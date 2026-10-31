import { expect, test, type Page } from '@playwright/test';

/* Keyboard use of the GitHub view: every list moves with the arrow keys, and Enter opens the
 * row that holds the focus. Runs on the preview's sample GitHub (src/preview-github-hub.ts). */
const hub = (page: Page) => page.getByRole('region', { name: 'GitHub', exact: true });
const tab = (page: Page, name: RegExp) => hub(page).getByRole('tab', { name });

async function openHub(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'GitHub', exact: true }).click();
  await expect(hub(page)).toBeVisible();
}

test('GitHub runs move with the arrow keys, and Enter opens the run', async ({ page }) => {
  await openHub(page);
  await tab(page, /Actions/).click();
  const runs = hub(page).locator('.gh-run');
  await expect(runs.first()).toBeVisible();
  await runs.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(runs.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(runs.first()).toBeFocused();
  // Enter opens the run the focus is on, the same as its Details button.
  await page.keyboard.press('ArrowDown');
  const id = await runs.nth(1).getAttribute('data-gh-run');
  await page.keyboard.press('Enter');
  await expect(hub(page).locator(`#gh-run-${id}`)).toBeVisible();
});

test('GitHub pull requests move with the arrow keys', async ({ page }) => {
  await openHub(page);
  await tab(page, /Pull requests/).click();
  const rows = hub(page).locator('.gh-item');
  await expect(rows.first()).toBeVisible();
  await rows.first().focus();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(rows.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(rows.nth(1)).toBeFocused();
});
