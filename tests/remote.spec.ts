import { expect, test, type Page } from '@playwright/test';

/* PandaCode Connect on the preview's sample account (src/preview-remote.ts): sign in, allow
 * remote control, then start a new task on another computer from the context bar. */
async function openRemoteSettings(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  return page.getByRole('tabpanel', { name: 'Remote access' });
}

test('signs in with a device code, toggles remote control and lists devices', async ({ page }) => {
  const panel = await openRemoteSettings(page);
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByLabel('Device code')).toHaveText('WDJB-MJHT');
  await expect(panel.getByRole('button', { name: 'Copy code' })).toBeVisible();
  await expect(panel.getByText('octocat')).toBeVisible();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();

  const toggle = panel.getByRole('checkbox', { name: 'Allow remote control of this computer' });
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(toggle).toBeChecked();
  const full = panel.getByRole('checkbox', { name: 'Full access for remote tasks' });
  await expect(full).not.toBeChecked();
  await full.check();
  await expect(full).toBeChecked();
  await expect(toggle).toBeChecked();
  await expect(panel.locator('.remote-device[data-device="dev-this"]')).toContainText('This computer');
  await expect(panel.locator('.remote-device[data-device="dev-this"]')).toContainText('remote control on');

  const studio = panel.locator('.remote-device[data-device="dev-studio"]');
  await expect(studio).toContainText('Studio iMac');
  await expect(studio).toContainText('9b02e4aa71c3d605');
  await expect(studio.getByRole('img', { name: 'Online' })).toBeVisible();
  await expect(panel.locator('.remote-device[data-device="dev-laptop"]').getByRole('img', { name: 'Offline' })).toBeVisible();

  await expect(panel.getByRole('checkbox', { name: /^Trusted:/ })).toHaveCount(0);
  await expect(panel.locator('.remote-trust')).toHaveCount(0);

  await panel.getByRole('button', { name: 'Revoke Old laptop' }).click();
  await expect(panel.locator('.remote-device[data-device="dev-laptop"]')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Sign out' }).click();
  await expect(panel.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
});

async function signedInNewTask(page: Page) {
  const panel = await openRemoteSettings(page);
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
  await page.locator('.new-task-button').click();
  return page.locator('#composer-computer');
}
async function chooseStudio(page: Page) {
  const computer = page.locator('#composer-computer');
  await computer.click();
  await page.getByRole('menuitemradio', { name: 'Studio iMac' }).click();
  await expect(computer).toHaveAccessibleName('Computer: Studio iMac');
}

test('the computer choice offers setup before sign-in and one row per computer after', async ({ page }) => {
  await page.goto('/');
  await page.locator('.new-task-button').click();
  // Signed out, Run on still shows so other computers can be set up from it.
  await page.locator('#composer-computer').click();
  await page.getByRole('menu', { name: 'Run on' }).getByRole('menuitemradio', { name: 'Set up other computers…' }).click();
  await expect(page.getByRole('tabpanel', { name: 'Remote access' })).toBeVisible();
  await page.keyboard.press('Escape');
  const computer = await signedInNewTask(page);
  await expect(computer).toHaveAccessibleName('Computer: This computer');
  await computer.click();
  const menu = page.getByRole('menu', { name: 'Run on' });
  await expect(menu.getByRole('menuitemradio', { name: 'This computer' })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitemradio', { name: 'Studio iMac' })).toBeEnabled();
  await expect(menu.getByRole('menuitemradio', { name: 'Old laptop' })).toHaveCount(0);
  // Every online computer hosting remote control is a target.
  await expect(menu.getByRole('menuitemradio', { name: 'Home NAS' })).toBeEnabled();
  await page.keyboard.press('Escape');
  // Local / Worktree still shows beside it.
  await expect(page.locator('#composer-area .composer-local')).toHaveText('Local');
});

test('a new task starts on another computer and is an ordinary task with a locked computer', async ({ page }) => {
  await signedInNewTask(page);
  await chooseStudio(page);
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Run the slow suite over there');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  const log = page.getByRole('log', { name: 'Conversation' });
  await expect(log).toContainText('Run the slow suite over there');
  await expect(page.locator('#navigation .task-item.selected')).toContainText('Run the slow suite over there');
  const started = await page.evaluate(() => (window as any).__remoteStarts);
  expect(started).toHaveLength(1);
  expect(started[0]).toMatchObject({ deviceId: 'dev-studio', projectId: 'project-1', prompt: 'Run the slow suite over there', worktree: false, branch: 'feat/instant-search' });
  expect(started[0].provider).toBeTruthy();

  // Started tasks show their computer, fixed, and no local branch or change actions.
  const locked = page.locator('#composer-area .composer-computer-fixed');
  await expect(locked).toHaveText('on Studio iMac');
  await expect(page.locator('#composer-computer')).toHaveCount(0);
  await expect(page.locator('#composer-area [data-action="branch-menu"]')).toHaveCount(0);
  await expect(page.locator('#composer-area .branch-chip-fixed')).toBeVisible();
  await expect(page.locator('#inspector-content')).toContainText('Runs on Studio iMac');
  await expect(page.locator('#commit-form')).toHaveCount(0);
  // The composer stays the ordinary one.
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeVisible();
});

test('GitHub behind this computer asks first: Cancel keeps the draft, Continue starts', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteBehind = { ahead: 2, dirty: true }; });
  await signedInNewTask(page);
  await chooseStudio(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Ship the fix');
  await page.getByRole('button', { name: 'Send message' }).click();
  const dialog = page.getByRole('dialog', { name: 'GitHub is behind this computer' });
  await expect(dialog).toContainText('2 unpushed commits, uncommitted changes');
  await expect(dialog).toContainText('Studio iMac will start from GitHub’s feat/instant-search');
  await dialog.getByRole('button', { name: 'Cancel' }).click();
  await expect(dialog).toHaveCount(0);
  await expect(prompt).toHaveValue('Ship the fix');
  expect(await page.evaluate(() => (window as any).__remoteStarts)).toBeUndefined();

  await page.getByRole('button', { name: 'Send message' }).click();
  await dialog.getByRole('button', { name: 'Continue' }).click();
  await expect(page.getByRole('log', { name: 'Conversation' })).toContainText('Ship the fix');
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  expect(await page.evaluate(() => (window as any).__remoteStarts.length)).toBe(1);
});

test('a project without a GitHub remote cannot start on another computer', async ({ page }) => {
  await signedInNewTask(page);
  await page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true }).click();
  await page.getByRole('dialog', { name: 'Choose project', exact: true }).getByRole('option', { name: /^pandacode — / }).click();
  await chooseStudio(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Try it there');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#toast')).toContainText('pandacode has no GitHub remote, so it can’t run on another computer.');
  await expect(prompt).toHaveValue('Try it there');
  expect(await page.evaluate(() => (window as any).__remoteStarts)).toBeUndefined();
});

test('sign-in can be cancelled', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__signInDelay = 60_000; });
  const panel = await openRemoteSettings(page);
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByLabel('Device code')).toHaveText('WDJB-MJHT');
  await expect(panel.getByText(/code expires at/)).toBeVisible();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByLabel('Device code')).toHaveCount(0);
  await expect(panel.getByRole('button', { name: 'Sign in with GitHub' })).toBeEnabled();
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('device fingerprints are listed without trust controls when host mode is off', async ({ page }) => {
  const panel = await openRemoteSettings(page);
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('checkbox', { name: 'Allow remote control of this computer' })).not.toBeChecked();
  await expect(panel.locator('.remote-device[data-device="dev-studio"]')).toContainText('9b02e4aa71c3d605');
  await expect(panel.getByRole('checkbox', { name: /^Trusted:/ })).toHaveCount(0);
});

const harnesses = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
async function openPicker(page: Page) {
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  return harnesses(page);
}

test('picking another computer limits the picker to its catalog, and local is restored', async ({ page }) => {
  await signedInNewTask(page);
  await chooseStudio(page);
  const picker = await openPicker(page);
  await expect(picker.getByRole('region', { name: 'Claude Code' })).toBeVisible();
  await expect(picker.getByRole('region', { name: 'Codex' })).toBeVisible();
  await expect(picker.getByRole('region', { name: 'Kimi Code' })).toHaveCount(0);
  await expect(picker.getByRole('region', { name: 'OpenCode' })).toHaveCount(0);
  await page.keyboard.press('Escape');

  const computer = page.locator('#composer-computer');
  await computer.click();
  await page.getByRole('menuitemradio', { name: 'This computer' }).click();
  const local = await openPicker(page);
  await expect(local.getByRole('region', { name: 'Kimi Code' })).toBeVisible();
});

test('a model missing on the chosen computer is swapped, with a notice', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('pandacode.defaultProvider', 'kimi'); localStorage.setItem('pandacode.provider', 'kimi'); });
  await signedInNewTask(page);
  await chooseStudio(page);
  await expect(page.locator('#toast')).toContainText('Studio iMac doesn’t have Kimi Code. Using Claude Code.');
  let picker = await openPicker(page);
  await expect(picker.getByRole('region', { name: 'Claude Code' }).locator('[aria-current="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await page.locator('#composer-computer').click();
  await page.getByRole('menuitemradio', { name: 'This computer' }).click();
  picker = await openPicker(page);
  await expect(picker.getByRole('region', { name: 'Kimi Code' }).locator('[aria-current="true"]')).toHaveCount(1);
});

test('a task running on another computer lists that computer’s catalog', async ({ page }) => {
  await signedInNewTask(page);
  await chooseStudio(page);
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Mirror task');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Studio iMac');
  const picker = await openPicker(page);
  await expect(picker.getByRole('region', { name: 'Claude Code' })).toBeVisible();
  await expect(picker.getByRole('region', { name: 'Kimi Code' })).toHaveCount(0);
});
