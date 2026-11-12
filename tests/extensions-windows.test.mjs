import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { WINDOW_ACTION_SURFACES } from '../src/extensions/window-surfaces.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/window-laboratory/extension.json', import.meta.url), 'utf8'));
const state = () => ({ safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {} }], diagnostics: [] });
test('extensions windows: every actual auxiliary label has an explicit surface and capability fallback', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const ui = createUiCatalog(state);
  assert.deepEqual([...new Set(Object.values(WINDOW_ACTION_SURFACES))].sort(), ['agents-dock', 'launcher', 'tray']);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  const actualLabels = ledger.families.filter(family => ['panda.tray', 'panda.windows'].includes(family.id)).flatMap(family => family.members.map(member => member[4] ?? family.window ?? ledger.defaults.window));
  assert.deepEqual([...new Set(actualLabels)].sort(), ['agents-dock', 'launcher', 'main', 'tray']);
  for (const id of Object.keys(WINDOW_ACTION_SURFACES)) assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === id)?.tests.includes('tests/extensions-windows.spec.ts'));
  for (const [surface, windowId] of Object.entries(WINDOW_ACTION_SURFACES)) {
    const metadata = ui.listSurfaces({ windowId, location: surface }).items[0];
    assert.equal(metadata.available, true); assert.deepEqual(metadata.windows, [windowId]);
    assert.equal(metadata.capabilities.inlineSelect, false); assert.equal(metadata.capabilities.selectFallback, 'host-quick-pick');
    assert.equal(metadata.capabilities.dialogPlacement, 'main'); assert.equal(metadata.capabilities.qualification, 'experimental');
    assert.ok(metadata.capabilities.limitations.length);
    assert.equal(metadata.capabilities.icons, surface !== 'panda.tray.menu');
    assert.equal(ui.listSurfaces({ location: surface }).items[0].available, false);
    assert.equal(ui.listSurfaces({ windowId: 'overlay', location: surface }).items[0].available, false);
  }
});
test('extensions windows: presentation activations bind window/surface and disposing one never revokes another', () => {
  const first = createDeclarativeActivation(state(), 1), second = createDeclarativeActivation(state(), 2);
  for (const entry of first.entries) {
    const id = entry.menu.items[0].items[0].id;
    const context = { schemaVersion: 1, windowId: WINDOW_ACTION_SURFACES[entry.menu.location], surfaceId: entry.menu.location, revision: 1 };
    assert.equal(first.actionFor(id, context).kind, 'showDialog');
    assert.equal(first.actionFor(id, { ...context, windowId: 'main' }), undefined);
    assert.equal(first.actionFor(id, { ...context, surfaceId: 'panda.workspace.header.actions' }), undefined);
    assert.equal(first.commandAction('sample.window-laboratory/form', { ...context, surfaceId: 'panda.commands' }), undefined);
    first.entries[0].command.action.message = 'forged';
  }
  const context = { schemaVersion: 1, windowId: 'launcher', surfaceId: 'panda.launcher.actions', revision: 1 };
  first.dispose(); assert.equal(first.actionFor('sample.window-laboratory/launcher-form', context), undefined);
  assert.equal(second.actionFor('sample.window-laboratory/launcher-form', context).kind, 'showDialog');
  second.dispose();
  for (const snapshot of [{ ...state(), safeMode: true }, { ...state(), packages: state().packages.map(item => ({ ...item, enabled: false })) }]) assert.equal(createDeclarativeActivation(snapshot, 3).entries.length, 0);
});
test('extensions windows: native policy is wired before dispatch and capabilities remain narrowly scoped', () => {
  const lib = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.ok(lib.indexOf('windows::command_allowed(invoke.message.webview_ref().label(), invoke.message.command())') < lib.indexOf('if invoke.message.webview_ref().label() == "launcher"'));
  for (const window of ['tray', 'launcher', 'agents-dock']) {
    const capability = JSON.parse(readFileSync(new URL(`../src-tauri/capabilities/${window}.json`, import.meta.url), 'utf8'));
    assert.deepEqual(capability.webviews, [window]);
    assert.ok(capability.permissions.every(name => ['core:event:allow-listen', 'core:event:allow-unlisten', 'core:window:allow-start-dragging'].includes(name)));
  }
});
