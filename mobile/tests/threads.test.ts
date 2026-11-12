/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import { demoCall, type DemoHost } from '../src/demo-host.ts';
import { archivedIds, cleanTitle, dropTasks, EXPORT_CHANGING, EXPORT_EXPIRED, exportMarkdown, exportVersion, patchTask, readPages, withoutArchived, type ExportPage, type ThreadGoal } from '../src/store/thread-model.ts';
import type { ConnectState } from '../src/store/index.ts';

const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'p', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, ...extra,
});

const tasks = (...list: TaskSummary[]): ConnectState['tasks'] => ({ mac: { tasks: list, projects: [], loadedAt: 0 } });

function host() {
  let state = {
    configured: false, ready: true, signedIn: true, connected: true, account: null, deviceId: 'phone', error: null, demo: true, older: {}, teams: {},
    devices: [{ id: 'mac', name: 'Mac', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 }],
    tasks: tasks(task('a', { title: 'Fix login' }), task('w', { status: 'running' })),
    messages: { 'mac/a': [
      { id: 1, role: 'user', content: 'hi', createdAt: 0, turnDurationMs: null },
      { id: 2, role: 'assistant', content: 'hello', createdAt: 1, turnDurationMs: null },
      { id: 3, role: 'user', content: 'again', createdAt: 2, turnDurationMs: null },
    ] },
    history: {}, sent: {}, live: {}, providers: {}, models: {}, pulls: {}, outdated: {}, bots: {},
  } as ConnectState;
  const h: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => 5000 };
  return { h, state: () => state };
}

test('titles are trimmed to one line of 1–200 characters', () => {
  assert.equal(cleanTitle('  Fix\n login  '), 'Fix login');
  assert.equal(cleanTitle('   '), null);
  assert.equal(cleanTitle('🐼'.repeat(200))?.length, 400, 'counts characters, not UTF-16 units');
  assert.equal(cleanTitle('x'.repeat(201)), null);
});

test('task list edits are immutable and keep identity when nothing changes', () => {
  const before = tasks(task('a'), task('b'));
  const renamed = patchTask(before, 'mac', 'a', { title: 'New' });
  assert.equal(renamed.mac.tasks[0].title, 'New');
  assert.equal(before.mac.tasks[0].title, 'a');
  assert.equal(patchTask(before, 'mac', 'zz', { title: 'x' }), before);
  assert.equal(patchTask(before, 'pc', 'a', { title: 'x' }), before);
  assert.deepEqual(dropTasks(before, 'mac', ['b']).mac.tasks.map(t => t.sessionId), ['a']);
  assert.equal(dropTasks(before, 'mac', ['zz']), before);
});

test('archived threads stay hidden until a newer prompt', () => {
  const list = tasks(task('a', { lastPromptAt: 100 }), task('b', { lastPromptAt: 300 }), task('c'));
  const archived = { 'mac/a': 200, 'mac/b': 200, 'pc/c': 1 };
  assert.deepEqual(archivedIds(list, 'mac', archived), ['a']);
  assert.deepEqual(withoutArchived(list, archived).mac.tasks.map(t => t.sessionId), ['b', 'c']);
  assert.equal(withoutArchived(list, {}), list);
});

test('export pages join in order and stop at the cap', async () => {
  const pages = ['one ', 'two ', 'three'];
  const read = (offset: number) => Promise.resolve({ text: pages[offset], next: offset + 1 < pages.length ? offset + 1 : null });
  assert.deepEqual(await readPages(read), { text: 'one two three', truncated: false });
  const capped = await readPages(read, 4);
  assert.equal(capped.truncated, true);
  assert.ok(capped.text.startsWith('one ') && capped.text.endsWith('[Truncated]'));
  // A host that never advances can't loop forever.
  assert.equal((await readPages(() => Promise.resolve({ text: 'x', next: 0 }))).truncated, true);
  assert.equal(exportMarkdown('T', [{ id: 1, role: 'user', content: 'hi', createdAt: 0, turnDurationMs: null }, { id: 2, role: 'tool', content: '{}', createdAt: 0, turnDurationMs: null }]), '# T\n\n## user\n\nhi\n\n');
});

test('demo rename, pin and delete act on the list as the host would', async () => {
  const { h, state } = host();
  assert.deepEqual(await demoCall(h, 'mac', 'thread.rename', { sessionId: 'a', title: ' Better name ' }), { sessionId: 'a', title: 'Better name' });
  assert.equal(state().tasks.mac.tasks[0].title, 'Better name');
  await assert.rejects(demoCall(h, 'mac', 'thread.rename', { sessionId: 'a', title: '  ' }), /1–200/);
  await demoCall(h, 'mac', 'thread.pin', { sessionId: 'a', pinned: true });
  assert.equal(state().tasks.mac.tasks[0].pinned, true);
  await assert.rejects(demoCall(h, 'mac', 'thread.delete', { sessionId: 'w' }), /Stop this task/);
  assert.deepEqual(await demoCall(h, 'mac', 'thread.delete', { sessionId: 'a' }), { deletedSessionIds: ['a'] });
  assert.deepEqual(state().tasks.mac.tasks.map(t => t.sessionId), ['w']);
  await assert.rejects(demoCall(h, 'mac', 'thread.pin', { sessionId: 'a', pinned: false }), /not found/);
});

test('demo fork copies the conversation up to (or before) a message', async () => {
  const { h, state } = host();
  const through = await demoCall(h, 'mac', 'thread.fork', { sessionId: 'a', messageId: 2 }) as { sessionId: string };
  assert.deepEqual(state().messages[`mac/${through.sessionId}`].map(m => m.id), [1, 2]);
  assert.equal(state().tasks.mac.tasks[0].sessionId, through.sessionId);
  const { h: h2, state: state2 } = host();
  const before = await demoCall(h2, 'mac', 'thread.fork', { sessionId: 'a', messageId: 3, before: true }) as { sessionId: string };
  assert.deepEqual(state2().messages[`mac/${before.sessionId}`].map(m => m.id), [1, 2]);
});

test('demo goal, stage and archive', async () => {
  const { h } = host();
  const goal = await demoCall(h, 'mac', 'thread.goal', { sessionId: 'a' }) as ThreadGoal;
  assert.equal(goal.stage, 'review');
  const edited = await demoCall(h, 'mac', 'thread.setGoal', { sessionId: 'a', description: ' Ship it ' }) as ThreadGoal;
  assert.equal(edited.description, 'Ship it');
  assert.equal((await demoCall(h, 'mac', 'thread.setStage', { sessionId: 'a', stage: 'pending' }) as ThreadGoal).stage, 'pending');
  await assert.rejects(demoCall(h, 'mac', 'thread.setStage', { sessionId: 'a', stage: 'archived' }), /Unknown/);
  await assert.rejects(demoCall(h, 'mac', 'thread.setGoal', { sessionId: 'w', description: 'x' }), /Stop the agent/);
  assert.deepEqual(await demoCall(h, 'mac', 'thread.archive', { sessionId: 'a', archived: true }), { sessionId: 'a', archived: true, stage: 'completed' });
  assert.equal((await demoCall(h, 'mac', 'thread.goal', { sessionId: 'a' }) as ThreadGoal).stage, 'completed');
  const exported = await demoCall(h, 'mac', 'thread.export', { sessionId: 'a' }) as { text: string; next: null };
  assert.ok(exported.text.startsWith('# Fix login\n\n## user\n\nhi'));
  assert.equal(exported.next, null);
});

test('export pages pass page 0\'s token back and start again when the export changes', async () => {
  // A snapshotting host: later pages carry the token.
  const calls: [number, string | undefined][] = [];
  const pages = ['one ', 'two'];
  const snap = async (offset: number, token?: string): Promise<ExportPage> => {
    calls.push([offset, token]);
    return { text: pages[offset], next: offset === 0 ? 1 : null, ...(offset === 0 && { token: 't1' }), version: 'v1' };
  };
  assert.deepEqual(await readPages(snap), { text: 'one two', truncated: false });
  assert.deepEqual(calls, [[0, undefined], [1, 't1']]);

  // A version change mid-export restarts from 0 and keeps none of the old text.
  let version = 'v1';
  const texts: Record<string, string[]> = { v1: ['old ', 'stale'], v2: ['new ', 'text'] };
  const changing = async (offset: number): Promise<ExportPage> => {
    const reply = { text: texts[version][offset], next: offset === 0 ? 1 : null, version };
    if (offset === 0 && version === 'v1') version = 'v2';
    return reply;
  };
  assert.deepEqual(await readPages(changing), { text: 'new text', truncated: false });

  // An expired token restarts too; a host that never settles gives up with a clear error.
  let expired = 1;
  const expiring = async (offset: number): Promise<ExportPage> => {
    if (offset > 0 && expired-- > 0) throw new Error(EXPORT_EXPIRED);
    return { text: offset === 0 ? 'a ' : 'b', next: offset === 0 ? 1 : null, token: 't' };
  };
  assert.deepEqual(await readPages(expiring), { text: 'a b', truncated: false });
  await assert.rejects(readPages(async offset => { if (offset > 0) throw new Error(EXPORT_EXPIRED); return { text: 'a', next: 1 }; }), { message: EXPORT_CHANGING });
  // Other errors are not retried.
  await assert.rejects(readPages(async () => { throw new Error('Conversation not found.'); }), { message: 'Conversation not found.' });
});

test('the demo export answers a token and a version that follows the text', async () => {
  const { h } = host();
  const reply = await demoCall(h, 'mac', 'thread.export', { sessionId: 'a', offset: 0 }) as ExportPage;
  assert.equal(reply.version, exportVersion(reply.text));
  assert.equal(typeof reply.token, 'string');
  assert.notEqual(exportVersion('a'), exportVersion('b'));
});

test('a fork and a rewind run once per tap, where the host dedupes them', async () => {
  const { readFileSync } = await import('node:fs');
  const read = (path: string) => readFileSync(new URL(path, import.meta.url), 'utf8');
  assert.match(read('../src/connect/api/threads.ts'), /hostCallForkOnce<[^>]+>\(deviceId, 'thread\.fork'/);
  const rewind = read('../src/connect/api/rewind.ts');
  assert.match(rewind, /hostCallForkOnce<[^>]+>\(deviceId, 'rewind\.to'/);
  // Only hosts that list forkSendId get a sendId and a retry; actionSendId alone predates these methods.
  assert.match(rewind, /export const FORK_SEND_ID = 'forkSendId'/);
  assert.match(rewind, /caps\.features\.has\(FORK_SEND_ID\)/);
});
