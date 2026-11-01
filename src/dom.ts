import { captureFileLinkContext, decorateFileLinks, fileReference } from './file-links.ts';
import { preserveTranscriptPosition } from './transcript-scroll.ts';
export function escape(value: unknown): string {
  return String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
}
const paths: Record<string, string> = {
  images: '<rect x="6" y="3" width="15" height="15" rx="2"/><path d="M3 7v12a2 2 0 0 0 2 2h12M6 14l4-4 5 5 3-3 3 3"/><circle cx="16" cy="7" r="1"/>',
  play: '<path d="m8 4 12 8-12 8Z"/>',
  board: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16M15 4v16"/>',
  chat: '<path d="M21 15a2 2 0 0 1-2 2H8l-5 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2Z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  search: '<circle cx="10.5" cy="10.5" r="6.5"/><path d="m16 16 4 4"/>',
  arrow: '<path d="M12 19V5m-6 6 6-6 6 6"/>',
  chevron: '<path d="m9 5 7 7-7 7"/>',
  down: '<path d="m6 9 6 6 6-6"/>',
  close: '<path d="m6 6 12 12M6 18 18 6"/>',
  folder: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/>',
  folderPlus: '<path d="M3 7a2 2 0 0 1 2-2h5l2 2h7a2 2 0 0 1 2 2v10H3Z"/><path d="M12 10v6m-3-3h6"/>',
  file: '<path d="M5 3h9l5 5v13H5Z"/><path d="M14 3v6h5"/>',
  branch: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="6" r="2"/><path d="M6 7v10m0-4c8 0 12-1 12-5"/>',
  worktree: '<rect x="2" y="3" width="6" height="6" rx="1.5"/><rect x="16" y="15" width="6" height="6" rx="1.5"/><path d="M5 9v8a2 2 0 0 0 2 2h9M8 6h9a2 2 0 0 1 2 2v7"/>',
  terminal: '<path d="m4 6 6 6-6 6m9 0h7"/>',
  settings: '<path d="M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8Z"/><path d="m10 3-.7 2.2-2 .9-2.1-.4-2 3.6 1.4 1.7v2l-1.4 1.7 2 3.6 2.2-.4 1.9 1 .7 2.1h4l.7-2.2 2-.9 2.1.4 2-3.6-1.4-1.7v-2l1.4-1.7-2-3.6-2.2.4-1.9-1L14 3Z"/>',
  archive: '<path d="M4 8v13h16V8M3 3h18v5H3Zm6 9h6"/>',
  more: '<circle cx="5" cy="12" r="1"/><circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/>',
  check: '<path d="m5 12 4 4L19 6"/>',
  unlock: '<rect x="4" y="10" width="16" height="11" rx="2"/><path d="M8 10V6a4 4 0 0 1 7.5-2M12 14v3"/>',
  plan: '<rect x="5" y="4" width="14" height="17" rx="2"/><path d="M9 2h6v4H9Zm0 9h6m-6 4h6"/>',
  activity: '<path d="M4 20h16M7 16V9m5 7V4m5 12v-5"/>',
  spark: '<path d="m12 3 2.5 6.5L21 12l-6.5 2.5L12 21l-2.5-6.5L3 12l6.5-2.5Z"/>',
  bot: '<rect x="4" y="8" width="16" height="12" rx="4"/><path d="M12 4v4M9 13v1m6-1v1M2 13v3m20-3v3"/>',
  panel: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M15 4v16"/>',
  sidebar: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M9 4v16"/>',
  attach: '<path d="m8 13 7-7a3 3 0 0 1 4 4L9 20a5 5 0 0 1-7-7L13 2m-5 11 7-7"/>',
  pause: '<path d="M9 5v14M15 5v14"/>',
  github: '<path d="M9 19c-4.3 1.4-4.3-2.5-6-3m12 5v-3.5c0-1 .1-1.4-.5-2 2.8-.3 5.5-1.4 5.5-6a4.6 4.6 0 0 0-1.3-3.2 4.2 4.2 0 0 0-.1-3.2s-1.1-.3-3.5 1.3a12.3 12.3 0 0 0-6.2 0C6.5 2.8 5.4 3.1 5.4 3.1a4.2 4.2 0 0 0-.1 3.2A4.6 4.6 0 0 0 4 9.5c0 4.6 2.7 5.7 5.5 6-.6.6-.6 1.2-.5 2V21"/>',
  external: '<path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 0 1-1 1H5a1 1 0 0 1-1-1V7a1 1 0 0 1 1-1h5"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  refresh: '<path d="M20 7v5h-5M4 17v-5h5M5 8a8 8 0 0 1 13-3l2 3M4 16l2 3a8 8 0 0 0 13-3"/>',
  reset: '<path d="M4 4v6h6M4.8 9a8 8 0 1 1-.3 6"/>',
  edit: '<path d="m14 5 5 5M4 20l5-1L21 7l-5-5L4 14Z"/>',
  command: '<path d="M8 8h8v8H8Zm0 0H5a3 3 0 1 1 3-3Zm8 0V5a3 3 0 1 1 3 3Zm0 8h3a3 3 0 1 1-3 3Zm-8 0v3a3 3 0 1 1-3-3Z"/>',
  leaf: '<path d="M19 3C5 3 2 9 5 15s14 4 14-12ZM5 20l9-11"/>',
  bamboo: '<path d="M9 3v18m-2-6h4M7 8h4m5 5v8m-2-4h4"/><path d="M10 9c1-4 4-6 9-6-1 4-4 6-9 6ZM8 15c-4 0-6-2-6-6 4 0 6 2 6 6Z" fill="currentColor" stroke="none"/>',
  moon: '<path d="M20.5 13A8.5 8.5 0 0 1 11 3.5 8.5 8.5 0 1 0 20.5 13Z"/>',
  clock: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/>',
  sun: '<circle cx="12" cy="12" r="4"/><path d="M12 2v2m0 16v2M2 12h2m16 0h2M5 5l1.5 1.5m11 11L19 19M5 19l1.5-1.5m11-11L19 5"/>',
  copy: '<rect x="8" y="8" width="12" height="13" rx="2"/><path d="M16 8V3H3v13h5"/>',
  alert: '<path d="m12 3 10 18H2Zm0 6v5m0 3v1"/>',
  info: '<circle cx="12" cy="12" r="9"/><path d="M12 11v6m0-10v.01"/>',
  help: '<circle cx="12" cy="12" r="9"/><path d="M9.5 8.5a2.5 2.5 0 0 1 5 .5c0 2-2.5 2-2.5 4m0 3v.01"/>',
  globe: '<circle cx="12" cy="12" r="9"/><ellipse cx="12" cy="12" rx="4" ry="9"/><path d="M3 12h18"/>',
  back: '<path d="m11 5-7 7 7 7M4 12h16"/>',
  forward: '<path d="m13 5 7 7-7 7M20 12H4"/>',
  camera: '<path d="m8 5 2-2h4l2 2h4v15H4V5Z"/><circle cx="12" cy="12" r="4"/>',
  select: '<path d="m5 3 14 10-7 1-3 7Z"/><path d="m14 15 4 5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><path d="M7 7.5h.01M7 16.5h.01M11 7.5h6M11 16.5h6"/>',
  issue: '<circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="1.6" fill="currentColor" stroke="none"/>',
  monitor: '<rect x="3" y="4" width="18" height="12.5" rx="2.2"/><path d="M8.5 20.5h7M12 16.5v4"/>',
  phone: '<rect x="6.5" y="2.5" width="11" height="19" rx="2.8"/><path d="M10.5 5.3h3"/>',
  lock: '<rect x="5" y="10.5" width="14" height="10" rx="2.2"/><path d="M8 10.5V7.5a4 4 0 0 1 8 0v3"/>',
  merge: '<circle cx="18" cy="18" r="2.5"/><circle cx="6" cy="6" r="2.5"/><path d="M6 21V8.5M6 8.5a9.5 9.5 0 0 0 9.5 9.5"/>',
  pull: '<circle cx="6" cy="5" r="2"/><circle cx="6" cy="19" r="2"/><circle cx="18" cy="19" r="2"/><path d="M6 7v10M18 17v-6a3 3 0 0 0-3-3h-4m3-3-3 3 3 3"/>',
  upload: '<path d="M12 16V5m-5 5 5-5 5 5M4 19h16"/>',
  download: '<path d="M12 4v11m-5-5 5 5 5-5M4 19h16"/>',
  sketch: '<path d="M4 20h16"/><path d="m5 16 9.5-9.5a2.1 2.1 0 0 1 3 3L8 19l-4 1Z"/>',
  square: '<rect x="4" y="4" width="16" height="16" rx="2"/>',
  circle: '<circle cx="12" cy="12" r="8"/>',
  line: '<path d="m5 19 14-14"/>',
  minimize: '<path d="M5 12h14"/>',
  pin: '<path d="m16 3 5 5-4 2-3 5-2-2-6 6m3-9L7 8l5-3Z"/>',
  'arrow-right': '<path d="M5 12h14m-6-6 6 6-6 6"/>',
  text: '<path d="M5 6h14M12 6v14m-4 0h8"/>',
  undo: '<path d="M9 14 4 9l5-5"/><path d="M4 9h10a6 6 0 0 1 0 12h-3"/>',
  redo: '<path d="m15 14 5-5-5-5"/><path d="M20 9H10a6 6 0 0 0 0 12h3"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-8 0 1 13h8l1-13"/>',
  move: '<path d="M12 3v18M3 12h18M8 7l4-4 4 4M8 17l4 4 4-4M7 8l-4 4 4 4m10-8 4 4-4 4"/>',
  grid: '<path d="M3 9h18M3 15h18M9 3v18M15 3v18"/>',
  kanban: '<rect x="3" y="4" width="5" height="16" rx="1.5"/><rect x="9.5" y="4" width="5" height="10" rx="1.5"/><rect x="16" y="4" width="5" height="13" rx="1.5"/>',
  thread: '<path d="M14 9a2 2 0 0 1-2 2H6l-3 3V4a1 1 0 0 1 1-1h8a2 2 0 0 1 2 2Z"/><path d="M18 9h2a1 1 0 0 1 1 1v11l-3-3h-6a2 2 0 0 1-2-2v-1"/>',
  widget: '<rect x="3" y="5" width="18" height="6" rx="1.5"/><rect x="3" y="14" width="10" height="5" rx="1.5"/><path d="M16 16.5h5"/>',
};
export function icon(name: string, cls = ''): string { return `<svg class="icon ${cls}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths[name] ?? paths.file}</svg>`; }
// Material file icons load in their own chunk to keep the startup bundle small; plain glyphs show until then.
let fileIcons: typeof import('./file-icons.ts') | undefined;
let loadFileIcons: () => void = () => {};
// Resolves once the icon chunk has loaded; the chunk is fetched on the first fileIcon() call, not at startup.
export const fileIconsReady = new Promise<void>(resolve => {
  let started = false;
  loadFileIcons = () => {
    if (started) return;
    started = true;
    import('./file-icons.ts').then(module => { fileIcons = module; }, error => console.warn('File icons unavailable', error)).then(() => resolve());
  };
});
export function fileIcon(name: string, isDir: boolean): string {
  if (!fileIcons) loadFileIcons();
  return fileIcons?.fileIcon(name, isDir, document.documentElement.dataset.theme === 'light') ?? icon(isDir ? 'folder' : 'file');
}
export function button(action: string, label: string, symbol: string, cls = '', extra = ''): string { return `<button class="icon-button ${cls}" data-action="${action}" title="${escape(label)}" aria-label="${escape(label)}" ${extra}>${icon(symbol)}</button>`; }
export function $(selector: string): HTMLElement { const el = document.querySelector<HTMLElement>(selector); if (!el) throw new Error(`Missing element ${selector}`); return el; }
// Local file URLs become inert workspace candidates before the sanitizer strips their
// scheme. The later resolver is the only route to opening them.
function workspaceHref(href: string): string {
  const path = /^file:/i.test(href) ? fileReference(href) : undefined;
  return path ? encodeURI(/^[a-z]:[\\/]/i.test(path) ? `/${path}` : path) : href;
}
// Compile the parser as soon as the app starts, so the first message renders formatted
// rather than as raw text that reflows. A microtask, not a timer, so nothing delays it.
void Promise.resolve().then(() => import('./enriched-markdown')).then(engine => engine.parseMarkdown('')).catch(() => { /* markdownHtml falls back when it is needed. */ });
/* Formatted Markdown by source text. Reopening a thread draws its final layout in one
 * frame instead of raw text that reflows once the parser answers. An LRU bounded by size:
 * source plus HTML, in UTF-16 code units (about 4 M characters, 8 MB). */
const RENDERED_LIMIT = 4 * 1024 * 1024;
const rendered = new Map<string, string>();
let renderedSize = 0;
function forget(value: string): void {
  const html = rendered.get(value);
  if (html === undefined) return;
  rendered.delete(value); renderedSize -= value.length + html.length;
}
function remember(value: string, html: string): void {
  forget(value);
  const size = value.length + html.length;
  if (size > RENDERED_LIMIT) return;
  rendered.set(value, html); renderedSize += size;
  for (const oldest of rendered.keys()) { if (renderedSize <= RENDERED_LIMIT) break; forget(oldest); }
}
// A stream registers its latest value here instead: the HTML (what the stream already settled plus
// one render of the rest) is built only when the finished reply is drawn again, never per frame.
const DEFERRED_LIMIT = 16;
const deferred = new Map<string, () => Promise<string>>();
function defer(value: string, build: () => Promise<string>): void {
  deferred.delete(value); deferred.set(value, build);
  for (const oldest of deferred.keys()) { if (deferred.size <= DEFERRED_LIMIT) break; deferred.delete(oldest); }
}
/** Builds and remembers `value`'s deferred entry; undefined when there is none or it fails. */
function settle(value: string): Promise<string | undefined> | undefined {
  const build = deferred.get(value);
  if (!build) return undefined;
  deferred.delete(value);
  return build().then(html => { remember(value, html); return html; }, () => undefined);
}
/** The formatted-Markdown cache, for the streaming painter (which registers its stream's latest
 * value, so a finished reply draws without parsing it whole) and tests. */
export const markdownCache = {
  get: (value: string) => rendered.get(value), set: remember, defer, settle, forgo: (value: string) => deferred.delete(value), size: () => renderedSize, limit: RENDERED_LIMIT,
  delete: (value: string) => { deferred.delete(value); forget(value); },
};
const PURIFY = { ADD_TAGS: ['pandacode-ui', 'pandacode-code'], ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'img', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'option', 'video', 'audio'], FORBID_ATTR: ['style', 'id', 'name'] };
type Modules = { purify: typeof import('dompurify').default; enriched: typeof import('./enriched-markdown') };
// Resolved once: after that a render awaits only the parser's own (already settled) promise, so a
// paint started in an animation frame lands in that frame, not in a later task.
let modules: Modules | undefined;
let loading: Promise<Modules> | undefined;
function loadModules(): Promise<Modules> {
  // generative-ui defines <pandacode-ui> (generative UI views) before any HTML that holds one is used.
  loading ??= Promise.all([import('dompurify'), import('./enriched-markdown'), import('./generative-ui')])
    .then(([purify, enriched]) => (modules = { purify: purify.default, enriched }), error => { loading = undefined; throw error; });
  return loading;
}
let fallback: Promise<(value: string) => string | Promise<string>> | undefined;
async function unsafeHtml(enriched: Modules['enriched'], value: string): Promise<string> {
  try {
    return enriched.renderMarkdown(await enriched.parseMarkdown(value), { link: workspaceHref });
  } catch {
    fallback ??= import('marked').then(m => {
      const links = new m.Renderer(); const renderLink = links.link;
      links.link = function (token) { return renderLink.call(this, { ...token, href: workspaceHref(token.href) }); };
      return (text: string) => m.marked.parse(text, { renderer: links });
    });
    return (await fallback)(value);
  }
}
/** Markdown to safe HTML through the Enriched Markdown engine (md4c), with `marked` as a
 * fallback if its WebAssembly cannot start. Math is typeset after sanitizing, from KaTeX.
 * Pass `cache = false` for text that is still changing, so passing prefixes never fill the cache. */
export async function markdownHtml(value: string, cache = true): Promise<string> {
  const { purify, enriched } = modules ?? await loadModules();
  const result = pendingView(value, await enriched.typesetMath(purify.sanitize(await unsafeHtml(enriched, value), PURIFY)));
  if (cache) remember(value, result);
  return result;
}
/** markdownHtml's output as a template's inert content; its `innerHTML` is the HTML, serialized
 * only if read. Without math or an open view, the sanitizer's own nodes are kept instead of
 * serializing and parsing them again. */
export async function markdownNodes(value: string): Promise<HTMLTemplateElement> {
  const { purify, enriched } = modules ?? await loadModules();
  const unsafe = await unsafeHtml(enriched, value), template = document.createElement('template');
  if (unsafe.includes('md-math') || openViewFence(value)) {
    template.innerHTML = pendingView(value, await enriched.typesetMath(purify.sanitize(unsafe, PURIFY)));
    return template;
  }
  template.content.append(purify.sanitize(unsafe, { ...PURIFY, RETURN_DOM_FRAGMENT: true }));
  // Removed tags leave their text beside its neighbours; parsing the HTML would have joined them.
  template.content.normalize();
  return template;
}
const FENCE_LINE = /^ {0,3}(`{3,}|~{3,})[ \t]*([^\s`]*)/;
/** Whether the text ends inside an open generative-UI fence (a reply still streaming). */
export function openViewFence(value: string): boolean {
  let open: { mark: string; view: boolean } | undefined;
  for (const line of value.split('\n')) {
    const fence = line.match(FENCE_LINE);
    if (!fence) continue;
    if (!open) open = { mark: fence[1], view: /^(?:ui|chart|svg|html|mermaid)$/i.test(fence[2]) };
    else if (fence[1][0] === open.mark[0] && fence[1].length >= open.mark.length && !fence[2] && !line.slice(line.indexOf(fence[1]) + fence[1].length).trim()) open = undefined;
  }
  return Boolean(open?.view);
}
/** An unfinished view shows a placeholder until its fence closes, instead of half-parsed JSON. */
function pendingView(value: string, html: string): string {
  if (!openViewFence(value)) return html;
  const at = html.lastIndexOf('<pandacode-ui>');
  return at < 0 ? html : `${html.slice(0, at)}<pandacode-ui class="pending">${html.slice(at + 14)}`;
}
export async function markdown(target: HTMLElement, value: string, scroll?: HTMLElement): Promise<void> {
  captureFileLinkContext(target);
  const known = rendered.get(value);
  if (known !== undefined) { remember(value, known); target.innerHTML = known; decorateFileLinks(target, target); return; }
  // A reply that just streamed is built from its stream's settled HTML, not parsed whole again.
  const settling = settle(value);
  target.textContent = value;
  const html = (settling && await settling) ?? await markdownHtml(value);
  if (target.isConnected && target.textContent === value) {
    const restore = scroll ? preserveTranscriptPosition(scroll, target) : undefined;
    target.innerHTML = html;
    decorateFileLinks(target, target);
    restore?.();
  }
}

/** Update `target`'s children to match `html`, touching only what changed. Unchanged rows
 *  keep their nodes (images stay decoded, hover and focus stay put); `depth` bounds how far
 *  it descends before replacing a subtree whose shape changed. */
export function morph(target: Element, html: string, depth = 4): void {
  const template = document.createElement('template');
  template.innerHTML = html;
  morphChildren(target, template.content, depth);
}
function morphChildren(from: Element, to: ParentNode, depth: number): void {
  const before = [...from.childNodes], after = [...to.childNodes];
  if (depth <= 0 || before.length !== after.length || before.some((node, i) => node.nodeName !== after[i].nodeName)) {
    from.replaceChildren(...after);
    return;
  }
  before.forEach((node, i) => {
    const next = after[i];
    if (node instanceof Element && next instanceof Element) {
      if (node.outerHTML === next.outerHTML) return;
      // An element never changes what it stands for: a row whose task moved is replaced, so a
      // click landing during a background update still reaches the row under the pointer.
      if (node.id !== next.id || node.getAttribute('data-id') !== next.getAttribute('data-id')) { node.replaceWith(next); return; }
      for (const { name } of [...node.attributes]) if (!next.hasAttribute(name)) node.removeAttribute(name);
      for (const { name, value } of [...next.attributes]) if (node.getAttribute(name) !== value) node.setAttribute(name, value);
      morphChildren(node, next, depth - 1);
    } else if (node.nodeValue !== next.nodeValue) node.nodeValue = next.nodeValue;
  });
}
