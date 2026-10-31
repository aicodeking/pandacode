import { expect, test, type Page } from '@playwright/test';

/* A prompt sent to another computer shows at once (src/main.ts sendRemote): the turn below it
 * reports the start's stages, then streams the host's events. Its history is copied from the
 * host only when the run ends (the preview mirrors remote/mirror.rs), and holds one copy. */

async function sendToStudio(page: Page, text: string) {
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
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
}
async function next(page: Page) {
  await page.waitForFunction(() => typeof (window as any).__remoteStartNext === 'function');
  await page.evaluate(() => { const w = window as any, step = w.__remoteStartNext; w.__remoteStartNext = undefined; step(); });
}
const userMessages = (page: Page, text: string) => page.locator('#transcript .user-message').filter({ hasText: text });

test('the first prompt to another computer shows at once, with the start stages in its turn', async ({ page }) => {
  await sendToStudio(page, 'Run the slow suite over there');
  const status = page.locator('#stream-region .live-status');
  // Still connecting: the host has not answered, yet the prompt is in the thread.
  await expect(userMessages(page, 'Run the slow suite over there')).toHaveCount(1);
  await expect(status).toHaveText('Connecting to Studio iMac…');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toHaveValue('');
  // The stages show once, in the turn, not also in the strip above the composer.
  await expect(page.locator('#composer-area .remote-start-strip')).toHaveCount(0);
  await expect(page.locator('.new-task-welcome')).toHaveCount(0);

  for (let step = 0; step < 3; step++) await next(page);
  await expect(status).toHaveText(/^Downloading .* · 12%$/);
  for (let step = 0; step < 3; step++) await next(page);
  await expect(status).toHaveText('Preparing checkout');
  await next(page);
  await expect(status).toHaveText('Starting agent');
  await expect(userMessages(page, 'Run the slow suite over there')).toHaveCount(1);
  await next(page);

  // The host's events stream in under the prompt, before the run ends.
  await expect(page.locator('#stream-region .live-text')).toContainText('This is the browser preview');
  await expect(userMessages(page, 'Run the slow suite over there')).toHaveCount(1);
  // After the run, history (copied from the host) holds exactly one copy.
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#transcript .agent-message.message').filter({ hasText: 'Open the native PandaCode app' }).first()).toBeVisible();
  await expect(userMessages(page, 'Run the slow suite over there')).toHaveCount(1);
  await expect(page.locator('#transcript .user-message[data-message-id^="-"]')).toHaveCount(0);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');

  // A follow-up on the mirror shows at once too, streams live, and ends with one copy.
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Now the fast suite');
  await prompt.press('Enter');
  await expect(userMessages(page, 'Now the fast suite')).toHaveCount(1);
  await expect(page.locator('#stream-region .live-text')).toContainText('This is the browser preview');
  await expect(userMessages(page, 'Now the fast suite')).toHaveCount(1);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#transcript .user-message[data-message-id^="-"]')).toHaveCount(0);
  await expect(userMessages(page, 'Now the fast suite')).toHaveCount(1);
  await expect(userMessages(page, 'Run the slow suite over there')).toHaveCount(1);
});

test('a failed start takes the prompt back to the composer, and Retry shows it again', async ({ page }) => {
  await sendToStudio(page, 'Try the flaky build');
  await expect(userMessages(page, 'Try the flaky build')).toHaveCount(1);
  for (let step = 0; step < 6; step++) await next(page);
  await page.evaluate(() => { (window as any).__remoteStartFail = 'Could not fetch from GitHub: timed out'; });
  await next(page);
  const strip = page.locator('#composer-area .remote-start-strip');
  await expect(strip.getByRole('alert')).toHaveText('Studio iMac · Could not start: Could not fetch from GitHub: timed out');
  await expect(userMessages(page, 'Try the flaky build')).toHaveCount(0);
  await expect(page.locator('#stream-region .live-status')).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toHaveValue('Try the flaky build');

  await strip.getByRole('button', { name: 'Retry' }).click();
  await expect(userMessages(page, 'Try the flaky build')).toHaveCount(1);
  await expect(page.locator('#stream-region .live-status')).toHaveText('Connecting to Studio iMac…');
  for (let step = 0; step < 8; step++) await next(page);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await expect(page.locator('#transcript .agent-message.message').filter({ hasText: 'Open the native PandaCode app' }).first()).toBeVisible();
  await expect(userMessages(page, 'Try the flaky build')).toHaveCount(1);
});
