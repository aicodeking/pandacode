import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMoodboardPresentation, snapshotMoodboard, MOODBOARD_CONSENT_CONTROLS, MOODBOARD_ENTRY_CONTROLS, MOODBOARD_DRAFT_SAFE_CONTROLS } from '../src/extensions/moodboard.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection, validSlotProps } from '../src/extensions/component-slot.ts';
import { MOODBOARD_CONTROLS, MOODBOARD_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/moodboards/${name}.json`, import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.moodboards/images-first', active: true, granted: true, moodboardControl: true, userChoice: true, ...changes });
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));

test('Moodboard schema, package, selected recipe, bounded catalog, protected file access and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'files'] }, { presentation: 'cards' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  assert.equal(validSlotProps({ contractVersion: 1, slot: 'panda.moodboards', context: 'c', revision: 0, objects: [], state: {} }), false);
  const protectedLayout = structuredClone(manifest); protectedLayout.contributes.layouts[0].location = MOODBOARD_PROTECTED_LOCATION;
  assert.equal(validateContract('packages', [protectedLayout]).ok, false);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.moodboards', [provider]), undefined); selection.select('panda.moodboards', provider.id, [provider]); assert.equal(selection.resolve('panda.moodboards', [provider]), provider); assert.equal(selection.resolve('panda.moodboards', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.moodboards' }).items.map(item => item.supportedItemTypes), [['viewer-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: MOODBOARD_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const location of ['panda.moodboards.actions', 'panda.moodboards.context']) assert.ok(catalog.listSurfaces({ location }).items[0].supportedOperations.includes('contribute'));
  for (const [location, controls] of Object.entries(MOODBOARD_CONTROLS)) {
    const items = catalog.listItems({ location }).items; assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    if (location === MOODBOARD_PROTECTED_LOCATION) { for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect']); continue; }
    for (const item of items) { assert.ok(item.supportedOperations.includes('hide')); layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  // The public enum names every eligible control and no protected one.
  const enumIds = schema.$defs.moodboardControlId.enum;
  for (const [id] of MOODBOARD_CONTROLS[MOODBOARD_PROTECTED_LOCATION]) assert.ok(!enumIds.includes(id));
  for (const location of ['panda.moodboards.controls', 'panda.moodboards.context']) for (const [id] of MOODBOARD_CONTROLS[location]) assert.ok(enumIds.includes(id));
  for (const change of [{ controls: Array(257).fill(fixture('state').controls[0]) }, { boardName: 'x'.repeat(121) }, { imageCount: 65 }, { boardCount: -1 }, { selector: 'body' }, { path: '/images/a.png' }, { dataUrl: 'data:image/png;base64,' }, { caption: 'secret' }, { window: 'tray' }, { contractVersion: 2 }, { draft: 'yes' }]) assert.equal(validateContract('moodboardPresentation', { ...fixture('state'), ...change }).ok, false);
  // Contributed toolbar/context entries evaluate their conditions against a moodboard or image selection.
  for (const kind of ['moodboard', 'moodboard-image']) assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.moodboards.context', revision: 1, projectId: 'p', selection: { kind, ids: ['handle'] } }).ok, true);
  assert.throws(() => snapshotMoodboard({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-moodboards-coverage\.spec\.ts/);
  const row = ledger.moodboardCoverage['panda.project.moodboards'];
  assert.deepEqual(row.members, enumIds); assert.deepEqual(row.protected, MOODBOARD_CONTROLS[MOODBOARD_PROTECTED_LOCATION].map(([id]) => id));
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.moodboards' && adapter.tests.includes('tests/extensions-moodboards-coverage.spec.ts')));
});

test('Moodboard binds owner/window/project/board/image/destination/revision, loading, busy and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createMoodboardPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'board', 'image', 'destination', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { resource: 'foreign' }, { controlId: 'image-remove' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), loading: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); live = fixture('state');
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], enabled: false }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/images-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.moodboards/images-first';
  for (const change of [{ selector: 'body' }, { controlId: 'create-confirm' }, { controlId: 'delete-confirm' }, { controlId: 'file-picker' }, { controlId: 'file-drop' }, { path: '/tmp/a.png' }, { paths: ['/tmp/a.png'] }, { dataUrl: 'data:image/png;base64,AA==' }, { caption: 'x' }, { name: 'x' }, { window: 'tray' }, { board: 7 }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Moodboard metadata never grants file, removal or attach authority; drafts and loads hold redrawing controls', () => {
  for (const controlId of new Set([...MOODBOARD_CONSENT_CONTROLS, ...MOODBOARD_ENTRY_CONTROLS])) {
    const state = fixture('state'); state.controls[0].controlId = controlId;
    const slot = createMoodboardPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', moodboardControl: false, userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), controlId, requestId: controlId }).reason, 'PermissionDenied');
  }
  // Consent alone is not a fresh user choice, and a fresh choice alone is not consent.
  for (const auth of [authority({ owner: 'owner', userChoice: false }), authority({ owner: 'owner', moodboardControl: false })]) {
    const state = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], controlId: 'attach' }] };
    assert.equal(createMoodboardPresentation(state, 'owner', () => state, () => auth, () => assert.fail('attach without both')).dispatch({ ...fixture('action'), controlId: 'attach' }).reason, 'PermissionDenied');
  }
  const controls = ['board-select', 'board-new', 'image-caption', 'image-remove', 'preview-close'];
  const draft = { ...fixture('state'), draft: true, controls: controls.map(controlId => ({ id: `${controlId}-control`, controlId, resource: 'r', enabled: true })) }, calls = [];
  const slot = createMoodboardPresentation(draft, 'owner', () => draft, () => authority({ owner: 'owner' }), action => calls.push(action.controlId));
  for (const controlId of controls) {
    const result = slot.dispatch({ ...fixture('action'), control: `${controlId}-control`, resource: 'r', controlId, requestId: controlId });
    assert.deepEqual(result, MOODBOARD_DRAFT_SAFE_CONTROLS.includes(controlId) ? { ok: true } : { ok: false, reason: 'Busy' });
  }
  assert.deepEqual(calls, ['board-new', 'image-caption', 'preview-close']);
  const loading = { ...draft, draft: false, loading: true };
  const during = createMoodboardPresentation(loading, 'owner', () => loading, () => authority({ owner: 'owner' }), action => calls.push(action.controlId));
  assert.equal(during.dispatch({ ...fixture('action'), control: 'board-select-control', resource: 'r', controlId: 'board-select', requestId: 'load-select' }).reason, 'Busy');
  assert.deepEqual(during.dispatch({ ...fixture('action'), control: 'preview-close-control', resource: 'r', controlId: 'preview-close', requestId: 'load-close' }), { ok: true });
});
