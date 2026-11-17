import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { CONTEXT_PERMISSION, MAX_ATTACHMENTS, MAX_LEDGER, MAX_NOTES_PER_TASK, NOTE_BYTES, PERMISSION, TEXT_BYTES, TaskMessages, TaskMessenger, admitMessage, admitNote, admitQueue, carriesContext, plan, queueCode, renderContext, revision, steerFailure, type MessengerWorld, type PreviewTask, type QueueRow } from '../src/extensions/runtime-tasks-messages';

// Preview column of R0402 (messages, notes and the revisioned queue). The first group runs the deterministic model in
// src/extensions/runtime-tasks-messages.ts, which mirrors src-tauri/src/extensions/runtime_tasks_messages.rs (whose own unit
// tests are `runtime_tasks_messages::tests`); the last group drives the main window's half in the preview app. The installed
// service reaching the scripted ACP agent (B5) is the native test `runtime_service_lifetime::tests::installed::tasks_message_*`
// (feature extension-runtime-native-tests), reported in its own column: this file claims only the preview and model column.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-messages/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-tasks-messages/main.cjs');
const OWNER = 'sample.runtime-tasks-messages';
const NAME = 'Task messenger';

type Grants = readonly (readonly [string, string])[];
const GRANTS: Grants = [[PERMISSION, 'A'], [PERMISSION, 'B'], [CONTEXT_PERMISSION, 'A']];
const checks = (grants: Grants = GRANTS) => ({ granted: (permission: string, project: string) => grants.some(([held, where]) => held === permission && where === project), package: NAME });
const tasks = (over: Partial<PreviewTask> = {}): PreviewTask[] => [{ id: 't1', projectId: 'A', running: false, ...over }, { id: 't2', projectId: 'A', running: true }, { id: 't3', projectId: 'B', running: false }];
function messenger(over: Partial<MessengerWorld> = {}, list: PreviewTask[] = tasks()) { return new TaskMessenger({ tasks: list, ...over }); }
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;
const world = (grants: Grants = GRANTS) => { const held = checks(grants); return { projectOf: (task: string) => ({ t1: 'A', t2: 'A', t3: 'B' } as Record<string, string>)[task], granted: held.granted, holdsAny: (permission: string) => ['A', 'B'].some(project => held.granted(permission, project)) }; };
const message = (taskId: string, body: Record<string, unknown>) => ({ taskId, message: body });
const entryOf = (reply: unknown) => (reply as { ok: true; value: { id: string } }).value.id;

test('extensions runtime tasks messages: the fixture package declares the permissions and a service and uses the calls', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION, CONTEXT_PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.tasks.message', 'panda.tasks.note', 'panda.tasks.queue.list', 'panda.tasks.queue.update', 'panda.tasks.queue.reorder', 'panda.tasks.queue.sendNow', 'panda.tasks.queue.resume', 'follow-up']) expect(fixtureSource, call).toContain(call);
  // The package holds tasks.message only: it never stops, starts or reconfigures a task and names no credential.
  expect(fixtureSource).not.toMatch(/tasks\.(start|stop|setMode|configure)|credentials/);
});

test('extensions runtime tasks messages: an idle task takes the message as a turn, once, with its label; a busy one queues it', () => {
  const host = messenger();
  const idle = host.message(OWNER, checks(), message('t1', { text: 'also run the linter' }));
  expect(idle).toMatchObject({ ok: true, value: { delivery: 'sent' } });
  expect(host.sent).toEqual([{ taskId: 't1', text: 'also run the linter', attachments: [], notes: [] }]);
  expect(host.transcript).toEqual([{ taskId: 't1', text: `Sent by ${NAME}` }]);
  // t1 now runs: the next message is queued behind the turn, and reaches the harness exactly once when the run ends.
  const queued = host.message(OWNER, checks(), message('t1', { text: 'then the formatter', attachments: ['img-1'] }));
  expect(queued).toMatchObject({ ok: true, value: { delivery: 'queued' } });
  expect(host.sent).toHaveLength(1);
  expect(host.queueOf('t1').map(row => row.text)).toEqual(['then the formatter']);
  host.endRun('t1');
  host.endRun('t1');
  expect(host.sent.map(entry => [entry.taskId, entry.text, entry.attachments])).toEqual([['t1', 'also run the linter', []], ['t1', 'then the formatter', ['img-1']]]);
  expect(host.queueOf('t1')).toEqual([]);
  // An explicit queue on an idle task still goes through the queue, and the drain sends it once.
  host.endRun('t1');
  expect(host.message(OWNER, checks(), message('t3', { text: 'later', delivery: 'queue' }))).toMatchObject({ ok: true, value: { delivery: 'queued' } });
  expect(host.sent.filter(entry => entry.taskId === 't3')).toHaveLength(1);
});

test('extensions runtime tasks messages: a supported steer reaches the running turn; an unsupported one is explicit and queues nothing', () => {
  const host = messenger({}, [{ id: 'live', projectId: 'A', running: true }, { id: 'plain', projectId: 'A', running: true, steerable: false }, { id: 'lead', projectId: 'A', running: true, team: true }, { id: 'rest', projectId: 'A', running: false }]);
  expect(host.message(OWNER, checks(), message('live', { text: 'use the new API', delivery: 'steer' }))).toMatchObject({ ok: true, value: { delivery: 'steered' } });
  expect(host.steered).toEqual([{ taskId: 'live', text: 'use the new API' }]);
  for (const task of ['plain', 'lead']) {
    const reply = host.message(OWNER, checks(), message(task, { text: 'now', delivery: 'steer' }));
    expect(reply).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'delivery' } });
    expect(host.queueOf(task)).toEqual([]);
  }
  expect(host.message(OWNER, checks(), message('live', { text: 'with a picture', attachments: ['i'], delivery: 'steer' }))).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'attachments' } });
  // Nothing to steer on an idle task: it is a plain send, once.
  expect(host.message(OWNER, checks(), message('rest', { text: 'go', delivery: 'steer' }))).toMatchObject({ ok: true, value: { delivery: 'sent' } });
  expect(host.sent).toHaveLength(1);
  expect(host.steered).toHaveLength(1);
});

test('extensions runtime tasks messages: no grant, a narrowed project or a revoke before the send is PermissionDenied and delivers nothing', () => {
  const host = messenger();
  for (const grants of [[], [[PERMISSION, 'B']]] as Grants[]) {
    const reply = host.message(OWNER, checks(grants), message('t1', { text: 'go' }));
    expect(reply).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: 'tasks.message' } });
  }
  // The grant answers first: an unknown task or a bad shape never leaks through a refusal.
  expect(code(host.message(OWNER, checks([]), message('ghost', { text: 'go' })))).toBe('PermissionDenied');
  expect(code(host.message(OWNER, checks(), message('ghost', { text: 'go' })))).toBe('NotFound');
  let live: Grants = GRANTS;
  const revoked = host.message(OWNER, { granted: (permission, project) => live.some(([held, where]) => held === permission && where === project), package: NAME }, message('t1', { text: 'go' }), () => { live = []; });
  expect(code(revoked)).toBe('PermissionDenied');
  expect([host.sent.length, host.queueOf('t1').length, host.queueOf('t2').length]).toEqual([0, 0, 0]);
});

test('extensions runtime tasks messages: shapes and bounds are refused with their reason, in the frozen order', () => {
  const admit = (raw: unknown) => { const result = admitMessage(world(), raw); return 'code' in result ? result.code : 'ok'; };
  for (const [raw, expected] of [
    ['text', 'InvalidShape'], [{ message: { text: 'x' } }, 'InvalidShape'], [{ taskId: 't1' }, 'InvalidShape'], [message('t1', { text: '  ' }), 'InvalidShape'], [message('t1', { text: 'x', delivery: 'teleport' }), 'InvalidShape'],
    [message('t1', { text: 'x', mode: 'plan' }), 'InvalidShape'], [message('t1', { text: 'x', attachments: 'a' }), 'InvalidShape'], [{ taskId: 't1', message: { text: 'x' }, extra: 1 }, 'InvalidShape'],
    [message('t1', { text: 'x'.repeat(TEXT_BYTES + 1) }), 'LimitExceeded'], [message('t1', { text: 'x', attachments: Array(MAX_ATTACHMENTS + 1).fill('a') }), 'LimitExceeded'],
    [message('t1', { attachments: ['a'] }), 'ok'], [message('t1', { text: 'x', delivery: 'queue' }), 'ok'],
  ] as [unknown, string][]) expect(admit(raw), JSON.stringify(raw).slice(0, 80)).toBe(expected);
  expect(plan(true, 'auto', true, true)).toBe('queue');
  expect(plan(false, 'steer', true, false)).toBe('send');
  expect(steerFailure('The agent is not running; the message stays queued.')).toBe('idle');
  expect(steerFailure('This agent cannot be steered; the message stays queued.')).toMatchObject({ code: 'UnsupportedCapability' });
  for (const [text, expected] of [['The queue changed. Try reordering again.', 'StaleContext'], ['This queued message was already sent or removed.', 'NotFound'], ['A task can queue up to 50 messages.', 'LimitExceeded'], ['Write a message or add an attachment to queue.', 'InvalidShape'], ['disk on fire', 'HostUnavailable']]) expect(queueCode(text), text).toBe(expected);
});

test('extensions runtime tasks messages: a note starts no turn; one for the model also needs the context permission and rides the next message once', () => {
  const host = messenger();
  const plain = host.note(OWNER, checks(), { taskId: 't1', note: { text: 'CI is red on main.' } });
  expect(plain.ok).toBe(true);
  expect(host.transcript).toEqual([{ taskId: 't1', text: `Note from ${NAME}: CI is red on main.` }]);
  expect([host.sent.length, host.queueOf('t1').length, host.ledger.pendingNotes('t1')]).toEqual([0, 0, 0]);
  // forModel: the transcript line is labelled, nothing is sent, and the block waits for the task's next message.
  expect(host.note(OWNER, checks(), { taskId: 't1', note: { text: 'The linter is flaky.', forModel: true } }).ok).toBe(true);
  expect(host.note(OWNER, checks(), { taskId: 't1', note: { text: 'Second note\nover two lines', forModel: true } }).ok).toBe(true);
  expect(host.sent).toHaveLength(0);
  expect(host.ledger.pendingNotes('t1')).toBe(2);
  expect(host.message(OWNER, checks(), message('t1', { text: 'please fix the tests' })).ok).toBe(true);
  expect(host.sent[0].text).toBe(`${renderContext([{ id: '', owner: OWNER, package: NAME, text: 'The linter is flaky.', at: 0 }, { id: '', owner: OWNER, package: NAME, text: 'Second note\nover two lines', at: 0 }])}\n\nplease fix the tests`);
  expect(host.sent[0].notes).toEqual(['The linter is flaky.', 'Second note\nover two lines']);
  // Exactly once: the next message carries nothing, and a typed slash command never gets a block in front of it.
  host.endRun('t1');
  expect(host.message(OWNER, checks(), message('t1', { text: 'again' })).ok).toBe(true);
  expect(host.sent[1].notes).toEqual([]);
  host.note(OWNER, checks(), { taskId: 't3', note: { text: 'for B', forModel: true } });
  expect(carriesContext('/compact')).toBe(false);
});

test('extensions runtime tasks messages: a forModel note without harness.hooks.context names that permission; a plain one still works', () => {
  const host = messenger();
  const onlyMessage: Grants = [[PERMISSION, 'A'], [PERMISSION, 'B']];
  const refused = host.note(OWNER, checks(onlyMessage), { taskId: 't1', note: { text: 'x', forModel: true } });
  expect(refused).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: 'harness.hooks.context' } });
  expect(host.note(OWNER, checks(onlyMessage), { taskId: 't1', note: { text: 'x' } }).ok).toBe(true);
  expect(host.ledger.pendingNotes('t1')).toBe(0);
  const admit = (raw: unknown) => { const result = admitNote(world(), raw); return 'code' in result ? result.code : 'ok'; };
  for (const [raw, expected] of [[{ taskId: 't1', note: { text: ' ' } }, 'InvalidShape'], [{ taskId: 't1', note: { text: 'x', forModel: 'yes' } }, 'InvalidShape'], [{ taskId: 't1', note: { text: 'x', send: true } }, 'InvalidShape'], [{ taskId: 't1', note: { text: 'x'.repeat(NOTE_BYTES + 1) } }, 'LimitExceeded']] as [unknown, string][]) expect(admit(raw), JSON.stringify(raw).slice(0, 60)).toBe(expected);
  const full = new TaskMessages();
  for (let index = 0; index < MAX_NOTES_PER_TASK; index += 1) expect(full.addNote('t1', OWNER, NAME, `n${index}`, index).ok).toBe(true);
  expect(code(full.addNote('t1', OWNER, NAME, 'one too many', 0) as never)).toBe('LimitExceeded');
});

test('extensions runtime tasks messages: a note that was taken for a message that never saved comes back first', () => {
  const store = new TaskMessages();
  store.addNote('t1', OWNER, NAME, 'old', 1);
  const taken = store.takeNotes('t1');
  store.addNote('t1', OWNER, NAME, 'newer', 2);
  store.restoreNotes('t1', taken);
  expect(store.takeNotes('t1').map(note => note.text)).toEqual(['old', 'newer']);
  const failing = messenger({ failSend: () => 'disk on fire' });
  failing.note(OWNER, checks(), { taskId: 't1', note: { text: 'kept', forModel: true } });
  expect(failing.message(OWNER, checks(), message('t1', { text: 'go' }))).toMatchObject({ ok: false, error: { code: 'HostUnavailable' } });
  expect(failing.ledger.pendingNotes('t1')).toBe(1);
  expect(failing.sent).toEqual([]);
});

function seeded(texts: string[], over: Partial<MessengerWorld> = {}) {
  const host = messenger(over);
  const ids = texts.map(text => entryOf(host.message(OWNER, checks(), message('t2', { text }))));
  return { host, ids };
}
const list = (host: TaskMessenger, task = 't2') => host.queue(OWNER, checks(), { op: 'list', taskId: task }) as { ok: true; value: { revision: number; entries: { id: string; text: string; package?: string; changedBy?: string }[] } };

test('extensions runtime tasks messages: the queue lists in order with its revision and the package that added each entry', () => {
  const { host, ids } = seeded(['first', 'second', 'third']);
  const answer = list(host);
  expect(answer.value.entries.map(entry => [entry.id, entry.text, entry.package])).toEqual(ids.map((id, index) => [id, ['first', 'second', 'third'][index], NAME]));
  expect(answer.value.revision).toBe(revision(host.queueOf('t2')));
  // A message for another task has its own queue and its own revision.
  expect(list(host, 't1').value.entries).toEqual([]);
});

test('extensions runtime tasks messages: an edit with a stale revision, or of a removed entry, is refused and changes nothing', () => {
  const { host, ids } = seeded(['first', 'second']);
  const before = list(host).value;
  expect(host.queue(OWNER, checks(), { op: 'update', taskId: 't2', entryId: ids[0], change: { text: 'first, edited', revision: before.revision } }).ok).toBe(true);
  // The same revision again is now stale: the queue moved.
  expect(host.queue(OWNER, checks(), { op: 'update', taskId: 't2', entryId: ids[0], change: { text: 'lost', revision: before.revision } })).toMatchObject({ ok: false, error: { code: 'StaleContext' } });
  expect(list(host).value.entries[0].text).toBe('first, edited');
  expect(list(host).value.revision).not.toBe(before.revision);
  // Without a revision the edit is last-writer-wins; a removed entry and another task's entry are NotFound.
  expect(host.queue(OWNER, checks(), { op: 'update', taskId: 't2', entryId: ids[1], change: { text: 'second, edited' } }).ok).toBe(true);
  expect(host.queue(OWNER, checks(), { op: 'remove', taskId: 't2', entryId: ids[1] }).ok).toBe(true);
  for (const op of [{ op: 'update', entryId: ids[1], change: { text: 'x' } }, { op: 'remove', entryId: ids[1] }, { op: 'sendNow', entryId: ids[1] }]) expect(code(host.queue(OWNER, checks(), { ...op, taskId: 't2' }) as never), JSON.stringify(op)).toBe('NotFound');
  expect(code(host.queue(OWNER, checks(), { op: 'remove', taskId: 't1', entryId: ids[0] }) as never)).toBe('NotFound');
  expect(list(host).value.entries.map(entry => entry.text)).toEqual(['first, edited']);
});

test('extensions runtime tasks messages: reorder must name exactly the queue; the order is what the drain then sends', () => {
  const { host, ids } = seeded(['a', 'b', 'c']);
  expect(host.queue(OWNER, checks(), { op: 'reorder', taskId: 't2', entryIds: [ids[2], ids[0]] })).toMatchObject({ ok: false, error: { code: 'StaleContext' } });
  expect(host.queue(OWNER, checks(), { op: 'reorder', taskId: 't2', entryIds: [ids[2], ids[0], 'gone'] })).toMatchObject({ ok: false, error: { code: 'StaleContext' } });
  expect(host.queue(OWNER, checks(), { op: 'reorder', taskId: 't2', entryIds: [ids[0], ids[0], ids[1]] })).toMatchObject({ ok: false, error: { code: 'InvalidShape' } });
  expect(host.queue(OWNER, checks(), { op: 'reorder', taskId: 't2', entryIds: [ids[2], ids[0], ids[1]] }).ok).toBe(true);
  expect(list(host).value.entries.map(entry => entry.text)).toEqual(['c', 'a', 'b']);
  host.endRun('t2');
  expect(host.sent.map(entry => entry.text)).toEqual(['c']);
});

test('extensions runtime tasks messages: sendNow delivers an entry once, steers a running turn, and is explicit when it cannot', () => {
  const idle = messenger({}, [{ id: 't1', projectId: 'A', running: false }]);
  // Seed an entry on an idle task without letting the drain take it: the task runs while it is added.
  const task = (idle as unknown as { world: MessengerWorld }).world.tasks[0];
  task.running = true;
  const id = entryOf(idle.message(OWNER, checks(), message('t1', { text: 'send me now' })));
  task.running = false;
  expect(idle.queue(OWNER, checks(), { op: 'sendNow', taskId: 't1', entryId: id }).ok).toBe(true);
  expect(idle.sent.map(entry => entry.text)).toEqual(['send me now']);
  expect(code(idle.queue(OWNER, checks(), { op: 'sendNow', taskId: 't1', entryId: id }) as never)).toBe('NotFound');
  expect(idle.sent).toHaveLength(1);
  // A running task that steers takes the entry into its turn; one that cannot keeps it queued.
  const running = messenger({}, [{ id: 'live', projectId: 'A', running: true }, { id: 'plain', projectId: 'A', running: true, steerable: false }]);
  const live = entryOf(running.message(OWNER, checks(), message('live', { text: 'into the turn' })));
  const stuck = entryOf(running.message(OWNER, checks(), message('plain', { text: 'cannot steer' })));
  expect(running.queue(OWNER, checks(), { op: 'sendNow', taskId: 'live', entryId: live }).ok).toBe(true);
  expect(running.steered).toEqual([{ taskId: 'live', text: 'into the turn' }]);
  expect(running.queue(OWNER, checks(), { op: 'sendNow', taskId: 'plain', entryId: stuck })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability' } });
  expect(running.queueOf('plain').map(row => row.text)).toEqual(['cannot steer']);
  // A send that fails leaves the entry where it was, and delivers nothing.
  const failing = messenger({ failSend: () => 'disk on fire' }, [{ id: 't1', projectId: 'A', running: true }]);
  const kept = entryOf(failing.message(OWNER, checks(), message('t1', { text: 'stay' })));
  (failing as unknown as { world: MessengerWorld }).world.tasks[0].running = false;
  expect(code(failing.queue(OWNER, checks(), { op: 'sendNow', taskId: 't1', entryId: kept }) as never)).toBe('HostUnavailable');
  expect(failing.queueOf('t1').map(row => row.text)).toEqual(['stay']);
});

test('extensions runtime tasks messages: every queue call needs the permission and records the package; an edit by another keeps the creator', () => {
  const { host, ids } = seeded(['one']);
  const none: Grants = [];
  for (const op of [{ op: 'list' }, { op: 'update', entryId: ids[0], change: { text: 'x' } }, { op: 'remove', entryId: ids[0] }, { op: 'reorder', entryIds: ids }, { op: 'sendNow', entryId: ids[0] }, { op: 'resume' }]) {
    expect(host.queue(OWNER, checks(none), { ...op, taskId: 't2' }), JSON.stringify(op)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: 'tasks.message' } });
  }
  expect(host.queueOf('t2').map(row => row.text)).toEqual(['one']);
  const editor = { ...checks(), package: 'Other editor' };
  expect(host.queue('sample.other', editor, { op: 'update', taskId: 't2', entryId: ids[0], change: { text: 'one, edited' } }).ok).toBe(true);
  expect(host.ledger.entry(ids[0])).toMatchObject({ package: NAME, owner: OWNER, changedBy: 'Other editor' });
  expect(host.queue(OWNER, checks(), { op: 'resume', taskId: 't2' }).ok).toBe(true);
  expect(host.resumed).toEqual(['t2']);
  expect(host.queue(OWNER, checks(), { op: 'remove', taskId: 't2', entryId: ids[0] }).ok).toBe(true);
  expect(host.ledger.entry(ids[0])).toBeUndefined();
  const refuse = (raw: unknown) => { const result = admitQueue(world(), raw); return 'code' in result ? result.code : 'ok'; };
  for (const raw of [{ op: 'explode', taskId: 't2' }, { op: 'remove', taskId: 't2' }, { op: 'update', taskId: 't2', entryId: 'e', change: { revision: 1 } }, { op: 'update', taskId: 't2', entryId: 'e', change: { text: 'x', revision: -1 } }, { op: 'list', taskId: 't2', extra: 1 }]) expect(refuse(raw), JSON.stringify(raw)).toBe('InvalidShape');
});

test('extensions runtime tasks messages: the revision is a stable 53-bit hash that moves with every change and nothing else', () => {
  const row = (id: string, position: number, text: string, updatedAt = 1, attachments = 0): QueueRow => ({ id, position, text, attachments, createdAt: 1, updatedAt });
  const base = [row('a', 0, 'first'), row('b', 1, 'second')];
  expect(revision(base)).toBe(revision(base.map(entry => ({ ...entry }))));
  expect(revision(base)).toBeLessThan(2 ** 53);
  const variants = [base, [row('a', 0, 'first!', 2), row('b', 1, 'second')], [row('b', 0, 'second'), row('a', 1, 'first')], [row('a', 0, 'first')], [], [row('a', 0, 'first', 1, 1), row('b', 1, 'second')]];
  expect(new Set(variants.map(revision)).size).toBe(variants.length);
  // The empty queue and a known queue have fixed values the native tests assert as well.
  expect(revision([])).toBe(Number(0xcbf29ce484222325n & ((1n << 53n) - 1n)));
});

test('extensions runtime tasks messages: the ledger is bounded, forgets a deleted task and keeps the creator', () => {
  const ledger = new TaskMessages();
  for (let index = 0; index < MAX_LEDGER + 5; index += 1) ledger.recordEntry(`e${index}`, { taskId: 't1', owner: OWNER, package: NAME, at: index });
  expect([ledger.entry('e0'), ledger.entry(`e${MAX_LEDGER + 4}`)?.package]).toEqual([undefined, NAME]);
  ledger.recordEntry('x1', { taskId: 't9', owner: OWNER, package: NAME, at: 1 });
  ledger.recordEntry('x1', { taskId: 't9', owner: OWNER, package: 'Other', at: 2 });
  expect(ledger.entry('x1')?.package).toBe(NAME);
  ledger.addNote('t9', OWNER, NAME, 'n', 1);
  ledger.forgetTask('t9');
  expect([ledger.entry('x1'), ledger.pendingNotes('t9')]).toEqual([undefined, 0]);
});

test('extensions runtime tasks messages: the host wires the calls, the requests, the cleanup, the commands and the registrations', () => {
  const host = read('src-tauri/src/extensions/node-host.cjs');
  for (const call of ["rpc('tasksMessage'", "rpc('tasksNote'", "rpc('tasksQueue'"]) expect(host, call).toContain(call);
  expect(read('src-tauri/src/extensions/runtime_service_lifetime.rs')).toContain('runtime_tasks_messages::serve');
  const lib = read('src-tauri/src/lib.rs');
  for (const name of ['runtime_tasks_messages::extensions_runtime_message_origins', 'runtime_tasks_messages::TaskMessages::open', 'runtime_tasks_messages::task_removed']) expect(lib, name).toContain(name);
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_tasks_messages');
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-tasks-messages.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

type Seams = { __runtimeQueueResume?: { resume(event: { taskId: string }): void }; __runtimeMessageOrigins?: { set(entries: Record<string, unknown>): void } };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeQueueResume && (window as unknown as Seams).__runtimeMessageOrigins))).toBe(true);
}

test('extensions runtime tasks messages: the package name marks only the queued rows it added, and follows the queue through redraws', async ({ page }) => {
  await setup(page);
  // The preview's queue panel: two rows, one added by a package.
  await page.evaluate(() => {
    document.body.insertAdjacentHTML('beforeend', '<section class="queue-panel" id="spec-queue"><ol class="queue-list"><li class="queue-row" data-queue-id="q1"><span class="queue-text">from a package</span></li><li class="queue-row" data-queue-id="q2"><span class="queue-text">from the user</span></li></ol></section>');
    (window as unknown as Seams).__runtimeMessageOrigins!.set({ q1: { taskId: 't', owner: 'sample.runtime-tasks-messages', package: 'Task messenger', changedBy: null } });
  });
  const chip = page.locator('#spec-queue [data-queue-id="q1"] .runtime-queue-origin');
  await expect(chip).toHaveText('Task messenger');
  await expect(chip).toHaveAttribute('title', 'Queued by Task messenger');
  await expect(page.locator('#spec-queue [data-queue-id="q2"] .runtime-queue-origin')).toHaveCount(0);
  await page.evaluate(() => (window as unknown as Seams).__runtimeMessageOrigins!.set({ q1: { taskId: 't', owner: 'sample.runtime-tasks-messages', package: 'Task messenger', changedBy: 'Other editor' } }));
  await expect(chip).toHaveAttribute('title', 'Queued by Task messenger, edited by Other editor');
  await page.evaluate(() => (window as unknown as Seams).__runtimeMessageOrigins!.set({}));
  await expect(page.locator('.runtime-queue-origin')).toHaveCount(0);
});

test('extensions runtime tasks messages: a resume from a package reaches the window, which releases the hold like its own Resume button', async ({ page }) => {
  await setup(page);
  // The seam stands for the native event `extensions-runtime-queue-resume`; main.ts's host function drops the hold and dispatches.
  await page.evaluate(() => (window as unknown as Seams).__runtimeQueueResume!.resume({ taskId: 'task-1' }));
  expect(await page.evaluate(() => (window as unknown as { __runtimeQueueResumed?: string[] }).__runtimeQueueResumed)).toEqual(['task-1']);
  await expect(page.locator('#prompt')).toBeEnabled();
});
