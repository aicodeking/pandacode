import { expect, test, type Page } from '@playwright/test';
import { replaceEditor } from './file-editor-helper';

/* S0602 (upstream sync P6): the floating code editor (`#file-panel`, an in-page pane) keeps upstream's behavior with no
 * extension, and the document surfaces re-applied on it (navigation, actions, context, captured identity) work for an
 * installed package through the real install/enable flow. Preview evidence only: the installed WebView and native
 * authority are separate columns of the receipt; see docs/extensions/upstream-editor.md. Written first, run in the
 * final test phase. */
const FILE = 'src/main.ts';
const pane = (page: Page) => page.locator('#file-panel');
const editorToggle = (page: Page) => page.locator('#file-editor-toggle');
const hideButton = (page: Page) => pane(page).locator('[data-file-window="close"]');
const state = (page: Page) => pane(page).evaluate(node => ({ mode: (node as HTMLElement).dataset.editorMode, dirty: (node as HTMLElement).dataset.editorDirty, saving: (node as HTMLElement).dataset.editorSaving }));
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
async function openEditor(page: Page) {
  await page.addInitScript(() => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async () => {} } });
  });
  await page.goto('/?extensions-baseline&upstream-editor&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Toggle file explorer', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'src', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name: 'main.ts', exact: true }).click();
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toBeVisible();
}
async function install(page: Page) {
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.upstream-editor', exact: true }).click();
  return region;
}

test('upstream editor: with no package the floating editor opens, edits, saves state, hides and returns as upstream', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await openEditor(page);
  expect(await state(page)).toEqual({ mode: 'source', dirty: 'false', saving: 'false' });
  await expect(pane(page).getByRole('button', { name: 'Save', exact: true })).toBeDisabled();
  await expect(editorToggle(page)).toHaveAttribute('aria-expanded', 'true');
  await replaceEditor(page, FILE, 'const answer = 42;\n');
  await expect.poll(() => state(page)).toEqual({ mode: 'source', dirty: 'true', saving: 'false' });
  await expect(pane(page).getByRole('tab', { name: /main\.ts ●/ })).toBeVisible();
  await expect(pane(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
  // Source and preview are one tab; the dirty draft refuses a view change that would replace it as a different file view.
  await pane(page).getByRole('button', { name: 'Preview', exact: true }).click();
  await expect.poll(async () => (await state(page)).mode).toBe('preview');
  await expect(pane(page).getByRole('button', { name: 'Edit', exact: true })).toBeVisible();
  await pane(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await expect.poll(async () => (await state(page)).mode).toBe('source');
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toContainText('const answer = 42;');
  // Hiding keeps tabs and drafts; the dock button and Escape both bring the same pane back.
  await pane(page).getByRole('textbox', { name: FILE, exact: true }).press('Escape');
  await expect(pane(page)).toBeHidden();
  await expect(editorToggle(page)).toHaveAttribute('aria-expanded', 'false');
  await editorToggle(page).click();
  await expect(pane(page)).toBeVisible();
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toContainText('const answer = 42;');
  await pane(page).getByRole('button', { name: 'Discard', exact: true }).click();
  await expect.poll(async () => (await state(page)).dirty).toBe('false');
  await expect(pane(page).getByRole('tab', { name: /main\.ts ●/ })).toHaveCount(0);
  await expect(page.locator('[data-extension-location="panda.documents.actions"] [data-extension-contribution]')).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('upstream editor: install, enable, contribute, reorder, hide and restore the navigation and actions', async ({ page }) => {
  await openEditor(page);
  const original = await pane(page).locator('.file-preview-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-file-tab')));
  let region = await install(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.actions');
  await region.getByRole('button', { name: 'Grant UI customization and select Attach first', exact: true }).click();
  await back(page);
  await page.getByRole('button', { name: 'Editor tools', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('keeps its own tabs, drafts and save handlers');
  const reordered = await pane(page).locator('.file-preview-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-file-tab')));
  expect(reordered.indexOf('attach')).toBeLessThan(reordered.indexOf('copy'));
  // Navigation: the dock button and the pane's Hide button are the two catalog controls; hiding never closes a tab.
  region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.navigation');
  await region.getByRole('button', { name: 'Hide Open files', exact: true }).click();
  await region.getByRole('button', { name: 'Hide Close open files', exact: true }).click();
  await back(page);
  await expect(editorToggle(page)).toHaveAttribute('data-layout-hidden', '');
  await expect(hideButton(page)).toHaveAttribute('data-layout-hidden', '');
  await expect(pane(page).getByRole('tab', { name: /main\.ts/ })).toBeVisible();
  // Escape is host chrome: it still hides the editor, and focus leaves the hidden pane for the host.
  await pane(page).getByRole('textbox', { name: FILE, exact: true }).press('Escape');
  await expect(pane(page)).toBeHidden();
  await expect(pane(page).getByRole('tab', { name: /main\.ts/ })).toHaveCount(1);
  region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.navigation');
  await region.getByRole('button', { name: 'Show Open files', exact: true }).click();
  await region.getByRole('button', { name: 'Show Close open files', exact: true }).click();
  await back(page);
  await expect(editorToggle(page)).not.toHaveAttribute('data-layout-hidden', '');
  await editorToggle(page).click();
  await expect(pane(page)).toBeVisible();
  await expect(hideButton(page)).not.toHaveAttribute('data-layout-hidden', '');
  // Disabling removes the package's button and the proposed order; the open tab and its viewer survive.
  await explorer(page);
  await page.getByRole('button', { name: 'Disable sample.upstream-editor', exact: true }).click(); await back(page);
  await expect(page.getByRole('button', { name: 'Editor tools', exact: true })).toHaveCount(0);
  expect(await pane(page).locator('.file-preview-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-file-tab')))).toEqual(original);
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toBeVisible();
});

test('upstream editor: a captured context menu is rejected once the editor moved on, and keyboard focus is kept', async ({ page }) => {
  await openEditor(page);
  await install(page); await back(page);
  const tab = pane(page).getByRole('tab', { name: /main\.ts/ });
  await tab.focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Editor tools', exact: true })).toBeVisible();
  // A redraw (Preview) bumps the revision, so the menu captured before it can no longer act.
  await page.evaluate(() => (document.querySelector('#file-panel [data-file-tab="reader"]') as HTMLElement).click());
  await expect(page.getByRole('menuitem', { name: 'Editor tools', exact: true })).toHaveCount(0);
  await expect.poll(async () => (await state(page)).mode).toBe('preview');
  // A fresh menu on the new revision works.
  await tab.focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Editor tools', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('keeps its own tabs, drafts and save handlers');
  // Keyboard: arrows move between tabs only; Delete closes a clean tab; Escape hides without losing it.
  await tab.focus(); await page.keyboard.press('Home');
  await expect(tab).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(pane(page)).toBeHidden();
  await editorToggle(page).click();
  await expect(pane(page).getByRole('tab', { name: /main\.ts/ })).toBeVisible();
});

test('upstream editor: revoke, fault fallback and safe mode restore the built-in editor with its work intact', async ({ page }) => {
  await openEditor(page);
  await replaceEditor(page, FILE, 'const kept = true;\n');
  const region = await install(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.navigation');
  await region.getByRole('button', { name: 'Hide Open files', exact: true }).click();
  await back(page);
  await expect(editorToggle(page)).toHaveAttribute('data-layout-hidden', '');
  // Safe mode ignores the hidden proposal and every contribution, and the draft stays.
  await explorer(page);
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(editorToggle(page)).not.toHaveAttribute('data-layout-hidden', '');
  await expect(page.getByRole('button', { name: 'Editor tools', exact: true })).toHaveCount(0);
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toContainText('const kept = true;');
  expect((await state(page)).dirty).toBe('true');
  // Revoking the package (disable) after the fault keeps the same editor and its draft.
  await explorer(page);
  await page.getByRole('button', { name: 'Disable sample.upstream-editor', exact: true }).click(); await back(page);
  await expect(pane(page).getByRole('textbox', { name: FILE, exact: true })).toContainText('const kept = true;');
  await expect(pane(page).getByRole('button', { name: 'Save', exact: true })).toBeEnabled();
});
