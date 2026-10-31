// Optimistic edits for the phone's actions (stop, approve/deny, answer, pause a bot, task settings):
// client.ts applies one at once, sends the call, and on failure undoes only what the edit changed
// and nothing a newer update set since. Pure: tests/optimistic.test.ts.
import type { Live } from '../store/reduce.ts';
import type { Bot, PendingRequest, TaskSummary } from './types.ts';

export const STOPPING = 'Stopping…';

/** Applies the edit, runs `send`; if it throws, undoes the edit and rethrows. */
export async function attempt<T>(apply: () => () => void, send: () => Promise<T>): Promise<T> {
  const undo = apply();
  try {
    return await send();
  } catch (error) {
    undo();
    throw error;
  }
}

export const stopping = (live: Live): Live => ({ ...live, activity: STOPPING });
/** A failed stop: the activity it replaced, unless something newer replaced "Stopping…". */
export const unstopping = (live: Live, before: string): Live => (live.activity === STOPPING ? { ...live, activity: before } : live);

/** A failed answer: the request comes back (once) and the run waits again, unless the run ended meanwhile. */
export function unanswered(live: Live, request: PendingRequest, before: Live): Live {
  const list = request.kind === 'approval' ? 'approvals' : 'inputs';
  if (live[list].some(r => r.requestId === request.requestId) || (live.status !== 'running' && live.status !== 'waiting')) return live;
  return { ...live, [list]: [...live[list], request], status: 'waiting', activity: before.activity };
}

/** A failed pause/resume puts back the bot's paused and state, unless a newer list changed them. */
export function unpaused(bots: readonly Bot[], botId: string, paused: boolean, before: Pick<Bot, 'paused' | 'state'>): Bot[] {
  return bots.map(b => (b.id === botId && b.paused === paused ? { ...b, ...before } : b));
}

type Settings = Partial<Pick<TaskSummary, 'provider' | 'model' | 'effort' | 'mode'>>;

/** Task settings changed at once in the list. */
export const configured = (tasks: readonly TaskSummary[], sessionId: string, change: Settings): TaskSummary[] =>
  tasks.map(t => (t.sessionId === sessionId ? { ...t, ...change } : t));

/** A failed change: each field the change set goes back, unless a newer list changed it. */
export function unconfigured(tasks: readonly TaskSummary[], sessionId: string, change: Settings, before: Settings): TaskSummary[] {
  return tasks.map(t => {
    if (t.sessionId !== sessionId) return t;
    const back = Object.fromEntries(Object.entries(change).filter(([field, value]) => t[field as keyof Settings] === value).map(([field]) => [field, before[field as keyof Settings]]));
    return Object.keys(back).length ? { ...t, ...back } : t;
  });
}
