import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { envelope } from '../src/extensions/runtime-tasks-start';
import { ControlLog, MAX_LOG, PERMISSION, TaskController, admit, checkChoice, checkCompact, checkMode, codeOf, decorate, label, plan, type ControlWorld, type PreviewTask, type ProviderView, type TaskFacts, type World } from '../src/extensions/runtime-tasks-control';

// Preview column of R0404 (stop, set mode, configure and compact). The first group runs the deterministic model in
// src/extensions/runtime-tasks-control.ts, which mirrors src-tauri/src/extensions/runtime_tasks_control.rs (whose own unit
// tests are `runtime_tasks_control::tests`, including the same parity recording); the last group drives the main window's half
// in the preview app. The installed service against a real harness is the native/installed column and is not claimed here.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-control/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-tasks-control/main.cjs');
const parity = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-control/parity.json')) as { cases: { name: string; task: TaskFacts; request: Record<string, unknown>; commands: unknown[] }[] };
const OWNER = 'sample.runtime-tasks-control';
const NAME = 'Task controller';

const view = (id: string, extra: Partial<ProviderView> = {}): ProviderView => ({ id, installed: true, readiness: 'ready', models: [], modes: [], compacts: true, ...extra });
const providers = (): ProviderView[] => [
  view('claude', { models: [{ id: 'sonnet', efforts: ['low', 'high'] }, { id: 'haiku', efforts: [] }], modes: ['ask', 'plan', 'full'] }),
  view('codex', { readiness: 'signedOut', models: [{ id: 'gpt-5', efforts: [] }] }),
  view('gone', { installed: false }),
  view('plain', { compacts: false }),
];
const task = (id: string, projectId: string, extra: Partial<PreviewTask> = {}): PreviewTask => ({
  id, projectId, harness: 'claude', model: 'sonnet', mode: 'ask', effort: null, team: null, connection: null, bot: null, stage: 'active', running: false, remote: false, target: 'local', resumeId: null, ...extra,
});
function controller(over: Partial<ControlWorld> = {}, tasks: PreviewTask[] = [task('t1', 'A'), task('t2', 'B'), task('t3', 'A', { running: true }), task('t4', 'A', { team: 'squad', running: true }), task('t5', 'A', { harness: 'plain' }), task('t6', 'A', { resumeId: 'r1' })]) {
  return new TaskController({ tasks, catalog: providers(), targets: ['studio'], compactCommands: ['claude'], teams: ['squad', 'review-squad'], connections: ['work-account'], bots: ['release-bot'], ...over });
}
const checks = (projects: readonly string[] = ['A', 'B']) => ({ granted: (project: string) => projects.includes(project), package: NAME });
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;

test('extensions runtime tasks control: the fixture package declares the permission and a service and uses the four calls', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.tasks.stop', 'panda.tasks.setMode', 'panda.tasks.configure', 'panda.tasks.compact', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package never pairs a machine, never asks for remote access and never names a credential.
  expect(fixtureSource).not.toMatch(/pair\b|remoteAccess|credentials\./i);
  // Councils, workers and limit pauses are R0404B: this slice has no call for them.
  expect(fixtureSource).not.toMatch(/council|worker|limit/i);
});

test('extensions runtime tasks control: every action runs the commands the interface runs, with the same arguments (the parity recording)', () => {
  expect(parity.cases.length).toBeGreaterThanOrEqual(15);
  const world: World = { taskProject: id => (id === 't1' ? 'A' : undefined), granted: () => true, holdsAny: () => true, targetPaired: target => target === 'studio' };
  for (const entry of parity.cases) {
    const spec = admit(world, entry.request);
    expect('code' in spec, entry.name).toBe(false);
    const commands = plan(spec as never, entry.task);
    expect(commands.map(command => ({ command: command.command, args: command.args })), entry.name).toEqual(entry.commands);
  }
  // The same commands, through the preview controller, are what a control records as run.
  const host = controller();
  expect(host.control(OWNER, checks(), { action: 'configure', taskId: 't1', change: { harness: 'claude', model: 'haiku', effort: null, connection: 'work-account', bot: 'release-bot', stage: 'completed' } })).toEqual({ ok: true, value: null });
  expect(host.commands.map(command => command.command)).toEqual(['configure_session', 'set_reasoning_effort', 'connection_assign', 'bot_assign_task', 'set_task_stage']);
  expect(host.task('t1')).toMatchObject({ model: 'haiku', effort: null, connection: 'work-account', bot: 'release-bot', stage: 'completed' });
});

test('extensions runtime tasks control: stop, mode and compact reach their operation and record the package that made them', () => {
  const host = controller();
  expect(host.control(OWNER, checks(), { action: 'stop', taskId: 't3' }).ok).toBe(true);
  expect(host.control(OWNER, checks(), { action: 'stop', taskId: 't4' }).ok).toBe(true);
  expect(host.commands.map(command => command.command)).toEqual(['stop_session', 'architect_control']);
  expect(host.task('t3')?.running).toBe(false);
  // The run's end reports who stopped it: the package, not the user.
  expect(host.events).toEqual([{ kind: 'task.stopped', taskId: 't3', projectId: 'A', by: { package: OWNER } }, { kind: 'task.stopped', taskId: 't4', projectId: 'A', by: { package: OWNER } }]);
  expect(host.control(OWNER, checks(), { action: 'setMode', taskId: 't1', mode: 'plan' }).ok).toBe(true);
  expect(host.task('t1')?.mode).toBe('plan');
  expect(host.control(OWNER, checks(), { action: 'compact', taskId: 't1' }).ok).toBe(true);
  expect(host.events.at(-1)).toEqual({ kind: 'task.compacted', taskId: 't1', projectId: 'A' });
  expect(host.log.snapshot()).toEqual({ revision: 4, controls: {
    t3: { action: 'stop', detail: { commands: ['stop_session'] }, owner: OWNER, package: NAME, at: 1 },
    t4: { action: 'stop', detail: { commands: ['architect_control'] }, owner: OWNER, package: NAME, at: 2 },
    t1: { action: 'compact', detail: { commands: ['send_message'] }, owner: OWNER, package: NAME, at: 4 },
  } });
  expect(host.log.forTask('t1').map(entry => entry.action)).toEqual(['setMode', 'compact']);
  // Stopping an idle task changes nothing and records nothing.
  const before = host.log.size;
  expect(host.control(OWNER, checks(), { action: 'stop', taskId: 't1' }).ok).toBe(true);
  expect(host.log.size).toBe(before);
});

test('extensions runtime tasks control: compaction needs a harness that answers it, and an unsupported harness is UnsupportedCapability', () => {
  const host = controller();
  expect(host.control(OWNER, checks(), { action: 'compact', taskId: 't5' })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'compact' } });
  expect(host.commands).toEqual([]);
  expect(checkCompact(providers(), 'claude')).toBeUndefined();
  expect(checkCompact(providers(), 'plain')).toMatchObject({ code: 'UnsupportedCapability' });
  expect(checkCompact(providers(), 'ghost')).toMatchObject({ code: 'NotFound' });
  // A harness whose catalog installs but whose command does not resolve is refused when the request runs, with nothing sent.
  const odd = controller({ compactCommands: [] });
  expect(code(odd.control(OWNER, checks(), { action: 'compact', taskId: 't1' }))).toBe('UnsupportedCapability');
  expect(odd.events).toEqual([]);
  // A running task cannot compact: the same refusal the composer gives, as Conflict.
  expect(code(host.control(OWNER, checks(), { action: 'compact', taskId: 't3' }))).toBe('Conflict');
});

test('extensions runtime tasks control: a hook cannot silently change the mode, and a service that does is recorded by name', () => {
  const host = controller();
  const refused = host.control(OWNER, checks(), { action: 'setMode', taskId: 't1', mode: 'full', source: 'hook' });
  expect(refused).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: 'setMode', ids: ['hook'] } });
  expect([host.task('t1')?.mode, host.log.size, host.commands.length]).toEqual(['ask', 0, 0]);
  expect(host.control(OWNER, checks(), { action: 'setMode', taskId: 't1', mode: 'full', source: 'service' }).ok).toBe(true);
  expect(host.log.forTask('t1')).toMatchObject([{ action: 'setMode', owner: OWNER, package: NAME }]);
  // Only the mode is kept out of a hook's hands: a hook that holds the grant may still stop.
  expect(host.control(OWNER, checks(), { action: 'stop', taskId: 't3', source: 'hook' }).ok).toBe(true);
  // A mode the harness does not offer is refused, naming `mode`.
  expect(host.control(OWNER, checks(), { action: 'setMode', taskId: 't1', mode: 'review' })).toMatchObject({ ok: false, error: { code: 'UnsupportedCapability', path: 'mode' } });
});

test('extensions runtime tasks control: configure covers harness, model, effort, team, connection, bot, target and stage with their refusals', () => {
  const host = controller();
  const configure = (taskId: string, change: Record<string, unknown>) => host.control(OWNER, checks(), { action: 'configure', taskId, change });
  expect(configure('t1', { harness: 'claude', model: 'sonnet', effort: 'high' }).ok).toBe(true);
  expect(configure('t1', { team: 'review-squad' }).ok).toBe(true);
  expect(host.task('t1')?.team).toBe('review-squad');
  expect(configure('t1', { team: null }).ok).toBe(true);
  expect(configure('t6', { target: 'studio' }).ok).toBe(false);
  expect(configure('t1', { target: 'studio' }).ok).toBe(true);
  expect(host.task('t1')).toMatchObject({ team: null, effort: 'high', target: 'studio' });
  // What does not exist is NotFound; a harness that is signed out or missing is HostUnavailable with its state.
  expect(configure('t1', { harness: 'ghost', model: 'm' })).toMatchObject({ ok: false, error: { code: 'NotFound', path: 'harness' } });
  expect(configure('t1', { model: 'opus' })).toMatchObject({ ok: false, error: { code: 'NotFound', path: 'model' } });
  expect(configure('t1', { harness: 'codex', model: 'gpt-5' })).toMatchObject({ ok: false, error: { code: 'HostUnavailable', ids: ['signedOut'] } });
  expect(configure('t1', { harness: 'gone', model: 'm' })).toMatchObject({ ok: false, error: { code: 'HostUnavailable', ids: ['unavailable'] } });
  expect(configure('t1', { model: 'sonnet', effort: 'max' })).toMatchObject({ ok: false, error: { code: 'InvalidShape', path: 'effort' } });
  expect(code(configure('t1', { team: 'ghost' }))).toBe('NotFound');
  expect(code(configure('t1', { connection: 'ghost' }))).toBe('NotFound');
  expect(code(configure('t1', { bot: 'ghost' }))).toBe('NotFound');
  expect(configure('t1', { target: 'stranger' })).toMatchObject({ ok: false, error: { code: 'NotFound', path: 'target' } });
  // A running agent blocks the changes the interface blocks (Stop first), as Conflict, naming what already ran in `ids`.
  expect(configure('t3', { model: 'haiku' })).toMatchObject({ ok: false, error: { code: 'Conflict', ids: [] } });
  expect(configure('t3', { bot: 'release-bot', stage: 'completed' })).toMatchObject({ ok: false, error: { code: 'Conflict', ids: ['bot_assign_task'] } });
  // Reopening a task clears its archive flag, as the stage menu does.
  host.task('t2')!.archived = true;
  expect(host.control(OWNER, checks(), { action: 'configure', taskId: 't2', change: { stage: 'active' } }).ok).toBe(true);
  expect(host.task('t2')?.archived).toBe(false);
});

test('extensions runtime tasks control: council, worker and limit actions have no call here and every shape is refused with its reason', () => {
  const world: World = { taskProject: () => 'A', granted: () => true, holdsAny: () => true, targetPaired: () => true };
  const bad: [unknown, string, string?][] = [
    ['text', 'InvalidShape'], [{ action: 'stop' }, 'InvalidShape'], [{ taskId: 't1' }, 'InvalidShape'], [{ action: 'council', taskId: 't1' }, 'InvalidShape'], [{ action: 'worker', taskId: 't1' }, 'InvalidShape'], [{ action: 'limit', taskId: 't1' }, 'InvalidShape'],
    [{ action: 'stop', taskId: 't1', mode: 'plan' }, 'InvalidShape'], [{ action: 'compact', taskId: 't1', change: {} }, 'InvalidShape'], [{ action: 'stop', taskId: 't1', extra: 1 }, 'InvalidShape'],
    [{ action: 'setMode', taskId: 't1' }, 'InvalidShape', 'mode'], [{ action: 'setMode', taskId: 't1', mode: 'yolo' }, 'InvalidShape', 'mode'], [{ action: 'setMode', taskId: 't1', mode: 'plan', change: {} }, 'InvalidShape'],
    [{ action: 'configure', taskId: 't1' }, 'InvalidShape', 'change'], [{ action: 'configure', taskId: 't1', change: {} }, 'InvalidShape', 'change'], [{ action: 'configure', taskId: 't1', change: { mode: 'plan' } }, 'InvalidShape', 'mode'],
    [{ action: 'configure', taskId: 't1', change: { council: 'accept' } }, 'InvalidShape', 'council'], [{ action: 'configure', taskId: 't1', change: { limit: 'continue' } }, 'InvalidShape', 'limit'],
    [{ action: 'configure', taskId: 't1', change: { harness: 'codex' } }, 'InvalidShape', 'model'], [{ action: 'configure', taskId: 't1', change: { model: null } }, 'InvalidShape', 'model'],
    [{ action: 'configure', taskId: 't1', change: { stage: 'archived' } }, 'InvalidShape', 'stage'], [{ action: 'configure', taskId: 't1', change: { stage: null } }, 'InvalidShape', 'stage'], [{ action: 'configure', taskId: 't1', change: { effort: 3 } }, 'InvalidShape', 'effort'],
    [{ action: 'stop', taskId: 't1', source: 'other' }, 'InvalidShape'], [{ action: 'stop', taskId: '' }, 'InvalidShape'],
  ];
  for (const [raw, expected, path] of bad) {
    const refusal = envelope(admit(world, raw) as never).error;
    expect([refusal.code, path === undefined ? undefined : refusal.path], JSON.stringify(raw)).toEqual([expected, path]);
  }
  expect(admit(world, { action: 'configure', taskId: 't1', change: { target: 'local' } })).toMatchObject({ change: { target: 'local' } });
});

test('extensions runtime tasks control: no grant, a narrowed project or a foreign project is PermissionDenied naming the permission, and nothing else leaks', () => {
  const host = controller();
  for (const projects of [[], ['B']]) {
    expect(host.control(OWNER, checks(projects), { action: 'stop', taskId: 't3' })).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
    expect(host.control(OWNER, checks(projects), { action: 'configure', taskId: 't3', change: { model: 'haiku' } })).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  }
  // A package with no grant at all is not told whether a task exists; one with a grant for some project is.
  expect(code(host.control(OWNER, checks([]), { action: 'stop', taskId: 'ghost' }))).toBe('PermissionDenied');
  for (const projects of [['A'], ['B']]) expect(code(host.control(OWNER, checks(projects), { action: 'stop', taskId: 'ghost' }))).toBe('NotFound');
  expect([host.commands.length, host.log.size, host.task('t3')?.running]).toEqual([0, 0, true]);
  // The grant is read again before anything changes: a revoke between admission and the first command changes nothing.
  let projects = ['A'];
  expect(host.control(OWNER, { granted: project => projects.includes(project), package: NAME }, { action: 'setMode', taskId: 't1', mode: 'plan' }, () => { projects = []; })).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  expect([host.task('t1')?.mode, host.commands.length, host.log.size]).toEqual(['ask', 0, 0]);
});

test('extensions runtime tasks control: the catalog checks, the host text mapping and the control ledger are the frozen ones', () => {
  const catalog = providers();
  expect(checkMode(catalog, 'claude', 'plan')).toBeUndefined();
  expect(checkMode(catalog, 'claude', 'review')).toMatchObject({ code: 'UnsupportedCapability', path: 'mode' });
  expect(checkMode(catalog, 'codex', 'review')).toBeUndefined();
  expect(checkChoice(catalog, 'claude', { model: 'haiku' })).toBeUndefined();
  expect(checkChoice(catalog, 'claude', { harness: 'codex', model: 'gpt-5' })).toMatchObject({ code: 'HostUnavailable', ids: ['signedOut'] });
  for (const [text, expected] of [['Stop the agent before changing its connection.', 'Conflict'], ['Start a conversation before compacting its context.', 'Conflict'], ['Unknown permission mode.', 'InvalidShape'], ['Unknown task.', 'NotFound'], ['disk on fire', 'HostUnavailable']]) expect(codeOf(text), text).toBe(expected);
  const ledger = new ControlLog();
  for (let index = 0; index < MAX_LOG + 5; index += 1) ledger.record({ taskId: index % 2 ? 'odd' : 'even', action: 'stop', detail: null, owner: OWNER, package: NAME, at: index });
  expect(ledger.size).toBe(MAX_LOG);
  expect(ledger.forget('odd')).toBe(true);
  expect(ledger.forget('odd')).toBe(false);
  expect(Object.keys(ledger.snapshot().controls)).toEqual(['even']);
  expect(label({ action: 'setMode', detail: null, package: NAME })).toBe('Mode set by Task controller');
});

test('extensions runtime tasks control: the host wires the call, the request, the label, the commands and the registrations', () => {
  const host = read('src-tauri/src/extensions/node-host.cjs');
  expect(host).toContain("rpc('tasksControl'");
  for (const call of ['stop', 'setMode', 'configure', 'compact']) expect(host, call).toContain(call);
  const lifetime = read('src-tauri/src/extensions/runtime_service_lifetime.rs');
  expect(lifetime).toContain('runtime_tasks_control::serve');
  const lib = read('src-tauri/src/lib.rs');
  for (const name of ['runtime_tasks_control::extensions_runtime_task_controls', 'runtime_tasks_control::ControlLog', 'runtime_tasks_control::task_removed']) expect(lib, name).toContain(name);
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_tasks_control');
  expect(read('src-tauri/src/extensions/runtime_workspace_events.rs')).toContain('runtime_tasks_control::take_stopper');
  const sdk = read('src/extensions/sdk/index.d.ts');
  for (const call of ['stop(taskId', 'setMode(taskId', 'configure(taskId', 'compact(taskId']) expect(sdk, call).toContain(call);
  expect(sdk.slice(sdk.indexOf('interface TasksApi'), sdk.indexOf('interface TasksApi') + 4000)).not.toMatch(/pair|remoteAccess/i);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-tasks-control.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

type Seams = { __runtimeTaskTarget?: { answer(event: unknown): Promise<void> }; __runtimeTaskControls?: { set(controls: Record<string, unknown>): void }; __runtimeTaskDefaultsAnswers?: { id: string; answer: Record<string, unknown> }[] };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeTaskTarget && (window as unknown as Seams).__runtimeTaskControls))).toBe(true);
}

test('extensions runtime tasks control: the window answers a Run on choice only for the open new conversation, and a package name marks the thread header', async ({ page }) => {
  await setup(page);
  await page.evaluate(() => (window as unknown as Seams).__runtimeTaskTarget!.answer({ id: 'c1', taskId: 'no-such-task', target: 'local' }));
  const answers = await page.evaluate(() => (window as unknown as Seams).__runtimeTaskDefaultsAnswers ?? []);
  expect(answers.map(entry => entry.id)).toEqual(['c1']);
  // A task that is not the open new conversation cannot be moved: Conflict (the host's own Run on belongs to the first message).
  expect(answers[0].answer).toMatchObject({ ok: false, code: expect.stringMatching(/^(Conflict|NotFound)$/) });
  const rows = page.locator('.task-item[data-id]');
  const id = await rows.first().getAttribute('data-id');
  expect(id).toBeTruthy();
  await rows.first().click();
  await page.evaluate(({ id }) => (window as unknown as Seams).__runtimeTaskControls!.set({ [id!]: { action: 'setMode', detail: null, owner: 'sample.runtime-tasks-control', package: 'Task controller', at: 1 } }), { id });
  await expect(page.locator('.runtime-task-control')).toHaveText('Mode set by Task controller');
  await page.evaluate(() => (window as unknown as Seams).__runtimeTaskControls!.set({}));
  await expect(page.locator('.runtime-task-control')).toHaveCount(0);
});

test('extensions runtime tasks control: the header label is idempotent', () => {
  const root = document_like();
  const controls = { t1: { action: 'stop', detail: null, owner: OWNER, package: NAME, at: 1 } };
  expect(decorate(root, controls, 't1')).toBe(1);
  expect(decorate(root, controls, 't1')).toBe(0);
  expect(decorate(root, controls, null)).toBe(1);
  expect(decorate(root, controls, null)).toBe(0);
});

/** A tiny DOM stand-in with the one header the label needs, so the idempotence rule is checked without a browser. */
function document_like(): ParentNode {
  const chips: { className: string; dataset: Record<string, string>; textContent: string; remove(): void }[] = [];
  const parent = {
    querySelector: (selector: string) => (selector.includes('runtime-task-control') ? chips[0] ?? null : null),
  };
  const crumb = {
    parentElement: parent,
    ownerDocument: { createElement: () => { const chip = { className: '', dataset: {} as Record<string, string>, textContent: '', remove() { chips.splice(chips.indexOf(chip), 1); } }; return chip; } },
    after: (chip: never) => { chips.push(chip); },
  };
  return { querySelector: (selector: string) => (selector === '#breadcrumb' ? crumb : null) } as unknown as ParentNode;
}
