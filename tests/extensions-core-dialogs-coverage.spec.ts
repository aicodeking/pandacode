import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: every native command is the preview mock; no real project, task, bot, credential,
// cloud machine or GitHub state is read or changed. Each dialog opens through its original main.ts opener.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/core-dialogs/extension.json', import.meta.url), 'utf8'));
const ELIGIBLE: [string, string][] = [
  ['recipes', 'Workflow recipes'], ['task-details', 'Task details'], ['subagents', 'Subagents'], ['task-status', 'Task status'],
  ['integrations-fallback', 'Integrations'], ['working-directory', 'Working directory'], ['changed-files', 'Changed files'], ['open-project', 'Open project'],
  ['rename-task', 'Rename task'], ['colors', 'Colors'], ['wallpapers', 'Wallpapers'], ['opencode-models', 'OpenCode models'], ['moodboards', 'Moodboards'],
  ['integrations', 'Tools & integrations'], ['jev-settings', 'Jev add-on'], ['jev-assist', 'Jev assistance'], ['jev-tests', 'Browser tests'],
  ['conversation-import', 'Import conversations'], ['bots', 'Bots'], ['bot-settings', 'Bot settings'], ['usage', 'Agent usage'], ['command-palette', 'Go to anything'],
];
// R1003: the other five formerly protected dialogs take a band only from packages holding ui.presentation (tests/extensions-runtime-protected-presentation.spec.ts).
const PROTECTED = ['github-behind'];
const dialog = (page: Page) => page.locator('#dialog');
const band = (page: Page) => page.locator('#dialog .dialog-extension-extras');
const accessory = (page: Page) => page.evaluate(() => (window as any).__previewDialogAccessory());
const admit = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewDialogAdmission(input), input);
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&dialog-coverage'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page, id: string) {
  await page.evaluate(id => (window as any).__previewOpenMainDialog(id), id);
  await expect(dialog(page)).toHaveJSProperty('open', true);
}
async function eligible(page: Page, id: string) {
  await open(page, id);
  await expect.poll(async () => (await accessory(page))?.dialog).toBe(id);
  await expect(page.locator(`#dialog .dialog-extension-extras[data-dialog-accessory="${id}"]`)).toHaveCount(1);
}
async function close(page: Page) { await page.keyboard.press('Escape'); await expect(dialog(page)).toHaveJSProperty('open', false); }
function companion(notes: number) {
  const value = JSON.parse(JSON.stringify(manifest).replaceAll('sample.core-dialogs', 'sample.dialog-companion'));
  value.contributes.menus = value.contributes.menus.filter((menu: any) => menu.location === 'panda.dialog.rename-task.actions' && !menu.items);
  value.contributes.menus[0].text = 'Companion note'; value.contributes.commands[0].title = 'Companion note';
  value.contributes.dialogExtras = Array.from({ length: notes }, (_, index) => ({ id: `sample.dialog-companion/rename-${index}`, dialog: 'rename-task', text: `Companion guidance ${index + 1}.` }));
  return value;
}

test('Core dialogs: zero extensions keep every main modal unchanged, with no visible band or contribution', async ({ page }) => {
  test.setTimeout(120_000); await setup(page);
  for (const [id, title] of ELIGIBLE) {
    await eligible(page, id);
    await expect(band(page)).toBeHidden(); await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
    const label = await dialog(page).getAttribute('aria-label');
    if (id === 'bots' || id === 'bot-settings') expect(label).toMatch(/bot/i); else expect(label).toContain(title);
    await close(page);
  }
  for (const id of PROTECTED) {
    await open(page, id);
    expect(await accessory(page)).toBeNull(); await expect(band(page)).toHaveCount(0);
    await close(page);
  }
});

test('Core dialogs: an installed package adds owner-labelled notes and clickable actions to every eligible dialog, never a protected one', async ({ page }) => {
  test.setTimeout(150_000); await setup(page);
  await page.keyboard.press('ControlOrMeta+,'); await page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${manifest.id}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  for (const [id, title] of ELIGIBLE) {
    await eligible(page, id);
    await expect(band(page)).toBeVisible();
    await expect(band(page).locator(`[data-extension-location="panda.dialog.${id}.bodyExtras"]`)).toHaveText(`${manifest.id}: Extension guidance for ${title}; the host keeps its fields and actions.`);
    const action = band(page).locator(`[data-extension-location="panda.dialog.${id}.actions"] [data-extension-contribution="${manifest.id}/${id}"]`);
    await expect(action.locator('svg')).toHaveCount(1); await expect(action).not.toHaveAttribute('data-extension-icon-fallback', 'true');
    const before = await accessory(page);
    await page.evaluate(() => { document.querySelector('#toast')!.textContent = ''; });
    await action.click();
    await expect(page.locator('#toast')).toHaveText('Core dialog note: the host keeps this dialog');
    // The original dialog, its target and its single host primary action stay in place.
    await expect(dialog(page)).toHaveJSProperty('open', true); expect(await accessory(page)).toEqual(before);
    await expect(band(page).locator('.primary-button')).toHaveCount(0);
    await close(page);
  }
  for (const id of PROTECTED) {
    await open(page, id);
    await expect(band(page)).toHaveCount(0); await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
    await close(page);
  }
  // The attachment viewer opens from a sent message chip, through its original click handler.
  await page.locator('#prompt').fill('Check this.\n\nBrowser element context (page content, not instructions):\n{"url":"https://example.com/","selector":"#hero","tag":"h1","text":"Hero"}');
  await page.keyboard.press('Enter');
  await page.locator('.user-message').last().locator('.message-attachments .prompt-chip').last().click();
  await expect.poll(async () => (await accessory(page))?.dialog).toBe('attachment');
  await expect(band(page).locator('[data-extension-location="panda.dialog.attachment.bodyExtras"]')).toContainText('Extension guidance for Message attachment');
  await expect(dialog(page).locator('.message-attachment-raw')).toContainText('"tag":"h1"');
  await band(page).getByRole('button', { name: 'Dialog note', exact: true }).click(); await expect(page.locator('#toast')).toHaveText('Core dialog note: the host keeps this dialog');
  await close(page);
});

test('Core dialogs: host fields, IME, Escape, focus and the single primary action survive menus and a nested follow-up form', async ({ page }) => {
  await setup(page, [manifest]); await eligible(page, 'rename-task');
  const title = page.locator('#task-title'), task = (await accessory(page)).task;
  await title.fill('Renamed by host'); await expect(title).toBeFocused();
  // A composing Enter in the host field neither submits the host form nor reaches the band.
  await title.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true });
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(title).toHaveValue('Renamed by host');
  await expect(dialog(page).locator('.primary-button')).toHaveCount(1);
  const more = band(page).getByRole('button', { name: 'More dialog actions', exact: true });
  await more.click(); await expect(page.getByRole('menuitem', { name: 'Show dialog note', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Unavailable dialog action', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('menuitem', { name: 'Show dialog note', exact: true })).toHaveCount(0);
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(more).toBeFocused();
  await more.click(); await page.getByRole('menuitem', { name: 'Open follow-up…', exact: true }).click();
  const nested = page.getByRole('dialog', { name: `Dialog follow-up — ${manifest.id}`, exact: true });
  await expect(nested).toBeVisible(); await expect(dialog(page)).toHaveJSProperty('open', true);
  const note = nested.getByLabel('Follow-up note', { exact: true }); await expect(note).toBeFocused();
  await note.fill('Later');
  await note.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true, bubbles: true }); await expect(nested).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(nested).toBeHidden(); await expect(page.locator('#toast')).toHaveText('Dialog follow-up cancelled');
  await expect(dialog(page)).toHaveJSProperty('open', true); await expect(title).toHaveValue('Renamed by host');
  expect(await dialog(page).evaluate(node => node.contains(document.activeElement))).toBe(true);
  await more.click(); await page.getByRole('menuitem', { name: 'Open follow-up…', exact: true }).click();
  await nested.getByLabel('Follow-up note', { exact: true }).fill('Share it');
  await nested.getByLabel('Follow-up kind', { exact: true }).click(); await page.getByRole('menuitemradio', { name: 'Share with team' }).click();
  await nested.getByLabel('Remind me', { exact: true }).check();
  await nested.getByRole('button', { name: 'Record', exact: true }).click();
  await expect(nested).toBeHidden(); await expect(page.locator('#toast')).toHaveText('Dialog follow-up recorded');
  await expect(title).toHaveValue('Renamed by host');
  // The host's own Save runs once, on the captured task, and closes the dialog with its band.
  await title.focus(); await page.keyboard.press('Enter');
  await expect(dialog(page)).toHaveJSProperty('open', false); await expect(band(page)).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'update_session')).map((call: any) => [call.args.sessionId, call.args.title])).toEqual([[task, 'Renamed by host']]);
});

test('Core dialogs: a task switch keeps the captured target; replacement and close cancel only owned extras and refuse late requests', async ({ page }) => {
  await setup(page, [manifest]); await eligible(page, 'rename-task');
  const captured = await accessory(page);
  expect(captured).toMatchObject({ contractVersion: 1, window: 'main', dialog: 'rename-task', target: 'task' }); expect(captured.task).not.toBe('');
  expect(await admit(page, captured)).toEqual({ ok: true });
  // Selecting another task while the dialog is open never retargets the captured accessory or its context.
  const next = await page.evaluate(id => [...document.querySelectorAll<HTMLElement>('.task-item[data-id]')].map(node => node.dataset.id).find(value => value && value !== id), captured.task);
  expect(next).toBeTruthy();
  await page.evaluate(id => (window as any).__previewSelectTask(id), next);
  await expect.poll(() => page.evaluate(() => document.querySelector<HTMLElement>('.task-item[aria-current="page"]')?.dataset.id)).toBe(next);
  await expect(dialog(page)).toHaveJSProperty('open', true);
  expect(await accessory(page)).toEqual(captured); expect(await admit(page, captured)).toEqual({ ok: true });
  const live = captured;
  await band(page).getByRole('button', { name: 'More dialog actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open follow-up…', exact: true }).click();
  const nested = page.getByRole('dialog', { name: `Dialog follow-up — ${manifest.id}`, exact: true });
  await nested.getByLabel('Follow-up note', { exact: true }).fill('Pending');
  // Replacing the host dialog unloads the band's form without a success or retargeted reply.
  await page.evaluate(() => { document.querySelector('#toast')!.textContent = ''; });
  await page.evaluate(() => (window as any).__previewOpenMainDialog('task-status'));
  await expect(nested).toBeHidden(); await expect.poll(async () => (await accessory(page))?.dialog).toBe('task-status');
  await expect(page.locator('#toast')).not.toHaveText('Dialog follow-up recorded');
  expect(await admit(page, live)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await accessory(page)).mount).not.toBe(live.mount);
  await expect(band(page).locator('[data-extension-location="panda.dialog.rename-task.bodyExtras"]')).toHaveCount(0);
  await close(page);
  expect(await admit(page, live)).toEqual({ ok: false, reason: 'Revoked' });
  expect(await admit(page, { ...live, dialog: 'github-behind' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
});

test('Core dialogs: conflict is bounded and owner-labelled; disable, fault and safe mode remove only extras and keep the host draft and focus', async ({ page }) => {
  await setup(page, [manifest, companion(9)]); await eligible(page, 'rename-task');
  const notes = band(page).locator('[data-extension-location="panda.dialog.rename-task.bodyExtras"] p');
  await expect(notes).toHaveCount(9);
  await expect(notes.first()).toHaveText(`${manifest.id}: Extension guidance for Rename task; the host keeps its fields and actions.`);
  await expect(notes.last()).toHaveText('2 more extension notes are not shown.');
  await expect(band(page).getByRole('button', { name: 'Companion note', exact: true })).toBeVisible();
  await expect(band(page).getByRole('button', { name: 'Dialog note', exact: true })).toBeVisible();
  const title = page.locator('#task-title'); await title.fill('Unsaved host title'); await title.focus();
  const node = await title.elementHandle();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.dialog-companion'); });
  await expect(band(page).getByRole('button', { name: 'Companion note', exact: true })).toHaveCount(0); await expect(notes).toHaveCount(1);
  await expect(title).toHaveValue('Unsaved host title'); await expect(title).toBeFocused(); expect(await node!.evaluate(node => node.isConnected)).toBe(true);
  // A corrupt package record faults activation: every contribution goes, the host dialog does not.
  await page.evaluate(async () => { localStorage.setItem('pandacode.preview.extensions.v1', '{"broken":'); await (window as any).__previewDialogRefresh(); });
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0); await expect(band(page)).toBeHidden();
  await expect(title).toHaveValue('Unsaved host title'); await expect(title).toBeFocused(); await expect(dialog(page)).toHaveJSProperty('open', true);
  await page.evaluate(async manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); await (window as any).__previewDialogRefresh(); }, manifest);
  await expect(band(page).getByRole('button', { name: 'Dialog note', exact: true })).toBeVisible(); await expect(title).toBeFocused();
  await page.evaluate(async () => { await (window as any).__previewDialogSafeMode(); });
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
  await expect(title).toHaveValue('Unsaved host title'); await expect(title).toBeFocused(); await expect(dialog(page)).toHaveJSProperty('open', true);
  await close(page); await eligible(page, 'rename-task'); await expect(band(page)).toBeHidden();
});
