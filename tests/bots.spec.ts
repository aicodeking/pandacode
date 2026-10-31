import { expect, test, type Page } from '@playwright/test';

/* Bots: a bot's conversations are ordinary task threads (same transcript, streaming and
 * composer, with the model picker), and its settings live in a modal. */
const bots = (page: Page) => page.getByRole('dialog', { name: /^(Bots|New bot)$/ });
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
  await sidebar(page).getByRole('button', { name: 'Add bot or channel' }).click();
  await sidebar(page).getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New bot' }).click();
  await expect(bots(page)).toBeVisible();
}

/** Creates a bot with only a name; it opens to the bot-specific welcome. */
async function newBot(page: Page, name = 'Scout'): Promise<void> {
  await openBots(page);
  await bots(page).getByRole('textbox', { name: 'Name' }).fill(name);
  await bots(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(bots(page)).toBeHidden();
  await expect(crumb(page)).toContainText(name);
  await expect(page.locator('#transcript .bot-welcome h1')).toHaveText(`${name} is ready.`);
  await expect(page.locator('#transcript .user-message, #transcript .agent-message')).toHaveCount(0);
  await expect(page.locator('#composer .stop-button')).toHaveCount(0);
}

async function openSettings(page: Page, section?: string, name = 'Scout'): Promise<void> {
  await page.locator('#breadcrumb').getByRole('button', { name: `${name} settings`, exact: true }).click();
  await expect(panel(page, name)).toBeVisible();
  if (section) await tab(page, section).click();
}

test.describe('bots', () => {
  test('a new bot keeps its draft and caret through background refreshes', async ({ page }) => {
    await openBots(page);
    const form = bots(page).getByRole('form', { name: 'New bot' });
    const name = form.getByRole('textbox', { name: 'Name' });
    const purpose = form.getByRole('textbox', { name: 'What should this bot help with?' });
    await name.fill('kittisaurus');
    await form.getByRole('button', { name: 'Blue', exact: true }).click();
    await purpose.fill('Custom instructions\nwith two lines.');
    const draft = await form.evaluate(form => Object.fromEntries(new FormData(form as HTMLFormElement)));
    await purpose.focus();
    await purpose.evaluate(field => (field as HTMLTextAreaElement).setSelectionRange(5, 11));
    // Preview bot changes emit the same bots-changed event as the native scheduler.
    const call = (command: string, args: Record<string, unknown>) => page.evaluate(async ([command, args]) => {
      const module = '/src/bridge.ts';
      return (await import(module)).call(command, args);
    }, [command, args] as const);
    const background = await call('bot_create', { input: { name: 'Background bot', role: '', instructions: '', goals: '', avatar: 'panda:0', provider: 'claude', model: 'default', mode: 'ask', heartbeatMinutes: 0 } }) as { id: string };
    const row = page.getByRole('button', { name: 'Chat with Background bot', exact: true });
    await expect(row).toBeVisible();
    expect(await form.evaluate(form => Object.fromEntries(new FormData(form as HTMLFormElement)))).toEqual(draft);
    await expect(purpose).toBeFocused();
    expect(await purpose.evaluate(field => [(field as HTMLTextAreaElement).selectionStart, (field as HTMLTextAreaElement).selectionEnd])).toEqual([5, 11]);
    await call('bot_delete', { botId: background.id });
    await expect(row).toHaveCount(0);
    expect(await form.evaluate(form => Object.fromEntries(new FormData(form as HTMLFormElement)))).toEqual(draft);
  });

  test('a new bot keeps its draft when creation fails and can be retried', async ({ page }) => {
    await page.route('**/src/preview-bots.ts*', async route => {
      const response = await route.fetch(); const source = await response.text();
      const marker = /switch\s*\(command\)\s*\{/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, `if (command === 'bot_create' && !window.__allowBotCreate) throw new Error('Bot could not be created.');\nswitch (command) {`) });
    });
    await openBots(page);
    const form = bots(page).getByRole('form', { name: 'New bot' });
    await form.getByRole('textbox', { name: 'Name' }).fill('Retry bot');
    await form.getByRole('textbox', { name: 'What should this bot help with?' }).fill('Keep these instructions');
    await form.getByRole('button', { name: 'Create bot', exact: true }).click();
    await expect(bots(page).getByRole('alert')).toHaveText('Bot could not be created.');
    await expect(form.getByRole('textbox', { name: 'Name' })).toHaveValue('Retry bot');
    await expect(form.getByRole('textbox', { name: 'What should this bot help with?' })).toHaveValue('Keep these instructions');
    await page.evaluate(() => { (window as any).__allowBotCreate = true; });
    await form.getByRole('button', { name: 'Create bot', exact: true }).click();
    await expect(bots(page)).toBeHidden();
    await expect(crumb(page)).toContainText('Retry bot');
  });

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
    await expect(sidebar(page).locator('.bots-panel-empty')).toHaveText('No bots or channels match.');
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
    const form = bots(page).getByRole('form', { name: 'New bot' });
    await expect(form).toBeVisible();
    await bots(page).getByRole('region', { name: 'Suggestions' }).getByRole('button', { name: /Researcher/ }).click();
    await expect(form.getByRole('textbox', { name: 'What should this bot help with?' })).toHaveValue(/^Research the questions/);
    await form.getByRole('textbox', { name: 'Name' }).fill('');
    await bots(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(form.locator('#bc-name-error')).toHaveText('Give the bot a name.');
    await form.getByRole('textbox', { name: 'Name' }).fill('Scout');
    await bots(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(bots(page)).toBeHidden();
    // The ordinary conversation pane, not a separate bot page.
    await expect(page.locator('.conversation-pane')).toBeVisible();
    await expect(page.locator('#bot-page')).toHaveCount(0);
    await expect(crumb(page)).toContainText('Scout');
    // The brief stays in profile instructions; the new thread starts with bot-specific welcome.
    await expect(page.locator('#transcript .bot-welcome h1')).toHaveText('Scout is ready.');
    await expect(page.locator('#transcript .user-message, #transcript .agent-message')).toHaveCount(0);
    await expect(page.locator('#transcript')).not.toContainText('What would you like to do?');
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Ready');
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
    await showBotsView(page);
    await sidebar(page).getByRole('button', { name: 'Chat with Scout' }).click();
    await expect(crumb(page)).toContainText('Scout');
  });

  test('a bot references its own skills and MCP servers, and a project task can start with it', async ({ page }) => {
    await newBot(page, 'Scout');
    await openSettings(page, 'Skills');
    const skill = panel(page).getByRole('checkbox', { name: 'Use Release notes' });
    await expect(skill).not.toBeChecked();
    await skill.check();
    await expect(panel(page).locator('.bots-skills')).toContainText('Files in the bot\'s workspace');
    const mcp = panel(page).getByRole('checkbox', { name: 'Use MCP server Preview documentation' });
    await mcp.check();
    await expect(panel(page).locator('.bots-mcp')).toContainText('From User config');
    await page.keyboard.press('Escape');
    await expect(panel(page)).toBeHidden();
    // A second bot on the same harness keeps its own, empty selection (same page: preview bots live in memory).
    await showBotsView(page);
    await sidebar(page).getByRole('button', { name: 'Add bot or channel' }).click();
    await sidebar(page).getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New bot' }).click();
    await bots(page).getByRole('region', { name: 'Suggestions' }).getByRole('button', { name: /Researcher/ }).click();
    await bots(page).getByRole('textbox', { name: 'Name' }).fill('Writer');
    await bots(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(crumb(page)).toContainText('Writer');
    await openSettings(page, undefined, 'Writer');
    await panel(page, 'Writer').getByRole('tab', { name: 'Skills' }).click();
    await expect(panel(page, 'Writer').getByRole('checkbox', { name: 'Use Release notes' })).not.toBeChecked();
    await expect(panel(page, 'Writer').getByRole('checkbox', { name: 'Use MCP server Preview documentation' })).not.toBeChecked();
    await page.keyboard.press('Escape');

    // A new project task offers the bots, defaulting to none.
    await showTasksView(page);
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await page.locator('.new-task-button').click();
    const chip = page.locator('#composer-bot');
    await expect(chip).toHaveText(/No bot/);
    await chip.click();
    await page.getByRole('menu', { name: 'Bot' }).getByRole('menuitemradio', { name: /Scout/ }).click();
    await expect(chip).toHaveText(/Scout/);
    const taskId = await page.locator('#prompt').getAttribute('data-session-id');
    await page.locator('#prompt').fill('Write the release notes');
    await page.locator('#prompt').press('Enter');
    await expect(page.locator('#transcript .user-message').last().locator('.message-content')).toHaveText('Write the release notes');
    // The task stays in its project, now marked with its bot; its first message carried the bot's brief and skills.
    await expect(page.locator('.composer-computer-fixed', { hasText: 'with Scout' })).toBeVisible();
    await expect(crumb(page)).toHaveCount(0);
    const briefs = await page.evaluate(() => (window as any).__botTaskBriefs);
    expect(briefs).toHaveLength(1);
    expect(briefs[0].sessionId).toBe(taskId);
    expect(briefs[0].brief).toContain('You are Scout');
    expect(briefs[0].brief).toContain('### release-notes');
    expect(briefs[0].brief).toContain('MCP servers chosen for this bot: Preview documentation');
    await expect(page.locator('#transcript .agent-message').last()).toContainText('browser preview', { timeout: 15_000 });
    // A follow-up does not repeat the brief, and a task without a bot gets none.
    await page.locator('#prompt').fill('Thanks');
    await page.locator('#prompt').press('Enter');
    await page.locator('.new-task-button').click();
    await expect(page.locator('#composer-bot')).toHaveText(/No bot/);
    await page.locator('#prompt').fill('Plain task');
    await page.locator('#prompt').press('Enter');
    await expect(page.locator('#transcript .user-message').last()).toContainText('Plain task');
    expect(await page.evaluate(() => (window as any).__botTaskBriefs.filter((item: any) => item.brief).length)).toBe(1);
  });

  test('chatting with a bot streams like any task and keeps its brief out of the transcript', async ({ page }) => {
    await newBot(page);
    await page.locator('#prompt').fill('What can you help me with?');
    await page.locator('#prompt').press('Enter');
    const sent = page.locator('#transcript .user-message').last();
    await expect(sent).toContainText('What can you help me with?');
    // The brief rides along for the agent but is the bot's setup, not an attachment: not shown.
    await expect(sent.locator('.message-attachments')).toHaveCount(0);
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
    await picker.getByRole('tab', { name: 'Kimi Code' }).click();
    await picker.getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill('bot-thread-model');
    await picker.getByRole('option', { name: 'Use "bot-thread-model" with Kimi Code', exact: true }).click();
    await expect(page.locator('#composer')).toContainText('bot-thread-model');
    // Saved on the conversation itself: it is still chosen after leaving and coming back.
    await showTasksView(page);
    await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
    await expect(page.locator('#composer')).not.toContainText('bot-thread-model');
    await showBotsView(page);
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
    await form.getByRole('textbox', { name: 'Name' }).fill('Copilot bot');
    await bots(page).getByRole('button', { name: 'Create bot', exact: true }).click();
    await expect(bots(page)).toBeHidden();
    await expect(crumb(page)).toContainText('Copilot bot');
    await expect(page.locator('#transcript .bot-welcome h1')).toHaveText('Copilot bot is ready.');
    await expect(page.locator('#transcript .user-message, #transcript .agent-message')).toHaveCount(0);
    await expect(page.locator('#composer .stop-button')).toHaveCount(0);
    // Copilot has no workspace-only rule, so it offers Ask first and Full access.
    await openSettings(page, undefined, 'Copilot bot');
    const rules = panel(page, 'Copilot bot').getByRole('radiogroup', { name: 'Rules' });
    await expect(rules.getByRole('radio')).toHaveCount(2);
    await expect(rules.getByRole('radio', { name: 'Workspace only' })).toHaveCount(0);
    await expect(rules.getByRole('radio', { name: 'Ask first' })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
    await expect(panel(page, 'Copilot bot')).toBeHidden();
    await expect(page.locator('#composer .provider-logo[data-provider="github-copilot"]')).toBeVisible();

    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    const choice = picker.locator('.model-menu-option[data-provider="github-copilot"][data-model="default"]');
    await expect(choice).toContainText('Default');
    await expect(choice).toHaveAttribute('aria-current', 'true');
  });

  test('the header pauses the bot and opens the right settings', async ({ page }) => {
    await newBot(page);
    await page.locator('#breadcrumb').getByRole('button', { name: 'Pause Scout' }).click();
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Paused');
    await expect(sidebar(page).getByRole('button', { name: 'Chat with Scout (paused)' })).toBeVisible();
    await page.locator('#breadcrumb').getByRole('button', { name: 'Resume Scout' }).click();
    await expect(crumb(page).locator('.bot-crumb-state')).toHaveText('Ready');
    await openSettings(page, 'Schedules');
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
    await openSettings(page, 'Connections');
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
    await expect(tab(page, 'Connections')).toContainText('1');
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
    await openSettings(page, 'Connections');
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
    await tab(page, 'Connections').click();
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
    await openSettings(page, 'Connections');
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
    await openSettings(page, 'Connections');
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
    const address = guide.getByPlaceholder('https://….trycloudflare.com');
    await address.fill('');
    await address.fill('https://quiet-river.trycloudflare.com/');
    await expect(address).toHaveValue('https://quiet-river.trycloudflare.com/');
    await guide.getByRole('button', { name: 'Save' }).click();
    const callback = guide.locator('code', { hasText: '/whatsapp/' });
    await expect(callback).toHaveText(/^https:\/\/quiet-river\.trycloudflare\.com\/whatsapp\/[0-9a-f-]{36}$/);
  });

  test('web chat is one click, and phone access builds a private phone link', async ({ page }) => {
    await captureOutside(page);
    await newBot(page);
    await openSettings(page, 'Connections');
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
    await expect(tab(page, 'Connections')).toContainText('1');
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
    await expect(panel(page).getByRole('tab')).toHaveText([/^Profile/, /^Connections/, /^Schedules/, /^Memory/, /^Skills/, /^Activity/]);
    await tab(page, 'Profile').focus();
    await page.keyboard.press('ArrowDown');
    await expect(tab(page, 'Connections')).toHaveAttribute('aria-selected', 'true');
    await expect(tab(page, 'Connections')).toBeFocused();
    await expect(panel(page).getByRole('tabpanel').getByRole('heading', { name: 'Connections', level: 2 })).toBeVisible();
    await page.keyboard.press('Home');
    await expect(tab(page, 'Profile')).toHaveAttribute('aria-selected', 'true');
    await expect(panel(page).getByRole('button', { name: 'Cancel' })).toHaveCount(0);
    await panel(page).getByRole('textbox', { name: 'Title' }).fill('Finds answers');
    await expect(panel(page).locator('.bs-saved')).toHaveText('Saved');
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
    await expect(sidebar(page).getByRole('button', { name: 'Create your first bot' })).toBeVisible();
    await expect(crumb(page)).toHaveCount(0);
  });

  test('a soul.md is copied into the profile apart from the instructions, and can be removed', async ({ page }) => {
    await newBot(page, 'Leo');
    await openSettings(page, undefined, 'Leo');
    const settings = panel(page, 'Leo');
    const file = settings.locator('input[data-soul-file]');
    const soul = settings.getByRole('textbox', { name: 'Soul' });
    await expect(soul).toHaveValue('');
    await file.setInputFiles({ name: 'soul.md', mimeType: 'text/markdown', buffer: Buffer.from([0xff, 0xfe, 0x00]) });
    await expect(settings.locator('.bots-soul-error')).toHaveText('soul.md is not UTF-8 text. Save it as UTF-8 Markdown and try again.');
    await file.setInputFiles({ name: 'soul.md', mimeType: 'text/markdown', buffer: Buffer.alloc(64 * 1024 + 1, 'a') });
    await expect(settings.locator('.bots-soul-error')).toHaveText('soul.md is larger than 64 KB. Shorten it and try again.');
    await expect(soul).toHaveValue('');
    await file.setInputFiles({ name: 'soul.md', mimeType: 'text/markdown', buffer: Buffer.from('# Leo\nDry wit, blunt under pressure.') });
    await expect(soul).toHaveValue('# Leo\nDry wit, blunt under pressure.');
    await expect(settings.locator('.bots-soul-error')).toBeHidden();
    await expect(settings.getByRole('textbox', { name: 'Instructions' })).not.toHaveValue(/Dry wit/);
    // The profile saves as you go, so the soul is kept after closing.
    await expect(settings.locator('.bs-saved')).toHaveText('Saved');
    await page.keyboard.press('Escape');
    await openSettings(page, undefined, 'Leo');
    await expect(soul).toHaveValue('# Leo\nDry wit, blunt under pressure.');
    await settings.getByRole('button', { name: 'Remove', exact: true }).click();
    await expect(soul).toHaveValue('');
    await expect(settings.getByRole('button', { name: 'Remove', exact: true })).toBeHidden();
    await expect(settings.locator('.bs-saved')).toHaveText('Saved');
    await page.keyboard.press('Escape');
    await openSettings(page, undefined, 'Leo');
    await expect(soul).toHaveValue('');
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

  test('the sidebar marks each bot\'s state: waiting first, then working and usage limits; paused bots fold under Hidden', async ({ page }) => {
    await page.goto('/?bots=sample');
    await showBotsView(page);
    const row = (name: string) => sidebar(page).locator('.bot-card', { hasText: name });
    const needs = sidebar(page).getByRole('group', { name: 'Needs you' });
    await expect(needs.locator('.bot-card')).toHaveCount(1);
    await expect(needs).toContainText('Scout');
    await expect(row('Scout').locator('.bot-badge.waiting')).toHaveAttribute('aria-label', 'Needs approval');
    await expect(row('Scout').locator('.bot-chip.waiting')).toHaveText('Review');
    await expect(row('Writer').locator('.bot-badge.working i')).toHaveCount(3);
    await expect(row('Ledger').locator('.bot-badge.limited')).toHaveAttribute('aria-label', /^Usage limit · Resets /);
    await expect(row('Ledger').locator('.bot-chip.limited')).toHaveAttribute('title', /^Usage limit · Resets /);
    await expect(row('Ledger').locator('.bot-chip.limited')).not.toContainText('Resets');
    await expect(row('Ledger').locator('.bot-chip.limited svg')).toHaveCount(1);
    await expect(row('Research').locator('.bot-role-tag')).toHaveCount(0);
    await expect(row('Research').locator('.bot-card-preview')).toContainText('Research');
    // Paused bots are hidden until the group is opened, and look asleep.
    const hidden = sidebar(page).getByRole('button', { name: 'Hidden (1)' });
    await expect(hidden).toHaveAttribute('aria-expanded', 'false');
    await expect(row('Dozy')).toHaveCount(0);
    await hidden.click();
    await expect(row('Dozy')).toHaveClass(/paused/);
    await expect(row('Dozy').locator('.bot-card-preview')).toContainText('Paused since');
  });

  test('right-click pins, hides, restores, duplicates and deletes a bot', async ({ page }) => {
    await page.goto('/?bots=sample');
    await showBotsView(page);
    const row = (name: string) => sidebar(page).locator('.bot-card', { hasText: name });
    const menu = (name: string) => page.getByRole('dialog', { name: `${name} actions` });
    await row('Writer').click();
    await expect(page.locator('#breadcrumb .bot-crumb')).toContainText('Writer');
    await expect(page.locator('#transcript .history-notice')).toHaveCount(0);
    await row('Writer').click({ button: 'right' });
    await menu('Writer').getByRole('menuitem', { name: 'Pin' }).click();
    await expect(sidebar(page).getByRole('group', { name: 'Pinned' })).toContainText('Writer');
    // Pins are this device's view of the list (preview bots get new ids on reload, so check the store).
    const writerId = await row('Writer').getAttribute('data-bot-row');
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.botsPinned') ?? '[]'))).toEqual([writerId]);
    await row('Writer').click({ button: 'right' });
    await menu('Writer').getByRole('menuitem', { name: 'Unpin' }).click();
    await expect(sidebar(page).getByRole('group', { name: 'Pinned' })).toHaveCount(0);
    // Hide pauses the bot; Restore brings it back.
    await row('Writer').click({ button: 'right' });
    await menu('Writer').getByRole('menuitem', { name: 'Hide (pause)' }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Hidden (2)' })).toBeVisible();
    await sidebar(page).getByRole('button', { name: 'Hidden (2)' }).click();
    await row('Writer').click({ button: 'right' });
    await menu('Writer').getByRole('menuitem', { name: 'Restore' }).click();
    await expect(sidebar(page).getByRole('button', { name: 'Hidden (1)' })).toBeVisible();
    await row('Ledger').click({ button: 'right' });
    await menu('Ledger').getByRole('menuitem', { name: 'Duplicate bot' }).click();
    await expect(row('Ledger copy')).toBeVisible();
    await row('Ledger copy').click({ button: 'right' });
    await menu('Ledger copy').getByRole('menuitem', { name: 'Edit bot' }).click();
    const duplicate = panel(page, 'Ledger copy');
    await expect(duplicate.locator('input[name="color"]')).toHaveValue('#14b8a6');
    await expect(duplicate.locator('select[name="reasoningEffort"]')).toHaveValue('high');
    await expect(duplicate.locator('input[name="backupModels"]')).toHaveValue('[{"provider":"codex","model":"gpt-5"}]');
    await expect(duplicate.getByLabel('Switching to a backup')).toHaveValue('auto');
    await expect(duplicate.getByLabel('Notifications')).not.toBeChecked();
    await expect(duplicate.getByLabel('While working')).toHaveValue('steer');
    await expect(duplicate.getByLabel('Show the plan before long tasks')).toBeChecked();
    await page.keyboard.press('Escape');
    await expect(duplicate).toBeHidden();
    await row('Ledger copy').click({ button: 'right' });
    await menu('Ledger copy').getByRole('menuitem', { name: 'Delete bot…' }).click();
    await page.getByRole('dialog', { name: 'Delete Ledger copy?' }).getByRole('button', { name: 'Delete bot' }).click();
    await expect(row('Ledger copy')).toHaveCount(0);
    await row('Ledger').click({ button: 'right' });
    await menu('Ledger').getByRole('menuitem', { name: 'Edit bot' }).click();
    await expect(panel(page, 'Ledger')).toBeVisible();
  });

  test('rows drag to reorder, and the order is saved', async ({ page }) => {
    await page.goto('/?bots=sample');
    await showBotsView(page);
    const names = () => sidebar(page).getByRole('group', { name: 'Other bots' }).locator('.bot-row-name').allTextContents();
    await expect.poll(names).toHaveLength(2);
    const [first, second] = await names();
    await sidebar(page).locator('.bot-card', { hasText: second }).dragTo(sidebar(page).locator('.bot-card', { hasText: first }));
    await expect.poll(names).toEqual([second, first]);
    const ids = await sidebar(page).locator('[data-bot-row]').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.botRow));
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.botsOrder') ?? '[]'))).toEqual(ids);
  });

  test('loading shows skeleton rows, then the empty state offers to create a bot', async ({ page }) => {
    await page.goto('/?botsDelay=4000', { waitUntil: 'commit' });
    await showBotsView(page);
    await expect(sidebar(page).getByRole('status', { name: 'Loading bots' })).toBeVisible();
    await expect(sidebar(page).locator('.bot-row-skeleton')).toHaveCount(3);
    await expect(sidebar(page).getByText('No bots yet')).toBeVisible({ timeout: 10_000 });
    await expect(sidebar(page).locator('.bot-row-skeleton')).toHaveCount(0);
    await sidebar(page).getByRole('button', { name: 'Create your first bot or channel' }).click();
    await sidebar(page).getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New bot' }).click();
    await expect(bots(page)).toBeVisible();
  });
});
