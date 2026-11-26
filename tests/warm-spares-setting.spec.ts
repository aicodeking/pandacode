import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Warm Claude spares: off by default (opt-in), saved natively, read before warming Claude processes.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Warm Claude spares', exact: true });
const status = (page: Page) => settings(page).locator('.setting-row:has(#warm-spares) .setting-status');
const hint = (page: Page) => settings(page).locator('.setting-row:has(#warm-spares) .sr-only');
/** Lets an answered preview `invoke` reach its caller: its promise chain resolves within a frame. */
const settle = (page: Page) => page.evaluate(() => new Promise<void>(done => requestAnimationFrame(() => requestAnimationFrame(() => done()))));
const TOTALS = 'This launch: 3/7 adopted, 1 idle now, 1 not used, 2 expired, 1 replaced, 1 cold · lead 1/1 adopted';
/** How many `warm_spare_stats` reads the preview has answered since the page loaded. */
const statsReads = (page: Page) => page.locator('html');

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
}

test('the warm spares switch is off by default, explains itself and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toHaveAttribute('id', 'warm-spares');
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  // The hint names each cost and limit; checked by phrase so rewording elsewhere stays free.
  await expect(hint(page)).toHaveCount(1);
  for (const disclosure of [
    'Off by default', 'up to 4 pooled', '~195–255 MiB', '~0.38–0.62 s', 'signed-in', 'Anthropic or your configured Claude endpoint', 'MCP',
    'SessionStart', 'git status', 'low memory', 'backs off',
  ]) {
    await expect(hint(page)).toContainText(disclosure);
  }
  // The full limits are a real link on the row, not a repository path in the tooltip.
  await expect(hint(page)).not.toContainText('docs/worker-tokens.md');
  const docs = settings(page).locator('.setting-row:has(#warm-spares)').getByRole('button', { name: 'Warm Claude spares limits and trade-offs', exact: true });
  await expect(docs).toBeVisible();
  await expect(docs).toHaveAttribute('data-action', 'open-url');
  await expect(docs).toHaveAttribute('data-url', 'https://github.com/aicodeking/pandacode/blob/main/docs/worker-tokens.md#turn-speed-cached-instructions-and-warm-spares');
  // This launch's local totals sit on the row's status line, which is not an alert.
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');

  // Flipped from the keyboard (WebKit does not focus a clicked checkbox), it keeps focus after the save.
  await toggle(page).focus();
  await page.keyboard.press('Space');
  await expect(toggle(page)).toBeChecked();
  await expect(toggle(page)).toBeFocused();

  // Reopened, Settings reads the saved value back.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
});

test('warm spares memory-guard skips show in this launch’s totals even when no spare started', async ({ page }) => {
  await page.goto('/?warm-spares-stats-low-memory');
  await openAgents(page);
  await expect(status(page)).toHaveText('This launch: 2 skipped (low memory)');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
});

test('a refused save puts the warm spares switch back and says why', async ({ page }) => {
  await page.goto('/?warm-spares-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  await expect(statsReads(page)).toHaveAttribute('data-preview-warm-stats-reads', '1');
  // The re-read after the refused save now returns totals, late, after the alert is up, so a
  // re-read that covered the alert would show them.
  await page.evaluate(() => history.replaceState(history.state, '', '/?warm-spares-fail&warm-spares-stats&warm-spares-stats-delayed'));
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).getByRole('alert')).toHaveText('Could not save the setting.');
  // The error replaces the launch totals on the status line.
  await expect(status(page)).toHaveText('Could not save the setting.');
  // The delayed totals re-read after the save never covers the alert: wait until the preview has
  // answered it and its result has reached the row, then look again.
  await expect(toggle(page)).toBeEnabled();
  await expect(statsReads(page)).toHaveAttribute('data-preview-warm-stats-reads', '2');
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
  await page.goto('/?warm-spares-on&warm-spares-stats');
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
  await expect(toggle(page)).not.toBeChecked();
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  // The preview reads `?warm-spares-stats` on every call, so new totals appear only if the row re-reads them.
  await page.evaluate(() => history.replaceState(history.state, '', '/?warm-spares-stats'));
  await expect(status(page)).toHaveText('This launch: no spares started yet.');
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(status(page)).toHaveText(TOTALS);
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
});

test('warm spares that all expired unused, with warming paused, show as waste and the time left in the pause', async ({ page }) => {
  await page.goto('/?warm-spares-on&warm-spares-stats-expired');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  // Live pause time follows adoption; starts the pause skipped are a separate, historical count.
  await expect(status(page)).toHaveText('This launch: 0/6 adopted, paused (29 min left), 6 expired, 2 starts paused');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
});

test('the open warm spares row re-reads this launch’s totals live and stops when Settings closes', async ({ page }) => {
  await page.goto('/?warm-spares-on&warm-spares-stats-expired&warm-spares-refresh-ms=80');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  await expect(status(page)).toHaveText('This launch: 0/6 adopted, paused (29 min left), 6 expired, 2 starts paused');
  // New totals reach the row with no click and no reopening.
  await page.evaluate(() => history.replaceState(history.state, '', '/?warm-spares-on&warm-spares-stats&warm-spares-refresh-ms=80'));
  await expect(status(page)).toHaveText(TOTALS);
  expect(Number(await statsReads(page).getAttribute('data-preview-warm-stats-reads'))).toBeGreaterThan(1);
  // Closed, Settings leaves no timer behind: the read count holds still across several periods.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  const closedAt = await statsReads(page).getAttribute('data-preview-warm-stats-reads');
  await page.waitForTimeout(400);
  await expect(statsReads(page)).toHaveAttribute('data-preview-warm-stats-reads', closedAt!);
});

test('turning warm spares off hides the live pause but keeps this launch’s historical totals', async ({ page }) => {
  await page.goto('/?warm-spares-on&warm-spares-stats-expired');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  await expect(status(page)).toHaveText('This launch: 0/6 adopted, paused (29 min left), 6 expired, 2 starts paused');
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  // A pause is moot with warming off, so "29 min left" would mislead; the starts it skipped stay counted.
  await expect(status(page)).toHaveText('This launch: 0/6 adopted, 6 expired, 2 starts paused');
  await expect(status(page)).not.toHaveAttribute('role', 'alert');
});
