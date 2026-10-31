// Background thread prefetch: which threads to copy ahead (running, then waiting, then the most
// recent few) and a one-at-a-time queue that holds while the user opens a thread or sends, since
// the host answers one phone's requests in order. Pure: tests/prefetch.test.ts covers it.
import type { TaskSummary } from '../connect/types.ts';

export const RECENT = 5;
/** A thread copied this recently is skipped when the list can't say whether it changed. */
export const FRESH_MS = 2 * 60_000;

/** What the phone already holds of a thread: its newest id and when it was last copied. */
export interface Known { lastId: number; at: number }

/** taskKeys to prefetch in priority order, each once, skipping threads already current. */
export function prefetchOrder(lists: { deviceId: string; tasks: TaskSummary[] }[], known: (key: string) => Known | undefined, now: number, recent = RECENT): string[] {
  const all = lists.flatMap(l => l.tasks.map(task => ({ key: `${l.deviceId}/${task.sessionId}`, task })));
  const ranked = [
    ...all.filter(t => t.task.status === 'running'),
    ...all.filter(t => t.task.status === 'waiting'),
    ...lists.flatMap(l => l.tasks.slice(0, recent).map(task => ({ key: `${l.deviceId}/${task.sessionId}`, task }))),
  ];
  const current = ({ key, task }: (typeof all)[number]) => {
    const have = known(key);
    if (!have) return false;
    return typeof task.lastId === 'number' ? have.lastId >= task.lastId : now - have.at < FRESH_MS;
  };
  return [...new Set(ranked.filter(t => !current(t)).map(t => t.key))];
}

/** Runs keys one at a time, newest list first; `hold` pauses it (between requests) until every reason is released. */
export class PrefetchQueue {
  private keys: string[] = [];
  private readonly holds = new Set<string>();
  private busy = false;
  private readonly run: (key: string) => Promise<unknown>;

  constructor(run: (key: string) => Promise<unknown>) {
    this.run = run;
  }

  /** A new order replaces whatever was still waiting. */
  replace(keys: string[]) {
    this.keys = [...keys];
    this.pump();
  }

  hold(reason: string) { this.holds.add(reason); }

  release(reason: string) {
    if (this.holds.delete(reason)) this.pump();
  }

  get waiting(): readonly string[] { return this.keys; }
  get paused() { return this.holds.size > 0; }

  private pump() {
    if (this.busy || this.paused || !this.keys.length) return;
    const [key, ...rest] = this.keys;
    this.keys = rest;
    this.busy = true;
    void this.run(key).catch(() => undefined).finally(() => {
      this.busy = false;
      this.pump();
    });
  }
}
