import { expect, test, type Page } from '@playwright/test';

const connection = (id: string, name: string, configDir: string | null) => ({ id, provider: 'claude', name, args: [], env: {}, secretEnv: [], configDir, revision: 1 });
const twoAccounts = [connection('work', 'Claude Work', '/Users/sample/.claude-work'), connection('shared', 'Claude Shared', null)];

async function openApp(page: Page, connections: unknown[], tasks: Record<string, string> = {}): Promise<string[]> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/switch\s*\(command\)\s*\{/, `(window.__calls ??= []).push({ command, args: structuredClone(args) });
      switch (command) {`);
    await route.fulfill({ response, body: `${body}\npreviewConnections = ${JSON.stringify({ connections, tasks, pools: [], poolExcluded: [] })};\nwindow.__connections = () => previewConnections; window.__emit = emit;\n` });
  });
  await page.goto('/');
  return errors;
}
async function openConnections(page: Page) {
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click(); await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.locator('#settings-panel-providers details.connection-card').first().waitFor(); for (const s of await page.locator('#settings-panel-providers details.connection-card>summary').all()) await s.click();
  return page.locator('#named-connections');
}
const calls = (page: Page, command: string) => page.evaluate(name => (window as any).__calls.filter((c: any) => c.command === name).map((c: any) => c.args), command);

test('with no connections both pools show the sign-in command and a disabled switch with the reason', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await expect(card.getByRole('switch', { name: 'Account pool · Claude Code' })).toBeDisabled();
  await expect(card.getByRole('switch', { name: 'Account pool · Codex' })).toBeDisabled();
  const claude = card.locator('[data-pool="claude"]');
  await expect(claude).toContainText('Add a connection for another account to turn it on.');
  await expect(claude.locator('code')).toHaveText('CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login');
  await expect(claude).toContainText('then add a connection with that config folder');
  await expect(card.locator('[data-pool="codex"] code')).toHaveText('CODEX_HOME=~/.codex-2 codex login');
  expect(errors).toEqual([]);
});

test('the account pool turns on, lists members with status, leaves one out and flags a shared login', async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  const card = await openConnections(page);
  const toggle = card.getByRole('switch', { name: 'Account pool · Claude Code' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  await expect(card.getByText('Switch to the next account automatically when one reaches its usage limit.').first()).toBeVisible();
  await expect(card.locator('[data-pool="claude"]')).toContainText('Pool only accounts you own; each needs its own subscription.');
  // Members and a shared login show before the pool is turned on.
  const offMembers = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(offMembers).toHaveCount(3);
  await expect(offMembers.nth(2)).toContainText('Same login as Default setup');

  await toggle.check();
  await expect(card.getByRole('status')).toHaveText('Account pool on.');
  expect(await calls(page, 'connection_pool_set')).toEqual([{ provider: 'claude', enabled: true }]);
  expect(await page.evaluate(() => (window as any).__connections().pools)).toEqual(['claude']);

  const members = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(members).toHaveCount(3);
  await expect(members.nth(0)).toHaveText(/Default setup\s*Near limit · Running 1/);
  await expect(members.nth(0).locator('[data-state-tone]')).toHaveAttribute('data-state-tone', 'near');
  // The reset is tomorrow, so it names the weekday.
  const weekday = await page.evaluate(() => new Date(Date.now() + 86_400_000).toLocaleDateString([], { weekday: 'short' }));
  await expect(members.nth(1)).toHaveText(new RegExp(`Claude Work\\s*Out until ${weekday} \\d`));
  await expect(members.nth(1).locator('[data-state-tone]')).toHaveAttribute('data-state-tone', 'limited');
  await expect(members.nth(2)).toHaveText(/Claude Shared\s*Same login as Default setup — give it its own config folder/);
  await expect(members.nth(2).getByRole('switch')).toHaveCount(0);
  // The same-login row lines up with the others.
  const left = async (i: number) => (await members.nth(i).locator('small').boundingBox())!.x;
  expect(await left(2)).toBeCloseTo(await left(0), 0);

  const work = card.getByRole('switch', { name: 'In pool: Claude Work' });
  await expect(work).toBeChecked();
  await work.uncheck();
  await expect(card.getByRole('status')).toHaveText('Account left out of the pool.');
  expect(await calls(page, 'connection_pool_member_set')).toEqual([{ provider: 'claude', id: 'work', included: false }]);
  expect(await page.evaluate(() => (window as any).__connections().poolExcluded)).toEqual(['claude/work']);
  await expect(card.getByRole('switch', { name: 'In pool: Claude Work' })).not.toBeChecked();
  await expect(card.getByRole('switch', { name: 'In pool: Default setup' })).toBeChecked();

  // Try now clears the account's hold so it reads Ready again.
  await card.getByRole('button', { name: 'Try Claude Work now', exact: true }).click();
  await expect(members.nth(1)).toHaveText(/Claude Work\s*Ready/);
  await expect(card.getByRole('button', { name: 'Try Claude Work now', exact: true })).toHaveCount(0);
  expect(await calls(page, 'account_pool_clear')).toEqual([{ provider: 'claude', id: 'work' }]);
  await expect(card.getByRole('button', { name: 'Try Default setup now', exact: true })).toBeVisible();

  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).uncheck();
  await expect(card.getByRole('status')).toHaveText('Account pool off.');
  await expect(members).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('a run moved to another pool account shows that account in the composer', async ({ page }) => {
  const errors = await openApp(page, twoAccounts, { 'session-1': 'work' });
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  const trigger = page.locator('#model-picker-trigger');
  await expect(trigger).toContainText('Claude Work');
  const note = (connectionId: string | null) => page.evaluate(id => (window as any).__emit('agent-event', { sessionId: 'session-1', kind: 'note', text: 'Claude Work reached its usage limit, so this task continues on Claude Shared.', data: { accountPool: { connectionId: id } } }), connectionId);
  await note('shared');
  await expect(trigger).toContainText('Claude Shared');
  await note(null);
  await expect(trigger).not.toContainText('Claude Shared');
  await expect(trigger).not.toContainText('Claude Work');
  expect(errors).toEqual([]);
});

test('Add account creates a connection with its own folder and signs it in with one click', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Codex account', exact: true }).click();
  await expect(card.locator('.named-connection')).toHaveText(/Codex account 2\s*Codex/);
  expect(await calls(page, 'connection_new_account')).toEqual([{ provider: 'codex' }]);
  const fresh = card.locator('[data-pool="codex"] [data-pool-member]').filter({ hasText: 'Codex account 2' });
  const panel = card.locator('[data-pool="codex"] [data-sign-in-panel]');
  // One click started the sign-in: the row waits on the browser with the link and Cancel.
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  const id = (await calls(page, 'account_sign_in_start'))[0].id;
  expect(id).toBeTruthy();
  await expect(panel.getByRole('link', { name: 'Open the sign-in page' })).toHaveAttribute('href', 'https://auth.openai.com/oauth/authorize?preview=1');
  await expect(panel.getByRole('button', { name: 'Cancel signing in Codex account 2' })).toBeVisible();
  await expect(fresh).toHaveText(/Codex account 2\s*Not signed in/);
  await expect(fresh.getByRole('button', { name: 'Sign in Codex account 2' })).toHaveCount(0);
  // The link opens in the default browser.
  await panel.getByRole('link', { name: 'Open the sign-in page' }).click();
  expect(await calls(page, 'open_external_url')).toContainEqual({ url: 'https://auth.openai.com/oauth/authorize?preview=1' });
  // The browser finishes; the row is signed in and joins the pool (the preview holds the first connection until tomorrow).
  await expect(fresh).not.toHaveAttribute('data-signed-out');
  await expect(fresh).not.toContainText('Not signed in');
  await expect(panel).toHaveCount(0);
  await expect(card.getByRole('status').last()).toHaveText('Codex account 2 is signed in.');
  await expect(fresh.getByRole('switch', { name: 'In pool: Codex account 2' })).toBeChecked();
  // The by-hand setup stays as a fallback after Add account.
  const order = await card.locator('[data-pool="codex"]').evaluate(pool => [...pool.querySelectorAll('[data-new-account], code')].map(e => e.tagName));
  expect(order[0]).toBe('BUTTON');
  expect(errors).toEqual([]);
});

test('a Claude sign-in that asks for a code takes it from one field, and a second account takes the next folder', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  const fresh = card.locator('[data-pool="claude"] [data-pool-member]').filter({ hasText: 'Claude account 2' });
  const code = card.getByRole('textbox', { name: 'Sign-in code for Claude account 2' });
  await expect(code).toBeVisible();
  await expect(card.locator('[data-pool="claude"] [data-sign-in-panel]')).toContainText('If the page shows a code, paste it here');
  // The fallback command stays on the row.
  await expect(fresh.getByRole('button', { name: 'Copy sign-in command for Claude account 2', exact: true })).toHaveAttribute('data-copy-command', `CLAUDE_CONFIG_DIR='/Users/sample/.claude-pandacode-2' claude auth login`);
  await code.fill('abc#def');
  await code.press('Enter');
  await expect(fresh).not.toHaveAttribute('data-signed-out');
  await expect(fresh.getByRole('switch', { name: 'In pool: Claude account 2' })).toBeChecked();
  expect((await calls(page, 'account_sign_in_code')).map((c: any) => c.code)).toEqual(['abc#def']);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  await expect(card.locator('.named-connection').nth(1)).toHaveText(/Claude account 3/);
  expect(errors).toEqual([]);
});

test('a sign-in can be cancelled and started again from the row', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  const fresh = card.locator('[data-pool="claude"] [data-pool-member]').filter({ hasText: 'Claude account 2' });
  const panel = card.locator('[data-pool="claude"] [data-sign-in-panel]');
  await panel.getByRole('button', { name: 'Cancel signing in Claude account 2' }).click();
  await expect(panel).toHaveText('Sign-in cancelled.');
  await expect(fresh).toHaveText(/Claude account 2\s*Not signed in/);
  expect(await calls(page, 'account_sign_in_cancel')).toHaveLength(1);
  await fresh.getByRole('button', { name: 'Sign in Claude account 2' }).click();
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  expect(await calls(page, 'account_sign_in_start')).toHaveLength(2);
  expect(errors).toEqual([]);
});
