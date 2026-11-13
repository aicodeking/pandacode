import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';

// Package inputs contain only public manifest data. Host instrumentation below is
// preview-only evidence, never a package API or installed guest/PTY qualification.
const packages = ['documents', 'diff', 'search', 'browser'].map(name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8')));
const choices = [['Document', 'sample.documents/viewer'], ['Changes', 'sample.diff/commit'], ['Search', 'sample.search/results'], ['Browser', 'sample.browser/controls'], ['Terminal', 'sample.terminal/tabs']] as const;
const laboratory = JSON.parse(readFileSync(new URL('./fixtures/extensions/view-laboratory/extension.json', import.meta.url), 'utf8'));
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function view(page: Page, name: string) {
  if (await page.locator('#inspector-toggle').getAttribute('aria-pressed') === 'false') await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, name);
  await page.locator(`.inspector-tab[data-view="${name.toLowerCase()}"] [role="tab"]`).click();
}

test('extensions content: simultaneous installed recipes recover hidden controls and live work in safe mode', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&documents-coverage&diff-coverage&search-coverage&browser-coverage&terminal-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await view(page, 'Files');
  await page.locator('#inspector-content [data-path="README.md"]').first().dblclick();
  await expect(page.getByRole('button', { name: 'Raw', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  const reader = await page.locator('.document-viewer').elementHandle();
  await page.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
  await expect(page.locator('.xterm-screen:visible')).toContainText('real PTY');
  const terminal = await page.locator('.xterm-screen:visible').elementHandle();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  const address = page.getByRole('textbox', { name: 'Browser URL', exact: true });
  await address.fill('localhost:3000'); await page.getByRole('button', { name: 'Open URL', exact: true }).click();
  await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
  const guest = await page.evaluate(() => (window as any).__previewBrowser().guest);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.terminal', exact: true }).click();
  for (const [label, id] of choices) await region.getByLabel(`${label} presentation`, { exact: true }).selectOption(id);
  for (const [location, label] of [['panda.browser.controls', 'Go forward'], ['panda.terminal.controls', 'New terminal'], ['panda.search.controls', 'Match case']]) {
    await region.getByLabel('Item location', { exact: true }).selectOption(location);
    await region.getByRole('button', { name: `Hide ${label}`, exact: true }).click();
  }
  await back(page);
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeHidden();
  await expect(page.getByRole('button', { name: 'New terminal', exact: true })).toBeHidden();
  await view(page, 'Search');
  await page.getByRole('searchbox', { name: 'Search in files' }).fill('search');
  await expect(page.locator('.search-line').first()).toBeVisible();
  await expect(page.getByRole('button', { name: 'Match case', exact: true })).toBeHidden();
  const field = await page.getByRole('searchbox', { name: 'Search in files' }).elementHandle();
  const before = await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['start_terminal', 'close_terminal', 'browser_open', 'browser_close', 'search_text', 'git_stage', 'git_commit'].includes(call.command)));
  await explorer(page);
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).press('Enter');
  await back(page);
  await expect(page.getByRole('button', { name: 'Match case', exact: true })).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search in files' })).toHaveValue('search');
  expect(await field!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole('button', { name: 'New terminal', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__previewBrowser().guest)).toBe(guest);
  expect(await reader!.evaluate(node => node.isConnected)).toBe(true);
  expect(await terminal!.evaluate(node => node.isConnected)).toBe(true);
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => ['start_terminal', 'close_terminal', 'browser_open', 'browser_close', 'search_text', 'git_stage', 'git_commit'].includes(call.command)))).toEqual(before);
});

for (const location of ['panda.documents.actions', 'panda.changes.actions', 'panda.browser.actions', 'panda.terminal.actions']) {
  test(`extensions content: ${location} reuses package menu, icon, dialog and select contracts`, async ({ page }) => {
    const manifest = structuredClone(laboratory);
    manifest.contributes.menus = [{ ...manifest.contributes.menus[0], location }];
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.addInitScript(manifest => {
      localStorage.setItem('pandacode.wallpapers', 'false');
      localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
    }, manifest);
    await page.goto('/?extensions-baseline');
    await expect(page.locator('#prompt')).toBeEnabled();
    await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
    if (location.includes('documents')) {
      await view(page, 'Files');
      await page.locator('#inspector-content [data-path="README.md"]').first().dblclick();
    } else if (location.includes('changes')) await view(page, 'Changes');
    else await page.getByRole('button', { name: location.includes('browser') ? 'Open browser' : 'Toggle terminal', exact: true }).click();
    const trigger = page.getByRole('button', { name: 'View laboratory', exact: true });
    await expect(trigger.locator('svg rect')).toHaveCount(1);
    await trigger.click();
    const tools = page.getByRole('menuitem', { name: 'Object tools', exact: true });
    await expect(tools.locator('svg rect')).toHaveCount(1);
    await tools.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Choose object options', exact: true }).press('Enter');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Clicked object — sample.view-laboratory');
    await page.getByRole('button', { name: 'Object options', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
    const calls = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
    expect(calls).toHaveLength(1);
    expect(calls[0].context).toMatchObject({ surfaceId: location, projectId: 'project-1', sessionId: 'session-1' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await explorer(page);
    await page.getByRole('button', { name: 'Disable sample.view-laboratory', exact: true }).click();
    await back(page);
    await expect(trigger).toHaveCount(0);
  });
}
