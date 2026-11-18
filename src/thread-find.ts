import './thread-find.css';
import { icon, isImeKey } from './dom';

/* ⌘F in a thread: a slim find bar over the conversation. Matches in your messages, the
 * agent's and its tools' details are highlighted with the CSS Custom Highlight API, so the message
 * DOM is never rewritten; the current match scrolls into view and opens any folded turn around it.
 * A long thread draws only its newest turns: the host searches the rest in memory (`older`) and
 * draws down to the next match when stepping past the oldest one drawn (`extend`). */

const MESSAGE_TEXT = 'article.message :is(.message-content, .streaming-content), .tool-activity-body';

/** Markdown's punctuation: a query holding any of it is compared with the source as written (sourceText). */
const MARKS = /[*_`~#>|\\]/;
const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: '\u00a0' };
const decodeEntities = (text: string): string => text.replace(/&(#x[0-9a-f]{1,6}|#\d{1,7}|[a-z]+);/gi, (whole, name: string) => {
  if (name[0] !== '#') return ENTITIES[name.toLowerCase()] ?? whole;
  const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
  return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
});
/** Markdown source as the in-memory search compares it while its formatted text is not known: lower case, escapes and
 *  entities read as they draw, and (`loose`) without Markdown's punctuation or link targets. Line breaks stay, as they
 *  do in the drawn text, so a match never spans two blocks. It errs towards matching. */
export function sourceText(text: string, loose: boolean): string {
  const read = decodeEntities(text.replace(/\\([!-/:-@[-`{-~])/g, '$1'));
  return (loose ? read.replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1').replace(/[*_`~#>|]/g, '') : read).toLocaleLowerCase();
}
/** What one reply's in-memory count reads, filled as it is needed: its formatted text once known, else its source. */
export type ReplyText = { drawn?: string; exact?: string; loose?: string };
/** How many times `query` occurs in a reply: in its formatted text when `formatted` knows it (drawnText), else in its
 *  source, compared as written when the query holds Markdown punctuation (`C#`, `a_b`) and loosely otherwise. */
export function replyCount(known: ReplyText, source: string, formatted: string | undefined, query: string): number {
  if (known.drawn === undefined && formatted !== undefined) known.drawn = drawnText(`<article class="message"><div class="message-content">${formatted}</div></article>`);
  if (known.drawn !== undefined) return exactCount(known.drawn, query);
  if (MARKS.test(query)) return exactCount(known.exact ??= sourceText(source, false), query);
  return exactCount(known.loose ??= sourceText(source, true), query);
}
/** How long Find waits after a keystroke before it searches. */
const FIND_TYPING_MS = 60;
const ALL = 'thread-find', CURRENT = 'thread-find-current';
/** Dispatched on the bar's input by the host when what it counts changed: a refresh, never a fresh search that moves the current match. */
export const FIND_REFRESH = 'find-refresh';

type Host = {
  /** The pane the bar floats over, and the scrolling transcript inside it. */
  pane(): HTMLElement | null;
  /** The transcript, asked before each search with the query (a closed tool's details are drawn when they match). */
  transcript(query?: string): HTMLElement | null;
  /** Matches for `query` in turns loaded but not drawn yet, all older than the drawn ones. */
  older?(query: string): number;
  /** Whether the count is final: nothing the host counts (tools above the window, replies to format) is still being worked out. */
  settled?(): boolean;
  /** Draws down to the newest match not drawn (`all`: to the oldest), then calls `done`. False when there is none. */
  extend?(query: string, all: boolean, done: () => void): boolean;
  /** The transcript stops following its bottom, which would otherwise pull it back off a match. */
  release(): void;
  /** Opens a turn card's clamped reply, so a match past its clamp can be seen. */
  openReply(reply: HTMLElement): void;
  /** Where focus returns when the bar closes. */
  restoreFocus(): void;
};

/** A searched block's text as Find reads it: its text nodes in order (skipping actions and screen-reader text), and
 *  where each starts in the joined text. */
function blockText(block: HTMLElement): { nodes: Text[]; starts: number[]; text: string } {
  const nodes: Text[] = [], starts: number[] = [];
  let text = '';
  const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
    if (node.parentElement?.closest('.message-actions, .sr-only')) continue;
    nodes.push(node); starts.push(text.length); text += node.data;
  }
  return { nodes, starts, text };
}

/** The text Find would search in `html` once drawn, lower case, one line per searched block: what the in-memory
 *  count of a turn not drawn yet compares (exactCount), so it agrees with what findRanges finds once it is. */
export function drawnText(html: string): string {
  const template = document.createElement('template');
  template.innerHTML = html;
  return [...template.content.querySelectorAll<HTMLElement>(MESSAGE_TEXT)].map(block => blockText(block).text).join('\n').toLocaleLowerCase();
}
/** How many times `query` occurs in `text` (drawnText), counted as findRanges counts. */
export function exactCount(text: string, query: string): number {
  const needle = query.toLocaleLowerCase();
  if (!needle) return 0;
  let count = 0;
  for (let at = text.indexOf(needle); at !== -1; at = text.indexOf(needle, at + needle.length)) count++;
  return count;
}

/** Every case-insensitive occurrence of `query` in `root`'s text, as ranges that may span
 *  inline formatting (a match across **bold** text is still one match). */
export function findRanges(root: ParentNode, query: string): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const block of root.querySelectorAll<HTMLElement>(MESSAGE_TEXT)) {
    const { nodes, starts, text } = blockText(block);
    const haystack = text.toLocaleLowerCase();
    // Find the node holding a character offset (nodes are in order, so search from `from`).
    const locate = (offset: number, from: number): number => {
      let index = from;
      while (index + 1 < nodes.length && starts[index + 1] <= offset) index++;
      return index;
    };
    let at = haystack.indexOf(needle), cursor = 0;
    while (at !== -1) {
      const first = locate(at, cursor), last = locate(at + needle.length - 1, first);
      const range = document.createRange();
      range.setStart(nodes[first], at - starts[first]);
      range.setEnd(nodes[last], at + needle.length - starts[last]);
      ranges.push(range);
      cursor = first;
      at = haystack.indexOf(needle, at + needle.length);
    }
  }
  return ranges;
}

export function createThreadFind(host: Host) {
  let bar: HTMLElement | undefined, input: HTMLInputElement | undefined, count: HTMLElement | undefined;
  let ranges: Range[] = [], current = -1, frame = 0, typing = 0;
  const highlights = typeof CSS !== 'undefined' && 'highlights' in CSS ? (CSS as unknown as { highlights: Map<string, unknown> }).highlights : undefined;
  const Highlight = (globalThis as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
  const observer = new MutationObserver(() => { if (!frame) frame = requestAnimationFrame(() => { frame = 0; search(false); }); });
  const FIND_BAR_HEIGHT = 32, FIND_BAR_WIDTH = 300; // .thread-find in thread-find.css (the width is a fallback before it lays out)
  const shown = (element: Element | null | undefined): element is HTMLElement => Boolean(element && element.getClientRects().length && element.getBoundingClientRect().width > 0);
  /** In the conversation view the bar rides in the empty header row (the transcript's first row rests
   *  just below the header), so it never covers a match, clamped 8px clear of the header's leading
   *  items and its widgets. A side thread (board, GitHub), the narrow layout (the dock is a row in the
   *  header) and a bot conversation (its crumb shows) keep it at the pane's top. */
  const headerSlot = (pane: HTMLElement, width: number): { center: number; top: number } | undefined => {
    if (!pane.closest('.workspace:not(.side-thread)')) return undefined;
    const header = document.querySelector<HTMLElement>('.main-pane>.workspace-header');
    if (!header || !shown(header)) return undefined;
    const dock = header.querySelector<HTMLElement>('#action-dock');
    if ((dock && getComputedStyle(dock).position !== 'absolute') || shown(header.querySelector('#breadcrumb'))) return undefined;
    const box = header.getBoundingClientRect(), half = width / 2, gap = 8;
    // The leading box stretches across the row; only its visible items count.
    const leading = [...header.querySelectorAll<HTMLElement>('.header-leading>*')].filter(shown).map(item => item.getBoundingClientRect().right);
    const min = (leading.length ? Math.max(...leading) : box.left) + gap + half;
    const widgets = [...header.querySelectorAll<HTMLElement>('.header-actions>*')].filter(shown).map(widget => widget.getBoundingClientRect().left);
    const max = (widgets.length ? Math.min(...widgets) : box.right) - gap - half;
    if (min > max) return undefined;
    const pane_ = pane.getBoundingClientRect();
    return { center: Math.min(max, Math.max(min, pane_.left + pane_.width / 2)), top: box.top + (box.height - FIND_BAR_HEIGHT) / 2 };
  };
  // Fixed over the pane's top centre, so it never changes how the pane lays out its panels.
  const place = (): void => {
    const pane = host.pane();
    if (!bar || !pane) return;
    const rect = pane.getBoundingClientRect();
    // The pane can leave the screen (GitHub view, settings); the bar goes with it.
    bar.hidden = rect.width === 0;
    const slot = headerSlot(pane, bar.offsetWidth || FIND_BAR_WIDTH);
    bar.style.setProperty('--find-left', `${slot ? Math.floor(slot.center) : Math.round(rect.left + rect.width / 2)}px`); // floor: the 8px clearance never rounds away
    bar.style.setProperty('--find-top', `${Math.round(slot?.top ?? rect.top + 10)}px`);
  };
  const resize = typeof ResizeObserver === 'function' ? new ResizeObserver(place) : undefined;

  function paint(): void {
    if (!highlights || !Highlight) return;
    highlights.set(ALL, new Highlight(...ranges));
    if (ranges[current]) highlights.set(CURRENT, new Highlight(ranges[current])); else highlights.delete(CURRENT);
  }

  const olderMatches = (): number => input?.value ? host.older?.(input.value) ?? 0 : 0;
  function label(): void {
    if (!count || !input) return;
    // Matches not drawn yet are all above the drawn ones.
    const older = olderMatches(), total = ranges.length + older;
    count.textContent = !input.value ? '' : total ? `${ranges.length ? older + current + 1 : older} of ${total}` : 'No results';
    bar?.querySelectorAll<HTMLButtonElement>('[data-find-step]').forEach(button => { button.disabled = total < 2; });
    // The query whose count is final (every match above the window counted), for anything waiting on it.
    if (!bar) return;
    if (input.value && (host.settled?.() ?? true)) bar.dataset.counted = input.value; else delete bar.dataset.counted;
  }

  /** The top of the transcript's clear area: below its scroll padding (the header it scrolls under,
   *  that header's fade and the floating team bars) and below this find bar. */
  function clearTop(transcript: HTMLElement): number {
    const padded = transcript.getBoundingClientRect().top + (parseFloat(getComputedStyle(transcript).scrollPaddingTop) || 0);
    return bar && !bar.hidden ? Math.max(padded, bar.getBoundingClientRect().bottom + 8) : padded;
  }

  /** Bring the current match into view, opening any folded turn that hides it. */
  function reveal(): void {
    const range = ranges[current], transcript = host.transcript(input?.value);
    if (!range || !transcript) return;
    let opened = false;
    for (let node = range.startContainer.parentElement; node && node !== transcript; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement && !node.open) { node.open = true; opened = true; }
      else if (node.matches('.turn-card-reply[data-overflow]:not([data-open])')) { host.openReply(node); opened = true; }
    }
    const rect = range.getBoundingClientRect(), bottom = transcript.getBoundingClientRect().bottom, top = clearTop(transcript);
    const outside = rect.top < top || rect.bottom > bottom - 24;
    if (opened || outside) host.release();
    // A third of the way down the clear area, never under anything floating over the transcript.
    if (outside) transcript.scrollTop += rect.top - top - (bottom - top) / 3;
  }

  /** Re-run the query. A fresh query starts at the match nearest the reader; a refresh after
   *  the transcript changed keeps the current position. */
  function search(fresh: boolean): void {
    const transcript = host.transcript(input?.value);
    if (!bar || !input || !transcript) return;
    const previous = ranges[current];
    ranges = findRanges(transcript, input.value);
    if (!ranges.length) current = -1;
    else if (fresh || !previous) {
      const top = clearTop(transcript);
      const visible = ranges.findIndex(range => range.getBoundingClientRect().bottom >= top);
      current = visible === -1 ? ranges.length - 1 : visible;
    } else current = Math.min(Math.max(ranges.findIndex(range => range.compareBoundaryPoints(Range.START_TO_START, previous) >= 0), 0), ranges.length - 1);
    paint(); label();
    if (fresh) reveal();
  }

  function step(by: 1 | -1): void {
    if (typing) { clearTimeout(typing); typing = 0; search(true); }
    // Past the oldest drawn match (or wrapping round to the first), the next one may not be drawn yet: draw down to it,
    // then land on it. Going back lands just above where the reader was; wrapping lands on the very first.
    const query = input?.value ?? '';
    const pastOldest = by === -1 ? current <= 0 : ranges.length > 0 && current === ranges.length - 1;
    if (query && pastOldest && olderMatches() > 0) {
      const all = by === 1, drawn = ranges.length > 0;
      const drawing = host.extend?.(query, all, () => {
        if (input?.value !== query) return;
        search(false);
        if (!ranges.length) return;
        current = all ? 0 : drawn ? Math.max(0, current - 1) : ranges.length - 1;
        paint(); label(); reveal();
      });
      if (drawing) return;
    }
    if (!ranges.length) return;
    current = (current + by + ranges.length) % ranges.length;
    paint(); label(); reveal();
  }

  function open(): void {
    const pane = host.pane(), transcript = host.transcript();
    if (!pane || !transcript) return;
    if (!bar || !bar.isConnected) {
      bar = document.createElement('div');
      bar.className = 'thread-find';
      bar.setAttribute('role', 'search');
      bar.innerHTML = `${icon('search')}<input type="search" aria-label="Find in thread" placeholder="Find in thread" autocomplete="off" spellcheck="false" maxlength="200"><span class="thread-find-count" aria-live="polite"></span><button type="button" class="icon-button thread-find-previous" data-find-step="-1" aria-label="Previous match" title="Previous match (⇧↩)">${icon('down')}</button><button type="button" class="icon-button" data-find-step="1" aria-label="Next match" title="Next match (↩)">${icon('down')}</button><button type="button" class="icon-button" data-find-close aria-label="Close find" title="Close (Esc)">${icon('close')}</button>`;
      input = bar.querySelector('input')!; count = bar.querySelector<HTMLElement>('.thread-find-count')!;
      // A keystroke's search waits for typing to pause: each one counts every turn not drawn yet.
      input.addEventListener('input', () => { clearTimeout(typing); typing = window.setTimeout(() => { typing = 0; search(true); }, FIND_TYPING_MS); });
      // The host's text changed under the bar (older replies formatted): count and search again, keeping the current match.
      input.addEventListener(FIND_REFRESH, () => { if (!typing) search(false); });
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter' && !isImeKey(event)) { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
        else if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); close(); }
      });
      bar.addEventListener('click', event => {
        const target = (event.target as Element).closest<HTMLButtonElement>('button');
        if (!target) return;
        if (target.dataset.findStep) step(Number(target.dataset.findStep) as 1 | -1);
        else if (target.hasAttribute('data-find-close')) close();
      });
      pane.append(bar);
      observer.observe(transcript, { childList: true, subtree: true, characterData: true });
      resize?.observe(pane);
      window.addEventListener('resize', place);
    }
    place();
    input!.focus(); input!.select();
    if (input!.value) search(true); else label();
  }

  function close(): void {
    observer.disconnect(); resize?.disconnect();
    window.removeEventListener('resize', place);
    cancelAnimationFrame(frame); frame = 0; clearTimeout(typing); typing = 0;
    highlights?.delete(ALL); highlights?.delete(CURRENT);
    bar?.remove(); bar = undefined; input = undefined; count = undefined; ranges = []; current = -1;
    host.restoreFocus();
  }

  return {
    open, close,
    isOpen: () => Boolean(bar?.isConnected),
    /** ⌘G / ⇧⌘G while the bar is open. */
    step: (by: 1 | -1) => { if (bar?.isConnected) step(by); },
  };
}
