/** Browser-preview stand-in for the native scheduler (`src-tauri/src/schedules.rs`). In memory only.
 *  Tests can seed with `window.__schedules` / `window.__scheduleRuns` before the first call. */
import { cadence, TRACE_HEADER, type ScheduleInput, type ScheduleRun, type SchedulerSettings, type TaskSchedule } from './schedules-api';

export interface PreviewSchedulesHost {
  sessions(): { id: string; title: string; projectId: string }[];
  projects(): { id: string; name: string }[];
  emit(name: string, payload: unknown): void;
  /** Delivers a fired schedule's message to its thread. */
  send(sessionId: string, text: string): Promise<void>;
}

const MINUTE = 60_000;
let schedules: TaskSchedule[] | null = null;
let runs: ScheduleRun[] = [];
let settings: SchedulerSettings = { agentsMaySchedule: true, askBeforeMessagingOtherTasks: true, paused: false, agentLimitPerTask: 10 };

function seed(host: PreviewSchedulesHost): TaskSchedule[] {
  const w = window as any;
  if (w.__schedules) { runs = w.__scheduleRuns ?? []; return w.__schedules; }
  const [first, second] = host.sessions();
  if (!first) return [];
  const now = Date.now();
  const base = { projectId: first.projectId, projectName: '', sessionTitle: '', watchSessionTitle: null, days: [] as number[], intervalMinutes: null, timeOfDay: null, watchSessionId: null, onlyOnSuccess: false, lastRunAt: null, enabled: true, createdBySession: null, runCount: 0, maxRuns: null, workflowId: null, chainFromId: null, createdAt: now - 3600_000, updatedAt: now - 3600_000 } as const;
  const list: TaskSchedule[] = [
    { ...base, id: 'sched-1', sessionId: first.id, title: 'Check the CI run', prompt: 'Check whether CI passed on this branch and fix anything red.', kind: 'once', nextRunAt: now + 12 * MINUTE, createdBy: 'agent', createdBySession: first.id, maxRuns: 1 },
    { ...base, id: 'sched-2', sessionId: first.id, title: 'Morning summary', prompt: 'Summarize what changed overnight.', kind: 'weekdays', timeOfDay: '09:00', nextRunAt: nextAt({ sessionId: first.id, title: '', prompt: '', kind: 'weekdays', timeOfDay: '09:00' }, now), createdBy: 'user', runCount: 4, lastRunAt: now - 8 * 60 * MINUTE },
  ];
  if (second) list.push({ ...base, id: 'sched-3', sessionId: second.id, projectId: second.projectId, title: 'Review after build', prompt: 'Review the build output and report regressions.', kind: 'after', watchSessionId: first.id, onlyOnSuccess: true, nextRunAt: null, createdBy: 'user' });
  runs = [{ id: 'run-1', scheduleId: 'sched-2', sessionId: first.id, title: 'Morning summary', at: now - 8 * 60 * MINUTE, outcome: 'started', detail: 'Woke the thread', sequence: 4, manual: false }];
  return list;
}

function decorate(host: PreviewSchedulesHost, schedule: TaskSchedule): TaskSchedule {
  const sessions = host.sessions(), session = sessions.find(s => s.id === schedule.sessionId);
  return {
    ...schedule,
    sessionTitle: session?.title ?? 'Task',
    projectId: session?.projectId ?? schedule.projectId,
    projectName: host.projects().find(p => p.id === (session?.projectId ?? schedule.projectId))?.name ?? '',
    watchSessionTitle: schedule.watchSessionId ? sessions.find(s => s.id === schedule.watchSessionId)?.title ?? 'Task' : null,
  };
}

function nextAt(input: ScheduleInput, now: number): number | null {
  const at = (hhmm: string, ok: (day: number) => boolean) => {
    const [h, m] = hhmm.split(':').map(Number);
    for (let i = 0; i < 8; i++) {
      const d = new Date(now); d.setDate(d.getDate() + i); d.setHours(h, m, 0, 0);
      if (d.getTime() > now && ok(d.getDay())) return d.getTime();
    }
    return null;
  };
  switch (input.kind) {
    case 'once': return input.runAt ?? null;
    case 'interval': return now + (input.intervalMinutes ?? 0) * MINUTE;
    case 'daily': return at(input.timeOfDay ?? '', () => true);
    case 'weekdays': return at(input.timeOfDay ?? '', day => day > 0 && day < 6);
    case 'weekly': return at(input.timeOfDay ?? '', day => (input.days ?? []).includes(day));
    case 'cron': case 'after': return null;
  }
}

function validate(input: ScheduleInput, now: number): void {
  if (!input.prompt?.trim()) throw new Error('A schedule needs a message: what should the thread be asked?');
  if (input.kind === 'interval' && !((input.intervalMinutes ?? 0) >= 5 && (input.intervalMinutes ?? 0) <= 10080)) throw new Error('Intervals are 5 minutes to a week.');
  if (['daily', 'weekdays', 'weekly'].includes(input.kind) && !/^([01]\d|2[0-3]):[0-5]\d$/.test(input.timeOfDay ?? '')) throw new Error('Times are HH:MM, 24-hour.');
  if (input.kind === 'cron' && (input.cron ?? '').trim().split(/\s+/).length !== 5) throw new Error('Write a cron expression: five fields (minute hour day-of-month month day-of-week).');
  const zone = input.timezone?.trim();
  // Aliases the browser's IANA list leaves out; anything else must be on the list,
  // which refuses invented names ("Mars/Olympus") like the native side does.
  if (zone && zone !== 'UTC' && zone !== 'GMT' && !(Intl as { supportedValuesOf?: (key: 'timeZone') => string[] }).supportedValuesOf?.('timeZone')?.includes(zone)) throw new Error(`Unknown timezone: ${zone}.`);
  if (input.kind === 'weekly' && !input.days?.length) throw new Error('Pick at least one day.');
  if (input.kind === 'once' && !(input.runAt && input.runAt > now - MINUTE)) throw new Error('Pick a time in the future.');
  if (input.kind === 'after' && (!input.watchSessionId || input.watchSessionId === input.sessionId)) throw new Error('Pick another task to follow.');
}

/** The native trace (`schedules.rs`) for a Run now: header, then labelled lines. */
function trace(s: TaskSchedule, sequence: number, now: number): string {
  const d = new Date(now), pad = (n: number) => String(n).padStart(2, '0');
  const by = s.createdBy === 'agent' ? 'this thread\'s agent' : 'the user';
  return [
    `${s.prompt}\n\n${TRACE_HEADER}: ${s.title}`,
    `Schedule ID: ${s.id} · ${cadence(s)} · run ${sequence}${s.maxRuns ? ` of ${s.maxRuns}` : ''} · set by ${by} · started with Run now`,
    // A Run now has no trigger of its own; the clock time is still useful to the agent.
    `Trigger: Run now · local time ${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`,
    ...(s.createdBy === 'agent' ? ['You set this earlier in this thread. Pick up where you left off; cancel it with pandacode_cancel_schedule if it is no longer needed.'] : []),
  ].join('\n');
}

export async function invokeSchedules<T>(command: string, args: Record<string, any>, host: PreviewSchedulesHost): Promise<T> {
  schedules ??= seed(host);
  const now = Date.now();
  const find = (id: string) => { const s = schedules!.find(item => item.id === id); if (!s) throw new Error('This schedule no longer exists.'); return s; };
  const replace = (next: TaskSchedule) => { schedules = schedules!.map(item => item.id === next.id ? next : item); host.emit('schedules-changed', { sessionId: next.sessionId }); return decorate(host, next) as T; };
  switch (command) {
    case 'schedules_list': return schedules.filter(s => !args.sessionId || s.sessionId === args.sessionId).map(s => decorate(host, s)).sort((a, b) => (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity)) as T;
    case 'schedule_create': case 'schedule_update': {
      const input: ScheduleInput = args.input;
      validate(input, now);
      const previous = command === 'schedule_update' ? find(args.scheduleId) : null;
      const next: TaskSchedule = decorate(host, {
        ...(previous ?? { id: `sched-${crypto.randomUUID()}`, createdBy: 'user', createdBySession: null, runCount: 0, lastRunAt: null, createdAt: now, enabled: true }),
        sessionId: input.sessionId, title: input.title.trim() || input.prompt.trim().slice(0, 60), prompt: input.prompt.trim(), kind: input.kind,
        intervalMinutes: input.intervalMinutes ?? null, timeOfDay: input.timeOfDay ?? null, cron: input.cron ?? null, timezone: input.timezone?.trim() || null,
        days: input.days ?? [], watchSessionId: input.watchSessionId ?? null,
        onlyOnSuccess: input.onlyOnSuccess ?? false, maxRuns: input.maxRuns ?? null, nextRunAt: nextAt(input, now), updatedAt: now,
        workflowId: input.workflowId ?? previous?.workflowId ?? null, chainFromId: input.chainFromId ?? previous?.chainFromId ?? null,
      } as TaskSchedule);
      if (previous) return replace(next);
      schedules = [...schedules, next]; host.emit('schedules-changed', { sessionId: next.sessionId });
      return next as T;
    }
    case 'schedule_set_enabled': return replace({ ...find(args.scheduleId), enabled: args.enabled, updatedAt: now });
    case 'schedule_snooze': { const s = find(args.scheduleId); return replace({ ...s, nextRunAt: Math.max(s.nextRunAt ?? now, now) + args.minutes * MINUTE, updatedAt: now }); }
    case 'schedule_delete': { const s = find(args.scheduleId); schedules = schedules.filter(item => item.id !== s.id); host.emit('schedules-changed', { sessionId: s.sessionId }); return undefined as T; }
    case 'schedule_run_now': {
      const s = find(args.scheduleId);
      const run: ScheduleRun = { id: `run-${crypto.randomUUID()}`, scheduleId: s.id, sessionId: s.sessionId, title: s.title, at: now, outcome: 'started', detail: 'Woke the thread', sequence: s.runCount + 1, manual: true };
      runs = [run, ...runs];
      // Like the native advance: a once schedule is spent after it runs, and so is one at its run limit.
      const spent = s.kind === 'once' || (s.maxRuns !== null && s.runCount + 1 >= s.maxRuns);
      replace({ ...s, runCount: s.runCount + 1, lastRunAt: now, ...(spent ? { enabled: false, nextRunAt: null } : {}) });
      await host.send(s.sessionId, trace(s, run.sequence, now));
      return run as T;
    }
    case 'schedule_runs': return runs.filter(r => (!args.sessionId || r.sessionId === args.sessionId) && (!args.scheduleId || r.scheduleId === args.scheduleId)).slice(0, args.limit ?? 50) as T;
    case 'scheduler_settings': return settings as T;
    case 'scheduler_set_settings': settings = { ...args.settings }; host.emit('schedules-changed', { sessionId: null }); return settings as T;
  }
  throw new Error(`Preview has no ${command}.`);
}
