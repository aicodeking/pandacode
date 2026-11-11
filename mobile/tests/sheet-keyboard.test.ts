/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { guardedFormSheet, sheetKeyboardPadding, TASK_INFO_DETENTS, FEATURE_SHEET_DETENTS } from '../src/ui/sheet-keyboard.ts';

const app = new URL('../src/app/', import.meta.url);

test('guarded routes are form sheets on iOS and modals on Android', () => {
  assert.equal(guardedFormSheet('ios'), true);
  assert.equal(guardedFormSheet('android'), false);
});

test('Task info pads for the keyboard itself on Android, where it is a modal; iOS unchanged', () => {
  const padding = (os: string) => sheetKeyboardPadding(os, TASK_INFO_DETENTS, guardedFormSheet(os));
  assert.equal(padding('android'), true, 'a modal is not lifted natively');
  assert.equal(padding('ios'), true);
  // A real Android fitToContents form sheet still leaves the lift to react-native-screens.
  assert.equal(sheetKeyboardPadding('android', TASK_INFO_DETENTS), false);
  assert.equal(sheetKeyboardPadding('android', TASK_INFO_DETENTS, true), false);
  for (const os of ['ios', 'android']) assert.equal(sheetKeyboardPadding(os, FEATURE_SHEET_DETENTS, guardedFormSheet(os)), true);
});

test('Task info passes its Android presentation to the keyboard rule, matching the layout', () => {
  const layout = readFileSync(new URL('_layout.tsx', app), 'utf8');
  assert.match(layout, /name="task-info" options=\{\{[^\n]*\.\.\.androidModal \}\}/);
  const info = readFileSync(new URL('task-info.tsx', app), 'utf8');
  assert.match(info, /sheetKeyboardPadding\(Platform\.OS, TASK_INFO_DETENTS, guardedFormSheet\(Platform\.OS\)\)/);
  assert.match(info, /<KeyboardAwareScrollView enabled=\{SHEET_KEYBOARD\}/);
});
