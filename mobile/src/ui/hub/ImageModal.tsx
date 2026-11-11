// A full-screen image for data URLs the hub downloads (workspace images, progress snapshots): on
// black, pinch to zoom on iOS, swipe down or Done to close. The task screen's ImageViewer loads
// message attachments itself, so these images get this lighter viewer. Reduce Motion: a swipe past
// the threshold closes with the modal's fade instead of the image following the finger off screen.
import { Image } from 'expo-image';
import { useState } from 'react';
import { Modal, ScrollView, StyleSheet, Text, useWindowDimensions, View, type NativeScrollEvent, type NativeSyntheticEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withSpring, withTiming } from 'react-native-reanimated';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { scheduleOnRN } from 'react-native-worklets';
import { Button, EXIT_MS, geometry, springs, type as text, VIEWER } from '../ds/index.ts';

const MAX_ZOOM = 5;
/** How far (pt) or how fast (pt/s) a downward swipe must go to close. */
const DISMISS_Y = 120;
const DISMISS_V = 900;
/** A swipe starts only once mostly vertical, so pinches and sideways drags stay with the scroll view. */
const PAN_START = 12;
const PAN_SIDEWAYS = 24;
/** Drag distance over which the black fades to show the drag is a close. */
const FADE_OVER = 400;
const SHRINK = 0.15;

export function ImageModal({ uri, title, note, onClose }: { uri: string | null; title?: string; note?: string; onClose: () => void }) {
  const insets = useSafeAreaInsets();
  const { height } = useWindowDimensions();
  const reduced = useReducedMotion();
  const [zoomed, setZoomed] = useState(false);
  const drag = useSharedValue(0);
  const reset = () => { drag.set(0); setZoomed(false); };

  const onScroll = (event: NativeSyntheticEvent<NativeScrollEvent>) => setZoomed((event.nativeEvent.zoomScale ?? 1) > 1.01);
  const pan = Gesture.Pan()
    .enabled(!zoomed)
    .activeOffsetY(PAN_START)
    .failOffsetX([-PAN_SIDEWAYS, PAN_SIDEWAYS])
    .onUpdate(e => { drag.set(Math.max(0, e.translationY)); })
    .onEnd(e => {
      if (drag.get() > DISMISS_Y || e.velocityY > DISMISS_V) {
        if (reduced) scheduleOnRN(onClose);
        else drag.set(withTiming(height, { duration: EXIT_MS * 2 }, done => { if (done) scheduleOnRN(onClose); }));
      } else drag.set(withSpring(0, springs.snappy));
    });
  const follow = useAnimatedStyle(() => {
    const moved = reduced ? 0 : drag.get();
    return { transform: [{ translateY: moved }, { scale: 1 - SHRINK * interpolate(moved, [0, FADE_OVER], [0, 1], 'clamp') }] };
  });
  const backdrop = useAnimatedStyle(() => ({ opacity: interpolate(drag.get(), [0, FADE_OVER], [1, 0.4], 'clamp') }));

  return (
    <Modal visible={!!uri} animationType="fade" presentationStyle="overFullScreen" transparent onRequestClose={onClose} onShow={reset} supportedOrientations={['portrait', 'landscape']}>
      <GestureHandlerRootView style={styles.root}>
        <Animated.View style={[StyleSheet.absoluteFill, styles.black, backdrop]} />
        <GestureDetector gesture={pan}>
          <Animated.View style={[styles.root, follow]}>
            <ScrollView style={styles.root} contentContainerStyle={styles.zoom} maximumZoomScale={MAX_ZOOM} minimumZoomScale={1} centerContent bouncesZoom
              onScroll={onScroll} scrollEventThrottle={64} showsHorizontalScrollIndicator={false} showsVerticalScrollIndicator={false}>
              {!!uri && <Image source={{ uri }} style={styles.image} contentFit="contain" accessibilityLabel={title} accessibilityHint="Swipe down to close" />}
            </ScrollView>
          </Animated.View>
        </GestureDetector>
        <View style={[styles.bar, { paddingTop: insets.top + 6, paddingLeft: insets.left + geometry.rowInset, paddingRight: insets.right + geometry.rowInset }]}>
          <Text numberOfLines={1} style={[text.headline, styles.title]}>{title}</Text>
          <Button label="Done" size="small" onPress={onClose} />
        </View>
        {!!note && <Text style={[text.subhead, styles.note, { paddingBottom: insets.bottom + geometry.rowInset, paddingLeft: insets.left + geometry.rowInset, paddingRight: insets.right + geometry.rowInset }]}>{note}</Text>}
      </GestureHandlerRootView>
    </Modal>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  black: { backgroundColor: VIEWER.page },
  zoom: { flexGrow: 1, justifyContent: 'center' },
  image: { width: '100%', aspectRatio: 1, flexGrow: 1 },
  bar: { position: 'absolute', top: 0, left: 0, right: 0, flexDirection: 'row', alignItems: 'center', gap: 12, paddingBottom: 8, backgroundColor: VIEWER.chrome },
  title: { flex: 1, color: VIEWER.text },
  note: { color: VIEWER.text, paddingTop: 10, backgroundColor: VIEWER.chrome },
});
