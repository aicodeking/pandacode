/// <reference types="node" />
// The iPhone Duo split view's pane insets (src/ui/pane-insets.ts): the sidebar takes the left inset, so
// a pane beside it must not add it again (a doubled gutter).
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { paneInsets } from '../src/ui/pane-insets.ts';

const rail = { left: 59, right: 0 };

test('beside the shown sidebar a pane drops the left inset', () => {
  assert.deepEqual(paneInsets(rail, true), { left: 0, right: 0 });
  assert.deepEqual(paneInsets({ left: 59, right: 20 }, true), { left: 0, right: 20 }, 'the right inset stays');
});

test('with the sidebar collapsed or no split, a pane keeps both insets', () => {
  assert.deepEqual(paneInsets(rail, false), rail);
  assert.deepEqual(paneInsets({ left: 0, right: 47 }, false), { left: 0, right: 47 });
});

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('pane screens take their side insets from usePaneInsets, not the raw safe area', () => {
  assert.match(source('ui/usePagePadding.ts'), /const \{ left, right \} = usePaneInsets\(\);/);
  for (const path of ['app/terminal.tsx', 'app/task/[device]/[session].tsx']) {
    const file = source(path);
    assert.match(file, /const side = usePaneInsets\(\);/, path);
    assert.doesNotMatch(file, /paddingLeft: insets\.left/, path);
  }
  // The sidebar is the one that takes the left inset.
  assert.match(source('ui/Sidebar.tsx'), /paddingLeft: insets\.left/);
});

test('the file viewer, editor, diff screen and git action bar never indent twice beside the sidebar', () => {
  const file = source('app/file.tsx');
  assert.match(file, /const side = usePaneInsets\(\);/);
  assert.doesNotMatch(file, /useSafeAreaInsets/);
  assert.equal(file.match(/insets=\{side\}/g)?.length, 2, 'CodeView and FileEditor');
  const diff = source('app/diff.tsx');
  assert.match(diff, /const side = usePaneInsets\(\);/);
  assert.doesNotMatch(diff, /insets\.(left|right)/);
  const bar = source('ui/GitParts.tsx');
  assert.match(bar, /const side = usePaneInsets\(\);/);
  assert.doesNotMatch(bar, /insets\.(left|right)/);
});

test('the code view sizes its lines from its own pane, not the window', () => {
  const code = source('ui/hub/CodeView.tsx');
  assert.doesNotMatch(code, /useWindowDimensions/);
  assert.match(code, /<ScrollView horizontal [^>]*onLayout=\{measure\}/);
  assert.match(code, /setWidth\(event\.nativeEvent\.layout\.width\)/);
});

test('the diff screen reloads on reconnect and keeps its banner and empty states on ds geometry', () => {
  const diff = source('app/diff.tsx');
  assert.match(diff, /useReloadOnReconnect\(device, load\);/);
  assert.match(diff, /bottom: insets\.bottom \+ geometry\.screenMargin/);
  assert.match(diff, /marginTop: geometry\.emptyTop/);
  assert.doesNotMatch(diff, /marginTop: \d|bottom: \d/);
});
