import { expect, test, type Page } from '@playwright/test';

// The browser preview mirrors the native worktree rules; these tests exercise the
// single branch control, in-place conversion, cleanup offers, and recovery.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const chip = (page: Page) => page.locator('#branch-chip');
const menu = (page: Page) => page.getByRole('dialog', { name: 'Branch and worktree', exact: true });
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__worktreeCalls ?? []).filter((entry: any) => entry.command === command), command);

async function probe(page: Page, hook = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `
      (window.__worktreeCalls ??= []).push({ command, args: structuredClone(args) });
      ${hook}
      switch (command) {
    `)) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toBeEnabled();
}

test('one branch control: the prompt bar chip names the checkout and there is no statusbar', async ({ page }) => {
  await probe(page);
  await expect(page.locator('.composer-context')).toHaveCount(1);
  await expect(chip(page)).toContainText('feat/instant-search');
  await expect(page.locator('.statusbar')).toHaveCount(0);
  await chip(page).click();
  await expect(menu(page).getByRole('menuitem', { name: /New task in a worktree/ })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /Work in a new worktree/ })).toHaveCount(0);
  await expect(menu(page)).toContainText('/Users/you/Projects/orbit');
  await page.keyboard.press('Escape');
  await expect(chip(page)).toBeFocused();
});

test('an unstarted task converts in place and keeps its draft, title, and selection', async ({ page }) => {
  await probe(page);
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
  const taskId = await page.locator('#prompt').getAttribute('data-session-id');
  await prompt(page).fill('Fix the login redirect loop when the session expires');
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  const dialog = page.locator('#dialog');
  const branch = dialog.getByRole('textbox', { name: 'Branch name', exact: true });
  await expect(branch).toHaveValue('fix-the-login-redirect-loop-when-the');
  await expect(dialog.locator('#branch-preview')).toContainText('pandacode/fix-the-login-redirect-loop-when-the');
  await expect(dialog.locator('#branch-base option')).toHaveCount(3);
  await branch.fill('login-loop');
  await dialog.locator('#branch-base').selectOption('main');
  await dialog.getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', taskId!);
  await expect(prompt(page)).toHaveValue('Fix the login redirect loop when the session expires');
  await expect(page.locator('.composer-local')).toHaveText('Worktree');
  await expect(chip(page)).toContainText('pandacode/login-loop');
  expect((await calls(page, 'attach_worktree')).at(-1).args).toMatchObject({ sessionId: taskId, branch: 'login-loop', base: 'main', existing: false });
  expect(await calls(page, 'create_worktree')).toHaveLength(0);
  await chip(page).click();
  await expect(menu(page).getByRole('menuitem', { name: /Remove worktree/ })).toBeVisible();
  await expect(menu(page).getByRole('menuitem', { name: /Push & open pull request/ })).toBeVisible();
  await page.keyboard.press('Escape');
});

test('an existing branch is offered for reuse instead of failing', async ({ page }) => {
  await probe(page);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('reuse-me');
  await dialog.getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(dialog).toBeHidden();
  // A second task asking for the same branch name learns it exists and can reuse it.
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('reuse-me');
  await dialog.getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(dialog.locator('.worktree-error')).toContainText('already exists');
  const existing = dialog.getByRole('checkbox', { name: /Use the existing branch/ });
  await expect(existing).toBeVisible();
  await expect(existing).toBeFocused();
  await existing.check();
  await dialog.getByRole('button', { name: 'Use a worktree', exact: true }).click();
  // The preview treats a checked-out branch like Git does: the destination is taken.
  await expect(dialog.locator('.worktree-error')).toContainText('already exists');
});

test('archiving a clean worktree task offers removal and reports a kept unmerged branch', async ({ page }) => {
  await probe(page);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('cleanup-me');
  await page.locator('#dialog').getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await page.locator('#task-menu-trigger').click();
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Archive task', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Archive task', exact: true });
  await expect(dialog).toContainText('worktree is clean');
  await expect(dialog).toContainText('not pushed or merged');
  const remove = dialog.getByRole('checkbox', { name: /Remove the worktree folder/ });
  await expect(remove).not.toBeChecked();
  await remove.check();
  await dialog.getByRole('button', { name: 'Archive task', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('pandacode/cleanup-me was kept');
  expect((await calls(page, 'remove_worktree')).at(-1).args).toMatchObject({ deleteBranch: true });
  expect((await calls(page, 'update_session')).at(-1).args).toMatchObject({ archived: true });
  await expect(page.locator('.composer-area')).toContainText('This task is archived.');
});

test('a dirty worktree is never removed and cancel keeps the task active', async ({ page }) => {
  await probe(page, `
    if (command === 'worktree_status') return { exists: true, branch: 'pandacode/dirty', changes: 2, clean: false, hasUpstream: false, ahead: 1, merged: false };
  `);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('dirty');
  await page.locator('#dialog').getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Remove worktree/ }).click();
  const dialog = page.getByRole('dialog', { name: 'Remove worktree', exact: true });
  await expect(dialog).toContainText('2 uncommitted changes');
  await expect(dialog.getByRole('button', { name: 'Remove and archive', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await calls(page, 'remove_worktree')).toHaveLength(0);
  expect(await calls(page, 'update_session')).toHaveLength(0);
  await expect(page.locator('.composer-local')).toHaveText('Worktree');
});

test('a missing worktree folder is named in the chip and can be recreated', async ({ page }) => {
  await probe(page);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('vanish');
  await page.locator('#dialog').getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(chip(page)).toContainText('pandacode/vanish');
  // Delete the folder behind the app's back, then revisit the task.
  await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const id = document.querySelector<HTMLElement>('#prompt')!.dataset.sessionId;
    await invoke('remove_worktree', { sessionId: id, deleteBranch: false });
  });
  await page.locator('.task-item[data-id="session-1"]').click();
  // A draft with a worktree is kept, not discarded; New task reopens it.
  await page.locator('.new-task-button').click();
  await expect(chip(page)).toContainText('Worktree missing');
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: 'Recreate worktree', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Worktree restored on pandacode/vanish');
  await expect(chip(page)).toContainText('pandacode/vanish');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('#inspector-content')).toContainText('pandacode/vanish');
});

test('the context bar stays on one line in a narrow conversation', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item', { hasText: 'Add keyboard shortcuts' }).click();
  const bar = page.locator('#composer-area .composer-context');
  await expect(bar.locator('.link-chip')).toBeVisible();
  await expect(bar.locator('#branch-chip')).toBeVisible();
  const measure = () => page.evaluate(() => document.querySelector('#composer-area .composer-context')!.getBoundingClientRect().height);
  const height = await measure();
  await page.locator('#composer-area').evaluate(el => { el.style.maxWidth = '420px'; });
  await expect(bar.locator('.composer-local')).toBeHidden();
  await expect(bar.locator('.link-chip')).toBeVisible();
  expect(Math.abs(await measure() - height)).toBeLessThan(1);
});

test('the branch menu switches the checkout to main or another local branch', async ({ page }) => {
  await probe(page);
  await expect(chip(page)).toContainText('feat/instant-search');
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Switch to main/ }).click();
  await expect(page.locator('#toast')).toContainText('Switched to main');
  await expect(chip(page)).toContainText('main');
  await chip(page).click();
  await expect(menu(page).getByRole('menuitem', { name: /Switch to main/ })).toHaveCount(0);
  await menu(page).getByRole('menuitem', { name: /Other branch/ }).click();
  const picker = page.locator('.choice-menu[aria-label="Switch branch"]');
  await expect(picker.getByRole('menuitemradio', { name: /^main/ })).toHaveCount(0);
  await picker.getByRole('menuitemradio', { name: /release\/1\.4/ }).click();
  await expect(page.locator('#toast')).toContainText('Switched to release/1.4');
  await expect(chip(page)).toContainText('release/1.4');
  expect((await calls(page, 'git_switch_branch')).map(call => call.args.branch)).toEqual(['main', 'release/1.4']);
});

for (const theme of ['dark', 'light'] as const) {
  test(`the prompt box has a hairline and its context bar no border in ${theme} mode, both solid under increased contrast`, async ({ page }) => {
    await page.emulateMedia({ colorScheme: theme });
    await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
    await probe(page);
    await page.locator('#prompt').focus();
    const border = (selector: string) => page.locator(selector).evaluate(el => getComputedStyle(el).borderTopColor);
    await expect.poll(() => border('#composer-area .composer')).toMatch(/^rgba\(.+, 0\.\d+\)$/);
    await expect.poll(() => border('#composer-area .composer-context')).toBe('rgba(0, 0, 0, 0)');
    await page.emulateMedia({ colorScheme: theme, contrast: 'more' });
    for (const selector of ['#composer-area .composer', '#composer-area .composer-context']) await expect.poll(() => border(selector)).toMatch(/^rgb\(/);
  });
}

test('merges a worktree into main locally, then offers to remove it', async ({ page }) => {
  await probe(page);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('ship-it');
  await page.locator('#dialog').getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /^Merge into main/ }).click();
  await expect(page.locator('#toast')).toContainText('Merged 1 commit from pandacode/ship-it into main');
  // The branch is merged now, so the cleanup offer removes the folder and the branch.
  const dialog = page.getByRole('dialog', { name: 'Remove worktree', exact: true });
  await expect(dialog).toContainText('its branch is merged');
  await expect(dialog.getByRole('checkbox')).toBeChecked();
  await dialog.getByRole('button', { name: 'Remove and archive', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('deleted pandacode/ship-it');
  expect((await calls(page, 'remove_worktree')).at(-1).args).toMatchObject({ deleteBranch: true });
});

test('a merge that conflicts says so and leaves the worktree alone', async ({ page }) => {
  await probe(page, `
    if (command === 'merge_worktree') throw new Error('Merging pandacode/clash into main conflicts in src/app.ts. Nothing was changed; merge main into the worktree, resolve it there, and try again.');
  `);
  await page.locator('.new-task-button').click();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /Work in a new worktree/ }).click();
  await page.locator('#dialog').getByRole('textbox', { name: 'Branch name', exact: true }).fill('clash');
  await page.locator('#dialog').getByRole('button', { name: 'Use a worktree', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await chip(page).click();
  await menu(page).getByRole('menuitem', { name: /^Merge into main/ }).click();
  await expect(page.locator('#toast')).toContainText('Couldn’t merge: Merging pandacode/clash into main conflicts in src/app.ts');
  await expect(page.getByRole('dialog', { name: 'Remove worktree', exact: true })).toHaveCount(0);
  expect(await calls(page, 'remove_worktree')).toHaveLength(0);
  await expect(page.locator('.composer-local')).toHaveText('Worktree');
});
