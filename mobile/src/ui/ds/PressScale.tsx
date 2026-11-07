// A pressable that scales on touch-down, from wherever it is, and springs back on release. The scale
// runs on the UI thread from a gesture that never activates, so a busy JS thread can't delay it and the
// Pressable underneath keeps every semantic: accessibility, long press, and yielding to a scroll.
import { useMemo } from 'react';
import { Pressable, StyleSheet, type GestureResponderEvent, type PressableProps, type StyleProp, type ViewStyle } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolate, useAnimatedStyle, useReducedMotion, useSharedValue, withDelay, withSpring } from 'react-native-reanimated';
import { haptic as fireHaptic, springs, type HapticKind } from './motion.ts';

const AnimatedPressable = Animated.createAnimatedComponent(Pressable);
const PRESSED_SCALE = 0.97;
/** With Reduce Motion a press dims instead of moving. */
const PRESSED_OPACITY = 0.6;

export interface PressScaleProps extends Omit<PressableProps, 'style'> {
  style?: StyleProp<ViewStyle>;
  /** The scale while held. */
  scale?: number;
  /** Fired on press, for meaningful events only. */
  haptic?: HapticKind;
}

export function PressScale({ style, scale = PRESSED_SCALE, haptic, onPress, onPressOut, accessibilityRole = 'button', ...rest }: PressScaleProps) {
  const { disabled, hitSlop, unstable_pressDelay: delay = 0 } = rest;
  const current = useSharedValue(1);
  const reduced = useReducedMotion();
  // The caller's own opacity (a disabled dim) stays: the press dims on top of it.
  const base = StyleSheet.flatten(style)?.opacity ?? 1;
  const animated = useAnimatedStyle(() => (reduced
    // scale 1 means no press look of its own (rows with a highlight): a [1, 1] range would pin it dim.
    ? { opacity: base * (scale >= 1 ? 1 : interpolate(current.get(), [scale, 1], [PRESSED_OPACITY, 1])) }
    : { transform: [{ scale: current.get() }] }));
  const touch = useMemo(() => {
    const gesture = Gesture.Manual().enabled(!disabled).shouldCancelWhenOutside(true)
      .onTouchesDown(() => { current.set(withDelay(delay, withSpring(scale, springs.press))); })
      .onTouchesUp(() => { current.set(withSpring(1, springs.press)); })
      .onTouchesCancelled(() => { current.set(withSpring(1, springs.press)); })
      .onFinalize(() => { current.set(withSpring(1, springs.press)); });
    return hitSlop == null ? gesture : gesture.hitSlop(hitSlop);
  }, [current, disabled, hitSlop, delay, scale]);
  // The gesture releases on its own; this covers a touch only the Pressable saw end, so a scale can't stick.
  const release = (event: GestureResponderEvent) => {
    current.set(withSpring(1, springs.press));
    onPressOut?.(event);
  };
  const press = (event: GestureResponderEvent) => {
    if (haptic) fireHaptic(haptic);
    onPress?.(event);
  };
  return (
    <GestureDetector gesture={touch}>
      <AnimatedPressable accessibilityRole={accessibilityRole} {...rest} style={[style, animated]} onPress={press} onPressOut={release} />
    </GestureDetector>
  );
}
