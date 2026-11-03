/** Time-of-day math for the thread's sky (src/sky-window.ts). Pure, so `tests/sky.test.mjs` can import it. */
export type Rgb = readonly [number, number, number];
export interface SkyColors {
  top: Rgb; mid: Rgb; horizon: Rgb;
  /** Sun (or moon) glow tint. */
  glow: Rgb;
  /** Cloud tops (lit) and bellies (shaded). */
  light: Rgb; shade: Rgb;
  /** 0 by day, 1 at full night: stars and the moon. */
  night: number;
}
export interface Body { x: number; y: number; elevation: number; visible: boolean }

export const SUNRISE = 6 * 60, SUNSET = 18 * 60 + 30;
const DAY = 24 * 60;
/** Bodies ride the open middle of the pane: from just above the composer (LOW) to just below where the first message card sits (HIGH), so the disc stays in sight beside the thread at common sizes. */
const LOW = .3, HIGH = .44;

const hex = (value: string): Rgb => [1, 3, 5].map(i => parseInt(value.slice(i, i + 2), 16) / 255) as unknown as Rgb;
/** Keyframes by minute of the day; colours interpolate between neighbours and wrap at midnight. */
const KEYS: { at: number; c: SkyColors }[] = [
  // Cloud lit/shade pairs keep a wide gap at dawn and dusk (warm gold or pink against cool violet-grey), so the
  // clouds keep their form instead of posterizing; noon is white tops over blue-grey bellies; night is moonlit.
  [0, '#060a1a', '#0c1430', '#1a2244', '#8090c0', '#7480a8', '#161c30', 1],
  [4.8, '#070b1d', '#0f1834', '#1e2a4e', '#8090c0', '#7480a8', '#161c30', 1],
  [5.6, '#18204a', '#3a3f74', '#b0708a', '#ffb080', '#e8a0a8', '#3a3a62', .55],
  [6.3, '#3d64a8', '#8aa0d0', '#ffb88a', '#ffc890', '#ffd6a8', '#6a6a94', .1],
  [7.5, '#3f86d8', '#82b6ea', '#d8e8f2', '#fff0d0', '#fffaf0', '#8a98b6', 0],
  [12, '#2f7fe0', '#6fb0f0', '#cfe6f8', '#fffbe8', '#ffffff', '#8c9cb8', 0],
  [16.5, '#3a82d8', '#7cb2ea', '#dde8ef', '#fff0d0', '#fffaf0', '#8c96b2', 0],
  [17.7, '#4a74c0', '#b0a8c8', '#ffc890', '#ffb060', '#ffdca0', '#7a76a0', 0],
  [18.5, '#2c3c7c', '#8a5a8a', '#ff8a5a', '#ff8048', '#ffb878', '#4e4676', .15],
  [19.3, '#141c48', '#3a2c5c', '#a04c5a', '#ff7050', '#f08c8c', '#242044', .6],
  [20.5, '#080d22', '#101838', '#222a50', '#8090c0', '#7480a8', '#161c30', 1],
].map(([h, top, mid, horizon, glow, light, shade, night]) => ({
  at: (h as number) * 60,
  c: { top: hex(top as string), mid: hex(mid as string), horizon: hex(horizon as string), glow: hex(glow as string), light: hex(light as string), shade: hex(shade as string), night: night as number },
}));

const mix = (a: Rgb, b: Rgb, t: number): Rgb => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
const ease = (t: number): number => t * t * (3 - 2 * t);
const wrap = (minutes: number): number => ((minutes % DAY) + DAY) % DAY;

export function skyColorsAt(minutes: number): SkyColors {
  const m = wrap(minutes);
  let i = KEYS.length - 1;
  while (i > 0 && KEYS[i].at > m) i--;
  const a = KEYS[i], b = KEYS[(i + 1) % KEYS.length];
  const span = wrap(b.at - a.at) || DAY, t = ease(wrap(m - a.at) / span);
  return {
    top: mix(a.c.top, b.c.top, t), mid: mix(a.c.mid, b.c.mid, t), horizon: mix(a.c.horizon, b.c.horizon, t),
    glow: mix(a.c.glow, b.c.glow, t), light: mix(a.c.light, b.c.light, t), shade: mix(a.c.shade, b.c.shade, t),
    night: a.c.night + (b.c.night - a.c.night) * t,
  };
}

/** The sun's arc: x 0.08–0.92 across the day, y from 0.3 at sunrise to 0.44 at solar noon (rising fast, then flat), in a y-up unit square. */
export function sunPosition(minutes: number): Body {
  const m = wrap(minutes), progress = (m - SUNRISE) / (SUNSET - SUNRISE);
  const elevation = Math.sin(Math.PI * progress);
  return { x: .08 + .84 * progress, y: LOW + (HIGH - LOW) * Math.max(0, elevation) ** .7, elevation, visible: progress > -.04 && progress < 1.04 };
}
/** The moon crosses the night the same way, rising at sunset. */
export function moonPosition(minutes: number): Body {
  const night = DAY - (SUNSET - SUNRISE), progress = wrap(minutes - SUNSET) / night;
  const elevation = Math.sin(Math.PI * progress);
  return { x: .1 + .8 * progress, y: LOW + (HIGH - .06 - LOW) * Math.max(0, elevation) ** .7, elevation, visible: progress < 1.02 };
}

export const minutesOf = (date: Date): number => date.getHours() * 60 + date.getMinutes() + date.getSeconds() / 60;
/** `?sky=06:30` (preview only) pins the clock; anything malformed is ignored. */
export function parseSkyTime(value: string | null): number | null {
  const match = value?.match(/^(\d{1,2}):(\d{2})$/);
  if (!match) return null;
  const hours = Number(match[1]), minutes = Number(match[2]);
  return hours < 24 && minutes < 60 ? hours * 60 + minutes : null;
}
const linear = (c: number): number => c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4;
export const luminance = (c: Rgb): number => .2126 * linear(c[0]) + .7152 * linear(c[1]) + .0722 * linear(c[2]);
/** Theme grade, as the shader does it, hue-preserving: light maps Y affinely onto [floor, 1] (floor 0.46 by day, 0.44 at
 * full night: a pale moonlit periwinkle, night by its hue, stars and moon), dark compresses Y onto [0, 0.06] and pulls
 * daytime toward a saturated dusk blue; in dark the sun, moon and stars are held to the ceiling too. Thread text sits on
 * the bare sky, so these bounds are what keep it readable: dark ink on Y >= the floor, light ink on Y <= the ceiling
 * (tests/sky.spec.ts measures the worst pixel). */
export const LIGHT_FLOOR = .46, LIGHT_NIGHT_FLOOR = .44, DARK_CEILING = .06;
/** The light floor for a night factor (0 day, 1 night). */
export const lightFloor = (night: number): number => LIGHT_FLOOR + (LIGHT_NIGHT_FLOOR - LIGHT_FLOOR) * night;
