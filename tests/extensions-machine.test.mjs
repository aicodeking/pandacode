import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createMachinesPresentation, snapshotMachines, MACHINES_CONSENT_CONTROLS, MACHINES_NETWORK_CONTROLS } from '../src/extensions/machines.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection, validSlotProps } from '../src/extensions/component-slot.ts';
import { MACHINES_CONTROLS, MACHINES_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/machines/${name}.json`, import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.machines/coordination-below', active: true, granted: true, machineControl: true, userChoice: true, ...changes });
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));

test('Machines schema, package, selected recipe, bounded catalog, protected consent and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'pairing'] }, { presentation: 'cards' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  assert.equal(validSlotProps({ contractVersion: 1, slot: 'panda.machines', context: 'c', revision: 0, objects: [], state: {} }), false);
  const protectedLayout = structuredClone(manifest); protectedLayout.contributes.layouts[0].location = MACHINES_PROTECTED_LOCATION;
  assert.equal(validateContract('packages', [protectedLayout]).ok, false);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.machines', [provider]), undefined); selection.select('panda.machines', provider.id, [provider]); assert.equal(selection.resolve('panda.machines', [provider]), provider); assert.equal(selection.resolve('panda.machines', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.machines' }).items.map(item => item.supportedItemTypes), [['controls-below']]);
  assert.deepEqual(catalog.listSurfaces({ location: MACHINES_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  assert.ok(catalog.listSurfaces({ location: 'panda.machines.context' }).items[0].supportedOperations.includes('contribute'));
  for (const [location, controls] of Object.entries(MACHINES_CONTROLS)) {
    const items = catalog.listItems({ location }).items; assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    if (location === MACHINES_PROTECTED_LOCATION) { for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect']); continue; }
    for (const item of items) { assert.ok(item.supportedOperations.includes('hide')); layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  // The public enum names every eligible control and no protected one.
  const enumIds = schema.$defs.machinesControlId.enum;
  for (const [id] of MACHINES_CONTROLS[MACHINES_PROTECTED_LOCATION]) assert.ok(!enumIds.includes(id));
  for (const location of ['panda.machines.controls', 'panda.machines.targets', 'panda.machines.context']) for (const [id] of MACHINES_CONTROLS[location]) assert.ok(enumIds.includes(id));
  for (const change of [{ controls: Array(65).fill(fixture('state').controls[0]) }, { label: 'x'.repeat(81) }, { requests: 17 }, { threads: 65 }, { pending: 'pairing' }, { mode: 'remote' }, { selector: 'body' }, { deviceId: 'dev-studio' }, { fingerprint: 'f' }, { access: 'full' }, { window: 'tray' }, { contractVersion: 2 }, { busy: 'yes' }]) assert.equal(validateContract('machinesPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const kind of ['task', 'machine', 'device']) assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.machines.context', revision: 1, projectId: 'p', selection: { kind, ids: ['handle'] } }).ok, true);
  assert.throws(() => snapshotMachines({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-machine-coverage\.spec\.ts/);
  const row = ledger.machinesCoverage['panda.project.machines'];
  assert.deepEqual(row.members, enumIds); assert.deepEqual(row.protected, MACHINES_CONTROLS[MACHINES_PROTECTED_LOCATION].map(([id]) => id));
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.machines' && adapter.tests.includes('tests/extensions-machine-coverage.spec.ts')));
});

test('Machines bind owner/window/project/task/host/revision, pending work, offline and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createMachinesPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'host', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { resource: 'foreign' }, { controlId: 'target-local' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  for (const pending of ['checking', 'starting', 'reconnecting']) { live = { ...fixture('state'), busy: true, pending }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); }
  live = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], enabled: false }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/coordination-below'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.machines/coordination-below';
  for (const change of [{ selector: 'body' }, { controlId: 'behind-continue' }, { controlId: 'remote-start' }, { controlId: 'link-confirm' }, { controlId: 'pairing' }, { controlId: 'orchestration' }, { deviceId: 'dev-studio' }, { access: 'full' }, { prompt: 'run' }, { window: 'tray' }, { host: 7 }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Machines metadata never grants a target, start, link answer or stop; only the open dialog cancels while busy', () => {
  for (const controlId of MACHINES_CONSENT_CONTROLS) {
    const state = { ...fixture('state'), controls: [{ ...fixture('state').controls[0], controlId }] };
    for (const auth of [authority({ owner: 'owner', machineControl: false }), authority({ owner: 'owner', userChoice: false })]) {
      assert.equal(createMachinesPresentation(state, 'owner', () => state, () => auth, () => assert.fail('unauthorized dispatch')).dispatch({ ...fixture('action'), controlId, requestId: controlId }).reason, 'PermissionDenied');
    }
  }
  // Menus, setup, opening the Link dialog or a thread and dismissing open or close original host UI only: no consent, and they work offline.
  const controls = ['computer-menu', 'target-setup', 'start-dismiss', 'link-open', 'lineage-open'], calls = [];
  const open = { ...fixture('state'), offline: true, controls: controls.map(controlId => ({ id: `${controlId}-control`, controlId, resource: 'r', enabled: true })) };
  const slot = createMachinesPresentation(open, 'owner', () => open, () => authority({ owner: 'owner', machineControl: false }), action => calls.push(action.controlId));
  for (const controlId of controls) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: `${controlId}-control`, resource: 'r', controlId, requestId: controlId }), { ok: true });
  assert.deepEqual(calls, controls); for (const controlId of controls) assert.ok(!MACHINES_NETWORK_CONTROLS.includes(controlId));
  const offline = { ...fixture('state'), offline: true, controls: [{ id: 'stop', controlId: 'lineage-stop', resource: 'r', enabled: true }] };
  assert.equal(createMachinesPresentation(offline, 'owner', () => offline, () => authority({ owner: 'owner' }), () => assert.fail('offline dispatch')).dispatch({ ...fixture('action'), control: 'stop', resource: 'r', controlId: 'lineage-stop' }).reason, 'Offline');
  for (const [flag, cancel, other] of [['behind', 'behind-cancel', 'link-cancel'], ['linking', 'link-cancel', 'behind-cancel']]) {
    const busy = { ...fixture('state'), busy: true, [flag]: true, controls: [cancel, other, 'computer-menu'].map(controlId => ({ id: `${controlId}-control`, controlId, resource: 'r', enabled: true })) }, during = [];
    const held = createMachinesPresentation(busy, 'owner', () => busy, () => authority({ owner: 'owner' }), action => during.push(action.controlId));
    assert.equal(held.dispatch({ ...fixture('action'), control: 'computer-menu-control', resource: 'r', controlId: 'computer-menu', requestId: 'menu' }).reason, 'Busy');
    assert.equal(held.dispatch({ ...fixture('action'), control: `${other}-control`, resource: 'r', controlId: other, requestId: 'other' }).reason, 'Busy');
    assert.deepEqual(held.dispatch({ ...fixture('action'), control: `${cancel}-control`, resource: 'r', controlId: cancel, requestId: 'cancel' }), { ok: true });
    assert.deepEqual(during, [cancel]);
  }
});

