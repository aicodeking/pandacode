/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { newestPage, olderByAfterId } from '../src/connect/paging.ts';
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
