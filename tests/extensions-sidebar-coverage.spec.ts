import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's sample threads (`?sections`) and in-memory storage. Drag replay here is the
// synthetic browser path; installed native drag qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/sidebar/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.sidebar/filter-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewSidebar());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const sidebar = (page: Page) => page.locator('.sidebar');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const group = (page: Page, name: string) => page.locator(`#navigation [data-thread-group="${name}"]`);
const heading = (page: Page, name: string) => group(page, name).locator('.section-fold, .section-toggle');
const groups = (page: Page) => page.locator('#navigation > .task-group').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.threadGroup));
const ids = (page: Page, name: string) => group(page, name).locator('.task-item').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id));
const selected = (page: Page) => page.locator('#navigation .task-item.selected').getAttribute('data-id');
const prompt = (page: Page) => page.locator('#prompt');
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&sidebar-coverage&replacement&sections'); await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('#navigation .task-item.selected')).toHaveCount(1); await expect.poll(async () => (await props(page))?.rows.length ?? 0).toBeGreaterThan(0);
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(sidebar(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Sidebar presentation', { exact: true }).selectOption(id); await back(page); await expect(sidebar(page)).toHaveAttribute('data-sidebar-provider', id); }
/** Builds a captured action from the live presentation. Row and heading handles are opaque; the test maps them by
 * their position in the drawn list, which is what the presentation lists. */
async function action(page: Page, controlId: string, target: { task?: string; section?: string } = {}, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, target, changes }) => {
    const p = (window as any).__previewSidebar();
    let resource = '';
    if (target.task) {
      const listed = [...document.querySelectorAll<HTMLElement>('#navigation .task-row')].filter(node => !node.closest('[hidden]')).map(node => node.querySelector<HTMLElement>(':scope > .task-item')?.dataset.id);
      resource = p.rows[listed.indexOf(target.task)]?.id ?? 'missing-row';
    }
    const candidates = p.controls.filter((control: any) => control.controlId === controlId && (!target.task || control.resource === resource));
    let control = candidates[0];
    if (target.section) {
      const headings = [...document.querySelectorAll<HTMLElement>('#navigation .section-fold, #navigation .section-toggle')].map(node => node.closest<HTMLElement>('[data-thread-group]')?.dataset.threadGroup);
      control = candidates[headings.indexOf(target.section)];
    }
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, target, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewSidebarAction(input), input);
const act = async (page: Page, controlId: string, target: { task?: string; section?: string } = {}, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, target, changes));
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
const toast = (page: Page) => page.locator('#toast');
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
/** Hides one item from the Surface explorer, following its cursor pages. */
async function hide(page: Page, location: string, label: RegExp | string, open = true) {
  const region = open ? await explorer(page) : page.getByRole('region', { name: 'Surface explorer' });
  if (open) await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: typeof label === 'string' ? `Hide ${label}` : label, exact: typeof label === 'string' });
  for (let cursor = 0; cursor < 4 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}
const preferences = (page: Page) => page.evaluate(() => JSON.stringify(['pandacode.sidebar.collapsedSections', 'pandacode.sidebar.completedOpen', 'pandacode.sidebar.sort', 'pandacode.sidebar.unreviewed', 'pandacode.sidebar.projectOrder'].map(key => localStorage.getItem(key))));

test('Sidebar extension: zero extensions keep groups, selection, keyboard, filter and original handlers', async ({ page }) => {
  await setup(page);
  expect((await groups(page)).slice(0, 3)).toEqual(['pinned', 'active', 'review']);
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-hidden'); await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-order');
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, filtering: false, safeMode: false, group: 'project', taskSort: 'manual' });
  expect(p.sections.filter((section: any) => section.pinned).map((section: any) => section.id)).toEqual(['active']);
  expect(p.sections.every((section: any) => !section.hidden)).toBe(true);
  expect(p.rows.filter((item: any) => item.selected)).toHaveLength(1);
  const before = await selected(page);
  expect(await act(page, 'select-task', { task: 'sections-review-1' })).toEqual({ ok: false, reason: 'Revoked' }); expect(await selected(page)).toBe(before);
  await expect(page.locator('.sidebar-actions .extension-header-actions')).toBeHidden();
  await heading(page, 'active').focus(); await page.keyboard.press('Shift+F10'); await expect(page.locator('.floating-menu')).toHaveCount(0);
  // Original fold handler and its saved preference.
  await heading(page, 'active').click(); await expect(heading(page, 'active')).toHaveAttribute('aria-expanded', 'false');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.sidebar.collapsedSections'))).toContain('active');
  await heading(page, 'active').click(); await expect(heading(page, 'active')).toHaveAttribute('aria-expanded', 'true');
  // Keyboard roving focus follows the drawn order.
  await row(page, before!).focus(); await page.keyboard.press('ArrowDown'); await expect(row(page, before!)).not.toBeFocused();
  // Filter and clear through the original field.
  await page.locator('#sidebar-filter').fill('release notes'); await expect(row(page, 'sections-review-2')).toBeVisible(); await expect(row(page, 'sections-running')).toHaveCount(0);
  expect((await props(page)).filtering).toBe(true);
  await page.locator('.sidebar-search-clear').click(); await expect(row(page, 'sections-running')).toBeVisible();
  expect(await selected(page)).toBe(before);
});

test('Sidebar extension: install/enable writes no preference; the selected recipe adds header, section, task and project actions', async ({ page }) => {
  await setup(page); const region = await explorer(page); const order = await groups(page), choice = await preferences(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.sidebar', exact: true }).click();
  await expect(region.getByLabel('Sidebar presentation')).toHaveValue(''); await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  await region.getByLabel('Sidebar presentation').selectOption(PROVIDER); await back(page);
  await expect(sidebar(page)).toHaveAttribute('data-sidebar-provider', PROVIDER);
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  // No proposal applies on selection alone: groups and preferences are untouched.
  expect(await groups(page)).toEqual(order); expect(await preferences(page)).toBe(choice);
  await expect(page.locator('.sidebar > .sidebar-search')).toHaveCSS('order', '-1');
  const filterTop = (await page.locator('.sidebar > .sidebar-search').boundingBox())!.y, newTop = (await page.locator('.sidebar-actions [data-action="new-task"]').boundingBox())!.y;
  expect(filterTop).toBeLessThan(newTop);
  const start = await selected(page);
  await page.locator('.sidebar-actions').getByRole('button', { name: 'Sidebar notes', exact: true }).click(); await expect(toast(page)).toContainText('Sidebar ownership stays with PandaCode');
  await heading(page, 'active').focus(); await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('dialog', { name: 'Active section', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Collapse Active', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Sidebar notes', exact: true }).click(); await expect(toast(page)).toContainText('Sidebar ownership stays with PandaCode');
  await heading(page, 'review').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Finished section', exact: true }).getByRole('menuitem', { name: 'Collapse Finished', exact: true }).click();
  await expect(heading(page, 'review')).toHaveAttribute('aria-expanded', 'false'); await heading(page, 'review').click(); await expect(heading(page, 'review')).toHaveAttribute('aria-expanded', 'true');
  await row(page, 'session-2').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Task notes', exact: true }).click(); await expect(toast(page)).toContainText('Task rows stay host-owned');
  await page.locator('#project-filter').click(); await page.getByRole('menuitemradio', { name: 'pandacode', exact: true }).click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Project notes', exact: true }).click(); await expect(toast(page)).toContainText('Project rows stay host-owned');
  await page.keyboard.press('Escape');
  expect(await selected(page)).toBe(start);
});

test('Sidebar extension: captured actions run original handlers after a fresh choice; stale, replayed, forged and busy requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'new-task', {}, { controlId: 'delete' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'new-task', {}, { selector: '.task-item' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'new-task', {}, { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const stale = await action(page, 'select-task', { task: 'sections-review-2' });
  const request = await action(page, 'select-task', { task: 'sections-review-1' });
  expect(await send(page, request)).toEqual({ ok: true }); await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
  // Selecting changed the captured task: the same request and an older one are refused, never retargeted.
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' }); expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
  const stages = (await calls(page, 'set_task_stage')).length;
  expect(await act(page, 'settle', { task: 'sections-review-2' })).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'select-task', { task: 'session-2' })).toEqual({ ok: false, reason: 'Busy' });
  await proceed(page, 'Settle task'); await expect(group(page, 'review').locator('.task-item[data-id="sections-review-2"]')).toHaveCount(0);
  await expect.poll(async () => (await calls(page, 'set_task_stage')).length).toBe(stages + 1);
  await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
  // Escape declines the fresh choice: the saved collapse preference is untouched.
  const folded = await preferences(page);
  expect(await act(page, 'toggle-section', { section: 'active' })).toEqual({ ok: true }); await page.keyboard.press('Escape');
  await expect(heading(page, 'active')).toHaveAttribute('aria-expanded', 'true'); expect(await preferences(page)).toBe(folded);
  expect(await act(page, 'task-menu', { task: 'session-2' })).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Task actions', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  expect(await act(page, 'open-project')).toEqual({ ok: true }); await expect(page.getByRole('dialog', { name: 'Open project', exact: true })).toBeVisible();
  expect((await props(page)).busy).toBe(true); await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden();
  expect(await act(page, 'filter-clear')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.locator('#sidebar-filter').fill('toolchain'); await expect.poll(async () => (await props(page)).filtering).toBe(true);
  expect(await act(page, 'toggle-section', { section: 'active' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'filter-clear')).toEqual({ ok: true }); await expect(page.locator('#sidebar-filter')).toHaveValue('');
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'search', {}, { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'search', {}, { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await calls(page, 'delete_session')).toHaveLength(0);
  await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
});

test('Sidebar extension: compatible section and header order follow proposals on the original nodes and keyboard order', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await row(page, 'sections-running').click(); await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
  await proposal(page, 'panda.sidebar.sections', 'Finished before Active'); await back(page);
  await expect.poll(async () => (await groups(page)).slice(0, 3)).toEqual(['pinned', 'review', 'active']);
  // Keyboard order follows the drawn order: the last Finished stop leads into Active.
  const finished = await ids(page, 'review'); await row(page, finished.at(-1)!).focus(); await page.keyboard.press('ArrowDown'); await page.keyboard.press('ArrowDown');
  await expect(heading(page, 'active')).toBeFocused();
  await proposal(page, 'panda.sidebar.header', 'Search first'); await back(page);
  // The proposal's one rule (Search before New task) holds on the same three original nodes.
  const header = await page.locator('.sidebar-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action));
  expect([...header].sort()).toEqual(['new-chat', 'new-task', 'search']); expect(header.indexOf('search')).toBeLessThan(header.indexOf('new-task'));
  await page.evaluate(() => (window as any).__previewSidebarSafeMode());
  await expect.poll(async () => (await groups(page)).slice(0, 3)).toEqual(['pinned', 'active', 'review']);
  expect(await page.locator('.sidebar-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action))).toEqual(['new-task', 'new-chat', 'search']);
  await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
});

test('Sidebar extension: reversible section visibility keeps Active, the open section and filtered rows', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await row(page, 'sections-running').click(); await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
  const region = await hide(page, 'panda.sidebar.sections', 'Pinned');
  await expect(region.getByRole('button', { name: /^Hide Active/ })).toHaveCount(0);
  await hide(page, 'panda.sidebar.sections', 'Finished', false); await back(page);
  await expect(group(page, 'pinned')).toHaveCount(0); await expect(group(page, 'review')).toHaveCount(0);
  expect((await props(page)).sections.filter((section: any) => section.hidden).map((section: any) => section.id).sort()).toEqual(['pinned', 'review']);
  // Filtering finds rows in hidden sections; clearing hides them again.
  await page.locator('#sidebar-filter').fill('release notes'); await expect(row(page, 'sections-review-2')).toBeVisible();
  await page.locator('.sidebar-search-clear').click(); await expect(group(page, 'review')).toHaveCount(0);
  // The section holding the open task stays listed.
  await page.locator('#sidebar-filter').fill('flaky filter'); await row(page, 'sections-review-1').click(); await page.locator('.sidebar-search-clear').click();
  await expect(group(page, 'review')).toBeVisible(); await expect(row(page, 'sections-review-1')).toHaveAttribute('aria-current', 'page');
  await row(page, 'sections-running').click(); await expect(group(page, 'review')).toHaveCount(0);
  // A forged overlay cannot hide Active, the filter or status signals.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.sidebar.sections/active': false, 'panda.sidebar.protected/filter': false, 'panda.sidebar.protected/status': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(group(page, 'active')).toBeVisible(); await expect(page.locator('#sidebar-filter')).toBeVisible();
  await expect(row(page, 'sections-approval').locator('.task-indicator')).toHaveAttribute('aria-label', 'Needs approval');
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect.poll(async () => (await groups(page)).slice(0, 3)).toEqual(['pinned', 'active', 'review']);
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await page.locator('.sidebar-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action))).toEqual(['new-task', 'new-chat', 'search']);
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
  await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
});

test('Sidebar extension: row parts hide and reorder through one list attribute and keep their keyboard paths', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await row(page, 'sections-running').click(); await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
  await proposal(page, 'panda.sidebar.rows', 'Task actions before the tick');
  await hide(page, 'panda.sidebar.rows', /^Hide Harness logo/); await back(page);
  await expect(page.locator('#navigation')).toHaveAttribute('data-row-order', 'more-first'); await expect(page.locator('#navigation')).toHaveAttribute('data-row-hidden', 'provider');
  await expect(row(page, 'sections-approval').locator('.task-provider')).toBeHidden();
  await expect(page.locator('#navigation .task-row:has(.task-check) .task-more').first()).toHaveCSS('order', '-1');
  await hide(page, 'panda.sidebar.rows', 'Settle / Reopen tick'); await back(page);
  await expect(page.locator('#navigation .task-check').first()).toBeHidden();
  const settled = (await calls(page, 'set_task_stage')).length;
  expect(await act(page, 'settle', { task: 'sections-limited' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The hidden tick keeps its keyboard path: ⌘/Ctrl+Enter still settles through the original handler.
  await row(page, 'sections-limited').focus(); await page.keyboard.press('ControlOrMeta+Enter');
  await expect.poll(async () => (await calls(page, 'set_task_stage')).length).toBe(settled + 1);
  await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider'); await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-hidden');
  await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-order'); await expect(page.locator('#navigation .task-check').first()).toBeVisible();
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
  await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
});

test('Sidebar extension: drag replay and keyboard reorder keep working inside a rearranged sidebar without changing selection', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.sidebar.sections', 'Finished before Active'); await back(page);
  await expect.poll(async () => (await groups(page)).slice(0, 3)).toEqual(['pinned', 'review', 'active']);
  const start = await selected(page), before = await ids(page, 'review');
  const bounds = (await row(page, before[0]).boundingBox())!;
  await row(page, before[2]).dragTo(row(page, before[0]), { targetPosition: { x: Math.min(30, bounds.width / 2), y: 3 } });
  await expect(page.locator('#navigation')).toHaveAttribute('aria-busy', 'false'); await expect(page.locator('.drop-before,.drop-after,.task-dragging')).toHaveCount(0);
  await expect.poll(async () => (await ids(page, 'review'))[0]).toBe(before[2]);
  expect(await calls(page, 'reorder_sessions')).toHaveLength(1); expect(await selected(page)).toBe(start);
  await row(page, before[0]).focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(async () => (await ids(page, 'review')).indexOf(before[0])).toBe(0);
  await expect(row(page, before[0])).toBeFocused(); expect(await calls(page, 'reorder_sessions')).toHaveLength(2);
  expect(await groups(page).then(list => list.slice(0, 3))).toEqual(['pinned', 'review', 'active']); expect(await selected(page)).toBe(start);
});

test('Sidebar extension: a running selected task, its draft, stream and terminal survive conflict, fault, disable and safe mode', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.sidebar'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.sidebar/filter-first' }] };
  const future = structuredClone(other); future.id = 'future.sidebar'; future.contributes.components[0].id = 'future.sidebar/filter-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  let region = await explorer(page);
  await expect(region.getByLabel('Sidebar presentation')).toHaveValue(''); await expect(region.locator('option[value="future.sidebar/filter-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  await select(page, 'other.sidebar/filter-first');
  await row(page, 'sections-running').click(); await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page');
  await prompt(page).fill('Keep this sidebar draft');
  await page.keyboard.press('ControlOrMeta+J'); await expect(page.locator('#terminal-drawer')).toBeVisible();
  await page.evaluate(() => { const w = window as any; w.__sidebarNodes = { row: document.querySelector('#navigation .task-item.selected'), prompt: document.querySelector('#prompt'), terminal: document.querySelector('#terminal-host'), transcript: document.querySelector('#transcript') }; });
  const same = () => page.evaluate(() => { const w = window as any, nodes = w.__sidebarNodes; return nodes.row.isConnected && nodes.row.classList.contains('selected') && nodes.prompt === document.querySelector('#prompt') && nodes.terminal === document.querySelector('#terminal-host') && nodes.transcript === document.querySelector('#transcript'); });
  const choice = await preferences(page), stages = (await calls(page, 'set_task_stage')).length, sends = (await calls(page, 'send_message')).length;
  const check = async () => {
    expect(await same()).toBe(true); await expect(prompt(page)).toHaveValue('Keep this sidebar draft');
    await expect(row(page, 'sections-running')).toHaveAttribute('aria-current', 'page'); await expect(group(page, 'active').locator('.task-item[data-id="sections-running"]')).toHaveCount(1);
    await expect(row(page, 'sections-running').locator('.task-runtime')).toHaveCount(1); await expect(page.locator('#terminal-drawer')).toBeVisible();
    expect(await preferences(page)).toBe(choice); expect((await calls(page, 'set_task_stage')).length).toBe(stages); expect((await calls(page, 'send_message')).length).toBe(sends);
  };
  expect(await act(page, 'new-task', {}, { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySidebarPresentation(document.querySelector('.sidebar'), () => { throw Error('controlled fault'); }); });
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await act(page, 'select-task', { task: 'sections-review-1' })).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.sidebar'));
  await check(); await expect(prompt(page)).toBeFocused();
  region = await explorer(page); await region.getByLabel('Sidebar presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(sidebar(page)).toHaveAttribute('data-sidebar-provider', PROVIDER);
  await check(); await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewSidebarSafeMode());
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider'); await expect(page.locator('.sidebar-actions .extension-header-actions')).toBeHidden();
  await check(); await expect(prompt(page)).toBeFocused();
  expect((await props(page)).safeMode).toBe(true);
});
