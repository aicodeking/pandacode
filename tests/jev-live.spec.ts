import { expect, test, type Page } from '@playwright/test';

const live = (page: Page) => page.getByRole('region', { name: 'Jev live browser', exact: true });
const frame = (page: Page) => live(page).getByRole('img', { name: 'Jev browser live view', exact: true });
const report = (patch: Record<string, unknown> = {}) => ({
  id: 'run-1', sessionId: 'session-1', url: 'http://localhost:3000/',
  goal: 'Check the game controls', viewport: 'desktop', status: 'running',
  verification: 'not_checked', summary: 'Exploring the game', createdAt: 1_900_000_000_000,
  durationMs: 1_000, steps: 0, checks: [], events: [], ...patch,
});

async function installProbe(page: Page, runningTask = false): Promise<void> {
  await page.addInitScript(running => { (window as any).__jevLiveRunningTask = running; }, runningTask);
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /switch \(command\) \{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      window.__jevLiveCalls ??= [];
      window.__jevLiveCalls.push({ command, args: structuredClone(args) });
      window.__jevLiveRuns ??= {};
      window.__jevLiveEmit = (name, payload) => {
        if (name === 'jev-run') window.__jevLiveRuns[payload.id] = structuredClone(payload);
        emit(name, structuredClone(payload));
      };
      if (window.__jevLiveRunningTask) {
        const task = sessions.find(item => item.id === 'session-1');
        if (task) task.status = 'running';
      }
      if (command === 'jev_configuration') return { enabled: true, decisionsEnabled: false, pythonPath: '', chromePath: '', textModel: 'fixture-model', textBaseUrl: 'https://example.invalid/v1', typesafeKeySaved: true, textKeySaved: true };
      if (command === 'jev_list_runs') {
        const runs = structuredClone(Object.values(window.__jevLiveRuns).filter(run => run.sessionId === args.sessionId).sort((a, b) => b.createdAt - a.createdAt));
        if (window.__jevLiveDelayList) await new Promise(resolve => { window.__jevLiveReleaseList = resolve; });
        return runs;
      }
      if (command === 'jev_read_run') return structuredClone(window.__jevLiveRuns[args.runId]);
      if (command === 'jev_watch_run') return;
      if (command === 'jev_cancel') {
        const run = window.__jevLiveRuns[args.runId];
        window.__jevLiveEmit('jev-run', { ...run, status: 'cancelled', summary: 'Browser test cancelled.' });
        return;
      }
      if (command === 'jev_start') throw new Error('Live UI fixtures never start a paid browser test.');
      switch (command) {`),
    });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}

async function calls(page: Page, command: string): Promise<{ command: string; args: Record<string, any> }[]> {
  return page.evaluate(name => ((window as any).__jevLiveCalls ?? []).filter((entry: any) => entry.command === name), command);
}
async function emit(page: Page, name: string, payload: Record<string, unknown>): Promise<void> {
  await page.evaluate(({ name, payload }) => (window as any).__jevLiveEmit(name, payload), { name, payload });
}
async function openBrowser(page: Page, navigate = true): Promise<void> {
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toBeVisible();
  await expect.poll(async () => (await calls(page, 'list_local_servers')).length).toBeGreaterThan(0);
  if (navigate) {
    await page.getByRole('textbox', { name: 'Browser URL', exact: true }).fill('http://localhost:3000/game');
    await page.getByRole('button', { name: 'Open URL', exact: true }).click();
    await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
  }
}
async function image(page: Page, accent = '#d8bd5e'): Promise<string> {
  return page.evaluate(accent => {
    const canvas = document.createElement('canvas'); canvas.width = 960; canvas.height = 640;
    const context = canvas.getContext('2d')!;
    context.fillStyle = '#203e36'; context.fillRect(0, 0, 960, 640);
    context.fillStyle = '#f3eddb'; context.font = '500 32px sans-serif'; context.fillText('A little room to play', 80, 82);
    context.fillStyle = '#a3b8aa'; context.font = '18px sans-serif'; context.fillText('MINESWEEPER  /  EASY', 80, 116);
    for (let row = 0; row < 6; row++) for (let column = 0; column < 10; column++) {
      context.fillStyle = row < 2 && column < 4 ? '#9cb29f' : accent;
      context.fillRect(80 + column * 64, 170 + row * 64, 56, 56);
    }
    context.fillStyle = '#f3eddb'; context.font = '17px sans-serif'; context.fillText('10 mines     00:18', 80, 606);
    return canvas.toDataURL('image/jpeg', .65);
  }, accent);
}
async function emitFrame(page: Page, dataUrl: string, patch: Record<string, unknown> = {}): Promise<void> {
  await emit(page, 'jev-frame', { sessionId: 'session-1', runId: 'run-1', sequence: 1, dataUrl, width: 960, height: 640, elapsedMs: 1_500, ...patch });
}
async function watched(page: Page, runId: string, watching: boolean): Promise<boolean> {
  return (await calls(page, 'jev_watch_run')).some(call => call.args.runId === runId && call.args.watching === watching);
}

test('auto-watches a running agent task, streams frames and actions, and preserves the frame element', async ({ page }) => {
  await installProbe(page, true); await openBrowser(page);
  await expect(page.getByRole('button', { name: 'Attach screenshot', exact: true })).toBeDisabled();
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  await expect.poll(() => watched(page, 'run-1', true)).toBe(true);
  const firstImage = await image(page);
  await emitFrame(page, firstImage);
  await expect(frame(page)).toHaveAttribute('src', firstImage);
  await frame(page).evaluate(element => { (window as any).__jevLiveOriginalFrame = element; });
  await emit(page, 'jev-run', report({ durationMs: 2_400, steps: 2, events: [
    { step: 1, operation: 'CLICK', target: 'New game', url: 'http://localhost:3000/game', elapsedMs: 1_100 },
    { step: 2, operation: 'CLICK', target: 'Reveal the center tile', url: 'http://localhost:3000/game', elapsedMs: 2_200 },
  ] }));
  await expect(live(page).locator('.jev-live-current')).toContainText('Reveal the center tile');
  await live(page).locator('summary').filter({ hasText: 'Browser actions' }).click();
  await expect(live(page)).toContainText('New game');
  await emitFrame(page, await image(page, '#c6d9b5'), { sequence: 2, elapsedMs: 2_500 });
  expect(await frame(page).evaluate(element => element === (window as any).__jevLiveOriginalFrame)).toBe(true);
  await page.screenshot({ path: '/private/tmp/pandacode-jev-live-dark.png' });
  await page.locator('#theme-toggle').click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'light');
  await page.screenshot({ path: '/private/tmp/pandacode-jev-live-light.png' });
  await page.setViewportSize({ width: 390, height: 844 });
  // Crossing the compact-layout breakpoint closes the inspector by design.
  await expect(page.getByRole('region', { name: 'Browser', exact: true })).toBeHidden();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(live(page)).toBeVisible();
  await emitFrame(page, firstImage, { sequence: 3 });
  await expect(frame(page)).toHaveAttribute('src', firstImage);
  const bounds = await live(page).boundingBox();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(391);
  expect(await live(page).evaluate(element => element.scrollWidth <= element.clientWidth + 1)).toBe(true);
  await page.screenshot({ path: '/private/tmp/pandacode-jev-live-narrow.png' });
  expect(await calls(page, 'jev_start')).toHaveLength(0);
});

test('keeps reports, frames, and watch leases isolated when changing tasks', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report({ id: 'other-run', sessionId: 'session-4', goal: 'Other task only' }));
  await expect(live(page)).toBeHidden();
  expect(await watched(page, 'other-run', true)).toBe(false);
  await emit(page, 'jev-run', report());
  const source = await image(page); await emitFrame(page, source);
  await expect(frame(page)).toHaveAttribute('src', source);
  await emitFrame(page, await image(page, '#ee9999'), { sessionId: 'session-4', runId: 'other-run', sequence: 10 });
  await expect(frame(page)).toHaveAttribute('src', source);
  await expect(live(page)).not.toContainText('Other task only');
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  // Inspector panels are per thread: open this task's browser.
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect.poll(() => watched(page, 'other-run', true)).toBe(true);
  await expect(live(page)).toContainText('Other task only');
  expect((await calls(page, 'jev_watch_run')).filter(call => call.args.runId === 'other-run').every(call => call.args.sessionId === 'session-4')).toBe(true);
});

test('lets the user choose between simultaneous runs and rejects frames from the other run', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await emit(page, 'jev-run', report({ id: 'run-2', goal: 'Check the mobile menu', createdAt: 1_900_000_001_000 }));
  const select = live(page).getByRole('combobox', { name: 'Jev run', exact: true });
  await expect(select).toBeVisible();
  await expect(select.locator('option')).toHaveCount(2);
  await select.selectOption('run-2');
  await expect.poll(() => watched(page, 'run-2', true)).toBe(true);
  const secondImage = await image(page, '#dbbea5');
  await emitFrame(page, secondImage, { runId: 'run-2' });
  await expect(frame(page)).toHaveAttribute('src', secondImage);
  await select.selectOption('run-1');
  await expect.poll(() => watched(page, 'run-2', false)).toBe(true);
  const firstImage = await image(page); await emitFrame(page, firstImage, { sequence: 2 });
  await expect(frame(page)).toHaveAttribute('src', firstImage);
  await emitFrame(page, secondImage, { runId: 'run-2', sequence: 2 });
  await emit(page, 'jev-run', report({ id: 'run-2', goal: 'Check the mobile menu', summary: 'Another step', createdAt: 1_900_000_001_000, steps: 2 }));
  await expect(select).toHaveValue('run-1');
  await expect(frame(page)).toHaveAttribute('src', firstImage);
});

test('returning to the browser restores the guest and keeps dismissed runs closed until requested', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  await expect.poll(async () => (await calls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
  await live(page).getByRole('button', { name: 'Return to browser', exact: true }).click();
  await expect(live(page)).toBeHidden();
  await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toHaveValue('http://localhost:3000/game');
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  await expect.poll(async () => (await calls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
  await emit(page, 'jev-run', report({ steps: 3, summary: 'Keep working in the background' }));
  await expect(live(page)).toBeHidden();
  expect(await calls(page, 'jev_cancel')).toHaveLength(0);
  await page.getByRole('button', { name: 'Watch Jev', exact: true }).click();
  await expect(live(page)).toBeVisible();
  await expect(live(page)).toContainText('Keep working in the background');
});

test('a late history response cannot replace the page the user has just opened', async ({ page }) => {
  await installProbe(page);
  await page.evaluate(run => {
    (window as any).__jevLiveRuns[run.id] = run;
    (window as any).__jevLiveDelayList = true;
  }, report({ createdAt: Date.now() - 10_000 }));
  await openBrowser(page);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__jevLiveReleaseList)).toBe('function');
  await page.evaluate(() => {
    (window as any).__jevLiveDelayList = false;
    (window as any).__jevLiveReleaseList();
  });
  await expect(page.getByRole('button', { name: 'Watch Jev', exact: true })).toBeVisible();
  await expect(live(page)).toBeHidden();
  await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
  await expect(page.getByRole('textbox', { name: 'Browser URL', exact: true })).toHaveValue('http://localhost:3000/game');
  expect(await watched(page, 'run-1', true)).toBe(false);
  await page.getByRole('button', { name: 'Watch Jev', exact: true }).click();
  await expect(live(page)).toBeVisible();
  await expect.poll(() => watched(page, 'run-1', true)).toBe(true);
});

test('stops only the selected test and releases its live watch when it finishes', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  await live(page).getByRole('button', { name: 'Stop test', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'jev_cancel')).length).toBe(1);
  expect((await calls(page, 'jev_cancel'))[0].args).toEqual({ sessionId: 'session-1', runId: 'run-1' });
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  await expect(live(page).locator('.jev-live-status')).toContainText('Cancelled');
  await live(page).getByRole('button', { name: 'Return to browser', exact: true }).click();
  await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
  await expect.poll(async () => (await calls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(true);
});

test('switches a finished live view to the next running test', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  await emit(page, 'jev-run', report({ status: 'done', summary: 'Initial flow finished', durationMs: 3_400 }));
  await expect(live(page).locator('.jev-live-status')).toContainText('Finished');
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  await emit(page, 'jev-run', report({ id: 'run-2', goal: 'Check the settings flow', createdAt: 1_900_000_001_000 }));
  await expect(live(page).getByRole('combobox', { name: 'Jev run', exact: true })).toHaveValue('run-2');
  await expect(live(page).locator('.jev-live-status')).toContainText('Testing');
  await expect.poll(() => watched(page, 'run-2', true)).toBe(true);
  const source = await image(page); await emitFrame(page, source, { runId: 'run-2' });
  await expect(frame(page)).toHaveAttribute('src', source);
});

test('renews the live lease while visible and cleans it up when the browser closes', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  const renewals = async () => (await calls(page, 'jev_watch_run')).filter(call => call.args.runId === 'run-1' && call.args.watching).length;
  await expect.poll(renewals, { timeout: 7_500 }).toBeGreaterThanOrEqual(2);
  await page.getByRole('button', { name: 'Close browser', exact: true }).click();
  await expect(live(page)).toBeHidden();
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  const afterClose = await renewals();
  await page.waitForTimeout(5_200);
  expect(await renewals()).toBe(afterClose);
  expect(await calls(page, 'jev_cancel')).toHaveLength(0);
});

test('pauses the watch and ignores frames while the window is hidden, then resumes', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  await expect.poll(() => watched(page, 'run-1', true)).toBe(true);
  const source = await image(page); await emitFrame(page, source);
  await expect(frame(page)).toHaveAttribute('src', source);
  const activeLeases = () => calls(page, 'jev_watch_run').then(entries => entries.filter(entry => entry.args.runId === 'run-1' && entry.args.watching).length);
  const beforeHide = await activeLeases();
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => watched(page, 'run-1', false)).toBe(true);
  const changed = await image(page, '#a7c8e2');
  await emitFrame(page, changed, { sequence: 100 });
  await expect(frame(page)).toHaveAttribute('src', source);
  expect(await activeLeases()).toBe(beforeHide);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(activeLeases).toBeGreaterThan(beforeHide);
  await emitFrame(page, changed, { sequence: 2 });
  await expect(frame(page)).toHaveAttribute('src', changed);
});

test('does not render unsafe, stale, oversized, or mismatched live images', async ({ page }) => {
  await installProbe(page); await openBrowser(page);
  await emit(page, 'jev-run', report());
  await expect(live(page)).toBeVisible();
  const source = await image(page); await emitFrame(page, source, { sequence: 5 });
  await expect(frame(page)).toHaveAttribute('src', source);
  const changed = await image(page, '#ffdddd');
  for (const patch of [
    { dataUrl: 'javascript:alert(1)' },
    { dataUrl: 'https://example.invalid/track.jpg' },
    { dataUrl: 'data:image/svg+xml,<svg onload="alert(1)" />' },
    { dataUrl: 'data:image/jpeg;base64,' + 'a'.repeat(400_000) },
    { dataUrl: changed, sessionId: 'session-4' },
    { dataUrl: changed, runId: 'unrelated-run' },
    { dataUrl: changed, width: 0 },
    { dataUrl: changed, height: -1 },
    { dataUrl: changed, sequence: 4 },
  ]) {
    await emitFrame(page, source, { sequence: 6, ...patch });
    await expect(frame(page)).toHaveAttribute('src', source);
  }
  await emitFrame(page, changed, { sequence: 6 });
  await expect(frame(page)).toHaveAttribute('src', changed);
  await emit(page, 'jev-run', report({ steps: 1, events: [{ step: 1, operation: 'CLICK', target: '<img src=x onerror=alert(1)>', url: 'http://localhost:3000/', elapsedMs: 100 }] }));
  await expect(live(page).locator('.jev-live-current')).toContainText('<img src=x onerror=alert(1)>');
  await expect(live(page).locator('img')).toHaveCount(1);
});
