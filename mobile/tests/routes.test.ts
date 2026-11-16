/// <reference types="node" />
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import test from 'node:test';
import { HOME, landing, SIGN_IN } from '../src/routes.ts';

const app = new URL('../src/app/', import.meta.url);

test('landing routes are real screens, not a group without an index', () => {
  assert.equal(landing(true), HOME);
  assert.equal(landing(false), SIGN_IN);
  assert.ok(existsSync(new URL('(tabs)/inbox/index.tsx', app)));
  assert.ok(existsSync(new URL('sign-in.tsx', app)));
});

test('every root guard names its redirect', () => {
  // Without redirectTo a flipped guard redirects to the anchor, `/(tabs)` = `/`: Unmatched Route.
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  const guards = layout.match(/<Stack\.Protected\b[^>]*>/g) ?? [];
  assert.equal(guards.length, 2);
  for (const guard of guards) assert.match(guard, /redirectTo=\{(HOME|SIGN_IN)\}/);
});

/** The names in one of the layout's screen tables (`const NAME ... = [ ['name', 'Title'], ... ];`). */
function screenTable(layout: string, table: string): string[] {
  const body = layout.match(new RegExp(`const ${table}\\b[^=]*= \\[([\\s\\S]*?)\\];`))?.[1];
  assert.ok(body, `${table} not found in _layout.tsx`);
  return [...body.matchAll(/\[\s*'([^']+)'\s*,\s*'[^']*'\s*\]/g)].map(m => m[1]);
}

const routeExists = (name: string) => existsSync(new URL(`${name}.tsx`, app)) || existsSync(new URL(`${name}/_layout.tsx`, app));

test('every root screen the layout names has a route file', () => {
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  const literal = [...layout.matchAll(/<Stack\.Screen name="([^"]+)"/g)].map(m => m[1]);
  const pushed = screenTable(layout, 'PUSHED_SCREENS');
  const sheets = screenTable(layout, 'SHEET_SCREENS');
  for (const name of ['pull', 'changes', 'diff', 'computer/[device]', 'terminal', 'bot-admin']) assert.ok(pushed.includes(name), name);
  for (const name of ['rename', 'commit', 'new-pull']) assert.ok(sheets.includes(name), name);
  const names = [...literal, ...pushed, ...sheets];
  assert.equal(new Set(names).size, names.length, 'a screen is registered twice');
  for (const name of names) assert.ok(routeExists(name), name);
});

test('pushed screens keep the back button beside left header items', () => {
  // The Duo's sidebar toggle (HeaderActions) is a left item; without headerBackVisible it replaces
  // the back button on iOS (leftItemsSupplementBackButton) and Android (the navigation icon).
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  const pushed = layout.match(/const pushed = (\{.*\}) as const;/)?.[1];
  assert.ok(pushed, 'pushed options not found in _layout.tsx');
  // iOS only: on Android it would keep the navigation arrow beside a leading Cancel. Android leaves it
  // unset: expo-router maps a literal false to hideBackButton, which drops the arrow on every screen.
  assert.match(pushed, /\.\.\.\(Platform\.OS === 'ios' \? \{ headerBackVisible: true \} : \{\}\)/);
  assert.doesNotMatch(pushed, /headerBackVisible: (false|Platform\.OS)/);
  assert.match(layout, /PUSHED_SCREENS\.map\([^)]*\) => <Stack\.Screen [^>]*options=\{\{ \.\.\.pushed\b/);
  // No pushed screen turns it off again, except the file editor while Cancel leads its header.
  for (const name of ['pull', 'changes', 'diff', 'queue', 'servers', 'agents', 'progress']) {
    const file = readFileSync(new URL(`${name}.tsx`, app), 'utf8');
    assert.doesNotMatch(file, /headerBackVisible: false/, name);
  }
});

test('the task header keeps the back button beside the Duo\'s left items', () => {
  // The task screen sets its own options; its split-view sidebar toggle and New task are left items.
  const header = readFileSync(new URL('../ui/TaskHeader.tsx', app), 'utf8');
  const options = header.match(/const options = (\{[^;]*\}) as const;/)?.[1];
  assert.ok(options, 'options not found in TaskHeader.tsx');
  assert.match(options, /headerBackVisible: true/);
  assert.match(header, /<Stack\.Screen options=\{options\} \/>/);
  assert.match(header, /<Stack\.Screen options=\{\{ \.\.\.options,/);
});

test('the PUSHED_HEADER options screens spread never hide the back button', () => {
  const shared = readFileSync(new URL('../ui/PushedScroll.tsx', app), 'utf8');
  const header = shared.match(/export const PUSHED_HEADER = (\{[^}]*\})/)?.[1];
  assert.ok(header, 'PUSHED_HEADER not found');
  assert.doesNotMatch(header, /headerBackVisible: false/);
});

test('every sheet with header actions leads with Cancel (or Done when there is nothing to confirm)', () => {
  for (const name of ['rename', 'commit', 'new-pull', 'new-task', 'add-project', 'new-schedule', 'btw']) {
    const file = readFileSync(new URL(`${name}.tsx`, app), 'utf8');
    const headers = file.match(/<HeaderActions\b[^>]*\/>/g) ?? [];
    assert.ok(headers.length, name);
    for (const header of headers) assert.match(header, /left=\{\[(CANCEL|DONE)\]\}/, `${name}: ${header}`);
  }
});

test('guarded sheets leave only through JS on Android; iOS keeps the form sheet', () => {
  // react-native-screens' Android form sheet drags and taps closed natively, past usePreventRemove.
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  assert.match(layout, /const sheet = \{ presentation: 'formSheet',/);
  // Cancel/Done are the header's only way out of an Android modal: no back arrow beside them.
  assert.match(layout, /const androidModal = Platform\.OS === 'android' \? \{ presentation: 'modal', headerBackVisible: false \} as const : undefined;/);
  assert.match(layout, /const guardedSheet = \{ \.\.\.sheet, \.\.\.androidModal \};/);
  assert.match(layout, /SHEET_SCREENS\.map\([^\n]*options=\{\{ \.\.\.guardedSheet, sheetAllowedDetents: \[0\.6, 1\]/);
  // Task info guards its goal edit too: an iOS fitToContents sheet, an Android modal (spread last).
  assert.match(layout, /name="task-info" options=\{\{ \.\.\.sheet, sheetAllowedDetents: 'fitToContents'[^\n]*\.\.\.androidModal \}\}/);
  // Every SHEET_SCREENS sheet that guards a draft is covered by that one table.
  const sheets = screenTable(layout, 'SHEET_SCREENS');
  for (const name of ['rename', 'commit', 'new-pull', 'new-schedule', 'btw', 'add-project']) assert.ok(sheets.includes(name), name);
});
