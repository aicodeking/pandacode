import { expect, test, type Page } from '@playwright/test';

/* Multi-machine orchestration on the preview's sample account (src/preview-remote.ts): the
 * Settings switch and linked computers, an agent's link request, the lineage strip and the
 * transcript's threads card. Titles start with "machine orchestration" for the WebKit grep. */
async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  return panel;
}
const task = (page: Page, title: string) => page.locator('#navigation .task-item', { hasText: title });
async function openTask(page: Page, title: string) {
  // Many launched threads fold a project's older tasks behind "Show N more".
  const more = page.locator('#navigation').getByRole('button', { name: /^Show \d+ more/ });
  if (!await task(page, title).count() && await more.count()) await more.first().click();
  await task(page, title).first().click();
  await expect(page.locator('#prompt')).toBeVisible();
  return (await page.locator('#prompt').getAttribute('data-session-id'))!;
}
async function backToTask(page: Page) {
  await page.getByRole('button', { name: /^back/i }).click();
  return openTask(page, 'Make search feel instant');
}
async function withOrchestration(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.waitForFunction(() => typeof (window as any).__orchestrationEnable === 'function' && typeof (window as any).__machineChild === 'function');
  await page.evaluate(() => (window as any).__orchestrationEnable(true));
}
type Child = { title: string; provider?: string; status?: string; machine?: { id: string; name: string }; launch?: boolean };
const addChild = (page: Page, parent: string, child: Child) => page.evaluate(([id, spec]) => (window as any).__machineChild(id, spec) as string, [parent, child] as const);
const mini = { id: 'dev-mini', name: 'ProMini' };

test('machine orchestration: the switch and linked computers live in Remote access', async ({ page }) => {
  const panel = await signIn(page);
  const toggle = panel.getByRole('checkbox', { name: 'Agent orchestration' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  await expect(panel.getByText('No linked computers.')).toBeVisible();

  await panel.getByRole('button', { name: 'Link a computer…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link a machine' });
  await dialog.getByRole('radio', { name: /Studio iMac/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByLabel('What agents here may do there').selectOption('read');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  const access = panel.getByRole('combobox', { name: 'Access: Studio iMac' });
  await expect(access).toHaveValue('read');
  await access.selectOption('full');
  await expect(panel.locator('[data-link="dev-studio"]')).toContainText('Full access');
  await panel.getByRole('button', { name: 'Unlink Studio iMac' }).click();
  await expect(panel.locator('[data-link="dev-studio"]')).toHaveCount(0);
});

test('machine orchestration: a link request shows a card; Not now declines it', async ({ page }) => {
  await signIn(page);
  const sessionId = await backToTask(page);
  await page.evaluate(id => (window as any).__machineLinkRequest(id, 'dev-studio', 'Run the slow suite on another machine'), sessionId);
  const card = page.getByRole('region', { name: 'Link a machine' });
  await expect(card).toContainText('Link a machine to this environment');
  await expect(card).toContainText('Run the slow suite on another machine');
  // No notice for the task in view.
  await expect(page.locator('#toast .toast-action')).toHaveCount(0);

  await card.getByRole('button', { name: 'Not now' }).click();
  await expect(card).toHaveCount(0);
  const responses = await page.evaluate(() => (window as any).__machineLinkResponses);
  expect(responses).toEqual([expect.objectContaining({ deviceId: null, access: null })]);
});

test('machine orchestration: the pending snapshot keeps newer requests and never revives settled ones', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__pendingDelay = 1500;
    (window as any).__seedLinkRequest = { requestId: 'request-old', sessionId: 'session-1', machine: null, reason: 'Answered elsewhere' };
  });
  await page.goto('/');
  await openTask(page, 'Make search feel instant');
  await page.waitForFunction(() => typeof (window as any).__machineLinkSettle === 'function');
  // While the snapshot (which still holds request-old) is in flight: it settles, and a new request arrives.
  await page.evaluate(() => { (window as any).__machineLinkSettle('request-old'); (window as any).__machineLinkRequest('session-1', null, 'Arrived after the snapshot'); });
  const card = page.getByRole('region', { name: 'Link a machine' });
  await expect(card).toContainText('Arrived after the snapshot');
  await page.waitForTimeout(1800);
  await expect(card).toHaveCount(1);
  await expect(card).toContainText('Arrived after the snapshot');
  await expect(page.getByText('Answered elsewhere')).toHaveCount(0);
});

test('machine orchestration: a request from a task out of view offers to open it', async ({ page }) => {
  await signIn(page);
  await backToTask(page);
  await page.evaluate(() => (window as any).__machineLinkRequest('session-2', null, 'Spread the review'));
  const toast = page.locator('#toast');
  await expect(toast).toContainText('“Refine the navigation” is asking to link a machine.');
  await expect(page.getByRole('region', { name: 'Link a machine' })).toHaveCount(0);
  await toast.getByRole('button', { name: 'Open task' }).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await expect(page.getByRole('region', { name: 'Link a machine' })).toContainText('Spread the review');
});

test('machine orchestration: the link dialog has two steps, explains disabled machines and links with the chosen access', async ({ page }) => {
  await signIn(page);
  const sessionId = await backToTask(page);
  await page.evaluate(id => (window as any).__machineLinkRequest(id, 'Studio iMac', 'Spread the review across machines'), sessionId);
  await page.getByRole('region', { name: 'Link a machine' }).getByRole('button', { name: 'Link…' }).click();

  const dialog = page.getByRole('dialog', { name: 'Link a machine' });
  await expect(dialog.locator('.machine-steps [aria-current="step"]')).toContainText('Machine');
  await expect(dialog.getByRole('radio', { name: /Studio iMac/ })).toBeChecked();
  await expect(dialog.getByRole('radio', { name: /Home NAS/ })).toBeEnabled();
  await expect(dialog.getByRole('radio', { name: /ProMini/ })).toBeDisabled();
  await expect(dialog.locator('.machine-row', { hasText: 'ProMini' })).toContainText('Remote control off');
  await expect(dialog.locator('.machine-row', { hasText: 'Old laptop' })).toContainText('Offline');
  await expect(dialog.getByRole('radio', { name: /This Mac/ })).toHaveCount(0);

  // Keyboard: Enter on the chosen machine continues.
  await dialog.getByRole('radio', { name: /Studio iMac/ }).focus();
  await page.keyboard.press('Enter');
  await expect(dialog.locator('.machine-steps [aria-current="step"]')).toContainText('Access');
  await expect(dialog.locator('.machine-steps')).toContainText('Machine: Studio iMac');
  const access = dialog.getByLabel('What agents here may do there');
  await expect(access).toBeFocused();
  await expect(access).toHaveValue('ask');
  await access.selectOption('full');
  await expect(dialog.locator('.machine-access-help')).toContainText('Full access when the task that launched it');
  await dialog.getByRole('button', { name: 'Back' }).click();
  await expect(dialog.getByRole('radio', { name: /Studio iMac/ })).toBeChecked();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await access.selectOption('full');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Link a machine' })).toHaveCount(0);
  const responses = await page.evaluate(() => (window as any).__machineLinkResponses);
  expect(responses).toEqual([expect.objectContaining({ deviceId: 'dev-studio', access: 'full' })]);
});

test('machine orchestration: no thread lookups while orchestration is off', async ({ page }) => {
  await page.goto('/');
  await openTask(page, 'Make search feel instant');
  await openTask(page, 'Refine the navigation');
  await page.waitForFunction(() => typeof (window as any).__orchestrationEnable === 'function');
  expect(await page.evaluate(() => (window as any).__orchestrationChildrenCalls ?? 0)).toBe(0);
  await page.evaluate(() => (window as any).__orchestrationEnable(true));
  await expect.poll(() => page.evaluate(() => (window as any).__orchestrationChildrenCalls ?? 0)).toBeGreaterThan(0);
});

test('machine orchestration: no status call on presence while orchestration is off', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.waitForFunction(() => typeof (window as any).__orchestrationEnable === 'function' && typeof (window as any).__remoteOnline === 'function');
  // The preview installs fresh test hooks on every orchestration_status call.
  const presence = () => page.evaluate(() => { const w = window as any; w.__hooksBefore = w.__orchestrationEnable; w.__remoteOnline('dev-mini', false); w.__remoteOnline('dev-mini', true); });
  const statusCalled = () => page.evaluate(() => (window as any).__orchestrationEnable !== (window as any).__hooksBefore);
  await presence();
  await page.waitForTimeout(300);
  expect(await statusCalled()).toBe(false);
  await page.evaluate(() => (window as any).__orchestrationEnable(true));
  await presence();
  await expect.poll(statusCalled).toBe(true);
});

test('machine orchestration: the lineage strip shows native statuses, opens and stops threads, and waits on running ones', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  const first = await addChild(page, parent, { title: 'Explore orchestration', provider: 'claude', machine: mini });
  const second = await addChild(page, parent, { title: 'Explore web desktop', provider: 'codex', machine: mini });
  const failed = await addChild(page, parent, { title: 'Grok provider check', provider: 'opencode', status: 'error', machine: mini });

  const strip = page.getByRole('region', { name: 'Threads on other machines' });
  const summary = strip.getByRole('button', { name: /3 threads on ProMini/ });
  await expect(summary).toContainText('2 running');
  await expect(strip.locator('.lineage-faces')).toHaveText('CLCXOC');
  const wait = page.locator('.lineage-wait');
  await expect(wait).toContainText('Waiting on 2 threads');
  await expect(wait).toContainText('Explore orchestration, Explore web desktop');

  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(strip.locator(`[data-thread="${failed}"]`)).toContainText('on ProMini · Failed');
  const row = strip.locator(`[data-thread="${first}"]`);
  await expect(row).toContainText('on ProMini · Running');
  await strip.getByRole('button', { name: 'Stop Explore orchestration' }).click();
  await expect(row).toContainText('on ProMini · Stopped');
  await expect(summary).toContainText('1 running');
  await expect(wait).toContainText('Waiting on 1 thread');

  // Waiting for the user is not running: it is counted apart and not waited on.
  await page.evaluate(id => (window as any).__machineChildStatus(id, 'waiting'), second);
  await expect(strip.locator(`[data-thread="${second}"]`)).toContainText('Needs you');
  await expect(summary).toContainText('0 running · 1 needs you');
  await expect(wait).toHaveCount(0);
  await strip.getByRole('button', { name: 'Stop Explore web desktop' }).click();
  await expect(strip.locator(`[data-thread="${second}"]`)).toContainText('Stopped');

  await strip.getByRole('button', { name: 'Explore web desktop' }).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', second);
});

test('machine orchestration: Stop all stops every running thread', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Lint', machine: mini });
  await addChild(page, parent, { title: 'Typecheck', machine: mini });
  const wait = page.locator('.lineage-wait');
  await expect(wait).toContainText('Waiting on 2 threads');
  await wait.getByRole('button', { name: 'Stop all' }).click();
  await expect(wait).toHaveCount(0);
  await expect(page.getByRole('button', { name: /2 threads on ProMini/ })).toContainText('0 running');
});

test('machine orchestration: each task remembers whether its lineage strip is open', async ({ page }) => {
  await withOrchestration(page);
  const a = await openTask(page, 'Make search feel instant');
  await addChild(page, a, { title: 'Thread of A', machine: mini });
  const b = await openTask(page, 'Refine the navigation');
  await addChild(page, b, { title: 'Thread of B', machine: mini });
  const summary = page.locator('.lineage-summary');
  await expect(summary).toContainText('1 thread on ProMini');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');

  await openTask(page, 'Make search feel instant');
  await summary.click();
  await expect(page.locator('.lineage-row')).toContainText('Thread of A');
  await openTask(page, 'Refine the navigation');
  await expect(summary).toHaveAttribute('aria-expanded', 'false');
  await expect(page.locator('.lineage-row')).toHaveCount(0);
  await openTask(page, 'Make search feel instant');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
});

test('machine orchestration: launches group into one threads card in the transcript', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Explore orchestration and persistence', provider: 'claude', machine: mini, launch: true });
  const second = await addChild(page, parent, { title: 'Explore web desktop and mobile', provider: 'codex', machine: mini, launch: true });
  // Reload the saved transcript with the new launch calls.
  await openTask(page, 'Refine the navigation');
  await openTask(page, 'Make search feel instant');

  const card = page.locator('#transcript .machine-threads');
  await expect(card).toHaveCount(1);
  const summary = card.locator('.machine-threads-summary');
  await expect(summary).toContainText('2 threads');
  await expect(summary).toContainText('2 working');
  await expect(card.locator('.lineage-faces')).toHaveText('CLCX');
  await expect(card.locator('.machine-threads-time')).toHaveText(/^\d+[smh]$/);
  await summary.click();
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(card.locator('.lineage-row')).toHaveCount(2);
  await expect(card.locator(`[data-thread="${second}"]`)).toContainText('on ProMini · Running');

  await page.evaluate(id => (window as any).__machineChildStatus(id, 'idle'), second);
  await expect(summary).toContainText('1 working');
  await expect(card.locator(`[data-thread="${second}"]`)).toContainText('Done');
  await card.getByRole('button', { name: 'Explore web desktop and mobile' }).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', second);
});

// Another project's task stays in view however many threads the first project lists.
async function reloadTranscript(page: Page, title = 'Make search feel instant') {
  await openTask(page, 'Explore the project');
  await openTask(page, title);
}

test('machine orchestration: a wake turn reads as machine threads finishing, not team coordination', async ({ page }) => {
  await withOrchestration(page);
  await openTask(page, 'Make search feel instant');
  await page.evaluate(() => (window as any).__machineWake('session-1'));
  await reloadTranscript(page);
  const note = page.getByRole('note', { name: 'Machines status: Machine threads finished' });
  await expect(note).toContainText('Machines');
  await expect(note).toContainText('Machine threads finished');
  await expect(page.locator('#transcript .coordination-status', { hasText: 'Coordinating team' })).toHaveCount(0);
});

test('machine orchestration: tool rows name a pending link and a starting thread', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await page.evaluate(() => (window as any).__machineToolMessage('session-1', 'pandacode_machine_link', { reason: 'Run elsewhere' }, { linked: false, pending: true, requestId: 'request-1' }));
  await addChild(page, parent, { title: 'Explore', machine: mini, launch: true });
  await reloadTranscript(page);
  await expect(page.locator('[data-tool-name="pandacode_machine_link"] > summary')).toHaveText(/Waiting for you\s*PandaCode\s*to link a machine/);
  await expect(page.locator('[data-tool-name="pandacode_machine_launch"] > summary')).toHaveText(/Starting\s*PandaCode\s*a thread on ProMini/);
});

test('machine orchestration: an older launch card stays after the lineage cap drops its thread', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  const first = await addChild(page, parent, { title: 'The first thread', status: 'idle', machine: mini, launch: true });
  await page.evaluate(([id, machine]) => { for (let index = 0; index < 30; index++) (window as any).__machineChild(id, { title: `Settled ${index}`, status: 'idle', machine }); }, [parent, mini] as const);
  await reloadTranscript(page);
  await expect(page.locator('.lineage-summary')).toContainText('24 threads on ProMini');
  const card = page.locator('#transcript .machine-threads');
  await expect(card).toHaveCount(1);
  await expect(card.locator('.machine-threads-summary')).toContainText('1 thread');
  await expect(card.locator('.machine-threads-summary')).toContainText('all settled');
  expect(await page.evaluate(() => (window as any).__orchestrationThreadsCalls)).toEqual([[first]]);
  // Fetched once: another redraw reuses it.
  await reloadTranscript(page);
  await expect(card).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__orchestrationThreadsCalls)).toHaveLength(1);
});

test('machine orchestration: a focused threads card keeps focus while it refreshes and its time ticks', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Alpha', machine: mini, launch: true });
  const beta = await addChild(page, parent, { title: 'Beta', machine: mini, launch: true });
  await reloadTranscript(page);
  const summary = page.locator('#transcript .machine-threads-summary');
  await expect(summary).toContainText('2 working');
  await summary.focus();
  const time = page.locator('#transcript .machine-threads-time');
  const before = await time.textContent();
  await expect.poll(() => time.textContent(), { timeout: 4000 }).not.toBe(before);
  await page.evaluate(id => (window as any).__machineChildStatus(id, 'idle'), beta);
  await expect(summary).toContainText('1 working');
  await expect(summary).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(summary).toHaveAttribute('aria-expanded', 'true');
  await expect(summary).toBeFocused();
});
