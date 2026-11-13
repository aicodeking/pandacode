import { test, expect } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifests = ['provider', 'consumer'].map(kind => JSON.parse(readFileSync(`examples/extensions/service-${kind}/package/extension.json`, 'utf8')));
test('extensions services: authenticated captured context, typed errors, disable cleanup and host UI Escape', async ({ page }) => {
  await page.addInitScript(manifests => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(manifests.map(manifest => ({ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } })))), manifests);
  await page.goto('/?extension-services'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#prompt').fill('unrelated draft');
  const button = page.locator('[data-extension-contribution="sample.service-consumer/button"]'); await button.click();
  const panel = page.getByRole('region', { name: 'Executable command', exact: true });
  await expect(panel).toContainText('sample.service-provider/greeting @ 1.0.0');
  await expect(panel.getByRole('button', { name: 'Allow public services and run', exact: true })).toBeEnabled();
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(button).toBeFocused();
  const result = await page.evaluate(async () => {
    const api = (window as any).__extensionServices;
    const captured = await api.context({ op: 'capture', id: 'sample.service-consumer/greet', version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', projectId: 'project-1', revision: 1 } });
    const handle = captured.value.handle;
    const request = { op: 'start', service: 'sample.service-provider/greeting', version: '1.0.0', method: 'hello', input: 'PandaCode' };
    const denied = await api.call(handle, request);
    await api.call(handle, { op: 'grant', service: request.service, allow: true });
    const privateCall = await api.call(handle, { ...request, method: 'privateMethod' });
    const wrongVersion = await api.call(handle, { ...request, version: '2.0.0' });
    const started = await api.call(handle, request);
    const exchange = await api.call(handle, { op: 'poll', request: started.value.request });
    await (window as any).__previewDisableExtension('sample.service-provider');
    const stale = await api.call(handle, { op: 'poll', request: started.value.request });
    return { denied, privateCall, wrongVersion, exchange, stale };
  });
  expect(result.denied.error.code).toBe('PermissionDenied'); expect(result.privateCall.error.code).toBe('PermissionDenied'); expect(result.wrongVersion.error.code).toBe('IncompatibleApi');
  expect(result.exchange.value.output).toBe('Hello PandaCode'); expect(result.exchange.value.events[0].value).toContain('sample.service-consumer; project project-1'); expect(result.stale.error.code).toBe('StaleContext');
  await expect(page.locator('#prompt')).toHaveValue('unrelated draft');
});
test('extensions services: zero extensions does not affect core composer', async ({ page }) => {
  await page.goto('/?extension-services'); await expect(page.locator('#prompt')).toBeEnabled(); await page.locator('#prompt').fill('core operational'); await expect(page.locator('#prompt')).toHaveValue('core operational');
});
