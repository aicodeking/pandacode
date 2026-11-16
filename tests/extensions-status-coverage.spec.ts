import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's sample usage and ledger, its six-iteration `?progress` thread and synthetic
// `jev-run` events, with the extensions baseline transport. No provider is read, no browser test or update runs;
// installed-window qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/status/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.status-feedback/details-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewStatus());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const group = (page: Page) => page.locator('#action-dock > [data-group="status"]');
const usage = (page: Page) => page.getByRole('dialog', { name: 'Agent usage', exact: true });
const pip = (page: Page) => page.locator('#progress-pip');
const toast = (page: Page) => page.locator('#toast');
const jev = (page: Page) => page.locator('.jev-activity');
const sections = (page: Page) => usage(page).locator('.usage-overview > *').evaluateAll(nodes => nodes.map(node => node.className.split(' ').find(name => ['usage-heroes', 'usage-range-row', 'usage-agents', 'usage-cost-details'].includes(name))));
const NOT_CALLED = ['restart_to_update', 'install_update', 'progress_clear', 'open_url', 'account_sign_in_start', 'jev_watch_run'];
/** Every request leaving the preview server: none may be added by this family. */
const external = new WeakMap<Page, string[]>();
async function setup(page: Page, packages: unknown[] = []) {
  const requests: string[] = []; external.set(page, requests);
  page.on('request', request => { const url = new URL(request.url()); if (!['127.0.0.1', 'localhost'].includes(url.hostname) && url.protocol.startsWith('http')) requests.push(request.url()); });
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!sessionStorage.getItem('status-seeded')) { localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: true, corner: 'tl' })); sessionStorage.setItem('status-seeded', '1'); }
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
    // Live listeners on window/document and live intervals, to prove no monotonic growth.
    const live = new Map<string, Set<unknown>>(), intervals = new Set<number>();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const key = (target: unknown, type: string) => target === window ? `window:${type}` : target === document ? `document:${type}` : '';
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) { const k = key(this, type); if (k && listener) { if (!live.has(k)) live.set(k, new Set()); live.get(k)!.add(listener); } return add.call(this, type, listener, options); };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: any, options?: any) { const k = key(this, type); if (k) live.get(k)?.delete(listener); return remove.call(this, type, listener, options); };
    const setInterval = window.setInterval.bind(window), clearInterval = window.clearInterval.bind(window);
    (window as any).setInterval = (...args: any[]) => { const id = (setInterval as any)(...args); intervals.add(id); return id; };
    (window as any).clearInterval = (id: number) => { intervals.delete(id); clearInterval(id); };
    (window as any).__statusLive = () => ({ listeners: [...live.values()].reduce((sum, set) => sum + set.size, 0), status: live.get('window:pandacode:status')?.size ?? 0, intervals: intervals.size, byKey: Object.fromEntries([...live].map(([k, v]) => [k, v.size])) });
  }, { packages });
  await page.goto('/?extensions-baseline&status-coverage&replacement&progress'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.controls.length ?? 0).toBeGreaterThan(0);
  await expect(pip(page).locator('.pp-pill')).toBeVisible();
}
async function openUsage(page: Page) {
  await page.locator('#agent-usage-button').click(); await expect(usage(page)).toBeVisible();
  await expect.poll(async () => (await props(page)).loading).toBe(false);
  await expect(usage(page).locator('.usage-cost-details [data-breakdown]').first()).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Status and usage presentation', { exact: true }).selectOption(id); await back(page); await expect(group(page)).toHaveAttribute('data-status-provider', id); }
/** The DOM nodes each resource control enumerates, in the order the presentation lists them. */
const NODE_KEYS: Record<string, [string, string]> = {
  'usage-tab': ['#dialog .usage-toolbar [role="tab"][data-tab]', 'tab'], 'usage-details': ['#dialog .usage-agents .usage-agent-row[data-provider]', 'provider'],
  'usage-range': ['#dialog .usage-range [data-range]', 'range'], 'usage-breakdown': ['#dialog .usage-cost-details [data-breakdown]', 'breakdown'],
  'progress-thumb': ['#progress-pip .pp-card:not(.is-overlay) .pp-strip .pp-thumb', 'index'],
};
/** Builds a captured action from the live presentation; resources are opaque, so the test maps them by DOM order. */
async function action(page: Page, controlId: string, key = '', changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, key, changes, keys }) => {
    const p = (window as any).__previewStatus();
    const candidates = p.controls.filter((control: any) => control.controlId === controlId);
    let control = candidates[0];
    if (key) { const [selector, attr] = keys[controlId]; control = candidates[[...document.querySelectorAll<HTMLElement>(selector)].map(node => node.dataset[attr]).indexOf(key)]; }
    if (!control) throw Error(`Missing ${controlId} ${key}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, provider: p.provider, range: p.range, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, key, changes, keys: NODE_KEYS });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewStatusAction(input), input);
const act = async (page: Page, controlId: string, key = '', changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, key, changes));
async function locationRegion(page: Page) { const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.status.controls'); return region; }
async function hide(page: Page, label: string) {
  const region = await locationRegion(page);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 4 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}
const refreshes = async (page: Page) => (await calls(page, 'agent_usage')).filter((call: any) => call.args.refresh === true).length;
const noAuthority = async (page: Page) => { for (const command of NOT_CALLED) expect(await calls(page, command), command).toEqual([]); expect(external.get(page)).toEqual([]); };
const jevRun = (page: Page, status: string, verification: string | null = null, createdAt = Date.now()) => page.evaluate(({ status, verification, createdAt }) => (window as any).__previewEmit('jev-run', { id: `run-${createdAt}`, sessionId: 'session-1', createdAt, status, verification }), { status, verification, createdAt });

test('Status extension: zero extensions keep usage, the status group, notices, visual progress and the Jev entry with their original handlers', async ({ page }) => {
  await setup(page);
  await expect(group(page)).not.toHaveAttribute('data-status-provider');
  let p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, usage: false, tab: 'closed', update: false, toast: 'hidden', pip: 'collapsed', inventory: false, providers: [], progress: false, iterations: 0, jevStatus: 'none' });
  expect(await act(page, 'usage-open')).toEqual({ ok: false, reason: 'Revoked' }); await expect(usage(page)).toHaveCount(0);
  const opened = (await calls(page, 'agent_usage')).length;
  await openUsage(page);
  const reads = (await calls(page, 'agent_usage')).length - opened;
  expect(reads).toBeGreaterThan(0); expect(await refreshes(page)).toBe(0);
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-agents', 'usage-cost-details']);
  p = await props(page); expect(p).toMatchObject({ usage: true, tab: 'overview', range: 'month', breakdown: 'model', provider: '' });
  // No context menu on an agent row without a contribution there; the original row opens its harness.
  await usage(page).locator('.usage-agent-row[data-provider="claude"]').click({ button: 'right' }); await expect(page.getByRole('dialog', { name: 'Harness usage', exact: true })).toHaveCount(0);
  await usage(page).locator('.usage-agent-row[data-provider="claude"]').click(); await expect(usage(page).getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect((await props(page)).tab).toBe('provider');
  await page.keyboard.press('Escape'); await expect(usage(page)).toHaveCount(0);
  // The original pill, Jev entry and status group.
  await pip(page).locator('.pp-pill').click(); await expect(pip(page).locator('.pp-card')).toBeVisible();
  await jevRun(page, 'running'); await expect(jev(page)).toContainText('Testing app…');
  await expect(group(page).locator('#update-status')).toBeHidden();
  await noAuthority(page);
});

test('Status extension: install/enable writes no preference; details-first moves the original sections and the row menu runs core and contributed actions', async ({ page }) => {
  await setup(page);
  const region = await explorer(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.status-feedback', exact: true }).click();
  await expect(region.getByLabel('Status and usage presentation')).toHaveValue(''); await expect(group(page)).not.toHaveAttribute('data-status-provider');
  await region.getByLabel('Status and usage presentation').selectOption(PROVIDER); await back(page);
  await expect(group(page)).toHaveAttribute('data-status-provider', PROVIDER);
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  // The shared status group slot still takes its contribution after the protected prompt.
  const item = group(page).locator('[data-extension-contribution="sample.status-feedback/status-item"]');
  await expect(item).toBeVisible(); expect(await group(page).evaluate(node => node.firstElementChild?.id)).toBe('update-status');
  await item.click(); await expect(toast(page)).toContainText('The update prompt and Undo stay host-owned.');
  await openUsage(page);
  const nodes = await page.evaluate(() => { const w = window as any; w.__usageNodes = [...document.querySelectorAll('#dialog .usage-overview > *')]; return w.__usageNodes.length; });
  expect(nodes).toBe(4);
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-cost-details', 'usage-agents']);
  expect(await page.evaluate(() => [...document.querySelectorAll('#dialog .usage-overview > *')].every(node => (window as any).__usageNodes.includes(node)))).toBe(true);
  // Harness reads need harnesses.inventory and task feedback tasks.summary, which the package declares: no account data.
  const p = await props(page);
  expect(p).toMatchObject({ inventory: true, progress: true, iterations: 6, iteration: 6 });
  expect(p.providers.find((row: any) => row.provider === 'claude')).toMatchObject({ status: 'ready', stale: false });
  expect(p.providers.every((row: any) => Number.isInteger(row.peak) && row.peak >= -1 && row.peak <= 100)).toBe(true);
  expect(JSON.stringify(p)).not.toMatch(/@example\.com|Max|Pro\b|Balance|LiteLLM|https?:/);
  // The row menu: keyboard opens it on the harness, the core row opens it, the contributed one runs once.
  await usage(page).locator('.usage-agent-row[data-provider="codex"]').focus(); await page.keyboard.press('Shift+F10');
  let menu = page.getByRole('dialog', { name: 'Harness usage', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Usage notes', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Show details', exact: true }).click();
  await expect(usage(page).getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await usage(page).getByRole('tab', { name: 'Overview', exact: true }).click();
  await usage(page).locator('.usage-agent-row[data-provider="claude"]').click({ button: 'right' });
  menu = page.getByRole('dialog', { name: 'Harness usage', exact: true });
  await menu.getByRole('menuitem', { name: 'Usage notes', exact: true }).click(); await expect(toast(page)).toContainText('Usage reads, account details and Refresh stay host-owned.');
  await expect(usage(page)).toBeVisible();
  expect(await refreshes(page)).toBe(0);
  await noAuthority(page);
});

test('Status extension: captured usage actions run original handlers; Refresh needs Continue; stale, replayed, forged and protected requests fail', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'usage-open', '', { controlId: 'update-restart' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'usage-open', '', { selector: '#agent-usage-button' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'usage-open', '', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const open = await action(page, 'usage-open');
  expect(await send(page, open)).toEqual({ ok: true }); await expect(usage(page)).toBeVisible();
  expect(await send(page, open)).toEqual({ ok: false, reason: 'StaleContext' });
  await expect.poll(async () => (await props(page)).loading).toBe(false);
  await expect(usage(page).locator('.usage-cost-details [data-breakdown]').first()).toBeVisible();
  const reads = (await calls(page, 'agent_usage')).length;
  expect(await act(page, 'usage-open')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // A period: the original segmented control redraws the overview; an older request is another target.
  const week = await action(page, 'usage-range', 'week');
  expect(await send(page, { ...week, resource: (await action(page, 'usage-range', 'year')).resource })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, week)).toEqual({ ok: true });
  await expect(usage(page).locator('.usage-range [data-range="week"]')).toHaveAttribute('aria-pressed', 'true'); expect((await props(page)).range).toBe('week');
  expect(await send(page, { ...week, requestId: crypto.randomUUID() })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'usage-breakdown', 'day')).toEqual({ ok: true });
  await expect(usage(page).locator('.usage-cost-details [data-breakdown="day"]')).toHaveAttribute('aria-pressed', 'true'); expect((await props(page)).breakdown).toBe('day');
  expect(await act(page, 'usage-details', 'codex')).toEqual({ ok: true });
  await expect(usage(page).getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  let p = await props(page); expect(p.tab).toBe('provider'); expect(p.provider).not.toBe('');
  // On a harness's card the overview's rows, period and breakdown do not act, as a pointer could not reach them.
  expect(await act(page, 'usage-range', 'month')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'usage-tab', 'overview')).toEqual({ ok: true }); expect((await props(page)).tab).toBe('overview');
  // The period, breakdown and cached reads survived the tab switch; none of these actions read a provider.
  await expect(usage(page).locator('.usage-range [data-range="week"]')).toHaveAttribute('aria-pressed', 'true');
  expect((await calls(page, 'agent_usage')).length).toBe(reads); expect(await refreshes(page)).toBe(0);
  for (const field of ['context', 'project', 'task', 'provider', 'control', 'resource']) expect(await act(page, 'usage-tab', 'claude', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'usage-tab', 'claude', { range: 'year' })).toEqual({ ok: false, reason: 'StaleContext' });
  for (const controlId of ['toast-undo', 'toast-action', 'progress-clear', 'usage-sign-in', 'usage-dashboard', 'usage-poll']) expect(await act(page, 'usage-refresh', '', { controlId })).toEqual({ ok: false, reason: 'InvalidArguments' });
  // Refresh: a fresh host choice inside the panel; Escape declines it and nothing is read.
  expect(await act(page, 'usage-refresh')).toEqual({ ok: true });
  const choice = page.getByRole('menuitemradio', { name: 'Continue: Refresh usage', exact: true });
  await expect(choice).toBeVisible(); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'usage-tab', 'claude')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice).toHaveCount(0); await expect(usage(page)).toBeVisible();
  expect(await refreshes(page)).toBe(0);
  expect(await act(page, 'usage-refresh')).toEqual({ ok: true }); await choice.click();
  await expect.poll(() => refreshes(page)).toBeGreaterThan(0);
  await expect.poll(async () => (await props(page)).loading).toBe(false);
  // The native per-provider limit still applies: the panel reads only installed harnesses once per Refresh.
  const once = await refreshes(page);
  p = await props(page); expect(p.range).toBe('week'); expect(p.breakdown).toBe('day');
  expect(await refreshes(page)).toBe(once);
  await noAuthority(page);
});

test('Status extension: visual progress, the Jev entry and notices act through original handlers; live progress, expiry and task switch refuse older requests', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  expect(await act(page, 'progress-expand')).toEqual({ ok: true }); await expect(pip(page).locator('.pp-card')).toBeVisible();
  await expect.poll(async () => (await props(page)).pip).toBe('expanded');
  // Controls act once the card has settled, as a pointer could not reach them mid-morph.
  await expect.poll(async () => (await props(page)).controls.find((control: any) => control.controlId === 'progress-thumb')?.enabled).toBe(true);
  expect(await act(page, 'progress-thumb', '0')).toEqual({ ok: true });
  await expect(pip(page).locator('.pp-meta')).toContainText('Iteration 1 of 6'); expect((await props(page)).iteration).toBe(1);
  expect(await act(page, 'progress-next')).toEqual({ ok: true }); await expect(pip(page).locator('.pp-meta')).toContainText('Iteration 2 of 6');
  expect(await act(page, 'progress-marks')).toEqual({ ok: true }); await expect(pip(page).locator('[data-pp="marks"]')).toHaveAttribute('aria-pressed', 'false');
  expect(await act(page, 'progress-compare')).toEqual({ ok: true }); await expect(pip(page).locator('[data-pp="compare"]')).toHaveAttribute('aria-pressed', 'true');
  // Live progress: a new iteration arrives; the viewed one stays and an older request is refused.
  const stale = await action(page, 'progress-prev');
  await page.evaluate(() => (window as any).__previewProgressAdd('Live polish'));
  await expect(pip(page).locator('.pp-meta')).toContainText('Iteration 2 of 7');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await props(page)).iterations).toBe(7);
  // The large view is a dialog: while it shows, the card does not act.
  expect(await act(page, 'progress-enlarge')).toEqual({ ok: true });
  await expect(page.locator('dialog.pp-lightbox')).toBeVisible();
  expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'progress-next')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect.poll(async () => (await props(page)).busy).toBe(false);
  // Clear history is protected: its own confirmation is the only path, and a forged request is invalid.
  expect(await act(page, 'progress-prev', '', { controlId: 'progress-clear' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await pip(page).locator('[data-pp="clear"]').click(); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'progress-prev')).toEqual({ ok: false, reason: 'Busy' });
  await pip(page).locator('[data-pp="clear-no"]').click(); expect((await props(page)).busy).toBe(false);
  expect(await act(page, 'progress-collapse')).toEqual({ ok: true }); await expect(pip(page).locator('.pp-pill')).toBeVisible();
  // The Jev entry: its status is permissioned and its original button opens the task's reports.
  await jevRun(page, 'done', 'passed'); await expect(jev(page)).toContainText('Checks passed');
  expect((await props(page)).jevStatus).toBe('passed');
  expect(await act(page, 'jev-open')).toEqual({ ok: true }); await expect(page.getByRole('dialog', { name: 'Browser tests', exact: true })).toBeVisible();
  expect((await props(page)).busy).toBe(true); expect(await act(page, 'usage-open')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Browser tests', exact: true })).toHaveCount(0);
  // Notices: Undo is protected and still works; an expired notice changes the captured state.
  const navigation = page.locator('#navigation .task-item[data-id="session-2"]');
  await navigation.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await navigation.click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Unpin task', exact: true }).click();
  await expect(toast(page).locator('.toast-undo')).toBeVisible(); expect((await props(page)).toast).toBe('undo');
  expect(await act(page, 'usage-open', '', { controlId: 'toast-undo' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await toast(page).locator('.toast-undo').click();
  await navigation.click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Unpin task', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.locator('[data-extension-contribution="sample.status-feedback/status-item"]').click(); await expect(toast(page)).toBeVisible();
  expect((await props(page)).toast).toBe('notice');
  const beforeExpiry = await action(page, 'usage-open');
  await expect(toast(page)).toBeHidden({ timeout: 10_000 }); expect((await props(page)).toast).toBe('hidden');
  expect(await send(page, beforeExpiry)).toEqual({ ok: false, reason: 'StaleContext' });
  // Switching task changes the captured task: the other task's progress and Jev status are never in the snapshot.
  const elsewhere = await action(page, 'progress-expand');
  await navigation.click(); await expect(navigation).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => (await props(page)).pip).toBe('hidden');
  expect(await props(page)).toMatchObject({ iterations: 0, jevStatus: 'none', jev: false });
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect.poll(async () => (await props(page)).iterations).toBe(7);
  await noAuthority(page);
});

test('Status extension: control order, reversible hiding and pinned controls follow proposals on the original nodes', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  let region = await locationRegion(page);
  await region.getByRole('button', { name: 'Grant UI customization and select Refresh before usage views', exact: true }).click(); await back(page);
  await openUsage(page);
  expect(await usage(page).locator('.usage-toolbar > *').evaluateAll(nodes => nodes.map(node => node.className))).toEqual(['icon-button usage-refresh', 'usage-tabs']);
  await page.keyboard.press('Escape');
  region = await locationRegion(page);
  await region.getByRole('button', { name: 'Grant UI customization and select Large view before Previous', exact: true }).click(); await back(page);
  await pip(page).locator('.pp-pill').click(); await expect(pip(page).locator('.pp-card')).toBeVisible();
  expect(await pip(page).locator('.pp-bar > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.pp))).toEqual(['play', 'next', 'marks', 'compare', 'enlarge', 'prev', 'clear']);
  region = await hide(page, 'Show annotations');
  await expect(region.getByRole('button', { name: /^Hide Usage views/ })).toHaveCount(0);
  await back(page);
  await expect(pip(page).locator('[data-pp="marks"]')).toBeHidden();
  expect(await act(page, 'progress-marks')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await hide(page, 'Refresh usage'); await back(page);
  await openUsage(page);
  await expect(usage(page).locator('.usage-refresh')).toBeHidden();
  expect(await act(page, 'usage-refresh')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // A forged overlay cannot hide a pinned control or a protected item.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.status.controls/tabs': false, 'panda.status.protected/update': false, 'panda.status.protected/toast-undo': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(usage(page).locator('.usage-tabs')).toBeVisible(); await expect(usage(page).locator('.usage-tabs')).not.toHaveAttribute('data-layout-hidden');
  expect(await act(page, 'usage-tab', 'claude')).toEqual({ ok: true });
  await page.evaluate(() => (window as any).__previewStatusSafeMode());
  await expect(group(page)).not.toHaveAttribute('data-status-provider');
  await expect(usage(page).locator('.usage-refresh')).toBeVisible();
  expect(await usage(page).locator('.usage-toolbar > *').evaluateAll(nodes => nodes.map(node => node.className))).toEqual(['usage-tabs', 'icon-button usage-refresh']);
  expect(await act(page, 'usage-tab', 'overview')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
  await noAuthority(page);
});

test('Status extension: cached usage, period, tab, progress, notices and focus survive conflict, fault, disable and safe mode with no listener or timer growth', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.status-feedback'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.status-feedback/details-first' }] };
  const future = structuredClone(other); future.id = 'future.status-feedback'; future.contributes.components[0].id = 'future.status-feedback/details-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  let region = await explorer(page);
  await expect(region.getByLabel('Status and usage presentation')).toHaveValue(''); await expect(region.locator('option[value="future.status-feedback/details-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(group(page)).not.toHaveAttribute('data-status-provider');
  await select(page, 'other.status-feedback/details-first');
  // Listener and timer baseline after one full cycle, then the same cycle repeated must not grow it.
  const cycle = async () => {
    await openUsage(page); await page.keyboard.press('Escape'); await expect(usage(page)).toHaveCount(0);
    await pip(page).locator('.pp-pill').click(); await expect(pip(page).locator('.pp-card')).toBeVisible();
    await pip(page).locator('[data-pp="collapse"]').click(); await expect(pip(page).locator('.pp-pill')).toBeVisible();
    await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
    await page.locator('#navigation .task-item[data-id="session-1"]').click(); await expect(pip(page).locator('.pp-pill')).toBeVisible();
  };
  const live = () => page.evaluate(() => (window as any).__statusLive());
  await cycle();
  // Opening and closing usage and the picture-in-picture adds nothing at all.
  const round = async () => { await openUsage(page); await page.keyboard.press('Escape'); await expect(usage(page)).toHaveCount(0); await pip(page).locator('.pp-pill').click(); await expect(pip(page).locator('.pp-card')).toBeVisible(); await pip(page).locator('[data-pp="collapse"]').click(); await expect(pip(page).locator('.pp-pill')).toBeVisible(); };
  await round();
  let baseline = await live();
  for (let index = 0; index < 3; index++) { await round(); expect(await live(), `round ${index}`).toEqual(baseline); }
  expect(baseline.status).toBe(1);
  // Task switches: this family's listeners and timers stay flat. (A task switch grows a few unrelated window/document
  // listeners with zero extensions too; that pre-existing growth is recorded in the extensibility issues register.)
  baseline = await live();
  for (let round = 0; round < 3; round++) await cycle();
  const after = await live();
  for (const key of ['window:pandacode:status', 'window:pandacode-components-change', 'document:contextmenu', 'document:keydown', 'window:storage']) expect(after.byKey[key], key).toBe(baseline.byKey[key]);
  expect(after.intervals).toBe(baseline.intervals);
  // A package without harnesses.inventory or tasks.summary sees no reads or iterations; presentation and actions are the same.
  await openUsage(page);
  expect(await props(page)).toMatchObject({ inventory: false, providers: [], progress: false, iterations: 0, jevStatus: 'none' });
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-cost-details', 'usage-agents']);
  await usage(page).locator('.usage-range [data-range="year"]').click(); await usage(page).getByRole('tab', { name: 'Claude', exact: true }).click();
  await usage(page).getByRole('tab', { name: 'Claude', exact: true }).focus();
  await page.evaluate(() => { const w = window as any; w.__statusNodes = { host: document.querySelector('#agent-usage-host'), details: document.querySelector('#dialog .usage-cost-details'), card: document.querySelector('#dialog .usage-card:not([hidden])'), pip: document.querySelector('#progress-pip'), prompt: document.querySelector('#prompt') }; });
  const pipPreference = await page.evaluate(() => localStorage.getItem('pandacode.progressPip'));
  const check = async () => {
    expect(await page.evaluate(() => { const nodes = (window as any).__statusNodes; return Object.values(nodes).every((node: any) => node.isConnected) && nodes.host === document.querySelector('#agent-usage-host') && nodes.prompt === document.querySelector('#prompt'); })).toBe(true);
    await expect(usage(page).getByRole('tab', { name: 'Claude', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(usage(page).getByRole('tab', { name: 'Claude', exact: true })).toBeFocused();
    await expect(usage(page).locator('.usage-range [data-range="year"]')).toHaveAttribute('aria-pressed', 'true');
    expect(await page.evaluate(() => localStorage.getItem('pandacode.progressPip'))).toBe(pipPreference);
    // No read was started by any of this.
    expect((await calls(page, 'agent_usage')).length).toBe(reads);
    await noAuthority(page);
  };
  const reads = (await calls(page, 'agent_usage')).length;
  await check();
  expect(await act(page, 'usage-tab', 'overview', { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyStatusPresentation(document.querySelector('#action-dock > [data-group="status"]'), () => undefined, () => { throw Error('controlled fault'); }); });
  await expect(group(page)).not.toHaveAttribute('data-status-provider');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(group(page)).not.toHaveAttribute('data-status-provider');
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-agents', 'usage-cost-details']);
  expect(await act(page, 'usage-tab', 'overview')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.status-feedback'));
  await check();
  await page.keyboard.press('Escape'); await expect(usage(page)).toHaveCount(0);
  region = await explorer(page); await region.getByLabel('Status and usage presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(group(page)).toHaveAttribute('data-status-provider', PROVIDER);
  await openUsage(page);
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-cost-details', 'usage-agents']);
  expect(await props(page)).toMatchObject({ inventory: true, progress: true, iterations: 6 });
  // Exactly once: one captured tab opens it once.
  expect(await act(page, 'usage-tab', 'codex')).toEqual({ ok: true }); await expect(usage(page).getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await usage(page).getByRole('tab', { name: 'Codex', exact: true }).focus();
  await page.evaluate(() => (window as any).__previewStatusSafeMode());
  await expect(group(page)).not.toHaveAttribute('data-status-provider');
  await expect(usage(page).getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true'); await expect(usage(page).getByRole('tab', { name: 'Codex', exact: true })).toBeFocused();
  await usage(page).getByRole('tab', { name: 'Overview', exact: true }).click();
  expect(await sections(page)).toEqual(['usage-heroes', 'usage-range-row', 'usage-agents', 'usage-cost-details']);
  expect((await props(page)).safeMode).toBe(true);
  await noAuthority(page);
});
