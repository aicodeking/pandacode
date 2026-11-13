// Task schedules on the phone: the desktop's types (src/schedules-api.ts), its cadence and "when"
// wording, and the New schedule sheet's cadence choices and checks, which mirror the host's
// (src-tauri/src/schedules.rs `validate`) so a mistake is caught before the call, and the
// create-once retry. Loads in node (tested there).
import { MAY_HAVE_RUN, runOnce } from '../connect/api/github.ts';
import { uuid } from '../connect/crypto.ts';
import { draftStartId, type DraftStart } from '../connect/start-retry.ts';

export type ScheduleKind = 'once' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'after';
export type RunOutcome = 'started' | 'queued' | 'skipped' | 'failed';

export interface TaskSchedule {
  id: string; sessionId: string; sessionTitle: string; projectId: string; projectName: string;
  title: string; prompt: string; kind: ScheduleKind; intervalMinutes: number | null; timeOfDay: string | null; days: number[];
  watchSessionId: string | null; watchSessionTitle: string | null; onlyOnSuccess: boolean;
  nextRunAt: number | null; lastRunAt: number | null; enabled: boolean; createdBy: 'user' | 'agent'; createdBySession: string | null;
  runCount: number; maxRuns: number | null; workflowId: string | null; chainFromId: string | null; createdAt: number; updatedAt: number;
  /** The host's own cadence words (24-hour); the phone writes its own with `cadence`. */
  cadence?: string;
}

export interface ScheduleRun { id: string; scheduleId: string; sessionId: string; title: string; at: number; outcome: RunOutcome; detail: string; sequence: number; manual: boolean }

export interface ScheduleInput {
  sessionId: string; title: string; prompt: string; kind: ScheduleKind;
  intervalMinutes?: number | null; timeOfDay?: string | null; days?: number[]; runAt?: number | null;
  watchSessionId?: string | null; onlyOnSuccess?: boolean; maxRuns?: number | null;
  /** Left out, an edit keeps the schedule's own workflow and chain (the host's `keep_chain`). */
  workflowId?: string | null; chainFromId?: string | null;
}

export const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'] as const;
const MINUTE = 60_000;
const DAY = 1440 * MINUTE;
export const MIN_INTERVAL = 5;
export const MAX_INTERVAL = 7 * 1440;
export const MAX_TITLE = 120;
/** The host's limit for remote text (MAX_TEXT). */
export const MAX_PROMPT_BYTES = 100 * 1024;

/** The kinds the sheet offers, in the desktop's order. */
export const KINDS: readonly { value: ScheduleKind; label: string }[] = [
  { value: 'once', label: 'Once' }, { value: 'interval', label: 'Repeat' }, { value: 'daily', label: 'Daily' },
  { value: 'weekdays', label: 'Weekdays' }, { value: 'weekly', label: 'Weekly' }, { value: 'after', label: 'After' },
];
/** Interval choices, all within the host's 5 minutes to 7 days. */
export const INTERVALS: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: 'Every 15 min' }, { minutes: 30, label: 'Every 30 min' }, { minutes: 60, label: 'Every hour' },
  { minutes: 120, label: 'Every 2 hours' }, { minutes: 360, label: 'Every 6 hours' }, { minutes: 720, label: 'Every 12 hours' }, { minutes: 1440, label: 'Every day' },
];
export const SNOOZES: readonly { minutes: number; label: string }[] = [
  { minutes: 15, label: '15 minutes' }, { minutes: 60, label: '1 hour' }, { minutes: 240, label: '4 hours' }, { minutes: 1440, label: '1 day' },
];

const pad = (n: number) => String(n).padStart(2, '0');
/** "HH:MM" for a Date's local time. */
export const timeOf = (date: Date) => `${pad(date.getHours())}:${pad(date.getMinutes())}`;

/** "9:00 AM" or "09:00" as the locale writes it; anything that isn't HH:MM comes back as is. */
export function clockTime(hhmm: string, format: (at: number) => string = clockAt): string {
  const match = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!match) return hhmm;
  const date = new Date();
  date.setHours(Number(match[1]), Number(match[2]), 0, 0);
  return format(date.getTime());
}
export const clockAt = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });

type CadenceFields = Pick<TaskSchedule, 'kind' | 'intervalMinutes' | 'timeOfDay' | 'days' | 'watchSessionTitle' | 'onlyOnSuccess'>;

/** The desktop's cadence words: "Every 30 min", "Weekdays at 9:00 AM", "After “Build” finishes". */
export function cadence(s: CadenceFields, format?: (at: number) => string): string {
  const time = clockTime(s.timeOfDay ?? '', format);
  switch (s.kind) {
    case 'once': return 'Once';
    case 'interval': {
      const minutes = s.intervalMinutes ?? 0;
      return minutes % 1440 === 0 ? `Every ${minutes / 1440 === 1 ? 'day' : `${minutes / 1440} days`}`
        : minutes % 60 === 0 ? `Every ${minutes / 60 === 1 ? 'hour' : `${minutes / 60} hours`}` : `Every ${minutes} min`;
    }
    case 'daily': return `Daily at ${time}`;
    case 'weekdays': return `Weekdays at ${time}`;
    case 'weekly': return `Weekly on ${[...s.days].sort((a, b) => a - b).map(day => DAY_NAMES[day]).join(', ')} at ${time}`;
    case 'after': return `After “${s.watchSessionTitle ?? 'a thread'}” ${s.onlyOnSuccess ? 'succeeds' : 'finishes'}`;
  }
}

/** "in 12 min", "in 3 h", "tomorrow 9:00 AM", "Fri 6:30 PM", "now", "5 min ago"; '' for none. */
export function when(at: number | null, now = Date.now(), format: (at: number) => string = clockAt): string {
  if (at === null) return '';
  const minutes = Math.round((at - now) / MINUTE);
  if (Math.abs(minutes) < 1) return 'now';
  if (minutes < 0) return -minutes < 60 ? `${-minutes} min ago` : -minutes < 1440 ? `${Math.round(-minutes / 60)} h ago` : `${Math.round(-minutes / 1440)} d ago`;
  if (minutes < 60) return `in ${minutes} min`;
  if (minutes < 6 * 60) return `in ${Math.round(minutes / 6) / 10} h`;
  const date = new Date(at);
  const days = Math.round((new Date(at).setHours(0, 0, 0, 0) - new Date(now).setHours(0, 0, 0, 0)) / DAY);
  const time = format(at);
  if (days === 0) return `today ${time}`;
  if (days === 1) return `tomorrow ${time}`;
  if (days < 7) return `${DAY_NAMES[date.getDay()]} ${time}`;
  return `${date.toLocaleDateString([], { month: 'short', day: 'numeric' })} ${time}`;
}

/** A one-off that ran, or a schedule that used all its runs: done, not paused (the host refuses to resume it). */
export function isFinished(s: Pick<TaskSchedule, 'enabled' | 'kind' | 'runCount' | 'maxRuns'>): boolean {
  return !s.enabled && ((s.kind === 'once' && s.runCount > 0) || (s.maxRuns !== null && s.runCount >= s.maxRuns));
}

/** The list line under a schedule's title: next run, else why there is none. */
export function nextLine(s: TaskSchedule, now = Date.now(), format?: (at: number) => string): string {
  if (isFinished(s)) return 'Finished';
  if (!s.enabled) return 'Off';
  if (s.kind === 'after') return s.nextRunAt !== null ? `Next ${when(s.nextRunAt, now, format)}` : 'Waiting for its trigger';
  return s.nextRunAt !== null ? `Next ${when(s.nextRunAt, now, format)}` : '';
}

/** Schedules for the list: on ones by next run, then off, then finished; newest first within each. */
export function sortSchedules(list: readonly TaskSchedule[]): TaskSchedule[] {
  const rank = (s: TaskSchedule) => (isFinished(s) ? 2 : s.enabled ? 0 : 1);
  return [...list].sort((a, b) => rank(a) - rank(b) || (a.nextRunAt ?? Infinity) - (b.nextRunAt ?? Infinity) || b.createdAt - a.createdAt);
}

export const OUTCOME_LABEL: Record<RunOutcome, string> = { started: 'Sent', queued: 'Queued', skipped: 'Skipped', failed: 'Failed' };

/** What the New schedule sheet holds. */
export interface ScheduleDraft {
  sessionId: string; title: string; prompt: string; kind: ScheduleKind;
  intervalMinutes: number; timeOfDay: string; days: number[]; runAt: number;
  watchSessionId: string; onlyOnSuccess: boolean; maxRuns: string;
}

export function emptyDraft(now = Date.now(), sessionId = ''): ScheduleDraft {
  // A one-off defaults to the next whole hour; clock kinds to 09:00.
  const next = new Date(now);
  next.setMinutes(0, 0, 0);
  next.setHours(next.getHours() + 1);
  return { sessionId, title: '', prompt: '', kind: 'daily', intervalMinutes: 60, timeOfDay: '09:00', days: [1], runAt: next.getTime(), watchSessionId: '', onlyOnSuccess: false, maxRuns: '' };
}

const bytes = (text: string) => new TextEncoder().encode(text).length;

/** The host's input for a draft, or the reason it would be refused (same words as the host where they overlap). */
export function draftInput(d: ScheduleDraft, now = Date.now()): { input: ScheduleInput } | { error: string } {
  if (!d.sessionId) return { error: 'Pick the thread to send it to.' };
  const prompt = d.prompt.trim();
  if (!prompt) return { error: 'Write the message the thread should be sent.' };
  if (bytes(prompt) > MAX_PROMPT_BYTES) return { error: 'Keep the message under 100 KB.' };
  const title = d.title.trim();
  if ([...title].length > MAX_TITLE) return { error: 'Keep the title under 120 characters.' };
  let maxRuns: number | null = null;
  if (d.maxRuns.trim()) {
    maxRuns = Number(d.maxRuns.trim());
    if (!Number.isInteger(maxRuns) || maxRuns < 1 || maxRuns > 1000) return { error: 'Max runs must be 1 to 1000, or empty to run until removed.' };
  }
  // No workflowId/chainFromId: the phone can't change them, and left out an edit keeps the
  // schedule's own (the host's `keep_chain`), so a stale copy never undoes a desktop edit.
  const base = { sessionId: d.sessionId, title, prompt, kind: d.kind, maxRuns };
  switch (d.kind) {
    case 'once':
      if (d.runAt < now - MINUTE) return { error: 'That time has already passed.' };
      if (d.runAt > now + 366 * DAY) return { error: 'Schedule one-off runs within a year.' };
      return { input: { ...base, runAt: d.runAt } };
    case 'interval':
      if (!Number.isInteger(d.intervalMinutes) || d.intervalMinutes < MIN_INTERVAL || d.intervalMinutes > MAX_INTERVAL) return { error: 'Intervals are 5 minutes to 7 days (10080 minutes).' };
      return { input: { ...base, intervalMinutes: d.intervalMinutes } };
    case 'daily':
    case 'weekdays':
    case 'weekly': {
      if (!/^([01]?\d|2[0-3]):[0-5]\d$/.test(d.timeOfDay)) return { error: 'Use a 24-hour local time like 09:30.' };
      if (d.kind !== 'weekly') return { input: { ...base, timeOfDay: d.timeOfDay } };
      const days = [...new Set(d.days)].sort((a, b) => a - b);
      if (!days.length) return { error: 'Pick at least one day for a weekly schedule.' };
      if (days.some(day => !Number.isInteger(day) || day < 0 || day > 6)) return { error: 'Days are 0 (Sunday) to 6 (Saturday).' };
      return { input: { ...base, timeOfDay: d.timeOfDay, days } };
    }
    case 'after':
      if (!d.watchSessionId) return { error: 'Pick the thread whose run should trigger this one.' };
      if (d.watchSessionId === d.sessionId) return { error: 'A thread cannot wake itself after its own run; pick another thread to watch.' };
      return { input: { ...base, watchSessionId: d.watchSessionId, onlyOnSuccess: d.onlyOnSuccess } };
  }
}

/** A draft from an existing schedule, for editing. */
export function draftOf(s: TaskSchedule, now = Date.now()): ScheduleDraft {
  const empty = emptyDraft(now, s.sessionId);
  return {
    ...empty, title: s.title, prompt: s.prompt, kind: s.kind,
    intervalMinutes: s.intervalMinutes ?? empty.intervalMinutes, timeOfDay: s.timeOfDay ?? empty.timeOfDay,
    days: s.days.length ? s.days : empty.days, runAt: s.kind === 'once' && s.nextRunAt !== null ? s.nextRunAt : empty.runAt,
    watchSessionId: s.watchSessionId ?? '', onlyOnSuccess: s.onlyOnSuccess, maxRuns: s.maxRuns === null ? '' : String(s.maxRuns),
  };
}

/** Same-project threads that may be watched by an `after` schedule on `sessionId`. */
export function watchable<T extends { sessionId: string; projectId: string }>(tasks: readonly T[], sessionId: string): T[] {
  const target = tasks.find(t => t.sessionId === sessionId);
  return target ? tasks.filter(t => t.sessionId !== sessionId && t.projectId === target.projectId) : [];
}

export const NO_SCHEDULE = 'The computer sent no schedule.';

/** The last create's `sendId`, kept while its draft may still be on the host. */
let lastCreate: DraftStart | null = null;

/** The `sendId` for creating `input` on `deviceId`: the last attempt's while the draft is unchanged, else a new one. */
export function createSendId(deviceId: string, input: ScheduleInput, fresh: () => string = uuid): string {
  lastCreate = draftStartId(lastCreate, `${deviceId}\n${JSON.stringify(input)}`, fresh);
  return lastCreate.id;
}

/**
 * Creates a schedule once (host.rs ONCE_METHODS): a lost reply is retried under the same
 * `sendId`, and saving the same draft again after "may have gone through" reuses it, so the
 * host answers the first schedule instead of making a second. `call` is the host call.
 */
export async function createScheduleWith(
  call: (params: Record<string, unknown>) => Promise<{ schedule?: TaskSchedule }>, dedupes: boolean, deviceId: string, input: ScheduleInput,
): Promise<TaskSchedule> {
  const sendId = createSendId(deviceId, input);
  try {
    const reply = await runOnce(id => call(id ? { input, sendId: id } : { input }), dedupes, sendId);
    lastCreate = null;
    if (!reply?.schedule) throw new Error(NO_SCHEDULE);
    return reply.schedule;
  } catch (error) {
    // The host answered (it remembers no refusal): the next save is a new attempt.
    if (!(error instanceof Error && error.message === MAY_HAVE_RUN)) lastCreate = null;
    throw error;
  }
}
