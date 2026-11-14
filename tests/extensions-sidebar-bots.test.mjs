import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSidebarBotsPresentation, snapshotSidebarBots, SIDEBAR_BOTS_CONTROL_IDS, SIDEBAR_BOTS_ENTRY_CONTROLS, SIDEBAR_BOTS_ROW_CONTROLS, SIDEBAR_BOTS_PROTECTED_CONTROLS, SIDEBAR_REGISTRY } from '../src/extensions/sidebar-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { SIDEBAR_BOTS_CONTROLS, SIDEBAR_BOTS_GROUPS, SIDEBAR_BOTS_PINNED_GROUPS, SIDEBAR_BOTS_ROW_PARTS, SIDEBAR_BOTS_PROTECTED, SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_ROWS_LOCATION, SIDEBAR_BOTS_PROTECTED_LOCATION, CONTEXT_COMMANDS } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/sidebar-bots/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.sidebar-bots/filter-first', active: true, granted: true, userChoice: true, ...changes });
const CONTEXTS = ['panda.sidebar.bots.actions', 'panda.sidebar.bots.context', 'panda.sidebar.channel.context'];

test('Bots panel registry: the panda.sidebar bots member has public locations, controls, order, hide and actions, and the ledger records the closed gap', () => {
  const entry = SIDEBAR_REGISTRY.find(item => item.member === 'bots');
  assert.equal(entry.lead, undefined); assert.ok(entry.order && entry.hide && entry.actions);
  assert.deepEqual(entry.locations, [SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_ROWS_LOCATION, SIDEBAR_BOTS_PROTECTED_LOCATION, ...CONTEXTS]);
  assert.equal(entry.context, 'panda.sidebar.bots.context'); assert.match(entry.reason, /needs-you: .{20,}/);
  assert.deepEqual(entry.controls, [...SIDEBAR_BOTS_CONTROL_IDS]); assert.deepEqual(entry.controls, schema.$defs.sidebarBotsControlId.enum);
  for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
  const row = ledger.sidebarCoverage['panda.sidebar.bots'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.sidebar'); assert.equal(row.lead, 'T56J'); assert.match(row.closes, /panda\.sidebar\/bots/);
  assert.deepEqual(row.members, schema.$defs.sidebarBotsControlId.enum);
  assert.deepEqual(row.groups, schema.$defs.sidebarBotsGroupId.enum); assert.deepEqual(row.groups, SIDEBAR_BOTS_GROUPS.map(([id]) => id));
  assert.deepEqual(row.headControls, SIDEBAR_BOTS_CONTROLS.map(([id]) => id)); assert.deepEqual(row.rowParts, SIDEBAR_BOTS_ROW_PARTS.map(([id]) => id));
  assert.deepEqual(row.protected, SIDEBAR_BOTS_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...SIDEBAR_BOTS_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  // The existing row menus keep their core rows; the captured registry names them.
  assert.deepEqual(CONTEXT_COMMANDS['panda.sidebar.bots.context'].map(([id]) => id), ['pin', 'edit', 'duplicate', 'hide', 'delete']);
  assert.deepEqual(CONTEXT_COMMANDS['panda.sidebar.channel.context'].map(([id]) => id), ['edit', 'delete', 'restore']);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-sidebar-bots-coverage\.spec\.ts/);
  // The host file that draws the fresh choice is inventoried with its named menu.
  assert.ok(ledger.sourceInventory.some(([owner]) => owner === 'src/extensions/sidebar-bots-host.ts'));
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'sidebar-bots-extension-entry' && owner === 'src/extensions/sidebar-bots-host.ts'));
});

test('Bots panel schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const kind of ['bot', 'channel']) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: `panda.sidebar.${kind === 'bot' ? 'bots' : 'channel'}.context`, revision: 1, ...(kind === 'bot' ? { projectId: 'bot-project' } : {}), selection: { kind, ids: ['id-1'] } }).ok, true);
  }
  // Empty ids are omitted, never sent: the public context rejects empty text.
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.sidebar.channel.context', revision: 1, projectId: '', selection: { kind: 'channel', ids: ['id-1'] } }).ok, false);
  for (const location of [SIDEBAR_BOTS_LOCATION, SIDEBAR_BOTS_GROUPS_LOCATION, SIDEBAR_BOTS_ROWS_LOCATION]) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of CONTEXTS) assert.ok(schema.$defs.actionLocation.enum.includes(location));
  for (const location of [SIDEBAR_BOTS_PROTECTED_LOCATION, 'panda.sidebar.bots.hidden']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.sidebar.sections/review'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of CONTEXTS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: SIDEBAR_BOTS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  assert.deepEqual(catalog.listSurfaces({ location: SIDEBAR_BOTS_ROWS_LOCATION }).items[0].supportedOperations, ['inspect', 'hide', 'show']);
  const head = catalog.listItems({ location: SIDEBAR_BOTS_LOCATION, limit: 100 }).items;
  assert.deepEqual(head.map(item => item.id).sort(), SIDEBAR_BOTS_CONTROLS.map(([id]) => `${SIDEBAR_BOTS_LOCATION}/${id}`).sort());
  for (const item of head) assert.deepEqual(item.supportedOperations, item.id.endsWith('/search') ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder']);
  const groups = catalog.listItems({ location: SIDEBAR_BOTS_GROUPS_LOCATION, limit: 100 }).items;
  assert.deepEqual(groups.map(item => item.id).sort(), SIDEBAR_BOTS_GROUPS.map(([id]) => `${SIDEBAR_BOTS_GROUPS_LOCATION}/${id}`).sort());
  for (const item of groups) {
    const id = item.id.split('/')[1];
    assert.deepEqual(item.supportedOperations, SIDEBAR_BOTS_PINNED_GROUPS[id] ? ['inspect', 'reorder'] : ['inspect', 'hide', 'show', 'reorder']);
    if (SIDEBAR_BOTS_PINNED_GROUPS[id]) assert.match(item.label, / — .{20,}/);
  }
  for (const item of catalog.listItems({ location: SIDEBAR_BOTS_PROTECTED_LOCATION, limit: 100 }).items) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  for (const [location, ids] of Object.entries({ 'panda.sidebar.bots.context': CONTEXT_COMMANDS['panda.sidebar.bots.context'], 'panda.sidebar.channel.context': CONTEXT_COMMANDS['panda.sidebar.channel.context'] })) assert.deepEqual(catalog.listItems({ location, limit: 100 }).items.map(item => item.id).sort(), ids.map(([id]) => `${location}/${id}`).sort());
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const item of catalog.listItems({ location: SIDEBAR_BOTS_ROWS_LOCATION, limit: 100 }).items) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
  const ids = SIDEBAR_BOTS_GROUPS.map(([id]) => `${SIDEBAR_BOTS_GROUPS_LOCATION}/${id}`); layout.move(SIDEBAR_BOTS_GROUPS_LOCATION, ids, { id: ids[4], target: ids[0], side: 'before' }); assert.equal(layout.order(SIDEBAR_BOTS_GROUPS_LOCATION, ids)[0], ids[4]);
  assert.throws(() => layout.move(SIDEBAR_BOTS_PROTECTED_LOCATION, ['panda.sidebar.bots.protected/bar', 'panda.sidebar.bots.protected/search-field'], { id: 'panda.sidebar.bots.protected/search-field', target: 'panda.sidebar.bots.protected/bar', side: 'before' }));
  // Bounded JSON only: no names, messages, tokens or selectors cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('sidebarBotsPresentation', state).ok, true); assert.equal(validateContract('sidebarBotsAction', fixture('action')).ok, true);
  for (const change of [{ rows: Array(257).fill(state.rows[0]) }, { controls: Array(1025).fill(state.controls[0]) }, { groups: Array(9).fill(state.groups[0]) }, { selector: '.bot-row' }, { name: 'Scout' }, { token: 'x' }, { window: 'tray' }, { contractVersion: 2 }, { view: 'settings' }, { bot: 'x'.repeat(257) }]) assert.equal(validateContract('sidebarBotsPresentation', { ...state, ...change }).ok, false);
  for (const extra of [{ name: 'Scout' }, { preview: 'You: hi' }, { role: 'Research' }]) assert.equal(validateContract('sidebarBotsPresentation', { ...state, rows: [{ ...state.rows[0], ...extra }] }).ok, false);
  assert.equal(validateContract('sidebarBotsPresentation', { ...state, rows: [{ ...state.rows[0], group: 'folders' }] }).ok, false);
  for (const list of ['controls', 'rows', 'groups']) assert.throws(() => snapshotSidebarBots({ ...state, [list]: Array(2).fill(state[list][0]) }), /Duplicate/);
});

test('Bots panel binds owner/window/mount/project/bot/channel/revision, row resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createSidebarBotsPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.rows[0]));
  for (const key of ['context', 'project', 'bot', 'channel', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Opening bot B from bot A never retargets: another control or resource is another target.
  for (const change of [{ control: 'foreign' }, { controlId: 'bot-menu' }, { resource: 'row-a' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), rows: [fixture('state').rows[0], fixture('state').rows[2]] }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/filter-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.sidebar-bots/filter-first';
  // Deletion, pausing, duplication, channel changes, membership and credentials are named as protected, never run.
  for (const controlId of SIDEBAR_BOTS_PROTECTED_CONTROLS) assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.bot-row' }, { controlId: 'rename-bot' }, { controlId: 'reorder' }, { botId: 'raw-id' }, { name: 'Scout' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Bots panel metadata never grants a view switch, Mark all read, Hidden preference or creation dialog without a fresh host choice', () => {
  for (const controlId of SIDEBAR_BOTS_ENTRY_CONTROLS) {
    const state = fixture('state'), resource = SIDEBAR_BOTS_ROW_CONTROLS.includes(controlId) ? 'row-b' : '';
    state.controls = [{ id: 'entry', controlId, resource, enabled: true, hidden: false }];
    const slot = createSidebarBotsPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'entry', controlId, resource }).reason, 'PermissionDenied', controlId);
  }
  // Entry and row controls are disjoint, and no protected behavior or control is a public action id.
  assert.deepEqual(SIDEBAR_BOTS_ENTRY_CONTROLS.filter(id => SIDEBAR_BOTS_ROW_CONTROLS.includes(id)), []);
  for (const id of [...SIDEBAR_BOTS_PROTECTED.map(([id]) => id), ...SIDEBAR_BOTS_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.sidebarBotsControlId.enum.includes(id), id);
});
