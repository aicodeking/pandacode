import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const banner = (page: Page) => page.getByRole('region', { name: 'Usage limit', exact: true });
const queue = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const sent = (page: Page): Promise<string[]> => page.evaluate(() => ((window as any).__limitCalls ?? []).filter((c: any) => c.command === 'send_message').map((c: any) => c.args.text));
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__limitCalls ?? []).filter((c: any) => c.command === name), name);

async function open(page: Page, seed = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/const providers\s*=/, `${seed}\nconst providers =`).replace(/switch\s*\(command\)\s*\{/, `(window.__limitCalls ??= []).push({ command, args: structuredClone(args) });
      // Like native storage, a saved prompt clears the task's usage limit.
      if (command === 'send_message' && window.__holdAgent) { Object.assign(session(args.sessionId), { status: 'running', limitedAt: null, limitedUntil: null, resumeAtReset: false }); return; }
      if (command === 'queue_add' && window.__slowQueue) await new Promise(resolve => setTimeout(resolve, 400));
      if (command === 'list_sessions' && window.__failList) throw new Error('preview: listing failed');
      switch (command) {`);
    await route.fulfill({ response, body: body + '\nwindow.__limitEmit = emit; window.__limitSession = session;\n' });
  });
  await page.addInitScript(() => { (window as any).__holdAgent = true; });
  await page.goto('/');
  await expect(prompt(page)).toBeEnabled();
}

/** Ends the held run at a usage limit, as native code would record it. */
async function hitLimit(page: Page, resetsAt: number | null): Promise<void> {
  await page.evaluate(resetsAt => {
    const task = (window as any).__limitSession('session-1');
    Object.assign(task, { limitedAt: Date.now(), limitedUntil: resetsAt, resumeAtReset: false, status: 'idle' });
    const emit = (event: object) => (window as any).__limitEmit('agent-event', { sessionId: 'session-1', ...event });
    emit({ kind: 'limited', text: '5-hour usage limit reached', data: { resetsAt, window: 'five_hour' } });
    emit({ kind: 'error', text: 'Claude AI usage limit reached' });
    emit({ kind: 'done', text: '' });
  }, resetsAt);
}

async function startRunWithQueue(page: Page): Promise<void> {
  await prompt(page).fill('Build the feature'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await prompt(page).fill('After the limit'); await prompt(page).press('Enter');
  await expect(queue(page).locator('.queue-row')).toHaveCount(1);
}

test('a usage limit holds the queue, marks the task, and Continue now recovers before queued work', async ({ page }) => {
  await open(page);
  await startRunWithQueue(page);
  await hitLimit(page, Date.now() + 2 * 3600_000);
  await expect(banner(page)).toContainText('Usage limit reached · Resets');
  await expect(queue(page)).toContainText('Paused until the usage limit resets');
  await expect(page.locator('.task-item[data-id="session-1"] .task-indicator.limited')).toHaveAttribute('aria-label', /^Usage limit · Resets/);
  await banner(page).getByRole('checkbox', { name: 'Resume at reset' }).check();
  await expect.poll(async () => (await calls(page, 'set_resume_at_reset')).at(-1)?.args).toEqual({ sessionId: 'session-1', enabled: true });
  await banner(page).getByRole('button', { name: 'Continue now' }).click();
  await expect.poll(() => sent(page)).toEqual(['Build the feature', 'Continue where you left off.']);
  await expect(banner(page)).toHaveCount(0);
  // The recovery turn ends cleanly, then the queued follow-up goes out.
  await page.evaluate(() => { (window as any).__limitSession('session-1').status = 'idle'; (window as any).__limitEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' }); });
  await expect.poll(() => sent(page)).toEqual(['Build the feature', 'Continue where you left off.', 'After the limit']);
});

test('Resume at reset continues the task when the limit resets', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await prompt(page).fill('Build the feature'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  const resetsAt = await page.evaluate(() => Date.now() + 60_000);
  await hitLimit(page, resetsAt);
  // The switch reflects the saved setting, which arrives after the simulated IPC delay.
  await banner(page).getByRole('checkbox', { name: 'Resume at reset' }).click();
  await page.clock.runFor(500);
  await expect(banner(page).getByRole('checkbox', { name: 'Resume at reset' })).toBeChecked();
  await page.clock.fastForward(30_000);
  expect(await sent(page)).toEqual(['Build the feature']);
  await page.clock.fastForward(31_000);
  await expect.poll(() => sent(page)).toEqual(['Build the feature', 'Continue where you left off.']);
});

test('a passed reset releases the queue hold without auto-sending', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await startRunWithQueue(page);
  const resetsAt = await page.evaluate(() => Date.now() + 60_000);
  await hitLimit(page, resetsAt);
  await expect(queue(page)).toContainText('Paused until the usage limit resets');
  await expect.poll(async () => (await calls(page, 'set_queue_hold')).map(call => call.args)).toEqual([{ sessionId: 'session-1', held: true }]);
  await page.clock.fastForward(61_000);
  // The banner says the limit has reset and the queue offers Resume again, but nothing sends by itself.
  await expect(banner(page)).toContainText('The usage limit has reset');
  await expect(queue(page)).not.toContainText('Paused until the usage limit resets');
  await expect(queue(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(await sent(page)).toEqual(['Build the feature']);
  expect(await calls(page, 'set_queue_hold')).toHaveLength(1);
  await queue(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => sent(page)).toEqual(['Build the feature', 'After the limit']);
  expect((await calls(page, 'set_queue_hold')).map(call => call.args)).toEqual([
    { sessionId: 'session-1', held: true }, { sessionId: 'session-1', held: false },
  ]);
});

test('a reset that passes before the run ends releases the queue hold when the run ends', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await startRunWithQueue(page);
  const resetsAt = await page.evaluate(() => Date.now() + 60_000);
  await page.evaluate(resetsAt => {
    const task = (window as any).__limitSession('session-1');
    Object.assign(task, { limitedAt: Date.now(), limitedUntil: resetsAt, resumeAtReset: false });
    const emit = (event: object) => (window as any).__limitEmit('agent-event', { sessionId: 'session-1', ...event });
    emit({ kind: 'limited', text: '5-hour usage limit reached', data: { resetsAt, window: 'five_hour' } });
  }, resetsAt);
  // The reset passes while the run is still going: the ending hold does not exist yet to release.
  await page.clock.fastForward(61_000);
  // The run then ends with the limit's ending (with the task list failing, no reload can re-check either):
  // the hold it installs must be re-checked at once.
  await page.evaluate(() => { (window as any).__failList = true; (window as any).__limitSession('session-1').status = 'idle'; (window as any).__limitEmit('agent-event', { sessionId: 'session-1', kind: 'error', text: 'Claude AI usage limit reached' }); (window as any).__limitEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' }); });
  await expect(banner(page)).toContainText('The usage limit has reset');
  await expect(queue(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(await sent(page)).toEqual(['Build the feature']);
});

test('each task resolves at its own reset time, never another task\'s', async ({ page }) => {
  await page.clock.install();
  await open(page);
  // The second task runs and holds a queue; then both tasks get limits half a second apart.
  await page.locator('.task-item[data-id="session-2"]').click();
  await startRunWithQueue(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 5_000));
  const resets = await page.evaluate(() => ({ first: Date.now() + 60_000, second: Date.now() + 60_500 }));
  // Both limits live on the mock's sessions, so a background reload keeps them.
  await page.evaluate(resets => {
    const task = (window as any).__limitSession('session-1');
    Object.assign(task, { limitedAt: Date.now(), limitedUntil: resets.first, resumeAtReset: false });
    (window as any).__limitEmit('agent-event', { sessionId: 'session-1', kind: 'limited', text: '5-hour usage limit reached', data: { resetsAt: resets.first, window: 'five_hour' } });
  }, resets);
  await page.evaluate(resets => {
    const task = (window as any).__limitSession('session-2');
    Object.assign(task, { limitedAt: Date.now(), limitedUntil: resets.second, resumeAtReset: false, status: 'idle' });
    const emit = (event: object) => (window as any).__limitEmit('agent-event', { sessionId: 'session-2', ...event });
    emit({ kind: 'limited', text: '5-hour usage limit reached', data: { resetsAt: resets.second, window: 'five_hour' } });
    emit({ kind: 'error', text: 'Claude AI usage limit reached' });
    emit({ kind: 'done', text: '' });
  }, resets);
  await expect(queue(page)).toContainText('Paused until the usage limit resets');
  // Advance to just past the first reset but short of the second: the second task's hold waits for its own time.
  await page.clock.fastForward(60_100);
  await expect(queue(page)).toContainText('Paused until the usage limit resets');
  await expect(queue(page).getByRole('button', { name: 'Resume', exact: true })).toHaveCount(0);
  await page.clock.fastForward(1_000);
  await expect(queue(page)).toContainText('The usage limit has reset');
  await expect(queue(page).getByRole('button', { name: 'Resume', exact: true })).toBeVisible();
  expect(await sent(page)).toEqual(['Build the feature']);
});

test('an overdue resume continues right after a restart', async ({ page }) => {
  await open(page, "Object.assign(sessions[0], { limitedAt: now - 7200000, limitedUntil: now - 1000, resumeAtReset: true });");
  await expect.poll(() => sent(page)).toEqual(['Continue where you left off.']);
});

test('an unknown reset time is shown honestly and cannot be scheduled', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Build the feature'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await hitLimit(page, null);
  await expect(banner(page)).toContainText('Reset time not reported');
  await expect(banner(page).getByRole('checkbox', { name: 'Resume at reset' })).toHaveCount(0);
  await banner(page).getByRole('button', { name: 'Dismiss usage limit' }).click();
  await expect(banner(page)).toHaveCount(0);
  expect((await calls(page, 'clear_usage_limit')).length).toBe(1);
});

test('a message saved as the run hits a limit stays held instead of being sent', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Build the feature'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(() => { (window as any).__slowQueue = true; });
  await prompt(page).fill('Typed at the last moment'); await prompt(page).press('Enter');
  await hitLimit(page, Date.now() + 3600_000);
  await expect(queue(page).locator('.queue-text')).toHaveText(['Typed at the last moment']);
  await expect(queue(page)).toContainText('Paused until the usage limit resets');
  await page.waitForTimeout(800);
  expect(await sent(page)).toEqual(['Build the feature']);
});
