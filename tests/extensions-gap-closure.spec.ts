import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Integrated gap closure (T60K): every fixture package delivered for the 49 T60 gaps is installed in ONE page together
// with the T60A fixture (project scope) and the shared preview flags of all families. Browser fixtures only: the
// extensions baseline transport, a held synthetic run, the preview's seeded threads, bots and council. No task is sent
// to a real harness; installed WebView qualification is separate and not claimed by this file.
const NAMES = ['sample-project-helper', 'composer-controls', 'composer-panels', 'composer-attach', 'thread-extras', 'tiles-picker', 'commands-extras', 'task-menus', 'window-menus', 'bot-conversation'];
const PACKAGES = NAMES.map(name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8')));
const FLAGS = ['composer-controls', 'composer-panels', 'composer-attach', 'thread-extras', 'tiles-picker', 'commands-extras', 'task-menus', 'window-menus', 'bot-conversation'];
const BASE = `/?extensions-baseline&${FLAGS.join('&')}&replacement&bots=sample&council=asking`;
const STORE = 'pandacode.preview.extensions.v1';
const prompt = (page: Page) => page.locator('#prompt');
const toast = (page: Page) => page.locator('#toast');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tile = (page: Page, id: string) => page.locator(`.thread-tile[data-tile="${id}"]`);
const menu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
/** A host menu: trigger selector and accessible name. */
const MENUS = {
  view: ['#view-menu', 'Workspace view'], sort: ['#sidebar-sort', 'Sort and view'], filter: ['#project-filter', 'Filter projects'],
  team: ['#team-trigger', 'Team'], task: ['#task-menu-trigger', 'Task actions'], deploy: ['#deploy-button', 'Deploy'], bot: ['#composer-bot', 'Bot'],
} as const;
const CORE = ['#prompt', '#model-picker-trigger', '#mode-picker-trigger', '#composer .composer-team-button', '#composer .composer-saver-button', '#composer .composer-council-button', '#view-menu', '#sidebar-sort', '#project-filter', '#team-trigger', '#task-menu-trigger', '#deploy-button', '.sidebar-bots-bar', '.new-task-button'];

async function setup(page: Page, packages: unknown[] = PACKAGES) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ packages, store }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true, runScript: true };
    if (!localStorage.getItem(store)) localStorage.setItem(store, JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, store: STORE });
  await load(page);
}
/** A page load: a cold preview server compiles on its first load, so only readiness waits longer. */
async function load(page: Page) {
  await page.goto(BASE); await expect(prompt(page)).toBeEnabled({ timeout: 20_000 });
  for (const hook of ['__previewComposer', '__previewPanels', '__previewAttach', '__previewThreadExtras', '__previewTiles', '__previewCommands', '__previewTaskMenus', '__previewWindowMenus', '__previewBotConversation']) {
    await expect.poll(() => page.evaluate(hook => Boolean((window as any)[hook]?.()), hook), { timeout: 20_000, message: hook }).toBe(true);
  }
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
/** Every contribution marker in the page, hidden ones included, sorted. */
const read = (page: Page) => page.evaluate(() => [...document.querySelectorAll('[data-extension-contribution]')].map(node => node.getAttribute('data-extension-contribution')!).sort());
/** The same list once it stopped changing: adoptions mount as the extensions load. */
async function mounts(page: Page) {
  let last = await read(page);
  for (let attempt = 0; attempt < 20; attempt++) {
    await page.waitForTimeout(400);
    const next = await read(page);
    if (JSON.stringify(next) === JSON.stringify(last)) return next;
    last = next;
  }
  return last;
}
/** The contributions of the Codex task (composer and steer slots) then of the limited first task, as one sorted list. */
async function both(page: Page) {
  const all: string[] = [];
  for (const id of ['session-2', 'session-1']) { await pickSession(page, id); all.push(...await mounts(page)); }
  return all.sort();
}
async function open(page: Page, kind: keyof typeof MENUS) {
  await page.locator(MENUS[kind][0]).click(); const list = menu(page, MENUS[kind][1]); await expect(list).toBeVisible(); return list;
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
async function clickContributed(page: Page, trigger: Locator | null, kind: keyof typeof MENUS | null, title: string, tags: string) {
  if (kind) { const list = await open(page, kind); await list.getByRole('menuitem', { name: title, exact: true }).click(); } else await trigger!.click();
  return captured(page, tags);
}
async function pickSession(page: Page, id: string) { await row(page, id).click(); await expect(row(page, id)).toHaveAttribute('aria-current', 'page'); await expect(prompt(page)).toHaveAttribute('data-session-id', id); }
const coreIntact = async (page: Page, when: string) => { for (const selector of CORE) await expect(page.locator(selector).first(), `${when}: ${selector}`).toBeVisible(); };
const listed = (page: Page) => page.locator('.choice-menu-option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
const noMutation = async (page: Page) => {
  for (const command of ['steer_task', 'stop_session', 'delete_session', 'remove_project', 'add_project', 'bot_assign_task', 'bot_set_paused', 'bot_delete', 'bot_update', 'schedule_create', 'schedule_delete', 'recipes_save', 'recipes_delete', 'queue_remove', 'queue_reorder', 'connection_assign', 'architect_configure', 'architect_council_accept']) expect(await calls(page, command), command).toEqual([]);
};
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };

test('Gap closure extension: all fixture packages together mount each contribution once, as they do alone, with no conflict and every core control', async ({ page }) => {
  test.setTimeout(180_000);
  await setup(page);
  const together = await both(page);
  expect(together.length).toBeGreaterThan(0);
  // A contribution mounts once per task view it belongs to, never twice in the same view.
  for (const id of ['session-2', 'session-1']) { await pickSession(page, id); const view = await mounts(page); expect(new Set(view).size, `a contribution mounted twice in ${id}`).toBe(view.length); }
  // Each package alone mounts the same contributions it mounts here: nothing lost, nothing added, nothing duplicated.
  const alone: string[] = [];
  for (const manifest of PACKAGES) {
    await page.evaluate(({ store, manifest }) => localStorage.setItem(store, JSON.stringify([{ manifest, enabled: true, icons: {} }])), { store: STORE, manifest });
    await load(page); alone.push(...await both(page));
  }
  expect(together).toEqual(alone.sort());
  await page.evaluate(({ store, packages }) => localStorage.setItem(store, JSON.stringify(packages.map((manifest: unknown) => ({ manifest, enabled: true, icons: {} })))), { store: STORE, packages: PACKAGES });
  await load(page);
  expect(await both(page)).toEqual(together);
  await coreIntact(page, 'all packages');
  // The Extensions page lists every package once and reports no rejected, corrupt or unavailable package.
  const region = await explorer(page);
  for (const manifest of PACKAGES) await expect(page.getByRole('button', { name: `Disable ${manifest.id}`, exact: true }).or(page.getByRole('switch', { name: new RegExp(manifest.id) })).first(), manifest.id).toBeAttached();
  const statuses = await page.locator('[role="status"]').allTextContents();
  expect(statuses.filter(text => /rejected|Corrupt|unavailable|Duplicate|conflict/i.test(text))).toEqual([]);
  await expect(region).toBeVisible();
  await back(page);
  await coreIntact(page, 'after the Extensions page');
});

test('Gap closure extension: contributed actions of every family are clicked in one page and run with their own captured target', async ({ page }) => {
  test.setTimeout(300_000);
  await setup(page);
  // Window menus: the contributed main view opens through the view navigation; Sort and Filter items capture selections.
  let list = await open(page, 'view');
  await list.getByRole('menuitem', { name: 'Window notes', exact: true }).click();
  await expect(page.locator('.extension-inspector-view')).toContainText('A contributed main view opened from the Workspace view menu.');
  expect(await page.locator('#view-menu').getAttribute('aria-label')).toBe('Workspace view: Conversation');
  expect(await clickContributed(page, null, 'sort', 'Sort notes', 'Sort tags')).toMatchObject({ surfaceId: 'panda.sidebar.sort.menu', selection: { kind: 'sidebar-sort' } });
  expect(await clickContributed(page, null, 'filter', 'Filter notes', 'Filter tags')).toMatchObject({ surfaceId: 'panda.projects.filter.menu', selection: { kind: 'project-filter', ids: ['all-projects'] } });
  // Task menus on the Codex task: team, task and deploy items with the captured task.
  await pickSession(page, 'session-2');
  expect(await clickContributed(page, null, 'team', 'Team notes', 'Team tags')).toMatchObject({ surfaceId: 'panda.team.menu', sessionId: 'session-2', selection: { kind: 'team', ids: ['session-2'] } });
  expect(await clickContributed(page, null, 'task', 'Task notes', 'Task tags')).toMatchObject({ surfaceId: 'panda.task.menu', sessionId: 'session-2', selection: { kind: 'task', ids: ['session-2'] } });
  expect(await clickContributed(page, null, 'deploy', 'Deploy notes', 'Deploy tags')).toMatchObject({ surfaceId: 'panda.deploy.menu', sessionId: 'session-2', selection: { kind: 'connection', ids: ['vercel', 'netlify'] } });
  // Commands: a package slash command runs its package command; the command center carries the contributed action.
  await prompt(page).click(); await prompt(page).fill('/no');
  const slash = page.getByRole('dialog', { name: 'Slash commands', exact: true });
  await expect(slash).toBeVisible();
  await expect(slash.locator('.slash-menu-option:not([hidden])').filter({ has: page.locator('strong', { hasText: /^\/notes$/ }) })).toBeVisible();
  await prompt(page).press('Enter'); await expect(prompt(page)).toHaveValue('/notes ');
  await prompt(page).pressSequentially('release plan'); await prompt(page).press('Enter');
  await expect(page.getByRole('dialog', { name: 'Slash notes' })).toBeVisible();
  expect(await captured(page, 'Slash tags')).toMatchObject({ surfaceId: 'panda.commands.slash', sessionId: 'session-2', slash: { command: 'sample.commands-extras/notes', arguments: 'release plan' } });
  await expect(prompt(page)).toHaveValue('');
  await prompt(page).fill('/usage'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  const center = page.locator('#dialog.command-center-dialog[open]');
  await expect(center).toBeVisible();
  await center.locator('[data-extension-contribution="sample.commands-extras/harness"]').click();
  expect(await captured(page, 'Harness tags')).toMatchObject({ surfaceId: 'panda.commands.harness.actions', sessionId: 'session-2', selection: { kind: 'harness-command', ids: ['codex:usage'] } });
  await center.getByRole('button', { name: 'Done', exact: true }).click(); await expect(center).toHaveCount(0);
  // Composer controls: the model picker and Permissions rows.
  await page.locator('#model-picker-trigger').click(); await expect(page.locator('.model-menu')).toBeVisible();
  await page.locator('.model-menu-extensions').getByRole('button', { name: 'Model notes', exact: true }).click();
  await expect(toast(page)).toContainText('The model choice stays with PandaCode.');
  await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0);
  await page.locator('#mode-picker-trigger').click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await permissions.getByRole('menuitem', { name: 'Permission notes', exact: true }).click();
  await expect(toast(page)).toContainText('Approval modes stay host authority.');
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'ask');
  // Composer attach: the Attach menu, the recipe and the quick add.
  await prompt(page).fill('Draft kept across every action');
  await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
  const attach = page.getByRole('dialog', { name: 'Attach', exact: true });
  await expect(attach).toBeVisible();
  expect((await listed(page)).at(-1)).toBe('Attach notes');
  await attach.getByRole('menuitem', { name: 'Attach notes', exact: true }).click();
  await expect(toast(page)).toContainText('Draft attachments stay with PandaCode.');
  await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
  await attach.getByRole('menuitem', { name: 'Workflow recipes…', exact: true }).click();
  const recipes = page.locator('#recipes-body');
  await recipes.getByRole('button', { name: /review-diff/ }).click();
  await recipes.getByRole('button', { name: 'Recipe notes', exact: true }).click();
  await expect(toast(page)).toContainText('Recipe steps stay with PandaCode.');
  await page.keyboard.press('Escape'); await expect(recipes).toBeHidden();
  await page.getByRole('button', { name: 'Attach files for context', exact: true }).click();
  await attach.getByRole('menuitem', { name: 'Schedule a wake-up…', exact: true }).click();
  const wake = page.getByRole('dialog', { name: 'Wake this thread later', exact: true });
  await wake.getByRole('button', { name: 'Wake notes', exact: true }).click();
  await expect(toast(page)).toContainText("Wake-ups stay the user's choice.");
  await wake.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(wake).toHaveCount(0);
  // Composer panels: the token saver panel.
  await page.locator('#composer .composer-saver-button').click(); await expect(page.locator('.saver-panel')).toBeVisible();
  await page.locator('.saver-panel').getByRole('button', { name: 'Saver notes', exact: true }).click();
  await expect(toast(page)).toContainText("Token saver packs stay the user's choice.");
  await page.keyboard.press('Escape'); await expect(page.locator('.saver-panel')).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Draft kept across every action');
  // Thread extras and the council strip on the first task (its usage limit, saved changes, attachments and council cycle).
  await pickSession(page, 'session-1');
  const banner = page.getByRole('region', { name: 'Usage limit', exact: true });
  await banner.locator('[data-extension-contribution="sample.thread-extras/limit"]').click();
  expect(await captured(page, 'Limit tags')).toMatchObject({ surfaceId: 'panda.thread.usage-limit.actions', sessionId: 'session-1', selection: { kind: 'usage-limit', ids: ['claude'] } });
  await page.locator('[data-extension-contribution="sample.thread-extras/attachments"]').first().click();
  expect(await captured(page, 'Attachment tags')).toMatchObject({ surfaceId: 'panda.thread.attachments.actions', sessionId: 'session-1', selection: { kind: 'message-attachment' } });
  await page.locator('[data-extension-contribution="sample.thread-extras/changes"]').first().click();
  expect(await captured(page, 'Turn tags')).toMatchObject({ surfaceId: 'panda.thread.changes.actions', selection: { kind: 'turn-changes' } });
  await prompt(page).focus(); await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread', exact: true });
  await expect(find).toBeFocused(); await find.fill('keyboard');
  await page.getByRole('search').locator('[data-extension-contribution="sample.thread-extras/find"]').click();
  expect(await captured(page, 'Find tags')).toMatchObject({ surfaceId: 'panda.thread.find.actions', selection: { kind: 'find', ids: ['session-1'] } });
  await expect(find).toHaveValue('keyboard');
  await find.focus(); await find.press('Escape'); await expect(page.getByRole('search')).toHaveCount(0);
  await page.locator('#composer .council-strip [data-extension-contribution="sample.composer-panels/council"]').click();
  await expect(toast(page)).toContainText('Council decisions stay with the user.');
  // Tiles: the mirror's own bar action names the mirror's thread, then the draft picker and the bot assignment menu.
  await row(page, 'session-2').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  const mirror = await clickContributed(page, tile(page, 'session-1').locator('[data-extension-contribution="sample.tiles-picker/tile"]'), null, '', 'Tile tags');
  expect(mirror).toMatchObject({ surfaceId: 'panda.workspace.tiles.actions', sessionId: 'session-1', selection: { kind: 'tile', ids: ['session-1'] } });
  await page.locator('.new-task-button').click();
  const draft = (await prompt(page).getAttribute('data-session-id'))!;
  await prompt(page).fill('A draft kept while the picker opens');
  await page.locator('#welcome-project').click();
  const picker = page.getByRole('dialog', { name: 'Choose project', exact: true });
  await expect(picker).toBeVisible();
  await picker.locator('[data-extension-contribution="sample.tiles-picker/draft"]').click();
  expect(await captured(page, 'Draft tags')).toMatchObject({ surfaceId: 'panda.workspace.project-picker.actions', sessionId: draft, selection: { kind: 'draft-project', ids: [draft] } });
  await page.keyboard.press('Escape'); await expect(picker).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('A draft kept while the picker opens');
  const bot = await clickContributed(page, null, 'bot', 'Bot notes', 'Bot tags');
  expect(bot).toMatchObject({ surfaceId: 'panda.bot.assignment', sessionId: draft, selection: { kind: 'bot' } });
  // A running turn: the queue row and the steer bar carry their contributed actions.
  await pickSession(page, 'session-2');
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await prompt(page).fill('Queued with notes'); await prompt(page).press('Enter');
  const queue = page.getByRole('region', { name: 'Queued messages', exact: true });
  await queue.locator('.queue-row').first().getByRole('button', { name: 'Queue notes', exact: true }).click();
  await expect(toast(page)).toContainText('Queued messages stay with PandaCode.');
  await prompt(page).fill('Keep this steer draft');
  await page.locator('#composer .composer-steer-bar').getByRole('button', { name: 'Steer notes', exact: true }).click();
  await expect(toast(page)).toContainText('Steering keeps the running turn and its draft.');
  await expect(prompt(page)).toHaveValue('Keep this steer draft');
  // Bots: the bot thread header and the shared channel carry their own actions.
  const bar = page.locator('.sidebar-bots-bar');
  if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
  const panel = page.getByRole('region', { name: 'Bots', exact: true });
  await panel.getByRole('button', { name: /^Chat with Ledger/ }).click();
  await expect(page.locator('#breadcrumb .bot-crumb')).toContainText('Ledger');
  const limit = page.getByRole('region', { name: 'Usage limit' });
  if (await limit.isVisible()) await limit.getByRole('button', { name: 'Dismiss usage limit' }).click();
  await page.locator('[data-extension-contribution="sample.bot-conversation/thread"]').click();
  expect(await captured(page, 'Bot tags')).toMatchObject({ surfaceId: 'panda.bot.thread.actions', selection: { kind: 'bot' } });
  await panel.getByRole('button', { name: '#launch' }).click();
  await expect(page.locator('.conversation-pane.channel-thread .bc-channel')).toBeVisible();
  await page.locator('[data-extension-contribution="sample.bot-conversation/channel"]').click();
  expect(await captured(page, 'Channel tags')).toMatchObject({ surfaceId: 'panda.bot.channel.actions', selection: { kind: 'channel', ids: ['sample-launch'] } });
  // None of the clicks changed a host-owned object; the one usage-limit dismissal is the Ledger card's own button.
  await noMutation(page);
  expect(await calls(page, 'clear_usage_limit')).toHaveLength(1);
  // The package slash command never reached the harness; only the host's own /usage was resolved, once.
  expect((await calls(page, 'resolve_slash_command')).map((call: any) => call.args.text)).toEqual(['/usage']);
  expect((await calls(page, 'send_message')).map((call: any) => call.args.text ?? call.args.prompt)).toEqual(expect.arrayContaining(['Start synthetic work']));
});

test('Gap closure extension: disabling one package, a faulted recipe and safe mode keep the other families and every core control', async ({ page }) => {
  test.setTimeout(180_000);
  await setup(page);
  await pickSession(page, 'session-2');
  const before = await mounts(page);
  await prompt(page).fill('Draft that must survive');
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.window-menus'));
  // The window-menus owner leaves its three menus; every other family keeps its own contributions.
  await expect.poll(async () => (await mounts(page)).filter(id => id.startsWith('sample.window-menus/'))).toEqual([]);
  expect(await mounts(page)).toEqual(before.filter(id => !id.startsWith('sample.window-menus/')));
  await open(page, 'sort');
  expect(await listed(page)).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks']);
  await page.keyboard.press('Escape');
  const team = await open(page, 'team'); await expect(team.getByRole('menuitem', { name: 'Team notes', exact: true })).toHaveCount(1); await page.keyboard.press('Escape');
  await coreIntact(page, 'one package disabled');
  await expect(prompt(page)).toHaveValue('Draft that must survive');
  // A fault of the composer recipe revokes captured composer actions, never a mutation of the draft or the task.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  await coreIntact(page, 'faulted recipe');
  await expect(prompt(page)).toHaveValue('Draft that must survive');
  // Safe mode: nothing contributes, every captured action is revoked, and the core controls and the draft stay.
  await page.evaluate(() => (window as any).__previewComposerSafeMode());
  await expect.poll(() => mounts(page)).toEqual([]);
  for (const hook of ['__previewComposerAction', '__previewPanelsAction', '__previewAttachAction', '__previewThreadExtrasAction', '__previewTilesAction', '__previewPickerAction', '__previewCommandsAction', '__previewTaskMenusAction', '__previewWindowMenusAction', '__previewBotConversationAction']) {
    expect(await page.evaluate(hook => (window as any)[hook]({ contractVersion: 1, window: 'main', requestId: crypto.randomUUID() }), hook), hook).toEqual({ ok: false, reason: 'Revoked' });
  }
  await open(page, 'view');
  expect(await listed(page)).toEqual(['Conversation', 'Board', 'GitHub']);
  await page.keyboard.press('Escape');
  await coreIntact(page, 'safe mode');
  await expect(prompt(page)).toHaveValue('Draft that must survive');
  await noMutation(page);
});

test('Gap closure extension: project scope withholds every family while another project is active and restores it without a reload', async ({ page }) => {
  test.setTimeout(180_000);
  await setup(page);
  await pickSession(page, 'session-2');
  const inside = await mounts(page);
  const scoped = PACKAGES.filter(manifest => manifest.id !== 'sample.project-helper');
  await explorer(page);
  // Only the first project (orbit, the active one) keeps each family package; the T60A fixture stays on all projects.
  for (const manifest of scoped) {
    await page.getByRole('group', { name: `Projects for ${manifest.id}`, exact: true }).getByRole('radio', { name: 'Only selected projects', exact: true }).check();
    await expect(page.getByRole('group', { name: `Selected projects for ${manifest.id}`, exact: true }).getByRole('checkbox', { name: 'orbit', exact: true })).toBeChecked();
  }
  await back(page);
  expect(await mounts(page)).toEqual(inside);
  // Another project's task: the families contribute nothing, the T60A fixture still does, the host's own menus are whole.
  await pickSession(page, 'session-4');
  await expect.poll(() => mounts(page)).toEqual(inside.filter(id => id.startsWith('sample.project-helper/')));
  await open(page, 'sort'); expect(await listed(page)).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks']); await page.keyboard.press('Escape');
  await open(page, 'view'); expect(await listed(page)).toEqual(['Conversation', 'Board', 'GitHub']); await page.keyboard.press('Escape');
  await open(page, 'team'); expect(await listed(page)).not.toContain('Team notes'); await page.keyboard.press('Escape');
  await coreIntact(page, 'other project');
  // Back in the scoped project every family contributes again, once.
  await pickSession(page, 'session-2');
  await expect.poll(() => mounts(page)).toEqual(inside);
  await open(page, 'team'); expect(await listed(page)).toContain('Team notes'); await page.keyboard.press('Escape');
  await coreIntact(page, 'scoped project');
  await noMutation(page);
});
