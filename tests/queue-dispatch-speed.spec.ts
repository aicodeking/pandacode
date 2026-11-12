import { expect, test, type Page } from '@playwright/test';

// A clean run end sends the next queued message without waiting for the inspector's
// git/file refresh; a failed or stopped run still holds the queue.
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const panel = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const rows = (page: Page) => panel(page).locator('.queue-row');
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__queueCalls ?? []).filter((c: any) => c.command === name), name);
const sent = async (page: Page): Promise<string[]> => (await calls(page, 'send_message')).map(c => c.args.text ?? c.args.prompt ?? c.args.message ?? '');
const emit = (page: Page, event: Record<string, unknown>) => page.evaluate(event => {
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
      if (command === 'git_status' && window.__slowGit) { window.__gitWaiting = (window.__gitWaiting ?? 0) + 1; await new Promise(resolve => { (window.__gitRelease ??= []).push(resolve); }); window.__gitWaiting--; }
      switch (command) {`);
    await route.fulfill({ response, body: body + '\nwindow.__queueEmit = emit; window.__queueSession = session;\n' });
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
async function queue(page: Page, text: string): Promise<void> {
  await prompt(page).fill(text); await prompt(page).press('Enter');
  await expect(rows(page)).toHaveCount(1);
}
/** From here on git_status never answers until released. */
const slowGit = (page: Page) => page.evaluate(() => { (window as any).__slowGit = true; });
const releaseGit = (page: Page) => page.evaluate(() => { const w = window as any; w.__slowGit = false; for (const resolve of w.__gitRelease ?? []) resolve(); w.__gitRelease = []; });

test('a clean run end sends the queued message while git status is still loading', async ({ page }) => {
  await startRun(page);
  await queue(page, 'Follow up');
  expect(await calls(page, 'send_message')).toHaveLength(1);
  await slowGit(page);
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  // The run-end inspector refresh has started and is stuck on git_status…
  await expect.poll(() => page.evaluate(() => (window as any).__gitWaiting ?? 0)).toBeGreaterThan(0);
  // …yet the queued message has already gone out.
  await expect.poll(() => calls(page, 'send_message').then(list => list.length), { timeout: 3000 }).toBe(2);
  expect((await sent(page)).join('\n')).toContain('Follow up');
  expect(await page.evaluate(() => (window as any).__gitWaiting)).toBeGreaterThan(0);
  await expect(rows(page)).toHaveCount(0);
  await releaseGit(page);
});

test('a failed run still holds the queue while git status is slow', async ({ page }) => {
  await startRun(page);
  await queue(page, 'Follow up');
  await slowGit(page);
  await emit(page, { sessionId: 'session-1', kind: 'error', text: 'boom' });
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect(panel(page)).toContainText('Paused');
  await releaseGit(page);
  await page.waitForTimeout(500);
  expect(await calls(page, 'send_message')).toHaveLength(1);
  await expect(rows(page)).toHaveCount(1);
});

test('a stopped run still holds the queue while git status is slow', async ({ page }) => {
  await startRun(page);
  await queue(page, 'Follow up');
  await slowGit(page);
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(panel(page)).toContainText('Paused');
  await releaseGit(page);
  await page.waitForTimeout(500);
  expect(await calls(page, 'send_message')).toHaveLength(1);
  await expect(rows(page)).toHaveCount(1);
});
