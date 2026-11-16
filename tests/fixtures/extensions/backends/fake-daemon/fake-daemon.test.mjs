import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { createDaemon } from '../core/fake-daemon.mjs';
import { writeFile } from 'node:fs/promises';
import { control, evidence, program, tcp } from '../test-support.mjs';

test('B1 pure core computes ready/blocked, revisions, signal acknowledgements and reset', () => {
  let clock = 42; const events = [];
  const state = createDaemon({ now: () => clock, emit: (...value) => events.push(value) });
  const a = state.request('issues.create', { title: 'first' });
  const b = state.request('issues.create', { title: 'second' });
  state.request('deps.add', { id: b.id, dependsOn: a.id });
  assert.deepEqual(state.snapshot().readyIds, [a.id]); assert.deepEqual(state.snapshot().blockedIds, [b.id]);
  assert.throws(() => state.request('issues.update', { id: a.id, patch: { title: 'stale' }, ifRevision: 0 }), { code: 'Conflict' });
  const closed = state.request('issues.close', { id: a.id, reason: 'finished' });
  state.request('comments.add', { id: a.id, text: 'changed after close' });
  assert.throws(() => state.request('issues.reopen', { id: a.id, ifRevision: closed.revision }), { code: 'Conflict' });
  assert.deepEqual(state.snapshot().readyIds, [b.id]);
  state.request('deps.remove', { id: b.id, dependsOn: a.id });
  assert.equal(state.request('issues.claim', { id: b.id, actor: 'tester' }).status, 'in_progress');
  assert.equal(state.request('issues.reopen', { id: a.id }).status, 'open');
  assert.equal(state.request('issues.update', { id: a.id, patch: { title: 'edited' } }).title, 'edited');
  assert.equal(state.request('issues.get', { id: a.id }).comments[0].text, 'changed after close');
  const signal = state.control('signal', { name: 'retry', payload: { n: 1 } });
  assert.deepEqual(state.request('ack', { signal: signal.id }), { acknowledged: signal.id });
  state.control('machine', { id: 'm' });
  state.control('metrics/script', { machine: 'm', samples: [{ cpu: 10, mem: 20 }, { cpu: 30, mem: 40 }] });
  assert.equal(state.sample('m').cpu, 10); clock = 43; assert.equal(state.sample('m').cpu, 30);
  assert.equal(state.request('metrics.history', { machine: 'm', sinceMs: 43 }).length, 1);
  assert(events.some(([topic]) => topic === 'signals'));
  state.control('reset'); assert.equal(state.snapshot().issues.length, 0);
});

test('B1 TCP/HTTP protocols, events, UTF-8 chunks and request log', async t => {
  const child = program(t, './fake-daemon/fake-daemon.mjs'), ready = await child.out.next(x => x.ready);
  assert.match(ready.socket, /^127\.0\.0\.1:\d+$/);
  const client = await tcp(t, ready.socket);
  assert.equal((await client.request('hello')).result.version, 1);
  assert.equal((await client.request('nope')).error.code, 'UnknownOp');
  await client.request('subscribe', { topic: 'signals' });
  await control(ready.control, 'signal', { name: 'retry', payload: 'canary' });
  assert.equal((await client.frames.next(x => x.event === 'signal')).data.name, 'retry');
  await client.request('subscribe', { topic: 'issues' });
  const added = await control(ready.control, 'issues', { op: 'add', issue: { id: 'T-z', title: 'UTF-8 🐼' } });
  assert(added.revision > 0);
  assert.deepEqual((await client.frames.next(x => x.event === 'issues.changed')).data.ids, ['T-z']);
  await control(ready.control, 'issues', { op: 'update', issue: { id: 'T-z', title: 'updated' } });
  assert.equal((await client.request('issues.get', { id: 'T-z' })).result.title, 'updated');
  await control(ready.control, 'issues', { op: 'remove', issue: { id: 'T-z' } });
  assert.equal((await client.request('issues.get', { id: 'T-z' })).error.code, 'NotFound');
  // Large transfer on a fresh client avoids retaining 2,000 irrelevant change events.
  client.socket.destroy();
  await control(ready.control, 'issues/fill', { count: 2000 });
  await control(ready.control, 'issues', { op: 'update', issue: { id: 'T-1', title: '🐼'.repeat(300) } });
  const large = await tcp(t, ready.socket), descriptor = (await large.request('issues.snapshot')).result;
  assert(descriptor.chunks > 1);
  const chunks = [];
  for (let index = 0; index < descriptor.chunks; index++) {
    const frame = await large.request('issues.chunk', { transfer: descriptor.transfer, index });
    assert(Buffer.byteLength(JSON.stringify(frame)) <= 65536); chunks.push(frame.result.text);
  }
  const snapshot = JSON.parse(chunks.join(''));
  assert.equal(snapshot.issues.length, 2000); assert.equal(snapshot.issues[0].title, '🐼'.repeat(300));
  assert.equal((await large.request('issues.create', { title: 'new unique issue' })).result.id, 'T-2001');
  const log = await (await fetch(`${ready.control}/control/log`)).json();
  assert(log.some(x => x.request?.op === 'issues.chunk')); assert(log.some(x => x.headers?.['content-type'] === 'application/json'));
  await control(ready.control, 'reset');
  assert.equal((await large.request('issues.snapshot')).result.issues.length, 0);
  await control(ready.control, 'issues', { op: 'add', issue: { id: 'huge', title: '🐼'.repeat(17000) } });
  assert.equal((await large.request('issues.get', { id: 'huge' })).error.code, 'FrameTooLarge');
  assert((await large.request('issues.snapshot')).result.chunks > 1);
  await control(ready.control, 'shutdown'); assert.equal((await child.exited).code, 0);
});

test('B1 metric interval changes, scripts, history and offline events', async t => {
  const child = program(t, './fake-daemon/fake-daemon.mjs'), ready = await child.out.next(x => x.ready), client = await tcp(t, ready.socket);
  await control(ready.control, 'machine', { id: 'a', online: true });
  await control(ready.control, 'machine', { id: 'b', online: true });
  await control(ready.control, 'metrics/script', { machine: 'a', samples: [{ cpu: 20, mem: 30 }, { cpu: 90, mem: 95 }] });
  await control(ready.control, 'metrics', { machine: 'b', cpu: 5, mem: 6 });
  await client.request('subscribe', { topic: 'metrics', intervalMs: 100 });
  assert.equal((await client.frames.next(x => x.event === 'metrics.sample' && x.data.machine === 'a')).data.cpu, 20);
  assert.equal((await client.frames.next(x => x.event === 'metrics.sample' && x.data.machine === 'a')).data.cpu, 90);
  assert((await client.request('metrics.history', { machine: 'a', sinceMs: 0 })).result.length >= 2);
  assert.equal((await client.request('subscribe', { topic: 'metrics', intervalMs: 99 })).ok, false);
  assert.equal((await client.request('subscribe', { topic: 'metrics', intervalMs: 60000 })).ok, true);
  const log = await (await fetch(`${ready.control}/control/log`)).json();
  assert(log.some(x => x.request?.params?.intervalMs === 60000));
  await control(ready.control, 'machine', { id: 'a', online: false });
  assert.equal((await client.frames.next(x => x.event === 'metrics.machine' && x.data.id === 'a')).data.online, false);
  assert.equal((await client.request('metrics.machines')).result.length, 2);
});

test('B1 faults, bounded frame rejection, EOF and termination leave no listener', async t => {
  const child = program(t, './fake-daemon/fake-daemon.mjs'), ready = await child.out.next(x => x.ready);
  const client = await tcp(t, ready.socket);
  await control(ready.control, 'fault', { kind: 'garbage' });
  assert((await client.frames.next(x => x.invalid)).invalid);
  await control(ready.control, 'fault', { kind: 'stall', ms: 120 });
  client.socket.write('{"id":99,"op":"hello"}\n'); await delay(160);
  assert(!client.frames.values.some(x => x.id === 99)); assert.equal((await client.request('hello')).ok, true);
  const dropped = once(client.socket, 'close'); await control(ready.control, 'fault', { kind: 'drop' }); await dropped;
  await control(ready.control, 'fault', { kind: 'refuse', ms: 120 });
  const refused = await tcp(t, ready.socket); await once(refused.socket, 'close');
  await delay(140); const recovered = await tcp(t, ready.socket);
  assert.equal((await recovered.request('hello')).ok, true);
  recovered.socket.write(`${'x'.repeat(65537)}\n`);
  assert.equal((await recovered.frames.next(x => x.error)).error.code, 'InvalidFrame');
  child.child.stdin.end(); assert.equal((await child.exited).code, 0);
  await assert.rejects(fetch(`${ready.control}/control/log`));
  const second = program(t, './fake-daemon/fake-daemon.mjs'); await second.out.next(x => x.ready);
  second.child.kill(); await second.exited;
});

test('B1 seed/reset and ephemeral-only port arguments', async t => {
  const seed = await evidence('daemon-seed.json');
  await writeFile(seed, JSON.stringify({ issues: [{ id: 'seed', title: 'Seed issue' }], machines: [{ id: 'seed-machine' }] }));
  const child = program(t, './fake-daemon/fake-daemon.mjs', ['--seed', seed, '--port', '0', '--control-port', '0']);
  const ready = await child.out.next(x => x.ready), client = await tcp(t, ready.socket);
  assert.equal((await client.request('issues.get', { id: 'seed' })).result.title, 'Seed issue');
  await control(ready.control, 'issues/fill', { count: 5 }); await control(ready.control, 'reset');
  assert.equal((await client.request('issues.snapshot')).result.issues.length, 1);
  assert.equal((await program(t, './fake-daemon/fake-daemon.mjs', ['--port', ready.socket.split(':')[1]]).exited).code, 2);
});
