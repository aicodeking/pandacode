import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const card = (page: Page) => page.locator('#feature-requests .fr-card');
const send = (page: Page) => page.getByRole('button', { name: 'Send request', exact: true });
const toast = (page: Page) => page.locator('#toast');
/** A toast hides on a timer unless the pointer rests on it, so a test that reads it first points at its button: under load the checks in between can outlast the timer. */
const hold = (page: Page, name: string) => toast(page).getByRole('button', { name }).hover();
test.beforeEach(() => { test.slow(); });

const TITLE = 'Pin a thread to the top of the sidebar';

/** Opens the preview with a seeded card; every IPC call and every window.open is recorded. */
async function open(page: Page, query = '?featurerequest', options: { openFails?: boolean } = {}): Promise<void> {
  await page.addInitScript(({ openFails }) => {
    const w = window as any;
    w.__calls = []; w.__opened = [];
    w.__clipboard = '';
    Object.defineProperty(navigator, 'clipboard', { value: { writeText: async (text: string) => { w.__clipboard = text; } }, configurable: true });
    w.open = (...args: unknown[]) => { w.__opened.push(args[0]); return null; };
    w.__openFails = openFails;
  }, { openFails: Boolean(options.openFails) });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window).__calls.push({ command, args: JSON.parse(JSON.stringify(args ?? {})) });
      if (command === 'open_external_url' && (window).__openFails) throw new Error('No browser');
      if (command === 'create_board_task' && (window).__createFails) throw new Error('Project not found.');
      switch (command) {
    `) });
  });
  await page.goto(`/${query}`, { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled({ timeout: 20_000 });
}

const calls = (page: Page, command: string) => page.evaluate(name => (window as any).__calls.filter((call: { command: string }) => call.command === name).map((call: { args: unknown }) => call.args), command);
const opened = (page: Page): Promise<string[]> => page.evaluate(() => (window as any).__opened);
const suggest = (page: Page, sessionId: string, title: string, description: string) =>
  page.evaluate(([id, head, body]) => (window as any).__previewFeatureRequest(id, head, body), [sessionId, title, description]);

test('feature request card shows the agent text, a hint and one primary action', async ({ page }) => {
  await open(page);
  await expect(card(page)).toBeVisible();
  await expect(page.getByRole('region', { name: 'Feature request suggestion' })).toBeVisible();
  await expect(card(page).getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(card(page)).toContainText('Suggested feature request');
  await expect(card(page)).toContainText('Send request opens a draft on GitHub in your browser, with this text in the link. It becomes an issue only when you submit it there.');
  for (const name of ['Edit', 'Do it myself', 'Send request']) await expect(card(page).getByRole('button', { name, exact: true })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Don\'t show feature requests again' })).toBeVisible();
  expect(await opened(page)).toEqual([]);
  // The cards sit above the approval bar, inside the composer area.
  const order = await page.evaluate(() => [...document.querySelector('#composer-area')!.children].map(node => node.id).filter(Boolean));
  expect(order.indexOf('feature-requests')).toBeLessThan(order.indexOf('approval-bar'));
  await expect(page.locator('#feature-requests')).toBeVisible();
});

test('feature request card is not drawn without a suggestion, and only for its own thread', async ({ page }) => {
  await open(page, '');
  await expect(card(page)).toHaveCount(0);
  expect(await page.locator('#feature-requests').evaluate(node => node.getBoundingClientRect().height)).toBe(0);
  await suggest(page, 'session-1', 'Live card', 'An agent left this while the thread was open.');
  await expect(card(page).getByRole('heading', { name: 'Live card' })).toBeVisible();
  await expect(page.locator('#feature-requests .fr-live')).toHaveText('The agent suggested a feature request: Live card.');
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(card(page)).toHaveCount(0);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(card(page).getByRole('heading', { name: 'Live card' })).toBeVisible();
});

test('feature request Edit changes the text, checks empty fields and Esc discards', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  const title = card(page).getByRole('textbox', { name: 'Title' }), description = card(page).getByRole('textbox', { name: 'Description' });
  await expect(title).toHaveValue(TITLE);
  await expect(title).toBeFocused();
  await expect(card(page).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await title.fill('');
  await send(page).click();
  await expect(card(page)).toContainText('Add a title');
  await expect(title).toHaveAttribute('aria-invalid', 'true');
  await expect(title).toBeFocused();
  expect(await opened(page)).toEqual([]);
  await title.fill('Pin threads');
  await expect(title).not.toHaveAttribute('aria-invalid', 'true');
  await description.fill('Keep my favorite thread on top.');
  await card(page).getByRole('button', { name: 'Done', exact: true }).click();
  await expect(card(page).getByRole('heading', { name: 'Pin threads' })).toBeVisible();
  await expect(card(page)).toContainText('Keep my favorite thread on top.');
  expect(await calls(page, 'feature_request_update')).toEqual([{ id: 'feature-request-1', title: 'Pin threads', description: 'Keep my favorite thread on top.' }]);
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Discard me');
  await page.keyboard.press('Escape');
  await expect(card(page).getByRole('heading', { name: 'Pin threads' })).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Edit', exact: true })).toBeFocused();
  expect(await calls(page, 'feature_request_update')).toHaveLength(1);
});

test('feature request Send request opens the GitHub draft with the edited text and hides the card', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Pin & sort threads');
  await card(page).getByRole('textbox', { name: 'Description' }).fill('Line one\nLine two: a/b?c=d');
  await send(page).click();
  await expect.poll(async () => (await opened(page)).length).toBe(1);
  const url = new URL((await opened(page))[0]);
  expect(url.origin + url.pathname).toBe('https://github.com/aicodeking/pandacode/issues/new');
  expect(Object.fromEntries(url.searchParams)).toEqual({ template: 'feature_request.yml', title: 'Pin & sort threads', problem: 'Line one\nLine two: a/b?c=d', proposal: '' });
  expect(await calls(page, 'feature_request_update')).toHaveLength(1);
  expect(await calls(page, 'feature_request_dismiss')).toEqual([{ id: 'feature-request-1' }]);
  await expect(card(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('Opened a draft on GitHub with this text. It becomes an issue when you submit it there.');
  await expect(prompt(page)).toBeFocused();
});

test('feature request Send request keeps the card and offers the text when the browser does not open', async ({ page }) => {
  await open(page, '?featurerequest', { openFails: true });
  await send(page).click();
  await toast(page).filter({ hasText: 'Couldn’t open your browser.' }).getByRole('button', { name: 'Copy text' }).click();
  await expect(card(page)).toBeVisible();
  expect(await calls(page, 'feature_request_dismiss')).toEqual([]);
  await expect.poll(() => page.evaluate(() => (window as any).__clipboard)).toContain(TITLE);
});

test('feature request Do it myself creates a task with the same agent and hides the card', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Do it myself', exact: true }).click();
  await expect(toast(page)).toContainText('Task created in orbit');
  await expect(card(page)).toHaveCount(0);
  const [created] = await calls(page, 'create_board_task') as Record<string, string>[];
  expect(created).toMatchObject({ projectId: 'project-1', provider: 'claude', title: TITLE });
  expect(created.description).toContain('While working on several tasks');
  expect(await calls(page, 'feature_request_dismiss')).toEqual([{ id: 'feature-request-1' }]);
  expect(await opened(page)).toEqual([]);
  await expect(page.locator('.task-item .task-title', { hasText: TITLE })).toHaveCount(1);
  await expect(prompt(page)).toBeFocused();
});

test('feature request Do it myself shows the reason and keeps the card when it fails', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).__createFails = true; });
  await card(page).getByRole('button', { name: 'Do it myself', exact: true }).click();
  await expect(card(page).getByRole('alert')).toHaveText('Couldn’t create the task: Project not found. Try again, or use Send request.');
  await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Do it myself', exact: true })).toBeEnabled();
  expect(await calls(page, 'feature_request_dismiss')).toEqual([]);
});

test('feature request Do it myself checks an empty description first', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'Description' }).fill('');
  await card(page).getByRole('button', { name: 'Do it myself', exact: true }).click();
  await expect(card(page)).toContainText('Add a description');
  expect(await calls(page, 'create_board_task')).toEqual([]);
});

test('feature request trash turns the cards off, Settings shows it and the switch turns them back on', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Don\'t show feature requests again' }).click();
  await hold(page, 'Settings');
  await expect(card(page)).toHaveCount(0);
  await expect(toast(page)).toContainText('Feature request cards turned off');
  expect(await calls(page, 'feature_requests_set_enabled')).toEqual([{ enabled: false }]);
  expect(await calls(page, 'feature_request_dismiss')).toEqual([{ id: 'feature-request-1' }]);
  await suggest(page, 'session-1', 'Hidden while off', 'Nothing may show while the switch is off.');
  await expect(card(page)).toHaveCount(0);
  await toast(page).getByRole('button', { name: 'Settings' }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await expect(settings.getByRole('tab', { name: 'Harnesses', exact: true })).toHaveAttribute('aria-selected', 'true');
  const toggle = settings.getByRole('checkbox', { name: 'Feature request cards' });
  await expect(toggle).not.toBeChecked();
  await toggle.click();
  await expect(toggle).toBeChecked();
  expect(await calls(page, 'feature_requests_set_enabled')).toEqual([{ enabled: false }, { enabled: true }]);
  await settings.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(card(page).getByRole('heading', { name: 'Hidden while off' })).toBeVisible();
});

test('feature request toast Turn on brings the cards back', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Don\'t show feature requests again' }).click();
  await toast(page).getByRole('button', { name: 'Turn on' }).click();
  await expect.poll(async () => (await calls(page, 'feature_requests_set_enabled')).length).toBe(2);
  await suggest(page, 'session-1', 'Back again', 'Cards are on again.');
  await expect(card(page).getByRole('heading', { name: 'Back again' })).toBeVisible();
});

test('feature request cards queue behind the one being read', async ({ page }) => {
  await open(page);
  await suggest(page, 'session-1', 'Second idea', 'Another thing the agent noticed.');
  await suggest(page, 'session-1', 'Third idea', 'And one more.');
  await expect(page.getByRole('region', { name: '3 feature request suggestions' })).toBeVisible();
  await expect(card(page).getByRole('heading', { name: TITLE })).toBeVisible();
  const queue = page.getByRole('button', { name: '2 more feature requests' });
  await expect(queue).toHaveAttribute('aria-expanded', 'false');
  await queue.click();
  await page.getByRole('button', { name: 'Third idea' }).click();
  await expect(card(page).getByRole('heading', { name: 'Third idea' })).toBeFocused();
  await expect(page.getByRole('button', { name: '2 more feature requests' })).toBeVisible();
  await send(page).click();
  await expect(card(page).getByRole('heading', { name: TITLE })).toBeVisible();
  await expect(page.getByRole('button', { name: '1 more feature request', exact: true })).toBeVisible();
});

test('feature request shows the whole text before Send, in a scroll area with no Show more', async ({ page }) => {
  await open(page);
  const lines = Array.from({ length: 30 }, (_, index) => `Line ${index + 1} of a long description.`);
  await suggest(page, 'session-1', 'Long one', lines.join('\n'));
  await page.getByRole('button', { name: '1 more feature request', exact: true }).click();
  await page.getByRole('button', { name: 'Long one' }).click();
  const text = card(page).locator('.fr-text');
  await expect(text).toContainText('Line 30 of a long description.');
  expect(await text.evaluate(node => node.textContent)).toBe(lines.join('\n'));
  const box = await text.evaluate(node => ({ client: node.clientHeight, scroll: node.scrollHeight, overflow: getComputedStyle(node).overflowY }));
  expect(box.overflow).toBe('auto');
  expect(box.scroll).toBeGreaterThan(box.client);
  expect(box.client).toBeGreaterThan(3 * 1.4 * 16);
  await expect(card(page).getByRole('button', { name: /^Show (more|less)$/ })).toHaveCount(0);
  await text.focus();
  await page.keyboard.press('End');
  expect(await text.evaluate(node => node.scrollTop)).toBeGreaterThan(0);
});

test('feature request clicks and Ctrl+Enter repeated at once open one draft and make one task', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Edited once');
  await page.evaluate(() => {
    const area = document.querySelector<HTMLElement>('#feature-requests textarea')!;
    for (const repeat of [false, false, true]) area.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, repeat, bubbles: true, cancelable: true }));
  });
  await expect(card(page)).toHaveCount(0);
  expect(await opened(page)).toHaveLength(1);
  expect(await calls(page, 'feature_request_update')).toHaveLength(1);
  expect(await calls(page, 'feature_request_dismiss')).toHaveLength(1);
});

test('feature request double Send request and double Do it myself act once', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('#feature-requests [data-fr="send"]')!; button.click(); button.click(); });
  await expect(card(page)).toHaveCount(0);
  expect(await opened(page)).toHaveLength(1);
  await suggest(page, 'session-1', 'Again', 'A second card.');
  await expect(card(page).getByRole('heading', { name: 'Again' })).toBeVisible();
  await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
  await card(page).getByRole('textbox', { name: 'Title' }).fill('Again, edited');
  await page.evaluate(() => { const button = document.querySelector<HTMLButtonElement>('#feature-requests [data-fr="do"]')!; button.click(); button.click(); });
  await expect(card(page)).toHaveCount(0);
  expect(await calls(page, 'create_board_task')).toHaveLength(1);
  expect(await calls(page, 'feature_request_update')).toHaveLength(1);
});

test('feature request Feedback opens an empty dialog and sends or cancels it', async ({ page }) => {
  await open(page, '');
  const feedback = page.getByRole('button', { name: 'Feedback', exact: true });
  await expect(feedback).toBeVisible();
  await feedback.focus();
  await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Feedback' });
  await expect(dialog).toBeVisible();
  await expect(dialog).toContainText('Send request opens a draft on GitHub in your browser with this text in the link; it becomes an issue when you submit it there.');
  const title = dialog.getByRole('textbox', { name: 'Title' }), details = dialog.getByRole('textbox', { name: 'Details' });
  await expect(title).toHaveValue('');
  await expect(details).toHaveValue('');
  await expect(title).toBeFocused();
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog).toContainText('Add a title');
  await expect(title).toBeFocused();
  await title.fill('Faster search');
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog).toContainText('Add details');
  await expect(details).toBeFocused();
  expect(await opened(page)).toEqual([]);
  // Cancel keeps the draft for the next time, and nothing is sent or created.
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(feedback).toBeFocused();
  await feedback.click();
  await expect(title).toHaveValue('Faster search');
  await details.fill('Search should answer while I type.');
  await dialog.getByRole('button', { name: 'Send request', exact: true }).click();
  await expect(dialog).toBeHidden();
  const url = new URL((await opened(page))[0]);
  expect(url.searchParams.get('title')).toBe('Faster search');
  expect(url.searchParams.get('problem')).toBe('Search should answer while I type.');
  await expect(toast(page)).toContainText('Opened a draft on GitHub with this text. It becomes an issue when you submit it there.');
  await feedback.click();
  await expect(title).toHaveValue('');
  await title.fill('Make it a task');
  await details.fill('Do it myself from the dialog.');
  await dialog.getByRole('button', { name: 'Do it myself', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(toast(page)).toContainText('Task created in orbit');
  const [created] = await calls(page, 'create_board_task') as Record<string, string>[];
  expect(created).toMatchObject({ title: 'Make it a task', description: 'Do it myself from the dialog.' });
  expect(await calls(page, 'feature_request_dismiss')).toEqual([]);
});

test('feature request Feedback sits beside Help and keeps the footer on one row at the default width', async ({ page }) => {
  await open(page, '');
  const names = await page.locator('.sidebar-bottom > button').evaluateAll(buttons => buttons.map(button => button.getAttribute('aria-label')));
  expect(names.slice(0, 2)).toEqual(['Help & support', 'Feedback']);
  const tops = () => page.locator('.sidebar-bottom > button').evaluateAll(buttons => new Set(buttons.map(button => Math.round(button.getBoundingClientRect().top))).size);
  await expect.poll(tops).toBe(1);
});

test('feature request Settings switch is on by default and describes what it does', async ({ page }) => {
  await open(page, '');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.getByRole('checkbox', { name: 'Feature request cards' })).toBeChecked();
  await expect(settings.locator('#settings-panel-agents')).toContainText('it becomes an issue only when you submit it there');
});

const PNG = process.env.FR_PNG_DIR;
for (const theme of ['light', 'dark']) {
  test(`feature request screenshots ${theme}`, async ({ page }) => {
    test.skip(!PNG, 'Set FR_PNG_DIR to write screenshots.');
    test.slow();
    await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
    await open(page);
    const area = page.locator('#composer-area');
    await expect(card(page)).toBeVisible();
    await area.screenshot({ path: `${PNG}/card-${theme}.png` });
    await card(page).getByRole('button', { name: 'Edit', exact: true }).click();
    await area.screenshot({ path: `${PNG}/card-editing-${theme}.png` });
    await page.keyboard.press('Escape');
    await suggest(page, 'session-1', 'Open a thread in a new window', 'A second window would let me watch two agents at once.');
    await suggest(page, 'session-1', 'Export a thread as Markdown', 'Sharing a conversation with a teammate takes copy and paste today.');
    await page.getByRole('button', { name: '2 more feature requests' }).click();
    await area.screenshot({ path: `${PNG}/card-several-${theme}.png` });
    await page.getByRole('button', { name: 'Feedback', exact: true }).click();
    await page.getByRole('dialog', { name: 'Feedback' }).screenshot({ path: `${PNG}/feedback-${theme}.png` });
    await page.getByRole('dialog', { name: 'Feedback' }).getByRole('button', { name: 'Cancel' }).click();
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
    await settings.getByRole('checkbox', { name: 'Feature request cards' }).scrollIntoViewIfNeeded();
    await settings.locator('#settings-panel-agents .settings-group').first().screenshot({ path: `${PNG}/settings-switch-${theme}.png` });
  });
}
