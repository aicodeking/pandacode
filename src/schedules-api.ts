/** Task schedules: wake-ups and timed messages that agents or the user set for a thread.
 *  This file is the IPC contract with `src-tauri/src/schedules.rs`; keep both in step. */
import { call } from './bridge';

/** once: at runAt · interval: every intervalMinutes · daily/weekdays: at timeOfDay ·
 *  weekly: at timeOfDay on `days` (0 = Sunday) · after: when watchSessionId's run ends. */
export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'after';
export type ScheduleOrigin = 'user' | 'agent';
export type RunOutcome = 'started' | 'queued' | 'skipped' | 'failed';

export interface TaskSchedule {
  id: string;
  /** The thread that receives the message. */
  sessionId: string;
  sessionTitle: string;
  projectId: string;
  projectName: string;
  title: string;
  /** What the thread is sent when the schedule fires. */
  prompt: string;
  kind: ScheduleKind;
  intervalMinutes: number | null;
  /** 24-hour HH:MM, local time. */
  timeOfDay: string | null;
  /** Weekly days, 0 = Sunday. Empty for other kinds. */
  days: number[];
  /** For `after`: the task whose run end fires this one. */
  watchSessionId: string | null;
  watchSessionTitle: string | null;
  /** For `after`: fire only when the watched run ended successfully. */
  onlyOnSuccess: boolean;
  nextRunAt: number | null;
  lastRunAt: number | null;
  enabled: boolean;
  createdBy: ScheduleOrigin;
  /** The agent's thread that created it, when createdBy is agent. */
  createdBySession: string | null;
  runCount: number;
  /** Stops after this many runs; null runs until removed. */
  maxRuns: number | null;
  /** Steps saved together by the workflow builder share this id (null for single schedules). */
  workflowId: string | null;
  /** For a workflow's `after` step: the previous step. The step fires only when the watched
   *  thread's run ends after that previous step fired since this one last ran. */
  chainFromId: string | null;
  createdAt: number;
  updatedAt: number;
}

export interface ScheduleRun {
  id: string;
  scheduleId: string;
  sessionId: string;
  /** Schedule title at the time it fired (the schedule may be gone). */
  title: string;
  at: number;
  outcome: RunOutcome;
  /** Short human reason, e.g. "Queued behind the running turn" or "Task is archived". */
  detail: string;
  /** Run number of the schedule, from 1. */
  sequence: number;
  /** True for Run now, false when the clock or a trigger fired it. */
  manual: boolean;
}

export interface ScheduleInput {
  sessionId: string;
  title: string;
  prompt: string;
  kind: ScheduleKind;
  intervalMinutes?: number | null;
  timeOfDay?: string | null;
  days?: number[];
  /** For once: absolute time in ms. */
  runAt?: number | null;
  watchSessionId?: string | null;
  onlyOnSuccess?: boolean;
  maxRuns?: number | null;
  workflowId?: string | null;
  chainFromId?: string | null;
}

export interface SchedulerSettings {
  /** Agents get the pandacode_schedule_* tools. */
  agentsMaySchedule: boolean;
  /** Agent-created schedules for other threads ask first (self wake-ups never do). */
  askBeforeMessagingOtherTasks: boolean;
  /** Holds every schedule without deleting it; due runs wait until resumed. */
  paused: boolean;
  /** Active agent-created schedules allowed per thread. */
  agentLimitPerTask: number;
}

export const schedulesApi = {
  list: (sessionId: string | null = null) => call<TaskSchedule[]>('schedules_list', { sessionId }),
  create: (input: ScheduleInput) => call<TaskSchedule>('schedule_create', { input }),
  update: (scheduleId: string, input: ScheduleInput) => call<TaskSchedule>('schedule_update', { scheduleId, input }),
  setEnabled: (scheduleId: string, enabled: boolean) => call<TaskSchedule>('schedule_set_enabled', { scheduleId, enabled }),
  remove: (scheduleId: string) => call<void>('schedule_delete', { scheduleId }),
  runNow: (scheduleId: string) => call<ScheduleRun>('schedule_run_now', { scheduleId }),
  /** Pushes the next run back by minutes (once and clock kinds). */
  snooze: (scheduleId: string, minutes: number) => call<TaskSchedule>('schedule_snooze', { scheduleId, minutes }),
  runs: (filter: { sessionId?: string | null; scheduleId?: string | null; limit?: number } = {}) =>
    call<ScheduleRun[]>('schedule_runs', { sessionId: filter.sessionId ?? null, scheduleId: filter.scheduleId ?? null, limit: filter.limit ?? 50 }),
  settings: () => call<SchedulerSettings>('scheduler_settings'),
  setSettings: (settings: SchedulerSettings) => call<SchedulerSettings>('scheduler_set_settings', { settings }),
};

/** A one-off that ran, or a schedule that used all its runs: done, not paused. Resuming it is refused natively. */
export function isFinished(s: Pick<TaskSchedule, 'enabled' | 'kind' | 'runCount' | 'maxRuns'>): boolean {
  return !s.enabled && ((s.kind === 'once' && s.runCount > 0) || (s.maxRuns !== null && s.runCount >= s.maxRuns));
}

/** Event `schedules-changed` carries `{ sessionId: string | null }` (null = many threads). */
export const SCHEDULES_CHANGED = 'schedules-changed';

/** First line of the folded block a fired schedule appends to its message. Matches native `TRACE_HEADER`. */
export const TRACE_HEADER = 'Scheduled wake-up (PandaCode scheduler)';

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
// One clock format everywhere: "9:00 AM" or "09:00" as the locale writes it, never a forced 2-digit hour.
const CLOCK = new Intl.DateTimeFormat([], { hour: 'numeric', minute: '2-digit' });

/** A local time of day in the user's clock format: `clockAt(ms)` → "6:30 PM". */
export function clockAt(at: number): string { return CLOCK.format(at); }
/** A 24-hour "HH:MM" in the user's clock format: "09:00" → "9:00 AM". */
export function clockTime(hhmm: string): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return hhmm;
  const date = new Date(); date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return clockAt(date.getTime());
}

/** "Once", "Every 30 min", "Daily at 9:00 AM", "Weekdays at 9:00 AM", "Weekly on Mon, Wed at 6:30 PM",
 *  "After “Build” finishes". Only the first letter is capital, so callers may lowercase it mid-sentence. */
export function cadence(schedule: Pick<TaskSchedule, 'kind' | 'intervalMinutes' | 'timeOfDay' | 'days' | 'watchSessionTitle' | 'onlyOnSuccess'>): string {
  const time = clockTime(schedule.timeOfDay ?? '');
  switch (schedule.kind) {
    case 'once': return 'Once';
    case 'interval': {
      const minutes = schedule.intervalMinutes ?? 0;
      return minutes % 1440 === 0 ? `Every ${minutes / 1440 === 1 ? 'day' : `${minutes / 1440} days`}`
        : minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `Every ${minutes} min`;
    }
    case 'daily': return `Daily at ${time}`;
    case 'weekdays': return `Weekdays at ${time}`;
    case 'weekly': return `Weekly on ${[...schedule.days].sort().map(day => DAY_NAMES[day]).join(', ')} at ${time}`;
    case 'after': return `After “${schedule.watchSessionTitle ?? 'a thread'}” ${schedule.onlyOnSuccess ? 'succeeds' : 'finishes'}`;
  }
}

/** "in 12 min", "in 3 h", "tomorrow 9:00 AM", "Fri 6:30 PM", "now", "5 min ago". */
export function when(at: number | null, now = Date.now()): string {
  if (at === null) return '';
  const minutes = Math.round((at - now) / 60_000);
  if (Math.abs(minutes) < 1) return 'now';
  if (minutes < 0) return -minutes < 60 ? `${-minutes} min ago` : -minutes < 1440 ? `${Math.round(-minutes / 60)} h ago` : `${Math.round(-minutes / 1440)} d ago`;
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 6 * 60) return `in ${Math.round(minutes / 6) / 10} h`.replace('.0 ', ' ');
  const date = new Date(at), today = new Date(now);
  const time = clockAt(at);
  const days = Math.round((new Date(date).setHours(0, 0, 0, 0) - new Date(today).setHours(0, 0, 0, 0)) / 86_400_000);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${DAY_NAMES[date.getDay()]} ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}
