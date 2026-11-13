import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { INSPECTOR_VIEWS, DEFAULT_INSPECTOR_TABS, INSPECTOR_TABS_KEY, normalizeTabs, resolveTabs, isExtensionInspectorView, loadTabs, saveTabs, openTab, closeTab, closedViews, threadDefault } from '../src/inspector-tabs.ts';
import { registeredInspectorViews, INSPECTOR_VIEW_LOCATION } from '../src/extensions/views-state.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/data-panel/extension.json', import.meta.url), 'utf8'));
const snapshot = { safeMode: false, diagnostics: [], packages: [{ manifest, enabled: true, icons: {} }] };
const id = 'sample.data-panel/overview', notes = 'sample.data-panel/notes';
const available = [...INSPECTOR_VIEWS, id, notes];
test('extensions views: old built-in normalization, default, closing and browser thread default remain stable', () => {
  assert.deepEqual(normalizeTabs(null), DEFAULT_INSPECTOR_TABS);
  assert.deepEqual(normalizeTabs({ open: ['files', 'vm', 'files', 'arbitrary'], selected: 'nope' }, ['files', 'changes']), { open: ['files'], selected: 'files' });
  assert.deepEqual(closeTab({ open: ['files', 'search', 'changes'], selected: 'search' }, 'search'), { open: ['files', 'changes'], selected: 'changes' });
  assert.equal(threadDefault({ open: ['files', 'browser'], selected: 'browser' }), 'files');
  assert.equal(threadDefault({ open: ['changes', 'browser'], selected: 'browser' }), 'changes');
});
test('extensions views: only namespaced extension IDs survive persistence and absent IDs stay dormant', () => {
  for (const value of ['files', 'panda.fake/view', 'a.b', 'a.b/c/d', 'a.b/<script>', 'A.b/c', 'a.b/c\n', 'x'.repeat(161), null]) assert.equal(isExtensionInspectorView(value), false, String(value));
  assert.equal(isExtensionInspectorView(id), true);
  const saved = { open: ['files', id, notes], selected: id }, storage = new Map();
  saveTabs({ setItem: (key, value) => storage.set(key, value) }, saved);
  const dormant = loadTabs({ getItem: key => storage.get(key) }, INSPECTOR_VIEWS);
  assert.deepEqual(dormant, saved); assert.deepEqual(JSON.parse(storage.get(INSPECTOR_TABS_KEY)), saved);
  assert.deepEqual(resolveTabs(dormant), { open: ['changes', 'files'], selected: 'changes' });
  assert.deepEqual(resolveTabs(dormant, available), saved);
  assert.equal(threadDefault(dormant, available), id);
  assert.equal(threadDefault(dormant), 'changes');
  assert.deepEqual(resolveTabs({ open: [id], selected: id }), DEFAULT_INSPECTOR_TABS);
  assert.equal(resolveTabs(openTab(dormant, 'files'), available).selected, 'files');
  assert.ok(closedViews(DEFAULT_INSPECTOR_TABS, available).includes(id));
});
test('extensions views: shared controls, references, namespace and bounds reject malformed packages without partial activation', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.deepEqual(registeredInspectorViews(snapshot).map(entry => entry.view.id), [id, notes]);
  for (const mutate of [
    value => value.contributes.views[0].controls[4].value = 101,
    value => value.contributes.views[0].controls[0].items = Array(101).fill('too many'),
    value => value.contributes.views[0].controls[0] = { kind: 'html', label: 'Unsafe', html: '<script>bad()</script>' },
    value => value.contributes.views[0].toolbar[0].command = 'other.extension/command',
    value => value.contributes.views[0].id = 'panda.core/view',
    value => value.contributes.views.push(structuredClone(value.contributes.views[0])),
  ]) {
    const invalid = structuredClone(manifest); mutate(invalid);
    assert.equal(validateContract('packages', [invalid]).ok, false);
    assert.deepEqual(registeredInspectorViews({ ...snapshot, packages: [{ ...snapshot.packages[0], manifest: invalid }] }), []);
  }
  const activation = createDeclarativeActivation(snapshot, 1);
  const context = { schemaVersion: 1, windowId: 'main', surfaceId: id, revision: 1, projectId: 'clicked-project' };
  assert.equal(activation.viewAction('sample.data-panel/refresh', context).message, 'Data panel refreshed');
  assert.equal(activation.viewAction('sample.data-panel/refresh', { ...context, surfaceId: notes }), undefined);
  assert.equal(activation.viewAction('sample.data-panel/refresh', { ...context, windowId: 'tray' }), undefined);
  assert.equal(activation.actionFor('sample.data-panel/header', { ...context, surfaceId: 'panda.workspace.header.actions' }).view, id);
  activation.dispose(); assert.equal(activation.viewAction('sample.data-panel/refresh', context), undefined);
});
test('extensions views: catalog and scoped overlays retain dormant order/visibility after disable and safe recovery', () => {
  let state = structuredClone(snapshot); const catalog = createUiCatalog(() => state);
  assert.deepEqual(catalog.listItems({ owner: manifest.id, type: 'view', location: INSPECTOR_VIEW_LOCATION }).items.map(item => item.id), [notes, id]);
  const records = new Map(), layout = createLayoutStore({ getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value) });
  layout.setVisible(id, false, 'project-a'); layout.move(INSPECTOR_VIEW_LOCATION, [id, notes], { id: notes, target: id, side: 'before' });
  assert.equal(layout.isHidden(id, 'project-a'), true); assert.equal(layout.isHidden(id, 'project-b'), false);
  state.packages[0].enabled = false;
  assert.deepEqual(catalog.listItems({ owner: manifest.id }).items, []);
  assert.deepEqual(layout.order(INSPECTOR_VIEW_LOCATION, []), []);
  state.packages[0].enabled = true;
  assert.deepEqual(layout.order(INSPECTOR_VIEW_LOCATION, [id, notes]), [notes, id]);
  assert.equal(layout.isHidden(id, 'project-a'), true);
  state.safeMode = true; assert.deepEqual(registeredInspectorViews(state), []);
});
test('extensions views: toolbar context is declared and owner-bound, not permission to invoke another view or window', () => {
  const value = structuredClone(manifest);
  value.contributes.commands.find(command => command.id === 'sample.data-panel/refresh').action = { kind: 'showProjectContext' };
  const state = { ...snapshot, packages: [{ manifest: value, enabled: true, icons: {} }] };
  const broker = createPreviewContextBroker(), data = { projects: [], tasks: [], harnesses: [], connections: [], jobs: [] };
  const request = { op: 'capture', id: 'sample.data-panel/refresh', version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: id, revision: 1 } };
  assert.equal(broker(request, state, data).ok, true);
  for (const context of [{ ...request.context, windowId: 'tray' }, { ...request.context, surfaceId: notes }]) assert.equal(broker({ ...request, context }, state, data).error.code, 'PermissionDenied');
});
test('extensions views: both explicit runners and CI discover the conformance suite', () => {
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-views\.spec\.ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /\|extensions views/);
});
