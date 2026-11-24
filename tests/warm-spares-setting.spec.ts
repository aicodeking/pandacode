import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Warm Claude spares: on by default, saved natively, read before warming Claude processes.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Warm Claude spares', exact: true });
const status = (page: Page) => settings(page).locator('.setting-row:has(#warm-spares) .setting-status');
const hint = (page: Page) => settings(page).locator('.setting-row:has(#warm-spares) .sr-only');
/** Lets every pending preview `invoke` settle: its promise chains resolve within a frame. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const TOTALS = 'This launch: 3/6 adopted, 1 not used, 2 expired, 1 cold · lead 1/1 adopted';

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
}

test('the warm spares switch is on by default, explains itself and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toHaveAttribute('id', 'warm-spares');
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();
  // The hint names each cost and limit; checked by phrase so rewording elsewhere stays free.
  await expect(hint(page)).toHaveCount(1);
  for (const disclosure of ['~0.17–1.71 s', 'Turn off agent telemetry', '~210–255 MiB', 'up to 4', 'MCP servers', 'SessionStart', 'all read-only', '10 min old']) {
    await expect(hint(page)).toContainText(disclosure);
  }
  // This launch's local totals sit on the row's status line, which is not an alert.
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');

  // Flipped from the keyboard (WebKit does not focus a clicked checkbox), it keeps focus after the save.
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(toggle(page)).not.toBeChecked();
  await expect(toggle(page)).toBeFocused();

  // Reopened, Settings reads the saved value back.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await openAgents(page);
  await expect(toggle(page)).not.toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
});

test('a refused save puts the warm spares switch back and says why', async ({ page }) => {
  await page.goto('/?warm-spares-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  // The re-read after the refused save now returns totals, so a re-read that covered the alert would show them.
  await page.evaluate(() => history.replaceState(history.state, '', '/?warm-spares-fail&warm-spares-stats'));
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(settings(page).getByRole('alert')).toHaveText('Could not save the setting.');
  // The error replaces the launch totals on the status line.
  await expect(status(page)).toHaveText('Could not save the setting.');
  // The totals re-read after the save never cover the alert: let it settle, then look again.
  await expect(toggle(page)).toBeEnabled();
  await settle(page);
  await expect(status(page)).toHaveText('Could not save the setting.');
  await expect(status(page)).toHaveAttribute('role', 'alert');
});

test('a warm spares switch that cannot be read shows no value and cannot be flipped', async ({ page }) => {
  await page.goto('/?warm-spares-read-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).locator('.setting-row:has(#warm-spares)').getByText('Couldn’t read this setting.', { exact: true })).toBeVisible();
  // The launch totals, read alongside, never cover the read error.
  await expect(status(page)).toHaveText('Couldn’t read this setting.');
});

test('the warm spares row shows this launch’s local adoption totals', async ({ page }) => {
  await page.goto('/?warm-spares-stats');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  // The ordinary pool first, the lead pool on its own: a lead spare is never summed into ordinary misses.
  await expect(status(page)).toHaveText(TOTALS);
  await expect(status(page)).toBeVisible();
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
});

test('flipping the warm spares switch re-reads this launch’s totals', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  // The preview reads `?warm-spares-stats` on every call, so new totals appear only if the row re-reads them.
  await page.evaluate(() => history.replaceState(history.state, '', '/?warm-spares-stats'));
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(status(page)).toHaveText(TOTALS);
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
});

test('warm spares that all expired unused, with warming paused, show as waste rather than zero', async ({ page }) => {
  await page.goto('/?warm-spares-stats-expired');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  await expect(status(page)).toHaveText('This launch: 0/6 adopted, 6 expired, 2 paused');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
});
