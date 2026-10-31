/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import { activeSnoozes, botOf, botRows, elapsedLabel, filterBots, filterRows, glanceOf, inboxSections, SETTLED_MS, stalledFor, STALL_MS, tomorrowMorning, type InboxInput } from '../src/store/inbox.ts';
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

test('tasks land in running, needs, recent and settled', () => {
  const inbox = inboxSections(input([
    task('a', { status: 'waiting', pending: [{ kind: 'approval', requestId: 'r', text: 'ok?' }] }),
    task('q', { status: 'waiting', pending: [{ kind: 'input_request', requestId: 'r2', text: '?' }] }),
    task('w', { status: 'running' }),
    task('f', { status: 'failed' }),
    task('old', { updatedAt: NOW - SETTLED_MS - 1 }),
    task('oldPinned', { updatedAt: NOW - SETTLED_MS - 1, pinned: true }),
  ]));
  // Waiting on you first, then failures.
  assert.deepEqual(ids(inbox.needs), ['a', 'q', 'f']);
  assert.deepEqual(inbox.needs.map(r => r.badge), ['approval', 'question', 'failed']);
  assert.deepEqual(ids(inbox.running), ['w']);
  assert.deepEqual(ids(inbox.recent), ['oldPinned']);
  assert.deepEqual(ids(inbox.settled), ['old']);
  assert.equal(inbox.needs[0].computer, 'Studio');
});

test('the live view beats the last list, and run end returns to the list status', () => {
  const live = { 'mac/x': { ...idleLive(), status: 'waiting', approvals: [{ kind: 'approval', requestId: 'r', text: '' }] }, 'mac/y': { ...idleLive(), status: 'running' } };
  const inbox = inboxSections(input([task('x', { status: 'running' }), task('y'), task('z', { status: 'running' })], { live: { ...live, 'mac/z': idleLive() } }));
  assert.deepEqual(ids(inbox.needs), ['x']);
  assert.deepEqual(ids(inbox.running), ['y', 'z']);
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

test('bot conversations leave the project sections and date their bot under Bots', () => {
  const bot = (id: string, name: string, desktopSession: string | null = null) => ({ id, name, avatar: null, state: 'ready', paused: false, desktopSession, projectId: `${id}-ws` });
  const tasks = [
    task('t'),
    task('b1', { botId: 'leo', botName: 'Leo', status: 'waiting', pending: [{ kind: 'approval', requestId: 'r', text: '?' }], updatedAt: NOW - 5000 }),
    task('b2', { botId: 'leo', botName: 'Leo', updatedAt: NOW - 9000 }),
  ];
  const inbox = inboxSections(input(tasks));
  assert.deepEqual([...inbox.needs, ...inbox.running, ...inbox.recent, ...inbox.settled].map(r => r.task.sessionId), ['t']);
  const hosts = [{ id: 'mac', name: 'Studio' }, { id: 'old', name: 'Laptop' }];
  const rows = botRows(hosts, { mac: [bot('ada', 'Ada'), bot('zed', 'Zed'), bot('leo', 'Leo', 'b1')], old: [] }, { mac: { tasks, projects: [] } });
  assert.deepEqual(rows.map(r => [r.bot.name, r.at, r.computer]), [['Leo', NOW - 5000, 'Studio'], ['Ada', 0, 'Studio'], ['Zed', 0, 'Studio']]);
  assert.equal(botOf(rows.map(r => r.bot), tasks[2], 'b2')?.id, 'leo');
  assert.equal(botOf(rows.map(r => r.bot), undefined, 'b1')?.id, 'leo');
  assert.equal(botOf(rows.map(r => r.bot), tasks[0], 't'), undefined);
  assert.deepEqual(filterBots(rows, 'ze').map(r => r.bot.id), ['zed']);
  assert.equal(filterBots(rows, 'studio').length, 3);
});

test('needs you puts waiting first even when a failure is newer; limits and stops get their badges', () => {
  const live = { 'mac/l': { ...idleLive(), status: 'idle', limited: { text: 'Limit reached', resetsAt: NOW + 3600_000 } }, 'mac/old': { ...idleLive(), limited: { text: 'x', resetsAt: NOW - 1 } } };
  const inbox = inboxSections(input([
    task('f', { status: 'failed', updatedAt: NOW - 1000 }),
    task('a', { status: 'waiting', updatedAt: NOW - 50_000, pending: [{ kind: 'approval', requestId: 'r', text: '' }] }),
    task('l'), task('old'), task('s', { status: 'stopped' }),
    task('oldFail', { status: 'failed', updatedAt: NOW - SETTLED_MS - 1 }),
  ], { live }));
  assert.deepEqual(ids(inbox.needs), ['a', 'f', 'l']);
  assert.equal(inbox.needs[2].badge, 'limited');
  assert.equal(inbox.needs[2].run.limitedUntil, NOW + 3600_000);
  assert.deepEqual(inbox.recent.map(r => [r.task.sessionId, r.badge]), [['old', null], ['s', 'stopped']]);
  assert.deepEqual(ids(inbox.settled), ['oldFail']);
});

test('a running row glances at its current tool, thinking and active subagents', () => {
  const agent = (id: string, status: string, tools: unknown[] = []) => ({ id, name: id, status, response: '', tools, startedAt: 1, updatedAt: 1 });
  const base = { ...idleLive(), status: 'running', startedAt: NOW - 360_000, lastEventAt: NOW - 1000 };
  const tool = { id: 't', name: 'Bash', status: 'running' as const, input: '{"command":"npm test -- upload"}', output: '' };
  const glance = glanceOf({ ...base, items: [{ kind: 'tool', tool }], subagents: [agent('x', 'running'), agent('y', 'completed'), agent('z', 'waiting')] as never });
  assert.deepEqual(glance, { activity: 'Running npm test -- upload', agents: 2, startedAt: NOW - 360_000, lastEventAt: NOW - 1000, limitedUntil: undefined });
  assert.equal(glanceOf({ ...base, thinking: 'Thinking' }).activity, 'Thinking');
  // No tool of its own: a subagent's running tool.
  const child = agent('c', 'running', [{ id: 'r', name: 'Read', status: 'running', input: '{"file_path":"/a/b/auth.ts"}', output: '' }]);
  assert.equal(glanceOf({ ...base, subagents: [child] as never }).activity, 'Reading auth.ts');
  // Older hosts: the list row's times, none at all for the oldest.
  assert.equal(glanceOf(undefined, task('t', { lastEventAt: 5, runStartedAt: 3 })).lastEventAt, 5);
  assert.equal(glanceOf(undefined, task('t')).startedAt, undefined);
});

test('a run stalls only after STALL_MS without events, and never with no known time', () => {
  assert.equal(stalledFor(NOW - STALL_MS, NOW), null);
  assert.equal(stalledFor(NOW - STALL_MS - 1, NOW), STALL_MS + 1);
  assert.equal(stalledFor(undefined, NOW), null);
  assert.equal(stalledFor(null, NOW), null);
});

test('sections come in order: running, needs, recent', () => {
  const inbox = inboxSections(input([task('r', { status: 'running' }), task('n', { status: 'waiting' }), task('d')]));
  assert.deepEqual(Object.keys(inbox).slice(0, 3), ['running', 'needs', 'recent']);
  assert.deepEqual([...inbox.running, ...inbox.needs, ...inbox.recent].map(r => r.task.sessionId), ['r', 'n', 'd']);
});
