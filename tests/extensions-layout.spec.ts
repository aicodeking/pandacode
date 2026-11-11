import { test, expect, type Page } from '@playwright/test';
const key = 'pandacode.extensions.layout.v1';
async function open(page: Page) {
  await page.goto('/?extensions-baseline'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
test('extensions layout: hide, public command, reload, keyboard recovery and restore', async ({ page }) => {
  await open(page);
  const region = await explorer(page);
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const before = await page.locator('#theme-toggle').getAttribute('aria-pressed');
  await region.getByRole('button', { name: 'Run Toggle theme', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const recovered = await explorer(page);
  await recovered.getByRole('button', { name: 'Hide Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('.sidebar-bottom [data-action="settings"]')).toBeHidden();
  const external = await explorer(page);
  await external.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});
test('extensions layout: focused control transfers focus and hidden controls cannot regain it', async ({ page }) => {
  await open(page);
  // Another window's preference change uses the normal browser storage notification.
  await page.locator('#theme-toggle').focus();
  const other = await page.context().newPage();
  await other.goto('/');
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar.footer/theme': false }, extensionLayoutsEnabled: true })), key);
  await other.close();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.checkVisibility())).toBe(true);
  await page.locator('#theme-toggle').evaluate((element: HTMLElement) => element.focus());
  await expect(page.locator('#theme-toggle')).not.toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#theme-toggle')).not.toBeFocused();
});
test('extensions layout: actual project choices override global choices after reload, project reset reveals global', async ({ page }) => {
  await open(page); let region = await explorer(page);
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  await region.getByLabel('Layout scope', { exact: true }).selectOption('project');
  await region.getByRole('button', { name: 'Show Toggle theme', exact: true }).click();
  const saved = await page.evaluate(key => ({ global: JSON.parse(localStorage.getItem(key)!), project: JSON.parse(localStorage.getItem(`${key}.project.project-1`)!) }), key);
  expect(saved.global.visibility['panda.sidebar.footer/theme']).toBe(false);
  expect(saved.project.visibility['panda.sidebar.footer/theme']).toBe(true);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  region = await explorer(page);
  await region.getByRole('button', { name: 'Reset project layout', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
});
test('extensions layout: hiding an anchored menu closes it and sidebar focus moves to surviving workspace', async ({ page }) => {
  await open(page);
  await page.locator('#sidebar-toggle').click();
  await page.locator('#view-menu').click();
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toBeVisible();
  const other = await page.context().newPage(); await other.goto('/');
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.workspace.header.actions/view-menu': false }, extensionLayoutsEnabled: true })), key);
  await expect(page.locator('#view-menu')).toBeHidden();
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveCount(0);
  await expect(page.locator('#view-divider')).toBeHidden();
  await page.locator('#sidebar-toggle').click();
  await page.locator('.task-item.selected').focus();
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar': false }, extensionLayoutsEnabled: true })), key);
  await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('#prompt')).toBeFocused();
  await other.close();
});
test('extensions layout: sidebar overlay preserves live task, draft and terminal identity', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; });
  await open(page); await page.locator('#prompt').fill('sidebar continuity draft');
  await page.locator('#terminal-toggle').click();
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  const terminal = await page.locator('#terminal-host .xterm-screen').elementHandle();
  const prompt = await page.locator('#prompt').elementHandle();
  const selected = await page.locator('.task-item.selected').getAttribute('data-id');
  const region = await explorer(page);
  await region.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('sidebar continuity draft');
  expect(await prompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await terminal!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  expect(await page.locator('.task-item.selected').getAttribute('data-id')).toBe(selected);
  const restored = await explorer(page);
  await restored.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await restored.getByRole('button', { name: 'Disable extension layouts', exact: true }).click();
  await expect(restored.getByText('Extension layout proposals are disabled.', { exact: false })).toBeVisible();
  const effects = await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((entry: any) => ['start_terminal', 'close_terminal', 'cancel_session', 'delete_session'].includes(entry.command)).map((entry: any) => entry.command));
  expect(effects).toEqual(['start_terminal']);
});
test('extensions layout: corrupt global overlay preserves project preferences and unrelated storage', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, '{broken');
    localStorage.setItem(`${key}.project.project-1`, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar.footer/theme': false, 'missing.extension/action': false }, extensionLayoutsEnabled: true }));
    localStorage.setItem('layout-test-sentinel', 'drafts and projects untouched');
  }, key);
  await open(page);
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const region = await explorer(page);
  await expect(region.getByText(/Invalid or unavailable layout preferences/)).toBeVisible();
  await region.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  await region.getByRole('button', { name: 'Reset project layout', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('layout-test-sentinel'))).toBe('drafts and projects untouched');
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
});
test('extensions layout: contributed choices stay dormant through disable and safe-mode rollback preserves overlays', async ({ page }) => {
  await open(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await region.getByLabel('Item owner', { exact: true }).selectOption('sample.project-helper');
  await region.locator('[data-layout-item="sample.project-helper/header"]').click();
  const contribution = page.locator('[data-extension-contribution="sample.project-helper/header"]');
  await expect(contribution).toBeHidden();
  await page.getByRole('button', { name: 'Disable sample.project-helper', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await expect(contribution).toBeHidden();
  await region.getByLabel('Item owner', { exact: true }).selectOption('panda.core');
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  const stored = await page.evaluate(key => localStorage.getItem(key), key);
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(stored);
});
