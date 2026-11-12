/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { Batcher } from '../src/connect/batcher.ts';
import { RETRY_FIRST_MS, RETRY_MAX_MS, RetryLater } from '../src/connect/renewal.ts';
import { DROPPED, LOST, maybeRan, NOT_CONNECTED, NOT_RUN, OFFLINE, promptMaybeRan, TIMED_OUT, UNKNOWN_METHOD } from '../src/connect/rpc.ts';
import { draftStartId, followStart, keepsStartId, MAX_RESENDS, START_POLL_MS, STILL_STARTING, type FollowDeps } from '../src/connect/start-retry.ts';
import type { AgentEvent, StartStatus } from '../src/connect/types.ts';
import { Cursors, CURSORS_MAX_AGE_MS, encodeCursors, parseCursors } from '../src/store/replay.ts';
import { sentLabel, settled, unconfirm, unmatched, type Sent } from '../src/store/sent.ts';

// ---- startId ----

test('a draft keeps its start id across retries until it changes', () => {
  let n = 0;
  const fresh = () => `id${++n}`;
  const first = draftStartId(null, 'draft-a', fresh);
  assert.equal(first.id, 'id1');
  assert.equal(draftStartId(first, 'draft-a', fresh), first, 'the same draft reuses it');
  assert.equal(draftStartId(first, 'draft-b', fresh).id, 'id2', 'an edited draft gets a new one');
  // Only a start the host may have keeps the id; one the host refused starts over.
  for (const kept of [TIMED_OUT, LOST, OFFLINE, NOT_CONNECTED, STILL_STARTING]) assert.ok(keepsStartId(new Error(kept)), kept);
  assert.ok(!keepsStartId(new Error('Install Codex on this computer first.')));
});

function starter(script: { start: (() => unknown)[]; status: (() => unknown)[] }, extra: Partial<FollowDeps> = {}) {
  let clock = 0;
  const calls: string[] = [];
  const run = (list: (() => unknown)[], name: string) => async () => {
    calls.push(name);
    const next = list.shift();
    if (!next) throw new Error(`unexpected ${name}`);
    return next() as never;
  };
  const deps: FollowDeps = {
    start: run(script.start, 'start'),
    status: run(script.status, 'status'),
    canPoll: () => true,
    sleep: async ms => { clock += ms; calls.push(`sleep ${ms}`); },
    now: () => clock,
    maxMs: 60_000,
    ...extra,
  };
  return { deps, calls };
}
const fail = (message: string) => () => { throw new Error(message); };
const status = (s: StartStatus & { note?: string }) => () => s;

test('a start whose reply was lost polls task.startStatus every 3 s until it is done', async () => {
  const { deps, calls } = starter({
    start: [fail(LOST)],
    status: [fail(NOT_CONNECTED), status({ state: 'running' }), status({ state: 'done', sessionId: 's9', note: 'Used a worktree' })],
  });
  assert.deepEqual(await followStart(deps), { sessionId: 's9', worktree: undefined, note: 'Used a worktree' });
  assert.deepEqual(calls, ['start', 'status', `sleep ${START_POLL_MS}`, 'status', `sleep ${START_POLL_MS}`, 'status']);
});

test('a polled start reports what the host decided', async () => {
  const { deps } = starter({ start: [fail(TIMED_OUT)], status: [status({ state: 'failed', error: 'No such project.' })] });
  await assert.rejects(followStart(deps), /No such project/);
});

test('a start the host never got is sent again under the same id, a bounded number of times', async () => {
  const unknown = status({ state: 'unknown' });
  const { deps, calls } = starter({ start: [fail(LOST), () => ({ sessionId: 's1' })], status: [unknown] });
  assert.deepEqual(await followStart(deps), { sessionId: 's1' });
  assert.deepEqual(calls, ['start', 'status', 'start']);
  const many = starter({ start: Array.from({ length: MAX_RESENDS + 1 }, () => fail(LOST)), status: Array.from({ length: MAX_RESENDS + 1 }, () => unknown) });
  await assert.rejects(followStart(many.deps), new RegExp(LOST.replace(/\./g, '\\.')));
  assert.equal(many.calls.filter(c => c === 'start').length, MAX_RESENDS + 1);
});

test('polling stops at the deadline, and is skipped for refusals or hosts without startStatus', async () => {
  const running = status({ state: 'running' });
  const slow = starter({ start: [fail(LOST)], status: Array.from({ length: 30 }, () => running) }, { maxMs: 9_000 });
  await assert.rejects(followStart(slow.deps), new RegExp(STILL_STARTING));
  assert.equal(slow.calls.filter(c => c === 'status').length, 4, 'at 0, 3, 6 and 9 s');
  const refused = starter({ start: [fail('Install Codex first.')], status: [] });
  await assert.rejects(followStart(refused.deps), /Install Codex/);
  const old = starter({ start: [fail(TIMED_OUT)], status: [] }, { canPoll: () => false });
  await assert.rejects(followStart(old.deps), new RegExp(TIMED_OUT));
  const unknownMethod = starter({ start: [fail(TIMED_OUT)], status: [fail(UNKNOWN_METHOD)] });
  await assert.rejects(followStart(unknownMethod.deps), new RegExp(TIMED_OUT), 'an older host: the lost reply stands');
});

// ---- sendId: unconfirmed bubbles ----

test('an unconfirmed prompt keeps its bubble until the reload finds its copy', () => {
  const sent: Sent[] = [{ id: 'a', text: 'fix it', state: 'sending', after: 3 }, { id: 'b', text: 'next', state: 'queued', after: 3 }];
  const marked = unconfirm(sent, 'a');
  assert.equal(marked[0].unconfirmed, true);
  assert.equal(sent[0].unconfirmed, undefined, 'not mutated');
  assert.equal(marked[1], sent[1]);
  assert.deepEqual(marked.map(sentLabel), ['Unconfirmed', 'Queued']);
  assert.equal(sentLabel({ id: 'c', text: 'x', state: 'steering', after: 0 }), 'Steer · Sending…');
  // Still unconfirmed while the host's copy isn't stored; gone once it is; dropped at a run's end.
  assert.equal(unmatched(marked, []).length, 2);
  assert.deepEqual(unmatched(marked, [{ id: 4, role: 'user', content: 'fix it', createdAt: 4, turnDurationMs: null }]).map(e => e.id), ['b']);
  assert.deepEqual(settled(marked).map(e => e.id), ['b']);
});

// ---- prevSeq: gaps ----

const ev = (seq: number, prev?: number, sessionId = 'a'): AgentEvent => ({ sessionId, kind: 'text', text: `e${seq}`, seq, ...(prev === undefined ? {} : { prev }) });

test('an event whose prev this phone never saw is a gap: the rest of its task waits for a replay', () => {
  const c = new Cursors();
  assert.deepEqual(c.check('h', 'E', [ev(5, 3)]).gaps, [], 'no position yet: never a gap');
  const checked = c.check('h', 'E', [ev(7, 5), ev(9, 8), ev(10, 9), ev(11, 2, 'b')]);
  assert.deepEqual(checked.events.map(e => e.seq), [7, 11], 'seq 8 never arrived: 9 and 10 wait');
  assert.deepEqual(checked.gaps, ['a']);
  assert.deepEqual(c.params('h', ['a', 'b']), { sessionIds: ['a', 'b'], epoch: 'E', afterSeq: { a: 7, b: 11 } }, 'the replay starts where the phone is');
  assert.deepEqual(c.check('h', 'E', [ev(8, 7), ev(9, 8)]).events.map(e => e.seq), [8, 9]);
  assert.deepEqual(c.check('h', 'E', [ev(12), ev(13, undefined)]).gaps, [], 'older hosts send no prev');
  assert.deepEqual(c.fresh('h', 'E', [ev(20, 15)]), [], 'fresh drops a gap too');
});

test('cursors are saved and restored as resume tokens, and stale or malformed ones are ignored', () => {
  const c = new Cursors();
  c.fresh('mac', 'E1', [ev(4), ev(6, 4, 'b')]);
  const text = encodeCursors(c.snapshot(), 1_000);
  const restored = new Cursors();
  restored.restore(parseCursors(text, 2_000));
  assert.deepEqual(restored.params('mac', ['a', 'b', 'c']), { sessionIds: ['a', 'b', 'c'], epoch: 'E1', afterSeq: { a: 4, b: 6 } });
  // A host this run already knows keeps its own position.
  const live = new Cursors();
  live.fresh('mac', 'E2', [ev(1)]);
  live.restore(parseCursors(text, 2_000));
  assert.equal(live.params('mac', ['a']).epoch, 'E2');
  assert.deepEqual(parseCursors(text, 1_000 + CURSORS_MAX_AGE_MS + 1), {}, 'too old');
  assert.deepEqual(parseCursors('nope', 0), {});
  assert.deepEqual(parseCursors(JSON.stringify({ savedAt: 0, hosts: { 'bad host': { epoch: 'E', seqs: { a: 1 } }, ok: { epoch: 'E', seqs: { a: -1, b: 'x', c: 3 } } } }), 0), { ok: { epoch: 'E', seqs: { c: 3 } } });
});

// ---- subscribe renewal retry ----

test('a failed subscribe is retried per host after 2 s, doubling to a minute, reset by a success', () => {
  const timers: { run: () => void; ms: number }[] = [];
  const ran: string[] = [];
  const retry = new RetryLater({ run: host => ran.push(host), random: () => 0.5, setTimer: (run, ms) => timers.push({ run, ms }), clearTimer: () => undefined });
  assert.equal(retry.failed('mac'), RETRY_FIRST_MS);
  assert.equal(retry.failed('mac'), null, 'one wait at a time');
  assert.equal(retry.failed('pc'), RETRY_FIRST_MS, 'per host');
  timers.shift()!.run();
  assert.deepEqual(ran, ['mac']);
  const waits = [];
  for (let i = 0; i < 8; i++) {
    waits.push(retry.failed('mac'));
    timers.at(-1)!.run();
  }
  assert.deepEqual(waits, [4000, 8000, 16000, 32000, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS, RETRY_MAX_MS]);
  retry.succeeded('mac');
  assert.equal(retry.failed('mac'), RETRY_FIRST_MS);
  // Jittered ±30 %.
  const low = new RetryLater({ run: () => undefined, random: () => 0, setTimer: () => 1 });
  assert.equal(low.failed('h'), 1400);
});

// ---- batch on reconnect ----

function wire(results: (calls: { method: string }[]) => unknown, limit = 8) {
  const sent: { method: string; params: any }[] = [];
  const later: (() => void)[] = [];
  const batcher = new Batcher({
    send: async (_device, method, params) => {
      sent.push({ method, params });
      if (method === 'batch') return results((params as any).calls);
      if (method === 'boom') throw new Error(OFFLINE);
      return { alone: method };
    },
    limit: () => limit,
    later: run => later.push(run),
  });
  return { batcher, sent, tick: async () => { later.splice(0).forEach(run => run()); await new Promise(r => setImmediate(r)); } };
}

test('read calls made together go as one batch, and an omitted result is fetched on its own', async () => {
  const { batcher, sent, tick } = wire(calls => ({ results: calls.map(c => (c.method === 'task.messages' ? { ok: false, error: 'Result omitted to keep the batch reply within 180 KiB; request it separately.' } : { ok: true, result: { from: c.method } })) }));
  const list = batcher.call('mac', 'tasks.list', {}, 20_000);
  const sub = batcher.call('mac', 'subscribe', { sessionIds: ['a'] }, 20_000);
  const page = batcher.call('mac', 'task.messages', { sessionId: 'a', afterId: 3 }, 20_000);
  const send = batcher.call('mac', 'task.send', { sessionId: 'a', text: 'hi' }, 20_000);
  await tick();
  assert.deepEqual(await list, { from: 'tasks.list' });
  assert.deepEqual(await sub, { from: 'subscribe' });
  assert.deepEqual(await page, { alone: 'task.messages' });
  assert.deepEqual(await send, { alone: 'task.send' }, 'a prompt is never batched');
  assert.deepEqual(sent.map(s => s.method), ['task.send', 'batch', 'task.messages']);
  assert.deepEqual(sent[1].params.calls.map((c: any) => c.method), ['tasks.list', 'subscribe', 'task.messages']);
});

test('a host that refuses batch answers each call; a lost batch fails each call', async () => {
  const refusing = wire(() => { throw new Error(UNKNOWN_METHOD); });
  const a = refusing.batcher.call('mac', 'tasks.list', {}, 1);
  const b = refusing.batcher.call('mac', 'subscribe', {}, 1);
  await refusing.tick();
  assert.deepEqual([await a, await b], [{ alone: 'tasks.list' }, { alone: 'subscribe' }]);
  const lost = wire(() => { throw new Error(LOST); });
  const c = assert.rejects(lost.batcher.call('mac', 'tasks.list', {}, 1), /lost/);
  const d = assert.rejects(lost.batcher.call('mac', 'subscribe', {}, 1), /lost/);
  await lost.tick();
  await Promise.all([c, d]);
  const off = wire(() => ({}), 0);
  assert.deepEqual(await off.batcher.call('mac', 'tasks.list', {}, 1), { alone: 'tasks.list' }, 'outside the window: sent at once');
});

// ---- queue expiry ----

test("a prompt refused for waiting too long is dropped only when the host says it never ran", () => {
  // A newer host answers a late copy of a prompt that already ran, so NOT_RUN means it never went.
  assert.ok(!promptMaybeRan(new Error(NOT_RUN)));
  // An older host refused it even when an earlier copy with the same sendId had run: keep the bubble.
  assert.ok(promptMaybeRan(new Error(DROPPED)));
  for (const lost of [TIMED_OUT, LOST]) assert.ok(promptMaybeRan(new Error(lost)), lost);
  for (const never of [OFFLINE, NOT_CONNECTED, 'No such task.']) assert.ok(!promptMaybeRan(new Error(never)), never);
  // Other calls keep their meaning: an expiry is a refusal there.
  assert.ok(!maybeRan(new Error(DROPPED)));
});

test('"Send again" on a steer sends the message under a fresh sendId, never the steer\'s', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../src/connect/client.ts', import.meta.url), 'utf8');
  const steer = client.slice(client.indexOf('async function steerTask'));
  const body = steer.slice(0, steer.indexOf('\n}\n'));
  assert.match(body, /again: \(\) => sendMessage\(deviceId, sessionId, text, uuid\(\)\)/);
  assert.doesNotMatch(body, /sendMessage\(deviceId, sessionId, text, id\)/);
  const again = client.slice(client.indexOf('async function sendAgain'));
  assert.match(again.slice(0, again.indexOf('\n}\n')), /entry\.state === 'steering' \? uuid\(\) : id/);
});

test('btw.ask, vm.start/stop and moodboards.add go once per call, under the host\'s backgroundSendId', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  const composer = read('../src/connect/api/composer.ts');
  // Only hosts that list backgroundSendId dedupe these; actionSendId and forkSendId predate them.
  assert.match(composer, /export const BACKGROUND_SEND_ID = 'backgroundSendId'/);
  assert.match(composer, /caps\.features\.has\(BACKGROUND_SEND_ID\)/);
  assert.match(composer, /runOnce\(sendId => hostCall<T>\(deviceId, method, sendId \? \{ \.\.\.params, sendId \} : params, options\), dedupes\)/);
  assert.match(composer, /hostCallBackgroundOnce<[^>]+>\(deviceId, 'btw\.ask'/);
  assert.doesNotMatch(composer, /hostCall<[^>]+>\(deviceId, 'btw\.ask'/);
  const admin = read('../src/connect/api/admin.ts');
  assert.match(admin, /hostCallBackgroundOnce<object>\(deviceId, action === 'start' \? 'vm\.start' : 'vm\.stop'/);
  const settings = read('../src/connect/api/settings.ts');
  assert.match(settings, /hostCallBackgroundOnce<[^>]+>\(deviceId, 'moodboards\.add'/);
  // The host refuses a queued background call past these (methods/mod.rs background_timeout).
  assert.match(composer, /BTW_TIMEOUT_MS = 60_000/);
  assert.match(admin, /VM_POWER_TIMEOUT_MS = 60_000/);
  const table = read('../../src-tauri/src/remote/methods/mod.rs');
  assert.match(table, /"btw\.ask" \| "vm\.start" \| "vm\.stop"[^=]*=> 60/);
  assert.match(table, /"checks\.run" => 150/);
  assert.match(read('../src/connect/api/tools.ts'), /CHECK_TIMEOUT_MS = 150_000/);
});
