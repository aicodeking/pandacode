import { test, expect, type Page } from '@playwright/test';

async function open(page: Page, query = '') {
  await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); });
  await page.goto(`/${query}`);
  await expect(page.locator('#prompt')).toBeVisible();
}
async function manager(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Install local package' })).toBeVisible();
}
async function back(page: Page) { await page.getByRole('button', { name: 'Back to the workspace' }).click(); }
const action = (page: Page) => page.locator('[data-extension-contribution="sample.project-helper/header"]');

// One real installation is followed through its lifecycle; no fabricated pre-enabled seed.
// Each independently timed transition keeps the existing 20 s budget instead of placing
// repeated setup plus several full reloads into one oversized WebKit test.
test.describe.serial('extensions install lifecycle', () => {
let page: Page;
test.beforeAll(async ({ browser, baseURL }) => { page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 940 } }); });
test.afterAll(async () => { await page?.context().close(); });

test('extensions install: explicit install/enable and pointer/Enter/Space invoke once without replacing built-ins', async () => {
  await open(page);
  await page.locator('#prompt').fill('Preserved extension lifecycle draft');
  await page.evaluate(() => {
    (window as any).__extensionCore = { prompt: document.querySelector('#prompt'), sidebar: document.querySelector('#sidebar-toggle'), drag: document.querySelector('.workspace-header')?.getAttribute('data-tauri-drag-region') };
    (window as any).__extensionMessages = 0;
    new MutationObserver(records => {
      for (const record of records) if (record.type === 'childList' && (record.target as Element).id === 'toast' && record.target.textContent === 'Extension installed successfully') (window as any).__extensionMessages++;
    }).observe(document.querySelector('#toast')!, { childList: true });
  });
  await expect(action(page)).toHaveCount(0);
  await manager(page);
  await page.getByRole('button', { name: 'Install local package' }).click();
  await expect(page.getByText('1.0.0 · Local unsigned · Installed — disabled')).toBeVisible();
  await expect(action(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await back(page);
  await expect(action(page)).toBeVisible();
  await expect(action(page)).toHaveAccessibleName('Project helper');
  await expect(action(page)).toHaveAttribute('data-tauri-drag-region', 'false');
  await expect(action(page).locator('svg')).toHaveCount(1);
  await action(page).click();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionMessages)).toBe(1);
  await action(page).focus(); await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__extensionMessages)).toBe(2);
  await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__extensionMessages)).toBe(3);
  expect(await page.evaluate(() => {
    const core = (window as any).__extensionCore;
    return core.prompt === document.querySelector('#prompt') && core.sidebar === document.querySelector('#sidebar-toggle') && core.drag === document.querySelector('.workspace-header')?.getAttribute('data-tauri-drag-region');
  })).toBe(true);
  await expect(page.locator('#prompt')).toHaveValue('Preserved extension lifecycle draft');
});

test('extensions install: duplicate installation is rejected without changing the enabled control', async () => {
  await expect(action(page)).toHaveCount(1);
  await manager(page);
  await page.getByRole('button', { name: 'Install local package' }).click();
  await expect(page.getByRole('alert')).toContainText('Duplicate package ownership');
  await back(page); await expect(action(page)).toHaveCount(1);
});

test('extensions install: restart preserves enable and disable restores usable built-in controls', async () => {
  await expect(action(page)).toBeVisible();
  await page.reload(); await expect(action(page)).toBeVisible();
  await manager(page); await page.getByRole('button', { name: 'Disable sample.project-helper', exact: true }).click();
  await back(page); await expect(action(page)).toHaveCount(0);
  await page.locator('#sidebar-toggle').click(); await expect(page.locator('#sidebar-toggle')).toHaveAttribute('aria-expanded', 'false');
  await page.locator('#sidebar-toggle').click(); await expect(page.locator('#sidebar-toggle')).toHaveAttribute('aria-expanded', 'true');
  await page.reload(); await expect(action(page)).toHaveCount(0);
});

test('extensions install: protected recovery removes controls without deleting enabled preferences', async () => {
  await manager(page);
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch' }).click();
  await expect(page.getByText('Safe mode: packages are not loaded.', { exact: false })).toBeVisible();
  await expect(page.getByText('Safe mode: packages are not loaded.', { exact: false })).toBeFocused();
  await back(page); await expect(action(page)).toHaveCount(0);
  await page.reload(); await expect(action(page)).toBeVisible();
});

test('extensions install: safe-mode launch bypasses stored packages and normal restart restores preferences', async () => {
  await expect(action(page)).toBeVisible();
  await page.goto('/?safe-mode'); await expect(page.locator('#prompt')).toBeVisible(); await expect(action(page)).toHaveCount(0);
  await manager(page); await expect(page.getByRole('button', { name: 'Install local package' })).toBeDisabled();
  await page.goto('/'); await expect(action(page)).toBeVisible();
});
});

test('extensions install: corrupt stored package cannot prevent built-in startup', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.preview.extensions.v1', '{corrupt'));
  await open(page); await expect(action(page)).toHaveCount(0);
  await manager(page); await expect(page.getByText('Corrupt preview extension record; activation bypassed.')).toBeVisible();
  await back(page); await page.locator('#prompt').fill('Built-ins remain usable');
  await expect(page.locator('#prompt')).toHaveValue('Built-ins remain usable');
});
