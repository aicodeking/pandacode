import { expect, test, type Page } from '@playwright/test';

/* Scoped pairing on the preview's sample account (src/preview-remote.ts, src/preview-grants.ts):
 * approving or blocking a device that asks for access, the per-device access picker and the
 * one-time pairing code, in Settings and in the prompt shown outside it. */
async function openSignedIn(page: Page, waiting: string[] = []) {
  await page.addInitScript(ids => { (window as any).__pairingPending = ids; }, waiting);
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await expect(panel.locator('.remote-device[data-device="dev-studio"]')).toBeVisible();
  return panel;
}
const calls = (page: Page, name: string) => page.evaluate(key => (window as any)[key] ?? [], name);

test('a device that asks for access waits on top, shows its key and is approved with a chosen scope', async ({ page }) => {
  const panel = await openSignedIn(page, ['dev-laptop']);
  const rows = panel.locator('.remote-devices .remote-device');
  const laptop = panel.locator('.remote-device[data-device="dev-laptop"]');
  await expect(rows.first()).toHaveAttribute('data-device', 'dev-laptop');
  await expect(laptop).toHaveClass(/remote-pending/);
  await expect(laptop).toContainText('asks for access');
  await expect(laptop).toContainText('c4d8 1f3e 0a99 57b2');
  await expect(panel.locator('.remote-device[data-device="dev-studio"]').getByRole('combobox', { name: 'Access for Studio iMac' })).toHaveValue('full');
  // One line per row, however long the text.
  const box = await laptop.boundingBox();
  expect(box!.height).toBeLessThan(60);

  await laptop.getByRole('combobox', { name: 'Approve Old laptop as' }).selectOption('view');
  await laptop.getByRole('button', { name: 'Approve Old laptop' }).click();
  await expect(laptop).not.toHaveClass(/remote-pending/);
  await expect(laptop.getByRole('combobox', { name: 'Access for Old laptop' })).toHaveValue('view');
  await expect(laptop.getByRole('button', { name: 'Approve Old laptop' })).toHaveCount(0);
  expect((await calls(page, '__grantCalls')).at(-1)).toEqual({ deviceId: 'dev-laptop', scope: 'view' });
  await expect(rows.first()).not.toHaveAttribute('data-device', 'dev-laptop');
});

test('a waiting device can be blocked, and the picker changes any device afterwards', async ({ page }) => {
  const panel = await openSignedIn(page, ['dev-nas']);
  const nas = panel.locator('.remote-device[data-device="dev-nas"]');
  await nas.getByRole('button', { name: 'Block Home NAS' }).click();
  await expect(nas.getByRole('combobox', { name: 'Access for Home NAS' })).toHaveValue('blocked');
  expect((await calls(page, '__grantCalls')).at(-1)).toEqual({ deviceId: 'dev-nas', scope: 'blocked' });

  await nas.getByRole('combobox', { name: 'Access for Home NAS' }).selectOption('control');
  await expect.poll(async () => (await calls(page, '__grantCalls')).at(-1)).toEqual({ deviceId: 'dev-nas', scope: 'control' });
  await expect(nas.getByRole('combobox', { name: 'Access for Home NAS' })).toHaveValue('control');
  const options = await nas.getByRole('combobox', { name: 'Access for Home NAS' }).locator('option').allTextContents();
  expect(options).toEqual(['View only', 'Control', 'Full access', 'Blocked']);
});

test('this computer shows its key grouped, and every device has an access help mark', async ({ page }) => {
  const panel = await openSignedIn(page);
  await expect(panel.locator('.remote-key')).toHaveText('3fa9 1c07 d2b6 4e58');
  await expect(panel.getByRole('img', { name: 'About device access' })).toHaveAttribute('data-tip', /View only.*Control.*Full access.*Blocked/);
  await expect(panel.locator('.remote-pending')).toHaveCount(0);
});

test('the host shows a one-time pairing code for a chosen scope and can cancel it', async ({ page }) => {
  const panel = await openSignedIn(page);
  await expect(panel.getByRole('button', { name: 'Show pairing code' })).toHaveCount(0);
  await panel.getByRole('checkbox', { name: 'Allow remote control of this computer' }).check();
  await panel.getByRole('combobox', { name: 'Access the pairing code gives' }).selectOption('view');
  await panel.getByRole('button', { name: 'Show pairing code' }).click();
  await expect(panel.getByLabel('Pairing code', { exact: true })).toHaveText('428 917');
  await expect(panel.getByText(/Gives view only once\. Expires at/)).toBeVisible();
  expect(await calls(page, '__pairCodeCalls')).toEqual([{ scope: 'view' }]);
  await panel.getByRole('combobox', { name: 'Access the pairing code gives' }).focus();
  await panel.getByRole('button', { name: 'Cancel' }).click();
  await expect(panel.getByLabel('Pairing code', { exact: true })).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__pairCodeCancelled)).toBe(1);
});

test('entering the host’s code pairs this computer, and a wrong code is refused', async ({ page }) => {
  const panel = await openSignedIn(page);
  const input = panel.getByRole('textbox', { name: 'Pairing code from the other computer' });
  const pair = panel.getByRole('button', { name: 'Pair', exact: true });
  await expect(panel.getByRole('combobox', { name: 'Computer to pair with' })).toHaveValue('dev-studio');
  await input.fill('123456');
  await expect(input).toHaveValue('123 456');
  await pair.click();
  await expect(panel.getByRole('alert').filter({ hasText: 'not valid or has expired' })).toBeVisible();
  await expect(input).toHaveValue('123 456');

  await input.fill('428 917');
  await panel.getByRole('combobox', { name: 'Computer to pair with' }).selectOption('dev-nas');
  await pair.click();
  await expect(page.locator('#toast')).toHaveText('Paired with Home NAS: control');
  expect((await calls(page, '__pairRedeems')).at(-1)).toEqual({ deviceId: 'dev-nas', code: '428917' });
  await expect(input).toHaveValue('');
  await expect(panel.getByRole('alert')).toHaveCount(0);
});

test('typing a code survives a presence update', async ({ page }) => {
  const panel = await openSignedIn(page);
  const input = panel.getByRole('textbox', { name: 'Pairing code from the other computer' });
  await input.click();
  await page.keyboard.type('4289');
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  await expect(input).toBeFocused();
  await expect(input).toHaveValue('428 9');
  await page.keyboard.type('17');
  await expect(input).toHaveValue('428 917');
});

test('the diagnostics section is mounted from the diagnostics module', async ({ page }) => {
  const panel = await openSignedIn(page);
  await expect(panel.getByRole('heading', { name: 'Diagnostics' })).toBeVisible();
  await expect(panel.locator('.remote-diagnostics-body')).not.toBeEmpty();
});

async function mountPrompt(page: Page, failing = false) {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(async fail => {
    const path = '/src/remote-pairing-prompt.ts';
    const { mountPairingPrompt } = await import(/* @vite-ignore */ path);
    const fake: any = { handlers: {}, calls: [], notes: [] };
    (window as any).__fakeHost = fake;
    mountPairingPrompt({
      call: async (command: string, args: unknown) => { fake.calls.push([command, args]); if (fail) throw new Error('Could not save.'); return undefined; },
      listen: async (name: string, callback: (event: unknown) => void) => { fake.handlers[name] = callback; return () => undefined; },
      notify: (text: string) => fake.notes.push(text),
      openUrl: async () => undefined,
    });
  }, failing);
}
const fire = (page: Page, name: string, payload: unknown) => page.evaluate(([event, data]) => (window as any).__fakeHost.handlers[event as string](data), [name, payload] as const);

test('a first request shows a prompt with the grouped key; Approve sends the chosen scope', async ({ page }) => {
  await mountPrompt(page);
  await fire(page, 'remote://device-pending', { deviceId: 'phone', name: 'Pixel', fingerprint: '0123456789abcdef0123456789abcdef' });
  const prompt = page.locator('.pairing-prompt[data-device="phone"]');
  await expect(prompt).toContainText('Pixel wants access to this computer');
  await expect(prompt).toContainText('0123 4567 89ab cdef');
  await expect(prompt.getByRole('combobox', { name: 'Access for Pixel' })).toHaveValue('control');
  await prompt.getByRole('combobox', { name: 'Access for Pixel' }).selectOption('full');
  await prompt.getByRole('button', { name: 'Approve' }).click();
  await expect(prompt).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fakeHost.calls)).toEqual([['remote_set_device_grant', { deviceId: 'phone', scope: 'full' }]]);
});

test('the prompt can block, decide later, and goes away when Settings decided first', async ({ page }) => {
  await mountPrompt(page);
  await fire(page, 'remote://device-pending', { deviceId: 'a', name: 'Alpha', fingerprint: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa' });
  await fire(page, 'remote://device-pending', { deviceId: 'b', name: 'Beta', fingerprint: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb' });
  await fire(page, 'remote://device-pending', { deviceId: 'c', name: 'Gamma', fingerprint: 'cccccccccccccccccccccccccccccccc' });
  await expect(page.locator('.pairing-prompt')).toHaveCount(3);
  await page.locator('.pairing-prompt[data-device="a"]').getByRole('button', { name: 'Block' }).click();
  await expect(page.locator('.pairing-prompt[data-device="a"]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__fakeHost.calls)).toEqual([['remote_set_device_grant', { deviceId: 'a', scope: 'blocked' }]]);
  await page.locator('.pairing-prompt[data-device="b"]').getByRole('button', { name: 'Decide later' }).click();
  await expect(page.locator('.pairing-prompt[data-device="b"]')).toHaveCount(0);
  await fire(page, 'remote://device-grants', [{ deviceId: 'c', name: 'Gamma', platform: '', fingerprint: 'c', scope: 'view', online: true, requested: false }]);
  await expect(page.locator('.pairing-prompt')).toHaveCount(0);
});

test('a failed decision keeps the prompt and says why', async ({ page }) => {
  await mountPrompt(page, true);
  await fire(page, 'remote://device-pending', { deviceId: 'phone', name: 'Pixel', fingerprint: '0123456789abcdef0123456789abcdef' });
  const prompt = page.locator('.pairing-prompt[data-device="phone"]');
  await prompt.getByRole('button', { name: 'Approve' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__fakeHost.notes)).toEqual(['Could not save.']);
  await expect(prompt).toBeVisible();
  await expect(prompt.getByRole('button', { name: 'Approve' })).toBeEnabled();
});
