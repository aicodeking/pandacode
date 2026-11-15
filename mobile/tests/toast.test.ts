/// <reference types="node" />
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { dismissal, fallbackClearance, tabBarClearance, toastClearance, toastDuration } from '../src/ui/ds/toast-clearance.ts';

test('the tab bar clearance is the tab controller’s bottom inset over the window’s', () => {
  assert.equal(tabBarClearance(83, 34), 49, 'iPhone tab bar over the home indicator');
  assert.equal(tabBarClearance(34, 34), 0, 'the Duo rail: no bottom bar');
  assert.equal(tabBarClearance(20, 34), 0, 'never negative');
  assert.equal(tabBarClearance(Number.NaN, 34), 0);
});

test('a measured 0 (the Duo rail) wins over the fallback', () => {
  assert.equal(toastClearance({ 1: tabBarClearance(34, 34) }, 64), 0);
});

test('the fallback is fixed only off the Duo rail', () => {
  assert.equal(fallbackClearance(false, 64), 64);
  assert.equal(fallbackClearance(true, 64), 0);
});

test('hiding a toast by id leaves a newer one alone and dismisses only the one it hides', () => {
  const preparing = { id: 1 };
  const truncated = { id: 2 };
  assert.deepEqual(dismissal(truncated, preparing.id), { next: truncated, gone: null }, 'stale id: nothing hidden');
  assert.deepEqual(dismissal(preparing, preparing.id), { next: null, gone: preparing });
  assert.deepEqual(dismissal(truncated), { next: null, gone: truncated }, 'no id hides whatever shows');
  assert.deepEqual(dismissal(null, 1), { next: null, gone: null });
});

test('a sticky toast never times out; others stay longer with a screen reader', () => {
  assert.equal(toastDuration(true, false, 6000, 10_000), null);
  assert.equal(toastDuration(true, true, 6000, 10_000), null);
  assert.equal(toastDuration(false, false, 6000, 10_000), 6000);
  assert.equal(toastDuration(undefined, true, 6000, 10_000), 10_000);
});

const source = (path: string) => readFileSync(new URL(`../src/${path}`, import.meta.url), 'utf8');

test('an Undo toast commits on its dismissal, not on a fixed timer a screen reader outlasts', () => {
  const toast = source('ui/ds/Toast.tsx');
  assert.match(toast, /onDismiss\?: \(\) => void;/);
  // Timed out, replaced or hidden: onDismiss runs; the action's tap clears it without.
  assert.match(toast, /const timer = setTimeout\(\(\) => hideToast\(toast\.id\), ms\);/);
  assert.match(toast, /gone\?\.onDismiss\?\.\(\);/);
  assert.match(toast, /onPress: \(\) => \{ if \(toast\) acted\(toast\.id\); action\.onPress\(\); \}/);
  const bot = source('app/bot-admin.tsx');
  assert.doesNotMatch(bot, /TOAST_MS/);
  assert.match(bot, /onDismiss: \(\) => commit\(id\)/);
  // A replaced toast's dismissal commits only its own forget, never the next one's.
  assert.match(bot, /if \(!forgetting \|\| \(id !== undefined && id !== forgetting\)\) return;/);
  for (const path of ['app/queue.tsx', 'ui/TaskHeader.tsx']) assert.doesNotMatch(source(path), /TOAST_MS/, path);
});

test('pushed pages without a dock register no tab bar allowance for toasts', () => {
  const pushed = source('ui/PushedScroll.tsx');
  assert.equal(pushed.match(/useNoDockClearance\(\);/g)?.length, 2, 'PushedScroll and PushedList');
  assert.match(source('ui/ds/Toast.tsx'), /export function useNoDockClearance\(\): void \{\n {2}useRegisteredClearance\(0\);/);
  // A screen's own dock is taller, so it still wins.
  assert.equal(toastClearance({ 1: 0, 2: 88 }, 64), 88);
  assert.equal(toastClearance({ 1: 0 }, 64), 0);
});

test('the export toast stays while loading and hides only itself', () => {
  const header = source('ui/TaskHeader.tsx');
  assert.match(header, /const preparing = showToast\(\{ title: 'Preparing export…', icon: EXPORT_ICON, sticky: true \}\);/);
  assert.match(header, /hideToast\(preparing\)/);
  assert.doesNotMatch(header, /hideToast\(\)/);
  assert.match(header, /await file\.write\(markdown\);/);
  assert.doesNotMatch(header, /file\.create\(\)/);
});

test('closing bot settings hides its Undo toast and sends the waiting forget once', () => {
  const bot = source('app/bot-admin.tsx');
  assert.match(bot, /toastId\.current = showToast\(\{ title: 'Memory forgotten'/);
  // The root ToastHost outlives the screen: the cleanup hides the toast before committing.
  const cleanup = bot.match(/useEffect\(\(\) => \(\) => \{([\s\S]*?)\}, \[commit\]\);/)?.[1] ?? '';
  assert.ok(cleanup.indexOf('hideToast(toast)') >= 0, 'hides the toast');
  assert.ok(cleanup.indexOf('hideToast(toast)') < cleanup.indexOf('commit()'), 'before committing');
  // hideToast runs onDismiss -> commit(id), which clears `pending`; the cleanup's commit() then finds nothing.
  assert.match(bot, /pending\.current = null;\n {4}forgetForBot\(/);
});

test('an iOS export is deleted after sharing, and sign-out clears cache/exports', () => {
  const header = source('ui/TaskHeader.tsx');
  assert.match(header, /await Share\.share\(\{ title: name, url: file\.uri \}\);\n {4}\} finally \{[\s\S]*?try \{ file\.delete\(\); \} catch/);
  const local = source('store/local.ts');
  assert.match(local, /new Directory\(Paths\.cache, 'exports'\)/);
  assert.match(local, /export async function clearLocal\(\): Promise<void> \{[\s\S]*?clearExports\(\);/);
});
