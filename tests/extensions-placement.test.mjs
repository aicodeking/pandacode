import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPlacementStore, reducePlacement, PLACEMENT_KEY } from '../src/extensions/placement.ts';
const main = 'panda.containers/main', inspector = 'panda.containers/inspector', id = 'panda.views/composer';
const views = [{ id, contract: 'host-view-v1', home: main }];
const containers = [{ id: main, accepts: ['host-view-v1'] }, { id: inspector, accepts: ['host-view-v1'] }];
function fixture() {
  const values = new Map(); const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, storage, store: createPlacementStore(storage) };
}
test('placement reducer is immutable, rejects incompatible destinations and nested cycles', () => {
  const state = {}; const action = { id, container: inspector };
  assert.deepEqual(reducePlacement(state, action, views, containers), { [id]: { container: inspector, hidden: false } });
  assert.deepEqual(state, {}); assert.deepEqual(action, { id, container: inspector });
  for (const destination of ['panda.menus/native', id]) assert.throws(() => reducePlacement(state, { id, container: destination }, views, [...containers, { id, accepts: ['host-view-v1'] }]), /Incompatible|Cyclic/);
  assert.throws(() => reducePlacement({}, action, views, [{ id: inspector, accepts: ['button-v1'] }]), /Incompatible/);
  assert.throws(() => reducePlacement({}, action, views, [{ id: inspector, accepts: ['host-view-v1'], parent: id }]), /Cyclic/);
});
test('placement persistence isolates projects, preserves dormant IDs and rejects corrupt bytes with last valid recovery', () => {
  const { store, storage, values } = fixture();
  store.dispatch({ id, container: inspector }, views, containers);
  store.dispatch({ id, hidden: true }, views, containers, 'A');
  assert.equal(createPlacementStore(storage).read('A')[id].hidden, true);
  assert.equal(store.read('B')[id].container, inspector);
  for (const corrupt of ['{broken', JSON.stringify({ schemaVersion: 1, placements: { [id]: { container: id, hidden: false } } }), JSON.stringify({ schemaVersion: 1, placements: [] })]) {
    values.set(PLACEMENT_KEY, corrupt); assert.equal(store.read()[id].container, inspector); assert.equal(values.get(PLACEMENT_KEY), corrupt);
  }
  assert.match(store.diagnostic(), /retained/);
  const missing = { id: 'sample.missing/view', contract: 'host-view-v1', home: main };
  store.dispatch({ id: missing.id, container: inspector }, [...views, missing], containers);
  store.restore(views); assert.equal(store.read()[missing.id].container, inspector);
  assert.equal(store.read()[id].container, main); assert.equal(store.read('A')[id].hidden, true);
  store.reset('A'); assert.equal(store.read('A')[id].hidden, false);
});
test('placement rejects failed writes and invalid actions without cache mutation or notification', () => {
  let raw = null, fail = false, changes = 0;
  const store = createPlacementStore({ getItem: () => raw, setItem: (_key, value) => { if (fail) throw new Error('quota'); raw = value; } });
  const off = store.subscribe(() => changes++);
  store.dispatch({ id, container: main }, views, containers); fail = true;
  assert.throws(() => store.dispatch({ id, container: inspector }, views, containers), /quota/);
  assert.equal(store.read()[id].container, main); assert.equal(changes, 1);
  off(); fail = false; store.restore(views); assert.equal(changes, 1);
});
test('placement conformance is explicitly registered in both browser runners and CI', () => {
  for (const file of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(file, import.meta.url), 'utf8'), /extensions-placement\.spec\.ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /extensions placement/);
});
