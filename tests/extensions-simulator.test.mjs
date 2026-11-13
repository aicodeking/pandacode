import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSimulatorPresentation } from '../src/extensions/simulator.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { SIMULATOR_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/simulator/${name}.json`, import.meta.url), 'utf8'));
test('Simulator public schema, selected closed recipe and fourteen catalogued controls are registered', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  const values = new Map(), selection = createComponentSelection({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  assert.equal(selection.resolve('panda.simulator', [provider]), undefined);
  selection.select('panda.simulator', provider.id, [provider]); assert.equal(selection.resolve('panda.simulator', [provider]), provider);
  assert.equal(selection.resolve('panda.simulator', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  const items = catalog.listItems({ location: 'panda.simulator.controls' }).items;
  assert.deepEqual(items.map(item => item.id), SIMULATOR_CONTROLS['panda.simulator.controls'].map(([id]) => `panda.simulator.controls/${id}`).sort());
  const storage = new Map(), layout = createLayoutStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  for (const item of items) {
    layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true);
    layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false);
  }
  for (const controls of [['power', 'back', 'home', 'recents', 'lock', 'pose', 'appearance', 'capture', 'finish'], ['add-duo', 'android-setup']]) {
    const ids = controls.map(id => `panda.simulator.controls/${id}`);
    layout.move('panda.simulator.controls', ids, { id: ids.at(-1), target: ids[0], side: 'before' });
    assert.deepEqual(layout.order('panda.simulator.controls', ids), [ids.at(-1), ...ids.slice(0, -1)]);
  }
  for (const change of [{ devices: Array(65).fill(fixture('state').devices[0]) }, { error: 'x'.repeat(513) }, { screen: 'raw' }, { controls: [{ id: 'execute', enabled: true, reason: '', values: [] }] }]) assert.equal(validateContract('simulatorPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-simulator-coverage\.spec\.ts/);
});
test('Simulator captures device/platform/project/session/revision and rejects stale, unsupported, busy, forged, replay and revoked actions', () => {
  let live = fixture('state'), auth = { owner: 'sample.simulator/controls', active: true, granted: true }; const calls = [];
  const slot = createSimulatorPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.devices[0]));
  for (const key of ['context', 'project', 'session', 'device', 'platform', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'platform' ? 'ios' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext');
    live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const [change, reason] of [[{ controlId: 'pose' }, 'UnsupportedCapability'], [{ ipc: 'raw' }, 'InvalidArguments'], [{ controlId: 'device', value: 'forged' }, 'InvalidArguments'], [{ value: 'raw' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  for (const change of [{ busy: true }, { loading: true }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); }
  live = { ...fixture('state'), error: 'Offline' }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability');
  live = { ...fixture('state'), visible: false }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign.owner/controls'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.simulator/controls';
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'value', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true;
  slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
