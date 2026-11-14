import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBoardPresentation, snapshotBoard } from '../src/extensions/board.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection, validSlotProps } from '../src/extensions/component-slot.ts';
import { BOARD_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/board/${name}.json`, import.meta.url), 'utf8'));
test('Board schema, selected closed recipe, catalog and reversible member layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'raw-task'] }, { presentation: 'cards' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.board', [provider]), undefined);
  selection.select('panda.board', provider.id, [provider]); assert.equal(selection.resolve('panda.board', [provider]), provider);
  assert.equal(selection.resolve('panda.board', []), undefined);
  assert.equal(validSlotProps({ contractVersion: 1, slot: 'panda.board', context: '', revision: 0, objects: [], state: { selected: '', focused: '', loading: false, offline: false, visible: true } }), false);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const [location, controls] of Object.entries(BOARD_CONTROLS)) {
    const items = catalog.listItems({ location }).items;
    assert.deepEqual(items.map(item => item.id), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  for (const change of [{ rows: Array(501).fill(fixture('state').rows[0]) }, { rows: [{ ...fixture('state').rows[0], title: 'x'.repeat(201) }] }, { selector: 'body' }, { window: 'tray' }, { contractVersion: 2 }]) assert.equal(validateContract('boardPresentation', { ...fixture('state'), ...change }).ok, false);
  assert.throws(() => snapshotBoard({ ...fixture('state'), rows: Array(2).fill(fixture('state').rows[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-board-coverage\.spec\.ts/);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  const members = ledger.boardCoverage['panda.workspace.views.board'].members;
  const source = readFileSync(new URL('../src/task-board.ts', import.meta.url), 'utf8');
  const names = { 'add-project': 'open-project', 'filter-projects': 'filter', 'board-complete': 'settle' };
  const actions = [...source.matchAll(/(?:data-action="|button\(')([a-z-]+)/g)].map(match => names[match[1]] ?? match[1].replace('board-', ''));
  assert.ok(actions.every(id => members.includes(id)));
  for (const [location, controls] of Object.entries(BOARD_CONTROLS)) assert.deepEqual(ledger.boardCoverage[location].members.slice().sort(), controls.map(([id]) => id).sort());
});
test('Board binds window/project/task/filter/row/stage revisions, consent and replay', () => {
  let live = fixture('state'); const auth = { owner: 'sample.board/review', active: true, granted: true, taskControl: true }, calls = [];
  const slot = createBoardPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.rows[0]));
  for (const key of ['context', 'project', 'task', 'filter', 'revision']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext');
    live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ row: 'foreign' }, { rowProject: 'foreign' }, { rowRevision: 9 }, { stage: 'review' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  for (const change of [{ loading: true }, { busy: true }, { rows: [{ ...live.rows[0], running: true }] }, { rows: [{ ...live.rows[0], busy: true }] }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); }
  live = fixture('state'); auth.taskControl = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.taskControl = true;
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/review'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.board/review';
  for (const change of [{ selector: 'body' }, { controlId: 'delete' }, { window: 'tray' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'row', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true;
  slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
test('Board retains original stage semantics, selected-detail restrictions and original import opt-in', () => {
  for (const [stage, controls] of [['pending', ['start', 'edit', 'open']], ['in_progress', ['retry', 'edit', 'open']], ['review', ['settle', 'edit', 'open']], ['completed', ['reopen', 'edit', 'open']]]) {
    const state = fixture('state'); state.rows[0].stage = stage;
    for (const controlId of ['open', 'edit', 'start', 'retry', 'settle', 'reopen']) {
      const slot = createBoardPresentation(state, 'owner', () => state, () => ({ owner: 'owner', active: true, granted: true, taskControl: true }), () => {});
      const result = slot.dispatch({ ...fixture('action'), stage, controlId }); assert.equal(result.ok, controls.includes(controlId), `${stage}/${controlId}`);
    }
  }
  const state = fixture('state'), auth = { owner: 'owner', active: true, granted: true, taskControl: true };
  for (const controlId of ['add', 'filter', 'open-project', 'close', 'import']) {
    const slot = createBoardPresentation(state, auth.owner, () => state, () => auth, () => {});
    const action = { ...fixture('action'), row: '', rowProject: '', rowRevision: 0, stage: '', controlId };
    assert.equal(slot.dispatch(action).ok, controlId !== 'import');
  }
  const archived = { ...state, rows: [{ ...state.rows[0], archived: true, stage: 'completed' }] };
  const slot = createBoardPresentation(archived, auth.owner, () => archived, () => auth, () => {});
  assert.equal(slot.dispatch({ ...fixture('action'), stage: 'completed', controlId: 'reopen' }).ok, true);
  assert.equal(slot.dispatch({ ...fixture('action'), stage: 'completed', controlId: 'edit', requestId: 'edit' }).reason, 'UnsupportedCapability');
});
