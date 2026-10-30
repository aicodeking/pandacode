import { expect, test, type Page } from '@playwright/test';

const group = (page: Page, id: string) => page.locator(`#navigation .project-tree-group[data-project="${id}"]`);
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const heading = (page: Page, id: string) => group(page, id).locator('.folder-heading');

async function open(page: Page, url = '/', seed = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace(/const providers\s*=/, `${seed}\nconst providers =`).replace(/switch\s*\(command\)\s*\{/, `
      if (['create_session','rename_project','remove_project'].includes(command)) (window.__projectTreeCalls ??= []).push({command,args:structuredClone(args)});
      switch (command) {`);
    await route.fulfill({ response, body: source + `
      window.__projectTreeChange = (id, status, taskStage) => { Object.assign(session(id), {status,taskStage}); emit('sessions-changed', undefined); };
    ` });
  });
  await page.goto(url);
  await expect(page.locator('#navigation .task-item[aria-current="page"]')).toHaveCount(1);
}

test('project sidebar shows each project with its own chats and ignores the old dropdown scope', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.projectFilter', 'project-1'));
  await open(page, '/', `projects.push({id:'empty-project',name:'Empty project',path:'/workspace/empty'});`);
  await expect(page.locator('#project-filter')).toBeHidden();
  await expect(group(page, 'project-1').locator('.task-item')).toHaveCount(3);
  await expect(group(page, 'project-2').locator('.task-item')).toHaveCount(1);
  await expect(row(page, 'session-4')).toBeVisible();
  await expect(group(page, 'empty-project')).toContainText('No chats yet');
  await expect(page.locator('#navigation > .active-group, #navigation > .review-group')).toHaveCount(0);
  await page.locator('#workspace-sidebar').screenshot({ path: testInfo.outputPath('project-sidebar.png') });
  await row(page, 'session-4').click();
  await expect(row(page, 'session-4')).toHaveAttribute('aria-current', 'page');
  await expect(group(page, 'project-1')).toBeVisible();
  await expect(row(page, 'session-1')).toBeVisible();
});

test('project sidebar remembers folds and reveals matching chats without changing the saved fold', async ({ page }) => {
  await open(page);
  await heading(page, 'project-2').click();
  await expect(heading(page, 'project-2')).toHaveAttribute('aria-expanded', 'false');
  await page.reload();
  await expect(heading(page, 'project-2')).toHaveAttribute('aria-expanded', 'false');
  const search = page.getByRole('searchbox', { name: 'Filter tasks', exact: true });
  await search.fill('pandacode');
  await expect(heading(page, 'project-2')).toHaveAttribute('aria-expanded', 'true');
  await expect(row(page, 'session-4')).toBeVisible();
  await expect(group(page, 'project-1')).toHaveCount(0);
  await heading(page, 'project-2').click();
  await search.fill('');
  await expect(heading(page, 'project-2')).toHaveAttribute('aria-expanded', 'false');
  await search.fill('no project or chat matches this');
  await expect(page.locator('#navigation')).toContainText('No tasks match');
});

test('project sidebar keeps running and finished chats in their project, with settled chats inside it', async ({ page }) => {
  await open(page, '/?sections');
  await expect(group(page, 'project-1').locator('.folder-running')).toBeVisible();
  await expect(group(page, 'project-1').locator('.task-item[data-id="sections-running"]')).toBeVisible();
  await page.evaluate(() => (window as any).__projectTreeChange('sections-running', 'idle', 'review'));
  await expect(group(page, 'project-1').locator('.task-item[data-id="sections-running"]')).toBeVisible();
  await expect(row(page, 'sections-running').locator('.task-indicator.running')).toHaveCount(0);
  const settled = group(page, 'project-1').getByRole('button', { name: 'Settled chats in orbit', exact: true });
  await expect(settled).toHaveAttribute('aria-expanded', 'false');
  await settled.click();
  await expect(settled).toHaveAttribute('aria-expanded', 'true');
  await expect(group(page, 'project-1').locator('.project-settled .task-item').first()).toBeVisible();
  await expect(page.locator('#navigation > .completed-group')).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Recent chats', exact: true })).toContainText('Explain the borrow checker');
  await expect(group(page, 'sections-chat-project')).toHaveCount(0);
});

test('project sidebar supports keyboard folding, task menus and project rename and removal', async ({ page }) => {
  await open(page);
  await row(page, 'session-1').focus();
  await page.keyboard.press('ArrowLeft');
  await expect(heading(page, 'project-1')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(heading(page, 'project-1')).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(heading(page, 'project-1')).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('dialog', { name: 'Project actions', exact: true });
  await menu.getByRole('menuitem', { name: 'Rename project…', exact: true }).click();
  await page.getByRole('textbox', { name: 'Project name', exact: true }).fill('My renamed project');
  await page.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(heading(page, 'project-1')).toContainText('My renamed project');
  await group(page, 'project-1').getByRole('button', { name: 'Project actions: My renamed project', exact: true }).click();
  await menu.getByRole('menuitem', { name: 'Remove project…', exact: true }).click();
  await expect(page.locator('#dialog')).toContainText('The folder stays on disk');
  await page.getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(group(page, 'project-1')).toHaveCount(0);
  await expect(group(page, 'project-2')).toBeVisible();
});

test('project sidebar starts a new chat in the chosen project and can switch to status grouping', async ({ page }) => {
  await open(page);
  await group(page, 'project-2').getByRole('button', { name: 'New chat in pandacode', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__projectTreeCalls?.find((call: any) => call.command === 'create_session')?.args.projectId)).toBe('project-2');
  await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sort and view', exact: true }).getByRole('menuitemradio', { name: 'Status', exact: true }).click();
  await expect(page.locator('#project-filter')).toBeVisible();
  await expect(page.locator('#navigation .project-tree-group')).toHaveCount(0);
  await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
  await page.getByRole('dialog', { name: 'Sort and view', exact: true }).getByRole('menuitemradio', { name: 'Projects', exact: true }).click();
  await expect(group(page, 'project-1')).toBeVisible();
  await expect(group(page, 'project-2')).toBeVisible();
  await page.reload();
  await expect(group(page, 'project-2')).toBeVisible();
});

test('project sidebar keeps the open chat under the pointer when settling and reopening it', async ({ page }) => {
  await open(page);
  const selected = row(page, 'session-1');
  await selected.hover();
  await page.locator('#task-row-session-1').getByRole('button', { name: /^Settle:/ }).click();
  await expect(selected).toHaveAttribute('aria-current', 'page');
  await expect(group(page, 'project-1').locator(':scope > .folder-tasks > #task-row-session-1')).toBeVisible();
  await row(page, 'session-2').click();
  const settled = group(page, 'project-1').getByRole('button', { name: 'Settled chats in orbit', exact: true });
  await settled.click();
  await expect(group(page, 'project-1').locator('.project-settled #task-row-session-1')).toBeVisible();
  await selected.click();
  await selected.hover();
  await page.locator('#task-row-session-1').getByRole('button', { name: /^Reopen:/ }).click();
  await expect(group(page, 'project-1').locator('.project-settled #task-row-session-1')).toBeVisible();
  await row(page, 'session-2').click();
  await expect(group(page, 'project-1').locator(':scope > .folder-tasks > #task-row-session-1')).toBeVisible();
});

test('project sidebar keeps pinned chats visible past the cap and reorders chats and folders manually', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.sidebar.sort', JSON.stringify({tasks:'manual',projects:'manual',perProject:3,group:'project'})));
  await open(page, '/?sections', `for (const task of sessions) if (task.projectId === 'project-1' && task.taskStage !== 'completed') task.pinned = true;`);
  await expect(row(page, 'sections-pinned')).toBeVisible();
  await expect(row(page, 'sections-many-6')).toBeVisible();
  await heading(page, 'project-2').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(page.locator('#navigation .folder-heading').first()).toHaveAttribute('data-project', 'project-2');
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.sidebar.projectOrder') || '[]')[0])).toBe('project-2');
  await page.reload();
  await expect(page.locator('#navigation .folder-heading').first()).toHaveAttribute('data-project', 'project-2');
});

test('project sidebar reorders chats within their project without changing selection', async ({ page }) => {
  await open(page);
  await row(page, 'session-2').focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => group(page, 'project-1').locator(':scope > .folder-tasks > .task-row > .task-item').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id))).toEqual(['session-2', 'session-1', 'session-3']);
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  await page.reload();
  await expect(group(page, 'project-1').locator(':scope > .folder-tasks > .task-row > .task-item').first()).toHaveAttribute('data-id', 'session-2');
});
