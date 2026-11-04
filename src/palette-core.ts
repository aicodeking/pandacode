import { contrast, mix, oklch, onColor, parseHex, toHex, toOklch, triplet, type Rgb } from './color.ts';

/* Pure palette derivation, shared by the app and its tests. */

export type VsixTheme = { id: string; name: string; extension: string; kind: 'light' | 'dark'; colors: Record<string, string> };
export type Tokens = Record<string, string>;

/** The state tones' source colours, as in design-system.css (tests/palette.test.mjs keeps them equal). */
export const TONE_HUES = {
  light: { plan: '#1c52ad', edit: '#075f55', full: '#874300', team: '#5f35b3', saver: '#17652f', remote: '#08587b', worktree: '#9c2260' },
  dark: { plan: '#85aeff', edit: '#2fcfb4', full: '#f5a524', team: '#b897fb', saver: '#5ccc6c', remote: '#45bff0', worktree: '#f27fb2' },
};
export const TONE_TOKENS = Object.keys(TONE_HUES.dark).map(name => `--ds-hue-${name}`);
/** Degrees of OKLCH hue a tone keeps from the accent, the floor a moved tone keeps from the other tones (relaxed down to
 * TONE_FLOOR when nothing clears it), how far a moved tone keeps from the status colours, and the reach of its own family. */
export const ACCENT_CLEARANCE = 30, TONE_CLEARANCE = 28, TONE_FLOOR = 22, STATUS_CLEARANCE = 25, TONE_FAMILY = 60;
export const hueGap = (a: number, b: number) => { const gap = Math.abs(a - b) % 360; return Math.min(gap, 360 - gap); };
/** A tone on the accent reads as the accent (Dracula's violet, the Blue swatch: the Team button, unread dot and selection
 * bar look alike), so it moves to the hue nearest its own that clears the accent, danger and the warning (a plan icon must
 * never look like an error) and the other tones: first within its family at the full floor, relaxing to TONE_FLOOR,
 * then anywhere; failing all that, the hue farthest from everything. Lightness and chroma stay; tones out of the
 * accent's reach never move, so a nearby accent (the next wallpaper) leaves them be. */
export function tonesClearOf(accentHue: number, kind: 'light' | 'dark', statusHues: number[]): Tokens {
  const seeds = Object.entries(TONE_HUES[kind]).map(([name, hex]) => ({ name, ...toOklch(parseHex(hex)!.rgb) }));
  const placed = new Map(seeds.map(seed => [seed.name, seed.h]));
  const tokens: Tokens = {};
  for (const { name, l, c, h } of seeds) {
    if (hueGap(h, accentHue) >= ACCENT_CLEARANCE) continue;
    const others = [...placed].filter(([other]) => other !== name).map(([, at]) => at);
    const clear = (hue: number) => hueGap(hue, accentHue) >= ACCENT_CLEARANCE && statusHues.every(at => hueGap(hue, at) >= STATUS_CLEARANCE);
    const toneGap = (hue: number) => Math.min(...others.map(at => hueGap(hue, at)));
    const nearest = (reach: number, floor: number) => {
      let best: number | undefined;
      for (let hue = 0; hue < 360; hue++) {
        if (hueGap(hue, h) > reach || !clear(hue) || toneGap(hue) < floor) continue;
        if (best === undefined || hueGap(hue, h) < hueGap(best, h)) best = hue;
      }
      return best;
    };
    let best: number | undefined;
    for (const reach of [TONE_FAMILY, 180]) for (let floor = TONE_CLEARANCE; best === undefined && floor >= TONE_FLOOR; floor--) best = nearest(reach, floor);
    if (best === undefined) {
      let bestGap = -1;
      for (let hue = 0; hue < 360; hue++) {
        const gap = Math.min(hueGap(hue, accentHue), ...statusHues.map(at => hueGap(hue, at)), toneGap(hue));
        if (gap > bestGap) { best = hue; bestGap = gap; }
      }
    }
    placed.set(name, best!); tokens[`--ds-hue-${name}`] = toHex(oklch(l, c, best!));
  }
  return tokens;
}

/** The status colours' defaults (tokens.css/styles.css; tests/palette.test.mjs keeps them equal). */
export const WARNING = { light: '#a8700a', dark: '#e3b24f' };
export const INFO = { light: '#2f6fc7', dark: '#15a0ec' };
export const STATUS = { light: { danger: '#b03535' }, dark: { danger: '#fa524a' } };
/** A status colour on the accent turns ACCENT_CLEARANCE away from it, on its own side; lightness and chroma stay. */
function turnedFrom(hex: string, accentHue: number): string | undefined {
  const { l, c, h } = toOklch(parseHex(hex)!.rgb);
  if (hueGap(h, accentHue) >= ACCENT_CLEARANCE) return;
  const side = Math.sign(((h - accentHue + 540) % 360) - 180) || -1;
  return toHex(oklch(l, c, accentHue + side * ACCENT_CLEARANCE));
}
/** An accent near amber (classic yellow) makes the unread dot read as needs you, so the warning turns away from it. */
export function warnClearOf(accentHue: number, mode: 'light' | 'dark'): Tokens {
  const warning = turnedFrom(WARNING[mode], accentHue);
  return warning ? { '--warning': warning } : {};
}
/** A blue accent makes the unread dot read as running (`--ds-info`), so info turns away from it the same way. */
export function infoClearOf(accentHue: number, mode: 'light' | 'dark'): Tokens {
  const info = turnedFrom(INFO[mode], accentHue);
  return info ? { '--info': info } : {};
}
/** Warning, info and the state tones, cleared of the accent. A moved tone clears the alarming statuses (danger, the
 * warning); success and info already sit beside saver and remote by design. */
export function statusClearOf(accentHue: number, mode: 'light' | 'dark', danger: string = STATUS[mode].danger): Tokens {
  const moved = { ...warnClearOf(accentHue, mode), ...infoClearOf(accentHue, mode) };
  const hues = [danger, moved['--warning'] ?? WARNING[mode]].map(hex => toOklch(parseHex(hex)!.rgb).h);
  return { ...tonesClearOf(accentHue, mode, hues), ...moved };
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
    ...statusClearOf(h, mode),
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
  // Muted text clears 4.5:1 on the page and on a card (--ds-card: the text 5.5% light / 4.5% dark over it).
  const card = mix(bg, fg, dark ? 0.045 : 0.055);
  const readable = (color: Rgb | undefined) => color && contrast(color, bg) >= 4.5 && contrast(color, card) >= 4.5 ? color : undefined;
  let muted = readable(get('descriptionForeground'));
  for (let share = 0.32; !muted && share > 0; share -= 0.02) muted = readable(mix(fg, bg, share));
  muted ??= fg;
  // Status colours and faint text take steps toward the text until they clear 4.5:1 on the page and a card too.
  // 4.55 leaves room for rounding to hex.
  const clears = (color: Rgb) => contrast(color, bg) >= 4.55 && contrast(color, card) >= 4.55;
  const lift = (color: Rgb, also?: Rgb): Rgb => { for (let step = 0; step <= 20; step++) { const lifted = mix(color, fg, step / 20); if (clears(lifted) && (!also || contrast(lifted, also) >= 4.55)) return lifted; } return fg; };
  const fallback = { color: dark ? [79, 142, 247] as Rgb : [37, 99, 235] as Rgb, key: '' };
  const found = themeAccent(get);
  // A theme with no colorful highlight at all still gets a visible accent.
  const picked = found && toOklch(found.color).c >= 0.06 ? found : fallback;
  const accent = picked.color;
  const onAccent = picked.key === 'button.background' ? visible(get('button.foreground'), accent, 3) : undefined;
  const { h, c } = toOklch(accent);
  const success = toHex(lift(visible(get('terminal.ansiGreen') ?? get('gitDecoration.addedResourceForeground'), bg, 2.5) ?? (dark ? [131, 207, 156] as Rgb : [35, 115, 69] as Rgb)));
  const danger = toHex(lift(visible(get('errorForeground') ?? get('terminal.ansiRed'), bg, 2.5) ?? (dark ? [255, 158, 150] as Rgb : [176, 53, 53] as Rgb)));
  const tokens: Tokens = {
    '--bg': toHex(bg), '--sidebar': toHex(sidebar), '--panel': toHex(panel), '--raised': toHex(raised), '--border': toHex(border),
    '--text': toHex(fg), '--muted': toHex(muted), '--faint': toHex(lift(mix(fg, bg, 0.42), sidebar)),
    '--success': success, '--danger': danger,
    // The theme's own accent, as is; only the supporting shades are derived.
    '--accent': toHex(accent), '--accent-rgb': triplet(accent),
    '--accent-hover': toHex(mix(accent, fg, 0.12)),
    '--on-accent': toHex(onAccent ?? onColor(accent)),
    '--accent-dim': toHex(mix(bg, accent, dark ? 0.22 : 0.16)),
    '--accent-ink': toHex(visible(mix(accent, fg, 0.25), mix(bg, accent, dark ? 0.22 : 0.16), 4) ?? fg),
    '--focus': toHex(visible(get('focusBorder'), bg, 2) ?? accent),
    '--accent-deep-rgb': triplet(oklch(0.5, c * 0.9, h)),
    '--accent-tint': toHex(mix(panel, accent, 0.05)), '--accent-tint-strong': toHex(mix(bg, accent, 0.05)),
    ...statusClearOf(h, dark ? 'dark' : 'light', danger),
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
