import { call } from '../bridge';
import { escape, isImeKey } from '../dom';
import { SECTIONS, type ExtensionSettingsPage } from '../settings-sections';
import { extensionsSnapshot } from './manager';
import { settingsDefaults, validSettingsValues, type SettingsPageDefinition } from './settings-state';
import type { DialogValues } from './dialog-state';

export function extensionSettingsPages() {
  const snapshot = extensionsSnapshot();
  return snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled).flatMap(item => (item.manifest.contributes.settings ?? []).map(page => ({ owner: item.manifest.id, page })));
}
export function extensionSettingsSections(): typeof SECTIONS {
  return [...SECTIONS, ...extensionSettingsPages().map(({ owner, page }) => ({ id: page.id as ExtensionSettingsPage, label: page.title, icon: 'info', pages: [{ id: page.id as ExtensionSettingsPage, label: page.title, keywords: owner }] }))];
}
export function mountExtensionSettingsPage(host: HTMLElement, owner: string, page: SettingsPageDefinition): () => void {
  let disposed = false, pending = false;
  const defaults = settingsDefaults(page);
  host.innerHTML = `<p>Extension: ${escape(owner)} · Settings belong only to this extension.</p><form data-extension-settings-form><div data-fields></div><p role="status">Loading settings…</p><button type="submit" class="secondary-button" disabled>Save extension settings</button></form>`;
  const form = host.querySelector<HTMLFormElement>('form')!, fields = host.querySelector<HTMLElement>('[data-fields]')!, status = host.querySelector<HTMLElement>('[role="status"]')!, save = host.querySelector<HTMLButtonElement>('button')!;
  const controls = new Map<string, HTMLInputElement | HTMLSelectElement>();
  const draw = (values: DialogValues) => {
    fields.innerHTML = page.fields.map(field => {
      const label = escape(field.label), id = escape(`extension-setting-${page.id}-${field.id}`), name = escape(field.id), value = values[field.id];
      const control = field.kind === 'switch' ? `<input type="checkbox" id="${id}" name="${name}" ${value ? 'checked' : ''}>` : field.kind === 'text' ? `<input id="${id}" name="${name}" type="text" maxlength="4096" value="${escape(String(value))}" ${field.required ? 'required' : ''} minlength="${field.minLength ?? 0}">` : `<select id="${id}" name="${name}" ${field.required ? 'required' : ''} ${field.multiple ? 'multiple' : ''}><option value="" ${field.required ? 'disabled' : ''}>${escape(field.placeholder ?? 'Choose…')}</option>${field.options.map(option => `<option value="${escape(option.value)}" ${option.disabled ? 'disabled' : ''} ${(Array.isArray(value) ? value : [value]).includes(option.value) ? 'selected' : ''}>${escape(option.label)}</option>`).join('')}</select>`;
      return `<div class="setting-row"><label for="${id}">${label}</label>${control}</div>`;
    }).join('');
    // Valid field names such as "elements" shadow HTMLFormElement named properties.
    // Retain the host-created controls rather than traversing that author-controlled collection.
    for (const control of fields.querySelectorAll<HTMLInputElement | HTMLSelectElement>('input, select')) controls.set(control.name, control);
  };
  void call<DialogValues | null>('extensions_settings_get', { id: owner, page: page.id }).then(values => {
    if (disposed) return;
    draw(values && validSettingsValues(page, values) ? values : defaults); status.textContent = ''; save.disabled = false;
  }).catch(error => { if (!disposed) { status.setAttribute('role', 'alert'); status.textContent = `Settings unavailable: ${String(error)}. Reopen this page to retry.`; } });
  const submit = async (event: SubmitEvent) => {
    event.preventDefault(); if (disposed || pending) return;
    const values = Object.fromEntries(page.fields.map(field => {
      const control = controls.get(field.id)!;
      return [field.id, field.kind === 'switch' ? (control as HTMLInputElement).checked : field.kind === 'select' && field.multiple ? [...(control as HTMLSelectElement).selectedOptions].map(option => option.value) : control.value];
    }));
    if (!validSettingsValues(page, values)) { status.textContent = 'Check the declared field values.'; return; }
    pending = true; save.disabled = true;
    try { await call('extensions_settings_set', { id: owner, page: page.id, values }); if (!disposed) { status.setAttribute('role', 'status'); status.textContent = 'Extension settings saved.'; } }
    catch (error) { if (!disposed) { status.setAttribute('role', 'alert'); status.textContent = `Settings not saved: ${String(error)}`; } }
    finally { pending = false; if (!disposed) save.disabled = false; }
  };
  form.addEventListener('submit', submit);
  const ime = (event: KeyboardEvent) => { if (event.key === 'Enter' && isImeKey(event)) event.preventDefault(); };
  form.addEventListener('keydown', ime);
  return () => { disposed = true; form.removeEventListener('submit', submit); form.removeEventListener('keydown', ime); };
}
