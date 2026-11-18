import { expect, test, type Page } from '@playwright/test';

const trigger = (page: Page) => page.locator('#model-picker-trigger');
const picker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const search = (page: Page) => picker(page).getByRole('combobox', { name: 'Search harnesses and models', exact: true });
const task = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  const id = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId;
  return invoke('get_task', { sessionId: id });
});
const activeOption = (page: Page) => picker(page).locator('[role="option"][aria-selected="true"]');
/** Wait for a page's first picker open: it loads the picker module lazily (the trigger is busy meanwhile), and a cold
 *  dev server under parallel workers took 3.7–6.5 s to serve it, past the default 5 s wait. Not a startup race: the
 *  open lands once the module does. */
const FIRST_OPEN_MS = 20_000;

/** Vite's lazy module graph can outlive page.goto. Wait for the first composer, not history or a picker:
 *  a held startup get_messages call still leaves this prompt attached and disabled. */
async function gotoApp(page: Page, url: string): Promise<void> {
  await page.goto(url);
  await page.locator('#prompt').waitFor({ state: 'attached', timeout: 30_000 });
}

async function open(page: Page, url = '/?teams'): Promise<void> {
  // As loadHeld: the rewritten preview module and the first picker open each load cold, so leave them room in the test.
  test.setTimeout(90_000);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__pandacodePreviewUrl = import.meta.url;\n` });
  });
  await gotoApp(page, url);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await trigger(page).click();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
}

// Issue #123: the picker lists only installed harnesses. The preview marks
// Antigravity and Oh My Pi as not installed.
test('the harness picker hides harnesses that are not installed', async ({ page }) => {
  await gotoApp(page, '/');
  await page.locator('.new-task-button').click();
  await page.getByRole('button', { name: /^Model: / }).click();
  await expect(picker(page).getByRole('tab', { name: 'Grok Build' })).toBeVisible();
  await expect(picker(page).locator('[data-provider="antigravity"], [data-provider="omp"]')).toHaveCount(0);
  await expect(picker(page)).not.toContainText('Antigravity');
  await expect(picker(page)).not.toContainText('Oh My Pi');
});

test('opens on the current harness with one-line rows, a scrollable rail and a focused search', async ({ page }) => {
  await open(page);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveAttribute('placeholder', /^Search \d+ models, \d+ harnesses…$/);
  // The popover's entrance spring scales it, so wait for it to settle.
  await expect.poll(async () => (await picker(page).boundingBox())!.width).toBeCloseTo(520, 0);
  expect((await picker(page).boundingBox())!.height).toBeLessThanOrEqual(440);
  const rail = picker(page).getByRole('tablist', { name: 'Harnesses' });
  await expect(rail.getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(rail.getByRole('tab', { name: 'Teams, 2' })).toBeVisible();
  // Every harness is reachable: the last one scrolls into view.
  await rail.getByRole('tab').last().scrollIntoViewIfNeeded();
  await expect(rail.getByRole('tab').last()).toBeInViewport();
  const list = picker(page).getByRole('listbox');
  await expect(list.getByRole('option').first()).toHaveAccessibleName('Claude Code · Default');
  await expect(list.locator('[aria-current="true"]')).toHaveCount(1);
  await expect(activeOption(page)).toHaveAttribute('aria-current', 'true');
  await expect(search(page)).toHaveAttribute('aria-activedescendant', (await activeOption(page).getAttribute('id'))!);
  for (const height of await list.getByRole('option').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))) expect(height).toBe(28);
  // The harness logo shows once, in the heading.
  await expect(list.locator('.model-menu-option .provider-logo')).toHaveCount(0);
  // Instant: no transitions or running animations in the panel, apart from the effort control's sliding thumb.
  expect(await picker(page).evaluate(panel => [panel, ...panel.querySelectorAll('*:not(.segment-thumb)')].filter(node => getComputedStyle(node).transitionDuration.split(',').some(value => parseFloat(value) > 0)).length)).toBe(0);
});

test('the picker is a small inset shell: a bare rail beside one inset list panel', async ({ page }) => {
  await open(page);
  const look = await picker(page).evaluate(panel => {
    // Resolve a token the way the browser paints it, so the comparison holds in any theme.
    const resolved = (property: 'color' | 'backgroundColor', token: string) => {
      const probe = document.createElement('span');
      probe.style[property] = `var(${token})`;
      panel.append(probe);
      const value = getComputedStyle(probe)[property];
      probe.remove();
      return value;
    };
    const list = getComputedStyle(panel.querySelector('.model-menu-list')!);
    const thumb = getComputedStyle(panel.querySelector('.model-menu-effort>.segment-thumb')!);
    const box = (selector: string) => panel.querySelector(selector)!.getBoundingClientRect();
    return {
      rail: getComputedStyle(panel.querySelector('.model-menu-rail')!).backgroundColor,
      listBorder: [list.borderTopWidth, list.borderTopColor], border: resolved('color', '--ds-border'),
      listFill: list.backgroundColor, inner: resolved('backgroundColor', '--ds-card-inner'),
      listRadius: list.borderTopLeftRadius, radius: getComputedStyle(document.documentElement).getPropertyValue('--ds-radius-inner').trim(),
      thumb: thumb.backgroundColor, thumbToken: resolved('backgroundColor', '--ds-thumb'),
      listEdges: [box('.model-menu-list').left, box('.model-menu-list').right], trackEdges: [box('.model-menu-effort').left, box('.model-menu-effort').right],
    };
  });
  expect(look.rail).toBe('rgba(0, 0, 0, 0)');
  expect(look.listBorder).toEqual(['1px', look.border]);
  expect(look.listFill).toBe(look.inner);
  expect(look.listRadius).toBe(look.radius);
  expect(look.thumb).toBe(look.thumbToken);
  // The effort track lines up under the panel.
  expect(look.trackEdges).toEqual(look.listEdges);
});

test('a team row keeps its name readable; the detail gives way first', async ({ page }) => {
  await open(page);
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  const names = picker(page).locator('.model-menu-team .model-menu-name');
  await expect(names).toHaveCount(2);
  expect(await names.evaluateAll(nodes => nodes.every(node => node.scrollWidth <= Math.ceil(node.getBoundingClientRect().width)))).toBe(true);
});

// True when the element's own text fits, and nothing of it is cut by its row.
const notClipped = (node: Element) => {
  const row = node.closest('.model-menu-option')!.getBoundingClientRect(), box = node.getBoundingClientRect();
  return node.scrollWidth <= Math.ceil(box.width) && box.width > 0 && box.right <= row.right;
};

test('a long custom ID truncates its quoted text and keeps the harness name whole', async ({ page }) => {
  await open(page);
  await page.keyboard.type('no-such-thing-at-all-and-then-a-great-deal-more-text-than-any-row-can-hold');
  const row = picker(page).getByRole('option', { name: /^Use "/ });
  await expect(row.locator('.model-menu-meta')).toHaveText('Claude Code');
  expect(await row.locator('.model-menu-meta').evaluate(notClipped)).toBe(true);
  expect(await row.locator('.model-menu-name').evaluate(node => node.scrollWidth > node.clientWidth)).toBe(true);
  await expect(row).toHaveAccessibleName('Use "no-such-thing-at-all-and-then-a-great-deal-more-text-than-any-row-can-hold" with Claude Code');
});

test('a team row keeps the worker count when its lead cannot fit', async ({ page }) => {
  await open(page);
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  const rows = picker(page).locator('.model-menu-team');
  await expect(rows).toHaveCount(2);
  for (const count of await rows.locator('.model-menu-meta-count').all()) {
    await expect(count).toContainText(/\d+ workers?$/);
    expect(await count.evaluate(notClipped)).toBe(true);
  }
  await expect(rows.first().locator('.model-menu-meta')).toHaveText('Claude Opus 5 · 3 workers');
  // In a narrow window the lead gives way and the count still shows whole.
  await page.setViewportSize({ width: 480, height: 800 });
  await expect.poll(() => rows.first().locator('.model-menu-meta-count').evaluate(notClipped)).toBe(true);
});

test('search flattens matches across harnesses and the rail becomes a hit map', async ({ page }) => {
  await open(page);
  await page.keyboard.type('sonne');
  await expect(search(page)).toHaveValue('sonne');
  const rail = picker(page).getByRole('tablist');
  await expect(rail.getByRole('tab', { name: 'Codex', exact: true })).toHaveClass(/is-dim/);
  await expect(rail.getByRole('tab', { name: 'Claude Code', exact: true }).locator('.model-menu-count')).toHaveText('1');
  await expect(activeOption(page)).toHaveAccessibleName('Claude Code · Claude Sonnet 5');
  // One custom row, for the viewed harness, after the real hits.
  await expect(picker(page).getByRole('option', { name: /^Use "/ })).toHaveCount(1);
  await expect(picker(page).getByRole('option').last()).toHaveAccessibleName('Use "sonne" with Claude Code');
  await expect(picker(page).locator('.model-menu-empty')).toHaveCount(0);
  // A query that names a harness offers no custom row.
  await search(page).fill('codex');
  await expect(picker(page).getByRole('option', { name: /^Use "/ })).toHaveCount(0);
  await search(page).fill('no-such-thing-at-all');
  await expect(picker(page).locator('.model-menu-empty')).toHaveText('No matching models.');
  await expect(picker(page).getByRole('option')).toHaveCount(1);
  await expect(picker(page).getByRole('option').first()).toHaveAccessibleName('Use "no-such-thing-at-all" with Claude Code');
  await search(page).fill('Ship');
  await expect(picker(page).getByRole('option').first()).toHaveAccessibleName('Agent team · Ship crew');
});

test('keyboard: arrows move rows, left/right change harness, Enter picks, Tab cycles without closing', async ({ page }) => {
  await open(page);
  await page.keyboard.press('ArrowRight');
  await expect(picker(page).getByRole('tab', { name: 'Codex', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(activeOption(page)).toHaveAccessibleName('Codex · Default');
  // Step through the fetched list, not the bundled one it replaces.
  await expect(picker(page).locator('[data-catalog-loading="codex"]')).toBeHidden();
  await page.keyboard.press('ArrowUp');
  await expect(activeOption(page)).not.toHaveAccessibleName('Codex · Default');
  const last = await activeOption(page).getAttribute('aria-label');
  await page.keyboard.press('ArrowDown');
  await expect(activeOption(page)).toHaveAccessibleName('Codex · Default');
  expect(last).not.toBe('Codex · Default');
  await page.keyboard.press('End');
  await expect(activeOption(page)).toHaveAccessibleName(last!);
  // Tab: search → rail → effort → search, never closing.
  await page.keyboard.press('Tab');
  await expect(picker(page).getByRole('tab', { name: 'Codex', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(picker(page).getByRole('radio', { name: 'Default', exact: true })).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(search(page)).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(picker(page).getByRole('radio', { name: 'Default', exact: true })).toBeFocused();
  await expect(picker(page)).toBeVisible();
  // Typing anywhere goes to search.
  await page.keyboard.type('astra');
  await expect(search(page)).toHaveValue('astra');
  await expect(activeOption(page)).toHaveAccessibleName('Codex · GPT-6-Astra');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('GPT-6-Astra');
  await expect.poll(() => task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
});

test('effort is a segmented radiogroup that saves on choice', async ({ page }) => {
  await open(page);
  const group = picker(page).getByRole('radiogroup', { name: 'Effort' });
  await expect(group.getByRole('radio', { name: 'Default', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(group.locator('[data-model-default]')).toHaveText('Medium');
  await expect(group.locator('.segment-thumb')).toHaveCount(1);
  await group.getByRole('radio', { name: 'High', exact: true }).click();
  await expect(group.getByRole('radio', { name: 'High', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('high');
  await expect(picker(page).locator('.model-menu-effort-hint')).toHaveText('Sample high effort.');
  await expect(trigger(page).locator('.model-effort')).toHaveText('High');
  // Arrow keys step and save.
  await group.getByRole('radio', { name: 'High', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('medium');
  await page.keyboard.press('Home');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBeNull();
  await expect(trigger(page).locator('.model-effort')).toBeHidden();
  await expect(picker(page)).toBeVisible();
});

test('teams: picking one sets the team, a plain model clears it', async ({ page }) => {
  await open(page);
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  const ship = picker(page).getByRole('option', { name: 'Agent team · Ship crew', exact: true });
  await expect(ship).toContainText('3 workers');
  await expect(ship.locator('.provider-logo')).toHaveCount(3);
  await ship.click();
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('Ship crew');
  await expect(trigger(page).locator('.model-menu-stack .provider-logo')).toHaveCount(3);
  await trigger(page).click();
  await expect(picker(page).getByRole('tab', { name: 'Teams, 2' })).toHaveAttribute('aria-selected', 'true');
  await expect(picker(page).getByRole('option', { name: 'Agent team · Ship crew', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(picker(page).locator('.model-menu-settings')).toContainText('Set per worker');
  await expect(picker(page).getByRole('radiogroup')).toHaveCount(0);
  await picker(page).getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).not.toContainText('Ship crew');
  await expect(trigger(page)).toContainText('Claude Opus 5');
  await expect(trigger(page).locator('.model-menu-stack')).toHaveCount(0);
});

test('a ZCode model joins an automatic team instead of leaving it', async ({ page }) => {
  await page.addInitScript(() => {
    const worker = { id: 'codex-default', name: 'Codex', provider: 'codex', model: 'default', reasoningEffort: null };
    localStorage.setItem('pandacode.preview.architect-configs', JSON.stringify({ 'session-1': {
      auto: true, workers: [worker], catalog: [worker], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072,
    } }));
  });
  await open(page, '/');
  await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
  // A redraw while the team loads can close a freshly opened menu, so try again until one stays.
  await expect(async () => {
    if (!(await picker(page).isVisible())) await trigger(page).click();
    await expect(picker(page).getByRole('tab', { name: 'ZCode', exact: true })).toBeVisible();
  }).toPass();
  // ZCode carries the team tools now, so its model keeps the automatic team.
  await picker(page).getByRole('tab', { name: 'ZCode', exact: true }).click();
  await picker(page).getByRole('option', { name: 'ZCode · zcproxy/GLM-5.3', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => task(page)).toMatchObject({ provider: 'zcode', model: 'zcproxy/GLM-5.3' });
  await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
  await expect.poll(async () => {
    const team = await page.evaluate(async () => {
      const { invoke } = await import((window as any).__pandacodePreviewUrl);
      return invoke('architect_get', { sessionId: 'session-1' });
    });
    return team?.config?.auto === true && [...team.config.workers, ...team.config.catalog].some((profile: any) => profile.provider === 'zcode');
  }).toBe(true);
});

test('Esc clears the query first, then closes and returns focus to the trigger', async ({ page }) => {
  await open(page);
  await page.keyboard.type('opus');
  await page.keyboard.press('Escape');
  await expect(search(page)).toHaveValue('');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toBeFocused();
});

for (const ime of ['isComposing', 'keyCode229'] as const) for (const query of ['opus', '']) {
  test(`IME Escape (${ime}) preserves the open picker with ${query ? 'a query' : 'empty search'}`, async ({ page }) => {
    await loadHeld(page);
    await openSettled(page);
    if (query) await search(page).fill(query);
    await expect(search(page)).toBeFocused();
    const selected = await activeOption(page).getAttribute('id');
    const before = await task(page);
    const choicesAndSends = () => page.evaluate(() => (window as any).__calls.filter((command: string) => ['configure_session', 'set_reasoning_effort', 'architect_configure', 'send_message', 'architect_start'].includes(command)));
    const callsBefore = await choicesAndSends();
    await search(page).evaluate((node, kind) => {
      if (kind === 'keyCode229') {
        node.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
        node.dispatchEvent(new CompositionEvent('compositionend', { bubbles: true }));
      }
      node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true, cancelable: true,
        ...(kind === 'isComposing' ? { isComposing: true } : { keyCode: 229 }) }));
    }, ime);
    await expect(picker(page)).toBeVisible();
    await expect(search(page)).toHaveValue(query);
    await expect(search(page)).toBeFocused();
    await expect(activeOption(page)).toHaveAttribute('id', selected!);
    await expect(search(page)).toHaveAttribute('aria-activedescendant', selected!);
    expect(await task(page)).toEqual(before);
    expect(await choicesAndSends()).toEqual(callsBefore);
    if (query) {
      await page.keyboard.press('Escape');
      await expect(search(page)).toHaveValue('');
      await expect(picker(page)).toBeVisible();
      await expect(search(page)).toBeFocused();
    }
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await expect(trigger(page)).toBeFocused();
  });
}

test('narrow windows collapse the rail to logos', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 800 });
  await open(page);
  const tab = picker(page).getByRole('tab', { name: 'Claude Code', exact: true });
  expect((await tab.boundingBox())!.width).toBeLessThan(50);
  await expect(tab.locator('.model-menu-tab-label')).toBeHidden();
});

/** Holds these preview commands back, so the app reaches the given moment with them still unanswered. */
async function delayCommands(page: Page, commands: string[], ms = 500): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const marker = /switch\s*\(command\)\s*\{/;
    await route.fulfill({ response, body: `${(await response.text()).replace(marker, `if (${JSON.stringify(commands)}.includes(command)) await new Promise(done => setTimeout(done, ${ms}));\nswitch (command) {`)}\nwindow.__pandacodePreviewUrl = import.meta.url;\n` });
  });
}

test('a harness list that answers late still fills the picker', async ({ page }) => {
  await delayCommands(page, ['list_providers']);
  await gotoApp(page, '/');
  await page.locator('.new-task-button').click();
  await trigger(page).click();
  await expect(picker(page).locator('[role="tab"][data-view="h:grok"]')).toBeVisible();
  // Typing keeps its place in the same picker.
  await page.keyboard.type('sonne');
  await expect(search(page)).toHaveValue('sonne');
  await expect(picker(page).getByRole('tab', { name: 'Grok Build', exact: true })).toBeVisible();
});

test('the Model button pressed while New task is on its way opens on the new task and stays open', async ({ page }) => {
  await delayCommands(page, ['create_session']);
  await gotoApp(page, '/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  const before = (await page.evaluate(async () => { const { invoke } = await import((window as any).__pandacodePreviewUrl); return invoke('get_task', { sessionId: 'session-1' }); }) as any);
  await page.locator('.new-task-button').click();
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
  // The pick landed on the new task, not on the one the button belonged to when it was pressed.
  await expect.poll(() => task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  const after = await page.evaluate(async () => { const { invoke } = await import((window as any).__pandacodePreviewUrl); return invoke('get_task', { sessionId: 'session-1' }); }) as any;
  expect([after.provider, after.model]).toEqual([before.provider, before.model]);
});

test('the picker shows provider logos for Cline, Kilo Code and Oh My Pi', async ({ page }) => {
  test.setTimeout(90_000); // As loadHeld: a rewritten preview module and a cold first picker open.
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `if (command === 'list_providers') return structuredClone(providers.map(p => ({ ...p, installed: true })));\nswitch (command) {`) });
  });
  await gotoApp(page, '/');
  await page.locator('.new-task-button').click();
  await trigger(page).click();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
  const rail = picker(page).getByRole('tablist', { name: 'Harnesses' });
  for (const [name, id] of [['Cline', 'cline'], ['Kilo Code', 'kilo'], ['Oh My Pi', 'omp']]) {
    const tab = rail.getByRole('tab', { name, exact: true });
    await expect(tab.locator(`.provider-logo[data-provider="${id}"]:not(.provider-logo-tile)`)).toHaveCount(1);
    await tab.click();
    await expect(picker(page).locator(`.provider-logo[data-provider="${id}"]:not(.provider-logo-tile)`).first()).toBeVisible();
  }
});

/** Saved/native account assignments are metadata, never extra picker choices. */
async function accountFixture(page: Page, pooled: boolean) {
  // As loadHeld: a rewritten preview module and a cold first picker open need room inside the test.
  test.setTimeout(90_000);
  const connections = ['claude', 'codex', 'kimi'].flatMap(provider => Array.from({ length: 6 }, (_, i) => ({
    id: `${provider}-${i}`, provider, name: `${provider} account ${i}`, args: [], env: {}, secretEnv: [], configDir: `/tmp/pandacode-fixture/${provider}-${i}`, revision: 1,
  })));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/switch\s*\(command\)\s*\{/, `(window.__accountCalls ??= []).push({ command, args: structuredClone(args) }); switch (command) {`);
    await route.fulfill({ response, body: `${body}\npreviewConnections = ${JSON.stringify({ connections, tasks: { 'session-1': 'claude-0' }, pools: pooled ? ['claude', 'codex'] : [], poolExcluded: [] })};\nwindow.__pandacodePreviewUrl = import.meta.url;\nwindow.__accountSnapshot = () => structuredClone(previewConnections);\n` });
  });
  await gotoApp(page, '/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}
const accountCalls = (page: Page, command: string) => page.evaluate(name => (window as any).__accountCalls.filter((c: any) => c.command === name), command);

for (const pooled of [false, true]) test(`accounts never duplicate harness tabs, models or search hits with pooling ${pooled ? 'on' : 'off'}`, async ({ page }) => {
  await accountFixture(page, pooled);
  await trigger(page).click();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
  const tabs = picker(page).getByRole('tablist', { name: 'Harnesses' }).getByRole('tab');
  const labels = await tabs.evaluateAll(nodes => nodes.map(node => node.textContent));
  expect(labels.filter(label => label?.includes('account'))).toEqual([]);
  expect(new Set(labels).size).toBe(labels.length);
  for (const name of ['Claude Code', 'Codex', 'Kimi Code']) await expect(picker(page).getByRole('tab', { name, exact: true })).toHaveCount(1);
  await expect(picker(page).getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(picker(page).locator('[aria-current="true"]')).toHaveAccessibleName('Claude Code · Claude Sonnet 5');
  const options = await picker(page).getByRole('option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(new Set(options).size).toBe(options.length);
  await search(page).fill('sonne');
  await expect(picker(page).getByRole('option', { name: 'Claude Code · Claude Sonnet 5', exact: true })).toHaveCount(1);
  const hits = await picker(page).getByRole('option').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label')));
  expect(new Set(hits).size).toBe(hits.length);
  expect(hits.some(label => label?.includes('account'))).toBe(false);
  await expect(picker(page).getByRole('tab', { name: 'Claude Code', exact: true }).locator('.model-menu-count')).toHaveText('1');
  expect(await accountCalls(page, 'connection_pool_set')).toEqual([]);
});

test('changing model within a harness keeps its native account binding and resumable conversation', async ({ page }) => {
  await accountFixture(page, true);
  const before = await task(page);
  await trigger(page).click();
  await picker(page).getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect.poll(async () => (await task(page)).model).toBe('opus');
  const after = await task(page);
  expect(after.resumeId).toBe(before.resumeId);
  expect(await accountCalls(page, 'connection_assign')).toEqual([]);
  expect(await page.evaluate(() => (window as any).__accountSnapshot().tasks['session-1'])).toBe('claude-0');
  await trigger(page).click();
  await expect(picker(page).getByRole('tab', { name: 'Claude Code', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(picker(page).locator('[aria-current="true"]')).toHaveAccessibleName('Claude Code · Claude Opus 5');
});


test('a true harness switch clears a stale account binding after configuring the new harness', async ({ page }) => {
  await accountFixture(page, true);
  await trigger(page).click();
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true }).click();
  await expect.poll(async () => (await task(page)).provider).toBe('codex');
  await expect.poll(() => accountCalls(page, 'connection_assign')).toEqual([{ command: 'connection_assign', args: { sessionId: 'session-1', connectionId: null } }]);
  const calls = await page.evaluate(() => (window as any).__accountCalls.filter((c: any) => ['configure_session', 'connection_assign'].includes(c.command)).map((c: any) => c.command));
  expect(calls).toEqual(['configure_session', 'connection_assign']);
  expect(await page.evaluate(() => (window as any).__accountSnapshot().tasks['session-1'])).toBeUndefined();
  expect(await accountCalls(page, 'connection_pool_set')).toEqual([]);
});

// Model switching is optimistic: the picker opens on cached data and a pick shows at once while the backend saves.
/** Loads the preview with holdable commands (HELD; `holdCall`, then `releaseCall`) and a log of every call (`__calls`). */
const HELD = ['architect_profiles', 'configure_session', 'set_reasoning_effort', 'list_provider_models', 'get_messages', 'get_task', 'send_message', 'update_session'];
/** `clock`: a controllable clock, to step past the catalogs' 5-minute expiry. */
async function loadHeld(page: Page, url = '/?teams', { clock = false, startupHolds = [] as string[] } = {}): Promise<void> {
  // A cold dev server compiles the rewritten preview module first: leave the boot wait room inside the test.
  test.setTimeout(90_000);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    let patched = 0;
    const body = (await response.text())
      .replace(new RegExp(`case (["'])(${HELD.join('|')})\\1:`, 'g'), (found, _q, name) => { patched += 1; return `${found} { const gate = window.__holds?.[${JSON.stringify(name)}]; if (gate) { (window.__atGate ??= {})[${JSON.stringify(name)}] = true; await gate; } const over = window.__override?.[${JSON.stringify(name)}]?.(args); if (over !== undefined) return over; }`; })
      .replace(/async function invoke\(command, args\) \{/, found => { patched += 1; return `${found} (window.__calls ??= []).push(command); (window.__callArgs ??= []).push([command, args]);`; });
    await route.fulfill({ response, body: `${body}\nwindow.__pandacodePreviewUrl = import.meta.url;\nwindow.__previewPatched = ${patched};\n` });
  });
  await page.addInitScript((startup: string[]) => {
    const w = window as any;
    w.__holds = {};
    w.__hold = (name: string) => { let release!: (fail?: string) => void; w.__holds[name] = new Promise<void>((resolve, reject) => { release = fail => { delete w.__holds[name]; fail ? reject(new Error(fail)) : resolve(); }; }); w.__release = { ...w.__release, [name]: release }; };
    for (const name of startup) w.__hold(name);
  }, startupHolds);
  if (clock) await page.clock.install();
  await gotoApp(page, url);
  // The rewritten preview module compiles uncached, so the first boot can take longer than the default wait.
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
  // Fail loudly when preview.ts changes shape: every held command and the call log.
  expect(await page.evaluate(() => (window as any).__previewPatched), 'preview.ts rewrite for held calls').toBe(HELD.length + 1);
}
const sent = (page: Page) => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'send_message').length);
const holdCall = (page: Page, name: string) => page.evaluate(n => (window as any).__hold(n), name);
/** Releases a held command once a call is waiting at its gate (releasing earlier would let that call through unheld). */
async function releaseCall(page: Page, name: string, fail?: string): Promise<void> {
  await expect.poll(() => page.evaluate(n => Boolean((window as any).__atGate?.[n]), name), { message: `a ${name} call waiting to be released` }).toBe(true);
  await page.evaluate(([n, f]) => { const w = window as any; w.__atGate[n] = false; w.__release[n](f); }, [name, fail] as const);
}

/** Open exactly once: startup refreshes must preserve the interaction. */
async function openSettled(page: Page): Promise<void> {
  await trigger(page).click();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
}
async function pickAstra(page: Page): Promise<void> {
  await openSettled(page);
  await search(page).fill('astra');
  await page.keyboard.press('Enter');
}

/** Keep the lazy choice-menu import pending without delaying the application's initial module graph. */
async function holdChoiceModule(page: Page): Promise<() => void> {
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/src/choice-menu.ts*', async route => {
    const response = await route.fetch();
    await gate;
    await route.fulfill({ response });
  });
  return release;
}

for (const pending of [true, false]) test(`startup refresh preserves ${pending ? 'pending' : 'open'} Permissions`, async ({ page }) => {
  const release = pending ? await holdChoiceModule(page) : () => {};
  try {
    await loadHeld(page, '/?teams', { startupHolds: ['get_messages'] });
    const mode = page.locator('#mode-picker-trigger'), menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
    await mode.click();
    if (pending) await expect(mode).toHaveAttribute('aria-busy', 'true');
    else await expect(menu).toBeVisible();
    await releaseCall(page, 'get_messages');
    await expect(page.locator('#prompt')).toBeEnabled();
    release();
    await expect(menu).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  } finally { release(); }
});

for (const cancel of ['Escape', 'navigation']) test(`pending Permissions stays cancelled after startup ${cancel}`, async ({ page }) => {
  const release = await holdChoiceModule(page);
  try {
    await loadHeld(page, '/?teams', { startupHolds: ['get_messages'] });
    const mode = page.locator('#mode-picker-trigger');
    await mode.click();
    await expect(mode).toHaveAttribute('aria-busy', 'true');
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else await page.locator('.task-item[data-id="session-2"]').click();
    await releaseCall(page, 'get_messages');
    await expect(page.locator('#prompt')).toBeEnabled();
    release();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('dialog', { name: 'Permissions', exact: true })).toHaveCount(0);
  } finally { release(); }
});

test('a catalog label refresh during one Model press keeps native activation', async ({ page }) => {
  await loadHeld(page, '/?teams', { startupHolds: ['get_messages', 'list_provider_models'] });
  await releaseCall(page, 'get_messages');
  await expect(page.locator('#prompt')).toBeEnabled();
  const label = trigger(page).locator('[data-model-label]');
  await expect(label).toHaveText('Claude Sonnet');
  const box = (await trigger(page).boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await releaseCall(page, 'list_provider_models');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
  await page.mouse.up();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
  await expect(search(page)).toBeFocused();
  await expect(label).toHaveText('Claude Sonnet 5');
});

for (const control of ['Model', 'Permissions']) test(`startup refresh during one ${control} press still activates the picker`, async ({ page }) => {
  await loadHeld(page, '/?teams', { startupHolds: ['get_messages'] });
  const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await releaseCall(page, 'get_messages');
  // Let the native startup completion paint before releasing this one press.
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await page.mouse.up();
  // The page's first open of either menu loads its module cold.
  await expect(page.getByRole('dialog', { name: control === 'Model' ? 'Harness and model' : 'Permissions', exact: true })).toBeVisible({ timeout: FIRST_OPEN_MS });
  if (control === 'Model') await expect(search(page)).toBeFocused();
  await expect(page.locator('#prompt')).toBeEnabled();
});

for (const control of ['Model', 'Permissions']) test(`releasing a startup ${control} press outside cancels and flushes the refresh`, async ({ page }) => {
  await loadHeld(page, '/?teams', { startupHolds: ['get_messages'] });
  const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
  const box = (await button.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  await releaseCall(page, 'get_messages');
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  const outside = (await page.locator('.workspace-header').boundingBox())!;
  await page.mouse.move(outside.x + 300, outside.y + 10);
  await page.mouse.up();
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.getByRole('dialog', { name: control === 'Model' ? 'Harness and model' : 'Permissions', exact: true })).toHaveCount(0);
});

for (const control of ['Model', 'Permissions']) for (const change of ['target', 'running', 'navigation']) {
  test(`startup ${change} change cancels a pressed ${control} trigger`, async ({ page }) => {
    await loadHeld(page, '/?teams', { startupHolds: ['get_messages', 'get_task'] });
    const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
    const box = (await button.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    if (change === 'navigation') await page.evaluate(() => document.querySelector<HTMLElement>('.task-item[data-id="session-2"]')!.click());
    else await page.evaluate(async running => {
      const { invoke } = await import((window as any).__pandacodePreviewUrl);
      await invoke('update_session', { sessionId: 'session-1', ...(running ? { status: 'running' } : { model: 'changed-during-press' }) });
    }, change === 'running');
    await releaseCall(page, 'get_task');
    await releaseCall(page, 'get_messages');
    await expect(page.locator('#prompt')).toBeEnabled();
    await page.mouse.up();
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(page.getByRole('dialog', { name: control === 'Model' ? 'Harness and model' : 'Permissions', exact: true })).toHaveCount(0);
  });
}

for (const pending of [true, false]) test(`startup message refresh preserves the ${pending ? 'pending' : 'open'} picker after one click`, async ({ page }) => {
  await loadHeld(page, '/?teams', { startupHolds: pending ? ['get_messages', 'architect_profiles'] : ['get_messages'] });
  const originalTrigger = await trigger(page).elementHandle();
  await trigger(page).click();
  if (pending) await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  else { await expect(picker(page)).toBeVisible(); await search(page).fill('sonne'); }
  await page.locator('#prompt').evaluate(node => { (node as HTMLTextAreaElement).value = 'draft during startup'; });
  await releaseCall(page, 'get_messages');
  await expect(page.locator('#prompt')).toBeEnabled();
  if (pending) await releaseCall(page, 'architect_profiles');
  await expect(picker(page)).toBeVisible();
  expect(await originalTrigger!.evaluate(node => node === document.querySelector('#model-picker-trigger'))).toBe(true);
  await expect(search(page)).toBeFocused();
  await expect(search(page)).toHaveValue(pending ? '' : 'sonne');
  await expect(page.locator('#prompt')).toHaveValue('draft during startup');
  if (!pending) await page.keyboard.press('Escape'); // Clear the query first.
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
});

for (const pending of [true, false]) for (const cancel of ['Escape', 'outside click', 'navigation', 'new task', 'target change', 'running task']) {
  test(`startup refresh keeps ${pending ? 'a pending' : 'an open'} picker cancelled after ${cancel}`, async ({ page }) => {
    await loadHeld(page, '/?teams', { startupHolds: ['get_messages', 'get_task', ...(pending ? ['architect_profiles'] : [])] });
    await trigger(page).click();
    if (pending) await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
    else await expect(picker(page)).toBeVisible();
    if (cancel === 'Escape') await page.keyboard.press('Escape');
    else if (cancel === 'outside click') await page.locator('.workspace-header').click({ position: { x: 300, y: 10 } });
    else if (cancel === 'navigation') await page.locator('.task-item[data-id="session-2"]').click();
    else if (cancel === 'new task') await page.locator('.new-task-button').click();
    else await page.evaluate(async running => {
      const { invoke } = await import((window as any).__pandacodePreviewUrl);
      await invoke('update_session', { sessionId: 'session-1', ...(running ? { status: 'running' } : { model: 'changed-during-startup' }) });
    }, cancel === 'running task');
    await releaseCall(page, 'get_task');
    await releaseCall(page, 'get_messages');
    if (cancel === 'navigation') await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
    else if (cancel === 'new task') await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
    else await expect(page.locator('#prompt')).toBeEnabled();
    if (pending) await releaseCall(page, 'architect_profiles');
    // Drain the same open's held work, then a browser frame: an invalid request must never mount later.
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(picker(page)).toHaveCount(0);
  });
}

test('the picker opens without waiting for the team library once it is known', async ({ page }) => {
  await loadHeld(page);
  await openSettled(page);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await holdCall(page, 'architect_profiles');
  await openSettled(page);
  await releaseCall(page, 'architect_profiles');
});

test('a picked model shows on the trigger before configure_session answers', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('GPT-6-Astra');
  await releaseCall(page, 'configure_session');
  await expect.poll(async () => (await task(page)).model).toBe('gpt-6-astra');
  await expect(trigger(page)).toContainText('GPT-6-Astra');
});

test('a refused switch puts the previous model back and says why', async ({ page }) => {
  await loadHeld(page);
  // Until Claude Code's catalog lands at startup, the trigger names the model by the harness's alias ("Claude Sonnet");
  // then by the catalog's name, which is what a refusal puts back. Capture the label once it is catalog-resolved.
  const listed = await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const id = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId;
    const current = await invoke('get_task', { sessionId: id });
    const catalog: { id: string; name: string }[] = await invoke('list_provider_models', { provider: current.provider });
    return catalog.find(model => model.id === (current.model || 'default'))?.name;
  });
  expect(listed, 'the task model is in its catalog').toBeTruthy();
  await expect(trigger(page).locator('[data-model-label]')).toHaveText(listed!);
  const before = await trigger(page).locator('[data-model-label]').textContent();
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toContainText('GPT-6-Astra');
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.getByText('Preview refused the switch', { exact: false })).toBeVisible();
  await expect(trigger(page).locator('[data-model-label]')).toHaveText(before!);
});

test('a send during a switch waits for it and goes with the new model', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toContainText('GPT-6-Astra');
  await page.locator('#prompt').fill('hello after the switch');
  await page.locator('#prompt').press('Enter');
  // The held message shows on the send button.
  const sendButton = page.locator('#composer .send-button[type="submit"]');
  await expect(sendButton).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__calls.includes('send_message'))).toBe(false);
  await releaseCall(page, 'configure_session');
  await expect.poll(() => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'configure_session' || c === 'send_message'))).toEqual(['configure_session', 'send_message']);
  await expect(page.locator('#composer .send-button[aria-busy="true"]')).toHaveCount(0);
  await expect.poll(() => task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
});

test('a failed switch keeps the draft and sends nothing', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#prompt').fill('keep this draft');
  await page.locator('#prompt').press('Enter');
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.getByText('Preview refused the switch', { exact: false })).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('keep this draft');
  await page.waitForTimeout(300);
  expect(await sent(page)).toBe(0);
});

test('opening another task during a held switch does not send the draft there, says so and keeps it', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#prompt').fill('meant for the first task');
  await page.locator('#prompt').press('Enter');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await releaseCall(page, 'configure_session');
  await expect.poll(async () => (await page.evaluate(async () => { const { invoke } = await import((window as any).__pandacodePreviewUrl); return invoke('get_task', { sessionId: 'session-1' }); }) as any).model).toBe('gpt-6-astra');
  await expect(page.locator('#toast')).toContainText('Not sent — you switched tasks. Your draft is still there.');
  await page.waitForTimeout(300);
  expect(await sent(page)).toBe(0);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(page.locator('#prompt')).toHaveValue('meant for the first task');
});

/** The task as stored, read from a listing (get_task may be held). */
const listed = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  return (await invoke('list_sessions')).find((item: { id: string }) => item.id === 'session-1');
});
/** Starts a task listing (sessions-changed, as any worker change sends) and keeps it from landing: its list is read now,
 *  before what comes next is saved, and lands on `releaseCall(page, 'get_task')`. */
async function staleListing(page: Page): Promise<void> {
  await holdCall(page, 'get_task');
  await page.evaluate(() => (window as any).__previewEmit('sessions-changed', {}));
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__atGate?.get_task)), { message: 'a listing waiting to land' }).toBe(true);
}
// A listing read before a pick saved landed after it and put the old model back, the trigger flickering between them.
for (const [label, query, option, model] of [
  ['within a harness', 'opus', 'Claude Code · Claude Opus 5', 'Claude Opus 5'],
  ['to another harness', 'astra', 'Codex · GPT-6-Astra', 'GPT-6-Astra'],
] as const) {
  test(`a listing read before a pick ${label} saved does not put the old model back`, async ({ page }) => {
    await loadHeld(page);
    await staleListing(page);
    await openSettled(page);
    await search(page).fill(query);
    await picker(page).getByRole('option', { name: option, exact: true }).click();
    await expect.poll(async () => (await listed(page)).model).not.toBe('sonnet');
    await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
    await releaseCall(page, 'get_task');
    await page.waitForTimeout(300);
    await expect(trigger(page).locator('[data-model-label]')).toHaveText(model);
    // A listing read after the save is believed again.
    await page.evaluate(() => (window as any).__previewEmit('sessions-changed', {}));
    await page.waitForTimeout(300);
    await expect(trigger(page).locator('[data-model-label]')).toHaveText(model);
    await openSettled(page);
    await expect(picker(page).locator('[aria-current="true"]')).toHaveAccessibleName(option);
  });
}

// Every native task read that replaces the task in state keeps a pick made meanwhile (main.ts taskCall), not only listings.
test('a board edit whose task read began before a pick saved does not put the old model back', async ({ page }) => {
  await loadHeld(page);
  const stale = await task(page);
  await page.getByRole('button', { name: /^Workspace view: / }).click();
  await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('region', { name: 'Project board', exact: true }).getByRole('button', { name: `Open task: ${stale.title}`, exact: true }).click();
  const edit = page.getByRole('region', { name: 'Task details', exact: true }).getByRole('button', { name: 'Edit task details', exact: true });
  await expect(edit).toBeEnabled();
  // The details read starts now and answers with the task as it was then, whatever saves before it lands.
  await holdCall(page, 'get_task');
  await page.evaluate(before => { (window as any).__override = { get_task: (args: { sessionId: string }) => args.sessionId === before.id ? before : undefined }; }, stale);
  await edit.click();
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__atGate?.get_task)), { message: 'the board edit reading the task' }).toBe(true);
  await pickAstra(page);
  await expect.poll(async () => (await listed(page)).model).toBe('gpt-6-astra');
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'get_task');
  const form = page.locator('#dialog');
  await expect(form.getByRole('textbox', { name: 'Task title', exact: true })).toHaveValue(stale.title);
  await page.evaluate(() => { (window as any).__override = {}; });
  await form.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(form).toBeHidden();
  // The picker opens on the task as held: the model picked, not the one the read saw.
  await openSettled(page);
  await expect(picker(page).locator('[aria-current="true"]')).toHaveAccessibleName('Codex · GPT-6-Astra');
  await page.keyboard.press('Escape');
  await expect(trigger(page).locator('[data-model-label]')).toHaveText('GPT-6-Astra');
});

test('a listing landing while a pick saves keeps the picked model on the busy trigger', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  // Read before the configure stored anything: it still lists the old model.
  await staleListing(page);
  await releaseCall(page, 'get_task');
  await page.waitForTimeout(300);
  await expect(trigger(page).locator('[data-model-label]')).toHaveText('GPT-6-Astra');
  await releaseCall(page, 'configure_session');
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(trigger(page).locator('[data-model-label]')).toHaveText('GPT-6-Astra');
  expect((await listed(page)).model).toBe('gpt-6-astra');
});

test('a listing read before an effort change saved does not put the old effort back', async ({ page }) => {
  await loadHeld(page);
  await staleListing(page);
  await openSettled(page);
  await picker(page).getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'High', exact: true }).click();
  await expect.poll(async () => (await listed(page)).reasoningEffort).toBe('high');
  await page.keyboard.press('Escape');
  await releaseCall(page, 'get_task');
  await page.waitForTimeout(300);
  await expect(trigger(page).locator('.model-effort')).toHaveText('High');
});

test('a refused effort change puts the previous effort back', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'set_reasoning_effort');
  await openSettled(page);
  await picker(page).getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'High', exact: true }).click();
  await expect(trigger(page).locator('.model-effort')).toHaveText('High');
  await releaseCall(page, 'set_reasoning_effort', 'Preview refused the effort.');
  await expect(picker(page)).toContainText('Preview refused the effort');
  await expect(trigger(page).locator('.model-effort')).toBeHidden();
  expect((await task(page)).reasoningEffort ?? null).toBeNull();
});

test('the model button pressed during a held save opens the picker once it lands', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  await trigger(page).click();
  await page.waitForTimeout(200);
  await expect(picker(page)).toHaveCount(0);
  const reads = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'get_messages').length);
  const before = await reads();
  await releaseCall(page, 'configure_session');
  await expect(picker(page)).toBeVisible();
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  // The harness change's transcript reload lands meanwhile and must not close the picker.
  await expect.poll(reads).toBeGreaterThan(before);
  await page.waitForTimeout(500);
  await expect(picker(page)).toBeVisible();
});

// A listing (any worker change sends sessions-changed) or the pick's own saved task landing during the save once
// changed the held open's snapshot, and the picker silently never opened.
for (const [label, query, option] of [
  ['within a harness', 'opus', 'Claude Code · Claude Opus 5'],
  ['to another harness', 'astra', 'Codex · GPT-6-Astra'],
] as const) {
  test(`the model button held during a pick ${label} still opens after a listing lands`, async ({ page }) => {
    await loadHeld(page);
    await holdCall(page, 'configure_session');
    await openSettled(page);
    await search(page).fill(query);
    await picker(page).getByRole('option', { name: option, exact: true }).click();
    await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
    await trigger(page).click();
    await page.evaluate(() => (window as any).__previewEmit('sessions-changed', {}));
    await page.waitForTimeout(300);
    await expect(picker(page)).toHaveCount(0);
    await releaseCall(page, 'configure_session');
    await expect(picker(page)).toBeVisible();
    await expect(picker(page).locator('[aria-current="true"]')).toHaveAccessibleName(option);
    await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  });
}

// renderComposer rebuilds the trigger. motion.ts aligns each pulse to the shared phase on its first animationstart, a
// frame late, so every repaint mid-save showed the pulse back at full opacity for a frame: the trigger blinked.
test('the busy pulse runs on through composer repaints', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  const node = await trigger(page).elementHandle();
  // Repaint and read in one task, before the new pulse has drawn a frame.
  const starts = await page.evaluate(() => {
    window.dispatchEvent(new Event('pandacode:team-mode'));
    const detail = document.querySelector('#model-picker-trigger > .model-detail')!;
    return detail.getAnimations().filter(item => (item as CSSAnimation).animationName === 'state-pulse').map(item => item.startTime);
  });
  expect(await node!.evaluate(item => item.isConnected), 'the composer was rebuilt').toBe(false);
  // Already on the shared phase (the document timeline's zero), not pending a first frame from the cycle's start.
  expect(starts).toEqual([0]);
  await releaseCall(page, 'configure_session');
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
});

// refreshModelLabels redraws the Permissions face in place when the shown mode changes; its busy pulse must keep phase.
test('the Permissions busy pulse runs on through a label refresh', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await loadHeld(page, '/');
  const mode = page.locator('#mode-picker-trigger');
  await holdCall(page, 'update_session');
  await mode.click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { checked: false }).first().click();
  await expect(mode).toHaveAttribute('aria-busy', 'true');
  // Read the redrawn face's pulses as soon as it is replaced, before it has drawn a frame.
  const starts = await page.evaluate(() => new Promise<(number | null)[] | 'not redrawn'>(resolve => {
    const button = document.querySelector<HTMLElement>('#mode-picker-trigger')!;
    const observer = new MutationObserver(() => {
      observer.disconnect();
      resolve([...button.children].flatMap(child => child.getAnimations()
        .filter(item => (item as CSSAnimation).animationName === 'state-pulse').map(item => item.startTime as number | null)));
    });
    observer.observe(button, { childList: true });
    setTimeout(() => { observer.disconnect(); resolve('not redrawn'); }, 3000);
    button.dataset.mode = 'stale';
    (window as any).__previewEmit('sessions-changed', {});
  }));
  expect(Array.isArray(starts) && starts.length > 0, `a redrawn face with pulses (${JSON.stringify(starts)})`).toBe(true);
  expect(new Set(starts as (number | null)[])).toEqual(new Set([0]));
  await releaseCall(page, 'update_session');
  await expect(mode).not.toHaveAttribute('aria-busy', 'true');
});

test('reduced motion: the busy trigger does not pulse', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  expect(await trigger(page).evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  await releaseCall(page, 'configure_session');
});

// A transcript paint held while the Settings default-model picker is open paints once it closes.
test('closing the default-model picker paints a held transcript', async ({ page }) => {
  await loadHeld(page);
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  await settings.getByRole('button', { name: 'Default model for new tasks', exact: true }).click();
  await expect(picker(page)).toBeVisible();
  await page.evaluate(async () => {
    const path = '/src/model-switch.ts';
    (await import(path)).deferTranscript(() => { (window as any).__heldPainted = true; });
  });
  expect(await page.evaluate(() => Boolean((window as any).__heldPainted)), 'held while the picker is open').toBe(false);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__heldPainted))).toBe(true);
});

test('a send right after a harness switch keeps its message when the transcript reloads', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#prompt').fill('right after the switch');
  await page.locator('#prompt').press('Enter');
  // The reload reads the page before the send is stored; the send's optimistic message must survive it.
  await holdCall(page, 'get_messages');
  await holdCall(page, 'send_message');
  await releaseCall(page, 'configure_session');
  const message = page.locator('#transcript .user-message', { hasText: 'right after the switch' });
  await expect(message).toBeVisible();
  await releaseCall(page, 'get_messages');
  await page.waitForTimeout(300);
  await expect(message).toBeVisible();
  await releaseCall(page, 'send_message');
  await expect(message).toBeVisible();
});

test('a catalog that failed loads again on the next open', async ({ page }) => {
  await loadHeld(page);
  const asked = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'list_provider_models').length);
  await holdCall(page, 'list_provider_models');
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await releaseCall(page, 'list_provider_models', 'Catalog offline.');
  const failure = picker(page).locator('[role="tab"][data-view="h:codex"][data-tip="Catalog offline."]');
  await expect(failure).toBeVisible();
  const before = await asked();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await openSettled(page);
  await expect.poll(asked).toBeGreaterThan(before);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(failure).toHaveCount(0);
  await expect(picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true })).toBeVisible();
});

test('overlapping effort changes: only the latest one paints or rolls back', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'set_reasoning_effort');
  await openSettled(page);
  const group = picker(page).getByRole('radiogroup', { name: 'Effort' });
  const effortLabel = trigger(page).locator('.model-effort');
  await group.getByRole('radio', { name: 'High', exact: true }).click();
  await group.getByRole('radio', { name: 'Low', exact: true }).click();
  await expect(effortLabel).toHaveText('Low');
  // High saves; Low, sent after it, is held again. High's reply must not paint over Low.
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__atGate?.set_reasoning_effort))).toBe(true);
  await page.evaluate(() => { const w = window as any; w.__atGate.set_reasoning_effort = false; w.__release.set_reasoning_effort(); w.__hold('set_reasoning_effort'); });
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('high');
  await page.waitForTimeout(200);
  await expect(effortLabel).toHaveText('Low');
  await expect(group.getByRole('radio', { name: 'Low', exact: true })).toHaveAttribute('aria-checked', 'true');
  // Low is refused: back to the last confirmed effort (High), not the one before both.
  await releaseCall(page, 'set_reasoning_effort', 'Preview refused the effort.');
  await expect(picker(page)).toContainText('Preview refused the effort');
  await expect(effortLabel).toHaveText('High');
  await expect(group.getByRole('radio', { name: 'High', exact: true })).toHaveAttribute('aria-checked', 'true');
  expect((await task(page)).reasoningEffort).toBe('high');
});

/** Chooses High with set_reasoning_effort held, then closes the picker: the effort change is still saving. */
async function holdHighEffort(page: Page): Promise<void> {
  await holdCall(page, 'set_reasoning_effort');
  await openSettled(page);
  await picker(page).getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'High', exact: true }).click();
  await expect(trigger(page).locator('.model-effort')).toHaveText('High');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
}

test('a send during an effort change waits for it, with the held cue on the send button', async ({ page }) => {
  await loadHeld(page);
  await holdHighEffort(page);
  await page.locator('#prompt').fill('after the effort change');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(150);
  const order = () => page.evaluate(() => (window as any).__calls.filter((c: string) => ['set_reasoning_effort', 'send_message', 'architect_start'].includes(c)));
  expect(await order()).toEqual(['set_reasoning_effort']);
  await releaseCall(page, 'set_reasoning_effort');
  await expect.poll(async () => (await order()).length).toBe(2);
  expect((await order())[0]).toBe('set_reasoning_effort');
  await expect(page.locator('#composer .send-button[aria-busy="true"]')).toHaveCount(0);
});

test('a refused effort change keeps held sends and their draft, with one notice', async ({ page }) => {
  await loadHeld(page, '/');
  await holdHighEffort(page);
  await page.evaluate(() => {
    const toast = document.querySelector('#toast')!; (window as any).__notSent = 0;
    new MutationObserver(() => { if (toast.textContent?.startsWith('Not sent')) (window as any).__notSent += 1; }).observe(toast, { childList: true, characterData: true, subtree: true });
  });
  const prompt = page.locator('#prompt');
  await prompt.fill('keep this effort draft');
  await prompt.press('Enter');
  await prompt.press('Enter');
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'set_reasoning_effort', 'Preview refused the effort.');
  await expect(page.locator('#toast')).toHaveText('Not sent — the effort wasn’t changed (Preview refused the effort); still Default. Your draft is still there.');
  await expect(prompt).toHaveValue('keep this effort draft');
  await expect(trigger(page).locator('.model-effort')).toBeHidden();
  await expect(page.locator('#composer .send-button[aria-busy="true"]')).toHaveCount(0);
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__calls.filter((c: string) => ['send_message', 'architect_start'].includes(c)))).toEqual([]);
  expect(await page.evaluate(() => (window as any).__notSent)).toBe(1);
});

for (const failed of [false, true]) test(`a model queued after a refused effort ${failed ? 'reports its own refusal' : 'sends with the newer choice'}`, async ({ page }) => {
  await loadHeld(page, '/');
  await openSettled(page);
  const group = picker(page).getByRole('radiogroup', { name: 'Effort' });
  await group.getByRole('radio', { name: 'Low', exact: true }).click();
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('low');
  await holdCall(page, 'set_reasoning_effort');
  await group.getByRole('radio', { name: 'High', exact: true }).click();
  await holdCall(page, 'configure_session');
  await search(page).fill('astra');
  await page.keyboard.press('Enter');
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toContainText('GPT-6-Astra');
  const prompt = page.locator('#prompt');
  await prompt.fill('after the newer model');
  await prompt.press('Enter');
  const sends = () => page.evaluate(() => (window as any).__calls.filter((c: string) => ['send_message', 'architect_start'].includes(c)).length);
  await releaseCall(page, 'set_reasoning_effort', 'Preview refused the effort.');
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__atGate?.configure_session))).toBe(true);
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  expect(await sends()).toBe(0);
  await expect(page.locator('#toast')).not.toContainText('Preview refused the effort');
  await releaseCall(page, 'configure_session', failed ? 'Preview refused the newer model.' : undefined);
  if (failed) {
    await expect(page.locator('#toast')).toHaveText(/^Not sent — the model wasn’t changed \(Preview refused the newer model\); still on .+\. Your draft is still there\.$/);
    await expect(prompt).toHaveValue('after the newer model');
    await expect(trigger(page).locator('.model-effort')).toHaveText('Low');
    await page.waitForTimeout(200);
    expect(await sends()).toBe(0);
  } else {
    await expect.poll(sends).toBe(1);
    await expect.poll(() => task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra', reasoningEffort: null });
  }
  await expect(page.locator('#composer .send-button[aria-busy="true"]')).toHaveCount(0);
});

test('the model button pressed during an effort change opens the picker once it lands', async ({ page }) => {
  await loadHeld(page);
  await holdHighEffort(page);
  await trigger(page).click();
  await page.waitForTimeout(200);
  await expect(picker(page)).toHaveCount(0);
  await expect(trigger(page)).toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'set_reasoning_effort');
  await expect(picker(page)).toBeVisible();
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
});

for (const failed of [true, false]) test(`reopening during an overlapping catalog refresh keeps cached choices and receives ${failed ? 'the quiet failure' : 'the refreshed list'}`, async ({ page }) => {
  await loadHeld(page, '/?teams', { clock: true });
  const codex = picker(page).getByRole('tab', { name: 'Codex', exact: true });
  const astra = picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true });
  const loading = picker(page).locator('[data-catalog-loading="codex"]');
  const loads = () => page.evaluate(() => (window as any).__callArgs.filter(([name, args]: [string, any]) => name === 'list_provider_models' && args.provider === 'codex').length);
  await openSettled(page);
  await codex.click();
  await expect(astra).toBeEnabled();
  await expect(loading).toBeHidden();
  expect(await loads()).toBe(1);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await page.clock.fastForward('06:00');
  await holdCall(page, 'list_provider_models');
  await openSettled(page);
  await codex.click();
  await expect(astra).toBeEnabled();
  await expect(loading).toBeHidden();
  await expect.poll(loads).toBe(2);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await openSettled(page);
  await codex.click();
  // This open must receive the cached answer before the same held refresh is released.
  await expect(astra).toBeEnabled();
  await expect(codex).toBeEnabled();
  await expect(loading).toBeHidden();
  expect(await loads()).toBe(2);
  await page.mouse.move(2, 2);
  if (!failed) await page.evaluate(() => { (window as any).__override = { list_provider_models: (args: any) => args.provider === 'codex' ? [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-7-nova', name: 'GPT-7-Nova' }] : undefined }; });
  await releaseCall(page, 'list_provider_models', failed ? 'Catalog offline.' : undefined);
  const note = picker(page).locator('.model-menu-stale');
  if (failed) {
    await expect(note).toHaveText("Couldn't refresh");
    await expect(note).toHaveAttribute('data-tip', 'Catalog offline. Showing the saved list.');
  } else {
    await expect(picker(page).getByRole('option', { name: 'Codex · GPT-7-Nova', exact: true })).toBeVisible();
    await expect(note).toHaveCount(0);
  }
  await expect(codex).toBeEnabled();
  await expect(astra).toBeEnabled();
  await expect(page.locator('#toast')).toBeHidden();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await openSettled(page);
  await codex.click();
  await expect(loading).toBeHidden();
  await expect(astra).toBeEnabled();
  if (failed) await expect(note).toHaveText("Couldn't refresh");
  else await expect(picker(page).getByRole('option', { name: 'Codex · GPT-7-Nova', exact: true })).toBeVisible();
  expect(await loads()).toBe(2);
  if (failed) {
    await page.keyboard.press('Escape');
    await expect(picker(page)).toHaveCount(0);
    await page.clock.fastForward('00:31');
    await holdCall(page, 'list_provider_models');
    await openSettled(page);
    await codex.click();
    await expect(astra).toBeEnabled();
    await expect(loading).toBeHidden();
    await expect.poll(loads).toBe(3);
    await releaseCall(page, 'list_provider_models');
    await expect(note).toHaveCount(0);
  }
});

test('a failed refresh behind a saved list keeps the list and says so quietly', async ({ page }) => {
  await loadHeld(page, '/?teams', { clock: true });
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  const astra = picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true });
  await expect(astra).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  // Past the 5-minute expiry the saved list answers at once while a refresh runs; that refresh fails.
  await page.clock.fastForward('06:00');
  await holdCall(page, 'list_provider_models');
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await expect(astra).toBeVisible();
  await releaseCall(page, 'list_provider_models', 'Catalog offline.');
  const note = picker(page).locator('.model-menu-stale');
  await expect(note).toHaveText("Couldn't refresh");
  await expect(note).toHaveAttribute('data-tip', 'Catalog offline. Showing the saved list.');
  await expect(astra).toBeVisible();
  await expect(page.locator('#toast')).toBeHidden();
});

/** Opens a /btw side thread that has answered once, then picks GPT-6-Astra for it with configure_session held. */
async function sideSwitchHeld(page: Page) {
  await page.locator('#prompt').fill('/btw first question');
  await page.locator('#prompt').press('Enter');
  const panel = page.locator('.btw-panel');
  await expect(panel.locator('.message.agent-message[data-message-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
  await holdCall(page, 'configure_session');
  const sideModel = panel.getByRole('button', { name: /^Model: / });
  // As openSettled: retry a lost open, but never click while one is on its way.
  await expect(async () => {
    if (!await picker(page).isVisible() && await sideModel.getAttribute('aria-busy') !== 'true') await sideModel.click();
    await expect(picker(page)).toBeVisible({ timeout: 2000 });
  }).toPass();
  await search(page).fill('astra');
  await page.keyboard.press('Enter');
  await expect(sideModel).toContainText('GPT-6-Astra');
  const box = page.getByRole('textbox', { name: 'Message the side thread', exact: true });
  const sends = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'send_message').length);
  return { panel, box, sends, before: await sends() };
}

test('a side-thread send during its model change waits for it', async ({ page }) => {
  await loadHeld(page, '/');
  const { panel, box, sends, before } = await sideSwitchHeld(page);
  await box.fill('second question');
  await box.press('Enter');
  await expect(panel.locator('.btw-send')).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(150);
  expect(await sends()).toBe(before);
  await releaseCall(page, 'configure_session');
  await expect.poll(sends).toBe(before + 1);
  const order = await page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'configure_session' || c === 'send_message'));
  expect(order.lastIndexOf('configure_session')).toBeLessThan(order.lastIndexOf('send_message'));
});

test('a failed side-thread model change keeps the message and sends nothing', async ({ page }) => {
  await loadHeld(page, '/');
  const { box, sends, before } = await sideSwitchHeld(page);
  await box.fill('second question');
  await box.press('Enter');
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(box).toHaveValue('second question');
  await page.waitForTimeout(200);
  expect(await sends()).toBe(before);
});

test('a refused switch says the model was not changed and which one stays', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.locator('#toast')).toContainText('Model not changed (Preview refused the switch); still on ');
  // The notice names the model the trigger is back on.
  const restored = (await trigger(page).getAttribute('aria-label'))!.replace(/^Model: /, '');
  await expect(page.locator('#toast')).toContainText(`Model not changed (Preview refused the switch); still on ${restored}`);
});

test('a board start during a model change waits for it', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  // The board's Start task goes through the same data-action dispatch; pressed while the model saves, it waits.
  const starts = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'start_task' || c === 'architect_start').length);
  await page.evaluate(() => {
    const start = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Start task' });
    start.dataset.action = 'board-start'; start.dataset.id = 'session-1';
    document.body.append(start); start.click(); start.remove();
  });
  await page.waitForTimeout(200);
  expect(await starts()).toBe(0);
  await releaseCall(page, 'configure_session');
  await expect.poll(starts).toBe(1);
});

test('typing a draft warms the task once; opening or focusing it does not', async ({ page }) => {
  await loadHeld(page, '/');
  const warms = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'warm_task').length);
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await page.locator('#prompt').click();
  await page.waitForTimeout(300);
  expect(await warms()).toBe(0);
  await page.locator('#prompt').pressSequentially('hello');
  await expect.poll(warms).toBe(1);
  await page.waitForTimeout(200);
  expect(await warms()).toBe(1);
  // A cleared draft typed again is a new sign of intent.
  await page.locator('#prompt').fill('');
  await page.locator('#prompt').pressSequentially('x');
  await expect.poll(warms).toBe(2);
});

test('a refused switch out of a named team says the task left the team', async ({ page }) => {
  await loadHeld(page);
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  await picker(page).getByRole('option', { name: 'Agent team · Ship crew', exact: true }).click();
  await expect(trigger(page)).toContainText('Ship crew');
  await holdCall(page, 'configure_session');
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Claude Code', exact: true }).click();
  await picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.locator('#toast')).toContainText('; the task left team Ship crew');
});

test('permissions show at once, save behind, and a refusal puts them back and says so', async ({ page }) => {
  await loadHeld(page, '/');
  const mode = page.locator('#mode-picker-trigger');
  const before = await mode.getAttribute('data-mode');
  await holdCall(page, 'update_session');
  await mode.click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  const choice = menu.getByRole('menuitemradio', { checked: false }).first();
  await choice.click();
  await expect(mode).not.toHaveAttribute('data-mode', before!);
  await expect(mode).toHaveAttribute('aria-busy', 'true');
  // The model button pressed meanwhile opens once the save lands, here refused.
  await trigger(page).click();
  await page.waitForTimeout(150);
  await expect(picker(page)).toHaveCount(0);
  await releaseCall(page, 'update_session', 'Preview refused the permissions.');
  await expect(page.locator('#toast')).toContainText('Permissions not changed (Preview refused the permissions); still ');
  await expect(mode).toHaveAttribute('data-mode', before!);
  await expect(mode).not.toHaveAttribute('aria-busy', 'true');
  await expect(picker(page)).toBeVisible();
});

test('a refreshed list that lands under the pointer waits for it to leave the rows', async ({ page }) => {
  await loadHeld(page, '/?teams', { clock: true });
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  const astra = picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true });
  await expect(astra).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  // Past the 5-minute expiry the saved list answers at once; its refresh brings a new model while the pointer is on a row.
  await page.clock.fastForward('06:00');
  await holdCall(page, 'list_provider_models');
  await openSettled(page);
  await picker(page).getByRole('tab', { name: 'Codex', exact: true }).click();
  await astra.hover();
  await expect(astra).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => { (window as any).__override = { list_provider_models: (args: any) => args.provider === 'codex' ? [{ id: 'gpt-6-astra', name: 'GPT-6-Astra' }, { id: 'gpt-7-nova', name: 'GPT-7-Nova' }] : undefined }; });
  await releaseCall(page, 'list_provider_models');
  const nova = picker(page).getByRole('option', { name: 'Codex · GPT-7-Nova', exact: true });
  await page.waitForTimeout(300);
  await expect(nova).toHaveCount(0);
  await expect(astra).toHaveAttribute('aria-selected', 'true');
  // Leaving the rows applies it, keeping the active row.
  await page.mouse.move(2, 2);
  await expect(nova).toBeVisible();
  await expect(astra).toHaveAttribute('aria-selected', 'true');
});

test('the permissions button pressed during a switch that fails opens its menu once it lands', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await page.waitForTimeout(150);
  await expect(menu).toHaveCount(0);
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(menu).toBeVisible();
});

test('a send held by a refused permissions change is not sent, says why and keeps the draft', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'update_session');
  await page.locator('#mode-picker-trigger').click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { checked: false }).first().click();
  await page.locator('#prompt').fill('after the permissions change');
  await page.locator('#prompt').press('Enter');
  await releaseCall(page, 'update_session', 'Preview refused the permissions.');
  await expect(page.locator('#toast')).toHaveText(/^Not sent — the permissions weren’t changed \(Preview refused the permissions\); still .+\. Your draft is still there\.$/);
  await expect(page.locator('#prompt')).toHaveValue('after the permissions change');
  await page.waitForTimeout(200);
  expect(await sent(page)).toBe(0);
});

test('the permissions button waits busy during a switch and stays closed if another task opened', async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  const mode = page.locator('#mode-picker-trigger');
  await mode.click();
  await expect(mode).toHaveAttribute('aria-busy', 'true');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await releaseCall(page, 'configure_session');
  await page.waitForTimeout(300);
  await expect(page.getByRole('dialog', { name: 'Permissions', exact: true })).toHaveCount(0);
});

test('a failed team library load is not retried on every hover', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__override = { architect_profiles: () => { throw new Error('Profiles unavailable.'); } }; });
  await loadHeld(page);
  const loads = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'architect_profiles').length);
  // The idle preload (about 1.5 s after start) fails once.
  await expect.poll(loads, { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(300);
  const before = await loads();
  for (let i = 0; i < 3; i++) { await trigger(page).hover(); await page.mouse.move(2, 2); }
  await page.waitForTimeout(300);
  expect(await loads()).toBe(before);
});

test('a new task aimed at another computer neither warms nor asks to warm', async ({ page }) => {
  await loadHeld(page, '/');
  // Sign in to Connect, then aim a new task at the Studio iMac (preview sample devices).
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Connections', exact: true }).click();
  await page.getByRole('tab', { name: 'Remote access' }).click();
  const remote = page.getByRole('tabpanel', { name: 'Remote access' });
  await remote.getByRole('button', { name: 'Sign in with GitHub' }).click();
  await expect(remote.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.getByRole('button', { name: /^back/i }).click();
  await page.locator('.new-task-button').click();
  const computer = page.locator('#composer-computer');
  await computer.click();
  await page.getByRole('menuitemradio', { name: 'Studio iMac' }).click();
  await expect(computer).toHaveAccessibleName('Computer: Studio iMac');
  await page.locator('#prompt').pressSequentially('for the other computer');
  // A permissions pick for that task doesn't ask to warm either.
  await page.locator('#mode-picker-trigger').click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { checked: false }).first().click();
  await expect.poll(() => page.evaluate(() => (window as any).__callArgs.filter(([c, a]: [string, any]) => c === 'update_session' && 'mode' in a).length)).toBe(1);
  await page.waitForTimeout(300);
  const log = await page.evaluate(() => (window as any).__callArgs as [string, any][]);
  expect(log.filter(([command]) => command === 'warm_task')).toEqual([]);
  expect(log.filter(([, args]) => args?.warm)).toEqual([]);
});

test('several held presses of Enter show one notice for one refused change', async ({ page }) => {
  await loadHeld(page, '/');
  await page.evaluate(() => {
    const toast = document.querySelector('#toast')!; (window as any).__notSent = 0;
    new MutationObserver(() => { if (toast.textContent?.startsWith('Not sent')) (window as any).__notSent += 1; }).observe(toast, { childList: true, characterData: true, subtree: true });
  });
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#prompt').fill('one notice please');
  await page.locator('#prompt').press('Enter');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.locator('#toast')).toContainText('Not sent — the model wasn’t changed (Preview refused the switch); still on ');
  await page.waitForTimeout(300);
  expect(await page.evaluate(() => (window as any).__notSent)).toBe(1);
  await expect(page.locator('#composer .send-button[aria-busy="true"]')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('one notice please');
});

test('a refused switch holding a send shows one notice that still names the model it stays on', async ({ page }) => {
  await loadHeld(page, '/');
  await page.evaluate(() => {
    const toast = document.querySelector('#toast')!; const w = window as any; w.__toasts = [];
    new MutationObserver(() => { const text = toast.textContent ?? ''; if (text && text !== w.__toasts.at(-1)) w.__toasts.push(text); }).observe(toast, { childList: true, characterData: true, subtree: true });
  });
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await page.locator('#prompt').fill('one combined notice');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  const restored = async () => (await trigger(page).getAttribute('aria-label'))!.replace(/^Model: /, '');
  await expect(trigger(page)).not.toContainText('GPT-6-Astra');
  await expect(page.locator('#toast')).toHaveText(`Not sent — the model wasn’t changed (Preview refused the switch); still on ${await restored()}. Your draft is still there.`);
  await page.waitForTimeout(300);
  const toasts: string[] = await page.evaluate(() => (window as any).__toasts);
  expect(toasts.filter(text => /not changed|wasn’t changed|weren’t changed/.test(text)), 'one notice, not the refusal then the held send').toHaveLength(1);
});

/** Records every distinct text the toast shows, from now on (`window.__toasts`). */
const watchToasts = (page: Page) => page.evaluate(() => {
  const toast = document.querySelector('#toast')!; const w = window as any; w.__toasts = [];
  new MutationObserver(() => { const text = toast.textContent ?? ''; if (text && text !== w.__toasts.at(-1)) w.__toasts.push(text); }).observe(toast, { childList: true, characterData: true, subtree: true });
});
const refusalToasts = async (page: Page): Promise<string[]> =>
  (await page.evaluate(() => (window as any).__toasts as string[])).filter(text => /not changed|wasn’t changed|weren’t changed/.test(text));

test('a board start held by a refused change is not started and says why', async ({ page }) => {
  await loadHeld(page, '/');
  await watchToasts(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  const starts = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'start_task' || c === 'architect_start').length);
  await page.evaluate(() => {
    const start = Object.assign(document.createElement('button'), { type: 'button', textContent: 'Start task' });
    start.dataset.action = 'board-start'; start.dataset.id = 'session-1';
    document.body.append(start); start.click(); start.remove();
  });
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.locator('#toast')).toHaveText(/^Not started — the model wasn’t changed \(Preview refused the switch\); still on .+\.$/);
  await page.waitForTimeout(200);
  expect(await starts()).toBe(0);
  expect(await refusalToasts(page), 'one notice, not the refusal then the held start').toHaveLength(1);
});

test('a team turned on while a refused switch saves is not turned on, and says so once', async ({ page }) => {
  await loadHeld(page, '/');
  await watchToasts(page);
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(picker(page)).toHaveCount(0);
  const teamSaves = await callCount(page, 'architect_configure');
  await page.locator('#team-trigger').click();
  await page.getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click();
  await releaseCall(page, 'configure_session', 'Preview refused the switch.');
  await expect(page.locator('#toast')).toHaveText(/^Team not turned on — the model wasn’t changed \(Preview refused the switch\); still on .+\.$/);
  await page.waitForTimeout(300);
  expect(await callCount(page, 'architect_configure')).toBe(teamSaves);
  await expect(page.locator('#team-trigger')).not.toHaveAttribute('data-on');
  expect(await refusalToasts(page), 'one notice for the refused switch and the team it held back').toHaveLength(1);
});

// The side thread re-reads its rows only for a saved harness change, once; a model change within a harness keeps them.
for (const [label, query, reads] of [['within a harness', 'opus', 0], ['to another harness', 'astra', 1]] as const) {
  test(`a side-thread pick ${label} re-reads its rows ${reads ? 'once, after it saves' : 'never'}`, async ({ page }) => {
    await loadHeld(page, '/');
    await page.locator('#prompt').fill('/btw first question');
    await page.locator('#prompt').press('Enter');
    const panel = page.locator('.btw-panel');
    await expect(panel.locator('.message.agent-message[data-message-id]')).toHaveCount(1);
    await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
    const sideReads = () => page.evaluate(() => (window as any).__callArgs.filter(([name, args]: [string, any]) => name === 'get_messages' && args?.sessionId && args.sessionId !== 'session-1').length);
    const sideModel = panel.locator('.model-picker');
    await sideModel.click();
    await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
    await holdCall(page, 'configure_session');
    const before = await sideReads();
    await search(page).fill(query);
    await page.keyboard.press('Enter');
    await expect(picker(page)).toHaveCount(0);
    await expect(sideModel).toContainText(query === 'opus' ? 'Claude Opus' : 'GPT-6-Astra');
    await expect(page.getByRole('textbox', { name: 'Message the side thread', exact: true })).toBeFocused();
    await page.waitForTimeout(300);
    expect(await sideReads(), 'nothing re-read while it saves').toBe(before);
    await releaseCall(page, 'configure_session');
    await expect(sideModel).not.toHaveAttribute('aria-busy', 'true');
    await page.waitForTimeout(400);
    expect(await sideReads()).toBe(before + reads);
    await expect(panel.locator('.message.agent-message[data-message-id]')).toHaveCount(1);
  });
}

test('the side panel stays live during its model change: a send click is held, then sent', async ({ page }) => {
  await loadHeld(page, '/');
  const { panel, box, sends, before } = await sideSwitchHeld(page);
  const send = panel.locator('.btw-send');
  await expect(send).toBeEnabled();
  await expect(panel.getByRole('button', { name: /^Model: / })).toBeEnabled();
  await box.fill('second question');
  await send.click();
  await expect(send).toHaveAttribute('aria-busy', 'true');
  await page.waitForTimeout(150);
  expect(await sends()).toBe(before);
  await releaseCall(page, 'configure_session');
  await expect.poll(sends).toBe(before + 1);
});

const callCount = (page: Page, command: string) => page.evaluate(name => (window as any).__calls.filter((c: string) => c === name).length, command);
// Picking the model already in use only closes the picker: nothing saves, the trigger never pulses, an automatic team
// keeps its roster, and the effort stays on screen.
for (const auto of [false, true]) test(`re-picking the current model ${auto ? 'in an automatic team ' : ''}just closes the picker`, async ({ page }) => {
  if (auto) await page.addInitScript(() => {
    const worker = { id: 'codex-default', name: 'Codex', provider: 'codex', model: 'default', reasoningEffort: null };
    localStorage.setItem('pandacode.preview.architect-configs', JSON.stringify({ 'session-1': {
      auto: true, council: { target: 9, maxRounds: 3, reviewers: 2 }, workers: [worker], catalog: [worker], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072,
    } }));
  });
  await loadHeld(page);
  if (auto) await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
  await openSettled(page);
  await picker(page).getByRole('radiogroup', { name: 'Effort' }).getByRole('radio', { name: 'High', exact: true }).click();
  const effort = trigger(page).locator('.model-effort');
  await expect(effort).toHaveText('High');
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('high');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  const configures = await callCount(page, 'configure_session'), teamSaves = await callCount(page, 'architect_configure');
  // The thread has loaded (a disabled prompt takes no focus, after a pick or a re-pick).
  await expect(page.locator('#prompt')).toBeEnabled();
  await openSettled(page);
  // Watch for any busy cue from the pick on.
  await trigger(page).evaluate(node => {
    const w = window as any; w.__busySeen = false;
    new MutationObserver(() => { if (document.querySelector('#model-picker-trigger[aria-busy="true"]')) w.__busySeen = true; })
      .observe(node.closest('#composer-area') ?? document.body, { subtree: true, childList: true, attributes: true, attributeFilter: ['aria-busy'] });
  });
  await picker(page).locator('.model-menu-option[aria-current="true"]').click();
  await expect(picker(page)).toHaveCount(0);
  // Like a real pick, focus goes back to the prompt.
  await expect(page.locator('#prompt')).toBeFocused();
  await page.waitForTimeout(300);
  expect(await callCount(page, 'configure_session')).toBe(configures);
  expect(await callCount(page, 'architect_configure')).toBe(teamSaves);
  expect(await page.evaluate(() => (window as any).__busySeen)).toBe(false);
  await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(effort).toHaveText('High');
  expect(await page.evaluate(async () => { const path = '/src/model-switch.ts'; return (await import(path)).saving('session-1'); })).toBe(false);
});

test('re-picking the side thread’s current model returns focus to the panel’s message box', async ({ page }) => {
  await loadHeld(page, '/');
  await page.locator('#prompt').fill('/btw first question');
  await page.locator('#prompt').press('Enter');
  const panel = page.locator('.btw-panel');
  await expect(panel.locator('.message.agent-message[data-message-id]')).toHaveCount(1);
  const configures = await callCount(page, 'configure_session');
  await panel.locator('.model-picker').click();
  await expect(picker(page)).toBeVisible({ timeout: FIRST_OPEN_MS });
  await picker(page).locator('.model-menu-option[aria-current="true"]').click();
  await expect(picker(page)).toHaveCount(0);
  await expect(page.getByRole('textbox', { name: 'Message the side thread', exact: true })).toBeFocused();
  expect(await callCount(page, 'configure_session')).toBe(configures);
});

test('with Start agents ahead off, typing and picking never warm', async ({ page }) => {
  await loadHeld(page, '/');
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'Agents', exact: true }).click();
  const toggle = settings.getByRole('checkbox', { name: 'Start agents ahead', exact: true });
  await expect(toggle).toBeChecked();
  await toggle.click();
  await expect(toggle).not.toBeChecked();
  await expect.poll(() => page.evaluate(() => (window as any).__startAheadSaves)).toEqual([false]);
  await page.keyboard.press('Escape');
  await expect(settings).toHaveCount(0);
  await page.locator('#prompt').pressSequentially('no warming please');
  await pickAstra(page);
  await expect.poll(async () => (await task(page)).model).toBe('gpt-6-astra');
  await page.waitForTimeout(300);
  const log = await page.evaluate(() => (window as any).__callArgs as [string, any][]);
  expect(log.filter(([command]) => command === 'warm_task')).toEqual([]);
  expect(log.filter(([, args]) => args?.warm)).toEqual([]);
});

for (const input of ['pointer', 'keyboard']) test(`named teams wait for queued efforts via ${input} while ordinary rows stay live`, async ({ page }) => {
  await loadHeld(page);
  await holdCall(page, 'set_reasoning_effort');
  await openSettled(page);
  const group = picker(page).getByRole('radiogroup', { name: 'Effort' });
  await group.getByRole('radio', { name: 'High', exact: true }).click();
  await group.getByRole('radio', { name: 'Low', exact: true }).click();
  await expect(group.getByRole('radio', { name: 'Medium', exact: true })).toBeEnabled();
  await expect(picker(page).getByRole('option', { name: 'Claude Code · Claude Opus 5', exact: true })).toBeEnabled();
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  const ship = picker(page).getByRole('option', { name: 'Agent team · Ship crew', exact: true });
  const configured = () => page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'architect_configure').length);
  const before = await configured();
  // A real pointer click on a disabled row must do nothing; Enter must also skip it after a search redraw.
  if (input === 'pointer') { const box = (await ship.boundingBox())!; await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2); }
  else { await search(page).fill('Ship'); await page.keyboard.press('Enter'); }
  await expect(ship).toBeDisabled();
  expect(await configured()).toBe(before);
  await expect.poll(() => page.evaluate(() => Boolean((window as any).__atGate?.set_reasoning_effort))).toBe(true);
  await page.evaluate(() => { const w = window as any; w.__atGate.set_reasoning_effort = false; w.__release.set_reasoning_effort(); w.__hold('set_reasoning_effort'); });
  await expect.poll(async () => (await task(page)).reasoningEffort).toBe('high');
  await expect(ship).toBeDisabled();
  await releaseCall(page, 'set_reasoning_effort', input === 'keyboard' ? 'Low refused.' : undefined);
  await expect(ship).toBeEnabled();
  expect((await task(page)).reasoningEffort).toBe(input === 'keyboard' ? 'high' : 'low');
  const leadEffort = await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.preview.architect-library')!).profiles.find((p: any) => p.name === 'Ship crew').setup.architect.reasoningEffort ?? null);
  if (input === 'pointer') await ship.click();
  else { await search(page).fill(''); await search(page).fill('Ship'); await page.keyboard.press('Enter'); }
  await expect(trigger(page)).toContainText('Ship crew');
  await expect.poll(async () => (await task(page)).reasoningEffort ?? null).toBe(leadEffort);
});

for (const control of ['Model', 'Permissions']) for (const dismiss of ['Escape', 'outside', 'focus', 'blur', 'navigation']) {
  test(`held ${control} opening cancels on ${dismiss} before the save settles`, async ({ page }) => {
    await loadHeld(page);
    await holdCall(page, 'configure_session');
    await pickAstra(page);
    const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
    await button.click();
    await expect(button).toHaveAttribute('aria-busy', 'true');
    // Observe real deferred-paint bookkeeping without releasing configure_session.
    await page.evaluate(async () => {
      const path = '/src/model-switch.ts'; const switching = await import(path);
      (window as any).__heldPaint = false;
      switching.deferTranscript(() => { (window as any).__heldPaint = true; });
    });
    if (control === 'Model') expect(await page.evaluate(() => (window as any).__heldPaint)).toBe(false);
    if (dismiss === 'Escape') await page.keyboard.press('Escape');
    else if (dismiss === 'outside') await page.locator('.workspace-header').click({ position: { x: 300, y: 10 } });
    else if (dismiss === 'focus') await page.locator('#prompt').focus();
    else if (dismiss === 'blur') await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    else await page.locator('.task-item[data-id="session-2"]').click();
    if (control === 'Permissions') await expect(button).not.toHaveAttribute('aria-busy', 'true');
    await expect.poll(() => page.evaluate(() => (window as any).__heldPaint)).toBe(true);
    expect(await page.evaluate(async () => { const path = '/src/model-switch.ts'; return (await import(path)).saving('session-1'); })).toBe(true);
    await releaseCall(page, 'configure_session');
    await expect.poll(() => page.evaluate(async () => { const path = '/src/model-switch.ts'; return (await import(path)).saving('session-1'); })).toBe(false);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Permissions', exact: true })).toHaveCount(0);
  });
}

for (const control of ['Model', 'Permissions']) for (const refused of [false, true]) {
  test(`a replacement held ${control} request survives ${refused ? 'refusal' : 'success'} and IME Escape`, async ({ page }) => {
    await loadHeld(page);
    await holdCall(page, 'configure_session');
    await pickAstra(page);
    const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
    const original = await button.elementHandle();
    await button.click();
    await page.keyboard.press('Escape');
    await button.click();
    await button.evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })));
    await releaseCall(page, 'configure_session', refused ? 'Model refused.' : undefined);
    const menu = control === 'Model' ? picker(page) : page.getByRole('dialog', { name: 'Permissions', exact: true });
    await expect(menu).toBeVisible();
    expect(await original!.evaluate(node => node === document.getElementById(node.id))).toBe(true);
    await expect(button).not.toHaveAttribute('aria-busy', 'true');
    if (control === 'Model') await expect(search(page)).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
  });
}

for (const control of ['Model', 'Permissions']) test(`held ${control} opening survives its automatic team roster refresh`, async ({ page }) => {
  await page.addInitScript(() => {
    const worker = { id: 'codex-default', name: 'Codex', provider: 'codex', model: 'default', reasoningEffort: null };
    localStorage.setItem('pandacode.preview.architect-configs', JSON.stringify({ 'session-1': {
      auto: true, council: { target: 9, maxRounds: 3, reviewers: 2 }, workers: [worker], catalog: [worker], maxParallel: 0, maxRounds: 8, maxAssignments: 24, workspace: 'shared', summaryLimit: 3072,
    } }));
  });
  await loadHeld(page);
  await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  const button = control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger');
  const original = await button.elementHandle();
  await button.click();
  await releaseCall(page, 'configure_session');
  await expect(control === 'Model' ? picker(page) : page.getByRole('dialog', { name: 'Permissions', exact: true })).toBeVisible();
  expect(await original!.evaluate(node => node === document.getElementById(node.id))).toBe(true);
  await expect(page.locator('#team-trigger')).toHaveAttribute('data-on', '');
});

for (const control of ['Model', 'Permissions']) test(`held ${control} opening stays on its side thread after saving`, async ({ page }) => {
  await loadHeld(page, '/');
  await page.locator('#prompt').fill('/btw first question');
  await page.locator('#prompt').press('Enter');
  const panel = page.locator('.btw-panel');
  await expect(panel.locator('.message.agent-message[data-message-id]')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
  const sideModel = panel.locator('.model-picker');
  await sideModel.click();
  await expect(picker(page)).toBeVisible();
  await holdCall(page, 'configure_session');
  await search(page).fill('astra');
  await page.keyboard.press('Enter');
  await expect(sideModel).toContainText('GPT-6-Astra');
  await (control === 'Model' ? sideModel : panel.locator('.mode-picker')).click();
  await releaseCall(page, 'configure_session');
  const menu = control === 'Model' ? picker(page) : page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(menu).toBeVisible();
  await expect(trigger(page)).toContainText('Claude Sonnet');
  await expect(sideModel).toContainText('GPT-6-Astra');
  if (control === 'Model') await expect(picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true })).toHaveAttribute('aria-current', 'true');
});

for (const control of ['Model', 'Permissions']) for (const changed of ['model', 'mode']) {
  test(`held ${control} opening rejects an unrelated ${changed} change`, async ({ page }) => {
    await loadHeld(page);
    await holdHighEffort(page);
    await (control === 'Model' ? trigger(page) : page.locator('#mode-picker-trigger')).click();
    await page.evaluate(async field => {
      const { invoke } = await import((window as any).__pandacodePreviewUrl);
      await invoke('update_session', { sessionId: 'session-1', reasoningEffort: 'high', [field]: field === 'model' ? 'opus' : 'full' });
      (window as any).__previewEmit('sessions-changed', {});
    }, changed);
    if (changed === 'model') await expect(trigger(page)).toContainText('Claude Opus');
    else await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'full');
    await releaseCall(page, 'set_reasoning_effort');
    await expect.poll(() => page.evaluate(async () => { const path = '/src/model-switch.ts'; return (await import(path)).saving('session-1'); })).toBe(false);
    await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    await expect(picker(page)).toHaveCount(0);
    await expect(page.getByRole('dialog', { name: 'Permissions', exact: true })).toHaveCount(0);
  });
}

const speed = (page: Page) => picker(page).getByRole('radiogroup', { name: 'Speed' });

async function pick(page: Page, query: string, name: string): Promise<void> {
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
  await picker(page).getByRole('combobox', { name: 'Search harnesses and models', exact: true }).fill(query);
  await picker(page).getByRole('option', { name, exact: true }).click();
  await expect(picker(page)).toHaveCount(0);
}

test('the Speed row lists a model\'s tiers and saves the choice', async ({ page }) => {
  // Claude Sonnet reports no fast mode.
  await open(page, '/');
  await expect(picker(page).getByRole('radiogroup', { name: 'Effort' })).toBeVisible();
  await expect(speed(page)).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);

  await pick(page, 'astra', 'Codex · GPT-6-Astra');
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(speed(page).getByRole('radio')).toHaveText(['Standard', 'Fast', 'Ultra Fast']);
  await expect(speed(page).getByRole('radio', { name: 'Standard', exact: true })).toHaveAttribute('aria-checked', 'true');
  await speed(page).getByRole('radio', { name: 'Ultra Fast', exact: true }).click();
  await expect(speed(page).getByRole('radio', { name: 'Ultra Fast', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect.poll(async () => (await task(page)).codexSettings?.serviceTier).toBe('ultrafast');
  await expect(trigger(page).locator('.model-effort')).toHaveText('Ultra Fast');
  // Arrow keys stay inside the Speed group and save.
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await task(page)).codexSettings?.serviceTier).toBe('priority');
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);

  // A Codex model without tiers has no Speed row.
  await pick(page, 'sol', 'Codex · GPT-5.6-Sol');
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
  await expect(picker(page).getByRole('radiogroup', { name: 'Effort' })).toBeVisible();
  await expect(speed(page)).toHaveCount(0);
});

test('a team turned on while a model change saves waits for it, then turns on', async ({ page }) => {
  await loadHeld(page, '/');
  await holdCall(page, 'configure_session');
  await pickAstra(page);
  await expect(picker(page)).toHaveCount(0);
  const team = page.locator('#team-trigger');
  await team.click();
  await page.getByRole('menuitemradio', { name: 'Balanced team', exact: true }).click({ timeout: FIRST_OPEN_MS });
  await page.waitForTimeout(150);
  expect(await page.evaluate(() => (window as any).__calls.includes('architect_configure')), 'the team waits for the model').toBe(false);
  await releaseCall(page, 'configure_session');
  await expect.poll(() => team.getAttribute('data-on')).toBe('');
  const order: string[] = await page.evaluate(() => (window as any).__calls.filter((c: string) => c === 'configure_session' || c === 'architect_configure'));
  expect(order.indexOf('configure_session')).toBeLessThan(order.indexOf('architect_configure'));
});

for (const row of ['team', 'speed']) test(`a refused change holding a ${row} row still shows its notice after the picker closes`, async ({ page }) => {
  await loadHeld(page, '/?teams');
  if (row === 'speed') {
    await openSettled(page);
    await search(page).fill('astra');
    await picker(page).getByRole('option', { name: 'Codex · GPT-6-Astra', exact: true }).click();
    await expect(picker(page)).toHaveCount(0);
    await expect(trigger(page)).not.toHaveAttribute('aria-busy', 'true');
  }
  await openSettled(page);
  await watchToasts(page);
  await holdCall(page, 'update_session');
  // A choice saving while this picker is already open (for example from another control).
  await page.evaluate(async () => {
    const path = '/src/model-switch.ts'; const changes = await import(path);
    (window as any).__heldMode = changes.pickMode('session-1', 'full', { warm: false, paint() {}, name: (mode: string) => mode, trigger: () => null });
  });
  if (row === 'team') {
    await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
    await picker(page).getByRole('option', { name: /Ship crew/ }).click();
  } else await speed(page).getByRole('radio', { name: 'Fast', exact: true }).click();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await releaseCall(page, 'update_session', 'Permissions locked.');
  await expect(page.locator('#toast')).toContainText(`${row === 'team' ? 'The agent team wasn’t selected' : 'The speed wasn’t changed'} — the permissions weren’t changed (Permissions locked); still `);
  await expect.poll(async () => (await refusalToasts(page)).length).toBe(1);
});


test('an effort refusal after task A closes reaches one notice while task B picker is open', async ({ page }) => {
  await loadHeld(page, '/');
  await watchToasts(page);
  await holdHighEffort(page);
  await page.locator('.new-task-button').click();
  await openSettled(page);
  await releaseCall(page, 'set_reasoning_effort', 'Task A effort refused.');
  await expect(page.locator('#toast')).toContainText('Effort not changed (Task A effort refused)');
  await expect(picker(page)).toBeVisible();
  await expect(picker(page)).not.toContainText('Task A effort refused');
  await expect.poll(async () => (await refusalToasts(page)).length).toBe(1);
});

test('a picker row refusal and concurrent held send share one notice', async ({ page }) => {
  await loadHeld(page, '/?teams');
  await openSettled(page);
  // Record each write: two notices in one microtask checkpoint can elude a MutationObserver.
  await page.evaluate(() => {
    const w = window as any; w.__toasts = [];
    const replace = Element.prototype.replaceChildren;
    Element.prototype.replaceChildren = function (...nodes) {
      if (this.classList.contains('toast-text')) w.__toasts.push(String(nodes[0]));
      replace.apply(this, nodes);
    };
  });
  await holdCall(page, 'update_session');
  await page.evaluate(async () => {
    const path = '/src/model-switch.ts'; const changes = await import(path);
    (window as any).__heldMode = changes.pickMode('session-1', 'full', { warm: false, paint() {}, name: (mode: string) => mode, trigger: () => null });
  });
  await picker(page).getByRole('tab', { name: 'Teams, 2' }).click();
  await picker(page).getByRole('option', { name: /Ship crew/ }).click();
  await page.keyboard.press('Escape');
  await expect(picker(page)).toHaveCount(0);
  await page.locator('#prompt').fill('keep this draft');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#composer .send-button[type="submit"]')).toHaveAttribute('aria-busy', 'true');
  await releaseCall(page, 'update_session', 'Shared permissions refusal.');
  await expect(page.locator('#toast')).toContainText('Shared permissions refusal');
  await expect(page.locator('#composer .send-button[type="submit"]')).not.toHaveAttribute('aria-busy', 'true');
  expect(await refusalToasts(page)).toHaveLength(1);
  await expect(page.locator('#prompt')).toHaveValue('keep this draft');
});
