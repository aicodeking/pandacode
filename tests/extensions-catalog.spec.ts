import { test, expect, type Page } from '@playwright/test';
async function explorer(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
test('extensions catalog: core discovery, pagination, public handlers and keyboard stay usable', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#prompt')).toBeVisible();
  await page.locator('#prompt').fill('catalog draft');
  const region = await explorer(page);
  await expect(region.getByRole('list', { name: 'Public surfaces' }).getByRole('listitem')).toHaveCount(11);
  await expect(region.locator('[data-catalog-item]')).toHaveCount(5);
  await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await expect(region.locator('[data-catalog-item]')).toHaveCount(5);
  const sidebar = page.locator('#sidebar-toggle');
  const before = await sidebar.getAttribute('aria-expanded');
  await region.getByRole('button', { name: 'Run Toggle sidebar', exact: true }).click();
  await expect(sidebar).toHaveAttribute('aria-expanded', before === 'true' ? 'false' : 'true');
  await region.getByRole('button', { name: 'Run Toggle sidebar', exact: true }).focus();
  await page.keyboard.press('Enter'); await expect(sidebar).toHaveAttribute('aria-expanded', before!);
  await region.getByRole('button', { name: 'First items', exact: true }).click();
  const theme = page.locator('#theme-toggle'), themeBefore = await theme.getAttribute('aria-pressed');
  await region.getByRole('button', { name: 'Run Toggle theme', exact: true }).click();
  await expect(theme).toHaveAttribute('aria-pressed', themeBefore === 'true' ? 'false' : 'true');
  // The original toggleTheme handler remounts open Settings on Appearance.
  await expect(page.getByRole('tab', { name: 'Appearance', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await region.getByRole('button', { name: 'Run Settings', exact: true }).click();
  await expect(page.getByRole('tab', { name: 'Extensions', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#prompt')).toHaveValue('catalog draft');
});
test('extensions catalog: sample metadata survives reload, disable removes only its items', async ({ page }) => {
  await page.goto('/'); await expect(page.locator('#prompt')).toBeVisible();
  let region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await region.getByLabel('Item owner', { exact: true }).selectOption('sample.project-helper');
  await expect(region.locator('[data-catalog-item]')).toHaveCount(2);
  const ids = await region.locator('[data-catalog-item]').evaluateAll(items => items.map(item => item.getAttribute('data-catalog-item')));
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.sidebar.footer');
  await expect(region.locator('[data-catalog-item]')).toHaveCount(1);
  await page.reload(); await expect(page.locator('#prompt')).toBeVisible(); region = await explorer(page);
  await region.getByLabel('Item owner', { exact: true }).selectOption('sample.project-helper');
  expect(await region.locator('[data-catalog-item]').evaluateAll(items => items.map(item => item.getAttribute('data-catalog-item')))).toEqual(ids);
  await page.getByRole('button', { name: 'Disable sample.project-helper', exact: true }).click();
  await expect(region.getByLabel('Item owner', { exact: true }).locator('option')).toHaveCount(2);
  await expect(region.locator('[data-catalog-item]')).toHaveCount(5);
});
