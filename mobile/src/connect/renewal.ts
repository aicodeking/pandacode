// Retries a host's failed subscribe (a renewal or a reconnect's) per host: 2 s, doubling to a
// minute, each wait jittered ±30 % so phones that failed together don't retry together. A
// success, or the socket closing (presence resubscribes), resets it. Pure: timers are injected.
import { jitter } from '../store/backoff.ts';

export const RETRY_FIRST_MS = 2000;
export const RETRY_MAX_MS = 60_000;

export interface RetryDeps {
  run: (host: string) => void;
  random?: () => number;
  setTimer?: (run: () => void, ms: number) => unknown;
  clearTimer?: (timer: unknown) => void;
}

export class RetryLater {
  private readonly waits = new Map<string, { timer: unknown | null; next: number }>();

  private readonly deps: RetryDeps;

  constructor(deps: RetryDeps) {
    this.deps = deps;
  }

  /** A failed round: schedules the next try unless one is already waiting. Returns the wait (ms). */
  failed(host: string): number | null {
    const entry = this.waits.get(host) ?? { timer: null, next: RETRY_FIRST_MS };
    if (entry.timer !== null) return null;
    const wait = jitter(entry.next, (this.deps.random ?? Math.random)());
    const setTimer = this.deps.setTimer ?? ((run: () => void, ms: number) => setTimeout(run, ms));
    const timer = setTimer(() => {
      const current = this.waits.get(host);
      if (current) this.waits.set(host, { ...current, timer: null });
      this.deps.run(host);
    }, wait);
    this.waits.set(host, { timer, next: Math.min(entry.next * 2, RETRY_MAX_MS) });
    return wait;
  }

  succeeded(host: string) {
    const entry = this.waits.get(host);
    if (entry?.timer != null) (this.deps.clearTimer ?? (t => clearTimeout(t as ReturnType<typeof setTimeout>)))(entry.timer);
    this.waits.delete(host);
  }

  clear() {
    for (const host of [...this.waits.keys()]) this.succeeded(host);
  }

  pending(host: string) { return this.waits.get(host)?.timer != null; }
}
