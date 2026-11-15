import { expect, test, type Page } from '@playwright/test';

// Desktop notifications: the Settings section's rows and persistence, then the gating in
// src/notifications.ts as the preview's agent events reach it (banner arguments recorded by
// the notifications_show mock in src/preview.ts).
const dialog = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name, exact: true });
const panel = (page: Page, name: string) => dialog(page).getByRole('tabpanel', { name, exact: true });

const shown = (page: Page) => page.evaluate(() => ((window as any).__notificationsShow ?? []) as any[]);

async function open(page: Page, settings?: Record<string, string>): Promise<void> {
  await page.addInitScript(stored => {
    for (const [key, value] of Object.entries(stored ?? {})) localStorage.setItem(key, value);
  }, settings);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}

async function settings(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
}

const approval = (page: Page, requestId: string) => page.evaluate(([id]) => {
  (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'approval', requestId: id, text: 'Run the tests?' });
}, [requestId]);

test('notification settings show their switches and the sound picker, and save their choices', async ({ page }) => {
  await open(page);
  await settings(page);
  await tab(page, 'Notifications').click();
  const content = panel(page, 'Notifications');
  await expect(content.getByRole('switch', { name: 'Notify when PandaCode is not focused' })).toBeChecked();
  await expect(content.getByRole('switch', { name: 'Approval requested' })).toBeChecked();
  await expect(content.getByRole('switch', { name: 'Input requested' })).toBeChecked();
  await expect(content.getByRole('switch', { name: 'Task finished' })).not.toBeChecked();
  await expect(content.getByRole('switch', { name: 'Task failed' })).not.toBeChecked();
  await expect(content.getByRole('switch', { name: 'Play sound when PandaCode is focused' })).not.toBeChecked();
  await expect(content.getByRole('switch', { name: 'Hide task details' })).not.toBeChecked();
  const sound = content.getByRole('combobox', { name: 'Sound', exact: true });
  await expect(sound).toHaveValue('Glass');
  await sound.selectOption('Frog');
  await content.getByRole('switch', { name: 'Task failed' }).check();
  await content.getByRole('switch', { name: 'Notify when PandaCode is not focused' }).uncheck();
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pandacode.notifications.sound'))).toBe('Frog');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pandacode.notifications.failed'))).toBe('true');
  await expect.poll(() => page.evaluate(() => localStorage.getItem('pandacode.notifications.enabled'))).toBe('false');
});

test('notification choices return the next time the page opens', async ({ page }) => {
  await open(page, { 'pandacode.notifications.sound': 'Purr', 'pandacode.notifications.finished': 'true' });
  await settings(page);
  await tab(page, 'Notifications').click();
  const content = panel(page, 'Notifications');
  await expect(content.getByRole('combobox', { name: 'Sound', exact: true })).toHaveValue('Purr');
  await expect(content.getByRole('switch', { name: 'Task finished' })).toBeChecked();
});

test('an approval while another app is in front sends one notification naming the task', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await approval(page, 'r-1');
  await expect.poll(() => shown(page).then(calls => calls.length), { timeout: 10_000 }).toBe(1);
  const call = (await shown(page))[0];
  expect(call.suppressBanner).toBe(false);
  expect(call.sessionId).toBe('session-1');
  expect(call.sound).toBe('Glass');
  expect(String(call.title)).toContain('needs approval');
});

test('three rapid approvals coalesce into one notification with the count', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await approval(page, 'r-1');
  await approval(page, 'r-2');
  await approval(page, 'r-3');
  await expect.poll(() => shown(page).then(calls => calls.length), { timeout: 10_000 }).toBe(1);
  const call = (await shown(page))[0];
  expect(String(call.body)).toContain('3 approvals waiting');
  expect(call.sessionId).toBe('session-1');
});

test('focused, no notification while the focused sound is off', async ({ page }) => {
  await open(page);
  await approval(page, 'r-1');
  await page.waitForTimeout(6_000);
  expect(await shown(page)).toEqual([]);
});

test('focused with the sound switch on, a suppressed notification arrives with its sound', async ({ page }) => {
  await open(page, { 'pandacode.notifications.soundWhenFocused': 'true', 'pandacode.notifications.sound': 'Tink' });
  await approval(page, 'r-1');
  await expect.poll(async () => (await shown(page)).length).toBe(1);
  const call = (await shown(page))[0];
  expect(call.suppressBanner).toBe(true);
  expect(call.sound).toBe('Tink');
  expect(String(call.title)).toContain('needs approval');
});

test("a finished task's notification names its task in the click payload too", async ({ page }) => {
  await open(page, { 'pandacode.notifications.finished': 'true' });
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' }));
  await expect.poll(async () => (await shown(page)).length).toBe(1);
  const call = (await shown(page))[0];
  expect(call.suppressBanner).toBe(false);
  expect(call.sessionId).toBe('session-1');
  expect(String(call.title)).toContain('finished');
});

test('finished and failed payloads never permit sound while another PandaCode window is focused', async ({ page }) => {
  await open(page, { 'pandacode.notifications.finished': 'true', 'pandacode.notifications.failed': 'true', 'pandacode.notifications.soundWhenFocused': 'true' });
  await page.evaluate(() => {
    document.hasFocus = () => false;
    (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '', data: { outcome: 'successful' } });
    (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '', data: { outcome: 'failed' } });
  });
  await expect.poll(async () => (await shown(page)).length).toBe(2);
  expect((await shown(page)).map(call => call.soundWhenFocused)).toEqual([false, false]);
});

test('a usage limit stays silent despite a failed run outcome', async ({ page }) => {
  await open(page, { 'pandacode.notifications.finished': 'true', 'pandacode.notifications.failed': 'true' });
  await page.evaluate(() => {
    document.hasFocus = () => false;
    (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'limited', text: 'Usage limit' });
    (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '', data: { outcome: 'failed' } });
  });
  expect(await shown(page)).toEqual([]);
});

test('a team lead waits for an explicit settled result and a pause discards its held notice', async ({ page }) => {
  await open(page, { 'pandacode.notifications.finished': 'true', 'pandacode.notifications.failed': 'true' });
  await page.evaluate(() => { document.hasFocus = () => false; });
  const publish = (status: string, revision: number) => page.evaluate(({ status, revision }) => {
    (window as any).__previewEmit('architect-event', { sessionId: 'session-1', config: { workers: [], maxParallel: 1, maxRounds: 1, maxAssignments: 1, workspace: 'shared', summaryLimit: 0 }, status, round: 1, revision, workers: [], error: null, updatedAt: Date.now() });
  }, { status, revision });
  const done = () => page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '', data: { outcome: 'successful' } }));
  await publish('running', 100);
  await done();
  expect(await shown(page)).toEqual([]);
  await publish('paused', 101);
  await publish('completed', 102);
  expect(await shown(page)).toEqual([]);
  await publish('running', 103);
  await done();
  expect(await shown(page)).toEqual([]);
  await publish('ready', 104);
  await publish('ready', 105);
  await expect.poll(async () => (await shown(page)).length).toBe(1);
  expect(String((await shown(page))[0].title)).toContain('finished');
});

test('a Council ask discards a held completion rather than notifying it later', async ({ page }) => {
  await open(page, { 'pandacode.notifications.finished': 'true', 'pandacode.notifications.input': 'false' });
  await page.evaluate(() => { document.hasFocus = () => false; });
  await page.evaluate(() => (window as any).__previewEmit('architect-event', {
    sessionId: 'session-1', config: { workers: [], maxParallel: 1, maxRounds: 1, maxAssignments: 1, workspace: 'shared', summaryLimit: 0 },
    status: 'running', round: 1, revision: 100, workers: [], error: null, updatedAt: Date.now(),
  }));
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '', data: { outcome: 'successful' } }));
  await council(page, true, 101);
  await council(page, false, 102);
  expect(await shown(page)).toEqual([]);
});

test('worker cancellation and run end withdraw queued approvals before the batch flushes', async ({ page }) => {
  await open(page);
  await page.evaluate(() => {
    document.hasFocus = () => false;
    const emit = (event: object) => (window as any).__previewEmit('agent-event', event);
    emit({ sessionId: 'worker-cancel', kind: 'approval', requestId: 'r-1', text: 'Approve?' });
    emit({ sessionId: 'worker-cancel', kind: 'approval_cancelled', requestId: 'r-1', text: '' });
    emit({ sessionId: 'worker-done', kind: 'approval', requestId: 'r-2', text: 'Approve?' });
    emit({ sessionId: 'worker-done', kind: 'done', text: '' });
  });
  await page.waitForTimeout(6_500);
  expect(await shown(page)).toEqual([]);
});

test('a cancelled request no longer counts in the waiting notification batch', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await approval(page, 'r-1');
  await approval(page, 'r-2');
  await approval(page, 'r-3');
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-1', kind: 'approval_cancelled', requestId: 'r-1', text: '' }));
  await expect.poll(() => shown(page).then(calls => calls.length), { timeout: 10_000 }).toBe(1);
  const call = (await shown(page))[0];
  expect(String(call.body)).toContain('2 approvals waiting');
  expect(String(call.body)).not.toContain('3 approvals');
});

/** A Council snapshot: `asking` rests the team on the user, anything else moves on. */
const council = (page: Page, asking: boolean, revision: number) => page.evaluate(([asking, revision]) => {
  (window as any).__previewEmit('architect-event', {
    sessionId: 'session-1',
    config: { workers: [], maxParallel: 1, maxRounds: 1, maxAssignments: 1, workspace: 'shared', summaryLimit: 0 },
    status: 'ready', round: 1, revision, workers: [], error: null, updatedAt: Date.now(),
    councilStatus: { state: asking ? 'asking' : 'passed', round: 1, lowest: null, target: 1, stale: false },
  });
}, [asking, revision]);

test('Council asking follows the input preference, once per ask', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await council(page, true, 1);
  await council(page, true, 2);
  await expect.poll(() => shown(page).then(calls => calls.length), { timeout: 10_000 }).toBe(1);
  const call = (await shown(page))[0];
  expect(call.suppressBanner).toBe(false);
  expect(call.sessionId).toBe('session-1');
  expect(String(call.title)).toContain('needs your answer');
});

test('the end of a Council ask withdraws its still-waiting notification', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { document.hasFocus = () => false; });
  await council(page, true, 1);
  await council(page, false, 2);
  await page.waitForTimeout(6_500);
  expect(await shown(page)).toEqual([]);
});
