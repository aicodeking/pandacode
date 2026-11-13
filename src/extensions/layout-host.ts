import { createLayoutStore, LAYOUT_KEY } from './layout';
import { extensionsSnapshot } from './manager';
import { proposalOrder, type LayoutProposal } from './ordering';

// Defer access so unavailable storage still permits built-in startup and reports a failed save.
export const layout = createLayoutStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
window.addEventListener('storage', event => { if (event.key === null || event.key.startsWith(LAYOUT_KEY)) layout.refresh(); });
let project: () => string | undefined = () => undefined;
export const layoutProject = () => project();
export function registerLayoutContext(context: () => string | undefined) { project = context; }

export function layoutProposals(): (LayoutProposal & { owner: string; version: string })[] {
  const state = extensionsSnapshot();
  return state.safeMode ? [] : state.packages.filter(item => item.enabled).flatMap(item => (item.manifest.contributes.layouts ?? []).map(proposal => ({ ...proposal, owner: item.manifest.id, version: item.manifest.version }))).sort((a, b) => a.id.localeCompare(b.id));
}
export function orderedControls(location: string, ids: readonly string[], projectId = layoutProject()): string[] {
  if (extensionsSnapshot().safeMode) return [...ids];
  const selected = layout.extensionLayoutsEnabled() && layoutProposals().find(proposal => proposal.id === layout.selected(location) && proposal.location === location);
  let suggested = [...ids];
  if (selected) { try { suggested = proposalOrder(ids, selected.rules); } catch { /* Invalid proposals never displace the last valid user overlay. */ } }
  return layout.order(location, suggested, projectId);
}

/** Reorder only compatible sibling controls, retaining node, listener and service identity. */
export function applyControlOrder(location: string, bindings: ReadonlyArray<readonly [string, HTMLElement | null]>, builtInOnly = false) {
  const groups = new Map<HTMLElement, [string, HTMLElement][]>();
  for (const [id, element] of bindings) if (element?.parentElement) {
    const group = groups.get(element.parentElement) ?? []; group.push([id, element]); groups.set(element.parentElement, group);
  }
  for (const [parent, group] of groups) {
    const nodes = new Map(group), ids = group.map(([id]) => id), desired = (builtInOnly ? ids : orderedControls(location, ids)).map(id => nodes.get(id)!);
    const focused = document.activeElement as HTMLElement | null;
    // Leave every non-control (including dividers and window drag areas) in its original slot.
    const children = [...parent.children], slots = children.map((node, index) => group.some(([, element]) => element === node) ? index : -1).filter(index => index >= 0);
    slots.forEach((index, offset) => { children[index] = desired[offset]; });
    children.forEach((node, index) => { if (parent.children[index] !== node) parent.insertBefore(node, parent.children[index] ?? null); });
    if (focused && group.some(([, element]) => element.contains(focused)) && document.activeElement !== focused) focused.focus({ preventScroll: true });
  }
}

/** Host-owned adapters only; never expose nodes/selectors to contributions. Keep nodes and services alive. */
export function applyControlVisibility(bindings: ReadonlyArray<readonly [string, HTMLElement | null]>, fallback: () => HTMLElement | null) {
  let moveFocus = false;
  for (const [id, element] of bindings) {
    if (!element) continue;
    const hidden = !extensionsSnapshot().safeMode && layout.isHidden(id, layoutProject());
    if (hidden && element.contains(document.activeElement)) moveFocus = true;
    element.toggleAttribute('data-layout-hidden', hidden); element.inert = hidden;
  }
  if (moveFocus) fallback()?.focus({ preventScroll: true });
}
