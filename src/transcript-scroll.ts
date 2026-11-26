/** Movement smaller than this (px) is rounding, not the reader. */
const SCROLL_EPSILON = 0.5;

const scrollRounding = new WeakMap<HTMLElement, { top: number; remainder: number }>();

/** Sets `transcript`'s scrollTop to `top`, remembering what a webview that rounds scrollTop to whole pixels dropped,
 *  so the next restore (scrollRemainder) can carry it instead of drifting a pixel at a time. */
export function restoreScrollTop(transcript: HTMLElement, top: number): void {
  // A write that would not move the scroller is skipped: in WKWebView any scrollTop assignment, even to the current
  // value, ends the reader's momentum scroll mid-glide.
  const moves = Math.abs(top - transcript.scrollTop) >= SCROLL_EPSILON;
  if (moves) transcript.scrollTop = top;
  recordRounding(transcript, top);
  if (moves) anchorListeners.get(transcript)?.forEach(listener => listener(transcript.scrollTop));
}

const anchorListeners = new WeakMap<HTMLElement, readonly ((top: number) => void)[]>();
/** Calls `listener` with the new scrollTop whenever restoreScrollTop moves `transcript` (an anchor restore from any
 *  caller: a Markdown paint, a reply's clamp, a step up), so its owner records the position before the scroll event
 *  arrives and never reads the restore as the reader moving. */
export function onAnchorRestore(transcript: HTMLElement, listener: (top: number) => void): void {
  anchorListeners.set(transcript, [...(anchorListeners.get(transcript) ?? []), listener]);
}

/** restoreScrollTop's bookkeeping, always writing: for our own animation (createSmoothScroller), which must land
 *  exactly and is cancelled by any scroll of the reader's, so it never runs during their momentum. */
function writeScrollTop(transcript: HTMLElement, top: number): void {
  transcript.scrollTop = top;
  recordRounding(transcript, top);
}

function recordRounding(transcript: HTMLElement, top: number): void {
  const actual = transcript.scrollTop, remainder = top - actual;
  // Some webviews round scrollTop to whole pixels. Carry only rounding error,
  // never a clamped scroll, so many async code-block paints cannot add up to a jump.
  scrollRounding.set(transcript, { top: actual, remainder: Math.abs(remainder) < 1 ? remainder : 0 });
}

/** The fraction of a pixel the last restoreScrollTop lost to rounding, while nothing has scrolled since; else 0. */
export function scrollRemainder(transcript: HTMLElement): number {
  const previous = scrollRounding.get(transcript);
  return previous?.top === transcript.scrollTop ? previous.remainder : 0;
}

function viewport(transcript: HTMLElement): { top: number; bottom: number; scale: number } {
  const rect = transcript.getBoundingClientRect();
  // Surfaces use border-box sizing. Keep fractional layout pixels: offsetHeight
  // rounds them, which magnifies anchoring errors over a long prepended page.
  const style = getComputedStyle(transcript), height = parseFloat(style.height);
  const scale = height > 0 && rect.height > 0 ? rect.height / height : 1;
  // The reading line sits below anything floating over the transcript (the frosted header,
  // its fade, the team bars), which scroll-padding-top clears; anchor to what is read there.
  const clear = (parseFloat(style.scrollPaddingTop) || 0) * scale;
  return { top: Math.min(rect.top + clear, rect.bottom), bottom: rect.bottom, scale };
}

/** The transcript's rows crossing the band from `top` to `bottom`: a binary search, since they stack in order,
 *  so a long thread costs a few reads rather than one per message. Hidden rows have no place and are stepped over. */
function rowsInBand(transcript: HTMLElement, top: number, bottom: number, skip?: (row: Element) => boolean): Element[] {
  // Rows `skip` names (set aside, out of layout, far from the band) are never read: reading one would lay it out.
  const rows = skip ? [...transcript.children].filter(row => !skip(row)) : transcript.children;
  let low = 0, high = rows.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    let at = middle;
    while (at < high && !rows[at].getClientRects().length) at++;
    if (at === high) high = middle;
    else if (rows[at].getBoundingClientRect().bottom > top) high = middle;
    else low = at + 1;
  }
  const found: Element[] = [];
  for (let index = low; index < rows.length; index++) {
    if (!rows[index].getClientRects().length) continue;
    if (rows[index].getBoundingClientRect().top >= bottom) break;
    found.push(rows[index]);
  }
  return found;
}

/** Preserve the visible message or tool while content is inserted above it. `skip` names rows the search must not read
 *  (transcript-window.ts skipFarRows). The returned call takes what writes still to come will change above the reader
 *  (holdPlace's `pending`); callers that finish every write before restoring pass nothing. The position is measured,
 *  never left to the engine: WebKit reports `overflow-anchor` as supported yet does not anchor the transcript. */
export function captureTranscriptAnchor(transcript: HTMLElement, skip?: (row: Element) => boolean): (pending?: number) => void {
  const { top, bottom, scale } = viewport(transcript);
  const scrollTop = transcript.scrollTop, height = transcript.scrollHeight;
  const remainder = scrollRemainder(transcript);
  const attributes = ['data-message-id', 'data-tool-key', 'data-turn-key', 'data-change-key'];
  const selector = attributes.map(name => `[${name}]`).join(',');
  // Innermost anchors only: a turn wrapper grows when earlier messages join its turn, so it moves.
  const anchors = rowsInBand(transcript, top, bottom, skip)
    .flatMap(row => [...(row.matches(selector) ? [row as HTMLElement] : []), ...row.querySelectorAll<HTMLElement>(selector)])
    .filter(node => node.getClientRects().length && !node.querySelector(selector))
    .map(node => ({ node, rect: node.getBoundingClientRect() }))
    .filter(({ rect }) => rect.bottom > top && rect.top < bottom)
    .sort((a, b) => Math.abs(a.rect.top - top) - Math.abs(b.rect.top - top))
    .map(({ node, rect }) => {
      const attribute = attributes.find(name => node.hasAttribute(name))!;
      return { selector: `[${attribute}="${CSS.escape(node.getAttribute(attribute)!)}"]`, offset: (rect.top - top) / scale };
    });
  return (later = 0) => {
    for (const anchor of anchors) {
      const node = transcript.querySelector<HTMLElement>(anchor.selector);
      if (!node?.getClientRects().length) continue;
      const current = viewport(transcript);
      restoreScrollTop(transcript, transcript.scrollTop + (node.getBoundingClientRect().top - current.top) / current.scale - anchor.offset + remainder + later);
      return;
    }
    restoreScrollTop(transcript, scrollTop + transcript.scrollHeight - height + remainder + later);
  };
}

/** A transcript whose owner keeps it pinned to the bottom after layout (a ResizeObserver),
 *  with a layout-free test of whether it is following now. */
const followers = new WeakMap<HTMLElement, () => boolean>();
export function followTranscriptBottom(transcript: HTMLElement, following: () => boolean): void { followers.set(transcript, following); }
/** Whether `transcript`'s owner is keeping it pinned to the bottom right now (layout-free); false for any other scroller. */
export function isFollowingTranscript(transcript: HTMLElement): boolean { return followers.get(transcript)?.() ?? false; }
/** Whether `transcript` has an owner that decides its follow (followTranscriptBottom): then only that owner's intent,
 *  never mere nearness to the bottom, may pin it. */
export function hasFollowOwner(transcript: HTMLElement): boolean { return followers.has(transcript); }

/** Capture immediately before an async Markdown paint, respecting new user scrolls. */
export function preserveTranscriptPosition(transcript: HTMLElement, changed?: HTMLElement): () => void {
  // Following: the owner pins after layout, before paint, so measuring here would only force layout.
  const following = followers.get(transcript);
  if (following?.()) return () => {};
  const follow = !following && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140
    && !document.activeElement?.closest('details');
  if (follow) return () => { transcript.scrollTop = transcript.scrollHeight; };
  // Content growing at or below the reading line cannot move what is read there or above it. Avoid scanning loaded
  // history on every token while the reader is elsewhere in the conversation.
  if (changed && changed.getBoundingClientRect().top >= viewport(transcript).top) return () => {};
  return captureTranscriptAnchor(transcript);
}

/** What the scroll handler knows when the transcript scrolls: where it is, where it was, its extent, and its state.
 *  `layoutChanged`: the page may have laid the scroller out otherwise since `lastTop` was recorded (its scrollHeight or
 *  box differs, or what sizes it changed); `userScrolling`: a wheel, touch, key or scrollbar gesture of the reader's is
 *  under way. */
export type ScrollTransitionInput = {
  top: number; lastTop: number; scrollHeight: number; clientHeight: number;
  stickToBottom: boolean; resumeFollow: boolean; programmatic: boolean;
  layoutChanged?: boolean; userScrolling?: boolean;
};
/** `ignore`: a scroll of our own; `repin`: content shrank under a follower; `release`: the reader moved up;
 *  `restick`: the reader came back to the bottom and follows again; `keep`: nothing changes. */
export type ScrollAction = 'ignore' | 'repin' | 'release' | 'restick' | 'keep';
export type ScrollTransitionResult = { stickToBottom: boolean; resumeFollow: boolean; nextLastTop: number; action: ScrollAction };

/** How close (px) to the bottom a reader coming back down counts as there. */
const RESTICK_GAP = 2;

/** The next scroll-intent state. Positions are clamped first: WKWebView's elastic overscroll reports scrollTop below 0
 *  and past the end. Upward movement is checked before anything but a layout clamp, so a 1–2px nudge up from the
 *  bottom releases the follow instead of snapping back. */
export function decideScrollTransition(input: ScrollTransitionInput): ScrollTransitionResult {
  const { top, lastTop, scrollHeight, clientHeight, stickToBottom, resumeFollow, programmatic, layoutChanged = false, userScrolling = false } = input;
  const maxTop = Math.max(0, scrollHeight - clientHeight);
  const clampedTop = Math.max(0, Math.min(maxTop, top));
  const gap = Math.max(0, maxTop - clampedTop);
  if (programmatic) return { stickToBottom, resumeFollow, nextLastTop: clampedTop, action: 'ignore' };
  // A gesture of the reader's (wheel, touch, scrollbar, keys) is never a clamp: neither rule below applies during one,
  // so a move up mid-gesture always releases, whatever the layout did meanwhile.
  // A follower moved up while the layout changed and the reader was not scrolling: the engine clamped the scroll to a
  // momentarily shorter layout (WebKit, as the composer fits its prompt or the inspector redraws), and the scroll event
  // arrives after the layout came back. Not the reader leaving, however far below the end it left them. The owner sets
  // `layoutChanged` only for a known layout task, a shrink or a resized box, never for content growing.
  if (stickToBottom && layoutChanged && !userScrolling && clampedTop < lastTop - SCROLL_EPSILON) return { stickToBottom: true, resumeFollow, nextLastTop: clampedTop, action: 'repin' };
  // Content shrank under a follower and the engine clamped it to (within a rounded pixel of) the new end. WebKit
  // shrinks by fractions of a pixel, so the clamp can be under SCROLL_EPSILON past the end and still look like a move up.
  if (stickToBottom && !userScrolling && lastTop > maxTop && gap <= RESTICK_GAP) return { stickToBottom: true, resumeFollow, nextLastTop: clampedTop, action: 'repin' };
  // Moving up releases the follow but keeps resumeFollow: only an opened or closed fold pauses it (and the wheel and
  // keys release through releaseTranscript), so coming back down to the bottom follows again.
  if (clampedTop < lastTop - SCROLL_EPSILON) return { stickToBottom: false, resumeFollow, nextLastTop: clampedTop, action: 'release' };
  if (stickToBottom) return { stickToBottom: true, resumeFollow, nextLastTop: clampedTop, action: 'keep' };
  // Only a move down re-sticks, so resting a pixel or two above the bottom stays released.
  if (resumeFollow && gap <= RESTICK_GAP && clampedTop > lastTop + SCROLL_EPSILON) return { stickToBottom: true, resumeFollow: true, nextLastTop: clampedTop, action: 'restick' };
  return { stickToBottom: false, resumeFollow, nextLastTop: clampedTop, action: 'keep' };
}

/** After an upward wheel, downward wheel deltas this soon (ms) are the trackpad settling, not the reader coming back. */
const WHEEL_RESTICK_COOLDOWN_MS = 250;
/** A downward wheel delta this large (px) is deliberate even inside the cooldown. */
const WHEEL_DELIBERATE_DELTA = 24;
/** Downward travel (px, summed since the last upward wheel) that counts as intent once the cooldown passed... */
const WHEEL_INTENT_ACCUM = 12;
/** ...or a single delta this large (px). */
const WHEEL_INTENT_DELTA = 6;
/** Below this raw gap (px) the scroller is in elastic overscroll past the end: a bounce, not a place to follow from. */
const WHEEL_OVERSCROLL_GAP = -0.5;

export type WheelRestickInput = { deltaY: number; now: number; lastUpwardWheelAt: number; downAccum: number; gap: number; stickToBottom: boolean };
/** `restick`: follow the bottom again now; `deliberate`: the wheel is the reader heading down (resumeFollow may arm);
 *  `nextDownAccum`: the downward travel to carry to the next wheel. */
export type WheelRestickResult = { restick: boolean; deliberate: boolean; nextDownAccum: number };

/** Whether a downward wheel brings a released reader back to following. A macOS trackpad sends a few tiny positive
 *  deltas (+0.01..+3px) as an upward swipe settles, and the elastic bounce at the end reports a gap below zero: neither
 *  may re-pin a reader who just scrolled up. `gap` is the raw scrollHeight − scrollTop − clientHeight. */
export function shouldWheelRestick(input: WheelRestickInput): WheelRestickResult {
  const { deltaY, now, lastUpwardWheelAt, downAccum, gap, stickToBottom } = input;
  if (!(deltaY > 0)) return { restick: false, deliberate: false, nextDownAccum: 0 };
  const nextDownAccum = downAccum + deltaY;
  const cooledDown = now - lastUpwardWheelAt >= WHEEL_RESTICK_COOLDOWN_MS;
  const deliberate = deltaY >= WHEEL_DELIBERATE_DELTA || (cooledDown && (nextDownAccum >= WHEEL_INTENT_ACCUM || deltaY >= WHEEL_INTENT_DELTA));
  const atEnd = gap >= WHEEL_OVERSCROLL_GAP && gap <= RESTICK_GAP;
  return { restick: deliberate && atEnd && !stickToBottom, deliberate, nextDownAccum };
}

const SCROLLING_OVERFLOW = new Set(['auto', 'scroll', 'overlay']);
type ScrollBox = { scrollTop: number; scrollHeight: number; clientHeight: number };

/** Whether an element inside `boundary` (a code block, a tool's output) can still scroll `deltaY`'s way, so a wheel
 *  over it is its own and not the transcript's. False outside a DOM. */
export function canNestedScrollerConsume(target: EventTarget | null, boundary: HTMLElement, deltaY: number): boolean {
  if (typeof getComputedStyle !== 'function' || !target || deltaY === 0) return false;
  let at = target as Node | null;
  // A text node (or any non-element) starts from its parent element.
  while (at && at.nodeType !== 1) at = at.parentNode;
  for (; at && at !== boundary; at = at.parentNode) {
    if (at.nodeType !== 1) continue;
    const box = at as unknown as Element & ScrollBox;
    if (box.scrollHeight <= box.clientHeight + 1 || !SCROLLING_OVERFLOW.has(getComputedStyle(box).overflowY)) continue;
    const room = deltaY < 0 ? box.scrollTop > SCROLL_EPSILON : box.scrollTop + box.clientHeight < box.scrollHeight - SCROLL_EPSILON;
    if (room) return true;
  }
  return false;
}

export type SmoothScrollTarget = number | (() => number | null);
export type SmoothScrollOptions = { instant?: boolean; onDone?: (landed: boolean) => void };
export type SmoothScroller = { scrollTo(target: SmoothScrollTarget, opts?: SmoothScrollOptions): void; cancel(): void; isActive(): boolean };

/** Shortest and longest eased scroll (ms); longer distances take a little longer. */
const SMOOTH_MIN_MS = 200, SMOOTH_MAX_MS = 280, SMOOTH_PX_PER_MS = 25;
/** The final approach after a long jump bridged most of the way at once. */
const BRIDGE_APPROACH_MS = 220;
/** An external scroll moved the scroller this far (px) from where the animation left it: the reader took over. */
const DRIFT_PX = 3;

const reducedMotion = (): boolean => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const easeOut = (t: number): number => 1 - (1 - t) ** 3;

/** Time-based eased scrolling of `scroller`. A target may be a function, asked again every frame (a target that moves
 *  as content lays out); null abandons the scroll. Writes go through writeScrollTop, and `onStep` gets each position
 *  so the owner can tell its own scrolls from the reader's. An external scroll during the animation cancels it; one that
 *  comes with a change in scrollHeight is layout (scroll anchoring) and the animation carries on from there. */
export function createSmoothScroller(scroller: HTMLElement, options: { onStep?: (top: number) => void; onActiveChange?: (active: boolean) => void } = {}): SmoothScroller {
  type Run = {
    resolve: () => number | null; from: number; start: number; duration: number; expectedTop: number;
    lastScrollHeight: number; onDone?: (landed: boolean) => void;
  };
  let run: Run | undefined, frame = 0;
  const maxTop = (): number => Math.max(0, scroller.scrollHeight - scroller.clientHeight);
  const clamp = (top: number): number => Math.max(0, Math.min(maxTop(), top));
  const write = (top: number): number => { writeScrollTop(scroller, top); options.onStep?.(scroller.scrollTop); return scroller.scrollTop; };
  /** Ends the current run, if any; `restarting` keeps the active state for the run about to start. */
  const end = (landed: boolean, restarting = false): void => {
    const ended = run;
    if (!ended) return;
    run = undefined;
    if (frame && typeof cancelAnimationFrame === 'function') cancelAnimationFrame(frame);
    frame = 0;
    if (!restarting) options.onActiveChange?.(false);
    ended.onDone?.(landed);
  };
  const tick = (): void => {
    frame = 0;
    const current = run;
    if (!current) return;
    const height = scroller.scrollHeight, actual = scroller.scrollTop;
    if (Math.abs(height - current.lastScrollHeight) >= SCROLL_EPSILON) {
      // Content laid out (far rows clamping under Read more) and the engine's scroll anchoring moved scrollTop with it:
      // carry the animation along by the same shift rather than taking it for the reader.
      const shift = actual - current.expectedTop;
      current.from += shift;
      current.expectedTop = actual;
      current.lastScrollHeight = height;
    } else if (Math.abs(actual - Math.min(current.expectedTop, maxTop())) > DRIFT_PX) { end(false); return; }
    const goal = current.resolve();
    if (goal === null || !Number.isFinite(goal)) { end(false); return; }
    const target = clamp(goal);
    const t = Math.min(1, (performance.now() - current.start) / current.duration);
    current.expectedTop = write(t >= 1 ? target : current.from + (target - current.from) * easeOut(t));
    current.lastScrollHeight = scroller.scrollHeight;
    if (t >= 1) { end(true); return; }
    frame = requestAnimationFrame(tick);
  };
  return {
    scrollTo(target, opts = {}) {
      const resolve = typeof target === 'function' ? target : () => target;
      const wasActive = Boolean(run);
      end(false, true);
      const goal = resolve();
      if (goal === null || !Number.isFinite(goal)) { if (wasActive) options.onActiveChange?.(false); opts.onDone?.(false); return; }
      const destination = clamp(goal), here = scroller.scrollTop, distance = Math.abs(destination - here);
      if (opts.instant || distance <= 1 || reducedMotion() || typeof requestAnimationFrame !== 'function') {
        write(destination);
        if (wasActive) options.onActiveChange?.(false);
        opts.onDone?.(true);
        return;
      }
      let from = here, duration = Math.min(SMOOTH_MAX_MS, SMOOTH_MIN_MS + distance / SMOOTH_PX_PER_MS);
      // A long way: cover most of it at once, then ease the final stretch.
      if (distance > Math.max(scroller.clientHeight * 2.2, 1200)) {
        const approach = Math.max(scroller.clientHeight * 1.1, 600);
        from = write(destination - Math.sign(destination - here) * approach);
        duration = BRIDGE_APPROACH_MS;
      }
      run = { resolve, from, start: performance.now(), duration, expectedTop: from, lastScrollHeight: scroller.scrollHeight, onDone: opts.onDone };
      if (!wasActive) options.onActiveChange?.(true);
      frame = requestAnimationFrame(tick);
    },
    cancel() { end(false); },
    isActive: () => Boolean(run),
  };
}
