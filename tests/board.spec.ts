import { expect, test, type Page } from '@playwright/test';

// Keep the status/filter layout explicit; project-first navigation is covered by sidebar-projects.spec.ts.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => { const key = 'pandacode.sidebar.sort'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), group: 'flat' })); });
});
// The workspace view (Conversation, Board, GitHub) is picked from the sidebar's view menu.
const showView = async (page: Page, name: string) => { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name, exact: true }).click(); };

const board = (page: Page) => page.getByRole('region', { name: 'Project board', exact: true });
const column = (page: Page, name: string) => board(page).getByRole('region', { name, exact: true });
const card = (page: Page, title: string) => board(page).getByRole('button', { name: `Open task: ${title}`, exact: true });
const details = (page: Page) => page.getByRole('region', { name: 'Task details', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });

async function installPreviewProbe(page: Page, seed = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const callsMarker = /switch \(command\) \{/;
    const seedMarker = /const providers\s*=/;
    expect(source).toMatch(callsMarker);
    expect(source).toMatch(seedMarker);
    const body = source.replace(seedMarker, `${seed}\nconst providers =`).replace(callsMarker, `
      window.__boardCalls ??= [];
      window.__boardCalls.push({ command, args: structuredClone(args) });
      if (command === 'start_task' && window.__failBoardStart) throw new Error('The agent could not start. Try again.');
      if (command === 'create_board_task' && window.__failBoardCreate) throw new Error('The task could not be saved. Try again.');
      if (command === 'get_task' && args.sessionId === window.__delayBoardDetails) await new Promise(resolve => { window.__releaseBoardDetails = resolve; });
      if (command === 'create_board_task' && window.__delayBoardCreate) await new Promise(resolve => { window.__releaseBoardCreate = resolve; });
      switch (command) {`);
    await route.fulfill({ response, body: body + "\nwindow.__boardPreviewUrl = import.meta.url;\n" });
  });
}

async function calls(page: Page, command: string): Promise<any[]> {
  return page.evaluate(command => ((window as any).__boardCalls ?? []).filter((call: any) => call.command === command), command);
}

async function savedTask(page: Page, title: string): Promise<any> {
  return page.evaluate(async title => {
    const { invoke } = await import((window as any).__boardPreviewUrl);
    return (await invoke('list_sessions', {})).find((session: { title: string }) => session.title === title);
  }, title);
}

async function storedMessages(page: Page, sessionId: string): Promise<any[]> {
  return page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__boardPreviewUrl);
    return (await invoke('get_messages', { sessionId })).messages;
  }, sessionId);
}

async function openBoard(page: Page): Promise<void> {
  await showView(page, 'Board');
  await expect(board(page)).toBeVisible();
}

async function queueTask(page: Page, title: string, description = ''): Promise<void> {
  await board(page).getByRole('button', { name: 'Add task', exact: true }).click();
  const form = page.locator('#dialog');
  await form.getByRole('textbox', { name: 'Task title', exact: true }).fill(title);
  await form.getByRole('textbox', { name: 'Task description', exact: true }).fill(description);
  await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
  await expect(form).toBeHidden();
  await expect(column(page, 'Pending').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
}

test.describe('project board', () => {
  test.beforeEach(async ({ page }) => {
    await installPreviewProbe(page);
    await page.goto('/');
    await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  });

  test('switches views without losing the conversation draft and remembers the chosen view', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await prompt(page).fill('Keep this unsent conversation draft');
    await openBoard(page);
    for (const name of ['Pending', 'In progress', 'Review', 'Settled']) await expect(column(page, name)).toBeVisible();
    await showView(page, 'Conversation');
    await expect(board(page)).toBeHidden();
    await expect(prompt(page)).toHaveValue('Keep this unsent conversation draft');
    await openBoard(page);
    await page.reload();
    await expect(board(page)).toBeVisible();
    await showView(page, 'Conversation');
    await page.reload();
    await expect(board(page)).toBeHidden();
    await expect(prompt(page)).toBeVisible();
    expect(errors).toEqual([]);
  });

  test('uses the full window in Board while keeping the project filter available', async ({ page }) => {
    const sidebar = page.getByRole('complementary', { name: 'Projects and tasks', exact: true, includeHidden: true });
    const main = page.getByRole('main');
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => (await main.boundingBox())!.x).toBeGreaterThan(0);

    await openBoard(page);
    await expect(sidebar).toBeHidden();
    await expect.poll(async () => (await main.boundingBox())!.x).toBe(0);
    await expect.poll(async () => (await main.boundingBox())!.width).toBe(1440);
    const filter = board(page).getByRole('button', { name: 'Filter projects', exact: true });
    await expect(filter).toBeVisible();
    // There is no archive: settled work stays on the board.
    await expect(board(page).getByRole('button', { name: 'Archived tasks', exact: true })).toHaveCount(0);
    await filter.click();
    await page.getByRole('dialog', { name: 'Filter projects', exact: true }).getByRole('menuitemradio', { name: 'pandacode', exact: true }).click();
    await expect(card(page, 'Explore the project')).toBeVisible();
    await expect(card(page, 'Make search feel instant')).toHaveCount(0);
    await expect(board(page).getByRole('heading', { name: 'pandacode', exact: true })).toBeVisible();

    await showView(page, 'Conversation');
    await expect(sidebar).toBeVisible();
    await expect.poll(async () => (await main.boundingBox())!.x).toBeGreaterThan(0);
    await expect(sidebar.getByRole('button', { name: 'Filter projects', exact: true })).toContainText('pandacode');
    await expect(page.locator('.task-item.selected .task-title')).toHaveText('Explore the project');
  });

  test('queues a task in the last active project without starting the agent', async ({ page }) => {
    await page.locator('.task-item[data-id="session-4"]').click();
    await openBoard(page);
    await queueTask(page, 'Fix the settings keyboard order', 'Tab through every setting and preserve a logical focus order.');
    const task = await savedTask(page, 'Fix the settings keyboard order');
    expect(task).toMatchObject({ mode: 'full', projectId: 'project-2', taskStage: 'pending', taskDescription: 'Tab through every setting and preserve a logical focus order.', status: 'idle', archived: false, completedAt: null });
    expect(await storedMessages(page, task.id)).toEqual([]);
    expect(await calls(page, 'start_task')).toEqual([]);
    expect(await calls(page, 'send_message')).toEqual([]);
    await card(page, task.title).click();
    await expect(details(page)).toBeVisible();
    await expect(details(page)).toContainText(task.taskDescription);
    await expect(details(page).getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    await expect.poll(async () => (await details(page).boundingBox())!.x).toBeGreaterThan(500);
    await expect.poll(async () => { const bounds = (await details(page).boundingBox())!; return bounds.x + bounds.width; }).toBeLessThanOrEqual(1441);
    await page.screenshot({ path: '/private/tmp/pandacode-board-pending.png', animations: 'disabled' });
    await details(page).getByRole('button', { name: 'Close task details', exact: true }).click();
    await expect(details(page)).toBeHidden();
    await expect(card(page, task.title)).toBeVisible();
  });

  test('starts pending work, displays agent comments, requires review, and reopens settled work', async ({ page }) => {
    await openBoard(page);
    const title = 'Review search accessibility';
    const description = 'Check the search input label and keyboard navigation.';
    await queueTask(page, title, description);
    await card(page, title).click();
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(column(page, 'In progress').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
    await expect(details(page).getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    const started = await savedTask(page, title);
    expect(started.lastPromptAt).toBeGreaterThan(Date.now() - 10_000);
    await expect(page.locator(`.task-item[data-activity="active"][data-id="${started.id}"]`)).toHaveCount(1);
    await expect(column(page, 'Review').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
    const task = await savedTask(page, title);
    const messages = await storedMessages(page, task.id);
    expect(messages.filter(message => message.role === 'user').map(message => message.content)).toEqual([description]);
    expect(messages.some(message => message.role === 'assistant')).toBe(true);
    expect(task).toMatchObject({ taskStage: 'review', status: 'idle', completedAt: null, archived: false });
    await expect(details(page).locator('.agent-message').first()).toBeVisible();
    await expect(details(page)).toContainText('This is the browser preview.');
    await expect(details(page).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled();
    await page.screenshot({ path: '/private/tmp/pandacode-board-review.png', animations: 'disabled' });
    await details(page).getByRole('button', { name: 'Settle', exact: true }).click();
    await expect(column(page, 'Settled').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
    const completed = await savedTask(page, title);
    expect(completed.taskStage).toBe('completed');
    expect(completed.completedAt).toBeGreaterThan(Date.now() - 10_000);
    expect(completed.archived).toBe(false);
    await expect(page.locator(`.task-item[data-id="${task.id}"]`)).toHaveCount(0);
    await details(page).getByRole('button', { name: 'Reopen task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
    expect(await savedTask(page, title)).toMatchObject({ taskStage: 'review', completedAt: null, archived: false });
    await showView(page, 'Conversation');
    await expect(page.locator(`.task-item[data-id="${task.id}"]`)).toBeVisible();
    expect((await calls(page, 'start_task')).length).toBe(1);
  });

  test('edits queued task details before starting and sends the saved description', async ({ page }) => {
    await openBoard(page);
    await queueTask(page, 'Draft a readme', 'Initial scope.');
    await details(page).getByRole('button', { name: 'Edit task details', exact: true }).click();
    const form = page.locator('#dialog');
    await form.getByRole('textbox', { name: 'Task title', exact: true }).fill('Document local setup');
    await form.getByRole('textbox', { name: 'Task description', exact: true }).fill('Explain the install, dev, and test commands.');
    await form.getByRole('button', { name: 'Save details', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(card(page, 'Draft a readme')).toHaveCount(0);
    await expect(card(page, 'Document local setup')).toBeVisible();
    await expect(details(page)).toContainText('Explain the install, dev, and test commands.');
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Document local setup', exact: true })).toBeVisible();
    const task = await savedTask(page, 'Document local setup');
    expect((await storedMessages(page, task.id)).find(message => message.role === 'user')?.content).toBe('Explain the install, dev, and test commands.');
  });

  test('can reopen settled board work after switching back to the conversation view', async ({ page }) => {
    await page.unroute('**/src/preview.ts*');
    await installPreviewProbe(page, `Object.assign(sessions[1], { taskStage: 'completed', taskDescription: 'A completed navigation task.', completedAt: now });`);
    await page.reload();
    await openBoard(page);
    await column(page, 'Settled').getByRole('button', { name: 'Open task: Refine the navigation', exact: true }).click();
    await showView(page, 'Conversation');
    await page.getByRole('button', { name: 'Reopen task', exact: true }).click();
    await expect(prompt(page)).toBeEnabled();
    expect(await savedTask(page, 'Refine the navigation')).toMatchObject({ taskStage: 'review', completedAt: null });
    await openBoard(page);
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Refine the navigation', exact: true })).toBeVisible();
  });

  test('loads a long task description on demand and keeps its full instructions for editing and starting', async ({ page }) => {
    await openBoard(page);
    const title = 'Keep the full task context';
    const description = 'Preserve these detailed requirements and acceptance criteria. '.repeat(24) + 'End of the complete task scope.';
    await queueTask(page, title, description);
    await card(page, 'Make search feel instant').click();
    await card(page, title).click();
    await expect(details(page).locator('.task-description')).toHaveText(description);
    await details(page).getByRole('button', { name: 'Edit task details', exact: true }).click();
    const form = page.locator('#dialog');
    await expect(form.getByRole('textbox', { name: 'Task description', exact: true })).toHaveValue(description);
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: `Open task: ${title}`, exact: true })).toBeVisible();
    const task = await savedTask(page, title);
    expect((await storedMessages(page, task.id)).find(message => message.role === 'user')?.content).toBe(description);
    await expect(details(page).locator('.task-description')).toHaveText(description);
  });

  test('keeps pending work retryable when the harness fails to start', async ({ page }) => {
    await openBoard(page);
    await queueTask(page, 'Retry the build', 'Check the build.');
    await page.evaluate(() => { (window as any).__failBoardStart = true; });
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(page.getByText('The agent could not start. Try again.', { exact: true })).toBeVisible();
    await expect(column(page, 'Pending').getByRole('button', { name: 'Open task: Retry the build', exact: true })).toBeVisible();
    await expect(details(page).getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    const task = await savedTask(page, 'Retry the build');
    expect(task).toMatchObject({ taskStage: 'pending', status: 'idle', completedAt: null });
    expect(await storedMessages(page, task.id)).toEqual([]);
    await page.evaluate(() => { (window as any).__failBoardStart = false; });
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Retry the build', exact: true })).toBeVisible();
  });

  test('waits for full task metadata before enabling editing', async ({ page }) => {
    await openBoard(page);
    await page.evaluate(() => { (window as any).__delayBoardDetails = 'session-2'; });
    await card(page, 'Refine the navigation').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBoardDetails)).toBe('function');
    await expect(details(page).getByRole('button', { name: 'Edit task details', exact: true })).toBeDisabled();
    await page.evaluate(() => { (window as any).__delayBoardDetails = null; (window as any).__releaseBoardDetails(); });
    await expect(details(page).getByRole('button', { name: 'Edit task details', exact: true })).toBeEnabled();
    await details(page).getByRole('button', { name: 'Edit task details', exact: true }).click();
    await expect(page.locator('#dialog').getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue('Refine the navigation');
  });

  test('does not reopen a canceled creation form or replace the task selected while saving', async ({ page }) => {
    await openBoard(page);
    await board(page).getByRole('button', { name: 'Add task', exact: true }).click();
    const form = page.locator('#dialog');
    await form.getByRole('textbox', { name: 'Task title', exact: true }).fill('Save this task in the background');
    await form.getByRole('textbox', { name: 'Task description', exact: true }).fill('Do not change the selected conversation when saving finishes.');
    await page.evaluate(() => { (window as any).__delayBoardCreate = true; });
    await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBoardCreate)).toBe('function');
    await form.getByRole('button', { name: 'Cancel', exact: true }).click();
    await card(page, 'Explore the project').click();
    await prompt(page).fill('Keep the current task and this draft');
    await page.evaluate(() => { (window as any).__delayBoardCreate = false; (window as any).__releaseBoardCreate(); });
    await expect(card(page, 'Save this task in the background')).toBeVisible();
    await expect(form).toBeHidden();
    await expect(details(page).getByRole('heading', { name: 'Explore the project', exact: true })).toBeVisible();
    await expect(prompt(page)).toHaveValue('Keep the current task and this draft');
  });

  test('keeps stopped work in progress for retry instead of marking it ready for review', async ({ page }) => {
    await openBoard(page);
    await queueTask(page, 'Pause this task', 'Stop before the response finishes.');
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await details(page).getByRole('button', { name: 'Stop task', exact: true }).click();
    await expect(details(page).getByRole('button', { name: 'Start task', exact: true })).toBeEnabled();
    await expect(column(page, 'In progress').getByRole('button', { name: 'Open task: Pause this task', exact: true })).toBeVisible();
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Pause this task', exact: true })).toHaveCount(0);
    expect(await savedTask(page, 'Pause this task')).toMatchObject({ status: 'idle', taskStage: 'in_progress', completedAt: null });
    await details(page).getByRole('button', { name: 'Start task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Pause this task', exact: true })).toBeVisible();
  });

  test('keeps a failed queue form and its contents available for retry', async ({ page }) => {
    await openBoard(page);
    await board(page).getByRole('button', { name: 'Add task', exact: true }).click();
    const form = page.locator('#dialog');
    await form.getByRole('textbox', { name: 'Task title', exact: true }).fill('Keep my task');
    await form.getByRole('textbox', { name: 'Task description', exact: true }).fill('Keep this description on error.');
    await page.evaluate(() => { (window as any).__failBoardCreate = true; });
    await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
    await expect(page.getByText('The task could not be saved. Try again.', { exact: true })).toBeVisible();
    await expect(form.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue('Keep my task');
    await expect(form.getByRole('textbox', { name: 'Task description', exact: true })).toHaveValue('Keep this description on error.');
    await expect(form.getByRole('button', { name: 'Add to pending', exact: true })).toBeEnabled();
    await page.evaluate(() => { (window as any).__failBoardCreate = false; });
    await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
    await expect(form).toBeHidden();
    await expect(card(page, 'Keep my task')).toHaveCount(1);
  });

  test('opens a task with the keyboard and fits its panel in a narrow light-mode window', async ({ page }) => {
    await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
    await openBoard(page);
    await queueTask(page, 'Check compact layouts', 'Keep controls reachable at smaller window sizes.');
    await details(page).getByRole('button', { name: 'Close task details', exact: true }).click();
    await card(page, 'Check compact layouts').focus();
    await page.keyboard.press('Enter');
    await expect(details(page)).toBeVisible();
    await page.setViewportSize({ width: 900, height: 760 });
    await expect.poll(async () => (await details(page).boundingBox())!.x).toBeGreaterThanOrEqual(0);
    await expect.poll(async () => { const bounds = (await details(page).boundingBox())!; return bounds.x + bounds.width; }).toBeLessThanOrEqual(901);
    await expect(details(page).getByRole('button', { name: 'Start task', exact: true })).toBeVisible();
    await expect(details(page).getByRole('button', { name: 'Close task details', exact: true })).toBeVisible();
    await page.screenshot({ path: '/private/tmp/pandacode-board-light-compact.png', animations: 'disabled' });
  });

  test('a task still archived from older data is settled, and Reopen clears the flag', async ({ page }) => {
    await page.unroute('**/src/preview.ts*');
    await installPreviewProbe(page, `sessions.push({ ...sessions[1], id: 'old-archived', title: 'Archived long ago', taskStage: 'completed', completedAt: now - 604800001, archived: true, taskDescription: 'Saved task details', pinned: false, sidebarOrder: null, lastResponseAt: null });`);
    await page.reload();
    await openBoard(page);
    await expect(board(page)).not.toContainText('archive after');
    await column(page, 'Settled').getByRole('button', { name: 'Open task: Archived long ago', exact: true }).click();
    await expect(details(page)).toContainText('Saved task details');
    await details(page).getByRole('button', { name: 'Reopen task', exact: true }).click();
    await expect(column(page, 'Review').getByRole('button', { name: 'Open task: Archived long ago', exact: true })).toBeVisible();
    expect(await savedTask(page, 'Archived long ago')).toMatchObject({ archived: false, taskStage: 'review' });
  });
});

test('the sidebar view menu switches views, marks the current one and stays reachable', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  const trigger = page.getByRole('button', { name: 'Workspace view: Conversation', exact: true });
  await expect(page.locator('.sidebar .brand')).toContainText('PandaCode');
  await expect(page.locator('.sidebar .brand #view-menu')).toBeVisible();
  await expect(trigger).toHaveAttribute('aria-haspopup', 'menu');
  await expect(page.locator('.workspace-header .view-switch')).toHaveCount(0);
  await trigger.click();
  const items = page.getByRole('menuitemradio');
  await expect(items).toHaveText(['Conversation', 'Board', 'GitHub']);
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.locator('.workspace')).toHaveClass(/\bboard-view\b/);
  // The board hides the sidebar, so the menu moves into the header.
  const boardTrigger = page.locator('.header-leading #view-menu');
  await expect(boardTrigger).toBeVisible();
  await expect(boardTrigger).toHaveAttribute('aria-label', 'Workspace view: Board');
  await boardTrigger.click();
  await expect(page.getByRole('menuitemradio', { name: 'Board', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');
  await showView(page, 'Conversation');
  await expect(page.locator('.sidebar .brand #view-menu')).toBeVisible();
  // The narrow rail keeps it under the sidebar toggle.
  await page.setViewportSize({ width: 620, height: 800 });
  await expect(page.locator('.sidebar .brand #view-menu')).toBeVisible();
});

