import { expect, test, type Page } from '@playwright/test';

// Settings → Agents → Model routing, and the uncapped model catalog sent with an automatic team.
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });

async function install(page: Page, init?: () => void): Promise<void> {
  if (init) await page.addInitScript(init);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      (window.__routing ??= { calls: [] }).calls.push({ command, args: structuredClone(args) });
      // Test hook: \`__routingFail[command] = message\` rejects that command until cleared.
      const failure = window.__routingFail?.[command];
      if (failure) throw new Error(failure);
      // Test hook: \`__routingDelay[command] = ms\` holds that command back before it runs.
      const delay = window.__routingDelay?.[command];
      if (delay) await new Promise(resolve => setTimeout(resolve, delay));
      return invokePreview(command, args);
    }
    async function invokePreview(command, args) {`) });
  });
  await page.goto('/');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
}
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => (window as any).__routing.calls.filter((entry: any) => entry.command === command), command);
async function openAgents(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settings(page).getByRole('tab', { name: 'Agent teams', exact: true }).click();
}
async function closeSettings(page: Page): Promise<void> {
  await settings(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settings(page)).toBeHidden();
}

test('the section renders, settings persist and the profiler downloads', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const toggle = settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true });
  await expect(toggle).toBeChecked();
  await expect(settings(page).getByText('Not downloaded', { exact: true })).toBeVisible();
  await expect(settings(page).getByRole('radio', { name: 'Balanced' })).toHaveAttribute('aria-checked', 'true');
  const minP = settings(page).getByRole('spinbutton', { name: /Minimum chance/ });
  await expect(minP).toBeHidden();
  await settings(page).getByRole('radio', { name: 'Cheap' }).click();
  await expect(minP).toBeVisible();
  await settings(page).getByRole('radio', { name: 'Cheap' }).press('ArrowRight');
  await expect(minP).toBeHidden();
  await settings(page).getByRole('radio', { name: 'Balanced' }).press('ArrowLeft');
  await expect(minP).toBeVisible();
  await toggle.uncheck();
  await settings(page).getByRole('button', { name: 'Download', exact: true }).click();
  await expect(settings(page).getByText('Ready', { exact: true })).toBeVisible();
  await expect(minP).toHaveValue('50');
  await expect(minP).toHaveAttribute('min', '30');
  await expect(minP).toHaveAttribute('max', '90');
  await minP.fill('99'); await minP.blur();
  await expect(minP).toHaveValue('90');
  await minP.fill('10'); await minP.blur();
  await expect(minP).toHaveValue('30');
  // Reopen: the preview keeps the configuration.
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await openAgents(page);
  await expect(settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true })).not.toBeChecked();
  await expect(settings(page).getByRole('radio', { name: 'Cheap' })).toHaveAttribute('aria-checked', 'true');
  await expect(settings(page).getByRole('spinbutton', { name: /Minimum chance/ })).toHaveValue('30');
  await expect(settings(page).getByRole('textbox', { name: 'Task to route' })).toBeDisabled();
  await expect(settings(page).getByText('Ready', { exact: true })).toBeVisible();
});

test('Try it shows a pick and alternatives', async ({ page }) => {
  await install(page);
  await openAgents(page);
  await settings(page).getByRole('textbox', { name: 'Task to route' }).fill('Fix the failing login test');
  await settings(page).getByRole('button', { name: 'Route', exact: true }).click();
  const rows = settings(page).getByRole('list', { name: 'Routed models' }).getByRole('listitem');
  await expect(rows).toHaveCount(5);
  await expect(rows.first()).toContainText('Pick');
  await expect(settings(page).getByText(/debugging/)).toBeVisible();
  expect((await calls(page, 'model_routing_route')).at(-1).args.pool.length).toBeGreaterThan(24);
});

test('the catalog keeps every harness and long shared prefixes', async ({ page }) => {
  await install(page);
  const result = await page.evaluate(async () => {
    const { buildTeamCatalog } = await import('/src/team-catalog.ts');
    const long = 'x'.repeat(90);
    const models = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `M${i}` }));
    const harnesses = [
      { id: 'opencode', name: 'OpenCode', models: [...models('provider/', 700), { id: `${long}a`, name: 'A' }, { id: `${long}b`, name: 'B' }, { id: 'provider/1', name: 'dup' }] },
      { id: 'glm', name: 'GLM', models: models('glm-', 2) }, { id: 'grok', name: 'Grok', models: models('grok-', 2) }, { id: 'muse', name: 'Muse', models: models('muse-', 2) },
      { id: 'kimi', name: 'Kimi', models: models('kimi-', 100) },
    ];
    const { catalog, roster } = buildTeamCatalog(harnesses as any);
    return { count: catalog.length, ids: new Set(catalog.map(m => m.id)).size, providers: [...new Set(catalog.map(m => m.provider))], longBoth: catalog.filter(m => m.model.startsWith(long)).length, dups: catalog.filter(m => m.provider === 'opencode' && m.model === 'provider/1').length, valid: catalog.every(m => /^[a-z0-9_-]{1,100}$/.test(m.id)), roster: roster.length, rosterInCatalog: roster.every(r => catalog.some(c => c.id === r.id)) };
  });
  expect(result.count).toBeLessThanOrEqual(1000);
  expect(result.ids).toBe(result.count);
  expect(result.providers).toEqual(expect.arrayContaining(['opencode', 'glm', 'grok', 'muse', 'kimi']));
  expect(result.longBoth).toBe(2);
  expect(result.dups).toBe(1);
  expect(result.valid).toBe(true);
  expect(result.roster).toBeLessThanOrEqual(24);
  expect(result.rosterInCatalog).toBe(true);
});

test('the cap keeps every harness represented', async ({ page }) => {
  await install(page);
  const providers = await page.evaluate(async () => {
    const { buildTeamCatalog } = await import('/src/team-catalog.ts');
    const models = (prefix: string, n: number) => Array.from({ length: n }, (_, i) => ({ id: `${prefix}${i}`, name: `M${i}` }));
    const { catalog } = buildTeamCatalog([{ id: 'opencode', name: 'OpenCode', models: models('p/', 2000) }, { id: 'glm', name: 'GLM', models: models('glm-', 3) }] as any);
    return { count: catalog.length, glm: catalog.filter(m => m.provider === 'glm').length };
  });
  expect(providers).toEqual({ count: 1000, glm: 3 });
});

// The composer's Team button opens No team · Cheap · Balanced · Best; the kind is Panda Router's global mode.
const teamButton = (page: Page) => page.locator('#team-trigger');
const kind = (page: Page, name: string) => page.getByRole('menuitemradio', { name, exact: true });
async function pickTeam(page: Page, name: string): Promise<void> {
  await teamButton(page).click();
  await kind(page, name).click();
  await expect(kind(page, name)).toBeHidden();
}

test('Team opens a menu of team kinds, turns the team on with the uncapped catalog and prepares routing', async ({ page }) => {
  await install(page);
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  await expect(teamButton(page)).toHaveAttribute('aria-haspopup', 'dialog');
  await expect(teamButton(page)).not.toHaveAttribute('data-on');
  await teamButton(page).click();
  await expect(teamButton(page)).toHaveAttribute('aria-expanded', 'true');
  await expect(page.getByRole('menuitemradio')).toHaveText([/No team/, /Cheap team/, /Balanced team/, /Best team/]);
  await expect(kind(page, 'No team')).toHaveAttribute('aria-checked', 'true');
  await kind(page, 'Cheap team').click();
  await expect(teamButton(page)).toHaveAccessibleName('Cheap team');
  await expect(teamButton(page)).toHaveAttribute('data-on', '');
  expect((await calls(page, 'model_routing_configure')).at(-1).args).toEqual({ enabled: true, mode: 'cheapest' });
  const { config } = (await calls(page, 'architect_configure')).at(-1).args;
  expect(config.auto).toBe(true);
  expect(config.workers.length).toBeLessThanOrEqual(24);
  expect(config.catalog.length).toBeGreaterThan(config.workers.length);
  await expect.poll(async () => (await calls(page, 'model_routing_prepare')).length).toBeGreaterThan(0);
  // Another kind only changes the mode; the team stays as it is.
  const configures = (await calls(page, 'architect_configure')).length;
  await teamButton(page).click();
  await expect(kind(page, 'Cheap team')).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('ArrowDown');
  await kind(page, 'Best team').press('Enter');
  await expect(teamButton(page)).toHaveAccessibleName('Best team');
  expect(await calls(page, 'architect_configure')).toHaveLength(configures);
  // Picking the current kind only closes the menu.
  const modes = (await calls(page, 'model_routing_configure')).length;
  await pickTeam(page, 'Best team');
  expect(await calls(page, 'model_routing_configure')).toHaveLength(modes);
  // No team turns the team off and leaves the mode for next time.
  await pickTeam(page, 'No team');
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  await expect(teamButton(page)).not.toHaveAttribute('data-on');
  expect((await calls(page, 'architect_configure')).at(-1).args.config).toBeNull();
  expect(await calls(page, 'model_routing_configure')).toHaveLength(modes);
});

test('the last team kind is remembered for new tasks and across reloads, and follows Settings both ways', async ({ page }) => {
  await install(page);
  await pickTeam(page, 'Best team');
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  await teamButton(page).click();
  await expect(kind(page, 'Best team')).toHaveAttribute('aria-checked', 'false');
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveText(/No team/);
  await page.keyboard.press('Escape');
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(teamButton(page)).toHaveAccessibleName('Best team');
  await openAgents(page);
  await expect(settings(page).getByRole('radio', { name: 'Best' })).toHaveAttribute('aria-checked', 'true');
  // A change in Settings reaches the button without a reload; the modal makes the composer inert, so read its text.
  await settings(page).getByRole('radio', { name: 'Balanced' }).click();
  await expect(teamButton(page)).toHaveText('Balanced team');
  // With routing off the lead picks models, and the button says only Team.
  await settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true }).uncheck();
  await expect(teamButton(page)).toHaveText('Team');
  await closeSettings(page);
  await teamButton(page).click();
  await expect(kind(page, 'Team')).toHaveAttribute('aria-checked', 'true');
  // A kind turns routing back on.
  await kind(page, 'Cheap team').click();
  await expect(teamButton(page)).toHaveAccessibleName('Cheap team');
  expect((await calls(page, 'model_routing_configure')).at(-1).args).toEqual({ enabled: true, mode: 'cheapest' });
  await openAgents(page);
  await expect(settings(page).getByRole('checkbox', { name: 'Pick worker models with Panda Router', exact: true })).toBeChecked();
  await expect(settings(page).getByRole('radio', { name: 'Cheap' })).toHaveAttribute('aria-checked', 'true');
});

test('a remote task never shows the Team menu', async ({ page }) => {
  await install(page);
  await expect(teamButton(page)).toBeVisible();
  await page.evaluate(() => (window as any).__previewMirrorTeam());
  await page.locator('.task-item[data-id="mirror-team"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'mirror-team');
  await expect(teamButton(page)).toHaveCount(0);
});

test('an unknown mode reads Team and checks no kind', async ({ page }) => {
  await install(page, () => localStorage.setItem('pandacode.preview.routing', JSON.stringify({ mode: 'fastest' })));
  await teamButton(page).click();
  await kind(page, 'No team').click();
  await expect(kind(page, 'No team')).toBeHidden();
  await teamButton(page).click();
  await expect(page.getByRole('menuitemradio', { checked: true })).toHaveText(/No team/);
  await expect(page.getByRole('menuitemradio')).toHaveCount(4);
});

test('a refused mode change after the team turned on shows the menu error and keeps the team on', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__routingFail = { model_routing_configure: 'Routing settings could not be saved.' }; });
  await teamButton(page).click();
  await kind(page, 'Cheap team').click();
  await expect(page.locator('.choice-menu-error')).toHaveText('Routing settings could not be saved.');
  // The team turned on first; the mode stays Balanced.
  expect((await calls(page, 'architect_configure')).at(-1).args.config.auto).toBe(true);
  await expect(teamButton(page)).toHaveAttribute('data-on', '');
  await expect(teamButton(page)).toHaveText('Balanced team');
});

test('a team that cannot turn on leaves the global mode alone', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__routingFail = { architect_configure: 'The team could not be saved.' }; });
  await teamButton(page).click();
  await kind(page, 'Best team').click();
  await expect(page.locator('.choice-menu-error')).toHaveText('The team could not be saved.');
  expect(await calls(page, 'model_routing_configure')).toHaveLength(0);
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  await expect(teamButton(page)).not.toHaveAttribute('data-on');
});

test('with routing off the menu offers a lead-picks team, and kinds say they turn routing on', async ({ page }) => {
  await install(page, () => localStorage.setItem('pandacode.preview.routing', JSON.stringify({ enabled: false })));
  await teamButton(page).click();
  await expect(page.getByRole('menuitemradio')).toHaveText([/No team/, /Team/, /Cheap team/, /Balanced team/, /Best team/]);
  // The kinds keep their own details; the group heading says they turn routing on.
  await expect(page.getByRole('group', { name: 'Worker models for every team · turns routing on' })).toBeVisible();
  await expect(kind(page, 'Cheap team')).toHaveAccessibleDescription('Cheapest model likely to pass');
  await expect(kind(page, 'Best team')).toHaveAccessibleDescription('Strongest model for each worker');
  await expect(kind(page, 'Team')).toHaveAccessibleDescription('The lead picks models');
  // The lead-picks team leaves routing off.
  await kind(page, 'Team').click();
  await expect(teamButton(page)).toHaveAttribute('data-on', '');
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  expect(await calls(page, 'model_routing_configure')).toHaveLength(0);
  // A kind turns routing on, keeping the team.
  const configures = (await calls(page, 'architect_configure')).length;
  await pickTeam(page, 'Cheap team');
  await expect(teamButton(page)).toHaveAccessibleName('Cheap team');
  expect((await calls(page, 'model_routing_configure')).at(-1).args).toEqual({ enabled: true, mode: 'cheapest' });
  expect(await calls(page, 'architect_configure')).toHaveLength(configures);
  await teamButton(page).click();
  await expect(kind(page, 'Team')).toHaveCount(0);
  await expect(kind(page, 'Balanced team')).toHaveAccessibleDescription('Best value for the cost');
});

test('a status read during a pending change never overrides it', async ({ page }) => {
  await install(page);
  await pickTeam(page, 'Cheap team');
  await page.evaluate(() => { (window as any).__routingDelay = { model_routing_configure: 800 }; });
  await teamButton(page).click();
  await kind(page, 'Balanced team').click();
  // The read starts after the change and answers first, with the old mode.
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
  await page.waitForTimeout(300);
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
  await page.evaluate(() => { delete (window as any).__routingDelay; window.dispatchEvent(new Event('focus')); });
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
});

test('without a routing status the menu still offers every choice, and recovers on the next render or focus', async ({ page }) => {
  await install(page, () => { (window as any).__routingFail = { model_routing_status: 'Router unavailable.' }; });
  await teamButton(page).click();
  await expect(page.getByRole('menuitemradio')).toHaveText([/No team/, /Team/, /Cheap team/, /Balanced team/, /Best team/]);
  await expect(page.getByRole('group', { name: 'Worker models for every team · turns routing on' })).toBeVisible();
  await kind(page, 'Team').click();
  await expect(teamButton(page)).toHaveAccessibleName('Team');
  await expect(teamButton(page)).toHaveAttribute('data-on', '');
  expect((await calls(page, 'architect_configure')).at(-1).args.config.auto).toBe(true);
  expect(await calls(page, 'model_routing_configure')).toHaveLength(0);
  await page.evaluate(() => { delete (window as any).__routingFail; window.dispatchEvent(new Event('focus')); });
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
  // A render recovers too, and once loaded renders ask nothing.
  await page.evaluate(() => { (window as any).__routingFail = { model_routing_status: 'Router unavailable.' }; });
  await page.reload();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await page.evaluate(() => { delete (window as any).__routingFail; });
  // Renders retry a failed load at most every 3 s (ROUTING_RETRY_MS).
  await page.waitForTimeout(3100);
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
  const loads = (await calls(page, 'model_routing_status')).length;
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(teamButton(page)).toHaveAccessibleName('Balanced team');
  expect(await calls(page, 'model_routing_status')).toHaveLength(loads);
});

test('a routing change keeps the prompt focus and caret', async ({ page }) => {
  await install(page);
  await pickTeam(page, 'Cheap team');
  const prompt = page.locator('#prompt');
  await prompt.fill('hello world'); await prompt.focus();
  await prompt.evaluate((el: HTMLTextAreaElement) => el.setSelectionRange(5, 5));
  await page.evaluate(() => window.dispatchEvent(new CustomEvent('pandacode:routing', { detail: { enabled: true, mode: 'quality', minP: 0.5, profiler: 'ready', error: null } })));
  await expect(teamButton(page)).toHaveAccessibleName('Best team');
  expect(await prompt.evaluate((el: HTMLTextAreaElement) => [document.activeElement === el, el.selectionStart, el.value])).toEqual([true, 5, 'hello world']);
});

test('the Team button keeps its label and fits the toolbar from wide to the narrowest window', async ({ page }) => {
  await install(page);
  await pickTeam(page, 'Balanced team');
  for (const theme of ['light', 'dark']) {
    if (await page.locator('html').getAttribute('data-theme') !== theme) await page.locator('[data-action="toggle-theme"]').click();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    // 860 is the app's minimum window width (tauri.conf.json); 600 is the browser preview's narrow layout (icon only).
    for (const width of [1280, 860, 600]) {
      await page.setViewportSize({ width, height: 800 });
      const layout = await page.evaluate(() => {
        const toolbar = document.querySelector('.composer-toolbar')!, tools = document.querySelector('.composer-tools')!.getBoundingClientRect();
        const button = document.querySelector('#team-trigger')!, box = button.getBoundingClientRect(), mode = document.querySelector('#mode-picker-trigger')!.getBoundingClientRect();
        const label = button.querySelector('span')!;
        return { toolsRight: tools.right, right: box.right, overflow: toolbar.scrollWidth - toolbar.clientWidth, center: box.top + box.height / 2, modeCenter: mode.top + mode.height / 2, shown: label.offsetWidth > 0, fits: label.scrollWidth <= label.clientWidth };
      });
      expect(layout.shown).toBe(width > 650);
      expect(layout.fits).toBe(true);
      expect(layout.right).toBeLessThanOrEqual(layout.toolsRight);
      expect(layout.overflow).toBeLessThanOrEqual(0);
      expect(Math.abs(layout.center - layout.modeCenter)).toBeLessThanOrEqual(2);
    }
  }
});

test('Unavailable models lists a paused model and Allow now clears it', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Unavailable models', exact: true });
  await expect(group).toBeVisible();
  await expect(group.getByText('gpt-6.1-sol · Command Code')).toBeVisible();
  await expect(group.getByText(/^Paused \d+ min$/)).toBeVisible();
  await group.getByRole('button', { name: 'Allow gpt-6.1-sol · Command Code now', exact: true }).click();
  await expect(group).toBeHidden();
  expect((await calls(page, 'model_health_clear')).at(-1).args).toEqual({ provider: 'commandcode', model: 'gpt-6.1-sol' });
});

test('Models for teams saves harness and model exclusions', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Models for teams', exact: true });
  const last = async () => (await calls(page, 'model_routing_set_exclusions')).at(-1)?.args;
  const claude = group.getByRole('checkbox', { name: 'Use Claude Code for teams', exact: true });
  await expect(claude).toBeChecked();
  await claude.uncheck();
  await expect.poll(last).toEqual({ providers: ['claude'], models: [] });
  await group.getByRole('button', { name: 'Codex models', exact: true }).click();
  await expect(group.getByRole('button', { name: 'Codex models', exact: true })).toHaveAttribute('aria-expanded', 'true');
  const model = group.locator('#routing-pool-codex .routing-pool-model').first();
  const id = await model.getAttribute('data-model');
  await model.uncheck();
  await expect.poll(last).toEqual({ providers: ['claude'], models: [{ provider: 'codex', model: id }] });
  await claude.check();
  await expect.poll(last).toEqual({ providers: [], models: [{ provider: 'codex', model: id }] });
  await expect(group.getByRole('status')).toHaveText(/^\d+ models on$/);
});

test('a health refresh keeps focus on an Allow button and updates the countdown in place', async ({ page }) => {
  await page.clock.install();
  await install(page);
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Unavailable models', exact: true });
  const allow = group.getByRole('button', { name: 'Allow gpt-6.1-sol · Command Code now', exact: true });
  await expect(group.getByText('Paused 8 min', { exact: true })).toBeVisible();
  await allow.focus();
  await page.clock.fastForward('02:00');
  await expect(group.getByText('Paused 6 min', { exact: true })).toBeVisible();
  await expect(allow).toBeFocused();
});

test('the warning shows when every model of every harness is off', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Models for teams', exact: true });
  const warning = group.getByRole('alert');
  await expect(warning).toBeHidden();
  for (const expand of await group.locator('.routing-pool-expand').all()) {
    await expand.click();
    const list = group.locator(`#${await expand.getAttribute('aria-controls')}`);
    await expect(list).not.toHaveText('Loading…');
    for (const box of await list.locator('.routing-pool-model').all()) await box.uncheck();
  }
  await expect(warning).toHaveText("No model is on for teams. Workers will use the lead's model.");
  await expect(group.getByRole('status')).toHaveText('0 models on');
});

test('Models for teams stays disabled until the saved exclusions load', async ({ page }) => {
  await install(page);
  await page.evaluate(() => { (window as any).__routingDelay = { model_routing_exclusions: 800 }; });
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Models for teams', exact: true });
  const claude = group.getByRole('checkbox', { name: 'Use Claude Code for teams', exact: true });
  await expect(group).toHaveAttribute('aria-busy', 'true');
  await expect(claude).toBeDisabled();
  await expect(claude).toBeEnabled();
  await expect(group).toHaveAttribute('aria-busy', 'false');
});

test('exclusion saves run in order and the last one wins', async ({ page }) => {
  await install(page);
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Models for teams', exact: true });
  const claude = group.getByRole('checkbox', { name: 'Use Claude Code for teams', exact: true });
  const codex = group.getByRole('checkbox', { name: 'Use Codex for teams', exact: true });
  await expect(claude).toBeEnabled();
  // The first save is slow; the next ones must wait for it rather than overtake it.
  await page.evaluate(() => { (window as any).__routingDelay = { model_routing_set_exclusions: 600 }; });
  await claude.uncheck();
  await page.evaluate(() => { delete (window as any).__routingDelay; });
  await codex.uncheck();
  await claude.check();
  const saves = async () => (await calls(page, 'model_routing_set_exclusions')).map(entry => entry.args);
  await expect.poll(async () => (await saves()).at(-1)).toEqual({ providers: ['codex'], models: [] });
  // Every save after the slow one carries codex: none was built before it and sent past it.
  const sent = await saves();
  expect(sent[0]).toEqual({ providers: ['claude'], models: [] });
  expect(sent.slice(1).every(args => args.providers.includes('codex'))).toBe(true);
  await expect(claude).toBeChecked();
  await expect(codex).not.toBeChecked();
});

test('a long catalog shows its recent models and Add model… adds one for teams', async ({ page }) => {
  await install(page, () => localStorage.setItem('pandacode.recent-models.hermes', JSON.stringify(Array.from({ length: 10 }, (_, i) => `nous/sample-${i + 1}`))));
  await openAgents(page);
  const group = settings(page).getByRole('group', { name: 'Models for teams', exact: true });
  await group.getByRole('button', { name: 'Hermes Agent models', exact: true }).click();
  const list = group.locator('#routing-pool-hermes');
  await expect(list.locator('.routing-pool-limit')).toHaveText('Showing 10 of 14 models · Add model…');
  await expect(list.getByRole('checkbox', { name: 'Use Nous Sample 12 (Hermes Agent) for teams' })).toHaveCount(0);
  const add = list.getByRole('button', { name: 'Add model…', exact: true });
  await add.click();
  const dialog = page.getByRole('dialog', { name: 'Models for teams: Hermes Agent' });
  const search = dialog.getByRole('searchbox', { name: 'Search Hermes Agent models' });
  await expect(search).toBeFocused();
  await expect(dialog.getByRole('checkbox', { name: /Nous Sample 1\b/ })).toBeDisabled();
  await expect(dialog.getByText('Recently used, always included').first()).toBeVisible();
  await search.fill('sample 12');
  await dialog.getByRole('checkbox', { name: /Nous Sample 12/ }).check();
  await expect(dialog.getByRole('status')).toHaveText('1 added');
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(settings(page)).toBeVisible();
  await expect(list.getByRole('button', { name: 'Add model…', exact: true })).toBeFocused();
  await expect(list.locator('.routing-pool-limit')).toHaveText('Showing 11 of 14 models · Add model…');
  await expect(list.getByRole('checkbox', { name: 'Use Nous Sample 12 (Hermes Agent) for teams' })).toBeChecked();
  expect(await page.evaluate(() => localStorage.getItem('pandacode.team-models.added.hermes'))).toBe('["nous/sample-12"]');
  // The team catalog follows: Try it routes over the limited set plus the added model.
  await settings(page).getByRole('textbox', { name: 'Task to route' }).fill('Fix the failing login test');
  await settings(page).getByRole('button', { name: 'Route', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'model_routing_route')).length).toBe(1);
  const hermes = (await calls(page, 'model_routing_route'))[0].args.pool.filter((m: any) => m.provider === 'hermes').map((m: any) => m.model);
  expect(hermes).toContain('nous/sample-12');
  expect(hermes).not.toContain('nous/sample-11');
  expect(hermes).not.toContain('anthropic/claude-sonnet-4');
});
