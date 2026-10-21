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
  await expect(prompt(page)).toBeEnabled();
}

test('queues messages during a run, edits and reorders them, and steers mid-turn', async ({ page }) => {
  await startRun(page);
  await expect(prompt(page)).toHaveAttribute('placeholder', /Queue a follow-up · ⌘↩ steers now/);
  await prompt(page).fill('First follow-up');
  await prompt(page).press('Enter');
  await prompt(page).fill('Second follow-up');
  await prompt(page).press('Enter');
  await expect(rows(page).locator('.queue-text')).toHaveText(['First follow-up', 'Second follow-up']);
  await expect(prompt(page)).toHaveValue('');
  await expect(panel(page)).toContainText('Sends when the agent finishes');
  await panel(page).getByRole('button', { name: 'Move queued message 2 up' }).click();
  await expect(rows(page).locator('.queue-text')).toHaveText(['Second follow-up', 'First follow-up']);
  await panel(page).getByRole('button', { name: 'Edit queued message 1' }).click();
  await panel(page).getByRole('textbox', { name: 'Edit queued message' }).fill('Second follow-up, edited');
  await panel(page).getByRole('button', { name: 'Save' }).click();
  await expect(rows(page).first().locator('.queue-text')).toHaveText('Second follow-up, edited');
  // Command Enter steers into the running turn instead of queuing.
  await prompt(page).fill('Also cover the edge case');
  await prompt(page).press('ControlOrMeta+Enter');
  await expect.poll(async () => (await calls(page, 'steer_task')).map(c => c.args.text)).toEqual(['Also cover the edge case']);
  await expect(page.locator('#transcript .user-message').last()).toContainText('Also cover the edge case');
  await expect(rows(page)).toHaveCount(2);
  await panel(page).getByRole('button', { name: 'Remove queued message 2' }).click();
  await expect(rows(page)).toHaveCount(1);
});

test('delivers the next message when a run finishes and holds after a failure or a restart', async ({ page }) => {
  await startRun(page);
  for (const text of ['Next step', 'Then this']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await expect(rows(page)).toHaveCount(2);
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => c.args.text)).toEqual(['Build the feature', 'Next step']);
  await expect(rows(page)).toHaveCount(1);
  // A failed run holds the queue until Resume.
  await emit(page, { sessionId: 'session-1', kind: 'error', text: 'Usage limit reached' });
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect(panel(page)).toContainText('Paused after the run failed');
  expect((await calls(page, 'send_message')).length).toBe(2);
  await page.reload();
  await expect(panel(page)).toContainText('Paused after restart');
  await expect(rows(page).locator('.queue-text')).toHaveText(['Then this']);
  await panel(page).getByRole('button', { name: 'Resume' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => c.args.text)).toEqual(['Then this']);
  await expect(panel(page)).toHaveCount(0);
});

test('queues instead of steering when the harness cannot take mid-turn messages', async ({ page }) => {
  await page.locator('.task-item[data-id="session-3"]').click();
  await startRun(page);
  await expect(prompt(page)).toHaveAttribute('placeholder', 'Queue a follow-up…');
  await prompt(page).fill('Steer attempt');
  await prompt(page).press('ControlOrMeta+Enter');
  await expect(page.locator('#toast')).toContainText('cannot take messages mid-turn');
  await expect(rows(page).locator('.queue-text')).toHaveText(['Steer attempt']);
  expect(await calls(page, 'steer_task')).toEqual([]);
});

test('keeps every message when typing quickly while the queue is being saved', async ({ page }) => {
  await startRun(page);
  await page.evaluate(() => { (window as any).__slowQueue = true; });
  // Type with the keyboard, as a person would, while earlier saves re-render the composer.
  for (const text of ['One', 'Two', 'Three']) { await page.keyboard.type(text); await page.keyboard.press('Enter'); }
  await expect(rows(page).locator('.queue-text')).toHaveText(['One', 'Two', 'Three']);
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('');
});

test('a follow-up queued by an agent for an idle task is sent right away', async ({ page }) => {
  await page.evaluate(async () => {
    // The app's own preview instance: a fresh import can load a second copy (Vite adds ?t= after an edit).
    await (window as any).__queueInvoke('queue_add', { sessionId: 'session-2', text: 'Queued by the architect', attachments: [] });
    (window as any).__queueEmit('queue-changed', { sessionId: 'session-2' });
  });
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => [c.args.sessionId, c.args.text])).toEqual([['session-2', 'Queued by the architect']]);
});

test('Send now delivers a held entry right away and keeps the rest held', async ({ page }) => {
  await startRun(page);
  for (const text of ['Later', 'Urgent']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await emit(page, { sessionId: 'session-1', kind: 'error', text: 'Boom' });
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect(panel(page)).toContainText('Paused after the run failed');
  await panel(page).getByRole('button', { name: 'Send now: Urgent' }).click();
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => c.args.text)).toEqual(['Build the feature', 'Urgent']);
  await expect(rows(page).locator('.queue-text')).toHaveText(['Later']);
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect(panel(page)).toContainText('Paused after the run failed');
  expect((await calls(page, 'send_message')).length).toBe(2);
});

test('Send now while running stops the run, sends that entry first and keeps the others in order', async ({ page }) => {
  await startRun(page);
  for (const text of ['One', 'Two', 'Three']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  await panel(page).getByRole('button', { name: 'Send now: Three' }).click();
  await expect.poll(async () => (await calls(page, 'stop_session')).length).toBe(1);
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => c.args.text)).toEqual(['Build the feature', 'Three']);
  await expect(rows(page).locator('.queue-text')).toHaveText(['One', 'Two']);
  // The stop was for Send now, so the rest are not paused: they follow when this run ends.
  await expect(panel(page)).toContainText('Sends when the agent finishes');
  await emit(page, { sessionId: 'session-1', kind: 'done', text: '' });
  await expect.poll(async () => (await calls(page, 'send_message')).map(c => c.args.text)).toEqual(['Build the feature', 'Three', 'One']);
  await expect(rows(page).locator('.queue-text')).toHaveText(['Two']);
});

test('Steer sends a queued entry into a steerable running turn', async ({ page }) => {
  await startRun(page);
  for (const text of ['Keep', 'Steer me']) { await prompt(page).fill(text); await prompt(page).press('Enter'); }
  const steer = panel(page).getByRole('button', { name: 'Steer now: Steer me' });
  await expect(steer).toHaveText('Steer');
  await steer.click();
  await expect.poll(async () => (await calls(page, 'steer_task')).map(c => c.args.text)).toEqual(['Steer me']);
  await expect(rows(page).locator('.queue-text')).toHaveText(['Keep']);
  expect(await calls(page, 'stop_session')).toEqual([]);
});

test('non-steerable harnesses offer only Send now', async ({ page }) => {
  await page.locator('.task-item[data-id="session-3"]').click();
  await startRun(page);
  await prompt(page).fill('Queued');
  await prompt(page).press('Enter');
  await expect(panel(page).getByRole('button', { name: /^Steer now/ })).toHaveCount(0);
  await expect(panel(page).getByRole('button', { name: 'Send now: Queued' })).toBeVisible();
});
