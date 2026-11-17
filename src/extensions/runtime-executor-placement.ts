/**
 * Services placed beside remote and headless executors (runtime slice R0108): the "On other computers" part of the
 * Extensions page, its Stop/Retry and grant controls, and the labelled preview stand-in of a paired host.
 *
 * The authority is native (`src-tauri/src/extensions/runtime_executor_placement.rs`): the desktop asks each paired
 * host computer over PandaCode Connect (`extensions.services`, `extensions.serviceControl`, `extensions.serviceGrant`)
 * through the IPC `extensions_executor_services`, `extensions_executor_service_control` and `extensions_executor_grant`.
 * A workspace-kind package's service runs on the computer that executes the task; this computer never runs it
 * instead. Every row is attributed to its package and to the host it runs on; a host that does not answer is listed
 * as unavailable and its placement stays pending. Pairing a computer and its access stay in Connect settings.
 *
 * The browser preview has no second computer: its hosts are a labelled fake paired transport that mirrors the host
 * rules for protocol checks only. It never qualifies placement.
 */
import { call } from '../bridge';
import { escape } from '../dom';
import { GRANT_PERMISSIONS } from './runtime-grants';

export type ExecutorHost = { placement: 'remote'; deviceId: string; name: string; platform: string | null; headless: boolean | null };
export type ExecutorService = {
  id: string; version: string | null; kind: 'workspace' | 'split'; enabled: boolean; trusted: boolean; declaresService: boolean;
  state: string; held: boolean; working: boolean; status: string | null; restarts: number; lastStop: { reason: string; acknowledged: boolean } | null;
  controls: { stop: boolean; retry: boolean }; declared: string[]; granted: string[]; authorized: boolean;
  attribution: { package: string; deviceId: string; host: string };
};
export type ExecutorActivity = { seq: number; owner: string; kind: 'hook' | 'ui' | 'control' | 'grant' | 'lifecycle'; summary: string; at: number };
export type Qualification = { installed: 'pending'; note: string };
export type ExecutorHostServices = {
  schemaVersion: 1; deviceId: string; reachable: boolean; host: ExecutorHost; safeMode?: boolean;
  services: ExecutorService[]; activity: ExecutorActivity[]; ui: { revision: number; owners: Record<string, { items: number; notices: number }> };
  revision: string | null; error: string | null; qualification: Qualification;
};
export type ExecutorPlacement = { schemaVersion: 1; hosts: ExecutorHostServices[]; qualification: Qualification };
export type ExecutorControlReply = { schemaVersion: 1; id: string; op: string; applied?: boolean; replayed?: boolean; requestId: string; attribution: { package: string; deviceId: string; host: string; from: string }; service: ExecutorService | null };

export const QUALIFICATION_NOTE = 'Installed cross-machine qualification is pending: it needs two real computers already paired by you.';
export const UNSUPPORTED_HOST = "UnsupportedCapability: that computer's PandaCode does not place extension services yet. Nothing runs here instead.";
export const OFFLINE_HOST = 'HostUnavailable: that computer is offline. Its services are not shown and nothing runs here instead.';
const PENDING: Qualification = Object.freeze({ installed: 'pending', note: QUALIFICATION_NOTE }) as Qualification;
export const NO_EXECUTORS: ExecutorPlacement = Object.freeze({ schemaVersion: 1, hosts: [], qualification: PENDING }) as ExecutorPlacement;
const MAX_SERVICES = 128;
const count = (value: unknown) => Number.isInteger(value) && (value as number) >= 0;

/**
 * Strict reader (mirrors `read_host`): every row must be attributed to its own package on the host asked. A host
 * whose answer does not hold is shown unavailable, never partially trusted.
 */
export function parseExecutorPlacement(value: unknown): ExecutorPlacement {
  const root = value as Record<string, unknown> | null;
  if (!root || root.schemaVersion !== 1 || !Array.isArray(root.hosts)) return NO_EXECUTORS;
  const hosts = (root.hosts as unknown[]).slice(0, 16).map(parseHost).filter((host): host is ExecutorHostServices => !!host);
  return { schemaVersion: 1, hosts, qualification: PENDING };
}
function parseHost(value: unknown): ExecutorHostServices | null {
  const item = value as Record<string, unknown> | null;
  const host = item?.host as Record<string, unknown> | undefined;
  if (!item || item.schemaVersion !== 1 || typeof item.deviceId !== 'string' || typeof item.reachable !== 'boolean' || !host || host.placement !== 'remote' || host.deviceId !== item.deviceId || typeof host.name !== 'string' || !Array.isArray(item.services)) return null;
  const device = item.deviceId, broken = { ...(item as ExecutorHostServices), reachable: false, services: [], activity: [], error: 'StaleContext', qualification: PENDING };
  if (!item.reachable) return { ...(item as ExecutorHostServices), services: [], activity: [], qualification: PENDING };
  const rows = item.services as Record<string, unknown>[], seen = new Set<string>();
  if (rows.length > MAX_SERVICES) return broken;
  for (const row of rows) {
    const attribution = row?.attribution as Record<string, unknown> | undefined, controls = row?.controls as Record<string, unknown> | undefined;
    if (!row || typeof row.id !== 'string' || seen.has(row.id) || attribution?.package !== row.id || attribution?.deviceId !== device || typeof row.state !== 'string' || typeof row.held !== 'boolean' || !count(row.restarts) || !controls || typeof controls.stop !== 'boolean' || typeof controls.retry !== 'boolean' || !Array.isArray(row.granted) || !Array.isArray(row.declared)) return broken;
    seen.add(row.id);
  }
  const activity = Array.isArray(item.activity) ? (item.activity as ExecutorActivity[]).filter(entry => entry && seen.has(entry.owner) && typeof entry.summary === 'string').slice(-64) : [];
  return { ...(item as ExecutorHostServices), activity, qualification: PENDING };
}

export async function loadExecutorPlacement(): Promise<ExecutorPlacement> {
  try { return parseExecutorPlacement(await call<unknown>('extensions_executor_services')); } catch { return NO_EXECUTORS; }
}
const requestId = () => (globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`).slice(0, 64);
/** Stop or Retry of one service on a paired host. One request id per click: a retry after a lost reply never applies twice. */
export async function controlExecutorService(deviceId: string, id: string, op: 'stop' | 'retry', request = requestId()): Promise<ExecutorControlReply> {
  return call<ExecutorControlReply>('extensions_executor_service_control', { deviceId, id, op, requestId: request });
}
/** Grant or revoke a package's permission on a paired host. */
export async function changeExecutorGrant(deviceId: string, change: { op: 'grant' | 'revoke' | 'revokeAll'; id: string; permission?: string }, request = requestId()): Promise<ExecutorControlReply> {
  return call<ExecutorControlReply>('extensions_executor_grant', { deviceId, request: { ...change, requestId: request } });
}

const hostKind = (host: ExecutorHost) => host.headless ? 'headless server' : host.headless === false ? 'computer' : 'computer';
const hostText = (host: ExecutorHost) => `${host.name || host.deviceId} (${hostKind(host)})`;
function stateText(item: ExecutorService): string {
  if (!item.trusted) return 'Not trusted on that computer';
  if (!item.enabled) return 'Disabled on that computer';
  if (!item.granted.includes('runtime.service')) return 'Not granted runtime.service';
  switch (item.state) {
    case 'starting': return 'Starting';
    case 'running': return 'Running';
    case 'stopping': return 'Stopping';
    case 'restarting': return 'Restarting';
    case 'parked': return 'Parked';
    case 'failed': return 'Failed to start';
    default: return item.held ? 'Stopped by you' : 'Stopped';
  }
}

function serviceRow(entry: ExecutorHostServices, item: ExecutorService, off: string): string {
  const id = escape(item.id), where = escape(entry.host.name || entry.deviceId);
  const ui = entry.ui.owners[item.id];
  const facts = [stateText(item), `Restarts: ${item.restarts}`, ui ? `${ui.items === 1 ? '1 live item' : `${ui.items} live items`}, ${ui.notices === 1 ? '1 notice' : `${ui.notices} notices`}` : ''].filter(Boolean).join(' · ');
  const activity = entry.activity.filter(row => row.owner === item.id).slice(-5);
  const granted = item.granted.includes('runtime.service');
  return `<div class="setting-row" data-executor-service="${id}" data-executor-state="${escape(item.state)}" data-executor-held="${item.held}">
    <div><strong>${id}</strong><small data-executor-facts>${escape(facts)}</small>
      ${item.status ? `<small data-executor-status>${escape(`${item.working ? 'Working: ' : ''}${item.status}`)}</small>` : ''}
      <small data-executor-where>Runs on ${escape(hostText(entry.host))}</small>
      ${activity.length ? `<ul data-executor-activity>${activity.map(row => `<li data-executor-activity-kind="${escape(row.kind)}">${escape(row.summary)}</li>`).join('')}</ul>` : ''}</div>
    ${item.controls.stop ? `<button type="button" class="secondary-button" data-executor-op="stop" ${off}>Stop ${id} on ${where}</button>` : ''}
    ${item.controls.retry ? `<button type="button" class="secondary-button" data-executor-op="retry" ${off}>Retry ${id} on ${where}</button>` : ''}
    ${item.declared.includes('runtime.service') ? `<button type="button" class="secondary-button" data-executor-op="${granted ? 'revoke' : 'grant'}" ${off}>${granted ? 'Revoke' : 'Grant'} runtime.service for ${id} on ${where}</button>` : ''}</div>`;
}
function hostBlock(entry: ExecutorHostServices, off: string): string {
  const device = escape(entry.deviceId);
  if (!entry.reachable) return `<div data-executor-host="${device}" data-executor-reachable="false"><h4>${escape(hostText(entry.host))}</h4>
    <p data-executor-unavailable>${escape(entry.error ?? OFFLINE_HOST)} Placement there stays pending.</p></div>`;
  return `<div data-executor-host="${device}" data-executor-reachable="true"><h4>${escape(hostText(entry.host))}</h4>
    ${entry.safeMode ? '<p role="status">That computer is in safe mode: no extension runs there.</p>' : ''}
    ${entry.services.length ? entry.services.map(item => serviceRow(entry, item, off)).join('') : '<p data-executor-empty>No workspace extension is installed there.</p>'}</div>`;
}

/** How often the open list rereads the hosts (each answer is one Connect round trip per computer). */
export const EXECUTOR_REFRESH_MS = 2000;

/** "On other computers": the services placed beside the executors of the account's other computers. */
export function mountExecutorServices(host: HTMLElement): () => void {
  let disposed = false, pending = false, error = '', placement: ExecutorPlacement = NO_EXECUTORS, drawn = '';
  const draw = () => {
    if (disposed) return;
    const off = pending ? 'disabled' : '';
    const html = placement.hosts.length ? `<h3>On other computers</h3><p>Workspace extensions run on the computer that executes the task; nothing here runs them instead. Pair computers and set their access in Remote settings.</p>
      ${placement.hosts.map(entry => hostBlock(entry, off)).join('')}
      <p data-executor-qualification>${escape(placement.qualification.note)}</p>
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}` : '';
    if (html === drawn) return;
    const active = document.activeElement instanceof HTMLElement && host.contains(document.activeElement) ? document.activeElement : null;
    const focus = active ? { device: active.closest<HTMLElement>('[data-executor-host]')?.dataset.executorHost, id: active.closest<HTMLElement>('[data-executor-service]')?.dataset.executorService, op: active.dataset.executorOp } : null;
    host.innerHTML = html; drawn = html;
    if (focus?.device && focus.id) refocus(focus.device, focus.id, focus.op);
  };
  const refocus = (device: string, id: string, op?: string) => {
    const block = [...host.querySelectorAll<HTMLElement>('[data-executor-host]')].find(node => node.dataset.executorHost === device);
    const row = block ? [...block.querySelectorAll<HTMLElement>('[data-executor-service]')].find(node => node.dataset.executorService === id) : undefined;
    const counterpart = op === 'grant' ? 'revoke' : op === 'revoke' ? 'grant' : op === 'stop' ? 'retry' : 'stop';
    (row?.querySelector<HTMLButtonElement>(`[data-executor-op="${op}"]`) ?? row?.querySelector<HTMLButtonElement>(`[data-executor-op="${counterpart}"]`) ?? row?.querySelector<HTMLButtonElement>('[data-executor-op]') ?? host.querySelector<HTMLElement>('[role="alert"]'))?.focus({ preventScroll: true });
  };
  const refresh = async () => { const next = await loadExecutorPlacement(); if (!pending) placement = next; draw(); };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('[data-executor-op]') : null;
    const device = button?.closest<HTMLElement>('[data-executor-host]')?.dataset.executorHost, id = button?.closest<HTMLElement>('[data-executor-service]')?.dataset.executorService, op = button?.dataset.executorOp;
    if (!button || !device || !id || !op || pending || !host.contains(button)) return;
    pending = true; error = ''; draw();
    try {
      if (op === 'stop' || op === 'retry') await controlExecutorService(device, id, op);
      else if (op === 'grant' || op === 'revoke') await changeExecutorGrant(device, { op, id, permission: 'runtime.service' });
      placement = await loadExecutorPlacement();
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    finally { pending = false; draw(); if (!disposed) refocus(device, id, op); }
  };
  host.addEventListener('click', click);
  const timer = window.setInterval(() => { if (!pending && document.visibilityState !== 'hidden') void refresh(); }, EXECUTOR_REFRESH_MS);
  draw(); void refresh();
  return () => { disposed = true; window.clearInterval(timer); host.removeEventListener('click', click); host.replaceChildren(); };
}

// ---- Preview stand-in: a labelled fake paired transport ------------------------------------------------------

/** One fake host computer for the preview (set `window.__extensionExecutorPeers` before load to replace them). */
export type PreviewPeer = {
  deviceId: string; name: string; platform: string; headless: boolean; online: boolean; legacy?: boolean;
  packages: { manifest: { id: string; version: string; extensionKind: string; permissions: string[]; runtime?: { service?: { start?: string } } }; enabled: boolean; trusted: boolean; granted: string[] }[];
};
type PeerService = { state: string; held: boolean; restarts: number; starts: number; status: string | null; lastStop: { reason: string; acknowledged: boolean } | null };
type PeerState = { peer: PreviewPeer; services: Map<string, PeerService>; activity: ExecutorActivity[]; answers: Map<string, ExecutorControlReply>; lose: number; seq: number; ui: Record<string, { items: number; notices: number }> };

const TIMED_OUT = 'That computer did not answer in time.';
const beside = (kind: string) => kind === 'workspace' || kind === 'split';
const DEFAULT_PEERS: PreviewPeer[] = [
  { deviceId: 'preview-build-server', name: 'build-server', platform: 'linux', headless: true, online: true, packages: [
    { manifest: { id: 'sample.executor-placement', version: '1.0.0', extensionKind: 'workspace', permissions: ['ui.contribute', 'runtime.service', 'storage.private'], runtime: { service: { start: 'onEnable' } } }, enabled: true, trusted: true, granted: ['runtime.service'] },
    { manifest: { id: 'sample.executor-placement-ui', version: '1.0.0', extensionKind: 'ui', permissions: ['ui.contribute', 'runtime.service'], runtime: { service: { start: 'onEnable' } } }, enabled: true, trusted: true, granted: ['runtime.service'] },
  ] },
  { deviceId: 'preview-studio', name: 'studio', platform: 'darwin', headless: false, online: false, packages: [] },
];

/**
 * The fake host rules (mirroring `host_snapshot`, `host_control` and `host_grant`) and the desktop's retry of a
 * writer whose reply was lost. One page is one app run; nothing here is a second machine.
 */
export function createExecutorPlacementPreview(peers: PreviewPeer[] = DEFAULT_PEERS) {
  const states = new Map<string, PeerState>();
  const startable = (state: PeerState, id: string) => {
    const item = state.peer.packages.find(entry => entry.manifest.id === id);
    return !!item && item.enabled && item.trusted && item.granted.includes('runtime.service') && item.manifest.runtime?.service?.start === 'onEnable' && beside(item.manifest.extensionKind);
  };
  const reconcile = (state: PeerState) => {
    for (const item of state.peer.packages.filter(entry => beside(entry.manifest.extensionKind))) {
      const id = item.manifest.id, service = state.services.get(id) ?? { state: 'stopped', held: false, restarts: 0, starts: 0, status: null, lastStop: null };
      if (startable(state, id) && !service.held && service.state !== 'running') { service.state = 'running'; service.starts += 1; service.status = 'Beside the executor'; }
      if (!startable(state, id) && service.state === 'running') { service.state = 'stopped'; service.status = null; service.lastStop = { reason: 'trust', acknowledged: true }; }
      state.services.set(id, service);
    }
  };
  for (const peer of peers) { const state: PeerState = { peer: structuredClone(peer), services: new Map(), activity: [], answers: new Map(), lose: 0, seq: 0, ui: {} }; reconcile(state); states.set(peer.deviceId, state); }
  const record = (state: PeerState, owner: string, kind: ExecutorActivity['kind'], summary: string) => { state.seq += 1; state.activity.push({ seq: state.seq, owner, kind, summary: summary.slice(0, 200), at: Date.now() }); state.activity = state.activity.slice(-64); };
  const row = (state: PeerState, id: string): ExecutorService | null => {
    const item = state.peer.packages.find(entry => entry.manifest.id === id);
    if (!item || !beside(item.manifest.extensionKind)) return null;
    const service = state.services.get(id) ?? { state: 'stopped', held: false, restarts: 0, starts: 0, status: null, lastStop: null };
    return {
      id, version: item.manifest.version, kind: item.manifest.extensionKind as 'workspace' | 'split', enabled: item.enabled, trusted: item.trusted, declaresService: item.manifest.runtime?.service?.start === 'onEnable',
      state: service.state, held: service.held, working: false, status: service.status, restarts: service.restarts, lastStop: service.lastStop,
      controls: { stop: service.state === 'running', retry: service.held }, declared: [...item.manifest.permissions], granted: [...item.granted], authorized: item.enabled && item.trusted,
      attribution: { package: id, deviceId: state.peer.deviceId, host: state.peer.name },
    };
  };
  const hostServices = (state: PeerState): ExecutorHostServices => {
    const host: ExecutorHost = { placement: 'remote', deviceId: state.peer.deviceId, name: state.peer.name, platform: state.peer.platform, headless: state.peer.headless };
    if (!state.peer.online) return { schemaVersion: 1, deviceId: state.peer.deviceId, reachable: false, host: { ...host, platform: null, headless: null }, services: [], activity: [], ui: { revision: 0, owners: {} }, revision: null, error: OFFLINE_HOST, qualification: PENDING };
    if (state.peer.legacy) return { schemaVersion: 1, deviceId: state.peer.deviceId, reachable: false, host: { ...host, platform: null, headless: null }, services: [], activity: [], ui: { revision: 0, owners: {} }, revision: null, error: UNSUPPORTED_HOST, qualification: PENDING };
    const services = state.peer.packages.map(item => row(state, item.manifest.id)).filter((item): item is ExecutorService => !!item);
    const owners = new Set(services.map(item => item.id));
    return {
      schemaVersion: 1, deviceId: state.peer.deviceId, reachable: true, host, safeMode: false, services,
      activity: state.activity.filter(entry => owners.has(entry.owner)), ui: { revision: state.seq, owners: Object.fromEntries(Object.entries(state.ui).filter(([owner]) => owners.has(owner))) },
      revision: String(state.seq), error: null, qualification: PENDING,
    };
  };
  const peer = (deviceId: unknown) => {
    const state = states.get(String(deviceId));
    if (!state) throw new Error('That computer is not on this account.');
    if (!state.peer.online) throw new Error('That computer is offline.');
    if (state.peer.legacy) throw new Error(UNSUPPORTED_HOST);
    return state;
  };
  /** The host side of one writer; a lost reply throws after the host applied it. */
  const hostWrite = (state: PeerState, kind: 'control' | 'grant', request: Record<string, unknown>): ExecutorControlReply => {
    const key = `${kind}\n${String(request.requestId)}`, known = state.answers.get(key);
    if (known) return { ...known, replayed: true };
    const id = String(request.id ?? '');
    if (!row(state, id)) throw new Error('NotFound');
    const service = state.services.get(id)!, item = state.peer.packages.find(entry => entry.manifest.id === id)!;
    let applied = true;
    if (kind === 'control') {
      if (request.op === 'stop') {
        if (service.state === 'running') { service.state = 'stopped'; service.held = true; service.status = null; service.lastStop = { reason: 'stop', acknowledged: true }; }
        else if (service.held) applied = false;
        else throw new Error('Conflict');
      } else if (request.op === 'retry') { service.held = false; reconcile(state); }
      else throw new Error('InvalidArguments');
      if (applied) record(state, id, 'control', `${request.op === 'stop' ? 'Stop' : 'Retry'} requested from This computer`);
    } else {
      const permission = typeof request.permission === 'string' ? request.permission : undefined;
      if (request.op === 'revokeAll') item.granted = [];
      else if (!permission) throw new Error('InvalidArguments');
      else if (!GRANT_PERMISSIONS.includes(permission)) throw new Error('UnsupportedCapability');
      else if (request.op === 'grant') { if (!item.manifest.permissions.includes(permission)) throw new Error('PermissionDenied'); if (!item.granted.includes(permission)) item.granted.push(permission); }
      else if (request.op === 'revoke') item.granted = item.granted.filter(name => name !== permission);
      else throw new Error('InvalidArguments');
      reconcile(state);
      record(state, id, 'grant', `${permission ?? 'Permissions'} ${request.op === 'grant' ? 'granted' : request.op === 'revoke' ? 'revoked' : 'all revoked'} from This computer`);
    }
    const reply: ExecutorControlReply = { schemaVersion: 1, id, op: String(request.op), applied, requestId: String(request.requestId), attribution: { package: id, deviceId: state.peer.deviceId, host: state.peer.name, from: 'This computer' }, service: row(state, id) };
    state.answers.set(key, reply);
    if (state.lose > 0) { state.lose -= 1; throw new Error(TIMED_OUT); }
    return reply;
  };
  /** The desktop side: one retry with the same request id when the first reply was lost. */
  const write = (deviceId: unknown, kind: 'control' | 'grant', request: Record<string, unknown>) => {
    if (typeof request.requestId !== 'string' || !/^[A-Za-z0-9-]{1,64}$/.test(request.requestId)) throw new Error('InvalidArguments');
    const state = peer(deviceId);
    let reply: ExecutorControlReply;
    try { reply = hostWrite(state, kind, request); }
    catch (failure) { if (!(failure instanceof Error) || failure.message !== TIMED_OUT) throw failure; reply = hostWrite(state, kind, request); }
    if (reply.attribution.deviceId !== deviceId || reply.id !== request.id) throw new Error('StaleContext');
    return reply;
  };
  return {
    services(): ExecutorPlacement { return { schemaVersion: 1, hosts: [...states.values()].map(hostServices), qualification: PENDING }; },
    control(args: Record<string, unknown>) { return write(args.deviceId, 'control', { id: args.id, op: args.op, requestId: args.requestId }); },
    grant(args: Record<string, unknown>) { return write(args.deviceId, 'grant', (args.request ?? {}) as Record<string, unknown>); },
    /** Test hook only: what a host would report or suffer natively. */
    script(request: Record<string, unknown>) {
      const state = states.get(String(request.deviceId));
      if (!state) throw new Error('NotFound');
      switch (request.op) {
        case 'online': state.peer.online = request.online === true; return null;
        case 'legacy': state.peer.legacy = request.legacy === true; return null;
        case 'lose': state.lose = Math.max(0, Math.trunc(Number(request.times ?? 1))); return null;
        case 'activity': record(state, String(request.id), (request.kind as ExecutorActivity['kind']) ?? 'hook', String(request.summary ?? '')); return null;
        case 'ui': state.ui[String(request.id)] = { items: Math.max(0, Math.trunc(Number(request.items ?? 0))), notices: Math.max(0, Math.trunc(Number(request.notices ?? 0))) }; state.seq += 1; return null;
        case 'starts': return state.services.get(String(request.id))?.starts ?? 0;
        default: throw new Error('InvalidArguments');
      }
    },
  };
}

let previewInstance: ReturnType<typeof createExecutorPlacementPreview> | undefined;
const previewWindow = () => location.pathname.endsWith('/agents-dock.html') || ['tray', 'launcher'].includes(new URLSearchParams(location.search).get('view') ?? '') ? 'other' : 'main';
/** The preview's IPC for the commands of this slice (labelled fake paired transport). */
export function previewExecutorPlacement(command: string, args: Record<string, unknown>): unknown {
  const peers = (globalThis as { __extensionExecutorPeers?: PreviewPeer[] }).__extensionExecutorPeers;
  // Without hosts set by a test, only `?executor-placement` shows the default fake hosts (other previews stay as they were).
  const instance = previewInstance ??= createExecutorPlacementPreview(Array.isArray(peers) ? peers : new URLSearchParams(location.search).has('executor-placement') ? DEFAULT_PEERS : []);
  if (previewWindow() !== 'main') throw new Error('PermissionDenied');
  switch (command) {
    case 'extensions_executor_services': return instance.services();
    case 'extensions_executor_service_control': return instance.control(args);
    case 'extensions_executor_grant': return instance.grant(args);
    // Preview-only test hook.
    case 'extensions_executor_preview': return instance.script(args);
    default: throw new Error('Unsupported extension preview command.');
  }
}

if (typeof location !== 'undefined' && new URLSearchParams(location.search).has('executor-placement')) {
  (globalThis as { __extensionExecutorPlacement?: unknown }).__extensionExecutorPlacement = { call: (command: string, args?: Record<string, unknown>) => call(command, args ?? {}) };
}
