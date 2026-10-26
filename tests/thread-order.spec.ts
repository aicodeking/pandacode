import { expect, test, type Page } from '@playwright/test';

const KEY = 'pandacode.preview.threadOrder';
const row = (page: Page, id: string) => page.locator(`.task-item[data-id="${id}"]`);
const group = (page: Page, name: string) => page.locator(`[data-thread-group="${name}"]`);
const menu = (page: Page) => page.getByRole('dialog', { name: 'Task actions', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const ids = (page: Page, name: string) => group(page, name).locator('.task-item').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id));
// Unpinned tasks sit in one folder per project: orbit holds sessions 1–3, pandacode holds session 4.
const ORBIT = 'project:project-1', PANDACODE = 'project:project-2';

async function open(page: Page, seed = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    expect(source).toMatch(/const providers\s*=/);
    expect(source).toMatch(/switch\s*\(command\)\s*\{/);
    const body = source.replace(/const providers\s*=/, `${seed}\nconst providers =`).replace(/switch\s*\(command\)\s*\{/, `
      (window.__threadOrderCalls ??= []).push({command,args:structuredClone(args)});
      if (['pin_session','reorder_sessions'].includes(command)) {
        if (window.__holdThreadOrder) {
          window.__holdThreadOrder = false;
          await new Promise(resolve => { window.__releaseThreadOrder = resolve; });
        }
        if (window.__failThreadOrder === command) throw new Error('Could not save task order.');
      }
      if (command === 'send_message' && window.__holdOrderAgent) return;
      if (command === 'get_task' && args.sessionId === window.__holdThreadDetails) {
        window.__holdThreadDetails = undefined;
        const snapshot = structuredClone(session(args.sessionId));
        return await new Promise(resolve => { window.__releaseThreadDetails = () => resolve(snapshot); });
      }
      switch (command) {`);
    await route.fulfill({ response, body: body + '\nwindow.__threadOrderUrl = import.meta.url; window.__threadOrderEmit = emit;\n' });
  });
  await page.goto('/');
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  await expect(prompt(page)).toBeEnabled();
}

async function choosePin(page: Page, id: string, pinned = true): Promise<void> {
  await row(page, id).click({ button: 'right' });
  await menu(page).getByRole('menuitem', { name: pinned ? 'Pin task' : 'Unpin task', exact: true }).click();
  await expect(page.locator('#navigation')).toHaveAttribute('aria-busy', 'false');
}

async function saved(page: Page): Promise<any[]> {
  return page.evaluate(async () => (await import((window as any).__threadOrderUrl)).invoke('list_sessions', {}));
}

async function calls(page: Page, command: string): Promise<any[]> {
  return page.evaluate(command => ((window as any).__threadOrderCalls ?? []).filter((item: any) => item.command === command), command);
}

async function dragBefore(page: Page, source: string, target: string): Promise<void> {
  const bounds = (await row(page, target).boundingBox())!;
  await row(page, source).dragTo(row(page, target), { targetPosition: { x: Math.min(30, bounds.width / 2), y: 3 } });
  await expect(page.locator('#navigation')).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('.drop-before,.drop-after,.task-dragging')).toHaveCount(0);
}

test.describe('thread order', () => {
  test('pins from row and task menus, preserves the selected draft, and remembers changes on reload', async ({ page, browserName }) => {
    await open(page);
    const before = await saved(page);
    await prompt(page).fill('Keep this unsent draft');
    const content = await page.locator('#transcript .agent-message').first().elementHandle();
    await choosePin(page, 'session-2');
    await expect(group(page, 'pinned')).toBeVisible();
    expect(await ids(page, 'pinned')).toEqual(['session-2']);
    await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
    await expect(prompt(page)).toHaveValue('Keep this unsent draft');
    expect(await content!.evaluate(node => node === document.querySelector('#transcript .agent-message'))).toBe(true);
    const after = await saved(page);
    const timestamps = (tasks: any[]) => tasks.map(task => [task.id, task.updatedAt, task.lastResponseAt, task.lastPromptAt]).sort((a, b) => a[0].localeCompare(b[0]));
    expect(timestamps(after)).toEqual(timestamps(before));
    await page.screenshot({ path: `/private/tmp/pandacode-thread-pinned-${browserName}.png`, animations: 'disabled' });
    await page.reload();
    await expect(group(page, 'pinned').locator('.task-item')).toHaveAttribute('data-id', 'session-2');
    await row(page, 'session-2').click();
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await menu(page).getByRole('menuitem', { name: 'Unpin task', exact: true }).click();
    await expect(group(page, 'pinned')).toHaveCount(0);
    await page.reload();
    await expect(group(page, 'pinned')).toHaveCount(0);
    const metadata = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!), KEY);
    expect(metadata.every((entry: object) => Object.keys(entry).sort().join(',') === 'id,pinned,sidebarOrder')).toBe(true);
  });

  test('drags rows and reorders by keyboard without changing selection, then restores their order', async ({ page }) => {
    await open(page);
    expect(await ids(page, ORBIT)).toEqual(['session-1', 'session-2', 'session-3']);
    await dragBefore(page, 'session-3', 'session-1');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
    await row(page, 'session-2').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-2', 'session-1']);
    await expect(row(page, 'session-2')).toBeFocused();
    await page.reload();
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-2', 'session-1']);
    await row(page, 'session-3').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page).getByRole('menuitem', { name: 'Move up', exact: true })).toBeDisabled();
    await menu(page).getByRole('menuitem', { name: 'Move down', exact: true }).click();
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-2', 'session-3', 'session-1']);
  });

  test('keeps hidden project tasks in their slots when reordering a filtered group', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pandacode.projectFilter', 'project-1'));
    await open(page, `for (const [index,id] of ['session-1','session-4','session-2','session-3'].entries()) { session(id).lastResponseAt = now - (index + 1) * 1000; }`);
    expect(await ids(page, ORBIT)).toEqual(['session-1', 'session-2', 'session-3']);
    await expect(row(page, 'session-4')).toHaveCount(0);
    await expect(group(page, PANDACODE)).toHaveCount(0);
    await dragBefore(page, 'session-3', 'session-1');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    expect((await calls(page, 'reorder_sessions'))[0].args.sessionIds).toEqual(['session-3', 'session-1', 'session-2']);
    expect((await saved(page)).find(task => task.id === 'session-4').sidebarOrder).toBe(1);
    await page.locator('[data-action="show-all-projects"]').click();
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    expect(await ids(page, PANDACODE)).toEqual(['session-4']);
    await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  });

  test('ignores drops across pinned and project folders', async ({ page }) => {
    await open(page);
    await choosePin(page, 'session-2');
    await row(page, 'session-3').dragTo(row(page, 'session-2'));
    await row(page, 'session-4').dragTo(row(page, 'session-1'));
    expect(await calls(page, 'reorder_sessions')).toEqual([]);
    expect(await ids(page, 'pinned')).toEqual(['session-2']);
    expect(await ids(page, ORBIT)).toEqual(['session-1', 'session-3']);
    expect(await ids(page, PANDACODE)).toEqual(['session-4']);
    await expect(page.locator('.drop-before,.drop-after,.task-dragging')).toHaveCount(0);
  });

  test('keeps the current order when saving fails and allows a retry', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__failThreadOrder = 'pin_session'; });
    await choosePin(page, 'session-2');
    await expect(page.locator('#toast')).toContainText('Could not save task order.');
    await expect(group(page, 'pinned')).toHaveCount(0);
    await page.evaluate(() => { (window as any).__failThreadOrder = 'reorder_sessions'; });
    await row(page, 'session-3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect(page.locator('#navigation')).toHaveAttribute('aria-busy', 'false');
    expect(await ids(page, ORBIT)).toEqual(['session-1', 'session-2', 'session-3']);
    await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
    await page.evaluate(() => { (window as any).__failThreadOrder = undefined; });
    await row(page, 'session-3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-1', 'session-3', 'session-2']);
  });

  test('pin completion preserves newer streaming activity and the response DOM', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__holdOrderAgent = true; });
    await prompt(page).fill('Keep working while I pin this task');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await page.evaluate(() => { (window as any).__holdThreadOrder = true; });
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await menu(page).getByRole('menuitem', { name: 'Pin task', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseThreadOrder)).toBe('function');
    await page.evaluate(() => (window as any).__threadOrderEmit('agent-event', { sessionId: 'session-1', kind: 'text', text: 'The response keeps streaming.' }));
    await expect(page.locator('#transcript')).toContainText('The response keeps streaming.');
    const stream = await page.locator('.streaming-content').last().elementHandle();
    await page.evaluate(() => (window as any).__releaseThreadOrder());
    await expect(row(page, 'session-1')).toHaveAttribute('data-pinned', 'true');
    // A running agent is listed under Active, pinned or not.
    await expect.poll(() => ids(page, 'active')).toEqual(['session-1']);
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    expect(await stream!.evaluate(node => node.isConnected)).toBe(true);
    await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
    expect(await calls(page, 'stop_session')).toEqual([]);
  });

  test('deleting a pinned task removes its saved sidebar preference', async ({ page }) => {
    await open(page);
    await choosePin(page, 'session-2');
    await row(page, 'session-2').click();
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await menu(page).getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
    await page.getByRole('dialog', { name: 'Delete task?', exact: true }).getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(row(page, 'session-2')).toHaveCount(0);
    expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).some((task: any) => task.id === 'session-2'), KEY)).toBe(false);
  });

  test('a delayed reorder does not take focus away from another task row', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__holdThreadOrder = true; });
    await row(page, 'session-3').focus();
    await page.keyboard.press('Alt+ArrowUp');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseThreadOrder)).toBe('function');
    await row(page, 'session-4').focus();
    await page.evaluate(() => (window as any).__releaseThreadOrder());
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-1', 'session-3', 'session-2']);
    await expect(row(page, 'session-4')).toBeFocused();
  });

  test('the context menu keeps its anchor and returns focus after background activity updates', async ({ page }) => {
    await open(page);
    await row(page, 'session-3').focus();
    await page.keyboard.press('Shift+F10');
    await expect(menu(page)).toBeVisible();
    const anchor = await row(page, 'session-3').elementHandle();
    await page.evaluate(() => (window as any).__threadOrderEmit('agent-event', { sessionId: 'session-2', kind: 'text', text: 'Background agent is working.' }));
    await expect(row(page, 'session-2')).toHaveAttribute('data-activity', 'active');
    expect(await anchor!.evaluate(node => node === document.querySelector('.task-item[data-id="session-3"]'))).toBe(true);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await expect(row(page, 'session-3')).toBeFocused();
  });

  test('a stale task details response cannot undo a newer pin or saved rank', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__holdThreadDetails = 'session-2'; });
    await row(page, 'session-2').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseThreadDetails)).toBe('function');
    await choosePin(page, 'session-2');
    await expect(group(page, 'pinned').locator('[data-id="session-2"]')).toBeVisible();
    await page.evaluate(() => (window as any).__releaseThreadDetails());
    await expect(prompt(page)).toBeEnabled();
    await expect(group(page, 'pinned').locator('[data-id="session-2"]')).toBeVisible();
    await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
    expect((await saved(page)).find(task => task.id === 'session-2').pinned).toBe(true);
  });

  test('a task created after a manual reorder appears at the top of its folder', async ({ page }) => {
    await open(page);
    await dragBefore(page, 'session-3', 'session-1');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    const created = await page.evaluate(async () => {
      const preview = await import((window as any).__threadOrderUrl);
      const task = await preview.invoke('create_board_task', { projectId: 'project-1', provider: 'claude', model: 'sonnet', mode: 'full', title: 'Brand new task', description: '' });
      (window as any).__threadOrderEmit('sessions-changed', {});
      return task.id as string;
    });
    await expect.poll(() => ids(page, ORBIT)).toEqual([created, 'session-3', 'session-1', 'session-2']);
  });

  test('the sort menu orders tasks by activity or creation, turns off dragging, and is remembered', async ({ page }) => {
    await open(page, `session('session-2').createdAt = now - 400000;`);
    await dragBefore(page, 'session-3', 'session-1');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    const sort = page.getByRole('button', { name: 'Sort and view', exact: true });
    const choose = async (group: string, label: string) => {
      await sort.click();
      await page.getByRole('dialog', { name: 'Sort and view', exact: true }).getByRole('group', { name: group, exact: true }).getByRole('menuitemradio', { name: label, exact: true }).click();
    };
    await choose('Sort tasks', 'Recent activity');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-1', 'session-2', 'session-3']);
    await expect(row(page, 'session-1')).toHaveAttribute('draggable', 'false');
    await row(page, 'session-1').click({ button: 'right' });
    await expect(menu(page).getByRole('menuitem', { name: 'Move down', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await choose('Sort tasks', 'Created');
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-2', 'session-1', 'session-3']);
    const created = await ids(page, ORBIT);
    await choose('Show per project', '3 tasks');
    await page.reload();
    await expect.poll(() => ids(page, ORBIT)).toEqual(created);
    await sort.click();
    const dialog = page.getByRole('dialog', { name: 'Sort and view', exact: true });
    await expect(dialog.getByRole('group', { name: 'Sort tasks', exact: true }).getByRole('menuitemradio', { name: 'Created', exact: true })).toHaveAttribute('aria-checked', 'true');
    await expect(dialog.getByRole('group', { name: 'Show per project', exact: true }).getByRole('menuitemradio', { name: '3 tasks', exact: true })).toHaveAttribute('aria-checked', 'true');
    await dialog.getByRole('group', { name: 'Sort tasks', exact: true }).getByRole('menuitemradio', { name: 'Manual', exact: true }).click();
    await expect.poll(() => ids(page, ORBIT)).toEqual(['session-3', 'session-1', 'session-2']);
    await expect(row(page, 'session-1')).toHaveAttribute('draggable', 'true');
  });

  test('projects sort by name and keep their place when a task starts running', async ({ page }) => {
    await open(page);
    const folders = () => page.locator('#navigation .folder-group').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.project));
    await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
    await page.getByRole('group', { name: 'Sort projects', exact: true }).getByRole('menuitemradio', { name: 'Name', exact: true }).click();
    await expect.poll(folders).toEqual(['project-1', 'project-2']);
    await expect(page.locator('.folder-heading').first()).toContainText('orbit');
  });

  test('a flat list replaces folders and names each row’s project; selected options show a trailing check', async ({ page }) => {
    await open(page);
    const sort = page.getByRole('button', { name: 'Sort and view', exact: true });
    await sort.click();
    const dialog = page.getByRole('dialog', { name: 'Sort and view', exact: true });
    const manual = dialog.getByRole('group', { name: 'Sort tasks', exact: true }).getByRole('menuitemradio', { name: 'Manual', exact: true });
    await expect(manual).toHaveAttribute('aria-checked', 'true');
    await expect(manual.locator('svg.icon').last()).toBeVisible();
    // On, but not the highlighted row: no fill, only the check.
    const recent = dialog.getByRole('group', { name: 'Sort projects', exact: true }).getByRole('menuitemradio', { name: 'Recent activity', exact: true });
    await expect(recent).toHaveAttribute('aria-checked', 'true');
    await expect(recent).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(recent.locator('svg.icon').last()).toBeVisible();
    expect((await dialog.boundingBox())!.width).toBe(280);
    await dialog.getByRole('group', { name: 'Group', exact: true }).getByRole('menuitemradio', { name: 'Flat list', exact: true }).click();
    await expect(page.locator('#navigation .folder-heading')).toHaveCount(0);
    await expect.poll(() => ids(page, 'all')).toEqual(['session-1', 'session-2', 'session-3', 'session-4']);
    // At the default width titles come first: the name hides (the tooltip keeps it), the icon stays.
    await expect(row(page, 'session-4').locator('.task-project-name')).toBeHidden();
    await expect(row(page, 'session-4').locator('.task-app-icon')).toBeVisible();
    await expect(row(page, 'session-4')).toHaveAttribute('title', /\npandacode/);
    // A wider sidebar shows the name in full.
    await page.evaluate(() => document.querySelector<HTMLElement>('.workspace')!.style.setProperty('--sidebar-width', '320px'));
    await expect(row(page, 'session-4').locator('.task-project-name')).toHaveText('pandacode');
    const name = await row(page, 'session-4').locator('.task-project-name').evaluate(node => node.scrollWidth <= node.clientWidth);
    expect(name).toBe(true);
    await page.reload();
    await expect(page.locator('#navigation .folder-heading')).toHaveCount(0);
  });

  test('projects can be arranged by hand: Alt+arrows move a folder and the order is remembered', async ({ page }) => {
    await open(page);
    const folders = () => page.locator('#navigation .folder-heading').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.project));
    expect(await folders()).toEqual(['project-1', 'project-2']);
    await expect(page.locator('.folder-heading').first()).toHaveAttribute('draggable', 'false');
    await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
    await page.getByRole('group', { name: 'Sort projects', exact: true }).getByRole('menuitemradio', { name: 'Manual', exact: true }).click();
    await expect(page.locator('.folder-heading').first()).toHaveAttribute('draggable', 'true');
    expect(await folders()).toEqual(['project-1', 'project-2']);
    await page.locator('.folder-heading[data-project="project-1"]').focus();
    await page.keyboard.press('Alt+ArrowDown');
    await expect.poll(folders).toEqual(['project-2', 'project-1']);
    await expect(page.locator('.folder-heading[data-project="project-1"]')).toBeFocused();
    await page.reload();
    await expect.poll(folders).toEqual(['project-2', 'project-1']);
    // Dragging a folder heading moves it too.
    await page.locator('.folder-heading[data-project="project-1"]').dragTo(page.locator('.folder-heading[data-project="project-2"]'), { targetPosition: { x: 30, y: 3 } });
    await expect.poll(folders).toEqual(['project-1', 'project-2']);
  });

  test('picking Projects: Manual from a flat list saves every project in its current order', async ({ page }) => {
    await open(page);
    const choose = async (group: string, name: string) => {
      await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
      await page.getByRole('group', { name: group, exact: true }).getByRole('menuitemradio', { name, exact: true }).click();
    };
    await choose('Group', 'Flat list');
    await expect(page.locator('#navigation .folder-heading')).toHaveCount(0);
    await choose('Sort projects', 'Manual');
    const saved = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.sidebar.projectOrder') ?? '[]'));
    expect(saved).toEqual(['project-1', 'project-2']);
    await choose('Group', 'By project');
    await expect.poll(() => page.locator('#navigation .folder-heading').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.project))).toEqual(['project-1', 'project-2']);
  });

  test('a right-click opens the task menu at the pointer; the … button keeps it on the row', async ({ page }) => {
    await open(page);
    const box = (await row(page, 'session-2').boundingBox())!;
    await row(page, 'session-2').click({ button: 'right', position: { x: 60, y: 6 } });
    let panel = (await menu(page).boundingBox())!;
    expect(Math.abs(panel.x - (box.x + 60))).toBeLessThan(2);
    expect(panel.y).toBeGreaterThan(box.y + 6);
    await page.keyboard.press('Escape');
    await expect(menu(page)).toBeHidden();
    await row(page, 'session-2').hover();
    await page.locator('#task-row-session-2 .task-more').click();
    panel = (await menu(page).boundingBox())!;
    expect(Math.abs(panel.x - box.x)).toBeLessThan(2);
    expect(panel.y).toBeGreaterThanOrEqual(box.y + box.height);
  });

  test('a right-click on a row’s tick, … or the gap beside them opens the app menu; again moves it', async ({ page }) => {
    await open(page);
    const actions = page.locator('#task-row-session-2 .task-actions');
    await row(page, 'session-2').hover();
    const area = (await actions.boundingBox())!;
    // The padding gap before the tick: the actions span itself, not a button.
    await actions.click({ button: 'right', position: { x: 4, y: area.height / 2 } });
    await expect(menu(page)).toBeVisible();
    await expect(menu(page).getByRole('menuitem', { name: 'Pin task', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    await row(page, 'session-2').hover();
    await page.locator('#task-row-session-2 .task-more').click({ button: 'right' });
    await expect(menu(page)).toBeVisible();
    const first = (await menu(page).boundingBox())!;
    // Right-clicking the same row elsewhere moves the open menu to the pointer instead of closing it.
    const box = (await row(page, 'session-2').boundingBox())!;
    await row(page, 'session-2').click({ button: 'right', position: { x: 30, y: 6 } });
    await expect(menu(page)).toBeVisible();
    await expect.poll(async () => Math.round((await menu(page).boundingBox())!.x)).toBe(Math.round(box.x + 30));
    expect(Math.round(first.x)).not.toBe(Math.round(box.x + 30));
    await expect(menu(page)).toHaveCount(1);
  });
});
