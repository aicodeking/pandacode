import { test, expect } from '@playwright/test';
import { readFileSync, readdirSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { ARGS_BYTES, COMMANDS, EVENTS, InternalModel, MAX_ACTIVITY, MAX_LISTENERS, MAX_QUEUE, PERMISSION, gate, readRequest, reserved } from '../src/extensions/runtime-internal-unstable';

// Preview column of R1301 (the granted unstable internal interface). The groups run the deterministic model in
// src/extensions/runtime-internal-unstable.ts, which mirrors src-tauri/src/extensions/runtime_internal_unstable.rs (whose own unit
// tests are `runtime_internal_unstable::tests`). A real service calling through the installed broker is a native test, reported in
// its own column: this file claims only the preview and model column.
//
// Refusal-test reconciliation (Q001, Q046, Q059): those rows refused a raw bridge to a package:
// - Q001 and Q046 (`bridge.call` and the four task-control action kinds are not valid declarative actions) are RETAINED unchanged.
//   A manifest action is a declaration, not a call a grant can authorize; the permissioned way to reach the host is the service-only
//   `panda.internal.*` below. Reason: a declaration cannot hold a grant, be revoked or be attributed (a structural fact), so the
//   declarative refusal does not weaken when the grant exists.
// - Q059 (`raw-ipc` is an excluded data primitive) is RETAINED unchanged. Reason: data primitives run with no package identity;
//   `internal.unstable` is checked per call against the installed service's identity (a structural fact, not a security limit).
// What this slice changes is only the permissioned assertions: a trusted, granted service can invoke and listen; an ungranted,
// revoked, untrusted or panel caller is refused natively. Unauthorized, stale and foreign-owner denials stay.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-internal-unstable/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-internal-unstable/main.cjs');
const OWNER = 'sample.runtime-internal-unstable';
const granted = { holds: true, service: true };
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
const value = (reply: unknown) => (reply as { value: any }).value;

test('extensions runtime internal unstable: the fixture declares the grant and a service, uses both calls and names no credential', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.internal.invoke', 'panda.internal.listen', 'internal.echo', 'internal.info', 'refuse']) expect(fixtureSource, call).toContain(call);
  expect(fixtureSource).not.toMatch(/credentials\.|secrets\./);
});

test('extensions runtime internal unstable: every call reads its fields and refuses the rest', () => {
  expect(readRequest({ op: 'invoke', command: 'internal.info' })).toEqual({ op: 'invoke', command: 'internal.info', args: null });
  expect(readRequest({ op: 'invoke', command: 'internal.echo', args: { a: 1 } })).toEqual({ op: 'invoke', command: 'internal.echo', args: { a: 1 } });
  expect(readRequest({ op: 'listen', event: 'internal.echoed' })).toEqual({ op: 'listen', event: 'internal.echoed' });
  expect(readRequest({ op: 'poll', listenerId: 'x' })).toEqual({ op: 'poll', listener: 'x' });
  for (const raw of ['x', {}, { op: 'call' }, { op: 'invoke' }, { op: 'invoke', command: '' }, { op: 'invoke', command: 'Internal.Info' }, { op: 'invoke', command: 'a b' }, { op: 'invoke', command: 3 }, { op: 'invoke', command: 'a', extra: 1 }, { op: 'listen' }, { op: 'poll' }, { op: 'unlisten', listenerId: '' }]) {
    expect(readRequest(raw), JSON.stringify(raw)).toMatchObject({ error: { code: 'InvalidShape' } });
  }
  expect(readRequest({ op: 'invoke', command: 'internal.echo', args: 'x'.repeat(ARGS_BYTES + 1) })).toMatchObject({ error: { code: 'LimitExceeded' } });
});

test('extensions runtime internal unstable: the grant answers first, then the credential rule, then the table', () => {
  expect(gate(false, COMMANDS, 'internal.info')).toMatchObject({ error: { code: 'PermissionDenied', path: PERMISSION } });
  expect(gate(false, COMMANDS, 'nothing.here')).toMatchObject({ error: { code: 'PermissionDenied', path: PERMISSION } });
  expect(gate(true, COMMANDS, 'internal.info')).toBeNull();
  expect(gate(true, COMMANDS, 'app.restart')).toMatchObject({ error: { code: 'NotFound' } });
  for (const name of ['secret_store.get', 'held-credentials.read', 'oauth.token', 'auth.sign-in', 'keychain.read', 'password.reveal', 'private_key']) {
    expect(gate(true, COMMANDS, name), name).toMatchObject({ error: { code: 'PermissionDenied', path: 'credentials' } });
  }
  expect([...COMMANDS, ...EVENTS].some(reserved)).toBe(false);
});

test('extensions runtime internal unstable: a granted service invokes and listens, then dispose, revoke and repeat leave nothing behind', () => {
  const host = new InternalModel();
  expect(value(host.call(OWNER, granted, { op: 'invoke', command: 'internal.info' })).stability).toBe('unstable');
  const listener = value(host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' })).listenerId as string;
  expect(value(host.call(OWNER, granted, { op: 'invoke', command: 'internal.echo', args: { n: 7 } })).echo).toEqual({ n: 7 });
  expect(value(host.call(OWNER, granted, { op: 'poll', listenerId: listener }))).toMatchObject({ events: [{ n: 7 }], dropped: 0 });
  expect(value(host.call(OWNER, granted, { op: 'poll', listenerId: listener })).events).toEqual([]);
  host.call(OWNER, granted, { op: 'unlisten', listenerId: listener });
  expect(host.count(OWNER)).toBe(0);
  // Revoke: the next call is refused natively and the listener goes with it; repeating it changes nothing.
  const again = value(host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' })).listenerId as string;
  for (let round = 0; round < 2; round += 1) expect(host.call(OWNER, { holds: false, service: true }, { op: 'poll', listenerId: again })).toMatchObject({ error: { code: 'PermissionDenied', path: PERMISSION } });
  expect(host.count(OWNER)).toBe(0);
});

test('extensions runtime internal unstable: ungranted, untrusted and panel callers are refused; a panel gets UnsupportedCapability', () => {
  const host = new InternalModel();
  expect(host.call(OWNER, { holds: false, service: true }, { op: 'invoke', command: 'internal.info' })).toMatchObject({ error: { code: 'PermissionDenied', path: PERMISSION } });
  expect(host.call(OWNER, { holds: true, service: false }, { op: 'invoke', command: 'internal.info' })).toMatchObject({ error: { code: 'UnsupportedCapability' } });
  expect(host.call(OWNER, { holds: true, service: false }, { op: 'listen', event: 'internal.echoed' })).toMatchObject({ error: { code: 'UnsupportedCapability' } });
  // A foreign package can neither poll nor remove another package's listener.
  const id = value(host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' })).listenerId as string;
  expect(code(host.call('sample.other', granted, { op: 'poll', listenerId: id }))).toBe('NotFound');
  host.call('sample.other', granted, { op: 'unlisten', listenerId: id });
  expect(host.count(OWNER)).toBe(1);
  // Disable, safe mode, untrust and the service's end drop every listener, and only of that package.
  host.call('sample.other', granted, { op: 'listen', event: 'internal.echoed' });
  expect(host.dropListeners(OWNER)).toBe(1);
  expect(host.count('sample.other')).toBe(1);
});

test('extensions runtime internal unstable: queues, listeners and the activity list are bounded and the list holds no argument or result', () => {
  const host = new InternalModel();
  const id = value(host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' })).listenerId as string;
  for (let n = 0; n < MAX_QUEUE + 5; n += 1) host.publish('internal.echoed', n);
  const page = value(host.call(OWNER, granted, { op: 'poll', listenerId: id }));
  expect([page.events.length, page.dropped, page.events[0]]).toEqual([MAX_QUEUE, 5, 5]);
  for (let n = 1; n < MAX_LISTENERS; n += 1) host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' });
  expect(host.call(OWNER, granted, { op: 'listen', event: 'internal.echoed' })).toMatchObject({ error: { code: 'LimitExceeded' } });
  host.call(OWNER, granted, { op: 'invoke', command: 'secret_store.get', args: { canary: 'CANARY-VALUE' } });
  for (let n = 0; n < MAX_ACTIVITY + 5; n += 1) host.call(OWNER, granted, { op: 'invoke', command: 'internal.info' });
  const list = host.activity(OWNER);
  expect(list.length).toBe(MAX_ACTIVITY);
  expect(JSON.stringify(list)).not.toContain('CANARY-VALUE');
  expect(list.every(line => line.stability === 'unstable' && line.package === OWNER)).toBe(true);
});

test('extensions runtime internal unstable: wiring, unstable labels and secret/panel rules are in the sources', () => {
  const native = read('src-tauri/src/extensions/runtime_internal_unstable.rs');
  expect(native).toContain('pub fn extensions_internal_activity');
  expect(native).toContain('"internal.unstable"');
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('pub mod runtime_internal_unstable;');
  expect(read('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain('runtime_internal_unstable::serve');
  expect(read('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain('runtime_internal_unstable::service_stopped');
  expect(read('src-tauri/src/extensions/runtime_rich_channel.rs')).toMatch(/SERVICE_ONLY[^\n]*"internal"/);
  const host = read('src-tauri/src/extensions/node-host.cjs');
  expect(host).toContain("rpc('internal'");
  expect(read('src-tauri/src/lib.rs')).toContain('runtime_internal_unstable::extensions_internal_activity');
  const sdk = read('src/extensions/sdk/index.d.ts');
  expect(sdk).toMatch(/internal: InternalApi/);
  expect(sdk).toMatch(/NO compatibility promise|no compatibility promise/i);
  expect(read('src/extensions/preview.ts')).toContain('extensions_internal_activity');
  const doc = read('docs/extensions/runtime-internal-unstable.md');
  expect(doc).toMatch(/no compatibility promise/i);
  expect(doc).toContain('UnsupportedCapability');
  expect(read('docs/extensions/README.md')).toContain('may change without notice');
  // No reference package depends on internal calls.
  const root = new URL('../examples/extensions/', import.meta.url);
  const files = (readdirSync(root, { recursive: true }) as string[]).filter(name => /\.(cjs|mjs|js|json)$/.test(name) && !name.includes('node_modules'));
  expect(files.length).toBeGreaterThan(0);
  for (const name of files) expect(readFileSync(new URL(name, root), 'utf8'), name).not.toMatch(/panda\.internal|internal\.unstable/);
  // The retained refusals still stand in their own tests.
  expect(read('tests/extensions-thread-actions.test.mjs')).toContain('bridge.call');
  expect(read('tests/extensions-primitives.test.mjs')).toContain('raw-ipc');
});
