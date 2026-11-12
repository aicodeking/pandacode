import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';
import { createContextClient, contextFailure } from '../src/extensions/context-state.ts';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-context/extension.json', import.meta.url), 'utf8'));
const context = projectId => ({ schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', projectId, revision: 1 });
function fixture() {
  const broker = createPreviewContextBroker();
  const state = { safeMode: false, packages: [{ enabled: true, manifest: structuredClone(manifest), icons: {} }], diagnostics: [] };
  const data = { projects: [{ id: 'A', name: 'Alpha', path: 'SECRET_PATH' }, { id: 'B', name: 'Beta' }], tasks: [{ id: 'a', projectId: 'A', status: 'running', title: 'SECRET_PROMPT', pid: 987 }, { id: 'b', projectId: 'B', status: 'idle' }], harnesses: [{ id: 'claude', name: 'Claude Code', installed: 'Installed', version: '2.1.0', auth: 'SECRET_AUTH' }, { id: 'codex', name: 'Codex', installed: 'Absent' }, { id: 'kimi', name: 'Kimi', installed: 'Unknown', version: 'SECRET_DIAGNOSTIC' }], connections: [{ id: 'ca', projectId: 'A', provider: 'claude', env: { SECRET_ENV: 'SECRET_TOKEN' }, auth: 'SECRET_AUTH', configDir: 'SECRET_DIR' }, { id: 'cb', projectId: 'B', provider: 'codex' }] };
  const call = request => broker(request, state, data);
  const capture = projectId => call({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: context(projectId) }).value.handle;
  const allow = (handle, capability, allow = true) => call({ op: 'consent', handle, capability, allow });
  const query = (handle, resource) => call({ op: 'query', handle, resource, limit: 10 });
  const subscribe = (handle, resource = 'jobs') => call({ op: 'subscribe', handle, resource, limit: 10 });
  const events = (handle, stream) => call({ op: 'events', handle, subscription: stream.subscription, cursor: stream.cursor });
  return { broker, state, data, call, capture, allow, query, subscribe, events };
}
test('extensions inventory: explicit independent grants and safe harness/connection/owned-job DTOs', () => {
  const f = fixture(), a = f.capture('A');
  assert.equal(validateContract('packages', [manifest]).ok, true);
  for (const [resource, capability] of [['harnesses', 'harnesses.inventory'], ['connections', 'connections.summary'], ['jobs', 'jobs.summary']]) {
    assert.deepEqual(f.query(a, resource), contextFailure('PermissionDenied')); assert.equal(f.allow(a, capability).ok, true);
    const reply = f.query(a, resource); assert.equal(reply.ok, true);
    for (const marker of ['SECRET', 'pid', 'configDir', 'env', 'auth:']) assert.equal(JSON.stringify(reply).includes(marker), false);
  }
  assert.deepEqual(f.query(a, 'harnesses').value.items.map(item => [item.installed, item.version]), [['Installed', '2.1.0'], ['Absent', null], ['Unknown', null]]);
  assert.deepEqual(f.query(a, 'connections').value.items, [{ id: 'ca', name: 'claude', status: 'Configured', authentication: 'Unknown', capabilities: ['harness.launch'] }]);
  assert.deepEqual(f.query(a, 'jobs').value.items, [{ id: 'a', projectId: 'A', kind: 'agentTask', status: 'running' }]);
  f.data.tasks[0].status = 'SECRET_ERROR'; assert.equal(f.query(a, 'jobs').value.items[0].status, 'unknown');
  assert.deepEqual(f.query(a, 'processes'), contextFailure('UnsupportedCapability'));
});
test('extensions inventory: two project streams reject stolen handles and forged window/project identities', () => {
  const f = fixture(), a = f.capture('A'), b = f.capture('B');
  f.allow(a, 'jobs.summary'); assert.deepEqual(f.subscribe(b), contextFailure('PermissionDenied')); f.allow(b, 'jobs.summary');
  const sa = f.subscribe(a).value, sb = f.subscribe(b).value;
  f.broker.record('a', 'progress', 'running'); f.broker.record('a', 'terminal', 'completed'); f.broker.record('b', 'terminal', 'stopped');
  assert.deepEqual(f.events(a, sa).value.events.map(item => item.id), ['a', 'a']);
  assert.deepEqual(f.events(b, sb).value.events, [{ sequence: 1, revision: 'event:1', id: 'b', kind: 'terminal', status: 'stopped' }]);
  assert.deepEqual(f.events(b, sa), contextFailure('PermissionDenied'));
  for (const key of ['windowId', 'projectId', 'extensionId', 'pid']) assert.deepEqual(f.call({ op: 'events', handle: a, subscription: sa.subscription, cursor: sa.cursor, [key]: 'B' }), contextFailure('InvalidShape'));
  assert.deepEqual(f.call({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: { ...context('A'), windowId: 'second-window' } }), contextFailure('PermissionDenied'));
});
test('extensions inventory: snapshot cursor coalescing, terminal ordering, overflow and reconnect explicitly resync', () => {
  const f = fixture(), a = f.capture('A'); f.allow(a, 'jobs.summary'); let stream = f.subscribe(a).value;
  f.broker.record('a', 'progress', 'running'); f.broker.record('a', 'progress', 'running');
  let reply = f.events(a, stream).value; assert.equal(reply.resync, true); assert.ok(reply.snapshot); assert.deepEqual(reply.events, []);
  stream = { ...stream, cursor: reply.cursor }; f.broker.record('a', 'terminal', 'completed'); f.broker.record('a', 'progress', 'running'); f.broker.record('a', 'terminal', 'failed');
  reply = f.events(a, stream).value; assert.equal(reply.resync, false); assert.deepEqual(reply.events.map(item => [item.kind, item.status]), [['terminal', 'completed'], ['progress', 'running'], ['terminal', 'failed']]);
  const reconnect = f.events(a, stream).value; assert.equal(reconnect.resync, true); assert.ok(reconnect.snapshot);
  stream = { ...stream, cursor: reconnect.cursor }; for (let i = 0; i < 140; i++) f.broker.record('a', 'terminal', 'stopped');
  reply = f.events(a, stream).value; assert.equal(reply.resync, true); assert.ok(reply.snapshot); assert.deepEqual(reply.events, []);
});
test('extensions inventory: updates, removal, revocation, disable, release and subscription caps dispose deterministically', () => {
  const f = fixture(), a = f.capture('A'); f.allow(a, 'jobs.summary');
  const first = f.subscribe(a).value; f.data.tasks[0].status = 'completed'; assert.equal(f.events(a, first).value.snapshot.items[0].status, 'completed');
  for (let i = 0; i < 4; i++) assert.equal(f.subscribe(a).ok, true);
  assert.deepEqual(f.subscribe(a), contextFailure('LimitExceeded')); assert.equal(f.broker.subscriptionCount(), 5);
  f.allow(a, 'jobs.summary', false); assert.equal(f.broker.subscriptionCount(), 0); assert.deepEqual(f.events(a, first), contextFailure('StaleContext'));
  f.allow(a, 'jobs.summary'); const removed = f.subscribe(a).value; f.subscribe(a);
  const b = f.capture('B'); f.allow(b, 'jobs.summary'); const other = f.subscribe(b).value;
  f.data.projects.shift(); assert.deepEqual(f.events(a, removed), contextFailure('NotFound')); assert.equal(f.broker.subscriptionCount(), 1); assert.equal(f.events(b, other).ok, true);
  f.data.projects.push({ id: 'A', name: 'Alpha' }); f.subscribe(a); f.broker.invalidate('sample.project-context'); assert.equal(f.broker.subscriptionCount(), 0);
  const fresh = f.capture('A'); f.allow(fresh, 'jobs.summary'); f.subscribe(fresh); f.call({ op: 'release', handle: fresh }); assert.equal(f.broker.subscriptionCount(), 0);
});
test('extensions inventory: bounded pagination versions, no-project and non-echoing diagnostic paths', () => {
  const f = fixture(), a = f.capture('A'); f.allow(a, 'jobs.summary');
  const first = f.call({ op: 'query', handle: a, resource: 'jobs', limit: 1 }); f.data.tasks.push({ id: 'a2', projectId: 'A', status: 'pending' });
  assert.deepEqual(f.call({ op: 'query', handle: a, resource: 'jobs', limit: 1, revision: first.value.revision }), contextFailure('StaleContext'));
  assert.deepEqual(f.call({ op: 'subscribe', handle: a, resource: 'jobs', limit: 51 }), contextFailure('LimitExceeded'));
  const stream = f.subscribe(a).value; assert.deepEqual(f.events(a, { ...stream, cursor: 'SECRET'.repeat(100) }), contextFailure('LimitExceeded'));
  const none = f.call({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: context('A').surfaceId, revision: 1 } }).value.handle;
  f.allow(none, 'jobs.summary'); assert.equal(f.subscribe(none).value.snapshot.state, 'NoProject');
});
const settle = () => new Promise(resolve => setImmediate(resolve));
function scheduler() { let next; return { schedule: callback => { next = callback; return callback; }, cancel: () => { next = undefined; }, tick: async () => { const callback = next; next = undefined; callback?.(); await settle(); }, active: () => Boolean(next) }; }
test('extensions inventory: host watcher reconnects after a lost committed response and releases its timer/subscription', async () => {
  const f = fixture(), clock = scheduler(), seen = []; let lose = false;
  const client = createContextClient('sample.project-context/header', '1.0.0', context('A'), async request => { const reply = f.call(request); if (request.op === 'events' && lose) { lose = false; throw new Error('SECRET transport failure'); } return reply; });
  await client.consent('jobs.summary', true); const stop = client.watch('jobs', result => seen.push(result), clock); await settle(); assert.equal(f.broker.subscriptionCount(), 1);
  lose = true; await clock.tick(); assert.deepEqual(seen.at(-1), contextFailure('HostUnavailable')); assert.equal(clock.active(), true);
  await clock.tick(); assert.equal(seen.at(-1).value.resync, true); stop(); stop(); await settle(); assert.equal(clock.active(), false); assert.equal(f.broker.subscriptionCount(), 0); client.dispose();
});
test('extensions inventory: lost initial subscribe acknowledgement retries without retaining an unknown stream', async () => {
  const f = fixture(), clock = scheduler(), seen = []; let lose = true;
  const client = createContextClient('sample.project-context/header', '1.0.0', context('A'), async request => {
    const reply = f.call(request);
    if (request.op === 'subscribe' && lose) { lose = false; throw new Error('lost acknowledgement'); }
    return reply;
  });
  await client.consent('jobs.summary', true); const stop = client.watch('jobs', reply => seen.push(reply), clock);
  await settle(); assert.deepEqual(seen.at(-1), contextFailure('HostUnavailable'));
  await clock.tick();
  try {
    assert.equal(f.broker.subscriptionCount(), 1);
    assert.equal(seen.at(-1).value.resync, true);
    assert.ok(seen.at(-1).value.snapshot);
    stop(); await settle(); assert.equal(f.broker.subscriptionCount(), 0); assert.equal(clock.active(), false);
  } finally { client.dispose(); }
});
test('extensions inventory: close while subscribe resolves late suppresses updates and releases the native listener', async () => {
  const f = fixture(), clock = scheduler(), seen = []; let release;
  const gate = new Promise(resolve => { release = resolve; });
  const client = createContextClient('sample.project-context/header', '1.0.0', context('A'), async request => { const reply = f.call(request); if (request.op === 'subscribe') await gate; return reply; });
  await client.consent('jobs.summary', true); client.watch('jobs', reply => seen.push(reply), clock); await settle(); assert.equal(f.broker.subscriptionCount(), 1);
  client.dispose(); release(); await settle(); assert.equal(f.broker.subscriptionCount(), 0); assert.deepEqual(seen, []); assert.equal(clock.active(), false);
});
test('extensions inventory: revoke waits for an outstanding poll then unsubscribes before native consent', async () => {
  const f = fixture(), clock = scheduler(), calls = []; let release, busy = false, holding = false;
  const gate = new Promise(resolve => { release = resolve; });
  const client = createContextClient('sample.project-context/header', '1.0.0', context('A'), async request => {
    calls.push(request.op); if (busy) return contextFailure('Timeout');
    if (holding && request.op === 'events') { busy = true; await gate; busy = false; }
    return f.call(request);
  });
  await client.consent('jobs.summary', true); client.watch('jobs', () => {}, clock); await settle();
  holding = true; const poll = clock.tick(); await settle(); const revoked = client.consent('jobs.summary', false); await settle();
  assert.equal(calls.at(-1), 'events'); release(); await poll; assert.equal((await revoked).ok, true);
  assert.deepEqual(calls.slice(-3), ['events', 'unsubscribe', 'consent']); assert.equal(f.broker.subscriptionCount(), 0); assert.equal(clock.active(), false); client.dispose();
});
test('extensions inventory: both runners discover the real UI suite and native inventory never invokes discovery', () => {
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-inventory\.spec\.ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /extensions inventory/);
  const native = readFileSync(new URL('../src-tauri/src/extensions/inventory.rs', import.meta.url), 'utf8');
  assert.doesNotMatch(native, /providers::discover|run_provider|Command::|\.spawn\(|secret_store|std::env|process_registry/);
  const providers = readFileSync(new URL('../src-tauri/src/providers.rs', import.meta.url), 'utf8');
  const cachedRead = providers.slice(providers.indexOf('pub(crate) fn inventory()'), providers.indexOf('fn inventory_observation'));
  assert.match(cachedRead, /INVENTORY\.try_lock/); assert.doesNotMatch(cachedRead, /discover\(|executable\(|version\(|Command::|\.spawn\(/);
});
