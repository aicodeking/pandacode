/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { mergeMessages, prependMessages } from '../src/store/reduce.ts';
import { CACHE_MESSAGES, decodeThread, encodeThread, evict, fileName, parseIndex, THREAD_BYTES, touch } from '../src/store/thread-cache.ts';

const msg = (id: number, content = `m${id}`): Message => ({ id, role: id % 2 ? 'user' : 'assistant', content, createdAt: id, turnDurationMs: null });
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, n) => msg(from + n));

test('a thread keeps its newest messages and says when older ones were cut', () => {
  const small = decodeThread(encodeThread(range(1, 10), false))!;
  assert.deepEqual(small.messages.map(m => m.id), range(1, 10).map(m => m.id));
  assert.equal(small.hasOlder, false);
  assert.equal(decodeThread(encodeThread(range(1, 10), true))!.hasOlder, true);
  const long = decodeThread(encodeThread(range(1, 500), false))!;
  assert.equal(long.messages.length, CACHE_MESSAGES);
  assert.equal(long.messages.at(-1)!.id, 500);
  assert.equal(long.hasOlder, true);
});

test('a thread file stays under its byte cap, newest message kept', () => {
  const big = range(1, 50).map(m => ({ ...m, content: 'x'.repeat(40_000) }));
  const text = encodeThread(big, false);
  assert.ok(text.length <= THREAD_BYTES);
  const thread = decodeThread(text)!;
  assert.equal(thread.messages.at(-1)!.id, 50);
  assert.equal(thread.hasOlder, true);
});

test('only sane files decode', () => {
  for (const bad of [null, '', 'nope', '{}', '{"messages":[]}', JSON.stringify({ messages: [msg(2), msg(1)] }), JSON.stringify({ messages: [{ id: 'x' }] })]) assert.equal(decodeThread(bad), null);
});

test('cached window merges with fetched pages: delta after, older before, overlaps skipped', () => {
  const cached = decodeThread(encodeThread(range(100, 120), true))!.messages;
  const delta = mergeMessages(cached, range(118, 125));
  assert.deepEqual([delta[0].id, delta.at(-1)!.id, delta.length], [100, 125, 26]);
  const older = prependMessages(delta, range(90, 101));
  assert.deepEqual([older[0].id, older.at(-1)!.id, older.length], [90, 125, 36]);
  assert.equal(prependMessages(older, range(95, 99)), older);
  assert.equal(mergeMessages(older, []), older);
});

test('the cache drops the least recently used threads past its cap', () => {
  let index = touch({}, 'd/a', { at: 1, bytes: 400, lastId: 5 });
  index = touch(index, 'd/b', { at: 3, bytes: 400, lastId: 9 });
  index = touch(index, 'd/c', { at: 2, bytes: 400, lastId: 7 });
  index = touch(index, 'd/a', { at: 4 }); // reopened: now the newest
  assert.equal(index['d/a'].bytes, 400);
  const { index: kept, drop } = evict(index, 900);
  assert.deepEqual(Object.keys(kept).sort(), ['d/a', 'd/b']);
  assert.deepEqual(drop, [fileName('d/c')]);
  assert.deepEqual(evict(index, 10_000).drop, []);
});

test('the index file is checked entry by entry; names hide ids', () => {
  const index = touch({}, 'dev/sess', { at: 1, bytes: 2, lastId: 3 });
  assert.deepEqual(parseIndex(JSON.stringify(index)), index);
  assert.deepEqual(parseIndex(JSON.stringify({ 'dev/x': { file: '../../etc', at: 1, bytes: 1, lastId: 1 } })), {});
  assert.deepEqual(parseIndex('[]'), {});
  assert.match(fileName('dev/sess'), /^[0-9a-f]{32}\.json$/);
});
