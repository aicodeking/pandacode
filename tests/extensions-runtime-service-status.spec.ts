import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0107 (the Running list and the quit account). The browser preview runs no package code: rows
// come from the lifetime and supervision stand-ins, and the working state, memory, jobs and data sizes are scripted
// by the labelled stand-in of src/extensions/runtime-service-status.ts. The real service, its memory, its data
// directory and the quit account are proven natively by
// `runtime_service_status::tests::installed` (feature extension-runtime-native-tests) and `quit_guard::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-service-status/extension.json'));
const unrelated = JSON.parse(read('tests/fixtures/extensions/runtime-service-lifetime/extension.json'));
const ID = 'sample.service-status';
const OTHER = 'sample.service-lifetime';
// Each test boots the whole app; a cold WebKit load alone can take several seconds.
test.setTimeout(90_000);

type Row = { id: string; state: string; held: boolean; restarts: number; working: boolean; jobs: number; memory: { residentBytes: number; peakBytes: number } | null; host: { placement: string; name: string }; starts: Record<string, number>; stops: Record<string, number>; lastStop: { reason: string; acknowledged: boolean } | null; controls: { stop: boolean; retry: boolean } };
type Status = { available: boolean; counts: { services: number; working: number; jobs: number; quit: number }; services: Row[]; jobs: { id: string; running: number }[]; quit: { id: string; text: string | null; jobs: number }[] };
const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionServiceSupervision.call(command, args), [command, args] as const);
const status = async (page: Page) => (await ipc(page, 'extensions_service_status')) as Status;
const script = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_service_status_preview', request);
const quit = async (page: Page) => (await ipc(page, 'extensions_service_quit_preview')) as { confirm: boolean; message: string; packages: Status['quit'] };
const grant = (page: Page, id: string) => ipc(page, 'extensions_runtime_grant', { request: { op: 'grant', id, permission: 'runtime.service' } });

async function boot(page: Page) {
  await page.addInitScript(([manifest, unrelated]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-status-a', trusted: true } },
      { manifest: unrelated, enabled: true, icons: {}, executable: { digest: 'preview-lifetime-a', trusted: true } },
    ]));
  }, [manifest, unrelated]);
  await page.goto('/?service-supervision'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__extensionServiceSupervision);
  await grant(page, ID); await grant(page, OTHER);
}
async function openExtensions(page: Page) {
  await page.locator('html[data-ready]').waitFor({ state: 'attached', timeout: 30_000 });
  const tab = page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true });
  await expect(async () => {
    if (!(await tab.isVisible())) await page.keyboard.press('ControlOrMeta+,');
    await tab.click({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('#settings-panel-extensions')).toBeVisible();
}
const running = (page: Page) => page.locator('[data-extension-running]');
const row = (page: Page, id = ID) => running(page).locator(`[data-running-service="${id}"]`);

test('extensions service status: the Running list follows native state, names a working service on quit and clearing the work removes the warning', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await expect(running(page).getByRole('heading', { name: 'Running' })).toBeVisible();
  await expect(row(page)).toHaveAttribute('data-running-state', 'running');
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Running · Restarts: 0 · Memory: measuring');
  await expect(row(page).locator('[data-running-host]')).toHaveText('Runs on This computer (Preview stand-in computer)');
  await expect(row(page, OTHER)).toHaveAttribute('data-running-state', 'running');
  await expect(running(page).locator('[data-running-summary]')).toHaveText('2 services running · 0 working · 0 jobs · on This computer (Preview stand-in computer)');
  await expect(running(page).locator('[data-running-quit]')).toHaveCount(0);
  // Resident memory comes from the native sample; the open list rereads it without any action.
  await script(page, { op: 'memory', id: ID, bytes: 41_943_040 });
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Running · Restarts: 0 · 40.0 MB in memory (peak 40.0 MB)');
  await script(page, { op: 'memory', id: ID, bytes: 20_971_520 });
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Running · Restarts: 0 · 20.0 MB in memory (peak 40.0 MB)');
  // Working: the row says so and the quit question names the package.
  await script(page, { op: 'status', id: ID, text: 'Indexing 3 files', working: true });
  await expect(row(page)).toHaveAttribute('data-running-working', 'true');
  await expect(row(page).locator('[data-running-status]')).toHaveText('Working: Indexing 3 files');
  await expect(running(page).locator('[data-running-quit]')).toHaveText('Quitting now asks first. Extension still working: sample.service-status (Indexing 3 files). Quitting stops it.');
  expect(await quit(page)).toEqual({ confirm: true, packages: [{ id: ID, text: 'Indexing 3 files', jobs: 0 }], message: 'Extension still working: sample.service-status (Indexing 3 files). Quitting stops it.' });
  // Its jobs are counted once, on the package; jobs of a package without a service are listed and counted once too.
  await script(page, { op: 'jobs', id: ID, running: 2 }); await script(page, { op: 'jobs', id: 'sample.tools', running: 1 });
  await expect(running(page).locator('[data-running-summary]')).toHaveText('2 services running · 1 working · 3 jobs · on This computer (Preview stand-in computer)');
  await expect(row(page).locator('[data-running-jobs]')).toHaveText('2 jobs running');
  await expect(running(page).locator('[data-running-other-jobs]')).toHaveText('Tool jobs: sample.tools (1 running)');
  const both = await status(page);
  expect(both.counts).toEqual({ services: 2, working: 1, jobs: 3, quit: 2 });
  expect(both.quit).toEqual([{ id: ID, text: 'Indexing 3 files', jobs: 2 }, { id: 'sample.tools', text: null, jobs: 1 }]);
  expect((await quit(page)).message).toBe('Extensions still working: sample.service-status (Indexing 3 files; 2 jobs running), sample.tools (1 job running). Quitting stops them.');
  // Clearing the work removes the warning.
  await script(page, { op: 'jobs', id: ID, running: 0 }); await script(page, { op: 'jobs', id: 'sample.tools', running: 0 });
  await script(page, { op: 'status', id: ID, text: 'Idle', working: false });
  await expect(row(page)).toHaveAttribute('data-running-working', 'false');
  await expect(row(page).locator('[data-running-status]')).toHaveText('Idle');
  await expect(running(page).locator('[data-running-quit]')).toHaveCount(0);
  const cleared = await quit(page);
  expect(cleared.packages).toEqual([]); expect(cleared.message).not.toContain('Extension');
  // Restarts come from supervision: a crash shows the scheduled restart, then the restarted service.
  await ipc(page, 'extensions_service_supervision_preview', { op: 'crash', id: ID });
  await expect(row(page)).toHaveAttribute('data-running-state', 'restarting');
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Restarting in 1.0 s after 1 crash · Restarts: 0');
  await expect(row(page).getByRole('button', { name: `Stop ${ID}` })).toBeVisible();
  await expect(row(page).getByRole('button', { name: `Retry ${ID}` })).toBeVisible();
  await ipc(page, 'extensions_service_supervision_preview', { op: 'advance', ms: 1000 });
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Running · Restarts: 1 · Memory: measuring');
  // The unrelated service never moved.
  await expect(row(page, OTHER).locator('[data-running-facts]')).toHaveText('Running · Restarts: 0 · Memory: measuring');
});

test('extensions service status: Stop holds the service until Retry or enable, a stopped service is not named on quit, and Data size measures its data', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await script(page, { op: 'status', id: ID, text: 'Syncing', working: true });
  await expect(row(page)).toHaveAttribute('data-running-working', 'true');
  // Keyboard: Stop, and the focus stays on the row (its Retry, since Stop is gone).
  await row(page).getByRole('button', { name: `Stop ${ID}` }).focus();
  await page.keyboard.press('Enter');
  await expect(row(page)).toHaveAttribute('data-running-state', 'stopped');
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Stopped by you · Restarts: 0');
  await expect(row(page).getByRole('button', { name: `Stop ${ID}` })).toHaveCount(0);
  await expect(row(page).getByRole('button', { name: `Retry ${ID}` })).toBeFocused();
  await expect(running(page).locator('[data-running-quit]')).toHaveCount(0);
  expect((await quit(page)).packages).toEqual([]);
  const stopped = (await status(page)).services.find(item => item.id === ID)!;
  expect(stopped).toMatchObject({ state: 'stopped', held: true, working: false, stops: { stop: 1 }, lastStop: { reason: 'stop', acknowledged: true }, controls: { stop: false, retry: true } });
  await expect(ipc(page, 'extensions_service_stop', { id: ID })).rejects.toThrow('Conflict');
  // Another reconcile (any extensions command) leaves it stopped; the unrelated service keeps running.
  await ipc(page, 'extensions_snapshot');
  await expect(row(page)).toHaveAttribute('data-running-state', 'stopped');
  await expect(row(page, OTHER)).toHaveAttribute('data-running-state', 'running');
  // Retry starts it again.
  await row(page).getByRole('button', { name: `Retry ${ID}` }).click();
  await expect(row(page)).toHaveAttribute('data-running-state', 'running');
  expect((await status(page)).services.find(item => item.id === ID)).toMatchObject({ held: false, starts: { enable: 2 }, stops: { stop: 1 }, lastStop: { reason: 'stop', acknowledged: true } });
  // Enable is the retry too.
  await row(page).getByRole('button', { name: `Stop ${ID}` }).click();
  await expect(row(page)).toHaveAttribute('data-running-state', 'stopped');
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  await expect(row(page)).toHaveAttribute('data-running-state', 'running');
  expect((await status(page)).services.find(item => item.id === ID)).toMatchObject({ starts: { enable: 3 }, stops: { stop: 2 } });
  // Data size: measured on request, the package's own data only.
  await expect(row(page).locator('[data-running-data]')).toHaveText('Data: not measured');
  await script(page, { op: 'data', id: ID, bytes: 4096, files: 1 });
  await row(page).getByRole('button', { name: `Data size ${ID}` }).click();
  await expect(row(page).locator('[data-running-data]')).toHaveText('Data: 4.0 KB in 1 file');
  await expect(row(page).getByRole('button', { name: `Data size ${ID}` })).toBeFocused();
  await row(page, OTHER).getByRole('button', { name: `Data size ${OTHER}` }).click();
  await expect(row(page, OTHER).locator('[data-running-data]')).toHaveText('Data: none');
  await expect(ipc(page, 'extensions_service_data_size', { id: '../other' })).rejects.toThrow('InvalidArguments');
  await expect(ipc(page, 'extensions_service_retry', { id: 'sample.unknown' })).rejects.toThrow('NotFound');
  // Disable stops it for its own reason; a disabled service is listed as stopped with no Stop.
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  await expect(row(page)).toHaveAttribute('data-running-state', 'stopped');
  await expect(row(page).locator('[data-running-facts]')).toHaveText('Stopped · Restarts: 0');
  expect((await status(page)).services.find(item => item.id === ID)).toMatchObject({ held: false, lastStop: { reason: 'disable' } });
});
