import { expect, test, type Page } from '@playwright/test';

// Settings → General lists each project's folders (the ?folders sample gives orbit three),
// and the project picker shows a count for projects with more than one folder.
async function openSettings(page: Page) {
  await page.goto('/?folders');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#projects-settings .project-row').first()).toBeVisible();
}
const orbit = (page: Page) => page.locator('#projects-settings [data-project="project-1"]');
const pandacode = (page: Page) => page.locator('#projects-settings [data-project="project-2"]');

test('folders render with the Primary mark on the primary', async ({ page }) => {
  await openSettings(page);
  await expect(orbit(page).locator('.project-folder')).toHaveCount(3);
  await expect(orbit(page).locator('.project-folder').first()).toContainText('/Users/you/Projects/orbit');
  await expect(orbit(page).locator('.project-folder').first().locator('.project-folder-mark')).toHaveText('Primary');
  await expect(orbit(page).locator('.project-folder').first().getByRole('button', { name: /^Set .* as primary/ })).toHaveCount(0);
  await expect(orbit(page).locator('.project-folder').nth(1)).toContainText('/Users/you/Projects/orbit-web');
  await expect(orbit(page).locator('.project-folder').nth(1).getByRole('button', { name: /^Set .* as primary/ })).toBeVisible();
  await expect(pandacode(page).locator('.project-folder')).toHaveCount(1);
  await expect(pandacode(page).locator('.project-folder').first().locator('.project-folder-mark')).toHaveText('Primary');
});

test('folders set as primary moves the Primary mark', async ({ page }) => {
  await openSettings(page);
  await orbit(page).locator('.project-folder').nth(1).getByRole('button', { name: /^Set .* as primary/ }).click();
  await expect(orbit(page).locator('.project-folder').nth(1).locator('.project-folder-mark')).toHaveText('Primary');
  await expect(orbit(page).locator('.project-folder').first().locator('.project-folder-mark')).toHaveCount(0);
  await expect(orbit(page).locator('.project-folder')).toHaveCount(3);
});

test('folders remove is refused for the last one with a toast', async ({ page }) => {
  await openSettings(page);
  await orbit(page).locator('.project-folder').last().getByRole('button', { name: 'Remove' }).click();
  await expect(orbit(page).locator('.project-folder')).toHaveCount(2);
  await pandacode(page).locator('.project-folder').getByRole('button', { name: 'Remove' }).click();
  await expect(page.locator('#toast')).toContainText('A project keeps at least one folder.');
  await expect(pandacode(page).locator('.project-folder')).toHaveCount(1);
  await expect(pandacode(page).locator('.project-folder').first()).toContainText('/Users/you/Projects/pandacode');
});

test('folders add picks a folder and appends it', async ({ page }) => {
  await openSettings(page);
  await orbit(page).getByRole('button', { name: 'Add a folder to orbit' }).click();
  await expect(orbit(page).locator('.project-folder')).toHaveCount(4);
  await expect(orbit(page).locator('.project-folder').last()).toContainText('/Users/you/Projects/new-project');
  await expect(orbit(page).locator('.project-folder').last().locator('.project-folder-mark')).toHaveCount(0);
  await orbit(page).getByRole('button', { name: 'Add a folder to orbit' }).click();
  await expect(page.locator('#toast')).toContainText('Folder already belongs to a project.');
  await expect(orbit(page).locator('.project-folder')).toHaveCount(4);
});

test('folders count shows beside the project in the picker', async ({ page }) => {
  await page.goto('/?folders');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
  await page.locator('#welcome-project').click();
  const menu = page.getByRole('dialog', { name: 'Choose project', exact: true });
  await expect(menu.getByRole('option', { name: /^orbit — 3 folders — / })).toBeVisible();
  const pandacodeOption = menu.getByRole('option', { name: /^pandacode — / });
  await expect(pandacodeOption).toBeVisible();
  await expect(pandacodeOption.locator('.project-menu-folders')).toHaveCount(0);
});
