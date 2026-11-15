import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTaskMenusControls, snapshotTaskMenus, TASK_MENUS_CONTROL_IDS, TASK_MENUS_CHOICE_CONTROLS, TASK_MENUS_PROTECTED_CONTROLS, TASK_MENUS_REGISTRY } from '../src/extensions/task-menus-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility } from '../src/extensions/component-slot.ts';
import { TASK_MENUS_ACTION_SURFACES, TASK_MENUS_ENTRIES, TASK_MENUS_PINNED, TASK_MENUS_PROTECTED, TASK_MENUS_PROTECTED_LOCATION } from '../src/extensions/surfaces.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/task-menus/${name}.json`, import.meta.url), 'utf8'));
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const authority = (changes = {}) => ({ owner: 'sample.task-menus/toolbar', active: true, granted: true, userChoice: true, ...changes });
const GAPS = ['panda.menus.team', 'panda.menus.task', 'panda.menus.deploy', 'panda.menus.bot-assignment', 'src/main.ts#architect-setup', 'src/main.ts#team-menu', 'src/main.ts#bot-task-menu'];

test('Task menus registry: each owned member has public locations and operations, a hook in main.ts, and the ledger closes exactly the seven gaps', () => {
  assert.deepEqual(TASK_MENUS_REGISTRY.map(entry => [entry.member, entry.source]), [['panda.menus.team', 'src/main.ts'], ['panda.menus.task', 'src/main.ts'], ['panda.menus.deploy', 'src/main.ts'], ['panda.menus.bot-assignment', 'src/main.ts']]);
  const menus = ledger.families.find(item => item.id === 'panda.menus').members;
  for (const entry of TASK_MENUS_REGISTRY) {
    assert.ok(entry.actions && entry.reason.length > 80, entry.member);
    for (const location of entry.locations) assert.ok(ledger.catalog.surfaces.includes(location), location);
    assert.ok(menus.some(([id, owner]) => `panda.menus.${id}` === entry.member && owner === entry.source), entry.member);
  }
  // Every host menu passes an extension surface with its captured target; the setup mounts its slot.
  const main = read('../src/main.ts');
  assert.match(main, /mountTaskMenusAdoption\(\{/);
  for (const [location, kind] of [['panda.team.menu', 'team'], ['panda.task.menu', 'task'], ['panda.bot.assignment', 'bot']]) assert.ok(main.includes(`taskMenus?.surface('${location}', { kind: '${kind}'`), location);
  assert.ok(main.includes("taskMenus?.surface('panda.deploy.menu', connected.length ? { kind: 'connection', ids: connected }"));
  assert.match(main, /taskMenus\?\.mountSetup\(setupPanel, task\.id/);
  assert.deepEqual([...TASK_MENUS_CONTROL_IDS], schema.$defs.taskMenusControlId.enum);
  const row = ledger.taskMenusCoverage['panda.menus.task'];
  assert.equal(row.status, 'implemented-experimental'); assert.equal(row.adapter, 'panda.menus.task'); assert.equal(row.lead, 'T60H');
  assert.deepEqual(row.closes, GAPS);
  // No gap is closed twice: every other coverage block keeps its own keys.
  for (const [key, block] of Object.entries(ledger).filter(([key]) => key.endsWith('Coverage'))) for (const [id, entry] of Object.entries(block)) if (!(key === 'taskMenusCoverage' && id === 'panda.menus.task')) assert.equal([entry?.closes ?? []].flat().filter(gap => GAPS.includes(gap)).length, 0, `${key}.${id}`);
  assert.deepEqual(row.members, [...TASK_MENUS_CONTROL_IDS]);
  assert.deepEqual(row.teamEntries, TASK_MENUS_ENTRIES['panda.team.menu'].map(([id]) => id)); assert.deepEqual(row.taskEntries, TASK_MENUS_ENTRIES['panda.task.menu'].map(([id]) => id)); assert.deepEqual(row.deployEntries, TASK_MENUS_ENTRIES['panda.deploy.menu'].map(([id]) => id));
  assert.deepEqual(row.pinned, Object.keys(TASK_MENUS_PINNED));
  assert.deepEqual(row.protected, TASK_MENUS_PROTECTED.map(([id]) => id)); assert.deepEqual(row.protectedControls, [...TASK_MENUS_PROTECTED_CONTROLS]);
  for (const field of ['action', 'control', 'context', 'visibility', 'order', 'conflict', 'move', 'replacement', 'boundary']) assert.ok(row[field]?.length > 40, field);
  for (const path of row.evidence) assert.doesNotThrow(() => read(`../${path}`), path);
  assert.equal(ledger.implementedAdapters.filter(adapter => adapter.id === 'panda.menus.task').length, 1);
  assert.ok(ledger.implementedAdapters.find(adapter => adapter.id === 'panda.menus.task').tests.includes('tests/extensions-task-menus-coverage.spec.ts'));
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(read(path), /extensions-task-menus-coverage\.spec\.ts/);
  assert.match(read('../playwright.webkit.config.ts'), /\|Task menus extension:/);
  assert.deepEqual(ledger.sourceInventory.find(([owner]) => owner === 'src/extensions/task-menus-host.ts'), ['src/extensions/task-menus-host.ts', [], 0, 1]);
  assert.ok(menus.some(([id, owner]) => id === 'task-menus-extension-entry' && owner === 'src/extensions/task-menus-host.ts'));
  // The original menus keep their members, anchors and handlers in main.ts.
  for (const local of ['team', 'task', 'deploy', 'bot-assignment']) { const [, owner, anchor] = menus.find(([id]) => id === local); assert.ok(read(`../${owner}`).includes(anchor), local); }
  for (const handler of ['async function chooseTeam(', 'async function startDeploy(', 'async function assignTaskBot(', 'function taskMenuItems(']) assert.ok(main.includes(handler), handler);
  // Package requests never carry text or bytes: the host builds contexts from ids and revisions.
  const host = read('../src/extensions/task-menus-host.ts');
  assert.doesNotMatch(host, /data-action/); assert.doesNotMatch(host, /\.value\b(?!,)/); assert.doesNotMatch(host, /textContent|innerText|HTMLTextAreaElement|#prompt/);
});

test('Task menus manifests and contracts: the fixture validates, locations and selection kinds are public and the protected location is not a layout target', () => {
  const manifest = fixture('extension');
  assert.equal(validateContract('packages', [manifest]).ok, true);
  for (const component of manifest.contributes.components) assert.equal(componentIncompatibility(component), undefined, component.id);
  assert.deepEqual(manifest.contributes.menus.map(menu => menu.location), [...TASK_MENUS_ACTION_SURFACES]);
  for (const location of TASK_MENUS_ACTION_SURFACES) { assert.ok(schema.$defs.actionLocation.enum.includes(location), location); assert.ok(actionLocations.includes(location), location); }
  assert.ok(!schema.$defs.actionLocation.enum.includes(TASK_MENUS_PROTECTED_LOCATION) && !schema.$defs.layoutLocation.anyOf[1].enum.includes(TASK_MENUS_PROTECTED_LOCATION));
  for (const [kind, surfaceId, ids] of [['team', 'panda.team.menu', ['task-1']], ['team', 'panda.team.setup.actions', ['task-1']], ['task', 'panda.task.menu', ['task-1']], ['connection', 'panda.deploy.menu', ['vercel', 'netlify']], ['bot', 'panda.bot.assignment', ['bot-1', 'bot-2']]]) {
    assert.ok(schema.$defs.context.properties.selection.properties.kind.enum.includes(kind), kind);
    assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId, projectId: 'project-1', sessionId: 'task-1', revision: 1, selection: { kind, ids } }).ok, true, surfaceId);
  }
  assert.equal(validateContract('context', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.deploy.menu', revision: 1, selection: { kind: 'credential', ids: ['vercel'] } }).ok, false);
  const forged = structuredClone(manifest); forged.contributes.layouts[0].location = TASK_MENUS_PROTECTED_LOCATION; assert.equal(validateContract('packages', [forged]).ok, false);
  const foreignRule = structuredClone(manifest); foreignRule.contributes.layouts[0].rules[0].id = 'panda.task.menu/rename'; assert.equal(validateContract('packages', [foreignRule]).ok, false);
  const state = fixture('state'), action = fixture('action');
  assert.equal(validateContract('taskMenusPresentation', state).ok, true); assert.equal(validateContract('taskMenusAction', action).ok, true);
  for (const field of ['selector', 'ipc', 'text', 'token', 'credential', 'name', 'draft']) {
    assert.equal(validateContract('taskMenusAction', { ...action, [field]: 'raw' }).ok, false, field);
    assert.equal(validateContract('taskMenusPresentation', { ...state, [field]: 'raw' }).ok, false, field);
  }
  for (const controlId of TASK_MENUS_PROTECTED_CONTROLS) assert.equal(validateContract('taskMenusAction', { ...action, controlId }).ok, false, controlId);
  for (const change of [{ controls: Array(65).fill(state.controls[0]) }, { menu: 'console' }, { window: 'tray' }, { contractVersion: 2 }, { team: 7 }]) assert.equal(validateContract('taskMenusPresentation', { ...state, ...change }).ok, false, JSON.stringify(change).slice(0, 40));
  for (const extra of [{ label: 'Vercel' }, { name: 'vercel' }, { token: 'x' }]) assert.equal(validateContract('taskMenusPresentation', { ...state, controls: [{ ...state.controls[0], ...extra }] }).ok, false);
  // The SDK declares the same shapes; the native mirror is checked by contracts.rs and packages.rs.
  const sdk = read('../src/extensions/sdk/index.d.ts');
  assert.match(sdk, /export type TaskMenusControl = 'team-select' \| 'team-setup-open' \| 'task-run' \| 'task-delete' \| 'deploy-run' \| 'bot-assign';/);
  assert.match(sdk, /export type TaskMenusSelectionKind = 'team' \| 'task' \| 'connection' \| 'bot';/);
  assert.match(read('../src-tauri/src/extensions/contracts.rs'), /"taskMenusPresentation", "taskMenusAction"/);
  assert.match(read('../src-tauri/src/extensions/packages.rs'), /fn task_menus_archive_install_restart_disable_and_safe_mode/);
});

test('Task menus catalog: eligible entries hide and reorder, pinned and protected ones are inspect-only with their reason, layouts are reversible', () => {
  const manifest = fixture('extension');
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const location of TASK_MENUS_ACTION_SURFACES) assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder'], location);
  assert.deepEqual(catalog.listSurfaces({ location: TASK_MENUS_PROTECTED_LOCATION }).items[0].supportedOperations, ['inspect']);
  for (const [location, entries] of Object.entries(TASK_MENUS_ENTRIES)) {
    const items = catalog.listItems({ location, limit: 100 }).items;
    assert.deepEqual(items.map(item => item.id).sort(), entries.map(([id]) => `${location}/${id}`).sort(), location);
    for (const item of items) assert.deepEqual(item.supportedOperations, ['inspect', 'hide', 'show', 'reorder'], item.id);
  }
  // Pinned and protected entries are never layout items; each carries its reason.
  const protectedItems = catalog.listItems({ location: TASK_MENUS_PROTECTED_LOCATION, limit: 100 }).items;
  assert.deepEqual(protectedItems.map(item => item.id.split('/')[1]).sort(), TASK_MENUS_PROTECTED.map(([id]) => id).sort());
  for (const item of protectedItems) { assert.deepEqual(item.supportedOperations, ['inspect']); assert.match(item.label, / — .{20,}/); }
  for (const id of Object.keys(TASK_MENUS_PINNED)) { const [location, entry] = [id.slice(0, id.lastIndexOf('/')), id.slice(id.lastIndexOf('/') + 1)]; assert.ok(!TASK_MENUS_ENTRIES[location].some(([local]) => local === entry), id); assert.ok(TASK_MENUS_PINNED[id].length > 30, id); }
  // Destructive, deploying and credential rows are protected: never layout items.
  for (const id of ['delete-task', 'harness-console', 'off', 'none']) assert.ok(!Object.values(TASK_MENUS_ENTRIES).flat().some(([local]) => local === id), id);
  const installed = createUiCatalog(() => ({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }] }));
  assert.deepEqual(installed.listItems({ owner: manifest.id, limit: 100 }).items.map(item => [item.id, item.location, item.supportedOperations]).sort(([a], [b]) => a.localeCompare(b)), manifest.contributes.menus.map(menu => [menu.id, menu.location, ['inspect', 'hide', 'show', 'reorder']]).sort(([a], [b]) => a.localeCompare(b)));
  assert.deepEqual(createUiCatalog(() => ({ safeMode: true, packages: [] })).listItems({ location: 'panda.task.menu' }).items.length, TASK_MENUS_ENTRIES['panda.task.menu'].length);
  const values = new Map(), layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const [location, entries] of Object.entries(TASK_MENUS_ENTRIES)) for (const [id] of entries) { const full = `${location}/${id}`; layout.setVisible(full, false); assert.equal(layout.isHidden(full), true); layout.setVisible(full, true); assert.equal(layout.isHidden(full), false); }
  const entries = ['cheapest', 'quality'].map(id => `panda.team.menu/${id}`); layout.move('panda.team.menu', entries, { id: entries[1], target: entries[0], side: 'before' }); assert.equal(layout.order('panda.team.menu', entries)[0], entries[1]);
});

test('Task menus bind owner/window/mount/project/task/team/connection/bot/revision; protected, busy, hidden, choice and replay', () => {
  let live = fixture('state'); const auth = authority(), calls = [];
  const slot = createTaskMenusControls(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.controls[0]));
  for (const key of ['context', 'project', 'task', 'team', 'connection', 'bot', 'revision']) {
    const value = key === 'revision' ? 6 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext', key); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext', key); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { controlId: 'bot-assign' }, { resource: 'resource-aws' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  live = { ...fixture('state'), controls: fixture('state').controls.filter(control => control.controlId !== 'deploy-run') }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext');
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), menu: 'deploy', busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = { ...fixture('state'), controls: fixture('state').controls.map(control => ({ ...control, hidden: control.controlId === 'deploy-run' })) }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); live = fixture('state');
  // A disabled control (Delete task while the agent runs) is unsupported, never forced.
  assert.equal(slot.dispatch({ ...fixture('action'), control: 'control-delete', controlId: 'task-delete', resource: 'resource-delete' }).reason, 'UnsupportedCapability');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/toolbar'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.task-menus/toolbar';
  // Saving a team, profiles, the harness console, connections and credentials and bot settings are named and never run.
  for (const controlId of TASK_MENUS_PROTECTED_CONTROLS) for (const control of ['control-vercel', 'foreign']) assert.equal(slot.dispatch({ ...fixture('action'), control, controlId, token: 'x' }).reason, 'PermissionDenied', controlId);
  for (const change of [{ selector: '.deploy' }, { controlId: 'deploy-now' }, { text: 'hello' }, { token: 'x' }, { window: 'tray' }, { requestId: '' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch({ ...fixture('action'), requestId: 'other' }).reason, 'Revoked');
  assert.equal(calls.length, 1); assert.ok(Object.isFrozen(calls[0])); assert.equal(calls[0].controlId, 'deploy-run');
  // Choosing a team, deleting a task, deploying and assigning a bot need the fresh host choice; opening the setup and the
  // plain task entries act on what the user already sees.
  assert.deepEqual([...TASK_MENUS_CHOICE_CONTROLS], ['team-select', 'task-delete', 'deploy-run', 'bot-assign']);
  const state = fixture('state'), guarded = createTaskMenusControls(state, 'owner', () => state, () => authority({ owner: 'owner', userChoice: false }), action => assert.ok(!TASK_MENUS_CHOICE_CONTROLS.includes(action.controlId)));
  for (const [control, controlId, resource] of [['control-team-balanced', 'team-select', 'resource-balanced'], ['control-vercel', 'deploy-run', 'resource-vercel'], ['control-bot', 'bot-assign', 'resource-bot']]) assert.equal(guarded.dispatch({ ...fixture('action'), control, controlId, resource, requestId: control }).reason, 'PermissionDenied', controlId);
  for (const [control, controlId, resource] of [['control-setup', 'team-setup-open', 'resource-setup'], ['control-rename', 'task-run', 'resource-rename']]) assert.deepEqual(guarded.dispatch({ ...fixture('action'), control, controlId, resource, requestId: control }), { ok: true });
  for (const id of [...TASK_MENUS_PROTECTED.map(([id]) => id).filter(id => !TASK_MENUS_CHOICE_CONTROLS.includes(id)), ...TASK_MENUS_PROTECTED_CONTROLS]) assert.ok(!schema.$defs.taskMenusControlId.enum.includes(id), id);
  assert.throws(() => snapshotTaskMenus({ ...state, controls: Array(2).fill(state.controls[0]) }), /Duplicate/);
});
