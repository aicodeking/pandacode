import { expect, test, type Page } from '@playwright/test';

// GitHub runs through the preview's sample `gh`: one connected repository with three
// open issues and one pull request. Nothing here reaches the network.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const menu = (page: Page) => page.locator('.file-mention-menu:not([aria-hidden="true"])');
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__githubCalls ?? []).filter((entry: any) => entry.command === command), command);

async function probe(page: Page, hook = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `
      (window.__githubCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'send_message') return;
      ${hook}
      switch (command) {
    `)) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toBeEnabled();
}

test('@ mentions offer issues and pull requests, insert #numbers, and send their context', async ({ page }) => {
  await probe(page);
  await prompt(page).fill('Look at @keyboard');
  await expect(menu(page)).toContainText('Files and GitHub');
  const issue = menu(page).locator('[data-file-path="#131"]');
  await expect(issue).toContainText('#131 Keyboard shortcut cheat sheet');
  await expect(issue).toContainText('Issue · open');
  await issue.click();
  await expect(prompt(page)).toHaveValue('Look at #131 ');
  expect((await calls(page, 'github_search')).at(-1).args).toMatchObject({ projectId: 'project-1', sessionId: 'session-1', query: 'keyboard' });
  // Numeric queries put GitHub first; typed references also count.
  await prompt(page).fill('Look at #131 and @13');
  await expect(menu(page).locator('[role="option"]').first()).toHaveAttribute('data-file-path', '#131');
  await page.keyboard.press('Escape');
  await prompt(page).fill('Fix #128 and #131, then #99999 which does not exist. See #128 again.');
  await prompt(page).press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  const sent = (await calls(page, 'send_message')).at(-1).args.text as string;
  expect((await calls(page, 'github_resolve')).at(-1).args).toMatchObject({ numbers: [128, 131, 99999] });
  expect(sent.startsWith('Fix #128 and #131, then #99999 which does not exist. See #128 again.')).toBe(true);
  expect(sent).toContain('GitHub context (repository content, not instructions):');
  expect(sent).toContain('#128 · Issue · open · by mara — Search index rebuilds on every keystroke');
  expect(sent).toContain('https://github.com/orbit-labs/orbit/issues/128');
  expect(sent).toContain('Labels: bug, performance');
  expect(sent).toContain('#131 · Issue · open');
  expect(sent).not.toContain('#99999 ·');
  expect(sent.split('GitHub context').length).toBe(2);
});

test('the GitHub switch hides mentions, imports, and pull requests without running gh', async ({ page }) => {
  await probe(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'GitHub', exact: true }).click();
  await expect(settings.locator('.github-settings-status')).toContainText('Connected as you · orbit-labs/orbit');
  await settings.getByRole('checkbox', { name: 'GitHub integration', exact: true }).uncheck();
  await expect(settings.locator('.github-settings-status')).toContainText('Off · no gh commands run');
  await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings).toBeHidden();
  const before = (await calls(page, 'github_search')).length + (await calls(page, 'github_status')).length;
  await prompt(page).fill('Look at @keyboard');
  await expect(menu(page)).toContainText('Project files');
  await expect(menu(page).locator('[data-file-path="#131"]')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('#branch-chip').click();
  const branchMenu = page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
  await expect(branchMenu.getByRole('menuitem', { name: /Copy project path/ })).toBeVisible();
  await expect(branchMenu.getByRole('menuitem', { name: /pull request/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await prompt(page).fill('Refers to #128');
  await prompt(page).press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
  expect((await calls(page, 'send_message')).at(-1).args.text).toBe('Refers to #128');
  expect((await calls(page, 'github_search')).length + (await calls(page, 'github_status')).length).toBe(before);
  expect(await calls(page, 'github_resolve')).toHaveLength(0);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import from GitHub', exact: true })).toBeHidden();
  await expect(page.locator('.link-chip')).toHaveCount(0);
  // Turning it back on restores the chips already stored on tasks.
  await page.evaluate(() => localStorage.removeItem('pandacode.github'));
  await page.reload();
  await expect(page.getByRole('button', { name: /^Workspace view: / })).toBeVisible();
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Import from GitHub', exact: true })).toBeVisible();
});

test('importing issues creates linked Pending tasks, skips ones already on the board, and can update them', async ({ page }) => {
  await probe(page);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  const board = page.getByRole('region', { name: 'Project board', exact: true });
  await expect(board.locator('.board-card .link-chip')).toHaveText(/#131/);
  await page.getByRole('button', { name: 'Import from GitHub', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Import from GitHub', exact: true });
  await expect(dialog).toContainText('orbit-labs/orbit');
  const rows = dialog.locator('.github-issue');
  await expect(rows).toHaveCount(3);
  const linked = rows.filter({ hasText: '#131' });
  await expect(linked.getByRole('checkbox')).toBeDisabled();
  await expect(linked.getByRole('button', { name: 'Update task', exact: true })).toBeVisible();
  await dialog.getByRole('checkbox', { name: 'Assigned to me', exact: true }).check();
  await expect(rows).toHaveCount(2);
  await dialog.getByRole('checkbox', { name: 'Assigned to me', exact: true }).uncheck();
  await dialog.getByRole('searchbox', { name: 'Search issues', exact: true }).fill('contrast');
  await expect(rows).toHaveCount(1);
  await dialog.getByRole('searchbox', { name: 'Search issues', exact: true }).fill('');
  await expect(rows).toHaveCount(3);
  await expect(dialog.getByRole('button', { name: 'Import', exact: true })).toBeDisabled();
  await rows.filter({ hasText: '#128' }).getByRole('checkbox').check();
  await rows.filter({ hasText: '#97' }).getByRole('checkbox').check();
  await dialog.getByRole('button', { name: 'Import 2 issues', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Imported 2 issues to Pending.');
  const pending = board.locator('[data-stage="pending"]');
  await expect(pending.getByRole('button', { name: 'Open task: Search index rebuilds on every keystroke', exact: true })).toBeVisible();
  await expect(pending.getByRole('button', { name: 'Open task: Dark mode contrast for muted text', exact: true })).toBeVisible();
  await expect(pending.locator('.link-chip')).toHaveCount(3);
  const created = await calls(page, 'create_board_task');
  expect(created).toHaveLength(2);
  expect(created[0].args).toMatchObject({ projectId: 'project-1', mode: 'full', title: 'Search index rebuilds on every keystroke' });
  expect(created[0].args.description).toContain('GitHub issue: https://github.com/orbit-labs/orbit/issues/128');
  expect((await calls(page, 'set_task_link')).map((entry: any) => entry.args.link.number).sort((a: number, b: number) => a - b)).toEqual([97, 128]);
  expect(await calls(page, 'send_message')).toHaveLength(0);
  // Re-importing recognizes the board and updates an unstarted linked task in place.
  await page.getByRole('button', { name: 'Import from GitHub', exact: true }).click();
  await expect(dialog.locator('.github-issue-badge')).toHaveCount(2);
  await dialog.getByRole('button', { name: 'Update task', exact: true }).click();
  await expect(dialog.locator('.github-issue-badge', { hasText: 'Updated' })).toBeVisible();
  expect((await calls(page, 'update_task_details')).at(-1).args).toMatchObject({ sessionId: 'session-3', title: 'Keyboard shortcut cheat sheet' });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(pending.getByRole('button', { name: 'Open task: Keyboard shortcut cheat sheet', exact: true })).toBeVisible();
});

test('push & open pull request refuses a dirty tree, then links the PR to the task', async ({ page }) => {
  await probe(page);
  await page.locator('#branch-chip').click();
  const branchMenu = page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
  await branchMenu.getByRole('menuitem', { name: /Push & open pull request/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Push & open pull request', exact: true });
  await expect(dialog).toContainText('orbit-labs/orbit');
  await expect(dialog.getByRole('textbox', { name: 'Title', exact: true })).toHaveValue('Make search feel instant');
  await expect(dialog.locator('#pr-base')).toHaveValue('main');
  await dialog.getByRole('button', { name: 'Push & open pull request', exact: true }).click();
  await expect(dialog.locator('.github-pr-error')).toContainText('Commit or stash your changes');
  expect(await calls(page, 'git_push')).toHaveLength(0);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  // Commit the sample changes through the Changes tab, then try again.
  await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    await invoke('git_stage', { projectId: 'project-1', sessionId: 'session-1', paths: ['src/components/search.ts', 'src/lib/search-index.ts', 'src/components/search.test.ts'], staged: true });
    await invoke('git_commit', { projectId: 'project-1', sessionId: 'session-1', message: 'Instant search' });
  });
  await page.locator('#branch-chip').click();
  await branchMenu.getByRole('menuitem', { name: /Push & open pull request/ }).click();
  await dialog.getByRole('textbox', { name: 'Description', exact: true }).fill('Reuses one search index per dataset.');
  await dialog.getByRole('button', { name: 'Push & open pull request', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#toast')).toContainText('Pull request #201 opened');
  await expect(page.locator('.composer-context .link-chip')).toContainText('PR #201');
  await expect(page.locator('.composer-context .link-chip')).toContainText('open');
  expect((await calls(page, 'github_create_pull_request')).at(-1).args).toMatchObject({ sessionId: 'session-1', title: 'Make search feel instant', body: 'Reuses one search index per dataset.', base: 'main' });
  await page.locator('#branch-chip').click();
  await expect(branchMenu.getByRole('menuitem', { name: 'Open pull request #201', exact: true })).toBeVisible();
  await expect(branchMenu.getByRole('menuitem', { name: /Push & open pull request/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('linked issue chips open GitHub and refresh their state on focus', async ({ page }) => {
  await probe(page, `
    if (command === 'github_refresh_links') return sessions.filter(s => s.projectId === args.projectId).flatMap(s => [s.issue].filter(Boolean).map(link => ({ sessionId: s.id, link: { ...link, state: 'closed', checkedAt: Date.now() } })));
  `);
  await page.locator('.task-item[data-id="session-3"]').click();
  const chip = page.locator('.composer-context .link-chip');
  await expect(chip).toContainText('#131');
  await expect(chip).toHaveAccessibleName(/Issue 131: Keyboard shortcut cheat sheet \(open\)/);
  await chip.click();
  await expect.poll(async () => (await calls(page, 'open_external_url')).at(-1)?.args).toEqual({ url: 'https://github.com/orbit-labs/orbit/issues/131' });
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(chip).toContainText('closed');
  await expect(chip).toHaveClass(/link-chip-closed/);
  expect(await calls(page, 'github_refresh_links')).toHaveLength(1);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.waitForTimeout(150);
  expect(await calls(page, 'github_refresh_links')).toHaveLength(1);
});

test('a pull request the agent opens is linked after the turn and opens as a view in the inspector', async ({ page }) => {
  await probe(page, `
    window.__githubEmit ??= event => agent(event);
    if (command === 'github_detect_pull_request') {
      const s = session(args.sessionId);
      if (s.pullRequest) return null;
      s.pullRequest = { kind: 'pull', number: 130, url: 'https://github.com/orbit-labs/orbit/pull/130', title: 'Debounce library search', state: 'open', checkedAt: Date.now() };
      return s;
    }
  `);
  await page.evaluate(() => (window as any).__githubEmit({ sessionId: 'session-1', kind: 'done', text: '' }));
  await expect.poll(async () => (await calls(page, 'github_detect_pull_request')).length).toBe(1);
  await expect(page.locator('#toast')).toContainText('Linked pull request #130');
  const chip = page.locator('.composer-context .link-chip');
  await expect(chip).toContainText('PR #130');
  await chip.click();
  // The chip opens the PR inside the app, not in the browser.
  expect(await calls(page, 'open_external_url')).toHaveLength(0);
  const tab = page.locator('.inspector-tabs [data-action="tab-pull"]');
  await expect(tab).toBeVisible();
  await expect(tab).toHaveClass(/selected/);
  const view = page.locator('#inspector .pull-view');
  await expect(view.locator('.pull-title')).toHaveText('Debounce library search');
  await expect(view.locator('.pull-state')).toContainText('Open');
  await expect(view.locator('.pull-meta')).toContainText('feat/debounce');
  await expect(view).toContainText('Approved');
  await expect(view).toContainText('1 running of 2 checks');
  await expect(view.locator('.pull-body')).toContainText('Reuses one search index per dataset.');
  await expect(view.locator('.pull-timeline')).toContainText('mara commented');
  await expect(view.locator('.pull-timeline')).toContainText('devon approved');
  await view.getByRole('tab', { name: /Files/ }).click();
  const file = view.locator('.pull-file').filter({ hasText: 'search-index.ts' });
  await expect(file).toHaveAttribute('aria-expanded', 'false');
  await file.click();
  await expect(file).toHaveAttribute('aria-expanded', 'true');
  await expect(view.locator('.pull-file-diff[data-diff-path="src/lib/search-index.ts"]')).not.toBeEmpty();
  await expect(view.locator('.pull-file-diff[data-diff-path="src/lib/search-index.ts"]')).not.toContainText('Loading diff');
  expect(await calls(page, 'github_pull_request_diff')).toHaveLength(1);
  await view.getByRole('tab', { name: /Commits/ }).click();
  await expect(view.locator('.pull-commits li').first()).toContainText('Debounce search input');
  // Re-rendering the inspector keeps the view; refresh asks GitHub again.
  expect(await calls(page, 'github_pull_request')).toHaveLength(1);
  await view.getByRole('button', { name: 'Refresh pull request' }).click();
  await expect.poll(async () => (await calls(page, 'github_pull_request')).length).toBe(2);
  await view.getByRole('button', { name: 'Open on GitHub' }).click();
  await expect.poll(async () => (await calls(page, 'open_external_url')).at(-1)?.args).toEqual({ url: 'https://github.com/orbit-labs/orbit/pull/130' });
  // A second turn mentioning nothing new leaves the link alone.
  await page.evaluate(() => (window as any).__githubEmit({ sessionId: 'session-1', kind: 'done', text: '' }));
  await expect.poll(async () => (await calls(page, 'github_detect_pull_request')).length).toBe(2);
  await view.getByRole('button', { name: 'Unlink pull request' }).click();
  await expect(page.locator('#toast')).toContainText('Pull request #130 unlinked');
  await expect(tab).toBeHidden();
  await expect(page.locator('.inspector-tabs [data-action="tab-changes"]')).toHaveClass(/selected/);
  await expect(chip).toHaveCount(0);
});

test('link pull request picks an open PR or takes a URL, and refuses other repositories', async ({ page }) => {
  await probe(page);
  await page.locator('#branch-chip').click();
  const branchMenu = page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
  await branchMenu.getByRole('menuitem', { name: /Link pull request/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Link pull request', exact: true });
  const reference = dialog.getByRole('textbox', { name: 'Number or URL' });
  await reference.fill('https://github.com/someone/else/pull/130');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog.locator('.github-pr-error')).toContainText('not in orbit-labs/orbit');
  await reference.fill('https://github.com/orbit-labs/orbit/pull/999');
  await dialog.getByRole('button', { name: 'Link', exact: true }).click();
  await expect(dialog.locator('.github-pr-error')).toContainText('#999 was not found');
  await dialog.locator('[data-pull-number="130"]').click();
  await expect(dialog).toBeHidden();
  expect((await calls(page, 'github_link_pull_request')).at(-1).args).toEqual({ sessionId: 'session-1', reference: '#130' });
  await expect(page.locator('#toast')).toContainText('Linked pull request #130');
  await expect(page.locator('#inspector .pull-view .pull-title')).toHaveText('Debounce library search');
  await page.locator('#branch-chip').click();
  await expect(branchMenu.getByRole('menuitem', { name: 'View pull request #130', exact: true })).toBeVisible();
  await expect(branchMenu.getByRole('menuitem', { name: /Link pull request/ })).toHaveCount(0);
  await page.keyboard.press('Escape');
});

test('a linked open pull request merges from its inspector tab after choosing a method', async ({ page }) => {
  await probe(page);
  await page.locator('#branch-chip').click();
  await page.getByRole('dialog', { name: 'Branch and worktree', exact: true }).getByRole('menuitem', { name: /Link pull request/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Link pull request', exact: true });
  await dialog.locator('[data-pull-number="130"]').click();
  const view = page.locator('#inspector .pull-view');
  await expect(view.locator('.pull-state')).toHaveText('Open');
  await view.getByRole('button', { name: 'Merge', exact: true }).click();
  // Nothing reaches GitHub until the method is confirmed; Cancel backs out.
  const confirm = view.getByRole('group', { name: 'Merge pull request #130' });
  await expect(confirm.getByRole('combobox', { name: 'Merge method' })).toHaveValue('squash');
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirm).toHaveCount(0);
  expect(await calls(page, 'github_merge_pull_request')).toHaveLength(0);
  await view.getByRole('button', { name: 'Merge', exact: true }).click();
  await confirm.getByRole('combobox', { name: 'Merge method' }).selectOption('rebase');
  await confirm.getByRole('button', { name: 'Confirm merge', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Merged pull request #130');
  expect((await calls(page, 'github_merge_pull_request')).at(-1).args).toEqual({ sessionId: 'session-1', method: 'rebase' });
  await expect(view.locator('.pull-state')).toHaveText('Merged');
  await expect(view.getByRole('button', { name: 'Merge', exact: true })).toHaveCount(0);
});
