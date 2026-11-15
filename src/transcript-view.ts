/* The main transcript's window (transcript-rows.ts, transcript-window.ts), and the tiles' (mountTileWindows): what it has drawn, and the steps that widen
 * it (the reader nearing the top, Find, a fetched page joining) and narrow it (a return to the bottom). What a row holds
 * (turn cards, folds, notes, workers) stays with main.ts, which supplies it through TranscriptViewHost. */
import { captureTranscriptAnchor } from './transcript-scroll';
import { MIN_TRIM_MESSAGES, MIN_TRIM_TURNS, MORE_TURNS, ROWS_MARGIN, ROW_BUDGET, drawRows, joinIndex, parseRow, rowsIntact, swapRowNodes, trimCount, turnWeight, windowAnchor, windowShort, windowStart, type DrawnRow, type TurnIds } from './transcript-rows';
import { markdownCache } from './dom';
import { FIND_REFRESH } from './thread-find';
import { drawnFrom, emptyWindow, prepareMarkdown, firstRowNode, holdPlace, insertRowsAbove, rowTops, skipFarRows, stepFrom, stepWhenFormatted, takeTrimmed, trimWindow, type RowsWindow } from './transcript-window';

type Formattable = { role: string; content: string } | undefined;

export interface TranscriptViewHost<Turn, Views> {
  scroller: HTMLElement;
  /** The open thread. */
  openId(): string;
  /** Whether the open thread draws whole (a bot thread: bot-thread.ts decorates across all of its rows). */
  drawsWhole(): boolean;
  /** Whether the transcript shows something other than its thread (a shared channel keeps the thread open). */
  elsewhere(): boolean;
  visible(): boolean;
  /** A thread's saved turns as drawn (a live card's exchange left out). */
  savedTurns(sessionId: string): Turn[];
  turnIds(turn: Turn): string[];
  /** The messages of `turns` whose Markdown is formatted before they draw (`all`: long folded replies too). */
  messagesOf(turns: readonly Turn[], all?: boolean): readonly Formattable[];
  /** A saved turn's markup for `sessionId`, from the markup cache when it holds (computes its inputs once). */
  markup(sessionId: string): (turn: Turn) => string;
  /** What the reader set in a row, or undefined when they never touched it. */
  captureViews(row: DrawnRow): Views | undefined;
  restoreViews(row: DrawnRow, views: Views): void;
  /** Formats rows parsed into `fragment` and puts back the open notes in `back`; answers which nodes replaced which. */
  prepare(fragment: DocumentFragment, back: readonly (Views | undefined)[]): Map<ChildNode, ChildNode>;
  /** Redraws one row in place, keeping its folds and formatted text; its replies are left for `watch`. */
  redrawRow(row: DrawnRow, html: string): DrawnRow;
  /** Rows came or went: workers (and, unless `workersOnly`, threads cards) drawn into rows after the fact catch up. */
  rowsChanged(workersOnly?: boolean): void;
  /** Measures new replies (ones `defer` names are left to their observer) and answers the writes that clamp them, to
   *  run after the step's own reads, and how much those writes change the rows' height (turn-card.ts measureReplies). */
  watch(nodes: readonly Node[], defer: (node: Node) => boolean): { apply(): void; shift: number };
  /** The reader's scroll position after a step held their place. */
  placed(top: number): void;
  /** Whatever keeps a trim off right now (not at the bottom, a tail bridging, Find open). */
  trimBlocked(): boolean;
  findInput(): HTMLInputElement | null;
  /** How many matches Find would find in a turn once drawn, counted in memory (main.ts findCount, thread-find.ts drawnText). */
  findCount(turn: Turn, query: string): number;
  /** Works out in the background what findCount cannot count yet in `turns` (transcript-host.ts findCounter); undefined when nothing. */
  prepareCounts(turns: readonly Turn[]): Promise<void> | undefined;
  /** The drawn replies left to format as they near the reader (main.ts lazyReplies), and painting those now formatted. */
  deferredReplies(): readonly Formattable[];
  paintDeferred(): void;
  /** Every loaded turn is drawn and the window is still too short to scroll: the host fetches an older page. */
  fetchOlder(): void;
  report(error: unknown): void;
}

/** How long the reader stays at the bottom before a widened window narrows, so a scroll passing through is left alone. */
const TRIM_SETTLE_MS = 400;
/** The idle time a trim's slice of rows may take before the rest waits for the next idle period. */
const TRIM_SLICE_MS = 4;

/** Runs `run` when the page is idle, never forced by a timeout: a trim is never worth delaying the reader's input. */
const idle = (run: (deadline?: IdleDeadline) => void): void => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(run);
  else setTimeout(run);
};

export function mountTranscriptView<Turn, Views>(host: TranscriptViewHost<Turn, Views>) {
  const scroller = host.scroller;
  let view: RowsWindow<Turn, Views> = emptyWindow();
  /** Threads whose next step up is being formatted: one thread's wait must not hold up the next one opened. */
  const preparing = new Map<string, (() => void) | null>(), forFind = new Map<string, (() => void) | null>();
  /** Which thread the reader last searched: a Find bar left open draws nothing in a thread it merely arrived at. */
  let findAsked = '', findStepping = '';
  /** The window last measured with nothing worth trimming: unchanged, it is not measured again. */
  let settled = '';
  let trimTimer = 0;
  /** Rows far from the reader skip layout; a bot thread's rows never do. */
  const farRows = skipFarRows(scroller, () => host.placed(scroller.scrollTop));
  const syncFarRows = (): void => farRows.sync(view.sessionId === host.openId() && !host.drawsWhole() ? view.rows.flatMap(row => row.nodes) : []);

  /** Whether the transcript still shows `shown`: a shared channel, an error page, a loading line or a thread switch replaces the rows. */
  const onScreen = (shown: RowsWindow<Turn, Views>): boolean => shown.sessionId === host.openId() && !host.elsewhere() && rowsIntact(scroller, shown.rows);
  /** Whether the transcript still shows `shown` with older turns to add. */
  const canShowOlder = (shown: RowsWindow<Turn, Views>): boolean => shown.first !== null && !host.drawsWhole() && onScreen(shown);

  /** Runs `run` in a task after the next paint (its errors reported, as a step's are). An animation frame callback
   *  alone runs before that paint, in the same frame as the step that asked for it. */
  const afterPaint = (run: () => void): void => {
    requestAnimationFrame(() => setTimeout(() => { try { run(); } catch (error) { host.report(error); } }));
  };
  /** Whether a step already drew in this frame: a step costs about a frame's budget, so a second one waits for the next. */
  let steppedThisFrame = false;
  const noteStep = (): void => { if (!steppedThisFrame) { steppedThisFrame = true; afterPaint(() => { steppedThisFrame = false; }); } };
  /** Runs `step` now, or after the next paint if a step already drew in this frame. */
  const inFrame = (step: () => void): void => {
    if (!steppedThisFrame) { try { step(); } catch (error) { host.report(error); } return; }
    afterPaint(step);
  };

  /** Draws the turns from `from` above the ones shown, without touching those or the live card. */
  function prepend(from: number): void {
    noteStep();
    const shown = view, markup = host.markup(shown.sessionId);
    const drawn = shown.turns.slice(from, drawnFrom(shown)).map(turn => parseRow(markup(turn)));
    // Turns a trim took down come back as the reader left them.
    const { back, trimmed } = takeTrimmed(shown, from);
    drawn.forEach((row, index) => { const views = back[index]; if (views) host.restoreViews(row, views); });
    const restore = holdPlace(scroller);
    let fresh = drawn;
    insertRowsAbove(scroller, firstRowNode(shown.rows, scroller), drawn, fragment => {
      fresh = swapRowNodes(drawn, host.prepare(fragment, back));
    });
    view = { ...shown, first: windowAnchor(shown.ids, from), rows: [...fresh, ...shown.rows], trimmed };
    // Every write first (workers, threads cards), then the one pass of reads (the new replies' heights and the scroll),
    // then the replies' clamps, already counted in the scroll: one layout a step.
    host.rowsChanged();
    const replies = host.watch(fresh.flatMap(row => row.nodes), farRows.isAside);
    host.placed(restore(replies.shift));
    replies.apply();
    syncFarRows();
    fill();
  }

  /** Draws older turns above the ones shown, formatted first so they arrive in their final height. False when there are none.
   *  `again` asks afresh if the reader asked while a step was formatting (stepWhenFormatted). */
  function showOlder(more = MORE_TURNS, budget = ROW_BUDGET, again?: () => void): boolean {
    const shown = view;
    if (!canShowOlder(shown)) return false;
    // A step whose text was already formatted lands in the same task, so a reader asking again (`again`) could chain
    // several in one frame: each waits for a frame of its own.
    stepWhenFormatted(preparing, shown.sessionId, host.messagesOf(shown.turns.slice(stepFrom(shown, more, budget), drawnFrom(shown))), () => inFrame(() => {
      if (view.sessionId === shown.sessionId && view.first === shown.first && canShowOlder(view)) prepend(stepFrom(view, more, budget));
    }), host.report, again);
    return true;
  }

  const findWanted = (sessionId: string): HTMLInputElement | undefined => {
    const input = host.findInput();
    return view.sessionId === sessionId && findAsked === sessionId && input?.value && canShowOlder(view) ? input : undefined;
  };
  /* Find searches the turns not drawn yet in memory, and draws only down to the match it needs: the newest one above
   * the window when a query is typed, the next one when the reader steps past the oldest drawn (thread-find.ts
   * `extend`). Drawing every loaded turn instead cost seconds and tens of thousands of nodes in a deep thread. */
  /** A turn's count, asked afresh each time: the host keeps each message's text, so a count is only string searches, and
   *  a reply formatted since (by Find or by a step) is counted by its formatted text at once. */
  const countIn = (turn: Turn, query: string): number => host.findCount(turn, query);
  /** Asks the bar to count and search `sessionId` again, keeping its current match, while the reader still searches it. */
  const refreshFind = (sessionId: string): void => {
    const input = host.findInput();
    if (input?.value && view.sessionId === sessionId && findAsked === sessionId) input.dispatchEvent(new Event(FIND_REFRESH));
  };
  /** The query (and thread) whose newest match was last drawn: a search asking again draws nothing more. */
  let findDrawn = '';
  /** The index of the newest turn above the window that matches (`oldest`: the oldest), or -1. */
  function matchAbove(query: string, oldest: boolean): number {
    const before = drawnFrom(view);
    if (oldest) { for (let index = 0; index < before; index++) if (countIn(view.turns[index], query)) return index; return -1; }
    for (let index = before - 1; index >= 0; index--) if (countIn(view.turns[index], query)) return index;
    return -1;
  }
  /** Matches above the window, for the bar's count. */
  function olderMatches(query: string): number {
    if (!query || view.sessionId !== host.openId() || !canShowOlder(view)) return 0;
    return view.turns.slice(0, drawnFrom(view)).reduce((total, turn) => total + countIn(turn, query), 0);
  }
  /** Draws down to turn `target`, formatted first so a match spanning formatting is found, one step a frame so a long
   *  way down never freezes; then `done`. The rows lay out at their true height before the observer sets far ones aside,
   *  so the match the bar scrolls to does not move. */
  /** A step the reader asked for (Enter past the oldest drawn match) while a draw-down was still on its way: it runs once that lands. */
  let queuedExtend: { sessionId: string; run: () => void } | undefined;
  const runQueuedExtend = (sessionId: string): void => {
    const queued = queuedExtend;
    if (queued?.sessionId !== sessionId) return;
    queuedExtend = undefined;
    queued.run();
  };
  function drawDownTo(sessionId: string, target: number, done: () => void): boolean {
    if (findStepping === sessionId) return false;
    return stepWhenFormatted(forFind, sessionId, host.messagesOf(view.turns.slice(target, drawnFrom(view))), () => {
      if (findStepping === sessionId) return;
      // The window changed under the formatting (a redraw): the search that change set off may already have run and
      // found this draw-down busy, so the bar searches again now, which draws down afresh if a match is still above.
      if (!findWanted(sessionId)) { findDrawn = ''; refreshFind(sessionId); runQueuedExtend(sessionId); return; }
      findStepping = sessionId;
      const next = (): void => {
        if (!findWanted(sessionId) || drawnFrom(view) <= target) {
          findStepping = '';
          if (findWanted(sessionId) || view.sessionId === sessionId) done();
          runQueuedExtend(sessionId);
          return;
        }
        // A step that throws must not leave Find stepping for good, which would keep every later draw-down (and trim) off.
        try { prepend(Math.max(stepFrom(view), target)); } catch (error) { findStepping = ''; findDrawn = ''; queuedExtend = undefined; host.report(error); return; }
        inFrame(next);
      };
      inFrame(next);
    }, host.report);
  }
  /** Threads whose tools above the window are being worked out for Find's count, and threads whose replies are being formatted for it. */
  const counting = new Set<string>(), formatting = new Set<string>();
  /** Until a reply is formatted Find reads its source: a count above the window only approximates what it draws
   *  (thread-find.ts replyCount), and a drawn long folded reply left to format lazily (host.deferredReplies) shows its
   *  raw Markdown; a tool above the window counts once its text is worked out (host.prepareCounts). A search does both
   *  in the background, each on its own: the tools' counts land (and the bar counts again) without waiting on any
   *  formatting, and the replies, once formatted, are painted and counted again. */
  function formatForFind(sessionId: string): void {
    const older = canShowOlder(view) ? view.turns.slice(0, drawnFrom(view)) : [];
    const landed = (busy: Set<string>) => (): void => { busy.delete(sessionId); findDrawn = ''; refreshFind(sessionId); };
    const counts = counting.has(sessionId) ? undefined : host.prepareCounts(older);
    if (counts) { counting.add(sessionId); void counts.catch(host.report).finally(landed(counting)); }
    if (formatting.has(sessionId)) return;
    const pending = [...host.messagesOf(older, true), ...host.deferredReplies()].filter(message => message?.role === 'assistant' && markdownCache.get(message.content) === undefined);
    if (!pending.length) return;
    formatting.add(sessionId);
    const formatted = landed(formatting);
    void prepareMarkdown(pending).catch(host.report).finally(() => { if (view.sessionId === sessionId) host.paintDeferred(); formatted(); });
  }
  /** A search with a query draws down to its newest match above the window, once per query; the bar searches again when it lands. */
  function showForFind(query: string): void {
    const shown = view, key = `${shown.sessionId}\n${query}`;
    if (query && findAsked === shown.sessionId && shown.sessionId === host.openId() && !host.elsewhere()) formatForFind(shown.sessionId);
    if (!query || findDrawn === key || findStepping === shown.sessionId || !findWanted(shown.sessionId)) return;
    const target = matchAbove(query, false);
    findDrawn = key;
    // Landing searches afresh, even when the draw reached the top (the window is whole and no longer `findWanted`).
    const landed = (): void => { if (view.sessionId === shown.sessionId) host.findInput()?.dispatchEvent(new Event('input')); };
    if (target >= 0 && !drawDownTo(shown.sessionId, target, landed)) findDrawn = '';
  }
  /** The reader stepped past the oldest drawn match: draws down to the next one above (`all`: the oldest), then `done`. */
  function extendFind(query: string, all: boolean, done: () => void): boolean {
    const shown = view;
    if (!query || !findWanted(shown.sessionId)) return false;
    // A draw-down still on its way: this step runs once it lands, and lands where the reader asked even if that one drew it.
    if (findStepping === shown.sessionId || forFind.has(shown.sessionId)) {
      queuedExtend = { sessionId: shown.sessionId, run: () => { if (!extendFind(query, all, done) && view.sessionId === shown.sessionId) done(); } };
      return true;
    }
    const target = matchAbove(query, all);
    return target >= 0 && drawDownTo(shown.sessionId, target, done);
  }

  /** A window too short to scroll (a few long agent turns folded to their headers) takes older turns until it can, a
   *  step after each paint (each step asks again), so an open paints its newest turns first; with every loaded turn
   *  drawn, the host fetches an older page, which joins and steps the same way. The window is measured only then,
   *  once the paint has laid it out: measured in the step's own task it would lay out again after the clamps' writes. */
  let filling = false;
  const short = (): boolean => host.visible() && windowShort(scroller.scrollHeight, scroller.clientHeight);
  function fill(): void {
    if (filling) return;
    filling = true;
    afterPaint(() => {
      filling = false;
      if (!short()) return;
      if (canShowOlder(view)) inFrame(() => { if (canShowOlder(view) && short()) prepend(stepFrom(view)); });
      else if (view.first === null && !host.drawsWhole() && onScreen(view)) host.fetchOlder();
    });
  }

  /** A window and how tall the thread is: new rows, or a reply growing at the end, make a trim worth measuring again. */
  const windowKey = (shown: RowsWindow<Turn, Views>): string => `${shown.sessionId}\n${shown.first}\n${shown.rows.length}\n${scroller.scrollHeight}`;
  /** Whether a trim could cut anything, from the turn list alone: fewer widened turns than a trim needs, holding fewer
   *  messages than make one worth it, can never be cut (trimCount), so nothing is measured. */
  function worthTrimming(shown: RowsWindow<Turn, Views>): boolean {
    const start = drawnFrom(shown), limit = windowStart(shown.ids, undefined) - start;
    if (limit < 1 || settled === windowKey(shown)) return false;
    return limit >= MIN_TRIM_TURNS || shown.ids.slice(start, start + limit).reduce((total, ids) => total + turnWeight(ids), 0) >= MIN_TRIM_MESSAGES;
  }
  /** The reader reached the bottom: once they stay there, a widened window narrows, in idle time. */
  function scheduleTrim(): void {
    if (trimTimer || trimming || !worthTrimming(view)) return;
    trimTimer = window.setTimeout(() => idle(deadline => { trimTimer = 0; trim(deadline); }), TRIM_SETTLE_MS);
  }
  /** Whether nothing keeps a trim of `shown` off right now. */
  const mayTrim = (shown: RowsWindow<Turn, Views>): boolean =>
    !host.drawsWhole() && onScreen(shown) && host.visible() && !host.trimBlocked() && !preparing.has(shown.sessionId) && !findStepping;
  /** A trim still taking its rows down, a slice per idle period. */
  let trimming = false;
  /** A reader back at the bottom of a widened thread gives the older turns back, keeping enough above them that the next
   *  scroll does not redraw them at once; turns heavy in messages go even when short (trimCount). They come back as any older ones do. */
  function trim(deadline?: IdleDeadline): void {
    const shown = view;
    if (!mayTrim(shown) || !worthTrimming(shown)) return;
    const start = drawnFrom(shown), limit = windowStart(shown.ids, undefined) - start;
    // One pass of reads over the widened rows only; the far ones among them are out of layout, so it stays cheap.
    const tops = rowTops(shown.rows, limit + 1);
    if (!tops) return;
    const cut = trimCount(tops, limit, scroller.scrollTop, shown.ids.slice(start, start + tops.length).map(turnWeight));
    if (!cut) { settled = windowKey(shown); return; }
    if (shown.rows.slice(0, cut).some(row => row.nodes.some(node => node.contains(document.activeElement)))) return;
    trimming = true;
    cutRows(cut, shown.first, deadline);
  }
  /** Takes the oldest `left` rows down, a slice of about a step's weight per idle period; anything changing meanwhile
   *  (a step drew above, the reader left the bottom, the thread changed) ends it where it is, which leaves a window as
   *  valid as a full cut does. `first` is the window's anchor the count was taken against. */
  function cutRows(left: number, first: string | null, deadline?: IdleDeadline): void {
    const shown = view;
    if (!left || shown.first !== first || !mayTrim(shown)) { trimming = false; return; }
    if (deadline && deadline.timeRemaining() < TRIM_SLICE_MS) { idle(next => cutRows(left, first, next)); return; }
    const start = drawnFrom(shown);
    let cut = 1, weight = turnWeight(shown.ids[start]);
    while (cut < left && weight + turnWeight(shown.ids[start + cut]) <= ROW_BUDGET) weight += turnWeight(shown.ids[start + cut++]);
    const restore = holdPlace(scroller);
    view = trimWindow(shown, cut, host.captureViews);
    host.rowsChanged(true);
    host.placed(restore());
    syncFarRows();
    if (left > cut) idle(next => cutRows(left - cut, view.first, next)); else trimming = false;
  }

  /** Takes a fetched page into the rows on screen without a redraw: only the oldest drawn turn can have changed, by
   *  joining the page's last messages. False when that does not hold and the transcript must draw afresh. */
  function joinPage(): boolean {
    const shown = view;
    if (!onScreen(shown) || host.drawsWhole()) return false;
    const saved = host.savedTurns(shown.sessionId);
    const ids = saved.map(host.turnIds), at = joinIndex(shown.ids.slice(drawnFrom(shown)), ids);
    if (at === undefined) return false;
    const html = host.markup(shown.sessionId)(saved[at]), [oldest, ...rest] = shown.rows;
    if (html !== oldest.html && !oldest.nodes.length) return false;
    // Rows set aside skip layout and lie far from the reader: the anchor search steps over them rather than lay them out.
    const restore = captureTranscriptAnchor(scroller, farRows.isAside);
    // The new extent first: where a worker goes depends on whether older turns are still to come.
    view = { ...shown, first: windowAnchor(ids, at), ids, turns: saved };
    const redrawn = html !== oldest.html ? host.redrawRow(oldest, html) : undefined;
    if (redrawn) view = { ...view, rows: [redrawn, ...rest] };
    // The redrawn row lost what is drawn into it after the fact: its workers and any threads card. Then, as a step
    // does, the reads in one pass and the replies' clamps after them.
    host.rowsChanged();
    const replies = redrawn ? host.watch(redrawn.nodes, farRows.isAside) : undefined;
    restore(replies?.shift);
    replies?.apply();
    host.placed(scroller.scrollTop);
    return true;
  }

  return {
    get view(): RowsWindow<Turn, Views> { return view; },
    set view(next: RowsWindow<Turn, Views>) { view = next; },
    onScreen, canShowOlder, showOlder, showForFind, extendFind, olderMatches, fill, scheduleTrim, joinPage, syncFarRows,
    /** Whether a step for the open thread is being formatted. */
    preparing: (sessionId: string): boolean => preparing.has(sessionId),
    /** The reader searched this thread: a query now draws its older turns too. */
    noteFind(sessionId: string): void { findAsked = sessionId; },
    forgetFind(): void { findAsked = ''; findDrawn = ''; queuedExtend = undefined; },
    /** Whether Find's count for the open thread is final: every tool above the window worked out, every reply it reads formatted. */
    countsSettled: (): boolean => !counting.has(view.sessionId) && !formatting.has(view.sessionId),
  };
}
export type TranscriptView<Turn, Views> = ReturnType<typeof mountTranscriptView<Turn, Views>>;

/** The rows of the last threads left, out of the document, so switching straight back reattaches them instead of
 *  parsing, formatting and measuring every turn again. Nothing stale comes back: drawRows keeps a row only while its
 *  markup (every input of which is in the turn's parts or markupEnv) is identical, and redraws the rest; a reply that
 *  finished formatting while out of the document is formatted again (main.ts staleMarkdown). `keys` are each row's
 *  turn's last message id, which a trim keys what the reader set by (takeTrimmed). */
export function leftRowsCache<Views>(limit = 2) {
  type Left = { rows: DrawnRow[]; trimmed: ReadonlyMap<string, Views>; keys: readonly string[] };
  const left = new Map<string, Left>();
  return {
    keep(sessionId: string, kept: Left): void {
      left.delete(sessionId);
      left.set(sessionId, kept);
      for (const key of left.keys()) { if (left.size <= limit) break; left.delete(key); }
    },
    /** `id`'s rows, once: only rows nothing else took into the document in the meantime. */
    take(id: string): Left | undefined {
      const kept = left.get(id);
      left.delete(id);
      return kept && kept.rows.every(row => row.nodes.every(node => !node.parentNode)) ? kept : undefined;
    },
    /** Whether `node` is in rows kept to come back. */
    holds(node: Node): boolean {
      for (const kept of left.values()) if (kept.rows.some(row => row.nodes.some(root => root.contains(node)))) return true;
      return false;
    },
  };
}

/** What the reader set in rows of a thread switched back to that the reopened window leaves out (a widened window
 *  opens from its tail again): kept as a trim keeps them, so they come back as the reader left them. `drawn` are the
 *  rows now on screen; `dropped` says whether a turn (by its last message id) is above the reopened window. */
export function leftViews<Views>(left: { rows: readonly DrawnRow[]; keys: readonly string[]; trimmed: ReadonlyMap<string, Views> }, drawn: readonly DrawnRow[], dropped: (key: string) => boolean, capture: (row: DrawnRow) => Views | undefined): ReadonlyMap<string, Views> {
  const shown = new Set(drawn);
  const taken = left.rows.flatMap((row, index): [string, Views][] => {
    const key = left.keys[index];
    if (shown.has(row) || key === undefined || !dropped(key)) return [];
    const views = capture(row);
    return views === undefined ? [] : [[key, views]];
  });
  return taken.length ? new Map([...left.trimmed, ...taken]) : left.trimmed;
}

/** What a tile view has drawn: the anchor of its oldest drawn turn (null: all of them), every saved turn, and the rows. */
export type TileWindow<Turn> = { first: string | null; ids: TurnIds[]; turns: Turn[]; rows: DrawnRow[] };

export interface TileWindowsHost<Turn> {
  /** Redraws a tile's rows (main.ts drawTile, which calls `draw` below for its saved turns). */
  redraw(id: string, rows: HTMLElement, scroller: HTMLElement): void;
  turnIds(turn: Turn): TurnIds;
  messagesOf(turns: readonly Turn[]): readonly Formattable[];
  /** Draws a saved tool's lazy body (a tile's folds open focused or not). */
  fillToolBody(tool: HTMLDetailsElement): void;
  report(error: unknown): void;
}

/** The tiles' windows: each tile view draws its newest turns, as the pane does, and older ones as its reader nears the top. */
export function mountTileWindows<Turn>(host: TileWindowsHost<Turn>) {
  const views = new WeakMap<HTMLElement, TileWindow<Turn>>(), preparing = new WeakMap<HTMLElement, (() => void) | null>();
  /** Whether a tile's reader is within reach of its top (thread-tiles.ts asks for more there). */
  const nearTop = (scroller: HTMLElement): boolean => scroller.scrollTop < ROWS_MARGIN && scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight >= 48;

  /** Draws `saved` into a tile's rows from its window, keeping every row whose markup did not change, then `trailing`.
   *  `restore` puts back what the reader had open and answers which nodes replaced which. */
  function draw(rows: HTMLElement, saved: Turn[], markup: (turn: Turn) => string, trailing: string, restore: () => Map<ChildNode, ChildNode>): { from: number; added: ChildNode[] } {
    const view = views.get(rows), ids = saved.map(host.turnIds), from = windowStart(ids, view && rowsIntact(rows, view.rows) ? view.first : undefined);
    const { rows: drawn, added } = drawRows(rows, view?.rows ?? [], saved.slice(from).map(markup), trailing);
    // A note the reader had open goes back in place of the redrawn one, so the row lists the node that is on screen.
    views.set(rows, { first: windowAnchor(ids, from), ids, turns: saved, rows: swapRowNodes(drawn, restore()) });
    return { from, added };
  }

  /** Formats older turns first, as the pane does, so they arrive in their final height. A step gone stale while it
   *  formatted (the tile redrew, another step landed) asks once more if the reader is still near the top: no scroll may follow. */
  function showMore(id: string, rows: HTMLElement, scroller: HTMLElement, retry = true): void {
    const view = views.get(rows);
    if (!view || view.first === null) return;
    const askAgain = (): void => { if (rows.isConnected && nearTop(scroller)) showMore(id, rows, scroller, false); };
    stepWhenFormatted(preparing, rows, host.messagesOf(view.turns.slice(stepFrom(view), drawnFrom(view))), () => {
      const current = views.get(rows);
      if (!rows.isConnected || !current || current.first !== view.first || !rowsIntact(rows, current.rows)) { if (retry) askAgain(); return; }
      const restore = holdPlace(scroller);
      views.set(rows, { ...current, first: windowAnchor(current.ids, stepFrom(current)) });
      delete rows.dataset.key;
      host.redraw(id, rows, scroller);
      restore();
    }, host.report, askAgain);
  }

  // A tile's folds fill their bodies as the transcript's do, focused or not; any other way one opens (a script) too.
  document.addEventListener('click', event => { const tool = (event.target as Element).closest?.('.thread-mirror-rows details[data-tool-key] > summary')?.parentElement; if (tool) host.fillToolBody(tool as HTMLDetailsElement); }, true);
  document.addEventListener('toggle', event => { const tool = event.target as HTMLDetailsElement; if (tool.open && tool.matches?.('.thread-mirror-rows details[data-tool-key]')) host.fillToolBody(tool); }, true);

  return {
    draw, showMore,
    /** What the tile view holding `rows` has drawn. */
    of: (rows: HTMLElement): TileWindow<Turn> | undefined => views.get(rows),
    /** What `id`'s tile has drawn, for the pane opening it at the tile's place. */
    ofThread: (id: string): TileWindow<Turn> | undefined => {
      const rows = document.querySelector<HTMLElement>(`.thread-tile[data-tile="${CSS.escape(id)}"] .thread-mirror-rows`);
      return rows ? views.get(rows) : undefined;
    },
  };
}
