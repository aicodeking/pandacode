// The brand panda's show as pure functions of show time (seconds since it started), so the UI thread
// computes every frame from one clock and tests can check it. No React Native imports.
//
// The panda rests on the ground just after the "e", leaving the whole word readable. The show (on
// launch and foreground) is a short trip: a hop up onto the last "d", a touch and a hop onto the "C",
// a look around, and back the same way. Each hop is short and high for its length, its apex beside
// the status bar clock rather than under it. A tab return only gets a greet (a glance and a blink).
// Positions come from layout: `px`/`ph` are the perches' x (word coordinates) and feet heights.
import {
  APEX, arc, climb, CROUCH_SQUAT, earSpring, keyframes, landing, landingTip, LAUNCH_BLEND, leaving, lerp, perk, pulse, SETTLE, smooth, STRETCH, travel,
} from './motion-curves.ts';

export { APEX, arc, climb, earSpring, keyframes, SETTLE, smooth, travel } from './motion-curves.ts';

/** The perches: on the ground after the "e" (rest), the last "d"'s stem, the "C". */
export const GROUND = 0;
export const D_STEM = 1;
export const C_TOP = 2;

const CROUCH = 0.26;
/** Body pitch in the air, degrees, about the centre: leaning into the travel rising, back falling, level for the contact. */
const PITCH_UP = 18;
const PITCH_DOWN = 14;
/** The ground lean, about the feet: back through a crouch, tipping forward after a landing. */
const CROUCH_LEAN = 2.5;
const LANDING_TIP = 5;
/** The feet tuck up at the apex, in points. */
const TUCK = 3;
const TRICK_TUCK = 3;
/** Ear anticipation in a crouch: up (points) and out. */
const PERK_UP = 1.5;
const PERK_OUT = 0.5;
/** The tap trick: crouch, a back somersault in place, landing and settle. */
const TRICK_CROUCH = 0.15;
const TRICK_AIR = 0.5;
export const TRICK_LAND = TRICK_CROUCH + TRICK_AIR;
export const TRICK_S = TRICK_LAND + SETTLE;
const TRICK_DRIFT = 0;
/** The second ear follows the first by this much. */
const EAR_LAG = 0.04;
const BOB = 2;
const TOUCH_BOB = 1;
/** Arms brace on every contact. */
const BRACE = 0.12;

export interface Hop {
  from: number; to: number;
  /** When the crouch (or, for a touch, the contact) begins; how long until the feet leave. */
  crouch: number; crouchLen: number; touch: boolean;
  air: number;
  /** How far the feet rise above the higher of the two perches, and where in the hop the apex falls. */
  height: number; apex: number;
}

/** The trip: out over two hops with a touch on the d, a look around on the C, and home. */
const FIRST_CROUCH = 1;
const PAUSE = 0.9;
export const HOPS: readonly Hop[] = (() => {
  const spec = [
    // Hops touching the C keep their apex on the d's side, away from the clock above the C.
    // A varied rhythm: up onto the d, a quick low hop to the C, back, and a bigger homecoming.
    { from: GROUND, to: D_STEM, touch: false, crouchLen: CROUCH, air: 0.4, height: 8.5, apex: APEX, wait: FIRST_CROUCH },
    { from: D_STEM, to: C_TOP, touch: true, crouchLen: 0.17, air: 0.31, height: 8.2, apex: 0.4, wait: 0 },
    { from: C_TOP, to: D_STEM, touch: false, crouchLen: CROUCH, air: 0.36, height: 9, apex: 0.6, wait: SETTLE + PAUSE },
    { from: D_STEM, to: GROUND, touch: true, crouchLen: 0.2, air: 0.44, height: 8, apex: APEX, wait: 0 },
  ];
  const hops: Hop[] = [];
  let at = 0;
  for (const h of spec) {
    const crouch = at + h.wait;
    const crouchLen = h.crouchLen;
    hops.push({ from: h.from, to: h.to, crouch, crouchLen, touch: h.touch, air: h.air, height: h.height, apex: h.apex });
    at = crouch + crouchLen + h.air;
  }
  return hops;
})();

export function launchOf(hop: Hop): number {
  'worklet';
  return hop.crouch + hop.crouchLen;
}
export function landOf(hop: Hop): number {
  'worklet';
  return hop.crouch + hop.crouchLen + hop.air;
}
/** Whether the hop after this one starts at its landing (a touch), so it has no settle of its own. */
function chained(i: number): boolean {
  'worklet';
  return i + 1 < HOPS.length && HOPS[i + 1].touch;
}

const LAST = HOPS[HOPS.length - 1];
/** Long enough after the last landing for the ripple, the press, the ears' spring and the perch fade. */
const AFTER_LANDING = 1;
export const SHOW_END = LAST.crouch + LAST.crouchLen + LAST.air + AFTER_LANDING;
const BREATH = 2.4;
const BREATHS = 3;
const BREATH_END = SHOW_END + BREATH * BREATHS;
/** Where a tab return starts the clock: a glance and a blink, then the usual rest. */
export const GREET_AT = 1000;
/** Where the greet's glance and blinks are over. */
export const GREET_END = GREET_AT + 1.2;

/** Where the panda turns: +1 to the right, -1 the left. It looks where it will go, and back after. */
const LOOK = [
  [0, 0], [0.7, 0], [0.95, -0.4], [1.0, -0.4], [FIRST_CROUCH - 0.3, -1],
  [landOf(HOPS[1]) + 0.25, -1], [landOf(HOPS[1]) + 0.5, 0], [landOf(HOPS[1]) + 0.75, 0], [landOf(HOPS[1]) + 0.95, 0.4],
  [HOPS[2].crouch - 0.3, 0.4], [HOPS[2].crouch - 0.12, 1], [landOf(LAST) + 0.4, 1], [landOf(LAST) + 0.75, 0],
  [GREET_AT, 0], [GREET_AT + 0.25, -0.45], [GREET_AT + 0.9, -0.45], [GREET_END, 0],
] as const;
/** A small curious tilt on the C. */
const TILT = [[0, 0], [landOf(HOPS[1]) + 0.45, 0], [landOf(HOPS[1]) + 0.6, 6], [landOf(HOPS[1]) + 0.85, 6], [landOf(HOPS[1]) + 1.0, 0]] as const;
/** The one small beat of the pause on the C: an ear flick. */
const FLICK_AT = landOf(HOPS[1]) + 0.55;
const FLICK = 0.6;
/** Blinks: one at first sight, one on the C, one after coming home, and a double for the greet. */
const SHOW_BLINKS = [0.4, landOf(HOPS[1]) + 0.72, landOf(LAST) + SETTLE + 0.5, GREET_AT + 0.4, GREET_AT + 0.62];
const BLINK_HALF = 0.06;
/** Resting blinks every 4-6 s (a fixed jitter, so it is reproducible), every third one doubled. */
const REST_BLINK_START = SHOW_END + 1.5;
const REST_BLINK_GAP = 5;
const DOUBLE = 0.22;

function jitter(k: number): number {
  'worklet';
  const x = Math.sin(k * 12.9898 + 1.3) * 43758.5453;
  return x - Math.floor(x) - 0.5;
}

/** The k-th resting blink. */
export function restBlink(k: number): number {
  'worklet';
  return REST_BLINK_START + REST_BLINK_GAP * k + jitter(k);
}

function blinkAt(t: number): number {
  'worklet';
  let blink = 0;
  for (let i = 0; i < SHOW_BLINKS.length; i++) blink = Math.max(blink, 1 - Math.abs(t - SHOW_BLINKS[i]) / BLINK_HALF);
  if (t >= REST_BLINK_START - 1) {
    const k = Math.round((t - REST_BLINK_START) / REST_BLINK_GAP);
    for (let j = Math.max(0, k - 1); j <= k + 1; j++) {
      const at = restBlink(j);
      blink = Math.max(blink, 1 - Math.abs(t - at) / BLINK_HALF);
      if (j % 3 === 2) blink = Math.max(blink, 1 - Math.abs(t - at - DOUBLE) / BLINK_HALF);
    }
  }
  return Math.max(blink, 0);
}

// Declared before the worklets that read them: a worklet captures its constants when it is defined.
/** A crouch from rest: a quick stretch up, down past the squat, back to it for the launch. */
const CROUCH_SY = [[0, 1], [0.05, 1.04], [0.2, CROUCH_SQUAT - 0.02], [CROUCH, CROUCH_SQUAT]] as const;
/** A touch of `len` seconds: arrives stretched, squashes and springs straight off again. */
function touchSy(s: number, len: number): number {
  'worklet';
  const down = 0.08;
  return s < down ? lerp(1 + STRETCH, CROUCH_SQUAT - 0.02, smooth(s / down)) : lerp(CROUCH_SQUAT - 0.02, CROUCH_SQUAT, smooth((s - down) / (len - down)));
}
const TRICK_CROUCH_SY = [[0, 1], [0.03, 1.03], [0.12, CROUCH_SQUAT - 0.02], [TRICK_CROUCH, CROUCH_SQUAT]] as const;

export interface Pose {
  /** The panda's centre in word coordinates, its feet's height above the baseline, and 0..1 of its arc. */
  x: number; feet: number; lift: number; sy: number;
  /** The perch it is on or last left, and whether its feet are down. */
  perch: number; grounded: boolean;
  /** Degrees about the feet (crouch, landing) and about the centre (pitch in the air, the curious tilt). */
  groundLean: number; pitch: number; tilt: number; look: number;
  /** Each ear's lag in points (positive is down), the right one 40 ms behind; and how far they spread. */
  earsL: number; earsR: number; earsOut: number;
  /** 0 open, 1 closed. */
  blink: number;
  /** Feet drawn up in the air; the whole panda dipping past the letter on landing; the head nodding. */
  tuck: number; bob: number; nod: number;
  /** Arms: raised and splayed with the lift (0..1), braced on contact (0..1). */
  arms: number; brace: number;
  /** A resting breath, 0..1. */
  breath: number;
}

/** Ears for a phase whose crouch started `s` seconds ago, leaving the ground `crouch` in and landing `down` in. */
function earsAt(s: number, crouch: number, down: number, perks: boolean): number {
  'worklet';
  return (perks ? -PERK_UP * perk(s, crouch) : 0) + earSpring(s - crouch) + earSpring(s - down);
}

export function pose(t: number, px: readonly number[], ph: readonly number[]): Pose {
  'worklet';
  let perch = GROUND;
  let x = px[GROUND];
  let feet = ph[GROUND];
  let lift = 0;
  let sy = 1;
  let grounded = true;
  let groundLean = 0;
  let pitch = 0;
  let earsL = 0;
  let earsR = 0;
  let earsOut = 0;
  let tuck = 0;
  let bob = 0;
  let nod = 0;
  let brace = 0;
  for (let i = 0; i < HOPS.length; i++) {
    const hop = HOPS[i];
    const dir = px[hop.to] > px[hop.from] ? 1 : -1;
    const launch = launchOf(hop);
    const land = landOf(hop);
    if (t >= land) {
      perch = hop.to;
      x = px[hop.to];
      feet = ph[hop.to];
    }
    // Follow-through runs across phases, so it never jumps at a boundary.
    earsL += earsAt(t - hop.crouch, hop.crouchLen, hop.crouchLen + hop.air, !hop.touch);
    earsR += earsAt(t - hop.crouch - EAR_LAG, hop.crouchLen, hop.crouchLen + hop.air, !hop.touch);
    if (!hop.touch) earsOut += PERK_OUT * perk(t - hop.crouch, hop.crouchLen);
    bob += pulse(t - land, 0.22, chained(i) ? TOUCH_BOB : BOB);
    brace += pulse(t - land, BRACE, 1);
    if (!chained(i)) {
      nod += pulse(t - land, 0.24, 0.7);
      groundLean += dir * landingTip(t - land, LANDING_TIP);
    }
    if (t >= hop.crouch && t < launch) {
      const s = t - hop.crouch;
      perch = hop.from;
      x = px[hop.from];
      feet = ph[hop.from];
      sy = hop.touch ? touchSy(s, hop.crouchLen) : keyframes(CROUCH_SY, s);
      if (!hop.touch) groundLean -= CROUCH_LEAN * dir * smooth(s / hop.crouchLen);
    } else if (t >= launch && t < land) {
      const s = t - launch;
      const u = s / hop.air;
      const off = smooth(s / LAUNCH_BLEND);
      const h0 = ph[hop.from];
      const h1 = ph[hop.to];
      perch = hop.from;
      grounded = false;
      x = lerp(px[hop.from], px[hop.to], travel(u));
      lift = arc(u, hop.apex);
      // A line between the perches plus the arc, sized so the top clears the higher one by `height`.
      feet = lerp(h0, h1, u) + (hop.height + Math.abs(h1 - h0) / 2) * lift;
      sy = leaving(s, u, hop.apex);
      tuck = TUCK * lift;
      if (!hop.touch) groundLean -= CROUCH_LEAN * dir * (1 - off);
      const v = climb(u, hop.apex);
      const level = 1 - smooth((u - 0.7) / 0.3);
      // The head leads the travel on the rise and rocks back to land feet first.
      pitch = off * level * dir * (v > 0 ? PITCH_UP : PITCH_DOWN) * v;
    } else if (t >= land && t < land + SETTLE && !chained(i)) {
      sy = landing(t - land);
    }
  }
  earsR += FLICK * earSpring(t - FLICK_AT);
  const breath = t >= SHOW_END && t < BREATH_END ? 0.5 - 0.5 * Math.cos((2 * Math.PI * (t - SHOW_END)) / BREATH) : 0;
  return {
    x, feet, lift, sy, perch, grounded, groundLean, pitch, tilt: keyframes(TILT, t), look: keyframes(LOOK, t),
    earsL, earsR, earsOut, blink: blinkAt(t), tuck, bob, nod, arms: lift, brace, breath,
  };
}

/** The take-off and landing letters' index for each perch, for the press and the colour. */
export const PERCH_LETTER = [8, 7, 5] as const;

/**
 * When the panda passes over (or lands on) each letter: per hop, the letters whose centre lies in its
 * span, at the moment the eased travel reaches them. Runs once per layout. `centres` in word coordinates.
 */
export function passTimes(centres: readonly number[], px: readonly number[]): number[][] {
  const reach = (x: number) => {
    let lo = 0;
    let hi = 1;
    for (let i = 0; i < 24; i++) {
      const mid = (lo + hi) / 2;
      if (travel(mid) < x) lo = mid;
      else hi = mid;
    }
    return (lo + hi) / 2;
  };
  return centres.map((c, letterIndex) => {
    const times: number[] = [];
    for (const hop of HOPS) {
      const x0 = px[hop.from];
      const x1 = px[hop.to];
      const f = (c - x0) / (x1 - x0);
      // The take-off letter is already lit by its perch; passing over it again would drain and refill it.
      if (PERCH_LETTER[hop.from] === letterIndex) continue;
      if (f > 0 && f < 1) times.push(launchOf(hop) + hop.air * reach(f));
      else if (PERCH_LETTER[hop.to] === letterIndex) times.push(landOf(hop));
    }
    return times;
  });
}

const FILL = 0.06;
const HOLD = 0.08;
const DRAIN = 0.09;
export const LIT = FILL + HOLD + DRAIN;

/**
 * A letter `since` seconds after the panda passed (or landed on it): `dip` presses down then
 * rebounds; `glow` fills quickly, holds a beat and drains fast (easing in), so it never lingers half full.
 */
export function answer(since: number): { dip: number; glow: number } {
  'worklet';
  if (since < 0 || since > 2) return { dip: 0, glow: 0 };
  const dip = Math.exp(-7 * since) * Math.sin((2 * Math.PI * since) / 0.36);
  const drain = (since - FILL - HOLD) / DRAIN;
  const glow = since < FILL ? smooth(since / FILL) : drain <= 0 ? 1 : drain >= 1 ? 0 : 1 - drain * drain;
  return { dip, glow };
}

export function letter(t: number, passes: readonly number[]): { dip: number; glow: number } {
  'worklet';
  let since = Infinity;
  for (let i = 0; i < passes.length; i++) if (t >= passes[i]) since = Math.min(since, t - passes[i]);
  return answer(since);
}

const PERCH_FADE = 0.25;
const MIN_STAY = 0.3;

/**
 * How much a perch's accent letter holds its colour: while the panda is at that perch, fading in after
 * the landing and out just after it leaves. At rest that is the e beside it: the logo is always the same.
 */
export function perchGlow(t: number, perch: number): number {
  'worklet';
  let on = 0;
  let start = -Infinity;
  let at = GROUND;
  for (let i = 0; i <= HOPS.length; i++) {
    const end = i < HOPS.length ? launchOf(HOPS[i]) + PERCH_FADE : Infinity;
    // A touch is too short to hold a colour: its landing flash is the accent.
    const stay = i < HOPS.length ? launchOf(HOPS[i]) - start : Infinity;
    if (at === perch && stay > MIN_STAY && t >= start && t <= end) {
      const fadeIn = start === -Infinity ? 1 : smooth((t - start) / PERCH_FADE);
      const fadeOut = end === Infinity ? 1 : smooth((end - t) / PERCH_FADE);
      on = Math.max(on, Math.min(fadeIn, fadeOut));
    }
    if (i < HOPS.length) {
      start = landOf(HOPS[i]);
      at = HOPS[i].to;
    }
  }
  return on;
}

/** Whether a tap trick started at `t` is allowed: at rest, before or after the trip, never during it. */
export function canTrick(t: number): boolean {
  'worklet';
  return !(t > HOPS[0].crouch - TRICK_S - 0.1 && t < landOf(LAST) + SETTLE);
}

export interface Trick {
  lift: number; spin: number; sy: number; tuck: number; drift: number;
  earsL: number; earsR: number; earsOut: number; bob: number; nod: number; arms: number; brace: number;
}

/** The tap trick `s` seconds in: crouch, a tucked back somersault in place, a weighted landing. */
export function trick(s: number): Trick {
  'worklet';
  const earsL = earsAt(s, TRICK_CROUCH, TRICK_LAND, true);
  const earsR = earsAt(s - EAR_LAG, TRICK_CROUCH, TRICK_LAND, true);
  const earsOut = PERK_OUT * perk(s, TRICK_CROUCH);
  const bob = pulse(s - TRICK_LAND, 0.22, BOB);
  const nod = pulse(s - TRICK_LAND, 0.24, 0.7);
  const brace = pulse(s - TRICK_LAND, BRACE, 1);
  if (s <= 0 || s >= TRICK_S) return { lift: 0, spin: 0, sy: 1, tuck: 0, drift: 0, earsL, earsR, earsOut, bob, nod, arms: 0, brace };
  if (s < TRICK_CROUCH) return { lift: 0, spin: 0, sy: keyframes(TRICK_CROUCH_SY, s), tuck: 0, drift: 0, earsL, earsR, earsOut, bob, nod, arms: 0, brace };
  if (s < TRICK_LAND) {
    const a = (s - TRICK_CROUCH) / TRICK_AIR;
    const lift = arc(a, APEX);
    return {
      lift, spin: -360 * smooth((a - 0.12) / 0.76), sy: leaving(s - TRICK_CROUCH, a, APEX), tuck: TRICK_TUCK * lift,
      drift: TRICK_DRIFT * Math.sin(Math.PI * a), earsL, earsR, earsOut, bob, nod, arms: lift, brace,
    };
  }
  return { lift: 0, spin: 0, sy: landing(s - TRICK_LAND), tuck: 0, drift: 0, earsL, earsR, earsOut, bob, nod, arms: 0, brace };
}

// The moments anything moves. Outside them the pose, the letters and the perch colours are constant,
// so the clock may stop until the next one. Each window is padded by a frame.
const PAD = 1 / 30;
function changes(points: readonly (readonly [number, number])[]): number[][] {
  const spans: number[][] = [];
  for (let i = 1; i < points.length; i++) if (points[i][1] !== points[i - 1][1]) spans.push([points[i - 1][0], points[i][0]]);
  return spans;
}
const WINDOWS: readonly (readonly number[])[] = [
  [HOPS[0].crouch, landOf(LAST) + AFTER_LANDING],
  ...SHOW_BLINKS.map(at => [at - BLINK_HALF, at + BLINK_HALF]),
  ...changes(LOOK),
  ...changes(TILT),
  [SHOW_END, BREATH_END],
].map(([a, b]) => [a - PAD, b + PAD]).sort((a, b) => a[0] - b[0]);
const BLINK_WINDOW = BLINK_HALF + PAD;

export function moving(t: number): boolean {
  'worklet';
  for (let i = 0; i < WINDOWS.length; i++) if (t >= WINDOWS[i][0] && t <= WINDOWS[i][1]) return true;
  if (t < REST_BLINK_START - 1) return false;
  const k = Math.round((t - REST_BLINK_START) / REST_BLINK_GAP);
  for (let j = Math.max(0, k - 1); j <= k + 1; j++) {
    const at = restBlink(j);
    if (Math.abs(t - at) <= BLINK_WINDOW) return true;
    if (j % 3 === 2 && Math.abs(t - at - DOUBLE) <= BLINK_WINDOW) return true;
  }
  return false;
}

/** Wake a hair inside a window (still in its padding), so a float at its edge never reads as still. */
const INSIDE = 1e-3;

/** The next moment after `t` when something starts to move: when a sleeping clock should wake. */
export function nextWake(t: number): number {
  'worklet';
  let best = Infinity;
  for (let i = 0; i < WINDOWS.length; i++) {
    if (WINDOWS[i][0] > t) {
      best = WINDOWS[i][0] + INSIDE;
      break;
    }
  }
  let k = Math.max(0, Math.floor((t - REST_BLINK_START) / REST_BLINK_GAP) - 1);
  for (;; k++) {
    const at = restBlink(k) - BLINK_WINDOW;
    if (at > t) return Math.min(best, at + INSIDE);
    if (k % 3 === 2 && at + DOUBLE > t) return Math.min(best, at + DOUBLE + INSIDE);
  }
}

/**
 * One frame of the clock: `clock` always advances; `shown`, which the views read, only follows it
 * while something moves. Returns whether the clock may now sleep (nothing moves at either).
 */
export function tick(clock: number, shown: number, dt: number): readonly [number, number, boolean] {
  'worklet';
  const t = clock + dt;
  const move = moving(t) || moving(shown);
  return [t, move ? t : shown, !moving(t) && !moving(move ? t : shown)];
}
