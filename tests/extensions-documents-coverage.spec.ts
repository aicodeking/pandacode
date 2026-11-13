import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/documents/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    (window as any).__documentCopies = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__documentCopies.push(text); } } });
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&documents-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function openReadme(page: Page) {
  await openInspectorTab(page, 'Files'); await page.locator('[data-action="tab-files"]').click();
  await page.locator('#inspector-content [data-path="README.md"]').first().dblclick();
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Raw', exact: true })).toBeVisible();
}
test('documents: zero-extension original reader, keyboard tabs and copy/attach remain usable', async ({ page }) => {
  await setup(page); await openReadme(page);
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Wrap', exact: true }).click();
  await page.getByRole('tab', { name: 'README.md', exact: true }).focus(); await page.keyboard.press('Home');
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toBeFocused();
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Copy file', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__documentCopies.length)).toBe(1);
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.locator('#prompt')).toBeFocused();
  await page.getByRole('tab', { name: 'README.md', exact: true }).focus(); await page.keyboard.press('Delete');
  await expect(page.getByRole('tab', { name: 'README.md', exact: true })).toHaveCount(0);
});
test('documents: installed explicit recipe, catalog, control order/visibility and original handlers retain live reader', async ({ page }) => {
  await setup(page); await openReadme(page);
  const viewer = await page.locator('.document-viewer').elementHandle();
  let region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.documents', exact: true }).click();
  await expect(page.locator('[data-document-provider]')).toHaveCount(0);
  await region.getByLabel('Document presentation', { exact: true }).selectOption('sample.documents/viewer');
  await region.getByRole('button', { name: 'Grant UI customization and select Attach before copy', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.actions');
  await region.getByRole('button', { name: 'Hide Copy file', exact: true }).click();
  await back(page); await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeHidden();
  await page.getByRole('tab', { name: 'README.md', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Copy file', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__documentCopies.length)).toBe(1);
  region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.actions');
  await region.getByRole('button', { name: 'Show Copy file', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.viewer');
  await expect(region.getByRole('list', { name: 'Surface items' })).toContainText('Actual size');
  await back(page);
  expect(await page.locator('.file-preview-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-file-tab')))).toEqual(['attach', 'copy']);
  expect(await viewer!.evaluate(node => node === document.querySelector('.document-viewer'))).toBe(true);
  await expect(page.locator('[data-document-provider="sample.documents/viewer"]')).toBeVisible();
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.documents', exact: true }).click(); await back(page);
  expect(await page.locator('.file-preview-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-file-tab')))).toEqual(['copy', 'attach']);
  expect(await viewer!.evaluate(node => node.isConnected)).toBe(true);
});
test('documents: selected installed recipe uses original view, context copy and attach handlers', async ({ page }) => {
  await setup(page, [manifest]); await openReadme(page);
  const region = await explorer(page);
  await region.getByLabel('Document presentation', { exact: true }).selectOption('sample.documents/viewer'); await back(page);
  await page.getByRole('button', { name: 'Document tools', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('original host handlers');
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  await page.getByRole('button', { name: 'Wrap', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Wrap', exact: true })).toHaveAttribute('aria-pressed', 'false');
  await page.getByRole('tab', { name: 'README.md', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Document tools', exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Copy file', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__documentCopies.length)).toBe(1);
  await page.getByRole('tab', { name: 'README.md', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await page.getByRole('menuitem', { name: 'Document tools', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('original host handlers');
  await page.getByRole('button', { name: 'Attach', exact: true }).click(); await expect(page.locator('#prompt')).toBeFocused();
});
test('documents: movement, navigation visibility, disable and safe recovery retain the same selected live reader', async ({ page }) => {
  await setup(page, [manifest]); await openReadme(page);
  let region = await explorer(page);
  await region.getByLabel('Document presentation', { exact: true }).selectOption('sample.documents/viewer'); await back(page);
  await page.getByRole('button', { name: 'Raw', exact: true }).click();
  const rawViewer = await page.locator('.document-viewer').elementHandle();
  region = await explorer(page);
  await region.getByRole('button', { name: 'Move Documents to Main', exact: true }).click();
  await back(page); await expect(page.locator('.main-pane #file-panel')).toBeVisible();
  expect(await rawViewer!.evaluate(node => node.isConnected)).toBe(true);
  region = await explorer(page);
  await region.getByRole('button', { name: 'Restore built-in view placement', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.documents.navigation');
  await region.getByRole('button', { name: 'Hide Close open files', exact: true }).click();
  await back(page); await expect(page.getByRole('button', { name: 'Close open files', exact: true })).toBeHidden();
  expect(await rawViewer!.evaluate(node => node.isConnected)).toBe(true);
  await explorer(page);
  await page.getByRole('button', { name: 'Disable sample.documents', exact: true }).click(); await back(page);
  expect(await rawViewer!.evaluate(node => node === document.querySelector('.document-viewer'))).toBe(true);
  await expect(page.getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('[data-document-provider]')).toHaveCount(0);
  await explorer(page); await page.getByRole('button', { name: 'Enable sample.documents', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  expect(await rawViewer!.evaluate(node => node === document.querySelector('.document-viewer'))).toBe(true);
});
test('documents: competing and future providers never auto-select', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.documents';
  other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.documents/viewer' }] };
  const future = structuredClone(other); future.id = 'future.documents'; future.contributes.components[0].id = 'future.documents/viewer'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  const region = await explorer(page);
  await expect(region.getByLabel('Document presentation', { exact: true })).toHaveValue('');
  await expect(region.locator('option[value="future.documents/viewer"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Document presentation', { exact: true }).selectOption('other.documents/viewer'); await back(page);
  await expect(page.locator('[data-document-provider]')).toHaveAttribute('data-document-provider', 'other.documents/viewer');
});
for (const [file, kind] of [['report.pdf', 'pdf'], ['proposal.docx', 'docx'], ['budget.xlsx', 'sheet'], ['screenshot.png', 'image']]) {
  test(`documents: ${kind} live viewer and original selection survive replacement fault, disable and safe mode`, async ({ page }) => {
    await setup(page, [manifest]);
    await openInspectorTab(page, 'Files'); await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: file, exact: true }).click();
    const viewer = page.locator(`.office-viewer[data-kind="${kind}"]`);
    await expect(viewer).toBeVisible();
    if (kind === 'pdf') await expect(viewer.locator('canvas').first()).toBeVisible();
    if (kind === 'sheet') await viewer.getByRole('button', { name: 'Log', exact: true }).click();
    if (kind === 'image') await viewer.getByRole('button', { name: 'Actual size', exact: true }).click();
    const node = await viewer.elementHandle();
    const region = await explorer(page);
    await region.getByLabel('Document presentation', { exact: true }).selectOption('sample.documents/viewer'); await back(page);
    expect(await node!.evaluate(node => node.isConnected)).toBe(true);
    if (kind === 'pdf') {
      await page.getByRole('button', { name: 'Preview in browser', exact: true }).click();
      await expect(page.locator('#browser-panel')).toBeVisible();
      await page.getByRole('tab', { name: 'Open files', exact: true }).click();
    }
    if (kind === 'sheet') {
      await viewer.getByRole('button', { name: 'Budget', exact: true }).click();
      await viewer.getByRole('button', { name: 'Log', exact: true }).click();
    }
    if (kind === 'image') {
      await viewer.getByRole('button', { name: 'Actual size', exact: true }).click();
      await viewer.getByRole('button', { name: 'Actual size', exact: true }).click();
    }
    await page.getByRole('tab', { name: file, exact: true }).focus();
    await page.evaluate(async () => {
      const api = await (window as any).__previewReplacementModules();
      api.applyDocumentPresentation(document.querySelector('#file-panel'), () => { throw Error('controlled document presentation fault'); });
      dispatchEvent(new Event('pandacode-components-change'));
    });
    await expect(page.locator('[data-document-provider]')).toHaveCount(0);
    await expect(page.getByRole('tab', { name: file, exact: true })).toBeFocused();
    expect(await node!.evaluate(node => node.isConnected)).toBe(true);
    if (kind === 'sheet') await expect(viewer.getByRole('button', { name: 'Log', exact: true })).toHaveAttribute('aria-pressed', 'true');
    if (kind === 'image') await expect(viewer.getByRole('button', { name: 'Actual size', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await explorer(page); await page.getByRole('button', { name: 'Disable sample.documents', exact: true }).click();
    await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
    expect(await node!.evaluate(node => node.isConnected)).toBe(true);
    await expect(page.getByRole('tab', { name: file, exact: true })).toHaveAttribute('aria-selected', 'true');
  });
}
