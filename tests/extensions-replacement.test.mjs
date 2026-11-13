import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createComponentSlot, createComponentSelection, validSlotProps, REPLACEMENT_KEY } from '../src/extensions/component-slot.ts';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/replacement/extension.json', import.meta.url), 'utf8'));
const providers = manifest.contributes.components;
const props = (slot = 'panda.projects', directory = false) => ({ contractVersion: 1, slot, context: 'project:A/task:one', revision: 7, objects: [{ id: 'one', label: 'One', revision: 3, directory }], state: { selected: 'one', focused: 'one', loading: false, offline: false, visible: true } });
const action = kind => ({ contractVersion: 1, kind, id: 'one', objectRevision: 3, revision: 7, context: 'project:A/task:one' });
test('component manifests validate ownership, bounded data, no code or unsupported template/actions', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  for (const change of [{ id: 'other.owner/stolen' }, { presentation: 'html' }, { actions: ['delete'] }, { render: 'function(){}' }]) {
    const value = structuredClone(manifest); Object.assign(value.contributes.components[0], change); assert.equal(validateContract('packages', [value]).ok, false);
  }
});
test('explicit component selection persists; conflicts, missing owner, incompatible versions use built-in', () => {
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const selection = createComponentSelection(storage), other = { ...providers[0], id: 'other.cards/projects' }, competing = [...providers, other];
  assert.equal(selection.resolve('panda.projects', competing), undefined);
  selection.select('panda.projects', other.id, competing);
  assert.equal(createComponentSelection(storage).resolve('panda.projects', competing).id, other.id);
  assert.equal(selection.resolve('panda.projects', providers), undefined);
  assert.equal(selection.resolve('panda.projects', [{ ...other, contractVersion: 2 }]), undefined);
  assert.throws(() => selection.select('panda.projects', other.id, [{ ...other, contractVersion: 2 }]));
  selection.select('panda.projects', undefined, competing); assert.equal(selection.resolve('panda.projects', competing), undefined);
  values.set(REPLACEMENT_KEY, '{broken'); assert.equal(selection.resolve('panda.projects', competing), undefined);
});
for (const [slot, directory, kind] of [['panda.projects', false, 'select'], ['panda.files', false, 'open'], ['panda.files', true, 'toggle']]) {
  test(`component v1 ${slot}/${kind}: immutable props/state, actions, revisions, focus, loading/offline, visibility and disposal`, () => {
    let latest = props(slot, directory); const initial = structuredClone(latest), calls = [];
    const instance = createComponentSlot(latest, () => latest, action => calls.push(action));
    assert.notEqual(instance.props, latest); assert.ok(Object.isFrozen(instance.props.objects[0])); assert.ok(Object.isFrozen(instance.state));
    assert.equal(instance.state.focused, 'one'); assert.equal(instance.state.selected, 'one');
    assert.equal(instance.dispatch(action(kind)), true);
    for (const change of [{ kind: 'delete' }, { id: 'missing' }, { objectRevision: 2 }, { revision: 6 }, { context: 'project:B/task:two' }, { contractVersion: 2 }, { rawIpc: true }]) assert.equal(instance.dispatch({ ...action(kind), ...change }), false);
    for (const state of [{ loading: true }, { offline: true }, { visible: false }]) { latest = { ...initial, state: { ...initial.state, ...state } }; assert.equal(instance.dispatch(action(kind)), false); }
    for (const change of [{ context: 'B' }, { revision: 8 }, { objects: [{ ...initial.objects[0], revision: 4 }] }, { objects: [] }]) { latest = { ...initial, ...change }; assert.equal(instance.dispatch(action(kind)), false); }
    latest = initial; instance.dispose(); instance.dispose(); assert.equal(instance.dispatch(action(kind)), false); assert.equal(calls.length, 1); assert.deepEqual(latest, initial);
  });
}
test('component conformance is registered in both runners and CI', () => {
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-replacement\.spec\.ts/);
});
test('component v1 props reject incompatible versions, unknown handles, duplicate IDs, malformed state and excessive payloads', () => {
  for (const change of [{ contractVersion: 2 }, { slot: 'panda.composer' }, { revision: -1 }, { objects: [...props().objects, ...props().objects] }, { objects: [{ ...props().objects[0], node: {} }] }, { objects: Array(10001).fill(props().objects[0]) }, { state: { ...props().state, focused: {} } }, { state: { ...props().state, loading: 'yes' } }]) {
    const invalid = { ...props(), ...change }; assert.equal(validSlotProps(invalid), false); assert.throws(() => createComponentSlot(invalid, () => invalid, () => {}), /Invalid component slot props/);
  }
});
