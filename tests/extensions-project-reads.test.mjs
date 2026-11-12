import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';
import { createContextClient, contextFailure } from '../src/extensions/context-state.ts';
import { readPath } from '../src/extensions/project-reads-preview.ts';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-reads/extension.json', import.meta.url), 'utf8'));
function fixture() {
  const broker = createPreviewContextBroker(), snapshot = { safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {} }], diagnostics: [] };
  const data = { projects: [{ id: 'A', name: 'Alpha', path: '/synthetic/A' }, { id: 'B', name: 'Beta', path: '/synthetic/B' }], tasks: [], files: { A: { 'README.md': 'A content', 'paged.txt': '€'.repeat(2000), 'binary.bin': '\0binary', 'large.txt': 'x'.repeat(131073) }, B: { 'README.md': 'B content' } }, heads: { A: { branch: 'main', commit: null } } };
  const call = request => broker(request, snapshot, data);
  const client = newClient('A');
  function newClient(projectId) { return createContextClient('sample.project-reads/header', '1.0.0', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId }, async request => call(request)); }
  return { broker, snapshot, data, call, client, newClient };
}
test('extensions project reads: declarations and exact metadata/content/Git consent stay separate', async () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const { client, newClient, snapshot } = fixture();
  await client.consent('projects.summary', true);
  for (const resource of ['metadata', 'file', 'git']) assert.deepEqual(await client.read(resource, resource === 'git' ? '.' : 'README.md'), contextFailure('PermissionDenied'));
  assert.equal((await client.readConsent('projects.files.metadata', 'README.md', true)).ok, true);
  assert.deepEqual((await client.read('metadata', 'README.md')).value.items, [{ path: 'README.md', bytes: 9, kind: 'file' }]);
  assert.deepEqual(await client.read('file', 'README.md'), contextFailure('PermissionDenied'));
  await client.readConsent('projects.files.read', 'README.md', true);
  assert.equal((await client.read('file', 'README.md')).value.content, 'A content');
  assert.deepEqual(await newClient('B').read('file', 'README.md'), contextFailure('PermissionDenied'));
  assert.deepEqual(await client.read('file', 'paged.txt'), contextFailure('PermissionDenied'));
  await client.readConsent('projects.git.read', '.', true);
  assert.deepEqual((await client.read('git', '.')).value.items, [{ kind: 'head', branch: 'main', commit: null }]);
  await client.readConsent('projects.files.read', 'README.md', false);
  assert.deepEqual(await client.read('file', 'README.md'), contextFailure('PermissionDenied'));
  snapshot.packages[0].manifest.permissions = ['ui.contribute', 'projects.summary'];
  assert.deepEqual(await client.readConsent('projects.files.read', 'README.md', true), contextFailure('PermissionDenied'));
  client.dispose();
});
test('extensions project reads: portable paths reject hidden/auth traversal devices alternate separators and ADS', () => {
  for (const path of ['../x', 'a/../x', '/etc/passwd', 'C:/file', 'C:file', 'a\\b', '.env', '.git/config', 'auth.json', 'credentials.json', 'key.pem', 'NUL.txt', 'a:stream', 'x.', 'x ', 'a//b']) assert.ok(readPath(path, false), path);
  assert.equal(readPath('src/readme.md', false), undefined);
});
test('extensions project reads: bounded UTF8 pages and stale, large, binary, removed/path-changed projects', async () => {
  const { client, data } = fixture();
  for (const path of ['paged.txt', 'large.txt', 'binary.bin']) await client.readConsent('projects.files.read', path, true);
  const first = (await client.read('file', 'paged.txt')).value;
  assert.equal(new TextEncoder().encode(first.content).length, 4095); assert.equal(first.nextCursor, 4095);
  const next = await client.read('file', 'paged.txt', { cursor: first.nextCursor, revision: first.revision });
  assert.equal(new TextEncoder().encode(next.value.content).length, 1905); assert.equal(next.value.nextCursor, null);
  data.files.A['paged.txt'] = 'changed';
  assert.deepEqual(await client.read('file', 'paged.txt', { cursor: first.nextCursor, revision: first.revision }), contextFailure('StaleContext'));
  assert.deepEqual(await client.read('file', 'large.txt'), contextFailure('LimitExceeded'));
  assert.deepEqual(await client.read('file', 'binary.bin'), contextFailure('UnsupportedCapability'));
  data.projects[0].path = '/synthetic/replacement'; assert.deepEqual(await client.read('file', 'paged.txt'), contextFailure('StaleContext'));
  data.projects.shift(); assert.deepEqual(await client.read('file', 'paged.txt'), contextFailure('NotFound'));
  client.dispose();
});
test('extensions project reads: cancellation and dispose suppress late replies and serialize release', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const client = createContextClient('sample.project-reads/header', '1.0.0', {}, async request => {
    calls.push(request.op);
    if (request.op === 'capture') return { ok: true, value: { handle: 'opaque' } };
    if (request.op === 'read') { await gate; return { ok: true, value: { content: 'late' } }; }
    return { ok: true, value: null };
  });
  const read = client.read('file', 'README.md'); await new Promise(resolve => setImmediate(resolve));
  client.dispose(); assert.equal(calls.at(-1), 'cancelRead'); assert.equal(calls.includes('release'), false);
  release(); assert.deepEqual(await read, contextFailure('Cancelled')); await new Promise(resolve => setImmediate(resolve));
  assert.equal(calls.at(-1), 'release');
});
test('extensions project reads: revoke cancels a pending native read before changing consent', async () => {
  let release; const gate = new Promise(resolve => { release = resolve; }), calls = [];
  const client = createContextClient('sample.project-reads/header', '1.0.0', {}, async request => {
    calls.push(request.op);
    if (request.op === 'capture') return { ok: true, value: { handle: 'opaque' } };
    if (request.op === 'read') { await gate; return { ok: true, value: { content: 'late' } }; }
    return { ok: true, value: null };
  });
  const read = client.read('file', 'README.md'); await new Promise(resolve => setImmediate(resolve));
  const revoke = client.readConsent('projects.files.read', 'README.md', false);
  await new Promise(resolve => setImmediate(resolve)); assert.equal(calls.at(-1), 'cancelRead'); assert.equal(calls.includes('readConsent'), false);
  release(); assert.deepEqual(await read, contextFailure('Cancelled')); assert.equal((await revoke).ok, true);
  assert.equal(calls.at(-1), 'readConsent'); client.dispose();
});
