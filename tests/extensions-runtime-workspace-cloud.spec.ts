import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts';
import { ACTIVITY_MAX, CLOUD_OPS, MAX_BOARDS, MAX_DATA_URL_BYTES, MAX_IMAGES, MAX_NAME_CHARS, MOODBOARD_OPS, PERMISSION, SEAMS, WorkspaceModel, codeOf, readCloud, readMoodboard, validMachineId, type Checks } from '../src/extensions/runtime-workspace-cloud';

// Preview column of R0406C (moodboards and already configured cloud machines). The first groups run the deterministic model in
// src/extensions/runtime-workspace-cloud.ts, which mirrors src-tauri/src/extensions/runtime_workspace_cloud.rs (whose own unit
// tests are `runtime_workspace_cloud::tests`); the last group drives the main window's host confirmation in the preview app.
// The installed service managing a real board or machine through the broker is a native test, reported in its own column: this
// file claims only the preview and model column. No real cloud call is made anywhere in it.
//
// Refusal-test reconciliation (Q018, Q085, Q086, Q087, Q110, Q111, Q112): the rows that refused `sync`, `target-cloud`,
// `image-remove`, `attach`, `delete-confirm`, `cloud-start`, `file-picker`, `credentials` and the machine actions before consent
// refuse a contributed UI ACTION at a protected location; that stays, because a contribution is a click the user did not make
// (reason: a declarative contribution has no user gesture, not a security rule about trusted packages). What this slice delivers
// is a different path: `panda.workspace.moodboards.*` and `panda.workspace.cloud.*` under the named permission
// `workspace.manage`, which the model below proves granted, narrowed, revoked, confirmed and declined. The refusals retained here
// each have a reason: the fields `credentials`, `token`, `apiKey`, `path` and `prompt` are not fields of any call (ADR-0006: no
// credentials API; a path would be a file read, which is `projects.files.read`), connecting a provider, pairing and remote access
// are not methods (they stay with the user), a provider that is not connected cannot be provisioned (the package cannot connect
// it), and a foreign or stale id answers NotFound (the id names nothing, a predictability rule).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-workspace-cloud/extension.json'));
const fixtureSource = read('tests/fixtures/extensions/runtime-workspace-cloud/main.cjs');
const OWNER = 'sample.runtime-workspace-cloud';
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

const checks = (projects: readonly string[] = ['A', 'B'], everything = true, holds = true): Checks => ({ holds, granted: project => (project === null ? everything : projects.includes(project)) });
const code = (reply: { ok: boolean; error?: { code: string } }) => (reply.ok ? 'ok' : reply.error!.code);
function model() {
  const host = new WorkspaceModel();
  host.projects.add('A'); host.projects.add('B');
  host.addBoard('boardA', 'A', 'Reference A'); host.addBoard('boardB', 'B', 'Reference B');
  host.addMachine('daytona:free-box', 'running');
  host.addMachine('daytona:task-box', 'running', { id: 'task1', project: 'A' });
  host.addMachine('daytona:busy-box', 'running', { id: 'task2', project: 'A', busy: true });
  return host;
}

test('extensions runtime workspace cloud: the fixture package declares workspace.manage and a service and uses every call', () => {
  expect(manifest.permissions).toEqual(expect.arrayContaining(['runtime.service', PERMISSION]));
  expect(validateContract('packages', [manifest]).ok).toBe(true);
  for (const call of ['moodboards.create', 'moodboards.rename', 'moodboards.remove', 'moodboards.addImage', 'moodboards.removeImage', 'cloud.provision', 'cloud.sync', 'cloud.retry', 'cloud.open', 'cloud.stop', 'cloud.remove', 'refuse']) expect(fixtureSource, call).toContain(call);
  // The package has no way to connect a provider, pair, grant remote access or name a credential.
  expect(fixtureSource).not.toMatch(/credential|apiKey|token|pair|remoteAccess|connect\(/i);
});

test('extensions runtime workspace cloud: every frozen method maps to a native seam and a parser, and no namespace disappears', () => {
  const frozen = ['moodboards.create', 'moodboards.rename', 'moodboards.remove', 'moodboards.addImage', 'moodboards.removeImage', 'cloud.provision', 'cloud.sync', 'cloud.retry', 'cloud.open', 'cloud.stop', 'cloud.remove'];
  expect(SEAMS.map(([name]) => name)).toEqual(frozen.map(name => `workspace.${name}`));
  expect(SEAMS.every(([, seam]) => seam.length > 0)).toBe(true);
  expect([...MOODBOARD_OPS.map(op => `moodboards.${op}`), ...CLOUD_OPS.map(op => `cloud.${op}`)]).toEqual(frozen);
  // Each seam is a real native command the original controls call (the moodboard panel, the machines panel, the cloud strip).
  const lib = read('src-tauri/src/lib.rs');
  for (const command of ['create_moodboard', 'rename_moodboard', 'delete_moodboard', 'add_moodboard_image', 'remove_moodboard_image', 'cloud_create', 'cloud_power', 'cloud_agent_action']) expect(lib, command).toContain(command);
});

test('extensions runtime workspace cloud: moodboard calls read with their exact fields and refuse everything else with a reason', () => {
  expect(readMoodboard({ op: 'create', input: { projectId: 'A', name: ' Ideas ' } })).toEqual({ op: 'create', projectId: 'A', name: 'Ideas' });
  expect(readMoodboard({ op: 'rename', boardId: 'b', name: 'New' })).toEqual({ op: 'rename', boardId: 'b', name: 'New' });
  expect(readMoodboard({ op: 'remove', boardId: 'b' })).toEqual({ op: 'remove', boardId: 'b' });
  expect(readMoodboard({ op: 'addImage', boardId: 'b', input: { name: 'a.png', dataUrl: PNG } })).toEqual({ op: 'addImage', boardId: 'b', name: 'a.png', dataUrl: PNG });
  expect(readMoodboard({ op: 'removeImage', boardId: 'b', imageId: 'i' })).toEqual({ op: 'removeImage', boardId: 'b', imageId: 'i' });
  const refused: [unknown, string][] = [
    [{ op: 'create', input: { projectId: 'A', name: '' } }, 'InvalidShape'], [{ op: 'create', input: { projectId: 'A', name: 'a\nb' } }, 'InvalidShape'],
    [{ op: 'create', input: { projectId: 'A', name: 'x'.repeat(MAX_NAME_CHARS + 1) } }, 'LimitExceeded'], [{ op: 'create', input: { projectId: 'A', name: 'a', path: 'C:/x' } }, 'InvalidShape'],
    [{ op: 'create', input: { name: 'a' } }, 'InvalidShape'], [{ op: 'create', projectId: 'A', name: 'a' }, 'InvalidShape'], [{ op: 'rename', boardId: 'b' }, 'InvalidShape'],
    [{ op: 'remove', boardId: 'b', confirmed: true }, 'InvalidShape'], [{ op: 'remove' }, 'InvalidShape'],
    [{ op: 'addImage', boardId: 'b', input: { name: 'a', dataUrl: 'file:///etc/passwd' } }, 'InvalidShape'],
    [{ op: 'addImage', boardId: 'b', input: { name: 'a', dataUrl: `data:image/png;base64,${'A'.repeat(MAX_DATA_URL_BYTES)}` } }, 'LimitExceeded'],
    [{ op: 'addImage', boardId: 'b', input: { name: 'a', dataUrl: PNG, token: 'x' } }, 'InvalidShape'], [{ op: 'list' }, 'InvalidShape'], ['create', 'InvalidShape'],
  ];
  for (const [raw, expected] of refused) expect(readMoodboard(raw), JSON.stringify(raw).slice(0, 120)).toMatchObject({ code: expected });
});

test('extensions runtime workspace cloud: cloud calls read with their exact fields, and credentials, pairing and remote access are not fields or methods', () => {
  expect(readCloud({ op: 'provision', input: { provider: 'daytona', name: 'box-1' } })).toEqual({ op: 'provision', provider: 'daytona', name: 'box-1' });
  for (const op of ['sync', 'retry', 'open', 'stop', 'remove']) expect(readCloud({ op, machineId: 'daytona:abc-1' })).toEqual({ op, machineId: 'daytona:abc-1' });
  const refused: [unknown, string][] = [
    [{ op: 'provision', input: { provider: 'daytona', name: 'a', apiKey: 'k' } }, 'InvalidShape'], [{ op: 'provision', input: { provider: 'daytona', name: 'a', credentials: {} } }, 'InvalidShape'],
    [{ op: 'provision', input: { provider: 'Daytona', name: 'a' } }, 'InvalidShape'], [{ op: 'provision', input: { provider: 'daytona', name: 'a b' } }, 'InvalidShape'],
    [{ op: 'provision', input: { provider: 'daytona', name: 'x'.repeat(64) } }, 'LimitExceeded'], [{ op: 'provision', input: { provider: 'daytona' } }, 'InvalidShape'],
    [{ op: 'sync', machineId: 'nowhere:abc' }, 'InvalidShape'], [{ op: 'sync', machineId: 'daytona:../x' }, 'InvalidShape'], [{ op: 'stop' }, 'InvalidShape'],
    [{ op: 'remove', machineId: 'daytona:abc', prompt: 'x' }, 'InvalidShape'], [{ op: 'pair', machineId: 'daytona:abc' }, 'InvalidShape'], [{ op: 'remoteAccess' }, 'InvalidShape'],
    [{ op: 'connect', input: { provider: 'daytona', key: 'k' } }, 'InvalidShape'],
  ];
  for (const [raw, expected] of refused) expect(readCloud(raw), JSON.stringify(raw)).toMatchObject({ code: expected });
  expect([validMachineId('daytona:abc'), validMachineId('aws:i-0abc'), validMachineId('daytona'), validMachineId('daytona:.hidden'), validMachineId('unknown:abc')]).toEqual([true, true, false, false, false]);
});

test('extensions runtime workspace cloud: native text becomes a frozen code and never reaches a package', () => {
  const cases: [string, string][] = [
    ['Wait for the agent to finish, or stop it first.', 'Busy'], ['This project has 24 moodboards. Remove one before adding another.', 'LimitExceeded'],
    ['Connect Daytona first.', 'UnsupportedCapability'], ['Use a name between 1 and 120 characters.', 'InvalidShape'], ['Moodboard is unavailable in this project.', 'NotFound'],
    ['Unknown cloud machine.', 'NotFound'], ['Image is no longer available.', 'NotFound'], ['a socket exploded', 'HostUnavailable'],
  ];
  for (const [text, expected] of cases) expect(codeOf(text), text).toBe(expected);
});

test('extensions runtime workspace cloud: a granted package manages moodboard content without a prompt, and every call is attributed', () => {
  const host = model();
  host.decide = () => { throw new Error('a granted non-removal call must never ask the host'); };
  const created = host.moodboards(OWNER, checks(), { op: 'create', input: { projectId: 'A', name: 'Fresh' } });
  expect(created).toMatchObject({ ok: true, value: { name: 'Fresh', projectId: 'A', imageCount: 0 } });
  const id = (created as { value: { id: string } }).value.id;
  expect(host.moodboards(OWNER, checks(), { op: 'rename', boardId: id, name: 'Renamed' })).toMatchObject({ ok: true, value: { name: 'Renamed' } });
  const added = host.moodboards(OWNER, checks(), { op: 'addImage', boardId: id, input: { name: 'a.png', dataUrl: PNG } });
  expect(added).toMatchObject({ ok: true, value: { imageCount: 1, images: [{ name: 'a.png' }] } });
  const imageId = (added as { value: { images: { id: string }[] } }).value.images[0].id;
  expect(host.moodboards(OWNER, checks(), { op: 'removeImage', boardId: id, imageId })).toEqual({ ok: true, value: null });
  expect(host.moodboards(OWNER, checks(), { op: 'removeImage', boardId: id, imageId })).toMatchObject({ ok: false, error: { code: 'NotFound' } });
  expect(host.boards.get(id)!.images.size).toBe(0);
  // Every call names its package, the method and the board, and carries no value.
  expect(host.activityOf(OWNER).map(item => [item.method, item.subject, item.outcome])).toEqual([
    ['workspaceMoodboards', 'A', 'ok'], ['workspaceMoodboards', id, 'ok'], ['workspaceMoodboards', id, 'ok'], ['workspaceMoodboards', id, 'ok'], ['workspaceMoodboards', id, 'NotFound'],
  ]);
  expect(host.activityOf('someone.else')).toEqual([]);
});

test('extensions runtime workspace cloud: the board and image limits are the native ones', () => {
  const host = model();
  for (let index = 0; index < MAX_BOARDS - 1; index += 1) expect(code(host.moodboards(OWNER, checks(), { op: 'create', input: { projectId: 'A', name: `b${index}` } }))).toBe('ok');
  expect(code(host.moodboards(OWNER, checks(), { op: 'create', input: { projectId: 'A', name: 'one too many' } }))).toBe('LimitExceeded');
  for (let index = 0; index < MAX_IMAGES; index += 1) expect(code(host.moodboards(OWNER, checks(), { op: 'addImage', boardId: 'boardB', input: { name: `i${index}.png`, dataUrl: PNG } }))).toBe('ok');
  expect(code(host.moodboards(OWNER, checks(), { op: 'addImage', boardId: 'boardB', input: { name: 'last.png', dataUrl: PNG } }))).toBe('LimitExceeded');
  expect(code(host.moodboards(OWNER, checks(), { op: 'create', input: { projectId: 'Z', name: 'nowhere' } }))).toBe('PermissionDenied');
  expect(code(host.moodboards(OWNER, checks(['A', 'B', 'Z']), { op: 'create', input: { projectId: 'Z', name: 'nowhere' } }))).toBe('NotFound');
});

test('extensions runtime workspace cloud: removals confirm by default with the package named, a declined one removes nothing, and the user can turn it off per package', () => {
  const host = model();
  host.decide = () => false;
  expect(code(host.moodboards(OWNER, checks(), { op: 'remove', boardId: 'boardA' }))).toBe('Cancelled');
  expect(code(host.cloud(OWNER, checks(), { op: 'remove', machineId: 'daytona:free-box' }))).toBe('Cancelled');
  expect([host.boards.has('boardA'), host.machines.has('daytona:free-box')]).toEqual([true, true]);
  expect(host.confirmations.map(item => [item.owner, item.action])).toEqual([[OWNER, 'moodboards.remove'], [OWNER, 'cloud.machines.remove']]);
  host.decide = () => true;
  expect(code(host.moodboards(OWNER, checks(), { op: 'remove', boardId: 'boardA' }))).toBe('ok');
  expect(code(host.cloud(OWNER, checks(), { op: 'remove', machineId: 'daytona:free-box' }))).toBe('ok');
  expect([host.boards.has('boardA'), host.machines.has('daytona:free-box')]).toEqual([false, false]);
  // Turned off for this package only: it removes without asking, another package still asks.
  host.confirmDeletions.set(OWNER, false);
  const before = host.confirmations.length;
  expect(code(host.moodboards(OWNER, checks(), { op: 'remove', boardId: 'boardB' }))).toBe('ok');
  expect(host.confirmations.length).toBe(before);
  host.addBoard('boardC', 'A', 'Other');
  host.decide = () => false;
  expect(code(host.moodboards('other.package', checks(), { op: 'remove', boardId: 'boardC' }))).toBe('Cancelled');
  // Stopping a machine is reversible: it never asks.
  expect(code(host.cloud('other.package', checks(), { op: 'stop', machineId: 'daytona:task-box' }))).toBe('ok');
  expect(host.machines.get('daytona:task-box')!.state).toBe('stopped');
});

test('extensions runtime workspace cloud: provisioning uses only a connected provider and the control calls reach the owning task', () => {
  const host = model();
  expect(host.cloud(OWNER, checks(), { op: 'provision', input: { provider: 'daytona', name: 'new-box' } })).toMatchObject({ ok: true, value: { id: 'daytona:new-box', provider: 'daytona', state: 'starting' } });
  expect(code(host.cloud(OWNER, checks(), { op: 'provision', input: { provider: 'daytona', name: 'new-box' } }))).toBe('Conflict');
  // A provider the user did not connect cannot be connected by a package: there is no method for it.
  expect(code(host.cloud(OWNER, checks(), { op: 'provision', input: { provider: 'hetzner', name: 'x' } }))).toBe('UnsupportedCapability');
  expect(host.machines.has('hetzner:x')).toBe(false);
  expect(code(host.cloud(OWNER, checks(), { op: 'sync', machineId: 'daytona:task-box' }))).toBe('ok');
  expect(code(host.cloud(OWNER, checks(), { op: 'retry', machineId: 'daytona:task-box' }))).toBe('ok');
  expect(host.synced).toEqual(['sync:daytona:task-box', 'retry:daytona:task-box']);
  // A machine no task owns has no sync or retry; a running agent holds stop and remove back (Busy), not a refusal of trust.
  expect(code(host.cloud(OWNER, checks(), { op: 'sync', machineId: 'daytona:free-box' }))).toBe('NotFound');
  expect(code(host.cloud(OWNER, checks(), { op: 'sync', machineId: 'daytona:busy-box' }))).toBe('Busy');
  expect(code(host.cloud(OWNER, checks(), { op: 'stop', machineId: 'daytona:busy-box' }))).toBe('Busy');
  expect(code(host.cloud(OWNER, checks(), { op: 'stop', machineId: 'daytona:gone' }))).toBe('NotFound');
  expect(code(host.cloud(OWNER, checks(), { op: 'open', machineId: 'daytona:free-box' }))).toBe('ok');
  expect(host.opened).toEqual(['daytona:free-box']);
});

test('extensions runtime workspace cloud: the grant is project scoped and a refusal never says whether a board or machine exists', () => {
  const host = model();
  const narrowed = checks(['A'], false);
  // A board of project A is reachable; one of project B is the permission itself, whether or not it exists.
  expect(code(host.moodboards(OWNER, narrowed, { op: 'rename', boardId: 'boardA', name: 'ok' }))).toBe('ok');
  expect(code(host.moodboards(OWNER, narrowed, { op: 'rename', boardId: 'boardB', name: 'no' }))).toBe('PermissionDenied');
  expect(host.moodboards(OWNER, narrowed, { op: 'rename', boardId: 'boardB', name: 'no' })).toMatchObject({ error: { path: PERMISSION } });
  expect(code(host.moodboards(OWNER, checks([], false, false), { op: 'rename', boardId: 'nope', name: 'x' }))).toBe('PermissionDenied');
  expect(code(host.moodboards(OWNER, checks([], false, false), { op: 'rename', boardId: 'boardA', name: 'x' }))).toBe('PermissionDenied');
  // A machine of a task in project A follows that project; a machine no task owns and provisioning need every project.
  expect(code(host.cloud(OWNER, narrowed, { op: 'stop', machineId: 'daytona:task-box' }))).toBe('ok');
  expect(code(host.cloud(OWNER, narrowed, { op: 'stop', machineId: 'daytona:free-box' }))).toBe('PermissionDenied');
  expect(code(host.cloud(OWNER, narrowed, { op: 'provision', input: { provider: 'daytona', name: 'n' } }))).toBe('PermissionDenied');
  expect(code(host.cloud(OWNER, checks(['B'], false), { op: 'stop', machineId: 'daytona:task-box' }))).toBe('PermissionDenied');
  expect(host.machines.get('daytona:free-box')!.state).toBe('running');
});

test('extensions runtime workspace cloud: a revoke or narrowing between admission and the effect changes nothing and leaves unrelated work alone', () => {
  const host = model();
  let allowed = true;
  const live: Checks = { holds: true, granted: () => allowed };
  expect(code(host.moodboards(OWNER, live, { op: 'rename', boardId: 'boardA', name: 'late' }, () => { allowed = false; }))).toBe('PermissionDenied');
  expect(host.boards.get('boardA')!.name).toBe('Reference A');
  allowed = true;
  expect(code(host.cloud(OWNER, live, { op: 'stop', machineId: 'daytona:free-box' }, () => { allowed = false; }))).toBe('PermissionDenied');
  expect(host.machines.get('daytona:free-box')!.state).toBe('running');
  allowed = true;
  expect(code(host.moodboards(OWNER, live, { op: 'remove', boardId: 'boardA' }, () => { allowed = false; }))).toBe('PermissionDenied');
  expect(host.boards.has('boardA')).toBe(true);
  // Unrelated work is untouched: another board and another machine still answer.
  allowed = true;
  expect(code(host.moodboards(OWNER, live, { op: 'rename', boardId: 'boardB', name: 'still works' }))).toBe('ok');
  expect(code(host.cloud(OWNER, live, { op: 'open', machineId: 'daytona:task-box' }))).toBe('ok');
  // Disabled, uninstalled or in safe mode there is no service and no grant: the permission is the answer for every method.
  const off = checks([], false, false);
  for (const raw of [{ op: 'create', input: { projectId: 'A', name: 'x' } }, { op: 'remove', boardId: 'boardB' }]) expect(code(host.moodboards(OWNER, off, raw))).toBe('PermissionDenied');
  const asked = host.confirmations.length;
  for (const raw of [{ op: 'provision', input: { provider: 'daytona', name: 'x' } }, { op: 'remove', machineId: 'daytona:free-box' }]) expect(code(host.cloud(OWNER, off, raw))).toBe('PermissionDenied');
  // A refused package is never offered a confirmation to show.
  expect(host.confirmations.length).toBe(asked);
});

test('extensions runtime workspace cloud: the activity log keeps the newest calls, with the package and the outcome and no values', () => {
  const host = model();
  for (let index = 0; index < ACTIVITY_MAX + 5; index += 1) host.cloud(index % 2 === 0 ? OWNER : 'other.package', checks(), { op: 'open', machineId: `daytona:box-${index}` });
  expect(host.activity.length).toBe(ACTIVITY_MAX);
  expect(host.activityOf(OWNER).every(item => item.owner === OWNER && item.method === 'workspaceCloud' && item.outcome === 'ok')).toBe(true);
  expect(host.activity.every(item => Object.keys(item).sort().join() === 'method,outcome,owner,subject')).toBe(true);
});

test('extensions runtime workspace cloud: the host wires the calls, the cleanup, the commands, the mocks and the registrations', () => {
  const nodeHost = read('src-tauri/src/extensions/node-host.cjs');
  for (const name of ["rpc('workspaceMoodboards'", "rpc('workspaceCloud'"]) expect(nodeHost, name).toContain(name);
  const lifetime = read('src-tauri/src/extensions/runtime_service_lifetime.rs');
  for (const name of ['runtime_workspace_cloud::serve', 'runtime_workspace_cloud::service_stopped']) expect(lifetime, name).toContain(name);
  const lib = read('src-tauri/src/lib.rs');
  for (const name of ['runtime_workspace_cloud::extensions_runtime_workspace_cloud_answer', 'runtime_workspace_cloud::extensions_runtime_workspace_cloud_activity', 'runtime_workspace_cloud::WorkspaceCloud']) expect(lib, name).toContain(name);
  expect(read('src-tauri/src/extensions/mod.rs')).toContain('runtime_workspace_cloud');
  expect(read('src/extensions/preview.ts')).toContain('extensions_runtime_workspace_cloud');
  const sdk = read('src/extensions/sdk/index.d.ts');
  for (const name of ['WorkspaceMoodboardsApi', 'WorkspaceCloudApi', 'CloudMachineInfo', 'MoodboardInfo']) expect(sdk, name).toContain(name);
  for (const path of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) expect(read(path), path).toContain('extensions-runtime-workspace-cloud.spec.ts');
});

// ---- the main window in the preview app ---------------------------------------------------------------------------

type Seams = { __runtimeWorkspaceCloud?: { receive(round: unknown): void; end(owner: string): void }; __runtimeWorkspaceCloudAnswers?: { id: string; answer: { accepted: boolean } }[] };
async function setup(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => Boolean((window as unknown as Seams).__runtimeWorkspaceCloud))).toBe(true);
}
const announce = (page: Page, id: string, what: string) => page.evaluate(({ id, what }) => (window as unknown as Seams).__runtimeWorkspaceCloud!.receive({ id, owner: 'sample.runtime-workspace-cloud', name: 'Workspace manager', phase: 'confirm', action: 'moodboards.remove', what }), { id, what });
const answers = (page: Page) => page.evaluate(() => (window as unknown as Seams).__runtimeWorkspaceCloudAnswers ?? []);

test('extensions runtime workspace cloud: a removal confirmation shows the package name and removes only when the user confirms', async ({ page }) => {
  await setup(page);
  await announce(page, 'c1', 'Delete moodboard boardA and its images');
  const dialog = page.locator('#dialog[open]');
  await expect(dialog).toContainText('Workspace manager');
  await expect(dialog).toContainText('Delete moodboard boardA');
  await dialog.getByRole('button', { name: 'Delete' }).click();
  await expect.poll(async () => (await answers(page)).map(entry => [entry.id, entry.answer.accepted])).toEqual([['c1', true]]);
});

test('extensions runtime workspace cloud: Escape declines, a second confirmation waits its turn, and a stopped service closes its own', async ({ page }) => {
  await setup(page);
  await announce(page, 'd1', 'Delete cloud machine daytona:free-box');
  await announce(page, 'd2', 'Delete moodboard boardB and its images');
  await expect(page.locator('#dialog[open]')).toContainText('daytona:free-box');
  await page.keyboard.press('Escape');
  await expect.poll(async () => (await answers(page)).map(entry => [entry.id, entry.answer.accepted])).toEqual([['d1', false]]);
  await expect(page.locator('#dialog[open]')).toContainText('boardB');
  // The service ends (disable, revoke, uninstall): the dialog leaves without an answer from the user; the native side already
  // resolved the round as revoked and removed nothing.
  await page.evaluate(() => (window as unknown as Seams).__runtimeWorkspaceCloud!.end('sample.runtime-workspace-cloud'));
  await expect(page.locator('#dialog[open]')).toHaveCount(0);
  expect((await answers(page)).map(entry => entry.id)).toEqual(['d1']);
});
