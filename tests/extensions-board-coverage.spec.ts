import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/board/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewBoard());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const detail = (page: Page) => page.getByRole('region', { name: 'Task details', exact: true });
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&board-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#view-menu').click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.locator('#project-board')).toBeVisible(); await expect.poll(async () => (await props(page))?.rows.length).toBeGreaterThan(0);
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Board presentation', { exact: true }).selectOption('sample.board/review'); await back(page); await expect(page.locator('[data-board-provider="sample.board/review"]')).toBeVisible(); }
async function act(page: Page, controlId: string, title = '', changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, title, changes }) => {
    const p = (window as any).__previewBoard(), row = p.rows.find((row: any) => row.title === title);
    const action = { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, filter: p.filter, revision: p.revision, row: row?.id ?? '', rowProject: row?.project ?? '', rowRevision: row?.revision ?? 0, stage: row?.stage ?? '', controlId, requestId: crypto.randomUUID(), ...changes };
    (window as any).__capturedBoard = action; return (window as any).__previewBoardAction(action);
  }, { controlId, title, changes });
}
const idle = (page: Page) => expect.poll(async () => (await props(page)).busy).toBe(false);
async function add(page: Page, title: string) {
  await page.locator('#project-board').getByRole('button', { name: 'Add task', exact: true }).click();
  await page.getByRole('textbox', { name: 'Task title', exact: true }).fill(title);
  await page.getByRole('textbox', { name: 'Task description', exact: true }).fill('Keep original Board instructions.');
  await page.getByRole('button', { name: 'Add to pending', exact: true }).click(); await expect(page.locator('#dialog')).toBeHidden();
  await expect(detail(page).getByRole('heading', { name: title, exact: true })).toBeVisible();
}
const allow = (page: Page) => page.getByRole('button', { name: 'Allow Board task control for sample.board', exact: true }).click();
test('board: no extension keeps original task lifecycle and metadata withheld', async ({ page }) => {
  await setup(page); expect((await props(page)).rows.every((row: any) => row.title === '')).toBe(true);
  await expect(page.locator('[data-board-provider]')).toHaveCount(0); await add(page, 'Original Board task');
  await detail(page).getByRole('button', { name: 'Start task', exact: true }).click();
  await expect(detail(page).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled();
  await detail(page).getByRole('button', { name: 'Settle', exact: true }).click();
  await expect(detail(page).getByRole('button', { name: 'Reopen task', exact: true })).toBeEnabled();
  await detail(page).getByRole('button', { name: 'Reopen task', exact: true }).click();
  expect(await calls(page, 'start_task')).toHaveLength(1); expect(await calls(page, 'set_task_stage')).toHaveLength(2);
});
test('board: installed selected recipe, original captured forms/start/settle/reopen/filter and context', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.board', exact: true }).click();
  await expect(region.getByLabel('Board presentation', { exact: true })).toHaveValue('');
  await region.getByLabel('Board presentation', { exact: true }).selectOption('sample.board/review');
  await region.getByRole('button', { name: 'Grant UI customization and select Add before import', exact: true }).click(); await back(page);
  await expect(page.locator('.board-column[data-stage="review"]')).toHaveCSS('order', '-1');
  expect(await act(page, 'add')).toEqual({ ok: true }); await idle(page);
  await page.getByRole('textbox', { name: 'Task title', exact: true }).fill('Captured Board work'); await page.getByRole('textbox', { name: 'Task description', exact: true }).fill('Original details.');
  await page.getByRole('button', { name: 'Add to pending', exact: true }).click(); await expect(page.locator('#dialog')).toBeHidden();
  expect(await act(page, 'edit', 'Captured Board work')).toEqual({ ok: true }); await idle(page);
  await page.getByRole('textbox', { name: 'Task description', exact: true }).fill('Edited original instructions.'); await page.getByRole('button', { name: 'Save details', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden(); expect(await act(page, 'start', 'Captured Board work')).toEqual({ ok: false, reason: 'PermissionDenied' });
  await allow(page); expect(await act(page, 'start', 'Captured Board work')).toEqual({ ok: true });
  await expect(detail(page).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled(); await idle(page);
  expect(await act(page, 'settle', 'Captured Board work')).toEqual({ ok: true }); await idle(page);
  expect(await act(page, 'reopen', 'Captured Board work')).toEqual({ ok: true }); await idle(page);
  expect(await act(page, 'close')).toEqual({ ok: true }); await idle(page);
  expect(await act(page, 'open', 'Captured Board work')).toEqual({ ok: true }); await idle(page);
  await page.locator('#board-project-filter').focus(); await page.keyboard.press('Shift+F10'); await expect(page.getByRole('menuitem', { name: 'Board tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.locator('#board-project-filter')).toBeFocused();
  expect(await act(page, 'filter')).toEqual({ ok: true }); await idle(page); await page.keyboard.press('Escape');
  expect(await calls(page, 'start_task')).toHaveLength(1); expect(await calls(page, 'update_task_details')).toHaveLength(1);
});
test('board: pending action, disable and safe recovery preserve form draft, task selection and running stream', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await add(page, 'Pending Board start'); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'start_task'; });
  expect(await act(page, 'start', 'Pending Board start')).toEqual({ ok: true }); await expect.poll(() => calls(page, 'start_task').then(calls => calls.length)).toBe(1);
  expect(await act(page, 'start', 'Pending Board start')).toEqual({ ok: false, reason: 'Busy' });
  const selected = (await props(page)).task;
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.board', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  expect((await props(page)).task).toBe(selected); await expect(page.locator('[data-board-provider]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect(detail(page).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled(); await idle(page);
  expect(await calls(page, 'start_task')).toHaveLength(1);
  await detail(page).getByRole('button', { name: 'Edit task details', exact: true }).click();
  const field = page.getByRole('textbox', { name: 'Task description', exact: true }); await field.fill('Retain this core detail draft');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change')));
  await expect(field).toHaveValue('Retain this core detail draft'); await expect(field).toBeFocused();
  await page.keyboard.press('Escape'); expect((await props(page)).task).toBe(selected);
});
test('board: original retry, open project and import handlers retain task-stage and opt-in policy', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'open-project')).toEqual({ ok: true }); await idle(page);
  await expect(page.getByRole('dialog', { name: 'Open project', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect.poll(async () => (await props(page)).importable).toBe(true);
  expect(await act(page, 'import')).toEqual({ ok: true }); await idle(page);
  await expect(page.getByRole('dialog', { name: 'Import from GitHub', exact: true })).toBeVisible();
  await expect(page.getByRole('group', { name: 'Open issues', exact: true })).toContainText('Search index rebuilds');
  await page.keyboard.press('Escape'); expect(await calls(page, 'create_board_task')).toHaveLength(0);
  await add(page, 'Retry original Board work'); await allow(page);
  expect(await act(page, 'start', 'Retry original Board work')).toEqual({ ok: true });
  await detail(page).getByRole('button', { name: 'Stop task', exact: true }).click(); await idle(page);
  await expect.poll(async () => { const row = (await props(page)).rows.find((row: any) => row.title === 'Retry original Board work'); return [row.stage, row.running, row.busy]; }).toEqual(['in_progress', false, false]);
  expect(await act(page, 'start', 'Retry original Board work')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'retry', 'Retry original Board work')).toEqual({ ok: true });
  await expect(detail(page).getByRole('button', { name: 'Settle', exact: true })).toBeEnabled();
  expect(await calls(page, 'start_task')).toHaveLength(2);
});
test('board: a start already pending for A never retargets B or its draft on recovery', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await add(page, 'Pending A'); await add(page, 'Selected B');
  expect(await act(page, 'open', 'Pending A')).toEqual({ ok: true }); await idle(page); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'start_task'; });
  expect(await act(page, 'start', 'Pending A')).toEqual({ ok: true });
  await expect.poll(() => calls(page, 'start_task').then(calls => calls.length)).toBe(1);
  await page.locator('#project-board').getByRole('button', { name: 'Open task: Selected B', exact: true }).click();
  await page.locator('#prompt').fill('B draft stays with B'); const state = await props(page), selected = state.task, pending = state.rows.find((row: any) => row.title === 'Pending A').id;
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.board', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await idle(page);
  await expect.poll(async () => (await props(page)).rows.find((row: any) => row.id === pending)?.stage).toBe('review');
  await expect(detail(page).getByRole('heading', { name: 'Selected B', exact: true })).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('B draft stays with B'); expect((await props(page)).task).toBe(selected);
  expect(await calls(page, 'start_task')).toHaveLength(1); expect(await calls(page, 'set_task_stage')).toHaveLength(0);
  await explorer(page); await page.getByRole('button', { name: 'Enable sample.board', exact: true }).click(); await back(page);
  await expect(page.getByRole('button', { name: 'Allow Board task control for sample.board', exact: true })).toBeVisible();
  expect(await act(page, 'start', 'Selected B')).toEqual({ ok: false, reason: 'PermissionDenied' });
});
test('board: conflict/future/fault/revocation and captured A to B cannot retarget mutations', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.board'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.board/review' }] };
  const future = structuredClone(other); future.id = 'future.board'; future.contributes.components[0].id = 'future.board/review'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Board presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.board/review"]')).toHaveAttribute('disabled', ''); await back(page); await select(page);
  await add(page, 'Captured A'); await allow(page); expect(await act(page, 'edit', 'Captured A')).toEqual({ ok: true }); await idle(page); await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__staleBoard = (window as any).__capturedBoard; }); await add(page, 'Captured B');
  expect(await page.evaluate(() => (window as any).__previewBoardAction((window as any).__staleBoard))).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'open', 'Captured A', { rowProject: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyBoardPresentation(document.querySelector('#project-board'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-board-presentation-status]')).toContainText('Built-in board remains active');
  expect(await act(page, 'edit', 'Captured B')).toEqual({ ok: false, reason: 'Revoked' });
  await detail(page).getByRole('button', { name: 'Edit task details', exact: true }).click(); await expect(page.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue('Captured B');
  expect(await calls(page, 'start_task')).toHaveLength(0);
});
for (const [location, labels] of Object.entries({ 'panda.board.header': ['Open project', 'Filter projects', 'Import from GitHub', 'Add task'], 'panda.board.columns': ['Pending column', 'In progress column', 'Review column', 'Settled column'], 'panda.board.cards': ['Open task', 'Start pending task', 'Retry task'], 'panda.board.detail': ['Edit task details', 'Close task details', 'Start task', 'Retry task', 'Settle task', 'Reopen task'] })) test(`board: reversible catalog controls for ${location}`, async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.locator('#board-project-filter').click(); await page.getByRole('dialog', { name: 'Filter projects', exact: true }).getByRole('menuitemradio', { name: 'orbit', exact: true }).click();
  await add(page, 'Layout Board work');
  const before = await props(page), region = await explorer(page);
  expect(before.filter).not.toBe('');
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  for (const label of labels) {
    const hide = region.getByRole('button', { name: `Hide ${label}`, exact: true });
    if (!await hide.count()) {
      const first = region.getByRole('button', { name: 'First items', exact: true }); if (await first.isEnabled()) await first.click();
      if (!await hide.count()) await region.getByRole('button', { name: 'Next items', exact: true }).click();
    }
    await hide.click(); await region.getByRole('button', { name: `Show ${label}`, exact: true }).click();
  }
  const first = region.getByRole('button', { name: 'First items', exact: true }); if (await first.isEnabled()) await first.click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.board.detail');
  await region.getByRole('button', { name: 'Hide Edit task details', exact: true }).click(); await back(page); await expect(detail(page).getByRole('button', { name: 'Edit task details', exact: true })).toBeHidden();
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(detail(page).getByRole('button', { name: 'Edit task details', exact: true })).toBeVisible();
  const after = await props(page); expect([after.project, after.task, after.filter]).toEqual([before.project, before.task, before.filter]);
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(detail(page).getByRole('button', { name: 'Edit task details', exact: true })).toBeVisible();
});
