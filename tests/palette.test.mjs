import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, fromOklch, parseHex, toHex, toOklch } from '../src/color.ts';
import { accentTokens, dominantColor, vsixTokens } from '../src/palette-core.ts';

const rgb = hex => parseHex(hex).rgb;
const ratio = (a, b) => contrast(rgb(a), rgb(b));
// Recorded from real Open VSX packages: Dracula, One Dark Pro, GitHub, Catppuccin, Tokyo Night.
const themes = JSON.parse(readFileSync(new URL('./fixtures/vscode-themes.json', import.meta.url), 'utf8'));

test('OKLCH round-trips sRGB and keeps out-of-gamut colors in gamut', () => {
  for (const hex of ['#ffd43b', '#4f8ef7', '#282a36', '#ffffff', '#000000']) assert.equal(toHex(fromOklch(toOklch(rgb(hex)))), hex);
  const vivid = fromOklch({ l: 0.7, c: 0.5, h: 150 });
  assert.ok(vivid.every(v => v >= 0 && v <= 255.5), String(vivid));
});

test('any accent hue yields readable buttons, links and selection in both modes', () => {
  const bases = { light: '#ffffff', dark: '#1c1c1b' };
  for (let hue = 0; hue < 360; hue += 15) {
    const source = fromOklch({ l: 0.6, c: 0.15, h: hue });
    for (const mode of ['light', 'dark']) {
      const t = accentTokens(source, mode);
      assert.ok(ratio(t['--on-accent'], t['--accent']) >= 4.5, `${mode} hue ${hue}: text on accent`);
      assert.ok(ratio(t['--accent-ink'], t['--accent-dim']) >= 4.5, `${mode} hue ${hue}: ink on dim`);
      assert.ok(ratio(t['--focus'], bases[mode]) >= 3, `${mode} hue ${hue}: focus ring`);
      assert.match(t['--accent-rgb'], /^\d+ \d+ \d+$/);
    }
  }
});

test('real VS Code themes map to readable PandaCode surfaces and keep their own accent', () => {
  assert.equal(themes.length, 23);
  for (const theme of themes) {
    const { tokens, terminal } = vsixTokens({ id: 'x', name: theme.name, extension: 'x', kind: theme.kind, colors: theme.colors });
    assert.ok(ratio(tokens['--text'], tokens['--bg']) >= 4.5, `${theme.name}: text`);
    assert.ok(ratio(tokens['--muted'], tokens['--bg']) >= 2.5, `${theme.name}: muted`);
    assert.ok(ratio(tokens['--on-accent'], tokens['--accent']) >= 3, `${theme.name}: text on accent ${tokens['--on-accent']} / ${tokens['--accent']}`);
    assert.ok(toOklch(rgb(tokens['--border'])).c < 0.06, `${theme.name}: neutral border`);
    assert.equal(tokens['--bg'], toHex(rgb(theme.colors['editor.background'])), `${theme.name}: background is the theme's`);
    assert.ok(terminal.background && terminal.foreground);
    assert.ok(toOklch(rgb(tokens['--accent'])).c >= 0.06, `${theme.name}: a colorful accent, not ${tokens['--accent']}`);
  }
  // Dracula's buttons are gray; the accent comes from its own vivid highlights.
  const dracula = themes.find(theme => theme.name === 'Dracula Theme');
  assert.ok(['#ff79c6', '#bd93f9'].includes(vsixTokens({ ...dracula, id: 'd', extension: 'd' }).tokens['--accent']));
});

test('a wallpaper accent is its most present vivid hue, and gray scenes have none', () => {
  const pixels = (colors) => new Uint8ClampedArray(colors.flatMap(([hex, count]) => Array.from({ length: count }, () => [...rgb(hex), 255]).flat()));
  const accent = dominantColor(pixels([['#203a8f', 300], ['#d9822b', 80], ['#777777', 600]]));
  assert.ok(Math.abs(toOklch(accent).h - toOklch(rgb('#203a8f')).h) < 12, toHex(accent));
  assert.equal(dominantColor(pixels([['#777777', 500], ['#202020', 500]])), undefined);
});

test('every shipped wallpaper has an accent that makes readable buttons', async () => {
  const { readdirSync } = await import('node:fs');
  const { wallpaperAccents } = await import('../src/wallpaper-accents.ts');
  const scenes = readdirSync(new URL('../public/wallpapers/', import.meta.url)).filter(name => name.endsWith('.webp')).map(name => name.replace('.webp', ''));
  assert.equal(scenes.length, 21);
  for (const scene of scenes) {
    assert.ok(wallpaperAccents[scene], `${scene} has no accent`);
    for (const mode of ['light', 'dark']) {
      const t = accentTokens(rgb(wallpaperAccents[scene]), mode);
      assert.ok(ratio(t['--on-accent'], t['--accent']) >= 4.5, `${scene} ${mode}`);
    }
  }
});

test('built-in workspace palettes keep text, accents and focus readable in both appearances', async () => {
  const { BUILTIN_THEMES, builtinTokens } = await import('../src/palette-core.ts');
  for (const { id } of BUILTIN_THEMES) for (const mode of ['light', 'dark']) {
    const t = builtinTokens(id, mode);
    if (id === 'system') { assert.deepEqual(t, {}); continue; }
    for (const surface of ['--bg', '--sidebar', '--panel', '--raised']) {
      assert.ok(ratio(t['--text'], t[surface]) >= 4.5, `${id} ${mode}: text on ${surface}`);
      assert.ok(ratio(t['--muted'], t[surface]) >= 4.5, `${id} ${mode}: muted on ${surface}`);
    }
    assert.ok(ratio(t['--on-accent'], t['--accent']) >= 4.5, `${id} ${mode}: button text`);
    assert.ok(ratio(t['--focus'], t['--bg']) >= 3, `${id} ${mode}: focus`);
  }
});
