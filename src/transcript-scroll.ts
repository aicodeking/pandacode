/** Whether the engine keeps the reader's content in place itself when content above it changes size (not WebKit). */
export const scrollAnchors = typeof CSS !== 'undefined' && Boolean(CSS.supports?.('overflow-anchor', 'auto'));

const scrollRounding = new WeakMap<HTMLElement, { top: number; remainder: number }>();

function restoreScrollTop(transcript: HTMLElement, top: number): void {
  transcript.scrollTop = top;
  const actual = transcript.scrollTop, remainder = top - actual;
  // Some webviews round scrollTop to whole pixels. Carry only rounding error,
  // never a clamped scroll, so many async code-block paints cannot add up to a jump.
  scrollRounding.set(transcript, { top: actual, remainder: Math.abs(remainder) < 1 ? remainder : 0 });
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
 *  (transcript-window.ts skipFarRows). The returned call takes what writes still to come will change above the
 *  reader (holdPlace's `pending`). */
export function captureTranscriptAnchor(transcript: HTMLElement, skip?: (row: Element) => boolean): (pending?: number) => void {
  const { top, bottom, scale } = viewport(transcript);
  const scrollTop = transcript.scrollTop, height = transcript.scrollHeight;
  const previous = scrollRounding.get(transcript);
  const remainder = previous?.top === scrollTop ? previous.remainder : 0;
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
  return (pending = 0) => {
    const later = scrollAnchors ? 0 : pending;
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

/** Capture immediately before an async Markdown paint, respecting new user scrolls. */
export function preserveTranscriptPosition(transcript: HTMLElement, changed?: HTMLElement): () => void {
  // Following: the owner pins after layout, before paint, so measuring here would only force layout.
  const following = followers.get(transcript);
  if (following?.()) return () => {};
  const follow = !following && transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 140
    && !document.activeElement?.closest('details');
  if (follow) return () => { transcript.scrollTop = transcript.scrollHeight; };
  // Streaming at the bottom cannot move content above it. Avoid scanning loaded
  // history on every token while the reader is elsewhere in the conversation.
  if (changed && changed.getBoundingClientRect().top >= transcript.getBoundingClientRect().bottom) return () => {};
  return captureTranscriptAnchor(transcript);
}
