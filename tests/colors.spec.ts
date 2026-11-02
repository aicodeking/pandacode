import { expect, test, type Page } from '@playwright/test';

// The preview stores imported themes in memory; Open VSX knows only Dracula.
const accent = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--accent').trim());
const token = (page: Page, name: string) => page.evaluate(name => getComputedStyle(document.documentElement).getPropertyValue(name).trim(), name);
const pin = (page: Page, scene: string) => page.addInitScript(scene => {
  if (sessionStorage.getItem('pinned') === scene) return;
  sessionStorage.setItem('pinned', scene);
  localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ enabled: true, visibility: 20, blur: 0, set: 'automatic', pinned: scene }));
}, scene);
async function openColors(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Appearance', exact: true }).click();
  await expect(page.locator('.vsix-list')).toHaveAttribute('aria-busy', 'false');
}

test('the accent follows the wallpaper scene and falls back to classic yellow without one', async ({ page }) => {
  await pin(page, 'wed-night');
  await page.goto('/');
  await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'wed-night', { timeout: 15000 });
  await expect.poll(() => accent(page)).not.toBe('#ffd43b');
  const night = await accent(page);
  await pin(page, 'mon-afternoon');
  await page.reload();
  await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-afternoon', { timeout: 15000 });
  await expect.poll(() => accent(page)).not.toBe(night);
  // Text on the accent stays readable whatever the scene.
  expect(await token(page, '--on-accent')).toMatch(/^#[0-9a-f]{6}$/);
  await openColors(page);
  await page.getByRole('radio', { name: 'Classic', exact: true }).click();
  await expect.poll(() => accent(page)).toBe('#ffd43b');
  await page.getByRole('radio', { name: 'Blue', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'Blue', exact: true })).toHaveAttribute('aria-checked', 'true');
  const blue = await accent(page);
  expect(blue).not.toBe('#ffd43b');
  await page.reload();
  await expect.poll(() => accent(page)).toBe(blue);
});

test('a VS Code theme from Open VSX recolors the app and holds still when the wallpaper changes', async ({ page }) => {
  await pin(page, 'wed-night');
  await page.goto('/');
  await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'wed-night', { timeout: 15000 });
  await openColors(page);
  const id = page.getByRole('textbox', { name: 'Open VSX extension ID' });
  await id.fill('nobody.nothing');
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('.vsix-status')).toContainText('Open VSX has no extension nobody.nothing');
  await id.fill('dracula-theme.theme-dracula');
  await page.getByRole('button', { name: 'Install', exact: true }).click();
  await expect(page.locator('.vsix-status')).toContainText('Using Dracula');
  await expect(page.locator('html')).toHaveAttribute('data-vsix', '');
  expect(await token(page, '--bg')).toBe('#282a36');
  expect(await token(page, '--text')).toBe('#f8f8f2');
  const dracula = await accent(page);
  await expect(page.getByRole('radio', { name: 'Wallpaper', exact: true })).toBeDisabled();
  await expect(page.locator('.colors-note')).toBeVisible();
  // Another scene, same colors.
  await pin(page, 'mon-afternoon');
  await page.reload();
  await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper', 'mon-afternoon', { timeout: 15000 });
  await page.waitForTimeout(300);
  expect(await accent(page)).toBe(dracula);
  expect(await token(page, '--bg')).toBe('#282a36');
  // Import from a file, then go back to PandaCode's own colors.
  await openColors(page);
  await page.getByRole('button', { name: 'Import .vsix…' }).click();
  await expect(page.locator('.vsix-status')).toContainText('Using Tokyo Night');
  expect(await token(page, '--bg')).toBe('#1a1b26');
  await page.getByRole('button', { name: 'Remove Tokyo Night' }).click();
  await expect(page.locator('.vsix-status')).toContainText('Theme removed');
  await expect(page.locator('html')).not.toHaveAttribute('data-vsix', '');
  await expect(page.getByRole('radio', { name: /PandaCode/ })).toHaveAttribute('aria-checked', 'true');
  await expect(page.getByRole('radio', { name: 'Wallpaper', exact: true })).toBeEnabled();
});

test('the light and dark toggle leaves a VS Code theme for PandaCode\'s own palette', async ({ page }) => {
  await page.goto('/');
  await openColors(page);
  await page.getByRole('radio', { name: /GitHub Light Default/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  expect(await token(page, '--accent')).toBe('#0969da');
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.locator('[data-action="toggle-theme"]').click();
  await expect(page.locator('#toast')).toContainText('GitHub Light Default turned off');
  await expect(page.locator('html')).not.toHaveAttribute('data-vsix', '');
});

for (const theme of ['dark', 'light'] as const) {
  test(`the selected task is a solid fill of the chosen accent over the native sidebar material in ${theme} mode`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(value => { localStorage.setItem('pandacode.theme', value); localStorage.setItem('pandacode.wallpapers', 'false'); }, theme);
    await page.goto('/');
    const card = page.locator('#navigation .task-item.selected');
    await card.waitFor();
    await page.evaluate(() => { document.documentElement.dataset.nativeMaterial = 'vibrancy'; });
    const fill = () => card.evaluate(el => {
      const style = getComputedStyle(el);
      return { image: style.backgroundImage, rgb: style.backgroundColor.replace(/^rgba?\((\d+), (\d+), (\d+).*$/, '$1 $2 $3'), accent: style.getPropertyValue('--accent-rgb').trim().replace(/\s+/g, ' ') };
    });
    await expect.poll(async () => { const value = await fill(); return value.image === 'none' && value.rgb === value.accent; }).toBe(true);
  });
}

test('workspace palette cards persist with accents, adapt to appearance, and restore after imported themes', async ({ page }) => {
  await page.goto('/');
  await openColors(page);
  const ocean = page.getByRole('radio', { name: 'Ocean', exact: true });
  await ocean.click();
  await expect(ocean).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('.settings-colors-summary')).toHaveText('Ocean palette');
  const dark = await token(page, '--bg');
  const oceanAccent = await accent(page);
  await page.screenshot({ path: 'playwright-report/palette-dark.png' });
  await page.reload();
  await expect.poll(() => token(page, '--bg')).toBe(dark);
  await expect.poll(() => accent(page)).toBe(oceanAccent);
  await openColors(page);
  await expect(ocean).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('button', { name: 'Use light', exact: true }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect.poll(() => token(page, '--bg')).not.toBe(dark);
  await expect(ocean).toHaveAttribute('aria-checked', 'true');
  const light = await token(page, '--bg');
  await page.screenshot({ path: 'playwright-report/palette-light.png' });
  await ocean.focus();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('radio', { name: 'Amethyst', exact: true })).toBeFocused();
  await expect(page.getByRole('radio', { name: 'Amethyst', exact: true })).toHaveAttribute('aria-checked', 'true');
  await ocean.click();
  await page.getByRole('radio', { name: /GitHub Light Default/ }).click();
  await expect(page.locator('html')).toHaveAttribute('data-vsix', '');
  await expect(ocean).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('radio', { name: /PandaCode/ }).click();
  await expect.poll(() => token(page, '--bg')).toBe(light);
  await expect(ocean).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('radio', { name: 'Classic', exact: true }).click();
  await expect.poll(() => accent(page)).toBe('#ffd43b');
  await page.setViewportSize({ width: 700, height: 900 });
  await page.screenshot({ path: 'playwright-report/palette-narrow.png' });
  await page.getByRole('radio', { name: 'System', exact: true }).click();
  await expect(page.getByRole('radio', { name: 'System', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect(await token(page, '--bg')).not.toBe(light);
});
