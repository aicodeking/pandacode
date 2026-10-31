import { escape, markdown } from './dom';
import { captureFileLinkContext, decorateFileLinks, workspaceImagePath } from './file-links';
import { trackSegment } from './motion';

export type DocumentView = 'rendered' | 'raw';
/** Reads a workspace image (path from the workspace root) as a data: URL. */
export type ImageLoader = (path: string) => Promise<string>;
type Kind = 'markdown' | 'text' | 'code';

const LINE_LIMIT = 2000;
const WORDS_PER_MINUTE = 230;
const MARKDOWN = /\.(md|markdown|mdx)$/i;
const TEXT = /\.(txt|text|rst|adoc|asciidoc|org)$/i;
const README_LIKE = /^(readme|changelog|changes|contributing|license|licence|authors|notice|copying|todo|history)$/i;

// Session memory: the chosen view per kind of file, and the soft-wrap choice per kind.
const views = new Map<Kind, DocumentView>();
const wraps = new Map<Kind, boolean>();

function kindOf(path: string): Kind {
  const name = path.split('/').pop() ?? '';
  if (MARKDOWN.test(name) || README_LIKE.test(name)) return 'markdown';
  return TEXT.test(name) ? 'text' : 'code';
}

/** Lets an agent (or a caller) choose how the next prose file opens. Code files have one view. */
export function setDocumentView(path: string, view: DocumentView): void {
  const kind = kindOf(path);
  if (kind !== 'code') views.set(kind, view);
}

function stats(content: string): string {
  const words = content.match(/\S+/g)?.length ?? 0;
  const minutes = Math.max(1, Math.round(words / WORDS_PER_MINUTE));
  return `${words.toLocaleString()} word${words === 1 ? '' : 's'} · ${minutes} min read`;
}

function codeLines(content: string): string {
  const lines = content.split('\n', LINE_LIMIT).map((line, i) => `<div class="code-line"><span class="line-number">${i + 1}</span><code>${escape(line) || ' '}</code></div>`).join('');
  const capped = content.split('\n', LINE_LIMIT + 1).length > LINE_LIMIT;
  return `<div class="code-preview">${lines}</div>${capped ? '<div class="inspector-hint">Preview limited to 2,000 lines.</div>' : ''}`;
}

function paragraphs(content: string): string {
  return content.split(/\n\s*\n/).filter(part => part.trim()).map(part => `<p>${escape(part.trim())}</p>`).join('');
}

// READMEs often open with raw HTML (centered banners, <img> tags) that the transcript's
// Markdown engine keeps as text; those documents render as GitHub does instead.
const RAW_HTML = /<\/?(?:div|p|img|picture|br|a|h[1-6]|details|table|span|sup|sub|center)\b[^>]*>/i;
// HTML shown as an example inside code is not the document's own markup.
const withoutCode = (content: string) => content.replace(/^ {0,3}(`{3,}|~{3,})[\s\S]*?^ {0,3}\1/gm, '').replace(/`[^`\n]*`/g, '');
let purifier: Promise<(html: string) => string> | undefined;
function sanitizer(): Promise<(html: string) => string> {
  purifier ??= import('dompurify').then(({ default: createPurify }) => {
    const purify = createPurify(window);
    // Nothing loads from the document's own src: workspace images are read through the
    // app and remote ones are never fetched, so the address moves aside before insertion.
    purify.addHook('afterSanitizeAttributes', node => {
      if (node.nodeName !== 'IMG') return;
      const element = node as Element;
      element.setAttribute('data-src', element.getAttribute('src') ?? '');
      element.removeAttribute('src');
    });
    // HTML only (no SVG or MathML, whose url() references fetch), no app classes, no download links.
    return (html: string) => purify.sanitize(html, { USE_PROFILES: { html: true }, ALLOW_DATA_ATTR: false, FORBID_TAGS: ['style', 'source', 'iframe', 'form', 'input', 'button', 'textarea', 'select', 'option', 'video', 'audio'], FORBID_ATTR: ['style', 'id', 'name', 'class', 'srcset', 'background', 'download'] });
  });
  return purifier;
}

async function renderHtmlDocument(reader: HTMLElement, path: string, content: string, image?: ImageLoader): Promise<void> {
  const [{ marked }, sanitize] = await Promise.all([import('marked'), sanitizer()]);
  const html = sanitize(await marked.parse(content));
  if (!reader.isConnected) return;
  captureFileLinkContext(reader);
  reader.innerHTML = html;
  for (const img of reader.querySelectorAll<HTMLImageElement>('img[data-src]')) {
    const src = img.dataset.src ?? '';
    img.removeAttribute('data-src');
    const local = workspaceImagePath(src, path), label = img.alt || 'Image';
    if (/^data:image\//i.test(src)) img.src = src;
    else if (local && image) image(local).then(url => { img.src = url; }, () => img.replaceWith(label));
    else if (!src || img.closest('a')) img.replaceWith(label);
    // Remote images link to their address instead, as in the transcript.
    else img.replaceWith(Object.assign(document.createElement('a'), { className: 'md-media', href: src, textContent: img.alt || 'Image' }));
  }
  decorateFileLinks(reader, reader);
}

function toolbar(kind: Kind, view: DocumentView, wrap: boolean, content: string): string {
  const segment = (value: DocumentView, label: string) => `<button type="button" data-doc-view="${value}" aria-pressed="${view === value}">${label}</button>`;
  const toggle = kind === 'code' ? '' : `<div class="doc-view-switch" role="group" aria-label="Document view">${segment('rendered', 'Rendered')}${segment('raw', 'Raw')}</div>`;
  const words = kind === 'code' ? '' : `<span class="doc-stats">${stats(content)}</span>`;
  const wrapButton = kind !== 'code' && view === 'rendered' ? '' : `<button type="button" class="doc-wrap" data-doc-wrap aria-pressed="${wrap}">Wrap</button>`;
  return `<div class="doc-toolbar">${toggle}${words}${wrapButton}</div>`;
}

/** Renders a file into the inspector: prose as a reading column (Rendered | Raw), code with line numbers. */
export function renderDocument(host: HTMLElement, path: string, content: string, image?: ImageLoader): void {
  const kind = kindOf(path);
  const view = kind === 'code' ? 'raw' : views.get(kind) ?? 'rendered';
  const wrap = wraps.get(kind) ?? kind !== 'code';
  const body = kind === 'code' ? codeLines(content)
    : view === 'raw' ? `<pre class="doc-raw">${escape(content)}</pre>`
    : kind === 'text' ? `<article class="doc-reader doc-plain">${paragraphs(content)}</article>`
    : '<article class="doc-reader markdown"></article>';
  host.innerHTML = `<div class="document-viewer" data-kind="${kind}" data-view="${view}"${wrap ? ' data-wrap' : ''}>${toolbar(kind, view, wrap, content)}${body}</div>`;
  const viewer = host.firstElementChild as HTMLElement;
  const reader = viewer.querySelector<HTMLElement>('.doc-reader.markdown');
  if (reader && RAW_HTML.test(withoutCode(content))) void renderHtmlDocument(reader, path, content, image).catch(() => markdown(reader, content));
  else if (reader) void markdown(reader, content);
  const group = viewer.querySelector<HTMLElement>('.doc-view-switch');
  if (group) trackSegment(group, group.querySelector('[aria-pressed="true"]'));
  viewer.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-doc-view],[data-doc-wrap]');
    if (!target) return;
    if (target.dataset.docView) views.set(kind, target.dataset.docView as DocumentView);
    else wraps.set(kind, !wrap);
    renderDocument(host, path, content, image);
  });
}
