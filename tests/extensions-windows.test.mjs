import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { WINDOW_ACTION_SURFACES, WINDOW_PROTECTED_SURFACES } from '../src/extensions/window-surfaces.ts';
import { WINDOW_REGISTRY, WINDOW_PROTECTED, WINDOW_FALLBACKS } from '../src/extensions/window-core.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/window-laboratory/extension.json', import.meta.url), 'utf8'));
const state = () => ({ safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {} }], diagnostics: [] });
test('extensions windows: every actual auxiliary label has an explicit surface and capability fallback', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const ui = createUiCatalog(state);
  assert.deepEqual([...new Set(Object.values(WINDOW_ACTION_SURFACES))].sort(), ['agents-dock', 'launcher', 'tray']);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  const actualLabels = ledger.families.filter(family => ['panda.tray', 'panda.windows'].includes(family.id)).flatMap(family => family.members.map(member => member[4] ?? family.window ?? ledger.defaults.window));
  assert.deepEqual([...new Set(actualLabels)].sort(), ['agents-dock', 'extension-view', 'launcher', 'main', 'tray']);
  const rich = ledger.families.find(family => family.id === 'panda.windows').members.find(member => member[4] === 'extension-view');
  assert.equal(rich[1], 'src-tauri/src/extensions/rich_views.rs');
  // Q051 (R0306): changed. Rich windows open for trusted packages holding ui.richViews on qualified targets (Windows
  // x64, docs/extensions/runtime-windows-panels.md) and answer UnsupportedRuntime on every other target (predictability:
  // no installed evidence there). R1102 owns the per-target platform record.
  assert.match(rich[3], /trusted packages holding ui\.richViews on qualified targets \(windows-x64\); UnsupportedRuntime on every other target/);
  assert.doesNotMatch(rich[3], /disabled on all targets/);
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

const coverageManifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/window-coverage/extension.json', import.meta.url), 'utf8'));
const coverageState = () => ({ safeMode: false, packages: [{ manifest: structuredClone(coverageManifest), enabled: true, icons: {} }], diagnostics: [] });
test('window coverage: every panda.tray/panda.windows member and the pinned widget has an adapter or a specific exception with a fallback', () => {
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  const coverage = ledger.windowCoverage['panda.windows'];
  const members = ledger.families.filter(family => ['panda.tray', 'panda.windows'].includes(family.id)).flatMap(family => family.members.map(([local]) => `${family.id}.${local}`));
  assert.deepEqual(WINDOW_REGISTRY.map(entry => entry.member).sort(), [...members, 'panda.agents.widget'].sort());
  assert.deepEqual(Object.keys(coverage.members).sort(), WINDOW_REGISTRY.map(entry => entry.member).sort());
  assert.equal(ledger.controlsAudit.gaps['panda.agents/widget-window'].severity, 'closed');
  for (const entry of WINDOW_REGISTRY) {
    const row = coverage.members[entry.member];
    assert.equal(row.disposition, entry.disposition, entry.member); assert.deepEqual(row.locations, entry.locations, entry.member); assert.equal(row.fallback, entry.fallback, entry.member);
    assert.ok(entry.fallback.length > 20, entry.member);
    // An exception names its specific protected or platform reason; missing implementation is never one.
    if (entry.disposition !== 'adapter') { assert.ok(entry.reason && entry.reason.length > 30, entry.member); assert.equal(row.reason, entry.reason); }
    for (const path of row.evidence) assert.doesNotThrow(() => readFileSync(new URL(`../${path}`, import.meta.url)), path);
  }
  assert.doesNotMatch(JSON.stringify(coverage), /\blater\b|TODO|pending implementation/i);
  const ui = createUiCatalog(coverageState);
  // Q052 (R0306): retained. Protected window controls (Quit, Show PandaCode, recovery, the pinned widget's lifetime)
  // stay inspect-only: they are the user's way back when packages fail (fault isolation and recovery, not security).
  // Packages contribute beside them through the window action surfaces and panda.tray.menu, asserted below.
  for (const [location, windowId] of Object.entries(WINDOW_PROTECTED_SURFACES)) {
    const surface = ui.listSurfaces({ windowId, location }).items[0];
    assert.equal(surface.available, true); assert.deepEqual(surface.windows, [windowId]); assert.deepEqual(surface.supportedOperations, ['inspect']);
    const items = ui.listItems({ windowId, location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id.slice(location.length + 1)).sort(), WINDOW_PROTECTED[location].map(([id]) => id).sort());
    for (const item of items) { assert.equal(item.owner, 'panda.core'); assert.equal(item.available, true); assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — \w+/); }
    assert.ok(ui.listItems({ location, limit: 100 }).items.every(item => !item.available), 'another window never sees them as available');
  }
  const menu = ui.listSurfaces({ windowId: 'tray', location: 'panda.tray.menu' }).items[0];
  assert.deepEqual(menu.supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder']);
  assert.deepEqual(menu.capabilities.fallbacks, WINDOW_FALLBACKS['panda.tray.menu']); assert.equal(menu.capabilities.icons, false);
  for (const location of ['panda.tray.actions', 'panda.launcher.actions', 'panda.agentsDock.actions']) assert.equal(ui.listSurfaces({ windowId: WINDOW_ACTION_SURFACES[location], location }).items[0].capabilities.fallbacks.select, 'host-quick-pick');
  const native = ui.listItems({ windowId: 'tray', location: 'panda.tray.menu', limit: 100 }).items;
  assert.deepEqual(native.map(item => item.id), ['sample.window-coverage/native-extra', 'sample.window-coverage/native-menu', 'sample.window-coverage/native-status']);
  for (const item of native) assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder']);
});
test('window coverage: auxiliary contributions hide and reorder through the host layout store; protected window controls never do', () => {
  const memory = new Map(); const layout = createLayoutStore({ getItem: key => memory.get(key) ?? null, setItem: (key, value) => memory.set(key, value) });
  const pairs = { 'panda.tray.actions': ['tray-state', 'tray-tools'], 'panda.tray.menu': ['native-extra', 'native-menu'] };
  for (const [location, [first, second]] of Object.entries(pairs)) {
    const ids = [first, second].map(id => `sample.window-coverage/${id}`);
    layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' });
    assert.deepEqual(layout.order(location, ids), [ids[1], ids[0]], location);
  }
  for (const location of ['panda.launcher.actions', 'panda.agentsDock.actions']) layout.move(location, ['sample.a/one', 'sample.a/two'], { id: 'sample.a/two', target: 'sample.a/one', side: 'before' });
  layout.setVisible('sample.window-coverage/native-extra', false);
  assert.equal(layout.isHidden('sample.window-coverage/native-extra'), true);
  // Q052 (R0306): retained, same reason: the recovery controls keep a fixed place (predictability when packages fail).
  for (const location of Object.keys(WINDOW_PROTECTED_SURFACES)) assert.throws(() => layout.move(location, [`${location}/a`, `${location}/b`], { id: `${location}/b`, target: `${location}/a`, side: 'before' }), /Unsupported placement/);
});
