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

for (const action of ['new-task', 'new-chat']) {
  test(`${action} waits visibly for discovery and drops creation after navigation`, async ({ page }) => {
    if (action === 'new-chat') await page.emulateMedia({ reducedMotion: 'reduce' });
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
    await expect(button).toHaveAccessibleName(action === 'new-task' ? /^New task\b/ : 'New chat');
    await expect(button).toHaveAttribute('aria-description', 'Loading agents…');
    await button.click();
    await expect(button.locator('.startup-progress')).toBeVisible();
    await expect(button).toHaveCSS('cursor', 'progress');
    if (action === 'new-chat') await expect(button.locator('.startup-progress')).toHaveCSS('animation-name', 'none');
    await expect(button).toHaveAccessibleName(action === 'new-task' ? /^New task\b/ : 'New chat');
    await page.locator('#navigation .task-item[data-id="session-2"]').click();
    await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
    await page.evaluate(() => (window as any).__releaseProviders());
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await expect(button.locator('.startup-progress')).toHaveCount(0);
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

for (const action of ['new-task', 'new-chat']) {
  test(`${action} pressed before the first session list survives automatic boot selection`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/case ["']list_sessions["']:/, match => `${match}
        if (!window.__sessionsReleased) await new Promise(resolve => { window.__releaseSessions = () => { window.__sessionsReleased = true; resolve(); }; });`);
      await route.fulfill({ response, body });
    });
    await page.goto('/');
    await page.waitForFunction(() => typeof (window as any).__releaseSessions === 'function');
    await page.locator(`.sidebar-actions [data-action="${action}"]`).click();
    await page.evaluate(() => (window as any).__releaseSessions());
    await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', /.+/);
    await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
    if (action === 'new-task') await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  });
}

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

  const bootOrder = await page.evaluate(() => {
    const calls = ((window as any).__bootAndNewTaskCalls as Array<{ command: string; sessionId: string | null }>).map(item => item.command);
    return {
      projectsAt: calls.indexOf('list_projects'),
      sessionsAt: calls.indexOf('list_sessions'),
      providersAt: calls.indexOf('list_providers'),
    };
  });
  expect(bootOrder.projectsAt).toBeGreaterThanOrEqual(0);
  expect(bootOrder.sessionsAt).toBeGreaterThanOrEqual(0);
  expect(bootOrder.providersAt).toBeGreaterThan(bootOrder.projectsAt);
  expect(bootOrder.providersAt).toBeGreaterThan(bootOrder.sessionsAt);

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
    return calls.filter(item => item.command === 'prewarm_draft_session' && item.sessionId === id).length;
  }, createdId);
  expect(prewarmCalls).toBe(1);
});
});
