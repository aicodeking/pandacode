import { expect, test } from '@playwright/test';

for (const [running, review] of [[2, 3], [10, 20]]) {
  test(`menu bar header fits ${running} running and ${review} to review at native width`, async ({page}) => {
    const tasks = (count: number, kind: string) => Array.from({length: count}, (_, index) => ({
      id: `${kind}-${index}`, title: 'Tray layout fixture', project: 'PandaCode', provider: 'codex', at: 1_800_000_000_000,
    }));
    const snapshot = {running: tasks(running, 'running'), waiting: tasks(review, 'waiting'), finished: [], usage: [], checking: false};
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text();
      const marker = /\(window\.__trayCalls \?\?= \[\]\)\.push\(\{ command, args \}\);/;
      expect(source).toMatch(marker);
      await route.fulfill({response, body: source.replace(marker, match => `${match} if (command === 'tray_snapshot') return ${JSON.stringify(snapshot)};`)});
    });
    await page.setViewportSize({width:340,height:560});
    await page.goto('/?view=tray');
    await expect(page.locator('.tray-summary')).toHaveText(`${running} running · ${review} to review`);
    const open = page.locator('header .tray-open-app');
    await expect(open).toHaveAccessibleName('Open PandaCode');
    await expect(open).toHaveCSS('width', '28px');
    const layout = await page.locator('.tray-header').evaluate(header => {
      const summary = header.querySelector('.tray-summary')!;
      const text = document.createRange(); text.selectNodeContents(summary);
      const button = header.querySelector('button')!.getBoundingClientRect();
      return {
        rightInset: header.getBoundingClientRect().right - parseFloat(getComputedStyle(header).paddingRight),
        buttonRight: button.right, buttonLeft: button.left,
        brandRight: header.querySelector('strong')!.getBoundingClientRect().right,
        summaryLeft: summary.getBoundingClientRect().left, summaryWidth: summary.getBoundingClientRect().width,
        textRight: text.getBoundingClientRect().right, textWidth: text.getBoundingClientRect().width,
      };
    });
    expect(layout.buttonRight).toBeLessThanOrEqual(layout.rightInset + 0.1);
    expect(layout.summaryLeft).toBeGreaterThanOrEqual(layout.brandRight);
    expect(layout.textRight).toBeLessThanOrEqual(layout.buttonLeft);
    expect(layout.textWidth).toBeLessThanOrEqual(layout.summaryWidth + 0.1);
  });
}

test('menu bar popover lists tasks and plan usage and opens a task', async ({page}, testInfo) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:340,height:560});
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-summary')).toHaveText('2 running · 3 to review');
  const header = page.locator('.tray-header');
  expect(await header.evaluate(node => node.scrollWidth <= node.clientWidth)).toBe(true);
  await expect(page.locator('header .tray-open-app')).toHaveCSS('width', '28px');
  await expect(page.locator('.tray-section h2')).toHaveText(['Running', 'Needs you', 'Finished', 'Plan usage']);
  await expect(page.locator('.tray-row')).toHaveCount(5);
  await expect(page.locator('.tray-row[data-id="tray-running-1"] .tray-spinner')).toBeVisible();
  await expect(page.locator('.tray-row[data-id="tray-waiting"] .tray-pill')).toHaveText('Respond');
  expect(await page.locator('.tray-pill').evaluate(node => {
    const style = getComputedStyle(node);
    return parseFloat(style.lineHeight) / parseFloat(style.fontSize);
  })).toBeCloseTo(1.3, 3);
  await expect(page.locator('.tray-row[data-id="tray-failed"] .tray-result.failed')).toBeVisible();
  await expect(page.locator('.tray-usage')).toHaveCount(2);
  await expect(page.locator('.tray')).toHaveCSS('border-radius', '16px');
  await expect(page.locator('.tray')).toHaveCSS('padding', '6px');
  await expect(page.locator('.tray-mark')).toHaveCSS('border-radius', '6px');
  await expect(page.locator('.tray-section').first()).toHaveCSS('border-radius', '10px');
  await expect(page.locator('.tray-plan')).toHaveCSS('border-radius', '10px');
  await expect(page.locator('.tray-row').first()).toHaveCSS('border-top-left-radius', '8px');
  await expect(page.locator('.tray-row').last()).toHaveCSS('border-bottom-right-radius', '8px');
  await expect(page.locator('.tray-usage').first()).toHaveCSS('border-top-left-radius', '8px');
  await expect(page.locator('.tray-usage').first()).toHaveCSS('border-top-right-radius', '8px');
  await expect(page.locator('.tray-usage').last()).toHaveCSS('border-bottom-left-radius', '8px');
  await expect(page.locator('.tray-usage').last()).toHaveCSS('border-bottom-right-radius', '8px');
  await expect(page.locator('.tray-window')).toHaveCount(3);
  await expect(page.locator('.tray-window[data-tone="high"]')).toHaveCount(1);
  await expect(page.locator('.tray-window[data-tone="exhausted"]')).toHaveCount(1);
  await expect(page.locator('.tray-bar').first()).toHaveAttribute('aria-valuenow', '42');
  await page.screenshot({path:testInfo.outputPath('tray-popover.png')});

  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await expect(page.locator('.tray-row[data-id="tray-running-2"]')).toBeFocused();
  await page.locator('.tray-row[data-id="tray-done"]').click();
  const calls = () => page.evaluate(() => (window as any).__trayCalls as {command:string;args:Record<string,unknown>}[]);
  await expect.poll(calls).toContainEqual({command:'tray_open', args:{sessionId:'tray-done'}});
  expect((await calls()).some(call => call.command === 'tray_resize' && Number(call.args.height) > 100)).toBe(true);
  expect(errors).toEqual([]);
});

test('a failing tray command shows one stable alert, Dismiss removes it and a later success clears it', async ({page}) => {
  await page.setViewportSize({width:340,height:560});
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /\(window\.__trayCalls \?\?= \[\]\)\.push\(\{ command, args \}\);/;
    expect(source).toMatch(marker);
    await route.fulfill({response, body: source.replace(marker, match => `${match} if (window.__trayFail && (command === 'tray_show_app' || command === 'tray_refresh_usage')) throw new Error('Window is gone');`)});
  });
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-row')).toHaveCount(5);
  // The live region is the text only; the box and its Dismiss button sit outside it.
  const alert = page.getByRole('alert'), box = page.locator('.tray-alert');
  await expect(alert).toBeEmpty();
  await expect(alert).toHaveCount(1);
  await expect(box.getByRole('button', {name: 'Dismiss error', includeHidden: true})).toBeHidden();
  await page.evaluate(() => { (window as any).__trayFail = true; });
  await page.locator('footer .tray-open-app').click();
  await expect(alert).toHaveText('Window is gone');
  expect(await alert.evaluate(node => node.closest('button') === null && !node.querySelector('button'))).toBe(true);
  expect(await alert.textContent()).not.toContain('Dismiss');
  const dismiss = box.getByRole('button', {name: 'Dismiss error'});
  expect((await dismiss.boundingBox())!.height).toBe(28);
  await expect(box.locator('.tray-alert-icon')).toHaveAttribute('data-state-tone', 'danger');
  // A second failure with the same text re-renders the list but leaves the alert's nodes alone (a rewrite would re-announce it).
  await alert.evaluate(node => { (node as any).__text = node; });
  await page.locator('.tray-refresh').click();
  await expect.poll(() => page.evaluate(() => (window as any).__trayCalls.filter((c: any) => c.command === 'tray_refresh_usage').length)).toBe(1);
  await expect(page.locator('.tray-refresh.checking')).toHaveCount(0);
  expect(await alert.evaluate(node => (node as any).__text === document.querySelector('.tray-alert-text') && node.isConnected)).toBe(true);
  await dismiss.click();
  await expect(alert).toBeEmpty();
  await expect(page.locator('header .tray-open-app')).toBeFocused();
  // A second failure shows again; a later success clears it without a click on Dismiss.
  await page.locator('footer .tray-open-app').click();
  await expect(alert).toContainText('Window is gone');
  await page.evaluate(() => { (window as any).__trayFail = false; });
  await page.locator('footer .tray-open-app').click();
  await expect(alert).toBeEmpty();
});

test('menu bar popover keeps a Claude row without limits, with the panel state label, and dates a saved snapshot', async ({page}) => {
  // A fixed day: the printed reset below (Nov 15) is still ahead.
  await page.clock.setFixedTime(new Date(2026, 10, 10, 12, 0));
  await page.setViewportSize({width:340,height:640});
  await page.addInitScript(() => {
    // Yesterday morning: an older snapshot is dated, as in the panel.
    const now = new Date();
    const taken = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5).getTime();
    (window as any).__trayExtraUsage = [
      { provider: 'kimi', status: 'error', action: 'claude', stale: false, checkedAt: Date.now(), windows: [] },
      { provider: 'glm', status: 'error', action: 'rateLimited', stale: false, checkedAt: Date.now(), windows: [] },
      { provider: 'deepseek', status: 'ready', action: 'refresh', stale: true, checkedAt: taken, windows: [{ label: 'Weekly', usedPercent: 30, resetsAt: null }] },
      { provider: 'mimo', status: 'error', action: 'updateClaude', stale: false, checkedAt: Date.now(), windows: [] },
      { provider: 'grok', status: 'ready', stale: false, checkedAt: Date.now(), windows: [{ label: 'Weekly', usedPercent: 48, resetsAt: null, detail: 'Resets Nov 15 at 8pm (America/New_York)' }] },
    ];
  });
  await page.goto('/?view=tray');
  const row = (name: string) => page.locator('.tray-usage', { hasText: name });
  await expect(row('Kimi').locator('.tray-state')).toHaveText('Sign in via Claude Code');
  await expect(row('GLM').locator('.tray-state')).toHaveText('Rate limited');
  await expect(row('MiMo').locator('.tray-state')).toHaveText('Update Claude Code');
  // Without a reset time, the reset as Claude Code printed it, without its time zone.
  await expect(row('Grok').locator('.tray-reset')).toHaveText('resets Nov 15 at 8pm');
  const saved = row('DeepSeek');
  await expect(saved.locator('.tray-window')).toHaveCount(1);
  const label = await page.evaluate(() => {
    const now = new Date();
    const taken = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1, 9, 5);
    return `${taken.toLocaleDateString([], { month: 'short', day: 'numeric' })}, ${taken.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`;
  });
  expect(label).toMatch(/\d.*,/);
  await expect(saved.locator('.tray-stale')).toHaveText(`saved ${label}`);
  await expect(saved.locator('.tray-stale')).toHaveAttribute('title', 'Saved · needs refresh');
});

test('menu bar shows "Asking Claude Code…" on the Claude row while PandaCode runs it', async ({page}) => {
  await page.setViewportSize({width:340,height:640});
  await page.addInitScript(() => { (window as any).__trayAskingClaude = true; });
  await page.goto('/?view=tray');
  const claude = page.locator('.tray-usage', { hasText: 'Claude' }).first();
  await expect(claude.locator('.tray-asking')).toHaveText('Asking Claude Code…');
  await expect(page.locator('.tray-usage', { hasText: 'Codex' }).locator('.tray-asking')).toHaveCount(0);
});

/** Each tray_snapshot waits for the spec to release it (window.__trayRelease(index, patch)), so replies can be held. */
async function holdSnapshots(page: import('@playwright/test').Page): Promise<void> {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /\(window\.__trayCalls \?\?= \[\]\)\.push\(\{ command, args \}\);/;
    expect(source).toMatch(marker);
    await route.fulfill({response, body: source.replace(marker, match => `${match}
      if (command === 'tray_snapshot' && !window.__trayInner) window.__trayRequests = (window.__trayRequests ?? 0) + 1;
      if (command === 'tray_snapshot' && window.__trayHold && !window.__trayInner) {
        const pending = (window.__trayPending ??= []);
        return new Promise(resolve => pending.push(patch => { window.__trayInner = true; try { resolve({ ...trayCommand(command, args), ...patch }); } finally { window.__trayInner = false; } }));
      }`)});
  });
}
/** Snapshot requests the popover made (a held reply's own trayCommand call is not one). */
const requests = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__trayRequests as number);
const snapshots = (page: import('@playwright/test').Page) => page.evaluate(() => ((window as any).__trayCalls as {command:string}[]).filter(call => call.command === 'tray_snapshot').length);
const emit = (page: import('@playwright/test').Page) => page.evaluate(() => (window as any).__previewEmit('tray-changed', {}));

test('a burst of tray-changed events costs at most two snapshots, one at a time, and the newest state lands', async ({page}) => {
  await page.setViewportSize({width:340,height:560});
  await holdSnapshots(page);
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-row')).toHaveCount(5);
  await page.evaluate(() => { (window as any).__trayHold = true; });
  const pending = () => page.evaluate(() => ((window as any).__trayPending ?? []).length as number);
  const release = (index: number, patch: Record<string, unknown>) => page.evaluate(([at, value]) => (window as any).__trayPending[at as number](value), [index, patch] as const);
  const from = await requests(page);
  // A usage check sends one event per provider: five in a row.
  for (let i = 0; i < 5; i++) await emit(page);
  await expect.poll(pending).toBe(1);
  await page.waitForTimeout(200);
  expect(await pending(), 'one request in flight').toBe(1);
  // The first reply (still checking) lands; the changes that came meanwhile ask once more, for the newer state.
  await release(0, { checking: true });
  await expect.poll(pending).toBe(2);
  await release(1, { checking: false, running: [] });
  await expect(page.locator('.tray-summary')).toHaveText('3 to review');
  await expect(page.locator('.tray-refresh.checking')).toHaveCount(0);
  await expect(page.locator('.tray-row')).toHaveCount(3);
  await page.waitForTimeout(300);
  expect(await requests(page) - from, 'snapshots for a burst of five').toBeLessThanOrEqual(2);
  expect(await pending()).toBe(2);
});

test('a hidden popover loads nothing on tray-changed, and loads once, fresh, when it is shown', async ({page}) => {
  await page.setViewportSize({width:340,height:560});
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-row')).toHaveCount(5);
  // The popover hides on blur (tray.rs): the document has no focus while it is hidden.
  await page.evaluate(() => { document.hasFocus = () => false; window.dispatchEvent(new Event('blur')); });
  const from = await snapshots(page);
  for (let i = 0; i < 5; i++) await emit(page);
  await page.waitForTimeout(400);
  expect(await snapshots(page) - from, 'snapshots while hidden').toBe(0);
  await page.evaluate(() => { delete (document as any).hasFocus; window.dispatchEvent(new Event('focus')); });
  await expect.poll(async () => await snapshots(page) - from).toBe(1);
  await page.waitForTimeout(300);
  expect(await snapshots(page) - from, 'snapshots on show').toBe(1);
});

test('menu bar empty plan nests quietly while standalone empty stays an inner card', async ({page}) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    const marker = /\(window\.__trayCalls \?\?= \[\]\)\.push\(\{ command, args \}\);/;
    expect(source).toMatch(marker);
    const snapshot = {running: [], waiting: [], finished: [], usage: [], checking: false};
    await route.fulfill({response, body: source.replace(marker, match => `${match} if (command === 'tray_snapshot') return ${JSON.stringify(snapshot)};`)});
  });
  await page.setViewportSize({width:340,height:560});
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-empty')).toHaveText('No agents running.');
  await expect(page.locator('.tray-empty')).toHaveCSS('border-radius', '10px');
  await expect(page.locator('.tray-plan')).toHaveCSS('border-radius', '10px');
  const quiet = page.locator('.tray-plan > .tray-quiet');
  await expect(quiet).toHaveText('No plan limits reported.');
  await expect(quiet).toHaveCSS('border-radius', '8px');
});
