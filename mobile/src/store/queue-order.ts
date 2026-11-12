// Undo for a queued message removed on the Queue screen (app/queue.tsx, connect/api/queue.ts):
// which removals get Undo, and where an older host's re-add goes back.

/** Undo can put back only a removal it knows in full: the list's text is cut short for long
 * messages, and a queued message's attachments never reach the phone. */
export function canRestore(entry: { truncated: boolean; attachments: number }): boolean {
  return !entry.truncated && entry.attachments === 0;
}

/** Whether an older host's task.send would take a message for a task in `mode`: a full-mode task
 * needs the host's Full access switch (host.rs allow_task_mode). Unknown counts as allowed. */
export function sendAllowed(mode: string | undefined, remoteFullAccess: boolean | undefined): boolean {
  return !(mode === 'full' && remoteFullAccess === false);
}

/**
 * How a removal offers Undo: with `queue.restore` the host puts back any entry ('undo'); without it
 * the phone re-sends, so an entry it can't rebuild, or a task whose mode it may not send in, asks
 * first ('confirm').
 */
export function removalUndo(entry: { truncated: boolean; attachments: number }, host: { restore: boolean; sendAllowed: boolean }): 'undo' | 'confirm' {
  if (host.restore) return 'undo';
  return host.sendAllowed && canRestore(entry) ? 'undo' : 'confirm';
}

/** The id of the entry a re-add created: the newest one not in `before` with `text`, else null. */
export function readdedId(before: readonly string[], after: readonly { id: string; text: string }[], text: string): string | null {
  const known = new Set(before);
  const fresh = after.filter(entry => !known.has(entry.id) && entry.text === text);
  return fresh.length ? fresh[fresh.length - 1].id : null;
}

/** `ids` with `id` moved to `index` (clamped), the place a removal held before its Undo. */
export function placedAt<T>(ids: readonly T[], id: T, index: number): T[] {
  const rest = ids.filter(other => other !== id);
  if (rest.length === ids.length) return [...ids];
  const at = Math.max(0, Math.min(rest.length, index));
  return [...rest.slice(0, at), id, ...rest.slice(at)];
}

/**
 * Where the open editor stands against the latest queue: 'none' with nothing open, 'open' while its
 * entry is still queued (or the list isn't loaded), 'sent' once the computer took it from the queue,
 * so the screen keeps the draft and says so instead of dropping it.
 */
export function editorState(editingId: string | null, entries: readonly { id: string }[] | undefined): 'none' | 'open' | 'sent' {
  if (!editingId) return 'none';
  if (!entries) return 'open';
  return entries.some(entry => entry.id === editingId) ? 'open' : 'sent';
}
