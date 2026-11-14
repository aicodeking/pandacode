import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's synthetic `architect-event` team and the extensions baseline transport. No real
// harness or agent runs; installed-window qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/action-dock/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.action-dock/actions-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewDock());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const dock = (page: Page) => page.locator('#action-dock');
const prompt = (page: Page) => page.locator('#prompt');
const list = (page: Page) => page.locator('#transcript .team-progress');
const worker = (page: Page, id: string) => list(page).locator(`.team-progress-worker[data-worker-id="${id}"]`);
const groups = (page: Page) => dock(page).locator(':scope > .action-dock-group').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
const panels = (page: Page) => dock(page).locator('[data-group="panels"] > button').evaluateAll(nodes => nodes.map(node => node.id || (node as HTMLElement).dataset.action));
const toast = (page: Page) => page.locator('#toast');
async function setup(page: Page, packages: unknown[] = [], baseline: Record<string, unknown> = {}) {
  await page.addInitScript(({ packages, baseline }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], ...baseline };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, baseline });
  await page.goto('/?extensions-baseline&dock-coverage&replacement'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.controls.length ?? 0).toBeGreaterThan(0);
}
/** A synthetic two-worker team for the open task: one working, one waiting on the reader. */
async function showTeam(page: Page, workers: { id: string; status: string; abandoned?: boolean }[] = [{ id: 'worker-1', status: 'running' }, { id: 'worker-2', status: 'waiting' }], revision = 1) {
  await page.evaluate(({ workers, revision }) => {
    const time = Date.now(), profile = { id: 'builder', name: 'Builder', provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' };
    (window as any).__previewEmit('architect-event', {
      sessionId: 'session-1', status: 'running', round: 1, revision, updatedAt: time,
      config: { workers: [profile], maxParallel: 2, maxRounds: 4, maxAssignments: 8, workspace: 'shared', summaryLimit: 1800 },
      workers: workers.map((item, index) => ({ ...profile, id: item.id, name: `Builder ${index + 1}`, profileId: 'builder', sessionId: `${item.id}-session`, status: item.status, abandoned: item.abandoned, assignment: 'Synthetic verification', summary: '', dependsOn: [], files: [], attempt: 1, createdAt: time + index, updatedAt: time })),
    });
  }, { workers, revision });
  await expect(list(page)).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(dock(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Action dock presentation', { exact: true }).selectOption(id); await back(page); await expect(dock(page)).toHaveAttribute('data-dock-provider', id); }
/** Builds a captured action from the live presentation. Worker handles are opaque: the test maps them by the order
 * of the drawn worker rows, which is the order the presentation lists them. */
async function action(page: Page, controlId: string, target: { worker?: string } = {}, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, target, changes }) => {
    const p = (window as any).__previewDock();
    const candidates = p.controls.filter((control: any) => control.controlId === controlId);
    let control = candidates[0];
    if (target.worker) {
      const rows = [...document.querySelectorAll<HTMLElement>('#transcript .team-progress .team-progress-worker')].map(node => node.dataset.workerId);
      control = candidates[rows.indexOf(target.worker)];
    }
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, team: p.team, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, target, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewDockAction(input), input);
const act = async (page: Page, controlId: string, target: { worker?: string } = {}, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, target, changes));
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, location: string, label: string, open = true) {
  const region = open ? await explorer(page) : page.getByRole('region', { name: 'Surface explorer' });
  if (open) await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 4 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}

test('Action dock extension: zero extensions keep the dock, the Workers line, Agents and their original handlers', async ({ page }) => {
  await setup(page); await showTeam(page);
  expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-team-hidden'); await expect(page.locator('.workspace')).not.toHaveAttribute('data-team-order');
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, progress: false, status: 'none', running: 0, attention: 0, total: 0, workers: [] });
  expect(p.team).not.toBe(''); expect(p.groups.map((group: any) => group.id)).toEqual(['panels', 'actions', 'status']);
  expect(p.controls.filter((control: any) => control.controlId === 'worker-open')).toHaveLength(2);
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Revoked' }); await expect(list(page)).not.toHaveAttribute('data-open');
  // No context menu on the Workers head without a contribution there.
  await list(page).locator('.team-progress-toggle').focus(); await page.keyboard.press('Shift+F10'); await expect(page.locator('.floating-menu')).toHaveCount(0);
  // Original Workers fold and the attention count.
  await expect(list(page).locator('.team-progress-count')).toHaveText('1 needs attention');
  await list(page).locator('.team-progress-toggle').click(); await expect(list(page)).toHaveAttribute('data-open', '');
  await expect(worker(page, 'worker-2').locator('.team-progress-status')).toHaveText('Needs attention');
  // Keyboard roving through the dock still follows its drawn order.
  await page.locator('#inspector-toggle').focus(); await page.keyboard.press('ArrowDown'); await expect(page.locator('#terminal-toggle')).toBeFocused();
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'architect_control')).toEqual([]); expect(await calls(page, 'respond_approval')).toEqual([]);
});

test('Action dock extension: install/enable writes no preference; the selected recipe moves the actions group and adds dock, Agents, team and Workers menu actions', async ({ page }) => {
  await setup(page); await showTeam(page);
  const region = await explorer(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.action-dock', exact: true }).click();
  await expect(region.getByLabel('Action dock presentation')).toHaveValue(''); await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await region.getByLabel('Action dock presentation').selectOption(PROVIDER); await back(page);
  await expect(dock(page)).toHaveAttribute('data-dock-provider', PROVIDER);
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  // The original group nodes move: actions lead, status stays last, the items are the same.
  expect(await groups(page)).toEqual(['actions', 'panels', 'status']);
  expect(await panels(page)).toEqual(['inspector-toggle', 'terminal-toggle', 'browser-toggle', 'moodboards', 'agents-toggle']);
  const runTop = (await page.locator('#task-menu-trigger').boundingBox())!.y, inspectorTop = (await page.locator('#inspector-toggle').boundingBox())!.y;
  expect(runTop).toBeLessThan(inspectorTop);
  // Progress needs tasks.summary, which the package declares.
  expect(await props(page)).toMatchObject({ progress: true, status: 'running', running: 1, attention: 1, total: 2 });
  await dock(page).getByRole('button', { name: 'Dock notes', exact: true }).click(); await expect(toast(page)).toContainText('Dock ownership stays with PandaCode');
  await list(page).getByRole('button', { name: 'Team notes', exact: true }).click(); await expect(toast(page)).toContainText('Workers, approvals and Stop stay host-owned');
  await list(page).locator('.team-progress-toggle').focus(); await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('dialog', { name: 'Workers', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Open team', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Show workers', exact: true }).click(); await expect(list(page)).toHaveAttribute('data-open', '');
  await list(page).locator('.team-progress-toggle').click({ button: 'right' });
  menu = page.getByRole('dialog', { name: 'Workers', exact: true });
  await menu.getByRole('menuitem', { name: 'Team notes', exact: true }).click(); await expect(toast(page)).toContainText('Workers, approvals and Stop stay host-owned');
  // The Agents flyout accessory through the original Agents item.
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'child', name: 'Child', status: 'running' }));
  await page.locator('#agents-toggle').click(); await expect(page.locator('#agents-flyout')).toBeVisible();
  await page.locator('#agents-flyout').getByRole('button', { name: 'Team notes', exact: true }).click(); await expect(toast(page)).toContainText('Workers, approvals and Stop stay host-owned');
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
});

test('Action dock extension: captured actions run original handlers; stale, replayed, forged, foreign-worker, Stop and approval requests fail', async ({ page }) => {
  await setup(page, [manifest], { runScript: true }); await select(page); await showTeam(page);
  expect(await act(page, 'team-toggle', {}, { controlId: 'stop' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'team-toggle', {}, { controlId: 'approve' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'team-toggle', {}, { selector: '.team-progress' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'team-toggle', {}, { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // A worker row acts only while its list is open, as a pointer could.
  expect(await act(page, 'worker-open', { worker: 'worker-1' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const fold = await action(page, 'team-toggle');
  expect(await send(page, fold)).toEqual({ ok: true }); await expect(list(page)).toHaveAttribute('data-open', '');
  // The fold changed the captured state: the same request is refused, never replayed or retargeted.
  expect(await send(page, fold)).toEqual({ ok: false, reason: 'StaleContext' }); await expect(list(page)).toHaveAttribute('data-open', '');
  const second = await action(page, 'worker-open', { worker: 'worker-2' });
  // Another worker's resource (or control) is another target.
  expect(await send(page, { ...second, resource: (await action(page, 'worker-open', { worker: 'worker-1' })).resource })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, { ...second, requestId: crypto.randomUUID(), resource: 'worker-of-another-team' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, second)).toEqual({ ok: true });
  await expect(page.locator('#agents-flyout')).toBeVisible(); await expect(page.locator('#agents-flyout .architect-panel')).toBeVisible();
  // The open flyout changed the captured state: the same request is refused, not replayed.
  expect(await send(page, second)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.keyboard.press('Escape'); await expect(page.locator('#agents-flyout')).toBeHidden();
  // A new worker redraws the list: an older request is refused.
  const stale = await action(page, 'team-open');
  await showTeam(page, [{ id: 'worker-1', status: 'running' }, { id: 'worker-2', status: 'waiting' }, { id: 'worker-3', status: 'queued' }], 2);
  await expect(worker(page, 'worker-3')).toHaveCount(1);
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await props(page)).total).toBe(3);
  // Run needs a fresh host choice; Escape declines it and nothing starts.
  await expect(page.locator('#run-project-button')).toBeVisible();
  const runs = (await calls(page, 'get_run_script')).length;
  expect(await act(page, 'run')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(page.getByRole('menuitemradio', { name: 'Continue: Run project', exact: true })).toHaveCount(0);
  expect((await calls(page, 'get_run_script')).length).toBe(runs);
  expect(await act(page, 'run')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Run project', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'get_run_script')).length).toBe(runs + 1);
  // Pending approvals stay host-owned: no public control answers them; the reader's Allow does, once.
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'approval', text: 'Run fixture verification?', requestId: 'fixture-approval' }));
  await expect(page.locator('.approval-bar')).toBeVisible();
  for (const controlId of ['approve', 'deny', 'answer', 'stop-worker']) expect(await act(page, 'team-toggle', {}, { controlId })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await calls(page, 'respond_approval')).toEqual([]);
  await page.locator('.approval-bar .approval-allow').click(); await expect.poll(() => calls(page, 'respond_approval')).toHaveLength(1);
  // Switching task changes the captured task and team: the team's requests are refused there.
  const elsewhere = await action(page, 'team-toggle');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await props(page)).team).toBe(''); expect((await props(page)).controls.some((control: any) => control.controlId === 'team-toggle')).toBe(false);
  for (const field of ['context', 'project', 'task', 'team', 'control', 'resource']) expect(await act(page, 'inspector', {}, { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await calls(page, 'stop_session')).toEqual([]);
});

test('Action dock extension: item order, reversible hiding and the Workers line follow proposals on the original nodes', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await showTeam(page);
  await proposal(page, 'panda.actionDock.controls', 'Agents first'); await back(page);
  // The proposal's one rule (Agents before Toggle inspector) holds on the same original nodes.
  await expect.poll(() => panels(page)).toEqual(['terminal-toggle', 'browser-toggle', 'moodboards', 'agents-toggle', 'inspector-toggle']);
  await proposal(page, 'panda.team.controls', 'Open team before Workers'); await back(page);
  await expect(page.locator('.workspace')).toHaveAttribute('data-team-order', 'menu-first');
  await expect(list(page).locator('.team-progress-menu')).toHaveCSS('order', '-1');
  const region = await hide(page, 'panda.actionDock.controls', 'Toggle terminal');
  await expect(region.getByRole('button', { name: /^Hide Agents/ })).toHaveCount(0);
  await hide(page, 'panda.team.controls', 'Open team button');
  await expect(page.getByRole('region', { name: 'Surface explorer' }).getByRole('button', { name: /^Hide Workers toggle/ })).toHaveCount(0);
  await back(page);
  await expect(page.locator('#terminal-toggle')).toBeHidden(); await expect(page.locator('.workspace')).toHaveAttribute('data-team-hidden', 'menu');
  await expect(list(page).locator('.team-progress-menu')).toBeHidden(); await expect(list(page).locator('.team-progress-toggle')).toBeVisible();
  expect(await act(page, 'terminal')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // A hidden item keeps its keyboard path, and roving skips it.
  await page.locator('#task-menu-trigger').focus(); await page.keyboard.press('ArrowDown'); await expect(page.locator('#browser-toggle')).toBeFocused();
  await page.keyboard.press('ControlOrMeta+J'); await expect(page.locator('#terminal-drawer')).toBeVisible();
  // A forged overlay cannot hide Agents or the Workers toggle.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.actionDock.controls/agents': false, 'panda.team.controls/toggle': false, 'panda.actionDock.protected/stop': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'child', name: 'Child', status: 'running' }));
  await expect(page.locator('#agents-toggle')).toBeVisible(); await expect(page.locator('#agents-toggle')).not.toHaveAttribute('data-layout-hidden');
  await expect(list(page).locator('.team-progress-toggle')).toBeVisible();
  await page.evaluate(() => (window as any).__previewDockSafeMode());
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await expect.poll(() => groups(page)).toEqual(['panels', 'actions', 'status']);
  await expect.poll(() => panels(page)).toEqual(['inspector-toggle', 'terminal-toggle', 'browser-toggle', 'moodboards', 'agents-toggle']);
  await expect(page.locator('#terminal-toggle')).toBeVisible(); await expect(page.locator('.workspace')).not.toHaveAttribute('data-team-hidden');
  await expect(list(page).locator('.team-progress-menu')).toBeVisible();
  expect(await act(page, 'inspector')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
});

test('Action dock extension: a running team, its stream, workers, approvals and draft survive tool events, conflict, fault, disable and safe mode', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.action-dock'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.action-dock/actions-first' }] };
  const future = structuredClone(other); future.id = 'future.action-dock'; future.contributes.components[0].id = 'future.action-dock/actions-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future], { holdRun: true });
  let region = await explorer(page);
  await expect(region.getByLabel('Action dock presentation')).toHaveValue(''); await expect(region.locator('option[value="future.action-dock/actions-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await select(page, 'other.action-dock/actions-first');
  // A package without tasks.summary sees no progress; its presentation and actions are the same.
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await showTeam(page);
  expect(await props(page)).toMatchObject({ progress: false, status: 'none', workers: [] });
  // Concurrent tool events keep the live Workers line and its worker rows (the M8 PC-039 repair).
  await list(page).locator('.team-progress-toggle').click(); await expect(list(page)).toHaveAttribute('data-open', '');
  await page.evaluate(() => { const w = window as any; w.__dockNodes = { list: document.querySelector('#transcript .team-progress'), first: document.querySelector('.team-progress-worker[data-worker-id="worker-1"]'), prompt: document.querySelector('#prompt'), transcript: document.querySelector('#transcript'), agents: document.querySelector('#agents-toggle') }; });
  for (const text of ['Read README', 'Search sources', 'Run checks']) await page.evaluate(text => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'tool', text }), text);
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'A live synthetic reply.' }));
  await expect(page.locator('#stream-region')).toContainText('A live synthetic reply.');
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'approval', text: 'Run fixture verification?', requestId: 'fixture-approval' }));
  await expect(page.locator('.approval-bar')).toBeVisible();
  await prompt(page).fill('Keep this dock draft');
  const same = () => page.evaluate(() => { const w = window as any, nodes = w.__dockNodes; return nodes.list.isConnected && nodes.first.isConnected && nodes.list === document.querySelector('#transcript .team-progress') && nodes.prompt === document.querySelector('#prompt') && nodes.transcript === document.querySelector('#transcript') && nodes.agents === document.querySelector('#agents-toggle'); });
  const sends = (await calls(page, 'send_message')).length;
  const check = async () => {
    expect(await same()).toBe(true); await expect(prompt(page)).toHaveValue('Keep this dock draft');
    expect(await list(page).locator('.team-progress-worker').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.workerId))).toEqual(['worker-1', 'worker-2']);
    await expect(list(page)).toHaveAttribute('data-open', ''); await expect(list(page).locator('.team-progress-count')).toHaveText('1 needs attention');
    await expect(page.locator('#stream-region')).toContainText('A live synthetic reply.'); await expect(page.locator('.approval-bar')).toBeVisible();
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    expect((await calls(page, 'send_message')).length).toBe(sends); expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'architect_control')).toEqual([]); expect(await calls(page, 'respond_approval')).toEqual([]);
  };
  await check();
  expect(await act(page, 'team-toggle', {}, { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyDockPresentation(document.querySelector('#action-dock'), () => { throw Error('controlled fault'); }); });
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider'); expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.action-dock'));
  await check(); await expect(prompt(page)).toBeFocused();
  region = await explorer(page); await region.getByLabel('Action dock presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(dock(page)).toHaveAttribute('data-dock-provider', PROVIDER); expect(await groups(page)).toEqual(['actions', 'panels', 'status']);
  await check();
  expect(await props(page)).toMatchObject({ progress: true, attention: 1, total: 2 });
  // Exactly once: one captured Open team runs the original handler once.
  expect(await act(page, 'team-open')).toEqual({ ok: true }); await expect(page.locator('#agents-flyout .architect-panel')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#agents-flyout')).toBeHidden();
  await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewDockSafeMode());
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider'); expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  await check(); await expect(prompt(page)).toBeFocused();
  expect((await props(page)).safeMode).toBe(true);
  // The host still answers and stops: once each.
  await page.locator('.approval-bar .approval-allow').click(); await expect.poll(() => calls(page, 'respond_approval')).toHaveLength(1);
  // A running team stops through its own host control (the team and its workers), once.
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'architect_control')).map((call: any) => call.args)).toEqual([{ sessionId: 'session-1', action: 'stop' }]);
});
