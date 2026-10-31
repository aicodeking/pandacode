import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
import { expect, test, type Page } from '@playwright/test';

const browserPanel = (page: Page) => page.getByRole('region', { name: 'Browser', exact: true });
const browserUrl = (page: Page) => page.getByRole('textbox', { name: 'Browser URL', exact: true });
const attachments = (page: Page) => page.locator('.browser-context-attachments .browser-context-chip');

async function installPreviewProbe(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    const body = source.replace(marker, `
      window.__browserCalls ??= [];
      window.__browserCalls.push({ command, args: structuredClone(args) });
      if (command === 'browser_bounds' && args.visible && window.__failBrowserBounds) throw new Error('Native browser visibility unavailable.');
      if (command === 'browser_capture' && window.__delayBrowserCapture) {
        await new Promise(resolve => { window.__releaseBrowserCapture = resolve; });
      }
      if (command === 'read_file' && window.__delayBrowserContextRead) {
        await new Promise(resolve => { window.__releaseBrowserContextRead = resolve; });
      }
      if (command === 'list_local_servers' && window.__failBrowserPorts) throw new Error('Local server discovery timed out. Try refreshing.');
      if (command === 'prepare_file_preview' && window.__delayFilePreview) {
        await new Promise(resolve => { window.__releaseFilePreview = resolve; });
      }
      if (command === 'prepare_file_preview' && window.__failFilePreview) throw new Error('File no longer exists.');
      if (command === 'get_messages' && window.__fileLinkExample) return {
        messages: [{ id: 900, sessionId: args.sessionId, role: 'assistant', content: 'Open [the page](index.html), inspect \`public/favicon.svg\`, or review src/main.ts. missing.html is not a file.', createdAt: Date.now() }], hasOlder: false,
      };
      switch (command) {`);
    await route.fulfill({ response, body });
  });
}

async function commandCalls(page: Page, command: string): Promise<any[]> {
  return page.evaluate(name => ((window as any).__browserCalls ?? []).filter((call: any) => call.command === name), command);
}

async function openBrowser(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(browserUrl(page)).toBeVisible();
}

async function navigate(page: Page, address: string): Promise<void> {
  await browserUrl(page).fill(address);
  await page.getByRole('button', { name: 'Open URL', exact: true }).click();
  await expect(browserPanel(page).getByText('Browser preview · sample page', { exact: true })).toBeVisible();
}

test.describe('browser workspace', () => {
  test.beforeEach(async ({ page }) => {
    await installPreviewProbe(page);
    await page.goto('/');
    await expect(page.locator('.task-item.selected .task-title')).toHaveText('Make search feel instant');
    await expect(page.locator('#inspector')).toBeVisible();
  });

  test('HTML previews in the browser with a separate source action, and images open in a tab that can preview them', async ({ page }) => {
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'View source of index.html', exact: true }).click();
    await expect(page.locator('.file-view-path')).toHaveText('index.html');
    await page.getByRole('button', { name: 'Preview in browser', exact: true }).click();
    await expect(browserUrl(page)).toHaveValue(/\/index\.html$/);
    await expect.poll(async () => (await commandCalls(page, 'prepare_file_preview')).at(-1)?.args).toMatchObject({ projectId: 'project-1', sessionId: 'session-1', path: 'index.html' });
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: 'public', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: 'favicon.svg', exact: true }).click();
    await expect(page.locator('.file-view-path')).toHaveText('public/favicon.svg');
    await expect(page.locator('.office-viewer[data-kind="image"] img')).toBeVisible();
    expect((await commandCalls(page, 'read_file')).some(call => call.args.path === 'public/favicon.svg')).toBe(false);
    await page.getByRole('button', { name: 'Preview in browser', exact: true }).click();
    await expect(browserUrl(page)).toHaveValue(/\/public\/favicon\.svg$/);
    // View source shows the SVG's text, not the image.
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'View source of favicon.svg', exact: true }).click();
    await expect(page.locator('.file-view-path')).toHaveText('public/favicon.svg');
    await expect(page.locator('.office-viewer[data-kind="image"]')).toHaveCount(0);
    await expect.poll(async () => (await commandCalls(page, 'read_file')).some(call => call.args.path === 'public/favicon.svg')).toBe(true);
    await expect(page.locator('.file-view-body')).toContainText('<svg');
  });

  test('file preview errors keep the file list usable', async ({ page }) => {
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.evaluate(() => { (window as any).__failFilePreview = true; });
    await page.locator('.file-row').getByRole('button', { name: 'index.html', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('File no longer exists');
    await expect(page.locator('.file-list')).toBeVisible();
    expect(await commandCalls(page, 'browser_open')).toEqual([]);
  });

  test('response filenames open browser previews and source files in conversation and board', async ({ page }) => {
    await page.addInitScript(() => { (window as any).__fileLinkExample = true; });
    await page.reload();
    const response = page.locator('.message-content').filter({ hasText: 'Open the page' });
    await response.getByRole('button', { name: 'the page', exact: true }).click();
    await expect(browserUrl(page)).toHaveValue(/\/index\.html$/);
    await response.getByRole('button', { name: 'src/main.ts', exact: true }).click();
    await expect(page.locator('.file-view-path')).toHaveText('src/main.ts');
    await expect(response.getByRole('button', { name: 'missing.html', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
    await page.locator('.board-card').filter({ hasText: 'Make search feel instant' }).click();
    await page.locator('.message-content').getByRole('button', { name: 'public/favicon.svg', exact: true }).click();
    await expect(page.locator('.file-view-path')).toHaveText('public/favicon.svg');
    expect((await commandCalls(page, 'prepare_file_preview')).every(call => call.args.sessionId === 'session-1' && call.args.projectId === 'project-1')).toBe(true);
  });

  test('a delayed file preview does not take over a different task', async ({ page }) => {
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.evaluate(() => { (window as any).__delayFilePreview = true; });
    await page.locator('.file-row').getByRole('button', { name: 'index.html', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'prepare_file_preview')).length).toBe(1);
    await page.locator('.task-item[data-id="session-2"]').click();
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
    await page.evaluate(() => { (window as any).__releaseFilePreview(); });
    await expect(browserPanel(page)).toBeHidden();
    expect(await commandCalls(page, 'browser_open')).toEqual([]);
  });

  test('changing inspector tabs cancels a pending file preview', async ({ page }) => {
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.evaluate(() => { (window as any).__delayFilePreview = true; });
    await page.locator('.file-row').getByRole('button', { name: 'index.html', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'prepare_file_preview')).length).toBe(1);
    await page.getByRole('button', { name: /^Changes/ }).click();
    await page.evaluate(() => { (window as any).__releaseFilePreview(); });
    await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
    expect(await commandCalls(page, 'browser_open')).toEqual([]);
  });

  test('opens local servers from both browser entry points and refreshes on demand', async ({ page }) => {
    await openInspectorTab(page, 'Browser');
    await page.getByRole('button', { name: 'Browser', exact: true }).click();
    await expect(browserPanel(page).getByRole('heading', { name: 'Local servers', exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Attach an element', exact: true })).toBeDisabled();
    await expect(page.getByRole('button', { name: 'Attach screenshot', exact: true })).toBeDisabled();
    await expect.poll(async () => (await commandCalls(page, 'list_local_servers')).length).toBe(1);
    await page.getByRole('button', { name: 'Refresh local servers', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'list_local_servers')).length).toBe(2);
    const server = browserPanel(page).locator('.browser-server').filter({ hasText: 'localhost:3000' });
    await expect(server).toContainText('node');
    await server.click();
    await expect(browserUrl(page)).toHaveValue('http://localhost:3000/');
    await expect(page.getByRole('button', { name: 'Attach screenshot', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Close browser', exact: true }).click();
    await expect(browserPanel(page)).toBeHidden();
    await openBrowser(page);
    await expect(browserUrl(page)).toHaveValue('http://localhost:3000/');
  });

  test('normalizes addresses and keeps back and forward navigation in sync', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, '3000');
    await expect(browserUrl(page)).toHaveValue('http://localhost:3000/');
    await expect(page.getByRole('button', { name: 'Go back', exact: true })).toBeDisabled();
    await navigate(page, 'example.com/docs?q=search');
    await expect(browserUrl(page)).toHaveValue('https://example.com/docs?q=search');
    await page.getByRole('button', { name: 'Go back', exact: true }).click();
    await expect(browserUrl(page)).toHaveValue('http://localhost:3000/');
    await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeEnabled();
    await page.getByRole('button', { name: 'Go forward', exact: true }).click();
    await expect(browserUrl(page)).toHaveValue('https://example.com/docs?q=search');
    await navigate(page, '[::1]:5173');
    await expect(browserUrl(page)).toHaveValue('http://[::1]:5173/');
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'browser_action')).map(call => call.args.action)).toEqual(['back', 'forward', 'reload']);
  });

  test('persistent browser visibility failures wait for an explicit reload instead of retrying continuously', async ({ page }) => {
    await openBrowser(page); await navigate(page, 'localhost:3000');
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    await page.evaluate(() => { (window as any).__failBrowserBounds = true; });
    const before = (await commandCalls(page, 'browser_bounds')).length;
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await expect(browserPanel(page).locator('.browser-notice')).toHaveText('Native browser visibility unavailable.');
    // A notice can change the viewport once. It must not start a 16ms retry loop.
    await page.waitForTimeout(350);
    expect((await commandCalls(page, 'browser_bounds')).length - before).toBeLessThanOrEqual(3);
    const attempts = (await commandCalls(page, 'browser_bounds')).length;
    await page.evaluate(() => { (window as any).__failBrowserBounds = false; });
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).slice(attempts).some(entry => entry.args.visible)).toBe(true);
  });

  test('rejects executable URLs, local files, credentials, and invalid ports before native navigation', async ({ page }) => {
    await openBrowser(page);
    for (const address of ['javascript:alert(1)', 'data:text/html,<script>alert(1)</script>', 'file:///etc/passwd', 'https://user:secret@example.com', 'localhost:99999']) {
      await browserUrl(page).fill(address);
      await page.getByRole('button', { name: 'Open URL', exact: true }).click();
      await expect(browserPanel(page).locator('.browser-notice')).toBeVisible();
      await expect.poll(async () => (await commandCalls(page, 'browser_open')).length).toBe(0);
    }
    await navigate(page, 'localhost:5173');
    await expect(browserUrl(page)).toHaveValue('http://localhost:5173/');
    await expect(browserPanel(page).locator('.browser-notice')).toBeHidden();
  });

  test('attaches selected elements and screenshots to the composer and allows removal', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    const pick = page.getByRole('button', { name: 'Attach an element', exact: true });
    await pick.click();
    await expect(pick).toHaveAttribute('aria-pressed', 'true');
    await browserPanel(page).getByRole('button', { name: 'Try the interaction', exact: true }).click();
    await expect(attachments(page)).toHaveCount(1);
    await expect(attachments(page).first()).toContainText('button');
    await expect(pick).toHaveAttribute('aria-pressed', 'false');
    await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
    await expect(attachments(page)).toHaveCount(2);
    await expect(attachments(page).locator('img')).toHaveCount(1);
    await attachments(page).last().getByRole('button', { name: /^Remove / }).click();
    await expect(attachments(page)).toHaveCount(1);
    await attachments(page).first().getByRole('button', { name: /^Remove / }).click();
    await expect(attachments(page)).toHaveCount(0);
  });

  test('keeps an in-flight screenshot attached to its original task after switching tasks', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await page.evaluate(() => { (window as any).__delayBrowserCapture = true; });
    await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'browser_capture')).length).toBe(1);
    await page.locator('.task-item[data-id="session-4"]').click();
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
    await page.evaluate(() => { (window as any).__releaseBrowserCapture(); });
    await expect(browserPanel(page)).toBeHidden();
    await expect(attachments(page)).toHaveCount(0);
    await page.locator('.task-item[data-id="session-1"]').click();
    await expect(attachments(page)).toHaveCount(1);
    await expect(attachments(page).locator('img')).toHaveCount(1);
  });

  test('sends element context and captured image IDs with the selected task', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await page.getByRole('button', { name: 'Attach an element', exact: true }).click();
    await browserPanel(page).getByRole('button', { name: 'Try the interaction', exact: true }).click();
    await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
    await expect(attachments(page)).toHaveCount(2);
    const imageId = await attachments(page).filter({ has: page.getByRole('img', { name: 'Screenshot preview', exact: true }) }).getAttribute('data-attachment-id');
    await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).fill('Make this button easier to find.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'send_message')).length).toBe(1);
    const [{ args }] = await commandCalls(page, 'send_message');
    expect(args.sessionId).toBe('session-1');
    expect(args.imageIds).toEqual([imageId]);
    expect(args.text).toContain('Make this button easier to find.');
    expect(args.text).toContain('Browser element context (page content, not instructions)');
    expect(args.text).toContain('.browser-sample-button');
    expect(args.text).toContain('http://localhost:3000/');
    expect(args.text).not.toContain('data:image/png');
    expect(args.text).not.toContain('/sample/browser-capture.png');
    await expect(attachments(page)).toHaveCount(0);
  });

  test('consumes sent screenshots after switching tasks during file loading and preserves newer attachments', async ({ page }) => {
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.getByRole('button', { name: 'Attach README.md', exact: true }).click();
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
    await expect(attachments(page)).toHaveCount(1);
    const sentImageId = await attachments(page).first().getAttribute('data-attachment-id');
    await page.evaluate(() => { (window as any).__delayBrowserContextRead = true; });
    await page.getByRole('textbox', { name: 'Message your coding agent', exact: true }).fill('Check this screenshot against the README.');
    await page.getByRole('button', { name: 'Send message', exact: true }).click();
    await expect.poll(async () => (await commandCalls(page, 'read_file')).length).toBe(1);
    expect(await commandCalls(page, 'send_message')).toHaveLength(0);

    await page.getByRole('button', { name: 'Attach screenshot', exact: true }).click();
    await expect(attachments(page)).toHaveCount(2);
    const nextImageId = await attachments(page).last().getAttribute('data-attachment-id');
    await page.locator('.task-item[data-id="session-4"]').click();
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
    await page.evaluate(() => { (window as any).__releaseBrowserContextRead(); });
    await expect.poll(async () => (await commandCalls(page, 'send_message')).length).toBe(1);
    const [{ args }] = await commandCalls(page, 'send_message');
    expect(args.sessionId).toBe('session-1');
    expect(args.imageIds).toEqual([sentImageId]);
    expect(args.text).toContain('File context: README.md');
    await expect(attachments(page)).toHaveCount(0);

    await page.locator('.task-item[data-id="session-1"]').click();
    await expect(attachments(page)).toHaveCount(1);
    await expect(attachments(page).first()).toHaveAttribute('data-attachment-id', nextImageId!);
  });

  test('updates native guest bounds while the right sidebar is resized', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    const separator = page.getByRole('separator', { name: 'Resize right sidebar', exact: true });
    const checkNativeBounds = async () => {
      await expect.poll(async () => {
        const guest = (await browserPanel(page).locator('.browser-viewport').boundingBox())!;
        const latest = (await commandCalls(page, 'browser_bounds')).at(-1)?.args;
        if (!latest?.visible) return Infinity;
        return Math.max(...(['x', 'y', 'width', 'height'] as const).map(key => Math.abs(latest.bounds[key] - guest[key])));
      }).toBeLessThan(1);
    };
    await checkNativeBounds();
    const lifecycle = await Promise.all(['browser_open', 'browser_close'].map(command => commandCalls(page, command)));
    await separator.focus();
    await page.keyboard.press('Home');
    await expect.poll(() => page.locator('#inspector').evaluate(node => node.getBoundingClientRect().width)).toBe(270);
    await checkNativeBounds();
    const small = (await browserPanel(page).locator('.browser-viewport').boundingBox())!;
    const handle = (await separator.boundingBox())!;
    await page.mouse.move(handle.x + handle.width / 2, handle.y + handle.height / 2);
    await page.mouse.down();
    await page.mouse.move(handle.x + handle.width / 2 - 210, handle.y + handle.height / 2, { steps: 6 });
    await expect.poll(() => page.locator('#inspector').evaluate(node => node.getBoundingClientRect().width)).toBe(480);
    await checkNativeBounds();
    const large = (await browserPanel(page).locator('.browser-viewport').boundingBox())!;
    expect(large.width - small.width).toBeCloseTo(210, 0);
    expect(large.height).toBeGreaterThan(small.height);
    await page.mouse.up();
    expect(await Promise.all(['browser_open', 'browser_close'].map(command => commandCalls(page, command)))).toEqual(lifecycle);
  });

  test('keeps the native guest visible while a non-overlapping composer slash menu opens and filters', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    const initialBounds = (await commandCalls(page, 'browser_bounds')).length;
    const before = await Promise.all(['browser_open', 'browser_close', 'browser_action'].map(command => commandCalls(page, command)));
    const prompt = page.locator('#prompt');
    await prompt.fill('/');
    const menu = page.getByRole('dialog', { name: 'Slash commands', exact: true });
    await expect(menu).toBeVisible();
    await expect(menu.getByRole('option').first()).toBeVisible();
    const guest = await browserPanel(page).locator('.browser-viewport').boundingBox();
    const popup = await menu.boundingBox();
    expect(popup!.x + popup!.width).toBeLessThanOrEqual(guest!.x);
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    await prompt.fill('/mod');
    await expect(menu.getByRole('option')).toContainText('/model');
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    await prompt.press('Escape');
    await expect(menu).toBeHidden();
    await expect(browserUrl(page)).toHaveValue('http://localhost:3000/');
    expect((await commandCalls(page, 'browser_bounds')).slice(initialBounds).every(call => call.args.visible)).toBe(true);
    const after = await Promise.all(['browser_open', 'browser_close', 'browser_action'].map(command => commandCalls(page, command)));
    expect(after).toEqual(before);
  });

  test('updates native guest visibility when an overlapping floating menu moves and resizes', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    const before = await Promise.all(['browser_open', 'browser_close', 'browser_action'].map(command => commandCalls(page, command)));
    await browserPanel(page).locator('.browser-viewport').evaluate(viewport => {
      const rect = viewport.getBoundingClientRect();
      const menu = document.createElement('section');
      menu.id = 'browser-overlap-fixture'; menu.className = 'floating-menu';
      menu.setAttribute('role', 'dialog'); menu.setAttribute('aria-label', 'Overlap fixture');
      menu.textContent = 'Menu overlapping the native guest';
      menu.style.cssText = `position:fixed;left:${rect.x + 20}px;top:${rect.y + 20}px;width:160px;height:100px;min-width:0;max-width:none;transform:none;transition:none;z-index:1000`;
      document.body.append(menu);
    });
    const menu = page.locator('#browser-overlap-fixture');
    await expect(menu).toBeVisible();
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
    await menu.evaluate(element => { element.style.left = '10px'; });
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    const guest = await browserPanel(page).locator('.browser-viewport').boundingBox();
    await menu.evaluate((element, width) => { element.style.width = `${width}px`; }, guest!.x + 30);
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
    await menu.evaluate(element => { element.style.width = '160px'; });
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    await menu.evaluate(element => element.remove());
    const after = await Promise.all(['browser_open', 'browser_close', 'browser_action'].map(command => commandCalls(page, command)));
    expect(after).toEqual(before);
  });

  test('closes the native guest when leaving the browser and hides it behind modal dialogs and Settings', async ({ page }) => {
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await expect(settings).toBeVisible();
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
    await settings.getByRole('tab', { name: 'Tools & add-ons', exact: true }).click();
    await settings.getByRole('button', { name: 'Manage', exact: true }).click();
    await expect(page.locator('dialog[open]')).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(page.locator('dialog[open]')).toHaveCount(0);
    await expect(settings).toBeVisible();
    expect((await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    const closes = (await commandCalls(page, 'browser_close')).length;
    await openInspectorTab(page, 'Files');
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await expect(browserPanel(page)).toBeHidden();
    await expect.poll(async () => (await commandCalls(page, 'browser_close')).length).toBe(closes + 1);
  });

  test('restores the guest when a dismissed menu remains in the DOM during a suspended fade', async ({ page }) => {
    await page.route('**/src/popover-motion.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const timer = /timer = window\.setTimeout\(finish, duration \+ 60\);/;
      expect(source).toMatch(timer);
      // Model native WebKit suspension: closing animation and its fallback do not
      // finish, even though the menu has already dismissed its interaction state.
      const body = source.replace(timer, 'if (exiting) animation.pause(); timer = window.setTimeout(finish, exiting ? 60000 : duration + 60);');
      await route.fulfill({ response, body });
    });
    await openBrowser(page);
    await navigate(page, 'localhost:3000');
    await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
    await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeVisible();
    const guest = await browserPanel(page).locator('.browser-viewport').boundingBox();
    await page.getByRole('dialog', { name: 'Harness and model', exact: true }).evaluate((menu, guest) => {
      menu.style.left = `${guest!.x + 12}px`; menu.style.top = `${guest!.y + 12}px`;
    }, guest);
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
    await page.keyboard.press('Escape');
    // Menus close instantly, so the guest returns as soon as the menu is gone.
    await expect(page.locator('.floating-menu')).toHaveCount(0);
    await expect.poll(async () => (await commandCalls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
  });

  test('keeps manual URL opening available when local server discovery fails', async ({ page }) => {
    await page.evaluate(() => { (window as any).__failBrowserPorts = true; });
    await openBrowser(page);
    await expect(browserPanel(page).getByText('Local server discovery timed out. Try refreshing.', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: 'Refresh local servers', exact: true })).toBeEnabled();
    await navigate(page, 'localhost:5173');
    await expect(page.getByRole('button', { name: 'Attach an element', exact: true })).toBeEnabled();
  });
});

const pickerSource = readFileSync(new URL('../src-tauri/src/browser/picker.js', import.meta.url), 'utf8');
const pickerKey = '__pandacode_picker_test';
const pickerState = (page: Page) => page.evaluate(key => (globalThis as any)[key].result, pickerKey);
async function startPicker(page: Page): Promise<void> {
  await page.evaluate(pickerSource.replace('__PANDACODE_PICK_KEY__', JSON.stringify(pickerKey)));
}

test.describe('native element picker script', () => {
  test('captures useful escaped metadata and prevents the selected element action', async ({ page }) => {
    await page.setContent('<title>Checkout preview</title><button id="checkout:primary" class="primary" data-testid="checkout" data-token="secret-token" style="padding:20px" onclick="window.selectionActionRan=true">Go &lt;now&gt; &amp; &quot;yes&quot;</button>');
    await startPicker(page);
    const button = page.getByRole('button');
    await button.hover();
    const expectedBounds = await button.boundingBox();
    await button.click();
    const result = await pickerState(page);
    expect(result).toMatchObject({ title: 'Checkout preview', tag: 'button', text: 'Go <now> & "yes"', bounds: expectedBounds });
    expect(await page.locator(result.selector).count()).toBe(1);
    expect(result.html).toContain('Go &lt;now&gt; &amp; &quot;yes&quot;');
    expect(result.html).not.toMatch(/onclick|data-token|secret-token|style=/);
    expect(await page.evaluate(() => (window as any).selectionActionRan)).toBeUndefined();
    await button.click();
    expect(await page.evaluate(() => (window as any).selectionActionRan)).toBe(true);
  });

  test('excludes form values, editable content, and hidden descendants from element context', async ({ page }) => {
    await page.setContent(`<section id="surface" style="padding:24px"><span>Visible context</span>
      <input value="private-input"><input type="password" value="private-password">
      <textarea>private-textarea</textarea><select><option>private-option</option></select>
      <div contenteditable="true">private-editable</div><div hidden>private-hidden</div>
      <div aria-hidden="true">private-aria-hidden</div><script type="application/json">{"private-script":"secret"}</script>
    </section>`);
    await startPicker(page);
    await page.locator('#surface').click({ position: { x: 8, y: 8 } });
    const result = await pickerState(page);
    expect(result.text).toBe('Visible context');
    expect(result.html).not.toContain('private-');
    await startPicker(page);
    await page.locator('input[type="password"]').click();
    const password = await pickerState(page);
    expect(password.tag).toBe('input');
    expect(password.text).toBe('');
    expect(password.html).not.toContain('private-password');
    expect(password.html).not.toContain('value=');
  });

  test('bounds large DOM context and Escape cancels without affecting the page', async ({ page }) => {
    await page.setContent('<title>Long page</title><section id="large" style="padding:24px"></section><button onclick="window.afterCancel=true">Continue</button>');
    await page.locator('#large').evaluate(element => {
      document.title = 'Page title '.repeat(100);
      element.setAttribute('aria-label', 'Description '.repeat(100));
      element.append(...Array.from({ length: 1000 }, () => Object.assign(document.createElement('span'), { textContent: 'Readable content '.repeat(100) })));
    });
    await startPicker(page);
    await page.locator('#large').click({ position: { x: 8, y: 8 } });
    const result = await pickerState(page);
    expect(result.title.length).toBeLessThanOrEqual(300);
    expect(result.text.length).toBeLessThanOrEqual(1200);
    expect(result.selector.length).toBeLessThanOrEqual(1000);
    expect(result.html.length).toBeLessThan(4096);
    await startPicker(page);
    await page.keyboard.press('Escape');
    expect(await pickerState(page)).toEqual({ cancelled: true });
    await page.getByRole('button', { name: 'Continue', exact: true }).click();
    expect(await page.evaluate(() => (window as any).afterCancel)).toBe(true);
  });
});
