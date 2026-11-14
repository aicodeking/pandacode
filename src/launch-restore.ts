/* What a launch restores after any exit, clean or abrupt (a crash restart included): composer
 * drafts per task and the thread that was open. Local storage only.
 *
 * Drafts: one key per task (`pandacode.draft:<id>` → `{"t":savedAt,"text":…}`), so a keystroke
 * rewrites only its own draft. A New task (a native draft session, discarded at the next launch
 * while it has no messages) keeps its text under one key per project instead
 * (`pandacode.draft:new:<project id>`), which the next New task in that project takes over. A shared
 * bot channel's composer text is kept the same way under `pandacode.draft:channel:<channel id>`.
 * Every change is written at once (a draft is at most MAX_DRAFT_CHARS, so a write stays cheap), and
 * so is removing one (sending it, clearing it): a crash loses no keystroke and never brings a sent
 * prompt back. A draft is dropped only when
 * it is older than DRAFT_MAX_AGE or dated more than a day ahead (at launch, then daily and when the window shows again),
 * malformed, too large, pushed out by DRAFTS_BYTE_BUDGET (oldest first; a full store drops more
 * and retries once), or its thread is deleted (also while the app was closed: `dropDeletedDrafts`); a project's New task
 * text goes when the project is removed in the window, or at the next boot whose project list lacks it (`dropRemovedProjectDrafts`);
 * a channel's text when it is sent, or once a launch's channel list lacks it (`dropRemovedChannelDrafts`). Dropped drafts stay in memory for the running launch.
 * With Settings' Keep unsent drafts off (KEEP_DRAFTS_KEY) nothing is written and every stored
 * draft goes, at once and at each launch; text already typed stays in memory for the running launch.
 *
 * Open thread: remembered once its messages have loaded (a New task as its project). Every thread
 * opened (by boot or the user) is marked until its messages have painted (or, in a window that
 * paints nothing, PAINT_WAIT after they rendered or once it is hidden); a failed or superseded
 * load clears its own mark, and an orderly exit (`leavePage`) clears any; a mark still there at the next boot, when that boot follows a crash,
 * means opening that thread may have taken the app down, so boot opens the thread that was open
 * before it (kept with the mark) or, when that is gone or archived, the newest one, and forgets both. After repeated crashes (restarts paused) boot opens no thread by itself.
 *
 * Window deaths: a first reload after the window's content died (often macOS ending it under memory
 * pressure) holds back only the marked thread; with no mark the remembered thread reopens as usual.
 * Either is noted in `pandacode.windowDied` until the page has lived
 * WINDOW_STABLE_AFTER or closes in an orderly way. A boot that finds the note (the window died
 * again: another reload, or the launch after the native dialog's Restart PandaCode) opens no
 * thread by itself and names the noted one. */

import { expiredAt, safeRead, safeRemove, storedKeys, writeWithinBudget, type Store, type StoredSizes } from './stored-budget.ts';

export type { Store };
type Schedule = (run: () => void, ms: number) => unknown;

export const DRAFT_PREFIX = 'pandacode.draft:';
/** 'off' when Settings' Keep unsent drafts is off; absent (on, the default) otherwise. */
export const KEEP_DRAFTS_KEY = 'pandacode.keepDrafts';
export const OPEN_THREAD_KEY = 'pandacode.openThread';
/** Set when the open thread at exit was a New task (its draft session does not outlive the launch);
 * its project is the saved current project, which follows a New task moved to another project. */
export const OPEN_NEW_TASK_KEY = 'pandacode.openNewTask';
/** Drafts key prefix (after DRAFT_PREFIX) of a project's New task text. */
export const NEW_TASK_DRAFT = 'new:';
/** Drafts key prefix (after DRAFT_PREFIX) of a shared bot channel's composer text. */
export const CHANNEL_DRAFT = 'channel:';
/** The drafts key of a shared channel's composer text. */
export const channelDraftKey = (channelId: string): string => CHANNEL_DRAFT + channelId;
export const RESTORING_KEY = 'pandacode.restoringThread';
/** The thread remembered as open when the marked one began to open (absent when it is the same),
 * kept and cleared with the mark: boot reopens it when the marked thread is held back. */
export const PREVIOUS_THREAD_KEY = 'pandacode.restoringPrevious';
/** Written at load, cleared on pagehide: still there at a reload means the window's content died. */
export const PAGE_ALIVE_KEY = 'pandacode.pageAlive';
/** The thread suspected when the window's content died ('' when none), kept until the page proves
 * stable (`windowStable`) or closes in an orderly way; see `threadToReopen`. */
export const WINDOW_DIED_KEY = 'pandacode.windowDied';
/** A page that has lived this long is past the native reload budget (60 s, crash_guard/webview.rs). */
export const WINDOW_STABLE_AFTER = 90_000;
/** A larger draft stays for this launch only. */
export const MAX_DRAFT_CHARS = 50_000;
/** Drafts untouched this long are dropped (at launch, daily, and when the window shows again). */
export const DRAFT_MAX_AGE = 30 * 24 * 60 * 60 * 1000;
/** A draft saved later than this past now (the clock ran ahead) is dropped too, or it would outlive DRAFT_MAX_AGE. */
export const DRAFT_FUTURE_SLACK = 24 * 60 * 60 * 1000;
/** Stored drafts in total (UTF-16, two bytes a character); WebKit allows about 5 MB an origin, shared by everything. */
export const DRAFTS_BYTE_BUDGET = 1_000_000;
/** How often a running app drops expired drafts, besides when its window shows again. */
export const EXPIRE_EVERY = 24 * 60 * 60 * 1000;

const bytes = (text: string) => text.length * 2;
const keep = (text: string) => Boolean(text.trim()) && text.length <= MAX_DRAFT_CHARS;


/** One stored draft, or null when it is malformed. */
export function decodeDraft(raw: string | null): { t: number; text: string } | null {
  if (!raw) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== 'object') return null;
    const { t, text } = value as Record<string, unknown>;
    return typeof t === 'number' && Number.isFinite(t) && typeof text === 'string' ? { t, text } : null;
  } catch { return null; }
}

/** The drafts map, written through to storage (see the file comment). `newTaskKey` names the
 * project key (`new:<project id>`) of a task that is a New task, undefined for any other task. */
export class PersistedDrafts extends Map<string, string> {
  newTaskKey: (id: string) => string | undefined = () => undefined;
  private readonly savedAt = new Map<string, number>();
  /** Bytes of each draft as stored, and when it was saved; absent when it is not in storage. */
  private readonly stored: StoredSizes = new Map();
  /** A New task's id → the project key it is stored under (the latest one typed in owns the key). */
  private readonly claimed = new Map<string, string>();
  private loaded = false;
  private keeping: boolean;
  private readonly store: Store;
  private readonly now: () => number;

  constructor(store: Store, now: () => number = Date.now) {
    super();
    this.store = store; this.now = now;
    this.keeping = safeRead(store, KEEP_DRAFTS_KEY) !== 'off';
    for (const key of storedKeys(store, DRAFT_PREFIX)) {
      if (!this.keeping) { safeRemove(store, key); continue; }
      const draft = decodeDraft(safeRead(store, key)), id = key.slice(DRAFT_PREFIX.length);
      if (!id || id === NEW_TASK_DRAFT || id === CHANNEL_DRAFT || !draft || this.expired(draft.t) || !keep(draft.text)) { safeRemove(store, key); continue; }
      super.set(id, draft.text); this.savedAt.set(id, draft.t); this.stored.set(id, { t: draft.t, size: bytes(draft.text) });
    }
    this.loaded = true;
  }

  /** A New task with no text of its own takes over its project's kept text. */
  override get(id: string): string | undefined { return super.get(id) ?? this.adopt(id); }

  override set(id: string, text: string): this {
    if (!this.loaded) return super.set(id, text);
    this.claim(id);
    if (super.get(id) === text) return this;
    super.set(id, text);
    this.savedAt.set(id, this.now());
    if (keep(text)) this.write(id); else this.unstore(id);
    return this;
  }
  override delete(id: string): boolean {
    this.savedAt.delete(id);
    this.unstore(id);
    this.claimed.delete(id);
    return super.delete(id);
  }
  override clear(): void { for (const id of [...this.keys()]) this.delete(id); }

  /** Settings' Clear saved drafts: removes every stored draft (thread, New task and channel text,
   * also any this launch never loaded) and drops them from memory, except `keep`'s: the text shown
   * in an open composer stays on screen, unstored until its next change. */
  clearStored(keep: (id: string) => boolean = () => false): void {
    for (const key of storedKeys(this.store, DRAFT_PREFIX)) safeRemove(this.store, key);
    this.stored.clear(); this.claimed.clear();
    for (const id of [...this.keys()]) if (!keep(id)) { super.delete(id); this.savedAt.delete(id); }
  }

  /** Whether drafts are written to storage (Settings' Keep unsent drafts). */
  get keepsDrafts(): boolean { return this.keeping; }

  /** Settings' Keep unsent drafts. Off: every stored draft goes at once (`clearStored`), all text
   * stays in memory for this launch, and nothing is written. On again: each draft is stored from its next change. */
  setKeeping(on: boolean): void {
    this.keeping = on;
    try { if (on) this.store.removeItem(KEEP_DRAFTS_KEY); else this.store.setItem(KEEP_DRAFTS_KEY, 'off'); }
    catch (error) { console.warn('Could not save the Keep unsent drafts setting:', error); }
    if (!on) this.clearStored(() => true);
  }

  /** Drops drafts untouched for DRAFT_MAX_AGE, or dated more than DRAFT_FUTURE_SLACK ahead, from storage and memory. */
  expire(): void {
    for (const [id, at] of [...this.savedAt]) if (this.expired(at)) this.delete(id);
  }

  private expired(at: number): boolean { return expiredAt(at, this.now(), DRAFT_MAX_AGE, DRAFT_FUTURE_SLACK); }

  private keyOf(id: string): string { return DRAFT_PREFIX + (this.claimed.get(id) ?? id); }

  /** Moves the project's kept text (loaded, not yet taken) to this New task. */
  private adopt(id: string): string | undefined {
    const key = this.newTaskKey(id), text = key === undefined ? undefined : super.get(key);
    if (key === undefined || text === undefined) return undefined;
    super.set(id, text); this.savedAt.set(id, this.savedAt.get(key) ?? this.now());
    const size = this.stored.get(key);
    if (size !== undefined) this.stored.set(id, { ...size });
    super.delete(key); this.savedAt.delete(key); this.stored.delete(key);
    this.claimed.set(id, key);
    return text;
  }

  /** The task's New task state may have changed (a delivered queued message published it, or a
   * failed first send left it a New task again): its text follows, as on its next keystroke. */
  reclaim(id: string): void { if (this.loaded) this.claim(id); }

  /** `reclaim` for every thread draft: call after the session list (or a task's draft flag) changed. */
  reclaimAll(): void {
    for (const id of [...this.keys()]) if (!id.startsWith(NEW_TASK_DRAFT) && !id.startsWith(CHANNEL_DRAFT)) this.reclaim(id);
  }

  /** A New task typed in owns its project's key; one that owned it before keeps its text in memory
   * only. A task that stopped being a New task (published) drops the project key and keeps its
   * text under its own id, and one that became a New task again (its first send failed) moves its
   * text back to the project key. `rewrite`: write the moved text (false when a write is under way). */
  private claim(id: string, rewrite = true): void {
    const key = this.newTaskKey(id), previous = this.claimed.get(id);
    if (previous === key) return;
    const moved = this.stored.has(id);
    safeRemove(this.store, DRAFT_PREFIX + (previous ?? id)); this.stored.delete(id);
    if (key === undefined) this.claimed.delete(id);
    else {
      if (super.has(key)) { super.delete(key); this.savedAt.delete(key); this.stored.delete(key); }
      for (const [other, owned] of this.claimed) if (owned === key) { this.claimed.delete(other); this.stored.delete(other); }
      this.claimed.set(id, key);
    }
    // Moved to another project, published, or a New task again: its text moves to the new key.
    if (rewrite && (previous !== undefined || moved) && super.has(id)) this.write(id);
  }

  private unstore(id: string): void {
    this.stored.delete(id);
    safeRemove(this.store, this.keyOf(id));
  }

  private write(id: string): void {
    // Its New task state may have changed since the change was typed.
    this.claim(id, false);
    if (!this.keeping) return;
    const text = super.get(id);
    if (text === undefined || !keep(text)) { this.unstore(id); return; }
    const t = this.savedAt.get(id) ?? this.now();
    this.stored.delete(id);
    // Older drafts leave storage (they stay in memory) to make room; a full store drops the older
    // half of what is stored and tries once more (stored-budget.ts).
    writeWithinBudget(this.store, this.stored, { id, key: this.keyOf(id), value: JSON.stringify({ t, text }), t, size: bytes(text) }, DRAFTS_BYTE_BUDGET,
      other => { this.stored.delete(other); safeRemove(this.store, this.keyOf(other)); },
      error => console.warn('Could not keep a composer draft:', error));
  }
}

/** Most ids `sessions_missing` takes in one call, and the longest id it accepts. */
export const MISSING_BATCH = 2000, MAX_SESSION_ID = 128;

/** The thread ids with a draft (not a project's New task text or a channel's), in batches for `sessions_missing`;
 * an id the command would refuse is left out rather than failing its whole batch. */
export function draftThreadBatches(ids: Iterable<string>): string[][] {
  const threads = [...ids].filter(id => id && id.length <= MAX_SESSION_ID && !id.startsWith(NEW_TASK_DRAFT) && !id.startsWith(CHANNEL_DRAFT));
  return Array.from({ length: Math.ceil(threads.length / MISSING_BATCH) }, (_, index) => threads.slice(index * MISSING_BATCH, (index + 1) * MISSING_BATCH));
}

/** At boot, after the task list: drops the drafts of threads deleted while the app was closed
 * (`missing` returns the asked ids that have no session at all). A failing check is logged once
 * and changes nothing more. */
export async function dropDeletedDrafts(drafts: { keys(): Iterable<string>; delete(id: string): unknown }, missing: (ids: string[]) => Promise<unknown>): Promise<void> {
  for (const batch of draftThreadBatches(drafts.keys())) {
    let gone: unknown;
    try { gone = await missing(batch); } catch (error) { console.warn('Could not check for drafts of deleted threads:', error); return; }
    if (!Array.isArray(gone)) { console.warn('Could not check for drafts of deleted threads: unexpected answer', gone); return; }
    const asked = new Set(batch);
    for (const id of gone) if (typeof id === 'string' && asked.has(id)) drafts.delete(id);
  }
}

/** At boot, once `list_projects` has answered (never after a failed load): drops the New task text
 * of projects that no longer exist, such as one removed by another window or a remote client. */
export function dropRemovedProjectDrafts(drafts: Pick<Map<string, string>, 'keys' | 'delete'>, projectIds: readonly string[]): void {
  const live = new Set(projectIds);
  for (const id of [...drafts.keys()]) if (id.startsWith(NEW_TASK_DRAFT) && !live.has(id.slice(NEW_TASK_DRAFT.length))) drafts.delete(id);
}

/** Once a launch, after `bot_shared_channels` has answered (never after a failed load; the list
 * includes archived channels): drops the composer text of channels that no longer exist. */
export function dropRemovedChannelDrafts(drafts: Pick<Map<string, string>, 'keys' | 'delete'>, channelIds: readonly string[]): void {
  const live = new Set(channelIds);
  for (const id of [...drafts.keys()]) if (id.startsWith(CHANNEL_DRAFT) && !live.has(id.slice(CHANNEL_DRAFT.length))) drafts.delete(id);
}

/** Drops expired drafts while the app runs: once a day and whenever the window shows again. */
export function expireDraftsWhileRunning(drafts: Pick<PersistedDrafts, 'expire'>, doc: Pick<Document, 'addEventListener' | 'visibilityState'> = document): void {
  setInterval(() => drafts.expire(), EXPIRE_EVERY);
  doc.addEventListener('visibilitychange', () => { if (doc.visibilityState === 'visible') drafts.expire(); });
}

/** Remembers the open thread; an empty id forgets it (nothing selected). `newTask`: the thread is
 * a New task, which the next launch opens again (in the saved project) unless it was sent. */
export function rememberOpenThread(store: Pick<Store, 'setItem' | 'removeItem'>, id: string, newTask = false): void {
  try {
    if (id) store.setItem(OPEN_THREAD_KEY, id); else store.removeItem(OPEN_THREAD_KEY);
    if (id && newTask) store.setItem(OPEN_NEW_TASK_KEY, '1'); else store.removeItem(OPEN_NEW_TASK_KEY);
  } catch { /* this launch only */ }
}

/** What boot knows about how the last run ended. */
export interface LaunchAfter {
  /** This launch follows a crash (a crash notice). */
  crashed: boolean;
  /** Restarts were paused after repeated crashes. */
  paused: boolean;
  /** This page is a reload after the window's content died (`windowContentDied`). */
  windowDied?: boolean;
}

/** What boot opens: `task`, the remembered thread; `newTask`, the saved project's New task (it was
 * open; its draft session is gone, its text kept); `stuck`, a thread boot must not open;
 * `fallback`, whether boot may open the project's newest thread when there is neither (also
 * with `newTask`, for when its project no longer exists);
 * `windowDiedAgain`, the window's content died a second time before it proved stable;
 * `stuckNotLast`, the stuck thread is not the user's last place (the New task reopened is). */
export interface Reopen<T> { task?: T; newTask?: true; stuck?: string; stuckNotLast?: true; fallback: boolean; windowDiedAgain?: true }

/** At boot: the thread open at the last exit (`task`), unless it is archived or gone, or this
 * launch follows a crash that may be that thread's fault. A restoring mark only counts after a
 * crash: a quit during the last launch's thread restore leaves one too, and is just cleared. After
 * a crash the marked thread is `stuck`, boot must not open it again, and the keys are forgotten.
 * A first reload after the window's content died holds back only the marked thread too: a single
 * death is usually harmless, so the remembered one reopens. It notes the mark or, with none, the
 * remembered thread in WINDOW_DIED_KEY. A boot that
 * finds that note opens nothing by itself, like paused restarts (any thread may be the one), and
 * suspects the noted thread; a boot that is not such a reload (the launch after the native
 * dialog's Restart PandaCode) honours the note once and removes it.
 * When restarts are paused boot opens nothing by itself; the suspect is the marked thread or,
 * with no mark (the crash came after the thread loaded), the remembered one, so the notice can
 * name it. An unsent New task open at exit is the exception in every case: it has no transcript,
 * so its project's New task page reopens with the kept text (`newTask`), and stays remembered. */
export function threadToReopen<T extends { id: string; archived: boolean }>(store: Pick<Store, 'getItem' | 'setItem' | 'removeItem'>, tasks: readonly T[], launch: LaunchAfter): Reopen<T> {
  const mark = safeRead(store, RESTORING_KEY) || undefined;
  const previous = safeRead(store, PREVIOUS_THREAD_KEY) || undefined;
  safeRemove(store, PREVIOUS_THREAD_KEY);
  const id = safeRead(store, OPEN_THREAD_KEY) || undefined;
  const newTask = Boolean(safeRead(store, OPEN_NEW_TASK_KEY));
  const noted = safeRead(store, WINDOW_DIED_KEY);
  const windowDied = launch.windowDied ?? false, again = noted !== null;
  if (mark) safeRemove(store, RESTORING_KEY);
  if (again && !windowDied) safeRemove(store, WINDOW_DIED_KEY);
  // A New task that was sent since is an ordinary thread now and reopens as one; an unsent one
  // (an empty draft session, no transcript) is no crash suspect, so its page and kept text come back
  // even when boot holds threads back.
  const unsentNewTask = newTask && Boolean(id) && !tasks.some(item => item.id === id);
  const remembered = unsentNewTask ? undefined : id;
  const closed = launch.paused || again;
  const stuck = closed ? noted || mark || remembered
    : windowDied || launch.crashed ? mark : undefined;
  if (windowDied && !again) { try { store.setItem(WINDOW_DIED_KEY, mark ?? remembered ?? ''); } catch { /* this launch only */ } }
  if (closed || stuck) {
    const suspect = unsentNewTask && stuck === id ? undefined : stuck;
    if (unsentNewTask) {
      // `fallback` is for a New task whose project is gone: as for any thread, unless boot holds all back.
      const reopen: Reopen<T> = suspect ? { newTask: true, stuck: suspect, stuckNotLast: true, fallback: !closed } : { newTask: true, stuck: suspect, fallback: !closed };
      return again ? { ...reopen, windowDiedAgain: true } : reopen;
    }
    safeRemove(store, OPEN_THREAD_KEY); safeRemove(store, OPEN_NEW_TASK_KEY);
    if (again) return { stuck, fallback: false, windowDiedAgain: true };
    // The marked thread is held back: the one open before it comes back instead of the newest.
    const back = !closed && previous && previous !== stuck ? tasks.find(item => item.id === previous && !item.archived) : undefined;
    return back ? { task: back, stuck, fallback: true } : { stuck, fallback: !closed };
  }
  const task = id ? tasks.find(item => item.id === id && !item.archived) : undefined;
  if (unsentNewTask) return { newTask: true, fallback: true };
  return { task, fallback: true };
}

/** The page was reloaded (not a fresh launch). */
export function reloadedPage(): boolean {
  const entry = globalThis.performance?.getEntriesByType?.('navigation')[0] as PerformanceNavigationTiming | undefined;
  return entry?.type === 'reload';
}

/** Once, at load: whether this page reloads a window whose content died (the last page's alive
 * mark survived, so it never reached pagehide), then marks this page alive until `pageClosed`. A
 * fresh launch after a quit or crash is not a reload; an orderly reload ran pagehide. */
export function windowContentDied(store: Pick<Store, 'getItem' | 'setItem'>, reloaded = reloadedPage()): boolean {
  const died = reloaded && safeRead(store, PAGE_ALIVE_KEY) !== null;
  try { store.setItem(PAGE_ALIVE_KEY, '1'); } catch { /* this launch only */ }
  return died;
}

/** The page is going away in an orderly way, so its window did not die (see leavePage). */
export function pageClosed(store: Pick<Store, 'removeItem'>): void { safeRemove(store, PAGE_ALIVE_KEY); safeRemove(store, WINDOW_DIED_KEY); }

/** The page has lived WINDOW_STABLE_AFTER: an earlier window death is no longer held against a thread. */
export function windowStable(store: Pick<Store, 'removeItem'>): void { safeRemove(store, WINDOW_DIED_KEY); }

/** A thread is about to open; until finishThreadRestore, a crash leaves it marked stuck. The thread
 * remembered as open until now is kept beside the mark, for boot to reopen instead. */
export function beginThreadRestore(store: Pick<Store, 'getItem' | 'setItem' | 'removeItem'>, id: string): void {
  const previous = safeRead(store, OPEN_THREAD_KEY);
  try {
    if (previous && previous !== id) store.setItem(PREVIOUS_THREAD_KEY, previous); else store.removeItem(PREVIOUS_THREAD_KEY);
    store.setItem(RESTORING_KEY, id);
  } catch { /* this launch only */ }
}

/** The thread `id` painted, failed to open without taking the app down, or was superseded: its mark
 * goes, and a later thread's mark stays. Without `id` (the page is going away) any mark goes. */
export function finishThreadRestore(store: Pick<Store, 'getItem' | 'removeItem'>, id?: string): void {
  if (id === undefined || safeRead(store, RESTORING_KEY) === id) { safeRemove(store, RESTORING_KEY); safeRemove(store, PREVIOUS_THREAD_KEY); }
}

/** The page is going away in an orderly way: pagehide, or the native `app-quitting` event once a
 * deliberate exit is committed (WKWebView may not fire pagehide on Cmd+Q). No thread is being
 * opened and the window did not die (drafts need nothing: each change is written at once). */
export function leavePage(store: Pick<Store, 'getItem' | 'removeItem'>): void {
  finishThreadRestore(store); pageClosed(store);
}

type Frame = (run: () => void) => unknown;
type PaintDocument = Pick<Document, 'addEventListener' | 'removeEventListener' | 'visibilityState'>;
/** A rendered thread's mark goes after this long even without a paint (a covered or minimised
 * window may run no animation frames), so a later, unrelated crash does not hold it back. */
export const PAINT_WAIT = 5000;

/** The thread `id` rendered: its mark goes once that has been laid out and painted (the second
 * animation frame from here), so a transcript that takes the app down while painting stays marked;
 * a thread opened meanwhile keeps its own. A window that paints nothing (covered, minimised, hidden)
 * clears it after PAINT_WAIT, or as soon as the document becomes hidden, whichever comes first. */
export function finishThreadRestoreAfterPaint(store: Pick<Store, 'getItem' | 'removeItem'>, id: string, frame: Frame = run => requestAnimationFrame(run), wait: Schedule = (run, ms) => setTimeout(run, ms), cancel: (handle: unknown) => void = handle => clearTimeout(handle as ReturnType<typeof setTimeout>), doc: PaintDocument = document): void {
  let done = false;
  const finish = () => {
    if (done) return;
    done = true; cancel(timer); doc.removeEventListener('visibilitychange', hidden);
    finishThreadRestore(store, id);
  };
  const hidden = () => { if (doc.visibilityState === 'hidden') finish(); };
  const timer = wait(finish, PAINT_WAIT);
  doc.addEventListener('visibilitychange', hidden);
  frame(() => frame(finish));
}
