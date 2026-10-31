import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

const open = async (page: Page, name: string) => {
  // A file opens in the inspector's Open files tab, so the Files tree comes back for the next one.
  if (await page.locator('.file-panel-tab').isVisible()) await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('.file-row').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#file-tabs').getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
};

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await openInspectorTab(page, 'Files');
  await page.getByRole('button', { name: 'Files', exact: true }).click();
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('a PDF opens in a tab with every page drawn from its bytes', async ({ page }) => {
  await open(page, 'report.pdf');
  const viewer = page.locator('.office-viewer[data-kind="pdf"]');
  await expect(viewer.locator('.office-bar')).toHaveText('2 pages');
  await expect(viewer.locator('.pdf-page')).toHaveCount(2);
  await expect(viewer.locator('.pdf-page').first().locator('canvas')).toBeVisible();
  // The tab still offers the browser preview, and binary files have no Copy action.
  await expect(page.getByRole('button', { name: 'Preview in browser', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toHaveCount(0);
  await expect(page.locator('#browser-panel')).toBeHidden();
});

test('a Word document renders its paragraphs', async ({ page }) => {
  await open(page, 'proposal.docx');
  const viewer = page.locator('.office-viewer[data-kind="docx"]');
  await expect(viewer).toContainText('Project proposal');
  await expect(viewer).toContainText('Hello from Word.');
});

test('a spreadsheet shows a grid per sheet and says when rows are cut off', async ({ page }) => {
  await open(page, 'budget.xlsx');
  const viewer = page.locator('.office-viewer[data-kind="sheet"]');
  await expect(viewer.getByRole('button', { name: 'Budget', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.sheet-grid thead th').nth(1)).toHaveText('A');
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('Hosting');
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('120');
  await expect(viewer.locator('.office-bar span')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(viewer.locator('.sheet-grid tbody tr')).toHaveCount(2000);
  await expect(viewer.locator('.office-bar span')).toContainText('first 2,000 rows');
});

test('switching away from a document and back keeps it, and closing it disposes the viewer', async ({ page }) => {
  await open(page, 'report.pdf');
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
  await open(page, 'proposal.docx');
  await expect(page.locator('.office-viewer[data-kind="docx"]')).toContainText('Hello from Word.');
  await page.locator('#file-tabs').getByRole('tab', { name: 'report.pdf', exact: true }).click();
  await expect(page.locator('.office-viewer[data-kind="pdf"] .office-bar')).toHaveText('2 pages');
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Close proposal.docx', exact: true }).click();
  await expect(page.locator('#file-tabs')).toBeHidden();
});

test('an image opens in a tab fitted to it, with its size and an actual-size toggle', async ({ page }) => {
  await open(page, 'screenshot.png');
  const viewer = page.locator('.office-viewer[data-kind="image"]');
  await expect(viewer.locator('.office-bar')).toContainText('4 × 3 px');
  await expect(viewer.getByRole('img', { name: 'screenshot.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('#browser-panel')).toBeHidden();
  const actual = viewer.getByRole('button', { name: 'Actual size', exact: true });
  await actual.click();
  await expect(actual).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer).toHaveAttribute('data-actual', '');
});
