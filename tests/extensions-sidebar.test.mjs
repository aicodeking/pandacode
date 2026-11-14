import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSidebarPresentation, snapshotSidebar, SIDEBAR_ENTRY_CONTROLS, SIDEBAR_ROW_CONTROLS, SIDEBAR_REGISTRY } from '../src/extensions/sidebar-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { SIDEBAR_SECTIONS, SIDEBAR_PINNED_SECTIONS, SIDEBAR_FIXED_SECTIONS, SIDEBAR_ROW_PARTS, SIDEBAR_PROTECTED, SIDEBAR_HEADER_CONTROLS, SIDEBAR_PROJECT_CONTROLS, SIDEBAR_HEADER_LOCATION, SIDEBAR_PROJECTS_LOCATION, SIDEBAR_SECTIONS_LOCATION, SIDEBAR_ROWS_LOCATION, SIDEBAR_PROTECTED_LOCATION, CONTEXT_COMMANDS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
import { sidebarSections } from '../src/sidebar-sections.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/sidebar/${name}.json`, import.meta.url), 'utf8'));
const schema = JSON.parse(readFileSync(new URL('../src/extensions/schema-v1.json', import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const authority = (changes = {}) => ({ owner: 'sample.sidebar/filter-first', active: true, granted: true, userChoice: true, ...changes });

test('Sidebar registry: every ledger member and the sort row has an explicit entry, each exception has its reason, and the ledger maps it', () => {
  const family = ledger.families.find(item => item.id === 'panda.sidebar');
  assert.deepEqual(SIDEBAR_REGISTRY.map(entry => entry.member).filter(member => member !== 'sort').sort(), family.members.map(([id]) => id).sort());
  for (const entry of SIDEBAR_REGISTRY) {
    if (!entry.hide || !entry.actions || entry.member === 'sort') assert.ok(entry.reason && entry.reason.length > 20, entry.member);
    if (entry.lead) assert.equal(entry.locations.length, 0);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
  }
  const row = ledger.sidebarCoverage['panda.sidebar'];
  assert.deepEqual(row.members, schema.$defs.sidebarControlId.enum);
  assert.deepEqual(row.sections, schema.$defs.sidebarSectionId.enum); assert.deepEqual(row.sections, SIDEBAR_SECTIONS.map(([id]) => id));
  assert.deepEqual(row.rowParts, SIDEBAR_ROW_PARTS.map(([id]) => id)); assert.deepEqual(row.protected, SIDEBAR_PROTECTED.map(([id]) => id));
  assert.ok(row.open.bots && SIDEBAR_REGISTRY.find(entry => entry.member === 'bots').lead === 'T56I');
  // Existing project-card and sidebar context adapters stay; the task and project row menus keep their core rows.
  assert.deepEqual(CONTEXT_COMMANDS['panda.sidebar.task.context'].map(([id]) => id), SIDEBAR_REGISTRY.find(entry => entry.member === 'task.context').controls);
  assert.deepEqual(CONTEXT_COMMANDS['panda.sidebar.project.context'].map(([id]) => id), SIDEBAR_REGISTRY.find(entry => entry.member === 'project.context').controls);
  assert.ok(ledger.implementedAdapters.some(adapter => adapter.id === 'panda.sidebar' && adapter.tests.includes('tests/extensions-sidebar-coverage.spec.ts')));
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.sidebar').length, 1);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-sidebar-coverage\.spec\.ts/);
});

test('Sidebar schema, package, selected recipe, bounded catalog, pinned and docked sections, protected behavior and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'grouping'] }, { presentation: 'actions-first' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  for (const location of [SIDEBAR_PROTECTED_LOCATION, 'panda.sidebar', 'panda.sidebar.bots']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.sidebar.context', revision: 1, selection: { kind: 'sidebar-section', ids: ['review'] } }).ok, true);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.sidebar', [provider]), undefined); selection.select('panda.sidebar', provider.id, [provider]); assert.equal(selection.resolve('panda.sidebar', [provider]), provider); assert.equal(selection.resolve('panda.sidebar', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  assert.deepEqual(catalog.listSurfaces({ location: 'panda.sidebar' }).items.map(item => item.supportedItemTypes), [['filter-first']]);
  assert.deepEqual(catalog.listSurfaces({ location: SIDEBAR_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const location of ['panda.sidebar.actions', 'panda.sidebar.context', 'panda.sidebar.footer', 'panda.sidebar.task.context', 'panda.sidebar.project.context']) assert.ok(catalog.listSurfaces({ location }).items[0].supportedOperations.includes('contribute'), location);
  for (const [location, controls] of [[SIDEBAR_HEADER_LOCATION, SIDEBAR_HEADER_CONTROLS], [SIDEBAR_PROJECTS_LOCATION, SIDEBAR_PROJECT_CONTROLS]]) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder']);
  }
  const sections = catalog.listItems({ location: SIDEBAR_SECTIONS_LOCATION, limit: 100 }).items;
  assert.deepEqual(sections.map(item => item.id).sort(), SIDEBAR_SECTIONS.map(([id]) => `${SIDEBAR_SECTIONS_LOCATION}/${id}`).sort());
  for (const item of sections) {
    const id = item.id.split('/')[1];
    assert.deepEqual(item.supportedOperations, SIDEBAR_PINNED_SECTIONS[id] ? ['inspect', 'reorder'] : SIDEBAR_FIXED_SECTIONS[id] ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder']);
    if (SIDEBAR_PINNED_SECTIONS[id] || SIDEBAR_FIXED_SECTIONS[id]) assert.match(item.label, / — .{20,}/);
  }
  for (const item of catalog.listItems({ location: SIDEBAR_ROWS_LOCATION, limit: 100 }).items) {
    const [, , reorderable] = SIDEBAR_ROW_PARTS.find(([id]) => item.id === `${SIDEBAR_ROWS_LOCATION}/${id}`);
    assert.deepEqual(item.supportedOperations, reorderable ? ['inspect', 'hide', 'show', 'reorder'] : ['inspect', 'hide', 'show']);
    layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false);
  }
  const protectedItems = catalog.listItems({ location: SIDEBAR_PROTECTED_LOCATION, limit: 100 }).items;
  assert.equal(protectedItems.length, SIDEBAR_PROTECTED.length);
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  const ids = sections.map(item => item.id); layout.move(SIDEBAR_SECTIONS_LOCATION, ids, { id: ids[2], target: ids[0], side: 'before' }); assert.equal(layout.order(SIDEBAR_SECTIONS_LOCATION, ids)[0], ids[2]);
  assert.throws(() => layout.move(SIDEBAR_PROTECTED_LOCATION, ['panda.sidebar.protected/filter', 'panda.sidebar.protected/status'], { id: 'panda.sidebar.protected/status', target: 'panda.sidebar.protected/filter', side: 'before' }));
  for (const change of [{ rows: Array(129).fill(fixture('state').rows[0]) }, { controls: Array(513).fill(fixture('state').controls[0]) }, { sections: Array(17).fill(fixture('state').sections[0]) }, { selector: 'body' }, { title: 'x' }, { window: 'tray' }, { contractVersion: 2 }, { group: 'folders' }, { taskSort: 'priority' }, { project: 'x'.repeat(257) }]) assert.equal(validateContract('sidebarPresentation', { ...fixture('state'), ...change }).ok, false);
  assert.equal(validateContract('sidebarPresentation', { ...fixture('state'), rows: [{ ...fixture('state').rows[0], title: 'Secret plan' }] }).ok, false);
  assert.throws(() => snapshotSidebar({ ...fixture('state'), controls: Array(2).fill(fixture('state').controls[0]) }), /Duplicate/);
  assert.throws(() => snapshotSidebar({ ...fixture('state'), rows: Array(2).fill(fixture('state').rows[0]) }), /Duplicate/);
  assert.equal(validateContract('sidebarPresentation', fixture('state')).ok, true); assert.equal(validateContract('sidebarAction', fixture('action')).ok, true);
});

test('Sidebar binds owner/window/mount/project/task/revision, row resources, busy, hidden and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createSidebarPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.rows[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  // Selecting task B from A never retargets: another resource or control is a different target.
  for (const change of [{ control: 'foreign' }, { controlId: 'task-menu' }, { resource: 'row-a' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), rows: [fixture('state').rows[0]] }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/filter-first'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.sidebar/filter-first';
  for (const change of [{ selector: '.task-item' }, { controlId: 'delete' }, { controlId: 'rename' }, { controlId: 'reorder' }, { taskId: 'session-1' }, { order: ['a'] }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Sidebar metadata never grants creation, collapse or stage authority; original grouping is unchanged by presentation', () => {
  for (const controlId of SIDEBAR_ENTRY_CONTROLS) {
    const state = fixture('state'), resource = SIDEBAR_ROW_CONTROLS.includes(controlId) ? 'row-b' : '';
    state.controls = [{ id: 'entry', controlId, resource, enabled: true, hidden: false }];
    const slot = createSidebarPresentation(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: 'entry', controlId, resource }).reason, 'PermissionDenied');
  }
  // No protected behavior is a public action id.
  for (const [id] of SIDEBAR_PROTECTED) assert.ok(!schema.$defs.sidebarControlId.enum.includes(id));
  // The presentation layer only names the original groups; sidebarSections() alone decides membership.
  const task = (id, extra = {}) => ({ id, projectId: 'p', title: id, createdAt: 1, status: 'idle', ...extra });
  const groups = sidebarSections({ tasks: [task('run'), task('done', { completedAt: 2 }), task('pin', { pinned: true }), task('new')], active: item => item.id === 'run', stage: item => item.completedAt ? 'completed' : 'review' });
  assert.deepEqual(Object.fromEntries(Object.entries(groups).map(([key, list]) => [key, list.map(item => item.id)])), { active: ['run'], review: ['new'], rest: ['pin'], completed: ['done'] });
});
