import { expect, test } from '@playwright/test';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await page.locator('#inspector-toggle').click();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
});

test('renders Markdown as a reader and switches to raw source', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  const viewer = page.locator('.document-viewer');
  await expect(viewer.locator('.doc-reader h1')).toHaveText('Orbit');
  await expect(viewer.locator('.doc-reader li')).toHaveCount(2);
  await expect(viewer.locator('.doc-stats')).toContainText('min read');
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
  await expect(viewer.locator('.doc-reader')).toHaveCSS('user-select', 'text');

  await viewer.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.doc-raw')).toContainText('# Orbit');
  await expect(viewer.locator('.doc-raw')).toContainText('## Usage');

  // The choice is remembered for Markdown files during the session.
  await page.locator('[data-action="back-inspector"]').click();
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await expect(page.locator('.document-viewer .doc-raw')).toContainText('# Orbit');
});

test('shows code with line numbers that are not selectable and a wrap toggle', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="package.json"]').click();
  const viewer = page.locator('.document-viewer');
  await expect(viewer.locator('.code-preview')).toContainText('"name": "orbit"');
  await expect(viewer.locator('.line-number').first()).toHaveText('1');
  await expect(viewer.locator('.line-number').first()).toHaveCSS('user-select', 'none');
  await expect(viewer.locator('.doc-view-switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeVisible();
  const wrap = viewer.getByRole('button', { name: 'Wrap', exact: true });
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await wrap.click();
  await expect(viewer.getByRole('button', { name: 'Wrap', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.code-line code').first()).toHaveCSS('white-space', 'pre-wrap');
});
