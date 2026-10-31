import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

// The inspector's change surfaces against a multi-folder project (?folders gives
// project-1 the primary orbit repository, the orbit-web repository and the plain
// orbit-docs folder): per-repo groups in Changes, the branch chip's repo count
// and menu, and one linked pull request per repository in the PR tab.
const tab = (page: Page, action: string) => page.locator(`.inspector-tabs [data-action="${action}"]`);

/** Records every preview command with its arguments, like the GitHub suite does. */
async function record(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__folderCalls ??= []).push({ command, args: structuredClone(args) });
      switch (command) {
    `) });
  });
}
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (((window as any).__folderCalls ?? []) as any[]).filter(entry => entry.command === command), command);

async function open(page: Page, recordCalls = false): Promise<void> {
  if (recordCalls) await record(page);
  await page.goto('/?folders');
  // Cold dev servers can take a few seconds to compile the first page.
  await expect(page.locator('.task-item.selected')).toBeVisible({ timeout: 20_000 });
}

test('the Changes view shows one group per repository and diffs a web file through its folder', async ({ page }) => {
  await open(page, true);
  await openInspectorTab(page, 'Changes');
  await tab(page, 'tab-changes').click();
  const view = page.locator('.changes-view');
  // One slim heading per repository with files; the plain docs folder has none and shows nothing.
  const headings = view.locator('.cv-repo');
  await expect(headings).toHaveCount(2);
  await expect(headings.filter({ hasText: 'orbit' }).first()).toBeVisible();
  const orbit = view.locator('.cv-repo[data-repo="orbit"]');
  await expect(orbit.locator('.cv-repo-branch')).toHaveText('feat/instant-search');
  await expect(orbit.locator('.cv-repo-ahead')).toHaveText('↑1');
  const web = view.locator('.cv-repo[data-repo="orbit-web"]');
  await expect(web.locator('.cv-repo-branch')).toHaveText('main');
  // Each group carries its own files: the primary's three, the web repository's two.
  await expect(view.locator('.cv-file')).toHaveCount(5);
  await expect(view.locator('.cv-file[data-repo="orbit-web"] .cv-name')).toHaveText(['package.json', 'refresh-button.tsx']);
  // The primary repository's files keep bare paths: no data-repo qualifier.
  await expect(view.locator('.cv-file:not([data-repo])')).toHaveCount(3);
  // Opening a web file diffs it through the folder qualifier; the primary stays unqualified.
  // Every group's patches load eagerly here (five files), so the recorded arguments are the proof.
  const argsFor = async (path: string) => (await calls(page, 'git_diff')).find(entry => entry.args.path === path)?.args;
  const file = view.locator('.cv-file[data-repo="orbit-web"][data-path="src/refresh-button.tsx"]');
  await expect(file.locator('.diff-viewer[data-diff-state="ready"]')).toBeAttached({ timeout: 10_000 });
  await expect.poll(() => argsFor('src/refresh-button.tsx')).toMatchObject({ path: 'src/refresh-button.tsx', folder: 'orbit-web' });
  const primary = view.locator('.cv-file:not([data-repo])[data-path="src/components/search.ts"]');
  await expect(primary.locator('.diff-viewer[data-diff-state="ready"]')).toBeAttached({ timeout: 10_000 });
  await expect.poll(() => argsFor('src/components/search.ts')).toMatchObject({ path: 'src/components/search.ts' });
  expect((await argsFor('src/components/search.ts')).folder).toBeUndefined();
  // A fold keeps the section's viewer mounted; unfolding shows it again.
  await file.locator('.cv-file-name').click();
  await expect(file.locator('.cv-file-body')).toBeHidden();
  await file.locator('.cv-file-name').click();
  await expect(file.locator('.diff-viewer[data-diff-state="ready"]')).toBeVisible();
});

test('the branch chip counts the extra repositories and its menu lists each one', async ({ page }) => {
  await open(page);
  const chip = page.locator('#branch-chip');
  await expect(chip.locator('.branch-chip-name')).toHaveText('feat/instant-search');
  const count = chip.locator('.branch-chip-repos');
  await expect(count).toHaveText('+2');
  await expect(count).toHaveAttribute('title', '3 repositories in this task');
  await chip.click();
  const menu = page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
  await expect(menu.locator('.choice-menu-heading', { hasText: 'Repositories' })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'orbit', exact: true })).toContainText('feat/instant-search · ↑1');
  await expect(menu.getByRole('menuitem', { name: 'orbit-web', exact: true })).toContainText('main');
  await expect(menu.getByRole('menuitem', { name: 'orbit-docs', exact: true })).toContainText('Not a Git repository');
});

test('the PR tab lists one entry per repository and opens the second PR through its folder', async ({ page }) => {
  await open(page, true);
  await openInspectorTab(page, 'Pull request');
  await tab(page, 'tab-pull').click();
  const view = page.locator('#inspector .pull-view');
  // One entry per repository: the primary's number alone, the web one named by its repo.
  const entries = view.locator('.pull-entry');
  await expect(entries).toHaveCount(2);
  await expect(entries.nth(0)).toContainText('#130');
  await expect(entries.nth(0)).toHaveAttribute('aria-selected', 'true');
  await expect(entries.nth(1)).toContainText('orbit-web #57');
  await expect(entries.nth(1)).toHaveAttribute('aria-selected', 'false');
  // The primary keeps today's presentation.
  await expect(view.locator('.pull-title')).toHaveText('Debounce library search');
  await expect(view.locator('.pull-repo')).toHaveCount(0);
  // Picking the web entry opens the existing detail view for that repository's pull request.
  await entries.nth(1).click();
  await expect(view.locator('.pull-title')).toHaveText('Refresh button polish');
  await expect(view.locator('.pull-repo')).toHaveText('orbit-labs/orbit-web');
  await expect(view.locator('.pull-state')).toContainText('Open');
  await expect.poll(async () => (await calls(page, 'github_pull_request')).at(-1)?.args).toMatchObject({ sessionId: 'session-1', folder: 'orbit-web' });
  // And back to the primary's.
  await entries.nth(0).click();
  await expect(view.locator('.pull-title')).toHaveText('Debounce library search');
  await expect(view.locator('.pull-repo')).toHaveCount(0);
});
