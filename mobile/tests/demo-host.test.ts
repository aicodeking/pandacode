/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { OFFLINE } from '../src/connect/rpc.ts';
import type { TaskSummary } from '../src/connect/types.ts';
import { DEMO_PULL_TASK, DEMO_REPLY, demoCall, REPLY_MS, type DemoHost } from '../src/demo-host.ts';
import type { Changes, PullDetail } from '../src/connect/types.ts';
import { diffLines } from '../src/store/diff.ts';
import type { ConnectState } from '../src/store/index.ts';
import { idleLive } from '../src/store/reduce.ts';

const task = (sessionId: string, extra: Partial<TaskSummary> = {}): TaskSummary => ({
  sessionId, title: sessionId, status: 'idle', projectId: 'p', projectName: 'p', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, ...extra,
});

/** A demo host over plain state; timers run only when `tick()` is called, and no fetch exists. */
function host() {
  let state = {
    configured: false, ready: true, signedIn: true, connected: true, account: null, deviceId: 'phone', error: null, demo: true, older: {}, teams: {},
    devices: [
      { id: 'mac', name: 'Mac', platform: 'macos', publicKey: 'k', host: true, online: true, lastSeen: 0 },
      { id: 'off', name: 'Off', platform: 'macos', publicKey: 'k', host: true, online: false, lastSeen: 0 },
    ],
    tasks: { mac: { tasks: [task('a'), task('w', { status: 'waiting' })], projects: [{ id: 'p', name: 'Project', repo: null }], loadedAt: 0 } },
    messages: { 'mac/a': [{ id: 7, role: 'user', content: 'hi', createdAt: 0, turnDurationMs: null }] },
    history: {}, sent: {}, live: {}, providers: {}, models: {}, pulls: {}, outdated: {},
    bots: { mac: [{ id: 'b', name: 'Leo', avatar: null, state: 'ready', paused: false, desktopSession: 'bs', projectId: 'bp' }, { id: 'n', name: 'New', avatar: null, state: 'ready', paused: false, desktopSession: null, projectId: 'np' }] },
  } as ConnectState;
  let timers: { run: () => void; ms: number }[] = [];
  let now = 1000;
  const h: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) }; }, later: (run, ms) => { timers.push({ run, ms }); }, now: () => now };
  const tick = () => { now += REPLY_MS; const due = timers; timers = []; due.forEach(t => t.run()); };
  return { h, tick, state: () => state, timers: () => timers };
}

test('a send echoes the prompt, runs, then gets the canned reply', async () => {
  const { h, tick, state, timers } = host();
  assert.deepEqual(await demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Do it' }), { queued: false });
  assert.deepEqual(state().messages['mac/a'].map(m => [m.id, m.role, m.content]), [[7, 'user', 'hi'], [8, 'user', 'Do it']]);
  assert.equal(state().live['mac/a'].status, 'running');
  assert.equal(state().tasks.mac.tasks[0].status, 'running');
  assert.equal(timers()[0].ms, REPLY_MS);
  tick();
  const last = state().messages['mac/a'].at(-1)!;
  assert.deepEqual([last.id, last.role, last.content], [9, 'assistant', DEMO_REPLY]);
  assert.deepEqual(state().live['mac/a'], idleLive());
  assert.equal(state().tasks.mac.tasks[0].status, 'idle');
});

test('a stop before the reply ends the run and drops the reply', async () => {
  const { h, tick, state } = host();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Do it' });
  await demoCall(h, 'mac', 'task.stop', { sessionId: 'a' });
  tick();
  assert.equal(state().live['mac/a'].status, 'stopped');
  assert.equal(state().tasks.mac.tasks[0].status, 'stopped');
  assert.equal(state().messages['mac/a'].at(-1)!.role, 'user');
});

test('an answered approval gets a reply once the run is going again', async () => {
  const { h, tick, state } = host();
  h.set(s => ({ live: { ...s.live, 'mac/w': { ...idleLive(), status: 'waiting' } } }));
  await demoCall(h, 'mac', 'approval.respond', { sessionId: 'w', requestId: 'r', approve: true });
  // client.ts clears the request (approval_cancelled) before the timer fires.
  h.set(s => ({ live: { ...s.live, 'mac/w': { ...idleLive(), status: 'running' } } }));
  tick();
  assert.equal(state().messages['mac/w'].at(-1)!.content, DEMO_REPLY);
  assert.equal(state().tasks.mac.tasks[1].status, 'idle');
});

test('a new task lands first in the list with its prompt', async () => {
  const { h, state } = host();
  const { sessionId } = await demoCall(h, 'mac', 'task.start', { projectId: 'p', worktree: false, prompt: 'Build it\nmore', provider: 'codex', model: 'm' }) as { sessionId: string };
  const first = state().tasks.mac.tasks[0];
  assert.deepEqual([first.sessionId, first.title, first.projectName, first.provider], [sessionId, 'Build it', 'Project', 'codex']);
  assert.equal(state().messages[`mac/${sessionId}`][0].content, 'Build it\nmore');
});

test('configure, lists and offline computers behave like a host', async () => {
  const { h, state } = host();
  await demoCall(h, 'mac', 'task.configure', { sessionId: 'a', model: 'opus', effort: undefined });
  assert.equal(state().tasks.mac.tasks[0].model, 'opus');
  assert.equal(state().tasks.mac.tasks[0].effort, null);
  assert.equal(((await demoCall(h, 'mac', 'tasks.list', {})) as { tasks: unknown[] }).tasks.length, 2);
  assert.deepEqual(await demoCall(h, 'mac', 'task.messages', { sessionId: 'a', afterId: 0 }), { messages: [], hasMore: false, title: '' });
  await assert.rejects(demoCall(h, 'off', 'task.send', { sessionId: 'x', text: 'y' }), { message: OFFLINE });
  await assert.rejects(demoCall(h, 'mac', 'projects.icons', { projectIds: [] }), { message: 'Unknown method.' });
});

test('demo mode starts from the build flag or the saved switch only', async () => {
  const { demoAtStart } = await import('../src/demo.ts');
  assert.equal(demoAtStart(true, null), true);
  assert.equal(demoAtStart(false, '1'), true);
  assert.equal(demoAtStart(false, null), false); // left the demo, or never entered it
  assert.equal(demoAtStart(false, '0'), false);
});

test('the demo pull request: detail, per-file patch, merge', async () => {
  const { h, state } = host();
  const { pull } = await demoCall(h, 'mac', 'task.pull', { sessionId: DEMO_PULL_TASK }) as { pull: PullDetail };
  assert.equal(pull.state, 'open');
  assert.equal(pull.files.length, pull.changedFiles);
  assert.deepEqual(await demoCall(h, 'mac', 'task.pull', { sessionId: 'a' }), { pull: null });
  assert.deepEqual(await demoCall(h, 'mac', 'task.pullDetect', { sessionId: 'a' }), { pull: null });
  const { patch } = await demoCall(h, 'mac', 'task.pullDiff', { sessionId: DEMO_PULL_TASK, path: pull.files[1].path }) as { patch: string };
  const lines = diffLines(patch);
  assert.equal(lines.filter(l => l.kind === 'add').length, pull.files[1].additions);
  assert.equal(lines.filter(l => l.kind === 'del').length, pull.files[1].deletions);
  await demoCall(h, 'mac', 'task.pullMerge', { sessionId: DEMO_PULL_TASK, method: 'squash' });
  assert.equal(state().pulls[`mac/${DEMO_PULL_TASK}`]!.state, 'merged');
  assert.equal(((await demoCall(h, 'mac', 'task.pull', { sessionId: DEMO_PULL_TASK })) as { pull: PullDetail }).pull.state, 'merged');
});

test('the demo checkout: changes and diffs with file headers', async () => {
  const { h } = host();
  const changes = await demoCall(h, 'mac', 'task.changes', { sessionId: 'a' }) as Changes;
  assert.ok(changes.files.length > 0 && changes.branch);
  const { diff } = await demoCall(h, 'mac', 'task.diff', { sessionId: 'a', path: changes.files[0].path }) as { diff: string };
  assert.match(diff, new RegExp(`^diff --git a/${changes.files[0].path} `));
  assert.ok(!diff.includes(changes.files[1].path));
});

test('demo bots: list, thread, message through the bot, pause', async () => {
  const { h, tick, state } = host();
  assert.equal(((await demoCall(h, 'mac', 'bots.list', {})) as { bots: unknown[] }).bots.length, 2);
  assert.deepEqual(await demoCall(h, 'mac', 'bot.thread', { botId: 'b' }), { sessionId: 'bs' });
  assert.deepEqual(await demoCall(h, 'mac', 'bot.thread', { botId: 'n' }), { sessionId: 'bot-n' });
  assert.deepEqual(await demoCall(h, 'mac', 'bot.message', { botId: 'b', text: 'Brief me' }), { sessionId: 'bs' });
  assert.equal(state().messages['mac/bs'].at(-1)!.content, 'Brief me');
  tick();
  assert.equal(state().messages['mac/bs'].at(-1)!.content, DEMO_REPLY);
  await demoCall(h, 'mac', 'bot.pause', { botId: 'b', paused: true });
  assert.deepEqual([state().bots.mac[0].paused, state().bots.mac[0].state], [true, 'paused']);
  await assert.rejects(demoCall(h, 'mac', 'bot.thread', { botId: 'gone' }), /no longer exists/);
});
