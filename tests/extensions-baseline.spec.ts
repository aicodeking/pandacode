import { expect, test, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';
const fixture = JSON.parse(readFileSync(new URL('./fixtures/extensions/baseline.json', import.meta.url), 'utf8'));

test.use({ viewport: fixture.viewport, locale: fixture.locale, timezoneId: fixture.timezone, reducedMotion: 'reduce' });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const selected = (page: Page) => page.locator('.task-item.selected');
const calls = (page: Page, command: string) => page.evaluate(command =>
  ((window as any).__extensionsBaseline?.calls ?? []).filter((entry: any) => entry.command === command), command);

async function open(page: Page, theme = 'light', runScript = false): Promise<void> {
  await page.clock.setFixedTime(new Date(fixture.time));
  await page.addInitScript(({ theme, regression, runScript }) => {
    localStorage.setItem('pandacode.theme', theme);
    localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null }));
    (window as any).__extensionsBaseline = { version: 1, calls: [], regression, runScript };
    (window as any).__baselineUrls = [];
    window.open = (url?: string | URL) => { (window as any).__baselineUrls.push(String(url)); return null; };
  }, { theme, regression: process.env.EXTENSIONS_BASELINE_REGRESSION ?? '', runScript });
  await page.goto('/?extensions-baseline');
  await expect(prompt(page)).toBeEnabled();
  await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
  // Verify fixture identity, rather than accidentally accepting another checkout/server.
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.version)).toBe(fixture.version);
  expect((await calls(page, 'list_sessions')).length).toBeGreaterThan(0);
  await expect(page.locator('.task-item[data-id="session-2"]')).toContainText('Refine the navigation');
}

async function select(page: Page, id: string): Promise<void> {
  await page.locator(`.task-item[data-id="${id}"]`).click();
  await expect(prompt(page)).toHaveAttribute('data-session-id', id);
  await expect(prompt(page)).toBeEnabled();
}

async function metadata(page: Page, info: TestInfo) {
  return { fixture: fixture.fixture, fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    build: process.env.PW_PROD ? 'vite-production' : 'vite-development',
    revision: process.env.BASELINE_REVISION ?? null,
    revisionUnavailableReason: process.env.BASELINE_REVISION ? null : 'Set BASELINE_REVISION from jtasks revision inspection',
     platform: platform(), release: release(), browser: info.project.use.browserName ?? 'chromium',
     machine: { architecture: arch(), cpu: cpus()[0]?.model ?? null, logicalProcessors: cpus().length,
       totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), node: process.version },
    browserVersion: page.context().browser()?.version(), viewport: fixture.viewport, locale: fixture.locale,
    timezone: fixture.timezone, time: fixture.time, budgets: fixture.budgets };
}

test.describe('extensions baseline', () => {
  // Independent controls localize a failed continuity gate instead of attributing a
  // whole navigation sequence to one browser engine or one particular surface.
  for (const action of ['sidebar', 'board', 'inspector', 'theme', 'settings', 'attachments', 'terminal']) {
    test(`${action} roundtrip preserves an already verified draft undo stack`, async ({ page }) => {
      await open(page);
      const field = prompt(page);
      await field.pressSequentially('Undo continuity probe');
      await field.press('ControlOrMeta+z');
      await expect(field).not.toHaveValue('Undo continuity probe');
      await field.press('ControlOrMeta+Shift+z');
      await expect(field).toHaveValue('Undo continuity probe');
      const node = await field.elementHandle();
      if (action === 'attachments') {
        await page.getByRole('button', { name: 'Attach files for context' }).click();
        await page.getByRole('menuitem', { name: /Attach files…/ }).click();
        await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
      } else if (action === 'terminal') {
        await page.locator('#terminal-toggle').click();
        await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
        await page.locator('#terminal-host .xterm-helper-textarea').pressSequentially('echo baseline');
        await expect.poll(async () => (await calls(page, 'write_terminal')).map((call: any) => call.args.data).join('')).toBe('echo baseline');
      } else if (action === 'board') {
        for (const view of ['Board', 'Conversation']) {
          await page.locator('#view-menu').click();
          await page.getByRole('menuitemradio', { name: view, exact: true }).click();
        }
      } else if (action === 'settings') {
        await page.getByRole('button', { name: 'Settings', exact: true }).click();
        await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
        await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
      } else {
        const id = action === 'theme' ? '#theme-toggle' : `#${action}-toggle`;
        await page.locator(id).click();
        await page.locator(id).click();
      }
      await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
      await expect(field).toHaveValue('Undo continuity probe');
      expect(await node!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
      await field.press('ControlOrMeta+z');
      await expect(field).not.toHaveValue('Undo continuity probe');
      await field.press('ControlOrMeta+Shift+z');
      await expect(field).toHaveValue('Undo continuity probe');
      expect(await calls(page, 'send_message')).toEqual([]);
    });
  }

  test('sort choice changes and persists without changing selected thread or draft', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Sorting must not navigate');
    for (const label of ['Manual', 'Created', 'Recent activity']) {
      await page.locator('#sidebar-sort').click();
      await page.getByRole('menuitemradio', { name: label, exact: true }).click();
      await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
      await expect(prompt(page)).toHaveValue('Sorting must not navigate');
      await page.locator('#sidebar-sort').click();
      await expect(page.getByRole('menuitemradio', { name: label, exact: true })).toHaveAttribute('aria-checked', 'true');
      await page.keyboard.press('Escape');
    }
    await page.reload();
    await expect(prompt(page)).toBeEnabled();
    await page.locator('#sidebar-sort').click();
    await expect(page.getByRole('menuitemradio', { name: 'Recent activity', exact: true })).toHaveAttribute('aria-checked', 'true');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('undo is local to the prompt, restores selections and does not revive programmatically replaced drafts', async ({ page }) => {
    await open(page);
    const field = prompt(page);
    await field.pressSequentially('alpha beta');
    await field.evaluate((field: HTMLTextAreaElement) => field.setSelectionRange(6, 10));
    await field.pressSequentially('gamma');
    await field.press('ControlOrMeta+z');
    await expect(field).toHaveValue('alpha beta');
    expect(await field.evaluate((field: HTMLTextAreaElement) => [field.selectionStart, field.selectionEnd])).toEqual([6, 10]);
    await field.press('ControlOrMeta+Shift+z');
    await expect(field).toHaveValue('alpha gamma');
    await field.press('ControlOrMeta+z');
    await field.pressSequentially('delta');
    await field.press('ControlOrMeta+Shift+z');
    await expect(field).toHaveValue('alpha delta');
    await field.fill('Replacement draft');
    await field.press('ControlOrMeta+z');
    await expect(field).toHaveValue('alpha delta');
    await field.evaluate((field: HTMLTextAreaElement) => { field.value = ''; field.dispatchEvent(new Event('input', { bubbles: true })); });
    await field.press('ControlOrMeta+z');
    await expect(field).toHaveValue('');
    // Recorded IME lifecycle: intermediate edits are one transaction; the
    // committing 229 key is not intercepted as an undo/submit shortcut.
    await field.evaluate((field: HTMLTextAreaElement) => {
      field.dispatchEvent(new CompositionEvent('compositionstart', { bubbles: true }));
      for (const value of ['に', '日本']) {
        field.dispatchEvent(new InputEvent('beforeinput', { inputType: 'insertCompositionText', bubbles: true }));
        field.value = value;
        field.setSelectionRange(value.length, value.length);
        field.dispatchEvent(new InputEvent('input', { inputType: 'insertCompositionText', isComposing: true, bubbles: true }));
      }
      field.dispatchEvent(new KeyboardEvent('keydown', { key: 'z', ctrlKey: true, keyCode: 229, isComposing: true, bubbles: true, cancelable: true }));
      field.dispatchEvent(new CompositionEvent('compositionend', { data: '日本', bubbles: true }));
    });
    await expect(field).toHaveValue('日本');
    await field.press('ControlOrMeta+z');
    await expect(field).toHaveValue('');
    await field.press('ControlOrMeta+Shift+z');
    await expect(field).toHaveValue('日本');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('history import retains a visible failure and selection for retry, imports once and restores the original draft', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Before import');
    await page.locator('[data-action="import-conversations"]').click();
    const dialog = page.getByRole('dialog', { name: 'Import conversations', exact: true });
    await dialog.locator('.import-row', { hasText: 'Fix login redirect loop' }).click();
    await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'import_conversations'; });
    await dialog.locator('.import-commit').click();
    await expect(dialog.locator('.import-error')).toBeVisible();
    await expect(dialog.locator('.import-error')).toContainText('Baseline rejected import_conversations');
    await expect(dialog.locator('.import-commit')).toHaveText('Import 1 conversation');
    await dialog.locator('.import-commit').click();
    await expect(dialog).toBeHidden();
    await expect(selected(page)).toContainText('Fix login redirect loop');
    expect(await calls(page, 'import_conversations')).toHaveLength(2);
    await select(page, 'session-1');
    await expect(prompt(page)).toHaveValue('Before import');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('opening a project keeps failure retry usable and cancels without creating a project', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Before open project');
    await page.locator('[data-action="add-project"]').first().click();
    await page.locator('#project-folder').fill('/synthetic/baseline');
    await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'add_project'; });
    await page.locator('#open-project-form button[type="submit"], #open-project-form .primary-button').click();
    await expect(page.locator('#toast')).toContainText('Baseline rejected add_project');
    await expect(page.locator('#project-folder')).toHaveValue('/synthetic/baseline');
    await page.keyboard.press('Escape');
    await expect(prompt(page)).toHaveValue('Before open project');
    await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
    expect(await calls(page, 'add_project')).toHaveLength(1);
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('task menu pin and rename act on the selected task without sending the draft', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Keep while renaming');
    await page.locator('[data-action="task-menu"]').click();
    await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
    await expect(selected(page)).toHaveAttribute('data-pinned', 'true');
    await expect(page.getByRole('region', { name: 'Pinned tasks', exact: true })).toContainText('Make search feel instant');
    expect((await calls(page, 'pin_session'))[0].args).toMatchObject({ sessionId: 'session-1', pinned: true });
    await page.locator('[data-action="task-menu"]').click();
    await page.getByRole('menuitem', { name: 'Rename task', exact: true }).click();
    await page.getByRole('textbox', { name: 'Task name', exact: true }).fill('Baseline renamed task');
    await page.getByRole('button', { name: 'Save', exact: true }).click();
    await expect(selected(page)).toContainText('Baseline renamed task');
    await expect(prompt(page)).toHaveValue('Keep while renaming');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('moodboard image attaches to the captured draft and terminal minimizes without closing its PTY', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await prompt(page).pressSequentially('Moodboard draft');
    await page.locator('[data-action="moodboards"]').click();
    const dialog = page.locator('#dialog.moodboards-dialog');
    await dialog.getByRole('button', { name: 'New moodboard', exact: true }).click();
    await dialog.getByRole('textbox', { name: 'Moodboard name', exact: true }).fill('Baseline board');
    await dialog.getByRole('button', { name: 'Create moodboard', exact: true }).click();
    await expect(dialog.getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue('Baseline board');
    const pixel = await page.evaluate(() => { const canvas = document.createElement('canvas'); canvas.width = canvas.height = 2; canvas.getContext('2d')!.fillRect(0, 0, 2, 2); return canvas.toDataURL('image/png').split(',')[1]; });
    await dialog.locator('.moodboard-file-input').setInputFiles({ name: 'Reference.png', mimeType: 'image/png', buffer: Buffer.from(pixel, 'base64') });
    await expect(dialog.getByRole('textbox', { name: 'Caption for Reference.png', exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Attach to task', exact: true }).click();
    await expect(page.locator('#attachments')).toContainText('Baseline board');
    await page.locator('#terminal-toggle').click();
    const node = await page.locator('#terminal-host .xterm-screen').elementHandle();
    await page.locator('#terminal-toggle').click();
    await page.locator('#terminal-toggle').click();
    expect(await node!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
    expect(await calls(page, 'start_terminal')).toHaveLength(1);
    expect(await calls(page, 'close_terminal')).toEqual([]);
    await expect(prompt(page)).toHaveValue('Moodboard draft');
    await prompt(page).press('ControlOrMeta+z');
    await expect(prompt(page)).toHaveValue('');
  });

  test('sidebar, view, inspector, theme and settings retain draft undo, attachments and terminal identity', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await prompt(page).pressSequentially('Unsent baseline draft');
    await prompt(page).press('ControlOrMeta+z');
    await expect(prompt(page)).not.toHaveValue('Unsent baseline draft');
    await prompt(page).press('ControlOrMeta+Shift+z');
    await expect(prompt(page)).toHaveValue('Unsent baseline draft');
    await page.getByRole('button', { name: 'Attach files for context' }).click();
    await page.getByRole('menuitem', { name: /Attach files…/ }).click();
    await expect(page.locator('#attachments .prompt-chip')).toHaveCount(2);
    const attachments = await page.locator('#attachments').innerText();
    const composer = await prompt(page).elementHandle();
    await page.locator('#terminal-toggle').click();
    const terminal = page.locator('#terminal-host .xterm-screen');
    await expect(terminal).toBeVisible();
    const terminalNode = await terminal.elementHandle();
    const start = await calls(page, 'start_terminal');
    expect(start).toHaveLength(1);
    await page.locator('#terminal-host .xterm-helper-textarea').pressSequentially('echo baseline');
    await expect.poll(async () => (await calls(page, 'write_terminal')).map((call: any) => call.args.data).join('')).toBe('echo baseline');
    for (let cycle = 0; cycle < 2; cycle++) {
      await page.locator('#sidebar-toggle').click();
      await expect(page.locator('.sidebar')).toBeHidden();
      await page.locator('#view-menu').click();
      await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
      await expect(page.locator('#project-board')).toBeVisible();
      await page.locator('#view-menu').click();
      await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
      await page.locator('#sidebar-toggle').click();
      await page.locator('#inspector-toggle').click();
      await page.locator('#inspector-toggle').click();
      await page.locator('#theme-toggle').click();
      await page.getByRole('button', { name: 'Settings', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Settings', exact: true })).toBeVisible();
      await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    }
    await expect(prompt(page)).toHaveValue('Unsent baseline draft');
    expect(await composer!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
    expect(await terminalNode!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
    expect(await page.locator('#attachments').innerText()).toBe(attachments);
    expect(await calls(page, 'start_terminal')).toEqual(start);
    expect(await calls(page, 'close_terminal')).toEqual([]);
    await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
    await prompt(page).focus();
    await prompt(page).press('ControlOrMeta+z');
    await expect(prompt(page)).not.toHaveValue('Unsent baseline draft');
    await prompt(page).press('ControlOrMeta+Shift+z');
    await expect(prompt(page)).toHaveValue('Unsent baseline draft');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('project filtering and thread roundtrip keep selected project/thread and per-thread drafts', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Draft for orbit');
    await page.locator('#project-filter').click();
    await page.getByRole('menuitemradio', { name: 'orbit', exact: true }).click();
    await expect(page.locator('#project-filter')).toContainText('orbit');
    await select(page, 'session-2');
    await prompt(page).fill('Draft for navigation');
    await select(page, 'session-1');
    await expect(prompt(page)).toHaveValue('Draft for orbit');
    await page.locator('#sidebar-filter').fill('nothing matches');
    await expect(page.locator('#navigation .task-item')).toHaveCount(0);
    await page.getByRole('button', { name: 'Clear filter', exact: true }).click();
    await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
    await expect(page.locator('#project-filter')).toContainText('orbit');
    await select(page, 'session-2');
    await expect(prompt(page)).toHaveValue('Draft for navigation');
    await page.locator('#project-filter').click();
    await page.getByRole('menuitemradio', { name: 'pandacode', exact: true }).click();
    await expect(page.locator('#project-filter')).toContainText('pandacode');
    await select(page, 'session-4');
    await prompt(page).fill('Draft for the second project');
    await page.locator('#project-filter').click();
    await page.getByRole('menuitemradio', { name: 'orbit', exact: true }).click();
    await select(page, 'session-2');
    await expect(prompt(page)).toHaveValue('Draft for navigation');
  });

  test('GitHub view roundtrip and Go to anything cancellation retain the original draft and focus', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await prompt(page).pressSequentially('View continuity');
    await page.locator('#view-menu').click();
    await page.getByRole('menuitemradio', { name: 'GitHub', exact: true }).click();
    await expect(page.locator('#github-hub')).toBeVisible();
    await page.locator('#view-menu').click();
    await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
    const search = page.locator('[data-action="search"]').first();
    await search.focus();
    await page.keyboard.press('Enter');
    await page.locator('#command-query').fill('Refine the navigation');
    await expect(page.locator('#command-results')).toContainText('Refine the navigation');
    await page.keyboard.press('Escape');
    await expect(search).toBeFocused();
    await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
    await expect(prompt(page)).toHaveValue('View continuity');
    await prompt(page).press('ControlOrMeta+z');
    await expect(prompt(page)).toHaveValue('');
    expect(await calls(page, 'send_message')).toEqual([]);
  });

  test('preview updater stays unavailable without update traffic or restart side effects', async ({ page }) => {
    await open(page);
    await expect(page.locator('#update-status')).toBeHidden();
    const recorded = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((entry: any) => entry.command));
    expect(recorded.filter((command: string) => /app_update|restart|local_sign/.test(command))).toEqual([]);
    // This is the actual preview contract, not native safe-restart qualification.
  });

  for (const [action, target] of [
    ['search', '#command-query'], ['sidebar-sort', '.floating-menu'],
    ['import-conversations', '.import-row'], ['add-project', '#project-folder'],
    ['agent-usage', '.usage-toolbar'], ['browser', '#browser-panel'],
    ['moodboards', '#dialog'], ['deploy', '[role="menu"][aria-label="Deploy"]'],
    ['task-menu', '.floating-menu'],
  ]) {
    test(`${action} opens the legacy surface without sending or changing the draft`, async ({ page }) => {
      await open(page);
      await prompt(page).fill('Retain my draft');
      await page.locator(`[data-action="${action}"]`).first().click();
      await expect(page.locator(target).first()).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(prompt(page)).toHaveValue('Retain my draft');
      await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
      expect(await calls(page, 'send_message')).toEqual([]);
    });
  }

  test('Help and star only act after keyboard activation, including relocated Help', async ({ page }) => {
    await open(page);
    expect(await calls(page, 'open_support')).toEqual([]);
    await page.locator('#sidebar-toggle').click();
    const help = page.locator('.header-leading [data-action="support"]');
    await help.focus();
    await page.keyboard.press('Enter');
    await expect.poll(async () => (await calls(page, 'open_support')).length).toBe(1);
    await page.locator('#sidebar-toggle').click();
    const star = page.locator('.star-panda');
    await star.focus();
    expect(await page.evaluate(() => (window as any).__baselineUrls)).toEqual([]);
    await page.keyboard.press('Enter');
    await expect.poll(() => page.evaluate(() => (window as any).__baselineUrls)).toEqual(['https://github.com/aicodeking/pandacode']);
  });

  test('new task and projectless chat preserve the existing task draft', async ({ page }) => {
    await open(page);
    await prompt(page).fill('Original task draft');
    await page.locator('[data-action="new-task"]').first().click();
    await expect(prompt(page)).not.toHaveAttribute('data-session-id', 'session-1');
    await expect(prompt(page)).toHaveValue('');
    await select(page, 'session-1');
    await expect(prompt(page)).toHaveValue('Original task draft');
    await page.locator('[data-action="new-chat"]').first().click();
    await expect(prompt(page)).not.toHaveAttribute('data-session-id', 'session-1');
    await expect(prompt(page)).toHaveValue('');
    await select(page, 'session-1');
    await expect(prompt(page)).toHaveValue('Original task draft');
  });

  test('Agents keyboard entry opens recorded subagent state and Escape restores focus', async ({ page }) => {
    await open(page);
    await page.evaluate(() => (window as any).__previewSubagent('session-1', { id: 'baseline-worker', name: 'Baseline worker', status: 'running' }));
    const trigger = page.locator('#agents-toggle');
    await expect(trigger).toBeVisible();
    await trigger.focus();
    await page.keyboard.press('Enter');
    await expect(page.locator('#agents-flyout')).toBeVisible();
    await expect(page.locator('#agents-flyout')).toContainText('Baseline worker');
    await page.keyboard.press('Escape');
    await expect(page.locator('#agents-flyout')).toBeHidden();
    await expect(trigger).toBeFocused();
  });

  test('Run project starts once for the captured task and survives a thread roundtrip', async ({ page }) => {
    await open(page, 'light', true);
    await page.locator('#run-project-button').click();
    await expect.poll(async () => (await calls(page, 'start_run_script_terminal')).length).toBe(1);
    const started = await calls(page, 'start_run_script_terminal');
    expect(started[0].args.sessionId).toBe('session-1');
    await select(page, 'session-2');
    await select(page, 'session-1');
    expect(await calls(page, 'start_run_script_terminal')).toEqual(started);
    expect(await calls(page, 'close_terminal')).toEqual([]);
  });

  test('Deploy reports a synthetic start failure and retries exactly once without leaking the connection secret', async ({ page }) => {
    test.setTimeout(60_000);
    await open(page);
    await prompt(page).fill('Original deploy draft');
    await page.locator('[data-action="deploy"]').click();
    await expect(page.getByRole('menuitem', { name: 'Deploy to Vercel', exact: true })).toBeDisabled();
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    const settings = page.getByRole('region', { name: 'Settings', exact: true });
    await settings.getByRole('tab', { name: 'Connections', exact: true }).click();
    await settings.getByRole('tab', { name: 'Cloud sandboxes', exact: true }).click();
    await settings.getByRole('button', { name: 'Connect Vercel', exact: true }).click();
    const form = settings.getByRole('form', { name: 'Connect Vercel', exact: true });
    await form.getByLabel('Vercel Access token').fill('synthetic-baseline-secret');
    await form.getByLabel('Vercel Team slug').fill('baseline-team');
    await form.locator('[type="submit"]').click();
    await expect(settings.getByRole('button', { name: 'Disconnect Vercel', exact: true })).toBeVisible();
    await settings.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
    await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'create_session'; });
    await page.locator('[data-action="deploy"]').click();
    await page.getByRole('menuitem', { name: 'Deploy to Vercel', exact: true }).click();
    await expect(page.locator('#toast')).toContainText('Baseline rejected create_session');
    await expect(prompt(page)).toHaveValue('Original deploy draft');
    expect(await calls(page, 'send_message')).toEqual([]);
    await page.locator('[data-action="deploy"]').click();
    await page.getByRole('menuitem', { name: 'Deploy to Vercel', exact: true }).click();
    await expect.poll(async () => (await calls(page, 'send_message')).length).toBe(1);
    const sent = (await calls(page, 'send_message'))[0].args;
    expect(sent.sessionId).not.toBe('session-1');
    expect(sent.text).toMatch(/^Deploy this project to Vercel\./);
    expect(sent.text).not.toContain('synthetic-baseline-secret');
    await select(page, 'session-1');
    await expect(prompt(page)).toHaveValue('Original deploy draft');
  });

  for (const mode of ['light', 'dark', 'accessibility']) {
    test(`${mode} deterministic screenshot and accessible control baseline`, async ({ page }, info) => {
      if (mode === 'accessibility') await page.emulateMedia({ forcedColors: 'active', contrast: 'more', reducedMotion: 'reduce' });
      await open(page, mode === 'dark' ? 'dark' : 'light');
      await page.getByRole('button', { name: 'Replay PandaCode animation', exact: true }).focus();
      await page.keyboard.press('Enter');
      await expect(prompt(page)).toBeEnabled();
      await page.mouse.move(0, 0);
      await page.locator('#prompt').focus();
      await page.evaluate(() => document.fonts.ready);
      await expect(page.locator('#action-dock[data-snap]')).toHaveCount(0);
      // Diff syntax highlighting arrives after the first paint. Wait for exact
      // repeated pixels, not a timer or a mask hiding the asynchronous content.
      let screenshot!: Buffer;
      await expect(async () => {
        screenshot = await page.screenshot({ path: info.outputPath(`${mode}.png`), animations: 'disabled', caret: 'hide' });
        const repeated = await page.screenshot({ animations: 'disabled', caret: 'hide' });
        expect(createHash('sha256').update(repeated).digest('hex')).toBe(createHash('sha256').update(screenshot).digest('hex'));
      }).toPass({ timeout: 10_000, intervals: [250, 500, 1000] });
      const controls = await page.locator('.workspace').ariaSnapshot();
      expect(controls).toContain('Hide sidebar');
      expect(controls).toContain('Toggle terminal');
      expect(controls).toContain('Message your coding agent');
      const path = info.outputPath(`${mode}.json`);
      writeFileSync(path, JSON.stringify({ ...await metadata(page, info), screenshotSha256: createHash('sha256').update(screenshot).digest('hex'), accessibleTree: controls }, null, 2));
      await info.attach(`${mode}-baseline`, { path, contentType: 'application/json' });
    });
  }

  test('repeated startup task-switch and memory measurements', async ({ page, browserName }, info) => {
    test.setTimeout(90_000);
    const startup: number[] = [], taskSwitch: number[] = [], automationSwitch: number[] = [], legacyAutomationSwitch: number[] = [], heap: (number | null)[] = [];
    const switchDiagnostics: unknown[] = [];
    await open(page);
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    for (let sample = 0; sample < fixture.samples; sample++) {
      const navigationStart = performance.now();
      await page.reload();
      await expect(prompt(page)).toBeEnabled();
      await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
      startup.push(performance.now() - navigationStart);
      const before = performance.now();
      taskSwitch.push(await page.evaluate(async () => {
        const start = performance.now();
        (document.querySelector('.task-item[data-id="session-2"]') as HTMLElement).click();
        for (;;) {
          await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
          const field = document.querySelector<HTMLTextAreaElement>('#prompt');
          if (field?.dataset.sessionId === 'session-2' && !field.disabled && document.querySelector('.task-item.selected')?.getAttribute('data-id') === 'session-2') return performance.now() - start;
          if (performance.now() - start > 10_000) throw new Error('Task switch never became ready');
        }
      }));
      await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
      automationSwitch.push(performance.now() - before);
      await select(page, 'session-1');
      // Keep the original actionability + protocol-roundtrip gate as well. The
      // in-page measurement diagnoses overhead; it must not hide a failed gate.
      await page.evaluate(() => {
        const diagnostic = (window as any).__baselineSwitchDiagnostic = { clickStart: null, dispatchMs: null, nextFrameMs: null, readyAtNextFrame: false };
        document.addEventListener('click', () => {
          diagnostic.clickStart = performance.now();
          requestAnimationFrame(() => {
            diagnostic.nextFrameMs = performance.now() - diagnostic.clickStart;
            const field = document.querySelector<HTMLTextAreaElement>('#prompt');
            diagnostic.readyAtNextFrame = field?.dataset.sessionId === 'session-2' && !field.disabled
              && document.querySelector('.task-item.selected')?.getAttribute('data-id') === 'session-2';
          });
        }, { capture: true, once: true });
        document.addEventListener('click', () => { diagnostic.dispatchMs = performance.now() - diagnostic.clickStart; }, { once: true });
      });
      const legacyBefore = performance.now();
      await page.locator('.task-item[data-id="session-2"]').click();
      const clickMs = performance.now() - legacyBefore;
      await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2');
      const attributeMs = performance.now() - legacyBefore - clickMs;
      await expect(prompt(page)).toBeEnabled();
      legacyAutomationSwitch.push(performance.now() - legacyBefore);
      switchDiagnostics.push({ clickMs, attributeMs, enabledMs: performance.now() - legacyBefore - clickMs - attributeMs,
        ...await page.evaluate(() => (window as any).__baselineSwitchDiagnostic) });
      await select(page, 'session-1');
      const metrics = await cdp?.send('Performance.getMetrics');
      heap.push(metrics?.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null);
    }
    await cdp?.detach();
    const stats = (values: number[]) => { const sorted = [...values].sort((a, b) => a - b); return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
    const result = { ...await metadata(page, info), startupMs: stats(startup), taskSwitchMs: stats(taskSwitch), automationSwitchMs: stats(automationSwitch), legacyAutomationSwitchMs: stats(legacyAutomationSwitch), switchDiagnostics, jsHeapBytes: heap,
      heapUnavailableReason: cdp ? null : 'CDP heap metric unavailable in WebKit', residentMemoryMiB: null,
      residentMemoryUnavailableReason: 'Browser preview cannot qualify native webview/host RSS', sampleCount: fixture.samples };
    const path = info.outputPath('measurements.json');
    writeFileSync(path, JSON.stringify(result, null, 2));
    await info.attach('measurements', { path, contentType: 'application/json' });
    expect(result.startupMs.p95).toBeLessThan(fixture.budgets.startupAbsoluteMs);
    expect(result.taskSwitchMs.p95).toBeLessThan(fixture.budgets.taskSwitchAbsoluteMs);
    expect(result.legacyAutomationSwitchMs.p95).toBeLessThan(fixture.budgets.taskSwitchAbsoluteMs);
  });
});
