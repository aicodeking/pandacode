import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-context/extension.json', import.meta.url), 'utf8'));
const companion = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const panel = (page: Page) => page.getByRole('region', { name: 'Project context inspector', exact: true });
const output = (page: Page) => panel(page).locator('.extension-context-output');
const trigger = (page: Page) => page.locator('[data-extension-contribution="sample.project-context/header"]');
async function setup(page: Page, packages = [manifest]) {
  await page.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?project-context'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page) { await trigger(page).click(); await expect(output(page)).toHaveText('PermissionDenied'); }
async function allow(page: Page, kind: 'project' | 'task' = 'project') {
  await panel(page).getByRole('button', { name: `Allow ${kind} summaries`, exact: true }).click(); await expect(output(page)).toContainText('Ready');
}
test('extensions context: inspector separates denied project/task grants and displays only bounded summary pages', async ({ page }) => {
  await setup(page); await open(page); await allow(page);
  await expect(output(page)).toContainText('orbit (project-1)'); await expect(output(page)).toContainText('Schema 1 · revision');
  await panel(page).getByRole('button', { name: 'Refresh task summaries', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await page.evaluate(() => (window as any).__extensionContext.addTasks()); await allow(page, 'task');
  await expect(output(page).locator('p')).toHaveCount(11); await expect(output(page)).not.toContainText('session-4');
  const first = await output(page).textContent();
  await panel(page).getByRole('button', { name: 'Next page', exact: true }).click(); await expect(output(page)).toContainText('session-3');
  await expect(output(page).locator('p')).toHaveCount(6); await expect(panel(page).getByRole('button', { name: 'Next page', exact: true })).toBeDisabled();
  for (const text of [first, await output(page).textContent()]) for (const marker of ['/Users/', 'TRANSCRIPT_SENTINEL', 'Make search', 'resume', 'token']) expect(text).not.toContain(marker);
});
test('extensions context: E11 delayed A query stays on A after actual navigation to B', async ({ page }) => {
  await setup(page); await open(page); await allow(page);
  await page.evaluate(() => { (window as any).__extensionContext.hold = true; });
  await panel(page).getByRole('button', { name: 'Refresh project summaries', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.waiting)).toBe(true);
  await page.locator('.task-item[data-id="session-4"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-4');
  await page.evaluate(() => (window as any).__extensionContext.release());
  await expect(output(page)).toContainText('orbit (project-1)'); await expect(output(page)).not.toContainText('pandacode (project-2)');
  await expect(panel(page).locator('.extension-context-scope')).toHaveText('Captured project: project-1');
  await panel(page).getByRole('button', { name: 'Close project context', exact: true }).click();
  await trigger(page).click(); await expect(output(page)).toHaveText('PermissionDenied'); await allow(page); await expect(output(page)).toContainText('pandacode (project-2)');
});
test('extensions context: stale pagination, deleted project and timeout are stable visible states', async ({ page }) => {
  await setup(page); await open(page); await page.evaluate(() => (window as any).__extensionContext.addTasks()); await allow(page, 'task');
  await page.evaluate(() => (window as any).__extensionContext.change());
  await panel(page).getByRole('button', { name: 'Next page', exact: true }).click(); await expect(output(page)).toHaveText('StaleContext');
  await page.evaluate(() => { (window as any).__extensionContext.timeout = true; });
  await panel(page).getByRole('button', { name: 'Refresh task summaries', exact: true }).click(); await expect(output(page)).toHaveText('Timeout');
  await page.evaluate(() => (window as any).__extensionContext.removeProject('project-1'));
  await panel(page).getByRole('button', { name: 'Refresh task summaries', exact: true }).click(); await expect(output(page)).toHaveText('NotFound');
});
test('extensions context: revocation wins a delayed result; Escape and disable dispose without losing draft', async ({ page }) => {
  await setup(page, [manifest, companion]); await page.locator('#prompt').fill('Keep context draft'); await open(page); await allow(page);
  await page.evaluate(() => { (window as any).__extensionContext.hold = true; });
  await panel(page).getByRole('button', { name: 'Refresh project summaries', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.waiting)).toBe(true);
  await panel(page).getByRole('button', { name: 'Revoke project summaries', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await page.evaluate(() => (window as any).__extensionContext.release()); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Close project context', exact: true }).focus(); await page.keyboard.press('Escape');
  await expect(panel(page)).toHaveCount(0); await expect(trigger(page)).toBeFocused();
  await trigger(page).press('Enter'); await expect(output(page)).toHaveText('PermissionDenied');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.project-context'); });
  await expect(panel(page)).toHaveCount(0); await expect(trigger(page)).toHaveCount(0); await expect(page.locator('#prompt')).toHaveValue('Keep context draft');
  await page.locator('[data-extension-contribution="sample.project-helper/header"]').click(); await expect(page.locator('#toast')).toHaveText('Extension installed successfully');
});
test('extensions context: actual manager installs disabled fixture, then explicit enable exposes inspector without data grants', async ({ page }) => {
  await setup(page, []); await expect(trigger(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await expect(trigger(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Enable sample.project-context', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await open(page);
});
test('extensions context: no-project API, forbidden IDs and oversize queries have non-echoing envelopes', async ({ page }) => {
  await setup(page); await open(page);
  const result = await page.evaluate(() => {
    const call = (window as any).__extensionContext.call;
    const capture = call({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1 } });
    const handle = capture.value.handle;
    call({ op: 'consent', handle, capability: 'projects.summary', allow: true });
    return [call({ op: 'query', handle, resource: 'projects', limit: 1 }), call({ op: 'query', handle, resource: 'projects', limit: 51 }), call({ op: 'query', handle, resource: 'projects', limit: 1, projectId: 'project-2' })];
  });
  expect(result[0].value).toMatchObject({ schemaVersion: 1, state: 'NoProject', items: [], nextCursor: null });
  expect(result[1].error).toEqual({ schemaVersion: 1, code: 'LimitExceeded', path: '$', ids: [] }); expect(result[2].error.code).toBe('InvalidShape');
});
test('extensions context: conflicting packages fail closed and leave zero-extension core usable', async ({ page }) => {
  await setup(page, [manifest, manifest]); await expect(trigger(page)).toHaveCount(0); await expect(panel(page)).toHaveCount(0);
  await page.locator('#prompt').fill('Core still works'); await expect(page.locator('#prompt')).toHaveValue('Core still works');
});
test('extensions context: inspector renders NoProject for an actual empty preview workspace', async ({ page }) => {
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); localStorage.setItem('pandacode.wallpapers', 'false'); }, manifest);
  await page.goto('/?project-context&no-project'); await open(page);
  await panel(page).getByRole('button', { name: 'Allow project summaries', exact: true }).click();
  await expect(output(page)).toContainText('NoProject'); await expect(output(page)).toContainText('No project selected at invocation.');
  await expect(panel(page).locator('.extension-context-scope')).toHaveText('Captured project: none');
});
test('extensions context: closing the inspector does not leave a stale modal owner in a mixed declarative menu', async ({ page }) => {
  const mixed = structuredClone(manifest);
  mixed.contributes.commands.push({ id: 'sample.project-context/form', title: 'Context form', action: { kind: 'showDialog', dialog: { title: 'Context form', fields: [], successMessage: 'Confirmed' } } });
  mixed.contributes.menus[0].items = [
    { id: 'sample.project-context/query', kind: 'command', title: 'Inspect captured context', command: 'sample.project-context/inspect' },
    { id: 'sample.project-context/open-form', kind: 'command', title: 'Open context form', command: 'sample.project-context/form' },
  ];
  await setup(page, [mixed]); await trigger(page).click(); await page.getByRole('menuitem', { name: 'Inspect captured context', exact: true }).click();
  await expect(output(page)).toHaveText('PermissionDenied'); await panel(page).getByRole('button', { name: 'Close project context', exact: true }).click();
  await trigger(page).click(); await page.getByRole('menuitem', { name: 'Open context form', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Context form — sample.project-context', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
});
