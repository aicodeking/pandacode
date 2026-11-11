import { createLayoutStore, LAYOUT_KEY } from './layout';

// Defer access so unavailable storage still permits built-in startup and reports a failed save.
export const layout = createLayoutStore({ getItem: key => localStorage.getItem(key), setItem: (key, value) => localStorage.setItem(key, value) });
window.addEventListener('storage', event => { if (event.key === null || event.key.startsWith(LAYOUT_KEY)) layout.refresh(); });
let project: () => string | undefined = () => undefined;
export const layoutProject = () => project();
export function registerLayoutContext(context: () => string | undefined) { project = context; }

/** Host-owned adapters only; never expose nodes/selectors to contributions. Keep nodes and services alive. */
export function applyControlVisibility(bindings: ReadonlyArray<readonly [string, HTMLElement | null]>, fallback: () => HTMLElement | null) {
  let moveFocus = false;
  for (const [id, element] of bindings) {
    if (!element) continue;
    const hidden = layout.isHidden(id, layoutProject());
    if (hidden && element.contains(document.activeElement)) moveFocus = true;
    element.toggleAttribute('data-layout-hidden', hidden); element.inert = hidden;
  }
  if (moveFocus) fallback()?.focus({ preventScroll: true });
}
