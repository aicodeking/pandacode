import { expect, test, type Page } from '@playwright/test';

const dialog = (page: Page) => page.getByRole('dialog', { name: 'Import conversations', exact: true });
const row = (page: Page, title: string) => dialog(page).locator('.import-row', { hasText: title });
const calls = (page: Page, name: string): Promise<any[]> => page.evaluate(name => ((window as any).__importCalls ?? []).filter((call: any) => call.command === name), name);

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `(window.__importCalls ??= []).push({ command, args: structuredClone(args) }); switch (command) {`) });
  });
  await page.goto('/');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
});

test('imports selected Claude Code conversations into their projects and marks them as imported', async ({ page }) => {
  await page.getByRole('button', { name: 'Import conversations', exact: true }).click();
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByRole('button', { name: 'Claude Code' })).toHaveAttribute('aria-pressed', 'true');
  await expect(dialog(page).locator('.import-row')).toHaveCount(3);
  await expect(row(page, 'Fix login redirect loop')).toContainText('orbit · 24 messages');
  // A conversation whose folder is gone explains why and cannot be chosen.
  await expect(row(page, 'Old scratch experiment').getByRole('checkbox')).toBeDisabled();
  await expect(row(page, 'Old scratch experiment')).toContainText('folder no longer exists');
  const commit = dialog(page).locator('.import-commit');
  await expect(commit).toBeDisabled();
  await row(page, 'Fix login redirect loop').click();
  await row(page, 'Draft the pricing page copy').click();
  await expect(commit).toHaveText('Import 2 conversations');
  await commit.click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Imported 2 conversations');
  const request = (await calls(page, 'import_conversations'))[0].args;
  expect(request.provider).toBe('claude');
  expect(request.ids).toHaveLength(2);
  // Each lands in the project for its folder; a new folder becomes a project.
  await expect(page.locator('#navigation .task-item', { hasText: 'Fix login redirect loop' })).toHaveAttribute('title', /\norbit(\n|$)/);
  await expect(page.locator('#navigation .task-item', { hasText: 'Draft the pricing page copy' })).toHaveAttribute('title', /\nmarketing-site(\n|$)/);
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Fix login redirect loop');
  await expect(page.locator('#transcript')).toContainText('This conversation was imported into PandaCode.');

  await page.getByRole('button', { name: 'Import conversations', exact: true }).click();
  await expect(row(page, 'Fix login redirect loop').getByRole('checkbox')).toBeDisabled();
  await row(page, 'Draft the pricing page copy').getByRole('button', { name: 'In PandaCode' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Draft the pricing page copy');
});

test('searches, switches to Codex, and selects all importable conversations', async ({ page }) => {
  await page.getByRole('button', { name: 'Import conversations', exact: true }).click();
  await dialog(page).getByRole('searchbox', { name: 'Search conversations' }).fill('pricing');
  await expect(dialog(page).locator('.import-row')).toHaveCount(1);
  await dialog(page).getByRole('searchbox', { name: 'Search conversations' }).fill('');
  await expect(dialog(page).locator('.import-row')).toHaveCount(3);
  await dialog(page).getByRole('button', { name: 'Codex' }).click();
  await expect(dialog(page).locator('.import-row')).toHaveCount(1);
  await expect(row(page, 'Speed up the search index')).toContainText('pandacode');
  await dialog(page).getByRole('checkbox', { name: 'Select all shown conversations' }).check();
  await expect(dialog(page).locator('.import-commit')).toHaveText('Import 1 conversation');
  await dialog(page).locator('.import-commit').click();
  await expect(dialog(page)).toBeHidden();
  expect((await calls(page, 'import_conversations')).at(-1).args).toMatchObject({ provider: 'codex', ids: ['4c5d6e7f-8a9b-4c0d-9e1f-2a3b4c5d6e7f'] });
  await expect(page.locator('#navigation .task-item', { hasText: 'Speed up the search index' })).toHaveAttribute('title', /\npandacode(\n|$)/);
});

test('is reachable from Go to anything', async ({ page }) => {
  await page.locator('.search-trigger').click();
  await page.getByRole('textbox', { name: 'Search tasks and commands', exact: true }).fill('import');
  await page.locator('#command-results [data-action="import-conversations"]').click();
  await expect(dialog(page)).toBeVisible();
});
