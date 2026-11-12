import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/storage-laboratory/extension.json', 'utf8'));
const owner = manifest.id;
async function seed(page: Page) {
  await page.addInitScript(manifest => {
    if (!localStorage.getItem('storage-seeded')) {
      const other = JSON.parse(JSON.stringify(manifest).replaceAll(manifest.id, 'other.storage-laboratory'));
      localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, other].map(manifest => ({ manifest, enabled: true, icons: {} }))));
      localStorage.setItem('storage-seeded', 'true');
    }
  }, manifest);
  await page.goto('/?extension-storage'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function settings(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
}
async function capture(page: Page, id = owner, projectId = 'project-1'): Promise<string> {
  return page.evaluate(async ({ id, projectId }) => {
    const reply = await (window as any).__extensionStorage.context({ op: 'capture', id: `${id}/inspect`, version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', projectId, revision: 1 } });
    if (!reply.ok) throw new Error(reply.error.code);
    return reply.value.handle;
  }, { id, projectId });
}
async function call(page: Page, handle: string, request: Record<string, unknown>) { return page.evaluate(({ handle, request }) => (window as any).__extensionStorage.call(handle, request), { handle, request }); }
test('extensions storage: supported API isolation, captured projects, persisted grants and scoped change events after restart', async ({ page }) => {
  await seed(page); await settings(page);
  for (const id of [owner, 'other.storage-laboratory']) await page.getByRole('button', { name: `Allow private storage ${id}`, exact: true }).click();
  const a = await capture(page), b = await capture(page, owner, 'project-2'), other = await capture(page, 'other.storage-laboratory');
  for (const [handle, scope, value] of [[a, 'global', 'global'], [a, 'project', 'project A'], [b, 'project', 'project B'], [other, 'global', 'other']]) expect((await call(page, handle, { op: 'set', scope, key: 'same', value })).ok).toBe(true);
  expect(await page.evaluate(async owner => {
    const client = (window as any).__extensionStorage;
    const key = await client.capture(owner, 'project-1');
    const value = await client.adapterGet(key); client.dispose(key); return value.value;
  }, owner)).toBe('project A');
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  const next = await capture(page), nextB = await capture(page, owner, 'project-2'), nextOther = await capture(page, 'other.storage-laboratory');
  for (const [handle, scope, value] of [[next, 'global', 'global'], [next, 'project', 'project A'], [nextB, 'project', 'project B'], [nextOther, 'global', 'other']]) expect((await call(page, handle, { op: 'get', scope, key: 'same' })).value.value).toBe(value);
  const stream = (await call(page, next, { op: 'subscribe', scope: 'project' })).value;
  await call(page, nextB, { op: 'set', scope: 'project', key: 'B-only', value: 1 });
  await call(page, next, { op: 'set', scope: 'project', key: 'A-only', value: 1 });
  const events = { op: 'events', scope: 'project', subscription: stream.subscription, cursor: stream.cursor };
  expect((await call(page, nextOther, events)).ok).toBe(false);
  expect((await call(page, next, events)).value.events).toEqual([{ sequence: 2, keys: ['A-only'] }]);
  expect((await call(page, next, { op: 'get', scope: 'global', key: 'same', owner: 'other.storage-laboratory' })).error.code).toBe('InvalidShape');
  await settings(page); await page.getByRole('button', { name: `Revoke private storage ${owner}`, exact: true }).click();
  expect((await call(page, next, { op: 'get', scope: 'global', key: 'same' })).error.code).toBe('PermissionDenied');
});
test('extensions storage: disable retains data and ends streams; explicit own-data removal is cancelable and keyboard accessible', async ({ page }) => {
  await seed(page); await settings(page);
  await page.getByRole('button', { name: `Allow private storage ${owner}`, exact: true }).click();
  const handle = await capture(page); await call(page, handle, { op: 'set', scope: 'global', key: 'same', value: 'keep' });
  await call(page, handle, { op: 'subscribe', scope: 'global' });
  await page.getByRole('button', { name: `Disable ${owner}`, exact: true }).click();
  expect((await call(page, handle, { op: 'snapshot', scope: 'global' })).ok).toBe(false);
  await page.getByRole('button', { name: `Enable ${owner}`, exact: true }).click();
  expect((await call(page, await capture(page), { op: 'get', scope: 'global', key: 'same' })).value.value).toBe('keep');
  const removal = page.getByRole('button', { name: `Uninstall and remove private data ${owner}`, exact: true });
  await removal.focus(); await page.keyboard.press('Enter');
  const dialog = page.getByRole('dialog', { name: 'Uninstall extension? — panda.core', exact: true });
  await expect(dialog).toBeVisible(); await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(removal).toBeFocused();
  await removal.click();
  await dialog.getByRole('switch', { name: `Also remove only ${owner} private settings and storage`, exact: true }).check();
  await dialog.getByRole('button', { name: 'Uninstall extension', exact: true }).click();
  await expect(page.getByRole('button', { name: `Enable ${owner}`, exact: true })).toHaveCount(0);
  expect(await page.evaluate(id => localStorage.getItem(`pandacode.preview.extension-private.v1.${id}`), owner)).toBeNull();
  await expect(page.getByRole('button', { name: 'Disable other.storage-laboratory', exact: true })).toBeVisible();
});
