import { expect, test, type Page } from '@playwright/test';

// The sidebar banner mirrors the header pill's prompt at the top of the sidebar. The preview
// seeds the updater with ?update=… (the browser never checks on its own), so each state is a
// fresh page load. About keeps its unsupported-preview text there, so a banner press asserts
// that Settings opens on the About section, not the row's unsupported state.
const banner = (page: Page) => page.locator('#sidebar-update-banner');
const open = (page: Page, update: string) => page.goto(`/?update=${update}`, { waitUntil: 'domcontentloaded' });

test('no banner while the updater is idle', async ({ page }) => {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
  await expect(banner(page)).toBeHidden();
});

test('a found update shows a dismissible banner between the name and the actions', async ({ page }) => {
  await open(page, 'available');
  await expect(banner(page)).toBeVisible();
  await expect(banner(page).locator('strong')).toHaveText('Update available');
  await expect(banner(page).locator('small')).toHaveText('PandaCode 0.4.0');
  await expect(banner(page).getByRole('button', { name: 'Dismiss update notice' })).toBeVisible();
  const top = await banner(page).evaluate(node => node.getBoundingClientRect().top);
  const brand = await page.locator('.brand').evaluate(node => node.getBoundingClientRect().bottom);
  const actions = await page.locator('.sidebar-actions').evaluate(node => node.getBoundingClientRect().top);
  expect(top).toBeGreaterThanOrEqual(brand);
  expect(top).toBeLessThan(actions);
  await banner(page).getByRole('button', { name: 'Dismiss update notice' }).click();
  await expect(banner(page)).toBeHidden();
});

test('downloading shows the progress percentage and no dismiss', async ({ page }) => {
  await open(page, 'downloading');
  await expect(banner(page).locator('strong')).toHaveText('Downloading update');
  await expect(banner(page).locator('small')).toHaveText('PandaCode 0.4.0 · 42%');
  await expect(banner(page).getByRole('button', { name: 'Dismiss update notice' })).toBeHidden();
});

test('pressing the banner opens Settings on the About section', async ({ page }) => {
  await open(page, 'ready');
  await expect(banner(page).locator('strong')).toHaveText('Restart to update');
  await expect(banner(page).locator('small')).toHaveText('PandaCode 0.4.0 is ready');
  await banner(page).locator('.sidebar-update-banner-body').click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await expect(settings).toBeVisible();
  await expect(settings.locator('.settings-about')).toBeVisible();
});
