import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

// The inspector's file surfaces against a multi-folder project (?folders gives
// project-1 the primary orbit plus the orbit-web repository and orbit-docs).
const tab = (page: Page, action: string) => page.locator(`.inspector-tabs [data-action="${action}"]`);

async function open(page: Page, query = '/?folders'): Promise<void> {
  await page.goto(query);
  // Cold dev servers can take a few seconds to compile the first page.
  await expect(page.locator('.task-item.selected')).toBeVisible({ timeout: 20_000 });
}

test('the Files tree renders one section per folder', async ({ page }) => {
  await open(page);
  await openInspectorTab(page, 'Files');
  await tab(page, 'tab-files').click();
  const headings = page.locator('.file-folder-heading');
  await expect(headings).toHaveCount(3);
  await expect(headings).toHaveText(['orbit', 'orbit-web', 'orbit-docs']);
  // Each section carries its own tree: the primary keeps the sample checkout.
  const web = page.locator('.file-folder-heading', { hasText: 'orbit-web' }).locator('xpath=following-sibling::div[1]');
  await expect(web.locator('.file-row').getByRole('button', { name: 'src', exact: true })).toBeVisible();
  await expect(web.locator('.file-row').getByRole('button', { name: 'package.json', exact: true })).toBeVisible();
});

test('opening a file from the web folder keys the tab and read to that folder', async ({ page }) => {
  await open(page);
  await openInspectorTab(page, 'Files');
  await tab(page, 'tab-files').click();
  const web = page.locator('.file-folder-heading', { hasText: 'orbit-web' }).locator('xpath=following-sibling::div[1]');
  const src = web.getByRole('button', { name: 'src', exact: true });
  await expect(src).toBeVisible();
  await src.click();
  const app = web.getByRole('button', { name: 'app.tsx', exact: true });
  await expect(app).toBeVisible();
  await app.click();
  // The tab is labelled with the file name suffixed by its folder, and reads through the qualifier.
  await expect(page.locator('#file-tabs .file-tab')).toHaveText(/app\.tsx\s*·\s*orbit-web/);
  await expect(page.locator('.file-view-path')).toHaveText('orbit-web/src/app.tsx');
});

test('search fans out across folders and groups results by label', async ({ page }) => {
  await open(page);
  await openInspectorTab(page, 'Search');
  await tab(page, 'tab-search').click();
  await page.getByRole('searchbox', { name: 'Search in files' }).fill('search');
  const sections = page.locator('.search-section-folder');
  await expect(sections).toHaveCount(3, { timeout: 10_000 });
  await expect(sections.filter({ hasText: 'orbit-web' }).locator('.search-row[data-search-open="orbit-web/src/app.tsx"]').first()).toBeVisible();
  await expect(sections.filter({ hasText: 'orbit-docs' }).locator('.search-row[data-search-open="orbit-docs/setup.md"]').first()).toBeVisible();
});

test('a single-folder task keeps one unheaded tree', async ({ page }) => {
  await open(page, '/');
  await openInspectorTab(page, 'Files');
  await tab(page, 'tab-files').click();
  await expect(page.locator('.file-folder-heading')).toHaveCount(0);
  await expect(page.locator('.file-row').first()).toBeVisible();
});
