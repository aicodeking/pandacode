import { markdownCache, markdownHtml } from './dom.ts';
import { captureFileLinkContext, decorateFileLinks, retainFileLink } from './file-links.ts';
import { preserveTranscriptPosition } from './transcript-scroll.ts';

// `source` is the settled prefix already painted as `nodes` leading children of the target (its HTML
// in `settledHtml`); only the open tail after it is parsed again. `cached` is the one cache entry
// this stream owns: its latest value, so a finished reply draws at once.
type Paint = { target: HTMLElement; value: string; rendered: string; pending: boolean; timer: number; lastPaint: number; formatted: boolean; source: string; settledHtml: string; nodes: number; cached?: string; context?: object; scroll?: HTMLElement };
const paints = new WeakMap<HTMLElement, Paint>();
const FRAME_MS = 32;
// The open tail of a link: `[label` or `[label](url…` (an image's `![…` is held until it closes).
const OPEN_LINK = /(!?)\[([^\][\n]*)(?:\]\([^)\s]*)?$/;
const FENCE = /^ {0,3}(```|~~~)/gm;
// Stands in for the URL still streaming; paint() swaps the anchor for an underlined, unclickable span.
const OPEN_HREF = '#pandacode-open-link';

/** What to show of a still-streaming value without ever holding text back: an open link shows as its
 * (underlined) label, an open code span as code. Inside an open fence the value is already code. */
export function settledMarkdown(value: string): string {
  if ((value.match(FENCE)?.length ?? 0) % 2) return value;
  const paragraph = value.slice(value.lastIndexOf('\n\n') + 1);
  const ticks = paragraph.match(/`+/g) ?? [];
  // ponytail: pairs backtick runs by count, not length; a ``span with ` inside`` may close a frame late.
  if (ticks.length % 2) return value + ticks[ticks.length - 1];
  return value.replace(OPEN_LINK, (match, image: string, label: string) =>
    image ? '' : !match.includes('](') && /^\s*x?\s*$/i.test(label) ? match : `[${label}](${OPEN_HREF})`);
}

// Syntax whose meaning reaches across blank lines: reference definitions and footnotes apply to the
// whole document, <details> is matched by the renderer across paragraphs, and these raw HTML blocks
// run past blank lines.
const WHOLE_DOCUMENT = /^[ \t>]*\[[^\]\n]+\]:|<details|^ {0,3}<(?:!--|pre|script|style|textarea)/im;
// A line that may still belong to the block above a blank line: indented (list item or code
// continuation) or a list item (a loose list goes on).
const CONTINUES = /^(?:[ \t]|[-*+](?:[ \t]|$)|\d{1,9}[.)](?:[ \t]|$))/;
const FENCE_OPEN = /^ {0,3}(`{3,}(?!.*`)|~{3,})/;

/** Offsets where a settled top-level block ends and the next begins: after a blank line outside
 * any open fence, before a complete line that cannot continue the block above. Rendering the parts
 * separately and joining the HTML equals rendering the whole, so a stream re-parses only the part
 * after the last offset. Offsets never move as text is appended (unless syntax that spans the whole
 * document arrives, which returns none). */
export function blockBoundaries(markdown: string): number[] {
  if (WHOLE_DOCUMENT.test(markdown)) return [];
  const offsets: number[] = [];
  let fence = '', blank = false;
  for (let at = 0, end = markdown.indexOf('\n'); end >= 0; at = end + 1, end = markdown.indexOf('\n', at)) {
    const line = markdown.slice(at, end);
    if (fence) {
      const close = line.match(FENCE_OPEN);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !line.slice(line.indexOf(close[1]) + close[1].length).trim()) fence = '';
    } else if (!line.trim()) blank = at > 0;
    else {
      if (blank && !CONTINUES.test(line)) offsets.push(at);
      blank = false;
      fence = line.match(FENCE_OPEN)?.[1] ?? '';
    }
  }
  return offsets;
}

/** Keep finished blocks and text nodes in place as the open Markdown block grows; children before
 * `from` are left alone. */
function reconcile(parent: Node, children: Node[], from = 0): void {
  children.forEach((child, index) => {
    const old = parent.childNodes[from + index];
    if (!old) { parent.appendChild(child); return; }
    if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { parent.replaceChild(child, old); return; }
    if (old instanceof Text && child instanceof Text) {
      if (child.data.startsWith(old.data)) { if (child.data.length > old.length) old.appendData(child.data.slice(old.length)); }
      else if (old.data !== child.data) old.data = child.data;
    } else if (old instanceof Element && child instanceof Element) {
      retainFileLink(old, child);
      for (const attribute of [...old.attributes]) if (!child.hasAttribute(attribute.name)) old.removeAttribute(attribute.name);
      for (const attribute of [...child.attributes]) if (old.getAttribute(attribute.name) !== attribute.value) old.setAttribute(attribute.name, attribute.value);
      reconcile(old, [...child.childNodes]);
    } else if (old.nodeValue !== child.nodeValue) old.nodeValue = child.nodeValue;
  });
  while (parent.childNodes.length > from + children.length) parent.lastChild!.remove();
}

function restart(state: Paint): void {
  state.source = ''; state.settledHtml = ''; state.nodes = 0;
}

function fragment(html: string, target: HTMLElement): Node[] {
  const template = document.createElement('template');
  template.innerHTML = html;
  for (const open of template.content.querySelectorAll(`a[href="${OPEN_HREF}"]`)) {
    const label = document.createElement('span'); label.className = 'md-open-link'; label.append(...open.childNodes);
    open.replaceWith(label);
  }
  decorateFileLinks(template.content, target);
  return [...template.content.childNodes];
}

function schedule(state: Paint): void {
  if (state.pending || state.timer || state.rendered === state.value || !state.target.isConnected) return;
  const delay = state.formatted ? Math.max(0, FRAME_MS - (performance.now() - state.lastPaint)) : 0;
  if (!delay) void paint(state);
  else state.timer = window.setTimeout(() => { state.timer = 0; void paint(state); }, delay);
}

async function paint(state: Paint): Promise<void> {
  if (!state.target.isConnected) return;
  const value = state.value;
  state.pending = true;
  try {
    const ends = blockBoundaries(value), tailAt = ends.at(-1) ?? 0;
    // Settled blocks stay painted while the text only grows past them; any other change repaints all.
    if (!value.startsWith(state.source) || (state.source && !ends.includes(state.source.length))) restart(state);
    const fresh = value.slice(state.source.length, tailAt), tail = value.slice(tailAt), shown = settledMarkdown(tail);
    // A reply opened whole (a thread reopened) draws from the cache; the next change settles its blocks.
    const known = state.source ? undefined : markdownCache.get(value);
    const [settledHtml, tailHtml] = known !== undefined ? ['', known]
      : await Promise.all([fresh ? markdownHtml(fresh, false) : '', markdownHtml(shown, false)]);
    if (!state.target.isConnected || state.value !== value) return;
    const settled = fragment(settledHtml, state.target);
    const restore = state.scroll ? preserveTranscriptPosition(state.scroll, state.target) : undefined;
    reconcile(state.target, [...settled, ...fragment(tailHtml, state.target)], state.nodes);
    if (known === undefined) { state.nodes += settled.length; state.source = value.slice(0, tailAt); state.settledHtml += settledHtml; }
    if (state.cached !== value) {
      if (state.cached !== undefined) markdownCache.delete(state.cached);
      state.cached = undefined;
      // Settled and open parts render as the whole would (blockBoundaries), unless the tail was patched.
      if (known === undefined && shown === tail) { markdownCache.set(value, state.settledHtml + tailHtml); state.cached = value; }
    }
    state.target.classList.add('markdown');
    state.formatted = true; state.rendered = value; state.lastPaint = performance.now();
    restore?.();
  } catch {
    // Keep the response readable if a lazy renderer cannot be loaded.
    if (state.target.isConnected && state.value === value) {
      state.target.classList.remove('markdown'); state.target.textContent = value;
      state.formatted = false; state.rendered = value; restart(state);
    }
  } finally { state.pending = false; schedule(state); }
}

/** One bounded paint per visible response; incoming chunks are never held for a turn to finish. */
export function streamMarkdown(target: HTMLElement, value: string, scroll?: HTMLElement): void {
  const context = captureFileLinkContext(target);
  let state = paints.get(target);
  if (!state) {
    state = { target, value: '', rendered: '', pending: false, timer: 0, lastPaint: 0, formatted: false, source: '', settledHtml: '', nodes: 0, context };
    paints.set(target, state);
  }
  if (state.context !== context) {
    state.context = context; state.rendered = ''; state.formatted = false; restart(state);
  }
  state.value = value; state.scroll = scroll;
  if (!value) {
    clearTimeout(state.timer); state.timer = 0; state.rendered = ''; state.formatted = false; restart(state);
    target.replaceChildren(); target.classList.remove('markdown'); return;
  }
  if (!state.formatted) {
    const shown = settledMarkdown(value);
    const text = target.firstChild;
    if (text instanceof Text && shown.startsWith(text.data)) text.appendData(shown.slice(text.length));
    else target.textContent = shown;
  }
  schedule(state);
}
