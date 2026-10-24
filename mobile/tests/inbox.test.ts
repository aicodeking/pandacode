/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import { activeSnoozes, elapsedLabel, filterRows, inboxSections, SETTLED_MS, tomorrowMorning, type InboxInput } from '../src/store/inbox.ts';
import { idleLive } from '../src/store/reduce.ts';

const NOW = 1_800_000_000_000;
const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'web', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: NOW - 60_000, lastPromptAt: null, ...extra,
});
const input = (tasks: TaskSummary[], extra: Partial<InboxInput> = {}): InboxInput => ({
  hosts: [{ id: 'mac', name: 'Studio' }], tasks: { mac: { tasks, projects: [] } }, live: {}, snoozed: {}, pins: {}, outbox: [], now: NOW, ...extra,
});
const ids = (rows: { task: TaskSummary }[]) => rows.map(r => r.task.sessionId);

test('tasks land in needs, working, recent and settled', () => {
  const inbox = inboxSections(input([
    task('a', { status: 'waiting', pending: [{ kind: 'approval', requestId: 'r', text: 'ok?' }] }),
    task('q', { status: 'waiting', pending: [{ kind: 'input_request', requestId: 'r2', text: '?' }] }),
    task('w', { status: 'running' }),
    task('f', { status: 'failed' }),
    task('old', { updatedAt: NOW - SETTLED_MS - 1 }),
    task('oldPinned', { updatedAt: NOW - SETTLED_MS - 1, pinned: true }),
  ]));
  assert.deepEqual(ids(inbox.needs), ['a', 'q']);
  assert.deepEqual(inbox.needs.map(r => r.badge), ['approval', 'question']);
  assert.deepEqual(ids(inbox.working), ['w']);
  assert.deepEqual(ids(inbox.recent), ['oldPinned', 'f']);
  assert.equal(inbox.recent[1].badge, 'failed');
  assert.deepEqual(ids(inbox.settled), ['old']);
  assert.equal(inbox.needs[0].computer, 'Studio');
});

test('the live view beats the last list, and run end returns to the list status', () => {
  const live = { 'mac/x': { ...idleLive(), status: 'waiting', approvals: [{ kind: 'approval', requestId: 'r', text: '' }] }, 'mac/y': { ...idleLive(), status: 'running' } };
  const inbox = inboxSections(input([task('x', { status: 'running' }), task('y'), task('z', { status: 'running' })], { live: { ...live, 'mac/z': idleLive() } }));
  assert.deepEqual(ids(inbox.needs), ['x']);
  assert.deepEqual(ids(inbox.working), ['y', 'z']);
});

test('snoozed and phone pins: snoozes hide until they end, pins sort first', () => {
  const tasks = [task('a', { updatedAt: NOW - 1000 }), task('b', { updatedAt: NOW - 5000 }), task('c')];
  const inbox = inboxSections(input(tasks, { snoozed: { 'mac/a': NOW + 1000, 'mac/c': NOW - 1 }, pins: { 'mac/b': true } }));
  assert.deepEqual(ids(inbox.snoozed), ['a']);
  assert.deepEqual(ids(inbox.recent), ['b', 'c']);
  assert.deepEqual(activeSnoozes({ x: NOW + 1, y: NOW }, NOW), { x: NOW + 1 });
});

test('unsent rows follow the outbox order and keep their task', () => {
  const outbox = [{ id: 'o1', deviceId: 'mac', sessionId: 'a', text: 'hi', createdAt: 2 }, { id: 'o2', deviceId: 'mac', sessionId: 'gone', text: '?', createdAt: 1 }];
  const inbox = inboxSections(input([task('a')], { outbox }));
  assert.equal(inbox.unsent.length, 1);
  assert.equal(inbox.unsent[0].badge, 'unsent');
  assert.equal(inbox.unsent[0].outboxId, 'o1');
  assert.deepEqual(ids(inbox.recent), ['a']);
});

test('tomorrow means 8:00 the next local day', () => {
  const t = new Date(tomorrowMorning(NOW));
  const today = new Date(NOW);
  assert.equal(t.getHours(), 8);
  assert.ok(t.getTime() > NOW && t.getTime() - NOW < 2 * 86_400_000 && t.getDate() !== today.getDate());
});

test('elapsed labels count minutes, then hours and minutes, then days', () => {
  const min = 60_000;
  assert.deepEqual([-5, 0, 59_999, min, 6 * min, 59 * min, 60 * min, 65 * min, 23 * 60 * min + 59 * min, 24 * 60 * min, 80 * 60 * min].map(elapsedLabel),
    ['<1m', '<1m', '<1m', '1m', '6m', '59m', '1h', '1h 5m', '23h 59m', '1d', '3d']);
});

test('search filters rows by title, project, branch or computer', () => {
  const inbox = inboxSections(input([task('fix login', { branch: 'auth/fix' }), task('docs', { projectName: 'Site' })]));
  const rows = inbox.recent;
  assert.deepEqual(ids(filterRows(rows, ' LOGIN ')), ['fix login']);
  assert.deepEqual(ids(filterRows(rows, 'auth/')), ['fix login']);
  assert.deepEqual(ids(filterRows(rows, 'site')), ['docs']);
  assert.equal(filterRows(rows, '').length, 2);
  assert.equal(filterRows(rows, 'studio').length, 2);
});
