import './styles.css';
import './motion.css';
import './agents-dock.css';
import { call } from './bridge';
import { icon } from './dom';
import { errorText } from './error-text';
import './theme';
import { palette } from './palette';
import { renderAgentRows, startElapsedTick, subscribeDockEvent, type AgentsDockSnapshot } from './agents-dock';

palette.refresh();
document.body.classList.add('agents-dock-window');
const root = document.querySelector<HTMLElement>('#agents-dock-root')!;
const getWindow = async () => (await import('@tauri-apps/api/window')).getCurrentWindow();

// Both states are built once and updated in place, so a focused control is never replaced.
root.innerHTML = `<button type="button" class="agents-dock-orb" data-tauri-drag-region aria-expanded="false" aria-controls="agents-dock-panel" title="Running agents">${icon('bot')}<span class="agents-dock-window-count" aria-hidden="true" hidden></span></button>
  <section class="agents-dock-window-panel" id="agents-dock-panel" role="dialog" aria-label="Running agents" hidden>
    <header class="agents-dock-window-head" data-tauri-drag-region><strong></strong><button type="button" data-action="collapse" aria-label="Collapse widget" title="Collapse (Esc)">${icon('minimize')}</button><button type="button" data-action="unpin" aria-label="Unpin widget" title="Unpin widget">${icon('close')}</button></header>
    <div class="agents-dock-window-error-row"><span class="agents-dock-window-error-icon" data-state-tone="danger" aria-hidden="true" hidden>${icon('alert')}</span><span class="agents-dock-window-error" role="alert"></span><button type="button" data-action="dismiss-error" aria-label="Dismiss error" hidden>${icon('close')}</button></div>
    <div class="agents-dock-window-list"></div>
  </section>`;
const orb = root.querySelector<HTMLButtonElement>('.agents-dock-orb')!;
const orbCount = root.querySelector<HTMLElement>('.agents-dock-window-count')!;
const panel = root.querySelector<HTMLElement>('.agents-dock-window-panel')!;
const heading = root.querySelector<HTMLElement>('.agents-dock-window-head strong')!;
const list = root.querySelector<HTMLElement>('.agents-dock-window-list')!;
const alertRow = root.querySelector<HTMLElement>('.agents-dock-window-error-row')!;
const alertText = alertRow.querySelector<HTMLElement>('.agents-dock-window-error')!;
let snapshot: AgentsDockSnapshot = { agents: [] };
let receivedAt = Date.now();
let expanded = false;
let stopped = false;
let intentTimer = 0;
let collapseTimer = 0;

function draw(): void {
  const total = snapshot.agents.length;
  const running = snapshot.agents.filter(agent => agent.status === 'running').length;
  const label = total ? `Running agents, ${total} active. Press to expand.` : 'Running agents. Press to expand.';
  if (orb.getAttribute('aria-label') !== label) orb.setAttribute('aria-label', label);
  orb.classList.toggle('is-working', running > 0);
  orb.setAttribute('aria-expanded', String(expanded));
  orb.hidden = expanded;
  orbCount.hidden = !total;
  orbCount.textContent = String(total);
  panel.hidden = !expanded;
  heading.textContent = `Running agents · ${total}`;
  renderAgentRows(list, snapshot.agents, receivedAt, 'agents-dock-window-empty');
}
const accept = (value: AgentsDockSnapshot) => { snapshot = value; receivedAt = Date.now(); draw(); };

async function setExpanded(value: boolean, { focus = false } = {}): Promise<void> {
  if (stopped) return;
  if (expanded !== value) {
    expanded = value;
    draw();
    try { await call('agents_dock_set_expanded', { expanded: value }); } catch { /* Native size follows the saved pin state. */ }
  }
  if (focus) (value ? list.querySelector<HTMLElement>('[data-agent-id]') ?? panel.querySelector<HTMLElement>('[data-action="collapse"]') : orb)?.focus();
}
function scheduleExpand(): void {
  window.clearTimeout(collapseTimer); window.clearTimeout(intentTimer);
  intentTimer = window.setTimeout(() => { void setExpanded(true); }, 160);
}
function scheduleCollapse(): void {
  window.clearTimeout(intentTimer); window.clearTimeout(collapseTimer);
  // A keyboard user inside the panel keeps it open; Escape or Collapse closes it.
  collapseTimer = window.setTimeout(() => { if (!root.matches(':hover') && !root.querySelector(':focus-visible')) void setExpanded(false); }, 180);
}
const onPointerEnter = () => scheduleExpand();
const onPointerLeave = () => scheduleCollapse();
const onPointerDown = (event: PointerEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target?.closest('[data-tauri-drag-region]') || target.closest('button:not(.agents-dock-orb)')) return;
  void getWindow().then(window => window.startDragging()).catch(() => undefined);
};
let said = '';
/** Shows a failed action in the panel; a later success clears it. The live region (the text only, not the Dismiss button) is always in the DOM (empty it takes
 * no room) and is rewritten only when the text changes, so assistive tech announces each failure once. */
function say(text = ''): void {
  if (text === said) return;
  said = text;
  alertText.textContent = text;
  alertRow.classList.toggle('is-open', text !== '');
  for (const node of alertRow.querySelectorAll<HTMLElement>('.agents-dock-window-error-icon, button')) node.hidden = text === '';
}
const failure = (cause: unknown) => errorText(cause, 'The action failed. Try again.');
const onClick = async (event: MouseEvent) => {
  const target = event.target instanceof Element ? event.target : null;
  if (!target) return;
  window.clearTimeout(intentTimer);
  if (target.closest('[data-action="unpin"]')) {
    try { await call('agents_dock_unpin'); say(); } catch (cause) { say(failure(cause)); }
    return;
  }
  if (target.closest('[data-action="dismiss-error"]')) {
    say();
    (list.querySelector<HTMLElement>('[data-agent-id]') ?? panel.querySelector<HTMLElement>('[data-action="collapse"]'))?.focus();
    return;
  }
  if (target.closest('[data-action="collapse"]')) { void setExpanded(false, { focus: true }); return; }
  // A click is a pointer; Enter/Space on the orb arrive as a click with detail 0.
  if (target.closest('.agents-dock-orb')) { void setExpanded(true, { focus: event.detail === 0 }); return; }
  const row = target.closest<HTMLElement>('[data-agent-id]');
  if (row?.dataset.agentId) {
    // A failed open keeps the panel expanded so the message stays in view.
    try { await call('agents_dock_open_task', { sessionId: row.dataset.agentId }); } catch (cause) { say(failure(cause)); return; }
    say();
    void setExpanded(false);
  }
};
const onKeyDown = (event: KeyboardEvent) => {
  if (event.key === 'Escape' && expanded) { event.preventDefault(); void setExpanded(false, { focus: true }); }
};

root.addEventListener('pointerenter', onPointerEnter);
root.addEventListener('pointerleave', onPointerLeave);
root.addEventListener('pointerdown', onPointerDown);
root.addEventListener('click', onClick);
document.addEventListener('keydown', onKeyDown);
void call<AgentsDockSnapshot>('agents_dock_snapshot').then(accept).catch(() => draw());
const unsubscribe = subscribeDockEvent<AgentsDockSnapshot>('agents-dock-changed', accept);
const stopTick = startElapsedTick(list);
draw();

window.addEventListener('beforeunload', () => {
  stopped = true; window.clearTimeout(intentTimer); window.clearTimeout(collapseTimer); stopTick();
  root.removeEventListener('pointerenter', onPointerEnter); root.removeEventListener('pointerleave', onPointerLeave);
  root.removeEventListener('pointerdown', onPointerDown); root.removeEventListener('click', onClick);
  document.removeEventListener('keydown', onKeyDown);
  void unsubscribe.then(cleanup => cleanup()).catch(() => undefined);
}, { once: true });
