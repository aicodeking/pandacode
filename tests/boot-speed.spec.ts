import { expect, test, type Page } from '@playwright/test';

/* Boot opens the first thread without waiting for `list_providers` (native --version probes take seconds). Until the
 * list answers, names and labels come from the last launch's list, nothing says a CLI is missing, and Send stays usable;
 * once it answers, the labels follow it. */

const PROVIDERS_DELAY = 3_000;
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';
type BootWindow = Window & { __providersAnswered?: number; __providersAsked?: number; __installNotes?: string[]; __firstMessageAt?: number; __drafts?: number; __releaseProviders?: () => void; __holdExplicit?: boolean; __releaseExplicit?: () => void; __failExplicit?: boolean; __holdConfigure?: boolean; __releaseConfigure?: () => void; __holdDraft?: boolean; __releaseDraft?: () => void; __configured?: { sessionId: string; provider: string }[]; __sent?: { sessionId: string; text: string }[]; __cloudConnected?: boolean };

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
      .replace(/case ["']configure_session["']\s*:\s*\{/, '$& (window.__configured ??= []).push({ sessionId: args.sessionId, provider: args.provider }); if (args.provider === "codex" && window.__holdExplicit) { await new Promise(resolve => { window.__releaseExplicit = resolve; }); if (window.__failExplicit) throw new Error("Explicit save failed"); } if (window.__holdConfigure) { window.__holdConfigure = false; await new Promise(resolve => { window.__releaseConfigure = resolve; }); }')
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

for (const refresh of ['fails', 'wins'] as const) {
  test(`startup keeps the newest successful catalog when Settings refresh ${refresh}`, async ({ page }) => {
    test.setTimeout(45_000);
    const boot = { id: 'claude', name: 'Boot Claude', installed: true, path: '/sample/bin/claude', version: '1.2.3', models: [] };
    const fresh = { id: 'codex', name: 'Refreshed Codex', installed: true, path: '/sample/bin/codex', version: '4.5.6', models: [] };
    type Answer = typeof boot[] | null;
    type CatalogWindow = Window & { __answerBoot?: (answer: Answer) => void; __answerRefresh?: (answer: Answer) => void };
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text()).replace(/case ["']list_providers["']\s*:/, `$&
        if (!args.deviceId) {
          result = await new Promise(resolve => { window[args.force ? '__answerRefresh' : '__answerBoot'] = resolve; });
          if (result === null) throw new Error('Agent discovery failed');
          break;
        }`);
      await route.fulfill({ response, body: previewBody(body) });
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => typeof (window as CatalogWindow).__answerBoot)).toBe('function');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as CatalogWindow).__answerRefresh)).toBe('function');

    const answer = (key: '__answerBoot' | '__answerRefresh', value: Answer) => page.evaluate(async ({ key, value }) => {
      (window as CatalogWindow)[key]!(value);
      // Let the IPC reply reach the app before advancing to the next action.
      await new Promise(requestAnimationFrame);
    }, { key, value });
    const expected = refresh === 'fails' ? boot : fresh;
    const version = settings.locator(`.provider-diagnostic[data-provider="${expected.id}"] .settings-provider-version`);
    if (refresh === 'fails') {
      await answer('__answerBoot', [boot]);
      await answer('__answerRefresh', null);
      await expect(settings.getByText('Couldn’t check agents. Try refreshing again.')).toBeVisible();
    } else {
      await answer('__answerRefresh', [fresh]);
      await expect(version).toHaveText(fresh.version);
      await answer('__answerBoot', [boot]);
      await expect(version).toHaveText(fresh.version);
    }
    await settings.getByRole('button', { name: 'Back to the workspace' }).click();
    await page.locator('.sidebar-actions .new-task-button').click();
    await expect(page.locator('.new-task-welcome')).toBeVisible();
    const prompt = page.locator('#prompt');
    const chosen = await page.evaluate(async id => {
      const task = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as { provider: string };
      return task.provider;
    }, await prompt.getAttribute('data-session-id'));
    expect(chosen).toBe(expected.id);
    await page.locator('#model-picker-trigger').click();
    const harnesses = page.locator('.model-menu-rail [data-view^="h:"]');
    await expect(harnesses).toHaveCount(1);
    await expect(harnesses.first()).toHaveAttribute('data-view', `h:${expected.id}`);

    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]'));
    expect(kept).toEqual([{ id: expected.id, name: expected.name, installed: true, models: [] }]);
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
    await expect(version).toHaveText(expected.version);
  });
}

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

/** A provisional draft whose correction is held before the native save, while its picker stays open. */
async function heldCorrection(page: Page, deploy = false): Promise<string> {
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.addInitScript(() => { (window as BootWindow).__cloudConnected = true; });
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.evaluate(() => { const w = window as BootWindow; w.__holdDraft = true; w.__holdConfigure = true; });
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  if (deploy) await deployToVercel(page);
  else await page.locator('.sidebar-actions .new-task-button').click();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseDraft), { timeout: 10_000 }).toBe('function');
  if (!deploy) {
    await page.evaluate(() => (window as BootWindow).__releaseDraft!());
    await expect(page.locator('.new-task-welcome')).toBeVisible();
    await page.locator('#model-picker-trigger').click();
    await expect(page.locator('.model-menu')).toBeVisible();
  }
  await release(page);
  await expect.poll(() => answered(page)).not.toBeNull();
  if (deploy) await page.evaluate(() => (window as BootWindow).__releaseDraft!());
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  return (await page.locator('#prompt').getAttribute('data-session-id'))!;
}

test('an explicit picker choice during a held correction wins in memory and storage', async ({ page }) => {
  test.setTimeout(45_000);
  const draft = await heldCorrection(page);
  const menu = page.locator('.model-menu');
  await menu.locator('[role="tab"][data-view="h:codex"]').click();
  await menu.locator('[role="option"]:not([disabled])').first().click();
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'codex');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__configured ?? [])).toEqual([
    { sessionId: draft, provider: 'claude' }, { sessionId: draft, provider: 'codex' },
  ]);
  const saved = await page.evaluate(async id => {
    const preview = await import('/src/preview.ts');
    const task = await preview.invoke('get_task', { sessionId: id }) as { provider: string };
    return task.provider;
  }, draft);
  expect(saved).toBe('codex');
});

test('Deploy during a held correction sends its brief exactly once after the correction', async ({ page }) => {
  test.setTimeout(45_000);
  const draft = await heldCorrection(page, true);
  await expect(page.locator('#prompt')).toHaveValue(/^Deploy this project to Vercel\./);
  expect(await sent(page)).toEqual([]);
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(async () => (await sent(page)).length, { timeout: 10_000 }).toBe(1);
  expect((await sent(page))[0]).toMatchObject({ sessionId: draft, text: expect.stringMatching(/^Deploy this project to Vercel\./) });
  await page.waitForTimeout(600);
  expect(await sent(page)).toHaveLength(1);
});


test('Send pressed twice during a held correction sends the user draft exactly once', async ({ page }) => {
  test.setTimeout(45_000);
  const draft = await heldCorrection(page);
  await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Keep this send while the harness is corrected');
  await page.locator('#prompt').press('Enter');
  await page.locator('#prompt').press('Enter');
  expect(await sent(page)).toEqual([]);
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(async () => (await sent(page)).length, { timeout: 10_000 }).toBe(1);
  expect((await sent(page))[0]).toEqual({ sessionId: draft, text: 'Keep this send while the harness is corrected' });
  await page.waitForTimeout(600);
  expect(await sent(page)).toHaveLength(1);
});

test('early New chat waits for the first session snapshot and keeps its typed text', async ({ page }) => {
  test.setTimeout(45_000);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    let body = await response.text();
    body = body.replace(/case ["']list_sessions["']\s*:/, '$& if (!window.__bootSnapshotAsked) { window.__bootSnapshotAsked = true; await new Promise(resolve => { window.__releaseBootSnapshot = resolve; }); }');
    body = body.replace(/case ["']chat_create["']\s*:\s*\{/, '$& window.__earlyChats = (window.__earlyChats ?? 0) + 1;');
    await route.fulfill({ response, body });
  });
  await page.goto('/');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBootSnapshot)).toBe('function');
  const button = page.locator('.sidebar-actions .new-chat-button');
  await button.click();
  // No chat may open against a snapshot that boot has yet to apply.
  await page.waitForTimeout(500);
  expect(await page.evaluate(() => (window as any).__earlyChats ?? 0)).toBe(0);
  await expect(button).toHaveAttribute('aria-busy', 'true');
  await page.evaluate(() => (window as any).__releaseBootSnapshot());
  await expect.poll(() => page.evaluate(() => (window as any).__earlyChats ?? 0)).toBe(1);
  await expect(button).not.toHaveAttribute('aria-busy', 'true');
  const prompt = page.locator('#prompt');
  const chat = await prompt.getAttribute('data-session-id');
  expect(chat).toBeTruthy();
  expect(chat).not.toBe('session-1');
  await prompt.fill('Keep this early chat draft');
  await page.waitForTimeout(500);
  await expect(prompt).toHaveAttribute('data-session-id', chat!);
  await expect(prompt).toHaveValue('Keep this early chat draft');
});

for (const earlyChat of [true, false]) {
  test(earlyChat ? 'early New chat stays in front of the remembered project draft' : 'startup reopens the remembered project draft without a creation press', async ({ page }) => {
    test.setTimeout(45_000);
    const text = 'Keep this remembered project draft';
    type RestoreWindow = Window & { __releaseBootSnapshot?: () => void; __startupChatId?: string };
    await page.addInitScript(draft => {
      localStorage.setItem('pandacode.project', 'project-1');
      localStorage.setItem('pandacode.openThread', 'unsent-project-draft');
      localStorage.setItem('pandacode.openNewTask', '1');
      localStorage.setItem('pandacode.draft:new:project-1', JSON.stringify({ t: Date.now(), text: draft }));
    }, text);
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const body = (await response.text())
        .replace(/case ["']list_sessions["']\s*:/, '$& if (!window.__releaseBootSnapshot) await new Promise(resolve => { window.__releaseBootSnapshot = resolve; });')
        .replace(/(case ["']chat_create["']\s*:\s*\{[\s\S]*?)(emit\(["']sessions-changed["'])/, '$1 window.__startupChatId = result.id; $2');
      await route.fulfill({ response, body });
    });
    await page.goto('/');
    await expect.poll(() => page.evaluate(() => typeof (window as RestoreWindow).__releaseBootSnapshot)).toBe('function');
    const chatButton = page.locator('.sidebar-actions .new-chat-button');
    const taskButton = page.locator('.sidebar-actions .new-task-button');
    if (earlyChat) {
      await chatButton.click();
      await expect(chatButton).toHaveAttribute('aria-busy', 'true');
    }
    await page.evaluate(() => (window as RestoreWindow).__releaseBootSnapshot!());
    const prompt = page.locator('#prompt');
    if (earlyChat) {
      const chatId = () => page.evaluate(() => (window as RestoreWindow).__startupChatId);
      await expect.poll(chatId).toBeTruthy();
      await expect(chatButton).not.toHaveAttribute('aria-busy', 'true');
      await expect(taskButton).not.toHaveAttribute('aria-busy', 'true');
      await expect(prompt).toHaveAttribute('data-session-id', (await chatId())!);
      await expect(prompt).toHaveValue('');
      await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.draft:new:project-1') ?? '{}').text)).toBe(text);
      await page.locator('#navigation .task-item[data-id="session-1"]').click();
      await taskButton.click();
    }
    await expect(page.locator('.new-task-welcome')).toBeVisible();
    await expect(prompt).toHaveValue(text);
  });
}

for (const outcome of ['success', 'failure', 'switch'] as const) {
  test(`Send waits for the explicit harness save after correction: ${outcome}`, async ({ page }) => {
    test.setTimeout(45_000);
    const draft = await heldCorrection(page);
    await page.evaluate(fail => { const w = window as BootWindow; w.__holdExplicit = true; w.__failExplicit = fail; }, outcome === 'failure');
    const menu = page.locator('.model-menu');
    await menu.locator('[role="tab"][data-view="h:codex"]').click();
    await menu.locator('[role="option"]:not([disabled])').first().click();
    const text = 'Send only after Codex is saved';
    await page.locator('#prompt').fill(text);
    await page.locator('#prompt').press('Enter');
    await page.locator('#prompt').press('Enter');
    await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
    await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseExplicit)).toBe('function');
    await page.waitForTimeout(250);
    expect(await sent(page)).toEqual([]);
    await expect(page.locator('#prompt')).toHaveValue(text);
    if (outcome === 'switch') {
      await page.locator('#navigation').getByRole('button', { name: /^pandacode .*Explore the project/ }).click();
      await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', draft);
    }
    await page.evaluate(() => (window as BootWindow).__releaseExplicit!());
    if (outcome === 'success') {
      await expect.poll(async () => (await sent(page)).length).toBe(1);
      expect((await sent(page))[0]).toEqual({ sessionId: draft, text });
      const saved = await page.evaluate(async id => (await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as { provider: string }).provider, draft);
      expect(saved).toBe('codex');
    } else {
      await page.waitForTimeout(500);
      expect(await sent(page)).toEqual([]);
      if (outcome === 'switch') {
        // Drafts are omitted from the sidebar; New task in their project reopens them.
        const original = await page.evaluate(async id => {
          const preview = await import('/src/preview.ts');
          const task = await preview.invoke('get_task', { sessionId: id }) as { projectId: string };
          const tasks = await preview.invoke('list_sessions', {}) as { id: string; projectId: string; draft: boolean }[];
          return tasks.find(item => item.projectId === task.projectId && !item.draft)!.id;
        }, draft);
        await page.locator(`#navigation .task-item[data-id="${original}"]`).click();
        await page.locator('.sidebar-actions .new-task-button').click();
        await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', draft);
      }
      await expect(page.locator('#prompt')).toHaveValue(text);
    }
  });
}

/* Enter submits the text in the composer at that moment. When the send has to wait (a harness save, a correction), an
 * edit meanwhile cancels that submit and the edited draft stays put; Enter again sends the edit, once. */
async function editWhileSaving(page: Page, draft: string): Promise<void> {
  const prompt = page.locator('#prompt');
  const later = 'A later revision I have not submitted';
  await prompt.fill(later);
  await page.evaluate(() => (window as BootWindow).__releaseExplicit!());
  await page.waitForTimeout(600);
  expect(await sent(page)).toEqual([]);
  await expect(prompt).toHaveValue(later);
  await expect(prompt).toHaveAttribute('data-session-id', draft);
  await prompt.press('Enter');
  await expect.poll(async () => (await sent(page)).length).toBe(1);
  expect((await sent(page))[0]).toEqual({ sessionId: draft, text: later });
  await page.waitForTimeout(500);
  expect(await sent(page)).toHaveLength(1);
}

test('an edit during the explicit harness save after correction cancels that Send and keeps the edit', async ({ page }) => {
  test.setTimeout(45_000);
  const draft = await heldCorrection(page);
  await page.evaluate(() => { (window as BootWindow).__holdExplicit = true; });
  const menu = page.locator('.model-menu');
  await menu.locator('[role="tab"][data-view="h:codex"]').click();
  await menu.locator('[role="option"]:not([disabled])').first().click();
  await page.locator('#prompt').fill('Message submitted by Enter');
  await page.locator('#prompt').press('Enter');
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseExplicit)).toBe('function');
  await editWhileSaving(page, draft);
});

test('an edit during an ordinary harness save cancels that Send and keeps the edit', async ({ page }) => {
  test.setTimeout(45_000);
  await slowProviders(page);
  await page.goto('/');
  const prompt = page.locator('#prompt');
  await expect(prompt).toBeVisible();
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  const thread = (await prompt.getAttribute('data-session-id'))!;
  await page.evaluate(() => { (window as BootWindow).__holdExplicit = true; });
  await prompt.fill('The text I pressed Enter for');
  await page.locator('#model-picker-trigger').click();
  const menu = page.locator('.model-menu');
  await menu.locator('[role="tab"][data-view="h:codex"]').click();
  await menu.locator('[role="option"]:not([disabled])').first().click();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseExplicit)).toBe('function');
  await prompt.press('Enter');
  await page.waitForTimeout(100);
  expect(await sent(page)).toEqual([]);
  await editWhileSaving(page, thread);
});
