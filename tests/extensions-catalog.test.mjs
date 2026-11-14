import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createUiCatalog, createCoreCommands, HEADER, FOOTER, INSPECTOR } from '../src/extensions/catalog.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { VIEW_ACTION_SURFACES, THREAD_ACTION_SURFACES, SETTINGS_ACTION_SURFACES, SETTINGS_DATA_SURFACES, CONTEXT_COMMANDS, CHANGES_CONTROLS } from '../src/extensions/surfaces.ts';
import { WINDOW_ACTION_SURFACES, surfaceWindow } from '../src/extensions/window-surfaces.ts';
import { INSPECTOR_VIEW_LOCATION } from '../src/extensions/views-state.ts';
import { INSPECTOR_VIEWS } from '../src/inspector-tabs.ts';
const sample = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const empty = () => ({ safeMode: false, packages: [], diagnostics: [] });
const installed = () => ({ safeMode: false, packages: [{ manifest: structuredClone(sample), enabled: true, icons: {} }], diagnostics: [] });
function allItems(ui, query = {}) {
  const items = []; let cursor;
  do { const page = ui.listItems({ ...query, limit: 100, ...(cursor ? { cursor } : {}) }); items.push(...page.items); cursor = page.nextCursor; } while (cursor);
  return items;
}
function plain(value) {
  assert.ok(value === null || ['string', 'boolean', 'number'].includes(typeof value) || typeof value === 'object');
  if (value && typeof value === 'object') {
    assert.ok(Array.isArray(value) || Object.getPrototypeOf(value) === Object.prototype);
    for (const child of Object.values(value)) plain(child);
  }
}
test('extensions catalog: public DTOs enumerate core/sample identities without host authority', () => {
  const ui = createUiCatalog(installed);
  assert.deepEqual(Object.keys(ui), ['listSurfaces', 'listItems']);
  const surfaces = []; let surfaceCursor;
  do { const page = ui.listSurfaces({ limit: 50, ...(surfaceCursor ? { cursor: surfaceCursor } : {}) }); surfaces.push(...page.items); surfaceCursor = page.nextCursor; } while (surfaceCursor);
  assert.deepEqual(surfaces.map(item => item.id), [INSPECTOR, INSPECTOR_VIEW_LOCATION, FOOTER, HEADER, 'panda.settings', 'panda.settings.sections', 'panda.settings.controls', 'panda.settings.protected', 'panda.settings.actions', 'panda.settings.context', 'panda.machines', 'panda.machines.controls', 'panda.machines.targets', 'panda.machines.protected', 'panda.machines.context', 'panda.cloud', 'panda.cloud.controls', 'panda.cloud.targets', 'panda.cloud.protected', 'panda.cloud.actions', 'panda.cloud.context', 'panda.moodboards', 'panda.moodboards.controls', 'panda.moodboards.protected', 'panda.moodboards.actions', 'panda.moodboards.context', 'panda.worktree', 'panda.worktree.controls', 'panda.worktree.protected', 'panda.worktree.actions', 'panda.worktree.context', 'panda.pull', 'panda.pull.controls', 'panda.pull.merge', 'panda.pull.actions', 'panda.pull.context', 'panda.githubHub', 'panda.githubHub.controls', 'panda.githubHub.actions', 'panda.githubHub.context', 'panda.board', 'panda.board.header', 'panda.board.card', 'panda.board.context', 'panda.board.cards', 'panda.board.columns', 'panda.board.detail', 'panda.btw', 'panda.btw.header', 'panda.btw.composer', 'panda.btw.context', 'panda.btw.controls', 'panda.btw.queue', 'panda.btw.message', 'panda.design', 'panda.design.actions', 'panda.design.context', 'panda.design.controls', 'panda.vm', 'panda.vm.actions', 'panda.vm.context', 'panda.vm.controls', 'panda.simulator', 'panda.simulator.actions', 'panda.simulator.context', 'panda.simulator.controls', 'panda.terminal', 'panda.terminal.actions', 'panda.terminal.context', 'panda.terminal.controls', 'panda.browser', 'panda.browser.actions', 'panda.browser.context', 'panda.browser.controls', 'panda.search', 'panda.search.controls', 'panda.documents', 'panda.documents.navigation', 'panda.documents.tabs', 'panda.documents.viewer', 'panda.documents.actions', 'panda.documents.context', 'panda.changes', 'panda.changes.actions', ...Object.keys(CHANGES_CONTROLS), ...VIEW_ACTION_SURFACES, ...THREAD_ACTION_SURFACES, ...SETTINGS_ACTION_SURFACES, ...SETTINGS_DATA_SURFACES, ...Object.keys(WINDOW_ACTION_SURFACES)].sort());
  const items = allItems(ui);
  const expected = 10 + 11 + 12 + 16 + 18 + 11 + 18 + 15 + 22 + 17 + 16 + 14 + 9 + 14 + 4 + 11 + 4 + 9 + 12 + Object.values(CHANGES_CONTROLS).reduce((count, controls) => count + controls.length, 0) + Object.values(CONTEXT_COMMANDS).reduce((count, commands) => count + commands.length, 0) + 6 + INSPECTOR_VIEWS.length;
  assert.equal(items.length, expected); assert.equal(new Set(items.map(item => item.id)).size, expected);
  assert.deepEqual(items.filter(item => item.owner === sample.id).map(item => item.id), ['sample.project-helper/header', 'sample.project-helper/sidebar']);
  for (const item of [...items, ...surfaces]) {
    assert.equal(typeof item.owner, 'string'); assert.ok(item.type); assert.ok(item.location); assert.ok(item.supportedOperations.includes('inspect'));
  }
  plain(ui.listItems()); plain(ui.listSurfaces());
  const json = JSON.stringify(items);
  for (const forbidden of ['svg', 'selector', 'callback', 'bridge', 'ipc', 'activationId', 'action.message']) assert.ok(!json.includes(forbidden));
  items[0].supportedOperations.push('forged'); items[0].label = 'changed';
  assert.ok(!JSON.stringify(ui.listItems()).includes('forged'));
});
test('extensions catalog: pagination and exact filters are bounded, stable and detect changed catalogs', () => {
  let state = installed(); const ui = createUiCatalog(() => state);
  const expected = allItems(ui).map(item => item.id), ids = [];
  let cursor;
  do { const page = ui.listItems({ limit: 2, ...(cursor ? { cursor } : {}) }); ids.push(...page.items.map(item => item.id)); cursor = page.nextCursor; } while (cursor);
  assert.deepEqual(ids, expected);
  assert.equal(ui.listItems({ owner: sample.id, location: HEADER, type: 'button' }).items.length, 1);
  assert.deepEqual(ui.listItems({ location: 'unknown.optional' }).items, []);
  const first = ui.listItems({ limit: 1 });
  assert.throws(() => ui.listItems({ limit: 2, cursor: first.nextCursor }), { code: 'StaleContext' });
  state.packages[0].enabled = false;
  assert.throws(() => ui.listItems({ limit: 1, cursor: first.nextCursor }), { code: 'StaleContext' });
  state = installed();
  assert.deepEqual(allItems(createUiCatalog(() => state)).map(item => item.id), expected);
  for (const query of [{ limit: 0 }, { limit: 101 }, { limit: 1.5 }, { cursor: '' }, { cursor: '{}' }, { windowId: 1 }, { owner: 'x'.repeat(513) }, { raw: true }]) assert.throws(() => ui.listItems(query), { code: 'InvalidQuery' });
});
test('extensions catalog: unsupported windows remain discoverable and disable/safe mode recover core metadata', () => {
  for (const windowId of ['tray', 'launcher', 'headless', 'unknown']) {
    for (const item of [...createUiCatalog(installed).listSurfaces({ windowId }).items, ...createUiCatalog(installed).listItems({ windowId }).items]) {
      const available = surfaceWindow(item.location) === windowId;
      assert.equal(item.available, available); if (!available) assert.equal(item.reason, 'HostUnavailable');
    }
  }
  for (const state of [empty(), { ...installed(), safeMode: true }, { ...installed(), packages: installed().packages.map(item => ({ ...item, enabled: false })) }]) {
    assert.deepEqual(createUiCatalog(() => state).listItems().items, createUiCatalog(empty).listItems().items);
  }
  const duplicate = installed(); duplicate.packages.push(structuredClone(duplicate.packages[0]));
  assert.throws(() => createUiCatalog(() => duplicate).listItems(), /DuplicateId/);
  const requiredUnknown = structuredClone(sample);
  requiredUnknown.contributes.menus[0].location = 'panda.unknown.required';
  const rejected = validateContract('packages', [requiredUnknown]);
  assert.equal(rejected.ok, false); assert.equal(rejected.error.code, 'InvalidShape');
  assert.deepEqual(createUiCatalog(empty).listSurfaces({ location: 'panda.unknown.optional' }).items, []);
});
test('extensions catalog: more than one hundred contributions remain fully pageable', () => {
  const state = installed();
  state.packages[0].manifest.contributes.menus = Array.from({ length: 128 }, (_, index) => ({ id: `${sample.id}/button-${String(index).padStart(3, '0')}`, command: `${sample.id}/hello`, location: HEADER }));
  const ui = createUiCatalog(() => state), first = ui.listItems({ limit: 100 });
  assert.equal(first.items.length, 100); assert.ok(first.nextCursor.length < 4096);
  const second = ui.listItems({ limit: 100, cursor: first.nextCursor });
  const total = 128 + allItems(createUiCatalog(empty)).length;
  assert.equal(second.items.length, 100); assert.ok(second.nextCursor);
  // Follow every remaining page: each full until the last, which ends the cursor.
  const pages = [first, second];
  while (pages.at(-1).nextCursor) pages.push(ui.listItems({ limit: 100, cursor: pages.at(-1).nextCursor }));
  pages.forEach((page, index) => assert.equal(page.items.length, Math.min(100, total - index * 100)));
  assert.equal(pages.length, Math.ceil(total / 100));
  assert.equal(new Set(pages.flatMap(page => page.items).map(item => item.id)).size, total);
});
test('extensions catalog: every public built-in invokes the exact original handler once with zero arguments', async () => {
  const ids = createUiCatalog(empty).listItems().items.flatMap(item => item.command ? [item.command.id] : []);
  assert.deepEqual(ids.sort(), ['panda.ui/open-settings', 'panda.ui/toggle-sidebar', 'panda.ui/toggle-theme']);
  const effects = [];
  const handlers = Object.fromEntries(ids.map(id => [id, async function (...args) { effects.push([id, args]); }]));
  const commands = createCoreCommands(handlers);
  for (const id of ids) await commands.invoke(id, null);
  assert.deepEqual(effects, ids.map(id => [id, []]));
  for (const id of ids) {
    await assert.rejects(commands.invoke(id, {}), { code: 'InvalidArguments' });
    await assert.rejects(commands.invoke(id, null, 'tray'), { code: 'HostUnavailable' });
  }
  await assert.rejects(commands.invoke('support', null), { code: 'NotFound' });
  assert.equal(effects.length, ids.length);
  const failed = createCoreCommands({ ...handlers, [ids[0]]: () => { throw new Error('Original failure'); } });
  await assert.rejects(failed.invoke(ids[0], null), /Original failure/);
  // Characterize the real integration, not just injected test callbacks.
  const main = readFileSync(new URL('../src/main.ts', import.meta.url), 'utf8');
  for (const [id, handler] of [['toggle-sidebar', 'toggleSidebar'], ['open-settings', 'showSettings'], ['toggle-theme', 'toggleTheme']]) {
    assert.ok(main.includes(`'panda.ui/${id}': () => ${handler}()`));
  }
});
