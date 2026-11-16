import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0104 (background services). The browser preview runs no package code: these are the synthetic
// stand-ins of src/extensions/runtime-service-lifetime.ts following the native rule. The real installed B1-backed
// process lifetime is the native test `runtime_service_lifetime::tests::installed` (feature extension-runtime-native-tests).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-service-lifetime/extension.json'));
const lazy = JSON.parse(read('tests/fixtures/extensions/project-summary/extension.json'));
const ID = 'sample.service-lifetime';
type Service = { id: string; state: string; reason: string | null; version: string | null; starts: Record<string, number>; stops: Record<string, number>; lastStop: { reason: string; acknowledged: boolean } | null };

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionServiceLifetime.call(command, args), [command, args] as const);
const services = async (page: Page) => ((await ipc(page, 'extensions_service_lifetime')) as { services: Service[] }).services;
const service = async (page: Page) => (await services(page)).find(entry => entry.id === ID) ?? null;
const runtime = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_runtime', { request });
const grant = (page: Page, op: 'grant' | 'revoke') => ipc(page, 'extensions_runtime_grant', { request: { op, id: ID, permission: 'runtime.service' } });
async function boot(page: Page) {
  await page.goto('/?service-lifetime'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionServiceLifetime);
}

test('extensions service lifetime: no service before trust, enable and grant; a service package starts while a command-only package stays lazy', async ({ page }) => {
  await page.addInitScript(([manifest, lazy]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: false, icons: {}, executable: { digest: 'preview-service-a', trusted: false } },
      { manifest: lazy, enabled: true, icons: {}, executable: { digest: 'preview-fixture', trusted: true } },
    ]));
  }, [manifest, lazy]);
  await boot(page);
  expect(await service(page)).toBeNull();
  await expect(ipc(page, 'extensions_enable', { id: ID, enabled: true })).rejects.toThrow(/ExecutableTrustRequired/);
  await runtime(page, { op: 'trust', id: ID, digest: 'preview-service-a', allow: true });
  expect(await service(page)).toBeNull();
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await service(page), 'enabled and trusted, but runtime.service is not granted').toBeNull();
  await grant(page, 'grant');
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'enable', starts: { enable: 1 }, stops: {} });
  // Q120 (retained): the trusted, enabled command-only package has no service; its code still starts only on use.
  expect((await services(page)).map(entry => entry.id)).toEqual([ID]);

  // A task switch in the workspace leaves the service alone.
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.locator('.task-item[data-id="session-1"]').click();
  expect(await service(page)).toMatchObject({ state: 'running', starts: { enable: 1 }, stops: {} });

  // Quit and launch (a main-page reload is the preview's restart).
  await page.reload(); await page.waitForFunction(() => (window as any).__extensionServiceLifetime);
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'appStart', starts: { enable: 1, appStart: 1 }, stops: { quit: 1 } });

  // Every stop reason, each followed by the start that undoes it.
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  expect(await service(page)).toMatchObject({ state: 'stopped', lastStop: { reason: 'disable', acknowledged: true } });
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'enable' });
  await grant(page, 'revoke');
  expect(await service(page)).toMatchObject({ state: 'stopped', lastStop: { reason: 'trust' }, stops: { trust: 1 } });
  await grant(page, 'grant');
  await runtime(page, { op: 'trust', id: ID, digest: 'preview-service-a', allow: false });
  expect(await service(page)).toMatchObject({ state: 'stopped', stops: { trust: 2 } });
  await runtime(page, { op: 'trust', id: ID, digest: 'preview-service-a', allow: true });
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  await runtime(page, { op: 'stageUpdate', id: ID, path: 'preview-update' });
  expect(await service(page), 'a staged, unreviewed update changes nothing').toMatchObject({ state: 'running', version: '1.0.0' });
  await runtime(page, { op: 'reviewUpdate', id: ID, digest: 'preview-update-1.1.0' });
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'update', version: '1.1.0', stops: { update: 1 }, starts: { update: 1 } });
  await ipc(page, 'extensions_safe_mode');
  expect(await service(page)).toMatchObject({ state: 'stopped', lastStop: { reason: 'safeMode' } });
  await page.reload(); await page.waitForFunction(() => (window as any).__extensionServiceLifetime);
  expect(await service(page), 'leaving safe mode is the next launch').toMatchObject({ state: 'running', reason: 'appStart', starts: { appStart: 2 } });
  await ipc(page, 'extensions_uninstall', { id: ID });
  const last = await service(page);
  expect(last).toMatchObject({ state: 'stopped', lastStop: { reason: 'uninstall', acknowledged: true } });
  expect(last!.starts).toEqual({ enable: 4, appStart: 2, update: 1 });
  expect(last!.stops).toEqual({ quit: 1, disable: 1, trust: 2, update: 1, safeMode: 1, uninstall: 1 });
  await expect(page.locator('#prompt')).toBeEnabled();
});

test('extensions service lifetime: the schema names the service shape and its permission', async ({ page }) => {
  await boot(page);
  const checked = await page.evaluate(manifest => {
    const { validateContract } = (window as any).__extensionRuntimeGrants;
    return {
      ok: validateContract('packages', [manifest]).ok,
      undeclared: validateContract('packages', [{ ...manifest, permissions: ['ui.contribute'] }]).error?.code,
      start: validateContract('packages', [{ ...manifest, runtime: { ...manifest.runtime, service: { start: 'onLaunch' } } }]).error?.code,
    };
  }, manifest);
  expect(checked).toEqual({ ok: true, undeclared: 'PermissionDenied', start: 'InvalidShape' });
  expect(await ipc(page, 'extensions_service_lifetime')).toEqual({ schemaVersion: 1, available: true, services: [] });
});
