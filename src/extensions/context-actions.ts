import { openChoiceMenu, type ChoiceItem } from '../choice-menu';
import { createDeclarativeActivation } from './activation';
import { extensionGeneration, extensionsSnapshot, onExtensionsChanged } from './manager';
import { evaluateCondition, type Json } from './contracts';
import { layout, orderedControls } from './layout-host';
import { extensionChoices, extensionIcon } from './menu-choices';
import { openExtensionDialog } from './dialogs';
import { openProjectContext } from './context-inspector';
import { openExecutableCommand } from './executable';
import { boundedContextActions, type ActionLocation } from './surfaces';

/** One clicked object, one bounded lifetime. No callback resolves a later active task. */
export function openContextActions(anchor: HTMLElement, location: ActionLocation, context: Record<string, Json>, options: { title: string; items: ChoiceItem[]; onSelect: (id: string) => void | Promise<void>; point?: { x: number; y: number }; notify: (message: string) => void; onClose?: () => void; isAlive?: () => boolean }): () => void {
  const captured: Record<string, Json> = structuredClone({ ...context, schemaVersion: 1, windowId: 'main', surfaceId: location });
  const activation = extensionGeneration(), owned = createDeclarativeActivation(extensionsSnapshot(), activation);
  let ended = false, openingDialog = false, closeDialog: (() => void) | undefined, closeMenu: (() => void) | undefined;
  const sourceKey = () => JSON.stringify([anchor.dataset.id, anchor.dataset.path, anchor.dataset.searchOpen, anchor.dataset.searchGroup, anchor.closest<HTMLElement>('.cv-file')?.dataset.path]);
  const originalSource = sourceKey();
  const sourceAlive = () => anchor.isConnected && sourceKey() === originalSource && options.isAlive?.() !== false;
  const fallback = () => {
    const eligible = (node: HTMLElement) => node.isConnected && !node.closest('[inert]') && node.checkVisibility() && !(node as HTMLButtonElement).disabled;
    (sourceAlive() && eligible(anchor) ? anchor : [...document.querySelectorAll<HTMLElement>('#prompt, button:not([disabled])')].find(node => node !== anchor && eligible(node)))?.focus({ preventScroll: true });
  };
  const dispose = () => {
    if (ended) return;
    ended = true; unsubscribe(); unsubscribeLayout(); observer.disconnect(); closeMenu?.(); closeDialog?.(); owned.dispose(); fallback();
  };
  const unsubscribe = onExtensionsChanged(dispose), unsubscribeLayout = layout.subscribe(dispose);
  const observer = new MutationObserver(() => { if (!sourceAlive()) dispose(); });
  observer.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['data-id', 'data-path', 'data-search-open', 'data-search-group'] });
  const valid = () => !ended && sourceAlive() && activation === extensionGeneration();
  const permits = (condition: Json | undefined) => { const result = condition === undefined ? undefined : evaluateCondition(condition, captured); return !result || result.ok && result.value === true; };
  const core = options.items.map(item => ({ ...item, id: `${location}/${item.id}` }));
  const entries = owned.entries.filter(entry => entry.menu.location === location && permits(entry.menu.visible));
  const contributed: ChoiceItem[] = entries.flatMap(entry => {
    const children = entry.menu.items ? extensionChoices(owned.itemsFor(entry.menu.id, captured), entry.icons, captured) : undefined;
    if (children && !children.length) return [];
    return [{ id: entry.menu.id, label: entry.command.title, leading: extensionIcon(entry.svg), disabled: !permits(entry.menu.enabled) || !permits(entry.command.enabled), children }];
  });
  const bounded = boundedContextActions<ChoiceItem>(core, contributed);
  if (bounded.omitted) options.notify('Some extension actions exceed this menu’s 128-item limit. Built-in actions remain available.');
  const items = new Map(bounded.items.map(item => [item.id, item]));
  const ids = orderedControls(location, [...items.keys()], typeof captured.projectId === 'string' ? captured.projectId : undefined);
  const visible = ids.filter(id => extensionsSnapshot().safeMode || !layout.isHidden(id, typeof captured.projectId === 'string' ? captured.projectId : undefined));
  let first = true;
  const choices = visible.map(id => { const item = { ...items.get(id)! }; if (first) item.separator = false; first = false; return item; });
  closeMenu = openChoiceMenu({ anchor, title: options.title, point: options.point, width: 280, actions: true, items: choices, itemLimit: 128, onSelect: id => {
    if (!valid()) { dispose(); return; }
    const legacy = core.find(item => item.id === id);
    if (legacy) { closeMenu?.(); return options.onSelect(id.slice(location.length + 1)); }
    const action = owned.actionFor(id, captured);
    if (action?.kind === 'showMessage') options.notify(action.message);
    if (action?.kind === 'runCommand') {
      openingDialog = true; closeMenu?.();
      const command = owned.commands.find(entry => entry.owner.extensionId === id.split('/')[0]);
      if (command) closeDialog = openExecutableCommand(id, command.owner.version, captured, anchor, options.notify, dispose);
      openingDialog = false;
    }
    if (action?.kind === 'showProjectContext') {
      openingDialog = true; closeMenu?.();
      const command = owned.commands.find(entry => entry.command.id === id || entry.owner.extensionId === id.split('/')[0]);
      if (command) closeDialog = openProjectContext(id, command.owner.version, captured, anchor, dispose);
      openingDialog = false;
    }
    if (action?.kind === 'showDialog') {
      openingDialog = true; closeMenu?.();
      const transient = openExtensionDialog(action.dialog, captured, entries.find(entry => id === entry.menu.id || entry.menu.items?.some(item => item.id === id))?.owner.extensionId ?? id.split('/')[0], anchor);
      closeDialog = transient.close; openingDialog = false;
      void transient.result.then(result => {
        if (!valid()) { dispose(); return; }
        if (result.kind === 'confirmed') options.notify(action.dialog.successMessage);
        else if (result.reason === 'cancel' && action.dialog.cancelMessage) options.notify(action.dialog.cancelMessage);
        dispose();
      });
    }
  }, onClose: () => { closeMenu = undefined; options.onClose?.(); if (!openingDialog && !closeDialog) dispose(); } });
  return dispose;
}
