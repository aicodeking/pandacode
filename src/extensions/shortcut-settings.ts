import { escape } from '../dom';
import { activeKeybindings } from './commands';
import { bindingGroups, BINDING_CHOICES_KEY, readBindingChoices } from './shortcuts';

export function mountShortcutSettings(host: HTMLElement): () => void {
  let choices = {}; try { choices = readBindingChoices(localStorage.getItem(BINDING_CHOICES_KEY)); } catch { /* Conflict-safe default. */ }
  const groups = bindingGroups(activeKeybindings(), choices);
  host.innerHTML = `<h3>Extension shortcuts</h3><p>Input fields, IME, terminals and open menus/dialogs keep their keys. Conflicts never use load order. Core shortcuts cannot be replaced.</p>${groups.map(group => `<div class="setting-row"><div><strong>${escape(group.key)}</strong><small>${group.reserved ? 'Conflict: reserved core shortcut; use the command palette instead.' : group.candidates.length > 1 ? 'Conflict: select an explicit owner, or leave all unassigned.' : 'Assigned to the only enabled contribution.'}</small></div>${group.reserved || group.candidates.length < 2 ? `<span>${escape(group.reserved ? 'Core' : group.winner!.id)}</span>` : `<select aria-label="Resolve ${escape(group.key)}" data-key="${escape(group.key)}"><option value="">Unassigned</option>${group.candidates.map(binding => `<option value="${escape(binding.id)}" ${binding.id === group.winner?.id ? 'selected' : ''}>${escape(binding.id)}</option>`).join('')}</select>`}</div>`).join('')}<p role="status" data-binding-status></p>`;
  const change = (event: Event) => {
    const target = event.target;
    if (!(target instanceof HTMLSelectElement) || !target.dataset.key || !host.contains(target)) return;
    const updated = { ...choices, [target.dataset.key]: target.value };
    try { localStorage.setItem(BINDING_CHOICES_KEY, JSON.stringify(updated)); choices = updated; host.querySelector('[data-binding-status]')!.textContent = 'Shortcut choice saved.'; }
    catch { host.querySelector('[data-binding-status]')!.textContent = 'Shortcut choice was not saved; conflicts remain unassigned.'; }
  };
  host.addEventListener('change', change); return () => host.removeEventListener('change', change);
}
