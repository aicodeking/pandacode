import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { CHUNK_BYTES, DraftModel, PERMISSION, READ_PERMISSION, TEXT_BYTES, answerRound, attachCode, gate, memoryPage, readRequest, readResolved, revisionOf, type Checks, type DraftAttachment, type Round, type WindowHost } from '../src/extensions/runtime-tasks-drafts';

// Preview column of R0403 (drafts and attachments without sending). The first groups run the deterministic model in
// src/extensions/runtime-tasks-drafts.ts, which mirrors src-tauri/src/extensions/runtime_tasks_drafts.rs (whose own unit tests
// are `runtime_tasks_drafts::tests`); the last group drives the main window's half in the preview app. The installed service
// editing a draft through the broker is a native test, reported in its own column: this file claims only the preview and model
// column.
//
// Refusal-test reconciliation (Q004, Q006, Q007, Q010, Q070, Q072, Q073, Q076, Q097, Q099, Q100, Q103): the rows that refused
// `draft-write`, `message-send`, `slash-read-draft` and the attach controls refuse a contributed UI ACTION at a protected
// location; that stays, because a contribution is a click the user did not make. What this slice delivers is a different path:
// `panda.tasks.draft.*` under the named permission `tasks.draft`, which the model below proves granted, narrowed, revoked and
// stale. The refusals that remain are asserted here, each with its non-security reason.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-drafts/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-tasks-drafts/main.cjs');
const OWNER = 'sample.runtime-tasks-drafts';

const checks = (projects: readonly string[] = ['A', 'B'], holds = projects.length > 0): Checks => ({ holds, granted: project => projects.includes(project) });
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
const bytes = (length: number) => Uint8Array.from({ length }, (_, index) => index % 251);
function model() {
  const host = new DraftModel();
  host.addTask('t1', 'A', 'hello'); host.addTask('t2', 'A', 'second'); host.addTask('tb', 'B', 'other project');
  host.show('main', 't1'); host.show('side', 't2');
  host.files.set('C:/pics/a.png', { name: 'a.png', kind: 'image', mime: 'image/png', bytes: bytes(CHUNK_BYTES * 2 + 10) });
  return host;
}

test('extensions runtime tasks drafts: the fixture package declares both permissions and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION, READ_PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['draft.get', 'draft.set', 'draft.insert', 'draft.suggest', 'draft.attach', 'draft.detach', 'attachments.read', 'readAll', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package has no way to send, and never touches a credential.
  expect(fixtureSource).not.toMatch(/tasks\.message|tasks\.start|send|credentials/i);
});

test('extensions runtime tasks drafts: a window-targeted and a task-targeted edit reach the correct draft, each as one undo step', () => {
  const host = model();
  expect(host.call(OWNER, checks(), { op: 'set', windowId: 'main', text: 'from the main window' })).toEqual({ ok: true, value: null });
  expect(host.call(OWNER, checks(), { op: 'insert', windowId: 'side', text: 'tail' })).toEqual({ ok: true, value: null });
  expect(host.call(OWNER, checks(), { op: 'set', taskId: 'tb', text: 'by id' })).toEqual({ ok: true, value: null });
  expect([host.drafts.get('t1')!.text, host.drafts.get('t2')!.text, host.drafts.get('tb')!.text]).toEqual(['from the main window', 'second tail', 'by id']);
  // One undo step per call: a single undo returns the text from before the call, and the other drafts are untouched.
  expect(host.undo('t1')).toBe(true);
  expect(host.drafts.get('t1')!.text).toBe('hello');
  expect(host.undo('t1')).toBe(false);
  expect(host.drafts.get('t2')!.text).toBe('second tail');
  // `get` reads text, attachments and the revision that guards a read-modify-write.
  const got = host.call(OWNER, checks(), { op: 'get', windowId: 'side' });
  expect(got).toEqual({ ok: true, value: { text: 'second tail', attachments: [], revision: revisionOf('second tail', []) } });
  // Nothing in any call sends.
  expect(host.sent).toEqual([]);
});

test('extensions runtime tasks drafts: suggestions are ghost text that never become the draft or send, and leave with the task, the typing or the package', () => {
  const host = model();
  expect(host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: ' world' })).toEqual({ ok: true, value: null });
  expect(host.ghost('main')).toEqual({ owner: OWNER, text: ' world' });
  expect(host.drafts.get('t1')!.text).toBe('hello');
  // It shows on the window that shows the task, not on another window.
  expect(host.ghost('side')).toBeNull();
  // Switching what the window shows leaves no ghost on either composer.
  host.show('main', 't2');
  expect([host.ghost('main'), host.drafts.get('t1')!.ghost]).toEqual([null, null]);
  host.show('main', 't1');
  expect(host.ghost('main')).toBeNull();
  // The user's own typing dismisses it; accepting it is the user's, one undo step, and still sends nothing.
  host.call(OWNER, checks(), { op: 'suggest', taskId: 't1', text: ' world' });
  host.userType('t1', 'hello!');
  expect(host.ghost('main')).toBeNull();
  host.call(OWNER, checks(), { op: 'suggest', taskId: 't1', text: ' there' });
  expect(host.accept('main')).toBe(true);
  expect([host.drafts.get('t1')!.text, host.ghost('main'), host.sent]).toEqual(['hello! there', null, []]);
  expect(host.undo('t1')).toBe(true);
  expect(host.drafts.get('t1')!.text).toBe('hello!');
  // An empty suggestion clears; the package ending, or a grant that no longer holds, takes ghost text off every screen.
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: 'x' });
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: '' });
  expect(host.ghost('main')).toBeNull();
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: 'a' });
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'side', text: 'b' });
  expect(host.end(OWNER)).toBe(2);
  expect([host.ghost('main'), host.ghost('side')]).toEqual([null, null]);
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: 'a' });
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'side', text: 'b' });
  expect(host.sweep((_owner, project) => project !== 'A')).toBe(2);
});

test('extensions runtime tasks drafts: a revision that moved is StaleContext, and a window that shows another task edits nothing', () => {
  const host = model();
  const first = host.call(OWNER, checks(), { op: 'get', taskId: 't1' });
  const revision = (first as { value: { revision: number } }).value.revision;
  host.userType('t1', 'the user typed');
  const stale = host.call(OWNER, checks(), { op: 'set', taskId: 't1', text: 'mine', revision });
  expect(code(stale)).toBe('StaleContext');
  expect(host.drafts.get('t1')!.text).toBe('the user typed');
  const fresh = (host.call(OWNER, checks(), { op: 'get', taskId: 't1' }) as { value: { revision: number } }).value.revision;
  expect(host.call(OWNER, checks(), { op: 'set', taskId: 't1', text: 'mine', revision: fresh }).ok).toBe(true);
  // The window switches between the two rounds of a call: the edit is refused and neither draft changes.
  const before = [host.drafts.get('t1')!.text, host.drafts.get('t2')!.text];
  expect(code(host.call(OWNER, checks(), { op: 'set', windowId: 'main', text: 'late' }, () => host.show('main', 't2')))).toBe('StaleContext');
  expect([host.drafts.get('t1')!.text, host.drafts.get('t2')!.text]).toEqual(before);
});

test('extensions runtime tasks drafts: attach and detach use tasks.draft and a 256 KiB page read uses tasks.transcript.read', () => {
  const host = model();
  const attached = host.call(OWNER, checks(), { op: 'attach', taskId: 't1', path: 'C:/pics/a.png' });
  expect(attached.ok && attached.value).toEqual({ id: expect.stringMatching(/^att-/) });
  const id = (attached as { value: { id: string } }).value.id;
  expect((host.call(OWNER, checks(), { op: 'get', windowId: 'main' }) as { value: { attachments: DraftAttachment[] } }).value.attachments).toEqual([{ id, kind: 'image', name: 'a.png' }]);
  // Attaching changes the revision, so a read-modify-write that read before it is stale.
  expect(code(host.call(OWNER, checks(), { op: 'set', taskId: 't1', text: 'x', revision: revisionOf('hello', []) }))).toBe('StaleContext');
  expect(code(host.call(OWNER, checks(), { op: 'attach', taskId: 't1', path: 'C:/pics/a.png' }))).toBe('Conflict');
  expect(code(host.call(OWNER, checks(), { op: 'attach', taskId: 't1', path: 'C:/pics/gone.png' }))).toBe('NotFound');
  // Pages: a byte cursor, 256 KiB decoded each, null at the end; the read grant is separate from the draft grant.
  const pages: number[] = [];
  let cursor: number | null = 0, total = 0;
  while (cursor !== null) {
    const reply = host.read(checks(), { taskId: 't1', attachmentId: id, cursor }) as { ok: true; value: { bytes: number; data: string; nextCursor: number | null } };
    expect(reply.ok).toBe(true);
    pages.push(Buffer.from(reply.value.data, 'base64').length); total = reply.value.bytes; cursor = reply.value.nextCursor;
  }
  expect([pages, total]).toEqual([[CHUNK_BYTES, CHUNK_BYTES, 10], CHUNK_BYTES * 2 + 10]);
  expect(host.read({ holds: false, granted: () => false }, { taskId: 't1', attachmentId: id })).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: READ_PERMISSION } });
  expect(code(host.read(checks(['B']), { taskId: 't1', attachmentId: id }))).toBe('PermissionDenied');
  expect(code(host.read(checks(), { taskId: 't1', attachmentId: id, cursor: CHUNK_BYTES * 3 }))).toBe('LimitExceeded');
  expect(code(host.read(checks(), { taskId: 't1', attachmentId: 'nope' }))).toBe('NotFound');
  expect(code(host.read(checks(), { taskId: 't1', attachmentId: id, cursor: -1 }))).toBe('InvalidShape');
  expect(host.call(OWNER, checks(), { op: 'detach', taskId: 't1', attachmentId: id }).ok).toBe(true);
  expect(code(host.call(OWNER, checks(), { op: 'detach', taskId: 't1', attachmentId: id }))).toBe('NotFound');
  // A draft grant alone never reads bytes: the write and read grants are independent.
  expect(host.call(OWNER, checks(), { op: 'get', taskId: 't1' }).ok).toBe(true);
  const small = memoryPage('x', 'text/plain', new Uint8Array(0), 0);
  expect(small).toMatchObject({ bytes: 0, data: '', nextCursor: null });
});

test('extensions runtime tasks drafts: no grant, a narrowed project, a revoke between the rounds and a disabled package edit nothing', () => {
  const host = model();
  for (const world of [checks([], false), checks(['B'])]) {
    const reply = host.call(OWNER, world, { op: 'set', taskId: 't1', text: 'nope' });
    expect(reply).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  }
  // A package that holds the permission nowhere learns nothing about tasks and windows: an unknown id answers the permission.
  expect(code(host.call(OWNER, checks([], false), { op: 'get', taskId: 'ghost' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, checks([], false), { op: 'get', windowId: 'ghost' }))).toBe('PermissionDenied');
  // A holder gets NotFound for what does not exist, and for a window that shows nothing.
  expect(code(host.call(OWNER, checks(), { op: 'get', taskId: 'ghost' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'get', windowId: 'ghost' }))).toBe('NotFound');
  host.show('empty', null);
  expect(code(host.call(OWNER, checks(), { op: 'get', windowId: 'empty' }))).toBe('NotFound');
  // The grant is read again after the window resolved the draft: a revoke in between creates no edit and no ghost text.
  let live = true;
  const revocable: Checks = { holds: true, granted: () => live };
  expect(code(host.call(OWNER, revocable, { op: 'set', windowId: 'main', text: 'late' }, () => { live = false; }))).toBe('PermissionDenied');
  live = true;
  expect(code(host.call(OWNER, revocable, { op: 'suggest', windowId: 'main', text: 'late' }, () => { live = false; }))).toBe('PermissionDenied');
  expect([host.drafts.get('t1')!.text, host.ghost('main'), host.log]).toEqual(['hello', null, []]);
  // The read of an attachment is rechecked after the page was cut, and a revoke wins over its result.
  host.call(OWNER, checks(), { op: 'attach', taskId: 't1', path: 'C:/pics/a.png' });
  const id = [...host.drafts.get('t1')!.attachments][0].id;
  live = true;
  expect(code(host.read(revocable, { taskId: 't1', attachmentId: id }, () => { live = false; }))).toBe('PermissionDenied');
});

test('extensions runtime tasks drafts: an input method composition is never interrupted', () => {
  const host = model();
  host.composing.add('main');
  for (const raw of [{ op: 'set', windowId: 'main', text: 'x' }, { op: 'insert', taskId: 't1', text: 'x' }, { op: 'suggest', windowId: 'main', text: 'x' }]) expect(code(host.call(OWNER, checks(), raw)), JSON.stringify(raw)).toBe('Busy');
  expect(host.drafts.get('t1')!.text).toBe('hello');
  // Reads and the other window are untouched, and accepting a suggestion waits for the composition too.
  expect(host.call(OWNER, checks(), { op: 'get', windowId: 'main' }).ok).toBe(true);
  expect(host.call(OWNER, checks(), { op: 'set', windowId: 'side', text: 'side edit' }).ok).toBe(true);
  host.composing.delete('main');
  host.call(OWNER, checks(), { op: 'suggest', windowId: 'main', text: 'x' });
  host.composing.add('main');
  expect(host.accept('main')).toBe(false);
  host.composing.delete('main');
  expect(code(host.call(OWNER, checks(), { op: 'set', windowId: 'main', text: 'after' }))).toBe('ok');
});

test('extensions runtime tasks drafts: requests are validated and no field sends, executes or reaches another target', () => {
  for (const [raw, expected] of [
    ['x', 'InvalidShape'], [{}, 'InvalidShape'], [{ op: 'send', taskId: 't1' }, 'InvalidShape'], [{ op: 'get' }, 'InvalidShape'], [{ op: 'get', windowId: 'w', taskId: 't' }, 'InvalidShape'],
    [{ op: 'set', taskId: 't1' }, 'InvalidShape'], [{ op: 'set', taskId: 't1', text: 3 }, 'InvalidShape'], [{ op: 'set', taskId: 't1', text: 'x', send: true }, 'InvalidShape'], [{ op: 'set', taskId: 't1', text: 'x', submit: true }, 'InvalidShape'],
    [{ op: 'set', taskId: 't1', text: 'x', revision: -1 }, 'InvalidShape'], [{ op: 'insert', taskId: 't1', text: '' }, 'InvalidShape'], [{ op: 'set', taskId: 't1', text: 'a\0b' }, 'InvalidShape'],
    [{ op: 'attach', taskId: 't1', path: '' }, 'InvalidShape'], [{ op: 'detach', taskId: 't1' }, 'InvalidShape'], [{ op: 'get', taskId: 't1', text: 'x' }, 'InvalidShape'],
    [{ op: 'set', taskId: 't1', text: 'x'.repeat(TEXT_BYTES + 1) }, 'LimitExceeded'], [{ op: 'attach', taskId: 't1', path: 'p'.repeat(5000) }, 'LimitExceeded'],
  ] as const) expect(readRequest(raw), JSON.stringify(raw).slice(0, 80)).toMatchObject({ code: expected });
  expect(readRequest({ op: 'set', taskId: 't1', text: '', revision: 4 })).toEqual({ target: { taskId: 't1' }, op: { op: 'set', text: '', revision: 4 } });
  expect(gate(PERMISSION, true, undefined, () => true)).toMatchObject({ code: 'NotFound' });
  expect(gate(PERMISSION, true, 'A', () => false)).toMatchObject({ code: 'PermissionDenied', path: PERMISSION });
  expect(readResolved({ ok: false, code: 'Busy' })).toMatchObject({ code: 'Busy' });
  expect(readResolved({ ok: false, code: 'Explode' })).toMatchObject({ code: 'InvalidShape' });
  expect(readResolved({ ok: true, taskId: 't1' })).toMatchObject({ code: 'InvalidShape' });
  expect(revisionOf('a', [])).not.toBe(revisionOf('b', []));
  expect(revisionOf('a', [{ id: '1' }])).not.toBe(revisionOf('a', []));
  for (const [text, expected] of [['a.png is already attached.', 'Conflict'], ['Attach up to 4 images per message.', 'LimitExceeded'], ['Grok Build does not accept images yet.', 'UnsupportedCapability'], ['read failed: no such file', 'NotFound'], ['disk on fire', 'HostUnavailable']]) expect(attachCode(text), text).toBe(expected);
});

// ---- the window half against a fake composer -----------------------------------------------------------------------

function fakeWindow() {
  const drafts = new Map<string, { project: string; text: string; attachments: DraftAttachment[] }>([['t1', { project: 'A', text: 'hello', attachments: [] }], ['t2', { project: 'A', text: 'second', attachments: [] }]]);
  const state = { shown: 't1' as string | null, composing: false, ghost: null as null | { taskId: string; owner: string; text: string }, edits: [] as string[] };
  const host: WindowHost = {
    windowId: () => 'main', shown: () => state.shown, project: id => drafts.get(id)?.project, draft: id => { const entry = drafts.get(id); return entry && { text: entry.text, attachments: entry.attachments }; },
    composing: () => state.composing,
    replace: (id, text) => { drafts.get(id)!.text = text; state.edits.push(`replace:${id}`); }, insert: (id, text) => { drafts.get(id)!.text += text; state.edits.push(`insert:${id}`); },
    ghost: (taskId, owner, text) => { state.ghost = text ? { taskId, owner, text } : null; },
    attach: async (id, path) => { if (path.includes('gone')) throw new Error('read failed: no such file'); const entry = { id: `att-${drafts.get(id)!.attachments.length + 1}`, kind: 'image', name: path }; drafts.get(id)!.attachments.push(entry); return entry; },
    detach: (id, attachment) => { const entry = drafts.get(id)!; const before = entry.attachments.length; entry.attachments = entry.attachments.filter(item => item.id !== attachment); return entry.attachments.length < before; },
    attachment: (id, attachment) => drafts.get(id)?.attachments.some(item => item.id === attachment) ? { name: 'a.png', mime: 'image/png', path: 'C:/pics/a.png' } : undefined,
  };
  return { host, drafts, state };
}
const round = (over: Partial<Round>): Round => ({ id: 'r1', owner: OWNER, phase: 'resolve', ...over });

test('extensions runtime tasks drafts: the window resolves a draft by window or by task and refuses the apply when anything moved', async () => {
  const { host, drafts, state } = fakeWindow();
  expect(await answerRound(host, round({ windowId: 'main' }))).toMatchObject({ ok: true, taskId: 't1', projectId: 'A', text: 'hello' });
  expect(await answerRound(host, round({ taskId: 't2' }))).toMatchObject({ ok: true, taskId: 't2', text: 'second' });
  expect(await answerRound(host, round({ windowId: 'elsewhere' }))).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, round({ taskId: 'ghost' }))).toEqual({ ok: false, code: 'NotFound' });
  // The window switched after the resolve: the apply for t1 through the window is stale, and nothing is edited.
  state.shown = 't2';
  expect(await answerRound(host, round({ phase: 'apply', op: 'set', windowId: 'main', taskId: 't1', text: 'x' }))).toEqual({ ok: false, code: 'StaleContext' });
  expect(drafts.get('t1')!.text).toBe('hello');
  expect(drafts.get('t2')!.text).toBe('second');
  // By id the task is the target whatever the window shows; one edit, one call.
  expect(await answerRound(host, round({ phase: 'apply', op: 'set', taskId: 't1', text: 'by id' }))).toEqual({ ok: true });
  expect(state.edits).toEqual(['replace:t1']);
  // A package revision that no longer matches is stale; one that matches applies.
  const old = revisionOf('by id', []);
  drafts.get('t1')!.text = 'user typed';
  expect(await answerRound(host, round({ phase: 'apply', op: 'set', taskId: 't1', text: 'mine', revision: old }))).toEqual({ ok: false, code: 'StaleContext' });
  expect(await answerRound(host, round({ phase: 'apply', op: 'set', taskId: 't1', text: 'mine', revision: revisionOf('user typed', []) }))).toEqual({ ok: true });
  // Composition: the edit waits; detaching and reading do not touch the text.
  state.composing = true;
  expect(await answerRound(host, round({ phase: 'apply', op: 'insert', taskId: 't1', text: 'x' }))).toEqual({ ok: false, code: 'Busy' });
  expect(await answerRound(host, round({ phase: 'apply', op: 'suggest', taskId: 't1', text: 'x' }))).toEqual({ ok: false, code: 'Busy' });
  state.composing = false;
  expect(await answerRound(host, round({ phase: 'apply', op: 'suggest', taskId: 't1', text: ' ghost' }))).toEqual({ ok: true });
  expect(state.ghost).toEqual({ taskId: 't1', owner: OWNER, text: ' ghost' });
  expect(drafts.get('t1')!.text).toBe('mine');
});

test('extensions runtime tasks drafts: the window attaches, detaches and resolves an attachment, and a failure is a frozen code', async () => {
  const { host } = fakeWindow();
  expect(await answerRound(host, round({ phase: 'apply', op: 'attach', taskId: 't1', path: 'C:/pics/a.png' }))).toEqual({ ok: true, id: 'att-1' });
  expect(await answerRound(host, round({ phase: 'apply', op: 'attach', taskId: 't1', path: 'C:/pics/gone.png' }))).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, round({ phase: 'attachment', taskId: 't1', attachmentId: 'att-1' }))).toMatchObject({ ok: true, name: 'a.png', path: 'C:/pics/a.png' });
  expect(await answerRound(host, round({ phase: 'attachment', taskId: 't1', attachmentId: 'nope' }))).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, round({ phase: 'apply', op: 'detach', taskId: 't1', attachmentId: 'att-1' }))).toEqual({ ok: true });
  expect(await answerRound(host, round({ phase: 'apply', op: 'detach', taskId: 't1', attachmentId: 'att-1' }))).toEqual({ ok: false, code: 'NotFound' });
});

test('extensions runtime tasks drafts: the host wires the calls, the cleanup, the commands, the mocks and the registrations', () => {
  const nodeHost = read('src-tauri/src/extensions/node-host.cjs');
  for (const name of ["rpc('tasksDraft'", "rpc('tasksAttachmentsRead'"]) expect(nodeHost, name).toContain(name);
  const lifetime = read('src-tauri/src/extensions/runtime_service_lifetime.rs');
  for (const name of ['runtime_tasks_drafts::serve', 'runtime_tasks_drafts::serve_attachment', 'runtime_tasks_drafts::service_stopped']) expect(lifetime, name).toContain(name);
  const lib = read('src-tauri/src/lib.rs');
  for (const name of ['runtime_tasks_drafts::extensions_runtime_draft_answer', 'runtime_tasks_drafts::extensions_runtime_draft_allowed', 'runtime_tasks_drafts::DraftSlots']) expect(lib, name).toContain(name);
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_tasks_drafts');
  expect(read('src-tauri/src/extensions/runtime_grants.rs')).toContain('runtime_tasks_drafts::sweep_app');
  expect(read('src/extensions/preview.ts')).toContain('extensions_runtime_draft_answer');
  const sdk = read('src/extensions/sdk/index.d.ts');
  for (const name of ['TasksDraftApi', 'TasksAttachmentsApi', 'AttachmentChunk', 'DraftTarget']) expect(sdk, name).toContain(name);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-tasks-drafts.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

type Seams = { __runtimeDraft?: { round(event: unknown): Promise<unknown>; ghost(): { taskId: string; owner: string; text: string } | null; clear(): void }; __runtimeDraftAnswers?: { id: string; answer: Record<string, unknown> }[] };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeDraft))).toBe(true);
}
const taskOf = (page: Page) => page.evaluate(() => document.querySelector<HTMLTextAreaElement>('#prompt')?.dataset.sessionId ?? '');

test('extensions runtime tasks drafts: a package edit of the open draft is one undo step and sends nothing', async ({ page }) => {
  await setup(page);
  const task = await taskOf(page);
  expect(task).not.toBe('');
  const prompt = page.locator('#prompt');
  await prompt.fill('typed by the user');
  await page.evaluate(({ task }) => (window as unknown as Seams).__runtimeDraft!.round({ id: 'a1', owner: 'sample.runtime-tasks-drafts', phase: 'apply', op: 'set', windowId: 'main', taskId: task, text: 'set by the package' }), { task });
  await expect(prompt).toHaveValue('set by the package');
  // The user's undo returns to what they had typed, in one step.
  await prompt.focus();
  await page.keyboard.press('ControlOrMeta+z');
  await expect(prompt).toHaveValue('typed by the user');
  const answers = await page.evaluate(() => (window as unknown as Seams).__runtimeDraftAnswers ?? []);
  expect(answers.map(entry => [entry.id, entry.answer.ok])).toEqual([['a1', true]]);
  // The message list never gained a user message: nothing was sent.
  await expect(page.locator('.message.user, [data-role="user"]')).toHaveCount(0);
});

test('extensions runtime tasks drafts: ghost text shows beside the prompt, never becomes the draft, and goes when the user types or the task changes', async ({ page }) => {
  await setup(page);
  const task = await taskOf(page);
  const prompt = page.locator('#prompt');
  await prompt.fill('hello');
  await page.evaluate(({ task }) => (window as unknown as Seams).__runtimeDraft!.round({ id: 'g1', owner: 'sample.runtime-tasks-drafts', phase: 'apply', op: 'suggest', taskId: task, text: ' world' }), { task });
  await expect(page.locator('.runtime-draft-ghost')).toHaveText(' world');
  await expect(prompt).toHaveValue('hello');
  // Typing dismisses it.
  await prompt.focus();
  await page.keyboard.type('!');
  await expect(page.locator('.runtime-draft-ghost')).toHaveCount(0);
  // A suggestion for the task, then another task opens: no ghost text is left on the other composer.
  await page.evaluate(({ task }) => (window as unknown as Seams).__runtimeDraft!.round({ id: 'g2', owner: 'sample.runtime-tasks-drafts', phase: 'apply', op: 'suggest', taskId: task, text: ' more' }), { task });
  await expect(page.locator('.runtime-draft-ghost')).toHaveCount(1);
  const other = page.locator('.task-item[data-id]').nth(1);
  await other.click();
  await expect(page.locator('.runtime-draft-ghost')).toHaveCount(0);
  expect(await page.evaluate(() => (window as unknown as Seams).__runtimeDraft!.ghost())).toBeNull();
});

test('extensions runtime tasks drafts: an edit is refused while an input method composes and a stale window never edits another draft', async ({ page }) => {
  await setup(page);
  const task = await taskOf(page);
  const prompt = page.locator('#prompt');
  await prompt.fill('keep me');
  await prompt.focus();
  await page.evaluate(() => document.querySelector('#prompt')!.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true })));
  await page.evaluate(({ task }) => (window as unknown as Seams).__runtimeDraft!.round({ id: 'c1', owner: 'sample.runtime-tasks-drafts', phase: 'apply', op: 'set', taskId: task, text: 'interrupt' }), { task });
  await expect(prompt).toHaveValue('keep me');
  await page.evaluate(() => document.querySelector('#prompt')!.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true })));
  // A call aimed at another task through this window is stale; by id it would edit that task, never this one.
  await page.evaluate(({ task }) => (window as unknown as Seams).__runtimeDraft!.round({ id: 'c2', owner: 'sample.runtime-tasks-drafts', phase: 'apply', op: 'set', windowId: 'main', taskId: `${task}-other`, text: 'wrong' }), { task });
  await expect(prompt).toHaveValue('keep me');
  const answers = await page.evaluate(() => (window as unknown as Seams).__runtimeDraftAnswers ?? []);
  expect(answers.map(entry => [entry.id, entry.answer.code])).toEqual([['c1', 'Busy'], ['c2', 'StaleContext']]);
});
