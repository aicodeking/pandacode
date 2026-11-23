import './colab-pip.css';
import { escape, icon, isImeKey } from './dom';
import { errorText } from './error-text';
import { materializeIn, reducedMotion } from './motion';

/* The open thread's Google Colab runtimes, floating at the conversation's top right beside the
 * action dock. Collapsed it is one pill (what is running, for how long); expanded, a card with a
 * row per runtime and its actions. A runtime bills while it lives, so a ready one keeps showing
 * its uptime. It takes no layout, hides with no runtimes, and only its clock text changes on a
 * tick. Motion is the Web Animations API (motion.ts); reduced motion cross-fades. */

export type ColabRuntimeState = 'creating' | 'ready' | 'busy' | 'restarting' | 'stopping' | 'stopped' | 'error';
export type ColabThreadRuntime = {
  /** "colab:<endpoint>", or "colab:pending-<n>" while creating. */
  id: string;
  /** Bare endpoint, or "" while creating. */
  endpoint: string;
  name: string;
  /** "CPU", "T4 GPU", "v5e-1 TPU"… */
  hardware: string;
  highMem: boolean;
  state: ColabRuntimeState;
  activity: string | null;
  browserUrl: string | null;
  /** Unix epoch ms. */
  startedAt: number;
  busySince: number | null;
  error: string | null;
};
export type ColabAction = 'open_browser' | 'restart_kernel' | 'stop' | 'dismiss';
export type ColabPipHost = {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  notifyError(text: string): void;
  /** Speaks through a live region that stays mounted while the pip is hidden (the composer's). */
  announce(text: string): void;
};
export type ColabPip = {
  /** The pane's thread and whether the pip may show there; a new thread reloads its runtimes. */
  update(sessionId: string, allowed: boolean): void;
  /** A `colab-runtime` event's list; ignored for another thread. Before the thread's first list has loaded it is
   * taken in silently, as that list would be, unless `handoff`: the event that mounted the pip, whose runtimes are
   * all news. */
  set(sessionId: string, runtimes: unknown, handoff?: boolean): void;
  dispose(): void;
};

const GAP = 12, EDGE = 14, DOCK_GAP = 10, WHEEL_LINE = 16;
/** Left of a top-right progress PiP the pip needs this much room; with less it goes under the PiP. It never gets narrower than MIN_WIDTH. */
const BESIDE_MIN = 260, MIN_WIDTH = 160;
/** The card's width (colab-pip.css), for the room it needs beside a bottom progress PiP. */
const CARD_WIDTH = 340;
/** The transcript's top padding under the pill (colab-pip.css), and the pill's height with its gap when it sits lower. */
const PILL_CLEAR = 72, PILL_SPACE = 60;
/** How much of an error is read out. */
const SPOKEN_ERROR_CHARS = 200;
/** The fade a surface leaves with; the same short cross-fade under reduced motion. */
const EXIT_MS = 120;
const CARD_ID = 'colab-pip-card', CONFIRM_TEXT_ID = 'colab-pip-confirm-text', ERROR_ID = 'colab-pip-error';
const STATES: readonly ColabRuntimeState[] = ['creating', 'ready', 'busy', 'restarting', 'stopping', 'stopped', 'error'];
/** States whose clock counts seconds. */
const TICKING: ReadonlySet<ColabRuntimeState> = new Set(['creating', 'busy', 'restarting', 'stopping']);
/** Coming out of these, "Ready" is news; out of busy it is only a tool call ending. */
const COMING_UP: ReadonlySet<ColabRuntimeState> = new Set(['creating', 'restarting']);
/** Which runtime the pill speaks for when a thread has several: what needs the user, then what works. */
const LEAD: readonly ColabRuntimeState[] = ['error', 'busy', 'creating', 'restarting', 'stopping', 'ready', 'stopped'];
const STATE_TEXT: Record<ColabRuntimeState, string> = { creating: 'Starting…', ready: 'Ready', busy: 'Running', restarting: 'Restarting kernel…', stopping: 'Stopping…', stopped: 'Stopped', error: 'Error' };
const FAILED: Record<ColabAction, string> = { open_browser: 'Could not open the runtime in Colab.', restart_kernel: 'Could not restart the kernel.', stop: 'Could not stop the runtime.', dismiss: 'Could not dismiss the runtime.' };
/** The two actions that ask once more in the row before they run: what each asks and how its answer reads. */
type Confirmable = 'stop' | 'restart';
const QUESTION: Record<Confirmable, { text: string; yes: string; group: (name: string) => string }> = {
  stop: { text: 'Stop runtime? Running work stops, and unsaved files and kernel state are lost.', yes: 'Stop', group: name => `Stop ${name}` },
  restart: { text: 'Restart kernel? Running work stops and variables are lost.', yes: 'Restart', group: name => `Restart kernel of ${name}` },
};
const GLYPH = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 18.5h10.5a4 4 0 0 0 .6-7.95A6 6 0 0 0 6.6 9.6 4.5 4.5 0 0 0 7 18.5Z"/><path d="m9.75 11.5 2 1.75-2 1.75M13.5 15h1.75"/></svg>';

const text = (value: unknown): string => typeof value === 'string' ? value.trim() : '';
/** An error's first line that says something, or "" for none. */
const firstLine = (error: string | null): string => (error ?? '').split('\n').map(line => line.trim()).find(Boolean) ?? '';
const time = (value: unknown): number | null => typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;

/** The list as the backend sent it, checked: rows without an id are dropped, an unknown state reads as stopped. */
export function runtimesFrom(value: unknown): ColabThreadRuntime[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): ColabThreadRuntime[] => {
    const row = item as Partial<Record<keyof ColabThreadRuntime, unknown>> | null, id = text(row?.id);
    if (!row || !id || seen.has(id)) return [];
    seen.add(id);
    const state = STATES.includes(row.state as ColabRuntimeState) ? row.state as ColabRuntimeState : 'stopped';
    return [{
      id, endpoint: text(row.endpoint), name: text(row.name) || 'Colab runtime', hardware: text(row.hardware) || 'CPU', highMem: row.highMem === true, state,
      activity: text(row.activity) || null, browserUrl: text(row.browserUrl) || null, startedAt: time(row.startedAt) ?? 0, busySince: time(row.busySince), error: text(row.error) || null,
    }];
  });
}
/** A running clock: 0:18, 12:05, 1:02:09. */
export function stopwatch(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000)), h = Math.floor(s / 3600), m = Math.floor(s % 3600 / 60), pad = (n: number) => String(n).padStart(2, '0');
  return h ? `${h}:${pad(m)}:${pad(s % 60)}` : `${m}:${pad(s % 60)}`;
}
/** How long a runtime has been up, to the minute: <1m, 12m, 2h 5m. */
export function uptime(ms: number): string {
  const m = Math.max(0, Math.floor(ms / 60000)), h = Math.floor(m / 60);
  return m < 1 ? '<1m' : h ? `${h}h${m % 60 ? ` ${m % 60}m` : ''}` : `${m}m`;
}
/** "T4 GPU", or "T4 · High-RAM" with the bigger memory shape. */
export const hardwareLabel = (r: Pick<ColabThreadRuntime, 'hardware' | 'highMem'>): string => r.highMem ? `${r.hardware.replace(/ (?:GPU|TPU)$/, '')} · High-RAM` : r.hardware;
export const leadRuntime = (list: readonly ColabThreadRuntime[]): ColabThreadRuntime | undefined => LEAD.map(state => list.find(r => r.state === state)).find(Boolean);


const canOpen = (r: ColabThreadRuntime) => Boolean(r.browserUrl) && r.state !== 'stopped';
/* Restart and Stop stay in the row, waiting, while their own state runs: the row keeps its shape and the pressed
 * control its focus. */
const showsRestart = (r: ColabThreadRuntime) => Boolean(r.endpoint) && r.state !== 'creating' && r.state !== 'stopped';
const showsStop = (r: ColabThreadRuntime) => Boolean(r.endpoint) && r.state !== 'stopped';
const canStop = (r: ColabThreadRuntime) => showsStop(r) && r.state !== 'stopping';
const canRestart = (r: ColabThreadRuntime) => showsRestart(r) && r.state !== 'stopping' && r.state !== 'restarting';
/** A failed or stopped runtime, and one still being allocated: a start that hangs always has a way out. */
const canDismiss = (r: ColabThreadRuntime) => r.state === 'error' || r.state === 'stopped' || (r.state === 'creating' && !r.endpoint);

/** What a screen reader hears when the list changes, every change in one message: a runtime that appeared, came
 * up, failed, stopped or went. A tool call ending (busy → ready) says nothing. */
export function runtimeAnnouncement(before: readonly ColabThreadRuntime[], after: readonly ColabThreadRuntime[]): string {
  const was = new Map(before.map(r => [r.id, r]));
  const failure = (r: ColabThreadRuntime) => `error. ${firstLine(r.error).slice(0, SPOKEN_ERROR_CHARS)}`;
  const changed = after.flatMap((r): string[] => {
    const old = was.get(r.id);
    if (!old) return [r.state === 'creating' ? `Starting Google Colab runtime ${r.name}` : `Google Colab runtime ${r.name}: ${r.state === 'error' ? failure(r) : STATE_TEXT[r.state]}`];
    if (r.state === 'error') return old.state !== 'error' || old.error !== r.error ? [`${r.name}: ${failure(r)}`] : [];
    if (old.state === r.state) return [];
    if (r.state === 'ready') return COMING_UP.has(old.state) ? [`${r.name}: Ready`] : [];
    return r.state === 'stopped' ? [`${r.name} stopped`] : [];
  });
  // A starting runtime's placeholder row goes when the real one takes over, which is announced as that one.
  const appeared = after.some(r => !was.has(r.id));
  const gone = before.filter(r => !(r.state === 'creating' && appeared) && !after.some(next => next.id === r.id)).map(r => `${r.name} ${canDismiss(r) ? 'dismissed' : 'stopped'}`);
  return [...changed, ...gone].map(part => part.replace(/[.…\s]+$/, '')).join('. ');
}

type Control = { action: string; label: string; glyph?: string; off?: boolean; waiting?: boolean; danger?: boolean };
type FocusKey = { action: string; id: string };
const fromHtml = (html: string): HTMLElement => { const t = document.createElement('template'); t.innerHTML = html.trim(); return t.content.firstElementChild as HTMLElement; };
/* Writes that leave an unchanged node alone: a repaint touches only what differs. */
const setText = (el: Element | null, value: string): void => { if (el && el.textContent !== value) el.textContent = value; };
const setAttr = (el: Element | null, name: string, value: string | null): void => {
  if (!el) return;
  if (value === null) el.removeAttribute(name); else if (el.getAttribute(name) !== value) el.setAttribute(name, value);
};
const setHidden = (el: Element | null, hidden: boolean): void => { if (el instanceof HTMLElement && el.hidden !== hidden) el.hidden = hidden; };
/** Brings `box`'s children to `wanted`, in order, keeping every node that stays (and with it focus and scroll). */
function reconcile<T>(box: HTMLElement, wanted: readonly T[], key: (item: T) => string, keyOf: (el: HTMLElement) => string, create: (item: T) => HTMLElement, paint: (el: HTMLElement, item: T) => void): void {
  const keys = new Set(wanted.map(key)), kept = new Map<string, HTMLElement>();
  for (const el of [...box.children] as HTMLElement[]) { if (keys.has(keyOf(el)) && !kept.has(keyOf(el))) kept.set(keyOf(el), el); else el.remove(); }
  let cursor = box.firstElementChild;
  for (const item of wanted) {
    const el = kept.get(key(item)) ?? create(item);
    if (el === cursor) cursor = cursor.nextElementSibling; else box.insertBefore(el, cursor);
    paint(el, item);
  }
}
const STATUS_HTML = '<span class="cp-activity"></span><span class="cp-sep" aria-hidden="true" hidden>·</span><time class="cp-clock" hidden></time>';
const controlEl = (c: Control): HTMLElement => fromHtml(`<button type="button" class="cp-button${c.danger ? ' is-danger' : ''}" data-cp="${c.action}">${c.glyph ?? ''}<span>${c.label}</span></button>`);
/** Waiting controls are aria-disabled, not disabled: the one that was pressed keeps keyboard focus. */
function paintControl(el: HTMLElement, c: Control): void {
  setAttr(el, 'aria-disabled', c.off || c.waiting ? 'true' : null);
  setAttr(el, 'aria-busy', c.waiting ? 'true' : null);
}

export function mountColabPip(root: HTMLElement, host: ColabPipHost): ColabPip {
  let sessionId = '', allowed = false, runtimes: ColabThreadRuntime[] = [];
  let expanded = false, confirming: { id: string; action: Confirmable } | null = null, refreshing = false, loadTicket = 0, timer = 0, frame = 0, disposed = false;
  /** The open thread's list has been seen once. That first load is what was already there, and is not read out. */
  let hydrated = false;
  /** The surface that is fading out, in a shell beside the pip. */
  let ghost: HTMLElement | null = null;
  /** The action in flight per runtime id; its row's buttons wait for it. */
  const pending = new Map<string, ColabAction>();
  /** When each runtime entered its state here, for a clock the backend gave no start for. */
  const since = new Map<string, { state: ColabRuntimeState; at: number }>();
  /** Runtimes whose long error is shown in full. */
  const fullErrors = new Set<string>();
  /** Whether each runtime's error overflows its clamp, as measured for that text at the card's width. */
  const errorFit = new Map<string, { error: string; long: boolean }>();
  /** A number per runtime for its error's element id: a runtime's own id may hold anything. */
  const errorIds = new Map<string, number>();
  let errorSeq = 0;
  const errorId = (id: string): string => { if (!errorIds.has(id)) errorIds.set(id, ++errorSeq); return `${ERROR_ID}-${errorIds.get(id)}`; };
  const pane = () => root.parentElement;
  const q = <T extends Element = HTMLElement>(selector: string) => root.querySelector<T>(selector);
  const surface = () => q('.cp-pill,.cp-card');
  const find = (id: string | undefined) => runtimes.find(r => r.id === id);

  /* ---------- text ---------- */
  function clock(r: ColabThreadRuntime, now: number): string {
    if (r.state === 'ready') return r.startedAt ? uptime(now - r.startedAt) : '';
    if (!TICKING.has(r.state)) return '';
    const from = r.state === 'creating' ? r.startedAt || since.get(r.id)?.at : r.busySince ?? since.get(r.id)?.at;
    return from ? stopwatch(now - from) : '';
  }
  /** One word for stopping wherever it shows, whatever the backend calls the step. */
  const status = (r: ColabThreadRuntime): string => r.state === 'error' || r.state === 'stopped' || r.state === 'stopping' ? STATE_TEXT[r.state] : r.activity ?? STATE_TEXT[r.state];
  const primary = (): string => runtimes.length === 1 ? `Colab · ${hardwareLabel(runtimes[0])}` : `Colab · ${runtimes.length} runtimes`;
  /** The pill's second line: what the lead runtime is doing; an error says what went wrong, and that it is one in
   * words, not only in the danger tone. */
  const pillStatus = (r: ColabThreadRuntime, max = Infinity): string => r.state === 'error' ? `Error: ${(firstLine(r.error) || 'Runtime error').slice(0, max)}` : status(r);
  /** The pill's name holds its visible text, an error cut to a sentence's length. A seconds clock is left out: it
   * would rewrite the name every tick. */
  function pillLabel(r: ColabThreadRuntime, now: number): string {
    const up = r.state === 'ready' ? clock(r, now) : '', doing = `${pillStatus(r, SPOKEN_ERROR_CHARS)}${up ? ` · ${up}` : ''}`;
    return `Google Colab runtime: ${primary()}, ${doing.replace(/[.\s]+$/, '')}. Show details`;
  }

  /* ---------- drawing: each surface is built once as a shell, then painted in place, so a runtime that only
   * changes state keeps its nodes (and a pressed or focused control stays the same element) ---------- */
  function paintStatus(scope: Element, r: ColabThreadRuntime, label: string, now: number): void {
    const activity = scope.querySelector('.cp-activity'), time = scope.querySelector('.cp-clock'), at = clock(r, now);
    setText(activity, label); setAttr(activity, 'title', label);
    setAttr(time, 'data-clock', r.id); setText(time, at);
    setHidden(time, !at); setHidden(time?.previousElementSibling ?? null, !at);
  }
  const pillEl = (): HTMLElement => fromHtml(`<button type="button" class="cp-pill" data-cp="expand" aria-expanded="false">
      <span class="cp-glyph" data-state-tone="remote" aria-hidden="true">${GLYPH}<i class="cp-dot"></i></span>
      <span class="cp-text"><strong class="cp-primary"></strong><small class="cp-status">${STATUS_HTML}</small></span>
      <span class="cp-chevron" aria-hidden="true">${icon('down')}</span>
    </button>`);
  function paintPill(el: HTMLElement, now: number): void {
    const lead = leadRuntime(runtimes)!;
    setAttr(el, 'data-runtime', lead.state); setAttr(el, 'aria-label', pillLabel(lead, now));
    setText(el.querySelector('.cp-primary'), primary());
    paintStatus(el, lead, pillStatus(lead), now);
  }
  function controls(r: ColabThreadRuntime): Control[] {
    const busy = pending.get(r.id), any = Boolean(busy);
    return [
      ...(canOpen(r) ? [{ action: 'open', label: 'Open in Colab', glyph: icon('external'), off: r.state === 'creating' || r.state === 'stopping' || any }] : []),
      ...(showsRestart(r) ? [{ action: 'restart', label: 'Restart kernel', glyph: icon('reset'), off: any || r.state === 'stopping', waiting: busy === 'restart_kernel' || r.state === 'restarting' }] : []),
      ...(showsStop(r) ? [{ action: 'stop', label: 'Stop', glyph: icon('stop'), off: any, waiting: busy === 'stop' || r.state === 'stopping' }] : []),
      ...(canDismiss(r) ? [{ action: 'dismiss', label: 'Dismiss', glyph: icon('close'), off: any, waiting: busy === 'dismiss' }] : []),
    ];
  }
  /** Stopping and restarting ask once more in the row, and say what is lost; Cancel, which takes focus, reads the
   * question out. */
  function confirmEl(r: ColabThreadRuntime, action: Confirmable): HTMLElement {
    const question = QUESTION[action];
    const el = fromHtml(`<div class="cp-confirm" role="group" data-confirm="${action}"><span class="cp-confirm-text" id="${CONFIRM_TEXT_ID}">${question.text}</span></div>`);
    const cancel = controlEl({ action: `${action}-no`, label: 'Cancel' });
    el.setAttribute('aria-label', question.group(r.name));
    cancel.setAttribute('aria-describedby', CONFIRM_TEXT_ID);
    el.append(cancel, controlEl({ action: `${action}-yes`, label: question.yes, danger: true }));
    return el;
  }
  /** The row's buttons, or a question in their place; only that swap replaces the group. */
  function paintActions(row: HTMLElement, r: ColabThreadRuntime): void {
    const asking = confirming?.id === r.id ? confirming.action : null, list = asking ? [] : controls(r);
    let group = row.querySelector<HTMLElement>(':scope > .cp-actions,:scope > .cp-confirm');
    if (group && ((group.dataset.confirm ?? null) !== asking || (!asking && !list.length))) { group.remove(); group = null; }
    if (asking) { if (!group) row.append(confirmEl(r, asking)); return; }
    if (!list.length) return;
    if (!group) { group = fromHtml('<div class="cp-actions" role="group"></div>'); row.append(group); }
    setAttr(group, 'aria-label', `${r.name} actions`);
    reconcile(group, list, c => c.action, el => el.dataset.cp ?? '', controlEl, paintControl);
  }
  /** The error is selectable text, clamped to four lines; one that does not fit them (fitErrors measures it) gets
   * a toggle that shows it whole. Until a new text is measured the toggle stays as it was. */
  function paintError(row: HTMLElement, r: ColabThreadRuntime): void {
    let block = row.querySelector<HTMLElement>(':scope > .cp-error-block');
    if (!r.error) { block?.remove(); return; }
    if (!block) { block = fromHtml('<div class="cp-error-block"><p class="cp-error"></p></div>'); row.querySelector('.cp-status')?.after(block); }
    const body = block.firstElementChild as HTMLElement, fit = errorFit.get(r.id);
    let more = block.querySelector<HTMLElement>('[data-cp="error-more"]');
    const long = fit?.error === r.error ? fit.long : Boolean(more), full = long && fullErrors.has(r.id);
    setAttr(body, 'id', errorId(r.id)); setText(body, r.error); setAttr(body, 'title', null);
    body.classList.toggle('is-full', full);
    if (!long) { more?.remove(); return; }
    if (!more) { more = fromHtml('<button type="button" class="cp-more" data-cp="error-more"></button>'); block.append(more); }
    setText(more, full ? 'Show less' : 'Show full error'); setAttr(more, 'aria-expanded', String(full)); setAttr(more, 'aria-controls', body.id);
  }
  /** Finds the errors that overflow their clamp, by measuring them clamped: whether one fits depends on the card's
   * width, not on its length. `all`: that width may have changed; otherwise only a text not measured yet is. */
  function fitErrors(all = false): void {
    const found = [...root.querySelectorAll<HTMLElement>('.cp-runtime')].flatMap(row => {
      const r = find(row.dataset.id), body = row.querySelector<HTMLElement>('.cp-error');
      return r?.error && body && (all || errorFit.get(r.id)?.error !== r.error) ? [{ row, r, body, error: r.error }] : [];
    });
    if (!found.length) return;
    const held = focusKey();
    // Every write, then every read, then the repaint: one layout for the lot.
    for (const { body } of found) body.classList.remove('is-full');
    const longs = found.map(({ body }) => body.scrollHeight > body.clientHeight + 1);
    found.forEach(({ row, r, error }, i) => { errorFit.set(r.id, { error, long: longs[i] }); paintError(row, r); });
    if (held && !root.contains(document.activeElement)) refocus(held);
  }
  const rowEl = (r: ColabThreadRuntime): HTMLElement => fromHtml(`<li class="cp-runtime ds-card-inner" data-id="${escape(r.id)}">
      <div class="cp-runtime-head"><strong class="cp-name"></strong><span class="cp-chips"></span></div>
      <p class="cp-status"><i class="cp-dot" aria-hidden="true"></i>${STATUS_HTML}</p>
    </li>`);
  function paintRow(row: HTMLElement, r: ColabThreadRuntime, now: number): void {
    const name = row.querySelector('.cp-name'), chips = row.querySelector<HTMLElement>('.cp-chips'), labels = [r.hardware, ...(r.highMem ? ['High-RAM'] : [])];
    setAttr(row, 'data-runtime', r.state);
    setText(name, r.name); setAttr(name, 'title', r.name);
    if (chips) reconcile(chips, labels, label => label, el => el.textContent ?? '', label => { const el = fromHtml('<span class="cp-chip"></span>'); el.textContent = label; return el; }, () => undefined);
    const line = row.querySelector('.cp-status'); if (line) paintStatus(line, r, status(r), now);
    paintError(row, r);
    paintActions(row, r);
  }
  const cardEl = (): HTMLElement => fromHtml(`<section class="cp-card" id="${CARD_ID}">
      <header class="cp-head"><span class="cp-glyph" data-state-tone="remote" aria-hidden="true">${GLYPH}</span><h3 class="cp-title">Google Colab</h3><span class="cp-head-gap"></span>
        <button type="button" class="cp-icon" data-cp="refresh" aria-label="Refresh runtimes" title="Refresh">${icon('refresh')}</button>
        <button type="button" class="cp-icon" data-cp="collapse" aria-label="Collapse Google Colab runtimes" title="Collapse (Esc)">${icon('minimize')}</button></header>
      <ul class="cp-list"></ul>
    </section>`);
  function paintCard(el: HTMLElement, now: number): void {
    const refresh = el.querySelector('[data-cp="refresh"]'), list = el.querySelector<HTMLElement>('.cp-list'), total = runtimes.length;
    setAttr(refresh, 'aria-disabled', refreshing ? 'true' : null); setAttr(refresh, 'aria-busy', refreshing ? 'true' : null);
    let count = el.querySelector('.cp-count');
    if (total < 2) count?.remove();
    else {
      if (!count) { count = fromHtml('<span class="cp-count"><span></span><span class="sr-only"> runtimes</span></span>'); el.querySelector('.cp-title')?.after(count); }
      setText(count.firstElementChild, String(total));
    }
    if (list) reconcile(list, runtimes, r => r.id, row => row.dataset.id ?? '', rowEl, (row, r) => paintRow(row, r, now));
  }

  /* ---------- placement: under the header, left of the floating dock, away from a top-right progress PiP ---------- */
  /** Layout offsets, not the dock's rect: its springs must not move the pip. */
  function dockClearance(host: HTMLElement): number {
    const dock = document.querySelector<HTMLElement>('#action-dock'), parent = dock?.offsetParent as HTMLElement | null;
    if (!dock || !parent || !dock.offsetWidth || getComputedStyle(dock).position !== 'absolute') return EDGE;
    const left = parent.getBoundingClientRect().left + parent.clientLeft + dock.offsetLeft, box = host.getBoundingClientRect();
    if (left >= box.right || left + dock.offsetWidth <= box.left) return EDGE;
    return Math.max(EDGE, Math.round(box.right - left + DOCK_GAP));
  }
  function unmark(): void { const host = pane(); host?.removeAttribute('data-colab-pip-top'); host?.style.removeProperty('--colab-pip-clear'); }
  /* The progress PiP keeps whichever corner it is parked in, and the pip never covers it. A PiP in a top corner
   * shares the pip's row: the pip sits beside it (left of one parked top right, right of one parked top left), no
   * wider than the room there, and in a pane too narrow for both it goes under the PiP. A PiP in a bottom corner
   * under the pip takes its height from the pip's room. Layout offsets again: a drag's translate is not a move. */
  function place(): void {
    frame = 0;
    const host = pane(); if (!host || root.hidden) return;
    const heading = host.querySelector<HTMLElement>('#task-details-heading'), composer = host.querySelector<HTMLElement>('#composer-area');
    const found = host.querySelector<HTMLElement>('#progress-pip'), progress = found && !found.hidden ? found : null, corner = progress?.dataset.corner ?? '';
    const headerBottom = heading && !heading.hidden ? heading.offsetTop + heading.offsetHeight : 0, under = headerBottom + GAP;
    const dock = dockClearance(host), side = corner === 'tr' ? 'left' : 'right', widest = host.clientWidth - EDGE - dock;
    let top = under, width = widest, bottom = (composer ? host.clientHeight - composer.offsetTop : 0) + GAP, stacked = false;
    if (progress && corner.startsWith('t')) {
      const room = side === 'left' ? progress.offsetLeft - EDGE - DOCK_GAP : host.clientWidth - dock - (progress.offsetLeft + progress.offsetWidth + DOCK_GAP);
      if (side === 'left' ? progress.offsetLeft >= BESIDE_MIN : room >= BESIDE_MIN) width = Math.min(widest, room);
      else { stacked = true; top = Math.max(under, progress.offsetTop + progress.offsetHeight + GAP); }
    } else if (progress && corner.startsWith('b')) {
      const right = host.clientWidth - dock, left = right - Math.min(CARD_WIDTH, widest);
      if (progress.offsetLeft < right && progress.offsetLeft + progress.offsetWidth > left) bottom = Math.max(bottom, host.clientHeight - progress.offsetTop + GAP);
    }
    root.style.setProperty('--cp-top', `${top}px`);
    root.style.setProperty('--cp-room', `${Math.max(120, host.clientHeight - top - bottom)}px`);
    root.style.setProperty('--cp-edge', `${side === 'left' ? EDGE : dock}px`);
    if (progress && corner.startsWith('t')) root.style.setProperty('--cp-max-w', `${Math.max(MIN_WIDTH, Math.floor(width))}px`); else root.style.removeProperty('--cp-max-w');
    if (root.dataset.side !== side) root.dataset.side = side;
    /* The transcript's first message starts under the pill, wherever the pill is: lower when it is under the
     * PiP's own pill. The PiP's card floats over the thread, and so does a pill under it. The card never counts:
     * expanding must not move the thread. */
    const lower = stacked && Boolean(progress?.querySelector('.pp-pill:not(.is-overlay)'));
    const clear = lower ? Math.max(PILL_CLEAR, Math.round(top - headerBottom + PILL_SPACE)) : PILL_CLEAR;
    if (clear > PILL_CLEAR) host.style.setProperty('--colab-pip-clear', `${clear}px`); else host.style.removeProperty('--colab-pip-clear');
    if (expanded) fitErrors(true);
  }
  const schedulePlace = () => { if (!frame && !root.hidden) frame = requestAnimationFrame(place); };
  const resize = new ResizeObserver(schedulePlace), mutations = new MutationObserver(schedulePlace);
  function watch(): void {
    const host = pane(), dock = document.querySelector<HTMLElement>('#action-dock'), progress = host?.querySelector('#progress-pip');
    // The progress PiP's own box too: it changes size between its pill and its card.
    for (const el of [host, dock, progress, host?.querySelector('#task-details-heading'), host?.querySelector('#composer-area')]) if (el) resize.observe(el);
    // The dock's `right` (a narrow window's inspector), the view it sits in, and the progress PiP's corner.
    if (dock) mutations.observe(dock, { attributes: true, attributeFilter: ['style'] });
    const workspace = root.closest('.workspace');
    if (workspace) mutations.observe(workspace, { attributes: true, attributeFilter: ['class'] });
    // Its pill or card too: which one it shows decides how far down the thread starts.
    if (progress) mutations.observe(progress, { attributes: true, attributeFilter: ['hidden', 'data-corner'], childList: true });
  }

  /* ---------- clock: text only, on whole seconds, and only while something visible counts ---------- */
  const shown = (): ColabThreadRuntime[] => expanded ? runtimes : [leadRuntime(runtimes)].filter((r): r is ColabThreadRuntime => Boolean(r));
  function paintClocks(): void {
    const now = Date.now();
    for (const el of root.querySelectorAll<HTMLElement>('[data-clock]')) {
      const r = find(el.dataset.clock), next = r ? clock(r, now) : '';
      setText(el, next); setHidden(el, !next); setHidden(el.previousElementSibling, !next);
    }
    // A focused pill keeps its name through a tick: rewriting it would have a screen reader say it again each minute.
    const pill = q('.cp-pill'), lead = leadRuntime(runtimes);
    if (pill && lead && document.activeElement !== pill) setAttr(pill, 'aria-label', pillLabel(lead, now));
  }
  function stopClock(): void { clearTimeout(timer); timer = 0; }
  function startClock(): void {
    stopClock();
    if (disposed || root.hidden || document.hidden) return;
    const now = Date.now(), list = shown();
    // A seconds clock ticks as its own second turns; a ready runtime's uptime, as its minute does. With several
    // counting, the next tick is the soonest of theirs, so none skips a second.
    const phase = (r: ColabThreadRuntime, unit: number) => unit - (now - (r.state === 'ready' || r.state === 'creating' ? r.startedAt : r.busySince ?? since.get(r.id)?.at ?? now)) % unit;
    const seconds = list.filter(r => TICKING.has(r.state) && clock(r, now)).map(r => phase(r, 1000));
    const waits = seconds.length ? seconds : list.filter(r => r.state === 'ready' && r.startedAt).map(r => phase(r, 60000));
    if (waits.length) timer = window.setTimeout(() => { timer = 0; paintClocks(); startClock(); }, Math.max(50, Math.min(...waits) + 8));
  }
  // A hidden window counts nothing; coming back, the clocks catch up at once.
  const onVisibility = () => { if (document.hidden) stopClock(); else if (!root.hidden) { paintClocks(); startClock(); } };
  document.addEventListener('visibilitychange', onVisibility);

  /* ---------- rendering ---------- */
  const outside = (event: Event) => { if (expanded && !root.contains(event.target as Node)) collapse(false); };
  const listen = (on: boolean) => { document.removeEventListener('pointerdown', outside, true); if (on) document.addEventListener('pointerdown', outside, true); };
  /** What had focus, so a redraw can hand it back to the same control. */
  function focusKey(): FocusKey | null {
    const active = document.activeElement;
    if (!(active instanceof HTMLElement) || !root.contains(active)) return null;
    return { action: active.dataset.cp ?? '', id: active.closest<HTMLElement>('[data-id]')?.dataset.id ?? '' };
  }
  /** Focus goes to `prefer` or back to the control that held it, in the same runtime's row. When that control is
   * gone the row's first one takes it, and when the row is gone the card's own: never another runtime's. */
  function refocus(key: FocusKey, prefer?: string): void {
    const scope: HTMLElement | undefined = key.id ? [...root.querySelectorAll<HTMLElement>('.cp-runtime')].find(el => el.dataset.id === key.id) : root;
    const pick = (selector: string): HTMLElement | null => scope?.querySelector<HTMLElement>(selector) ?? null;
    const control = (action: string | undefined) => action ? pick(`[data-cp="${action}"]`) : null;
    const target = control(prefer) ?? control(key.action) ?? (key.id ? pick('[data-cp]') : null) ?? q('[data-cp="collapse"],[data-cp="expand"]');
    target?.focus({ preventScroll: true });
  }
  /** Draws the pill or card, or repaints the one that is there. `prefer` names the control to focus after; `null`
   * leaves focus wherever it goes by itself. Focus only ever moves when it was in the pip to begin with. */
  function render(prefer?: string | null, fade = true): void {
    const show = allowed && runtimes.length > 0, wasHidden = root.hidden, held = focusKey();
    if (!show) {
      const was = surface();
      expanded = false; confirming = null; listen(false); stopClock();
      root.hidden = true; unmark();
      if (was && !wasHidden && fade) leave(was); else { if (!fade) dropGhost(); was?.remove(); }
      // Its last runtime went while it had focus: the composer takes it, as when a PiP is cleared.
      if (held && !wasHidden) document.querySelector<HTMLElement>('#prompt')?.focus({ preventScroll: true });
      return;
    }
    pane()?.setAttribute('data-colab-pip-top', '');
    const was = surface(), now = Date.now(), swap = !was || was.classList.contains('cp-card') !== expanded;
    const next = swap ? (expanded ? cardEl() : pillEl()) : was;
    if (expanded) paintCard(next, now); else paintPill(next, now);
    if (swap) {
      // The card leaves with a fade as the pill arrives; anything still fading from before goes at once.
      if (was && !expanded) leave(was); else { dropGhost(); was?.remove(); }
      root.prepend(next);
      root.hidden = false;
      if (wasHidden) { place(); arrive(root); }
      else if (was) { if (expanded) materializeIn(next, { scale: 0.96, y: -4, spring: { response: 0.2 }, origin: root.dataset.side === 'left' ? 'top left' : 'top right' }); else arrive(next); }
    }
    // A card that just opened may be a different width from the last one measured.
    if (expanded) fitErrors(swap);
    if (held && prefer !== null && (prefer || !root.contains(document.activeElement))) refocus(held, prefer);
    startClock();
  }
  function dropGhost(): void { ghost?.remove(); ghost = null; }
  /** A surface that goes fades out in a shell beside the pip, a copy of its box: the pip is already in its next
   * state, and nothing in the shell can be pointed at, focused or read. A surface that arrives meanwhile ends it. */
  function leave(el: HTMLElement): void {
    dropGhost();
    if (typeof el.animate !== 'function' || !root.parentElement) { el.remove(); return; }
    const shell = root.cloneNode(false) as HTMLElement;
    for (const name of ['id', 'aria-label', 'hidden']) shell.removeAttribute(name);
    shell.classList.add('cp-ghost'); shell.setAttribute('aria-hidden', 'true'); shell.setAttribute('inert', '');
    for (const node of [el, ...el.querySelectorAll('[id]')]) node.removeAttribute('id');
    shell.append(el); root.after(shell);
    ghost = shell;
    const gone = () => { shell.remove(); if (ghost === shell) ghost = null; };
    shell.animate([{ opacity: 1 }, { opacity: 0 }], { duration: EXIT_MS, easing: 'ease-in', fill: 'forwards' }).finished.then(gone, gone);
  }
  /** A soft arrival: opacity only (120 ms under reduced motion too, a cross-fade). */
  function arrive(el: HTMLElement): void {
    if (typeof el.animate === 'function') el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: reducedMotion() ? 120 : 160, easing: 'ease-out' });
  }
  function expand(): void { if (expanded) return; expanded = true; listen(true); render('collapse'); }
  /** `focus`: its own control or Escape asked, so the pill takes focus back. A click elsewhere keeps its target. */
  function collapse(focus: boolean): void {
    if (!expanded) return;
    expanded = false; confirming = null; listen(false);
    render(focus ? 'expand' : null);
  }

  /* ---------- data ---------- */
  /** `silent`: the list is what the thread already had, not news. */
  function apply(value: unknown, silent = false): void {
    const next = runtimesFrom(value), now = Date.now(), ids = new Set(next.map(r => r.id));
    const said = allowed && !silent ? runtimeAnnouncement(runtimes, next) : '';
    hydrated = true;
    if (said) host.announce(said);
    for (const id of [...since.keys()]) if (!ids.has(id)) since.delete(id);
    for (const r of next) if (since.get(r.id)?.state !== r.state) since.set(r.id, { state: r.state, at: now });
    for (const id of [...pending.keys()]) if (!ids.has(id)) pending.delete(id);
    for (const id of [...fullErrors]) if (!next.some(r => r.id === id && r.error)) fullErrors.delete(id);
    for (const id of [...errorFit.keys()]) if (!next.some(r => r.id === id && r.error)) errorFit.delete(id);
    for (const id of [...errorIds.keys()]) if (!ids.has(id)) errorIds.delete(id);
    runtimes = next;
    const asked = find(confirming?.id);
    if (!asked || !(confirming?.action === 'stop' ? canStop(asked) : canRestart(asked))) confirming = null;
    render();
  }
  async function reload(refresh = false): Promise<void> {
    const ticket = ++loadTicket, id = sessionId;
    if (refresh) { refreshing = true; render(); }
    try {
      const list = await host.call<unknown>('cloud_colab_thread_runtimes', { sessionId: id, ...(refresh ? { refresh: true } : {}) });
      if (id !== sessionId) return;
      if (refresh) refreshing = false;
      // A `colab-runtime` event that landed meanwhile is newer than this answer. A thread's first list is silent;
      // a refresh the user asked for, like an event, reads out what changed.
      if (ticket === loadTicket) apply(list, !hydrated && !refresh); else render();
    } catch (error) {
      if (id !== sessionId) return;
      if (refresh) { refreshing = false; host.notifyError(`Could not refresh the Colab runtimes. ${errorText(error)}`); render(); }
      else console.warn('cloud_colab_thread_runtimes failed', error);
    }
  }
  /** `prefer`: the control that takes focus as the action starts (Stop, when its question is answered). The answer
   * is painted without one: focus has stayed there, or the user has moved it on. */
  async function act(r: ColabThreadRuntime, action: ColabAction, prefer?: string): Promise<void> {
    if (pending.has(r.id)) return;
    const id = sessionId, ticket = ++loadTicket;
    pending.set(r.id, action); confirming = null;
    render(prefer);
    try {
      const list = await host.call<unknown>('cloud_colab_runtime_action', { sessionId: id, endpoint: action === 'dismiss' ? (r.endpoint || r.id) : r.endpoint, action });
      if (id !== sessionId) return;
      pending.delete(r.id);
      // As in reload: an event that landed during the call already holds what this answer does, or something newer.
      if (ticket === loadTicket) apply(list); else render();
    } catch (error) {
      if (id !== sessionId) return;
      pending.delete(r.id);
      host.notifyError(`${FAILED[action]} ${errorText(error)}`);
      render();
    }
  }
  /** Asks `action`'s question in `r`'s row; Cancel takes focus. */
  function ask(r: ColabThreadRuntime, action: Confirmable): void { confirming = { id: r.id, action }; render(`${action}-no`); }
  /** Backs out of the question; focus returns to the control that asked it when it was in the question. */
  function cancelConfirm(): void {
    const asked = Boolean(document.activeElement?.closest('.cp-confirm')), action = confirming?.action;
    confirming = null;
    render(asked ? action : undefined);
  }

  /* ---------- events ---------- */
  const onClick = (event: MouseEvent): void => {
    const button = (event.target as Element).closest<HTMLElement>('[data-cp]'), r = find(button?.closest<HTMLElement>('[data-id]')?.dataset.id);
    if (!button || button.getAttribute('aria-disabled') === 'true') return;
    // WebKit does not focus a clicked button; the redraw's focus follows the control that was pressed.
    if (document.activeElement !== button) button.focus({ preventScroll: true });
    switch (button.dataset.cp) {
      case 'expand': expand(); break;
      case 'collapse': collapse(true); break;
      case 'refresh': if (!refreshing) void reload(true); break;
      case 'open': if (r) void act(r, 'open_browser'); break;
      case 'restart': if (r && canRestart(r)) ask(r, 'restart'); break;
      case 'restart-no': cancelConfirm(); break;
      case 'restart-yes': if (r) void act(r, 'restart_kernel', 'restart'); break;
      case 'stop': if (r && canStop(r)) ask(r, 'stop'); break;
      case 'stop-no': cancelConfirm(); break;
      case 'stop-yes': if (r) void act(r, 'stop', 'stop'); break;
      case 'dismiss': if (r) void act(r, 'dismiss'); break;
      case 'error-more': if (r) { if (!fullErrors.delete(r.id)) fullErrors.add(r.id); render(); } break;
    }
  };
  // Esc is the pip's only when it closes something here; otherwise it stays the app's (which stops a running agent).
  const onKey = (event: KeyboardEvent): void => {
    if (event.key !== 'Escape' || isImeKey(event) || !expanded) return;
    event.preventDefault();
    if (confirming) cancelConfirm(); else collapse(true);
  };
  // The pip floats outside the transcript, so the browser would not chain a wheel to it; a long list scrolls itself.
  const onWheel = (event: WheelEvent): void => {
    const transcript = document.querySelector<HTMLElement>('#transcript'), list = (event.target as Element).closest<HTMLElement>('.cp-list');
    if (!transcript || event.ctrlKey || transcript.closest('[inert]') || (list && list.scrollHeight > list.clientHeight)) return;
    transcript.dispatchEvent(new WheelEvent('wheel', event));
    transcript.scrollTop += event.deltaY * [1, WHEEL_LINE, transcript.clientHeight][event.deltaMode];
  };
  root.addEventListener('click', onClick);
  root.addEventListener('keydown', onKey);
  root.addEventListener('wheel', onWheel, { passive: true });
  watch();

  return {
    update(id, show) {
      const changed = id !== sessionId;
      if (!changed && show === allowed) return;
      allowed = show;
      if (!changed) { render(); return; }
      sessionId = id; runtimes = []; pending.clear(); since.clear(); fullErrors.clear(); errorFit.clear(); errorIds.clear(); refreshing = false; hydrated = false;
      // Another thread's pip is not leaving: it goes at once, so switching between two Colab threads does not flicker.
      render(undefined, false);
      if (id) void reload();
    },
    // Before the thread's first list, an event is that list (or newer): what was there already is not news.
    set(id, list, handoff = false) { if (id && id === sessionId) { loadTicket++; apply(list, !hydrated && !handoff); } },
    dispose() {
      disposed = true; stopClock(); listen(false); cancelAnimationFrame(frame);
      resize.disconnect(); mutations.disconnect();
      document.removeEventListener('visibilitychange', onVisibility);
      root.removeEventListener('click', onClick); root.removeEventListener('keydown', onKey); root.removeEventListener('wheel', onWheel);
      root.hidden = true; unmark(); dropGhost(); root.replaceChildren();
    },
  };
}
