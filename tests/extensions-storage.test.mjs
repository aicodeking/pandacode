import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createStoragePreview } from '../src/extensions/storage-preview.ts';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/storage-laboratory/extension.json', 'utf8'));
function fixture() {
  const records = new Map();
  const disk = { getItem: key => records.get(key) ?? null, setItem: (key, value) => records.set(key, value), removeItem: key => records.delete(key) };
  const other = JSON.parse(JSON.stringify(manifest).replaceAll(manifest.id, 'other.storage-laboratory'));
  const snapshot = { safeMode: false, diagnostics: [], packages: [manifest, other].map(manifest => ({ manifest, enabled: true, icons: {} })) };
  const storage = createStoragePreview(disk);
  const binding = (owner = manifest.id, project = 'A') => ({ owner, version: '1.0.0', context: { projectId: project } });
  for (const item of snapshot.packages) storage.grant(snapshot, item.manifest.id, true);
  const call = (owner, project, request) => storage.call(snapshot, binding(owner, project), owner + project, request);
  return { records, disk, snapshot, storage, binding, call };
}
test('storage.private is a shared native/frontend capability and fixture is valid', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const native = readFileSync('src-tauri/src/extensions/contracts.rs', 'utf8');
  // The vocabulary lives once, in runtime_grants.rs; the validator consults it at all three of its checks.
  assert.equal((native.match(/runtime_grants::PERMISSIONS\.contains/g) ?? []).length, 3);
  assert.equal((readFileSync('src-tauri/src/extensions/runtime_grants.rs', 'utf8').match(/"storage\.private"/g) ?? []).length, 1);
});
test('SQLite schema keeps the original\'s schedule step at 37, the provider identity step at 38, and the constant at the newest step', () => {
  const source = readFileSync('src-tauri/src/storage.rs', 'utf8');
  const open = source.slice(source.indexOf('pub fn open('), source.indexOf('mod tests {'));
  const constant = Number(source.match(/pub const SCHEMA_VERSION: i64 = (\d+);/)[1]);
  const steps = [...open.matchAll(/PRAGMA user_version=(\d+)/g)].map(match => Number(match[1]));
  assert.equal(constant, 38);
  assert.equal(Math.max(...steps), constant);
  const step = version => open.slice(open.indexOf(`if version < ${version}`), open.indexOf(`PRAGMA user_version=${version};`));
  assert.match(step(37), /saved_remotely/);
  assert.doesNotMatch(step(37), /extension_provider_identities/);
  assert.match(step(38), /CREATE TABLE IF NOT EXISTS extension_provider_identities/);
  assert.doesNotMatch(step(38), /task_schedules/);
  assert.match(readFileSync('AGENTS.md', 'utf8'), new RegExp(`schema is at \`user_version\` ${constant}\\b`));
});
test('private storage public requests isolate identical keys by authenticated owner and captured project after reload', () => {
  const f = fixture();
  for (const [owner, project, scope, value] of [[manifest.id, 'A', 'global', 1], [manifest.id, 'A', 'project', 2], [manifest.id, 'B', 'project', 3], ['other.storage-laboratory', 'A', 'global', 4]]) {
    f.call(owner, project, { op: 'set', scope, key: 'same', value });
  }
  const restarted = createStoragePreview(f.disk);
  for (const [owner, project, scope, expected] of [[manifest.id, 'B', 'global', 1], [manifest.id, 'A', 'project', 2], [manifest.id, 'B', 'project', 3], ['other.storage-laboratory', 'A', 'global', 4]]) {
    assert.equal(restarted.call(f.snapshot, f.binding(owner, project), owner, { op: 'get', scope, key: 'same' }).value, expected);
  }
  assert.throws(() => f.call(manifest.id, 'A', { op: 'get', scope: 'global', key: 'same', owner: 'other.storage-laboratory' }), /InvalidShape/);
  assert.throws(() => f.call(manifest.id, '', { op: 'snapshot', scope: 'project' }), /NoProject/);
});
test('quota, malformed request, migration and failed writes preserve last committed preview record', () => {
  const f = fixture();
  f.call(manifest.id, 'A', { op: 'set', scope: 'global', key: 'same', value: 'previous' });
  const before = [...f.records];
  for (const request of [{ op: 'set', scope: 'global', key: 'same', value: 'x'.repeat(16385) }, { op: 'set', scope: 'global', key: 'same', value: 1, projectId: 'B' }, { op: 'migrate', scope: 'global', revision: 0, fromVersion: 1, toVersion: 2, rollbackCompatible: true, values: {} }]) {
    assert.throws(() => f.call(manifest.id, 'A', request)); assert.deepEqual([...f.records], before);
  }
  const failed = createStoragePreview({ ...f.disk, setItem() { throw new Error('Disk full'); } });
  assert.throws(() => failed.call(f.snapshot, f.binding(), 'handle', { op: 'set', scope: 'global', key: 'same', value: 'lost' }), /Disk full/);
  assert.deepEqual([...f.records], before);
});
test('streams are owner, project and activation scoped and end immediately on grant revocation', () => {
  const f = fixture(), a = manifest.id;
  const stream = f.call(a, 'A', { op: 'subscribe', scope: 'project' });
  f.call(a, 'B', { op: 'set', scope: 'project', key: 'B-only', value: 1 });
  f.call(a, 'A', { op: 'set', scope: 'project', key: 'A-only', value: 1 });
  const events = { op: 'events', scope: 'project', subscription: stream.subscription, cursor: stream.cursor };
  assert.throws(() => f.call(a, 'B', events), /StaleContext/);
  assert.deepEqual(f.call(a, 'A', events).events, [{ sequence: 1, keys: ['A-only'] }]);
  f.storage.grant(f.snapshot, a, false);
  assert.throws(() => f.call(a, 'A', { op: 'get', scope: 'project', key: 'A-only' }), /PermissionDenied/);
  f.storage.grant(f.snapshot, a, true);
  assert.throws(() => f.call(a, 'A', events), /StaleContext/);
  assert.equal(f.call(a, 'A', { op: 'get', scope: 'project', key: 'A-only' }).value, 1);
});
