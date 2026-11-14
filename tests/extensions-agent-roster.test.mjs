import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createRosterPresentation, snapshotRoster, runningFirst, ROSTER_ENTRY_CONTROLS, ROSTER_RESOURCE_CONTROLS, ROSTER_REGISTRY } from '../src/extensions/roster-core.ts';
import { DOCK_REGISTRY } from '../src/extensions/dock-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { ROSTER_CONTROLS, ROSTER_PINNED_CONTROLS, ROSTER_PROTECTED, ROSTER_CONTROLS_LOCATION, ROSTER_PROTECTED_LOCATION, CONTEXT_COMMANDS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/agent-roster/${name}.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.agent-roster/running-first', active: true, granted: true, userChoice: true, ...changes });

test('Agent roster registry: every roster member of panda.agents has an explicit entry with its reasons, and the ledger maps it', () => {
  const family = ledger.families.find(item => item.id === 'panda.agents');
  assert.deepEqual(ROSTER_REGISTRY.map(entry => entry.member).sort(), ['profiles', 'subagents', 'widget']);
  for (const entry of ROSTER_REGISTRY) {
    assert.ok(family.members.some(([id]) => id === entry.member), entry.member);
    assert.ok(entry.reason.length > 40, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    for (const action of entry.actions) assert.ok(schema.$defs.rosterControlId.enum.includes(action), action);
    assert.deepEqual([...entry.parts].sort(), ROSTER_CONTROLS.filter(([, , member]) => member === entry.member).map(([id]) => id).sort());
    // The dock registry names the same family for the member.
    const dock = DOCK_REGISTRY.find(item => item.member === entry.member);
    assert.ok(dock && entry.locations.every(location => dock.locations.includes(location)), entry.member);
  }
  // Every public action belongs to exactly one member; the widget's auxiliary window stays T57's.
  assert.deepEqual(ROSTER_REGISTRY.flatMap(entry => entry.actions).sort(), [...schema.$defs.rosterControlId.enum].sort());
  assert.equal(ROSTER_REGISTRY.find(entry => entry.member === 'widget').lead, 'T57');
  const row = ledger.rosterCoverage['panda.roster'];
  assert.deepEqual(row.members, schema.$defs.rosterControlId.enum);
  assert.deepEqual(row.parts, ROSTER_CONTROLS.map(([id]) => id)); assert.deepEqual(row.protected, ROSTER_PROTECTED.map(([id]) => id));
  assert.deepEqual(CONTEXT_COMMANDS['panda.roster.context'].map(([id]) => id), ['open']);
  assert.match(row.lineage, /machine lineage.*not conflated/);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.roster').length, 1);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-agent-roster-coverage\.spec\.ts/);
  for (const id of [...ROSTER_CONTROLS.map(([id]) => `${ROSTER_CONTROLS_LOCATION}/${id}`), ...ROSTER_PROTECTED.map(([id]) => `${ROSTER_PROTECTED_LOCATION}/${id}`), 'panda.roster.context/open']) assert.ok(ledger.catalog.coreItems.includes(id), id);
});

test('Agent roster schema, package, selected recipe, bounded catalog, pinned controls, protected behavior and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'stop'] }, { presentation: 'actions-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  for (const location of [ROSTER_PROTECTED_LOCATION, 'panda.roster', 'panda.roster.rows', 'panda.agentsDock.window']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.roster.context', sessionId: 'session-1', revision: 1, selection: { kind: 'subagent', ids: ['child-a'] } }).ok, true);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.roster', [provider]), undefined); selection.select('panda.roster', provider.id, [provider]); assert.equal(selection.resolve('panda.roster', [provider]), provider); assert.equal(selection.resolve('panda.roster', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.roster' }).items.map(item => item.supportedItemTypes), [['running-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: ROSTER_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  assert.ok(catalog.listSurfaces({ location: 'panda.roster.context' }).items[0].supportedOperations.includes('contribute'));
  const items = catalog.listItems({ location: ROSTER_CONTROLS_LOCATION, limit: 100 }).items;
  assert.deepEqual(items.map(item => item.id).sort(), ROSTER_CONTROLS.map(([id]) => `${ROSTER_CONTROLS_LOCATION}/${id}`).sort());
  for (const item of items) {
    const id = item.id.split('/')[1];
    assert.deepEqual(item.supportedOperations, ROSTER_PINNED_CONTROLS[id] ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder'], id);
    if (ROSTER_PINNED_CONTROLS[id]) assert.match(item.label, / — .{20,}/);
    layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false);
  }
  assert.deepEqual(Object.keys(ROSTER_PINNED_CONTROLS).sort(), ['back', 'close', 'picker', 'widget']);
  const protectedItems = catalog.listItems({ location: ROSTER_PROTECTED_LOCATION, limit: 100 }).items;
  assert.equal(protectedItems.length, ROSTER_PROTECTED.length);
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const ids = ROSTER_CONTROLS.map(([id]) => `${ROSTER_CONTROLS_LOCATION}/${id}`); layout.move(ROSTER_CONTROLS_LOCATION, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(ROSTER_CONTROLS_LOCATION, ids)[0], ids[1]);
  assert.throws(() => layout.move(ROSTER_PROTECTED_LOCATION, [`${ROSTER_PROTECTED_LOCATION}/lineage`, `${ROSTER_PROTECTED_LOCATION}/stop`], { id: `${ROSTER_PROTECTED_LOCATION}/stop`, target: `${ROSTER_PROTECTED_LOCATION}/lineage`, side: 'before' }));
  const state = fixture('state');
  for (const change of [{ children: Array(65).fill(state.children[0]) }, { agents: Array(65).fill(state.agents[0]) }, { controls: Array(129).fill(state.controls[0]) }, { selector: 'body' }, { prompt: 'x' }, { window: 'agents-dock' }, { contractVersion: 2 }, { view: 'window' }, { running: -1 }, { task: 'x'.repeat(257) }]) assert.equal(validateContract('rosterPresentation', { ...state, ...change }).ok, false, JSON.stringify(Object.keys(change)));
  for (const field of ['name', 'prompt', 'response', 'tools', 'model', 'sessionId']) assert.equal(validateContract('rosterPresentation', { ...state, children: [{ ...state.children[0], [field]: 'Secret plan' }] }).ok, false, field);
  for (const field of ['title', 'projectName', 'provider', 'model']) assert.equal(validateContract('rosterPresentation', { ...state, agents: [{ ...state.agents[0], [field]: 'Secret' }] }).ok, false, field);
  for (const list of ['controls', 'children', 'agents']) assert.throws(() => snapshotRoster({ ...state, [list]: Array(2).fill(state[list][0]) }), /Duplicate/);
  // Child and running-agent data are permissioned: a presentation without it carries none.
  for (const change of [{ running: 1 }, { children: state.children }, { agents: state.agents }]) assert.throws(() => snapshotRoster({ ...state, progress: false, running: 0, children: [], agents: [], ...change }), /Unpermissioned/);
  assert.doesNotThrow(() => snapshotRoster({ ...state, progress: false, running: 0, children: [], agents: [] }));
  assert.equal(validateContract('rosterPresentation', state).ok, true); assert.equal(validateContract('rosterAction', fixture('action')).ok, true);
});

test('Agent roster running-first keeps start order inside each group and only reorders, never adds or drops a child', () => {
  const rows = [{ id: 'a', active: false }, { id: 'b', active: true }, { id: 'c', active: false }, { id: 'd', active: true }];
  assert.deepEqual(runningFirst(rows), ['b', 'd', 'a', 'c']);
  assert.deepEqual(runningFirst([]), []);
  assert.deepEqual(runningFirst(rows).sort(), rows.map(row => row.id).sort());
});

test('Agent roster binds owner/window/mount/project/task/profile/revision, child and profile resources, busy, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createRosterPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.children[0]));
  for (const key of ['context', 'project', 'task', 'profile', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another child, a child of another task or another profile is a different target, never a retarget.
  for (const change of [{ control: 'foreign' }, { controlId: 'subagents-close' }, { resource: 'child-b' }, { control: 'control-child-b' }, { resource: 'child-of-another-task' }, { control: 'control-profile-b', controlId: 'profile-select', resource: 'profile-c' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext', JSON.stringify(change));
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.id !== 'control-child-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/running-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.agent-roster/running-first';
  // Stop, pin, unpin, rename, delete, approvals and answers have no public control id: forged requests are invalid.
  for (const change of [{ controlId: 'stop' }, { controlId: 'stop-subagent' }, { controlId: 'widget-pin' }, { controlId: 'unpin' }, { controlId: 'profile-delete' }, { controlId: 'profile-rename' }, { controlId: 'approve' }, { controlId: 'answer' }, { selector: '.subagent-row' }, { agentId: 'child-1' }, { sessionId: 'session-1' }, { window: 'agents-dock' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments', JSON.stringify(change));
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Agent roster metadata never grants profile, child or task authority; no protected behavior is a public action', () => {
  for (const controlId of ROSTER_ENTRY_CONTROLS) {
    const state = fixture('state'), resource = controlId === 'profile-select' ? 'profile-b' : '';
    state.controls = [{ id: 'entry', controlId, resource, enabled: true, hidden: false }];
    const slot = createRosterPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'entry', controlId, resource }).reason, 'PermissionDenied');
  }
  // A resource control names its resource; a child needs the captured parent task.
  for (const controlId of ROSTER_RESOURCE_CONTROLS) {
    const state = { ...fixture('state'), controls: [{ id: 'bare', controlId, resource: '', enabled: true, hidden: false }] };
    const slot = createRosterPresentation(state, 'owner', () => state, () => authority({ owner: 'owner' }), () => assert.fail('dispatch without a resource'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'bare', controlId, resource: '' }).reason, 'StaleContext', controlId);
  }
  const orphan = { ...fixture('state'), task: '', controls: [{ id: 'child', controlId: 'subagent-open', resource: 'child-a', enabled: true, hidden: false }] };
  const slot = createRosterPresentation(orphan, 'owner', () => orphan, () => authority({ owner: 'owner' }), () => assert.fail('dispatch without a parent task'));
  assert.equal(slot.dispatch({ ...fixture('action'), task: '', control: 'child', resource: 'child-a' }).reason, 'StaleContext');
  for (const [id] of ROSTER_PROTECTED) assert.ok(!schema.$defs.rosterControlId.enum.includes(id), id);
  for (const id of ['stop', 'pin', 'unpin', 'rename', 'delete', 'approve', 'answer']) assert.ok(!schema.$defs.rosterControlId.enum.some(item => item === id || item.endsWith(`-${id}`)), id);
});
