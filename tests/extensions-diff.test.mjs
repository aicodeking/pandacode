import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createChangesPresentation } from '../src/extensions/diff.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/diff/${name}.json`, import.meta.url), 'utf8'));
const props = () => fixture('state'), action = () => fixture('action'), manifest = fixture('extension');
test('Changes package, SDK vocabulary, bounded schema, compatible layouts and explicit selection', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const provider = manifest.contributes.components[0]; assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  for (const change of [{ presentation: 'html' }, { render: 'callback' }, { id: 'wrong.owner/commit' }]) {
    const invalid = structuredClone(manifest); Object.assign(invalid.contributes.components[0], change); assert.equal(validateContract('packages', [invalid]).ok, false);
  }
  const storage = new Map(), io = { getItem: key => storage.get(key) ?? null, setItem: (key, value) => storage.set(key, value) };
  const selection = createComponentSelection(io), other = { ...provider, id: 'other.diff/commit' }, providers = [provider, other];
  assert.equal(selection.resolve('panda.changes', providers), undefined);
  selection.select('panda.changes', other.id, providers); assert.equal(selection.resolve('panda.changes', providers), other);
  assert.equal(selection.resolve('panda.changes', [provider]), undefined);
  const layout = createLayoutStore(io);
  for (const location of ['panda.changes.controls', 'panda.changes.file', 'panda.changes.viewer']) {
    const proposal = structuredClone(manifest); proposal.contributes.layouts[0].location = location;
    const ids = [`${location}/first`, `${location}/second`]; proposal.contributes.layouts[0].rules = [{ id: ids[1], target: ids[0], side: 'before' }];
    assert.equal(validateContract('packages', [proposal]).ok, true);
    layout.move(location, ids, proposal.contributes.layouts[0].rules[0]); assert.deepEqual(layout.order(location, ids), [ids[1], ids[0]]);
  }
});
test('Changes captured repository/file/hunk revisions, owner, grant, pending and replay admission', () => {
  let latest = props(), auth = { owner: 'sample.diff/commit', granted: true, active: true }; const calls = [];
  const instance = createChangesPresentation(latest, auth.owner, () => latest, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(instance.props.files[0].hunks[0])); assert.equal(instance.props.scope, 'staged');
  for (const [change, reason] of [[{ context: 'B' }, 'StaleContext'], [{ repository: 'B' }, 'StaleContext'], [{ revision: 6 }, 'StaleContext'], [{ fileId: 'B' }, 'StaleContext'], [{ diffId: 'B' }, 'StaleContext'], [{ fileRevision: 2 }, 'StaleContext'], [{ hunkId: 'hunk-A', hunkRevision: 2 }, 'StaleContext'], [{ hunkId: 'hunk-A', hunkRevision: 3 }, 'UnsupportedCapability'], [{ controlId: 'stage-hunk' }, 'UnsupportedCapability'], [{ contractVersion: 2 }, 'UnsupportedCapability'], [{ ipc: 'raw' }, 'InvalidArguments'], [{ requestId: '' }, 'InvalidArguments'], [{ hunkRevision: 3 }, 'InvalidArguments']]) assert.deepEqual(instance.dispatch({ ...action(), ...change }), { ok: false, reason });
  for (const [change, reason] of [[{ repository: 'B' }, 'StaleContext'], [{ revision: 8 }, 'StaleContext'], [{ visible: false }, 'StaleContext'], [{ pending: true }, 'Busy'], [{ loading: true }, 'UnsupportedCapability'], [{ error: true }, 'UnsupportedCapability'], [{ offline: true }, 'UnsupportedCapability']]) { latest = { ...props(), ...change }; assert.equal(instance.dispatch(action()).reason, reason); }
  latest = props(); auth.owner = 'other.diff/commit'; assert.equal(instance.dispatch(action()).reason, 'WrongOwner');
  auth.owner = 'sample.diff/commit'; auth.granted = false; assert.equal(instance.dispatch(action()).reason, 'PermissionDenied');
  auth.granted = true; auth.active = false; assert.equal(instance.dispatch(action()).reason, 'Revoked'); auth.active = true;
  assert.deepEqual(instance.dispatch(action()), { ok: true }); assert.equal(instance.dispatch(action()).reason, 'AlreadyApplied');
  instance.dispose(); assert.equal(instance.dispatch({ ...action(), requestId: 'new' }).reason, 'Revoked'); assert.equal(calls.length, 1);
});
test('Changes duplicate, unsupported and oversized DTOs fail closed', () => {
  assert.equal(validateContract('changesPresentation', props()).ok, true); assert.equal(validateContract('changesAction', action()).ok, true);
  for (const change of [{ revision: -1 }, { selected: 'missing' }, { files: [...props().files, ...props().files] }, { files: Array(257).fill(props().files[0]) }, { rawPatch: 'private' }]) assert.equal(validateContract('changesPresentation', { ...props(), ...change }).ok, false);
  const duplicate = props(); duplicate.files[0].hunks.push(duplicate.files[0].hunks[0]); assert.equal(validateContract('changesPresentation', duplicate).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-diff-coverage\.spec\.ts/);
});
