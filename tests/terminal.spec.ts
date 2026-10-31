import { expect, test, type Page } from '@playwright/test';

const drawer = (page: Page) => page.locator('#terminal-drawer');
const screen = (page: Page) => drawer(page).locator('.xterm-screen:visible');
const toggle = (page: Page) => page.locator('.workspace-header [data-action="terminal"]');
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__terminalCalls.filter((entry: any) => entry.command === command), command);
const warning = (page: Page) => page.getByRole('dialog', { name: /terminal/i });

async function open(page: Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__terminalCalls ??= []).push({command,args:structuredClone(args)});
      if (command === 'start_terminal' || command === 'start_harness_terminal') {
        const terminalId = 'terminal-' + (window.__terminalSerial = (window.__terminalSerial ?? 0) + 1);
        if (window.__holdTerminalStart) {
          window.__holdTerminalStart = false;
          await new Promise(resolve => {window.__releaseTerminalStart = resolve;});
        }
        setTimeout(() => emit('terminal-event', {terminalId,data:'Ready ' + terminalId + '\\r\\n$ '}), 30);
        return terminalId;
      }
      if (command === 'get_terminal_activity') {
        if (window.__holdTerminalActivity) {
          window.__holdTerminalActivity = false;
          await new Promise(resolve => {window.__releaseTerminalActivity = resolve;});
        }
        if (window.__terminalActivityError) throw new Error('Process information unavailable');
        return window.__terminalActivity ?? {running:false,processNames:[],uncertain:false};
      }
      if (command === 'get_terminal_preferences' && window.__terminalPreferences) return window.__terminalPreferences;
      if (command === 'write_terminal' && window.__holdTerminalWrite) {
        window.__holdTerminalWrite = false;
        await new Promise(resolve => {window.__releaseTerminalWrite = resolve;});
      }
      if (command === 'close_terminal') return;
      switch (command) {`) + '\nwindow.__terminalEmit = emit;\n' });
  });
  await page.goto('/');
  await expect(page.locator('.task-item[data-id="session-1"]')).toHaveAttribute('aria-current', 'page');
  await toggle(page).click();
  await expect(screen(page)).toBeVisible();
  await expect(screen(page)).toContainText('Ready terminal-1');
}

async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.task-item[data-id="${id}"]`).click();
  await expect(page.locator(`.task-item[data-id="${id}"]`)).toHaveAttribute('aria-current', 'page');
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
}

async function running(page: Page): Promise<void> {
  await page.evaluate(() => { (window as any).__terminalActivity = { running: true, processNames: ['node'], uncertain: false }; });
}

test.describe('terminal', () => {
  test('minimizes and restores the same terminal while background output continues', async ({ page }) => {
    await open(page);
    const original = await screen(page).elementHandle();
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await page.evaluate(() => (window as any).__terminalEmit('terminal-event', { terminalId: 'terminal-1', data: '\r\nBuild finished in the background\r\n' }));
    await toggle(page).click();
    await expect(screen(page)).toContainText('Build finished in the background');
    expect(await original!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
    expect(await calls(page, 'start_terminal')).toHaveLength(1);
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
    expect(await calls(page, 'get_terminal_activity')).toHaveLength(0);
  });

  test('top toggle and keyboard shortcut hide the terminal without stopping it', async ({ page }) => {
    await open(page);
    await toggle(page).click();
    await expect(drawer(page)).toBeHidden();
    await page.keyboard.press('Meta+j');
    await expect(drawer(page)).toBeVisible();
    await page.keyboard.press('Meta+j');
    await expect(drawer(page)).toBeHidden();
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-1');
    expect(await calls(page, 'start_terminal')).toHaveLength(1);
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
  });

  test('warns before closing running work and lets users minimize, dismiss, or cancel instead', async ({ page }) => {
    await open(page); await running(page);
    const close = drawer(page).getByRole('button', { name: 'Close terminal', exact: true });
    await close.click();
    await expect(warning(page)).toBeVisible();
    await expect(warning(page)).toContainText(/node/i);
    await expect(warning(page)).toContainText(/stop|kill|running/i);
    await warning(page).evaluate(async node => { await Promise.all(node.getAnimations().map(animation => animation.finished.catch(() => {}))); });
    await page.screenshot({ path: '/private/tmp/pandacode-terminal-warning.png' });
    await warning(page).getByRole('button', { name: 'Minimize instead', exact: true }).click();
    await expect(warning(page)).toBeHidden();
    await expect(drawer(page)).toBeHidden();
    await toggle(page).click();
    await close.click();
    await expect(warning(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(warning(page)).toBeHidden();
    await expect(drawer(page)).toBeVisible();
    await close.click();
    await expect(warning(page)).toBeVisible();
    // Empty sidebar space below the task list.
    await page.mouse.click(12, 700);
    await expect(warning(page)).toBeHidden();
    await expect(drawer(page)).toBeVisible();
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
    expect(await calls(page, 'start_terminal')).toHaveLength(1);
  });

  test('tabs retain separate processes and output and closing a busy tab only stops that tab', async ({ page }) => {
    await open(page);
    await drawer(page).getByRole('button', { name: 'New terminal', exact: true }).click();
    const tabs = drawer(page).getByRole('tablist', { name: 'Terminal tabs' });
    await expect(tabs.getByRole('tab')).toHaveCount(2);
    await expect(tabs.getByRole('tab', { name: 'Terminal 2', exact: true })).toHaveAttribute('aria-selected', 'true');
    await expect(screen(page)).toContainText('Ready terminal-2');
    await page.screenshot({ path: '/private/tmp/pandacode-terminal-tabs.png' });
    await page.evaluate(() => (window as any).__terminalEmit('terminal-event', { terminalId: 'terminal-1', data: '\r\nFirst tab stayed alive\r\n' }));
    await tabs.getByRole('tab', { name: 'Terminal 1', exact: true }).click();
    await expect(screen(page)).toContainText('First tab stayed alive');
    await expect(screen(page)).not.toContainText('Ready terminal-2');
    await running(page);
    await drawer(page).getByRole('button', { name: 'Close Terminal 1', exact: true }).click();
    await expect(warning(page)).toBeVisible();
    await warning(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(warning(page)).toBeHidden();
    await expect(tabs.getByRole('tab')).toHaveCount(1);
    await expect(screen(page)).toContainText('Ready terminal-2');
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-1']);
    expect(await calls(page, 'start_terminal')).toHaveLength(2);
  });

  test('idle and exited terminals close without a warning', async ({ page }) => {
    await open(page);
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(warning(page)).toBeHidden();
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-1']);
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-2');
    await running(page);
    await page.evaluate(() => (window as any).__terminalEmit('terminal-event', { terminalId: 'terminal-2', data: '', exit: true }));
    await expect(screen(page)).toContainText('Process exited');
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(warning(page)).toBeHidden();
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-1', 'terminal-2']);
  });

  test('uncertain or unavailable process information warns rather than silently killing work', async ({ page }) => {
    await open(page);
    await page.evaluate(() => { (window as any).__terminalActivity = { running: false, processNames: [], uncertain: true }; });
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(warning(page)).toBeVisible();
    await warning(page).getByRole('button', { name: 'Minimize instead', exact: true }).click();
    await toggle(page).click();
    await page.evaluate(() => { (window as any).__terminalActivityError = true; });
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(warning(page)).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
  });

  test('keeps tabs linked to each thread and restores its prior visibility on return', async ({ page }) => {
    await open(page);
    await drawer(page).getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect(screen(page)).toContainText('Ready terminal-2');
    await select(page, 'session-2');
    await expect(drawer(page)).toBeHidden();
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-3');
    await expect(drawer(page).getByRole('tab')).toHaveCount(1);
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await select(page, 'session-1');
    await expect(drawer(page)).toBeVisible();
    await expect(drawer(page).getByRole('tab')).toHaveCount(2);
    await expect(screen(page)).toContainText('Ready terminal-2');
    await select(page, 'session-2');
    await expect(drawer(page)).toBeHidden();
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-3');
    expect((await calls(page, 'start_terminal')).map((call: any) => call.args.sessionId)).toEqual(['session-1', 'session-1', 'session-2']);
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
  });

  test('ignores a delayed close check after switching threads', async ({ page }) => {
    await open(page); await running(page);
    await page.evaluate(() => { (window as any).__holdTerminalActivity = true; });
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTerminalActivity)).toBe('function');
    await select(page, 'session-2');
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-2');
    await page.evaluate(() => (window as any).__releaseTerminalActivity());
    await expect(warning(page)).toBeHidden();
    await expect(screen(page)).toContainText('Ready terminal-2');
    await select(page, 'session-1');
    await expect(screen(page)).toContainText('Ready terminal-1');
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
  });

  test('imports terminal appearance while keeping font size controlled by app zoom', async ({ page }) => {
    await page.addInitScript(() => {
      (window as any).__terminalPreferences = {
        source: 'Ghostty', fontFamily: 'JetBrains Mono', fontSize: 48, lineHeight: 1.4,
        cursorStyle: 'bar', cursorBlink: false, theme: { background: '#112233', foreground: '#ddeeff' },
      };
    });
    await open(page);
    const rows = screen(page).locator('.xterm-rows');
    await expect.poll(() => rows.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBe(12);
    expect(await rows.evaluate(node => getComputedStyle(node).fontFamily)).toContain('JetBrains Mono');
    await expect(drawer(page).locator('[data-terminal-settings="Ghostty"]')).toBeVisible();
    expect(await calls(page, 'get_terminal_preferences')).toHaveLength(1);
    await page.keyboard.press('Meta+=');
    await expect.poll(() => rows.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(13.2, 2);
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await toggle(page).click();
    await expect.poll(() => rows.evaluate(node => parseFloat(getComputedStyle(node).fontSize))).toBeCloseTo(13.2, 2);
    expect(await calls(page, 'start_terminal')).toHaveLength(1);
  });

  test('keeps a close request anchored when its terminal finishes starting', async ({ page }) => {
    await open(page); await running(page);
    await page.evaluate(() => { (window as any).__holdTerminalStart = true; });
    await drawer(page).getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTerminalStart)).toBe('function');
    const close = drawer(page).getByRole('button', { name: 'Close Terminal 2', exact: true });
    const anchor = await close.elementHandle();
    await close.click();
    await expect(close).toHaveAttribute('aria-busy', 'true');
    await expect(warning(page)).toBeHidden();
    await page.evaluate(() => (window as any).__releaseTerminalStart());
    await expect(warning(page)).toBeVisible();
    expect(await anchor!.evaluate(node => node.isConnected)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(warning(page)).toBeHidden();
    await expect(close).toBeFocused();
    await close.click();
    await warning(page).getByRole('button', { name: 'Minimize instead', exact: true }).click();
    await expect(drawer(page)).toBeHidden();
    await expect(warning(page)).toBeHidden();
    await toggle(page).click();
    await expect(screen(page)).toContainText('Ready terminal-2');
    await close.click();
    await warning(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(warning(page)).toBeHidden();
    await expect(drawer(page).getByRole('tab')).toHaveCount(1);
    await expect(screen(page)).toContainText('Ready terminal-1');
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-2']);
  });

  test('reuses a harness console and offers the newly requested command without submitting it', async ({ page }) => {
    await open(page); await select(page, 'session-2');
    const prompt = page.locator('#prompt');
    await prompt.fill('/raw on '); await prompt.press('Enter');
    await expect(screen(page)).toContainText('Ready terminal-2');
    const original = await screen(page).elementHandle();
    const insertOn = drawer(page).getByRole('button', { name: 'Insert /raw on in the harness console', exact: true });
    await expect(insertOn).toBeEnabled();
    expect(await calls(page, 'write_terminal')).toHaveLength(0);
    await page.evaluate(() => { (window as any).__holdTerminalWrite = true; });
    await insertOn.click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTerminalWrite)).toBe('function');
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await prompt.fill('/raw off '); await prompt.press('Enter');
    const insertOff = drawer(page).getByRole('button', { name: 'Insert /raw off in the harness console', exact: true });
    await expect(insertOff).toBeEnabled();
    await expect(insertOn).toHaveCount(0);
    expect(await calls(page, 'start_harness_terminal')).toHaveLength(1);
    expect(await calls(page, 'write_terminal')).toHaveLength(1);
    expect(await original!.evaluate(node => node === document.querySelector('#terminal-host .terminal-tab-surface:not([hidden]) .xterm-screen'))).toBe(true);
    await prompt.focus();
    await page.evaluate(() => (window as any).__releaseTerminalWrite());
    await expect(screen(page)).toContainText('/raw on');
    await expect(insertOff).toHaveText('Insert /raw');
    await expect(insertOff).toBeEnabled();
    await expect(prompt).toBeFocused();
    await insertOff.click();
    await expect.poll(async () => (await calls(page, 'write_terminal')).map((call: any) => call.args)).toEqual([
      { terminalId: 'terminal-2', data: '\u001b[200~/raw on\u001b[201~' },
      { terminalId: 'terminal-2', data: '\u001b[200~/raw off\u001b[201~' },
    ]);
    expect(await calls(page, 'send_message')).toHaveLength(0);
    expect(await calls(page, 'close_terminal')).toHaveLength(0);
  });

  test('keeps a starting terminal output and exit event when another terminal is noisy', async ({ page }) => {
    await open(page); await running(page);
    await page.evaluate(() => { (window as any).__holdTerminalStart = true; });
    await drawer(page).getByRole('button', { name: 'New terminal', exact: true }).click();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTerminalStart)).toBe('function');
    await page.evaluate(() => {
      const emit = (window as any).__terminalEmit;
      for (let index = 0; index < 140; index++) emit('terminal-event', { terminalId: 'terminal-1', data: `Other terminal output ${index}\r\n` });
      emit('terminal-event', { terminalId: 'terminal-2', data: 'Early output from the new terminal\r\n' });
      emit('terminal-event', { terminalId: 'terminal-2', data: '', exit: true });
      (window as any).__releaseTerminalStart();
    });
    await expect(screen(page)).toContainText('Early output from the new terminal');
    await expect(screen(page)).toContainText('Process exited');
    await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
    await expect(warning(page)).toBeHidden();
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-2']);
    expect(await calls(page, 'get_terminal_activity')).toHaveLength(0);
    await expect(screen(page)).toContainText('Other terminal output 139');
  });

  test('replaces an exited harness console when opening another native slash command', async ({ page }) => {
    await open(page); await select(page, 'session-2');
    const prompt = page.locator('#prompt');
    await prompt.fill('/raw on '); await prompt.press('Enter');
    await expect(screen(page)).toContainText('Ready terminal-2');
    await page.evaluate(() => (window as any).__terminalEmit('terminal-event', { terminalId: 'terminal-2', data: '', exit: true }));
    await expect(screen(page)).toContainText('Process exited');
    await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
    await prompt.fill('/raw off '); await prompt.press('Enter');
    await expect(screen(page)).toContainText('Ready terminal-3');
    await expect(drawer(page).getByRole('tab')).toHaveCount(1);
    const insert = drawer(page).getByRole('button', { name: 'Insert /raw off in the harness console', exact: true });
    await expect(insert).toBeEnabled();
    expect(await calls(page, 'start_harness_terminal')).toHaveLength(2);
    await expect.poll(async () => (await calls(page, 'close_terminal')).map((call: any) => call.args.terminalId)).toEqual(['terminal-2']);
    await insert.click();
    await expect.poll(async () => (await calls(page, 'write_terminal')).map((call: any) => call.args)).toEqual([
      { terminalId: 'terminal-3', data: '\u001b[200~/raw off\u001b[201~' },
    ]);
    expect(await calls(page, 'send_message')).toHaveLength(0);
  });
});
