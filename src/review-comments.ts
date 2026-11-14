/* Line comments: review notes a user leaves on a line or a range of lines in the Files view's code
 * preview or the Changes diff, then hands to the thread's agent in one prompt. They belong to one
 * thread and are kept per thread in local storage, like composer drafts, until sent: "Send comments
 * to agent" puts them in the composer and clears them. The agent has no tools for them. See
 * docs/line-comments.md.
 *
 * This is the part loaded at startup: the store, its storage and cleanup, the prompt and the Send
 * button. The inline UI (fields, line numbers, the diff's keyboard path) and its CSS load the first
 * time a code file or a Changes diff is shown with a thread, or a comment needs the Changes view's
 * group of comments shown nowhere else (`reviewUi()`, review-comments-ui.ts; a diff's part is
 * `reviewDiffUi()`, review-comments-diff.ts); anchoring lives in review-anchor.ts. It has no
 * runtime imports but launch-restore's constants and the storage helpers it shares with drafts
 * (stored-budget.ts), so `node --test` loads it directly. */
import { DRAFT_FUTURE_SLACK, DRAFT_MAX_AGE } from './launch-restore.ts';
import { expiredAt, safeRead, safeRemove, storedKeys, writeWithinBudget, type Store, type StoredSizes } from './stored-budget.ts';

export type ReviewSide = 'old' | 'new' | 'file';
/** `outdated`: its lines are gone from the file (it comes back to `open` if they return). */
export type ReviewStatus = 'open' | 'outdated';
/** What a comment remembers about its lines: their text (joined with `\n`) and up to three lines of
 * context each side, as arrays so that a blank line counts as context. `unique`: in the Files view,
 * the text was the only copy in the file when the comment was made (absent in a diff, and in
 * comments stored before it was recorded, which then never move to a lone copy elsewhere). */
export type ReviewAnchor = { text: string; before: string[]; after: string[]; unique?: boolean };
/** `dropped`: in a diff, the deleted (old-side) lines a range drawn between deleted and added lines
 * left out (selectionSpan in review-anchor.ts): the card and the prompt say so. Absent otherwise, and
 * in comments stored before it was recorded. */
export type ReviewComment = {
  id: string; sessionId: string; file: string; side: ReviewSide;
  startLine: number; endLine: number; anchor: ReviewAnchor; text: string;
  status: ReviewStatus; createdAt: number; dropped?: number[];
};
export type NewReviewComment = Pick<ReviewComment, 'file' | 'side' | 'startLine' | 'endLine' | 'anchor' | 'text' | 'dropped'> & { status?: ReviewStatus };
/** A change to a comment. `anchor`: its lines were found again with other surroundings, which the
 * next search goes by. */
export type ReviewUpdate = { id: string; text?: string; status?: ReviewStatus; startLine?: number; endLine?: number; anchor?: ReviewAnchor };

export const MAX_COMMENT_LENGTH = 4000;

export const rangeLabel = (start: number, end: number): string => start === end ? `line ${start}` : `lines ${start}–${end}`;
export const capital = (text: string): string => text.charAt(0).toUpperCase() + text.slice(1);
/** Line numbers as short runs: `13–14, 16`. */
export function lineRuns(lines: readonly number[]): string {
  const sorted = [...new Set(lines)].sort((a, b) => a - b), runs: string[] = [];
  for (let i = 0; i < sorted.length;) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    runs.push(i === j ? String(sorted[i]) : `${sorted[i]}–${sorted[j]}`);
    i = j + 1;
  }
  return runs.join(', ');
}
/** What a diff comment says about the deleted lines its range left out (`dropped`): `deleted lines
 * 13–14 not included`, or '' when none were. */
export const droppedNote = (dropped: readonly number[] | undefined): string =>
  dropped?.length ? `deleted ${dropped.length === 1 ? 'line' : 'lines'} ${lineRuns(dropped)} not included` : '';
const plural = (count: number, word: string): string => `${count} ${word}${count === 1 ? '' : 's'}`;

/** Asked of the agent after the comments. Comments may be requests or questions, so it asks only for
 * one item per comment; and none is tracked once sent, so that list is the record of each. */
export const SUMMARY_REQUEST = 'End your reply with a numbered list: one short item responding to each comment, in the same order.';

/**
 * The text "Send N comments" puts in the composer: every comment of the thread as its file,
 * lines and text, then SUMMARY_REQUEST. It says nothing about what the comments are for; the user
 * adds any instructions. Sending clears the comments, so outdated ones go too, marked as such.
 */
export function reviewPrompt(comments: readonly ReviewComment[], onLines: (comment: ReviewComment) => boolean = c => c.status !== 'outdated'): string {
  if (!comments.length) return '';
  const items = comments.map((c, i) => {
    const notes = [c.side === 'old' ? 'deleted lines' : '', droppedNote(c.dropped), c.status === 'outdated' ? 'these lines have since changed' : ''].filter(Boolean);
    const head = `${i + 1}. ${c.file}, ${rangeLabel(c.startLine, c.endLine)}${notes.length ? ` (${notes.join('; ')})` : ''}`;
    const body = c.text.trim().split('\n').map(line => `   ${line}`.trimEnd());
    // Lines no view shows it on (outdated, or not shown where it was): the code it was written on.
    // Deleted lines always: their numbers are in the previous version, which the agent may not
    // have at hand, so the file and lines alone do not find them.
    const code = c.side === 'old' || c.status === 'outdated' || !onLines(c) ? quotedCode(c.anchor.text) : [];
    return [head, ...body, ...code.length ? ['   Written on:', ...code.map(line => `      ${line}`.trimEnd())] : []].join('\n');
  });
  return `${items.join('\n\n')}\n\n${SUMMARY_REQUEST}`;
}

/** At most this many lines of code are quoted under a comment. */
export const QUOTE_MAX_LINES = 12;
/** The code a comment was written on, to quote under it: lines a diff did not show (UNSHOWN in
 * review-anchor.ts) left out, blank lines at either end dropped, common indentation removed, and
 * cut to QUOTE_MAX_LINES. */
function quotedCode(text: string): string[] {
  const lines = text.split('\n').filter(line => line !== '\u0000').map(line => line.trimEnd());
  while (lines.length && !lines[0]) lines.shift();
  while (lines.length && !lines.at(-1)) lines.pop();
  const indent = Math.min(...lines.filter(Boolean).map(line => line.length - line.trimStart().length));
  const out = lines.map(line => line.slice(Number.isFinite(indent) ? indent : 0));
  return out.length > QUOTE_MAX_LINES ? [...out.slice(0, QUOTE_MAX_LINES), `… ${out.length - QUOTE_MAX_LINES} more lines`] : out;
}

/* ---------- Store: comments per thread, kept until sent ---------- */

/** One key per thread: `pandacode.lineComments:<thread id>` → `{"t":savedAt,"comments":[…]}`. */
export const STORED_PREFIX = 'pandacode.lineComments:';
/** Untouched this long, a thread's stored comments are dropped, as composer drafts are. */
export const STORED_MAX_AGE = DRAFT_MAX_AGE;
/** Saved later than this past now (the clock ran ahead), they are dropped too, as drafts are. */
export const STORED_FUTURE_SLACK = DRAFT_FUTURE_SLACK;
/** A thread's comments larger than this (UTF-16 characters of JSON) stay for this launch only. */
export const STORED_MAX_CHARS = 200_000;
/** All threads' stored comments together (characters; 1 MB in UTF-16, like the drafts' budget): past
 * it the oldest threads' leave storage (they stay for this launch), so line comments never crowd out
 * composer drafts. WebKit allows about 5 MB of local storage an origin, shared by everything. */
export const STORED_BUDGET_CHARS = 500_000;

export type ReviewStorage = Store;

export type ReviewHost = {
  /** `isImeKey` from dom.ts: an Enter or Escape that commits an IME composition is not a command. */
  isImeKey(event: KeyboardEvent): boolean;
  /** Mac keyboards: the fields name Command-Return, not Control-Enter, as their save key. */
  mac?: boolean;
  /** Puts the comments into the shown thread's composer without sending it; false when it could not. */
  compose(prompt: string): boolean;
  /** Where unsent comments outlive the launch (local storage); without it they are kept in memory only. */
  storage?: ReviewStorage;
  /** Settings' Keep unsent drafts: off, nothing is written. */
  keep?(): boolean;
  now?(): number;
  /** Says a comment was deleted and offers to bring it back for a few seconds (the app's toast,
   * whose Undo also answers Cmd/Ctrl+Z); without it, the deletion is only announced. */
  undoable?(text: string, undo: () => void): void;
  /** How long typing rests before the text in comment fields is written to storage (ms, 500). */
  typingDelay?: number;
};

export type ReviewStore = ReturnType<typeof createReviewStore>;

const SIDES: readonly string[] = ['old', 'new', 'file'];
const isLine = (value: unknown): value is number => Number.isInteger(value) && (value as number) >= 1;
const strings = (value: unknown): value is string[] => Array.isArray(value) && value.every(item => typeof item === 'string');
/** Stored `dropped` lines: line numbers, at most a hunk's worth; anything else reads as none. */
const storedLines = (value: unknown): number[] | undefined => Array.isArray(value) && value.length > 0 && value.length <= 10_000 && value.every(isLine) ? [...value] : undefined;
/** A stored anchor: its text and context lines (arrays). */
function storedAnchor(value: unknown): ReviewAnchor | null {
  const a = value as { text?: unknown; before?: unknown; after?: unknown } | null;
  if (!a || typeof a !== 'object' || typeof a.text !== 'string' || !strings(a.before) || !strings(a.after)) return null;
  const unique = (value as { unique?: unknown }).unique;
  return { text: a.text, before: [...a.before], after: [...a.after], ...typeof unique === 'boolean' ? { unique } : {} };
}
/** A stored comment as written by this module; anything else (an unknown shape, a hand edit) is skipped. */
function storedComment(value: unknown, sessionId: string): ReviewComment | null {
  const c = value as Partial<ReviewComment> | null;
  if (!c || typeof c !== 'object' || typeof c.id !== 'string' || typeof c.file !== 'string' || !SIDES.includes(c.side as string)) return null;
  if (!isLine(c.startLine) || !isLine(c.endLine) || c.startLine > c.endLine || typeof c.text !== 'string' || !c.text.trim()) return null;
  const anchor = storedAnchor(c.anchor);
  if (!anchor) return null;
  const dropped = c.side === 'new' ? storedLines(c.dropped) : undefined;
  return {
    id: c.id, sessionId, file: c.file, side: c.side as ReviewSide, startLine: c.startLine, endLine: c.endLine, anchor,
    text: c.text.slice(0, MAX_COMMENT_LENGTH), status: c.status === 'outdated' ? 'outdated' : 'open',
    createdAt: typeof c.createdAt === 'number' ? c.createdAt : 0, ...dropped ? { dropped } : {},
  };
}

/** Where comments are written: a file's code preview in the Files view, or its diff in the Changes view. */
export type SurfaceKind = 'file' | 'diff';
/** A comment being written. `anchor` is taken when its lines are picked, so it follows them when the
 * content changes under it (placeDraft) and is saved against the code it was written on; `lost`:
 * its lines changed (`changed`), or a diff no longer shows them (`away`). `dropped`: deleted lines a
 * diff range between deleted and added lines left out (selectionSpan), which the field says. */
export type Draft = { side: ReviewSide; startLine: number; endLine: number; text: string; anchor: ReviewAnchor; lost?: 'changed' | 'away'; dropped?: number[] };
/** What a draft saved as a comment keeps besides its lines and text: Outdated when its lines changed
 * while it was written, and the deleted lines its range left out. */
export const draftExtras = (draft: Draft): Pick<NewReviewComment, 'status' | 'dropped'> => ({
  status: draft.lost === 'changed' ? 'outdated' : 'open', ...draft.dropped?.length ? { dropped: [...draft.dropped] } : {},
});

/**
 * The comments being written on one file of one thread, in its file view or its diff (the two are
 * separate sets: a file view's comments have side `file`, a diff's `old` or `new`). The store keeps
 * it, not the view: a view drawn again (a diff refetched while the agent edits the file, a file tab
 * re-rendered after a run or by Wrap) picks up the new comment and the edits in progress, text,
 * caret and focus, where the last one left them.
 */
export type CommentSurface = {
  readonly thread: string;
  readonly kind: SurfaceKind;
  readonly file: string;
  draft: Draft | null;
  /** Text typed into a comment's field and not saved yet (it saves on leaving), by comment id. */
  live: Map<string, string>;
  /** The newest field built for each comment id (`new` for the draft). */
  fields: Map<string, HTMLTextAreaElement>;
  /** The field with focus until the user leaves it; a field removed or moved by a repaint keeps it,
   * so the field drawn next can take focus back. */
  focused: HTMLTextAreaElement | null;
  /** Views drawing it (`retain`, `release`). With none and nothing unsaved, the store lets it go. */
  users: number;
  /** Comments the view's latest paint shows on their lines (found, not outdated or away). Send
   * quotes the code under every other comment (reviewPrompt). Emptied when the view goes. */
  shown: Set<string>;
};

/**
 * The comments of each thread, until they are sent. Like composer drafts (launch-restore.ts) they
 * are written to local storage at every change, one key per thread, so a restart or crash loses
 * none, except a New task's: its draft thread is discarded at restart, and its comments with it.
 * Text still being typed in a field (a new comment, an unsaved edit) is written too, half a second
 * after typing rests (`typing`), as the comment leaving that field would save, and comes back
 * saved. They go when sent, deleted or emptied, when their thread is deleted, when malformed, when
 * untouched for STORED_MAX_AGE or dated past STORED_FUTURE_SLACK (`expire()`, at launch and then as
 * drafts expire), and leave storage, oldest first, past STORED_BUDGET_CHARS. With Keep unsent
 * drafts off nothing is written.
 *
 * Reads and writes take the thread a view was drawn for (`thread`, by default the shown one), so a
 * field left during a thread switch saves into its own thread.
 */
export function createReviewStore(host: ReviewHost) {
  const threads = new Map<string, ReviewComment[]>();
  /** When each thread's comments in memory were last saved (read back, or changed). */
  const savedAt = new Map<string, number>();
  /** What storage holds, by thread: when it was saved and its size. Filled by the first scan. */
  const stored: StoredSizes = new Map();
  let scanned = false;
  const surfaces = new Map<string, CommentSurface>();
  /** Threads deleted this launch: a field left after its thread went (letGo saves a task later)
   * must not write the thread's comments back. */
  const gone = new Set<string>();
  /** The files open in each thread's file tabs (`openFiles`): a Files view comment on any other file
   * has no view to show it but the Changes view's group of comments shown nowhere else. */
  const tabs = new Map<string, Set<string>>();
  /** Threads whose fields' text waits to be written (`typing`). */
  const typingTimers = new Map<string, ReturnType<typeof setTimeout>>();
  const listeners = new Set<() => void>(), countListeners = new Set<() => void>();
  let sessionId = '', serial = 0;
  // Unique across launches: stored comments come back with their ids.
  const newId = () => `rc-${globalThis.crypto?.randomUUID?.() ?? `${Date.now().toString(36)}-${++serial}-${Math.random().toString(36).slice(2)}`}`;
  const now = () => host.now?.() ?? Date.now();
  const emit = () => { listeners.forEach(fn => fn()); countListeners.forEach(fn => fn()); };
  const keeping = () => host.keep?.() ?? true;
  const expired = (at: number) => expiredAt(at, now(), STORED_MAX_AGE, STORED_FUTURE_SLACK);
  const surfaceKey = (thread: string, kind: SurfaceKind, file: string) => `${thread}\0${kind}\0${file}`;

  /** Thread ids with comments in storage. */
  const storedIds = (): string[] => host.storage ? storedKeys(host.storage, STORED_PREFIX).map(key => key.slice(STORED_PREFIX.length)) : [];
  const getRaw = (id: string): string | null => host.storage ? safeRead(host.storage, STORED_PREFIX + id) : null;
  function unstore(id: string): void {
    stored.delete(id);
    if (host.storage) safeRemove(host.storage, STORED_PREFIX + id);
  }
  /** A stored entry, or null (and it is removed) when it is malformed, expired, or not to be kept. */
  function decode(id: string, raw: string | null): { t: number; comments: ReviewComment[] } | null {
    if (!raw) return null;
    try {
      const saved = JSON.parse(raw) as { t?: unknown; comments?: unknown };
      if (keeping() && typeof saved.t === 'number' && Number.isFinite(saved.t) && !expired(saved.t) && Array.isArray(saved.comments)) {
        const comments = saved.comments.map(c => storedComment(c, id)).filter((c): c is ReviewComment => Boolean(c));
        if (comments.length) return { t: saved.t, comments };
      }
    } catch { /* malformed: dropped below */ }
    unstore(id);
    return null;
  }
  /** The date a stored entry was saved, or undefined when it has none (malformed). Only the date is
   * read here; the comments are checked when their thread is read. */
  function dateOf(raw: string): number | undefined {
    try { const t = (JSON.parse(raw) as { t?: unknown }).t; return typeof t === 'number' && Number.isFinite(t) ? t : undefined; } catch { return undefined; }
  }
  /** Learns what storage holds (each thread's date and size), so writes keep to the budget; with
   * `sweep`, expired and malformed entries go (all of them with Keep unsent drafts off). */
  function scan(sweep = false): void {
    if (scanned && !sweep) return;
    scanned = true;
    stored.clear();
    for (const id of storedIds()) {
      const raw = getRaw(id), t = raw ? dateOf(raw) : undefined;
      if (t === undefined || (sweep && (!keeping() || expired(t)))) unstore(id);
      else stored.set(id, { t, size: raw!.length });
    }
  }
  function read(id: string): ReviewComment[] {
    const entry = decode(id, getRaw(id));
    if (!entry) return [];
    savedAt.set(id, entry.t);
    return entry.comments;
  }
  /** Moves a thread's comments out of storage, into memory for this launch. */
  const evict = (id: string) => { list(id); unstore(id); };
  /** What a thread's comments would be if every field were left now: unsaved edits saved, and new
   * comments holding text added. Storage keeps this, so typed text outlives a reload or a crash. */
  function leftNow(id: string): ReviewComment[] {
    const own = [...surfaces.values()].filter(surface => surface.thread === id), edits = new Map<string, string>(), added: ReviewComment[] = [];
    for (const surface of own) {
      for (const [commentId, text] of surface.live) if (text.trim()) edits.set(commentId, text.trim().slice(0, MAX_COMMENT_LENGTH));
      const draft = surface.draft;
      if (draft?.text.trim()) {
        const { side, startLine, endLine, anchor } = draft;
        added.push(make({ file: surface.file, side, startLine, endLine, anchor, text: draft.text.trim(), ...draftExtras(draft) }, id));
      }
    }
    return [...list(id).map(c => edits.has(c.id) ? { ...c, text: edits.get(c.id)! } : c), ...added];
  }
  function write(id: string): void {
    clearTimeout(typingTimers.get(id)); typingTimers.delete(id);
    if (!host.storage || !id || gone.has(id)) return;
    const comments = leftNow(id), t = now();
    savedAt.set(id, t);
    const json = comments.length && keeping() ? JSON.stringify({ t, comments: comments.map(({ sessionId: _, ...c }) => c) }) : '';
    if (!json || json.length > STORED_MAX_CHARS) { unstore(id); return; }
    scan();
    // Older threads' comments leave storage to make room, as older drafts do (stored-budget.ts).
    writeWithinBudget(host.storage, stored, { id, key: STORED_PREFIX + id, value: json, t, size: json.length }, STORED_BUDGET_CHARS, evict, error => console.warn('Could not save line comments:', error));
  }
  function list(id = sessionId): ReviewComment[] {
    if (id && !gone.has(id) && !threads.has(id)) threads.set(id, read(id));
    return threads.get(id) ?? [];
  }
  const set = (id: string, comments: ReviewComment[]) => { if (!id || gone.has(id)) return; threads.set(id, comments); write(id); };
  const patch = (id: string, update: ReviewUpdate) => {
    const { id: commentId, ...change } = update;
    if (change.text !== undefined) change.text = change.text.slice(0, MAX_COMMENT_LENGTH);
    set(id, list(id).map(c => c.id === commentId ? { ...c, ...Object.fromEntries(Object.entries(change).filter(([, value]) => value !== undefined)) } : c));
  };
  function make(comment: NewReviewComment, thread: string): ReviewComment { return { ...comment, text: comment.text.slice(0, MAX_COMMENT_LENGTH), id: newId(), sessionId: thread, status: comment.status ?? 'open', createdAt: now() }; }
  /** Drafts holding text in the shown thread's views. */
  const typedDrafts = () => [...surfaces.values()].filter(s => s.thread === sessionId && s.draft?.text.trim()).length;
  /** Comments whose field has been emptied and not left yet (leaving deletes them): Send leaves them
   * out and keeps them, so the field decides, with its Undo. */
  const emptied = (thread: string) => {
    const ids = new Set<string>();
    for (const surface of surfaces.values()) if (surface.thread === thread) for (const [id, text] of surface.live) if (!text.trim()) ids.add(id);
    return ids;
  };
  /** A surface nobody draws and with nothing unsaved goes, so its detached fields are not kept. */
  function prune(surface: CommentSurface): void {
    if (surface.users > 0 || surface.draft || surface.live.size || surface.focused) return;
    const key = surfaceKey(surface.thread, surface.kind, surface.file);
    if (surfaces.get(key) === surface) surfaces.delete(key);
  }

  return {
    get sessionId(): string { return sessionId; },
    /** Shows a thread's comments (read from storage the first time). */
    show(id: string | null | undefined): void {
      const next = id ?? '';
      if (next === sessionId) return;
      sessionId = next;
      emit();
    },
    /** Deleted threads take their comments with them, stored ones included; nothing written for them
     * later this launch (a field left after the thread went) is kept. */
    forget(ids: readonly string[]): void {
      for (const id of ids) {
        gone.add(id);
        threads.delete(id); savedAt.delete(id); tabs.delete(id);
        for (const [key, surface] of surfaces) if (surface.thread === id) surfaces.delete(key);
        unstore(id);
      }
      if (ids.includes(sessionId)) emit();
    },
    /** Thread ids with stored comments, for dropping those of threads deleted while the app was closed. */
    storedThreads: storedIds,
    /** Settings' Clear saved drafts, or Keep unsent drafts turned off: storage is emptied; the comments
     * stay for this launch. */
    clearStored(): void { for (const id of storedIds()) unstore(id); },
    /** Drops comments untouched for STORED_MAX_AGE, or dated past STORED_FUTURE_SLACK, from storage
     * and memory, and malformed entries (with Keep unsent drafts off, every entry). Run at launch,
     * then daily and when the window shows again (`expireDraftsWhileRunning`). */
    expire(): void {
      scan(true);
      let shown = false;
      for (const [id, at] of [...savedAt]) {
        if (!expired(at)) continue;
        threads.delete(id); savedAt.delete(id); unstore(id);
        if (id === sessionId) shown = true;
      }
      if (shown) emit();
    },
    all: (thread = sessionId): ReviewComment[] => list(thread),
    /** Whether a thread has comments, a new one holding text included (a New task with comments is
     * kept, as one with typed text is). */
    has: (thread: string): boolean => list(thread).length > 0 || [...surfaces.values()].some(s => s.thread === thread && Boolean(s.draft?.text.trim())),
    /** The file tabs open in a thread, told by the file tabs as they draw. Tells the listeners when
     * that changes the Files view comments that have a tab to show them. */
    openFiles(thread: string, files: Iterable<string>): void {
      const next = new Set(files), before = tabs.get(thread);
      if (gone.has(thread) || (before && before.size === next.size && [...next].every(file => before.has(file)))) return;
      tabs.set(thread, next);
      if (thread === sessionId && list(thread).some(c => c.side === 'file' && before?.has(c.file) !== next.has(c.file))) emit();
    },
    /** Whether `file` has a tab open in the thread's Files view. */
    fileOpen: (file: string, thread = sessionId): boolean => tabs.get(thread)?.has(file) ?? false,
    /** What Send would send in the shown thread: its comments (not those whose field was emptied and
     * not left) and the new ones holding text. */
    count: (): number => { const skip = emptied(sessionId); return list().filter(c => !skip.has(c.id)).length + typedDrafts(); },
    forFile: (file: string, sides: readonly ReviewSide[], thread = sessionId): ReviewComment[] => list(thread).filter(c => c.file === file && sides.includes(c.side)),
    /** The comments being written on `file` in one kind of view, the same object for every view drawn. */
    surface(kind: SurfaceKind, file: string, thread = sessionId): CommentSurface {
      const key = surfaceKey(thread, kind, file);
      let surface = surfaces.get(key);
      if (!surface) surfaces.set(key, surface = { thread, kind, file, draft: null, live: new Map(), fields: new Map(), focused: null, users: 0, shown: new Set() });
      return surface;
    },
    /** A view starts drawing `surface` (it is kept while drawn, and registered again if it was let go). */
    retain(surface: CommentSurface): void {
      surface.users++;
      const key = surfaceKey(surface.thread, surface.kind, surface.file);
      if (!surfaces.has(key)) surfaces.set(key, surface);
    },
    /** A view stops drawing `surface`: with no view and nothing unsaved, it goes. */
    release(surface: CommentSurface): void { surface.users = Math.max(0, surface.users - 1); prune(surface); },
    subscribe(fn: () => void): () => void { listeners.add(fn); return () => { listeners.delete(fn); }; },
    /** Like subscribe, and also told when a new comment's field gains or loses its text (`typed`). */
    watchCount(fn: () => void): () => void { countListeners.add(fn); return () => { countListeners.delete(fn); }; },
    /** A new comment's field went from empty to holding text, or back: the count changed. */
    typed(): void { countListeners.forEach(fn => fn()); },
    /** Text in one of a thread's fields changed (or a field holding text went): written to storage
     * once typing rests, so it outlives a reload or a crash. */
    typing(thread = sessionId): void {
      if (!host.storage || !thread || gone.has(thread)) return;
      clearTimeout(typingTimers.get(thread));
      typingTimers.set(thread, setTimeout(() => write(thread), host.typingDelay ?? 500));
    },
    /** Writes text waiting in fields now (the page is going away). */
    flushTyping(): void { for (const id of [...typingTimers.keys()]) write(id); },
    /** `beforeShow` runs just before the comment is painted, so the field that made it can step
     * aside in the same paint. */
    add(comment: NewReviewComment, options: { thread?: string; beforeShow?(): void } = {}): ReviewComment | null {
      const thread = options.thread ?? sessionId;
      if (!thread || gone.has(thread)) return null;
      const saved = make(comment, thread);
      options.beforeShow?.();
      set(thread, [...list(thread), saved]);
      emit();
      return saved;
    },
    update(update: ReviewUpdate, thread = sessionId): void { patch(thread, update); emit(); },
    remove(id: string, thread = sessionId): void { set(thread, list(thread).filter(c => c.id !== id)); emit(); },
    /** Brings back a deleted comment (Undo) at its place in the list; false when it could not (its
     * thread is gone, or it is already there). */
    restore(comment: ReviewComment, index: number, thread = sessionId): boolean {
      const current = list(thread);
      if (!thread || gone.has(thread) || current.some(c => c.id === comment.id)) return false;
      const next = [...current];
      next.splice(Math.max(0, Math.min(index, next.length)), 0, { ...comment, sessionId: thread });
      set(thread, next);
      emit();
      return true;
    },
    /** Relocations found while painting: remembered without a repaint (the paint that found them
     * already placed the comments there). */
    persist(updates: readonly ReviewUpdate[], thread = sessionId): void { updates.forEach(update => patch(thread, update)); },
    /**
     * Puts the comments in the composer and clears them; they stay when there is no composer.
     * Returns how many were sent (0 when none were). A comment whose field was emptied and not left
     * is neither sent nor deleted: it stays, and leaving its field deletes it with Undo as usual.
     */
    send(): number {
      const thread = sessionId;
      if (!thread) return 0;
      const own = [...surfaces.values()].filter(surface => surface.thread === thread);
      const skip = emptied(thread);
      for (const surface of own) {
        // An edit only in a field's live text (the field went without the blur that saves it, e.g.
        // removed by a thread switch; WebKit fires no blur on removal) is part of the comment.
        for (const [id, text] of surface.live) {
          const kept = text.trim();
          if (kept) { surface.live.delete(id); patch(thread, { id, text: kept }); }
        }
        // So is a new comment's text left in its field the same way: it is saved first. Its field's
        // copy goes before the write, which would otherwise store it twice (as `add` does).
        const draft = surface.draft;
        if (draft?.text.trim()) {
          const { side, startLine, endLine, anchor } = draft;
          const saved = make({ file: surface.file, side, startLine, endLine, anchor, text: draft.text.trim(), ...draftExtras(draft) }, thread);
          surface.draft = null;
          surface.focused = null;
          set(thread, [...list(thread), saved]);
          if (!draft.lost && surface.users) surface.shown.add(saved.id);
        }
      }
      const sending = list(thread).filter(c => !skip.has(c.id));
      const prompt = reviewPrompt(sending, c => own.some(surface => surface.users > 0 && surface.shown.has(c.id)));
      if (!prompt || !host.compose(prompt)) { emit(); return 0; }
      set(thread, list(thread).filter(c => skip.has(c.id)));
      emit();
      // The views have dropped the sent comments' fields: they are not kept.
      for (const surface of own) {
        for (const [id, field] of surface.fields) if (!field.isConnected) surface.fields.delete(id);
        if (surface.focused && !surface.focused.isConnected) surface.focused = null;
        prune(surface);
      }
      return sending.length;
    },
    host,
  };
}

/* ---------- Loaded at startup: the announcer and the Send button ---------- */

let announcer: HTMLElement | null = null;
/** Says what just happened (a comment added or deleted, comments sent) through one polite live region. */
export function announce(text: string): void {
  if (typeof document === 'undefined') return;
  if (!announcer?.isConnected) {
    announcer = document.createElement('div');
    announcer.className = 'rc-announcer';
    announcer.setAttribute('role', 'status');
    announcer.setAttribute('aria-live', 'polite');
    document.body.append(announcer);
  }
  const region = announcer;
  // Emptied first, so the same words twice in a row are read twice.
  region.textContent = '';
  setTimeout(() => { region.textContent = text; }, 30);
}

/** The header button that sends the thread's comments, shown while there are any (a new comment
 * holding text counts); it updates itself and stops when its element leaves the page. `glyph` is the
 * icon (a speech bubble, for comments) shown with the count in a narrow header. */
export function mountSendButton(button: HTMLButtonElement, store: ReviewStore, glyph = ''): () => void {
  button.type = 'button';
  button.classList.add('rc-send');
  // "Send N comments" where the header has room; a narrower one shows "Send", the icon and the
  // count, and a narrow one the icon and the count (review-send.css), so the header's own controls
  // keep their labels. The name and tooltip
  // always say all of it. The text is updated in place: pressing the button from a comment field
  // saves that comment between mousedown and mouseup, and a replaced element there would swallow
  // the click.
  // (The count is the button's `data-count`, drawn by CSS only in the narrow form.)
  const text = document.createElement('span'), verb = document.createElement('span'), rest = document.createElement('span');
  text.className = 'rc-send-label';
  verb.className = 'rc-send-verb'; verb.textContent = 'Send';
  rest.className = 'rc-send-rest';
  text.append(verb, rest);
  button.innerHTML = glyph;
  button.append(text);
  const paint = () => {
    if (!button.isConnected) { stop(); return; }
    const count = store.count();
    // Shown only while the thread has comments, so it takes no header space otherwise.
    button.hidden = !count;
    if (!count) return;
    const label = `Send ${plural(count, 'comment')}`, name = `${label} to agent`;
    const more = label.slice('Send'.length);
    if (rest.textContent !== more) rest.textContent = more;
    button.dataset.count = String(count);
    button.setAttribute('aria-label', name);
    button.title = `${name}: add them to the message in the composer`;
  };
  // Pressing it from a comment field leaves the field first, which saves it, so it is included.
  const click = () => {
    const sent = store.send();
    if (sent) announce(`${plural(sent, 'comment')} added to the message`);
  };
  button.addEventListener('click', click);
  const unsubscribe = store.watchCount(paint);
  const stop = () => { unsubscribe(); button.removeEventListener('click', click); };
  paint();
  return stop;
}

/** The comments of a thread (the shown one by default) that no view shows: diff comments on files the Changes list
 * does not show as a diff (`listed`), and Files view comments on files with no tab open. The Changes
 * view lists them in a group of their own. */
export const unshownComments = (store: ReviewStore, listed: (file: string) => boolean, thread = store.sessionId): ReviewComment[] =>
  store.all(thread).filter(c => c.side === 'file' ? !store.fileOpen(c.file, thread) : !listed(c.file));

/* ---------- The inline UI, loaded on first use ---------- */

type ReviewUi = typeof import('./review-comments-ui');
let ui: ReviewUi | undefined, loading: Promise<ReviewUi> | undefined;
/** The inline UI (comment fields, line numbers, the diff's hooks) and its CSS, loaded the first time
 * a view takes comments. */
export function reviewUi(): Promise<ReviewUi> {
  loading ??= import('./review-comments-ui').then(module => (ui = module), error => { loading = undefined; throw error; });
  return loading;
}
/** The inline UI if it has loaded, so a view drawn again adds its comments in the same paint. */
export const reviewUiNow = (): ReviewUi | undefined => ui;

type ReviewDiffUi = typeof import('./review-comments-diff');
let diffUi: ReviewDiffUi | undefined, diffLoading: Promise<ReviewDiffUi> | undefined;
/** A Changes diff's line comments (review-comments-diff.ts, which loads the inline UI with it),
 * loaded with the first diff shown with a thread. The diff does not wait for it: its hooks attach
 * when it arrives (`reviewDiffUiNow` gives them at once after that). */
export function reviewDiffUi(): Promise<ReviewDiffUi> {
  diffLoading ??= import('./review-comments-diff').then(module => { void reviewUi(); return (diffUi = module); }, error => { diffLoading = undefined; throw error; });
  return diffLoading;
}
/** A Changes diff's line comments if they have loaded, so a diff mounted after that has them at once. */
export const reviewDiffUiNow = (): ReviewDiffUi | undefined => diffUi;
