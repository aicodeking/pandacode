/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { legacy, parseHello, withMissing } from '../src/connect/api/hello.ts';
import { gatedPress, menuGate } from '../src/ui/menu-gate.ts';

const hello = (extra: Record<string, unknown>) =>
  parseHello({ protocol: 2, appVersion: '0.4.0', methods: ['thread.rename', 'thread.archive', 'terminal.list'], ...extra })!;

test('an item shows with no note while the host is unknown, legacy or allows it', () => {
  assert.deepEqual(menuGate(undefined, 'thread.rename', 'Mac'), { shown: true, note: null });
  assert.deepEqual(menuGate(hello({ access: 'full', features: ['remoteFullAccess'] }), 'thread.rename', 'Mac'), { shown: true, note: null });
});

test('an item hides only when the computer lacks the method', () => {
  assert.equal(menuGate(hello({ access: 'full' }), 'thread.delete', 'Mac').shown, false);
  assert.equal(menuGate(withMissing(legacy(), 'thread.rename'), 'thread.rename', 'Mac').shown, false);
});

test('a narrow grant or the Full access switch keeps the item, with the access note', () => {
  const view = menuGate(hello({ access: 'view', methodAccess: { 'thread.rename': 'control' } }), 'thread.rename', 'Mac');
  assert.equal(view.shown, true);
  assert.match(view.note ?? '', /^Needs Control access/);
  const off = menuGate(hello({ access: 'full', methodAccess: { 'terminal.list': 'full' } }), 'terminal.list', 'Mac');
  assert.deepEqual(off, { shown: true, note: 'Turn on Full access for remote tasks on Mac.' });
});

test('a blocked press explains instead of running', () => {
  const calls: string[] = [];
  const run = () => calls.push('run');
  const explain = (note: string) => calls.push(note);
  gatedPress({ shown: true, note: null }, run, explain)();
  gatedPress({ shown: true, note: 'Needs Full access' }, run, explain)();
  assert.deepEqual(calls, ['run', 'Needs Full access']);
});
