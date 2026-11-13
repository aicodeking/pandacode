/** Pure helpers that de-duplicate, summarise and dismiss thread error messages. */
import type { TranscriptTurn } from './turn-activity.ts';
import type { Message } from './types.ts';

/** Minimal shape of an error row in a thread; `count` (default 1) is how many identical events one row stands for. */
type ErrorLike = { id: number | string; content: string; count?: number };

/** All errors sharing one `errorKey`, in input order. */
export type ErrorGroup = { key: string; content: string; count: number; ids: (number | string)[] };

/** Most saved error ids one native `dismiss_error_messages` call takes; the same limit as `MAX_DISMISS_ERROR_IDS` in
 * src-tauri/src/storage.rs (keep the two equal). */
export const DISMISS_BATCH = 500;

const LIVE_PREFIX = /^Error:\s*/;
const KEY_PREFIX_CHARS = 64;
const DEFAULT_SUMMARY_LIMIT = 240;
const DEFAULT_ANNOUNCE_WINDOW_MS = 10_000;
const ELLIPSIS = '…';
const HASH_SEED = 0x811c9dc5;
const HASH_PRIME = 0x01000193;

function normalise(content: string): string {
  return content.trim().replace(/\s+/g, ' ');
}

/** The text without surrounding space and one leading `Error: ` (how a live event arrives). */
export function stripErrorPrefix(content: string): string {
  return content.trim().replace(LIVE_PREFIX, '');
}

/** FNV-1a 32-bit hash as hex; only used to keep keys of long content short. */
function hash(text: string): string {
  let h = HASH_SEED;
  for (let i = 0; i < text.length; i += 1) {
    h = Math.imul(h ^ text.charCodeAt(i), HASH_PRIME) >>> 0;
  }
  return h.toString(16).padStart(8, '0');
}

/**
 * Normalised identity for de-duplication: trims, collapses whitespace, strips one
 * leading `Error: ` and stays short (long content becomes prefix + length + hash).
 */
export function errorKey(content: string): string {
  const text = normalise(stripErrorPrefix(content));
  if (text.length <= KEY_PREFIX_CHARS) return text;
  return `${text.slice(0, KEY_PREFIX_CHARS)}#${text.length}:${hash(text)}`;
}

/**
 * Merges every error with the same key (adjacent or not) into one group, keeping
 * first-occurrence order. Does not mutate the input.
 */
export function groupErrors(errors: readonly ErrorLike[]): ErrorGroup[] {
  const groups = new Map<string, { content: string; count: number; ids: (number | string)[] }>();
  for (const error of errors) {
    const key = errorKey(error.content), count = Math.max(1, error.count ?? 1);
    const existing = groups.get(key);
    if (existing) { existing.ids.push(error.id); existing.count += count; }
    else groups.set(key, { content: stripErrorPrefix(error.content), count, ids: [error.id] });
  }
  return [...groups].map(([key, group]) => ({ key, content: group.content, count: group.count, ids: [...group.ids] }));
}

/**
 * First non-empty line clamped to `limit` characters (with `…` when cut), and what the disclosure adds: the lines after
 * it (leading blank lines dropped, indentation kept), or the full trimmed text when the summary was clamped; null when
 * there is nothing more to show.
 */
export function errorSummary(content: string, limit = DEFAULT_SUMMARY_LIMIT): { summary: string; detail: string | null } {
  const full = content.trim();
  const newline = full.indexOf('\n');
  const firstLine = (newline < 0 ? full : full.slice(0, newline)).trim();
  if (firstLine.length > limit) return { summary: `${firstLine.slice(0, Math.max(0, limit - 1))}${ELLIPSIS}`, detail: full };
  const rest = newline < 0 ? '' : full.slice(newline + 1).replace(/^(?:[ \t]*\r?\n)+/, '').trimEnd();
  return { summary: firstLine, detail: rest || null };
}

/** False when the same key was announced within `windowMs`, so identical toasts are not repeated. */
export function shouldAnnounce(
  last: { key: string; at: number } | null,
  key: string,
  now: number,
  windowMs = DEFAULT_ANNOUNCE_WINDOW_MS,
): boolean {
  if (!last || last.key !== key) return true;
  return now - last.at >= windowMs && now >= last.at;
}

const isId = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) > 0;
const record = (value: unknown): Record<string, unknown> => value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};

/** The saved row id an `error` agent event carries in `data.messageId` (lib.rs `attach_message_id`); undefined when the
 * backend did not save it (or the data is malformed), so dismissing that live error is view-only. */
export function savedErrorId(data: unknown): number | undefined {
  const id = record(data).messageId;
  return isId(id) ? id : undefined;
}

/**
 * Deletes that must survive the app quitting before they reach the database (stored in localStorage, replayed at
 * launch): per thread, the saved error ids a dismissal will delete or is deleting. Storage is untrusted, so parsing
 * keeps only well-formed entries.
 */
export function dismissJournal(saved: ReadonlyMap<string, Iterable<number>>): string | null {
  const out = Object.fromEntries([...saved].map(([id, ids]) => [id, [...ids]] as const).filter(([, ids]) => ids.length));
  return Object.keys(out).length ? JSON.stringify(out) : null;
}
export function parseDismissJournal(raw: string | null): Map<string, number[]> {
  let data: Record<string, unknown> = {};
  try { data = record(raw ? JSON.parse(raw) : null); } catch { /* unreadable: nothing to replay */ }
  const saved = new Map<string, number[]>();
  for (const [id, ids] of Object.entries(data)) {
    const valid = Array.isArray(ids) ? ids.filter(isId) : [];
    if (valid.length) saved.set(id, valid);
  }
  return saved;
}

/** A turn as drawn; `errorsDismissed`: every error it had was dismissed, so its card keeps its header ("Stopped · 7s")
 * without the error box rather than vanishing; `dismissedErrors`: how many error events were dismissed (a quiet note
 * where the box was). */
export type ShownTurn = TranscriptTurn & { errorsDismissed?: boolean; dismissedErrors?: number };
/** Error events a list of rows stands for (a transient row carries `count`). */
export const eventCount = (messages: readonly Message[]): number => messages.reduce((sum, message) => sum + Math.max(1, (message as { count?: number }).count ?? 1), 0);
/** Both run times summed when a turn takes in another; an untimed side adds nothing, and an estimate stays one. */
function addTime(a: TranscriptTurn, b: TranscriptTurn): Pick<TranscriptTurn, 'durationMs' | 'estimated'> {
  if (a.durationMs === null || b.durationMs === null) return a.durationMs === null ? { durationMs: b.durationMs, estimated: b.estimated } : { durationMs: a.durationMs, estimated: a.estimated };
  return { durationMs: a.durationMs + b.durationMs, estimated: a.estimated || b.estimated };
}
/**
 * Drops hidden error rows, and folds a turn of errors alone (no prompt, step, reply, note or changes) into the turn
 * before it, so one failing run reads as one group (its run time added to that turn's); an errors-alone turn left with
 * none is dropped, leaving no shell. A turn that lost nothing is returned as is.
 */
export function foldErrorTurns(turns: readonly TranscriptTurn[], hidden: (message: Message) => boolean): ShownTurn[] {
  const shown: ShownTurn[] = [];
  for (const turn of turns) {
    const kept = turn.errors.filter(message => !hidden(message));
    // `filter` always returns a new array: a turn that lost nothing must stay the same turn, never "dismissed".
    const errors = kept.length === turn.errors.length ? turn.errors : kept;
    const alone = !turn.user && !turn.coordination && !turn.handoff && !turn.activity.length && !turn.final && !turn.notes.length && !turn.changes;
    const previous = shown.at(-1), dismissed = errors === turn.errors ? 0 : eventCount(turn.errors) - eventCount(errors);
    if (alone && previous && !previous.handoff) shown[shown.length - 1] = { ...previous, ...addTime(previous, turn), errors: [...previous.errors, ...errors], ...(dismissed ? { dismissedErrors: (previous.dismissedErrors ?? 0) + dismissed, errorsDismissed: (!previous.errors.length && !errors.length) || previous.errorsDismissed } : {}) };
    else if (alone && !errors.length) continue;
    else shown.push(errors === turn.errors ? turn : { ...turn, errors, errorsDismissed: (turn.errors.length > 0 && !errors.length) || undefined, dismissedErrors: dismissed || undefined });
  }
  return shown;
}

/** A live error dismissed in a thread mirrored from another computer: its `errorKey`, and the newest saved row id the
 * thread had then (the run's copies arrive later, with higher ids). */
export type RunHide = { key: string; after: number };
/**
 * The saved rows a mirrored thread's live dismissals stand for once the run's copies arrive: errors with the same key,
 * saved after the dismissal (id above `after`), in that run only (up to the next prompt after its first copied row).
 */
export function hiddenRunErrors(messages: readonly Pick<Message, 'id' | 'role' | 'content'>[], hides: readonly RunHide[]): Set<number> {
  const hidden = new Set<number>(), ordered = [...messages].sort((a, b) => a.id - b.id);
  for (const { key, after } of hides) {
    let started = false;
    for (const message of ordered) {
      if (message.id <= after) continue;
      const prompt = message.role === 'user' || message.role === 'coordination';
      if (prompt && started) break;
      started ||= !prompt;
      if (message.role === 'error' && errorKey(message.content) === key) hidden.add(message.id);
    }
  }
  return hidden;
}
