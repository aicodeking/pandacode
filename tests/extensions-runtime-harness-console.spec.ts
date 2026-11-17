import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { ConsoleModel, PERMISSION, answerRound, failureCode, gate, listValue, readCommand, readRequest, roundPayload, type Checks, type Round, type WindowHost } from '../src/extensions/runtime-harness-console';

// Preview column of R0408 (harness consoles and command-center actions). The groups run the deterministic model in
// src/extensions/runtime-harness-console.ts, which mirrors src-tauri/src/extensions/runtime_harness_console.rs (whose own unit
// tests are `runtime_harness_console::tests`), and the window half with a fake host. The installed service opening a real
// console is a native test, reported in its own column: this file claims only the preview and model column.
//
// Refusal-test reconciliation (Q007, Q065, Q073, Q100, Q129): the rows that refused the harness console and command-center
// controls refuse a contributed UI ACTION at a protected location; that stays, because a contribution is a click the user did
// not make. What this slice delivers is a different path: `panda.harnesses.console.*` and `commands.*` under the named
// permission `harness.console`, which the model proves granted, narrowed, revoked and refused. The refusals that remain are
// asserted here, each with its non-security reason (docs/extensions/runtime-harness-console.md).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-harness-console/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-harness-console/main.cjs');
const OWNER = 'sample.runtime-harness-console';

const checks = (projects: readonly string[] = ['A', 'B'], holds = projects.length > 0): Checks => ({ holds, granted: project => projects.includes(project) });
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
function model() {
  const host = new ConsoleModel();
  host.projects.add('A'); host.projects.add('B');
  host.providers.set('codex', { console: true, commands: [
    { name: '/compact', description: 'Free up context', kind: 'native' },
    { name: '/model', description: 'Choose the model', kind: 'action' },
    { name: '/console', description: 'Open a console', kind: 'unsupported' },
  ] });
  host.providers.set('acme.agent/local', { console: false, commands: [{ name: '/ping', description: 'Ping the package', kind: 'package' }, { name: '/console', description: '', kind: 'unsupported' }] });
  host.tasks.set('t1', { projectId: 'A', provider: 'codex', running: false });
  host.tasks.set('t2', { projectId: 'A', provider: 'codex', running: true });
  host.tasks.set('tb', { projectId: 'B', provider: 'codex', running: false });
  host.tasks.set('tp', { projectId: 'A', provider: 'acme.agent/local', running: false });
  return host;
}

test('extensions runtime harness console: the fixture package declares the permission and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['console.open', 'commands.list', 'commands.run', 'runFirst', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package types nothing into a terminal and never touches a credential.
  expect(fixtureSource).not.toMatch(/terminals\.write|credentials|tasks\.message/i);
});

test('extensions runtime harness console: every call is read strictly and anything else is InvalidShape', () => {
  expect(readRequest({ op: 'open', taskId: 't1' })).toEqual({ op: 'open', open: { taskId: 't1' } });
  expect(readRequest({ op: 'open', harness: 'codex', projectId: 'A' })).toEqual({ op: 'open', open: { harness: 'codex', projectId: 'A' } });
  expect(readRequest({ op: 'list', harness: 'codex' })).toEqual({ op: 'list', harness: 'codex' });
  expect(readRequest({ op: 'run', taskId: 't1', command: 'model', arguments: '  gpt-5 ' })).toEqual({ op: 'run', taskId: 't1', command: '/model', arguments: 'gpt-5' });
  for (const raw of [
    'x', {}, { op: 'close', taskId: 't1' }, { op: 'open' }, { op: 'open', taskId: 't1', harness: 'codex' }, { op: 'open', harness: 'codex' }, { op: 'open', taskId: 't1', send: true },
    { op: 'list' }, { op: 'list', harness: 'codex', taskId: 't1' }, { op: 'run', taskId: 't1' }, { op: 'run', command: '/x' }, { op: 'run', taskId: 't1', command: '' },
    { op: 'run', taskId: 't1', command: '/a b' }, { op: 'run', taskId: 't1', command: '/x; rm' }, { op: 'run', taskId: 't1', command: '/x', arguments: 3 }, { op: 'run', taskId: 't1', command: '/x', arguments: 'a\nb' }, { op: 'open', taskId: '' },
  ]) expect(readRequest(raw), JSON.stringify(raw)).toMatchObject({ code: 'InvalidShape' });
  expect(readRequest({ op: 'run', taskId: 't1', command: `/${'c'.repeat(129)}` })).toMatchObject({ code: 'LimitExceeded' });
  expect(readRequest({ op: 'run', taskId: 't1', command: '/x', arguments: 'a'.repeat(4097) })).toMatchObject({ code: 'LimitExceeded' });
  expect(readCommand('/compact')).toBe('/compact');
});

test('extensions runtime harness console: a built-in harness opens by task or by harness and project, and nothing else opens', () => {
  const host = model();
  expect(host.call(OWNER, checks(), { op: 'open', taskId: 't1' })).toEqual({ ok: true, value: null });
  expect(host.call(OWNER, checks(), { op: 'open', harness: 'codex', projectId: 'B' })).toEqual({ ok: true, value: null });
  expect(host.consoles).toEqual([{ by: OWNER, taskId: 't1', harness: 'codex', projectId: 'A' }, { by: OWNER, harness: 'codex', projectId: 'B' }]);
  // A running task needs stopping first, as for the user; a task that is gone is NotFound.
  expect(code(host.call(OWNER, checks(), { op: 'open', taskId: 't2' }))).toBe('Busy');
  expect(code(host.call(OWNER, checks(), { op: 'open', taskId: 'gone' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'open', harness: 'codex', projectId: 'zzz' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'open', harness: 'nope', projectId: 'A' }))).toBe('NotFound');
  expect(host.consoles).toHaveLength(2);
});

test('extensions runtime harness console: a package provider console is UnsupportedCapability while its supported command stays callable', () => {
  const host = model();
  expect(code(host.call(OWNER, checks(), { op: 'open', taskId: 'tp' }))).toBe('UnsupportedCapability');
  expect(code(host.call(OWNER, checks(), { op: 'open', harness: 'acme.agent/local', projectId: 'A' }))).toBe('UnsupportedCapability');
  expect(code(host.call(OWNER, checks(), { op: 'run', taskId: 'tp', command: '/console' }))).toBe('UnsupportedCapability');
  expect(host.consoles).toEqual([]);
  expect(host.call(OWNER, checks(), { op: 'run', taskId: 'tp', command: '/ping' })).toEqual({ ok: true, value: null });
  expect(host.ran).toEqual([{ by: OWNER, taskId: 'tp', command: '/ping', arguments: '' }]);
});

test('extensions runtime harness console: the list is the command center and a run carries the same arguments as the user', () => {
  const host = model();
  expect(host.call(OWNER, checks(), { op: 'list', harness: 'codex' })).toEqual({ ok: true, value: [{ id: '/compact', title: 'Free up context' }, { id: '/model', title: 'Choose the model' }] });
  expect(listValue([{ name: '/x', description: '  ', kind: 'native' }])).toEqual([{ id: '/x', title: '/x' }]);
  // A harness the package has no task of in a project it may use lists nothing; an unknown harness is NotFound.
  expect(host.call(OWNER, checks(['zzz'], true), { op: 'list', harness: 'codex' })).toEqual({ ok: true, value: [] });
  expect(code(host.call(OWNER, checks(), { op: 'list', harness: 'nope' }))).toBe('NotFound');
  host.userRun('t1', '/model gpt-5');
  expect(host.call(OWNER, checks(), { op: 'run', taskId: 't1', command: '/model', arguments: 'gpt-5' })).toEqual({ ok: true, value: null });
  const [user] = host.userRan, [package_] = host.ran;
  expect({ taskId: package_.taskId, command: package_.command, arguments: package_.arguments }).toEqual(user);
  // The package is named on the action; the user's own run has no package.
  expect(package_.by).toBe(OWNER);
});

test('extensions runtime harness console: no grant, a narrowed project, an unknown command or a removed task leave no console and no run', () => {
  const host = model();
  expect(host.call(OWNER, checks([], false), { op: 'open', taskId: 't1' })).toEqual({ ok: false, error: { schemaVersion: 1, code: 'PermissionDenied', path: PERMISSION, ids: [] } });
  expect(code(host.call(OWNER, checks([], false), { op: 'open', taskId: 'gone' }))).toBe('PermissionDenied');
  // Narrowed to project B: a task of project A is denied (not NotFound), a task of B is served.
  expect(code(host.call(OWNER, checks(['B']), { op: 'open', taskId: 't1' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, checks(['B']), { op: 'run', taskId: 't1', command: '/compact' }))).toBe('PermissionDenied');
  expect(code(host.call(OWNER, checks(['B']), { op: 'open', taskId: 'tb' }))).toBe('ok');
  host.consoles.length = 0;
  expect(code(host.call(OWNER, checks(), { op: 'run', taskId: 't1', command: '/nope' }))).toBe('NotFound');
  expect(code(host.call(OWNER, checks(), { op: 'run', taskId: 'gone', command: '/compact' }))).toBe('NotFound');
  // A disabled package (its service ended) and a revoke between the checks and the effect change nothing.
  host.ended.add(OWNER);
  expect(code(host.call(OWNER, checks(), { op: 'open', taskId: 't1' }))).toBe('PermissionDenied');
  host.ended.clear();
  let allowed = true;
  const revoking: Checks = { holds: true, granted: () => allowed };
  expect(code(host.call(OWNER, revoking, { op: 'run', taskId: 't1', command: '/compact' }, () => { allowed = false; }))).toBe('PermissionDenied');
  expect([host.consoles, host.ran]).toEqual([[], []]);
  expect(gate(true, undefined, () => true)).toMatchObject({ code: 'NotFound' });
  expect(gate(false, 'A', () => true)).toMatchObject({ code: 'PermissionDenied', path: PERMISSION });
});

function fakeWindow() {
  const log: string[] = [];
  const tasks = new Map([['t1', { projectId: 'A', provider: 'codex', running: false }], ['t2', { projectId: 'A', provider: 'codex', running: true }]]);
  const host: WindowHost = {
    task: id => tasks.get(id),
    show: async id => { log.push(`show:${id}`); },
    openTask: async id => { log.push(`open:${id}`); },
    openHarness: async (harness, project) => { log.push(`harness:${harness}:${project}`); },
    run: async (id, command, args) => { if (command === '/boom') throw new Error('UnsupportedCapability: no console'); log.push(`run:${id}:${command}:${args}`); },
    attribute: (packageId, text) => { log.push(`say:${packageId}:${text}`); },
  };
  return { host, log };
}
const round = (fields: Partial<Round>): Round => ({ id: 'r1', op: 'run', projectId: 'A', harness: 'codex', package: OWNER, ...fields });

test('extensions runtime harness console: the window opens the console and runs the command as the user would, naming the package', async () => {
  const { host, log } = fakeWindow();
  expect(await answerRound(host, round({ op: 'open', taskId: 't1' }))).toEqual({ ok: true });
  expect(await answerRound(host, round({ op: 'open' }))).toEqual({ ok: true });
  expect(await answerRound(host, round({ op: 'run', taskId: 't1', command: '/model', arguments: 'gpt-5' }))).toEqual({ ok: true });
  expect(log).toEqual([
    'show:t1', 'open:t1', `say:${OWNER}:${OWNER} opened the codex console.`,
    'harness:codex:A', `say:${OWNER}:${OWNER} opened the codex console.`,
    'show:t1', `say:${OWNER}:${OWNER} ran /model.`, 'run:t1:/model:gpt-5',
  ]);
});

test('extensions runtime harness console: the window refuses a task that is gone, moved or now running and opens nothing', async () => {
  const { host, log } = fakeWindow();
  expect(await answerRound(host, round({ op: 'open', taskId: 'gone' }))).toEqual({ ok: false, code: 'NotFound' });
  expect(await answerRound(host, round({ op: 'open', taskId: 't2' }))).toEqual({ ok: false, code: 'Busy' });
  expect(await answerRound(host, round({ op: 'open', taskId: 't1', projectId: 'B' }))).toEqual({ ok: false, code: 'StaleContext' });
  expect(await answerRound(host, round({ op: 'run', taskId: 't1', command: '/boom' }))).toEqual({ ok: false, code: 'UnsupportedCapability' });
  expect(log.filter(line => line.startsWith('open:') || line.startsWith('harness:'))).toEqual([]);
  expect(failureCode(new Error('Stop this task before opening its harness console.'))).toBe('Busy');
  expect(failureCode(new Error('Select a task before opening its harness console.'))).toBe('NotFound');
  expect(failureCode('disk on fire')).toBe('HostUnavailable');
});

test('extensions runtime harness console: the round names the package, the command and the arguments unchanged', () => {
  const request = readRequest({ op: 'run', taskId: 't1', command: '/model', arguments: 'gpt-5' });
  expect(roundPayload(request as never, 't1', 'A', 'codex', OWNER)).toEqual({ op: 'run', projectId: 'A', harness: 'codex', package: OWNER, taskId: 't1', command: '/model', arguments: 'gpt-5' });
  expect(roundPayload({ op: 'open', open: { harness: 'codex', projectId: 'A' } }, undefined, 'A', 'codex', OWNER)).toEqual({ op: 'open', projectId: 'A', harness: 'codex', package: OWNER });
});
