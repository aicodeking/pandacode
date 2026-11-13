import { createPlacementStore, PLACEMENT_KEY, reducePlacement, type PlacementContainer, type PlacementView, type PlacementAction } from './placement';
import { layoutProject } from './layout-host';
import { extensionsSnapshot } from './manager';
import './placement.css';

export const placements = createPlacementStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
type View = PlacementView & { label: string; node: HTMLElement; anchor: Comment };
type Container = PlacementContainer & { label: string; node: HTMLElement };
let views: View[] = [], containers: Container[] = [];
export const placementViews = () => views;
export const placementContainers = () => containers;
export function dispatchPlacement(action: PlacementAction, project?: string) { placements.dispatch(action, views, containers, project); }
export function canPlace(id: string, container: string) {
  try { reducePlacement(placements.read(layoutProject()), { id, container }, views, containers); return true; } catch { return false; }
}
export function registerPlacementHosts(bindings: { id: string; label: string; node: HTMLElement }[], destinations: Container[], fallback: () => HTMLElement | null) {
  containers = destinations;
  views = bindings.map(binding => {
    const anchor = document.createComment(`placement home: ${binding.id}`); binding.node.before(anchor);
    return { ...binding, anchor, contract: 'host-view-v1', home: 'panda.containers/main' };
  });
  const refresh = () => {
    const state = placements.read(layoutProject()), safe = extensionsSnapshot().safeMode;
    const focused = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    let affected = false;
    for (const view of views) {
      const saved = !safe && state[view.id];
      const target = saved && containers.find(container => container.id === saved.container);
      let valid = false;
      if (target) { try { reducePlacement(state, { id: view.id }, views, containers); valid = !view.node.contains(target.node); } catch { /* Retain dormant/invalid intent, use the built-in anchor. */ } }
      if (focused && view.node.contains(focused)) affected = true;
      if (valid && target && target.id !== view.home) { if (view.node.parentElement !== target.node) target.node.append(view.node); }
      else if (view.anchor.parentNode && view.node.previousSibling !== view.anchor) view.anchor.after(view.node);
      const hidden = Boolean(saved && saved.hidden);
      view.node.toggleAttribute('data-layout-hidden', hidden); view.node.inert = hidden;
    }
    if (affected && focused) {
      if (focused.checkVisibility() && !focused.closest('[inert]')) focused.focus({ preventScroll: true });
      else fallback()?.focus({ preventScroll: true });
    }
    window.dispatchEvent(new Event('resize'));
  };
  const cleanup = placements.subscribe(refresh); refresh();
  return { refresh, setDestinations(next: Container[]) { containers = next; refresh(); }, dispose() { cleanup(); } };
}
window.addEventListener('storage', event => { if (event.key === null || event.key.startsWith(PLACEMENT_KEY)) placements.refresh(); });
