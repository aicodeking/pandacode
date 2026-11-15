import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with the preview's seeded threads (session-2 is a Codex task
// in the first project, session-4 one in the second), two deploy platforms connected with preview-only keys and the
// sample bots (Scout, Writer, Ledger, Dozy). No team is started with a real model, nothing is deployed and no bot is
// created or deleted; installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/task-menus/extension.json', import.meta.url), 'utf8'));
const TOOLBAR = 'sample.task-menus/toolbar';
const BASE = '/?extensions-baseline&task-menus&replacement&bots=sample';
const PROTECTED = ['team-save', 'team-profile-edit', 'task-console', 'task-delete-confirm', 'deploy-connect', 'deploy-credentials', 'bot-credentials', 'bot-create', 'bot-delete'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewTaskMenus());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const menu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true });
const names = (list: Locator) => list.locator('.choice-menu-option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}` });
const TRIGGERS = { team: '#team-trigger', task: '#task-menu-trigger', deploy: '#deploy-button', bot: '#composer-bot' } as const;
const MENUS = { team: 'Team', task: 'Task actions', deploy: 'Deploy', bot: 'Bot' } as const;
async function open(page: Page, kind: keyof typeof TRIGGERS) {
  await page.locator(TRIGGERS[kind]).click(); const list = menu(page, MENUS[kind]); await expect(list).toBeVisible(); return list;
}
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load; the Codex task is opened. */
async function load(page: Page, url = BASE) {
  // A cold preview server compiles the page on its first load; readiness, not behavior, is awaited longer here.
  await page.goto(url); await expect(prompt(page)).toBeEnabled({ timeout: 20_000 }); await expect.poll(async () => Boolean(await props(page)), { timeout: 20_000 }).toBe(true);
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
  await row(page, 'session-2').click(); await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
  await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  await expect(page.locator(TRIGGERS.team)).toBeVisible(); await expect(page.locator(TRIGGERS.deploy)).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page) {
  await explorer(page);
  await page.getByLabel('Composer presentation', { exact: true }).selectOption(TOOLBAR);
  await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', TOOLBAR);
}
async function install(page: Page) {
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.task-menus', exact: true }).click();
  await back(page); return region;
}
async function hide(page: Page, region: Locator, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: new RegExp(`^Hide ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( —|$)`) });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
async function proposal(region: Locator, location: string, title: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: new RegExp(`^(Grant UI customization and select|Select) ${title}$`) }).click();
}
/** Opens a contributed action's dialog, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}
/** Chooses a contributed menu item, then loads its dialog's options and cancels it. */
async function contributed(page: Page, kind: keyof typeof TRIGGERS, title: string, tags: string) {
  const list = await open(page, kind);
  await list.getByRole('menuitem', { name: title, exact: true }).click();
  return captured(page, tags);
}
const noMutation = async (page: Page) => { for (const command of ['send_message', 'steer_message', 'architect_configure', 'delete_session', 'bot_assign_task']) expect(await calls(page, command), command).toEqual([]); };
function build(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewTaskMenus(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, team: p.team, connection: p.connection, bot: p.bot, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewTaskMenusAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await build(page, controlId, changes, nth));
const ofKind = async (page: Page, controlId: string) => (await props(page)).controls.filter((control: any) => control.controlId === controlId);
async function newTask(page: Page) {
  await row(page, 'session-2').click(); await page.locator('.new-task-button').click();
  await expect(page.locator(TRIGGERS.bot)).toBeVisible();
  return (await prompt(page).getAttribute('data-session-id'))!;
}

test('Task menus extension: zero extensions keep the Team, Task actions, Deploy and Bot menus and the task, team setup and bot assignment', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  // Team: radios for no team, the lead's team and the kinds; no contributed or hidden markup.
  let list = await open(page, 'team');
  expect(await names(list)).toEqual(expect.arrayContaining(['No team', 'Cheap team', 'Balanced team', 'Best team']));
  await expect(list.getByRole('menuitemradio', { name: 'No team', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-extension-contribution], [data-layout-hidden]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
  // Task actions: Delete task… and Open harness console stay in place.
  list = await open(page, 'task');
  const task = await names(list);
  expect(task).toEqual(expect.arrayContaining(['Pin task', 'Rename task', 'Browser tests with Jev', 'Manage goal', 'Open harness console', 'Copy project path', 'Delete task…']));
  expect(task.at(-1)).toBe('Delete task…');
  await page.keyboard.press('Escape');
  // Deploy: connected platforms enabled, the others point to Settings.
  list = await open(page, 'deploy');
  await expect(list.getByRole('menuitem', { name: 'Deploy to Vercel', exact: true })).toBeEnabled(); await expect(list.getByRole('menuitem', { name: 'Deploy to AWS', exact: true })).toBeDisabled();
  expect(await names(list)).toEqual(['Deploy to Vercel', 'Deploy to Cloudflare', 'Deploy to Railway', 'Deploy to Netlify', 'Deploy to AWS', 'Deploy to Google Cloud']);
  await page.keyboard.press('Escape');
  // Bot assignment on a new task: radios, No bot checked.
  await newTask(page);
  list = await open(page, 'bot');
  expect(await names(list)).toEqual(expect.arrayContaining(['No bot', 'Scout', 'Writer']));
  await expect(list.getByRole('menuitemradio', { name: 'No bot', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  // The presentation names no label or name, and captured actions have no owner without a selected provider.
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, menu: 'none' });
  expect(JSON.stringify(p)).not.toMatch(/Scout|Vercel|session-|project-|Cheap/);
  expect(await act(page, 'bot-assign')).toEqual({ ok: false, reason: 'Revoked' });
  await noMutation(page);
});

test('Task menus extension: an installed package\'s items in all four menus and the setup are clicked and run with the captured task, team, platforms and bot', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await install(page);
  const team = await contributed(page, 'team', 'Team notes', 'Team tags');
  expect(team).toMatchObject({ surfaceId: 'panda.team.menu', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'team', ids: ['session-2'] } });
  // The Team radios keep their role and the host's own rows once the surface is engaged.
  let list = await open(page, 'team');
  await expect(list.getByRole('menuitemradio', { name: 'No team', exact: true })).toHaveAttribute('aria-checked', 'true'); await expect(list.getByRole('menuitem', { name: 'Team notes', exact: true })).toHaveCount(1);
  expect(await names(list)).toEqual(['No team', 'Cheap team', 'Balanced team', 'Best team', 'Team notes']);
  await page.keyboard.press('Escape');
  const task = await contributed(page, 'task', 'Task notes', 'Task tags');
  expect(task).toMatchObject({ surfaceId: 'panda.task.menu', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'task', ids: ['session-2'] } });
  const deploy = await contributed(page, 'deploy', 'Deploy notes', 'Deploy tags');
  expect(deploy).toMatchObject({ surfaceId: 'panda.deploy.menu', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'connection', ids: ['vercel', 'netlify'] } });
  expect(JSON.stringify(deploy)).not.toMatch(/preview-only|token|secret/i);
  // A task switch is another capture: the same items now name the other task and project.
  await row(page, 'session-4').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-4');
  expect(await contributed(page, 'task', 'Task notes', 'Task tags')).toMatchObject({ projectId: 'project-2', sessionId: 'session-4', selection: { kind: 'task', ids: ['session-4'] } });
  expect(await contributed(page, 'team', 'Team notes', 'Team tags')).toMatchObject({ projectId: 'project-2', sessionId: 'session-4', selection: { kind: 'team', ids: ['session-4'] } });
  // The bot menu of a new task captures the task and the bots listed.
  const fresh = await newTask(page);
  const bot = await contributed(page, 'bot', 'Bot notes', 'Bot tags');
  expect(bot).toMatchObject({ surfaceId: 'panda.bot.assignment', sessionId: fresh, selection: { kind: 'bot' } });
  expect(bot.selection.ids.length).toBeGreaterThanOrEqual(4);
  // A switch while a contributed dialog is open does not retarget it: the menu ends with the task it was opened for.
  list = await open(page, 'task');
  await row(page, 'session-2').click({ force: true });
  await expect(list).toHaveCount(0); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  await noMutation(page);
  // Architect & workers (classic setup) carries the package's slot with the task and its team.
  await page.evaluate(() => { localStorage.setItem('pandacode.teamClassic', 'true'); window.dispatchEvent(new CustomEvent('pandacode:team-mode', { detail: true })); });
  await page.getByRole('button', { name: 'Architect & workers', exact: true }).click();
  const setupSlot = page.locator('.architect-setup-popover .task-menus-setup-extensions [data-extension-contribution="sample.task-menus/setup"]');
  await expect(setupSlot).toBeVisible();
  await setupSlot.click();
  const setupContext = await captured(page, 'Setup tags');
  expect(setupContext).toMatchObject({ surfaceId: 'panda.team.setup.actions', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'team', ids: ['session-2'] } });
  await noMutation(page);
});

test('Task menus extension: hide and order of eligible entries persist and restore; pinned and protected entries keep their place', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]);
  let team = await names(await open(page, 'team')); await page.keyboard.press('Escape');
  expect(team.indexOf('Cheap team')).toBeLessThan(team.indexOf('Best team'));
  const region = await explorer(page);
  await proposal(region, 'panda.team.menu', 'Best team before Cheap team');
  await hide(page, region, 'panda.team.menu', 'Balanced team');
  await proposal(region, 'panda.task.menu', 'Rename before Pin');
  await hide(page, region, 'panda.task.menu', 'Browser tests with Jev');
  await proposal(region, 'panda.deploy.menu', 'Netlify before Vercel');
  await hide(page, region, 'panda.deploy.menu', 'Deploy to AWS');
  // Pinned and protected entries are not layout items: no Hide control exists for them.
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.task.menu');
  const visibility = region.getByRole('list', { name: 'Item visibility', exact: true });
  for (const label of ['Delete task', 'Open harness console']) await expect(visibility.getByRole('button', { name: new RegExp(`^Hide ${label}`) })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.team.menu');
  await expect(visibility.getByRole('button', { name: /^Hide No team/ })).toHaveCount(0);
  await back(page);
  for (const reload of [false, true]) {
    if (reload) await load(page);
    const when = reload ? 'after reload' : 'live';
    team = await names(await open(page, 'team')); await page.keyboard.press('Escape');
    expect(team.indexOf('Best team'), when).toBeLessThan(team.indexOf('Cheap team')); expect(team, when).not.toContain('Balanced team'); expect(team, when).toEqual(expect.arrayContaining(['No team', 'Team notes']));
    expect(team[0], when).toBe('No team');
    const task = await names(await open(page, 'task')); await page.keyboard.press('Escape');
    expect(task.indexOf('Rename task'), when).toBeLessThan(task.indexOf('Pin task')); expect(task, when).not.toContain('Browser tests with Jev'); expect(task, when).toEqual(expect.arrayContaining(['Open harness console', 'Delete task…', 'Task notes']));
    const deploy = await names(await open(page, 'deploy')); await page.keyboard.press('Escape');
    expect(deploy.indexOf('Deploy to Netlify'), when).toBeLessThan(deploy.indexOf('Deploy to Vercel')); expect(deploy, when).not.toContain('Deploy to AWS'); expect(deploy, when).toContain('Deploy notes');
  }
  // Safe mode shows the built-in order and every entry, with no contributed item and no deleted preference; a normal launch restores them.
  await page.evaluate(() => (window as any).__previewTaskMenusSafeMode());
  expect(await names(await open(page, 'team'))).toEqual(['No team', 'Cheap team', 'Balanced team', 'Best team']); await page.keyboard.press('Escape');
  const safe = await names(await open(page, 'task')); await page.keyboard.press('Escape');
  expect(safe.indexOf('Pin task')).toBeLessThan(safe.indexOf('Rename task')); expect(safe).toContain('Browser tests with Jev'); expect(safe).not.toContain('Task notes');
  expect(await names(await open(page, 'deploy'))).toEqual(['Deploy to Vercel', 'Deploy to Cloudflare', 'Deploy to Railway', 'Deploy to Netlify', 'Deploy to AWS', 'Deploy to Google Cloud']); await page.keyboard.press('Escape');
  expect((await props(page)).safeMode).toBe(true);
  await load(page);
  expect(await names(await open(page, 'deploy'))).not.toContain('Deploy to AWS'); await page.keyboard.press('Escape');
  await noMutation(page);
  // The sample bots keep their own order after hide, order and safe mode on a new task: nothing is hidden or reordered.
  await newTask(page);
  const bots = await names(await open(page, 'bot')); await page.keyboard.press('Escape');
  expect(bots[0]).toBe('No bot'); expect(bots).toEqual(expect.arrayContaining(['Scout', 'Writer', 'Bot notes']));
});

test('Task menus extension: captured actions run the original handlers once after a fresh choice; protected, stale and forged requests are refused', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]); await select(page);
  // The connected platforms are read once an owner is active; the presentation then names their set.
  await expect.poll(async () => (await props(page)).connection).not.toBe('');
  const initial = await props(page);
  expect(initial).toMatchObject({ visible: true, busy: false, menu: 'none', safeMode: false });
  expect(initial.team).toBe(''); expect(initial.bot).toBe('');
  expect(JSON.stringify(initial)).not.toMatch(/Vercel|Scout|session-|project-|Cheap|preview-only/);
  const teams = await ofKind(page, 'team-select');
  expect(teams.length).toBeGreaterThanOrEqual(4);
  expect(teams[0].enabled).toBe(false);
  expect(await ofKind(page, 'deploy-run')).toHaveLength(6);
  expect((await ofKind(page, 'deploy-run')).map((control: any) => control.enabled)).toEqual([true, false, false, true, false, false]);
  // No bot plus the four sample bots, while the task can still choose one; No bot is the current choice.
  expect((await ofKind(page, 'bot-assign')).map((control: any) => control.enabled)).toEqual([false, true, true, true, true]);
  // Choosing a team asks first; Escape declines and nothing is configured; Continue changes the team once.
  const balanced = teams.length - 2;
  expect(await act(page, 'team-select', {}, balanced)).toEqual({ ok: true });
  await expect(choice(page, 'Switch the team to Balanced team')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(choice(page, 'Switch the team to Balanced team')).toHaveCount(0);
  expect(await calls(page, 'architect_configure')).toEqual([]);
  expect(await act(page, 'team-select', {}, balanced)).toEqual({ ok: true });
  await choice(page, 'Switch the team to Balanced team').click();
  await expect.poll(async () => (await calls(page, 'architect_configure')).length).toBe(1);
  await expect(page.locator(TRIGGERS.team)).toHaveAttribute('data-on', '');
  expect((await props(page)).team).not.toBe('');
  // A team control for the kind the task already has is not offered.
  expect((await ofKind(page, 'team-select')).some((control: any) => !control.enabled)).toBe(true);
  // A plain task entry runs the original handler with no choice; Delete task asks first and keeps its own confirmation.
  expect(await act(page, 'task-run', {}, 1)).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Rename task' })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Rename task' })).toHaveCount(0);
  expect(await act(page, 'task-delete')).toEqual({ ok: true });
  await expect(choice(page, 'Delete this task')).toBeVisible(); await choice(page, 'Delete this task').click();
  await expect(page.getByRole('dialog', { name: 'Delete task?' })).toBeVisible();
  expect(await calls(page, 'delete_session')).toEqual([]);
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Delete task?' })).toHaveCount(0);
  expect(await calls(page, 'delete_session')).toEqual([]);
  // Sensitive and host-only operations named by a package are refused before anything else.
  for (const controlId of PROTECTED) for (const control of ['control-x', 'foreign']) expect(await act(page, controlId, { control, token: 'x' }), controlId).toEqual({ ok: false, reason: 'PermissionDenied' });
  for (const change of [{ selector: '.deploy-menu' }, { text: 'hello' }, { token: 'preview-only' }, { window: 'tray' }, { requestId: '' }]) expect(await act(page, 'deploy-run', change)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'deploy-run', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // A platform that is not connected is not available.
  expect(await act(page, 'deploy-run', {}, 4)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // Stale: another task, team, connection set, bot or revision, a forged resource or control.
  for (const change of [{ task: 'foreign' }, { team: 'foreign' }, { connection: 'foreign' }, { bot: 'foreign' }, { project: 'foreign' }, { context: 'foreign' }, { revision: 0 }, { control: 'foreign' }, { resource: 'foreign' }]) expect(await act(page, 'deploy-run', change), JSON.stringify(change)).toEqual({ ok: false, reason: 'StaleContext' });
  // A request built for one task is refused after switching to another; a replay is refused.
  const stale = await build(page, 'deploy-run');
  await row(page, 'session-4').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-4');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  await row(page, 'session-2').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  // Busy while a host menu is open.
  const list = await open(page, 'deploy');
  expect(await act(page, 'deploy-run')).toEqual({ ok: false, reason: 'Busy' }); expect((await props(page)).menu).toBe('deploy');
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
  // Deploying asks first; declining starts nothing, and a replay is refused.
  const request = await build(page, 'deploy-run');
  expect(await send(page, request)).toEqual({ ok: true });
  await expect(choice(page, 'Deploy to Vercel and start its task')).toBeVisible();
  await page.keyboard.press('Escape'); expect(await calls(page, 'send_message')).toEqual([]); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  expect(await send(page, request)).toEqual({ ok: false, reason: 'AlreadyApplied' });
});

test('Task menus extension: a deploy and a bot assignment run once after a fresh choice, and setup opens from a captured action', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]); await select(page);
  // Deploying asks first and starts one task with the platform's brief, once (after the platforms are read).
  await expect.poll(async () => (await props(page)).connection).not.toBe('');
  expect(await act(page, 'deploy-run')).toEqual({ ok: true });
  await choice(page, 'Deploy to Vercel and start its task').click();
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  expect((await calls(page, 'send_message'))[0].args.text).toMatch(/^Deploy this project to Vercel\./);
  // The brief went to a new task, not to the task the menu was opened on, and carries no credential.
  expect((await calls(page, 'send_message'))[0].args.sessionId).not.toBe('session-2');
  expect(JSON.stringify(await calls(page, 'send_message'))).not.toContain('preview-only');
  const fresh = await newTask(page);
  const bots = await ofKind(page, 'bot-assign');
  expect(bots.length).toBeGreaterThanOrEqual(5); expect(bots[0].enabled).toBe(false);
  expect(JSON.stringify(await props(page))).not.toMatch(/Scout|Writer/);
  expect(await act(page, 'bot-assign', {}, 1)).toEqual({ ok: true });
  await expect(page.getByRole('menuitemradio', { name: /^Continue: Start this task with / })).toBeVisible();
  await page.keyboard.press('Escape'); expect(await calls(page, 'bot_assign_task')).toEqual([]);
  expect(await act(page, 'bot-assign', {}, 1)).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: /^Continue: Start this task with / }).click();
  await expect.poll(async () => (await calls(page, 'bot_assign_task')).length).toBe(1);
  expect((await calls(page, 'bot_assign_task'))[0].args).toMatchObject({ sessionId: fresh });
  await expect(page.locator(TRIGGERS.bot)).not.toContainText('No bot');
  expect((await props(page)).bot).not.toBe('');
  // No bot goes back through the same choice.
  expect(await act(page, 'bot-assign', {}, 0)).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Start this task without a bot' }).click();
  await expect.poll(async () => (await calls(page, 'bot_assign_task')).length).toBe(2);
  await expect(page.locator(TRIGGERS.bot)).toContainText('No bot');
  // Architect & workers opens from a captured action (the Team button is the anchor).
  await page.evaluate(() => { localStorage.setItem('pandacode.teamClassic', 'true'); window.dispatchEvent(new CustomEvent('pandacode:team-mode', { detail: true })); });
  await expect(page.getByRole('button', { name: 'Architect & workers', exact: true })).toBeVisible();
  expect(await act(page, 'team-setup-open')).toEqual({ ok: true });
  await expect(page.getByRole('heading', { name: 'Architect & workers', exact: true })).toBeVisible();
  expect((await props(page)).menu).toBe('setup');
  expect(await act(page, 'team-setup-open')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape');
  expect(await calls(page, 'architect_configure')).toEqual([]);
});

test('Task menus extension: conflict, fault, disable and safe mode keep the task, team setup and bot assignment with no duplicate action', async ({ page }) => {
  test.setTimeout(120_000);
  const rival = structuredClone(manifest);
  rival.id = 'other.task-menus'; delete rival.contributes.components; delete rival.contributes.layouts;
  rival.permissions = ['ui.contribute'];
  rival.contributes.commands = rival.contributes.commands.map((command: any) => ({ ...command, id: command.id.replace('sample.task-menus', 'other.task-menus') }));
  rival.contributes.menus = rival.contributes.menus.map((menu: any) => ({ ...menu, id: menu.id.replace('sample.task-menus', 'other.task-menus'), command: menu.command.replace('sample.task-menus', 'other.task-menus') }));
  await setup(page, [manifest, rival]); await select(page);
  // Two owners contribute to the same menus: each item appears once, the host's rows once.
  let list = await open(page, 'task');
  const task = await names(list);
  expect(task.filter(name => name === 'Task notes')).toHaveLength(2); expect(task.filter(name => name === 'Delete task…')).toHaveLength(1); expect(task.filter(name => name === 'Rename task')).toHaveLength(1);
  await page.keyboard.press('Escape');
  // Disabling the rival leaves one item and the same host rows.
  await page.evaluate(() => (window as any).__previewDisableExtension('other.task-menus'));
  list = await open(page, 'task'); expect((await names(list)).filter(name => name === 'Task notes')).toHaveLength(1); await page.keyboard.press('Escape');
  // A fault of the selected composer recipe revokes captured actions; the menus stay usable and nothing ran.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'deploy-run')).toEqual({ ok: false, reason: 'Revoked' });
  list = await open(page, 'deploy'); await expect(list.getByRole('menuitem', { name: 'Deploy to Vercel', exact: true })).toBeEnabled(); await page.keyboard.press('Escape');
  // Disabling the owner while its menu is open closes the menu without running anything; the host's rows return.
  list = await open(page, 'team');
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.task-menus'));
  await expect(list).toHaveCount(0);
  list = await open(page, 'team'); expect(await names(list)).toEqual(['No team', 'Cheap team', 'Balanced team', 'Best team']);
  await expect(list.getByRole('menuitemradio', { name: 'No team', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
  expect(await act(page, 'team-select')).toEqual({ ok: false, reason: 'Revoked' });
  // Bot assignment keeps its radios and the task keeps its Task actions.
  await newTask(page);
  list = await open(page, 'bot'); await expect(list.getByRole('menuitemradio', { name: 'No bot', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
  expect(await names(await open(page, 'task'))).toEqual(expect.arrayContaining(['Pin task', 'Delete task…'])); await page.keyboard.press('Escape');
  // Safe mode: nothing contributes and every captured action is revoked.
  await page.evaluate(() => (window as any).__previewTaskMenusSafeMode());
  expect((await props(page)).safeMode).toBe(true);
  expect(await act(page, 'bot-assign')).toEqual({ ok: false, reason: 'Revoked' });
  expect(await names(await open(page, 'task'))).not.toContain('Task notes'); await page.keyboard.press('Escape');
  await noMutation(page);
});
