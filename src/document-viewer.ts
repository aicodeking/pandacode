import { escape, markdown } from './dom';
import { trackSegment } from './motion';

export type DocumentView = 'rendered' | 'raw';
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

function toolbar(kind: Kind, view: DocumentView, wrap: boolean, content: string): string {
  const segment = (value: DocumentView, label: string) => `<button type="button" data-doc-view="${value}" aria-pressed="${view === value}">${label}</button>`;
  const toggle = kind === 'code' ? '' : `<div class="doc-view-switch" role="group" aria-label="Document view">${segment('rendered', 'Rendered')}${segment('raw', 'Raw')}</div>`;
  const words = kind === 'code' ? '' : `<span class="doc-stats">${stats(content)}</span>`;
  const wrapButton = kind !== 'code' && view === 'rendered' ? '' : `<button type="button" class="doc-wrap" data-doc-wrap aria-pressed="${wrap}">Wrap</button>`;
  return `<div class="doc-toolbar">${toggle}${words}${wrapButton}</div>`;
}

/** Renders a file into the inspector: prose as a reading column (Rendered | Raw), code with line numbers. */
export function renderDocument(host: HTMLElement, path: string, content: string): void {
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
  if (reader) void markdown(reader, content);
  const group = viewer.querySelector<HTMLElement>('.doc-view-switch');
  if (group) trackSegment(group, group.querySelector('[aria-pressed="true"]'));
  viewer.addEventListener('click', event => {
    const target = (event.target as Element).closest<HTMLElement>('[data-doc-view],[data-doc-wrap]');
    if (!target) return;
    if (target.dataset.docView) views.set(kind, target.dataset.docView as DocumentView);
    else wraps.set(kind, !wrap);
    renderDocument(host, path, content);
  });
}
