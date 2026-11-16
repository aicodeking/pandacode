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

test('the demo answers host.hello with its core methods and every feature handler', async () => {
  const { h } = host();
  const { DEMO_HANDLERS } = await import('../src/demo/index.ts');
  const reply = await demoCall(h, 'mac', 'host.hello', {}) as { protocol: number; methods: string[] };
  assert.equal(reply.protocol, 2);
  assert.ok(reply.methods.includes('task.send') && reply.methods.includes('host.hello'));
  for (const name of DEMO_HANDLERS.keys()) assert.ok(reply.methods.includes(name), name);
  await assert.rejects(demoCall(h, 'off', 'host.hello', {}), new RegExp(OFFLINE));
});

test('the demo host.hello carries access, methodAccess and fullAccessSwitch, so demo mode runs the gating code', async () => {
  const { h } = host();
  const { allows, blockedBy, parseHello, SWITCH_METHODS } = await import('../src/connect/api/hello.ts');
  const { demoHello } = await import('../src/demo-host.ts');
  const reply = await demoCall(h, 'mac', 'host.hello', {}) as { access: string; methodAccess: Record<string, string>; fullAccessSwitch: string[]; methods: string[]; features: string[] };
  assert.equal(reply.access, 'full');
  assert.deepEqual(new Set(reply.fullAccessSwitch), new Set(SWITCH_METHODS));
  assert.ok(reply.features.includes('remoteFullAccess'));
  for (const method of reply.methods) assert.ok(['view', 'control', 'full'].includes(reply.methodAccess[method]), method);
  assert.deepEqual([reply.methodAccess['tasks.list'], reply.methodAccess['task.send'], reply.methodAccess['task.start']], ['view', 'control', 'full']);
  const caps = parseHello(reply)!;
  assert.equal(caps.access, 'full');
  for (const method of reply.methods) assert.ok(allows(caps, method), method);
  // The same shape with a narrower grant or the switch off blocks what a real host would.
  const view = parseHello(demoHello('view'))!;
  assert.equal(blockedBy(view, 'task.send'), 'access');
  assert.equal(blockedBy(view, 'tasks.list'), null);
  const switchOff = parseHello(demoHello('full', false))!;
  assert.equal(blockedBy(switchOff, 'terminal.list'), reply.methods.includes('terminal.list') ? 'switch' : 'outdated');
  assert.equal(blockedBy(switchOff, 'task.send'), null);
});

test('feature methods fall through to src/demo handlers; unknown ones answer Unknown method.', async () => {
  const { h, state } = host();
  const { DEMO_GROUPS, DEMO_HANDLERS } = await import('../src/demo/index.ts');
  const { METHODS } = await import('../src/connect/rpc.ts');
  const names = Object.values(DEMO_GROUPS).flatMap(group => Object.keys(group));
  assert.equal(new Set(names).size, names.length, 'a demo method is handled in two groups');
  for (const name of names) assert.ok(!(METHODS as readonly string[]).includes(name), `${name} shadows a core method`);
  await assert.rejects(demoCall(h, 'mac', 'thread.nothing', {}), /^Error: Unknown method\.$/);
  const handlers = DEMO_HANDLERS as Map<string, (ctx: any, params: any) => unknown>;
  handlers.set('thread.testEcho', (ctx, params) => ({ deviceId: ctx.deviceId, title: ctx.state.tasks.mac.tasks[0].title, params }));
  try {
    assert.deepEqual(await demoCall(h, 'mac', 'thread.testEcho', { x: 1 }), { deviceId: 'mac', title: state().tasks.mac.tasks[0].title, params: { x: 1 } });
  } finally {
    handlers.delete('thread.testEcho');
  }
});

test('demo image.put takes chunks and names the image; task.send claims its imageIds once', async () => {
  const { h, state } = host();
  assert.ok((await demoCall(h, 'mac', 'host.hello', {}) as { methods: string[] }).methods.includes('image.put'));
  const data = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]).toString('base64');
  assert.deepEqual(await demoCall(h, 'mac', 'image.put', { uploadId: 'u', index: 0, size: 6, data: data.slice(0, 4) }), {});
  const { imageId } = await demoCall(h, 'mac', 'image.put', { uploadId: 'u', index: 1, size: 6, data: data.slice(4) }) as { imageId: string };
  assert.equal(typeof imageId, 'string');
  await assert.rejects(demoCall(h, 'mac', 'image.put', { uploadId: 'v', index: 0, size: 6, data: '' }), /Invalid image data/);
  assert.deepEqual(await demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Look', imageIds: [imageId] }), { queued: false });
  assert.equal(state().messages['mac/a'].at(-1)?.content, 'Look');
  await assert.rejects(demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Again', imageIds: [imageId] }), /missing on this computer/);
});

test('demo task.send behind a running turn queues the message instead of sending it', async () => {
  const { h, state } = host();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Do it' });
  assert.deepEqual(await demoCall(h, 'mac', 'task.send', { sessionId: 'a', text: 'Then this' }), { queued: true });
  assert.equal(state().messages['mac/a'].at(-1)!.content, 'Do it', 'not in the transcript yet');
  const { entries } = await demoCall(h, 'mac', 'queue.list', { sessionId: 'a' }) as { entries: { id: string; text: string }[] };
  assert.deepEqual(entries.map(e => e.text), ['Then this']);
});

test('demo queue.remove refuses an unknown id and queue.restore puts the entry back in place', async () => {
  const { h, tick } = host();
  const list = async () => ((await demoCall(h, 'mac', 'queue.list', { sessionId: 'flaky' })) as { entries: { id: string; attachments: number }[] }).entries;
  await assert.rejects(demoCall(h, 'mac', 'queue.remove', { sessionId: 'flaky', id: 'nope' }), { message: 'This queued message was already sent or removed.' });
  const ids = (await list()).map(e => e.id);
  assert.deepEqual(ids, ['q1', 'q2']);
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'flaky', id: 'q1' });
  assert.deepEqual((await list()).map(e => e.id), ['q2']);
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'flaky', id: 'q1' });
  assert.deepEqual((await list()).map(e => e.id), ['q1', 'q2'], 'back at its old index');
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'flaky', id: 'q1' });
  assert.deepEqual((await list()).map(e => e.id), ['q1', 'q2'], 'a retry is harmless');
  // The entry with an attachment comes back with it, and only inside the window.
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'flaky', id: 'q2' });
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'flaky', id: 'q2' });
  assert.equal((await list()).find(e => e.id === 'q2')?.attachments, 1);
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'flaky', id: 'q2' });
  for (let waited = 0; waited < 60_000; waited += REPLY_MS) tick();
  await assert.rejects(demoCall(h, 'mac', 'queue.restore', { sessionId: 'flaky', id: 'q2' }), { message: 'This message can no longer be put back.' });
  await assert.rejects(demoCall(h, 'mac', 'queue.restore', { sessionId: 'flaky', id: 'never' }), { message: 'This message can no longer be put back.' });
});

test('demo archive then Undo: unarchive reopens for review and thread.setStage puts the earlier stage back', async () => {
  const { h, state } = host();
  const stage = async () => ((await demoCall(h, 'mac', 'thread.goal', { sessionId: 'a' })) as { stage: string }).stage;
  await demoCall(h, 'mac', 'thread.setStage', { sessionId: 'a', stage: 'in_progress' });
  await demoCall(h, 'mac', 'thread.archive', { sessionId: 'a', archived: true });
  assert.equal(await stage(), 'completed');
  await demoCall(h, 'mac', 'thread.archive', { sessionId: 'a', archived: false });
  assert.equal(await stage(), 'review');
  await demoCall(h, 'mac', 'thread.setStage', { sessionId: 'a', stage: 'in_progress' });
  assert.equal(await stage(), 'in_progress');
  assert.equal(state().tasks.mac.tasks.find(t => t.sessionId === 'a')?.stage, 'in_progress', 'the list carries it too');
});

test('demo queue.remove retried after a lost reply answers with the queue while the entry is held, as the host does', async () => {
  const { h, tick } = host();
  const sessionId = 'retry-remove';
  await demoCall(h, 'mac', 'task.send', { sessionId, text: 'Working' });
  await demoCall(h, 'mac', 'task.send', { sessionId, text: 'First' });
  await demoCall(h, 'mac', 'task.send', { sessionId, text: 'Second' });
  const { entries } = await demoCall(h, 'mac', 'queue.list', { sessionId }) as { entries: { id: string; text: string }[] };
  const [first, second] = entries.map(e => e.id);
  const remove = (id: string) => demoCall(h, 'mac', 'queue.remove', { sessionId, id }) as Promise<{ entries: { id: string }[] }>;
  assert.deepEqual((await remove(first)).entries.map(e => e.id), [second]);
  assert.deepEqual((await remove(first)).entries.map(e => e.id), [second], 'held, not put back: the retry succeeds');
  await assert.rejects(remove('never-queued'), { message: 'This queued message was already sent or removed.' });
  // Put back and removed again: held afresh, so its retry succeeds too.
  await demoCall(h, 'mac', 'queue.restore', { sessionId, id: first });
  await remove(first);
  assert.deepEqual((await remove(first)).entries.map(e => e.id), [second]);
  // Past the hold window it is gone for good, as on the host.
  for (let waited = 0; waited < 60_000; waited += REPLY_MS) tick();
  await assert.rejects(remove(first), { message: 'This queued message was already sent or removed.' });
});

test('demo queue.restore still allows Undo after a direct send, as the host does', async () => {
  const { h, tick, state } = host();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-direct', text: 'Working' });
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-direct', text: 'Queued for later' });
  const list = async () => ((await demoCall(h, 'mac', 'queue.list', { sessionId: 'undo-direct' })) as { entries: { id: string; text: string }[] }).entries;
  const id = (await list()).find(e => e.text === 'Queued for later')!.id;
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'undo-direct', id });
  // The run ends with an empty queue, then a prompt goes straight to the task: not a queue delivery.
  tick();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-direct', text: 'Something else' });
  assert.equal(state().messages['mac/undo-direct'].at(-1)?.content, 'Something else', 'sent, not queued');
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'undo-direct', id });
  assert.deepEqual((await list()).map(e => e.id), [id], 'put back');
});

test('demo queue.restore refuses once the queue delivered since the removal', async () => {
  const { h, tick, state } = host();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-delivered', text: 'Working' });
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-delivered', text: 'First' });
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-delivered', text: 'Second' });
  const list = async () => ((await demoCall(h, 'mac', 'queue.list', { sessionId: 'undo-delivered' })) as { entries: { id: string; text: string }[] }).entries;
  const second = (await list()).find(e => e.text === 'Second')!.id;
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'undo-delivered', id: second });
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'undo-delivered', id: second });
  assert.ok((await list()).some(e => e.id === second), 'restored before any delivery');
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'undo-delivered', id: second });
  // The run ends and the queue delivers 'First'.
  tick();
  assert.equal(state().messages['mac/undo-delivered'].at(-1)?.content, 'First', 'the queue delivered');
  assert.equal(state().live['mac/undo-delivered'].status, 'running');
  assert.deepEqual(await list(), []);
  await assert.rejects(demoCall(h, 'mac', 'queue.restore', { sessionId: 'undo-delivered', id: second }), { message: 'This message can no longer be put back.' });
  assert.deepEqual(await list(), [], 'not put back');
});

test('demo queue.restore refuses an entry restored and then delivered', async () => {
  const { h, tick, state } = host();
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-restored', text: 'Working' });
  await demoCall(h, 'mac', 'task.send', { sessionId: 'undo-restored', text: 'Queued' });
  const list = async () => ((await demoCall(h, 'mac', 'queue.list', { sessionId: 'undo-restored' })) as { entries: { id: string }[] }).entries;
  const id = (await list())[0].id;
  await demoCall(h, 'mac', 'queue.remove', { sessionId: 'undo-restored', id });
  await demoCall(h, 'mac', 'queue.restore', { sessionId: 'undo-restored', id });
  tick();
  assert.equal(state().messages['mac/undo-restored'].at(-1)?.content, 'Queued', 'the restored entry was delivered');
  await assert.rejects(demoCall(h, 'mac', 'queue.restore', { sessionId: 'undo-restored', id }), { message: 'This message can no longer be put back.' });
});

test('demo queue.restore answers success only while the entry is in the queue, as the host does', async () => {
  // A restored entry gone again can't come back twice (composer.rs restore_held). Through the handlers
  // that path is guarded twice more (a new remove re-holds it, a delivery bumps the count), so this
  // reads the handler: the only success for a held entry is one still present.
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/demo/composer.ts', import.meta.url), 'utf8');
  const restore = source.match(/'queue\.restore': [^]*?\n  \},/)?.[0];
  assert.ok(restore, 'queue.restore handler not found');
  assert.match(restore, /if \(entries\.some\(e => e\.id === p\.id\)\) return \{ entries \};/);
  assert.match(restore, /if \(held\.restored\) throw new Error\(CANNOT_RESTORE\);/);
  assert.doesNotMatch(restore, /if \(held\.restored\) return/);
});
