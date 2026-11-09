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
      if (window.__beforeInvoke) await window.__beforeInvoke(command, args);
      const intercepted = window.__testInvoke?.(command, args); if (intercepted !== undefined) return intercepted;
      if (command === 'account_pool_status' && window.__poolFixture) return structuredClone((window.__poolFixture[args.provider] ?? []).map(m => ({ ...m, excluded: (previewConnections.poolExcluded ?? []).includes(args.provider + '/' + m.id) })));
      if (command === 'agent_usage' && window.__usageFixtureOverride) return structuredClone(window.__usageFixtureOverride);
      if (command === 'agent_usage' && window.__usageFails) throw new Error('Could not read limits.');
      if (command === 'send_message' && window.__holdPoolTurn) return window.__startPoolTurn(args);
      switch (command) {`);
    await route.fulfill({ response, body: `${body}\npreviewConnections = ${JSON.stringify({ connections, tasks, pools: [], poolExcluded: [] })};\nwindow.__connections = () => previewConnections; window.__emit = emit; window.__poolSession = session;\n${poolTurnFixture}\n` });
  });
  await page.goto('/');
  return errors;
}
async function openConnections(page: Page) {
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click(); await settings.getByRole('tab', { name: 'Providers', exact: true }).click();
  await page.locator('#named-connections [data-pools]').waitFor();
  return page.locator('#named-connections');
}
const calls = (page: Page, command: string) => page.evaluate(name => (window as any).__calls.filter((c: any) => c.command === name).map((c: any) => c.args), command);

// Only metadata crosses this fixture: no login files, credentials or real account requests.
async function changingCodex(page: Page, hold: string[] = []) {
  await page.evaluate(hold => {
    const w = window as any;
    w.__accountReads = { hold, pending: [] };
    w.__testInvoke = (command: string, args: any) => {
      if (command === 'account_pool_status' && args.provider === 'codex') return ['', ...w.__connections().connections.filter((c: any) => c.provider === 'codex').map((c: any) => c.id)].map(id => ({ id, email: null, plan: null, signedIn: true, excluded: false, sameAs: null, limitedUntil: null, nearUntil: null, active: 0 }));
      if (command !== 'agent_usage' || args.provider !== 'codex' || args.connection !== 'work') return;
      const account = w.__connections().connections.find((c: any) => c.id === 'work');
      const version = account.configDir.endsWith('-B') ? 'B' : 'A';
      const result = { provider: 'codex', status: 'ready', email: `account.${version.toLowerCase()}@example.invalid`, plan: version === 'A' ? 'Pro' : 'Team', windows: [{ label: 'Weekly', usedPercent: version === 'A' ? 17 : 63, resetsAt: null }], checkedAt: Date.now(), stale: false };
      if (w.__accountReads.hold.includes(version)) return new Promise(resolve => w.__accountReads.pending.push({ version, resolve, result }));
      return result;
    };
  }, hold);
}
async function releaseAccount(page: Page, version: string) {
  await page.evaluate(async version => {
    const f = (window as any).__accountReads;
    f.hold = f.hold.filter((v: string) => v !== version);
    const pending = f.pending.filter((p: any) => p.version === version);
    f.pending = f.pending.filter((p: any) => p.version !== version);
    pending.forEach((p: any) => p.resolve(p.result));
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
  }, version);
}
async function keyboardAction(page: Page, name: string, action: 'Edit…' | 'Delete…') {
  const more = page.getByRole('button', { name: `More for ${name}`, exact: true });
  await more.focus(); await page.keyboard.press('Enter');
  const item = page.getByRole('menu', { name: `Actions for ${name}` }).getByRole('menuitem', { name: action, exact: true });
  await item.focus(); await page.keyboard.press('Enter');
}

test('with no connections both pools show the default account, Add account and folded manual setup', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await expect(card.getByRole('switch', { name: 'Account pool · Claude Code' })).toBeDisabled();
  await expect(card.getByRole('switch', { name: 'Account pool · Codex' })).toBeDisabled();
  const claude = card.getByRole('region', { name: 'Claude Code accounts' });
  // Default identity remains visible; the ownership note waits for a second account.
  await expect(claude.locator('[data-pool-member=""]')).toBeVisible();
  await expect(claude.getByRole('button', { name: 'Add a Claude Code account', exact: true })).toBeVisible();
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
  // Members and their accessible statuses show before pooling is on; member switches appear when enabled.
  const members = card.getByRole('list', { name: 'Claude Code account pool' }).locator('[data-pool-member]');
  await expect(members).toHaveCount(3);
  await expect(members.nth(2).locator('[data-status]')).toHaveAttribute('aria-label', 'Same login');
  await expect(pool).toHaveAttribute('data-off', '');
  expect(await members.nth(0).evaluate(row => getComputedStyle(row).opacity)).toBe('1');
  await expect(members.nth(1).locator('.account-meter')).toHaveCount(2);
  await expect(members.nth(1).locator('[data-identity]')).toHaveText('claude.work@example.com');
  await expect(pool.getByRole('switch', { name: /^In pool:/ })).toHaveCount(0);
  await expect(members.nth(0).locator('[data-status]')).toHaveAttribute('aria-label', /^Ready(?: · Running 1)?$/);
  await expect(members.nth(1).locator('[data-status]')).toHaveAttribute('aria-label', /^Weekly limit/);
  await expect(members.nth(2).locator('[data-status]')).toHaveAttribute('aria-label', 'Same login');

  await toggle.check();
  await expect(card.getByRole('status')).toHaveText('Account pool on.');
  expect(await calls(page, 'connection_pool_set')).toEqual([{ provider: 'claude', enabled: true }]);
  expect(await page.evaluate(() => (window as any).__connections().pools)).toEqual(['claude']);
  await expect(pool).not.toHaveAttribute('data-off');

  await expect(members).toHaveCount(3);
  // Identity: the email and plan read from each account's login, and how many tasks run on it. No avatar.
  await expect(members.nth(0).locator('.ds-row-sub')).toHaveText('Default setup · Max');
  await expect(members.nth(0).locator('[data-identity]')).toHaveText('you@example.com');
  await expect(card.locator('.ds-avatar')).toHaveCount(0);
  await expect(members.nth(1).locator('[data-identity]')).toHaveText('claude.work@example.com');
  // Fresh usage (22 % and 64 %) outranks the held near-limit mark, so chip and meters agree.
  await expect(members.nth(0).locator('[data-status]')).toHaveAttribute('aria-label', /^Ready(?: · Running 1)?$/);
  await expect(members.nth(0).locator('[data-status]')).toHaveAttribute('data-account-state', 'ready');
  await expect(members.nth(0).locator('[data-status][data-account-state="ready"]')).toHaveCount(1);
  // The limit that ran out is named, and the reset is tomorrow, so it names the weekday.
  const weekday = await page.evaluate(() => new Date(Date.now() + 86_400_000).toLocaleDateString([], { weekday: 'short' }));
  await expect(members.nth(1).locator('[data-status]')).toHaveAttribute('aria-label', new RegExp(`^Weekly limit · until ${weekday} \\d`));
  await expect(members.nth(1).locator('[data-status]')).toHaveAttribute('data-account-state', 'limited');
  // Usage: up to two meters per account, each with its percent and reset; the default setup is read without a connection.
  const meters = members.nth(1).locator('.account-meter');
  await expect(meters).toHaveCount(2);
  // Each heading pairs its window and percent; the separate reset agrees with the held window's chip.
  await expect(meters.locator('.account-meter-label')).toHaveText(['5-hour', 'Weekly']);
  await expect(meters.locator('.account-meter-value')).toHaveText(['81%', '100%']);
  await expect(meters.nth(0).locator('.account-meter-reset')).toHaveText(/^resets \d+:\d\d [AP]M$/);
  await expect(meters.nth(0)).toHaveAttribute('data-level', 'warn');
  await expect(meters.nth(1).locator('.account-meter-reset')).toHaveText(/^resets \w+ \d.*$/);
  await expect(meters.nth(1)).toHaveAttribute('data-level', 'danger');
  const chipTime = (await members.nth(1).locator('[data-status]').getAttribute('aria-label'))!.replace(/^.* · until /, '');
  await expect(meters.nth(1).locator('.account-meter-reset')).toHaveText(`resets ${chipTime}`);
  await expect(members.nth(0).locator('.account-meter').nth(0)).toContainText('22%');
  await expect(members.nth(0).locator('.account-meter').nth(0)).toHaveAttribute('data-level', 'normal');
  await expect(pool.getByRole('button', { name: 'Refresh Claude Code usage' })).toBeVisible();
  // Meters line up with the account name.
  const left = async (locator: ReturnType<typeof members.nth>) => (await locator.boundingBox())!.x;
  expect(await left(meters.nth(0))).toBeCloseTo(await left(members.nth(1).locator('.ds-row-title')), 0);
  const usage = await calls(page, 'agent_usage');
  expect(usage).toContainEqual({ provider: 'claude', refresh: false });
  expect(usage).toContainEqual({ provider: 'claude', refresh: false, connection: 'work' });
  expect(usage.some((c: any) => c.connection === 'shared')).toBe(false);
  await expect(members.nth(2).locator('[data-identity]')).toHaveText('you@example.com');
  await expect(members.nth(2).locator('[data-status]')).toHaveAttribute('aria-label', 'Same login');
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
  await expect(members.nth(1).locator('[data-status]')).toHaveAttribute('aria-label', 'Near limit');
  expect(await calls(page, 'account_pool_clear')).toEqual([{ provider: 'claude', id: 'work' }]);
  await card.getByRole('button', { name: 'More for Claude Work', exact: true }).click();
  await expect(page.getByRole('menu', { name: 'Actions for Claude Work' }).getByRole('menuitem')).toHaveText(['Copy sign-in command', 'Edit…', 'Delete…']);
  await page.keyboard.press('Escape');
  await pool.getByRole('button', { name: 'More for Default setup', exact: true }).click();
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
  await expect(members.nth(1).locator('[data-status]')).toHaveAttribute('aria-label', 'Left out');
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
  await expect(personal.locator('[data-status]')).toHaveAttribute('aria-label', 'Near limit');
  await expect(personal.locator('[data-status]')).toHaveAttribute('data-account-state', 'near');
  await expect(personal.locator('.account-meter').nth(0)).toContainText('93%');
  await expect(personal.locator('.account-meter').nth(0)).toHaveAttribute('data-level', 'warn');
  const settingsPlans = await card.locator('[data-pool="claude"] [data-pool-member] [data-identity]').allTextContents();
  expect(settingsPlans.slice(0, 3)).toEqual(['you@example.com', 'claude.work@example.com', 'claude.personal@example.com']);
  // The Usage panel names the same plans.
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  await usage.getByRole('tab', { name: 'Claude', exact: true }).click();
  const who = (id: string) => usage.locator(`#usage-panel-claude .usage-account-heading[data-account="${id}"] .usage-account-who`);
  await expect(who('')).toHaveText('you@example.com');
  await expect(who('work')).toHaveText('claude.work@example.com');
  await expect(who('personal')).toHaveText('claude.personal@example.com');
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

test('pool rotation updates account metadata while the picker keeps one plain current harness and model', async ({ page }) => {
  const errors = await openApp(page, twoAccounts, { 'session-1': 'work' });
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  const trigger = page.locator('#model-picker-trigger');
  await expect(trigger).toContainText('Claude Sonnet 5');
  await expect(trigger).not.toContainText('Claude Work');
  const note = (connectionId: string | null) => page.evaluate(id => {
    const w = window as any, tasks = w.__connections().tasks;
    if (id) tasks['session-1'] = id; else delete tasks['session-1'];
    w.__emit('agent-event', { sessionId: 'session-1', kind: 'note', text: 'Synthetic pool rotation.', data: { accountPool: { connectionId: id } } });
    w.__emit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' });
  }, connectionId);
  await note('shared');
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  // The completed run refresh can close a picker opened before that refresh lands.
  await expect(async () => {
    if (!await picker.isVisible()) await trigger.click();
    await expect(picker.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true', { timeout: 1000 });
  }).toPass();
  await expect(picker.getByRole('tab', { name: /Claude (Work|Shared)/ })).toHaveCount(0);
  await expect(picker.locator('[aria-current="true"]')).toHaveAccessibleName('Claude Code · Claude Sonnet 5');
  await page.keyboard.press('Escape');
  // Continuation choices consume the live account metadata: the new current account is omitted.
  await page.evaluate(() => {
    const w = window as any, emit = w.__emit;
    Object.assign(w.__poolSession('session-1'), { status: 'idle', limitedAt: Date.now(), limitedUntil: Date.now() + 3600000 });
    emit('agent-event', { sessionId: 'session-1', kind: 'limited', text: 'Synthetic usage limit', data: { resetsAt: Date.now() + 3600000 } });
    emit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' });
  });
  const banner = page.getByRole('region', { name: 'Usage limit', exact: true });
  await expect(banner.getByRole('button', { name: /^Continue on / })).toHaveText(['Continue on Claude Work']);
  await note(null);
  await expect(banner.getByRole('button', { name: /^Continue on / })).toHaveText(['Continue on Claude Work', 'Continue on Claude Shared']);
  await expect(trigger).toContainText('Claude Sonnet 5');
  expect(await calls(page, 'connection_assign')).toEqual([]);
  expect(await calls(page, 'connection_pool_set')).toEqual([]);
  expect(errors).toEqual([]);
});

test('Add account creates a connection with its own folder and signs it in with one click', async ({ page }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Codex account', exact: true }).click();
  await expect.poll(() => calls(page, 'connection_new_account')).toEqual([{ provider: 'codex' }]);
  const fresh = card.locator('[data-pool="codex"] [data-pool-member]').filter({ has: page.locator('.ds-row-sub', { hasText: 'Codex account 2' }) });
  await expect(fresh).toHaveCount(1);
  const panel = card.locator('[data-pool="codex"] [data-sign-in-panel]');
  // One click started the sign-in: the row waits on the browser with the link and Cancel.
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  const id = (await calls(page, 'account_sign_in_start'))[0].id;
  expect(id).toBeTruthy();
  await expect(panel.getByRole('link', { name: 'Open the sign-in page' })).toHaveAttribute('href', 'https://auth.openai.com/oauth/authorize?preview=1');
  await expect(panel.getByRole('button', { name: 'Cancel signing in Codex account 2' })).toBeVisible();
  await expect(fresh.locator('[data-status]')).toHaveAttribute('aria-label', 'Not signed in');
  await expect(fresh.locator('[data-identity]')).toHaveText('Not signed in');
  // Right after Add account the ownership note shows.
  await expect(card.locator('[data-pool="codex"]')).toContainText('Pool only accounts you own; each needs its own subscription.');
  await expect(fresh.getByRole('button', { name: 'Sign in Codex account 2' })).toHaveCount(0);
  // The link opens in the default browser.
  await panel.getByRole('link', { name: 'Open the sign-in page' }).click();
  await expect.poll(() => calls(page, 'open_external_url')).toContainEqual({ url: 'https://auth.openai.com/oauth/authorize?preview=1' });
  // The browser finishes; the row is signed in and joins the pool (the preview holds the first connection until tomorrow).
  await expect(fresh).not.toHaveAttribute('data-signed-out');
  await expect(fresh.locator('[data-status]')).not.toHaveAttribute('aria-label', 'Not signed in');
  await expect(panel).toHaveCount(0);
  // Pool feedback lands in the card the action came from, not under the Connections card.
  await expect(card.locator('[data-pool="codex"] .account-pool-feedback')).toHaveText('Codex account 2 is signed in.');
  await expect(card.locator('[data-pool="codex"] .account-pool-feedback')).toHaveAttribute('role', 'status');
  await expect(card.locator('.named-connection-feedback')).toBeHidden();
  // The pool is still off, so the row has no switch until it is turned on.
  await expect(fresh.getByRole('switch')).toHaveCount(0);
  await card.getByRole('switch', { name: 'Account pool · Codex' }).check();
  await expect(fresh.getByRole('switch', { name: 'In pool: Codex account 2' })).toBeChecked();
  await expect(fresh.locator('[data-identity]')).toHaveText('codex.account.2@example.com');
  await expect(fresh.locator('.account-meter')).toHaveCount(2);
  // The by-hand setup stays as a folded fallback after Add account.
  await expect(card.locator('[data-pool="codex"] details.account-pool-manual')).not.toHaveAttribute('open');
  expect(errors).toEqual([]);
});

test('a Claude sign-in that asks for a code takes it from one field, and a second account takes the next folder', async ({ page, browserName }) => {
  const errors = await openApp(page, []);
  const card = await openConnections(page);
  await card.getByRole('button', { name: 'Add a Claude Code account', exact: true }).click();
  const fresh = card.locator('[data-pool="claude"] [data-pool-member]').filter({ hasText: 'Claude account 2' });
  const code = card.getByRole('textbox', { name: 'Sign-in code for Claude account 2' });
  await expect(code).toBeVisible();
  await expect(code).toHaveAttribute('placeholder', 'Paste code');
  await expect(card.locator('[data-pool="claude"] [data-sign-in-panel]')).toContainText('If the page shows a code, paste it here');
  // The fallback command is in the row's menu.
  if (browserName === 'chromium') await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  else await page.evaluate(() => { let text = ''; Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (value: string) => { text = value; }, readText: async () => text } }); });
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
  await expect(fresh.locator('[data-status]')).toHaveAttribute('aria-label', 'Not signed in');
  expect(await calls(page, 'account_sign_in_cancel')).toHaveLength(1);
  await fresh.getByRole('button', { name: 'Sign in Claude account 2' }).click();
  await expect(panel).toContainText('Waiting for you to sign in in your browser…');
  expect(await calls(page, 'account_sign_in_start')).toHaveLength(2);
  expect(errors).toEqual([]);
});


test('default-only accounts are visible with pooling off and read local identity before limits', async ({ page }) => {
  await openApp(page, []);
  const card = await openConnections(page);
  for (const provider of ['claude', 'codex']) {
    const row = card.locator(`[data-pool="${provider}"] [data-pool-member=""]`);
    await expect(row).toBeVisible();
    await expect(row.locator('[data-identity]')).toContainText('you@example.com');
    expect(await calls(page, 'account_pool_status')).toContainEqual({ provider });
    expect(await calls(page, 'agent_usage')).toContainEqual({ provider, refresh: false });
  }
});

test('Refresh updates local identity and falls back to the same account usage email without extra reads', async ({ page }) => {
  await openApp(page, twoAccounts);
  const card = await openConnections(page);
  const row = card.locator('[data-pool="claude"] [data-pool-member="work"]');
  await expect(row.locator('[data-identity]')).toContainText('claude.work@example.com');
  await expect(row.locator('.account-meter')).toHaveCount(2);
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  const before = (await calls(page, 'agent_usage')).filter((c: any) => c.provider === 'claude').length;
  await page.evaluate(() => {
    (window as any).__poolFixture = { claude: [
      { id: '', email: 'default.changed@example.com', plan: 'Max', signedIn: true, excluded: false, sameAs: null, active: 0 },
      { id: 'work', email: null, plan: null, signedIn: true, excluded: false, sameAs: null, active: 0 },
      { id: 'shared', email: null, plan: null, signedIn: true, excluded: false, sameAs: '', active: 0 },
    ] };
    (window as any).__usageFixtureOverride = { provider: 'claude', status: 'ready', email: 'server.work@example.com', plan: 'Pro', windows: [], checkedAt: Date.now(), stale: false };
  });
  await card.getByRole('button', { name: 'Refresh Claude Code usage' }).click();
  await expect(row.locator('[data-identity]')).toContainText('server.work@example.com');
  await expect(card.locator('[data-pool="claude"] [data-pool-member=""] [data-identity]')).toContainText('default.changed@example.com');
  const after = (await calls(page, 'agent_usage')).filter((c: any) => c.provider === 'claude');
  expect(after.length - before, JSON.stringify(after)).toBe(2);
  await page.evaluate(() => {
    (window as any).__poolFixture.claude[1].email = 'known.work@example.com';
    (window as any).__usageFixtureOverride = { provider: 'claude', status: 'unavailable', email: null, plan: null, windows: [], checkedAt: Date.now(), stale: false };
  });
  await card.getByRole('button', { name: 'Refresh Claude Code usage' }).click();
  await expect(row.locator('[data-identity]')).toContainText('known.work@example.com');
});

test('window focus after a local identity change and explicit Refresh each read one account pair', async ({ page }) => {
  await page.clock.install();
  await openApp(page, twoAccounts);
  const card = await openConnections(page), row = card.locator('[data-pool="claude"] [data-pool-member="work"]');
  await expect(row.locator('.account-meter')).toHaveCount(2);
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  const claudeCalls = async () => (await calls(page, 'agent_usage')).filter((c: any) => c.provider === 'claude');
  const initial = (await claudeCalls()).length;
  await page.evaluate(() => {
    (window as any).__poolFixture = { claude: [
      { id: '', email: 'changed.default@example.invalid', plan: null, signedIn: true, excluded: false, sameAs: null, active: 0, nearUntil: null, limitedUntil: null },
      { id: 'work', email: null, plan: null, signedIn: true, excluded: false, sameAs: null, active: 0, nearUntil: null, limitedUntil: null },
      { id: 'shared', email: null, plan: null, signedIn: true, excluded: false, sameAs: '', active: 0, nearUntil: null, limitedUntil: null },
    ] };
    (window as any).__usageFixtureOverride = { provider: 'claude', status: 'ready', email: 'changed.work@example.invalid', plan: 'Pro', windows: [{ label: 'Weekly', usedPercent: 29, resetsAt: null }], checkedAt: Date.now(), stale: false };
    window.dispatchEvent(new Event('focus'));
  });
  await expect(row.locator('[data-identity]')).toHaveText('changed.work@example.invalid');
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  expect((await claudeCalls()).slice(initial)).toEqual([{ provider: 'claude', refresh: false }, { provider: 'claude', refresh: false, connection: 'work' }]);
  const focused = (await claudeCalls()).length;
  await card.getByRole('button', { name: 'Refresh Claude Code usage' }).click();
  await expect.poll(async () => (await claudeCalls()).length).toBe(focused + 2);
  expect((await claudeCalls()).slice(focused)).toEqual([{ provider: 'claude', refresh: true }, { provider: 'claude', refresh: true, connection: 'work' }]);
});

test('editing a Codex config folder clears the old fallback identity and windows before the new account read', async ({ page }) => {
  const errors = await openApp(page, [{ ...connection('work', 'Codex Work', '/tmp/codex-A'), provider: 'codex' }]);
  await changingCodex(page, ['B']);
  const card = await openConnections(page), row = card.locator('[data-pool="codex"] [data-pool-member="work"]');
  await expect(row.locator('[data-identity]')).toHaveText('account.a@example.invalid');
  await expect(row.locator('.ds-row-sub')).toHaveText('Codex Work · Pro');
  await expect(row.locator('.account-meter')).toContainText('17%');
  await keyboardAction(page, 'Codex Work', 'Edit…');
  await card.getByLabel('Config folder', { exact: false }).fill('/tmp/codex-B');
  await card.getByRole('button', { name: 'Save connection', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect(card.locator('[data-edit-panel]')).toHaveCount(0);
  await expect(card.getByRole('button', { name: 'More for Codex Work', exact: true })).toBeFocused();
  await expect(row.locator('[data-identity]')).toHaveText('Email not available');
  await expect(row.locator('.ds-row-sub')).toHaveText('Codex Work');
  await expect(row.locator('.account-meter')).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__accountReads.pending.map((p: any) => p.version))).toContain('B');
  expect(await page.evaluate(() => (window as any).__connections().connections[0])).toMatchObject({ id: 'work', configDir: '/tmp/codex-B', revision: 2 });
  await releaseAccount(page, 'B');
  await expect(row.locator('[data-identity]')).toHaveText('account.b@example.invalid');
  await expect(row.locator('.ds-row-sub')).toHaveText('Codex Work · Team');
  await expect(row.locator('.account-meter')).toContainText('63%');
  // Usage opens with the same revised connection and the same account/read fallback.
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Agent usage', exact: true }).click();
  const usage = page.getByRole('dialog', { name: 'Agent usage', exact: true });
  await usage.getByRole('tab', { name: 'Codex', exact: true }).click();
  const account = usage.locator('.usage-connection[data-connection="work"]');
  await expect(account.locator('.usage-account-who')).toHaveText('account.b@example.invalid');
  await expect(account.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '63');
  expect(errors).toEqual([]);
});

for (const action of ['edit', 'remove'] as const) test(`a deferred old Codex account response cannot land after ${action}`, async ({ page }) => {
  const errors = await openApp(page, [{ ...connection('work', 'Codex Work', '/tmp/codex-A'), provider: 'codex' }]);
  await changingCodex(page, ['A', 'B']);
  const card = await openConnections(page), row = card.locator('[data-pool="codex"] [data-pool-member="work"]');
  await expect.poll(() => page.evaluate(() => (window as any).__accountReads.pending.map((p: any) => p.version))).toContain('A');
  await keyboardAction(page, 'Codex Work', action === 'edit' ? 'Edit…' : 'Delete…');
  if (action === 'edit') {
    await card.getByLabel('Config folder', { exact: false }).fill('/tmp/codex-B');
    await card.getByRole('button', { name: 'Save connection', exact: true }).press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__accountReads.pending.map((p: any) => p.version))).toContain('B');
  } else {
    await card.getByRole('group', { name: 'Delete Codex Work?' }).getByRole('button', { name: 'Delete', exact: true }).press('Enter');
    await expect(row).toHaveCount(0);
  }
  await releaseAccount(page, 'A');
  await expect(card).not.toContainText('account.a@example.invalid');
  if (action === 'edit') {
    await expect(row.locator('.account-meter')).toHaveCount(0);
    await releaseAccount(page, 'B');
    await expect(row.locator('[data-identity]')).toHaveText('account.b@example.invalid');
    await expect(row.locator('.account-meter')).toContainText('63%');
  } else await expect(row).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('keyboard Save restores More and Delete focuses the adjacent account action or Add account', async ({ page }) => {
  const errors = await openApp(page, [connection('work', 'Claude Work', '/tmp/claude-work'), connection('personal', 'Claude Personal', '/tmp/claude-personal')]);
  const card = await openConnections(page);
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  await keyboardAction(page, 'Claude Work', 'Edit…');
  await card.getByLabel('Name', { exact: true }).fill('Claude Office');
  await card.getByRole('button', { name: 'Save connection', exact: true }).press('Enter');
  await expect(card.getByRole('button', { name: 'More for Claude Office', exact: true })).toBeFocused();
  await keyboardAction(page, 'Claude Office', 'Delete…');
  await card.getByRole('group', { name: 'Delete Claude Office?' }).getByRole('button', { name: 'Delete', exact: true }).press('Enter');
  await expect(card.getByRole('button', { name: 'More for Claude Personal', exact: true })).toBeFocused();
  await keyboardAction(page, 'Claude Personal', 'Delete…');
  await card.getByRole('group', { name: 'Delete Claude Personal?' }).getByRole('button', { name: 'Delete', exact: true }).press('Enter');
  // No named accounts remain, so Add account is the next useful action.
  await expect(card.getByRole('button', { name: 'Add a Claude Code account', exact: true })).toBeFocused();
  expect(errors).toEqual([]);
});

for (const action of ['save', 'delete'] as const) test(`async ${action} does not steal focus after the user moves to another account action`, async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  const card = await openConnections(page);
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  await page.evaluate(command => {
    (window as any).__beforeInvoke = (name: string) => name === command ? new Promise(resolve => { (window as any).__finishAction = resolve; }) : undefined;
  }, action === 'save' ? 'connection_save' : 'connection_delete');
  await keyboardAction(page, 'Claude Work', action === 'save' ? 'Edit…' : 'Delete…');
  if (action === 'save') {
    await card.getByLabel('Name', { exact: true }).fill('Claude Office');
    await card.getByRole('button', { name: 'Save connection', exact: true }).press('Enter');
  } else await card.getByRole('group', { name: 'Delete Claude Work?' }).getByRole('button', { name: 'Delete', exact: true }).press('Enter');
  await expect(card).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__finishAction)).toBe('function');
  const other = card.getByRole('button', { name: 'More for Claude Shared', exact: true });
  await other.focus();
  await expect(other).toBeFocused();
  await page.evaluate(() => (window as any).__finishAction());
  await expect(card).not.toHaveAttribute('aria-busy');
  await expect(other).toBeFocused();
  expect(errors).toEqual([]);
});

for (const theme of ['dark', 'light']) test(`ordinary account emails keep full row width in narrow ${theme} Settings`, async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await page.addInitScript(theme => { localStorage.setItem('pandacode.uiScale', '1.4'); localStorage.setItem('pandacode.theme', theme); }, theme);
  await openApp(page, [connection('work', 'Claude Work', '/tmp/pandacode-example-work')]);
  await page.evaluate(() => {
    const w = window as any;
    w.__usagePending = [];
    w.__beforeInvoke = (command: string) => command === 'agent_usage' && w.__usagePending ? new Promise(resolve => w.__usagePending.push(resolve)) : undefined;
  });
  const card = await openConnections(page);
  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).check();
  const row = card.locator('[data-pool="claude"] [data-pool-member="work"]');
  await expect(row.locator('[data-identity]')).toHaveText('claude.work@example.com');
  await expect(row.locator('[data-usage]')).toHaveAttribute('aria-busy', 'true');
  await expect.poll(() => page.evaluate(() => (window as any).__usagePending.length)).toBeGreaterThan(0);
  await page.evaluate(() => {
    const w = window as any, pending = w.__usagePending;
    w.__usagePending = null;
    pending.forEach((resolve: () => void) => resolve());
  });
  await expect(card).not.toHaveAttribute('aria-busy');
  await expect(row.locator('.account-meter')).toHaveCount(2);
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  const measure = () => row.evaluate(row => {
    if (!row.isConnected) return null;
    const main = row.querySelector<HTMLElement>('.ds-row-main')!, trail = row.querySelector<HTMLElement>('.ds-row-trail')!;
    const email = row.querySelector<HTMLElement>('[data-identity]')!, bounds = row.getBoundingClientRect();
    const style = getComputedStyle(row), text = getComputedStyle(email);
    return {
      width: main.getBoundingClientRect().width,
      available: bounds.width - parseFloat(style.paddingLeft) - parseFloat(style.paddingRight),
      mainBottom: main.getBoundingClientRect().bottom, trailTop: trail.getBoundingClientRect().top,
      lines: email.getBoundingClientRect().height / parseFloat(text.lineHeight),
      overflow: row.scrollWidth - row.clientWidth,
    };
  });
  let layout = await measure();
  // Requery only a detached row; geometry violations must fail on their first live measurement.
  if (layout === null) await expect.poll(async () => (layout = await measure())).not.toBeNull();
  expect(layout!.width).toBeCloseTo(layout!.available, 0);
  expect(layout!.trailTop).toBeGreaterThanOrEqual(layout!.mainBottom);
  expect(layout!.lines).toBeLessThanOrEqual(2.05);
  expect(layout!.overflow).toBeLessThanOrEqual(1);
  // Both widths keep the complete reset below the track, independent of the heading and percent.
  for (const width of [460, 1100]) {
    await page.setViewportSize({ width, height: 740 });
    const meters = row.locator('.account-meter');
    const geometry = await meters.evaluateAll(meters => meters.map(meter => {
      const label = meter.querySelector('.account-meter-label')!.getBoundingClientRect();
      const value = meter.querySelector('.account-meter-value')!.getBoundingClientRect();
      const track = meter.querySelector('.ds-meter')!.getBoundingClientRect();
      const reset = meter.querySelector<HTMLElement>('.account-meter-reset')!, bounds = reset.getBoundingClientRect();
      const text = document.createRange(); text.selectNodeContents(reset);
      const ink = text.getBoundingClientRect(), outer = meter.getBoundingClientRect();
      return { label: label.toJSON(), value: value.toJSON(), track: track.toJSON(), reset: bounds.toJSON(), ink: ink.toJSON(), outer: outer.toJSON(), overflow: reset.scrollWidth - reset.clientWidth };
    }));
    for (const meter of geometry) {
      expect(Math.max(meter.label.bottom, meter.value.bottom)).toBeLessThanOrEqual(meter.track.top);
      expect(meter.reset.top).toBeGreaterThanOrEqual(meter.track.bottom);
      expect(meter.ink.left).toBeGreaterThanOrEqual(meter.outer.left - 1);
      expect(meter.ink.right).toBeLessThanOrEqual(meter.outer.right + 1);
      expect(meter.ink.bottom).toBeLessThanOrEqual(meter.outer.bottom + 1);
      expect(meter.overflow).toBeLessThanOrEqual(1);
    }
    await expect(meters.locator('.account-meter-reset')).toHaveText([/^resets \d+:\d\d [AP]M$/, /^resets \w+ \d.*$/]);
    if (process.env.POOL_SHOTS) await page.screenshot({ path: `.pandacode/progress-shots/pooling-reset-${theme}-${width}.png`, animations: 'disabled' });
  }
});

for (const theme of ['dark', 'light']) test(`populated Settings accounts fit narrow 140% ${theme} and preserve status and actions`, async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await page.addInitScript(theme => { localStorage.setItem('pandacode.uiScale', '1.4'); localStorage.setItem('pandacode.theme', theme); }, theme);
  const email = `${'a'.repeat(104)}@example.invalid`; // 120 characters, deliberately wider than a row.
  const name = 'Research and development subscription account '.repeat(3);
  await openApp(page, [connection('long', name, '/tmp/pandacode-example-account')]);
  await page.evaluate(email => {
    (window as any).__poolFixture = { claude: [
      { id: '', email: 'default@example.invalid', plan: 'Max', signedIn: true, excluded: false, sameAs: null, active: 0 },
      { id: 'long', email, plan: 'Pro', signedIn: true, excluded: false, sameAs: null, active: 0 },
    ] };
    (window as any).__usageFixtureOverride = { provider: 'claude', status: 'ready', email: 'wrong@example.invalid', windows: [{ label: 'Weekly', usedPercent: 93, resetsAt: null }], checkedAt: Date.now(), stale: false };
  }, email);
  const card = await openConnections(page);
  const row = card.locator('[data-pool="claude"] [data-pool-member="long"]');
  await expect(row.locator('[data-identity]')).toHaveText(email);
  const status = row.locator('[data-status]');
  await expect(status).toHaveAttribute('aria-label', 'Near limit');
  await status.focus(); await expect(status).toBeFocused();
  await card.getByRole('switch', { name: 'Account pool · Claude Code' }).check();
  const toggle = row.getByRole('switch', { name: `In pool: ${name}` });
  await toggle.focus(); await page.keyboard.press('Space');
  await expect(toggle).toBeFocused();
  await expect(status).toHaveAttribute('aria-label', 'Left out');
  await toggle.check();
  await expect(status).toHaveAttribute('aria-label', 'Near limit');
  await expect(card).not.toHaveAttribute('aria-busy');
  await expect(card.locator('[data-usage][aria-busy="true"]')).toHaveCount(0);
  const more = row.getByRole('button', { name: `More for ${name}`, exact: true });
  await more.scrollIntoViewIfNeeded();
  const measure = () => row.evaluate(row => {
    if (!row.isConnected) return null;
    const r = row.getBoundingClientRect(), main = row.querySelector('.ds-row-main')!.getBoundingClientRect(), trail = row.querySelector('.ds-row-trail')!.getBoundingClientRect();
    return { left: r.left, right: r.right, overflow: row.scrollWidth - row.clientWidth, mainBottom: main.bottom, trailTop: trail.top };
  });
  let geometry = await measure();
  if (geometry === null) await expect.poll(async () => (geometry = await measure())).not.toBeNull();
  expect(geometry!.left).toBeGreaterThanOrEqual(0); expect(geometry!.right).toBeLessThanOrEqual(461);
  expect(geometry!.overflow).toBeLessThanOrEqual(1); expect(geometry!.mainBottom).toBeLessThanOrEqual(geometry!.trailTop);
  if (process.env.POOL_SHOTS) {
    await page.screenshot({ path: `.pandacode/progress-shots/pooling-settings-${theme}-narrow.png`, animations: 'disabled' });
    if (theme === 'dark') { await page.setViewportSize({ width: 1100, height: 820 }); await page.screenshot({ path: '.pandacode/progress-shots/pooling-settings-dark.png', animations: 'disabled' }); }
  }
  await more.focus(); await page.keyboard.press('Enter');
  await expect(page.getByRole('menu', { name: `Actions for ${name}` })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(more).toBeFocused();
});

test('fresh signed-out limits override an old locally signed-in default account', async ({ page }) => {
  await openApp(page, []);
  await page.evaluate(() => {
    (window as any).__poolFixture = { codex: [{ id: '', email: 'old@example.invalid', plan: 'Plus', signedIn: true, excluded: false, sameAs: null, nearUntil: null, limitedUntil: null, active: 0 }] };
    (window as any).__usageFixtureOverride = { provider: 'codex', status: 'signedOut', email: null, windows: [], checkedAt: Date.now(), stale: false };
  });
  const card = await openConnections(page);
  const row = card.locator('[data-pool="codex"] [data-pool-member=""]');
  await expect(row.locator('[data-status]')).toHaveAttribute('aria-label', 'Not signed in');
  await expect(row.locator('[data-identity]')).not.toContainText('old@example.invalid');
  await expect(row.locator('.account-meter')).toHaveCount(0);
});


// Real preview event flow, with the run held until done(); all persistence below is mocked.
const poolTurnFixture = `
const savedPool = sessionStorage.getItem('pool-saved-fixture');
if (savedPool) {
  const saved = JSON.parse(savedPool);
  const existing = sessions.findIndex(task => task.id === saved.task.id);
  if (existing < 0) sessions.push(saved.task); else sessions[existing] = saved.task;
  messages[saved.task.id] = saved.messages;
}
window.__poolRuns = {};
window.__startPoolTurn = args => {
  const task = session(args.sessionId); task.status = 'running'; task.taskStage = 'in_progress';
  if (task.title === 'New conversation') task.title = args.text;
  const rows = messages[task.id] ??= [];
  const save = (role, content) => rows.push({ id: ++id, sessionId: task.id, role, content, createdAt: Date.now() });
  save('user', args.text);
  let pending = '', toolIndex = 0;
  const persist = () => { if (pending) { save('assistant', pending); pending = ''; } };
  window.__poolRuns[task.id] = {
    push(text) { pending += text; agent({ sessionId: task.id, kind: 'text', text }); },
    note(text, connectionId = 'work') {
      persist(); save('system', text);
      previewConnections.tasks[task.id] = connectionId;
      agent({ sessionId: task.id, kind: 'note', text, data: { accountPool: { connectionId } } });
    },
    ordinary(text) { persist(); save('system', text); },
    tool() {
      persist();
      const tool = { id: 'pool-read-' + ++toolIndex, name: 'Read', status: 'completed', input: 'README.md', output: 'Local fixture output.' };
      save('tool', encodeTool(tool)); agent({ sessionId: task.id, kind: 'tool', text: 'Read completed', tool });
    },
    done() { persist(); finishTiming(task.id); task.status = 'idle'; task.taskStage = 'review'; agent({ sessionId: task.id, kind: 'done', text: '' }); },
    snapshot() { sessionStorage.setItem('pool-saved-fixture', JSON.stringify({ task, messages: rows })); },
    rows() { return structuredClone(rows); }
  };
  window.__latestPoolRun = task.id;
  agent({ sessionId: task.id, kind: 'status', text: 'Starting agent' });
};
`;
const switchProse = '“Claude Work” reached its usage limit, so this task continues on the default Claude account.';
const switchContent = 'Account switched\n' + switchProse;
const switchNote = (page: Page) => page.locator('#transcript details.account-switch-note[data-account-switch]');
async function startPoolTurn(page: Page): Promise<string> {
  await page.evaluate(() => { (window as any).__holdPoolTurn = true; });
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await expect(prompt).toBeEnabled(); await prompt.fill('Controlled account switch'); await prompt.press('Enter');
  await expect.poll(() => page.evaluate(() => (window as any).__latestPoolRun ?? '')).not.toBe('');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  const id = await page.evaluate(() => (window as any).__latestPoolRun);
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', id);
  await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeHidden();
  return id;
}

test('account switch stays compact live before done, survives later ticks and hands open focus to saved history', async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  const note = switchNote(page), summary = note.locator('summary');
  await expect(note).toHaveCount(1);
  await expect(summary).toHaveAccessibleName('Account switched');
  await expect(summary).toHaveText('Account switched');
  expect(await summary.getAttribute('title')).toBeNull();
  await expect(summary.locator('svg')).toHaveCount(2);
  await expect(note).not.toHaveAttribute('open');
  await expect(note.locator('p')).toHaveText(switchProse);
  await expect(note.locator('p')).toBeHidden();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  expect(await page.evaluate(id => (window as any).__poolRuns[id].rows().filter((row: any) => row.role === 'system'), id)).toMatchObject([{ content: switchContent }]);
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(note).toHaveAttribute('open'); await expect(summary).toBeFocused();
  for (const operation of ['push', 'tool', 'push']) {
    await page.evaluate(({ id, operation }) => (window as any).__poolRuns[id][operation]('Continued response. '), { id, operation });
    await expect(note).toHaveCount(1); await expect(note).toHaveAttribute('open'); await expect(summary).toBeFocused();
  }
  await expect(page.locator('#transcript .tool-trace')).toHaveCount(1);
  expect(await note.evaluate(node => !!node.closest('.turn-activity, .tool-trace, .message-error, .live-errors'))).toBe(false);
  await page.evaluate(id => (window as any).__poolRuns[id].done(), id);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(note).toHaveCount(1); await expect(note).toHaveAttribute('open'); await expect(summary).toBeFocused();
  await page.keyboard.press('Space'); await expect(note).not.toHaveAttribute('open');
  expect(errors).toEqual([]);
});


for (const initiallyOpen of [true, false]) test(`account switch activates Space exactly once across live-to-saved handoff from ${initiallyOpen ? 'open' : 'closed'}`, async ({ page }) => {
  const errors = await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  await page.evaluate(({ id, content }) => {
    const run = (window as any).__poolRuns[id]; run.note(content); run.push('Final response.');
  }, { id, content: switchContent });
  const note = switchNote(page), summary = note.locator('summary');
  await expect(note).toHaveCount(1);
  await expect(note).toHaveAttribute('data-account-switch', /:-\d+$/);
  await summary.focus();
  if (initiallyOpen) { await page.keyboard.press('Enter'); await expect(note).toHaveAttribute('open'); }
  else await expect(note).not.toHaveAttribute('open');
  const original = await note.elementHandle();
  await note.evaluate(node => {
    (window as any).__poolSpaceChanges = 0;
    new MutationObserver(records => { (window as any).__poolSpaceChanges += records.length; }).observe(node, { attributes: true, attributeFilter: ['open'] });
  });
  // Hold the real key through the DOM move; waiting until after done() misses WebKit's lost activation.
  await page.keyboard.down('Space');
  await page.evaluate(id => (window as any).__poolRuns[id].done(), id);
  await expect(note).toHaveAttribute('data-account-switch', /:\d+$/);
  expect(await note.evaluate(node => !!node.closest('#stream-region'))).toBe(false);
  expect(await note.evaluate((node, original) => node === original, original)).toBe(true);
  await expect(summary).toBeFocused();
  await page.keyboard.up('Space');
  await expect(note).toHaveJSProperty('open', !initiallyOpen);
  expect(await page.evaluate(() => (window as any).__poolSpaceChanges)).toBe(1);
  await expect(summary).toBeFocused();
  // Auto-repeat must neither toggle again nor leave a delayed native keyup activation.
  await page.keyboard.down('Space'); await page.keyboard.down('Space'); await page.keyboard.up('Space');
  await expect(note).toHaveJSProperty('open', initiallyOpen);
  expect(await page.evaluate(() => (window as any).__poolSpaceChanges)).toBe(2);
  await expect(summary).toBeFocused();
  const ignored = await summary.evaluate(summary => [
    { metaKey: true }, { ctrlKey: true }, { altKey: true }, { shiftKey: true }, { isComposing: true }, { keyCode: 229 },
  ].map(init => {
    const event = new KeyboardEvent('keydown', { key: ' ', bubbles: true, cancelable: true, ...init });
    summary.dispatchEvent(event); return event.defaultPrevented;
  }));
  expect(ignored).toEqual([false, false, false, false, false, false]);
  await page.keyboard.press('Tab'); await expect(summary).not.toBeFocused();
  await expect(note).toHaveJSProperty('open', initiallyOpen);
  expect(await page.evaluate(() => (window as any).__poolSpaceChanges)).toBe(2);
  await summary.click(); await expect(note).toHaveJSProperty('open', !initiallyOpen);
  await summary.focus(); await page.keyboard.press('Enter');
  await expect(note).toHaveJSProperty('open', initiallyOpen);
  expect(await page.evaluate(() => (window as any).__poolSpaceChanges)).toBe(4);
  expect(errors).toEqual([]);
});

test('account switch survives a midrun thread re-entry with an already persisted tail and a fresh mocked saved reload', async ({ page }) => {
  await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  const ordinary = 'A report was lost. <b>Keep this ordinary system note verbatim.</b>';
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  await expect(switchNote(page)).toHaveCount(1);
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await page.locator(`#navigation .task-item[data-id="${id}"]`).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', id);
  await expect(switchNote(page)).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(({ id, ordinary }) => {
    const run = (window as any).__poolRuns[id]; run.push('Continues after re-entry.'); run.tool(); run.push('Finished response.'); run.ordinary(ordinary); run.done(); run.snapshot();
  }, { id, ordinary });
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(switchNote(page)).toHaveCount(1);
  // Reload creates a new preview module; get_messages reads explicitly seeded rows, not the old live event.
  await page.reload();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', id);
  await expect.poll(async () => (await calls(page, 'get_messages')).some((call: any) => call.sessionId === id)).toBe(true);
  const note = switchNote(page);
  await expect(note).toHaveCount(1); await expect(note).not.toHaveAttribute('open');
  await expect(note.locator('summary')).toHaveAccessibleName('Account switched');
  await note.locator('summary').focus(); await page.keyboard.press('Space');
  await expect(note.locator('p')).toHaveText(switchProse);
  await expect(page.locator('#transcript .message-note')).toHaveText(ordinary);
  await expect(page.locator('#transcript .message-note b')).toHaveCount(0);
  await expect(page.locator('#transcript .message-error')).toHaveCount(0);
  await expect(page.locator('#transcript .tool-trace')).toHaveCount(1);
  expect(await note.evaluate(node => !!node.closest('.turn-activity, .tool-trace, .message-error'))).toBe(false);
});

for (const theme of ['dark', 'light']) test(`account switch fits a 260px tile at 160% in ${theme}, mirrors compactly and opens by keyboard`, async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 720 });
  await page.addInitScript(theme => { localStorage.setItem('pandacode.uiScale', '1.6'); localStorage.setItem('pandacode.theme', theme); }, theme);
  const from = '<b>研发 "Work" & private</b>' + '甲'.repeat(34);
  const to = '<img src=x onerror="boom">私用' + '乙'.repeat(32);
  expect([...from]).toHaveLength(60); expect([...to]).toHaveLength(60);
  const prose = `“${from}” reached its usage limit, so this task continues on “${to}”.`;
  await openApp(page, [connection('work', from, '/tmp/pandacode-switch-work'), connection('personal', to, '/tmp/pandacode-switch-personal')]);
  const id = await startPoolTurn(page);
  const hideInspector = async () => {
    if (await page.getByRole('button', { name: 'Hide inspector', exact: true }).isVisible()) await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
    // hidePanel closes the inspector's grid column only after its exit animation finishes.
    await expect(page.locator('#inspector')).toBeHidden();
    await expect(page.locator('.workspace')).toHaveClass(/inspector-closed/);
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  };
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: 'Account switched\n' + prose });
  await expect(switchNote(page)).toHaveCount(1);
  if (process.env.SWITCH_SHOTS) await page.screenshot({ path: `.pandacode/progress-shots/account-switch-main-${theme}.png`, animations: 'disabled' });
  // Open the other thread as the focused tile, leaving the running thread in its real mirror.
  await page.locator('#navigation .task-item[data-id="session-2"]').click({ modifiers: ['Meta'] });
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  await hideInspector();
  // Responsive sidebars can change width at a breakpoint; measure the resulting thread area again.
  for (let attempt = 0; attempt < 5; attempt++) {
    await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
    const width = await page.locator('.work-area').evaluate(node => node.clientWidth);
    if (width === 528) break;
    await page.setViewportSize({ width: page.viewportSize()!.width + 528 - width, height: 640 });
  }
  await expect.poll(() => page.locator('.work-area').evaluate(node => node.clientWidth)).toBe(528);
  const tile = page.locator(`.thread-tile[data-tile="${id}"]`), mirror = tile.locator('.thread-mirror');
  await expect(tile).toHaveCount(1);
  await expect.poll(() => tile.evaluate(node => Math.round(node.getBoundingClientRect().width))).toBe(260);
  const mirrored = mirror.locator('details.account-switch-note[data-account-switch]');
  await expect(mirrored).toHaveCount(1); await expect(mirrored).not.toHaveAttribute('open');
  await expect(mirrored.locator('summary')).toHaveText('Account switched');
  await tile.locator('.thread-tile-title').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', id);
  await hideInspector();
  const note = switchNote(page), summary = note.locator('summary');
  await expect(note).not.toHaveAttribute('open'); await expect(summary).toHaveAccessibleName('Account switched');
  expect(await summary.getAttribute('title')).toBeNull();
  const bounds = async () => note.evaluate(node => {
    const summary = node.querySelector('summary')!, rect = node.getBoundingClientRect(), pane = node.closest('.transcript')!.getBoundingClientRect();
    const children = [...summary.children].map(child => child.getBoundingClientRect()).filter(rect => rect.width && rect.height);
    const paragraph = node.querySelector('p')!, p = paragraph.getBoundingClientRect(), dock = document.querySelector('.action-dock')!.getBoundingClientRect();
    const dockOverlap = [summary.getBoundingClientRect(), ...(node.hasAttribute('open') ? [p] : [])].some(rect => rect.top < dock.bottom && rect.bottom > dock.top && rect.left < dock.right && rect.right > dock.left);
    return { dockOverlap, dock: dock.toJSON(), summary: summary.getBoundingClientRect().toJSON(), paragraph: p.toJSON(), width: rect.width, overflow: node.scrollWidth - node.clientWidth, summaryOverflow: summary.scrollWidth - summary.clientWidth,
      left: rect.left, right: rect.right, paneLeft: pane.left, paneRight: pane.right,
      overlaps: children.slice(1).some((rect, index) => children[index].right > rect.left + 1),
      detailOverflow: paragraph.scrollWidth - paragraph.clientWidth, detailLeft: p.left, detailRight: p.right };
  });
  for (const expanded of [false, true]) {
    if (expanded) { await summary.focus(); await page.keyboard.press('Enter'); await expect(note).toHaveAttribute('open'); await expect(summary).toBeFocused(); }
    const geometry = await bounds();
    expect(geometry.width).toBeLessThanOrEqual(260); expect(geometry.overflow).toBeLessThanOrEqual(1); expect(geometry.summaryOverflow).toBeLessThanOrEqual(1);
    expect(geometry.left).toBeGreaterThanOrEqual(geometry.paneLeft - 1); expect(geometry.right).toBeLessThanOrEqual(geometry.paneRight + 1); expect(geometry.overlaps).toBe(false); expect(geometry.dockOverlap, JSON.stringify(geometry)).toBe(false);
    if (expanded) { expect(geometry.detailOverflow).toBeLessThanOrEqual(1); expect(geometry.detailLeft).toBeGreaterThanOrEqual(geometry.left - 1); expect(geometry.detailRight).toBeLessThanOrEqual(geometry.right + 1); }
    if (expanded) await note.locator('p').scrollIntoViewIfNeeded();
    if (process.env.SWITCH_SHOTS) {
      await page.screenshot({ path: `.pandacode/progress-shots/account-switch-tile-${theme}-${expanded ? 'expanded' : 'collapsed'}.png`, animations: 'disabled' });
      if (expanded) {
        await note.evaluate(node => { const scroller = node.closest('.transcript')!; scroller.scrollTop = scroller.scrollHeight; });
        await page.screenshot({ path: `.pandacode/progress-shots/account-switch-tile-${theme}-expanded-tail.png`, animations: 'disabled' });
      }
    }
  }
  await expect(note.locator('p')).toHaveText(prose); await expect(note.locator('p img, p b')).toHaveCount(0);
  await page.evaluate(id => (window as any).__poolRuns[id].push('Still running after the disclosure opened.'), id);
  await expect(note).toHaveCount(1); await expect(note).toHaveAttribute('open'); await expect(summary).toBeFocused();
  await page.keyboard.press('Space'); await expect(note).not.toHaveAttribute('open');
});

test('account switches with identical prose stay distinct within a run and across turns without taking focus', async ({ page }) => {
  await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  const first = switchNote(page).first();
  await first.locator('summary').focus(); await page.keyboard.press('Enter');
  await page.evaluate(({ id, content }) => { const run = (window as any).__poolRuns[id]; run.push('Between switches.'); run.note(content); }, { id, content: switchContent });
  await expect(switchNote(page)).toHaveCount(2);
  await expect(first).toHaveAttribute('open'); await expect(first.locator('summary')).toBeFocused();
  await expect(switchNote(page).nth(1)).not.toHaveAttribute('open');
  await page.evaluate(id => { const run = (window as any).__poolRuns[id]; run.push('First turn complete.'); run.done(); }, id);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden();
  await expect(switchNote(page)).toHaveCount(2);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  const sent = (await calls(page, 'send_message')).length;
  await prompt.fill('Continue the same thread'); await prompt.press('Enter');
  await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(sent + 1);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  await expect(switchNote(page)).toHaveCount(3);
  expect(await switchNote(page).evaluateAll(nodes => new Set(nodes.map(node => node.getAttribute('data-account-switch'))).size)).toBe(3);
});


test('account switch in an inactive live mirror survives a turn boundary after its cached page was loaded', async ({ page }) => {
  await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  await page.locator('#navigation .task-item[data-id="session-2"]').click({ modifiers: ['Meta'] });
  const mirror = page.locator(`.thread-tile[data-tile="${id}"] .thread-mirror`);
  await expect(mirror.locator('.user-message')).toContainText('Controlled account switch');
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  const note = mirror.locator('details.account-switch-note[data-account-switch]');
  await expect(note).toHaveCount(1);
  await page.evaluate(id => {
    const w = window as any, run = w.__poolRuns[id]; run.push('First autonomous turn.'); run.tool();
    w.__emit('agent-event', { sessionId: id, kind: 'turn_changes', text: '', data: { turnChanges: { id: 'pool-boundary', files: [], additions: 0, deletions: 0, truncated: false, concurrent: false } } });
    run.push('Next autonomous turn.');
  }, id);
  await expect(mirror).toContainText('Next autonomous turn.');
  await expect(note).toHaveCount(1); await expect(note.locator('summary')).toHaveText('Account switched');
  expect(await note.evaluate(node => !!node.closest('.turn-activity, .tool-trace, .message-error'))).toBe(false);
});

test('account switch keeps its exact live node open and focused when an older page prepends equal prose', async ({ page }) => {
  await openApp(page, twoAccounts);
  const id = await startPoolTurn(page);
  await page.evaluate(({ id, content }) => {
    const w = window as any, at = Date.now() - 60_000;
    const row = (number: number, role: string, text: string) => ({ id: number, sessionId: id, role, content: text, createdAt: at + number });
    const latest = [row(100, 'user', 'Previous account switch'), row(101, 'system', content), row(102, 'assistant', 'Previous reply.')];
    for (let number = 110; number < 200; number += 10) latest.push(row(number, 'user', `Saved turn ${number}`), row(number + 1, 'assistant', 'Saved answer. '.repeat(30)));
    latest.push(row(200, 'user', 'Controlled account switch'));
    const older = [row(50, 'user', 'Older account switch'), row(51, 'system', content), row(52, 'assistant', 'Older reply.')];
    w.__testInvoke = (command: string, args: any) => {
      if (command !== 'get_messages' || args.sessionId !== id) return;
      if (args.beforeId) return new Promise(resolve => { w.__releasePoolHistory = () => resolve({ messages: older, hasOlder: false }); });
      return { messages: latest, hasOlder: true };
    };
  }, { id, content: switchContent });
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await page.locator(`#navigation .task-item[data-id="${id}"]`).click();
  const saved = page.locator(`details[data-account-switch="${id}:101"]`);
  await expect(saved).toHaveCount(1); await expect(saved).not.toHaveAttribute('open');
  await page.evaluate(({ id, content }) => (window as any).__poolRuns[id].note(content), { id, content: switchContent });
  const live = page.locator('#stream-region details.account-switch-note[data-account-switch]');
  await expect(live).toHaveCount(1);
  await live.locator('summary').focus(); await page.keyboard.press('Enter');
  const key = await live.getAttribute('data-account-switch'), node = await live.elementHandle();
  await expect(live).toHaveAttribute('open'); await expect(live.locator('summary')).toBeFocused();
  // Scrolling invokes the app's real older-page loader; the mock response waits until focus is established.
  await page.locator('#transcript').evaluate(element => { element.scrollTop = 0; element.dispatchEvent(new Event('scroll')); });
  await expect.poll(async () => (await calls(page, 'get_messages')).some((args: any) => args.sessionId === id && args.beforeId === 100)).toBe(true);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePoolHistory)).toBe('function');
  await page.evaluate(() => (window as any).__releasePoolHistory());
  const older = page.locator(`details[data-account-switch="${id}:51"]`);
  await expect(older).toHaveCount(1); await expect(older).not.toHaveAttribute('open');
  await expect(saved).not.toHaveAttribute('open');
  await expect(live).toHaveAttribute('data-account-switch', key!); await expect(live).toHaveAttribute('open'); await expect(live.locator('summary')).toBeFocused();
  expect(await node!.evaluate(node => node.isConnected)).toBe(true);
  expect(await live.evaluate((fresh, original) => fresh === original, node)).toBe(true);
  await expect(switchNote(page)).toHaveCount(3);
});
