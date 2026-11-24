import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Warm Claude spares: on by default, saved natively, read before warming Claude processes.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Warm Claude spares', exact: true });
const status = (page: Page) => settings(page).locator('.setting-row:has(#warm-spares) .setting-status');

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
  await expect(settings(page).getByText('Skips Claude Code’s cold start between turns (~0.17–1.71 s; Turn off agent telemetry already removes ~1.5 s of it for free). Keeps idle Claude Code processes ready (~218–255 MiB each on short sessions, the low end with agent telemetry off; more with long histories or extra MCP servers; up to 4); each starts your MCP servers, runs SessionStart hooks early and makes Claude Code’s startup requests. Lead spares serve only teams whose workers are all read-only, such as Council reviews. Branch switches and commits start fresh; an ordinary spare’s uncommitted git status can be up to 10 min old.')).toBeVisible();
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
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(settings(page).getByRole('alert')).toHaveText('Could not save the setting.');
  // The error replaces the launch totals on the status line.
  await expect(status(page)).toHaveText('Could not save the setting.');
  // The totals re-read after the save never cover the alert.
  await page.waitForTimeout(200);
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
  await expect(status(page)).toHaveText('This launch: 3 adopted, 1 not used, 1 cold · lead 1/1 adopted');
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
  await expect(status(page)).toHaveText('This launch: 3 adopted, 1 not used, 1 cold · lead 1/1 adopted');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
});
