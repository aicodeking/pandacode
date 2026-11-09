// The cold-launch intro, over the whole app while it initialises underneath (timeline.ts has the
// choreography, plan.ts the decisions). Its first frame is the launch screen (the page tone, the panda
// centred at 88 pt), so the native splash hands over without a flash, and the panda is alive from
// then on. Once the app is ready the beat plays and the mark flies into the Inbox header's brand;
// signed out (or with no header brand) it fades instead. However slow the start, the panda idles until
// the app is ready and then plays the beat; only a tap before it skips it, and a tap during it hurries it
// to the end. Reduce Motion gets a short cross-fade. Only
// on a cold launch: it is mounted once by the root layout and never comes back.
import * as SplashScreen from 'expo-splash-screen';
import { useEffect, useState } from 'react';
import { AccessibilityInfo, AppState, PixelRatio, Platform, StyleSheet, useWindowDimensions, View } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing, ReduceMotion, useFrameCallback, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { useSplit } from '../split.tsx';
import { useColors } from '../theme.ts';
import { contentShown, finishIntro, headerShown, useIntro, type Rect } from './handoff.ts';
import { IntroMark, useMarkSpans } from './IntroMark.tsx';
import { launchFeet, markLayout, markRest, type Placement } from './mark-layout.ts';
import { clockRuns, DIRECT, holdAfter, mayStart, exitMode, exitMs, FADE, FLY, gateOpen, PLAY_CAP_MS, REDUCE, SAFETY_MS } from './plan.ts';
import { backdrop, BEAT_END, flight, glide, LAND, LAUNCH, REVEAL_AT, SKIP_HANDOFF_MS, SKIP_MS, type Point } from './timeline.ts';
import { smooth } from '../brand/motion-curves.ts';
import { useSettled } from './useSettled.ts';

const ACTIONS = [{ name: 'activate', label: 'Skip the intro' }];
const FADE_GROW = 0.06;
/** Points: measured on an iPhone 17 Pro simulator (Release), dark and light. */
const LAND_NUDGE = 0.2;
/** The hand-off's speed (progress per second), indexed by mode: FLY, FADE, REDUCE, DIRECT. */
const EXIT_RATES = [FLY, FADE, REDUCE, DIRECT].map(m => 1000 / exitMs(m));
const SKIP_RATE = 1000 / SKIP_HANDOFF_MS;
const SKIP_EASE = Easing.inOut(Easing.quad);
const NONE = -1;
/** The most the beat's clock moves in one frame (s): two 60 Hz frames. */
const MAX_STEP = 1 / 30;
/** A background this long is real (see the AppState note below). */
const AWAY_MS = 300;
/**
 * When, in the beat, to measure the header brand: at the take-off and again at the landing (the later
 * answer wins), so the hand-off never waits on it. Measured at the gate it sat ~40 pt high, before the
 * safe area applied.
 */
/** Nothing may reach the JS thread before this far into the flight: a commit there stalls its first frames. */
const JS_QUIET_UNTIL = 0.5;

let played = false;
// The launch screen stays until the intro has drawn its first frame (the same picture), not just mounted.
if (Platform.OS === 'ios') SplashScreen.preventAutoHideAsync().catch(() => undefined);
const hideLaunchScreen = () => requestAnimationFrame(() => SplashScreen.hide());

export function SplashIntro({ ready, signedIn }: { ready: boolean; signedIn: boolean }) {
  // Decided once, on the first render of the app's life.
  const [on] = useState(() => Platform.OS === 'ios' && !played);
  if (!on) return null;
  return <Intro ready={ready} signedIn={signedIn} />;
}

function Intro({ ready, signedIn }: { ready: boolean; signedIn: boolean }) {
  const colors = useColors();
  const window = useWindowDimensions();
  const reduced = useReducedMotion();
  const split = useSplit();
  const { spans, onLetter } = useMarkSpans();
  const [skippedEarly, setSkippedEarly] = useState(false);
  /** Past SAFETY_MS: stop waiting for the header brand. */
  const [overdue, setOverdue] = useState(false);
  const [gone, setGone] = useState(false);
  // Only flipped for VoiceOver users, and only past JS_QUIET_UNTIL.
  const [hidden, setHidden] = useState(false);
  const t = useSharedValue(0);
  const w = useSharedValue(0);
  /** Whether the beat's clock runs. */
  const running = useSharedValue(false);
  const h = useSharedValue(0);
  const mode = useSharedValue(REDUCE);
  const target = useSharedValue<Point>({ x: 0, y: 0 });
  const skipped = useSharedValue(false);
  /** The exit to take when the beat ends, once known (NONE until then), and whether the hand-off started. */
  const planned = useSharedValue(NONE);
  const started = useSharedValue(false);
  const reader = useSharedValue(false);
  const isReady = useSharedValue(false);
  /** The hand-off's speed once it starts (0 before). */
  const rate = useSharedValue(0);
  /** The JS thread's heartbeat (a frame count), the last one the UI thread saw, and ms since it changed. */
  const jsTick = useSharedValue(0);
  const seenTick = useSharedValue(0);
  const sinceJs = useSharedValue(0);
  /** When (UI frame time, ms) the last JS stall ended, and how long the beat's start waits after it. */
  const busyEnd = useSharedValue(0);
  const hold = useSharedValue(0);
  // Every shared value a worklet below captures is declared above it: a worklet captures a later
  // `const` as undefined (the UI-thread errors "Cannot read property 'set' of undefined", "undefined is
  // not a function").
  //
  // The clocks advance per frame, at most MAX_STEP a frame: the UI thread still stalls now and then while
  // the app's native views mount, and a clock on wall time skipped the crouch then. The idle's runs from
  // the first frame the UI thread draws (from mount, the app's mount ate its first beats), not under
  // Reduce Motion. The beat's (while `running`) and the hand-off's only run while the JS thread answers
  // frames: while React commits (the Inbox rendering its list, over a second in a Debug build) Reanimated
  // holds every UI update back, so motion played then was never seen (`clockRuns`).
  useFrameCallback(frame => {
    const gap = frame.timeSincePreviousFrame ?? 16;
    const step = Math.min(gap / 1000, MAX_STEP);
    if (!reduced) w.set(w.get() + step);
    const tick = jsTick.get();
    if (tick !== seenTick.get()) {
      seenTick.set(tick);
      const wait = holdAfter(sinceJs.get());
      if (wait > 0) {
        busyEnd.set(frame.timestamp);
        hold.set(wait);
      }
      sinceJs.set(0);
    } else {
      sinceJs.set(sinceJs.get() + gap);
    }
    if (!clockRuns(sinceJs.get())) return;
    if (running.get() && (t.get() > 0 || mayStart(frame.timestamp - busyEnd.get(), hold.get()))) t.set(t.get() + step);
    const speed = rate.get();
    if (speed > 0 && h.get() < 1) {
      const next = Math.min(1, h.get() + step * speed);
      h.set(next);
      if (next >= 1) scheduleOnRN(setGone, true);
    }
  });
  // The heartbeat: one tick per JS frame, for the intro's life.
  useEffect(() => {
    let frame = 0;
    const beat = () => {
      jsTick.set(jsTick.get() + 1);
      frame = requestAnimationFrame(beat);
    };
    frame = requestAnimationFrame(beat);
    return () => cancelAnimationFrame(frame);
  }, [jsTick]);
  const calm = useDerivedValue(() => glide(h.get() / 0.3));
  const place = useSharedValue<Placement | null>(null);
  const drift = useDerivedValue(() => (mode.get() === FLY ? glide(h.get()) : 0));

  const layout = markLayout(spans);
  const rest = markRest(window, layout);
  const from = launchFeet(window, rest);
  const exit = ready ? exitMode({ reduced, beat: !skippedEarly, signedIn, split }) : null;
  const plays = exit === FLY || exit === FADE;
  const exitIsFly = useDerivedValue(() => exit === FLY);

  // The safety net runs from mount: it only stops the wait for the header brand, the beat still plays.
  useEffect(() => {
    played = true;
    void AccessibilityInfo.isScreenReaderEnabled().then(on => reader.set(on), () => undefined);
    const net = setTimeout(() => setOverdue(true), SAFETY_MS);
    return () => clearTimeout(net);
  }, [reader]);
  useEffect(() => isReady.set(ready), [ready, isReady]);

  // Sent away mid-intro (the app switcher's snapshot): the app as it will be, no mark. A user leaving
  // passes through inactive; iOS also sends a bare, brief background (~200 ms) on the first launch after
  // an install or an appearance change, which must not cut the intro short.
  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = AppState.addEventListener('change', state => {
      clearTimeout(timer);
      if (state === 'inactive') setGone(true);
      else if (state === 'background') timer = setTimeout(() => setGone(true), AWAY_MS);
    });
    return () => {
      clearTimeout(timer);
      sub.remove();
    };
  }, []);

  // The beat waits for the header brand it flies to, then for both threads to go quiet: while React
  // commits, Reanimated holds its UI updates back, and while native views mount nothing draws, so motion
  // played then is unseen (useSettled.ts). The same holds for every exit: Reduce Motion's cross-fade
  // started on ready alone was a hard cut.
  const brandUp = useIntro(s => s.measure !== null);
  const settled = useSettled(gateOpen(exit, brandUp, overdue), PLAY_CAP_MS);

  // The hand-off, on the UI thread: from the beat's end with no JS hop, or straight away without a beat.
  const handOff = (m: number) => {
    'worklet';
    if (started.get()) return;
    started.set(true);
    mode.set(m);
    if (m === REDUCE) headerShown.set(1);
    rate.set(skipped.get() && m === FLY ? SKIP_RATE : EXIT_RATES[m]);
  };
  /** Where the beat hands off: its end, or the landing after a skip. */
  const due = () => {
    'worklet';
    return t.get() >= (skipped.get() ? LAND : BEAT_END);
  };
  const plan = (m: number) => {
    'worklet';
    planned.set(m);
    if (due()) handOff(m);
  };
  useAnimatedReaction(() => t.get() >= BEAT_END, (end, was) => {
    if (end && was === false && planned.get() !== NONE) handOff(planned.get());
  });

  useEffect(() => {
    if (!settled || exit === null) return undefined;
    if (!plays) {
      scheduleOnUI(handOff, exit);
      return undefined;
    }
    // The crouch starts as the gate opens, and once started the beat never pauses (the gate can close
    // again, e.g. the header brand remounting under a slow Debug start).
    if (!skipped.get()) running.set(true);
    if (exit === FADE) scheduleOnUI(plan, FADE);
    return undefined;
    // handOff and plan are worklets over shared values: stable in effect.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [settled, exit, plays, running, skipped]);

  // Where the mark lands, measured once at the take-off (measured at the gate it sat ~40 pt high, before
  // the safe area applied), so nothing reaches the JS thread near the hand-off.
  const measureBrand = () => {
    const measure = useIntro.getState().measure;
    const fly = (rect: Rect | null) => {
      if (started.get()) return;
      if (rect) {
        // On the device-pixel grid, as the header brand itself is drawn; LAND_NUDGE is what the scaled
        // mark still sits above the header's own drawing (measured), so the swap frame doesn't move.
        target.set({ x: PixelRatio.roundToNearestPixel(rect.x), y: PixelRatio.roundToNearestPixel(rect.y) + LAND_NUDGE });
        place.set({ lefts: rect.lefts, home: rect.home });
      } else if (__DEV__) {
        console.warn('[intro] header brand not measured: fading instead of flying');
      }
      scheduleOnUI(plan, rect ? FLY : FADE);
    };
    if (!measure) fly(null);
    else measure().then(fly, () => fly(null));
  };
  useAnimatedReaction(() => t.get() >= LAUNCH, (now, was) => {
    if (now && was === false && planned.get() === NONE && !started.get() && exitIsFly.get()) scheduleOnRN(measureBrand);
  });

  // The header brand: swapped for the arriving mark in the same frame, or faded in under a fading mark.
  // The list (and with the backdrop, the bar) comes in over the second half.
  useAnimatedReaction(() => h.get(), (progress, was) => {
    const m = mode.get();
    if (m === FLY) headerShown.set(progress >= 1 ? 1 : 0);
    else if (m !== REDUCE) headerShown.set(glide((progress - 0.3) / 0.7));
    contentShown.set(m === REDUCE ? smooth(progress) : glide((progress - REVEAL_AT) / (1 - REVEAL_AT)));
    if (progress >= JS_QUIET_UNTIL && (was ?? 0) < JS_QUIET_UNTIL && reader.get()) scheduleOnRN(setHidden, true);
  });

  useEffect(() => {
    if (gone) finishIntro();
  }, [gone]);

  // On the UI thread (the JS thread is busy at launch, so a JS press would land late). Before the beat
  // a tap drops it (the still panda fades straight to the app); during it, a tap plays the rest quickly.
  const skip = () => {
    'worklet';
    const now = t.get();
    if (reduced || skipped.get() || now >= BEAT_END || started.get()) return;
    skipped.set(true);
    if (now === 0) {
      // The app is under the intro once it is ready: fade to it now, on this thread.
      if (isReady.get()) handOff(DIRECT);
      scheduleOnRN(setSkippedEarly, true);
      return;
    }
    // Before the take-off nothing is measured yet: measure now (it lands inside the hurried leap).
    if (planned.get() === NONE && exitIsFly.get()) scheduleOnRN(measureBrand);
    const land = () => {
      'worklet';
      // The landing's settle runs on under the hand-off (calmed by it).
      running.set(true);
      if (planned.get() !== NONE) handOff(planned.get());
    };
    if (now >= LAND) {
      land();
      return;
    }
    running.set(false);
    t.set(withTiming(LAND, { duration: SKIP_MS, easing: SKIP_EASE, reduceMotion: ReduceMotion.Never }, finished => {
      if (finished) land();
    }));
  };
  const tap = Gesture.Tap().onEnd(skip);

  const cover = useAnimatedStyle(() => {
    const m = mode.get();
    const p = h.get();
    if (m === REDUCE) return { opacity: 1 - smooth(p) };
    return { opacity: m === DIRECT ? 1 - glide(p) : backdrop(p) };
  });
  const mark = useAnimatedStyle(() => {
    const p = h.get();
    const m = mode.get();
    if (m === REDUCE) return { opacity: 1 - smooth(p), transform: [{ translateX: rest.x }, { translateY: rest.y }, { scale: 1 }] };
    if (m === FADE || m === DIRECT) {
      const s = 1 + FADE_GROW * glide(p);
      return {
        opacity: 1 - glide(p / 0.7),
        transform: [{ translateX: rest.x - (layout.width * (s - 1)) / 2 }, { translateY: rest.y - (layout.height * (s - 1)) / 2 }, { scale: s }],
      };
    }
    // Shown to the last frame, then swapped for the header brand in the same frame.
    const f = flight(p, rest, target.get());
    return { opacity: p >= 1 ? 0 : 1, transform: [{ translateX: f.x }, { translateY: f.y }, { scale: f.scale }] };
  });

  if (gone) return null;
  return (
    // Its own gesture root: the intro sits outside the app's. Taps during the hand-off land here and do nothing.
    <GestureHandlerRootView style={StyleSheet.absoluteFill} onLayout={hideLaunchScreen}>
    <GestureDetector gesture={tap}>
    <View
      style={StyleSheet.absoluteFill} accessible={!hidden} accessibilityLabel="PandaCode"
      accessibilityElementsHidden={hidden} importantForAccessibility={hidden ? 'no-hide-descendants' : 'auto'}
      accessibilityHint="Skips the intro." accessibilityActions={ACTIONS}
      onAccessibilityAction={() => scheduleOnUI(skip)}
    >
      <Animated.View style={[StyleSheet.absoluteFill, { backgroundColor: colors.page }, cover]} />
      <Animated.View style={[styles.mark, mark]}>
        <IntroMark t={t} w={w} from={from} layout={layout} calm={calm} drift={drift} place={place} lefts={spans.map(s => s.left)} onLetter={onLetter} />
      </Animated.View>
    </View>
    </GestureDetector>
    </GestureHandlerRootView>
  );
}

const styles = StyleSheet.create({ mark: { position: 'absolute', left: 0, top: 0, transformOrigin: '0% 0%' } });
