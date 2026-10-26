import { expect, test, type Page } from '@playwright/test';

// ?sections adds preview threads for every section: running, waiting for approval, a failed run
// and a usage limit (Active); two unseen finished turns (Needs review); a pinned task; a chat; a long
// worktree title with a PR; enough folder tasks for "Show more"; and twelve completed tasks.
const section = (page: Page, name: string) => page.locator(`#navigation [data-thread-group="${name}"]`);
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const toggle = (page: Page) => page.getByRole('button', { name: /^Completed/ });
const action = (page: Page, name: string) => page.getByRole('button', { name, exact: true });
const menu = (page: Page) => page.getByRole('dialog', { name: 'Task actions', exact: true });
const ids = (page: Page, name: string) => section(page, name).locator('.task-item').evaluateAll(rows => rows.map(r => (r as HTMLElement).dataset.id));

async function open(page: Page): Promise<void> {
  await page.goto('/?sections');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}

test.describe('sidebar sections', () => {
  test('lists work that needs you, then review, pinned and chats, each under a heading with a count', async ({ page }) => {
    await open(page);
    const active = page.getByRole('region', { name: 'Active tasks', exact: true });
    const review = page.getByRole('region', { name: 'Tasks to review', exact: true });
    await expect(active.locator('.section-heading')).toHaveText('Active4');
    // Latest start first: running, approval, the failed run, then the usage limit.
    expect(await ids(page, 'active')).toEqual(['sections-running', 'sections-approval', 'sections-failed', 'sections-limited']);
    await expect(review.locator('.section-heading')).toHaveText('Needs review2');
    expect(await ids(page, 'review')).toEqual(['sections-review-1', 'sections-review-2']);
    await expect(row(page, 'sections-approval').locator('.task-indicator')).toHaveAttribute('aria-label', 'Needs approval');
    await expect(row(page, 'sections-approval').locator('.task-status')).toHaveText('Approval');
    await expect(row(page, 'sections-failed').locator('.task-indicator')).toHaveAttribute('aria-label', 'Failed');
    await expect(row(page, 'sections-limited').locator('.task-indicator')).toHaveAttribute('aria-label', /^Usage limit · /);
    await expect(row(page, 'sections-limited').locator('.task-status')).toHaveText(/^Limited · \d/);
    await expect(row(page, 'sections-running').locator('.task-runtime')).toBeVisible();
    await expect(row(page, 'sections-review-1')).toHaveClass(/\bunread\b/);
    await expect(row(page, 'sections-review-1').locator('.task-indicator.unread')).toHaveAttribute('aria-label', 'Unread');
    expect(await ids(page, 'pinned')).toEqual(['sections-pinned']);
    expect(await ids(page, 'chats')).toEqual(['sections-chat', 'sections-chat-2', 'sections-chat-3', 'sections-chat-4']);
    // Two-line cards in the sections, one line in folders; cards are compact.
    const card = await row(page, 'sections-approval').boundingBox();
    expect(card!.height).toBeLessThanOrEqual(54);
    const line = await row(page, 'session-2').boundingBox();
    expect(line!.height).toBeLessThanOrEqual(30);
    // Each thread appears once.
    for (const id of ['sections-running', 'sections-review-1', 'session-1', 'sections-chat']) await expect(row(page, id)).toHaveCount(1);
  });

  test('Chats follow the per-project cap with Show more; Pinned is never capped', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pandacode.sidebar.sort', JSON.stringify({ perProject: 3 })));
    await open(page);
    expect(await ids(page, 'chats')).toEqual(['sections-chat', 'sections-chat-2', 'sections-chat-3']);
    await section(page, 'chats').getByRole('button', { name: 'Show 1 more', exact: true }).click();
    await expect(section(page, 'chats').locator('.task-item')).toHaveCount(4);
    await section(page, 'chats').getByRole('button', { name: 'Show less', exact: true }).click();
    await expect(section(page, 'chats').locator('.task-item')).toHaveCount(3);
    await expect(section(page, 'pinned').locator('.folder-more')).toHaveCount(0);
  });

  test('a long title keeps its branch tail and PR visible on the row', async ({ page }) => {
    await open(page);
    const long = row(page, 'sections-long');
    await expect(long.locator('.task-link')).toHaveText('#482');
    await expect(long.locator('.task-worktree')).toHaveAttribute('aria-label', 'Worktree');
    await expect(long).toHaveAttribute('title', /pandacode\/sidebar-redesign-compact-rows/);
  });

  test('Completed starts closed, opens on click, pages in more and stays open after reload', async ({ page }) => {
    await open(page);
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(toggle(page)).toContainText('12');
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(0);
    await toggle(page).click();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    expect((await ids(page, 'completed')).slice(0, 3)).toEqual(['sections-done-1', 'sections-done-2', 'sections-done-3']);
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(10);
    await section(page, 'completed').getByRole('button', { name: 'Show 2 more', exact: true }).click();
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(12);
    await page.reload();
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(10);
  });

  test('row titles keep their width on hover: the actions cover the age instead', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    const line = row(page, 'sections-done-1').locator('.task-line').first();
    const title = row(page, 'sections-done-1').locator('.task-title');
    await expect(line).toHaveCSS('padding-right', '0px');
    await expect(row(page, 'sections-done-1').locator('.task-age')).toBeVisible();
    const width = (await title.boundingBox())!.width;
    await row(page, 'sections-done-1').hover();
    await expect(action(page, 'Reopen: Add dark mode tokens')).toBeVisible();
    await expect(line).toHaveCSS('padding-right', '0px');
    await expect(row(page, 'sections-done-1').locator('.task-age')).toHaveCSS('visibility', 'hidden');
    expect((await title.boundingBox())!.width).toBeCloseTo(width, 0);
  });

  test('the row tick completes a review thread, Undo brings it back, and the checked tick reopens it', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    await row(page, 'sections-review-1').hover();
    await action(page, 'Mark complete: Fix the flaky filter test').click();
    await expect(section(page, 'completed').locator('.task-item').first()).toHaveAttribute('data-id', 'sections-review-1');
    await expect(section(page, 'review').locator('.task-item')).toHaveCount(1);
    await expect(toggle(page)).toContainText('13');
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(section(page, 'completed').locator('[data-id="sections-review-1"]')).toHaveCount(0);
    await expect(toggle(page)).toContainText('12');
    // Undo restores the stage and the unread mark, so it is back in Needs review, still unread.
    await expect(section(page, 'review').locator('[data-id="sections-review-1"]')).toHaveCount(1);
    await expect(row(page, 'sections-review-1')).toHaveClass(/\bunread\b/);
    await row(page, 'sections-review-2').hover();
    await action(page, 'Mark complete: Write the release notes').click();
    await expect(section(page, 'completed').locator('.task-item').first()).toHaveAttribute('data-id', 'sections-review-2');
    await action(page, 'Reopen: Write the release notes').click();
    await expect(section(page, 'completed').locator('[data-id="sections-review-2"]')).toHaveCount(0);
    await expect(section(page, 'project:project-2').locator('[data-id="sections-review-2"]')).toHaveCount(1);
  });

  test('the open thread stays under the pointer when its own tick moves it to another section', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    await row(page, 'sections-done-2').click();
    await expect(row(page, 'sections-done-2')).toHaveAttribute('aria-current', 'page');
    const before = await row(page, 'sections-done-2').boundingBox();
    await action(page, 'Reopen: Remove the old onboarding').click();
    await expect(action(page, 'Mark complete: Remove the old onboarding')).toBeVisible();
    expect(await ids(page, 'completed')).toContain('sections-done-2');
    expect((await row(page, 'sections-done-2').boundingBox())!.y).toBeCloseTo(before!.y, 0);
    // Opening another thread lets it move to its folder.
    await row(page, 'session-2').click();
    await expect(section(page, 'project:project-2').locator('[data-id="sections-done-2"]')).toHaveCount(1);
  });

  test('archiving from the row menu moves the thread to the archive view, and Undo restores it', async ({ page }) => {
    await open(page);
    await row(page, 'sections-review-2').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(row(page, 'sections-review-2')).toHaveCount(0);
    await page.locator('#toast').getByRole('button', { name: 'Undo', exact: true }).click();
    await expect(row(page, 'sections-review-2')).toHaveCount(1);
    await row(page, 'sections-review-2').click({ button: 'right' });
    await menu(page).getByRole('menuitem', { name: 'Archive', exact: true }).click();
    await expect(row(page, 'sections-review-2')).toHaveCount(0);
    await page.getByRole('button', { name: 'Archived tasks', exact: true }).click();
    await expect(section(page, 'archived').locator('[data-id="sections-review-2"]')).toBeVisible();
    await row(page, 'sections-review-2').hover();
    await expect(action(page, 'Restore: Write the release notes')).toBeVisible();
    await expect(action(page, 'Delete: Write the release notes')).toBeVisible();
  });

  test('deletes a thread from the row menu after confirming', async ({ page }) => {
    await open(page);
    await row(page, 'sections-review-1').hover();
    const more = action(page, 'Task actions: Fix the flaky filter test');
    await expect(more).toHaveAttribute('aria-haspopup', 'menu');
    await more.click();
    await menu(page).getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Delete task?', exact: true });
    await expect(confirm).toContainText('Fix the flaky filter test');
    await confirm.getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(confirm).toBeHidden();
    await expect(row(page, 'sections-review-1')).toHaveCount(0);
    await expect(section(page, 'review').locator('.section-count')).toHaveText('1');
  });

  test('the filter field narrows every section by title, branch, PR or project, and Esc clears it', async ({ page }) => {
    await open(page);
    const filter = page.getByRole('searchbox', { name: 'Filter tasks', exact: true });
    await filter.fill('toolchain');
    await expect(page.locator('#navigation .task-item')).toHaveCount(1);
    await expect(row(page, 'sections-failed')).toBeVisible();
    await filter.fill('compact-rows');
    await expect(page.locator('#navigation .task-item')).toHaveCount(1);
    await expect(row(page, 'sections-long')).toBeVisible();
    await filter.fill('#482');
    await expect(row(page, 'sections-long')).toBeVisible();
    await filter.fill('no such task');
    await expect(page.locator('#navigation .task-item')).toHaveCount(0);
    await expect(page.locator('#navigation .sidebar-no-match')).toHaveText('No tasks match');
    await filter.press('Escape');
    await expect(filter).toHaveValue('');
    await expect(row(page, 'sections-failed')).toBeVisible();
  });

  test('the filter reaches into closed Completed, collapsed folders and past the per-project limit, without saving it', async ({ page }) => {
    await open(page);
    const filter = page.getByRole('searchbox', { name: 'Filter tasks', exact: true });
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(row(page, 'sections-many-6')).toHaveCount(0);
    await page.locator('.folder-heading[data-project="project-1"]').click();
    await expect(page.locator('.folder-heading[data-project="project-1"]')).toHaveAttribute('aria-expanded', 'false');
    await filter.fill('fixtures');
    await expect(row(page, 'sections-old-8')).toBeVisible();
    await filter.fill('the bundle');
    await expect(row(page, 'sections-many-6')).toBeVisible();
    await filter.fill('logger');
    await expect(row(page, 'sections-many-0')).toBeVisible();
    await filter.press('Escape');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    await expect(page.locator('.folder-heading[data-project="project-1"]')).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => localStorage.getItem('pandacode.sidebar.completedOpen'))).not.toBe('true');
  });

  test('a thread opened by shortcut holds its section; once it runs it leaves Completed for good', async ({ page }) => {
    await open(page);
    await page.locator('body').click({ position: { x: 900, y: 300 } }).catch(() => undefined);
    await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());
    // The fifth row is the first Needs review thread.
    await page.keyboard.press('ControlOrMeta+5');
    await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
    expect(await ids(page, 'review')).toContain('sections-review-1');
    await toggle(page).click();
    await row(page, 'sections-done-3').click();
    await action(page, 'Reopen: Document the keyboard map').click();
    expect(await ids(page, 'completed')).toContain('sections-done-3');
    const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
    await prompt.fill('Pick this back up');
    await prompt.press('Enter');
    await expect(section(page, 'active').locator('[data-id="sections-done-3"]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden({ timeout: 15_000 });
    expect(await ids(page, 'completed')).not.toContain('sections-done-3');
  });

  test('the row menu is grouped, offers moves only where rows can move, and renames without opening', async ({ page }) => {
    await open(page);
    await row(page, 'sections-review-2').click({ button: 'right' });
    const items = menu(page).getByRole('menuitem');
    await expect(menu(page).getByRole('menuitem', { name: 'Move up', exact: true })).toHaveCount(0);
    await expect(menu(page).getByRole('menuitem', { name: 'Copy task ID', exact: true })).toBeVisible();
    await expect(menu(page).getByRole('separator')).toHaveCount(3);
    expect((await items.allTextContents()).map(text => text.trim())).toEqual(['Pin task', 'Rename…', 'Mark as read', 'Copy project path', 'Copy task ID', 'Mark complete', 'Archive', 'Delete task…']);
    await page.keyboard.press('Escape');
    // A worktree task offers its branch.
    await row(page, 'sections-long').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'New task from pandacode/sidebar-redesign-compact-rows…', exact: true })).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Copy branch name', exact: true })).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Move up', exact: true })).toBeVisible();
    await menu(page).getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename task', exact: true });
    await dialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Compact rows');
    await dialog.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(row(page, 'sections-long').locator('.task-title')).toHaveText('Compact rows');
    await expect(row(page, 'sections-long')).not.toHaveAttribute('aria-current', 'page');
  });

  test('folders show a chevron and a menu that collapses the others and removes a project', async ({ page }) => {
    await open(page);
    const orbit = page.locator('.folder-heading[data-project="project-1"]'), pandacode = page.locator('.folder-heading[data-project="project-2"]');
    await expect(orbit.locator('.folder-chevron')).toHaveCSS('rotate', '90deg');
    await orbit.click();
    await expect(orbit.locator('.folder-chevron')).toHaveCSS('rotate', 'none');
    await orbit.click();
    await pandacode.click({ button: 'right' });
    const folderMenu = page.getByRole('dialog', { name: 'Project actions', exact: true });
    await expect(folderMenu.getByRole('menuitem')).toHaveText(['New task', 'Collapse other projects', 'Reveal in Finder', 'Remove project…']);
    await folderMenu.getByRole('menuitem', { name: 'Collapse other projects', exact: true }).click();
    await expect(orbit).toHaveAttribute('aria-expanded', 'false');
    await expect(pandacode).toHaveAttribute('aria-expanded', 'true');
    await page.locator('.folder-row').filter({ has: pandacode }).hover();
    await page.getByRole('button', { name: 'Project actions: pandacode', exact: true }).click();
    await folderMenu.getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
    const confirm = page.getByRole('dialog', { name: 'Remove pandacode?', exact: true });
    await confirm.getByRole('button', { name: 'Remove project', exact: true }).click();
    await expect(pandacode).toHaveCount(0);
    await expect(row(page, 'session-4')).toHaveCount(0);
  });

  test('the open Completed thread stays listed past the first page', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    await section(page, 'completed').getByRole('button', { name: 'Show 2 more', exact: true }).click();
    await row(page, 'sections-old-8').click();
    await expect(row(page, 'sections-old-8')).toHaveAttribute('aria-current', 'page');
    // Closing and reopening resets the page to 10 rows; the open thread is still there.
    await toggle(page).click();
    await toggle(page).click();
    await expect(row(page, 'sections-old-8')).toBeVisible();
    await expect(section(page, 'completed').locator('.task-item')).toHaveCount(11);
  });

  test('while filtering, heading clicks do not save open or closed state', async ({ page }) => {
    await open(page);
    await page.getByRole('searchbox', { name: 'Filter tasks', exact: true }).fill('the');
    const orbit = page.locator('.folder-heading[data-project="project-1"]');
    await orbit.click();
    await toggle(page).click();
    await expect(orbit).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'true');
    await page.getByRole('searchbox', { name: 'Filter tasks', exact: true }).fill('');
    await expect(orbit).toHaveAttribute('aria-expanded', 'true');
    await expect(toggle(page)).toHaveAttribute('aria-expanded', 'false');
    expect(await page.evaluate(() => [localStorage.getItem('pandacode.collapsedFolders'), localStorage.getItem('pandacode.sidebar.completedOpen')])).not.toContain('true');
  });

  test('folder counts show on hover; a focused row’s actions fade into the row’s own background', async ({ page }) => {
    await open(page);
    const count = page.locator('.folder-heading[data-project="project-1"] .folder-count');
    await expect(count).toBeHidden();
    await page.locator('.folder-row').first().hover();
    await expect(count).toBeVisible();
    await page.mouse.move(900, 600);
    await row(page, 'session-2').focus();
    const [rowBg, fade] = await row(page, 'session-2').evaluate(item => [getComputedStyle(item).backgroundColor, getComputedStyle(item.parentElement!).getPropertyValue('--row-bg')]);
    expect(rowBg).not.toBe('rgba(0, 0, 0, 0)');
    const probe = await page.evaluate(value => { const el = document.createElement('div'); el.style.background = value; document.body.append(el); const color = getComputedStyle(el).backgroundColor; el.remove(); return color; }, fade.trim());
    expect(probe).toBe(rowBg);
  });

  test('the archive heading count matches the other sections', async ({ page }) => {
    await open(page);
    await page.getByRole('button', { name: 'Archived tasks', exact: true }).click();
    await expect(section(page, 'archived').locator('.section-heading .section-count')).toHaveCount(1);
  });

  test('the sort menu fits a 720px window, with tasks per project as one segmented row', async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 720 });
    await open(page);
    await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Sort and view', exact: true });
    const flat = dialog.getByRole('group', { name: 'Group', exact: true }).getByRole('menuitemradio', { name: 'Flat list', exact: true });
    await expect(flat).toBeInViewport();
    expect(await dialog.locator('.choice-menu-list').evaluate(list => list.scrollHeight <= list.clientHeight)).toBe(true);
    const perProject = dialog.getByRole('group', { name: 'Show per project', exact: true });
    await expect(perProject.getByRole('menuitemradio')).toHaveText(['3', '6', '10', '15']);
    await expect(perProject.getByRole('menuitemradio', { name: '6 tasks', exact: true })).toHaveAttribute('aria-checked', 'true');
    // ← and → move along the row; Enter picks.
    await perProject.getByRole('menuitemradio', { name: '6 tasks', exact: true }).focus();
    await page.keyboard.press('ArrowRight');
    await expect(perProject.getByRole('menuitemradio', { name: '10 tasks', exact: true })).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(dialog).toBeHidden();
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.sidebar.sort')!).perProject)).toBe(10);
  });
});
