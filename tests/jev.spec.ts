import { expect, test, type Page } from '@playwright/test';

const dialog = (page: Page) => page.locator('#dialog');
const probe = `
  window.__jevCalls ??= [];
  window.__jevCalls.push({ command, args: structuredClone(args) });
  window.__jevConfig ??= { enabled: true, pythonPath: '', chromePath: '', textModel: 'inception/mercury-2.5', textBaseUrl: 'https://openrouter.ai/api/v1', typesafeKeySaved: false, textKeySaved: false };
  window.__jevRuns ??= {};
  window.__jevEmit = patch => {
    const report = { id: 'run-1', sessionId: 'session-1', url: 'http://localhost:3000/', goal: 'Check the primary interaction', viewport: 'desktop', status: 'running', verification: 'not_checked', summary: 'Exploring the app', createdAt: Date.now(), durationMs: 1000, steps: 1, checks: [], events: [], ...window.__jevRuns[patch.id || 'run-1'], ...patch };
    window.__jevRuns[report.id] = structuredClone(report); emit('jev-run', structuredClone(report)); return report;
  };
  if (command === 'jev_configuration') return structuredClone(window.__jevConfig);
  if (command === 'list_local_servers' && window.__jevLocalServers) return structuredClone(window.__jevLocalServers);
  if (command === 'jev_doctor') {
    if (window.__jevDelayDoctor) await new Promise(resolve => { window.__jevReleaseDoctor = resolve; });
    return { ready: true, pythonVersion: 'Python 3.12.10', jevVersion: '0.1.0', chromePath: '/test/chrome', issues: [] };
  }
  if (command === 'jev_save_configuration') {
    if (window.__jevFailSave) throw new Error('Could not save settings. Try again.');
    window.__jevConfig = { ...window.__jevConfig, ...args.settings };
    if ('typesafeKey' in args) window.__jevConfig.typesafeKeySaved = Boolean(args.typesafeKey);
    if ('textKey' in args) window.__jevConfig.textKeySaved = Boolean(args.textKey);
    return structuredClone(window.__jevConfig);
  }
  if (command === 'jev_install_runtime') {
    emit('jev-install', {status:'installing',message:'Preparing Python environment…'});
    if (window.__jevDelayInstall) await new Promise(resolve => { window.__jevReleaseInstall = resolve; });
    return { ready: true, pythonVersion: 'Python 3.12.10', jevVersion: '0.1.0', chromePath: '/test/chrome', issues: [] };
  }
  if (command === 'jev_list_runs') return Object.values(window.__jevRuns).filter(run => run.sessionId === args.sessionId).sort((a,b) => b.createdAt-a.createdAt);
  if (command === 'jev_read_run') {
    if (window.__jevDelayRead) await new Promise(resolve => { window.__jevReleaseRead = resolve; });
    return structuredClone(window.__jevRuns[args.runId]);
  }
  if (command === 'jev_start') {
    if (window.__jevFailStart) throw new Error('Missing TypeSafe API key. Set up Jev first.');
    return window.__jevEmit({id:'run-' + (Object.keys(window.__jevRuns).length + 1), sessionId:args.sessionId, ...args.request, status:'starting', summary:'Opening isolated Chrome…', steps:0, events:[], durationMs:0, createdAt:Date.now()});
  }
  if (command === 'jev_cancel') { window.__jevEmit({id:args.runId,status:'cancelled',summary:'Browser test cancelled.'}); return; }
`;

async function installProbe(page: Page, nativeKeys = false) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    expect(source).toMatch(/switch \(command\) \{/);
    await route.fulfill({ response, body: source.replace(/switch \(command\) \{/, `${probe}\n switch (command) {`) });
  });
  if (nativeKeys) await page.route('**/src/jev.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /import \{ call, preview, subscribe \} from ([^;]+);/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, 'import { call, subscribe } from $1; const preview = false;') });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}
async function calls(page: Page, command: string): Promise<any[]> {
  return page.evaluate(command => (window as any).__jevCalls.filter((entry: any) => entry.command === command), command);
}
async function emit(page: Page, patch: Record<string, unknown>) {
  await page.evaluate(patch => (window as any).__jevEmit(patch), patch);
}
async function settings(page: Page) {
  // Closing the Jev dialog returns to the Settings page, which stays open behind it.
  const settingsPage = page.getByRole('region', { name: 'Settings', exact: true });
  if (!await settingsPage.isVisible()) await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await settingsPage.getByRole('tab', { name: 'Tools & add-ons', exact: true }).click();
  await page.getByRole('button', { name: 'Set up Jev', exact: true }).click();
  await expect(dialog(page).getByRole('heading', { name: 'Jev add-on', exact: true })).toBeVisible();
  await expect(page.locator('[data-jev-save]')).toBeEnabled();
}
async function tests(page: Page) {
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Browser tests with Jev', exact: true }).click();
  await expect(page.locator('#jev-test-goal')).toBeVisible();
}
async function run(page: Page) {
  await page.locator('#jev-test-url').fill('http://localhost:3000/');
  await page.locator('[data-jev-run]').click();
  await expect(page.locator('.jev-report-status')).toHaveText('Starting browser');
}

test('Jev settings persist opt-in and never return saved keys to inputs', async ({ page }) => {
  await installProbe(page, true);
  await page.evaluate(() => { (window as any).__jevConfig.enabled = false; });
  await settings(page);
  await expect(page.locator('#jev-enabled')).not.toBeChecked();
  await page.locator('#jev-enabled').check();
  await page.locator('#jev-typesafe-key').fill('fake-typesafe-test-key');
  await page.locator('#jev-text-key').fill('fake-text-test-key');
  await page.locator('[data-jev-save]').click();
  await expect(page.locator('[data-jev-key-status="typesafe"]')).toHaveText('Key saved');
  await expect(page.locator('#jev-typesafe-key')).toHaveValue('');
  await expect(page.locator('#jev-text-key')).toHaveValue('');
  const saved = (await calls(page, 'jev_save_configuration'))[0].args;
  expect(saved.settings.enabled).toBe(true); expect(saved.typesafeKey).toBe('fake-typesafe-test-key');
  await page.locator('[data-jev-save]').click();
  await expect.poll(async () => (await calls(page, 'jev_save_configuration')).length).toBe(2);
  expect((await calls(page, 'jev_save_configuration'))[1].args).not.toHaveProperty('typesafeKey');
  await page.locator('[data-jev-remove-key="typesafe"]').click();
  await page.locator('[data-jev-save]').click();
  await expect(page.locator('[data-jev-key-status="typesafe"]')).toHaveText('No saved key');
  expect((await calls(page, 'jev_save_configuration'))[2].args.typesafeKey).toBe('');
  await page.locator('[data-jev-settings-close]').click(); await settings(page);
  await expect(page.locator('#jev-enabled')).toBeChecked();
  await expect(page.locator('[data-jev-key-status="text"]')).toHaveText('Key saved');
  await expect(page.locator('#jev-text-key')).toHaveValue('');
  await page.screenshot({ path: '/private/tmp/pandacode-jev-settings.png' });
});

test('OpenRouter decisions list models only when the menu opens and send the key once', async ({ page }) => {
  await installProbe(page, true);
  await settings(page);
  const models = async (provider: string) => (await calls(page, 'jev_decision_models')).filter(entry => entry.args.provider === provider).length;
  await expect(page.locator('#jev-decision-provider')).toHaveValue('typesafe');
  await expect(page.locator('#jev-decision-model')).toHaveValue('jev-1.13.0');
  await expect(page.locator('#jev-openrouter-key')).toBeHidden();
  await page.locator('#jev-decision-provider').selectOption('openrouter');
  await expect(page.locator('#jev-openrouter-key')).toBeVisible();
  expect(await models('openrouter')).toBe(0);
  await page.locator('#jev-decision-model').focus();
  await expect.poll(() => models('openrouter')).toBe(1);
  await expect(page.locator('#jev-decision-model option[value="openai/gpt-4o-mini"]')).toHaveCount(1);
  await page.locator('#jev-decision-model').selectOption('openai/gpt-4o-mini');
  await page.locator('[data-jev-models-refresh]').click();
  await expect.poll(() => models('openrouter')).toBe(2);
  await page.locator('#jev-openrouter-key').fill('fake-openrouter-test-key');
  await page.locator('[data-jev-save]').click();
  await expect.poll(async () => (await calls(page, 'jev_save_configuration')).length).toBe(1);
  const saved = (await calls(page, 'jev_save_configuration'))[0].args;
  expect(saved.settings.decisionProvider).toBe('openrouter'); expect(saved.settings.decisionModel).toBe('openai/gpt-4o-mini');
  expect(saved.openrouterKey).toBe('fake-openrouter-test-key');
  await expect(page.locator('#jev-openrouter-key')).toHaveValue('');
});
test('Jev setup remains editable after errors and shows installation progress', async ({ page }) => {
  await installProbe(page, true); await settings(page);
  await page.evaluate(() => { (window as any).__jevFailSave = true; });
  await page.locator('#jev-text-key').fill('fake-do-not-retain'); await page.locator('[data-jev-save]').click();
  await expect(page.locator('.jev-feedback')).toContainText('Could not save');
  await expect(page.locator('#jev-text-key')).toHaveValue('');
  await expect(page.locator('[data-jev-save]')).toBeEnabled();
  await page.evaluate(() => { (window as any).__jevDelayInstall = true; });
  await page.locator('[data-jev-install]').click();
  await expect(page.locator('.jev-install-progress')).toBeVisible();
  await expect(page.locator('[data-jev-install]')).toBeDisabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__jevReleaseInstall)).toBe('function');
  await page.evaluate(() => { (window as any).__jevReleaseInstall(); });
  await expect(page.locator('.jev-install-progress')).toBeHidden();
  await expect(page.locator('.jev-runtime-badge')).toHaveText('Ready');
});

test('browser entry prefills the current URL and mobile checks send exact options', async ({ page }) => {
  await installProbe(page);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('textbox', { name: 'Browser URL', exact: true }).fill('localhost:5173/game');
  await page.getByRole('button', { name: 'Open URL', exact: true }).click();
  await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Test with Jev', exact: true })).toHaveClass(/jev-popover/);
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#jev-test-url')).toHaveValue('http://localhost:5173/game');
  await expect(page.locator('.jev-server-chip')).not.toHaveCount(0);
  await page.locator('[data-jev-preset="mobile"]').click();
  await page.getByText('Verify the result', { exact: false }).click();
  await page.locator('#jev-expected-text').fill('Victory');
  await page.locator('#jev-expected-title').fill('Minesweeper');
  await page.locator('#jev-expected-url').fill('http://localhost:5173/success');
  await page.locator('[data-jev-run]').click();
  await expect(page.locator('#jev-test-popover')).toBeHidden();
  await expect(page.getByRole('region', { name: 'Jev live browser', exact: true })).toBeVisible();
  const request = (await calls(page, 'jev_start'))[0].args.request;
  expect(request).toMatchObject({ url: 'http://localhost:5173/game', viewport: 'mobile', maxSteps: 20, timeoutSeconds: 180, expectedText: 'Victory', expectedTitle: 'Minesweeper', expectedUrl: 'http://localhost:5173/success' });
  expect(request.goal).toContain('narrow mobile viewport');
});

test('browser Jev popover anchors, dismisses, and preserves the form during live reports', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installProbe(page);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  const trigger = page.getByRole('button', { name: 'Test with Jev', exact: true });
  const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
  await trigger.click();
  await expect(popover).toBeVisible();
  await expect(page.locator('#jev-test-url')).toBeFocused();
  const anchor = (await trigger.boundingBox())!, bounds = (await popover.boundingBox())!;
  expect(bounds.width).toBeLessThanOrEqual(420);
  expect(bounds.x + bounds.width).toBeLessThanOrEqual(1440 - 11);
  expect(bounds.y).toBeGreaterThanOrEqual(anchor.y + anchor.height);
  await page.locator('#jev-test-goal').fill('Keep my next test draft');
  await page.locator('#jev-test-goal').focus();
  await page.evaluate(() => { (window as any).__popoverInput = document.querySelector('#jev-test-goal'); });
  await emit(page, { id: 'other-run', sessionId: 'session-4', summary: 'Different task' });
  await emit(page, { status: 'running', steps: 1, events: [{ step: 1, operation: 'CLICK', target: 'Start game', url: 'http://localhost:3000/', elapsedMs: 1000 }] });
  await expect(page.locator('#jev-test-goal')).toHaveValue('Keep my next test draft');
  await expect(page.locator('#jev-test-goal')).toBeFocused();
  expect(await page.evaluate(() => (window as any).__popoverInput === document.querySelector('#jev-test-goal'))).toBe(true);
  await expect(popover).not.toContainText('Different task');
  await expect(popover).toHaveAttribute('data-popover-state', 'open');
  await page.screenshot({ path: '/private/tmp/pandacode-jev-popover-dark.png' });
  await page.keyboard.press('Escape');
  await expect(popover).toHaveCount(0);
  await expect(trigger).toBeFocused();
  await trigger.click(); await expect(popover).toBeVisible();
  await trigger.click(); await expect(popover).toHaveCount(0);
  await trigger.click(); await expect(popover).toBeVisible();
  await page.getByRole('button', { name: 'Task actions', exact: true }).click();
  await expect(popover).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('browser Jev popover fits a narrow light window and setup opens from its notice', async ({ page }) => {
  await installProbe(page);
  await page.evaluate(() => { (window as any).__jevConfig.enabled = false; });
  await page.locator('#theme-toggle').click();
  await page.setViewportSize({ width: 420, height: 700 });
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
  const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
  await expect(popover).toBeVisible();
  await expect(page.locator('[data-jev-run]')).toBeDisabled();
  await expect.poll(async () => popover.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.x >= 0 && box.right <= innerWidth && box.y >= 0 && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  await expect(popover).toHaveAttribute('data-popover-state', 'open');
  await page.screenshot({ path: '/private/tmp/pandacode-jev-popover-narrow-light.png' });
  await page.getByRole('button', { name: 'Set up Jev', exact: false }).click();
  await expect(popover).toHaveCount(0);
  await expect(dialog(page).getByRole('heading', { name: 'Jev add-on', exact: true })).toBeVisible();
});

for (const [scale, width, height] of [[1.4, 1440, 940], [1.6, 480, 780]]) {
  test(`Jev popover fits long server lists and expanded options at ${scale * 100}% text size in ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height });
    await page.addInitScript(scale => {
      localStorage.setItem('pandacode.uiScale', String(scale));
      localStorage.setItem('pandacode.sidebarWidth', '380');
      if (scale === 1.6) localStorage.setItem('pandacode.theme', 'light');
    }, scale);
    await installProbe(page);
    await expect.poll(() => page.locator('html').evaluate(element => parseFloat(getComputedStyle(element).fontSize))).toBeCloseTo(14 * scale, 2);
    await page.evaluate(() => {
      (window as any).__jevLocalServers = Array.from({ length: 12 }, (_, index) => ({
        process: `pandacode-development-server-for-very-long-project-name-${index + 1}`,
        port: 3000 + index, url: `http://localhost:${3000 + index}/`,
      }));
    });
    await page.getByRole('button', { name: 'Open browser', exact: true }).click();
    await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
    const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
    await expect(popover).toBeVisible();
    await expect(popover.locator('.jev-server-chip')).toHaveCount(12);
    await expect(popover.locator('[data-jev-run]')).toBeEnabled();
    await expect(popover).toHaveAttribute('data-popover-state', 'open');
    const capture = process.env.PANDACODE_JEV_LAYOUT_CAPTURE === 'before' ? 'before' : 'after';
    await page.screenshot({ path: `/private/tmp/pandacode-jev-layout-${capture}-${Math.round(scale * 100)}-${width}.png` });
    const overflow = () => popover.evaluate(element => {
      const box = element.getBoundingClientRect();
      const outside = Array.from(element.querySelectorAll<HTMLElement>('input,textarea,select,.jev-run-row,.jev-presets,[data-jev-run]'))
        .filter(control => control.getClientRects().length > 0)
        .filter(control => { const bounds = control.getBoundingClientRect(); return bounds.left < box.left - 1 || bounds.right > box.right + 1; })
        .map(control => control.id || control.className);
      return { horizontalScroll: element.scrollWidth > element.clientWidth + 1, outside,
        fitsViewport: box.left >= 0 && box.right <= innerWidth + 1 && box.top >= 0 && box.bottom <= innerHeight + 1 };
    });
    await expect.poll(overflow).toEqual({ horizontalScroll: false, outside: [], fitsViewport: true });
    await expect(popover.locator('[data-jev-run]')).toBeInViewport();
    await popover.locator('.jev-local-options > summary').click();
    await expect(popover.locator('.jev-server-chip').first()).toBeVisible();
    await expect.poll(overflow).toEqual({ horizontalScroll: false, outside: [], fitsViewport: true });
    await expect(popover.locator('.jev-server-port')).toHaveText(Array.from({ length: 12 }, (_, index) => `:${3000 + index}`));
    expect(await popover.locator('.jev-server-port').evaluateAll(ports => ports.every(port => {
      const box = port.getBoundingClientRect(), chip = port.closest('.jev-server-chip')!.getBoundingClientRect();
      return box.left >= chip.left && box.right <= chip.right && port.scrollWidth <= port.clientWidth + 1;
    }))).toBe(true);
    await page.screenshot({ path: `/private/tmp/pandacode-jev-layout-${capture}-${Math.round(scale * 100)}-${width}-servers.png` });
    await popover.locator('.jev-server-port').last().scrollIntoViewIfNeeded();
    await expect(popover.locator('.jev-server-port').last()).toBeInViewport({ ratio: 0.99 });
    await popover.locator('.jev-server-chip').last().click();
    await expect(popover.locator('#jev-test-url')).toHaveValue('http://localhost:3011/');
    await popover.locator('#jev-test-goal').fill('Check the primary interaction without losing the Start button.');
    await popover.locator('.jev-advanced > summary').filter({ hasText: 'Run options' }).click();
    await popover.locator('#jev-viewport').selectOption('mobile');
    await popover.locator('#jev-max-steps').fill('12');
    await popover.locator('#jev-time-limit').fill('90');
    await popover.locator('.jev-test-checks > summary').click();
    await popover.locator('#jev-expected-text').fill('Ready to play');
    await popover.locator('#jev-expected-title').fill('A game with a long descriptive title');
    await popover.locator('#jev-expected-url').fill('http://localhost:3011/ready');
    await expect.poll(overflow).toEqual({ horizontalScroll: false, outside: [], fitsViewport: true });
    const start = popover.locator('[data-jev-run]');
    await start.scrollIntoViewIfNeeded();
    await expect(start).toBeInViewport();
    await page.screenshot({ path: `/private/tmp/pandacode-jev-layout-${capture}-${Math.round(scale * 100)}-${width}-expanded.png` });
    await start.click();
    await expect.poll(async () => (await calls(page, 'jev_start')).length).toBe(1);
    expect((await calls(page, 'jev_start'))[0].args.request).toMatchObject({
      url: 'http://localhost:3011/', viewport: 'mobile', maxSteps: 12, timeoutSeconds: 90,
      expectedText: 'Ready to play', expectedTitle: 'A game with a long descriptive title', expectedUrl: 'http://localhost:3011/ready',
    });
    await expect(popover).toBeHidden();
    await expect(page.getByRole('region', { name: 'Jev live browser', exact: true })).toBeVisible();
  });
}

test('Jev popover keeps its header and Run button reachable in a short enlarged window', async ({ page }) => {
  await page.setViewportSize({ width: 480, height: 360 });
  await page.addInitScript(() => { localStorage.setItem('pandacode.uiScale', '1.6'); });
  await installProbe(page);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
  const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
  const start = popover.locator('[data-jev-run]');
  const close = popover.getByRole('button', { name: 'Close Test with Jev', exact: true });
  await expect(popover).toHaveAttribute('data-popover-state', 'open');
  await expect.poll(() => popover.evaluate(element => {
    const box = element.getBoundingClientRect();
    return box.left >= 0 && box.top >= 0 && box.right <= innerWidth && box.bottom <= innerHeight && element.scrollWidth <= element.clientWidth + 1;
  })).toBe(true);
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  const body = popover.locator('.jev-testing-body');
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  await popover.locator('.jev-advanced > summary').filter({ hasText: 'Run options' }).click();
  await popover.locator('#jev-max-steps').fill('12');
  await expect(start).toBeInViewport({ ratio: 1 });
  await expect(close).toBeInViewport({ ratio: 1 });
  await page.screenshot({ path: '/private/tmp/pandacode-jev-layout-after-160-480-short.png' });
  await close.click();
  await expect(popover).toHaveCount(0);
  expect(await calls(page, 'jev_start')).toHaveLength(0);
});

test('Jev popover keeps explanations behind accessible information buttons without losing the draft', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 680 });
  await installProbe(page);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
  const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
  const info = popover.getByRole('button', { name: 'About Jev browser tests', exact: true });
  const checksInfo = popover.getByRole('button', { name: 'About result checks', exact: true });
  await expect(popover.locator('#jev-test-help')).toBeHidden();
  await expect(popover.locator('#jev-check-help')).toBeHidden();
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await expect(popover.locator('.jev-intro,.jev-hint')).toHaveCount(0);
  await popover.locator('#jev-test-goal').fill('Keep this browser test draft while I read its help.');
  const input = await popover.locator('#jev-test-goal').elementHandle();
  await info.focus(); await page.keyboard.press('Enter');
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(popover.locator('#jev-test-help')).toBeVisible();
  await expect(popover.locator('#jev-test-help')).toContainText('separate Chrome profile');
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'false');
  await expect(popover.locator('#jev-test-help')).toBeHidden();
  await checksInfo.click();
  await expect(checksInfo).toHaveAttribute('aria-expanded', 'true');
  await expect(popover.locator('.jev-test-checks')).toHaveAttribute('open', '');
  await expect(popover.locator('#jev-check-help')).toContainText('not a verified pass');
  await expect(popover.locator('#jev-check-help')).toBeVisible();
  await checksInfo.click();
  await expect(checksInfo).toHaveAttribute('aria-expanded', 'false');
  await expect(popover.locator('#jev-check-help')).toBeHidden();
  await expect(popover.locator('.jev-test-checks')).toHaveAttribute('open', '');
  await checksInfo.click();
  await expect(popover.locator('#jev-check-help')).toBeVisible();
  await popover.locator('.jev-test-checks > summary').click({ position: { x: 20, y: 15 } });
  await expect(popover.locator('.jev-test-checks')).not.toHaveAttribute('open', '');
  await expect(checksInfo).toHaveAttribute('aria-expanded', 'false');
  await expect(popover.locator('#jev-check-help')).toBeHidden();
  await checksInfo.click();
  await expect(checksInfo).toHaveAttribute('aria-expanded', 'true');
  await expect(popover.locator('.jev-test-checks')).toHaveAttribute('open', '');
  await expect(popover.locator('#jev-check-help')).toBeVisible();
  const body = popover.locator('.jev-testing-body');
  expect(await body.evaluate(element => element.scrollHeight > element.clientHeight)).toBe(true);
  await body.evaluate(element => { element.scrollTop = element.scrollHeight; });
  await info.click();
  await expect(info).toHaveAttribute('aria-expanded', 'true');
  await expect(popover.locator('#jev-test-help')).toBeInViewport({ ratio: 0.99 });
  await expect(popover.locator('#jev-test-goal')).toHaveValue('Keep this browser test draft while I read its help.');
  expect(await input!.evaluate(element => element === document.querySelector('#jev-test-goal'))).toBe(true);
  await expect(popover.locator('[data-jev-run]')).toBeInViewport();
  expect(await calls(page, 'jev_start')).toHaveLength(0);
});

test('Jev popover uses translucent blur and respects reduced transparency preferences', async ({ page, browserName }) => {
  await installProbe(page);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await page.getByRole('button', { name: 'Test with Jev', exact: true }).click();
  const popover = page.locator('#jev-test-popover:not([aria-hidden="true"])');
  const material = () => popover.evaluate(element => {
    const style = getComputedStyle(element), canvas = document.createElement('canvas');
    canvas.width = canvas.height = 1;
    const context = canvas.getContext('2d')!;
    context.fillStyle = style.backgroundColor;
    context.fillRect(0, 0, 1, 1);
    return { alpha: context.getImageData(0, 0, 1, 1).data[3] / 255, filter: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter') };
  });
  await expect(popover).toHaveAttribute('data-popover-state', 'open');
  // The glass condenses as the popover arrives; read its material once it has settled.
  await expect.poll(() => popover.evaluate(element => element.getAnimations().length)).toBe(0);
  const glass = await material();
  expect(glass.alpha).toBeGreaterThan(0); expect(glass.alpha).toBeLessThan(1);
  expect(glass.filter).toContain('blur(');
  await page.emulateMedia({ contrast: 'more' });
  await expect.poll(material).toEqual({ alpha: 1, filter: 'none' });
  await page.emulateMedia({ contrast: 'no-preference' });
  await expect.poll(material).toEqual(glass);
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }] });
    await expect.poll(material).toEqual({ alpha: 1, filter: 'none' });
    await cdp.send('Emulation.setEmulatedMedia', { features: [] });
    await cdp.detach();
    await expect.poll(material).toEqual(glass);
  }
});

test('streaming preserves the draft DOM, isolates tasks, and never treats DONE as a verified pass', async ({ page }) => {
  await installProbe(page); await tests(page); await run(page);
  await page.locator('#jev-test-goal').fill('Keep this unsent next test');
  await page.locator('#jev-test-goal').focus();
  await page.evaluate(() => { (window as any).__originalJevInput = document.querySelector('#jev-test-goal'); });
  await emit(page, { status: 'running', durationMs: 2300, steps: 1, events: [{ step: 1, operation: 'CLICK', target: 'Start game', url: 'http://localhost:3000/', elapsedMs: 1000 }] });
  await expect(page.locator('.jev-report-status')).toHaveText('Testing');
  await expect(page.locator('#jev-test-goal')).toBeFocused();
  expect(await page.evaluate(() => (window as any).__originalJevInput === document.querySelector('#jev-test-goal'))).toBe(true);
  await emit(page, { id: 'other-run', sessionId: 'session-4', summary: 'Other task output' });
  await expect(page.locator('.jev-run-item')).toHaveCount(1);
  await expect(dialog(page)).not.toContainText('Other task output');
  await emit(page, { status: 'done', verification: 'not_checked', summary: 'Model said DONE.', durationMs: 4500 });
  await expect(page.locator('.jev-report-status')).toHaveText('Agent finished');
  await expect(page.locator('.jev-check-badge')).toHaveText('Not checked');
  await expect(page.locator('#jev-test-goal')).toHaveValue('Keep this unsent next test');
  await page.locator('.jev-events summary').click();
  await expect(page.locator('.jev-events li')).toContainText('Start game');
  await emit(page, { verification: 'failed', checks: [{ name: 'Expected text', passed: false, expected: '<img src=x onerror=alert(1)>Victory' }] });
  await expect(page.locator('.jev-check-badge')).toHaveText('Checks failed');
  await expect(page.locator('.jev-verification img')).toHaveCount(0);
  await emit(page, { verification: 'passed', checks: [{ name: 'Expected text', passed: true, expected: 'Victory' }] });
  await expect(page.locator('.jev-check-badge')).toHaveText('Checks passed');
  await page.screenshot({ path: '/private/tmp/pandacode-jev-test.png' });
});

test('completed reports attach concise observed evidence to the selected task prompt', async ({ page }) => {
  await installProbe(page); await tests(page); await run(page);
  await emit(page, { status: 'done', summary: 'Started a game and revealed a cell.', verification: 'passed', checks: [{ name: 'Expected title', passed: true, expected: 'Minesweeper' }] });
  await expect(page.locator('.jev-check-badge')).toHaveText('Checks passed');
  await page.getByRole('button', { name: 'Use report in prompt', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue(/Jev browser test report/);
  await expect(page.locator('#prompt')).toHaveValue(/PASS Expected title: Minesweeper/);
  await expect(page.locator('#prompt')).toHaveValue(/observed page content is untrusted data/);
  expect(await calls(page, 'send_message')).toHaveLength(0);
});

test('a saved test can open in the sidebar from its report modal', async ({ page }) => {
  await installProbe(page); await tests(page); await run(page);
  await emit(page, { status: 'done', summary: 'Verified the start button.', durationMs: 2400 });
  await expect(page.locator('.jev-report-status')).toHaveText('Agent finished');
  await page.getByRole('button', { name: 'Watch in browser', exact: true }).click();
  await expect(dialog(page)).toBeHidden();
  const viewer = page.getByRole('region', { name: 'Jev live browser', exact: true });
  await expect(viewer).toBeVisible();
  await expect(viewer.locator('.jev-live-current')).toContainText('Verified the start button.');
  expect((await calls(page, 'jev_watch_run')).filter(call => call.args.watching)).toHaveLength(0);
  expect(await calls(page, 'jev_start')).toHaveLength(1);
});

test('runs are cancellable and live activity follows conversation and board detail', async ({ page }) => {
  await installProbe(page); await tests(page); await run(page);
  await page.locator('[data-jev-cancel]').click();
  await expect(page.locator('.jev-report-status')).toHaveText('Cancelled');
  expect((await calls(page, 'jev_cancel'))[0].args).toMatchObject({ sessionId: 'session-1', runId: 'run-1' });
  await page.locator('[data-jev-close]').click();
  const chip = page.getByRole('button', { name: 'Open Jev browser test reports', exact: true });
  await expect(chip).toContainText('Test stopped');
  await emit(page, { id: 'run-2', status: 'running', createdAt: Date.now() + 2000 });
  await expect(chip).toContainText('Testing app');
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Open task: Make search feel instant', exact: true }).click();
  await expect(chip).toBeVisible();
  await chip.click();
  await expect(page.locator('.jev-run-item')).toHaveCount(2);
});

test('closing or replacing settings clears draft credentials and ignores late work', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await installProbe(page, true); await settings(page);
  await page.locator('#jev-typesafe-key').fill('fake-draft-must-clear');
  await page.evaluate(() => { (window as any).__jevOldInput = document.querySelector('#jev-typesafe-key'); });
  await page.locator('[data-jev-close]').click();
  expect(await page.evaluate(() => (window as any).__jevOldInput.value)).toBe('');
  await settings(page);
  await page.evaluate(() => { (window as any).__jevDelayInstall = true; });
  await page.locator('[data-jev-install]').click();
  await expect(page.locator('.jev-install-progress')).toBeVisible();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__jevReleaseInstall)).toBe('function');
  await page.evaluate(() => {
    const content = document.createElement('p'); content.textContent = 'Replacement dialog content'; document.querySelector('#dialog')!.replaceChildren(content);
  });
  await page.evaluate(() => { (window as any).__jevReleaseInstall(); });
  await expect(dialog(page)).toHaveText('Replacement dialog content');
  expect(errors).toEqual([]);
});

test('runtime errors recover and unsafe URLs never reach the native test runner', async ({ page }) => {
  await installProbe(page); await tests(page);
  for (const url of ['javascript:alert(1)', 'file:///tmp/index.html', 'http://user:pass@localhost:3000/']) {
    await page.locator('#jev-test-url').fill(url); await page.locator('[data-jev-run]').click();
    await expect(page.locator('.jev-feedback')).toContainText('without embedded credentials');
  }
  expect(await calls(page, 'jev_start')).toHaveLength(0);
  await page.evaluate(() => { (window as any).__jevFailStart = true; });
  await page.locator('#jev-test-url').fill('3000'); await page.locator('[data-jev-run]').click();
  await expect(page.locator('.jev-feedback')).toContainText('Missing TypeSafe API key');
  await expect(page.locator('[data-jev-run]')).toBeEnabled();
  await page.evaluate(() => { (window as any).__jevFailStart = false; });
  await run(page);
});

test('Jev panels stay inside a narrow viewport in both themes', async ({ page }) => {
  await installProbe(page, true); await tests(page);
  await page.setViewportSize({ width: 320, height: 900 });
  const overflow = async () => dialog(page).evaluate(element => element.scrollWidth > element.clientWidth + 1);
  for (const theme of ['dark', 'light']) {
    await page.evaluate(theme => document.documentElement.dataset.theme = theme, theme);
    await page.locator('.jev-test-checks summary').click();
    await expect(page.locator('#jev-expected-url')).toBeVisible(); expect(await overflow()).toBe(false);
    await page.locator('.jev-test-checks summary').click();
  }
  await page.screenshot({ path: '/private/tmp/pandacode-jev-narrow-light.png' });
  await page.locator('[data-jev-close]').click();
  await page.setViewportSize({ width: 1440, height: 940 }); await settings(page);
  await page.setViewportSize({ width: 280, height: 900 });
  await page.locator('.jev-advanced:not([data-jev-browser-runtime]) summary').click(); expect(await overflow()).toBe(false);
  await expect(page.locator('#jev-text-model')).toBeVisible();
});
