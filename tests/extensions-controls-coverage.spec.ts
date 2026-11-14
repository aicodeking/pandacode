import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
/**
 * Integrated controls audit (T56I) across the T56A-H and T56J families: Settings, main and module-owned dialogs, sidebar and its Bots panel,
 * action dock/team, agent roster, cached usage/status and the shared primitives. Browser fixtures only: preview
 * sample threads, bots and in-memory storage; installed-window qualification is separate and not claimed here.
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8'));
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const audit = ledger.controlsAudit;
const FIXTURES = ['settings-core', 'core-dialogs', 'owned-dialogs', 'sidebar', 'sidebar-bots', 'action-dock', 'agent-roster', 'status', 'primitives'];
const QUERY = 'extensions-baseline&settings-coverage&dialog-coverage&owned-dialog-coverage&sidebar-coverage&dock-coverage&roster-coverage&status-coverage&primitives-coverage&replacement&sections&bots=sample';
const LAYOUT = 'pandacode.extensions.layout.v1';
const RECIPES: [string, string, string, string][] = [
  ['Sidebar presentation', 'sample.sidebar/filter-first', '.sidebar', 'data-sidebar-provider'],
  ['Action dock presentation', 'sample.action-dock/actions-first', '#action-dock', 'data-dock-provider'],
  ['Agent roster presentation', 'sample.agent-roster/running-first', '#subagents-host', 'data-roster-provider'],
  ['Status and usage presentation', 'sample.status-feedback/details-first', '#action-dock > [data-group="status"]', 'data-status-provider'],
];
const prompt = (page: Page) => page.locator('#prompt');
const group = (page: Page, name: string) => page.locator(`#navigation [data-thread-group="${name}"]`);
async function setup(page: Page, packages: unknown[], query = QUERY, overlay?: unknown) {
  await page.addInitScript(({ packages, overlay, key }) => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
    if (overlay && localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify(overlay));
  }, { packages, overlay, key: LAYOUT });
  await page.goto(`/?${query}`); await expect(prompt(page)).toBeEnabled();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };

test('Controls audit: every Settings, dialog, sidebar, agents and status ledger member maps to a T56 family with executed evidence or an explicit gap', () => {
  const families = Object.fromEntries(ledger.families.map((family: any) => [family.id, family.members.map(([id]: string[]) => id)]));
  expect(audit.families.map((family: any) => family.lead).filter((id: string, index: number, all: string[]) => all.indexOf(id) === index)).toEqual(['T56A', 'T56B', 'T56C', 'T56D', 'T56J', 'T56E', 'T56F', 'T56G', 'T56H']);
  const configs = ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  for (const family of audit.families) {
    const row = family.details.length === 2 ? ledger[family.details[0]][family.details[1]] : null;
    if (row) { expect(row.status, family.slot).toBe('implemented-experimental'); expect(row.evidence.length, family.slot).toBeGreaterThan(0); }
    expect(() => fixture(family.fixture), family.fixture).not.toThrow();
    for (const path of new Set([...family.evidence, ...(row?.evidence ?? [])])) expect(() => readFileSync(new URL(`../${path}`, import.meta.url)), path).not.toThrow();
    for (const spec of family.evidence.filter((path: string) => path.endsWith('.spec.ts'))) for (const config of configs) expect(config, spec).toContain(spec.replace('tests/', ''));
  }
  for (const config of configs) expect(config).toContain('extensions-controls-coverage.spec.ts');
  // Settings: every ledger page has a page row; a page that cannot hide or take fields says why.
  const settings = ledger.settingsCoverage['panda.settings.pages'];
  expect(Object.keys(settings.pages).sort()).toEqual([...families['panda.settings.pages']].sort());
  for (const [id, page] of Object.entries<any>(settings.pages)) {
    expect(settings.sections, id).toContain(page.section);
    if (!page.hide) expect(page.hideReason, id).toBeTruthy();
    if (!page.fields) expect(page.fieldsReason, id).toBeTruthy();
  }
  // Dialogs: one row per ledger dialog, split between T56B (main modal) and T56C (module-owned/direct); protected rows cite a policy.
  const dialogs = Object.entries<any>(ledger.dialogCoverage);
  expect(dialogs.map(([id]) => id.replace('panda.dialog.', '')).sort()).toEqual([...families['panda.dialog']].sort());
  for (const [id, row] of dialogs) {
    expect(['T56B', 'T56C'], id).toContain(row.lead);
    if (row.status === 'protected') expect(row.reason, id).toMatch(/\w{3,}.*\w{3,}/);
    else { expect(row.status, id).toBe('implemented-experimental'); expect(row.location, id).toBe(row.alias ? `panda.dialog.${row.alias}` : id); }
  }
  // A direct-mount alias names a main dialog that exists, so the two never mount separate bands.
  for (const [id, row] of dialogs.filter(([, row]) => row.alias)) expect(ledger.dialogCoverage[`panda.dialog.${row.alias}`]?.lead, id).toBe('T56B');
  // Sidebar, agents and status: covered members plus gaps are exactly the ledger members.
  for (const id of ['panda.sidebar', 'panda.agents', 'panda.status']) {
    const covered = audit.families.filter((family: any) => family.ledger === id).flatMap((family: any) => family.members === 'all' ? families[id] : family.members);
    const gaps = Object.keys(audit.gaps).filter(key => key.startsWith(`${id}/`) && audit.gaps[key].severity !== 'closed').map(key => key.slice(id.length + 1)).filter(gap => families[id].includes(gap));
    expect([...new Set([...covered, ...gaps])].sort(), id).toEqual([...families[id]].sort());
    expect(covered.filter((member: string) => gaps.includes(member)), id).toEqual([]);
  }
  // The Bots panel gap this audit found is closed by T56J's own row, not by a protected exception; no blocking gap remains.
  expect(audit.gaps['panda.sidebar/bots']).toMatchObject({ severity: 'closed', lead: 'T56J', closedBy: 'sidebarCoverage["panda.sidebar.bots"]' });
  expect(ledger.sidebarCoverage['panda.sidebar.bots']).toMatchObject({ status: 'implemented-experimental', lead: 'T56J' });
  expect(ledger.sidebarCoverage['panda.sidebar.bots'].closes).toContain('panda.sidebar/bots');
  expect(ledger.sidebarCoverage['panda.sidebar'].closed.bots).toContain('T56J');
  expect(ledger.sidebarCoverage['panda.sidebar'].open?.bots).toBeUndefined();
  expect(Object.values<any>(audit.gaps).filter(gap => gap.severity === 'blocking')).toEqual([]);
  expect(audit.status).toBe('accepted');
  // The pinned widget window is T57's.
  expect(audit.gaps['panda.agents/widget-window']).toMatchObject({ severity: 'assigned', lead: 'T57' });
  expect(ledger.dockCoverage['panda.actionDock'].open.widget).toContain('T57'); expect(ledger.rosterCoverage['panda.roster'].open['widget-window']).toContain('T57');
});

test('Controls audit: the T56 packages use only public manifest contracts, no private imports, selectors or host internals', () => {
  for (const name of FIXTURES) {
    const text = readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8'), manifest = JSON.parse(text);
    expect(manifest.id, name).toMatch(/^[a-z0-9-]+\.[a-z0-9-]+$/); expect(manifest.id.startsWith('panda.'), name).toBe(false);
    for (const forbidden of ['/src/', 'querySelector', '__TAURI', '__preview', 'invoke(', '<script', 'javascript:', 'onclick', '#dialog', '.task-item', 'data-action']) expect(text, `${name}: ${forbidden}`).not.toContain(forbidden);
    // Every contribution is namespaced to its package.
    for (const list of Object.values<any>(manifest.contributes ?? {})) if (Array.isArray(list)) for (const item of list) if (item?.id) expect(item.id.startsWith(`${manifest.id}/`), `${name}: ${item.id}`).toBe(true);
  }
});

test('Controls audit: all nine T56 packages load together; each family adopts its recipe and safe mode restores every one', async ({ page }) => {
  test.setTimeout(90_000);
  const packages = FIXTURES.map(fixture); await setup(page, packages);
  let region = await explorer(page);
  for (const manifest of packages) await expect(page.getByRole('button', { name: `Disable ${manifest.id}`, exact: true }), manifest.id).toHaveCount(1);
  for (const [label, id] of RECIPES) await region.getByLabel(label, { exact: true }).selectOption(id);
  await region.getByLabel('Settings presentation', { exact: true }).selectOption('sample.settings-core/actions-first');
  await expect(page.locator('#settings-page')).toHaveAttribute('data-settings-provider', 'sample.settings-core/actions-first');
  await back(page);
  for (const [, id, selector, attribute] of RECIPES) await expect(page.locator(selector).first(), id).toHaveAttribute(attribute, id);
  for (const name of ['__previewSidebar', '__previewDock', '__previewRoster', '__previewStatus']) expect(await page.evaluate(name => Boolean((window as any)[name]?.()), name), name).toBe(true);
  // The open task, its draft and the core handlers are untouched by nine concurrent packages.
  const selected = await page.locator('#navigation .task-item.selected').getAttribute('data-id');
  await prompt(page).fill('draft kept across every family');
  region = await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  for (const [, id, selector, attribute] of RECIPES) await expect(page.locator(selector).first(), id).not.toHaveAttribute(attribute, id);
  for (const name of ['__previewSidebarAction', '__previewDockAction', '__previewRosterAction', '__previewStatusAction']) {
    expect(await page.evaluate(name => (window as any)[name]({}), name), name).toMatchObject({ ok: false });
  }
  await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', selected!);
  await expect(prompt(page)).toHaveValue('draft kept across every family');
  for (const command of ['delete_session', 'set_task_stage', 'stop_session', 'restart_to_update']) expect(await page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command).length, command), command).toBe(0);
});

test('Controls audit: a dialog shared by the main and module-owned families draws one accessory band holding each package once', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, [fixture('core-dialogs'), fixture('owned-dialogs')], 'extensions-baseline&dialog-coverage&owned-dialog-coverage&bots=sample');
  const dialog = page.locator('#dialog'), bands = page.locator('.dialog-extension-extras:not([hidden])');
  const contributions = () => page.locator('.dialog-extension-extras [data-extension-contribution]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.extensionContribution ?? ''));
  const close = async () => { await page.keyboard.press('Escape'); if (await dialog.evaluate(node => (node as HTMLDialogElement).open)) await page.keyboard.press('Escape'); await expect(dialog).toHaveJSProperty('open', false); };
  for (const [opener, id, band] of [['main', 'integrations', 'integrations'], ['owned', 'integrations-direct', 'integrations'], ['main', 'jev-assist', 'jev-assist'], ['owned', 'jev-assist-direct', 'jev-assist'], ['main', 'jev-tests', 'jev-tests'], ['owned', 'jev-tests-direct', 'jev-tests']] as const) {
    await page.evaluate(([opener, id]) => opener === 'main' ? (window as any).__previewOpenMainDialog(id) : (window as any).__previewOpenOwnedDialog(id), [opener, id]);
    await expect(dialog, id).toHaveJSProperty('open', true);
    await expect(page.locator(`.dialog-extension-extras[data-dialog-accessory="${band}"]`), id).toHaveCount(1);
    await expect(bands, id).toHaveCount(1);
    await expect.poll(async () => (await contributions()).length, { message: id }).toBeGreaterThan(0);
    const ids = await contributions();
    expect(new Set(ids).size, `${id}: ${ids.join(', ')}`).toBe(ids.length);
    expect(ids.some(value => value.startsWith('sample.core-dialogs/')), id).toBe(true);
    expect(ids.some(value => value.startsWith('sample.owned-dialogs/')), id).toBe(true);
    await close();
    await expect(page.locator('.dialog-extension-extras[data-extension-contribution], .dialog-extension-extras [data-extension-contribution]')).toHaveCount(0);
  }
});

test('Controls audit: hidden core controls of several families are reversible, never reapplied in safe mode and never deleted', async ({ page }) => {
  const hidden = { 'panda.sidebar.sections/pinned': false, 'panda.sidebar.rows/provider': false, 'panda.actionDock.controls/terminal': false, 'panda.settings.sections/appearance': false };
  await setup(page, [], 'extensions-baseline&sections', { schemaVersion: 1, visibility: hidden, extensionLayoutsEnabled: true, orders: {}, selected: {} });
  const terminal = page.locator('#terminal-toggle'), appearance = page.locator('.settings-nav-list [role="tab"]').filter({ hasText: /^\s*Appearance\s*$/ });
  // The section holding the open task always stays listed, so open an Active task first.
  const running = page.locator('#navigation .task-item[data-id="sections-running"]');
  await running.click(); await expect(running).toHaveAttribute('aria-current', 'page');
  await expect(group(page, 'pinned')).toHaveCount(0); await expect(page.locator('#navigation')).toHaveAttribute('data-row-hidden', 'provider');
  await expect(terminal).toHaveAttribute('data-layout-hidden', '');
  await page.keyboard.press('ControlOrMeta+,'); await expect(appearance).toHaveAttribute('data-layout-hidden', '');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(appearance).not.toHaveAttribute('data-layout-hidden');
  await back(page);
  await expect(group(page, 'pinned')).toBeVisible(); await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-hidden');
  await expect(terminal).not.toHaveAttribute('data-layout-hidden'); await expect(terminal).toBeVisible();
  // A later overlay write (another window, a forged value) in safe mode applies nothing.
  await page.evaluate(key => {
    const value = JSON.parse(localStorage.getItem(key)!);
    value.visibility = { ...value.visibility, 'panda.actionDock.controls/browser': false, 'panda.sidebar.sections/review': false, 'panda.sidebar.rows/more': false };
    localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key, newValue: JSON.stringify(value) }));
  }, LAYOUT);
  await page.locator('#navigation .task-item[data-id="sections-pinned"]').click(); await running.click(); await expect(running).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#browser-toggle')).not.toHaveAttribute('data-layout-hidden'); await expect(terminal).not.toHaveAttribute('data-layout-hidden');
  await expect(group(page, 'pinned')).toBeVisible(); await expect(group(page, 'review')).toBeVisible();
  await expect(page.locator('#navigation')).not.toHaveAttribute('data-row-hidden');
  await page.keyboard.press('ControlOrMeta+,'); await expect(appearance).not.toHaveAttribute('data-layout-hidden'); await back(page);
  // The user's preferences are kept for the next normal launch, not deleted by recovery.
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).visibility, LAYOUT);
  expect(saved).toMatchObject(hidden);
});

test('Controls audit: task switches with zero extensions leave window and document listeners flat once AbortSignal removal is counted', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    // Two probes: one counts only removeEventListener (the T56G status probe), one also counts { signal } aborts.
    const naive = new Map<string, Set<unknown>>(), live = new Map<string, Set<unknown>>();
    const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
    const key = (target: unknown, type: string) => target === window ? `window:${type}` : target === document ? `document:${type}` : '';
    const capture = (options: unknown) => typeof options === 'boolean' ? options : Boolean((options as AddEventListenerOptions | undefined)?.capture);
    EventTarget.prototype.addEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
      const k = key(this, type);
      if (k && listener && !(options?.signal?.aborted)) {
        const entry = `${capture(options)}`;
        for (const map of [naive, live]) { if (!map.has(k)) map.set(k, new Set()); }
        naive.get(k)!.add(listener); const token = [listener, entry]; const tokens = live.get(k)!;
        if (![...tokens].some((item: any) => item[0] === listener && item[1] === entry)) tokens.add(token);
        options?.signal?.addEventListener('abort', () => tokens.delete(token), { once: true });
      }
      return add.call(this, type, listener, options);
    };
    EventTarget.prototype.removeEventListener = function (this: EventTarget, type: string, listener: any, options?: any) {
      const k = key(this, type);
      if (k) { naive.get(k)?.delete(listener); const tokens = live.get(k); for (const item of [...tokens ?? []] as any[]) if (item[0] === listener && item[1] === `${capture(options)}`) tokens!.delete(item); }
      return remove.call(this, type, listener, options);
    };
    const count = (map: Map<string, Set<unknown>>) => ({ total: [...map.values()].reduce((sum, set) => sum + set.size, 0), byKey: Object.fromEntries([...map].map(([k, v]) => [k, v.size])) });
    (window as any).__controlsListeners = () => ({ naive: count(naive), live: count(live) });
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', '[]');
  });
  await page.goto('/?extensions-baseline'); await expect(prompt(page)).toBeEnabled();
  const select = async (id: string) => { await page.locator(`#navigation .task-item[data-id="${id}"]`).click(); await expect(page.locator(`#navigation .task-item[data-id="${id}"]`)).toHaveAttribute('aria-current', 'page'); await expect(prompt(page)).toBeEnabled(); };
  const cycle = async () => { await select('session-2'); await select('session-1'); };
  const sample = () => page.evaluate(() => (window as any).__controlsListeners());
  await cycle(); await cycle();
  const before = await sample();
  for (let round = 0; round < 3; round++) await cycle();
  const after = await sample();
  expect(after.live.byKey).toEqual(before.live.byKey);
  // The removeEventListener-only probe still grows: those listeners were removed by aborting their signal.
  expect(after.naive.total).toBeGreaterThanOrEqual(before.naive.total);
});
