/// <reference types="node" />
// The iPhone Duo sidebar's navigation decision (src/ui/sidebar-nav.ts): picking a task never grows the
// stack, and the open task stays highlighted under any feature screen pushed over it.
import assert from 'node:assert/strict';
import test from 'node:test';
import { rootStack, runSidebarSteps, settles, sidebarOpen, sidebarSelection, sidebarSteps, TASK_ROUTE, type StackState } from '../src/ui/sidebar-nav.ts';

const tabs = { name: '(tabs)' };
const task = (device: string, session: string) => ({ name: TASK_ROUTE, params: { device, session } });
const stack = (...routes: StackState['routes']): StackState => ({ index: routes.length - 1, routes });

test('over the root a pick pushes the task', () => {
  assert.equal(sidebarOpen(stack(tabs)), 'push');
  assert.equal(sidebarOpen(undefined), 'push');
});

test('over the open task alone a pick replaces it', () => {
  assert.equal(sidebarOpen(stack(tabs, task('d', 'a'))), 'replace');
});

test('over a feature screen a pick goes back to the root first', () => {
  assert.equal(sidebarOpen(stack(tabs, task('d', 'a'), { name: 'changes' })), 'reset');
  assert.equal(sidebarOpen(stack(tabs, task('d', 'a'), { name: 'files' }, { name: 'file' })), 'reset');
  assert.equal(sidebarOpen(stack(tabs, { name: 'computer/[device]' })), 'reset');
  assert.equal(sidebarOpen(stack(tabs, task('d', 'a'), task('d', 'b'))), 'reset', 'a stack that already grew collapses');
});

test('routes past the focused index (being popped) do not count', () => {
  assert.equal(sidebarOpen({ index: 1, routes: [tabs, task('d', 'a'), { name: 'changes' }] }), 'replace');
});

test('the highlight is the nearest task under the focused screen', () => {
  assert.equal(sidebarSelection(stack(tabs)), '');
  assert.equal(sidebarSelection(stack(tabs, task('d', 'a'))), 'd/a');
  assert.equal(sidebarSelection(stack(tabs, task('d', 'a'), { name: 'changes', params: { device: 'd', session: 'x' } }, { name: 'diff' })), 'd/a');
  assert.equal(sidebarSelection(stack(tabs, task('d', 'a'), task('e', 'b'), { name: 'files' })), 'e/b');
  assert.equal(sidebarSelection(stack(tabs, { name: TASK_ROUTE })), '', 'a task route without params lights nothing');
});

test('the root Stack is found inside a wrapping container route', () => {
  const inner = stack(tabs, task('d', 'a'));
  assert.equal(rootStack({ index: 0, routes: [{ name: '__root', state: inner }] }), inner);
  assert.equal(rootStack(inner), inner);
  assert.equal(rootStack(undefined), undefined);
});

test('a pick turns into router calls: back to the root before pushing over a feature screen', () => {
  assert.deepEqual(sidebarSteps('push', false), ['push']);
  assert.deepEqual(sidebarSteps('replace', true), ['replace']);
  assert.deepEqual(sidebarSteps('reset', true), ['dismissAll', 'push']);
  assert.deepEqual(sidebarSteps('reset', false), ['replace'], 'nothing to dismiss: replace, never a growing push');
});

test('rows outside the sidebar (the inbox tab, search) keep pushing', () => {
  assert.deepEqual(sidebarSteps(undefined, true), ['push']);
  assert.deepEqual(sidebarSteps(undefined, false), ['push']);
});

/** A fake router recording its calls; `lands` is whether the dismiss goes through. */
function fakeRouter(lands: boolean) {
  const calls: string[] = [];
  return {
    calls,
    nav: { replace: () => void calls.push('replace'), dismissAll: () => void calls.push('dismissAll'), push: () => void calls.push('push'), dismissed: async () => lands },
  };
}

test('a pick pushes only once its dismiss landed', async () => {
  const { calls, nav } = fakeRouter(true);
  assert.equal(await runSidebarSteps(['dismissAll', 'push'], nav), true);
  assert.deepEqual(calls, ['dismissAll', 'push']);
});

test('a dismiss a discard guard prevented ends the pick without pushing over the dirty screen', async () => {
  const { calls, nav } = fakeRouter(false);
  assert.equal(await runSidebarSteps(['dismissAll', 'push'], nav), false);
  assert.deepEqual(calls, ['dismissAll']);
  const plain = fakeRouter(false);
  assert.equal(await runSidebarSteps(['replace'], plain.nav), true, 'no dismiss, nothing to wait for');
  assert.deepEqual(plain.calls, ['replace']);
});

/** A clock whose frames advance 16 ms each, run synchronously. */
function frames() {
  let now = 0;
  return { now: () => now, frame: (run: () => void) => { now += 16; run(); } };
}

test('settles waits frames for the stack and gives up after its window', async () => {
  let checks = 0;
  assert.equal(await settles(() => ++checks >= 3, 400, frames()), true);
  assert.equal(checks, 3);
  assert.equal(await settles(() => false, 400, frames()), false, 'still dismissable: prevented');
});
