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

// ---- Send now (queue.take) ----

/** The message the host sends for an entry another client already took: the send happened, so it
 * reads as success on this phone (`message_queue::withdraw`'s own sentence). */
const ALREADY_GONE = /already sent or removed/i;

/** Why `queue.take` refused, as far as the phone acts on it: `gone` (treat as success and refresh),
 * `stop` (the run must stop first, so offer that as its own step) or `other` (just show it). */
export type TakeRefusal = 'gone' | 'stop' | 'other';

/** How to read a failed `queue.take`. The host refuses a running task it cannot steer with a
 * sentence naming the run, and a message another client sent is not a failure at all. Matching on
 * the sentence is deliberate: the method takes no error codes, and the two it distinguishes here
 * lead to different UI, so a wording change must show up as `other` rather than a wrong action. */
export function takeRefusal(error: unknown): TakeRefusal {
  const message = error instanceof Error ? error.message : String(error ?? '');
  if (ALREADY_GONE.test(message)) return 'gone';
  // Both refuse with "stop the run first": attachments while running, and a task that leads a team.
  if (/stop the run first/i.test(message)) return 'stop';
  return 'other';
}

/** Whether Send now is worth offering: the phone may take it out of the queue, and the row is the
 * one the host will send from an idle task (from a running one it steers whatever row was tapped). */
export function canSendNow(rights: { take: boolean }, running: boolean, index: number): boolean {
  return rights.take && (running || index === 0);
}
