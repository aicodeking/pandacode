import { expect, test } from '@playwright/test';

test('a named connection is added in Settings, chosen for a task in the model picker, and kept', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  const taskId = await page.locator('.task-item.selected').getAttribute('data-id');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Providers', exact: true }).click();
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
