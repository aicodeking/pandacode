import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDockPresentation, snapshotDock, DOCK_ENTRY_CONTROLS, TEAM_CONTROLS, DOCK_REGISTRY } from '../src/extensions/dock-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { DOCK_CONTROLS, DOCK_PINNED_CONTROLS, DOCK_PROTECTED, DOCK_GROUPS, TEAM_PARTS, TEAM_PINNED_PARTS, DOCK_CONTROLS_LOCATION, TEAM_CONTROLS_LOCATION, DOCK_PROTECTED_LOCATION, CONTEXT_COMMANDS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/action-dock/${name}.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.action-dock/actions-first', active: true, granted: true, userChoice: true, ...changes });

test('Action dock registry: every panda.agents ledger member has an explicit entry, each exception has its reason, and the ledger maps it', () => {
  const family = ledger.families.find(item => item.id === 'panda.agents');
  assert.deepEqual(DOCK_REGISTRY.map(entry => entry.member).filter(member => member !== 'flyout' && member !== 'status').sort(), family.members.map(([id]) => id).sort());
  for (const entry of DOCK_REGISTRY) {
    if (!entry.hide || !entry.actions || entry.lead) assert.ok(entry.reason && entry.reason.length > 20, entry.member);
    if (entry.lead) assert.ok(['T56F', 'T56G', 'T57'].includes(entry.lead), entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
  }
  // Dock and team are T56E's, subagents and profiles the roster family's (T56F); the widget window and usage stay with their own tasks.
  assert.deepEqual(DOCK_REGISTRY.filter(entry => !entry.lead).map(entry => entry.member).sort(), ['dock', 'flyout', 'profiles', 'subagents', 'team']);
  const row = ledger.dockCoverage['panda.actionDock'];
  assert.deepEqual(row.members, schema.$defs.dockControlId.enum);
  assert.deepEqual(row.groups, [...DOCK_GROUPS]); assert.deepEqual(row.teamParts, TEAM_PARTS.map(([id]) => id)); assert.deepEqual(row.protected, DOCK_PROTECTED.map(([id]) => id));
  assert.deepEqual(Object.keys(row.open).sort(), ['usage', 'widget']);
  assert.deepEqual(CONTEXT_COMMANDS['panda.team.context'].map(([id]) => id), ['toggle', 'open']);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.actionDock').length, 1);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.actionDock' && adapter.tests.includes('tests/extensions-team-controls-coverage.spec.ts')));
  // The existing accessory adapters remain and keep their own evidence.
  for (const id of ['panda.actionDock.actions', 'panda.team.actions', 'panda.agents.actions']) assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === id && adapter.tests.includes('tests/extensions-thread-actions.spec.ts')), id);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-team-controls-coverage\.spec\.ts/);
});

test('Action dock schema, package, selected recipe, bounded catalog, pinned items, protected behavior and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'approvals'] }, { presentation: 'filter-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  for (const location of [DOCK_PROTECTED_LOCATION, 'panda.actionDock', 'panda.actionDock.groups', 'panda.team.workers']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.team.context', sessionId: 'session-1', revision: 1, selection: { kind: 'team', ids: ['session-1'] } }).ok, true);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.actionDock', [provider]), undefined); selection.select('panda.actionDock', provider.id, [provider]); assert.equal(selection.resolve('panda.actionDock', [provider]), provider); assert.equal(selection.resolve('panda.actionDock', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.actionDock' }).items.map(item => item.supportedItemTypes), [['actions-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: DOCK_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const location of ['panda.actionDock.actions', 'panda.team.actions', 'panda.agents.actions', 'panda.team.context']) assert.ok(catalog.listSurfaces({ location }).items[0].supportedOperations.includes('contribute'), location);
  for (const [location, controls, pinned] of [[DOCK_CONTROLS_LOCATION, DOCK_CONTROLS, DOCK_PINNED_CONTROLS], [TEAM_CONTROLS_LOCATION, TEAM_PARTS, TEAM_PINNED_PARTS]]) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      const id = item.id.split('/')[1];
      assert.deepEqual(item.supportedOperations, pinned[id] ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder']);
      if (pinned[id]) assert.match(item.label, / — .{20,}/);
      layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false);
    }
  }
  const protectedItems = catalog.listItems({ location: DOCK_PROTECTED_LOCATION, limit: 100 }).items;
  assert.equal(protectedItems.length, DOCK_PROTECTED.length);
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const ids = DOCK_CONTROLS.map(([id]) => `${DOCK_CONTROLS_LOCATION}/${id}`); layout.move(DOCK_CONTROLS_LOCATION, ids, { id: ids[4], target: ids[0], side: 'before' }); assert.equal(layout.order(DOCK_CONTROLS_LOCATION, ids)[0], ids[4]);
  assert.throws(() => layout.move(DOCK_PROTECTED_LOCATION, ['panda.actionDock.protected/stop', 'panda.actionDock.protected/approvals'], { id: 'panda.actionDock.protected/approvals', target: 'panda.actionDock.protected/stop', side: 'before' }));
  for (const change of [{ workers: Array(65).fill(fixture('state').workers[0]) }, { controls: Array(129).fill(fixture('state').controls[0]) }, { groups: Array(4).fill(fixture('state').groups[0]) }, { selector: 'body' }, { assignment: 'x' }, { window: 'tray' }, { contractVersion: 2 }, { status: 'deleted' }, { running: -1 }, { team: 'x'.repeat(257) }]) assert.equal(validateContract('dockPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const field of ['name', 'assignment', 'model', 'sessionId', 'prompt']) assert.equal(validateContract('dockPresentation', { ...fixture('state'), workers: [{ ...fixture('state').workers[0], [field]: 'Secret plan' }] }).ok, false, field);
  assert.throws(() => snapshotDock({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  assert.throws(() => snapshotDock({ ...fixture('state'), workers: Array(2).fill(fixture('state').workers[0]) }), /Duplicate/);
  // Progress is permissioned: a presentation without it carries no status, count or worker.
  for (const change of [{ status: 'running' }, { running: 1 }, { attention: 1 }, { failed: 1 }, { total: 1 }, { workers: fixture('state').workers }]) assert.throws(() => snapshotDock({ ...fixture('state'), progress: false, status: 'none', running: 0, attention: 0, failed: 0, total: 0, workers: [], ...change }), /Unpermissioned/);
  assert.doesNotThrow(() => snapshotDock({ ...fixture('state'), progress: false, status: 'none', running: 0, attention: 0, failed: 0, total: 0, workers: [] }));
  assert.equal(validateContract('dockPresentation', fixture('state')).ok, true); assert.equal(validateContract('dockAction', fixture('action')).ok, true);
});

test('Action dock binds owner/window/mount/project/task/team/revision, worker resources, busy, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createDockPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.workers[0]));
  for (const key of ['context', 'project', 'task', 'team', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  // Another worker's control or resource is a different target, never a retarget; a worker that left is refused.
  for (const change of [{ control: 'foreign' }, { controlId: 'team-open' }, { resource: 'worker-b' }, { control: 'control-worker-b' }, { resource: 'worker-of-another-team' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.id !== 'control-worker-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/actions-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.action-dock/actions-first';
  // Stop, approvals, answers and recovery have no public control id: forged requests are invalid, not dispatched.
  for (const change of [{ controlId: 'stop' }, { controlId: 'stop-worker' }, { controlId: 'approve' }, { controlId: 'deny' }, { controlId: 'answer' }, { controlId: 'retry' }, { controlId: 'skip' }, { selector: '#agents-toggle' }, { workerId: 'worker-1' }, { sessionId: 'session-1' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Action dock metadata never grants Run, team or worker authority; no protected behavior is a public action', () => {
  for (const controlId of DOCK_ENTRY_CONTROLS) {
    const state = fixture('state'); state.controls = [{ id: 'entry', controlId, resource: '', enabled: true, hidden: false }];
    const slot = createDockPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'entry', controlId, resource: '' }).reason, 'PermissionDenied');
  }
  // A team control needs the captured team: without one (another task, or the team gone) nothing acts.
  for (const controlId of TEAM_CONTROLS) {
    const state = { ...fixture('state'), team: '', controls: [{ id: 'team', controlId, resource: 'team-a', enabled: true, hidden: false }] };
    const slot = createDockPresentation(state, 'owner', () => state, () => authority({ owner: 'owner' }), () => assert.fail('dispatch without a team'));
    assert.equal(slot.dispatch({ ...fixture('action'), team: '', control: 'team', controlId, resource: 'team-a' }).reason, 'StaleContext');
  }
  for (const [id] of DOCK_PROTECTED) assert.ok(!schema.$defs.dockControlId.enum.includes(id), id);
  for (const id of ['stop', 'approve', 'deny', 'answer', 'retry', 'skip']) assert.ok(!schema.$defs.dockControlId.enum.includes(id), id);
});
