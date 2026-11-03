/* Multi-machine orchestration (docs/machine-orchestration.md): the link card and Link a machine
 * dialog for an agent's `pandacode_machine_link` request, the Lineage panel in the dock's Agents
 * flyout, the one-line waiting state above the composer, the transcript's threads card, and the
 * Settings → Remote access orchestration controls. Imported statically by main.ts, so its
 * stylesheet is always loaded before the composer renders. */
import './machine-orchestration.css';
import { escape, icon } from './dom';
import { enterView, reducedMotion, type Spring } from './motion';
import { showPopover, hidePopover } from './popover-motion';
import { infoMark } from './tooltip';
import type { RemoteDevice, RemoteHost } from './remote-types';

export type Access = 'read' | 'ask' | 'full';
export interface OrchestrationLink { deviceId: string; name: string; platform: string; online: boolean; access: Access; departed?: boolean }
export interface OrchestrationStatus { enabled: boolean; links: OrchestrationLink[] }
export interface LinkRequest { requestId: string; sessionId: string; machine: string | null; reason: string }
export interface MachineChild { sessionId: string; title: string; provider: string; model: string; status: string; machine: { id: string; name: string }; createdAt: number; hostOffline?: boolean }

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
  /** Whether the visible task's conversation pane is on screen (not the board or GitHub view). */
  visible(): boolean;
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
/** Expanded transcript cards. */
const expanded = new Set<string>();
/** Launched threads the lineage cap dropped, fetched once by id (`orchestration_threads`). */
const older = new Map<string, MachineChild>(), asked = new Set<string>();
const THREADS_PER_CALL = 64;
let ticker = 0;
/** Which threads each drawn transcript card holds, and the card of each thread: a status change
 * goes straight to its card, with no transcript scan. Rebuilt by `decorateTranscript`. */
const cards = new Map<HTMLElement, string[]>(), threadCards = new Map<string, HTMLElement>();
/** What each row last drew, so an unchanged row costs one string compare and no DOM reads. */
const painted = new WeakMap<Element, string>();
let panel: HTMLElement | undefined, panelTask = '', lastTask = '', agentsSignal = '';
/** The short spring rows and the waiting line arrive on. */
const ROW_SPRING: Spring = { response: 0.2 };
const arrive = (element: HTMLElement, distance: number) => { if (!reducedMotion()) enterView(element, distance, ROW_SPRING); };

const message = (e: unknown) => e instanceof Error ? e.message : String(e);
const live = (child: MachineChild) => RUNNING.has(child.status) || NEEDS_YOU.has(child.status);
/** A live thread whose computer is unreachable: nobody can say it is working, or that it stopped. */
const away = (child: MachineChild) => Boolean(child.hostOffline) && live(child);
const running = (child: MachineChild) => RUNNING.has(child.status) && !child.hostOffline;
const needsYou = (child: MachineChild) => NEEDS_YOU.has(child.status) && !child.hostOffline;
export const initials = (provider: string) => INITIALS[provider] ?? provider.slice(0, 2).toUpperCase();
export function childState(status: string): string {
  if (NEEDS_YOU.has(status)) return 'Needs you';
  if (RUNNING.has(status)) return 'Running';
  if (status === 'error' || status === 'failed') return 'Failed';
  return status === 'interrupted' || status === 'stopped' ? 'Stopped' : 'Done';
}
const threadState = (child: MachineChild) => away(child) ? 'Offline' : childState(child.status);
const whereText = (child: MachineChild) => `on ${child.machine.name} · ${threadState(child)}`;
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
    if (id === reopenFor && !list.length) reopenFor = '';
    const before = children.get(id) ?? [];
    if (JSON.stringify(before) === JSON.stringify(list)) return;
    if (list.length) children.set(id, list); else children.delete(id);
    render();
    if (id !== h.sessionId()) return;
    // Only a new or dropped thread can change which cards exist; a status change patches its own.
    if (before.length === list.length && before.every((child, index) => child.sessionId === list[index].sessionId)) patchCards(before, list);
    else decorateTranscript();
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
const rowHtml = (child: MachineChild, stop: boolean) => `<li class="lineage-row" data-thread="${escape(child.sessionId)}" data-state="${threadState(child)}"><span class="lineage-face" aria-hidden="true">${escape(initials(child.provider))}</span><button type="button" class="lineage-open" data-mo="open" data-session="${escape(child.sessionId)}" title="Open ${escape(child.title)}">${escape(child.title)}</button><span class="lineage-where">${escape(whereText(child))}</span>${stop ? `<button type="button" class="machine-quiet lineage-stop" data-mo="stop" data-session="${escape(child.sessionId)}" aria-label="Stop ${escape(child.title)}" ${live(child) ? '' : 'hidden'}>Stop</button>` : ''}</li>`;
const rowKey = (child: MachineChild) => [child.title, child.provider, child.machine.name, child.status, child.hostOffline ? 1 : 0].join('\n');
function setText(node: Element | null | undefined, text: string): void { if (node && node.textContent !== text) node.textContent = text; }
function fromHtml(html: string): HTMLElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template.content.firstElementChild as HTMLElement;
}

/** Updates one row where it stands, touching only what changed, so focus and hover survive. */
function patchRow(row: HTMLElement, child: MachineChild): void {
  const key = rowKey(child);
  if (painted.get(row) === key) return;
  painted.set(row, key);
  const state = threadState(child), open = row.querySelector<HTMLElement>('.lineage-open')!, stop = row.querySelector<HTMLButtonElement>('.lineage-stop');
  if (row.dataset.state !== state) row.dataset.state = state;
  setText(row.querySelector('.lineage-face'), initials(child.provider));
  setText(open, child.title);
  const tip = `Open ${child.title}`;
  if (open.title !== tip) open.title = tip;
  setText(row.querySelector('.lineage-where'), whereText(child));
  if (stop) {
    if (stop.hidden === live(child)) stop.hidden = !live(child);
    if (stop.getAttribute('aria-label') !== `Stop ${child.title}`) stop.setAttribute('aria-label', `Stop ${child.title}`);
  }
}

/** Keyed: rows are made once, patched in place and moved only when out of order. */
function syncRows(list: HTMLElement, threads: MachineChild[], stop: boolean, animate = false): void {
  const rows = new Map([...list.children].map(row => [(row as HTMLElement).dataset.thread!, row as HTMLElement]));
  const wanted = new Set(threads.map(child => child.sessionId));
  for (const [id, row] of rows) if (!wanted.has(id)) row.remove();
  let at = list.firstElementChild;
  for (const child of threads) {
    let row = rows.get(child.sessionId);
    if (!row) {
      row = fromHtml(rowHtml(child, stop));
      painted.set(row, rowKey(child));
      list.insertBefore(row, at);
      if (animate) arrive(row, 3);
    } else {
      patchRow(row, child);
      if (row === at) at = at.nextElementSibling; else list.insertBefore(row, at);
    }
  }
}

/** `Lineage · 2 running · 1 needs you · 1 offline`. */
export function lineageHeading(list: MachineChild[]): string {
  const needs = list.filter(needsYou).length, gone = list.filter(away).length;
  return ['Lineage', `${list.filter(running).length} running`, needs ? `${needs} need${needs === 1 ? 's' : ''} you` : '', gone ? `${gone} offline` : ''].filter(Boolean).join(' · ');
}

let reopenFor = '';
const flyoutOpen = () => document.querySelector<HTMLElement>('#agents-flyout')?.hidden === false;
const visibleThreads = () => host?.visible() ? children.get(host.sessionId()) ?? [] : [];
function paintPanel(animate: boolean): void {
  if (!panel) return;
  const list = visibleThreads();
  setText(panel.querySelector('.lineage-count'), lineageHeading(list));
  const stopAll = panel.querySelector<HTMLButtonElement>('[data-mo="stop-all"]')!;
  if (stopAll.hidden === list.some(live)) stopAll.hidden = !stopAll.hidden;
  syncRows(panel.querySelector<HTMLElement>('.lineage-rows')!, list, true, animate);
}
function openPanel(): void {
  const root = document.querySelector<HTMLElement>('#lineage-host'), item = document.querySelector<HTMLElement>('#agents-toggle');
  if (panel || !root || !item || !host || !visibleThreads().length) return;
  panel = document.createElement('section');
  panel.className = 'lineage-panel'; panel.setAttribute('role', 'region'); panel.setAttribute('aria-label', 'Lineage');
  panel.innerHTML = '<header class="lineage-heading"><strong class="lineage-count"></strong><button type="button" class="machine-quiet" data-mo="stop-all">Stop all</button></header><ul class="lineage-rows"></ul>';
  root.append(panel);
  panelTask = host.sessionId();
  paintPanel(false);
  showPopover(panel, item);
}
function closePanel(): void {
  if (panel) {
    // Switching to a task whose threads aren't loaded yet must not lose a Lineage panel left open;
    // the dock hides it first, seeing nothing to show, so this is the one place both paths share.
    const id = host?.sessionId();
    if (id && panelTask !== id && !children.has(id)) reopenFor = id;
    hidePopover(panel);
  }
  panel = undefined;
}
/** The third source of the dock's Agents item (`mountAgents`), beside the team and subagents. */
export const lineageSource = {
  get present() { return visibleThreads().length > 0; },
  get running() { return visibleThreads().filter(running).length; },
  get isOpen() { return Boolean(panel); },
  open: openPanel,
  close: closePanel,
};

/** The transcript card for one turn's launches, like a subagents card: `2 threads · 2 working`. */
export function threadsCardHtml(list: MachineChild[], key: string, open: boolean): string {
  return `<div class="machine-threads${open ? ' is-open' : ''}" data-card="${escape(key)}"><button type="button" class="machine-threads-summary" data-mo="card" data-card="${escape(key)}" aria-expanded="${open}"><span class="lineage-faces" aria-hidden="true">${faces(list)}</span><span class="machine-threads-copy"><strong>${plural(list.length, 'thread')}</strong><small>${cardState(list)}</small></span><span class="machine-threads-time" data-since="${cardSince(list)}" ${list.some(working) ? '' : 'hidden'}>${elapsed(cardSince(list))}</span>${icon('chevron', 'lineage-chevron')}</button>${open ? `<ul class="lineage-rows">${list.map(child => rowHtml(child, false)).join('')}</ul>` : ''}</div>`;
}
const working = (child: MachineChild) => live(child) && !child.hostOffline;
const cardSince = (list: MachineChild[]) => Math.min(...list.map(child => child.createdAt));
function cardState(list: MachineChild[]): string {
  const busy = list.filter(working).length, gone = list.filter(away).length;
  return [busy ? `${busy} working` : '', gone ? `${gone} offline` : ''].filter(Boolean).join(' · ') || 'all settled';
}

/** Puts one threads card after each turn (or live tool group) whose launch calls named threads.
 * Runs on transcript and children revisions only. Reads the cached children, plus older threads
 * fetched once by id; launch rows carry `data-machine-thread` from tool-activity.ts. */
export function decorateTranscript(): void {
  const root = document.querySelector<HTMLElement>('#transcript');
  if (!root || !host) return;
  const id = host.sessionId(), rows = root.querySelectorAll<HTMLElement>('[data-machine-thread]');
  cards.clear(); threadCards.clear();
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
    if (card?.classList.contains('machine-threads')) paintCard(card, list, key);
    else { anchor.insertAdjacentHTML('afterend', threadsCardHtml(list, key, expanded.has(key))); card = anchor.nextElementSibling as HTMLElement; }
    keep.add(card);
    cards.set(card, list.map(child => child.sessionId));
    for (const child of list) threadCards.set(child.sessionId, card);
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

/** Updates a card where it stands, field by field, so a focused summary or row keeps focus. */
function paintCard(card: HTMLElement, list: MachineChild[], key: string): void {
  const open = expanded.has(key);
  if (card.classList.contains('is-open') !== open) card.classList.toggle('is-open', open);
  if (card.dataset.card !== key) card.dataset.card = key;
  const button = card.querySelector<HTMLElement>('.machine-threads-summary')!;
  if (button.dataset.card !== key) button.dataset.card = key;
  if (button.getAttribute('aria-expanded') !== String(open)) button.setAttribute('aria-expanded', String(open));
  const face = button.querySelector<HTMLElement>('.lineage-faces')!, nextFaces = faces(list);
  if (face.innerHTML !== nextFaces) face.innerHTML = nextFaces;
  setText(button.querySelector('strong'), plural(list.length, 'thread'));
  setText(button.querySelector('small'), cardState(list));
  const time = button.querySelector<HTMLElement>('.machine-threads-time')!, since = String(cardSince(list));
  if (time.dataset.since !== since) { time.dataset.since = since; time.textContent = elapsed(Number(since)); }
  if (time.hidden === list.some(working)) time.hidden = !time.hidden;
  let rows = card.querySelector<HTMLElement>('.lineage-rows');
  if (!open) rows?.remove();
  else {
    if (!rows) { rows = document.createElement('ul'); rows.className = 'lineage-rows'; card.append(rows); }
    syncRows(rows, list, false);
  }
}

/** A status change: repaints only the cards of the threads that changed. */
function patchCards(before: MachineChild[], list: MachineChild[]): void {
  const byId = new Map(list.map(child => [child.sessionId, child]));
  const touched = new Set(list.filter((child, index) => rowKey(child) !== rowKey(before[index])).flatMap(child => threadCards.get(child.sessionId) ?? []));
  for (const card of touched) {
    const threads = (cards.get(card) ?? []).flatMap(id => byId.get(id) ?? older.get(id) ?? []);
    if (card.isConnected && threads.length) paintCard(card, threads, card.dataset.card!);
  }
  syncTicker();
}

/** One shared 1 s tick for the elapsed time on working cards; off when none is shown. */
const shownTimes = () => [...cards.keys()].flatMap(card => card.isConnected ? [...card.querySelectorAll<HTMLElement>('.machine-threads-time:not([hidden])')] : []);
function syncTicker(): void {
  const any = shownTimes().length > 0;
  if (any && !ticker) ticker = window.setInterval(tick, 1000);
  else if (!any && ticker) { window.clearInterval(ticker); ticker = 0; }
}
function tick(): void {
  const times = shownTimes();
  if (!times.length) { window.clearInterval(ticker); ticker = 0; return; }
  if (document.hidden) return;
  for (const time of times) setText(time, elapsed(Number(time.dataset.since)));
}

/** One line while the parent is idle and its threads are still out: never a second list. */
function paintWait(slot: HTMLElement, list: MachineChild[], parentRunning: boolean, sameTask: boolean): void {
  const busy = list.filter(running), gone = list.filter(child => away(child) && RUNNING.has(child.status));
  let line = slot.querySelector<HTMLElement>(':scope>.lineage-wait');
  if (parentRunning || !(busy.length || gone.length)) { line?.remove(); return; }
  if (!line) {
    slot.insertAdjacentHTML('beforeend', '<div class="lineage-wait" role="status"><span class="lineage-spinner" aria-hidden="true"></span><strong></strong><span class="lineage-titles"></span><button type="button" class="machine-quiet" data-mo="stop-waiting" aria-label="Stop all waiting threads">Stop</button></div>');
    line = slot.lastElementChild as HTMLElement;
    // A line already there when a thread opens just shows; it only arrives when the state begins.
    if (sameTask) arrive(line, 4);
  }
  setText(line.querySelector('strong'), `Waiting on ${busy.length ? plural(busy.length, 'thread') : plural(gone.length, 'offline thread')}`);
  setText(line.querySelector('.lineage-titles'), [...busy.map(child => child.title), ...gone.map(child => `${child.title} ${whereText(child)}`)].join(', '));
}

/** Keyed by request, so a redraw never replaces a card whose button has focus. */
function paintLinks(slot: HTMLElement, id: string): void {
  const requests = pending.filter(request => request.sessionId === id), ids = new Set(requests.map(request => request.requestId));
  const shown = new Map([...slot.querySelectorAll<HTMLElement>(':scope>.machine-link-card')].map(card => [card.dataset.request!, card]));
  for (const [key, card] of shown) if (!ids.has(key)) card.remove();
  const wait = slot.querySelector(':scope>.lineage-wait');
  for (const request of requests) if (!shown.has(request.requestId)) slot.insertBefore(fromHtml(linkCard(request)), wait);
}

function render(): void {
  if (!host) return;
  const id = host.sessionId(), sameTask = id === lastTask, slot = document.querySelector<HTMLElement>('#machine-orchestration'), list = children.get(id) ?? [];
  if (slot) { paintLinks(slot, id); paintWait(slot, list, host.running(), sameTask); }
  const threads = visibleThreads();
  const stale = Boolean(panel) && (panelTask !== id || !threads.length);
  if (reopenFor !== id) reopenFor = '';
  if (stale) closePanel();
  // A flyout that stays open shows this task's threads in this same draw, whatever it showed before
  // (a task switch whose cached threads come back unchanged draws nothing else); with none of them
  // its observer hides it. Rows arrive only for a thread that is new to the same task.
  if (!panel && threads.length && (flyoutOpen() || reopenFor === id)) { reopenFor = ''; openPanel(); }
  else paintPanel(sameTask);
  lastTask = id;
  const signal = `${threads.length > 0}:${threads.filter(running).length}`;
  if (signal !== agentsSignal) { agentsSignal = signal; dispatchEvent(new Event('pandacode:agents')); }
}

function onClick(event: MouseEvent): void {
  const target = (event.target as HTMLElement | null)?.closest<HTMLElement>(':is(#machine-orchestration, .machine-threads, .lineage-panel) [data-mo]');
  if (!target || !host) return;
  const h = host, action = target.dataset.mo, request = pending.find(item => item.requestId === target.dataset.request);
  const fail = (e: unknown) => h.notify(message(e));
  const toggle = (key: string) => { if (!expanded.delete(key)) expanded.add(key); render(); decorateTranscript(); };
  if (action === 'decline' && request) void h.call('orchestration_link_respond', { requestId: request.requestId }).then(() => settle(request.requestId), fail);
  else if (action === 'link' && request) void openLinkDialog({ request });
  else if (action === 'card' && target.dataset.card) toggle(target.dataset.card);
  else if (action === 'open' && target.dataset.session) h.openSession(target.dataset.session);
  else if (action === 'stop' && target.dataset.session) {
    // The button hides once the thread stops, so focus moves to the row first.
    target.closest('.lineage-row')?.querySelector<HTMLElement>('.lineage-open')?.focus();
    void h.call('stop_session', { sessionId: target.dataset.session }).then(syncOrchestration, fail);
  } else if (action === 'stop-all' || action === 'stop-waiting') {
    const list = (children.get(h.sessionId()) ?? []).filter(action === 'stop-all' ? live : child => RUNNING.has(child.status));
    (action === 'stop-all' ? panel?.querySelector<HTMLElement>('.lineage-open') : document.querySelector<HTMLElement>('#prompt'))?.focus();
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
  /** A computer that left the account: nothing to set, but its threads stay readable until cut. */
  const departedRow = (link: OrchestrationLink) => `<div class="setting-row machine-linked is-departed" data-link="${escape(link.deviceId)}"><div><strong>${escape(link.name)} · Left the account</strong><small>Its threads stay readable until you unlink it.</small></div><button type="button" class="secondary-button" data-unlink="${escape(link.deviceId)}" aria-label="Unlink ${escape(link.name)}">Unlink</button></div>`;
  function render(): void {
    if (disposed) return;
    if (!status) { root.innerHTML = ''; return; }
    const links = status.links.map(link => link.departed ? departedRow(link) : `<div class="setting-row machine-linked" data-link="${escape(link.deviceId)}"><div><strong><span class="remote-dot" data-online="${link.online}" role="img" aria-label="${link.online ? 'Online' : 'Offline'}"></span>${escape(link.name)}</strong><small>${escape(link.platform)} · ${ACCESS[link.access].label}</small></div>${select(link)}<button type="button" class="secondary-button" data-unlink="${escape(link.deviceId)}" aria-label="Unlink ${escape(link.name)}">Unlink</button></div>`).join('');
    root.innerHTML = `<h3 class="settings-heading">Agent orchestration</h3><div class="settings-group"><div class="setting-row"><div><strong>Agent orchestration</strong><small>Agents here can ask to link your other computers and run threads there.</small></div><input type="checkbox" class="settings-switch" id="orchestration-enabled" aria-label="Agent orchestration" ${status.enabled ? 'checked' : ''}>${infoMark(ENABLE_TIP, 'About agent orchestration')}</div>${links || '<div class="setting-row"><div><small>No linked computers.</small></div></div>'}<div class="setting-row"><div><small>Linked computers are the ones agents here may use.</small></div><button type="button" class="secondary-button" data-link-new aria-haspopup="dialog">Link a computer…</button></div></div>${error ? `<p class="remote-error" role="alert">${escape(error)}</p>` : ''}`;
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
