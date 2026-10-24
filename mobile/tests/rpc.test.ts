/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { Pending, Replay, request } from '../src/connect/rpc.ts';

test('requests carry id, ts and a fresh printable nonce', () => {
  const a = request('task.send', { sessionId: 's', text: 'hi' }, 1000);
  const b = request('task.send', { sessionId: 's', text: 'hi' }, 1000);
  assert.deepEqual(Object.keys(a).sort(), ['id', 'method', 'nonce', 'params', 'ts', 'type']);
  assert.equal(a.type, 'req');
  assert.equal(a.ts, 1000);
  assert.match(a.nonce, /^[0-9a-f]{32}$/);
  assert.notEqual(a.nonce, b.nonce);
  assert.notEqual(a.id, b.id);
  assert.throws(() => request('nope' as never, {}));
  assert.throws(() => request('task.send', { text: 'x'.repeat(120 * 1024) }), /too large/);
});

test('responses settle only from the device asked; undeliverable fails by ref or device', async () => {
  const pending = new Pending();
  const ok = pending.wait('host', 'r1', 1000);
  pending.resolve('intruder', { id: 'r1', ok: true, result: 'evil' });
  pending.resolve('host', { id: 'r1', ok: true, result: { sessionId: 'x' } });
  assert.deepEqual(await ok, { sessionId: 'x' });

  const refused = pending.wait('host', 'r2', 1000);
  pending.resolve('host', { id: 'r2', ok: false, error: 'Remote control is off on this computer' });
  await assert.rejects(refused, /Remote control is off/);

  const one = pending.wait('host', 'a', 1000);
  const two = pending.wait('host', 'b', 1000);
  const other = pending.wait('other', 'c', 1000);
  pending.fail('host', 'a', 'offline');
  await assert.rejects(one, /offline/);
  assert.equal(pending.size, 2);
  pending.fail('host', undefined, 'offline');
  await assert.rejects(two, /offline/);
  pending.failAll('lost');
  await assert.rejects(other, /lost/);
  assert.equal(pending.size, 0);

  await assert.rejects(pending.wait('host', 't', 5), /did not answer in time/);
  assert.equal(pending.size, 0);
});

test('replies and events are accepted once, inside the window, only with ts and nonce', () => {
  const replay = new Replay();
  const now = 1_000_000_000;
  const nonce = '0123456789abcdef0123456789abcdef';
  assert.equal(replay.check(now - 1000, nonce, now), true);
  assert.equal(replay.check(now - 1000, nonce, now + 10), false, 'repeated');
  assert.equal(replay.check(now - 60_001, 'fresh-nonce-000001', now), false, 'too old');
  assert.equal(replay.check(now + 60_001, 'fresh-nonce-000002', now), false, 'too new');
  assert.equal(replay.check(undefined, 'fresh-nonce-000003', now), false, 'an older host without ts');
  assert.equal(replay.check(now, undefined, now), false);
  assert.equal(replay.check(now, 'short', now), false);
  // Pruned once its ts leaves the window.
  assert.equal(replay.check(now + 61_500, 'fresh-nonce-000004', now + 61_500), true);
});
