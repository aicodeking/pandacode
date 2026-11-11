import test from 'node:test';
import assert from 'node:assert/strict';
import { createLayoutStore, LAYOUT_KEY, SIDEBAR } from '../src/extensions/layout.ts';
const item = 'panda.sidebar.footer/theme', missing = 'missing.extension/action';
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
