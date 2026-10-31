import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Android emulator flags', exact: true });

async function openFlags(page: Page): Promise<void> {
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
  await page.keyboard.press('Meta+,');
  await expect(settings(page).getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await settings(page).getByRole('tab', { name: 'Tools & add-ons', exact: true }).click();
  await settings(page).getByRole('button', { name: 'Set flags', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

test('Android emulator flags are saved with per-device overrides and survive reopening', async ({ page }) => {
  await openFlags(page);
  await expect(dialog(page).getByLabel('Default flags')).toBeVisible();
  // The preview lists one Android device; iOS devices never appear here.
  const pixel = dialog(page).getByLabel('Pixel 9 API 35');
  await expect(pixel).toBeVisible();
  await dialog(page).getByLabel('Default flags').fill('-no-snapshot');
  await pixel.fill('-gpu host');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(page.locator('#toast')).toContainText('Emulator flags saved');
  await expect(dialog(page)).not.toBeVisible();

  await settings(page).getByRole('button', { name: 'Set flags', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Default flags')).toHaveValue('-no-snapshot');
  await expect(dialog(page).getByLabel('Pixel 9 API 35')).toHaveValue('-gpu host');

  // A cleared device entry falls back to the default again.
  await dialog(page).getByLabel('Pixel 9 API 35').fill('');
  await dialog(page).getByRole('button', { name: 'Save' }).click();
  await expect(dialog(page)).not.toBeVisible();
  await settings(page).getByRole('button', { name: 'Set flags', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByLabel('Default flags')).toHaveValue('-no-snapshot');
  await expect(dialog(page).getByLabel('Pixel 9 API 35')).toHaveValue('');
});
