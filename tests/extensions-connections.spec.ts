import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-service/extension.json', 'utf8'));
const secret = 'DUMMY-T37-credential-never-return';
async function seed(page: Page) {
  await page.addInitScript(manifest => {
    const other = JSON.parse(JSON.stringify(manifest).replaceAll(manifest.id, 'other.fake-service'));
    other.contributes.connections[0].authentication = 'custom-signing';
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, other].map(manifest => ({ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }))));
  }, manifest);
  await page.goto('/?extension-connections'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function capture(page: Page, owner = manifest.id, projectId = 'project-1') {
  return page.evaluate(async ({ owner, projectId }) => {
    const reply = await (window as any).__extensionConnections.context({ op: 'capture', id: `${owner}/request`, version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', projectId, revision: 1 } });
    if (!reply.ok) throw new Error(reply.error.code); return reply.value.handle as string;
  }, { owner, projectId });
}
async function call(page: Page, handle: string, request: Record<string, unknown>, operation = 'summary', owner = manifest.id) {
  return page.evaluate(({ handle, request, operation, owner }) => (window as any).__extensionConnections.call(handle, { connection: `${owner}/api`, operation, ...request }), { handle, request, operation, owner });
}
test('extensions connections: opaque credentials, exact operation/context and typed policy errors without automatic network', async ({ page }) => {
  await seed(page); const a = await capture(page), b = await capture(page, manifest.id, 'project-2');
  expect(await page.evaluate(() => (window as any).__extensionConnections.stats())).toMatchObject({ starts: 0, grants: 0 });
  expect((await call(page, a, { op: 'status' })).value.state).toBe('disconnected');
  expect((await call(page, a, { op: 'start', credential: 'forged' })).error.code).toBe('PermissionDenied');
  const connected = (await call(page, a, { op: 'connect', secret })).value;
  expect(connected.state).toBe('connected'); expect(connected.credential).toMatch(/^[a-f0-9-]{36}$/); expect(JSON.stringify(connected)).not.toContain(secret);
  expect(await page.evaluate(() => (window as any).__extensionConnections.stats())).toMatchObject({ starts: 0, grants: 1 });
  expect((await call(page, b, { op: 'start', credential: connected.credential })).error.code).toBe('PermissionDenied');
  expect((await call(page, a, { op: 'start', credential: connected.credential }, 'undeclared')).error.code).toBe('PermissionDenied');
  expect((await call(page, a, { op: 'start', credential: connected.credential, url: 'https://evil.example' })).error.code).toBe('InvalidShape');
  const request = (await call(page, a, { op: 'start', credential: connected.credential })).value.request;
  expect((await call(page, b, { op: 'poll', request })).error.code).toBe('PermissionDenied');
  for (let i = 0; i < 3; i++) await call(page, a, { op: 'poll', request });
  const result = (await call(page, a, { op: 'poll', request })).value;
  expect(result.response).toEqual({ schemaVersion: 1, accepted: true, count: 3 }); expect(JSON.stringify(result)).not.toContain(secret);
  await call(page, a, { op: 'revoke' }); expect((await call(page, a, { op: 'poll', request })).value).toMatchObject({ error: 'PermissionDenied', response: null });
  const unsupported = await capture(page, 'other.fake-service');
  expect((await call(page, unsupported, { op: 'connect', secret }, 'summary', 'other.fake-service')).error.code).toBe('UnsupportedCapability');
  expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
});
test('extensions connections: timeout, cancel, revoke, redirects and size limits suppress late results', async ({ page }) => {
  await seed(page); const handle = await capture(page);
  for (const [operation, expected] of [['redirect', 'PermissionDenied'], ['large', 'LimitExceeded'], ['failure', 'HostUnavailable'], ['wait', 'Timeout']]) {
    const credential = (await call(page, handle, { op: 'connect', secret }, operation)).value.credential;
    const request = (await call(page, handle, { op: 'start', credential }, operation)).value.request;
    for (let i = 0; i < 15; i++) await call(page, handle, { op: 'poll', request }, operation);
    const result = (await call(page, handle, { op: 'poll', request }, operation)).value;
    expect(result).toMatchObject({ state: 'failed', error: expected, response: null }); expect(JSON.stringify(result)).not.toContain(secret);
  }
  for (const [op, expected] of [['cancel', 'Cancelled'], ['revoke', 'PermissionDenied']]) {
    const credential = (await call(page, handle, { op: 'connect', secret }, 'wait')).value.credential;
    const request = (await call(page, handle, { op: 'start', credential }, 'wait')).value.request;
    await call(page, handle, op === 'cancel' ? { op, request } : { op }, 'wait');
    expect((await call(page, handle, { op: 'poll', request }, 'wait')).value).toMatchObject({ error: expected, response: null });
  }
});
test('extensions connections: host-owned entry, button request, Escape/focus, disable and composer continuity', async ({ page }) => {
  const logs: string[] = []; page.on('console', message => logs.push(message.text()));
  await seed(page); await page.locator('#prompt').fill('core draft retained');
  const button = page.locator('[data-extension-contribution="sample.fake-service/button"]'); await button.click();
  const panel = page.getByRole('region', { name: 'Extension connection', exact: true });
  await expect(panel.getByRole('status')).toHaveText('Disconnected — no network request');
  await panel.getByLabel('Service credential', { exact: true }).fill(secret);
  await panel.getByRole('button', { name: 'Save credential and authorize operation', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Connected — no network request');
  await expect(panel.getByLabel('Service credential', { exact: true })).toHaveValue('');
  expect(await page.evaluate(() => (window as any).__extensionConnections.stats())).toMatchObject({ starts: 0 });
  await panel.getByRole('button', { name: 'Run broker request', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Request completed');
  await expect(panel.getByLabel('Sanitized connection response')).toHaveText('{"schemaVersion":1,"accepted":true,"count":3}');
  expect(await page.locator('body').textContent()).not.toContain(secret);
  await panel.getByRole('button', { name: 'Revoke connection authorization', exact: true }).click();
  await expect(panel.getByLabel('Sanitized connection response')).toBeEmpty();
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(button).toBeFocused();
  await button.click(); await panel.getByLabel('Authorized operation', { exact: true }).selectOption('wait');
  await panel.getByLabel('Service credential', { exact: true }).fill(secret); await panel.getByRole('button', { name: 'Save credential and authorize operation', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Connected — no network request');
  await panel.getByRole('button', { name: 'Run broker request', exact: true }).click(); await expect(panel.getByRole('status')).toHaveText('Request running');
  await panel.getByRole('button', { name: 'Cancel request', exact: true }).click(); await expect(panel.getByRole('status')).toHaveText('Cancelled');
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.fake-service'));
  await expect(panel).toHaveCount(0); await expect(button).toHaveCount(0); await expect(page.locator('#prompt')).toHaveValue('core draft retained');
  expect(logs.join('\n')).not.toContain(secret); expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toContain(secret);
});
test('extensions connections: no-extension workspace remains usable and installed fixture requires executable trust', async ({ page }) => {
  await page.goto('/?extension-connections'); await expect(page.locator('#prompt')).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__extensionConnections.stats())).toMatchObject({ starts: 0, grants: 0 });
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.fake-service', exact: true }).click(); await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  await page.getByRole('button', { name: 'Review executable trust sample.fake-service', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  await dialog.getByRole('button', { name: 'Review full authority', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.fake-service', exact: true }).click(); await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Open fake service', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Extension connection', exact: true }).getByRole('status')).toHaveText('Disconnected — no network request');
});
