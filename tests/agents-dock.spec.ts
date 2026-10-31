import { expect, test } from '@playwright/test';

test('running agents widget reveals active tasks and closes on selecting one', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
  const trigger = page.getByRole('button', { name: /Running agents/ });
  await expect(trigger).toBeVisible();
  await expect(trigger.locator('.agents-dock-count')).toHaveText('3');
  await trigger.hover();
  const popover = page.getByRole('dialog', { name: 'Running agents' });
  await expect(popover).toBeVisible();
  await expect(popover).toContainText('Polish the new onboarding');
  await expect(popover).toContainText('Build a responsive gallery');

  await popover.getByRole('button', { name: /Polish the new onboarding/ }).click();
  await expect(popover).toBeHidden();
});

test('Escape closes the header popover and returns focus to the trigger without reopening it', async ({ page }) => {
  await page.goto('/');
  const trigger = page.locator('.agents-dock-trigger');
  await expect(trigger).toHaveAttribute('aria-controls', 'agents-dock-popover');
  await expect(trigger).toHaveAttribute('aria-label', 'Running agents, 3 active');
  await expect(trigger.locator('.agents-dock-count')).toHaveAttribute('aria-hidden', 'true');
  await trigger.focus();
  const popover = page.locator('#agents-dock-popover');
  await expect(popover).toBeVisible();
  await page.keyboard.press('Tab');
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();
  await expect(trigger).toBeFocused();
  // The focus that came back must not schedule a reopen.
  await page.waitForTimeout(400);
  await expect(popover).toBeHidden();
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test('the working ring follows the trigger radius and the popover uses the shared glass radius', async ({ page }) => {
  await page.goto('/');
  const trigger = page.locator('.agents-dock-trigger');
  await expect(trigger).toHaveClass(/is-working/);
  const [button, ring] = await trigger.evaluate(el => [getComputedStyle(el).borderTopLeftRadius, getComputedStyle(el, '::after').borderTopLeftRadius]);
  expect(ring).toBe(button);
  await trigger.click();
  const radius = await page.locator('#agents-dock-popover').evaluate(el => getComputedStyle(el).borderTopLeftRadius);
  expect(radius).toBe(await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--glass-radius').trim()));
});

test('the pinned window is transparent, works from the keyboard and keeps focus across updates', async ({ page }) => {
  await page.goto('/agents-dock.html');
  const transparent = 'rgba(0, 0, 0, 0)';
  await expect(page.locator('html')).toHaveCSS('background-color', transparent);
  await expect(page.locator('body')).toHaveCSS('background-color', transparent);
  const orb = page.locator('.agents-dock-orb');
  await expect(orb).toHaveAttribute('aria-label', /Running agents, 3 active\. Press to expand\./);
  await expect(orb).not.toHaveAttribute('aria-label', /hover/i);
  await orb.focus();
  await page.keyboard.press('Enter');
  const panel = page.getByRole('dialog', { name: 'Running agents' });
  await expect(panel).toBeVisible();
  const first = panel.getByRole('button', { name: /Polish the new onboarding/ });
  await expect(first).toBeFocused();
  // A native change and the elapsed tick update rows in place: the focused row survives.
  const handle = await first.elementHandle();
  await page.evaluate(() => (window as any).__agentsDockPush());
  await page.waitForTimeout(1_100);
  expect(await handle!.evaluate(el => el.isConnected && document.activeElement === el)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(panel).toBeHidden();
  await expect(orb).toBeFocused();
  expect(await page.evaluate(() => (window as any).__agentsDockExpanded)).toBe(false);
});

test('toggling the widget setting with Space keeps focus on the switch', async ({ page }) => {
  await page.goto('/');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Running agents widget', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).not.toBeChecked();
  await expect(toggle).toBeEnabled();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space');
  await expect(toggle).toBeChecked();
  await expect(toggle).toBeFocused();
});
