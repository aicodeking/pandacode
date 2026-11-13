import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createTerminalPresentation } from '../src/extensions/terminal.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { componentIncompatibility, createComponentSelection } from '../src/extensions/component-slot.ts';
const fixture = name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/terminal/${name}.json`, import.meta.url), 'utf8'));
test('Terminal recipe is installable, selected, capability-complete and registered in both engines/CI', () => {
  const manifest = fixture('extension'), provider = manifest.contributes.components[0];
  assert.equal(validateContract('packages', [manifest]).ok, true);
  assert.equal(componentIncompatibility(provider), undefined);
  assert.match(componentIncompatibility({ ...provider, capabilities: [] }), /Missing/);
  assert.match(componentIncompatibility({ ...provider, contractVersion: 2 }), /version/);
  const values = new Map(), selection = createComponentSelection({ getItem: key => values.get(key) ?? null, setItem: (key, value) => values.set(key, value) });
  assert.equal(selection.resolve('panda.terminal', [provider]), undefined);
  selection.select('panda.terminal', provider.id, [provider]);
  assert.equal(selection.resolve('panda.terminal', [provider]), provider);
  assert.equal(selection.resolve('panda.terminal', []), undefined);
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-terminal-coverage\.spec\.ts/);
});
test('Terminal capture rejects stale/foreign/PID/shell actions, pending, replay and revoked authority', () => {
  let live = fixture('state'), auth = { owner: 'sample.terminal/tabs', active: true, granted: true }; const calls = [];
  const slot = createTerminalPresentation(live, auth.owner, () => live, () => auth, action => calls.push(action));
  assert.ok(Object.isFrozen(slot.props.tabs[0]));
  for (const [change, reason] of [[{ project: 'B' }, 'StaleContext'], [{ context: 'B' }, 'StaleContext'], [{ group: 'B' }, 'StaleContext'], [{ session: 'B' }, 'StaleContext'], [{ revision: 4 }, 'StaleContext'], [{ tab: '1234' }, 'InvalidArguments'], [{ pid: 1234 }, 'InvalidArguments'], [{ command: 'echo forged' }, 'InvalidArguments'], [{ terminalId: 'native' }, 'InvalidArguments'], [{ controlId: 'write' }, 'InvalidArguments'], [{ contractVersion: 2 }, 'UnsupportedCapability']]) assert.equal(slot.dispatch({ ...fixture('action'), ...change }).reason, reason);
  const accessor = { ...fixture('action') }; Object.defineProperty(accessor, 'tab', { get() { throw Error('must not read'); }, enumerable: true }); assert.equal(slot.dispatch(accessor).reason, 'InvalidArguments');
  for (const change of [{ project: 'B' }, { group: 'B' }, { session: 'B' }, { revision: 4 }, { visible: false }]) { live = { ...fixture('state'), ...change }; assert.equal(slot.dispatch(fixture('action')).reason, 'StaleContext'); }
  live = { ...fixture('state'), busy: true }; assert.equal(slot.dispatch(fixture('action')).reason, 'Busy'); live = fixture('state');
  auth.granted = false; assert.equal(slot.dispatch(fixture('action')).reason, 'PermissionDenied'); auth.granted = true;
  auth.owner = 'other.terminal/tabs'; assert.equal(slot.dispatch(fixture('action')).reason, 'WrongOwner'); auth.owner = 'sample.terminal/tabs';
  assert.deepEqual(slot.dispatch(fixture('action')), { ok: true }); assert.equal(slot.dispatch(fixture('action')).reason, 'AlreadyApplied');
  auth.active = false; assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); auth.active = true; slot.dispose(); assert.equal(slot.dispatch(fixture('action')).reason, 'Revoked'); assert.equal(calls.length, 1);
});
