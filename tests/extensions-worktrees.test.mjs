import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createWorktreePresentation, snapshotWorktree, WORKTREE_CONSENT_CONTROLS, WORKTREE_ENTRY_CONTROLS, WORKTREE_NETWORK_CONTROLS } from '../src/extensions/worktree.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { WORKTREE_CONTROLS, WORKTREE_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/worktree/${name}.json`, import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.worktree/branch-first', active: true, granted: true, branchControl: true, userChoice: true, ...changes });
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));

test('Worktree schema, package, selected recipe, bounded catalog, protected confirmations and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'git'] }, { presentation: 'tabs-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const protectedLayout = structuredClone(manifest); protectedLayout.contributes.layouts[0].location = WORKTREE_PROTECTED_LOCATION;
  assert.equal(validateContract('packages', [protectedLayout]).ok, false);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.worktree', [provider]), undefined); selection.select('panda.worktree', provider.id, [provider]); assert.equal(selection.resolve('panda.worktree', [provider]), provider); assert.equal(selection.resolve('panda.worktree', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.worktree' }).items.map(item => item.supportedItemTypes), [['controls-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: WORKTREE_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const location of ['panda.worktree.actions', 'panda.worktree.context']) assert.ok(catalog.listSurfaces({ location }).items[0].supportedOperations.includes('contribute'));
  for (const [location, controls] of Object.entries(WORKTREE_CONTROLS)) {
    const items = catalog.listItems({ location }).items; assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    if (location === WORKTREE_PROTECTED_LOCATION) { for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect']); continue; }
    for (const item of items) { assert.ok(item.supportedOperations.includes('hide')); layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  for (const change of [{ controls: Array(65).fill(fixture('state').controls[0]) }, { branchName: 'x'.repeat(121) }, { selector: 'body' }, { path: '/repo' }, { window: 'tray' }, { contractVersion: 2 }, { checkout: 'deleted' }, { pending: 'delete' }, { form: 'cleanup' }, { linked: { issue: false } }]) assert.equal(validateContract('worktreePresentation', { ...fixture('state'), ...change }).ok, false);
  assert.throws(() => snapshotWorktree({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-worktrees-coverage\.spec\.ts/);
  const row = ledger.worktreeCoverage['panda.project.worktree'];
  assert.deepEqual(row.members, JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8')).$defs.worktreeControlId.enum);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.worktree' && adapter.tests.includes('tests/extensions-worktrees-coverage.spec.ts')));
});

test('Worktree binds owner/window/project/task/repository/branch/base/worktree/revision, busy, offline and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createWorktreePresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'repository', 'branch', 'base', 'worktree', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { resource: 'foreign' }, { controlId: 'switch-default' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  // Local git keeps working offline; only network entries are refused.
  live = { ...fixture('state'), offline: true }; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'offline-local' }).ok, true); live = fixture('state');
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], enabled: false }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/branch-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.worktree/branch-first';
  for (const change of [{ selector: 'body' }, { controlId: 'worktree-confirm' }, { controlId: 'cleanup-confirm' }, { controlId: 'delete-branch' }, { branchName: 'main' }, { path: '/repo' }, { window: 'tray' }, { base: 7 }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  assert.equal(calls.length, 2); assert.ok(Object.isFrozen(calls[0]));
});

test('Worktree metadata never grants switch, cleanup, settle or external-entry authority; only the cleanup cancel acts on an open offer', () => {
  for (const controlId of new Set([...WORKTREE_CONSENT_CONTROLS, ...WORKTREE_ENTRY_CONTROLS])) {
    const state = fixture('state'); state.controls[0].controlId = controlId;
    const slot = createWorktreePresentation(state, 'owner', () => state, () => authority({ owner: 'owner', branchControl: false, userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'PermissionDenied');
  }
  for (const controlId of WORKTREE_NETWORK_CONTROLS) {
    const state = { ...fixture('state'), offline: true, controls: [{ ...fixture('state').controls[0], controlId }] };
    assert.equal(createWorktreePresentation(state, 'owner', () => state, () => authority({ owner: 'owner' }), () => assert.fail('offline dispatch')).dispatch({ ...fixture('action'), controlId }).reason, 'Offline');
  }
  const offer = { ...fixture('state'), busy: true, cleanup: 'remove', controls: [{ ...fixture('state').controls[0], controlId: 'cleanup-cancel' }] }, calls = [];
  const slot = createWorktreePresentation(offer, 'owner', () => offer, () => authority({ owner: 'owner' }), action => calls.push(action));
  assert.equal(slot.dispatch({ ...fixture('action'), controlId: 'switch-other' }).reason, 'Busy');
  assert.deepEqual(slot.dispatch({ ...fixture('action'), controlId: 'cleanup-cancel' }), { ok: true }); assert.equal(calls.length, 1);
  const running = { ...offer, pending: 'cleanup' };
  assert.equal(createWorktreePresentation(running, 'owner', () => running, () => authority({ owner: 'owner' }), () => assert.fail('cancel during removal')).dispatch({ ...fixture('action'), controlId: 'cleanup-cancel' }).reason, 'Busy');
  for (const id of ['worktree-confirm', 'cleanup-confirm', 'cleanup-remove']) assert.ok(!WORKTREE_CONSENT_CONTROLS.includes(id) && !validateContract('worktreeAction', { ...fixture('action'), controlId: id }).ok);
});
