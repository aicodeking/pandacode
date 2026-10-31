/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { Cursors, followReplay, MAX_REPLAY_PAGES } from '../src/store/replay.ts';
import type { AgentEvent, SubscribeReply } from '../src/connect/types.ts';

const ev = (seq: number, sessionId = 'a'): AgentEvent => ({ sessionId, kind: 'text', text: `e${seq}`, seq } as AgentEvent);

/** A host whose journal for task `a` holds seqs 1..last, replaying `per` events per page. */
const host = (last: number, per: number, calls: any[], during?: () => void) => async (params: any): Promise<SubscribeReply> => {
  calls.push(params);
  during?.();
  const after = params.afterSeq?.a ?? 0;
  const top = Math.min(after + per, last);
  const events = params.afterSeq ? Array.from({ length: top - after }, (_, n) => ev(after + n + 1)) : [];
  const more = params.afterSeq !== undefined && top < last;
  return { epoch: 'E', more, tasks: [{ sessionId: 'a', status: 'running', lastId: 1, title: 't', events, seq: more ? top : last, ...(more ? { more: true } : {}) }] };
};

/** The viewer: shows replayed events through fresh, live ones through keep → fresh. */
function viewer(c: Cursors) {
  const shown: number[] = [];
  const show = (list: AgentEvent[], epoch: unknown) => shown.push(...c.fresh('h', epoch, list).map(e => e.seq!));
  const live = (list: AgentEvent[]) => { if (!c.keep('h', 'E', list)) show(list, 'E'); };
  return { shown, show, live };
}

test('replay pages are drained while `more`, and a live event meanwhile hides none of them', async () => {
  const c = new Cursors();
  c.fresh('h', 'E', [ev(2)]); // left off at seq 2
  const v = viewer(c);
  const calls: any[] = [];
  let sent = false;
  // A live frame (seq 11) arrives while the first page is in flight.
  const result = await followReplay(c, 'h', ['a'], host(10, 3, calls, () => { if (!sent) { sent = true; v.live([ev(11)]); } }), v.show);
  assert.deepEqual(calls.map(p => p.afterSeq.a), [2, 5, 8], 'each page continues from the last replayed seq');
  assert.deepEqual(v.shown, [3, 4, 5, 6, 7, 8, 9, 10]);
  for (const e of result.held.entries) v.show(e.events, e.epoch);
  assert.deepEqual(v.shown, [3, 4, 5, 6, 7, 8, 9, 10, 11], 'the held live event comes last');
  assert.equal(result.tasks.length, 1);
  assert.notEqual(result.tasks[0].gap, true);
  v.live([ev(12)]);
  assert.equal(v.shown.at(-1), 12, 'not held once the round is over');
});

test('a replay longer than the page limit becomes a gap', async () => {
  const c = new Cursors();
  c.fresh('h', 'E', [ev(1)]);
  const v = viewer(c);
  const calls: any[] = [];
  const result = await followReplay(c, 'h', ['a'], host(1000, 1, calls), v.show);
  assert.equal(calls.length, MAX_REPLAY_PAGES);
  assert.equal(result.tasks[0].gap, true);
});

test('a later page that fails marks the unfinished task as a gap; a first that fails returns no reply', async () => {
  const c = new Cursors();
  c.fresh('h', 'E', [ev(1)]);
  const v = viewer(c);
  const ok = host(10, 3, []);
  let n = 0;
  const flaky = async (p: any) => { if (++n === 2) throw new Error('offline'); return ok(p); };
  const result = await followReplay(c, 'h', ['a'], flaky, v.show);
  assert.equal(result.tasks[0].gap, true);
  const failed = await followReplay(c, 'h', ['a'], async () => { throw new Error('offline'); }, v.show);
  assert.equal(failed.reply, null);
});

test('a task with no position takes its held live events, not the reply seq', async () => {
  const c = new Cursors();
  const v = viewer(c);
  // First subscribe (no epoch): nothing replayed; a live event (seq 9) lands before the reply says seq 10.
  const result = await followReplay(c, 'h', ['a'], host(10, 3, [], () => v.live([ev(9)])), v.show);
  for (const e of result.held.entries) v.show(e.events, e.epoch);
  assert.deepEqual(v.shown, [9]);
});
