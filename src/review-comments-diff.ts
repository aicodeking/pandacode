/* Line comments in a Changes diff (docs/line-comments.md): the hooks diff-viewer.ts knows only as
 * DiffReviewHooks (`createDiffReview`: pierre's line selection, annotations and the shadow CSS that
 * tints commented lines) and the keyboard path to the line numbers in pierre's shadow roots
 * (`diffKeys`). Loaded by `reviewDiffUi()` in review-comments.ts with the first diff shown with a
 * thread; the comment fields and focus hand-off it shares with the Files view are
 * review-comments-ui.ts. */
import { capital, rangeLabel, type CommentSurface, type Draft, type ReviewSide, type ReviewStore } from './review-comments';
import { clampToHunk, makeAnchor, patchHunks, patchRows, patchSideLines, placeDraft, reconcileComments, selectionSpan, spanSelection, type DiffSelection, type DiffSide, type PatchHunk, type PatchRow, type PlacedComment } from './review-anchor';
import { COMMENT_HINT, commentElement, draftElement, focusEditor, handOff, isPainting, letGo, lineCommand, lineName, repaintKeepingFocus, setTabStop } from './review-comments-ui';
import type { DiffAnnotation, DiffHunkSpan, DiffReviewHooks, DiffReviewHost } from './diff-viewer';

/** The first-use hint, which the Changes view puts above its list with its first diff. */
export { mountCommentHint } from './review-comments-ui';

const toSide = (side?: DiffSide): 'old' | 'new' => side === 'deletions' ? 'old' : 'new';
const fromSide = (side: ReviewSide): DiffSide => side === 'old' ? 'deletions' : 'additions';

/** A diff highlights at most this many lines of one range (each line is a selector); a longer comment says so. */
export const HIGHLIGHT_CAP = 400;
/** Selectors for a range's line-number cells and its code lines, on one side (line numbers only,
 * never patch text), and for its first and last code lines (where forced colours draw its top and
 * bottom edges). */
type LineSelectors = { numbers: string; lines: string; first: string; last: string };
function lineSelectors(side: ReviewSide, from: number, to: number): LineSelectors {
  const numbers: string[] = [], lines: string[] = [];
  const line = (n: number) => side === 'old' ? `[data-line-type="change-deletion"][data-line="${n}"]` : `[data-line="${n}"]:not([data-line-type="change-deletion"])`;
  const end = Math.min(to, from + HIGHLIGHT_CAP - 1);
  for (let n = from; n <= end; n++) {
    numbers.push(side === 'old' ? `[data-line-type="change-deletion"][data-column-number="${n}"]` : `[data-column-number="${n}"]:not([data-line-type="change-deletion"])`);
    lines.push(line(n));
  }
  const join = (parts: string[]) => parts.length ? `:is(${parts.join(',')})` : '';
  return { numbers: join(numbers), lines: join(lines), first: numbers.length ? line(from) : '', last: numbers.length ? line(end) : '' };
}
// Custom properties inherit into the shadow root, so the palette's tokens and the tints in
// review-comments.css apply there too. The line number carries the accent edge and the full tint;
// the code line only a faint one (`--rc-diff-*`), an inset shadow over its own background, so added
// and deleted lines keep their green and red, clearly apart, under a comment. Increase Contrast
// draws a text-coloured edge; forced colours, which drop shadows and fills, fill the line numbers
// with Highlight and outline each range's code lines as one block (dashed while selected): its sides
// on every line, its top on the first and its bottom on the last, drawn by an overlay so the rows
// keep their height (pierre's indicators are the lines' ::before; ::after is free).
const overlay = (tint: string) => `inset 0 0 0 100vmax rgb(var(--accent-rgb) / var(${tint}))`;
function tinted({ numbers, lines }: LineSelectors, tint: 'covered' | 'selected'): string {
  if (!numbers) return '';
  const cell = overlay(`--rc-tint-${tint}`);
  // Focused, the number keeps its edge inside the focus ring (an outline 2px in).
  return `${numbers}{box-shadow:inset 2px 0 0 var(--accent),${cell}}${numbers}:focus-visible{box-shadow:inset 4px 0 0 var(--accent),${cell}}${lines}{box-shadow:${overlay(`--rc-diff-tint-${tint}`)}}`
    + `@media (prefers-contrast:more){${numbers}{box-shadow:inset 3px 0 0 var(--text),${cell}}${numbers}:focus-visible{box-shadow:inset 5px 0 0 var(--text),${cell}}}`;
}
function forced(ranges: LineSelectors[], selected: LineSelectors | null): string {
  const all = ranges.filter(r => r.numbers);
  if (!all.length) return '';
  const list = (key: keyof LineSelectors, from = all) => `:is(${from.map(r => r[key]).join(',')})`;
  const edge = '2px solid Highlight';
  return '@media (forced-colors:active){'
    + `${list('numbers')}{forced-color-adjust:none;background:Highlight;color:HighlightText}${list('numbers')}:is(:hover,:focus-visible)::after{color:HighlightText}`
    + `${list('lines')}::after{content:"";position:absolute;inset:0;pointer-events:none;border-inline:${edge}}`
    + `${list('first')}::after{border-block-start:${edge}}${list('last')}::after{border-block-end:${edge}}`
    + (selected?.numbers ? `${list('lines', [selected])}::after{border-style:dashed}` : '')
    + '}';
}
const merge = (ranges: LineSelectors[]): LineSelectors => {
  // One selector each, so a pseudo-class added after it applies to every range.
  const join = (key: keyof LineSelectors) => { const parts = ranges.map(r => r[key]).filter(Boolean); return parts.length ? `:is(${parts.join(',')})` : ''; };
  return { numbers: join('numbers'), lines: join('lines'), first: join('first'), last: join('last') };
};
// The line numbers say they take comments: a "+" on hover and on keyboard focus (pierre's own
// ::before is the change bar, so this is ::after).
const GUTTER_CSS = '[data-column-number]:is(:hover,:focus-visible)::after{content:"+";position:absolute;top:0;bottom:0;left:4px;display:flex;align-items:center;font-weight:var(--weight-strong,600);color:var(--accent-ink,var(--accent))}'
  + '[data-column-number]:focus-visible{outline:2px solid var(--focus);outline-offset:-2px}'
  + '@media (forced-colors:active){[data-column-number]:is(:hover,:focus-visible)::after{color:Highlight}}';

/**
 * The diffs drawing each surface, oldest first. A refetched diff mounts before the old one goes, so
 * for a moment two draw the same comments from different patches: only the newest (`owns`) places
 * the comment being written and remembers relocations; the others only draw.
 */
const drawing = new WeakMap<CommentSurface, object[]>();
const owns = (surface: CommentSurface, review: object) => drawing.get(surface)?.at(-1) === review;

/** Line comments for one file's diff in the Changes view, for the thread shown when it mounts. */
export function createDiffReview(store: ReviewStore, file: string, patch: string, thread = store.sessionId): DiffReviewHooks {
  const surface = store.surface('diff', file, thread);
  const self = {};
  // The patch is read only once there is something to place: most diffs never take a comment.
  let rows: PatchRow[] | null = null, parsed: ReturnType<typeof patchSideLines> | null = null, hunkList: PatchHunk[] | null = null;
  const rowsOf = () => rows ??= patchRows(patch);
  const sides = () => parsed ??= patchSideLines(rowsOf());
  const hunksOf = () => hunkList ??= patchHunks(patch);
  const hosts = new Map<DiffReviewHost, ReturnType<typeof diffKeys>>();
  let placed: PlacedComment[] = [];
  let elements = new Map<string, HTMLElement>();
  let painted = '';
  const keyOf = (item: PlacedComment) => `${item.comment.id}\0${item.startLine}\0${item.endLine}\0${item.outdated}\0${Boolean(item.away)}\0${item.comment.status}\0${item.comment.text}`;
  const draftKey = () => surface.draft ? `draft\0${surface.draft.side}\0${surface.draft.startLine}\0${surface.draft.endLine}\0${surface.draft.lost ?? ''}\0${surface.draft.dropped?.join() ?? ''}` : '';
  /** What this diff shows: when a store change leaves it alone (another file's comment), nothing is redrawn. */
  const signature = () => `${draftKey()}\n${store.forFile(file, ['old', 'new'], thread).map(c => `${c.id}\0${c.startLine}\0${c.endLine}\0${c.status}\0${c.text}`).join('\n')}`;
  const show = (range: DiffSelection | null) => hosts.forEach((_, host) => host.show(range));
  const done = (byKey: boolean, draft: Draft) => {
    show(null);
    if (byKey) [...hosts.values()].at(-1)?.focusLine(fromSide(draft.side), draft.endLine);
  };
  const awayNote = (item: { startLine: number; endLine: number }) => `${capital(rangeLabel(item.startLine, item.endLine))} ${item.startLine === item.endLine ? 'is' : 'are'} no longer in this diff`;

  function build(): void {
    placed = [];
    // An older diff of this file still on screen (its refetched successor is drawing) only draws.
    const owner = owns(surface, self);
    for (const side of ['old', 'new'] as const) {
      const comments = store.forFile(file, [side], thread);
      if (!comments.length) continue;
      const result = reconcileComments(comments, sides()[side], true);
      if (owner) store.persist(result.updates, thread);
      placed.push(...result.placed);
    }
    if (owner) surface.shown = new Set(placed.filter(open).map(item => item.comment.id));
    // A draft follows its lines when the refetched patch moved them.
    if (owner && surface.draft) placeDraft(surface.draft, sides()[surface.draft.side as 'old' | 'new'], true);
    const next = new Map<string, HTMLElement>();
    for (const item of placed) {
      const key = keyOf(item);
      const note = item.away ? awayNote(item) : item.endLine - item.startLine >= HIGHLIGHT_CAP ? `Only the first ${HIGHLIGHT_CAP} lines are highlighted` : '';
      next.set(key, elements.get(key) ?? commentElement(store, surface, item, note));
    }
    const draft = draftKey();
    if (draft) next.set(draft, elements.get(draft) ?? draftElement(store, surface, repaint, done));
    elements = next;
    painted = signature();
  }
  function repaint(): void {
    // Detached (its diff went, and a field it left was saved or dropped since): nothing to draw, and
    // fields built now would replace the live ones of whichever view shows the surface.
    if (!hosts.size) return;
    repaintKeepingFocus(surface, () => { build(); hosts.forEach((_, host) => host.repaint()); });
  }
  const changed = () => { if (signature() !== painted) repaint(); };
  const inHunks = (hunks: readonly DiffHunkSpan[], side: ReviewSide, line: number) => hunks.some(h => side === 'old' ? line >= h.deletionStart && line < h.deletionStart + h.deletionCount : line >= h.additionStart && line < h.additionStart + h.additionCount);
  /** The hunk group drawn first (a long patch is drawn in several), which shows what has no line of its own. */
  const first = (hunks: readonly DiffHunkSpan[]) => { const top = hunksOf()[0]; return !top || hunks.some(h => h.additionStart === top.newStart && h.deletionStart === top.oldStart); };
  const open = (item: PlacedComment) => item.comment.status === 'open' && !item.outdated && !item.away;
  // Subscribed only while a viewer shows it: a diff that falls back to plain text never attaches.
  let unsubscribe = () => {};
  /** What a selection comments on, and the selection to show for it: the hunk it starts in, and
   * across deleted and added lines only the lines the comment will be on. `shown` is `input`
   * itself when that needs no change. */
  const resolve = (input: DiffSelection) => {
    const range = clampToHunk(hunksOf(), input), span = selectionSpan(rowsOf(), range);
    const mixed = (range.endSide ?? range.side) !== range.side;
    return { span, shown: mixed ? spanSelection(span) : range };
  };
  /** The last selection shown in place of the one drawn: pierre reports it back when the pointer is
   * released, and the deleted lines it left out still belong to the note. */
  let previewed: { shown: DiffSelection; dropped: number[] } | null = null;
  const sameRange = (a: DiffSelection, b: DiffSelection) => a.start === b.start && a.end === b.end && (a.side ?? 'additions') === (b.side ?? 'additions') && (a.endSide ?? a.side ?? 'additions') === (b.endSide ?? b.side ?? 'additions');

  const review = {
    annotations(hunks: readonly DiffHunkSpan[]): DiffAnnotation[] {
      const list: DiffAnnotation[] = [];
      const shown = surface.draft;
      // Only something with no line of its own needs to know which hunk group is drawn first (that
      // reads the patch's hunks).
      const top = (placed.some(item => item.away) || shown?.lost === 'away') && first(hunks);
      for (const item of placed) {
        const side = fromSide(item.comment.side);
        if (item.away) { if (top) list.push({ side, lineNumber: 0, metadata: keyOf(item) }); }
        else if (inHunks(hunks, item.comment.side, item.endLine)) list.push({ side, lineNumber: item.endLine, metadata: keyOf(item) });
      }
      const draft = draftKey();
      // A draft whose lines the diff no longer shows stays on screen, above the first hunk.
      if (shown && (shown.lost === 'away' ? top : inHunks(hunks, shown.side, shown.endLine))) list.push({ side: fromSide(shown.side), lineNumber: shown.lost === 'away' ? 0 : shown.endLine, metadata: draft });
      return list;
    },
    render: (key: string) => elements.get(key),
    css(): string {
      const covered = placed.filter(open).map(p => lineSelectors(p.comment.side, p.startLine, p.endLine));
      const draft = surface.draft;
      const selected = draft && !draft.lost ? lineSelectors(draft.side, draft.startLine, draft.endLine) : null;
      return GUTTER_CSS + tinted(merge(covered), 'covered') + (selected ? tinted(selected, 'selected') : '') + forced(selected ? [...covered, selected] : covered, selected);
    },
    selecting(input: DiffSelection | null): DiffSelection | null {
      if (!input) { previewed = null; return input; }
      const { span, shown } = resolve(input);
      previewed = shown !== input && span.dropped ? { shown, dropped: span.dropped } : null;
      return shown;
    },
    select(input: DiffSelection | null): void {
      if (!input) return;
      // A range stops at the edge of the hunk it started in, and a range between deleted and added
      // lines comments on the new-side lines it covers: pierre is shown those lines.
      const { span, shown } = resolve(input);
      if (shown !== input) show(shown);
      const { side, startLine, endLine } = span;
      const dropped = span.dropped ?? (previewed && sameRange(previewed.shown, input) ? previewed.dropped : undefined);
      previewed = null;
      // The same lines again keep the draft (its field holds it); other lines move it, text and all.
      const draft = surface.draft;
      if (!draft || draft.side !== side || draft.startLine !== startLine || draft.endLine !== endLine || draft.lost) {
        surface.draft = { side, startLine, endLine, text: draft?.text ?? '', anchor: makeAnchor(sides()[side], startLine, endLine, true), ...dropped ? { dropped } : {} };
      } else if (draft.dropped?.join() !== dropped?.join()) draft.dropped = dropped;
      repaint();
      queueMicrotask(() => focusEditor(elements.get(draftKey())));
      requestAnimationFrame(() => focusEditor(elements.get(draftKey())));
    },
    attach(host: DiffReviewHost) {
      if (!hosts.size) {
        drawing.set(surface, [...(drawing.get(surface) ?? []).filter(other => other !== self), self]);
        unsubscribe = store.subscribe(changed); store.retain(surface); build();
      }
      const keys = diffKeys(host, {
        isImeKey: store.host.isImeKey,
        clamp: range => clampToHunk(hunksOf(), range),
        preview: range => resolve(range).shown,
        select: range => review.select(range),
        lineName(side, line) {
          const own = toSide(side);
          const commented = placed.some(p => open(p) && p.comment.side === own && line >= p.startLine && line <= p.endLine);
          return lineName(line, commented, side === 'deletions' ? 'Deleted line' : 'Line');
        },
      });
      hosts.set(host, keys);
      return {
        // Pierre drew: the Tab stop goes back on its line number, and a field drawn for a comment
        // that had focus (a refetched diff's) takes it back.
        rendered(): void { keys.placeSoon(); if (!isPainting()) handOff(surface); },
        detach(): void {
          keys.stop();
          hosts.delete(host);
          if (!hosts.size) {
            unsubscribe(); unsubscribe = () => {};
            const rest = (drawing.get(surface) ?? []).filter(other => other !== self);
            if (rest.length) drawing.set(surface, rest); else { drawing.delete(surface); surface.shown.clear(); }
            letGo(store, surface);
          }
          // A diff swapped for a refetched one is removed right after this: then its focused field
          // hands focus to its successor.
          queueMicrotask(() => handOff(surface));
        },
      };
    },
  } satisfies DiffReviewHooks;
  return review;
}

type KeyReview = {
  isImeKey(event: KeyboardEvent): boolean;
  /** `range` kept to the hunk it starts in. */
  clamp(range: DiffSelection): DiffSelection;
  /** The selection to show for `range`: the lines a comment on it would cover. */
  preview(range: DiffSelection): DiffSelection;
  /** Opens a comment on a range (as pierre's own selection does). */
  select(range: DiffSelection): void;
  lineName(side: DiffSide, line: number): string;
};

/**
 * The keyboard's way to line comments in a diff, whose line numbers live in pierre's shadow roots:
 * they are one Tab stop (a roving tabindex, named "Line 12, add comment"). Up and Down (Home, End)
 * move, Shift extends a range (shown with pierre's selection) up to the edge of its hunk, Enter or
 * Space opens a comment on the line or range, and Escape drops the range. A pointer press moves the
 * Tab stop too. Nothing is set up until the diff is first used (focus enters it, or a line number
 * is pressed), so a diff nobody comments on does no work after each render.
 */
function diffKeys(host: DiffReviewHost, review: KeyReview) {
  type Spot = { side: DiffSide; line: number };
  const { root } = host;
  const abort = new AbortController(), signal = abort.signal;
  // `pending`: until when a line asked for by focusLine takes focus once it is drawn.
  let roving: Spot | null = null, anchor: Spot | null = null, pending = 0, frame = 0, engaged = false;
  const numbers = () => [...root.querySelectorAll('diffs-container')].flatMap(el => [...el.shadowRoot?.querySelectorAll<HTMLElement>('[data-gutter] [data-column-number]') ?? []]);
  // Split diffs put each side in its own column; unified ones mark deleted lines by type.
  const spotOf = (el: HTMLElement): Spot => ({
    side: el.closest('[data-deletions]') ? 'deletions' : el.closest('[data-additions]') ? 'additions' : el.dataset.lineType === 'change-deletion' ? 'deletions' : 'additions',
    line: Number(el.dataset.columnNumber),
  });
  const at = (spot: Spot, el: HTMLElement) => { const here = spotOf(el); return here.side === spot.side && here.line === spot.line; };
  const numberIn = (event: Event) => { const el = event.composedPath()[0]; return el instanceof HTMLElement ? el.closest<HTMLElement>('[data-column-number]') : null; };
  const range = (from: Spot, to: Spot): DiffSelection => ({ start: from.line, side: from.side, end: to.line, endSide: to.side });

  /** Puts the Tab stop on the roving number (the first one until there is one), focusing it when asked. */
  function place(focus: boolean): void {
    const all = numbers();
    if (!all.length) return;
    const found = roving ? all.find(el => at(roving!, el)) : undefined;
    const target = found ?? all[0];
    const spot = spotOf(target);
    // A line asked for by focusLine takes focus as it is drawn (pierre redraws after the comment
    // closes), unless the user has gone elsewhere meanwhile.
    const active = document.activeElement;
    const asked = performance.now() < pending && (!active || active === document.body || root.contains(active));
    setTabStop(all, target, review.lineName(spot.side, spot.line), (focus || asked) && Boolean(found || !roving));
  }
  // Pressing a line number keeps focus in an open comment field, as in the Files view. Otherwise
  // the field's blur (an empty new comment is dropped, which clears pierre's selection and
  // rerenders) lands in the middle of a Shift-click, and pierre loses the range it extends.
  const keepFocus = (event: Event) => {
    if (event.composedPath().some(node => node instanceof Element && node.hasAttribute('data-column-number'))) event.preventDefault();
  };
  root.addEventListener('pointerdown', keepFocus, { capture: true, signal });
  root.addEventListener('mousedown', keepFocus, { capture: true, signal });
  root.addEventListener('keydown', event => {
    const el = numberIn(event);
    const command = el ? lineCommand(event, review.isImeKey) : null;
    if (!el || !command) return;
    pending = 0;
    const here = spotOf(el);
    if (command === 'cancel') {
      if (!anchor) return;
      event.preventDefault(); event.stopPropagation();
      anchor = null; host.show(null);
      return;
    }
    event.preventDefault();
    if (command === 'open') {
      const from = anchor ?? here;
      anchor = null;
      roving = here;
      review.select(range(from, here));
      return;
    }
    const all = numbers(), index = all.indexOf(el);
    const to = command === 'next' ? all[index + 1] : command === 'previous' ? all[index - 1] : command === 'first' ? all[0] : all.at(-1);
    if (!to) return;
    let target = to;
    if (event.shiftKey) {
      const from = anchor ??= here;
      // A range stays in the hunk it started in: it stops at the hunk's edge.
      const within = (other: HTMLElement) => { const wanted = range(from, spotOf(other)), kept = review.clamp(wanted); return kept.end === wanted.end && kept.endSide === wanted.endSide; };
      const goal = all.indexOf(to), step = goal > index ? 1 : -1;
      let i = index;
      while (i !== goal && within(all[i + step])) i += step;
      target = all[i];
      host.show(review.preview(range(from, spotOf(target))));
    } else if (anchor) { anchor = null; host.show(null); }
    roving = spotOf(target);
    place(true);
  }, { signal });
  root.addEventListener('pointerdown', event => {
    const el = numberIn(event);
    if (!el) return;
    roving = spotOf(el); anchor = null; pending = 0; engaged = true;
    place(false);
  }, { signal });
  root.addEventListener('focusin', event => {
    // Focus going anywhere else in the diff (another comment's field, the content strip) drops a
    // line asked for by focusLine: a redraw meanwhile (a comment deleted) must not take it back.
    if (!numberIn(event)) pending = 0;
    // Focus entering the diff (its content strip first) puts the Tab stop on the line numbers.
    if (!engaged) { engaged = true; place(false); }
    // A focused line number draws its own ring, so the diff's shared one stays off (changes-view.css).
    root.toggleAttribute('data-line-focus', Boolean(numberIn(event)));
  }, { signal });
  root.addEventListener('focusout', () => root.removeAttribute('data-line-focus'), { signal });
  // The tooltip is set as a number is first pointed at, not on every row up front.
  root.addEventListener('pointerover', event => {
    const el = numberIn(event);
    if (el && !el.title) el.title = COMMENT_HINT;
  }, { signal });
  // Hooks that arrive after the diff (their code loads alongside it) find focus already inside it:
  // the Tab stop goes on the line numbers as pierre draws them again.
  if (root.contains(document.activeElement)) engaged = true;
  return {
    /** After pierre draws (rows replaced, more rows mounted): once a frame, however many renderers drew. */
    placeSoon(): void { if (engaged && !frame && !signal.aborted) frame = requestAnimationFrame(() => { frame = 0; place(false); }); },
    focusLine(side: DiffSide, line: number): void {
      roving = { side, line }; pending = performance.now() + 2000; engaged = true;
      place(false);
      this.placeSoon();
    },
    stop(): void { abort.abort(); cancelAnimationFrame(frame); },
  };
}
