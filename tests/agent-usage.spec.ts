import { expect, test, type Page } from '@playwright/test';

const installed = ['claude', 'codex', 'kimi', 'opencode', 'glm', 'grok', 'mimo', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'github-copilot', 'muse'];
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

async function openApp(page: Page, hold: string[] = [], failures: string[] = []): Promise<void> {
  await page.addInitScript(({ hold, failures, ledgerFixture }) => {
    const result = (provider: string, status: string, message: string | null = null) => ({
      provider, status, windows: [], plan: null, message, checkedAt: Date.now(), stale: false, source: null, dashboardUrl: null,
    });
    (window as any).__usageFixture = {
      hold, failures, calls: [], pending: [], ledgerCalls: [], ledgerError: null, ledger: ledgerFixture,
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
        kilo: result('kilo', 'unsupported', 'Kilo Code does not expose credits or limits through this agent.'),
        'github-copilot': result('github-copilot', 'unsupported', 'GitHub Copilot CLI does not expose usage limits through this agent.'),
        muse: result('muse', 'unsupported', 'Muse Code reports its usage windows only inside a running session.'),
      },
    };
  }, { hold, failures, ledgerFixture: ledger() });
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
      if (command === 'agent_usage') {
        const fixture = window.__usageFixture;
        fixture.calls.push(structuredClone(args));
        if (fixture.failures.includes(args.provider)) throw new Error('Usage service temporarily unavailable.');
        const result = structuredClone(fixture.responses[args.provider]);
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
  const shortWindow = codex.getByRole('progressbar', { name: 'Codex · 5-hour window', exact: true });
  await expect(shortWindow).toHaveAttribute('aria-valuenow', '35');
  await expect(shortWindow).toHaveAttribute('aria-valuemin', '0');
  await expect(shortWindow).toHaveAttribute('aria-valuemax', '100');
  await expect(codex.getByRole('progressbar', { name: 'Codex · Weekly window', exact: true })).toHaveAttribute('aria-valuenow', '68');
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
  await expect(card(page, 'MiMo Token Plan')).toContainText('Usage is not available for this MiMo account.');
  for (const name of ['Kimi Code', 'OpenCode', 'GLM Coding Plan', 'MiMo Token Plan']) {
    await expect(card(page, name).getByRole('progressbar')).toHaveCount(0);
  }
  await expect(refresh(page)).toBeDisabled();
  await expect(card(page, 'Codex').getByRole('progressbar')).toHaveCount(0);
  await release(page, 'codex');
  await tab(page, 'Codex').click();
  await expect(card(page, 'Codex').getByRole('progressbar').first()).toHaveAttribute('aria-valuenow', '35');
  await expect(refresh(page)).toBeEnabled();
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
    if (mode === 'board') await page.getByRole('button', { name: 'Board view', exact: true }).click();
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
