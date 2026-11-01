import './thread-find.css';
import { icon } from './dom';

/* ⌘F in a thread: a slim find bar over the conversation. Matches in your messages and the
 * agent's are highlighted with the CSS Custom Highlight API, so the message DOM is never
 * rewritten; the current match scrolls into view and opens any folded turn around it. */

const MESSAGE_TEXT = 'article.message :is(.message-content, .streaming-content)';
const ALL = 'thread-find', CURRENT = 'thread-find-current';

type Host = {
  /** The pane the bar floats over, and the scrolling transcript inside it. */
  pane(): HTMLElement | null;
  transcript(): HTMLElement | null;
  /** Where focus returns when the bar closes. */
  restoreFocus(): void;
};

/** Every case-insensitive occurrence of `query` in `root`'s text, as ranges that may span
 *  inline formatting (a match across **bold** text is still one match). */
export function findRanges(root: ParentNode, query: string): Range[] {
  const needle = query.toLocaleLowerCase();
  if (!needle) return [];
  const ranges: Range[] = [];
  for (const block of root.querySelectorAll<HTMLElement>(MESSAGE_TEXT)) {
    const nodes: Text[] = [], starts: number[] = [];
    let text = '';
    const walker = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode() as Text | null; node; node = walker.nextNode() as Text | null) {
      if (node.parentElement?.closest('.message-actions, .sr-only')) continue;
      nodes.push(node); starts.push(text.length); text += node.data;
    }
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
  let ranges: Range[] = [], current = -1, frame = 0;
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

  function label(): void {
    if (!count || !input) return;
    count.textContent = !input.value ? '' : ranges.length ? `${current + 1} of ${ranges.length}` : 'No results';
    bar?.querySelectorAll<HTMLButtonElement>('[data-find-step]').forEach(button => { button.disabled = ranges.length < 2; });
  }

  /** The top of the transcript's clear area: below its scroll padding (the header it scrolls under,
   *  that header's fade and the floating team bars) and below this find bar. */
  function clearTop(transcript: HTMLElement): number {
    const padded = transcript.getBoundingClientRect().top + (parseFloat(getComputedStyle(transcript).scrollPaddingTop) || 0);
    return bar && !bar.hidden ? Math.max(padded, bar.getBoundingClientRect().bottom + 8) : padded;
  }

  /** Bring the current match into view, opening any folded turn that hides it. */
  function reveal(): void {
    const range = ranges[current], transcript = host.transcript();
    if (!range || !transcript) return;
    for (let node = range.startContainer.parentElement; node && node !== transcript; node = node.parentElement) {
      if (node instanceof HTMLDetailsElement && !node.open) node.open = true;
    }
    const rect = range.getBoundingClientRect(), bottom = transcript.getBoundingClientRect().bottom, top = clearTop(transcript);
    // A third of the way down the clear area, never under anything floating over the transcript.
    if (rect.top < top || rect.bottom > bottom - 24) transcript.scrollTop += rect.top - top - (bottom - top) / 3;
  }

  /** Re-run the query. A fresh query starts at the match nearest the reader; a refresh after
   *  the transcript changed keeps the current position. */
  function search(fresh: boolean): void {
    const transcript = host.transcript();
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
      input.addEventListener('input', () => search(true));
      input.addEventListener('keydown', event => {
        if (event.key === 'Enter') { event.preventDefault(); step(event.shiftKey ? -1 : 1); }
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
    cancelAnimationFrame(frame); frame = 0;
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
