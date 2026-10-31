import { expect, test, type Page } from '@playwright/test';

const title = 'Make search feel instant';
const confirmation = (page: Page) => page.getByRole('dialog', { name: 'Delete task?', exact: true });
const taskRow = (page: Page, id: string) => page.locator(`.task-item[data-id="${id}"]`);
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });

async function installDeletionProbe(page: Page, seed = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    expect(source).toMatch(/const providers\s*=/);
    expect(source).toMatch(/switch \(command\) \{/);
    const body = source.replace(/const providers\s*=/, `${seed}\nconst providers =`).replace(/switch \(command\) \{/, `
      (window.__deletionCalls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'delete_session') {
        if (window.__holdDeletion) await new Promise(resolve => { window.__releaseDeletion = resolve; });
        if (window.__failDeletion) throw new Error(window.__failDeletion);
      }
      if (command === 'get_messages' && args.sessionId === window.__holdDeletedHistory) {
        window.__holdDeletedHistory = null;
        const old = structuredClone({ messages: messages[args.sessionId] ?? [], hasOlder: false });
        return await new Promise(resolve => { window.__releaseDeletedHistory = () => resolve(old); });
      }
      switch (command) {`);
    await route.fulfill({ response, body: body + `
      window.__deletionPreviewUrl = import.meta.url;
      window.__deletionEmit = emit;
      window.__externalDelete = sessionIds => {
        sessions = sessions.filter(task => !sessionIds.includes(task.id));
        for (const sessionId of sessionIds) delete messages[sessionId];
        emit('sessions-deleted', { sessionIds });
      };
    ` });
  });
}

async function calls(page: Page, command: string): Promise<{ command: string; args: Record<string, unknown> }[]> {
  return page.evaluate(command => ((window as any).__deletionCalls ?? []).filter((call: any) => call.command === command), command);
}

async function stored(page: Page): Promise<{ sessions: { id: string; title: string; archived: boolean }[]; projects: { id: string; name: string; path: string }[] }> {
  return page.evaluate(async () => {
    const { invoke } = await import((window as any).__deletionPreviewUrl);
    return { sessions: await invoke('list_sessions', {}), projects: await invoke('list_projects', {}) };
  });
}

async function openDelete(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
  await expect(confirmation(page)).toBeVisible();
}

async function openMain(page: Page, seed = ''): Promise<void> {
  await installDeletionProbe(page, seed);
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}

test.describe('task deletion', () => {
  test('names the task in its confirmation and cancel leaves saved history untouched', async ({ page, browserName }) => {
    await openMain(page);
    const before = await stored(page);
    await openDelete(page);
    await expect(confirmation(page)).toContainText(title);
    await expect(confirmation(page).getByRole('button', { name: 'Cancel', exact: true })).toBeFocused();
    await page.screenshot({ path: `/private/tmp/pandacode-delete-task-${browserName}.png`, animations: 'disabled' });
    await confirmation(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(confirmation(page)).toBeHidden();
    expect(await calls(page, 'delete_session')).toEqual([]);
    expect(await stored(page)).toEqual(before);
    await expect(taskRow(page, 'session-1')).toHaveAttribute('aria-current', 'page');
    await expect(page.getByRole('log', { name: 'Conversation', exact: true })).toContainText('Search feels a little slow.');

    await page.setViewportSize({ width: 460, height: 740 });
    await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.4'));
    await page.reload();
    await openDelete(page);
    const bounds = (await confirmation(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(460);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
    expect(await confirmation(page).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    await expect(confirmation(page).getByRole('button', { name: 'Delete task', exact: true })).toBeVisible();
    await page.screenshot({ path: `/private/tmp/pandacode-delete-task-${browserName}-140pct.png`, animations: 'disabled' });
    await confirmation(page).getByRole('button', { name: 'Cancel', exact: true }).click();
    expect(await calls(page, 'delete_session')).toEqual([]);
  });

  test('permanently removes only the confirmed task and preserves its project and sibling tasks', async ({ page }) => {
    await openMain(page);
    const before = await stored(page);
    await openDelete(page);
    await confirmation(page).getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(confirmation(page)).toBeHidden();
    await expect(taskRow(page, 'session-1')).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).sessions.map(task => task.id)).toEqual(['session-2', 'session-3', 'session-4']);
    expect((await stored(page)).projects).toEqual(before.projects);
    expect(await calls(page, 'delete_session')).toEqual([{ command: 'delete_session', args: { sessionId: 'session-1' } }]);
    expect(await calls(page, 'remove_project')).toEqual([]);
    await expect(page.locator('.task-item.selected')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No task selected', exact: true })).toBeVisible();
    expect(await calls(page, 'create_session')).toEqual([]);
    await expect(page.getByRole('log', { name: 'Conversation', exact: true })).not.toContainText('Search feels a little slow.');
  });

  test('allows a task still archived from older data to be deleted; it shows as settled', async ({ page }) => {
    await openMain(page, "sessions[0].archived = true;");
    await page.getByRole('button', { name: /^Settled/ }).click();
    await taskRow(page, 'session-1').click();
    await expect(page.locator('#composer-area')).toContainText('This task is settled.');
    await openDelete(page);
    await confirmation(page).getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(taskRow(page, 'session-1')).toHaveCount(0);
    await expect.poll(async () => (await stored(page)).sessions.some(task => task.id === 'session-1')).toBe(false);
    expect(await calls(page, 'update_session')).toEqual([]);
  });

  test('removes a board task and closes its details without removing the board project', async ({ page }) => {
    await openMain(page);
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    const board = page.getByRole('region', { name: 'Project board', exact: true });
    await board.getByRole('button', { name: `Open task: ${title}`, exact: true }).click();
    const details = page.getByRole('region', { name: 'Task details', exact: true });
    await expect(details).toBeVisible();
    await openDelete(page);
    await confirmation(page).getByRole('button', { name: 'Delete task', exact: true }).click();
    await expect(details).toBeHidden();
    await expect(board.getByRole('button', { name: `Open task: ${title}`, exact: true })).toHaveCount(0);
    await expect(board.getByRole('button', { name: 'Open task: Refine the navigation', exact: true })).toBeVisible();
    expect((await stored(page)).projects.map(project => project.id)).toEqual(['project-1', 'project-2']);
  });

  for (const status of ['running', 'waiting']) {
    test(`disables deletion while the task is ${status}`, async ({ page }) => {
      await openMain(page, `sessions[0].status = '${status}'; sessions[0].taskStage = 'in_progress';`);
      await page.getByRole('button', { name: 'Task actions', exact: true }).click();
      const action = page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Delete task…', exact: true });
      await expect(action).toBeDisabled();
      await expect(confirmation(page)).toBeHidden();
      expect(await calls(page, 'delete_session')).toEqual([]);
    });
  }

  test('keeps the original target and a newer selection intact when deletion finishes late', async ({ page }) => {
    await openMain(page);
    await page.evaluate(() => { (window as any).__holdDeletion = true; });
    await openDelete(page);
    const submit = confirmation(page).getByRole('button', { name: 'Delete task', exact: true });
    await submit.click();
    await expect(submit).toBeDisabled();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseDeletion)).toBe('function');
    await page.keyboard.press('Escape');
    await page.evaluate(() => (window as any).__deletionEmit('overlay-open-task', { sessionId: 'session-2' }));
    await expect(taskRow(page, 'session-2')).toHaveAttribute('aria-current', 'page');
    await prompt(page).fill('Keep this newer task draft.');
    await page.evaluate(() => (window as any).__releaseDeletion());
    await expect(taskRow(page, 'session-1')).toHaveCount(0);
    await expect(taskRow(page, 'session-2')).toHaveAttribute('aria-current', 'page');
    await expect(prompt(page)).toHaveValue('Keep this newer task draft.');
    expect((await calls(page, 'delete_session')).map(call => call.args)).toEqual([{ sessionId: 'session-1' }]);
  });

  test('shows deletion failures inline and a delayed retry cannot close a newer dialog', async ({ page }) => {
    await openMain(page);
    await page.evaluate(() => { (window as any).__failDeletion = 'The saved task could not be deleted. Try again.'; });
    await openDelete(page);
    const submit = confirmation(page).getByRole('button', { name: 'Delete task', exact: true });
    await submit.click();
    await expect(confirmation(page).getByRole('alert')).toHaveText('The saved task could not be deleted. Try again.');
    await expect(submit).toBeEnabled();
    await expect(taskRow(page, 'session-1')).toHaveCount(1);
    await page.evaluate(() => { (window as any).__failDeletion = ''; (window as any).__holdDeletion = true; });
    await submit.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseDeletion)).toBe('function');
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await page.evaluate(() => (window as any).__releaseDeletion());
    await expect.poll(async () => (await stored(page)).sessions.some(task => task.id === 'session-1')).toBe(false);
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('alert')).toHaveCount(0);
  });

  test('refreshes selected and sibling tasks removed by another window', async ({ page }) => {
    await openMain(page);
    const projects = (await stored(page)).projects;
    await page.evaluate(() => (window as any).__externalDelete(['session-1', 'session-3']));
    await expect(taskRow(page, 'session-1')).toHaveCount(0);
    await expect(taskRow(page, 'session-3')).toHaveCount(0);
    await expect(page.locator('.task-item.selected')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No task selected', exact: true })).toBeVisible();
    expect((await stored(page)).projects).toEqual(projects);
    expect(await calls(page, 'delete_session')).toEqual([]);
  });

  test('does not restore saved history that arrives after the selected task was deleted externally', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await openMain(page, "window.__holdDeletedHistory = 'session-1';");
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseDeletedHistory)).toBe('function');
    await page.evaluate(() => (window as any).__externalDelete(['session-1']));
    await expect(page.getByRole('heading', { name: 'No task selected', exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__releaseDeletedHistory());
    await expect(taskRow(page, 'session-1')).toHaveCount(0);
    await expect(page.locator('.task-item.selected')).toHaveCount(0);
    await expect(page.getByRole('heading', { name: 'No task selected', exact: true })).toBeVisible();
    await expect(page.getByRole('log', { name: 'Conversation', exact: true })).not.toContainText('Search feels a little slow.');
    expect(errors).toEqual([]);
  });

  test('returns the launcher to its list after external deletion and rejects an older snapshot', async ({ page }) => {
    await page.clock.install();
    await page.setViewportSize({ width: 650, height: 610 });
    await page.route('**/src/overlay-client.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = /if \(command === ["']overlay_preferences["']\)/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, `
        if (command === 'overlay_snapshot' && window.__holdDeletionSnapshot) {
          window.__holdDeletionSnapshot = false;
          const old = structuredClone(await overlayCall('overlay_snapshot'));
          return await new Promise(resolve => { window.__releaseDeletionSnapshot = () => resolve(old); });
        }
        $&`) + '\nwindow.__deletionOverlayUrl = import.meta.url;\n' });
    });
    await page.goto('/?view=launcher');
    await page.locator('.launcher-task[data-task="preview-active"]').click();
    await expect(page.locator('.launcher-thread')).toBeVisible();
    await page.evaluate(() => { (window as any).__holdDeletionSnapshot = true; });
    await page.clock.runFor(1600);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseDeletionSnapshot)).toBe('function');
    await page.evaluate(async () => {
      const { overlayCall } = await import((window as any).__deletionOverlayUrl);
      const snapshot = await overlayCall('overlay_snapshot');
      const sessionIds = ['preview-active'];
      for (let index = snapshot.tasks.length - 1; index >= 0; index--) {
        if (sessionIds.includes(snapshot.tasks[index].sessionId)) snapshot.tasks.splice(index, 1);
      }
      window.dispatchEvent(new CustomEvent('pandacode-overlay-sessions-deleted', { detail: { sessionIds } }));
    });
    await expect(page.locator('.launcher-thread')).toBeHidden();
    await expect(page.locator('.launcher-home')).toBeVisible();
    await expect(page.getByRole('searchbox', { name: 'Search tasks', exact: true })).toBeFocused();
    await page.evaluate(() => (window as any).__releaseDeletionSnapshot());
    await page.clock.runFor(1);
    for (const id of ['preview-active', 'preview-subagent']) await expect(page.locator(`.launcher-task[data-task="${id}"]`)).toHaveCount(0);
    await expect(page.locator('.launcher-task[data-task="preview-worker"]')).toBeVisible();
    await expect(page.locator('html')).not.toHaveAttribute('data-overlay-hidden', 'true');
    await page.clock.runFor(1600);
    await expect(page.locator('.launcher-task[data-task="preview-active"]')).toHaveCount(0);
  });

  for (const target of ['source', 'fork'] as const) {
    test(`tracks the actual open launcher fork when its ${target} is deleted`, async ({ page }) => {
      await page.clock.install();
      await page.setViewportSize({ width: 650, height: 610 });
      await page.route('**/src/overlay-client.ts*', async route => {
        const response = await route.fetch();
        await route.fulfill({ response, body: await response.text() + `
          window.__deletionOverlayUrl = import.meta.url;
          window.__deleteOverlayTask = sessionId => {
            for (let index = tasks.length - 1; index >= 0; index--) {
              if (tasks[index].sessionId === sessionId) tasks.splice(index, 1);
            }
            threads.delete(sessionId + ':');
            window.dispatchEvent(new CustomEvent('pandacode-overlay-sessions-deleted', { detail: { sessionIds: [sessionId] } }));
          };
        ` });
      });
      await page.goto('/?view=launcher');
      await page.locator('.launcher-task[data-task="preview-active"]').click();
      await page.locator('.launcher-thread-user').getByRole('button', { name: 'Fork from here', exact: true }).click();
      const forkTitle = 'Polish the new onboarding (fork)';
      await expect(page.locator('.launcher-thread-heading h2')).toHaveText(forkTitle);
      const forkId = await page.evaluate(async () => {
        const { overlayCall } = await import((window as any).__deletionOverlayUrl);
        const snapshot = await overlayCall('overlay_snapshot');
        // The source can finish while the user reads the independent fork.
        snapshot.tasks.find((task: any) => task.id === 'preview-active').status = 'idle';
        return snapshot.tasks.find((task: any) => task.title.endsWith(' (fork)')).sessionId as string;
      });
      await page.evaluate(id => (window as any).__deleteOverlayTask(id), target === 'source' ? 'preview-active' : forkId);
      if (target === 'source') {
        await expect(page.locator('.launcher-thread')).toBeVisible();
        await expect(page.locator('.launcher-thread-heading h2')).toHaveText(forkTitle);
        await page.clock.runFor(1600);
        await expect(page.locator('.launcher-thread-user')).toContainText('Polish the new onboarding');
        await expect(page.locator('.launcher-home')).toBeHidden();
      } else {
        await expect(page.locator('.launcher-thread')).toBeHidden();
        await expect(page.locator('.launcher-home')).toBeVisible();
        await expect(page.locator('.launcher-thread-history')).toBeEmpty();
        await page.clock.runFor(1600);
        await expect(page.locator('.launcher-thread')).toBeHidden();
      }
    });
  }
});
