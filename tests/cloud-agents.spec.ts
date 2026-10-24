import { expect, test, type Page } from '@playwright/test';

/* Cloud agents in the preview (src/preview.ts, src/preview-vm.ts): connect a sandbox provider,
 * pick it in a New task's "Run on" menu, and watch the cloud machine get ready. */
const settingsRegion = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
async function openCloudSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsRegion(page).getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
  return settingsRegion(page);
}
async function connectE2b(page: Page) {
  const settings = await openCloudSettings(page);
  await settings.getByRole('button', { name: 'Connect E2B', exact: true }).click();
  await settings.getByLabel('E2B API key').fill('e2b_key');
  await settings.getByRole('form', { name: 'Connect E2B' }).locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: 'Disconnect E2B', exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings).toBeHidden();
}
async function newTask(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.locator('.new-task-button').click();
}
async function startOnE2b(page: Page, text: string) {
  await newTask(page);
  await connectE2b(page);
  const computer = page.locator('#composer-computer');
  await expect(computer).toHaveAccessibleName('Computer: This computer');
  await computer.click();
  await page.getByRole('menuitemradio', { name: 'Cloud · E2B' }).click();
  await expect(computer).toHaveAccessibleName('Computer: Cloud · E2B');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill(text);
  await page.getByRole('button', { name: 'Send message' }).click();
}
const strip = (page: Page) => page.locator('#composer-area .cloud-strip');

test('the Run on menu lists cloud providers without Connect sign-in', async ({ page }) => {
  await newTask(page);
  await connectE2b(page);
  await page.locator('#composer-computer').click();
  const menu = page.getByRole('menu', { name: 'Run on' });
  await expect(menu.getByRole('menuitemradio', { name: 'This computer' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Cloud · E2B' })).toBeEnabled();
  // Only connected providers are listed; the rest are behind setup.
  await expect(menu.getByRole('menuitemradio', { name: /^Cloud · / })).toHaveCount(1);
  await expect(menu.getByText(/Modal|Railway/)).toHaveCount(0);
  await menu.getByRole('menuitemradio', { name: 'Set up cloud providers…' }).click();
  await expect(settingsRegion(page).getByRole('tabpanel', { name: 'Cloud sandboxes' })).toBeVisible();
});

test('a new task on E2B becomes a cloud task with a fixed chip and live stages', async ({ page }) => {
  await startOnE2b(page, 'Run the suite in the cloud');
  await expect.poll(() => page.evaluate(() => (window as any).__cloudStarts?.length)).toBe(1);
  const started = await page.evaluate(() => (window as any).__cloudStarts);
  expect(started[0]).toMatchObject({ provider: 'e2b', projectId: 'project-1', prompt: 'Run the suite in the cloud', harness: 'claude' });
  expect(started[0].sessionId).toBeTruthy();

  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on E2B');
  await expect(page.locator('#composer-computer')).toHaveCount(0);
  // Preparation steps go by every 400 ms in the preview; each shows with a spinner.
  await expect(strip(page)).toContainText(/E2B · (Creating machine|Installing Claude Code|Copying logins|Uploading checkout|Running)/);
  await expect(strip(page).locator('.support-spinner')).toBeVisible();
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Run the suite in the cloud');
  await expect(strip(page)).toContainText('E2B · Ready');
  await expect(page.locator('#navigation .task-item.selected .task-cloud')).toHaveAccessibleName('Runs on E2B');
});

test('the cloud machine menu syncs, stops and deletes after confirming', async ({ page }) => {
  await startOnE2b(page, 'Cloud chores');
  await expect(strip(page)).toContainText('E2B · Ready');
  const actions = () => page.evaluate(() => (window as any).__cloudActions ?? []);
  const menuButton = page.getByRole('button', { name: 'Cloud machine actions' });

  await menuButton.click();
  const menu = page.getByRole('menu', { name: 'Cloud machine' });
  await expect(menu.getByRole('menuitem', { name: 'Retry' }).or(menu.getByRole('menuitemradio', { name: 'Retry' }))).toHaveCount(0);
  await menu.getByText('Sync changes').click();
  await expect(strip(page)).toContainText('Syncing changes');
  await expect(strip(page)).toContainText('E2B · Ready');

  await menuButton.click();
  await page.getByRole('menu', { name: 'Cloud machine' }).getByText('Stop machine').click();
  await expect(strip(page)).toContainText('E2B · Stopped');

  await menuButton.click();
  await page.getByRole('menu', { name: 'Cloud machine' }).getByText('Delete machine…').click();
  const dialog = page.getByRole('dialog', { name: 'Delete cloud machine?' });
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  expect(await actions()).toEqual(['sync', 'stop']);
  await menuButton.click();
  await page.getByRole('menu', { name: 'Cloud machine' }).getByText('Delete machine…').click();
  await page.getByRole('dialog', { name: 'Delete cloud machine?' }).getByRole('button', { name: 'Delete machine' }).click();
  await expect.poll(actions).toEqual(['sync', 'stop', 'delete']);
});

test('Settings → Cloud connects keyed providers and saves a Claude token', async ({ page }) => {
  await newTask(page);
  const settings = await openCloudSettings(page);
  for (const name of ['E2B', 'Modal', 'CodeSandbox', 'Runloop', 'Blaxel', 'Tensorlake', 'Freestyle', 'boat']) await expect(settings.getByRole('button', { name: `Connect ${name}`, exact: true })).toBeVisible();

  await settings.getByRole('button', { name: 'Connect Modal', exact: true }).click();
  const modal = settings.getByRole('form', { name: 'Connect Modal' });
  await modal.getByLabel('Modal Token secret').fill('as-secret');
  await modal.locator('[type="submit"]').click();
  await expect(modal.getByRole('alert')).toHaveText('Enter the token id.');
  await modal.getByLabel('Modal Token ID').fill('ak-1');
  await modal.getByLabel('Modal Environment').fill('main');
  await modal.locator('[type="submit"]').click();
  await expect(settings.getByRole('button', { name: 'Disconnect Modal', exact: true })).toBeVisible();
  await expect(settings.locator('.cloud-provider[data-provider="modal"] .cloud-detail')).toHaveText('Connected · main');

  await settings.getByRole('button', { name: 'Connect Vercel', exact: true }).click();
  await expect(settings.getByLabel('Vercel Sandbox project ID')).toBeVisible();
  await expect(settings.getByLabel('Vercel Sandbox team ID')).toBeVisible();
  await settings.getByRole('button', { name: 'Connect Google Cloud', exact: true }).click();
  await expect(settings.getByLabel('Google Cloud Zone')).toBeVisible();

  const claude = settings.getByRole('form', { name: 'Claude login for cloud agents' });
  await claude.getByRole('button', { name: 'Save token' }).click();
  await expect(claude.getByRole('alert')).toHaveText('Paste the token from claude setup-token.');
  await claude.getByLabel('Claude token for cloud agents').fill('sk-ant-oat01-preview');
  await claude.getByRole('button', { name: 'Save token' }).click();
  await expect(claude.getByRole('status')).toContainText('Saved.');
  await expect(settings.locator('.cloud-claude .info-mark')).toHaveAttribute('data-tip', /claude setup-token/);
});

test('switching tasks while a machine prepares keeps the strip and chip with the cloud task', async ({ page }) => {
  await startOnE2b(page, 'Prepare in the background');
  const cloudRow = page.locator('#navigation .task-item', { has: page.locator('.task-cloud') });
  await expect(cloudRow).toHaveCount(1);
  await expect(strip(page)).toBeVisible();
  await page.locator('#navigation .task-item:not(.selected)').first().click();
  await expect(page.locator('#navigation .task-item.selected .task-cloud')).toHaveCount(0);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveCount(0);
  // Its progress keeps arriving (a step every 400 ms) and must not paint this task.
  await page.waitForTimeout(1200);
  await expect(strip(page)).toHaveCount(0);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveCount(0);
  await cloudRow.click();
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on E2B');
  await expect(strip(page)).toContainText('E2B · Ready');
});

test('a failed machine action shows the provider error', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__cloudActionFail = 'stop'; });
  await startOnE2b(page, 'Stop fails');
  await expect(strip(page)).toContainText('E2B · Ready');
  await page.getByRole('button', { name: 'Cloud machine actions' }).click();
  await page.getByRole('menu', { name: 'Cloud machine' }).getByText('Stop machine').click();
  await expect(page.locator('#toast')).toHaveText('E2B could not stop the machine (HTTP 503).');
  await expect(strip(page)).toContainText('E2B · Ready');
});
