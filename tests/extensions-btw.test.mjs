import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBtwPresentation, snapshotBtw } from '../src/extensions/btw.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { BTW_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/btw/${name}.json`, import.meta.url), 'utf8'));
test('BTW public manifest, bounded JSON contract, explicit compatible recipe and exact controls', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'approve'] }, { contractVersion: 2 }, { presentation: 'toolbar-first' }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const values = new Map(), selection = createComponentSelection({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  assert.equal(selection.resolve('panda.btw', [provider]), undefined);
  selection.select('panda.btw', provider.id, [provider]); assert.equal(selection.resolve('panda.btw', [provider]), provider);
  assert.equal(selection.resolve('panda.btw', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  const layout = createLayoutStore({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  for (const location of Object.keys(BTW_CONTROLS)) {
    const items = catalog.listItems({ location }).items;
    for (const item of items.filter(item => item.supportedOperations.includes('hide'))) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id);
    if (ids.length > 1) { layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.deepEqual(layout.order(location, ids).slice(0, 2), [ids[1], ids[0]]); }
  }
  for (const id of ['focus', 'stop']) assert.deepEqual(catalog.listItems({ location: 'panda.btw.controls' }).items.find(item => item.id.endsWith(`/${id}`)).supportedOperations, ['inspect']);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  for (const [location, controls] of Object.entries(BTW_CONTROLS)) assert.deepEqual(ledger.btwCoverage[location].members.slice().sort(), controls.map(([id]) => id).sort());
  for (const [location, controls] of Object.entries(BTW_CONTROLS)) assert.deepEqual(catalog.listItems({ location }).items.map(item => item.id), controls.map(([id]) => `${location}/${id}`).sort());
  for (const key of ['text', 'draftText', 'attachments', 'selector', 'html', 'ipc']) assert.equal(validateContract('btwPresentation', { ...fixture('state'), [key]: 'raw' }).ok, false);
  assert.throws(() => snapshotBtw({ ...fixture('state'), main: 'side-a' }));
  assert.equal(validateContract('btwPresentation', { ...fixture('state'), messages: Array(1001).fill('a') }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-btw-coverage\.spec\.ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /\|btw:/);
});
test('BTW main/side/project/revision capture, independent grants, cancellation and exactly-once admission', () => {
  let live = fixture('state'), auth = { owner: 'sample.btw/conversation', active: true, content: true, taskControl: true }; const calls = [];
  const slot = createBtwPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.messages));
  for (const key of ['context', 'project', 'main', 'side', 'revision']) {
    const value = key === 'revision' ? 99 : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext');
    live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  assert.equal(slot.dispatch({ ...fixture('action'), window: 'foreign' }).reason, 'InvalidArguments');
  auth.taskControl = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied');
  auth.taskControl = true; auth.content = false;
  const insert = { ...fixture('action'), controlId: 'insert', resource: 'answer-a', requestId: 'insert-a' };
  assert.equal(slot.dispatch(insert).reason, 'PermissionDenied'); auth.content = true;
  assert.equal(slot.dispatch({ ...insert, resource: 'main-answer' }).reason, 'StaleContext');
  for (const controlId of ['approval-allow', 'mode', 'execute']) assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'resource', { get() { throw Error('must not evaluate'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  live = { ...live, busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); live = fixture('state');
  assert.equal(slot.dispatch({ ...fixture('action'), controlId: 'queue-save', resource: 'foreign' }).reason, 'StaleContext');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  assert.deepEqual(slot.dispatch(insert), { ok: true }); assert.equal(calls.length, 2);
  auth.owner = 'foreign.owner/component'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.btw/conversation';
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true;
  slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
});
