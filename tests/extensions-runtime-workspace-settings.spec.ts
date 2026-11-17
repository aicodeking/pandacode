import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Preview column of R0407 (the settled workspace settings). The browser has no service process: `extensions_workspace_settings_service`
// answers a service call exactly as the native `serve` does (same refusal envelope, same revisions), and the window half
// (publish, apply, acknowledge) is the real one running against the preview store. The native rules are proven by
// `runtime_workspace_settings::tests` (cargo, feature-less); an installed run with a real service is the native fixture's.
const values = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-workspace-settings/values.json', import.meta.url), 'utf8')) as Record<string, any>;
const OWNER = 'sample.runtime-workspace-settings';
test.setTimeout(90_000);

const ipc = (page: Page, command: string, args: Record<string, unknown> = {}) => page.evaluate(([command, args]) => (window as any).__workspaceSettings.call(command, args), [command, args] as const);
const hook = (page: Page, op: string, owner = OWNER) => ipc(page, 'extensions_workspace_settings_preview', { op, owner });
const service = (page: Page, params: Record<string, unknown>, owner = OWNER) => ipc(page, 'extensions_workspace_settings_service', { owner, params }) as Promise<any>;
const fixedKeys = Object.keys(values).filter(key => key !== 'excluded' && !key.includes(':'));
const keyed = Object.keys(values).filter(key => key.includes(':'));

async function boot(page: Page) {
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await page.goto('/?workspace-settings'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__workspaceSettings);
  await hook(page, 'install'); await hook(page, 'grant');
}
const sent = (page: Page, key: string) => page.evaluate(storageKey => localStorage.getItem(storageKey), key);

test('extensions workspace settings: every frozen key round-trips with a new revision, bots and channels included', async ({ page }) => {
  await boot(page);
  // The window publishes the bots and channels it knows (keyed entries exist only once published).
  await ipc(page, 'extensions_workspace_settings_publish', { values: { 'bot:bot-1': { pinned: false, order: null }, 'channel:channel-1': { pinned: false, order: null } }, forget: [] });
  const listed = (await service(page, { op: 'list' })).value as string[];
  for (const key of [...fixedKeys, ...keyed]) expect(listed).toContain(key);
  for (const key of [...fixedKeys, ...keyed]) {
    const before = (await service(page, { op: 'get', key })).value;
    expect(before.key).toBe(key);
    const written = await service(page, { op: 'set', key, value: values[key], revision: before.revision });
    expect(written, key).toEqual({ ok: true, value: null });
    const after = (await service(page, { op: 'get', key })).value;
    expect(after.value, key).toEqual(values[key]);
    expect(after.revision, key).toBe(before.revision + 1);
  }
});

test('extensions workspace settings: unknown and excluded keys are NotFound, a stale revision is StaleContext, shapes and grants are refused natively', async ({ page }) => {
  await boot(page);
  for (const name of values.excluded as string[]) {
    for (const key of [name, `${name}.enabled`]) {
      for (const params of [{ op: 'get', key }, { op: 'set', key, value: true }]) {
        const reply = await service(page, params);
        expect(reply.ok, key).toBe(false);
        expect(reply.error.code, key).toBe('NotFound');
      }
    }
  }
  expect((await service(page, { op: 'get', key: 'bot:ghost' })).error.code).toBe('NotFound');
  expect((await service(page, { op: 'list' })).value).toEqual(expect.not.arrayContaining(['telemetry', 'safeMode', 'pairing']));
  // The race: two readers at the same revision, the second write is stale and changes nothing.
  const first = (await service(page, { op: 'get', key: 'view.open' })).value.revision as number;
  expect((await service(page, { op: 'set', key: 'view.open', value: 'board', revision: first })).ok).toBe(true);
  const stale = await service(page, { op: 'set', key: 'view.open', value: 'github', revision: first });
  expect(stale.error).toMatchObject({ code: 'StaleContext', path: 'view.open' });
  expect((await service(page, { op: 'get', key: 'view.open' })).value).toMatchObject({ value: 'board', revision: first + 1 });
  expect((await service(page, { op: 'set', key: 'view.open', value: 'github' })).ok).toBe(true);
  // Shapes the key does not take, and fields the call does not take.
  for (const [key, value, code] of [['sidebar.scope', 7, 'InvalidShape'], ['sidebar.sort', { tasks: 'recent' }, 'InvalidShape'], ['view.open', 'settings', 'InvalidShape'], ['appearance.theme', 'sepia', 'InvalidShape'], ['find.query', 'x'.repeat(513), 'LimitExceeded'], ['tiles.layout', ['1', '2', '3', '4', '5', '6', '7'], 'LimitExceeded']] as const) {
    expect((await service(page, { op: 'set', key, value })).error.code, key).toBe(code);
  }
  expect((await service(page, { op: 'set', key: 'view.open', value: 'board', remote: true })).error.code).toBe('InvalidShape');
  // No grant, a revoked grant, a package that is not installed: PermissionDenied naming the permission; nothing changes.
  await hook(page, 'revoke');
  for (const params of [{ op: 'list' }, { op: 'get', key: 'view.open' }, { op: 'set', key: 'view.open', value: 'board' }]) {
    expect((await service(page, params)).error).toMatchObject({ code: 'PermissionDenied', path: 'workspace.settings' });
  }
  await hook(page, 'grant');
  expect((await service(page, { op: 'get', key: 'view.open' })).value.value).toBe('github');
  await hook(page, 'uninstall');
  expect((await service(page, { op: 'get', key: 'view.open' })).error.code).toBe('PermissionDenied');
  expect((await service(page, { op: 'get', key: 'view.open' }, 'other.package')).error.code).toBe('PermissionDenied');
});

test('extensions workspace settings: the window applies a package change to its own storage, labelled, and acknowledges it', async ({ page }) => {
  await boot(page);
  const events = await page.evaluate(() => { const seen: unknown[] = []; (window as any).__settingEvents = seen; window.addEventListener('pandacode-workspace-setting', event => seen.push((event as CustomEvent).detail)); return seen.length; });
  expect(events).toBe(0);
  expect((await service(page, { op: 'set', key: 'appearance.compact', value: true })).ok).toBe(true);
  expect((await service(page, { op: 'set', key: 'sidebar.scope', value: 15 })).ok).toBe(true);
  expect((await service(page, { op: 'set', key: 'sidebar.filter', value: 'project-1' })).ok).toBe(true);
  expect((await service(page, { op: 'set', key: 'council', value: { target: 9, maxRounds: 10, reviewers: 2, newThreads: true } })).ok).toBe(true);
  await expect.poll(() => sent(page, 'pandacode.compact'), { timeout: 15_000 }).toBe('true');
  await expect(page.locator('body')).toHaveClass(/compact/);
  expect(JSON.parse((await sent(page, 'pandacode.sidebar.sort')) ?? '{}').perProject).toBe(15);
  expect(await sent(page, 'pandacode.projectFilter')).toBe('project-1');
  expect(JSON.parse((await sent(page, 'pandacode.council')) ?? '{}')).toMatchObject({ target: 9, maxRounds: 10, reviewers: 2, newThreads: true });
  // The surface hears each change with the package that made it, and nothing stays pending.
  await expect.poll(() => page.evaluate(() => (window as any).__settingEvents.length), { timeout: 15_000 }).toBeGreaterThanOrEqual(4);
  const detail = await page.evaluate(() => (window as any).__settingEvents.find((event: any) => event.key === 'appearance.compact'));
  expect(detail).toMatchObject({ key: 'appearance.compact', value: true, by: OWNER });
  await expect.poll(async () => (await hook(page, 'state') as any).pending, { timeout: 15_000 }).toBe(0);
  // The user's own change goes the other way: the window publishes it and the package reads it.
  await page.evaluate(() => localStorage.setItem('pandacode.view', 'github'));
  await expect.poll(async () => (await service(page, { op: 'get', key: 'view.open' })).value.value, { timeout: 15_000 }).toBe('github');
});
