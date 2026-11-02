import { contrast, mix, oklch, onColor, parseHex, toHex, toOklch, triplet, type Rgb } from './color.ts';

/* Pure palette derivation, shared by the app and its tests. */

export type VsixTheme = { id: string; name: string; extension: string; kind: 'light' | 'dark'; colors: Record<string, string> };
export type Tokens = Record<string, string>;

export const BUILTIN_THEMES = [
  { id: 'system', name: 'System', hue: 0 },
  { id: 'ocean', name: 'Ocean', hue: 235 },
  { id: 'amethyst', name: 'Amethyst', hue: 305 },
  { id: 'forest', name: 'Forest', hue: 155 },
  { id: 'rose', name: 'Rose', hue: 355 },
  { id: 'amber', name: 'Amber', hue: 80 },
] as const;
export type BuiltinTheme = typeof BUILTIN_THEMES[number]['id'];

/** Softly colored surfaces, with readable text in either appearance. */
export function builtinTokens(id: BuiltinTheme, mode: 'light' | 'dark'): Tokens {
  if (id === 'system') return {};
  const hue = BUILTIN_THEMES.find(theme => theme.id === id)!.hue, dark = mode === 'dark';
  const color = (lightness: number, chroma = 0.025) => toHex(oklch(lightness, chroma, hue));
  return {
    '--bg': color(dark ? 0.23 : 0.985), '--sidebar': color(dark ? 0.26 : 0.95),
    '--panel': color(dark ? 0.28 : 0.96), '--raised': color(dark ? 0.32 : 0.92),
    '--text': color(dark ? 0.94 : 0.25, 0.012), '--muted': color(dark ? 0.74 : 0.48, 0.018),
    '--faint': color(dark ? 0.65 : 0.54, 0.015), '--border': color(dark ? 0.4 : 0.82, 0.018),
    ...accentTokens(oklch(0.76, 0.13, hue), mode),
  };
}

/** Accent shades for PandaCode's own surfaces, tuned per light and dark. */
export function accentTokens(source: Rgb, mode: 'light' | 'dark'): Tokens {
  const { l, c: rawC, h } = toOklch(source);
  const c = Math.min(Math.max(rawC, 0.09), 0.19), dark = mode === 'dark';
  const accent = oklch(Math.min(Math.max(l, dark ? 0.68 : 0.64), 0.88), c, h);
  return {
    '--accent': toHex(accent), '--accent-rgb': triplet(accent),
    '--accent-hover': toHex(oklch(Math.min(Math.max(l, dark ? 0.68 : 0.64), 0.88) - 0.045, c, h)),
    '--on-accent': toHex(onColor(accent)),
    '--accent-dim': toHex(dark ? oklch(0.34, c * 0.32, h) : oklch(0.95, c * 0.33, h)),
    '--accent-ink': toHex(dark ? oklch(0.86, c * 0.6, h) : oklch(0.4, Math.min(c, 0.12), h)),
    '--focus': toHex(dark ? oklch(0.8, c * 0.85, h) : oklch(0.52, Math.min(c, 0.15), h)),
    '--accent-deep-rgb': triplet(oklch(0.5, c * 0.9, h)),
    '--accent-tint': toHex(dark ? oklch(0.255, 0.02, h) : oklch(0.988, 0.012, h)),
    '--accent-tint-strong': toHex(dark ? oklch(0.25, 0.022, h) : oklch(0.988, 0.012, h)),
  };
}

/** The most chromatic color among a VS Code theme's highlight colors. */
function themeAccent(get: (key: string) => Rgb | undefined): { color: Rgb; key: string } | undefined {
  const keys = ['button.background', 'focusBorder', 'activityBarBadge.background', 'textLink.foreground', 'progressBar.background', 'tab.activeBorderTop', 'statusBarItem.remoteBackground', 'editorCursor.foreground', 'list.highlightForeground', 'terminal.ansiBlue', 'terminal.ansiMagenta'];
  const found = keys.map(key => ({ key, color: get(key) })).filter((entry): entry is { key: string; color: Rgb } => Boolean(entry.color));
  if (!found.length) return;
  // The most vivid wins; a close second listed earlier (the button) is the theme's intent.
  const most = Math.max(...found.map(entry => toOklch(entry.color).c));
  return found.find(entry => toOklch(entry.color).c >= most - 0.03 && toOklch(entry.color).c >= 0.06) ?? found[0];
}

/** Map a VS Code theme's workbench colors onto PandaCode's tokens, and the terminal's. */
export function vsixTokens(themeData: VsixTheme): { tokens: Tokens; terminal: Record<string, string> } {
  const dark = themeData.kind === 'dark';
  const raw = (key: string) => parseHex(themeData.colors[key] ?? '');
  const bg = raw('editor.background')?.rgb ?? (dark ? [30, 30, 30] as Rgb : [255, 255, 255] as Rgb);
  // Translucent theme colors are seen over the editor background.
  const get = (key: string): Rgb | undefined => { const value = raw(key); return value && mix(bg, value.rgb, value.alpha); };
  const fg = get('editor.foreground') ?? get('foreground') ?? (dark ? [212, 212, 212] as Rgb : [36, 36, 35] as Rgb);
  const visible = (color: Rgb | undefined, against: Rgb, min: number) => color && contrast(color, against) >= min ? color : undefined;
  const sidebar = get('sideBar.background') ?? get('activityBar.background') ?? mix(bg, fg, 0.03);
  const panel = get('panel.background') ?? sidebar;
  const raised = get('list.hoverBackground') ?? get('input.background') ?? mix(bg, fg, 0.08);
  // Themes often color one border loudly (Dracula's panel); app-wide lines stay neutral.
  const border = ['editorGroup.border', 'sideBar.border', 'panel.border', 'contrastBorder'].map(get)
    .find(color => color && toOklch(color).c < 0.06 && contrast(color, bg) >= 1.15) ?? mix(bg, fg, 0.14);
  const muted = visible(get('descriptionForeground'), bg, 3) ?? mix(fg, bg, 0.32);
  const fallback = { color: dark ? [79, 142, 247] as Rgb : [37, 99, 235] as Rgb, key: '' };
  const found = themeAccent(get);
  // A theme with no colorful highlight at all still gets a visible accent.
  const picked = found && toOklch(found.color).c >= 0.06 ? found : fallback;
  const accent = picked.color;
  const onAccent = picked.key === 'button.background' ? visible(get('button.foreground'), accent, 3) : undefined;
  const { h, c } = toOklch(accent);
  const tokens: Tokens = {
    '--bg': toHex(bg), '--sidebar': toHex(sidebar), '--panel': toHex(panel), '--raised': toHex(raised), '--border': toHex(border),
    '--text': toHex(fg), '--muted': toHex(muted), '--faint': toHex(mix(fg, bg, 0.42)),
    '--success': toHex(visible(get('terminal.ansiGreen') ?? get('gitDecoration.addedResourceForeground'), bg, 2.5) ?? (dark ? [131, 207, 156] as Rgb : [35, 115, 69] as Rgb)),
    '--danger': toHex(visible(get('errorForeground') ?? get('terminal.ansiRed'), bg, 2.5) ?? (dark ? [255, 158, 150] as Rgb : [176, 53, 53] as Rgb)),
    // The theme's own accent, as is; only the supporting shades are derived.
    '--accent': toHex(accent), '--accent-rgb': triplet(accent),
    '--accent-hover': toHex(mix(accent, fg, 0.12)),
    '--on-accent': toHex(onAccent ?? onColor(accent)),
    '--accent-dim': toHex(mix(bg, accent, dark ? 0.22 : 0.16)),
    '--accent-ink': toHex(visible(mix(accent, fg, 0.25), mix(bg, accent, dark ? 0.22 : 0.16), 4) ?? fg),
    '--focus': toHex(visible(get('focusBorder'), bg, 2) ?? accent),
    '--accent-deep-rgb': triplet(oklch(0.5, c * 0.9, h)),
    '--accent-tint': toHex(mix(panel, accent, 0.05)), '--accent-tint-strong': toHex(mix(bg, accent, 0.05)),
  };
  const ansi = ['Black', 'Red', 'Green', 'Yellow', 'Blue', 'Magenta', 'Cyan', 'White', 'BrightBlack', 'BrightRed', 'BrightGreen', 'BrightYellow', 'BrightBlue', 'BrightMagenta', 'BrightCyan', 'BrightWhite'];
  const terminal: Record<string, string> = {
    background: toHex(get('terminal.background') ?? panel), foreground: toHex(get('terminal.foreground') ?? fg),
    cursor: toHex(get('terminalCursor.foreground') ?? accent), cursorAccent: toHex(get('terminal.background') ?? panel),
    selectionBackground: (themeData.colors['terminal.selectionBackground'] ?? toHex(accent) + '55'),
  };
  for (const name of ansi) {
    const value = get(`terminal.ansi${name}`);
    if (value) terminal[name[0].toLowerCase() + name.slice(1)] = toHex(value);
  }
  return { tokens, terminal };
}

function hueBins(pixels: Uint8ClampedArray, minChroma: number) {
  const bins = Array.from({ length: 24 }, () => ({ weight: 0, r: 0, g: 0, b: 0 }));
  for (let i = 0; i < pixels.length; i += 4) {
    if (pixels[i + 3] < 200) continue;
    const rgb: Rgb = [pixels[i], pixels[i + 1], pixels[i + 2]], { l, c, h } = toOklch(rgb);
    if (c < minChroma || l < 0.12 || l > 0.96) continue;
    const weight = c * c * (l > 0.35 && l < 0.88 ? 1 : 0.4), bin = bins[Math.floor(h / 15) % 24];
    bin.weight += weight; bin.r += rgb[0] * weight; bin.g += rgb[1] * weight; bin.b += rgb[2] * weight;
  }
  // Neighbouring bins share a hue family.
  const best = bins.map((bin, i) => ({ i, score: bin.weight + 0.5 * (bins[(i + 23) % 24].weight + bins[(i + 1) % 24].weight) })).sort((x, y) => y.score - x.score)[0];
  return bins[best.i];
}
/** The most present vivid hue in RGBA pixels; muted scenes give their faint tint, gray ones nothing. */
export function dominantColor(pixels: Uint8ClampedArray): Rgb | undefined {
  for (const [minChroma, minWeight] of [[0.04, 0.4], [0.012, 0.01]]) {
    const bin = hueBins(pixels, minChroma);
    if (bin.weight >= minWeight) return [bin.r / bin.weight, bin.g / bin.weight, bin.b / bin.weight];
  }
}
