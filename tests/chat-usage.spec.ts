import { expect, test, type Page } from '@playwright/test';

type UsageFixture = { calls: { provider: string; refresh: boolean }[]; values: Record<string, unknown>; holds: Record<string, (() => void)[]> };
const providers = [
  { id: 'claude', name: 'Claude', installed: true },
  { id: 'codex', name: 'Codex', installed: true },
  { id: 'kimi', name: 'Kimi', installed: true },
  { id: 'glm', name: 'GLM', installed: true },
  { id: 'mimo', name: 'MiMo', installed: true },
].map(p => ({ ...p, path: null, version: '', models: [] }));

async function fixture(page: Page, options: { providers?: typeof providers; holdAll?: boolean } = {}): Promise<void> {
  await page.addInitScript((holdAll: boolean) => {
    const windows: Record<string, unknown[]> = {
      claude: [{ label: '5-hour window', usedPercent: 0, resetsAt: new Date(Date.now() + 90 * 60_000).toISOString() }, { label: 'Weekly window', usedPercent: 42, resetsAt: null }],
      codex: [{ label: 'Weekly window', usedPercent: 100, resetsAt: new Date(Date.now() + 2 * 86_400_000).toISOString() }],
      kimi: [{ label: 'Daily', usedPercent: 15 }], glm: [{ label: 'Daily', usedPercent: 28 }], mimo: [{ label: 'Daily', usedPercent: 63 }],
    };
    const f: UsageFixture = { calls: [], values: {}, holds: {} };
    (f as any).holdProvider = null;
    (f as any).resolveHold = null;
    (f as any).active = 0;
    (f as any).maxActive = 0;
    Object.entries(windows).forEach(([provider, entries]) => { f.values[provider] = { provider, status: entries.length ? 'ready' : 'unavailable', windows: entries, checkedAt: Date.now(), stale: false }; });
    (window as any).__usageFixture = f;
    (window as any).__TAURI_INTERNALS__ = {
      invoke: async (command: string, args: { provider: string; refresh: boolean }) => {
        if (command !== 'agent_usage') throw new Error(`Unexpected command: ${command}`);
        f.calls.push(args);
        (f as any).active++;
        (f as any).maxActive = Math.max((f as any).maxActive, (f as any).active);
        await new Promise(resolve => setTimeout(resolve, 10));
        if (holdAll) await new Promise<void>(resolve => { ((f as any).releases ??= []).push(resolve); });
        if ((f as any).holdProvider === args.provider) await new Promise<void>(resolve => { (f as any).resolveHold = resolve; });
        (f as any).active--;
        return structuredClone(f.values[args.provider]);
      },
    };
  }, options.holdAll ?? false);
  await page.route('**/chat-usage-fixture', route => route.fulfill({ contentType: 'text/html', body: `<!doctype html><html><head><meta name="viewport" content="width=device-width,initial-scale=1"><link rel="stylesheet" href="/src/styles.css"><link rel="stylesheet" href="/src/motion.css"><link rel="stylesheet" href="/src/chat-usage.css"></head><body><div class="composer-context-row" style="width:500px"><div class="composer-context">Project <span>main</span></div><div id="chat-usage-host"></div></div><script type="module">import { createChatUsage } from '/src/chat-usage.ts'; import { providers } from '/src/chat-usage-fixture.js'; window.usage = createChatUsage(); window.usage.update(document.querySelector('#chat-usage-host'), providers);</script></body></html>` }));
  await page.route('**/chat-usage-fixture.js', route => route.fulfill({ contentType: 'application/javascript', body: `export const providers = ${JSON.stringify(options.providers ?? providers)}; window.fixtureProviders = providers;` }));
  await page.goto('/chat-usage-fixture');
  await page.waitForFunction(() => Boolean((window as any).usage));
  if ((options.providers ?? providers).length) {
    if (options.holdAll) await expect(page.locator('.chat-usage-strip')).toHaveCount(0);
    else {
      await expect(page.locator('.chat-usage-strip')).toBeVisible();
      await expect(page.getByRole('button', { name: 'Claude usage: 42% used' })).toBeVisible();
      await expect(page.locator('.chat-usage-refresh')).toBeEnabled();
    }
  } else await expect(page.locator('.chat-usage-strip')).toHaveCount(0);
}

test('Chat usage: collapse at half row width, expand leftward on hover and keyboard focus without moving project context', async ({ page }) => {
  await fixture(page);
  const row = page.locator('.composer-context-row');
  const strip = page.locator('.chat-usage-strip');
  await expect(strip).toHaveClass(/is-collapsed/);
  await expect(page.locator('.chat-usage-stack')).toBeVisible();
  const contextBefore = await row.locator('.composer-context').boundingBox();
  const before = await strip.boundingBox();
  await strip.hover();
  await expect(strip).toHaveClass(/is-expanded/);
  const contextAfter = await row.locator('.composer-context').boundingBox();
  expect(contextAfter?.x).toBe(contextBefore?.x);
  expect(contextAfter?.width).toBe(contextBefore?.width);
  expect((await strip.boundingBox())?.y).toBe(before?.y);
  await expect(page.getByRole('button', { name: 'Codex usage: 100% used' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(strip).not.toHaveClass(/is-expanded/);
  await page.locator('.chat-usage-icon').first().focus();
  await expect(strip).toHaveClass(/is-expanded/);
  await page.locator('.chat-usage-full [data-usage-provider="claude"]').focus();
  await page.keyboard.press('Escape');
  await expect(strip).not.toHaveClass(/is-expanded/);
  await expect(page.locator('.chat-usage-icon').first()).toBeFocused();
  await row.evaluate(element => { (element as HTMLElement).style.width = '1000px'; });
  await expect(strip).not.toHaveClass(/is-collapsed/);
  const fullWidth = await strip.evaluate(element => element.scrollWidth);
  await row.evaluate((element, width) => { (element as HTMLElement).style.width = `${width * 2}px`; }, fullWidth);
  await expect(strip).not.toHaveClass(/is-collapsed/);
  await row.evaluate((element, width) => { (element as HTMLElement).style.width = `${width * 2 - 2}px`; }, fullWidth);
  await expect(strip).toHaveClass(/is-collapsed/);
});

test('Chat usage: provider details preserve every finite window including true zero', async ({ page }) => {
  await fixture(page);
  await page.locator('.chat-usage-strip').hover();
  const claude = page.getByRole('button', { name: 'Claude usage: 42% used' });
  await claude.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toContainText('Default setup');
  await expect(tip).toContainText('5-hour window: 0% used');
  await expect(tip).toContainText(/resets in \d+h(?: \d+m)? \(/);
  const bounds = await tip.boundingBox();
  const viewport = page.viewportSize()!;
  expect(bounds && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= viewport.width && bounds.y + bounds.height <= viewport.height).toBe(true);
  await expect(tip).toContainText('Weekly window: 42% used; reset time not reported');
  await expect(page.getByRole('button', { name: 'Kimi usage: 15% used' })).toBeVisible();
  await page.evaluate(() => { (window as any).__usageFixture.values.claude.windows = [{ label: '5-hour window', usedPercent: 0, resetsAt: null }]; });
  await page.locator('.chat-usage-refresh').click();
  await expect(page.getByRole('button', { name: 'Claude usage: 0% used' })).toContainText('0%');
});

test('Chat usage: hides accounts without finite quotas and filters refresh results in both layouts', async ({ page }) => {
  await fixture(page);
  const configure = () => page.evaluate(() => {
    const f = (window as any).__usageFixture;
    f.values.kimi = { provider: 'kimi', status: 'signedOut', windows: [], checkedAt: Date.now(), stale: false };
    f.values.glm = { provider: 'glm', status: 'unsupported', windows: [], checkedAt: Date.now(), stale: false };
    f.values.mimo = { provider: 'mimo', status: 'ready', windows: [{ label: 'invalid', usedPercent: NaN }], checkedAt: Date.now(), stale: false };
  });
  await configure();
  await page.locator('.chat-usage-strip').hover();
  await page.locator('.chat-usage-refresh').click();
  await expect(page.getByRole('button', { name: 'Kimi usage: unavailable' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'GLM usage: unavailable' })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'MiMo usage: unavailable' })).toHaveCount(0);
  await expect(page.locator('.chat-usage-full [data-usage-provider]')).toHaveCount(2);
  await page.locator('.chat-usage-strip').hover();
  await expect(page.locator('.chat-usage-stack [data-usage-provider]')).toHaveCount(2);
  await expect(page.getByRole('button', { name: 'Claude usage: 42% used' })).toBeVisible();
  await page.evaluate(() => {
    const f = (window as any).__usageFixture;
    f.values.kimi = { provider: 'kimi', status: 'ready', windows: [{ label: 'Daily', usedPercent: 0 }], checkedAt: Date.now(), stale: false };
  });
  await page.locator('.chat-usage-refresh').click();
  await expect(page.getByRole('button', { name: 'Kimi usage: 0% used' })).toBeVisible();
  await expect(page.locator('.chat-usage-full [data-usage-provider]')).toHaveCount(3);
  await page.locator('.chat-usage-strip').hover();
  await expect(page.locator('.chat-usage-stack [data-usage-provider]')).toHaveCount(3);
});

test('Chat usage: no finite quota entries leave the host empty and clear its layout width', async ({ page }) => {
  await fixture(page);
  await page.evaluate(() => {
    const f = (window as any).__usageFixture;
    for (const id of ['claude', 'codex', 'kimi', 'glm', 'mimo']) f.values[id] = { provider: id, status: 'signedOut', windows: [], checkedAt: Date.now(), stale: false };
  });
  await page.locator('.chat-usage-strip').hover();
  await page.locator('.chat-usage-refresh').click();
  await expect(page.locator('.chat-usage-strip')).toHaveCount(0);
  await expect(page.locator('#chat-usage-host')).toHaveCSS('width', '0px');
  await expect(page.locator('#chat-usage-host')).toBeEmpty();
});

test('Chat usage: initial reads are capped, mount reuse does not reread, and only explicit refresh fetches again', async ({ page }) => {
  await fixture(page);
  const calls = () => page.evaluate(() => (window as any).__usageFixture.calls as { provider: string; refresh: boolean }[]);
  await expect.poll(async () => (await calls()).length).toBe(5);
  expect(await page.evaluate(() => (window as any).__usageFixture.maxActive)).toBeLessThanOrEqual(3);
  expect((await calls()).every(c => !c.refresh)).toBe(true);
  await page.evaluate(() => { (window as any).usage.update(document.querySelector('#chat-usage-host'), (window as any).fixtureProviders); });
  expect((await calls()).length).toBe(5);
  await page.clock.install();
  await page.clock.fastForward(30 * 60_000);
  expect((await calls()).length).toBe(5);
  await page.locator('.chat-usage-strip').hover();
  await expect(page.getByRole('button', { name: 'Refresh account usage' })).toBeEnabled();
  await page.getByRole('button', { name: 'Refresh account usage' }).click();
  await page.clock.runFor(100);
  await expect.poll(async () => (await calls()).filter(c => c.refresh).length).toBe(5);
});

test('Chat usage: host replacement during a pending request renders into only the current host', async ({ page }) => {
  await fixture(page);
  await expect.poll(() => page.evaluate(() => (window as any).__usageFixture.calls.length)).toBe(5);
  await page.evaluate(() => {
    const f = (window as any).__usageFixture;
    f.holdProvider = 'antigravity';
    f.values.antigravity = { provider: 'antigravity', status: 'ready', windows: [{ label: 'Daily', usedPercent: 12 }], checkedAt: Date.now(), stale: false };
    const next = [...(window as any).fixtureProviders, { id: 'antigravity', name: 'Antigravity', installed: true, path: null, version: '', models: [] }];
    (window as any).usage.update(document.querySelector('#chat-usage-host'), next);
  });
  await expect.poll(() => page.evaluate(() => (window as any).__usageFixture.calls.length)).toBe(11);
  await page.evaluate(() => {
    const old = document.querySelector('#chat-usage-host')!;
    const replacement = old.cloneNode(false) as HTMLElement;
    replacement.id = 'replacement-host'; old.replaceWith(replacement);
    (window as any).usage.update(replacement, [...(window as any).fixtureProviders, { id: 'antigravity', name: 'Antigravity', installed: true, path: null, version: '', models: [] }]);
    (window as any).__usageFixture.resolveHold();
  });
  await expect(page.locator('#replacement-host .chat-usage-strip')).toBeVisible();
  await page.locator('#replacement-host .chat-usage-strip').hover();
  await expect(page.getByRole('button', { name: 'Antigravity usage: 12% used' })).toBeVisible();
  expect(await page.locator('#chat-usage-host').count()).toBe(0);
});

test('Chat usage: no installed harnesses leave no strip, spacing or account requests', async ({ page }) => {
  await fixture(page, { providers: [] });
  expect(await page.evaluate(() => (window as any).__usageFixture.calls)).toEqual([]);
  expect(await page.locator('#chat-usage-host').evaluate(element => ({ width: element.getBoundingClientRect().width, margin: getComputedStyle(element).marginRight }))).toEqual({ width: 0, margin: '0px' });
});

test('Chat usage: disposal during the first three reads prevents queued accounts from starting', async ({ page }) => {
  await fixture(page, { holdAll: true });
  await expect.poll(() => page.evaluate(() => (window as any).__usageFixture.calls.length)).toBe(3);
  await expect.poll(() => page.evaluate(() => ((window as any).__usageFixture.releases ?? []).length)).toBe(3);
  await page.evaluate(() => {
    (window as any).usage.dispose();
    (window as any).__usageFixture.releases.forEach((release: () => void) => release());
  });
  await expect.poll(() => page.evaluate(() => (window as any).__usageFixture.active)).toBe(0);
  expect(await page.evaluate(() => (window as any).__usageFixture.calls.length)).toBe(3);
});

test('Chat usage: a tap opens details and Escape preserves unrelated keyboard shortcuts', async ({ page }) => {
  await fixture(page);
  const strip = page.locator('.chat-usage-strip');
  await page.locator('.chat-usage-icon').first().dispatchEvent('click');
  await expect(strip).toHaveClass(/is-expanded/);
  await expect(page.getByRole('tooltip')).toContainText('Default setup');
  await page.locator('.chat-usage-full [data-usage-provider="mimo"]').focus();
  await page.keyboard.press('Escape');
  await expect(strip).not.toHaveClass(/is-expanded/);
  await expect(page.locator('.chat-usage-icon').first()).toBeFocused();
  await page.evaluate(() => {
    const input = document.createElement('input'); input.id = 'outside-prompt'; document.body.append(input); input.focus();
    (window as any).unhandledEscapes = 0;
    document.addEventListener('keydown', event => { if (event.key === 'Escape' && !event.defaultPrevented) (window as any).unhandledEscapes++; });
  });
  await strip.hover();
  await page.keyboard.press('Escape');
  await expect(strip).not.toHaveClass(/is-expanded/);
  expect(await page.evaluate(() => (window as any).unhandledEscapes)).toBe(1);
});

test('Chat usage: the real composer keeps its branch controls and contains a long provider list', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `if (command === 'agent_usage') (window.__chatUsageCalls ??= []).push(structuredClone(args)); switch (command) {`) });
  });
  await page.goto('/');
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await expect(prompt).toBeEnabled();
  await expect(page.locator('.chat-usage-refresh')).toBeEnabled();
  const row = page.locator('.composer-context-row'), strip = row.locator('.chat-usage-strip'), branch = row.locator('#branch-chip');
  await expect(branch).toBeVisible();
  const branchBefore = await branch.boundingBox(), stripBefore = await strip.boundingBox();
  await strip.hover();
  await expect(strip).toHaveClass(/is-expanded/);
  expect(await branch.boundingBox()).toEqual(branchBefore);
  const rowBounds = (await row.boundingBox())!, bounds = (await strip.boundingBox())!;
  expect(bounds.y).toBe(stripBefore?.y);
  expect(bounds.x).toBeGreaterThanOrEqual(rowBounds.x);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(rowBounds.x + rowBounds.width);
  const last = row.locator('.chat-usage-full [data-usage-provider]').last();
  await last.scrollIntoViewIfNeeded(); await last.hover();
  const tip = page.getByRole('tooltip');
  await expect(tip).toBeVisible();
  const tipBounds = (await tip.boundingBox())!, viewport = page.viewportSize()!;
  expect(tipBounds.x).toBeGreaterThanOrEqual(0);
  expect(tipBounds.x + tipBounds.width).toBeLessThanOrEqual(viewport.width);
  expect(tipBounds.y).toBeGreaterThanOrEqual(0);
  await prompt.fill('Keep this draft while checking usage');
  await page.keyboard.press('Escape');
  await branch.click();
  await expect(page.getByRole('dialog', { name: 'Branch and worktree', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt).toHaveValue('Keep this draft while checking usage');
  expect(await page.evaluate(() => (window as any).__chatUsageCalls.every((args: Record<string, unknown>) => args.connection === undefined))).toBe(true);
});
