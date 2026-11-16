import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0106 (service supervision). The browser preview runs no package code: crashes are scripted on a
// simulated clock by the labelled stand-in of src/extensions/runtime-service-supervision.ts, which mirrors the native
// rules. The real crashing process is the native test `runtime_service_lifetime::tests::installed` (feature
// extension-runtime-native-tests) and the pure rules are `runtime_service_supervision::tests`.
const read = (path: string) => readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/runtime-service-supervision/extension.json'));
const unrelated = JSON.parse(read('tests/fixtures/extensions/runtime-service-lifetime/extension.json'));
const ID = 'sample.service-supervision';
const OTHER = 'sample.service-lifetime';
type Service = { id: string; state: string; reason: string | null; version: string | null; restarts: number; error: string | null; starts: Record<string, number>; stops: Record<string, number>; lastStop: { reason: string; acknowledged: boolean } | null; supervision?: { crashes: number; backoffMs: number | null; restartInMs: number | null; parked: string | null; startup: { elapsedMs: number; slow: boolean; readyMs: number | null } | null } };

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__extensionServiceSupervision.call(command, args), [command, args] as const);
const services = async (page: Page) => ((await ipc(page, 'extensions_service_lifetime')) as { services: Service[] }).services;
const service = async (page: Page, id = ID) => (await services(page)).find(entry => entry.id === id) ?? null;
const supervise = (page: Page, request: Record<string, unknown>) => ipc(page, 'extensions_service_supervision_preview', request);
const crash = (page: Page) => supervise(page, { op: 'crash', id: ID });
const advance = (page: Page, ms: number) => supervise(page, { op: 'advance', ms });
const grant = (page: Page, id: string) => ipc(page, 'extensions_runtime_grant', { request: { op: 'grant', id, permission: 'runtime.service' } });
async function boot(page: Page) {
  await page.addInitScript(([manifest, unrelated]) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([
      { manifest, enabled: true, icons: {}, executable: { digest: 'preview-supervision-a', trusted: true } },
      { manifest: unrelated, enabled: true, icons: {}, executable: { digest: 'preview-lifetime-a', trusted: true } },
    ]));
  }, [manifest, unrelated]);
  await page.goto('/?service-supervision'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.waitForFunction(() => (window as any).__extensionServiceSupervision);
  await grant(page, ID); await grant(page, OTHER);
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'enable', restarts: 0 });
  expect(await service(page, OTHER)).toMatchObject({ state: 'running', reason: 'enable' });
}

test('extensions service supervision: the scripted crash sequence backs off from 1 s to 60 s and parks after five crashes in ten minutes', async ({ page }) => {
  await page.goto('/?service-supervision'); await page.waitForFunction(() => (window as any).__extensionServiceSupervision);
  const result = await page.evaluate(() => {
    const { createCrashHistory, recordCrash, backoffMs, parkingExplanation, startState } = (window as any).__extensionServiceSupervision;
    const script = (times: number[]) => { const history = createCrashHistory(); return times.map(time => { const decision = recordCrash(history, 'sample.service-supervision', time, 'HostUnavailable'); return decision.kind === 'park' ? null : decision.delayMs; }); };
    return {
      backoff: [1, 2, 3, 4, 5, 6, 7, 8].map(backoffMs),
      rapid: script([0, 1_000, 3_000, 7_000, 15_000]),
      spaced: script(Array.from({ length: 9 }, (_, index) => index * 150_000)),
      inside: script([0, 100_000, 200_000, 300_000, 599_999]).at(-1),
      outside: script([0, 100_000, 200_000, 300_000, 600_000]).at(-1),
      reset: script([0, 1_000, 3_000, 603_000]),
      explanation: parkingExplanation('sample.service-supervision', ['HostUnavailable', 'IncompatibleApi', 'HostUnavailable', 'PermissionDenied', 'HostUnavailable']),
      bounded: [...parkingExplanation('x'.repeat(400), Array(5).fill('HostUnavailable'))].length,
      slow: [startState(true, 5_000, null, 14_999).slow, startState(true, 5_000, null, 15_000).slow, startState(false, 5_000, 17_000, 30_000).readyMs],
    };
  });
  // The same numbers as the native `a_scripted_crash_sequence_backs_off_and_parks_after_five_crashes_in_ten_minutes`.
  expect(result).toEqual({
    backoff: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000],
    rapid: [1_000, 2_000, 4_000, 8_000, null],
    spaced: [1_000, 2_000, 4_000, 8_000, 16_000, 32_000, 60_000, 60_000, 60_000],
    inside: null, outside: 16_000, reset: [1_000, 2_000, 4_000, 1_000],
    explanation: 'The service of sample.service-supervision was parked after 5 crashes in 10 minutes (HostUnavailable x3, IncompatibleApi, PermissionDenied). Retry, enable or update the package to start it again.',
    bounded: 240, slow: [false, true, 12_000],
  });
});

test('extensions service supervision: crashes restart with backoff and park with a named explanation while the app and unrelated services keep running; retry, enable and update restart a parked service', async ({ page }) => {
  await boot(page);
  const prompt = page.locator('#prompt');
  // Four crashes: each restart waits exactly its backoff on the simulated clock.
  for (const [index, delay] of [1_000, 2_000, 4_000, 8_000].entries()) {
    expect(await crash(page)).toEqual({ kind: 'restart', delayMs: delay, atMs: expect.any(Number) });
    expect(await service(page)).toMatchObject({ state: 'restarting', restarts: index, error: 'HostUnavailable', supervision: { crashes: index + 1, backoffMs: delay, restartInMs: delay, parked: null } });
    await advance(page, delay - 1);
    expect((await service(page))!.state, 'not before its backoff').toBe('restarting');
    await prompt.pressSequentially(`${index}`, { delay: 0 });
    await advance(page, 1);
    expect(await service(page)).toMatchObject({ state: 'running', reason: 'restart', restarts: index + 1, starts: { restart: index + 1 } });
  }
  // The fifth crash inside ten minutes parks it: no restart however long the clock runs.
  expect(await crash(page)).toMatchObject({ kind: 'park' });
  await advance(page, 3_600_000);
  const parked = await service(page);
  expect(parked).toMatchObject({ state: 'parked', restarts: 4, stops: { crash: 5, park: 1 }, lastStop: { reason: 'park', acknowledged: false }, starts: { enable: 1, restart: 4 } });
  expect(parked!.supervision!.parked).toBe('The service of sample.service-supervision was parked after 5 crashes in 10 minutes (HostUnavailable x5). Retry, enable or update the package to start it again.');
  expect(parked!.supervision!.parked!.length).toBeLessThanOrEqual(240);
  // Unrelated work keeps running: the other package's service and the composer.
  expect(await service(page, OTHER)).toMatchObject({ state: 'running', restarts: 0, stops: {} });
  await expect(prompt).toBeEnabled(); await expect(prompt).toHaveValue('0123');

  // Enable (the retry) restarts a parked service with a clean history.
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await service(page)).toMatchObject({ state: 'running', restarts: 0, supervision: { crashes: 0, parked: null } });
  // Disable cancels a scheduled restart.
  await crash(page);
  expect((await service(page))!.state).toBe('restarting');
  await ipc(page, 'extensions_enable', { id: ID, enabled: false });
  await advance(page, 120_000);
  expect(await service(page)).toMatchObject({ state: 'stopped' });
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await service(page)).toMatchObject({ state: 'running', restarts: 0 });
  // Safe mode cancels a scheduled restart too.
  await crash(page);
  await ipc(page, 'extensions_safe_mode');
  await advance(page, 120_000);
  expect(await service(page)).toMatchObject({ state: 'stopped', lastStop: { reason: 'safeMode' } });
  expect(await service(page, OTHER)).toMatchObject({ state: 'stopped', lastStop: { reason: 'safeMode' } });

  // Leaving safe mode is the next launch; park again, then an update restarts the parked service.
  await page.reload(); await page.waitForFunction(() => (window as any).__extensionServiceSupervision);
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'appStart' });
  for (const delay of [1_000, 2_000, 4_000, 8_000]) { await crash(page); await advance(page, delay); }
  await crash(page);
  expect((await service(page))!.state).toBe('parked');
  await ipc(page, 'extensions_runtime', { request: { op: 'stageUpdate', id: ID, path: 'preview-update' } });
  await ipc(page, 'extensions_runtime', { request: { op: 'reviewUpdate', id: ID, digest: 'preview-update-1.1.0' } });
  expect(await service(page)).toMatchObject({ state: 'running', reason: 'update', version: '1.1.0', restarts: 0, supervision: { crashes: 0, parked: null } });
  expect(await service(page, OTHER)).toMatchObject({ state: 'running' });
});

test('extensions service supervision: a service still starting after 10 s is shown as slow and never blocks the app', async ({ page }) => {
  await boot(page);
  await supervise(page, { op: 'hang', id: ID });
  await advance(page, 9_999);
  expect(await service(page)).toMatchObject({ state: 'starting', supervision: { startup: { elapsedMs: 9_999, slow: false, readyMs: null } } });
  await advance(page, 1);
  expect(await service(page)).toMatchObject({ state: 'starting', supervision: { startup: { elapsedMs: 10_000, slow: true } } });
  const prompt = page.locator('#prompt');
  await expect(prompt).toBeEnabled(); await prompt.fill('still typing'); await expect(prompt).toHaveValue('still typing');
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await service(page, OTHER)).toMatchObject({ state: 'running' });
  // Enable is the retry of a start that never settled.
  await ipc(page, 'extensions_enable', { id: ID, enabled: true });
  expect(await service(page)).toMatchObject({ state: 'running', supervision: { startup: { slow: false, readyMs: 0 } } });
});
