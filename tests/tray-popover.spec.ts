import { expect, test } from '@playwright/test';

test('menu bar popover lists tasks and plan usage and opens a task', async ({page}) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.setViewportSize({width:340,height:560});
  await page.goto('/?view=tray');
  await expect(page.locator('.tray-summary')).toHaveText('2 running · 3 to review');
  await expect(page.locator('.tray-section h2')).toHaveText(['Running', 'Needs you', 'Finished', 'Plan usage']);
  await expect(page.locator('.tray-row')).toHaveCount(5);
  await expect(page.locator('.tray-row[data-id="tray-running-1"] .tray-spinner')).toBeVisible();
  await expect(page.locator('.tray-row[data-id="tray-waiting"] .tray-pill')).toHaveText('Respond');
  await expect(page.locator('.tray-row[data-id="tray-failed"] .tray-result.failed')).toBeVisible();
  await expect(page.locator('.tray-usage')).toHaveCount(2);
  await expect(page.locator('.tray-window')).toHaveCount(3);
  await expect(page.locator('.tray-window[data-tone="high"]')).toHaveCount(1);
  await expect(page.locator('.tray-window[data-tone="exhausted"]')).toHaveCount(1);
  await expect(page.locator('.tray-bar').first()).toHaveAttribute('aria-valuenow', '42');
  await page.screenshot({path:'test-results/tray-popover.png'});

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
