/** Host-only markers, never package selectors or access to transcript/draft contents. */
import { escape } from '../dom';
import type { ThreadActionLocation } from './surfaces';

export function threadActionSlot(location: ThreadActionLocation, sessionId: string, kind: 'task' | 'message' | 'trace' | 'team' = 'task', id = sessionId): string {
  return `<div class="extension-action-slot" data-extension-action-slot="${location}" data-extension-session="${escape(sessionId)}" data-extension-selection-kind="${kind}" data-extension-selection-id="${escape(id)}"></div>`;
}
