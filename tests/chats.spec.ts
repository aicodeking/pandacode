import { expect, test, type Page } from '@playwright/test';

const chats = (page: Page) => page.getByRole('region', { name: 'Chats', exact: true });

async function newChat(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(chats(page).locator('.task-item.selected')).toHaveCount(1);
}

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
});

test('a new chat lists under Chats, not projects, without project affordances', async ({ page }) => {
  await newChat(page);
  await expect(page.locator('.folder-group .task-item.selected')).toHaveCount(0);
  await expect(page.locator('.folder-heading', { hasText: 'Chat' })).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible();
  await expect(page.locator('#breadcrumb')).toHaveText('Chat');
  await expect(page.locator('#deploy-button')).toBeHidden();
  await expect(page.locator('#composer-area .composer-context')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'Ask anything…');

  // Leaving the chat brings the project affordances back.
  await page.locator('.folder-group .task-item').first().click();
  await expect(page.locator('#deploy-button')).toBeVisible();
});

test('deleting a chat removes it and its hidden project', async ({ page }) => {
  await newChat(page);
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete chat…', exact: true }).click();
  await page.getByRole('dialog', { name: 'Delete chat?', exact: true }).getByRole('button', { name: 'Delete chat', exact: true }).click();
  await expect(chats(page)).toHaveCount(0);
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
  await expect(chats(page)).toHaveCount(0);
  await expect(page.locator('.folder-group[aria-label="orbit tasks"] .task-item.selected')).toHaveCount(1);
});
