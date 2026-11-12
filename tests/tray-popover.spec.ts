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
