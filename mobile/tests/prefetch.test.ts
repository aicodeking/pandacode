/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import { FRESH_MS, PrefetchQueue, prefetchOrder } from '../src/store/prefetch.ts';

const task = (sessionId: string, status: TaskSummary['status'] = 'idle', lastId?: number): TaskSummary => ({
  sessionId, title: sessionId, status, projectId: 'p', projectName: 'p', provider: 'claude', model: 'm',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, ...(lastId === undefined ? {} : { lastId }),
});

test('running first, then waiting, then the most recent few, each once', () => {
  const lists = [
    { deviceId: 'a', tasks: [task('r1'), task('r2'), task('w', 'waiting'), task('r3'), task('r4'), task('r5'), task('r6')] },
    { deviceId: 'b', tasks: [task('x'), task('run', 'running')] },
  ];
  assert.deepEqual(prefetchOrder(lists, () => undefined, 0),
    ['b/run', 'a/w', 'a/r1', 'a/r2', 'a/r3', 'a/r4', 'b/x']);
});

test('threads already current are skipped', () => {
  const lists = [{ deviceId: 'a', tasks: [task('same', 'idle', 10), task('newer', 'idle', 12), task('nolist'), task('stale')] }];
  const known = (key: string) => ({ 'a/same': { lastId: 10, at: 0 }, 'a/newer': { lastId: 10, at: 1000 }, 'a/nolist': { lastId: 3, at: 1000 }, 'a/stale': { lastId: 3, at: 0 } })[key];
  assert.deepEqual(prefetchOrder(lists, known, 1000 + FRESH_MS - 1), ['a/newer', 'a/stale']);
});

const tick = () => new Promise(resolve => setImmediate(resolve));

test('the queue runs one at a time and holds while the user is busy', async () => {
  const ran: string[] = [];
  const finish: (() => void)[] = [];
  const queue = new PrefetchQueue(key => new Promise<void>(resolve => { ran.push(key); finish.push(resolve); }));
  queue.hold('thread');
  queue.replace(['a', 'b', 'c']);
  await tick();
  assert.deepEqual(ran, []);
  queue.release('thread');
  await tick();
  assert.deepEqual(ran, ['a']); // one call at a time
  queue.hold('send:1');
  finish.shift()!();
  await tick();
  assert.deepEqual(ran, ['a']); // held between calls, never mid-call
  queue.replace(['c', 'd']); // a newer list replaces what waited
  queue.release('send:1');
  await tick();
  assert.deepEqual(ran, ['a', 'c']);
  finish.shift()!();
  await tick();
  assert.deepEqual(ran, ['a', 'c', 'd']);
});

test('a failed prefetch moves on', async () => {
  const ran: string[] = [];
  const queue = new PrefetchQueue(async key => { ran.push(key); throw new Error('offline'); });
  queue.replace(['a', 'b']);
  await tick(); await tick(); await tick();
  assert.deepEqual(ran, ['a', 'b']);
});
