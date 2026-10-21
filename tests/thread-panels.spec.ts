import { expect, test, type Page } from '@playwright/test';

const inspector = (page: Page) => page.locator('#inspector');
const address = (page: Page) => page.getByRole('textbox', { name: 'Browser URL', exact: true });
const row = (page: Page, id: string) => page.locator(`.task-item[data-id="${id}"]`);
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__panelCalls.filter((entry: any) => entry.command === command), command);

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__panelCalls ??= []).push({command, args: structuredClone(args)});
      if (command === 'browser_open' && window.__holdPanelUrl === args.url) {
        window.__holdPanelUrl = null;
        await new Promise(resolve => { window.__releasePanelUrl = resolve; });
      }
      if (command === 'read_file' && window.__holdPanelFile === args.sessionId) {
        window.__holdPanelFile = null;
        await new Promise(resolve => { window.__releasePanelFile = resolve; });
      }
      if (command === 'configure_session' && args.projectId && window.__holdPanelProject) {
        window.__holdPanelProject = false;
        await new Promise(resolve => { window.__releasePanelProject = resolve; });
      }
      switch (command) {`) + '\nwindow.__panelEmit = emit;\n' });
  });
  await page.goto('/');
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}
async function select(page: Page, id: string): Promise<void> {
  await row(page, id).click();
  await expect(row(page, id)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}
async function navigate(page: Page, url: string): Promise<void> {
  await page.locator('#browser-toggle').click();
  await address(page).fill(url); await address(page).press('Enter');
  await expect(address(page)).toHaveValue(url);
  await expect.poll(async () => (await calls(page, 'browser_open')).at(-1)?.args.url).toBe(url);
}

test.describe('thread panels', () => {
  test('restored browser visibility does not depend on a paused WebKit bounds timer', async ({ page }) => {
    await page.route('**/src/browser.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = /}, 16\);/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, '}, window.__pauseBrowserBounds ? 60000 : 16);') });
    });
    await open(page); await navigate(page, 'http://localhost:3000/kept');
    await expect.poll(async () => (await calls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
    await select(page, 'session-2');
    await expect.poll(async () => (await calls(page, 'browser_close')).length).toBe(1);
    await page.evaluate(() => { (window as any).__pauseBrowserBounds = true; });
    const before = (await calls(page, 'browser_bounds')).length;
    await select(page, 'session-1');
    await expect(address(page)).toHaveValue('http://localhost:3000/kept');
    await expect.poll(async () => (await calls(page, 'browser_bounds')).slice(before).some(entry => entry.args.visible)).toBe(true);
    const shown = (await calls(page, 'browser_bounds')).length;
    await page.getByRole('button', { name: 'Reload page', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'browser_bounds')).slice(shown).some(entry => entry.args.visible)).toBe(true);
  });

  test('keeps folder, selected file, tab, and closed state separate for same-project tasks', async ({ page }) => {
    await open(page);
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: 'src', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: 'main.ts', exact: true }).click();
    await expect(page.locator('.file-preview-title')).toHaveText('src/main.ts');
    await select(page, 'session-2');
    await expect(inspector(page)).toBeHidden();
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name: 'Files', exact: true }).click();
    await page.locator('.file-row').getByRole('button', { name: 'package.json', exact: true }).click();
    await expect(page.locator('.file-preview-title')).toHaveText('package.json');
    await page.locator('#inspector-toggle').click();
    await select(page, 'session-1');
    await expect(inspector(page)).toBeVisible();
    await expect(page.locator('.file-preview-title')).toHaveText('src/main.ts');
    expect((await calls(page, 'read_file')).at(-1).args).toMatchObject({sessionId:'session-1',path:'src/main.ts'});
    await page.getByRole('button', { name: 'Back', exact: true }).click();
    await expect(page.locator('.file-folder-path')).toContainText('/ src');
    await select(page, 'session-2');
    await expect(inspector(page)).toBeHidden();
    await page.locator('#inspector-toggle').click();
    await expect(page.locator('.file-preview-title')).toHaveText('package.json');
  });

  test('new tasks start closed and returning restores the prior task browser including in-page navigation', async ({ page }) => {
    await open(page); await navigate(page, 'http://localhost:3000/first');
    await page.evaluate(() => (window as any).__panelEmit('browser-state', {url:'http://localhost:3000/next',title:'Next page',loading:false,canGoBack:true,canGoForward:false,picking:false}));
    await expect(address(page)).toHaveValue('http://localhost:3000/next');
    await page.locator('.new-task-button').click();
    await expect(page.getByRole('heading', { name: /^What should we build in/ })).toBeVisible();
    await expect(page.locator('#prompt')).not.toHaveAttribute('data-session-id', 'session-1');
    const newId = await page.locator('#prompt').getAttribute('data-session-id');
    expect(newId).not.toBe('session-1');
    await expect(inspector(page)).toBeHidden();
    await navigate(page, 'http://localhost:5173/second');
    // Typed text keeps the unsent draft; New task reopens it since it has no sidebar row yet.
    await page.locator('#prompt').fill('Keep this draft');
    const reopen = async () => { await page.locator('.new-task-button').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', newId!); };
    await select(page, 'session-1');
    await expect(address(page)).toHaveValue('http://localhost:3000/next');
    await expect.poll(async () => (await calls(page, 'browser_open')).at(-1)?.args.url).toBe('http://localhost:3000/next');
    await reopen();
    await expect(address(page)).toHaveValue('http://localhost:5173/second');
    await page.getByRole('button', { name: 'Close browser', exact: true }).click();
    await select(page, 'session-1');
    await expect(address(page)).toHaveValue('http://localhost:3000/next');
    await reopen();
    await expect(inspector(page)).toBeHidden();
  });

  test('a delayed browser restoration cannot paint or overwrite the task selected afterward', async ({ page }) => {
    await open(page); await navigate(page, 'http://localhost:3000/first');
    await select(page, 'session-2'); await navigate(page, 'http://localhost:5173/second');
    await page.evaluate(() => { (window as any).__holdPanelUrl = 'http://localhost:3000/first'; });
    await select(page, 'session-1');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePanelUrl)).toBe('function');
    await select(page, 'session-2');
    await expect(page.locator('#browser-panel .browser-sample')).toHaveCount(0);
    await page.evaluate(() => (window as any).__releasePanelUrl());
    await expect(address(page)).toHaveValue('http://localhost:5173/second');
    await expect.poll(async () => (await calls(page, 'browser_open')).at(-1)?.args.url).toBe('http://localhost:5173/second');
    await select(page, 'session-1');
    await expect(address(page)).toHaveValue('http://localhost:3000/first');
  });

  test('restores task panels through board and launcher navigation and clears them on deletion', async ({ page }) => {
    await open(page); await navigate(page, 'http://localhost:3000/kept');
    await page.getByRole('button', { name: 'Board view', exact: true }).click();
    await expect(inspector(page)).toBeHidden();
    await page.getByRole('button', { name: 'Open task: Refine the navigation', exact: true }).click();
    await expect(inspector(page)).toBeHidden();
    await page.evaluate(() => (window as any).__panelEmit('overlay-open-task', {sessionId:'session-1'}));
    await expect(address(page)).toHaveValue('http://localhost:3000/kept');
    await page.getByRole('button', { name: 'Task actions', exact: true }).click();
    await page.getByRole('menuitem', { name: 'Delete task…', exact: true }).click();
    await page.getByRole('dialog', {name:'Delete task?',exact:true}).getByRole('button', {name:'Delete task',exact:true}).click();
    await expect(inspector(page)).toBeHidden();
    await expect.poll(async () => (await calls(page, 'browser_close')).length).toBeGreaterThan(1);
    await page.getByRole('button', { name: 'Open task: Refine the navigation', exact: true }).click();
    await page.locator('#browser-toggle').click();
    await expect(address(page)).toHaveValue('');
  });

  test('late selected-file restoration cannot replace another task selection', async ({ page }) => {
    await open(page);
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name:'Files',exact:true }).click();
    await page.locator('.file-row').getByRole('button', { name:'README.md',exact:true }).click();
    await select(page, 'session-2');
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name:'Files',exact:true }).click();
    await page.locator('.file-row').getByRole('button', { name:'package.json',exact:true }).click();
    await page.evaluate(() => { (window as any).__holdPanelFile = 'session-1'; });
    await select(page, 'session-1');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePanelFile)).toBe('function');
    await select(page, 'session-2');
    await expect(page.locator('.file-preview-title')).toHaveText('package.json');
    await page.evaluate(() => (window as any).__releasePanelFile());
    await expect(page.locator('.file-preview-title')).toHaveText('package.json');
  });

  test('a browser mount that finishes after switching tasks disposes its detached view cleanly', async ({ page }) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    await page.route('**/src/jev-live.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = /const unlisten = await Promise\.all/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, `
        if (window.__holdPanelMount) {
          window.__holdPanelMount = false;
          await new Promise(resolve => { window.__releasePanelMount = resolve; });
        }
        $&`) });
    });
    await open(page);
    await page.evaluate(() => { (window as any).__holdPanelMount = true; });
    await page.locator('#browser-toggle').click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePanelMount)).toBe('function');
    await select(page, 'session-2');
    await page.evaluate(() => (window as any).__releasePanelMount());
    await page.locator('#browser-toggle').click();
    await expect(address(page)).toBeVisible();
    await expect(page.locator('.browser-instance')).toHaveCount(1);
    await address(page).fill('http://localhost:5173/current'); await address(page).press('Enter');
    await expect.poll(async () => (await calls(page, 'browser_open')).at(-1)?.args.url).toBe('http://localhost:5173/current');
    expect(errors).toEqual([]);
  });

  test('hiding and reselecting a task does not strand a restored file in its loading state', async ({ page }) => {
    await open(page);
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name:'Files',exact:true }).click();
    await page.locator('.file-row').getByRole('button', { name:'README.md',exact:true }).click();
    await select(page, 'session-2');
    await page.evaluate(() => { (window as any).__holdPanelFile = 'session-1'; });
    await select(page, 'session-1');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePanelFile)).toBe('function');
    await page.locator('#inspector-toggle').click();
    await select(page, 'session-1');
    await page.evaluate(() => (window as any).__releasePanelFile());
    await page.locator('#inspector-toggle').click();
    await expect(page.locator('.file-preview-title')).toHaveText('README.md');
    await expect(page.locator('.document-viewer')).toBeVisible();
  });

  test('a project change completed in the background discards the old workspace file context', async ({ page }) => {
    await open(page); await select(page, 'session-2');
    await page.locator('#inspector-toggle').click();
    await page.getByRole('button', { name:'Files',exact:true }).click();
    await page.locator('.file-row').getByRole('button', { name:'src',exact:true }).click();
    await page.locator('.file-row').getByRole('button', { name:'main.ts',exact:true }).click();
    await page.evaluate(() => { (window as any).__holdPanelProject = true; });
    await page.getByRole('button', { name:'Change task project',exact:true }).first().click();
    await page.getByRole('dialog', { name:'Choose project',exact:true }).getByRole('option', {name:/^pandacode — /}).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releasePanelProject)).toBe('function');
    await select(page, 'session-1');
    const reads = (await calls(page, 'read_file')).length;
    await page.evaluate(() => (window as any).__releasePanelProject());
    await expect(row(page, 'session-2').locator('.task-project')).toHaveText('pandacode');
    await select(page, 'session-2');
    await expect(page.locator('.file-preview-title')).toHaveCount(0);
    await expect(page.locator('.file-folder-path')).toHaveText('pandacode');
    expect((await calls(page, 'read_file')).length).toBe(reads);
  });
});
