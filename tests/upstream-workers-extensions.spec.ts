import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S0605 (upstream sync P6): the Workers panel and the Running agents dock after the 0.3.128 merge. An installed package
 * customizes them only through the existing public primitives (panda.actionDock, panda.team.*, panda.agentsDock.*), with
 * captured context and revision; worker state, approvals, Stop and the dock's failures stay host-owned. Browser fixtures
 * only: the preview's synthetic `architect-event` team and the extensions baseline transport. No real harness runs;
 * installed-window and native-authority qualification are separate evidence (docs/extensions/upstream-workers.md). */
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-workers/manifest.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.upstream-workers/actions-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewDock());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const dock = (page: Page) => page.locator('#action-dock');
const prompt = (page: Page) => page.locator('#prompt');
const list = (page: Page) => page.locator('#transcript .team-progress');
const worker = (page: Page, id: string) => list(page).locator(`.team-progress-worker[data-worker-id="${id}"]`);
const groups = (page: Page) => dock(page).locator(':scope > .action-dock-group').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.group));
const toast = (page: Page) => page.locator('#toast');
async function setup(page: Page, packages: unknown[] = [], baseline: Record<string, unknown> = {}) {
  await page.addInitScript(({ packages, baseline }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], ...baseline };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, baseline });
  await page.goto('/?extensions-baseline&upstream-workers&dock-coverage&replacement'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.controls.length ?? 0).toBeGreaterThan(0);
}
/** A synthetic team: one working, one waiting on the reader and (optionally) a reviewer seat. */
async function showTeam(page: Page, workers: { id: string; status: string; abandoned?: boolean }[] = [{ id: 'worker-1', status: 'running' }, { id: 'worker-2', status: 'waiting' }], revision = 1) {
  await page.evaluate(({ workers, revision }) => {
    const time = Date.now(), profile = { id: 'builder', name: 'Builder', provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'xhigh' };
    (window as any).__previewEmit('architect-event', {
      sessionId: 'session-1', status: 'running', round: 1, revision, updatedAt: time,
      config: { workers: [profile], maxParallel: 2, maxRounds: 4, maxAssignments: 8, workspace: 'shared', summaryLimit: 1800 },
      workers: workers.map((item, index) => ({ ...profile, id: item.id, name: `Builder ${index + 1}`, profileId: 'builder', sessionId: `${item.id}-session`, status: item.status, abandoned: item.abandoned, assignment: 'Synthetic verification', summary: '', dependsOn: [], files: [], attempt: 1, createdAt: time, updatedAt: time })),
    });
  }, { workers, revision });
  await expect(list(page)).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(dock(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Action dock presentation', { exact: true }).selectOption(id); await back(page); await expect(dock(page)).toHaveAttribute('data-dock-provider', id); }
async function action(page: Page, controlId: string, worker?: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, worker, changes }) => {
    const p = (window as any).__previewDock();
    const candidates = p.controls.filter((control: any) => control.controlId === controlId);
    let control = candidates[0];
    if (worker) {
      const rows = [...document.querySelectorAll<HTMLElement>('#transcript .team-progress .team-progress-worker')].map(node => node.dataset.workerId);
      control = candidates[rows.indexOf(worker)];
    }
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, team: p.team, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, worker, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewDockAction(input), input);
const act = async (page: Page, controlId: string, worker?: string, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, worker, changes));

test('Upstream workers: zero extensions keep the Workers line, its statuses, the dock and the original handlers', async ({ page }) => {
  await setup(page); await showTeam(page);
  expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await expect(list(page).locator('.team-progress-count')).toHaveText('1 needs attention');
  await list(page).locator('.team-progress-toggle').click(); await expect(list(page)).toHaveAttribute('data-open', '');
  await expect(worker(page, 'worker-2').locator('.team-progress-status')).toHaveText('Needs attention');
  await expect(worker(page, 'worker-1').locator('.team-progress-status')).toHaveText('Working');
  expect(await props(page)).toMatchObject({ visible: true, progress: false, status: 'none', workers: [] });
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await worker(page, 'worker-2').click(); await expect(page.locator('#agents-flyout .architect-panel')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#agents-flyout')).toBeHidden();
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'architect_control')).toEqual([]); expect(await calls(page, 'respond_approval')).toEqual([]);
});

test('Upstream workers: install and enable through the extensions page grants nothing until the recipe is selected; the package then customizes the panel and the dock', async ({ page }) => {
  await setup(page); await showTeam(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.upstream-workers', exact: true }).click();
  await expect(region.getByLabel('Action dock presentation')).toHaveValue(''); await expect(dock(page)).not.toHaveAttribute('data-dock-provider');
  await region.getByLabel('Action dock presentation').selectOption(PROVIDER); await back(page);
  await expect(dock(page)).toHaveAttribute('data-dock-provider', PROVIDER);
  expect(await groups(page)).toEqual(['actions', 'panels', 'status']);
  // tasks.summary is declared: the captured progress counts the workers, never their names or assignments.
  expect(await props(page)).toMatchObject({ progress: true, status: 'running', running: 1, attention: 1, total: 2 });
  expect((await props(page)).workers.map((item: any) => Object.keys(item).sort())).toEqual([['attention', 'id', 'status'], ['attention', 'id', 'status']]);
  await list(page).getByRole('button', { name: 'Workers note', exact: true }).click(); await expect(toast(page)).toContainText('Workers, approvals, effort and Stop stay with PandaCode.');
  // The Workers head context menu (keyboard) offers the contributed item beside the original ones.
  await list(page).locator('.team-progress-toggle').focus(); await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('dialog', { name: 'Workers', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Open team', exact: true })).toBeVisible();
  await expect(menu.getByRole('menuitem', { name: 'Workers note', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(list(page).locator('.team-progress-toggle')).toBeFocused();
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
});

test('Upstream workers: a captured action carries context and revision; a stale, replayed, forged or foreign request is refused', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await showTeam(page);
  await list(page).locator('.team-progress-toggle').click();
  const open = await action(page, 'worker-open', 'worker-2');
  expect(await send(page, { ...open, requestId: crypto.randomUUID(), revision: open.revision + 1 })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, { ...open, requestId: crypto.randomUUID(), resource: (await action(page, 'worker-open', 'worker-1')).resource })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, { ...open, requestId: crypto.randomUUID(), resource: 'worker-of-another-team' })).toEqual({ ok: false, reason: 'StaleContext' });
  for (const controlId of ['stop-worker', 'approve', 'deny', 'answer', 'effort']) expect(await act(page, 'team-toggle', undefined, { controlId })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await send(page, open)).toEqual({ ok: true }); await expect(page.locator('#agents-flyout .architect-panel')).toBeVisible();
  expect(await send(page, open)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.keyboard.press('Escape');
  // A new worker redraws the list: an older request is refused and the draw keeps its order.
  const older = await action(page, 'team-open');
  await showTeam(page, [{ id: 'worker-1', status: 'running' }, { id: 'worker-2', status: 'waiting' }, { id: 'worker-3', status: 'queued' }], 2);
  await expect(worker(page, 'worker-3')).toHaveCount(1);
  expect(await send(page, older)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await props(page)).total).toBe(3);
  expect(await calls(page, 'stop_session')).toEqual([]);
});

test('Upstream workers: hide, reorder and restore on the original nodes; the keyboard path and focus survive', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await showTeam(page);
  let region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.team.controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Open team before Workers', exact: true }).click(); await back(page);
  await expect(page.locator('.workspace')).toHaveAttribute('data-team-order', 'menu-first');
  await expect(list(page).locator('.team-progress-menu')).toHaveCSS('order', '-1');
  region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.team.controls');
  const hide = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Open team button', exact: true });
  await hide.click(); await back(page);
  await expect(page.locator('.workspace')).toHaveAttribute('data-team-hidden', 'menu');
  await expect(list(page).locator('.team-progress-menu')).toBeHidden(); await expect(list(page).locator('.team-progress-toggle')).toBeVisible();
  // The Workers toggle stays reachable and unhidable; Open team keeps its context-menu path.
  await list(page).locator('.team-progress-toggle').focus(); await page.keyboard.press('Enter'); await expect(list(page)).toHaveAttribute('data-open', '');
  await expect(list(page).locator('.team-progress-toggle')).toBeFocused();
  region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.team.controls');
  await region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Show Open team button', exact: true }).click(); await back(page);
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-team-hidden'); await expect(list(page).locator('.team-progress-menu')).toBeVisible();
  expect(await calls(page, 'stop_session')).toEqual([]);
});

test('Upstream workers: grant revoke, fault fallback, disable and safe mode return the original Workers line and dock', async ({ page }) => {
  // A package without tasks.summary has the same presentation and actions but sees no progress, count or worker.
  const other = structuredClone(manifest); other.id = 'other.upstream-workers'; other.permissions = ['ui.contribute'];
  other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.upstream-workers/actions-first' }] };
  await setup(page, [manifest, other]); await select(page, 'other.upstream-workers/actions-first'); await showTeam(page);
  await prompt(page).fill('Keep this draft');
  expect(await props(page)).toMatchObject({ progress: false, status: 'none', workers: [] });
  await select(page);
  expect(await props(page)).toMatchObject({ progress: true });
  // A throwing presentation falls back to the original dock and drops the captured actions.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyDockPresentation(document.querySelector('#action-dock'), () => { throw Error('controlled fault'); }); });
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider'); expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(prompt(page)).toHaveValue('Keep this draft');
  await expect(list(page).locator('.team-progress-count')).toHaveText('1 needs attention');
  // Disable and safe mode clean up.
  await select(page);
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.upstream-workers'));
  await expect(dock(page)).not.toHaveAttribute('data-dock-provider'); await expect(list(page).getByRole('button', { name: 'Workers note', exact: true })).toHaveCount(0);
  expect(await act(page, 'team-toggle')).toEqual({ ok: false, reason: 'Revoked' });
  await page.evaluate(() => (window as any).__previewDockSafeMode());
  expect((await props(page)).safeMode).toBe(true); expect(await groups(page)).toEqual(['panels', 'actions', 'status']);
  await expect(prompt(page)).toHaveValue('Keep this draft');
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'architect_control')).toEqual([]);
});

test('Upstream workers: the adapter core projects bounded rows with upstream effort and status words and refuses a stale error dismissal', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async () => {
    const core = await import('/src/extensions/upstream-workers.ts');
    const rows = core.projectWorkers([
      { id: 'a', status: 'running', reasoningEffort: 'xhigh' }, { id: 'b', status: 'waiting' }, { id: 'c', status: 'queued', abandoned: true }, { id: 'd', status: 'parked' },
    ], false, id => id === 'a');
    const many = core.projectWorkers(Array.from({ length: 80 }, (_, index) => ({ id: `w${index}`, status: 'running' as const })), true);
    const state = core.createDockErrorState();
    const first = state.show('Error: The widget window is busy')!;
    const same = state.show('The widget window is busy');
    const outcomes: unknown[] = [];
    outcomes.push(state.dismiss({ key: first.key, revision: first.revision + 1, requestId: 'r1' }, () => undefined));
    outcomes.push(state.dismiss({ key: 'other', revision: first.revision, requestId: 'r2' }, () => undefined));
    outcomes.push(state.dismiss('forged', () => undefined));
    let cleared = 0;
    outcomes.push(state.dismiss({ key: first.key, revision: first.revision, requestId: 'r3' }, () => { cleared += 1; state.show(''); }));
    outcomes.push(state.dismiss({ key: first.key, revision: first.revision, requestId: 'r3' }, () => { cleared += 1; }));
    return { rows, truncated: many.truncated, count: many.rows.length, same, first, outcomes, cleared, registry: core.WORKERS_REGISTRY.map(entry => [entry.member, entry.disposition, Boolean(entry.reason), Boolean(entry.handoff)]) };
  });
  expect(result.rows.rows).toEqual([
    { id: 'a', status: 'paused', attention: true, effort: 'x-high' }, { id: 'b', status: 'paused', attention: true, effort: '' },
    { id: 'c', status: 'skipped', attention: false, effort: '' }, { id: 'd', status: 'paused', attention: false, effort: '' },
  ]);
  expect(result.count).toBe(64); expect(result.truncated).toBe(true);
  expect(result.same).toEqual(result.first);
  expect(result.outcomes).toEqual([{ ok: false, reason: 'StaleContext' }, { ok: false, reason: 'StaleContext' }, { ok: false, reason: 'InvalidArguments' }, { ok: true }, { ok: false, reason: 'AlreadyApplied' }]);
  expect(result.cleared).toBe(1);
  // Every protected member says why; the ones that need a new runtime ability name their handoff.
  for (const [, disposition, reason] of result.registry) if (disposition === 'protected') expect(reason).toBe(true);
  expect(result.registry.filter(entry => entry[3]).map(entry => entry[0])).toEqual(['worker-effort', 'worker-reviewer']);
});

test('Upstream workers: the Running agents window shows a failure once, captures it and dismisses it with focus kept', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /if \(command === ["']agents_dock_unpin["']\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, match => `${match} if (window.__dockFail) throw new Error('The widget window is busy');`) });
  });
  await page.goto('/agents-dock.html');
  const row = page.locator('.agents-dock-window-error-row'), live = page.getByRole('alert', { includeHidden: true });
  await expect(row).not.toHaveAttribute('data-error-key');
  await page.locator('.agents-dock-orb').click();
  await page.evaluate(() => { (window as any).__dockFail = true; });
  await page.getByRole('button', { name: 'Unpin widget' }).click();
  await expect(live).toHaveText('The widget window is busy');
  await expect(row).toHaveAttribute('data-error-key', 'The widget window is busy');
  const revision = await row.getAttribute('data-error-revision');
  // The same failure again is the same capture; the live region is not rewritten.
  await page.getByRole('button', { name: 'Unpin widget' }).click();
  await expect(row).toHaveAttribute('data-error-revision', revision!);
  await row.getByRole('button', { name: 'Dismiss error' }).focus(); await page.keyboard.press('Enter');
  await expect(live).toBeEmpty(); await expect(row).not.toHaveAttribute('data-error-key');
  expect(await page.evaluate(() => document.activeElement?.closest('button,[data-agent-id]') !== null)).toBe(true);
});
