import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { CHECKS, MANAGE, MAX_CHECKS, MAX_WAITING, SPECS, CheckGate, ConfirmSlots, WorkspaceManager, admit, branchOk, codeOf, confirmation, envelope, refOk, specOf, type Checks, type Reply, type WorkspaceWorld } from '../src/extensions/runtime-workspace-projects';

// Preview column of R0405 (projects, worktrees, branches, tasks and pulls, and the project checks). The first groups run
// the deterministic model in src/extensions/runtime-workspace-projects.ts, which mirrors
// src-tauri/src/extensions/runtime_workspace_projects.rs (whose own unit tests are `runtime_workspace_projects::tests`);
// the last group drives the main window's half in the preview app. A real service calling the real commands over a
// temporary fixture project is the native fixture's column, never claimed here.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-workspace-projects/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-workspace-projects/main.cjs');
const OWNER = 'sample.runtime-workspace-projects';
const NAME = 'Workspace manager';

function world(over: Partial<WorkspaceWorld> = {}): WorkspaceWorld {
  return {
    projects: [{ id: 'A', name: 'alpha', path: '/work/alpha' }, { id: 'B', name: 'beta', path: '/work/beta' }, { id: 'C', name: 'gamma', path: '/work/gamma' }],
    tasks: [
      { id: 't1', projectId: 'A', title: 'First' },
      { id: 't2', projectId: 'B', title: 'Second' },
      { id: 'ta', projectId: 'A', title: 'Alpha task' },
      { id: 'tw', projectId: 'A', title: 'Worktree task', worktreeBranch: 'pandacode/wt' },
      { id: 'tw2', projectId: 'A', title: 'Second worktree task', worktreeBranch: 'pandacode/wt2' },
      { id: 'tp', projectId: 'A', title: 'Linked task', pull: { number: 12, url: 'https://github.com/o/r/pull/12', title: 'Fix it', state: 'open' } },
      { id: 'tr', projectId: 'A', title: 'Running', running: true },
      { id: 'tm', projectId: 'A', title: 'Mirrored', remote: true },
    ],
    branches: { A: { current: 'main', list: ['main', 'topic', 'new-topic', 'pandacode/wt', 'pandacode/wt2'] }, B: { current: 'main', list: ['main'] } },
    pulls: { '#12': { number: 12, url: 'https://github.com/o/r/pull/12', title: 'Fix it', state: 'open' } },
    checks: { A: { checked: true, name: 'npm test', ok: true, output: '', truncated: false } },
    folders: ['/work/new', '/work/moved', '/work/alpha'],
    ...over,
  };
}
const allow = (projects: readonly string[] | null = null, permissions: readonly string[] = [MANAGE, CHECKS]) => (permission: string, project: string | null) => permissions.includes(permission) && (projects === null || (project !== null && projects.includes(project)));
const checks = (over: Partial<Checks> = {}): Checks => ({ granted: allow(), package: NAME, confirms: true, answer: () => true, ...over });
const code = (reply: Reply<unknown>) => (reply.ok ? 'ok' : reply.error.code);
const path = (reply: Reply<unknown>) => (reply.ok ? '' : reply.error.path);

/** One allowed call per method with the input the native shape takes. */
const SAMPLES: Record<string, unknown> = {
  'projects.add': { path: '/work/new' },
  'projects.remove': { projectId: 'C' },
  'projects.rename': { projectId: 'A', name: 'Renamed' },
  'projects.relink': { projectId: 'B', path: '/work/moved' },
  'worktrees.create': { taskId: 't1', branch: 'feature/x', base: 'main' },
  'worktrees.remove': { worktreeId: 'tw', deleteBranch: true },
  'worktrees.recreate': { worktreeId: 'tw2' },
  'worktrees.merge': { worktreeId: 'tw2' },
  'branches.create': { projectId: 'A', name: 'fresh-topic', from: 'main', switch: true },
  'branches.switch': { projectId: 'A', branch: 'topic' },
  'branches.rename': { projectId: 'A', from: 'topic', to: 'topic-2' },
  'branches.remove': { projectId: 'A', branch: 'new-topic' },
  'tasks.remove': { taskId: 't2' },
  'tasks.rename': { taskId: 't1', title: 'A new title' },
  'tasks.move': { taskId: 't1', projectId: 'B' },
  'pulls.link': { taskId: 't1', reference: '#12' },
  'pulls.unlink': { taskId: 't1' },
  'pulls.check': { taskId: 'tp' },
  'pulls.merge': { taskId: 'tp', method: 'squash' },
  'projects.checks.run': { taskId: 'ta' },
};
const run = (host: WorkspaceManager, call: string, input: unknown, over: Partial<Checks> = {}) => host.call(OWNER, checks(over), call, input);

test('extensions runtime workspace projects: the fixture package declares both permissions and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', MANAGE, CHECKS]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const spec of SPECS) {
    const [family, name] = spec.call.split('.');
    expect(fixtureSource, spec.call).toContain(spec.call === CHECKS ? 'panda.projects.checks.run' : `workspace.${family}.${name}(`);
  }
  // The package never pairs a machine, never asks for remote access and never names a credential.
  expect(fixtureSource).not.toMatch(/pair\(|remoteAccess|credentials/i);
});

test('extensions runtime workspace projects: all nineteen calls and the check have one native shape and one allowed call, and nothing is left to the host', async () => {
  expect(SPECS).toHaveLength(20);
  expect(Object.keys(SAMPLES).sort()).toEqual(SPECS.map(spec => spec.call).sort());
  const host = new WorkspaceManager(world());
  const results: Record<string, unknown> = {};
  for (const spec of SPECS) {
    const reply = await run(host, spec.call, SAMPLES[spec.call]);
    expect(reply.ok, `${spec.call}: ${code(reply)}`).toBe(true);
    results[spec.call] = reply.ok ? reply.value : null;
  }
  expect(results['projects.add']).toEqual({ projectId: expect.any(String), name: 'new' });
  expect(results['projects.rename']).toEqual({ projectId: 'A', name: 'Renamed' });
  expect(results['projects.relink']).toEqual({ projectId: 'B', name: 'moved' });
  expect(results['worktrees.create']).toMatchObject({ projectId: 'A', branch: 'pandacode/feature/x' });
  expect(results['worktrees.remove']).toEqual({ removed: true, branch: 'pandacode/wt', branchDeleted: true, note: '' });
  expect(results['branches.create']).toMatchObject({ current: 'fresh-topic' });
  expect(results['branches.rename']).toMatchObject({ branches: expect.arrayContaining(['topic-2']) });
  expect(results['tasks.remove']).toEqual({ taskIds: ['t2'] });
  expect(results['tasks.move']).toEqual({ taskId: 't1', projectId: 'B' });
  expect(results['pulls.link']).toEqual({ number: 12, url: 'https://github.com/o/r/pull/12', title: 'Fix it', state: 'open' });
  expect(results['pulls.merge']).toMatchObject({ number: 12, state: 'merged' });
  expect(results['projects.checks.run']).toEqual({ schemaVersion: 1, report: { checked: true, name: 'npm test', ok: true, output: '', truncated: false } });
  // A call outside the vocabulary has no adapter: pairing a machine and remote access stay with the user.
  for (const name of ['projects.pair', 'workspace.pair', 'remote.access', 'machines.pair', 'projects.trust']) expect(code(await run(host, name, {})), name).toBe('UnsupportedCapability');
});

test('extensions runtime workspace projects: the grant answers first, per project, and a refused call changes nothing', async () => {
  const host = new WorkspaceManager(world());
  const narrowed = { granted: allow(['A']) };
  for (const [call, input] of [['tasks.rename', { taskId: 't2', title: 'x' }], ['projects.remove', { projectId: 'B' }], ['branches.switch', { projectId: 'B', branch: 'main' }], ['pulls.check', { taskId: 't2' }], ['projects.checks.run', { taskId: 't2' }], ['projects.add', { path: '/work/new' }]] as const) {
    const reply = await run(host, call, input, narrowed);
    expect([code(reply), path(reply)], call).toEqual(['PermissionDenied', specOf(call)!.permission]);
  }
  // The grant answers before the project is looked up: a ghost id leaks nothing to a narrowed package, and is NotFound for a full one.
  expect(code(await run(host, 'tasks.remove', { taskId: 'ghost' }, narrowed))).toBe('PermissionDenied');
  expect(code(await run(host, 'tasks.remove', { taskId: 'ghost' }))).toBe('NotFound');
  expect(code(await run(host, 'projects.remove', { projectId: 'ghost' }, narrowed))).toBe('PermissionDenied');
  expect(code(await run(host, 'projects.remove', { projectId: 'ghost' }))).toBe('NotFound');
  // Moving a task needs both projects; the two permissions are independent.
  expect(code(await run(host, 'tasks.move', { taskId: 't1', projectId: 'B' }, narrowed))).toBe('PermissionDenied');
  expect(code(await run(host, 'tasks.move', { taskId: 't1', projectId: 'ghost' }))).toBe('NotFound');
  expect(code(await run(host, 'projects.checks.run', { taskId: 't1' }, { granted: allow(null, [MANAGE]) }))).toBe('PermissionDenied');
  expect(code(await run(host, 'tasks.rename', { taskId: 't1', title: 'x' }, { granted: allow(null, [CHECKS]) }))).toBe('PermissionDenied');
  expect(host.world.tasks.find(task => task.id === 't1')!.title).toBe('First');
  expect(host.world.tasks.find(task => task.id === 't2')!.projectId).toBe('B');
  expect(host.world.projects).toHaveLength(3);
  expect(host.events).toEqual([]);
  // A revoke or a narrowing between admission and the change changes nothing.
  let revoked = false;
  const racing = checks({ granted: (permission, project) => !revoked && allow()(permission, project) });
  expect(code(await host.call(OWNER, racing, 'tasks.rename', { taskId: 't1', title: 'Late' }, () => { revoked = true; }))).toBe('PermissionDenied');
  expect(host.world.tasks.find(task => task.id === 't1')!.title).toBe('First');
});

test('extensions runtime workspace projects: shapes are refused with their reason and a pairing, trust or confirmation key is never read', async () => {
  const host = new WorkspaceManager(world());
  const cases: [string, unknown, string][] = [
    ['projects.add', 'C:/x', 'InvalidShape'], ['projects.add', {}, 'InvalidShape'], ['projects.add', { path: 3 }, 'InvalidShape'], ['projects.add', { path: '/work/new', pair: 'studio' }, 'InvalidShape'],
    ['projects.add', { path: '/work/new', remoteAccess: true }, 'InvalidShape'], ['projects.add', { path: '/work/new', trusted: true }, 'InvalidShape'], ['projects.add', { path: 'x'.repeat(4097) }, 'LimitExceeded'],
    ['projects.rename', { projectId: 'A', name: 'a\nb' }, 'InvalidShape'], ['projects.rename', { projectId: 'A', name: 'n'.repeat(201) }, 'LimitExceeded'],
    ['projects.remove', { projectId: '' }, 'InvalidShape'], ['projects.remove', { projectId: 7 }, 'InvalidShape'], ['projects.remove', { projectId: 'B', confirmed: true }, 'InvalidShape'],
    ['worktrees.create', { taskId: 't1', branch: '../evil' }, 'InvalidShape'], ['worktrees.create', { taskId: 't1', branch: 'ok', base: '--upload-pack=x' }, 'InvalidShape'], ['worktrees.create', { taskId: 't1', branch: 'ok', existing: 'yes' }, 'InvalidShape'],
    ['branches.create', { projectId: 'A', name: '-D' }, 'InvalidShape'], ['branches.create', { projectId: 'A', name: 'a b' }, 'InvalidShape'], ['branches.create', { projectId: 'A', name: 'x.lock' }, 'InvalidShape'],
    ['branches.rename', { projectId: 'A', from: 'a', to: 'a' }, 'InvalidShape'], ['branches.remove', { projectId: 'A', branch: 'topic', force: 'yes' }, 'InvalidShape'],
    ['tasks.rename', { taskId: 't1', title: ' ' }, 'InvalidShape'], ['tasks.rename', { taskId: 't1', title: 't'.repeat(201) }, 'LimitExceeded'],
    ['pulls.link', { taskId: 't1', reference: 'r'.repeat(513) }, 'LimitExceeded'], ['pulls.merge', { taskId: 't1', method: 'fast-forward' }, 'InvalidShape'],
    ['projects.checks.run', { taskId: 't1', command: 'rm -rf /' }, 'InvalidShape'], ['projects.checks.run', {}, 'InvalidShape'],
  ];
  for (const [call, input, expected] of cases) expect(code(await run(host, call, input)), `${call} ${JSON.stringify(input)}`).toBe(expected);
  for (const good of ['main', 'feature/x', 'pandacode/fix-12', 'release_1.2']) expect(branchOk(good), good).toBe(true);
  for (const bad of ['', '-x', '--help', '/x', '.x', 'x/', 'x.', 'a..b', 'a//b', 'a b', 'a:b', 'a~1', 'x.lock', 'x'.repeat(121)]) expect(branchOk(bad), bad).toBe(false);
  expect([refOk('origin/main'), refOk('v1.2.3'), refOk('-x'), refOk('a..b'), refOk('HEAD~2')]).toEqual([true, true, false, false, false]);
  expect(host.world.projects).toHaveLength(3);
});

test('extensions runtime workspace projects: the host failures keep the frozen codes and the state the commands already guard', async () => {
  const host = new WorkspaceManager(world());
  expect(code(await run(host, 'projects.add', { path: '/nowhere' }))).toBe('InvalidShape');
  expect(code(await run(host, 'projects.relink', { projectId: 'B', path: '/nowhere' }))).toBe('InvalidShape');
  expect(code(await run(host, 'projects.relink', { projectId: 'B', path: '/work/alpha' }))).toBe('Conflict');
  expect(code(await run(host, 'worktrees.remove', { worktreeId: 't1' }))).toBe('NotFound');
  expect(code(await run(host, 'worktrees.remove', { worktreeId: 'tr' }))).toBe('Conflict');
  expect(code(await run(host, 'worktrees.remove', { worktreeId: 'tm' }))).toBe('UnsupportedCapability');
  expect(code(await run(host, 'tasks.remove', { taskId: 'tr' }))).toBe('Conflict');
  expect(code(await run(host, 'tasks.move', { taskId: 'tw', projectId: 'B' }))).toBe('Conflict');
  expect(code(await run(host, 'tasks.move', { taskId: 'tr', projectId: 'B' }))).toBe('Conflict');
  expect(code(await run(host, 'branches.create', { projectId: 'A', name: 'topic' }))).toBe('Conflict');
  expect(code(await run(host, 'branches.create', { projectId: 'A', name: 'x', from: 'ghost' }))).toBe('NotFound');
  expect(code(await run(host, 'branches.switch', { projectId: 'A', branch: 'ghost' }))).toBe('NotFound');
  expect(code(await run(host, 'branches.rename', { projectId: 'A', from: 'pandacode/wt', to: 'moved' }))).toBe('Conflict');
  expect(code(await run(host, 'branches.remove', { projectId: 'A', branch: 'main' }))).toBe('Conflict');
  expect(code(await run(host, 'pulls.link', { taskId: 't1', reference: '#99' }))).toBe('NotFound');
  expect(code(await run(host, 'pulls.check', { taskId: 't1' }))).toBe('NotFound');
  const failing = new WorkspaceManager(world({ fail: call => (call === 'tasks.rename' ? 'disk exploded' : null) }));
  expect(code(await run(failing, 'tasks.rename', { taskId: 't1', title: 'x' }))).toBe('HostUnavailable');
  expect(codeOf('Stop this project\'s agents first.')).toBe('Conflict');
  expect(envelope({ code: 'NotFound', path: '$', ids: [] })).toEqual({ ok: false, error: { schemaVersion: 1, code: 'NotFound', path: '$', ids: [] } });
});

test('extensions runtime workspace projects: only the irreversible actions confirm, a refusal is Cancelled and changes nothing, and the user can turn it off per package', async () => {
  const confirming = SPECS.filter(spec => spec.confirm !== null).map(spec => spec.call);
  expect(confirming).toEqual(['projects.remove', 'worktrees.remove', 'branches.remove', 'tasks.remove', 'pulls.merge']);
  const host = new WorkspaceManager(world());
  host.world.tasks.find(task => task.id === 't1')!.pull = { number: 12, url: 'u', title: 'Fix it', state: 'open' };
  const refuse = { answer: () => false };
  for (const call of confirming) {
    const before = JSON.stringify(host.world);
    const reply = await run(host, call, SAMPLES[call], refuse);
    expect([code(reply), JSON.stringify(host.world)], call).toEqual(['Cancelled', before]);
  }
  expect(host.asked.map(entry => entry.action)).toEqual(confirming);
  expect(host.asked[0]).toMatchObject({ package: NAME, what: 'Remove the project gamma from PandaCode (its folder stays)' });
  expect(host.asked.find(entry => entry.action === 'tasks.remove')!.what).toBe('Delete the task Second and its history');
  // The host's own dialog names the package and what goes.
  const dialog = confirmation({ id: 'x', owner: OWNER, package: NAME, action: 'tasks.remove', what: host.asked[3].what });
  expect([dialog.title, dialog.confirmation]).toEqual([`${NAME} wants to continue`, 'Delete the task Second and its history. This cannot be undone.']);
  // An accepted confirmation proceeds; every other call never asks.
  host.asked.length = 0;
  expect(code(await run(host, 'tasks.remove', { taskId: 't2' }))).toBe('ok');
  for (const call of ['projects.rename', 'worktrees.merge', 'tasks.rename', 'branches.switch', 'pulls.unlink']) expect(code(await run(host, call, SAMPLES[call])), call).toBe('ok');
  expect(host.asked).toHaveLength(1);
  // Off for this package only: the same action proceeds at once.
  host.asked.length = 0;
  expect(code(await run(host, 'branches.remove', { projectId: 'A', branch: 'topic' }, { confirms: false }))).toBe('ok');
  expect(host.asked).toEqual([]);
  // The confirmation waits for the user, four at a time per package, and ends with the service.
  const slots = new ConfirmSlots();
  const opened = Array.from({ length: MAX_WAITING }, () => slots.begin(OWNER));
  expect(opened.every(entry => entry.ok)).toBe(true);
  expect(code(slots.begin(OWNER))).toBe('LimitExceeded');
  expect(slots.begin('sample.other').ok).toBe(true);
  expect(slots.cancelOwner(OWNER)).toHaveLength(MAX_WAITING);
  for (const entry of opened) if (entry.ok) expect(await entry.value.answer).toBe(false);
  expect(code(slots.answer('gone', true))).toBe('NotFound');
});

test('extensions runtime workspace projects: the check runs per project with no prompt, no plan is a report, and a revoke withdraws it', async () => {
  const host = new WorkspaceManager(world());
  let asked = 0;
  const reply = await run(host, CHECKS, { taskId: 'ta' }, { answer: () => { asked += 1; return true; } });
  expect(reply).toEqual({ ok: true, value: { schemaVersion: 1, report: { checked: true, name: 'npm test', ok: true, output: '', truncated: false } } });
  expect(asked).toBe(0);
  // A project with no check script reports that it has none: a result, not an error.
  expect(await run(host, CHECKS, { taskId: 't2' })).toEqual({ ok: true, value: { schemaVersion: 1, report: { checked: false, reason: expect.any(String) } } });
  // Per project: a package granted for B only runs B's check and never A's.
  expect(code(await run(host, CHECKS, { taskId: 'ta' }, { granted: allow(['B']) }))).toBe('PermissionDenied');
  expect(code(await run(host, CHECKS, { taskId: 't2' }, { granted: allow(['B']) }))).toBe('ok');
  expect(code(await run(host, CHECKS, { taskId: 'ghost' }))).toBe('NotFound');
  // Revoked while the script runs: the report is withheld.
  let calls = 0;
  const losing = checks({ granted: (permission, project) => { calls += 1; return calls <= 2 && allow()(permission, project); } });
  expect(code(await host.call(OWNER, losing, CHECKS, { taskId: 'ta' }))).toBe('PermissionDenied');
  // Two checks at a time per package.
  const gate = new CheckGate();
  expect([gate.enter(OWNER), gate.enter(OWNER)]).toEqual([null, null]);
  expect(gate.enter(OWNER)?.code).toBe('LimitExceeded');
  expect(gate.enter('sample.other')).toBeNull();
  gate.leave(OWNER);
  expect([gate.count(OWNER), MAX_CHECKS]).toEqual([1, 2]);
  expect(host.gate.count(OWNER)).toBe(0);
});

test('extensions runtime workspace projects: a package change reloads the workspace and an unrelated read never does', async () => {
  const host = new WorkspaceManager(world());
  await run(host, 'projects.rename', SAMPLES['projects.rename']);
  await run(host, 'tasks.rename', SAMPLES['tasks.rename']);
  await run(host, 'pulls.link', SAMPLES['pulls.link']);
  await run(host, 'pulls.check', SAMPLES['pulls.check']);
  await run(host, CHECKS, SAMPLES[CHECKS]);
  expect(host.events).toEqual([{ call: 'projects.rename', projects: true }, { call: 'tasks.rename', projects: false }, { call: 'pulls.link', projects: false }]);
  expect(admit({ granted: () => true, taskProject: () => undefined, projectExists: () => true }, 'tasks.rename', { taskId: 'x', title: 'y' })).toMatchObject({ code: 'NotFound' });
});

// ---- The main window -------------------------------------------------------------------------------------------------

const answers = (page: Page) => page.evaluate(() => (window as unknown as { __runtimeWorkspaceAnswers?: unknown[] }).__runtimeWorkspaceAnswers ?? []);

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as unknown as { __runtimeWorkspaceProjects?: unknown }).__runtimeWorkspaceProjects, undefined, { timeout: 30_000 });
}
const deliver = (page: Page, id: string) => page.evaluate(event => (window as unknown as { __runtimeWorkspaceProjects: { receive: (event: unknown) => void } }).__runtimeWorkspaceProjects.receive(event), { id, owner: OWNER, package: NAME, action: 'tasks.remove', what: 'Delete the task Second and its history' });

test('extensions runtime workspace projects: the host asks in its own dialog with the package name, Cancel answers refused and the Escape key too', async ({ page }) => {
  await boot(page);
  await deliver(page, `${OWNER}#confirm-1`);
  const dialog = page.locator('dialog[open]');
  await expect(dialog).toContainText(`${NAME} wants to continue`);
  await page.keyboard.press('Escape');
  await expect(dialog).toHaveCount(0);
  await expect.poll(() => answers(page)).toEqual([{ id: `${OWNER}#confirm-1`, accepted: false }]);
  await deliver(page, `${OWNER}#confirm-2`);
  await expect(page.locator('dialog[open]')).toContainText(NAME);
  await page.locator('dialog[open]').getByRole('button', { name: 'Cancel' }).click();
  await expect.poll(() => answers(page)).toEqual([{ id: `${OWNER}#confirm-1`, accepted: false }, { id: `${OWNER}#confirm-2`, accepted: false }]);
});

test('extensions runtime workspace projects: confirming takes the second step, shows what goes and answers accepted once', async ({ page }) => {
  await boot(page);
  await deliver(page, `${OWNER}#confirm-3`);
  const dialog = page.locator('dialog[open]');
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(dialog).toContainText('Delete the task Second and its history. This cannot be undone.');
  await dialog.getByRole('button', { name: 'Confirm' }).click();
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await expect.poll(() => answers(page)).toEqual([{ id: `${OWNER}#confirm-3`, accepted: true }]);
});
