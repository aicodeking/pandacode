import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { contrast, fromOklch, mix, parseHex, toHex, toOklch } from '../src/color.ts';
import { ACCENT_CLEARANCE, INFO, STATUS, STATUS_CLEARANCE, TONE_FLOOR, TONE_HUES, WARNING, accentTokens, warnClearOf, dominantColor, vsixTokens } from '../src/palette-core.ts';

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
  const bases = { light: '#ffffff', dark: '#151515' };
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
    const card = toHex(mix(rgb(tokens['--bg']), rgb(tokens['--text']), theme.kind === 'dark' ? 0.045 : 0.055));
    assert.ok(ratio(tokens['--muted'], tokens['--bg']) >= 4.5, `${theme.name}: muted ${tokens['--muted']} on page`);
    assert.ok(ratio(tokens['--muted'], card) >= 4.5, `${theme.name}: muted ${tokens['--muted']} on a card`);
    for (const name of ['--faint', '--danger', '--success']) {
      assert.ok(ratio(tokens[name], tokens['--bg']) >= 4.5 && ratio(tokens[name], card) >= 4.5, `${theme.name}: ${name} ${tokens[name]} clears 4.5:1 on page and card`);
    }
    // Faint text also runs on the sidebar (kbd hints, task ages, checkouts).
    assert.ok(ratio(tokens['--faint'], tokens['--sidebar']) >= 4.5, `${theme.name}: --faint ${tokens['--faint']} clears 4.5:1 on the sidebar ${tokens['--sidebar']}`);
    // --ds-info in design-system.css: the fixed info blue (tokens.css) 30% toward the theme's text.
    const info = toHex(mix(rgb(tokens['--info'] ?? (theme.kind === 'dark' ? '#15a0ec' : '#2f6fc7')), rgb(tokens['--text']), 0.3));
    assert.ok(ratio(info, tokens['--bg']) >= 4.5 && ratio(info, card) >= 4.5, `${theme.name}: info ${info} clears 4.5:1 on page and card`);
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

test('state tones clear 4.5:1 on the page, a card and their own fill, in every palette and real theme', () => {
  const css = readFileSync(new URL('../src/design-system.css', import.meta.url), 'utf8');
  const hues = kind => {
    const start = kind === 'dark' ? css.indexOf('html[data-theme="dark"]{') : css.indexOf(':root{');
    return Object.fromEntries([...css.slice(start).matchAll(/--ds-hue-(\w+):(#[0-9a-f]{6})/g)].slice(0, 7).map(match => [match[1], match[2]]));
  };
  const check = (label, kind, surfaces, keep = 1, toward = '#000000', fillAmount = kind === 'dark' ? 0.14 : 0.1, moved = {}) => {
    assert.equal(Object.keys(hues(kind)).length, 7, `${kind}: seven hues`);
    assert.deepEqual(hues(kind), TONE_HUES[kind], `${kind}: palette-core's hues match the CSS`);
    for (const [name, base] of Object.entries(hues(kind))) {
      const hue = moved[`--ds-hue-${name}`] ?? base;
      const tone = toHex(mix(rgb(toward), rgb(hue), keep));
      for (const surface of surfaces) {
        assert.ok(ratio(tone, surface) >= 4.5, `${label} ${name} ${tone} on ${surface}: ${ratio(tone, surface).toFixed(2)}`);
        const fill = toHex(mix(rgb(surface), rgb(tone), fillAmount));
        assert.ok(ratio(tone, fill) >= 4.5, `${label} ${name} ${tone} on its fill ${fill}: ${ratio(tone, fill).toFixed(2)}`);
      }
    }
  };
  // Page, card on the page, the frame, card on the frame.
  const on = (bg, text, frame, card) => [bg, frame].flatMap(base => [base, toHex(mix(rgb(base), rgb(text), card))]);
  check('dark', 'dark', on('#151515', '#e2e2e2', '#0e0e0e', 0.02));
  check('light', 'light', on('#ffffff', '#242423', toHex(mix(rgb('#f5f5f3'), rgb('#242423'), 0.04)), 0.03));
  // Increase Contrast: halfway to the text.
  check('dark contrast', 'dark', on('#151515', '#e2e2e2', '#0e0e0e', 0.02), 0.5, '#e2e2e2');
  check('light contrast', 'light', on('#ffffff', '#242423', '#f5f5f3', 0.03), 0.5, '#242423');
  // The darkest surface a light wallpaper puts under them and the brightest a dark one does, sampled across all 21 scenes at 20% and 80% visibility.
  check('dark wallpaper', 'dark', ['#343632'], 0.7, '#ffffff');
  check('light wallpaper', 'light', ['#dedfdf'], 0.9, '#242423');
  for (const theme of themes) {
    const { tokens } = vsixTokens({ id: 'x', name: theme.name, extension: 'x', kind: theme.kind, colors: theme.colors });
    const card = toHex(mix(rgb(tokens['--bg']), rgb(tokens['--text']), theme.kind === 'dark' ? 0.045 : 0.055));
    check(theme.name, theme.kind === 'dark' ? 'dark' : 'light', [tokens['--bg'], card], 0.62, tokens['--text'], 0.08, tokens);
  }
});

test('a state tone on an imported accent steps away from it, and the others stay put', () => {
  const hue = hex => toOklch(rgb(hex)).h;
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const colors = accent => ({ 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'button.background': accent });
  // Dracula's violet: the team tone moves, plan and worktree do not.
  const violet = vsixTokens({ id: 'v', name: 'v', extension: 'v', kind: 'dark', colors: colors('#bd93f9') }).tokens;
  assert.ok(gap(hue(violet['--ds-hue-team']), hue('#bd93f9')) >= ACCENT_CLEARANCE - 2, `team ${violet['--ds-hue-team']}`);
  assert.equal(violet['--ds-hue-plan'], undefined);
  assert.equal(violet['--ds-hue-worktree'], undefined);
  // Only tones within reach of the accent ever move.
  const clearOfAll = vsixTokens({ id: 'n', name: 'n', extension: 'n', kind: 'dark', colors: colors('#ff5540') }).tokens;
  assert.deepEqual(Object.keys(clearOfAll).filter(key => key.startsWith('--ds-hue-') && gap(hue(TONE_HUES.dark[key.slice(9)]), hue('#ff5540')) >= ACCENT_CLEARANCE), []);
  // Every recorded theme ends with every tone clear of its accent.
  for (const theme of themes) {
    const { tokens } = vsixTokens({ id: 'x', name: theme.name, extension: 'x', kind: theme.kind, colors: theme.colors });
    for (const [name, base] of Object.entries(TONE_HUES[theme.kind === 'dark' ? 'dark' : 'light'])) {
      const tone = tokens[`--ds-hue-${name}`] ?? base;
      assert.ok(gap(hue(tone), hue(tokens['--accent'])) >= ACCENT_CLEARANCE - 3, `${theme.name}: ${name} ${tone} on ${tokens['--accent']}`);
    }
  }
});

test('a moved tone keeps the floor from every other tone (blue accents and Dracula)', () => {
  const hue = hex => toOklch(rgb(hex)).h;
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const synthetic = accent => ({ name: accent, kind: 'dark', colors: { 'editor.background': '#282a36', 'editor.foreground': '#f8f8f2', 'button.background': accent } });
  const blue = theme => { const a = hue(vsixTokens({ id: 'x', name: theme.name, extension: 'x', kind: theme.kind, colors: theme.colors }).tokens['--accent']); return a > 240 && a < 280; };
  const cases = [...themes.filter(theme => blue(theme) || theme.name.startsWith('Dracula')), synthetic('#bd93f9'), synthetic('#1f6feb')];
  assert.ok(cases.length >= 12, `${cases.length} cases`);
  for (const theme of cases) {
    const { tokens } = vsixTokens({ id: 'x', name: theme.name, extension: 'x', kind: theme.kind, colors: theme.colors });
    const tones = Object.entries(TONE_HUES[theme.kind === 'dark' ? 'dark' : 'light']).map(([name, base]) => [name, hue(tokens[`--ds-hue-${name}`] ?? base)]);
    for (const [i, [a, ha]] of tones.entries()) for (const [b, hb] of tones.slice(i + 1)) {
      assert.ok(gap(ha, hb) >= TONE_FLOOR, `${theme.name}: ${a} and ${b} ${gap(ha, hb).toFixed(1)}° apart`);
    }
    // A moved tone never lands on an alarm: danger and needs you.
    const alarms = [tokens['--danger'], tokens['--warning'] ?? WARNING[theme.kind === 'dark' ? 'dark' : 'light']].map(hue);
    for (const [name, at] of tones) if (tokens[`--ds-hue-${name}`]) for (const alarm of alarms) {
      assert.ok(gap(at, alarm) >= STATUS_CLEARANCE, `${theme.name}: moved ${name} ${tokens[`--ds-hue-${name}`]} ${gap(at, alarm).toFixed(1)}° from a status`);
    }
  }
  // Blue accents keep plan blue-family (cyan), never orange.
  const github = themes.find(theme => theme.name === 'GitHub Dark Default');
  const plan = hue(vsixTokens({ id: 'g', name: 'g', extension: 'g', kind: 'dark', colors: github.colors }).tokens['--ds-hue-plan']);
  assert.ok(gap(plan, hue(TONE_HUES.dark.plan)) <= 60, `plan ${plan.toFixed(0)}° stays in its family`);
});

test("PandaCode's own accents clear the tones and info too, and leave tones out of reach alone", () => {
  const hue = hex => toOklch(rgb(hex)).h;
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  const wallpapers = Object.values(Object.fromEntries([...readFileSync(new URL('../src/wallpaper-accents.ts', import.meta.url), 'utf8').matchAll(/'([\w-]+)': '(#[0-9a-f]{6})'/g)].map(m => [m[1], m[2]])));
  assert.equal(wallpapers.length, 21);
  for (const mode of ['light', 'dark']) for (const source of ['#4f8ef7', '#34c084', '#a86cf0', '#f0679b', '#ff8a3d', '#2fb8c4', ...wallpapers]) {
    const tokens = accentTokens(rgb(source), mode), accent = hue(tokens['--accent']);
    const label = `${mode} ${source} (accent ${accent.toFixed(0)}°)`;
    // Unread (accent) and running (info) never match.
    assert.ok(gap(hue(tokens['--info'] ?? INFO[mode]), accent) >= ACCENT_CLEARANCE - 1, `${label}: info ${tokens['--info']}`);
    const alarms = [STATUS[mode].danger, tokens['--warning'] ?? WARNING[mode]].map(hue);
    const tones = Object.entries(TONE_HUES[mode]).map(([name, base]) => [name, hue(tokens[`--ds-hue-${name}`] ?? base)]);
    for (const [name, base] of Object.entries(TONE_HUES[mode])) {
      const moved = tokens[`--ds-hue-${name}`];
      // Only a tone within the accent's reach moves, so a nearby wallpaper accent never shifts the others.
      assert.equal(Boolean(moved), gap(hue(base), accent) < ACCENT_CLEARANCE, `${label}: ${name} ${moved ?? 'stays'}`);
      if (!moved) continue;
      assert.ok(gap(hue(moved), accent) >= ACCENT_CLEARANCE - 2, `${label}: ${name} ${moved} clears the accent`);
      for (const alarm of alarms) assert.ok(gap(hue(moved), alarm) >= STATUS_CLEARANCE - 1, `${label}: ${name} ${moved} clears danger and warn`);
      for (const [other, at] of tones) if (other !== name) assert.ok(gap(hue(moved), at) >= TONE_FLOOR - 1, `${label}: ${name} ${moved} and ${other}`);
    }
  }
  // The Blue swatch, dark: plan goes cyan, info steps off the accent.
  const blue = accentTokens(rgb('#4f8ef7'), 'dark');
  assert.ok(blue['--ds-hue-plan'] && gap(hue(blue['--ds-hue-plan']), hue(TONE_HUES.dark.plan)) <= 60, `plan ${blue['--ds-hue-plan']}`);
  assert.ok(blue['--info']);
  // tokens.css and styles.css hold the same defaults.
  const tokensCss = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8'), styles = readFileSync(new URL('../src/styles.css', import.meta.url), 'utf8');
  assert.equal(tokensCss.match(/--info:(#[0-9a-f]{6})/)[1], INFO.light);
  assert.equal(tokensCss.match(/html\[data-theme="dark"\]\{--info:(#[0-9a-f]{6})/)[1], INFO.dark);
  assert.ok(styles.includes(`--danger:${STATUS.light.danger}`) && styles.includes(`--danger:${STATUS.dark.danger}`));
});

test('needs-you amber turns away from an accent near it (classic yellow), and keeps its contrast', () => {
  const css = readFileSync(new URL('../src/tokens.css', import.meta.url), 'utf8');
  assert.equal(css.match(/--warning:(#[0-9a-f]{6})/)[1], WARNING.light);
  assert.equal(css.match(/html\[data-theme="dark"\]\{[^}]*--warning:(#[0-9a-f]{6})/)[1], WARNING.dark);
  const hue = hex => toOklch(rgb(hex)).h;
  const gap = (a, b) => { const d = Math.abs(a - b) % 360; return Math.min(d, 360 - d); };
  for (const mode of ['light', 'dark']) {
    const page = mode === 'dark' ? '#151515' : '#ffffff';
    for (const accent of ['#ffd43b', '#f5b041', '#e3b24f', '#ff8a3d']) {
      const tokens = accentTokens(rgb(accent), mode);
      const warn = tokens['--warning'] ?? WARNING[mode];
      assert.ok(gap(hue(warn), hue(tokens['--accent'])) >= ACCENT_CLEARANCE - 3, `${mode} ${accent}: warn ${warn} on accent ${tokens['--accent']}`);
      assert.ok(ratio(warn, page) >= ratio(WARNING[mode], page) * 0.95, `${mode} ${accent}: warn ${warn} keeps its contrast`);
    }
    // Classic yellow (CSS defaults, no accent tokens) takes the same step; a blue accent leaves it alone.
    assert.ok(gap(hue(warnClearOf(hue('#ffd43b'), mode)['--warning']), hue('#ffd43b')) >= ACCENT_CLEARANCE - 1);
    assert.deepEqual(warnClearOf(hue('#4f8ef7'), mode), {});
  }
});
