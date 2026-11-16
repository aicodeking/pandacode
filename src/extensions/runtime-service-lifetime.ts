/**
 * Background services of trusted packages (`runtime.service`, runtime slice R0104): the webview's read projection of
 * the native owner (`src-tauri/src/extensions/runtime_service_lifetime.rs`, IPC `extensions_service_lifetime`) and the
 * synthetic preview of its lifetime rules.
 *
 * The authority is native: it decides which services run from the package state and the native grants, starts them,
 * and stops them on disable, uninstall, update, trust or grant loss, safe mode and quit. The browser preview runs no
 * package code, so its services are labelled stand-ins that follow the same rule and keep the same counters.
 */
import { call } from '../bridge';
import type { ServiceSupervision } from './runtime-service-supervision';

export type ServiceStartReason = 'appStart' | 'enable' | 'restart' | 'update';
export type ServiceStopReason = 'disable' | 'uninstall' | 'update' | 'trust' | 'safeMode' | 'quit' | 'stop' | 'park';
// `restarting` (a crash restart is scheduled) and `parked` (five crashes in ten minutes) come from R0106.
export type ServiceState = 'starting' | 'running' | 'stopping' | 'restarting' | 'parked' | 'failed' | 'stopped';
export type ServiceEntry = {
  id: string; version: string | null; state: ServiceState; reason: ServiceStartReason | null; restarts: number;
  status: { text: string; working: boolean } | null; error: string | null;
  starts: Partial<Record<ServiceStartReason, number>>; stops: Partial<Record<ServiceStopReason | 'crash', number>>;
  lastStop: { reason: ServiceStopReason; acknowledged: boolean } | null;
  /** Crash supervision, start state and measured memory (R0106, `src/extensions/runtime-service-supervision.ts`). */
  supervision?: ServiceSupervision | null;
};
export type ServiceLifetimeProjection = { schemaVersion: 1; available: boolean; services: ServiceEntry[] };

export const UNAVAILABLE_SERVICES: ServiceLifetimeProjection = Object.freeze({ schemaVersion: 1, available: false, services: [] }) as ServiceLifetimeProjection;
const STATES = ['starting', 'running', 'stopping', 'restarting', 'parked', 'failed', 'stopped'];
const isCounts = (value: unknown) => !!value && typeof value === 'object' && !Array.isArray(value) && Object.values(value).every(count => Number.isInteger(count) && (count as number) >= 0);

/** Strict reader: a shape this build does not know is unavailable, never partially trusted. */
export function parseServiceLifetime(value: unknown): ServiceLifetimeProjection {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || !Array.isArray(root.services)) return UNAVAILABLE_SERVICES;
  for (const item of root.services as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || !STATES.includes(item.state as string) || !Number.isInteger(item.restarts) || !isCounts(item.starts) || !isCounts(item.stops)) return UNAVAILABLE_SERVICES;
    const supervision = item.supervision as Record<string, unknown> | null | undefined;
    if (supervision != null && (typeof supervision !== 'object' ||!Number.isInteger(supervision.crashes) || !(supervision.parked === null || typeof supervision.parked === 'string'))) return UNAVAILABLE_SERVICES;
  }
  return root as ServiceLifetimeProjection;
}
export async function loadServiceLifetime(): Promise<ServiceLifetimeProjection> {
  try { return parseServiceLifetime(await call<unknown>('extensions_service_lifetime')); } catch { return UNAVAILABLE_SERVICES; }
}

type Manifest = { id: string; version: string; runtime?: object; contributes?: { commands?: { id: string; action: { kind: string } }[] } };
type SnapshotPackage = { manifest: Manifest; enabled: boolean; executable?: { digest: string; trusted: boolean } | null };
export type LifetimeSnapshot = { safeMode?: boolean; packages: SnapshotPackage[] };
export type Granted = (id: string, version: string) => boolean;

export const declaresService = (manifest: Manifest) => (manifest.runtime as { service?: { start?: string } } | undefined)?.service?.start === 'onEnable';
/** Mirrors `desired` in the native module: enabled, trusted, declared and granted; nothing in safe mode. */
export function desiredServices(snapshot: LifetimeSnapshot, granted: Granted): Map<string, { version: string; digest: string }> {
  const wanted = new Map<string, { version: string; digest: string }>();
  if (snapshot.safeMode) return wanted;
  for (const item of snapshot.packages) {
    const digest = item.executable?.digest;
    if (digest && item.enabled && item.executable?.trusted && declaresService(item.manifest) && granted(item.manifest.id, item.manifest.version)) wanted.set(item.manifest.id, { version: item.manifest.version, digest });
  }
  return wanted;
}
/** Mirrors `stop_reason` in the native module. */
export function serviceStopReason(snapshot: LifetimeSnapshot, id: string, digest: string, granted: Granted): ServiceStopReason | null {
  if (snapshot.safeMode) return 'safeMode';
  const item = snapshot.packages.find(candidate => candidate.manifest.id === id);
  if (!item) return 'uninstall';
  if (item.executable?.digest !== digest || !declaresService(item.manifest)) return 'update';
  if (!item.executable?.trusted) return 'trust';
  if (!item.enabled) return 'disable';
  return granted(id, item.manifest.version) ? null : 'trust';
}

type Stored = {
  schemaVersion: 1;
  running: Record<string, { version: string; digest: string; reason: ServiceStartReason }>;
  counters: Record<string, { starts: Partial<Record<ServiceStartReason, number>>; stops: Partial<Record<ServiceStopReason, number>>; lastStop: ServiceEntry['lastStop'] }>;
};

/**
 * Synthetic stand-in for the native owner, persisted in the preview's localStorage. A main-page load is the preview's
 * app start: services left running by the previous page were ended by its quit (counted as `quit`), and the first
 * reconcile of the page starts the wanted ones with `appStart`. No package code runs; every service is "running".
 */
export function createServiceLifetimePreview(storage: Pick<Storage, 'getItem' | 'setItem'> = localStorage, key = 'pandacode.preview.extensions.services.v1') {
  const load = (): Stored => { try { const stored = JSON.parse(storage.getItem(key) ?? ''); if (stored?.schemaVersion === 1) return stored; } catch { /* a missing or damaged preview record starts empty */ } return { schemaVersion: 1, running: {}, counters: {} }; };
  const save = (stored: Stored) => storage.setItem(key, JSON.stringify(stored));
  const counters = (stored: Stored, id: string) => stored.counters[id] ??= { starts: {}, stops: {}, lastStop: null };
  const stop = (stored: Stored, id: string, reason: ServiceStopReason) => {
    delete stored.running[id];
    const count = counters(stored, id); count.stops[reason] = (count.stops[reason] ?? 0) + 1; count.lastStop = { reason, acknowledged: true };
  };
  let launched = false;
  const api = {
    /** The page's quit of the previous load, then nothing until the first reconcile. */
    launch() { const stored = load(); for (const id of Object.keys(stored.running)) stop(stored, id, 'quit'); save(stored); launched = false; },
    reconcile(snapshot: LifetimeSnapshot, granted: Granted) {
      const stored = load(), first = !launched; launched = true;
      for (const [id, entry] of Object.entries(stored.running)) {
        const reason = serviceStopReason(snapshot, id, entry.digest, granted);
        if (reason) stop(stored, id, reason);
        else continue;
        const want = desiredServices(snapshot, granted).get(id);
        if (want && reason === 'update') { stored.running[id] = { ...want, reason: 'update' }; const count = counters(stored, id); count.starts.update = (count.starts.update ?? 0) + 1; }
      }
      for (const [id, want] of desiredServices(snapshot, granted)) {
        if (stored.running[id]) continue;
        const reason: ServiceStartReason = first ? 'appStart' : 'enable';
        stored.running[id] = { ...want, reason };
        const count = counters(stored, id); count.starts[reason] = (count.starts[reason] ?? 0) + 1;
      }
      save(stored);
    },
    projection(): ServiceLifetimeProjection {
      const stored = load();
      const ids = [...new Set([...Object.keys(stored.running), ...Object.keys(stored.counters)])].sort();
      return { schemaVersion: 1, available: true, services: ids.map(id => {
        const entry = stored.running[id], count = stored.counters[id];
        return { id, version: entry?.version ?? null, state: entry ? 'running' : 'stopped', reason: entry?.reason ?? null, restarts: 0, status: entry ? { text: 'Preview stand-in: no package code runs', working: false } : null, error: null, starts: { ...count?.starts }, stops: { ...count?.stops }, lastStop: count?.lastStop ?? null };
      }) };
    },
  };
  return api;
}
