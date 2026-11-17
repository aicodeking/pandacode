import { test, expect } from '@playwright/test';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { validateContract } from '../src/extensions/contracts';

// R1210: the Attention inbox (sample.inbox). PREVIEW/Node column: the shipped main.cjs runs against a stand-in of the service SDK
// whose fake host keeps the open set of requests with one winner (as R0507 and R0508 specify), so the spec proves what the
// package does with pending events, late answers, refusals, gaps, tools and navigation. It never proves the installed package or a
// real harness. The installed and both-engine columns are prepared in tests/fixtures/extensions/example-inbox/evidence-columns.json.
// Written for the final test phase; not run when written (binding decision of 2026-11-16).
type Obj = Record<string, any>;
const root = (path: string) => new URL(`../${path}`, import.meta.url);
const read = (path: string) => readFileSync(root(path), 'utf8');
const manifest = JSON.parse(read('examples/extensions/inbox/package/extension.json')) as Obj;
const evidence = JSON.parse(read('tests/fixtures/extensions/example-inbox/evidence-columns.json')) as Obj;
const VIEW = 'sample.inbox/inbox';
const code = (name: string) => Object.assign(new Error(name), { code: name });

async function boot(over: { mode?: 'plan' | 'ask'; settings?: Obj; grantDecide?: boolean } = {}) {
  const directory = mkdtempSync(join(tmpdir(), 'inbox-spec-'));
  const handlers = new Map<string, (payload: Obj) => unknown>();
  const events = new Map<string, (event: Obj) => unknown>();
  const tools = new Map<string, (input: Obj, call: Obj) => Promise<Obj>>();
  const commands = new Map<string, (context: Obj) => Promise<any>>();
  let viewHandler: (message: Obj) => unknown = () => undefined;
  let opened: (instance: Obj) => unknown = () => undefined;
  const posted: Obj[] = [];
  const updates: Obj[] = [];
  const notices: Obj[] = [];
  const revealed: Obj[] = [];
  const sent: Obj[] = [];
  const answered: Obj[] = [];
  const stops: (() => void)[] = [];
  const host = {
    open: new Map<string, Obj>(),   // requestId -> request (the host's open set: one winner)
    mode: over.mode ?? 'ask',
    decide: over.grantDecide ?? true,
    revision: 1,
    stale: new Set<string>(),
  };
  const panda = {
    hooks: {
      on: (event: string, handler: (payload: Obj) => unknown) => { handlers.set(event, handler); return { ready: Promise.resolve(), dispose: () => { handlers.delete(event); } }; },
      pending: async () => ({ schemaVersion: 1, revision: host.revision, truncated: false, approvals: [...host.open.values()].filter(r => r.family === 'approval'), questions: [...host.open.values()].filter(r => r.family === 'question') }),
    },
    tasks: {
      respond: async (taskId: string, requestId: string, answer: Obj) => {
        if (!host.decide) throw code('PermissionDenied');
        const request = host.open.get(requestId);
        if (!request) throw code(host.stale.has(requestId) ? 'StaleContext' : 'NotFound');
        if (request.taskId !== taskId) throw code('StaleContext');
        if (request.family === 'approval' && answer.approved === true && host.mode === 'plan') throw code('UnsupportedCapability');
        host.open.delete(requestId); host.stale.add(requestId);
        answered.push({ taskId, requestId, answer });
        return null;
      },
      message: async (taskId: string, message: Obj) => { sent.push({ taskId, message }); return { id: 'm', delivery: 'queued' }; },
    },
    modelTools: { register: (id: string, handler: (input: Obj, call: Obj) => Promise<Obj>) => { tools.set(id, handler); return { ready: Promise.resolve(), dispose: () => { tools.delete(id); } }; } },
    events: { on: (kind: string, handler: (event: Obj) => unknown) => { events.set(kind, handler); return { dispose: () => { events.delete(kind); } }; } },
    views: {
      post: async (view: string, message: Obj) => { posted.push({ view, ...message }); return { delivered: 1 }; },
      onMessage: (_view: string, handler: (message: Obj) => unknown) => { viewHandler = handler; return { dispose() { viewHandler = () => undefined; } }; },
      on: (_kind: string, handler: (instance: Obj) => unknown) => { opened = handler; return { dispose() {} }; },
    },
    ui: {
      update: async (id: string, patch: Obj) => { updates.push({ id, ...patch }); return null; },
      notify: async (notice: Obj) => { notices.push(notice); return { key: notice.key, replaced: false, merged: false, os: 'delivered' }; },
      reveal: async (target: Obj) => { if (target.taskId === 'gone') throw code('NotFound'); revealed.push(target); return null; },
    },
    storage: { directory: async () => ({ schemaVersion: 1, path: directory }) },
    settings: { get: async () => ({ schemaVersion: 1, revision: 1, values: { retentionDays: '7', notifyDelaySec: '120', brief: true, ...over.settings } }) },
    commands: { register: (id: string, handler: (context: Obj) => Promise<any>) => { commands.set(id, handler); return { dispose() {} }; } },
  };
  const service = createRequire(import.meta.url)(fileURLToPath(root('examples/extensions/inbox/package/main.cjs')));
  await service.service(panda, { onStop: (stop: () => void) => { stops.push(stop); return { dispose() {} }; } });
  const control = (args: Obj) => commands.get('sample.inbox/control')!({ args });
  const open = (request: Obj) => host.open.set(request.requestId, request);
  const approval = (taskId: string, requestId: string, command = 'rm -rf x'): Obj => ({ family: 'approval', requestId, taskId, projectId: 'p1', tool: { kind: 'shell', name: 'Bash' }, input: { command }, at: new Date().toISOString() });
  const question = (taskId: string, requestId: string): Obj => ({ family: 'question', requestId, taskId, projectId: 'p1', questions: [{ id: 'db', question: 'Which database?' }], at: new Date().toISOString() });
  const last = () => posted.filter(message => message.type === 'inbox').at(-1) as Obj;
  const stop = () => { stops.forEach(fn => fn()); rmSync(directory, { recursive: true, force: true }); };
  return { handlers, events, tools, commands, host, posted, updates, notices, revealed, sent, answered, control, open, approval, question, last, stop, dispatch: (message: Obj) => viewHandler(message), opened: (instance: Obj) => opened(instance), directory };
}
type Inbox = Awaited<ReturnType<typeof boot>>;
const waiting = (inbox: Inbox) => (inbox.last()?.waiting as Obj[] | undefined)?.map(row => row.id) ?? [];
// What the host does when a request opens: it records it, then delivers the event.
const raise = async (inbox: Inbox, request: Obj) => { inbox.open(request); await inbox.handlers.get(`${request.family}.pending`)!(request); };
const settle = async (inbox: Inbox, request: Obj, by: unknown = 'user') => { inbox.host.open.delete(request.requestId); inbox.host.stale.add(request.requestId); await inbox.handlers.get(`${request.family}.resolved`)!({ requestId: request.requestId, taskId: request.taskId, by }); };

test('inbox example: the package is valid, holds the declared permissions and declares hooks, tools and a rich view', () => {
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', 'harness.hooks.observe', 'harness.hooks.context', 'harness.hooks.decide', 'tools.model', 'tasks.message', 'ui.richViews', 'ui.dynamic', 'ui.notify', 'events.workspace']));
  expect(manifest.contributes.hooks.map((hook: Obj) => hook.event)).toEqual(['approval.pending', 'approval.resolved', 'question.pending', 'question.resolved', 'turn.fail', 'task.idle', 'prompt.submit']);
  expect(manifest.contributes.modelTools.map((tool: Obj) => tool.name)).toEqual(['inbox_notify', 'inbox_ask', 'inbox_resolve']);
  expect(manifest.contributes.views[0].rich).toMatchObject({ folder: 'panel', entry: 'index.html' });
  const main = read('examples/extensions/inbox/package/main.cjs');
  expect([...main.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)].map(match => match[1])).toEqual(['node:fs', 'node:path']);
  expect(main).toContain('panda.tasks.respond(');
  expect(main).not.toMatch(/respond_approval|respond_user_input|credentials/);
  for (const column of Object.values(evidence.columns) as Obj[]) expect(column.status).toMatch(/^prepared, not run/);
});

test('inbox example: approvals and questions show within the service start, rebuilt from the host, and leave when resolved', async () => {
  const early = await boot();
  early.stop();
  const inbox = await boot();
  const a = inbox.approval('t1', 'r1:7'), q = inbox.question('t2', 'r1:q1');
  await raise(inbox, a); await raise(inbox, q);
  expect(waiting(inbox)).toEqual(['r1:7', 'r1:q1']);
  expect(inbox.updates.at(-1)).toMatchObject({ id: 'sample.inbox/count', badge: '2' });
  expect(inbox.last().waiting[0]).toMatchObject({ kind: 'approval', tool: 'Bash', input: 'rm -rf x', taskId: 't1' });
  await settle(inbox, a, 'user');
  expect(waiting(inbox)).toEqual(['r1:q1']);
  await settle(inbox, q, 'cancelled');
  expect(waiting(inbox)).toEqual([]);
  expect(inbox.updates.at(-1)).toMatchObject({ badge: '' });
  inbox.stop();
});

test('inbox example: two tasks answered after the hook budget reach the right task, attributed, and the rows leave', async () => {
  const inbox = await boot();
  await raise(inbox, inbox.approval('t1', 'r1:7'));
  await raise(inbox, inbox.question('t2', 'r2:q1'));
  // The hook budget (30 s) is long past: nothing in the book expires, the rows are still there.
  await inbox.dispatch({ op: 'deny', id: 'r1:7', reason: 'Not in this project.' });
  await inbox.dispatch({ op: 'answer', id: 'r2:q1', answers: { db: 'Postgres' } });
  expect(inbox.answered).toEqual([
    { taskId: 't1', requestId: 'r1:7', answer: { approved: false, reason: 'Not in this project.' } },
    { taskId: 't2', requestId: 'r2:q1', answer: { answers: { db: 'Postgres' } } },
  ]);
  expect(waiting(inbox)).toEqual([]);
  expect(inbox.posted.filter(message => message.type === 'result').map(message => [message.op, message.ok])).toEqual([['deny', true], ['answer', true]]);
  inbox.stop();
});

test('inbox example: a request the user answered first, a resolved one and a forged id cannot answer another call', async () => {
  const inbox = await boot();
  const a = inbox.approval('t1', 'r1:7'), b = inbox.approval('t1', 'r1:8');
  await raise(inbox, a); await raise(inbox, b);
  // The user answers r1:7 in the thread while the panel's Approve is in flight: the host has no open r1:7 any more.
  inbox.host.open.delete('r1:7'); inbox.host.stale.add('r1:7');
  await inbox.dispatch({ op: 'approve', id: 'r1:7' });
  expect(inbox.answered).toEqual([]);
  const result = inbox.posted.filter(message => message.type === 'result').at(-1)!;
  expect(result).toMatchObject({ op: 'approve', id: 'r1:7', ok: false, code: 'StaleContext' });
  // The stale row left; the other request is untouched and still waits.
  expect(waiting(inbox)).toEqual(['r1:8']);
  expect(inbox.host.open.has('r1:8')).toBe(true);
  // An id the inbox never listed answers nothing at all.
  await inbox.dispatch({ op: 'approve', id: 'r9:9' });
  expect(inbox.answered).toEqual([]);
  // Answering the first one twice is refused the second time.
  await inbox.dispatch({ op: 'deny', id: 'r1:8' });
  await inbox.dispatch({ op: 'deny', id: 'r1:8' });
  expect(inbox.answered).toHaveLength(1);
  inbox.stop();
});

test('inbox example: a mode that holds an approve, or a revoked grant, leaves the host prompt and the row', async () => {
  const plan = await boot({ mode: 'plan' });
  await raise(plan, plan.approval('t1', 'r1:7'));
  await plan.dispatch({ op: 'approve', id: 'r1:7' });
  expect(plan.posted.filter(message => message.type === 'result').at(-1)).toMatchObject({ ok: false, code: 'UnsupportedCapability' });
  expect(plan.answered).toEqual([]);
  expect(plan.host.open.has('r1:7')).toBe(true);
  expect(waiting(plan)).toEqual(['r1:7']);
  // Denying is always possible.
  await plan.dispatch({ op: 'deny', id: 'r1:7' });
  expect(plan.answered).toHaveLength(1);
  plan.stop();
  const revoked = await boot({ grantDecide: false });
  await raise(revoked, revoked.approval('t1', 'r1:8'));
  await revoked.dispatch({ op: 'deny', id: 'r1:8' });
  expect(revoked.posted.filter(message => message.type === 'result').at(-1)).toMatchObject({ ok: false, code: 'PermissionDenied' });
  expect(revoked.host.open.has('r1:8')).toBe(true);
  expect(waiting(revoked)).toEqual(['r1:8']);
  revoked.stop();
});

test('inbox example: after a lost event and an event gap the list matches the host, not the events', async () => {
  const inbox = await boot();
  const a = inbox.approval('t1', 'r1:7'), b = inbox.approval('t1', 'r1:8'), c = inbox.question('t2', 'r2:q1');
  await raise(inbox, a); await raise(inbox, b);
  // r1:8 ended and a question opened while the service listened to nothing: both events were dropped.
  inbox.host.open.delete('r1:8'); inbox.host.stale.add('r1:8');
  inbox.open(c);
  await inbox.events.get('gap')!({ kind: 'gap', dropped: 2 });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(waiting(inbox).sort()).toEqual(['r1:7', 'r2:q1']);
  // A later frame for the resolved request cannot bring its row back: the host's set is the truth.
  await inbox.handlers.get('task.idle')!({ taskId: 't1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(waiting(inbox).sort()).toEqual(['r1:7', 'r2:q1']);
  // Reopening the panel sends the current snapshot to that instance only.
  const before = inbox.posted.length;
  await inbox.opened({ viewId: VIEW, instanceId: 'i1' });
  expect(inbox.posted.length).toBe(before + 1);
  expect(inbox.last().waitingCount).toBe(2);
  // A service restarted from nothing finds the same set.
  inbox.stop();
});

test('inbox example: model tools add messages and asks with the calling task, resolve them, and retention removes old messages', async () => {
  const inbox = await boot({ settings: { retentionDays: '1' } });
  const call = { callId: 'c1', taskId: 't1', projectId: 'p1' };
  expect(await inbox.tools.get('sample.inbox/notify')!({ message: 'Build is green', url: 'https://example.test/run/1' }, call)).toEqual({ content: { ok: true, id: expect.any(String) } });
  expect(inbox.last().messages[0]).toMatchObject({ taskId: 't1', text: 'Build is green', read: false, url: 'https://example.test/run/1' });
  expect(inbox.last().unread).toBe(1);
  const ask = await inbox.tools.get('sample.inbox/ask')!({ message: 'Which branch?' }, call);
  const id = ask.content.id as string;
  expect(waiting(inbox)).toEqual([id]);
  // An ask stays when its task goes idle, until it is handled or resolved.
  await inbox.handlers.get('task.idle')!({ taskId: 't1' });
  await new Promise(resolve => setTimeout(resolve, 20));
  expect(waiting(inbox)).toEqual([id]);
  expect(await inbox.tools.get('sample.inbox/resolve')!({}, { ...call, taskId: 't2' })).toMatchObject({ isError: true });
  expect(await inbox.tools.get('sample.inbox/resolve')!({}, call)).toEqual({ content: { ok: true, id } });
  expect(waiting(inbox)).toEqual([]);
  // "Mark handled" removes an ask the model never resolved.
  const second = await inbox.tools.get('sample.inbox/ask')!({ message: 'Again?' }, call);
  await inbox.dispatch({ op: 'handle', id: second.content.id });
  expect(waiting(inbox)).toEqual([]);
  // Reading a message lowers the unread count and the badge; a reply is queued into that task, labelled by the host.
  const messageId = inbox.last().messages[0].id as string;
  await inbox.dispatch({ op: 'read', id: messageId });
  expect(inbox.last().unread).toBe(0);
  await inbox.dispatch({ op: 'reply', id: messageId, text: 'Thanks, merge it.' });
  expect(inbox.sent).toEqual([{ taskId: 't1', message: { text: 'Thanks, merge it.', delivery: 'queue' } }]);
  inbox.stop();
});

test('inbox example: the brief goes once per task and only while the setting is on', async () => {
  const inbox = await boot();
  const submit = inbox.handlers.get('prompt.submit')!;
  expect(await submit({ taskId: 't1' })).toMatchObject({ context: expect.stringContaining('inbox_notify') });
  expect(await submit({ taskId: 't1' })).toBeUndefined();
  expect(await submit({ taskId: 't2' })).toMatchObject({ context: expect.any(String) });
  inbox.stop();
  const quiet = await boot({ settings: { brief: false } });
  expect(await quiet.handlers.get('prompt.submit')!({ taskId: 't1' })).toBeUndefined();
  quiet.stop();
});

test('inbox example: a failed turn adds a row that leaves on the next turn; Go to task reveals it and a vanished task is a result', async () => {
  const inbox = await boot();
  await inbox.handlers.get('turn.fail')!({ taskId: 't1', projectId: 'p1', error: { message: 'Rate limited' } });
  expect(inbox.last().waiting[0]).toMatchObject({ kind: 'failed', text: 'Rate limited' });
  await inbox.dispatch({ op: 'go', id: 'failed:t1' });
  expect(inbox.revealed).toEqual([{ taskId: 't1' }]);
  await inbox.events.get('turn.started')!({ kind: 'turn.started', taskId: 't1', projectId: 'p1', index: 2 });
  expect(waiting(inbox)).toEqual([]);
  await inbox.handlers.get('turn.fail')!({ taskId: 'gone', projectId: 'p1', error: 'x' });
  await inbox.dispatch({ op: 'go', id: 'failed:gone' });
  expect(inbox.posted.filter(message => message.type === 'result').at(-1)).toMatchObject({ op: 'go', ok: false, code: 'NotFound' });
  // A message the service does not know changes nothing.
  const revision = inbox.last().revision;
  await inbox.dispatch({ op: 'format-disk' });
  expect(inbox.last().revision).toBe(revision);
  inbox.stop();
});

test('inbox example: one notice for a row that waits past the delay while the app is not focused, never before or twice', async () => {
  const inbox = await boot({ settings: { notifyDelaySec: '0' } });
  await raise(inbox, inbox.approval('t1', 'r1:7'));
  await inbox.control({ op: 'tick' });
  expect(inbox.notices).toEqual([]);            // delay 0 turns the notice off
  inbox.stop();
  const slow = await boot({ settings: { notifyDelaySec: '1' } });
  const old = slow.approval('t1', 'r1:7'); old.at = new Date(Date.now() - 5000).toISOString();
  await raise(slow, old);
  await slow.control({ op: 'tick' });
  expect(slow.notices).toEqual([]);             // the app is focused
  await slow.events.get('app.focus')!({ kind: 'app.focus', focused: false });
  await slow.control({ op: 'tick' });
  await slow.control({ op: 'tick' });
  expect(slow.notices).toHaveLength(1);
  expect(slow.notices[0].text).toContain('waiting');
  slow.stop();
});

test('inbox example: disable removes the hooks, tools and subscriptions; nothing is left to answer or approve', async () => {
  const inbox = await boot();
  await raise(inbox, inbox.approval('t1', 'r1:7'));
  inbox.stop();
  expect(inbox.handlers.size).toBe(0);
  expect(inbox.tools.size).toBe(0);
  expect(inbox.events.size).toBe(0);
  expect(inbox.answered).toEqual([]);
  expect(inbox.host.open.has('r1:7')).toBe(true);   // the host's own prompt is still there for the user
});
