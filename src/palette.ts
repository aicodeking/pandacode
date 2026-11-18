import './palette.css';
import { parseHex, toOklch } from './color';
import { accentTokens, statusClearOf, TONE_TOKENS, vsixTokens, type Tokens, type VsixTheme } from './palette-core';
import { wallpaperAccents } from './wallpaper-accents';
export type { VsixTheme } from './palette-core';

/* The app's colors: PandaCode's own palette with an accent that is classic yellow,
 * a fixed color, or drawn from the current wallpaper — or, when a VS Code theme is
 * active, that theme's colors, which then stay put whatever the wallpaper does. */

export type AccentChoice = { mode: 'wallpaper' } | { mode: 'classic' } | { mode: 'custom'; color: string };
type Saved = { accent: AccentChoice; vsix: VsixTheme | null; cache: { key: string; tokens: Tokens; terminal: Record<string, string> } | null };

const STORE = 'pandacode.palette';
export const CLASSIC = '#ffd43b';
export const SWATCHES = ['#4f8ef7', '#34c084', '#a86cf0', '#f0679b', '#ff8a3d', '#2fb8c4'];
const TOKEN_NAMES = ['--bg', '--sidebar', '--panel', '--raised', '--border', '--text', '--muted', '--faint', '--success', '--danger',
  '--accent', '--accent-rgb', '--accent-dim', '--accent-ink', '--focus', '--on-accent', '--accent-hover', '--accent-deep-rgb', '--accent-tint', '--accent-tint-strong', '--warning', '--info', ...TONE_TOKENS];
const root = document.documentElement;

function read(): Saved {
  try {
    const saved = JSON.parse(localStorage.getItem(STORE) ?? 'null') as Partial<Saved> | null;
    const accent = saved?.accent;
    const valid = accent && (accent.mode === 'wallpaper' || accent.mode === 'classic' || (accent.mode === 'custom' && parseHex(accent.color)));
    return { accent: valid ? accent : { mode: 'wallpaper' }, vsix: saved?.vsix ?? null, cache: saved?.cache ?? null };
  } catch { return { accent: { mode: 'wallpaper' }, vsix: null, cache: null }; }
}
let state = read();
let wallpaperId: string | undefined;
/** The scene id while the thread shows the sky (Wallpapers off): the accent is the daytime sky's calm zenith blue
 * (between the 7:30 and noon tops in sky-math.ts), since there is no wallpaper to take it from. */
export const SKY_SCENE = 'sky';
const SKY_ACCENT = '#3a80dc';
let wallpaperColor: string | undefined;
const theme = () => (root.dataset.theme === 'light' ? 'light' : 'dark') as 'light' | 'dark';

function persist(): void {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* This launch keeps the palette. */ }
}
/* Startup gate (design-system.css): transitions stay off until html[data-ready], set two frames after
 * the last palette write of the startup burst, so first-paint colours never fade in. */
let readyFrame = 0;
function markReady(): void {
  if (root.hasAttribute('data-ready') || typeof requestAnimationFrame !== 'function') return;
  cancelAnimationFrame(readyFrame);
  readyFrame = requestAnimationFrame(() => { readyFrame = requestAnimationFrame(() => root.setAttribute('data-ready', '')); });
}
function write(tokens: Tokens): void {
  markReady();
  for (const name of TOKEN_NAMES) {
    if (name in tokens) root.style.setProperty(name, tokens[name]); else root.style.removeProperty(name);
  }
}
let terminalOverrides: Record<string, string> = {};
/** Terminal colors that follow the palette: accent cursor and selection, or the VS Code theme's. */
export function paletteTerminal(): Record<string, string> { return terminalOverrides; }

function compute(): { key: string; tokens: Tokens; terminal: Record<string, string> } {
  const mode = theme();
  if (state.vsix) {
    const { tokens, terminal } = vsixTokens(state.vsix);
    return { key: `vsix:${state.vsix.id}`, tokens, terminal };
  }
  const color = state.accent.mode === 'custom' ? state.accent.color : state.accent.mode === 'wallpaper' ? wallpaperColor : undefined;
  const source = color && parseHex(color)?.rgb;
  if (!source) return { key: `classic:${mode}`, tokens: statusClearOf(toOklch(parseHex(CLASSIC)!.rgb).h, mode), terminal: {} };
  const tokens = accentTokens(source, mode);
  return { key: `${color}:${mode}`, tokens, terminal: { cursor: tokens['--focus'], selectionBackground: tokens['--accent'] + '40' } };
}
/** Apply the palette now; announces a change only when the colors actually moved. */
function apply(): void {
  const next = compute();
  if (state.vsix) root.dataset.theme = state.vsix.kind;
  root.toggleAttribute('data-vsix', Boolean(state.vsix));
  write(next.tokens);
  terminalOverrides = next.terminal;
  const changed = state.cache?.key !== next.key;
  state = { ...state, cache: next };
  persist();
  if (changed) window.dispatchEvent(new CustomEvent('pandacode-palette-change'));
}

export const palette = {
  get accent(): AccentChoice { return state.accent; },
  get vsix(): VsixTheme | null { return state.vsix; },
  get wallpaperColor(): string | undefined { return wallpaperColor; },
  /** The scene is the sky (Wallpapers off): the scene accent is called Sky. */
  get sky(): boolean { return wallpaperId === SKY_SCENE; },
  /** What the wallpaper accent looks like on screen, after tuning for the current base. */
  get wallpaperAccent(): string | undefined { const source = wallpaperColor && parseHex(wallpaperColor)?.rgb; return source ? accentTokens(source, theme())['--accent'] : undefined; },
  setAccent(accent: AccentChoice): void { state = { ...state, accent }; apply(); },
  setVsix(themeData: VsixTheme | null): void {
    const leaving = state.vsix && !themeData;
    state = { ...state, vsix: themeData };
    apply();
    if (leaving) { let saved = 'dark'; try { saved = localStorage.getItem('pandacode.theme') === 'light' ? 'light' : 'dark'; } catch { /* Default palette. */ } root.dataset.theme = saved; apply(); }
    window.dispatchEvent(new Event('pandacode-theme-change'));
  },
  /** The wallpaper changed: its accent applies, unless a VS Code theme holds the colors. */
  setWallpaper(id: string | undefined): void {
    if (id === wallpaperId) return;
    const wasSky = wallpaperId === SKY_SCENE;
    wallpaperId = id;
    wallpaperColor = id === SKY_SCENE ? SKY_ACCENT : id ? wallpaperAccents[id] : undefined;
    if (!state.vsix && state.accent.mode === 'wallpaper') apply();
    // Sky and wallpaper name the theme and accent rows differently, so Settings redraws them even when no colour moved.
    else if (wasSky !== (id === SKY_SCENE)) window.dispatchEvent(new CustomEvent('pandacode-palette-change'));
  },
  /** Light or dark changed: shades are re-derived for the new base. */
  refresh(): void { apply(); },
};

/** Re-read the saved palette and apply its cached colors without recomputing; the launcher calls this when the main window changes them. */
export function restorePalette(): void {
  state = read();
  // An imported theme's colours come from the saved theme itself, so a derivation that changed reaches a palette saved before it.
  if (state.vsix) state = { ...state, cache: { key: `vsix:${state.vsix.id}`, ...vsixTokens(state.vsix) } };
  // Nothing saved yet, classic yellow or a fixed colour (a cache saved before its tone and status steps) is derived again: it costs nothing.
  if (!state.cache || state.cache.key.startsWith('classic:') || (!state.vsix && state.accent.mode === 'custom')) { const next = compute(); write(next.tokens); terminalOverrides = next.terminal; root.toggleAttribute('data-vsix', Boolean(state.vsix)); return; }
  if (state.vsix) { root.dataset.theme = state.vsix.kind; root.setAttribute('data-vsix', ''); } else root.removeAttribute('data-vsix');
  write(state.cache.tokens);
  terminalOverrides = state.cache.terminal ?? {};
  const prefix = state.cache.key.split(':')[0];
  if (!state.vsix && prefix.startsWith('#') && state.accent.mode === 'wallpaper') wallpaperColor = prefix;
}

// Before the workspace paints: last session's colors, so nothing flashes yellow first.
restorePalette();

/* Switches (.ds-toggle, .settings-switch, role=switch checkboxes) slide only once the user touches them: one delegated
 * listener arms the switch under the pointer or focus, so a state set during render lands at once. */
function arm(event: Event): void {
  const target = event.target instanceof Element ? event.target : null;
  const host = target instanceof HTMLLabelElement ? target.control : target?.closest('label')?.control ?? target;
  const toggle = host?.closest?.('.ds-toggle, .settings-switch, input[type=checkbox][role=switch]');
  if (toggle instanceof HTMLElement) toggle.dataset.armed = '';
}
if (typeof document !== 'undefined') for (const type of ['pointerdown', 'keydown']) document.addEventListener(type, arm, { capture: true, passive: true });
