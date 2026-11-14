import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createGithubHubPresentation, snapshotGithubHub } from '../src/extensions/github-hub.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { GITHUB_HUB_CONTROLS } from '../src/extensions/surfaces.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/github-hub/${name}.json`, import.meta.url), 'utf8'));
test('GitHub hub schema, package, selected recipe, bounded catalog and reversible layouts', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true); assert.equal(componentIncompatibility(provider), undefined);
  for (const change of [{ capabilities: [] }, { capabilities: [...provider.capabilities, 'merge'] }, { presentation: 'cards' }, { contractVersion: 2 }]) assert.ok(componentIncompatibility({ ...provider, ...change }));
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) }, selection = createComponentSelection(storage), layout = createLayoutStore(storage);
  assert.equal(selection.resolve('panda.githubHub', [provider]), undefined); selection.select('panda.githubHub', provider.id, [provider]); assert.equal(selection.resolve('panda.githubHub', [provider]), provider); assert.equal(selection.resolve('panda.githubHub', []), undefined);
  const catalog = createUiCatalog(() => ({ safeMode: false, packages: [] }));
  for (const [location, controls] of Object.entries(GITHUB_HUB_CONTROLS)) {
    const items = catalog.listItems({ location }).items; assert.deepEqual(items.map(item => item.id), controls.map(([id]) => `${location}/${id}`).sort());
    for (const item of items) { layout.setVisible(item.id, false); assert.equal(layout.isHidden(item.id), true); layout.setVisible(item.id, true); assert.equal(layout.isHidden(item.id), false); }
    const ids = items.map(item => item.id); layout.move(location, ids, { id: ids[1], target: ids[0], side: 'before' }); assert.equal(layout.order(location, ids)[0], ids[1]);
  }
  for (const change of [{ rows: Array(501).fill(fixture('state').rows[0]) }, { controls: Array(257).fill(fixture('state').controls[0]) }, { query: 'x'.repeat(201) }, { selector: 'body' }, { window: 'tray' }, { contractVersion: 2 }]) assert.equal(validateContract('githubHubPresentation', { ...fixture('state'), ...change }).ok, false);
  assert.throws(() => snapshotGithubHub({ ...fixture('state'), rows: Array(2).fill(fixture('state').rows[0]) }), /Duplicate/);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-github-hub-coverage\.spec\.ts/);
});
test('GitHub hub binds owner/window/repository/project/tab/resource/attempt/revision, consent, offline and replay', () => {
  let live = fixture('state'); const auth = { owner: 'sample.github-hub/tabs', active: true, granted: true, taskControl: true, userChoice: true }, calls = [];
  const slot = createGithubHubPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action)); assert.ok(Object.isFrozen(slot.props.rows[0]));
  for (const key of ['context', 'repository', 'project', 'tab', 'revision']) {
    const value = key === 'revision' ? 4 : key === 'tab' ? 'issues' : 'foreign';
    assert.equal(slot.dispatch({ ...fixture('action'), [key]: value }).reason, 'StaleContext'); live = { ...fixture('state'), [key]: value }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); live = fixture('state');
  }
  for (const change of [{ control: 'foreign' }, { resource: 'foreign' }, { attempt: 1 }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'StaleContext');
  for (const [field, reason] of [['busy', 'Busy'], ['offline', 'Offline']]) { live = { ...fixture('state'), [field]: true }; assert.equal(slot.dispatch(fixture('action')).reason, reason); } live = fixture('state');
  auth.taskControl = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.taskControl = true;
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'foreign/tabs'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.github-hub/tabs';
  for (const change of [{ selector: 'body' }, { controlId: 'merge' }, { window: 'tray' }, { value: 'mutation' }]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, 'InvalidArguments');
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'control', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.equal(slot.dispatch({ ...fixture('action'), contractVersion: 2 }).reason, 'UnsupportedCapability');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
test('GitHub hub metadata never grants task or external-entry authority', () => {
  for (const controlId of ['review', 'issue-thread', 'solve', 'fix', 'workflow', 'compose', 'clone', 'open']) {
    const state = fixture('state'); state.controls[0].controlId = controlId;
    const slot = createGithubHubPresentation(state, 'owner', () => state, () => ({ owner: 'owner', active: true, granted: true, taskControl: false, userChoice: false }), () => assert.fail('unauthorized dispatch'));
    assert.equal(slot.dispatch({ ...fixture('action'), controlId }).reason, 'PermissionDenied');
  }
});
