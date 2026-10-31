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
