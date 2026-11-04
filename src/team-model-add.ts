/* Add model…: choose which of a long harness catalog's models teams may use, beside its recent ones. */
import './team-model-add.css';
import { escape, icon } from './dom';
import { ADDED_MAX, addedTeamModels, dupModelNames, excludedTeamModels, recentTeamModelIds, setAddedTeamModels, setExcludedTeamModels } from './team-catalog';
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
    <p class="dialog-description">Teams use your recently used models. Turn one off to drop it, or turn on others to add them.</p>
    <label class="team-model-search">${icon('search')}<input type="search" aria-label="Search ${escape(name)} models" placeholder="Search models" autocomplete="off" spellcheck="false" maxlength="200"></label>
    <div class="team-model-list" role="group" aria-label="${escape(name)} models"><p class="team-model-empty">Loading…</p></div>
    <div class="dialog-footer"><span class="team-model-count" role="status"></span><button type="button" class="primary-button" data-team-close>Done</button></div>`;
  const search = dialog.querySelector<HTMLInputElement>('input')!, list = dialog.querySelector<HTMLElement>('.team-model-list')!;
  const count = dialog.querySelector<HTMLElement>('.team-model-count')!;
  let models: ProviderModel[] = [];
  // Recency before exclusions: a dropped recent model still wears its badge and can come back.
  const autoRecent = () => new Set(recentTeamModelIds(provider));
  const render = () => {
    const added = new Set(addedTeamModels(provider)), excluded = new Set(excludedTeamModels(provider)), auto = autoRecent();
    const query = search.value.trim().toLowerCase();
    const full = added.size >= ADDED_MAX, dupes = dupModelNames(models);
    const rows = models.filter(m => m.id !== 'default' && `${m.name} ${m.id}`.toLowerCase().includes(query)).map(m => {
      // Two models can share a display name (endpoints of different providers): a duplicate's row shows its id.
      const label = escape(m.name) + (dupes.has(m.name) ? ` · ${escape(m.id)}` : ''), isRecent = auto.has(m.id), on = (isRecent || added.has(m.id)) && !excluded.has(m.id);
      return `<label class="team-model-row" title="${escape(m.id)}"><input type="checkbox" data-model="${escape(m.id)}" aria-label="${label}"${on ? ' checked' : ''}${full && !on && !isRecent ? ' disabled' : ''}>`
        + `<span>${escape(m.name)}</span>${dupes.has(m.name) ? `<small class="team-model-id">${escape(m.id)}</small>` : ''}${isRecent ? '<small>Recently used</small>' : ''}</label>`;
    });
    list.innerHTML = rows.join('') || `<p class="team-model-empty">${models.length ? 'No matching models.' : 'No models listed.'}</p>`;
    count.textContent = `${added.size} added${full ? ' · limit reached' : ''}`;
  };
  const close = () => dialog.close();
  dialog.querySelectorAll('[data-team-close]').forEach(button => button.addEventListener('click', close));
  search.addEventListener('input', render);
  list.addEventListener('change', event => {
    const box = event.target as HTMLInputElement, model = box.dataset.model!;
    const recent = autoRecent().has(model);
    const rest = addedTeamModels(provider).filter(id => id !== model), left = excludedTeamModels(provider).filter(id => id !== model);
    // An off recent model is excluded, not merely un-added: it stays out until it is turned on again.
    if (box.checked) setExcludedTeamModels(provider, left);
    else if (recent) setExcludedTeamModels(provider, [...left, model]);
    else { setAddedTeamModels(provider, rest); return; }
    setAddedTeamModels(provider, recent ? rest : [...rest, model]);
    render();
    list.querySelector<HTMLElement>(`input[data-model="${CSS.escape(model)}"]`)?.focus();
  });
  dialog.addEventListener('close', () => trigger()?.focus(), { once: true });
  dialog.showModal();
  search.focus();
  models = await loadModels(provider).catch(() => [] as ProviderModel[]);
  if (dialog.open && dialog.classList.contains('team-model-dialog')) render();
}
