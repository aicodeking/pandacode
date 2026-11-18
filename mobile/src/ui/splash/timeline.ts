// The cold-launch intro as pure functions of time, so the UI thread computes each frame from one clock
// and tests can check it. No React Native imports.
//
// While the app gets ready the launch screen's panda is alive, not frozen: a blink soon after the
// swap, then a slow breath (`idle`, on its own clock from mount). The beat (seconds since it started):
// the panda, sitting on the word's baseline, crouches with its ears perked and leaps along the word to
// its place after the e, shrinking as it goes as if moving back into the screen. The letters behind
// the take-off rise just before it, left to right, as anticipation; the rest pop up as the panda flies over them, each
// carrying its colour for a moment, so the colour follows the panda and arrives at the pink e as it
// lands. It settles with a glance back at the word and a blink. Then the hand-off (0..1 of its own):
// the mark glides and shrinks into the Inbox header's brand, the backdrop clearing as it arrives.
import { arc, climb, earSpring, keyframes, LAND_BLEND, LAND_SQUAT, lerp, perk, pulse, smooth, travel } from '../brand/motion-curves.ts';
import type { Pose } from '../brand/panda-motion.ts';

/** The wordmark's scale in the intro (the header's is 1), and the launch screen panda's (88 pt). */
export const WORD_SCALE = 2;
export const START_SCALE = 4;

/** The crouch starts almost at once: the idle before the beat was the wait. */
const CROUCH_AT = 0.04;
const CROUCH_LEN = 0.2;
export const LAUNCH = CROUCH_AT + CROUCH_LEN;
const AIR = 0.42;
export const LAND = LAUNCH + AIR;
/** How high the arc rises above the baseline, in intro points: the 88 pt panda's feet clear the letters. */
const ARC_HEIGHT = 50;
const APEX_AT = 0.42;
/** A short landed pause with a glance back at the word; the settle and the blink run on into the hand-off. */
export const BEAT_END = LAND + 0.2;
/** A small look ahead (more would slide the cheeks out of the face at this size), then back at the word. */
const LOOK = [[0, 0], [CROUCH_AT, 0], [CROUCH_AT + 0.12, 0.3], [LAND + 0.03, 0.3], [LAND + 0.09, -0.4], [LAND + 0.13, -0.4], [LAND + 0.2, 0]] as const;
const BLINK_AT = LAND + 0.2;
const BLINK_HALF = 0.06;
const PITCH = 14;
const TUCK = 3;
const CROUCH_SY = [[0, 1], [0.04, 1.04], [0.15, 0.82], [CROUCH_LEN, 0.84]] as const;
const LEAN = 3;
const TIP = 5;
const STRETCH = 0.12;
const SHRINK_BY = 0.6;

/** Before the beat (seconds since the first drawn frame): a blink, a breath you can see, one ear flick. */
const IDLE_BLINK = 0.35;
const IDLE_BLINK_GAP = 2.8;
const BREATH = 1.3;
const BREATH_FROM = 0.1;
const BREATH_SCALE = 0.08;
const EAR_FLICK = 0.6;
/** The idle breath eases out over the beat's first moments. */
const BREATH_OUT = 0.12;

/**
 * The letters: those behind the take-off rise through the crouch, left to right, so they are up for the
 * push-off; the rest pop just before the panda passes; the e is nearly up when the panda lands on it.
 */
const RIPPLE = 0.04;
const PASS_LEAD = 0.03;
const E_LEAD = 0.1;
/** Each letter's colour: in with its rise, held, and out; the e holds it. */
const TONE_IN = 0.12;
const TONE_HOLD = 0.12;
const TONE_OUT = 0.12;

/** The hand-off, the no-beat hand-off (a tap before the beat), and Reduce Motion's cross-fade. */
export const HANDOFF_MS = 360;
export const DIRECT_MS = 300;
export const FADE_MS = 200;
/** After a skip mid-beat: the panda hurries to its landing, then a quicker hand-off. */
export const SKIP_MS = 120;
export const SKIP_HANDOFF_MS = 300;

export interface Point { x: number; y: number }
export interface IntroPose extends Pose {
  /** Feet position in the mark's coordinates, and the panda's scale there. */
  y: number; scale: number;
}

/**
 * Vertical scale `v` s after the landing: the header panda's squash and rebound, damped faster to fit
 * the shorter settle, and exactly 1 by SETTLE_S.
 */
const SETTLE_S = 0.3;
export function settle(v: number): number {
  'worklet';
  if (v < LAND_BLEND) return lerp(1 + STRETCH, LAND_SQUAT, smooth(v / LAND_BLEND));
  const w = v - LAND_BLEND;
  const rebound = (1 - LAND_SQUAT) * Math.exp(-8 * w) * Math.cos(2 * Math.PI * 3.5 * w);
  return 1 - rebound * (1 - smooth((v - SETTLE_S + 0.1) / 0.1));
}

function blinkCurve(t: number, at: number): number {
  'worklet';
  return Math.max(0, 1 - Math.abs(t - at) / BLINK_HALF);
}

/** Before the beat: 0..1 of a blink and of a breath, `w` seconds after mount. */
export function idle(w: number): { blink: number; breath: number } {
  'worklet';
  const k = Math.max(0, Math.round((w - IDLE_BLINK) / IDLE_BLINK_GAP));
  const blink = blinkCurve(w, IDLE_BLINK + k * IDLE_BLINK_GAP);
  const breath = w > BREATH_FROM ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (w - BREATH_FROM)) / BREATH) : 0;
  return { blink, breath };
}

/**
 * The panda `t` s into the beat (0 before it), `w` s after mount, leaping from `from` (scale
 * START_SCALE) to `to` (WORD_SCALE), feet positions on the baseline.
 */
export function introPose(t: number, w: number, from: Point, to: Point): IntroPose {
  'worklet';
  const air = (t - LAUNCH) / AIR;
  const inAir = air > 0 && air < 1;
  const u = air <= 0 ? 0 : air >= 1 ? 1 : air;
  const s = t - CROUCH_AT;
  const lift = inAir ? arc(u, APEX_AT) : 0;
  const v = climb(u, APEX_AT);
  let sy = 1;
  let groundLean = 0;
  if (s > 0 && s < CROUCH_LEN) {
    sy = keyframes(CROUCH_SY, s);
    groundLean = -LEAN * smooth(s / CROUCH_LEN);
  } else if (inAir) {
    sy = lerp(0.84, 1 + STRETCH * Math.abs(v), smooth((t - LAUNCH) / 0.08));
    groundLean = -LEAN * (1 - smooth((t - LAUNCH) / 0.08));
  } else if (t >= LAND) {
    sy = settle(t - LAND);
    groundLean = pulse(t - LAND, 0.26, TIP);
  }
  const rest = idle(w);
  const waiting = 1 - smooth(t / BREATH_OUT);
  const flick = earSpring(w - EAR_FLICK) * waiting;
  const ears = -1.5 * perk(s, CROUCH_LEN) + earSpring(s - CROUCH_LEN) + earSpring(t - LAND);
  const earsR = -1.5 * perk(s - 0.04, CROUCH_LEN) + earSpring(s - 0.04 - CROUCH_LEN) + earSpring(t - LAND - 0.04) + flick;
  return {
    x: lerp(from.x, to.x, travel(u)),
    y: lerp(from.y, to.y, u) - (ARC_HEIGHT + Math.abs(to.y - from.y) / 2) * lift,
    // At its final size by 60% of the leap, so it lands as it will sit.
    scale: lerp(START_SCALE, WORD_SCALE, smooth(u / SHRINK_BY)),
    feet: 0, lift, sy: sy * (1 + BREATH_SCALE * rest.breath * waiting), perch: 0, grounded: !inAir, groundLean,
    pitch: inAir ? PITCH * v * (1 - smooth((u - 0.7) / 0.3)) * Math.sign(to.x - from.x) : 0,
    tilt: 0, look: keyframes(LOOK, t), earsL: ears, earsR, earsOut: 0.5 * perk(s, CROUCH_LEN),
    blink: Math.max(blinkCurve(t, BLINK_AT), t > 0 ? 0 : rest.blink),
    tuck: TUCK * lift, bob: pulse(t - LAND, 0.2, 2), nod: pulse(t - LAND, 0.22, 0.7), arms: lift, brace: pulse(t - LAND, 0.12, 1), breath: 0,
  };
}

/** When the panda's eased travel reaches fraction `f` of the hop's distance, as air progress. */
function reach(f: number): number {
  let lo = 0;
  let hi = 1;
  for (let i = 0; i < 24; i++) {
    const mid = (lo + hi) / 2;
    if (travel(mid) < f) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

/**
 * When each letter rises, from the letters' centres and the take-off and landing x (mark coordinates):
 * at and behind the take-off, left to right through the crouch; ahead of it, just before the panda passes
 * over; the e, E_LEAD before the landing, so it is nearly up when the panda lands on it. Runs once per layout.
 */
export function letterTimes(centres: readonly number[], fromX: number, toX: number): number[] {
  return centres.map((c, i) => {
    if (c <= fromX) return CROUCH_AT + RIPPLE * i;
    if (i === centres.length - 1) return LAND - E_LEAD;
    const f = Math.min(1, (c - fromX) / (toX - fromX));
    return Math.max(LAUNCH, LAUNCH + AIR * reach(f) - PASS_LEAD);
  });
}

/** The letter under the take-off: it dips as the panda pushes off. */
export function launchLetter(centres: readonly number[], fromX: number): number {
  let best = 0;
  for (let i = 1; i < centres.length; i++) if (Math.abs(centres[i] - fromX) < Math.abs(centres[best] - fromX)) best = i;
  return best;
}

/** A letter's rise from `start`: 0 hidden, 1 in place, a ~9% overshoot (a damped spring, exactly 1 once settled). */
export function letterRise(t: number, start: number): number {
  'worklet';
  const s = t - start;
  if (s <= 0) return 0;
  // Within 0.5% of rest by then.
  if (s >= 0.4) return 1;
  const zeta = 0.6;
  const w0 = 22;
  const wd = w0 * Math.sqrt(1 - zeta * zeta);
  return 1 - Math.exp(-zeta * w0 * s) * (Math.cos(wd * s) + ((zeta * w0) / wd) * Math.sin(wd * s));
}
export function letterOpacity(t: number, start: number): number {
  'worklet';
  return smooth((t - start) / 0.1);
}
/** How much of its colour a letter shows: in with its rise, held, out; `keep` (the e) holds it. */
export function letterTone(t: number, start: number, keep: boolean): number {
  'worklet';
  const s = t - start;
  if (s <= 0) return 0;
  if (s < TONE_IN) return smooth(s / TONE_IN);
  if (keep) return 1;
  return 1 - smooth((s - TONE_IN - TONE_HOLD) / TONE_OUT);
}

/** A cubic bezier easing (0..1 to 0..1), for the hand-off. */
function bezier(x1: number, y1: number, x2: number, y2: number, x: number): number {
  'worklet';
  const cx = 3 * x1;
  const bx = 3 * (x2 - x1) - cx;
  const ax = 1 - cx - bx;
  const cy = 3 * y1;
  const by = 3 * (y2 - y1) - cy;
  const ay = 1 - cy - by;
  let u = x;
  for (let i = 0; i < 8; i++) {
    const d = (3 * ax * u + 2 * bx) * u + cx;
    if (Math.abs(d) < 1e-6) break;
    u = Math.min(1, Math.max(0, u - (((ax * u + bx) * u + cx) * u - x) / d));
  }
  return ((ay * u + by) * u + cy) * u;
}

/** The hand-off's travel shares one curve with its shrink: a firm start, home (within 0.5 pt) by 85%, no creep. */
const ARRIVE_BY = 0.9;
export function glide(h: number): number {
  'worklet';
  const c = Math.min(Math.max(h / ARRIVE_BY, 0), 1);
  return bezier(0.25, 0.1, 0, 1, c);
}

export interface Flight { x: number; y: number; scale: number }

/**
 * The mark's top left and scale during the hand-off, from `rest` (scale 1) to `target` (1 / WORD_SCALE).
 * It shrinks with its travel on one curve.
 */
export function flight(h: number, rest: Point, target: Point): Flight {
  'worklet';
  const e = glide(h);
  // Vertical leads horizontal a little, so the path curves instead of running straight.
  const ey = glide(h * 1.3);
  // The shrink rides the same curve as the travel.
  return { x: lerp(rest.x, target.x, e), y: lerp(rest.y, target.y, ey), scale: WORD_SCALE ** -e };
}

/** The backdrop clears early, so the bar the mark flies to is there while it flies; the list follows from REVEAL_AT. */
export const REVEAL_AT = 0.32;
export function backdrop(h: number): number {
  'worklet';
  return 1 - smooth((h - 0.15) / 0.45);
}
