// The brand panda's motion curves: pure worklets of a phase's local time, shared by the show's
// crossings and the tap trick. No React Native imports. Every curve is continuous at its ends.
// Worklets compile to consts, so each helper is declared before its first use.

/** Squash at the bottom of a crouch (ears perk up, so they stay clear of the head) and on a landing. */
export const CROUCH_SQUAT = 0.84;
export const LAND_SQUAT = 0.87;
/** Stretch along the velocity: most at launch and contact, none at the apex. */
export const STRETCH = 0.12;
export const LAUNCH_BLEND = 0.09;
export const LAND_BLEND = 0.07;
const REBOUND_TAIL = 0.45;
export const SETTLE = LAND_BLEND + REBOUND_TAIL;
/**
 * The usual apex: a little early (a fast rise, a slower fall) with only a brief hang, a peaked hop.
 * Passed explicitly: a worklet does not capture constants named in default parameters.
 */
export const APEX = 0.45;
const HANG = 0.05;
/** The ears let go of their perk over this long after the launch, under the spring's lag. */
const PERK_RELEASE = 0.15;
/** The ears' spring: one ~280 ms cycle whose overshoot is a quarter of the lag. */
const EAR_PERIOD = 0.28;
const EAR_DECAY = EAR_PERIOD / 2 / Math.log(4);

export function smooth(u: number): number {
  'worklet';
  const c = Math.min(Math.max(u, 0), 1);
  return c * c * (3 - 2 * c);
}

export function lerp(a: number, b: number, u: number): number {
  'worklet';
  return a + (b - a) * u;
}

/** [time, value] pairs eased with smoothstep between them; holds the ends. */
export function keyframes(points: readonly (readonly [number, number])[], t: number): number {
  'worklet';
  if (t <= points[0][0]) return points[0][1];
  for (let i = 1; i < points.length; i++) {
    const [t1, v1] = points[i];
    if (t <= t1) {
      const [t0, v0] = points[i - 1];
      return v0 + (v1 - v0) * smooth((t - t0) / (t1 - t0));
    }
  }
  return points[points.length - 1][1];
}

/** Height (0..1) at air progress `u`: an ease-out rise, a brief hang at the top, an ease-in fall. */
export function arc(u: number, apex: number): number {
  'worklet';
  const rise = apex - HANG / 2;
  const fall = apex + HANG / 2;
  if (u <= 0 || u >= 1) return 0;
  if (u < rise) return 1 - (1 - u / rise) ** 2;
  if (u <= fall) return 1;
  return 1 - ((u - fall) / (1 - fall)) ** 2;
}

/** Vertical speed at air progress `u`, normalised: +1 leaving the ground, 0 at the top, -1 arriving. */
export function climb(u: number, apex: number): number {
  'worklet';
  const rise = apex - HANG / 2;
  const fall = apex + HANG / 2;
  if (u < rise) return 1 - u / rise;
  if (u <= fall) return 0;
  return -(u - fall) / (1 - fall);
}

/** Horizontal progress through a hop: eased at take-off and landing, so the last stretch slows into the contact. */
export function travel(u: number): number {
  'worklet';
  return lerp(u, smooth(u), 0.4);
}

/** Stretch along the velocity at air progress `u`. */
export function airStretch(u: number, apex: number): number {
  'worklet';
  return 1 + STRETCH * Math.abs(climb(u, apex));
}

/** Vertical scale `s` seconds after leaving the ground: the crouch's squash blends into the stretch. */
export function leaving(s: number, u: number, apex: number): number {
  'worklet';
  return lerp(CROUCH_SQUAT, airStretch(u, apex), smooth(s / LAUNCH_BLEND));
}

/**
 * Vertical scale `v` seconds after contact: into a light squash, then a damped rebound with weight
 * (one ~7% overshoot near 140 ms, ~3% back near 290 ms) that ends exactly at 1.
 */
export function landing(v: number): number {
  'worklet';
  if (v < LAND_BLEND) return lerp(1 + STRETCH, LAND_SQUAT, smooth(v / LAND_BLEND));
  const w = v - LAND_BLEND;
  const rebound = (1 - LAND_SQUAT) * Math.exp(-4.5 * w) * Math.cos(2 * Math.PI * 3.5 * w);
  return 1 - rebound * (1 - smooth((w - 0.35) / (REBOUND_TAIL - 0.35)));
}

/** An ear's spring after a jolt `s` seconds ago: ~3 pt of lag, one ~25% overshoot, still by ~0.45 s. */
export function earSpring(s: number): number {
  'worklet';
  if (s <= 0) return 0;
  // A soft onset, so the ear eases into its lag instead of snapping in a frame.
  return 5.55 * smooth(s / 0.06) * Math.exp(-s / EAR_DECAY) * Math.sin((2 * Math.PI * s) / EAR_PERIOD);
}

/** A quick there-and-back of `amount` over `length` seconds. */
export function pulse(s: number, length: number, amount: number): number {
  'worklet';
  return s <= 0 || s >= length ? 0 : amount * Math.sin(Math.PI * smooth(s / length));
}

/** The ears perk (up, negative) and spread through a crouch of `crouch` seconds, and let go at the launch. */
export function perk(s: number, crouch: number): number {
  'worklet';
  if (s < 0) return 0;
  if (s < crouch) return smooth(s / crouch);
  return 1 - smooth((s - crouch) / PERK_RELEASE);
}

/**
 * The tipping forward over planted feet after a landing `v` seconds ago, in degrees: 0 at contact
 * (so the feet don't slide when the pivot moves to them), a few degrees, and back.
 */
export function landingTip(v: number, amount: number): number {
  'worklet';
  return pulse(v, 0.3, amount);
}
