import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's `?bots=sample` bots (Scout waiting for approval, Writer working, Ledger at a usage
// limit, Dozy paused) and the #launch shared channel, with in-memory storage. No bot is created, deleted or paused and
// no messaging service is called; installed-window qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/sidebar-bots/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.sidebar-bots/filter-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewSidebarBots());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const mutations = async (page: Page) => Promise.all(['bot_create', 'bot_delete', 'bot_set_paused', 'bot_shared_channel_archive', 'bot_shared_channel_create', 'bot_shared_channel_update'].map(async command => (await calls(page, command)).length));
const sidebar = (page: Page) => page.locator('.sidebar');
const panel = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });
const bar = (page: Page) => page.locator('.sidebar-bots-bar');
const search = (page: Page) => panel(page).locator('[data-bots-search]');
const bot = (page: Page, name: string) => page.locator('#sidebar-bots-panel .bot-row').filter({ has: page.locator('.bot-row-name', { hasText: new RegExp(`^${name}$`) }) });
const channel = (page: Page, name: string) => page.locator(`#sidebar-bots-panel .channel-row[aria-label="#${name}"]`);
const groups = (page: Page) => page.locator('#sidebar-bots-panel .bots-panel-list > [data-bots-group]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.botsGroup));
const head = (page: Page) => page.locator('#sidebar-bots-panel .bots-panel-head > :is(label, button)').evaluateAll(nodes => nodes.map(node => node.className.split(' ')[0] + ((node as HTMLElement).dataset.action ? `:${(node as HTMLElement).dataset.action}` : '')));
const hiddenToggle = (page: Page) => page.locator('#sidebar-bots-panel .bots-group-toggle');
const toast = (page: Page) => page.locator('#toast');
const prompt = (page: Page) => page.locator('#prompt');
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&sidebar-coverage&replacement&bots=sample'); await expect(prompt(page)).toBeEnabled();
  if (await bar(page).getAttribute('aria-pressed') !== 'true') await bar(page).click();
  await expect(panel(page)).toBeVisible();
  // Scout reports its approval shortly after launch, moving into Needs you.
  await expect.poll(async () => (await props(page))?.groups.find((group: any) => group.id === 'needs-you')?.count ?? 0).toBe(1);
  await expect(bot(page, 'Scout')).toBeVisible();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(sidebar(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Sidebar presentation', { exact: true }).selectOption(id); await back(page); await expect(sidebar(page)).toHaveAttribute('data-sidebar-provider', id); }
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, location: string, label: RegExp | string, open = true) {
  const region = open ? await explorer(page) : page.getByRole('region', { name: 'Surface explorer' });
  if (open) await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: typeof label === 'string' ? `Hide ${label}` : label, exact: typeof label === 'string' });
  for (let cursor = 0; cursor < 4 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}
/** Builds a captured action from the live presentation. Row handles are opaque; the test maps them by their position in
 * the drawn list, which is the order the presentation lists them in. */
async function action(page: Page, controlId: string, target: { bot?: string; channel?: string } = {}, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, target, changes }) => {
    const p = (window as any).__previewSidebarBots();
    let resource = '';
    if (target.bot || target.channel) {
      const nodes = [...document.querySelectorAll<HTMLElement>('#sidebar-bots-panel .bots-panel-list [data-bot-row], #sidebar-bots-panel .bots-panel-list .channel-row[data-channel]')].filter(node => node.closest('[data-bots-group]'));
      const index = nodes.findIndex(node => target.bot ? node.querySelector('.bot-row-name')?.textContent === target.bot : node.getAttribute('aria-label') === `#${target.channel}`);
      resource = p.rows[index]?.id ?? 'missing-row';
    }
    const control = p.controls.find((item: any) => item.controlId === controlId && (!resource || item.resource === resource));
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, bot: p.bot, channel: p.channel, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, target, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewSidebarBotsAction(input), input);
const act = async (page: Page, controlId: string, target: { bot?: string; channel?: string } = {}, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, target, changes));
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
const selectedBot = (page: Page) => page.locator('#sidebar-bots-panel .bot-row.selected .bot-row-name').textContent();

test('Bots panel extension: zero extensions keep groups, search, Hidden group, row menus and original handlers', async ({ page }) => {
  await setup(page);
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await groups(page)).toEqual(['needs-you', 'bots', 'hidden', 'channels']);
  await expect(page.locator('#sidebar-bots-panel .bots-panel-list')).not.toHaveAttribute('data-row-hidden');
  const p = await props(page);
  expect(p).toMatchObject({ view: 'bots', visible: true, busy: false, searching: false, loaded: true, safeMode: false, channel: '' });
  const open = await page.locator('#sidebar-bots-panel .bot-row.selected .bot-row-name').allTextContents();
  expect(Boolean(p.bot)).toBe(open.length === 1); expect(p.rows.filter((row: any) => row.selected)).toHaveLength(open.length);
  expect(p.groups.filter((group: any) => group.pinned).map((group: any) => group.id)).toEqual(['needs-you']);
  expect(p.rows.map((row: any) => [row.kind, row.group, row.status].join(':')).sort()).toEqual(['bot:bots:limited', 'bot:bots:working', 'bot:needs-you:waiting', 'channel:channels:none']);
  // No package, no captured action: the request is refused and nothing moves.
  expect(await act(page, 'open-bot', { bot: 'Writer' })).toEqual({ ok: false, reason: 'Revoked' });
  expect(await page.locator('#sidebar-bots-panel .bot-row.selected .bot-row-name').allTextContents()).toEqual(open);
  await expect(panel(page).locator('.extension-header-actions')).toBeHidden();
  // The bot and channel row menus keep exactly their core rows.
  await bot(page, 'Writer').click({ button: 'right' });
  const menu = page.getByRole('dialog', { name: 'Writer actions', exact: true });
  await expect(menu.getByRole('menuitem')).toHaveText(['Pin', 'Edit bot', 'Duplicate bot', 'Hide (pause)', 'Delete bot…']);
  await menu.getByRole('menuitem', { name: 'Pin', exact: true }).click();
  await expect.poll(() => groups(page)).toEqual(['needs-you', 'pinned', 'bots', 'hidden', 'channels']);
  await channel(page, 'launch').click({ button: 'right' });
  await expect(page.getByRole('dialog', { name: '#launch actions', exact: true }).getByRole('menuitem')).toHaveText(['Edit', 'Delete']);
  await page.keyboard.press('Escape');
  // Original Hidden-group fold, search and its saved preference.
  await hiddenToggle(page).click(); await expect(hiddenToggle(page)).toHaveAttribute('aria-expanded', 'true'); await expect(bot(page, 'Dozy')).toBeVisible();
  expect(await page.evaluate(() => localStorage.getItem('pandacode.botsHiddenOpen'))).toBe('true');
  await search(page).fill('Ledger'); await expect(bot(page, 'Writer')).toHaveCount(0); await expect(bot(page, 'Ledger')).toBeVisible();
  expect((await props(page)).searching).toBe(true);
  await search(page).fill(''); await expect(bot(page, 'Writer')).toBeVisible();
  expect(await mutations(page)).toEqual([0, 0, 0, 0, 0, 0]);
});

test('Bots panel extension: the selected package adds a head accessory and bot and channel row actions that are clicked through the public context', async ({ page }) => {
  await setup(page, [manifest]);
  // Install and enable alone change nothing: no provider is selected, the accessory still contributes (ui.contribute).
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' });
  await select(page);
  await expect(panel(page)).toBeVisible();
  const before = await mutations(page), open = await page.locator('#sidebar-bots-panel .bot-row.selected .bot-row-name').allTextContents();
  await panel(page).getByRole('button', { name: 'Bots notes', exact: true }).click(); await expect(toast(page)).toContainText('Bots stay host-owned');
  await bot(page, 'Ledger').click({ button: 'right' });
  const menu = page.getByRole('dialog', { name: 'Ledger actions', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Delete bot…', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Bot notes', exact: true }).click(); await expect(toast(page)).toContainText('Bot rows stay host-owned');
  await channel(page, 'launch').click({ button: 'right' });
  const channelMenu = page.getByRole('dialog', { name: '#launch actions', exact: true });
  await expect(channelMenu.getByRole('menuitem', { name: 'Bot notes' })).toHaveCount(0);
  await channelMenu.getByRole('menuitem', { name: 'Channel notes', exact: true }).click(); await expect(toast(page)).toContainText('Channel rows stay host-owned');
  // Contributed actions ran no host handler: no bot or channel was created, deleted, paused or changed.
  expect(await mutations(page)).toEqual(before);
  expect(await page.locator('#sidebar-bots-panel .bot-row.selected .bot-row-name').allTextContents()).toEqual(open);
});

test('Bots panel extension: captured actions run original handlers after a fresh choice; stale, replayed, forged, protected and busy requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const before = await mutations(page);
  expect(await act(page, 'search', {}, { controlId: 'delete-bot' })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'search', {}, { controlId: 'channel-members' })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'search', {}, { controlId: 'rename-bot' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'search', {}, { selector: '.bot-row' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'search', {}, { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The sample may open any bot first; start from Ledger so that opening Writer below is a real change.
  if (await selectedBot(page) === 'Writer') {
    expect(await act(page, 'open-bot', { bot: 'Ledger' })).toEqual({ ok: true });
    await expect(bot(page, 'Ledger').locator('.bot-row-open')).toHaveAttribute('aria-current', 'page');
  }
  const stale = await action(page, 'open-bot', { bot: 'Ledger' });
  const request = await action(page, 'open-bot', { bot: 'Writer' });
  expect(await send(page, request)).toEqual({ ok: true });
  await expect(bot(page, 'Writer').locator('.bot-row-open')).toHaveAttribute('aria-current', 'page');
  // Opening Writer changed the captured bot: the same request and an older one are refused, never retargeted.
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' }); expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await selectedBot(page)).toBe('Writer');
  expect(await act(page, 'bot-menu', { bot: 'Ledger' })).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Ledger actions', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  expect(await act(page, 'channel-menu', { channel: 'launch' })).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: '#launch actions', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  expect(await act(page, 'search')).toEqual({ ok: true }); await expect(search(page)).toBeFocused();
  expect(await act(page, 'bot-settings', { bot: 'Ledger' })).toEqual({ ok: true });
  await expect(page.getByRole('dialog', { name: 'Ledger settings', exact: true })).toBeVisible();
  expect((await props(page)).busy).toBe(true); expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden();
  // Mark all read only shows while a reply is unread: its handler is unavailable, so the request is refused.
  expect(await act(page, 'mark-read')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The Hidden-group preference waits for a fresh host choice; Escape declines it and nothing is saved.
  expect(await act(page, 'toggle-hidden')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'open-bot', { bot: 'Ledger' })).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape');
  await expect(hiddenToggle(page)).toHaveAttribute('aria-expanded', 'false'); expect(await page.evaluate(() => localStorage.getItem('pandacode.botsHiddenOpen'))).toBeNull();
  expect(await act(page, 'toggle-hidden')).toEqual({ ok: true }); await proceed(page, 'Show or hide paused bots');
  await expect(hiddenToggle(page)).toHaveAttribute('aria-expanded', 'true'); await expect(bot(page, 'Dozy')).toBeVisible();
  // The create menu opens directly; New bot and New channel only open their host dialogs after a fresh choice.
  expect(await act(page, 'create-menu')).toEqual({ ok: true }); await expect(panel(page).getByRole('menu', { name: 'Create' })).toBeVisible();
  await page.keyboard.press('Escape'); await page.locator('#prompt').click({ force: true });
  expect(await act(page, 'new-bot')).toEqual({ ok: true }); await proceed(page, 'New bot');
  await expect(page.getByRole('dialog', { name: /^(Bots|New bot)$/ })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden();
  expect(await act(page, 'new-channel')).toEqual({ ok: true }); await proceed(page, 'New channel');
  await expect(page.locator('#dialog[open]')).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden();
  for (const field of ['context', 'project', 'bot', 'channel', 'control', 'resource']) expect(await act(page, 'search', {}, { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'search', {}, { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  // Opening the channel moves the captured channel; the view switch waits for a fresh choice and keeps the open channel.
  expect(await act(page, 'open-channel', { channel: 'launch' })).toEqual({ ok: true });
  await expect(channel(page, 'launch')).toHaveAttribute('aria-current', 'page');
  expect((await props(page)).channel).not.toBe('');
  expect(await act(page, 'toggle-view')).toEqual({ ok: true }); await proceed(page, 'Switch the sidebar view');
  await expect(bar(page)).toHaveAttribute('aria-pressed', 'false'); await expect(page.locator('#navigation')).toBeVisible();
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await mutations(page)).toEqual(before);
});

test('Bots panel extension: group and head order, reversible group and row-part visibility, forged overlays and safe mode', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.sidebar.bots.groups', 'Channels above Needs you'); await back(page);
  await expect.poll(() => groups(page)).toEqual(['bots', 'hidden', 'channels', 'needs-you']);
  await proposal(page, 'panda.sidebar.bots', 'Create before search'); await back(page);
  const order = await head(page);
  expect(order.indexOf('icon-button:new-bot-menu')).toBeLessThan(order.indexOf('bots-panel-search'));
  // Hiding the Hidden group, the settings button and Mark all read is reversible; Needs you and search cannot hide.
  let region = await hide(page, 'panda.sidebar.bots.groups', 'Hidden');
  await expect(region.getByRole('button', { name: /^Hide Needs you/ })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.sidebar.bots');
  await expect(region.getByRole('button', { name: /^Hide Search bots/ })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.sidebar.bots.rows');
  await hide(page, 'panda.sidebar.bots.rows', /^Hide Bot settings button/, false); await back(page);
  await expect.poll(() => groups(page)).toEqual(['bots', 'channels', 'needs-you']);
  expect((await props(page)).groups.find((group: any) => group.id === 'hidden')).toMatchObject({ hidden: true, count: 1 });
  await expect(page.locator('#sidebar-bots-panel .bots-panel-list')).toHaveAttribute('data-row-hidden', 'settings');
  await expect(bot(page, 'Writer').locator('.bot-row-settings')).toBeHidden();
  expect(await act(page, 'bot-settings', { bot: 'Writer' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  // The hidden settings button keeps its path through the row menu.
  await bot(page, 'Writer').click({ button: 'right' });
  await page.getByRole('dialog', { name: 'Writer actions', exact: true }).getByRole('menuitem', { name: 'Edit bot', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Writer settings', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden();
  // Searching finds bots in hidden groups; clearing hides the group again.
  await search(page).fill('Dozy'); await expect(page.locator('#sidebar-bots-panel [data-bots-group="hidden"]')).toBeVisible();
  await search(page).fill(''); await expect(page.locator('#sidebar-bots-panel [data-bots-group="hidden"]')).toHaveCount(0);
  // A forged overlay cannot hide Needs you, the search field or the Bots bar.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.sidebar.bots.groups/needs-you': false, 'panda.sidebar.bots/search': false, 'panda.sidebar.bots.protected/bar': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(page.locator('#sidebar-bots-panel [data-bots-group="needs-you"]')).toBeVisible(); await expect(search(page)).toBeVisible(); await expect(bar(page)).toBeVisible();
  await expect(bot(page, 'Scout').locator('.bot-badge')).toHaveAttribute('aria-label', 'Needs approval');
  await page.evaluate(() => (window as any).__previewSidebarSafeMode());
  await expect.poll(() => groups(page)).toEqual(['needs-you', 'bots', 'hidden', 'channels']);
  await expect(page.locator('#sidebar-bots-panel .bots-panel-list')).not.toHaveAttribute('data-row-hidden');
  expect(await head(page)).toEqual(['bots-panel-search', 'bots-mark-read:mark-bots-read', 'icon-button:new-bot-menu']);
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
});

test('Bots panel extension: the open bot, search text, Hidden group and focus survive conflict, fault, disable and safe mode without a duplicate action', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.sidebar-bots'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.sidebar-bots/filter-first' }] };
  const future = structuredClone(other); future.id = 'future.sidebar-bots'; future.contributes.components[0].id = 'future.sidebar-bots/filter-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  let region = await explorer(page);
  await expect(region.getByLabel('Sidebar presentation')).toHaveValue(''); await expect(region.locator('option[value="future.sidebar-bots/filter-first"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' });
  await select(page, 'other.sidebar-bots/filter-first');
  await hiddenToggle(page).click(); await expect(hiddenToggle(page)).toHaveAttribute('aria-expanded', 'true');
  await bot(page, 'Writer').locator('.bot-row-open').click(); await expect(bot(page, 'Writer').locator('.bot-row-open')).toHaveAttribute('aria-current', 'page');
  await search(page).fill('i');
  const before = await mutations(page), choices = (await calls(page, 'bot_desktop_thread')).length;
  const check = async () => {
    await expect(search(page)).toHaveValue('i'); await expect(search(page)).toBeFocused();
    await expect(bot(page, 'Writer').locator('.bot-row-open')).toHaveAttribute('aria-current', 'page');
    await expect(hiddenToggle(page)).toHaveAttribute('aria-expanded', 'true');
    expect(await page.evaluate(() => localStorage.getItem('pandacode.botsHiddenOpen'))).toBe('true');
    expect(await mutations(page)).toEqual(before); expect((await calls(page, 'bot_desktop_thread')).length).toBe(choices);
  };
  await search(page).focus();
  expect(await act(page, 'search', {}, { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySidebarPresentation(document.querySelector('.sidebar'), () => { throw Error('controlled fault'); }); });
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider');
  expect(await act(page, 'open-bot', { bot: 'Ledger' })).toEqual({ ok: false, reason: 'Revoked' });
  await search(page).focus(); await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.sidebar-bots'));
  await check();
  region = await explorer(page); await region.getByLabel('Sidebar presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(sidebar(page)).toHaveAttribute('data-sidebar-provider', PROVIDER);
  await search(page).focus(); await check();
  await expect(panel(page).getByRole('button', { name: 'Bots notes', exact: true })).toBeVisible();
  await page.evaluate(() => (window as any).__previewSidebarSafeMode());
  await expect(sidebar(page)).not.toHaveAttribute('data-sidebar-provider'); await expect(panel(page).locator('.extension-header-actions')).toBeHidden();
  await check();
  expect((await props(page)).safeMode).toBe(true); expect(await act(page, 'search')).toEqual({ ok: false, reason: 'Revoked' });
});
