import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDesignPresentation } from '../src/extensions/design.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { DESIGN_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/design/${name}.json`, import.meta.url), 'utf8'));
test('Design public schema, explicit recipe, exact catalog and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'raw-frame'] }, { contractVersion: 2 }, { presentation: 'cards' }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage);
  assert.equal(selection.resolve('panda.design', [provider]), undefined);
  selection.select('panda.design', provider.id, [provider]); assert.equal(selection.resolve('panda.design', [provider]), provider);
  assert.equal(selection.resolve('panda.design', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] })), items = catalog.listItems({ location: 'panda.design.controls' }).items;
  assert.deepEqual(items.map(item => item.id), DESIGN_CONTROLS['panda.design.controls'].map(([id]) => `panda.design.controls/${id}`).sort());
  const layout = createLayoutStore(storage);
  for (const item of items) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
  const ids = ['out', 'fit', 'in'].map(id => `panda.design.controls/${id}`);
  layout.move('panda.design.controls', ids, { id: ids[1], target: ids[0], side: 'before' }); assert.deepEqual(layout.order('panda.design.controls', ids), [ids[1], ids[0], ids[2]]);
  for (const change of [{ artboards: Array(101).fill(fixture('state').artboards[0]) }, { comments: Array(501).fill(fixture('state').comments[0]) }, { error: 'x'.repeat(513) }, ...['selector', 'html', 'frame', 'text', 'ipc'].map(key => ({ [key]: 'raw' }))]) assert.equal(validateContract('designPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-design-coverage\.spec\.ts/);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  assert.deepEqual(ledger.designCoverage['panda.inspector.design'].members.slice().sort(), DESIGN_CONTROLS['panda.design.controls'].map(([id]) => id).sort());
  const source = readFileSync(new URL('../src/design-canvas.ts', import.meta.url), 'utf8');
  const captured = [...source.matchAll(/data-design="([a-z-]+)"/g)].map(match => match[1] === 'send' ? 'compose' : match[1] === 'toggle' ? 'resolve' : match[1]);
  assert.ok(captured.every(id => ledger.designCoverage['panda.inspector.design'].members.includes(id)));
});
test('Design captures owner/grant/project/task/selection/resources and rejects replay, stale, raw or unsupported requests', () => {
  let live = fixture('state'), auth = { owner: 'sample.design/comments', active: true, granted: true }; const calls = [];
  const slot = createDesignPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.comments[0]));
  for (const key of ['context', 'project', 'session', 'revision', 'selection']) {
    const value = key === 'revision' ? 4 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext');
    live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const key of ['artboard', 'comment', 'resourceRevision']) assert.equal(slot.dispatch({ ...fixture('action'), [key]: 'foreign' }).reason, 'StaleContext');
  live = { ...live, comments: [{ ...live.comments[0], revision: 'changed' }] }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  for (const [change, reason] of [[{ controlId: 'save' }, 'UnsupportedCapability'], [{ controlId: 'execute' }, 'InvalidArguments'], [{ selector: 'body' }, 'InvalidArguments'], [{ x: 6001 }, 'InvalidArguments'], [{ value: 'raw' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  for (const change of [{ busy: true }, { loading: true }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); }
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign.owner/comments'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.design/comments';
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'value', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true;
  slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
test('Design selection/pan admit only bounded host operations and matching artboard revisions', () => {
  const state = fixture('state'), calls = [], auth = { owner: 'sample.design/comments', active: true, granted: true };
  const slot = createDesignPresentation(state, auth.owner, () => state, () => auth, action => calls.push(action));
  const select = { ...fixture('action'), controlId: 'select', comment: '', resourceRevision: 'board-rev-a', x: 50, y: 150 };
  assert.equal(slot.dispatch({ ...select, resourceRevision: 'foreign' }).reason, 'StaleContext');
  assert.equal(slot.dispatch({ ...select, x: -1 }).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(select), { ok: true });
  const pan = { ...fixture('action'), artboard: '', comment: '', resourceRevision: '', controlId: 'pan', value: 'left', requestId: 'pan-a' };
  assert.equal(slot.dispatch({ ...pan, value: 'script' }).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...pan, x: 1 }).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(pan), { ok: true }); assert.equal(calls.length, 2);
});
