import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComposerControls, snapshotComposer, COMPOSER_CONTROL_IDS, COMPOSER_ENTRY_CONTROLS, COMPOSER_PROTECTED_CONTROLS, COMPOSER_REGISTRY } from '../src/extensions/composer-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { COMPOSER_ACTION_SURFACES, COMPOSER_TRAY_CONTROLS, COMPOSER_TRAY_PINNED, COMPOSER_TRAY_FIXED, COMPOSER_MODEL_ENTRIES, COMPOSER_STEER_PARTS, COMPOSER_STEER_PINNED, COMPOSER_PERMISSION_MODES, COMPOSER_PROTECTED, COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION, COMPOSER_PERMISSIONS_LOCATION, COMPOSER_PROTECTED_LOCATION, THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { BUILTIN_PROVIDER_IDS } from '../src/extensions/provider-identity.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/composer-controls/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.composer-controls/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.composer.model', 'panda.composer.permissions', 'panda.composer.steering', 'panda.menus.permissions', 'src/main.ts#mode', 'src/main.ts#model', 'src/main.ts#steer', 'src/main.ts#steer-clear', 'src/main.ts#steer-edit'];
const ACTIONS = [...COMPOSER_ACTION_SURFACES];

test('Composer controls registry: every owned member has public locations and operations, and the ledger closes exactly the nine gaps', () => {
  assert.deepEqual(COMPOSER_REGISTRY.map(entry => entry.member), ['panda.composer.tray', 'panda.composer.model', 'panda.composer.permissions', 'panda.composer.steering', 'panda.menus.permissions']);
  for (const entry of COMPOSER_REGISTRY) {
    assert.ok(entry.actions && entry.reason.length > 40, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
  }
  // Every ledger member the registry names exists in its family with the source anchor T60 checked.
  for (const member of COMPOSER_REGISTRY.map(entry => entry.member)) {
    const [family, local] = [member.slice(0, member.lastIndexOf('.')), member.slice(member.lastIndexOf('.') + 1)];
    assert.ok(ledger.families.find(item => item.id === family).members.some(([id]) => id === local), member);
  }
  assert.deepEqual([...COMPOSER_CONTROL_IDS], schema.$defs.composerControlId.enum);
  const row = ledger.composerCoverage['panda.composer.controls'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.composer.controls'); assert.equal(row.lead, 'T60B');
  assert.deepEqual(row.closes, GAPS);
  assert.deepEqual(row.members, [...COMPOSER_CONTROL_IDS]); assert.deepEqual(row.modelEntries, COMPOSER_MODEL_ENTRIES.map(([id]) => id));
  assert.deepEqual(row.permissionModes, COMPOSER_PERMISSION_MODES.map(([id]) => id)); assert.deepEqual(row.protected, COMPOSER_PROTECTED.map(([id]) => id));
  assert.deepEqual(row.protectedControls, [...COMPOSER_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.composer.controls').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.composer.controls').tests.includes('tests/extensions-composer-controls-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-composer-controls-coverage\.spec\.ts/);
  // The host file that draws the fresh choice is inventoried with its named menu.
  assert.ok(ledger.sourceInventory.some(([owner]) => owner === 'src/extensions/composer-host.ts'));
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'composer-extension-entry' && owner === 'src/extensions/composer-host.ts'));
  // showModel, showMode and the steer bar pass an extension surface with the captured task, draft or mode.
  const main = read('../src/main.ts');
  assert.match(main, /permissionsSurface\(\{ projectId: s\.projectId \|\| undefined, sessionId: s\.id \}, s\.mode, generation/);
  assert.match(main, /modelActions\(host, \{ projectId: selected\.projectId \|\| undefined, sessionId: selected\.id \}/);
  assert.match(main, /<div class="composer-steer-bar"><div class="extension-action-slot" data-composer-steer-actions><\/div>/);
  assert.match(read('../src/extensions/composer-host.ts'), /mountExtensionActions\(host, 'panda\.composer\.steering\.actions', \(\) => captured\('draft', task, \{ projectId: project, sessionId: task \}, generation\)/);
});

test('Composer controls schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const [kind, surfaceId, id] of [['draft', 'panda.composer.steering.actions', 'task-1'], ['model', 'panda.composer.model.actions', 'claude:default'], ['approval-mode', COMPOSER_PERMISSIONS_LOCATION, 'plan']]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids: [id] } }).ok, true, kind);
  }
  // Empty ids are omitted, never sent: the public context rejects empty text.
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: COMPOSER_PERMISSIONS_LOCATION, projectId: '', revision: 1, selection: { kind: 'approval-mode', ids: ['ask'] } }).ok, false);
  // The steer bar's slot is mounted by composer-host.ts with the draft context, not by the generic thread slots.
  assert.deepEqual(ACTIONS, ['panda.composer.model.actions', COMPOSER_PERMISSIONS_LOCATION, 'panda.composer.steering.actions']); assert.ok(!THREAD_ACTION_SURFACES.includes('panda.composer.steering.actions'));
  for (const location of ACTIONS) { assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  for (const location of [COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION]) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [COMPOSER_PROTECTED_LOCATION, 'panda.composer.mode', 'panda.composer.draft']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.composer.steering.controls/steer'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of ACTIONS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const location of [COMPOSER_TRAY_LOCATION, COMPOSER_MODEL_LOCATION, COMPOSER_STEER_LOCATION]) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: COMPOSER_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  const tray = catalog.listItems({ location: COMPOSER_TRAY_LOCATION, limit: 100 }).items;
  assert.deepEqual(tray.map(item => item.id).sort(), COMPOSER_TRAY_CONTROLS.map(([id]) => `${COMPOSER_TRAY_LOCATION}/${id}`).sort());
  for (const item of tray) {
    const id = item.id.split('/')[1];
    assert.deepEqual(item.supportedOperations, COMPOSER_TRAY_PINNED[id] ? ['inspect', 'reorder'] : COMPOSER_TRAY_FIXED[id] ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], id);
    if (COMPOSER_TRAY_PINNED[id] || COMPOSER_TRAY_FIXED[id]) assert.match(item.label, / — .{20,}/);
  }
  assert.deepEqual(Object.keys(COMPOSER_TRAY_PINNED), ['model', 'mode']);
  const steer = catalog.listItems({ location: COMPOSER_STEER_LOCATION, limit: 100 }).items;
  assert.deepEqual(steer.map(item => item.id).sort(), COMPOSER_STEER_PARTS.map(([id]) => `${COMPOSER_STEER_LOCATION}/${id}`).sort());
  for (const item of steer) assert.deepEqual(item.supportedOperations, COMPOSER_STEER_PINNED[item.id.split('/')[1]] ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder']);
  const entries = catalog.listItems({ location: COMPOSER_MODEL_LOCATION, limit: 100 }).items;
  assert.deepEqual(entries.map(item => item.id.split('/')[1]).sort(), ['recent', 'teams', ...BUILTIN_PROVIDER_IDS].sort());
  for (const item of entries) assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder']);
  // Approval modes are listed with their reason and are inspect-only, like every protected behavior.
  const modes = catalog.listItems({ location: COMPOSER_PERMISSIONS_LOCATION, limit: 100 }).items;
  assert.deepEqual(modes.map(item => item.id.split('/')[1]).sort(), ['ask', 'auto', 'full', 'plan', 'review']);
  for (const item of [...modes, ...catalog.listItems({ location: COMPOSER_PROTECTED_LOCATION, limit: 100 }).items]) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // A contributed Permissions row reorders and hides like any contribution; the modes do not.
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.composer-controls/model', 'panda.composer.model.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-controls/permissions', COMPOSER_PERMISSIONS_LOCATION, ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-controls/steer', 'panda.composer.steering.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const item of [...tray, ...steer, ...entries].filter(item => item.supportedOperations.includes('hide'))) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
  const ids = COMPOSER_TRAY_CONTROLS.slice(0, 5).map(([id]) => `${COMPOSER_TRAY_LOCATION}/${id}`); layout.move(COMPOSER_TRAY_LOCATION, ids, { id: ids[4], target: ids[0], side: 'before' }); assert.equal(layout.order(COMPOSER_TRAY_LOCATION, ids)[0], ids[4]);
  const rail = entries.map(item => item.id); layout.move(COMPOSER_MODEL_LOCATION, rail, { id: `${COMPOSER_MODEL_LOCATION}/codex`, target: `${COMPOSER_MODEL_LOCATION}/claude`, side: 'before' }); assert.ok(layout.order(COMPOSER_MODEL_LOCATION, rail).indexOf(`${COMPOSER_MODEL_LOCATION}/codex`) < layout.order(COMPOSER_MODEL_LOCATION, rail).indexOf(`${COMPOSER_MODEL_LOCATION}/claude`));
  assert.throws(() => layout.move(COMPOSER_PROTECTED_LOCATION, ['panda.composer.protected/draft', 'panda.composer.protected/approvals'], { id: 'panda.composer.protected/approvals', target: 'panda.composer.protected/draft', side: 'before' }));
  // Bounded JSON only: no draft text, model, selectors or IPC cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('composerPresentation', state).ok, true); assert.equal(validateContract('composerAction', fixture('action')).ok, true);
  for (const change of [{ controls: Array(65).fill(state.controls[0]) }, { selector: '#prompt' }, { text: 'draft text' }, { model: 'claude' }, { window: 'tray' }, { contractVersion: 2 }, { mode: 'yolo' }, { draft: 'draft text' }, { task: 'x'.repeat(257) }]) assert.equal(validateContract('composerPresentation', { ...state, ...change }).ok, false);
  for (const extra of [{ label: 'Steer' }, { value: 'plan' }]) assert.equal(validateContract('composerPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotComposer({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});

test('Composer controls bind owner/window/mount/project/task/revision, control resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createComposerControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Switching task A to B never retargets: another control or draft resource is another target.
  for (const change of [{ control: 'foreign' }, { controlId: 'steer-clear' }, { resource: 'draft-b' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.controlId !== 'steer') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.composer-controls/toolbar';
  // A mode or model change (and Send, Stop, approvals) is named as protected and never runs, whatever else the request says.
  for (const controlId of COMPOSER_PROTECTED_CONTROLS) for (const control of ['control-mode', 'control-model', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, value: 'full' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '#prompt' }, { controlId: 'reorder' }, { text: 'draft' }, { mode: 'full' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Composer controls never steer or clear a draft without a fresh host choice, and no protected behavior is a public control', () => {
  for (const controlId of COMPOSER_ENTRY_CONTROLS) {
    const state = fixture('state'), slot = createComposerControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    const control = state.controls.find(item => item.controlId === controlId);
    assert.equal(slot.dispatch({ ...fixture('action'), control: control.id, controlId, resource: control.resource }).reason, 'PermissionDenied', controlId);
  }
  // Opening a picker or menu needs no choice: the user makes it there.
  const state = fixture('state'), opened = [];
  const slot = createComposerControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of state.controls.filter(item => !COMPOSER_ENTRY_CONTROLS.includes(item.controlId))) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['model', 'mode', 'council', 'steer-edit']);
  for (const id of [...COMPOSER_PROTECTED.map(([id]) => id), ...COMPOSER_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.composerControlId.enum.includes(id), id);
  assert.deepEqual(COMPOSER_ENTRY_CONTROLS, ['steer', 'steer-clear']);
});
