import { expect, test } from '@playwright/test';

test('a named connection is added in Settings, chosen for a task in the model picker, and kept', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  const taskId = await page.locator('.task-item.selected').getAttribute('data-id');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Agents', exact: true }).click(); await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click(); await page.locator('#settings-panel-providers details.connection-card').first().waitFor(); for (const s of await page.locator('#settings-panel-providers details.connection-card>summary').all()) await s.click();
  const card = page.locator('#named-connections');
  await card.getByRole('button', { name: 'Add connection', exact: true }).click();
  await card.getByLabel('Harness', { exact: true }).selectOption('claude');
  await expect(card.locator('[data-config-var]')).toHaveText('(sets CLAUDE_CONFIG_DIR)');
  await card.getByLabel('Name', { exact: true }).fill('Claude Work');
  await card.getByLabel('Config folder').fill('/Users/sample/.claude-work');
  await card.getByRole('button', { name: 'Add variable', exact: true }).click();
  await card.getByLabel('Variable name').fill('ANTHROPIC_API_KEY');
  await card.getByLabel('Value').fill('fixture-secret');
  await card.getByLabel('Secret').check();
  await expect(card.getByLabel('Value')).toHaveAttribute('type', 'password');
  await card.getByRole('button', { name: 'Save connection', exact: true }).click();
  await expect(card.getByRole('status')).toHaveText('Connection saved. Choose it in the model picker.');
  await expect(card.locator('.named-connection')).toHaveText(/Claude Work\s*Claude Code/);
  // Editing shows the secret by name only; its value never comes back.
  await card.getByRole('button', { name: 'Edit Claude Work', exact: true }).click();
  await expect(card.getByLabel('Variable name')).toHaveValue('ANTHROPIC_API_KEY');
  await expect(card.getByLabel('Value')).toHaveValue('');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.keyboard.press('Escape');

  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Claude Work', exact: true }).click();
  await picker.getByRole('option', { name: 'Claude Work · Claude Sonnet 5', exact: true }).click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Work · Claude Sonnet 5');

  // Another task keeps the harness's own setup; returning shows the connection again.
  await page.locator('.task-item:not(.selected)').first().click();
  await expect(page.locator('#model-picker-trigger')).not.toContainText('Claude Work');
  await page.locator(`.task-item[data-id="${taskId}"]`).click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Work · Claude Sonnet 5');
  await page.locator('#model-picker-trigger').click();
  await expect(picker.getByRole('tab', { name: 'Claude Work', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(picker.locator('.model-menu-option[aria-current="true"]')).toHaveAttribute('aria-label', 'Claude Work · Claude Sonnet 5');
  // The plain harness clears it.
  await picker.getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await picker.getByRole('option', { name: 'Claude Code · Claude Sonnet 5', exact: true }).click();
  await expect(page.locator('#model-picker-trigger')).not.toContainText('Claude Work');
  expect(errors).toEqual([]);
});

test('a task at its plan limit can continue on another connection of the same harness', async ({ page }) => {
  const connection = (id: string, name: string, provider = 'claude') => ({ id, provider, name, args: [], env: {}, secretEnv: [], configDir: null, revision: 1 });
  const seed = `previewConnections = ${JSON.stringify({ connections: [connection('work', 'Claude Work'), connection('personal', 'Claude Personal'), connection('codex-work', 'Codex Work', 'codex')], tasks: { 'session-1': 'work' } })};`;
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/switch\s*\(command\)\s*\{/, `(window.__calls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'send_message') { Object.assign(session(args.sessionId), { status: 'running', limitedAt: null, limitedUntil: null }); return; }
      switch (command) {`);
    await route.fulfill({ response, body: `${body}\n${seed}\nwindow.__emit = emit; window.__session = session;\n` });
  });
  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.fill('Build the feature'); await prompt.press('Enter');
  await page.evaluate(() => {
    Object.assign((window as any).__session('session-1'), { limitedAt: Date.now(), limitedUntil: Date.now() + 3_600_000, status: 'idle' });
    const emit = (event: object) => (window as any).__emit('agent-event', { sessionId: 'session-1', ...event });
    emit({ kind: 'limited', text: '5-hour usage limit reached', data: { resetsAt: Date.now() + 3_600_000 } });
    emit({ kind: 'done', text: '' });
  });
  const banner = page.getByRole('region', { name: 'Usage limit', exact: true });
  // Only other connections of the same harness are offered, never the current one or another harness.
  await expect(banner.getByRole('button', { name: /^Continue on / })).toHaveText(['Continue on Claude Personal']);
  await banner.getByRole('button', { name: 'Continue on Claude Personal' }).click();
  const calls = () => page.evaluate(() => (window as any).__calls.filter((c: any) => ['connection_assign', 'send_message'].includes(c.command)).map((c: any) => [c.command, c.args.connectionId ?? c.args.text]));
  await expect.poll(calls).toEqual([
    ['send_message', 'Build the feature'],
    ['connection_assign', 'personal'],
    ['send_message', 'Continue where you left off. (Moved to the connection “Claude Personal” because Claude Work reached its usage limit.)'],
  ]);
  await expect(banner).toHaveCount(0);
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Personal');
});

const seedConnection = async (page: import('@playwright/test').Page) => {
  const connection = { id: 'work', provider: 'claude', name: 'Claude Work', args: [], env: {}, secretEnv: [], configDir: '/Users/sample/.claude-work', revision: 1 };
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/switch\s*\(command\)\s*\{/, `(window.__calls ??= []).push({ command, args: structuredClone(args) });
      if (command === window.__failCommand) throw new Error('Could not save the connection.');
      switch (command) {`);
    await route.fulfill({ response, body: `${body}\npreviewConnections = ${JSON.stringify({ connections: [connection], tasks: {} })};\n` });
  });
};
const callsNamed = (page: import('@playwright/test').Page, ...names: string[]) => page.evaluate(wanted => (window as any).__calls.filter((c: any) => wanted.includes(c.command)), names);

test('issue 252: a connection chosen on a new task is bound to exactly that one task', async ({ page }) => {
  await seedConnection(page);
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Claude Work', exact: true }).click();
  // Viewing a connection binds nothing yet, and the picker says what does.
  await expect(picker.locator('.model-menu-group-heading')).toContainText('Choose a model to use it');
  await picker.getByRole('option', { name: 'Claude Work · Claude Sonnet 5', exact: true }).click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Work · Claude Sonnet 5');
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.fill('Use my work login'); await prompt.press('Enter');
  await expect(page.locator('.user-message')).toContainText('Use my work login');
  const created = await callsNamed(page, 'create_session', 'chat_create');
  expect(created).toHaveLength(1);
  const assigned = await callsNamed(page, 'connection_assign');
  expect(assigned.map((c: any) => c.args.connectionId)).toEqual(['work']);
  // The prompt's bubble draws before the send call goes out.
  await expect.poll(async () => (await callsNamed(page, 'send_message')).map((c: any) => c.args.sessionId)).toEqual([assigned[0].args.sessionId]);
  await expect(page.locator(`#navigation .task-item[data-id="${assigned[0].args.sessionId}"]`)).toHaveCount(1);
});

test('issue 252: moving a new task to No project moves its text and connection and leaves one task', async ({ page }) => {
  await seedConnection(page);
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Claude Work', exact: true }).click();
  await picker.getByRole('option', { name: 'Claude Work · Claude Sonnet 5', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.fill('Typed before moving');
  const [{ args: { sessionId: draft } }] = await callsNamed(page, 'connection_assign');
  await page.locator('#welcome-project').click();
  await page.getByRole('option', { name: /No project/ }).click();
  await expect(prompt).toHaveValue('Typed before moving');
  await expect.poll(async () => (await callsNamed(page, 'discard_draft')).map((c: any) => c.args.sessionId)).toEqual([draft]);
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Work · Claude Sonnet 5');
  const [{ args: chat }] = await callsNamed(page, 'chat_create');
  expect([chat.provider, chat.model]).toEqual(['claude', 'sonnet']);
  await prompt.press('Enter');
  await expect(page.locator('.user-message')).toContainText('Typed before moving');
  await expect.poll(async () => (await callsNamed(page, 'send_message')).length).toBe(1);
  const sent = await callsNamed(page, 'send_message');
  const assigned = await callsNamed(page, 'connection_assign');
  expect(assigned.at(-1).args).toEqual({ sessionId: sent[0].args.sessionId, connectionId: 'work' });
  await expect(page.locator(`#navigation .task-item[data-id="${sent[0].args.sessionId}"]`)).toHaveCount(1);
  await expect(page.locator(`#navigation .task-item[data-id="${draft}"]`)).toHaveCount(0);
});

const PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==';
const pasteImage = (page: import('@playwright/test').Page) => page.evaluate(base64 => {
  const data = new DataTransfer();
  data.items.add(new File([Uint8Array.from(atob(base64), c => c.charCodeAt(0))], 'shot.png', { type: 'image/png' }));
  document.querySelector('#prompt')!.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
}, PNG);
const draftWithTextAndImage = async (page: import('@playwright/test').Page) => {
  await seedConnection(page);
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.fill('Look at this');
  await pasteImage(page);
  await expect(page.locator('#attachments .prompt-chip-image')).toContainText('shot.png');
  await expect(prompt).toHaveValue('Look at this');
  return prompt;
};

test('a new task moved to No project ends as one chat holding its text and attachment, with no draft left', async ({ page }) => {
  const prompt = await draftWithTextAndImage(page);
  await page.locator('#welcome-project').click();
  await page.getByRole('option', { name: /No project/ }).click();
  await expect(page.locator('.chat-welcome')).toBeVisible();
  await expect(prompt).toHaveValue('Look at this');
  await expect(page.locator('#attachments .prompt-chip-image')).toContainText('shot.png');
  await expect.poll(async () => (await callsNamed(page, 'discard_draft')).length).toBe(1);
  expect(await callsNamed(page, 'chat_create')).toHaveLength(1);
  await prompt.press('Enter');
  await expect.poll(async () => (await callsNamed(page, 'send_message')).length).toBe(1);
  const [{ args: sent }] = await callsNamed(page, 'send_message');
  expect(sent.imageIds).toHaveLength(1);
  expect(sent.text).toContain('Look at this');
  // New task finds no hidden draft to reopen: it creates a fresh one with an empty composer.
  await page.locator('.new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await expect(prompt).toHaveValue('');
  await expect(page.locator('#attachments .prompt-chip')).toHaveCount(0);
});

test('a failed move to No project reports the error and leaves the text and attachment on the new task', async ({ page }) => {
  const prompt = await draftWithTextAndImage(page);
  await page.locator('#model-picker-trigger').click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('tab', { name: 'Claude Work', exact: true }).click();
  await picker.getByRole('option', { name: 'Claude Work · Claude Sonnet 5', exact: true }).click();
  await expect(page.locator('#model-picker-trigger')).toContainText('Claude Work · Claude Sonnet 5');
  const draft = await page.locator('#prompt').getAttribute('data-session-id');
  await page.evaluate(() => { (window as any).__failCommand = 'connection_assign'; });
  await page.locator('#welcome-project').click();
  await page.getByRole('option', { name: /No project/ }).click();
  await expect(page.getByText('Could not save the connection.')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', draft!);
  await expect(prompt).toHaveValue('Look at this');
  await expect(page.locator('#attachments .prompt-chip-image')).toContainText('shot.png');
  expect(await callsNamed(page, 'discard_draft')).toHaveLength(0);
});

test('issue 193: New chat opens one chat, even when the native refresh lands first and on a second click', async ({ page }) => {
  await seedConnection(page);
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
  const before = await page.locator('#navigation .task-item').count();
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await expect(page.locator('.chat-welcome')).toBeVisible();
  await expect(page.locator('#navigation .task-item')).toHaveCount(before + 1);
  await page.getByRole('button', { name: 'New chat', exact: true }).click();
  await expect(prompt).toBeFocused();
  await expect(page.locator('#navigation .task-item')).toHaveCount(before + 1);
  expect(await callsNamed(page, 'chat_create')).toHaveLength(1);
});
