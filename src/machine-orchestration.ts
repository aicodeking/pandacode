/* Multi-machine orchestration (docs/machine-orchestration.md): the link card and Link a machine
 * dialog for an agent's `pandacode_machine_link` request, the lineage strip of threads a task
 * launched on other computers, the transcript's threads card, and the Settings → Remote access
 * orchestration controls. Imported statically by main.ts, so its stylesheet is always loaded
 * before the composer renders. */
import './machine-orchestration.css';
import { escape, icon } from './dom';
import { infoMark } from './tooltip';
import type { RemoteDevice, RemoteHost } from './remote-types';

export type Access = 'read' | 'ask' | 'full';
export interface OrchestrationLink { deviceId: string; name: string; platform: string; online: boolean; access: Access }
export interface OrchestrationStatus { enabled: boolean; links: OrchestrationLink[] }
export interface LinkRequest { requestId: string; sessionId: string; machine: string | null; reason: string }
export interface MachineChild { sessionId: string; title: string; provider: string; model: string; status: string; machine: { id: string; name: string }; createdAt: number }

export interface OrchestrationHost {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  listen(name: string, callback: (event: any) => void): Promise<() => void>;
  notify(text: string, action?: { label: string; run: () => void }): void;
  modal(title: string, body: string, cls?: string): HTMLDialogElement;
  closeModal(): void;
  openSession(id: string): void;
  sessionId(): string;
  /** Whether the visible task's own agent is running. */
  running(): boolean;
  /** A task's title, for notices about tasks that aren't visible. */
  title(id: string): string | undefined;
}

export const ACCESS: Record<Access, { label: string; description: string }> = {
  read: { label: 'Read only', description: 'See the machine’s harnesses and models, and read threads launched there. Agents cannot start, message or stop anything.' },
  ask: { label: 'Ask first', description: 'Also launch and message threads. Threads run in Standard mode, so their approvals come back here.' },
  full: { label: 'Full access', description: 'As Ask first, but a thread runs in Full access when the task that launched it is in Full access. An agent never gets more access there than its own mode here.' },
};
const ENABLE_TIP = 'Agents never link on their own: each link asks you first, and you choose the computer and what agents may do there. Launched threads appear here as ordinary tasks.';
/** Native session statuses: `running` and `waiting` (needs the user) are live; the rest are settled. */
const RUNNING = new Set(['running', 'starting']);
const NEEDS_YOU = new Set(['waiting', 'waiting_approval']);
/** Agent events that can change a thread's status; text and tool deltas never do. */
const STATUS_EVENTS = new Set(['turn_start', 'turn_complete', 'status', 'approval', 'approval_cancelled', 'input_request', 'input_cancelled', 'error', 'done']);
const INITIALS: Record<string, string> = { claude: 'CL', codex: 'CX', opencode: 'OC', antigravity: 'AG' };

let host: OrchestrationHost | undefined;
let pending: LinkRequest[] = [], enabled = false, frame = 0;
/** Requests answered here or settled natively; a late snapshot must not bring them back. */
const settled = new Set<string>();
const children = new Map<string, MachineChild[]>();
/** One request per task in flight; `again` asks for one more after it, `generation` drops stale replies. */
const inflight = new Set<string>(), again = new Set<string>(), generation = new Map<string, number>();
/** Expanded lineage strips and transcript cards, per task and per card. */
const expanded = new Set<string>();
/** Launched threads the lineage cap dropped, fetched once by id (`orchestration_threads`). */
const older = new Map<string, MachineChild>(), asked = new Set<string>();
const THREADS_PER_CALL = 64;
let ticker = 0;

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const running = (child: MachineChild) => RUNNING.has(child.status);
const live = (child: MachineChild) => RUNNING.has(child.status) || NEEDS_YOU.has(child.status);
export const initials = (provider: string) => INITIALS[provider] ?? provider.slice(0, 2).toUpperCase();
export function childState(status: string): string {
  if (NEEDS_YOU.has(status)) return 'Needs you';
  if (RUNNING.has(status)) return 'Running';
  if (status === 'error' || status === 'failed') return 'Failed';
  return status === 'interrupted' || status === 'stopped' ? 'Stopped' : 'Done';
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
function elapsed(since: number): string {
  const s = Math.max(0, Math.round((Date.now() - since) / 1000));
  return s < 60 ? `${s}s` : s < 3600 ? `${Math.floor(s / 60)}m` : `${Math.floor(s / 3600)}h`;
}

/** Subscribes once at boot; the link card survives a reload through `orchestration_pending`. */
export async function initOrchestration(next: OrchestrationHost): Promise<void> {
  host = next;
  document.addEventListener('click', onClick);
  await Promise.all([
    next.listen('machine-link-request', (request: LinkRequest) => { if (!settled.has(request.requestId)) addRequest(request, true); }),
    next.listen('machine-link-settled', (event: { requestId: string }) => settle(event.requestId)),
    next.listen('orchestration://status', applyStatus),
    // While off, a presence change can't change anything here: no IPC. (Settings, when
    // open, refreshes its own list so linked computers' online dots stay current.)
    next.listen('remote://presence', () => { if (enabled) void next.call<OrchestrationStatus>('orchestration_status').then(applyStatus, () => undefined); }),
    next.listen('sessions-changed', () => syncOrchestration()),
    next.listen('agent-event', (event: { sessionId: string; kind: string }) => {
      if (!STATUS_EVENTS.has(event.kind)) return;
      const id = next.sessionId();
      if (event.sessionId === id || children.get(id)?.some(child => child.sessionId === event.sessionId)) syncOrchestration();
    }),
  ]);
  const [snapshot, status] = await Promise.all([
    next.call<LinkRequest[]>('orchestration_pending').catch(() => [] as LinkRequest[]),
    next.call<OrchestrationStatus>('orchestration_status').catch(() => undefined),
  ]);
  if (status) enabled = status.enabled;
  // Events may have landed while the snapshot was in flight: keep them, and skip anything settled since.
  for (const request of snapshot) if (!settled.has(request.requestId) && !pending.some(item => item.requestId === request.requestId)) addRequest(request, false);
  syncOrchestration();
}

function applyStatus(status: OrchestrationStatus): void {
  enabled = status.enabled;
  syncOrchestration();
}

function addRequest(request: LinkRequest, announce: boolean): void {
  pending = [...pending.filter(item => item.requestId !== request.requestId), request];
  render();
  const h = host;
  if (!announce || !h || request.sessionId === h.sessionId()) return;
  // The agent waits on the user; a request from a task out of view must not stall unseen.
  const title = h.title(request.sessionId);
  h.notify(`${title ? `“${title}”` : 'A task'} is asking to link a machine.`, { label: 'Open task', run: () => h.openSession(request.sessionId) });
}
function settle(requestId: string): void {
  settled.add(requestId);
  pending = pending.filter(item => item.requestId !== requestId);
  render();
}

/** Draws from what is known now, then refreshes the visible task's threads, at most once per frame. */
export function syncOrchestration(): void {
  render();
  if (frame || !host) return;
  frame = requestAnimationFrame(() => {
    frame = 0;
    const id = host?.sessionId();
    // Off and never seen with threads: no call at all.
    if (id && (enabled || children.has(id))) refresh(id);
  });
}

function refresh(id: string): void {
  const h = host;
  if (!h) return;
  if (inflight.has(id)) { again.add(id); return; }
  inflight.add(id);
  const mine = (generation.get(id) ?? 0) + 1;
  generation.set(id, mine);
  void h.call<MachineChild[]>('orchestration_children', { sessionId: id }).then(list => {
    if (generation.get(id) !== mine) return;
    const changed = JSON.stringify(children.get(id) ?? []) !== JSON.stringify(list);
    if (list.length) children.set(id, list); else children.delete(id);
    render();
    if (changed && id === h.sessionId()) decorateTranscript();
  }, () => undefined).finally(() => {
    inflight.delete(id);
    if (again.delete(id)) refresh(id);
  });
}

function linkCard(request: LinkRequest): string {
  const reason = request.reason.trim();
  return `<section class="machine-link-card" aria-label="Link a machine" data-request="${escape(request.requestId)}">${icon('monitor', 'machine-link-mark')}<div class="machine-link-text"><strong>Link a machine to this environment</strong>${reason ? `<span title="${escape(reason)}">${escape(reason)}</span>` : ''}</div><span class="machine-actions"><button type="button" class="machine-quiet" data-mo="decline" data-request="${escape(request.requestId)}">Not now</button><button type="button" class="machine-primary" data-mo="link" data-request="${escape(request.requestId)}" aria-haspopup="dialog">Link…</button></span></section>`;
}

const faces = (list: MachineChild[]) => [...new Set(list.map(child => initials(child.provider)))].slice(0, 3).map(face => `<span>${escape(face)}</span>`).join('');
function threadRows(list: MachineChild[], stop: boolean): string {
  return `<ul class="lineage-rows">${list.map(child => `<li class="lineage-row" data-thread="${escape(child.sessionId)}"><span class="lineage-face" aria-hidden="true">${escape(initials(child.provider))}</span><button type="button" class="lineage-open" data-mo="open" data-session="${escape(child.sessionId)}" title="Open ${escape(child.title)}">${escape(child.title)}</button><span class="lineage-where">on ${escape(child.machine.name)} · ${childState(child.status)}</span>${stop && live(child) ? `<button type="button" class="machine-quiet" data-mo="stop" data-session="${escape(child.sessionId)}" aria-label="Stop ${escape(child.title)}">Stop</button>` : ''}</li>`).join('')}</ul>`;
}
function counts(list: MachineChild[]): string {
  const working = list.filter(running).length, needs = list.filter(child => NEEDS_YOU.has(child.status)).length;
  return [`${working} running`, needs ? `${needs} need${needs === 1 ? 's' : ''} you` : ''].filter(Boolean).join(' · ');
}

export function lineageHtml(list: MachineChild[], parentRunning: boolean, open: boolean): string {
  if (!list.length) return '';
  const working = list.filter(running), machines = [...new Set(list.map(child => child.machine.name))];
  const where = machines.length === 1 ? machines[0] : plural(machines.length, 'machine');
  const waiting = !parentRunning && working.length
    ? `<div class="lineage-wait" role="status"><span class="lineage-spinner" aria-hidden="true"></span><strong>Waiting on ${plural(working.length, 'thread')}</strong><span class="lineage-titles">${escape(working.map(child => child.title).join(', '))}</span><button type="button" class="machine-quiet" data-mo="stop-all">Stop all</button></div>` : '';
  return `<section class="lineage${open ? ' is-open' : ''}" aria-label="Threads on other machines"><div class="lineage-line"><span class="lineage-faces" aria-hidden="true">${faces(list)}</span><button type="button" class="lineage-summary" data-mo="toggle" aria-expanded="${open}"><strong>${plural(list.length, 'thread')} on ${escape(where)}</strong><span>${counts(list)}</span>${icon('chevron', 'lineage-chevron')}</button></div>${open ? threadRows(list, true) : ''}</section>${waiting}`;
}

/** The transcript card for one turn's launches, like a subagents card: `2 threads · 2 working`. */
export function threadsCardHtml(list: MachineChild[], key: string, open: boolean): string {
  const working = list.filter(live);
  const since = Math.min(...list.map(child => child.createdAt));
  return `<div class="machine-threads${open ? ' is-open' : ''}" data-card="${escape(key)}"><button type="button" class="machine-threads-summary" data-mo="card" data-card="${escape(key)}" aria-expanded="${open}"><span class="lineage-faces" aria-hidden="true">${faces(list)}</span><span class="machine-threads-copy"><strong>${plural(list.length, 'thread')}</strong><small>${working.length ? `${working.length} working` : 'all settled'}</small></span>${working.length ? `<span class="machine-threads-time" data-since="${since}">${elapsed(since)}</span>` : ''}${icon('chevron', 'lineage-chevron')}</button>${open ? threadRows(list, false) : ''}</div>`;
}

/** Puts one threads card after each turn (or live tool group) whose launch calls named threads.
 * Runs on transcript and children revisions only. Reads the cached children, plus older threads
 * fetched once by id; launch rows carry `data-machine-thread` from tool-activity.ts. */
export function decorateTranscript(): void {
  const root = document.querySelector<HTMLElement>('#transcript');
  if (!root || !host) return;
  const id = host.sessionId(), rows = root.querySelectorAll<HTMLElement>('[data-machine-thread]');
  if (!rows.length) {
    for (const card of root.querySelectorAll('.machine-threads')) card.remove();
    syncTicker();
    return;
  }
  const byId = new Map((children.get(id) ?? []).map(child => [child.sessionId, child]));
  const groups = new Map<Element, MachineChild[]>(), missing: string[] = [];
  for (const row of rows) {
    const thread = row.dataset.machineThread!, child = byId.get(thread) ?? older.get(thread);
    if (!child) { if (!asked.has(thread)) missing.push(thread); continue; }
    const anchor = row.closest('.turn-activity') ?? row.closest('.tool-group') ?? row;
    groups.set(anchor, [...(groups.get(anchor) ?? []).filter(item => item !== child), child]);
  }
  if (missing.length) fetchOlder(id, [...new Set(missing)]);
  const keep = new Set<Element>();
  for (const [anchor, list] of groups) {
    const key = `card:${list[0].sessionId}`;
    let card = anchor.nextElementSibling as HTMLElement | null;
    if (card?.classList.contains('machine-threads')) patchCard(card, list, key);
    else { anchor.insertAdjacentHTML('afterend', threadsCardHtml(list, key, expanded.has(key))); card = anchor.nextElementSibling as HTMLElement; }
    keep.add(card);
  }
  for (const card of root.querySelectorAll('.machine-threads')) if (!keep.has(card)) card.remove();
  syncTicker();
}

/** One batched lookup per revision for launch rows the children list no longer carries. */
function fetchOlder(sessionId: string, ids: string[]): void {
  const h = host;
  if (!h) return;
  for (let index = 0; index < ids.length; index += THREADS_PER_CALL) {
    const batch = ids.slice(index, index + THREADS_PER_CALL);
    batch.forEach(item => asked.add(item));
    void h.call<MachineChild[]>('orchestration_threads', { sessionId, ids: batch }).then(list => {
      for (const child of list) older.set(child.sessionId, child);
      if (list.length && h.sessionId() === sessionId) decorateTranscript();
    }, () => batch.forEach(item => asked.delete(item)));
  }
}

/** Updates a card where it stands, so a focused summary or row keeps focus. */
function patchCard(card: HTMLElement, list: MachineChild[], key: string): void {
  const template = document.createElement('template');
  template.innerHTML = threadsCardHtml(list, key, expanded.has(key));
  const fresh = template.content.firstElementChild as HTMLElement;
  if (card.className !== fresh.className) card.className = fresh.className;
  card.dataset.card = key;
  const button = card.querySelector<HTMLElement>('.machine-threads-summary')!, next = fresh.querySelector<HTMLElement>('.machine-threads-summary')!;
  button.dataset.card = key;
  button.setAttribute('aria-expanded', next.getAttribute('aria-expanded')!);
  if (button.innerHTML !== next.innerHTML) button.innerHTML = next.innerHTML;
  const rows = card.querySelector('.lineage-rows'), nextRows = fresh.querySelector('.lineage-rows');
  if (!nextRows) rows?.remove();
  else if (!rows) card.append(nextRows);
  else {
    const old = new Map([...rows.children].map(item => [(item as HTMLElement).dataset.thread, item]));
    const items = [...nextRows.children].map(item => { const kept = old.get((item as HTMLElement).dataset.thread); return kept?.outerHTML === item.outerHTML ? kept : item; });
    if (items.length !== rows.children.length || items.some((item, index) => rows.children[index] !== item)) rows.replaceChildren(...items);
  }
}

/** One shared 1 s tick for the elapsed time on working cards; off when none is shown. */
function syncTicker(): void {
  const any = document.querySelector('#transcript .machine-threads-time');
  if (any && !ticker) ticker = window.setInterval(tick, 1000);
  else if (!any && ticker) { window.clearInterval(ticker); ticker = 0; }
}
function tick(): void {
  const times = document.querySelectorAll<HTMLElement>('#transcript .machine-threads-time[data-since]');
  if (!times.length) { window.clearInterval(ticker); ticker = 0; return; }
  if (document.hidden) return;
  for (const time of times) { const text = elapsed(Number(time.dataset.since)); if (time.textContent !== text) time.textContent = text; }
}

function render(): void {
  const slot = document.querySelector<HTMLElement>('#machine-orchestration');
  if (!host) return;
  const id = host.sessionId();
  if (slot) {
    const html = pending.filter(request => request.sessionId === id).map(linkCard).join('') + lineageHtml(children.get(id) ?? [], host.running(), expanded.has(id));
    if (slot.innerHTML !== html) slot.innerHTML = html;
  }
}

function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(':is(#machine-orchestration, .machine-threads) [data-mo]');
  if (!target || !host) return;
  const h = host, action = target.dataset.mo, request = pending.find(item => item.requestId === target.dataset.request);
  const fail = (e: unknown) => h.notify(message(e));
  const toggle = (key: string) => { if (!expanded.delete(key)) expanded.add(key); render(); decorateTranscript(); };
  if (action === 'decline' && request) void h.call('orchestration_link_respond', { requestId: request.requestId }).then(() => settle(request.requestId), fail);
  else if (action === 'link' && request) void openLinkDialog({ request });
  else if (action === 'toggle') toggle(h.sessionId());
  else if (action === 'card' && target.dataset.card) toggle(target.dataset.card);
  else if (action === 'open' && target.dataset.session) h.openSession(target.dataset.session);
  else if (action === 'stop' && target.dataset.session) void h.call('stop_session', { sessionId: target.dataset.session }).then(syncOrchestration, fail);
  else if (action === 'stop-all') {
    const list = (children.get(h.sessionId()) ?? []).filter(live);
    void Promise.all(list.map(child => h.call('stop_session', { sessionId: child.sessionId }))).then(syncOrchestration, fail);
  }
}

/* Link a machine: 1 Machine, 2 Access. With a request it answers the agent; without one
 * (Settings) it saves the link directly. */
type Row = RemoteDevice & { access: Access | null; why: string };
export function deviceRows(devices: RemoteDevice[], links: OrchestrationLink[]): Row[] {
  return devices.filter(device => !device.current).map(device => ({
    ...device,
    access: links.find(link => link.deviceId === device.id)?.access ?? null,
    why: !device.host ? 'Remote control off · turn it on on that computer' : '',
  }));
}
function badges(row: Row): string {
  // A disabled row names its reason (and the fix) in `why` instead of a badge.
  const list = [row.access ? 'Linked' : '', row.online ? '' : 'Offline'].filter(Boolean);
  return list.map(text => `<span class="machine-badge">${text}</span>`).join('');
}

export async function openLinkDialog(options: { request?: LinkRequest; deviceId?: string } = {}): Promise<void> {
  if (!host) return;
  const h = host;
  let rows: Row[] = [], step: 1 | 2 = 1, chosen = '', access: Access = 'ask', error = '', busy = false;
  const dialog = h.modal('Link a machine', '<p class="dialog-description">Agents here can then launch, message and wait on threads there.</p><form id="machine-link-form" class="machine-link-form"><p class="dialog-loading" role="status">Loading computers…</p></form>', 'machine-link-dialog');
  const form = dialog.querySelector<HTMLFormElement>('#machine-link-form')!;
  try {
    const [devices, status] = await Promise.all([h.call<RemoteDevice[]>('remote_devices'), h.call<OrchestrationStatus>('orchestration_status')]);
    rows = deviceRows(devices, status.links);
  } catch (e) { error = message(e); }
  if (!form.isConnected) return;
  const wanted = (options.deviceId ?? options.request?.machine ?? '').toLowerCase();
  const usable = rows.filter(row => !row.why);
  chosen = (usable.find(row => row.id.toLowerCase() === wanted || row.name.toLowerCase() === wanted) ?? usable[0])?.id ?? '';

  const machineStep = () => rows.length
    ? `<fieldset class="machine-list"><legend class="sr-only">Machine</legend>${rows.map(row => `<label class="machine-row${row.why ? ' is-disabled' : ''}"><input type="radio" name="machine" value="${escape(row.id)}" ${row.id === chosen ? 'checked' : ''} ${row.why ? 'disabled' : ''}><span class="remote-dot" data-online="${row.online}" aria-hidden="true"></span><span class="machine-name">${escape(row.name)}</span><span class="machine-platform">${escape(row.platform)}</span>${badges(row)}${row.why ? `<small class="machine-why">${escape(row.why)}</small>` : ''}</label>`).join('')}</fieldset>`
    : '<p class="remote-note">No other computers on this account yet. Sign in to PandaCode Connect on another computer first.</p>';
  const accessStep = () => `<label class="field-label" for="machine-access">What agents here may do there</label><select id="machine-access">${(Object.keys(ACCESS) as Access[]).map(key => `<option value="${key}" ${key === access ? 'selected' : ''}>${ACCESS[key].label}</option>`).join('')}</select><p class="field-help machine-access-help" data-live>${escape(ACCESS[access].description)}</p>`;
  function draw(): void {
    const name = rows.find(row => row.id === chosen)?.name ?? '';
    form.innerHTML = `${options.request?.reason ? `<p class="machine-reason">${escape(options.request.reason)}</p>` : ''}<ol class="machine-steps"><li ${step === 1 ? 'aria-current="step"' : ''}><span>${step === 2 ? icon('check') : '1'}</span>${step === 2 ? `Machine: ${escape(name)}` : 'Machine'}</li><li ${step === 2 ? 'aria-current="step"' : ''}><span>2</span>Access</li></ol>${step === 1 ? machineStep() : accessStep()}${error ? `<p class="remote-error" role="alert">${escape(error)}</p>` : ''}<div class="dialog-footer">${step === 1
      ? `<button type="button" class="secondary-button" data-step="cancel">Cancel</button><button type="submit" class="primary-button" ${chosen ? '' : 'disabled'}>Continue</button>`
      : `<button type="button" class="secondary-button" data-step="back">Back</button><button type="submit" class="primary-button" ${busy ? 'disabled' : ''}>Link</button>`}</div>`;
    form.querySelector<HTMLElement>(step === 1 ? 'input[name="machine"]:checked' : '#machine-access')?.focus();
  }
  form.addEventListener('change', event => {
    const input = event.target as HTMLInputElement | HTMLSelectElement;
    if (input.name === 'machine') { chosen = input.value; form.querySelector<HTMLButtonElement>('[type="submit"]')!.disabled = false; }
    if (input.id === 'machine-access') { access = input.value as Access; form.querySelector('.machine-access-help')!.textContent = ACCESS[access].description; }
  });
  form.addEventListener('click', event => {
    const step_ = (event.target as HTMLElement).closest<HTMLElement>('[data-step]')?.dataset.step;
    if (step_ === 'cancel') h.closeModal();
    else if (step_ === 'back') { step = 1; error = ''; draw(); }
  });
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (step === 1) { if (!chosen) return; step = 2; access = rows.find(row => row.id === chosen)?.access ?? 'ask'; error = ''; draw(); return; }
    if (busy) return;
    busy = true; draw();
    const request = options.request;
    const call = request
      ? h.call<OrchestrationStatus>('orchestration_link_respond', { requestId: request.requestId, deviceId: chosen, access })
      : h.call<OrchestrationStatus>('orchestration_set_link', { deviceId: chosen, access });
    void call.then(() => {
      if (request) settle(request.requestId);
      if (dialog.open && form.isConnected) h.closeModal();
      h.notify(`Linked ${rows.find(row => row.id === chosen)?.name ?? 'the machine'} · ${ACCESS[access].label}`);
    }, e => { busy = false; error = message(e); if (form.isConnected) draw(); });
  });
  draw();
}

/** Settings → Remote access, signed in: the orchestration switch and linked computers. */
export function mountOrchestrationSettings(root: HTMLElement, remote: RemoteHost): () => void {
  let status: OrchestrationStatus | undefined, error = '', disposed = false;
  const fail = (e: unknown) => { error = message(e); render(); };
  const apply = (next: OrchestrationStatus) => { status = next; error = ''; render(); };
  const select = (link: OrchestrationLink) => `<select class="settings-select" data-access="${escape(link.deviceId)}" aria-label="Access: ${escape(link.name)}">${(Object.keys(ACCESS) as Access[]).map(key => `<option value="${key}" ${key === link.access ? 'selected' : ''}>${ACCESS[key].label}</option>`).join('')}</select>`;
  function render(): void {
    if (disposed) return;
    if (!status) { root.innerHTML = ''; return; }
    const links = status.links.map(link => `<div class="setting-row machine-linked" data-link="${escape(link.deviceId)}"><div><strong><span class="remote-dot" data-online="${link.online}" role="img" aria-label="${link.online ? 'Online' : 'Offline'}"></span>${escape(link.name)}</strong><small>${escape(link.platform)} · ${ACCESS[link.access].label}</small></div>${select(link)}<button type="button" class="secondary-button" data-unlink="${escape(link.deviceId)}" aria-label="Unlink ${escape(link.name)}">Unlink</button></div>`).join('');
    root.innerHTML = `<h3 class="settings-heading">Agent orchestration</h3><div class="settings-group"><div class="setting-row"><div><strong>Agent orchestration ${infoMark(ENABLE_TIP, 'About agent orchestration')}</strong><small>Agents here can ask to link your other computers and run threads there.</small></div><input type="checkbox" class="settings-switch" id="orchestration-enabled" aria-label="Agent orchestration" ${status.enabled ? 'checked' : ''}></div>${links || '<div class="setting-row"><div><small>No linked computers.</small></div></div>'}<div class="setting-row"><div><small>Linked computers are the ones agents here may use.</small></div><button type="button" class="secondary-button" data-link-new aria-haspopup="dialog">Link a computer…</button></div></div>${error ? `<p class="remote-error" role="alert">${escape(error)}</p>` : ''}`;
  }
  root.addEventListener('click', event => {
    const target = (event.target as HTMLElement).closest<HTMLElement>('button');
    if (!target) return;
    if (target.hasAttribute('data-link-new')) void openLinkDialog();
    else if (target.dataset.unlink) void remote.call<OrchestrationStatus>('orchestration_set_link', { deviceId: target.dataset.unlink, access: null }).then(apply, fail);
  });
  root.addEventListener('change', event => {
    const input = event.target as HTMLInputElement;
    if (input.id === 'orchestration-enabled') void remote.call<OrchestrationStatus>('orchestration_set_enabled', { enabled: input.checked }).then(apply, e => { input.checked = !input.checked; fail(e); });
    else if (input.dataset.access) void remote.call<OrchestrationStatus>('orchestration_set_link', { deviceId: input.dataset.access, access: input.value }).then(apply, fail);
  });
  const reload = () => void remote.call<OrchestrationStatus>('orchestration_status').then(apply, fail);
  const unlisten = [remote.listen('orchestration://status', apply), remote.listen('remote://presence', reload)];
  reload();
  return () => { disposed = true; for (const u of unlisten) void u.then(fn => fn(), () => undefined); };
}
