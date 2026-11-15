import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { THREAD_ACTION_SURFACES, DIALOG_DATA_SURFACES } from '../src/extensions/surfaces.ts';
import { WINDOW_ACTION_SURFACES } from '../src/extensions/window-surfaces.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const sample = read('./fixtures/extensions/sample-project-helper/extension.json');
const items = read('./fixtures/extensions/menus-v1.json');
function manifest() {
  const result = structuredClone(sample);
  result.contributes.menus = [{ ...result.contributes.menus[0], items: structuredClone(items) }];
  return result;
}
const context = { schemaVersion: 1, revision: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', sessionId: 'A' };
function activation(value = manifest()) { return createDeclarativeActivation({ safeMode: false, diagnostics: [], packages: [{ manifest: value, icons: {}, enabled: true }] }, 1); }

test('extensions menus: shared three-level fixture is validated without mutation; flat fixture unchanged', () => {
  const value = manifest(), before = structuredClone(value);
  assert.equal(validateContract('packages', [value]).ok, true);
  assert.deepEqual(value, before);
  assert.equal(validateContract('packages', [sample]).ok, true);
});

test('extensions menus: discovery labels nested contributions as menu triggers, not direct command buttons', () => {
  const catalog = createUiCatalog(() => ({ safeMode: false, diagnostics: [], packages: [{ manifest: manifest(), icons: {}, enabled: true }] }));
  assert.equal(catalog.listItems({ owner: sample.id }).items[0].type, 'menu-trigger');
  for (const surface of catalog.listSurfaces().items) {
    const dataTypes = { 'panda.inspector.views': ['view', 'list', 'tree', 'table', 'tabs', 'progress'], 'panda.commands': ['command'], 'panda.shortcuts': ['keybinding'], 'panda.settings.pages': ['settings-page'], 'panda.dialog.protected': ['button'], 'panda.tray.protected': ['button'], 'panda.launcher.protected': ['button'], 'panda.agentsDock.protected': ['button'], ...Object.fromEntries(DIALOG_DATA_SURFACES.map(id => [id, ['text']])) };
    const documentTypes = { 'panda.design': ['comments-first'], 'panda.design.controls': ['button'], 'panda.simulator': ['controls-first'], 'panda.simulator.controls': ['button'], 'panda.terminal': ['tabs-below'], 'panda.terminal.controls': ['button'], 'panda.browser': ['controls-below'], 'panda.browser.controls': ['button', 'input'], 'panda.search': ['results-first'], 'panda.search.controls': ['button'], 'panda.documents': ['viewer-first'], 'panda.documents.navigation': ['button'], 'panda.documents.tabs': ['button'], 'panda.documents.viewer': ['button'], 'panda.changes': ['commit-first'], 'panda.changes.controls': ['button'], 'panda.changes.file': ['button'], 'panda.changes.viewer': ['button'] };
    const btwTypes = { 'panda.btw': ['composer-first'], 'panda.btw.header': ['button'], 'panda.btw.controls': ['button'], 'panda.btw.queue': ['button'], 'panda.btw.message': ['button'] };
    const boardTypes = { 'panda.composer.recipes.controls': ['button'], 'panda.composer.wake.controls': ['button'], 'panda.composer.attach.protected': ['button'], 'panda.composer.queue.controls': ['button'], 'panda.composer.saver.controls': ['button'], 'panda.composer.council.controls': ['button'], 'panda.composer.panels.protected': ['button'], 'panda.composer.queue.actions': ['button', 'menu-trigger'], 'panda.composer.saver.actions': ['button', 'menu-trigger'], 'panda.composer.council.actions': ['button', 'menu-trigger'], 'panda.composer.tray.controls': ['button'], 'panda.composer.model.entries': ['button'], 'panda.composer.steering.controls': ['button'], 'panda.composer.protected': ['button'], 'panda.composer.model.actions': ['button', 'menu-trigger'], 'panda.composer.permissions.actions': ['button', 'menu-trigger'], 'panda.composer.steering.actions': ['button', 'menu-trigger'], 'panda.actionDock': ['actions-first'], 'panda.actionDock.controls': ['button'], 'panda.team.controls': ['button'], 'panda.actionDock.protected': ['button'], 'panda.sidebar': ['filter-first'], 'panda.sidebar.header': ['button'], 'panda.sidebar.projects': ['button'], 'panda.sidebar.sections': ['button'], 'panda.sidebar.rows': ['button'], 'panda.sidebar.protected': ['button'], 'panda.settings': ['actions-first'], 'panda.settings.sections': ['button'], 'panda.settings.controls': ['button'], 'panda.settings.protected': ['button'], 'panda.settings.actions': ['button', 'menu-trigger'], 'panda.settings.context': ['button', 'menu-trigger'], 'panda.machines': ['controls-below'], 'panda.machines.controls': ['button'], 'panda.machines.targets': ['button'], 'panda.machines.protected': ['button'], 'panda.cloud': ['controls-below'], 'panda.cloud.controls': ['button'], 'panda.cloud.targets': ['button'], 'panda.cloud.protected': ['button'], 'panda.moodboards': ['viewer-first'], 'panda.moodboards.controls': ['button'], 'panda.moodboards.protected': ['button'], 'panda.worktree': ['controls-first'], 'panda.worktree.controls': ['button'], 'panda.worktree.protected': ['button'], 'panda.pull': ['tabs-first'], 'panda.pull.controls': ['button'], 'panda.pull.merge': ['button'], 'panda.githubHub': ['tabs-first'], 'panda.githubHub.controls': ['button'], 'panda.board': ['review-first'], 'panda.board.columns': ['button'], 'panda.board.cards': ['button'] };
    assert.deepEqual(surface.supportedItemTypes, boardTypes[surface.id] ?? btwTypes[surface.id] ?? documentTypes[surface.id] ?? dataTypes[surface.id] ?? (THREAD_ACTION_SURFACES.includes(surface.id) || surface.id === 'panda.status.items' || surface.id.endsWith('.actions') && surface.id.startsWith('panda.dialog.') || Object.hasOwn(WINDOW_ACTION_SURFACES, surface.id) && surface.id !== 'panda.tray.menu' ? ['button', 'menu-trigger', 'status', 'badge'] : ['button', 'menu-trigger']));
  }
});

test('extensions menus: reject cycles, depth, total items, duplicate IDs, foreign IDs and malformed variants', () => {
  const value = manifest(); value.contributes.menus[0].items[1].items = value.contributes.menus[0].items;
  assert.equal(validateContract('packages', [value]).ok, false);
  for (const mutate of [
    m => { m.contributes.menus[0].items[1].id = 'other.owner/reports'; },
    m => { m.contributes.menus[0].items[1].id = m.contributes.menus[0].id; },
    m => { m.contributes.menus[0].items[1].command = 'sample.project-helper/hello'; },
    m => { m.contributes.menus[0].items[0].title = 'Not a separator'; },
    m => { delete m.contributes.menus[0].items[1].items[0].items[4].group; },
    m => { m.contributes.menus[0].items[1].items[0].items[5].checked = true; },
    m => { m.contributes.menus[0].items = Array.from({ length: 128 }, (_, n) => ({ id: `sample.project-helper/item-${n}`, kind: 'submenu', title: 'Nested', items: [{ id: `sample.project-helper/child-${n}`, kind: 'command', title: 'Child', command: 'sample.project-helper/hello' }] })); },
    m => { let list = m.contributes.menus[0].items = []; for (let n = 0; n < 6; n++) { const item = { id: `sample.project-helper/level-${n}`, kind: 'submenu', title: 'Deep', items: [] }; list.push(item); list = item.items; } },
  ]) {
    const m = manifest(); mutate(m);
    assert.equal(validateContract('packages', [m]).ok, false);
  }
});

test('extensions menus: registration DTOs share recursive ownership/variant/limit validation', () => {
  const dto = { schemaVersion: 1, owner: { extensionId: sample.id, version: '1.0.0', activationId: 'test-1' }, definition: manifest().contributes.menus[0] };
  assert.equal(validateContract('contribution', dto).ok, true);
  dto.definition.items[1].items[0].id = 'other.owner/item';
  assert.equal(validateContract('contribution', dto).error.code, 'InvalidId');
  dto.definition.items[1].items[0].id = 'sample.project-helper/child';
  dto.definition.items[1].items[0].command = 'sample.project-helper/hello';
  assert.equal(validateContract('contribution', dto).error.code, 'InvalidShape');
});

test('extensions menus: exactly 128 leaf items and exactly five levels are accepted', () => {
  const m = manifest();
  m.contributes.menus[0].items = Array.from({ length: 128 }, (_, n) => ({ id: `sample.project-helper/item-${n}`, kind: 'command', title: 'Item', command: 'sample.project-helper/hello' }));
  assert.equal(validateContract('packages', [m]).ok, true);
  let deep = [{ id: 'sample.project-helper/leaf', kind: 'command', title: 'Leaf', command: 'sample.project-helper/hello' }];
  for (let n = 0; n < 4; n++) deep = [{ id: `sample.project-helper/level-${n}`, kind: 'submenu', title: 'Deep', items: deep }];
  m.contributes.menus[0].items = deep;
  assert.equal(validateContract('packages', [m]).ok, true);
});

test('extensions menus: filter empty submenus/orphan separators and enforce ancestor authorization at invocation', () => {
  const owned = activation();
  const roots = owned.itemsFor('sample.project-helper/header', context);
  assert.deepEqual(roots.map(item => item.title), ['Reports']);
  assert.deepEqual(roots[0].items.map(item => item.title), ['Formats']);
  assert.equal(owned.invoke('sample.project-helper/disabled', context), undefined);
  assert.equal(owned.invoke('sample.project-helper/hidden', context), undefined);
  assert.equal(owned.invoke('sample.project-helper/summary', { ...context, surfaceId: 'elsewhere' }), undefined);
  const m = manifest(); m.contributes.menus[0].items[1].enabled = false;
  assert.equal(activation(m).invoke('sample.project-helper/summary', context), undefined);
  assert.equal(owned.invoke('sample.project-helper/summary', context), 'Extension installed successfully');
  owned.dispose();
  assert.equal(owned.invoke('sample.project-helper/summary', context), undefined);
  assert.deepEqual(owned.itemsFor('sample.project-helper/header', context), []);
});

test('extensions menus: checkbox toggles and radio siblings stay exclusive within an activation', () => {
  const owned = activation();
  const leaves = () => owned.itemsFor('sample.project-helper/header', context)[0].items[0].items;
  assert.equal(leaves().find(item => item.kind === 'checkbox').checked, true);
  owned.invoke('sample.project-helper/checked', context);
  assert.equal(leaves().find(item => item.kind === 'checkbox').checked, false);
  owned.invoke('sample.project-helper/radio-b', context);
  assert.deepEqual(leaves().filter(item => item.kind === 'radio').map(item => item.checked), [false, true]);
  leaves()[0].title = 'mutated';
  assert.equal(leaves()[0].title, 'Unavailable');
});

test('extensions menus: nested command definitions cannot be retargeted by mutating the input snapshot', () => {
  const m = manifest(), owned = activation(m);
  m.contributes.commands[0].action.message = 'Changed after activation';
  m.contributes.menus[0].items[1].enabled = false;
  assert.equal(owned.invoke('sample.project-helper/summary', context), 'Extension installed successfully');
});

test('extensions menus: nested choices display the same command enable policy enforced at invocation', () => {
  const m = manifest(); m.contributes.commands[0].enabled = false;
  const owned = activation(m);
  const leaves = owned.itemsFor('sample.project-helper/header', context)[0].items[0].items;
  for (const id of ['summary', 'checked', 'radio-a', 'radio-b']) {
    assert.equal(leaves.find(item => item.id === `sample.project-helper/${id}`).enabled, false);
    assert.equal(owned.actionFor(`sample.project-helper/${id}`, context), undefined);
  }
  owned.dispose();
});
