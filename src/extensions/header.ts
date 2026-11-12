import './extensions.css';
import { icon as hostIcon } from '../dom';
import { openChoiceMenu, type ChoiceItem } from '../choice-menu';
import type { ExtensionMenuItem } from './manager';
import { evaluateCondition, type Json } from './contracts';
import { extensionsSnapshot, onExtensionsChanged, extensionGeneration } from './manager';
import { createDeclarativeActivation } from './activation';
import { layout, layoutProject, applyControlOrder } from './layout-host';

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
  let closeMenu: (() => void) | undefined;
  let conditions: { button: HTMLButtonElement; visible?: Json; enabled?: Json; hasItems: boolean }[] = [];
  const fallbackFocus = () => [...document.querySelectorAll<HTMLElement>('button:not([disabled]), #prompt:not([disabled])')].find(element => !element.inert && element.checkVisibility())?.focus({ preventScroll: true });
  const refreshConditions = () => {
    const captured = { ...context(), schemaVersion: 1, windowId: 'main', surfaceId: location };
    const allows = (condition: Json | undefined) => {
      if (condition === undefined) return true;
      const result = evaluateCondition(condition, captured);
      return result.ok && result.value === true;
    };
    for (const { button, visible, enabled, hasItems } of conditions) {
      button.hidden = !allows(visible) || layout.isHidden(button.dataset.extensionContribution!, layoutProject()) || hasItems && allows(enabled) && !registration?.itemsFor(button.dataset.extensionContribution!, captured).length; button.disabled = !allows(enabled);
      if ((button.hidden || button.disabled) && button.getAttribute('aria-expanded') === 'true') closeMenu?.();
      if (document.activeElement === button && (button.hidden || button.disabled)) fallbackFocus();
    }
    slot.hidden = !conditions.some(({ button }) => !button.hidden);
    applyControlOrder(location, conditions.map(({ button }) => [button.dataset.extensionContribution!, button] as const));
  };
  const draw = () => {
    closeMenu?.();
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
        if (menu.items) button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('pointerdown', event => { if (menu.items && closeMenu) event.preventDefault(); });
        button.addEventListener('click', () => {
          if (activation !== extensionGeneration() || !button.isConnected) return;
          const captured = structuredClone({ ...context(), schemaVersion: 1, windowId: 'main', surfaceId: menu.location });
          if (menu.items) {
            if (closeMenu) { const wasOpen = button.getAttribute('aria-expanded') === 'true'; closeMenu(); if (wasOpen) return; }
            const choices = (items: ExtensionMenuItem[]): ChoiceItem[] => {
              let separator = false;
              return items.flatMap(item => {
                if (item.kind === 'separator') { separator = true; return []; }
                const enabled = item.enabled === undefined ? undefined : evaluateCondition(item.enabled, captured);
                const parsed = item.icon && entry.icons[item.icon] ? new DOMParser().parseFromString(entry.icons[item.icon], 'image/svg+xml') : undefined;
                const svg = parsed?.documentElement;
                const validIcon = svg?.localName === 'svg' && !parsed?.querySelector('parsererror');
                if (validIcon) { svg.setAttribute('class', 'icon'); svg.setAttribute('aria-hidden', 'true'); }
                const choice: ChoiceItem = { id: item.id, label: item.title!, separator, disabled: enabled !== undefined && (!enabled.ok || enabled.value !== true), selected: item.checked, kind: item.kind === 'checkbox' || item.kind === 'radio' ? item.kind : undefined, leading: validIcon ? svg.outerHTML : hostIcon('help').replace('<svg ', '<svg data-extension-icon-fallback="true" '), children: item.items ? choices(item.items) : undefined };
                separator = false;
                return [choice];
              });
            };
            const items = choices(owned.itemsFor(menu.id, captured));
            closeMenu = openChoiceMenu({ anchor: button, title: command.title, items, itemLimit: 128, actions: true, onSelect: id => {
              if (activation !== extensionGeneration() || !button.isConnected) return;
              const message = owned.invoke(id, captured);
              if (message !== undefined) showMessage(message);
            }, onClose: () => { closeMenu = undefined; } });
            return;
          }
          const message = owned.invoke(menu.id, captured);
          if (message !== undefined) showMessage(message);
        });
        slot.append(button);
        conditions.push({ button, visible: menu.visible, enabled: menu.enabled, hasItems: Boolean(menu.items) });
    }
    refreshConditions();
    if (focused) fallbackFocus();
  };
  const cleanup = onExtensionsChanged(draw), cleanupContext = onContextChanged?.(refreshConditions), cleanupLayout = layout.subscribe(() => { closeMenu?.(); refreshConditions(); }); draw();
  return () => { closeMenu?.(); const focused = slot.contains(document.activeElement); cleanup(); cleanupContext?.(); cleanupLayout(); registration?.dispose(); conditions = []; slot.remove(); if (focused) fallbackFocus(); };
}
