import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const rows = (page: Page) => panel(page).locator('.queue-row');
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__queueCalls ?? []).filter((c: any) => c.command === name), name);
const emit = (page: Page, event: Record<string, unknown>) => page.evaluate(event => {
  // Native storage marks the task idle when its run ends; the held preview run does not.
  if (event.kind === 'done') (window as any).__queueSession(event.sessionId).status = 'idle';
  (window as any).__queueEmit('agent-event', event);
}, event);

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `(window.__queueCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'send_message' && window.__holdAgent) { session(args.sessionId).status = 'running'; return; }
      if (command === 'steer_task' && window.__rejectSteer) throw new Error('No live run to steer.');
      if (command === 'queue_add' && window.__slowQueue) await new Promise(resolve => setTimeout(resolve, 300));
      switch (command) {`);
    await route.fulfill({ response, body: body + '\nwindow.__queueEmit = emit; window.__queueSession = session; window.__queueInvoke = invoke;\n' });
  });
  await page.addInitScript(() => { (window as any).__holdAgent = true; });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
});

async function startRun(page: Page): Promise<void> {
  await prompt(page).fill('Build the feature');
  await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
}
async function queue(page: Page, texts: string[]): Promise<void> {
  for (const text of texts) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await expect(rows(page)).toHaveCount(texts.length);
}

test('Alt+Arrow reorders a queued message and announces the new position', async ({ page }) => {
  await startRun(page);
  await queue(page, ['One', 'Two', 'Three', 'Four']);
  await rows(page).nth(0).focus();
  await page.keyboard.press('Alt+ArrowDown');
  await expect(rows(page).locator('.queue-text')).toHaveText(['Two', 'One', 'Three', 'Four']);
  await expect(page.locator('#queue-live')).toHaveText('Moved queued message to position 2 of 4.');
  expect((await calls(page, 'queue_reorder')).length).toBe(1);
});

test('dragging a row onto another reorders the queue', async ({ page }) => {
  await startRun(page);
  await queue(page, ['One', 'Two', 'Three']);
  await rows(page).nth(2).dragTo(rows(page).nth(0));
  await expect(rows(page).locator('.queue-text')).toHaveText(['Three', 'One', 'Two']);
});

test('edit shows the notice and Editing badge; cancel restores the row', async ({ page }) => {
  await startRun(page);
  await queue(page, ['One']);
  await panel(page).getByRole('button', { name: 'Edit queued message 1' }).click();
  await expect(panel(page)).toContainText('You are editing a queued message. Save or cancel the edit to let it run.');
  await expect(panel(page).locator('.queue-badge')).toHaveText('Editing');
  await panel(page).getByRole('button', { name: 'Cancel edit' }).click();
  await expect(rows(page).locator('.queue-text')).toHaveText(['One']);
});

test('deleting from a held queue asks first', async ({ page }) => {
  await startRun(page);
  await queue(page, ['One', 'Two']);
  await page.evaluate(() => (window as any).__queueEmit('agent-event', { sessionId: 'session-1', kind: 'error', text: 'boom' }));
  await page.evaluate(() => { (window as any).__queueSession('session-1').status = 'idle'; (window as any).__queueEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' }); });
  await expect(panel(page)).toContainText('Paused');
  await panel(page).getByRole('button', { name: 'Remove queued message 1' }).click();
  await expect(panel(page).getByText('Delete queued message?')).toBeVisible();
  await panel(page).getByRole('button', { name: 'Keep' }).click();
  await expect(rows(page)).toHaveCount(2);
  await panel(page).getByRole('button', { name: 'Remove queued message 1' }).click();
  await panel(page).getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(rows(page)).toHaveCount(1);
});
