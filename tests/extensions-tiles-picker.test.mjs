import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTilesControls, createPickerControls, snapshotTiles, snapshotPicker, TILES_CONTROL_IDS, PICKER_CONTROL_IDS, TILES_PICKER_CHOICE_CONTROLS, TILES_PROTECTED_CONTROLS, PICKER_PROTECTED_CONTROLS, TILES_PICKER_REGISTRY } from '../src/extensions/tiles-picker-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { TILES_PICKER_ACTION_SURFACES, TILES_CONTROLS, PICKER_ENTRIES, TILES_PICKER_PINNED, TILES_PICKER_FIXED, TILES_PICKER_PROTECTED, TILES_LOCATION, PICKER_LOCATION, TILES_PICKER_PROTECTED_LOCATION, THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/tiles-picker/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.tiles-picker/timeline', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.workspace.views.tiles', 'panda.workspace.views.project-picker', 'src/main.ts#change-task-project'];
const CONTROLS = [[TILES_LOCATION, TILES_CONTROLS], [PICKER_LOCATION, PICKER_ENTRIES]];

test('Tiles picker registry: each owned member has public locations, operations and an extension hook in its source, and the ledger closes exactly the three gaps', () => {
  assert.deepEqual(TILES_PICKER_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.workspace.views.tiles', 'src/thread-tiles.ts'], ['panda.workspace.views.project-picker', 'src/main.ts']]);
  for (const entry of TILES_PICKER_REGISTRY) {
    assert.ok(entry.actions && entry.order && entry.hide && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    const local = entry.member.slice('panda.workspace.views.'.length);
    assert.ok(ledger.families.find(item => item.id === 'panda.workspace.views').members.some(([id, owner]) => id === local && owner === entry.source), entry.member);
  }
  // T60's audit found no extension hook in the tiles or the picker; each now carries the adapter's hook.
  assert.match(read('../src/thread-tiles.ts'), /extension\?\(\): TileExtension/);
  assert.match(read('../src/project-picker.ts'), /extension\?: ProjectPickerExtension/);
  const main = read('../src/main.ts');
  assert.match(main, /extension: \(\) => tilesPicker\?\.tileLayout\(\)/);
  assert.match(main, /const extension = tilesPicker\?\.pickerExtension\(currentProjectId, NO_PROJECT\)/);
  assert.match(main, /case 'change-task-project': await showProjectPicker\(element\); break;/);
  assert.match(main, /mountTilesPickerAdoption\(\{/);
  assert.deepEqual([...TILES_CONTROL_IDS], schema.$defs.tilesControlId.enum); assert.deepEqual([...PICKER_CONTROL_IDS], schema.$defs.projectPickerControlId.enum);
  const row = ledger.viewsCoverage['panda.workspace.tiles-picker'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.workspace.tiles-picker'); assert.equal(row.lead, 'T60F');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage'))) for (const [id, entry] of Object.entries(block)) if (!(key === 'viewsCoverage' && id === 'panda.workspace.tiles-picker')) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...TILES_CONTROL_IDS, ...PICKER_CONTROL_IDS]);
  assert.deepEqual(row.tileControls, TILES_CONTROLS.map(([id]) => id)); assert.deepEqual(row.pickerEntries, PICKER_ENTRIES.map(([id]) => id));
  assert.deepEqual(row.protected, TILES_PICKER_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...TILES_PROTECTED_CONTROLS, ...PICKER_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.workspace.tiles-picker').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.workspace.tiles-picker').tests.includes('tests/extensions-tiles-picker-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-tiles-picker-coverage\.spec\.ts/);
  assert.match(read('../playwright.webkit.config.ts'), /\|Tiles picker extension:/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/tiles-picker-host.ts'), ['src/extensions/tiles-picker-host.ts', [], 0, 1]);
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'tiles-picker-extension-entry' && owner === 'src/extensions/tiles-picker-host.ts'));
  // The ledger's own view rows stay anchored to their sources; the change-task-project action stays inventoried.
  for (const local of ['tiles', 'project-picker']) {
    const [, owner, anchor] = ledger.families.find(family => family.id === 'panda.workspace.views').members.find(([id]) => id === local);
    assert.ok(read(`../${owner}`).includes(anchor), local);
  }
  assert.ok(ledger.sourceInventory.find(([owner]) => owner === 'src/main.ts')[1].includes('change-task-project'));
  // The picker never reads or receives the draft text: only its digest enters the revision.
  const host = read('../src/extensions/tiles-picker-host.ts');
  assert.doesNotMatch(host, /draft: state\.draft[,}]/);
  assert.match(host, /draft: Boolean\(state\.draft\.trim\(\)\)/);
});

test('Tiles picker schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension');
  assert.equal(validateContract('packages', [manifest]).ok, true);
  for (const provider of manifest.contributes.components) assert.equal(componentIncompatibility(provider), undefined, provider.id);
  for (const [kind, surfaceId, ids] of [['tile', 'panda.workspace.tiles.actions', ['task-2']], ['draft-project', 'panda.workspace.project-picker.actions', ['task-9']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: ids[0], revision: 1, selection: { kind, ids } }).ok, true, kind);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.tiles.actions', revision: 1, selection: { kind: 'tile-input', ids: ['task-1'] } }).ok, false);
  // The tile slot is a host marker mounted by thread-actions.ts with the tile's own thread; it is not a thread slot.
  assert.deepEqual([...TILES_PICKER_ACTION_SURFACES], ['panda.workspace.tiles.actions', 'panda.workspace.project-picker.actions']);
  for (const location of TILES_PICKER_ACTION_SURFACES) { assert.ok(!THREAD_ACTION_SURFACES.includes(location)); assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  assert.match(read('../src/extensions/thread-actions.ts'), /'panda\.workspace\.tiles\.actions'\]/);
  for (const [location] of CONTROLS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [TILES_PICKER_PROTECTED_LOCATION, 'panda.workspace.views', 'panda.workspace.tiles']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.workspace.project-picker.entries/open'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute', 'tasks.transcript.read', 'tasks.tools.read']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of TILES_PICKER_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const [location] of CONTROLS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: TILES_PICKER_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  // Pinned entries never hide but still reorder; pinned and fixed ones (the current project) are inspect-only.
  for (const [location, controls] of CONTROLS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      const pinned = TILES_PICKER_PINNED[item.id], fixed = TILES_PICKER_FIXED[item.id];
      assert.deepEqual(item.supportedOperations, pinned && fixed ? ['inspect'] : pinned ? ['inspect', 'reorder'] : fixed ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (pinned || fixed) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(Object.keys(TILES_PICKER_PINNED), [`${TILES_LOCATION}/title`, `${PICKER_LOCATION}/current`, `${PICKER_LOCATION}/projects`]);
  assert.deepEqual(Object.keys(TILES_PICKER_FIXED), [`${TILES_LOCATION}/composer`, `${PICKER_LOCATION}/current`, `${PICKER_LOCATION}/open`]);
  const protectedItems = catalog.listItems({ location: TILES_PICKER_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), TILES_PICKER_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // The picker's search field, the draft and a tile's rows are never layout items.
  const layoutIds = CONTROLS.flatMap(([location, controls]) => controls.map(([id]) => `${location}/${id}`));
  for (const id of ['search', 'draft', 'rows', 'input']) assert.ok(!layoutIds.some(item => item.endsWith(`/${id}`)), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.tiles-picker/draft', 'panda.workspace.project-picker.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.tiles-picker/tile', 'panda.workspace.tiles.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const id of layoutIds.filter(id => !TILES_PICKER_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const entries = ['no-project', 'projects'].map(id => `${PICKER_LOCATION}/${id}`); layout.move(PICKER_LOCATION, entries, { id: entries[1], target: entries[0], side: 'before' }); assert.equal(layout.order(PICKER_LOCATION, entries)[0], entries[1]);
  // Bounded JSON only: no titles, rows, draft text, search text or project names cross the presentations.
  for (const [shape, state] of [['tilesPresentation', fixture('state')], ['projectPickerPresentation', fixture('picker-state')]]) {
    assert.equal(validateContract(shape, state).ok, true, shape);
    for (const change of [{ controls: Array(shape === 'tilesPresentation' ? 33 : 129).fill(state.controls[0]) }, { selector: '.thread-tile' }, { draftText: 'secret' }, { title: 'Make search feel instant' }, { search: 'orbit' }, { window: 'tray' }, { contractVersion: 2 }]) assert.equal(validateContract(shape, { ...state, ...change }).ok, false, `${shape} ${JSON.stringify(change).slice(0, 40)}`);
    for (const extra of [{ label: 'orbit' }, { path: '/tmp/a' }]) assert.equal(validateContract(shape, { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  }
  assert.equal(validateContract('tilesPresentation', { ...fixture('state'), tiles: Array(7).fill('tile') }).ok, false);
  assert.equal(validateContract('projectPickerPresentation', { ...fixture('picker-state'), entries: 129 }).ok, false);
  assert.equal(validateContract('tilesAction', fixture('action')).ok, true); assert.equal(validateContract('projectPickerAction', fixture('picker-action')).ok, true);
  assert.equal(validateContract('tilesAction', { ...fixture('action'), controlId: 'picker-select' }).ok, false);
  assert.throws(() => snapshotTiles({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  assert.throws(() => snapshotPicker({ ...fixture('picker-state'), controls: Array(2).fill(fixture('picker-state').controls[0]) }), /Duplicate/);
});

test('Tiles bind owner/window/mount/project/focused task/revision and the tile resource; a mirror takes no input; busy, hidden, protected and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createTilesControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another tile or control is another target; so is a tile that left.
  for (const change of [{ control: 'foreign' }, { controlId: 'tile-close' }, { resource: 'tile-a' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.resource !== 'tile-b') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  // The focused tile's follow-up button is hidden: nothing to act on.
  assert.equal(slot.dispatch({ ...fixture('action'), control: 'control-composer-a', controlId: 'tile-composer', resource: 'tile-a' }).reason, 'UnsupportedCapability');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/timeline'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.tiles-picker/timeline';
  // Input to a mirror (or any tile), its rows and the tile layout are named as protected and never run.
  for (const controlId of TILES_PROTECTED_CONTROLS) for (const control of ['control-focus-a', 'control-composer-b', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, text: 'hello' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.thread-tile' }, { controlId: 'tile-send' }, { text: 'hello' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0])); assert.equal(calls[0].resource, 'tile-b');
});

test('The picker binds the draft and its revision; a package never moves the draft without a fresh host choice', () => {
  let live = fixture('picker-state'); const auth = authority({ owner: 'sample.tiles-picker/toolbar' }), calls = [];
  const slot = createPickerControls(live, auth.owner, () => live, () => auth, action => calls.push(action));
  // Another draft, an edited draft (a new revision) or another current project is another target.
  for (const key of ['task', 'revision', 'project']) { live = { ...fixture('picker-state'), [key]: key === 'revision' ? 6 : 'foreign' }; assert.equal(slot.dispatch(fixture('picker-action')).reason, 'StaleContext', key); }
  live = fixture('picker-state');
  for (const controlId of PICKER_PROTECTED_CONTROLS) assert.equal(slot.dispatch({ ...fixture('picker-action'), controlId, projectId: 'project-b' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ draft: 'text' }, { projectId: 'project-b' }, { search: 'orbit' }]) assert.equal(slot.dispatch({ ...fixture('picker-action'), ...change }).reason, 'InvalidArguments');
  // A project that left the list is another target.
  const select = { ...fixture('picker-action'), control: 'control-select-b', controlId: 'picker-select', resource: 'project-b', requestId: 'move' };
  live = { ...fixture('picker-state'), controls: fixture('picker-state').controls.filter(control => control.resource !== 'project-b') }; assert.equal(slot.dispatch(select).reason, 'StaleContext'); live = fixture('picker-state');
  for (const state of [fixture('picker-state')]) {
    for (const control of state.controls.filter(item => TILES_PICKER_CHOICE_CONTROLS.includes(item.controlId))) {
      const guarded = createPickerControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized move'));
      assert.equal(guarded.dispatch({ ...fixture('picker-action'), control: control.id, controlId: control.controlId, resource: control.resource }).reason, 'PermissionDenied', control.id);
    }
  }
  assert.deepEqual(slot.dispatch(select), { ok: true }); assert.equal(slot.dispatch(select).reason, 'AlreadyApplied');
  // The toggle and Open project… open the host's own picker or folder dialog: no choice needed, the user acts there.
  const opened = [], plain = createPickerControls(fixture('picker-state'), 'owner', fixture.bind(null, 'picker-state'), () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of fixture('picker-state').controls.filter(item => !TILES_PICKER_CHOICE_CONTROLS.includes(item.controlId))) assert.deepEqual(plain.dispatch({ ...fixture('picker-action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['picker-toggle', 'picker-open']);
  // Closing a tile also needs the choice; focusing one is an ordinary thread switch.
  const tiles = fixture('state'), focused = [], tileSlot = createTilesControls(tiles, 'owner', () => tiles, () => authority({ owner: 'owner', userChoice: false }), action => focused.push(action.controlId));
  for (const control of tiles.controls.filter(item => !item.hidden)) tileSlot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id });
  assert.deepEqual(focused, ['tile-focus', 'tile-focus', 'tile-composer']);
  for (const id of [...TILES_PICKER_PROTECTED.map(([id]) => id), ...TILES_PROTECTED_CONTROLS, ...PICKER_PROTECTED_CONTROLS]) { assert.ok(!schema.$defs.tilesControlId.enum.includes(id), id); assert.ok(!schema.$defs.projectPickerControlId.enum.includes(id), id); }
  assert.deepEqual(TILES_PICKER_CHOICE_CONTROLS, ['tile-close', 'picker-select']);
  assert.equal(calls.length, 1); assert.equal(calls[0].resource, 'project-b');
});
