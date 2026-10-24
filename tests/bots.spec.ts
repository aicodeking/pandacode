import { expect, test, type Page } from '@playwright/test';

/* Bots: a bot's conversations are ordinary task threads (same transcript, streaming and
 * composer, with the model picker), and its settings live in a modal. */
const bots = (page: Page) => page.getByRole('dialog', { name: 'Bots' });
const panel = (page: Page, name = 'Scout') => page.getByRole('dialog', { name: `${name} settings` });
const tab = (page: Page, name: string) => panel(page).getByRole('tab', { name, exact: false });
const crumb = (page: Page) => page.locator('#breadcrumb .bot-crumb');

/** Records links opened and text copied, instead of leaving the page. */
async function captureOutside(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any; w.__opened = []; w.__copied = [];
    window.open = ((url: string) => { w.__opened.push(String(url)); return null; }) as typeof window.open;
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { w.__copied.push(text); } } });
  });
}
const opened = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__opened);
const copied = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__copied);

const sidebar = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });
const botsBar = (page: Page) => page.locator('.sidebar-bots-bar');
/** The bar at the bottom of the sidebar switches it to the Bots view. */
async function showBotsView(page: Page): Promise<void> {
  if (await botsBar(page).getAttribute('aria-pressed') !== 'true') await botsBar(page).click();
  await expect(sidebar(page)).toBeVisible();
}
/** Back to the task list from the Bots view. */
async function showTasksView(page: Page): Promise<void> {
  if (await botsBar(page).getAttribute('aria-pressed') === 'true') await botsBar(page).click();
  await expect(page.locator('#navigation')).toBeVisible();
}
async function openBots(page: Page): Promise<void> {
  await page.goto('/');
  await showBotsView(page);
  await sidebar(page).getByRole('button', { name: 'Add bot', exact: true }).click();
  await expect(bots(page)).toBeVisible();
}

/** Creates a bot from the Researcher template; it opens straight into its conversation. */
async function newBot(page: Page, name = 'Scout'): Promise<void> {
  await openBots(page);
  await bots(page).getByRole('button', { name: /Researcher/ }).click();
  await bots(page).getByRole('textbox', { name: 'Name' }).fill(name);
  await bots(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(bots(page)).toBeHidden();
  await expect(crumb(page)).toContainText(name);
}

async function openSettings(page: Page, section?: string, name = 'Scout'): Promise<void> {
  await page.locator('#breadcrumb').getByRole('button', { name: `${name} settings`, exact: true }).click();
  await expect(panel(page, name)).toBeVisible();
  if (section) await tab(page, section).click();
}

test.describe('bots', () => {
  test('the Bots bar switches the sidebar to the bots, each with its latest message', async ({ page }) => {
    await page.goto('/');
    await expect(page.locator('#navigation')).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    await newBot(page, 'Scout');
    await expect(page.locator('#navigation')).toBeHidden();
    await expect(botsBar(page)).toHaveAttribute('aria-pressed', 'true');
    const row = sidebar(page).locator('.bot-card', { hasText: 'Scout' });
    await expect(row).toHaveClass(/selected/);
    await page.locator('#prompt').fill('What is new today?');
    await page.locator('#prompt').press('Enter');
    // After the reply, the row previews it with its time.
    await expect(row.locator('.bot-card-preview')).toContainText('This is the browser preview');
    await expect(row.locator('time')).toBeVisible();
    const search = sidebar(page).getByRole('searchbox', { name: 'Search bots' });
    await search.fill('nobody');
    await expect(sidebar(page).locator('.bots-panel-empty')).toHaveText('No bots match.');
    await search.fill('sco');
    await expect(row).toBeVisible();
    await expect(search).toBeFocused();
    await expect(botsBar(page)).toContainText('1');
    // The view is remembered (preview bots live in memory, so the list starts empty); the bar switches back to tasks.
    await page.reload();
    await expect(sidebar(page)).toBeVisible();
    await botsBar(page).click();
    await expect(page.locator('#navigation')).toBeVisible();
    await expect(sidebar(page)).toBeHidden();
    await expect(botsBar(page)).toHaveAttribute('aria-pressed', 'false');
  });

  test('a new bot opens its conversation in the task view, with the bot in the header', async ({ page }) => {
    await openBots(page);
    await expect(bots(page).getByRole('heading', { name: 'New bot' })).toBeVisible();
    await expect(bots(page).getByText('No bots yet.')).toBeVisible();
    await bots(page).getByRole('button', { name: /Researcher/ }).click();
    await expect(bots(page).getByRole('textbox', { name: 'Job' })).toHaveValue('Digs into questions and reports back');
    await bots(page).getByRole('textbox', { name: 'Name' }).fill('');
    await bots(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(bots(page).getByRole('alert')).toHaveText('Give the bot a name.');
    await bots(page).getByRole('textbox', { name: 'Name' }).fill('Scout');
    await bots(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(bots(page)).toBeHidden();
    // The ordinary conversation pane, not a separate bot page.
    await expect(page.locator('.conversation-pane')).toBeVisible();
    await expect(page.locator('#bot-page')).toHaveCount(0);
    await expect(crumb(page)).toContainText('Scout');
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Ready');
    await expect(page.locator('#transcript').getByRole('heading', { name: 'Chat with Scout' })).toBeVisible();
    // The task composer, model picker included; bots own their workspace, so no project bar.
    await expect(page.locator('#prompt')).toHaveAttribute('placeholder', 'Message Scout…');
    await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toBeVisible();
    await expect(page.locator('#composer-area .composer-context')).toBeHidden();
    await expect(sidebar(page).locator('.bot-row.selected')).toContainText('Scout');
    await expect(page.locator('#navigation')).not.toContainText('Scout');
    await showTasksView(page);
    await page.getByRole('button', { name: 'Filter projects' }).click();
    await expect(page.locator('.floating-menu')).not.toContainText('Scout');
    await page.keyboard.press('Escape');
    // Another task brings back the normal header; the sidebar row returns to the bot.
    await showTasksView(page);
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await expect(crumb(page)).toHaveCount(0);
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    await expect(crumb(page)).toContainText('Scout');
  });

  test('chatting with a bot streams like any task and keeps its brief out of the transcript', async ({ page }) => {
    await newBot(page);
    await page.locator('#transcript').getByRole('button', { name: /What can you help me with/ }).click();
    await expect(page.locator('#prompt')).toHaveValue('What can you help me with?');
    await page.locator('#prompt').press('Enter');
    const sent = page.locator('#transcript .user-message').last();
    await expect(sent).toContainText('What can you help me with?');
    // The brief rides along for the agent but is the bot's setup, not an attachment: not shown.
    await expect(sent.locator('.message-context')).toHaveCount(0);
    await expect(sent.locator('.message-content')).toHaveText('What can you help me with?');
    await expect(page.locator('#transcript .agent-message').last()).toContainText('browser preview', { timeout: 15_000 });
    await expect(page.locator('#prompt')).toHaveValue('');
    // It went through the bot, so the bot logged it.
    await openSettings(page, 'Activity');
    await expect(panel(page).locator('.bots-activity')).toContainText('You (desktop): What can you help me with?');
    // Conversations and rules share the Activity section.
    await expect(panel(page).locator('.bots-items').first()).toContainText('This app');
  });

  test('the model can be changed in a bot conversation', async ({ page }) => {
    await newBot(page);
    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    await picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('bot-thread-model');
    await picker.getByRole('button', { name: 'Use "bot-thread-model" with Kimi Code', exact: true }).click();
    await expect(page.locator('#composer')).toContainText('bot-thread-model');
    // Saved on the conversation itself: it is still chosen after leaving and coming back.
    await showTasksView(page);
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await expect(page.locator('#composer')).not.toContainText('bot-thread-model');
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    await expect(page.locator('#composer')).toContainText('bot-thread-model');
    await expect(crumb(page)).toContainText('Scout');
  });

  test('GitHub Copilot is selectable in bot setup and appears in the bot chat model picker', async ({ page }) => {
    await openBots(page);
    const form = bots(page).locator('.bots-form');
    const provider = form.locator('select[name=provider]');
    await expect(provider.locator('option[value="github-copilot"]')).toHaveCount(1);
    await provider.selectOption('github-copilot');
    const model = form.locator('select[name=model]');
    await expect(model).toHaveValue('default');
    await expect(model.locator('option[value="default"]')).toHaveText('Default');
    await expect(form.locator('select[name=mode] option[value="auto"]')).toHaveCount(0);
    await expect(form.locator('select[name=mode] option')).toHaveCount(3);

    await form.getByRole('textbox', { name: 'Name' }).fill('Copilot bot');
    await bots(page).getByRole('button', { name: 'Create bot', exact: true }).click();
    await expect(bots(page)).toBeHidden();
    await expect(crumb(page)).toContainText('Copilot bot');
    await expect(page.locator('#composer .provider-logo[data-provider="github-copilot"]')).toBeVisible();

    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    const choice = picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="default"]');
    await expect(choice).toContainText('Default');
    await expect(choice).toHaveAttribute('aria-current', 'true');
  });

  test('the header pauses the bot and the welcome opens the right settings', async ({ page }) => {
    await newBot(page);
    await page.locator('#breadcrumb').getByRole('button', { name: 'Pause Scout' }).click();
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Paused');
    await expect(sidebar(page).getByRole('button', { name: 'Chat with Scout (paused)' })).toBeVisible();
    await page.locator('#breadcrumb').getByRole('button', { name: 'Resume Scout' }).click();
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Ready');
    const setup = page.getByRole('group', { name: 'Set up Scout' });
    await setup.getByRole('button', { name: 'Schedules' }).click();
    await expect(tab(page, 'Schedules')).toHaveAttribute('aria-selected', 'true');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    // The sidebar's gear opens the same settings.
    await sidebar(page).getByRole('button', { name: 'Scout settings' }).click();
    await expect(tab(page, 'Profile')).toHaveAttribute('aria-selected', 'true');
  });

  test('memories can be added and forgotten', async ({ page }) => {
    await newBot(page);
    await openSettings(page, 'Memory');
    const input = panel(page).getByRole('textbox', { name: 'New memory' });
    await input.fill('I prefer metric units');
    await panel(page).getByRole('button', { name: 'Remember' }).click();
    await expect(panel(page).getByText('I prefer metric units')).toBeVisible();
    await expect(panel(page).getByText('Added by you', { exact: false })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Forget this memory' }).click();
    await expect(panel(page).getByText('No memories yet.')).toBeVisible();
  });

  test('schedules show their timing and can be turned off, run and deleted', async ({ page }) => {
    await newBot(page);
    await openSettings(page, 'Schedules');
    await panel(page).getByRole('textbox', { name: 'What should it do?' }).fill('Summarize my notifications');
    await panel(page).getByRole('textbox', { name: 'Name' }).fill('Morning digest');
    await panel(page).getByRole('combobox', { name: 'Repeat' }).selectOption('weekdays');
    await expect(panel(page).getByLabel('Time')).toBeVisible();
    await expect(panel(page).getByLabel('Every (minutes)')).toBeHidden();
    await panel(page).getByRole('button', { name: 'Add schedule' }).click();
    const row = panel(page).locator('.bots-items li', { hasText: 'Morning digest' });
    await expect(row).toContainText('Weekdays at 09:00');
    await row.getByRole('checkbox', { name: 'Morning digest on' }).uncheck();
    await expect(row).toHaveClass(/off/);
    await row.getByRole('button', { name: 'Run Morning digest now' }).click();
    await row.getByRole('button', { name: 'Delete Morning digest' }).click();
    await expect(panel(page).getByText('No schedules yet.', { exact: false })).toBeVisible();
  });

  test('Telegram setup walks through BotFather, catches a bad token, and pairs the first sender', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Channels');
    await panel(page).getByRole('button', { name: /^Telegram/ }).click();
    const form = panel(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(3);
    await form.getByRole('button', { name: 'Open BotFather' }).click();
    await expect.poll(() => opened(page)).toEqual(['https://t.me/BotFather']);
    await form.getByRole('button', { name: 'Copy' }).first().click();
    await expect.poll(() => copied(page)).toEqual(['/newbot']);
    await form.getByLabel('Bot token').fill('123456');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('copy the whole line BotFather sent');
    await form.getByLabel('Bot token').fill('123456789:AAE1234567890abcdefghijklmnopqrstu');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.ok')).toContainText('@preview_pandacode_bot');
    await form.getByRole('button', { name: 'Connect Telegram' }).click();
    const card = panel(page).locator('.bots-channel');
    await expect(card).toContainText('@preview_pandacode_bot');
    await expect(panel(page)).not.toContainText('AAE1234567890');
    const guide = card.locator('details.bots-guide');
    await expect(guide).toHaveAttribute('open', '');
    await guide.getByRole('button', { name: 'Open @preview_pandacode_bot in Telegram' }).click();
    await expect.poll(async () => (await opened(page)).at(-1)).toBe('https://t.me/preview_pandacode_bot');
    const pending = panel(page).locator('.bots-pairing.pending');
    await expect(pending).toContainText('4821');
    await expect(tab(page, 'Channels')).toContainText('1');
    await pending.getByRole('button', { name: 'Approve' }).click();
    await expect(panel(page).locator('.bots-pairing')).toContainText('approved');
    await expect(card.locator('details.bots-guide')).not.toHaveAttribute('open', '');
    await panel(page).getByRole('button', { name: 'Remove Telegram' }).click();
    await panel(page).getByRole('alertdialog', { name: 'Remove this channel?' }).getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(panel(page).locator('.bots-channel')).toHaveCount(0);
  });

  test('Slack setup creates the app from a prefilled manifest and spots swapped tokens', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Channels');
    await panel(page).getByRole('button', { name: /^Slack/ }).click();
    const form = panel(page).locator('.bots-connect');
    await form.getByRole('button', { name: 'Create Slack app' }).click();
    await expect.poll(async () => (await opened(page)).length).toBe(1);
    const url = new URL((await opened(page))[0]);
    expect(url.origin + url.pathname).toBe('https://api.slack.com/apps');
    const manifest = JSON.parse(url.searchParams.get('manifest_json')!);
    expect(manifest.display_information.name).toBe('Scout');
    expect(manifest.settings.socket_mode_enabled).toBe(true);
    expect(manifest.settings.event_subscriptions.bot_events).toEqual(['app_mention', 'message.im']);
    expect(manifest.oauth_config.scopes.bot).toEqual(expect.arrayContaining(['chat:write', 'app_mentions:read', 'im:history', 'users:read']));
    await form.getByRole('button', { name: 'Copy manifest instead' }).click();
    await expect.poll(async () => (await copied(page)).length).toBe(1);
    expect(JSON.parse((await copied(page))[0])).toEqual(manifest);
    await form.getByLabel('Bot token').fill('xapp-1-A');
    await form.getByLabel('App-level token').fill('xoxb-1-B');
    await form.getByRole('button', { name: 'Connect Slack' }).click();
    await expect(panel(page).getByRole('alert').first()).toContainText('swapped');
    // Typed values survive the panel re-rendering.
    await tab(page, 'Memory').click();
    await tab(page, 'Channels').click();
    await expect(form.getByLabel('Bot token')).toHaveValue('xapp-1-A');
    await form.getByLabel('Bot token').fill('xoxb-1-B');
    await form.getByLabel('App-level token').fill('xapp-1-A');
    await form.getByRole('button', { name: 'Connect Slack' }).click();
    await expect(panel(page).locator('.bots-channel')).toContainText('@scout in Preview Workspace');
    await expect(panel(page).locator('.bots-guide')).toContainText('/invite');
  });

  test('Discord setup offers the server invite and warns when Message Content is off', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Channels');
    await panel(page).getByRole('button', { name: /^Discord/ }).click();
    const form = panel(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(4);
    await form.getByLabel('Bot token').fill('client-secret-by-mistake');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('Client Secret');
    await form.getByLabel('Bot token').fill(`${'M'.repeat(24)}.${'G'.repeat(6)}.${'x'.repeat(38)}`);
    await form.getByRole('button', { name: 'Connect Discord' }).click();
    const card = panel(page).locator('.bots-channel');
    await expect(card.locator('.bots-warning')).toContainText('Message Content intent is off');
    await card.getByRole('button', { name: 'Add to a server' }).click();
    await expect.poll(async () => (await opened(page)).at(-1) ?? '').toContain('discord.com/oauth2/authorize?client_id=1234567890&scope=bot');
  });

  test('WhatsApp setup ends with copyable webhook details built from the tunnel address', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Channels');
    await panel(page).getByRole('button', { name: /^WhatsApp/ }).click();
    const form = panel(page).locator('.bots-connect');
    await expect(form.locator('.bots-steps > li')).toHaveCount(5);
    await form.getByLabel('Phone number ID').fill('+351 912 345 678');
    await form.getByLabel('Access token').fill('EAAG-preview');
    await form.getByLabel('App secret').fill('preview-secret');
    await form.getByRole('button', { name: 'Test' }).click();
    await expect(form.locator('.bots-check.fail')).toContainText('not the phone number itself');
    await form.getByLabel('Phone number ID').fill('123456789012345');
    await form.getByRole('button', { name: 'Connect WhatsApp' }).click();
    const guide = panel(page).locator('.bots-channel .bots-guide');
    await expect(guide).toContainText('cloudflared tunnel --url http://127.0.0.1:47321');
    await expect(guide).toContainText('the callback URL appears here after you save the address');
    await expect(guide).toContainText('pandacode-preview0123456789');
    await guide.getByPlaceholder('https://….trycloudflare.com').fill('http://not-secure.example');
    await guide.getByRole('button', { name: 'Save' }).click();
    await expect(panel(page).getByRole('alert').first()).toContainText('https://');
    await guide.getByPlaceholder('https://….trycloudflare.com').fill('https://quiet-river.trycloudflare.com/');
    await guide.getByRole('button', { name: 'Save' }).click();
    const callback = guide.locator('code', { hasText: '/whatsapp/' });
    await expect(callback).toHaveText(/^https:\/\/quiet-river\.trycloudflare\.com\/whatsapp\/[0-9a-f-]{36}$/);
  });

  test('web chat is one click, and phone access builds a private phone link', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Channels');
    await panel(page).getByRole('button', { name: /^Web chat/ }).click();
    await panel(page).getByRole('button', { name: 'Turn on web chat' }).click();
    const card = panel(page).locator('.bots-channel');
    await expect(card).toContainText('Ready on this computer');
    await card.getByText('How to use').click();
    await card.getByRole('button', { name: 'Open web chat' }).click();
    await expect.poll(async () => (await opened(page)).at(-1) ?? '').toMatch(/^http:\/\/127\.0\.0\.1:47321\/chat\/[0-9a-f-]{36}#preview-token$/);
    await card.getByRole('checkbox', { name: /Use from my phone/ }).check();
    await expect(card).toContainText('tailscale serve --bg 47321');
    await card.getByPlaceholder('https://your-mac.tailnet.ts.net').fill('https://my-mac.tailnet.ts.net');
    await card.getByRole('button', { name: 'Save' }).click();
    await card.getByRole('button', { name: 'Copy link for my phone' }).click();
    await expect.poll(async () => (await copied(page)).at(-1)).toMatch(/^https:\/\/my-mac\.tailnet\.ts\.net\/chat\/[0-9a-f-]{36}#preview-token$/);
    await card.getByRole('button', { name: 'New link' }).click();
    await panel(page).getByRole('alertdialog', { name: 'Create a new web chat link?' }).getByRole('button', { name: 'New link' }).click();
    await expect(page.locator('#toast')).toHaveText('New link copied');
    await expect(tab(page, 'Channels')).toContainText('1');
    await tab(page, 'Activity').click();
    await expect(panel(page).getByRole('button', { name: 'Open web chat' })).toBeVisible();
  });

  test('rules validate patterns and list allow, ask and deny', async ({ page }) => {
    await newBot(page);
    await openSettings(page, 'Activity');
    await panel(page).getByRole('textbox', { name: 'Pattern' }).fill('*');
    await panel(page).getByRole('button', { name: 'Add rule' }).click();
    await expect(panel(page).getByRole('alert')).toContainText('at least two characters');
    await panel(page).getByRole('textbox', { name: 'Pattern' }).fill('git push*');
    await panel(page).getByRole('combobox', { name: 'Decision' }).selectOption('deny');
    await panel(page).getByRole('button', { name: 'Add rule' }).click();
    await expect(panel(page).locator('.bots-chip.deny')).toBeVisible();
    await panel(page).getByRole('button', { name: 'Delete rule git push*' }).click();
    await expect(panel(page).getByText('No rules.', { exact: false })).toBeVisible();
  });

  test('settings: pause, profile, activity, reset and delete in the modal', async ({ page }) => {
    await newBot(page);
    await openSettings(page);
    await panel(page).getByRole('button', { name: 'Pause' }).click();
    await expect(panel(page).getByText('Paused. Schedules', { exact: false })).toBeVisible();
    await panel(page).getByRole('button', { name: 'Resume' }).click();
    await expect(panel(page).locator('.bots-banner')).toHaveCount(0);
    await expect(tab(page, 'Profile')).toHaveAttribute('aria-selected', 'true');
    // Sections are a vertical list, like Settings, and arrow keys move through it.
    await expect(panel(page).getByRole('tablist', { name: 'Bot settings' })).toHaveAttribute('aria-orientation', 'vertical');
    await expect(panel(page).getByRole('tab')).toHaveText([/^Profile/, /^Channels/, /^Schedules/, /^Memory/, /^Activity/]);
    await tab(page, 'Profile').focus();
    await page.keyboard.press('ArrowDown');
    await expect(tab(page, 'Channels')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Channels')).toBeFocused();
    await expect(panel(page).getByRole('tabpanel').getByRole('heading', { name: 'Channels', level: 2 })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(tab(page, 'Profile')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await panel(page).getByRole('textbox', { name: 'Job' }).fill('Finds answers');
    await panel(page).getByRole('button', { name: 'Save' }).click();
    await expect(panel(page).locator('.bp-meta')).toContainText('Finds answers');
    await tab(page, 'Activity').click();
    await expect(panel(page).locator('.bots-activity')).toContainText('Settings changed');
    await expect(panel(page).locator('.bots-activity')).toContainText('Created Scout');
    // Destructive actions wait one level down, in More.
    await expect(panel(page).getByRole('button', { name: 'Delete bot' })).toHaveCount(0);
    await panel(page).getByRole('button', { name: 'More', exact: true }).click();
    await panel(page).getByRole('menuitem', { name: 'Reset bot' }).click();
    await panel(page).getByRole('alertdialog', { name: 'Reset Scout?' }).getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(panel(page).locator('.bots-activity')).toContainText('Reset');
    await panel(page).getByRole('button', { name: 'More', exact: true }).click();
    await panel(page).getByRole('menuitem', { name: 'Delete bot' }).click();
    await panel(page).getByRole('alertdialog', { name: 'Delete Scout?' }).getByRole('button', { name: 'Delete', exact: true }).click();
    await expect(panel(page)).toBeHidden();
    await expect(sidebar(page).getByRole('button', { name: 'Add a bot' })).toBeVisible();
    await expect(crumb(page)).toHaveCount(0);
  });

  test('Open chat in settings returns to the conversation', async ({ page }) => {
    await newBot(page);
    await showTasksView(page);
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await showBotsView(page);
    await sidebar(page).getByRole('button', { name: 'Scout settings' }).click();
    await panel(page).getByRole('button', { name: 'Open chat' }).click();
    await expect(panel(page)).toBeHidden();
    await expect(crumb(page)).toContainText('Scout');
  });

  test('bots are reachable from Go to anything', async ({ page }) => {
    await page.goto('/');
    await page.locator('.search-trigger').click();
    await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill('bots');
    await page.locator('#command-results').getByRole('button', { name: 'Bots' }).click();
    await expect(bots(page)).toBeVisible();
  });
});
