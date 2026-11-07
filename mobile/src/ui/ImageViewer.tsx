// The full-screen image viewer: pinch and double-tap zoom, swipes between a message's images and Share
// (the iOS share sheet offers Save Image). As in Photos the image grows out of its thumbnail and goes
// back to it, also from a drag: a hero view flies between the two rects, the tile hides meanwhile, and
// with Reduce Motion or no thumbnail on screen the viewer cross-fades. One host is mounted by
// Transcript; openViewer() shows it from any row.
import { Image } from 'expo-image';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Share, StyleSheet, Text, useWindowDimensions, View, type ListRenderItem, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedReaction, useAnimatedStyle, useReducedMotion, useSharedValue, withDecay, withSpring, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { create } from 'zustand';
import { Button, EXIT_MS, FADE_MS, PressScale, springs, type as text } from './ds/index.ts';
import { useAttachment, type ViewerImage } from './useAttachment.ts';
import { Icon } from './Icon.tsx';
import { draggedRect, fitRect, isOnScreen, panBounds, type Rect } from './viewer-geometry.ts';

/** A thumbnail on screen right now: its rect, corner radius and the image's aspect (width / height). */
export interface ThumbRect extends Rect { radius: number; aspect: number; uri: string }
/** Finds image `index`'s thumbnail, at opening and again at closing. Null when it has none on screen. */
export type ThumbSource = (index: number) => Promise<ThumbRect | null>;

export const imageKey = (image: ViewerImage) => `${image.deviceId}/${image.sessionId}/${image.id ?? image.path}`;

const useViewer = create<{ images: ViewerImage[]; index: number; opened: number; source?: ThumbSource; origin: ThumbRect | null; hidden: string | null }>(
  () => ({ images: [], index: 0, opened: 0, origin: null, hidden: null }),
);

export function openViewer(images: ViewerImage[], index: number, source?: ThumbSource) {
  const show = (origin: ThumbRect | null) => useViewer.setState(s => ({ images, index, source, origin, opened: s.opened + 1 }));
  if (!source) return show(null);
  source(index).then(show, () => show(null));
}

const finish = () => useViewer.setState({ images: [], index: 0, source: undefined, origin: null, hidden: null });

/** True while this image is the one flying: its tile steps aside, so there's only one of it. */
export const useViewerHides = (image: ViewerImage) => useViewer(s => s.hidden === imageKey(image));

/** The viewer is always on black, whatever the appearance. */
const ON_BLACK = '#fff';
/** Dark enough for the white marks to read over a bright image when zoomed. */
const CHROME = 'rgba(30, 30, 30, 0.72)';
const TAP_SLOP = 10;
const MAX_SCALE = 5;
const DOUBLE_SCALE = 2.5;
/** Swipe-down distance (pt) or speed (pt/s) that dismisses. */
const DISMISS_Y = 120;
const DISMISS_V = 900;
/** The drag that fades the backdrop out and shrinks the image to DRAG_SCALE. */
const FADE_DRAG = 400;
const MIN_BACKDROP = 0.3;
const DRAG_SCALE = 0.92;
/** How far a drag takes the top bar with it. */
const BAR_FADE_DRAG = 80;
/** Close enough to the end of a flight's spring to swap views: its long tail is invisible. */
const LANDED = 0.004;
const MIN_FLIGHT = 60;
const CLOSE_FALLBACK_MS = 1200;
/** Apple's rubber band: UIScrollView's constant, over `limit` points of stretch. */
const RUBBER = 0.55;

function rubberBand(overshoot: number, limit: number) {
  'worklet';
  const distance = Math.abs(overshoot);
  return Math.sign(overshoot) * (1 - 1 / ((distance * RUBBER) / limit + 1)) * limit;
}

/** `value` held to ±bound, with anything past it resisted. */
function banded(value: number, bound: number, limit: number) {
  'worklet';
  const past = Math.abs(value) - bound;
  return past <= 0 ? value : Math.sign(value) * (bound + rubberBand(past, limit));
}

const lerp = (from: number, to: number, at: number) => {
  'worklet';
  return from + (to - from) * at;
};

const shrinkFor = (dragged: number) => {
  'worklet';
  return interpolate(Math.abs(dragged), [0, FADE_DRAG], [1, DRAG_SCALE], 'clamp');
};

export function ImageViewerHost() {
  const { images, index, opened, origin, source } = useViewer();
  // Each open starts fresh at the image tapped.
  return images.length > 0 ? <Viewer key={opened} images={images} index={index} origin={origin} source={source} /> : null;
}

/** The image in flight: one view whose frame moves between the thumbnail and its fitted rect. `cover`
 * turns the tile's crop into the whole image. It stays mounted, hidden, for the current image, so a
 * flight home starts with its pixels already decoded instead of a blank frame. */
function Hero({ image, small, shown, thumb, from, progress }: { image: ViewerImage; small?: string; shown: SharedValue<number>; thumb: SharedValue<ThumbRect>; from: SharedValue<Rect>; progress: SharedValue<number> }) {
  const tile = useAttachment(image, 'thumb');
  const large = useAttachment(image, 'full');
  const frame = useAnimatedStyle(() => {
    const [a, b, at] = [thumb.get(), from.get(), progress.get()];
    return { left: lerp(a.x, b.x, at), top: lerp(a.y, b.y, at), width: lerp(a.width, b.width, at), height: lerp(a.height, b.height, at), borderRadius: Math.max(0, a.radius * (1 - at)), opacity: shown.get() };
  });
  const uri = large.uri ?? tile.uri ?? small;
  return (
    <Animated.View pointerEvents="none" style={[styles.hero, frame]}>
      {!!uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="cover" />}
    </Animated.View>
  );
}

function Viewer({ images, index, origin, source }: { images: ViewerImage[]; index: number; origin: ThumbRect | null; source?: ThumbSource }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const reduced = useReducedMotion();
  const [current, setCurrent] = useState(index);
  const [zoomed, setZoomed] = useState(false);
  // A retry starts the loads again from nothing: useAttachment keeps its error until remounted.
  const [attempt, setAttempt] = useState(0);
  const retry = useCallback(() => setAttempt(a => a + 1), []);
  const usable = (rect: ThumbRect | null): rect is ThumbRect => !!rect && !reduced && isOnScreen(rect, width, height);
  const flies = usable(origin);
  /** The hero shows while one flies; the pages take over once it lands. */
  const heroShown = useSharedValue(flies ? 1 : 0);
  const [closing, setClosing] = useState(false);
  const closingNow = useRef(false);
  const fallback = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  useEffect(() => () => clearTimeout(fallback.current), []);
  const opening = useRef(flies);

  const placeholder = useMemo(() => ({ x: 0, y: 0, width, height, radius: 0, aspect: width / height, uri: '' }), [width, height]);
  const progress = useSharedValue(0);
  const thumb = useSharedValue<ThumbRect>(flies ? origin : placeholder);
  const from = useSharedValue<Rect>(flies ? fitRect(origin.aspect, width, height) : placeholder);
  const pagesShown = useSharedValue(flies ? 0 : 1);
  const fades = useSharedValue(!flies);
  const drag = useSharedValue(0);
  /** The backdrop a drag had reached, held while the image flies home from there. */
  const heldFade = useSharedValue(1);

  const land = useCallback(() => {
    if (opening.current) {
      opening.current = false;
      pagesShown.set(1);
      heroShown.set(0);
    }
  }, [pagesShown, heroShown]);
  useEffect(() => {
    useViewer.setState({ hidden: flies ? imageKey(images[index]) : null });
    progress.set(flies ? withSpring(1, springs.smooth) : withTiming(1, { duration: FADE_MS }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- once per open
  }, []);
  useAnimatedReaction(() => progress.get() >= 1 - LANDED, (arrived, was) => { if (arrived && !was) scheduleOnRN(land); });

  const dismiss = useCallback(async (dragY = 0, velocityY = 0) => {
    if (closingNow.current) return;
    closingNow.current = true;
    setClosing(true);
    const image = images[current];
    const rect = zoomed ? null : await (source?.(current).catch(() => null) ?? Promise.resolve(null));
    // Whatever becomes of the flight from here (a cancelled animation, say), the viewer goes.
    fallback.current = setTimeout(finish, CLOSE_FALLBACK_MS);
    if (!usable(rect)) {
      useViewer.setState({ hidden: null });
      fades.set(true);
      progress.set(withTiming(0, { duration: EXIT_MS * 2 }, done => { if (done) scheduleOnRN(finish); }));
      return;
    }
    opening.current = false;
    const start = draggedRect(fitRect(rect.aspect, width, height), shrinkFor(dragY), dragY, width, height);
    heldFade.set(interpolate(Math.abs(dragY), [0, FADE_DRAG], [1, MIN_BACKDROP], 'clamp'));
    thumb.set(rect);
    from.set(start);
    useViewer.setState({ hidden: imageKey(image) });
    heroShown.set(1);
    pagesShown.set(0);
    drag.set(0);
    // Progress runs 1 → 0 over this distance, so the finger's speed carries straight into the flight.
    const distance = Math.max(MIN_FLIGHT, rect.y - start.y);
    const velocity = -Math.max(0, velocityY) / distance;
    const flown = progress.get() || 1;
    progress.set(flown);
    progress.set(withSpring(0, { ...springs.smooth, velocity }, done => { if (done) scheduleOnRN(finish); }));
    // eslint-disable-next-line react-hooks/exhaustive-deps -- shared values and setters are stable
  }, [current, images, source, zoomed, width, height, reduced]);
  useAnimatedReaction(() => progress.get() <= LANDED, (home, was) => { if (home && was === false) scheduleOnRN(finish); });

  const root = useAnimatedStyle(() => ({ opacity: fades.get() ? progress.get() : 1 }));
  const backdrop = useAnimatedStyle(() => ({ opacity: fades.get() ? interpolate(Math.abs(drag.get()), [0, FADE_DRAG], [1, MIN_BACKDROP], 'clamp') : Math.min(1, progress.get()) * heldFade.get() * interpolate(Math.abs(drag.get()), [0, FADE_DRAG], [1, MIN_BACKDROP], 'clamp') }));
  const pages = useAnimatedStyle(() => ({ opacity: pagesShown.get() }));
  const bar = useAnimatedStyle(() => ({ opacity: Math.min(1, progress.get()) * interpolate(Math.abs(drag.get()), [0, BAR_FADE_DRAG], [1, 0], 'clamp') }));

  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => {
    const next = Math.round(e.nativeEvent.contentOffset.x / width);
    setCurrent(next);
    useViewer.setState({ hidden: imageKey(images[next] ?? images[0]) });
  }, [width, images]);
  const onDismiss = useCallback((dragY: number, velocityY: number) => { void dismiss(dragY, velocityY); }, [dismiss]);
  const render: ListRenderItem<ViewerImage> = useCallback(({ item, index: i }) => (
    <Page key={attempt} image={item} width={width} height={height} active={Math.abs(i - current) <= 1} drag={drag} onZoom={setZoomed} onRetry={retry} onDismiss={onDismiss} />
  ), [width, height, current, drag, attempt, retry, onDismiss]);
  const shown = images[current];
  return (
    <Modal visible transparent animationType="none" presentationStyle="overFullScreen" statusBarTranslucent onRequestClose={() => { void dismiss(); }}>
    <GestureHandlerRootView style={styles.root} pointerEvents={closing ? 'none' : 'auto'}>
      <Animated.View style={[styles.root, root]}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
        <Animated.View style={[styles.root, pages]}>
          <FlatList
            data={images}
            horizontal
            pagingEnabled
            scrollEnabled={!zoomed}
            initialScrollIndex={index}
            getItemLayout={(_, i) => ({ length: width, offset: width * i, index: i })}
            keyExtractor={(item, i) => `${item.id ?? item.path}:${i}`}
            renderItem={render}
            onMomentumScrollEnd={onScroll}
            showsHorizontalScrollIndicator={false}
          />
        </Animated.View>
        <Hero key={`${imageKey(shown)}/${attempt}`} image={shown} small={origin?.uri} shown={heroShown} thumb={thumb} from={from} progress={progress} />
        <Animated.View style={[styles.bar, { top: insets.top + 6, left: insets.left + 12, right: insets.right + 12 }, bar]} pointerEvents="box-none">
          <PressScale onPress={() => { void dismiss(); }} hitSlop={10} style={styles.button} accessibilityLabel="Close">
            <Icon ios="xmark" android="close" size={18} color={ON_BLACK} />
          </PressScale>
          <Text style={[text.headline, styles.title]} numberOfLines={1}>{images.length > 1 ? `${current + 1} of ${images.length}` : shown?.name}</Text>
          {Platform.OS === 'ios' ? <ShareButton key={`${current}/${attempt}`} image={shown} /> : <View style={styles.button} />}
        </Animated.View>
      </Animated.View>
    </GestureHandlerRootView>
    </Modal>
  );
}

function ShareButton({ image }: { image: ViewerImage }) {
  const { uri } = useAttachment(image, 'full');
  const share = () => { if (uri) void Share.share({ url: uri, title: image.name }); };
  return (
    <PressScale onPress={share} disabled={!uri} hitSlop={10} style={[styles.button, !uri && styles.dim]} accessibilityLabel="Share or save">
      <Icon ios="square.and.arrow.up" android="share" size={18} color={ON_BLACK} />
    </PressScale>
  );
}

/** One zoomable image. Not zoomed: a vertical drag dismisses (horizontal swipes page the list). Zoomed: drags pan. */
function Page({ image, width, height, active, drag, onZoom, onRetry, onDismiss }: { image: ViewerImage; width: number; height: number; active: boolean; drag: SharedValue<number>; onZoom: (zoomed: boolean) => void; onRetry: () => void; onDismiss: (dragY: number, velocityY: number) => void }) {
  const thumb = useAttachment(image, 'thumb', active);
  const full = useAttachment(image, 'full', active);
  const scale = useSharedValue(1);
  const base = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const startScale = useSharedValue(1);
  const focalX = useSharedValue(0);
  const focalY = useSharedValue(0);
  const pinching = useSharedValue(false);
  // Pan limits follow the image's own rect, once known: the window's shape until then.
  const aspect = useSharedValue(image.width && image.height ? image.width / image.height : width / height);
  const [zoomed, setZoomed] = useState(false);
  const report = useCallback((z: boolean) => { setZoomed(z); onZoom(z); }, [onZoom]);

  const gesture = useMemo(() => {
    const reset = () => {
      'worklet';
      scale.set(withSpring(1, springs.snappy));
      base.set(1);
      x.set(withSpring(0, springs.snappy));
      y.set(withSpring(0, springs.snappy));
      scheduleOnRN(report, false);
    };
    // Keeps the zoomed image covering the screen where it can.
    const clamp = (tx = x.get(), ty = y.get()) => {
      'worklet';
      const bounds = panBounds(aspect.get(), base.get(), width, height);
      x.set(withSpring(Math.min(bounds.x, Math.max(-bounds.x, tx)), springs.snappy));
      y.set(withSpring(Math.min(bounds.y, Math.max(-bounds.y, ty)), springs.snappy));
    };
    // After a zoomed pan: inside the image the finger's speed coasts to the edge; past an edge it springs back.
    const settle = (value: SharedValue<number>, bound: number, velocity: number) => {
      'worklet';
      if (Math.abs(value.get()) > bound) value.set(withSpring(Math.sign(value.get()) * bound, { ...springs.momentum, velocity }));
      else value.set(withDecay({ velocity, clamp: [-bound, bound] }));
    };
    const pinch = Gesture.Pinch()
      .onStart(e => {
        pinching.set(true);
        // A drag begun by the first finger gives way; this gesture is a zoom now.
        drag.set(withSpring(0, springs.snappy));
        startScale.set(scale.get());
        startX.set(x.get());
        startY.set(y.get());
        focalX.set(e.focalX - width / 2);
        focalY.set(e.focalY - height / 2);
      })
      .onUpdate(e => {
        const next = Math.min(MAX_SCALE, Math.max(0.8, base.get() * e.scale));
        const grown = next / startScale.get();
        scale.set(next);
        // The point under the fingers stays under them, and follows if they move together.
        x.set(e.focalX - width / 2 - grown * (focalX.get() - startX.get()));
        y.set(e.focalY - height / 2 - grown * (focalY.get() - startY.get()));
      })
      .onFinalize(() => { pinching.set(false); })
      .onEnd(() => {
        if (scale.get() <= 1.02) return reset();
        base.set(scale.get());
        clamp();
        scheduleOnRN(report, true);
      });
    // A moved finger isn't a tap: without maxDistance the drag waits out the tap's whole delay, and a flick does nothing.
    const doubleTap = Gesture.Tap().numberOfTaps(2).maxDistance(TAP_SLOP).onEnd(e => {
      if (base.get() > 1) return reset();
      scale.set(withSpring(DOUBLE_SCALE, springs.snappy));
      base.set(DOUBLE_SCALE);
      // Zoom toward the tapped point.
      clamp((width / 2 - e.x) * (DOUBLE_SCALE - 1), (height / 2 - e.y) * (DOUBLE_SCALE - 1));
      scheduleOnRN(report, true);
    });
    const pan = Gesture.Pan()
      .onStart(() => { startX.set(x.get()); startY.set(base.get() > 1 ? y.get() : drag.get()); })
      .onUpdate(e => {
        if (pinching.get()) return;
        if (base.get() > 1) {
          const bounds = panBounds(aspect.get(), base.get(), width, height);
          x.set(banded(startX.get() + e.translationX, bounds.x, width));
          y.set(banded(startY.get() + e.translationY, bounds.y, height));
        } else {
          // Down follows the finger; up, which doesn't close, resists.
          const next = startY.get() + e.translationY;
          drag.set(next > 0 ? next : rubberBand(next, height));
        }
      })
      .onEnd(e => {
        if (pinching.get()) return;
        if (base.get() > 1) {
          const bounds = panBounds(aspect.get(), base.get(), width, height);
          settle(x, bounds.x, e.velocityX);
          settle(y, bounds.y, e.velocityY);
          return;
        }
        if (drag.get() > DISMISS_Y || e.velocityY > DISMISS_V) scheduleOnRN(onDismiss, drag.get(), e.velocityY);
        else drag.set(withSpring(0, { ...springs.momentum, velocity: e.velocityY }));
      });
    // Unzoomed, only one finger drags: two that drift down are a pinch, not a dismiss.
    if (!zoomed) pan.maxPointers(1).activeOffsetY([-12, 12]).failOffsetX([-12, 12]);
    return Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, pan));
  }, [zoomed, width, height, scale, base, x, y, startX, startY, startScale, focalX, focalY, pinching, drag, report, aspect, onDismiss]);

  const style = useAnimatedStyle(() => {
    const dragged = base.get() > 1 ? 0 : drag.get();
    return { transform: [{ translateX: x.get() }, { translateY: y.get() + dragged }, { scale: scale.get() * shrinkFor(dragged) }] };
  });
  const uri = full.uri ?? thumb.uri;
  const failed = !full.uri && !!full.error;
  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }} collapsable={false}>
        {/* The image alone is the accessible element, so Retry stays reachable beside it. */}
        <Animated.View accessible accessibilityRole="image" accessibilityLabel={image.name} accessibilityHint="Pinch or double-tap to zoom, swipe down to close" style={[StyleSheet.absoluteFill, style]}>
          {/* The thumbnail until the full image arrives, as the hero showed it, so landing doesn't pop. */}
          {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" transition={full.uri ? 150 : 0}
            onLoad={e => { if (e.source.width && e.source.height) aspect.set(e.source.width / e.source.height); }} />}
        </Animated.View>
        {!uri && !full.error && <ActivityIndicator color={ON_BLACK} style={StyleSheet.absoluteFill} />}
        {failed && (
          <View style={styles.error}>
            <Text accessibilityRole="alert" style={[text.subhead, styles.errorText]}>Couldn’t load the full image. {full.error}</Text>
            <Button label="Retry" size="small" onPress={onRetry} />
          </View>
        )}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  hero: { position: 'absolute', overflow: 'hidden', borderCurve: 'continuous' },
  black: { backgroundColor: '#000' },
  bar: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: CHROME },
  dim: { opacity: 0.4 },
  title: { flex: 1, color: ON_BLACK, textAlign: 'center', textShadowColor: CHROME, textShadowRadius: 6, textShadowOffset: { width: 0, height: 0 } },
  error: { position: 'absolute', left: 24, right: 24, bottom: '12%', alignItems: 'center', gap: 10, padding: 14, borderRadius: 14, borderCurve: 'continuous', backgroundColor: 'rgba(0,0,0,0.6)' },
  errorText: { color: ON_BLACK, textAlign: 'center' },
});
