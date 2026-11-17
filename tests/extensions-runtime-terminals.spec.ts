import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { INPUT_BYTES, LOG_BYTES, MAX_SUBSCRIPTIONS, OutputLog, PAGE_BYTES, READ_PERMISSION, TICK_MS, TerminalModel, WRITE_PERMISSION, attribute, gate, permissionFor, readRequest, type Checks } from '../src/extensions/runtime-terminals';

// Preview column of R0409 (read and operate terminals with separate grants). The groups run the deterministic model in
// src/extensions/runtime-terminals.ts, which mirrors src-tauri/src/extensions/runtime_terminals.rs (whose own unit tests are
// `runtime_terminals::tests`). A real shell opened by an installed service through the broker is a native test, reported in its
// own column: this file claims only the preview and model column.
//
// Refusal-test reconciliation (Q019, Q093): the rows that refused terminal output and terminal input to a package refused them
// because no named permission existed. What this slice delivers is `terminals.read` and `terminals.write`, each proven granted,
// narrowed, revoked and independent below. The refusals that remain are asserted here with their non-security reasons:
// - a package with no grant, a revoked grant, a disabled package and a project outside the narrowing stay `PermissionDenied`:
//   authority is the user's and is rechecked natively on every call (ADR-0005 keeps the trust decision, not a prompt);
// - a terminal of no project stays invisible: it is not a project resource, so no project grant can reach it (a visibility rule);
// - writing to a terminal that already ended is `NotFound`: there is no process to receive the input (a functional fact);
// - input over 64 KiB is `LimitExceeded`: the terminal's own bound on one write (predictability, not safety).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-terminals/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-terminals/main.cjs');
const OWNER = 'sample.runtime-terminals';

const checks = (projects: readonly string[] = ['A', 'B'], holds = projects.length > 0): Checks => ({ holds, granted: project => projects.includes(project) });
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
const value = (reply: { ok: boolean; value?: unknown }) => (reply as { value: any }).value;
const revoked = { ok: true };
function model() {
  const host = new TerminalModel();
  host.addProject('A'); host.addProject('B');
  host.add('ta', 'A'); host.add('tb', 'B'); host.add('orphan', undefined);
  return host;
}

test('extensions runtime terminals: the fixture package declares both grants and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', READ_PERMISSION, WRITE_PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['terminals.list', 'terminals.read', 'terminals.open', 'terminals.write', 'terminals.close', 'terminals.onOutput', 'readAll', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package never names a credential.
  expect(fixtureSource).not.toMatch(/credentials\.|secrets\./);
});

test('extensions runtime terminals: every call reads its fields and refuses the rest, and the grant each call needs is fixed by its operation', () => {
  expect(readRequest({ op: 'list' })).toEqual({ op: 'list' });
  expect(readRequest({ op: 'read', terminalId: 't1' })).toEqual({ op: 'read', terminal: 't1', cursor: 0 });
  expect(readRequest({ op: 'subscribe', terminalId: 't1', cursor: 7 })).toEqual({ op: 'subscribe', terminal: 't1', cursor: 7 });
  expect(readRequest({ op: 'open', projectId: 'A' })).toEqual({ op: 'open', project: 'A', cols: 80, rows: 24 });
  expect(readRequest({ op: 'write', terminalId: 't1', data: 'ls\r' })).toEqual({ op: 'write', terminal: 't1', data: 'ls\r' });
  for (const raw of [
    'x', {}, { op: 'kill', terminalId: 't1' }, { op: 'read' }, { op: 'read', terminalId: '' }, { op: 'read', terminalId: 't1', cursor: -1 }, { op: 'read', terminalId: 't1', extra: 1 },
    { op: 'list', terminalId: 't1' }, { op: 'open' }, { op: 'open', projectId: 'A', cols: 1 }, { op: 'write', terminalId: 't1' }, { op: 'write', terminalId: 't1', data: '' }, { op: 'close', terminalId: 't1', force: true },
  ]) expect(readRequest(raw), JSON.stringify(raw)).toMatchObject({ code: 'InvalidShape' });
  expect(readRequest({ op: 'write', terminalId: 't1', data: 'x'.repeat(INPUT_BYTES + 1) })).toMatchObject({ code: 'LimitExceeded' });
  for (const op of ['list', 'read', 'subscribe', 'poll', 'unsubscribe']) expect(permissionFor(op), op).toBe(READ_PERMISSION);
  for (const op of ['open', 'write', 'close']) expect(permissionFor(op), op).toBe(WRITE_PERMISSION);
  expect(gate(READ_PERMISSION, false, undefined, () => true)).toMatchObject({ code: 'PermissionDenied', path: READ_PERMISSION });
  expect(gate(READ_PERMISSION, true, undefined, () => true)).toMatchObject({ code: 'NotFound' });
});

test('extensions runtime terminals: terminals.read permits no write, open or close, and terminals.write permits no read', () => {
  const host = model();
  // The two grants are two independent answers: the model is asked once per permission, as the native side is.
  const readOnly = { read: checks(), write: checks([]) };
  const writeOnly = { read: checks([]), write: checks() };
  const none = { holds: false, granted: () => false };
  for (const raw of [{ op: 'open', projectId: 'A' }, { op: 'write', terminalId: 'ta', data: 'x' }, { op: 'close', terminalId: 'ta' }]) {
    expect(host.call(OWNER, readOnly, raw)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: WRITE_PERMISSION } });
  }
  expect(host.log).toEqual([]);
  expect(host.terminals.has('ta')).toBe(true);
  for (const raw of [{ op: 'list' }, { op: 'read', terminalId: 'ta' }, { op: 'subscribe', terminalId: 'ta' }]) {
    expect(host.call(OWNER, writeOnly, raw)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: READ_PERMISSION } });
    expect(host.call(OWNER, none, raw)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: READ_PERMISSION } });
  }
  expect(host.count(OWNER)).toBe(0);
  // Each grant does exactly its own calls.
  expect(host.call(OWNER, readOnly, { op: 'list' }).ok).toBe(true);
  expect(host.call(OWNER, readOnly, { op: 'read', terminalId: 'ta' }).ok).toBe(true);
  expect(host.call(OWNER, readOnly, { op: 'subscribe', terminalId: 'ta' }).ok).toBe(true);
  expect(host.call(OWNER, writeOnly, { op: 'write', terminalId: 'ta', data: 'echo hi\r' }).ok).toBe(true);
  expect(host.call(OWNER, writeOnly, { op: 'open', projectId: 'A' }).ok).toBe(true);
  expect(host.log).toEqual(['write:ta:echo hi\r', 'open:term-1']);
  // Losing the read grant drops the listeners; stopping one never needs a grant.
  const sub = [...host.subs.keys()][0];
  expect(host.call(OWNER, writeOnly, { op: 'poll', subscriptionId: sub }, 1)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: READ_PERMISSION } });
  expect(host.count(OWNER)).toBe(0);
  const again = value(host.call(OWNER, readOnly, { op: 'subscribe', terminalId: 'ta' })).subscriptionId as string;
  expect(host.call(OWNER, none, { op: 'unsubscribe', subscriptionId: again }).ok).toBe(true);
  expect(host.count(OWNER)).toBe(0);
});

test('extensions runtime terminals: project narrowing is checked on every call and a terminal of no project is invisible', () => {
  const host = model();
  const onlyA = checks(['A']);
  expect(value(host.call(OWNER, onlyA, { op: 'list' })).map((row: { id: string }) => row.id)).toEqual(['ta']);
  expect(value(host.call(OWNER, checks(), { op: 'list' })).map((row: { id: string }) => row.id).sort()).toEqual(['ta', 'tb']);
  expect(code(host.call(OWNER, onlyA, { op: 'list', projectId: 'B' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, onlyA, { op: 'read', terminalId: 'tb' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, onlyA, { op: 'subscribe', terminalId: 'tb' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, onlyA, { op: 'write', terminalId: 'tb', data: 'x' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, onlyA, { op: 'close', terminalId: 'tb' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, onlyA, { op: 'open', projectId: 'B' }))).toBe('PermissionDenied');
  expect(host.terminals.has('tb')).toBe(true);
  // A terminal of no project, or an unknown id, is `NotFound` to a package that holds the permission, never to one that does not.
  expect(code(host.call(OWNER, checks(), { op: 'read', terminalId: 'orphan' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'read', terminalId: 'nope' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'open', projectId: 'unknown' }))).toBe('NotFound');
  expect(host.call(OWNER, { holds: false, granted: () => false }, { op: 'read', terminalId: 'nope' })).toMatchObject({ error: { code: 'PermissionDenied' } });
  // A revoke between the check and the effect changes nothing.
  revoked.ok = true;
  expect(code(host.call(OWNER, { holds: true, granted: project => revoked.ok && project === 'A' }, { op: 'write', terminalId: 'ta', data: 'late' }, 0, () => { revoked.ok = false; }))).toBe('PermissionDenied');
  expect(host.log).not.toContain('write:ta:late');
});

test('extensions runtime terminals: attribution is the package project, then the task project, then the longest folder', () => {
  const listed = (id: string, cwd: string, sessionId: string | null = null) => ({ id, title: id, cwd, sessionId, kind: 'shell', running: true, exitCode: null });
  const attribution = { owners: new Map([['opened', 'B']]), sessions: new Map([['s1', 'A']]), projects: [['A', 'C:\\work\\a'], ['N', 'C:/work/a/nested'], ['Z', 'C:/work/zz']] as [string, string][] };
  expect(attribute(attribution, listed('opened', 'C:/work/a', 's1'))).toBe('B');
  expect(attribute(attribution, listed('t', 'C:/elsewhere', 's1'))).toBe('A');
  expect(attribute(attribution, listed('t', 'C:/work/a/src'))).toBe('A');
  expect(attribute(attribution, listed('t', 'C:/work/a/nested/deep'))).toBe('N');
  expect(attribute(attribution, listed('t', 'C:/work/aa'))).toBeUndefined();
  expect(attribute(attribution, listed('t', 'D:/tmp'))).toBeUndefined();
});

test('extensions runtime terminals: open, write and close operate an inert terminal and each effect is attributed to the package', () => {
  const host = model();
  const opened = host.call(OWNER, checks(), { op: 'open', projectId: 'A', taskId: 'task-1' });
  expect(opened).toEqual({ ok: true, value: { id: 'term-1', projectId: 'A', taskId: 'task-1' } });
  expect(host.handles(OWNER)).toBe(1);
  // It lists under its project, and the output of what the package wrote can be read back.
  expect(value(host.call(OWNER, checks(['A']), { op: 'list' })).map((row: { id: string }) => row.id)).toContain('term-1');
  expect(host.call(OWNER, checks(), { op: 'write', terminalId: 'term-1', data: 'echo ready\r' }).ok).toBe(true);
  host.print('term-1', 'echo ready\r\nready\r\n');
  expect(value(host.call(OWNER, checks(), { op: 'read', terminalId: 'term-1' })).data).toBe('echo ready\r\nready\r\n');
  expect(host.call(OWNER, checks(), { op: 'close', terminalId: 'term-1' }).ok).toBe(true);
  expect(code(host.call(OWNER, checks(), { op: 'read', terminalId: 'term-1' }))).toBe('NotFound');
  expect(host.log).toEqual(['open:term-1', 'write:term-1:echo ready\r', 'close:term-1']);
  // A terminal that ended receives no input.
  host.exit('ta', 0);
  expect(code(host.call(OWNER, checks(), { op: 'write', terminalId: 'ta', data: 'x' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'write', terminalId: 'tb', data: 'x'.repeat(INPUT_BYTES + 1) }))).toBe('LimitExceeded');
});

test('extensions runtime terminals: 64 KiB pages after a byte cursor join exactly, report what was dropped and never split a character', () => {
  const host = model();
  const text = 'line of output\n'.repeat(20000);
  host.print('ta', text);
  const pages: string[] = [];
  let cursor = 0;
  for (let guard = 0; guard < 20; guard += 1) {
    const page = value(host.call(OWNER, checks(), { op: 'read', terminalId: 'ta', cursor }));
    expect(page.schemaVersion).toBe(1);
    // The first page starts where the log now begins (the oldest bytes are gone); every later page starts where the last ended.
    expect(page.cursor).toBe(pages.length === 0 ? text.length - LOG_BYTES : cursor);
    expect(new TextEncoder().encode(page.data).length).toBeLessThanOrEqual(PAGE_BYTES);
    if (page.data === '') break;
    pages.push(page.data); cursor = page.nextCursor;
  }
  expect(pages.length).toBeGreaterThan(1);
  expect(pages.join('')).toBe(text.slice(text.length - LOG_BYTES));
  expect(pages.join('').length).toBe(LOG_BYTES);
  // The first read began after the 256 KiB log had already dropped its oldest bytes: it says how many, never silently.
  expect(value(host.call(OWNER, checks(), { op: 'read', terminalId: 'ta', cursor: 0 })).dropped).toBe(text.length - LOG_BYTES);
  // A cursor past the end resumes at the end; a character is never split by a page boundary.
  const wide = new OutputLog(1024);
  wide.push('é'.repeat(100));
  const first = wide.read(0, 51);
  expect(first.data).toBe('é'.repeat(25));
  expect(wide.read(first.next, 51).data).toBe('é'.repeat(25));
  const jsonCost = new OutputLog(1024);
  jsonCost.push('"'.repeat(10));
  expect(jsonCost.read(0, 9).data).toBe('""""');
  const ended = new OutputLog(1024);
  ended.push('bye'); ended.exit(3);
  expect(ended.read(0)).toMatchObject({ data: 'bye', exited: true, exitCode: 3 });
  expect(ended.read(1)).toMatchObject({ data: 'ye', exited: true, exitCode: 3 });
});

test('extensions runtime terminals: onOutput is coalesced to ten chunks a second and its chunks neither repeat nor skip', () => {
  const host = model();
  const subscribed = host.call(OWNER, checks(), { op: 'subscribe', terminalId: 'ta' });
  const { subscriptionId } = value(subscribed);
  expect(value(subscribed).intervalMs).toBe(TICK_MS);
  let seen = '', chunks = 0, previous = 0;
  // The shell prints on every millisecond for two seconds while the service polls on every millisecond: at most one read per tick.
  for (let now = 1; now <= 2000; now += 1) {
    host.print('ta', `[${now}]`);
    const answer = value(host.call(OWNER, checks(), { op: 'poll', subscriptionId }, now));
    if (answer.chunk) {
      expect(answer.chunk.cursor).toBe(previous);
      previous = answer.chunk.nextCursor; seen += answer.chunk.data; chunks += 1;
    }
  }
  expect(chunks).toBeLessThanOrEqual(20);
  expect(chunks).toBeGreaterThanOrEqual(19);
  // Everything printed after the subscription was delivered, in order, once; the rest is one tick away.
  const last = value(host.call(OWNER, checks(), { op: 'poll', subscriptionId }, 2200));
  seen += last.chunk?.data ?? '';
  expect(seen).toBe(Array.from({ length: 2000 }, (_, index) => `[${index + 1}]`).join(''));
  // Inside a tick nothing is read and the wait is told; a replay subscription starts at an explicit cursor.
  const again = value(host.call(OWNER, checks(), { op: 'poll', subscriptionId }, 2250));
  expect(again).toEqual({ chunk: null, ended: false, retryMs: 50 });
  const replay = value(host.call(OWNER, checks(), { op: 'subscribe', terminalId: 'ta', cursor: 0 }));
  expect(value(host.call(OWNER, checks(), { op: 'poll', subscriptionId: replay.subscriptionId }, 1)).chunk.data.startsWith('[1][2]')).toBe(true);
});

test('extensions runtime terminals: close, revoke, disable and exit remove callbacks and handles', () => {
  const host = model();
  const sub = (terminalId: string) => value(host.call(OWNER, checks(), { op: 'subscribe', terminalId })).subscriptionId as string;
  // Closing a terminal ends its subscriptions: the next pump says so once, and the id is then unknown.
  const onClose = sub('ta');
  host.call(OWNER, checks(), { op: 'close', terminalId: 'ta' });
  expect(host.count(OWNER)).toBe(0);
  expect(code(host.call(OWNER, checks(), { op: 'poll', subscriptionId: onClose }, 1))).toBe('NotFound');
  // A revoked grant ends the subscription at the next pump and names the permission.
  const onRevoke = sub('tb');
  expect(host.call(OWNER, checks([]), { op: 'poll', subscriptionId: onRevoke }, 1)).toMatchObject({ ok: false, error: { code: 'PermissionDenied' } });
  const narrowed = sub('tb');
  expect(host.call(OWNER, checks(['A']), { op: 'poll', subscriptionId: narrowed }, 1)).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: READ_PERMISSION } });
  expect(host.count(OWNER)).toBe(0);
  // A sweep after a grant change, and the service ending, remove what is left; the shell it opened stays for the user.
  sub('tb'); sub('tb');
  expect(host.sweep((_owner, project) => project !== 'B')).toBe(2);
  host.call(OWNER, checks(), { op: 'open', projectId: 'A' });
  sub('tb');
  expect([host.handles(OWNER), host.count(OWNER)]).toEqual([1, 1]);
  expect(host.end(OWNER)).toBe(1);
  expect([host.handles(OWNER), host.count(OWNER), host.terminals.has('term-1')]).toEqual([0, 0, true]);
  // A terminal that exits delivers its last bytes and exit code once, then the subscription is gone.
  const exiting = sub('tb');
  host.print('tb', 'done\n'); host.exit('tb', 2);
  const final = value(host.call(OWNER, checks(), { op: 'poll', subscriptionId: exiting }, 1));
  expect(final).toMatchObject({ ended: true, chunk: { data: 'done\n', exited: true, exitCode: 2 } });
  expect(code(host.call(OWNER, checks(), { op: 'poll', subscriptionId: exiting }, 500))).toBe('NotFound');
});

test('extensions runtime terminals: subscriptions are bounded per package', () => {
  const host = model();
  for (let index = 0; index < MAX_SUBSCRIPTIONS; index += 1) expect(host.call(OWNER, checks(), { op: 'subscribe', terminalId: 'ta' }).ok).toBe(true);
  expect(code(host.call(OWNER, checks(), { op: 'subscribe', terminalId: 'ta' }))).toBe('LimitExceeded');
  expect(host.call('sample.other', checks(), { op: 'subscribe', terminalId: 'ta' }).ok).toBe(true);
  const first = [...host.subs.keys()][0];
  expect(host.call('sample.other', checks(), { op: 'poll', subscriptionId: first }, 1)).toMatchObject({ ok: false, error: { code: 'NotFound' } });
  expect(host.call('sample.other', checks(), { op: 'unsubscribe', subscriptionId: first }).ok).toBe(true);
  expect(host.subs.has(first)).toBe(true);
  expect(host.call(OWNER, checks(), { op: 'unsubscribe', subscriptionId: first }).ok).toBe(true);
  expect(host.subs.has(first)).toBe(false);
  expect(host.call(OWNER, checks(), { op: 'subscribe', terminalId: 'ta' }).ok).toBe(true);
});
