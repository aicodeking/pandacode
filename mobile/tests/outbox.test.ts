/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { LOST, NOT_CONNECTED, OFFLINE } from '../src/connect/rpc.ts';
import { applyFlush, flush, isUnsent, parseOutbox, type OutboxEntry } from '../src/store/outbox.ts';

const e = (id: string, deviceId: string, sessionId: string, createdAt: number, extra: Partial<OutboxEntry> = {}): OutboxEntry =>
  ({ id, deviceId, sessionId, text: id, createdAt, ...extra });

test('only errors where the host never got the message count as unsent', () => {
  assert.ok(isUnsent(new Error(OFFLINE)));
  assert.ok(isUnsent(new Error(NOT_CONNECTED)));
  assert.ok(!isUnsent(new Error(LOST)));
  assert.ok(!isUnsent(new Error('That computer did not answer in time.')));
});

test('flush sends oldest first and stops a computer at its first offline error', async () => {
  const sent: string[] = [];
  const entries = [e('b', 'mac', 's1', 2), e('a', 'mac', 's1', 1), e('c', 'pc', 's2', 3), e('d', 'pc', 's2', 4), e('z', 'off', 's3', 0)];
  const result = await flush(entries, {
    online: id => id !== 'off',
    send: async entry => { if (entry.id === 'c') throw new Error(OFFLINE); sent.push(entry.id); },
  });
  assert.deepEqual(sent, ['a', 'b']);
  assert.deepEqual(result, { sent: ['a', 'b'], failed: {} });
  assert.deepEqual(applyFlush(entries, result).map(x => x.id), ['c', 'd', 'z']);
});

test('a refused message keeps its error and holds the rest of its task', async () => {
  const entries = [e('a', 'mac', 's1', 1), e('b', 'mac', 's1', 2), e('c', 'mac', 's2', 3), e('d', 'mac', 's3', 4, { error: 'old' }), e('f', 'mac', 's3', 5)];
  const result = await flush(entries, { online: () => true, send: async entry => { if (entry.id === 'a') throw new Error('No such task.'); } });
  assert.deepEqual(result, { sent: ['c'], failed: { a: 'No such task.' } });
  const next = applyFlush(entries, result);
  assert.deepEqual(next.map(x => [x.id, x.error ?? '']), [['a', 'No such task.'], ['b', ''], ['d', 'old'], ['f', '']]);
  assert.equal(entries[0].error, undefined); // not mutated
});

test('stored outboxes are validated', () => {
  assert.deepEqual(parseOutbox('not json'), []);
  assert.deepEqual(parseOutbox('{"a":1}'), []);
  assert.deepEqual(parseOutbox(JSON.stringify([e('a', 'm', 's', 1), { id: 1 }, null])).map(x => x.id), ['a']);
});
