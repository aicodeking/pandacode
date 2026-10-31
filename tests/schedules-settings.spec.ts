import { expect, test, type Page } from '@playwright/test';

const region = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const panel = (page: Page) => region(page).getByRole('tabpanel', { name: 'Schedules', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const editor = (page: Page) => panel(page).getByRole('form', { name: 'Schedule', exact: true });
const row = (page: Page, title: string) => panel(page).locator('.schedule-row', { hasText: title });

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await page.keyboard.press('Meta+,');
  await region(page).getByRole('tab', { name: 'Schedules', exact: true }).click();
  await expect(panel(page).getByRole('heading', { name: 'Upcoming', exact: true })).toBeVisible();
}

test('schedules settings lists the seeded schedules with origin, cadence and activity', async ({ page }) => {
  await open(page);
  await expect(row(page, 'Check the CI run')).toContainText('Agent');
  await expect(row(page, 'Check the CI run')).toContainText('in 12 min');
  await expect(row(page, 'Morning summary')).toContainText('Weekdays at');
  await expect(row(page, 'Morning summary')).toContainText('You');
  await panel(page).getByRole('button', { name: 'Agents', exact: true }).click();
  await expect(panel(page).locator('.schedule-row')).toHaveCount(1);
  await panel(page).getByRole('button', { name: 'All', exact: true }).click();
  await expect(panel(page).getByRole('list', { name: 'Recent schedule runs' })).toContainText('Morning summary');
});

test('schedules editor creates a weekly schedule with a live preview', async ({ page }) => {
  await open(page);
  await panel(page).getByRole('button', { name: 'New schedule', exact: true }).click();
  await expect(editor(page).getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
  await editor(page).getByRole('textbox', { name: 'Title', exact: true }).fill('Weekly review');
  await editor(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Review this week’s changes.');
  await editor(page).getByRole('button', { name: 'Weekly', exact: true }).click();
  const days = editor(page).getByRole('group', { name: 'Days' });
  for (const day of ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat']) {
    const button = days.getByRole('button', { name: day, exact: true });
    if (await button.getAttribute('aria-pressed') === 'true') await button.click();
  }
  await days.getByRole('button', { name: 'Mon', exact: true }).click();
  await days.getByRole('button', { name: 'Wed', exact: true }).click();
  await editor(page).getByLabel('Time of day').fill('18:30');
  await expect(editor(page).locator('.schedules-preview')).toHaveText(/every Mon, Wed at (6:30\s?PM|18:30) · next:/);
  await editor(page).getByRole('button', { name: 'Save schedule', exact: true }).click();
  await expect(editor(page)).toBeHidden();
  await expect(row(page, 'Weekly review')).toHaveText(/Weekly on Mon, Wed at/);
});

test('schedules editor shows the interval hint, refuses two minutes and an empty message, and Escape closes it', async ({ page }) => {
  await open(page);
  await panel(page).getByRole('button', { name: 'New schedule', exact: true }).click();
  await editor(page).getByRole('button', { name: 'Repeat every', exact: true }).click();
  const every = editor(page).getByRole('spinbutton', { name: 'Repeat every', exact: true });
  await expect(every).toHaveAttribute('min', '5');
  await every.fill('30');
  await every.press('Enter');
  await expect(editor(page).getByRole('alert')).toHaveText('Add a message: what should the thread be asked?');
  await expect(editor(page).getByRole('textbox', { name: 'Message', exact: true })).toBeFocused();
  await editor(page).getByRole('textbox', { name: 'Message', exact: true }).fill('Ping');
  await every.fill('2');
  await editor(page).getByRole('combobox', { name: 'Unit', exact: true }).selectOption('1');
  await expect(editor(page).locator('.schedules-preview')).toHaveText('Intervals are 5 minutes to 7 days.');
  await every.press('Enter');
  await expect(editor(page).getByRole('alert')).toHaveText('Intervals are 5 minutes to 7 days.');
  await expect(every).toBeFocused();
  await editor(page).getByRole('textbox', { name: 'Message', exact: true }).press('Escape');
  await expect(editor(page)).toBeHidden();
  await expect(region(page)).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'New schedule', exact: true })).toBeFocused();
});

test('pause all mutes switches, offers Resume all, and Run now shows in activity', async ({ page }) => {
  await open(page);
  const pause = panel(page).getByRole('checkbox', { name: 'Pause all schedules', exact: true });
  const banner = panel(page).locator('.schedules-paused');
  await expect(banner).toBeHidden();
  await pause.check();
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('Nothing is lost');
  const toggle = row(page, 'Morning summary').getByRole('checkbox', { name: 'Morning summary', exact: true });
  await expect(toggle).toHaveAccessibleDescription('Paused for all schedules');
  await expect(toggle).toBeEnabled();
  await banner.getByRole('button', { name: 'Resume all', exact: true }).click();
  await expect(banner).toBeHidden();
  await expect(pause).not.toBeChecked();
  await expect(toggle).not.toHaveAttribute('aria-describedby', /.+/);

  await row(page, 'Check the CI run').getByRole('button', { name: 'More for Check the CI run' }).click();
  await page.getByRole('menuitem', { name: 'Run now', exact: true }).click();
  const activity = panel(page).getByRole('list', { name: 'Recent schedule runs' });
  await expect(activity.locator('li', { hasText: 'Check the CI run' })).toContainText('Run now');
});

test('Remove asks inline first, and Keep leaves the schedule', async ({ page }) => {
  await open(page);
  const target = row(page, 'Check the CI run');
  await target.getByRole('button', { name: 'More for Check the CI run' }).click();
  await page.getByRole('menuitem', { name: 'Remove…', exact: true }).click();
  await expect(target).toContainText('Remove?');
  await expect(target.getByRole('button', { name: 'Keep Check the CI run' })).toBeFocused();
  await target.getByRole('button', { name: 'Keep Check the CI run' }).click();
  await expect(target).not.toContainText('Remove?');
  await expect(target.getByRole('button', { name: 'More for Check the CI run' })).toBeFocused();
  await target.getByRole('button', { name: 'More for Check the CI run' }).click();
  await page.getByRole('menuitem', { name: 'Remove…', exact: true }).click();
  await target.getByRole('button', { name: 'Remove Check the CI run' }).click();
  await expect(row(page, 'Check the CI run')).toHaveCount(0);
  await expect(row(page, 'Morning summary').first()).toBeVisible();
});

test('row switches are labelled by the schedule title alone', async ({ page }) => {
  await open(page);
  const toggle = row(page, 'Check the CI run').getByRole('checkbox', { name: 'Check the CI run', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.uncheck();
  await expect(row(page, 'Check the CI run')).toHaveAttribute('data-enabled', 'false');
  await expect(row(page, 'Check the CI run').getByRole('checkbox', { name: 'Check the CI run', exact: true })).not.toBeChecked();
});

test('an empty schedule list offers a single New schedule call to action', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__schedules = []; (window as any).__scheduleRuns = []; });
  await open(page);
  await expect(panel(page).locator('.schedules-empty')).toBeVisible();
  await expect(panel(page).getByRole('button', { name: 'New schedule', exact: true })).toHaveCount(1);
  await expect(panel(page).getByRole('group', { name: 'Show schedules' })).toBeHidden();
  await expect(panel(page).getByRole('button', { name: 'New workflow', exact: true })).toBeHidden();
  await expect(panel(page).locator('.schedules-template')).toHaveCount(4);
  await expect(panel(page).locator('.schedules-template').first()).toContainText(/Weekdays at (9:00\s?AM|09:00)/);
});

test('thread pickers for followed threads stay in the project and skip the thread itself', async ({ page }) => {
  await open(page);
  const values = (select: ReturnType<Page['locator']>) => select.locator('option').evaluateAll(options => options.map(o => (o as HTMLOptionElement).value).filter(Boolean));
  await panel(page).getByRole('button', { name: 'New schedule', exact: true }).click();
  await editor(page).getByRole('combobox', { name: 'Thread', exact: true }).selectOption('session-1');
  await editor(page).getByRole('button', { name: 'After a thread finishes', exact: true }).click();
  const watched = await values(editor(page).getByRole('combobox', { name: 'Thread to follow', exact: true }));
  expect(watched.length).toBeGreaterThan(0);
  expect(watched).not.toContain('session-1');
  expect(watched).not.toContain('session-4');
  await expect(editor(page).locator('.schedules-preview')).toHaveText('Pick a thread to follow.');
  await expect(editor(page).getByRole('button', { name: 'Only the next time', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await editor(page).getByRole('textbox', { name: 'Message', exact: true }).press('Escape');

  await panel(page).getByRole('button', { name: 'New workflow', exact: true }).click();
  const flow = panel(page).getByRole('form', { name: 'Workflow', exact: true });
  await flow.getByRole('combobox', { name: 'Step 1 thread' }).selectOption('session-1');
  const second = await values(flow.getByRole('combobox', { name: 'Step 2 thread' }));
  expect(second).not.toContain('session-1');
  expect(second).not.toContain('session-4');
  await flow.getByRole('button', { name: 'After a thread finishes', exact: true }).click();
  const start = await values(flow.getByRole('combobox', { name: 'Start after thread' }));
  expect(start).not.toContain('session-1');
  expect(start).not.toContain('session-4');
});

test('the workflow builder chains steps by workflow id and lists them as one unit with one switch', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__schedules = []; (window as any).__scheduleRuns = []; });
  await open(page);
  await panel(page).getByRole('button', { name: 'Chain threads' }).click();
  const flow = panel(page).getByRole('form', { name: 'Workflow', exact: true });
  await expect(flow).toBeVisible();
  await flow.getByRole('textbox', { name: 'Workflow name' }).fill('Ship it');
  await flow.getByRole('button', { name: 'Add step', exact: true }).click();
  const ids = ['session-1', 'session-2', 'session-3'];
  for (const [index, id] of ids.entries()) {
    await flow.getByRole('combobox', { name: `Step ${index + 1} thread` }).selectOption(id);
    await flow.getByRole('textbox', { name: `Step ${index + 1} message` }).fill(`Do part ${index + 1}`);
  }
  await flow.getByRole('button', { name: 'Weekdays', exact: true }).click();
  await expect(flow.locator('.workflow-preview')).toContainText('every weekday at');
  await expect(flow.locator('.workflow-preview')).toContainText('when the previous step succeeds');
  await flow.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await expect(flow).toBeHidden();
  const list = () => page.evaluate(async () => {
    const { invoke } = await import('/src/preview.ts' as string);
    return invoke('schedules_list', { sessionId: null });
  }) as Promise<{ id: string; title: string; kind: string; sessionId: string; watchSessionId: string | null; onlyOnSuccess: boolean; workflowId: string | null; chainFromId: string | null; maxRuns: number | null; enabled: boolean }[]>;
  const steps = (await list()).filter(s => s.title.startsWith('Ship it')).sort((a, b) => a.title.localeCompare(b.title));
  expect(steps.map(s => [s.kind, s.sessionId, s.watchSessionId])).toEqual([['weekdays', ids[0], null], ['after', ids[1], ids[0]], ['after', ids[2], ids[1]]]);
  expect(new Set(steps.map(s => s.workflowId)).size).toBe(1);
  expect(steps[0].workflowId).toBeTruthy();
  expect(steps.map(s => s.chainFromId)).toEqual([null, steps[0].id, steps[1].id]);
  expect(steps.slice(1).every(s => s.onlyOnSuccess && s.maxRuns === null)).toBe(true);

  const unit = panel(page).locator('.schedule-flow', { hasText: 'Ship it' });
  await expect(unit.locator('.schedule-flow-head')).toContainText('3 steps');
  await expect(unit.getByRole('list', { name: 'Ship it steps' }).locator('.schedule-row')).toHaveCount(3);
  await expect(unit.getByRole('checkbox')).toHaveCount(1);
  await unit.getByRole('checkbox', { name: 'Ship it', exact: true }).uncheck();
  await expect(unit).toHaveAttribute('data-enabled', 'false');
  expect((await list()).filter(s => s.workflowId === steps[0].workflowId).every(s => !s.enabled)).toBe(true);
  await unit.getByRole('button', { name: 'More for Ship it', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Remove workflow…', exact: true }).click();
  await unit.getByRole('button', { name: 'Remove Ship it', exact: true }).click();
  await expect(panel(page).locator('.schedule-flow')).toHaveCount(0);
});

test('a refused workflow step shows inline and leaves no partial chain', async ({ page }) => {
  await page.route('**/src/preview-schedules.ts*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/function validate\(([^)]*)\)([^{]*)\{/, (all) => `${all} if (input.prompt === 'LOOP') throw new Error('This would make a loop.');`);
    await route.fulfill({ response, body });
  });
  await open(page);
  await expect(row(page, 'Check the CI run')).toBeVisible();
  const before = await panel(page).locator('.schedule-row').count();
  await panel(page).getByRole('button', { name: 'New workflow', exact: true }).click();
  const flow = panel(page).getByRole('form', { name: 'Workflow', exact: true });
  await flow.getByRole('textbox', { name: 'Step 1 message' }).fill('One');
  await flow.getByRole('textbox', { name: 'Step 2 message' }).fill('LOOP');
  await flow.getByRole('button', { name: 'Save workflow', exact: true }).click();
  await expect(flow.getByRole('alert')).toHaveText('Step 2: This would make a loop.');
  await expect(flow).toBeVisible();
  await flow.getByRole('textbox', { name: 'Step 1 message' }).press('Escape');
  await expect(panel(page).locator('.schedule-row')).toHaveCount(before);
});
