import { escape, isImeKey } from '../dom';
import { openChoiceMenu, type ChoiceItem } from '../choice-menu';
import { createDialogState, type DialogCallbacks, type DialogContext, type DialogDefinition, type DialogResult } from './dialog-state';

/** Host-only transport seam. Executable extensions remain disabled; no function is read from JSON. */
let callbacks: DialogCallbacks | undefined;
export function setDialogCallbacks(value: DialogCallbacks): void { callbacks = value; }

/** Uses the existing transparent modal/plate/motion. Never replace another owner's open dialog. */
export function openExtensionDialog(definition: DialogDefinition, context: DialogContext, owner: string, trigger: HTMLElement, openSelect = false): { result: Promise<DialogResult>; close: () => void } {
  const element = document.querySelector<HTMLDialogElement>('#dialog');
  if (!element || element.open) return { result: Promise.resolve({ kind: 'cancelled', reason: 'busy' }), close() {} };
  const dialog = element;
  const state = createDialogState(definition, context, callbacks);
  const spec = state.definition, token = crypto.randomUUID(), triggerId = trigger.dataset.extensionContribution;
  let resolve!: (result: DialogResult) => void;
  const result = new Promise<DialogResult>(done => { resolve = done; });
  let ended = false, pending = false, confirming = false, closePick: (() => void) | undefined;
  const controls = new Map<string, HTMLInputElement | HTMLButtonElement>();
  dialog.className = 'extension-dialog'; dialog.dataset.extensionDialog = token;
  dialog.setAttribute('aria-label', `${spec.title} — ${owner}`); dialog.removeAttribute('aria-describedby');
  dialog.innerHTML = `<form novalidate><div class="dialog-heading"><h2>${escape(spec.title)}</h2></div><p class="dialog-description">Extension: ${escape(owner)}</p><div class="extension-dialog-fields"></div><p class="extension-dialog-confirm" hidden></p><p class="extension-dialog-error" role="alert" hidden></p><p class="extension-dialog-status" role="status"></p><div class="dialog-footer"><button type="button" class="secondary-button" data-extension-cancel>Cancel</button><button type="submit" class="primary-button">${escape(spec.confirmLabel ?? 'Confirm')}</button></div></form>`;
  const form = dialog.querySelector('form')!, fields = dialog.querySelector<HTMLElement>('.extension-dialog-fields')!;
  const error = dialog.querySelector<HTMLElement>('.extension-dialog-error')!, status = dialog.querySelector<HTMLElement>('.extension-dialog-status')!;
  const confirmation = dialog.querySelector<HTMLElement>('.extension-dialog-confirm')!, submit = dialog.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const owned = () => dialog.dataset.extensionDialog === token && dialog.contains(form);
  const focusTrigger = () => {
    const replacement = trigger.isConnected ? trigger : triggerId ? [...document.querySelectorAll<HTMLElement>('[data-extension-contribution]')].find(node => node.dataset.extensionContribution === triggerId && node.closest<HTMLElement>('[data-extension-session]')?.dataset.extensionSession === context.sessionId) : undefined;
    const eligible = (node: HTMLElement) => !node.closest('[inert]') && node.checkVisibility() && !(node as HTMLButtonElement).disabled;
    const prompt = document.querySelector<HTMLElement>('#prompt:not([disabled])');
    (replacement && eligible(replacement) ? replacement : prompt && eligible(prompt) ? prompt : [...document.querySelectorAll<HTMLElement>('button:not([disabled])')].find(eligible))?.focus({ preventScroll: true });
  };
  function finish(value: DialogResult): void {
    if (ended) return;
    ended = true; closePick?.(); state.dispose(); observer.disconnect();
    if (owned()) { delete dialog.dataset.extensionDialog; if (dialog.open) dialog.close(); focusTrigger(); }
    resolve(value);
  }
  const observer = new MutationObserver(() => { if (!owned() || !form.isConnected || !dialog.open) finish({ kind: 'cancelled', reason: 'unload' }); });
  observer.observe(dialog, { childList: true, attributes: true, attributeFilter: ['open', 'data-extension-dialog'] });
  const renderValue = (id: string) => {
    const field = spec.fields.find(field => field.id === id)!, control = controls.get(id)!;
    if (field.kind !== 'select') return;
    const value = state.values()[id], selected = Array.isArray(value) ? value : [value];
    control.textContent = state.optionsFor(id).filter(option => selected.includes(option.value)).map(option => option.label).join(', ') || field.placeholder || 'Choose…';
  };
  function clearConfirmation(): void { confirming = false; confirmation.hidden = true; submit.textContent = spec.confirmLabel ?? 'Confirm'; }
  for (const field of spec.fields) {
    const row = document.createElement('div'); row.className = 'extension-dialog-field';
    const id = `${token}-${field.id}`;
    row.innerHTML = `<label for="${id}">${escape(field.label)}</label>${field.kind === 'select' ? `<button type="button" class="secondary-button" id="${id}" aria-haspopup="dialog"></button>` : `<input id="${id}" ${field.kind === 'switch' ? 'type="checkbox" role="switch" class="ds-toggle"' : 'type="text" maxlength="4096" autocomplete="off"'}>`}<p id="${id}-error" class="extension-field-error" hidden></p>`;
    const control = row.querySelector<HTMLInputElement | HTMLButtonElement>('input, button')!;
    control.setAttribute('aria-describedby', `${id}-error`); if ('required' in field && field.required) control.setAttribute('aria-required', 'true');
    controls.set(field.id, control); fields.append(row);
    if (field.kind === 'select') {
      renderValue(field.id);
      control.addEventListener('click', () => {
        if (pending || ended) return;
        closePick?.();
        const choices = (options: typeof field.options): ChoiceItem[] => {
          const value = state.values()[field.id], selected = Array.isArray(value) ? value : [value];
          return options.map(option => ({ id: option.value, label: option.label, disabled: option.disabled, selected: selected.includes(option.value), kind: field.multiple ? 'checkbox' : 'radio' }));
        };
        closePick = openChoiceMenu({ anchor: control, title: field.label, searchPlaceholder: `Search ${field.label}`, items: field.async ? [] : choices(field.options), multiple: field.multiple,
          loadItems: field.async ? async (query, signal) => {
            const abort = () => state.cancelOptions(field.id); signal.addEventListener('abort', abort, { once: true });
            try { return choices(await state.options(field.id, query) ?? []); }
            finally { signal.removeEventListener('abort', abort); }
          } : undefined,
          onSelect: value => {
            if (ended || pending) return;
            const previous = state.values()[field.id];
            state.set(field.id, field.multiple && Array.isArray(previous) ? previous.includes(value) ? previous.filter(item => item !== value) : [...previous, value] : value);
            clearConfirmation(); renderValue(field.id);
          }, onClose: () => { state.cancelOptions(field.id); closePick = undefined; },
        });
      }, { signal: state.signal });
    } else {
      const input = control as HTMLInputElement;
      if (field.kind === 'switch') input.checked = Boolean(state.values()[field.id]); else input.value = String(state.values()[field.id]);
      input.addEventListener('input', () => { if (!ended && !pending) { state.set(field.id, field.kind === 'switch' ? input.checked : input.value); clearConfirmation(); } }, { signal: state.signal });
    }
  }
  form.addEventListener('submit', event => {
    event.preventDefault();
    if (pending || ended) return;
    if (confirming) { finish({ kind: 'confirmed', values: state.values() }); return; }
    pending = true; error.hidden = true; status.textContent = 'Validating…';
    controls.forEach(control => { control.disabled = true; }); submit.disabled = true;
    void state.validate().then(errors => {
      if (ended || !errors) return;
      let first: HTMLElement | undefined;
      for (const [id, control] of controls) {
        const message = Object.hasOwn(errors, id) ? errors[id] : undefined, help = document.getElementById(`${control.id}-error`)!;
        help.textContent = message ?? ''; help.hidden = !message; control.setAttribute('aria-invalid', String(Boolean(message)));
        if (message) first ??= control;
      }
      if (first) { error.textContent = 'Check the highlighted fields.'; error.hidden = false; }
      else if (spec.confirmation) { confirming = true; confirmation.textContent = spec.confirmation; confirmation.hidden = false; submit.textContent = 'Confirm'; }
      else { finish({ kind: 'confirmed', values: state.values() }); return; }
      controls.forEach(control => { control.disabled = false; }); submit.disabled = false; first?.focus();
    }).catch(() => { if (!ended) { error.textContent = 'Validation failed. Try again.'; error.hidden = false; } }).finally(() => {
      if (ended) return;
      pending = false; status.textContent = ''; controls.forEach(control => { control.disabled = false; }); submit.disabled = false;
    });
  }, { signal: state.signal });
  form.querySelector('[data-extension-cancel]')!.addEventListener('click', () => finish({ kind: 'cancelled', reason: 'cancel' }), { signal: state.signal });
  dialog.addEventListener('keydown', event => {
    if (isImeKey(event) && (event.key === 'Enter' || event.key === 'Escape')) { event.preventDefault(); event.stopPropagation(); }
  }, { capture: true, signal: state.signal });
  dialog.addEventListener('cancel', event => { event.preventDefault(); finish({ kind: 'cancelled', reason: 'cancel' }); }, { signal: state.signal });
  dialog.addEventListener('close', () => { if (!dialog.open) finish({ kind: 'cancelled', reason: 'cancel' }); }, { signal: state.signal });
  dialog.showModal(); (controls.values().next().value ?? submit).focus();
  if (openSelect) {
    const field = spec.fields.find(field => field.kind === 'select');
    if (field) controls.get(field.id)?.click();
  }
  return { result, close: () => finish({ kind: 'cancelled', reason: 'unload' }) };
}
