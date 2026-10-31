import { expect, test, type Page } from '@playwright/test';

async function showRemoteSettings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  return page.getByRole('tabpanel', { name: 'Remote access' });
}
async function openRemoteSettings(page: Page) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  return showRemoteSettings(page);
}
async function chooseStudioOnNewTask(page: Page) {
  const panel = await openRemoteSettings(page);
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
  await page.locator('.new-task-button').click();
  const computer = page.locator('#composer-computer');
  await computer.click();
  await page.getByRole('menuitemradio', { name: 'Studio iMac' }).click();
  await expect(computer).toHaveAccessibleName('Computer: Studio iMac');
}
async function startMirror(page: Page, text = 'Mirror connection task') {
  await page.addInitScript(() => { (window as any).__remoteStartStep = 0; });
  await chooseStudioOnNewTask(page);
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill(text);
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect(page.locator('#composer-area .composer-computer-fixed')).toContainText('Studio iMac');
  const started = await page.evaluate(() => (window as any).__remoteStarts.at(-1));
  return started.sessionId as string;
}
async function nextStartStep(page: Page) {
  await page.waitForFunction(() => typeof (window as any).__remoteStartNext === 'function');
  await page.evaluate(() => { const w = window as any, step = w.__remoteStartNext; w.__remoteStartNext = undefined; step(); });
}
const userMessages = (page: Page, text: string) => page.locator('#transcript .user-message').filter({ hasText: text });

test('mirror file mentions use the local project and local-only slash commands explain themselves inline', async ({ page }) => {
  test.slow(); // waits for the mirror's first run to end
  await startMirror(page);
  const prompt = page.locator('#prompt');
  await prompt.fill('@src/ma');
  const menu = page.locator('.file-mention-menu:not([aria-hidden="true"])');
  await expect(menu.getByRole('option').filter({ hasText: 'main.ts' }).first()).toBeVisible();
  await expect(page.locator('#toast')).not.toContainText('This task runs on');
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await prompt.fill('/diff');
  await prompt.press('Escape');
  await prompt.press('Enter');
  await expect(page.locator('#composer-area .composer-inline-note')).toContainText('/diff');
  await expect(page.locator('#composer-area .composer-inline-note')).toContainText('this computer');
  await expect(prompt).toHaveValue('/diff');
  await expect(page.locator('#toast')).not.toContainText('This task runs on');
});

test('stopping a remote start shows feedback, calls cancellation, and restores the draft', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartManual = true; (window as any).__remoteCancelStartHold = true; });
  await chooseStudioOnNewTask(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Cancel this remote start');
  await prompt.press('Enter');
  await expect(userMessages(page, 'Cancel this remote start')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop task' }).click();
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Stopping…');
  await page.waitForFunction(() => typeof (window as any).__remoteCancelStartRelease === 'function');
  await page.evaluate(() => { (window as any).__remoteCancelStartRelease(); });
  await expect(prompt).toHaveValue('Cancel this remote start');
  await expect(userMessages(page, 'Cancel this remote start')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__remoteCancelStarts)).toHaveLength(1);
});

test('a failed remote-start cancellation rolls back the stopping state', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartManual = true; (window as any).__remoteCancelStartFail = 'The host did not cancel.'; });
  await chooseStudioOnNewTask(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Keep this start when cancel fails');
  await prompt.press('Enter');
  await page.getByRole('button', { name: 'Stop task' }).click();
  await expect(page.locator('#toast')).toContainText('The host did not cancel.');
  await expect(userMessages(page, 'Keep this start when cancel fails')).toHaveCount(1);
  await expect(prompt).toHaveValue('');
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Connecting to Studio iMac');
});

test('presence loss keeps the chosen computer and lists offline devices with Retry', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartStep = 0; });
  await chooseStudioOnNewTask(page);
  const computer = page.locator('#composer-computer');
  await expect(computer).toHaveAttribute('aria-haspopup', 'menu');
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  await expect(computer).toHaveAccessibleName(/Computer: Studio iMac.*Offline/);
  await expect(computer).not.toHaveAccessibleName(/This computer/);
  await computer.click();
  const menu = page.getByRole('menu', { name: 'Run on' });
  const studio = menu.getByRole('menuitemradio', { name: 'Studio iMac' });
  const laptop = menu.getByRole('menuitemradio', { name: 'Old laptop' });
  await expect(studio).toBeDisabled();
  await expect(studio).toContainText(/Offline.*last seen/);
  await expect(laptop).toBeDisabled();
  await expect(laptop).toContainText(/Offline.*last seen/);
  await expect(menu.getByRole('menuitemradio', { name: 'Set up other computers…' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('button', { name: 'Send message' })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__remoteResubscribeHold = true; });
  await page.getByRole('button', { name: 'Retry connection' }).click();
  await expect(page.getByRole('button', { name: 'Reconnecting…' })).toBeDisabled();
  await page.waitForFunction(() => typeof (window as any).__remoteResubscribeRelease === 'function');
  await page.evaluate(() => { (window as any).__remoteResubscribeRelease(); });
  await expect.poll(() => page.evaluate(() => (window as any).__remoteResubscribes.length)).toBe(1);
  expect(await page.evaluate(() => (window as any).__remoteReconnects)).toBe(1);
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', true));
  await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible();
  await expect(computer).toHaveAccessibleName('Computer: Studio iMac');
});

test('an offline mirror has a compact last-seen status and Retry resubscribes without a spinner', async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  const notice = page.locator('#stream-region .remote-connection');
  await expect(notice).toContainText('Studio iMac');
  await expect(notice).toContainText('offline');
  await expect(notice).toContainText('last seen');
  await expect(notice.locator('.support-spinner')).toHaveCount(0);
  await expect(page.locator('#composer-area .composer-computer-fixed')).toContainText('Offline');
  await page.evaluate(() => { (window as any).__remoteResubscribeHold = true; });
  await notice.getByRole('button', { name: 'Retry connection' }).click();
  await expect(notice).toContainText('Reconnecting…');
  await page.waitForFunction(() => typeof (window as any).__remoteResubscribeRelease === 'function');
  await page.evaluate(() => { (window as any).__remoteResubscribeRelease(); });
  await expect.poll(() => page.evaluate(() => (window as any).__remoteResubscribes.length)).toBe(1);
});

test('mirror stop feedback is immediate for the button and Escape', async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => { (window as any).__stopHold = true; });
  await page.getByRole('button', { name: 'Stop task' }).click();
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Stopping agent');
  await page.waitForFunction(() => typeof (window as any).__stopRelease === 'function');
  await page.evaluate(() => { (window as any).__stopRelease(); });
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Restart the mirror');
  await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task' })).toBeVisible();
  await page.evaluate(() => { (window as any).__stopHold = true; });
  await page.keyboard.press('Escape');
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Stopping agent');
  await page.waitForFunction(() => typeof (window as any).__stopRelease === 'function');
  await page.evaluate(() => { (window as any).__stopRelease(); });
});

test('remote settings distinguish loading, empty, and retryable status/device failures', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => { (window as any).__remoteStatusFailures = 1; });
  const panel = await showRemoteSettings(page);
  await expect(panel.getByRole('alert')).toContainText('Couldn’t load remote access');
  await expect(panel.getByText('No devices yet.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.getByRole('button', { name: 'Sign in with GitHub' })).toBeVisible();
  // The app's presence refresh asks first; the settings panel asks second.
  await page.evaluate(() => { (window as any).__remoteDevicesFailures = 2; });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('alert')).toContainText('Couldn’t load devices');
  await expect(panel.getByText('No devices yet.')).toHaveCount(0);
  await panel.getByRole('button', { name: 'Retry' }).click();
  await expect(panel.locator('.remote-device[data-device="dev-studio"]')).toBeVisible();
});

test('remote pre-check shows Checking and duplicate submits cannot start twice', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartStep = 0; });
  await chooseStudioOnNewTask(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Check once before starting');
  await page.evaluate(() => { (window as any).__remoteRepoCheckManual = true; });
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.getByRole('button', { name: 'Checking…' })).toBeDisabled();
  await page.evaluate(() => { const form = document.querySelector<HTMLFormElement>('#composer')!; form.requestSubmit(); form.requestSubmit(); });
  await expect.poll(() => page.evaluate(() => (window as any).__remoteRepoChecks.length)).toBe(1);
  await page.evaluate(() => { (window as any).__remoteRepoCheckRelease(); });
  await expect(page.locator('#composer-area .composer-computer-fixed')).toContainText('Studio iMac');
  expect(await page.evaluate(() => (window as any).__remoteStarts.length)).toBe(1);
});

test('an optimistic mirror prompt survives switching away during send preparation', async ({ page }) => {
  const mirrorId = await startMirror(page);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await page.evaluate(() => { (window as any).__remoteSendHold = true; });
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Optimistic background send');
  await page.evaluate(() => {
    document.querySelector<HTMLFormElement>('#composer')!.requestSubmit();
    document.querySelector<HTMLElement>('.task-item[data-id="session-2"]')!.click();
  });
  await page.waitForFunction(() => typeof (window as any).__remoteSendRelease === 'function');
  await page.locator(`.task-item[data-id="${mirrorId}"]`).click();
  await expect(userMessages(page, 'Optimistic background send')).toHaveCount(1);
  await page.evaluate(() => { (window as any).__remoteSendRelease(); });
});

test('an optimistic mirror steer survives switching away before the host answers', async ({ page }) => {
  const mirrorId = await startMirror(page);
  await expect(page.getByRole('button', { name: 'Steer the running turn' })).toBeVisible();
  await page.evaluate(() => { (window as any).__remoteSteerHold = true; });
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Optimistic background steer');
  await page.evaluate(() => {
    document.querySelector<HTMLElement>('.steer-button')!.click();
    document.querySelector<HTMLElement>('.task-item[data-id="session-2"]')!.click();
  });
  await page.waitForFunction(() => typeof (window as any).__remoteSteerRelease === 'function');
  await page.locator(`.task-item[data-id="${mirrorId}"]`).click();
  await expect(userMessages(page, 'Optimistic background steer')).toHaveCount(1);
  await page.evaluate(() => { (window as any).__remoteSteerRelease(); });
});

test('agent questions can load a mirror workspace image through its host', async ({ page }) => {
  await page.goto('/');
  await page.evaluate(async () => {
    const { createAgentInput } = await import('/src/agent-input.ts' as string);
    const input = createAgentInput('mirror-task', 'mirror-question', { kind: 'questions', questions: [{ id: 'image', question: '![Host image](docs/before.png)', options: [{ label: 'Use it' }] }] }, () => undefined, true);
    input.element.id = 'mirror-question';
    document.body.append(input.element);
  });
  await expect(page.locator('#mirror-question .rich-image img')).toHaveAttribute('src', /^data:image\//);
  expect(await page.evaluate(() => (window as any).__remoteWorkspaceImages)).toEqual([{ sessionId: 'mirror-task', path: 'docs/before.png' }]);
});

test('the first mirror prompt stays visible after a steer', async ({ page }) => {
  await startMirror(page, 'First mirror prompt');
  await expect(page.getByRole('button', { name: 'Steer the running turn' })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Steer the mirror');
  await page.getByRole('button', { name: 'Steer the running turn' }).click();
  await expect(userMessages(page, 'Steer the mirror')).toHaveCount(1);
  await expect(userMessages(page, 'First mirror prompt')).toHaveCount(1);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 10_000 });
  await expect(userMessages(page, 'First mirror prompt')).toHaveCount(1);
  await expect(userMessages(page, 'Steer the mirror')).toHaveCount(1);
});

test('Retry reconnects to the relay first and shows a failure inline', async ({ page }) => {
  await startMirror(page);
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  const notice = page.locator('#stream-region .remote-connection');
  await page.evaluate(() => { (window as any).__remoteReconnectFail = 'The relay is unavailable.'; });
  await notice.getByRole('button', { name: 'Retry connection' }).click();
  await expect(notice).toContainText('Couldn’t reconnect to Studio iMac: The relay is unavailable.');
  await expect(page.locator('#toast')).not.toContainText('The relay is unavailable.');
  expect(await page.evaluate(() => (window as any).__remoteReconnects)).toBe(1);
  expect(await page.evaluate(() => (window as any).__remoteResubscribes?.length ?? 0)).toBe(0);
  await notice.getByRole('button', { name: 'Retry connection' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteResubscribes?.length ?? 0)).toBe(1);
  expect(await page.evaluate(() => (window as any).__remoteReconnects)).toBe(2);
});

test('another computer going offline or online keeps the @ menu open', async ({ page }) => {
  await chooseStudioOnNewTask(page);
  const prompt = page.locator('#prompt');
  await prompt.fill('@src/ma');
  const menu = page.locator('.file-mention-menu:not([aria-hidden="true"])');
  await expect(menu.getByRole('option').first()).toBeVisible();
  await page.evaluate(() => (window as any).__remoteOnline('dev-nas', false));
  await page.evaluate(() => (window as any).__remoteOnline('dev-nas', true));
  await expect(menu.getByRole('option').first()).toBeVisible();
  await expect(prompt).toBeFocused();
  await expect(prompt).toHaveValue('@src/ma');
});

test('a chosen computer that is no longer paired is labelled and offers another', async ({ page }) => {
  await chooseStudioOnNewTask(page);
  await page.evaluate(() => (window as any).__remoteRevoke('dev-studio'));
  const computer = page.locator('#composer-computer');
  await expect(computer).toHaveAccessibleName('Computer: Studio iMac · Not paired');
  const note = page.locator('#composer-area .remote-missing-note');
  await expect(note).toContainText('Studio iMac is no longer paired.');
  await note.getByRole('button', { name: 'Choose another' }).click();
  await expect(page.getByRole('menu', { name: 'Run on' })).toBeVisible();
});

test('Stop on a remote start waits for the host to confirm before restoring the draft', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartManual = true; (window as any).__remoteCancelStartPending = true; });
  await chooseStudioOnNewTask(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Wait for the cancel');
  await prompt.press('Enter');
  await expect(userMessages(page, 'Wait for the cancel')).toHaveCount(1);
  await page.getByRole('button', { name: 'Stop task' }).click();
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Stopping…');
  await expect(userMessages(page, 'Wait for the cancel')).toHaveCount(1);
  await expect(prompt).toHaveValue('');
  await page.waitForFunction(() => typeof (window as any).__remoteCancelStartFailLater === 'function');
  await page.evaluate(() => { (window as any).__remoteCancelStartFailLater(); });
  await expect(prompt).toHaveValue('Wait for the cancel');
  await expect(userMessages(page, 'Wait for the cancel')).toHaveCount(0);
});

test('a start whose reply timed out can still be stopped', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__remoteStartStep = 0; (window as any).__remoteStartAmbiguous = true; });
  await chooseStudioOnNewTask(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Lost start reply');
  await prompt.press('Enter');
  await expect(page.locator('#stream-region .turn-activity-label')).toContainText('Waiting for Studio iMac');
  await page.getByRole('button', { name: 'Stop task' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteCancelStarts?.length ?? 0)).toBe(1);
  await expect(prompt).toHaveValue('Lost start reply');
  await expect(page.getByRole('button', { name: 'Stop task' })).toHaveCount(0);
});

test('pending-approval and permission refusals show inline and keep the text', async ({ page }) => {
  test.slow(); // waits for the mirror's first run to end before sending
  await startMirror(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  const note = page.locator('#composer-area .composer-inline-note');
  await expect(page.getByRole('button', { name: 'Steer the running turn' })).toBeVisible();
  await page.evaluate(() => { (window as any).__remoteRefuse = 'This device can only view tasks on Studio iMac.'; });
  await prompt.fill('Steer without permission');
  await page.getByRole('button', { name: 'Steer the running turn' }).click();
  await expect(note).toContainText('can only view tasks on Studio iMac.');
  await expect(page.locator('#toast')).not.toContainText('can only view');
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0, { timeout: 15_000 });
  await page.evaluate(() => { (window as any).__remoteRefuse = 'Waiting for approval on Studio iMac.'; });
  await prompt.fill('Needs approval');
  await prompt.press('Enter');
  await expect(note).toContainText('Waiting for approval on Studio iMac.');
  await expect(prompt).toHaveValue('Needs approval');
  await expect(page.locator('#toast')).not.toContainText('Waiting for approval');
});
