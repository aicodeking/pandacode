import { expect, test, type Locator, type Page } from '@playwright/test';

// Vite may add an HMR timestamp to the app's module URL. Reuse that exact
// instance so assertions and injected events reach the application's store.
const previewBody = (source: string) => source + '\nwindow.__pandacodePreviewUrl = import.meta.url;\n';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
// Rows mark tasks with a prompt or response in the last 24 hours; folders group them by project.
const activeRows = (page: Page) => page.locator('#navigation .task-item[data-activity="active"]');
const taskRow = (page: Page, id: string, activity?: 'active' | 'inactive') => page.locator(`#navigation .task-item[data-id="${id}"]${activity ? `[data-activity="${activity}"]` : ''}`);
const folderRows = (page: Page, id: string) => page.locator(`#navigation .folder-group:has(.task-item[data-id="${id}"]) .task-item`);
const projectFilter = (page: Page) => page.getByRole('button', { name: 'Filter projects', exact: true });
const chooseProjectFilter = async (page: Page, name: string) => {
  await projectFilter(page).click();
  await page.getByRole('dialog', { name: 'Filter projects', exact: true }).getByRole('menuitemradio', { name, exact: true }).click();
};
const previewProjectNames = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  return (await invoke('list_projects', {})).map((project: { name: string }) => project.name);
});
const appearanceSurfaces = (page: Page) => page.evaluate(() => {
  const channels = (color: string) => color.match(/[\d.]+/g)!.map(Number);
  const alpha = (color: string) => channels(color)[3] ?? 1;
  const styles = ['html', 'body', '#app', '.workspace', '.sidebar', '.main-pane'].map(selector => getComputedStyle(document.querySelector(selector)!));
  const luminance = (color: string) => channels(color).slice(0, 3).map(value => {
    const component = value / 255;
    return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
  }).reduce((sum, component, index) => sum + component * [0.2126, 0.7152, 0.0722][index], 0);
  const background = luminance(styles[5].backgroundColor);
  const foreground = luminance(getComputedStyle(document.querySelector('.message-content')!).color);
  return {
    alphas: styles.map(style => alpha(style.backgroundColor)),
    sidebarBackdrop: styles[4].backdropFilter,
    mainContrast: (Math.max(background, foreground) + 0.05) / (Math.min(background, foreground) + 0.05),
  };
});
const settingsPage = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
/** Opens the full-page Settings from the sidebar, then one of its groups. */
async function openSettings(page: Page, group?: string): Promise<Locator> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = settingsPage(page);
  await expect(settings).toBeVisible();
  if (group) await settings.getByRole('tab', { name: group, exact: true }).click();
  return settings;
}
async function closeSettings(page: Page): Promise<void> {
  await settingsPage(page).getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(settingsPage(page)).toBeHidden();
}
async function disableWallpapers(page: Page): Promise<void> {
  await openSettings(page, 'Appearance');
  await page.getByRole('checkbox', { name: 'Daily wallpapers', exact: true }).uncheck();
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-wallpaper');
  await expect(page.locator('.workspace-wallpaper img')).toHaveCount(0);
  await closeSettings(page);
}
const newTaskHeading = (page: Page) => page.getByRole('heading', { name: /^What should we build in/ });
const taskProjectPicker = (page: Page) => page.getByRole('dialog', { name: 'Choose project', exact: true });
const toolByName = (page: Page, name: string) => page.locator(`details.tool-activity[data-tool-name="${name}"]`)
  .or(page.locator('details.tool-activity:not([data-tool-name])').filter({ has: page.locator('summary').filter({ hasText: name }) }));
const turnForTool = (tool: Locator) => tool.locator('xpath=ancestor::details[contains(concat(" ", normalize-space(@class), " "), " turn-activity ")][1]');
async function expandToolTurn(tool: Locator): Promise<void> {
  const turn = turnForTool(tool);
  await expect(turn).toHaveCount(1);
  if (!await turn.evaluate(element => element.hasAttribute('open'))) await turn.locator(':scope > summary').click();
  const group = tool.locator('xpath=ancestor::details[contains(concat(" ", normalize-space(@class), " "), " tool-group ")][1]');
  if (await group.count() && !await group.evaluate(element => element.hasAttribute('open'))) await group.locator(':scope > summary').click();
}
const savedSelection = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  // The open task may be an unlisted New task draft, so read it directly.
  const id = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? document.querySelector<HTMLElement>('.task-item.selected')?.dataset.id;
  const selected = id ? await invoke('get_task', { sessionId: id }).catch(() => null) : null;
  return { provider: selected?.provider, model: selected?.model };
});
const savedPermission = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  const id = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? document.querySelector<HTMLElement>('.task-item.selected')?.dataset.id;
  return id ? (await invoke('get_task', { sessionId: id }).catch(() => null))?.mode : undefined;
});
/** The open New task draft: its composer is showing and it has no sidebar row until the first prompt. */
const draftTaskId = async (page: Page): Promise<string> => {
  let id = '';
  await expect.poll(async () => (id = await page.evaluate(() => {
    const current = document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? '';
    return current && !document.querySelector(`.task-item[data-id="${CSS.escape(current)}"]`) ? current : '';
  }))).not.toBe('');
  return id;
};
/** The open task's project: the composer names a draft's project; listed tasks show it on their row. */
const openTaskProject = (page: Page) => page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true }).or(page.locator('.task-item.selected .task-project'));
const modelTrigger = (page: Page) => page.getByRole('button', { name: 'Choose harness and model', exact: true });
const modelPicker = (page: Page) => page.getByRole('dialog', { name: 'Harness and model', exact: true });
const reasoningSlider = (page: Page) => modelPicker(page).getByRole('slider', { name: 'Reasoning effort', exact: true });
const reasoningLabel = (page: Page) => modelPicker(page).locator('.effort-label');
const savedEffort = (page: Page, sessionId?: string) => page.evaluate(async sessionId => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  const id = sessionId ?? document.querySelector<HTMLElement>('#prompt')?.dataset.sessionId ?? document.querySelector<HTMLElement>('.task-item.selected')?.dataset.id;
  return id ? (await invoke('get_task', { sessionId: id }).catch(() => null))?.reasoningEffort ?? null : null;
}, sessionId);

async function installReasoningPreview(page: Page): Promise<void> {
  const effort = (id: string, name: string) => ({ id, name, description: `Sample ${name.toLowerCase()} effort.` });
  const catalogs = {
    claude: [
      { id: 'sonnet', name: 'Claude Sonnet 5', description: 'Sample Claude model.', reasoningEfforts: [effort('low', 'Low'), effort('high', 'High')], defaultReasoningEffort: 'low', contextWindow: 200000 },
      { id: 'opus', name: 'Claude Opus 5', description: 'Sample Claude model.', reasoningEfforts: [effort('high', 'High'), effort('max', 'Max')], defaultReasoningEffort: 'high', contextWindow: 1000000 },
    ],
    codex: [{ id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Sample Codex model.', reasoningEfforts: [effort('low', 'Low'), effort('medium', 'Medium'), effort('high', 'High')], defaultReasoningEffort: 'medium', contextWindow: 400000 }],
    kimi: [{ id: 'kimi-code/k3', name: 'K3', description: 'No optional metadata available.' }],
  };
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const catalogMarker = /let git\s*=/;
    const effortMarker = /case ["']set_reasoning_effort["']\s*:/;
    expect(source).toMatch(catalogMarker);
    expect(source).toMatch(effortMarker);
    const body = source
      .replace(catalogMarker, `Object.assign(catalogs, ${JSON.stringify(catalogs)}); let git =`)
      .replace(effortMarker, `$&
        if (window.__pandacodeFailEffort) throw new Error('The harness could not save reasoning effort.');
        if (window.__pandacodeHoldEffort) await new Promise(resolve => { window.__pandacodeReleaseEffort = resolve; });
      `);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
}

async function captureEffortPresentation(page: Page): Promise<void> {
  await expect(modelPicker(page)).toHaveAttribute('data-popover-state', 'open');
  await reasoningSlider(page).focus();
  await page.evaluate(() => {
    const selectors = ['.model-menu', '.model-menu-list', '.model-menu-option[aria-current="true"]', '.model-menu-settings', '.effort-range', '.effort-label', '.effort-particles', '#prompt', '#model-picker-trigger', '#breadcrumb button'];
    const nodes = selectors.map(selector => document.querySelector<HTMLElement>(selector)!);
    const list = document.querySelector<HTMLElement>('.model-menu-list')!;
    list.scrollTop = Math.min(40, list.scrollHeight - list.clientHeight);
    const rect = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height]; };
    (window as any).__effortPresentation = {
      selectors, nodes, rows: [...list.querySelectorAll('.model-menu-option')],
      rects: [rect(nodes[0]), rect(nodes[4])], scrollTop: list.scrollTop,
      opacity: nodes.map(node => getComputedStyle(node).opacity),
      particles: [...document.querySelectorAll('.effort-particles i')],
      animations: [...document.querySelectorAll('.effort-particles i')].map(particle => particle.getAnimations()[0]),
    };
  });
}

async function expectEffortPresentationUnchanged(page: Page): Promise<void> {
  const presentation = await page.evaluate(() => {
    const saved = (window as any).__effortPresentation;
    const nodes = saved.selectors.map((selector: string) => document.querySelector<HTMLElement>(selector)!);
    const rows = [...document.querySelectorAll('.model-menu-list .model-menu-option')];
    const particles = [...document.querySelectorAll('.effort-particles i')];
    const rect = (element: Element) => { const { x, y, width, height } = element.getBoundingClientRect(); return [x, y, width, height]; };
    const shifts = [rect(nodes[0]), rect(nodes[4])].map((values, i) => Math.max(...values.map((value, j) => Math.abs(value - saved.rects[i][j]))));
    return {
      replacedNodes: saved.selectors.filter((_: string, index: number) => nodes[index] !== saved.nodes[index]),
      replacedRows: rows.length !== saved.rows.length || rows.some((node, index) => node !== saved.rows[index]),
      shiftedBounds: shifts.map(shift => shift > 0.5),
      scrolled: Math.abs(nodes[1].scrollTop - saved.scrollTop) > 0.5,
      changedOpacity: saved.selectors.filter((_: string, index: number) => getComputedStyle(nodes[index]).opacity !== saved.opacity[index]),
      sameParticles: particles.length === saved.particles.length && particles.every((node, index) => node === saved.particles[index] && node.getAnimations()[0] === saved.animations[index]),
      reentering: nodes[0].dataset.popoverState !== 'open' || nodes[0].getAnimations().length > 0,
    };
  });
  expect.soft(presentation).toEqual({ replacedNodes: [], replacedRows: false, shiftedBounds: [false, false], scrolled: false, changedOpacity: [], sameParticles: true, reentering: false });
}

test.beforeEach(async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: previewBody(await response.text()) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect(page.locator('.markdown pre code')).toContainText('createSearchIndex');
});

test('identifies sample data and renders the desktop workspace without runtime errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.reload();
  await expect(page).toHaveTitle('PandaCode');
  await expect(page.locator('.brand')).toHaveText('PandaCode');
  await expect(page.getByText('Browser preview · sample data', { exact: true })).toBeVisible();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect(page.locator('#task-heading')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Projects and tasks' })).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await expect(page.locator('.markdown pre code')).toContainText('createSearchIndex');
  await expect(prompt(page)).toBeEnabled();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('.change-row')).toHaveCount(3);
  await page.screenshot({ path: '/private/tmp/pandacode-activity.png' });
  expect(errors).toEqual([]);
});

test('does not offer earlier messages for a complete short conversation with global message IDs', async ({ page }) => {
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#transcript .message-content')).toHaveText('The project is a small native workspace for coding agents.');
  await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Return to latest messages', exact: true })).toHaveCount(0);
});

async function installHistoryFixture(page: Page, total: number, formatted = false): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `async function invoke(command, args) {
      if (!window.__historyFixture) {
        messages['session-4'] = Array.from({ length: ${total} }, (_, index) => ({
          id: 500 + index * 3, sessionId: 'session-4', role: ${formatted} && index % 2 ? 'assistant' : 'user',
          content: 'History message ' + (index + 1) + (${formatted} && index % 2 ? ${JSON.stringify('\n\n**Saved response**\n\n```ts\nconst retained = true;\n```')} : ''), createdAt: now - 259200000 + index
        }));
        id = Math.max(id, 500 + ${total} * 3);
        window.__historyFixture = { calls: [], emit: event => agent(event),
          tools: count => { for (let index = 0; index < count; index++) {
            const tool = { id: 'history-gap-tool-' + index, name: 'Read', status: 'completed', input: 'source-' + index + '.ts', output: 'Read complete' };
            messages['session-4'].push({ id: ++id, sessionId: 'session-4', role: 'tool', content: encodeTool(tool), createdAt: Date.now() });
            agent({ sessionId: 'session-4', kind: 'tool', text: 'Read complete', tool });
          } },
          append: text => messages['session-4'].push({ id: ++id, sessionId: 'session-4', role: 'assistant', content: text, createdAt: Date.now() }) };
      }
      if (command === 'get_messages') {
        window.__historyFixture.calls.push(structuredClone(args));
        if (args.beforeId && window.__historyFixture.hold) await new Promise(resolve => { window.__historyFixture.release = resolve; });
      }
    `);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#transcript .message-content')).toHaveCount(Math.min(total, 100));
  await expect.poll(() => page.locator('#transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
}
const olderRequests = (page: Page) => page.evaluate(() => (window as any).__historyFixture.calls.filter((call: any) => call.beforeId));
const historyOffset = (element: Locator) => element.evaluate(node => node.getBoundingClientRect().top - node.closest('#transcript')!.getBoundingClientRect().top);
const scrollHistoryTop = (page: Page) => page.locator('#transcript').evaluate(element => {
  element.scrollTop = 0;
  element.dispatchEvent(new Event('scroll'));
});

for (const total of [100, 101, 251]) {
  test(`automatically prepends a ${total}-message conversation without history buttons`, async ({ page }) => {
    await installHistoryFixture(page, total);
    const content = page.locator('#transcript .message-content');
    let loaded = Math.min(total, 100);
    expect(await olderRequests(page)).toHaveLength(0);
    do {
      const previous = loaded;
      const first = page.locator('#transcript [data-message-id]').first();
      const anchorId = await first.getAttribute('data-message-id');
      // Capture the first visible message after the user's upward scroll, before IPC resolves.
      await page.evaluate(() => { (window as any).__historyFixture.hold = true; });
      await scrollHistoryTop(page);
      const anchorY = await historyOffset(first);
      if (loaded < total) {
        await expect.poll(async () => (await olderRequests(page)).length).toBe(Math.ceil(previous / 100));
        await page.evaluate(() => { const fixture = (window as any).__historyFixture; fixture.hold = false; fixture.release(); });
        loaded = Math.min(total, loaded + 100);
        await expect(content).toHaveCount(loaded);
        await expect.poll(async () => Math.abs(await historyOffset(page.locator(`#transcript [data-message-id="${anchorId}"]`)) - anchorY)).toBeLessThan(2);
      }
      await expect(content).toHaveText(Array.from({ length: loaded }, (_, index) => `History message ${total - loaded + index + 1}`));
    } while (loaded < total);
    await page.evaluate(() => { (window as any).__historyFixture.hold = false; });
    const requestsAtEnd = (await olderRequests(page)).length;
    await scrollHistoryTop(page);
    await page.locator('#transcript').dispatchEvent('wheel', { deltaY: -200 });
    expect(await olderRequests(page)).toHaveLength(requestsAtEnd);
    expect(requestsAtEnd).toBe(Math.ceil(total / 100) - 1);
    await expect(page.getByRole('button', { name: 'Load earlier messages', exact: true })).toHaveCount(0);
    await expect(page.getByRole('button', { name: 'Return to latest messages', exact: true })).toHaveCount(0);
    await page.locator('#transcript').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(content.last()).toBeInViewport();
    await expect(content.last()).toHaveText(`History message ${total}`);
  });
}

test('retains existing formatted response nodes when earlier history is prepended', async ({ page }) => {
  await installHistoryFixture(page, 251, true);
  const response = page.locator('#transcript [data-message-id="953"] .message-content');
  await expect(response.locator('pre code')).toContainText('const retained = true;');
  const originalResponse = await response.elementHandle();
  await page.evaluate(() => { (window as any).__historyFixture.hold = true; });
  await scrollHistoryTop(page);
  await expect.poll(async () => (await olderRequests(page)).length).toBe(1);
  const readingY = await historyOffset(response);
  await page.evaluate(() => { const fixture = (window as any).__historyFixture; fixture.hold = false; fixture.release(); });
  await expect(page.locator('#transcript .message-content')).toHaveCount(200);
  expect(await originalResponse!.evaluate(node => node === document.querySelector('#transcript [data-message-id="953"] .message-content'))).toBe(true);
  await expect(page.locator('#transcript .message-content pre code')).toHaveCount(100);
  await expect.poll(async () => Math.abs(await historyOffset(response) - readingY)).toBeLessThan(2);
  await expect(response.locator('pre code')).toContainText('const retained = true;');
});

test('deduplicates pending history loads and ignores pages from a previously selected thread', async ({ page }) => {
  await installHistoryFixture(page, 251);
  await page.evaluate(() => { (window as any).__historyFixture.hold = true; });
  await scrollHistoryTop(page);
  await expect.poll(async () => (await olderRequests(page)).length).toBe(1);
  await scrollHistoryTop(page);
  await page.locator('#transcript').dispatchEvent('wheel', { deltaY: -200 });
  await page.locator('#transcript').dispatchEvent('wheel', { deltaY: -200 });
  expect(await olderRequests(page)).toHaveLength(1);
  await chooseProjectFilter(page, 'orbit');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect(page.locator('#transcript .markdown pre code')).toContainText('createSearchIndex');
  await page.evaluate(() => { const fixture = (window as any).__historyFixture; fixture.hold = false; fixture.release(); });
  await expect(page.locator('#transcript')).not.toContainText('History message');
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#transcript .message-content')).toHaveCount(100);
  await scrollHistoryTop(page);
  await expect(page.locator('#transcript .message-content')).toHaveCount(200);
  await expect(page.locator('#transcript .message-content').first()).toHaveText('History message 52');
  await expect(page.locator('#transcript .message-content').last()).toHaveText('History message 251');
  expect(await olderRequests(page)).toHaveLength(2);
});

for (const view of ['conversation', 'board'] as const) {
  test(`keeps ${view} streaming and the reading position while earlier history is loaded`, async ({ page }) => {
    await installHistoryFixture(page, 151);
    if (view === 'board') {
      await page.getByRole('button', { name: 'Board view', exact: true }).click();
      await page.getByRole('button', { name: 'Open task: Explore the project', exact: true }).click();
    }
    await scrollHistoryTop(page);
    await expect(page.locator('#transcript .message-content')).toHaveCount(151);
    await page.evaluate(() => {
      const fixture = (window as any).__historyFixture;
      fixture.emit({ sessionId: 'session-4', kind: 'status', text: 'Starting agent' });
    });
    const anchor = page.locator('#transcript [data-message-id="653"]');
    await expect(anchor).toBeInViewport();
    const readingY = await historyOffset(anchor);
    await page.evaluate(() => (window as any).__historyFixture.emit({ sessionId: 'session-4', kind: 'text', text: 'A live reply' }));
    await expect(page.locator('#stream-region .live-text')).toHaveText('A live reply');
    await expect.poll(async () => Math.abs(await historyOffset(anchor) - readingY)).toBeLessThan(2);
    await page.locator('#transcript').evaluate(element => { element.scrollTop = element.scrollHeight; });
    await expect(page.locator('#stream-region .live-text')).toBeInViewport();
    await page.evaluate(() => (window as any).__historyFixture.emit({ sessionId: 'session-4', kind: 'text', text: ' continues smoothly.' }));
    await expect(page.locator('#stream-region .live-text')).toHaveText('A live reply continues smoothly.');
    await expect.poll(() => page.locator('#transcript').evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThan(2);
    await scrollHistoryTop(page);
    const first = page.locator('#transcript [data-message-id="500"]');
    const firstY = await historyOffset(first);
    await page.evaluate(() => {
      const fixture = (window as any).__historyFixture;
      fixture.append('A live reply continues smoothly.');
      fixture.emit({ sessionId: 'session-4', kind: 'done', text: '' });
    });
    await expect(page.locator('#transcript .message-content')).toHaveCount(152);
    await expect(page.locator('#transcript .agent-message .message-content')).toHaveText('A live reply continues smoothly.');
    await expect.poll(async () => Math.abs(await historyOffset(first) - firstY)).toBeLessThan(2);
    await expect(page.locator('#transcript .history-notice')).toHaveCount(0);
    expect(await olderRequests(page)).toHaveLength(1);
  });
}

test('retains loaded history when a completed tool-heavy turn spans multiple pages', async ({ page }) => {
  await installHistoryFixture(page, 151);
  await scrollHistoryTop(page);
  await expect(page.locator('#transcript .user-message')).toHaveCount(151);
  await page.evaluate(() => {
    const fixture = (window as any).__historyFixture;
    fixture.emit({ sessionId: 'session-4', kind: 'status', text: 'Starting agent' });
    fixture.tools(125);
    fixture.emit({ sessionId: 'session-4', kind: 'text', text: 'Every source file checked.' });
  });
  await expect(page.locator('#stream-region .live-text')).toHaveText('Every source file checked.');
  await page.evaluate(() => {
    const fixture = (window as any).__historyFixture;
    fixture.append('Every source file checked.');
    fixture.emit({ sessionId: 'session-4', kind: 'done', text: '' });
  });
  await expect(page.locator('#transcript .tool-activity')).toHaveCount(125);
  await expect(page.locator('#transcript .user-message .message-content')).toHaveText(Array.from({length: 151}, (_, index) => `History message ${index + 1}`));
  await expect(page.locator('#transcript .agent-message .message-content')).toHaveText('Every source file checked.');
  const keys = await page.locator('#transcript [data-tool-key]').evaluateAll(elements => elements.map(element => element.getAttribute('data-tool-key')));
  expect(new Set(keys).size).toBe(125);
  await expect(page.locator('#stream-region .live-text')).toHaveCount(0);
  expect(await olderRequests(page)).toHaveLength(2);
});

test('defaults to dark mode and remembers explicit light and dark preferences after reload', async ({ page }) => {
  const toggle = page.getByRole('button', { name: 'Dark mode', exact: true });
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBeNull();
  expect((await appearanceSurfaces(page)).mainContrast).toBeGreaterThanOrEqual(4.5);
  await expect(page.locator('.provider-logo[data-provider="codex"]').first()).toHaveCSS('filter', 'invert(1)');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(menu.getByRole('searchbox', { name: 'Search harnesses and models', exact: true })).toBeFocused();
  await page.screenshot({ path: '/private/tmp/pandacode-dark-models.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBe('light');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'false');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('html')).toHaveCSS('color-scheme', 'light');
  await expect(page.locator('.workspace')).toHaveAttribute('data-wallpaper');
  await expect(page.locator('.main-pane')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBe('light');
  await toggle.focus();
  await page.keyboard.press('Space');
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBe('dark');
  await page.reload();
  await expect(toggle).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBe('dark');
});

test('uses dark mode for missing or invalid preferences without writing a preference on startup', async ({ page }) => {
  await page.evaluate(() => localStorage.setItem('pandacode.theme', 'invalid'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', 'true');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBe('invalid');
  await page.evaluate(() => localStorage.removeItem('pandacode.theme'));
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.theme'))).toBeNull();
});

for (const theme of ['light', 'dark']) {
  test(`migrates legacy preferences before initializing the ${theme} theme`, async ({ page }) => {
    const preferences = {
      theme, compact: 'true', view: 'board', project: 'project-2', projectFilter: 'project-2',
      inactiveCollapsed: 'true', provider: 'codex', 'model.codex': 'gpt-6-astra',
    };
    await page.evaluate(preferences => {
      localStorage.clear();
      for (const [key, value] of Object.entries(preferences)) localStorage.setItem(`kingcode.${key}`, value);
      localStorage.setItem('another-app.theme', 'unrelated');
    }, preferences);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.locator('html')).toHaveCSS('color-scheme', theme);
    await expect(page.getByRole('button', { name: 'Board view', exact: true })).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('body')).toHaveClass(/compact/);
    expect(await page.evaluate(keys => Object.fromEntries(keys.map(key => [key, localStorage.getItem(`pandacode.${key}`)])), Object.keys(preferences))).toEqual(preferences);
    expect(await page.evaluate(() => localStorage.getItem('another-app.theme'))).toBe('unrelated');
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
  });

  test(`keeps existing PandaCode preferences and the ${theme} theme during migration`, async ({ page }) => {
    await page.evaluate(theme => {
      localStorage.clear();
      localStorage.setItem('kingcode.theme', theme === 'light' ? 'dark' : 'light');
      localStorage.setItem('kingcode.compact', 'true');
      localStorage.setItem('kingcode.projectFilter', 'project-2');
      localStorage.setItem('kingcode.model.codex', 'legacy-model');
      localStorage.setItem('pandacode.theme', theme);
      localStorage.setItem('pandacode.compact', 'false');
      localStorage.setItem('pandacode.projectFilter', '');
      localStorage.setItem('pandacode.model.codex', 'current-model');
    }, theme);
    await page.reload();
    await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
    await expect(page.getByRole('button', { name: 'Dark mode', exact: true })).toHaveAttribute('aria-pressed', String(theme === 'dark'));
    await expect(page.locator('body')).not.toHaveClass(/compact/);
    expect(await page.evaluate(() => ['compact', 'projectFilter', 'model.codex'].map(key => localStorage.getItem(`pandacode.${key}`)))).toEqual(['false', '', 'current-model']);
  });
}

test('does not restore removed PandaCode preferences from legacy storage on later launches', async ({ page }) => {
  await page.evaluate(() => {
    localStorage.clear();
    localStorage.setItem('kingcode.theme', 'light');
    localStorage.setItem('kingcode.compact', 'true');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await expect(page.locator('body')).toHaveClass(/compact/);
  await page.evaluate(() => {
    localStorage.removeItem('pandacode.theme');
    localStorage.removeItem('pandacode.compact');
  });
  await page.reload();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  await expect(page.locator('body')).not.toHaveClass(/compact/);
  expect(await page.evaluate(() => [localStorage.getItem('pandacode.theme'), localStorage.getItem('pandacode.compact')])).toEqual([null, null]);
});

test('loads full model names, searches names or IDs, and saves the harness invocation ID', async ({ page }) => {
  await prompt(page).fill('Keep the draft while loading model names');
  await page.evaluate(() => { (window as any).__catalogPrompt = document.querySelector('#prompt'); });
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const search = picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true });
  await expect(picker.getByRole('button', { name: 'Claude Code · Claude Sonnet 5', exact: true })).toHaveAttribute('data-model', 'sonnet');
  await expect(trigger).toHaveText('Claude Sonnet 5');
  expect(await page.evaluate(() => (window as any).__catalogPrompt === document.querySelector('#prompt'))).toBe(true);
  await expect(prompt(page)).toHaveValue('Keep the draft while loading model names');
  await search.fill('Claude Opus 5');
  const opus = picker.getByRole('button', { name: 'Claude Code · Claude Opus 5', exact: true });
  await expect(opus).toBeVisible();
  await search.fill('opus');
  await expect(opus).toBeVisible();
  await search.fill('  OPUS  ');
  await expect(opus).toBeVisible();
  await page.screenshot({ path: '/private/tmp/pandacode-model-names.png', animations: 'disabled' });
  await search.press('Enter');
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'claude', model: 'opus' });
  await expect(trigger).toHaveText('Claude Opus 5');
  await expect(prompt(page)).toHaveValue('Keep the draft while loading model names');
});

test('offers only reported reasoning efforts and remembers the selected effort for each task', async ({ page }) => {
  await installReasoningPreview(page);
  await prompt(page).fill('Keep this draft while choosing reasoning effort');
  await modelTrigger(page).click();
  const settings = modelPicker(page).locator('.model-menu-settings');
  await expect(settings).toBeVisible();
  const slider = reasoningSlider(page);
  // The bar, thumb and label follow the theme accent (which can change with the wallpaper) at every level.
  const accent = () => settings.evaluate(element => { const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; element.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
  const expectColor = async (_level: string) => {
    await expect.poll(async () => [await settings.locator('.effort-fill').evaluate(element => getComputedStyle(element).backgroundColor), await slider.evaluate(element => getComputedStyle(element).color), await reasoningLabel(page).evaluate(element => getComputedStyle(element).color)]).toEqual(Array(3).fill(await accent()));
  };
  const lowColor = 'low', highColor = 'high';
  await expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  await expect(slider).toHaveAttribute('min', '0');
  await expect(slider).toHaveAttribute('max', '1');
  await expect(slider).toHaveAttribute('step', '1');
  await expect(slider).toHaveValue('0');
  await expectColor(lowColor);
  await expect(reasoningLabel(page)).toHaveText('Default');
  await expect(modelPicker(page).getByRole('button', { name: 'Reset reasoning effort', exact: true })).toHaveCount(0);
  await expect(settings).not.toContainText('Claude Sonnet');
  // The context window is shown under the composer, not in this menu.
  await expect(settings).not.toContainText(/context/i);
  await expect(modelPicker(page).getByRole('button', { name: 'Claude Code · Claude Opus 5', exact: true })).toContainText(/1M/i);
  await page.screenshot({ path: '/private/tmp/pandacode-reasoning-settings.png', animations: 'disabled' });
  await page.setViewportSize({ width: 860, height: 600 });
  await expect(slider).toBeInViewport();
  const compactBounds = (await modelPicker(page).boundingBox())!;
  expect(compactBounds.x).toBeGreaterThanOrEqual(12);
  expect(compactBounds.y).toBeGreaterThanOrEqual(12);
  expect(compactBounds.x + compactBounds.width).toBeLessThanOrEqual(848);
  expect(compactBounds.y + compactBounds.height).toBeLessThanOrEqual(588);
  await expect(modelPicker(page)).toHaveAttribute('data-popover-state', 'open');
  await page.screenshot({ path: '/private/tmp/pandacode-reasoning-compact.png', animations: 'allow' });
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect(modelPicker(page)).toHaveCSS('max-height', '916px');
  // Resizing also repositions the anchored menu on an animation frame. Wait
  // for stable hit-test geometry before taking coordinates for a real drag.
  await slider.click({ trial: true });
  const sliderBounds = (await slider.boundingBox())!;
  await page.mouse.move(sliderBounds.x + 16, sliderBounds.y + sliderBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(sliderBounds.x + sliderBounds.width - 16, sliderBounds.y + sliderBounds.height / 2, { steps: 8 });
  await expect(slider).toHaveAttribute('aria-valuetext', 'High');
  await expect(reasoningLabel(page)).toHaveText('High');
  await expect(settings).not.toContainText('Claude Sonnet');
  await expectColor(highColor);
  expect(await savedEffort(page)).toBeNull();
  await page.mouse.up();
  await expect.poll(() => savedEffort(page)).toBe('high');
  await expect(modelPicker(page)).toBeVisible();
  await expect(slider).toBeEnabled();
  await expect(modelTrigger(page)).toContainText('High');
  await expect(prompt(page)).toHaveValue('Keep this draft while choosing reasoning effort');
  const reverseBounds = (await slider.boundingBox())!;
  await page.mouse.move(reverseBounds.x + reverseBounds.width - 8, reverseBounds.y + reverseBounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(reverseBounds.x - 40, reverseBounds.y + reverseBounds.height / 2, { steps: 8 });
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
  await expect(reasoningLabel(page)).toHaveText('Low');
  await expectColor(lowColor);
  expect(await savedEffort(page)).toBe('high');
  await page.mouse.up();
  await expect.poll(() => savedEffort(page)).toBe('low');
  await expect(modelPicker(page)).toBeVisible();
  await slider.press('End');
  await expect.poll(() => savedEffort(page)).toBe('high');
  await expectColor(highColor);
  const particles = settings.locator('.effort-particles i');
  await expect(particles).toHaveCount(12);
  const particle = particles.nth(4);
  const position = await particle.evaluate(element => getComputedStyle(element).transform);
  await expect.poll(() => particle.evaluate(element => getComputedStyle(element).transform)).not.toBe(position);
  await page.screenshot({ path: '/private/tmp/pandacode-effort-slider-dark.png', animations: 'allow' });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(particle).toHaveCSS('animation-name', 'none');
  await expect(particle).toHaveCSS('opacity', '0.55');
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.keyboard.press('Escape');
  await expect(page.locator('.effort-particles i')).toHaveCount(0);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await modelTrigger(page).click();
  await expect(slider).toHaveAttribute('aria-valuetext', 'High');
  await expect(modelPicker(page)).toHaveAttribute('data-popover-state', 'open');
  await expectColor(highColor);
  await page.screenshot({ path: '/private/tmp/pandacode-effort-slider-light.png', animations: 'allow' });
  await slider.focus();
  await slider.press('ArrowUp');
  await expect(slider).toBeFocused();
  await expect(modelPicker(page).locator('.model-menu-option:focus')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect.poll(() => savedEffort(page)).toBeNull();
  await expect(modelTrigger(page)).not.toContainText('High');
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(modelTrigger(page)).toContainText('High');
  await modelTrigger(page).click();
  await expect(reasoningLabel(page)).toHaveText('High');
  await slider.press('Home');
  await expect.poll(() => savedEffort(page)).toBe('low');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
  await expect(slider).toHaveValue('0');
  await expectColor(lowColor);
  await expect(reasoningLabel(page)).toHaveText('Low');
  await expect(modelPicker(page)).toBeVisible();
  await expect(modelTrigger(page)).not.toContainText('High');
  await expect(prompt(page)).toHaveValue('Keep this draft while choosing reasoning effort');
});

test('keeps the reasoning bar in the theme accent at every level while dragging, without saving the preview', async ({ page }) => {
  await page.clock.install();
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    const originalMatchMedia = window.matchMedia;
    window.matchMedia = query => {
      const media = originalMatchMedia.call(window, query);
      if (query === '(prefers-reduced-motion: reduce)') (window as any).__colorEffortMedia ??= media;
      return media;
    };
    (window as any).__colorEffortSaves = [];
    (window as any).__closeColorEffortPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models: [{ id: 'sonnet', name: 'Claude Sonnet', description: '', defaultReasoningEffort: 'low', reasoningEfforts: ['Low', 'Medium', 'High', 'Max'].map(name => ({ id: name.toLowerCase(), name, description: '' })) }] }],
      current: { provider: 'claude', model: 'sonnet', reasoningEffort: null }, canSwitchProvider: false,
      onSelect: async () => {}, onEffortSelect: async effort => { (window as any).__colorEffortSaves.push(effort); },
    });
    window.matchMedia = originalMatchMedia;
  });
  const slider = reasoningSlider(page);
  const fill = modelPicker(page).locator('.effort-fill');
  const label = reasoningLabel(page);
  const accent = await fill.evaluate(element => { const probe = document.createElement('span'); probe.style.color = 'var(--accent)'; element.append(probe); const color = getComputedStyle(probe).color; probe.remove(); return color; });
  const expectAccent = async () => {
    await expect(fill).toHaveCSS('background-color', accent);
    await expect(slider).toHaveCSS('color', accent);
    await expect(label).toHaveCSS('color', accent);
  };
  await expect(label).toHaveText('Default');
  await expectAccent();
  const bounds = (await slider.boundingBox())!;
  await page.mouse.move(bounds.x + 9, bounds.y + bounds.height / 2);
  await page.mouse.down();
  for (const [index, name] of ['Medium', 'High', 'Max'].entries()) {
    await page.mouse.move(bounds.x + 9 + (bounds.width - 18) * (index + 1) / 3, bounds.y + bounds.height / 2);
    await expect(slider).toHaveAttribute('aria-valuetext', name);
    await expectAccent();
    expect(await page.evaluate(() => (window as any).__colorEffortSaves)).toEqual([]);
  }
  await page.mouse.up();
  await expect.poll(() => page.evaluate(() => (window as any).__colorEffortSaves)).toEqual(['max']);
  await page.evaluate(() => (window as any).__closeColorEffortPicker());
});

test('keeps the reasoning menu stationary during delayed effort saves', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 450 });
  await installReasoningPreview(page);
  await prompt(page).fill('Keep this draft while adjusting effort');
  await modelTrigger(page).click();
  await expect(modelPicker(page).getByRole('button', { name: 'Claude Code · Claude Sonnet 5', exact: true })).toBeVisible();
  await captureEffortPresentation(page);
  expect(await page.evaluate(() => (window as any).__effortPresentation.scrollTop)).toBeGreaterThan(0);
  for (const [effort, name, key] of [['high', 'High', 'End'], ['low', 'Low', 'Home']]) {
    await page.evaluate(() => {
      (window as any).__pandacodeHoldEffort = true;
      delete (window as any).__pandacodeReleaseEffort;
    });
    await reasoningSlider(page).press(key);
    await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseEffort)).toBe('function');
    await expect(reasoningSlider(page)).toBeDisabled();
    await expect(reasoningLabel(page)).toHaveText(name);
    await expect(modelPicker(page).locator('.model-menu-option:not(:disabled)')).toHaveCount(0);
    await expectEffortPresentationUnchanged(page);
    await page.evaluate(() => { (window as any).__pandacodeHoldEffort = false; (window as any).__pandacodeReleaseEffort(); });
    await expect.poll(() => savedEffort(page)).toBe(effort);
    await expect(reasoningSlider(page)).toBeEnabled();
    await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', name);
    await expect(reasoningLabel(page)).toHaveText(name);
    await expectEffortPresentationUnchanged(page);
  }
  await expect(prompt(page)).toHaveValue('Keep this draft while adjusting effort');
});

test('keeps an identical reasoning catalog refresh from rebuilding or scrolling the menu', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 600 });
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    const models = [{ id: 'sonnet', name: 'Claude Sonnet', description: '', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }] },
      ...Array.from({ length: 20 }, (_, index) => ({ id: `sample-${index}`, name: `Sample model ${index}`, description: '' }))];
    (window as any).__stableEffortCatalog = models;
    (window as any).__closeStableEffortPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models }],
      current: { provider: 'claude', model: 'sonnet', reasoningEffort: null }, canSwitchProvider: false,
      onSelect: async () => {}, onEffortSelect: async () => {},
      loadModels: () => new Promise(resolve => { (window as any).__resolveStableEffortCatalog = resolve; }),
    });
  });
  await captureEffortPresentation(page);
  expect(await page.evaluate(() => (window as any).__effortPresentation.scrollTop)).toBeGreaterThan(0);
  await page.evaluate(() => (window as any).__resolveStableEffortCatalog(structuredClone((window as any).__stableEffortCatalog)));
  await expect(modelPicker(page).getByText('Loading…', { exact: true })).toBeHidden();
  await expectEffortPresentationUnchanged(page);
  await page.evaluate(() => (window as any).__closeStableEffortPicker());
});

test('preserves reasoning effort when changing projects and resets it when changing model or harness', async ({ page }) => {
  await installReasoningPreview(page);
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await modelTrigger(page).click();
  await modelPicker(page).getByRole('button', { name: 'Claude Code · Claude Sonnet 5', exact: true }).click();
  await modelTrigger(page).click();
  await reasoningSlider(page).press('End');
  await expect.poll(() => savedEffort(page)).toBe('high');
  await page.keyboard.press('Escape');
  await prompt(page).fill('Use this repository with the same reasoning preference');
  await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
  await taskProjectPicker(page).getByRole('option', { name: /^pandacode — / }).click();
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect.poll(() => savedEffort(page)).toBe('high');
  await expect(modelTrigger(page)).toContainText('High');
  await modelTrigger(page).click();
  await modelPicker(page).getByRole('button', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect.poll(() => savedEffort(page)).toBeNull();
  await modelTrigger(page).click();
  await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', 'Default');
  await expect(reasoningLabel(page)).toHaveText('Default');
  await expect(reasoningSlider(page)).toHaveAttribute('max', '1');
  await reasoningSlider(page).press('End');
  await expect.poll(() => savedEffort(page)).toBe('max');
  await modelPicker(page).getByRole('button', { name: 'Codex · GPT-6-Astra', exact: true }).click();
  await expect.poll(() => savedEffort(page)).toBeNull();
  await expect(modelTrigger(page)).toContainText('GPT-6-Astra');
  await expect(modelTrigger(page)).not.toContainText('Max');
  await expect(prompt(page)).toHaveValue('Use this repository with the same reasoning preference');
  await modelTrigger(page).click();
  await expect(reasoningSlider(page)).toHaveValue('1');
  await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', 'Default');
  await expect(reasoningLabel(page)).toHaveText('Default');
  await expect(reasoningSlider(page)).toHaveAttribute('max', '2');
  await reasoningSlider(page).press('ArrowRight');
  await expect.poll(() => savedEffort(page)).toBe('high');
  await expect(reasoningSlider(page)).toBeFocused();
  await reasoningSlider(page).press('ArrowLeft');
  await expect.poll(() => savedEffort(page)).toBe('medium');
  await expect(reasoningLabel(page)).toHaveText('Medium');
  await expect(reasoningSlider(page)).toHaveValue('1');
});

test('keeps task selection and drafts intact when a reasoning save finishes after navigation', async ({ page }) => {
  await installReasoningPreview(page);
  await prompt(page).fill('Original task draft');
  await page.evaluate(() => { (window as any).__pandacodeHoldEffort = true; });
  await modelTrigger(page).click();
  await reasoningSlider(page).press('End');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseEffort)).toBe('function');
  await expect(reasoningSlider(page)).toBeDisabled();
  await expect(reasoningLabel(page)).toHaveText('High');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await prompt(page).fill('Second task draft');
  await page.evaluate(() => { (window as any).__pandacodeHoldEffort = false; (window as any).__pandacodeReleaseEffort(); });
  await expect.poll(() => savedEffort(page, 'session-1')).toBe('high');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await expect(prompt(page)).toHaveValue('Second task draft');
  await expect(modelTrigger(page)).not.toContainText('High');
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(prompt(page)).toHaveValue('Original task draft');
  await expect(modelTrigger(page)).toContainText('High');
});

test('preserves composer focus and selection when a reasoning save finishes after returning to its task', async ({ page }) => {
  await installReasoningPreview(page);
  await page.evaluate(() => { (window as any).__pandacodeHoldEffort = true; });
  await modelTrigger(page).click();
  await reasoningSlider(page).press('End');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseEffort)).toBe('function');
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.locator('.task-item[data-id="session-1"]').click();
  await prompt(page).fill('Keep my selection while I edit this draft');
  await prompt(page).evaluate((element: HTMLTextAreaElement) => element.setSelectionRange(8, 17));
  await expect(prompt(page)).toBeFocused();
  await page.evaluate(() => { (window as any).__pandacodeHoldEffort = false; (window as any).__pandacodeReleaseEffort(); });
  await expect(modelTrigger(page)).toContainText('High');
  await expect(prompt(page)).toHaveValue('Keep my selection while I edit this draft');
  await expect(prompt(page)).toBeFocused();
  expect(await prompt(page).evaluate((element: HTMLTextAreaElement) => [element.selectionStart, element.selectionEnd])).toEqual([8, 17]);
});

test('keeps the previous reasoning choice when saving a new effort fails', async ({ page }) => {
  await installReasoningPreview(page);
  await modelTrigger(page).click();
  await reasoningSlider(page).press('End');
  await expect.poll(() => savedEffort(page)).toBe('high');
  await page.evaluate(() => { (window as any).__pandacodeFailEffort = true; });
  await reasoningSlider(page).press('Home');
  await expect(modelPicker(page).getByRole('alert')).toContainText('could not save reasoning effort');
  await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', 'High');
  await expect(reasoningLabel(page)).toHaveText('High');
  await expect(reasoningSlider(page)).toHaveValue('1');
  await expect(reasoningSlider(page)).toBeEnabled();
  await expect.poll(() => savedEffort(page)).toBe('high');
  await expect(modelTrigger(page)).toContainText('High');
  await page.keyboard.press('Escape');
  await modelTrigger(page).click();
  await expect(reasoningSlider(page)).toHaveAttribute('aria-valuetext', 'High');
});

test('hides unsupported reasoning and context metadata without inventing values', async ({ page }) => {
  await installReasoningPreview(page);
  await page.locator('.task-item[data-id="session-3"]').click();
  await modelTrigger(page).click();
  await modelPicker(page).getByRole('button', { name: 'Kimi Code · K3', exact: true }).click();
  await modelTrigger(page).click();
  await expect(reasoningSlider(page)).toHaveCount(0);
  await expect(modelPicker(page).locator('.model-menu-settings')).toBeHidden();
  await expect(page.locator('.context-indicator')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-1"]').click();
  await modelTrigger(page).click();
  await modelPicker(page).getByRole('searchbox').fill('custom-without-metadata');
  await modelPicker(page).getByRole('button', { name: 'Use "custom-without-metadata" with Claude Code', exact: true }).click();
  await modelTrigger(page).click();
  await expect(reasoningSlider(page)).toHaveCount(0);
  await expect(modelPicker(page).locator('.model-menu-settings')).toBeHidden();
  await expect(page.locator('.context-indicator')).toBeHidden();
  await page.keyboard.press('Escape');
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    (window as any).__unsupportedEffortSaves = [];
    (window as any).__closeUnsupportedEffortPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models: [] }],
      current: { provider: 'claude', model: 'retired-model', reasoningEffort: 'retired-effort' }, canSwitchProvider: false,
      onSelect: async () => {},
      onEffortSelect: async effort => { (window as any).__unsupportedEffortSaves.push(effort); },
    });
  });
  await expect(reasoningSlider(page)).toHaveCount(0);
  await expect(reasoningLabel(page)).toHaveText('retired-effort');
  await expect(modelPicker(page).getByRole('button', { name: 'Reset reasoning effort', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__unsupportedEffortSaves)).toEqual([]);
  await expect(modelPicker(page)).toBeVisible();
  await expect(modelPicker(page).locator('.model-menu-settings')).toBeVisible();
  await page.evaluate(() => (window as any).__closeUnsupportedEffortPicker());
});

test('retries unavailable model metadata and keeps custom model IDs usable', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']list_provider_models["']:/;
    expect(marker.test(source)).toBe(true);
    await route.fulfill({ response, body: previewBody(source.replace(marker, match => `${match} if (!window.__catalogAvailable) throw new Error('Model service unavailable');`)) });
  });
  await page.reload();
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  await trigger.click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.locator('.model-menu-catalog-error')).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Claude Code · Claude Sonnet', exact: true })).toBeVisible();
  await picker.getByRole('searchbox').fill('my-proxy/model_42');
  await picker.getByRole('button', { name: 'Use "my-proxy/model_42" with Claude Code', exact: true }).click();
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'claude', model: 'my-proxy/model_42' });
  await page.evaluate(() => { (window as any).__catalogAvailable = true; });
  await trigger.click();
  await expect(picker.getByRole('button', { name: 'Claude Code · Claude Sonnet 5', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Claude Code · my-proxy/model_42', exact: true })).toHaveAttribute('aria-current', 'true');
  await expect(picker.locator('.model-menu-catalog-error')).toBeHidden();
});

test('keeps keyboard focus in the model picker when refreshed metadata removes the focused model', async ({ page }) => {
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    (window as any).__closeFocusPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models: [{ id: 'legacy', name: 'Legacy model', description: '' }] }],
      current: { provider: 'claude', model: 'default' }, canSwitchProvider: false,
      onSelect: async () => {},
      loadModels: () => new Promise(resolve => { (window as any).__resolveFocusCatalog = resolve; }),
    });
  });
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const legacy = picker.getByRole('button', { name: 'Claude Code · Legacy model', exact: true });
  await legacy.focus();
  await expect(legacy).toBeFocused();
  await page.evaluate(() => (window as any).__resolveFocusCatalog([]));
  await expect(legacy).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'Claude Code · Default', exact: true })).toBeFocused();
  await page.evaluate(() => (window as any).__closeFocusPicker());
});

test('restores search focus when refreshed metadata removes the focused reasoning control', async ({ page }) => {
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    (window as any).__closeEffortFocusPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models: [{ id: 'sonnet', name: 'Claude Sonnet', description: '', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }] }] }],
      current: { provider: 'claude', model: 'sonnet', reasoningEffort: null }, canSwitchProvider: false,
      onSelect: async () => {}, onEffortSelect: async () => {},
      loadModels: () => new Promise(resolve => { (window as any).__resolveEffortFocusCatalog = resolve; }),
    });
  });
  await reasoningSlider(page).focus();
  await expect(reasoningSlider(page)).toBeFocused();
  await page.evaluate(() => (window as any).__resolveEffortFocusCatalog([{ id: 'sonnet', name: 'Claude Sonnet', description: '' }]));
  await expect(reasoningSlider(page)).toHaveCount(0);
  await expect(modelPicker(page).getByRole('searchbox')).toBeFocused();
  await page.evaluate(() => (window as any).__closeEffortFocusPicker());
});

test('commits a Default thumb tap and rejects an effort removed from the catalog during a drag', async ({ page }) => {
  await page.evaluate(async () => {
    const { openModelPicker } = await import('/src/model-picker.ts');
    (window as any).__dragEffortSaves = [];
    (window as any).__closeDragEffortPicker = openModelPicker({
      anchor: document.querySelector<HTMLElement>('#model-picker-trigger')!,
      providers: [{ id: 'claude', name: 'Claude Code', installed: true, path: '/sample/bin/claude', version: 'Sample', models: [{ id: 'sonnet', name: 'Claude Sonnet', description: '', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }, { id: 'high', name: 'High', description: '' }] }] }],
      current: { provider: 'claude', model: 'sonnet', reasoningEffort: null }, canSwitchProvider: false,
      onSelect: async () => {},
      onEffortSelect: async effort => { (window as any).__dragEffortSaves.push(effort); },
      loadModels: () => new Promise(resolve => { (window as any).__resolveDragEffortCatalog = resolve; }),
    });
  });
  const slider = reasoningSlider(page);
  await expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  await expect(reasoningLabel(page)).toHaveText('Default');
  await slider.click({ button: 'right', position: { x: 17, y: 17 } });
  expect(await page.evaluate(() => (window as any).__dragEffortSaves)).toEqual([]);
  await expect(slider).toHaveAttribute('aria-valuetext', 'Default');
  await slider.click({ position: { x: 17, y: 17 } });
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
  await expect(reasoningLabel(page)).toHaveText('Low');
  expect(await page.evaluate(() => (window as any).__dragEffortSaves)).toEqual(['low']);
  const bounds = (await slider.boundingBox())!;
  await page.mouse.move(bounds.x + 17, bounds.y + bounds.height / 2);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width - 17, bounds.y + bounds.height / 2, { steps: 8 });
  await expect(slider).toHaveAttribute('aria-valuetext', 'High');
  await page.evaluate(() => (window as any).__resolveDragEffortCatalog([{ id: 'sonnet', name: 'Updated Claude Sonnet', description: '', defaultReasoningEffort: 'low', reasoningEfforts: [{ id: 'low', name: 'Low', description: '' }] }]));
  await expect(modelPicker(page).getByRole('button', { name: 'Claude Code · Updated Claude Sonnet', exact: true })).toBeVisible();
  await expect(slider).toHaveAttribute('aria-valuetext', 'High');
  await expect(reasoningLabel(page)).toHaveText('High');
  expect(await page.evaluate(() => (window as any).__dragEffortSaves)).toEqual(['low']);
  await page.mouse.up();
  await expect(modelPicker(page).getByRole('alert')).toHaveText('This reasoning effort is no longer available. Choose another level.');
  await expect(slider).toHaveAttribute('max', '0');
  await expect(slider).toHaveAttribute('aria-valuetext', 'Low');
  await expect(reasoningLabel(page)).toHaveText('Low');
  await expect(modelPicker(page)).toBeVisible();
  expect(await page.evaluate(() => (window as any).__dragEffortSaves)).toEqual(['low']);
  await page.evaluate(() => (window as any).__closeDragEffortPicker());
});

for (const outcome of ['resolve', 'reject'] as const) {
  test(`ignores a stale model catalog ${outcome} after refreshing the harness version`, async ({ page }) => {
    await page.addInitScript(() => { (window as any).__catalogRace = { version: 1, requests: [] }; });
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      let source = await response.text();
      const providersMarker = /case ["']list_providers["']:/;
      const modelsMarker = /case ["']list_provider_models["']:/;
      expect(providersMarker.test(source)).toBe(true);
      expect(modelsMarker.test(source)).toBe(true);
      source = source.replace(providersMarker, match => `${match} return providers.map(provider => ({ ...provider, version: provider.id === 'claude' ? String(window.__catalogRace.version) : provider.version, models: provider.models.map(model => ({ ...model })) }));`);
      source = source.replace(modelsMarker, match => `${match} if (args.provider === 'claude') { const request = { provider: args.provider }; window.__catalogRace.requests.push(request); try { return await new Promise((resolve, reject) => Object.assign(request, { resolve, reject })); } finally { request.settled = true; } }`);
      await route.fulfill({ response, body: previewBody(source) });
    });
    await page.reload();
    const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
    const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
    const requestCount = () => page.evaluate(() => (window as any).__catalogRace.requests.length);
    await trigger.click();
    await expect.poll(requestCount).toBe(1);
    await page.keyboard.press('Escape');
    await page.evaluate(() => { (window as any).__catalogRace.version = 2; });
    await openSettings(page, 'Agents');
    await expect(page.getByRole('button', { name: 'Refresh agents', exact: true })).toBeEnabled();
    await closeSettings(page);
    await trigger.click();
    await expect.poll(requestCount).toBe(2);
    if (outcome === 'resolve') {
      await page.evaluate(() => (window as any).__catalogRace.requests[1].resolve([{ id: 'sonnet', name: 'Current harness model', description: '' }]));
      await expect(trigger).toHaveText('Current harness model');
      await page.evaluate(() => (window as any).__catalogRace.requests[0].resolve([{ id: 'sonnet', name: 'Stale harness model', description: '' }]));
    } else {
      await page.evaluate(() => (window as any).__catalogRace.requests[0].reject(new Error('Old harness unavailable')));
    }
    await expect.poll(() => page.evaluate(() => (window as any).__catalogRace.requests[0].settled)).toBe(true);
    await page.keyboard.press('Escape');
    await trigger.click();
    await expect(picker).toBeVisible();
    // A stale rejection must not evict the current in-flight request; a stale
    // success must not overwrite the current catalog retained for reopening.
    expect(await requestCount()).toBe(2);
    if (outcome === 'reject') {
      await page.evaluate(() => (window as any).__catalogRace.requests[1].resolve([{ id: 'sonnet', name: 'Current harness model', description: '' }]));
    }
    await expect(trigger).toHaveText('Current harness model');
    await expect(picker.getByRole('button', { name: 'Claude Code · Current harness model', exact: true })).toBeVisible();
    await expect(picker.getByRole('button', { name: 'Claude Code · Stale harness model', exact: true })).toHaveCount(0);
    await expect(picker.locator('.model-menu-catalog-error')).toBeHidden();
    expect(await requestCount()).toBe(2);
  });
}

test('changes terminal colors without replacing its session or the composer draft', async ({ page }) => {
  await prompt(page).fill('Keep this draft while changing appearance');
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  const viewport = page.locator('#terminal-host .xterm-scrollable-element');
  await expect(viewport).toBeVisible();
  await expect(viewport).toHaveCSS('background-color', 'rgb(25, 26, 24)');
  await page.evaluate(() => { (window as any).__themeNodes = [document.querySelector('#prompt'), document.querySelector('.xterm-screen')]; });
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(viewport).toHaveCSS('background-color', 'rgb(255, 255, 255)');
  await expect(prompt(page)).toHaveValue('Keep this draft while changing appearance');
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect(viewport).toHaveCSS('background-color', 'rgb(25, 26, 24)');
  await expect(prompt(page)).toHaveValue('Keep this draft while changing appearance');
  await page.screenshot({ path: '/private/tmp/pandacode-dark-terminal.png', animations: 'disabled' });
  expect(await page.evaluate(() => {
    const nodes = (window as any).__themeNodes;
    return nodes[0] === document.querySelector('#prompt') && nodes[1] === document.querySelector('.xterm-screen');
  })).toBe(true);
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
});

test('synchronizes dark mode with native appearance without wallpapers and respects reduced transparency', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'Reduced-transparency emulation in this test requires Chromium CDP.');
  await disableWallpapers(page);
  await page.evaluate(async () => {
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    (window as any).__themeCalls = [];
    (window as any).__disposeThemeAppearance = initializeNativeAppearance(async preferences => {
      (window as any).__themeCalls.push(preferences);
      return { platform: 'macos', material: 'liquidGlass' };
    });
  });
  await expect.poll(() => page.evaluate(() => (window as any).__themeCalls.at(-1)?.darkMode)).toBe(true);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__themeCalls.at(-1)?.darkMode)).toBe(false);
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__themeCalls.at(-1)?.darkMode)).toBe(true);
  expect((await appearanceSurfaces(page)).alphas).toEqual([0, 0, 0, 0, 0, 1]);
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'more' },
  ] });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  const surfaces = await appearanceSurfaces(page);
  expect(surfaces.alphas).toEqual([1, 1, 1, 1, 1, 1]);
  expect(surfaces.mainContrast).toBeGreaterThanOrEqual(4.5);
  await projectFilter(page).click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  await expect(menu).toHaveCSS('backdrop-filter', 'none');
  await page.screenshot({ path: '/private/tmp/pandacode-dark-accessible.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  const count = await page.evaluate(() => { (window as any).__disposeThemeAppearance(); return (window as any).__themeCalls.length; });
  await page.getByRole('button', { name: 'Dark mode', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__themeCalls.length)).toBe(count);
  await devtools.detach();
});

test('chooses a project filter from its anchored menu using the keyboard', async ({ page }) => {
  const trigger = projectFilter(page);
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const all = menu.getByRole('menuitemradio', { name: 'All projects', exact: true });
  await expect(menu.getByRole('searchbox', { name: 'Search projects', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(all).toBeFocused();
  await expect(all).toHaveAttribute('aria-checked', 'true');
  await page.screenshot({ path: '/private/tmp/pandacode-filter-menu.png', animations: 'disabled' });
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitemradio', { name: 'pandacode', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(trigger).toHaveText('pandacode');
  await expect(page.locator('#navigation .task-title')).toHaveText(['Explore the project']);
  await trigger.click();
  await expect(menu.getByRole('searchbox', { name: 'Search projects', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'pandacode', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(trigger).toHaveText('All projects');
  await expect(page.locator('#navigation .task-item')).toHaveCount(4);
});

test('all projects: folder headings show the project icon and rows are one line without the project name', async ({ page }) => {
  const folders = page.locator('#navigation .folder-group:not(.single-project)');
  await expect(page.locator('#navigation .folder-heading')).toHaveCount(2);
  await expect(page.locator('#navigation .folder-heading > .task-app-icon')).toHaveCount(2);
  await expect(page.locator('#navigation .folder-heading > svg.icon')).toHaveCount(0);
  await expect(folders.locator('.task-item .task-checkout')).toHaveCount(0);
  await expect(folders.locator('.task-item .task-top .task-title').first()).toBeVisible();
  // Each row is one line, with its harness and linked PR beside the title.
  await expect(folders.locator('.task-item .task-meta')).toHaveCount(0);
  await expect(folders.locator('.task-item .task-top .task-provider').first()).toBeVisible();
  for (const height of await folders.locator('.task-item').evaluateAll(rows => rows.map(row => row.getBoundingClientRect().height))) expect(height).toBeLessThan(36);
  // One project on its own is named by the filter, which shows its icon; the harness leads each title.
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#project-filter > .task-app-icon')).toHaveCount(1);
  await expect(page.locator('#project-filter')).toHaveText('pandacode');
  await expect(page.locator('#navigation .task-item .task-checkout')).toHaveCount(0);
  await expect(page.locator('#navigation .task-item .task-top .task-title')).toHaveText(['Explore the project']);
  await expect(page.locator('#navigation .task-item .task-top .task-provider')).toHaveCount(1);
  await expect(page.locator('#navigation .task-item .task-meta .task-provider')).toHaveCount(0);
  await chooseProjectFilter(page, 'All projects');
  await expect(page.locator('#project-filter > .task-app-icon')).toHaveCount(0);
});

test('says how many tasks the project filter hides and shows them all in one click', async ({ page }) => {
  const note = page.locator('#sidebar-note .filter-note');
  await expect(note).toHaveCount(0);
  await expect(page.locator('#navigation .folder-heading')).toHaveCount(2);
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#navigation .task-title')).toHaveText(['Explore the project']);
  // The filter already names the project: no folder heading, and the note sits under the list.
  await expect(page.locator('#navigation .folder-heading')).toHaveCount(0);
  await expect(note).toHaveText('3 more in other projectsShow all');
  // The note closes the task list; the Bots section and the bottom bar follow it.
  const noteBox = (await note.boundingBox())!, below = (await page.locator('#sidebar-bots').boundingBox())!;
  expect(noteBox.y + noteBox.height).toBeLessThanOrEqual(below.y + 1);
  expect(below.y - (noteBox.y + noteBox.height)).toBeLessThan(24);
  expect(noteBox.height).toBeLessThanOrEqual(36);
  await page.getByRole('button', { name: 'Show all' }).click();
  await expect(projectFilter(page)).toHaveText('All projects');
  await expect(page.locator('#navigation .task-item')).toHaveCount(4);
  await expect(note).toHaveCount(0);
  // Opening a project narrows the sidebar to it; the note is what keeps that legible.
  await page.locator('#navigation .task-item', { hasText: 'Explore the project' }).click();
  await chooseProjectFilter(page, 'orbit');
  await expect(note).toHaveText('1 more in other projectsShow all');
});

test('finds and selects projects beyond the first hundred filter options', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /let sessions\s*=/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `projects.push(...Array.from({ length: 120 }, (_, index) => ({ id: 'fixture-project-' + index, name: 'Fixture project ' + String(index).padStart(3, '0'), path: '/sample/project-' + index }))); let sessions =`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await projectFilter(page).click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const search = menu.getByRole('searchbox', { name: 'Search projects', exact: true });
  await expect(search).toBeFocused();
  expect(await menu.getByRole('menuitemradio').count()).toBeLessThanOrEqual(100);
  await search.fill('Fixture project 119');
  await expect(menu.getByRole('menuitemradio')).toHaveCount(1);
  await expect(menu.getByRole('menuitemradio', { name: 'Fixture project 119', exact: true })).toBeVisible();
  await search.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(projectFilter(page)).toHaveText('Fixture project 119');
  await projectFilter(page).click();
  await expect(search).toHaveValue('');
  const selected = menu.getByRole('menuitemradio', { name: 'Fixture project 119', exact: true });
  await expect(selected).toHaveAttribute('aria-checked', 'true');
  expect(await menu.getByRole('menuitemradio').count()).toBeLessThanOrEqual(100);
  await search.press('ArrowDown');
  await expect(selected).toBeFocused();
  await page.keyboard.press('Escape');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in Fixture project 119?');
  await expect(openTaskProject(page)).toHaveText('Fixture project 119');
});

test('menus open and close instantly and stay usable', async ({ page }) => {
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const search = menu.getByRole('searchbox', { name: 'Search harnesses and models', exact: true });
  await expect(menu).toHaveAttribute('data-popover-state', 'open');
  expect(await menu.evaluate(element => element.getAnimations().length)).toBe(0);
  await expect(search).toBeFocused();
  await page.keyboard.type('animation-ready-model');
  await expect(search).toHaveValue('animation-ready-model');
  await expect(menu.getByRole('button', { name: 'Use "animation-ready-model" with Claude Code', exact: true })).toBeEnabled();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(prompt(page)).toBeFocused();
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'claude', model: 'animation-ready-model' });
});

test('rapidly reopens menus without leaving interactive or retained closing panels', async ({ page }) => {
  const trigger = page.getByRole('button', { name: 'Choose harness and model', exact: true });
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  for (let i = 0; i < 5; i++) {
    await trigger.click();
    await expect(menu).toHaveCount(1);
    await expect(menu.getByRole('searchbox', { name: 'Search harnesses and models', exact: true })).toBeFocused();
    await page.keyboard.press('Escape');
    await expect(menu).toHaveCount(0);
    await expect(trigger).toBeFocused();
    const closing = await page.locator('.floating-menu[data-popover-state="closing"]').evaluateAll(elements => elements.map(element => ({
      inert: (element as HTMLElement).inert,
      hidden: element.getAttribute('aria-hidden'),
      pointerEvents: getComputedStyle(element).pointerEvents,
    })));
    expect(closing.every(panel => panel.inert && panel.hidden === 'true' && panel.pointerEvents === 'none')).toBe(true);
  }
  await expect(page.locator('.floating-menu')).toHaveCount(0);
  await projectFilter(page).click();
  await expect(page.getByRole('dialog', { name: 'Filter projects', exact: true })).toHaveCount(1);
  await trigger.click();
  await expect(page.getByRole('dialog', { name: 'Filter projects', exact: true })).toHaveCount(0);
  await expect(menu).toHaveCount(1);
  await expect(page.locator('.floating-menu:not([aria-hidden="true"])')).toHaveCount(1);
  await page.keyboard.press('Escape');
  await expect(page.locator('.floating-menu')).toHaveCount(0);
});

test('changes permissions and opens task actions with anchored keyboard menus', async ({ page }) => {
  const history = await page.locator('.user-message,.agent-message').allTextContents();
  await prompt(page).fill('Preserve this draft through menu actions');
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  const permissions = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(permissions.getByRole('menuitemradio', { name: 'Standard', exact: true })).toBeFocused();
  await page.screenshot({ path: '/private/tmp/pandacode-permissions-menu.png', animations: 'disabled' });
  await page.keyboard.press('ArrowDown');
  await expect(permissions.getByRole('menuitemradio', { name: 'Accept edits', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(permissions).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Accept edits', exact: true })).toBeVisible();
  await expect(page.locator('#mode-picker-trigger')).toBeFocused();
  await expect(prompt(page)).toHaveValue('Preserve this draft through menu actions');
  await expect(page.locator('.user-message,.agent-message')).toHaveText(history);
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  const actions = page.getByRole('dialog', { name: 'Task actions', exact: true });
  await expect(actions.getByRole('menuitem', { name: 'Rename task', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Home');
  await page.keyboard.press('Enter');
  await expect(actions).toHaveCount(0);
  const rename = page.locator('#dialog');
  await expect(rename.getByRole('textbox', { name: 'Task name', exact: true })).toBeFocused();
  await rename.getByRole('textbox', { name: 'Task name', exact: true }).fill('A task renamed through its menu');
  await rename.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('A task renamed through its menu');
  await expect(prompt(page)).toHaveValue('Preserve this draft through menu actions');
});

test('updates permissions after leaving and reselecting a task while the save is pending', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']update_session["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$& if (args.mode && window.__pandacodeDelayPermissions) await new Promise(resolve => { window.__pandacodeReleasePermissions = resolve; });`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await prompt(page).fill('Preserve this draft while permissions finish saving');
  await page.evaluate(() => { (window as any).__pandacodeDelayPermissions = true; });
  await page.getByRole('button', { name: 'Standard', exact: true }).click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name: 'Accept edits', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleasePermissions)).toBe('function');
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Explore the project');
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect(page.getByRole('button', { name: 'Standard', exact: true })).toBeVisible();
  await page.evaluate(() => {
    (window as any).__pandacodeDelayPermissions = false;
    (window as any).__pandacodeReleasePermissions();
    delete (window as any).__pandacodeReleasePermissions;
  });
  await expect(page.locator('#mode-picker-trigger')).toHaveText('Accept edits');
  await expect(prompt(page)).toHaveValue('Preserve this draft while permissions finish saving');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await page.getByRole('button', { name: 'Accept edits', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name: 'Accept edits', exact: true })).toHaveAttribute('aria-checked', 'true');
});

for (const configuration of [
  { provider: 'Claude Code', sessionId: 'session-1', labels: ['Standard', 'Accept edits', 'Approve for me', 'Plan mode', 'Full access'], selected: 'Plan mode', mode: 'plan' },
  { provider: 'Codex', sessionId: 'session-2', labels: ['Standard', 'Approve for me', 'Read only', 'Full access'], selected: 'Approve for me', mode: 'auto' },
  { provider: 'Kimi Code', sessionId: 'session-3', labels: ['Standard', 'Ask when needed', 'Plan mode', 'Full access'], selected: 'Full access', mode: 'full' },
]) {
  test(`shows supported ${configuration.provider} approval behaviours and remembers the selection for its task`, async ({ page }) => {
    await page.locator(`.task-item[data-id="${configuration.sessionId}"]`).click();
    await prompt(page).fill('Keep this draft with its chosen approval behaviour');
    const trigger = page.locator('#mode-picker-trigger');
    await expect(trigger).toHaveText('Standard');
    await trigger.click();
    const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
    await expect(menu.getByRole('menuitemradio')).toHaveCount(configuration.labels.length);
    for (const label of configuration.labels) {
      await expect(menu.getByRole('menuitemradio', { name: label, exact: true })).toBeVisible();
    }
    await menu.getByRole('menuitemradio', { name: configuration.selected, exact: true }).click();
    await expect(menu).toHaveCount(0);
    await expect(trigger).toHaveText(configuration.selected);
    await expect(trigger).toHaveAttribute('title', /\S+/);
    await expect.poll(() => savedPermission(page)).toBe(configuration.mode);
    await page.locator('.task-item[data-id="session-4"]').click();
    await expect(trigger).toHaveText('Standard');
    await page.locator(`.task-item[data-id="${configuration.sessionId}"]`).click();
    await expect(trigger).toHaveText(configuration.selected);
    await expect(prompt(page)).toHaveValue('Keep this draft with its chosen approval behaviour');
    await trigger.click();
    await expect(menu.getByRole('menuitemradio', { name: configuration.selected, exact: true })).toHaveAttribute('aria-checked', 'true');
    await page.keyboard.press('Escape');
  });
}

test('keeps the saved approval behaviour and draft when saving a different mode fails', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']update_session["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$& if (args.mode) throw new Error('Approval preference could not be saved.');`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await prompt(page).fill('Preserve the draft when permissions cannot be saved');
  const trigger = page.locator('#mode-picker-trigger');
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await menu.getByRole('menuitemradio', { name: 'Full access', exact: true }).click();
  await expect(page.getByText('Approval preference could not be saved.', { exact: true })).toBeVisible();
  await expect(trigger).toHaveText('Standard');
  await expect.poll(() => savedPermission(page)).toBe('ask');
  await expect(prompt(page)).toHaveValue('Preserve the draft when permissions cannot be saved');
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Standard', exact: true })).toHaveAttribute('aria-checked', 'true');
});

test('starts new tasks with Full access and preserves deliberate permissions across harness changes', async ({ page }) => {
  const trigger = page.locator('#mode-picker-trigger');
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(trigger).toHaveText('Standard');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(trigger).toHaveText('Full access');
  await expect.poll(() => savedPermission(page)).toBe('full');
  await prompt(page).fill('Keep this draft while switching harnesses');
  for (const selection of [
    { provider: 'Codex', id: 'codex', mode: 'full', label: 'Full access' },
    { provider: 'Kimi Code', id: 'kimi', mode: 'plan', label: 'Plan mode' },
    { provider: 'Claude Code', id: 'claude', mode: 'ask', label: 'Standard' },
  ]) {
    if (selection.mode !== 'full') {
      await trigger.click();
      await menu.getByRole('menuitemradio', { name: selection.mode === 'plan' ? 'Read only' : 'Standard', exact: true }).click();
    }
    await modelTrigger(page).click();
    await modelPicker(page).getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('approval-preserved-model');
    await modelPicker(page).getByRole('button', { name: `Use "approval-preserved-model" with ${selection.provider}`, exact: true }).click();
    await expect.poll(() => savedSelection(page)).toEqual({ provider: selection.id, model: 'approval-preserved-model' });
    await expect(trigger).toHaveText(selection.label);
    await expect.poll(() => savedPermission(page)).toBe(selection.mode);
    await expect(prompt(page)).toHaveValue('Keep this draft while switching harnesses');
  }
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(trigger).toHaveText('Standard');
});

test('locks the approval behaviour while a task is running and keeps it after stopping', async ({ page }) => {
  await page.clock.install();
  await page.reload();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  const trigger = page.locator('#mode-picker-trigger');
  await trigger.click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name: 'Plan mode', exact: true }).click();
  await expect(trigger).toHaveText('Plan mode');
  await prompt(page).fill('Review the project without changing any files');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(trigger).toBeDisabled();
  await expect(trigger).toHaveText('Plan mode');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(trigger).toBeEnabled();
  await expect(trigger).toHaveText('Plan mode');
  await expect.poll(() => savedPermission(page)).toBe('plan');
});

test('chooses the default agent inside Settings without closing the Settings page', async ({ page }) => {
  const settings = await openSettings(page, 'Agents');
  const trigger = settings.getByRole('button', { name: 'Default agent for new tasks', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Default agent', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: 'Claude Code', exact: true })).toBeFocused();
  await page.screenshot({ path: '/private/tmp/pandacode-settings-menu.png', animations: 'disabled' });
  await page.keyboard.press('Escape');
  await expect(menu).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Claude Code', exact: true })).toBeFocused();
  await page.keyboard.press('End');
  await expect(menu.getByRole('menuitemradio', { name: 'Muse Code', exact: true })).toBeFocused();
  await page.keyboard.press('Home');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'Kimi Code', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await expect(trigger).toHaveText('Kimi Code');
  await expect(trigger).toBeFocused();
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: 'Kimi Code', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Tab');
  await expect(menu).toHaveCount(0);
  await expect(settings.getByRole('button', { name: 'Default model for new tasks', exact: true })).toBeFocused();
  await closeSettings(page);
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'kimi', model: 'default' });
  await expect(page.locator('#composer .provider-logo[data-provider="kimi"]')).toBeVisible();
});

test('keeps the Settings agent menu clickable at the minimum desktop window size', async ({ page }) => {
  await page.setViewportSize({ width: 860, height: 580 });
  const settings = await openSettings(page, 'Agents');
  await settings.getByRole('button', { name: 'Default agent for new tasks', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Default agent', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: 'Claude Code', exact: true })).toBeFocused();
  await page.screenshot({ path: '/private/tmp/pandacode-settings-menu-narrow.png', animations: 'disabled' });
  // The list scrolls at this height; every agent must be reachable once scrolled to.
  const hitTargets = await menu.getByRole('menuitemradio').evaluateAll(elements => elements.map(element => {
    element.scrollIntoView({ block: 'nearest' });
    const rect = element.getBoundingClientRect();
    return { inViewport: rect.left >= 0 && rect.right <= innerWidth && rect.top >= 0 && rect.bottom <= innerHeight,
      reachable: element.contains(document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)) };
  }));
  expect(hitTargets).toHaveLength(15);
  expect(hitTargets.every(target => target.inViewport && target.reachable)).toBe(true);
  await menu.getByRole('menuitemradio', { name: 'Kimi Code', exact: true }).click();
  await expect(settings.getByRole('button', { name: 'Default agent for new tasks', exact: true })).toHaveText('Kimi Code');
  await expect(settings.getByRole('button', { name: 'Back to the workspace', exact: true })).toBeVisible();
});

test('keeps menus readable and usable with reduced motion, transparency, and high contrast', async ({ page }) => {
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-motion', value: 'reduce' },
    { name: 'prefers-reduced-transparency', value: 'reduce' },
    { name: 'prefers-contrast', value: 'more' },
    { name: 'forced-colors', value: 'active' },
  ] });
  await expect.poll(() => page.evaluate(() => [
    '(prefers-reduced-motion: reduce)', '(prefers-reduced-transparency: reduce)', '(prefers-contrast: more)', '(forced-colors: active)',
  ].every(query => matchMedia(query).matches))).toBe(true);
  await projectFilter(page).click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  await expect(menu.getByRole('searchbox', { name: 'Search projects', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(menu.getByRole('menuitemradio', { name: 'All projects', exact: true })).toBeFocused();
  const styles = await menu.evaluate(element => {
    const style = getComputedStyle(element);
    return { backdrop: style.backdropFilter, background: style.backgroundColor, border: Number.parseFloat(style.borderTopWidth), borderStyle: style.borderTopStyle };
  });
  expect(styles.backdrop).toBe('none');
  expect(styles.background).toMatch(/^rgb\(/);
  expect(styles.border).toBeGreaterThanOrEqual(1);
  expect(styles.borderStyle).not.toBe('none');
  await page.keyboard.press('End');
  await page.keyboard.press('Enter');
  await expect(menu).toHaveCount(0);
  await expect(projectFilter(page)).toHaveText('pandacode');
  await expect(page.locator('#navigation .task-title')).toHaveText(['Explore the project']);
  await devtools.detach();
});

for (const material of ['liquidGlass', 'vibrancy'] as const) {
  test(`reveals native ${material} only through the sidebar while conversation text stays opaque with wallpapers disabled`, async ({ page }) => {
    await disableWallpapers(page);
    await page.evaluate(async material => {
      const { initializeNativeAppearance } = await import('/src/appearance.ts');
      (window as any).__pandacodeDisposeAppearance = initializeNativeAppearance(async () => ({ platform: 'macos', material }));
    }, material);
    await expect(page.locator('html')).toHaveAttribute('data-native-material', material);
    const surfaces = await appearanceSurfaces(page);
    expect(surfaces.alphas).toEqual([0, 0, 0, 0, 0, 1]);
    expect(surfaces.sidebarBackdrop).toBe('none');
    expect(surfaces.mainContrast).toBeGreaterThanOrEqual(4.5);
    await expect(prompt(page)).toBeEnabled();
    await page.evaluate(() => (window as any).__pandacodeDisposeAppearance());
    await expect(page.locator('html')).not.toHaveAttribute('data-native-material');
    expect((await appearanceSurfaces(page)).alphas[0]).toBe(1);
  });
}

test('keeps preview, unsupported platforms, and unavailable native materials opaque with wallpapers disabled', async ({ page }) => {
  await disableWallpapers(page);
  await expect(page.getByText('Browser preview · sample data', { exact: true })).toBeVisible();
  await expect(page.locator('html')).not.toHaveAttribute('data-native-material');
  expect((await appearanceSurfaces(page)).alphas.filter((_, index) => [0, 4, 5].includes(index))).toEqual([1, 1, 1]);
  await page.evaluate(async () => {
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    (window as any).__pandacodeDisposeAppearance = initializeNativeAppearance(async () => ({ platform: 'other', material: 'liquidGlass' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  expect((await appearanceSurfaces(page)).alphas.filter((_, index) => [0, 4, 5].includes(index))).toEqual([1, 1, 1]);
  await page.evaluate(async () => {
    (window as any).__pandacodeDisposeAppearance();
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    (window as any).__pandacodeDisposeAppearance = initializeNativeAppearance(async () => { throw new Error('Test native material unavailable'); });
  });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  const fallback = await appearanceSurfaces(page);
  expect(fallback.alphas.filter((_, index) => [0, 4, 5].includes(index))).toEqual([1, 1, 1]);
  expect(fallback.mainContrast).toBeGreaterThanOrEqual(4.5);
  await page.evaluate(() => (window as any).__pandacodeDisposeAppearance());
});

test('coalesces appearance preferences without restoring stale glass or losing the draft and open menu', async ({ page }) => {
  await prompt(page).fill('Keep my draft as the system appearance changes');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const search = menu.getByRole('searchbox', { name: 'Search harnesses and models', exact: true });
  await search.fill('opus');
  await page.evaluate(async () => {
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    const testState = (window as any).__pandacodeAppearance = { calls: [], pending: [], materials: [], hold: false, material: 'liquidGlass', active: 0, maxActive: 0, prompt: document.querySelector('#prompt'), menu: document.querySelector('.model-menu') };
    testState.dispose = initializeNativeAppearance(preferences => {
      testState.calls.push(preferences);
      testState.maxActive = Math.max(testState.maxActive, ++testState.active);
      if (!testState.hold) {
        testState.active--;
        return Promise.resolve({ platform: 'macos', material: testState.material });
      }
      return new Promise(resolve => testState.pending.push({ preferences, reply: (result: any) => { testState.active--; resolve(result); } }));
    });
    const transparency = matchMedia('(prefers-reduced-transparency: reduce)');
    const contrast = matchMedia('(prefers-contrast: more)');
    testState.observed = { reducedTransparency: transparency.matches, increasedContrast: contrast.matches };
    const onTransparency = (event: MediaQueryListEvent) => { testState.observed.reducedTransparency = event.matches; };
    const onContrast = (event: MediaQueryListEvent) => { testState.observed.increasedContrast = event.matches; };
    transparency.addEventListener('change', onTransparency);
    contrast.addEventListener('change', onContrast);
    testState.stopObservingMedia = () => {
      transparency.removeEventListener('change', onTransparency);
      contrast.removeEventListener('change', onContrast);
    };
  });
  const calls = () => page.evaluate(() => (window as any).__pandacodeAppearance.calls);
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'liquidGlass');
  await page.evaluate(() => { (window as any).__pandacodeAppearance.hold = true; window.dispatchEvent(new Event('focus')); });
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeAppearance.pending.length)).toBe(1);
  const gatedCallCount = (await calls()).length;
  const devtools = await page.context().newCDPSession(page);
  await devtools.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-contrast', value: 'no-preference' },
  ] });
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeAppearance.observed)).toEqual({ reducedTransparency: true, increasedContrast: false });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  expect((await appearanceSurfaces(page)).alphas).toEqual([1, 1, 1, 1, 1, 1]);
  await page.evaluate(() => {
    const state = (window as any).__pandacodeAppearance;
    state.observer = new MutationObserver(() => state.materials.push(document.documentElement.dataset.nativeMaterial));
    state.observer.observe(document.documentElement, { attributes: true, attributeFilter: ['data-native-material'] });
  });
  await devtools.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'no-preference' }, { name: 'prefers-contrast', value: 'more' },
  ] });
  // CSS queries change before their change events are dispatched. Wait for both
  // real events before replying to IPC, so this tests coalescing deterministically.
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeAppearance.observed)).toEqual({ reducedTransparency: false, increasedContrast: true });
  expect((await calls()).length).toBe(gatedCallCount);
  await page.evaluate(() => (window as any).__pandacodeAppearance.pending.shift().reply({ platform: 'macos', material: 'liquidGlass' }));
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeAppearance.pending.map((request: any) => request.preferences))).toEqual([{ reducedTransparency: false, increasedContrast: true, darkMode: true }]);
  expect((await calls()).length).toBe(gatedCallCount + 1);
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  expect(await page.evaluate(() => (window as any).__pandacodeAppearance.materials)).not.toContain('liquidGlass');
  await page.evaluate(() => {
    const state = (window as any).__pandacodeAppearance;
    state.hold = false;
    state.pending.shift().reply({ platform: 'macos', material: 'liquidGlass' });
    state.material = 'vibrancy';
  });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'solid');
  expect((await appearanceSurfaces(page)).alphas).toEqual([1, 1, 1, 1, 1, 1]);
  await devtools.send('Emulation.setEmulatedMedia', { features: [
    { name: 'prefers-reduced-transparency', value: 'no-preference' }, { name: 'prefers-contrast', value: 'no-preference' },
  ] });
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeAppearance.observed)).toEqual({ reducedTransparency: false, increasedContrast: false });
  await expect(page.locator('html')).toHaveAttribute('data-native-material', 'vibrancy');
  expect((await calls()).at(-1)).toEqual({ reducedTransparency: false, increasedContrast: false, darkMode: true });
  expect(await page.evaluate(() => (window as any).__pandacodeAppearance.maxActive)).toBe(1);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toHaveValue('Keep my draft as the system appearance changes');
  await expect(menu).toHaveCount(1);
  await expect(search).toHaveValue('opus');
  await expect(search).toBeFocused();
  expect(await page.evaluate(() => {
    const state = (window as any).__pandacodeAppearance;
    return state.prompt === document.querySelector('#prompt') && state.menu === document.querySelector('.model-menu');
  })).toBe(true);
  const cleanupCallCount = await page.evaluate(() => {
    const state = (window as any).__pandacodeAppearance;
    state.dispose(); state.observer.disconnect(); state.stopObservingMedia();
    window.dispatchEvent(new Event('focus'));
    return state.calls.length;
  });
  await devtools.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
  await page.evaluate(() => new Promise<void>(resolve => requestAnimationFrame(() => resolve())));
  await expect(page.locator('html')).not.toHaveAttribute('data-native-material');
  expect((await calls()).length).toBe(cleanupCallCount);
  await devtools.detach();
});

test('expands saved tool commands and file contents after reloading the conversation', async ({ page }) => {
  const read = toolByName(page, 'Read');
  await expandToolTurn(read);
  await read.locator(':scope > summary').click();
  await expect(read.locator('[data-tool-section="input"] pre')).toHaveText('src/components/search.ts');
  await expect(read.locator('[data-tool-section="output"] pre')).toContainText('export function createSearchIndex(items)');
  const bash = toolByName(page, 'Bash');
  await expandToolTurn(bash);
  await bash.locator(':scope > summary').click();
  await expect(bash.locator('[data-tool-section="input"] pre')).toHaveText('npm test -- --runInBand');
  await expect(bash.locator('[data-tool-section="output"] pre')).toContainText('PASS src/components/search.test.ts');
  await expect(bash.locator('[data-tool-section="output"] pre')).toContainText('Tests: 12 passed, 12 total');
  await expect(bash).toHaveAttribute('data-tool-status', 'completed');
  await bash.scrollIntoViewIfNeeded();
  await page.screenshot({ path: '/private/tmp/pandacode-tool-details.png' });
  await page.reload();
  await expandToolTurn(bash);
  await bash.locator(':scope > summary').click();
  await expect(bash.locator('[data-tool-section="output"] pre')).toContainText('Sample output — no command was executed.');
  await expect(page.getByText('Browser preview · sample data', { exact: true })).toBeVisible();
});

test('coalesces live tool updates while preserving expansion and saves their details', async ({ page }) => {
  await page.clock.install();
  await page.reload();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('Show the preview test command and its result');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // The async preview bridge may start after click resolves. Wait for its tool
  // event's backing record before advancing the paused animation-frame clock.
  await expect.poll(() => page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const { messages } = await invoke('get_messages', { sessionId });
    return messages.filter((message: { role: string }) => message.role === 'tool')
      .map((message: { content: string }) => JSON.parse(message.content).status);
  }, sessionId)).toEqual(['running']);
  await page.clock.runFor(20);
  const live = page.locator('.live-tools details.tool-activity');
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute('data-tool-status', 'running');
  await expect(turnForTool(live)).toHaveAttribute('open', '');
  await expandToolTurn(live);
  await live.locator(':scope > summary').click();
  await expect(live.locator('[data-tool-section="input"] pre')).toHaveText('npm test -- --runInBand');
  await page.clock.runFor(450);
  await expect(live).toHaveCount(1);
  await expect(live).toHaveAttribute('data-tool-status', 'completed');
  await expect(live).toHaveAttribute('open', '');
  await expect(live.locator('[data-tool-section="output"] pre')).toContainText('Tests: 12 passed, 12 total');
  await page.clock.runFor(1000);
  await expect(prompt(page)).toBeEnabled();
  await expect(live).toHaveCount(0);
  const saved = toolByName(page, 'Bash');
  await expect(saved).toHaveCount(1);
  await expect(turnForTool(saved)).toHaveAttribute('open', '');
  await expect(saved).toHaveAttribute('open', '');
  await expect(saved.locator('[data-tool-section="output"] pre')).toContainText('PASS src/components/search.test.ts');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Refine the navigation');
  await page.locator(`.task-item[data-id="${sessionId}"]`).click();
  await expect(saved).toHaveCount(1);
  await expandToolTurn(saved);
  if (!await saved.evaluate(element => element.hasAttribute('open'))) await saved.locator(':scope > summary').click();
  await expect(saved.locator('[data-tool-section="input"] pre')).toHaveText('npm test -- --runInBand');
  await expect(saved.locator('[data-tool-section="output"] pre')).toContainText('Tests: 12 passed, 12 total');
  const persisted = await page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const { messages } = await invoke('get_messages', { sessionId });
    return messages.filter((message: { role: string }) => message.role === 'tool').map((message: { content: string }) => JSON.parse(message.content));
  }, sessionId);
  expect(persisted).toHaveLength(1);
  expect(persisted[0]).toMatchObject({ type: 'tool_activity', version: 1, name: 'Bash', status: 'completed', input: 'npm test -- --runInBand' });
  expect(persisted[0].output).toContain('Tests: 12 passed, 12 total');
});

test('preserves focused tool detail and output scroll across snapshots and saving', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const outputMarker = /const sampleTestOutput\s*=/;
    const messageMarker = /const toolMessage\s*=/;
    expect(source).toMatch(outputMarker);
    expect(source).toMatch(messageMarker);
    const body = source
      .replace(outputMarker, `const sampleTestOutput = Array.from({ length: 60 }, (_, index) => 'Sample test output line ' + index).join('\\n') + '\\n' +`)
      .replace(messageMarker, 'tool.output = sampleTestOutput; window.__pandacodeToolStarted = true; const toolMessage =')
      .replace(/case ["']list_sessions["']\s*:/, `$& if (window.__pandacodeDelaySaved) await new Promise(resolve => { window.__pandacodeReleaseSaved = resolve; });`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.clock.install();
  await page.reload();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await prompt(page).fill('Keep my position while I read the tool output');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeToolStarted)).toBe(true);
  await page.clock.runFor(20);
  const live = page.locator('.live-tools details.tool-activity');
  await expect(live).toHaveAttribute('data-tool-status', 'running');
  await expandToolTurn(live);
  const turnKey = await turnForTool(live).getAttribute('data-turn-key');
  const key = await live.getAttribute('data-tool-key');
  await live.locator(':scope > summary').click();
  await live.locator('.tool-trace-raw > summary').click();
  const retainedTool = page.locator(`#transcript [data-tool-key="${key}"]`);
  const output = retainedTool.locator('[data-tool-section="output"] pre');
  await output.focus();
  const scroll = await output.evaluate(element => {
    element.scrollTop = 120;
    return { top: element.scrollTop, overflow: element.scrollHeight - element.clientHeight };
  });
  expect(scroll.overflow).toBeGreaterThan(120);
  expect(scroll.top).toBe(120);
  await page.clock.runFor(450);
  await expect(live).toHaveAttribute('data-tool-status', 'completed');
  await expect(live).toHaveAttribute('data-tool-key', key!);
  await expect(live).toHaveAttribute('open', '');
  await expect(output).toBeFocused();
  expect(await output.evaluate(element => element.scrollTop)).toBe(scroll.top);
  await page.evaluate(() => { (window as any).__pandacodeDelaySaved = true; });
  await page.clock.runFor(1000);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseSaved)).toBe('function');
  await page.clock.runFor(20);
  // The completed-turn boundary may materialize the tool before history loads.
  await expect(retainedTool).toHaveCount(1);
  await expect(retainedTool).toHaveAttribute('open', '');
  await expect(output).toBeFocused();
  expect(await output.evaluate(element => element.scrollTop)).toBe(scroll.top);
  await page.evaluate(() => {
    (window as any).__pandacodeDelaySaved = false;
    (window as any).__pandacodeReleaseSaved();
    delete (window as any).__pandacodeReleaseSaved;
  });
  await expect(prompt(page)).toBeEnabled();
  await expect(live).toHaveCount(0);
  const saved = toolByName(page, 'Bash');
  await expect(turnForTool(saved)).toHaveAttribute('data-turn-key', turnKey!);
  await expect(turnForTool(saved)).toHaveAttribute('open', '');
  await expect(saved).toHaveAttribute('data-tool-key', key!);
  await expect(saved).toHaveAttribute('open', '');
  const savedOutput = saved.locator('[data-tool-section="output"] pre');
  await expect(savedOutput).toBeFocused();
  expect(await savedOutput.evaluate(element => element.scrollTop)).toBe(scroll.top);
});

test('caps long live tool activity without dropping the output being read', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /const toolMessage\s*=/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `tool.output = 'Keep this first tool output available while I read it.'; const toolMessage =`)
      + '\nexport const emitActivityTestEvent = agent;\n';
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.clock.install();
  await page.reload();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('Keep the first result readable throughout a long run');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const { messages } = await invoke('get_messages', { sessionId });
    return messages.some((message: { role: string }) => message.role === 'tool');
  }, sessionId)).toBe(true);
  await page.clock.runFor(20);
  const firstTool = page.locator('.live-tools details.tool-activity').first();
  const key = await firstTool.getAttribute('data-tool-key');
  await expandToolTurn(firstTool);
  await firstTool.locator(':scope > summary').click();
  await firstTool.locator('.tool-trace-raw > summary').click();
  const output = page.locator(`[data-tool-key="${key}"] [data-tool-section="output"] pre`);
  await expect(output).toHaveText('Keep this first tool output available while I read it.');
  await output.focus();
  await page.evaluate(async sessionId => {
    const { emitActivityTestEvent } = await import((window as any).__pandacodePreviewUrl);
    for (let index = 0; index < 40; index++) {
      emitActivityTestEvent({ sessionId, kind: 'text', text: index >= 38 ? 'A'.repeat(20_000) : `Progress update ${index}.` });
      emitActivityTestEvent({ sessionId, kind: 'tool', text: 'Read', tool: {
        id: `long-live-${index}`, name: 'Read', status: 'completed', input: `file-${index}.ts`, output: `File ${index} contents`,
      } });
    }
    emitActivityTestEvent({ sessionId, kind: 'error', text: 'One late check needs attention.' });
  }, sessionId);
  await page.clock.runFor(20);
  await expect(output).toBeFocused();
  await expect(output).toHaveText('Keep this first tool output available while I read it.');
  await expect(page.locator(`[data-tool-key="${key}"]`)).toHaveAttribute('open', '');
  await expect(page.locator('[data-tool-key="tool:long-live-39"]')).toHaveCount(1);
  const toolCount = await page.locator('.live-tools details.tool-activity').count();
  expect(toolCount).toBeGreaterThan(1);
  expect(toolCount).toBeLessThanOrEqual(30);
  await expect(page.locator('.live-activity .activity-limit')).toBeVisible();
  const commentary = page.locator('.live-tools .activity-commentary').last();
  await expect(commentary).toContainText('[Activity preview truncated]');
  expect((await commentary.textContent())!.length).toBeLessThan(16_450);
  await expect(page.locator('#stream-region .live-text')).toHaveText('A'.repeat(20_000));
  await expect(page.locator('#stream-region .live-text')).toBeVisible();
  const error = page.locator('.live-errors .message-error');
  await expect(error).toContainText('One late check needs attention.');
  await expect(error).toBeVisible();
  expect(await error.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

test('keeps legacy tool output readable without duplicate completion placeholders', async ({ page }) => {
  const legacy = toolByName(page, 'Legacy tool report');
  await expandToolTurn(legacy);
  await legacy.locator(':scope > summary').click();
  await expect(legacy.locator('.tool-activity-legacy-body')).toHaveText('Older saved output remains readable.');
  await expect(toolByName(page, 'Tool finished')).toHaveCount(0);
});

test('collapses turn activity into one compact row while keeping the final answer visible', async ({ page }) => {
  await showTurnFixture(page, [
    { role: 'user', content: 'Make search feel instant.', at: 0 },
    { role: 'assistant', content: 'I’ll trace how the search input updates the results, then check the keyboard interactions.', at: 5000 },
    { role: 'tool', content: turnTool('saved-search-read', 'Read'), at: 10_000 },
    { role: 'tool', content: turnTool('saved-search-test', 'Bash'), at: 20_000 },
    { role: 'tool', content: 'Legacy tool report\nOlder saved output remains readable.', at: 25_000 },
    { role: 'tool', content: 'Tool finished', at: 30_000 },
    { role: 'assistant', content: 'The input was rebuilding the search index on every keystroke. The index now updates only when needed.', at: 150_000 },
  ]);
  const turn = page.locator('details.turn-activity');
  await expect(turn).toHaveCount(1);
  await expect(turn).not.toHaveAttribute('open', '');
  await expect(turn.locator('.turn-activity-label')).toHaveText(/^Worked for about /);
  await expect(turn.locator('.turn-activity-body')).toBeHidden();
  await expect(turn.locator('details.tool-activity')).toHaveCount(3);
  const commentary = page.getByText('I’ll trace how the search input updates the results, then check the keyboard interactions.', { exact: true });
  await expect(commentary).toBeHidden();
  const answer = page.locator('.agent-message').filter({ hasText: 'The input was rebuilding the search index on every keystroke.' });
  await expect(answer).toBeVisible();
  expect(await answer.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  const summary = turn.locator('.turn-activity-summary');
  const bounds = (await summary.boundingBox())!;
  expect(bounds.height).toBeGreaterThanOrEqual(24);
  expect(bounds.height).toBeLessThanOrEqual(44);
  expect((await turn.boundingBox())!.height).toBeLessThanOrEqual(52);
  await page.screenshot({ path: '/private/tmp/pandacode-activity-collapsed.png', animations: 'disabled' });
  await summary.focus();
  await page.keyboard.press('Enter');
  await expect(turn).toHaveAttribute('open', '');
  await expect(commentary).toBeVisible();
  await expandToolTurn(toolByName(page, 'Read'));
  await expect(toolByName(page, 'Read').locator(':scope > summary')).toBeVisible();
  await expect(toolByName(page, 'Bash').locator(':scope > summary')).toBeVisible();
  await page.screenshot({ path: '/private/tmp/pandacode-activity-expanded.png', animations: 'disabled' });
  await summary.focus();
  await page.keyboard.press('Space');
  await expect(turn).not.toHaveAttribute('open', '');
  await expect(answer).toBeVisible();
});

async function showTurnFixture(page: Page, entries: Array<{ role: string; content: string; at: number; turnDurationMs?: number | null }>): Promise<void> {
  const fixture = entries.map((entry, index) => ({ id: 200 + index, sessionId: 'session-4', role: entry.role, content: entry.content, createdAt: 1_784_000_000_000 + entry.at, ...(entry.turnDurationMs === undefined ? {} : { turnDurationMs: entry.turnDurationMs }) }));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /const providers\s*=/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: previewBody(source.replace(marker, `messages['session-4'] = ${JSON.stringify(fixture)}; const providers =`)) });
  });
  await page.reload();
  await chooseProjectFilter(page, 'pandacode');
}

const turnTool = (id: string, name: string, status = 'completed') => JSON.stringify({ type: 'tool_activity', version: 1, id, name, status, input: `${name} input`, output: `${name} output` });

test('tool activity settings persist expanded and collapsed groups with compact spacing', async ({ page }) => {
  await showTurnFixture(page, [
    { role: 'user', content: 'Inspect these files.', at: 0 },
    ...Array.from({ length: 12 }, (_, index) => ({ role: 'tool', content: turnTool(`compact-${index}`, 'Read'), at: (index + 1) * 1000 })),
    { role: 'assistant', content: 'Inspection complete.', at: 15000 },
  ]);
  const turn = page.locator('details.turn-activity');
  const groups = turn.locator('.tool-group');
  await expect(turn).not.toHaveAttribute('open', '');
  await turn.locator('.turn-activity-summary').click();
  await expect(groups).toHaveCount(3);
  const first = (await groups.nth(0).boundingBox())!;
  const second = (await groups.nth(1).boundingBox())!;
  expect(second.y - first.y - first.height).toBeLessThanOrEqual(4);
  expect(first.height).toBeGreaterThanOrEqual(30);
  await prompt(page).fill('Keep my draft while changing activity.');
  await page.keyboard.press('Meta+,');
  const expand = page.getByRole('checkbox', { name: 'Expand tool activity', exact: true });
  await expect(expand).not.toBeChecked();
  await expand.check();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(turn).toHaveAttribute('open', '');
  await expect(turn.locator('.tool-group[open]')).toHaveCount(3);
  await expect(prompt(page)).toHaveValue('Keep my draft while changing activity.');
  await page.reload();
  await expect(turn).toHaveAttribute('open', '');
  await expect(turn.locator('.tool-group[open]')).toHaveCount(3);
  await page.keyboard.press('Meta+,');
  await expand.uncheck();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect(turn).not.toHaveAttribute('open', '');
  await turn.locator('.turn-activity-summary').focus();
  await page.keyboard.press('Enter');
  await expect(turn).toHaveAttribute('open', '');
  await expect(turn.locator('.tool-group[open]')).toHaveCount(0);
  await groups.first().locator('.tool-group-summary').focus();
  await page.keyboard.press('Enter');
  await expect(groups.first()).toHaveAttribute('open', '');
  await page.reload();
  await expect(turn).not.toHaveAttribute('open', '');
});

test('times each tool turn independently using saved durations and labels older estimates', async ({ page }) => {
  await showTurnFixture(page, [
    { role: 'user', content: 'First task', at: 0, turnDurationMs: 83_000 },
    { role: 'assistant', content: 'First task progress', at: 5000 },
    { role: 'tool', content: turnTool('turn-one', 'Read'), at: 10_000 },
    { role: 'assistant', content: 'First task final answer', at: 125_000 },
    { role: 'user', content: 'Second task after a long pause', at: 7_200_000, turnDurationMs: 17_000 },
    { role: 'tool', content: turnTool('turn-two', 'Bash'), at: 7_202_000 },
    { role: 'assistant', content: 'Second task progress', at: 7_204_000 },
    { role: 'assistant', content: 'Second task final answer', at: 7_260_000 },
    { role: 'user', content: 'Older task without saved timing', at: 8_000_000, turnDurationMs: null },
    { role: 'tool', content: turnTool('turn-three', 'Search'), at: 8_003_000 },
    { role: 'tool', content: 'Tool finished', at: 8_020_000 },
    { role: 'assistant', content: 'Older task final answer', at: 8_060_000 },
    { role: 'user', content: 'Answer without using tools', at: 9_000_000, turnDurationMs: 1000 },
    { role: 'assistant', content: 'A plain answer needs no activity disclosure.', at: 9_001_000 },
  ]);
  const turns = page.locator('details.turn-activity');
  await expect(turns).toHaveCount(3);
  await expect(turns.locator('.turn-activity-label')).toHaveText(['Worked for 1m 23s', 'Worked for 17s', 'Worked for about 1m 0s']);
  await expect(turns.nth(2).locator('details.tool-activity')).toHaveCount(1);
  const keys = await turns.evaluateAll(elements => elements.map(element => element.getAttribute('data-turn-key')));
  expect(keys.every(Boolean)).toBe(true);
  expect(new Set(keys).size).toBe(3);
  await expect(page.locator('details.turn-activity[open]')).toHaveCount(0);
  await turns.nth(0).locator('.turn-activity-summary').click();
  await expect(turns.nth(0)).toHaveAttribute('open', '');
  await expect(turns.nth(1)).not.toHaveAttribute('open', '');
  await expect(turns.nth(2)).not.toHaveAttribute('open', '');
  await expect(turns.nth(0).locator('.turn-activity-body')).toContainText('First task progress');
  await expect(turns.nth(0).locator('details.tool-activity')).toHaveCount(1);
  await expect(turns.nth(0)).not.toContainText('Second task progress');
  for (const text of ['First task final answer', 'Second task final answer', 'Older task final answer', 'A plain answer needs no activity disclosure.']) {
    const final = page.getByText(text, { exact: true });
    await expect(final).toBeVisible();
    expect(await final.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  }
  await chooseProjectFilter(page, 'All projects');
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(turns.locator('.turn-activity-label')).toHaveText(['Worked for 1m 23s', 'Worked for 17s', 'Worked for about 1m 0s']);
});

test('keeps saved errors visible outside a collapsed tool turn', async ({ page }) => {
  await showTurnFixture(page, [
    { role: 'user', content: 'Run the check', at: 0, turnDurationMs: 23_000 },
    { role: 'assistant', content: 'Running the project check.', at: 1000 },
    { role: 'tool', content: turnTool('failed-check', 'Bash', 'failed'), at: 5000 },
    { role: 'error', content: 'The project check failed with exit code 1.', at: 22_000 },
    { role: 'assistant', content: 'I found an error in the project check.', at: 23_000 },
  ]);
  const turn = page.locator('details.turn-activity');
  await expect(turn).not.toHaveAttribute('open', '');
  const error = page.locator('.message-error').filter({ hasText: 'The project check failed with exit code 1.' });
  await expect(error).toBeVisible();
  expect(await error.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  await expect(page.getByText('I found an error in the project check.', { exact: true })).toBeVisible();
  await turn.locator('.turn-activity-summary').click();
  await expect(toolByName(page, 'Bash')).toHaveAttribute('data-tool-status', 'failed');
});

test('keeps live approvals and errors actionable while tool activity is collapsed', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /const output\s*=/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `
      agent({ sessionId: s.id, kind: 'approval', requestId: 'turn-approval', text: 'Run npm test in this project?' });
      agent({ sessionId: s.id, kind: 'error', text: 'A previous check failed.' });
      window.__pandacodeTurnApprovalReady = true;
      const output =
    `);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.clock.install();
  await page.reload();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(prompt(page)).toBeFocused();
  await prompt(page).fill('Check the project and request permission');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeTurnApprovalReady)).toBe(true);
  await page.clock.runFor(20);
  const turn = page.locator('#stream-region details.turn-activity');
  await expect(turn).toHaveCount(1);
  await expect(turn).toHaveAttribute('open', '');
  await turn.locator(':scope > summary').click();
  await expect(turn).not.toHaveAttribute('open', '');
  const approval = page.locator('.approval-bar');
  await expect(approval).toBeVisible();
  expect(await approval.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  const error = page.locator('#stream-region .message-error').filter({ hasText: 'A previous check failed.' });
  await expect(error).toBeVisible();
  expect(await error.evaluate(element => element.closest('.turn-activity'))).toBeNull();
  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect(approval).toHaveCount(0);
  await expect(turn).not.toHaveAttribute('open', '');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

async function startControlledStatusStream(page: Page, withoutContextMetadata = false): Promise<string> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const sendMarker = /case ["']send_message["']\s*:/;
    const approvalMarker = /case ["']respond_approval["']\s*:/;
    expect(source).toMatch(sendMarker);
    expect(source).toMatch(approvalMarker);
    const body = source
      .replace(/case ["']list_provider_models["']\s*:/, `$& if (${withoutContextMetadata}) { result = [{id:'default',name:'Default',description:'No context metadata'}]; break; }`)
      .replace(sendMarker, `$& {
        const selected = session(args.sessionId);
        selected.status = 'running';
        messages[selected.id] ??= [];
        messages[selected.id].push({ id: ++id, sessionId: selected.id, role: 'user', content: args.text, createdAt: Date.now() });
        window.__pandacodeControlledStatusReady = true;
        break;
      }`)
      .replace(approvalMarker, `$& await new Promise(resolve => { window.__pandacodeResolveStatusApproval = resolve; });`)
      + `
        export const emitStatusTestEvent = agent;
        export const refreshStatusTestSessions = () => emit('sessions-changed', {});
        export function finishStatusTestTurn(sessionId) {
          messages[sessionId].push({ id: ++id, sessionId, role: 'tool', content: 'Checked the project files.', createdAt: Date.now() });
          finish(sessionId, 'The project check is complete.');
        }
      `;
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.clock.install();
  await page.reload();
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = (await prompt(page).getAttribute('data-session-id'))!;
  await prompt(page).fill('Show the actual provider activity as it arrives');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeControlledStatusReady)).toBe(true);
  await page.clock.runFor(20);
  const turn = page.locator('#stream-region .turn-activity');
  await expect(turn).toHaveAttribute('open', '');
  await expect(page.locator('.live-status')).toHaveText('Starting agent');
  return sessionId;
}

async function emitStatusEvents(page: Page, sessionId: string, events: Array<Record<string, unknown>>): Promise<void> {
  await page.evaluate(async ({ sessionId, events }) => {
    const { emitStatusTestEvent } = await import((window as any).__pandacodePreviewUrl);
    for (const event of events) emitStatusTestEvent({ ...event, sessionId });
  }, { sessionId, events });
  await page.clock.runFor(20);
}

test('shows reported context usage while running and keeps late usage from creating a phantom stream', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const indicator = page.locator('.context-indicator');
  await expect(indicator).toHaveText('200K context');
  await expect(modelTrigger(page)).toBeDisabled();
  await page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    await invoke('update_session', { sessionId, contextUsage: { usedTokens: 24000, contextWindow: 200000 } });
  }, sessionId);
  await emitStatusEvents(page, sessionId, [{ kind: 'usage', text: '', data: { usedTokens: 24000, contextWindow: 200000 } }]);
  await expect(indicator).toHaveText('24K / 200K context');
  await expect(indicator).toHaveAttribute('title', /24,000.*200,000/);
  await page.screenshot({ path: '/private/tmp/pandacode-context-usage.png', animations: 'disabled' });
  await emitStatusEvents(page, sessionId, [
    { kind: 'usage', text: '', data: { usedTokens: -10, contextWindow: 200000 } },
    { kind: 'usage', text: '', data: { usedTokens: 'fake', contextWindow: 200000 } },
    { kind: 'text', text: 'The reported context usage remains stable while tokens stream.' },
  ]);
  await expect(indicator).toHaveText('24K / 200K context');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('#stream-region .turn-activity')).toHaveCount(0);
  await expect(indicator).toHaveText('24K / 200K context');
  await emitStatusEvents(page, sessionId, [{ kind: 'usage', text: '', data: { usedTokens: 25000, contextWindow: 200000 } }]);
  await expect(indicator).toHaveText('25K / 200K context');
  await emitStatusEvents(page, 'unknown-usage-task', [{ kind: 'usage', text: '', data: { usedTokens: 100000, contextWindow: 200000 } }]);
  await expect(indicator).toHaveText('25K / 200K context');
  await expect(page.locator('#stream-region .turn-activity')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  await expect(prompt(page)).toBeEnabled();
  await modelTrigger(page).click();
  await modelPicker(page).getByRole('button', { name: 'Claude Code · Claude Opus 5', exact: true }).click();
  await expect(indicator).not.toContainText('25K');
  expect(await page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const sessions = await invoke('list_sessions', {});
    return sessions.find((session: { id: string }) => session.id === sessionId)?.contextUsage ?? null;
  }, sessionId)).toBeNull();
});

test('shows a reported token count without inventing an unavailable context limit', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page, true);
  await emitStatusEvents(page, sessionId, [{ kind: 'usage', text: '', data: { usedTokens: 24000, contextWindow: null } }]);
  const indicator = page.locator('.context-indicator');
  await expect(indicator).toBeVisible();
  await expect(indicator).toContainText('24K');
  await expect(indicator).not.toContainText('/');
  await expect(indicator).not.toContainText('%');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

test('updates live startup and retry status only when real response text arrives', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const status = page.locator('.live-status');
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: '' }, { kind: 'text', text: ' \n\t ' }]);
  await expect(status).toHaveText('Starting agent');
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: 'I found the relevant source file.' }]);
  await expect(status).toHaveText('Generating response');
  // The test clock is paused; let the coalesced Markdown paint run after status updates.
  await page.clock.runFor(40);
  await expect(page.locator('.streaming-content')).toContainText('I found the relevant source file.');
  await emitStatusEvents(page, sessionId, [{ kind: 'status', text: 'Retrying connection…' }, { kind: 'text', text: ' ' }]);
  await expect(status).toHaveText('Retrying connection…');
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: ' The connection has recovered.' }]);
  await expect(status).toHaveText('Generating response');
  await emitStatusEvents(page, sessionId, [{ kind: 'status', text: 'Stopping agent' }, { kind: 'text', text: ' Buffered final text.' }]);
  await expect(status).toHaveText('Stopping agent');
  await emitStatusEvents(page, sessionId, [
    { kind: 'status', text: 'Retrying a buffered request…' },
    { kind: 'approval', requestId: 'late-stopping-approval', text: 'A buffered permission request' },
  ]);
  await expect(status).toHaveText('Stopping agent');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

test('updates live tool status and preserves newer response status across delayed approval replies', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const status = page.locator('.live-status');
  const tool = (id: string, name: string, state: string) => ({ kind: 'tool', text: name, tool: { id, name, status: state, input: `${name} input`, output: state === 'completed' ? `${name} complete` : '' } });
  await emitStatusEvents(page, sessionId, [tool('status-read', 'Read', 'running')]);
  await expect(status).toHaveText('Running Read');
  await emitStatusEvents(page, sessionId, [tool('status-bash', 'Bash', 'running')]);
  await expect(status).toHaveText('Running Bash');
  await emitStatusEvents(page, sessionId, [tool('status-read', 'Read', 'completed')]);
  await expect(status).toHaveText('Running Bash');
  await emitStatusEvents(page, sessionId, [tool('status-bash', 'Bash', 'completed')]);
  await expect(status).toHaveText('Working…');
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'status-approval', text: 'Run the next check?' }]);
  const approval = page.locator('.approval-bar');
  await expect(approval).toBeVisible();
  await expect(status).toBeHidden();
  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeResolveStatusApproval)).toBe('function');
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: 'The approved check is producing a response.' }]);
  await expect(approval).toBeVisible();
  await expect(status).toHaveText('Generating response');
  await page.evaluate(() => { (window as any).__pandacodeResolveStatusApproval(); });
  await expect(approval).toHaveCount(0);
  await expect(status).toBeVisible();
  await expect(status).toHaveText('Generating response');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

test('the turn header names what the agent is doing, with no separate status line', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const turn = page.locator('.live-activity');
  const label = turn.locator('.turn-activity-label');
  await expect(label).toHaveText(/^Working… · |^Starting agent · /);
  await emitStatusEvents(page, sessionId, [{ kind: 'tool', text: 'Read', tool: { id: 'header-read', name: 'Read', status: 'running', input: 'src/main.ts', output: '' } }]);
  await expect(label).toHaveText(/^Running Read · /);
  await emitStatusEvents(page, sessionId, [{ kind: 'tool', text: 'Read', tool: { id: 'header-read', name: 'Read', status: 'completed', input: 'src/main.ts', output: 'Source contents' } }]);
  await expect(label).toHaveText(/^Working… · /);
  await page.clock.runFor(9000);
  await expect(label).toHaveText(/^Working… · 9s$/);
  // The status line is for screen readers; it takes no visible space.
  expect(await page.locator('.live-status').evaluate(el => el.getBoundingClientRect().height)).toBeLessThanOrEqual(1);
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

/** A request's line never runs past the bar: its summary truncates and the buttons stay in view. */
async function expectApprovalInBounds(page: Page): Promise<void> {
  const bar = (await page.locator('.approval-bar').boundingBox())!;
  for (const box of await page.locator('.approval-bar :is(.approval-summary,.approval-allow)').evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().toJSON()))) {
    expect(box.right).toBeLessThanOrEqual(bar.x + bar.width + 1);
  }
  await expect(page.locator('.approval-bar .approval-allow').first()).toBeVisible();
}

test('a very long command keeps the approval bar within its width', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const long = `codex exec --sandbox read-only "${'The user asked about this repo and wants it faster. '.repeat(12)}"`;
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'long', text: `${long}\nin the project folder` }]);
  await expect(page.locator('.approval-bar')).toBeVisible();
  await expectApprovalInBounds(page);
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'long-2', text: long }]);
  await page.locator('.approval-bar').getByRole('button', { name: /2 approvals needed/ }).click();
  await expect(page.locator('.approval-row')).toHaveCount(2);
  await expectApprovalInBounds(page);
});

test('approvals wait in one slim bar above the prompt and its context bar, one line each and grouped when there are several', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const bar = page.locator('#composer-area .approval-bar');
  // The sample harness holds each answer until the test lets it through.
  const resolveApproval = async () => {
    await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeResolveStatusApproval)).toBe('function');
    await page.evaluate(() => { const w = window as any, resolve = w.__pandacodeResolveStatusApproval; w.__pandacodeResolveStatusApproval = undefined; resolve(); });
  };
  const lineHeights = () => bar.locator('.approval-line').evaluateAll(lines => lines.map(line => Math.round(line.getBoundingClientRect().height)));
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'one', text: 'Run `npm test`\nin the project folder' }]);
  await expect(bar).toBeVisible();
  await expect(bar.locator('.approval-summary')).toHaveText('Run npm test');
  expect((await lineHeights()).every(height => height <= 36)).toBe(true);
  // It leads the composer area, above the context bar that rides on the prompt.
  await expect(page.locator('#composer-area > :first-child')).toHaveAttribute('id', 'approval-bar');
  const barBox = (await bar.boundingBox())!;
  for (const below of [page.locator('#composer-area .composer-context'), page.locator('#composer')]) {
    if (await below.count()) expect((await below.boundingBox())!.y).toBeGreaterThanOrEqual(barBox.y + barBox.height);
  }
  await expect(page.locator('#transcript .approval-bar')).toHaveCount(0);
  await expectApprovalInBounds(page);
  // The full request is one click away.
  await bar.locator('.approval-summary').click();
  await expect(bar.locator('.approval-full')).toContainText('in the project folder');
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'two', text: 'Write src/main.ts' }]);
  await expect(bar.locator('.approval-group')).toContainText('2 approvals needed');
  await expect(bar.locator('.approval-row')).toHaveCount(0);
  await bar.getByRole('button', { name: /2 approvals needed/ }).click();
  await expect(bar.locator('.approval-row')).toHaveCount(2);
  expect((await lineHeights()).every(height => height <= 36)).toBe(true);
  await bar.locator('[data-approval="two"]').getByRole('button', { name: 'Deny', exact: true }).click();
  await resolveApproval();
  await expect(bar.locator('.approval-group')).toHaveCount(0);
  await expect(bar.locator('.approval-row')).toHaveCount(1);
  await bar.getByRole('button', { name: 'Approve', exact: true }).click();
  await resolveApproval();
  await expect(bar).toHaveCount(0);
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
});

test('keeps approval, retry, stopping, and completed summaries clear', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  const label = page.locator('.live-activity .turn-activity-label');
  await emitStatusEvents(page, sessionId, [{ kind: 'status', text: 'Retrying connection…' }]);
  await expect(label).toHaveText(/^Retrying connection… · /);
  await page.clock.runFor(9000);
  await expect(label).toHaveText(/^Retrying connection… · 9s$/);
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: 'The connection has recovered.' }]);
  await expect(label).toHaveText(/^Generating response · /);
  await emitStatusEvents(page, sessionId, [{ kind: 'approval', requestId: 'playful-approval', text: 'Run the project check?' }]);
  await expect(label).toHaveText(/^Waiting for approval · /);
  const approval = page.locator('.approval-bar');
  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeResolveStatusApproval)).toBe('function');
  await emitStatusEvents(page, sessionId, [{ kind: 'text', text: 'The approved check is producing a response.' }]);
  await page.clock.runFor(8000);
  await expect(label).toHaveText(/^Waiting for approval · /);
  await expect(approval).toBeVisible();
  await page.evaluate(() => { (window as any).__pandacodeResolveStatusApproval(); });
  await expect(approval).toHaveCount(0);
  await expect(label).toHaveText(/^Generating response · /);
  await emitStatusEvents(page, sessionId, [{ kind: 'status', text: 'Stopping agent' }, { kind: 'text', text: 'Buffered response text.' }]);
  await page.clock.runFor(9000);
  await expect(label).toHaveText(/^Stopping agent · /);
  await page.evaluate(async sessionId => {
    const { finishStatusTestTurn } = await import((window as any).__pandacodePreviewUrl);
    finishStatusTestTurn(sessionId);
  }, sessionId);
  await expect(page.locator('.live-activity')).toHaveCount(0);
  await expect(page.locator('.turn-activity-label')).toHaveText(/^Worked for \d+s$/);
  await expect(page.getByText('The project check is complete.', { exact: true })).toBeVisible();
  await expect(prompt(page)).toBeEnabled();
});

test('marks a sent prompt active before the first agent response', async ({ page }) => {
  const sessionId = await startControlledStatusStream(page);
  await expect(taskRow(page, sessionId, 'active')).toBeVisible();
  await expect(folderRows(page, sessionId).first()).toHaveAttribute('data-id', sessionId);
  await expect(page.locator('.streaming-content')).toBeEmpty();
  // Metadata can arrive before the native send has returned its persisted prompt.
  await page.evaluate(async () => { const { refreshStatusTestSessions } = await import((window as any).__pandacodePreviewUrl); refreshStatusTestSessions(); });
  await expect(taskRow(page, sessionId, 'active')).toBeVisible();
});

test('a rejected first prompt leaves the new task unlisted and restores its text', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const body = source.replace(/case ["']send_message["']\s*:/, `$& await new Promise((_, reject) => { window.__rejectPrompt = () => reject(new Error('Provider unavailable')); });`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = (await prompt(page).getAttribute('data-session-id'))!;
  await prompt(page).fill('Preserve this rejected prompt');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(taskRow(page, sessionId, 'active')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__rejectPrompt)).toBe('function');
  await page.evaluate(() => { (window as any).__rejectPrompt(); });
  // Nothing was saved, so the new task goes back to an unlisted draft.
  await expect(taskRow(page, sessionId)).toHaveCount(0);
  await expect(prompt(page)).toHaveValue('Preserve this rejected prompt');
});

test('saved user prompts keep old threads active until their own 24 hour boundary', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    await route.fulfill({ response, body: previewBody(await response.text() + "\nexport const refreshActivity = () => emit('sessions-changed', {});") });
  });
  await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
  await page.reload();
  await expect(page.locator('.task-item[data-id="session-4"]')).toBeVisible();
  const sentAt = await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const { refreshActivity } = await import((window as any).__pandacodePreviewUrl);
    const time = Date.now();
    // An accepted prompt from another view uses native session metadata on refresh.
    await invoke('update_session', { sessionId: 'session-4', lastPromptAt: time });
    refreshActivity();
    return time;
  });
  await expect(taskRow(page, 'session-4', 'active')).toBeVisible();
  // The newest work leads: pandacode's folder now sits above orbit's.
  await expect(page.locator('#navigation .folder-group').first()).toHaveAttribute('data-project', 'project-2');
  await page.clock.pauseAt(sentAt + 24 * 60 * 60 * 1000 - 1);
  await expect(taskRow(page, 'session-4', 'active')).toBeVisible();
  await page.clock.fastForward(1);
  await expect(taskRow(page, 'session-4', 'inactive')).toBeVisible();
});

test('groups tasks into project folders and remembers a collapsed folder', async ({ page }) => {
  await expect(projectFilter(page)).toHaveText('All projects');
  const orbit = page.getByRole('region', { name: 'orbit tasks', exact: true });
  const pandacode = page.getByRole('region', { name: 'pandacode tasks', exact: true });
  await expect(orbit.locator('.task-title')).toHaveText(['Make search feel instant', 'Refine the navigation', 'Add keyboard shortcuts']);
  await expect(pandacode.locator('.task-title')).toHaveText(['Explore the project']);
  await expect(activeRows(page).locator('.task-title')).toHaveText(['Make search feel instant']);
  // The folder names the project; the row keeps it for assistive technology.
  await expect(taskRow(page, 'session-4').locator('.task-project')).toHaveText('pandacode');
  await expect(taskRow(page, 'session-4').locator('.task-project')).not.toBeInViewport();
  const toggle = pandacode.getByRole('button', { name: 'pandacode', exact: true });
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  await toggle.click();
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect(pandacode.locator('.task-item:visible')).toHaveCount(0);
  await expect(orbit.locator('.task-item:visible')).toHaveCount(3);
  await page.reload();
  await expect(page.getByRole('region', { name: 'pandacode tasks', exact: true }).getByRole('button', { name: 'pandacode', exact: true })).toHaveAttribute('aria-expanded', 'false');
  // Opening a task hidden in a collapsed folder opens that folder.
  await page.locator('.search-trigger').click();
  await page.getByRole('textbox', { name: 'Search tasks and commands', exact: true }).fill('Explore');
  await page.locator('#command-results [data-action="select-task"][data-id="session-4"]').click();
  await expect(taskRow(page, 'session-4')).toHaveAttribute('aria-current', 'page');
  await expect(pandacode.getByRole('button', { name: 'pandacode', exact: true })).toHaveAttribute('aria-expanded', 'true');
  await expect(taskRow(page, 'session-4')).toBeVisible();
});

test('moves a task to inactive automatically at the 24 hour response boundary', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-09-12T12:00:00Z') });
  await page.reload();
  await expect(taskRow(page, 'session-1', 'active')).toBeVisible();
  const expiresAt = await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const sessions = await invoke('list_sessions', {});
    return sessions.find((session: { id: string }) => session.id === 'session-1').lastResponseAt + 24 * 60 * 60 * 1000;
  });
  await page.clock.pauseAt(expiresAt - 1);
  await expect(taskRow(page, 'session-1', 'active')).toBeVisible();
  await page.clock.fastForward(1);
  await expect(taskRow(page, 'session-1', 'inactive')).toBeVisible();
  await expect(activeRows(page)).toHaveCount(0);
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
});

test('renaming and changing a model do not make an old response active', async ({ page }) => {
  await taskRow(page, 'session-4', 'inactive').click();
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  const renameAction = page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Rename task', exact: true });
  await expect(renameAction).toBeFocused();
  await renameAction.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Renamed older conversation');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(taskRow(page, 'session-4', 'inactive').locator('.task-title')).toHaveText('Renamed older conversation');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('review-old-response');
  await picker.getByRole('button', { name: 'Use "review-old-response" with Codex', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toHaveText('review-old-response');
  await expect(taskRow(page, 'session-4', 'inactive')).toBeVisible();
  await expect(activeRows(page).locator('.task-title')).toHaveText(['Make search feel instant']);
});

test('keeps an observed streaming response active when metadata reloads before persistence', async ({ page }) => {
  await page.clock.install();
  await page.reload();
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await prompt(page).fill('Stream while the response timestamp awaits persistence');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  // Assert the first chunk; the short preview can finish between phrase-length polls.
  await expect(page.locator('.streaming-content')).toContainText('This is');
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 1000));
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(page.locator('#navigation .task-item.selected[data-activity="active"]')).toBeVisible();
  const observedResponseAt = await page.evaluate(async () => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    const sessionId = document.querySelector<HTMLElement>('#prompt')!.dataset.sessionId;
    const sessions = await invoke('list_sessions', {});
    const responseAt = sessions.find((session: { id: string }) => session.id === sessionId).lastResponseAt;
    // Native streams can be visible before their buffered assistant text reaches SQLite.
    await invoke('update_session', { sessionId, lastResponseAt: null });
    return responseAt;
  });
  expect(observedResponseAt).toBeGreaterThan(0);
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  const actions = page.getByRole('dialog', { name: 'Task actions', exact: true });
  await expect(actions.getByRole('menuitem', { name: 'Pin task', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowDown');
  const renameAction = actions.getByRole('menuitem', { name: 'Rename task', exact: true });
  await expect(renameAction).toBeFocused();
  await renameAction.press('Enter');
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Task name', exact: true }).fill('Renamed while streaming');
  await dialog.getByRole('button', { name: 'Save', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('#navigation .task-item.selected[data-activity="active"] .task-title')).toHaveText('Renamed while streaming');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

test('filters projects and keeps the active project when returning to all projects', async ({ page }) => {
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('#navigation .task-title')).toHaveText(['Explore the project']);
  await expect(page.locator('#breadcrumb')).toContainText('pandacode');
  await chooseProjectFilter(page, 'All projects');
  await expect(page.locator('#navigation .task-item')).toHaveCount(4);
  await expect(page.locator('#breadcrumb')).toContainText('pandacode');
  await page.reload();
  await expect(projectFilter(page)).toHaveText('All projects');
  await expect(page.locator('#breadcrumb')).toContainText('pandacode');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(openTaskProject(page)).toHaveText('pandacode');
  await expect(projectFilter(page)).toHaveText('All projects');
});

test('removes the old project inspector actions while the new task history loads', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']get_messages["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$& if (args.sessionId === 'session-4') await new Promise(resolve => { window.__pandacodeReleaseMessages = resolve; });`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('.change-row')).toHaveCount(3);
  await page.locator('[data-action="open-diff"]').first().click();
  await expect(page.locator('.diff-viewer')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Stage file', exact: true })).toBeVisible();
  await chooseProjectFilter(page, 'pandacode');
  await page.waitForFunction(() => typeof (window as any).__pandacodeReleaseMessages === 'function');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Explore the project');
  await expect(page.locator('#inspector-content')).toContainText('Loading files…');
  await expect(page.getByRole('button', { name: 'Stage file', exact: true })).toHaveCount(0);
  await expect(page.locator('.diff-viewer,.change-row')).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pandacodeReleaseMessages(); delete (window as any).__pandacodeReleaseMessages; });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('.change-row')).toHaveCount(3);
  await expect(page.locator('#breadcrumb')).toContainText('pandacode');
});

test('renders provider logos in task rows, composer, picker, and settings', async ({ page }) => {
  await expect(page.locator('#composer .provider-logo[data-provider="claude"]')).toBeVisible();
  for (const provider of ['claude', 'codex', 'kimi']) {
    await expect(page.locator(`#navigation .provider-logo[data-provider="${provider}"]`).first()).toBeVisible();
  }
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  for (const provider of ['claude', 'codex', 'kimi', 'github-copilot']) {
    await expect(picker.locator(`.provider-logo[data-provider="${provider}"]`).first()).toBeVisible();
    await expect(picker.locator(`.model-menu-option .provider-logo[data-provider="${provider}"]`).first()).toBeVisible();
  }
  await page.keyboard.press('Escape');
  const settings = await openSettings(page, 'Agents');
  for (const provider of ['claude', 'codex', 'kimi', 'github-copilot']) {
    await expect(settings.locator(`.provider-diagnostic .provider-logo[data-provider="${provider}"]`)).toBeVisible();
  }
  await expect(settings.getByRole('button', { name: 'Default agent for new tasks', exact: true }).locator('.provider-logo[data-provider="claude"]')).toBeVisible();
  const logos = await page.locator('.provider-logo').evaluateAll(elements => elements.map(element => ({
    decorative: element.getAttribute('aria-hidden'),
    graphic: element.matches('svg,img') || Boolean(element.querySelector('svg,img')),
  })));
  expect(logos.length).toBeGreaterThan(6);
  expect(logos.every(logo => logo.decorative === 'true' && logo.graphic)).toBe(true);
});

test('a new task is listed after its first prompt and an untouched one is discarded', async ({ page }) => {
  const listed = () => page.evaluate(async () => { const { invoke } = await import((window as any).__pandacodePreviewUrl); return (await invoke('list_sessions', {})).map((task: any) => task.id); });
  const before = await listed();
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const draftId = await prompt(page).getAttribute('data-session-id');
  expect(draftId).toBeTruthy();
  expect(await listed()).toEqual(before);
  await expect(page.locator(`#navigation .task-item[data-id="${draftId}"]`)).toHaveCount(0);
  // Leaving an untouched draft discards it.
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  await expect.poll(async () => page.evaluate(async id => { const { invoke } = await import((window as any).__pandacodePreviewUrl); try { await invoke('get_task', { sessionId: id }); return 'kept'; } catch { return 'gone'; } }, draftId)).toBe('gone');
  // A draft with typed text stays hidden, and New task reopens it with the text.
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(prompt(page)).not.toHaveAttribute('data-session-id', 'session-2');
  const typedId = await prompt(page).getAttribute('data-session-id');
  await prompt(page).fill('Keep this idea');
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator(`#navigation .task-item[data-id="${typedId}"]`)).toHaveCount(0);
  await page.locator('.new-task-button').click();
  await expect(prompt(page)).toHaveAttribute('data-session-id', typedId!);
  await expect(prompt(page)).toHaveValue('Keep this idea');
  // The first prompt registers it.
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator(`#navigation .task-item[data-id="${typedId}"]`)).toBeVisible();
  await expect.poll(listed).toContain(typedId);
});

test('opens a new conversation in the active project without listing it', async ({ page }) => {
  const projectName = await page.locator('#breadcrumb').innerText();
  await page.locator('.new-task-button').click();
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('');
  await expect(page.locator('.user-message,.agent-message')).toHaveCount(0);
  await expect(page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true })).toHaveText(projectName.trim());
  // The draft opens immediately but is not a task until its first prompt.
  await expect(page.locator('#navigation .task-item.selected')).toHaveCount(0);
  await expect(page.locator('#navigation .task-item', { hasText: 'New conversation' })).toHaveCount(0);
  const mainBounds = (await page.getByRole('main').boundingBox())!;
  const headingBounds = (await newTaskHeading(page).boundingBox())!;
  const composerBounds = (await page.locator('#composer').boundingBox())!;
  expect(Math.abs(composerBounds.x + composerBounds.width / 2 - mainBounds.x - mainBounds.width / 2)).toBeLessThan(24);
  expect(Math.abs(headingBounds.x + headingBounds.width / 2 - mainBounds.x - mainBounds.width / 2)).toBeLessThan(24);
  expect(headingBounds.y).toBeGreaterThan(mainBounds.y + mainBounds.height * 0.2);
  expect(headingBounds.y + headingBounds.height).toBeLessThan(mainBounds.y + mainBounds.height * 0.65);
  expect(composerBounds.y - headingBounds.y - headingBounds.height).toBeGreaterThanOrEqual(0);
  expect(mainBounds.y + mainBounds.height - composerBounds.y - composerBounds.height).toBeGreaterThanOrEqual(0);
  expect(mainBounds.y + mainBounds.height - composerBounds.y - composerBounds.height).toBeLessThan(90);
  await expect(page.getByRole('button', { name: 'Change task project', exact: true })).toHaveCount(2);
  await page.screenshot({ path: '/private/tmp/pandacode-new-task.png' });
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.getByRole('button', { name: 'Claude Code · Default', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Codex · Default', exact: true })).toBeVisible();
  await expect(picker.getByRole('button', { name: 'Kimi Code · Default', exact: true })).toBeVisible();
  await page.screenshot({ path: '/private/tmp/pandacode-brand-picker.png' });
});

test('changes the empty task project while keeping its draft, harness, model, and identity', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /case ["']git_status["']\s*:/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `$& if (args.projectId === 'project-2') { result = { ...git, branch: 'test/pandacode-project' }; break; }`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('Keep this plan while I choose the right repository');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const modelPicker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await modelPicker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('project-switch-model');
  await modelPicker.getByRole('button', { name: 'Use "project-switch-model" with Kimi Code', exact: true }).click();
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'kimi', model: 'project-switch-model' });
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await page.locator('[data-action="open-diff"]').first().click();
  await expect(page.locator('.diff-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
  const picker = taskProjectPicker(page);
  await picker.getByRole('searchbox', { name: 'Search projects', exact: true }).fill('panda');
  await picker.getByRole('option', { name: /^pandacode — / }).click();
  await expect(picker).toHaveCount(0);
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in pandacode?');
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(openTaskProject(page)).toHaveText('pandacode');
  await expect(page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true })).toHaveText('pandacode');
  await expect(page.locator('.diff-viewer')).toHaveCount(0);
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toContainText('test/pandacode-project');
  await expect(prompt(page)).toHaveValue('Keep this plan while I choose the right repository');
  await expect(page.locator('#composer')).toContainText('project-switch-model');
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'kimi', model: 'project-switch-model' });
  await expect(page.locator('.user-message,.agent-message')).toHaveCount(0);
  await page.reload();
  expect(await page.evaluate(() => localStorage.getItem('pandacode.project'))).toBe('project-2');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in pandacode?');
});

test('searches task projects by keyboard and cancels or reselects without changing the task', async ({ page }) => {
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('A draft that stays with this empty task');
  const trigger = page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true });
  await trigger.click();
  const picker = taskProjectPicker(page);
  const search = picker.getByRole('searchbox', { name: 'Search projects', exact: true });
  await expect(search).toBeFocused();
  await expect(picker.getByRole('option', { name: /^orbit — / })).toHaveAttribute('aria-selected', 'true');
  await page.screenshot({ path: '/private/tmp/pandacode-project-picker.png' });
  await search.fill('panda');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await search.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  await expect(prompt(page)).toHaveValue('A draft that stays with this empty task');
  await trigger.click();
  await search.fill('/Users/you/Projects/orbit');
  await expect(picker.getByRole('option')).toHaveCount(1);
  await search.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  await expect(prompt(page)).toHaveValue('A draft that stays with this empty task');
  await trigger.click();
  await search.fill('panda');
  await search.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in pandacode?');
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(prompt(page)).toHaveValue('A draft that stays with this empty task');
});

test('opens a new folder from the task project picker without discarding its draft or task', async ({ page }) => {
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('Build this in the folder I am about to open');
  await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
  await taskProjectPicker(page).getByRole('button', { name: 'Open project…', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/tmp/new-task-folder');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(prompt(page)).toHaveValue('Build this in the folder I am about to open');
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(page.getByRole('button', { name: 'Change task project', exact: true }).first()).toBeFocused();
  await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
  await taskProjectPicker(page).getByRole('button', { name: 'Open project…', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/tmp/new-task-folder');
  await dialog.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in new-task-folder?');
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(openTaskProject(page)).toHaveText('new-task-folder');
  await expect(page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true })).toHaveText('new-task-folder');
  await expect(prompt(page)).toHaveValue('Build this in the folder I am about to open');
  await expect(page.locator('.user-message,.agent-message')).toHaveCount(0);
});

test('applies a delayed project switch after leaving and reselecting the same empty task', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const configureMarker = /case ["']configure_session["']\s*:/;
    const gitMarker = /case ["']git_status["']\s*:/;
    expect(source).toMatch(configureMarker);
    expect(source).toMatch(gitMarker);
    const body = source
      .replace(configureMarker, `$& if (args.projectId && window.__pandacodeDelayConfigure) await new Promise(resolve => { window.__pandacodeReleaseConfigure = resolve; });`)
      .replace(gitMarker, `$& if (args.projectId === 'project-2') { result = { ...git, branch: 'test/pandacode-project' }; break; }`);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  const sessionId = await draftTaskId(page);
  await prompt(page).fill('Retain this draft when I return before the project write finishes');
  await page.evaluate(() => { (window as any).__pandacodeDelayConfigure = true; });
  await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
  await taskProjectPicker(page).getByRole('option', { name: /^pandacode — / }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseConfigure)).toBe('function');
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Explore the project');
  // The draft keeps its typed text, so leaving hides it instead of discarding it.
  await expect(page.locator(`.task-item[data-id="${sessionId}"]`)).toHaveCount(0);
  await page.evaluate(() => {
    (window as any).__pandacodeDelayConfigure = false;
    (window as any).__pandacodeReleaseConfigure();
    delete (window as any).__pandacodeReleaseConfigure;
  });
  // The delayed switch still lands, so New task in pandacode reopens the same draft there.
  await page.locator('.new-task-button').click();
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(prompt(page)).toHaveValue('Retain this draft when I return before the project write finishes');
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in pandacode?');
  await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
  await expect(openTaskProject(page)).toHaveText('pandacode');
  await expect(page.locator('#composer-area').getByRole('button', { name: 'Change task project', exact: true })).toHaveText('pandacode');
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toContainText('test/pandacode-project');
  await expect(prompt(page)).toHaveValue('Retain this draft when I return before the project write finishes');
  const projectId = await page.evaluate(async sessionId => {
    const { invoke } = await import((window as any).__pandacodePreviewUrl);
    return (await invoke('get_task', { sessionId })).projectId;
  }, sessionId);
  expect(projectId).toBe('project-2');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.project'))).toBe('project-2');
});

for (const delayedCommand of ['add_project', 'list_projects']) {
  test(`ignores canceled task folder selection while ${delayedCommand} finishes behind Settings`, async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const marker = new RegExp(`case ["']${delayedCommand}["']\\s*:`);
      expect(source).toMatch(marker);
      const body = source.replace(marker, `$& if (window.__pandacodeDelayFolder) await new Promise(resolve => { window.__pandacodeReleaseFolder = resolve; });`);
      await route.fulfill({ response, body: previewBody(body) });
    });
    await page.reload();
    await page.locator('.new-task-button').click();
    await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
    const sessionId = await draftTaskId(page);
    await prompt(page).fill('Keep this task and draft after canceling its folder request');
    await page.getByRole('button', { name: 'Change task project', exact: true }).first().click();
    await taskProjectPicker(page).getByRole('button', { name: 'Open project…', exact: true }).click();
    const dialog = page.getByRole('dialog');
    await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/tmp/canceled-task-folder');
    await page.evaluate(() => { (window as any).__pandacodeDelayFolder = true; });
    await dialog.getByRole('button', { name: 'Open project', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseFolder)).toBe('function');
    await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
    const settings = await openSettings(page);
    await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Back to the workspace', exact: true })).toBeVisible();
    await page.evaluate(() => {
      const navigation = document.querySelector('#navigation')!;
      const observer = new MutationObserver(() => {
        (window as any).__pandacodeFolderNavigationUpdated = true;
        observer.disconnect();
      });
      observer.observe(navigation, { childList: true });
      (window as any).__pandacodeDelayFolder = false;
      (window as any).__pandacodeReleaseFolder();
      delete (window as any).__pandacodeReleaseFolder;
    });
    await expect.poll(() => page.evaluate(() => (window as any).__pandacodeFolderNavigationUpdated)).toBe(true);
    expect(await previewProjectNames(page)).toContain('canceled-task-folder');
    await expect(settings.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
    // The workspace behind the page is hidden from assistive technology, so read the composer directly.
    await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', sessionId!);
    await closeSettings(page);
    await expect(prompt(page)).toHaveAttribute('data-session-id', sessionId!);
    await expect(openTaskProject(page)).toHaveText('orbit');
    await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
    await expect(prompt(page)).toHaveValue('Keep this task and draft after canceling its folder request');
  });
}

for (const config of [
  { module: 'model-picker', trigger: 'Choose harness and model', dialog: 'Harness and model' },
  { module: 'project-picker', trigger: 'Change task project', dialog: 'Choose project' },
  { module: 'choice-menu', trigger: 'Filter projects', dialog: 'Filter projects' },
]) {
  for (const dismissal of ['Escape', 'outside pointer', 'same trigger']) {
    test(`dismisses the pending ${config.module} import with ${dismissal} without stealing focus`, async ({ page }) => {
      if (config.module === 'project-picker') {
        await page.locator('.new-task-button').click();
        await expect(newTaskHeading(page)).toBeVisible();
      }
      let releaseModule!: () => void;
      let markRequested!: () => void;
      const moduleGate = new Promise<void>(resolve => { releaseModule = resolve; });
      const moduleRequested = new Promise<void>(resolve => { markRequested = resolve; });
      await page.route(`**/src/${config.module}.ts*`, async route => {
        markRequested();
        await moduleGate;
        await route.continue();
      });
      const trigger = page.getByRole('button', { name: config.trigger, exact: true }).first();
      await trigger.click();
      await moduleRequested;
      if (dismissal === 'outside pointer') await prompt(page).click();
      else if (dismissal === 'same trigger') await trigger.click();
      else await page.keyboard.press('Escape');
      releaseModule();
      await page.evaluate(async module => {
        await import(`/src/${module}.ts`);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }, config.module);
      const menu = page.getByRole('dialog', { name: config.dialog, exact: true });
      await expect(menu).toHaveCount(0);
      await expect(page.locator('.floating-menu')).toHaveCount(0);
      await expect(dismissal === 'outside pointer' ? prompt(page) : trigger).toBeFocused();
      // Dismissing a pending request must not prevent the next explicit open.
      await trigger.click();
      await expect(menu).toHaveCount(1);
      await page.keyboard.press('Escape');
      await expect(menu).toHaveCount(0);
      await expect(trigger).toBeFocused();
    });
  }
}

test('restores the last active project and creates new conversations there', async ({ page }) => {
  await chooseProjectFilter(page, 'pandacode');
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Explore the project');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(projectFilter(page)).toHaveText('pandacode');
  await expect(openTaskProject(page)).toHaveText('pandacode');
  await page.reload();
  await expect(projectFilter(page)).toHaveText('pandacode');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in pandacode?');
  await expect(prompt(page)).toBeFocused();
});

test('chooses a harness and custom model inline without losing the draft, streams, and stops', async ({ page }) => {
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await prompt(page).fill('Check the streaming cancellation path');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker).toBeVisible();
  await picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('kimi-test-model');
  await picker.getByRole('button', { name: 'Use "kimi-test-model" with Kimi Code', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator('#composer .provider-logo[data-provider="kimi"]')).toBeVisible();
  await expect(page.locator('#composer')).toContainText('kimi-test-model');
  await expect(prompt(page)).toHaveValue('Check the streaming cancellation path');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(page.locator('.streaming-content')).toContainText('This is');
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect(prompt(page)).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
  await expect(page.locator('.user-message')).toContainText('Check the streaming cancellation path');
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'kimi', model: 'kimi-test-model' });
});

test('opens a project by path and preserves the selected task when canceled', async ({ page }) => {
  await prompt(page).fill('Keep this draft while choosing a project');
  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('heading', { name: 'Open project', exact: true })).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/tmp/canceled-project');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
  await expect(prompt(page)).toHaveValue('Keep this draft while choosing a project');
  expect(await previewProjectNames(page)).not.toContain('canceled-project');

  await page.getByRole('button', { name: 'Open project', exact: true }).click();
  await dialog.getByRole('textbox', { name: 'Project folder', exact: true }).fill('/tmp/pandacode-ui-project');
  await dialog.getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(dialog).not.toBeVisible();
  await expect.poll(() => previewProjectNames(page)).toContain('pandacode-ui-project');
  await expect(page.locator('#breadcrumb')).toContainText('pandacode-ui-project');
  await expect(page.getByRole('button', { name: 'Start a task', exact: true })).toBeVisible();
  await expect(page.locator('.task-item.selected')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Opened pandacode-ui-project');
});

test('retains a completed conversation and model when switching fixture tasks', async ({ page }) => {
  const history = await page.locator('.user-message,.agent-message').allTextContents();
  await prompt(page).fill('Remember this completed preview message');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).fill('review-model');
  await picker.getByRole('searchbox', { name: 'Search harnesses and models', exact: true }).press('Enter');
  await expect(picker).not.toBeVisible();
  await expect(prompt(page)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toHaveText('review-model');
  await expect(prompt(page)).toHaveValue('Remember this completed preview message');
  await expect(page.locator('.user-message,.agent-message')).toHaveText(history);
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.agent-message').last()).toContainText('no agent or shell is running here');
  await page.locator('.task-item').filter({ hasText: 'Refine the navigation' }).click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Refine the navigation');
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(page.locator('.user-message')).toHaveCount(0);
  await page.locator('.task-item').filter({ hasText: 'Make search feel instant' }).click();
  await expect(page.getByRole('button', { name: 'Choose harness and model', exact: true })).toHaveText('review-model');
  await expect(page.locator('.user-message').last()).toContainText('Remember this completed preview message');
  await expect(page.locator('.agent-message').last()).toContainText('no agent or shell is running here');
});

test('switches harness after the first message while preserving conversation and draft', async ({ page }) => {
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change task project', exact: true })).toHaveCount(2);
  await prompt(page).fill('Keep this conversation with the original harness');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Change task project', exact: true })).toHaveCount(0);
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.agent-message').last()).toContainText('no agent or shell is running here');
  await expect(page.getByRole('button', { name: 'Change task project', exact: true })).toHaveCount(0);
  await expect(openTaskProject(page)).toHaveText('orbit');
  await expect(page.locator('#navigation .task-item.selected[data-activity="active"]')).toBeVisible();
  await prompt(page).fill('A follow-up draft');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const picker = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(picker.getByText('Start a new task to switch harnesses.', { exact: true })).toHaveCount(0);
  await expect(picker.getByRole('button', { name: 'Kimi Code · Default', exact: true })).toBeEnabled();
  await picker.getByRole('button', { name: 'Codex · Default', exact: true }).click();
  await expect(picker).not.toBeVisible();
  await expect(page.locator('#composer .provider-logo[data-provider="codex"]')).toBeVisible();
  await expect(page.locator('.provider-handoff')).toContainText('Conversation carried forward');
  await expect(page.locator('.agent-message .message-meta strong').last()).toHaveText('Claude Code');
  await expect(prompt(page)).toHaveValue('A follow-up draft');
  await expect(page.locator('.user-message')).toContainText('Keep this conversation with the original harness');
  await expect(page.locator('.agent-message').last()).toContainText('no agent or shell is running here');
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'codex', model: 'default' });
});

test('browses a file and includes its contents as attached message context', async ({ page }) => {
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('[data-action="open-file"][data-path="package.json"]').click();
  await expect(page.locator('.code-preview')).toContainText('"name": "orbit"');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await expect(page.locator('#attachments')).toContainText('package.json');
  await prompt(page).fill('Explain this package configuration');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  const chip = page.locator('.user-message').last().locator('.message-attachments .prompt-chip');
  await expect(chip).toHaveText(/package\.json\s*Project file/);
  await chip.click();
  await expect(page.locator('#file-view')).toContainText('"name": "orbit"');
  await page.locator('#file-tabs').getByRole('tab', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('#attachments')).toBeEmpty();
  await expect(prompt(page)).toBeEnabled();
});

test('reviews a diff, stages changes, and commits within the sample session', async ({ page }) => {
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.getByRole('button', { name: 'Commit', exact: true })).toBeDisabled();
  await page.locator('[data-action="open-diff"]').first().click();
  await expect(page.locator('.diff-viewer')).toContainText('renderResults');
  await page.getByRole('button', { name: 'Stage file', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Unstage file', exact: true })).toHaveCount(1);
  await page.getByRole('button', { name: 'Stage all', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Commit 3 files', exact: true })).toBeEnabled();
  await page.getByRole('textbox', { name: 'Commit message', exact: true }).fill('Improve search responsiveness');
  await page.getByRole('button', { name: 'Commit 3 files', exact: true }).click();
  await expect(page.getByText('Working tree clean', { exact: true })).toBeVisible();
  await expect(page.locator('.change-row')).toHaveCount(0);
  await expect(page.locator('#toast')).toContainText('Preview commit created');
});

test('navigates the command palette using the keyboard', async ({ page }) => {
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill('Refine the navigation');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Refine the navigation');
  await expect(newTaskHeading(page)).toBeVisible();
  await page.keyboard.press('ControlOrMeta+k');
  await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill('Settings');
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog')).not.toBeVisible();
  await expect(settingsPage(page).getByRole('heading', { name: 'Settings', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(settingsPage(page)).toBeHidden();
});

test('keeps composer and navigation usable in a narrow desktop window', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 720 });
  await expect(prompt(page)).toBeVisible();
  await expect(page.locator('.new-task-button')).toBeVisible();
  const layout = await page.evaluate(() => {
    const composer = document.querySelector('#composer')!.getBoundingClientRect();
    const navigation = document.querySelector('.sidebar')!.getBoundingClientRect();
    return { width: innerWidth, scrollWidth: document.documentElement.scrollWidth, left: composer.left, right: composer.right, bottom: composer.bottom, sidebarRight: navigation.right, height: innerHeight };
  });
  expect(layout.scrollWidth).toBeLessThanOrEqual(layout.width);
  expect(layout.left).toBeGreaterThanOrEqual(layout.sidebarRight);
  expect(layout.right).toBeLessThanOrEqual(layout.width);
  expect(layout.bottom).toBeLessThanOrEqual(layout.height);
  await prompt(page).fill('Narrow window keyboard check');
  await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeEnabled();
});

test('agent Markdown cannot inject application actions, IDs, or forms', async ({ page }) => {
  const sanitized = await page.evaluate(async () => {
    const { markdown } = await import('/src/dom.ts');
    const target = document.createElement('div');
    document.querySelector('#transcript')!.append(target);
    await markdown(target, `Safe **content**.
<a id="commit-form" name="commit-message" data-action="stage-all" data-id="session-1" href="javascript:alert(1)" onclick="alert(1)">forged link</a>
<button data-action="archive-task">forged action</button>
<div data-action="open-file" data-path="secret.txt">forged file</div>
<form id="worktree-form"><input name="branch" value="injected"></form>
<script>throw new Error('injected script')</script>`);
    const result = {
      unsafeAttributes: target.querySelectorAll('[data-action],[data-id],[data-path],[id],[name],[onclick]').length,
      forbiddenElements: target.querySelectorAll('form,input,script,iframe').length,
      unsafeLinks: target.querySelectorAll('a[href^="javascript:"]').length,
      text: target.textContent,
      strong: target.querySelector('strong')?.textContent,
    };
    target.remove();
    return result;
  });
  expect(sanitized.unsafeAttributes).toBe(0);
  expect(sanitized.forbiddenElements).toBe(0);
  expect(sanitized.unsafeLinks).toBe(0);
  expect(sanitized.text).toContain('Safe content.');
  expect(sanitized.strong).toBe('content');
});

test('opens a visible terminal without relying on entrance animation', async ({ page }) => {
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  await expect(page.locator('#terminal-drawer')).toBeVisible();
  await expect(page.locator('#terminal-drawer .drawer-heading')).toBeVisible();
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  const rendering = await page.locator('#terminal-drawer').evaluate(element => {
    const style = getComputedStyle(element);
    return { opacity: style.opacity, animation: style.animationName, height: element.getBoundingClientRect().height };
  });
  expect(rendering.opacity).toBe('1');
  expect(rendering.animation).toBe('none');
  expect(rendering.height).toBeGreaterThan(150);
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await expect(page.locator('#terminal-drawer')).toBeHidden();
});

async function observeWorktreeCommands(page: Page, hook = ''): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `
      (window.__pandacodeWorktreeCalls ??= []).push({ command, args: structuredClone(args) });
      ${hook}
      switch (command) {
    `);
    await route.fulfill({ response, body: previewBody(body) });
  });
  await page.reload();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}

async function submitWorktree(page: Page, branch: string): Promise<void> {
  // The prompt bar's branch chip is the one worktree control; a started task spawns a sibling task.
  await page.locator('#branch-chip').click();
  await page.getByRole('dialog', { name: 'Branch and worktree', exact: true }).getByRole('menuitem', { name: /New task in a worktree/ }).click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill(branch);
  await dialog.getByRole('button', { name: 'Create worktree task', exact: true }).click();
}

const previewWorktreeTasks = (page: Page) => page.evaluate(async () => {
  const { invoke } = await import((window as any).__pandacodePreviewUrl);
  return (await invoke('list_sessions', {})).filter((session: { worktreePath?: string | null }) => session.worktreePath);
});

test('creates a worktree task under its original project with an icon and fresh approvals', async ({ page }) => {
  const projects = await previewProjectNames(page);
  await page.locator('#mode-picker-trigger').click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitemradio', { name: 'Full access', exact: true }).click();
  await expect.poll(() => savedPermission(page)).toBe('full');
  await prompt(page).fill('Keep this draft in the original checkout');
  await submitWorktree(page, 'codex/worktree-task');
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  const selected = page.locator('.task-item.selected');
  const taskId = await selected.getAttribute('data-id');
  expect(taskId).not.toBe('session-1');
  await expect(selected.locator('.task-title')).toHaveText('New conversation');
  await expect(selected.locator('.task-project')).toHaveText('orbit');
  await expect(selected.getByRole('img', { name: 'Worktree', exact: true })).toHaveClass(/task-worktree/);
  await expect(page.locator('.composer-local')).toHaveText('Worktree');
  await expect(page.locator('#composer-project')).toBeDisabled();
  await expect.poll(() => savedSelection(page)).toEqual({ provider: 'claude', model: 'sonnet' });
  await expect(page.locator('#mode-picker-trigger')).toHaveText('Full access');
  await expect(prompt(page)).toHaveValue('');
  expect(await previewProjectNames(page)).toEqual(projects);
  expect(await previewWorktreeTasks(page)).toEqual([expect.objectContaining({
    id: taskId, projectId: 'project-1', title: 'New conversation', provider: 'claude', model: 'sonnet', mode: 'full',
    worktreePath: expect.any(String), resumeId: null,
  })]);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(prompt(page)).toHaveValue('Keep this draft in the original checkout');
  await expect(page.locator('#mode-picker-trigger')).toHaveText('Full access');
  await page.locator(`.task-item[data-id="${taskId}"]`).click();
  await expect(page.locator('.task-item.selected .task-worktree')).toBeVisible();
  await expect(page.locator('.composer-local')).toHaveText('Worktree');
  await page.locator('.new-task-button').click();
  await expect(newTaskHeading(page)).toHaveAccessibleName('What should we build in orbit?');
  await expect(page.locator('.task-item.selected .task-worktree')).toHaveCount(0);
  await expect(page.locator('.composer-local')).toHaveText('Local');
  await expect(page.locator('#composer-project')).toBeEnabled();
  expect(await previewProjectNames(page)).toEqual(projects);
});

test('routes worktree files, Git, and terminals by task and retains each checkout terminal', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'git_status') return { ...git, branch: session(args.sessionId).worktreePath ? 'codex/worktree-routing' : 'main' };
    if (command === 'read_file') return JSON.stringify({ checkout: session(args.sessionId).worktreePath ? 'worktree' : 'root' });
  `);
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  await expect(page.locator('#terminal-host .xterm-screen:visible')).toBeVisible();
  await submitWorktree(page, 'codex/worktree-routing');
  await expect(newTaskHeading(page)).toBeVisible();
  const taskId = await page.locator('.task-item.selected').getAttribute('data-id');
  await expect(page.locator('#terminal-drawer')).toBeHidden();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeWorktreeCalls.filter((call: any) => call.command === 'close_terminal').length)).toBe(0);
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('#inspector-content')).toContainText('codex/worktree-routing');
  await page.locator('[data-action="open-diff"]').first().click();
  await expect(page.locator('.diff-viewer')).toBeVisible();
  await page.getByRole('button', { name: 'Files', exact: true }).click();
  await page.locator('[data-action="open-file"][data-path="package.json"]').click();
  await expect(page.locator('.code-preview')).toContainText('"checkout":"worktree"');
  await page.getByRole('button', { name: 'Attach', exact: true }).click();
  await prompt(page).fill('Read the package from this worktree');
  await page.getByRole('button', { name: 'Send message', exact: true }).click();
  await expect(page.locator('.user-message .message-attachments .prompt-chip')).toHaveText(/package\.json/);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  await expect(page.locator('#terminal-host .xterm-screen:visible')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__pandacodeWorktreeCalls);
  for (const command of ['git_status', 'list_files', 'git_diff', 'read_file', 'start_terminal']) {
    expect(calls).toContainEqual(expect.objectContaining({ command, args: expect.objectContaining({ projectId: 'project-1', sessionId: taskId }) }));
  }
  expect(calls.filter((call: any) => call.command === 'read_file' && call.args.sessionId === taskId)).toHaveLength(2);
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(page.locator('#terminal-drawer')).toBeVisible();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeWorktreeCalls.filter((call: any) => call.command === 'close_terminal').length)).toBe(0);
  await expect(page.locator('#terminal-host .xterm-screen:visible')).toBeVisible();
  const terminalCalls = await page.evaluate(() => (window as any).__pandacodeWorktreeCalls.filter((call: any) => call.command === 'start_terminal').map((call: any) => call.args.sessionId));
  expect(terminalCalls).toEqual(['session-1', taskId]);
});

test('clears worktree inspector actions immediately and ignores stale same-project responses', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'git_status') return git;
    if (command === 'get_messages' && args.sessionId === 'session-1' && window.__pandacodeDelayWorktreeHistory) {
      await new Promise(resolve => { window.__pandacodeReleaseWorktreeHistory = resolve; });
    }
    if (command === 'git_diff') {
      const checkout = session(args.sessionId).worktreePath ? 'worktree-snapshot' : 'root-stale-snapshot';
      if (window.__pandacodeDelayWorktreeDiff) {
        await new Promise(resolve => { window.__pandacodeReleaseWorktreeDiff = resolve; });
        window.__pandacodeWorktreeDiffFinished = true;
      }
      return ['diff --git a/check.txt b/check.txt', '--- a/check.txt', '+++ b/check.txt', '@@ -1 +1 @@', '-previous', '+' + checkout, ''].join('\\n');
    }
  `);
  await submitWorktree(page, 'codex/worktree-races');
  await expect(newTaskHeading(page)).toBeVisible();
  const taskId = await page.locator('.task-item.selected').getAttribute('data-id');
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await page.locator('[data-action="open-diff"]').first().click();
  await expect(page.locator('.diff-viewer')).toBeVisible();
  await page.evaluate(() => { (window as any).__pandacodeDelayWorktreeHistory = true; });
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseWorktreeHistory)).toBe('function');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect(page.locator('.diff-viewer,.change-row')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Stage file', exact: true })).toHaveCount(0);
  await page.evaluate(() => { (window as any).__pandacodeDelayWorktreeHistory = false; (window as any).__pandacodeReleaseWorktreeHistory(); });
  await expect(page.locator('.change-row')).toHaveCount(3);
  await expect(page.getByRole('complementary', { name: 'Project inspector' })).toBeVisible();
  await page.evaluate(() => { (window as any).__pandacodeDelayWorktreeDiff = true; });
  await page.locator('[data-action="open-diff"]').first().click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseWorktreeDiff)).toBe('function');
  await page.evaluate(() => { (window as any).__pandacodeDelayWorktreeDiff = false; });
  await page.locator(`.task-item[data-id="${taskId}"]`).click();
  await expect(newTaskHeading(page)).toBeVisible();
  await expect(page.locator('.diff-viewer')).toBeVisible();
  await expect(page.locator('.diff-viewer')).toContainText('worktree-snapshot');
  await page.evaluate(() => { (window as any).__pandacodeReleaseWorktreeDiff(); });
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeWorktreeDiffFinished)).toBe(true);
  await expect(page.locator('.diff-viewer')).toContainText('worktree-snapshot');
  await expect(page.locator('.diff-viewer')).not.toContainText('root-stale-snapshot');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', taskId!);
});

test('keeps delayed worktree creation with its original task without stealing navigation', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'create_worktree') await new Promise(resolve => { window.__pandacodeReleaseWorktree = resolve; });
  `);
  const projects = await previewProjectNames(page);
  await submitWorktree(page, 'codex/worktree-delayed');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseWorktree)).toBe('function');
  await page.locator('#dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  await page.locator('.task-item[data-id="session-4"]').click();
  await prompt(page).fill('Keep the other project active');
  await page.evaluate(() => { (window as any).__pandacodeReleaseWorktree(); });
  await expect.poll(() => previewWorktreeTasks(page)).toHaveLength(1);
  await expect(page.locator('#navigation .task-worktree')).toHaveCount(1);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
  await expect(page.locator('#breadcrumb')).toContainText('pandacode');
  await expect(prompt(page)).toHaveValue('Keep the other project active');
  expect(await previewProjectNames(page)).toEqual(projects);
  expect((await previewWorktreeTasks(page))[0]).toMatchObject({ projectId: 'project-1', provider: 'claude', model: 'sonnet' });
  const request = await page.evaluate(() => (window as any).__pandacodeWorktreeCalls.find((call: any) => call.command === 'create_worktree'));
  expect(request.args).toMatchObject({ sessionId: 'session-1', branch: 'codex/worktree-delayed' });
});

test('does not dismiss Settings when canceled worktree creation finishes', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'create_worktree') await new Promise(resolve => { window.__pandacodeReleaseWorktree = resolve; });
  `);
  await prompt(page).fill('Keep the original task draft');
  await submitWorktree(page, 'codex/worktree-canceled');
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeReleaseWorktree)).toBe('function');
  await page.locator('#dialog').getByRole('button', { name: 'Cancel', exact: true }).click();
  const settings = await openSettings(page);
  await page.evaluate(() => { (window as any).__pandacodeReleaseWorktree(); });
  await expect(page.locator('#navigation .task-worktree')).toHaveCount(1);
  await expect(settings).toBeVisible();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await closeSettings(page);
  await expect(prompt(page)).toHaveValue('Keep the original task draft');
});

test('keeps the original task and projects when worktree creation fails', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'create_worktree') throw new Error('A branch with this name already exists.');
  `);
  const projects = await previewProjectNames(page);
  await prompt(page).fill('Do not discard this draft after a Git error');
  await submitWorktree(page, 'codex/worktree-exists');
  const dialog = page.locator('#dialog');
  await expect(dialog).toBeVisible();
  await expect(page.getByText('A branch with this name already exists.', { exact: true })).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Create worktree task', exact: true })).toBeEnabled();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(page.locator('#navigation .task-item')).toHaveCount(4);
  expect(await previewProjectNames(page)).toEqual(projects);
  expect(await previewWorktreeTasks(page)).toEqual([]);
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(prompt(page)).toHaveValue('Do not discard this draft after a Git error');
});

test('keeps the worktree terminal open when the previous checkout terminal fails to start late', async ({ page }) => {
  await observeWorktreeCommands(page, `
    if (command === 'start_terminal' && args.sessionId === 'session-1') {
      await new Promise((resolve, reject) => {
        window.__pandacodeRejectOldTerminal = () => reject(new Error('The old checkout terminal failed to start.'));
      });
    }
  `);
  await submitWorktree(page, 'codex/worktree-terminal-race');
  await expect(newTaskHeading(page)).toBeVisible();
  const taskId = await page.locator('.task-item.selected').getAttribute('data-id');
  await page.locator('.task-item[data-id="session-1"]').click();
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__pandacodeRejectOldTerminal)).toBe('function');
  await page.locator(`.task-item[data-id="${taskId}"]`).click();
  await expect(page.locator('#terminal-drawer')).toBeHidden();
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  await expect(page.locator('#terminal-host .xterm-screen:visible')).toBeVisible();
  await page.evaluate(() => {
    (window as any).__pandacodeCurrentTerminal = document.querySelector('#terminal-host .terminal-tab-surface:not([hidden]) .xterm-screen');
    (window as any).__pandacodeRejectOldTerminal();
  });
  await expect(page.locator('#terminal-drawer')).toBeVisible();
  await expect(page.locator('#terminal-host .xterm-screen:visible')).toBeVisible();
  expect(await page.evaluate(() => (window as any).__pandacodeCurrentTerminal === document.querySelector('#terminal-host .terminal-tab-surface:not([hidden]) .xterm-screen'))).toBe(true);
  expect(await page.evaluate(() => (window as any).__pandacodeWorktreeCalls.filter((call: any) => call.command === 'close_terminal'))).toEqual([]);
  await expect(page.getByText('The old checkout terminal failed to start.', { exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Close terminal', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__pandacodeWorktreeCalls.filter((call: any) => call.command === 'close_terminal').length)).toBe(1);
});

test('the interface is instant: no transitions, no entrance motion, and presses keep a button in place', async ({ page }) => {
  await page.locator('.sidebar-projects').getByRole('button', { name: 'Open project', exact: true }).click();
  await expect(page.locator('#dialog')).toBeVisible();
  // The modal is fully there at once: nothing is animating it in.
  expect(await page.evaluate(() => document.getAnimations().filter(animation => animation.playState === 'running').length)).toBe(0);
  await expect(page.locator('.dialog-plate')).toHaveCSS('opacity', '1');
  await expect(page.locator('#dialog .primary-button')).toHaveCSS('transition-duration', '0s');
  await page.keyboard.press('Escape');
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(page.locator('.dialog-plate')).toBeHidden();
  // Press feedback uses `scale`, so a button positioned by `transform` stays put while pressed.
  const send = page.locator('#composer .send-button');
  const before = await send.evaluate(el => getComputedStyle(el).transform);
  const box = (await send.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  expect(await send.evaluate(el => getComputedStyle(el).transform)).toBe(before);
  await page.mouse.up();
});

test('switching back to a thread draws it at once: formatted, at the bottom, with no loading frame', async ({ page }) => {
  const transcript = page.locator('#transcript');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(transcript.locator('.message').first()).toBeVisible();
  await page.locator('.task-item[data-id="session-2"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await expect(transcript.locator('.history-notice')).toHaveCount(0);
  // Record every frame right after the click: the remembered thread must already be final.
  const frames = await page.evaluate(() => new Promise<Array<{ loading: boolean; bottom: boolean; raw: boolean; messages: number }>>(resolve => {
    const transcript = document.querySelector<HTMLElement>('#transcript')!;
    const seen: Array<{ loading: boolean; bottom: boolean; raw: boolean; messages: number }> = [];
    const sample = () => seen.push({
      loading: Boolean(transcript.querySelector('.history-notice')),
      bottom: transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 2,
      // Raw Markdown is plain text with no element children while the parser runs.
      raw: [...transcript.querySelectorAll('[data-markdown]')].some(node => node.childElementCount === 0 && (node.textContent ?? '').length > 0),
      messages: transcript.querySelectorAll('.message').length,
    });
    document.querySelector<HTMLElement>('.task-item[data-id="session-1"]')!.click();
    sample();
    let count = 0;
    const tick = () => { sample(); if (++count < 8) requestAnimationFrame(tick); else resolve(seen); };
    requestAnimationFrame(tick);
  }));
  expect(frames.every(frame => !frame.loading && frame.bottom && !frame.raw && frame.messages > 0)).toBe(true);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
});

test('⌘F finds text in the thread, in your messages and the agent’s, and steps through matches', async ({ page }) => {
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(page.locator('#transcript .user-message').first()).toBeVisible();
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('search');
  const input = find.getByRole('searchbox', { name: 'Find in thread', exact: true });
  await expect(input).toBeFocused();
  await input.fill('search');
  const count = find.locator('.thread-find-count');
  await expect(count).toHaveText(/^1 of \d+$/);
  const total = Number((await count.textContent())!.split(' of ')[1]);
  expect(total).toBeGreaterThan(1);
  // Matches come from both sides of the conversation, highlighted without touching the DOM.
  const owners = await page.evaluate(() => {
    const all = (CSS as any).highlights.get('thread-find');
    return [...all].map((range: Range) => range.startContainer.parentElement!.closest('.message')!.classList.contains('user-message') ? 'user' : 'agent');
  });
  expect(owners).toContain('user'); expect(owners).toContain('agent');
  expect(await page.evaluate(() => (CSS as any).highlights.get('thread-find-current').size)).toBe(1);
  await input.press('Enter');
  await expect(count).toHaveText(`2 of ${total}`);
  await input.press('Shift+Enter');
  await expect(count).toHaveText(`1 of ${total}`);
  await input.press('Shift+Enter');
  await expect(count).toHaveText(`${total} of ${total}`);
  await page.keyboard.press('ControlOrMeta+g');
  await expect(count).toHaveText(`1 of ${total}`);
  await input.fill('zzqqxx-not-here');
  await expect(count).toHaveText('No results');
  await input.press('Escape');
  await expect(find).toHaveCount(0);
  expect(await page.evaluate(() => (CSS as any).highlights.has('thread-find'))).toBe(false);
  await expect(page.locator('#prompt')).toBeFocused();
});

test('the prompt sits in the same place in every thread', async ({ page }) => {
  await expect(page.locator('#composer')).toBeVisible();
  const bottoms: number[] = [];
  const measure = async () => { await expect(page.locator('#composer')).toBeVisible(); bottoms.push(Math.round((await page.locator('#composer').boundingBox())!.y + (await page.locator('#composer').boundingBox())!.height)); };
  const ids = await page.locator('#navigation .task-item').evaluateAll(rows => rows.map(row => (row as HTMLElement).dataset.id!));
  expect(ids.length).toBeGreaterThan(1);
  for (const id of ids) {
    await page.locator(`#navigation .task-item[data-id="${id}"]`).click();
    await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', id);
    await expect(page.locator('#transcript .history-notice')).toHaveCount(0);
    await measure();
  }
  // A brand-new task, which has no context count yet, lines up too.
  await page.keyboard.press('ControlOrMeta+n');
  await expect(page.locator('.new-task-welcome')).toBeVisible();
  await measure();
  expect(new Set(bottoms).size, `prompt bottoms: ${bottoms.join(', ')}`).toBe(1);
});

test('streaming keeps the transcript at the bottom after sending and leaves a reader who scrolled up', async ({ page }) => {
  await installHistoryFixture(page, 30);
  const transcript = page.locator('#transcript');
  const reply = page.locator('#transcript .agent-message .message-content', { hasText: 'connects to the CLI tools' });
  // A multi-line draft grows the composer; sending shrinks it again while the reply streams in.
  await prompt(page).fill('Line one\nLine two\nLine three\nLine four');
  await transcript.evaluate(element => {
    const gaps: number[] = (window as any).__bottomGaps = [];
    // Sample after each paint: the transcript re-pins between layout and paint, never visibly later.
    const sample = () => { gaps.push(element.scrollHeight - element.scrollTop - element.clientHeight); requestAnimationFrame(() => setTimeout(sample)); };
    sample();
  });
  await prompt(page).press('Enter');
  await expect(reply).toHaveCount(1);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0);
  expect(Math.max(...await page.evaluate(() => (window as any).__bottomGaps.slice(1) as number[]))).toBeLessThanOrEqual(2);
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);

  await prompt(page).fill('Second message');
  await prompt(page).press('Enter');
  await expect(page.locator('#stream-region .live-text')).not.toBeEmpty();
  await transcript.hover();
  await page.mouse.wheel(0, -300);
  await expect.poll(() => transcript.evaluate(element => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeGreaterThan(100);
  const anchor = page.locator('#transcript [data-message-id="566"]');
  const anchorY = await historyOffset(anchor);
  await expect(reply).toHaveCount(2);
  await expect(page.locator('#stream-region .live-message')).toHaveCount(0);
  expect(Math.abs(await historyOffset(anchor) - anchorY)).toBeLessThan(2);
});

test('shows a folder’s new-task button on focus and hover and starts a task in that project', async ({ page }) => {
  const second = page.locator('#navigation .folder-group').nth(1);
  const name = (await second.locator('.folder-heading span').last().textContent())!;
  const add = second.locator('.folder-new-task');
  await expect(add).toHaveCSS('opacity', '0');
  await add.focus();
  await expect(add).toHaveCSS('opacity', '1');
  await page.mouse.move(0, 0);
  await add.blur();
  await second.locator('.folder-row').hover();
  await expect(add).toHaveCSS('opacity', '1');
  await add.click();
  await expect(newTaskHeading(page)).toHaveAccessibleName(`What should we build in ${name}?`);
  // The heading itself still only folds the project's tasks.
  const heading = second.locator('.folder-heading');
  const expanded = await heading.getAttribute('aria-expanded');
  await heading.click();
  await expect(heading).toHaveAttribute('aria-expanded', expanded === 'true' ? 'false' : 'true');
  await expect(newTaskHeading(page)).toHaveAccessibleName(`What should we build in ${name}?`);
});
