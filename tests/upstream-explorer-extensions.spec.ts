import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S0601 (upstream sync P6): the project explorer (the inspector Files tab: tree, tools above it, one menu per row and the
 * host's create, rename and delete dialog) keeps upstream's behavior with no extension, and the surfaces re-applied on it
 * (row and toolbar actions with a captured project, path, kind and revision; hide, reorder and restore of the host
 * controls) work for an installed package through the real install and enable flow. Preview evidence only: native
 * authority and the installed WebView are separate columns of the receipt; see docs/extensions/upstream-explorer.md.
 * Written first, run in the final test phase. */
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-explorer/manifest.json', import.meta.url), 'utf8'));
const ID = manifest.id as string;
const layoutKey = 'pandacode.extensions.layout.v1';
const TOOLBAR = 'panda.inspector.files.toolbar', CONTEXT = 'panda.inspector.files.context';
const explorerRegion = (page: Page) => page.getByRole('region', { name: 'File explorer', exact: true });
const row = (page: Page, name: string) => explorerRegion(page).locator('.file-row').getByRole('button', { name, exact: true });
const tools = (page: Page) => explorerRegion(page).locator('.file-explorer-tools button').evaluateAll(nodes => nodes.filter(node => !node.hasAttribute('data-layout-hidden')).map(node => node.getAttribute('data-action')));
const labels = (page: Page) => page.locator('.choice-menu-option .choice-menu-label').allTextContents();
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const toast = (page: Page) => page.locator('#toast');
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function settings(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
async function openExplorer(page: Page) {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  });
  await page.goto('/?extensions-baseline&upstream-explorer&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport?.(); });
  const loading = page.locator('#inspector-content').getByText('Loading files…', { exact: true });
  if (await loading.isVisible()) await expect(loading).toBeHidden();
  if (!await explorerRegion(page).isVisible()) await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorerRegion(page)).toBeVisible();
}
/** The real flow: Settings > Extensions > Install local package, then Enable. */
async function install(page: Page) {
  const region = await settings(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${ID}`, exact: true }).click();
  return region;
}
async function hide(page: Page, region: Locator, location: string, label: string, verb = 'Hide') {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: new RegExp(`^${verb} ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( —|$)`) });
  for (let cursor = 0; cursor < 12 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
async function forceLayout(page: Page, layout: Record<string, unknown>) {
  await page.evaluate(({ key, layout }) => { localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, extensionLayoutsEnabled: true, ...layout })); dispatchEvent(new StorageEvent('storage', { key })); }, { key: layoutKey, layout });
}
const HOST_FILE = ['Open file', 'Attach file', 'New File', 'New Folder', 'Rename', 'Delete', 'Copy Path', 'Reveal in OS', 'Open in Default App'];
const HOST_FOLDER = ['New File', 'New Folder', 'Rename', 'Delete', 'Copy Path', 'Reveal in OS'];

test('upstream explorer: with no package the tree, tools and menus behave as upstream with one menu per object', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openExplorer(page);
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu']);
  // A file: right-click opens exactly one menu with the host rows and nothing contributed.
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual(HOST_FILE);
  await expect(page.locator('.choice-menu')).toHaveCount(1);
  await expect(page.locator('[data-extension-contribution]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.locator('.choice-menu')).toHaveCount(0);
  await expect(row(page, 'README.md')).toBeFocused();
  // A folder, from the keyboard: Shift+F10 and the row's own button open the same menu.
  await row(page, 'src').focus(); await page.keyboard.press('Shift+F10');
  expect(await labels(page)).toEqual(HOST_FOLDER);
  await page.keyboard.press('Escape'); await expect(row(page, 'src')).toBeFocused();
  // The project button above the tree opens the root menu: no Rename, Delete or Open.
  await page.getByRole('button', { name: 'File actions', exact: true }).click();
  expect(await labels(page)).toEqual(['New File', 'New Folder', 'Copy Path', 'Reveal in OS']);
  await page.keyboard.press('Escape');
  // Expansion, selection and open keep their handlers: the folder expands, the file opens in the editor.
  await row(page, 'src').click(); await expect(row(page, 'main.ts')).toBeVisible();
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu', 'collapse-folders']);
  await row(page, 'main.ts').click(); await expect(page.locator('#file-panel')).toBeVisible();
  // Rename keeps the host dialog and its guard: F2 opens it, Cancel leaves the file alone.
  await row(page, 'README.md').focus(); await page.keyboard.press('F2');
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true })).toHaveValue('README.md');
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row(page, 'README.md')).toBeVisible();
  expect(await calls(page, 'manage_workspace_entry')).toEqual([]);
  expect(errors).toEqual([]);
});

test('upstream explorer: an installed package adds a file row action, a folder row action and a toolbar action with the clicked identity', async ({ page }) => {
  await openExplorer(page);
  await install(page); await back(page);
  // File row: the host rows first, then the package's, with the captured file identity.
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual([...HOST_FILE, 'Open in my tool']);
  await page.getByRole('menuitem', { name: 'Open in my tool', exact: true }).click();
  await expect(toast(page)).toContainText('Sent the clicked file to my tool.');
  await expect(row(page, 'README.md')).toBeFocused();
  // Folder row: its own action, never the file one.
  await row(page, 'src').click({ button: 'right' });
  expect(await labels(page)).toEqual([...HOST_FOLDER, 'Open folder in my tool']);
  await page.keyboard.press('Escape');
  // Toolbar: the contributed tool joins the strip and runs without touching a file.
  await page.getByRole('button', { name: 'Explorer tool', exact: true }).click();
  await expect(toast(page)).toContainText('The project tool ran from the explorer toolbar.');
  // A package action edits nothing: no create, rename or delete went to the host.
  expect(await calls(page, 'manage_workspace_entry')).toEqual([]);
  expect(await calls(page, 'write_workspace_file')).toEqual([]);
  // The project menu has no file or folder, so neither row action shows there.
  await page.getByRole('button', { name: 'File actions', exact: true }).click();
  expect(await labels(page)).toEqual(['New File', 'New Folder', 'Copy Path', 'Reveal in OS']);
  await page.keyboard.press('Escape');
});

test('upstream explorer: a menu captured for one object is rejected once the task, the tree or the row moved on', async ({ page }) => {
  await openExplorer(page);
  await install(page); await back(page);
  // Another task is another workspace: the open menu goes away and runs nothing.
  await row(page, 'README.md').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toBeVisible();
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toHaveCount(0);
  await expect(toast(page)).not.toContainText('Sent the clicked file to my tool.');
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(explorerRegion(page)).toBeVisible();
  // The row disappearing from disk (the two-second refresh) closes the menu captured on it.
  await row(page, 'README.md').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__previewExplorerRemove('README.md'));
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toHaveCount(0, { timeout: 10_000 });
  await expect(row(page, 'README.md')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement instanceof HTMLElement)).toBe(true);
  // A disabled package revokes a menu opened before: its row cannot run afterwards.
  await row(page, 'package.json').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toBeVisible();
  await settings(page); await page.getByRole('button', { name: `Disable ${ID}`, exact: true }).click(); await back(page);
  await expect(page.getByRole('menuitem', { name: 'Open in my tool', exact: true })).toHaveCount(0);
});

test('upstream explorer: hide, reorder and restore the host tools and menu rows; keyboard and focus stay', async ({ page }) => {
  await openExplorer(page);
  let region = await install(page);
  await hide(page, region, TOOLBAR, 'New folder');
  await back(page);
  expect(await tools(page)).toEqual(['new-workspace-file', 'file-menu']);
  await expect(row(page, 'src')).toBeVisible();
  // Menu rows hide too; a hidden row is not offered but its keyboard shortcut (F2) still works.
  region = await settings(page);
  await hide(page, region, CONTEXT, 'Reveal in OS');
  await back(page);
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual([...HOST_FILE.filter(label => label !== 'Reveal in OS'), 'Open in my tool']);
  await page.keyboard.press('Escape');
  await row(page, 'README.md').focus(); await page.keyboard.press('F2');
  await expect(page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true })).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  // A hidden tool never keeps focus: hiding the focused one hands it to a visible control.
  await page.getByRole('button', { name: 'New file', exact: true }).focus();
  await forceLayout(page, { visibility: { [`${TOOLBAR}/new-file`]: false, [`${TOOLBAR}/new-folder`]: false } });
  await expect(page.getByRole('button', { name: 'New file', exact: true })).toBeHidden();
  expect(await page.evaluate(() => Boolean(document.activeElement && document.activeElement !== document.body && !(document.activeElement as HTMLElement).closest('[data-layout-hidden]')))).toBe(true);
  // Reorder: the user's order wins on the original nodes; the tree does not redraw.
  await row(page, 'src').click();
  expect(await tools(page)).toEqual(['file-menu', 'collapse-folders']);
  await forceLayout(page, { orders: { [TOOLBAR]: [`${TOOLBAR}/collapse`, `${TOOLBAR}/actions`, `${TOOLBAR}/new-folder`, `${TOOLBAR}/new-file`] } });
  expect(await tools(page)).toEqual(['collapse-folders', 'file-menu']);
  // Restore: Reset global layout brings every tool, row and the built-in order back.
  region = await settings(page);
  await region.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await back(page);
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu', 'collapse-folders']);
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toContain('Reveal in OS');
  await page.keyboard.press('Escape');
});

test('upstream explorer: granting and revoking the proposed order, disabling and uninstalling clean up completely', async ({ page }) => {
  await openExplorer(page);
  await row(page, 'src').click();
  let region = await install(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(TOOLBAR);
  // Grant: the package's proposal puts Collapse folders first; the user's choice is explicit.
  await region.getByRole('button', { name: 'Grant UI customization and select Collapse before New file', exact: true }).click();
  await back(page);
  expect((await tools(page))[0]).toBe('collapse-folders');
  // Revoke: disabling extension layouts restores the built-in order and keeps the package's actions.
  region = await settings(page);
  await region.getByRole('button', { name: 'Disable extension layouts', exact: true }).click();
  await back(page);
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu', 'collapse-folders']);
  await expect(page.getByRole('button', { name: 'Explorer tool', exact: true })).toBeVisible();
  // Disable: the package's tool and rows are gone, the host's are untouched, the tree keeps its expansion.
  await settings(page); await page.getByRole('button', { name: `Disable ${ID}`, exact: true }).click(); await back(page);
  await expect(page.getByRole('button', { name: 'Explorer tool', exact: true })).toHaveCount(0);
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual(HOST_FILE); await page.keyboard.press('Escape');
  await expect(row(page, 'main.ts')).toBeVisible();
  // Enable again, then uninstall: nothing of the package remains.
  await settings(page); await page.getByRole('button', { name: `Enable ${ID}`, exact: true }).click(); await back(page);
  await expect(page.getByRole('button', { name: 'Explorer tool', exact: true })).toBeVisible();
  await settings(page); await page.getByRole('button', { name: `Uninstall ${ID}`, exact: true }).click(); await back(page);
  await expect(page.getByRole('button', { name: 'Explorer tool', exact: true })).toHaveCount(0);
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual(HOST_FILE); await page.keyboard.press('Escape');
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu', 'collapse-folders']);
});

test('upstream explorer: a faulted extension surface falls back to the built-in menu, and safe mode shows built-in tools and rows', async ({ page }) => {
  await openExplorer(page);
  await install(page); await back(page);
  await forceLayout(page, { visibility: { [`${TOOLBAR}/new-folder`]: false }, orders: { [CONTEXT]: [`${CONTEXT}/delete`, `${CONTEXT}/rename`] } });
  expect(await tools(page)).toEqual(['new-workspace-file', 'file-menu']);
  // Fault: the extension surface cannot load; the built-in menu still opens with a notice and the same rows.
  await page.evaluate(() => { (window as any).__previewExplorerFault = true; });
  await row(page, 'README.md').click({ button: 'right' });
  await expect(toast(page)).toContainText('Explorer extension actions failed. The built-in menu is shown.');
  expect(await labels(page)).toEqual(HOST_FILE);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__previewExplorerFault = false; });
  // Safe mode ignores the package, the hidden tool and the order, and keeps the tree and any draft.
  await page.evaluate(() => (window as any).__previewExplorerSafeMode());
  await expect(page.getByRole('button', { name: 'Explorer tool', exact: true })).toHaveCount(0);
  expect(await tools(page)).toEqual(['new-workspace-file', 'new-workspace-folder', 'file-menu']);
  await row(page, 'README.md').click({ button: 'right' });
  expect(await labels(page)).toEqual(HOST_FILE);
  await page.keyboard.press('Escape');
  await expect(row(page, 'src')).toBeVisible();
});
