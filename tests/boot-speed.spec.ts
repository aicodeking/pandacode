import { expect, test, type Page } from '@playwright/test';

/* Boot opens the first thread without waiting for `list_providers` (native --version probes take seconds). Until the
 * list answers, names and labels come from the last launch's list, nothing says a CLI is missing, and Send stays usable;
 * once it answers, the labels follow it. */

const PROVIDERS_DELAY = 3_000;
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url; window.__bootEmit = emit;\n';
type SavedHarness = { provider: string; model: string };
type BootWindow = Window & { __providersAnswered?: number; __providersAsked?: number; __installNotes?: string[]; __firstMessageAt?: number; __drafts?: number; __releaseProviders?: () => void; __holdRefresh?: boolean; __releaseRefresh?: () => void; __holdExplicit?: boolean; __releaseExplicit?: () => void; __failExplicit?: boolean; __holdConfigure?: boolean; __releaseConfigure?: (error?: string) => void; __holdDraft?: boolean; __releaseDraft?: () => void; __holdAgent?: boolean; __configured?: { sessionId: string; provider: string }[]; __discarded?: string[]; __teamConfigured?: { sessionId: string; lead: string; auto: boolean }[]; __teamStarted?: { sessionId: string; text: string }[]; __bootEmit?: (name: string, payload: unknown) => void; __modeUpdates?: { sessionId: string; mode: string }[]; __boardStarted?: { sessionId: string; provider: string; model: string }[]; __effortCalls?: { sessionId: string; reasoningEffort: string | null }[]; __speedCalls?: { sessionId: string; tier: string | null }[]; __connectionAssigns?: { sessionId: string; connectionId: string | null }[]; __getMessagesCalls?: string[]; __sent?: { sessionId: string; text: string }[]; __sentHarnesses?: SavedHarness[]; __refreshedHarnesses?: string[]; __cloudConnected?: boolean };

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
      if (args.force && window.__refreshedHarnesses) {
        if (window.__holdRefresh) {
          window.__holdRefresh = false;
          await new Promise(resolve => { window.__releaseRefresh = resolve; });
        }
        result = listPreviewProviders(true).filter(provider => window.__refreshedHarnesses.includes(provider.id));
        break;
      }
      if (!args.deviceId) {
        window.__providersAsked = performance.now();
        await new Promise(resolve => ${held} ? (window.__releaseProviders = resolve) : setTimeout(resolve, ${PROVIDERS_DELAY}));
        window.__providersAnswered = performance.now();
      }`).replace(/case ["']create_session["']\s*:\s*\{/, '$& window.__drafts = (window.__drafts ?? 0) + 1; if (window.__holdDraft) await new Promise(resolve => { window.__releaseDraft = resolve; });')
      .replace(/case ["']configure_session["']\s*:\s*\{/, `$&
        (window.__configured ??= []).push({ sessionId: args.sessionId, provider: args.provider });
        if (args.provider === "codex" && window.__holdExplicit) {
          await new Promise(resolve => { window.__releaseExplicit = resolve; });
          if (window.__failExplicit) throw new Error("Explicit save failed");
        }
        if (window.__holdConfigure) {
          window.__holdConfigure = false;
          const error = await new Promise(resolve => { window.__releaseConfigure = resolve; });
          if (error) throw new Error(error);
        }`)
      .replace(/case ["']set_reasoning_effort["']\s*:\s*\{/, `$&
        (window.__effortCalls ??= []).push({ sessionId: args.sessionId, reasoningEffort: args.reasoningEffort ?? null });`)
      .replace(/case ["']set_task_preference["']\s*:\s*\{/, `$&
        if (args.request?.action === "speed") (window.__speedCalls ??= []).push({ sessionId: args.sessionId, tier: args.request.tier ?? null });`)
      .replace(/case ["']connection_assign["']\s*:\s*\{/, `$&
        (window.__connectionAssigns ??= []).push({ sessionId: args.sessionId, connectionId: args.connectionId ?? null });`)
      .replace(/case ["']get_messages["']\s*:\s*\{/, `$&
        (window.__getMessagesCalls ??= []).push(args.sessionId);`)
      .replace(/case ["']send_message["']\s*:\s*\{/, `$&
        (window.__sent ??= []).push({ sessionId: args.sessionId, text: args.text });
        { const { provider, model } = session(args.sessionId); (window.__sentHarnesses ??= []).push({ provider, model }); }
        if (window.__holdAgent) { session(args.sessionId).status = 'running'; break; }`)
      .replace(/case ["']discard_draft["']\s*:\s*\{/, `$&
        (window.__discarded ??= []).push(args.sessionId);`)
      .replace(/case ["']architect_configure["']\s*:/, `$&
        (window.__teamConfigured ??= []).push({ sessionId: args.sessionId, lead: args.architect?.provider ?? session(args.sessionId).provider, auto: Boolean(args.config?.auto) });`)
      .replace(/case ["']architect_start["']\s*:/, `$&
        (window.__teamStarted ??= []).push({ sessionId: args.sessionId, text: args.text });`)
      .replace(/case ["']update_session["']\s*:\s*\{/, `$&
        if (args.mode) (window.__modeUpdates ??= []).push({ sessionId: args.sessionId, mode: args.mode });`)
      .replace(/case ["']start_task["']\s*:\s*\{/, `$&
        { const { provider, model } = session(args.sessionId); (window.__boardStarted ??= []).push({ sessionId: args.sessionId, provider, model }); }`)
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
async function paintedBeforeProviders(page: Page, timeout = 10_000): Promise<void> {
  await expect(page.locator('#transcript .message').first()).toBeVisible({ timeout });
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

    const kept = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]') as { id: string; name: string; installed: boolean; models: { id: string }[] }[]);
    expect(kept).toEqual([{ id: expected.id, name: expected.name, installed: true, models: expect.any(Array) }]);
    expect(kept[0].models.length).toBeGreaterThan(0);
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
const sentHarnesses = (page: Page) => page.evaluate(() => (window as BootWindow).__sentHarnesses ?? []);
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

/** A provisional draft whose correction is held before the native save. */
async function heldCorrection(page: Page, { deploy = false, openPicker = true } = {}): Promise<string> {
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.addInitScript(() => { (window as BootWindow).__cloudConnected = true; });
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);
  await page.evaluate(() => { const w = window as BootWindow; w.__holdDraft = true; w.__holdConfigure = true; });
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  if (deploy) await deployToVercel(page);
  else await page.locator('.sidebar-actions .new-task-button').click();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseDraft), { timeout: 10_000 }).toBe('function');
  if (!deploy) {
    await page.evaluate(() => (window as BootWindow).__releaseDraft!());
    await expect(page.locator('.new-task-welcome')).toBeVisible();
    if (openPicker) {
      await page.locator('#model-picker-trigger').click();
      await expect(page.locator('.model-menu')).toBeVisible({ timeout: 10_000 });
    }
  }
  await release(page);
  await expect.poll(() => answered(page)).not.toBeNull();
  if (deploy) await page.evaluate(() => (window as BootWindow).__releaseDraft!());
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  return (await page.locator('#prompt').getAttribute('data-session-id'))!;
}

test('a deliberate Send retries a rejected automatic harness save', async ({ page }) => {
  test.setTimeout(60_000);
  const draft = await heldCorrection(page, { openPicker: false });
  const prompt = page.locator('#prompt');
  const toast = page.locator('#toast');
  const text = 'Keep this prompt until an installed harness is saved';
  await prompt.fill(text);

  const configured = { sessionId: draft, provider: 'claude' };
  for (const [index, error] of ['Automatic harness save failed', 'Automatic harness retry failed'].entries()) {
    await prompt.press('Enter');
    await expect.poll(() => page.evaluate(() => {
      const w = window as BootWindow;
      return { held: Boolean(w.__releaseConfigure), configured: w.__configured, sent: w.__sent ?? [] };
    })).toEqual({ held: true, configured: Array(index + 1).fill(configured), sent: [] });
    await page.evaluate(error => {
      const w = window as BootWindow;
      const release = w.__releaseConfigure!;
      w.__releaseConfigure = undefined;
      w.__holdConfigure = true;
      release(error);
    }, error);
    await expect(toast).toContainText(error);
    await expect(toast).toBeVisible();
    await expect(prompt).toHaveValue(text);
    expect(await sent(page)).toEqual([]);
  }

  await prompt.press('Enter');
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure)).toBe('function');
  expect(await sent(page)).toEqual([]);
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(prompt).toHaveValue('');
  expect(await sent(page)).toEqual([{ sessionId: draft, text }]);
  expect(await sentHarnesses(page)).toEqual([{ provider: 'claude', model: 'sonnet' }]);
});

test('an open model picker marks the saved correction without losing keyboard focus', async ({ page }) => {
  test.setTimeout(60_000);
  await heldCorrection(page);
  const trigger = page.locator('#model-picker-trigger');
  const menu = page.locator('.model-menu');
  const claude = menu.locator('[role="tab"][data-view="h:claude"]');
  const sonnet = menu.getByRole('option', { name: 'Claude Code · Claude Sonnet 5', exact: true });
  await claude.click();
  await expect(claude).toHaveAttribute('aria-selected', 'true');
  await expect(sonnet).toBeVisible();
  await expect(sonnet).not.toHaveAttribute('aria-current', 'true');
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'antigravity');
  await page.keyboard.press('Tab');
  await expect(claude).toBeFocused();

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect(trigger.locator('[data-model-label]')).toHaveText('Claude Sonnet 5');
  await expect(sonnet).toHaveAttribute('aria-current', 'true');
  await expect(menu.locator('[role="option"][aria-current="true"]')).toHaveCount(1);
  await expect(claude).toHaveAttribute('aria-selected', 'true');
  await expect(claude).toBeFocused();
});

test('an open model picker enables speed tiers after a live correction switches to a supporting model', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { localStorage.setItem('pandacode.model.claude', 'opus'); });
  const draft = await heldCorrection(page);
  const menu = page.locator('.model-menu');
  const speedGroup = menu.locator('.model-menu-effort[data-kind="speed"]');
  await expect(speedGroup).toHaveCount(0);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect(page.locator('#model-picker-trigger [data-model-label]')).toHaveText('Claude Opus 5');
  await expect(speedGroup).toBeVisible();

  const fast = speedGroup.getByRole('radio', { name: 'Fast', exact: true });
  await fast.click();
  await expect(fast).toHaveAttribute('aria-checked', 'true');
  const savedTier = await page.evaluate(async id => {
    const preview = await import('/src/preview.ts');
    const task = await preview.invoke('get_task', { sessionId: id }) as { codexSettings?: { serviceTier?: string | null } };
    return task.codexSettings?.serviceTier ?? null;
  }, draft);
  expect(savedTier).toBe('fast');
});

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
  const draft = await heldCorrection(page, { deploy: true });
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

async function refreshHarnesses(page: Page, ids: string[]): Promise<void> {
  await page.evaluate(ids => { (window as BootWindow).__refreshedHarnesses = ids; }, ids);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]')
    .filter((provider: { installed: boolean }) => provider.installed).map((provider: { id: string }) => provider.id))).toEqual(ids);
  await settings.getByRole('button', { name: 'Back to the workspace' }).click();
}

for (const action of ['Send', 'Deploy', 'Send with no installed harness'] as const) {
  test(`${action} waiting on a held correction uses the latest Settings catalog`, async ({ page }) => {
    test.setTimeout(45_000);
    const draft = await heldCorrection(page, { deploy: action === 'Deploy' });
    if (action !== 'Deploy') await page.keyboard.press('Escape');
    const noHarness = action === 'Send with no installed harness';
    await refreshHarnesses(page, noHarness ? [] : ['codex']);

    const prompt = page.locator('#prompt');
    const text = 'Keep this message through the harness refresh';
    if (action === 'Deploy') {
      await expect(prompt).toHaveValue(/^Deploy this project to Vercel\./);
    } else {
      await prompt.fill(text);
      await prompt.press('Enter');
      await prompt.press('Enter');
    }
    expect(await sent(page)).toEqual([]);
    await page.evaluate(holdNext => {
      const w = window as BootWindow;
      const release = w.__releaseConfigure!;
      w.__releaseConfigure = undefined;
      w.__holdConfigure = holdNext;
      release();
    }, !noHarness);

    if (noHarness) {
      await expect(page.locator('.composer-inline-note')).toHaveText(/This agent is not installed/);
      await expect(prompt).toHaveValue(text);
      expect(await sent(page)).toEqual([]);
      await prompt.press('Enter');
      await expect(page.locator('.composer-inline-note')).toHaveText(/This agent is not installed/);
      await expect(prompt).toHaveValue(text);
      expect(await sent(page)).toEqual([]);
      expect(await page.evaluate(() => (window as BootWindow).__configured)).toEqual([{ sessionId: draft, provider: 'claude' }]);
      return;
    }
    await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure)).toBe('function');
    expect(await sent(page)).toEqual([]);
    await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
    await expect.poll(() => sent(page)).toEqual([{
      sessionId: draft, text: action === 'Deploy' ? expect.stringMatching(/^Deploy this project to Vercel\./) : text,
    }]);
    expect(await sentHarnesses(page)).toEqual([{ provider: 'codex', model: 'default' }]);
    expect(await page.evaluate(() => (window as BootWindow).__configured)).toEqual([
      { sessionId: draft, provider: 'claude' }, { sessionId: draft, provider: 'codex' },
    ]);
    await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'codex');
  });
}

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
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseBootSnapshot), { timeout: 15_000 }).toBe('function');
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
    await expect.poll(() => page.evaluate(() => typeof (window as RestoreWindow).__releaseBootSnapshot), { timeout: 15_000 }).toBe('function');
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
      if (outcome === 'failure') await expect(menu.getByRole('alert')).toHaveText('Explicit save failed');
      else await page.waitForTimeout(500);
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
      if (outcome === 'failure') {
        const trigger = page.locator('#model-picker-trigger');
        await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'claude');
        await expect(trigger.locator('[data-model-label]')).toHaveText('Claude Sonnet 5');
        await menu.locator('[role="tab"][data-view="h:claude"]').click();
        await expect(menu.locator('[role="option"][aria-current="true"]')).toHaveAttribute('data-model', 'sonnet');
        const saved = await page.evaluate(async id => {
          const { provider, model } = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as SavedHarness;
          return { provider, model };
        }, draft);
        expect(saved).toEqual({ provider: 'claude', model: 'sonnet' });
        await page.keyboard.press('Escape');
        await page.locator('#prompt').press('Enter');
        await expect.poll(() => sent(page)).toEqual([{ sessionId: draft, text }]);
        expect(await sentHarnesses(page)).toEqual([saved]);
      }
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
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => answered(page), { timeout: 20_000 }).not.toBeNull();
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

/** Opens the picker on a provisional draft where correction #1 (to claude/opus) has completed and enabled the
 *  picker's effort/speed controls while correction #2 (to `secondProviders[0]`) is still held in flight. */
async function heldSecondCorrection(page: Page, secondProviders: string[]): Promise<string> {
  await page.addInitScript(ids => {
    localStorage.setItem('pandacode.model.claude', 'opus');
    localStorage.setItem('pandacode.model.codex', 'gpt-6-astra');
    const w = window as BootWindow;
    w.__holdRefresh = true;
    w.__refreshedHarnesses = ids;
  }, secondProviders);
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);

  // Start a Settings refresh (higher catalog generation) and keep it held until boot's catalog fills the picker.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseRefresh), { timeout: 10_000 }).toBe('function');
  await settings.getByRole('button', { name: 'Back to the workspace' }).click();

  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const draft = (await page.locator('#prompt').getAttribute('data-session-id'))!;
  await page.locator('#model-picker-trigger').click();
  const menu = page.locator('.model-menu');
  await expect(menu).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => { (window as BootWindow).__holdConfigure = true; });
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');

  // Release the newer Settings refresh so correction #1 loops into a held correction #2.
  await page.evaluate(() => (window as BootWindow).__releaseRefresh!());
  await expect.poll(() => page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]')
    .filter((provider: { installed: boolean }) => provider.installed).map((provider: { id: string }) => provider.id)), { timeout: 10_000 })
    .toEqual(secondProviders);

  await page.evaluate(() => {
    const w = window as BootWindow;
    const done = w.__releaseConfigure!;
    w.__releaseConfigure = undefined;
    w.__holdConfigure = true;
    done();
  });
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__configured ?? [])).toEqual([
    { sessionId: draft, provider: 'claude' }, { sessionId: draft, provider: secondProviders[0] },
  ]);
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect(menu.locator('.model-menu-effort[data-kind="effort"]')).toBeVisible();
  await expect(menu.locator('.model-menu-effort[data-kind="speed"]')).toBeVisible();
  return draft;
}

test('reasoning effort waits for an in-flight provisional correction instead of racing it', async ({ page }) => {
  test.setTimeout(60_000);
  const draft = await heldSecondCorrection(page, ['codex']);
  const menu = page.locator('.model-menu');
  const high = menu.locator('.model-menu-effort[data-kind="effort"]').getByRole('radio', { name: 'High', exact: true });
  await expect(high).toBeEnabled();
  await high.click();
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => (window as BootWindow).__effortCalls ?? [])).toEqual([]);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(menu).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'codex');
  await expect(high).toHaveAttribute('aria-checked', 'true');
  expect(await page.evaluate(() => (window as BootWindow).__effortCalls ?? [])).toEqual([{ sessionId: draft, reasoningEffort: 'high' }]);
  const saved = await page.evaluate(async id => {
    const task = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as { provider: string; model: string; reasoningEffort: string | null };
    return { provider: task.provider, model: task.model, reasoningEffort: task.reasoningEffort };
  }, draft);
  expect(saved).toEqual({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: 'high' });
});

test('speed tier waits for an in-flight provisional correction and re-checks the saved provider', async ({ page }) => {
  test.setTimeout(60_000);
  const draft = await heldSecondCorrection(page, ['cursor']);
  const menu = page.locator('.model-menu');
  const fast = menu.locator('.model-menu-effort[data-kind="speed"]').getByRole('radio', { name: 'Fast', exact: true });
  await expect(fast).toBeEnabled();
  await fast.click();
  await expect(menu).toHaveAttribute('aria-busy', 'true');
  expect(await page.evaluate(() => (window as BootWindow).__speedCalls ?? [])).toEqual([]);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(menu.getByRole('alert')).toHaveText('This agent does not support speed tiers.');
  await expect(menu).toHaveAttribute('aria-busy', 'false');
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'cursor');
  expect(await page.evaluate(() => (window as BootWindow).__speedCalls ?? [])).toEqual([]);
  const saved = await page.evaluate(async id => {
    const task = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as { provider: string; codexSettings?: { serviceTier?: string | null } };
    return { provider: task.provider, serviceTier: task.codexSettings?.serviceTier ?? null };
  }, draft);
  expect(saved).toEqual({ provider: 'cursor', serviceTier: null });
});

test('selecting another model on the corrected harness keeps its connection and skips transcript reload', async ({ page }) => {
  test.setTimeout(60_000);
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const draft = (await page.locator('#prompt').getAttribute('data-session-id'))!;

  // Assign a named connection before the picker opens (and reads connections_list).
  const connectionId = await page.evaluate(async id => {
    const preview = await import('/src/preview.ts');
    const saved = await preview.invoke('connection_save', { connection: { provider: 'claude', name: 'Work Claude' } }) as { connections: { id: string }[] };
    const connection = saved.connections[0].id;
    await preview.invoke('connection_assign', { sessionId: id, connectionId: connection });
    return connection;
  }, draft);

  await page.locator('#model-picker-trigger').click();
  const menu = page.locator('.model-menu');
  await expect(menu).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => { (window as BootWindow).__holdConfigure = true; });
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());

  const trigger = page.locator('#model-picker-trigger');
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect(trigger.locator('[data-model-label]')).toHaveText('Claude Sonnet 5');

  // Clear call logs right before choosing another Claude model from the same picker.
  await page.evaluate(() => {
    const w = window as BootWindow;
    w.__connectionAssigns = [];
    w.__getMessagesCalls = [];
  });
  await menu.locator('[role="tab"][data-view="h:claude"]').click();
  await menu.getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect(menu).toBeHidden();
  await expect(trigger.locator('[data-model-label]')).toHaveText('Claude Opus 5');

  expect(await page.evaluate(() => (window as BootWindow).__connectionAssigns ?? [])).toEqual([]);
  expect(await page.evaluate(() => (window as BootWindow).__getMessagesCalls ?? [])).toEqual([]);
  const state = await page.evaluate(async id => {
    const preview = await import('/src/preview.ts');
    const task = await preview.invoke('get_task', { sessionId: id }) as SavedHarness;
    const connections = await preview.invoke('connections_list', {}) as { tasks: Record<string, string> };
    return { provider: task.provider, model: task.model, connection: connections.tasks[id] ?? null };
  }, draft);
  expect(state).toEqual({ provider: 'claude', model: 'opus', connection: connectionId });
});

test('moving a provisional draft to No project preserves provisional tracking and auto-corrects', async ({ page }) => {
  test.setTimeout(60_000);
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const prompt = page.locator('#prompt');
  const draft = (await prompt.getAttribute('data-session-id'))!;
  const trigger = page.locator('#model-picker-trigger');
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'antigravity');

  const text = 'Move this provisional draft to a projectless chat';
  await prompt.fill(text);
  await page.locator('#welcome-project').click();
  await page.getByRole('option', { name: /No project/ }).click();
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({ timeout: 10_000 });
  const chatId = (await prompt.getAttribute('data-session-id'))!;
  expect(chatId).not.toBe(draft);
  await expect(prompt).toHaveValue(text);
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'antigravity');

  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect(trigger.locator('[data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__configured ?? [])).toEqual([{ sessionId: chatId, provider: 'claude' }]);
  const saved = await page.evaluate(async id => {
    const task = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as SavedHarness;
    return { provider: task.provider, model: task.model };
  }, chatId);
  expect(saved).toEqual({ provider: 'claude', model: 'sonnet' });

  await prompt.press('Enter');
  await expect.poll(() => sent(page)).toEqual([{ sessionId: chatId, text }]);
  expect(await sentHarnesses(page)).toEqual([{ provider: 'claude', model: 'sonnet' }]);
});

test('Settings Default model opened before list_providers answers shows Loading, then real harnesses', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.locator('#default-model')).toBeVisible({ timeout: 10_000 });
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await settings.locator('#default-model').click();
  const menu = page.locator('.model-menu');
  await expect(menu).toBeVisible({ timeout: 10_000 });
  await expect(menu.locator('.model-menu-list')).toHaveText(/Loading…/);
  await expect(menu.locator('.model-menu-rail [role="tab"][data-view^="h:"]')).toHaveCount(0);
  const search = menu.locator('input').first();
  await expect(search).toHaveAttribute('placeholder', 'Loading models…');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect(menu).toBeVisible();
  await expect(menu.locator('.model-menu-rail [data-view="h:claude"]')).toBeVisible();
  await expect(menu.locator('.model-menu-list')).not.toHaveText(/^Loading…$/);
  await expect(menu.locator('.model-menu-list [role="option"]:not([disabled])').first()).toBeVisible();
  await expect(search).toHaveAttribute('placeholder', /^Search [1-9]\d* models, [1-9]\d* harnesses…$/);
  await page.keyboard.press('Escape');
  await expect(menu).toBeHidden();
  await expect(settings.locator('#default-provider')).toContainText('Claude Code');
});

test('Settings Recommended, Agents, and Model routing update live when list_providers settles', async ({ page }) => {
  test.setTimeout(30_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const installState = settings.locator('[data-recommendation="agent"] .recommended-state');
  await expect(installState).toHaveText('Not set', { timeout: 10_000 });

  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await settings.getByRole('tab', { name: 'Model routing', exact: true }).click();
  const routing = settings.locator('#model-routing-settings');
  await expect(routing).toHaveText(/Loading…/);
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await release(page);
  await expect.poll(() => answered(page), { timeout: PROVIDERS_DELAY + 5_000 }).not.toBeNull();
  await expect(routing.locator('.model-routing')).toBeVisible({ timeout: 10_000 });
  await expect(routing.locator('.routing-pool-harness[data-provider="claude"]')).toBeVisible();
  // Recommended refreshed live on providersChanged without waiting to switch back to the tab.
  await expect(installState).toHaveText('Set');
  await settings.getByRole('tab', { name: 'Harnesses', exact: true }).click();
  await expect(settings.locator('.provider-diagnostic[data-provider="claude"] code')).toHaveText('/sample/bin/claude');
});

test('moving a provisional draft to No project during an in-flight correction discards the empty project draft', async ({ page }) => {
  test.setTimeout(60_000);
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);
  await page.waitForTimeout(PROVIDERS_DELAY + 300);
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const prompt = page.locator('#prompt');
  const draft = (await prompt.getAttribute('data-session-id'))!;
  const text = 'Move while provisional correction is in flight';
  await prompt.fill(text);

  // Open the project picker before the correction starts, then hold configure_session in flight.
  await page.locator('#welcome-project').click();
  const noProject = page.getByRole('option', { name: /No project/ });
  await expect(noProject).toBeVisible({ timeout: 10_000 });
  await page.evaluate(() => { (window as BootWindow).__holdConfigure = true; });
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');

  await noProject.click();
  await page.waitForTimeout(200);
  await expect(prompt).toHaveAttribute('data-session-id', draft);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(page.getByRole('heading', { name: 'What’s on your mind?' })).toBeVisible({ timeout: 10_000 });
  const chatId = (await prompt.getAttribute('data-session-id'))!;
  expect(chatId).not.toBe(draft);
  await expect(prompt).toHaveValue(text);
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');

  const sessions = await page.evaluate(async () => {
    const preview = await import('/src/preview.ts');
    return await preview.invoke('list_sessions', {}) as { id: string; provider: string; model: string; draft: boolean }[];
  });
  expect(sessions.find(item => item.id === draft)).toBeUndefined();
  expect(sessions.filter(item => item.draft)).toEqual([]);
  const chat = sessions.find(item => item.id === chatId);
  expect(chat).toMatchObject({ provider: 'claude', model: 'sonnet' });
});

test('dismissing voice-compact mode invalidates promptMetricsCache and restores normal prompt sizing', async ({ page }) => {
  test.setTimeout(30_000);
  await page.goto('/');
  const prompt = page.locator('#prompt');
  await expect(prompt).toBeVisible({ timeout: 15_000 });
  await prompt.fill('Hello');
  const normalHeight = await prompt.evaluate(el => parseFloat((el as HTMLTextAreaElement).style.height));
  expect(normalHeight).toBeGreaterThanOrEqual(70);

  // Enter voice-compact mode and trigger a keystroke so promptMetricsCache records compact metrics.
  await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('#composer')!;
    const area = document.querySelector<HTMLElement>('#composer-area')!;
    composer.style.setProperty('--voice-prompt-height', '40px');
    composer.setAttribute('data-voice-compact', '');
    area.setAttribute('data-voice-compact', '');
  });
  await prompt.focus();
  await page.keyboard.press('Backspace');
  const compactHeight = await prompt.evaluate(el => parseFloat((el as HTMLTextAreaElement).style.height));
  expect(compactHeight).toBeLessThanOrEqual(40);

  // Clear voice-compact mode (as VoicePillPlacement.clearCompactDraft does) and type a character.
  await page.evaluate(() => {
    const composer = document.querySelector<HTMLElement>('#composer')!;
    const area = document.querySelector<HTMLElement>('#composer-area')!;
    area.removeAttribute('data-voice-compact');
    composer.removeAttribute('data-voice-compact');
    composer.style.removeProperty('--voice-prompt-height');
  });
  await page.keyboard.type('o');
  const restoredHeight = await prompt.evaluate(el => parseFloat((el as HTMLTextAreaElement).style.height));
  expect(restoredHeight).toBe(normalHeight);
});

test('leaving an untouched provisional draft during in-flight correction discards it cleanly and honors updated defaults', async ({ page }) => {
  test.setTimeout(60_000);
  const draft = await heldCorrection(page, { openPicker: false });
  const prompt = page.locator('#prompt');
  await expect(prompt).toHaveAttribute('data-session-id', draft);
  await expect(prompt).toHaveValue('');

  // Leave the untouched provisional draft while configure_session is still in flight.
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(prompt).toHaveAttribute('data-session-id', 'session-1');
  // discard_draft waits for the in-flight configure_session so it never races the backend.
  expect(await page.evaluate(() => (window as BootWindow).__discarded ?? [])).toEqual([]);

  // Change Default agent to Codex and press New task while the abandoned correction is still held.
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await settings.locator('#default-provider').click();
  await page.getByRole('menuitemradio', { name: /^Codex/ }).click();
  await expect(settings.locator('#default-provider')).toContainText('Codex');
  await settings.getByRole('button', { name: 'Back to the workspace' }).click();

  await page.evaluate(() => { (window as BootWindow).__holdDraft = false; });
  await page.locator('.sidebar-actions .new-task-button').click();
  await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
  const freshDraft = (await prompt.getAttribute('data-session-id'))!;
  expect(freshDraft).not.toBe(draft);
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'codex');

  // Releasing the abandoned draft's correction finishes cleanly and discards it from storage.
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__discarded ?? []), { timeout: 10_000 }).toEqual([draft]);
  const stored = await page.evaluate(async ([oldId, newId]) => {
    const preview = await import('/src/preview.ts');
    const oldTask = await preview.invoke('get_task', { sessionId: oldId }).catch(() => null);
    const freshTask = await preview.invoke('get_task', { sessionId: newId }) as { id: string; provider: string; draft: boolean };
    return { oldTask, freshTask };
  }, [draft, freshDraft] as const);
  expect(stored.oldTask).toBeNull();
  expect(stored.freshTask).toMatchObject({ id: freshDraft, provider: 'codex', draft: true });
});

for (const timing of ['before-providers', 'during-correction'] as const) {
  test(`automatic Team (${timing}) waits for provisional correction and never locks in an uninstalled lead`, async ({ page }) => {
    test.setTimeout(60_000);
    let draft: string;
    if (timing === 'before-providers') {
      await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
      await page.goto('/');
      await paintedBeforeProviders(page, 25_000);
      await page.waitForTimeout(PROVIDERS_DELAY + 300);
      await page.locator('.sidebar-actions .new-task-button').click();
      await expect(page.locator('.new-task-welcome')).toBeVisible({ timeout: 10_000 });
      draft = (await page.locator('#prompt').getAttribute('data-session-id'))!;
      await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'antigravity');

      await page.locator('#team-trigger').click();
      await page.getByRole('dialog', { name: 'Team', exact: true }).getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([]);

      await page.evaluate(() => { (window as BootWindow).__holdConfigure = true; });
      await release(page);
      await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
      await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([]);
    } else {
      draft = await heldCorrection(page, { openPicker: false });
      await page.locator('#team-trigger').click();
      await page.getByRole('dialog', { name: 'Team', exact: true }).getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
      await page.waitForTimeout(200);
      expect(await page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([]);
    }

    await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
    await expect.poll(() => page.evaluate(() => (window as BootWindow).__teamConfigured ?? []), { timeout: 10_000 })
      .toEqual([{ sessionId: draft, lead: 'claude', auto: true }]);
    await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
    await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');
    const savedLead = await page.evaluate(async id => {
      const preview = await import('/src/preview.ts');
      const task = await preview.invoke('get_task', { sessionId: id }) as { provider: string };
      const team = await preview.invoke('architect_get', { sessionId: id }) as { config?: { auto?: boolean } } | null;
      const profiles = await preview.invoke('architect_profiles', {}) as { lastSetup?: { architect: { provider: string } } | null };
      return { teamAuto: Boolean(team?.config?.auto), taskProvider: task.provider, lastSetupLead: profiles.lastSetup?.architect.provider ?? null };
    }, draft);
    expect(savedLead.teamAuto).toBe(true);
    expect(savedLead.taskProvider).toBe('claude');
    expect(savedLead.lastSetupLead).not.toBe('antigravity');
  });
}

test('Classic Architect Setup waits for provisional correction, stays open when it settles, and saves cleanly', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { localStorage.setItem('pandacode.teamClassic', 'true'); });
  const draft = await heldCorrection(page, { openPicker: false });
  const trigger = page.locator('#architect-setup-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();

  const popover = page.getByRole('dialog', { name: 'Architect & workers', exact: true });
  await expect(popover).toBeVisible({ timeout: 10_000 });
  await expect(popover.getByRole('status')).toHaveText(/Loading team setup/);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(popover).toBeVisible();
  const leadButton = popover.getByRole('button', { name: 'Choose architect model', exact: true });
  await expect(leadButton).toBeVisible({ timeout: 10_000 });
  await expect(leadButton).toContainText(/Claude/);
  await expect(leadButton).not.toContainText(/Antigravity/);

  await popover.getByRole('button', { name: 'Save setup', exact: true }).click();
  await expect(popover).toBeHidden({ timeout: 10_000 });
  await expect(trigger).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([
    { sessionId: draft, lead: 'claude', auto: false },
  ]);
});

test('composer triggers open during an in-flight provisional correction, menus stay anchored, and mode selection succeeds', async ({ page }) => {
  test.setTimeout(60_000);
  const draft = await heldCorrection(page, { openPicker: false });

  // #model-picker-trigger opens while correction is in flight.
  await page.locator('#model-picker-trigger').click();
  await expect(page.locator('.model-menu')).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.locator('.model-menu')).toBeHidden();

  // #welcome-project opens while correction is in flight.
  await page.locator('#welcome-project').click();
  await expect(page.getByRole('option', { name: /No project/ })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  await expect(page.getByRole('option', { name: /No project/ })).toBeHidden();

  // #mode-picker-trigger opens while correction is in flight and stays anchored as correction settles.
  await page.locator('#mode-picker-trigger').click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(permissions).toBeVisible({ timeout: 10_000 });
  await permissions.getByRole('menuitemradio', { name: /^Plan mode/ }).click();
  await page.waitForTimeout(200);
  expect(await page.evaluate(() => (window as BootWindow).__modeUpdates ?? [])).toEqual([]);
  await expect(permissions).not.toContainText('Select the task again');

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__modeUpdates ?? []), { timeout: 10_000 })
    .toEqual([{ sessionId: draft, mode: 'plan' }]);
  await expect(permissions).toBeHidden();
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'plan');
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');

  const saved = await page.evaluate(async id => {
    const task = await (await import('/src/preview.ts')).invoke('get_task', { sessionId: id }) as { provider: string; mode: string };
    return { provider: task.provider, mode: task.mode };
  }, draft);
  expect(saved).toEqual({ provider: 'claude', mode: 'plan' });
});

test('open Permissions menu stays open when provisional correction completes', async ({ page }) => {
  test.setTimeout(60_000);
  await heldCorrection(page, { openPicker: false });
  await page.locator('#mode-picker-trigger').click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(permissions).toBeVisible({ timeout: 10_000 });

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude');
  await expect(permissions).toBeVisible();
});

test('starting a provisional board task during an in-flight correction waits for correction before starting', async ({ page }) => {
  test.setTimeout(60_000);
  await slowProviders(page, [{ id: 'antigravity', name: 'Antigravity', installed: true, models: [] }], true);
  await page.goto('/');
  await paintedBeforeProviders(page, 25_000);

  await page.getByRole('button', { name: /^Workspace view: / }).click();
  await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.waitForTimeout(PROVIDERS_DELAY + 300);

  await page.getByRole('button', { name: 'Add task', exact: true }).click();
  const form = page.locator('#board-task-form');
  await expect(form).toBeVisible({ timeout: 10_000 });
  await form.locator('#board-task-title').fill('Provisional board task');
  await form.getByRole('button', { name: 'Add to pending', exact: true }).click();
  await expect(form).toBeHidden({ timeout: 10_000 });

  const taskId = await page.evaluate(async () => {
    const preview = await import('/src/preview.ts');
    const tasks = await preview.invoke('list_sessions', {}) as { id: string; title: string }[];
    return tasks.find(item => item.title === 'Provisional board task')?.id ?? null;
  });
  expect(taskId).toBeTruthy();

  await page.evaluate(() => { (window as BootWindow).__holdConfigure = true; });
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => typeof (window as BootWindow).__releaseConfigure), { timeout: 10_000 }).toBe('function');

  // Click Start while provisional correction is in flight.
  await page.locator(`button[data-action="board-start"][data-id="${taskId}"]`).first().click();
  await page.waitForTimeout(250);
  expect(await page.evaluate(() => (window as BootWindow).__boardStarted ?? [])).toEqual([]);

  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__boardStarted ?? []), { timeout: 10_000 })
    .toEqual([{ sessionId: taskId, provider: 'claude', model: 'sonnet' }]);
});

test('providerCatalog retains discovered models after loadModels and across subsequent providersLanded', async ({ page }) => {
  test.setTimeout(45_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();

  await expect.poll(() => page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]') as { id: string; models: { id: string }[] }[];
    return saved.find(entry => entry.id === 'claude')?.models.map(m => m.id) ?? [];
  }), { timeout: 10_000 }).toContain('sonnet');

  // Opening Settings → Agents triggers list_providers({ force: true }) -> providersLanded(..., true).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await expect(settings.locator('.provider-diagnostic[data-provider="claude"] code')).toHaveText('/sample/bin/claude', { timeout: 10_000 });

  const afterRefresh = await page.evaluate(() => {
    const saved = JSON.parse(localStorage.getItem('pandacode.providerCatalog') ?? '[]') as { id: string; models: { id: string }[] }[];
    return saved.find(entry => entry.id === 'claude')?.models.map(m => m.id) ?? [];
  });
  expect(afterRefresh).toContain('sonnet');
});

test('Agent updates dialog opened before list_providers resolves updates live when list_providers lands', async ({ page }) => {
  test.setTimeout(45_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);

  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await settings.getByRole('button', { name: 'Check updates', exact: true }).click();

  const dialog = page.getByRole('dialog', { name: 'Agent updates', exact: true });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog).toContainText('No installed agents found.');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect(dialog.locator('.agent-update-row[data-provider="claude"]')).toBeVisible({ timeout: 10_000 });
  await expect(dialog).not.toContainText('No installed agents found.');
});

test('showProviderConnections awaits knownProviders before mounting', async ({ page }) => {
  test.setTimeout(45_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  // Trigger the real [data-action="provider-connections"] click handler before list_providers resolves.
  await page.evaluate(() => {
    const trigger = document.createElement('button');
    trigger.type = 'button';
    trigger.dataset.action = 'provider-connections';
    document.body.append(trigger);
    trigger.click();
    trigger.remove();
  });

  const dialog = page.getByRole('dialog', { name: 'Provider connections', exact: true });
  await expect(dialog).toBeVisible({ timeout: 10_000 });
  await expect(dialog.locator('.dialog-loading')).toHaveText('Loading connections…');
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect(dialog.locator('.dialog-loading')).toHaveCount(0, { timeout: 10_000 });
  await expect(dialog.locator('.connection-card, #named-connections')).not.toHaveCount(0);
});

test('automatic Team while list_providers is pending blocks Send, Model picker, and queue dispatch until Team finishes', async ({ page }) => {
  test.setTimeout(60_000);
  await slowProviders(page, undefined, true);
  await page.goto('/');
  await paintedBeforeProviders(page);

  const prompt = page.locator('#prompt');
  const team = page.locator('#team-trigger');
  const sendButton = page.locator('#composer button[type="submit"].send-button');
  const modelTrigger = page.locator('#model-picker-trigger');
  const modeTrigger = page.locator('#mode-picker-trigger');

  await prompt.fill('Run this with the team');
  await team.click();
  await page.getByRole('dialog', { name: 'Team', exact: true }).getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
  await expect(team).toHaveAttribute('aria-busy', 'true', { timeout: 10_000 });
  await page.keyboard.press('Escape');

  // While setTeam is awaiting list_providers, Send, Model picker, Permissions, and queue dispatch must stay locked.
  await expect(sendButton).toBeDisabled();
  await expect(modelTrigger).toBeDisabled();
  await expect(modeTrigger).toBeDisabled();
  await prompt.press('Enter');
  await modelTrigger.click({ force: true });
  await page.evaluate(async () => {
    const preview = await import('/src/preview.ts');
    await preview.invoke('queue_add', { sessionId: 'session-1', text: 'Queued during team setup', attachments: [] });
    (window as BootWindow).__bootEmit?.('queue-changed', { sessionId: 'session-1' });
  });
  await page.waitForTimeout(250);
  await expect(prompt).toHaveValue('Run this with the team');
  await expect(page.locator('.model-menu')).toHaveCount(0);
  expect(await answered(page), 'still waiting for list_providers').toBeNull();
  expect(await page.evaluate(() => (window as BootWindow).__sent ?? [])).toEqual([]);
  expect(await page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([]);
  expect(await page.evaluate(() => (window as BootWindow).__teamStarted ?? [])).toEqual([]);

  // Releasing list_providers finishes Team setup and delivers the queued follow-up through the Team (never plain send_message).
  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__teamConfigured ?? []), { timeout: 10_000 })
    .toEqual([{ sessionId: 'session-1', lead: 'claude', auto: true }]);
  await expect(team).toHaveAttribute('aria-busy', 'false');
  await expect(team).toHaveAttribute('data-on', '');
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__teamStarted ?? []), { timeout: 10_000 })
    .toEqual([{ sessionId: 'session-1', text: 'Queued during team setup' }]);
  expect(await page.evaluate(() => (window as BootWindow).__sent ?? [])).toEqual([]);
  await expect(prompt).toHaveValue('Run this with the team');
});

test('Classic Architect Setup still opens when provisional correction settles while ./architect is still loading', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => { localStorage.setItem('pandacode.teamClassic', 'true'); });
  let architectRequested!: () => void;
  const askedArchitect = new Promise<void>(resolve => { architectRequested = resolve; });
  let releaseArchitect!: () => void;
  const architectGate = new Promise<void>(resolve => { releaseArchitect = resolve; });
  await page.route('**/src/architect.ts*', async route => {
    architectRequested();
    await architectGate;
    await route.continue();
  });

  const draft = await heldCorrection(page, { openPicker: false });
  const trigger = page.locator('#architect-setup-trigger');
  await expect(trigger).toBeVisible();
  await trigger.click();
  await askedArchitect;
  await expect(trigger).toHaveAttribute('aria-busy', 'true');

  // Settle provisional correction while import('./architect') is still in flight.
  await page.evaluate(() => (window as BootWindow).__releaseConfigure!());
  await expect(page.locator('#model-picker-trigger [data-logo]')).toHaveAttribute('data-logo', 'claude', { timeout: 10_000 });
  releaseArchitect();

  const popover = page.getByRole('dialog', { name: 'Architect & workers', exact: true });
  await expect(popover).toBeVisible({ timeout: 10_000 });
  const leadButton = popover.getByRole('button', { name: 'Choose architect model', exact: true });
  await expect(leadButton).toBeVisible({ timeout: 10_000 });
  await expect(leadButton).toContainText(/Claude/);
  await expect(leadButton).not.toContainText(/Antigravity/);
  await popover.getByRole('button', { name: 'Save setup', exact: true }).click();
  await expect(popover).toBeHidden({ timeout: 10_000 });
  await expect.poll(() => page.evaluate(() => (window as BootWindow).__teamConfigured ?? [])).toEqual([
    { sessionId: draft, lead: 'claude', auto: false },
  ]);
});

test('open composer menu stays open when list_providers lands on a thread with queued messages and updates queue agent name in place', async ({ page }) => {
  test.setTimeout(45_000);
  await slowProviders(page, [{ id: 'claude', name: 'Claude (last launch)', installed: true, models: [] }], true);
  await page.addInitScript(() => { (window as BootWindow).__holdAgent = true; });
  await page.goto('/');
  await paintedBeforeProviders(page);

  await page.locator('#prompt').fill('Start a run before list_providers');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#composer .stop-button')).toBeVisible({ timeout: 10_000 });
  await page.locator('#prompt').fill('Queued before list_providers');
  await page.locator('#prompt').press('Enter');

  const queuePanel = page.locator('#composer > .queue-panel');
  const queueNext = queuePanel.locator('.queue-next');
  await expect(queueNext).toHaveText('Waiting – Claude (last launch) is working', { timeout: 10_000 });
  await queuePanel.evaluate(el => { (el as HTMLElement & { __kept?: boolean }).__kept = true; });

  await page.locator('#team-trigger').click();
  const teamMenu = page.getByRole('dialog', { name: 'Team', exact: true });
  await expect(teamMenu).toBeVisible({ timeout: 10_000 });
  expect(await answered(page), 'still waiting for list_providers').toBeNull();

  await release(page);
  await expect.poll(() => answered(page), { timeout: 10_000 }).not.toBeNull();
  await expect(queueNext).toHaveText('Waiting – Claude Code is working', { timeout: 10_000 });
  await expect(teamMenu).toBeVisible();
  expect(await queuePanel.evaluate(el => (el as HTMLElement & { __kept?: boolean }).__kept)).toBe(true);
});
