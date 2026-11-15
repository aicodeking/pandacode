import { expect, test, type Page } from '@playwright/test';

/** Opens Settings → Agents; `before` runs in the page first (to hold or fail the start-ahead calls). */
async function openAgents(page: Page, before?: () => void) {
  if (before) await page.addInitScript(before);
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeVisible();
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  return { settings, toggle: settings.getByRole('checkbox', { name: 'Start agents ahead', exact: true }) };
}

test('Start agents ahead switch saves through start_ahead_set', async ({ page }) => {
  const { toggle } = await openAgents(page);
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).__startAheadSaves)).toEqual([false]);
  await toggle.click();
  await expect(toggle).toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).__startAheadSaves)).toEqual([false, true]);
});

test('the switch assumes nothing until the saved value arrives', async ({ page }) => {
  const { toggle } = await openAgents(page, () => {
    const w = window as any;
    w.__startAheadGetHold = new Promise<void>(resolve => { w.__releaseStartAheadGet = resolve; });
  });
  await expect(toggle).toBeDisabled();
  await expect(toggle).not.toBeChecked();
  await page.evaluate(() => (window as any).__releaseStartAheadGet());
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeChecked();
});

test('a setting that cannot be read hides its switch and says so', async ({ page }) => {
  const { settings, toggle } = await openAgents(page, () => { (window as any).__startAheadFail = { get: 'Storage unavailable.' }; });
  await expect(settings.getByRole('alert')).toHaveText('Couldn’t read this setting. Close Settings and try again.');
  // An unchecked switch would read as "off"; there is no value to show.
  await expect(toggle).toBeHidden();
});

test('the hint names every moment an agent starts ahead', async ({ page }) => {
  const { settings } = await openAgents(page);
  await expect(settings.locator('.setting-row').filter({ has: page.locator('#start-ahead') })).toContainText('after a turn, when you pick a model, effort, permissions or harness, or when you start typing');
});

test('a failed save puts the switch back and shows the error', async ({ page }) => {
  const { settings, toggle } = await openAgents(page);
  await expect(toggle).toBeChecked();
  await page.evaluate(() => { (window as any).__startAheadFail = { set: 'Settings file is read-only.' }; });
  await toggle.click();
  await expect(settings.getByRole('alert')).toHaveText('Couldn’t save: Settings file is read-only.');
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeEnabled();
  // The next successful save clears the note.
  await page.evaluate(() => { (window as any).__startAheadFail = undefined; });
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect(settings.getByRole('alert')).toBeHidden();
});
