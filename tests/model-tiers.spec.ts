import { expect, test, type Page } from '@playwright/test';

// Settings → Agent teams → Model routing → Rank models: the tier list Panda Router weighs most.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const group = (page: Page) => settings(page).getByRole('group', { name: 'Rank models', exact: true });
const row = (page: Page, name: string) => group(page).getByRole('group', { name, exact: true });
const chip = (page: Page, name: string) => group(page).locator('.tier-chip').filter({ hasText: name }).first();

async function install(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__tiers ??= { calls: [] }).calls.push({ command, args: structuredClone(args) });
      const failure = window.__tiersFail?.[command];
      if (failure) throw new Error(failure);
      const result = window.__tiersResult?.[command];
      if (result) return structuredClone(result);
      const delay = window.__tiersDelay?.[command];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__tiers.calls.filter((entry: any) => entry.command === command), command);
async function openTeams(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
  await expect(group(page)).toHaveAttribute('aria-busy', 'false');
}

test('Rank models renders the seeded tiers, the unranked tray and unrated markers', async ({ page }) => {
  await install(page);
  await openTeams(page);
  for (const tier of ['S', 'A', 'B', 'C', 'D']) await expect(row(page, `Tier ${tier}`)).toBeVisible();
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  await expect(row(page, 'Tier B').locator('.tier-name')).toHaveText(['DeepSeek V4 Pro']);
  // Claude Sonnet 5.5 runs on Command Code and Cline: one chip, two logos.
  await expect(chip(page, 'Claude Sonnet 5.5').locator('.tier-logo')).toHaveCount(2);
  await expect(row(page, 'Unranked').locator('.tier-chip').first()).toBeVisible();
  await expect(chip(page, 'DeepSeek V4 Flash Vision Exp')).toHaveAccessibleName(/, Unranked, unrated$/);
  await expect(chip(page, 'DeepSeek V4 Flash Vision Exp').locator('.tier-unrated')).toHaveAttribute('data-tip', /lets the router use it/);
  await expect(group(page).getByRole('img', { name: 'About ranking models' })).toHaveAttribute('data-tip', /a higher tier is usually tried first/);
});

test('dragging a chip to S saves the new tiers', async ({ page }) => {
  await install(page);
  await openTeams(page);
  const source = chip(page, 'Kimi K3');
  await expect(source).toBeVisible();
  await row(page, 'Tier S').scrollIntoViewIfNeeded();
  await row(page, 'Tier S').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const from = (await source.boundingBox())!, to = (await row(page, 'Tier S').boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 30, from.y, { steps: 3 });
  await page.mouse.move(to.x + to.width - 40, to.y + to.height / 2, { steps: 8 });
  await expect(page.locator('.tier-row[data-tier=S][data-drop]')).toHaveCount(1);
  await page.mouse.up();
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5', 'Kimi K3']);
  await expect.poll(async () => (await calls(page, 'model_routing_set_tiers')).at(-1)?.args).toEqual({ tiers: { 'claude-sonnet-5-5': 'S', 'deepseek-v4-pro': 'B', 'kimi-k3': 'S' } });
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await expect(group(page).locator('.tier-live')).toHaveText('Kimi K3 moved to tier S.');
});

test('the keyboard picks a chip up, moves it and drops it; Escape cancels', async ({ page }) => {
  await install(page);
  await openTeams(page);
  await chip(page, 'Claude Sonnet 5.5').focus();
  await page.keyboard.press('Enter');
  await expect(chip(page, 'Claude Sonnet 5.5')).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'Tier B').locator('.tier-name')).toHaveText(['DeepSeek V4 Pro', 'Claude Sonnet 5.5']);
  await expect(chip(page, 'Claude Sonnet 5.5')).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeVisible();
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  expect(await calls(page, 'model_routing_set_tiers')).toHaveLength(0);

  await chip(page, 'Claude Sonnet 5.5').focus();
  await page.keyboard.press('Space');
  await page.keyboard.press('c');
  await page.keyboard.press('Enter');
  await expect(row(page, 'Tier C').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  await expect(chip(page, 'Claude Sonnet 5.5')).toBeFocused();
  await expect.poll(async () => (await calls(page, 'model_routing_set_tiers')).at(-1)?.args).toEqual({ tiers: { 'claude-sonnet-5-5': 'C', 'deepseek-v4-pro': 'B' } });
  await expect(group(page).locator('.tier-live')).toHaveText('Claude Sonnet 5.5 moved to tier C.');

  // The Move to… menu does the same.
  await group(page).getByRole('button', { name: 'Move DeepSeek V4 Pro to…', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Unranked' }).click();
  await expect(row(page, 'Unranked').locator('.tier-chip').filter({ hasText: 'DeepSeek V4 Pro' })).toHaveCount(1);
  await expect.poll(async () => (await calls(page, 'model_routing_set_tiers')).at(-1)?.args).toEqual({ tiers: { 'claude-sonnet-5-5': 'C' } });
});

test('Reset clears every tier after a confirm, and a failed save reverts', async ({ page }) => {
  await install(page);
  await openTeams(page);
  await page.evaluate(() => { (window as any).__tiersFail = { model_routing_set_tiers: 'disk full' }; });
  await group(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await group(page).getByRole('button', { name: 'Clear tiers', exact: true }).click();
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  await expect(group(page).locator('.tier-live')).toHaveText('Your tiers could not be saved.');

  await page.evaluate(() => { (window as any).__tiersFail = {}; });
  await group(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await group(page).getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(row(page, 'Tier S').locator('.tier-chip')).toHaveCount(1);
  await group(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await group(page).getByRole('button', { name: 'Clear tiers', exact: true }).click();
  await expect(group(page).locator('.tier-row:not(.tier-unranked) .tier-chip')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'model_routing_set_tiers')).at(-1)?.args).toEqual({ tiers: {} });
  await expect(group(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
});

test('the controls stay disabled until the tiers load', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__tiersDelay = { model_routing_tiers: 1500 }; });
  await install(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
  await expect(group(page)).toHaveAttribute('aria-busy', 'true');
  await expect(group(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
  await expect(group(page).locator('.tier-chip')).toHaveCount(0);
  await expect(group(page)).toHaveAttribute('aria-busy', 'false');
  await expect(group(page).getByRole('button', { name: 'Reset', exact: true })).toBeEnabled();
  await expect(chip(page, 'Claude Sonnet 5.5')).toBeEnabled();
});

test('Rank models: a paused model has no chip until it is allowed again', async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__tiersResult = { model_health_list: [{ provider: 'commandcode', model: 'gpt-6-luna', reason: 'Provider error (test).', until: Date.now() + 600_000, failures: 2, providerDown: false }] };
  });
  await install(page);
  await openTeams(page);
  await expect(chip(page, 'Claude Sonnet 5.5')).toBeVisible();
  await expect(group(page).locator('.tier-chip').filter({ hasText: 'GPT-6 Luna' })).toHaveCount(0);
  const pools = await calls(page, 'model_routing_tier_models');
  expect(pools).toHaveLength(1);
  // Native drops `default` entries that resolve to no card, so only the paused model is left out here.
  expect(pools[0].args.pool.some((m: any) => m.provider === 'commandcode' && m.model === 'gpt-6-luna')).toBe(false);
  await page.evaluate(() => { (window as any).__tiersResult = {}; });
  await settings(page).getByRole('button', { name: /^Allow (GPT-6 Luna|gpt-6-luna) · Command Code now$/ }).click();
  await expect(chip(page, 'GPT-6 Luna')).toBeVisible();
});

test('Rank models: focus follows the chip after Move to and lands on a chip after Reset', async ({ page }) => {
  await install(page);
  await openTeams(page);
  await group(page).getByRole('button', { name: 'Move Kimi K3 to…', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Tier A' }).click();
  const moved = row(page, 'Tier A').getByRole('button', { name: 'Move Kimi K3 to…', exact: true });
  await expect(moved).toBeFocused();
  await page.keyboard.press('Enter');
  await page.getByRole('menuitemradio', { name: 'Tier D' }).click();
  await expect(row(page, 'Tier D').getByRole('button', { name: 'Move Kimi K3 to…', exact: true })).toBeFocused();

  await group(page).getByRole('button', { name: 'Reset', exact: true }).click();
  await group(page).getByRole('button', { name: 'Clear tiers', exact: true }).click();
  await expect(group(page).locator('.tier-chip').first()).toBeFocused();
  await expect(group(page).getByRole('button', { name: 'Reset', exact: true })).toBeDisabled();
});

test('Rank models: a failed load shows Retry, and Retry recovers', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__tiersFail = { model_routing_tiers: 'disk unreadable' }; });
  await install(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
  await expect(group(page).getByRole('alert')).toContainText('disk unreadable');
  await expect(group(page).getByText('Loading…')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__tiersFail = {}; });
  await group(page).getByRole('button', { name: 'Retry', exact: true }).click();
  await expect(group(page)).toHaveAttribute('aria-busy', 'false');
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  await expect(group(page).getByRole('alert')).toHaveCount(0);
});

test('dropping a chip on its own row sends no save', async ({ page }) => {
  await install(page);
  await openTeams(page);
  const source = chip(page, 'Claude Sonnet 5.5');
  await row(page, 'Tier S').evaluate(element => element.scrollIntoView({ block: 'start' }));
  const from = (await source.boundingBox())!;
  await page.mouse.move(from.x + 10, from.y + from.height / 2);
  await page.mouse.down();
  await page.mouse.move(from.x + 60, from.y + from.height / 2, { steps: 6 });
  await expect(page.locator('.tier-row[data-tier=S][data-drop]')).toHaveCount(1);
  await page.mouse.up();
  await expect(page.locator('[data-drop]')).toHaveCount(0);
  await expect(row(page, 'Tier S').locator('.tier-name')).toHaveText(['Claude Sonnet 5.5']);
  expect(await calls(page, 'model_routing_set_tiers')).toHaveLength(0);
  await expect(group(page).locator('.tier-live')).not.toHaveText(/moved/);
});

test('Add model… picks a limited harness and its added model joins the tray', async ({ page }) => {
  await install(page);
  await openTeams(page);
  await expect(chip(page, 'Nous Sample 3')).toHaveCount(0);
  const add = group(page).getByRole('button', { name: 'Add model…', exact: true });
  await add.click();
  await page.getByRole('menuitem', { name: /Hermes Agent/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Models for teams: Hermes Agent' });
  await expect(dialog.getByRole('searchbox')).toBeFocused();
  await dialog.getByRole('checkbox', { name: /Nous Sample 3$/ }).check();
  await dialog.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(add).toBeFocused();
  await expect(row(page, 'Unranked').locator('.tier-chip').filter({ hasText: 'Nous Sample 3' })).toHaveCount(1);
});
