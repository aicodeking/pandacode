/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Bot, PendingRequest, TaskSummary } from '../src/connect/types.ts';
import { attempt, configured, STOPPING, stopping, unanswered, unconfigured, unpaused, unstopping } from '../src/connect/optimistic.ts';
import { BackgroundGate } from '../src/connect/rpc.ts';
import { applyEvent, idleLive, type Live } from '../src/store/reduce.ts';

test('attempt applies at once, keeps the edit on success and undoes it on failure', async () => {
  let value = 'before';
  const apply = () => { value = 'after'; return () => { value = 'before'; }; };
  assert.equal(await attempt(apply, async () => { assert.equal(value, 'after', 'applied before the call'); return 1; }), 1);
  assert.equal(value, 'after');
  await assert.rejects(attempt(apply, async () => { throw new Error('offline'); }), /offline/);
  assert.equal(value, 'before');
});

test('stop shows Stopping at once; a failure restores the activity unless something newer replaced it', () => {
  const live: Live = { ...idleLive(), status: 'running', activity: 'Running npm test' };
  const shown = stopping(live);
  assert.equal(shown.activity, STOPPING);
  assert.equal(unstopping(shown, live.activity).activity, 'Running npm test');
  const newer = { ...shown, activity: 'Generating response' };
  assert.equal(unstopping(newer, live.activity), newer);
});

test('an answered approval leaves at once and comes back if the answer fails', () => {
  const request: PendingRequest = { kind: 'approval', requestId: 'r1', text: 'Run rm?' };
  const waiting: Live = { ...idleLive(), status: 'waiting', activity: 'Waiting for approval', approvals: [request] };
  const answered = applyEvent(waiting, { sessionId: 's', kind: 'approval_cancelled', text: '', requestId: 'r1' });
  assert.equal(answered.approvals.length, 0, 'the card collapses');
  assert.equal(answered.status, 'running');
  const back = unanswered(answered, request, waiting);
  assert.deepEqual(back.approvals, [request]);
  assert.equal(back.status, 'waiting');
  assert.equal(back.activity, 'Waiting for approval');
  assert.equal(unanswered(back, request, waiting), back, 'never twice');
  const ended = { ...answered, status: 'stopped' };
  assert.equal(unanswered(ended, request, waiting), ended, 'a run that ended stays ended');
});

test('a failed question answer restores the input request', () => {
  const request: PendingRequest = { kind: 'input_request', requestId: 'q', text: 'Which?' };
  const waiting: Live = { ...idleLive(), status: 'waiting', inputs: [request] };
  const answered = applyEvent(waiting, { sessionId: 's', kind: 'input_cancelled', text: '', requestId: 'q' });
  assert.deepEqual(unanswered(answered, request, waiting).inputs, [request]);
});

test('pause rolls back only while the bot still shows the optimistic value', () => {
  const bot: Bot = { id: 'b', name: 'B', avatar: null, state: 'ready', paused: false, desktopSession: null, projectId: 'p' };
  const shown = [{ ...bot, paused: true, state: 'paused' }];
  assert.deepEqual(unpaused(shown, 'b', true, bot), [bot]);
  const relisted = [{ ...bot, paused: false, state: 'working' }];
  assert.deepEqual(unpaused(relisted, 'b', true, bot), relisted);
});

test('task settings change at once; a failure puts back only the fields still showing the change', () => {
  const task = { sessionId: 's', model: 'a', effort: 'low', mode: 'ask', provider: 'claude' } as TaskSummary;
  const shown = configured([task], 's', { model: 'b', effort: 'high' });
  assert.equal(shown[0].model, 'b');
  const before = { model: 'a', effort: 'low' };
  assert.deepEqual(unconfigured(shown, 's', { model: 'b', effort: 'high' }, before)[0], task);
  const newer = [{ ...shown[0], effort: 'medium' }];
  assert.deepEqual(unconfigured(newer, 's', { model: 'b', effort: 'high' }, before)[0], { ...task, effort: 'medium' });
});

test('background calls take turns per host, in order; other hosts are not held', async () => {
  const gate = new BackgroundGate();
  const order: string[] = [];
  const first = await gate.turn('mac');
  const second = gate.turn('mac').then(release => { order.push('second'); return release; });
  const third = gate.turn('mac').then(release => { order.push('third'); return release; });
  const other = await gate.turn('pc');
  assert.equal(gate.waiting('mac'), 2);
  await Promise.resolve();
  assert.deepEqual(order, [], 'nothing starts while one is in flight');
  first();
  (await second)();
  (await third)();
  other();
  assert.deepEqual(order, ['second', 'third']);
  assert.equal(gate.waiting('mac'), 0);
  const again = await gate.turn('mac'); // free again
  again();
});
