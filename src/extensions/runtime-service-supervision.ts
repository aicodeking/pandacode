/**
 * Supervision of background services (runtime slice R0106): the webview mirror of the native rules in
 * `src-tauri/src/extensions/runtime_service_supervision.rs` and a labelled preview stand-in on a simulated clock.
 *
 * The authority is native. A crash is restarted after 1 s, doubling per consecutive crash up to 60 s (crashes are
 * consecutive while each follows the previous one by less than ten minutes). Five crashes inside ten minutes park the
 * service until the user retries, enables or updates it. A start that never reached a process stays failed until
 * retried. A start still unsettled after ten seconds is reported as slow, never waited for. Memory is measured, never
 * capped, and there is no deadline. The browser preview runs no package code: its crashes are scripted.
 */
import type { ServiceEntry, ServiceLifetimeProjection } from './runtime-service-lifetime';

export const FIRST_BACKOFF_MS = 1_000;
export const MAX_BACKOFF_MS = 60_000;
export const CRASH_WINDOW_MS = 600_000;
export const PARK_AFTER = 5;
export const START_NOTICE_MS = 10_000;
export const EXPLANATION_LIMIT = 240;

/** The `supervision` object of a service in `extensions_service_lifetime`. */
export type ServiceSupervision = {
  crashes: number; backoffMs: number | null; restartInMs: number | null; parked: string | null;
  startup: { elapsedMs: number; slow: boolean; readyMs: number | null } | null;
  memory: { residentBytes: number; peakBytes: number; samples: number } | null;
};
export type CrashDecision = { kind: 'restart'; delayMs: number; atMs: number } | { kind: 'park'; explanation: string };
export type CrashHistory = { recent: { at: number; code: string }[]; streak: number; last: number | null };

/** The delay after the `streak`-th consecutive crash (1-based): 1 s, 2 s, 4 s … 60 s. */
export function backoffMs(streak: number): number {
  return Math.min(FIRST_BACKOFF_MS * 2 ** Math.min(Math.max(streak - 1, 0), 16), MAX_BACKOFF_MS);
}
export const createCrashHistory = (): CrashHistory => ({ recent: [], streak: 0, last: null });
/** Mirrors `CrashHistory::record`. */
export function recordCrash(history: CrashHistory, id: string, now: number, code: string): CrashDecision {
  if (history.last !== null && now - history.last >= CRASH_WINDOW_MS) history.streak = 0;
  history.last = now; history.streak += 1;
  history.recent = history.recent.filter(crash => now - crash.at < CRASH_WINDOW_MS);
  history.recent.push({ at: now, code });
  if (history.recent.length >= PARK_AFTER) return { kind: 'park', explanation: parkingExplanation(id, history.recent.map(crash => crash.code)) };
  const delayMs = backoffMs(history.streak);
  return { kind: 'restart', delayMs, atMs: now + delayMs };
}
/** Mirrors `explanation`: package id, count and host error codes (most frequent first), at most 240 characters. */
export function parkingExplanation(id: string, codes: string[]): string {
  const counts = new Map<string, number>();
  for (const code of codes) counts.set(code, (counts.get(code) ?? 0) + 1);
  const named = [...counts].sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0)).map(([code, count]) => count === 1 ? code : `${code} x${count}`).join(', ');
  const text = `The service of ${id} was parked after ${codes.length} crashes in 10 minutes (${named}). Retry, enable or update the package to start it again.`;
  const chars = [...text];
  return chars.length <= EXPLANATION_LIMIT ? text : `${chars.slice(0, EXPLANATION_LIMIT - 1).join('')}…`;
}
/** Mirrors `start_state`. */
export function startState(starting: boolean, startedMs: number, readyMs: number | null, nowMs: number): NonNullable<ServiceSupervision['startup']> {
  const elapsedMs = Math.max(nowMs - startedMs, 0);
  return { elapsedMs, slow: starting && elapsedMs >= START_NOTICE_MS, readyMs: readyMs === null ? null : Math.max(readyMs - startedMs, 0) };
}

type Supervised = {
  version: string | null; history: CrashHistory; state: 'starting' | 'running' | 'restarting' | 'parked';
  restarts: number; restartAt: number | null; backoffMs: number | null; parked: string | null; error: string | null;
  startedAt: number; readyAt: number | null; restartStarts: number; crashes: number; parks: number;
};

/**
 * Labelled stand-in of the native supervisor for the browser preview: the lifetime stand-in decides which services
 * run; this layer scripts crashes on a simulated clock and decorates the lifetime projection with the supervision
 * state. A main-page load is the preview's app start, so supervision state lives for one page.
 */
export function createServiceSupervisionPreview() {
  let now = 0;
  const entries = new Map<string, Supervised>();
  const fresh = (version: string | null): Supervised => ({ version, history: createCrashHistory(), state: 'running', restarts: 0, restartAt: null, backoffMs: null, parked: null, error: null, startedAt: now, readyAt: now, restartStarts: 0, crashes: 0, parks: 0 });
  const due = () => {
    for (const entry of entries.values()) {
      if (entry.state !== 'restarting' || entry.restartAt === null || entry.restartAt > now) continue;
      Object.assign(entry, { state: 'running', restarts: entry.restarts + 1, restartAt: null, backoffMs: null, startedAt: now, readyAt: now, restartStarts: entry.restartStarts + 1 });
    }
  };
  return {
    /** Moves the simulated clock; a restart whose time came starts (reason `restart`). */
    advance(ms: number) { now += ms; due(); },
    now: () => now,
    /** The running service crashes with a host error code. */
    crash(id: string, code = 'HostUnavailable') {
      const entry = entries.get(id);
      if (!entry || (entry.state !== 'running' && entry.state !== 'starting')) throw new Error('HostUnavailable');
      entry.crashes += 1; entry.error = code;
      const decision = recordCrash(entry.history, id, now, code);
      if (decision.kind === 'park') Object.assign(entry, { state: 'parked', parked: decision.explanation, restartAt: null, backoffMs: null, parks: entry.parks + 1 });
      else Object.assign(entry, { state: 'restarting', restartAt: decision.atMs, backoffMs: decision.delayMs });
      return decision;
    },
    /** The service's function does not settle: it stays `starting` (and becomes a slow start after ten seconds). */
    hang(id: string) { const entry = entries.get(id); if (entry) Object.assign(entry, { state: 'starting', startedAt: now, readyAt: null }); },
    /** Retry, enable: a parked, restarting or crashed service starts again with a clean history. */
    retry(id: string) { const entry = entries.get(id); if (entry && entry.state !== 'running') entries.set(id, { ...fresh(entry.version), crashes: entry.crashes, parks: entry.parks, restartStarts: entry.restartStarts }); },
    /** Follows the lifetime stand-in: a service that no longer runs (disable, safe mode, uninstall) loses any scheduled restart; an update starts clean. */
    reconcile(lifetime: ServiceLifetimeProjection) {
      const running = new Map(lifetime.services.filter(service => service.state === 'running').map(service => [service.id, service.version]));
      for (const [id, entry] of entries) {
        if (!running.has(id)) entries.delete(id);
        else if (running.get(id) !== entry.version) entries.set(id, { ...fresh(running.get(id) ?? null), crashes: entry.crashes, parks: entry.parks, restartStarts: entry.restartStarts });
      }
      for (const [id, version] of running) if (!entries.has(id)) entries.set(id, fresh(version));
    },
    /** The lifetime projection with each supervised service's state, restarts, counters and `supervision` object. */
    decorate(lifetime: ServiceLifetimeProjection): ServiceLifetimeProjection {
      return { ...lifetime, services: lifetime.services.map((service): ServiceEntry => {
        const entry = entries.get(service.id);
        if (!entry || service.state !== 'running') return service;
        const starts = { ...service.starts }, stops = { ...service.stops };
        if (entry.restartStarts) starts.restart = entry.restartStarts;
        if (entry.crashes) stops.crash = (stops.crash ?? 0) + entry.crashes;
        if (entry.parks) stops.park = (stops.park ?? 0) + entry.parks;
        const supervision: ServiceSupervision = {
          crashes: entry.history.recent.filter(crash => now - crash.at < CRASH_WINDOW_MS).length,
          backoffMs: entry.backoffMs, restartInMs: entry.restartAt === null ? null : Math.max(entry.restartAt - now, 0), parked: entry.parked,
          startup: entry.state === 'starting' || entry.state === 'running' ? startState(entry.state === 'starting', entry.startedAt, entry.readyAt, now) : null,
          memory: null,
        };
        return { ...service, state: entry.state, restarts: entry.restarts, reason: entry.restarts > 0 ? 'restart' : service.reason, error: entry.state === 'running' || entry.state === 'starting' ? service.error : entry.error, starts, stops, lastStop: entry.state === 'parked' ? { reason: 'park', acknowledged: false } : service.lastStop, supervision };
      }) };
    },
  };
}
