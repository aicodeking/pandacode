import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the preview's `?bots=sample` bots (Scout waiting for approval, Writer working, Ledger idle with
// an empty conversation at a usage limit, Dozy paused) and the #launch shared channel, with in-memory storage. No
// messaging service is called; the bot web chat projection is proven natively (src-tauri/src/extensions/projections.rs).
// Installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/bot-conversation/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.bot-conversation/timeline';
const BASE = '/?extensions-baseline&bot-conversation&replacement&bots=sample';
const props = (page: Page) => page.evaluate(() => (window as any).__previewBotConversation());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const transcript = (page: Page) => page.locator('#transcript');
const panel = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });
const crumb = (page: Page) => page.locator('#breadcrumb .bot-crumb');
const slots = (page: Page) => page.locator('.header-leading > .bot-conversation-actions');
const contributed = (page: Page, id: string) => page.locator(`[data-extension-contribution="sample.bot-conversation/${id}"]`);
const channelActions = (page: Page) => page.locator('#composer-area .bc-channel-actions');
const channel = (page: Page) => page.locator('.conversation-pane.channel-thread .bc-channel');
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}`, exact: true });
/** The header buttons and the channel row's buttons in DOM order, hidden ones included. */
const headerOrder = (page: Page) => page.locator('#breadcrumb > .bot-crumb-action').evaluateAll(nodes => nodes.map(node => node.hasAttribute('aria-pressed') ? 'pause' : 'settings'));
const rowOrder = (page: Page) => channelActions(page).locator(':scope > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.sharedAction));
const botId = (page: Page) => page.locator('#breadcrumb .bot-crumb-who').getAttribute('data-bot');
const noEffects = async (page: Page) => { for (const command of ['bot_set_paused', 'bot_shared_channel_stop', 'bot_shared_channel_continue', 'bot_shared_channel_reassign', 'bot_shared_channel_update', 'bot_update', 'bot_delete', 'send_message']) expect(await calls(page, command), command).toEqual([]); };

async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await load(page);
}
/** Another page load: the cold preview's first load can take a while; only readiness waits longer. */
async function load(page: Page) {
  await page.goto(BASE); await expect(prompt(page)).toBeEnabled({ timeout: 20_000 });
  await expect.poll(async () => Boolean(await props(page)), { timeout: 20_000 }).toBe(true);
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function showBots(page: Page) {
  const bar = page.locator('.sidebar-bots-bar');
  if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
  await expect(panel(page)).toBeVisible();
}
async function openBot(page: Page, name: string) {
  // A shared channel is left through its own back button, as a user does.
  const leave = page.getByRole('button', { name: 'Back to conversation', exact: true });
  if (await leave.isVisible()) { await leave.click(); await expect(channel(page)).toHaveCount(0); }
  await showBots(page);
  await panel(page).getByRole('button', { name: new RegExp(`^Chat with ${name}`) }).click();
  await expect(crumb(page)).toContainText(name);
  const limit = page.getByRole('region', { name: 'Usage limit' });
  if (await limit.isVisible()) { await limit.getByRole('button', { name: 'Dismiss usage limit' }).click(); await expect(limit).toHaveCount(0); }
  await expect.poll(async () => (await props(page)).view).toBe('bot-thread');
}
async function openChannel(page: Page) {
  await showBots(page);
  await panel(page).getByRole('button', { name: '#launch' }).click();
  await expect(channel(page)).toBeVisible();
  await expect.poll(async () => (await props(page)).view).toBe('channel');
}
/** A post that fails leaves Continue and Reassign under the channel. */
async function failPost(page: Page) {
  const field = page.getByRole('textbox', { name: 'Message channel' });
  await field.fill('[post-fails] ship it'); await field.press('Enter');
  await expect(channelActions(page)).toContainText('This message failed.');
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(page.locator('.sidebar')).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(id); await back(page); await expect(transcript(page)).toHaveAttribute('data-component-provider', id); }
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(region: ReturnType<Page['locator']>, location: string, label: RegExp) {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: label });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
/** A captured action built from the live presentation; `nth` picks among controls with the same id. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewBotConversation(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, bot: p.bot, session: p.session, channel: p.channel, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewBotConversationAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
/** Opens a contributed action's dialog, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, id: string, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await contributed(page, id).click();
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}

test('Bot conversation extension: zero extensions keep the bot header, welcome and channel controls and their original handlers', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  await openBot(page, 'Ledger');
  await expect(slots(page)).toHaveCount(0);
  await expect(page.locator('#breadcrumb [data-layout-hidden], #transcript [data-layout-hidden]')).toHaveCount(0);
  expect(await headerOrder(page)).toEqual(['pause', 'settings']);
  expect(await props(page)).toMatchObject({ view: 'bot-thread', visible: true, busy: false, safeMode: false });
  expect(await act(page, 'bot-pause')).toEqual({ ok: false, reason: 'Revoked' });
  // A suggestion fills the draft; the settings button opens settings; Pause pauses once and Resume resumes once.
  await transcript(page).getByRole('button', { name: 'What can you help me with?', exact: true }).click();
  await expect(prompt(page)).toHaveValue('What can you help me with?');
  await page.locator('#breadcrumb').getByRole('button', { name: 'Ledger settings', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Ledger settings' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Ledger settings' })).toHaveCount(0);
  await page.locator('#breadcrumb').getByRole('button', { name: 'Pause Ledger', exact: true }).click();
  await expect(page.locator('#breadcrumb').getByRole('button', { name: 'Resume Ledger', exact: true })).toBeVisible();
  expect((await calls(page, 'bot_set_paused')).map((call: any) => call.args.paused)).toEqual([true]);
  await page.locator('#breadcrumb').getByRole('button', { name: 'Resume Ledger', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'bot_set_paused')).map((call: any) => call.args.paused)).toEqual([true, false]);
  // The channel: a failed post leaves Continue then Reassign; Continue runs once.
  await openChannel(page);
  await expect(slots(page)).toHaveCount(0);
  await failPost(page);
  expect(await rowOrder(page)).toEqual(['continue', 'reassign-toggle']);
  await expect(page.locator('#composer-area [data-layout-hidden], #transcript [data-layout-hidden]')).toHaveCount(0);
  await channelActions(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'bot_shared_channel_continue')).length).toBe(1);
  await expect(channel(page).locator('.bc-working-status')).toHaveText('Scout is working');
  await channelActions(page).getByRole('button', { name: /^Stop/ }).click();
  await expect(channelActions(page)).toContainText('This message stopped.');
  expect((await calls(page, 'bot_shared_channel_stop')).length).toBe(1);
});

test('Bot conversation extension: an installed package adds bot thread and channel actions that receive the captured bot and channel, also after switching', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.bot-conversation', exact: true }).click();
  await expect(region.getByLabel('Transcript presentation')).toHaveValue('');
  await back(page);
  // The bot thread: the action follows the header breadcrumb and captures the bot and its conversation.
  await openBot(page, 'Ledger');
  await expect(contributed(page, 'thread')).toBeVisible(); await expect(contributed(page, 'channel')).toBeHidden();
  const ledger = await botId(page);
  const first = await captured(page, 'thread', 'Bot tags');
  expect(first).toMatchObject({ surfaceId: 'panda.bot.thread.actions', selection: { kind: 'bot', ids: [ledger] } });
  expect(typeof first.sessionId).toBe('string');
  expect(JSON.stringify(first)).not.toMatch(/Ledger|Finance|What can you help/);
  // Switching to another bot: the same action captures that bot and its own conversation.
  await openBot(page, 'Scout');
  const scout = await botId(page);
  expect(scout).not.toBe(ledger);
  const second = await captured(page, 'thread', 'Bot tags');
  expect(second).toMatchObject({ surfaceId: 'panda.bot.thread.actions', selection: { kind: 'bot', ids: [scout] } });
  expect(second.sessionId).not.toBe(first.sessionId);
  // The channel: its own action, its own capture; the bot action hides.
  await openChannel(page);
  await expect(contributed(page, 'channel')).toBeVisible(); await expect(contributed(page, 'thread')).toBeHidden();
  const shared = await captured(page, 'channel', 'Channel tags');
  expect(shared).toMatchObject({ surfaceId: 'panda.bot.channel.actions', selection: { kind: 'channel', ids: ['sample-launch'] } });
  expect(JSON.stringify(shared)).not.toMatch(/#launch|Scout|Writer/);
  await noEffects(page);
  // Back to a bot: the bot action shows again, the channel's hides.
  await openBot(page, 'Ledger');
  await expect(contributed(page, 'thread')).toBeVisible(); await expect(contributed(page, 'channel')).toBeHidden();
});

test('Bot conversation extension: captured actions run original handlers after a fresh host choice; Stop, settings and credential changes are refused', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]); await select(page);
  await openBot(page, 'Ledger');
  // A package never stops, deletes, changes settings, credentials or members, sends or writes the draft.
  for (const controlId of ['bot-stop', 'channel-stop', 'bot-delete', 'bot-credentials', 'bot-settings-save', 'channel-settings-save', 'channel-membership', 'channel-delete', 'message-send', 'draft-write']) expect(await act(page, 'bot-pause', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'bot-pause', { text: 'hello' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'bot-pause', { selector: '#breadcrumb' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'bot-pause', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const field of ['context', 'project', 'bot', 'session', 'control', 'resource']) expect(await act(page, 'bot-pause', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await noEffects(page);
  // A suggestion asks first: Escape keeps the draft; Continue puts the suggestion in once.
  await prompt(page).fill('Keep my draft');
  expect(await act(page, 'bot-suggest')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  await expect(choice(page, 'Put “What can you help me with?” in the message to Ledger')).toBeVisible();
  expect(await act(page, 'bot-settings')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice(page, 'Put “What can you help me with?” in the message to Ledger')).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Keep my draft');
  expect(await act(page, 'bot-suggest')).toEqual({ ok: true }); await choice(page, 'Put “What can you help me with?” in the message to Ledger').click();
  await expect(prompt(page)).toHaveValue('What can you help me with?');
  // Settings open through the original handler after the choice; a setup shortcut names its page.
  expect(await act(page, 'bot-settings')).toEqual({ ok: true }); await choice(page, 'Open Ledger settings').click();
  await expect(page.getByRole('dialog', { name: 'Ledger settings' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.getByRole('dialog', { name: 'Ledger settings' })).toHaveCount(0);
  expect(await act(page, 'bot-settings', {}, 2)).toEqual({ ok: true });
  await expect(choice(page, 'Open Ledger settings: Memory')).toBeVisible(); await page.keyboard.press('Escape');
  // Pause asks first; Escape declines; Continue pauses once, and a request captured before is stale.
  const before = await action(page, 'bot-pause');
  expect(await send(page, before)).toEqual({ ok: true });
  await expect(choice(page, 'Pause Ledger')).toBeVisible(); await page.keyboard.press('Escape'); await expect(choice(page, 'Pause Ledger')).toHaveCount(0);
  expect(await calls(page, 'bot_set_paused')).toEqual([]);
  expect(await act(page, 'bot-pause')).toEqual({ ok: true }); await choice(page, 'Pause Ledger').click();
  await expect(page.locator('#breadcrumb').getByRole('button', { name: 'Resume Ledger', exact: true })).toBeVisible();
  expect((await calls(page, 'bot_set_paused')).map((call: any) => call.args.paused)).toEqual([true]);
  expect(await send(page, { ...before, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  // A request captured in this thread is stale in the channel.
  const elsewhere = await action(page, 'bot-pause');
  await openChannel(page);
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  // The channel: Continue asks first and runs once for the captured channel.
  await failPost(page);
  expect(await act(page, 'channel-continue')).toEqual({ ok: true });
  await expect(choice(page, 'Continue the stopped message in #launch')).toBeVisible(); await page.keyboard.press('Escape');
  expect(await calls(page, 'bot_shared_channel_continue')).toEqual([]);
  expect(await act(page, 'channel-continue')).toEqual({ ok: true }); await choice(page, 'Continue the stopped message in #launch').click();
  await expect.poll(async () => (await calls(page, 'bot_shared_channel_continue')).map((call: any) => call.args.channelId)).toEqual(['sample-launch']);
  await expect(channel(page).locator('.bc-working-status')).toHaveText('Scout is working');
  // Stop stays the user's: a package request is refused, the user's own Stop runs once.
  expect(await act(page, 'channel-earlier', { controlId: 'channel-stop' })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await calls(page, 'bot_shared_channel_stop')).toEqual([]);
  await channelActions(page).getByRole('button', { name: /^Stop/ }).click();
  await expect(channelActions(page)).toContainText('This message stopped.');
  // Opening the Reassign menu needs no choice; reassigning to a member asks first and runs once.
  expect(await act(page, 'channel-reassign-open')).toEqual({ ok: true });
  await expect(page.locator('#composer-area .bc-reassign-menu')).toBeVisible();
  expect(await act(page, 'channel-reassign', {}, 1)).toEqual({ ok: true });
  await choice(page, 'Reassign the stopped message to Writer').click();
  await expect.poll(async () => (await calls(page, 'bot_shared_channel_reassign')).map((call: any) => [call.args.channelId, call.args.botId])).toEqual([['sample-launch', expect.any(String)]]);
  await expect(channel(page).locator('.bc-working-status')).toHaveText('Writer is working');
  // Channel settings open after the choice; nothing in them is changed.
  expect(await act(page, 'channel-settings')).toEqual({ ok: true }); await choice(page, 'Open #launch settings').click();
  await expect(page.getByRole('dialog', { name: 'Channel settings' })).toBeVisible();
  await page.getByRole('dialog', { name: 'Channel settings' }).getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await calls(page, 'bot_shared_channel_update')).toEqual([]);
  expect((await calls(page, 'bot_shared_channel_stop')).length).toBe(1); expect((await calls(page, 'bot_set_paused')).length).toBe(1);
});

test('Bot conversation extension: header and channel order and hiding persist across a reload and never touch pinned controls', async ({ page }) => {
  test.setTimeout(120_000);
  await setup(page, [manifest]);
  await proposal(page, 'panda.bot.thread.controls', 'Bot settings before Pause'); await back(page);
  await proposal(page, 'panda.bot.channel.controls', 'Reassign before Continue'); await back(page);
  const region = await explorer(page);
  await hide(region, 'panda.bot.thread.controls', /^Hide Welcome suggestions/);
  await hide(region, 'panda.bot.channel.controls', /^Hide Channel settings button/);
  await expect(region.getByRole('button', { name: /^Hide Pause or resume/ })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.bot.channel.controls');
  await expect(region.getByRole('button', { name: /^Hide (Stop channel work|Continue|Show earlier messages)/ })).toHaveCount(0);
  await back(page);
  const check = async () => {
    await openBot(page, 'Ledger');
    await expect.poll(() => headerOrder(page)).toEqual(['settings', 'pause']);
    await expect(page.locator('#breadcrumb').getByRole('button', { name: 'Ledger settings', exact: true })).toBeVisible();
    await expect(transcript(page).locator('.bot-suggestions')).toBeHidden();
    await expect(transcript(page).locator('.bot-welcome-setup')).toBeVisible();
    await openChannel(page);
    await expect(channel(page).getByRole('button', { name: 'Channel settings' })).toBeHidden();
    await failPost(page);
    await expect.poll(() => rowOrder(page)).toEqual(['reassign-toggle', 'continue']);
    // The bot menu stays right after its toggle and still opens from it.
    await channelActions(page).getByRole('button', { name: /Reassign/ }).click();
    await expect(page.locator('#composer-area .bc-reassign-menu')).toBeVisible();
    expect(await channelActions(page).evaluate(row => row.querySelector('[data-shared-action="reassign-toggle"]')?.nextElementSibling?.classList.contains('bc-reassign-menu'))).toBe(true);
  };
  await check();
  await load(page);
  await check();
  // A forged overlay cannot hide Pause, Stop, Continue or Show earlier messages.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.bot.thread.controls/pause': false, 'panda.bot.channel.controls/continue': false, 'panda.bot.channel.controls/stop': false, 'panda.bot.channel.controls/earlier': false, 'panda.bot.conversation.protected/bot-identity': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(channelActions(page).getByRole('button', { name: 'Continue', exact: true })).toBeVisible();
  await openBot(page, 'Ledger');
  await expect(page.locator('#breadcrumb').getByRole('button', { name: 'Pause Ledger', exact: true })).toBeVisible();
  await expect(page.locator('#breadcrumb .bot-crumb-who')).toBeVisible();
  await noEffects(page);
});

test('Bot conversation extension: the draft, the channel and its controls survive conflict, fault, disable and safe mode with no duplicate action', async ({ page }) => {
  test.setTimeout(120_000);
  const other = structuredClone(manifest); other.id = 'other.bot-conversation'; other.permissions = ['ui.contribute', 'tasks.transcript.read', 'tasks.tools.read']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.bot-conversation/timeline' }], commands: [{ id: 'other.bot-conversation/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.bot-conversation/thread', command: 'other.bot-conversation/notes', location: 'panda.bot.thread.actions', presentation: 'button', text: 'Other notes' }] };
  await setup(page, [manifest, other]);
  // Two compatible providers: neither is selected automatically.
  await explorer(page); await expect(page.getByLabel('Transcript presentation', { exact: true })).toHaveValue(''); await back(page);
  await expect(transcript(page)).not.toHaveAttribute('data-component-provider');
  await select(page, 'other.bot-conversation/timeline');
  await openBot(page, 'Ledger');
  // Both packages contribute side by side after the breadcrumb; the header keeps its buttons.
  await expect(slots(page).first().locator('[data-extension-contribution]')).toHaveCount(2);
  await prompt(page).fill('Keep this draft'); await prompt(page).focus();
  const check = async () => {
    await expect(prompt(page)).toHaveValue('Keep this draft');
    expect(await headerOrder(page)).toEqual(['pause', 'settings']);
    await expect(crumb(page)).toContainText('Ledger');
    await noEffects(page);
  };
  await check();
  // A faulting transcript recipe falls back to the built-in transcript: captured actions stop; the slots stay.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('controlled fault'); }); });
  await expect(transcript(page)).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'bot-pause')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(contributed(page, 'thread')).toBeVisible();
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.bot-conversation'));
  await expect(slots(page).first().locator('[data-extension-contribution]')).toHaveCount(1);
  await check();
  await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(transcript(page)).toHaveAttribute('data-component-provider', PROVIDER);
  await openBot(page, 'Ledger');
  await check();
  // A captured Pause asks first; Escape declines it.
  expect(await act(page, 'bot-pause')).toEqual({ ok: true });
  await expect(choice(page, 'Pause Ledger')).toBeVisible(); await page.keyboard.press('Escape'); await expect(choice(page, 'Pause Ledger')).toHaveCount(0);
  await check();
  // The channel keeps its controls through the same lifecycle.
  await openChannel(page);
  await failPost(page);
  await page.getByRole('textbox', { name: 'Message channel' }).fill('Channel draft');
  // Safe mode restores the built-in views: no slots or arrangement, nothing captured; everything else stays.
  await page.evaluate(() => (window as any).__previewBotConversationSafeMode());
  await expect.poll(async () => (await props(page)).safeMode).toBe(true);
  expect(await act(page, 'channel-continue')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('.bot-conversation-actions, [data-layout-hidden], [data-extension-contribution^="sample.bot-conversation/"]')).toHaveCount(0);
  expect(await rowOrder(page)).toEqual(['continue', 'reassign-toggle']);
  await expect(page.getByRole('textbox', { name: 'Message channel' })).toHaveValue('Channel draft');
  // The host still continues the message: once.
  await channelActions(page).getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'bot_shared_channel_continue')).length).toBe(1);
  await openBot(page, 'Ledger');
  await expect(prompt(page)).toHaveValue('Keep this draft');
  expect(await calls(page, 'bot_set_paused')).toEqual([]);
});
