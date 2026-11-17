import { test, expect, type Page } from '@playwright/test';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
// S0610 (upstream sync P6). Written for the final test phase; not run when authored. Browser fixtures only: the grants
// store is the preview's labelled synthetic stand-in. Native authority is proven by the remote::host and
// remote::methods unit tests; the installed WebView and a second machine are not claimed here (docs/extensions/upstream-remote.md).
const root = new URL('../', import.meta.url);
const read = (path: string) => readFileSync(new URL(path, root), 'utf8');
const manifest = JSON.parse(read('tests/fixtures/extensions/upstream-remote/manifest.json'));
const peers: { name: string; peer: Record<string, unknown>; supported: boolean }[] = JSON.parse(read('tests/fixtures/extensions/remote-peers.json'));
const ID = manifest.id as string;
const PERMISSIONS = manifest.permissions as string[];
test.setTimeout(60_000);

const MODULES = readdirSync(new URL('src-tauri/src/remote/methods/', root)).filter(name => name.endsWith('.rs') && name !== 'mod.rs').sort();
const METHOD = /Method \{ name: "([^"]+)", access: Access::(\w+), read_only: (true|false)/g;
const modules = MODULES.map(file => {
  const rows = [...read(`src-tauri/src/remote/methods/${file}`).matchAll(METHOD)].map(match => ({ name: match[1], access: match[2] }));
  return { name: file.slice(0, -3), rows, source: read(`src-tauri/src/remote/methods/${file}`) };
});

test('upstream remote registry: the documented inventory equals the Rust registry and no method reads a package', () => {
  expect(modules.map(module => module.name)).toHaveLength(15);
  const doc = read('docs/extensions/upstream-remote.md');
  const documented = Object.fromEntries([...doc.matchAll(/^\| `(\w+)` \| (\d+) \| (\d+) \| (\d+) \| (\d+) \|$/gm)].map(match => [match[1], match.slice(2).map(Number)]));
  for (const module of modules) {
    const count = (access: string) => module.rows.filter(row => row.access === access).length;
    expect(documented[module.name], module.name).toEqual([module.rows.length, count('View'), count('Control'), count('Full')]);
    // Method names are unique across the whole registry.
    expect(module.rows.length, module.name).toBeGreaterThan(0);
    // A method acts under the device grant; none reads a package grant, a manifest or the extension runtime store.
    expect(module.source, module.name).not.toMatch(/runtime_grants|extensions::(runtime|packages|manifest)|RuntimeGrants/);
  }
  const names = modules.flatMap(module => module.rows.map(row => row.name));
  expect(new Set(names).size).toBe(names.length);
  expect(names).toHaveLength(119);
});

test('upstream remote phone: no extension code or adapter runs on the phone and the protocol fixtures are intact', () => {
  expect(existsSync(new URL('mobile/src/extensions', root))).toBe(false);
  for (const check of ['mobile/tests/extensions-projection.test.ts', 'mobile/tests/capabilities.test.ts']) expect(existsSync(new URL(check, root)), check).toBe(true);
  // The phone-facing projection fixture still treats package metadata and desktop HTML as inert data.
  const projection = JSON.parse(read('tests/fixtures/extensions/mobile-projection.json'));
  expect(projection.messages[0].content).toBe('Core history remains readable');
  expect(projection.events.map((event: { kind: string }) => event.kind)).toEqual(['text', 'extension.desktopHtml', 'status']);
  // Core protocol fields a phone relies on are unchanged by the package fixture.
  expect(Object.keys(projection.task)).toEqual(expect.arrayContaining(['sessionId', 'title', 'status', 'projectId', 'provider', 'model']));
  // The fixture package asks for no permission that names a phone, a device or a remote credential.
  expect(PERMISSIONS.some(name => /phone|device|pair|credentials/.test(name))).toBe(false);
});

async function boot(page: Page, query = '', manifests: unknown[] = [manifest]) {
  await page.addInitScript(manifests => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(manifests.map(item => ({ manifest: item, enabled: true, icons: {} }))));
  }, manifests);
  await page.goto(`/?runtime-grants-manager${query}`); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__extensionRuntimeGrants);
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
const section = (page: Page) => page.locator(`[data-grants-package="${ID}"]`);
const row = (page: Page, permission: string) => section(page).locator(`[data-grant-row="${permission}"]`);
const state = (page: Page, permission: string) => row(page, permission).locator('[data-grant-state]');
const projection = (page: Page) => page.evaluate(async id => {
  const { loadRuntimeGrants } = (window as any).__extensionRuntimeGrants;
  return (await loadRuntimeGrants()).packages.find((item: { id: string }) => item.id === id);
}, ID);
const grant = (page: Page, permission: string) => row(page, permission).getByRole('button', { name: `Grant ${permission} for ${ID}` }).click();

test('upstream remote package grants: the installed fixture is granted, attributed, narrowed away and revoked without a prompt', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await expect(section(page).locator('[data-grants-pending]')).toContainText('not granted yet');
  for (const permission of PERMISSIONS) await expect(state(page, permission)).toHaveText('Not granted');
  // Granting a package permission is separate from any device grant: nothing about a paired device changes.
  await grant(page, 'tasks.start'); await expect(state(page, 'tasks.start')).toContainText('Granted');
  await grant(page, 'connections.summary'); await expect(state(page, 'connections.summary')).toContainText('Granted');
  const item = await projection(page);
  expect(item.grants.map((entry: { permission: string }) => entry.permission).sort()).toEqual(['connections.summary', 'tasks.start']);
  expect(item).toMatchObject({ id: ID, archived: false });
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  await row(page, 'tasks.start').getByRole('button', { name: `Revoke tasks.start for ${ID}` }).click();
  await expect(state(page, 'tasks.start')).toHaveText('Not granted');
  expect((await projection(page)).grants.map((entry: { permission: string }) => entry.permission)).toEqual(['connections.summary']);
  await section(page).getByRole('button', { name: `Revoke all permissions of ${ID}` }).click();
  expect((await projection(page)).grants).toEqual([]);
  // Keyboard: a grant button takes focus and Enter grants, as for every grants row.
  const button = row(page, 'tasks.message').getByRole('button', { name: `Grant tasks.message for ${ID}` });
  await button.focus(); await expect(button).toBeFocused(); await page.keyboard.press('Enter');
  await expect(state(page, 'tasks.message')).toContainText('Granted');
});

test('upstream remote stale and foreign: another package or an undeclared name never receives the grant', async ({ page }) => {
  await boot(page); await openExtensions(page);
  const refused = await page.evaluate(async id => {
    const { changeRuntimeGrant } = (window as any).__extensionRuntimeGrants;
    const code = async (request: unknown) => { try { await changeRuntimeGrant(request); return 'ok'; } catch (error) { return (error as Error).message; } };
    return { foreign: await code({ op: 'grant', id: 'sample.someone-else', permission: 'tasks.start' }), undeclared: await code({ op: 'grant', id, permission: 'tasks.draft' }), forged: await code({ op: 'grant', id, permission: 'credentials.read' }) };
  }, ID);
  expect(refused.foreign).toContain('PermissionDenied'); expect(refused.undeclared).toContain('PermissionDenied'); expect(refused.forged).toContain('UnsupportedCapability');
  expect((await projection(page)).grants).toEqual([]);
});

test('upstream remote lifecycle: disable keeps grants but suspends them, uninstall removes them and safe mode lists no package', async ({ page }) => {
  await boot(page); await openExtensions(page);
  await grant(page, 'tasks.message');
  await page.getByRole('button', { name: `Disable ${ID}`, exact: true }).click();
  await expect(section(page).locator('[data-grants-suspended]')).toBeVisible();
  expect(await projection(page)).toMatchObject({ archived: true });
  await page.getByRole('button', { name: `Enable ${ID}`, exact: true }).click();
  await expect(section(page).locator('[data-grants-suspended]')).toHaveCount(0);
  await expect(state(page, 'tasks.message')).toContainText('Granted');
  await page.getByRole('button', { name: `Uninstall ${ID}`, exact: true }).click();
  const confirm = page.getByRole('dialog').getByRole('button', { name: /Uninstall|Remove|Confirm/ });
  if (await confirm.count()) await confirm.first().click();
  await expect(section(page)).toHaveCount(0);
  expect(await projection(page)).toBeUndefined();
});

test('upstream remote safe mode: with the package installed the host lists and grants nothing', async ({ page }) => {
  await boot(page, '&safe-mode'); await openExtensions(page);
  await expect(section(page)).toHaveCount(0);
  expect(await projection(page)).toBeUndefined();
});

test('upstream remote stale host: a captured host that is not the peer starts nothing and keeps history readable', async ({ page }) => {
  const peer = peers.find(entry => entry.name === 'wrong captured host')!;
  expect(peer.supported).toBe(false);
  await page.addInitScript(peer => {
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    (window as any).__extensionRemotePeer = peer;
  }, peer.peer);
  await page.goto('/?extensions-baseline&provider-history');
  await expect(page.locator('[data-provider-recovery]')).toBeVisible();
  const before = await page.evaluate(() => (window as any).__providerHistory.state());
  const failed = await page.evaluate(async () => {
    try { await (window as any).__providerHistory.call('remote_start_task', { deviceId: 'host-a', projectId: 'project-1', provider: 'sample.fake-harness/recorded', model: 'recorded-model', startId: 'captured-start', prompt: 'Do not run locally' }); return false; }
    catch { return true; }
  });
  expect(failed).toBe(true);
  expect(await page.evaluate(() => (window as any).__providerHistory.state())).toEqual(before);
  expect(await page.evaluate(() => (window as any).__remoteStarts ?? [])).toEqual([]);
});
