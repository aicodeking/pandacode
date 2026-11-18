/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { newestPage, olderByAfterId, workerNewer, workerNewest, workerOlder } from '../src/connect/paging.ts';
import { OFFLINE } from '../src/connect/rpc.ts';
import type { Message, MessagePage } from '../src/connect/types.ts';

const msg = (id: number): Message => ({ id, role: 'assistant', content: `m${id}`, createdAt: id, turnDurationMs: null });
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, n) => msg(from + n));

/** An older host: ignores tail/beforeId and pages by afterId, 3 at a time, over ids 1..10. */
const oldHost = (calls: object[]) => async (params: any): Promise<MessagePage> => {
  calls.push(params);
  const after = params.afterId ?? 0;
  const messages = range(after + 1, Math.min(after + 3, 10));
  return { messages, hasMore: after + 3 < 10, title: 't' };
};

test('a newer host answers tail pages with hasOlder', async () => {
  const legacy = new Set<string>();
  const page = { messages: range(8, 10), hasMore: false, hasOlder: true, lastId: 10, title: 't' };
  const result = await newestPage(async () => page, 'mac', legacy, { tail: true, limit: 60 });
  assert.deepEqual(result, { page, legacy: false });
  assert.equal(legacy.size, 0);
});

test('a host that ignores tail is remembered, and its afterId-0 answer is kept', async () => {
  const legacy = new Set<string>();
  const calls: object[] = [];
  const result = await newestPage(oldHost(calls), 'mac', legacy, { tail: true, limit: 60 });
  assert.equal(result.legacy, true);
  assert.deepEqual(result.page?.messages.map(m => m.id), [1, 2, 3]);
  assert.ok(legacy.has('mac'));
  // Asked again: no call at all.
  assert.deepEqual(await newestPage(oldHost(calls), 'mac', legacy, { tail: true }), { page: null, legacy: true });
  assert.equal(calls.length, 1);
});

test('a host that refuses the params falls back; a network failure does not', async () => {
  const legacy = new Set<string>();
  const refused = await newestPage(async () => { throw new Error('Unknown field `tail`.'); }, 'old', legacy, { tail: true });
  assert.deepEqual(refused, { page: null, legacy: true });
  await assert.rejects(newestPage(async () => { throw new Error(OFFLINE); }, 'mac', legacy, { tail: true }), { message: OFFLINE });
  assert.ok(!legacy.has('mac'));
});

test('older history from an older host pages forward up to the first message held', async () => {
  const calls: any[] = [];
  const fetch = oldHost(calls);
  const older = await olderByAfterId(fetch, 8, await fetch({ beforeId: 8 }), 50);
  assert.deepEqual(older.map(m => m.id), [1, 2, 3, 4, 5, 6, 7]);
  assert.deepEqual(calls.map(c => c.afterId ?? 0), [0, 3, 6]);
});

/** A newer host's task.workerMessages over ids 1..`total`, 3 rows a page. */
const workerHost = (total: number, calls: object[] = []) => async (params: any): Promise<MessagePage> => {
  calls.push(params);
  if (params.tail || params.beforeId) {
    const end = params.tail ? total : params.beforeId - 1;
    const start = Math.max(1, end - 2);
    return { messages: range(start, end), hasMore: end < total, hasOlder: start > 1, tail: true, title: 't' };
  }
  const after = params.afterId ?? 0;
  const end = Math.min(after + 3, total);
  return { messages: range(after + 1, end), hasMore: end < total, hasOlder: after > 0, title: 't' };
};

test('a worker opens on its newest rows in one call, however long its transcript', async () => {
  const calls: object[] = [];
  const page = await workerNewest(workerHost(1_000_000, calls), 50);
  assert.deepEqual(page.messages.map(m => m.id), [999_998, 999_999, 1_000_000]);
  assert.deepEqual([page.hasOlder, page.hasMore], [true, false]);
  assert.deepEqual(calls, [{ tail: true }]);
});

test('older worker pages walk back to the first message', async () => {
  const fetch = workerHost(5);
  const page = await workerOlder(fetch, 4);
  assert.deepEqual(page.messages.map(m => m.id), [1, 2, 3]);
  assert.equal(page.hasOlder, false);
});

test('a refresh reads every newer worker row forward', async () => {
  const page = await workerNewer(workerHost(10), 3, 50);
  assert.deepEqual(page.messages.map(m => m.id), [4, 5, 6, 7, 8, 9, 10]);
  assert.equal(page.hasMore, false);
});

test('an older host is read forward from the start and offers no older pages', async () => {
  const calls: object[] = [];
  const page = await workerNewest(oldHost(calls), 50);
  assert.deepEqual(page.messages.map(m => m.id), range(1, 10).map(m => m.id));
  assert.deepEqual([page.hasOlder, page.hasMore], [false, false]);
  assert.deepEqual(calls.slice(0, 2), [{ tail: true }, { afterId: 3 }]);
  assert.deepEqual((await workerOlder(oldHost([]), 5)).messages, []);
});

test('an older host past the page cap reports the rows it left unread', async () => {
  const page = await workerNewest(oldHost([]), 2);
  assert.deepEqual(page.messages.map(m => m.id), [1, 2, 3, 4, 5, 6]);
  assert.equal(page.hasMore, true);
});
