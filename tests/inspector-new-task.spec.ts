import { expect, test } from '@playwright/test';

test('a new task keeps the inspector closed when the user closed it', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  const inspector = page.locator('#inspector');
  await expect(inspector).toBeVisible();
  await page.locator('#inspector-toggle').click();
  await expect(inspector).toBeHidden();
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
  await expect(inspector).toBeHidden();
  await expect(page.locator('#inspector-toggle')).not.toHaveClass(/active/);
});
