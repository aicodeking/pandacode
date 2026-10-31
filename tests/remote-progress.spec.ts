import { expect, test, type Page } from '@playwright/test';

/* The strip above a New task's composer while it starts on another computer
 * (src/remote-progress.ts), driven by the preview host's stages (src/preview-remote.ts). */

async function newTask(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.locator('.new-task-button').click();
  await page.getByRole('textbox', { name: 'Message your coding agent' }).waitFor();
}

/** Starts tracking a start for the open New task, stepped by `__remoteStartNext()`. */
async function trackStart(page: Page) {
  await page.evaluate(async () => {
    const w = window as any;
    w.__remoteStartManual = true;
    const [progress, host] = await Promise.all([import('/src/remote-progress.ts' as string), import('/src/preview-remote.ts' as string)]);
    const id = document.querySelector<HTMLTextAreaElement>('#prompt')!.dataset.sessionId!;
    // The preview host's frames go straight to the handler native code would emit them to.
    w.__startResult = progress.trackRemoteStart(id, { deviceId: 'dev-studio', name: 'Studio iMac' }, (startId: string) => host.previewRemoteStart({ deviceId: 'dev-studio', startId }, (_: string, event: unknown) => progress.onRemoteStartProgress(event)), () => { w.__retried = (w.__retried ?? 0) + 1; })
      .then(() => 'started', (error: Error) => `failed: ${error.message}`);
  });
}
/** Lets the preview host take its next step, once it is waiting for one. */
async function next(page: Page) {
  await page.waitForFunction(() => typeof (window as any).__remoteStartNext === 'function');
  await page.evaluate(() => { const w = window as any, step = w.__remoteStartNext; w.__remoteStartNext = undefined; step(); });
}

test('a remote start shows each stage, the download percent, and survives a composer redraw', async ({ page }) => {
  await newTask(page);
  await trackStart(page);
  const strip = page.locator('#composer-area .remote-start-strip');
  const status = strip.getByRole('status');
  await expect(status).toHaveText('Studio iMac · Connecting to computer');
  await expect(strip.locator('.support-spinner')).toBeVisible();
  // The strip sits right above the composer.
  expect(await page.evaluate(() => document.querySelector('#composer-area .remote-start-strip')?.nextElementSibling?.id)).toBe('composer');

  await next(page);
  await expect(status).toHaveText('Studio iMac · Finding orbit-labs/orbit');
  await next(page);
  await expect(status).toHaveText('Studio iMac · Downloading orbit-labs/orbit');
  await expect(strip.getByRole('progressbar')).toHaveCount(0);
  await next(page);
  await expect(status).toHaveText('Studio iMac · Downloading orbit-labs/orbit · 12%');
  const bar = strip.getByRole('progressbar', { name: 'Download progress' });
  await expect(bar).toHaveAttribute('value', '12');

  // A redraw of the composer area keeps the strip.
  await page.evaluate(() => document.querySelector('#composer-area .remote-start-strip')!.remove());
  await expect(bar).toHaveAttribute('value', '12');

  await next(page);
  await expect(bar).toHaveAttribute('value', '58');
  await next(page);
  await next(page);
  await expect(status).toHaveText('Studio iMac · Preparing checkout');
  await expect(bar).toHaveCount(0);
  await next(page);
  await expect(status).toHaveText('Studio iMac · Starting agent');
  await next(page);
  expect(await page.evaluate(() => (window as any).__startResult)).toBe('started');
  await expect(strip).toHaveCount(0);
});

test('a failed remote start stays as an error with Retry and Dismiss', async ({ page }) => {
  await newTask(page);
  await trackStart(page);
  const strip = page.locator('#composer-area .remote-start-strip');
  for (let step = 0; step < 6; step++) await next(page);
  await expect(strip.getByRole('status')).toHaveText('Studio iMac · Preparing checkout');
  await page.evaluate(() => { (window as any).__remoteStartFail = 'Could not fetch from GitHub: timed out'; });
  await next(page);
  await expect(strip.getByRole('alert')).toHaveText('Studio iMac · Could not start: Could not fetch from GitHub: timed out');
  await expect(strip).toHaveAttribute('data-stage', 'error');
  await expect(strip.locator('.support-spinner')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__startResult)).toBe('failed: Could not fetch from GitHub: timed out');

  await strip.getByRole('button', { name: 'Retry' }).click();
  await expect(strip).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__retried)).toBe(1);

  // Dismiss clears a failure without retrying.
  await trackStart(page);
  for (let step = 0; step < 6; step++) await next(page);
  await page.evaluate(() => { (window as any).__remoteStartFail = 'Claude Code is not installed on Studio iMac.'; });
  await next(page);
  await strip.getByRole('button', { name: 'Dismiss' }).click();
  await expect(strip).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__retried)).toBe(1);
});

async function sendToStudio(page: Page, text: string) {
  // Sign-in, computer choice and a stepped start: a long flow for a loaded parallel run.
  test.slow();
  await page.addInitScript(() => { (window as any).__remoteStartManual = true; });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
  await page.locator('.new-task-button').click();
  await page.locator('#composer-computer').click();
  await page.getByRole('menuitemradio', { name: 'Studio iMac' }).click();
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}

test('sending a New task to another computer shows its start stages, then opens the task', async ({ page }) => {
  await sendToStudio(page, 'Run the slow suite over there');
  // The stages are the sent prompt's turn status (tests/remote-first-message.spec.ts), so the strip stays away.
  const strip = page.locator('#composer-area .remote-start-strip'), status = page.locator('#stream-region .live-status');
  await expect(status).toHaveText('Connecting to Studio iMac…');
  await expect(strip).toHaveCount(0);
  for (let step = 0; step < 3; step++) await next(page);
  await expect(status).toHaveText(/^Downloading .* · 12%$/);
  for (let step = 0; step < 4; step++) await next(page);
  await expect(status).toHaveText('Starting agent');
  await expect(strip).toHaveCount(0);
  await next(page);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Run the slow suite over there');
  const started = await page.evaluate(() => (window as any).__remoteStarts);
  expect(started).toHaveLength(1);
  expect(started[0].startId.startsWith(`${started[0].sessionId}.`)).toBe(true);
});

test('a failed start shows in the strip, not as a toast, and Retry sends it again', async ({ page }) => {
  await sendToStudio(page, 'Try the flaky build');
  const strip = page.locator('#composer-area .remote-start-strip');
  for (let step = 0; step < 6; step++) await next(page);
  await page.evaluate(() => { (window as any).__remoteStartFail = 'Could not fetch from GitHub: timed out'; });
  await next(page);
  await expect(strip.getByRole('alert')).toHaveText('Studio iMac · Could not start: Could not fetch from GitHub: timed out');
  await expect(page.locator('#toast')).not.toContainText('Could not fetch');
  // The draft is kept for Retry.
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toHaveValue('Try the flaky build');

  await strip.getByRole('button', { name: 'Retry' }).click();
  await expect(strip).toHaveCount(0);
  await expect(page.locator('#stream-region .live-status')).toHaveText('Connecting to Studio iMac…');
  for (let step = 0; step < 8; step++) await next(page);
  await expect(strip).toHaveCount(0);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  expect(await page.evaluate(() => (window as any).__remoteStarts.length)).toBe(2);
});

test('a busy host checkout starts in a worktree and says so; a steer while starting is queued', async ({ page }) => {
  const note = 'Started in a worktree: Studio iMac has uncommitted changes in orbit.';
  await page.addInitScript(text => { (window as any).__remoteStartBusy = text; }, note);
  await sendToStudio(page, 'Fix the login bug');
  for (let step = 0; step < 3; step++) await next(page);
  // Nothing to steer yet: the message waits in the queue instead of failing.
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Also add a test');
  await prompt.press('ControlOrMeta+Enter');
  await expect(page.locator('#toast')).toContainText('Studio iMac is still starting this task; your message is queued for after it.');
  await expect(page.locator('[data-queue-id]')).toHaveCount(1);
  await expect(page.locator('[data-queue-id]')).toContainText('Also add a test');
  for (let step = 0; step < 4; step++) await next(page);
  await expect(page.locator('#stream-region .live-status')).toHaveText(note);
  await next(page);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  await expect(page.locator('#composer-area .composer-inline-note')).toHaveText(note);
});

test('a start whose reply was lost still shows the host worktree note once it links', async ({ page }) => {
  test.slow();
  const note = 'Started in a worktree: Studio iMac has an agent working in orbit.';
  await page.addInitScript(() => { (window as any).__remoteStartAmbiguous = true; });
  await sendToStudio(page, 'Lost reply, busy host');
  for (let step = 0; step < 8; step++) await next(page);
  await page.waitForFunction(() => typeof (window as any).__remoteStartAttach === 'function');
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Waiting for Studio iMac');
  await page.evaluate(text => (window as any).__remoteStartAttach(text), note);
  await expect(page.locator('#composer-area .composer-inline-note')).toHaveText(note);
});
