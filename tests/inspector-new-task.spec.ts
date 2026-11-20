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

test('a hidden inspector stays hidden in tasks that had it open, and after a reload', async ({ page }) => {
  await page.goto('/');
  const inspector = page.locator('#inspector');
  const select = async (id: string) => {
    await page.locator(`.task-item[data-id="${id}"]`).click();
    await expect(page.locator(`.task-item[data-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  };
  await expect(page.locator('.task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  await expect(inspector).toBeVisible();
  // session-2 remembers an open panel...
  await select('session-2');
  await expect(inspector).toBeVisible();
  await select('session-1');
  await page.locator('#inspector-toggle').click();
  await expect(inspector).toBeHidden();
  // ...but the user's hide wins over it.
  await select('session-2');
  await expect(inspector).toBeHidden();
  await select('session-3');
  await expect(inspector).toBeHidden();

  // The choice survives a relaunch: no task opens the panel by itself.
  await page.reload();
  await expect(page.locator('.task-item[data-id]').first()).toBeVisible();
  await select('session-2');
  await expect(inspector).toBeHidden();
  await select('session-1');
  await expect(inspector).toBeHidden();
  await expect(page.locator('#inspector-toggle')).not.toHaveClass(/active/);

  // Showing it again is remembered the same way: both previously visited and unvisited tasks open with the panel.
  await page.locator('#inspector-toggle').click();
  await expect(inspector).toBeVisible();
  await select('session-2');
  await expect(inspector).toBeVisible();
  await select('session-4');
  await expect(inspector).toBeVisible();
});
