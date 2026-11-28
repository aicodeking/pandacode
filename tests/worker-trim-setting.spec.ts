import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Trim worker tools: opt-in (off by default), saved natively, read at each worker run.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Trim worker tools', exact: true });

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
}

test('the worker trim switch is off by default, explains itself and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).getByText('Fewer tools for team workers; no measured saving yet.')).toBeVisible();

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

test('a refused save puts the worker trim switch back and says why', async ({ page }) => {
  await page.goto('/?worker-trim-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).not.toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();
  await expect(page.getByText('Could not save the setting.')).toBeVisible();
});

test('a worker trim switch that cannot be read shows no value and cannot be flipped', async ({ page }) => {
  await page.goto('/?worker-trim-read-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).getByText('Couldn’t read this setting.').first()).toBeVisible();
});
