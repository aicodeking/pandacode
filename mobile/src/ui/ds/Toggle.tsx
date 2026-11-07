// The desktop's switch: a near-text track with a dark knob when on, recessed when off. Custom, because
// iOS 26's native switch forces a white knob. The knob follows a tap with a spring, or the finger on a drag.
import { useEffect, useMemo, useState } from 'react';
import { StyleSheet, View } from 'react-native';
import { Gesture, GestureDetector } from 'react-native-gesture-handler';
import Animated, { interpolateColor, useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';
import { scheduleOnRN } from 'react-native-worklets';
import { useColors } from '../theme.ts';
import { haptic, springs } from './motion.ts';
import { geometry } from './type.ts';

const WIDTH = 46;
const HEIGHT = 28;
const INSET = 3;
const KNOB = HEIGHT - INSET * 2;
const TRAVEL = WIDTH - KNOB - INSET * 2;
/** To a 44 pt target. */
const TARGET_SLOP = (44 - HEIGHT) / 2;
/** Long enough for an accepted change to have come back through React. */
const RESYNC_MS = 150;
const DRAG_START = 6;
const SCROLL_START = 12;
/** A held knob stretches a little, the way the system's does. */
const HELD_STRETCH = 0.16;
const DISABLED_OPACITY = 0.45;
/** Tells a parent ScrollView this touch is handled, so it keeps the keyboard up. */
const claimTouch = () => true;
const clamp = (value: number) => { 'worklet'; return Math.min(Math.max(value, 0), 1); };

export interface ToggleProps {
  value: boolean;
  onValueChange: (value: boolean) => void;
  disabled?: boolean;
  accessibilityLabel?: string;
}

export function Toggle({ value, onValueChange, disabled, accessibilityLabel }: ToggleProps) {
  const colors = useColors();
  const progress = useSharedValue(value ? 1 : 0);
  const held = useSharedValue(0);
  const dragFrom = useSharedValue(0);
  const latest = useSharedValue(value);
  // A drag hands the knob its own momentum on release; a tap or a change from outside settles without bounce.
  const dragged = useSharedValue(false);
  useEffect(() => {
    latest.set(value);
    if (dragged.get()) dragged.set(false);
    else progress.set(withSpring(value ? 1 : 0, springs.snappy));
  }, [value, progress, latest, dragged]);
  // A parent that refused the change keeps `value`, which the effect above wouldn't see: put the knob back.
  const [asked, setAsked] = useState<{ next: boolean } | null>(null);
  useEffect(() => {
    if (!asked) return undefined;
    const timer = setTimeout(() => { if (latest.get() !== asked.next) progress.set(withSpring(latest.get() ? 1 : 0, springs.snappy)); }, RESYNC_MS);
    return () => clearTimeout(timer);
  }, [asked, latest, progress]);
  const gesture = useMemo(() => {
    const commit = (next: boolean) => {
      if (next === value) return;
      haptic('selection');
      onValueChange(next);
      setAsked({ next });
    };
    const drag = Gesture.Pan().enabled(!disabled).activeOffsetX([-DRAG_START, DRAG_START]).failOffsetY([-SCROLL_START, SCROLL_START])
      .onBegin(() => { dragFrom.set(progress.get()); held.set(withSpring(1, springs.press)); })
      .onUpdate(event => { progress.set(clamp(dragFrom.get() + event.translationX / TRAVEL)); })
      .onEnd(() => {
        const next = progress.get() > 0.5;
        progress.set(withSpring(next ? 1 : 0, springs.momentum));
        if (next !== value) dragged.set(true);
        scheduleOnRN(commit, next);
      })
      .onFinalize(() => { held.set(withSpring(0, springs.press)); });
    const tap = Gesture.Tap().enabled(!disabled).onEnd(() => { scheduleOnRN(commit, !value); });
    return Gesture.Exclusive(drag, tap);
  }, [value, disabled, onValueChange, progress, held, dragFrom, dragged]);
  const { toggleOff, toggleOn, toggleKnob, toggleKnobOff } = colors;
  const track = useAnimatedStyle(() => ({ backgroundColor: interpolateColor(progress.get(), [0, 1], [toggleOff, toggleOn]) }));
  const knob = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(progress.get(), [0, 1], [toggleKnobOff, toggleKnob]),
    transform: [
      { translateX: progress.get() * TRAVEL + (KNOB * HELD_STRETCH * held.get() * (progress.get() - 0.5)) },
      { scaleX: 1 + HELD_STRETCH * held.get() },
    ],
  }));
  return (
    <View accessible accessibilityRole="switch" accessibilityLabel={accessibilityLabel} accessibilityState={{ checked: value, disabled: !!disabled }}
      accessibilityActions={[{ name: 'activate' }]} onAccessibilityAction={() => { if (!disabled) { haptic('selection'); onValueChange(!value); } }}
      onStartShouldSetResponder={claimTouch} style={disabled && styles.disabled}>
      <GestureDetector gesture={gesture}>
        <View style={styles.target}>
          <Animated.View style={[styles.track, { borderColor: colors.border }, track]}>
            <Animated.View style={[styles.knob, knob]} />
          </Animated.View>
        </View>
      </GestureDetector>
    </View>
  );
}

// A gesture's hitSlop can't reach past its view: a touch has to land on it, so the view is the target.
const styles = StyleSheet.create({
  target: { paddingVertical: TARGET_SLOP, marginVertical: -TARGET_SLOP },
  track: { width: WIDTH, height: HEIGHT, borderRadius: HEIGHT / 2, padding: INSET - geometry.hairline, borderWidth: geometry.hairline },
  knob: { width: KNOB, height: KNOB, borderRadius: KNOB / 2 },
  disabled: { opacity: DISABLED_OPACITY },
});
