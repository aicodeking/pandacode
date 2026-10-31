// The relay socket's reconnect waits (src/connect/socket.ts); pure so tests can import it.
// Same as the desktop's socket.rs `backoff`.
export const STABLE_MS = 30_000;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
const REPLACED = 4000;
export const REVOKED = 4001;

/** (wait now, base for the next failure), or null to stop (revoked). The first retry after a
 * stable socket goes at once, then 1 s, 2 s, 4 s… up to a minute. */
export function backoff(delay: number, outcome: { opened: boolean; upMs: number; code?: number }): [number, number] | null {
  if (outcome.code === REVOKED) return null;
  const base = outcome.opened && outcome.upMs >= STABLE_MS ? 0 : delay;
  const wait = outcome.code === REPLACED ? Math.max(base, MAX_BACKOFF_MS) : base;
  return [wait, Math.min(Math.max(base * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS)];
}
