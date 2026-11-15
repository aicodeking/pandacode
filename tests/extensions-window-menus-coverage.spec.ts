import { test, expect, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with the preview's seeded threads (session-2 is a Codex task
// in the first project, orbit; the second project is pandacode). No task is sent, deleted or created, no project is added
// or removed; installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/window-menus/extension.json', import.meta.url), 'utf8'));
const TOOLBAR = 'sample.window-menus/toolbar';
const BASE = '/?extensions-baseline&window-menus&replacement';
const PROTECTED = ['view-hide-current', 'sort-reorder', 'project-actions', 'project-remove', 'project-add', 'github-enable'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewWindowMenus());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const menu = (page: Page, name: string) => page.getByRole('menu', { name, exact: true });
const names = (list: Locator) => list.locator('.choice-menu-option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}` });
const TRIGGERS = { view: '#view-menu', sort: '#sidebar-sort', filter: '#project-filter' } as const;
const MENUS = { view: 'Workspace view', sort: 'Sort and view', filter: 'Filter projects' } as const;
const stored = (page: Page, key: string) => page.evaluate(key => localStorage.getItem(key), key);
const sortOf = async (page: Page) => JSON.parse((await stored(page, 'pandacode.sidebar.sort')) ?? '{}');
const search = (page: Page) => page.getByRole('searchbox', { name: 'Search projects', exact: true });
const viewLabel = (page: Page) => page.locator('#view-menu').getAttribute('aria-label');
async function open(page: Page, kind: keyof typeof TRIGGERS) {
  await page.locator(TRIGGERS[kind]).click(); const list = menu(page, MENUS[kind]); await expect(list).toBeVisible(); return list;
}
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load; the Codex task is opened. */
async function load(page: Page, url = BASE) {
  // A cold preview server compiles the page on its first load; readiness, not behavior, is awaited longer here.
  await page.goto(url); await expect(prompt(page)).toBeEnabled({ timeout: 20_000 }); await expect.poll(async () => Boolean(await props(page)), { timeout: 20_000 }).toBe(true);
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
  await row(page, 'session-2').click(); await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
  await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
  await expect(page.locator(TRIGGERS.view)).toBeVisible(); await expect(page.locator(TRIGGERS.filter)).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page) {
  await explorer(page);
  await page.getByLabel('Composer presentation', { exact: true }).selectOption(TOOLBAR);
  await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', TOOLBAR);
}
async function install(page: Page) {
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.window-menus', exact: true }).click();
  await back(page); return region;
}
async function hide(page: Page, region: Locator, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: new RegExp(`^Hide ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( —|$)`) });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
async function proposal(region: Locator, location: string, title: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: new RegExp(`^(Grant UI customization and select|Select) ${title}$`) }).click();
}
/** Opens a contributed action's dialog, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}
/** Chooses a contributed menu item, then loads its dialog's options and cancels it. */
async function contributed(page: Page, kind: keyof typeof TRIGGERS, title: string, tags: string) {
  const list = await open(page, kind);
  await list.getByRole('menuitem', { name: title, exact: true }).click();
  return captured(page, tags);
}
const noMutation = async (page: Page) => { for (const command of ['send_message', 'steer_message', 'delete_session', 'remove_project', 'add_project']) expect(await calls(page, command), command).toEqual([]); };
function build(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewWindowMenus(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, view: p.view, sort: p.sort, filter: p.filter, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewWindowMenusAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await build(page, controlId, changes, nth));
const ofKind = async (page: Page, controlId: string) => (await props(page)).controls.filter((control: any) => control.controlId === controlId);

test('Window menus extension: zero extensions keep the Workspace view, Sort and view and Filter projects menus, search, keyboard and Escape', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  // Workspace view: radios with the open view checked; no contributed or hidden markup.
  let list = await open(page, 'view');
  expect(await names(list)).toEqual(expect.arrayContaining(['Conversation', 'Board']));
  await expect(list.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-extension-contribution], [data-layout-hidden]')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
  // Sort and view: the sort groups keep their radios; the keyboard picks Recent activity and the menu closes.
  list = await open(page, 'sort');
  expect(await names(list)).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks']);
  await expect(list.getByRole('menuitemradio', { name: 'Manual', exact: true })).toHaveAttribute('aria-checked', 'true'); await expect(list.getByRole('menuitemradio', { name: '6 tasks', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0); expect((await sortOf(page)).tasks ?? 'manual').toBe('manual');
  list = await open(page, 'sort');
  await list.getByRole('menuitemradio', { name: 'Recent activity', exact: true }).click();
  await expect(list).toHaveCount(0); expect((await sortOf(page)).tasks).toBe('recent');
  // Filter projects: search narrows the list, Enter chooses the match, and Escape keeps the filter.
  list = await open(page, 'filter');
  expect(await names(list)).toEqual(expect.arrayContaining(['All projects', 'orbit', 'pandacode']));
  await expect(list.getByRole('menuitemradio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
  await search(page).fill('panda');
  expect(await names(list)).toEqual(['pandacode']);
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
  expect(await stored(page, 'pandacode.projectFilter')).toBeFalsy();
  list = await open(page, 'filter');
  await search(page).fill('panda'); await page.keyboard.press('ArrowDown'); await page.keyboard.press('Enter');
  await expect(list).toHaveCount(0); await expect.poll(() => stored(page, 'pandacode.projectFilter')).toBe('project-2');
  await expect(page.locator(TRIGGERS.filter)).toContainText('pandacode');
  // The presentation names no view, sort or project, and captured actions have no owner without a selected provider.
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, menu: 'none' });
  expect(JSON.stringify(p)).not.toMatch(/orbit|pandacode|Conversation|Board|session-|project-|recent/);
  expect(await act(page, 'filter-set')).toEqual({ ok: false, reason: 'Revoked' });
  await noMutation(page);
});

test('Window menus extension: an installed package\'s items in all three menus are clicked, and its contributed main view opens through the view navigation', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page);
  await install(page);
  // The contributed main view is listed beside the host views and opens through the existing view navigation.
  let list = await open(page, 'view');
  expect(await names(list)).toEqual(['Conversation', 'Board', 'GitHub', 'Window notes']);
  await expect(list.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(list.getByRole('menuitem', { name: 'Window notes', exact: true })).toHaveCount(1);
  await list.getByRole('menuitem', { name: 'Window notes', exact: true }).click();
  await expect(list).toHaveCount(0);
  const view = page.locator('.extension-inspector-view');
  await expect(view).toBeVisible(); await expect(view).toContainText('A contributed main view opened from the Workspace view menu.');
  // The host's own view stays: opening a contributed view changed nothing in the workspace view or the sort.
  expect(await viewLabel(page)).toBe('Workspace view: Conversation');
  // Sort and view: the contributed item captures the window and revision; the sort radios keep their role.
  const sort = await contributed(page, 'sort', 'Sort notes', 'Sort tags');
  expect(sort).toMatchObject({ surfaceId: 'panda.sidebar.sort.menu', windowId: 'main', selection: { kind: 'sidebar-sort', ids: ['manual', 'per-6'] } });
  expect(typeof sort.revision).toBe('number');
  list = await open(page, 'sort');
  expect(await names(list)).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks', 'Sort notes']);
  await expect(list.getByRole('menuitemradio', { name: 'Manual', exact: true })).toHaveAttribute('aria-checked', 'true');
  await list.getByRole('menuitemradio', { name: 'Created', exact: true }).click();
  expect((await sortOf(page)).tasks).toBe('created');
  const next = await contributed(page, 'sort', 'Sort notes', 'Sort tags');
  expect(next).toMatchObject({ selection: { kind: 'sidebar-sort', ids: ['created', 'per-6'] } });
  // Filter projects: the contributed item captures the filter selection and never a project name or path; the search stays.
  const all = await contributed(page, 'filter', 'Filter notes', 'Filter tags');
  expect(all).toMatchObject({ surfaceId: 'panda.projects.filter.menu', windowId: 'main', selection: { kind: 'project-filter', ids: ['all-projects'] } });
  list = await open(page, 'filter');
  expect(await names(list)).toEqual(['All projects', 'orbit', 'pandacode', 'Filter notes']);
  await expect(list.getByRole('menuitemradio', { name: 'All projects', exact: true })).toHaveAttribute('aria-checked', 'true');
  await search(page).fill('panda'); expect(await names(list)).toEqual(['pandacode']);
  await list.getByRole('menuitemradio', { name: 'pandacode', exact: true }).click();
  await expect.poll(() => stored(page, 'pandacode.projectFilter')).toBe('project-2');
  const filtered = await contributed(page, 'filter', 'Filter notes', 'Filter tags');
  expect(filtered).toMatchObject({ selection: { kind: 'project-filter', ids: ['project-2'] } });
  expect(JSON.stringify([sort, next, all, filtered])).not.toMatch(/orbit|pandacode|\/Users\//);
  await noMutation(page);
});

test('Window menus extension: hide and order of eligible entries persist and restore; the open view, the selected sort and the filter rows keep their place', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]);
  let views = await names(await open(page, 'view')); await page.keyboard.press('Escape');
  expect(views.indexOf('Conversation')).toBeLessThan(views.indexOf('Board'));
  const region = await explorer(page);
  await proposal(region, 'panda.workspace.view.menu', 'GitHub before Board');
  await hide(page, region, 'panda.workspace.view.menu', 'Conversation');
  await proposal(region, 'panda.sidebar.sort.menu', 'Created before Recent activity');
  await hide(page, region, 'panda.sidebar.sort.menu', '10 tasks');
  await hide(page, region, 'panda.sidebar.sort.menu', '6 tasks');
  // Pinned and protected entries are not layout items: no Hide control exists for them.
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.sidebar.sort.menu');
  const visibility = region.getByRole('list', { name: 'Item visibility', exact: true });
  await expect(visibility.getByRole('button', { name: /^Hide Manual/ })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.projects.filter.menu');
  await expect(visibility.getByRole('button', { name: /^Hide All projects/ })).toHaveCount(0);
  await back(page);
  for (const reload of [false, true]) {
    if (reload) await load(page);
    const when = reload ? 'after reload' : 'live';
    // The open view is pinned even though the user hid it: it stays listed and checked.
    const list = await open(page, 'view'); views = await names(list);
    expect(views.indexOf('GitHub'), when).toBeLessThan(views.indexOf('Board')); expect(views[0], when).toBe('Conversation'); expect(views, when).toContain('Window notes');
    await expect(list.getByRole('menuitemradio', { name: 'Conversation', exact: true }), when).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
    const sort = await names(await open(page, 'sort')); await page.keyboard.press('Escape');
    expect(sort.indexOf('Created'), when).toBeLessThan(sort.indexOf('Recent activity')); expect(sort, when).not.toContain('10 tasks');
    // The selected count stays even though it is hidden; Manual keeps its place at the top.
    expect(sort, when).toEqual(expect.arrayContaining(['Manual', '6 tasks', '3 tasks', '15 tasks', 'Sort notes'])); expect(sort[0], when).toBe('Manual');
    const filter = await names(await open(page, 'filter')); await page.keyboard.press('Escape');
    expect(filter, when).toEqual(['All projects', 'orbit', 'pandacode', 'Filter notes']);
  }
  // Hiding a view that is not open removes it; the host's view is unchanged and the presentation marks the control hidden.
  await hide(page, await explorer(page), 'panda.workspace.view.menu', 'Board'); await back(page);
  expect(await names(await open(page, 'view'))).not.toContain('Board'); await page.keyboard.press('Escape');
  // Safe mode shows the built-in order and every entry, with no contributed item and no deleted preference; a normal launch restores them.
  await page.evaluate(() => (window as any).__previewWindowMenusSafeMode());
  expect(await names(await open(page, 'view'))).toEqual(['Conversation', 'Board', 'GitHub']); await page.keyboard.press('Escape');
  expect(await names(await open(page, 'sort'))).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks']); await page.keyboard.press('Escape');
  expect((await props(page)).safeMode).toBe(true);
  await load(page);
  expect(await names(await open(page, 'sort'))).not.toContain('10 tasks'); await page.keyboard.press('Escape');
  await noMutation(page);
});

test('Window menus extension: captured actions run the original handlers once after a fresh choice; protected, stale and forged requests are refused', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]); await select(page);
  const initial = await props(page);
  expect(initial).toMatchObject({ visible: true, busy: false, menu: 'none', safeMode: false });
  expect(JSON.stringify(initial)).not.toMatch(/orbit|pandacode|Conversation|Board|session-|project-|recent/);
  // The open view is not a target for itself; the others are.
  expect((await ofKind(page, 'view-open')).map((control: any) => control.enabled)).toEqual([false, true, true]);
  expect((await ofKind(page, 'sort-set')).map((control: any) => control.enabled)).toEqual([true, true, false]);
  expect((await ofKind(page, 'scope-set')).map((control: any) => control.enabled)).toEqual([true, false, true, true]);
  expect((await ofKind(page, 'filter-set')).map((control: any) => control.enabled)).toEqual([false, true, true]);
  // Sort and count ask first, run once and save per window like the menu's own choice.
  expect(await act(page, 'sort-set', {}, 0)).toEqual({ ok: true });
  await expect(choice(page, 'Sort tasks by Recent activity')).toBeVisible();
  await page.keyboard.press('Escape'); expect((await sortOf(page)).tasks ?? 'manual').toBe('manual');
  expect(await act(page, 'sort-set', {}, 0)).toEqual({ ok: true });
  await choice(page, 'Sort tasks by Recent activity').click();
  await expect.poll(async () => (await sortOf(page)).tasks).toBe('recent');
  expect(await act(page, 'scope-set', {}, 2)).toEqual({ ok: true });
  await choice(page, 'Show 10 tasks per section').click();
  await expect.poll(async () => (await sortOf(page)).perProject).toBe(10);
  expect((await sortOf(page)).tasks).toBe('recent');
  // The project filter asks first, and clearing it goes through the same choice.
  expect(await act(page, 'filter-set', {}, 2)).toEqual({ ok: true });
  await expect(choice(page, 'Show only pandacode')).toBeVisible();
  await page.keyboard.press('Escape'); expect(await stored(page, 'pandacode.projectFilter')).toBeFalsy();
  expect(await act(page, 'filter-set', {}, 2)).toEqual({ ok: true });
  await choice(page, 'Show only pandacode').click();
  await expect.poll(() => stored(page, 'pandacode.projectFilter')).toBe('project-2');
  expect(await act(page, 'filter-set', {}, 0)).toEqual({ ok: true });
  await choice(page, 'Show all projects').click();
  await expect.poll(() => stored(page, 'pandacode.projectFilter')).toBe('');
  // Sensitive and host-only operations named by a package are refused before anything else.
  for (const controlId of PROTECTED) for (const control of ['control-x', 'foreign']) expect(await act(page, controlId, { control, query: 'x' }), controlId).toEqual({ ok: false, reason: 'PermissionDenied' });
  for (const change of [{ selector: '.sort' }, { text: 'hello' }, { query: 'orbit' }, { window: 'tray' }, { requestId: '' }]) expect(await act(page, 'sort-set', change)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'sort-set', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // Stale: another view, sort, filter, mount or revision, a forged resource or control.
  for (const change of [{ view: 'foreign' }, { sort: 'foreign' }, { filter: 'foreign' }, { context: 'foreign' }, { revision: 0 }, { control: 'foreign' }, { resource: 'foreign' }]) expect(await act(page, 'sort-set', change), JSON.stringify(change)).toEqual({ ok: false, reason: 'StaleContext' });
  // A request built for one state is refused after the user changes the sort; a replay is refused.
  const stale = await build(page, 'filter-set', {}, 1);
  await (await open(page, 'sort')).getByRole('menuitemradio', { name: 'Created', exact: true }).click();
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  // Busy while a host menu is open.
  const list = await open(page, 'sort');
  expect(await act(page, 'filter-set', {}, 1)).toEqual({ ok: false, reason: 'Busy' }); expect((await props(page)).menu).toBe('sort');
  await page.keyboard.press('Escape'); await expect(list).toHaveCount(0);
  const request = await build(page, 'filter-set', {}, 1);
  expect(await send(page, request)).toEqual({ ok: true });
  await expect(choice(page, 'Show only orbit')).toBeVisible();
  await page.keyboard.press('Escape'); expect(await stored(page, 'pandacode.projectFilter')).toBeFalsy();
  expect(await send(page, request)).toEqual({ ok: false, reason: 'AlreadyApplied' });
  // Switching the view asks first; Escape declines and nothing changes; Continue switches once through the original navigation.
  expect(await act(page, 'view-open', {}, 1)).toEqual({ ok: true });
  await expect(choice(page, 'Open the Board view')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(choice(page, 'Open the Board view')).toHaveCount(0);
  expect(await viewLabel(page)).toBe('Workspace view: Conversation');
  expect(await act(page, 'view-open', {}, 1)).toEqual({ ok: true });
  await choice(page, 'Open the Board view').click();
  await expect.poll(() => viewLabel(page)).toBe('Workspace view: Board'); expect(await stored(page, 'pandacode.view')).toBe('board');
  // The open view is no longer a target for itself; the board has no sidebar, so the sort has no trigger to anchor on.
  expect((await ofKind(page, 'view-open')).map((control: any) => control.enabled)).toEqual([true, false, true]);
  expect(await act(page, 'view-open', {}, 1)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'sort-set', {}, 0)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await noMutation(page);
});

test('Window menus extension: conflict, fault, disable and safe mode keep the active view, sort, count and filter with no duplicate change', async ({ page }) => {
  test.setTimeout(120_000);
  const rival = JSON.parse(JSON.stringify(manifest).replaceAll('sample.window-menus', 'other.window-menus'));
  delete rival.contributes.components; delete rival.contributes.layouts; rival.permissions = ['ui.contribute'];
  await setup(page, [manifest, rival]); await select(page);
  // The user's own choices first: Created, 3 tasks and the second project (the board hides the sidebar, so the view comes last).
  await (await open(page, 'sort')).getByRole('menuitemradio', { name: 'Created', exact: true }).click();
  await (await open(page, 'sort')).getByRole('menuitemradio', { name: '3 tasks', exact: true }).click();
  await (await open(page, 'filter')).getByRole('menuitemradio', { name: 'pandacode', exact: true }).click(); await expect.poll(() => stored(page, 'pandacode.projectFilter')).toBe('project-2');
  const kept = async (when: string, view = 'Conversation') => {
    expect(await viewLabel(page), when).toBe(`Workspace view: ${view}`);
    expect(await sortOf(page), when).toMatchObject({ tasks: 'created', perProject: 3 }); expect(await stored(page, 'pandacode.projectFilter'), when).toBe('project-2');
  };
  await kept('start');
  // Two owners contribute to the same menus: each item appears once per owner, the host's rows once.
  let list = await open(page, 'sort');
  const sort = await names(list);
  expect(sort.filter(name => name === 'Sort notes')).toHaveLength(2); expect(sort.filter(name => name === 'Created')).toHaveLength(1); expect(sort.filter(name => name === 'Manual')).toHaveLength(1);
  await page.keyboard.press('Escape');
  // Disabling the rival leaves one item and the same host rows.
  await page.evaluate(() => (window as any).__previewDisableExtension('other.window-menus'));
  list = await open(page, 'sort'); expect((await names(list)).filter(name => name === 'Sort notes')).toHaveLength(1); await page.keyboard.press('Escape');
  // A fault of the selected composer recipe revokes captured actions; the menus stay usable and nothing changed.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'sort-set')).toEqual({ ok: false, reason: 'Revoked' });
  list = await open(page, 'view'); await expect(list.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
  await kept('fault');
  // Disabling the owner while its menu is open closes the menu without running anything; the host's rows return once.
  list = await open(page, 'filter');
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.window-menus'));
  await expect(list).toHaveCount(0);
  list = await open(page, 'filter'); expect(await names(list)).toEqual(['All projects', 'orbit', 'pandacode']);
  await expect(list.getByRole('menuitemradio', { name: 'pandacode', exact: true })).toHaveAttribute('aria-checked', 'true'); await page.keyboard.press('Escape');
  list = await open(page, 'sort'); expect(await names(list)).toEqual(['Manual', 'Recent activity', 'Created', '3 tasks', '6 tasks', '10 tasks', '15 tasks']); await page.keyboard.press('Escape');
  expect(await act(page, 'filter-set')).toEqual({ ok: false, reason: 'Revoked' });
  await kept('disable');
  // Safe mode: nothing contributes and every captured action is revoked; the choices are still the user's.
  await page.evaluate(() => (window as any).__previewWindowMenusSafeMode());
  expect((await props(page)).safeMode).toBe(true);
  expect(await act(page, 'view-open')).toEqual({ ok: false, reason: 'Revoked' });
  expect(await names(await open(page, 'view'))).toEqual(['Conversation', 'Board', 'GitHub']); await page.keyboard.press('Escape');
  await kept('safe mode');
  // The user's own view choice still works in safe mode and changes nothing else.
  await (await open(page, 'view')).getByRole('menuitemradio', { name: 'Board', exact: true }).click(); await expect.poll(() => viewLabel(page)).toBe('Workspace view: Board');
  await kept('board', 'Board'); expect(await stored(page, 'pandacode.view')).toBe('board');
  await noMutation(page);
});
