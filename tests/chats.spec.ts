import { expect, test, type Page } from '@playwright/test';

// Keep the status/filter layout explicit; project-first navigation is covered by sidebar-projects.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { const key = 'pandacode.sidebar.sort'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), group: 'flat' })); });
});

// Chats list in Finished like any other task: the sidebar has only Active, Finished and Settled.
const chats = (page: Page) => page.getByRole('region', { name: 'Finished tasks', exact: true });

async function newChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(chats(page).locator('.task-item.selected')).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
});

test('a new chat lists under Finished, not a project folder, without project affordances', async ({ page }) => {
  await newChat(page);
  await expect(page.locator('.folder-heading', { hasText: 'Chat' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
  await expect(page.locator('#breadcrumb')).toHaveText('Chat');
  await expect(page.locator('#deploy-button')).toBeHidden();
  await expect(page.locator('#composer-area .composer-context')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'Ask anything…');

  // Leaving the chat brings the project affordances back.
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(page.locator('#deploy-button')).toBeVisible();
});

test('deleting a chat removes it and its hidden project', async ({ page }) => {
  await newChat(page);
  const id = await chats(page).locator('.task-item.selected').getAttribute('data-id');
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete task?', exact: true }).getByRole('button', { name: 'Delete task', exact: true }).click();
  await expect(page.locator(`#navigation .task-item[data-id="${id}"]`)).toHaveCount(0);
  // The project filter lists real projects only.
  await page.locator('#project-filter').click();
  await expect(page.getByRole('menuitemradio', { name: /orbit/ })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: /^Chat\b/ })).toHaveCount(0);
});

test('Go to anything starts a chat, and an empty chat can move to a project', async ({ page }) => {
  await page.keyboard.press(`${process.platform === 'darwin' ? 'Meta' : 'Control'}+k`);
  await page.getByRole('button', { name: 'New chat (no project)' }).click();
  await expect(chats(page).locator('.task-item.selected')).toHaveCount(1);

  await page.getByRole('button', { name: 'Move to project…' }).click();
  await page.getByRole('option', { name: /orbit/ }).click();
  await expect(page.locator('#breadcrumb')).not.toHaveText('Chat');
  await expect(chats(page).locator('.task-item.selected')).toHaveCount(1);
});
