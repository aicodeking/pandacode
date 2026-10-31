import { expect, test, type Page } from '@playwright/test';

const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const savedPermission = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  const id = document.querySelector<HTMLElement>('.task-item.selected')?.dataset.id;
  return id ? (await invoke('get_task', { sessionId: id }))?.mode : undefined;
});

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: previewBody(await response.text()) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
});

test('offers Approve for me to Claude Code and keeps it with the task', async ({ page }) => {
  const trigger = page.locator('#mode-picker-trigger');
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await trigger.click();
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
  await menu.getByRole('menuitemradio', { name: 'Approve for me', exact: true }).click();
  await expect(trigger).toHaveText('Approve for me');
  await expect(trigger).toHaveAttribute('title', /auto mode/);
  await expect.poll(() => savedPermission(page)).toBe('review');
  await page.locator('.task-item[data-id="session-4"]').click();
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(trigger).toHaveText('Approve for me');
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Approve for me', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('shows Approve for me as unavailable instead of another mode on a harness without it', async ({ page }) => {
  const trigger = page.locator('#mode-picker-trigger');
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  // Kimi Code task: no agent-reviewed approvals, so the option is not offered.
  await page.locator('.task-item[data-id="session-3"]').click();
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Approve for me', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  // A task that already holds the mode (e.g. after a harness switch) says why it cannot run.
  await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    await invoke('update_session', { sessionId: 'session-3', mode: 'review' });
  });
  await page.locator('.task-item[data-id="session-4"]').click();
  await page.locator('.task-item[data-id="session-3"]').click();
  await expect(trigger).toHaveText('Approve for me');
  await trigger.click();
  const row = menu.getByRole('menuitemradio', { name: 'Approve for me', exact: true });
  await expect(row).toBeDisabled();
  await expect(menu).toContainText('no agent-reviewed approvals');
});

test('describes Plan mode investigation for Claude Code', async ({ page }) => {
  await page.locator('#mode-picker-trigger').click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name: 'Plan mode', exact: true }).click();
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('title', /web lookups run, even outside this project/);
  await expect.poll(() => savedPermission(page)).toBe('plan');
});
