import { errorText } from './error-text.ts';

export type ToastTone = 'danger' | undefined;
/** The count a toast shows: an identical plain message (no Undo or action button) in the same tone while a plain one is
 * still visible bumps it, anything else restarts at 1 (a toast with a button keeps its own closure and longer timer; a
 * failure repeating a plain notice needs its danger icon and a fresh Escape grace). */
export function nextToastCount(current: { text: string; count: number; plain?: boolean; tone?: ToastTone } | null, text: string, visible: boolean, plain = true, tone?: ToastTone): number {
  return current && visible && plain && current.plain !== false && current.tone === tone && current.text === text ? current.count + 1 : 1;
}

/** Whether a new live error raises a toast. `onScreen`: its thread is the one in the main pane; `attended`: the window
 * is visible and focused; `undoShowing`: the toast offers Undo. The inline row already shows an error of the thread in
 * front of the reader, and a repeating error must not take that thread's Undo away early. */
export function shouldToastLiveError(state: { onScreen: boolean; attended: boolean; undoShowing: boolean }): boolean {
  return !state.onScreen || (!state.attended && !state.undoShowing);
}

const SAME_MS = 30_000, ANY_MS = 2_000;
/** A rejection loop must not spam: the same text waits 30 s, any text 2 s. */
export function shouldShowGlobalError(last: { key: string; at: number } | null, key: string, now: number): boolean {
  if (!last) return true;
  return now - last.at >= (last.key === key ? SAME_MS : ANY_MS);
}

/** Noise that is not worth a toast: aborted work, the harmless ResizeObserver notice, opaque cross-origin errors. */
export function isBenignGlobalError(reason: unknown, message: string): boolean {
  if ((reason as { name?: unknown } | null | undefined)?.name === 'AbortError') return true;
  return /ResizeObserver loop|^Script error\.?$/i.test(message);
}

/** What an uncaught error shows: its own message would be internal ("Cannot read properties of undefined"). */
export const GLOBAL_ERROR_TEXT = 'Something went wrong. If it keeps happening, restart PandaCode.';
/** A rejected IPC call (Tauri rejects with a string, or a plain `{ message }`) is worded for users; anything thrown is not. */
export function globalErrorText(reason: unknown): string {
  const fromIpc = typeof reason === 'string' || (reason !== null && typeof reason === 'object' && !(reason instanceof Error) && typeof (reason as { message?: unknown }).message === 'string');
  return fromIpc ? errorText(reason, GLOBAL_ERROR_TEXT) : GLOBAL_ERROR_TEXT;
}

/** An urgent toast (danger tone or Undo) that appeared this recently takes Escape before Stop does: the reader is most
 * likely answering it. A plain notice never does unless focus is in it. */
export const TOAST_ESCAPE_GRACE_MS = 2_000;
/** Whether Escape closes the toast before anything lower in the order (Stop); `blocked`: a dialog, menu or IME has it. */
export function escapeClosesToast(state: { visible: boolean; focusInToast: boolean; urgent: boolean; shownAt: number; now: number; blocked: boolean }): boolean {
  if (!state.visible || state.blocked) return false;
  return state.focusInToast || (state.urgent && state.now >= state.shownAt && state.now - state.shownAt < TOAST_ESCAPE_GRACE_MS);
}

/** At most this many plain notices wait behind a dismissal's Undo toast; older plain ones are dropped (a plain notice
 * asks nothing of the user). Notices that need the user (`important`: an approval or a question), notices with an
 * action button and danger notices are never dropped. */
export const TOAST_QUEUE_MAX = 3;
type Queued = { text: string; tone?: ToastTone; undo?: unknown; important?: boolean };
const plainNotice = (entry: Queued): boolean => !entry.important && entry.tone !== 'danger' && !entry.undo;
/** Whether a new notice shows now, and what waits. While a dismissal's Undo toast shows (`holding`), replacing it would
 * commit the dismissal early, so other notices wait (deduped by text and tone) and show once it settles. Another
 * dismissal (`dismissal`) or any other Undo toast (`undo` a function) replaces it at once, which commits the first:
 * queued, its ⌘Z would run the dismissal's Undo instead of its own. */
export function queueToast<T extends Queued>(state: { holding: boolean; queue: readonly T[] }, next: T, dismissal: boolean): { show: boolean; queue: T[] } {
  if (!state.holding || dismissal || typeof next.undo === 'function') return { show: true, queue: [...state.queue] };
  if (state.queue.some(entry => entry.text === next.text && entry.tone === next.tone)) return { show: false, queue: [...state.queue] };
  // ponytail: kept notices are unbounded; dedup by text and the global-error throttle keep them few.
  const queue = [...state.queue, next];
  const extra = queue.filter(plainNotice).length - TOAST_QUEUE_MAX;
  const dropped = new Set(queue.filter(plainNotice).slice(0, Math.max(0, extra)));
  return { show: false, queue: dropped.size ? queue.filter(entry => !dropped.has(entry)) : queue };
}

/** A toast's `title` (its full text on hover) is at most this long; a live error can carry kilobytes. */
export const TOAST_TITLE_CHARS = 500;
export const toastTitle = (text: string): string => text.length > TOAST_TITLE_CHARS ? `${text.slice(0, TOAST_TITLE_CHARS - 1)}…` : text;
