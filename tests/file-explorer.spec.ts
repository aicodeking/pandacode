import { expect, test, type Page, type Locator } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';
import { replaceEditor } from './file-editor-helper';

const explorer = (page: Page) => page.getByRole('region', { name: 'File explorer', exact: true });
const root = (page: Page) => explorer(page);
const item = (page: Page, name: string) => root(page).locator('.file-row').getByRole('button', { name, exact: true });
async function showExplorer(page: Page) {
  // A thread switch keeps the Files panel open but replaces the tree with "Loading files…".
  // The toggle would read that as already-open and close the panel, so wait the placeholder out.
  const loading = page.locator('#inspector-content').getByText('Loading files…', { exact: true });
  if (await loading.isVisible()) await expect(loading).toBeHidden();
  if (!await explorer(page).isVisible()) await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeVisible();
}
async function menu(page: Page, row: Locator, action: string) {
  await showExplorer(page);
  await row.click({ button: 'right' });
  await page.getByRole('menuitem', { name: action, exact: true }).click();
}
async function submitName(page: Page, name: string, action = 'Create') {
  await page.getByRole('dialog').getByRole('textbox', { name: 'Name', exact: true }).fill(name);
  await page.getByRole('dialog').getByRole('button', { name: action, exact: true }).click();
  await expect(page.locator('#dialog')).not.toBeVisible();
}
async function disk(page: Page, command: string, args: Record<string, unknown>) {
  const workspace = { projectId: 'project-1', sessionId: 'session-1' };
  return page.evaluate(async ({ command, args }) => {
    const preview = await import('/src/preview.ts');
    return preview.invoke(command, args);
  }, { command, args: { ...workspace, ...args } });
}
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
});

test('file explorer: right panel keeps the current project available with mouse and keyboard disclosure', async ({ page }) => {
  await expect(page.locator('#workspace-sidebar').getByRole('region', { name: 'File explorer', exact: true })).toHaveCount(0);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('orbit');
  await expect(page.getByRole('button', { name: 'Toggle file explorer', exact: true })).toHaveAttribute('aria-pressed', 'true');
  const src = item(page, 'src');
  await src.click();
  await expect(src).toHaveAttribute('aria-expanded', 'true');
  await expect(item(page, 'main.ts')).toBeVisible();
  await src.press('ArrowLeft');
  await expect(src).toHaveAttribute('aria-expanded', 'false');
  await expect(item(page, 'main.ts')).toHaveCount(0);
  await src.press('ArrowRight');
  await expect(item(page, 'main.ts')).toBeVisible();
  await explorer(page).getByRole('button', { name: 'Collapse folders', exact: true }).click();
  await expect(src).toHaveAttribute('aria-expanded', 'false');
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Toggle file explorer', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
});

test('file explorer: creates, edits, renames and deletes nested files and folders', async ({ page }) => {
  await explorer(page).getByRole('button', { name: 'New folder', exact: true }).click();
  await submitName(page, 'scratch');
  await menu(page, item(page, 'scratch'), 'New File');
  await submitName(page, 'hello.ts');
  await replaceEditor(page, 'scratch/hello.ts', 'export const answer = 42;\n');
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('answer');
  await menu(page, item(page, 'scratch'), 'Rename');
  await submitName(page, 'renamed', 'Rename');
  await expect(page.locator('.file-view-path')).toHaveText('renamed/hello.ts');
  await menu(page, item(page, 'hello.ts'), 'Rename');
  await submitName(page, 'hello world.json', 'Rename');
  await expect(page.locator('.file-view-path')).toHaveText('renamed/hello world.json');
  await menu(page, item(page, 'renamed'), 'Delete');
  await expect(page.getByRole('dialog')).toContainText('and all its contents');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(item(page, 'renamed')).toHaveCount(0);
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
});

test('file explorer: rejects duplicate names and traversal without dismissing the dialog', async ({ page }) => {
  await menu(page, item(page, 'README.md'), 'New File');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('README.md');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('already exists');
  await dialog.getByRole('textbox', { name: 'Name', exact: true }).fill('../outside');
  await dialog.getByRole('button', { name: 'Create', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('single file or folder name');
});

test('file explorer: preserves unsaved edits across file tabs and rejects stale saves', async ({ page }) => {
  await item(page, 'README.md').click();
  const original = await disk(page, 'read_file', { path: 'README.md' });
  await replaceEditor(page, 'README.md', '# My draft\n');
  await page.locator('#file-tabs [data-file-tab="close"]').click();
  await expect(page.locator('#toast')).toContainText('Save or discard');
  await showExplorer(page);
  await item(page, 'package.json').click();
  await page.locator('#file-tabs').getByRole('tab', { name: /README.md/ }).click();
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'README.md', exact: true })).toContainText('My draft');
  await disk(page, 'write_workspace_file', { path: 'README.md', expected: original, content: '# External edit\n' });
  await page.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('File changed on disk');
  await expect(page.locator('#file-panel').getByRole('textbox', { name: 'README.md', exact: true })).toContainText('My draft');
  await page.getByRole('button', { name: 'Discard', exact: true }).click();
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('External edit');
});

test('file explorer: auto-refreshes new, changed and deleted files on disk', async ({ page }) => {
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'external.txt' });
  await expect(item(page, 'external.txt')).toBeVisible();
  await item(page, 'external.txt').click();
  await disk(page, 'write_workspace_file', { path: 'external.txt', expected: '', content: 'Updated on disk' });
  await expect(page.locator('#file-panel [contenteditable="true"]')).toContainText('Updated on disk');
  await disk(page, 'manage_workspace_entry', { action: 'delete', path: 'external.txt' });
  await showExplorer(page);
  await expect(item(page, 'external.txt')).toHaveCount(0);
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(0);
});

test('file explorer: dirty files cannot be renamed or deleted from their folder', async ({ page }) => {
  await item(page, 'src').click();
  await item(page, 'main.ts').click();
  await replaceEditor(page, 'src/main.ts', 'unsaved');
  await menu(page, item(page, 'src'), 'Delete');
  await page.getByRole('button', { name: 'Delete permanently', exact: true }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toContainText('Save or discard');
  await expect(item(page, 'main.ts')).toBeVisible();
});

test('file explorer: inspector shares explorer actions and supports the keyboard menu', async ({ page }) => {
  const row = item(page, 'README.md');
  await row.focus(); await row.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Copy Path', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Reveal in OS', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Open in Default App', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await row.click();
  await openInspectorTab(page, 'Files');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'README.md', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'New Folder', exact: true })).toBeVisible();
});

test('file explorer: switching projects shows only the active checkout', async ({ page }) => {
  await disk(page, 'manage_workspace_entry', { action: 'new-file', path: 'only-in-orbit.txt' });
  await expect(item(page, 'only-in-orbit.txt')).toBeVisible();
  await page.locator('.task-item[data-id="session-4"]').click();
  await showExplorer(page);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('pandacode');
  await expect(item(page, 'only-in-orbit.txt')).toHaveCount(0);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveCount(1);
  await page.locator('.task-item[data-id="session-1"]').click();
  await showExplorer(page);
  await expect(explorer(page).locator('.file-folder-path>span')).toHaveText('orbit');
  await expect(item(page, 'only-in-orbit.txt')).toBeVisible();
});

/** Counts the poll's IPC (`list_files` for the tree, `workspace_file_stamp` for the file on screen) by patching the preview's
 * command switch, as `observeWorktreeCommands` in ui.spec.ts does. */
async function countPolls(page: Page): Promise<() => Promise<number>> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const marker = /switch\s*\(command\)\s*\{/, source = await response.text();
    expect(source).toMatch(marker);
    const body = source.replace(marker, `if (command === 'list_files' || command === 'workspace_file_stamp') window.__filePolls = (window.__filePolls ?? 0) + 1;
      switch (command) {`) + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
    await route.fulfill({ response, body });
  });
  await page.reload();
  // The reload restores the open Files panel; let it draw (or settle closed) before toggling it.
  await expect(item(page, 'README.md').or(page.locator('#files-toggle[aria-pressed="false"]'))).toBeVisible();
  await showExplorer(page);
  await expect(item(page, 'README.md')).toBeVisible();
  return () => page.evaluate(() => (window as any).__filePolls as number ?? 0);
}
/** No poll IPC across two and a bit poll intervals. */
async function expectQuiet(page: Page, polls: () => Promise<number>, why: string): Promise<void> {
  await page.waitForTimeout(150);
  const from = await polls();
  await page.waitForTimeout(4500);
  expect(await polls(), why).toBe(from);
}

test('file explorer: the poll pauses while the window is unfocused or hidden and refreshes at once on return', async ({ page }) => {
  test.setTimeout(45_000);
  const polls = await countPolls(page);
  let from = await polls();
  await expect.poll(polls, { timeout: 5000, message: 'focused with the tree on screen, it polls' }).toBeGreaterThan(from);
  await page.evaluate(() => { document.hasFocus = () => false; dispatchEvent(new Event('blur')); });
  await expectQuiet(page, polls, 'no poll while the window is unfocused');
  from = await polls();
  await page.evaluate(() => { document.hasFocus = () => true; dispatchEvent(new Event('focus')); });
  await expect.poll(polls, { timeout: 500, message: 'focus refreshes at once' }).toBeGreaterThan(from);
  await page.evaluate(() => { Object.defineProperty(document, 'hidden', { configurable: true, get: () => true }); document.dispatchEvent(new Event('visibilitychange')); });
  await expectQuiet(page, polls, 'no poll while the window is hidden');
  from = await polls();
  await page.evaluate(() => { delete (document as any).hidden; document.dispatchEvent(new Event('visibilitychange')); });
  await expect.poll(polls, { timeout: 500, message: 'showing the window refreshes at once' }).toBeGreaterThan(from);
  // Focus moving into one of the app's own frames blurs the window, but the document keeps focus: the poll goes on.
  from = await polls();
  await page.evaluate(() => dispatchEvent(new Event('blur')));
  await expect.poll(polls, { timeout: 5000, message: 'a blur that leaves the document focused keeps polling' }).toBeGreaterThan(from);
});

test('file explorer: the poll runs only while the Files tree or an open file is on screen', async ({ page }) => {
  test.setTimeout(45_000);
  const polls = await countPolls(page);
  await item(page, 'README.md').click();
  await expect(page.locator('#file-tabs .file-tab')).toHaveCount(1);
  // The open file alone (tree closed) keeps its stamp fresh.
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await expect(explorer(page)).toBeHidden();
  await expect(page.locator('#file-panel')).toBeVisible();
  const from = await polls();
  await expect.poll(polls, { timeout: 5000, message: 'an open file on screen is polled' }).toBeGreaterThan(from);
  // The file hidden too: the tab still exists, but nothing on screen shows the files.
  await page.locator('#file-editor-toggle').click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await expectQuiet(page, polls, 'no poll while neither the tree nor a file is on screen');
});
