import { expect, test, type Page } from '@playwright/test';

/* Boot opens the first thread without waiting for `list_providers` (native --version probes take seconds). Until the
 * list answers, names and labels come from the last launch's list, nothing says a CLI is missing, and Send stays usable;
 * once it answers, the labels follow it. */

const PROVIDERS_DELAY = 3_000;
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
type BootWindow = Window & { __providersAnswered?: number; __providersAsked?: number; __installNotes?: string[]; __firstMessageAt?: number; __drafts?: number; __releaseProviders?: () => void; __holdDraft?: boolean; __releaseDraft?: () => void; __configured?: { sessionId: string; provider: string }[]; __sent?: { sessionId: string; text: string }[]; __cloudConnected?: boolean };

/** list_providers answers PROVIDERS_DELAY after it is asked (with `held`, only once the test calls
 *  window.__releaseProviders()); the page records when, and any install note it shows. With `__holdDraft` set,
 *  create_session waits for window.__releaseDraft(); configure_session calls are recorded in `__configured`, sends in
 *  `__sent`. With `__cloudConnected` set, every cloud platform reports connected (so Deploy offers them all). */
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
      }`).replace(/case ["']create_session["']\s*:\s*\{/, '$& window.__drafts = (window.__drafts ?? 0) + 1; if (window.__holdDraft) await new Promise(resolve => { window.__releaseDraft = resolve; });')
      .replace(/case ["']configure_session["']\s*:\s*\{/, '$& (window.__configured ??= []).push({ sessionId: args.sessionId, provider: args.provider });')
      .replace(/case ["']send_message["']\s*:\s*\{/, '$& (window.__sent ??= []).push({ sessionId: args.sessionId, text: args.text });')
      .replace(/case ["']cloud_connections["']\s*:\s*result\s*=\s*previewCloud\.connections\(\)\s*;/, '$& if (window.__cloudConnected) result = result.map(item => ({ ...item, connected: true }));');
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
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator('.model-menu-list')).toHaveText(/Loading…/);
  await expect(menu.locator('.model-menu-rail [role="tab"][data-view^="h:"]')).toHaveCount(0);
  // Nothing to count yet: the search field says so instead of "Search 0 models, 0 harnesses…".
  const search = menu.locator('input').first();
  await expect(search).toHaveAttribute('placeholder', 'Loading models…');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  // The same picker fills in: the real harnesses, no Loading row, and it stayed open.
  await expect(menu).toBeVisible();
  await expect(menu.locator('.model-menu-rail [data-view="h:claude"]')).toBeVisible();
  await expect(menu.locator('.model-menu-list')).not.toHaveText(/^Loading…$/);
  await expect(menu.locator('.model-menu-list [role="option"]:not([disabled])').first()).toBeVisible();
  await expect(search).toHaveAttribute('placeholder', /^Search [1-9]\d* models, [1-9]\d* harnesses…$/);
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
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5, { timeout: 10_000 });
  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect(author).toHaveText('Claude Code');
  await expect(menu).toBeVisible();
  // The row was renamed, not redrawn.
  expect(await message.evaluate(el => Boolean((el as HTMLElement & { __kept?: boolean }).__kept))).toBe(true);
});

/* Versions: list_providers answers with '' for any version not cached and `provider-versions` fills them in. The preview
 * mock follows that contract; `__previewHoldVersions` keeps each report until the test releases it. */
type VersionsWindow = Window & { __previewHoldVersions?: boolean; __previewReleaseVersions?: () => void; __previewEmit?: (name: string, event: unknown) => void; __modelCalls?: Record<string, number> };

async function heldVersions(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']list_provider_models["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$& { const counts = (window.__modelCalls ??= {}); counts[args.provider] = (counts[args.provider] ?? 0) + 1; }`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.addInitScript(() => { (window as VersionsWindow).__previewHoldVersions = true; });
}
/** Delivers the held `provider-versions` report (the mock's probe finishing). */
async function releaseVersions(page: Page): Promise<void> {
  await expect.poll(() => page.evaluate(() => typeof (window as VersionsWindow).__previewReleaseVersions), { timeout: 10_000 }).toBe('function');
  await page.evaluate(() => { const w = window as VersionsWindow; const report = w.__previewReleaseVersions!; w.__previewReleaseVersions = undefined; report(); });
}
const modelCalls = (page: Page, id: string) => page.evaluate(name => (window as VersionsWindow).__modelCalls?.[name] ?? 0, id);
async function threadPainted(page: Page): Promise<void> {
  await expect(page.locator('#transcript .agent-message .message-meta strong').first()).toHaveText('Claude Code', { timeout: 10_000 });
}

test('versions fill in after provider-versions without closing an open menu or redrawing', async ({ page }) => {
  test.setTimeout(45_000);
  await heldVersions(page);
  await page.goto('/');
  await threadPainted(page);
  const message = page.locator('#transcript .agent-message').first();
  await message.evaluate(el => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(menu.getByRole('menuitemradio')).toHaveCount(5, { timeout: 10_000 });
  await releaseVersions(page);
  await page.waitForTimeout(300);
  await expect(menu).toBeVisible();
  expect(await message.evaluate(el => Boolean((el as HTMLElement & { __kept?: boolean }).__kept))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();

  // Settings → Agents refreshes the list (its versions come back blank and are probed again), but a harness at the same
  // path keeps the version shown through the refresh: no blank, no Checking…, then the new report fills in place.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  const row = settings.locator('.provider-diagnostic[data-provider="claude"]');
  const version = row.locator('.settings-provider-version');
  await expect(version).toHaveText('Sample provider', { timeout: 10_000 });
  await row.evaluate(el => {
    const seen = new Set<string>(); (el as HTMLElement & { __seen?: Set<string> }).__seen = seen;
    new MutationObserver(() => seen.add(el.querySelector('.settings-provider-version')!.textContent ?? '')).observe(el, { subtree: true, childList: true, characterData: true });
  });
  await expect.poll(() => page.evaluate(() => typeof (window as VersionsWindow).__previewReleaseVersions), { timeout: 10_000, message: 'the refresh started a new probe' }).toBe('function');
  await expect(version).toHaveText('Sample provider');
  await row.locator('summary').click();
  await row.evaluate(el => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });
  await releaseVersions(page);
  await page.waitForTimeout(300);
  await expect(version).toHaveText('Sample provider');
  await expect(row).toHaveAttribute('open', '');
  expect(await row.evaluate(el => Boolean((el as HTMLElement & { __kept?: boolean }).__kept))).toBe(true);
  const seen = await row.evaluate(el => [...(el as HTMLElement & { __seen?: Set<string> }).__seen!]);
  expect(seen, 'the version never blanked or said Checking… through the refresh').not.toContain('Checking…');
  expect(seen).not.toContain('');
  // A harness that is not installed reports no version, not Checking….
  await expect(settings.locator('.provider-diagnostic[data-provider="antigravity"] .settings-provider-version')).toHaveText('Not reported');
});

test('Settings says Checking… per harness until its version is reported, and done ends the round', async ({ page }) => {
  test.setTimeout(45_000);
  await heldVersions(page);
  await page.goto('/');
  await threadPainted(page);
  // The boot probe is still out: no installed harness has a version yet.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  const versionOf = (id: string) => settings.locator(`.provider-diagnostic[data-provider="${id}"] .settings-provider-version`);
  await expect(versionOf('claude')).toHaveText('Checking…', { timeout: 10_000 });
  await expect(versionOf('codex')).toHaveText('Checking…');
  await expect(versionOf('cursor')).toHaveText('Checking…');
  await expect(versionOf('antigravity')).toHaveText('Not reported');
  const row = settings.locator('.provider-diagnostic[data-provider="claude"]');
  await row.locator('summary').click();
  await row.evaluate(el => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });
  const emit = (event: unknown) => page.evaluate(payload => (window as VersionsWindow).__previewEmit!('provider-versions', payload), event);
  // One harness reported: only its row fills; the others are still being probed.
  await emit({ versions: { claude: 'Claude Code 1.2.3 (sample)' } });
  await expect(versionOf('claude')).toHaveText('Claude Code 1.2.3 (sample)');
  await expect(versionOf('codex')).toHaveText('Checking…');
  // A failed or timed-out probe is reported as '': that row stops checking.
  await emit({ versions: { codex: '' } });
  await expect(versionOf('codex')).toHaveText('Not reported');
  await expect(versionOf('cursor')).toHaveText('Checking…');
  // done: nothing is pending any more, so a harness never reported stops checking too.
  await emit({ versions: {}, done: true });
  await expect(versionOf('cursor')).toHaveText('Not reported');
  await expect(row).toHaveAttribute('open', '');
  expect(await row.evaluate(el => Boolean((el as HTMLElement & { __kept?: boolean }).__kept))).toBe(true);
});

test('Settings before the list answers shows the last launch\'s installed harness as pending, not missing', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, [{ id: 'claude', name: 'Claude Code', installed: true, models: [] }, { id: 'codex', name: 'Codex', installed: false, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  const claude = settings.locator('.provider-diagnostic[data-provider="claude"]');
  await expect(claude.locator('code')).toHaveText('Checking…', { timeout: 10_000 });
  await expect(claude.locator('.settings-provider-version')).toHaveText('Checking…');
  // The last launch knew this one as missing, so it may say so.
  await expect(settings.locator('.provider-diagnostic[data-provider="codex"] code')).toHaveText('Install the agent, then refresh.');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  await release(page);
  await expect(claude.locator('code')).toHaveText('/sample/bin/claude', { timeout: 10_000 });
});

test('a version filling in keeps cached models; a real version change drops them', async ({ page }) => {
  test.setTimeout(45_000);
  await heldVersions(page);
  await page.goto('/');
  await threadPainted(page);
  // The open thread's harness loads its models once the list lands.
  await expect.poll(() => modelCalls(page, 'claude'), { timeout: 10_000 }).toBe(1);
  await releaseVersions(page);
  await page.locator('#model-picker-trigger').click();
  const menu = page.locator('.model-menu');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator('.model-menu-list [role="option"]:not([disabled])').first()).toBeVisible();
  await page.waitForTimeout(300);
  expect(await modelCalls(page, 'claude'), "'' to a real version is not a new CLI").toBe(1);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await page.evaluate(() => (window as VersionsWindow).__previewEmit!('provider-versions', { versions: { claude: 'Claude Code 99.0.0 (sample)' } }));
  await expect.poll(() => modelCalls(page, 'claude'), { timeout: 10_000 }).toBe(2);
});

test('a click on the model trigger survives a composer re-render while the picker loads', async ({ page }) => {
  test.setTimeout(45_000);
  let releasePicker: () => void = () => {};
  const pickerHeld = new Promise<void>(resolve => { releasePicker = resolve; });
  let pickerAsked = false;
  await page.route(/\/src\/model-picker\.ts(\?|$)/, async route => { pickerAsked = true; await pickerHeld; await route.continue(); });
  await page.goto('/');
  await threadPainted(page);
  await page.locator('#model-picker-trigger').click();
  await expect.poll(() => pickerAsked, { timeout: 10_000 }).toBe(true);
  // A boot re-render replaces the trigger while the module is still loading.
  await page.evaluate(() => { const old = document.querySelector('#model-picker-trigger')!; old.replaceWith(old.cloneNode(true)); });
  releasePicker();
  await expect(page.locator('.model-menu')).toBeVisible({ timeout: 10_000 });
});

test('a New task press while the list is out shows busy and makes exactly one draft', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  const button = page.locator('.sidebar-actions .new-task-button');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await button.click();
  expect(await page.evaluate(() => (window as BootWindow).__drafts ?? 0), 'nothing is created before the list answers').toBe(0);
  await release(page);
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__drafts ?? 0), { timeout: 10_000 }).toBe(1);
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as BootWindow).__drafts ?? 0)).toBe(1);
});

test('a ⌘N press while the list is out shows the same busy state as the button, pulsing its icon', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  const button = page.locator('.sidebar-actions .new-task-button');
  await page.locator('#prompt').click();
  await page.keyboard.press('ControlOrMeta+n');
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button.locator('.icon').first()).toHaveCSS('animation-name', 'state-pulse');
  await release(page);
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  await expect(button.locator('.icon').first()).toHaveCSS('animation-name', 'none');
});

test('reduced motion: a busy New task button holds its icon dimmed instead of pulsing', async ({ page }) => {
  test.setTimeout(30_000);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  const button = page.locator('.sidebar-actions .new-task-button');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await expect(button.locator('.icon').first()).toHaveCSS('animation-name', 'none');
  await expect(button.locator('.icon').first()).toHaveCSS('opacity', '0.45');
  await release(page);
});

test('a New task drafted from the last launch\'s list is corrected when the real list lands during its creation', async ({ page }) => {
  test.setTimeout(45_000);
  // The last launch knew only a harness the real list reports as missing.
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.evaluate(() => { (window as BootWindow).__holdDraft = true; });
  // Past the wait for the real list, a New task uses the last launch's list (provisional).
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseDraft), { timeout: 10_000, message: 'create_session is out' }).toBe('function');
  // The real list lands while create_session is awaited; then the draft is created.
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await page.evaluate(() => (window as BootWindow).__releaseDraft!());
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const draft = await page.locator('#prompt').getAttribute('data-session-id');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__configured ?? []), { timeout: 10_000, message: 'the draft moved to an installed harness' })
    .toEqual([{ sessionId: draft, provider: 'claude' }]);
});

/* Deploy (and a GitHub task) acts on the draft its New task press opens. While a press waits for the harness list, the
 * same press again settles with it, and a press dropped for a later one settles without a draft: neither writes its
 * brief into, or sends from, the thread that happens to be open. A last-launch list with nothing installed keeps every
 * press waiting for the real list, however long it takes. */
const NOTHING_INSTALLED = [{ id: 'claude', name: 'Claude Code', installed: false, models: [] }];
const sent = (page: Page) => page.evaluate(() => (window as BootWindow).__sent ?? []);
async function deployToVercel(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Deploy', exact: true }).click();
  await page.getByRole('menu', { name: 'Deploy' }).getByRole('menuitem', { name: 'Deploy to Vercel' }).click();
}
async function heldWithCloud(page: Page): Promise<void> {
  await slowProviders(page, NOTHING_INSTALLED, true);
  await page.addInitScript(() => { (window as BootWindow).__cloudConnected = true; });
  await page.goto('/');
  await paintedBeforeProviders(page);
}

test('Deploy pressed while a New task waits for the list writes its brief only into the new draft', async ({ page }) => {
  test.setTimeout(30_000);
  await heldWithCloud(page);
  const prompt = page.locator('#prompt');
  const before = await prompt.getAttribute('data-session-id'), typed = await prompt.inputValue();
  const button = page.locator('.sidebar-actions .new-task-button');
  await button.click();
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await deployToVercel(page);
  // Both presses wait for the list: the open thread keeps its text and nothing is sent from it.
  await page.waitForTimeout(400);
  await expect(prompt).toHaveAttribute('data-session-id', before!);
  await expect(prompt).toHaveValue(typed);
  expect(await sent(page)).toEqual([]);
  await release(page);
  await expect.poll(async () => (await sent(page)).length, { timeout: 10_000 }).toBe(1);
  const [deploy] = await sent(page);
  expect(deploy.sessionId).not.toBe(before);
  expect(deploy.text).toMatch(/^Deploy this project to Vercel\./);
  expect(await page.evaluate(() => (window as BootWindow).__drafts ?? 0), 'one draft for both presses').toBe(1);
  await page.waitForTimeout(300);
  expect(await sent(page)).toHaveLength(1);
});

test('a Deploy press dropped for a later New task writes nothing anywhere', async ({ page }) => {
  test.setTimeout(30_000);
  await heldWithCloud(page);
  const prompt = page.locator('#prompt');
  const before = await prompt.getAttribute('data-session-id');
  // New chat waits for the list; Deploy (a New task in this project) queues behind it.
  await page.locator('.sidebar-actions .new-chat-button').click();
  await deployToVercel(page);
  // From a thread in another project, its New task replaces the queued Deploy press.
  await page.locator('#navigation').getByRole('button', { name: /^pandacode .*Explore the project/ }).click();
  await expect(prompt).not.toHaveAttribute('data-session-id', before!);
  const elsewhere = await prompt.getAttribute('data-session-id'), typed = await prompt.inputValue();
  await page.locator('.sidebar-actions .new-task-button').click();
  await release(page);
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__drafts ?? 0), { timeout: 10_000, message: "project-2's draft" }).toBe(1);
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  await expect(prompt).not.toHaveAttribute('data-session-id', elsewhere!);
  await page.waitForTimeout(500);
  await expect(prompt).toHaveValue('');
  expect(await sent(page)).toEqual([]);
  // The thread that was open keeps its text.
  await page.locator('#navigation').getByRole('button', { name: /^pandacode .*Explore the project/ }).click();
  await expect(prompt).toHaveAttribute('data-session-id', elsewhere!);
  await expect(prompt).toHaveValue(typed);
});
