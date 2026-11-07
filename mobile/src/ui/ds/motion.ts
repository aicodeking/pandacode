// Shared motion: critically damped springs, a few points of travel, exits around 120 ms. With Reduce
// Motion the springs jump, slides become cross-fades and layout changes are instant.
import * as Haptics from 'expo-haptics';
import { useCallback, useEffect, useState } from 'react';
import { Easing, FadeIn, FadeOut, Keyframe, LinearTransition, ReduceMotion, useReducedMotion } from 'react-native-reanimated';
import { STAGGER_CAP, STAGGER_STEP_MS, springParams, staggerDelay } from './motion-math.ts';

const spring = (response: number, dampingRatio = 1) => ({ ...springParams(response, dampingRatio), reduceMotion: ReduceMotion.System });

export const springs = {
  /** Touch-down and release. */
  press: spring(0.2),
  /** Thumbs, chevrons, small moves. */
  snappy: spring(0.28),
  /** Expand and collapse. */
  smooth: spring(0.36),
  /** Slight bounce: only after a gesture with momentum. */
  momentum: spring(0.4, 0.8),
};

export const EXIT_MS = 120;
export const FADE_MS = 180;
const ENTER_MS = 220;
const ENTER_TRAVEL = 6;
const BANNER_TRAVEL = 8;
/** Long enough for every capped row of a first page to mount and start. */
const STAGGER_WINDOW_MS = STAGGER_CAP * STAGGER_STEP_MS + ENTER_MS;

const slideFrom = (y: number) => new Keyframe({
  from: { opacity: 0, transform: [{ translateY: y }] },
  to: { opacity: 1, transform: [{ translateY: 0 }], easing: Easing.out(Easing.cubic) },
}).duration(ENTER_MS).reduceMotion(ReduceMotion.Never);

const STAGGERED = Array.from({ length: STAGGER_CAP }, (_, i) => slideFrom(ENTER_TRAVEL).delay(staggerDelay(i) ?? 0));
const FROM_ABOVE = slideFrom(-BANNER_TRAVEL);

export const crossFadeIn = FadeIn.duration(FADE_MS).reduceMotion(ReduceMotion.Never);
export const crossFadeOut = FadeOut.duration(EXIT_MS).reduceMotion(ReduceMotion.Never);
const layout = LinearTransition.springify().mass(springs.snappy.mass).stiffness(springs.snappy.stiffness).damping(springs.snappy.damping).reduceMotion(ReduceMotion.System);

/** `entering`/`exiting`/`layout` props for Animated views; `enter(i)` staggers and is undefined past the cap. */
export function useMotion() {
  const reduced = useReducedMotion();
  const enter = useCallback((index = 0) => {
    if (index >= STAGGER_CAP) return undefined;
    return reduced ? crossFadeIn : STAGGERED[Math.max(0, index)];
  }, [reduced]);
  return { reduced, enter, enterFromAbove: reduced ? crossFadeIn : FROM_ABOVE, exit: crossFadeOut, layout };
}

/**
 * The first-mount entrance for a list screen: once per mount, for the first rows only, so rows that
 * mount later while scrolling or from a refresh just appear. Pass `ready` once the data is there.
 */
export function useStagger(ready = true) {
  const { enter } = useMotion();
  const [armed, setArmed] = useState(true);
  useEffect(() => {
    if (!ready) return undefined;
    const timer = setTimeout(() => setArmed(false), STAGGER_WINDOW_MS);
    return () => clearTimeout(timer);
  }, [ready]);
  return useCallback((index: number) => (armed ? enter(index) : undefined), [armed, enter]);
}

export type HapticKind = 'selection' | 'light' | 'medium' | 'success' | 'warning' | 'error';

/** Fire and forget: a device without a haptic engine just stays quiet. */
export function haptic(kind: HapticKind) {
  const done = () => undefined;
  if (kind === 'selection') Haptics.selectionAsync().catch(done);
  else if (kind === 'light') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light).catch(done);
  else if (kind === 'medium') Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium).catch(done);
  else if (kind === 'success') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success).catch(done);
  else if (kind === 'warning') Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning).catch(done);
  else Haptics.notificationAsync(Haptics.NotificationFeedbackType.Error).catch(done);
}
