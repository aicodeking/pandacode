// The full-screen image viewer: a native modal on black with pinch and double-tap zoom, swipes
// between a message's images, swipe down to dismiss, and Share (the iOS share sheet offers Save
// Image). One host is mounted by Transcript; openViewer() shows it from any row.
import { Image } from 'expo-image';
import { useCallback, useMemo, useState } from 'react';
import { ActivityIndicator, FlatList, Modal, Platform, Pressable, Share, StyleSheet, Text, useWindowDimensions, View, type ListRenderItem, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { runOnJS, useAnimatedStyle, useSharedValue, withTiming, type SharedValue } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { create } from 'zustand';
import { useAttachment, type ViewerImage } from './useAttachment.ts';
import { Icon } from './Icon.tsx';

const useViewer = create<{ images: ViewerImage[]; index: number; opened: number }>(() => ({ images: [], index: 0, opened: 0 }));

export const openViewer = (images: ViewerImage[], index: number) => useViewer.setState(s => ({ images, index, opened: s.opened + 1 }));
const close = () => useViewer.setState({ images: [], index: 0 });

const MAX_SCALE = 5;
const DOUBLE_SCALE = 2.5;
/** Swipe-down distance (pt) or speed (pt/s) that dismisses. */
const DISMISS_Y = 120;
const DISMISS_V = 900;
const EASE = { duration: 180 };

export function ImageViewerHost() {
  const { images, index, opened } = useViewer();
  return (
    <Modal visible={images.length > 0} transparent animationType="fade" presentationStyle="overFullScreen" statusBarTranslucent onRequestClose={close}>
      {/* Each open starts fresh at the image tapped. */}
      {images.length > 0 && <Viewer key={opened} images={images} index={index} />}
    </Modal>
  );
}

function Viewer({ images, index }: { images: ViewerImage[]; index: number }) {
  const { width, height } = useWindowDimensions();
  const insets = useSafeAreaInsets();
  const [current, setCurrent] = useState(index);
  const [zoomed, setZoomed] = useState(false);
  const drag = useSharedValue(0);
  const backdrop = useAnimatedStyle(() => ({ opacity: 1 - Math.min(Math.abs(drag.get()) / 400, 0.7) }));
  const onScroll = useCallback((e: NativeSyntheticEvent<NativeScrollEvent>) => setCurrent(Math.round(e.nativeEvent.contentOffset.x / width)), [width]);
  const render: ListRenderItem<ViewerImage> = useCallback(({ item, index: i }) => (
    <Page image={item} width={width} height={height} active={Math.abs(i - current) <= 1} drag={drag} onZoom={setZoomed} />
  ), [width, height, current, drag]);
  const shown = images[current];
  const { uri: fullUri } = useAttachment(shown, 'full');
  const share = () => { if (fullUri) void Share.share({ url: fullUri, title: shown?.name }); };
  return (
    <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
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
        <View style={[styles.bar, { top: insets.top + 6, left: insets.left + 12, right: insets.right + 12 }]} pointerEvents="box-none">
          <Pressable onPress={close} hitSlop={10} style={styles.button} accessibilityRole="button" accessibilityLabel="Close">
            <Icon ios="xmark" android="close" size={18} color="#fff" />
          </Pressable>
          <Text style={styles.title} numberOfLines={1}>{images.length > 1 ? `${current + 1} of ${images.length}` : shown?.name}</Text>
          {Platform.OS === 'ios'
            ? <Pressable onPress={share} disabled={!fullUri} hitSlop={10} style={[styles.button, !fullUri && styles.dim]} accessibilityRole="button" accessibilityLabel="Share or save">
              <Icon ios="square.and.arrow.up" android="share" size={18} color="#fff" />
            </Pressable>
            : <View style={styles.button} />}
        </View>
    </GestureHandlerRootView>
  );
}

/** One zoomable image. Not zoomed: a vertical drag dismisses (horizontal swipes page the list). Zoomed: drags pan. */
function Page({ image, width, height, active, drag, onZoom }: { image: ViewerImage; width: number; height: number; active: boolean; drag: SharedValue<number>; onZoom: (zoomed: boolean) => void }) {
  const thumb = useAttachment(image, 'thumb', active);
  const full = useAttachment(image, 'full', active);
  const scale = useSharedValue(1);
  const base = useSharedValue(1);
  const x = useSharedValue(0);
  const y = useSharedValue(0);
  const startX = useSharedValue(0);
  const startY = useSharedValue(0);
  const [zoomed, setZoomed] = useState(false);
  const report = useCallback((z: boolean) => { setZoomed(z); onZoom(z); }, [onZoom]);

  const gesture = useMemo(() => {
    const reset = () => {
      'worklet';
      scale.set(withTiming(1, EASE));
      base.set(1);
      x.set(withTiming(0, EASE));
      y.set(withTiming(0, EASE));
      runOnJS(report)(false);
    };
    // Keeps the zoomed image covering the screen where it can.
    const clamp = (tx = x.get(), ty = y.get()) => {
      'worklet';
      const mx = (width * (base.get() - 1)) / 2;
      const my = (height * (base.get() - 1)) / 2;
      x.set(withTiming(Math.min(mx, Math.max(-mx, tx)), EASE));
      y.set(withTiming(Math.min(my, Math.max(-my, ty)), EASE));
    };
    const pinch = Gesture.Pinch()
      .onUpdate(e => { scale.set(Math.min(MAX_SCALE, Math.max(0.8, base.get() * e.scale))); })
      .onEnd(() => {
        if (scale.get() <= 1.02) return reset();
        base.set(scale.get());
        clamp();
        runOnJS(report)(true);
      });
    const doubleTap = Gesture.Tap().numberOfTaps(2).onEnd(e => {
      if (base.get() > 1) return reset();
      scale.set(withTiming(DOUBLE_SCALE, EASE));
      base.set(DOUBLE_SCALE);
      // Zoom toward the tapped point.
      clamp((width / 2 - e.x) * (DOUBLE_SCALE - 1), (height / 2 - e.y) * (DOUBLE_SCALE - 1));
      runOnJS(report)(true);
    });
    const pan = Gesture.Pan()
      .onStart(() => { startX.set(x.get()); startY.set(y.get()); })
      .onUpdate(e => {
        if (base.get() > 1) {
          x.set(startX.get() + e.translationX);
          y.set(startY.get() + e.translationY);
        } else drag.set(e.translationY);
      })
      .onEnd(e => {
        if (base.get() > 1) return clamp();
        if (Math.abs(e.translationY) > DISMISS_Y || Math.abs(e.velocityY) > DISMISS_V) runOnJS(close)();
        else drag.set(withTiming(0, EASE));
      });
    if (!zoomed) pan.activeOffsetY([-12, 12]).failOffsetX([-12, 12]);
    return Gesture.Simultaneous(pinch, Gesture.Exclusive(doubleTap, pan));
  }, [zoomed, width, height, scale, base, x, y, startX, startY, drag, report]);

  const style = useAnimatedStyle(() => ({ transform: [{ translateX: x.get() }, { translateY: y.get() + (base.get() > 1 ? 0 : drag.get()) }, { scale: scale.get() }] }));
  const uri = full.uri ?? thumb.uri;
  return (
    <GestureDetector gesture={gesture}>
      <View style={{ width, height }} collapsable={false} accessible accessibilityLabel={image.name} accessibilityHint="Pinch or double-tap to zoom, swipe down to close">
        <Animated.View style={[StyleSheet.absoluteFill, style]}>
          {/* The thumbnail, blurred, until the full image arrives. */}
          {uri && <Image source={{ uri }} style={StyleSheet.absoluteFill} contentFit="contain" blurRadius={full.uri ? 0 : 12} transition={full.uri ? 150 : 0} />}
        </Animated.View>
        {!uri && !full.error && <ActivityIndicator color="#fff" style={StyleSheet.absoluteFill} />}
        {!full.uri && !!full.error && !thumb.uri && <Text style={styles.error}>Couldn’t load this image. {full.error}</Text>}
      </View>
    </GestureDetector>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  black: { backgroundColor: '#000' },
  bar: { position: 'absolute', flexDirection: 'row', alignItems: 'center', gap: 12 },
  button: { width: 36, height: 36, borderRadius: 18, alignItems: 'center', justifyContent: 'center', backgroundColor: 'rgba(255,255,255,0.16)' },
  dim: { opacity: 0.4 },
  title: { flex: 1, color: '#fff', fontSize: 16, fontWeight: '600', textAlign: 'center' },
  error: { position: 'absolute', top: '45%', left: 24, right: 24, color: '#fff', fontSize: 15, textAlign: 'center' },
});
