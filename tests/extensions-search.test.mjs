import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createSearchPresentation } from '../src/extensions/search.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/search/${name}.json`, import.meta.url), 'utf8'));
test('Search package, explicit closed selection, control ordering and schema bounds', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const selection = createComponentSelection(storage);
  assert.equal(selection.resolve('panda.search', [provider]), undefined);
  selection.select('panda.search', provider.id, [provider]);
  assert.equal(selection.resolve('panda.search', [provider]), provider);
  assert.equal(selection.resolve('panda.search', []), undefined);
  const layout = createLayoutStore(storage), ids = ['panda.search.controls/regex', 'panda.search.controls/match-case'];
  layout.move('panda.search.controls', ids, { id: ids[1], target: ids[0], side: 'before' });
  assert.deepEqual(layout.order('panda.search.controls', ids), ids.toReversed());
  for (const changes of [{ results: Array(65).fill(fixture('state').results[0]) }, { results: [...fixture('state').results, ...fixture('state').results] }, { query: 'a'.repeat(513) }, { source: 'private text' }]) assert.equal(validateContract('searchPresentation', { ...fixture('state'), ...changes }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-search-coverage\.spec\.ts/);
});
test('Search actions capture query/project/result/revision; reject forgery, replay and revocation', () => {
  let live = fixture('state'), auth = { owner: 'sample.search/results', active: true, granted: true, metadata: true }; const calls = [];
  const slot = createSearchPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.results[0]));
  for (const [change, reason] of [[{ project: 'B' }, 'StaleContext'], [{ context: 'B' }, 'StaleContext'], [{ query: 'B' }, 'StaleContext'], [{ revision: 4 }, 'StaleContext'], [{ resultId: 'forged' }, 'StaleContext'], [{ path: '/etc/passwd' }, 'InvalidArguments'], [{ value: 'raw' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability'], [{ controlId: 'execute' }, 'InvalidArguments']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  for (const change of [{ query: 'B' }, { project: 'B' }, { revision: 4 }, { visible: false }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); }
  live = fixture('state'); auth.metadata = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.metadata = true;
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'other.search/results'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.search/results';
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
