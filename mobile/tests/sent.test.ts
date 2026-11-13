/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { delivering, MAX_RESENDS, sentLabel, settled, unconfirm, unconfirmedVerdict, undeliver, unmatched, withoutSent, type Sent } from '../src/store/sent.ts';

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

test('an unconfirmed prompt with no stored copy resolves once the task is idle', () => {
  const entry = unconfirm([s('a', 'hi', 1)], 'a')[0];
  const idle = { idle: true, dedupes: false, resendable: true, resent: 0 };
  assert.equal(unconfirmedVerdict(entry, { ...idle, idle: false }), 'keep', 'a running task settles it at its end');
  assert.equal(unconfirmedVerdict(undefined, idle), 'keep', 'gone (its copy turned up)');
  assert.equal(unconfirmedVerdict(s('b', 'hi', 1), idle), 'keep', 'not unconfirmed');
  assert.equal(unconfirmedVerdict(entry, idle), 'undelivered', 'a host without sendId dedupe: the user decides');
  assert.equal(unconfirmedVerdict(entry, { ...idle, dedupes: true }), 'resend', 'a deduping host gets it back under the same id');
  assert.equal(unconfirmedVerdict(entry, { ...idle, dedupes: true, resendable: false }), 'undelivered', 'steers and bot messages never go to the outbox');
  assert.equal(unconfirmedVerdict(entry, { ...idle, dedupes: true, resent: MAX_RESENDS }), 'undelivered', 'resent once already: the user decides');
});

test('a not-delivered bubble keeps through a run end until sent again or discarded', () => {
  const list = undeliver(unconfirm([s('a', 'hi', 1), s('b', 'other', 1)], 'a'), 'a');
  assert.equal(list[0].undelivered, true);
  assert.equal(list[0].unconfirmed, undefined);
  assert.equal(sentLabel(list[0]), 'Not delivered');
  assert.equal(list[1], list[1], 'others untouched');
  assert.equal(undeliver(list, 'b')[1].undelivered, undefined, 'only unconfirmed entries turn undelivered');
  assert.deepEqual(settled(list).map(e => e.id), ['a'], 'a run end keeps it');
  assert.deepEqual(unmatched(list, [m(2, 'user', 'hi')]).map(e => e.id), ['b'], 'its stored copy turning up still clears it');
  assert.deepEqual(withoutSent(list, 'a').map(e => e.id), ['b']);
});
