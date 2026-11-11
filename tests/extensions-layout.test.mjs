import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutStore, LAYOUT_KEY, SIDEBAR } from '../src/extensions/layout.ts';
import { proposalOrder, reorder } from '../src/extensions/ordering.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { readFileSync } from 'node:fs';
const item = 'panda.sidebar.footer/theme', missing = 'missing.extension/action';
const footerIds = ['support', 'usage', 'settings', 'star', 'theme'].map(id => `panda.sidebar.footer/${id}`);
function fixture() {
  const values = new Map([['pandacode.draft', 'untouched'], ['pandacode.projects', '[1]']]);
  const storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  return { values, storage, layout: createLayoutStore(storage) };
}
test('extensions layout: project > global, reload and dormant IDs do not depend on installed packages', () => {
  const { layout, storage, values } = fixture();
  layout.setVisible(item, false); layout.setVisible(missing, false); layout.setVisible(missing, true, 'A');
  layout.setVisible(item, true, 'A'); layout.setVisible(SIDEBAR, false, 'B');
  const reload = createLayoutStore(storage);
  assert.equal(reload.isHidden(item), true); assert.equal(reload.isHidden(item, 'A'), false);
  assert.equal(reload.isHidden(item, 'B'), true); assert.equal(reload.isHidden(SIDEBAR, 'B'), true);
  assert.equal(reload.isHidden(missing), true); assert.equal(reload.isHidden(missing, 'A'), false);
  assert.equal(values.get('pandacode.draft'), 'untouched'); assert.equal(values.get('pandacode.projects'), '[1]');
});
test('extensions layout: three recovery operations have disjoint effects', () => {
  const { layout } = fixture();
  layout.setVisible(item, false); layout.setVisible(SIDEBAR, false, 'A'); layout.setVisible(missing, false, 'B');
  layout.disableExtensionLayouts();
  assert.equal(layout.extensionLayoutsEnabled(), false); assert.equal(layout.isHidden(item, 'A'), true);
  layout.resetProject('A'); assert.equal(layout.isHidden(SIDEBAR, 'A'), false); assert.equal(layout.isHidden(item, 'A'), true);
  assert.equal(layout.isHidden(missing, 'B'), true); assert.equal(layout.extensionLayoutsEnabled(), false);
  layout.resetGlobal(); assert.equal(layout.isHidden(item), false); assert.equal(layout.isHidden(missing, 'B'), true);
  assert.equal(layout.extensionLayoutsEnabled(), true);
});
test('extensions layout: corrupt records fall back independently without erasing bytes or last valid state', () => {
  const { layout, values, storage } = fixture();
  layout.setVisible(item, false); layout.setVisible(SIDEBAR, false, 'A');
  values.set(LAYOUT_KEY, '{broken');
  assert.equal(layout.isHidden(item), true); // Last valid in this host.
  const reload = createLayoutStore(storage);
  assert.equal(reload.isHidden(item), false); assert.equal(reload.isHidden(SIDEBAR, 'A'), true);
  assert.equal(values.get(LAYOUT_KEY), '{broken'); assert.match(reload.diagnostic(), /retained/);
  for (const visibility of [[], { [item]: 'false' }, { '__proto__': false, 'invalid': false }]) {
    values.set(LAYOUT_KEY, JSON.stringify({ schemaVersion: 1, visibility, extensionLayoutsEnabled: true }));
    assert.equal(createLayoutStore(storage).isHidden(item), false);
  }
  assert.equal(values.get('pandacode.draft'), 'untouched');
});
test('extensions layout: failed persistence reports failure, notifications dispose, invalid IDs are rejected', () => {
  const { layout } = fixture(); let changes = 0;
  const dispose = layout.subscribe(() => changes++);
  layout.setVisible(item, false); dispose(); layout.resetGlobal(); assert.equal(changes, 1);
  assert.throws(() => layout.setVisible('#selector', false), /Invalid/);
  assert.throws(() => layout.setVisible('invalid.extension/' + 'a'.repeat(160), false), /Invalid/);
  assert.throws(() => layout.resetProject(''), /Project/);
  const blocked = createLayoutStore({ getItem: () => null, setItem: () => { throw new Error('quota'); } });
  assert.throws(() => blocked.setVisible(item, false), /quota/); assert.equal(blocked.isHidden(item), false);
});

test('extensions layout: relative reducer is immutable, scoped orders survive restart and reset independently', () => {
  const { layout, storage } = fixture(), location = 'panda.sidebar.footer';
  const ids = [...footerIds], before = [...ids];
  const operation = { id: ids[1], target: ids[0], side: 'before' };
  const expected = reorder(ids, operation);
  layout.move(location, ids, operation);
  assert.deepEqual(ids, before);
  assert.deepEqual(createLayoutStore(storage).order(location, ids), expected);
  layout.move(location, expected, { id: ids[0], target: ids[1], side: 'before' }, 'A');
  assert.deepEqual(createLayoutStore(storage).order(location, ids, 'A'), ids);
  layout.resetProject('A'); assert.deepEqual(layout.order(location, ids, 'A'), expected);
  assert.throws(() => layout.move('panda.inspector.views', ids, operation), /Unsupported/);
  assert.throws(() => reorder(ids, { ...operation, target: operation.id }), /Invalid/);
  assert.throws(() => reorder(ids, { ...operation, side: 'left' }), /Invalid/);
  assert.throws(() => layout.move(location, [...ids, ids[0]], operation), /limit/);
  assert.deepEqual(layout.order(location, ids), expected, 'rejected writes preserve the last valid overlay');
  layout.move(location, [missing, ...ids], { id: missing, target: ids[0], side: 'before' });
  layout.move(location, ids, operation);
  assert.deepEqual(createLayoutStore(storage).order(location, [missing, ...ids]), [missing, ...expected], 'editing while absent preserves a dormant item position');
});

test('extensions layout: proposal validation, cycle rejection, declaration and incompatible placement', () => {
  const read = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8'));
  const a = read('layout-a'), b = read('layout-b');
  assert.equal(validateContract('packages', [a, b]).ok, true);
  assert.equal(validateContract('packages', [b, a]).ok, true);
  const denied = structuredClone(a); denied.permissions = ['ui.contribute'];
  assert.equal(validateContract('packages', [denied]).error.code, 'PermissionDenied');
  const cycle = structuredClone(a), rule = cycle.contributes.layouts[0].rules[0];
  cycle.contributes.layouts[0].rules.push({ id: rule.target, target: rule.id, side: 'before' });
  assert.equal(validateContract('packages', [cycle]).error.code, 'OrderingCycle');
  assert.throws(() => proposalOrder([], cycle.contributes.layouts[0].rules), /OrderingCycle/);
  const incompatible = structuredClone(a); incompatible.contributes.layouts[0].location = 'panda.inspector.views';
  assert.equal(validateContract('packages', [incompatible]).ok, false);
  const { layout, storage } = fixture(), location = 'panda.sidebar.footer', ids = [...footerIds];
  assert.equal(layout.selected(location), undefined, 'declaration is not selection/grant');
  layout.select(location, a.contributes.layouts[0].id);
  assert.equal(createLayoutStore(storage).selected(location), a.contributes.layouts[0].id);
  const suggested = proposalOrder(ids, a.contributes.layouts[0].rules);
  layout.move(location, suggested, { id: ids[0], target: ids[4], side: 'before' });
  assert.deepEqual(layout.order(location, suggested), layout.order(location, ids), 'explicit user order wins over either proposal');
  layout.disableExtensionLayouts(); assert.equal(layout.extensionLayoutsEnabled(), false);
  assert.deepEqual(layout.order(location, ids), layout.order(location, suggested));
});
