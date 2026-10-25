import { test, expect } from '@playwright/test';

// The language setting: system default, override, and reload into the chosen locale.
// See src/locales/GLOSSARY.md for the design.

const openGeneralSettings = async (page, settingsName = 'Settings', generalName = 'General') => {
  await page.getByRole('button', { name: settingsName, exact: true }).click();
  await page.getByRole('tab', { name: generalName }).click();
};

test('defaults to the system language (English in the test browser)', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
  await expect(page.locator('html')).toHaveAttribute('lang', 'en');
  await openGeneralSettings(page);
  await expect(page.getByRole('combobox', { name: 'Language' })).toHaveValue('auto');
  await expect(page.getByRole('combobox', { name: 'Language' })).toContainText('System default');
});

test('switching to 简体中文 reloads the workspace into Chinese and keeps the choice', async ({ page }) => {
  await page.goto('/');
  await openGeneralSettings(page);
  await page.getByRole('combobox', { name: 'Language' }).selectOption('zh-Hans');
  await page.waitForLoadState('load');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
  // The reload lands on the workspace, translated.
  await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  await openGeneralSettings(page, '设置', '通用');
  await expect(page.getByRole('combobox', { name: '语言' })).toHaveValue('zh-Hans');
  await expect(page.getByRole('combobox', { name: '语言' })).toContainText('跟随系统');
});

test('a seeded zh-Hant-HK preference boots with Traditional Chinese', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.language', 'zh-Hant-HK'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hant-HK');
  await page.getByRole('button', { name: '設定', exact: true }).click();
  await page.getByRole('tab', { name: '關於與更新' }).click();
  await expect(page.getByText('無遙測')).toBeVisible();
});

test.describe('auto mode follows the browser locale', () => {
  test.use({ locale: 'zh-CN' });
  test('zh-CN browser auto-detects Simplified Chinese', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'zh-Hans');
    await expect(page.getByRole('button', { name: '设置', exact: true })).toBeVisible();
  });
});

test.describe('auto mode follows en-GB locales', () => {
  test.use({ locale: 'en-GB' });
  test('British English browser respells the interface', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await page.getByRole('tab', { name: 'Appearance' }).click();
    await expect(page.getByRole('heading', { name: /Colours/ })).toBeVisible();
  });
});

test('an explicit en-GB override works from any system locale', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.language', 'en-GB'));
  await page.goto('/');
  await expect(page.locator('html')).toHaveAttribute('lang', 'en-GB');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Appearance' }).click();
  await expect(page.getByRole('heading', { name: /Colours/ })).toBeVisible();
});
