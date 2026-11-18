import { expect, test, type Page } from '@playwright/test';

/* Multi-machine orchestration on the preview's sample account (src/preview-remote.ts): the
 * Settings switch and linked computers, an agent's link request, the Lineage panel in the Agents
 * flyout, the waiting line and the transcript's threads card. Titles start with "machine orchestration" for the WebKit grep. */
async function signIn(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click(); await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  return panel;
}
const task = (page: Page, title: string) => page.locator('#navigation .task-item', { hasText: title });
async function openTask(page: Page, title: string) {
  // Many launched threads fold a project's older tasks behind "Show N more".
  const more = page.locator('#navigation').getByRole('button', { name: /^Show \d+ more/ });
  await expect(async () => {
    if (!await task(page, title).count() && await more.count()) await more.first().click();
    await task(page, title).first().click({ timeout: 1000 });
  }).toPass();
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

test('machine orchestration: a computer that left the account can only be unlinked, and is never offered', async ({ page }) => {
  const panel = await signIn(page);
  await panel.getByRole('checkbox', { name: 'Agent orchestration' }).check();
  await panel.getByRole('button', { name: 'Link a computer…' }).click();
  const dialog = page.getByRole('dialog', { name: 'Link a machine' });
  await dialog.getByRole('radio', { name: /Studio iMac/ }).check();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog).toHaveCount(0);

  await page.evaluate(() => (window as any).__remoteRevoke('dev-studio'));
  const row = panel.locator('[data-link="dev-studio"]');
  await expect(row).toContainText('Studio iMac · Left the account');
  await expect(row.getByRole('combobox')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Link a computer…' }).click();
  await expect(dialog.getByRole('radio', { name: /Home NAS/ })).toBeVisible();
  await expect(dialog.getByRole('radio', { name: /Studio iMac/ })).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Cancel' }).click();

  await panel.getByRole('button', { name: 'Unlink Studio iMac' }).click();
  await expect(row).toHaveCount(0);
  await expect(panel.getByText('No linked computers.')).toBeVisible();
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

const agents = (page: Page) => page.locator('#agents-toggle');
const lineage = (page: Page) => page.getByRole('region', { name: 'Lineage', exact: true });
async function openLineage(page: Page) {
  await agents(page).click();
  await expect(lineage(page)).toBeVisible();
  return lineage(page);
}

test('machine orchestration: the Lineage panel shows native statuses, opens and stops threads', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await expect(agents(page)).toBeHidden();
  const first = await addChild(page, parent, { title: 'Explore orchestration', provider: 'claude', machine: mini });
  const second = await addChild(page, parent, { title: 'Explore web desktop', provider: 'codex', machine: mini });
  const failed = await addChild(page, parent, { title: 'Grok provider check', provider: 'opencode', status: 'error', machine: mini });

  // The dock's Agents item stands for them: shown, and counting only the running ones.
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
  await expect(agents(page).locator('.dock-badge')).toHaveText('2');
  const panel = await openLineage(page);
  await expect(panel.locator('.lineage-count')).toHaveText('Lineage · 2 running');
  await expect(panel.locator(`[data-thread="${first}"] .lineage-face`)).toHaveText('CL');
  await expect(panel.locator(`[data-thread="${failed}"]`)).toContainText('on ProMini · Failed');
  const row = panel.locator(`[data-thread="${first}"]`);
  await expect(row).toContainText('on ProMini · Running');
  await panel.getByRole('button', { name: 'Stop Explore orchestration' }).click();
  await expect(row).toContainText('on ProMini · Stopped');
  await expect(panel.locator('.lineage-count')).toHaveText('Lineage · 1 running');
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  // A stopped row's Stop leaves, with focus kept on the row.
  await expect(panel.getByRole('button', { name: 'Stop Explore orchestration' })).toHaveCount(0);
  await expect(row.locator('.lineage-open')).toBeFocused();

  // Waiting for the user is not running: it is counted apart.
  await page.evaluate(id => (window as any).__machineChildStatus(id, 'waiting'), second);
  await expect(panel.locator(`[data-thread="${second}"]`)).toContainText('Needs you');
  await expect(panel.locator('.lineage-count')).toHaveText('Lineage · 0 running · 1 needs you');
  await expect(agents(page).locator('.dock-badge')).toBeHidden();
  await panel.getByRole('button', { name: 'Stop Explore web desktop' }).click();
  await expect(panel.locator(`[data-thread="${second}"]`)).toContainText('Stopped');
  await expect(panel.getByRole('button', { name: 'Stop all' })).toBeHidden();

  await panel.getByRole('button', { name: 'Explore web desktop' }).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', second);
  await expect(page.locator('#agents-flyout')).toBeHidden();
});

test('machine orchestration: hovering the Agents item opens Lineage beside the other panels', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Lint', machine: mini });
  await page.evaluate(id => (window as any).__previewSubagent(id, { id: 'a', name: 'Agent a', status: 'running' }), parent);
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
  await agents(page).hover();
  await expect(lineage(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Subagents', exact: true })).toBeVisible();
  await expect(lineage(page).locator(':focus')).toHaveCount(0);
  await page.mouse.move(300, 600);
  await expect(page.locator('#agents-flyout')).toBeHidden();
  await expect(lineage(page)).toHaveCount(0);
  // A thread arriving while the flyout is open joins it; no second list above the composer.
  await page.evaluate(id => (window as any).__previewSubagent(id, { id: 'a', name: 'Agent a', status: 'completed' }), parent);
  await agents(page).click();
  await expect(lineage(page).locator('.lineage-row')).toHaveCount(1);
  await addChild(page, parent, { title: 'Typecheck', machine: mini });
  await expect(lineage(page).locator('.lineage-row')).toHaveCount(2);
  await expect(page.locator('#machine-orchestration .lineage-row')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.locator('#agents-flyout')).toBeHidden();
  await expect(agents(page)).toBeFocused();
});

test('machine orchestration: a pinned flyout follows a task switch in one draw', async ({ page }) => {
  await withOrchestration(page);
  const a = await openTask(page, 'Make search feel instant');
  await addChild(page, a, { title: 'Thread of A', machine: mini });
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  const b = await openTask(page, 'Refine the navigation');
  await addChild(page, b, { title: 'First of B', machine: mini });
  await addChild(page, b, { title: 'Second of B', machine: mini });
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
  await openTask(page, 'Make search feel instant');
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  const panel = await openLineage(page);
  await expect(panel.locator('.lineage-row')).toHaveText([/Thread of A/]);

  // The count changing ends the render that switches tasks: the panel must already be back by then,
  // whether or not anything else happens to render again.
  await page.evaluate(() => {
    const w = window as any;
    w.__panelAtAgents = [];
    addEventListener('pandacode:agents', () => w.__panelAtAgents.push(Boolean(document.querySelector('.lineage-panel'))));
  });
  await task(page, 'Refine the navigation').first().click();
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
  await expect(panel.locator('.lineage-row')).toHaveText([/First of B/, /Second of B/]);
  await page.mouse.move(300, 600);
  await page.waitForTimeout(500);
  await expect(page.locator('#agents-flyout')).toBeVisible();
  const seen = await page.evaluate(() => (window as any).__panelAtAgents as boolean[]);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(false);
});

test('machine orchestration: a pinned Lineage panel comes back on a task whose threads were not loaded yet', async ({ page }) => {
  await withOrchestration(page);
  const b = await openTask(page, 'Refine the navigation');
  const a = await openTask(page, 'Make search feel instant');
  await addChild(page, a, { title: 'Thread of A', machine: mini });
  await addChild(page, b, { title: 'Thread of B', machine: mini });
  const panel = await openLineage(page);
  await expect(panel.locator('.lineage-row')).toHaveText([/Thread of A/]);
  await page.evaluate(() => { (window as any).__orchestrationChildrenDelay = 150; });
  await task(page, 'Refine the navigation').first().click();
  await expect(panel.locator('.lineage-row')).toHaveText([/Thread of B/]);
  await page.mouse.move(300, 600);
  await page.waitForTimeout(500);
  await expect(page.locator('#agents-flyout')).toBeVisible();
});

test('machine orchestration: a pinned flyout showing only subagents gains Lineage on a task with unchanged threads', async ({ page }) => {
  await withOrchestration(page);
  const b = await openTask(page, 'Refine the navigation');
  await addChild(page, b, { title: 'Thread of B', machine: mini });
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  const a = await openTask(page, 'Make search feel instant');
  for (const key of ['a', 'b']) await page.evaluate(([id, name]) => (window as any).__previewSubagent(id, { id: name, name, status: 'running' }), [a, key]);
  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 2 running');
  await agents(page).click();
  await expect(page.getByRole('region', { name: 'Subagents', exact: true })).toBeVisible();
  await expect(lineage(page)).toHaveCount(0);

  // The render that switches tasks ends by announcing B's thread (only this module's own event
  // counts; the subagents view announces too). B's threads come back unchanged, so no refresh draws
  // again: the panel must be there by then.
  await page.evaluate(() => {
    const w = window as any;
    w.__panelAtAgents = [];
    addEventListener('pandacode:agents', () => { if (new Error().stack?.includes('machine-orchestration')) w.__panelAtAgents.push(Boolean(document.querySelector('.lineage-panel'))); });
  });
  await page.mouse.move(300, 600);
  await task(page, 'Refine the navigation').first().click();
  await expect(lineage(page).locator('.lineage-row')).toHaveText([/Thread of B/]);
  await page.waitForTimeout(500);
  await expect(page.locator('#agents-flyout')).toBeVisible();
  const seen = await page.evaluate(() => (window as any).__panelAtAgents as boolean[]);
  expect(seen.length).toBeGreaterThan(0);
  expect(seen).not.toContain(false);
});

test('machine orchestration: the waiting line is one line while the parent is idle, and Stop ends what it waits on', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Lint', machine: mini });
  const asks = await addChild(page, parent, { title: 'Asks you', status: 'waiting', machine: mini });
  await addChild(page, parent, { title: 'Typecheck', machine: mini });
  const extra = await addChild(page, parent, { title: 'Extra', machine: mini });
  const wait = page.locator('.lineage-wait');
  await expect(wait).toContainText('Waiting on 3 threads');
  await expect(wait.locator('.lineage-titles')).toHaveText('Lint, Typecheck, Extra');
  await expect(page.locator('#machine-orchestration')).not.toContainText('Asks you');
  const height = await wait.evaluate(node => node.getBoundingClientRect().height);
  expect(height).toBeLessThanOrEqual(30);
  // The spinner survives an update, so its turn never restarts.
  await wait.locator('.lineage-spinner').evaluate(node => { (node as any).__kept = true; });
  await page.evaluate(id => (window as any).__machineChildStatus(id, 'idle'), extra);
  await expect(wait).toContainText('Waiting on 2 threads');
  await expect(wait.locator('.lineage-titles')).toHaveText('Lint, Typecheck');
  expect(await wait.locator('.lineage-spinner').evaluate(node => (node as any).__kept)).toBe(true);
  await wait.getByRole('button', { name: 'Stop all waiting threads' }).click();
  await expect(wait).toHaveCount(0);
  // A thread that needs you is not stopped by it.
  const panel = await openLineage(page);
  await expect(panel.locator('.lineage-count')).toHaveText('Lineage · 0 running · 1 needs you');
  await expect(panel.locator(`[data-thread="${asks}"]`)).toContainText('Needs you');
  await panel.getByRole('button', { name: 'Stop all', exact: true }).click();
  await expect(panel.locator(`[data-thread="${asks}"]`)).toContainText('Stopped');
});

test('machine orchestration: a thread whose computer is offline reads Offline and is not working', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  const gone = await addChild(page, parent, { title: 'Slow suite', machine: mini, launch: true });
  await addChild(page, parent, { title: 'Lint', machine: mini, launch: true });
  await reloadTranscript(page);
  const summary = page.locator('#transcript .machine-threads-summary');
  await expect(summary).toContainText('2 working');
  await page.evaluate(id => (window as any).__machineChildOffline(id, true), gone);

  await expect(agents(page)).toHaveAttribute('aria-label', 'Agents: 1 running');
  await expect(summary).toContainText('1 working · 1 offline');
  const wait = page.locator('.lineage-wait');
  await expect(wait).toContainText('Waiting on 1 thread');
  await expect(wait.locator('.lineage-titles')).toHaveText('Lint, Slow suite on ProMini · Offline');
  const panel = await openLineage(page);
  await expect(panel.locator(`[data-thread="${gone}"]`)).toContainText('on ProMini · Offline');
  await expect(panel.locator('.lineage-count')).toHaveText('Lineage · 1 running · 1 offline');
  await page.keyboard.press('Escape');
  await summary.click();
  await expect(page.locator(`#transcript [data-thread="${gone}"]`)).toContainText('on ProMini · Offline');

  // Alone, it still holds the line (the parent is not woken yet) but counts as nobody working.
  const lint = await page.locator('#transcript .lineage-row', { hasText: 'Lint' }).getAttribute('data-thread');
  await page.evaluate(id => (window as any).__machineChildStatus(id, 'idle'), lint);
  await expect(wait).toContainText('Waiting on 1 offline thread');
  await expect(agents(page).locator('.dock-badge')).toBeHidden();
  await page.evaluate(id => (window as any).__machineChildOffline(id, false), gone);
  await expect(wait).toContainText('Waiting on 1 thread');
  await expect(page.locator(`#transcript [data-thread="${gone}"]`)).toContainText('on ProMini · Running');
});

test('machine orchestration: one thread changing status touches only its own row', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  const ids = await page.evaluate(([id, machine]) => Array.from({ length: 40 }, (_, index) => (window as any).__machineChild(id, { title: `Thread ${index}`, machine, launch: true }) as string), [parent, mini] as const);
  await reloadTranscript(page);
  await page.locator('#transcript .machine-threads-summary').click();
  const panel = await openLineage(page);
  await expect(panel.locator('.lineage-row')).toHaveCount(40);
  await expect(page.locator('#transcript .lineage-row')).toHaveCount(40);
  await page.waitForTimeout(300);

  const target = ids[17];
  const seen = await page.evaluate(async id => {
    const records: MutationRecord[] = [];
    const observer = new MutationObserver(list => records.push(...list));
    observer.observe(document.documentElement, { subtree: true, childList: true, attributes: true, characterData: true });
    const kept = [...document.querySelectorAll('[data-thread]')];
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!;
    prompt.value = 'hello'; prompt.focus(); prompt.setSelectionRange(2, 2);
    (window as any).__machineChildStatus(id, 'idle');
    await new Promise<void>(resolve => { const check = () => [...document.querySelectorAll(`[data-thread="${id}"]`)].every(row => row.textContent!.includes('Done')) ? resolve() : requestAnimationFrame(check); check(); });
    await new Promise(resolve => setTimeout(resolve, 200));
    observer.disconnect();
    const count = (selector: string) => {
      const nodes = new Set<Node>();
      for (const record of records) {
        const owner = record.target instanceof Element ? record.target : record.target.parentElement;
        if (!owner?.closest(selector)) continue;
        nodes.add(record.target);
        for (const node of [...record.addedNodes, ...record.removedNodes]) { nodes.add(node); if (node instanceof Element) node.querySelectorAll('*').forEach(child => nodes.add(child)); }
      }
      return nodes.size;
    };
    const others = records.flatMap(record => { const owner = record.target instanceof Element ? record.target : record.target.parentElement; const row = owner?.closest<HTMLElement>('[data-thread]'); return row && row.dataset.thread !== id ? [row.dataset.thread] : []; });
    return { others, sidebar: count('#workspace-sidebar'), composer: count('#composer-area'), dock: count('#action-dock'), promptKept: prompt.isConnected && document.activeElement === prompt && prompt.selectionStart === 2, flyout: count('#agents-flyout'), card: count('.machine-threads'), transcript: count('#transcript'), slot: count('#machine-orchestration'), kept: kept.every(row => row.isConnected) };
  }, target);
  // Row: its state attribute and where text. Heading: the count. Stop: hidden on the row.
  expect(seen.others).toEqual([]);
  expect(seen.kept).toBe(true);
  expect(seen.flyout).toBeLessThanOrEqual(10);
  // Nothing around it redraws: the sidebar row, the context bar stays, the prompt keeps its caret.
  // (Margins cover a ticking elapsed time; these were 172, 45 and 14 with no-op writes.)
  expect(seen.sidebar).toBeLessThanOrEqual(24);
  expect(seen.composer).toBeLessThanOrEqual(12);
  expect(seen.dock).toBeLessThanOrEqual(8);
  expect(seen.promptKept).toBe(true);
  // Row, summary count and the card's 1 s time tick; the transcript is not redrawn around the card.
  expect(seen.card).toBeLessThanOrEqual(12);
  // The card plus main.ts's own transcript attribute writes; a redraw would be hundreds.
  expect(seen.transcript).toBeLessThanOrEqual(seen.card + 4);
  // Waiting line: count and titles only.
  expect(seen.slot).toBeLessThanOrEqual(8);
  await expect(panel.locator(`[data-thread="${target}"]`)).toContainText('on ProMini · Done');
});

test('machine orchestration: rows arrive without motion under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  await addChild(page, parent, { title: 'Lint', machine: mini });
  await openLineage(page);
  await addChild(page, parent, { title: 'Typecheck', machine: mini });
  await expect(lineage(page).locator('.lineage-row')).toHaveCount(2);
  const animating = await page.evaluate(() => [...document.querySelectorAll('.lineage-row, .lineage-wait, .lineage-spinner')].flatMap(node => node.getAnimations()).length);
  expect(animating).toBe(0);
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
  // The wake's label is a row in the exchange's one card, so it shows with the trace open.
  await page.locator('#transcript .turn-card > details.turn-activity:has(.coordination-status) > summary').click();
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

test('machine orchestration: an automatic launch names the machine the tool answered with', async ({ page }) => {
  await withOrchestration(page);
  await openTask(page, 'Make search feel instant');
  await page.evaluate(() => {
    const add = (window as any).__machineToolMessage;
    add('session-1', 'pandacode_machine_launch', { machine: 'auto', prompt: 'Lint', provider: 'claude', model: 'default' }, { thread: 'thread-auto', machine: { id: 'dev-mini', name: 'ProMini' }, mode: 'ask', status: 'running' });
    add('session-1', 'pandacode_machine_launch', { machine: 'auto', prompt: 'Lint', provider: 'claude', model: 'default' }, 'No linked machine can take this.');
    add('session-1', 'pandacode_machine_list', {}, { machines: [{ id: 'dev-mini', name: 'ProMini', platform: 'macOS', online: true, hosting: true, access: 'full', runningThreads: 2, harnesses: ['claude'] }] });
  });
  await reloadTranscript(page);
  const launches = page.locator('[data-tool-name="pandacode_machine_launch"] > summary');
  await expect(launches.first()).toHaveText(/Launched\s*PandaCode\s*a thread on ProMini/);
  await expect(launches.last()).toHaveText(/a thread on another machine/);
  await expect(page.locator('[data-tool-name="pandacode_machine_list"] > summary')).toHaveText(/Listed\s*PandaCode\s*machines · 2 running threads/);
});

test('machine orchestration: an older launch card stays after the lineage cap drops its thread', async ({ page }) => {
  await withOrchestration(page);
  const parent = await openTask(page, 'Make search feel instant');
  const first = await addChild(page, parent, { title: 'The first thread', status: 'idle', machine: mini, launch: true });
  await page.evaluate(([id, machine]) => { for (let index = 0; index < 30; index++) (window as any).__machineChild(id, { title: `Settled ${index}`, status: 'idle', machine }); }, [parent, mini] as const);
  await reloadTranscript(page);
  await expect(agents(page)).toBeVisible();
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
