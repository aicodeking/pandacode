/**
 * The Running list of the Extensions page (runtime slice R0107): the background services of trusted packages with
 * their state, restarts, resident memory, status line, running jobs and host, and the Stop, Retry and Data size
 * controls; plus the webview mirror of the extension part of the quit confirmation.
 *
 * The authority is native (`src-tauri/src/extensions/runtime_service_status.rs`, IPC `extensions_service_status`,
 * `extensions_service_stop`, `extensions_service_retry`, `extensions_service_data_size`). It reads the lifetime and
 * supervision projection (R0104/R0106) and the running owned jobs; nothing is measured twice. The host is always this
 * computer here; placement beside remote and headless executors is R0108. The browser preview runs no package code:
 * its rows come from the lifetime stand-in, and stop, working state, memory, jobs and data sizes are a labelled
 * stand-in driven by a test hook.
 */
import { call } from '../bridge';
import { escape } from '../dom';
import type { ServiceEntry, ServiceLifetimeProjection, ServiceState } from './runtime-service-lifetime';

export type ServiceHost = { placement: 'local'; name: string; platform: string };
export type RunningService = {
  id: string; version: string | null; state: ServiceState; held: boolean; reason: string | null; restarts: number;
  status: { text: string; working: boolean } | null; working: boolean; error: string | null;
  crashes: number; backoffMs: number | null; restartInMs: number | null; parked: string | null;
  startup: { elapsedMs: number; slow: boolean; readyMs: number | null } | null;
  memory: { residentBytes: number; peakBytes: number; samples: number } | null;
  jobs: number; host: ServiceHost;
  starts: Record<string, number>; stops: Record<string, number>; lastStop: { reason: string; acknowledged: boolean } | null;
  controls: { stop: boolean; retry: boolean };
};
export type QuitPackage = { id: string; text: string | null; jobs: number };
export type ServiceStatus = {
  schemaVersion: 1; available: boolean; host: ServiceHost;
  counts: { services: number; working: number; jobs: number; quit: number };
  services: RunningService[]; jobs: { id: string; running: number }[]; quit: QuitPackage[];
};
export type DataSize = { schemaVersion: 1; id: string; bytes: number; files: number; truncated: boolean; exists: boolean };

const HOST: ServiceHost = { placement: 'local', name: 'This computer', platform: 'unknown' };
export const UNAVAILABLE_STATUS: ServiceStatus = Object.freeze({ schemaVersion: 1, available: false, host: HOST, counts: { services: 0, working: 0, jobs: 0, quit: 0 }, services: [], jobs: [], quit: [] }) as ServiceStatus;
const STATES = ['starting', 'running', 'stopping', 'restarting', 'parked', 'failed', 'stopped'];
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;
const isHost = (value: unknown): value is ServiceHost => !!value && (value as ServiceHost).placement === 'local' && typeof (value as ServiceHost).name === 'string';

/** Strict reader: a shape this build does not know is unavailable, never partially trusted. */
export function parseServiceStatus(value: unknown): ServiceStatus {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || typeof root.available !== 'boolean' || !isHost(root.host) || !Array.isArray(root.services) || !Array.isArray(root.jobs) || !Array.isArray(root.quit)) return UNAVAILABLE_STATUS;
  const counts = root.counts as Record<string, unknown> | null;
  if (!counts || !['services', 'working', 'jobs', 'quit'].every(key => count(counts[key]))) return UNAVAILABLE_STATUS;
  for (const item of root.services as Record<string, unknown>[]) {
    if (!item || typeof item.id !== 'string' || !STATES.includes(item.state as string) || typeof item.held !== 'boolean' || typeof item.working !== 'boolean' || !count(item.restarts) || !count(item.jobs) || !isHost(item.host)) return UNAVAILABLE_STATUS;
    const controls = item.controls as Record<string, unknown> | null;
    if (!controls || typeof controls.stop !== 'boolean' || typeof controls.retry !== 'boolean') return UNAVAILABLE_STATUS;
    const memory = item.memory as Record<string, unknown> | null;
    if (memory != null && (!count(memory.residentBytes) || !count(memory.peakBytes))) return UNAVAILABLE_STATUS;
  }
  if (!(root.quit as Record<string, unknown>[]).every(item => item && typeof item.id === 'string' && count(item.jobs) && (item.text === null || typeof item.text === 'string'))) return UNAVAILABLE_STATUS;
  return root as ServiceStatus;
}
export async function loadServiceStatus(): Promise<ServiceStatus> {
  try { return parseServiceStatus(await call<unknown>('extensions_service_status')); } catch { return UNAVAILABLE_STATUS; }
}
export async function stopService(id: string): Promise<ServiceStatus> { return parseServiceStatus(await call<unknown>('extensions_service_stop', { id })); }
export async function retryService(id: string): Promise<ServiceStatus> { return parseServiceStatus(await call<unknown>('extensions_service_retry', { id })); }
export async function measureServiceData(id: string): Promise<DataSize> { return call<DataSize>('extensions_service_data_size', { id }); }

/** Mirrors `quit_guard::account_message`: the original sentence without working packages, each package named once. */
export function quitMessage(agents: number, packages: QuitPackage[]): string {
  const agentsText = agents === 1 ? '1 agent is still running.' : `${agents} agents are still running.`;
  if (!packages.length) return `${agentsText} ${agents === 1 ? 'Quitting stops it.' : 'Quitting stops them.'}`;
  const display = (text: string) => { const line = text.replace(/\p{Cc}/gu, ' ').trim(), chars = [...line]; return chars.length <= 80 ? line : `${chars.slice(0, 79).join('').trimEnd()}…`; };
  const named = packages.map(item => {
    const details = [item.text ? display(item.text) : '', item.jobs === 1 ? '1 job running' : item.jobs > 1 ? `${item.jobs} jobs running` : ''].filter(Boolean);
    return details.length ? `${item.id} (${details.join('; ')})` : item.id;
  });
  return `${agents ? `${agentsText} ` : ''}${named.length === 1 ? 'Extension still working: ' : 'Extensions still working: '}${named.join(', ')}${agents + packages.length === 1 ? '. Quitting stops it.' : '. Quitting stops them.'}`;
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024, unit = 0;
  while (value >= 1024 && unit < units.length - 1) { value /= 1024; unit += 1; }
  return `${value.toFixed(1)} ${units[unit]}`;
}
const seconds = (ms: number) => `${(ms / 1000).toFixed(ms < 10_000 ? 1 : 0)} s`;
function stateText(item: RunningService): string {
  switch (item.state) {
    case 'starting': return item.startup?.slow ? `Starting (slow, ${seconds(item.startup.elapsedMs)})` : 'Starting';
    case 'running': return 'Running';
    case 'stopping': return 'Stopping';
    case 'restarting': return `Restarting in ${seconds(item.restartInMs ?? 0)} after ${item.crashes === 1 ? '1 crash' : `${item.crashes} crashes`}`;
    case 'parked': return 'Parked';
    case 'failed': return `Failed to start${item.error ? `: ${item.error}` : ''}`;
    default: return item.held ? 'Stopped by you' : 'Stopped';
  }
}
const hostText = (host: ServiceHost) => `This computer${host.name && host.name !== 'This computer' ? ` (${host.name})` : ''}`;

function row(item: RunningService, data: DataSize | undefined, off: string): string {
  const id = escape(item.id);
  const memory = item.memory ? `${formatBytes(item.memory.residentBytes)} in memory (peak ${formatBytes(item.memory.peakBytes)})` : item.state === 'running' || item.state === 'starting' ? 'Memory: measuring' : '';
  const facts = [stateText(item), `Restarts: ${item.restarts}`, memory].filter(Boolean).join(' · ');
  const status = item.status?.text ? `${item.working ? 'Working: ' : ''}${item.status.text}` : '';
  const dataText = !data ? 'Data: not measured' : !data.exists ? 'Data: none' : `Data: ${formatBytes(data.bytes)} in ${data.files === 1 ? '1 file' : `${data.files} files`}${data.truncated ? ' (partial count)' : ''}`;
  return `<div class="setting-row" data-running-service="${id}" data-running-state="${escape(item.state)}" data-running-working="${item.working}">
    <div><strong>${id}</strong><small data-running-facts>${escape(facts)}</small>
      ${status ? `<small data-running-status>${escape(status)}</small>` : ''}
      ${item.parked ? `<small data-running-parked>${escape(item.parked)}</small>` : ''}
      ${item.jobs ? `<small data-running-jobs>${item.jobs === 1 ? '1 job running' : `${item.jobs} jobs running`}</small>` : ''}
      <small data-running-host>Runs on ${escape(hostText(item.host))}</small><small data-running-data>${escape(dataText)}</small></div>
    ${item.controls.stop ? `<button type="button" class="secondary-button" data-running-op="stop" ${off}>Stop ${id}</button>` : ''}
    ${item.controls.retry ? `<button type="button" class="secondary-button" data-running-op="retry" ${off}>Retry ${id}</button>` : ''}
    <button type="button" class="secondary-button" data-running-op="data" ${off}>Data size ${id}</button></div>`;
}

/** How often the open list rereads the native state (memory is sampled every 2 s). */
export const RUNNING_REFRESH_MS = 1000;

/** The Running section of the Extensions page. Rereads the native state while it is mounted and the page is visible. */
export function mountRunningServices(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '', status: ServiceStatus = UNAVAILABLE_STATUS, drawn = '';
  const sizes = new Map<string, DataSize>();
  const draw = () => {
    if (disposed) return;
    const off = pending ? 'disabled' : '';
    const services = status.services;
    const summary = `${status.counts.services === 1 ? '1 service running' : `${status.counts.services} services running`} · ${status.counts.working} working · ${status.counts.jobs === 1 ? '1 job' : `${status.counts.jobs} jobs`} · on ${hostText(status.host)}`;
    const html = `<h3>Running</h3><p>Background services of your extensions. Stop ends a service until you retry or enable it again; quitting PandaCode stops them all.</p>
      ${!status.available ? '<p role="status">Service status is unavailable.</p>' : `<p data-running-summary>${escape(summary)}</p>`}
      ${status.quit.length ? `<p data-running-quit>Quitting now asks first. ${escape(quitMessage(0, status.quit))}</p>` : ''}
      ${services.length ? services.map(item => row(item, sizes.get(item.id), off)).join('') : status.available ? '<p data-running-empty>No extension service is running.</p>' : ''}
      ${status.jobs.length ? `<p data-running-other-jobs>Tool jobs: ${escape(status.jobs.map(item => `${item.id} (${item.running} running)`).join(', '))}</p>` : ''}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}`;
    if (html === drawn) return;
    // Keep the keyboard where it was: the same control of the same service after the redraw.
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const focus = active ? { id: active.closest<HTMLElement>('[data-running-service]')?.dataset.runningService, op: active.dataset.runningOp } : null;
    host.innerHTML = html; drawn = html;
    if (focus?.id && focus.op) [...host.querySelectorAll<HTMLElement>('[data-running-service]')].find(node => node.dataset.runningService === focus.id)?.querySelector<HTMLButtonElement>(`[data-running-op="${focus.op}"]`)?.focus({ preventScroll: true });
  };
  const refresh = async () => { const next = await loadServiceStatus(); if (!pending) status = next; draw(); };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-running-op]') : null;
    const id = button?.closest<HTMLElement>('[data-running-service]')?.dataset.runningService, op = button?.dataset.runningOp;
    if (!button || !id || !op || pending || !host.contains(button)) return;
    pending = true; error = ''; draw();
    try {
      if (op === 'stop') status = await stopService(id);
      else if (op === 'retry') status = await retryService(id);
      else if (op === 'data') sizes.set(id, await measureServiceData(id));
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally {
      pending = false; draw();
      if (!disposed) {
        const again = [...host.querySelectorAll<HTMLElement>('[data-running-service]')].find(node => node.dataset.runningService === id);
        (again?.querySelector<HTMLButtonElement>(`[data-running-op="${op}"]`) ?? again?.querySelector<HTMLButtonElement>('[data-running-op]') ?? host.querySelector<HTMLElement>('[role="alert"]'))?.focus({ preventScroll: true });
      }
    }
  };
  host.addEventListener('click', click);
  const timer = window.setInterval(() => { if (!pending && document.visibilityState !== 'hidden') void refresh(); }, RUNNING_REFRESH_MS);
  draw(); void refresh();
  return () => { disposed = true; window.clearInterval(timer); host.removeEventListener('click', click); host.replaceChildren(); };
}

// ---- Preview stand-in -------------------------------------------------------------------------------------------

type Overlay = {
  /** Stops by the user (counted), the services held stopped now, the starts by Retry, and the lifetime's own last stop when each hold began. */
  stops: Map<string, number>; held: Set<string>; retries: Map<string, number>; lastStopAt: Map<string, string>;
  status: Map<string, { text: string; working: boolean }>; memory: Map<string, { now: number; peak: number }>; jobs: Map<string, number>; data: Map<string, { bytes: number; files: number }>;
};
const PREVIEW_HOST: ServiceHost = { placement: 'local', name: 'Preview stand-in computer', platform: 'browser' };

/** Mirrors `runtime_service_status::status` over a lifetime projection (`held` per id) and the running jobs. */
export function serviceStatusOf(lifetime: ServiceLifetimeProjection, jobs: Map<string, number>, host: ServiceHost, held: (id: string) => boolean = () => false): ServiceStatus {
  const working = (service: ServiceEntry) => (service.state === 'starting' || service.state === 'running') && service.status?.working === true;
  const services: RunningService[] = lifetime.services.map(service => {
    const supervision = service.supervision ?? null, isHeld = held(service.id) || (service as { held?: boolean }).held === true;
    return {
      id: service.id, version: service.version, state: service.state, held: isHeld, reason: service.reason, restarts: service.restarts,
      status: service.status, working: working(service), error: service.error, crashes: supervision?.crashes ?? 0,
      backoffMs: supervision?.backoffMs ?? null, restartInMs: supervision?.restartInMs ?? null, parked: supervision?.parked ?? null,
      startup: supervision?.startup ?? null, memory: supervision?.memory ?? null, jobs: jobs.get(service.id) ?? 0, host,
      starts: { ...service.starts } as Record<string, number>, stops: { ...service.stops } as Record<string, number>, lastStop: service.lastStop,
      controls: { stop: ['starting', 'running', 'restarting'].includes(service.state), retry: ['failed', 'parked', 'restarting'].includes(service.state) || (service.state === 'stopped' && isHeld) },
    };
  });
  const quit = new Map<string, QuitPackage>();
  for (const service of lifetime.services.filter(working)) quit.set(service.id, { id: service.id, text: service.status?.text ?? null, jobs: 0 });
  for (const [id, running] of jobs) if (running > 0) quit.set(id, { ...(quit.get(id) ?? { id, text: null, jobs: 0 }), jobs: running });
  return {
    schemaVersion: 1, available: lifetime.available, host,
    counts: { services: services.filter(item => ['starting', 'running', 'stopping'].includes(item.state)).length, working: services.filter(item => item.working).length, jobs: [...jobs.values()].reduce((sum, value) => sum + value, 0), quit: quit.size },
    services, jobs: [...jobs].filter(([id, running]) => running > 0 && !services.some(item => item.id === id)).sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0).map(([id, running]) => ({ id, running })),
    quit: [...quit.values()].sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  };
}

/**
 * Labelled stand-in of the native controls for the browser preview, layered over the lifetime and supervision
 * stand-ins (one page is one app run). Stop holds a running service as `stopped` with the stop reason `stop` until
 * Retry or enable; the working state, memory, jobs and data sizes are set by the test hook only.
 */
export function createServiceStatusPreview() {
  const overlay: Overlay = { stops: new Map(), held: new Set(), retries: new Map(), lastStopAt: new Map(), status: new Map(), memory: new Map(), jobs: new Map(), data: new Map() };
  const decorate = (lifetime: ServiceLifetimeProjection): ServiceLifetimeProjection => ({ ...lifetime, services: lifetime.services.map((service): ServiceEntry => {
    const stops = overlay.stops.get(service.id) ?? 0, retries = overlay.retries.get(service.id) ?? 0;
    const starts = retries ? { ...service.starts, enable: (service.starts.enable ?? 0) + retries } : { ...service.starts };
    const counted = stops ? { ...service.stops, stop: (service.stops.stop ?? 0) + stops } : { ...service.stops };
    // The last stop is the user's until the lifetime stand-in records a later one of its own (disable, update, ...).
    const lastStop = overlay.lastStopAt.get(service.id) === JSON.stringify(service.lastStop) ? { reason: 'stop' as const, acknowledged: true } : service.lastStop;
    if (overlay.held.has(service.id)) return { ...service, version: null, state: 'stopped', reason: null, restarts: 0, status: null, error: null, starts, stops: counted, lastStop, supervision: null };
    const running = service.state === 'running' || service.state === 'starting';
    // A process that ended (crash, restart, disable) took its status and memory with it, as natively.
    if (!running) { overlay.status.delete(service.id); overlay.memory.delete(service.id); }
    const memory = overlay.memory.get(service.id);
    const supervision = service.supervision && running && memory ? { ...service.supervision, memory: { residentBytes: memory.now, peakBytes: memory.peak, samples: 1 } } : service.supervision;
    return { ...service, status: running ? overlay.status.get(service.id) ?? service.status : service.status, starts, stops: counted, lastStop, supervision };
  }) });
  return {
    status(lifetime: ServiceLifetimeProjection): ServiceStatus { return serviceStatusOf(decorate(lifetime), overlay.jobs, PREVIEW_HOST, id => overlay.held.has(id)); },
    stop(lifetime: ServiceLifetimeProjection, id: string) {
      const service = decorate(lifetime).services.find(item => item.id === id);
      if (!service) throw new Error('NotFound');
      if (!['starting', 'running', 'restarting'].includes(service.state)) throw new Error('Conflict');
      overlay.held.add(id); overlay.stops.set(id, (overlay.stops.get(id) ?? 0) + 1);
      overlay.lastStopAt.set(id, JSON.stringify(lifetime.services.find(item => item.id === id)?.lastStop ?? null));
      overlay.status.delete(id); overlay.memory.delete(id);
    },
    /** Retry, and enable (the native retry): a held service starts again (`enable`). */
    release(id: string) { if (overlay.held.delete(id)) overlay.retries.set(id, (overlay.retries.get(id) ?? 0) + 1); },
    dataSize(id: string): DataSize {
      if (!/^[A-Za-z0-9_.-]{1,160}$/.test(id) || id.includes('..') || id.startsWith('.')) throw new Error('InvalidArguments');
      const data = overlay.data.get(id);
      return { schemaVersion: 1, id, bytes: data?.bytes ?? 0, files: data?.files ?? 0, truncated: false, exists: !!data };
    },
    /** Test hook only: what a running service would report natively. */
    script(request: Record<string, unknown>) {
      const id = String(request.id);
      switch (request.op) {
        case 'status': overlay.status.set(id, { text: String(request.text ?? '').slice(0, 200), working: request.working === true }); return null;
        case 'memory': { const now = Math.max(0, Math.trunc(Number(request.bytes))); overlay.memory.set(id, { now, peak: Math.max(now, overlay.memory.get(id)?.peak ?? 0) }); return null; }
        case 'jobs': overlay.jobs.set(id, Math.max(0, Math.trunc(Number(request.running)))); return null;
        case 'data': overlay.data.set(id, { bytes: Math.max(0, Math.trunc(Number(request.bytes))), files: Math.max(0, Math.trunc(Number(request.files))) }); return null;
        default: throw new Error('InvalidArguments');
      }
    },
  };
}

let previewInstance: ReturnType<typeof createServiceStatusPreview> | undefined;
const previewWindow = () => location.pathname.endsWith('/agents-dock.html') || ['tray', 'launcher'].includes(new URLSearchParams(location.search).get('view') ?? '') ? 'other' : 'main';
/** The preview's IPC for the commands of this slice. `lifetime` reads the lifetime stand-in; `agents` counts the running local tasks. */
export function previewServiceStatus(command: string, args: Record<string, unknown>, lifetime: () => ServiceLifetimeProjection, agents: number): unknown {
  const instance = previewInstance ??= createServiceStatusPreview();
  if (command === 'extensions_enable') { if (args.enabled === true) instance.release(String(args.id)); return undefined; }
  if (previewWindow() !== 'main') throw new Error('PermissionDenied');
  switch (command) {
    case 'extensions_service_status': return instance.status(lifetime());
    case 'extensions_service_stop': instance.stop(lifetime(), String(args.id)); return instance.status(lifetime());
    case 'extensions_service_retry': {
      const id = String(args.id);
      if (!lifetime().services.some(item => item.id === id)) throw new Error('NotFound');
      instance.release(id); return instance.status(lifetime());
    }
    case 'extensions_service_data_size': return instance.dataSize(String(args.id));
    // Preview-only: the test hook, and what the native quit question would say now.
    case 'extensions_service_status_preview': return instance.script(args);
    case 'extensions_service_quit_preview': { const quit = instance.status(lifetime()).quit; return { confirm: agents + quit.length > 0, packages: quit, message: quitMessage(agents, quit) }; }
    default: throw new Error('Unsupported extension preview command.');
  }
}
