import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { MAX_ATTACHMENTS, MAX_ORIGINS, MAX_WAITING, PERMISSION, PROMPT_BYTES, StartSlots, TITLE_CHARS, TaskOrigins, TaskStarter, admit, branchName, codeOf, envelope, readDefaults, resolveDefaults, type Catalog, type CatalogProvider, type StartWorld } from '../src/extensions/runtime-tasks-start';

// Preview column of R0401 (attributed task start). The first group runs the deterministic model in
// src/extensions/runtime-tasks-start.ts, which mirrors src-tauri/src/extensions/runtime_tasks_start.rs (whose own unit
// tests are `runtime_tasks_start::tests`); the last group drives the main window's half in the preview app. The installed
// service starting the scripted ACP agent (B5, R0801's declared launch) is the native test
// `runtime_service_lifetime::tests::installed::tasks_start_*` (feature extension-runtime-native-tests), reported in its own
// column: this file claims only the preview and model column.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-tasks-start/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-tasks-start/main.cjs');
const OWNER = 'sample.runtime-tasks-start';
const NAME = 'Task starter';
const FAKE = 'sample.launch-agent/fake';

const provider = (id: string, extra: Partial<CatalogProvider> = {}): CatalogProvider => ({ id, installed: true, ...extra });
const fake = (state: 'ready' | 'signedOut' | 'unavailable' = 'ready'): CatalogProvider => provider(FAKE, { models: [{ id: 'fake-1' }], metadata: { modes: ['ask'], readiness: { state } } });
function catalog(over: Partial<Catalog> = {}, providers: CatalogProvider[] = [provider('claude'), fake()]): Catalog {
  return { providers, defaultProvider: 'claude', rememberedModel: id => (id === 'claude' ? 'sonnet' : 'fake-1'), initialMode: id => (id.includes('/') ? 'ask' : 'full'), ...over };
}
function starter(over: Partial<StartWorld> = {}, cat: Catalog = catalog()) {
  return new TaskStarter({ projects: ['A', 'B'], catalog: cat, worktrees: ['feature/x'], targets: ['studio'], ...over });
}
const checks = (projects: readonly string[] = ['A', 'B']) => ({ granted: (project: string) => projects.includes(project), package: NAME });
const code = (reply: { ok: boolean; error?: { code: string } }) => reply.ok ? 'ok' : reply.error!.code;

test('extensions runtime tasks start: the fixture package declares the permission and a service and uses the call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['panda.tasks.start', "worktree: 'new'", 'steps', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package never pairs a machine and never asks for remote access.
  expect(fixtureSource).not.toMatch(/pair|remoteAccess|credentials/i);
});

test('extensions runtime tasks start: a granted package starts a task with prompt, title and a new worktree, on the user defaults', () => {
  const host = starter();
  const reply = host.start(OWNER, checks(), { projectId: 'A', prompt: 'Fix T-12', title: 'Fix T-12', worktree: 'new' });
  expect(reply.ok && reply.value).toMatchObject({ projectId: 'A', worktree: expect.stringMatching(/^pandacode\/fix-t-12-[a-z0-9]+$/) });
  const task = host.tasks[0];
  // The harness, model and mode are what the user would get for a new task: the default provider's remembered model and initial mode.
  expect([task.harness, task.model, task.mode, task.title, task.prompt, task.effort, task.target]).toEqual(['claude', 'sonnet', 'full', 'Fix T-12', 'Fix T-12', null, null]);
  expect(host.events).toEqual([{ kind: 'task.created', taskId: task.id, projectId: 'A', harness: 'claude', startedBy: { package: OWNER } }]);
  // The current checkout is the default, and an existing branch is reused.
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go' })).toMatchObject({ ok: true, value: { worktree: null } });
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', worktree: 'feature/x' })).toMatchObject({ ok: true, value: { worktree: 'feature/x' } });
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', worktree: 'feature/gone' })).toMatchObject({ ok: false, error: { code: 'NotFound' } });
  expect(host.tasks).toHaveLength(3);
});

test('extensions runtime tasks start: the scripted fake harness starts with its own model and mode, and explicit choices win over the defaults', () => {
  const host = starter();
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', harness: FAKE })).toMatchObject({ ok: true });
  expect([host.tasks[0].harness, host.tasks[0].model, host.tasks[0].mode]).toEqual([FAKE, 'fake-1', 'ask']);
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', harness: 'claude', model: 'opus', effort: 'high', mode: 'plan' })).toMatchObject({ ok: true });
  expect([host.tasks[1].harness, host.tasks[1].model, host.tasks[1].mode, host.tasks[1].effort]).toEqual(['claude', 'opus', 'plan', 'high']);
  // A package harness takes only the modes and models it declares.
  expect(code(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', harness: FAKE, mode: 'full' }))).toBe('InvalidShape');
  expect(code(host.start(OWNER, checks(), { projectId: 'A', prompt: 'go', harness: FAKE, model: 'other' }))).toBe('NotFound');
  expect(host.tasks).toHaveLength(2);
});

test('extensions runtime tasks start: the source package appears in the sidebar row, the thread header and the history, and survives the package', () => {
  const host = starter();
  host.start(OWNER, checks(), { projectId: 'A', prompt: 'one', title: 'One' });
  host.start('sample.other', { ...checks(), package: 'Other starter' }, { projectId: 'B', prompt: 'two' });
  expect(host.row('task-1')).toEqual({ id: 'task-1', title: 'One', startedBy: NAME });
  expect(host.row('task-2')?.startedBy).toBe('Other starter');
  expect(host.origins.snapshot()).toEqual({ revision: 2, origins: { 'task-1': { owner: OWNER, package: NAME, projectId: 'A' }, 'task-2': { owner: 'sample.other', package: 'Other starter', projectId: 'B' } } });
  // A deleted task loses its label; a second record of a task keeps the first starter.
  expect(host.origins.forget('task-2')).toBe(true);
  host.origins.record('task-1', { owner: 'sample.other', package: 'Late', projectId: 'A', at: 99 });
  expect(host.origins.get('task-1')?.package).toBe(NAME);
});

test('extensions runtime tasks start: no grant, a narrowed project, an unknown project, a missing or signed-out harness create no task', () => {
  const host = starter({}, catalog({}, [provider('claude'), fake('signedOut'), provider('gone', { installed: false })]));
  const request = { projectId: 'A', prompt: 'go' };
  // No grant at all, and a grant narrowed to another project, are the permission itself; the permission name is in `path`.
  for (const projects of [[], ['B']]) {
    const reply = host.start(OWNER, checks(projects), request);
    expect(reply).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
    // The grant answers first: nothing else about the request leaks through a refusal.
    expect(code(host.start(OWNER, checks(projects), { projectId: 'ghost', prompt: 'go', target: 'nobody' }))).toBe('PermissionDenied');
  }
  expect(code(host.start(OWNER, { ...checks(), granted: () => true }, { projectId: 'ghost', prompt: 'go' }))).toBe('NotFound');
  // A harness the catalog does not know, one that is not installed, one that is signed out.
  expect(host.start(OWNER, checks(), { ...request, harness: 'nobody/home' })).toMatchObject({ ok: false, error: { code: 'NotFound', ids: [] } });
  expect(host.start(OWNER, checks(), { ...request, harness: 'gone' })).toMatchObject({ ok: false, error: { code: 'HostUnavailable', ids: ['unavailable'] } });
  expect(host.start(OWNER, checks(), { ...request, harness: FAKE })).toMatchObject({ ok: false, error: { code: 'HostUnavailable', ids: ['signedOut'] } });
  // Not one of them made a task, a label or an event.
  expect([host.tasks.length, host.origins.size, host.events.length]).toEqual([0, 0, 0]);
});

test('extensions runtime tasks start: a revoke or narrowing between the defaults and the creation creates nothing', () => {
  const host = starter();
  let projects = ['A'];
  const reply = host.start(OWNER, { granted: project => projects.includes(project), package: NAME }, { projectId: 'A', prompt: 'go' }, () => { projects = []; });
  expect(reply).toMatchObject({ ok: false, error: { code: 'PermissionDenied', path: PERMISSION } });
  expect([host.tasks.length, host.origins.size]).toEqual([0, 0]);
  // A worktree that cannot be made leaves no task behind either, and says why without its text.
  const failing = starter({ failCreate: () => 'Branch pandacode/x already exists. Use the existing branch.' });
  expect(failing.start(OWNER, checks(), { projectId: 'A', prompt: 'go', worktree: 'new' })).toMatchObject({ ok: false, error: { code: 'Conflict' } });
  expect(failing.tasks).toEqual([]);
});

test('extensions runtime tasks start: a bot or channel project keeps its pinned identity and defaults, over the user defaults and under the request', () => {
  const pinned = catalog({ pinned: project => project === 'B' ? { harness: FAKE, model: 'fake-1', mode: 'ask', bot: 'release-bot', channel: 'releases' } : undefined });
  const host = starter({}, pinned);
  expect(host.start(OWNER, checks(), { projectId: 'B', prompt: 'ship it' })).toMatchObject({ ok: true });
  expect(host.tasks[0]).toMatchObject({ harness: FAKE, model: 'fake-1', mode: 'ask', bot: 'release-bot', channel: 'releases' });
  // A plain project is untouched by another project's pin; an explicit harness beats the pin and its model.
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'plain' })).toMatchObject({ ok: true });
  expect(host.tasks[1]).toMatchObject({ harness: 'claude', model: 'sonnet', bot: null, channel: null });
  expect(host.start(OWNER, checks(), { projectId: 'B', prompt: 'explicit', harness: 'claude' })).toMatchObject({ ok: true });
  expect(host.tasks[2]).toMatchObject({ harness: 'claude', model: 'sonnet', mode: 'full', bot: 'release-bot' });
});

test('extensions runtime tasks start: a paired target keeps identity and defaults, and pairing or remote access has no call', () => {
  const host = starter();
  expect(host.start(OWNER, checks(), { projectId: 'A', prompt: 'remote run', target: 'studio', worktree: 'new', title: 'Remote' })).toMatchObject({ ok: true });
  expect(host.tasks[0]).toMatchObject({ target: 'studio', harness: 'claude', model: 'sonnet', mode: 'full', startedBy: { package: NAME, owner: OWNER } });
  expect(host.origins.get('task-1')?.package).toBe(NAME);
  // A machine that is not paired is unknown. The call takes no option that pairs or grants access.
  expect(code(host.start(OWNER, checks(), { projectId: 'A', prompt: 'x', target: 'stranger' }))).toBe('NotFound');
  for (const option of ['pair', 'pairWith', 'remoteAccess', 'grantRemoteAccess', 'device', 'invite']) expect(code(host.start(OWNER, checks(), { projectId: 'A', prompt: 'x', [option]: 'studio' })), option).toBe('InvalidShape');
  expect(host.tasks).toHaveLength(1);
  // The service host and the SDK expose only `start` here: nothing in them names pairing.
  const sdk = read('src/extensions/sdk/index.d.ts');
  expect(sdk).toContain('tasks:');
  expect(sdk.slice(sdk.indexOf('interface TasksApi'), sdk.indexOf('interface TasksApi') + 1500)).not.toMatch(/pair|remoteAccess/i);
});

test('extensions runtime tasks start: shapes and sizes are refused with their own reasons', () => {
  const world = { granted: () => true, projectExists: () => true, targetPaired: () => true };
  const bad: [unknown, string][] = [
    ['text', 'InvalidShape'], [{ prompt: 'x' }, 'InvalidShape'], [{ projectId: 'A' }, 'InvalidShape'], [{ projectId: 'A', prompt: '  ' }, 'InvalidShape'], [{ projectId: 'A', prompt: 'x', mode: 'yolo' }, 'InvalidShape'],
    [{ projectId: 'A', prompt: 'x', worktree: '../x' }, 'InvalidShape'], [{ projectId: 'A', prompt: 'x', worktree: 3 }, 'InvalidShape'], [{ projectId: 'A', prompt: 'x', attachments: 'a' }, 'InvalidShape'],
    [{ projectId: 'A', prompt: 'x'.repeat(PROMPT_BYTES + 1) }, 'LimitExceeded'], [{ projectId: 'A', prompt: 'x', title: 't'.repeat(TITLE_CHARS + 1) }, 'LimitExceeded'], [{ projectId: 'A', prompt: 'x', attachments: Array(MAX_ATTACHMENTS + 1).fill('a') }, 'LimitExceeded'],
  ];
  for (const [raw, expected] of bad) expect(envelope(admit(world, raw) as never).error.code, JSON.stringify(raw).slice(0, 80)).toBe(expected);
  expect(admit(world, { projectId: 'A', prompt: 'x', attachments: ['img-1'], worktree: 'current' })).toMatchObject({ attachments: ['img-1'], worktree: { kind: 'current' } });
});

test('extensions runtime tasks start: the window answer, the defaults resolution and the branch name are the frozen ones', () => {
  expect(readDefaults({ ok: true, harness: 'claude', model: 'sonnet', mode: 'full', effort: 'high' })).toEqual({ harness: 'claude', model: 'sonnet', mode: 'full', effort: 'high' });
  expect(readDefaults({ ok: false, code: 'HostUnavailable', state: 'signedOut' })).toMatchObject({ code: 'HostUnavailable', ids: ['signedOut'] });
  expect(readDefaults({ ok: false, code: 'HostUnavailable' })).toMatchObject({ ids: ['unavailable'] });
  for (const bad of [{ ok: true, harness: 'claude', model: 'm', mode: 'yolo' }, { ok: true }, { ok: false, code: 'Explode' }, null]) expect(readDefaults(bad), JSON.stringify(bad)).toMatchObject({ code: 'InvalidShape' });
  // The first installed harness stands in when the default one is not installed.
  expect(resolveDefaults(catalog({ defaultProvider: 'missing' }), { projectId: 'A' })).toMatchObject({ ok: true, harness: 'claude' });
  expect(resolveDefaults(catalog({}, []), { projectId: 'A' })).toEqual({ ok: false, code: 'NotFound' });
  expect(branchName('Fix the T-12 flaky login test, please!', 'ab12-cd34-ef56')).toBe('pandacode/fix-the-t-12-flaky-login-test-please-ab12cd');
  expect(branchName('!!!', 'xyz')).toBe('pandacode/xyz');
  expect(branchName('same', 'aaaaaa')).not.toBe(branchName('same', 'bbbbbb'));
  for (const [text, expected] of [['Branch x already exists.', 'Conflict'], ['Branch x does not exist yet.', 'NotFound'], ['Unknown permission mode.', 'InvalidShape'], ['disk on fire', 'HostUnavailable']]) expect(codeOf(text), text).toBe(expected);
});

test('extensions runtime tasks start: waiting starts are four per package, answered once, and end with the service', async () => {
  const slots = new StartSlots();
  const open = Array.from({ length: MAX_WAITING }, () => slots.begin(OWNER));
  expect(open.every(entry => entry.ok)).toBe(true);
  expect(code(slots.begin(OWNER))).toBe('LimitExceeded');
  expect(slots.begin('sample.other').ok).toBe(true);
  const first = open[0] as Extract<(typeof open)[number], { ok: true }>;
  expect(slots.answer(first.value.id, { ok: true })).toEqual({ ok: true, value: null });
  await expect(first.value.answer).resolves.toEqual({ ok: true });
  expect(code(slots.answer(first.value.id, { ok: true }))).toBe('NotFound');
  expect(slots.cancelOwner(OWNER)).toBe(MAX_WAITING - 1);
  await expect((open[1] as typeof first).value.answer).resolves.toEqual({ ok: false, code: 'Revoked' });
  expect([slots.count(OWNER), slots.count('sample.other')]).toEqual([0, 1]);
});

test('extensions runtime tasks start: the origins ledger is bounded and drops its oldest label first', () => {
  const ledger = new TaskOrigins();
  for (let index = 0; index < MAX_ORIGINS + 5; index += 1) ledger.record(`t${index}`, { owner: OWNER, package: NAME, projectId: 'A', at: index });
  expect([ledger.size, ledger.get('t0'), ledger.get(`t${MAX_ORIGINS + 4}`)?.package]).toEqual([MAX_ORIGINS, undefined, NAME]);
});

test('extensions runtime tasks start: the host wires the call, the request, the cleanup, the commands and the registrations', () => {
  const host = read('src-tauri/src/extensions/node-host.cjs');
  expect(host).toContain("rpc('tasksStart'");
  const lifetime = read('src-tauri/src/extensions/runtime_service_lifetime.rs');
  expect(lifetime).toContain('runtime_tasks_start::serve');
  expect(lifetime).toContain('runtime_tasks_start::service_stopped');
  const lib = read('src-tauri/src/lib.rs');
  for (const name of ['runtime_tasks_start::extensions_runtime_task_defaults_answer', 'runtime_tasks_start::extensions_runtime_task_origins', 'runtime_tasks_start::TaskOrigins::open', 'runtime_tasks_start::StartSlots']) expect(lib, name).toContain(name);
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_tasks_start');
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-tasks-start.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

type Seams = { __runtimeTaskStart?: { answer(event: unknown): Promise<void> }; __runtimeTaskOrigins?: { set(origins: Record<string, unknown>): void }; __runtimeTaskDefaultsAnswers?: { id: string; answer: Record<string, unknown> }[] };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeTaskStart && (window as unknown as Seams).__runtimeTaskOrigins))).toBe(true);
}

test('extensions runtime tasks start: the window answers a start with the user defaults, and an unknown harness with the frozen error', async ({ page }) => {
  await setup(page);
  const project = await page.evaluate(() => document.querySelector<HTMLElement>('.task-item[data-id]')?.dataset.id ?? '');
  expect(project).not.toBe('');
  await page.evaluate(() => (window as unknown as Seams).__runtimeTaskStart!.answer({ id: 's1', projectId: 'p', harness: undefined }));
  await page.evaluate(() => (window as unknown as Seams).__runtimeTaskStart!.answer({ id: 's2', projectId: 'p', harness: 'nobody/home' }));
  const answers = await page.evaluate(() => (window as unknown as Seams).__runtimeTaskDefaultsAnswers ?? []);
  expect(answers.map(entry => entry.id)).toEqual(['s1', 's2']);
  expect(answers[0].answer).toMatchObject({ ok: true, harness: expect.any(String), model: expect.any(String), mode: expect.stringMatching(/^(ask|auto|review|plan|full)$/) });
  expect(answers[1].answer).toEqual({ ok: false, code: 'NotFound' });
});

test('extensions runtime tasks start: the package name marks the sidebar row and the thread header, and only a started task', async ({ page }) => {
  await setup(page);
  const rows = page.locator('.task-item[data-id]');
  const id = await rows.first().getAttribute('data-id');
  const other = await rows.nth(1).getAttribute('data-id');
  expect(id && other).toBeTruthy();
  await page.evaluate(({ id }) => (window as unknown as Seams).__runtimeTaskOrigins!.set({ [id!]: { owner: 'sample.runtime-tasks-start', package: 'Task starter', projectId: 'p' } }), { id });
  await expect(rows.first().locator('.runtime-task-origin')).toHaveText('Task starter');
  await expect(rows.nth(1).locator('.runtime-task-origin')).toHaveCount(0);
  // The label follows the row through the sidebar's own redraws, and leaves when the ledger no longer holds the task.
  await rows.first().click();
  await expect(page.locator('.runtime-task-origin-header')).toHaveText('Started by Task starter');
  await page.evaluate(() => (window as unknown as Seams).__runtimeTaskOrigins!.set({}));
  await expect(page.locator('.runtime-task-origin')).toHaveCount(0);
  await expect(page.locator('.runtime-task-origin-header')).toHaveCount(0);
});
