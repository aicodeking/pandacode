/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { delivering, settled, unmatched, type Sent } from '../src/store/sent.ts';

const m = (id: number, role: string, content: string): Message => ({ id, role, content, createdAt: id, turnDurationMs: null });
const s = (id: string, text: string, after: number, state: Sent['state'] = 'sending'): Sent => ({ id, text, state, after });

test('a sent prompt shows until its stored copy arrives', () => {
  const sent = [s('a', ' fix the tests ', 3)];
  assert.deepEqual(unmatched(sent, [m(1, 'user', 'hi'), m(3, 'assistant', 'ok')]).map(e => e.id), ['a']);
  assert.deepEqual(unmatched(sent, [m(1, 'user', 'hi'), m(3, 'assistant', 'ok'), m(4, 'user', 'fix the tests')]), []);
});

test('only messages stored after the send count, and only user ones', () => {
  const sent = [s('a', 'again', 5)];
  assert.equal(unmatched(sent, [m(2, 'user', 'again'), m(6, 'assistant', 'again')]).length, 1);
});

test('the same text sent twice needs two copies, never duplicating or hiding one', () => {
  const sent = [s('a', 'go', 1), s('b', 'go', 1, 'queued')];
  assert.deepEqual(unmatched(sent, [m(2, 'user', 'go')]).map(e => e.id), ['b']);
  assert.deepEqual(unmatched(sent, [m(2, 'user', 'go'), m(5, 'user', 'go')]), []);
});

test('a copy with context appended still matches; a longer prompt does not', () => {
  assert.equal(unmatched([s('a', 'look', 0)], [m(1, 'user', 'look\n\nFile context: a.ts')]).length, 0);
  assert.equal(unmatched([s('a', 'look', 0)], [m(1, 'user', 'look closer')]).length, 1);
});

test('unchanged lists keep their identity for selectors', () => {
  const sent = [s('a', 'x', 0)];
  assert.equal(unmatched(sent, []), sent);
  assert.equal(settled([s('q', 'x', 0, 'queued')]).length, 1);
});

test('a new turn delivers the oldest queued entry; a run end keeps only queued ones', () => {
  const sent = [s('a', 'one', 0, 'steering'), s('b', 'two', 0, 'queued'), s('c', 'three', 0, 'queued')];
  assert.deepEqual(delivering(sent).map(e => e.state), ['steering', 'sending', 'queued']);
  assert.deepEqual(settled(delivering(sent)).map(e => e.id), ['c']);
});
