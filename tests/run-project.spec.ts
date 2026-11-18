import { expect, test, type Page } from '@playwright/test';

type Script = { path: string; previewUrl?: string; previewPath?: string };
const script: Script = { path: 'pandacode-run.sh', previewUrl: 'http://127.0.0.1:3000/' };
const runButton = (page: Page) => page.locator('#run-project-button');
const cardRun = (page: Page) => page.locator('.turn-changes [data-action="run-project"]').first();
const drawer = (page: Page) => page.locator('#terminal-drawer');
const screen = (page: Page) => drawer(page).locator('.xterm-screen:visible');
const address = (page: Page) => page.getByRole('textbox', { name: 'Browser URL', exact: true });
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__runTest.calls.filter((entry: any) => entry.command === command), command);
const errors = new WeakMap<Page, string[]>();

async function open(page: Page, config: { scripts?: Record<string, Script | null>; ready?: Record<string, string>; hold?: Record<string, boolean> } = {}): Promise<void> {
  const runtimeErrors: string[] = []; errors.set(page, runtimeErrors);
  page.on('pageerror', error => runtimeErrors.push(error.message));
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /async function invoke\(command, args\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `async function invoke(command, args) {
      const fixture = window.__runTest ??= {
        calls: [], serial: 0, scripts: ${JSON.stringify(config.scripts ?? { 'session-1': script })},
        ready: ${JSON.stringify(config.ready ?? {})}, hold: ${JSON.stringify(config.hold ?? {})}, release: {},
        emit, agent,
      };
      fixture.calls.push({ command, args: structuredClone(args) });
      if (command === 'agent_ui_request_active') return !fixture.expired?.includes(args.requestId);
      if (command === 'resolve_agent_ui_action') return;
      const wait = async kind => {
        const key = kind + ':' + args.sessionId;
        if (fixture.hold[key]) {
          fixture.hold[key] = false;
          await new Promise(resolve => { fixture.release[key] = resolve; });
        }
      };
      if (command === 'get_run_script') {
        const result = structuredClone(fixture.scripts[args.sessionId] ?? null);
        await wait('metadata'); return result;
      }
      if (command === 'get_run_script_preview') {
        const result = fixture.ready[args.sessionId] ?? null;
        await wait('preview'); return result;
      }
      if (command === 'prepare_file_preview') {
        await wait('file');
        return { path: args.path, name: 'index.html', url: 'http://127.0.0.1:43210/index.html' };
      }
      if (command === 'start_run_script_terminal') {
        const terminalId = 'run-' + ++fixture.serial;
        await wait('start');
        setTimeout(() => emit('terminal-event', {terminalId, data:'Running ' + terminalId + '\\r\\n'}), 20);
        return terminalId;
      }
      if (command === 'get_terminal_activity') return { running: false, processNames: [], uncertain: false };
      if (command === 'close_terminal') return;
    `) });
  });
  await page.goto('/');
  await expect(page.locator('.task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(async () => (await calls(page, 'get_run_script')).length).toBeGreaterThan(0);
}

async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.task-item[data-id="${id}"]`).click();
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', id);
  await expect(page.locator('#prompt')).toBeEnabled();
}

async function release(page: Page, key: string): Promise<void> {
  await expect.poll(() => page.evaluate(key => typeof (window as any).__runTest.release[key], key)).toBe('function');
  await page.evaluate(key => (window as any).__runTest.release[key](), key);
}

test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

test.describe('project run', () => {
  test('hides header and turn-card controls when the checkout has no run script', async ({ page }) => {
    await open(page, { scripts: {} });
    await expect(runButton(page)).toBeHidden();
    await expect(cardRun(page)).toBeHidden();
    expect(await calls(page, 'start_run_script_terminal')).toEqual([]);
    expect(await calls(page, 'get_run_script_preview')).toEqual([]);
  });

  test('discovers the script in the header and completed-turn card and launches in the selected checkout', async ({ page }) => {
    await open(page);
    await expect(runButton(page)).toBeVisible();
    await expect(cardRun(page)).toBeVisible();
    await cardRun(page).click();
    await expect(drawer(page).getByRole('tab', { name: 'Run', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(screen(page)).toContainText('Running run-1');
    const started = await calls(page, 'start_run_script_terminal');
    expect(started).toHaveLength(1);
    expect(started[0].args).toMatchObject({ projectId: 'project-1', sessionId: 'session-1' });
    expect(started[0].args.cols).toBeGreaterThan(0);
    expect(started[0].args.rows).toBeGreaterThan(0);
    expect(await calls(page, 'start_terminal')).toEqual([]);
    expect(await calls(page, 'write_terminal')).toEqual([]);
  });

  test('guards repeated starts and restores the same running terminal after minimizing', async ({ page }) => {
    await open(page, { hold: { 'start:session-1': true } });
    await runButton(page).click();
    await expect(runButton(page)).toBeDisabled();
    await expect(cardRun(page)).toBeDisabled();
    await runButton(page).dispatchEvent('click');
    await cardRun(page).dispatchEvent('click');
    await release(page, 'start:session-1');
    await expect(screen(page)).toContainText('Running run-1');
    await expect(runButton(page)).toBeEnabled();
    expect(await calls(page, 'start_run_script_terminal')).toHaveLength(1);
    const original = await screen(page).elementHandle();
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await runButton(page).click();
    await expect(screen(page)).toContainText('Running run-1');
    expect(await calls(page, 'start_run_script_terminal')).toHaveLength(1);
    expect(await original!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
    await expect(drawer(page).getByRole('tab', { name: 'Run', exact: true })).toHaveCount(1);
  });

  for (const preview of [
    { label: 'dev server', script, url: script.previewUrl! },
    { label: 'built page', script: { path: 'pandacode-run.sh', previewPath: 'dist/index.html' }, url: 'http://127.0.0.1:43210/index.html' },
  ]) test(`opens the ${preview.label} once its native preview is ready`, async ({ page }) => {
    await page.clock.install();
    await open(page, { scripts: { 'session-1': preview.script } });
    await runButton(page).click();
    await expect(screen(page)).toContainText('Running run-1');
    await expect.poll(async () => (await calls(page, 'get_run_script_preview')).length).toBeGreaterThan(0);
    expect(await calls(page, 'browser_open')).toEqual([]);
    await page.evaluate(url => { (window as any).__runTest.ready['session-1'] = url; }, preview.url);
    await page.clock.runFor(1500);
    await expect(address(page)).toHaveValue(preview.url);
    const checks = (await calls(page, 'get_run_script_preview')).length;
    await page.clock.runFor(2000);
    expect(await calls(page, 'get_run_script_preview')).toHaveLength(checks);
    expect(await calls(page, 'browser_open')).toHaveLength(1);
  });

  test('the dock Run item is green while the script runs, and pulses only while starting', async ({ page }) => {
    await open(page, { hold: { 'start:session-1': true } });
    const glyph = runButton(page).locator('.icon');
    const pulsing = () => glyph.evaluate(el => getComputedStyle(el).animationName === 'state-pulse');
    // The dock sits in the main pane's header, where a scene steps the status tones (sky.css), so the probe reads the tone there.
    const green = () => glyph.evaluate(el => { const probe = document.createElement('i'); probe.style.color = 'var(--ds-success)'; el.closest('#action-dock')!.parentElement!.append(probe); const success = getComputedStyle(probe).color; probe.remove(); return getComputedStyle(el).color === success; });
    await expect(runButton(page)).not.toHaveAttribute('data-running');
    await runButton(page).click();
    await expect(runButton(page)).toHaveAttribute('aria-busy', 'true');
    expect(await pulsing()).toBe(true);
    await release(page, 'start:session-1');
    await expect(runButton(page)).toHaveAttribute('data-running', '');
    await expect(runButton(page)).toHaveAttribute('aria-busy', 'false');
    await expect.poll(green).toBe(true);
    expect(await pulsing()).toBe(false);
    await page.evaluate(() => (window as any).__runTest.emit('terminal-event', { terminalId: 'run-1', data: '', exit: true }));
    await expect(runButton(page)).not.toHaveAttribute('data-running');
    await expect.poll(green).toBe(false);
  });

  test('restarts an exited Run terminal without accumulating tabs', async ({ page }) => {
    await open(page, { scripts: { 'session-1': { path: 'pandacode-run.sh' } } });
    await runButton(page).click();
    await expect(screen(page)).toContainText('Running run-1');
    await page.evaluate(() => (window as any).__runTest.emit('terminal-event', { terminalId: 'run-1', data: '\r\nFinished\r\n', exit: true }));
    await expect(screen(page)).toContainText('Process exited');
    await runButton(page).click();
    await expect(screen(page)).toContainText('Running run-2');
    expect(await calls(page, 'start_run_script_terminal')).toHaveLength(2);
    expect(await calls(page, 'close_terminal')).toHaveLength(1);
    await expect(drawer(page).getByRole('tab', { name: 'Run', exact: true })).toHaveCount(1);
    expect(await calls(page, 'get_run_script_preview')).toEqual([]);
  });

  test('passes an active agent request to the native Run startup', async ({ page }) => {
    await open(page, { scripts: { 'session-1': { path: 'pandacode-run.sh' } } });
    await page.evaluate(() => (window as any).__runTest.emit('agent-ui-action', {
      requestId: 'agent-run', sessionId: 'session-1', action: 'run_project', args: {},
    }));
    await expect(screen(page)).toContainText('Running run-1');
    expect((await calls(page, 'start_run_script_terminal'))[0].args).toMatchObject({
      requestId: 'agent-run', projectId: 'project-1', sessionId: 'session-1',
    });
    await expect.poll(async () => (await calls(page, 'resolve_agent_ui_action')).at(-1)?.args).toMatchObject({
      requestId: 'agent-run', result: { started: true, previewPending: false },
    });
  });

  test('an agent Run request cancelled during metadata lookup never starts a shell', async ({ page }) => {
    await open(page);
    await expect(runButton(page)).toBeVisible();
    await page.evaluate(() => {
      const fixture = (window as any).__runTest;
      fixture.hold['metadata:session-1'] = true;
      fixture.emit('agent-ui-action', { requestId: 'cancelled-run', sessionId: 'session-1', action: 'run_project', args: {} });
    });
    await expect.poll(() => page.evaluate(() => typeof (window as any).__runTest.release['metadata:session-1'])).toBe('function');
    await page.evaluate(() => { (window as any).__runTest.expired = ['cancelled-run']; });
    await release(page, 'metadata:session-1');
    await expect.poll(async () => (await calls(page, 'resolve_agent_ui_action')).at(-1)?.args.error).toContain('no longer active');
    expect(await calls(page, 'start_run_script_terminal')).toEqual([]);
    expect(await calls(page, 'start_terminal')).toEqual([]);
    expect(await calls(page, 'browser_open')).toEqual([]);
    await expect(drawer(page)).toBeHidden();
    await expect(runButton(page)).toBeEnabled();
  });

  test('an agent static-preview request cancelled during preparation never opens the browser', async ({ page }) => {
    await open(page);
    await page.evaluate(() => {
      const fixture = (window as any).__runTest;
      fixture.hold['file:session-1'] = true;
      fixture.emit('agent-ui-action', { requestId: 'cancelled-preview', sessionId: 'session-1', action: 'preview_file', args: { path: 'dist/index.html' } });
    });
    await expect.poll(() => page.evaluate(() => typeof (window as any).__runTest.release['file:session-1'])).toBe('function');
    await page.evaluate(() => { (window as any).__runTest.expired = ['cancelled-preview']; });
    await release(page, 'file:session-1');
    await expect.poll(async () => (await calls(page, 'resolve_agent_ui_action')).at(-1)?.args.error).toContain('no longer active');
    expect((await calls(page, 'prepare_file_preview'))[0].args).toMatchObject({
      projectId: 'project-1', sessionId: 'session-1', path: 'dist/index.html',
    });
    expect(await calls(page, 'browser_open')).toEqual([]);
    await expect(page.locator('#browser-panel')).toBeHidden();
  });

  test('ignores delayed discovery from a task that is no longer selected', async ({ page }) => {
    await open(page, { hold: { 'metadata:session-1': true } });
    await select(page, 'session-2');
    await release(page, 'metadata:session-1');
    await expect(runButton(page)).toBeHidden();
    expect(await calls(page, 'start_run_script_terminal')).toEqual([]);
    expect(await calls(page, 'browser_open')).toEqual([]);
  });

  test('does not start a script when the task changes during launch validation', async ({ page }) => {
    await open(page);
    await expect(runButton(page)).toBeVisible();
    await page.evaluate(() => { (window as any).__runTest.hold['metadata:session-1'] = true; });
    await runButton(page).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__runTest.release['metadata:session-1'])).toBe('function');
    await select(page, 'session-2');
    await release(page, 'metadata:session-1');
    await expect(runButton(page)).toBeHidden();
    expect(await calls(page, 'start_run_script_terminal')).toEqual([]);
    expect(await calls(page, 'browser_open')).toEqual([]);
    await expect(drawer(page)).toBeHidden();
  });

  test('a delayed preview cannot open over another task or replace that task preview', async ({ page }) => {
    const secondUrl = 'http://127.0.0.1:5173/second';
    await open(page, {
      scripts: { 'session-1': script, 'session-2': { path: 'pandacode-run.sh', previewUrl: secondUrl } },
      ready: { 'session-1': script.previewUrl!, 'session-2': secondUrl },
      hold: { 'preview:session-1': true },
    });
    await runButton(page).click();
    await expect(screen(page)).toContainText('Running run-1');
    await expect.poll(() => page.evaluate(() => typeof (window as any).__runTest.release['preview:session-1'])).toBe('function');
    await select(page, 'session-2');
    await runButton(page).click();
    await expect(address(page)).toHaveValue(secondUrl);
    await release(page, 'preview:session-1');
    await expect(address(page)).toHaveValue(secondUrl);
    expect((await calls(page, 'browser_open')).map((entry: any) => entry.args.url)).toEqual([secondUrl]);
    expect((await calls(page, 'start_run_script_terminal')).map((entry: any) => entry.args.sessionId)).toEqual(['session-1', 'session-2']);
    await expect(screen(page)).toContainText('Running run-2');
  });

  test('refreshes availability on completed changes and done without reading on each text token', async ({ page }) => {
    await open(page, { scripts: {} });
    await expect(runButton(page)).toBeHidden();
    const before = (await calls(page, 'get_run_script')).length;
    await page.evaluate(() => {
      const fixture = (window as any).__runTest;
      for (let index = 0; index < 25; index++) fixture.agent({ sessionId: 'session-1', kind: 'text', text: `Chunk ${index}. ` });
    });
    await expect(page.locator('#stream-region .live-text')).toContainText('Chunk 24.');
    expect(await calls(page, 'get_run_script')).toHaveLength(before);
    await page.evaluate(script => {
      const fixture = (window as any).__runTest;
      fixture.scripts['session-1'] = script;
      fixture.agent({ sessionId: 'session-1', kind: 'turn_changes', text: '', data: {
        messageId: 900, turnChanges: { id: 'run-created', files: [{ path: 'pandacode-run.sh', status: 'added', additions: 3, deletions: 0 }], additions: 3, deletions: 0, truncated: false, concurrent: false },
      } });
    }, script);
    await expect(runButton(page)).toBeVisible();
    await expect(cardRun(page)).toBeVisible();
    expect((await calls(page, 'get_run_script')).length).toBeGreaterThan(before);
    await page.evaluate(() => {
      const fixture = (window as any).__runTest;
      delete fixture.scripts['session-1'];
      fixture.agent({ sessionId: 'session-1', kind: 'done', text: '' });
    });
    await expect(runButton(page)).toBeHidden();
  });

  for (const width of [1440, 900]) test(`keeps Run and neighboring header controls separate at ${width}px`, async ({ page }, testInfo) => {
    await page.setViewportSize({ width, height: 940 });
    await open(page);
    await expect(runButton(page)).toBeVisible();
    const overlaps = await page.locator('.workspace-header').evaluate(header => {
      const controls = [...header.querySelectorAll<HTMLElement>('button')].filter(node => node.getClientRects().length > 0);
      const issues: string[] = [];
      for (let i = 0; i < controls.length; i++) {
        const a = controls[i].getBoundingClientRect();
        if (a.left < 0 || a.right > innerWidth + 1) issues.push(`${controls[i].ariaLabel ?? controls[i].textContent} leaves viewport`);
        for (let j = i + 1; j < controls.length; j++) {
          const b = controls[j].getBoundingClientRect();
          if (Math.min(a.right, b.right) - Math.max(a.left, b.left) > 1 && Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top) > 1) issues.push(`${controls[i].ariaLabel ?? controls[i].textContent} overlaps ${controls[j].ariaLabel ?? controls[j].textContent}`);
        }
      }
      return issues;
    });
    expect(overlaps).toEqual([]);
    await page.screenshot({ path: `/private/tmp/pandacode-project-run-${testInfo.project.name || testInfo.config.projects[0].use.browserName || 'chrome'}-${width}.png`, animations: 'disabled' });
  });
});
