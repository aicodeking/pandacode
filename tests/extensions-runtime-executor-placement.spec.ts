import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0108 (services beside remote and headless executors). The browser has no second computer: the
// hosts are the labelled fake paired transport of src/extensions/runtime-executor-placement.ts, which proves protocol
// behaviour only (attribution, idempotent writers across a lost reply, refusals, unavailable hosts). A real service
// beside a headless executor is proven natively (`runtime_executor_placement::tests::installed`, feature
// extension-runtime-native-tests); installed cross-machine qualification stays pending until two real paired
// computers are available (docs/extensions/runtime-executor-placement.md).
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const peers = JSON.parse(read('tests/fixtures/extensions/runtime-executor-placement/peers.json'));
const ID = 'sample.executor-placement';
const UI_ID = 'sample.executor-placement-ui';
const HOST = 'fake-build-server';
test.setTimeout(90_000);

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionExecutorPlacement.call(command, args), [command, args] as const);
const script = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_executor_preview', { deviceId: HOST, ...request });
const refusal = (page: Page, command: string, args: Record<string, unknown>) => page.evaluate(async ([command, args]) => {
  try { await (window as any).__extensionExecutorPlacement.call(command, args); return 'resolved'; } catch (error) { return error instanceof Error ? error.message : String(error); }
}, [command, args] as const);

async function boot(page: Page) {
  await page.addInitScript(peers => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionExecutorPeers = peers;
  }, peers);
  await page.goto('/?executor-placement'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
}
async function openExtensions(page: Page) {
  await page.locator('html[data-ready]').waitFor({ state: 'attached', timeout: 30_000 });
  const tab = page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true });
  await expect(async () => {
    if (!(await tab.isVisible())) await page.keyboard.press('ControlOrMeta+,');
    await tab.click({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('#settings-panel-extensions')).toBeVisible();
  await page.waitForFunction(() => (window as any).__extensionExecutorPlacement);
}
const section = (page: Page) => page.locator('[data-extension-executors]');
const hostBlock = (page: Page, device = HOST) => section(page).locator(`[data-executor-host="${device}"]`);
const row = (page: Page, id = ID) => hostBlock(page).locator(`[data-executor-service="${id}"]`);

test('extensions executor placement: a workspace service runs beside the headless executor, attributed; ui code is not placed there and unavailable computers stay pending', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await expect(section(page).getByRole('heading', { name: 'On other computers' })).toBeVisible();
  await expect(hostBlock(page)).toHaveAttribute('data-executor-reachable', 'true');
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
  await expect(row(page).locator('[data-executor-where]')).toHaveText('Runs on build-server (headless server)');
  await expect(row(page).locator('[data-executor-status]')).toHaveText('Beside the executor');
  await expect(row(page, UI_ID)).toHaveCount(0);
  // The native projection shape: every row is attributed to its package on the host it runs on.
  const placement = await ipc(page, 'extensions_executor_services') as any;
  const build = placement.hosts.find((host: any) => host.deviceId === HOST);
  expect(build.host).toEqual({ placement: 'remote', deviceId: HOST, name: 'build-server', platform: 'linux', headless: true });
  expect(build.services.map((service: any) => service.id)).toEqual([ID]);
  expect(build.services[0].attribution).toEqual({ package: ID, deviceId: HOST, host: 'build-server' });
  expect(placement.qualification.installed).toBe('pending');
  // Offline and older computers are listed, nothing is delivered from them and nothing runs here instead.
  await expect(hostBlock(page, 'fake-studio')).toHaveAttribute('data-executor-reachable', 'false');
  await expect(hostBlock(page, 'fake-studio').locator('[data-executor-unavailable]')).toContainText('offline');
  await expect(hostBlock(page, 'fake-studio').locator('[data-executor-unavailable]')).toContainText('Placement there stays pending.');
  await expect(hostBlock(page, 'fake-old-laptop').locator('[data-executor-unavailable]')).toContainText('UnsupportedCapability');
  await expect(section(page).locator('[data-executor-qualification]')).toHaveText('Installed cross-machine qualification is pending: it needs two real computers already paired by you.');
  // A host that goes offline keeps its services pending, not delivered.
  await script(page, { op: 'online', online: false });
  await expect(hostBlock(page)).toHaveAttribute('data-executor-reachable', 'false');
  await expect(row(page)).toHaveCount(0);
  await script(page, { op: 'online', online: true });
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
});

test('extensions executor placement: Stop, Retry and revoke from the desktop apply once across a lost reply, keep the keyboard and forward activity and live UI', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
  const startsBefore = await script(page, { op: 'starts', id: ID });
  // The host applies Stop, the reply is lost, the desktop retries with the same request id: one stop.
  await script(page, { op: 'lose', times: 1 });
  const stop = row(page).getByRole('button', { name: `Stop ${ID} on build-server`, exact: true });
  await stop.focus(); await page.keyboard.press('Enter');
  await expect(row(page)).toHaveAttribute('data-executor-state', 'stopped');
  await expect(row(page)).toHaveAttribute('data-executor-held', 'true');
  await expect(row(page).locator('[data-executor-facts]')).toContainText('Stopped by you');
  await expect(row(page).getByRole('button', { name: `Retry ${ID} on build-server`, exact: true })).toBeFocused();
  await expect(row(page).locator('[data-executor-activity] li', { hasText: 'Stop requested from This computer' })).toHaveCount(1);
  // Retry, also with a lost reply: the service starts once.
  await script(page, { op: 'lose', times: 1 });
  await page.keyboard.press('Enter');
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
  expect(await script(page, { op: 'starts', id: ID })).toBe((startsBefore as number) + 1);
  await expect(row(page).locator('[data-executor-activity] li', { hasText: 'Retry requested from This computer' })).toHaveCount(1);
  // A repeated request id answers the first answer and changes nothing.
  const first = await ipc(page, 'extensions_executor_service_control', { deviceId: HOST, id: ID, op: 'stop', requestId: 'same-id' }) as any;
  const again = await ipc(page, 'extensions_executor_service_control', { deviceId: HOST, id: ID, op: 'stop', requestId: 'same-id' }) as any;
  expect(first.applied).toBe(true); expect(again.replayed).toBe(true); expect(again.attribution).toEqual(first.attribution);
  expect((await ipc(page, 'extensions_executor_service_control', { deviceId: HOST, id: ID, op: 'stop', requestId: 'other-id' }) as any).applied).toBe(false);
  await ipc(page, 'extensions_executor_service_control', { deviceId: HOST, id: ID, op: 'retry', requestId: 'retry-2' });
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
  // Revoke runtime.service on the host: the service ends with the reason trust, without a prompt.
  await row(page).getByRole('button', { name: `Revoke runtime.service for ${ID} on build-server`, exact: true }).click();
  await expect(row(page)).toHaveAttribute('data-executor-state', 'stopped');
  await expect(row(page).locator('[data-executor-facts]')).toContainText('Not granted runtime.service');
  await expect(row(page).getByRole('button', { name: `Grant runtime.service for ${ID} on build-server`, exact: true })).toBeFocused();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  await page.keyboard.press('Enter');
  await expect(row(page)).toHaveAttribute('data-executor-state', 'running');
  // Hook activity and live UI updates of the host's package are forwarded, attributed and bounded.
  await script(page, { op: 'activity', id: ID, kind: 'hook', summary: 'Denied Bash rm -rf in task 7' });
  await script(page, { op: 'ui', id: ID, items: 2, notices: 1 });
  await expect(row(page).locator('[data-executor-activity-kind="hook"]')).toHaveText('Denied Bash rm -rf in task 7');
  await expect(row(page).locator('[data-executor-facts]')).toContainText('2 live items, 1 notice');
});

test('extensions executor placement: foreign, ui, undeclared, unknown and malformed requests and older hosts stay refused', async ({ page }) => {
  await boot(page); await openExtensions(page);
  const grant = (request: Record<string, unknown>, deviceId = HOST) => refusal(page, 'extensions_executor_grant', { deviceId, request });
  expect(await grant({ op: 'revoke', id: UI_ID, permission: 'runtime.service', requestId: 'r-ui' })).toBe('NotFound');
  expect(await grant({ op: 'revoke', id: 'sample.unknown', permission: 'runtime.service', requestId: 'r-unknown' })).toBe('NotFound');
  expect(await grant({ op: 'grant', id: ID, permission: 'tasks.start', requestId: 'r-undeclared' })).toBe('PermissionDenied');
  expect(await grant({ op: 'grant', id: ID, permission: 'credentials.read', requestId: 'r-read' })).toBe('UnsupportedCapability');
  expect(await grant({ op: 'grant', id: ID, requestId: 'r-missing' })).toBe('InvalidArguments');
  expect(await grant({ op: 'grant', id: ID, permission: 'runtime.service' })).toBe('InvalidArguments');
  expect(await grant({ op: 'revoke', id: ID, permission: 'runtime.service', requestId: 'r-offline' }, 'fake-studio')).toContain('offline');
  expect(await grant({ op: 'revoke', id: ID, permission: 'runtime.service', requestId: 'r-legacy' }, 'fake-old-laptop')).toContain('UnsupportedCapability');
  expect(await grant({ op: 'revoke', id: ID, permission: 'runtime.service', requestId: 'r-stranger' }, 'not-paired')).toContain('not on this account');
  expect(await refusal(page, 'extensions_executor_service_control', { deviceId: HOST, id: ID, op: 'kill', requestId: 'c-1' })).toBe('InvalidArguments');
  expect(await refusal(page, 'extensions_executor_service_control', { deviceId: HOST, id: UI_ID, op: 'stop', requestId: 'c-2' })).toBe('NotFound');
  // Nothing of the refused requests reached the host's state.
  const build = (await ipc(page, 'extensions_executor_services') as any).hosts.find((host: any) => host.deviceId === HOST);
  expect(build.services[0].granted).toEqual(['runtime.service']);
  expect(build.services[0].state).toBe('running');
  expect(build.activity).toEqual([]);
});
