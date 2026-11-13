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

for (const action of ['new-task', 'new-chat']) {
  test(`${action} waits visibly for discovery and drops creation after navigation`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/case ["']list_providers["']:/, match => `${match}
        await new Promise(resolve => { window.__releaseProviders = resolve; });`).replace(/case ["'](?:create_session|chat_create)["']:/g, match => `${match} window.__createdDuringBoot = true;`);
      await route.fulfill({ response, body });
    });
    await page.goto('/');
    await expect(page.locator('#transcript .message').first()).toBeVisible();
    const button = page.locator(`.sidebar-actions [data-action="${action}"]`);
    await expect(button).toHaveAttribute('aria-busy', 'true');
    await expect(button).toContainText('Loading agents');
    await button.click();
    await page.locator('#navigation .task-item[data-id="session-2"]').click();
    await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
    await page.evaluate(() => (window as any).__releaseProviders());
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
    await page.evaluate(async () => { await new Promise(requestAnimationFrame); await new Promise(requestAnimationFrame); });
    await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
    expect(await page.evaluate(() => (window as any).__createdDuringBoot ?? false)).toBe(false);
  });
}

test('a New task queued during discovery opens when the user stays on the thread', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/case ["']list_providers["']:/, match => `${match}
      await new Promise(resolve => { window.__releaseProviders = resolve; });`);
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(page.locator('#transcript .message').first()).toBeVisible();
  await page.locator('.new-task-button').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-1');
  await page.evaluate(() => (window as any).__releaseProviders());
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
});
