import { expect, test, type Page } from '@playwright/test';

// The sidebar's per-row menus: a project's ⋯ button and a task or chat's right-click menu.
async function open(page: Page) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__removed ??= []);
      if (command === 'remove_project') window.__removed.push(args.projectId);
      switch (command) {
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}
const folder = (page: Page, name: string) => page.locator(`.folder-group[aria-label="${name} tasks"]`);
const chats = (page: Page) => page.getByRole('region', { name: 'Chats', exact: true });

test('task rows in a project lead with the harness and end with the age', async ({ page }) => {
  await open(page);
  const order = await folder(page, 'orbit').locator('.task-top').first().evaluate(line => [...line.children].map(child => child.getAttribute('class') ?? ''));
  expect(order[0]).toContain('task-provider');
  expect(order[1]).toContain('task-title');
  expect(order.at(-1)).toContain('task-age');
});

test('a project ⋯ menu offers its actions and removes it after confirming', async ({ page }) => {
  await open(page);
  const orbit = folder(page, 'orbit');
  const id = await orbit.getAttribute('data-project');
  await orbit.locator('.folder-row').hover();
  await orbit.getByRole('button', { name: 'Project actions for orbit', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Project actions', exact: true });
  for (const name of ['New task', 'Show only this project', 'Copy project path', 'Project settings', 'Remove project…']) {
    await expect(menu.getByRole('menuitem', { name, exact: true })).toBeVisible();
  }
  await menu.getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: 'Remove orbit?', exact: true });
  await expect(confirm).toContainText('The folder stays on disk');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(orbit).toHaveCount(1);

  await orbit.locator('.folder-row').hover();
  await orbit.getByRole('button', { name: 'Project actions for orbit', exact: true }).click();
  await page.getByRole('dialog', { name: 'Project actions', exact: true }).getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Remove orbit?', exact: true }).getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(orbit).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([id]);
});

test('right-clicking a chat deletes that chat', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const chat = chats(page).locator('.task-item').first();
  await expect(chat).toBeVisible();
  // Open another task so the menu acts on the clicked row, not the selected one.
  await folder(page, 'orbit').locator('.task-item').first().click();
  await chat.click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete chat…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete chat?', exact: true }).getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(chats(page)).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Chat deleted');
  await expect(folder(page, 'orbit').locator('.task-item.selected')).toHaveCount(1);
});
