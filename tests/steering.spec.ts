import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const rows = (page: Page) => panel(page).locator('.queue-row');
const lastUser = (page: Page) => page.locator('#transcript .user-message').last();
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__steerCalls ?? []).filter((c: any) => c.command === name), name);

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    // Runs stay open (as a long turn would) so steering has something to steer.
    const body = source.replace(marker, `(window.__steerCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'send_message') { session(args.sessionId).status = 'running'; return; }
      switch (command) {`);
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
});

async function startRun(page: Page): Promise<void> {
  await prompt(page).fill('Build the feature');
  await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
}

test('the composer Steer button shows the message pending, then delivered', async ({ page }) => {
  await startRun(page);
  await prompt(page).fill('Use the new API');
  await page.getByRole('button', { name: 'Steer the running turn' }).click();
  await expect(prompt(page)).toHaveValue('');
  await expect(lastUser(page)).toContainText('Use the new API');
  await expect(lastUser(page).locator('.steer-state')).toHaveText('Steering…');
  await expect(lastUser(page).locator('.steer-state')).toHaveCount(0);
  await expect(lastUser(page)).toContainText('Use the new API');
  expect((await calls(page, 'steer_task')).map(c => c.args.text)).toEqual(['Use the new API']);
  expect(await calls(page, 'stop_session')).toEqual([]);
  await expect(panel(page)).toHaveCount(0);
});

test('a harness without live steering sends it when the turn ends', async ({ page }) => {
  await page.locator('.task-item[data-id="session-3"]').click();
  await startRun(page);
  await expect(prompt(page)).toHaveAttribute('placeholder', /⌘↩ steers now/);
  await prompt(page).fill('Then add tests');
  await prompt(page).press('ControlOrMeta+Enter');
  await expect(lastUser(page).locator('.steer-state')).toHaveText('Sends when this turn ends');
  await expect(lastUser(page).locator('.steer-state')).toHaveCount(0);
  await expect(panel(page)).toHaveCount(0);
});

test('Steer on a queued row steers that entry and leaves the rest', async ({ page }) => {
  await startRun(page);
  for (const text of ['Keep', 'Steer me']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await panel(page).getByRole('button', { name: 'Steer now: Steer me' }).click();
  await expect(lastUser(page)).toContainText('Steer me');
  await expect(rows(page).locator('.queue-text')).toHaveText(['Keep']);
  await expect(lastUser(page).locator('.steer-state')).toHaveCount(0);
  expect((await calls(page, 'steer_task')).map(c => c.args.text)).toEqual(['Steer me']);
});

test('Send now while running steers instead of stopping', async ({ page }) => {
  await startRun(page);
  for (const text of ['One', 'Two']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await panel(page).getByRole('button', { name: 'Send now: Two' }).click();
  await expect(lastUser(page)).toContainText('Two');
  await expect(rows(page).locator('.queue-text')).toHaveText(['One']);
  expect((await calls(page, 'steer_task')).map(c => c.args.text)).toEqual(['Two']);
  expect(await calls(page, 'stop_session')).toEqual([]);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

test('a steer the agent could not take goes back to the queue', async ({ page }) => {
  await startRun(page);
  await prompt(page).fill('Lost? [steer-fails]');
  await page.getByRole('button', { name: 'Steer the running turn' }).click();
  await expect(rows(page).locator('.queue-text')).toHaveText(['Lost? [steer-fails]']);
  await expect(lastUser(page).locator('.steer-state')).toContainText('moved to the queue');
});

test('the steer row and Stop never drop focus to the page, and Esc in the row keeps the run going', async ({ page }) => {
  await startRun(page);
  const steer = page.getByRole('button', { name: 'Steer the running turn' });
  await expect(steer).toHaveAttribute('aria-disabled', 'true');
  await prompt(page).fill('Use the new API');
  await expect(steer).toHaveAttribute('aria-disabled', 'false');
  await steer.focus();
  await page.keyboard.press('Enter');
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('');

  await prompt(page).fill('Draft');
  await page.getByRole('button', { name: 'Clear draft' }).focus();
  await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeFocused();
  expect(await calls(page, 'stop_session')).toEqual([]);

  await page.getByRole('button', { name: 'Stop task', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page, 'stop_session')).toHaveLength(1);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  await expect(prompt(page)).toBeFocused();
});
