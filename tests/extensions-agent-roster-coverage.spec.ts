import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's synthetic `subagent` events, its team profile library and its Running agents
// snapshot, with the extensions baseline transport. No real harness or agent runs; installed-window qualification is
// separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/agent-roster/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.agent-roster/running-first';
const WIDGET_ON = JSON.stringify({ enabled: true, keepOnScreen: true, pinned: false });
const props = (page: Page) => page.evaluate(() => (window as any).__previewRoster());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const host = (page: Page) => page.locator('#subagents-host');
const panel = (page: Page) => page.locator('#subagents-panel');
const row = (page: Page, id: string) => panel(page).locator(`.subagents-list [data-subagent-id="${id}"]`);
const order = (page: Page) => panel(page).locator('.subagents-list [data-subagent-id]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.subagentId));
const heading = (page: Page) => panel(page).locator('.subagents-heading > button').evaluateAll(nodes => nodes.map(node => node.className.includes('subagents-back') ? 'back' : 'close'));
const widget = (page: Page) => page.locator('.agents-dock-trigger');
const popover = (page: Page) => page.locator('#agents-dock-popover');
const library = (page: Page) => page.locator('.team-library');
const toast = (page: Page) => page.locator('#toast');
const NOT_CALLED = ['stop_session', 'architect_control', 'agents_dock_pin', 'agents_dock_save_preferences', 'architect_delete_profile'];
async function setup(page: Page, packages: unknown[] = [], options: { widget?: boolean; classic?: boolean } = {}) {
  await page.addInitScript(({ packages, options, widgetOn }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
    if (options.widget && !sessionStorage.getItem('roster-widget-seeded')) { localStorage.setItem('pandacode.preview.agents-dock', widgetOn); sessionStorage.setItem('roster-widget-seeded', '1'); }
    if (options.classic) localStorage.setItem('pandacode.teamClassic', 'true');
  }, { packages, options, widgetOn: WIDGET_ON });
  await page.goto('/?extensions-baseline&roster-coverage&replacement'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.controls.length ?? 0).toBeGreaterThan(0);
}
/** Four children of the open task in start order: Scout settled, Builder working, Reviewer failed, Fixer (from Builder) working. */
async function children(page: Page, sessionId = 'session-1') {
  await page.evaluate(sessionId => {
    const emit = (window as any).__previewSubagent;
    emit(sessionId, { id: 'a', name: 'Scout', status: 'completed', response: 'Scout found the files.' });
    emit(sessionId, { id: 'b', name: 'Builder', status: 'running' });
    emit(sessionId, { id: 'c', name: 'Reviewer', status: 'failed' });
    emit(sessionId, { id: 'd', name: 'Fixer', status: 'running', parentId: 'b' });
  }, sessionId);
}
async function openView(page: Page) {
  await page.locator('#agents-toggle').click(); await expect(panel(page)).toBeVisible();
  await expect(row(page, 'd')).toHaveCount(1);
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Agent roster presentation', { exact: true }).selectOption(id); await back(page); await expect(host(page)).toHaveAttribute('data-roster-provider', id); }
/** Builds a captured action from the live presentation. Child handles are opaque: the test maps them by the order of
 * the drawn rows, which is the order the presentation lists them; profiles by the picker's order. */
async function action(page: Page, controlId: string, target: { child?: string; index?: number } = {}, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, target, changes }) => {
    const p = (window as any).__previewRoster();
    const candidates = p.controls.filter((control: any) => control.controlId === controlId);
    let control = candidates[target.index ?? 0];
    if (target.child) {
      const rows = [...document.querySelectorAll<HTMLElement>('#subagents-panel .subagents-list [data-subagent-id]')].map(node => node.dataset.subagentId);
      control = candidates[rows.indexOf(target.child)];
    }
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, profile: p.profile, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, target, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewRosterAction(input), input);
const act = async (page: Page, controlId: string, target: { child?: string; index?: number } = {}, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, target, changes));
async function proposal(page: Page, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.roster.controls');
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, label: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.roster.controls');
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 4 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}
/** The classic team setup with two saved profiles whose lead guidance differs, through the original Save as handler. */
async function openSetup(page: Page) {
  await page.getByRole('button', { name: 'Architect & workers', exact: true }).click();
  await expect(library(page)).toBeVisible();
}
async function saveProfiles(page: Page) {
  for (const name of ['Alpha', 'Beta']) {
    await page.locator('#team-guidance').fill(`${name} guidance`);
    await library(page).locator('.team-library-create').click();
    await library(page).getByLabel('Profile name', { exact: true }).fill(name);
    await library(page).locator('.team-library-confirm').click();
    await expect(library(page).locator('.team-library-picker')).toHaveText(name);
  }
}
const noAuthority = async (page: Page) => { for (const command of NOT_CALLED) expect(await calls(page, command), command).toEqual([]); };

test('Agent roster extension: zero extensions keep subagent rows, profiles, the widget and their original handlers', async ({ page }) => {
  await setup(page, [], { widget: true, classic: true }); await children(page); await openView(page);
  expect(await order(page)).toEqual(['a', 'b', 'c', 'd']);
  await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, view: 'list', child: '', progress: false, running: 0, children: [], agents: [], widget: true, widgetOpen: false });
  expect(p.task).not.toBe(''); expect(p.controls.filter((control: any) => control.controlId === 'subagent-open')).toHaveLength(4);
  expect(await act(page, 'subagent-open', { child: 'b' })).toEqual({ ok: false, reason: 'Revoked' }); await expect(panel(page).locator('.subagent-detail')).toBeHidden();
  // No context menu on a subagent row without a contribution there.
  await row(page, 'b').focus(); await page.keyboard.press('Shift+F10'); await expect(page.getByRole('dialog', { name: 'Subagent', exact: true })).toHaveCount(0);
  // Original row, lineage label and Back.
  await expect(row(page, 'd')).toContainText('From Builder');
  await row(page, 'b').click(); await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Builder');
  await panel(page).locator('.subagents-back').click(); await expect(row(page, 'b')).toBeFocused();
  await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  // The widget's original trigger and rows.
  await widget(page).click(); await expect(popover(page)).toBeVisible(); await expect(popover(page)).toContainText('Polish the new onboarding');
  // A press outside closes it (WebKit does not focus a clicked button, so Escape is a keyboard path only).
  await prompt(page).click(); await expect(popover(page)).toBeHidden();
  await openSetup(page); await expect(library(page).locator('.team-library-picker')).toBeVisible();
  await noAuthority(page);
});

test('Agent roster extension: install/enable writes no preference; running-first moves the original rows and the row menu runs core and contributed actions', async ({ page }) => {
  await setup(page); await children(page);
  const region = await explorer(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.agent-roster', exact: true }).click();
  await expect(region.getByLabel('Agent roster presentation')).toHaveValue(''); await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  await region.getByLabel('Agent roster presentation').selectOption(PROVIDER); await back(page);
  await expect(host(page)).toHaveAttribute('data-roster-provider', PROVIDER);
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  await openView(page);
  const nodes = await page.evaluate(() => { const w = window as any; w.__rosterRows = Object.fromEntries([...document.querySelectorAll<HTMLElement>('#subagents-panel [data-subagent-id]')].map(node => [node.dataset.subagentId, node])); return Object.keys(w.__rosterRows).length; });
  expect(nodes).toBe(4);
  // Working children lead, start order inside each group, the same nodes.
  expect(await order(page)).toEqual(['b', 'd', 'a', 'c']);
  await expect(row(page, 'd')).toContainText('From Builder');
  // A child that settles moves behind the working ones without a redraw of the others.
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'b', name: 'Builder', status: 'completed', response: 'Built.' }));
  await expect.poll(() => order(page)).toEqual(['d', 'a', 'b', 'c']);
  expect(await page.evaluate(() => { const w = window as any; return [...document.querySelectorAll<HTMLElement>('#subagents-panel [data-subagent-id]')].every(node => w.__rosterRows[node.dataset.subagentId!] === node); })).toBe(true);
  // Children data needs tasks.summary, which the package declares: opaque ids, statuses and lineage only.
  const p = await props(page);
  expect(p).toMatchObject({ progress: true, running: 1 });
  expect(p.children.map((child: any) => [child.status, child.active])).toEqual([['completed', false], ['completed', false], ['failed', false], ['running', true]]);
  expect(p.children.find((child: any) => child.status === 'running').parent).toBe(p.children[1].id);
  expect(JSON.stringify(p)).not.toMatch(/Scout|Builder|Reviewer|Fixer|Built\./);
  // The row menu: keyboard opens it on the child, the core row opens that child, the contributed one runs once.
  await row(page, 'd').focus(); await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('dialog', { name: 'Subagent', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Child notes', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Open subagent', exact: true }).click();
  await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Fixer');
  await panel(page).locator('.subagents-back').click();
  await row(page, 'a').click({ button: 'right' });
  menu = page.getByRole('dialog', { name: 'Subagent', exact: true });
  await menu.getByRole('menuitem', { name: 'Child notes', exact: true }).click(); await expect(toast(page)).toContainText('Subagents, their lineage and Stop stay host-owned');
  await noAuthority(page);
});

test('Agent roster extension: captured actions run original handlers; stale, replayed, forged, cross-task and Stop requests fail', async ({ page }) => {
  await setup(page, [manifest], { widget: true }); await select(page); await children(page);
  expect(await act(page, 'subagents', {}, { controlId: 'stop' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'widget', {}, { controlId: 'widget-pin' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'subagents', {}, { selector: '.subagent-row' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'subagents', {}, { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The original Subagents toggle opens the view (in the Agents flyout).
  const toggle = await action(page, 'subagents');
  expect(await send(page, toggle)).toEqual({ ok: true }); await expect(panel(page)).toBeVisible(); await expect(page.locator('#agents-flyout')).toBeVisible();
  expect(await send(page, toggle)).toEqual({ ok: false, reason: 'StaleContext' });
  await expect(row(page, 'd')).toHaveCount(1);
  const open = await action(page, 'subagent-open', { child: 'd' });
  // Another child's resource or control is another target.
  expect(await send(page, { ...open, resource: (await action(page, 'subagent-open', { child: 'b' })).resource })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, { ...open, requestId: crypto.randomUUID(), resource: 'child-of-another-task' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, open)).toEqual({ ok: true });
  await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Fixer'); expect((await props(page)).view).toBe('detail');
  expect(await send(page, open)).toEqual({ ok: false, reason: 'StaleContext' });
  // In the detail view rows do not act, as a pointer could not reach them.
  expect(await act(page, 'subagent-open', { index: 0 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The open child keeps streaming while captured actions come and go.
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'd', name: 'Fixer', status: 'running', parentId: 'b', response: 'Fixing the flaky test.' }));
  await expect(panel(page).locator('.subagent-response')).toContainText('Fixing the flaky test.');
  expect(await act(page, 'subagents-back')).toEqual({ ok: true }); await expect(panel(page).locator('.subagents-list')).toBeVisible();
  // A new child redraws the list: an older request is refused.
  const stale = await action(page, 'subagent-open', { child: 'a' });
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'e', name: 'Linter', status: 'running' }));
  await expect(row(page, 'e')).toHaveCount(1);
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'subagents-close')).toEqual({ ok: true }); await expect(panel(page)).toHaveCount(0);
  // The widget: its trigger opens it, a row opens that task only while it is open.
  expect(await act(page, 'widget-open')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'widget')).toEqual({ ok: true }); await expect(popover(page)).toBeVisible();
  expect((await props(page)).agents.map((agent: any) => agent.status)).toEqual(['running', 'waiting', 'waiting']);
  expect(await act(page, 'widget-open')).toEqual({ ok: true }); await expect(popover(page)).toBeHidden();
  // Switching task changes the captured task: another task's children are never in the snapshot.
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  await children(page, 'session-2');
  const elsewhere = await action(page, 'subagents');
  await page.locator('#navigation .task-item[data-id="session-1"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  for (const field of ['context', 'project', 'task', 'profile', 'control', 'resource']) expect(await act(page, 'subagents', {}, { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await noAuthority(page);
});

test('Agent roster extension: profile selection and Update need a fresh host choice; rename and delete stay in the host menu', async ({ page }) => {
  await setup(page, [manifest], { classic: true }); await select(page);
  await openSetup(page); await saveProfiles(page);
  let p = await props(page);
  expect(p.setup).toBe(true); expect(p.profile).not.toBe('');
  // Choices: the last saved setup is absent until a setup is saved; Alpha, Beta follow the picker's order.
  const selects = p.controls.filter((control: any) => control.controlId === 'profile-select');
  expect(selects.length).toBeGreaterThanOrEqual(2);
  const alpha = selects.length - 2;
  // Selecting Alpha shows a fresh host choice inside the setup; Escape declines it and nothing changes.
  expect(await act(page, 'profile-select', { index: alpha })).toEqual({ ok: true });
  const choice = page.getByRole('menuitemradio', { name: 'Continue: Apply team profile', exact: true });
  await expect(choice).toBeVisible(); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'profile-manage')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice).toHaveCount(0);
  await expect(library(page)).toBeVisible(); await expect(page.locator('#team-guidance')).toHaveValue('Beta guidance');
  expect(await act(page, 'profile-select', { index: alpha })).toEqual({ ok: true });
  await choice.click();
  await expect(page.locator('#team-guidance')).toHaveValue('Alpha guidance'); await expect(library(page).locator('.team-library-picker')).toHaveText('Alpha');
  // Another profile changes the captured profile: a request captured under Beta is refused.
  p = await props(page); expect(p.profile).not.toBe('');
  const update = await action(page, 'profile-update');
  await page.locator('#team-guidance').fill('Alpha guidance, revised');
  await expect(library(page).locator('.team-library-update')).toBeVisible();
  expect(await send(page, update)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'profile-update')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Update profile', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'architect_save_profile')).map((call: any) => [call.args.name, call.args.setup.config.leadGuidance])).toEqual([['Alpha', 'Alpha guidance'], ['Beta', 'Beta guidance'], ['Alpha', 'Alpha guidance, revised']]);
  await expect(library(page).locator('.team-library-state')).toHaveText('Saved');
  // Manage opens the host's own Profile actions menu; deleting stays the user's choice there.
  expect(await act(page, 'profile-manage')).toEqual({ ok: true });
  await expect(page.getByRole('menuitem', { name: 'Delete profile', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(library(page)).toBeVisible();
  expect(await act(page, 'profile-create')).toEqual({ ok: true }); await expect(library(page).getByLabel('Profile name', { exact: true })).toBeFocused();
  for (const controlId of ['profile-delete', 'profile-rename']) expect(await act(page, 'profile-picker', {}, { controlId })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await noAuthority(page);
});

test('Agent roster extension: control order, reversible hiding and pinned controls follow proposals on the original nodes', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, [manifest], { widget: true, classic: true }); await select(page); await children(page);
  await proposal(page, 'Close before Back'); await back(page);
  await openView(page); await row(page, 'b').click();
  expect(await heading(page)).toEqual(['close', 'back']);
  await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  let region = await hide(page, 'Pin widget');
  await expect(region.getByRole('button', { name: /^Hide Running agents/ })).toHaveCount(0);
  await expect(region.getByRole('button', { name: /^Hide Back to Subagents/ })).toHaveCount(0);
  await expect(region.getByRole('button', { name: /^Hide Choose team profile/ })).toHaveCount(0);
  await back(page);
  region = await hide(page, 'Manage team profile'); await back(page);
  await widget(page).click(); await expect(popover(page)).toBeVisible();
  await expect(page.locator('.agents-dock-pin')).toBeHidden(); await expect(widget(page)).toBeVisible();
  await prompt(page).click(); await expect(popover(page)).toBeHidden();
  // A forged overlay cannot hide a pinned control (a layout refresh redraws the composer, so the setup opens after it).
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.roster.controls/picker': false, 'panda.roster.controls/widget': false, 'panda.roster.controls/back': false, 'panda.roster.protected/stop': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(widget(page)).toBeVisible(); await expect(widget(page)).not.toHaveAttribute('data-layout-hidden');
  await openSetup(page);
  await expect(library(page).locator('.team-library-manage')).toBeHidden();
  await expect(library(page).locator('.team-library-picker')).toBeVisible(); await expect(library(page).locator('.team-library-picker')).not.toHaveAttribute('data-layout-hidden');
  expect(await act(page, 'profile-manage')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await openView(page); await expect(panel(page).locator('.subagents-close')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  await page.evaluate(() => (window as any).__previewRosterSafeMode());
  await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  if (!await library(page).count()) await openSetup(page);
  await expect(library(page).locator('.team-library-manage')).toBeVisible();
  expect(await act(page, 'profile-picker')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
  await noAuthority(page);
});

test('Agent roster extension: children, the open child, its stream, the widget preference and focus survive conflict, fault, disable and safe mode', async ({ page }) => {
  test.setTimeout(60_000);
  const other = structuredClone(manifest); other.id = 'other.agent-roster'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.agent-roster/running-first' }] };
  const future = structuredClone(other); future.id = 'future.agent-roster'; future.contributes.components[0].id = 'future.agent-roster/running-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future], { widget: true });
  let region = await explorer(page);
  await expect(region.getByLabel('Agent roster presentation')).toHaveValue(''); await expect(region.locator('option[value="future.agent-roster/running-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  await select(page, 'other.agent-roster/running-first');
  await children(page); await openView(page);
  // A package without tasks.summary sees no children; its presentation and actions are the same.
  expect(await props(page)).toMatchObject({ progress: false, running: 0, children: [], agents: [] });
  expect(await order(page)).toEqual(['b', 'd', 'a', 'c']);
  await row(page, 'd').click(); await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Fixer');
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'd', name: 'Fixer', status: 'running', parentId: 'b', response: 'Streaming a fix.' }));
  await expect(panel(page).locator('.subagent-response')).toContainText('Streaming a fix.');
  await panel(page).locator('.subagents-back').focus();
  await page.evaluate(() => { const w = window as any; w.__rosterNodes = { panel: document.querySelector('#subagents-panel'), detail: document.querySelector('#subagents-panel .subagent-detail'), prompt: document.querySelector('#prompt'), widget: document.querySelector('.agents-dock-trigger') }; });
  const preference = () => page.evaluate(() => localStorage.getItem('pandacode.preview.agents-dock'));
  const saved = await preference();
  const check = async (focused = true) => {
    expect(await page.evaluate(() => { const nodes = (window as any).__rosterNodes; return nodes.panel.isConnected && nodes.detail.isConnected && nodes.panel === document.querySelector('#subagents-panel') && nodes.prompt === document.querySelector('#prompt') && nodes.widget === document.querySelector('.agents-dock-trigger'); })).toBe(true);
    await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Fixer'); await expect(panel(page).locator('.subagent-response')).toContainText('Streaming a fix.');
    if (focused) await expect(panel(page).locator('.subagents-back')).toBeFocused();
    expect(await preference()).toBe(saved); await expect(widget(page)).toBeVisible();
    await noAuthority(page);
  };
  await check();
  expect(await act(page, 'subagents-back', {}, { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyRosterPresentation(document.querySelector('#subagents-host'), () => undefined, () => { throw Error('controlled fault'); }); });
  await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  expect(await act(page, 'subagents-back')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.agent-roster'));
  await check();
  region = await explorer(page); await region.getByLabel('Agent roster presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(host(page)).toHaveAttribute('data-roster-provider', PROVIDER);
  // Back to the list: built-in order returned while unselected, running-first again now.
  await panel(page).locator('.subagents-back').click(); await expect.poll(() => order(page)).toEqual(['b', 'd', 'a', 'c']);
  expect(await props(page)).toMatchObject({ progress: true, running: 2 });
  // Exactly once: one captured child opens it once.
  expect(await act(page, 'subagent-open', { child: 'd' })).toEqual({ ok: true }); await expect(panel(page).locator('.subagent-detail-name')).toHaveText('Fixer');
  await panel(page).locator('.subagents-back').focus();
  await page.evaluate(() => (window as any).__previewRosterSafeMode());
  await expect(host(page)).not.toHaveAttribute('data-roster-provider');
  await check(); expect((await props(page)).safeMode).toBe(true);
  await panel(page).locator('.subagents-back').click(); await expect.poll(() => order(page)).toEqual(['a', 'b', 'c', 'd']);
});
