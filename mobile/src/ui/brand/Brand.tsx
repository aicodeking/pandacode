// The Inbox's header brand: the `PandaCode` wordmark, centred on the bar buttons' axis, with a small
// panda standing just after the "e", the whole word left readable. On first sight and when the app
// comes back from the background it takes a short trip over the word (panda-motion.ts) and comes
// home; a tab return only gets a glance and a blink. The letter at its perch holds its colour (at rest
// the pink e), letters it passes fill with theirs for a moment. One UI-thread clock (useShowClock.ts)
// drives everything and sleeps whenever nothing moves; Reduce Motion (read live) leaves the resting
// pose. A tap, or VoiceOver's action, makes the panda somersault. iOS only: the layout is measured
// for SF Rounded, so Android shows the plain wordmark.
import { useIsFocused } from 'expo-router';
import { useEffect, useMemo, useRef, useState, type ComponentRef } from 'react';
import { AccessibilityInfo, AppState, Platform, StyleSheet, Text, useColorScheme, View, type LayoutChangeEvent } from 'react-native';
import { Gesture, GestureDetector, GestureHandlerRootView } from 'react-native-gesture-handler';
import Animated, {
  Easing, ReduceMotion, useAnimatedReaction, useAnimatedStyle, useDerivedValue, useReducedMotion, useSharedValue, withDelay, withSequence, withSpring, withTiming,
} from 'react-native-reanimated';
import { scheduleOnRN, scheduleOnUI } from 'react-native-worklets';
import { headerShown, useIntro, type Rect } from '../splash/handoff.ts';
import { alpha, haptic, mix, type HapticKind, type StateTone } from '../ds/index.ts';
import { paletteFor } from '../ds/palette.ts';
import { useColors, type Colors } from '../theme.ts';
import {
  ASCENDER, BASELINE, BOX_HEIGHT, CAP, DIP, HALF_WIDTH, letterTop, OPTICAL_INSET, PANDA_SIZE, PERCH_OFFSET_D, REST_GAP, SHADOW_HEIGHT, SHADOW_WIDTH, SINK, TRICK_JUMP,
} from './geometry.ts';
import { Letter, TEXT_BASELINE } from './Letter.tsx';
import { Panda, type PandaInk } from './Panda.tsx';
import { canTrick, GROUND, letter, PERCH_LETTER, passTimes, pose, smooth, TRICK_LAND, TRICK_S, trick } from './panda-motion.ts';
import { useShowClock } from './useShowClock.ts';

export const WORD = 'PandaCode';
/** Each letter's colour: state tones, a quiet rainbow without amber; only the e, the resting accent, is pink. */
export const TONES: readonly StateTone[] = ['team', 'plan', 'remote', 'edit', 'team', 'saver', 'plan', 'team', 'worktree'];
const ESTIMATED_WIDTH = 11.8;
const VIVID = paletteFor('dark', false);
const LIGHT = paletteFor('light', false);
const NUDGE_TILT = 8;
/** How long the clock stays awake for a nudge. */
const NUDGE_HOLD = 0.6;
// The brand gates Reduce Motion itself (no trick, no nudge), so its animations never defer to
// Reanimated's own reading of the setting, which can lag a change and would skip them to the end.
const NUDGE_IN = { duration: 80, easing: Easing.out(Easing.quad), reduceMotion: ReduceMotion.Never };
const NUDGE_BACK = { damping: 9, stiffness: 260, mass: 0.6, reduceMotion: ReduceMotion.Never };
const TRICK_TIMING = { duration: TRICK_S * 1000, easing: Easing.linear, reduceMotion: ReduceMotion.Never };
/** Time for a sleeping clock to wake before the trick's first frame. */
const WAKE_MS = 80;
/** The resting breath, as a fraction of the panda's height (under a point). */
const BREATH_SCALE = 0.04;
const SHADOW_ALPHA = 0.06;

/**
 * A letter's colour. Light's state tones are tuned for small text and look navy and plum on a heavy
 * wordmark; mostly the dark scheme's hue, deepened a little, reads colourful and still holds the
 * ink's weight (not with Increase Contrast, which keeps the stronger tone).
 */
export function toneFor(colors: Colors, dark: boolean, tone: StateTone): string {
  return dark || colors[tone] !== LIGHT[tone] ? colors[tone] : mix(VIVID[tone], 0.7, colors[tone]);
}

export function inkFor(colors: Colors, dark: boolean, accent: string): PandaInk {
  const fur = dark ? mix(colors.text, 0.35, '#ffffff') : colors.page;
  const patch = dark ? mix(colors.text, 0.29, colors.page) : colors.text;
  return {
    // Light: pure white fur, its volume carried by a soft falloff and a light rim. Dark: a near-white.
    fur,
    // Patches, ears, arms and feet; in dark lifted well off the bar (read at 1x), pupils black.
    ink: patch,
    pupil: dark ? mix('#000000', 0.8, colors.page) : mix('#000000', 0.5, colors.text),
    // The accent pink, so the panda and the e read as one mark.
    blush: alpha(accent, dark ? 0.75 : 0.5),
    shine: alpha('#ffffff', dark ? 0.75 : 0.9),
    shade: dark ? mix(colors.page, 0.12, colors.text) : mix(colors.text, 0.08, colors.page),
    belly: dark ? fur : mix(colors.text, 0.05, colors.page),
    rim: dark ? 'transparent' : alpha(colors.text, 0.11),
    earRim: dark ? mix(fur, 0.35, patch) : patch,
  };
}

function useAppActive() {
  const [active, setActive] = useState(AppState.currentState === 'active');
  useEffect(() => {
    const sub = AppState.addEventListener('change', state => setActive(state === 'active'));
    return () => sub.remove();
  }, []);
  return active;
}

/** Reduce Motion: the first value read synchronously (no frame of motion), then followed live. */
function useReduceMotion() {
  const initial = useReducedMotion();
  const [on, setOn] = useState(initial);
  useEffect(() => {
    const sub = AccessibilityInfo.addEventListener('reduceMotionChanged', setOn);
    return () => sub.remove();
  }, []);
  return on;
}

const buzz = (kind: HapticKind) => haptic(kind);
const ACTIONS = [{ name: 'activate', label: 'Make the panda somersault' }];
/** The perch each accent letter belongs to. */
const PERCH_OF = WORD.split('').map((_, i) => {
  const perch = PERCH_LETTER.indexOf(i as (typeof PERCH_LETTER)[number]);
  return perch < 0 ? undefined : perch;
});

interface Span { left: number; width: number }
const estimated: readonly Span[] = WORD.split('').map((_, i) => ({ left: i * ESTIMATED_WIDTH, width: ESTIMATED_WIDTH }));

function PandaBrand() {
  const colors = useColors();
  const dark = useColorScheme() === 'dark';
  const reduced = useReduceMotion();
  const focused = useIsFocused();
  const active = useAppActive();
  // On a cold launch the intro's mark flies in to take this place: hidden and still until it lands.
  const introDone = useIntro(s => s.done);
  const { time, now: showTime, hold, asleep } = useShowClock(focused && active && !reduced && introDone, reduced);
  const inset = useRef<ComponentRef<typeof View>>(null);
  // The intro lands each letter and the panda exactly where this brand draws them.
  const placed = useRef({ lefts: estimated.map(s => s.left), home: 0 });
  useEffect(() => {
    const measure = () => new Promise<Rect | null>(resolve => {
      if (!inset.current) resolve(null);
      else inset.current.measureInWindow((x, y, w, h) => resolve(w > 0 ? { x, y, width: w, height: h, ...placed.current } : null));
    });
    useIntro.setState({ measure });
    return () => useIntro.setState(s => (s.measure === measure ? { measure: null } : s));
  }, []);
  const shown = useAnimatedStyle(() => ({ opacity: headerShown.get() }));
  const [spans, setSpans] = useState(estimated);
  const trickAt = useSharedValue(0);
  const nudge = useSharedValue(0);

  // The trick's landing haptic, at the moment of contact.
  useAnimatedReaction(() => trickAt.get() >= TRICK_LAND && trickAt.get() < TRICK_S, (down, was) => {
    if (down && was === false) scheduleOnRN(buzz, 'selection');
  });

  // Layout, once per measurement: the perches (home just after the e, the d's stem, the C), when the
  // panda passes or lands on each letter, and where each letter's top is for the shadow.
  const { px, ph, passes, lefts, rights, tops, width } = useMemo(() => {
    const centre = (i: number) => spans[i].left + spans[i].width / 2;
    const home = spans[8].left + spans[8].width + REST_GAP + HALF_WIDTH;
    const perchX = [home, centre(7) + PERCH_OFFSET_D, centre(5)];
    return {
      px: perchX, ph: [0, ASCENDER - SINK, CAP - SINK],
      passes: passTimes(spans.map((_, i) => centre(i)), perchX),
      lefts: spans.map(s => s.left), rights: spans.map(s => s.left + s.width), tops: WORD.split('').map(letterTop),
      width: home + HALF_WIDTH + 2,
    };
  }, [spans]);
  useEffect(() => { placed.current = { lefts, home: px[0] }; }, [lefts, px]);

  // The show's pose and the trick's, computed once per frame into one flat pose the views read.
  const now = useDerivedValue(() => {
    const p = pose(time.get(), px, ph);
    const q = trick(trickAt.get());
    return {
      x: p.x + q.drift, feet: p.feet + q.lift * TRICK_JUMP, lift: Math.min(p.lift + q.lift, 1), sy: p.sy * q.sy * (1 + BREATH_SCALE * p.breath),
      perch: p.perch, grounded: p.grounded && q.lift === 0, groundLean: p.groundLean, pitch: p.pitch, tilt: p.tilt + NUDGE_TILT * nudge.get(),
      spin: q.spin, look: p.look, earsL: p.earsL + q.earsL, earsR: p.earsR + q.earsR, earsOut: p.earsOut + q.earsOut, blink: p.blink,
      tuck: p.tuck + q.tuck, bob: p.bob + q.bob, nod: p.nod + q.nod, arms: Math.max(p.arms, q.arms), brace: Math.max(p.brace, q.brace), breath: p.breath,
    };
  });
  // Where the feet are: the perch, sunk into a letter's top and pressed with it.
  const feetY = useDerivedValue(() => {
    const p = now.get();
    const pressed = p.grounded && p.perch !== GROUND ? letter(time.get(), passes[PERCH_LETTER[p.perch]]).dip * DIP : 0;
    return BASELINE - p.feet + pressed + p.bob;
  });
  const panda = useAnimatedStyle(() => ({
    transform: [{ translateX: now.get().x - PANDA_SIZE / 2 }, { translateY: feetY.get() - PANDA_SIZE }],
  }));
  // Ground lean pivots at the feet, so planted feet never slide.
  const lean = useAnimatedStyle(() => ({ transform: [{ rotate: `${now.get().groundLean}deg` }] }));
  // Pitch in the air, the curious tilt, a tap's nudge and the somersault turn about the centre.
  const spin = useAnimatedStyle(() => {
    const p = now.get();
    return { transform: [{ rotate: `${p.pitch + p.tilt + p.spin}deg` }] };
  });
  const squash = useAnimatedStyle(() => {
    const sy = now.get().sy;
    return { transform: [{ scaleX: 1 / Math.sqrt(sy) }, { scaleY: sy }] };
  });
  // A small shadow under the feet: on the ground at rest, on whichever letter is below in flight
  // (behind the letters, shrinking as the panda rises). Light only: on a dark bar it would not read.
  const shadow = useAnimatedStyle(() => {
    const p = now.get();
    let top = 0;
    for (let i = 0; i < lefts.length; i++) if (p.x >= lefts[i] && p.x <= rights[i]) top = tops[i];
    const onLetter = top > 0;
    return {
      // Gone by 40% of the lift, so at rest it is a hint of contact rather than an underline.
      opacity: (1 - smooth(p.lift / 0.4)) * (onLetter ? smooth(p.lift / 0.15) : 1),
      transform: [{ translateX: p.x - SHADOW_WIDTH / 2 }, { translateY: BASELINE - top - SHADOW_HEIGHT / 2 }, { scale: 1 - 0.5 * p.lift }],
    };
  });

  // On the UI thread; only the haptics cross to JS. The guard reads the show's real time, and the
  // clock is held awake, so the trick reaches the screen even while the show is asleep.
  const flip = () => {
    'worklet';
    const busy = trickAt.get() > 0 && trickAt.get() < TRICK_S;
    if (reduced || busy) return;
    if (!canTrick(showTime())) {
      // Mid-trip: a small acknowledging tilt instead.
      scheduleOnRN(buzz, 'selection');
      hold(NUDGE_HOLD);
      nudge.set(withSequence(withTiming(1, NUDGE_IN), withSpring(0, NUDGE_BACK)));
      return;
    }
    scheduleOnRN(buzz, 'light');
    // Waking a sleeping clock goes through JS; start the trick once it is awake, so no frame is lost.
    const wait = asleep() ? WAKE_MS : 0;
    hold(TRICK_S + 0.1 + wait / 1000);
    trickAt.set(0);
    trickAt.set(withDelay(wait, withTiming(TRICK_S, TRICK_TIMING), ReduceMotion.Never));
  };
  const tap = Gesture.Tap().onEnd(flip);
  const onLetter = (i: number) => (event: LayoutChangeEvent) => {
    const { x, width: w } = event.nativeEvent.layout;
    setSpans(prev => prev.map((span, j) => (j === i ? { left: x, width: w } : span)));
  };

  const ink = inkFor(colors, dark, toneFor(colors, dark, 'worktree'));
  return (
    // A bar item is outside React Native's root touch handler, so the tap is a gesture-handler tap
    // with its own root, sized explicitly (it defaults to flex: 1, which collapses in a bar item).
    <GestureHandlerRootView style={[styles.box, { width: width + OPTICAL_INSET }]}>
      <GestureDetector gesture={tap}>
        <Animated.View
          ref={inset} accessible accessibilityLabel="PandaCode" accessibilityRole="header"
          accessibilityHint={reduced ? undefined : 'The panda can somersault.'}
          accessibilityActions={reduced ? undefined : ACTIONS} onAccessibilityAction={() => scheduleOnUI(flip)}
          style={[StyleSheet.absoluteFill, styles.inset, shown]}
        >
          {!dark && <Animated.View style={[styles.shadow, { backgroundColor: alpha(colors.text, SHADOW_ALPHA) }, shadow]} />}
          <View style={styles.word}>
            {WORD.split('').map((char, i) => (
              <Letter
                key={i} char={char} passes={passes[i]} time={time} ink={colors.text} tone={toneFor(colors, dark, TONES[i])}
                perch={PERCH_OF[i]} onLayout={onLetter(i)}
              />
            ))}
          </View>
          <Animated.View style={[styles.panda, panda]}>
            <Animated.View style={[styles.pivot, styles.feet, lean]}>
              <Animated.View style={[styles.pivot, spin]}>
                <Animated.View style={[styles.pivot, styles.feet, squash]}>
                  <Panda pose={now} ink={ink} />
                </Animated.View>
              </Animated.View>
            </Animated.View>
          </Animated.View>
        </Animated.View>
      </GestureDetector>
    </GestureHandlerRootView>
  );
}

/** Android: the wordmark alone, in the system's heavy weight. */
function PlainBrand() {
  const colors = useColors();
  return <Text accessibilityRole="header" allowFontScaling={false} style={[styles.plain, { color: colors.text }]}>{WORD}</Text>;
}

export const Brand = Platform.OS === 'ios' ? PandaBrand : PlainBrand;

const styles = StyleSheet.create({
  plain: { fontSize: 20, fontWeight: '800' },
  box: { height: BOX_HEIGHT },
  inset: { left: OPTICAL_INSET },
  word: { position: 'absolute', left: 0, top: BASELINE - TEXT_BASELINE, flexDirection: 'row' },
  panda: { position: 'absolute', left: 0, top: 0, width: PANDA_SIZE, height: PANDA_SIZE },
  pivot: { width: PANDA_SIZE, height: PANDA_SIZE },
  feet: { transformOrigin: '50% 100%' },
  shadow: { position: 'absolute', left: 0, top: 0, width: SHADOW_WIDTH, height: SHADOW_HEIGHT, borderRadius: SHADOW_HEIGHT / 2 },
});
