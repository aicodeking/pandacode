import { t } from './i18n.ts';
import './conversation-import.css';
import { escape, icon } from './dom';
import { trackSegment } from './motion';
import { providerLogo } from './provider-logos';
import type { ProviderId, Session } from './types';

export type ImportSource = 'claude' | 'codex';
export interface Importable {
  id: string;
  title: string;
  folder: string;
  updatedAt: number;
  messages: number | null;
  model: string | null;
  importedTaskId: string | null;
  unavailable: string | null;
}
export interface ImportPage { items: Importable[]; cursor: string | null; note: string | null; }
export interface ImportResult { imported: Session[]; existing: string[]; failed: { id: string; message: string }[]; }
export interface ImportOptions {
  call<T>(command: string, args?: Record<string, unknown>): Promise<T>;
  /** Harnesses installed here; a source that is not installed stays listed but explains why. */
  installed: ProviderId[];
  defaultModel(provider: ImportSource): string;
  onImported(result: ImportResult): void;
  openTask(id: string): void;
}

const SOURCES: { id: ImportSource; label: string }[] = [{ id: 'claude', label: 'Claude Code' }, { id: 'codex', label: 'Codex' }];
const relative = new Intl.RelativeTimeFormat(undefined, { numeric: 'auto', style: 'short' });
const MAX_SELECTION = 50;

function age(at: number, now = Date.now()): string {
  if (!at) return '';
  const minutes = Math.round((at - now) / 60000);
  if (Math.abs(minutes) < 60) return relative.format(minutes, 'minute');
  if (Math.abs(minutes) < 1440) return relative.format(Math.round(minutes / 60), 'hour');
  if (Math.abs(minutes) < 43200) return relative.format(Math.round(minutes / 1440), 'day');
  return new Date(at).toLocaleDateString([], { month: 'short', day: 'numeric', year: 'numeric' });
}
function folderName(path: string): string { return path.split(/[\\/]/).filter(Boolean).pop() ?? path; }

/** The Import conversations window: pick a source, search, check conversations, import. */
export function mountConversationImport(host: HTMLElement, options: ImportOptions): () => void {
  let source: ImportSource = options.installed.includes('claude') || !options.installed.includes('codex') ? 'claude' : 'codex';
  let items: Importable[] = [], cursor: string | null = null, note: string | null = null;
  let loading = false, importing = false, disposed = false, request = 0, searchTimer = 0;
  const selected = new Set<string>();
  host.classList.add('conversation-import');
  host.innerHTML = `<p class="dialog-description">${t('Bring conversations you started in Claude Code or Codex into PandaCode. Each continues its own session, in the project for its folder.')}</p>
    <div class="import-controls"><div class="import-sources" role="group" aria-label="${t('Import from')}">${SOURCES.map(item => `<button type="button" data-source="${item.id}" aria-pressed="${item.id === source}">${providerLogo(item.id)}<span>${item.label}</span></button>`).join('')}</div>
      <label class="import-search">${icon('search')}<input type="search" placeholder="${t('Search conversations')}" aria-label="${t('Search conversations')}" autocomplete="off"></label></div>
    <div class="import-bar"><label class="import-all"><input type="checkbox" aria-label="${t('Select all shown conversations')}"><span>${t('Select all')}</span></label><span class="import-count" role="status"></span></div>
    <div class="import-list" role="group" aria-label="${t('Conversations')}"></div>
    <p class="import-error" role="alert" hidden></p>
    <div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">${t('Cancel')}</button><button type="button" class="primary-button import-commit" disabled>${t('Import')}</button></div>`;
  const sources = host.querySelector<HTMLElement>('.import-sources')!;
  const search = host.querySelector<HTMLInputElement>('input[type=search]')!;
  const list = host.querySelector<HTMLElement>('.import-list')!;
  const all = host.querySelector<HTMLInputElement>('.import-all input')!;
  const count = host.querySelector<HTMLElement>('.import-count')!;
  const error = host.querySelector<HTMLElement>('.import-error')!;
  const commit = host.querySelector<HTMLButtonElement>('.import-commit')!;

  const selectable = () => items.filter(item => !item.importedTaskId && !item.unavailable);
  function sync(): void {
    const choices = selectable();
    const chosen = choices.filter(item => selected.has(item.id)).length;
    all.checked = chosen > 0 && chosen === choices.length;
    all.indeterminate = chosen > 0 && chosen < choices.length;
    all.disabled = !choices.length || importing;
    commit.disabled = !selected.size || importing;
    commit.textContent = importing ? t('Importing…') : selected.size ? selected.size === 1 ? t`Import ${selected.size} conversation` : t`Import ${selected.size} conversations` : t('Import');
    count.textContent = loading ? t('Loading…') : items.length ? `${cursor ? t`${items.length}+ found` : t`${items.length} found`}${selected.size ? ` · ${t`${selected.size} selected`}` : ''}` : '';
  }
  function row(item: Importable): string {
    const meta = [escape(folderName(item.folder) || t('Unknown folder')), item.messages ? t`${item.messages} messages` : '', age(item.updatedAt)].filter(Boolean).join(' · ');
    const state = item.importedTaskId ? `<button type="button" class="import-open" data-open="${escape(item.importedTaskId)}">${t('In PandaCode')}${icon('forward')}</button>`
      : item.unavailable ? `<span class="import-unavailable" title="${escape(item.unavailable)}">${t('Unavailable')}</span>` : '';
    const disabled = Boolean(item.importedTaskId || item.unavailable);
    return `<label class="import-row ${disabled ? 'disabled' : ''}" data-id="${escape(item.id)}" title="${escape(item.folder)}"><input type="checkbox" value="${escape(item.id)}" ${selected.has(item.id) ? 'checked' : ''} ${disabled || importing ? 'disabled' : ''}>
      <span class="import-copy"><strong>${escape(item.title)}</strong><small>${meta}${item.unavailable ? ` · ${escape(item.unavailable)}` : ''}</small></span>${state}</label>`;
  }
  function render(): void {
    const installed = options.installed.includes(source);
    list.innerHTML = loading && !items.length ? `<p class="import-empty">${t('Reading conversations…')}</p>`
      : items.length ? items.map(row).join('') + (cursor ? `<button type="button" class="secondary-button import-more">${t('Load more')}</button>` : '')
        : `<p class="import-empty">${escape(note ?? (installed ? t('No conversations match.') : t`${SOURCES.find(item => item.id === source)!.label} is not installed on this computer.`))}</p>`;
    sync();
  }
  async function load(more = false): Promise<void> {
    const ticket = ++request;
    loading = true; error.hidden = true;
    if (!more) { items = []; cursor = null; note = null; }
    render();
    try {
      const page = await options.call<ImportPage>('list_importable_conversations', { provider: source, search: search.value.trim() || null, cursor: more ? cursor : null });
      if (disposed || ticket !== request) return;
      const known = new Set(items.map(item => item.id));
      items = [...items, ...page.items.filter(item => !known.has(item.id))];
      cursor = page.cursor; note = page.note;
    } catch (cause) {
      if (disposed || ticket !== request) return;
      error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false;
    } finally {
      if (!disposed && ticket === request) { loading = false; render(); }
    }
  }
  async function importSelected(): Promise<void> {
    if (!selected.size || importing) return;
    importing = true; error.hidden = true; render();
    try {
      const result = await options.call<ImportResult>('import_conversations', { provider: source, ids: [...selected], model: options.defaultModel(source) });
      if (disposed) return;
      const failed = new Set(result.failed.map(item => item.id));
      for (const id of [...selected]) if (!failed.has(id)) selected.delete(id);
      if (result.failed.length) {
        error.textContent = result.failed.length === 1 ? result.failed[0].message : t`${result.failed.length} conversations could not be imported: ${result.failed[0].message}`;
        error.hidden = false;
      }
      options.onImported(result);
    } catch (cause) {
      if (disposed) return;
      error.textContent = cause instanceof Error ? cause.message : String(cause); error.hidden = false;
    } finally {
      if (!disposed) { importing = false; await load(); }
    }
  }

  function change(event: Event): void {
    const input = event.target as HTMLInputElement;
    if (input === all) {
      const choices = selectable();
      if (all.checked) for (const item of choices.slice(0, MAX_SELECTION)) selected.add(item.id); else for (const item of choices) selected.delete(item.id);
      render(); return;
    }
    if (input.type === 'checkbox' && input.value) {
      if (input.checked && selected.size >= MAX_SELECTION) { input.checked = false; error.textContent = t`Import up to ${MAX_SELECTION} conversations at a time.`; error.hidden = false; return; }
      if (input.checked) selected.add(input.value); else selected.delete(input.value);
      sync();
    }
  }
  function click(event: MouseEvent): void {
    const target = event.target instanceof Element ? event.target : null;
    const sourceButton = target?.closest<HTMLButtonElement>('[data-source]');
    if (sourceButton && sourceButton.dataset.source !== source && !importing) {
      source = sourceButton.dataset.source as ImportSource; selected.clear();
      sources.querySelectorAll('[data-source]').forEach(button => button.setAttribute('aria-pressed', String(button === sourceButton)));
      trackSegment(sources, sourceButton); void load(); return;
    }
    const open = target?.closest<HTMLButtonElement>('[data-open]');
    if (open) { event.preventDefault(); options.openTask(open.dataset.open!); return; }
    if (target?.closest('.import-more')) { void load(true); return; }
    if (target?.closest('.import-commit')) void importSelected();
  }
  const typed = () => { window.clearTimeout(searchTimer); searchTimer = window.setTimeout(() => { selected.clear(); void load(); }, 250); };
  host.addEventListener('change', change);
  host.addEventListener('click', click);
  search.addEventListener('input', typed);
  trackSegment(sources, sources.querySelector<HTMLElement>('[aria-pressed="true"]'));
  void load();
  search.focus({ preventScroll: true });
  return () => { disposed = true; window.clearTimeout(searchTimer); host.removeEventListener('change', change); host.removeEventListener('click', click); search.removeEventListener('input', typed); };
}
