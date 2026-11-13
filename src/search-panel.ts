// The inspector's Search view: file-name matches (the @ mention index) and
// find-in-files results. The form stays mounted while the view is open, so
// background inspector refreshes never steal the caret.
import './search-panel.css';
import { escape, fileIcon, icon, isImeKey } from './dom';
import type { FileEntry } from './types';
import { createSearchPresentation, snapshotSearch, type SearchPresentation, type SearchResult } from './extensions/search';
import { applySearchPresentation, componentProviders, componentSelection } from './extensions/replacement';
import { extensionsSnapshot, extensionIdentity, onExtensionsChanged } from './extensions/manager';
import { applyControlOrder, applyControlVisibility, layout } from './extensions/layout-host';

type Context = { projectId: string; sessionId?: string };
type TextMatch = { line: number; text: string; ranges: [number, number][] };
export type TextSearchResult = { files: { path: string; matches: TextMatch[] }[]; truncated: boolean };
type Deps = {
  call<T>(command: string, args: Record<string, unknown>): Promise<T>;
  context(): Context | null;
  open(path: string): void;
  contextMenu?(anchor: HTMLElement, path: string, point?: { x: number; y: number }): void;
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

export function createSearchPanel(deps: Deps) {
  const state = { key: '', query: '', matchCase: false, wholeWord: false, regex: false, loading: false, error: '', files: [] as FileEntry[], text: null as TextSearchResult | null, collapsed: new Set<string>(), selected: '' };
  let request = 0, timer: ReturnType<typeof setTimeout> | undefined, mounted: HTMLElement | undefined;
  const instance = crypto.randomUUID(), applied = new Set<string>(), cursors = new Map<string, number>();
  let revision = 0, entries: SearchResult[] = [];
  const contextKey = () => { const context = deps.context(); return context ? JSON.stringify(context) : ''; };
  function changed() { revision++; cursors.clear(); }
  function presentation(offset = 0, metadata = true): SearchPresentation {
    const end = Math.min(entries.length, offset + 64);
    let next = '';
    if (metadata && end < entries.length) { next = `${instance}:${revision}:${end}`; cursors.set(next, end); }
    const current = contextKey() === state.key;
    return snapshotSearch({ contractVersion: 1, context: instance, project: contextKey() || 'none', revision, query: state.query, matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex, loading: state.loading, error: Boolean(state.error), visible: current && Boolean(mounted?.querySelector('.search-panel')?.checkVisibility()), selected: metadata && current ? state.selected : '', results: metadata && current ? entries.slice(offset, end) : [], next: current ? next : '', truncated: Boolean(state.text?.truncated) });
  }
  function authority() {
    const provider = componentSelection.resolve('panda.search', componentProviders());
    const owner = extensionsSnapshot().packages.find(item => item.manifest.id === provider?.id.split('/')[0]);
    return { owner: provider?.id ?? '', active: Boolean(provider && mounted?.querySelector<HTMLElement>('.search-panel')?.dataset.searchProvider === provider.id), granted: Boolean(owner?.manifest.permissions?.includes('ui.contribute')), metadata: Boolean(owner?.manifest.permissions?.includes('projects.files.metadata')) };
  }
  function page(cursor = '') {
    const auth = authority();
    if (!auth.active || !auth.granted || !auth.metadata) return { ok: false, reason: 'PermissionDenied' } as const;
    if (contextKey() !== state.key) return { ok: false, reason: 'ResyncRequired' } as const;
    const offset = cursor ? cursors.get(cursor) : 0;
    if (offset === undefined) return { ok: false, reason: 'ResyncRequired' } as const;
    return { ok: true, value: presentation(offset) } as const;
  }
  function dispatch(action: unknown) {
    const resultId = action && typeof action === 'object' ? Object.getOwnPropertyDescriptor(action, 'resultId')?.value : undefined;
    const auth = authority(), offset = Math.max(0, Math.floor(entries.findIndex(item => item.id === resultId) / 64) * 64);
    const identity = extensionIdentity(auth.owner.split('/')[0]);
    const slot = createSearchPresentation(presentation(offset, auth.metadata), auth.owner, () => presentation(offset, authority().metadata), () => ({ ...authority(), active: authority().active && extensionIdentity(auth.owner.split('/')[0]) === identity }), input => {
      if (input.controlId === 'query') {
        state.query = input.value;
        const field = mounted?.querySelector<HTMLInputElement>('.search-input'); if (field) field.value = state.query;
        schedule(DEBOUNCE_MS, true);
      } else if (input.controlId === 'submit') schedule(0);
      else if (['matchCase', 'wholeWord', 'regex'].includes(input.controlId)) toggle(input.controlId as Toggle);
      else {
        const result = entries.find(item => item.id === input.resultId)!;
        if (input.controlId === 'open') open(result.path, result.id);
        else collapse(result.path);
      }
    }, applied);
    const result = slot.dispatch(action); slot.dispose(); return result;
  }
  function configure() {
    const host = mounted?.querySelector<HTMLElement>('.search-panel'); if (!host) return;
    host.style.display = 'flex'; host.style.flexDirection = 'column';
    applySearchPresentation(host);
    const bindings = [ ['panda.search.controls/query', host.querySelector<HTMLElement>('.search-input')], ...TOGGLES.map(([name]) => [`panda.search.controls/${name.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)}`, host.querySelector<HTMLElement>(`[data-search-toggle="${name}"]`)] as const) ] as const;
    applyControlVisibility(bindings, () => [...host.querySelectorAll<HTMLElement>('input,button')].find(node => !node.inert && node.checkVisibility()) ?? null);
    applyControlOrder('panda.search.controls', bindings);
  }
  const lifecycle = () => { changed(); configure(); };
  const unsubscribe = onExtensionsChanged(lifecycle), unlayout = layout.subscribe(configure);
  window.addEventListener('pandacode-components-change', lifecycle);
  function toggle(name: Toggle) {
    state[name] = !state[name];
    mounted?.querySelector(`[data-search-toggle="${name}"]`)?.setAttribute('aria-pressed', String(state[name]));
    if (state.query) schedule(0, true); else changed();
  }
  function open(path: string, id = '') { if (contextKey() !== state.key) return; state.selected = id; changed(); deps.open(path); }
  function collapse(path: string) { if (!state.collapsed.delete(path)) state.collapsed.add(path); changed(); paint(); }

  function show(target: HTMLElement): void {
    const context = deps.context(), key = context ? JSON.stringify(context) : '';
    if (key !== state.key) {
      // A different project or task checkout: old results point at other files.
      ++request; changed(); state.key = key; state.files = []; state.text = null; entries = []; state.selected = ''; state.error = ''; state.collapsed.clear();
      if (state.query) schedule(0);
    }
    if (mounted === target && target.querySelector(':scope > .search-panel')) { configure(); return; }
    // Files may have changed while another view was open.
    if (key === state.key && state.query) schedule(0);
    mounted = target;
    target.innerHTML = `<div class="search-panel"><form class="search-form" role="search"><div class="search-field">${icon('search')}<input type="search" class="search-input" aria-label="Search in files" placeholder="Search" autocomplete="off" spellcheck="false" maxlength="512" value="${escape(state.query)}"><span class="search-toggles">${TOGGLES.map(([name, label, glyph]) => `<button type="button" class="search-toggle" data-search-toggle="${name}" aria-pressed="${state[name]}" title="${label}" aria-label="${label}">${glyph}</button>`).join('')}</span></div></form><div class="search-results"></div></div>`;
    const form = target.querySelector<HTMLFormElement>('.search-form')!, input = form.querySelector<HTMLInputElement>('.search-input')!;
    let composing = false;
    input.addEventListener('compositionstart', () => { composing = true; clearTimeout(timer); ++request; changed(); state.files = []; state.text = null; entries = []; state.selected = ''; paint(); });
    input.addEventListener('compositionend', () => { composing = false; state.query = input.value; schedule(DEBOUNCE_MS, true); });
    input.addEventListener('input', () => { state.query = input.value; if (!composing) schedule(DEBOUNCE_MS, true); });
    form.addEventListener('keydown', event => { if (event.key === 'Enter' && isImeKey(event)) event.preventDefault(); });
    form.addEventListener('submit', event => { event.preventDefault(); if (!composing) schedule(0); });
    form.addEventListener('click', event => {
      const button = (event.target as HTMLElement).closest<HTMLButtonElement>('[data-search-toggle]'); if (!button) return;
      toggle(button.dataset.searchToggle as Toggle);
    });
    target.querySelector('.search-results')!.addEventListener('click', event => {
      const element = (event.target as HTMLElement).closest<HTMLElement>('[data-search-open],[data-search-group]'); if (!element) return;
      if (element.dataset.searchOpen) { open(element.dataset.searchOpen, entries.find(item => item.path === element.dataset.searchOpen && item.line === Number(element.dataset.searchLine ?? 0))?.id); return; }
      const path = element.dataset.searchGroup!;
      collapse(path);
    });
    target.querySelector('.search-results')!.addEventListener('contextmenu', event => {
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-search-open],[data-search-group]');
      if (!row || !deps.contextMenu) return;
      event.preventDefault();
      deps.contextMenu(row, row.dataset.searchOpen ?? row.dataset.searchGroup!, { x: (event as MouseEvent).clientX, y: (event as MouseEvent).clientY });
    });
    target.querySelector('.search-results')!.addEventListener('keydown', event => {
      const key = event as KeyboardEvent;
      if (isImeKey(key)) return;
      if (key.key !== 'ContextMenu' && !(key.key === 'F10' && key.shiftKey)) return;
      const row = (event.target as HTMLElement).closest<HTMLElement>('[data-search-open],[data-search-group]');
      if (!row || !deps.contextMenu) return;
      event.preventDefault(); deps.contextMenu(row, row.dataset.searchOpen ?? row.dataset.searchGroup!);
    });
    paint(); configure();
  }

  function schedule(delay: number, clear = false): void {
    clearTimeout(timer); ++request; changed();
    if (clear) { state.files = []; state.text = null; state.error = ''; state.selected = ''; entries = []; state.collapsed.clear(); state.loading = Boolean(state.query.trim()); paint(); }
    timer = setTimeout(() => void run(), delay);
  }

  async function run(): Promise<void> {
    const id = ++request, context = deps.context(), query = state.query;
    if (!context || !query.trim()) { state.loading = false; state.files = []; state.text = null; state.error = ''; paint(); return; }
    const captured = JSON.stringify([context, query, state.matchCase, state.wholeWord, state.regex]);
    state.loading = true; changed(); paint();
    const [files, text] = await Promise.allSettled([
      deps.call<FileEntry[]>('search_files', { ...context, query: query.trim(), limit: FILE_LIMIT * 2 }),
      deps.call<TextSearchResult>('search_text', { ...context, query, matchCase: state.matchCase, wholeWord: state.wholeWord, regex: state.regex }),
    ]);
    if (id !== request || captured !== JSON.stringify([deps.context(), state.query, state.matchCase, state.wholeWord, state.regex])) return;
    const selected = entries.find(item => item.id === state.selected);
    state.loading = false;
    state.files = files.status === 'fulfilled' ? files.value.filter(file => !file.isDir).slice(0, FILE_LIMIT) : [];
    state.text = text.status === 'fulfilled' ? text.value : null;
    state.error = text.status === 'rejected' ? errorText(text.reason) : '';
    changed();
    entries = [...state.files.map(file => ({ id: crypto.randomUUID(), path: file.path, line: 0, collapsed: false })), ...(state.text?.files ?? []).flatMap(group => [ { id: crypto.randomUUID(), path: group.path, line: 0, collapsed: false }, ...group.matches.map(match => ({ id: crypto.randomUUID(), path: group.path, line: match.line, collapsed: false })) ])];
    state.selected = selected ? entries.find(item => item.path === selected.path && item.line === selected.line)?.id ?? '' : '';
    paint();
  }

  function paint(): void {
    entries = entries.map(item => ({ ...item, collapsed: state.collapsed.has(item.path) }));
    const results = mounted?.querySelector<HTMLElement>(':scope > .search-panel > .search-results'); if (!results) return;
    const focused = document.activeElement instanceof HTMLElement && results.contains(document.activeElement) ? { path: document.activeElement.dataset.searchOpen, group: document.activeElement.dataset.searchGroup, title: document.activeElement.title } : undefined;
    results.setAttribute('aria-busy', String(state.loading));
    if (!state.query.trim()) { results.innerHTML = '<p class="search-hint">Search file names and text in this project.</p>'; return; }
    if (state.loading && !state.text && !state.files.length) { results.innerHTML = '<p class="search-hint" role="status">Searching…</p>'; return; }
    const fileRows = state.files.map(file => { const { name, folder } = split(file.path); return `<button type="button" class="search-row search-file" data-search-open="${escape(file.path)}" title="${escape(file.path)}">${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small></button>`; }).join('');
    const groups = state.text?.files ?? [];
    const total = groups.reduce((sum, group) => sum + group.matches.reduce((n, match) => n + Math.max(1, match.ranges.length), 0), 0);
    const summary = state.text ? `${total.toLocaleString()} ${total === 1 ? 'result' : 'results'} in ${groups.length.toLocaleString()} ${groups.length === 1 ? 'file' : 'files'}${state.text.truncated ? ' · showing the first 2,000' : ''}` : '';
    const textRows = groups.map(group => {
      const { name, folder } = split(group.path), open = !state.collapsed.has(group.path);
      return `<div class="search-group"><button type="button" class="search-row search-group-title" data-search-group="${escape(group.path)}" aria-expanded="${open}" title="${escape(group.path)}">${icon('chevron')}${fileIcon(name, false)}<span class="search-name">${escape(name)}</span><small>${escape(folder)}</small><span class="search-count">${group.matches.length}</span></button>${open ? group.matches.map(match => `<button type="button" class="search-row search-line" data-search-open="${escape(group.path)}" data-search-line="${match.line}" title="${escape(group.path)}:${match.line}"><span class="search-text">${highlight(match.text, match.ranges)}</span><small>${match.line}</small></button>`).join('') : ''}</div>`;
    }).join('');
    results.innerHTML = (state.files.length ? `<section class="search-section" aria-label="Matching file names"><h3>Files</h3>${fileRows}</section>` : '')
      + `<section class="search-section" aria-label="Text matches"><h3>Text${summary ? ` <span class="search-summary">${summary}</span>` : ''}</h3>${state.error ? `<p class="search-error" role="alert">${escape(state.error)}</p>` : groups.length ? textRows : state.text ? '<p class="search-hint">No text matches.</p>' : ''}</section>`;
    if (focused) [...results.querySelectorAll<HTMLElement>('[data-search-open],[data-search-group]')].find(node => node.dataset.searchOpen === focused.path && node.dataset.searchGroup === focused.group && node.title === focused.title)?.focus({ preventScroll: true });
  }

  return { show, page, presentation: () => presentation(), dispatch, refresh: () => { if (state.query) schedule(0); }, dispose() { ++request; clearTimeout(timer); unsubscribe(); unlayout(); window.removeEventListener('pandacode-components-change', lifecycle); mounted = undefined; } };
}
