import { expect, test, type Page } from '@playwright/test';

const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const separator = (page: Page) => page.getByRole('separator', { name: 'Resize sidebar', exact: true });
const sidebarWidth = (page: Page) => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width);
const storedWidth = (page: Page) => page.evaluate(() => localStorage.getItem('pandacode.sidebarWidth'));
const storedScale = (page: Page) => page.evaluate(() => localStorage.getItem('pandacode.uiScale'));
const rootSize = (page: Page) => page.locator('html').evaluate(node => parseFloat(getComputedStyle(node).fontSize));
const inspectorSeparator = (page: Page) => page.getByRole('separator', { name: 'Resize right sidebar', exact: true });
const inspectorWidth = (page: Page) => page.locator('#inspector').evaluate(node => node.getBoundingClientRect().width);
const storedInspectorWidth = (page: Page) => page.evaluate(() => localStorage.getItem('pandacode.inspectorWidth'));

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.task-item.selected')).toBeVisible();
}

for (const [platform, modifier, key] of [['MacIntel', '⌘', 'Meta'], ['Win32', 'Ctrl', 'Control'], ['Linux x86_64', 'Ctrl', 'Control']]) {
  test(`layout preferences use platform shortcuts for ${platform}`, async ({ page }) => {
    await page.addInitScript(platform => Object.defineProperty(navigator, 'platform', {get: () => platform}), platform);
    await open(page);
    await expect(page.locator('.new-task-button kbd')).toHaveText(`${modifier} N`);
    await expect(page.locator('.search-trigger kbd')).toHaveText(`${modifier} K`);
    await expect(page.locator('[data-action="terminal"]').first()).toHaveAttribute('title', `Toggle terminal (${modifier} J)`);
    await expect(page.locator('.send-button')).toHaveAttribute('title', `Send message (${modifier} Enter)`);
    await page.keyboard.press(`${key}+b`);
    await expect(page.locator('.workspace')).toHaveClass(/sidebar-collapsed/);
    if (platform !== 'MacIntel') {
      await expect(page.locator('html')).not.toHaveAttribute('data-native-platform', 'macos');
      expect(await page.locator('.workspace-header').evaluate(node => parseFloat(getComputedStyle(node).paddingLeft))).toBeLessThan(80);
    }
    await page.keyboard.press(`${key}+b`);
    await expect(page.locator('.workspace')).not.toHaveClass(/sidebar-collapsed/);
    const previous = await prompt(page).getAttribute('data-session-id');
    await page.keyboard.press(`${key}+n`);
    await expect(prompt(page)).not.toHaveAttribute('data-session-id', previous!);
    await expect(prompt(page)).toBeEnabled();
    await page.keyboard.press(`${key}+,`);
    const settings = page.getByRole('region', {name:'Settings', exact:true});
    await expect(settings).toBeVisible();
    await expect(page.locator('.text-size-setting')).toContainText(`${modifier} + / −`);
    await settings.getByRole('tab', {name:'About & updates', exact:true}).click();
    await expect(page.locator('.settings-about')).toContainText('Releases');
  });
}

async function dragSidebar(page: Page, targetWidth: number): Promise<void> {
  const handle = await separator(page).boundingBox();
  const sidebar = await page.locator('.sidebar').boundingBox();
  expect(handle).not.toBeNull();
  expect(sidebar).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + handle!.width / 2 + targetWidth - sidebar!.width, handle!.y + handle!.height / 2, { steps: 6 });
  await page.mouse.up();
}

async function openInspector(page: Page): Promise<void> {
  if (!await page.locator('#inspector').isVisible()) await page.locator('#inspector-toggle').click();
  await expect(inspectorSeparator(page)).toBeVisible();
}

async function dragInspector(page: Page, targetWidth: number): Promise<void> {
  const handle = (await inspectorSeparator(page).boundingBox())!;
  const width = await inspectorWidth(page);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 + width - targetWidth, handle.y + handle.height / 2, { steps: 6 });
  await page.mouse.up();
}

async function recordTerminalCalls(page: Page): Promise<void> {
  await page.addInitScript(() => { (window as any).__layoutTerminalCalls = []; });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      if (['start_terminal', 'resize_terminal', 'write_terminal', 'close_terminal'].includes(command)) {
        window.__layoutTerminalCalls.push({ command, args });
      }
      switch (command) {
    `) });
  });
}

test('layout preferences resize the sidebar while dragging and retain the draft and thread nodes', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Keep this draft while I resize the sidebar.');
  const originalPrompt = await prompt(page).elementHandle();
  const originalTranscript = await page.locator('#transcript').elementHandle();
  const originalWidth = await sidebarWidth(page);
  const handle = await separator(page).boundingBox();
  expect(handle).not.toBeNull();
  await page.mouse.move(handle!.x + handle!.width / 2, handle!.y + handle!.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle!.x + 55, handle!.y + handle!.height / 2, { steps: 5 });
  await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(originalWidth + 40);
  await page.mouse.move(handle!.x + 100, handle!.y + handle!.height / 2, { steps: 5 });
  await expect.poll(() => sidebarWidth(page)).toBeGreaterThan(originalWidth + 85);
  await page.mouse.up();
  await expect(prompt(page)).toHaveValue('Keep this draft while I resize the sidebar.');
  expect(await originalPrompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await originalTranscript!.evaluate(node => node === document.querySelector('#transcript'))).toBe(true);
  const width = await sidebarWidth(page);
  expect(Number(await storedWidth(page))).toBeCloseTo(width, 0);
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(width, 0);
});

test('layout preferences sidebar resizing supports keyboard limits and double-click reset', async ({ page }) => {
  await open(page);
  const initial = await sidebarWidth(page);
  await separator(page).focus();
  await page.keyboard.press('ArrowRight');
  const oneStep = await sidebarWidth(page);
  expect(oneStep).toBeGreaterThan(initial);
  await page.keyboard.press('Shift+ArrowRight');
  expect(await sidebarWidth(page) - oneStep).toBeGreaterThan(oneStep - initial);
  await page.keyboard.press('Home');
  await expect.poll(() => sidebarWidth(page)).toBe(190);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '190');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => sidebarWidth(page)).toBe(190);
  await page.keyboard.press('End');
  await expect.poll(() => sidebarWidth(page)).toBe(440);
  await expect(separator(page)).toHaveAttribute('aria-valuenow', '440');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => sidebarWidth(page)).toBe(440);
  await separator(page).dblclick();
  await expect.poll(() => sidebarWidth(page)).toBe(initial);
  expect(await storedWidth(page)).toBeNull();
});

test('layout preferences retain the chosen width through narrow windows and the board view', async ({ page }) => {
  await open(page);
  await dragSidebar(page, 420);
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(420, 0);
  const stored = await storedWidth(page);
  await page.setViewportSize({ width: 700, height: 900 });
  await expect.poll(() => sidebarWidth(page)).toBeLessThan(420);
  expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(190);
  expect(await storedWidth(page)).toBe(stored);
  await page.setViewportSize({ width: 620, height: 900 });
  await expect(separator(page)).toBeHidden();
  expect(await storedWidth(page)).toBe(stored);
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(420, 0);
  await page.getByRole('button', { name: 'Board view', exact: true }).click();
  await expect(separator(page)).toBeHidden();
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.getByRole('button', { name: 'Conversation view', exact: true }).click();
  await expect(separator(page)).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBeCloseTo(420, 0);
  expect(await storedWidth(page)).toBe(stored);
});

test('layout preferences support Mac and Control text shortcuts without consuming typed punctuation', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Draft');
  await prompt(page).press('End');
  await page.keyboard.type(' +=-0');
  await expect(prompt(page)).toHaveValue('Draft +=-0');
  await expect.poll(() => rootSize(page)).toBe(14);
  const node = await prompt(page).elementHandle();
  await page.keyboard.press('Meta+=');
  await expect.poll(() => rootSize(page)).toBeCloseTo(15.4, 2);
  await page.keyboard.press('Control+Shift+=');
  await expect.poll(() => rootSize(page)).toBeCloseTo(16.8, 2);
  await page.keyboard.press('Meta+-');
  await expect.poll(() => rootSize(page)).toBeCloseTo(15.4, 2);
  await page.keyboard.press('Control+0');
  await expect.poll(() => rootSize(page)).toBe(14);
  await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('Draft +=-0');
  expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
});

test('layout preferences clamp text scaling and restore the saved size after reload', async ({ page }) => {
  await open(page);
  await prompt(page).focus();
  for (let step = 0; step < 9; step++) await page.keyboard.press('Control+=');
  await expect.poll(() => rootSize(page)).toBeCloseTo(22.4, 2);
  expect(Number(await storedScale(page))).toBe(1.6);
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await expect.poll(() => rootSize(page)).toBeCloseTo(22.4, 2);
  for (let step = 0; step < 12; step++) await page.keyboard.press('Meta+-');
  await expect.poll(() => rootSize(page)).toBeCloseTo(11.2, 2);
  expect(Number(await storedScale(page))).toBe(.8);
  await page.keyboard.press('Meta+0');
  await expect.poll(() => rootSize(page)).toBe(14);
});

test('layout preferences offer text size controls in Settings without replacing the page', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const row = settings.locator('.setting-row').filter({ hasText: 'Interface size' });
  await expect(row).toBeVisible();
  const node = await row.elementHandle();
  await expect(row.getByText('100%', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Increase interface size', exact: true }).click();
  await expect(row.getByText('110%', { exact: true })).toBeVisible();
  await expect.poll(() => rootSize(page)).toBeCloseTo(15.4, 2);
  await settings.getByRole('button', { name: 'Decrease interface size', exact: true }).click();
  await expect(row.getByText('100%', { exact: true })).toBeVisible();
  await settings.getByRole('button', { name: 'Increase interface size', exact: true }).click();
  await settings.getByRole('button', { name: 'Reset interface size', exact: true }).click();
  await expect(row.getByText('100%', { exact: true })).toBeVisible();
  expect(await node!.evaluate(node => node.isConnected)).toBe(true);
  await page.keyboard.press('Meta+=');
  await expect(row.getByText('110%', { exact: true })).toBeVisible();
});

test('layout preferences leave an open model menu and its search focus stable when text grows', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Do not lose this draft.');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  const search = menu.locator('.model-menu-search input');
  await search.fill('Claude');
  const menuNode = await menu.elementHandle();
  const promptNode = await prompt(page).elementHandle();
  const before = await search.evaluate(node => parseFloat(getComputedStyle(node).fontSize));
  await page.keyboard.press('Meta+=');
  await expect.poll(() => search.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(before * 1.1, 2);
  await expect(menu).toBeVisible();
  await expect(search).toBeFocused();
  await expect(search).toHaveValue('Claude');
  await expect(prompt(page)).toHaveValue('Do not lose this draft.');
  expect(await menuNode!.evaluate(node => node.isConnected)).toBe(true);
  expect(await promptNode!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  const bounds = await menu.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.y).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(1440);
  expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(940);
});

test('layout preferences ignore corrupt stored dimensions and still accept new choices', async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.sidebarWidth', 'not-a-width');
    localStorage.setItem('pandacode.uiScale', 'not-a-scale');
  });
  await open(page);
  await expect.poll(() => rootSize(page)).toBe(14);
  expect(await sidebarWidth(page)).toBeGreaterThanOrEqual(190);
  expect(await sidebarWidth(page)).toBeLessThanOrEqual(440);
  await separator(page).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => sidebarWidth(page)).toBe(190);
  expect(Number(await storedWidth(page))).toBe(190);
  await page.keyboard.press('Meta+=');
  await expect.poll(() => rootSize(page)).toBeCloseTo(15.4, 2);
  expect(Number(await storedScale(page))).toBe(1.1);
});

test('layout preferences resize focused terminal text without restarting the PTY or sending shortcut input', async ({ page }) => {
  await recordTerminalCalls(page);
  await open(page);
  await prompt(page).fill('Keep the agent draft while resizing terminal text.');
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  const screen = page.locator('#terminal-host .xterm-screen');
  const row = screen.locator('.xterm-rows > div').first();
  const input = page.locator('#terminal-host .xterm-helper-textarea');
  await expect(screen).toBeVisible();
  await expect(input).toBeFocused();
  await expect(row).toBeVisible();
  const node = await screen.elementHandle();
  const before = await row.evaluate(node => ({
    height: node.getBoundingClientRect().height,
    fontSize: parseFloat(getComputedStyle(node).fontSize),
  }));
  expect(before.fontSize).toBe(12);
  const initialColumns = await page.evaluate(() => (window as any).__layoutTerminalCalls.find((call: any) => call.command === 'start_terminal').args.cols);
  await page.keyboard.press('Control+=');
  await page.keyboard.press('Meta+=');
  await expect.poll(() => rootSize(page)).toBeCloseTo(16.8, 2);
  expect(Number(await storedScale(page))).toBe(1.2);
  await expect.poll(() => row.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(14.4, 2);
  await expect.poll(() => row.evaluate(node => node.getBoundingClientRect().height)).toBeGreaterThan(before.height);
  await expect.poll(() => page.evaluate(() => (window as any).__layoutTerminalCalls.filter((call: any) => call.command === 'resize_terminal').at(-1)?.args.cols)).toBeLessThan(initialColumns);
  const calls = await page.evaluate(() => (window as any).__layoutTerminalCalls);
  expect(calls.filter((call: any) => call.command === 'start_terminal')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'close_terminal' || call.command === 'write_terminal')).toEqual([]);
  expect(await node!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  await expect(input).toBeFocused();
  await expect(prompt(page)).toHaveValue('Keep the agent draft while resizing terminal text.');
  await page.keyboard.type('+-0');
  await expect.poll(() => page.evaluate(() => (window as any).__layoutTerminalCalls.filter((call: any) => call.command === 'write_terminal').map((call: any) => call.args.data).join(''))).toBe('+-0');
  await expect.poll(() => rootSize(page)).toBeCloseTo(16.8, 2);
});

test('layout preferences keep controls readable at 160 percent in wide and narrow windows', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.uiScale', '1.6');
    localStorage.setItem('pandacode.sidebarWidth', '190');
  });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /name:\s*["']orbit["']/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, 'name: "A project with a deliberately long name for narrow windows"') });
  });
  await open(page);
  for (const width of [1440, 760]) {
    await page.setViewportSize({ width, height: 940 });
    const inspector = page.getByRole('complementary', { name: 'Project inspector', exact: true });
    // The narrow-window media callback closes the inspector asynchronously in WebKit.
    if (width <= 920) await expect(inspector).toBeHidden();
    if (!await inspector.isVisible()) await page.getByRole('button', { name: 'Toggle inspector (⌘ ⇧ B)', exact: true }).click();
    await expect(inspector).toBeVisible();
    await expect.poll(() => rootSize(page)).toBeCloseTo(22.4, 2);
    await expect.poll(() => sidebarWidth(page)).toBe(190);
    const breadcrumb = await page.locator('.breadcrumb').boundingBox();
    const actions = await page.locator('.header-actions').boundingBox();
    const header = await page.locator('.workspace-header').boundingBox();
    expect(breadcrumb).not.toBeNull();
    expect(actions).not.toBeNull();
    expect(header).not.toBeNull();
    expect(breadcrumb!.x + breadcrumb!.width).toBeLessThanOrEqual(actions!.x + .5);
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(header!.x + header!.width + .5);
    expect(actions!.x + actions!.width).toBeLessThanOrEqual(width + .5);
    const projectLabel = page.locator('.breadcrumb > button');
    await expect(projectLabel).toHaveCSS('overflow', 'hidden');
    await expect(projectLabel).toHaveCSS('text-overflow', 'ellipsis');

    const inspectorBounds = (await inspector.boundingBox())!;
    for (const button of await inspector.locator('.inspector-heading button:visible').all()) {
      const bounds = (await button.boundingBox())!;
      expect(bounds.x).toBeGreaterThanOrEqual(inspectorBounds.x - .5);
      expect(bounds.x + bounds.width).toBeLessThanOrEqual(inspectorBounds.x + inspectorBounds.width + .5);
      expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }
    for (const button of await page.locator('.sidebar-actions button').all()) {
      await expect(button.locator('kbd')).toBeHidden();
      const bounds = (await button.boundingBox())!;
      const label = (await button.locator(':scope > span').boundingBox())!;
      expect(label.x).toBeGreaterThanOrEqual(bounds.x);
      expect(label.x + label.width).toBeLessThanOrEqual(bounds.x + bounds.width + .5);
      expect(await button.evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
    }

    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    const controls = settings.getByRole('group', { name: 'Interface size', exact: true });
    await controls.scrollIntoViewIfNeeded();
    await expect(controls.getByRole('button', { name: 'Increase interface size', exact: true })).toBeDisabled();
    const items = await controls.locator(':scope > *').all();
    const bounds = await Promise.all(items.map(item => item.boundingBox()));
    const centers = bounds.map(rect => rect!.y + rect!.height / 2);
    expect(Math.max(...centers) - Math.min(...centers)).toBeLessThan(2);
    for (let index = 1; index < bounds.length; index++) {
      expect(bounds[index]!.x).toBeGreaterThanOrEqual(bounds[index - 1]!.x + bounds[index - 1]!.width);
    }
    const dialogBounds = (await settings.getByRole('tabpanel', { name: 'General', exact: true }).boundingBox())!;
    const controlBounds = (await controls.boundingBox())!;
    expect(controlBounds.x).toBeGreaterThanOrEqual(dialogBounds.x);
    expect(controlBounds.x + controlBounds.width).toBeLessThanOrEqual(dialogBounds.x + dialogBounds.width);
    await page.screenshot({ path: testInfo.outputPath(`geometry-${width}.png`), animations: 'disabled' });
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await expect(settings).toBeHidden();
  }
  // A wide sidebar can leave only 330px for the conversation at this viewport.
  await separator(page).focus();
  await page.keyboard.press('End');
  await expect.poll(() => sidebarWidth(page)).toBe(430);
  await expect(page.locator('.view-switch button > span').first()).toBeHidden();
  const compactActions = (await page.locator('.header-actions').boundingBox())!;
  const compactHeader = (await page.locator('.workspace-header').boundingBox())!;
  expect(compactActions.x).toBeGreaterThanOrEqual(compactHeader.x);
  expect(compactActions.x + compactActions.width).toBeLessThanOrEqual(760);
  await page.screenshot({ path: testInfo.outputPath('geometry-760-wide-sidebar.png'), animations: 'disabled' });
});

test('layout preferences collapse the sidebar, reclaim its width, and restore both saved choices', async ({ page }) => {
  await open(page);
  await dragSidebar(page, 350);
  await expect.poll(() => sidebarWidth(page)).toBe(350);
  const chosenWidth = await storedWidth(page);
  const mainBefore = (await page.locator('.main-pane').boundingBox())!;
  const toggle = page.locator('#sidebar-toggle');
  await expect(toggle).toHaveAccessibleName('Hide sidebar');
  await expect(page.locator('.brand>#sidebar-toggle')).toBeVisible();
  const expandedToggle = (await toggle.boundingBox())!;
  expect(expandedToggle.x).toBeLessThan(mainBefore.x);
  await expect(toggle).toHaveAttribute('aria-controls', 'workspace-sidebar');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true');
  const toggleNode = await toggle.elementHandle();
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(separator(page)).toBeHidden();
  await expect(toggle).toHaveAccessibleName('Show sidebar');
  await expect(page.locator('.header-leading>#sidebar-toggle')).toBeVisible();
  await expect(toggle).toBeFocused();
  expect(await toggleNode!.evaluate(node => node === document.querySelector('#sidebar-toggle'))).toBe(true);
  await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  await expect.poll(async () => (await page.locator('.main-pane').boundingBox())!.width).toBeCloseTo(mainBefore.width + 350, 0);
  expect(await page.evaluate(() => localStorage.getItem('pandacode.sidebarCollapsed'))).toBe('true');
  expect(await storedWidth(page)).toBe(chosenWidth);
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(toggle).toHaveAccessibleName('Show sidebar');
  await toggle.click();
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.locator('.brand>#sidebar-toggle')).toBeVisible();
  await expect.poll(() => sidebarWidth(page)).toBe(350);
  expect(await page.evaluate(() => localStorage.getItem('pandacode.sidebarCollapsed'))).toBe('false');
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await expect(toggle).toHaveAccessibleName('Hide sidebar');
  await expect.poll(() => sidebarWidth(page)).toBe(350);
});

test('layout preferences sidebar shortcuts survive board roundtrips and hide the compact rail', async ({ page }) => {
  await open(page);
  await prompt(page).fill('Keep this draft while changing the sidebar view.');
  await page.keyboard.press('Meta+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(prompt(page)).toBeFocused();
  await page.getByRole('button', { name: 'Board view', exact: true }).click();
  await expect(page.locator('#sidebar-toggle')).toBeHidden();
  await page.keyboard.press('Control+b');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.sidebarCollapsed'))).toBe('true');
  await page.getByRole('button', { name: 'Conversation view', exact: true }).click();
  await expect(page.locator('#sidebar-toggle')).toHaveAccessibleName('Show sidebar');
  await expect(page.locator('.sidebar')).toBeHidden();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(page.getByRole('complementary', { name: 'Project inspector', exact: true })).toBeVisible();
  await page.keyboard.press('Control+Shift+b');
  await expect(page.getByRole('complementary', { name: 'Project inspector', exact: true })).toBeHidden();
  await page.keyboard.press('Control+Shift+b');
  await expect(page.getByRole('complementary', { name: 'Project inspector', exact: true })).toBeVisible();
  await expect(page.locator('.sidebar')).toBeVisible();
  await page.setViewportSize({ width: 620, height: 940 });
  await expect.poll(() => sidebarWidth(page)).toBe(58);
  const mainBefore = (await page.locator('.main-pane').boundingBox())!;
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect.poll(async () => (await page.locator('.main-pane').boundingBox())!.width).toBeCloseTo(mainBefore.width + 58, 0);
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect.poll(() => sidebarWidth(page)).toBe(58);
  await expect(prompt(page)).toHaveValue('Keep this draft while changing the sidebar view.');
});

test('layout preferences collapse the sidebar without replacing the draft or live terminal session', async ({ page }) => {
  await recordTerminalCalls(page);
  await open(page);
  await prompt(page).fill('Keep my composer and terminal while toggling the sidebar.');
  await page.getByRole('button', { name: 'Toggle terminal (⌘ J)', exact: true }).click();
  const terminal = page.locator('#terminal-host .xterm-screen');
  const terminalInput = page.locator('#terminal-host .xterm-helper-textarea');
  await expect(terminal).toBeVisible();
  await expect(terminalInput).toBeFocused();
  const terminalNode = await terminal.elementHandle();
  const promptNode = await prompt(page).elementHandle();
  const transcriptNode = await page.locator('#transcript').elementHandle();
  await page.keyboard.press('Meta+b');
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(terminalInput).toBeFocused();
  await page.keyboard.press('Control+b');
  await expect(page.locator('.sidebar')).toBeVisible();
  await expect(terminalInput).toBeFocused();
  expect(await terminalNode!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  expect(await promptNode!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await transcriptNode!.evaluate(node => node === document.querySelector('#transcript'))).toBe(true);
  await expect(prompt(page)).toHaveValue('Keep my composer and terminal while toggling the sidebar.');
  const calls = await page.evaluate(() => (window as any).__layoutTerminalCalls);
  expect(calls.filter((call: any) => call.command === 'start_terminal')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'close_terminal' || call.command === 'write_terminal')).toEqual([]);
});

test('layout preferences reserve Mac window controls when the sidebar is collapsed at 160 percent', async ({ page }, testInfo) => {
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.sidebarCollapsed', 'true');
    localStorage.setItem('pandacode.uiScale', '1.6');
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await page.evaluate(async () => {
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    initializeNativeAppearance(async () => ({ platform: 'macos', material: 'solid' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-native-platform', 'macos');
  for (const width of [1440, 620]) {
    await page.setViewportSize({ width, height: 940 });
    const toggle = page.getByRole('button', { name: 'Show sidebar', exact: true });
    await expect(toggle).toBeVisible();
    await expect(page.locator('.sidebar')).toBeHidden();
    await expect.poll(() => rootSize(page)).toBeCloseTo(22.4, 2);
    const header = (await page.locator('.workspace-header').boundingBox())!;
    const bounds = (await toggle.boundingBox())!;
    const actions = (await page.locator('.header-actions').boundingBox())!;
    expect(bounds.x - header.x).toBeGreaterThanOrEqual(104);
    expect(bounds.x + bounds.width).toBeLessThanOrEqual(actions.x);
    expect(actions.x + actions.width).toBeLessThanOrEqual(width);
    await page.screenshot({ path: testInfo.outputPath(`collapsed-macos-${width}.png`), animations: 'disabled' });
  }
});

test('layout preferences keep the left sidebar button clear of Mac controls and narrow branding', async ({ page }, testInfo) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.6'));
  await open(page);
  await page.evaluate(async () => {
    const { initializeNativeAppearance } = await import('/src/appearance.ts');
    initializeNativeAppearance(async () => ({ platform: 'macos', material: 'solid' }));
  });
  await expect(page.locator('html')).toHaveAttribute('data-native-platform', 'macos');
  const toggle = page.locator('#sidebar-toggle');
  const original = await toggle.elementHandle();
  for (const width of [190, 235, 440]) {
    await dragSidebar(page, width);
    await expect.poll(() => sidebarWidth(page)).toBe(width);
    const button = (await toggle.boundingBox())!;
    const brand = (await page.locator('.brand-name').boundingBox())!;
    const sidebar = (await page.locator('.sidebar').boundingBox())!;
    expect(button.x - sidebar.x).toBeGreaterThanOrEqual(104);
    expect(button.x + button.width).toBeLessThanOrEqual(brand.x);
    expect(brand.x + brand.width).toBeLessThanOrEqual(sidebar.x + sidebar.width);
  }
  await toggle.focus();
  await page.keyboard.press('Enter');
  await expect(toggle).toHaveAccessibleName('Show sidebar');
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(page.locator('.brand>#sidebar-toggle')).toBeVisible();
  await expect(toggle).toBeFocused();
  expect(await original!.evaluate(node => node === document.querySelector('#sidebar-toggle'))).toBe(true);
  await page.screenshot({ path: testInfo.outputPath('sidebar-toggle-left-macos.png'), animations: 'disabled' });
});

test('layout preferences constrain a saved wide sidebar when browser styles first load', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 940 });
  await page.addInitScript(() => localStorage.setItem('pandacode.sidebarWidth', '440'));
  await open(page);
  await expect.poll(() => sidebarWidth(page)).toBe(440);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
  const inspectorRight = () => page.locator('#inspector').evaluate(node => node.getBoundingClientRect().right);
  await expect.poll(inspectorRight).toBeCloseTo(1100, 0);
  expect(await sidebarWidth(page)).toBeLessThan(440);
  expect(await storedWidth(page)).toBe('440');
  await page.locator('#inspector [data-action="tab-files"]').click();
  await expect.poll(() => sidebarWidth(page)).toBe(440);
});

test('layout preferences resize the right sidebar live and retain its width across tabs, tasks, and reload', async ({ page }) => {
  await open(page);
  await openInspector(page);
  await prompt(page).fill('Keep this draft while I resize the right sidebar.');
  const promptNode = await prompt(page).elementHandle();
  const transcriptNode = await page.locator('#transcript').elementHandle();
  const initial = await inspectorWidth(page);
  const handle = (await inspectorSeparator(page).boundingBox())!;
  const panel = (await page.locator('#inspector').boundingBox())!;
  expect(Math.abs(handle.x + handle.width / 2 - panel.x)).toBeLessThan(8);
  await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
  await page.mouse.down();
  await page.mouse.move(handle.x + handle.width / 2 - 60, handle.y + handle.height / 2, { steps: 5 });
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(initial + 60, 0);
  await page.mouse.move(handle.x + handle.width / 2 - 100, handle.y + handle.height / 2, { steps: 5 });
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(initial + 100, 0);
  await page.mouse.up();
  await expect(prompt(page)).toHaveValue('Keep this draft while I resize the right sidebar.');
  expect(await promptNode!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await transcriptNode!.evaluate(node => node === document.querySelector('#transcript'))).toBe(true);
  const chosen = await inspectorWidth(page);
  expect(Number(await storedInspectorWidth(page))).toBeCloseTo(chosen, 0);

  for (const tab of ['tab-files', 'browser', 'tab-changes']) {
    await page.locator(`#inspector [data-action="${tab}"]`).click();
    if (tab === 'browser') await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
    await expect.poll(() => inspectorWidth(page)).toBeCloseTo(chosen, 0);
  }
  await page.locator('#inspector-toggle').click();
  await expect(inspectorSeparator(page)).toBeHidden();
  await openInspector(page);
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(chosen, 0);
  for (const id of ['session-2', 'session-1']) {
    await page.locator(`.task-item[data-id="${id}"]`).click();
    await expect(prompt(page)).toHaveAttribute('data-session-id', id);
    await expect(prompt(page)).toBeEnabled();
    await openInspector(page);
    await expect.poll(() => inspectorWidth(page)).toBeCloseTo(chosen, 0);
  }
  await page.reload({ waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await openInspector(page);
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(chosen, 0);
});

test('layout preferences right sidebar keyboard limits and reset preserve the wider browser default', async ({ page }) => {
  await open(page);
  await openInspector(page);
  const initial = await inspectorWidth(page);
  await expect(inspectorSeparator(page)).toHaveAttribute('aria-orientation', 'vertical');
  await inspectorSeparator(page).focus();
  await page.keyboard.press('ArrowLeft');
  const oneStep = await inspectorWidth(page);
  expect(oneStep).toBeGreaterThan(initial);
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(initial, 0);
  await page.keyboard.press('Shift+ArrowLeft');
  expect(await inspectorWidth(page) - initial).toBeGreaterThan(oneStep - initial);
  await page.keyboard.press('Home');
  await expect.poll(() => inspectorWidth(page)).toBe(270);
  await expect(inspectorSeparator(page)).toHaveAttribute('aria-valuemin', '270');
  await expect(inspectorSeparator(page)).toHaveAttribute('aria-valuenow', '270');
  await page.keyboard.press('ArrowRight');
  await expect.poll(() => inspectorWidth(page)).toBe(270);
  const maximum = Number(await inspectorSeparator(page).getAttribute('aria-valuemax'));
  expect(maximum).toBeGreaterThan(initial);
  await page.keyboard.press('End');
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(maximum, 0);
  await expect(inspectorSeparator(page)).toHaveAttribute('aria-valuenow', String(maximum));
  await page.keyboard.press('ArrowLeft');
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(maximum, 0);
  await inspectorSeparator(page).dblclick();
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(initial, 0);
  expect(await storedInspectorWidth(page)).toBeNull();

  await page.locator('#browser-toggle').click();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
  const browserDefault = await inspectorWidth(page);
  expect(browserDefault).toBeGreaterThan(initial);
  await inspectorSeparator(page).focus();
  await page.keyboard.press('Home');
  await expect.poll(() => inspectorWidth(page)).toBe(270);
  expect((await page.getByRole('textbox', { name: 'Browser URL', exact: true }).boundingBox())!.width).toBeGreaterThan(140);
  expect(await page.locator('#inspector').evaluate(node => node.scrollWidth <= node.clientWidth + 1)).toBe(true);
  await dragInspector(page, 480);
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(480, 0);
  await inspectorSeparator(page).dblclick();
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(browserDefault, 0);
  expect(await storedInspectorWidth(page)).toBeNull();
});

test('layout preferences keep a resized right sidebar within collapsed, board, and narrow layouts', async ({ page }, testInfo) => {
  await open(page);
  await openInspector(page);
  await dragInspector(page, 620);
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(620, 0);
  const chosen = await storedInspectorWidth(page);
  const checkGeometry = async () => {
    await expect.poll(() => page.evaluate(() => {
      const workspace = document.querySelector<HTMLElement>('.workspace')!;
      const main = document.querySelector<HTMLElement>('.main-pane')!.getBoundingClientRect();
      const inspector = document.querySelector<HTMLElement>('#inspector')!;
      const panel = inspector.getBoundingClientRect();
      const bounds = workspace.getBoundingClientRect();
      const overlay = getComputedStyle(inspector).position === 'absolute';
      return Math.max(Math.abs(panel.right - bounds.right), bounds.left - panel.left,
        workspace.scrollWidth - workspace.clientWidth, overlay ? 0 : Math.abs(main.right - panel.left));
    })).toBeLessThan(1);
    expect(await storedInspectorWidth(page)).toBe(chosen);
  };
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(620, 0);
  await checkGeometry();
  await page.locator('#browser-toggle').click();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
  await checkGeometry();
  await page.screenshot({ path: testInfo.outputPath('right-sidebar-browser-collapsed.png'), animations: 'disabled' });
  await page.getByRole('button', { name: 'Board view', exact: true }).click();
  await expect(inspectorSeparator(page)).toBeHidden();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
  await expect(inspectorSeparator(page)).toBeVisible();
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(620, 0);
  await checkGeometry();
  await page.getByRole('button', { name: 'Conversation view', exact: true }).click();
  await page.locator('#sidebar-toggle').click();
  await expect(page.locator('.sidebar')).toBeVisible();

  for (const width of [1100, 960, 760, 620]) {
    await page.setViewportSize({ width, height: 940 });
    // Crossing the existing narrow-window breakpoint closes the inspector.
    if (width === 760) await expect(page.locator('#inspector')).toBeHidden();
    await openInspector(page);
    await checkGeometry();
    expect(await inspectorWidth(page)).toBeLessThanOrEqual(620);
  }
  await page.setViewportSize({ width: 1440, height: 940 });
  await expect.poll(() => inspectorWidth(page)).toBeCloseTo(620, 0);
  await checkGeometry();
});

for (const width of [2048, 1440, 1100, 960, 760, 620]) {
  for (const scale of [1, 1.6]) {
    test(`layout preferences fill the workspace through inspector tabs at ${width}px and ${scale * 100} percent`, async ({ page }, testInfo) => {
      await page.setViewportSize({ width, height: 940 });
      await page.addInitScript(scale => {
        localStorage.setItem('pandacode.uiScale', String(scale));
        localStorage.setItem('pandacode.sidebarWidth', '250');
      }, scale);
      await page.goto('/', { waitUntil: 'domcontentloaded' });
      await expect(prompt(page)).toBeEnabled();
      await page.evaluate(async () => {
        const { initializeNativeAppearance } = await import('/src/appearance.ts');
        initializeNativeAppearance(async () => ({ platform: 'macos', material: 'solid' }));
      });
      await expect(page.locator('html')).toHaveAttribute('data-native-platform', 'macos');

      const inspector = page.locator('#inspector');
      const checkGeometry = async () => {
        await expect.poll(() => page.evaluate(() => {
          const workspace = document.querySelector<HTMLElement>('.workspace')!;
          const main = document.querySelector<HTMLElement>('.main-pane')!;
          const sidebar = document.querySelector<HTMLElement>('.sidebar')!;
          const inspector = document.querySelector<HTMLElement>('#inspector')!;
          const bounds = workspace.getBoundingClientRect();
          const mainBounds = main.getBoundingClientRect();
          const sidebarBounds = sidebar.getBoundingClientRect();
          const inspectorBounds = inspector.getBoundingClientRect();
          const overlay = getComputedStyle(inspector).position === 'absolute';
          const left = sidebar.hidden ? bounds.left : sidebarBounds.right;
          const right = inspector.hidden || overlay ? bounds.right : inspectorBounds.left;
          return Math.max(Math.abs(mainBounds.left - left), Math.abs(mainBounds.right - right),
            inspector.hidden ? 0 : Math.abs(inspectorBounds.right - bounds.right));
        })).toBeLessThan(1);
      };

      for (const collapsed of [true, false, true, false]) {
        if (collapsed !== await page.locator('.sidebar').isHidden()) await page.locator('#sidebar-toggle').click();
        if (!await inspector.isVisible()) await page.locator('#inspector-toggle').click();
        for (const tab of ['tab-changes', 'browser', 'tab-files', 'tab-changes']) {
          await inspector.locator(`[data-action="${tab}"]`).click();
          if (tab === 'browser') {
            await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
            if (collapsed) await page.screenshot({ path: testInfo.outputPath('collapsed-browser.png'), animations: 'disabled' });
          }
          await checkGeometry();
          if (!collapsed) await expect.poll(() => sidebarWidth(page)).toBe(width <= 650 ? 58 : 250);
        }
        await page.locator('#inspector-toggle').click();
        await expect(inspector).toBeHidden();
        await checkGeometry();
      }
      await page.getByRole('button', { name: 'Board view', exact: true }).click();
      await page.getByRole('button', { name: 'Open browser', exact: true }).click();
      await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
      await checkGeometry();
    });
  }
}

test('the title bar row keeps its on-screen height under interface zoom so it stays level with the window buttons', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  const heights = () => page.evaluate(() => ['.workspace-header', '.sidebar>.brand'].map(selector => Math.round(document.querySelector(selector)!.getBoundingClientRect().height * 10) / 10));
  expect(await heights()).toEqual([55, 55]);
  // In the app, ⌘+ zooms the webview by --page-zoom; the row shrinks in CSS pixels by the same factor.
  await page.evaluate(() => document.documentElement.style.setProperty('--page-zoom', '1.25'));
  expect(await heights()).toEqual([44, 44]);
});
