// The relay socket's reconnect waits (src/connect/socket.ts); pure so tests can import it.
// Same as the desktop's socket.rs `backoff`.
export const STABLE_MS = 30_000;
const FIRST_BACKOFF_MS = 1000;
const MAX_BACKOFF_MS = 60_000;
export const REPLACED = 4000;
/** Waits spread over 70–130 %, so phones that lost the relay together don't return together. */
export const JITTER = 0.3;
export const REVOKED = 4001;

/** (wait now, base for the next failure), or null to stop (revoked). The first retry after a
 * stable socket goes at once, then 1 s, 2 s, 4 s… up to a minute. */
export function backoff(delay: number, outcome: { opened: boolean; upMs: number; code?: number }): [number, number] | null {
  if (outcome.code === REVOKED) return null;
  const base = outcome.opened && outcome.upMs >= STABLE_MS ? 0 : delay;
  const wait = outcome.code === REPLACED ? Math.max(base, MAX_BACKOFF_MS) : base;
  return [wait, Math.min(Math.max(base * 2, FIRST_BACKOFF_MS), MAX_BACKOFF_MS)];
}

/** Spreads a wait over ±JITTER; `random` is in [0, 1] (injected so tests are deterministic). Zero stays zero. */
export function jitter(wait: number, random: number): number {
  const r = Math.min(1, Math.max(0, Number.isFinite(random) ? random : 0.5));
  return Math.round(wait * (1 - JITTER + 2 * JITTER * r));
}

/** `backoff` with the wait jittered. A replaced socket still waits at least the full minute (jitter
 * only ever lengthens it), so two phones on one account don't keep evicting each other. */
export function jitteredBackoff(
  delay: number,
  outcome: { opened: boolean; upMs: number; code?: number },
  random: number = Math.random(),
): [number, number] | null {
  const next = backoff(delay, outcome);
  if (!next) return null;
  const wait = jitter(next[0], random);
  return [outcome.code === REPLACED ? Math.max(wait, MAX_BACKOFF_MS) : wait, next[1]];
}
