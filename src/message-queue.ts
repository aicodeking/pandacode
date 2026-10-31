/** The queue above the composer: follow-ups typed while an agent works, delivered in order. */
import { escape, icon } from './dom';

export interface QueuedMessage {
  id: string;
  sessionId: string;
  position: number;
  text: string;
  /** Prompt attachments and mentioned file paths, as the composer described them. */
  attachments: QueuedAttachment[];
  createdAt: number;
  updatedAt: number;
}
export type QueuedAttachment = { kind: 'path'; path: string } | ({ kind: 'image' | 'document' | 'folder' | 'sketch' } & Record<string, unknown>);

export type HoldReason = 'restart' | 'failed' | 'stopped' | 'limited';
export const HOLD_LABEL: Record<HoldReason, string> = {
  restart: 'Paused after restart',
  failed: 'Paused after the run failed',
  stopped: 'Paused after you stopped the run',
  limited: 'Paused until the usage limit resets',
};

export interface QueueView {
  entries: QueuedMessage[];
  hold: HoldReason | null;
  running: boolean;
  steerable: boolean;
  /** Send now can start a turn here (bot conversations drain natively, so they cannot). */
  sendable: boolean;
  editingId: string | null;
  busy: boolean;
  /** Entries whose steer is in flight; they leave the queue once it is taken. */
  steering: ReadonlySet<string>;
  /** Entries whose last steer did not land, with the reason (shown as a "Not steered" badge). */
  notSteered?: ReadonlyMap<string, string>;
  /** Name of the agent holding the queue, for "Waiting – {name} is working". */
  agentName?: string;
}
const SPINNER = '<span class="support-spinner" aria-hidden="true"></span>';

function attachmentLabel(entry: QueuedMessage): string {
  const count = entry.attachments.length;
  return count ? `<span class="queue-attachments" title="${count} ${count === 1 ? 'attachment' : 'attachments'}">${icon('attach')}${count}</span>` : '';
}

function row(entry: QueuedMessage, index: number, view: QueueView): string {
  const last = index === view.entries.length - 1;
  if (entry.id === view.editingId) {
    return `<li class="queue-row editing" data-queue-id="${escape(entry.id)}"><div class="queue-edit-head"><span class="queue-badge">Editing</span><span class="queue-edit-notice" role="note">You are editing a queued message. Save or cancel the edit to let it run.</span></div><textarea class="queue-edit" aria-label="Edit queued message" rows="2">${escape(entry.text)}</textarea>
      <div class="queue-edit-actions"><button type="button" class="secondary-button" data-action="queue-cancel">Cancel edit</button><button type="button" class="primary-button" data-action="queue-save">Save</button></div></li>`;
  }
  const preview = escape(entry.text.slice(0, 60));
  if (view.steering.has(entry.id)) {
    return `<li class="queue-row steering" data-queue-id="${escape(entry.id)}" aria-busy="true"><span class="queue-index" aria-hidden="true">${icon('spark')}</span>
    <span class="queue-text" title="${escape(entry.text)}">${escape(entry.text.split('\n')[0] || '(attachments only)')}</span><span class="queue-status" role="status">${SPINNER}Steering…</span></li>`;
  }
  const steer = view.running && view.steerable && !view.busy && !entry.attachments.length ? `<button type="button" class="queue-now" data-action="queue-steer" title="Steer message" aria-label="Steer now: ${preview}">${icon('spark')}<span>Steer</span></button>` : '';
  const sendNow = view.sendable && !view.busy ? `<button type="button" class="queue-now" data-action="queue-send-now" title="${!view.running ? 'Send this now' : view.steerable && !entry.attachments.length ? 'Send into the running turn' : 'Stop the run and send this next'}" aria-label="Send now: ${preview}">${icon('arrow')}<span>Send now</span></button>` : '';
  const failure = view.notSteered?.get(entry.id);
  const badge = failure !== undefined ? `<span class="queue-badge warn" title="${escape(failure)}" tabindex="0">Not steered</span>` : '';
  return `<li class="queue-row" data-queue-id="${escape(entry.id)}" draggable="${view.busy ? 'false' : 'true'}" tabindex="0" aria-label="Queued message ${index + 1}: ${preview}" aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"><span class="queue-index" aria-hidden="true">${icon('spark')}</span>
    <span class="queue-text" title="${escape(entry.text)}">${escape(entry.text.split('\n')[0] || '(attachments only)')}</span>${attachmentLabel(entry)}${badge}
    <span class="queue-actions">${steer}${sendNow}<button type="button" class="icon-button" data-action="queue-edit" aria-label="Edit queued message ${index + 1}" title="Edit message" ${view.busy ? 'disabled' : ''}>${icon('edit')}</button><button type="button" class="icon-button" data-action="queue-up" aria-label="Move queued message ${index + 1} up" title="Move up" ${index === 0 || view.busy ? 'disabled' : ''}>${icon('arrow')}</button><button type="button" class="icon-button queue-down" data-action="queue-down" aria-label="Move queued message ${index + 1} down" title="Move down" ${last || view.busy ? 'disabled' : ''}>${icon('arrow')}</button><button type="button" class="icon-button" data-action="queue-remove" aria-label="Remove queued message ${index + 1}" title="Delete message" data-held="${view.hold ? '1' : ''}" ${view.busy ? 'disabled' : ''}>${icon('trash')}</button></span></li>`;
}

/** Markup for the queue panel, or an empty string when nothing is queued. */
export function queuePanel(view: QueueView): string {
  if (!view.entries.length) return '';
  const count = view.entries.length;
  // A limit is resolved from its banner (Continue now or Resume at reset), so the queue offers no Resume then.
  const resume = view.hold === 'limited' ? '' : `<button type="button" class="queue-resume" data-action="queue-resume" ${view.busy ? 'disabled' : ''}>${view.running ? 'Resume after this run' : 'Resume'}</button>`;
  const status = view.hold ? `<span class="queue-hold">${HOLD_LABEL[view.hold]}</span>${resume}`
    : `<span class="queue-next">${view.running ? (view.agentName ? `Waiting – ${escape(view.agentName)} is working` : 'Sends when the agent finishes') : `${SPINNER}Sending next…`}</span>`;
  return `<section class="queue-panel" aria-label="Queued messages"><header class="queue-heading"><strong>Queued</strong><span class="queue-count">${count}</span>${status}</header><ol class="queue-list">${view.entries.map((entry, index) => row(entry, index, view)).join('')}</ol></section>`;
}

/** Moves an entry one place and returns the new order of ids. */
export function moved(entries: readonly QueuedMessage[], id: string, step: -1 | 1): string[] {
  const ids = entries.map(entry => entry.id);
  const index = ids.indexOf(id), target = index + step;
  if (index < 0 || target < 0 || target >= ids.length) return ids;
  [ids[index], ids[target]] = [ids[target], ids[index]];
  return ids;
}

const LIVE = 'queue-live';
function announce(text: string): void {
  let live = document.getElementById(LIVE);
  if (!live) { live = document.createElement('div'); live.id = LIVE; live.className = 'sr-only'; live.setAttribute('role', 'status'); live.setAttribute('aria-live', 'polite'); document.body.append(live); }
  live.textContent = '';
  live.textContent = text;
}
const rowOf = (id: string): HTMLElement | null => document.querySelector<HTMLElement>(`.queue-row[data-queue-id="${CSS.escape(id)}"]`);
const idsInDom = (): string[] => [...document.querySelectorAll<HTMLElement>('.queue-list > .queue-row')].map(row => row.dataset.queueId ?? '');
/** Waits for the panel to redraw after a move (the app re-renders the composer asynchronously). */
const redrawn = (): Promise<void> => new Promise(resolve => {
  const list = document.querySelector('.queue-list')?.parentElement?.parentElement ?? document.body;
  const done = () => { observer.disconnect(); clearTimeout(timer); resolve(); };
  const observer = new MutationObserver(done), timer = setTimeout(done, 600);
  observer.observe(list, { childList: true, subtree: true });
});

/** Steps a row one place at a time through the panel's own move buttons, so state stays with the app. */
async function moveTo(id: string, target: number): Promise<void> {
  for (let guard = 0; guard < 50; guard++) {
    const at = idsInDom().indexOf(id);
    if (at < 0 || at === target) break;
    const button = rowOf(id)?.querySelector<HTMLButtonElement>(at > target ? '[data-action="queue-up"]' : '[data-action="queue-down"]');
    if (!button || button.disabled) break;
    const next = redrawn(); button.click(); await next;
  }
  const total = idsInDom().length, position = idsInDom().indexOf(id) + 1;
  if (position) announce(`Moved queued message to position ${position} of ${total}.`);
  rowOf(id)?.focus();
}

let dragged = '';
function dropTarget(event: DragEvent): HTMLElement | null { return (event.target as HTMLElement | null)?.closest<HTMLElement>('.queue-list > .queue-row') ?? null; }
function installQueueInteractions(): void {
  document.addEventListener('dragstart', event => {
    const row = dropTarget(event); if (!row || row.classList.contains('editing')) return;
    dragged = row.dataset.queueId ?? ''; row.classList.add('dragging');
    event.dataTransfer?.setData('text/plain', dragged); if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  document.addEventListener('dragover', event => {
    if (!dragged) return; const row = dropTarget(event); if (!row) return;
    event.preventDefault();
    document.querySelectorAll('.queue-row.drag-over').forEach(other => other.classList.remove('drag-over'));
    if (row.dataset.queueId !== dragged) row.classList.add('drag-over');
  });
  document.addEventListener('dragend', () => { dragged = ''; document.querySelectorAll('.queue-row.dragging,.queue-row.drag-over').forEach(row => row.classList.remove('dragging', 'drag-over')); });
  document.addEventListener('drop', event => {
    const row = dropTarget(event), id = dragged; if (!row || !id) return;
    event.preventDefault(); dragged = '';
    void moveTo(id, idsInDom().indexOf(row.dataset.queueId ?? ''));
  });
  document.addEventListener('keydown', event => {
    if (!event.altKey || (event.key !== 'ArrowUp' && event.key !== 'ArrowDown')) return;
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.queue-list > .queue-row'); if (!row || row.classList.contains('editing')) return;
    event.preventDefault();
    const id = row.dataset.queueId ?? '', at = idsInDom().indexOf(id);
    void moveTo(id, Math.max(0, Math.min(idsInDom().length - 1, at + (event.key === 'ArrowUp' ? -1 : 1))));
  });
  // Deleting while the queue is held asks first: the held message would otherwise vanish unseen.
  document.addEventListener('click', event => {
    const target = event.target as HTMLElement | null, button = target?.closest<HTMLElement>('[data-action="queue-remove"]');
    if (button && button.dataset.held === '1' && !button.dataset.confirmed) {
      event.stopImmediatePropagation(); event.preventDefault();
      const row = button.closest<HTMLElement>('.queue-row'); if (!row || row.querySelector('.queue-confirm')) return;
      row.insertAdjacentHTML('beforeend', `<div class="queue-confirm" role="alertdialog" aria-label="Delete queued message?"><strong>Delete queued message?</strong><button type="button" class="secondary-button" data-queue-keep>Keep</button><button type="button" class="primary-button" data-action="queue-remove" data-confirmed="1">Delete</button></div>`);
      row.querySelector<HTMLElement>('[data-queue-keep]')?.focus(); return;
    }
    if (target?.closest('[data-queue-keep]')) { const row = target.closest<HTMLElement>('.queue-row'); row?.querySelector('.queue-confirm')?.remove(); row?.focus(); }
  }, true);
}
installQueueInteractions();
