import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const sample = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const items = JSON.parse(readFileSync(new URL('./fixtures/extensions/menus-v1.json', import.meta.url), 'utf8'));

const trigger = (page: Page) => page.locator('[data-extension-contribution="sample.project-helper/header"]');
async function setup(page: Page, { missing = false, rtl = false, sidebar = false, width = 540, fullList = false } = {}) {
  const manifest = structuredClone(sample) as any;
  manifest.contributes.menus = [{ ...manifest.contributes.menus[0], items: structuredClone(items) }];
  if (sidebar) manifest.contributes.menus[0].location = 'panda.sidebar.footer';
  if (fullList) manifest.contributes.menus[0].items = Array.from({ length: 128 }, (_, n) => ({ id: `sample.project-helper/item-${n}`, kind: 'command', title: `Option ${n + 1}`, command: 'sample.project-helper/hello' }));
  if (missing) {
    manifest.contributes.icons.push({ id: 'sample.project-helper/missing', asset: 'assets/missing.svg' });
    manifest.contributes.menus[0].items[1].items[0].items[1].icon = 'sample.project-helper/missing';
  }
  await page.addInitScript(({ manifest }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
  }, { manifest, rtl });
  await page.setViewportSize({ width, height: 680 });
  await page.goto('/');
  await expect(trigger(page)).toBeVisible();
  if (rtl) await page.evaluate(() => { document.documentElement.dir = 'rtl'; });
  await page.evaluate(() => {
    (window as any).__menuActions = 0;
    new MutationObserver(records => {
      for (const record of records) if (record.target === document.querySelector('#toast') && record.type === 'childList' && record.target.textContent === 'Extension installed successfully') (window as any).__menuActions++;
    }).observe(document.querySelector('#toast')!, { childList: true });
  });
}
async function deepest(page: Page, rtl = false) {
  await trigger(page).click();
  await expect(page.getByRole('menuitem', { name: 'Reports', exact: true })).toBeFocused();
  await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Formats', exact: true })).toBeFocused();
  await page.keyboard.press(rtl ? 'ArrowLeft' : 'ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Summary', exact: true })).toBeFocused();
}
async function bounded(page: Page) {
  const rects = await page.locator('.choice-menu').evaluateAll(panels => panels.map(panel => {
    const rect = panel.getBoundingClientRect(); return { x: rect.x, y: rect.y, right: rect.right, bottom: rect.bottom };
  }));
  expect(rects).toHaveLength(3);
  const viewport = page.viewportSize()!;
  for (const rect of rects) { expect(rect.x).toBeGreaterThanOrEqual(11); expect(rect.y).toBeGreaterThanOrEqual(11); expect(rect.right).toBeLessThanOrEqual(viewport.width - 11); expect(rect.bottom).toBeLessThanOrEqual(viewport.height - 11); }
}

test('extensions menus: three levels preserve Arrow/Home/End/Enter/Escape and checkbox/radio state in a narrow viewport', async ({ page }) => {
  await setup(page); await deepest(page); await bounded(page);
  await expect(page.getByRole('menuitem', { name: 'Unavailable', exact: true })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: 'Empty', exact: true })).toHaveCount(0);
  await expect(page.getByRole('separator')).toHaveCount(1);
  for (const label of ['Reports', 'Formats', 'Summary']) await expect(page.getByRole('menuitem', { name: label, exact: true }).locator('svg[aria-hidden="true"]')).not.toHaveCount(0);
  await page.keyboard.press('End'); await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitem', { name: 'Summary', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowUp'); await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toBeFocused();
  await page.keyboard.press('Home'); await expect(page.getByRole('menuitem', { name: 'Summary', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown'); await expect(page.getByRole('menuitemcheckbox', { name: 'Include details' })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(1);
  await deepest(page); await expect(page.getByRole('menuitemcheckbox', { name: 'Include details' })).toHaveAttribute('aria-checked', 'false');
  await page.keyboard.press('End'); await page.keyboard.press('Space');
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(2);
  await deepest(page);
  await expect(page.getByRole('menuitemradio', { name: 'Brief', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowLeft'); await expect(page.getByRole('menuitem', { name: 'Formats', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem', { name: 'Reports', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
  await expect(page.locator('.choice-menu')).toHaveCount(0);
});

test('extensions menus: pointer crosses submenu gaps and invokes exactly once on the sidebar surface', async ({ page }) => {
  await setup(page, { sidebar: true });
  const open = async () => {
    await trigger(page).click();
    await page.getByRole('menuitem', { name: 'Reports', exact: true }).hover();
    await expect(page.getByRole('menuitem', { name: 'Formats', exact: true })).toBeVisible();
    await page.getByRole('menuitem', { name: 'Formats', exact: true }).hover();
    await expect(page.getByRole('menuitem', { name: 'Summary', exact: true })).toBeVisible();
  };
  await open();
  await bounded(page);
  await page.getByRole('menuitem', { name: 'Summary', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(1);
  await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await open(); await page.getByRole('menuitemcheckbox', { name: 'Include details' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(2);
  await open(); await expect(page.getByRole('menuitemcheckbox', { name: 'Include details' })).toHaveAttribute('aria-checked', 'false');
  await page.getByRole('menuitemradio', { name: 'Full', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(3);
  await open();
  await expect(page.getByRole('menuitemradio', { name: 'Brief', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { name: 'Full', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await expect(trigger(page)).toBeFocused();
});

test('extensions menus: RTL arrows mirror direction and Escape closes only one level', async ({ page }) => {
  await setup(page, { rtl: true }); await deepest(page, true); await bounded(page);
  await page.keyboard.press('Escape'); await expect(page.locator('.choice-menu')).toHaveCount(2);
  await expect(page.getByRole('menuitem', { name: 'Formats', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight'); await expect(page.locator('.choice-menu')).toHaveCount(1);
  await page.keyboard.press('Escape'); await expect(trigger(page)).toBeFocused();
});

test('extensions menus: every item at the accepted 128-item limit remains keyboard reachable', async ({ page }) => {
  await setup(page, { fullList: true });
  await trigger(page).click();
  await expect(page.getByRole('menuitem')).toHaveCount(128);
  await page.keyboard.press('End'); await expect(page.getByRole('menuitem', { name: 'Option 128', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__menuActions)).toBe(1);
  await expect(trigger(page)).toBeFocused();
});

test('extensions menus: 320px reduced-motion tree toggles closed, ignores IME Escape and lets Tab leave', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await setup(page, { width: 320 }); await deepest(page); await bounded(page);
  await page.evaluate(() => { document.activeElement?.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', isComposing: true, bubbles: true })); });
  await expect(page.locator('.choice-menu')).toHaveCount(3);
  await trigger(page).click(); await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await deepest(page); await page.keyboard.press('Tab');
  await expect(page.locator('.choice-menu')).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body)).toBe(true);
  expect(await page.evaluate(() => (window as any).__menuActions)).toBe(0);
});

test('extensions menus: missing assets fall back; unload closes submenus and detaches stale callbacks', async ({ page }) => {
  await setup(page, { missing: true }); await deepest(page);
  const summary = page.getByRole('menuitem', { name: 'Summary', exact: true });
  await expect(summary.locator('svg[data-extension-icon-fallback="true"][aria-hidden="true"]')).toHaveCount(1);
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'sample.project-helper/summary: missing icon asset' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await deepest(page);
  await page.evaluate(() => { (window as any).__staleMenuItem = document.querySelector('[aria-label="Summary"]'); });
  // Preview-only transport injection calls the actual manager/disposal path.
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.project-helper'); });
  await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(trigger(page)).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body)).toBe(true);
  await page.evaluate(() => { (window as any).__staleMenuItem.click(); });
  expect(await page.evaluate(() => (window as any).__menuActions)).toBe(0);
  await expect(page.locator('#prompt')).toBeEnabled();
});
