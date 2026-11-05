import { expect, test, type Page } from '@playwright/test';

// Settings → General lists user projects; Remove asks first and calls the preview's remove_project.
async function open(page: Page) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__removed ??= []);
      if (command === 'remove_project') { if (window.__refuse) throw new Error('Stop this project\\'s agents first.'); window.__removed.push(args.projectId); }
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General', exact: true }).click();
  await expect(page.locator('#projects-settings .project-row').first()).toBeVisible();
}
const rows = (page: Page) => page.locator('#projects-settings .project-row');

test('cancel keeps the project, confirm removes it', async ({ page }) => {
  await open(page);
  const before = await rows(page).count();
  const first = rows(page).first();
  const id = await first.getAttribute('data-project');
  await first.getByRole('button', { name: /^Remove / }).click();
  await expect(first).toContainText('The folder stays on disk');
  await first.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows(page)).toHaveCount(before);
  await rows(page).first().getByRole('button', { name: /^Remove / }).click();
  await rows(page).first().getByRole('button', { name: 'Remove project' }).click();
  await expect(page.locator(`#projects-settings [data-project="${id}"]`)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([id]);
});

test('a native refusal is shown and the project stays', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).__refuse = true; });
  const before = await rows(page).count();
  await rows(page).first().getByRole('button', { name: /^Remove / }).click();
  await rows(page).first().getByRole('button', { name: 'Remove project' }).click();
  await expect(page.locator('#projects-settings [role="alert"]')).toContainText('Stop this project');
  await expect(rows(page)).toHaveCount(before);
});
