import { expect, test, type Page } from '@playwright/test';

// The inspector's VS Code-style icon bar, its Files default and the Search view
// (file-name matches plus find-in-files) against the browser preview backend.
const tab = (page: Page, action: string) => page.locator(`.inspector-tabs [data-action="${action}"]`);
const searchInput = (page: Page) => page.getByRole('searchbox', { name: 'Search in files' });
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__searchCalls ?? []).filter((entry: any) => entry.command === command), command);

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `(window.__searchCalls ??= []).push({ command, args: structuredClone(args) });\n      switch (command) {`) });
  });
  await page.goto('/');
  // Cold dev servers can take a few seconds to compile the first page.
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
}

test('the panel opens on Files with an icon bar of labelled views', async ({ page }) => {
  await open(page);
  await expect(page.locator('#inspector')).toBeVisible();
  await expect(tab(page, 'tab-files')).toHaveClass(/selected/);
  await expect(page.locator('#inspector-title')).toHaveText('Files');
  await expect(page.locator('#inspector-content .file-row').first()).toBeVisible();
  for (const name of ['Files', 'Search', 'Browser']) await expect(page.locator('.inspector-tabs').getByRole('button', { name, exact: true })).toBeVisible();
  // The change count is part of the Changes button's name.
  await expect(tab(page, 'tab-changes')).toHaveAccessibleName(/^Changes, \d+ changed files?$/);
  await expect(tab(page, 'tab-files')).toHaveAttribute('aria-current', 'true');
  await tab(page, 'tab-changes').click();
  await expect(page.locator('#inspector-title')).toHaveText('Changes');
  await expect(tab(page, 'tab-changes')).toHaveClass(/selected/);
  await expect(tab(page, 'tab-files')).not.toHaveClass(/selected/);
});

test('the icon bar runs along the top of the panel, level with the workspace header', async ({ page }) => {
  await open(page);
  const bar = await page.locator('.inspector-tabs').boundingBox();
  const panel = await page.locator('#inspector').boundingBox();
  const header = await page.locator('.workspace-header').boundingBox();
  const title = await page.locator('#inspector-title').boundingBox();
  const buttons = await page.locator('.inspector-tabs > button:visible').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().top));
  expect(buttons.length).toBeGreaterThan(2);
  expect(Math.max(...buttons) - Math.min(...buttons), 'one row of views').toBeLessThan(1);
  expect(Math.abs(bar!.y - panel!.y), 'at the top of the panel').toBeLessThan(2);
  expect(Math.abs(bar!.height - header!.height), 'as tall as the header beside it').toBeLessThan(2);
  expect(bar!.width, 'across the panel').toBeGreaterThan(panel!.width - 4);
  expect(title!.y, 'the view title sits under the bar').toBeGreaterThanOrEqual(bar!.y + bar!.height - 1);
});

test('search lists matching file names and highlighted text matches grouped by file', async ({ page }) => {
  await open(page);
  await tab(page, 'tab-search').click();
  await expect(page.locator('#inspector-title')).toHaveText('Search');
  await expect(searchInput(page)).toBeFocused();
  await searchInput(page).pressSequentially('search');
  const files = page.getByRole('region', { name: 'Matching file names' });
  await expect(files.locator('.search-file')).toContainText(['search.test.ts', 'search.ts', 'search-index.ts']);
  const text = page.getByRole('region', { name: 'Text matches' });
  await expect(text.locator('.search-summary')).toContainText(/\d+ results in \d+ files/);
  await expect(text.locator('.search-line mark').first()).toHaveText(/search/i);
  // Only the settled query reaches the backend after typing pauses.
  await expect.poll(async () => (await calls(page, 'search_text')).map(call => call.args.query)).toEqual(['search']);
  // Groups collapse and expand.
  const group = text.locator('.search-group-title').first();
  const lines = text.locator('.search-group').first().locator('.search-line');
  await expect(lines.first()).toBeVisible();
  await group.click();
  await expect(group).toHaveAttribute('aria-expanded', 'false');
  await expect(lines).toHaveCount(0);
  await group.click();
  await expect(lines.first()).toBeVisible();
});

test('toggles reach the backend, invalid regex is reported, and opening a match returns to the search', async ({ page }) => {
  await open(page);
  await tab(page, 'tab-search').click();
  await searchInput(page).fill('Search');
  await page.getByRole('button', { name: 'Match case' }).click();
  await expect(page.getByRole('button', { name: 'Match case' })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(async () => (await calls(page, 'search_text')).at(-1)?.args).toMatchObject({ query: 'Search', matchCase: true, wholeWord: false, regex: false });
  await page.getByRole('button', { name: 'Use regular expression' }).click();
  await searchInput(page).fill('(unclosed');
  await expect(page.locator('.search-error')).toContainText('Invalid regular expression');
  await searchInput(page).fill('createSearchIndex');
  await page.getByRole('button', { name: 'Match case' }).click();
  const line = page.locator('.search-line').first();
  await expect(line).toBeVisible();
  const path = await line.getAttribute('data-search-open');
  await line.click();
  await expect.poll(async () => (await calls(page, 'read_file')).at(-1)?.args.path).toBe(path);
  // The match opens as a tab beside the conversation; the search stays where it was.
  await expect(page.locator('.file-view-path')).toHaveText(path!);
  await expect(searchInput(page)).toHaveValue('createSearchIndex');
  await expect(page.locator('.search-line').first()).toBeVisible();
});
