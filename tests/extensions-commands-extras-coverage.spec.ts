import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with the preview's seeded threads (session-2 is a Codex task
// in the first project, session-1 a Claude task) and the preview's recorded slash catalogs and command center panels. No
// real harness runs; installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/commands-extras/extension.json', import.meta.url), 'utf8'));
const TOOLBAR = 'sample.commands-extras/toolbar';
const BASE = '/?extensions-baseline&commands-extras&replacement';
const props = (page: Page) => page.evaluate(() => (window as any).__previewCommands());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const menu = (page: Page) => page.getByRole('dialog', { name: 'Slash commands', exact: true });
const names = (page: Page) => menu(page).locator('.slash-menu-option:not([hidden]) .slash-menu-title strong').allTextContents();
const option = (page: Page, name: string) => menu(page).locator('.slash-menu-option:not([hidden])').filter({ has: page.locator('strong', { hasText: new RegExp(`^${name}$`) }) });
const center = (page: Page) => page.locator('#dialog.command-center-dialog[open]');
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}` });
const note = (page: Page) => page.locator('#composer-area .composer-inline-note');
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
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page) {
  await explorer(page);
  await page.getByLabel('Composer presentation', { exact: true }).selectOption(TOOLBAR);
  await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', TOOLBAR);
}
async function hide(page: Page, region: ReturnType<Page['locator']>, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: new RegExp(`^Hide ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( —|$)`) });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
/** Types into the composer so the slash menu opens with the catalog for the open task. */
async function type(page: Page, text: string) {
  await prompt(page).click(); await prompt(page).fill(text);
  await expect(menu(page)).toBeVisible(); await expect(menu(page).locator('.slash-menu-option:not([hidden])').first()).toBeVisible();
}
/** Opens the command center's contributed dialog or the slash command's dialog, loads its options (recording the
 * captured context) and cancels it. */
async function captured(page: Page, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}
const caret = (page: Page) => prompt(page).evaluate(node => [(node as HTMLTextAreaElement).selectionStart, (node as HTMLTextAreaElement).selectionEnd]);
const noInput = async (page: Page) => { for (const command of ['send_message', 'steer_message', 'architect_start']) expect(await calls(page, command), command).toEqual([]); };
function build(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewCommands(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, provider: p.provider, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewCommandsAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await build(page, controlId, changes, nth));

test('Commands extension: zero extensions keep the slash menu (filtering, IME, Enter/Escape) and the command center', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await type(page, '/re');
  expect(await names(page)).toEqual(expect.arrayContaining(['/resume', '/rename']));
  expect((await names(page)).every(name => name.startsWith('/re'))).toBe(true);
  await expect(menu(page).locator('.slash-menu-source', { hasText: 'sample.' })).toHaveCount(0);
  // Escape closes the menu and keeps the draft and the caret.
  await prompt(page).press('Escape'); await expect(menu(page)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('/re'); expect(await caret(page)).toEqual([3, 3]);
  // IME: a composition closes the menu and its committing Enter chooses nothing.
  await prompt(page).fill('/ren'); await expect(menu(page)).toBeVisible();
  await prompt(page).dispatchEvent('compositionstart'); await expect(menu(page)).toHaveCount(0);
  await prompt(page).evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })));
  await expect(prompt(page)).toHaveValue('/ren');
  await prompt(page).dispatchEvent('compositionend');
  // Enter chooses the highlighted entry: completion inserts its name only.
  await expect(option(page, '/rename')).toBeVisible();
  await prompt(page).press('Enter'); await expect(prompt(page)).toHaveValue('/rename '); await expect(menu(page)).toHaveCount(0);
  // The command center opens for the task with no contributed markup; captured actions have no owner.
  await prompt(page).fill('/usage'); await expect(menu(page)).toBeVisible(); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(center(page)).toBeVisible(); await expect(center(page).getByRole('heading', { name: 'Codex usage' })).toBeVisible();
  await expect(center(page).locator('.command-center-extensions, [data-extension-contribution]')).toHaveCount(0);
  expect(await props(page)).toMatchObject({ visible: true, panel: 'usage', safeMode: false, slash: 0 });
  expect(await act(page, 'harness-refresh')).toEqual({ ok: false, reason: 'Revoked' });
  await center(page).getByRole('button', { name: 'Done', exact: true }).click(); await expect(center(page)).toHaveCount(0);
  await noInput(page);
});

test('Commands extension: an installed package\'s slash command runs its package command with the captured task, harness and arguments; its command center action is clicked', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.commands-extras', exact: true }).click();
  await back(page);
  // Typed and chosen like any entry: the package's name, its source and its argument hint.
  await type(page, '/no');
  await expect(option(page, '/notes')).toBeVisible();
  await expect(option(page, '/notes').locator('.slash-menu-source')).toHaveText('sample.commands-extras');
  await expect(option(page, '/notes').locator('.slash-menu-title span')).toHaveText('[topic]');
  await prompt(page).press('Enter'); await expect(prompt(page)).toHaveValue('/notes ');
  await prompt(page).pressSequentially('release plan');
  await prompt(page).press('Enter');
  await expect(page.getByRole('dialog', { name: 'Slash notes' })).toBeVisible();
  const slash = await captured(page, 'Slash tags');
  expect(slash).toMatchObject({ surfaceId: 'panda.commands.slash', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'slash-command', ids: ['session-2'] }, slash: { command: 'sample.commands-extras/notes', provider: 'codex', arguments: 'release plan' } });
  // Nothing went to the harness; the sent draft is cleared once.
  await expect(prompt(page)).toHaveValue(''); await noInput(page);
  expect(await calls(page, 'resolve_slash_command')).toEqual([]);
  // A command without arguments refuses them and keeps the draft and the caret; sent bare it runs once.
  await prompt(page).fill('/ping now'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(note(page)).toContainText('/ping does not accept arguments');
  await expect(prompt(page)).toHaveValue('/ping now'); expect(await caret(page)).toEqual([9, 9]);
  await prompt(page).fill('/ping'); await prompt(page).press('Escape'); await prompt(page).press('Enter'); await prompt(page).press('Enter');
  await expect(page.locator('#toast')).toContainText('Ping from the commands extension.');
  await expect(prompt(page)).toHaveValue(''); await noInput(page);
  // The command center's contributed action is clicked and captures the panel's own task and harness.
  await prompt(page).fill('/usage'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(center(page)).toBeVisible();
  const harness = center(page).locator('.command-center-footer > .command-center-extensions [data-extension-contribution="sample.commands-extras/harness"]');
  await expect(harness).toBeVisible();
  await harness.click();
  const panel = await captured(page, 'Harness tags');
  expect(panel).toMatchObject({ surfaceId: 'panda.commands.harness.actions', projectId: 'project-1', sessionId: 'session-2', selection: { kind: 'harness-command', ids: ['codex:usage'] } });
  await expect(center(page)).toBeVisible();
  await center(page).getByRole('button', { name: 'Done', exact: true }).click(); await expect(center(page)).toHaveCount(0);
  // Another task's panel captures that task.
  await row(page, 'session-4').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-4');
  await prompt(page).fill('/hooks'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await center(page).locator('[data-extension-contribution="sample.commands-extras/harness"]').click();
  expect(await captured(page, 'Harness tags')).toMatchObject({ projectId: 'project-2', sessionId: 'session-4', selection: { kind: 'harness-command', ids: ['codex:hooks'] } });
  await noInput(page);
});

test('Commands extension: hide and order of PandaCode slash entries and harness entries persist and restore', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]);
  await type(page, '/');
  const built = await names(page);
  expect(built.indexOf('/new')).toBeLessThan(built.indexOf('/rename'));
  expect(built).toEqual(expect.arrayContaining(['/copy', '/usage', '/goal', '/notes', '/ping']));
  await prompt(page).press('Escape');
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.commands.slash.entries');
  await region.getByRole('button', { name: 'Grant UI customization and select Rename before New task', exact: true }).click();
  await hide(page, region, 'panda.commands.slash.entries', 'Copy response (/copy)');
  await hide(page, region, 'panda.commands.harness.entries', 'Account usage (/usage)');
  await hide(page, region, 'panda.commands.slash', '/ping');
  // /help never hides: it has no Hide control.
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.commands.slash.entries');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: /^Hide Help \(\/help\)/ })).toHaveCount(0);
  await back(page);
  for (const reload of [false, true]) {
    if (reload) await load(page);
    await type(page, '/');
    const arranged = await names(page);
    expect(arranged.indexOf('/rename'), reload ? 'after reload' : 'live').toBeLessThan(arranged.indexOf('/new'));
    for (const hidden of ['/copy', '/usage', '/ping']) expect(arranged).not.toContain(hidden);
    expect(arranged).toEqual(expect.arrayContaining(['/help', '/goal', '/notes', '/rename']));
    await prompt(page).press('Escape');
  }
  // A hidden entry still runs when typed: the harness command opens its panel.
  // (The menu lists no match for it; Escape closes it, as for any unlisted command.)
  await prompt(page).fill('/usage'); await expect(menu(page)).toContainText('Unknown command /usage'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(center(page).getByRole('heading', { name: 'Codex usage' })).toBeVisible();
  await center(page).getByRole('button', { name: 'Done', exact: true }).click();
  // Safe mode shows the built-in order and every entry without deleting the preferences; a normal launch restores them.
  await page.evaluate(() => (window as any).__previewCommandsSafeMode());
  await type(page, '/');
  const safe = await names(page);
  expect(safe.indexOf('/new')).toBeLessThan(safe.indexOf('/rename'));
  expect(safe).toEqual(expect.arrayContaining(['/copy', '/usage']));
  expect(safe).not.toContain('/notes');
  await prompt(page).press('Escape');
  await load(page);
  await type(page, '/');
  expect(await names(page)).not.toContain('/copy');
  await noInput(page);
});

test('Commands extension: captured actions open harness panels after a fresh choice; protected, stale and forged requests are refused', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]); await select(page);
  await type(page, '/'); await prompt(page).press('Escape');
  await prompt(page).fill('');
  const initial = await props(page);
  expect(initial).toMatchObject({ visible: true, busy: false, menu: false, panel: 'none', slash: 2 });
  expect(initial.controls.filter((control: any) => control.controlId === 'harness-open').length).toBe(6);
  expect(JSON.stringify(initial)).not.toMatch(/notes|usage|session-2|codex/);
  // Opening a panel asks first; Escape declines and nothing opens.
  expect(await act(page, 'harness-open', {}, 1)).toEqual({ ok: true });
  await expect(choice(page, 'Open Account usage (/usage)')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(choice(page, 'Open Account usage (/usage)')).toHaveCount(0);
  await expect(center(page)).toHaveCount(0);
  expect(await act(page, 'harness-open', {}, 1)).toEqual({ ok: true });
  await choice(page, 'Open Account usage (/usage)').click();
  await expect(center(page).getByRole('heading', { name: 'Codex usage' })).toBeVisible();
  expect((await props(page)).panel).toBe('usage');
  // Refresh and Done act on the open panel itself.
  const loads = (await calls(page, 'codex_command')).length;
  expect(await act(page, 'harness-refresh')).toEqual({ ok: true });
  await expect.poll(async () => (await calls(page, 'codex_command')).length).toBeGreaterThan(loads);
  // Sending, writing or reading the draft, panel changes and consoles are refused before anything else.
  for (const controlId of ['slash-send', 'slash-insert', 'slash-read-draft', 'harness-execute', 'console-open']) expect(await act(page, controlId, { text: '/notes hi' })).toEqual({ ok: false, reason: 'PermissionDenied' });
  for (const change of [{ selector: '.slash-menu' }, { text: 'hello' }, { window: 'tray' }]) expect(await act(page, 'harness-refresh', change)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'harness-close')).toEqual({ ok: true });
  await expect(center(page)).toHaveCount(0);
  // A request built before the draft changed is stale; a replay is refused.
  const stale = await build(page, 'harness-open');
  await prompt(page).fill('an edited draft');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  const fresh = await build(page, 'harness-open');
  expect(await send(page, fresh)).toEqual({ ok: true });
  await page.keyboard.press('Escape');
  expect(await send(page, fresh)).toEqual({ ok: false, reason: 'AlreadyApplied' });
  await expect(prompt(page)).toHaveValue('an edited draft');
  await noInput(page);
});

test('Commands extension: conflict, fault, disable and safe mode keep the draft and caret with no duplicate dispatch', async ({ page }) => {
  test.setTimeout(90_000);
  const rival = structuredClone(manifest);
  rival.id = 'other.commands'; delete rival.contributes.components; delete rival.contributes.layouts; delete rival.contributes.menus;
  rival.permissions = ['ui.contribute'];
  rival.contributes.commands = rival.contributes.commands.map((command: any) => ({ ...command, id: command.id.replace('sample.commands-extras', 'other.commands') }));
  rival.contributes.slashCommands = [{ ...manifest.contributes.slashCommands[0], id: 'other.commands/notes', command: 'other.commands/slash-notes' }, { id: 'other.commands/rename', name: '/rename', description: 'A name PandaCode keeps', command: 'other.commands/ping' }];
  await setup(page, [manifest, rival]); await select(page);
  // Two packages declare /notes and one declares PandaCode's /rename: they are listed unavailable with the reason.
  await type(page, '/no');
  const notes = menu(page).locator('.slash-menu-option:not([hidden])').filter({ hasText: '/notes' });
  await expect(notes).toHaveCount(2);
  for (const entry of await notes.all()) { await expect(entry).toBeDisabled(); await expect(entry).toContainText('Conflict: more than one extension declares /notes'); }
  await prompt(page).press('Enter'); await expect(prompt(page)).toHaveValue('/no');
  await prompt(page).fill('/rena');
  await expect(menu(page).locator('.slash-menu-option:not([hidden])').filter({ hasText: 'other.commands' })).toContainText('Conflict: /rename');
  // Sent, a conflicting name runs nothing from either package: the host keeps /notes unknown and the draft stays.
  await prompt(page).fill('/notes keep this'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(page.locator('#toast')).toContainText('Unknown command /notes');
  await expect(prompt(page)).toHaveValue('/notes keep this'); expect(await caret(page)).toEqual([16, 16]);
  await expect(page.getByRole('dialog', { name: 'Slash notes' })).toHaveCount(0);
  // PandaCode's /rename keeps its name: one rename through the host, no package dialog or message.
  await prompt(page).fill('/rename Commands checked'); await prompt(page).press('Escape'); await prompt(page).press('Enter');
  await expect(row(page, 'session-2')).toContainText('Commands checked');
  expect((await calls(page, 'update_session')).filter((call: any) => call.args.title === 'Commands checked')).toHaveLength(1);
  await expect(page.locator('[data-extension-dialog], dialog[open]')).toHaveCount(0);
  // Disabling the rival restores the package's own /notes.
  await page.evaluate(() => (window as any).__previewDisableExtension('other.commands'));
  await type(page, '/no'); await expect(option(page, '/notes')).toBeEnabled(); await prompt(page).press('Escape');
  // A fault of the selected composer recipe revokes captured actions; the draft stays and slash commands still work.
  await prompt(page).fill('/notes after fault'); await prompt(page).press('Escape');
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'harness-open')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(prompt(page)).toHaveValue('/notes after fault');
  // Disabled between typing and sending: the command does not run, the draft and caret stay, nothing is sent.
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.commands-extras'));
  await prompt(page).focus(); await prompt(page).press('End'); await prompt(page).press('Enter');
  await expect(page.locator('#toast')).toContainText('Unknown command /notes');
  await expect(prompt(page)).toHaveValue('/notes after fault'); expect(await caret(page)).toEqual([18, 18]);
  await expect(page.getByRole('dialog', { name: 'Slash notes' })).toHaveCount(0);
  // Safe mode: no package entries or captured actions; the draft stays.
  await page.evaluate(() => (window as any).__previewCommandsSafeMode());
  await type(page, '/');
  expect(await names(page)).not.toContain('/notes'); await prompt(page).press('Escape');
  expect((await props(page)).safeMode).toBe(true);
  expect(await act(page, 'harness-refresh')).toEqual({ ok: false, reason: 'Revoked' });
  await noInput(page);
});
