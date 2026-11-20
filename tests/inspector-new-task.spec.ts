import { expect, test } from '@playwright/test';

test.describe('inspector new task', () => {
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

test('closing the inspector suspends diffs without losing the reader folds', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#inspector .diff-viewer[data-diff-state="ready"]').first()).toBeVisible({ timeout: 15_000 });
  const toggles = page.locator('#inspector .cv-toggle');
  await toggles.first().click();
  await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#inspector-toggle').click();
  await expect(page.locator('#inspector')).toBeHidden();
  await expect(page.locator('#inspector .diff-viewer')).toHaveCount(0);
  await page.locator('#inspector-toggle').click();
  await expect(toggles.first()).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('#inspector .diff-viewer[data-diff-state="ready"]').first()).toBeVisible({ timeout: 15_000 });
});

test('New task opens and focuses #prompt immediately without redundant history, task, team, or fresh-workspace IPCs', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/switch \(command\) \{/, `
      (window.__bootAndNewTaskCalls ??= []).push({ command, sessionId: args?.sessionId ?? null });
      switch (command) {`);
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(page.locator('.task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#inspector .changes-view')).toBeVisible();

  await page.evaluate(() => { (window as any).__bootAndNewTaskCalls = []; });
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#prompt')).toBeFocused();
  const createdId = await page.locator('#prompt').getAttribute('data-session-id');
  expect(createdId).toBeTruthy();
  expect(createdId).not.toBe('session-1');

  const newTaskCalls = await page.evaluate(id => {
    const calls = (window as any).__bootAndNewTaskCalls as Array<{ command: string; sessionId: string | null }>;
    return {
      forCreated: calls.filter(item => item.sessionId === id).map(item => item.command),
      gitStatusCalls: calls.filter(item => item.command === 'git_status').length,
    };
  }, createdId);
  expect(newTaskCalls.forCreated).not.toContain('messages_page');
  expect(newTaskCalls.forCreated).not.toContain('get_messages');
  expect(newTaskCalls.forCreated).not.toContain('get_task');
  expect(newTaskCalls.forCreated).not.toContain('architect_get');
  expect(newTaskCalls.forCreated).not.toContain('prewarm_draft_session');
  expect(newTaskCalls.gitStatusCalls).toBe(0);

  await page.locator('#prompt').fill('h');
  await page.locator('#prompt').fill('hello');
  const prewarmCalls = await page.evaluate(id => {
    const calls = (window as any).__bootAndNewTaskCalls as Array<{ command: string; sessionId: string | null }>;
    return calls.filter(item => item.command === 'warm_task' && item.sessionId === id).length;
  }, createdId);
  expect(prewarmCalls).toBe(1);
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
});
