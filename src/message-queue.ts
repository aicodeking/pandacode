/** The queue above the composer: follow-ups typed while an agent works, delivered in order. */
import { escape, icon } from './dom';
import type { ProviderId } from './types';

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

/** Harnesses whose running turn accepts a message: Claude Code stream input and Codex `turn/steer`. */
export function canSteer(provider: ProviderId): boolean {
  return provider === 'claude' || provider === 'glm' || provider === 'mimo' || provider === 'codex';
}

export interface QueueView {
  entries: QueuedMessage[];
  hold: HoldReason | null;
  running: boolean;
  steerable: boolean;
  /** Send now can start a turn here (bot conversations drain natively, so they cannot). */
  sendable: boolean;
  editingId: string | null;
  busy: boolean;
}

function attachmentLabel(entry: QueuedMessage): string {
  const count = entry.attachments.length;
  return count ? `<span class="queue-attachments" title="${count} ${count === 1 ? 'attachment' : 'attachments'}">${icon('attach')}${count}</span>` : '';
}

function row(entry: QueuedMessage, index: number, view: QueueView): string {
  const last = index === view.entries.length - 1;
  if (entry.id === view.editingId) {
    return `<li class="queue-row editing" data-queue-id="${escape(entry.id)}"><textarea class="queue-edit" aria-label="Edit queued message" rows="2">${escape(entry.text)}</textarea>
      <div class="queue-edit-actions"><button type="button" class="secondary-button" data-action="queue-cancel">Cancel</button><button type="button" class="primary-button" data-action="queue-save">Save</button></div></li>`;
  }
  const preview = escape(entry.text.slice(0, 60));
  const steer = view.running && view.steerable && !view.busy ? `<button type="button" class="queue-now" data-action="queue-steer" title="Send into the running turn" aria-label="Steer now: ${preview}">${icon('spark')}<span>Steer</span></button>` : '';
  const sendNow = view.sendable && !view.busy ? `<button type="button" class="queue-now" data-action="queue-send-now" title="${view.running ? 'Stop the run and send this next' : 'Send this now'}" aria-label="Send now: ${preview}">${icon('arrow')}<span>Send now</span></button>` : '';
  return `<li class="queue-row" data-queue-id="${escape(entry.id)}"><span class="queue-index" aria-hidden="true">${index + 1}</span>
    <span class="queue-text" title="${escape(entry.text)}">${escape(entry.text.split('\n')[0] || '(attachments only)')}</span>${attachmentLabel(entry)}
    <span class="queue-actions">${steer}${sendNow}<button type="button" class="icon-button" data-action="queue-edit" aria-label="Edit queued message ${index + 1}" title="Edit" ${view.busy ? 'disabled' : ''}>${icon('edit')}</button><button type="button" class="icon-button" data-action="queue-up" aria-label="Move queued message ${index + 1} up" title="Move up" ${index === 0 || view.busy ? 'disabled' : ''}>${icon('arrow')}</button><button type="button" class="icon-button queue-down" data-action="queue-down" aria-label="Move queued message ${index + 1} down" title="Move down" ${last || view.busy ? 'disabled' : ''}>${icon('arrow')}</button><button type="button" class="icon-button" data-action="queue-remove" aria-label="Remove queued message ${index + 1}" title="Remove" ${view.busy ? 'disabled' : ''}>${icon('close')}</button></span></li>`;
}

/** Markup for the queue panel, or an empty string when nothing is queued. */
export function queuePanel(view: QueueView): string {
  if (!view.entries.length) return '';
  const count = view.entries.length;
  // A limit is resolved from its banner (Continue now or Resume at reset), so the queue offers no Resume then.
  const resume = view.hold === 'limited' ? '' : `<button type="button" class="queue-resume" data-action="queue-resume" ${view.busy ? 'disabled' : ''}>${view.running ? 'Resume after this run' : 'Resume'}</button>`;
  const status = view.hold ? `<span class="queue-hold">${HOLD_LABEL[view.hold]}</span>${resume}`
    : `<span class="queue-next">${view.running ? 'Sends when the agent finishes' : 'Sending next…'}</span>`;
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
