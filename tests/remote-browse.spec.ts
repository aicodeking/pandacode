import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

/* Another computer's projects and tasks, shown here (remote/browse.rs; the preview mocks
 * `remote_browse` in src/preview.ts): Open project lists your other computers, a shown
 * computer's tasks open like any mirror, and a New task in one of its projects starts there,
 * by project, with no GitHub check of a local checkout. */

async function signIn(page: Page) {
  test.slow();
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click(); await page.getByRole('tab', { name: 'Remote access' }).click();
  const panel = page.getByRole('tabpanel', { name: 'Remote access' });
  await panel.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(panel.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
}
async function showNas(page: Page) {
  await page.getByRole('button', { name: 'Open project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open project' });
  const computers = dialog.getByRole('list', { name: 'On another computer' });
  await expect(computers.getByRole('listitem')).toHaveCount(3);
  // Offline computers are listed, but can't be shown until they are back.
  await expect(computers.getByRole('button', { name: 'Show projects on Old laptop' })).toBeDisabled();
  await computers.getByRole('button', { name: 'Show projects on Home NAS' }).click();
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Showing 2 projects and 1 task from Home NAS')).toBeVisible();
}
const remoteTask = (page: Page) => page.locator('#navigation .task-item').filter({ hasText: 'Fix the flaky upload test' });

test('another computer’s projects and tasks show here, and its tasks open like any other', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  expect(await page.evaluate(() => (window as any).__remoteBrowses)).toEqual([{ deviceId: 'dev-nas', show: true }]);

  // Its task is in the sidebar, marked as running on that computer.
  await expect(remoteTask(page).locator('.task-remote')).toHaveAttribute('aria-label', 'Runs on Home NAS');
  await remoteTask(page).click();
  await expect(page.locator('#transcript')).toContainText("raced the upload's progress callback");
  await expect(page.locator('#composer-area .composer-computer-fixed')).toHaveText('on Home NAS');
  // Its changes come from that computer, for review only (remote/inspect.rs).
  await page.locator('[data-action="tab-changes"]').click();
  await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  await expect.poll(() => page.evaluate(() => ((window as any).__remoteInspects ?? []).filter((call: { sessionId: string }) => call.sessionId === 'remote-dev-nas-task-1').length)).toBeGreaterThan(0);

  // Its projects are in the filter, located on that computer, not in a folder here.
  await page.getByRole('button', { name: 'Filter projects' }).click();
  const atlas = page.getByRole('menuitemradio', { name: /atlas/ });
  await expect(atlas).toContainText('On Home NAS');
  await expect(page.getByRole('menuitemradio', { name: /field-notes/ })).toContainText('On Home NAS');
});

test('a New task in another computer’s project starts there by project', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: /atlas/ }).click();
  await page.locator('.new-task-button').click();
  // The computer is the project's, fixed: there is no Run on menu to change it.
  const chip = page.locator('#composer-area .composer-computer-fixed');
  await expect(chip).toHaveText('on Home NAS');
  await expect(chip).toHaveAttribute('data-tip', 'This project is on Home NAS, so its tasks run there.');
  await expect(page.locator('#composer-computer')).toHaveCount(0);
  // Nothing of it is on this disk: until the task exists there, the inspector says where it is.
  await page.locator('[data-action="tab-changes"]').click();
  await expect(page.locator('#inspector-content')).toContainText('Start the task to review its changes and files here.');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Add a retry to the upload client');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__remoteStarts?.length ?? 0)).toBe(1);
  const started = await page.evaluate(() => (window as any).__remoteStarts[0]);
  expect(started).toMatchObject({ deviceId: 'dev-nas', projectId: 'remote-dev-nas-atlas', prompt: 'Add a retry to the upload client', worktree: false });
  // A remote project has no local checkout to compare with GitHub.
  expect(await page.evaluate(() => (window as any).__remoteRepoChecks ?? [])).toEqual([]);
});

test('a New task in another computer’s project can start in a new worktree there', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: /atlas/ }).click();
  await page.locator('.new-task-button').click();
  const checkout = page.locator('#remote-checkout');
  await expect(checkout).toHaveAccessibleName('Checkout: Project folder on Home NAS');
  await checkout.click();
  await page.getByRole('menuitemradio', { name: 'New worktree' }).click();
  // New worktree opens its branch list at once; dismissing it keeps the default branch.
  await expect(page.getByRole('dialog', { name: 'Branches on Home NAS' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Branches on Home NAS' })).toHaveCount(0);
  await expect(checkout).toHaveAccessibleName('Checkout: New worktree on Home NAS');
  await expect(checkout).toHaveAttribute('data-checkout', 'worktree');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Try the retry in isolation');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__remoteStarts?.length ?? 0)).toBe(1);
  expect(await page.evaluate(() => (window as any).__remoteStarts[0])).toMatchObject({ deviceId: 'dev-nas', projectId: 'remote-dev-nas-atlas', worktree: true });
});

test('Stop showing a computer removes its projects and task copies here', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await expect(remoteTask(page)).toHaveCount(1);
  await page.getByRole('button', { name: 'Open project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open project' });
  await dialog.getByRole('button', { name: 'Stop showing Home NAS' }).click();
  await expect(page.getByText('No longer showing Home NAS')).toBeVisible();
  await expect(remoteTask(page)).toHaveCount(0);
  // The dialog comes back with the computer offered again.
  await expect(page.getByRole('dialog', { name: 'Open project' }).getByRole('button', { name: 'Show projects on Home NAS' })).toBeEnabled();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await expect(page.getByRole('menuitemradio', { name: /atlas/ })).toHaveCount(0);
});

test('a computer that can’t be reached is reported, and nothing is shown', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => { (window as any).__remoteBrowseFail = 'That computer is offline.'; });
  await page.getByRole('button', { name: 'Open project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open project' });
  await dialog.getByRole('button', { name: 'Show projects on Home NAS' }).click();
  await expect(page.getByText('That computer is offline.')).toBeVisible();
  await expect(dialog).toBeVisible();
  await expect(remoteTask(page)).toHaveCount(0);
});

test('the project filter narrows the sidebar to one computer, and choosing it refreshes that computer', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  const local = page.locator('#navigation .task-item').filter({ hasNotText: 'Fix the flaky upload test' });
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: 'Home NAS' }).click();
  await expect(page.getByRole('button', { name: 'Filter projects' })).toContainText('Home NAS');
  await expect(remoteTask(page)).toHaveCount(1);
  await expect(local).toHaveCount(0);
  // Choosing the computer asked it for its list again, quietly.
  await expect.poll(() => page.evaluate(() => (window as any).__remoteBrowses.length)).toBe(2);
  expect(await page.evaluate(() => (window as any).__remoteBrowses[1])).toEqual({ deviceId: 'dev-nas', show: true });
  // This computer: only its own tasks, and only its own projects in the menu.
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: 'This computer' }).click();
  await expect(page.getByRole('button', { name: 'Filter projects' })).toContainText('This computer');
  await expect(remoteTask(page)).toHaveCount(0);
  await expect(local.first()).toBeVisible();
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await expect(page.getByRole('menuitemradio', { name: /atlas/ })).toHaveCount(0);
  await page.getByRole('menuitemradio', { name: 'All projects' }).click();
  await expect(remoteTask(page)).toHaveCount(1);
});

test('a computer out of reach marks its tasks and projects offline', async ({ page }) => {
  await signIn(page);
  // The preview can take Studio iMac offline (`__remoteOnline`).
  await page.getByRole('button', { name: 'Open project' }).click();
  await page.getByRole('dialog', { name: 'Open project' }).getByRole('button', { name: 'Show projects on Studio iMac' }).click();
  const studioTask = page.locator('#navigation .task-item').filter({ hasText: 'Fix the flaky upload test' });
  await expect(studioTask.locator('.task-remote')).toHaveAttribute('aria-label', 'Runs on Studio iMac');
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  await expect(studioTask.locator('.task-remote')).toHaveAttribute('aria-label', 'Runs on Studio iMac · Offline');
  await expect(studioTask.locator('.task-remote')).toHaveClass(/is-offline/);
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await expect(page.getByRole('menuitemradio', { name: /atlas/ })).toContainText('On Studio iMac · Offline');
  await expect(page.getByRole('menuitemradio', { name: 'Studio iMac' })).toContainText('Offline');
  await page.keyboard.press('Escape');
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', true));
  await expect(studioTask.locator('.task-remote')).toHaveAttribute('aria-label', 'Runs on Studio iMac');
});

test('showing a computer says it is loading, and a shown computer can be refreshed', async ({ page }) => {
  await signIn(page);
  await page.evaluate(() => { (window as any).__remoteBrowseHold = true; });
  await page.getByRole('button', { name: 'Open project' }).click();
  const dialog = page.getByRole('dialog', { name: 'Open project' });
  const nas = dialog.getByRole('listitem').filter({ hasText: 'Home NAS' });
  await nas.getByRole('button', { name: 'Show projects on Home NAS' }).click();
  await expect(nas).toHaveAttribute('aria-busy', 'true');
  await expect(nas).toContainText('Asking Home NAS for its projects…');
  await expect(nas.getByRole('button', { name: 'Show projects on Home NAS' })).toHaveText('Loading…');
  await page.evaluate(() => (window as any).__remoteBrowseRelease());
  await expect(dialog).toBeHidden();
  await expect(page.getByText('Showing 2 projects and 1 task from Home NAS')).toBeVisible();
  // Refresh asks again and keeps the dialog open.
  await page.getByRole('button', { name: 'Open project' }).click();
  await page.getByRole('dialog', { name: 'Open project' }).getByRole('button', { name: 'Refresh Home NAS' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteBrowses.length)).toBe(2);
  await expect(page.getByRole('dialog', { name: 'Open project' }).getByRole('button', { name: 'Refresh Home NAS' })).toBeEnabled();
});

test('settling a task from another computer settles it there too', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await remoteTask(page).hover();
  await remoteTask(page).locator('xpath=..').getByRole('button', { name: /^Settle: Fix the flaky upload test/ }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteStages ?? [])).toEqual([{ sessionId: 'remote-dev-nas-task-1', deviceId: 'dev-nas', stage: 'completed' }]);
});

test('a host that refuses a settle leaves the task as it was', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await page.evaluate(() => { (window as any).__remoteStageFail = 'Turn on Full access for remote tasks on that computer to settle this task.'; });
  await remoteTask(page).hover();
  await remoteTask(page).locator('xpath=..').getByRole('button', { name: /^Settle: Fix the flaky upload test/ }).click();
  await expect(page.getByText('Turn on Full access for remote tasks on that computer to settle this task.')).toBeVisible();
  await expect(remoteTask(page).locator('xpath=..').getByRole('button', { name: /^Settle: Fix the flaky upload test/ })).toBeAttached();
});

test('a computer on an older PandaCode is not asked to run a task in its project folder', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await page.evaluate(() => { (window as any).__remoteOlderHost = true; });
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: /atlas/ }).click();
  await page.locator('.new-task-button').click();
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Fix it in place');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect(page.getByText('Update PandaCode on Home NAS, or choose Runs in → New worktree.', { exact: false }).first()).toBeVisible();
  expect(await page.evaluate(() => (window as any).__remoteStarts ?? [])).toEqual([]);
  // A worktree is what that computer does anyway, so it goes.
  await page.locator('#remote-checkout').click();
  await page.getByRole('menuitemradio', { name: 'New worktree' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Fix it in a worktree');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__remoteStarts?.length ?? 0)).toBe(1);
});

const rowMenu = (page: Page) => page.getByRole('dialog', { name: 'Task actions', exact: true });
async function openAtlasDraft(page: Page) {
  await page.getByRole('button', { name: 'Filter projects' }).click();
  await page.getByRole('menuitemradio', { name: /atlas/ }).click();
  await page.locator('.new-task-button').click();
}

test('@-mentions in another computer’s project search its files there', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await openAtlasDraft(page);
  await page.getByRole('textbox', { name: 'Message your coding agent' }).pressSequentially('Look at @sea');
  await expect.poll(() => page.evaluate(() => ((window as any).__remoteSearches ?? []).map((call: { projectId: string }) => call.projectId))).toContain('remote-dev-nas-atlas');
});

test('a remote task’s files open read only, with nothing to save, edit or open here', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await remoteTask(page).click();
  await openInspectorTab(page, 'tab-files');
  const readme = page.locator('#inspector-content .file-row > button:first-child[data-path="README.md"]');
  // Another computer's file can't be read here to attach.
  await expect(page.locator('#inspector-content [data-action="attach-file"]')).toHaveCount(0);
  // The explorer's menu only copies the project-relative path.
  await readme.click({ button: 'right' });
  const actions = page.getByRole('dialog', { name: 'README.md' });
  await expect(actions.getByRole('menuitem')).toHaveCount(1);
  await expect(actions.getByRole('menuitem', { name: 'Copy Path' })).toBeVisible();
  await page.keyboard.press('Escape');
  await readme.click();
  const view = page.locator('#file-view');
  await expect(view.locator('.file-view-remote')).toHaveText('Read only · on Home NAS');
  await expect(view.locator('[data-file-tab="save"], [data-file-tab="edit"], [data-file-tab="attach"]')).toHaveCount(0);
});

test('renaming and pinning a task from another computer does it there too', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await remoteTask(page).click({ button: 'right' });
  await rowMenu(page).getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteChanges ?? [])).toEqual([{ method: 'thread.pin', sessionId: 'remote-dev-nas-task-1', pinned: true }]);
  await page.locator('#navigation .task-item').filter({ hasText: 'Fix the flaky upload test' }).click({ button: 'right' });
  await rowMenu(page).getByRole('menuitem', { name: 'Rename…', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename task', exact: true });
  await dialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Upload retries');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => page.evaluate(() => ((window as any).__remoteChanges ?? []).at(-1))).toEqual({ method: 'thread.rename', sessionId: 'remote-dev-nas-task-1', title: 'Upload retries' });
});

test('a New worktree in another computer’s project can start from one of its branches', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await openAtlasDraft(page);
  const checkout = page.locator('#remote-checkout');
  await checkout.click();
  await page.getByRole('menuitemradio', { name: 'New worktree' }).click();
  const branches = page.getByRole('dialog', { name: 'Branches on Home NAS' });
  await expect(branches.getByRole('menuitemradio', { name: 'feat/upload-retry' })).toContainText('Checked out there');
  await branches.getByRole('menuitemradio', { name: 'release/2.4' }).click();
  await expect(checkout).toHaveAccessibleName('Checkout: New worktree from release/2.4 on Home NAS');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).fill('Backport the retry');
  await page.getByRole('textbox', { name: 'Message your coding agent' }).press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__remoteStarts?.length ?? 0)).toBe(1);
  expect(await page.evaluate(() => (window as any).__remoteStarts[0])).toMatchObject({ projectId: 'remote-dev-nas-atlas', worktree: true, branch: 'release/2.4' });
});

test('a computer that can’t list its branches says why', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await openAtlasDraft(page);
  await page.evaluate(() => { (window as any).__remoteBranchesFail = 'Home NAS runs an older PandaCode, which can’t list a project’s branches. Update PandaCode there to choose one.'; });
  const checkout = page.locator('#remote-checkout');
  await checkout.click();
  await page.getByRole('menuitemradio', { name: 'New worktree' }).click();
  await expect(page.getByText('Update PandaCode there to choose one.', { exact: false }).first()).toBeVisible();
});


test('refresh reads an open remote file again even though its polling stamp is fixed', async ({ page }) => {
  await signIn(page);
  await showNas(page);
  await remoteTask(page).click();
  await openInspectorTab(page, 'tab-files');
  await page.evaluate(() => { (window as any).__remoteFileText = '# Before the remote edit'; });
  await page.locator('#inspector-content .file-row > button:first-child[data-path="README.md"]').click();
  await expect(page.locator('#file-view .doc-reader')).toContainText('Before the remote edit');
  await page.evaluate(() => { (window as any).__remoteFileText = '# After the remote edit'; });
  await page.locator('#inspector-refresh').click();
  await expect(page.locator('#file-view .doc-reader')).toContainText('After the remote edit');
});
