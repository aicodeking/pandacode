// A light/dark change flips the whole window in one frame, native bars included, so the page tone
// fades in over everything, the scheme swaps under it, and it fades away. A cross-fade, so it stays with Reduce Motion.
import { useEffect, useState } from 'react';
import { StyleSheet } from 'react-native';
import Animated, { Easing, ReduceMotion, useAnimatedStyle, useSharedValue, withDelay, withTiming } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { setThemeFader } from './appearance.ts';
import { EXIT_MS, FADE_MS } from './ds/index.ts';
import { useColors } from './theme.ts';

/** Time for native views and React to repaint in the new scheme under the cover. */
const SETTLE_MS = 60;
const easing = Easing.inOut(Easing.quad);
// Built here, not inside the callback below: that runs on the UI thread, which can't call JS functions.
const FADE_IN = { duration: EXIT_MS, easing, reduceMotion: ReduceMotion.Never };
const FADE_OUT = { duration: FADE_MS, easing, reduceMotion: ReduceMotion.Never };

export function ThemeFade() {
  const { page } = useColors();
  const [cover, setCover] = useState(page);
  const opacity = useSharedValue(0);
  useEffect(() => {
    setThemeFader(swap => {
      setCover(page);
      opacity.set(withTiming(1, FADE_IN, finished => {
        // A newer change took over and will swap and uncover when it finishes.
        if (!finished) return;
        scheduleOnRN(swap);
        opacity.set(withDelay(SETTLE_MS, withTiming(0, FADE_OUT)));
      }));
    });
    return () => setThemeFader(null);
  }, [page, opacity]);
  const style = useAnimatedStyle(() => ({ opacity: opacity.get() }));
  return <Animated.View pointerEvents="none" accessibilityElementsHidden importantForAccessibility="no-hide-descendants" style={[StyleSheet.absoluteFill, { backgroundColor: cover }, style]} />;
}
