import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPanelControls, snapshotPanels, PANEL_CONTROL_IDS, PANEL_CHOICE_CONTROLS, PANEL_PROTECTED_CONTROLS, PANELS_REGISTRY } from '../src/extensions/composer-panels-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { PANEL_ACTION_SURFACES, PANEL_QUEUE_CONTROLS, PANEL_SAVER_CONTROLS, PANEL_COUNCIL_CONTROLS, PANEL_PINNED, PANEL_FIXED, PANEL_PROTECTED, PANEL_QUEUE_LOCATION, PANEL_SAVER_LOCATION, PANEL_COUNCIL_LOCATION, PANEL_PROTECTED_LOCATION, THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/composer-panels/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.composer-panels/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.composer.queue', 'panda.composer.saver', 'panda.composer.council', 'src/message-queue.ts', 'src/token-saver-panel.ts', 'src/council-panel.ts'];
const LOCATIONS = [[PANEL_QUEUE_LOCATION, PANEL_QUEUE_CONTROLS], [PANEL_SAVER_LOCATION, PANEL_SAVER_CONTROLS], [PANEL_COUNCIL_LOCATION, PANEL_COUNCIL_CONTROLS]];

test('Composer panels registry: each owned member has public locations, operations and an extension hook in its source, and the ledger closes exactly the six gaps', () => {
  assert.deepEqual(PANELS_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.composer.queue', 'src/message-queue.ts'], ['panda.composer.saver', 'src/token-saver-panel.ts'], ['panda.composer.council', 'src/council-panel.ts']]);
  for (const entry of PANELS_REGISTRY) {
    assert.ok(entry.actions && entry.order && entry.hide && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    const [family, local] = [entry.member.slice(0, entry.member.lastIndexOf('.')), entry.member.slice(entry.member.lastIndexOf('.') + 1)];
    assert.ok(ledger.families.find(item => item.id === family).members.some(([id, owner]) => id === local && owner === entry.source), entry.member);
    // T60's audit found no extension hook in these three owners; each now carries its slot and presentation hook.
    assert.match(read(`../${entry.source}`), /extension/i, entry.source);
  }
  assert.deepEqual([...PANEL_CONTROL_IDS], schema.$defs.composerPanelControlId.enum);
  const row = ledger.composerCoverage['panda.composer.panels'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.composer.panels'); assert.equal(row.lead, 'T60C');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: T60B's composer controls keep their own nine keys.
  assert.equal(ledger.composerCoverage['panda.composer.controls'].closes.filter(key => GAPS.includes(key)).length, 0);
  assert.deepEqual(row.members, [...PANEL_CONTROL_IDS]);
  assert.deepEqual(row.queueControls, PANEL_QUEUE_CONTROLS.map(([id]) => id)); assert.deepEqual(row.saverControls, PANEL_SAVER_CONTROLS.map(([id]) => id)); assert.deepEqual(row.councilControls, PANEL_COUNCIL_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.protected, PANEL_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...PANEL_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.composer.panels').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.composer.panels').tests.includes('tests/extensions-composer-panels-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-composer-panels-coverage\.spec\.ts/);
  assert.ok(ledger.sourceInventory.some(([owner]) => owner === 'src/extensions/composer-panels-host.ts'));
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'composer-panels-extension-entry' && owner === 'src/extensions/composer-panels-host.ts'));
  // The main composer's queue, the token saver and Council read their presentation from the adapter; the By the way
  // panel's queue (panda.btw.queue) does not.
  const main = read('../src/main.ts');
  assert.match(main, /agentName: botForThread\(\)\?\.name \?\? provider\(s\.provider\)\?\.name, extension: composerPanels\?\.queueLayout\(\) \}\)/);
  assert.match(main, /extension: sessionId => composerPanels\?\.saverLayout\(sessionId\)/);
  assert.match(main, /extension: \(\) => composerPanels\?\.councilLayout\(\)/);
  assert.equal((main.match(/composerPanels\?\.queueLayout\(\)/g) ?? []).length, 1);
});

test('Composer panels schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const [kind, surfaceId, id] of [['queue-entry', 'panda.composer.queue.actions', 'queue-1'], ['token-saver', 'panda.composer.saver.actions', 'task-1'], ['council-cycle', 'panda.composer.council.actions', 'task-1:1700000000000']]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids: [id] } }).ok, true, kind);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.composer.queue.actions', revision: 1, selection: { kind: 'queue', ids: ['queue-1'] } }).ok, false);
  // The slots are mounted by composer-panels-host.ts with their own contexts, not by the generic thread slots.
  assert.deepEqual([...PANEL_ACTION_SURFACES], ['panda.composer.queue.actions', 'panda.composer.saver.actions', 'panda.composer.council.actions']);
  for (const location of PANEL_ACTION_SURFACES) { assert.ok(!THREAD_ACTION_SURFACES.includes(location)); assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  for (const [location] of LOCATIONS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [PANEL_PROTECTED_LOCATION, 'panda.composer.queue', 'panda.btw.queue.controls']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.composer.council.controls/target'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of PANEL_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const [location] of LOCATIONS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: PANEL_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const [location, controls] of LOCATIONS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      assert.deepEqual(item.supportedOperations, PANEL_PINNED[item.id] ? ['inspect', 'reorder'] : PANEL_FIXED[item.id] ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (PANEL_PINNED[item.id] || PANEL_FIXED[item.id]) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(Object.keys(PANEL_PINNED), [`${PANEL_COUNCIL_LOCATION}/target`]);
  const protectedItems = catalog.listItems({ location: PANEL_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), PANEL_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // Delete, Save, Cancel, packs and the council's decisions are never layout items.
  const layoutIds = LOCATIONS.flatMap(([location, controls]) => controls.map(([id]) => `${location}/${id}`));
  for (const id of ['remove', 'save', 'cancel', 'pack', 'install', 'accept', 'dismiss', 'keep-fixing']) assert.ok(!layoutIds.some(item => item.endsWith(`/${id}`)), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.composer-panels/council', 'panda.composer.council.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-panels/queue', 'panda.composer.queue.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.composer-panels/saver', 'panda.composer.saver.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const id of layoutIds.filter(id => !PANEL_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const queue = ['steer', 'send-now', 'edit'].map(id => `${PANEL_QUEUE_LOCATION}/${id}`); layout.move(PANEL_QUEUE_LOCATION, queue, { id: queue[2], target: queue[0], side: 'before' }); assert.equal(layout.order(PANEL_QUEUE_LOCATION, queue)[0], queue[2]);
  const rows = ['target', 'max-rounds', 'reviewers'].map(id => `${PANEL_COUNCIL_LOCATION}/${id}`); layout.move(PANEL_COUNCIL_LOCATION, rows, { id: rows[2], target: rows[0], side: 'before' }); assert.equal(layout.order(PANEL_COUNCIL_LOCATION, rows)[0], rows[2]);
  // Bounded JSON only: no queued text, packs, selectors or IPC cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('composerPanelsPresentation', state).ok, true); assert.equal(validateContract('composerPanelsAction', fixture('action')).ok, true);
  for (const change of [{ controls: Array(129).fill(state.controls[0]) }, { entries: Array(65).fill('entry') }, { selector: '.queue-row' }, { text: 'queued text' }, { packs: ['caveman'] }, { window: 'tray' }, { contractVersion: 2 }, { held: 'restart' }, { cycle: 'x'.repeat(257) }]) assert.equal(validateContract('composerPanelsPresentation', { ...state, ...change }).ok, false);
  for (const extra of [{ label: 'Steer' }, { text: 'queued text' }]) assert.equal(validateContract('composerPanelsPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotPanels({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});

test('Composer panels bind owner/window/mount/project/task/revision, entry, saver and cycle resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createPanelControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another entry, an edited entry (a new resource) or another control is another target; so is a removed entry.
  for (const change of [{ control: 'foreign' }, { controlId: 'queue-edit' }, { resource: 'entry-b' }, { resource: 'entry-a-edited' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.resource !== 'entry-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  // A new council cycle is a new resource for every council control.
  const toggle = fixture('state').controls.find(control => control.controlId === 'council-strip-toggle');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => control.resource === 'cycle-a' ? { ...control, resource: 'cycle-b' } : control) };
  assert.equal(slot.dispatch({ ...fixture('action'), control: toggle.id, controlId: toggle.controlId, resource: 'cycle-a', requestId: 'cycle' }).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.composer-panels/toolbar';
  // Queue removal, edit commits, reordering, packs, installs and the council's decisions are named as protected and never run.
  for (const controlId of PANEL_PROTECTED_CONTROLS) for (const control of ['control-steer-a', 'control-toggle', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, text: 'x' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.queue-row' }, { controlId: 'queue-delete' }, { text: 'queued' }, { position: 0 }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Composer panels never send, resume or change the saver without a fresh host choice, and no protected behavior is a public control', () => {
  const state = fixture('state');
  for (const control of state.controls.filter(item => PANEL_CHOICE_CONTROLS.includes(item.controlId))) {
    const slot = createPanelControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource }).reason, 'PermissionDenied', control.controlId);
  }
  // Editing, the disclosure, reviewer rows and the compact Council panel need no choice: the user acts there.
  const opened = [], slot = createPanelControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of state.controls.filter(item => !PANEL_CHOICE_CONTROLS.includes(item.controlId))) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['queue-edit', 'council-strip-toggle', 'council-open-worker', 'council-lower-target']);
  for (const id of [...PANEL_PROTECTED.map(([id]) => id), ...PANEL_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.composerPanelControlId.enum.includes(id), id);
  assert.deepEqual(PANEL_CHOICE_CONTROLS, ['queue-steer', 'queue-send-now', 'queue-resume', 'saver-tighten', 'saver-default', 'saver-off']);
});
