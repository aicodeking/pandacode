import { expect, test, type Page } from '@playwright/test';

const installed = ['claude', 'codex', 'kimi', 'opencode', 'glm', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes', 'cursor'];
const usageButton = (page: Page) => page.getByRole('button', { name: 'Agent usage', exact: true });
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Agent usage', exact: true });
const card = (page: Page, name: string) => dialog(page).locator('.usage-card').filter({ hasText: name });
const refresh = (page: Page) => dialog(page).getByRole('button', { name: 'Refresh usage', exact: true });
const calls = (page: Page): Promise<{ provider: string; refresh: boolean }[]> => page.evaluate(() => (window as any).__usageFixture.calls);
const tab = (page: Page, name: string) => dialog(page).getByRole('tab', { name, exact: true });
const hourOn = (daysBack: number, hour = 14) => { const now = new Date(); return Math.floor(new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysBack, hour).getTime() / 3_600_000); };
const ledger = () => ({
  scannedAt: Date.now(), pricing: { source: 'live', fetchedAt: Date.now() }, sources: [{ provider: 'claude', files: 3 }, { provider: 'codex', files: 2 }],
  models: [{ provider: 'claude', name: 'claude-opus-5-5', priced: true }, { provider: 'codex', name: 'gpt-6-astra', priced: true }, { provider: 'codex', name: 'codex-auto-review', priced: false }],
  rows: [[hourOn(0), 0, 1000, 90_000, 2000, 7000, 4.25, 3.1], [hourOn(2), 1, 5000, 40_000, 0, 5000, 1.5, 0.4], [hourOn(2), 2, 9000, 0, 0, 1000, 0, 0], [hourOn(60), 0, 100, 100, 0, 100, 20, 0]],
  sessions: [{ provider: 'claude', first: hourOn(3), last: hourOn(0) }, { provider: 'codex', first: hourOn(2), last: hourOn(2) }, { provider: 'claude', first: hourOn(60), last: hourOn(60) }],
});

async function openApp(page: Page, hold: string[] = [], failures: string[] = [], connections: unknown = null, pool: unknown = null): Promise<void> {
  await page.addInitScript(({ hold, failures, ledgerFixture, connections, pool }) => {
    const result = (provider: string, status: string, message: string | null = null) => ({
      provider, status, windows: [], plan: null, message, checkedAt: Date.now(), stale: false, source: null, dashboardUrl: null,
    });
    (window as any).__usageFixture = {
      hold, failures, calls: [], pending: [], ledgerCalls: [], ledgerError: null, ledger: ledgerFixture, connections, pool,
      prompts: [[Math.floor(Date.now() / 3_600_000), 'kimi', 4]],
      responses: {
        claude: {
          ...result('claude', 'ready'), plan: 'Max', source: 'Claude subscription',
          windows: [{ label: '5-hour window', usedPercent: 22, resetsAt: new Date(Date.now() + 3_600_000).toISOString(), detail: null }],
        },
        codex: {
          ...result('codex', 'ready'), plan: 'Pro', source: 'Codex account',
          windows: [
            { label: '5-hour window', usedPercent: 35, resetsAt: new Date(Date.now() + 7_200_000).toISOString(), detail: null },
            { label: 'Weekly window', usedPercent: 68, resetsAt: new Date(Date.now() + 172_800_000).toISOString(), detail: 'All models' },
          ],
        },
        kimi: result('kimi', 'signedOut', 'Sign in to Kimi Code to check usage.'),
        opencode: result('opencode', 'unsupported', 'OpenCode does not expose account usage.'),
        glm: result('glm', 'error', 'The GLM usage service is temporarily unavailable.'),
        grok: result('grok', 'unsupported', 'Grok Build does not expose account usage.'),
        mimo: result('mimo', 'unavailable', 'Usage is not available for this MiMo account.'),
        deepseek: { ...result('deepseek', 'ready', 'Balance CNY 110.00 (granted 10.00, topped up 100.00).'), source: 'DeepSeek balance API' },
        kilo: result('kilo', 'unsupported', 'Kilo Code does not expose credits or limits through this agent.'),
        'github-copilot': result('github-copilot', 'unsupported', 'GitHub Copilot CLI does not expose usage limits through this agent.'),
        muse: result('muse', 'unsupported', 'Muse Code reports its usage windows only inside a running session.'),
        devin: result('devin', 'unsupported', 'Devin does not expose plan limits through its ACP server.'),
        zcode: result('zcode', 'unsupported', 'ZCode does not expose plan limits through its app-server.'),
        cursor: result('cursor', 'unsupported', 'Cursor does not expose plan usage through its ACP server. Check usage in your Cursor dashboard.'),
      },
    };
  }, { hold, failures, ledgerFixture: ledger(), connections, pool });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      if (command === 'usage_ledger') {
        const fixture = window.__usageFixture;
        fixture.ledgerCalls.push(structuredClone(args));
        if (fixture.ledgerError) throw new Error(fixture.ledgerError);
        return structuredClone(fixture.ledger);
      }
      if (command === 'prompt_activity') return structuredClone(window.__usageFixture.prompts);
      if (command === 'agent_usage_asking_claude') {
        const { asking, saved } = window.__usageFixture;
        window.__usageFixture.waitingPolls = (window.__usageFixture.waitingPolls ?? 0) + 1;
        return Object.fromEntries(args.connections.map(id => [id, {
          asking: typeof asking === 'object' && asking ? Boolean(asking[id]) : Boolean(asking),
          saved: saved?.[id] ? structuredClone(saved[id]) : null,
        }]));
      }
      if (command === 'connections_list' && window.__usageFixture.connections) return structuredClone(window.__usageFixture.connections);
      if (command === 'account_pool_status' && window.__usageFixture.pool) return structuredClone(window.__usageFixture.pool[args.provider] ?? []);
      if (command === 'agent_usage') {
        const fixture = window.__usageFixture;
        fixture.calls.push(structuredClone(args));
        if (fixture.failures.includes(args.provider)) throw new Error('Usage service temporarily unavailable.');
        const result = structuredClone(fixture.responses[args.provider]);
        if (fixture.byConnection?.[args.connection]) return structuredClone(fixture.byConnection[args.connection]);
        if (args.connection === 'personal') result.windows = [{ label: '5-hour window', usedPercent: 97, resetsAt: null, detail: null }];
        if (args.connection === 'work') return { ...result, status: 'unavailable', windows: [], message: 'Claude is configured with an API key, custom endpoint, or environment credentials.' };
        if (fixture.hold.includes(args.provider)) return new Promise(resolve => {
          fixture.pending.push({ provider: args.provider, resolve, result });
        });
        return result;
      }
      switch (command) {
    `) });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}

async function openUsage(page: Page): Promise<void> {
  await usageButton(page).click();
  await expect(dialog(page)).toBeVisible();
}

async function release(page: Page, provider?: string): Promise<void> {
  await page.evaluate(async provider => {
    const fixture = (window as any).__usageFixture;
    const pending = fixture.pending.filter((entry: any) => !provider || entry.provider === provider);
    fixture.pending = fixture.pending.filter((entry: any) => provider && entry.provider !== provider);
    for (const entry of pending) entry.resolve(entry.result);
    // Let invoke and the panel's result handlers settle before checking the DOM.
    await new Promise(resolve => setTimeout(resolve, 0));
  }, provider);
}

test('Agent usage loads only on opening and reopening, with explicit used percentages and no polling', async ({ page }, testInfo) => {
  await page.clock.install();
  await openApp(page);
  await page.clock.fastForward(60_000);
  expect(await calls(page)).toEqual([]);
  await expect(page.locator('.sidebar-bottom > #agent-usage-button')).toBeVisible();
  await openUsage(page);
  await expect(refresh(page)).toBeEnabled();
  expect((await calls(page)).map(call => call.provider).sort()).toEqual([...installed].sort());
  expect((await calls(page)).every(call => call.refresh === false)).toBe(true);
  await expect(dialog(page).locator('.usage-card')).toHaveCount(installed.length);
  await expect(card(page, 'Antigravity')).toHaveCount(0);
  await expect(tab(page, 'Overview')).toHaveAttribute('aria-selected', 'true');
  // Claude peaks at 22% and Codex at 68%; agents without windows are left out of the average.
  await expect(dialog(page).locator('.usage-limit-hero')).toContainText('45%');
  await expect(dialog(page).locator('.usage-limit-hero')).toContainText('Across 2 agents');
  await tab(page, 'Codex').click();
  await expect(card(page, 'Codex')).toBeVisible();
  await expect(dialog(page).locator('.usage-overview')).toBeHidden();
  const codex = card(page, 'Codex');
  const shortWindow = codex.getByRole('progressbar', { name: 'Codex · 5-hour', exact: true });
  await expect(shortWindow).toHaveAttribute('aria-valuenow', '35');
  await expect(shortWindow).toHaveAttribute('aria-valuemin', '0');
  await expect(shortWindow).toHaveAttribute('aria-valuemax', '100');
  await expect(codex.getByRole('progressbar', { name: 'Codex · Weekly', exact: true })).toHaveAttribute('aria-valuenow', '68');
  await expect(codex).toContainText('35% used');
  await expect(codex).toContainText('68% used');
  await expect(codex).toContainText(/Resets/i);
  await expect(codex).toContainText('Pro');
  await page.screenshot({ path: testInfo.outputPath('agent-usage-desktop.png'), animations: 'disabled' });
  await page.clock.fastForward(300_000);
  expect(await calls(page)).toHaveLength(installed.length);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await page.clock.fastForward(300_000);
  expect(await calls(page)).toHaveLength(installed.length);
  await openUsage(page);
  await expect(refresh(page)).toBeEnabled();
  expect(await calls(page)).toHaveLength(installed.length * 2);
  expect((await calls(page)).every(call => call.refresh === false)).toBe(true);
});

test('Agent usage shows successful and unavailable cards while a different provider is still loading', async ({ page }) => {
  await openApp(page, ['codex']);
  await openUsage(page);
  await tab(page, 'Claude').click();
  await expect(card(page, 'Claude Code').getByRole('progressbar')).toHaveAttribute('aria-valuenow', '22');
  await expect(card(page, 'Kimi Code')).toContainText('Sign in to Kimi Code to check usage.');
  await expect(card(page, 'OpenCode')).toContainText('OpenCode does not expose account usage.');
  await expect(card(page, 'GLM Coding Plan')).toContainText('The GLM usage service is temporarily unavailable.');
  // Without a fix the backend names, an error stays "Unavailable".
  await expect(card(page, 'GLM Coding Plan').locator('.usage-state')).toHaveText('Unavailable');
  await expect(card(page, 'MiMo Token Plan')).toContainText('Usage is not available for this MiMo account.');
  await expect(card(page, 'DeepSeek')).toContainText('Balance CNY 110.00 (granted 10.00, topped up 100.00).');
  for (const name of ['Kimi Code', 'OpenCode', 'GLM Coding Plan', 'MiMo Token Plan', 'DeepSeek']) {
    await expect(card(page, name).getByRole('progressbar')).toHaveCount(0);
  }
  await expect(refresh(page)).toBeDisabled();
  await expect(card(page, 'Codex').getByRole('progressbar')).toHaveCount(0);
  await release(page, 'codex');
  await tab(page, 'Codex').click();
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '35');
  await expect(refresh(page)).toBeEnabled();
});

test('a rate-limited Claude card shows its saved snapshot with the date it was taken and when it is asked again', async ({ page }) => {
  // A fixed noon: the retry time is always on the same day, whenever the test runs.
  await page.clock.setFixedTime(new Date(2026, 10, 9, 12, 0));
  await openApp(page);
  const times = await page.evaluate(() => {
    const now = new Date();
    const taken = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 14, 5).getTime();
    const retry = Date.now() + 2 * 60_000;
    const automatic = Date.now() + 15 * 60_000;
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = {
      ...fixture.responses.claude, stale: true, checkedAt: taken, retryAt: retry, autoRetryAt: automatic, action: 'rateLimited',
      message: "Claude's usage service is rate limited; showing the last good reading.",
      windows: [{ label: 'Weekly', usedPercent: 37, resetsAt: null, detail: null }],
    };
    const time = (at: number) => new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
    return { taken: `${new Date(taken).toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${time(taken)}`, retry: time(retry), automatic: time(automatic) };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude).toHaveClass(/usage-stale/);
  await expect(claude.locator('.usage-card-checked')).toContainText(`Last success ${times.taken}`);
  await expect(claude.locator('.usage-state')).toHaveText('Saved · rate limited');
  await expect(claude).toContainText("Claude's usage service is rate limited; showing the last good reading.");
  // Refresh may ask after the server's own wait; opening the panel checks later.
  await expect(claude).toContainText(`Press Refresh after ${times.retry} to check again; opening this panel checks on its own after ${times.automatic}.`);
  await expect(claude.getByRole('progressbar')).toHaveAttribute('aria-valuenow', '37');
});

test('a rate-limited Claude card with no saved reading says "Rate limited", not "Needs refresh"', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 10, 9, 12, 0));
  await openApp(page);
  const retry = await page.evaluate(() => {
    const at = Date.now() + 60_000;
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'rateLimited', retryAt: at, autoRetryAt: at,
      message: "Claude's usage service is rate limited, and there is no earlier reading for this account." };
    return new Date(at).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText('Rate limited');
  await expect(claude).toContainText(`Press Refresh after ${retry} to check again.`);
  await expect(claude).not.toContainText('opening this panel');
});

test('an error is labelled by what fixes it: "Needs refresh", "Sign in via Claude Code", "Keychain locked"', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'refresh',
      message: "macOS didn't let PandaCode read Claude's login (denied or not answered). Press Refresh to try again; if macOS asks, choose Always Allow." };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText('Needs refresh');
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, action: 'claude', message: 'Open Claude Code to renew it, then refresh.' };
  });
  await refresh(page).click();
  await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText('Sign in via Claude Code');
  for (const [action, label] of [['unlock', 'Keychain locked'], ['apiConnection', 'Not your subscription'], ['retry', 'Temporary problem'], ['updateClaude', 'Update Claude Code'], ['expired', 'Login expired']]) {
    await page.evaluate((next) => {
      const fixture = (window as any).__usageFixture;
      fixture.responses.claude = { ...fixture.responses.claude, action: next };
    }, action);
    await refresh(page).click();
    await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText(label);
  }
  // A saved snapshot standing in names its cause; without one it is a plain snapshot.
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'ready', stale: true, action: 'claude',
      windows: [{ label: 'Weekly', usedPercent: 12, resetsAt: null, detail: null }] };
  });
  await refresh(page).click();
  await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText('Saved · sign in via Claude Code');
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, action: null };
  });
  await refresh(page).click();
  await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText('Saved snapshot');
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, stale: false, windows: [] };
  });
  // A sign-out keeps its own label even when Claude Code fixes it.
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'signedOut', action: 'claude' };
  });
  await refresh(page).click();
  await expect(card(page, 'Claude Code').locator('.usage-state')).toHaveText('Sign-in needed');
});

test('a fix PandaCode can start is a button: Refresh for a passing problem, Open Settings for an expired login with the switch off', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'retry', message: "Claude Code couldn't refresh the login. Try again later, or open Claude Code." };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText('Temporary problem');
  await expect(refresh(page)).toBeEnabled();
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, action: 'settings',
      message: 'Your Claude login has expired. Open Claude Code, or turn on Let PandaCode ask Claude Code for usage when it can’t read it in Settings.' };
  });
  await claude.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect.poll(async () => (await calls(page)).some(call => call.provider === 'claude' && call.refresh)).toBe(true);
  await expect(claude.locator('.usage-state')).toHaveText('Login expired');
  await expect(claude.getByRole('button', { name: 'Refresh', exact: true })).toHaveCount(0);
  await claude.getByRole('button', { name: 'Open Settings', exact: true }).click();
  await expect(page.locator('#claude-connection')).toHaveAttribute('open', '');
  await expect(page.locator('#claude-cli-refresh')).toBeFocused();
});

test('"Sign in via Claude Code" offers the sign-in command for its own config folder and names no retry times', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 10, 10, 12, 0));
  const connection = { id: 'personal', provider: 'claude', name: 'Claude Personal', args: [], env: {}, secretEnv: [], configDir: "/Users/sample/.claude-o'personal", revision: 1 };
  await openApp(page, [], [], { connections: [connection], tasks: {} });
  await page.evaluate(() => {
    (window as any).__copied = [];
    navigator.clipboard.writeText = async (text: string) => { (window as any).__copied.push(text); };
    const fixture = (window as any).__usageFixture;
    const next = Date.now() + 15 * 60_000;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'signedOut', windows: [], action: 'claude', retryAt: next, autoRetryAt: next,
      message: "Claude Code's login was refused. Sign in again in Claude Code (/login), then refresh." };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state').first()).toHaveText('Sign-in needed');
  await expect(claude).not.toContainText('Opening this panel');
  await expect(claude).not.toContainText('Press Refresh after');
  await expect(claude.locator('.usage-retry')).toHaveCount(0);
  const own = claude.locator('.usage-card-body').first();
  await expect(own).toContainText('Run claude auth login in a terminal, or /login in Claude Code, then press Refresh.');
  await expect(own.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
  await own.getByRole('button', { name: 'Copy command', exact: true }).click();
  // A connection signs in with its own config folder, quoted for the shell.
  const personal = claude.getByRole('region', { name: 'Claude Personal', exact: true });
  await personal.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__copied)).toEqual(['claude auth login', "CLAUDE_CONFIG_DIR='/Users/sample/.claude-o'\\''personal' claude auth login"]);
});

test('a Claude card waiting on a run of Claude Code says "Asking Claude Code…"', async ({ page }) => {
  await openApp(page, ['claude']);
  await page.evaluate(() => { (window as any).__usageFixture.asking = true; });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-card-body')).toHaveText('Asking Claude Code…');
  await release(page, 'claude');
  await expect(claude.locator('.usage-window')).toHaveCount(1);
  await expect(claude).not.toContainText('Asking Claude Code');
});

test('"Asking Claude Code…" shows only on the card whose setup is running it', async ({ page }) => {
  const connection = (id: string, name: string) => ({ id, provider: 'claude', name, args: [], env: {}, secretEnv: [], configDir: `/Users/sample/.claude-${id}`, revision: 1 });
  await openApp(page, ['claude'], [], { connections: [connection('personal', 'Claude Personal'), connection('work', 'Claude Work')], tasks: {} });
  await page.evaluate(() => { (window as any).__usageFixture.asking = { personal: true }; });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await page.waitForTimeout(1500);
  await expect(claude.locator('.usage-card-body').first()).toHaveText('Checking limits…');
  await release(page, 'claude');
  const personal = claude.getByRole('region', { name: 'Claude Personal', exact: true });
  await expect(personal.locator('.usage-card-body')).toHaveText('Asking Claude Code…');
  await expect(claude.getByRole('region', { name: 'Claude Work', exact: true }).locator('.usage-card-body')).toHaveText('Checking limits…');
  await expect(claude.locator('.usage-card-body').first()).not.toContainText('Asking');
  await release(page, 'claude');
});

test('an expired login Claude Code could not refresh says when opening the panel asks again, with a Refresh button', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 10, 10, 12, 0));
  await openApp(page);
  const at = await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    const next = Date.now() + 15 * 60_000;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'expired', autoRetryAt: next, message: "Claude Code couldn't refresh the login." };
    return new Date(next).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText('Login expired');
  await expect(claude).toContainText(`Opening this panel after ${at} will ask Claude Code again, or press Refresh.`);
  await expect(claude).not.toContainText('try again in');
  await expect(claude.getByRole('button', { name: 'Refresh', exact: true })).toBeVisible();
});

test('a connection card whose connection is gone gets its Refresh button back', async ({ page }) => {
  const connection = { id: 'personal', provider: 'claude', name: 'Claude Personal', args: [], env: {}, secretEnv: [], configDir: '/Users/sample/.claude-personal', revision: 1 };
  await openApp(page, [], [], { connections: [connection], tasks: {} });
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.byConnection = { personal: { ...fixture.responses.claude, status: 'error', windows: [], action: 'retry', message: 'PandaCode couldn\'t read Claude\'s login just now. Press Refresh to try again.' } };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const personal = card(page, 'Claude Code').getByRole('region', { name: 'Claude Personal', exact: true });
  const button = personal.getByRole('button', { name: 'Refresh', exact: true });
  await expect(button).toBeVisible();
  await personal.evaluate(section => { section.dataset.connection = 'gone'; });
  await button.click();
  await expect(button).toBeEnabled();
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  await expect(personal.locator('.usage-card-body')).not.toHaveAttribute('data-loading', 'true');
});

test("a card's own Refresh works while other providers are still loading", async ({ page }) => {
  await openApp(page, ['codex']);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'retry', message: 'PandaCode couldn\'t read Claude\'s login just now. Press Refresh to try again.' };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText('Temporary problem');
  await expect(refresh(page)).toBeDisabled();
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'ready', action: null, message: null, windows: [{ label: 'Weekly', usedPercent: 41, resetsAt: null, detail: null }] };
  });
  await claude.getByRole('button', { name: 'Refresh', exact: true }).click();
  await expect(claude.locator('.usage-window')).toHaveCount(1);
  expect((await calls(page)).filter(call => call.provider === 'claude').map(call => call.refresh)).toEqual([false, true]);
  await release(page, 'codex');
  await expect(refresh(page)).toBeEnabled();
});

test('once the extra Refresh is used, the card says "Next try after" until then, and Refresh still reads again', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 10, 12, 0) });
  await openApp(page);
  const at = await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    const next = Date.now() + 10 * 60_000;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'expired', retryAt: next, autoRetryAt: next, message: "Claude Code couldn't refresh the login." };
    return new Date(next).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText(`Next try after ${at}`);
  await expect(claude).toContainText(`Opening this panel after ${at} will ask Claude Code again.`);
  const button = claude.getByRole('button', { name: 'Refresh', exact: true });
  await expect(button).toBeEnabled();
  await page.clock.fastForward(10 * 60_000 + 1000);
  await expect(claude.locator('.usage-state')).toHaveText('Login expired');
  // The time has passed: no stale "Opening this panel after…" line is left.
  await expect(claude).not.toContainText('Opening this panel after');
  await expect(claude.locator('.usage-retry')).toHaveCount(0);
  // The card's Refresh reads the login and the service again at any time.
  await expect(refresh(page)).toBeEnabled();
  await button.click();
  await expect.poll(async () => (await calls(page)).some(call => call.provider === 'claude' && call.refresh)).toBe(true);
});

test('a locked Keychain card has a Refresh button', async ({ page }) => {
  await openApp(page);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'unlock', message: "Your login Keychain is locked, so PandaCode can't read Claude's login. Unlock it, then refresh." };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-state')).toHaveText('Keychain locked');
  await expect(claude.getByRole('button', { name: 'Refresh', exact: true })).toBeEnabled();
});

test('a reading Claude Code printed shows its reset text when no reset time is known, unless that date has passed', async ({ page }) => {
  await page.clock.setFixedTime(new Date(2026, 10, 10, 12, 0));
  await openApp(page);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'ready', source: 'Claude Code CLI', windows: [
      { label: 'Weekly', usedPercent: 48, resetsAt: null, detail: 'Resets Nov 15 at 8pm (America/New_York)' },
      { label: 'Weekly · Sonnet', usedPercent: 7, resetsAt: null, detail: null },
    ] };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const resets = card(page, 'Claude Code').locator('.usage-reset');
  await expect(resets.nth(0)).toHaveText('Resets Nov 15 at 8pm (America/New_York)');
  await expect(resets.nth(1)).toContainText('Reset time not reported');
  // Nov 9 has passed: that stale reset text is not shown; a time without a date stays.
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, windows: [
      { label: 'Weekly', usedPercent: 48, resetsAt: null, detail: 'Resets Nov 9 at 8pm (America/New_York)' },
      { label: '5 hours', usedPercent: 12, resetsAt: null, detail: 'Resets 3pm (America/New_York)' },
    ] };
  });
  await refresh(page).click();
  await expect(resets.nth(0)).toContainText('Reset time not reported');
  await expect(resets.nth(1)).toHaveText('Resets 3pm (America/New_York)');
});

test('while a Claude check runs its saved reading shows at once, with the checking line under it', async ({ page }) => {
  await openApp(page, ['claude']);
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.saved = { '': { ...fixture.responses.claude, status: 'ready', stale: true, checkedAt: Date.now() - 3_600_000, windows: [{ label: 'Weekly', usedPercent: 21, resetsAt: null, detail: null }] } };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-window')).toHaveCount(1);
  await expect(claude.locator('.usage-window')).toContainText('21%');
  await expect(claude.locator('.usage-state')).toHaveText('Saved snapshot');
  await expect(claude.locator('.usage-checking')).toHaveText('Checking limits…');
  await page.evaluate(() => { (window as any).__usageFixture.asking = true; });
  await expect(claude.locator('.usage-checking')).toHaveText('Asking Claude Code…');
  await release(page, 'claude');
  await expect(claude.locator('.usage-checking')).toHaveCount(0);
  await expect(claude.locator('.usage-state')).toHaveCount(0);
  // One poll served the card; none is left running once it settled.
  const polls = await page.evaluate(() => (window as any).__usageFixture.waitingPolls);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__usageFixture.waitingPolls)).toBe(polls);
});

test('a rate limit with no reading gets a Refresh once the server\'s wait ends; Update Claude Code offers its command', async ({ page }) => {
  await page.clock.install({ time: new Date(2026, 10, 10, 12, 0) });
  await openApp(page);
  await page.evaluate(() => {
    (window as any).__copied = [];
    navigator.clipboard.writeText = async (text: string) => { (window as any).__copied.push(text); };
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, status: 'error', windows: [], action: 'rateLimited', retryAt: Date.now() + 60_000, autoRetryAt: Date.now() + 300_000,
      message: "Claude's usage service is rate limited, and there is no earlier reading for this account." };
  });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  const button = claude.getByRole('button', { name: 'Refresh', exact: true });
  await expect(button).toBeDisabled();
  await page.clock.fastForward(61_000);
  await expect(button).toBeEnabled();
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude = { ...fixture.responses.claude, action: 'updateClaude', retryAt: null, autoRetryAt: null, message: 'Update Claude Code to let PandaCode refresh an expired login.' };
  });
  await button.click();
  await expect(claude.locator('.usage-state')).toHaveText('Update Claude Code');
  await expect(claude).toContainText('Run claude update in a terminal, then press Refresh.');
  await claude.getByRole('button', { name: 'Copy command', exact: true }).click();
  await expect(claude.getByRole('button', { name: 'Copied', exact: true })).toBeVisible();
  expect(await page.evaluate(() => (window as any).__copied)).toEqual(['claude update']);
});

test('Agent usage refresh bypasses cached results and stays disabled until every provider settles', async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  await expect(refresh(page)).toBeEnabled();
  await tab(page, 'Codex').click();
  await page.evaluate(installed => {
    const fixture = (window as any).__usageFixture;
    fixture.hold = installed;
    fixture.responses.codex.windows[0].usedPercent = 72;
  }, installed);
  await refresh(page).click();
  await expect(refresh(page)).toBeDisabled();
  // Only three provider requests may be in flight; remaining accounts queue.
  await expect.poll(() => calls(page)).toHaveLength(installed.length + 3);
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '35');
  await release(page, 'codex');
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '72');
  await expect(refresh(page)).toBeDisabled();
  await expect.poll(() => calls(page)).toHaveLength(installed.length + 4);
  await page.evaluate(() => { (window as any).__usageFixture.hold = []; });
  await release(page);
  await expect(refresh(page)).toBeEnabled();
  expect(await calls(page)).toHaveLength(installed.length * 2);
  const forced = (await calls(page)).slice(installed.length);
  expect(forced.map(call => call.provider).sort()).toEqual([...installed].sort());
  expect(forced.every(call => call.refresh === true)).toBe(true);
  expect(await page.evaluate(() => (window as any).__usageFixture.ledgerCalls)).toEqual([{ refresh: false }, { refresh: true }]);
});

test('Agent usage isolates a failed IPC request and recovers on refresh', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openApp(page, [], ['codex']);
  await openUsage(page);
  await tab(page, 'Codex').click();
  await expect(card(page, 'Codex')).toContainText('Could not read limits. Try Refresh.');
  await expect(card(page, 'Codex').getByRole('progressbar')).toHaveCount(0);
  await expect(card(page, 'Claude Code')).toContainText('22% used');
  await expect(refresh(page)).toBeEnabled();
  await page.evaluate(() => { (window as any).__usageFixture.failures = []; });
  await refresh(page).click();
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '35');
  await expect(card(page, 'Codex')).not.toContainText('Could not read limits. Try Refresh.');
  await expect(refresh(page)).toBeEnabled();
  expect(errors).toEqual([]);
});

test('Agent usage ignores responses from a closed panel after a new panel has loaded', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await openApp(page, installed);
  await openUsage(page);
  await expect(refresh(page)).toBeDisabled();
  await expect.poll(() => calls(page)).toHaveLength(3);
  await page.keyboard.press('Escape');
  await expect(dialog(page)).toBeHidden();
  await page.evaluate(() => {
    const fixture = (window as any).__usageFixture;
    fixture.hold = [];
    fixture.responses.codex.windows[0].usedPercent = 72;
  });
  await openUsage(page);
  await expect(refresh(page)).toBeEnabled();
  await tab(page, 'Codex').click();
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '72');
  const current = await dialog(page).innerText();
  await release(page);
  await expect(dialog(page)).toHaveText(current, { useInnerText: true });
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '72');
  await expect(refresh(page)).toBeEnabled();
  // The closed panel must not start its four queued requests after these settle.
  expect(await calls(page)).toHaveLength(installed.length + 3);
  expect(errors).toEqual([]);
});

test('Agent usage remains reachable in the sidebar, collapsed header, and board at 140% text size', async ({ page }, testInfo) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.4'));
  await openApp(page);
  for (const mode of ['sidebar', 'collapsed', 'board']) {
    if (mode === 'collapsed') await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    if (mode === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
    await expect(usageButton(page)).toHaveCount(1);
    await expect(usageButton(page)).toBeVisible();
    await expect(usageButton(page)).toHaveAttribute('id', 'agent-usage-button');
    const buttonBounds = (await usageButton(page).boundingBox())!;
    expect(buttonBounds.x).toBeGreaterThanOrEqual(0);
    expect(buttonBounds.x + buttonBounds.width).toBeLessThanOrEqual(460);
    expect(buttonBounds.y + buttonBounds.height).toBeLessThanOrEqual(740);
    await usageButton(page).focus();
    await page.keyboard.press('Enter');
    await expect(dialog(page)).toBeVisible();
    await expect(refresh(page)).toBeEnabled();
    const bounds = (await dialog(page).boundingBox())!;
    expect(bounds.x).toBeGreaterThanOrEqual(0);
    expect(bounds.y).toBeGreaterThanOrEqual(0);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(460);
    expect(bounds.y + bounds.height).toBeLessThanOrEqual(740);
    expect(await dialog(page).evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
    const cards = await dialog(page).locator('.usage-panel:not([hidden]), .usage-toolbar, .usage-agent-row').evaluateAll(nodes => nodes.map(node => {
      const bounds = node.getBoundingClientRect();
      return { name: node.className, left: bounds.left, right: bounds.right, overflow: node.scrollWidth - node.clientWidth };
    }));
    expect(cards.length).toBeGreaterThan(installed.length);
    for (const usage of cards) {
      expect(usage.left).toBeGreaterThanOrEqual(bounds.x - 1);
      expect(usage.right).toBeLessThanOrEqual(bounds.x + bounds.width + 1);
      expect(usage.overflow, JSON.stringify(cards.filter(card => card.overflow > 1))).toBeLessThanOrEqual(1);
    }
    await page.screenshot({ path: testInfo.outputPath(`agent-usage-${mode}-140pct.png`), animations: 'disabled' });
    await page.keyboard.press('Escape');
    await expect(dialog(page)).toBeHidden();
  }
});

test('Agent usage estimates API cost by range, agent, model, and day from local logs', async ({ page }) => {
  await openApp(page);
  await openUsage(page);
  const overview = dialog(page).locator('.usage-overview');
  await expect(overview.locator('.usage-cost-hero')).toContainText('$5.75');
  await expect(overview.locator('.usage-cost-hero')).toContainText('2 sessions · past 30 days');
  await expect(overview.locator('.usage-cost-hero')).toContainText('unpriced tokens');
  const claudeRow = overview.getByRole('button', { name: /^Claude Code\. \$4\.25 estimated/ });
  await expect(claudeRow).toContainText('73.9% of cost');
  await expect(overview.getByRole('button', { name: /^Kimi Code\./ })).toContainText('Cost not tracked');
  await expect(overview.locator('.usage-totals')).toContainText('Cache savings');
  await expect(overview.locator('.usage-totals')).toContainText('$3.50');
  const table = overview.locator('.usage-breakdown');
  await expect(table.locator('tbody tr')).toHaveCount(3);
  await expect(table.locator('tbody tr').first()).toContainText('claude-opus-5-5');
  await expect(table.locator('tbody tr').last()).toContainText('unpriced');
  // Re-rendering the table keeps keyboard focus on the switch that was used.
  await overview.getByRole('button', { name: 'Day', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(overview.getByRole('button', { name: 'Day', exact: true })).toBeFocused();
  await expect(table.locator('tbody tr')).toHaveCount(2);
  await overview.getByRole('button', { name: 'Week', exact: true }).click();
  await expect(overview.locator('.usage-cost-hero')).toContainText('past 7 days');
  await overview.getByRole('button', { name: 'Year', exact: true }).click();
  await expect(overview.locator('.usage-cost-hero')).toContainText('$25.75');
  await expect(overview.locator('.usage-chart-section h3')).toHaveText('Weekly cost');
  const chart = overview.getByRole('img', { name: /Estimated API cost over time/ });
  await chart.focus(); await page.keyboard.press('End');
  await expect(overview.locator('.cost-chart-readout')).toContainText('$4.25');
  await overview.getByRole('button', { name: /^Claude Code\. \$24\.25 estimated/ }).click();
  await expect(tab(page, 'Claude')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page, 'Claude')).toBeFocused();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-agent-cost-section')).toContainText('$24.25');
  await expect(claude.getByRole('listbox', { name: 'Claude Code daily tokens' })).toBeVisible();
  await tab(page, 'Kimi').click();
  await expect(card(page, 'Kimi Code').getByRole('listbox', { name: 'Kimi Code daily prompts' })).toBeVisible();
  await expect(card(page, 'Kimi Code').locator('.heatmap-readout')).toContainText('4 prompts');
  await page.keyboard.press('ArrowRight');
  await expect(tab(page, 'OpenCode')).toBeFocused();
  await expect(card(page, 'OpenCode')).toContainText('No activity recorded for this agent yet.');
});

test('Agent usage keeps limits working when local logs cannot be read', async ({ page }) => {
  await page.addInitScript(() => { const wait = setInterval(() => { const fixture = (window as any).__usageFixture; if (fixture) { fixture.ledgerError = 'Reading agent logs took too long. Try again later.'; clearInterval(wait); } }, 0); });
  await openApp(page);
  await openUsage(page);
  await expect(dialog(page).locator('.usage-cost-hero').getByRole('alert')).toHaveText('Reading agent logs took too long. Try again later.');
  await expect(dialog(page).locator('.usage-limit-hero')).toContainText('45%');
  await expect(dialog(page).locator('.cost-chart')).toHaveCount(0);
});

test('each named connection shows its own limits under its harness', async ({ page }) => {
  const connection = (id: string, name: string) => ({ id, provider: 'claude', name, args: [], env: {}, secretEnv: [], configDir: `/Users/sample/.claude-${id}`, revision: 1 });
  await openApp(page, [], [], { connections: [connection('personal', 'Claude Personal'), connection('work', 'Claude Work')], tasks: {} });
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  await expect(claude.locator('.usage-connection-default')).toContainText('Default setup');
  const personal = claude.getByRole('region', { name: 'Claude Personal', exact: true });
  await expect(personal.getByRole('progressbar', { name: 'Claude Personal · 5-hour' })).toHaveAttribute('aria-valuenow', '97');
  await expect(claude.getByRole('region', { name: 'Claude Work', exact: true })).toContainText('API key');
  // The default setup and each connection are separate checks, read by connection id.
  await expect.poll(async () => (await calls(page)).filter(call => call.provider === 'claude').map(call => (call as any).connection ?? null)).toEqual([null, 'personal', 'work']);
});

test('Claude Code and Codex accounts show email, plan and accessible pool state', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  const connection = (id: string, name: string) => ({ id, provider: 'claude', name, args: [], env: {}, secretEnv: [], configDir: `/Users/sample/.claude-${id}`, revision: 1 });
  const member = (id: string, extra: object) => ({ id, email: null, plan: null, signedIn: true, excluded: false, sameAs: null, limitedUntil: null, limitedWindow: null, nearUntil: null, active: 0, ...extra });
  const tomorrow = Date.now() + 86_400_000, threeDays = Date.now() + 3 * 86_400_000;
  const names = ['personal', 'work', 'spare', 'shared', 'off', 'capped'];
  await openApp(page, [], [], { connections: names.map(id => connection(id, `Claude ${id[0].toUpperCase()}${id.slice(1)}`)), tasks: {}, pools: ['claude'] }, {
    claude: [
      // The pool still remembers a near-limit warning, but fresh usage (64% at most) says otherwise.
      member('', { email: 'me@example.com', plan: 'Pro', nearUntil: Date.now() + 1_800_000 }),
      member('personal', { email: '<b>personal</b>@example.com', limitedUntil: tomorrow, limitedWindow: 'seven_day' }),
      member('work', { email: 'work@example.com', plan: 'Max', signedIn: false }),
      member('spare', { email: 'spare@example.com' }),
      member('shared', { sameAs: '' }),
      member('off', { excluded: true }),
      member('capped', { limitedUntil: Date.now() + 1_800_000 }),
    ],
    codex: [member('', { email: 'codex@example.com', plan: 'Plus' })],
  });
  await page.evaluate(at => {
    const fixture = (window as any).__usageFixture;
    fixture.responses.claude.windows.push({ label: 'Weekly window', usedPercent: 64, resetsAt: new Date(at).toISOString(), detail: null }, { label: 'Weekly · Sonnet', usedPercent: 99, resetsAt: null, detail: null });
    fixture.byConnection = {
      spare: { ...fixture.responses.claude, windows: [{ label: '5-hour window', usedPercent: 92, resetsAt: null, detail: 'Shared with claude.ai' }] },
      capped: { ...fixture.responses.claude, windows: [{ label: '5-hour window', usedPercent: 100, resetsAt: null, detail: null }, { label: 'Weekly window', usedPercent: 40, resetsAt: null, detail: null }] },
    };
  }, threeDays);
  await openUsage(page);
  await tab(page, 'Claude').click();
  const claude = card(page, 'Claude Code');
  const heading = (id: string) => claude.locator(`.usage-account-heading[data-account="${id}"]`);
  const chip = (id: string) => heading(id).locator('.usage-pool-chip');
  const dot = (id: string) => heading(id).locator('[data-status]');
  const weekday = (at: number) => page.evaluate(at => new Date(at).toLocaleDateString([], { weekday: 'short' }), at);
  // Default setup: email · the login's own plan (agent_usage's only when the login has none, as in Settings); the same
  // two windows as Settings; fresh usage wins over the stale warning.
  await expect(heading('').getByRole('heading', { name: 'Default setup · Pro', exact: true })).toBeVisible();
  await expect(heading('').locator('.usage-account-who')).toHaveText('me@example.com');
  await expect(claude.locator(':scope > .usage-card-body').getByRole('progressbar')).toHaveCount(2);
  await expect(claude.getByRole('progressbar', { name: 'Claude Code · Weekly', exact: true })).toHaveAttribute('aria-valuenow', '64');
  await expect(chip('')).toHaveAttribute('aria-label', 'Ready');
  await expect(dot('')).toHaveAttribute('data-account-state', 'ready');
  // Ready accounts have no summary line: it would only repeat the meters.
  await expect(heading('').locator('.usage-account-summary')).toHaveText('');
  // Limits name their window; emails are text, never markup.
  await expect(heading('personal').locator('.usage-account-who')).toHaveText('<b>personal</b>@example.com');
  await expect(chip('personal')).toHaveAttribute('aria-label', new RegExp(`^Weekly limit · until ${await weekday(tomorrow)} \\d`));
  await expect(dot('personal')).toHaveAttribute('data-account-state', 'limited');
  await expect(heading('personal').locator('.usage-account-summary')).toHaveText('');
  await expect(chip('capped')).toHaveAttribute('aria-label', /^Limit · until /);
  await expect(chip('spare')).toHaveAttribute('aria-label', 'Near limit');
  await expect(dot('spare')).toHaveAttribute('data-account-state', 'near');
  // 92 % is amber like its Near limit chip; only a full window, or the one holding the account, is red.
  await expect(claude.locator('.usage-connection[data-connection="spare"] .usage-window')).toHaveAttribute('data-tone', 'warn');
  const capped = claude.locator('.usage-connection[data-connection="capped"] .usage-window');
  await expect(capped.nth(0)).toHaveAttribute('data-tone', 'danger');
  await expect(capped.nth(1)).toHaveAttribute('data-tone', 'normal');
  // The held weekly window is not the 97 % 5-hour one, so that meter stays amber.
  await expect(claude.locator('.usage-connection[data-connection="personal"] .usage-window')).toHaveAttribute('data-tone', 'warn');
  // A window's detail rides on its reset text; the card keeps a single ⓘ (the source, in its header).
  await expect(claude.locator('.usage-window .info-mark')).toHaveCount(0);
  const spareReset = claude.locator('.usage-connection[data-connection="spare"] .usage-reset');
  await expect(spareReset.locator('span[title]')).toHaveAttribute('title', 'Shared with claude.ai');
  // Keyboard and screen-reader users get the detail too, as visually hidden text.
  await expect(spareReset.locator('.sr-only')).toHaveText('. Shared with claude.ai');
  await expect(heading('spare').locator('.usage-account-summary')).toHaveText('');
  // A same-login connection is not read again; one line points to the account it shares.
  const shared = claude.locator('.usage-connection[data-connection="shared"]');
  await expect(shared.locator('.usage-same-login')).toHaveText('Same login as Default setup. Its usage is shown there.');
  await expect(shared.getByRole('progressbar')).toHaveCount(0);
  await expect(heading('shared').locator('.usage-account-summary')).toHaveText('');
  await expect(claude.locator(':scope > .usage-card-heading .info-mark')).toHaveCount(1);
  // Neutral states carry no tone: amber only means close to a limit.
  for (const [id, text] of [['work', 'Not signed in'], ['shared', 'Same login'], ['off', 'Left out']]) {
    await expect(chip(id)).toHaveAttribute('aria-label', text);
    await expect(dot(id)).toHaveAttribute('data-account-state', 'neutral');
  }
  // A signed-out account is never checked; it points to Settings → Providers, with no plan.
  const work = claude.locator('.usage-connection[data-connection="work"]');
  await expect(work.locator('.usage-signed-out')).toHaveText(/^\s*Sign in from Settings → Providers\.\s*Open Settings\s*$/);
  await expect(heading('work').locator('.usage-account-who')).toHaveText('Not signed in');
  await expect(work.getByRole('progressbar')).toHaveCount(0);
  await expect.poll(async () => (await calls(page)).filter(call => call.provider === 'claude').map(call => (call as any).connection ?? null)).toEqual([null, 'personal', 'spare', 'off', 'capped']);
  // One "Checked" time per harness card, in its header.
  await expect(claude.getByText(/^Checked \d/)).toHaveCount(1);
  await expect(claude.locator(':scope > .usage-card-heading')).toContainText(/Checked \d/);
  await expect(claude.locator('b')).toHaveCount(0);
  // Codex has no named accounts and pooling is off: identity and accessible status still show.
  await tab(page, 'Codex').click();
  const codex = card(page, 'Codex');
  await expect(codex.getByRole('heading', { name: 'Default setup · Plus', exact: true })).toBeVisible();
  await expect(codex.locator('.usage-account-who')).toHaveText('codex@example.com');
  await expect(codex.locator('.usage-account-summary')).toHaveText('');
  await expect(codex.locator('.usage-pool-chip')).toHaveAttribute('aria-label', 'Ready');
  // Other harnesses keep their plan pill and no account rows.
  await tab(page, 'Kimi').click();
  await expect(card(page, 'Kimi').locator('.usage-account-heading')).toHaveCount(0);
  // Open Settings lands on Settings → Providers.
  await tab(page, 'Claude').click();
  await work.getByRole('button', { name: 'Open Settings' }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#settings-panel-providers')).toBeVisible();
  expect(errors).toEqual([]);
});

test('Agent usage populated narrow accounts keep full identity and status accessible through refresh', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.4'));
  const email = `${'a'.repeat(104)}@example.invalid`;
  const name = 'Research subscription account '.repeat(4);
  const member = (id: string, extra: object = {}) => ({ id, email: null, plan: null, signedIn: true, excluded: false, sameAs: null, limitedUntil: null, nearUntil: null, active: 0, ...extra });
  await openApp(page, [], [], { connections: [{ id: 'long', provider: 'codex', name, configDir: '/tmp/codex-example', env: {}, secretEnv: [], args: [], revision: 1 }], pools: ['codex'], tasks: {} }, {
    claude: [member('', { email: 'local@example.invalid' })],
    codex: [member('', { email: 'default@example.invalid' }), member('long')],
  });
  await page.evaluate(email => { const f = (window as any).__usageFixture; f.byConnection = { long: { ...f.responses.codex, email, windows: [{ label: 'Weekly', usedPercent: 93, resetsAt: null }] } }; }, email);
  await openUsage(page); await tab(page, 'Codex').click();
  const heading = dialog(page).locator('.usage-account-heading[data-account="long"]');
  await expect(heading.locator('.usage-account-who')).toHaveText(email);
  await expect(heading.locator('.usage-pool-chip')).toHaveAttribute('aria-label', 'Near limit');
  await heading.scrollIntoViewIfNeeded();
  const geometry = await heading.evaluate(node => {
    const r = node.getBoundingClientRect(), status = node.querySelector('.usage-pool-chip')!.getBoundingClientRect();
    return { left: r.left, right: r.right, statusRight: status.right, overflow: node.scrollWidth - node.clientWidth };
  });
  expect(geometry.left).toBeGreaterThanOrEqual(0); expect(geometry.right).toBeLessThanOrEqual(461);
  expect(geometry.statusRight).toBeLessThanOrEqual(geometry.right + 1); expect(geometry.overflow).toBeLessThanOrEqual(1);
  if (process.env.POOL_SHOTS) await page.screenshot({ path: '.pandacode/progress-shots/pooling-usage-narrow.png', animations: 'disabled' });
  for (const [extra, label] of [
    [{ excluded: true }, 'Left out'],
    [{ signedIn: false }, 'Not signed in'],
    [{ sameAs: '' }, 'Same login'],
    [{ limitedUntil: Date.now() + 3_600_000, limitedWindow: 'seven_day' }, /^Weekly limit/],
    [{}, 'Ready'],
  ] as const) {
    await page.evaluate(({ extra }) => { const f = (window as any).__usageFixture; Object.assign(f.pool.codex[1], { excluded: false, signedIn: true, sameAs: null, limitedUntil: null, email: 'refreshed@example.invalid' }, extra); f.byConnection.long.windows[0].usedPercent = 22; }, { extra });
    await refresh(page).scrollIntoViewIfNeeded(); await refresh(page).focus(); await page.keyboard.press('Enter');
    await expect(refresh(page)).toBeEnabled(); await expect(refresh(page)).toBeFocused();
    await expect(heading.locator('.usage-pool-chip')).toHaveAttribute('aria-label', label);
  }
  await expect(heading.locator('.usage-account-who')).toHaveText('refreshed@example.invalid');
  await page.evaluate(() => { const f = (window as any).__usageFixture; f.pool.codex[1].email = null; Object.assign(f.byConnection.long, { status: 'unavailable', email: 'account.read@example.invalid', windows: [] }); });
  await refresh(page).click(); await expect(refresh(page)).toBeEnabled();
  await expect(heading.locator('.usage-account-who')).toHaveText('account.read@example.invalid');
  // No speculative per-account identity query: each refresh reads that account's existing usage command once.
  expect((await calls(page)).filter((c: any) => c.provider === 'codex' && c.connection === 'long')).toHaveLength(5);
});

test('Agent usage fresh sign-out overrides a locally signed-in default identity', async ({ page }) => {
  await openApp(page, [], [], { connections: [], tasks: {}, pools: [] }, {
    codex: [{ id: '', email: 'old@example.invalid', plan: 'Plus', signedIn: true, excluded: false, sameAs: null, nearUntil: null, limitedUntil: null, active: 0 }],
  });
  await page.evaluate(() => { const f = (window as any).__usageFixture; Object.assign(f.responses.codex, { status: 'signedOut', email: null, windows: [], plan: null }); });
  await openUsage(page); await tab(page, 'Codex').click();
  const heading = dialog(page).locator('#usage-panel-codex .usage-account-heading[data-account=""]');
  await expect(heading.locator('[data-status]')).toHaveAttribute('aria-label', 'Not signed in');
  await expect(heading.locator('.usage-account-who')).not.toContainText('old@example.invalid');
  await expect(card(page, 'Codex').getByRole('progressbar')).toHaveCount(0);
});
