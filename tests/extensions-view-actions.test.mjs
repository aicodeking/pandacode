import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { VIEW_ACTION_SURFACES, boundedContextActions } from '../src/extensions/surfaces.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/view-laboratory/extension.json', import.meta.url), 'utf8'));
const snapshot = { safeMode: false, packages: [{ manifest, enabled: true, icons: {} }], diagnostics: [] };

test('extensions view actions: the surface ledger names every catalog location and core action exactly', () => {
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [], diagnostics: [] }));
  assert.deepEqual(catalog.listSurfaces().items.map(item => item.id).sort(), [...ledger.catalog.surfaces].sort());
  assert.deepEqual(catalog.listItems({ owner: 'panda.core' }).items.map(item => item.id).sort(), [...ledger.catalog.coreItems].sort());
});

test('extensions view actions: a valid maximum-size tree cannot displace core actions or overflow a context menu', () => {
  const core = [{ id: 'pin' }, { id: 'rename' }], small = { id: 'small' };
  const oversized = { id: 'large', children: Array.from({ length: 128 }, (_, index) => ({ id: `leaf-${index}` })) };
  assert.deepEqual(boundedContextActions(core, [oversized, small]), { items: [...core, small], omitted: 1 });
  assert.deepEqual(boundedContextActions(core, [{ id: 'accepted', children: oversized.children.slice(0, 125) }]).items.length, 3);
  assert.deepEqual(core, [{ id: 'pin' }, { id: 'rename' }]);
});

for (const location of VIEW_ACTION_SURFACES) {
  test(`extensions view actions: ${location} filters metadata, captures IDs and supports dormant hide/order`, () => {
    assert.equal(validateContract('packages', [manifest]).ok, true);
    const catalog = createUiCatalog(() => snapshot);
    const surface = catalog.listSurfaces({ location }).items;
    assert.equal(surface.length, 1);
    assert.deepEqual(surface[0].supportedOperations, ['inspect', 'contribute', 'hide', 'show', 'reorder']);
    const contributions = catalog.listItems({ location, owner: manifest.id }).items;
    assert.equal(contributions.length, 1); assert.equal(contributions[0].location, location);
    assert.equal(catalog.listItems({ location, owner: 'panda.core' }).items.some(item => item.owner !== 'panda.core'), false);
    assert.equal(catalog.listItems({ location, type: 'link' }).items.length, 0);
    const registration = createDeclarativeActivation(snapshot, 1), entry = registration.entries.find(item => item.menu.location === location);
    let leaf = entry.menu.items?.[0]; while (leaf?.items) leaf = leaf.items[0];
    const context = { schemaVersion: 1, windowId: 'main', surfaceId: location, revision: 1, projectId: 'clicked-project', sessionId: 'clicked-task', selection: { kind: location.includes('project.context') ? 'project' : location.includes('task.context') ? 'task' : 'file', ids: ['clicked-object'] } };
    assert.equal(registration.actionFor(leaf?.id ?? entry.menu.id, context)?.kind, 'showDialog');
    assert.deepEqual(context.selection.ids, ['clicked-object']);
    assert.equal(registration.actionFor(leaf?.id ?? entry.menu.id, { ...context, surfaceId: 'wrong.surface' }), undefined);
    const records = new Map(), layout = createLayoutStore({ getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) });
    const coreId = catalog.listItems({ location, owner: 'panda.core' }).items[0].id;
    layout.setVisible(entry.menu.id, false, 'clicked-project');
    layout.move(location, [coreId, entry.menu.id], { id: entry.menu.id, target: coreId, side: 'before' }, 'clicked-project');
    assert.equal(layout.isHidden(entry.menu.id, 'clicked-project'), true);
    assert.equal(layout.isHidden(entry.menu.id, 'other-project'), false);
    assert.deepEqual(layout.order(location, [coreId, entry.menu.id], 'clicked-project'), [entry.menu.id, coreId]);
    registration.dispose(); assert.equal(registration.actionFor(leaf?.id ?? entry.menu.id, context), undefined);
    assert.equal(createUiCatalog(() => ({ ...snapshot, packages: [] })).listItems({ location, owner: manifest.id }).items.length, 0);
    assert.deepEqual(layout.order(location, [coreId], 'clicked-project'), [coreId]);
    const proposal = structuredClone(manifest);
    proposal.permissions.push('ui.customize');
    proposal.contributes.layouts = [{ id: `${manifest.id}/layout`, title: 'Object actions first', location, rules: [{ id: entry.menu.id, target: coreId, side: 'before' }] }];
    assert.equal(validateContract('packages', [proposal]).ok, true);
  });
}
