// The phone's colour tokens, measured from the desktop (src/design-system.css). The only place with
// literal colours apart from project tiles: no React Native imports, so tests can check contrast.
// `useColors()` (theme.ts) picks a table by scheme and Increase Contrast.

export type Scheme = 'light' | 'dark';
export type StatusTone = 'success' | 'danger' | 'info' | 'running' | 'warning';
export type StateTone = 'plan' | 'edit' | 'full' | 'team' | 'saver' | 'remote' | 'worktree';
export type Tone = StatusTone | StateTone;

/** Flat, so every value is a colour: read `colors[tone]` and its soft chip fill `colors[`${tone}Fill`]`. */
export interface Palette extends Record<Tone, string>, Record<`${Tone}Fill`, string> {
  // Surfaces: page > card > cardInner, raised controls, recessed tracks.
  page: string; card: string; cardInner: string; raised: string; thumb: string; track: string; fill: string; bubble: string;
  border: string; borderStrong: string; borderInner: string; chipBorder: string; glyphFaint: string;
  /** React Native `boxShadow` strings; undefined with Increase Contrast, as on the desktop. */
  shadowCard: string | undefined; shadowRaised: string | undefined;
  text: string; muted: string; faint: string;
  /** The monochrome primary button, as in "Squash and merge". */
  primary: string; onPrimary: string;
  toggleOn: string; toggleKnob: string; toggleOff: string; toggleKnobOff: string;
  // Names from before the redesign; unconverted screens read these.
  background: string; grouped: string; separator: string; secondary: string; tertiary: string;
  tint: string; onTint: string; tintFill: string; green: string; orange: string; red: string;
}

const channel = (hex: string, at: number) => parseInt(hex.slice(at, at + 2), 16);
const rgb = (hex: string) => [channel(hex, 1), channel(hex, 3), channel(hex, 5)];

/** `amount` of `top` over `base`, as CSS color-mix in srgb. Takes and returns #rrggbb. */
export function mix(top: string, amount: number, base: string): string {
  const under = rgb(base);
  const parts = rgb(top).map((value, i) => Math.round(value * amount + under[i] * (1 - amount)));
  return `#${parts.map(part => part.toString(16).padStart(2, '0')).join('')}`;
}

export function alpha(hex: string, opacity: number): string {
  return `rgba(${rgb(hex).join(', ')}, ${opacity})`;
}

const EASE_STEPS = 8;

/** A smoothstep ramp as CSS stops: a straight ramp shows a line where it meets the solid part. */
export function edgeGradient(direction: 'to bottom' | 'to top', color: string, opacity: number, solidTo: number): string {
  const stops = Array.from({ length: EASE_STEPS + 1 }, (_, i) => {
    const t = i / EASE_STEPS;
    const eased = t * t * (3 - 2 * t);
    return `${alpha(color, Number((opacity * (1 - eased)).toFixed(3)))} ${(solidTo + (1 - solidTo) * t) * 100}%`;
  });
  return `linear-gradient(${direction}, ${stops.join(', ')})`;
}

/** How far a scroll edge has arrived: 0 at rest, 1 once content is this far under the bar. */
export const EDGE_RAMP = 12;
export function edgeProgress(under: number): number {
  'worklet';
  return Math.min(Math.max(under / EDGE_RAMP, 0), 1);
}

/** WCAG contrast ratio between two #rrggbb colours. */
export function contrast(a: string, b: string): number {
  const luminance = (hex: string) => {
    const [r, g, b2] = rgb(hex).map(value => {
      const c = value / 255;
      return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * b2;
  };
  const [hi, lo] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
}

const WHITE = '#ffffff';
const BLACK = '#000000';
const DARK = { page: '#151515', text: '#e2e2e2', muted: '#959595', faint: '#8a8a8a' };
const LIGHT = { page: WHITE, text: '#242423', muted: '#5a5a55', faint: '#5f5f5a' };

const STATE_HUES: Record<Scheme, Record<StateTone, string>> = {
  dark: { plan: '#85aeff', edit: '#2fcfb4', full: '#f5a524', team: '#b897fb', saver: '#5ccc6c', remote: '#45bff0', worktree: '#f27fb2' },
  light: { plan: '#1c52ad', edit: '#075f55', full: '#874300', team: '#5f35b3', saver: '#17652f', remote: '#08587b', worktree: '#9c2260' },
};
const STATUS: Record<Scheme, Record<StatusTone, string>> = {
  dark: { success: '#3fba50', danger: '#fa524a', info: '#15a0ec', running: '#09bf81', warning: '#e3b24f' },
  light: {
    success: mix('#237345', 0.85, LIGHT.text), danger: mix('#b03535', 0.9, LIGHT.text), info: mix('#15a0ec', 0.6, LIGHT.text),
    running: mix('#09bf81', 0.5, LIGHT.text), warning: '#855700',
  },
};
/** iOS systemBlue, for links and native selection only. Colour otherwise means state. */
const TINT: Record<Scheme, { normal: string; contrast: string }> = { dark: { normal: '#0a84ff', contrast: '#409cff' }, light: { normal: '#007aff', contrast: '#0040dd' } };

function toneTable(scheme: Scheme, status: Record<StatusTone, string>, increase: boolean) {
  const towards = scheme === 'dark' ? DARK.text : LIGHT.text;
  const hues = STATE_HUES[scheme];
  const state = Object.fromEntries(Object.entries(hues).map(([name, hue]) => [name, increase ? mix(hue, 0.5, towards) : hue])) as Record<StateTone, string>;
  const tones: Record<Tone, string> = { ...status, ...state };
  const amount = scheme === 'dark' ? 0.14 : 0.1;
  const fills = Object.fromEntries(Object.entries(tones).map(([name, hue]) => [`${name}Fill`, alpha(hue, amount)])) as Record<`${Tone}Fill`, string>;
  return { ...tones, ...fills };
}

function build(scheme: Scheme, increase: boolean): Palette {
  const dark = scheme === 'dark';
  const { page, text, muted, faint } = dark ? DARK : LIGHT;
  const status = STATUS[scheme];
  const card = mix(text, dark ? 0.02 : 0.03, page);
  const cardInner = dark ? mix(text, 0.025, card) : page;
  const raised = dark ? mix(text, 0.042, cardInner) : page;
  const tint = TINT[scheme][increase ? 'contrast' : 'normal'];
  const base: Palette = {
    page, card, cardInner, raised, thumb: raised,
    track: dark ? mix(BLACK, 0.1, card) : mix(text, 0.03, page),
    fill: alpha(text, dark ? 0.055 : 0.05),
    bubble: mix(text, dark ? 0.07 : 0.05, page),
    border: alpha(text, dark ? 0.07 : 0.09), borderStrong: alpha(text, dark ? 0.16 : 0.14),
    borderInner: alpha(text, dark ? 0.01 : 0.09), chipBorder: alpha(text, 0.04),
    glyphFaint: mix(text, dark ? 0.34 : 0.4, page),
    shadowCard: dark ? '0 1px 2px rgba(0, 0, 0, 0.3), 0 2px 6px rgba(0, 0, 0, 0.25)' : '0 1px 2px rgba(0, 0, 0, 0.04), 0 2px 8px rgba(0, 0, 0, 0.04)',
    shadowRaised: dark ? '0 1px 2px rgba(0, 0, 0, 0.45), 0 1px 1px rgba(0, 0, 0, 0.25)' : '0 1px 2px rgba(0, 0, 0, 0.08), 0 1px 1px rgba(0, 0, 0, 0.04)',
    text, muted, faint,
    primary: dark ? mix(text, 0.6, WHITE) : text, onPrimary: page,
    // As the desktop: ON is the primary pair (near-text track, page-toned knob).
    toggleOn: dark ? mix(text, 0.6, WHITE) : text, toggleKnob: page,
    toggleOff: dark ? mix(BLACK, 0.5, card) : mix(text, 0.22, page), toggleKnobOff: dark ? muted : page,
    ...toneTable(scheme, status, increase),
    background: page, grouped: page, separator: '', secondary: muted, tertiary: faint,
    tint, onTint: WHITE, tintFill: alpha(tint, 0.22), green: status.success, orange: status.warning, red: status.danger,
  };
  const palette = increase ? { ...base, ...increasedContrast(scheme) } : base;
  return { ...palette, secondary: palette.muted, tertiary: palette.faint, separator: palette.border };
}

/** As the desktop's prefers-contrast: solid hairlines, stronger text and glyphs, no shadows. */
function increasedContrast(scheme: Scheme): Partial<Palette> {
  const dark = scheme === 'dark';
  const text = dark ? '#f5f5f5' : '#000000';
  const border = dark ? '#7a7a7a' : '#85857c';
  return {
    text, muted: dark ? '#c8c8c8' : '#454540', faint: dark ? '#bcbcbc' : '#50504a',
    border, borderInner: border, chipBorder: border, borderStrong: text, glyphFaint: text,
    primary: text, toggleOn: text, toggleKnobOff: text,
    shadowCard: undefined, shadowRaised: undefined,
  };
}

const TABLES: Record<Scheme, Record<'normal' | 'increased', Palette>> = {
  light: { normal: build('light', false), increased: build('light', true) },
  dark: { normal: build('dark', false), increased: build('dark', true) },
};

export const paletteFor = (scheme: Scheme, increase: boolean): Palette => TABLES[scheme][increase ? 'increased' : 'normal'];

/** Full-screen image viewers: black in every scheme (photos read truest on black), white text, and a
 * dimmed chrome bar the image can show through. Scheme-independent, so not part of the Palette. */
export const VIEWER = { page: BLACK, text: WHITE, chrome: alpha(BLACK, 0.55) } as const;
