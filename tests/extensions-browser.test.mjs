import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createBrowserPresentation } from '../src/extensions/browser.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/browser/${name}.json`, import.meta.url), 'utf8'));
test('Browser closed recipe is explicitly selected, bounded and registered in both engines/CI', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  const values = new Map(), storage = { getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) };
  const selection = createComponentSelection(storage);
  assert.equal(selection.resolve('panda.browser', [provider]), undefined);
  selection.select('panda.browser', provider.id, [provider]);
  assert.equal(selection.resolve('panda.browser', [provider]), provider);
  assert.equal(selection.resolve('panda.browser', []), undefined);
  const layout = createLayoutStore(storage), ids = ['panda.browser.controls/reload', 'panda.browser.controls/back'];
  layout.move('panda.browser.controls', ids, { id: ids[1], target: ids[0], side: 'before' });
  assert.deepEqual(layout.order('panda.browser.controls', ids), ids.toReversed());
  for (const change of [{ picked: { tag: 'input', text: 'a'.repeat(513) } }, { picked: { tag: '', text: '', html: 'raw' } }, { url: 'x'.repeat(8193) }, { dom: {} }]) assert.equal(validateContract('browserPresentation', { ...fixture('state'), ...change }).ok, false);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-browser-coverage\.spec\.ts/);
});
test('Browser captures guest/project/session/revision and rejects forgery, replay, pending, platform and revocation', () => {
  let live = fixture('state'), auth = { owner: 'sample.browser/controls', active: true, granted: true }; const calls = [];
  const slot = createBrowserPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.picked));
  for (const [change, reason] of [[{ project: 'B' }, 'StaleContext'], [{ context: 'B' }, 'StaleContext'], [{ guest: 'B' }, 'StaleContext'], [{ session: 'B' }, 'StaleContext'], [{ revision: 4 }, 'StaleContext'], [{ ipc: 'browser_close' }, 'InvalidArguments'], [{ value: 'raw' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability'], [{ controlId: 'execute' }, 'InvalidArguments']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  for (const change of [{ project: 'B' }, { guest: 'B' }, { session: 'B' }, { revision: 4 }, { visible: false }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); }
  for (const change of [{ home: true }, { watching: true }, { embedded: false }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'UnsupportedCapability'); }
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy');
  live = fixture('state'); auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'other.browser/controls'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.browser/controls';
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'controlId', { get() { throw Error('must not read'); }, enumerable: true });
  assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked');
  auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
