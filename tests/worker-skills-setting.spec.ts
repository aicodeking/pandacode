import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Workers can use skills: on by default, saved natively, read at each worker run.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Workers can use skills', exact: true });

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
}

test('the worker skills switch is on by default, explains itself and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();
  await expect(settings(page).getByText('Applies to Claude Code, GLM, MiMo and Alibaba Token Plan team workers; off removes Skill next run.')).toBeVisible();

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

test('a refused save puts the worker skills switch back and says why', async ({ page }) => {
  await page.goto('/?worker-skills-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeEnabled();
  await expect(toggle(page)).toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
  await expect(page.getByText('Could not save the setting.')).toBeVisible();
});

test('a worker skills switch that cannot be read shows no value and cannot be flipped', async ({ page }) => {
  await page.goto('/?worker-skills-read-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).getByText('Couldn’t read this setting.').first()).toBeVisible();
});
