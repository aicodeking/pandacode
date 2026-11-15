/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Method } from '../src/connect/rpc.ts';
import type { DemoHost } from '../src/demo-host.ts';
import type { ConnectState } from '../src/store/index.ts';
import { cadence, draftInput, draftOf, emptyDraft, INTERVALS, isFinished, MAX_INTERVAL, MIN_INTERVAL, nextLine, sortSchedules, watchable, when, type ScheduleDraft, type TaskSchedule } from '../src/store/schedules.ts';

const NOW = new Date(2026, 10, 9, 14, 0).getTime();
const MIN = 60_000;
const clock = (at: number) => { const d = new Date(at); return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`; };

const schedule = (extra: Partial<TaskSchedule> = {}): TaskSchedule => ({
  id: 's', sessionId: 't', sessionTitle: 'Thread', projectId: 'p', projectName: 'p', title: 'Check', prompt: 'Check CI', kind: 'daily',
  intervalMinutes: null, timeOfDay: '09:00', days: [], watchSessionId: null, watchSessionTitle: null, onlyOnSuccess: false,
  nextRunAt: NOW + 60 * MIN, lastRunAt: null, enabled: true, createdBy: 'user', createdBySession: null, runCount: 0, maxRuns: null,
  workflowId: null, chainFromId: null, createdAt: 0, updatedAt: 0, ...extra,
});
const draft = (extra: Partial<ScheduleDraft> = {}): ScheduleDraft => ({ ...emptyDraft(NOW, 't'), prompt: 'Check CI', ...extra });

test('cadence reads like the desktop', () => {
  assert.equal(cadence(schedule({ kind: 'once' })), 'Once');
  assert.equal(cadence(schedule({ kind: 'interval', intervalMinutes: 30 })), 'Every 30 min');
  assert.equal(cadence(schedule({ kind: 'interval', intervalMinutes: 60 })), 'Every hour');
  assert.equal(cadence(schedule({ kind: 'interval', intervalMinutes: 120 })), 'Every 2 hours');
  assert.equal(cadence(schedule({ kind: 'interval', intervalMinutes: 2880 })), 'Every 2 days');
  assert.equal(cadence(schedule({ kind: 'daily', timeOfDay: '09:30' }), clock), 'Daily at 9:30');
  assert.equal(cadence(schedule({ kind: 'weekly', days: [4, 1], timeOfDay: '18:30' }), clock), 'Weekly on Mon, Thu at 18:30');
  assert.equal(cadence(schedule({ kind: 'after', watchSessionTitle: 'Build', onlyOnSuccess: true })), 'After “Build” succeeds');
  assert.equal(cadence(schedule({ kind: 'after' })), 'After “a thread” finishes');
});

test('when says how far off a run is', () => {
  assert.equal(when(null, NOW), '');
  assert.equal(when(NOW + 20_000, NOW), 'now');
  assert.equal(when(NOW + 12 * MIN, NOW), 'in 12 min');
  assert.equal(when(NOW + 90 * MIN, NOW), 'in 1.5 h');
  assert.equal(when(NOW - 5 * MIN, NOW), '5 min ago');
  assert.equal(when(NOW + 8 * 60 * MIN, NOW, clock), 'today 22:00');
  assert.equal(when(NOW + 20 * 60 * MIN, NOW, clock), 'tomorrow 10:00');
});

test('finished, off and waiting schedules say so, and sort after live ones', () => {
  const once = schedule({ id: 'once', kind: 'once', enabled: false, runCount: 1 });
  const used = schedule({ id: 'used', enabled: false, runCount: 3, maxRuns: 3 });
  const off = schedule({ id: 'off', enabled: false });
  const soon = schedule({ id: 'soon', nextRunAt: NOW + MIN });
  const later = schedule({ id: 'later', nextRunAt: NOW + 90 * MIN });
  assert.ok(isFinished(once) && isFinished(used) && !isFinished(off));
  assert.equal(nextLine(once, NOW), 'Finished');
  assert.equal(nextLine(off, NOW), 'Off');
  assert.equal(nextLine(schedule({ kind: 'after', nextRunAt: null }), NOW), 'Waiting for its trigger');
  assert.equal(nextLine(soon, NOW), 'Next in 1 min');
  assert.deepEqual(sortSchedules([once, off, later, soon, used]).map(s => s.id), ['soon', 'later', 'off', 'once', 'used']);
});

test('drafts are checked the way the host checks them', () => {
  const error = (d: ScheduleDraft) => { const r = draftInput(d, NOW); return 'error' in r ? r.error : ''; };
  assert.match(error(draft({ sessionId: '' })), /Pick the thread/);
  assert.match(error(draft({ prompt: '   ' })), /Write the message/);
  assert.match(error(draft({ prompt: 'x'.repeat(100 * 1024 + 1) })), /100 KB/);
  assert.match(error(draft({ title: 't'.repeat(121) })), /120 characters/);
  assert.match(error(draft({ maxRuns: '0' })), /Max runs/);
  assert.match(error(draft({ kind: 'once', runAt: NOW - 2 * MIN })), /already passed/);
  assert.match(error(draft({ kind: 'once', runAt: NOW + 400 * 24 * 60 * MIN })), /within a year/);
  assert.match(error(draft({ kind: 'interval', intervalMinutes: MIN_INTERVAL - 1 })), /5 minutes to 7 days/);
  assert.match(error(draft({ kind: 'interval', intervalMinutes: MAX_INTERVAL + 1 })), /5 minutes to 7 days/);
  assert.match(error(draft({ kind: 'daily', timeOfDay: '24:00' })), /24-hour/);
  assert.match(error(draft({ kind: 'weekly', days: [] })), /at least one day/);
  assert.match(error(draft({ kind: 'after', watchSessionId: '' })), /whose run should trigger/);
  assert.match(error(draft({ kind: 'after', watchSessionId: 't' })), /cannot wake itself/);
  assert.ok(INTERVALS.every(i => i.minutes >= MIN_INTERVAL && i.minutes <= MAX_INTERVAL), 'every offered interval is allowed');
});

test('valid drafts send only their kind’s fields', () => {
  const input = (d: ScheduleDraft) => { const r = draftInput(d, NOW); assert.ok('input' in r, JSON.stringify(r)); return r.input; };
  assert.deepEqual(input(draft({ kind: 'weekly', days: [3, 1, 3], timeOfDay: '7:05', maxRuns: '10', title: '  Weekly  ' })),
    { sessionId: 't', title: 'Weekly', prompt: 'Check CI', kind: 'weekly', maxRuns: 10, timeOfDay: '7:05', days: [1, 3] });
  assert.deepEqual(input(draft({ kind: 'interval', intervalMinutes: 30 })), { sessionId: 't', title: '', prompt: 'Check CI', kind: 'interval', maxRuns: null, intervalMinutes: 30 });
  assert.equal(input(draft({ kind: 'once', runAt: NOW + 5 * MIN })).runAt, NOW + 5 * MIN);
  assert.deepEqual(input(draft({ kind: 'after', watchSessionId: 'w', onlyOnSuccess: true })).watchSessionId, 'w');
});

test('editing starts from the schedule and keeps defaults for unused fields', () => {
  const d = draftOf(schedule({ kind: 'interval', intervalMinutes: 120, timeOfDay: null, maxRuns: 5 }), NOW);
  assert.equal(d.intervalMinutes, 120);
  assert.equal(d.timeOfDay, '09:00');
  assert.equal(d.maxRuns, '5');
  assert.ok(d.runAt > NOW, 'a one-off defaults to the next whole hour');
});

test('neither an edit nor a new draft sends a workflow or chain, so the host keeps its own', () => {
  // The phone's copy may be stale: the desktop may have re-chained the schedule since.
  const d = draftOf(schedule({ kind: 'after', watchSessionId: 'w', workflowId: 'wf-1', chainFromId: 's0' }), NOW);
  assert.ok(!('workflowId' in d) && !('chainFromId' in d));
  const r = draftInput({ ...d, prompt: 'Changed' }, NOW);
  assert.ok('input' in r, JSON.stringify(r));
  assert.ok(!('workflowId' in r.input) && !('chainFromId' in r.input));
  const plain = draftInput(draftOf(schedule(), NOW), NOW);
  assert.ok('input' in plain && !('workflowId' in plain.input) && !('chainFromId' in plain.input));
  const fresh = draftInput(draft(), NOW);
  assert.ok('input' in fresh && !('workflowId' in fresh.input) && !('chainFromId' in fresh.input));
});

test('a create keeps one sendId across retries of the same draft', async () => {
  const { createScheduleWith } = await import('../src/store/schedules.ts');
  const { MAY_HAVE_RUN } = await import('../src/connect/api/github.ts');
  const { LOST } = await import('../src/connect/rpc.ts');
  const input = { sessionId: 't', title: '', prompt: 'Ping', kind: 'daily' as const, timeOfDay: '09:00' };
  const ids: unknown[] = [];
  const lost = async (params: Record<string, unknown>) => { ids.push(params.sendId); throw new Error(LOST); };
  await assert.rejects(createScheduleWith(lost, true, 'd1', input), { message: MAY_HAVE_RUN });
  assert.equal(ids.length, 2);
  assert.equal(ids[0], ids[1], 'the automatic retry reuses it');
  // Saving the same draft again reuses it too, so the host answers the first schedule.
  const made = await createScheduleWith(async params => { ids.push(params.sendId); return { schedule: schedule({ id: 'new' }) }; }, true, 'd1', input);
  assert.equal(made.id, 'new');
  assert.equal(ids[2], ids[0]);
  // After it went through, the same draft again is a new schedule; so is a changed draft.
  await createScheduleWith(async params => { ids.push(params.sendId); return { schedule: schedule() }; }, true, 'd1', input);
  assert.notEqual(ids[3], ids[0]);
  await assert.rejects(createScheduleWith(lost, true, 'd1', input), { message: MAY_HAVE_RUN });
  await createScheduleWith(async params => { ids.push(params.sendId); return { schedule: schedule() }; }, true, 'd1', { ...input, prompt: 'Other' });
  assert.notEqual(ids.at(-1), ids.at(-2));
  // A host that can't dedupe gets no sendId.
  await createScheduleWith(async params => { ids.push(params.sendId); return { schedule: schedule() }; }, false, 'd1', input);
  assert.equal(ids.at(-1), undefined);
});

test('only other threads in the same project can be watched', () => {
  const tasks = [{ sessionId: 't', projectId: 'p' }, { sessionId: 'u', projectId: 'p' }, { sessionId: 'v', projectId: 'q' }];
  assert.deepEqual(watchable(tasks, 't').map(t => t.sessionId), ['u']);
  assert.deepEqual(watchable(tasks, 'missing'), []);
});

test('the demo answers every schedules and github method with plausible data', async () => {
  const { demoCall } = await import('../src/demo-host.ts');
  const task = (sessionId: string, projectId: string) => ({ sessionId, title: sessionId, status: 'idle', projectId, projectName: projectId, provider: 'claude', model: 'default', effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null });
  const tasks = [task('flaky', 'relay'), task('docs', 'pandacode'), task('perf', 'pandacode'), task('readme', 'pandacode'), task('lint', 'relay')];
  let state = {
    devices: [{ id: 'studio', name: 'Mac Studio', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: { studio: { tasks, projects: ['relay', 'pandacode', 'payments'].map(id => ({ id, name: id, repo: null })), loadedAt: 0 } },
    messages: {}, live: {}, outdated: {}, sent: {}, bots: {},
  } as unknown as ConnectState;
  const host: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => NOW };
  const call = (method: string, params: object = {}) => demoCall(host, 'studio', method as Method, params) as Promise<any>;

  const list = await call('schedules.list');
  assert.ok(list.schedules.length >= 3 && list.schedules.every((s: TaskSchedule) => s.cadence));
  const first: TaskSchedule = list.schedules[0];
  assert.ok((await call('schedules.runs', { scheduleId: first.id })).runs.length > 0);
  assert.equal((await call('schedules.runNow', { scheduleId: first.id })).run.manual, true);
  assert.equal((await call('schedules.setEnabled', { scheduleId: first.id, enabled: false })).schedule.enabled, false);
  const made = (await call('schedules.create', { input: { sessionId: first.sessionId, title: '', prompt: 'Ping', kind: 'interval', intervalMinutes: 30 } })).schedule;
  assert.equal(made.title, 'Ping');
  // An edit keeps the schedule's on/off state and its workflow chain unless it names them.
  const chained = (await call('schedules.update', { scheduleId: first.id, input: { sessionId: first.sessionId, title: '', prompt: 'Edited', kind: 'interval', intervalMinutes: 60, workflowId: 'wf', chainFromId: made.id } })).schedule;
  assert.equal(chained.enabled, false, 'still off');
  const edited = (await call('schedules.update', { scheduleId: first.id, input: { sessionId: first.sessionId, title: '', prompt: 'Again', kind: 'interval', intervalMinutes: 60 } })).schedule;
  assert.deepEqual([edited.prompt, edited.enabled, edited.workflowId, edited.chainFromId], ['Again', false, 'wf', made.id]);
  await call('schedules.delete', { scheduleId: made.id });
  assert.ok(!(await call('schedules.list')).schedules.some((s: TaskSchedule) => s.id === made.id));

  const repos = (await call('github.repos')).repos;
  assert.ok(repos.some((r: { projectId: string }) => r.projectId === 'pandacode'));
  const issues = (await call('github.issues', { projectId: 'pandacode' })).items;
  assert.ok(issues.length > 0 && (await call('github.pulls', { projectId: 'pandacode' })).items.length > 0);
  const runs = (await call('github.runs', { projectId: 'pandacode' })).items;
  assert.equal((await call('github.item', { projectId: 'pandacode', kind: 'run', runId: runs[1].id })).kind, 'run');
  assert.equal((await call('github.item', { projectId: 'pandacode', kind: 'pull', number: 415 })).checks.length, 3);
  assert.ok((await call('github.search', { projectId: 'pandacode', query: '#412' })).items.length >= 1);
  const { sessionId } = await call('github.startTask', { projectId: 'pandacode', issueNumber: issues[0].number, provider: 'claude', model: 'default' });
  assert.match(state.tasks.studio.tasks.find(t => t.sessionId === sessionId)?.title ?? '', /^Fix #\d+: /);
  await assert.rejects(call('github.issues', { projectId: 'payments' }), /no GitHub remote/);
});
