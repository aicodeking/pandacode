import './palette.css';
import { parseHex } from './color';
import { accentTokens, vsixTokens, type Tokens, type VsixTheme } from './palette-core';
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
  '--accent', '--accent-rgb', '--accent-dim', '--accent-ink', '--focus', '--on-accent', '--accent-hover', '--accent-deep-rgb', '--accent-tint', '--accent-tint-strong'];
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
let wallpaperColor: string | undefined;
const theme = () => (root.dataset.theme === 'light' ? 'light' : 'dark') as 'light' | 'dark';

function persist(): void {
  try { localStorage.setItem(STORE, JSON.stringify(state)); } catch { /* This launch keeps the palette. */ }
}
function write(tokens: Tokens): void {
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
  if (!source) return { key: `classic:${mode}`, tokens: {}, terminal: {} };
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
    wallpaperId = id;
    wallpaperColor = id ? wallpaperAccents[id] : undefined;
    if (!state.vsix && state.accent.mode === 'wallpaper') apply();
  },
  /** Light or dark changed: shades are re-derived for the new base. */
  refresh(): void { apply(); },
};

/** Re-read the saved palette and apply its cached colors without recomputing; the launcher calls this when the main window changes them. */
export function restorePalette(): void {
  state = read();
  if (!state.cache) { write({}); root.toggleAttribute('data-vsix', Boolean(state.vsix)); return; }
  if (state.vsix) { root.dataset.theme = state.vsix.kind; root.setAttribute('data-vsix', ''); } else root.removeAttribute('data-vsix');
  write(state.cache.tokens);
  terminalOverrides = state.cache.terminal ?? {};
  const prefix = state.cache.key.split(':')[0];
  if (!state.vsix && prefix.startsWith('#') && state.accent.mode === 'wallpaper') wallpaperColor = prefix;
}

// Before the workspace paints: last session's colors, so nothing flashes yellow first.
restorePalette();
