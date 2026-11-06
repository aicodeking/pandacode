// The inspector's Search view: file-name matches (the @ mention index) and
// find-in-files results, fanned out across the task's folders and grouped by
// folder label when there is more than one. The form stays mounted while the
// view is open, so background inspector refreshes never steal the caret.
import './search-panel.css';
import { escape, fileIcon, icon } from './dom';
import type { FileEntry } from './types';

type Context = { projectId: string; sessionId?: string };
type Scope = { label: string; context: Context };
type TextMatch = { line: number; text: string; ranges: [number, number][] };
export type TextSearchResult = { files: { path: string; matches: TextMatch[] }[]; truncated: boolean };
type Group = { label: string; files: FileEntry[]; text: TextSearchResult | null; error: string };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  /** One search target per project folder, the primary first; a single-folder project has one with an empty label. */
  scopes(): Scope[];
  /** Opens a result; `folder` is the searched group's label, so the host never re-derives it from the qualified path. */
  open(path: string, folder?: string): void;
};
type Toggle = 'matchCase' | 'wholeWord' | 'regex';

const FILE_LIMIT = 8;
const DEBOUNCE_MS = 250;
const TOGGLES: [Toggle, string, string][] = [['matchCase', 'Match case', 'Aa'], ['wholeWord', 'Match whole word', 'ab'], ['regex', 'Use regular expression', '.*']];

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
/** Search rows open through the qualified key: `label/relative` in another folder, bare in the primary. */
const qualified = (group: Group, path: string) => group.label ? `${group.label}/${path}` : path;

export function createSearchPanel(deps: Deps) {
  const state = { key: '', query: '', matchCase: false, wholeWord: false, regex: false, loading: false, groups: [] as Group[], collapsed: new Set<string>() };
  let request = 0, timer: ReturnType<typeof setTimeout> | undefined, mounted: HTMLElement | undefined;

  const multi = () => state.groups.length > 1;

  function show(target: HTMLElement): void {
    const scopes = deps.scopes(), key = scopes.length ? JSON.stringify(scopes) : '';
    if (key !== state.key) {
      // A different project or task checkout: old results point at other files.
      state.key = key; state.groups = []; state.collapsed.clear();
      if (state.query) schedule(0);
    }
    if (mounted === target && target.querySelector(':scope > .search-panel')) return;
    // Files may have changed while another view was open.
    if (key === state.key && state.query) schedule(0);
    mounted = target;
    target.innerHTML = `<div class="search-panel"><form class="search-form" role="search"><div class="search-field">${icon('search')}<input type="search" class="search-input" aria-label="Search in files" placeholder="Search" autocomplete="off" spellcheck="false" maxlength="512" value="${escape(state.query)}"><span class="search-toggles">${TOGGLES.map(([name, label, glyph]) => `<button type="button" class="search-toggle" data-search-toggle="${name}" aria-pressed="${state[name]}" title="${label}" aria-label="${label}">${glyph}</button>`).join('')}</span></div></form><div class="search-results"></div></div>`;
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
      if (element.dataset.searchOpen) { deps.open(element.dataset.searchOpen, element.dataset.searchFolder || undefined); return; }
      const path = element.dataset.searchGroup!;
      if (!state.collapsed.delete(path)) state.collapsed.add(path);
      paint();
    });
    paint();
  }

  function schedule(delay: number): void { clearTimeout(timer); timer = setTimeout(() => void run(), delay); }

  async function run(): Promise<void> {
    const id = ++request, scopes = deps.scopes(), query = state.query;
    if (!scopes.length || !query.trim()) { state.loading = false; state.groups = []; paint(); return; }
    state.loading = true; paint();
    const groups = await Promise.all(scopes.map(async (scope): Promise<Group> => {
      const folder = scope.label ? { folder: scope.label } : {};
      const [files, text] = await Promise.allSettled([
        deps.call<FileEntry[]>('search_files', { ...scope.context, ...folder, query: query.trim(), limit: FILE_LIMIT * 2 }),
        deps.call<TextSearchResult>('search_text', { ...scope.context, ...folder, query, matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex }),
      ]);
      return {
        label: scope.label,
        files: files.status === 'fulfilled' ? files.value.filter(file => !file.isDir).slice(0, FILE_LIMIT) : [],
        text: text.status === 'fulfilled' ? text.value : null,
        error: text.status === 'rejected' ? errorText(text.reason) : '',
      };
    }));
    if (id !== request) return;
    state.loading = false; state.collapsed.clear();
    state.groups = groups;
    paint();
  }

  /** One group's file rows and text rows; single-folder groups render exactly as they always have. */
  function groupPaint(group: Group): { fileRows: string; textRows: string; total: number; truncated: boolean } {
    const fileRows = group.files.map(file => { const { name, folder } = split(file.path); return `<button type="button" class="search-row search-file" data-search-open="${escape(qualified(group, file.path))}" data-search-folder="${escape(group.label)}" title="${escape(qualified(group, file.path))}">${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small></button>`; }).join('');
    const groups = group.text?.files ?? [];
    const total = groups.reduce((sum, group) => sum + group.matches.reduce((n, match) => n + Math.max(1, match.ranges.length), 0), 0);
    const textRows = groups.map(result => {
      const key = qualified(group, result.path), { name, folder } = split(result.path), open = !state.collapsed.has(key);
      return `<div class="search-group"><button type="button" class="search-row search-group-title" data-search-group="${escape(key)}" data-search-folder="${escape(group.label)}" aria-expanded="${open}" title="${escape(key)}">${icon('chevron')}${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small><span class="search-count">${result.matches.length}</span></button>${open ? result.matches.map(match => `<button type="button" class="search-row search-line" data-search-open="${escape(key)}" data-search-folder="${escape(group.label)}" title="${escape(key)}:${match.line}"><span class="search-text">${highlight(match.text, match.ranges)}</span><small>${match.line}</small></button>`).join('') : ''}</div>`;
    }).join('');
    return { fileRows, textRows, total, truncated: group.text?.truncated ?? false };
  }

  function paint(): void {
    const results = mounted?.querySelector<HTMLElement>(':scope > .search-panel > .search-results'); if (!results) return;
    results.setAttribute('aria-busy', String(state.loading));
    if (!state.query.trim()) { results.innerHTML = '<p class="search-hint">Search file names and text in this project.</p>'; return; }
    if (state.loading && !state.groups.length) { results.innerHTML = '<p class="search-hint" role="status">Searching…</p>'; return; }
    if (!multi()) {
      const group = state.groups[0] ?? { label: '', files: [], text: null, error: '' };
      const { fileRows, textRows, total, truncated } = groupPaint(group);
      const groups = group.text?.files ?? [];
      const summary = group.text ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'} in ${groups.length.toLocaleString()} ${groups.length === 1 ? 'file' : 'files'}${truncated ? ' · showing the first 2,000' : ''}` : '';
      results.innerHTML = (group.files.length ? `<section class="search-section" aria-label="Matching file names"><h3>Files</h3>${fileRows}</section>` : '')
        + `<section class="search-section" aria-label="Text matches"><h3>Text${summary ? ` <span class="search-summary">${summary}</span>` : ''}</h3>${group.error ? `<p class="search-error" role="alert">${escape(group.error)}</p>` : groups.length ? textRows : group.text ? '<p class="search-hint">No text matches.</p>' : ''}</section>`;
      return;
    }
    results.innerHTML = state.groups.map(group => {
      const { fileRows, textRows, total } = groupPaint(group);
      const groups = group.text?.files ?? [];
      const summary = group.text ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'} in ${groups.length.toLocaleString()} ${groups.length === 1 ? 'file' : 'files'}` : '';
      const heading = `<h3 class="search-folder">${escape(group.label)}${summary ? ` <span class="search-summary">${summary}</span>` : ''}</h3>`;
      const body = (group.files.length || groups.length || group.error)
        ? (group.files.length ? fileRows : '')
          + (group.error ? `<p class="search-error" role="alert">${escape(group.error)}</p>` : '')
          + (groups.length ? textRows : group.text ? '<p class="search-hint">No text matches.</p>' : '')
        : '<p class="search-hint">No matches.</p>';
      return `<section class="search-section search-section-folder" aria-label="Matches in ${escape(group.label)}">${heading}${body}</section>`;
    }).join('');
  }

  return { show, refresh: () => { if (state.query) schedule(0); } };
}
