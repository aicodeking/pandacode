// Pure parts of the New/Edit schedule sheet (src/app/new-schedule.tsx): picker options that keep a
// saved schedule's own thread, watched thread and one-off time when the recent lists don't hold them,
// and whether an edit has its schedule yet. No React Native imports, so tests run under Node.
import { watchable, type TaskSchedule } from '../store/schedules.ts';

export interface PickOption { value: string; label: string }

const HOUR = 3_600_000;
const UNTITLED = 'Untitled thread';

/** A one-off preset: a label and how many hours from now. */
export interface OncePreset { label: string; hours: number }

/** `options` with `{ value, label }` appended when `value` is set and not already offered. */
export function withSaved(options: readonly PickOption[], value: string | null | undefined, label: string | null | undefined): PickOption[] {
  if (!value || options.some(o => o.value === value)) return [...options];
  return [...options, { value, label: label?.trim() || UNTITLED }];
}

type Listed = { sessionId: string; projectId: string; title: string };

/** Threads to send to: the recent list, plus the edited schedule's own thread when it isn't listed. */
export function threadOptions(tasks: readonly Listed[], saved?: Pick<TaskSchedule, 'sessionId' | 'sessionTitle'>): PickOption[] {
  return withSaved(tasks.map(t => ({ value: t.sessionId, label: t.title || UNTITLED })), saved?.sessionId, saved?.sessionTitle);
}

/** Threads an `after` schedule on `sessionId` may watch, plus the saved watched thread while the
 * schedule still targets its saved thread (another thread may sit in another project). */
export function watchOptions(tasks: readonly Listed[], sessionId: string, saved?: Pick<TaskSchedule, 'sessionId' | 'watchSessionId' | 'watchSessionTitle'>): PickOption[] {
  const listed = watchable(tasks, sessionId).map(t => ({ value: t.sessionId, label: t.title || UNTITLED }));
  if (!saved || saved.sessionId !== sessionId || saved.watchSessionId === sessionId) return listed;
  return withSaved(listed, saved.watchSessionId, saved.watchSessionTitle);
}

/** The one-off picker off iOS: presets from `now`, and the selected value. A saved time no preset
 * matches (within half an hour) is offered first as `Keep: <date>` and selected, so opening an edit
 * doesn't show "In 1 hour" for it. */
export function onceChoice(presets: readonly OncePreset[], now: number, runAt: number, keep: boolean, format: (at: number) => string): { options: PickOption[]; value: string } {
  const options = presets.map(p => ({ value: String(now + p.hours * HOUR), label: p.label }));
  const match = options.find(o => Math.abs(Number(o.value) - runAt) < HOUR / 2);
  if (match) return { options, value: match.value };
  if (keep && Number.isFinite(runAt)) {
    const kept = { value: String(runAt), label: `Keep: ${format(runAt)}` };
    return { options: [kept, ...options], value: kept.value };
  }
  return { options, value: options[0]?.value ?? '' };
}

/** An edit (`id` set) is `loading` until the schedule list arrives, then `ready` or `missing`. */
export type EditState = 'new' | 'loading' | 'ready' | 'missing';

export function editState(id: string | undefined, listLoaded: boolean, found: boolean): EditState {
  if (!id) return 'new';
  if (found) return 'ready';
  return listLoaded ? 'missing' : 'loading';
}
