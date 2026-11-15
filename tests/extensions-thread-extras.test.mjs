import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createThreadExtrasControls, snapshotThreadExtras, THREAD_EXTRAS_CONTROL_IDS, THREAD_EXTRAS_CHOICE_CONTROLS, THREAD_EXTRAS_PROTECTED_CONTROLS, THREAD_EXTRAS_REGISTRY } from '../src/extensions/thread-extras-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { THREAD_EXTRAS_ACTION_SURFACES, THREAD_ATTACHMENTS_CONTROLS, THREAD_FIND_CONTROLS, THREAD_CHANGES_CONTROLS, THREAD_LIMIT_CONTROLS, THREAD_EXTRAS_PINNED, THREAD_EXTRAS_FIXED, THREAD_EXTRAS_PROTECTED, THREAD_ATTACHMENTS_LOCATION, THREAD_FIND_LOCATION, THREAD_CHANGES_LOCATION, THREAD_LIMIT_LOCATION, THREAD_EXTRAS_PROTECTED_LOCATION, THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/thread-extras/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.thread-extras/timeline', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.thread.attachments', 'panda.thread.find', 'panda.thread.changes', 'panda.thread.usage-limit', 'src/message-attachments.ts', 'src/turn-changes.ts#open-turn-diff', 'src/usage-limit.ts'];
const CONTROLS = [[THREAD_ATTACHMENTS_LOCATION, THREAD_ATTACHMENTS_CONTROLS], [THREAD_FIND_LOCATION, THREAD_FIND_CONTROLS], [THREAD_CHANGES_LOCATION, THREAD_CHANGES_CONTROLS], [THREAD_LIMIT_LOCATION, THREAD_LIMIT_CONTROLS]];

test('Thread extras registry: each owned member has public locations, operations and an extension hook in its source, and the ledger closes exactly the seven gaps', () => {
  assert.deepEqual(THREAD_EXTRAS_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.thread.attachments', 'src/message-attachments.ts'], ['panda.thread.find', 'src/thread-find.ts'], ['panda.thread.changes', 'src/turn-changes.ts'], ['panda.thread.usage-limit', 'src/usage-limit.ts']]);
  for (const entry of THREAD_EXTRAS_REGISTRY) {
    assert.ok(entry.actions && entry.order && entry.hide && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    const local = entry.member.slice('panda.thread.'.length);
    assert.ok(ledger.families.find(item => item.id === 'panda.thread').members.some(([id, owner]) => id === local && owner === entry.source), entry.member);
    // T60's audit found no extension hook in these four owners; each now carries the adapter's hook.
    assert.match(read(`../${entry.source}`), /extension/i, entry.source);
  }
  assert.deepEqual([...THREAD_EXTRAS_CONTROL_IDS], schema.$defs.threadExtrasControlId.enum);
  const row = ledger.threadCoverage['panda.thread.extras'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.thread.extras'); assert.equal(row.lead, 'T60E');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage') && key !== 'threadCoverage')) for (const [id, entry] of Object.entries(block)) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...THREAD_EXTRAS_CONTROL_IDS]);
  assert.deepEqual(row.attachmentControls, THREAD_ATTACHMENTS_CONTROLS.map(([id]) => id)); assert.deepEqual(row.findControls, THREAD_FIND_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.changesControls, THREAD_CHANGES_CONTROLS.map(([id]) => id)); assert.deepEqual(row.limitControls, THREAD_LIMIT_CONTROLS.map(([id]) => id));
  assert.deepEqual(row.protected, THREAD_EXTRAS_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...THREAD_EXTRAS_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.thread.extras').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.thread.extras').tests.includes('tests/extensions-thread-extras-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-thread-extras-coverage\.spec\.ts/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/thread-extras-host.ts'), ['src/extensions/thread-extras-host.ts', [], 0, 1]);
  assert.ok(ledger.families.find(family => family.id === 'panda.menus').members.some(([id, owner]) => id === 'thread-extras-extension-entry' && owner === 'src/extensions/thread-extras-host.ts'));
  // The ledger's own thread rows stay anchored to their sources.
  for (const local of ['attachments', 'find', 'changes', 'usage-limit']) {
    const [, owner, anchor] = ledger.families.find(family => family.id === 'panda.thread').members.find(([id]) => id === local);
    assert.ok(read(`../${owner}`).includes(anchor), local);
  }
  // Find reads its layout from the adapter; the adoption is mounted once extensions load.
  const main = read('../src/main.ts');
  assert.match(main, /extension: \(\) => threadExtras\?\.findLayout\(\)/);
  assert.match(main, /mountThreadExtrasAdoption\(\{/);
  // Contributed actions never become find matches.
  assert.match(read('../src/thread-find.ts'), /closest\('\.message-actions, \.sr-only, \.extension-action-slot'\)/);
});

test('Thread extras schema, selection kinds, package, catalog operations, protected items and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const [kind, surfaceId, ids] of [['message-attachment', 'panda.thread.attachments.actions', ['1:0', '1:1']], ['find', 'panda.thread.find.actions', ['task-1']], ['turn-changes', 'panda.thread.changes.actions', ['turn-1', 'src/a.ts', 'src/b.ts']], ['usage-limit', 'panda.thread.usage-limit.actions', ['claude']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind));
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids } }).ok, true, kind);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.thread.find.actions', revision: 1, selection: { kind: 'find-query', ids: ['task-1'] } }).ok, false);
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.thread.changes.actions', revision: 1, selection: { kind: 'turn-changes', ids: Array(101).fill('src/a.ts') } }).ok, false);
  // The slots are host markers mounted by thread-actions.ts with their own captured ids, beside the existing thread slots.
  assert.deepEqual([...THREAD_EXTRAS_ACTION_SURFACES], ['panda.thread.attachments.actions', 'panda.thread.find.actions', 'panda.thread.changes.actions', 'panda.thread.usage-limit.actions']);
  for (const location of THREAD_EXTRAS_ACTION_SURFACES) { assert.ok(!THREAD_ACTION_SURFACES.includes(location)); assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  for (const [location] of CONTROLS) { assert.ok(actionLocations.includes(location)); assert.ok(schema.$defs.layoutLocation.anyOf[1].enum.includes(location)); }
  for (const location of [THREAD_EXTRAS_PROTECTED_LOCATION, 'panda.thread', 'panda.thread.attachments']) {
    const forged = structuredClone(manifest); forged.contributes.layouts[0].location = location; assert.equal(validateContract('packages', [forged]).ok, false, location);
  }
  const foreign = structuredClone(manifest); foreign.contributes.layouts[0].rules[0].id = 'panda.thread.find.controls/close'; assert.equal(validateContract('packages', [foreign]).ok, false);
  const noCustomize = structuredClone(manifest); noCustomize.permissions = ['ui.contribute', 'tasks.transcript.read', 'tasks.tools.read']; assert.equal(validateContract('packages', [noCustomize]).ok, false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of THREAD_EXTRAS_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  for (const [location] of CONTROLS) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: THREAD_EXTRAS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  // Pinned controls never hide but still reorder; Dismiss is pinned and fixed: inspect-only.
  for (const [location, controls] of CONTROLS) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) {
      const pinned = THREAD_EXTRAS_PINNED[item.id], fixed = THREAD_EXTRAS_FIXED[item.id];
      assert.deepEqual(item.supportedOperations, pinned && fixed ? ['inspect'] : pinned ? ['inspect', 'reorder'] : fixed ? ['inspect', 'hide', 'show'] : ['inspect', 'hide', 'show', 'reorder'], item.id);
      if (pinned || fixed) assert.match(item.label, / — .{20,}/);
    }
  }
  assert.deepEqual(Object.keys(THREAD_EXTRAS_PINNED), [`${THREAD_FIND_LOCATION}/close`, `${THREAD_CHANGES_LOCATION}/open`, `${THREAD_LIMIT_LOCATION}/continue`, `${THREAD_LIMIT_LOCATION}/dismiss`]);
  assert.deepEqual(Object.keys(THREAD_EXTRAS_FIXED), [`${THREAD_LIMIT_LOCATION}/dismiss`]);
  const protectedItems = catalog.listItems({ location: THREAD_EXTRAS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), THREAD_EXTRAS_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  // The find field is never a layout item.
  const layoutIds = CONTROLS.flatMap(([location, controls]) => controls.map(([id]) => `${location}/${id}`));
  for (const id of ['input', 'query', 'field']) assert.ok(!layoutIds.some(item => item.endsWith(`/${id}`)), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]), [
    ['sample.thread-extras/attachments', 'panda.thread.attachments.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.thread-extras/changes', 'panda.thread.changes.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.thread-extras/find', 'panda.thread.find.actions', ['inspect', 'hide', 'show', 'reorder']],
    ['sample.thread-extras/limit', 'panda.thread.usage-limit.actions', ['inspect', 'hide', 'show', 'reorder']],
  ]);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const id of layoutIds.filter(id => !THREAD_EXTRAS_PINNED[id])) { layout.setVisible(id, false); assert.equal(layout.isHidden(id), true); layout.setVisible(id, true); assert.equal(layout.isHidden(id), false); }
  const kinds = ['file', 'folder'].map(id => `${THREAD_ATTACHMENTS_LOCATION}/${id}`); layout.move(THREAD_ATTACHMENTS_LOCATION, kinds, { id: kinds[1], target: kinds[0], side: 'before' }); assert.equal(layout.order(THREAD_ATTACHMENTS_LOCATION, kinds)[0], kinds[1]);
  // Bounded JSON only: no attachment names, paths, find text, diffs or connection names cross the presentation.
  const state = fixture('state');
  assert.equal(validateContract('threadExtrasPresentation', state).ok, true); assert.equal(validateContract('threadExtrasAction', fixture('action')).ok, true);
  for (const change of [{ controls: Array(257).fill(state.controls[0]) }, { turns: Array(65).fill('turn') }, { selector: '#transcript' }, { query: 'needle' }, { paths: ['/tmp/a'] }, { diff: '+a' }, { window: 'tray' }, { contractVersion: 2 }, { attachments: 257 }, { attachments: -1 }, { provider: 'x'.repeat(257) }]) assert.equal(validateContract('threadExtrasPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: 'Continue on Work account' }, { path: '/tmp/a' }]) assert.equal(validateContract('threadExtrasPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  assert.throws(() => snapshotThreadExtras({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});

test('Thread extras bind owner/window/mount/project/task/revision, attachment, turn, limit and connection resources, busy, hidden, protected controls and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createThreadExtrasControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  // Another turn, another control or another connection is another target; so is a turn whose card left.
  for (const change of [{ control: 'foreign' }, { controlId: 'changes-run' }, { resource: 'turn-b' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.resource !== 'turn-a') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  const sw = fixture('state').controls.find(control => control.controlId === 'limit-switch');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => control.id === sw.id ? { ...control, resource: 'connection-b' } : control) };
  assert.equal(slot.dispatch({ ...fixture('action'), control: sw.id, controlId: sw.controlId, resource: sw.resource, requestId: 'switch' }).reason, 'StaleContext'); live = fixture('state');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, enabled: false })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: true })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/timeline'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.thread-extras/timeline';
  // Reading attachment contents, setting the find text, reading diffs and assigning a connection or provider are named
  // as protected and never run.
  for (const controlId of THREAD_EXTRAS_PROTECTED_CONTROLS) for (const control of ['control-open', 'control-switch', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, path: '/tmp/a' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '#transcript' }, { controlId: 'find-open' }, { query: 'needle' }, { path: '/tmp/a' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0]));
});

test('Thread extras never open an attachment, run the project or change the limit or connection without a fresh host choice, and no protected behavior is a public control', () => {
  const state = fixture('state');
  for (const control of state.controls.filter(item => THREAD_EXTRAS_CHOICE_CONTROLS.includes(item.controlId))) {
    const slot = createThreadExtrasControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource }).reason, 'PermissionDenied', control.controlId);
  }
  // Stepping or closing find and opening the host's diff viewer need no choice: the user acts there.
  const opened = [], slot = createThreadExtrasControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => opened.push(action.controlId));
  for (const control of state.controls.filter(item => !THREAD_EXTRAS_CHOICE_CONTROLS.includes(item.controlId))) assert.deepEqual(slot.dispatch({ ...fixture('action'), control: control.id, controlId: control.controlId, resource: control.resource, requestId: control.id }), { ok: true });
  assert.deepEqual(opened, ['find-previous', 'find-next', 'find-close', 'changes-open', 'changes-file']);
  for (const id of [...THREAD_EXTRAS_PROTECTED.map(([id]) => id), ...THREAD_EXTRAS_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.threadExtrasControlId.enum.includes(id), id);
  assert.deepEqual(THREAD_EXTRAS_CHOICE_CONTROLS, ['attachment-open', 'changes-run', 'limit-continue', 'limit-switch', 'limit-dismiss', 'limit-resume']);
});
