import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0802 (private package secrets). The browser preview runs no package code: these are the synthetic
// stand-ins of src/extensions/runtime-private-secrets.ts following the native rules. The real host-side behaviour
// (file store, grants, cross-package isolation) is the native test module `runtime_private_secrets::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-private-secrets/extension.json'));
const other = { ...manifest, id: 'sample.other-package', runtime: { ...manifest.runtime, activationEvents: ['sample.other-package/store'] }, contributes: { commands: [{ id: 'sample.other-package/store', title: 'Other', action: { kind: 'runCommand' } }] } };
const ID = manifest.id, OTHER = other.id;
const CANARY = ['canary', 'secret', 'value', 'r0802'].join('-');

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionPrivateSecrets.call(command, args), [command, args] as const);
const secrets = (page: Page, id: string, method: string, params?: unknown, caller = 'service') => ipc(page, 'extensions_private_secrets_service', { id, caller, method, params });
const grant = (page: Page, id: string, op: 'grant' | 'revoke') => ipc(page, 'extensions_runtime_grant', { request: { op, id, permission: 'secrets.private' } });
const runtime = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_runtime', { request });
async function boot(page: Page) {
  await page.addInitScript(([manifest, other]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-secrets-a', trusted: true } },
      { manifest: other, enabled: true, icons: {}, executable: { digest: 'preview-secrets-b', trusted: true } },
    ]));
  }, [manifest, other]);
  await page.goto('/?private-secrets'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionPrivateSecrets);
}
const refused = async (promise: Promise<unknown>, code: string) => { await expect(promise).rejects.toThrow(new RegExp(code)); };

test('extensions private secrets: a package keeps its own secret and never meets another package\'s key', async ({ page }) => {
  await boot(page);
  await refused(secrets(page, ID, 'secrets.get', { key: 'api-token' }), 'PermissionDenied');
  await grant(page, ID, 'grant'); await grant(page, OTHER, 'grant');
  expect(await secrets(page, ID, 'secrets.set', { key: 'api-token', value: CANARY })).toBeNull();
  expect(await secrets(page, ID, 'secrets.get', { key: 'api-token' })).toEqual({ value: CANARY });
  expect(await secrets(page, ID, 'secrets.list')).toEqual({ keys: ['api-token'] });
  expect(await secrets(page, OTHER, 'secrets.get', { key: 'api-token' })).toEqual({ value: null });
  expect(await secrets(page, OTHER, 'secrets.list')).toEqual({ keys: [] });
  for (const extra of [{ key: 'api-token', id: ID }, { key: 'api-token', owner: ID }, { key: 'api-token', package: ID }, { key: '../api-token' }, 'api-token']) {
    await refused(secrets(page, OTHER, 'secrets.get', extra), 'InvalidArguments');
  }
  await secrets(page, OTHER, 'secrets.set', { key: 'api-token', value: 'other' });
  await secrets(page, OTHER, 'secrets.delete', { key: 'api-token' });
  expect(await secrets(page, ID, 'secrets.get', { key: 'api-token' }), 'the other package never touched it').toEqual({ value: CANARY });
  await secrets(page, ID, 'secrets.delete', { key: 'api-token' });
  expect(await secrets(page, ID, 'secrets.list')).toEqual({ keys: [] });
});

test('extensions private secrets: limits, revoke, disable and service-only are explicit; no value reaches the projection', async ({ page }) => {
  await boot(page);
  await grant(page, ID, 'grant');
  for (let index = 0; index < 64; index++) await secrets(page, ID, 'secrets.set', { key: `key-${index}`, value: 'v' });
  await refused(secrets(page, ID, 'secrets.set', { key: 'one-more', value: 'v' }), 'LimitExceeded');
  await secrets(page, ID, 'secrets.set', { key: 'key-0', value: CANARY });
  await refused(secrets(page, ID, 'secrets.set', { key: 'key-1', value: 'x'.repeat(16 * 1024 + 1) }), 'LimitExceeded');
  await secrets(page, ID, 'secrets.set', { key: 'key-1', value: 'x'.repeat(16 * 1024) });
  for (const params of [{ key: 'Upper', value: 'v' }, { key: 'k', value: '' }, { key: 'k' }, { key: 'k', value: 'v', extra: 1 }, { key: 'a'.repeat(65), value: 'v' }]) {
    await refused(secrets(page, ID, 'secrets.set', params), 'InvalidArguments');
  }

  // Never a value in the projection, and the package-owned kind is named.
  const projection = await ipc(page, 'extensions_private_secrets') as { kind: string; packages: { id: string; count: number }[] };
  expect(projection.kind).toBe('package-owned');
  expect(projection.packages).toMatchObject([{ id: ID, count: 64 }]);
  expect(JSON.stringify(projection)).not.toContain(CANARY);

  // Service only, and no credentials.read anywhere.
  await refused(secrets(page, ID, 'secrets.get', { key: 'key-0' }, 'panel'), 'UnsupportedCapability');
  for (const method of ['credentials.read', 'secrets.getAll', 'secrets.credentials']) await refused(secrets(page, ID, method), 'UnsupportedCapability');

  // Revoke and disable deny before any read and keep the data; a grant brings it back.
  await grant(page, ID, 'revoke');
  await refused(secrets(page, ID, 'secrets.get', { key: 'key-0' }), 'PermissionDenied');
  await refused(secrets(page, ID, 'secrets.list'), 'PermissionDenied');
  await grant(page, ID, 'grant');
  expect(await secrets(page, ID, 'secrets.get', { key: 'key-0' })).toEqual({ value: CANARY });
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  await refused(secrets(page, ID, 'secrets.get', { key: 'key-0' }), 'PermissionDenied');
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await secrets(page, ID, 'secrets.get', { key: 'key-0' })).toEqual({ value: CANARY });
  await runtime(page, { op: 'trust', id: ID, digest: 'preview-secrets-a', allow: false });
  await refused(secrets(page, ID, 'secrets.get', { key: 'key-0' }), 'PermissionDenied');
  await runtime(page, { op: 'trust', id: ID, digest: 'preview-secrets-a', allow: true });

  // Uninstall removes the owner's secrets.
  await ipc(page, 'extensions_uninstall', { id: ID });
  expect((await ipc(page, 'extensions_private_secrets') as { packages: unknown[] }).packages).toEqual([]);
  expect(await page.evaluate(() => JSON.stringify(Object.entries(localStorage)))).not.toContain('key-0');
});

test('extensions private secrets: the schema names the permission and the SDK has no credentials.read', async ({ page }) => {
  await boot(page);
  const checked = await page.evaluate(manifest => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    return {
      ok: validateContract('packages', [manifest]).ok,
      undeclared: validateContract('packages', [{ ...manifest, permissions: ['ui.contribute', 'runtime.service'] }]).ok,
      credentialsRead: validateContract('packages', [{ ...manifest, permissions: ['ui.contribute', 'credentials.read'] }]).ok,
    };
  }, manifest);
  expect(checked).toEqual({ ok: true, undeclared: true, credentialsRead: false });
  expect(read('src/extensions/sdk/index.d.ts')).not.toMatch(/['"]credentials\.read['"]/); // the SDK's prose may say there is none; no type or name offers it
  expect(await ipc(page, 'extensions_private_secrets')).toMatchObject({ schemaVersion: 1, available: true, kind: 'package-owned', packages: [] });
});
