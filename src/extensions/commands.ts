import { extensionsSnapshot, extensionGeneration, onExtensionsChanged } from './manager';
import { createDeclarativeActivation } from './activation';
import { openExtensionDialog } from './dialogs';
import { openProjectContext } from './context-inspector';
import { openExecutableCommand } from './executable';
import { BINDING_CHOICES_KEY, readBindingChoices, shortcutCommand } from './shortcuts';
import type { Json } from './contracts';

export function extensionCommands() {
  const activation = createDeclarativeActivation(extensionsSnapshot(), extensionGeneration());
  const commands = activation.commands; activation.dispose(); return commands;
}
export function activeKeybindings() {
  const snapshot = extensionsSnapshot();
  return snapshot.safeMode ? [] : snapshot.packages.filter(item => item.enabled).flatMap(item => item.manifest.contributes.keybindings ?? []);
}
/** Rechecks enabled owner/generation at invocation; visual hiding is deliberately not authority. */
export function invokeExtensionCommand(id: string, context: Record<string, Json>, notify: (message: string) => void): boolean {
  const generation = extensionGeneration(), activation = createDeclarativeActivation(extensionsSnapshot(), generation);
  const command = activation.commands.find(entry => entry.command.id === id), action = activation.commandAction(id, context);
  activation.dispose();
  if (!command || !action) return false;
  if (action.kind === 'showMessage') { notify(action.message); return true; }
  if (action.kind === 'runCommand') { openExecutableCommand(id, command.owner.version, context, document.activeElement instanceof HTMLElement ? document.activeElement : document.body, notify); return true; }
  if (action.kind === 'showProjectContext') {
    openProjectContext(id, command.owner.version, structuredClone(context), document.activeElement instanceof HTMLElement ? document.activeElement : document.body); return true;
  }
  if (action.kind !== 'showDialog') return false;
  const anchor = document.activeElement instanceof HTMLElement ? document.activeElement : document.body;
  const transient = openExtensionDialog(action.dialog, structuredClone(context), command.owner.extensionId, anchor);
  const unsubscribe = onExtensionsChanged(() => transient.close());
  void transient.result.then(result => { unsubscribe(); if (generation === extensionGeneration() && result.kind === 'confirmed') notify(action.dialog.successMessage); });
  return true;
}
export function dispatchExtensionShortcut(event: KeyboardEvent, context: Record<string, Json>, notify: (message: string) => void): boolean {
  const target = event.target instanceof Element ? event.target : null;
  const editing = !!target?.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], .xterm');
  let choices = {}; try { choices = readBindingChoices(localStorage.getItem(BINDING_CHOICES_KEY)); } catch { /* Defaults are conflict-safe. */ }
  const command = shortcutCommand(activeKeybindings(), choices, event, editing, !!document.querySelector('dialog[open], .floating-menu'));
  if (!command || !invokeExtensionCommand(command, { ...context, schemaVersion: 1, windowId: 'main', surfaceId: 'panda.shortcuts' }, notify)) return false;
  event.preventDefault(); return true;
}
