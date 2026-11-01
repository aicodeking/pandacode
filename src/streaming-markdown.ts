import { markdownCache, markdownHtml, markdownNodes } from './dom.ts';
import { captureFileLinkContext, decorateFileLinks, retainFileLink } from './file-links.ts';
import { preserveTranscriptPosition } from './transcript-scroll.ts';

// `source` is the settled prefix already painted as `nodes` leading children of the target (its HTML
// in `settledHtml`, one part per paint); only the open tail after it is parsed again. `deferred` is
// the value this stream registered with the cache (its latest), so a finished reply draws without
// a whole parse. `scheduled` is set while a paint waits for the next frame.
// `code` is set while the tail is one open code fence, `cost` is how long the last paint took.
type Paint = { target: HTMLElement; value: string; rendered: string; pending: boolean; scheduled: boolean; formatted: boolean; source: string; settledHtml: string[]; nodes: number; scan?: BlockScan; code?: CodeTail; cost: number; deferred?: string; context?: object; scroll?: HTMLElement };
// An open code fence that is the whole tail (`at`, opened by the `opener` line): the code of its
// complete lines up to `end` (`source` is the text to there) sits in `settled` and is never parsed
// again; `open` holds the code of the line still streaming.
type CodeTail = { at: number; opener: string; end: number; source: string; settled: Text; open: Text };
const paints = new WeakMap<HTMLElement, Paint>();
// A hidden or occluded window gets no animation frames; text still paints after this long.
const FRAME_FALLBACK_MS = 100;
// A paint slower than this (a tail that is one giant block) waits as long again before the next one.
const SLOW_PAINT_MS = 8, MAX_WAIT_MS = 250;
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

/** Where scanBlocks stopped: `read` is the text up to the last complete line, `fence` the open
 * fence (opened at `fenceAt`), `whole` whether syntax that spans the whole document was seen. */
export type BlockScan = { readonly read: string; readonly fence: string; readonly fenceAt: number; readonly blank: boolean; readonly whole: boolean; readonly offsets: readonly number[] };
const UNREAD: BlockScan = { read: '', fence: '', fenceAt: 0, blank: false, whole: false, offsets: [] };

/** blockBoundaries, carried on from an earlier scan of a prefix of `markdown` (else from the start),
 * so a stream reads each line once. */
export function scanBlocks(markdown: string, from: BlockScan = UNREAD): BlockScan {
  const start = markdown.startsWith(from.read) ? from : UNREAD;
  // The rules are line-local and a match stays a match as text is appended, so only the unread
  // lines need testing (`read` always ends at a line start).
  if (start.whole || WHOLE_DOCUMENT.test(markdown.slice(start.read.length))) return { ...start, whole: true };
  const added: number[] = [];
  let { fence, fenceAt, blank } = start, at = start.read.length;
  for (let end = markdown.indexOf('\n', at); end >= 0; at = end + 1, end = markdown.indexOf('\n', at)) {
    const line = markdown.slice(at, end);
    if (fence) {
      const close = line.match(FENCE_OPEN);
      if (close && close[1][0] === fence[0] && close[1].length >= fence.length && !line.slice(line.indexOf(close[1]) + close[1].length).trim()) fence = '';
    } else if (!line.trim()) blank = at > 0;
    else {
      if (blank && !CONTINUES.test(line)) added.push(at);
      blank = false;
      fence = line.match(FENCE_OPEN)?.[1] ?? '';
      if (fence) fenceAt = at;
    }
  }
  return { read: markdown.slice(0, at), fence, fenceAt, blank, whole: false, offsets: added.length ? [...start.offsets, ...added] : start.offsets };
}

/** Offsets where a settled top-level block ends and the next begins: after a blank line outside
 * any open fence, before a complete line that cannot continue the block above. Rendering the parts
 * separately and joining the HTML equals rendering the whole, so a stream re-parses only the part
 * after the last offset. Offsets never move as text is appended (unless syntax that spans the whole
 * document arrives, which returns none). */
export function blockBoundaries(markdown: string, scan = scanBlocks(markdown)): readonly number[] {
  return scan.whole ? [] : scan.offsets;
}

/** Keep finished blocks and text nodes in place as the open Markdown block grows; children before
 * `from` are left alone. Exported for tests. */
export function reconcile(parent: Node, children: Node[], from = 0): void {
  children.forEach((child, index) => {
    const old = parent.childNodes[from + index];
    if (!old) { parent.appendChild(child); return; }
    if (old.nodeType !== child.nodeType || old.nodeName !== child.nodeName) { parent.replaceChild(child, old); return; }
    // A finished block or row is left alone: no records, no walk through its attributes.
    if (old.isEqualNode(child)) return;
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
  state.source = ''; state.settledHtml = []; state.nodes = 0; state.code = undefined;
}

function parsed(html: string): HTMLTemplateElement {
  const template = document.createElement('template');
  template.innerHTML = html;
  return template;
}

// Only the nodes this paint adds (new settled blocks and the tail) are prepared. Only a `patched`
// tail (settledMarkdown closed an open link) can hold OPEN_HREF.
function prepare(nodes: DocumentFragment, target: HTMLElement, patched = false): Node[] {
  if (patched) for (const open of nodes.querySelectorAll(`a[href="${OPEN_HREF}"]`)) {
    const label = document.createElement('span'); label.className = 'md-open-link'; label.append(...open.childNodes);
    open.replaceWith(label);
  }
  decorateFileLinks(nodes, target);
  return [...nodes.childNodes];
}

// At most one paint per display frame, in the frame itself, with a timer for when frames stop.
function schedule(state: Paint): void {
  if (state.pending || state.scheduled || state.rendered === state.value || !state.target.isConnected) return;
  state.scheduled = true;
  let frame = 0, timer: ReturnType<typeof setTimeout> | undefined;
  const run = (): void => { cancelAnimationFrame(frame); clearTimeout(timer); state.scheduled = false; void paint(state); };
  const arm = (): void => { frame = requestAnimationFrame(run); timer = setTimeout(run, FRAME_FALLBACK_MS); };
  // A tail too big to parse every frame (no blank lines, or syntax that spans the whole document)
  // is parsed at most about half the time, so a stream of one giant block is not quadratic per frame.
  if (state.cost > SLOW_PAINT_MS) setTimeout(arm, Math.min(state.cost, MAX_WAIT_MS)); else arm();
}

const lineCount = (text: string): number => text.split('\n').length - 1;
// Where the code of a fence's first `lines` lines ends: each line inside a fence is one line of code.
function afterLines(code: string, lines: number): number {
  let at = 0;
  for (let line = 0; line < lines; line++) if (!(at = code.indexOf('\n', at) + 1)) return -1;
  return at;
}

// The code of a rendered fence that is the whole fragment (not a generative view), if it is one.
function fenceCode(parent: ParentNode, block = parent.firstChild): HTMLElement | undefined {
  const code = block?.nodeName === 'PANDACODE-CODE' ? block.firstChild?.firstChild : undefined;
  return code instanceof HTMLElement && code.nodeName === 'CODE' && !block!.nextSibling?.textContent?.trim() ? code : undefined;
}

/** After a paint that drew `value`'s tail as one open code fence: split its code into the complete
 * lines and the line still streaming, so later paints parse only the lines added since. */
function codeTail(state: Paint, value: string, tailAt: number): CodeTail | undefined {
  const code = fenceCode(state.target, state.target.childNodes[state.nodes]);
  const opened = value.indexOf('\n', tailAt) + 1, end = value.lastIndexOf('\n') + 1;
  if (!code || !opened) return undefined;
  const text = code.textContent ?? '', cut = afterLines(text, lineCount(value.slice(opened, end)));
  if (cut < 0) return undefined;
  const settled = new Text(text.slice(0, cut)), open = new Text(text.slice(cut));
  code.replaceChildren(settled, open);
  return { at: tailAt, opener: value.slice(tailAt, opened), end, source: value.slice(0, end), settled, open };
}

/** Paints a tail that is still one open code fence from only the lines added since the last paint,
 * each rendered under the fence's own opening line (a fence's lines render independently, so the
 * joined code equals the whole render). False when the tail is no longer that fence. */
async function paintCode(state: Paint, value: string, tailAt: number): Promise<boolean> {
  const code = state.code!, end = value.lastIndexOf('\n') + 1, added = value.slice(code.end);
  // Line breaks other than \n and NUL do not map one line to one line of code.
  if (code.at !== tailAt || !state.scan?.fence || state.scan.fenceAt !== tailAt || !code.settled.isConnected || !value.startsWith(code.source) || /[\r\0]/.test(added)) return false;
  const rendered = fenceCode((await markdownNodes(code.opener + added)).content);
  if (!state.target.isConnected || state.value !== value) return true;
  const text = rendered?.textContent ?? '', cut = rendered ? afterLines(text, lineCount(value.slice(code.end, end))) : -1;
  if (cut < 0) return false;
  const restore = state.scroll ? preserveTranscriptPosition(state.scroll, state.target) : undefined;
  if (cut) code.settled.appendData(text.slice(0, cut));
  const open = text.slice(cut);
  if (open.startsWith(code.open.data)) { if (open.length > code.open.length) code.open.appendData(open.slice(code.open.length)); }
  else code.open.data = open;
  code.end = end; code.source = value.slice(0, end); state.rendered = value;
  restore?.();
  return true;
}

/** The finished reply's HTML: the settled blocks' HTML plus one render of the rest (blockBoundaries
 * makes the join equal the whole). Read only when the reply is drawn again. Exported for tests. */
export async function finalHtml(state: Pick<Paint, 'source' | 'settledHtml' | 'scan'>, value: string, render = (text: string) => markdownHtml(text, false)): Promise<string> {
  const ends = blockBoundaries(value, scanBlocks(value, state.scan));
  const kept = state.source && value.startsWith(state.source) && ends.includes(state.source.length) ? state.source : '';
  const parts = kept ? state.settledHtml.join('') : '';
  return parts + await render(value.slice(kept.length));
}

async function paint(state: Paint): Promise<void> {
  if (!state.target.isConnected) return;
  const value = state.value, started = performance.now();
  state.pending = true;
  try {
    state.scan = scanBlocks(value, state.scan);
    const ends = blockBoundaries(value, state.scan), tailAt = ends.at(-1) ?? 0;
    // Settled blocks stay painted while the text only grows past them; any other change repaints all.
    if (!value.startsWith(state.source) || (state.source && !ends.includes(state.source.length))) restart(state);
    if (state.code) { if (await paintCode(state, value, tailAt)) return; state.code = undefined; }
    const fresh = value.slice(state.source.length, tailAt), tail = value.slice(tailAt), shown = settledMarkdown(tail);
    // A reply opened whole (a thread reopened) draws from the cache; the next change settles its blocks.
    const known = state.source ? undefined : markdownCache.get(value);
    const [fresher, open] = known !== undefined ? [undefined, parsed(known)]
      : await Promise.all([fresh ? markdownNodes(fresh) : undefined, markdownNodes(shown)]);
    if (!state.target.isConnected || state.value !== value) return;
    // Settled blocks are serialized once, before decorating, for finalHtml; the tail never is.
    const settledHtml = fresher?.innerHTML;
    const settled = fresher ? prepare(fresher.content, state.target) : [];
    const restore = state.scroll ? preserveTranscriptPosition(state.scroll, state.target) : undefined;
    reconcile(state.target, [...settled, ...prepare(open.content, state.target, shown !== tail)], state.nodes);
    if (known === undefined) { state.nodes += settled.length; state.source = value.slice(0, tailAt); if (settledHtml !== undefined) state.settledHtml.push(settledHtml); }
    if (known === undefined && shown === tail && state.scan.fence && state.scan.fenceAt === tailAt) state.code = codeTail(state, value, tailAt);
    // Toggling a class that is already set still queues a mutation record.
    if (!state.formatted) state.target.classList.add('markdown');
    state.formatted = true; state.rendered = value;
    restore?.();
  } catch {
    // Keep the response readable if a lazy renderer cannot be loaded.
    if (state.target.isConnected && state.value === value) {
      state.target.classList.remove('markdown'); state.target.textContent = value;
      state.formatted = false; state.rendered = value; restart(state);
    }
  } finally { state.cost = performance.now() - started; state.pending = false; schedule(state); }
}

/** One bounded paint per visible response; incoming chunks are never held for a turn to finish. */
export function streamMarkdown(target: HTMLElement, value: string, scroll?: HTMLElement): void {
  const context = captureFileLinkContext(target);
  let state = paints.get(target);
  if (!state) {
    state = { target, value: '', rendered: '', pending: false, scheduled: false, formatted: false, source: '', settledHtml: [], nodes: 0, cost: 0, context };
    paints.set(target, state);
  }
  if (state.context !== context) {
    state.context = context; state.rendered = ''; state.formatted = false; restart(state);
  }
  state.value = value; state.scroll = scroll;
  if (state.deferred !== value) {
    const paint = state;
    if (state.deferred !== undefined) markdownCache.forgo(state.deferred);
    if (value) markdownCache.defer(value, () => finalHtml(paint, value));
    state.deferred = value || undefined;
  }
  if (!value) {
    state.rendered = ''; state.formatted = false; restart(state);
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
