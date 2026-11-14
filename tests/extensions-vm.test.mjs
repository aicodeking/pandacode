import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createVmPresentation } from '../src/extensions/vm.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { VM_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/vm/${name}.json`, import.meta.url), 'utf8'));
test('VM public schema, selected closed recipe and every catalogued control are registered', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'raw-input'] }, { contractVersion: 2 }, { presentation: 'cards' }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage);
  assert.equal(selection.resolve('panda.vm', [provider]), undefined);
  selection.select('panda.vm', provider.id, [provider]); assert.equal(selection.resolve('panda.vm', [provider]), provider);
  assert.equal(selection.resolve('panda.vm', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] })), items = catalog.listItems({ location: 'panda.vm.controls' }).items;
  assert.deepEqual(items.map(item => item.id), VM_CONTROLS['panda.vm.controls'].map(([id]) => `panda.vm.controls/${id}`).sort());
  const layout = createLayoutStore(storage);
  for (const item of items) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
  const ids = ['power', 'share', 'new'].map(id => `panda.vm.controls/${id}`);
  layout.move('panda.vm.controls', ids, { id: ids[2], target: ids[0], side: 'before' }); assert.deepEqual(layout.order('panda.vm.controls', ids), [ids[2], ids[0], ids[1]]);
  for (const change of [{ machines: Array(65).fill(fixture('state').machines[0]) }, { error: 'x'.repeat(513) }, { frame: 'raw' }, { controls: [{ id: 'execute', enabled: true, reason: '', values: [] }] }]) assert.equal(validateContract('vmPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-vm-coverage\.spec\.ts/);
});
test('VM captures local/cloud machine, connection, project, session and revision; rejects replay, raw input, wrong owner and revocation', () => {
  let live = fixture('state'), auth = { owner: 'sample.vm/controls', active: true, granted: true }; const calls = [];
  const slot = createVmPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.machines[0]));
  for (const key of ['context', 'project', 'session', 'machine', 'connection', 'platform', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'platform' ? 'local' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext');
    live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const [change, reason] of [[{ controlId: 'suspend' }, 'UnsupportedCapability'], [{ ipc: 'raw' }, 'InvalidArguments'], [{ input: { action: 'type' } }, 'InvalidArguments'], [{ controlId: 'select', value: 'native-id' }, 'InvalidArguments'], [{ value: 'writeable' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  for (const change of [{ busy: true }, { loading: true }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); }
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign.owner/controls'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.vm/controls';
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'value', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true;
  slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
