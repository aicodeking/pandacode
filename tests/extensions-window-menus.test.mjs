import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWindowMenusControls, snapshotWindowMenus, WINDOW_MENUS_CONTROL_IDS, WINDOW_MENUS_CHOICE_CONTROLS, WINDOW_MENUS_PROTECTED_CONTROLS, WINDOW_MENUS_REGISTRY } from '../src/extensions/window-menus-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { WINDOW_MENUS_ACTION_SURFACES, WINDOW_MENUS_ENTRIES, WINDOW_MENUS_PINNED, WINDOW_MENUS_PROTECTED, WINDOW_MENUS_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
import { PER_PROJECT, DEFAULT_SORT, sortAfterChoice } from '../src/sidebar-sort.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/window-menus/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.window-menus/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.menus.workspace-view', 'panda.menus.sort', 'panda.menus.project-filter'];

test('Window menus registry: each owned member has public locations and operations, a hook in main.ts, and the ledger closes exactly the three gaps', () => {
  assert.deepEqual(WINDOW_MENUS_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.menus.workspace-view', 'src/main.ts'], ['panda.menus.sort', 'src/main.ts'], ['panda.menus.project-filter', 'src/main.ts']]);
  const menus = ledger.families.find(item => item.id === 'panda.menus').members;
  for (const entry of WINDOW_MENUS_REGISTRY) {
    assert.ok(entry.actions && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    assert.ok(menus.some(([id, owner]) => `panda.menus.${id}` === entry.member && owner === entry.source), entry.member);
  }
  // Every host menu passes an extension surface with its captured window state.
  const main = read('../src/main.ts');
  assert.match(main, /mountWindowMenusAdoption\(\{/);
  for (const [location, kind] of [['panda.workspace.view.menu', 'workspace-view'], ['panda.sidebar.sort.menu', 'sidebar-sort'], ['panda.projects.filter.menu', 'project-filter']]) assert.ok(main.includes(`windowMenus?.surface('${location}', { kind: '${kind}'`), location);
  assert.deepEqual([...WINDOW_MENUS_CONTROL_IDS], schema.$defs.windowMenusControlId.enum);
  const row = ledger.windowMenusCoverage['panda.menus.window'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.menus.window'); assert.equal(row.lead, 'T60I');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage'))) for (const [id, entry] of Object.entries(block)) if (!(key === 'windowMenusCoverage' && id === 'panda.menus.window')) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...WINDOW_MENUS_CONTROL_IDS]);
  assert.deepEqual(row.viewEntries, WINDOW_MENUS_ENTRIES['panda.workspace.view.menu'].map(([id]) => id)); assert.deepEqual(row.sortEntries, WINDOW_MENUS_ENTRIES['panda.sidebar.sort.menu'].map(([id]) => id));
  assert.deepEqual(row.pinned, Object.keys(WINDOW_MENUS_PINNED));
  assert.deepEqual(row.protected, WINDOW_MENUS_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...WINDOW_MENUS_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'conflict', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.menus.window').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.menus.window').tests.includes('tests/extensions-window-menus-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-window-menus-coverage\.spec\.ts/);
  assert.match(read('../playwright.webkit.config.ts'), /\|Window menus extension:/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/window-menus-host.ts'), ['src/extensions/window-menus-host.ts', [], 0, 1]);
  assert.ok(menus.some(([id, owner]) => id === 'window-menus-extension-entry' && owner === 'src/extensions/window-menus-host.ts'));
  // The original menus keep their members, anchors and handlers; the sort choice lives once in sidebar-sort.ts.
  for (const local of ['workspace-view', 'sort', 'project-filter']) { const [, owner, anchor] = menus.find(([id]) => id === local); assert.ok(read(`../${owner}`).includes(anchor), local); }
  for (const handler of ['function chooseSidebarSort(', 'async function chooseProjectFilter(', 'function setWorkspaceView(', 'const listedWorkspaceViews =']) assert.ok(main.includes(handler), handler);
  assert.match(read('../src/sidebar-sort.ts'), /export function sortAfterChoice\(/);
  // Package requests never carry text or bytes: the host builds contexts from ids and revisions.
  const host = read('../src/extensions/window-menus-host.ts');
  assert.doesNotMatch(host, /data-action/); assert.doesNotMatch(host, /\.value\b(?!,)/); assert.doesNotMatch(host, /textContent|innerText|HTMLTextAreaElement|#prompt|\.path\b/);
});

test('Window menus sort choices: the shared pure handler applies a task order or a count and rejects anything else', () => {
  assert.deepEqual(sortAfterChoice(DEFAULT_SORT, 'recent'), { ...DEFAULT_SORT, tasks: 'recent' });
  assert.deepEqual(sortAfterChoice(DEFAULT_SORT, 'created'), { ...DEFAULT_SORT, tasks: 'created' });
  assert.deepEqual(sortAfterChoice({ ...DEFAULT_SORT, tasks: 'recent' }, 'manual'), { ...DEFAULT_SORT, tasks: 'manual' });
  for (const count of PER_PROJECT) assert.deepEqual(sortAfterChoice(DEFAULT_SORT, `per-${count}`), { ...DEFAULT_SORT, perProject: count });
  for (const id of ['per-4', 'per-', 'tasks:recent', 'projects', '', 'perProject:6', '__proto__']) assert.equal(sortAfterChoice(DEFAULT_SORT, id), undefined, id);
  // The catalog's count entries are exactly the host's counts.
  assert.deepEqual(WINDOW_MENUS_ENTRIES['panda.sidebar.sort.menu'].filter(([id]) => id.startsWith('per-')).map(([id]) => Number(id.slice(4))), [...PER_PROJECT]);
});

test('Window menus manifests and contracts: the fixture validates, locations and selection kinds are public and the protected location is not a layout target', () => {
  const manifest = fixture('extension');
  assert.equal(validateContract('packages', [manifest]).ok, true);
  for (const component of manifest.contributes.components) assert.equal(componentIncompatibility(component), undefined, component.id);
  assert.deepEqual(manifest.contributes.menus.map(menu => menu.location), [...WINDOW_MENUS_ACTION_SURFACES]);
  // A contributed main view is a declared view opened by a declared openView command, listed in the Workspace view menu.
  assert.equal(manifest.contributes.views[0].id, 'sample.window-menus/notes');
  assert.deepEqual(manifest.contributes.commands.find(command => command.id === manifest.contributes.menus[0].command).action, { kind: 'openView', view: 'sample.window-menus/notes' });
  const missing = structuredClone(manifest); missing.contributes.commands[0].action.view = 'sample.window-menus/missing'; assert.equal(validateContract('packages', [missing]).ok, false);
  for (const location of WINDOW_MENUS_ACTION_SURFACES) { assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  assert.ok(!schema.$defs.actionLocation.enum.includes(WINDOW_MENUS_PROTECTED_LOCATION) && !schema.$defs.layoutLocation.anyOf[1].enum.includes(WINDOW_MENUS_PROTECTED_LOCATION));
  for (const [kind, surfaceId, ids] of [['workspace-view', 'panda.workspace.view.menu', ['board']], ['sidebar-sort', 'panda.sidebar.sort.menu', ['recent', 'per-6']], ['project-filter', 'panda.projects.filter.menu', ['all-projects']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind), kind);
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, revision: 1, selection: { kind, ids } }).ok, true, surfaceId);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.projects.filter.menu', revision: 1, selection: { kind: 'project-path', ids: ['x'] } }).ok, false);
  const forged = structuredClone(manifest); forged.contributes.layouts[0].location = WINDOW_MENUS_PROTECTED_LOCATION; assert.equal(validateContract('packages', [forged]).ok, false);
  const foreignRule = structuredClone(manifest); foreignRule.contributes.layouts[0].rules[0].id = 'panda.sidebar.sort.menu/recent'; assert.equal(validateContract('packages', [foreignRule]).ok, false);
  const state = fixture('state'), action = fixture('action');
  assert.equal(validateContract('windowMenusPresentation', state).ok, true); assert.equal(validateContract('windowMenusAction', action).ok, true);
  for (const field of ['selector', 'ipc', 'text', 'query', 'project', 'path', 'name']) {
    assert.equal(validateContract('windowMenusAction', { ...action, [field]: 'raw' }).ok, false, field);
    assert.equal(validateContract('windowMenusPresentation', { ...state, [field]: 'raw' }).ok, false, field);
  }
  for (const controlId of WINDOW_MENUS_PROTECTED_CONTROLS) assert.equal(validateContract('windowMenusAction', { ...action, controlId }).ok, false, controlId);
  for (const change of [{ controls: Array(65).fill(state.controls[0]) }, { menu: 'default-agent' }, { window: 'tray' }, { contractVersion: 2 }, { view: 7 }]) assert.equal(validateContract('windowMenusPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: 'Board' }, { name: 'project' }, { path: '/x' }]) assert.equal(validateContract('windowMenusPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  // The SDK declares the same shapes; the native mirror is checked by contracts.rs and packages.rs.
  const sdk = read('../src/extensions/sdk/index.d.ts');
  assert.match(sdk, /export type WindowMenusControl = 'view-open' \| 'sort-set' \| 'scope-set' \| 'filter-set';/);
  assert.match(sdk, /export type WindowMenusSelectionKind = 'workspace-view' \| 'sidebar-sort' \| 'project-filter';/);
  assert.match(read('../src-tauri/src/extensions/contracts.rs'), /"windowMenusPresentation", "windowMenusAction"/);
  assert.match(read('../src-tauri/src/extensions/packages.rs'), /fn window_menus_archive_install_restart_disable_and_safe_mode/);
  // The contributed view opens through the existing view navigation, which the menu path now calls.
  assert.match(read('../src/extensions/context-actions.ts'), /action\?\.kind === 'openView'\) \{ closeMenu\?\.\(\); requestInspectorView\(action\.view\)/);
});

test('Window menus catalog: eligible entries hide and reorder, pinned and protected ones are inspect-only with their reason, layouts are reversible', () => {
  const manifest = fixture('extension');
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of WINDOW_MENUS_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: WINDOW_MENUS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const [location, entries] of Object.entries(WINDOW_MENUS_ENTRIES)) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), entries.map(([id]) => `${location}/${id}`).sort(), location);
    for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder'], item.id);
  }
  // Pinned and protected entries are never layout items; each carries its reason.
  const protectedItems = catalog.listItems({ location: WINDOW_MENUS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), WINDOW_MENUS_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  for (const id of Object.keys(WINDOW_MENUS_PINNED)) { const [location, entry] = [id.slice(0, id.lastIndexOf('/')), id.slice(id.lastIndexOf('/') + 1)]; assert.ok(!WINDOW_MENUS_ENTRIES[location].some(([local]) => local === entry), id); assert.ok(WINDOW_MENUS_PINNED[id].length > 30, id); }
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]).sort(([a], [b]) => a.localeCompare(b)), [...manifest.contributes.menus.map(menu => [menu.id, menu.location, ['inspect', 'hide', 'show', 'reorder']]), [manifest.contributes.views[0].id, 'panda.inspector.views', ['inspect', 'hide', 'show', 'reorder']]].sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(createUiCatalog(() => ({ safeMode: true, packages: [] })).listItems({ location: 'panda.sidebar.sort.menu' }).items.length, WINDOW_MENUS_ENTRIES['panda.sidebar.sort.menu'].length);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const [location, entries] of Object.entries(WINDOW_MENUS_ENTRIES)) for (const [id] of entries) { const full = `${location}/${id}`; layout.setVisible(full, false); assert.equal(layout.isHidden(full), true); layout.setVisible(full, true); assert.equal(layout.isHidden(full), false); }
  const entries = ['created', 'recent'].map(id => `panda.sidebar.sort.menu/${id}`); layout.move('panda.sidebar.sort.menu', entries, { id: entries[0], target: entries[1], side: 'before' }); assert.equal(layout.order('panda.sidebar.sort.menu', entries)[0], entries[0]);
});

test('Window menus bind owner/window/mount/view/sort/filter/revision; protected, busy, hidden, choice and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createWindowMenusControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'view', 'sort', 'filter', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { controlId: 'filter-set' }, { resource: 'resource-board' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.controlId !== 'sort-set') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), menu: 'sort', busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: control.controlId === 'sort-set' })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  // The open view is not a target: its control is disabled, never forced.
  assert.equal(slot.dispatch({ ...fixture('action'), control: 'control-conversation', controlId: 'view-open', resource: 'resource-conversation' }).reason, 'UnsupportedCapability');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.window-menus/toolbar';
  // Hiding the open view, manual order, project actions, adding or removing a project and GitHub are named and never run.
  for (const controlId of WINDOW_MENUS_PROTECTED_CONTROLS) for (const control of ['control-recent', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, query: 'x' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.sort' }, { controlId: 'sort-now' }, { text: 'hello' }, { query: 'project' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0])); assert.equal(calls[0].controlId, 'sort-set');
  // Changing the view, the sort, the count and the project filter all need the fresh host choice.
  assert.deepEqual([...WINDOW_MENUS_CHOICE_CONTROLS], [...WINDOW_MENUS_CONTROL_IDS]);
  const state = fixture('state'), guarded = createWindowMenusControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('no choice, no handler'));
  for (const [control, controlId, resource] of [['control-board', 'view-open', 'resource-board'], ['control-recent', 'sort-set', 'resource-recent'], ['control-per-10', 'scope-set', 'resource-per-10'], ['control-project', 'filter-set', 'resource-project']]) assert.equal(guarded.dispatch({ ...fixture('action'), control, controlId, resource, requestId: control }).reason, 'PermissionDenied', controlId);
  for (const id of [...WINDOW_MENUS_PROTECTED.map(([id]) => id), ...WINDOW_MENUS_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.windowMenusControlId.enum.includes(id), id);
  assert.throws(() => snapshotWindowMenus({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});
