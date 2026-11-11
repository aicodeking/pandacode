/// <reference types="node" />
// On Android the installed expo-router's Stack.Toolbar.Button and Stack.Toolbar.Menu render nothing
// unless their icon is an image (no SF Symbols, no text). Routes go through src/ui/HeaderActions.tsx,
// which draws Android's headerLeft/headerRight itself; this keeps a new screen from losing its actions there.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const app = fileURLToPath(new URL('../src/app/', import.meta.url));
const ui = fileURLToPath(new URL('../src/ui/', import.meta.url));

/** Files with their own Android path (headerLeft/headerRight with the ds Button and Menu), and why. */
const ALLOWED: Record<string, string> = {
  '(tabs)/inbox/index.tsx': 'Stack.Toolbar only under Platform.OS === "ios"; headerLeft/headerRight elsewhere',
};

const TOOLBAR_ITEM = /Stack\.Toolbar\.(Button|Menu)\b/;

function routes(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap(entry => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return routes(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test('routes put header buttons and menus through HeaderActions, so Android draws them', () => {
  const offenders = routes(app)
    .map(path => ({ name: relative(app, path), source: readFileSync(path, 'utf8') }))
    .filter(({ name, source }) => TOOLBAR_ITEM.test(source) && !(name in ALLOWED))
    .map(({ name }) => name);
  assert.deepEqual(offenders, [], `Use HeaderActions (src/ui/HeaderActions.tsx) instead of Stack.Toolbar.Button/Menu in: ${offenders.join(', ')}`);
});

test('every allowlisted route still uses a toolbar item (stale entries go)', () => {
  for (const name of Object.keys(ALLOWED)) assert.match(readFileSync(join(app, name), 'utf8'), TOOLBAR_ITEM, `${name} no longer needs its allowlist entry`);
});

test('the inbox keeps its explicit Android path', () => {
  const inbox = readFileSync(join(app, '(tabs)/inbox/index.tsx'), 'utf8');
  assert.match(inbox, /headerRight: Platform\.OS === 'ios' \? undefined/);
});

test('HeaderActions draws Android items itself and Stack.Toolbar only on iOS', () => {
  const source = readFileSync(join(ui, 'HeaderActions.tsx'), 'utf8');
  assert.match(source, /if \(Platform\.OS === 'ios'\) return/);
  assert.match(source, /headerLeft/);
  assert.match(source, /headerRight/);
});

test('TaskHeader returns its Android header before any Stack.Toolbar', () => {
  const source = readFileSync(join(ui, 'TaskHeader.tsx'), 'utf8');
  const android = source.indexOf("if (Platform.OS !== 'ios')");
  assert.ok(android > 0);
  assert.ok(android < source.indexOf('<Stack.Toolbar'), 'the Android branch must come first');
  // Gated Tools items explain themselves on Android, as Deploy's do.
  assert.match(source, /subtitle: t\.gate\.note/);
});

test('on the Duo, pushed screens get the task header’s sidebar toggle; sheets opt out', () => {
  const source = readFileSync(join(ui, 'HeaderActions.tsx'), 'utf8');
  assert.match(source, /useSplit\(\)/);
  assert.match(source, /toggleSidebar/);
  assert.match(source, /ios: 'sidebar\.left'/, 'the same symbol as TaskHeader’s toggle');
  // On by default only for a screen that keeps its back button (no left side of its own).
  assert.match(source, /sidebar \?\? own === undefined/);
  for (const sheet of ['rename.tsx', 'commit.tsx', 'new-pull.tsx', 'btw.tsx']) {
    assert.match(readFileSync(join(app, sheet), 'utf8'), /sidebar=\{false\}/, `${sheet} is a sheet: no sidebar toggle`);
  }
});

test('sheet confirm actions live in the native header, not a keyboard-riding bar', () => {
  for (const sheet of ['rename.tsx', 'commit.tsx', 'new-pull.tsx']) {
    const source = readFileSync(join(app, sheet), 'utf8');
    assert.match(source, /primary: true/, `${sheet} confirms from the header`);
    assert.doesNotMatch(source, /ActionBar|KeyboardStickyView/, `${sheet} has no bottom action bar`);
  }
});

/** The names in _layout.tsx's PUSHED_SCREENS table (`['name', 'Title']` pairs). */
function pushedScreens(): string[] {
  const layout = readFileSync(join(app, '_layout.tsx'), 'utf8');
  const body = layout.match(/const PUSHED_SCREENS\b[^=]*= \[([\s\S]*?)\];/)?.[1];
  assert.ok(body, 'PUSHED_SCREENS not found in _layout.tsx');
  return [...body.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']*'\s*\]/g)].map(m => m[1]);
}

test('on the Duo every pushed screen renders HeaderActions, so the sidebar toggle is always reachable', () => {
  const names = pushedScreens();
  assert.ok(names.length > 20, 'the PUSHED_SCREENS table parsed');
  const missing = names
    .filter(name => !/<HeaderActions\b/.test(readFileSync(join(app, `${name}.tsx`), 'utf8')));
  assert.deepEqual(missing, [], `Render <HeaderActions /> (the Duo's sidebar toggle) in: ${missing.join(', ')}`);
});

test('every Stack.Screen in a pushed screen comes with HeaderActions, so no return path loses the toggle', () => {
  const count = (source: string, pattern: RegExp) => source.match(pattern)?.length ?? 0;
  const short = pushedScreens()
    .map(name => ({ name, source: readFileSync(join(app, `${name}.tsx`), 'utf8') }))
    .filter(({ source }) => count(source, /<HeaderActions\b/g) < count(source, /<Stack\.Screen\b/g))
    .map(({ name }) => name);
  assert.deepEqual(short, [], `A <Stack.Screen> without its own <HeaderActions /> in: ${short.join(', ')}`);
});

test('sheet keyboard padding: JS lifts unless react-native-screens lifts the Android sheet itself', async () => {
  const { FEATURE_SHEET_DETENTS, nativeSheetLift, sheetKeyboardPadding, TASK_INFO_DETENTS } = await import('../src/ui/sheet-keyboard.ts');
  assert.equal(sheetKeyboardPadding('ios', 'fitToContents'), true, 'iOS never moves sheets for the keyboard');
  assert.equal(sheetKeyboardPadding('ios', [0.6, 1]), true);
  assert.equal(sheetKeyboardPadding('android', 'fitToContents'), false);
  assert.equal(sheetKeyboardPadding('android', [0.5, 0.8]), false);
  assert.equal(sheetKeyboardPadding('android', [0.6, 1]), true, 'a full-height detent leaves no room for the native shift');
  assert.equal(nativeSheetLift('android', []), false);
  // The helper's copies of the detents match the layout's.
  const layout = readFileSync(join(app, '_layout.tsx'), 'utf8');
  assert.match(layout, new RegExp(`name="task-info" options=\\{\\{ \\.\\.\\.sheet, sheetAllowedDetents: '${TASK_INFO_DETENTS}'`));
  assert.match(layout, new RegExp(`SHEET_SCREENS\\.map\\([^\\n]*sheetAllowedDetents: \\[${(FEATURE_SHEET_DETENTS as number[]).join(', ')}\\]`));
  for (const sheet of ['btw.tsx', 'commit.tsx', 'new-pull.tsx', 'new-schedule.tsx', 'add-project.tsx', 'task-info.tsx']) {
    assert.match(readFileSync(join(app, sheet), 'utf8'), /enabled=\{SHEET_KEYBOARD\}/, `${sheet} gates its keyboard padding`);
  }
});
