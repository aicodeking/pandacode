/* The bookkeeping of a windowed transcript (see transcript-rows.ts for the window itself): what a view has drawn,
 * the steps that widen and narrow it, and how they hold the reader's place. Everything here takes its host and
 * scroller, so the main transcript and the tiles share it; what a row holds (turn cards, folds) stays with main.ts. */
import { markdownCache, markdownHtml } from './dom';
import { isFollowingTranscript, restoreScrollTop, scrollRemainder } from './transcript-scroll';
import { widerWindow, windowAnchor, windowStart, MORE_TURNS, ROW_BUDGET, type DrawnRow, type TurnIds } from './transcript-rows';

/** What a view has drawn: its thread, the anchor of its oldest drawn turn (null: all of them), every saved turn and its
 *  ids, the rows, and what the reader had set in rows a trim took down, by each turn's last message id (a joined page
 *  adds only at a turn's head). */
export type RowsWindow<Turn, Views> = {
  sessionId: string; first: string | null; ids: TurnIds[]; turns: Turn[]; rows: DrawnRow[]; trimmed: ReadonlyMap<string, Views>;
};

export function emptyWindow<Turn, Views>(): RowsWindow<Turn, Views> {
  return { sessionId: '', first: null, ids: [], turns: [], rows: [], trimmed: new Map() };
}

/** The index of the oldest drawn turn. */
export const drawnFrom = (view: { ids: TurnIds[]; first: string | null }): number => windowStart(view.ids, view.first);
/** Where the next step up starts. */
export const stepFrom = (view: { ids: TurnIds[]; first: string | null }, more = MORE_TURNS, budget = ROW_BUDGET): number =>
  widerWindow(view.ids, drawnFrom(view), more, budget);

/** How long formatting may hold the main thread before it lets a frame through. */
const MARKDOWN_SLICE_MS = 8;
/** Formats assistant text ahead of drawing it, a slice at a time, so a long page never freezes the scroll. */
export async function prepareMarkdown(messages: readonly ({ role: string; content: string } | undefined)[], progress?: () => void): Promise<void> {
  let sliceStart = performance.now();
  for (const message of messages) {
    if (message?.role !== 'assistant' || markdownCache.get(message.content) !== undefined) continue;
    await markdownHtml(message.content);
    progress?.();
    if (performance.now() - sliceStart < MARKDOWN_SLICE_MS) continue;
    await new Promise(resolve => setTimeout(resolve));
    sliceStart = performance.now();
  }
}

/** What `stepWhenFormatted` tracks per view: present while its formatting runs, holding the latest request made meanwhile. */
export type StepBusy<Key> = { has(key: Key): boolean; get(key: Key): (() => void) | null | undefined; set(key: Key, again: (() => void) | null): unknown; delete(key: Key): unknown };

/** How long a step waits on formatting that makes no progress (the Markdown engine still loading on a cold start)
 *  before it draws its rows unformatted; they format as they arrive, as any unprepared text does. */
export const FORMAT_STALL_MS = 1000;

/** Formats `messages`, then runs `step` once; or sooner if formatting stalls for FORMAT_STALL_MS, so a reader is never
 *  left looking at nothing while the engine loads. A view asked again while its formatting runs is not formatted twice:
 *  the latest `again` (the caller asking afresh, its own checks included) runs once the step is done, so a request
 *  made while a step that turns out stale was formatting is never lost. False when the view was already waiting. */
export function stepWhenFormatted<Key>(busy: StepBusy<Key>, key: Key, messages: Parameters<typeof prepareMarkdown>[0], step: () => void, report: (error: unknown) => void, again?: () => void): boolean {
  if (busy.has(key)) { if (again) busy.set(key, again); return false; }
  busy.set(key, null);
  let stepped = false, stall: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => {
    if (stepped) return;
    stepped = true; clearTimeout(stall);
    const next = busy.get(key);
    busy.delete(key);
    // Inside a promise's settling or a timer: an error must reach `report`, never go unhandled.
    try { step(); } catch (error) { report(error); } finally { next?.(); }
  };
  const waiting = (): void => { clearTimeout(stall); if (!stepped) stall = setTimeout(run, FORMAT_STALL_MS); };
  waiting();
  void prepareMarkdown(messages, waiting).catch(report).finally(run);
  return true;
}

/** Reads the scroller once; the returned call puts the reader back where they were after content above them changed.
 *  An absolute position, so it lands the same whether or not the engine anchored the scroll itself. Call it after every
 *  write above the reader (the replies' clamps too), so it reads the final extent; `pending` is what writes still to
 *  come will change above the reader, always counted: never trust `overflow-anchor`, which WebKit reports as supported
 *  without anchoring the transcript. */
export function holdPlace(scroller: HTMLElement): (pending?: number) => number {
  // Carry what a webview that rounds scrollTop dropped last time, so repeated prepends never drift a pixel at a time.
  const top = scroller.scrollTop + scrollRemainder(scroller), height = scroller.scrollHeight;
  return (later = 0) => {
    // Nothing above the reader changed: no write at all, since any scrollTop write ends a WKWebView momentum scroll.
    if (scroller.scrollHeight === height && later === 0) return scroller.scrollTop;
    restoreScrollTop(scroller, top + scroller.scrollHeight - height + later);
    return scroller.scrollTop;
  };
}

/** Puts `rows` (parsed, not yet placed) above `anchor` in one insertion. `prepare` runs on the fragment first, so
 *  formatting lands before anything lays out (it may swap nodes in the fragment). */
export function insertRowsAbove(host: ParentNode, anchor: ChildNode | null, rows: readonly DrawnRow[], prepare: (fragment: DocumentFragment) => void = () => {}): void {
  const fragment = document.createDocumentFragment();
  const nodes = rows.flatMap(row => row.nodes);
  fragment.append(...nodes);
  prepare(fragment);
  host.insertBefore(fragment, anchor);
}

/** The first node of the oldest drawn row: what older rows go in front of. */
export const firstRowNode = (rows: readonly DrawnRow[], host: ParentNode): ChildNode | null => rows.find(row => row.nodes.length)?.nodes[0] ?? host.firstChild;

/** Each of the first `count` rows' distance below the first row, in one pass of reads. A row with nothing to measure
 *  sits where the row before it ended, which the next read corrects. Undefined when the first row has no box. */
export function rowTops(rows: readonly DrawnRow[], count: number): number[] | undefined {
  const elementTop = (row: DrawnRow): number | undefined => row.nodes.find((node): node is Element => node instanceof Element)?.getBoundingClientRect().top;
  const origin = rows[0] && elementTop(rows[0]);
  if (origin === undefined) return undefined;
  return rows.slice(0, count).reduce<number[]>((list, row) => [...list, (elementTop(row) ?? origin + (list.at(-1) ?? 0)) - origin], []);
}

/** Takes `rows` (consecutive, in order) out of the document in one operation. */
export function removeRows(rows: readonly DrawnRow[]): void {
  const nodes = rows.flatMap(row => row.nodes), first = nodes[0], last = nodes.at(-1);
  // Only a run with nothing else between its nodes (a decoration drawn beside a row) goes as one range.
  let at: ChildNode | null = first ?? null, index = 0;
  while (at && index < nodes.length && at === nodes[index]) { at = at.nextSibling; index++; }
  if (!first || !last || index < nodes.length) { nodes.forEach(node => node.remove()); return; }
  const range = document.createRange();
  range.setStartBefore(first); range.setEndAfter(last);
  range.deleteContents();
}

/** The view after its first `cut` rows came down: the rows leave the document, and what the reader had set in them is
 *  kept. `capture` answers undefined for a row with nothing set (never opened), which is then not kept. */
export function trimWindow<Turn, Views>(view: RowsWindow<Turn, Views>, cut: number, capture: (row: DrawnRow) => Views | undefined): RowsWindow<Turn, Views> {
  const start = drawnFrom(view);
  const taken = view.rows.slice(0, cut).flatMap((row, index): [string, Views][] => { const views = capture(row); return views === undefined ? [] : [[view.ids[start + index].at(-1)!, views]]; });
  removeRows(view.rows.slice(0, cut));
  return { ...view, first: windowAnchor(view.ids, start + cut), rows: view.rows.slice(cut), trimmed: taken.length ? new Map([...view.trimmed, ...taken]) : view.trimmed };
}

/** What the reader had set in the turns `from` up to the drawn window, as a trim left them, and the trimmed map without them. */
export function takeTrimmed<Turn, Views>(view: RowsWindow<Turn, Views>, from: number): { back: (Views | undefined)[]; trimmed: ReadonlyMap<string, Views> } {
  const keys = view.ids.slice(from, drawnFrom(view)).map(ids => ids.at(-1)!), back = keys.map(key => view.trimmed.get(key));
  return { back, trimmed: back.some(Boolean) ? new Map([...view.trimmed].filter(([key]) => !keys.includes(key))) : view.trimmed };
}

/** Rows this far (px) outside the viewport skip style and layout. */
export const FAR_MARGIN = 2400;
/** A change in a far row's height, or in the scroll, smaller than this (px) is rounding. */
const SHIFT_EPSILON = 0.5;

/** Rows far from the reader skip style and layout (`content-visibility: auto`), so a thread scrolled deep into its
 *  history costs a step what a short one does: every forced read lays out only what is near. A row is set aside at the
 *  height it was last laid out with, read from the observer's entry (no extra layout); when it comes near it lays out
 *  again, and a row above the reader that changed size meanwhile (a worker joined its slot, the window narrowed, its
 *  reply formatted) moves the scroll by what it changed, less what the engine's scroll anchoring already moved it, so
 *  nothing on screen shifts. WebKit reports `overflow-anchor` as supported yet does not anchor the transcript, so what
 *  the engine did is measured rather than assumed. */
export function skipFarRows(scroller: HTMLElement, onShift: () => void): { sync(nodes: readonly ChildNode[]): void; isAside(node: Node): boolean; reveal(node: Node | null): void } {
  if (typeof IntersectionObserver === 'undefined') return { sync() {}, isAside: () => false, reveal() {} };
  const aside = new WeakMap<HTMLElement, number>(), watched = new Set<HTMLElement>();
  /** After `rows` (laid out again, read before at their held heights) changed size, moves the scroll by what those above
   *  the reader changed and the engine's anchoring (applied in the same layout) has not moved it yet. `before` is the
   *  scrollTop read before any write. A transcript following its bottom is pinned again by its owner after layout:
   *  moving it here (up, for a row that shrank) would read as the reader leaving the bottom. */
  const shiftReader = (rows: readonly { row: HTMLElement; height: number; above: boolean }[], before: number): void => {
    if (!rows.some(({ above }) => above) || isFollowingTranscript(scroller)) return;
    // All writes are done: one layout for every read below.
    const shift = rows.reduce((total, { row, height, above }) => above ? total + row.getBoundingClientRect().height - height : total, 0);
    const anchored = scroller.scrollTop - before, missing = shift - anchored;
    if (Math.abs(missing) >= SHIFT_EPSILON) restoreScrollTop(scroller, scroller.scrollTop + missing);
    if (Math.abs(missing) >= SHIFT_EPSILON || Math.abs(anchored) >= SHIFT_EPSILON) onShift();
  };
  const observer = new IntersectionObserver(entries => {
    // The scroller's own top, read before any write below: the root bounds include the far margin, so they would
    // place every row that comes near (at the margin's edge) below them.
    const readerTop = scroller.getBoundingClientRect().top, before = scroller.scrollTop;
    const near: { row: HTMLElement; height: number; above: boolean }[] = [];
    for (const entry of entries) {
      const row = entry.target as HTMLElement, height = entry.boundingClientRect.height;
      if (!watched.has(row)) continue;
      if (!entry.isIntersecting) {
        // A hidden scroller measures nothing: nothing to hold the place of.
        if (aside.has(row) || height <= 0 || !entry.rootBounds?.height) continue;
        setRowAside(row, height);
      } else if (aside.has(row)) {
        near.push({ row, height: aside.get(row)!, above: entry.boundingClientRect.bottom <= readerTop });
        aside.delete(row);
        row.style.removeProperty('content-visibility');
        row.style.removeProperty('contain-intrinsic-size');
      }
    }
    shiftReader(near, before);
  }, { root: scroller, rootMargin: `${FAR_MARGIN}px 0px` });
  const clearAside = (row: HTMLElement): void => { row.style.removeProperty('content-visibility'); row.style.removeProperty('contain-intrinsic-size'); };
  const release = (row: HTMLElement): void => {
    observer.unobserve(row); watched.delete(row);
    if (aside.delete(row)) clearAside(row);
  };
  /** The direct child of the scroller holding `node`. */
  const rowOf = (node: Node | null): HTMLElement | undefined => {
    for (let at = node; at && at !== scroller; at = at.parentNode) if (at.parentNode === scroller) return at instanceof HTMLElement ? at : undefined;
    return undefined;
  };
  const setRowAside = (row: HTMLElement, height: number): void => {
    aside.set(row, height);
    row.style.setProperty('contain-intrinsic-size', `auto ${height}px`);
    row.style.setProperty('content-visibility', 'auto');
  };
  return {
    /** Whether `node` is in a row set aside: measuring inside it would lay it out. */
    isAside(node) {
      for (let at: Node | null = node; at && at !== scroller; at = at.parentNode) if (at.parentNode === scroller) return aside.has(at as HTMLElement);
      return false;
    },
    /** Lays out now the row holding `node` and its neighbours, if set aside, so a jump to it measures exact positions.
     *  A revealed row above the reader that changed size moves the scroll by that change (shiftReader). */
    reveal(node) {
      const row = rowOf(node);
      if (!row) return;
      const rows = [row.previousElementSibling, row, row.nextElementSibling].filter((at): at is HTMLElement => at instanceof HTMLElement && aside.has(at));
      if (!rows.length) return;
      // Reads first (rows set aside lay out at their held height), then every write, then one layout for the shift.
      const readerTop = scroller.getBoundingClientRect().top, before = scroller.scrollTop;
      const revealed = rows.map(at => ({ row: at, height: aside.get(at)!, above: at.getBoundingClientRect().bottom <= readerTop }));
      for (const { row: at } of revealed) { aside.delete(at); clearAside(at); }
      shiftReader(revealed, before);
    },
    /** Watches exactly `nodes` (the drawn rows), letting go of any no longer among them. */
    sync(nodes) {
      const rows = new Set(nodes.filter((node): node is HTMLElement => node instanceof HTMLElement));
      for (const row of watched) if (!rows.has(row)) release(row);
      for (const row of rows) if (!watched.has(row)) { watched.add(row); observer.observe(row); }
    },
  };
}

/** Rows the reader touched (a click, a fold toggled, a scroll inside): only those have views worth keeping. */
export function touchedRows(scroller: HTMLElement): { has(node: Node): boolean; add(node: Node): void } {
  const touched = new WeakSet<Node>();
  const mark = (event: Event): void => {
    let node = event.target as Node | null;
    if (node === scroller) return;
    while (node && node.parentNode !== scroller) node = node.parentNode;
    if (node) touched.add(node);
  };
  for (const type of ['click', 'toggle', 'scroll']) scroller.addEventListener(type, mark, { capture: true, passive: true });
  return { has: node => touched.has(node), add: node => { touched.add(node); } };
}

/** A folded saved reply this long is formatted only as it nears the viewport: its clamp shows a few lines either way,
 *  so its height does not change, and a step or an open never waits on formatting text the reader may never see. */
export const LAZY_REPLY_CHARS = 8000;
/** Formats Markdown targets in `scroller` only as they come within FAR_MARGIN of its viewport; `paint` formats one.
 *  `defer` is false where nothing can watch (no IntersectionObserver): the caller formats at once. `kept` says whether a
 *  target out of the document will come back (a thread's rows kept across a switch): it stays deferred; any other is let go. */
export function lazyMarkdown(scroller: HTMLElement, paint: (target: HTMLElement, follow: () => void) => void, kept: (target: HTMLElement) => boolean = () => false): {
  defer(target: HTMLElement, follow: () => void): boolean; pending(): HTMLElement[]; flush(ready: (target: HTMLElement) => boolean): void;
} {
  if (typeof IntersectionObserver === 'undefined') return { defer: () => false, pending: () => [], flush() {} };
  const follows = new WeakMap<Element, () => void>();
  /** Deferred targets; one out of the document stays while `kept` says it will come back. */
  const waiting = new Set<HTMLElement>();
  const take = (target: HTMLElement): void => { observer.unobserve(target); waiting.delete(target); paint(target, follows.get(target) ?? (() => {})); };
  const observer = new IntersectionObserver(entries => {
    for (const entry of entries) {
      const target = entry.target as HTMLElement;
      if (entry.isIntersecting && target.isConnected) take(target);
    }
  }, { root: scroller, rootMargin: `${FAR_MARGIN}px 0px` });
  const connected = (): HTMLElement[] => [...waiting].filter(target => {
    if (target.isConnected) return true;
    if (!kept(target)) { observer.unobserve(target); waiting.delete(target); }
    return false;
  });
  return {
    defer(target, follow) { follows.set(target, follow); waiting.add(target); observer.observe(target); return true; },
    /** The deferred targets in the document. */
    pending: connected,
    /** Paints now every deferred target in the document that `ready` says is formatted (Find searching its text). */
    flush(ready) { for (const target of connected()) if (ready(target)) take(target); },
  };
}
