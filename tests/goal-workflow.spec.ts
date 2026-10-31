import { expect, test, type Page } from '@playwright/test';

const banner = (page: Page) => page.getByRole('region', { name: 'Task goal', exact: true });
const goalDialog = (page: Page) => page.getByRole('dialog').filter({ has: page.getByRole('heading', { name: 'Goal', exact: true }) });
async function command(page: Page, value: string): Promise<void> { const prompt = page.locator('#prompt'); await expect(prompt).toBeEnabled(); await prompt.fill(value + ' '); await prompt.press('Enter'); }
const calls = (page: Page, name?: string) => page.evaluate(name => (window as any).__goalCalls.filter((entry: any) => !name || entry.command === name), name);
async function startGoal(page: Page): Promise<void> {
  await command(page, '/goal');
  await expect(goalDialog(page)).toBeVisible();
  await goalDialog(page).getByRole('textbox', { name: 'Goal objective' }).fill('Build and verify a keyboard-accessible game');
  await goalDialog(page).getByRole('spinbutton', { name: 'Goal token budget' }).fill('50000');
  await goalDialog(page).getByRole('button', { name: 'Start goal', exact: true }).click();
  await expect(goalDialog(page).getByRole('status')).toContainText('Working toward goal');
  await goalDialog(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(banner(page)).toBeVisible();
}

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    await route.fulfill({ response, body: source.replace(/switch\s*\(command\)\s*\{/, `
      window.__goalCalls ??= [];
      window.__goalCalls.push({command,args:structuredClone(args)});
      window.__goalTask = id => structuredClone(session(id));
      window.__goalEmit = event => {
        if (event.kind === 'goal') session(event.sessionId).goalState = structuredClone(event.data);
        agent(event);
      };
      if (command === 'task_goal' && window.__goalHold) await new Promise(resolve => { window.__goalRelease = resolve; });
      if (command === 'task_goal' && window.__goalError) throw new Error(window.__goalError);
      switch (command) {
    `) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toBeEnabled();
});

test('goal workflow creates a budgeted goal and pauses and resumes the running task', async ({ page }) => {
  await startGoal(page);
  await expect(banner(page)).toContainText('Build and verify a keyboard-accessible game');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', /Queue a follow-up/);
  const started = (await calls(page, 'task_goal')).find((entry: any) => entry.args.request.action === 'set');
  expect(started.args).toEqual({ sessionId: 'session-2', request: { action: 'set', objective: 'Build and verify a keyboard-accessible game', tokenBudget: 50000 } });
  expect(await calls(page, 'send_message')).toHaveLength(0);
  const retained = await banner(page).getByRole('button', { name: 'Manage task goal' }).elementHandle();
  await expect(page.getByRole('log')).toContainText('sample goal');
  await banner(page).getByRole('button', { name: 'Pause goal', exact: true }).click();
  await expect(banner(page)).toContainText('Paused');
  await expect(page.locator('#prompt')).toBeEnabled();
  await banner(page).getByRole('button', { name: 'Resume goal', exact: true }).click();
  await expect(banner(page)).toContainText('Working toward goal');
  await expect(page.locator('#prompt')).toHaveAttribute('placeholder', /Queue a follow-up/);
  expect(await retained!.evaluate(node => node === document.querySelector('.goal-banner-open'))).toBe(true);
  const task = await page.evaluate(() => (window as any).__goalTask('session-2'));
  expect(task.taskStage).toBe('in_progress');
  expect(task.goalState.status).toBe('active');
  expect((await calls(page, 'task_goal')).map((entry: any) => entry.args.request.action)).toEqual(['get', 'set', 'pause', 'resume']);
});

test('goal workflow keeps live goal state scoped to its task across conversation and board views', async ({ page }) => {
  await startGoal(page);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(banner(page)).toBeHidden();
  await page.evaluate(() => {
    const task = (window as any).__goalTask('session-2');
    (window as any).__goalEmit({ sessionId: 'session-2', kind: 'goal', text: '', data: { ...task.goalState, tokensUsed: 12300 } });
  });
  await expect(banner(page)).toBeHidden();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(banner(page)).toContainText('12,');
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Open task: Refine the navigation', exact: true }).click();
  const details = page.getByRole('region', { name: 'Task details', exact: true });
  await expect(details.getByRole('region', { name: 'Task goal', exact: true })).toBeVisible();
  await details.getByRole('button', { name: 'Pause goal', exact: true }).click();
  await expect(banner(page)).toContainText('Paused');
  await banner(page).getByRole('button', { name: 'Manage task goal', exact: true }).click();
  await goalDialog(page).getByRole('button', { name: 'Clear goal', exact: true }).click();
  await expect(goalDialog(page).getByRole('status')).toContainText('No active goal');
  await goalDialog(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(banner(page)).toBeHidden();
  expect((await page.evaluate(() => (window as any).__goalTask('session-2'))).goalState).toBeNull();
});

test('goal workflow keeps edits through goal events and reports failed changes', async ({ page }) => {
  await startGoal(page);
  await banner(page).getByRole('button', { name: 'Manage task goal', exact: true }).click();
  const objective = goalDialog(page).getByRole('textbox', { name: 'Goal objective' });
  await objective.fill('Keep this revised objective');
  const retained = await objective.elementHandle();
  await page.evaluate(() => {
    const task = (window as any).__goalTask('session-2');
    (window as any).__goalEmit({ sessionId: 'session-2', kind: 'goal', text: '', data: { ...task.goalState, tokensUsed: 900 } });
    (window as any).__goalError = 'Goal update rejected';
  });
  await expect(objective).toHaveValue('Keep this revised objective');
  await expect(objective).toBeFocused();
  expect(await retained!.evaluate(node => node === document.querySelector('.goal-form textarea'))).toBe(true);
  await goalDialog(page).getByRole('button', { name: 'Save goal', exact: true }).click();
  await expect(goalDialog(page).getByRole('alert')).toHaveText('Goal update rejected');
  await expect(objective).toHaveValue('Keep this revised objective');
  expect((await page.evaluate(() => (window as any).__goalTask('session-2'))).goalState.objective).toBe('Build and verify a keyboard-accessible game');
});

test('goal workflow plan and fast commands persist task-specific settings without sending a prompt', async ({ page }) => {
  await command(page, '/plan on');
  await expect(page.locator('#toast')).toContainText('Plan mode enabled');
  await command(page, '/fast on');
  await expect(page.locator('#toast')).toContainText('Fast service tier enabled');
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-2"]').click();
  const task = await page.evaluate(() => (window as any).__goalTask('session-2'));
  expect(task.codexSettings).toEqual({ collaborationMode: { mode: 'plan' }, serviceTier: 'fast' });
  await command(page, '/plan off');
  await expect(page.locator('#toast')).toContainText('Plan mode disabled');
  await command(page, '/fast off');
  await expect(page.locator('#toast')).toContainText('Fast service tier disabled');
  expect((await calls(page, 'set_task_preference')).map((entry: any) => entry.args)).toEqual([
    { sessionId: 'session-2', request: { action: 'plan', enabled: true } }, { sessionId: 'session-2', request: { action: 'fast', enabled: true } },
    { sessionId: 'session-2', request: { action: 'plan', enabled: false } }, { sessionId: 'session-2', request: { action: 'fast', enabled: false } },
  ]);
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('goal workflow opens usage, imports selected setup, and resumes a chosen conversation', async ({ page }) => {
  await command(page, '/usage');
  await expect(page.getByRole('heading', { name: 'Codex usage' })).toBeVisible();
  await expect(page.getByRole('progressbar', { name: '5-hour limit usage' })).toHaveAttribute('value', '28');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await command(page, '/import');
  await page.getByRole('checkbox', { name: /Project instructions/ }).check();
  await page.getByRole('button', { name: 'Import selected', exact: true }).click();
  await expect(page.getByRole('dialog')).toContainText('1 selected item');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  const imported = (await calls(page, 'codex_command')).find((entry: any) => entry.args.request.action === 'importSelected');
  expect(imported.args.request.ids).toEqual(['preview-instructions']);
  await command(page, '/resume');
  await page.getByRole('radio', { name: /Review project architecture/ }).check();
  await page.getByRole('button', { name: 'Resume conversation', exact: true }).click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Review project architecture');
  await expect(page.getByRole('log')).toContainText('sample imported conversation');
  expect((await calls(page, 'fork_codex_task')).at(-1).args).toEqual({ sessionId: 'session-2', remoteId: 'preview-remote-conversation' });
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('goal workflow harness console inserts the exact command only after a click and never submits it', async ({ page }) => {
  await command(page, '/raw on');
  const insert = page.getByRole('button', { name: 'Insert /raw on in the harness console', exact: true });
  await expect(insert).toBeEnabled();
  expect(await calls(page, 'start_harness_terminal')).toHaveLength(1);
  expect(await calls(page, 'write_terminal')).toHaveLength(0);
  await insert.click();
  await expect(insert).toHaveText('Inserted · press Enter');
  const writes = await calls(page, 'write_terminal');
  expect(writes).toHaveLength(1);
  expect(writes[0].args.data).toBe('\u001b[200~/raw on\u001b[201~');
  expect(writes[0].args.data).not.toMatch(/[\r\n]/);
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('goal workflow prevents a competing harness console while the goal is running', async ({ page }) => {
  await startGoal(page);
  await expect(page.getByRole('log')).toContainText('sample goal');
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Open harness console', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Stop this task before opening its harness console');
  expect(await calls(page, 'start_harness_terminal')).toHaveLength(0);
  await expect(banner(page)).toContainText('Working toward goal');
});

test('goal workflow honors command arguments and rejects invalid fast settings without losing the draft', async ({ page }) => {
  await command(page, '/fast turbo');
  await expect(page.locator('#toast')).toContainText('Use /fast, /fast on, or /fast off.');
  await expect(page.locator('#prompt')).toHaveValue('/fast turbo ');
  expect(await calls(page, 'set_task_preference')).toHaveLength(0);
  await command(page, '/worktree feature/game');
  await expect(page.getByRole('textbox', { name: 'Branch name', exact: true })).toHaveValue('feature/game');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await command(page, '/resume architecture');
  await expect(page.getByRole('radio', { name: /Review project architecture/ })).toBeVisible();
  const lookup = (await calls(page, 'codex_command')).find((entry: any) => entry.args.request.action === 'conversations');
  expect(lookup.args.request.search).toBe('architecture');
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await command(page, '/usage daily');
  await expect(page.getByRole('listbox', { name: 'Daily token use' })).toBeFocused();
  await expect(page.locator('.heatmap-readout')).toContainText('3,420 tokens');
});
