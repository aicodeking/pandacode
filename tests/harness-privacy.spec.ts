import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Privacy: one switch for every harness's telemetry opt-outs.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const privacy = (page: Page) => settings(page).locator('#settings-panel-agents [data-embed="harnessPrivacy"]');
const toggle = (page: Page) => privacy(page).getByRole('checkbox', { name: 'Turn off agent telemetry', exact: true });
const row = (page: Page, provider: string) => privacy(page).locator(`li[data-provider="${provider}"]`);

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings(page).getByRole('heading', { name: 'Privacy', exact: true })).toBeVisible();
}

/** Makes the next `count` calls of `command` in the preview fail. */
async function failing(page: Page, command: string, count: number): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const body = source.replace(new RegExp(`case ["']${command}["']:`), `$& if ((window.__privacyFailures = (window.__privacyFailures ?? ${count}) - 1) >= 0) throw new Error('Preview failure');`);
    expect(body).not.toBe(source);
    await route.fulfill({ response, body });
  });
}

test('the telemetry switch saves, keeps focus and every agent row shows what it does', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(toggle(page)).toHaveAccessibleDescription(/Your agent config files are not changed/);
  await expect(row(page, 'claude').locator('em')).toHaveText('Vendor default');
  await expect(row(page, 'cline').locator('em')).toHaveText('Turn off in Cline');
  await expect(row(page, 'antigravity').locator('em')).toHaveText('No verified switch');

  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(toggle(page)).toBeChecked();
  await expect(toggle(page)).toBeFocused();
  await expect(row(page, 'claude').locator('em')).toHaveText('Turned off');
  await expect(row(page, 'codex')).toHaveAttribute('data-active', 'true');
  await expect(row(page, 'cline')).toHaveAttribute('data-active', 'false');
  await expect(privacy(page).getByRole('status')).toHaveText('Agents started from now on have telemetry turned off.');
  // Row details wrap instead of being cut off.
  const clipped = await row(page, 'claude').locator('small').evaluate(el => el.scrollWidth > el.clientWidth);
  expect(clipped).toBe(false);

  // The saved value survives leaving and reopening Settings.
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  await expect(privacy(page).getByRole('status')).toBeHidden();

  await toggle(page).uncheck();
  await expect(privacy(page).getByRole('status')).toHaveText('Agents started from now on use their own telemetry settings.');
  await expect(row(page, 'claude').locator('em')).toHaveText('Vendor default');
});

test('a failed save puts the switch back and offers a retry', async ({ page }) => {
  await failing(page, 'harness_privacy_set', 1);
  await page.goto('/');
  await openAgents(page);
  await toggle(page).click();
  await expect(privacy(page).getByRole('status')).toHaveText('Couldn’t save this setting.');
  // The button sits beside the live region, so it isn't announced with the message.
  await expect(privacy(page).getByRole('status').getByRole('button')).toHaveCount(0);
  await expect(toggle(page)).not.toBeChecked();
  await expect(row(page, 'claude').locator('em')).toHaveText('Vendor default');
  await privacy(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(toggle(page)).toBeChecked();
  await expect(row(page, 'claude').locator('em')).toHaveText('Turned off');
  await expect(privacy(page).getByRole('status')).toHaveText('Agents started from now on have telemetry turned off.');
});

test('a failed load offers a retry', async ({ page }) => {
  await failing(page, 'harness_privacy', 1);
  await page.goto('/');
  await openAgents(page);
  await expect(privacy(page).getByRole('status')).toHaveText('Agent telemetry settings couldn’t load.');
  await expect(toggle(page)).toBeDisabled();
  await privacy(page).getByRole('button', { name: 'Try again', exact: true }).click();
  await expect(toggle(page)).toBeEnabled();
  await expect(privacy(page).getByRole('status')).toBeHidden();
  await expect(row(page, 'codex')).toBeVisible();
});
