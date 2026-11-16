import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the grants store is the preview's labelled synthetic stand-in (page storage). The native
// store is proven by src-tauri/src/extensions/runtime_grants_manager.rs over the same fixtures.
const read = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/extensions/runtime-grants-manager/${name}.json`, import.meta.url), 'utf8'));
const fixture = read('extension'), update = read('update'), plain = read('plain');
const ID = fixture.id as string;
// Each test boots the whole app (and one reloads it); a cold WebKit load alone can take several seconds.
test.setTimeout(60_000);

async function boot(page: Page, manifests: unknown[]) {
  await page.addInitScript(manifests => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(manifests.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, manifests);
  await page.goto('/?runtime-grants-manager'); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 });
  await page.waitForFunction(() => (window as any).__extensionRuntimeGrants);
}
async function openExtensions(page: Page) {
  await page.locator('html[data-ready]').waitFor({ state: 'attached', timeout: 30_000 });
  const tab = page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true });
  // Right after a reload the shortcut can land before the app wires it, so retry the whole open.
  await expect(async () => {
    if (!(await tab.isVisible())) await page.keyboard.press('ControlOrMeta+,');
    await tab.click({ timeout: 2000 });
  }).toPass({ timeout: 15_000 });
  await expect(page.locator('#settings-panel-extensions')).toBeVisible();
}
const section = (page: Page, id = ID) => page.locator(`[data-grants-package="${id}"]`);
const row = (page: Page, permission: string, id = ID) => section(page, id).locator(`[data-grant-row="${permission}"]`);
const state = (page: Page, permission: string) => row(page, permission).locator('[data-grant-state]');
const projection = (page: Page) => page.evaluate(async id => {
  const { loadRuntimeGrants } = (window as any).__extensionRuntimeGrants;
  return (await loadRuntimeGrants()).packages.find((item: { id: string }) => item.id === id);
}, ID);
const scopeOf = async (page: Page, permission: string) => (await projection(page)).grants.find((grant: { permission: string }) => grant.permission === permission)?.scope;

test('grants manager: install a fixture, grant one project, tool kind and credential item, and the page shows the persisted effective grant', async ({ page }) => {
  await boot(page, [fixture, plain]); await openExtensions(page);
  await expect(section(page).locator('[data-grants-pending]')).toContainText('not granted yet: credentials.use, harness.hooks.decide, tasks.start');
  for (const permission of ['tasks.start', 'harness.hooks.decide', 'credentials.use']) await expect(state(page, permission)).toHaveText('Not granted');
  const projects = row(page, 'tasks.start').locator('[data-grant-project]');
  expect(await projects.count()).toBeGreaterThan(0);
  const projectId = await projects.first().getAttribute('data-grant-project');
  await projects.first().check();
  await row(page, 'tasks.start').getByRole('button', { name: `Grant tasks.start for ${ID}` }).click();
  await expect(state(page, 'tasks.start')).toContainText('Granted · Projects:');
  await row(page, 'harness.hooks.decide').locator('[data-grant-project]').first().check();
  await row(page, 'harness.hooks.decide').locator('[data-grant-tool-kinds]').fill('shell');
  await row(page, 'harness.hooks.decide').getByRole('button', { name: `Grant harness.hooks.decide for ${ID}` }).click();
  await expect(state(page, 'harness.hooks.decide')).toContainText('Tool kinds: shell');
  await row(page, 'credentials.use').locator('[data-grant-items]').fill('github');
  await row(page, 'credentials.use').getByRole('button', { name: `Grant credentials.use for ${ID}` }).click();
  await expect(state(page, 'credentials.use')).toHaveText('Granted · Credential items: github');
  // No per-action prompt was needed, and the page equals the persisted projection.
  await expect(page.locator('dialog[open]')).toHaveCount(0);
  expect(await scopeOf(page, 'tasks.start')).toEqual({ projects: [projectId] });
  expect(await scopeOf(page, 'harness.hooks.decide')).toEqual({ projects: [projectId], toolKinds: ['shell'] });
  expect(await scopeOf(page, 'credentials.use')).toEqual({ items: ['github'] });
  // A reload is the restart: the persisted grant is still what the page shows.
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 }); await openExtensions(page);
  await expect(state(page, 'credentials.use')).toHaveText('Granted · Credential items: github');
  await expect(state(page, 'tasks.start')).toContainText('Granted · Projects:');
});

test('grants manager: narrowing never widens, revoke and revoke all take effect and the page and the store agree', async ({ page }) => {
  await boot(page, [fixture]); await openExtensions(page);
  const items = row(page, 'credentials.use').locator('[data-grant-items]');
  await items.fill('github, openai');
  await row(page, 'credentials.use').getByRole('button', { name: `Grant credentials.use for ${ID}` }).click();
  await expect(state(page, 'credentials.use')).toHaveText('Granted · Credential items: github, openai');
  await row(page, 'credentials.use').locator('[data-grant-items]').fill('github');
  await row(page, 'credentials.use').getByRole('button', { name: `Narrow credentials.use for ${ID}` }).click();
  await expect(state(page, 'credentials.use')).toHaveText('Granted · Credential items: github');
  expect(await scopeOf(page, 'credentials.use')).toEqual({ items: ['github'] });
  // Widening through Narrow is refused natively and the stored grant is unchanged.
  await row(page, 'credentials.use').locator('[data-grant-items]').fill('github, gitlab');
  await row(page, 'credentials.use').getByRole('button', { name: `Narrow credentials.use for ${ID}` }).click();
  await expect(page.locator('#settings-panel-extensions [role="alert"]')).toContainText('InvalidArguments');
  expect(await scopeOf(page, 'credentials.use')).toEqual({ items: ['github'] });
  await row(page, 'tasks.start').getByRole('button', { name: `Grant tasks.start for ${ID}` }).click();
  await expect(state(page, 'tasks.start')).toHaveText('Granted · All projects');
  await row(page, 'tasks.start').getByRole('button', { name: `Revoke tasks.start for ${ID}` }).click();
  await expect(state(page, 'tasks.start')).toHaveText('Not granted');
  expect(await scopeOf(page, 'tasks.start')).toBeUndefined();
  await section(page).getByRole('button', { name: `Revoke all permissions of ${ID}` }).click();
  for (const permission of ['tasks.start', 'harness.hooks.decide', 'credentials.use']) await expect(state(page, permission)).toHaveText('Not granted');
  expect((await projection(page)).grants).toEqual([]);
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('grants manager: an update that adds a permission shows it for review and the new name cannot run before it is granted', async ({ page }) => {
  await boot(page, [fixture]); await openExtensions(page);
  await row(page, 'tasks.start').getByRole('button', { name: `Grant tasks.start for ${ID}` }).click();
  await expect(state(page, 'tasks.start')).toHaveText('Granted · All projects');
  // The update is applied: the next snapshot carries version 1.1.0 with one more permission.
  await page.evaluate(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])), update);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled({ timeout: 30_000 }); await openExtensions(page);
  await expect(section(page).locator('[data-grants-pending]')).toContainText('tasks.message');
  await expect(state(page, 'tasks.message')).toHaveText('Not granted');
  await expect(state(page, 'tasks.start')).toHaveText('Granted · All projects');
  const checks = await page.evaluate(() => {
    const raw = JSON.parse(localStorage.getItem('pandacode.preview.extensions.grants.v1')!);
    return { version: raw.packages['sample.grants-manager'].version, grants: Object.keys(raw.packages['sample.grants-manager'].grants) };
  });
  expect(checks).toEqual({ version: '1.1.0', grants: ['tasks.start'] });
  await row(page, 'tasks.message').getByRole('button', { name: `Grant tasks.message for ${ID}` }).click();
  await expect(state(page, 'tasks.message')).toContainText('Granted');
  await expect(page.locator('dialog[open]')).toHaveCount(0);
});

test('grants manager: a permissionless package keeps its flow and requests cannot forge authority', async ({ page }) => {
  await boot(page, [fixture, plain]); await openExtensions(page);
  await expect(section(page, plain.id).locator('[data-grants-none]')).toHaveText('Declares no permissions; nothing to grant.');
  await expect(section(page, plain.id).locator('[data-grant-op]')).toHaveCount(0);
  await expect(page.getByRole('button', { name: `Disable ${plain.id}`, exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: `Uninstall ${plain.id}`, exact: true })).toBeVisible();
  const refused = await page.evaluate(async ({ id, plainId }) => {
    const { changeRuntimeGrant } = (window as any).__extensionRuntimeGrants;
    const code = async (request: unknown) => { try { await changeRuntimeGrant(request); return 'ok'; } catch (error) { return (error as Error).message; } };
    return {
      foreign: await code({ op: 'grant', id: plainId, permission: 'tasks.start' }),
      undeclared: await code({ op: 'grant', id, permission: 'tasks.control' }),
      unknown: await code({ op: 'grant', id, permission: 'credentials.read' }),
      missing: await code({ op: 'grant', id: 'sample.unknown', permission: 'tasks.start' }),
    };
  }, { id: ID, plainId: plain.id });
  expect(refused.foreign).toContain('PermissionDenied'); expect(refused.undeclared).toContain('PermissionDenied');
  expect(refused.unknown).toContain('UnsupportedCapability'); expect(refused.missing).toContain('PermissionDenied');
  expect((await projection(page)).grants).toEqual([]);
});
