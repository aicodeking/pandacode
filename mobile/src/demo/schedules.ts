// Demo answers for the `schedules` feature group (src/connect/api/schedules.ts). See ./index.ts.
// The Mac Studio has a few schedules on demo threads; changes live for the demo session only.
import { cadence, type ScheduleInput, type ScheduleRun, type TaskSchedule } from '../store/schedules.ts';
import type { ConnectState } from '../store/index.ts';
import { sent } from '../demo-host.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

const MIN = 60_000;
const HOUR = 60 * MIN;

interface DemoSchedules { schedules: TaskSchedule[]; runs: ScheduleRun[] }
/** Per device, made on first use; replaced (never edited in place) on every change. */
let byDevice: Record<string, DemoSchedules> = {};

const titleOf = (s: ConnectState, deviceId: string, sessionId: string) => s.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);

function seed(s: ConnectState, deviceId: string, now: number): DemoSchedules {
  const task = (id: string) => titleOf(s, deviceId, id);
  const make = (id: string, sessionId: string, title: string, prompt: string, fields: Partial<TaskSchedule>): TaskSchedule | null => {
    const target = task(sessionId);
    if (!target) return null;
    return {
      id, sessionId, sessionTitle: target.title, projectId: target.projectId, projectName: target.projectName, title, prompt,
      kind: 'daily', intervalMinutes: null, timeOfDay: null, days: [], watchSessionId: null, watchSessionTitle: null, onlyOnSuccess: false,
      nextRunAt: null, lastRunAt: null, enabled: true, createdBy: 'user', createdBySession: null, runCount: 0, maxRuns: null,
      workflowId: null, chainFromId: null, createdAt: now - 6 * 24 * HOUR, updatedAt: now - HOUR, ...fields,
    };
  };
  const schedules = [
    make('sch-ci', 'flaky', 'Check the upload test', 'Run the upload test 20 times and tell me if it still flakes.', { kind: 'interval', intervalMinutes: 120, nextRunAt: now + 47 * MIN, lastRunAt: now - 73 * MIN, runCount: 9 }),
    make('sch-standup', 'docs', 'Morning summary', 'Summarize what changed in the relay docs since yesterday.', { kind: 'weekdays', timeOfDay: '09:00', nextRunAt: now + 15 * HOUR, lastRunAt: now - 9 * HOUR, runCount: 14 }),
    make('sch-after', 'readme', 'Refresh screenshots after the perf work', 'The sidebar perf work finished: retake the README screenshots.', { kind: 'after', watchSessionId: 'perf', watchSessionTitle: task('perf')?.title ?? 'a thread', onlyOnSuccess: true, createdBy: 'agent', createdBySession: 'perf' }),
    make('sch-weekly', 'lint', 'Dependency audit', 'Run `npm audit` and open an issue for anything high.', { kind: 'weekly', timeOfDay: '18:30', days: [1, 4], enabled: false, nextRunAt: now + 2 * 24 * HOUR, runCount: 3 }),
  ].filter((x): x is TaskSchedule => x !== null);
  const run = (schedule: TaskSchedule, ago: number, outcome: ScheduleRun['outcome'], sequence: number, detail = '', manual = false): ScheduleRun =>
    ({ id: `${schedule.id}-${sequence}`, scheduleId: schedule.id, sessionId: schedule.sessionId, title: schedule.title, at: now - ago, outcome, detail, sequence, manual });
  const runs = schedules.flatMap(schedule => (schedule.runCount ? [
    run(schedule, 73 * MIN, 'started', schedule.runCount),
    run(schedule, 193 * MIN, 'queued', schedule.runCount - 1, 'Queued behind the running turn'),
    run(schedule, 313 * MIN, 'started', schedule.runCount - 2, '', true),
    run(schedule, 433 * MIN, 'skipped', schedule.runCount - 3, 'The scheduler was paused'),
  ] : []));
  return { schedules, runs };
}

function data(ctx: DemoContext): DemoSchedules {
  const found = byDevice[ctx.deviceId] ?? seed(ctx.state, ctx.deviceId, ctx.host.now());
  byDevice = { ...byDevice, [ctx.deviceId]: found };
  return found;
}

function save(ctx: DemoContext, next: DemoSchedules) {
  byDevice = { ...byDevice, [ctx.deviceId]: next };
}

function find(ctx: DemoContext, id: string): TaskSchedule {
  const schedule = data(ctx).schedules.find(s => s.id === id);
  if (!schedule) throw new Error('This schedule no longer exists.');
  return schedule;
}

const withCadence = (s: TaskSchedule) => ({ ...s, cadence: cadence(s, at => new Date(at).toTimeString().slice(0, 5)) });

function replace(ctx: DemoContext, schedule: TaskSchedule): TaskSchedule {
  const current = data(ctx);
  save(ctx, { ...current, schedules: current.schedules.map(s => (s.id === schedule.id ? schedule : s)) });
  return schedule;
}

/** The next slot the demo shows: the interval from now, else tomorrow at the time, else the one-off. */
function nextRun(input: ScheduleInput, now: number): number | null {
  if (input.kind === 'once') return input.runAt ?? null;
  if (input.kind === 'interval') return now + (input.intervalMinutes ?? 60) * MIN;
  if (input.kind === 'after') return null;
  const [hours, minutes] = (input.timeOfDay ?? '09:00').split(':').map(Number);
  const at = new Date(now);
  at.setHours(hours, minutes, 0, 0);
  return at.getTime() > now ? at.getTime() : at.getTime() + 24 * HOUR;
}

function fromInput(ctx: DemoContext, input: ScheduleInput, before?: TaskSchedule): TaskSchedule {
  const now = ctx.host.now();
  const target = titleOf(ctx.state, ctx.deviceId, input.sessionId);
  if (!target) throw new Error('That thread no longer exists.');
  const watch = input.watchSessionId ? titleOf(ctx.state, ctx.deviceId, input.watchSessionId) : undefined;
  const prompt = input.prompt.trim();
  return {
    id: before?.id ?? `sch-${now.toString(36)}`, sessionId: target.sessionId, sessionTitle: target.title, projectId: target.projectId, projectName: target.projectName,
    title: input.title.trim() || prompt.split('\n')[0].slice(0, 60), prompt, kind: input.kind, intervalMinutes: input.intervalMinutes ?? null,
    timeOfDay: input.timeOfDay ?? null, days: input.days ?? [], watchSessionId: watch?.sessionId ?? null, watchSessionTitle: watch?.title ?? null,
    onlyOnSuccess: !!input.onlyOnSuccess, nextRunAt: nextRun(input, now), lastRunAt: before?.lastRunAt ?? null, enabled: before?.enabled ?? true,
    createdBy: before?.createdBy ?? 'user', createdBySession: before?.createdBySession ?? null, runCount: before?.runCount ?? 0, maxRuns: input.maxRuns ?? null,
    // As the host: an edit that leaves the workflow fields out keeps the schedule's own.
    workflowId: input.workflowId !== undefined ? input.workflowId : before?.workflowId ?? null,
    chainFromId: input.chainFromId !== undefined ? input.chainFromId : before?.chainFromId ?? null,
    createdAt: before?.createdAt ?? now, updatedAt: now,
  };
}

// Run now sends the prompt to its thread, which answers with the demo reply.
function runNow(ctx: DemoContext, p: { scheduleId: string }) {
  const schedule = find(ctx, p.scheduleId);
  const now = ctx.host.now();
  const run: ScheduleRun = { id: `${schedule.id}-${now}`, scheduleId: schedule.id, sessionId: schedule.sessionId, title: schedule.title, at: now, outcome: 'started', detail: '', sequence: schedule.runCount + 1, manual: true };
  const current = data(ctx);
  save(ctx, { schedules: current.schedules.map(s => (s.id === schedule.id ? { ...s, runCount: s.runCount + 1, lastRunAt: now } : s)), runs: [run, ...current.runs] });
  ctx.host.set(next => sent(next, ctx.deviceId, schedule.sessionId, schedule.prompt, now));
  ctx.reply(schedule.sessionId);
  return { run };
};

export const handlers: DemoHandlers = {
  'schedules.list': (ctx, p) => {
    const schedules = data(ctx).schedules.filter(s => !p?.sessionId || s.sessionId === p.sessionId).map(withCadence);
    return { schedules, paused: false, truncated: false };
  },
  'schedules.runs': (ctx, p) => {
    const runs = data(ctx).runs.filter(r => (!p?.scheduleId || r.scheduleId === p.scheduleId) && (!p?.sessionId || r.sessionId === p.sessionId)).slice(0, p?.limit ?? 50);
    return { runs, truncated: false };
  },
  'schedules.runNow': runNow,
  'schedules.setEnabled': (ctx, p) => ({ schedule: withCadence(replace(ctx, { ...find(ctx, p.scheduleId), enabled: !!p.enabled, updatedAt: ctx.host.now() })) }),
  'schedules.snooze': (ctx, p) => {
    const schedule = find(ctx, p.scheduleId);
    if (!schedule.enabled || schedule.nextRunAt === null) throw new Error('This schedule has no upcoming run to snooze.');
    return { schedule: withCadence(replace(ctx, { ...schedule, nextRunAt: Math.max(schedule.nextRunAt, ctx.host.now()) + Number(p.minutes) * MIN })) };
  },
  'schedules.create': (ctx, p) => {
    const schedule = fromInput(ctx, p.input as ScheduleInput);
    const current = data(ctx);
    save(ctx, { ...current, schedules: [schedule, ...current.schedules] });
    return { schedule: withCadence(schedule) };
  },
  'schedules.update': (ctx, p) => ({ schedule: withCadence(replace(ctx, fromInput(ctx, p.input as ScheduleInput, find(ctx, p.scheduleId)))) }),
  'schedules.delete': (ctx, p) => {
    const current = data(ctx);
    find(ctx, p.scheduleId);
    save(ctx, { ...current, schedules: current.schedules.filter(s => s.id !== p.scheduleId) });
    return {};
  },
};
