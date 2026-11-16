import { expect, test, type Page } from '@playwright/test';

/* Boot opens the first thread without waiting for `list_providers` (native --version probes take seconds). Until the
 * list answers, names and labels come from the last launch's list, nothing says a CLI is missing, and Send stays usable;
 * once it answers, the labels follow it. */

const PROVIDERS_DELAY = 3_000;
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
type BootWindow = Window & { __providersAnswered?: number; __providersAsked?: number; __installNotes?: string[]; __firstMessageAt?: number; __drafts?: number; __releaseProviders?: () => void };

/** list_providers answers PROVIDERS_DELAY after it is asked (with `held`, only once the test calls
 *  window.__releaseProviders()); the page records when, and any install note it shows. */
async function slowProviders(page: Page, lastLaunch?: unknown, held = false): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']list_providers["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$&
      if (!args.deviceId) {
        window.__providersAsked = performance.now();
        await new Promise(resolve => ${held} ? (window.__releaseProviders = resolve) : setTimeout(resolve, ${PROVIDERS_DELAY}));
        window.__providersAnswered = performance.now();
      }`).replace(/case ["']create_session["']\s*:\s*\{/, '$& window.__drafts = (window.__drafts ?? 0) + 1;');
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.addInitScript(saved => {
    if (saved) localStorage.setItem('pandacode.providerCatalog', JSON.stringify(saved));
    const w = window as BootWindow;
    w.__installNotes = [];
    new MutationObserver(() => {
      if (w.__firstMessageAt === undefined && document.querySelector('#transcript .message')) w.__firstMessageAt = performance.now();
      const toast = document.querySelector('#toast')?.textContent ?? '';
      if (/install|agent CLIs/i.test(toast)) w.__installNotes!.push(toast);
    }).observe(document, { subtree: true, childList: true, characterData: true });
  }, lastLaunch);
}
const answered = (page: Page) => page.evaluate(() => (window as BootWindow).__providersAnswered ?? null);
/** The transcript painted while list_providers was still out (timed in the page, so a slow machine cannot fake it). */
async function paintedBeforeProviders(page: Page): Promise<void> {
  await expect(page.locator('#transcript .message').first()).toBeVisible({ timeout: 10_000 });
  const { painted, asked, answer } = await page.evaluate(() => { const w = window as BootWindow; return { painted: w.__firstMessageAt, asked: w.__providersAsked, answer: w.__providersAnswered }; });
  expect(asked, 'list_providers was asked').toBeDefined();
  expect(painted).toBeDefined();
  if (answer !== undefined) expect(painted!).toBeLessThan(answer);
}

test('the first thread shows before list_providers answers, with no install note and Send usable', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await expect(page.getByRole('textbox', { name: 'Message your coding agent', exact: true })).toBeEnabled();
  await expect(page.locator('#composer button[type="submit"].send-button')).toBeEnabled();
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  // Once it answers the agent's name is the harness's own.
  await expect(page.locator('#transcript .agent-message .message-meta strong').first()).toHaveText('Claude Code');
  await expect(page.locator('#composer button[type="submit"].send-button')).toBeEnabled();
  expect(await page.evaluate(() => (window as BootWindow).__installNotes)).toEqual([]);
});

test('names and labels paint from the last launch\'s list, then follow list_providers', async ({ page }) => {
  test.setTimeout(30_000);
  const lastLaunch = [
    { id: 'claude', name: 'Claude (last launch)', installed: true, models: [{ id: 'sonnet', name: 'Sonnet (last launch)', description: '' }] },
    { id: 'codex', name: 'Codex', installed: true, models: [] },
  ];
  await slowProviders(page, lastLaunch, true);
  await page.goto('/');
  const author = page.locator('#transcript .agent-message .message-meta strong').first();
  const label = page.locator('#model-picker-trigger [data-model-label]');
  await paintedBeforeProviders(page);
  await expect(author).toHaveText('Claude (last launch)');
  await expect(label).toHaveText('Sonnet (last launch)');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  await page.evaluate(() => (window as BootWindow & { __releaseProviders?: () => void }).__releaseProviders?.());
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect(author).toHaveText('Claude Code');
  await expect(label).not.toContainText('last launch');
  // The answer is kept for the next launch.
  const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]') as { id: string; name: string }[]);
  expect(kept.find(entry => entry.id === 'claude')?.name).toBe('Claude Code');
  expect(await page.evaluate(() => (window as BootWindow).__installNotes)).toEqual([]);
});

test('a last-launch list with nothing installed still shows no install note before the answer', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, [{ id: 'claude', name: 'Claude Code', installed: false, models: [] }]);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await expect(page.locator('#composer button[type="submit"].send-button')).toBeEnabled();
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  expect(await page.evaluate(() => (window as BootWindow).__installNotes)).toEqual([]);
});

const release = (page: Page) => page.evaluate(() => (window as BootWindow).__releaseProviders?.());

test('the model picker opened before list_providers answers shows Loading, then the real harnesses', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  // With no last-launch list, messages are signed with the harness's built-in name, never 'Agent'.
  await expect(page.locator('#transcript .agent-message .message-meta strong').first()).toHaveText('Claude');
  await page.locator('#model-picker-trigger').click();
  const menu = page.locator('.model-menu');
  await expect(menu).toBeVisible();
  await expect(menu.locator('.model-menu-list')).toHaveText(/Loading…/);
  await expect(menu.locator('.model-menu-rail [role="tab"][data-view^="h:"]')).toHaveCount(0);
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  // The same picker fills in: the real harnesses, no Loading row, and it stayed open.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.model-menu-rail [data-view="h:claude"]')).toBeVisible();
  await expect(menu.locator('.model-menu-list')).not.toHaveText(/^Loading…$/);
  await expect(menu.locator('.model-menu-list [role="option"]:not([disabled])').first()).toBeVisible();
  await expect(page.locator('#transcript .agent-message .message-meta strong').first()).toHaveText('Claude Code');
});

test('New task twice while list_providers is out makes one draft', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.locator('#prompt').click();
  await page.keyboard.press('ControlOrMeta+n');
  await page.keyboard.press('ControlOrMeta+n');
  expect(await page.evaluate(() => (window as BootWindow).__drafts ?? 0), 'nothing is created before the list answers').toBe(0);
  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__drafts ?? 0)).toBe(1);
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  // Settled: no late second draft.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as BootWindow).__drafts ?? 0)).toBe(1);
});

test('a menu open when list_providers answers stays open while the names update in place', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, [{ id: 'claude', name: 'Claude (last launch)', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  const author = page.locator('#transcript .agent-message .message-meta strong').first();
  await expect(author).toHaveText('Claude (last launch)');
  const message = page.locator('#transcript .agent-message').first();
  await message.evaluate(el => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5);
  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect(author).toHaveText('Claude Code');
  await expect(menu).toBeVisible();
  // The row was renamed, not redrawn.
  expect(await message.evaluate(el => Boolean((el as HTMLElement & { __kept?: boolean }).__kept))).toBe(true);
});
