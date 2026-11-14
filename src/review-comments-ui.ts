/* Line comments' inline UI (docs/line-comments.md), loaded by `reviewUi()` in review-comments.ts the
 * first time a code file or a Changes diff is shown with a thread (or the Changes view has comments
 * no view shows): the comment fields and their focus hand-off, the line numbers' keys, the Files
 * view's line numbers (`mountFileComments`) and the group of comments no view shows
 * (`mountAwayComments`). A Changes diff's hooks and keyboard path are review-comments-diff.ts,
 * which builds on this module. The store and the Send button stay in review-comments.ts, loaded at
 * startup. */
import './review-comments.css';
import { announce, capital, draftExtras, droppedNote, MAX_COMMENT_LENGTH, rangeLabel, unshownComments, type CommentSurface, type Draft, type ReviewSide, type ReviewStore } from './review-comments';
import { makeAnchor, placeDraft, reconcileComments, type PlacedComment } from './review-anchor';

const CLOSE_ICON = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true"><path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" fill="none"/></svg>';
/** What a field says before it has text: a new one invites a comment and names its save key; an
 * emptied saved one says Escape undoes that. Kept to one row in a diff at the inspector's default
 * width, whose field has about 148px for it with Linux's fallback font ("Add a comment · Ctrl+↵
 * saves" needs 181px). The field's description says all of it (Escape, leaving it, the × button). */
const placeholder = (mac: boolean, fresh: boolean) => fresh ? `Comment · ${mac ? '⌘↵' : 'Ctrl+↵'} saves` : 'Comment · Esc undoes';
/** The field's description: every key, and the × button. */
const fieldKeys = (mac: boolean, fresh: boolean) => fresh
  ? `${mac ? 'Command-Return' : 'Control-Enter'}, Escape or leaving the field saves it; left empty, it is discarded. Discard comment throws it away.`
  : `${mac ? 'Command-Return' : 'Control-Enter'} or leaving the field saves it; Escape undoes the edit. Emptied, or with Delete comment, it is deleted.`;
/** How to start a comment: the line numbers' tooltip. */
export const COMMENT_HINT = 'Click to comment · drag or Shift-click for a range';

/** Set while a surface repaints: a field it replaces or moves is not being left by the user. */
let painting = false;
export const isPainting = (): boolean => painting;
function whilePainting(paint: () => void): void {
  const was = painting;
  painting = true;
  try { paint(); } finally { painting = was; }
}
/** What leaving each field does (saving it), for a hand-off that finds the user has moved on. */
const leavers = new WeakMap<HTMLTextAreaElement, () => void>();
/** A field's hidden copy of its text (its placeholder while empty), which sizes it. */
const syncSize = (area: HTMLTextAreaElement) => { (area.parentElement as HTMLElement).dataset.value = area.value || area.placeholder; };

type Caret = readonly [start: number, end: number, scroll: number];

/**
 * The one focus hand-off for comment fields. A repaint can replace a focused field (the file view
 * draws its rows again), move it (pierre re-keys annotation wrappers by index, so removing an
 * earlier comment moves a later one's element, which drops its focus), or a whole view can be drawn
 * again (a refetched diff, a re-rendered file tab). The field that had focus (`surface.focused`,
 * kept until the user leaves it) hands focus, caret and unsaved text to the field now on the page
 * for the same comment, which may be itself. If the user has moved on meanwhile (focus is somewhere
 * else), the field is saved as leaving it would: a blur ignored during a repaint loses no text.
 */
export function handOff(surface: CommentSurface, caret?: Caret): void {
  const lost = surface.focused;
  if (!lost || document.activeElement === lost) return;
  const next = surface.fields.get(lost.dataset.rcField ?? '');
  // Not drawn yet: the view that draws it hands focus over then (`rendered`, or its paint).
  if (!next?.isConnected) return;
  const active = document.activeElement;
  if (active && active !== document.body) { surface.focused = null; leavers.get(next)?.(); return; }
  if (next !== lost && next.value !== lost.value) { next.value = lost.value; syncSize(next); }
  const [start, end, scroll] = caret ?? [lost.selectionStart, lost.selectionEnd, lost.scrollTop];
  next.focus({ preventScroll: true });
  next.setSelectionRange(start, end);
  next.scrollTop = scroll;
}
/** How many of a surface's users are the Changes view's group of comments no view shows, which
 * draws saved comments only, never the one being written (`mountAwayComments`). */
const listing = new WeakMap<CommentSurface, number>();
/** Views drawing `surface` that can draw the comment being written in it. */
const drawers = (surface: CommentSurface) => surface.users - (listing.get(surface) ?? 0);
/**
 * A view stops drawing `surface`. A field it left with focus (its tab closed, the thread switched)
 * would keep the surface, and a hand-off long afterwards would save it or take focus back. So once
 * no view has taken the surface again (a view drawn again mounts in the same task, a refetched diff
 * before the old one goes), the field is left as a blur would leave it: its text saved, a new
 * comment holding text added, an empty one dropped. Then the surface can go. The group of comments
 * no view shows does not count as taking it: it lists saved comments only, so a comment being
 * written when the agent commits its file is saved and listed there, not kept out of sight.
 */
export function letGo(store: ReviewStore, surface: CommentSurface): void {
  store.release(surface);
  const lost = surface.focused;
  if (!lost || drawers(surface)) return;
  // A view's elements may leave the page just after it stops drawing them.
  setTimeout(() => {
    if (drawers(surface) || surface.focused !== lost || lost.isConnected) return;
    surface.focused = null;
    leavers.get(lost)?.();
    // With no view drawing it, this only lets it go now that nothing is unsaved.
    if (!surface.users) store.release(surface);
  });
}
/** Repaints a surface, keeping a focused comment field focused, with its caret, across it. */
export function repaintKeepingFocus(surface: CommentSurface, paint: () => void): void {
  const area = surface.focused, active = area && document.activeElement === area;
  const caret: Caret | undefined = active ? [area.selectionStart, area.selectionEnd, area.scrollTop] : undefined;
  whilePainting(paint);
  handOff(surface, caret);
}

type FieldActions = {
  label: string; value: string; deleteLabel: string;
  /** A new comment's field (Escape saves and closes it) rather than a saved one's (Escape undoes the edit). */
  fresh: boolean;
  input(text: string): void;
  /** Leaving the field (blur, or Cmd/Ctrl+Enter: `byKey`) saves what it holds. */
  leave(area: HTMLTextAreaElement, byKey: boolean): void;
  /** Escape. */
  cancel(area: HTMLTextAreaElement): void;
  remove(): void;
};

/**
 * A comment's text, editable in place: there is no Save or Edit button. Leaving the field saves it.
 * It is one row tall for one line and grows with its text to three rows, then scrolls: a hidden copy
 * of the text (of the placeholder while empty) in the same grid cell (`.rc-field::after`, from
 * `data-value`) sizes it, so the height is right as soon as it is on the page, with no measuring.
 * `id` names it on its surface (a comment id, or `new` for the draft), so a view drawn again can
 * hand focus to its successor.
 */
function commentBody(store: ReviewStore, surface: CommentSurface, id: string, actions: FieldActions): HTMLElement {
  const body = document.createElement('div');
  body.className = 'rc-body';
  const field = document.createElement('div'), area = document.createElement('textarea'), remove = document.createElement('button');
  field.className = 'rc-field';
  const mac = Boolean(store.host.mac);
  Object.assign(area, { rows: 1, dir: 'auto', maxLength: MAX_COMMENT_LENGTH, placeholder: placeholder(mac, actions.fresh) });
  area.setAttribute('aria-label', actions.label);
  area.setAttribute('aria-description', fieldKeys(mac, actions.fresh));
  Object.assign(remove, { type: 'button', className: 'rc-delete', title: actions.deleteLabel, innerHTML: CLOSE_ICON });
  remove.setAttribute('aria-label', actions.deleteLabel);
  field.append(area);
  body.append(field, remove);
  area.value = actions.value;
  area.dataset.rcField = id;
  surface.fields.set(id, area);
  syncSize(area);
  let byKey = false;
  leavers.set(area, () => actions.leave(area, false));
  area.addEventListener('input', () => { syncSize(area); actions.input(area.value); });
  area.addEventListener('focus', () => { surface.focused = area; });
  area.addEventListener('keydown', event => {
    if (store.host.isImeKey(event)) return;
    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
      event.preventDefault(); event.stopPropagation();
      byKey = true;
      try { area.blur(); } finally { byKey = false; }
    } else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); actions.cancel(area); syncSize(area); }
  });
  area.addEventListener('blur', () => {
    // Replaced or moved by a repaint, or removed with its view: not left by the user (the hand-off
    // gives focus back, or saves it if the user has moved on). Chrome blurs a focused element just
    // before removing it, so whether it was removed is known only once that is done.
    if (painting) return;
    const key = byKey;
    queueMicrotask(() => {
      if (!area.isConnected || document.activeElement === area) return;
      if (surface.focused === area) surface.focused = null;
      actions.leave(area, key);
    });
  });
  // Pressing × keeps focus in the field, so the field is not left (and a new comment saved) first.
  remove.addEventListener('mousedown', event => event.preventDefault());
  remove.addEventListener('click', event => { event.stopPropagation(); actions.remove(); });
  // Clicks inside never reach line selection or the viewers' own handlers.
  for (const type of ['pointerdown', 'mousedown', 'click'] as const) body.addEventListener(type, event => event.stopPropagation());
  return body;
}

function threadElement(label: string, status: string): HTMLElement {
  const el = document.createElement('div');
  el.className = 'rc-thread';
  el.dataset.status = status;
  el.setAttribute('role', 'group');
  el.setAttribute('aria-label', label);
  for (const type of ['pointerdown', 'mousedown'] as const) el.addEventListener(type, event => event.stopPropagation());
  return el;
}

/** The line above a comment's text: an Outdated badge, and a note saying why it is not beside its
 * lines (or not all of them are highlighted). */
function head(card: HTMLElement, outdated: boolean, note: string): void {
  if (!outdated && !note) return;
  const row = document.createElement('div');
  row.className = 'rc-head';
  if (outdated) {
    const badge = document.createElement('span');
    badge.className = 'rc-badge';
    badge.dataset.rcStatus = 'outdated';
    badge.textContent = 'Outdated';
    row.append(badge);
  }
  if (note) {
    const text = document.createElement('span');
    text.className = 'rc-note';
    text.textContent = note;
    row.append(text);
  }
  card.append(row);
}

/** One comment: its text, editable in place, with a delete button; an outdated one carries a badge,
 * and `note` says why it is not next to its lines (or not all of them are highlighted). A diff
 * comment drawn across deleted and added lines also says which deleted lines it left out, as its
 * field did while it was written. */
export function commentElement(store: ReviewStore, surface: CommentSurface, placed: PlacedComment, note = ''): HTMLElement {
  const { comment } = placed;
  const id = comment.id;
  const label = `Comment on ${rangeLabel(placed.startLine, placed.endLine)}`;
  const el = threadElement(label, placed.outdated ? 'outdated' : 'open');
  el.dataset.rcId = id;
  const card = document.createElement('div');
  card.className = 'rc-card';
  head(card, placed.outdated, [note, capital(droppedNote(comment.dropped))].filter(Boolean).join(' · '));
  // Deleted (×, or emptied and left), it can be brought back for a few seconds: the app's toast
  // offers Undo (and Cmd/Ctrl+Z), and says so to screen readers.
  const drop = () => {
    surface.live.delete(id); surface.fields.delete(id);
    if (surface.focused?.dataset.rcField === id) surface.focused = null;
    const thread = surface.thread, all = store.all(thread), index = all.findIndex(c => c.id === id), kept = all[index];
    store.remove(id, thread);
    if (!kept || !store.host.undoable) { announce('Comment deleted'); return; }
    store.host.undoable('Comment deleted', () => { if (store.restore(kept, index, thread)) announce('Comment restored'); });
  };
  card.append(commentBody(store, surface, id, {
    label, deleteLabel: 'Delete comment', fresh: false,
    value: surface.live.get(id) ?? comment.text,
    input: text => { surface.live.set(id, text); store.typing(surface.thread); },
    leave: area => {
      const text = area.value.trim();
      surface.live.delete(id);
      // No text is no comment: emptied and left, it is deleted, like a new one left empty.
      if (!text) drop();
      else if (text !== comment.text) store.update({ id, text }, surface.thread);
    },
    cancel: area => { surface.live.delete(id); store.typing(surface.thread); area.value = comment.text; area.blur(); },
    remove: drop,
  }));
  el.append(card);
  return el;
}

/** Why a draft is not on the lines it was started on (placeDraft), or which deleted lines a range
 * between deleted and added lines leaves out (selectionSpan). */
function draftNote(draft: Draft): string {
  const lines = capital(rangeLabel(draft.startLine, draft.endLine)), one = draft.startLine === draft.endLine;
  if (draft.lost) return draft.lost === 'changed' ? `${lines} changed while you were writing` : `${lines} ${one ? 'is' : 'are'} no longer in this diff`;
  return capital(droppedNote(draft.dropped));
}

/**
 * The field for a new comment on the selected lines. It looks like a saved comment: leaving it with
 * text saves it, and the saved comment takes its place in the same paint, so nothing below moves.
 * Escape saves it too (typed text is never thrown away by a key); left empty it goes away, as it
 * does with ×. `done` runs as it goes (`byKey`: Escape or Cmd/Ctrl+Enter, after which the view puts
 * focus back on the line number). A draft whose lines changed under it says so.
 */
export function draftElement(store: ReviewStore, surface: CommentSurface, repaint: () => void, done: (byKey: boolean, draft: Draft) => void): HTMLElement {
  const draft = surface.draft!;
  const range = rangeLabel(draft.startLine, draft.endLine);
  const el = threadElement(`New comment on ${range}`, 'draft');
  el.classList.add('rc-new');
  const discard = (byKey = false) => {
    if (surface.draft !== draft) return;
    surface.draft = null;
    if (surface.focused?.dataset.rcField === 'new') surface.focused = null;
    // Send counted it while it held text, and storage kept it.
    if (draft.text.trim()) { store.typed(); store.typing(surface.thread); }
    done(byKey, draft); repaint();
  };
  const save = (area: HTMLTextAreaElement, byKey: boolean) => {
    const text = area.value.trim();
    if (!text) { discard(byKey); return; }
    if (surface.draft !== draft) return;
    if (surface.focused?.dataset.rcField === 'new') surface.focused = null;
    // Anchored to the code it was written on (taken when the lines were picked).
    // Lines that changed under it: saved as Outdated, against the code it was written on.
    const saved = store.add({ file: surface.file, side: draft.side, startLine: draft.startLine, endLine: draft.endLine, anchor: draft.anchor, text, ...draftExtras(draft) }, {
      thread: surface.thread,
      beforeShow: () => { surface.draft = null; done(byKey, draft); },
    });
    if (saved) announce(`Comment added on ${range}`);
  };
  const card = document.createElement('div');
  card.className = 'rc-card';
  head(card, false, draftNote(draft));
  card.append(commentBody(store, surface, 'new', {
    label: `Comment on ${range}`, deleteLabel: 'Discard comment', fresh: true,
    value: draft.text,
    input: text => {
      const had = Boolean(draft.text.trim());
      draft.text = text;
      // The Send button counts a new comment holding text.
      if (had !== Boolean(text.trim())) store.typed();
      store.typing(surface.thread);
    },
    leave: save,
    cancel: area => save(area, true),
    remove: () => discard(),
  }));
  el.append(card);
  return el;
}

export function focusEditor(scope: Element | null | undefined): void {
  const area = scope?.querySelector<HTMLTextAreaElement>('.rc-field textarea');
  if (!area) return;
  area.focus({ preventScroll: true });
  area.setSelectionRange(area.value.length, area.value.length);
  area.scrollIntoView({ block: 'nearest' });
}

/* ---------- Line numbers: shared by both views ---------- */

/** What a line number says to assistive technology. */
export const lineName = (line: number, commented: boolean, prefix = 'Line') => `${prefix} ${line}${commented ? ', commented' : ''}, add comment`;

/** What a key does on the line numbers, the same in both views. */
export type LineCommand = 'cancel' | 'open' | 'next' | 'previous' | 'first' | 'last';
export function lineCommand(event: KeyboardEvent, isImeKey: (event: KeyboardEvent) => boolean): LineCommand | null {
  if (event.altKey || event.metaKey || event.ctrlKey) return null;
  switch (event.key) {
    case 'Escape': return isImeKey(event) ? null : 'cancel';
    case 'Enter': case ' ': return isImeKey(event) ? null : 'open';
    case 'ArrowDown': return 'next';
    case 'ArrowUp': return 'previous';
    case 'Home': return 'first';
    case 'End': return 'last';
    default: return null;
  }
}

/** Makes `target` the line numbers' one Tab stop (a roving tabindex), named for assistive
 * technology, taking it from `others`; focuses it when asked. */
export function setTabStop(others: Iterable<HTMLElement | null>, target: HTMLElement, label: string, focus: boolean): void {
  for (const el of others) if (el && el !== target && el.hasAttribute('tabindex')) { el.removeAttribute('tabindex'); el.removeAttribute('role'); el.removeAttribute('aria-label'); }
  target.tabIndex = 0;
  target.setAttribute('role', 'button');
  target.setAttribute('aria-label', label);
  if (focus) { target.focus({ preventScroll: true }); target.scrollIntoView({ block: 'nearest' }); }
}

/* ---------- The first-use hint ---------- */

/** Set once the user has made a comment: the hint never shows again. */
export const HINT_SEEN_KEY = 'pandacode.lineCommentHintSeen';
export const HINT_TEXT = 'Click a line number to comment';
const hintSeen = () => { try { return localStorage.getItem(HINT_SEEN_KEY) !== null; } catch { return true; } };

/**
 * A faint line saying how to start a comment, put first in `host` (the code preview's toolbar, the
 * Changes list) until the user makes a first comment, in any thread; then every hint goes and the
 * flag (HINT_SEEN_KEY) keeps them gone. Views only mount it with a thread, so it never shows where
 * comments cannot be made. Returns a disposer.
 */
export function mountCommentHint(host: HTMLElement, store: ReviewStore, thread = store.sessionId): () => void {
  if (hintSeen()) return () => {};
  const hint = document.createElement('p');
  hint.className = 'rc-hint';
  hint.textContent = HINT_TEXT;
  let stopped = false;
  const stop = () => { if (stopped) return; stopped = true; unsubscribe(); hint.remove(); };
  const check = () => {
    if (!store.all(thread).length && !hintSeen()) return;
    try { localStorage.setItem(HINT_SEEN_KEY, '1'); } catch { /* shown again next launch */ }
    stop();
  };
  host.prepend(hint);
  const unsubscribe = store.subscribe(check);
  check();
  return stop;
}

/* ---------- File view: the code preview's line numbers ---------- */

/**
 * Adds line comments to a rendered code preview (`.code-preview` with `.code-line[data-line]`):
 * click a line number to comment on it, or drag across numbers or Shift-click a second number for
 * a range. From the keyboard the line numbers are one Tab stop (a roving tabindex): Up and Down
 * (Home, End) move, Shift extends a range, Enter or Space opens the comment. `thread` is the thread
 * the file was opened in. Returns a disposer.
 */
export function mountFileComments(preview: HTMLElement, store: ReviewStore, file: string, content: string, thread = store.sessionId): () => void {
  const lines = content.split('\n');
  const surface = store.surface('file', file, thread);
  store.retain(surface);
  let anchorLine = 0, dragging = false, selecting: { start: number; end: number } | null = null, disposed = false;
  // The roving line number, and where a Shift+Arrow range started.
  let current = 0, keyAnchor = 0;
  const covered = new Set<number>();
  const abort = new AbortController(), signal = abort.signal;
  preview.classList.add('rc-commentable');
  const row = (line: number) => preview.querySelector<HTMLElement>(`.code-line[data-line="${line}"]`);
  const number = (line: number) => row(line)?.querySelector<HTMLElement>('.line-number') ?? null;
  const shownLines = () => preview.querySelectorAll('.code-line').length;
  const lineOf = (node: Node | null): number => Number((node instanceof Element ? node : node?.parentElement)?.closest<HTMLElement>('.code-line')?.dataset.line ?? 0);

  const describe = (el: HTMLElement) => {
    const text = el.classList.contains('rc-selected') ? 'Selected for a comment' : el.classList.contains('rc-covered') ? 'Commented' : '';
    if (text) el.setAttribute('aria-description', text); else el.removeAttribute('aria-description');
  };
  function mark(start: number, end: number, cls: string): void {
    for (let line = start; line <= end; line++) {
      const el = row(line); if (!el) continue;
      el.classList.add(cls);
      if (line === start) el.classList.add(`${cls}-first`);
      if (line === end) el.classList.add(`${cls}-last`);
      describe(el);
    }
  }
  /** Makes `line`'s number the one Tab stop of the line numbers, and focuses it when asked. */
  function rove(line: number, focus: boolean): void {
    const last = shownLines();
    if (!last) return;
    line = Math.min(Math.max(line, 1), last);
    const before = current;
    current = line;
    const el = number(line);
    if (el) setTabStop([before ? number(before) : null], el, lineName(line, covered.has(line)), focus);
  }
  function paint(): void {
    if (!preview.isConnected) { dispose(); return; }
    const shown = shownLines();
    repaintKeepingFocus(surface, () => {
      preview.querySelectorAll('.rc-thread').forEach(el => el.remove());
      preview.querySelectorAll<HTMLElement>('.rc-covered, .rc-selected').forEach(el => {
        el.classList.remove('rc-covered', 'rc-covered-first', 'rc-covered-last', 'rc-selected', 'rc-selected-first', 'rc-selected-last');
        describe(el);
      });
      covered.clear();
      const { placed, updates } = reconcileComments(store.forFile(file, ['file'], thread), lines);
      store.persist(updates, thread);
      surface.shown = new Set(placed.filter(item => item.comment.status === 'open' && !item.outdated).map(item => item.comment.id));
      const below = new Map<number, HTMLElement[]>();
      const add = (line: number, el: HTMLElement) => below.set(line, [...below.get(line) ?? [], el]);
      for (const item of placed.sort((a, b) => a.endLine - b.endLine || a.comment.createdAt - b.comment.createdAt)) {
        if (item.comment.status === 'open' && !item.outdated) {
          mark(item.startLine, item.endLine, 'rc-covered');
          for (let line = item.startLine; line <= item.endLine; line++) covered.add(line);
        }
        // The preview shows the first lines only: a comment further down sits after the last row, saying so.
        const past = item.endLine > shown ? `${capital(rangeLabel(item.startLine, item.endLine))}, past the preview's ${shown.toLocaleString('en-US')} lines` : '';
        add(Math.min(item.endLine, shown), commentElement(store, surface, item, past));
      }
      // A draft follows its lines when the content changed under it; one whose lines are gone stays
      // where it was, saying so, and is not highlighted.
      const draft = surface.draft;
      if (draft) placeDraft(draft, lines);
      if (draft && !draft.lost) mark(draft.startLine, draft.endLine, 'rc-selected');
      else if (!draft && selecting) mark(selecting.start, selecting.end, 'rc-selected');
      if (draft) add(Math.min(draft.endLine, Math.max(shown, 1)), draftElement(store, surface, paint, (byKey, draft) => {
        anchorLine = 0;
        // Escape or Cmd/Ctrl+Enter: back to the line number, once the field is gone.
        if (byKey) queueMicrotask(() => rove(draft.endLine, true));
      }));
      for (const [line, els] of below) (row(line) ?? [...preview.querySelectorAll('.code-line')].at(-1))?.after(...els);
    });
    rove(current || 1, false);
  }
  const startDraft = (start: number, end: number) => {
    const [a, b] = start <= end ? [start, end] : [end, start];
    // Picking other lines moves an unsaved draft, text and all.
    const draft = surface.draft;
    if (!draft || draft.startLine !== a || draft.endLine !== b || draft.lost) surface.draft = { side: 'file', startLine: a, endLine: b, text: draft?.text ?? '', anchor: makeAnchor(lines, a, b) };
    selecting = null;
    paint();
    focusEditor(preview.querySelector('.rc-new'));
  };
  const select = (start: number, end: number) => { selecting = { start: Math.min(start, end), end: Math.max(start, end) }; showSelecting(); };
  function showSelecting(): void {
    preview.querySelectorAll<HTMLElement>('.rc-selected').forEach(el => { el.classList.remove('rc-selected', 'rc-selected-first', 'rc-selected-last'); describe(el); });
    if (selecting) mark(selecting.start, selecting.end, 'rc-selected');
  }

  preview.addEventListener('pointerdown', event => {
    const target = (event.target as Element).closest('.line-number');
    if (!target || event.button !== 0) return;
    const line = lineOf(target); if (!line) return;
    event.preventDefault();
    window.getSelection()?.removeAllRanges();
    if (!event.shiftKey || !anchorLine) anchorLine = line;
    dragging = true;
    keyAnchor = 0;
    rove(line, false);
    select(anchorLine, line);
    try { preview.setPointerCapture(event.pointerId); } catch { /* synthetic pointers */ }
  }, { signal });
  preview.addEventListener('pointermove', event => {
    if (!dragging) return;
    const line = lineOf(document.elementFromPoint(event.clientX, event.clientY));
    if (line) select(anchorLine, line);
  }, { signal });
  // The tooltip is set as a number is first pointed at, not on every row up front.
  preview.addEventListener('pointerover', event => {
    const target = (event.target as Element).closest<HTMLElement>('.line-number');
    if (target && !target.title) target.title = COMMENT_HINT;
  }, { signal });
  const finish = () => {
    if (!dragging) return;
    dragging = false;
    if (selecting) startDraft(selecting.start, selecting.end);
  };
  preview.addEventListener('pointerup', finish, { signal });
  preview.addEventListener('pointercancel', () => { dragging = false; selecting = null; showSelecting(); }, { signal });
  preview.addEventListener('keydown', event => {
    const command = lineCommand(event, store.host.isImeKey);
    // Escape drops a range being picked, wherever focus is in the preview.
    if (command === 'cancel') {
      if (!selecting) return;
      event.preventDefault();
      selecting = null; keyAnchor = 0; showSelecting();
      return;
    }
    const target = (event.target as Element).closest?.('.line-number');
    const line = target ? lineOf(target) : 0;
    if (!line || !command) return;
    event.preventDefault();
    if (command === 'open') {
      const [start, end] = selecting ? [selecting.start, selecting.end] : [line, line];
      anchorLine = start; keyAnchor = 0;
      startDraft(start, end);
      return;
    }
    const last = shownLines();
    const to = command === 'next' ? Math.min(line + 1, last) : command === 'previous' ? Math.max(line - 1, 1) : command === 'first' ? 1 : last;
    if (event.shiftKey) { keyAnchor ||= line; select(keyAnchor, to); }
    else if (selecting) { keyAnchor = 0; selecting = null; showSelecting(); }
    rove(to, true);
  }, { signal });

  const unsubscribe = store.subscribe(paint);
  // The code's toolbar (Wrap) says how to start a comment until the first one is made.
  const toolbar = preview.parentElement?.querySelector<HTMLElement>(':scope > .doc-toolbar');
  const stopHint = toolbar ? mountCommentHint(toolbar, store, thread) : () => {};
  function dispose(): void {
    if (disposed) return;
    disposed = true;
    abort.abort(); unsubscribe(); stopHint(); letGo(store, surface);
    if (!surface.users) surface.shown.clear();
  }
  paint();
  return dispose;
}

/* ---------- Changes view: comments no view shows ---------- */

/** The group's title and name. */
export const AWAY_TITLE = 'Comments on files not shown';

/**
 * Comments no view shows, yet Send still counts and sends: diff comments whose file the Changes list
 * no longer shows (the agent committed or reverted it, or the scope hides it) or shows only as plain
 * text, and Files view comments on files with no tab open (closed, or the file deleted or renamed).
 * This group, at the top of the Changes list, shows each with its file and lines, editable in place
 * and deletable like in its view. `listed` says whether the list shows a file's diff. The Changes
 * view mounts it only once such a comment exists, and calls `update()` when the list or the
 * comments change; it redraws only when its comments did. `thread` is the thread the Changes view
 * was drawn for, so during a thread switch it never draws the next thread's comments. Returns
 * `update` and `dispose`.
 */
export function mountAwayComments(container: HTMLElement, store: ReviewStore, listed: (file: string) => boolean, thread = store.sessionId): { update(): void; dispose(): void } {
  let painted = '', held = new Set<CommentSurface>();
  container.classList.add('rc-away');
  container.setAttribute('role', 'group');
  container.setAttribute('aria-label', AWAY_TITLE);
  const surfaceOf = (c: { file: string; side: ReviewSide }) => store.surface(c.side === 'file' ? 'file' : 'diff', c.file, thread);
  function update(): void {
    const comments = unshownComments(store, listed, thread);
    const signature = `${thread}\n${comments.map(c => `${c.id}\0${c.file}\0${c.side}\0${c.startLine}\0${c.endLine}\0${c.status}\0${c.text}`).join('\n')}`;
    if (signature === painted) return;
    painted = signature;
    const surfaces = new Set(comments.map(surfaceOf));
    const paint = () => {
      container.hidden = !comments.length;
      if (!comments.length) { container.replaceChildren(); return; }
      const title = document.createElement('div');
      title.className = 'rc-away-title';
      title.textContent = AWAY_TITLE;
      const items = comments.map(comment => {
        const item = document.createElement('div');
        item.className = 'rc-away-item';
        const where = document.createElement('div');
        where.className = 'rc-away-where';
        const path = document.createElement('span'), lines = document.createElement('span');
        path.className = 'rc-away-file'; path.textContent = path.title = comment.file;
        lines.className = 'rc-away-lines';
        const note = comment.side === 'old' ? ' (deleted lines)' : comment.side === 'file' ? ' (Files view)' : '';
        lines.textContent = `${capital(rangeLabel(comment.startLine, comment.endLine))}${note}`;
        where.append(path, lines);
        item.append(where, commentElement(store, surfaceOf(comment), { comment, startLine: comment.startLine, endLine: comment.endLine, outdated: comment.status === 'outdated' }));
        return item;
      });
      container.replaceChildren(title, ...items);
    };
    // A field being edited here keeps focus, caret and text across the redraw.
    const active = [...surfaces].find(surface => surface.focused && surface.focused === document.activeElement);
    if (active) repaintKeepingFocus(active, paint); else whilePainting(paint);
    for (const surface of surfaces) if (!held.has(surface)) hold(surface);
    for (const surface of held) if (!surfaces.has(surface)) drop(surface);
    held = surfaces;
  }
  function hold(surface: CommentSurface): void {
    listing.set(surface, (listing.get(surface) ?? 0) + 1);
    store.retain(surface);
  }
  function drop(surface: CommentSurface): void {
    listing.set(surface, Math.max(0, (listing.get(surface) ?? 0) - 1));
    letGo(store, surface);
  }
  update();
  return {
    update,
    dispose(): void {
      painted = '';
      container.hidden = true;
      container.replaceChildren();
      for (const surface of held) drop(surface);
      held = new Set();
    },
  };
}
