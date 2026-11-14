import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStatusPresentation, snapshotStatus, STATUS_ENTRY_CONTROLS, STATUS_RESOURCE_CONTROLS, STATUS_REGISTRY } from '../src/extensions/status-core.ts';
import { DOCK_REGISTRY } from '../src/extensions/dock-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { STATUS_CONTROLS, STATUS_PINNED_CONTROLS, STATUS_PROTECTED, STATUS_CONTROLS_LOCATION, STATUS_PROTECTED_LOCATION, CONTEXT_COMMANDS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/status/${name}.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const source = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const authority = (changes = {}) => ({ owner: 'sample.status-feedback/details-first', active: true, granted: true, userChoice: true, ...changes });

test('Status registry: every panda.status ledger member and usage has an explicit entry with its reasons, and the ledger maps it', () => {
  const status = ledger.families.find(item => item.id === 'panda.status'), agents = ledger.families.find(item => item.id === 'panda.agents');
  assert.deepEqual(STATUS_REGISTRY.map(entry => entry.member).sort(), ['items', 'jev', 'progress', 'toast', 'usage']);
  // Every member of the status family is covered, and usage is the agents family's.
  assert.deepEqual(status.members.map(([id]) => id).sort(), STATUS_REGISTRY.filter(entry => entry.family === 'panda.status').map(entry => entry.member).sort());
  assert.ok(agents.members.some(([id]) => id === 'usage'));
  for (const entry of STATUS_REGISTRY) {
    const family = entry.family === 'panda.status' ? status : agents, row = family.members.find(([id]) => id === entry.member);
    assert.match(row[3], /statusCoverage/, entry.member);
    assert.ok(entry.reason.length > 60, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    for (const action of entry.actions) assert.ok(schema.$defs.statusControlId.enum.includes(action), action);
    assert.deepEqual([...entry.parts].sort(), STATUS_CONTROLS.filter(([, , member]) => member === entry.member).map(([id]) => id).sort());
  }
  // Every public action belongs to exactly one member; the dock registry names the same family for status and usage.
  assert.deepEqual(STATUS_REGISTRY.flatMap(entry => entry.actions).sort(), [...schema.$defs.statusControlId.enum].sort());
  for (const member of ['status', 'usage']) { const dock = DOCK_REGISTRY.find(item => item.member === member); assert.ok(!dock.lead && dock.locations.some(location => location.startsWith('panda.status')), member); }
  const row = ledger.statusCoverage['panda.status'];
  assert.deepEqual(row.members, schema.$defs.statusControlId.enum);
  assert.deepEqual(row.parts, STATUS_CONTROLS.map(([id]) => id)); assert.deepEqual(row.protected, STATUS_PROTECTED.map(([id]) => id));
  assert.deepEqual(row.open, {});
  assert.deepEqual(CONTEXT_COMMANDS['panda.status.context'].map(([id]) => id), ['open']);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.status').length, 1);
  // The existing shared slots stay registered as before.
  for (const id of ['panda.status.items', 'panda.dialog.usage.actions']) assert.ok(ledger.catalog.surfaces.includes(id), id);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.status.items'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(source(path), /extensions-status-coverage\.spec\.ts/);
  for (const id of [...STATUS_CONTROLS.map(([id]) => `${STATUS_CONTROLS_LOCATION}/${id}`), ...STATUS_PROTECTED.map(([id]) => `${STATUS_PROTECTED_LOCATION}/${id}`), 'panda.status.context/open']) assert.ok(ledger.catalog.coreItems.includes(id), id);
});

test('Status schema, package, selected recipe, bounded catalog, pinned controls, protected behavior and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'polling'] }, { presentation: 'running-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  for (const location of [STATUS_PROTECTED_LOCATION, 'panda.status', 'panda.status.toast', 'panda.status.update']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.status.context', revision: 1, selection: { kind: 'usage-provider', ids: ['provider-a'] } }).ok, true);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.status.context', revision: 1, selection: { kind: 'usage-account', ids: ['a'] } }).ok, false);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.status', [provider]), undefined); selection.select('panda.status', provider.id, [provider]); assert.equal(selection.resolve('panda.status', [provider]), provider); assert.equal(selection.resolve('panda.status', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.status' }).items.map(item => item.supportedItemTypes), [['details-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: STATUS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  assert.ok(catalog.listSurfaces({ location: 'panda.status.context' }).items[0].supportedOperations.includes('contribute'));
  // The shared status group slot keeps its contribute/hide/show/reorder operations.
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.status.items' }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder']);
  const items = catalog.listItems({ location: STATUS_CONTROLS_LOCATION, limit: 100 }).items;
  assert.deepEqual(items.map(item => item.id).sort(), STATUS_CONTROLS.map(([id]) => `${STATUS_CONTROLS_LOCATION}/${id}`).sort());
  for (const item of items) {
    const id = item.id.split('/')[1];
    assert.deepEqual(item.supportedOperations, STATUS_PINNED_CONTROLS[id] ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder'], id);
    if (STATUS_PINNED_CONTROLS[id]) assert.match(item.label, / — .{20,}/);
    layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false);
  }
  assert.deepEqual(Object.keys(STATUS_PINNED_CONTROLS), ['tabs']);
  const protectedItems = catalog.listItems({ location: STATUS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.equal(protectedItems.length, STATUS_PROTECTED.length);
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const ids = STATUS_CONTROLS.map(([id]) => `${STATUS_CONTROLS_LOCATION}/${id}`); layout.move(STATUS_CONTROLS_LOCATION, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(STATUS_CONTROLS_LOCATION, ids)[0], ids[1]);
  assert.throws(() => layout.move(STATUS_PROTECTED_LOCATION, [`${STATUS_PROTECTED_LOCATION}/update`, `${STATUS_PROTECTED_LOCATION}/toast-undo`], { id: `${STATUS_PROTECTED_LOCATION}/toast-undo`, target: `${STATUS_PROTECTED_LOCATION}/update`, side: 'before' }));
  const state = fixture('state');
  for (const change of [{ providers: Array(65).fill(state.providers[0]) }, { controls: Array(129).fill(state.controls[0]) }, { selector: 'body' }, { email: 'x' }, { window: 'tray' }, { contractVersion: 2 }, { tab: 'settings' }, { toast: 'Saved draft' }, { range: 'day' }, { iterations: -1 }, { iteration: 10001 }, { task: 'x'.repeat(257) }]) assert.equal(validateContract('statusPresentation', { ...state, ...change }).ok, false, JSON.stringify(Object.keys(change)));
  // No account, cost or link data fits a harness row.
  for (const field of ['email', 'plan', 'message', 'cost', 'dashboardUrl', 'windows']) assert.equal(validateContract('statusPresentation', { ...state, providers: [{ ...state.providers[0], [field]: 'secret' }] }).ok, false, field);
  for (const change of [{ peak: 101 }, { peak: -2 }, { provider: '../secrets' }, { provider: 'Claude Max' }, { status: 'polling' }]) assert.equal(validateContract('statusPresentation', { ...state, providers: [{ ...state.providers[0], ...change }] }).ok, false, JSON.stringify(change));
  for (const list of ['controls', 'providers']) assert.throws(() => snapshotStatus({ ...state, [list]: Array(2).fill(state[list][0]) }), /Duplicate/);
  // Harness and task data are permissioned: a presentation without them carries none.
  assert.throws(() => snapshotStatus({ ...state, inventory: false }), /Unpermissioned usage/);
  for (const change of [{ iterations: 1 }, { iteration: 1 }, { jevStatus: 'passed' }]) assert.throws(() => snapshotStatus({ ...state, progress: false, iterations: 0, iteration: 0, jevStatus: 'none', ...change }), /Unpermissioned task/);
  assert.doesNotThrow(() => snapshotStatus({ ...state, inventory: false, providers: [], progress: false, iterations: 0, iteration: 0, jevStatus: 'none' }));
  assert.equal(validateContract('statusPresentation', state).ok, true); assert.equal(validateContract('statusAction', fixture('action')).ok, true);
});

test('Status binds owner/window/mount/project/task/provider/range/revision, resources, busy, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createStatusPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.providers[0]));
  for (const key of ['context', 'project', 'task', 'provider', 'range', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'range' ? 'week' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another tab, harness, period or control is a different target, never a retarget.
  for (const change of [{ control: 'foreign' }, { controlId: 'usage-details' }, { resource: 'provider-b' }, { control: 'control-row-a' }, { control: 'control-week', controlId: 'usage-range', resource: 'range-year' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext', JSON.stringify(change));
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.id !== 'control-tab-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/details-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.status-feedback/details-first';
  // Restart, Undo, notice actions, Clear, sign-in, dashboard links and polling have no public control id.
  for (const change of [{ controlId: 'update-restart' }, { controlId: 'restart' }, { controlId: 'toast-undo' }, { controlId: 'undo' }, { controlId: 'toast-action' }, { controlId: 'progress-clear' }, { controlId: 'usage-sign-in' }, { controlId: 'usage-dashboard' }, { controlId: 'usage-poll' }, { selector: '.usage-refresh' }, { interval: 1000 }, { provider: 'x'.repeat(257) }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments', JSON.stringify(change));
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Status metadata never grants a read, restart or Undo; no protected behavior is a public action; no timer or polling in the family', () => {
  for (const controlId of STATUS_ENTRY_CONTROLS) {
    const state = { ...fixture('state'), controls: [{ id: 'entry', controlId, resource: '', enabled: true, hidden: false }] };
    const slot = createStatusPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'entry', controlId, resource: '' }).reason, 'PermissionDenied');
  }
  assert.deepEqual([...STATUS_ENTRY_CONTROLS], ['usage-refresh']);
  // A resource control names its resource; an iteration needs the captured task.
  for (const controlId of STATUS_RESOURCE_CONTROLS) {
    const state = { ...fixture('state'), controls: [{ id: 'bare', controlId, resource: '', enabled: true, hidden: false }] };
    const slot = createStatusPresentation(state, 'owner', () => state, () => authority({ owner: 'owner' }), () => assert.fail('dispatch without a resource'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'bare', controlId, resource: '' }).reason, 'StaleContext', controlId);
  }
  const orphan = { ...fixture('state'), task: '', controls: [{ id: 'thumb', controlId: 'progress-thumb', resource: 'snapshot-a', enabled: true, hidden: false }] };
  const slot = createStatusPresentation(orphan, 'owner', () => orphan, () => authority({ owner: 'owner' }), () => assert.fail('dispatch without a task'));
  assert.equal(slot.dispatch({ ...fixture('action'), task: '', control: 'thumb', controlId: 'progress-thumb', resource: 'snapshot-a' }).reason, 'StaleContext');
  for (const [id] of STATUS_PROTECTED) assert.ok(!schema.$defs.statusControlId.enum.includes(id), id);
  for (const id of ['restart', 'undo', 'clear', 'sign-in', 'dashboard', 'poll', 'dismiss']) assert.ok(!schema.$defs.statusControlId.enum.some(item => item === id || item.endsWith(`-${id}`)), id);
  // The adoption adds no read, timer or network request: it only activates original nodes, and Refresh waits for Continue.
  for (const path of ['../src/extensions/status-host.ts', '../src/extensions/status-core.ts', '../src/extensions/status-state.ts']) {
    const text = source(path);
    assert.doesNotMatch(text, /setInterval|setTimeout|requestAnimationFrame|fetch\(|XMLHttpRequest|WebSocket|\bcall\(|invoke\(|(?<!layout\.)subscribe\(/, path);
  }
  assert.match(source('../src/extensions/status-host.ts'), /Extension requested a status action/);
});
