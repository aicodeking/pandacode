import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createAttachControls, snapshotAttach, ATTACH_CONTROL_IDS, ATTACH_CHOICE_CONTROLS, ATTACH_PROTECTED_CONTROLS, ATTACH_REGISTRY } from '../src/extensions/composer-attach-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { ATTACH_ACTION_SURFACES, ATTACH_MENU_ENTRIES, ATTACH_WAKE_MENU_ENTRIES, ATTACH_RECIPES_CONTROLS, ATTACH_WAKE_CONTROLS, ATTACH_PINNED, ATTACH_FIXED, ATTACH_PROTECTED, ATTACH_MENU_LOCATION, ATTACH_WAKE_MENU_LOCATION, ATTACH_RECIPES_LOCATION, ATTACH_WAKE_LOCATION, ATTACH_PROTECTED_LOCATION, THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/composer-attach/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.composer-attach/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.menus.attach', 'panda.composer.recipes', 'panda.composer.wake', 'panda.menus.wake', 'src/main.ts#attach', 'src/main.ts#attach-file', 'src/recipes.ts', 'src/schedules-thread.ts'];
const MENUS = [[ATTACH_MENU_LOCATION, ATTACH_MENU_ENTRIES], [ATTACH_WAKE_MENU_LOCATION, ATTACH_WAKE_MENU_ENTRIES]];
const CONTROLS = [[ATTACH_RECIPES_LOCATION, ATTACH_RECIPES_CONTROLS], [ATTACH_WAKE_LOCATION, ATTACH_WAKE_CONTROLS]];

test('Composer attach registry: each owned member has public locations, operations and an extension hook in its source, and the ledger closes exactly the eight gaps', () => {
  assert.deepEqual(ATTACH_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.menus.attach', 'src/main.ts'], ['panda.composer.recipes', 'src/recipes.ts'], ['panda.composer.wake', 'src/schedules-thread.ts'], ['panda.menus.wake', 'src/schedules-thread.ts']]);
  for (const entry of ATTACH_REGISTRY) {
    assert.ok(entry.actions && entry.order && entry.hide && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    const [family, local] = [entry.member.slice(0, entry.member.lastIndexOf('.')), entry.member.slice(entry.member.lastIndexOf('.') + 1)];
    assert.ok(ledger.families.find(item => item.id === family).members.some(([id, owner]) => id === local && owner === entry.source), entry.member);
    // T60's audit found no extension hook in recipes.ts and schedules-thread.ts; each now carries its slot and hook.
    assert.match(read(`../${entry.source}`), /extension/i, entry.source);
  }
  assert.deepEqual([...ATTACH_CONTROL_IDS], schema.$defs.composerAttachControlId.enum);
  const row = ledger.composerCoverage['panda.composer.attach'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.composer.attach'); assert.equal(row.lead, 'T60D');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: T60B's composer controls and T60C's panels keep their own keys.
  for (const other of ['panda.composer.controls', 'panda.composer.panels']) assert.equal(ledger.composerCoverage[other].closes.filter(key => GAPS.includes(key)).length, 0, other);
  assert.deepEqual(row.members, [...ATTACH_CONTROL_IDS]);
  assert.deepEqual(row.attachEntries, ATTACH_MENU_ENTRIES.map(([id]) => id)); assert.deepEqual(row.wakeMenuEntries, ATTACH_WAKE_MENU_ENTRIES.map(([id]) => id));
  assert.deepEqual(row.recipeControls, ATTACH_RECIPES_CONTROLS.map(([id]) => id)); assert.deepEqual(row.wakeControls, ATTACH_WAKE_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.protected, ATTACH_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...ATTACH_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.composer.attach').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.composer.attach').tests.includes('tests/extensions-attach-wake-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-attach-wake-coverage\.spec\.ts/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/composer-attach-host.ts'), ['src/extensions/composer-attach-host.ts', [], 0, 1]);
  const menus = ledger.families.find(family => family.id === 'panda.menus').members;
  assert.ok(menus.some(([id, owner]) => id === 'composer-attach-extension-entry' && owner === 'src/extensions/composer-attach-host.ts'));
  // The ledger's own Attach and wake-up menu rows stay anchored to their sources.
  assert.ok(menus.some(([id, owner, anchor]) => id === 'attach' && owner === 'src/main.ts' && read('../src/main.ts').includes(anchor)));
  assert.ok(menus.some(([id, owner, anchor]) => id === 'wake' && owner === 'src/schedules-thread.ts' && read('../src/schedules-thread.ts').includes(anchor)));
  // The Attach menu, the recipes dialog and the wake-ups read their presentation from the adapter.
  const main = read('../src/main.ts');
  assert.match(main, /showChoices\(anchor, \{ title: 'Attach', width: 340, actions: true, \.\.\.attachMenuSurface\(\), items:/);
  assert.match(main, /extension: \(\) => composerAttach\?\.recipesLayout\(s\.id\)/);
  assert.match(main, /extension: \(\) => composerAttach\?\.wakeLayout\(\)/);
  assert.match(read('../src/schedules-thread.ts'), /host!\.showChoices\(anchor, \{ title: schedule\.title, actions: true, width: 240, items, \.\.\.\(extensionSurface \? \{ extensionSurface \} : \{\}\)/);
});

test('Composer attach schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const [kind, surfaceId, id] of [['draft', ATTACH_MENU_LOCATION, 'task-1'], ['recipe', 'panda.composer.recipes.actions', 'project:review-diff'], ['task', 'panda.composer.wake.actions', 'task-1'], ['schedule', ATTACH_WAKE_MENU_LOCATION, 'sched-1']]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids: [id] } }).ok, true, kind);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: ATTACH_WAKE_MENU_LOCATION, revision: 1, selection: { kind: 'wake-up', ids: ['sched-1'] } }).ok, false);
  // The slots and menus are opened by composer-attach-host.ts with their own contexts, not by the generic thread slots.
  assert.deepEqual([...ATTACH_ACTION_SURFACES], ['panda.composer.attach.actions', 'panda.composer.recipes.actions', 'panda.composer.wake.actions', 'panda.composer.wake.context']);
  for (const location of ATTACH_ACTION_SURFACES) { assert.ok(!THREAD_ACTION_SURFACES.includes(location)); assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  for (const [location] of CONTROLS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [ATTACH_PROTECTED_LOCATION, 'panda.composer.attach', 'panda.composer.recipes']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.composer.wake.context/remove'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of ATTACH_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const [location] of CONTROLS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: ATTACH_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  // Menu entries keep their slot when pinned; control rows still reorder when pinned and hide in place when fixed.
  for (const [location, entries] of MENUS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), entries.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) { assert.deepEqual(item.supportedOperations, ATTACH_PINNED[item.id] ? ['inspect'] : ['inspect', 'hide', 'show', 'reorder'], item.id); if (ATTACH_PINNED[item.id]) assert.match(item.label, / — .{20,}/); }
  }
  for (const [location, controls] of CONTROLS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      assert.deepEqual(item.supportedOperations, ATTACH_PINNED[item.id] ? ['inspect', 'reorder'] : ATTACH_FIXED[item.id] ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (ATTACH_PINNED[item.id] || ATTACH_FIXED[item.id]) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(Object.keys(ATTACH_PINNED), [`${ATTACH_MENU_LOCATION}/files`, `${ATTACH_WAKE_MENU_LOCATION}/remove`, `${ATTACH_RECIPES_LOCATION}/run`, `${ATTACH_WAKE_LOCATION}/in-60`]);
  const protectedItems = catalog.listItems({ location: ATTACH_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), ATTACH_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // Delete, Save, Cancel and Schedule are never layout items.
  const layoutIds = [...MENUS, ...CONTROLS].flatMap(([location, controls]) => controls.map(([id]) => `${location}/${id}`));
  for (const id of ['delete', 'save', 'cancel', 'schedule', 'detach']) assert.ok(!layoutIds.some(item => item.endsWith(`/${id}`)), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.composer-attach/attach', 'panda.composer.attach.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-attach/recipe', 'panda.composer.recipes.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-attach/schedule', 'panda.composer.wake.context', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-attach/wake', 'panda.composer.wake.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const id of layoutIds.filter(id => !ATTACH_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const recipe = ['edit', 'run'].map(id => `${ATTACH_RECIPES_LOCATION}/${id}`); layout.move(ATTACH_RECIPES_LOCATION, recipe, { id: recipe[1], target: recipe[0], side: 'before' }); assert.equal(layout.order(ATTACH_RECIPES_LOCATION, recipe)[0], recipe[1]);
  const entries = ['folder', 'project', 'wake'].map(id => `${ATTACH_MENU_LOCATION}/${id}`); layout.move(ATTACH_MENU_LOCATION, entries, { id: entries[2], target: entries[0], side: 'before' }); assert.equal(layout.order(ATTACH_MENU_LOCATION, entries)[0], entries[2]);
  // Bounded JSON only: no draft text, paths, recipe steps, prompts, selectors or IPC cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('composerAttachPresentation', state).ok, true); assert.equal(validateContract('composerAttachAction', fixture('action')).ok, true);
  for (const change of [{ controls: Array(129).fill(state.controls[0]) }, { schedules: Array(65).fill('schedule') }, { selector: '#prompt' }, { text: 'draft text' }, { paths: ['/tmp/a'] }, { steps: [] }, { window: 'tray' }, { contractVersion: 2 }, { attachments: 65 }, { attachments: -1 }, { recipe: 'x'.repeat(257) }]) assert.equal(validateContract('composerAttachPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: 'Run' }, { path: '/tmp/a' }]) assert.equal(validateContract('composerAttachPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotAttach({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});

test('Composer attach binds owner/window/mount/project/task/revision, draft, file, recipe and wake-up resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createAttachControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another recipe, an edited recipe (a new resource) or another control is another target; so is a deleted recipe.
  for (const change of [{ control: 'foreign' }, { controlId: 'recipe-edit' }, { resource: 'recipe-b' }, { resource: 'recipe-a-edited' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.resource !== 'recipe-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  // A paused, snoozed or edited wake-up is a new resource for every row control.
  const run = fixture('state').controls.find(control => control.controlId === 'wake-run');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => control.resource === 'schedule-a' ? { ...control, resource: 'schedule-a-paused' } : control) };
  assert.equal(slot.dispatch({ ...fixture('action'), control: run.id, controlId: run.controlId, resource: 'schedule-a', requestId: 'wake' }).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.composer-attach/toolbar';
  // Attaching paths, removing attachments, deleting or saving recipes and creating, removing or changing wake-ups are
  // named as protected and never run.
  for (const controlId of ATTACH_PROTECTED_CONTROLS) for (const control of ['control-run', 'control-wake-run', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, path: '/tmp/a' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '#prompt' }, { controlId: 'attach-drop' }, { text: 'draft' }, { path: '/tmp/a' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Composer attach never changes the draft, queues a recipe or changes a wake-up without a fresh host choice, and no protected behavior is a public control', () => {
  const state = fixture('state');
  for (const control of state.controls.filter(item => ATTACH_CHOICE_CONTROLS.includes(item.controlId))) {
    const slot = createAttachControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource }).reason, 'PermissionDenied', control.controlId);
  }
  // Opening the Attach menu, picking, creating or editing a recipe, and the strip's disclosure, + and More need no
  // choice: the user acts there.
  const opened = [], slot = createAttachControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of state.controls.filter(item => !ATTACH_CHOICE_CONTROLS.includes(item.controlId))) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['attach-open', 'recipe-pick', 'recipe-new', 'recipe-edit', 'wake-expand', 'wake-add', 'wake-more']);
  for (const id of [...ATTACH_PROTECTED.map(([id]) => id), ...ATTACH_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.composerAttachControlId.enum.includes(id), id);
  assert.deepEqual(ATTACH_CHOICE_CONTROLS, ['attach-file', 'recipe-run', 'wake-run', 'wake-enable']);
});
