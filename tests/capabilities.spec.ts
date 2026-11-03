import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });

test('capability and cache alignment tables show safe local metadata', async ({ page }) => {
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
  await page.keyboard.press('Meta+,');
  const panel = settings(page);
  await expect(panel.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await panel.getByRole('tab', { name: 'Tools', exact: true }).click();
  await panel.getByText('Capabilities and cache', { exact: true }).click();

  const capabilities = panel.getByRole('table', { name: 'Capability alignment', exact: true });
  const cache = panel.getByRole('table', { name: 'Cache alignment', exact: true });
  await expect(capabilities).toBeVisible();
  await expect(capabilities).toContainText('Preview documentation');
  await expect(capabilities).toContainText(/discovered/i);
  await expect(cache).toBeVisible();
  await expect(cache).toContainText('Claude Code');
  await expect(cache).toContainText(/cached system prompt/i);
  await expect(cache).toContainText(/not exposed/i);
  await expect(panel).not.toContainText('preview-secret');
});
