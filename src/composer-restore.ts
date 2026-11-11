/**
 * Restoring rejected sends to the composer. A committed send clears its draft at once, so newer typing may already be
 * there when a send fails: the failed draft comes back before that text (after any earlier rejected drafts), in the
 * order the drafts were written, and each rejected send restores its own copy. DOM-free except `applyRestoredDraft`.
 */

/** Recent committed drafts per thread, oldest first. */
interface CommittedDraft { readonly serial: number; readonly text: string; readonly restored: boolean }

/** How many unrestored commits a thread remembers. */
const COMMITTED_DRAFT_LIMIT = 16;

export interface RestoredDraft {
  /** The composer text with the rejected draft restored. */
  readonly text: string;
  /** Where the draft went in: text at or after this offset moved by the restored length. */
  readonly at: number;
}

export interface CommittedDrafts {
  /** A send committed `text` in `threadId` (blank drafts are ignored). */
  note(threadId: string, text: string): void;
  /** Drops the records of deleted threads. */
  forget(threadIds: Iterable<string>): void;
  /** Places a rejected draft `text` into the thread's `current` composer text. */
  restore(threadId: string, text: string, current: string): RestoredDraft;
}

export function createCommittedDrafts(limit = COMMITTED_DRAFT_LIMIT): CommittedDrafts {
  let drafts = new Map<string, readonly CommittedDraft[]>();
  let commits = 0;
  const update = (threadId: string, entries: readonly CommittedDraft[]) => { drafts = new Map(drafts).set(threadId, entries); };

  /** A rejected draft's place among the drafts already restored at the top (written order), else before everything.
   * Only text typed anew that equals it is deduplicated. */
  const placement = (threadId: string, text: string, current: string): { at: number; dedupe: boolean } => {
    const entries = drafts.get(threadId) ?? [], restored = entries.filter(entry => entry.restored);
    const own = entries.find(entry => !entry.restored && entry.text === text.trim());
    const joined = restored.map(entry => entry.text).join('\n');
    const present = Boolean(joined) && (current === joined || current.startsWith(`${joined}\n`));
    if (own) update(threadId, entries.map(entry => entry === own ? { ...entry, restored: true } : entry));
    if (!own || !present) return { at: 0, dedupe: !present };
    const earlier = restored.filter(entry => entry.serial < own.serial).map(entry => entry.text).join('\n');
    return { at: earlier ? earlier.length + 1 : 0, dedupe: false };
  };

  return {
    // A new commit carries any restored drafts with it, so only unrestored commits are kept.
    note(threadId, text) {
      if (!text.trim()) return;
      const kept = (drafts.get(threadId) ?? []).filter(entry => !entry.restored).slice(1 - limit);
      update(threadId, [...kept, { serial: ++commits, text: text.trim(), restored: false }]);
    },
    forget(threadIds) {
      const next = new Map(drafts);
      for (const id of threadIds) next.delete(id);
      drafts = next;
    },
    restore(threadId, text, current) {
      if (!text) return { text: current, at: 0 };
      const place = placement(threadId, text, current);
      if (place.dedupe && text === current) return { text: current, at: 0 };
      const { at } = place;
      const head = current.slice(0, Math.max(0, at - 1)), tail = current.slice(at);
      const restored = at ? `${head}\n${text}${tail ? `\n${tail}` : ''}` : current ? `${text}\n${current}` : text;
      return { text: restored, at };
    },
  };
}

/** The textarea surface `applyRestoredDraft` needs. */
export interface DraftField {
  value: string; selectionStart: number; selectionEnd: number; selectionDirection: 'forward' | 'backward' | 'none';
  setSelectionRange(start: number, end: number, direction?: 'forward' | 'backward' | 'none'): void;
}

/** Writes a restored draft into the shown field, keeping its selection on the same text. */
export function applyRestoredDraft(field: DraftField, current: string, restored: string, at: number): void {
  const offset = restored.length - current.length, shift = (position: number) => position >= at ? position + offset : position;
  const start = shift(field.selectionStart), end = shift(field.selectionEnd), direction = field.selectionDirection;
  if (field.value !== restored) field.value = restored;
  field.setSelectionRange(start, end, direction);
}
