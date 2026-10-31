/* Add model…: choose which of a long harness catalog's models teams may use, beside its recent ones. */
import './team-model-add.css';
import { escape, icon } from './dom';
import { ADDED_MAX, addedTeamModels, setAddedTeamModels, teamModels } from './team-catalog';
import type { ProviderId, ProviderModel } from './types';

export interface AddTeamModelsOptions {
  provider: ProviderId;
  name: string;
  loadModels(provider: ProviderId): Promise<ProviderModel[]>;
  /** The trigger to focus when the dialog closes (looked up then, since saving may redraw it). */
  trigger(): HTMLElement | null | undefined;
}

/** Opens in the app's `#dialog` (its plate and motion come from `installDialogMotion`); each change saves at once. */
export async function openAddTeamModels({ provider, name, loadModels, trigger }: AddTeamModelsOptions): Promise<void> {
  const dialog = document.querySelector<HTMLDialogElement>('#dialog');
  if (!dialog || dialog.open) return;
  dialog.className = 'team-model-dialog';
  dialog.setAttribute('aria-label', `Models for teams: ${name}`);
  dialog.removeAttribute('aria-describedby');
  dialog.innerHTML = `<div class="dialog-heading"><div class="dialog-title"><h2>${escape(name)} models for teams</h2></div><button type="button" class="icon-button" data-team-close title="Close dialog" aria-label="Close dialog">${icon('close')}</button></div>
    <p class="dialog-description">Teams use your recently used models. Turn on others to add them.</p>
    <label class="team-model-search">${icon('search')}<input type="search" aria-label="Search ${escape(name)} models" placeholder="Search models" autocomplete="off" spellcheck="false" maxlength="200"></label>
    <div class="team-model-list" role="group" aria-label="${escape(name)} models"><p class="team-model-empty">Loading…</p></div>
    <div class="dialog-footer"><span class="team-model-count" role="status"></span><button type="button" class="primary-button" data-team-close>Done</button></div>`;
  const search = dialog.querySelector<HTMLInputElement>('input')!, list = dialog.querySelector<HTMLElement>('.team-model-list')!;
  const count = dialog.querySelector<HTMLElement>('.team-model-count')!;
  let models: ProviderModel[] = [];
  const render = () => {
    const added = new Set(addedTeamModels(provider)), recent = teamModels(provider, models).recent, query = search.value.trim().toLowerCase();
    const full = added.size >= ADDED_MAX;
    const rows = models.filter(m => m.id !== 'default' && `${m.name} ${m.id}`.toLowerCase().includes(query)).map(m => {
      const isRecent = recent.has(m.id), on = isRecent || added.has(m.id);
      return `<label class="team-model-row" title="${escape(m.id)}"><input type="checkbox" data-model="${escape(m.id)}"${on ? ' checked' : ''}${isRecent || (full && !on) ? ' disabled' : ''}>`
        + `<span>${escape(m.name)}</span>${isRecent ? '<small>Recently used, always included</small>' : ''}</label>`;
    });
    list.innerHTML = rows.join('') || `<p class="team-model-empty">${models.length ? 'No matching models.' : 'No models listed.'}</p>`;
    count.textContent = `${added.size} added${full ? ' · limit reached' : ''}`;
  };
  const close = () => dialog.close();
  dialog.querySelectorAll('[data-team-close]').forEach(button => button.addEventListener('click', close));
  search.addEventListener('input', render);
  list.addEventListener('change', event => {
    const box = event.target as HTMLInputElement, model = box.dataset.model!;
    const rest = addedTeamModels(provider).filter(id => id !== model);
    setAddedTeamModels(provider, box.checked ? [...rest, model] : rest);
    render();
    list.querySelector<HTMLElement>(`input[data-model="${CSS.escape(model)}"]`)?.focus();
  });
  dialog.addEventListener('close', () => trigger()?.focus(), { once: true });
  dialog.showModal();
  search.focus();
  models = await loadModels(provider).catch(() => [] as ProviderModel[]);
  if (dialog.open && dialog.classList.contains('team-model-dialog')) render();
}
