import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Local code explorer: on by default (Claude Code only; every other harness
// opts in with its own switch, stored as an app-data marker), saved natively, read at each run start.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const harness = (page: Page, name: string) => settings(page).getByRole('checkbox', { name: `Local code explorer for ${name}`, exact: true });
const toggle = (page: Page) => settings(page).getByRole('checkbox', { name: 'Local code explorer (pandacode_explore)', exact: true });

async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agents', exact: true }).click();
}

test('the local code explorer switch is on by default, names its harnesses and the deny-rule gap, and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(toggle(page)).toBeChecked();
  // The switch is not per harness: its hint (behind the title's mark) says on means Claude Code.
  await expect(settings(page).locator(`.info-mark[data-tip="Next run. On for Claude Code unless Claude read rules withhold it; opt-in harnesses below don’t parse harness deny rules."]`)).toHaveCount(1);

  await toggle(page).click();
  await expect(toggle(page)).not.toBeChecked();

  // Reopened, Settings reads the saved value back.
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await openAgents(page);
  await expect(toggle(page)).not.toBeChecked();
  await toggle(page).click();
  await expect(toggle(page)).toBeChecked();
});

test('an explorer switch that cannot be read shows no value and cannot be flipped', async ({ page }) => {
  await page.goto('/?explore-fail');
  await openAgents(page);
  await expect(toggle(page)).toBeDisabled();
  await expect(toggle(page)).not.toBeChecked();
  await expect(settings(page).getByText('Couldn’t read this setting.')).toBeVisible();
});

test('the explorer switch lists its harnesses: Claude Code on by default, each other one opts in and saves', async ({ page }) => {
  await page.goto('/');
  await openAgents(page);
  await expect(harness(page, 'Claude Code')).toBeChecked();
  await expect(harness(page, 'Claude Code')).toBeDisabled();
  for (const name of ['GLM', 'MiMo', 'Alibaba Token Plan', 'Codex', 'Kimi Code', 'OpenCode', 'Pi', 'Oh My Pi', 'Grok Build']) {
    await expect(harness(page, name)).toBeEnabled();
    await expect(harness(page, name)).not.toBeChecked();
  }
  // One line per row: the hint is behind the title's mark.
  const codexRow = settings(page).locator('.setting-row:has(#explore-codex)');
  await expect(codexRow.locator('.info-mark[data-tip="Off by default: not measured. Takes effect while the switch above is on."]')).toHaveCount(1);
  await expect(codexRow.locator('small')).toBeHidden();

  await harness(page, 'Codex').click();
  await expect(harness(page, 'Codex')).toBeChecked();
  await harness(page, 'Alibaba Token Plan').click();
  await expect(harness(page, 'Alibaba Token Plan')).toBeChecked();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await openAgents(page);
  await expect(harness(page, 'Codex')).toBeChecked();
  await expect(harness(page, 'Alibaba Token Plan')).toBeChecked();
  await expect(harness(page, 'GLM')).not.toBeChecked();
  await harness(page, 'Codex').click();
  await expect(harness(page, 'Codex')).not.toBeChecked();
  await harness(page, 'Alibaba Token Plan').click();
  await expect(harness(page, 'Alibaba Token Plan')).not.toBeChecked();
});

test('an unreadable harness’s explorer switch stays disabled and a refused save snaps back with the reason', async ({ page }) => {
  await page.goto('/?explore-harness-fail');
  await openAgents(page);
  await expect(harness(page, 'Codex')).toBeDisabled();
  await expect(harness(page, 'Codex')).not.toBeChecked();
  await expect(settings(page).locator('.setting-row:has(#explore-codex)').getByText('Couldn’t read this setting.')).toBeVisible();

  await harness(page, 'Kimi Code').click();
  await expect(harness(page, 'Kimi Code')).not.toBeChecked();
  await expect(settings(page).getByRole('alert').filter({ hasText: 'Could not save the setting: read-only file system' })).toBeVisible();
  await expect(harness(page, 'OpenCode')).toBeEnabled();
});
