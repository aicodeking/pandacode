import './agents-dock.css';
import { call, subscribe } from './bridge';
import { icon } from './dom';
import { materializeIn } from './motion';

export type AgentsDockStatus = 'running' | 'waiting-for-approval' | 'waiting-for-input';
export interface AgentsDockAgent {
  id: string;
  title: string;
  projectName: string;
  provider: string;
  model: string;
  status: AgentsDockStatus;
  elapsedSeconds: number;
}
export interface AgentsDockSnapshot { agents: AgentsDockAgent[] }
export interface AgentsDockPreferences { enabled: boolean; keepOnScreen: boolean; pinned: boolean }
export interface AgentsDockDeps { openTask(id: string): void }

const DEFAULT_PREFERENCES: AgentsDockPreferences = { enabled: true, keepOnScreen: true, pinned: false };
export const subscribeDockEvent = subscribe as unknown as <T>(name: string, callback: (event: T) => void) => Promise<() => void>;
const statusLabel: Record<AgentsDockStatus, string> = {
  running: 'Running',
  'waiting-for-approval': 'Waiting for approval',
  'waiting-for-input': 'Waiting for input',
};

function elapsed(seconds: number): string {
  const minutes = Math.floor(Math.max(0, seconds) / 60);
  return minutes ? `${minutes}m ${String(Math.max(0, seconds) % 60).padStart(2, '0')}s` : `${Math.max(0, seconds)}s`;
}
function paintElapsed(age: HTMLTimeElement, now: number): void {
  const seconds = Math.max(0, Math.floor((now - Number(age.dataset.started)) / 1000));
  const text = elapsed(seconds);
  if (age.textContent !== text) { age.textContent = text; age.dateTime = `PT${seconds}S`; }
}

/** Updates a list of agent rows in place (keyed by task), so focus and hover survive.
 *  `receivedAt` is when the snapshot arrived; rows count on from there. */
export function renderAgentRows(list: HTMLElement, agents: AgentsDockAgent[], receivedAt: number, emptyClass: string): void {
  if (!agents.length) {
    list.querySelectorAll('[data-agent-id]').forEach(row => row.remove());
    if (!list.querySelector(`.${emptyClass}`)) {
      const empty = document.createElement('p');
      empty.className = emptyClass;
      empty.textContent = 'No agents running';
      list.append(empty);
    }
    return;
  }
  list.querySelector(`.${emptyClass}`)?.remove();
  const rows = new Map(Array.from(list.querySelectorAll<HTMLButtonElement>('[data-agent-id]')).map(row => [row.dataset.agentId!, row]));
  const now = Date.now();
  for (const [index, agent] of agents.entries()) {
    let row = rows.get(agent.id);
    if (!row) {
      row = document.createElement('button');
      row.type = 'button';
      row.className = 'agents-dock-row';
      row.innerHTML = '<span class="agents-dock-status-dot" aria-hidden="true"></span><span class="agents-dock-copy"><strong class="agents-dock-title"></strong><span class="agents-dock-detail"></span><span class="agents-dock-meta"><span></span><time class="agents-dock-elapsed"></time></span></span>';
      row.dataset.agentId = agent.id;
    }
    row.setAttribute('aria-label', `${agent.title}, ${agent.projectName}, ${statusLabel[agent.status]}`);
    row.querySelector('.agents-dock-status-dot')!.className = `agents-dock-status-dot ${agent.status === 'running' ? 'running' : 'waiting'}`;
    row.querySelector('.agents-dock-title')!.textContent = agent.title;
    row.querySelector('.agents-dock-detail')!.textContent = `${agent.projectName} · ${agent.provider} / ${agent.model}`;
    row.querySelector('.agents-dock-meta>span')!.textContent = statusLabel[agent.status];
    const age = row.querySelector<HTMLTimeElement>('.agents-dock-elapsed')!;
    age.dataset.started = String(receivedAt - Math.max(0, agent.elapsedSeconds) * 1000);
    paintElapsed(age, now);
    if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    rows.delete(agent.id);
  }
  rows.forEach(row => row.remove());
}

/** The one clock per window: rewrites only the elapsed labels under `root`, once a second. */
export function startElapsedTick(root: HTMLElement): () => void {
  const timer = window.setInterval(() => {
    const now = Date.now();
    root.querySelectorAll<HTMLTimeElement>('.agents-dock-elapsed[data-started]').forEach(age => paintElapsed(age, now));
  }, 1_000);
  return () => window.clearInterval(timer);
}

/** Eagerly mount the live running-agents button in the workspace header. */
export function mountAgentsDock(host: HTMLElement, deps: AgentsDockDeps): () => void {
  host.classList.add('agents-dock-host');
  host.innerHTML = `<button type="button" class="icon-button agents-dock-trigger" aria-label="Running agents" aria-haspopup="dialog" aria-expanded="false" aria-controls="agents-dock-popover" title="Running agents">${icon('bot')}<span class="agents-dock-count" aria-hidden="true" hidden></span></button>
    <section class="agents-dock-popover" id="agents-dock-popover" role="dialog" aria-label="Running agents" hidden>
      <header class="agents-dock-head"><div><strong>Running agents</strong><span class="agents-dock-summary"></span></div><button type="button" class="agents-dock-pin icon-button" data-action="pin" aria-label="Pin widget" title="Pin widget">${icon('pin')}</button></header>
      <div class="agents-dock-list"></div>
    </section>`;
  const trigger = host.querySelector<HTMLButtonElement>('.agents-dock-trigger')!;
  const count = host.querySelector<HTMLElement>('.agents-dock-count')!;
  const popover = host.querySelector<HTMLElement>('.agents-dock-popover')!;
  const list = host.querySelector<HTMLElement>('.agents-dock-list')!;
  const summary = host.querySelector<HTMLElement>('.agents-dock-summary')!;
  const pin = host.querySelector<HTMLButtonElement>('.agents-dock-pin')!;
  let preferences = { ...DEFAULT_PREFERENCES };
  let snapshot: AgentsDockSnapshot = { agents: [] };
  let receivedAt = Date.now();
  let open = false;
  let disposed = false;
  // Escape hands focus back to the trigger; that focus must not reopen the popover.
  let returningFocus = false;
  let intentTimer = 0;
  let closeTimer = 0;

  const draw = () => {
    const agents = snapshot.agents;
    const running = agents.filter(agent => agent.status === 'running').length;
    const wasHidden = popover.hidden;
    trigger.hidden = !preferences.enabled;
    trigger.setAttribute('aria-expanded', String(open));
    // The count lives in the name (read on focus), never in a live region: it changes quietly.
    const label = agents.length ? `Running agents, ${agents.length} active` : 'Running agents';
    if (trigger.getAttribute('aria-label') !== label) trigger.setAttribute('aria-label', label);
    trigger.classList.toggle('is-working', running > 0);
    trigger.classList.toggle('has-agents', agents.length > 0);
    count.hidden = agents.length === 0;
    count.textContent = String(agents.length);
    popover.hidden = !open || !preferences.enabled;
    summary.textContent = agents.length ? `${agents.length} active` : '';
    pin.setAttribute('aria-pressed', String(preferences.pinned));
    pin.title = preferences.pinned ? 'Widget pinned' : 'Pin widget';
    pin.setAttribute('aria-label', preferences.pinned ? 'Widget pinned' : 'Pin widget');
    pin.classList.toggle('is-pinned', preferences.pinned);
    renderAgentRows(list, agents, receivedAt, 'agents-dock-empty');
    if (wasHidden && !popover.hidden) materializeIn(popover, { scale: 0.985, y: -4, spring: { response: 0.2 }, origin: '100% 0%' });
  };
  const accept = (next: AgentsDockSnapshot) => { snapshot = next; receivedAt = Date.now(); };
  const setOpen = (next: boolean) => { open = next; draw(); };
  const scheduleOpen = () => {
    window.clearTimeout(closeTimer);
    window.clearTimeout(intentTimer);
    intentTimer = window.setTimeout(() => setOpen(true), 150);
  };
  const scheduleClose = () => {
    window.clearTimeout(intentTimer);
    window.clearTimeout(closeTimer);
    closeTimer = window.setTimeout(() => {
      if (!host.matches(':hover') && !host.contains(document.activeElement)) setOpen(false);
    }, 140);
  };
  const click = async (event: MouseEvent) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (target.closest('.agents-dock-trigger')) { window.clearTimeout(intentTimer); setOpen(!open); return; }
    if (target.closest('[data-action="pin"]')) {
      try { await call('agents_dock_pin'); preferences = { ...preferences, pinned: true }; draw(); }
      catch { /* The header remains usable if a native window cannot be created. */ }
      return;
    }
    const row = target.closest<HTMLButtonElement>('[data-agent-id]');
    if (row?.dataset.agentId) { deps.openTask(row.dataset.agentId); setOpen(false); }
  };
  const keydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) return;
    event.preventDefault();
    window.clearTimeout(intentTimer);
    setOpen(false);
    returningFocus = true;
    trigger.focus();
    returningFocus = false;
  };
  const outside = (event: PointerEvent) => {
    if (open && event.target instanceof Node && !host.contains(event.target)) setOpen(false);
  };
  const pointerEnter = () => scheduleOpen();
  const pointerLeave = () => scheduleClose();
  const focusIn = () => { if (!returningFocus) scheduleOpen(); };
  const focusOut = () => scheduleClose();

  host.addEventListener('click', click);
  host.addEventListener('pointerenter', pointerEnter);
  host.addEventListener('pointerleave', pointerLeave);
  host.addEventListener('focusin', focusIn);
  host.addEventListener('focusout', focusOut);
  host.addEventListener('keydown', keydown);
  document.addEventListener('pointerdown', outside);
  const cleanups: (() => void)[] = [startElapsedTick(list)];
  const rememberCleanup = (promise: Promise<() => void>) => {
    void promise.then(cleanup => { if (disposed) cleanup(); else cleanups.push(cleanup); }).catch(() => undefined);
  };
  rememberCleanup(subscribeDockEvent<AgentsDockSnapshot>('agents-dock-changed', next => { accept(next); draw(); }));
  rememberCleanup(subscribeDockEvent<Partial<AgentsDockPreferences>>('agents-dock-preferences-changed', next => { preferences = { ...preferences, ...next }; draw(); }));
  void Promise.all([
    call<AgentsDockPreferences>('agents_dock_preferences').catch(() => DEFAULT_PREFERENCES),
    call<AgentsDockSnapshot>('agents_dock_snapshot').catch(() => ({ agents: [] })),
  ]).then(([saved, current]) => {
    if (disposed) return;
    preferences = { ...DEFAULT_PREFERENCES, ...saved };
    accept(current);
    draw();
  });
  draw();
  return () => {
    if (disposed) return;
    disposed = true;
    window.clearTimeout(intentTimer);
    window.clearTimeout(closeTimer);
    cleanups.forEach(cleanup => cleanup());
    host.removeEventListener('click', click);
    host.removeEventListener('pointerenter', pointerEnter);
    host.removeEventListener('pointerleave', pointerLeave);
    host.removeEventListener('focusin', focusIn);
    host.removeEventListener('focusout', focusOut);
    host.removeEventListener('keydown', keydown);
    document.removeEventListener('pointerdown', outside);
    host.replaceChildren();
    host.classList.remove('agents-dock-host');
  };
}
