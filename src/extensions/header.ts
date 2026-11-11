import './extensions.css';
import { icon as hostIcon } from '../dom';
import { evaluateCondition, type Json } from './contracts';
import { extensionsSnapshot, onExtensionsChanged, extensionGeneration } from './manager';
import { createDeclarativeActivation } from './activation';
import { layout, layoutProject } from './layout-host';

/** Append only owned nodes; never remount or delegate legacy controls. Native buttons supply
 * pointer/Enter/Space activation, avoiding duplicate synthetic keyboard click dispatch. */
export function mountExtensionHeader(host: HTMLElement, context: () => Record<string, Json>, showMessage: (message: string) => void, onContextChanged?: (listener: () => void) => () => void): () => void {
  return mountExtensionActions(host, 'panda.workspace.header.actions', context, showMessage, onContextChanged);
}

/** Both public surfaces share validation, invocation and owner-scoped disposal. */
export function mountExtensionActions(host: HTMLElement, location: 'panda.workspace.header.actions' | 'panda.sidebar.footer', context: () => Record<string, Json>, showMessage: (message: string) => void, onContextChanged?: (listener: () => void) => () => void): () => void {
  const slot = document.createElement('div');
  slot.className = 'extension-header-actions'; slot.dataset.tauriDragRegion = 'false';
  slot.setAttribute('role', 'group'); slot.setAttribute('aria-label', 'Extension actions');
  if (location === 'panda.sidebar.footer') { slot.classList.add('extension-sidebar-actions'); host.before(slot); }
  else host.append(slot);
  let registration: ReturnType<typeof createDeclarativeActivation> | undefined;
  let conditions: { button: HTMLButtonElement; visible?: Json; enabled?: Json }[] = [];
  const fallbackFocus = () => [...document.querySelectorAll<HTMLElement>('button:not([disabled]), #prompt:not([disabled])')].find(element => !element.inert && element.checkVisibility())?.focus({ preventScroll: true });
  const refreshConditions = () => {
    const captured = { ...context(), schemaVersion: 1, windowId: 'main', surfaceId: location };
    const allows = (condition: Json | undefined) => {
      if (condition === undefined) return true;
      const result = evaluateCondition(condition, captured);
      return result.ok && result.value === true;
    };
    for (const { button, visible, enabled } of conditions) {
      button.hidden = !allows(visible) || layout.isHidden(button.dataset.extensionContribution!, layoutProject()); button.disabled = !allows(enabled);
      if (document.activeElement === button && (button.hidden || button.disabled)) fallbackFocus();
    }
    slot.hidden = !conditions.some(({ button }) => !button.hidden);
  };
  const draw = () => {
    const focused = slot.contains(document.activeElement);
    registration?.dispose();
    slot.replaceChildren();
    conditions = [];
    const current = extensionsSnapshot(), activation = extensionGeneration();
    registration = createDeclarativeActivation(current, activation);
    const owned = registration;
    for (const entry of owned.entries) {
        const { menu, command, svg } = entry;
        if (menu.location !== location) continue;
        if (!command || command.action.kind !== 'showMessage') continue;
        const button = document.createElement('button'); button.type = 'button'; button.className = 'icon-button';
        button.dataset.extensionContribution = menu.id; button.dataset.tauriDragRegion = 'false';
        button.setAttribute('aria-label', command.title); button.title = command.title;
        if (svg) {
          // Native policy returns a restricted static SVG, never arbitrary package HTML.
          const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
          const icon = parsed.documentElement;
          if (icon.localName === 'svg' && !parsed.querySelector('parsererror')) {
            icon.setAttribute('class', 'icon'); icon.setAttribute('aria-hidden', 'true'); button.append(document.importNode(icon, true));
          }
        }
        if (!button.childNodes.length) { button.innerHTML = hostIcon('help'); button.dataset.extensionIconFallback = 'true'; }
        button.addEventListener('click', () => {
          if (activation !== extensionGeneration() || !button.isConnected) return;
          const captured = structuredClone({ ...context(), schemaVersion: 1, windowId: 'main', surfaceId: menu.location });
          const message = owned.invoke(menu.id, captured);
          if (message !== undefined) showMessage(message);
        });
        slot.append(button);
        conditions.push({ button, visible: menu.visible, enabled: menu.enabled });
    }
    refreshConditions();
    if (focused) fallbackFocus();
  };
  const cleanup = onExtensionsChanged(draw), cleanupContext = onContextChanged?.(refreshConditions), cleanupLayout = layout.subscribe(refreshConditions); draw();
  return () => { cleanup(); cleanupContext?.(); cleanupLayout(); registration?.dispose(); conditions = []; slot.remove(); };
}
