import { expect, test, type Page } from '@playwright/test';

const token = (page: Page, name: string) => page.locator('html').evaluate((node, property) => getComputedStyle(node).getPropertyValue(property).trim(), name);
const maxWidth = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => getComputedStyle(node).maxWidth);
const saved = (page: Page) => page.evaluate(() => localStorage.getItem('pandacode.readingWidth'));

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await expect(page.locator('#transcript > .turn-card').first()).toBeVisible();
}

async function openAppearance(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance', exact: true }).click();
  return page.getByRole('group', { name: 'Reading width', exact: true });
}

test('reading width widens the thread and composer from Appearance and remembers the choice', async ({ page }) => {
  await open(page);
  expect(await token(page, '--reading-width')).toBe('830px');
  expect(await token(page, '--composer-width')).toBe('950px');
  expect(await maxWidth(page, '#composer-area')).toBe('950px');
  expect(await maxWidth(page, '#transcript > .turn-card')).toBe('830px');

  const control = await openAppearance(page);
  const comfortable = control.getByRole('button', { name: 'Comfortable', exact: true });
  const wide = control.getByRole('button', { name: 'Wide', exact: true });
  await expect(comfortable).toHaveAttribute('aria-pressed', 'true');
  await expect(wide).toHaveAttribute('aria-pressed', 'false');
  await expect(control.locator('.segment-thumb')).toHaveCount(1);

  await wide.click();
  await expect(wide).toHaveAttribute('aria-pressed', 'true');
  await expect(comfortable).toHaveAttribute('aria-pressed', 'false');
  await expect.poll(() => saved(page)).toBe('wide');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.readingWidth)).toBe('wide');
  await expect.poll(() => token(page, '--reading-width')).toBe('1040px');
  await expect.poll(() => token(page, '--composer-width')).toBe('1160px');

  // Back in the workspace the new measure is in force for the thread and the composer.
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(page.locator('#transcript > .turn-card').first()).toBeVisible();
  expect(await maxWidth(page, '#composer-area')).toBe('1160px');
  expect(await maxWidth(page, '#transcript > .turn-card')).toBe('1040px');

  // A saved preference: the next launch opens wide, before Settings is ever mounted.
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(page.locator('.task-item.selected')).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.dataset.readingWidth)).toBe('wide');
  expect(await token(page, '--reading-width')).toBe('1040px');

  // Comfortable brings back the documented measure and drops the preference.
  const again = await openAppearance(page);
  await again.getByRole('button', { name: 'Comfortable', exact: true }).click();
  await expect.poll(() => saved(page)).toBe('comfortable');
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.readingWidth)).toBeUndefined();
  await expect.poll(() => token(page, '--reading-width')).toBe('830px');
});
