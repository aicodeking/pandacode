import './extensions.css';
import { icon as hostIcon } from '../dom';
import { openChoiceMenu } from '../choice-menu';
import { extensionChoices } from './menu-choices';
import type { ActionLocation } from './surfaces';
import { evaluateCondition, type Json } from './contracts';
import { extensionsSnapshot, onExtensionsChanged, extensionGeneration } from './manager';
import { createDeclarativeActivation } from './activation';
import { layout, layoutProject, applyControlOrder } from './layout-host';
import { openExtensionDialog } from './dialogs';
import { openProjectContext } from './context-inspector';
import { openExecutableCommand } from './executable';
import type { ExtensionAction } from './manager';
type WindowBinding = { windowId: string; invoke(id: string, version: string): Promise<ExtensionAction | undefined> };

/** Append only owned nodes; never remount or delegate legacy controls. Native buttons supply
 * pointer/Enter/Space activation, avoiding duplicate synthetic keyboard click dispatch. */
export function mountExtensionHeader(host: HTMLElement, context: () => Record<string, Json>, showMessage: (message: string) => void, onContextChanged?: (listener: () => void) => () => void): () => void {
  return mountExtensionActions(host, 'panda.workspace.header.actions', context, showMessage, onContextChanged);
}

/** Public action surfaces share validation, invocation and owner-scoped disposal. */
export function mountExtensionActions(host: HTMLElement, location: ActionLocation, context: () => Record<string, Json>, showMessage: (message: string) => void, onContextChanged?: (listener: () => void) => () => void, active: () => boolean = () => true, coreControls: ReadonlyArray<readonly [string, HTMLElement]> = [], binding?: WindowBinding): () => void {
  const slot = document.createElement('div');
  slot.className = 'extension-header-actions'; slot.dataset.tauriDragRegion = 'false'; slot.dataset.extensionLocation = location;
  slot.setAttribute('role', 'group'); slot.setAttribute('aria-label', coreControls.length ? `${location.split('.')[2]} actions` : 'Extension actions');
  if (location === 'panda.sidebar.footer') { slot.classList.add('extension-sidebar-actions'); host.before(slot); }
  else host.append(slot);
  let registration: ReturnType<typeof createDeclarativeActivation> | undefined;
  let closeMenu: (() => void) | undefined;
  let closeDialog: (() => void) | undefined;
  let closeContext: (() => void) | undefined;
  let conditions: { button: HTMLElement; visible?: Json; enabled?: Json; hasItems: boolean }[] = [];
  const fallbackFocus = () => {
    const eligible = (element: HTMLElement) => !element.closest('[inert]') && element.checkVisibility();
    const dialog = document.querySelector<HTMLDialogElement>('dialog[open]');
    if (dialog) { [...dialog.querySelectorAll<HTMLElement>('button:not([disabled]), input:not([disabled])')].find(eligible)?.focus({ preventScroll: true }); return; }
    const prompt = document.querySelector<HTMLElement>('#prompt:not([disabled])');
    (prompt && eligible(prompt) ? prompt : [...document.querySelectorAll<HTMLElement>('button:not([disabled])')].find(eligible))?.focus({ preventScroll: true });
  };
  const refreshConditions = () => {
    const captured = { ...context(), schemaVersion: 1, windowId: binding?.windowId ?? 'main', surfaceId: location };
    const allows = (condition: Json | undefined) => {
      if (condition === undefined) return true;
      const result = evaluateCondition(condition, captured);
      return result.ok && result.value === true;
    };
    for (const { button, visible, enabled, hasItems } of conditions) {
      const disabled = !allows(enabled);
      button.hidden = !allows(visible) || layout.isHidden(button.dataset.extensionContribution!, layoutProject()) || hasItems && !disabled && !registration?.itemsFor(button.dataset.extensionContribution!, captured).length;
      if (button instanceof HTMLButtonElement) button.disabled = disabled;
      if ((button.hidden || disabled) && button.getAttribute('aria-expanded') === 'true') closeMenu?.();
      if (document.activeElement === button && (button.hidden || disabled)) fallbackFocus();
    }
    if (active()) for (const [, node] of coreControls) if (node.parentElement !== slot) slot.append(node);
    slot.hidden = !active() || !coreControls.length && !conditions.some(({ button }) => !button.hidden);
    applyControlOrder(location, [...coreControls.filter(([, node]) => node.parentElement === slot), ...conditions.map(({ button }) => [button.dataset.extensionContribution!, button] as const)]);
  };
  const draw = () => {
    closeContext?.(); closeContext = undefined;
    closeDialog?.(); closeDialog = undefined;
    closeMenu?.();
    const focused = conditions.some(({ button }) => button === document.activeElement);
    registration?.dispose();
    // Built-ins keep their exact nodes/listeners through extension enable/disable.
    for (const { button } of conditions) button.remove();
    conditions = [];
    const current = extensionsSnapshot(), activation = extensionGeneration();
    registration = createDeclarativeActivation(current, activation);
    const owned = registration;
    for (const entry of owned.entries) {
        const { menu, command, svg } = entry;
        if (menu.location !== location) continue;
        if (!command || !['showMessage', 'showDialog', 'showProjectContext', 'runCommand'].includes(command.action.kind)) continue;
        const passive = menu.presentation === 'status' || menu.presentation === 'badge';
        const button = passive ? document.createElement('span') : document.createElement('button');
        if (button instanceof HTMLButtonElement) button.type = 'button';
        button.className = passive ? `extension-action-${menu.presentation}` : menu.presentation === 'button' ? 'extension-action-button ds-btn' : 'icon-button';
        button.dataset.extensionContribution = menu.id; button.dataset.tauriDragRegion = 'false';
        button.setAttribute('aria-label', passive ? menu.text ?? command.title : command.title); button.title = command.title;
        if (svg) {
          // Native policy returns a restricted static SVG, never arbitrary package HTML.
          const parsed = new DOMParser().parseFromString(svg, 'image/svg+xml');
          const icon = parsed.documentElement;
          if (icon.localName === 'svg' && !parsed.querySelector('parsererror')) {
            icon.setAttribute('class', 'icon'); icon.setAttribute('aria-hidden', 'true'); button.append(document.importNode(icon, true));
          }
        }
        if (!button.childNodes.length) { button.innerHTML = hostIcon('help'); button.dataset.extensionIconFallback = 'true'; }
        if (passive || menu.presentation === 'button') {
          const label = document.createElement('span'); label.textContent = menu.text ?? command.title; button.append(label);
        }
        if (menu.badge) {
          const badge = document.createElement('span'); badge.className = 'extension-action-badge'; badge.textContent = menu.badge; button.append(badge);
          button.setAttribute('aria-label', `${command.title}: ${menu.badge}`);
        }
        if (passive) {
          if (menu.presentation === 'status') button.setAttribute('role', 'status');
          slot.append(button); conditions.push({ button, visible: menu.visible, hasItems: false }); continue;
        }
        if (menu.items) button.setAttribute('aria-haspopup', 'menu');
        button.addEventListener('pointerdown', event => { if (menu.items && closeMenu) event.preventDefault(); });
        button.addEventListener('click', () => {
          if (activation !== extensionGeneration() || !button.isConnected) return;
          const captured = structuredClone({ ...context(), schemaVersion: 1, windowId: binding?.windowId ?? 'main', surfaceId: menu.location });
          const invoke = async (id: string) => {
            if (activation !== extensionGeneration() || !button.isConnected) return;
            let action = owned.actionFor(id, captured);
            if (!action) return;
            try { if (binding) action = await binding.invoke(id, entry.owner.version); }
            catch (error) { if (activation === extensionGeneration() && button.isConnected) showMessage(String(error)); return; }
            if (activation !== extensionGeneration() || !button.isConnected) return;
            if (action?.kind === 'showMessage') showMessage(action.message);
            if (action?.kind === 'runCommand') {
              closeMenu?.(); closeContext?.(); closeContext = openExecutableCommand(id, entry.owner.version, captured, button, showMessage);
            }
            if (action?.kind === 'showProjectContext') {
              closeMenu?.(); closeContext?.();
              closeContext = openProjectContext(id, entry.owner.version, captured, button, () => { closeContext = undefined; });
            }
            if (action?.kind === 'showDialog') {
              if (closeDialog) return;
              closeMenu?.();
              const transient = openExtensionDialog(action.dialog, captured, entry.owner.extensionId, button);
              closeDialog = transient.close;
              void transient.result.then(result => {
                if (closeDialog === transient.close) closeDialog = undefined;
                if (activation !== extensionGeneration() || !button.isConnected) return;
                if (result.kind === 'confirmed') showMessage(action.dialog.successMessage);
                else if (result.reason === 'cancel' && action.dialog.cancelMessage) showMessage(action.dialog.cancelMessage);
              });
            }
          };
          if (menu.items) {
            if (closeMenu) { const wasOpen = button.getAttribute('aria-expanded') === 'true'; closeMenu(); if (wasOpen) return; }
            const items = extensionChoices(owned.itemsFor(menu.id, captured), entry.icons, captured);
            closeMenu = openChoiceMenu({ anchor: button, title: command.title, items, itemLimit: 128, actions: true, onSelect: id => {
              void invoke(id);
            }, onClose: () => { closeMenu = undefined; } });
            return;
          }
          void invoke(menu.id);
        });
        slot.append(button);
        conditions.push({ button, visible: menu.visible, enabled: { op: 'all', args: [menu.enabled ?? true, command.enabled ?? true] }, hasItems: Boolean(menu.items) });
    }
    refreshConditions();
    if (focused) fallbackFocus();
  };
  const cleanup = onExtensionsChanged(draw), cleanupContext = onContextChanged?.(refreshConditions), cleanupLayout = layout.subscribe(() => { closeMenu?.(); refreshConditions(); }); draw();
  return () => { closeContext?.(); closeDialog?.(); closeMenu?.(); const focused = slot.contains(document.activeElement); cleanup(); cleanupContext?.(); cleanupLayout(); registration?.dispose(); conditions = []; for (const [, node] of coreControls) if (node.parentElement === slot) host.insertBefore(node, slot); slot.remove(); if (focused) fallbackFocus(); };
}
