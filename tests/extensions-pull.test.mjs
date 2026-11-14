import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPullPresentation, snapshotPull, PULL_CONSENT_CONTROLS, PULL_ENTRY_CONTROLS } from '../src/extensions/pull.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { PULL_CONTROLS, PULL_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/pull/${name}.json`, import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.pull/sections', active: true, granted: true, pullControl: true, userChoice: true, ...changes });
test('Pull schema, package, selected recipe, bounded catalog, protected merge location and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'merge'] }, { presentation: 'cards' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const protectedLayout = structuredClone(manifest); protectedLayout.contributes.layouts[0].location = PULL_PROTECTED_LOCATION;
  assert.equal(validateContract('packages', [protectedLayout]).ok, false);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.pull', [provider]), undefined); selection.select('panda.pull', provider.id, [provider]); assert.equal(selection.resolve('panda.pull', [provider]), provider); assert.equal(selection.resolve('panda.pull', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.pull' }).items.map(item => item.supportedItemTypes), [['tabs-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: PULL_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const [location, controls] of Object.entries(PULL_CONTROLS)) {
    const items = catalog.listItems({ location }).items; assert.deepEqual(items.map(item => item.id), controls.map(([id]) => `${location}/${id}`).sort());
    if (location === PULL_PROTECTED_LOCATION) { for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect']); continue; }
    for (const item of items) { assert.ok(item.supportedOperations.includes('hide')); layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  for (const change of [{ files: Array(501).fill(fixture('state').files[0]) }, { controls: Array(257).fill(fixture('state').controls[0]) }, { title: 'x'.repeat(201) }, { selector: 'body' }, { window: 'tray' }, { contractVersion: 2 }, { merge: 'confirmed' }, { section: 'checks' }]) assert.equal(validateContract('pullPresentation', { ...fixture('state'), ...change }).ok, false);
  assert.throws(() => snapshotPull({ ...fixture('state'), files: Array(2).fill(fixture('state').files[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-pull-coverage\.spec\.ts/);
});
test('Pull binds owner/window/project/task/repository/pull/base/head/section/revision, offline, busy and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createPullPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.files[0]));
  for (const key of ['context', 'project', 'task', 'repository', 'pull', 'base', 'head', 'section', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'section' ? 'overview' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { resource: 'foreign' }, { controlId: 'refresh' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  for (const [field, reason] of [['busy', 'Busy'], ['offline', 'Offline']]) { live = { ...fixture('state'), [field]: true }; assert.equal(slot.dispatch(fixture('action')).reason, reason); } live = fixture('state');
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], enabled: false }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/sections'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.pull/sections';
  for (const change of [{ selector: 'body' }, { controlId: 'merge-confirm' }, { controlId: 'merge' }, { window: 'tray' }, { value: 'rebase' }, { method: 'rebase' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});
test('Pull metadata never grants task-link, merge-state or external-entry authority', () => {
  for (const controlId of [...PULL_CONSENT_CONTROLS, ...PULL_ENTRY_CONTROLS]) {
    const state = fixture('state'); state.controls[0].controlId = controlId;
    const slot = createPullPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', pullControl: false, userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'PermissionDenied');
  }
  assert.ok(!PULL_CONSENT_CONTROLS.includes('merge-confirm') && !validateContract('pullAction', { ...fixture('action'), controlId: 'merge-confirm' }).ok);
});
