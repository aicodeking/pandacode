import { expect, test, type Page } from '@playwright/test';

// Times and weekdays are read in one locale and zone, so the expected strings hold on any machine.
test.use({ locale: 'en-US', timezoneId: 'UTC' });

const connection = (id: string, name: string, configDir: string | null) => ({ id, provider: 'claude', name, args: [], env: {}, secretEnv: [], configDir, revision: 1 });
const twoAccounts = [connection('work', 'Claude Work', '/Users/sample/.claude-work'), connection('shared', 'Claude Shared', null)];

async function openApp(page: Page, connections: unknown[], tasks: Record<string, string> = {}): Promise<string[]> {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/switch\s*\(command\)\s*\{/, `(window.__calls ??= []).push({ command, args: structuredClone(args) });
      if (command === 'agent_usage' && window.__usageFails) throw new Error('Could not read limits.');
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

test('with no connections both pools show one quiet line with Add account, a disabled switch and the by-hand setup folded away', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await expect(card.getByRole('switch', { name: 'Account pool · Claude Code' })).toBeDisabled();
  await expect(card.getByRole('switch', { name: 'Account pool · Codex' })).toBeDisabled();
  const claude = card.getByRole('region', { name: 'Claude Code accounts' });
  // One muted line with the button beside it; the ownership note waits for a second account.
  const empty = claude.locator('.account-pool-empty');
  await expect(empty).toContainText('Add a second account to pool');
  await expect(empty.getByRole('button', { name: 'Add a Claude Code account', exact: true })).toBeVisible();
  await expect(claude.getByRole('button', { name: 'Add a Claude Code account', exact: true })).toHaveCount(1);
  await expect(claude).not.toContainText('Pool only accounts you own');
  // The manual command sits in a closed disclosure until asked for.
  const manual = claude.locator('details.account-pool-manual');
  await expect(manual).not.toHaveAttribute('open');
  await expect(manual.locator('code')).toBeHidden();
  await manual.getByText('Set up an account by hand').click();
  await expect(manual.locator('code')).toHaveText('CLAUDE_CONFIG_DIR=~/.claude-2 claude auth login');
  await expect(manual).toContainText('then add a connection with that config folder');
  await expect(manual.getByRole('button', { name: 'Copy Claude Code sign-in command' })).toBeVisible();
  await expect(card.locator('[data-pool="codex"] code')).toHaveText('CODEX_HOME=~/.codex-2 codex login');
  expect(errors).toEqual([]);
});

test('the account pool turns on, lists members with identity, usage and status, leaves one out and flags a shared login', async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  const card = await openConnections(page);
  const toggle = card.getByRole('switch', { name: 'Account pool · Claude Code' });
  await expect(toggle).toBeEnabled();
  await expect(toggle).not.toBeChecked();
  const pool = card.getByRole('region', { name: 'Claude Code accounts' });
  await expect(pool.locator('.settings-heading h3')).toHaveText('Claude Code accounts');
  // The hint is the heading's second line, not an item of the list.
  await expect(pool.locator('.account-pool-head .account-pool-hint')).toHaveText('Moves to the next account when one reaches its usage limit.');
  await expect(pool.locator('.account-pool-members')).not.toContainText('Moves to the next account');
  await expect(pool).toContainText('Pool only accounts you own; each needs its own subscription.');
  // Members and a shared login show before the pool is turned on, at full contrast, with only neutral chips and no switches.
  const members = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(members).toHaveCount(3);
  await expect(members.nth(2)).toContainText('Same login as Default setup');
  await expect(pool).toHaveAttribute('data-off', '');
  expect(await members.nth(0).evaluate(row => getComputedStyle(row).opacity)).toBe('1');
  await expect(members.nth(1).locator('.account-meter')).toHaveCount(2);
  expect(await members.nth(1).locator('[data-identity]').evaluate(line => getComputedStyle(line).color)).toBe(await pool.locator('.account-pool-hint').evaluate(line => getComputedStyle(line).color));
  await expect(pool.getByRole('switch', { name: /^In pool:/ })).toHaveCount(0);
  await expect(members.nth(0).locator('[data-status]')).toHaveCount(0);
  await expect(members.nth(1).locator('[data-status]')).toHaveCount(0);
  await expect(members.nth(2).locator('[data-status]')).toHaveText('Same login');

  await toggle.check();
  await expect(card.getByRole('status')).toHaveText('Account pool on.');
  expect(await calls(page, 'connection_pool_set')).toEqual([{ provider: 'claude', enabled: true }]);
  expect(await page.evaluate(() => (window as any).__connections().pools)).toEqual(['claude']);
  await expect(pool).not.toHaveAttribute('data-off');

  await expect(members).toHaveCount(3);
  // Identity: the email and plan read from each account's login, and how many tasks run on it. No avatar.
  await expect(members.nth(0).locator('.ds-row-title')).toHaveText('Default setup');
  await expect(members.nth(0).locator('[data-identity]')).toHaveText('you@example.com · Max · Running 1');
  await expect(card.locator('.ds-avatar')).toHaveCount(0);
  await expect(members.nth(1).locator('[data-identity]')).toHaveText('claude.work@example.com · Pro');
  // Fresh usage (22 % and 64 %) outranks the held near-limit mark, so chip and meters agree.
  await expect(members.nth(0).locator('[data-status]')).toHaveText('Ready');
  await expect(members.nth(0).locator('[data-status] [data-state-tone]')).toHaveAttribute('data-state-tone', 'ready');
  await expect(members.nth(0).locator('[data-state-tone]')).toHaveCount(1);
  // The limit that ran out is named, and the reset is tomorrow, so it names the weekday.
  const weekday = await page.evaluate(() => new Date(Date.now() + 86_400_000).toLocaleDateString([], { weekday: 'short' }));
  await expect(members.nth(1).locator('[data-status]')).toHaveText(new RegExp(`^Weekly limit · until ${weekday} \\d`));
  await expect(members.nth(1).locator('[data-status] [data-state-tone]')).toHaveAttribute('data-state-tone', 'limited');
  // Usage: up to two meters per account, each with its percent and reset; the default setup is read without a connection.
  const meters = members.nth(1).locator('.account-meter');
  await expect(meters).toHaveCount(2);
  // One separator between label and reset, and the held weekly window resets when the chip says.
  await expect(meters.nth(0)).toHaveText(/^5-hour · resets \d+:\d\d [AP]M 81%$/);
  await expect(meters.nth(0)).toHaveAttribute('data-level', 'warn');
  await expect(meters.nth(1)).toHaveText(/^Weekly · resets \w+ \d.* 100%$/);
  await expect(meters.nth(1)).toHaveAttribute('data-level', 'danger');
  const chipTime = (await members.nth(1).locator('[data-status]').textContent())!.replace(/^.* · until /, '');
  await expect(meters.nth(1).locator('.account-meter-reset')).toHaveText(` · resets ${chipTime}`);
  await expect(members.nth(0).locator('.account-meter').nth(0)).toContainText('22%');
  await expect(members.nth(0).locator('.account-meter').nth(0)).toHaveAttribute('data-level', 'normal');
  // How old the numbers are: the oldest check on screen, beside Refresh.
  await expect(pool.locator('[data-checked]')).toHaveText(/^Checked \d+:\d\d [AP]M$/);
  // Meters line up with the account name.
  const left = async (locator: ReturnType<typeof members.nth>) => (await locator.boundingBox())!.x;
  expect(await left(meters.nth(0))).toBeCloseTo(await left(members.nth(1).locator('.ds-row-title')), 0);
  const usage = await calls(page, 'agent_usage');
  expect(usage).toContainEqual({ provider: 'claude', refresh: false });
  expect(usage).toContainEqual({ provider: 'claude', refresh: false, connection: 'work' });
  expect(usage.some((c: any) => c.connection === 'shared')).toBe(false);
  await expect(members.nth(2).locator('[data-identity]')).toHaveText('Same login as Default setup — give it its own config folder');
  await expect(members.nth(2).locator('[data-status]')).toHaveText('Same login');
  await expect(members.nth(2).locator('[data-status] [data-state-tone]')).toHaveCount(0);
  await expect(members.nth(2).getByRole('switch')).toHaveCount(0);
  await expect(members.nth(2).locator('.account-meter')).toHaveCount(0);

  const work = card.getByRole('switch', { name: 'In pool: Claude Work' });
  await expect(work).toBeChecked();
  // Try now (in the row's menu) clears the account's hold so it reads Ready again.
  await card.getByRole('button', { name: 'More for Claude Work', exact: true }).click();
  const menu = page.getByRole('menu', { name: 'Actions for Claude Work' });
  await expect(menu.getByRole('menuitem')).toHaveText(['Try now', 'Copy sign-in command', 'Edit…', 'Delete…']);
  await menu.getByRole('menuitem', { name: 'Try now' }).click();
  // The full weekly window is still in fresh usage, so the chip says Near limit rather than Ready.
  await expect(members.nth(1).locator('[data-status]')).toHaveText('Near limit');
  expect(await calls(page, 'account_pool_clear')).toEqual([{ provider: 'claude', id: 'work' }]);
  await card.getByRole('button', { name: 'More for Claude Work', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Actions for Claude Work' }).getByRole('menuitem')).toHaveText(['Copy sign-in command', 'Edit…', 'Delete…']);
  await page.keyboard.press('Escape');
  await card.getByRole('button', { name: 'More for Default setup', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Actions for Default setup' }).getByRole('menuitem')).toHaveText(['Try now']);
  await page.keyboard.press('Escape');

  // Leaving an account out by keyboard keeps focus on its switch while the row redraws.
  await work.focus();
  await page.keyboard.press('Space');
  await expect(card.getByRole('status')).toHaveText('Account left out of the pool.');
  expect(await calls(page, 'connection_pool_member_set')).toEqual([{ provider: 'claude', id: 'work', included: false }]);
  expect(await page.evaluate(() => (window as any).__connections().poolExcluded)).toEqual(['claude/work']);
  await expect(card.getByRole('switch', { name: 'In pool: Claude Work' })).not.toBeChecked();
  await expect(card.getByRole('switch', { name: 'In pool: Claude Work' })).toBeFocused();
  await expect(members.nth(1).locator('[data-status]')).toHaveText('Left out');
  await expect(members.nth(1).locator('[data-status] [data-state-tone]')).toHaveCount(0);
  await expect(card.getByRole('switch', { name: 'In pool: Default setup' })).toBeChecked();

  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).uncheck();
  await expect(card.getByRole('status')).toHaveText('Account pool off.');
  await expect(card.getByRole('switch', { name: 'Account pool · Claude Code' })).toBeFocused();
  await expect(members).toHaveCount(3);
  expect(errors).toEqual([]);
});

test('a 93 % window is amber like its Near limit chip, and an account shows the same plan in Settings and in Usage', async ({ page }) => {
  const errors = await openApp(page, [connection('work', 'Claude Work', '/Users/sample/.claude-work'), connection('personal', 'Claude Personal', '/Users/sample/.claude-personal')]);
  const card = await openConnections(page);
  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).check();
  const personal = card.locator('[data-pool="claude"] [data-pool-member="personal"]');
  await expect(personal.locator('[data-status]')).toHaveText('Near limit');
  await expect(personal.locator('[data-status] [data-state-tone]')).toHaveAttribute('data-state-tone', 'near');
  await expect(personal.locator('.account-meter').nth(0)).toContainText('93%');
  await expect(personal.locator('.account-meter').nth(0)).toHaveAttribute('data-level', 'warn');
  const settingsPlans = await card.locator('[data-pool="claude"] [data-pool-member] [data-identity]').allTextContents();
  expect(settingsPlans.slice(0, 3)).toEqual(['you@example.com · Max · Running 1', 'claude.work@example.com · Pro', 'claude.personal@example.com · Max']);
  // The Usage panel names the same plans.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  await usage.getByRole('tab', { name: 'Claude', exact: true }).click();
  const who = (id: string) => usage.locator(`#usage-panel-claude .usage-account-heading[data-account="${id}"] .usage-account-who`);
  await expect(who('')).toHaveText('you@example.com · Max');
  await expect(who('work')).toHaveText('claude.work@example.com · Pro');
  await expect(who('personal')).toHaveText('claude.personal@example.com · Max');
  await expect(usage.locator('.usage-connection[data-connection="personal"] .usage-window').nth(0)).toHaveAttribute('data-tone', 'warn');
  expect(errors).toEqual([]);
});

test('a refresh keeps an open row menu anchored and the minute tick re-reads only local status', async ({ page }) => {
  await page.clock.install();
  const errors = await openApp(page, twoAccounts);
  const card = await openConnections(page);
  const members = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(members.nth(1).locator('.account-meter')).toHaveCount(2);
  const reads = (await calls(page, 'agent_usage')).length, statuses = (await calls(page, 'account_pool_status')).length;
  // A status refresh while the menu is open waits; the menu stays on its anchor.
  const more = card.getByRole('button', { name: 'More for Claude Work', exact: true });
  await more.click();
  const menu = page.getByRole('menu', { name: 'Actions for Claude Work' });
  await expect(menu).toBeVisible();
  const anchor = await more.elementHandle();
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await calls(page, 'account_pool_status')).length).toBeGreaterThan(statuses);
  await expect(menu).toBeVisible();
  expect(await anchor!.evaluate(node => node.isConnected)).toBe(true);
  await page.keyboard.press('Escape');
  await expect(more).toBeFocused();
  // The 60 s timer reads account status again but never asks the provider for usage.
  const before = (await calls(page, 'account_pool_status')).length;
  await page.clock.fastForward(61_000);
  await expect.poll(async () => (await calls(page, 'account_pool_status')).length).toBeGreaterThan(before);
  expect((await calls(page, 'agent_usage')).length).toBe(reads);
  // After five minutes, focusing the window reads usage again.
  await page.clock.fastForward(300_000);
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await calls(page, 'agent_usage')).length).toBeGreaterThan(reads);
  // The card's refresh button asks for fresh numbers.
  await card.getByRole('button', { name: 'Refresh Claude Code usage' }).click();
  await expect.poll(async () => (await calls(page, 'agent_usage')).filter((c: any) => c.refresh).length).toBeGreaterThan(0);
  expect(errors).toEqual([]);
});

test('account rows are edited inline and deleted after a confirmation, and other harnesses keep a plain list', async ({ page }) => {
  const errors = await openApp(page, [...twoAccounts, { ...connection('kimi-team', 'Kimi Team', null), provider: 'kimi' }]);
  const card = await openConnections(page);
  // A pooled harness's accounts are rows in its card, not in the Connections list.
  await expect(card.locator('.named-connection')).toHaveText([/Kimi Team\s*Kimi Code/]);
  await card.getByRole('button', { name: 'More for Claude Work', exact: true }).click();
  await page.getByRole('menu', { name: 'Actions for Claude Work' }).getByRole('menuitem', { name: 'Edit…' }).click();
  // The form opens right under the account's row.
  const panel = card.locator('[data-pool="claude"] [data-edit-panel="work"]');
  await expect(panel.getByRole('form', { name: 'Edit connection' })).toBeVisible();
  expect(await panel.evaluate(node => (node.previousElementSibling as HTMLElement).dataset.poolMember)).toBe('work');
  await expect(card.getByLabel('Name', { exact: true })).toBeFocused();
  await expect(card.getByLabel('Name', { exact: true })).toHaveValue('Claude Work');
  // A status refresh keeps what is being typed.
  await card.getByLabel('Name', { exact: true }).fill('Claude Work 2');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect.poll(async () => (await calls(page, 'account_pool_status')).length).toBeGreaterThan(2);
  await expect(card.getByLabel('Name', { exact: true })).toHaveValue('Claude Work 2');
  await card.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(panel).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'More for Claude Work', exact: true })).toBeFocused();

  // Delete asks first and says the sign-in stays in its folder; Cancel keeps the account.
  await card.getByRole('button', { name: 'More for Claude Work', exact: true }).click();
  await page.getByRole('menu', { name: 'Actions for Claude Work' }).getByRole('menuitem', { name: 'Delete…' }).click();
  const confirm = card.getByRole('group', { name: 'Delete Claude Work?' });
  await expect(confirm).toContainText('Its sign-in stays in its folder (/Users/sample/.claude-work)');
  await expect(confirm.getByRole('button', { name: 'Cancel' })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(confirm).toHaveCount(0);
  await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
  expect(await calls(page, 'connection_delete')).toEqual([]);
  await card.getByRole('button', { name: 'More for Claude Shared', exact: true }).click();
  await page.getByRole('menu', { name: 'Actions for Claude Shared' }).getByRole('menuitem', { name: 'Delete…' }).click();
  await card.getByRole('group', { name: 'Delete Claude Shared?' }).getByRole('button', { name: 'Delete' }).click();
  await expect(card.getByRole('status')).toHaveText('Connection deleted. Its tasks use the harness setup again.');
  expect(await calls(page, 'connection_delete')).toEqual([{ id: 'shared' }]);
  await expect(card.locator('[data-pool="claude"] [data-pool-member]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('an account whose usage cannot be read says so', async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  await page.evaluate(() => { (window as any).__usageFails = true; });
  const card = await openConnections(page);
  const members = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(members.nth(0).locator('[data-usage]')).toHaveText('Usage not available');
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
  await expect.poll(() => calls(page, 'connection_new_account')).toEqual([{ provider: 'codex' }]);
  const fresh = card.locator('[data-pool="codex"] [data-pool-member]').filter({ hasText: 'Codex account 2' });
  await expect(fresh).toHaveCount(1);
  const panel = card.locator('[data-pool="codex"] [data-sign-in-panel]');
  // One click started the sign-in: the row waits on the browser with the link and Cancel.
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  const id = (await calls(page, 'account_sign_in_start'))[0].id;
  expect(id).toBeTruthy();
  await expect(panel.getByRole('link', { name: 'Open the sign-in page' })).toHaveAttribute('href', 'https://auth.openai.com/oauth/authorize?preview=1');
  await expect(panel.getByRole('button', { name: 'Cancel signing in Codex account 2' })).toBeVisible();
  await expect(fresh.locator('[data-status]')).toHaveText('Not signed in');
  await expect(fresh.locator('[data-identity]')).toHaveText('Sign in to add it to the pool');
  // Right after Add account the ownership note shows.
  await expect(card.locator('[data-pool="codex"]')).toContainText('Pool only accounts you own; each needs its own subscription.');
  await expect(fresh.getByRole('button', { name: 'Sign in Codex account 2' })).toHaveCount(0);
  // The link opens in the default browser.
  await panel.getByRole('link', { name: 'Open the sign-in page' }).click();
  await expect.poll(() => calls(page, 'open_external_url')).toContainEqual({ url: 'https://auth.openai.com/oauth/authorize?preview=1' });
  // The browser finishes; the row is signed in and joins the pool (the preview holds the first connection until tomorrow).
  await expect(fresh).not.toHaveAttribute('data-signed-out');
  await expect(fresh).not.toContainText('Not signed in');
  await expect(panel).toHaveCount(0);
  // Pool feedback lands in the card the action came from, not under the Connections card.
  await expect(card.locator('[data-pool="codex"] .account-pool-feedback')).toHaveText('Codex account 2 is signed in.');
  await expect(card.locator('[data-pool="codex"] .account-pool-feedback')).toHaveAttribute('role', 'status');
  await expect(card.locator('.named-connection-feedback')).toBeHidden();
  // The pool is still off, so the row has no switch until it is turned on.
  await expect(fresh.getByRole('switch')).toHaveCount(0);
  await card.getByRole('switch', { name: 'Account pool · Codex' }).check();
  await expect(fresh.getByRole('switch', { name: 'In pool: Codex account 2' })).toBeChecked();
  await expect(fresh.locator('[data-identity]')).toHaveText('codex.account.2@example.com · Plus');
  await expect(fresh.locator('.account-meter')).toHaveCount(2);
  // The by-hand setup stays as a folded fallback after Add account.
  await expect(card.locator('[data-pool="codex"] details.account-pool-manual')).not.toHaveAttribute('open');
  expect(errors).toEqual([]);
});

test('a Claude sign-in that asks for a code takes it from one field, and a second account takes the next folder', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  const fresh = card.locator('[data-pool="claude"] [data-pool-member]').filter({ hasText: 'Claude account 2' });
  const code = card.getByRole('textbox', { name: 'Sign-in code for Claude account 2' });
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute('placeholder', 'Paste code');
  await expect(card.locator('[data-pool="claude"] [data-sign-in-panel]')).toContainText('If the page shows a code, paste it here');
  // The fallback command is in the row's menu.
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await fresh.getByRole('button', { name: 'More for Claude account 2', exact: true }).click();
  await page.getByRole('menu', { name: 'Actions for Claude account 2' }).getByRole('menuitem', { name: 'Copy sign-in command' }).click();
  await expect(card.getByRole('status').last()).toHaveText('Command copied.');
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(`CLAUDE_CONFIG_DIR='/Users/sample/.claude-pandacode-2' claude auth login`);
  await code.fill('abc#def');
  await code.press('Enter');
  await expect(fresh).not.toHaveAttribute('data-signed-out');
  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).check();
  await expect(fresh.getByRole('switch', { name: 'In pool: Claude account 2' })).toBeChecked();
  expect((await calls(page, 'account_sign_in_code')).map((c: any) => c.code)).toEqual(['abc#def']);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  await expect(card.locator('[data-pool="claude"] [data-pool-member]').filter({ hasText: 'Claude account 3' })).toHaveCount(1);
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
  await expect(fresh.locator('[data-status]')).toHaveText('Not signed in');
  expect(await calls(page, 'account_sign_in_cancel')).toHaveLength(1);
  await fresh.getByRole('button', { name: 'Sign in Claude account 2' }).click();
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  expect(await calls(page, 'account_sign_in_start')).toHaveLength(2);
  expect(errors).toEqual([]);
});
