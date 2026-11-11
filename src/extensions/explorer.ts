import { escape } from '../dom';
import { ui, invokeCoreCommand } from './catalog-host';
import { extensionsSnapshot, onExtensionsChanged } from './manager';
import { layout, layoutProject, orderedControls, layoutProposals } from './layout-host';

/** Read-only metadata plus explicit host user actions; no mutation authority is granted to packages. */
export function mountSurfaceExplorer(host: HTMLElement): () => void {
  let disposed = false;
  let scope = 'global';
  let owner = '', location = '', cursor: string | undefined, next: string | null = null, error = '';
  let dragging = '';
  const orderingGroups = () => {
    const items = []; let cursor: string | undefined;
    do { const page = ui.listItems({ limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor ?? undefined; } while (cursor);
    const groups = new Map<string, typeof items>();
    for (const item of items) {
      const key = `${item.location}:${item.owner}`, group = groups.get(key) ?? []; group.push(item); groups.set(key, group);
    }
    return [...groups.values()].map(group => {
      group.sort((a, b) => (a.defaultPosition ?? 0) - (b.defaultPosition ?? 0) || a.id.localeCompare(b.id));
      return orderedControls(group[0].location, group.map(item => item.id)).map(id => group.find(item => item.id === id)!);
    });
  };
  const move = (id: string, target: string, side: 'before' | 'after') => {
    try {
      const group = orderingGroups().find(group => group.some(item => item.id === id));
      if (!group || !group.some(item => item.id === target)) throw new Error('Unsupported placement: reorder within the same owner action group only');
      layout.move(group[0].location, group.map(item => item.id), { id, target, side }, scope === 'project' ? layoutProject() : undefined);
      error = '';
    } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
    draw(); host.querySelector<HTMLElement>(`[data-order-id="${id}"]`)?.focus();
  };
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
      <h3>Visibility and recovery</h3><p>Hide changes presentation only, not command access or running work. Settings remains reachable with the Settings keyboard shortcut.</p>
      <label>Layout scope <select aria-label="Layout scope" data-layout-scope><option value="global" ${scope === 'global' ? 'selected' : ''}>Global</option><option value="project" ${scope === 'project' ? 'selected' : ''} ${!layoutProject() ? 'disabled' : ''}>Current project</option></select></label>
      <button type="button" class="secondary-button" data-layout-item="panda.sidebar">${layout.isHidden('panda.sidebar', layoutProject()) ? 'Show' : 'Hide'} sidebar</button>
      <ul aria-label="Item visibility">${page.items.map(item => `<li><button type="button" class="secondary-button" data-layout-item="${escape(item.id)}">${layout.isHidden(item.id, layoutProject()) ? 'Show' : 'Hide'} ${escape(item.label)}</button></li>`).join('')}</ul>
      <button type="button" class="secondary-button" data-layout-reset-project ${!layoutProject() ? 'disabled' : ''}>Reset project layout</button>
      <button type="button" class="secondary-button" data-layout-reset-global>Reset global layout</button>
      <button type="button" class="secondary-button" data-layout-disable ${!layout.extensionLayoutsEnabled() ? 'disabled' : ''}>Disable extension layouts</button>
      <h3>Control order</h3><p>Drag a row or use Alt+Up/Down (or the before/after buttons). Reordering stays within one owner action group. Inspector and general view movement is unsupported until its state contract exists.</p>
      ${orderingGroups().map(group => `<ul aria-label="Order ${escape(group[0].owner)} ${escape(group[0].location)}">${group.map((item, index) => `<li draggable="true" tabindex="0" data-order-id="${escape(item.id)}" aria-label="Reorder ${escape(item.label)}"><strong>${escape(item.label)}</strong> · ${escape(item.owner)} <button type="button" class="secondary-button" data-order-step="before" data-order-item="${escape(item.id)}" ${index === 0 ? 'disabled' : ''}>Move ${escape(item.label)} before</button> <button type="button" class="secondary-button" data-order-step="after" data-order-item="${escape(item.id)}" ${index === group.length - 1 ? 'disabled' : ''}>Move ${escape(item.label)} after</button></li>`).join('')}</ul>`).join('')}
      <h3>Extension layout proposals</h3><p>Grant UI customization and select a proposal explicitly. No proposal applies on activation alone. User order overrides suggestions; disabling a selected extension restores defaults plus user preferences. Competing proposals never use activation order.</p>
      <ul aria-label="Layout proposals">${layoutProposals().map(proposal => {
        const conflicts = layoutProposals().filter(other => other.id !== proposal.id && other.location === proposal.location && other.rules.some(rule => proposal.rules.some(own => [own.id, own.target].includes(rule.id) || [own.id, own.target].includes(rule.target))));
        return `<li><strong>${escape(proposal.title)}</strong> · Owner: ${escape(proposal.owner)} @ ${escape(proposal.version)} · Location: ${escape(proposal.location)}<p>${proposal.rules.map(rule => `${escape(rule.id)} ${rule.side} ${escape(rule.target)}`).join('; ')}</p>${conflicts.length ? `<p>Conflict: ${conflicts.map(other => `${escape(other.owner)} (${escape(other.id)})`).join(', ')}. Select the winner; other proposals remain inactive.</p>` : ''}<button type="button" class="secondary-button" data-layout-select="${escape(proposal.id)}">${layout.extensionLayoutsEnabled() && layout.selected(proposal.location) === proposal.id ? 'Selected' : 'Grant UI customization and select'} ${escape(proposal.title)}</button></li>`;
      }).join('') || '<li>No active proposals</li>'}</ul>
      ${!layout.extensionLayoutsEnabled() ? '<p role="status">Extension layout proposals are disabled. User visibility preferences are retained.</p>' : ''}
      ${layout.diagnostic() ? `<p role="status">${escape(layout.diagnostic())}</p>` : ''}
      ${error ? `<p role="alert">${escape(error)}</p>` : ''}`;
  };
  const change = (event: Event) => {
    const target = event.target as HTMLSelectElement;
    if (target.hasAttribute('data-layout-scope')) { scope = target.value; draw(); host.querySelector<HTMLElement>('[data-layout-scope]')?.focus(); return; }
    if (target.hasAttribute('data-catalog-owner')) owner = target.value;
    else if (target.hasAttribute('data-catalog-location')) location = target.value;
    else return;
    cursor = undefined; error = ''; draw();
    host.querySelector<HTMLSelectElement>(target.hasAttribute('data-catalog-owner') ? '[data-catalog-owner]' : '[data-catalog-location]')?.focus();
  };
  const click = async (event: MouseEvent) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>('button') : null;
    if (!button || button.disabled || !host.contains(button)) return;
    if (button.dataset.orderItem) {
      const id = button.dataset.orderItem, side = button.dataset.orderStep as 'before' | 'after';
      const group = orderingGroups().find(group => group.some(item => item.id === id))!;
      const index = group.findIndex(item => item.id === id), target = group[index + (side === 'before' ? -1 : 1)];
      if (target) move(id, target.id, side); return;
    }
    if (button.dataset.layoutSelect) {
      const proposal = layoutProposals().find(proposal => proposal.id === button.dataset.layoutSelect);
      try { if (proposal) layout.select(proposal.location, proposal.id); } catch (failure) { error = String(failure); }
      draw(); host.querySelector<HTMLElement>(`[data-layout-select="${button.dataset.layoutSelect}"]`)?.focus(); return;
    }
    if (button.dataset.layoutItem || button.hasAttribute('data-layout-reset-project') || button.hasAttribute('data-layout-reset-global') || button.hasAttribute('data-layout-disable')) {
      const id = button.dataset.layoutItem;
      try {
        if (id) layout.setVisible(id, layout.isHidden(id, layoutProject()), scope === 'project' ? layoutProject() : undefined);
        else if (button.hasAttribute('data-layout-reset-project')) layout.resetProject(layoutProject()!);
        else if (button.hasAttribute('data-layout-reset-global')) layout.resetGlobal();
        else layout.disableExtensionLayouts();
      } catch (failure) { error = failure instanceof Error ? failure.message : String(failure); }
      draw();
      const replacement = id ? [...host.querySelectorAll<HTMLElement>('[data-layout-item]')].find(element => element.dataset.layoutItem === id) : host.querySelector<HTMLElement>('[data-layout-scope]');
      replacement?.focus(); return;
    }
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
  const row = (event: Event) => event.target instanceof Element ? event.target.closest<HTMLElement>('[data-order-id]') : null;
  const keydown = (event: KeyboardEvent) => {
    const element = row(event); if (!element || !event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    event.preventDefault(); event.stopPropagation();
    const id = element.dataset.orderId!, group = orderingGroups().find(group => group.some(item => item.id === id))!;
    const side = event.key === 'ArrowUp' ? 'before' : 'after', target = group[group.findIndex(item => item.id === id) + (side === 'before' ? -1 : 1)];
    if (target) move(id, target.id, side);
  };
  const dragstart = (event: DragEvent) => { const element = row(event); if (!element || event.defaultPrevented) return; dragging = element.dataset.orderId!; event.dataTransfer?.setData('text/plain', dragging); };
  const dragover = (event: DragEvent) => {
    const target = row(event)?.dataset.orderId;
    if (target && target !== dragging && orderingGroups().some(group => group.some(item => item.id === dragging) && group.some(item => item.id === target))) event.preventDefault();
  };
  const drop = (event: DragEvent) => { const element = row(event); if (!element || !dragging) return; event.preventDefault(); const box = element.getBoundingClientRect(); move(dragging, element.dataset.orderId!, event.clientY < box.y + box.height / 2 ? 'before' : 'after'); dragging = ''; };
  const dragend = () => { dragging = ''; };
  host.addEventListener('change', change); host.addEventListener('click', click); host.addEventListener('keydown', keydown);
  host.addEventListener('dragstart', dragstart); host.addEventListener('dragover', dragover); host.addEventListener('drop', drop); host.addEventListener('dragend', dragend); draw();
  return () => { disposed = true; cleanup(); host.removeEventListener('change', change); host.removeEventListener('click', click); host.removeEventListener('keydown', keydown); host.removeEventListener('dragstart', dragstart); host.removeEventListener('dragover', dragover); host.removeEventListener('drop', drop); host.removeEventListener('dragend', dragend); };
}
