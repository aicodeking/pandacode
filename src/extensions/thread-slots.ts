/** Host-only markers, never package selectors or access to transcript/draft contents. */
import { escape } from '../dom';
import type { ThreadActionLocation, ThreadExtrasActionLocation } from './surfaces';

export function threadActionSlot(location: ThreadActionLocation, sessionId: string, kind: 'task' | 'message' | 'trace' | 'team' = 'task', id = sessionId): string {
  return `<div class="extension-action-slot" data-extension-action-slot="${location}" data-extension-session="${escape(sessionId)}" data-extension-selection-kind="${kind}" data-extension-selection-id="${escape(id)}"></div>`;
}

/** A transcript-extras marker (thread-extras-host.ts): the same host marker with several captured ids (a message's
 * attachment handles, a turn and its changed paths), bounded like `context.selection.ids`. */
export function threadExtrasSlot(location: ThreadExtrasActionLocation, sessionId: string, kind: 'message-attachment' | 'find' | 'turn-changes' | 'usage-limit', ids: readonly string[]): HTMLElement {
  const slot = document.createElement('div');
  slot.className = 'extension-action-slot';
  Object.assign(slot.dataset, { extensionActionSlot: location, extensionSession: sessionId, extensionSelectionKind: kind, extensionSelectionIds: JSON.stringify(ids.slice(0, 100)), threadExtras: '' });
  return slot;
}
