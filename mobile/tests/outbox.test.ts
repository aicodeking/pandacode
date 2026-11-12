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

test('with sendId dedupe a lost reply leaves the entry queued for the next flush', async () => {
  const entries = [e('a', 'mac', 's1', 1), e('b', 'mac', 's1', 2), e('c', 'old', 's2', 3)];
  const send = async (entry: OutboxEntry) => { if (entry.id === 'a' || entry.id === 'c') throw new Error(LOST); };
  const result = await flush(entries, { online: () => true, send, idempotent: id => id === 'mac' });
  assert.deepEqual(result, { sent: [], failed: { c: LOST } }, 'mac retries a and b later; old cannot dedupe, so c is reported');
  assert.deepEqual(applyFlush(entries, result).map(x => [x.id, x.error ?? '']), [['a', ''], ['b', ''], ['c', LOST]]);
});

test('stored image entries keep uris only; malformed images drop the entry rather than send without them', () => {
  const images = [{ uri: 'file:///a.png', name: 'a.png' }];
  const parsed = parseOutbox(JSON.stringify([
    e('a', 'm', 's', 1, { images: [{ uri: 'file:///a.png', name: 'a.png', base64: 'AAAA' } as never] }),
    e('b', 'm', 's', 2, { images: [{ uri: 7 } as never] }),
    e('c', 'm', 's', 3, { images: [] }),
    e('d', 'm', 's', 4),
  ]));
  assert.deepEqual(parsed.map(x => [x.id, x.images]), [['a', images], ['c', undefined], ['d', undefined]]);
});

test('an entry whose image is gone is reported with its error and holds its task', async () => {
  const gone = 'An image in this message is no longer on this phone. Attach it again and send.';
  const entries = [e('a', 'mac', 's1', 1, { images: [{ uri: 'file:///x.png', name: 'x.png' }] }), e('b', 'mac', 's1', 2)];
  const result = await flush(entries, { online: () => true, send: async entry => { if (entry.images) throw new Error(gone); } });
  assert.deepEqual(result, { sent: [], failed: { a: gone } });
});

test('an unconfirmed send handed back to the outbox goes out under its own sendId, behind older entries', async () => {
  // local.ts's requeue keeps the bubble's id: a deduping host answers a copy that did run from memory.
  const entries = [e('older', 'mac', 's1', 1), e('unconfirmed-id', 'mac', 's1', 5)];
  const ids: string[] = [];
  const result = await flush(entries, { online: () => true, send: async entry => { ids.push(entry.id); }, idempotent: () => true });
  assert.deepEqual(ids, ['older', 'unconfirmed-id']);
  assert.deepEqual(applyFlush(entries, result), []);
  const local = (await import('node:fs')).readFileSync(new URL('../src/store/local.ts', import.meta.url), 'utf8');
  assert.match(local, /connect\.onRequeue\(\(\{ id, deviceId, sessionId, text, images \}\) => \{/);
  assert.match(local, /const entry: OutboxEntry = \{ id, deviceId/);
});
