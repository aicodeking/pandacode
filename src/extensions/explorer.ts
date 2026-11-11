import { escape } from '../dom';
import { ui, invokeCoreCommand } from './catalog-host';
import { extensionsSnapshot, onExtensionsChanged } from './manager';

/** Host-rendered read-only discovery; invocation is an explicit host gesture, not a package grant. */
export function mountSurfaceExplorer(host: HTMLElement): () => void {
  let disposed = false;
  let owner = '', location = '', cursor: string | undefined, next: string | null = null, error = '';
  const draw = () => {
    if (disposed) return;
    const surfaces = ui.listSurfaces().items;
    const page = ui.listItems({ ...(owner ? { owner } : {}), ...(location ? { location } : {}), ...(cursor ? { cursor } : {}), limit: 5 });
    next = page.nextCursor;
    // Package ownership is bounded by the validated snapshot, not just the first item page.
    const state = extensionsSnapshot();
    const owners = ['panda.core', ...state.packages.filter(item => item.enabled && !state.safeMode).map(item => item.manifest.id)].sort();
    host.innerHTML = `<h3>Surface explorer</h3><p>Read-only metadata. Inspecting an item grants no command permission. Only explicitly public core UI commands can be run here.</p>
      <ul aria-label="Public surfaces">${surfaces.map(surface => `<li><strong>${escape(surface.label)}</strong> <code>${escape(surface.id)}</code> · ${escape(surface.owner)} · ${escape(surface.type)} · ${escape(surface.supportedOperations.join(', '))} · Main window only</li>`).join('')}</ul>
      <label>Item owner <select aria-label="Item owner" data-catalog-owner><option value="">All owners</option>${owners.map(value => `<option ${owner === value ? 'selected' : ''} value="${escape(value)}">${escape(value)}</option>`).join('')}</select></label>
      <label>Item location <select aria-label="Item location" data-catalog-location><option value="">All locations</option>${surfaces.map(surface => `<option ${location === surface.id ? 'selected' : ''} value="${escape(surface.id)}">${escape(surface.label)}</option>`).join('')}</select></label>
      <ul aria-label="Surface items">${page.items.map(item => `<li data-catalog-item="${escape(item.id)}"><strong>${escape(item.label)}</strong> <code>${escape(item.id)}</code><p>Owner: ${escape(item.owner)} · Type: ${escape(item.type)} · Location: ${escape(item.location)} · Operations: ${escape(item.supportedOperations.join(', '))}</p>${item.command ? `<button type="button" class="secondary-button" data-catalog-command="${escape(item.command.id)}">Run ${escape(item.label)}</button>` : ''}</li>`).join('') || '<li>No matching items</li>'}</ul>
      <button type="button" class="secondary-button" data-catalog-start ${!cursor ? 'disabled' : ''}>First items</button> <button type="button" class="secondary-button" data-catalog-next ${!next ? 'disabled' : ''}>Next items</button>
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}`;
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.hasAttribute('data-catalog-owner')) owner = target.value;
    else if (target.hasAttribute('data-catalog-location')) location = target.value;
    else return;
    cursor = undefined; error = ''; draw();
    host.querySelector<HTMLSelectElement>(target.hasAttribute('data-catalog-owner') ? '[data-catalog-owner]' : '[data-catalog-location]')?.focus();
  };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled || !host.contains(button)) return;
    if (button.hasAttribute('data-catalog-next')) { cursor = next ?? undefined; draw(); host.querySelector<HTMLElement>('[data-catalog-start]')?.focus(); }
    else if (button.hasAttribute('data-catalog-start')) { cursor = undefined; draw(); host.querySelector<HTMLElement>('[data-catalog-next]')?.focus(); }
    else if (button.dataset.catalogCommand) {
      button.disabled = true;
      try { await invokeCoreCommand(button.dataset.catalogCommand); }
      catch (failure) { error = failure instanceof Error ? failure.message : String(failure); draw(); }
      finally { if (button.isConnected) button.disabled = false; }
    }
  };
  const cleanup = onExtensionsChanged(() => { cursor = undefined; draw(); });
  host.addEventListener('change', change); host.addEventListener('click', click); draw();
  return () => { disposed = true; cleanup(); host.removeEventListener('change', change); host.removeEventListener('click', click); };
}
