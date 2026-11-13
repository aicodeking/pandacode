import { test, expect } from '@playwright/test';

for (const fallback of ['legacy', 'missing']) test(`extensions remote: ${fallback} peer refuses execution and preserves readable history and keyboard recovery`, async ({ page }) => {
  await page.addInitScript(fallback => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    (window as any).__extensionRemotePeer = fallback === 'legacy' ? {} : { apiVersion: 1, deviceId: 'host-a', placements: ['workspace'], protocols: ['conversation.v1'], providers: [] };
  }, fallback);
  await page.goto('/?extensions-baseline&provider-history');
  const notice = page.locator('[data-provider-recovery]');
  await expect(notice).toBeVisible();
  const before = await page.evaluate(() => (window as any).__providerHistory.state());
  const error = await page.evaluate(async () => {
    try { await (window as any).__providerHistory.call('remote_start_task', { deviceId: 'host-a', projectId: 'project-1', provider: 'sample.fake-harness/recorded', model: 'recorded-model', startId: 'captured-start', prompt: 'Do not run locally' }); }
    catch (error) { return String(error); }
  });
  expect(error).toContain(fallback === 'legacy' ? 'UnsupportedCapability' : 'MissingProvider');
  expect(error).toContain('History');
  expect(await page.evaluate(() => (window as any).__providerHistory.state())).toEqual(before);
  expect(await page.evaluate(() => (window as any).__remoteStarts ?? [])).toEqual([]);
  await expect(page.locator('#transcript')).toContainText(before.messages.find((message: any) => message.role === 'user').content);
  await notice.getByRole('button', { name: 'Change provider', exact: true }).focus();
  await page.keyboard.press('Enter');
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Harness and model', exact: true })).toHaveCount(0);
});
