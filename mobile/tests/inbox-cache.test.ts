/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Device, TaskSummary } from '../src/connect/types.ts';
import { decodeInbox, encodeInbox, INBOX_VERSION, MAX_TASKS, seenOnly } from '../src/store/inbox-cache.ts';

const task = (sessionId: string, status: TaskSummary['status'] = 'idle'): TaskSummary => ({
  sessionId, title: sessionId, status, projectId: 'p', projectName: 'Project', provider: 'claude', model: 'm',
  effort: null, mode: 'ask', pinned: false, updatedAt: 1, lastPromptAt: null,
});
const device: Device = { id: 'mac', name: 'Mac', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 5 };
const bot = { id: 'b1', name: 'Bot', avatar: null, state: 'ready', paused: false, desktopSession: null, projectId: 'p' };

const lists = () => ({
  mac: { tasks: [{ ...task('run', 'running'), pending: [{ kind: 'approval', requestId: 'r', text: 'secret-ish' }], subagents: [{}] }, task('done')], projects: [{ id: 'p', name: 'Project', repo: null }], loadedAt: 1000 },
});

test('round trip: devices, lists, projects and bots for the same account', () => {
  const restored = decodeInbox(encodeInbox('acct', [device], lists(), { mac: [bot] }), 'acct');
  assert.ok(restored);
  assert.deepEqual(restored.devices, [device]);
  assert.deepEqual(restored.tasks.mac.projects, [{ id: 'p', name: 'Project', repo: null }]);
  assert.deepEqual(restored.tasks.mac.tasks.map(t => t.sessionId), ['run', 'done']);
  assert.deepEqual(restored.bots.mac.map(b => b.id), ['b1']);
});

test('restored lists are stale and every row is stamped with when it was last seen', () => {
  const restored = decodeInbox(encodeInbox('acct', [device], lists(), {}), 'acct')!;
  const list = restored.tasks.mac;
  assert.equal(list.loadedAt, 0, 'the first presence lists it again');
  assert.equal(list.cachedAt, 1000);
  assert.ok(list.tasks.every(t => t.seenAt === 1000 && seenOnly(t)));
  // A running row keeps its status but is marked, so it's never drawn as live.
  assert.equal(list.tasks[0].status, 'running');
  assert.equal(list.tasks[0].pending, undefined, 'pending requests stay live-only');
  assert.equal(list.tasks[0].subagents, undefined);
});

test('saving a still-cached list keeps the time it was last seen, not the restore time', () => {
  const first = decodeInbox(encodeInbox('acct', [device], lists(), {}), 'acct')!;
  const again = decodeInbox(encodeInbox('acct', first.devices, first.tasks, {}), 'acct')!;
  assert.equal(again.tasks.mac.cachedAt, 1000);
  assert.equal(again.tasks.mac.tasks[0].seenAt, 1000);
  assert.ok(!JSON.parse(encodeInbox('acct', first.devices, first.tasks, {})).lists.mac.tasks[0].seenAt, 'rows are saved without the stamp');
});

test('another version, another account, nothing or garbage: no cache', () => {
  const text = encodeInbox('acct', [device], lists(), {});
  assert.equal(decodeInbox(text, 'other'), null);
  assert.equal(decodeInbox(text, ''), null);
  assert.equal(decodeInbox(JSON.stringify({ ...JSON.parse(text), version: INBOX_VERSION + 1 }), 'acct'), null);
  assert.equal(decodeInbox(null, 'acct'), null, 'cleared on sign-out: no file');
  assert.equal(decodeInbox('{not json', 'acct'), null);
});

test('invalid rows and devices are dropped; long lists are capped', () => {
  const many = { mac: { tasks: Array.from({ length: MAX_TASKS + 5 }, (_, i) => task(`t${i}`)), projects: [], loadedAt: 1 } };
  const parsed = JSON.parse(encodeInbox('acct', [device], many, {}));
  parsed.lists.mac.tasks.push({ sessionId: 7 });
  parsed.devices.push({ id: 1 });
  const restored = decodeInbox(JSON.stringify(parsed), 'acct')!;
  assert.equal(restored.tasks.mac.tasks.length, MAX_TASKS);
  assert.equal(restored.devices.length, 1);
});
