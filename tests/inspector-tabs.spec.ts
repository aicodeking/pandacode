import { expect, test, type Page } from '@playwright/test';

// The inspector's slim tab strip: open views as tabs, a "+" menu for the rest,
// closable tabs, and the open list and selection kept across reloads.
const strip = (page: Page) => page.locator('#inspector .inspector-tabs');
const tab = (page: Page, view: string) => strip(page).locator(`.inspector-tab[data-view="${view}"]`);
const tabButton = (page: Page, view: string) => tab(page, view).locator('.inspector-tab-button');
const shownViews = (page: Page) => strip(page).locator('.inspector-tab:not([hidden])').evaluateAll(items => items.map(item => (item as HTMLElement).dataset.view));

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
  await expect(page.locator('#inspector')).toBeVisible();
}

async function addView(page: Page, label: string): Promise<void> {
  await page.locator('#inspector [data-action="inspector-add-tab"]').click();
  await page.getByRole('menu', { name: 'Open view' }).getByRole('menuitem', { name: label, exact: true }).click();
}

test('the inspector opens on a single Changes tab in a slim strip', async ({ page }) => {
  await open(page);
  expect(await shownViews(page)).toEqual(['changes']);
  await expect(tabButton(page, 'changes')).toHaveClass(/selected/);
  await expect(tabButton(page, 'changes')).toHaveAttribute('aria-current', 'true');
  await expect(tabButton(page, 'changes')).toHaveAccessibleName(/^Changes(, \d+ changed files?)?$/);
  await expect(tabButton(page, 'changes')).toContainText('Changes');
  await expect(page.locator('#changes-count')).toHaveText(/^\d+$/);
  await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  // The last tab cannot be closed, and the old heading row is gone.
  await expect(tab(page, 'changes').locator('.inspector-tab-close')).toBeHidden();
  await expect(page.locator('#inspector .inspector-heading')).toHaveCount(0);
  const stripBox = (await page.locator('#inspector .inspector-strip').boundingBox())!, headerBox = (await page.locator('.workspace-header').boundingBox())!;
  expect(Math.abs(stripBox.height - headerBox.height), 'level with the workspace header').toBeLessThan(2);
  // The content uses the panel's full width.
  const inspectorBox = (await page.locator('#inspector').boundingBox())!, contentBox = (await page.locator('#inspector-content').boundingBox())!;
  expect(contentBox.x - inspectorBox.x).toBeLessThanOrEqual(2);
  await expect(page.locator('#inspector-refresh')).toBeVisible();
});

test('the + menu lists closed views and opens one as a selected tab', async ({ page }) => {
  await open(page);
  const add = page.locator('#inspector [data-action="inspector-add-tab"]');
  await expect(add).toHaveAttribute('aria-haspopup', /.+/);
  await add.click();
  const menu = page.getByRole('menu', { name: 'Open view' });
  for (const name of ['Files', 'Search', 'Browser', 'Design']) await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Changes', exact: true })).toHaveCount(0);
  await expect(menu.getByRole('menuitem', { name: 'Pull request', exact: true })).toHaveCount(0);
  await menu.getByRole('menuitem', { name: 'Files', exact: true }).click();
  await expect(menu).toBeHidden();
  expect(await shownViews(page)).toEqual(['changes', 'files']);
  await expect(tabButton(page, 'files')).toHaveClass(/selected/);
  await expect(tabButton(page, 'changes')).not.toHaveClass(/selected/);
  await expect(page.locator('#inspector-content .file-row').first()).toBeVisible();
  await add.click();
  await expect(page.getByRole('menu', { name: 'Open view' }).getByRole('menuitem', { name: 'Files', exact: true })).toHaveCount(0);
});

test('tabs select on click, and closing the selected tab selects its neighbour', async ({ page }) => {
  await open(page);
  await addView(page, 'Files');
  await addView(page, 'Search');
  expect(await shownViews(page)).toEqual(['changes', 'files', 'search']);
  await tabButton(page, 'changes').click();
  await expect(tabButton(page, 'changes')).toHaveClass(/selected/);
  await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  // Closing an unselected tab keeps the selection.
  await tab(page, 'search').hover();
  const closeSearch = tab(page, 'search').getByRole('button', { name: 'Close Search' });
  await expect(closeSearch).toBeVisible();
  await closeSearch.click();
  expect(await shownViews(page)).toEqual(['changes', 'files']);
  await expect(tabButton(page, 'changes')).toHaveClass(/selected/);
  // Closing the selected tab hands the selection to its neighbour.
  await tabButton(page, 'files').click();
  await expect(tabButton(page, 'files')).toHaveClass(/selected/);
  await tab(page, 'files').getByRole('button', { name: 'Close Files' }).click();
  expect(await shownViews(page)).toEqual(['changes']);
  await expect(tabButton(page, 'changes')).toHaveClass(/selected/);
  await expect(tabButton(page, 'changes')).toBeFocused();
  await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  await expect(tab(page, 'changes').locator('.inspector-tab-close')).toBeHidden();
});

test('the open tabs and the selected tab survive a reload', async ({ page }) => {
  await open(page);
  await addView(page, 'Files');
  await addView(page, 'Search');
  await tabButton(page, 'files').click();
  await expect(tabButton(page, 'files')).toHaveClass(/selected/);
  await page.reload();
  await expect(page.locator('#inspector')).toBeVisible({ timeout: 20_000 });
  await expect.poll(() => shownViews(page)).toEqual(['changes', 'files', 'search']);
  await expect(tabButton(page, 'files')).toHaveClass(/selected/);
  await expect(page.locator('#inspector-content .file-row').first()).toBeVisible();
});

test('opening a view from elsewhere adds and selects its tab', async ({ page }) => {
  await open(page);
  await page.locator('#browser-toggle').click();
  await expect.poll(() => shownViews(page)).toEqual(['changes', 'browser']);
  await expect(tabButton(page, 'browser')).toHaveClass(/selected/);
  await expect(page.locator('#browser-panel')).toBeVisible();
  await expect(page.locator('#inspector-refresh')).toBeHidden();
  await tabButton(page, 'changes').click();
  await expect(page.locator('#browser-panel')).toBeHidden();
  await expect(page.locator('#inspector-refresh')).toBeVisible();
});
