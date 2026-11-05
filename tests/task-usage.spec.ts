import { expect, test, type Page } from '@playwright/test';

const total = (page: Page) => page.locator('.task-usage-button');
const panel = (page: Page) => page.getByRole('dialog', { name: 'Task usage', exact: true });
const fixture = {
  input: 100000, cacheRead: 20000, cacheWrite: 5000, output: 3000,
  firstUsed: 1, lastUsed: 2, costUsd: 0.42, unpricedTokens: 0, missingSessions: 0,
  models: [{ provider: 'codex', model: 'model-a', tokens: 100000, costUsd: 0.3 }, { provider: 'claude', model: 'model-b', tokens: 28000, costUsd: 0.12 }],
  pricing: { source: 'bundled', fetchedAt: null },
};

async function open(page: Page, value: unknown = fixture, theme = 'dark') {
  await page.addInitScript(({ value, theme }) => {
    localStorage.setItem('pandacode.theme', theme);
    (window as any).__taskUsage = value;
  }, { value, theme });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = (await response.text()).replace(/switch\s*\(command\)\s*\{/, `
      if (command === 'task_token_usage') {
        (window.__taskUsageCalls ??= []).push(args.sessionId);
        const value = structuredClone(window.__taskUsage);
        const delay = window.__taskUsageDelay ?? 0;
        if (delay) await new Promise(resolve => setTimeout(resolve, delay));
        if (window.__taskUsageError) throw new Error('Unavailable');
        return value;
      }
      switch (command) {`);
    await route.fulfill({ response, body: source + '\nwindow.__taskUsageEmit = emit;\n' });
  });
  await page.goto('/');
  await expect(total(page)).toBeVisible();
  await expect(total(page)).not.toHaveText('Reading usage…');
}

for (const theme of ['dark', 'light']) test(`task usage: totals, breakdown and keyboard dismissal in ${theme}`, async ({ page }, info) => {
  await open(page, fixture, theme);
  await expect(total(page)).toHaveText('128K tokens · $0.42 est.');
  await total(page).focus();
  await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
  await expect(total(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(panel(page)).toContainText('128,000');
  await expect(panel(page)).toContainText('Input (uncached)100,000');
  await expect(panel(page)).toContainText('Cache reads20,000');
  await expect(panel(page)).toContainText('Cache writes5,000');
  await expect(panel(page)).toContainText('model-aCodex · 100,000 tokens$0.30');
  await expect(panel(page)).toContainText('model-bClaude Code · 28,000 tokens$0.12');
  await expect(panel(page)).toContainText('not a bill');
  await page.screenshot({ path: info.outputPath(`task-usage-${theme}.png`), animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0);
  await expect(total(page)).toBeFocused();
  await expect(total(page)).toHaveAttribute('aria-expanded', 'false');
  await page.setViewportSize({ width: 860, height: 580 });
  await total(page).click();
  const bounds = await panel(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(860);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(580);
  await page.screenshot({ path: info.outputPath(`task-usage-${theme}-compact.png`), animations: 'disabled' });
  await panel(page).getByRole('button', { name: 'Close task usage' }).click();
  await expect(total(page)).toBeFocused();
});

test('task usage: missing records and unknown prices never look free', async ({ page }) => {
  await open(page, null);
  await expect(total(page)).toHaveText('Usage unavailable');
  await total(page).click();
  await expect(panel(page)).toContainText('No usage records');
  await page.keyboard.press('Escape');
  await page.evaluate(value => { (window as any).__taskUsage = { ...value, costUsd: null, unpricedTokens: 128000, missingSessions: 1, models: [{ provider: 'codex', model: '<unknown>', tokens: 128000, costUsd: null }] }; }, fixture);
  await total(page).click();
  await expect(total(page)).toHaveText('128K tokens · Cost unavailable · Partial');
  await expect(panel(page)).toContainText('<unknown>');
  await expect(panel(page)).toContainText('Unpriced');
  await expect(panel(page)).toContainText('128,000 tokens have no known price');
  await expect(panel(page)).toContainText('Some linked sessions');
  await expect(panel(page)).not.toContainText('$0.00');
});

test('task usage: response refreshes, stale reads and switching tasks', async ({ page }) => {
  await open(page);
  await total(page).click();
  await page.evaluate(value => {
    (window as any).__taskUsage = { ...value, costUsd: 0.6 };
    (window as any).__taskUsageDelay = 400;
    (window as any).__taskUsageEmit('agent-event', { sessionId: 'session-1', kind: 'turn_complete', text: '' });
  }, fixture);
  await page.evaluate(value => {
    (window as any).__taskUsage = { ...value, costUsd: 0.8 };
    (window as any).__taskUsageDelay = 0;
    (window as any).__taskUsageEmit('agent-event', { sessionId: 'session-1', kind: 'done', text: '' });
  }, fixture);
  await expect(total(page)).toContainText('$0.80');
  await expect(panel(page)).toContainText('$0.80');
  await page.waitForTimeout(500);
  await expect(total(page)).toContainText('$0.80');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(panel(page)).toHaveCount(0);
  await expect(total(page)).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(() => page.evaluate(() => (window as any).__taskUsageCalls)).toContain('session-2');
});

test('task usage: failed reads retry on open and tiny amounts stay visible', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__taskUsageError = true; });
  await open(page);
  await expect(total(page)).toHaveText('Usage unavailable');
  await total(page).click();
  await expect(panel(page)).toContainText('Could not read');
  await page.keyboard.press('Escape');
  await page.evaluate(value => {
    (window as any).__taskUsageError = false;
    (window as any).__taskUsage = { ...value, costUsd: 0.001, unpricedTokens: 10 };
  }, fixture);
  await total(page).click();
  await expect(total(page)).toContainText('<$0.01 est. · Partial');
  await expect(panel(page)).toContainText('Partial estimated API cost');
});

test('task usage: imported dark surfaces stay readable with light appearance', async ({ page }, info) => {
  await open(page, fixture, 'light');
  await page.evaluate(() => {
    const root = document.documentElement;
    root.setAttribute('data-vsix', '');
    root.style.setProperty('--panel', '#282a36');
    root.style.setProperty('--bg', '#282a36');
    root.style.setProperty('--sidebar', '#21222c');
    root.style.setProperty('--text', '#f8f8f2');
    root.style.setProperty('--muted', '#b8b8c0');
  });
  await total(page).click();
  await expect(panel(page)).toContainText('$0.42');
  const fill = await panel(page).evaluate(el => getComputedStyle(el).backgroundColor);
  expect(fill).toContain('0.92');
  await page.screenshot({ path: info.outputPath('task-usage-imported.png'), animations: 'disabled' });
});
