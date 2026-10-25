import './opencode-model-settings.css';
import { call } from './bridge';
import { icon } from './dom';
import { tokenCount } from './model-catalog';
import { t } from './i18n.ts';
import type { ProviderModel } from './types';

interface Catalog {
  models: ProviderModel[];
  selectedModelIds: string[];
  error: string | null;
}

/** Keep the search field and selected rows stable while editing or saving. */
export function mountOpenCodeModels(host: HTMLElement, saved: () => void): () => void {
  let disposed = false, loading = false, saving = false, initialized = false;
  let models: ProviderModel[] = [], selected = new Set<string>(), persisted = new Set<string>();
  let visibleLimit = 80;
  const rows = new Map<string, HTMLLabelElement>();
  let rowId = 0;
  host.classList.add('opencode-model-settings');
  host.innerHTML = `<p class="dialog-description">${t('Choose the OpenCode models you want in your model selectors.')}</p>
    <div class="opencode-model-toolbar"><label class="opencode-model-search">${icon('search')}<input type="search" aria-label="${t('Search OpenCode models')}" placeholder="${t('Search models or providers')}" autocomplete="off" spellcheck="false"></label><button type="button" class="secondary-button" data-refresh aria-label="${t('Refresh models')}" title="${t('Refresh from OpenCode')}">${icon('refresh')}</button></div>
    <p class="opencode-model-status" role="status" hidden></p>
    <div class="opencode-model-list" role="group" aria-label="${t('Available OpenCode models')}"></div>
    <button type="button" class="secondary-button opencode-model-more" hidden>${t('Show more models')}</button>
    <p class="opencode-model-empty" hidden></p>
    <div class="opencode-model-footer"><span class="opencode-model-count"></span><button type="button" class="primary-button" data-save>${t('Save models')}</button></div>
    <small class="opencode-model-note">${t('Default always uses OpenCode’s own selection. Models and connected providers come from your OpenCode installation.')}</small>`;
  const search = host.querySelector<HTMLInputElement>('input')!;
  const list = host.querySelector<HTMLElement>('.opencode-model-list')!;
  const empty = host.querySelector<HTMLElement>('.opencode-model-empty')!;
  const status = host.querySelector<HTMLElement>('.opencode-model-status')!;
  const count = host.querySelector<HTMLElement>('.opencode-model-count')!;
  const refreshButton = host.querySelector<HTMLButtonElement>('[data-refresh]')!;
  const saveButton = host.querySelector<HTMLButtonElement>('[data-save]')!;
  const moreButton = host.querySelector<HTMLButtonElement>('.opencode-model-more')!;
  const dirty = () => selected.size !== persisted.size || [...selected].some(id => !persisted.has(id));
  function message(text: string, error = false): void {
    status.textContent = text; status.hidden = !text; status.classList.toggle('error', error);
  }
  function controls(): void {
    refreshButton.disabled = loading || saving;
    saveButton.disabled = !initialized || saving || !dirty();
    saveButton.textContent = saving ? t('Saving…') : t('Save models');
    count.textContent = selected.size === 100 ? t('100 selected · limit reached') : t`${selected.size} selected`;
    for (const input of list.querySelectorAll<HTMLInputElement>('input')) input.disabled = saving || (selected.size >= 100 && !input.checked);
  }
  function render(): void {
    const query = search.value.trim().toLocaleLowerCase();
    const available = new Map(models.filter(model => model.id !== 'default').map(model => [model.id, model]));
    const items = [...available.values()];
    for (const id of selected) if (!available.has(id)) items.push({id, name: id, description: ''});
    items.sort((a, b) => a.id.split('/')[0].localeCompare(b.id.split('/')[0]) || a.name.localeCompare(b.name));
    const keep = new Set<string>();
    const matching = items.filter(model => `${model.name} ${model.id}`.toLocaleLowerCase().includes(query));
    const shown = Math.min(visibleLimit, matching.length);
    moreButton.hidden = shown === matching.length;
    moreButton.textContent = t`Show more models · ${matching.length - shown} remaining`;
    for (const [index, model] of matching.slice(0, visibleLimit).entries()) {
      keep.add(model.id);
      let row = rows.get(model.id);
      if (!row) {
        row = document.createElement('label'); row.className = 'opencode-model-row';
        row.innerHTML = `<input type="checkbox"><span class="opencode-model-copy"><strong></strong><small></small></span><span class="opencode-model-context"></span>`;
        const checkbox = row.querySelector('input')!;
        checkbox.dataset.modelId = model.id;
        const description = row.querySelector('small')!;
        description.id = `opencode-model-description-${++rowId}`;
        checkbox.setAttribute('aria-describedby', description.id);
        rows.set(model.id, row);
      }
      const checkbox = row.querySelector('input')!;
      checkbox.checked = selected.has(model.id); checkbox.disabled = saving;
      checkbox.setAttribute('aria-label', model.name);
      row.querySelector('strong')!.textContent = model.name;
      row.querySelector('small')!.textContent = available.has(model.id) ? model.id : t`${model.id} · Currently unavailable`;
      row.querySelector('.opencode-model-context')!.textContent = model.contextWindow ? t`${tokenCount(model.contextWindow)} context` : '';
      row.classList.toggle('selected', checkbox.checked);
      if (list.children[index] !== row) list.insertBefore(row, list.children[index] ?? null);
    }
    for (const [id, row] of rows) if (!keep.has(id)) { row.remove(); rows.delete(id); }
    list.hidden = shown === 0;
    empty.hidden = shown > 0;
    empty.textContent = loading ? t('Loading models from OpenCode…') : query ? t('No matching models. Try another name or provider.') : t('No models found. Connect a provider in OpenCode, then refresh.');
    controls();
  }
  async function refresh(): Promise<void> {
    if (disposed || loading || saving) return;
    loading = true; controls();
    message(t('Loading models from OpenCode…'));
    if (!models.length) render();
    try {
      const result = await call<Catalog>('list_opencode_models');
      if (disposed) return;
      if (!initialized) { selected = new Set(result.selectedModelIds); persisted = new Set(result.selectedModelIds); initialized = true; }
      if (!result.error || result.models.length) models = result.models;
      message(result.error || '');
      status.classList.toggle('error', Boolean(result.error));
    } catch (error) { if (!disposed) message(String(error), true); }
    finally { loading = false; if (!disposed) render(); }
  }
  async function save(): Promise<void> {
    if (disposed || saving || !initialized || !dirty()) return;
    saving = true; render();
    try {
      const ids = await call<string[]>('save_opencode_models', {modelIds: [...selected]});
      if (disposed) return;
      persisted = new Set(ids); selected = new Set(ids);
      saved(); message(t('Models saved. Available in every model selector.'));
    } catch (error) { if (!disposed) message(String(error), true); }
    finally { saving = false; if (!disposed) render(); }
  }
  function change(event: Event): void {
    const checkbox = event.target;
    if (!(checkbox instanceof HTMLInputElement) || !checkbox.dataset.modelId || saving) return;
    if (checkbox.checked) selected.add(checkbox.dataset.modelId); else selected.delete(checkbox.dataset.modelId);
    checkbox.closest('label')!.classList.toggle('selected', checkbox.checked);
    message(''); controls();
  }
  function filter(): void { visibleLimit = 80; list.scrollTop = 0; render(); }
  function more(): void { visibleLimit += 80; render(); }
  search.addEventListener('input', filter); list.addEventListener('change', change);
  moreButton.addEventListener('click', more);
  refreshButton.addEventListener('click', refresh); saveButton.addEventListener('click', save);
  // Its own dialog starts in the search; embedded in the Settings page, focus stays on the group list.
  void refresh(); if (host.closest('dialog')) search.focus({preventScroll: true});
  return () => {
    disposed = true; rows.clear(); search.removeEventListener('input', filter); moreButton.removeEventListener('click', more);
    list.removeEventListener('change', change); refreshButton.removeEventListener('click', refresh); saveButton.removeEventListener('click', save);
  };
}
