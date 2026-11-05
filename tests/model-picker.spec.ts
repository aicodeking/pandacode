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

async function open(page: Page, url = '/?teams'): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: `${await response.text()}\nwindow.__pandacodePreviewUrl = import.meta.url;\n` });
  });
  await page.goto(url);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await trigger(page).click();
  await expect(picker(page)).toBeVisible();
}

// Issue #123: the picker lists only installed harnesses. The preview marks
// Antigravity and Oh My Pi as not installed.
test('the harness picker hides harnesses that are not installed', async ({ page }) => {
  await page.goto('/');
  await page.locator('.new-task-button').click();
  // A composer redraw while the app starts cancels a menu just opened, so try again until one stays.
  await expect(async () => {
    if (!await picker(page).isVisible()) await page.getByRole('button', { name: /^Model: / }).click();
    await expect(picker(page).getByRole('tab', { name: 'Grok Build' })).toBeVisible({ timeout: 1000 });
  }).toPass();
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
  await page.keyboard.press('ArrowUp');
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
  expect(await task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
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
  await page.goto('/');
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
  await page.goto('/');
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
  expect(await task(page)).toMatchObject({ provider: 'codex', model: 'gpt-6-astra' });
  const after = await page.evaluate(async () => { const { invoke } = await import((window as any).__pandacodePreviewUrl); return invoke('get_task', { sessionId: 'session-1' }); }) as any;
  expect([after.provider, after.model]).toEqual([before.provider, before.model]);
});

test('the picker shows provider logos for Cline, Kilo Code and Oh My Pi', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(); const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `if (command === 'list_providers') return structuredClone(providers.map(p => ({ ...p, installed: true })));\nswitch (command) {`) });
  });
  await page.goto('/');
  await page.locator('.new-task-button').click();
  await trigger(page).click();
  const rail = picker(page).getByRole('tablist', { name: 'Harnesses' });
  for (const [name, id] of [['Cline', 'cline'], ['Kilo Code', 'kilo'], ['Oh My Pi', 'omp']]) {
    const tab = rail.getByRole('tab', { name, exact: true });
    await expect(tab.locator(`.provider-logo[data-provider="${id}"]:not(.provider-logo-tile)`)).toHaveCount(1);
    await tab.click();
    await expect(picker(page).locator(`.provider-logo[data-provider="${id}"]:not(.provider-logo-tile)`).first()).toBeVisible();
  }
});
