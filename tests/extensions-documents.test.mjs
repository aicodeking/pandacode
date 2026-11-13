import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDocumentPresentation } from '../src/extensions/documents.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/documents/extension.json', import.meta.url), 'utf8'));
const props = () => ({ contractVersion: 1, context: 'main/project:A/task:one', revision: 7, selected: 'tab', focused: 'doc', visible: true, tabs: [{ id: 'tab', documentId: 'doc', label: 'Readme', controls: [{ id: 'copy', label: 'Copy file', enabled: true }] }] });
const action = () => ({ contractVersion: 1, context: 'main/project:A/task:one', revision: 7, tabId: 'tab', documentId: 'doc', controlId: 'copy' });
test('document manifest/schema owns closed compatible recipe and explicit conflict selection', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const provider = manifest.contributes.components[0]; assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  for (const change of [{ render: 'code' }, { id: 'other.owner/stolen' }, { presentation: 'html' }]) {
    const invalid = structuredClone(manifest); Object.assign(invalid.contributes.components[0], change); assert.equal(validateContract('packages', [invalid]).ok, false);
  }
  const storage = new Map(), selection = createComponentSelection({ getItem: key => storage.get(key), setItem: (key, value) => storage.set(key, value) });
  const other = { ...provider, id: 'other.documents/viewer' }, providers = [provider, other];
  assert.equal(selection.resolve('panda.documents', providers), undefined);
  selection.select('panda.documents', other.id, providers); assert.equal(selection.resolve('panda.documents', providers), other);
  assert.equal(selection.resolve('panda.documents', [provider]), undefined);
  const layout = createLayoutStore({ getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) });
  layout.select('panda.documents.actions', 'sample.documents/order');
  assert.equal(layout.selected('panda.documents.actions'), 'sample.documents/order');
  for (const location of ['panda.documents.navigation', 'panda.documents.tabs', 'panda.documents.viewer']) {
    const ids = [`${location}/first`, `${location}/second`];
    layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' });
    assert.deepEqual(layout.order(location, ids), [ids[1], ids[0]]);
    const proposal = structuredClone(manifest);
    proposal.contributes.layouts[0].location = location;
    proposal.contributes.layouts[0].rules = [{ id: ids[1], target: ids[0], side: 'before' }];
    assert.equal(validateContract('packages', [proposal]).ok, true);
  }
  const invalidLayout = structuredClone(manifest); invalidLayout.contributes.layouts[0].location = 'panda.documents.unknown';
  assert.equal(validateContract('packages', [invalidLayout]).ok, false);
  const invalidMenu = structuredClone(manifest); invalidMenu.contributes.menus[0].location = 'panda.documents.viewer';
  assert.equal(validateContract('packages', [invalidMenu]).ok, false);
});
test('documents immutable identities and structured original action reject forged, stale, unsupported and revoked requests', () => {
  let latest = props(), allowed = true; const calls = [];
  const instance = createDocumentPresentation(latest, () => latest, () => allowed, action => calls.push(action));
  assert.ok(Object.isFrozen(instance.props.tabs[0].controls[0])); assert.equal(instance.props.focused, 'doc');
  assert.deepEqual(instance.dispatch(action()), { ok: true });
  for (const [change, reason] of [[{ documentId: 'forged' }, 'InvalidArguments'], [{ tabId: 'forged' }, 'InvalidArguments'], [{ ipc: 'secret' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability'], [{ controlId: 'delete' }, 'UnsupportedCapability'], [{ revision: 6 }, 'StaleContext'], [{ context: 'B' }, 'StaleContext']]) assert.deepEqual(instance.dispatch({ ...action(), ...change }), { ok: false, reason });
  latest = { ...props(), revision: 8 }; assert.equal(instance.dispatch(action()).reason, 'StaleContext');
  latest = props(); allowed = false; assert.equal(instance.dispatch(action()).reason, 'Revoked');
  allowed = true; instance.dispose(); assert.equal(instance.dispatch(action()).reason, 'Revoked'); assert.equal(calls.length, 1);
});
test('document DTO payload and duplicate identities are bounded', () => {
  assert.equal(validateContract('documentPresentation', props()).ok, true);
  assert.equal(validateContract('documentAction', action()).ok, true);
  for (const change of [{ contractVersion: 2 }, { revision: -1 }, { tabId: '' }, { ipc: 'forged' }]) assert.equal(validateContract('documentAction', { ...action(), ...change }).ok, false);
  for (const change of [{ tabs: Array(1001).fill(props().tabs[0]) }, { tabs: [...props().tabs, ...props().tabs] }, { selected: 'missing' }, { revision: -1 }]) assert.throws(() => createDocumentPresentation({ ...props(), ...change }, props, () => true, () => {}));
});
test('document browser suite is in both explicit runners and CI', () => {
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-documents-coverage\.spec\.ts/);
});
