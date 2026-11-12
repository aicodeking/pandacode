import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
import { createContextClient, contextFailure } from '../src/extensions/context-state.ts';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-context/extension.json', import.meta.url), 'utf8'));
const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId: 'A', sessionId: 'a1' };
const snapshot = () => ({ safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {} }], diagnostics: [] });
const data = () => ({ projects: [{ id: 'A', name: 'Alpha', path: '/private/SECRET_ROOT' }, { id: 'B', name: 'Beta' }], tasks: [1, 2, 3].map(n => ({ id: `a${n}`, projectId: 'A', status: 'pending', title: 'TRANSCRIPT_SENTINEL', token: 'SECRET_TOKEN' })).concat([{ id: 'b1', projectId: 'B', status: 'idle' }]) });
const deferred = () => { let resolve; const promise = new Promise(done => { resolve = done; }); return { promise, resolve }; };
function fixture() {
  const broker = createPreviewContextBroker(), state = snapshot(), records = data();
  const transport = async request => broker(request, state, records);
  const client = createContextClient('sample.project-context/header', '1.0.0', context, transport);
  return { broker, state, records, transport, client };
}
test('extensions context: fixed declarative action validates without execution or implicit grants', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const activation = createDeclarativeActivation(snapshot(), 1);
  assert.deepEqual(activation.actionFor('sample.project-context/header', context), { kind: 'showProjectContext' });
  activation.dispose(); assert.equal(activation.actionFor('sample.project-context/header', context), undefined);
  for (const extra of ['projectId', 'extensionId', 'script', 'query']) {
    const invalid = structuredClone(manifest); invalid.contributes.commands[0].action[extra] = 'B';
    assert.equal(validateContract('packages', [invalid]).ok, false);
  }
});
test('extensions context: independent grants, immutable captured A, revision and paginated minimal DTOs', async () => {
  const { client, records } = fixture();
  assert.deepEqual(await client.query('projects'), contextFailure('PermissionDenied'));
  assert.equal((await client.consent('projects.summary', true)).ok, true);
  assert.deepEqual((await client.query('projects')).value.items, [{ id: 'A', name: 'Alpha' }]);
  assert.deepEqual(await client.query('tasks'), contextFailure('PermissionDenied'));
  assert.equal((await client.consent('tasks.summary', true)).ok, true);
  const first = await client.query('tasks', { limit: 2 });
  assert.equal(first.value.schemaVersion, 1); assert.equal(first.value.nextCursor, 2);
  assert.deepEqual(first.value.items, [{ id: 'a1', projectId: 'A', status: 'pending' }, { id: 'a2', projectId: 'A', status: 'pending' }]);
  const second = await client.query('tasks', { limit: 2, cursor: 2, revision: first.value.revision });
  assert.deepEqual(second.value.items, [{ id: 'a3', projectId: 'A', status: 'pending' }]); assert.equal(second.value.nextCursor, null);
  for (const marker of ['private', 'SECRET', 'TRANSCRIPT', 'title', 'token']) assert.equal(JSON.stringify([first, second]).includes(marker), false);
  const copy = client.context(); copy.projectId = 'B'; assert.equal(client.context().projectId, 'A');
  records.tasks[0].status = 'completed'; assert.deepEqual(await client.query('tasks', { revision: first.value.revision }), contextFailure('StaleContext'));
  client.dispose();
});
test('extensions context: captured request is not retargeted while transport is delayed', async () => {
  const gate = deferred(), records = data(), state = snapshot(), broker = createPreviewContextBroker();
  const source = structuredClone(context), requests = [];
  const client = createContextClient('sample.project-context/header', '1.0.0', source, async request => { requests.push(structuredClone(request)); if (request.op === 'query') await gate.promise; return broker(request, state, records); });
  await client.consent('projects.summary', true);
  const pending = client.query('projects'); source.projectId = 'B'; source.sessionId = 'b1'; gate.resolve();
  assert.deepEqual((await pending).value.items, [{ id: 'A', name: 'Alpha' }]);
  assert.equal(requests[0].context.projectId, 'A'); assert.equal(requests[2].context, undefined);
  client.dispose();
});
test('extensions context: revoke or dispose suppresses an already in-flight reply', async () => {
  const gate = deferred(), replies = [];
  const client = createContextClient('sample.project-context/header', '1.0.0', context, async request => {
    if (request.op === 'capture') return { ok: true, value: { handle: 'opaque' } };
    if (request.op === 'query') { await gate.promise; return { ok: true, value: { items: ['late private result'] } }; }
    replies.push(request); return { ok: true, value: null };
  });
  await client.consent('projects.summary', true);
  const pending = client.query('projects'); await Promise.resolve();
  await client.consent('projects.summary', false); gate.resolve(); assert.deepEqual(await pending, contextFailure('Cancelled'));
  client.dispose(); client.dispose(); assert.equal(replies.filter(request => request.op === 'release').length, 1);
});
test('extensions context: null/deleted/denied/revoked/disabled and forged project requests are stable', async () => {
  const { client, records, broker, state } = fixture();
  await client.consent('projects.summary', true); records.projects = records.projects.filter(project => project.id !== 'A');
  assert.deepEqual(await client.query('projects'), contextFailure('NotFound'));
  await client.consent('projects.summary', false); assert.deepEqual(await client.query('projects'), contextFailure('PermissionDenied'));
  state.packages[0].enabled = false; assert.deepEqual(await client.query('projects'), contextFailure('PermissionDenied'));
  state.packages[0].enabled = true;
  const capture = broker({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context }, state, records);
  for (const field of ['projectId', 'extensionId', 'windowId', 'command', 'sessionId']) assert.deepEqual(broker({ op: 'query', handle: capture.value.handle, resource: 'projects', limit: 1, [field]: 'B' }, state, records), contextFailure('InvalidShape'));
  assert.deepEqual(broker({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: { ...context, projectId: 'B' } }, state, records), contextFailure('PermissionDenied'));
  const none = createContextClient('sample.project-context/header', '1.0.0', { schemaVersion: 1, windowId: 'main', surfaceId: context.surfaceId, revision: 1 }, async request => broker(request, state, records));
  await none.consent('projects.summary', true); assert.equal((await none.query('projects')).value.state, 'NoProject'); none.dispose(); client.dispose();
});
test('extensions context: oversized request/results, unavailable transport and bounds never echo data', async () => {
  const { client, records, broker, state } = fixture();
  await client.consent('projects.summary', true);
  for (const options of [{ limit: 51 }, { limit: 0 }, { cursor: 10001 }, { revision: 'SECRET'.repeat(20) }]) assert.deepEqual(await client.query('projects', options), contextFailure('LimitExceeded'));
  records.projects[0].name = 'SECRET'.repeat(1000); assert.deepEqual(await client.query('projects'), contextFailure('LimitExceeded'));
  assert.deepEqual(broker({ op: 'capture', id: 'SECRET'.repeat(2000) }, state, records), contextFailure('LimitExceeded'));
  for (const invalid of [null, [], false, 'SECRET']) assert.deepEqual(broker(invalid, state, records), contextFailure('InvalidShape'));
  const unavailable = createContextClient('x', '1.0.0', context, async () => { throw new Error('/private/SECRET_TOKEN'); });
  assert.deepEqual(await unavailable.query('projects'), contextFailure('HostUnavailable')); unavailable.dispose(); client.dispose();
});
test('extensions context: closing before capture releases the late native handle without querying', async () => {
  const gate = deferred(), calls = [];
  const client = createContextClient('x', '1.0.0', context, async request => { calls.push(request); if (request.op === 'capture') await gate.promise; return { ok: true, value: { handle: 'late' } }; });
  const pending = client.query('projects'); client.dispose(); gate.resolve();
  assert.deepEqual(await pending, contextFailure('Cancelled')); assert.deepEqual(calls.map(call => call.op), ['capture', 'release']);
});
test('extensions context: both actual browser runners list the spec and native endpoint is registered', () => {
  for (const path of ['../playwright.config.ts', '../playwright.webkit.config.ts']) assert.match(readFileSync(new URL(path, import.meta.url), 'utf8'), /extensions-context\.spec\.ts/);
  assert.match(readFileSync(new URL('../playwright.webkit.config.ts', import.meta.url), 'utf8'), /extensions context/);
  const native = readFileSync(new URL('../src-tauri/src/lib.rs', import.meta.url), 'utf8');
  assert.match(native, /extensions::context::ContextBroker::default\(\)/); assert.match(native, /extensions::context::extensions_context/);
});
