import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { bindingGroups, shortcutCommand, readBindingChoices, CORE_BINDINGS } from '../src/extensions/shortcuts.ts';
import { settingsDefaults, validSettingsValues } from '../src/extensions/settings-state.ts';
const sample = JSON.parse(readFileSync(new URL('./fixtures/extensions/settings-laboratory/extension.json', import.meta.url), 'utf8'));
const bindings = sample.contributes.keybindings;
const event = { code: 'KeyU', ctrlKey: true, metaKey: false, shiftKey: true, altKey: false, repeat: false, defaultPrevented: false, isComposing: false, keyCode: 85 };
test('extensions settings: installable sample validates settings/status/dialog/keybinding ownership', () => {
  const checked = validateContract('packages', [sample]); assert.equal(checked.ok, true);
  assert.deepEqual(checked.value.packages[0], sample);
  for (const kind of ['settings', 'keybindings', 'dialogExtras']) {
    const invalid = structuredClone(sample); invalid.contributes[kind][0].id = 'other.owner/foreign';
    assert.equal(validateContract('packages', [invalid]).error.code, 'InvalidId');
  }
});
test('extensions settings: static typed values never reuse core keys or permit unknown/disabled values', () => {
  const page = sample.contributes.settings[0], defaults = settingsDefaults(page);
  assert.equal(validSettingsValues(page, defaults), true);
  for (const values of [{ ...defaults, theme: 'dark' }, { ...defaults, label: '' }, { ...defaults, enabled: 'yes' }, { ...defaults, format: 'unsupported' }, { ...defaults, format: 'unknown' }, { ...defaults, label: 'x'.repeat(4097) }]) assert.equal(validSettingsValues(page, values), false);
  const invalid = structuredClone(sample); invalid.contributes.settings[0].fields[2].async = true;
  assert.equal(validateContract('packages', [invalid]).error.code, 'UnsupportedContribution');
});
test('extensions shortcuts: conflict is unassigned, deterministic and explicitly resolved, core cannot lose', () => {
  assert.equal(shortcutCommand(bindings, {}, event, false, false), undefined);
  assert.equal(shortcutCommand([...bindings].reverse(), {}, event, false, false), undefined);
  const choices = { 'Mod+Shift+KeyU': bindings[0].id, 'Mod+KeyK': bindings[2].id };
  assert.equal(shortcutCommand(bindings, choices, event, false, false), bindings[0].command);
  assert.equal(bindingGroups(bindings, choices).find(group => group.key === 'Mod+KeyK').winner, undefined);
  assert.equal(shortcutCommand(bindings, { 'Mod+Shift+KeyU': 'other.owner/missing' }, event, false, false), undefined);
  for (const key of ['Mod+KeyK', 'Mod+KeyB', 'Mod+Shift+KeyB', 'Mod+KeyN', 'Mod+KeyJ', 'Mod+KeyZ']) assert.equal(CORE_BINDINGS.has(key), true);
});
test('extensions shortcuts: input, terminal, IME, 229, repeats, modal and handled events are never intercepted', () => {
  const choices = { 'Mod+Shift+KeyU': bindings[0].id };
  for (const patch of [{ isComposing: true }, { keyCode: 229 }, { repeat: true }, { defaultPrevented: true }, { metaKey: true }, { ctrlKey: false }]) assert.equal(shortcutCommand(bindings, choices, { ...event, ...patch }, false, false), undefined);
  assert.equal(shortcutCommand(bindings, choices, event, true, false), undefined);
  assert.equal(shortcutCommand(bindings, choices, event, false, true), undefined);
  assert.deepEqual(readBindingChoices('{broken'), {}); assert.deepEqual(readBindingChoices('[]'), {});
  assert.deepEqual(readBindingChoices(JSON.stringify({ 'Mod+Shift+KeyU': bindings[0].id, bad: 'other', 'Mod+KeyK': 3 })), choices);
});
test('extensions commands: hidden controls do not grant/revoke command permission; disable/safe/disposal revoke', () => {
  const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', revision: 1 };
  const snapshot = { safeMode: false, packages: [{ enabled: true, manifest: sample, icons: {} }], diagnostics: [] };
  const activation = createDeclarativeActivation(snapshot, 2);
  assert.equal(activation.commandAction(bindings[0].command, context).message, 'Settings laboratory command invoked');
  assert.equal(activation.commandAction('sample.settings-laboratory/denied', context), undefined);
  assert.equal(activation.commandAction(bindings[0].command, { ...context, windowId: 'tray' }), undefined);
  assert.equal(activation.commandAction(bindings[0].command, { ...context, surfaceId: 'panda.dialog.privacy.actions' }), undefined);
  activation.dispose(); assert.equal(activation.commandAction(bindings[0].command, context), undefined);
  for (const state of [{ ...snapshot, safeMode: true }, { ...snapshot, packages: [{ ...snapshot.packages[0], enabled: false }] }]) assert.deepEqual(createDeclarativeActivation(state, 3).commands, []);
});
test('extensions dialogs: named contracts reject protected and unsupported hosts at validation', () => {
  for (const name of ['permission', 'recovery', 'privacy', 'approve', 'unknown']) {
    const invalid = structuredClone(sample); invalid.contributes.dialogExtras[0].dialog = name;
    assert.equal(validateContract('packages', [invalid]).ok, false);
    const menu = structuredClone(sample); menu.contributes.menus[0].location = `panda.dialog.${name}.actions`;
    assert.equal(validateContract('packages', [menu]).ok, false);
  }
  const unknown = structuredClone(sample); unknown.contributes.keybindings[0].command = 'other.owner/unknown';
  assert.equal(validateContract('packages', [unknown]).error.code, 'UnknownReference');
});
