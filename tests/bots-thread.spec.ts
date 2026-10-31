import { expect, test, type Page } from '@playwright/test';

/* A bot's conversation (src/bot-thread.ts): chat bubbles, hover actions (copy, reply, react),
 * the working indicator, a steps row per finished turn and the empty state. */
const sidebar = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });
const transcript = (page: Page) => page.locator('#transcript');

async function showBotsView(page: Page): Promise<void> {
  const bar = page.locator('.sidebar-bots-bar');
  if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
  await expect(sidebar(page)).toBeVisible();
}
/** Sample bots: Writer is working, Ledger is idle with an empty conversation. */
async function openSample(page: Page, name: string): Promise<void> {
  await page.goto('/?bots=sample');
  await showBotsView(page);
  await sidebar(page).getByRole('button', { name: new RegExp(`^Chat with ${name}`) }).click();
  await expect(page.locator('#breadcrumb .bot-crumb')).toContainText(name);
  const limit = page.getByRole('region', { name: 'Usage limit' });
  if (await limit.isVisible()) {
    await limit.getByRole('button', { name: 'Dismiss usage limit' }).click();
    await expect(limit).toHaveCount(0);
  }
}
/** Ledger (a sample bot) answers one message; the preview's turn runs one tool, then replies. */
async function chattedBot(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any; w.__copied = [];
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { w.__copied.push(text); } } });
  });
  await openSample(page, 'Ledger');
  await page.locator('#prompt').fill('How did we do this month?');
  await page.locator('#prompt').press('Enter');
  await expect(transcript(page).locator('.agent-message').last()).toContainText('browser preview', { timeout: 15_000 });
  await expect(page.locator('#composer .stop-button')).toHaveCount(0);
}

async function installFailoverPreview(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const key = 'pandacode.test.botFailoverFixture';
    const stored = sessionStorage.getItem(key);
    (window as any).__botFailoverFixture = stored ? JSON.parse(stored) : { botId: '', calls: [] };
    (window as any).__botMessageFixture = { markers: [] };
    (window as any).__persistBotFailoverFixture = () => sessionStorage.setItem(key, JSON.stringify((window as any).__botFailoverFixture));
  });
  await page.route('**/src/preview.ts', async route => {
    const response = await route.fetch();
    const body = await response.text();
    await route.fulfill({ response, body: `${body}\nwindow.__botEmit = emit; window.__botHasListener = name => Boolean(listeners.get(name)?.size);` });
  });
  await page.route('**/src/preview-bots.ts', async route => {
    const response = await route.fetch();
    let body = await response.text();
    const replaceCase = (source: RegExp, replacement: string | ((match: string) => string)) => {
      if (!source.test(body)) throw new Error(`Preview bot fixture changed: ${source}`);
      body = body.replace(source, replacement);
    };
    replaceCase(/case ["']bot_failover_pending["']:[\s\S]*?break;/, `case "bot_failover_pending": {
      const fixture = window.__botFailoverFixture;
      result = fixture?.ask ? { ...fixture.ask, botId: fixture.botId, sessionId: args.sessionId } : null;
      break;
    }`);
    replaceCase(/case ["']bot_message_markers["']:[\s\S]*?break;/, `case "bot_message_markers": {
      result = window.__botMessageFixture.markers ?? [];
      break;
    }`);
    replaceCase(/case ["']bot_model_switches["']:[\s\S]*?break;/, `case "bot_model_switches": {
      const fixture = window.__botFailoverFixture;
      result = fixture?.switches ?? [];
      break;
    }`);
    replaceCase(/case ["']bot_failover_decide["']:[\s\S]*?break;\s*}/, `case "bot_failover_decide": {
      const fixture = window.__botFailoverFixture;
      fixture.calls.push({ command, args: structuredClone(args) });
      fixture.ask = null;
      result = null;
      break;
    }`);
    await route.fulfill({ response, body });
  });
}

test.describe('bot conversation', () => {
  test('bot-to-bot markers group together and expand to show message text and status', async ({ page }) => {
    await installFailoverPreview(page);
    await openSample(page, 'Scout');
    // Scout's sample approval replaces the welcome once it lands; wait so it cannot redraw mid-test.
    await expect(page.locator('#composer-area')).toContainText('example.com');
    const sessionId = await page.locator('#prompt').getAttribute('data-session-id');
    await expect.poll(() => page.evaluate(() => (window as any).__botHasListener?.('bot-messages-changed') ?? false)).toBe(true);
    await page.evaluate(({ sessionId }) => {
      const at = Date.now();
      (window as any).__botMessageFixture.markers = [
        { id: 'm1', kind: 'sent', botId: 'writer', botName: 'Writer', avatar: 'panda:4', color: '', text: 'Draft the announcement', result: null, status: 'Queued', createdAt: at },
        { id: 'm2', kind: 'sent', botId: 'ledger', botName: 'Ledger', avatar: 'panda:7', color: '#14b8a6', text: 'Check the budget', result: null, status: 'In progress', createdAt: at + 1 },
        { id: 'm3', kind: 'received', botId: 'writer', botName: 'Writer', avatar: 'panda:4', color: '', text: 'Add a short intro too', result: null, status: 'In progress', createdAt: at + 2 },
      ];
      (window as any).__botEmit('bot-messages-changed', { sessionId });
    }, { sessionId });
    const group = page.locator('#transcript .bot-collab-group');
    await expect(group.locator('summary').first()).toContainText('3 messages with Writer, Ledger');
    await expect(group.getByText('Draft the announcement')).toBeHidden();
    await group.locator('summary').first().click();
    await expect(group.getByText('Messaged Writer')).toBeVisible();
    await expect(group.getByText('Queued')).toBeVisible();
    await group.locator('.bot-collab-item').first().locator('summary').click();
    await expect(group.getByText('Draft the announcement')).toBeVisible();
    await expect(group.getByText('Message from Writer')).toBeVisible();
  });

  test('model switch events render in the transcript and a held message survives a page reload', async ({ page }) => {
    await installFailoverPreview(page);
    await openSample(page, 'Ledger');
    const row = sidebar(page).getByRole('button', { name: /^Chat with Ledger/ });
    const botId = await row.getAttribute('data-bot');
    await page.locator('#prompt').fill('How did we do this month?');
    await page.locator('#prompt').press('Enter');
    await expect(transcript(page).locator('.agent-message').last()).toContainText('browser preview', { timeout: 15_000 });
    const sessionId = await page.locator('#prompt').getAttribute('data-session-id');
    await expect.poll(() => page.evaluate(() => (window as any).__botHasListener('bot-model-switch'))).toBe(true);
    await page.evaluate(({ botId, sessionId }) => {
      const fixture = (window as any).__botFailoverFixture;
      fixture.botId = botId;
      (window as any).__botEmit('bot-model-switch', { botId, at: Date.now(), text: 'Provider error. Switched to gpt-5.', detail: { sessionId, cause: 'provider-error', back: false, provider: 'codex', model: 'gpt-5' } });
    }, { botId, sessionId });
    await expect(transcript(page).locator('.model-switch-marker')).toContainText('Switched to gpt-5');

    await page.evaluate(({ botId, sessionId }) => {
      const fixture = (window as any).__botFailoverFixture;
      fixture.ask = { botId, sessionId, cause: 'limit', provider: 'claude', model: 'opus', target: { provider: 'codex', model: 'gpt-5' }, resetsAt: null };
      fixture.switches = [{ id: 1, kind: 'model-switch', summary: 'Usage limit reached. Switched to gpt-5.', detail: { sessionId, cause: 'limit', back: false, provider: 'codex', model: 'gpt-5' }, at: Date.now() }];
      (window as any).__persistBotFailoverFixture();
    }, { botId, sessionId });
    await page.reload();
    await showBotsView(page);
    const reloadedRow = sidebar(page).getByRole('button', { name: /^Chat with Ledger/ });
    await reloadedRow.click();
    const card = page.locator('#composer-area .bot-failover');
    await expect(card).toBeVisible();
    await expect(card).toContainText('Message on hold');
    // No reset time is known, so nothing would resume the message: the card offers Dismiss.
    await expect(card).toContainText('retry manually');
    await expect(card.getByRole('button', { name: 'Wait for the reset' })).toHaveCount(0);
    const withReset = await page.evaluate(async ({ url, ask }) => (await import(url)).failoverCardHtml({ ...ask, resetsAt: Date.now() + 3_600_000 }), { url: '/src/bots.ts', ask: { botId, sessionId, cause: 'limit', provider: 'claude', model: 'opus', target: { provider: 'codex', model: 'gpt-5' } } });
    expect(withReset).toContain('Wait for the reset');
    await card.getByRole('button', { name: 'Dismiss' }).click();
    await expect(card).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => (window as any).__botFailoverFixture.calls)).toEqual([{ command: 'bot_failover_decide', args: { sessionId: expect.any(String), action: 'wait', always: false } }]);
  });

  test('messages are bubbles with a day separator and the bot as author', async ({ page }) => {
    // The folded bot brief must never reach the sidebar's one-line preview.
    await page.addInitScript(() => {
      const w = window as any; w.__briefLeaked = false;
      new MutationObserver(() => { if (document.querySelector('#sidebar-bots-panel')?.textContent?.includes('Bot brief')) w.__briefLeaked = true; })
        .observe(document, { subtree: true, childList: true, characterData: true });
    });
    await chattedBot(page);
    await expect(sidebar(page).getByRole('button', { name: /^Chat with Ledger/ })).toContainText('browser preview');
    expect(await page.evaluate(() => (window as any).__briefLeaked)).toBe(false);
    const user = transcript(page).locator('.user-message').first(), agent = transcript(page).locator('.agent-message').last();
    await expect(user.locator('.message-content')).toHaveCSS('border-top-left-radius', '16px');
    const [userBox, agentBox] = [await user.locator('.message-content').boundingBox(), await agent.locator('.message-content').boundingBox()];
    expect(userBox!.x + userBox!.width).toBeGreaterThan(agentBox!.x + agentBox!.width - 2);
    expect(userBox!.x).toBeGreaterThan(agentBox!.x);
    await expect(agent.locator('.message-meta strong')).toHaveText('Ledger');
    await expect(transcript(page).locator('.bot-day').first()).toHaveText(/^Today \d{1,2}:\d{2}/);
  });

  test('time and actions show on hover: copy, reply with a quote chip, and reactions', async ({ page }) => {
    await chattedBot(page);
    const agent = transcript(page).locator('.agent-message').last(), actions = agent.locator('.message-actions');
    await expect(actions).toHaveCSS('opacity', '0');
    await agent.hover();
    await expect(actions).toHaveCSS('opacity', '1');
    await expect(actions.locator('.bot-message-time')).toHaveText(/\d{1,2}:\d{2}/);

    await actions.getByRole('button', { name: 'Copy message' }).click();
    await expect.poll(() => page.evaluate(() => (window as any).__copied.join(''))).toContain('browser preview');

    await actions.getByRole('button', { name: 'Reply' }).click();
    const chip = page.locator('#composer .bot-reply-chip');
    await expect(chip).toContainText('Replying to Ledger');
    await expect(page.locator('#prompt')).toHaveValue(/^> This is the browser preview/);
    await chip.getByRole('button', { name: 'Cancel reply' }).click();
    await expect(chip).toHaveCount(0);
    await expect(page.locator('#prompt')).toHaveValue('');

    await agent.hover();
    await actions.getByRole('button', { name: 'React', exact: true }).click();
    await actions.getByRole('button', { name: 'React with 🎉' }).click();
    const pill = agent.getByRole('button', { name: 'Remove your 🎉 reaction' });
    await expect(pill).toBeVisible();
    await pill.click();
    await expect(pill).toHaveCount(0);
  });

  test('a finished turn folds its work into one steps row above the answer', async ({ page }) => {
    await chattedBot(page);
    const steps = transcript(page).locator('.turn-activity.bot-steps').last();
    await expect(steps.locator('.turn-activity-label')).toHaveText(/^1 step · \d+s$/);
    await expect(steps).not.toHaveAttribute('open', '');
    await steps.locator('.turn-activity-summary').click();
    await expect(steps.locator('[data-tool-key]')).toHaveCount(1);
  });

  test('while working: one shimmering label, elapsed time after 5s, then waiting on the harness', async ({ page }) => {
    await page.clock.install();
    await openSample(page, 'Writer');
    await page.clock.fastForward(700);
    const working = page.locator('#stream-region .bot-working');
    await expect(working).toBeVisible();
    await expect(working.locator('.bot-working-avatar')).toHaveCSS('width', '32px');
    const label = await working.locator('.bot-working-label').textContent();
    expect(['Working on it…', 'Thinking it through…', 'Connecting the dots…', 'Checking the details…', 'Putting the answer together…', 'Making sense of it…', 'One step at a time…', 'Tiny gears are turning…', 'Consulting the inner council…', 'Cooking up something useful…']).toContain(label);
    await expect(working).toHaveAttribute('data-shimmer', '');
    await expect(working.getByRole('status')).toHaveText(`Writer is working: ${label}`);
    await expect(working.locator('.bot-working-elapsed')).toHaveText('');
    // The bot's indicator carries the status; the step summary shows only once there is a step.
    const steps = page.locator('#stream-region .live-activity');
    await expect(steps.locator('.live-tools > *')).toHaveCount(0);
    await expect(steps).toBeHidden();
    await page.clock.fastForward(6_000);
    await expect(working.locator('.bot-working-elapsed')).toHaveText(/^[6-9]s$/);
    await page.clock.fastForward(20_000);
    await expect(working.locator('.bot-working-label')).toHaveText(/^Waiting for .+…$/);
    await expect(working).not.toHaveAttribute('data-shimmer', '');
    await expect(working.locator('.bot-working-elapsed')).toHaveText(/^\d+s$/);
  });

  test('Enter while a bot works shows the queued row at once', async ({ page }) => {
    await openSample(page, 'Writer');
    await expect(page.locator('#composer .stop-button')).toBeVisible();
    await page.locator('#prompt').fill('Then draft the follow-up');
    await page.locator('#prompt').press('Enter');
    await expect(page.locator('.queue-row').filter({ hasText: 'Then draft the follow-up' })).toBeVisible({ timeout: 1_500 });
  });

  test('short messages keep one line and a steer on a working bot is delivered', async ({ page }) => {
    await openSample(page, 'Writer');
    await expect(page.locator('#composer .stop-button')).toBeVisible();
    await page.locator('#prompt').fill('one');
    await page.locator('#prompt').press('ControlOrMeta+Enter');
    const bubble = transcript(page).locator('.user-message .message-content').filter({ hasText: /^one$/ });
    await expect(bubble).toBeVisible();
    expect((await bubble.boundingBox())!.height).toBeLessThan(50);
    await expect(page.locator('#stream-region')).toContainText('Got it, I will fold that in.');
    await expect(page.locator('#toast')).not.toContainText('not running');
  });

  test('a thread waiting for approval drops the ready welcome', async ({ page }) => {
    await openSample(page, 'Scout');
    await expect(page.locator('#composer-area')).toContainText('example.com');
    await expect(transcript(page).locator('.bot-welcome-setup')).toHaveCount(0);
  });

  test('a model picked mid-turn waits for the next turn', async ({ page }) => {
    await openSample(page, 'Writer');
    await expect(page.locator('#stream-region .bot-working')).toBeVisible();
    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    await picker.getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill('next-model');
    await picker.getByRole('option', { name: /^Use "next-model" with / }).click();
    const badge = page.locator('#breadcrumb .bot-next-model');
    await expect(badge).toHaveText('After this turn');
    await expect(badge).toHaveAttribute('title', /finishes this turn\. next-model starts with the next one\.$/);
  });

  test('an empty conversation says the bot is ready and suggests asks from its role', async ({ page }) => {
    await openSample(page, 'Ledger');
    const welcome = transcript(page).locator('.bot-welcome');
    await expect(welcome.getByRole('heading', { name: 'Ledger is ready.' })).toBeVisible();
    await expect(welcome).toContainText('Ask, then watch it work.');
    const chips = welcome.getByRole('group', { name: 'Suggestions' }).getByRole('button');
    await expect(chips).toHaveCount(3);
    await expect(chips.nth(1)).toHaveText('Summarize my spending categories this month.');
    await chips.nth(1).click();
    await expect(page.locator('#prompt')).toHaveValue('Summarize my spending categories this month.');
    await expect(page.locator('#breadcrumb').getByRole('button', { name: 'View bot settings' })).toBeVisible();
    await expect(page.locator('#breadcrumb .bot-crumb-state')).toHaveClass(/sr-only/);
    await welcome.getByRole('group', { name: 'Set up Ledger' }).getByRole('button', { name: 'Memory' }).click();
    await expect(page.getByRole('dialog', { name: 'Ledger settings' })).toBeVisible();
  });
});
