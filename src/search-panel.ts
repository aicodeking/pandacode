// The inspector's Search view: file-name matches (the @ mention index) and
// find-in-files results. The form stays mounted while the view is open, so
// background inspector refreshes never steal the caret.
import './search-panel.css';
import { t } from './i18n.ts';
import { escape, fileIcon, icon } from './dom';
import type { FileEntry } from './types';

type Context = { projectId: string; sessionId?: string };
type TextMatch = { line: number; text: string; ranges: [number, number][] };
export type TextSearchResult = { files: { path: string; matches: TextMatch[] }[]; truncated: boolean };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  context(): Context | null;
  open(path: string): void;
};
type Toggle = 'matchCase' | 'wholeWord' | 'regex';

const FILE_LIMIT = 8;
const DEBOUNCE_MS = 250;
const TOGGLES: [Toggle, string, string][] = [['matchCase', t('Match case'), 'Aa'], ['wholeWord', t('Match whole word'), 'ab'], ['regex', t('Use regular expression'), '.*']];

/** Escaped line text with each UTF-16 range wrapped in <mark>. */
export function highlight(text: string, ranges: [number, number][]): string {
  let html = '', at = 0;
  for (const [start, end] of ranges) {
    if (start < at) continue;
    html += escape(text.slice(at, start)) + `<mark>${escape(text.slice(start, end))}</mark>`;
    at = end;
  }
  return html + escape(text.slice(at));
}

const split = (path: string) => { const at = path.lastIndexOf('/'); return { name: path.slice(at + 1), folder: at < 0 ? '' : path.slice(0, at) }; };
const errorText = (error: unknown) => error instanceof Error ? error.message : String(error);

export function createSearchPanel(deps: Deps) {
  const state = { key: '', query: '', matchCase: false, wholeWord: false, regex: false, loading: false, error: '', files: [] as FileEntry[], text: null as TextSearchResult | null, collapsed: new Set<string>() };
  let request = 0, timer: ReturnType<typeof setTimeout> | undefined, mounted: HTMLElement | undefined;

  function show(target: HTMLElement): void {
    const context = deps.context(), key = context ? JSON.stringify(context) : '';
    if (key !== state.key) {
      // A different project or task checkout: old results point at other files.
      state.key = key; state.files = []; state.text = null; state.error = ''; state.collapsed.clear();
      if (state.query) schedule(0);
    }
    if (mounted === target && target.querySelector(':scope > .search-panel')) return;
    // Files may have changed while another view was open.
    if (key === state.key && state.query) schedule(0);
    mounted = target;
    target.innerHTML = `<div class="search-panel"><form class="search-form" role="search"><div class="search-field">${icon('search')}<input type="search" class="search-input" aria-label="${t('Search in files')}" placeholder="${t('Search')}" autocomplete="off" spellcheck="false" maxlength="512" value="${escape(state.query)}"><span class="search-toggles">${TOGGLES.map(([name, label, glyph]) => `<button type="button" class="search-toggle" data-search-toggle="${name}" aria-pressed="${state[name]}" title="${label}" aria-label="${label}">${glyph}</button>`).join('')}</span></div></form><div class="search-results"></div></div>`;
    const form = target.querySelector<HTMLFormElement>('.search-form')!, input = form.querySelector<HTMLInputElement>('.search-input')!;
    input.addEventListener('input', () => { state.query = input.value; schedule(DEBOUNCE_MS); });
    form.addEventListener('submit', event => { event.preventDefault(); schedule(0); });
    form.addEventListener('click', event => {
      const toggle = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-search-toggle]'); if (!toggle) return;
      const name = toggle.dataset.searchToggle as Toggle;
      state[name] = !state[name]; toggle.setAttribute('aria-pressed', String(state[name]));
      if (state.query) schedule(0);
    });
    target.querySelector('.search-results')!.addEventListener('click', event => {
      const element = (event.target as HTMLElement).closest<HTMLElement>('[data-search-open],[data-search-group]'); if (!element) return;
      if (element.dataset.searchOpen) { deps.open(element.dataset.searchOpen); return; }
      const path = element.dataset.searchGroup!;
      if (!state.collapsed.delete(path)) state.collapsed.add(path);
      paint();
    });
    paint();
  }

  function schedule(delay: number): void { clearTimeout(timer); timer = setTimeout(() => void run(), delay); }

  async function run(): Promise<void> {
    const id = ++request, context = deps.context(), query = state.query;
    if (!context || !query.trim()) { state.loading = false; state.files = []; state.text = null; state.error = ''; paint(); return; }
    state.loading = true; paint();
    const [files, text] = await Promise.allSettled([
      deps.call<FileEntry[]>('search_files', { ...context, query: query.trim(), limit: FILE_LIMIT * 2 }),
      deps.call<TextSearchResult>('search_text', { ...context, query, matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex }),
    ]);
    if (id !== request) return;
    state.loading = false; state.collapsed.clear();
    state.files = files.status === 'fulfilled' ? files.value.filter(file => !file.isDir).slice(0, FILE_LIMIT) : [];
    state.text = text.status === 'fulfilled' ? text.value : null;
    state.error = text.status === 'rejected' ? errorText(text.reason) : '';
    paint();
  }

  function paint(): void {
    const results = mounted?.querySelector<HTMLElement>(':scope > .search-panel > .search-results'); if (!results) return;
    results.setAttribute('aria-busy', String(state.loading));
    if (!state.query.trim()) { results.innerHTML = `<p class="search-hint">${t('Search file names and text in this project.')}</p>`; return; }
    if (state.loading && !state.text && !state.files.length) { results.innerHTML = `<p class="search-hint" role="status">${t('Searching…')}</p>`; return; }
    const fileRows = state.files.map(file => { const { name, folder } = split(file.path); return `<button type="button" class="search-row search-file" data-search-open="${escape(file.path)}" title="${escape(file.path)}">${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small></button>`; }).join('');
    const groups = state.text?.files ?? [];
    const total = groups.reduce((sum, group) => sum + group.matches.reduce((n, match) => n + Math.max(1, match.ranges.length), 0), 0);
    const summary = state.text ? `${total.toLocaleString()} ${total === 1 ? t('result') : t('results')} in ${groups.length.toLocaleString()} ${groups.length === 1 ? t('file') : t('files')}${state.text.truncated ? ` · ${t('showing the first 2,000')}` : ''}` : '';
    const textRows = groups.map(group => {
      const { name, folder } = split(group.path), open = !state.collapsed.has(group.path);
      return `<div class="search-group"><button type="button" class="search-row search-group-title" data-search-group="${escape(group.path)}" aria-expanded="${open}" title="${escape(group.path)}">${icon('chevron')}${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small><span class="search-count">${group.matches.length}</span></button>${open ? group.matches.map(match => `<button type="button" class="search-row search-line" data-search-open="${escape(group.path)}" title="${escape(group.path)}:${match.line}"><span class="search-text">${highlight(match.text, match.ranges)}</span><small>${match.line}</small></button>`).join('') : ''}</div>`;
    }).join('');
    results.innerHTML = (state.files.length ? `<section class="search-section" aria-label="${t('Matching file names')}"><h3>${t('Files')}</h3>${fileRows}</section>` : '')
      + `<section class="search-section" aria-label="${t('Text matches')}"><h3>${t('Text')}${summary ? ` <span class="search-summary">${summary}</span>` : ''}</h3>${state.error ? `<p class="search-error" role="alert">${escape(state.error)}</p>` : groups.length ? textRows : state.text ? `<p class="search-hint">${t('No text matches.')}</p>` : ''}</section>`;
  }

  return { show, refresh: () => { if (state.query) schedule(0); } };
}
