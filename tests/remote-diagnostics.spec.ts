import { expect, test } from '@playwright/test';

test('connect diagnostics shows stages, routes and events, and reconnects', async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(async () => {
    const host = document.createElement('div');
    host.id = 'diag-host';
    document.body.append(host);
    const mod = await import(/* @vite-ignore */ '/src/remote-diagnostics.ts');
    mod.mountRemoteDiagnostics(host);
  });
  const panel = page.locator('#diag-host');
  await expect(panel.locator('.diag-stages li')).toHaveCount(5);
  await expect(panel.locator('.diag-stages li').first()).toContainText('Signed in');
  await expect(panel.locator('.diag-stages li[data-ok="true"]')).toHaveCount(5);
  await expect(panel.locator('.diag-routes tbody tr')).toHaveCount(3);
  await expect(panel.locator('.diag-routes tbody tr').first()).toContainText('Studio iMac');
  await expect(panel.locator('.diag-routes tbody tr').first()).toContainText('4 ms');
  await expect(panel.locator('.diag-event').first()).toContainText('route.direct');
  await panel.getByRole('button', { name: 'Refresh' }).click();
  await expect(panel.locator('.diag-event')).toHaveCount(4);
  await panel.getByRole('button', { name: 'Reconnect now' }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__remoteReconnects)).toBe(1);
});
