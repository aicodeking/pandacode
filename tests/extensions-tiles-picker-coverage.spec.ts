import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { MAX_TILES, tilesThatFit } from '../src/tile-layout';
// Browser fixtures only: the extensions baseline transport with the preview's four seeded threads (session-4 in the
// second project) and its two projects. No real harness runs; installed WebView qualification is separate and not
// claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/tiles-picker/extension.json', import.meta.url), 'utf8'));
const TIMELINE = 'sample.tiles-picker/timeline', TOOLBAR = 'sample.tiles-picker/toolbar';
const BASE = '/?extensions-baseline&tiles-picker&replacement';
const tilesProps = (page: Page) => page.evaluate(() => (window as any).__previewTiles());
const pickerProps = (page: Page) => page.evaluate(() => (window as any).__previewPicker());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const moves = async (page: Page) => (await calls(page, 'configure_session')).filter((call: any) => call.args.projectId);
const prompt = (page: Page) => page.locator('#prompt');
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tile = (page: Page, id: string) => page.locator(`.thread-tile[data-tile="${id}"]`);
const tiles = (page: Page) => page.locator('.thread-tile');
const current = (page: Page) => page.locator('#navigation .task-item.selected').getAttribute('data-id');
const barOrder = (page: Page, id: string) => tile(page, id).locator('.thread-tile-bar > button').evaluateAll(nodes => nodes.map(node => node.classList.contains('thread-tile-close') ? 'close' : 'title'));
const trigger = (page: Page) => page.locator('#welcome-project');
const heading = (page: Page) => page.getByRole('heading', { name: /^What should we build in/ });
const picker = (page: Page) => page.getByRole('dialog', { name: 'Choose project', exact: true });
const options = (page: Page) => picker(page).getByRole('option').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.projectId));
const contributed = (page: Page, id: string) => page.locator(`[data-extension-contribution="sample.tiles-picker/${id}"]`);
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}` });
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load. */
async function load(page: Page, url = BASE) {
  await page.goto(url); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await tilesProps(page))).toBe(true);
  await expect(row(page, 'session-2')).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page) {
  await explorer(page);
  await page.getByLabel('Transcript presentation', { exact: true }).selectOption(TIMELINE);
  await page.getByLabel('Composer presentation', { exact: true }).selectOption(TOOLBAR);
  await back(page);
  await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', TIMELINE);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', TOOLBAR);
}
/** session-1 open, session-2 opened beside it (Ctrl/⌘-click): session-2 is focused, session-1 is a read-only mirror. */
async function openTiles(page: Page) {
  await row(page, 'session-1').click(); await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  await row(page, 'session-2').click({ modifiers: ['ControlOrMeta'] });
  await expect(tiles(page)).toHaveCount(2); await expect.poll(() => current(page)).toBe('session-2');
  await expect(tile(page, 'session-1').locator('.thread-mirror')).toBeVisible();
}
async function newTask(page: Page, draft = '') {
  await page.locator('.new-task-button').click(); await expect(heading(page)).toHaveAccessibleName('What should we build in orbit?');
  if (draft) await prompt(page).fill(draft);
  return (await prompt(page).getAttribute('data-session-id'))!;
}
function build(page: Page, kind: 'tiles' | 'picker', controlId: string, changes: Record<string, unknown> = {}, pick: { resource?: string; nth?: number } = {}) {
  return page.evaluate(({ kind, controlId, changes, pick }) => {
    const p = kind === 'tiles' ? (window as any).__previewTiles() : (window as any).__previewPicker();
    const matching = p.controls.filter((item: any) => item.controlId === controlId && (!pick.resource || item.resource === pick.resource)), control = matching[pick.nth ?? 0] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { kind, controlId, changes, pick });
}
const send = (page: Page, kind: 'tiles' | 'picker', input: unknown) => page.evaluate(({ kind, input }) => kind === 'tiles' ? (window as any).__previewTilesAction(input) : (window as any).__previewPickerAction(input), { kind, input });
const act = async (page: Page, kind: 'tiles' | 'picker', controlId: string, changes: Record<string, unknown> = {}, pick: { resource?: string; nth?: number } = {}) => send(page, kind, await build(page, kind, controlId, changes, pick));
/** The opaque resource of a tile, by its position in the presentation's `tiles` (the tiles' order). */
const tileResource = async (page: Page, index: number) => (await tilesProps(page)).tiles[index] as string;
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, region: ReturnType<Page['locator']>, location: string, label: string) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: new RegExp(`^Hide ${label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}( —|$)`) });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
/** Opens a contributed action's dialog, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, button: ReturnType<Page['locator']>, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await button.click();
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}
const noInput = async (page: Page) => { for (const command of ['send_message', 'steer_message']) expect(await calls(page, command), command).toEqual([]); };

test('Tiles picker extension: zero extensions keep tiles (focus switch, MAX_TILES, layout) and the draft project picker', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await openTiles(page);
  await expect(page.locator('.thread-tile-bar [data-tiles-picker], .thread-tile-bar [data-layout-hidden], .thread-tile-bar .extension-action-slot, .thread-mirror-composer[data-layout-hidden]')).toHaveCount(0);
  expect(await barOrder(page, 'session-1')).toEqual(['close', 'title']);
  expect(await tilesProps(page)).toMatchObject({ visible: true, busy: false, safeMode: false });
  expect((await tilesProps(page)).tiles).toHaveLength(2);
  expect(await act(page, 'tiles', 'tile-focus')).toEqual({ ok: false, reason: 'Revoked' });
  // Focus switch: clicking a mirror is an ordinary thread switch; the other tile becomes the mirror.
  await tile(page, 'session-1').locator('.thread-tile-title').click();
  await expect.poll(() => current(page)).toBe('session-1');
  await expect(tile(page, 'session-2').locator('.thread-mirror')).toBeVisible(); await expect(tile(page, 'session-1').locator('.thread-mirror')).toBeHidden();
  // MAX_TILES and room: a window with room for two keeps two and says so.
  await page.setViewportSize({ width: 1180, height: 490 });
  await expect.poll(() => page.locator('.work-area').getAttribute('data-tiles')).toBe('2');
  const area = await page.locator('.work-area').evaluate(node => [node.clientWidth, node.clientHeight]);
  expect(Math.min(MAX_TILES, tilesThatFit(area[0], area[1])), `room in ${area}`).toBe(2);
  await row(page, 'session-3').click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('#toast')).toContainText('No room for another view.');
  await expect(tiles(page)).toHaveCount(2);
  await page.setViewportSize({ width: 1440, height: 900 });
  await row(page, 'session-3').click({ modifiers: ['ControlOrMeta'] });
  await expect(tiles(page)).toHaveCount(3); await expect.poll(() => current(page)).toBe('session-3');
  // Close view drops one tile; the focused thread stays.
  await tile(page, 'session-2').locator('.thread-tile-close').click();
  await expect(tiles(page)).toHaveCount(2); expect(await current(page)).toBe('session-3');
  await noInput(page);
  // The draft project picker: search, keyboard and a choice that moves the draft once and keeps its text.
  const draft = await newTask(page, 'Keep this draft while I choose the project');
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
  expect(await options(page)).toEqual(['no-project', 'project-1', 'project-2']);
  await expect(picker(page).locator('.project-menu-extensions, [data-layout-hidden]')).toHaveCount(0);
  await picker(page).getByRole('searchbox', { name: 'Search projects', exact: true }).press('Escape');
  await expect(picker(page)).toHaveCount(0); expect(await moves(page)).toEqual([]);
  await trigger(page).click();
  await picker(page).getByRole('option', { name: /^pandacode — / }).click();
  await expect(heading(page)).toHaveAccessibleName('What should we build in pandacode?');
  expect((await moves(page)).map((call: any) => [call.args.sessionId, call.args.projectId])).toEqual([[draft, 'project-2']]);
  await expect(prompt(page)).toHaveValue('Keep this draft while I choose the project'); await expect(prompt(page)).toHaveAttribute('data-session-id', draft);
});

test('Tiles picker extension: an installed package adds tile and picker actions that receive the tile\'s own thread and the draft', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.tiles-picker', exact: true }).click();
  await expect(region.getByLabel('Transcript presentation')).toHaveValue('');
  await back(page);
  await openTiles(page);
  // Every tile bar carries the contributed action; the mirror's names the mirror's thread, not the focused one.
  await expect(tile(page, 'session-1').locator('.thread-tile-bar > .extension-action-slot [data-extension-contribution="sample.tiles-picker/tile"]')).toBeVisible();
  await expect(tile(page, 'session-2').locator('[data-extension-contribution="sample.tiles-picker/tile"]')).toBeVisible();
  const mirror = await captured(page, tile(page, 'session-1').locator('[data-extension-contribution="sample.tiles-picker/tile"]'), 'Tile tags');
  expect(mirror).toMatchObject({ surfaceId: 'panda.workspace.tiles.actions', projectId: 'project-1', sessionId: 'session-1', selection: { kind: 'tile', ids: ['session-1'] } });
  expect(JSON.stringify(mirror)).not.toMatch(/Make search feel instant|Refine the navigation/);
  // Clicking it neither focused nor closed the mirror.
  expect(await current(page)).toBe('session-2'); await expect(tiles(page)).toHaveCount(2);
  const focusedTile = await captured(page, tile(page, 'session-2').locator('[data-extension-contribution="sample.tiles-picker/tile"]'), 'Tile tags');
  expect(focusedTile).toMatchObject({ sessionId: 'session-2', selection: { kind: 'tile', ids: ['session-2'] } });
  // A thread from the other project, opened in the focused tile's place, keeps its own project as a mirror.
  await row(page, 'session-4').click();
  await expect(tile(page, 'session-4')).toBeVisible(); await expect(tiles(page)).toHaveCount(2); await expect.poll(() => current(page)).toBe('session-4');
  await tile(page, 'session-1').locator('.thread-tile-title').click(); await expect.poll(() => current(page)).toBe('session-1');
  const other = await captured(page, tile(page, 'session-4').locator('[data-extension-contribution="sample.tiles-picker/tile"]'), 'Tile tags');
  expect(other).toMatchObject({ projectId: 'project-2', sessionId: 'session-4', selection: { kind: 'tile', ids: ['session-4'] } });
  expect(await current(page)).toBe('session-1');
  // The draft project picker's footer action captures the draft, never its text.
  const draft = await newTask(page, 'A secret plan for the new project');
  await trigger(page).click(); await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.project-menu-extensions [data-extension-contribution="sample.tiles-picker/draft"]')).toBeVisible();
  const drafted = await captured(page, contributed(page, 'draft'), 'Draft tags');
  expect(drafted).toMatchObject({ surfaceId: 'panda.workspace.project-picker.actions', projectId: 'project-1', sessionId: draft, selection: { kind: 'draft-project', ids: [draft] } });
  expect(JSON.stringify(drafted)).not.toMatch(/secret plan/);
  await expect(prompt(page)).toHaveValue('A secret plan for the new project');
  expect(await moves(page)).toEqual([]); await noInput(page);
});

test('Tiles picker extension: captured tile and picker actions run original handlers; mirrors take no input and the draft moves only after a fresh choice', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]); await select(page);
  await openTiles(page);
  const mirror = await tileResource(page, 0);
  // A package never sends input to a tile (a mirror least of all), reads its rows or changes the tile layout.
  for (const controlId of ['tile-send-input', 'tile-read-rows', 'tile-open', 'tile-move', 'tile-resize']) expect(await act(page, 'tiles', 'tile-focus', { controlId }, { resource: mirror })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'tiles', 'tile-focus', { text: 'hello' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'tiles', 'tile-focus', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'tiles', 'tile-focus', { [field]: 'forged' }, { resource: mirror })).toEqual({ ok: false, reason: 'StaleContext' });
  // The focused tile's follow-up button is not shown: nothing to act on.
  expect(await act(page, 'tiles', 'tile-composer', {}, { resource: await tileResource(page, 1) })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await noInput(page);
  // Focusing the mirror is the original thread switch; a request captured before it is stale afterwards.
  const before = await build(page, 'tiles', 'tile-close', {}, { resource: mirror });
  expect(await act(page, 'tiles', 'tile-focus', {}, { resource: mirror })).toEqual({ ok: true });
  await expect.poll(() => current(page)).toBe('session-1');
  expect(await send(page, 'tiles', before)).toEqual({ ok: false, reason: 'StaleContext' });
  // The other tile's follow-up button focuses it and its own composer; nothing is sent.
  expect(await act(page, 'tiles', 'tile-composer', {}, { resource: await tileResource(page, 1) })).toEqual({ ok: true });
  await expect.poll(() => current(page)).toBe('session-2'); await expect(prompt(page)).toBeFocused();
  await noInput(page);
  // Closing a view asks first; Escape declines; Continue closes it once.
  expect(await act(page, 'tiles', 'tile-close', {}, { resource: mirror })).toEqual({ ok: true });
  expect((await tilesProps(page)).busy).toBe(true);
  await expect(choice(page, 'Close this view')).toBeVisible();
  expect(await act(page, 'tiles', 'tile-focus', {}, { resource: mirror })).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice(page, 'Close this view')).toHaveCount(0);
  await expect(tiles(page)).toHaveCount(2);
  const close = await build(page, 'tiles', 'tile-close', {}, { resource: mirror });
  expect(await send(page, 'tiles', close)).toEqual({ ok: true }); await choice(page, 'Close this view').click();
  await expect(tiles(page)).toHaveCount(0); expect(await current(page)).toBe('session-2');
  expect(await send(page, 'tiles', { ...close, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  // The picker: the toggle opens the original picker; a package never moves the draft itself.
  const draft = await newTask(page, 'Move me only when I say so');
  for (const controlId of ['picker-move', 'picker-read-draft', 'picker-set-search', 'picker-create-project', 'picker-clear-attachments']) expect(await act(page, 'picker', 'picker-toggle', { controlId, projectId: 'project-2' })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'picker', 'picker-toggle', { draft: 'text' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: true });
  await expect(picker(page)).toBeVisible();
  expect(await pickerProps(page)).toMatchObject({ open: true, draft: true, entries: 3 });
  const target = (await pickerProps(page)).controls.filter((item: any) => item.controlId === 'picker-select')[2].resource;
  expect(await act(page, 'picker', 'picker-select', {}, { resource: target })).toEqual({ ok: true });
  await expect(choice(page, 'Move this draft to pandacode')).toBeVisible();
  expect(await moves(page)).toEqual([]);
  await page.keyboard.press('Escape'); await expect(choice(page, 'Move this draft to pandacode')).toHaveCount(0);
  await expect(heading(page)).toHaveAccessibleName('What should we build in orbit?'); expect(await moves(page)).toEqual([]);
  // An edited draft is another revision: a request captured before the edit is stale.
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: true }); await expect(picker(page)).toBeVisible();
  const stale = await build(page, 'picker', 'picker-select', {}, { resource: target });
  await picker(page).getByRole('searchbox', { name: 'Search projects', exact: true }).press('Escape');
  await prompt(page).fill('Move me only when I say so, now');
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: true }); await expect(picker(page)).toBeVisible();
  expect(await send(page, 'picker', stale)).toEqual({ ok: false, reason: 'StaleContext' });
  const move = await build(page, 'picker', 'picker-select', {}, { resource: target });
  expect(await send(page, 'picker', move)).toEqual({ ok: true }); await choice(page, 'Move this draft to pandacode').click();
  await expect(heading(page)).toHaveAccessibleName('What should we build in pandacode?');
  expect((await moves(page)).map((call: any) => [call.args.sessionId, call.args.projectId])).toEqual([[draft, 'project-2']]);
  await expect(prompt(page)).toHaveValue('Move me only when I say so, now'); await expect(prompt(page)).toHaveAttribute('data-session-id', draft);
  expect(await send(page, 'picker', { ...move, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await moves(page)).toHaveLength(1); await noInput(page);
});

test('Tiles picker extension: tile control and picker entry order and hiding persist across a reload and never touch pinned entries', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]);
  await proposal(page, 'panda.workspace.tiles.controls', 'Tile title before Close view'); await back(page);
  await proposal(page, 'panda.workspace.project-picker.entries', 'Other projects before No project'); await back(page);
  const region = await explorer(page);
  await hide(page, region, 'panda.workspace.tiles.controls', 'Mirror follow-up button');
  await hide(page, region, 'panda.workspace.project-picker.entries', 'Open project…');
  await expect(region.getByRole('button', { name: /^Hide Tile title/ })).toHaveCount(0);
  await expect(region.getByRole('button', { name: /^Hide (Current project|Other projects)/ })).toHaveCount(0);
  await back(page);
  const check = async () => {
    await openTiles(page);
    await expect.poll(() => barOrder(page, 'session-1')).toEqual(['title', 'close']);
    await expect(tile(page, 'session-1').locator('.thread-mirror-composer')).toHaveAttribute('data-layout-hidden', '');
    await expect(tile(page, 'session-1').locator('.thread-mirror-composer')).toBeHidden();
    // The mirror still focuses from its title.
    await tile(page, 'session-1').locator('.thread-tile-title').click(); await expect.poll(() => current(page)).toBe('session-1');
    await newTask(page);
    await trigger(page).click(); await expect(picker(page)).toBeVisible();
    expect(await options(page)).toEqual(['project-1', 'project-2', 'no-project']);
    await expect(picker(page).locator('.project-menu-open')).toBeHidden();
    await picker(page).getByRole('searchbox', { name: 'Search projects', exact: true }).press('Escape');
  };
  await check();
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await tilesProps(page))).toBe(true);
  await check();
  // Hiding No project never hides the draft's current project.
  const next = await explorer(page); await hide(page, next, 'panda.workspace.project-picker.entries', 'No project'); await back(page);
  await trigger(page).click(); await expect(picker(page)).toBeVisible();
  expect(await options(page)).toEqual(['project-1', 'project-2']);
  await expect(picker(page).getByRole('option', { name: /^orbit — / })).toHaveAttribute('aria-selected', 'true');
  await picker(page).getByRole('searchbox', { name: 'Search projects', exact: true }).press('Escape');
  // A forged overlay cannot hide a tile's title, the current project or the other projects.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.workspace.tiles.controls/title': false, 'panda.workspace.project-picker.entries/current': false, 'panda.workspace.project-picker.entries/projects': false, 'panda.workspace.tiles-picker.protected/mirror-input': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await trigger(page).click(); await expect(picker(page)).toBeVisible();
  expect(await options(page)).toEqual(['project-1', 'project-2']);
  await picker(page).getByRole('searchbox', { name: 'Search projects', exact: true }).press('Escape');
  await openTiles(page);
  await expect(tile(page, 'session-1').locator('.thread-tile-title')).toBeVisible();
  expect(await moves(page)).toEqual([]); await noInput(page);
});

test('Tiles picker extension: the focused thread, mirrors, the draft and its project survive conflict, fault, disable and safe mode with no duplicate move', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.tiles-picker';
  other.contributes = { components: manifest.contributes.components.map((component: any) => ({ ...component, id: component.id.replace('sample.', 'other.') })), commands: [{ id: 'other.tiles-picker/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.tiles-picker/tile', command: 'other.tiles-picker/notes', location: 'panda.workspace.tiles.actions', presentation: 'button', text: 'Other notes' }] };
  await setup(page, [manifest, other]);
  // Two compatible providers: neither is selected automatically, so no package owns captured actions.
  await explorer(page); await expect(page.getByLabel('Transcript presentation', { exact: true })).toHaveValue(''); await back(page);
  const draft = await newTask(page, 'Keep this draft and its project');
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await openTiles(page);
  expect(await act(page, 'tiles', 'tile-focus')).toEqual({ ok: false, reason: 'Revoked' });
  // Both packages contribute to every tile bar; neither displaces Close or the title.
  await expect(tile(page, 'session-1').locator('[data-extension-contribution]')).toHaveCount(2);
  await prompt(page).fill('Keep this focused draft'); await prompt(page).focus();
  const check = async (contributions = 2) => {
    await expect(tiles(page)).toHaveCount(2); expect(await current(page)).toBe('session-2');
    await expect(tile(page, 'session-1').locator('.thread-mirror')).toBeVisible(); await expect(tile(page, 'session-2').locator('.thread-mirror')).toBeHidden();
    await expect(tile(page, 'session-1').locator('.thread-tile-close')).toBeAttached(); expect(await barOrder(page, 'session-1')).toEqual(['close', 'title']);
    await expect(prompt(page)).toHaveValue('Keep this focused draft'); await expect(prompt(page)).toBeFocused();
    await expect(tile(page, 'session-1').locator('[data-extension-contribution]')).toHaveCount(contributions);
    expect(await moves(page)).toEqual([]); await noInput(page);
  };
  await check();
  // Selecting the providers, then a faulting transcript recipe: captured tile actions stop; the tiles stay.
  await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption('other.tiles-picker/timeline'); await back(page);
  await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', 'other.tiles-picker/timeline');
  await prompt(page).focus(); await check();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#transcript')).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'tiles', 'tile-focus')).toEqual({ ok: false, reason: 'Revoked' });
  await prompt(page).focus(); await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.tiles-picker'));
  await prompt(page).focus(); await check(1);
  // Selected again, the provider owns captured actions: a captured Close asks first; Escape declines it and both tiles stay.
  await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(TIMELINE); await back(page);
  await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', TIMELINE);
  expect(await act(page, 'tiles', 'tile-close', {}, { resource: await tileResource(page, 0) })).toEqual({ ok: true });
  await expect(choice(page, 'Close this view')).toBeVisible(); await page.keyboard.press('Escape'); await expect(choice(page, 'Close this view')).toHaveCount(0);
  await prompt(page).focus(); await check(1);
  // The draft: a package's move waits for the fresh choice; a composer fault before Continue moves nothing.
  await page.locator('.new-task-button').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', draft);
  await expect(prompt(page)).toHaveValue('Keep this draft and its project'); await expect(heading(page)).toHaveAccessibleName('What should we build in orbit?');
  await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(TOOLBAR); await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', TOOLBAR);
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: true }); await expect(picker(page)).toBeVisible();
  const target = (await pickerProps(page)).controls.filter((item: any) => item.controlId === 'picker-select')[2].resource;
  expect(await act(page, 'picker', 'picker-select', {}, { resource: target })).toEqual({ ok: true });
  await expect(choice(page, 'Move this draft to pandacode')).toBeVisible();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await choice(page, 'Move this draft to pandacode').click();
  await expect(heading(page)).toHaveAccessibleName('What should we build in orbit?'); expect(await moves(page)).toEqual([]);
  expect(await act(page, 'picker', 'picker-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(prompt(page)).toHaveValue('Keep this draft and its project');
  await row(page, 'session-2').click(); await expect.poll(() => current(page)).toBe('session-2');
  await prompt(page).fill('Keep this focused draft'); await prompt(page).focus(); await check(1);
  // Safe mode restores the built-in bars and picker: no markers, contributions or captured actions; tiles still focus.
  await page.evaluate(() => (window as any).__previewTilesPickerSafeMode());
  await expect.poll(async () => (await tilesProps(page)).safeMode).toBe(true);
  expect(await act(page, 'tiles', 'tile-focus')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('[data-tiles-picker], .thread-tile-bar [data-layout-hidden], .thread-mirror-composer[data-layout-hidden], [data-extension-contribution]')).toHaveCount(0);
  await prompt(page).focus(); await check(0);
  await tile(page, 'session-1').locator('.thread-tile-title').click(); await expect.poll(() => current(page)).toBe('session-1');
  // The host still moves the draft, once, through its own picker.
  await page.locator('.new-task-button').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', draft);
  await expect(prompt(page)).toHaveValue('Keep this draft and its project'); await expect(heading(page)).toHaveAccessibleName('What should we build in orbit?');
  await trigger(page).click(); await expect(picker(page)).toBeVisible();
  await expect(picker(page).locator('.project-menu-extensions, [data-layout-hidden]')).toHaveCount(0);
  await picker(page).getByRole('option', { name: /^pandacode — / }).click();
  await expect(heading(page)).toHaveAccessibleName('What should we build in pandacode?');
  expect((await moves(page)).map((call: any) => [call.args.sessionId, call.args.projectId])).toEqual([[draft, 'project-2']]);
  await expect(prompt(page)).toHaveValue('Keep this draft and its project');
});
