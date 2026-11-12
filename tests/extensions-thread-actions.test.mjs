import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { THREAD_ACTION_SURFACES } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { validateContract } from '../src/extensions/contracts.ts';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/thread-laboratory/extension.json', import.meta.url), 'utf8'));
const snapshot = { safeMode: false, packages: [{ manifest, enabled: true, icons: {} }], diagnostics: [] };
for (const location of THREAD_ACTION_SURFACES) test(`extensions thread actions: ${location} shares native schema, discovery and bounded context-only activation`, () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const catalog = createUiCatalog(() => snapshot), registration = createDeclarativeActivation(snapshot, 1);
  assert.deepEqual(catalog.listSurfaces({ location }).items[0].supportedItemTypes, ['button', 'menu-trigger', 'status', 'badge']);
  const entry = registration.entries.find(entry => entry.menu.location === location);
  assert.equal(catalog.listItems({ location, owner: manifest.id }).items.length, 1);
  for (const presentation of ['icon', 'button', 'status', 'badge']) {
    const variant = structuredClone(manifest), menu = variant.contributes.menus.find(menu => menu.location === location);
    menu.presentation = presentation; delete menu.items;
    assert.equal(validateContract('packages', [variant]).ok, true);
    const item = createUiCatalog(() => ({ ...snapshot, packages: [{ manifest: variant, enabled: true, icons: {} }] })).listItems({ location, owner: manifest.id }).items[0];
    assert.equal(item.type, ['status', 'badge'].includes(presentation) ? presentation : 'button');
  }
  const context = { schemaVersion: 1, windowId: 'main', surfaceId: location, revision: 1, projectId: 'project-a', sessionId: 'task-a', selection: { kind: location.includes('message') ? 'message' : location.includes('trace') ? 'trace' : location.includes('team') ? 'team' : 'task', ids: ['object-a'] } };
  assert.equal(validateContract('context', context).ok, true);
  const actionId = entry.menu.items?.[0].id ?? entry.menu.id;
  const passive = ['status', 'badge'].includes(entry.menu.presentation);
  assert.equal(registration.actionFor(actionId, context)?.kind, passive ? undefined : entry.menu.items ? 'showDialog' : 'showMessage');
  assert.equal(registration.actionFor(actionId, { ...context, surfaceId: 'panda.other' }), undefined);
  registration.dispose(); assert.equal(registration.actionFor(actionId, context), undefined);
  for (const state of [{ ...snapshot, packages: [] }, { ...snapshot, safeMode: true }, { ...snapshot, packages: [{ ...snapshot.packages[0], enabled: false }] }]) assert.equal(createDeclarativeActivation(state, 2).entries.length, 0);
});

test('extensions thread actions: declarations cannot acquire stop, approval, question or bridge authority', () => {
  for (const kind of ['stop_session', 'respond_approval', 'respond_user_input', 'send_message', 'bridge.call']) {
    const invalid = structuredClone(manifest); invalid.contributes.commands[0].action = { kind, sessionId: 'task-a' };
    assert.equal(validateContract('packages', [invalid]).ok, false, kind);
  }
  const collision = validateContract('packages', [manifest, manifest]);
  assert.equal(collision.ok, false); assert.equal(collision.error.code, 'DuplicateId');
});

test('extensions thread actions: first-render CSS and source ownership do not depend on lazy team modules', () => {
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  const css = readFileSync(new URL('../src/extensions/extensions.css', import.meta.url), 'utf8');
  assert.match(main, /import '\.\/extensions\/extensions.css'/);
  assert.match(css, /\.extension-action-badge/);
  const adapter = readFileSync(new URL('../src/extensions/thread-actions.ts', import.meta.url), 'utf8');
  assert.doesNotMatch(adapter, /bridge|send_message|stop_session|respond_approval|respond_user_input|#prompt|\.value\s*=/);
  const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
  for (const id of THREAD_ACTION_SURFACES) assert.ok(ledger.implementedAdapters.some(row => row.id === id && row.tests.includes('tests/extensions-thread-actions.spec.ts')));
});
