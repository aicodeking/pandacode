import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-reads/extension.json', import.meta.url), 'utf8'));
const panel = (page: Page) => page.getByRole('region', { name: 'Project context inspector', exact: true });
const output = (page: Page) => panel(page).locator('.extension-project-read-output');
async function setup(page: Page, fixture = manifest) {
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.wallpapers', 'false'); localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); }, fixture);
  await page.goto('/?project-context'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('[data-extension-contribution="sample.project-reads/header"]').click();
  await panel(page).getByText('Separately authorized file and Git reads', { exact: true }).click();
  await panel(page).getByLabel('Relative file path', { exact: true }).fill('README.md');
}
test('extensions project reads: summary-only declaration cannot grant paths/content or Git', async ({ page }) => {
  const summary = structuredClone(manifest); summary.permissions = ['ui.contribute', 'projects.summary'];
  await setup(page, summary);
  await panel(page).getByRole('button', { name: 'Allow project summaries', exact: true }).click();
  await expect(panel(page).locator('.extension-context-output')).toContainText('orbit');
  for (const name of ['Read file metadata', 'Allow file metadata', 'Read file content', 'Allow file content', 'Allow Git HEAD']) {
    await panel(page).getByRole('button', { name, exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  }
  await expect(output(page)).not.toContainText('Synthetic project A');
});
test('extensions project reads: exact metadata/content/Git grants are independent and revoked without writing', async ({ page }) => {
  await setup(page);
  await panel(page).getByRole('button', { name: 'Read file content', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Allow file metadata', exact: true }).click(); await expect(output(page)).toContainText('"path": "README.md"');
  await expect(output(page)).not.toContainText('Synthetic project A');
  await panel(page).getByRole('button', { name: 'Read file content', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Allow file content', exact: true }).click(); await expect(output(page)).toContainText('Synthetic project A read-only content');
  await panel(page).getByLabel('Relative file path', { exact: true }).press('Enter'); await expect(output(page)).toContainText('Synthetic project A read-only content');
  await panel(page).getByRole('button', { name: 'Allow Git HEAD', exact: true }).click(); await expect(output(page)).toContainText('"branch": "main"');
  for (const secret of ['token', '/Users/', 'AUTH_', 'environment', 'config']) await expect(output(page)).not.toContainText(secret);
  await panel(page).getByRole('button', { name: 'Revoke file content', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Read file content', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
});
test('extensions project reads: UTF8 pagination, large/binary errors and forbidden path consent are bounded', async ({ page }) => {
  await setup(page);
  const path = panel(page).getByLabel('Relative file path', { exact: true });
  await path.fill('paged.txt'); await panel(page).getByRole('button', { name: 'Allow file content', exact: true }).click();
  await expect(output(page)).toContainText('€'.repeat(1365));
  await panel(page).getByRole('button', { name: 'Next file page', exact: true }).click();
  await expect(output(page)).toContainText('€'.repeat(635)); await expect(panel(page).getByRole('button', { name: 'Next file page', exact: true })).toBeDisabled();
  for (const [file, code] of [['large.txt', 'LimitExceeded'], ['binary.bin', 'UnsupportedCapability'], ['../outside', 'PermissionDenied'], ['.env', 'PermissionDenied']]) {
    await path.fill(file); await panel(page).getByRole('button', { name: 'Allow file content', exact: true }).click(); await expect(output(page)).toHaveText(code);
  }
});
test('extensions project reads: delayed A stays on A after B navigation; cancellation and Escape suppress late UI', async ({ page }) => {
  await setup(page); await page.locator('#prompt').fill('Preserve project read draft');
  await panel(page).getByRole('button', { name: 'Allow file content', exact: true }).click(); await expect(output(page)).toContainText('Synthetic project A');
  await page.evaluate(() => { (window as any).__extensionContext.hold = true; });
  await panel(page).getByRole('button', { name: 'Read file content', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.waiting)).toBe(true);
  await page.locator('.task-item[data-id="session-4"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-4');
  await page.evaluate(() => (window as any).__extensionContext.release());
  await expect(output(page)).toContainText('Synthetic project A'); await expect(output(page)).not.toContainText('Synthetic project B');
  await page.evaluate(() => { (window as any).__extensionContext.hold = true; });
  await panel(page).getByRole('button', { name: 'Read file content', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.waiting)).toBe(true);
  await panel(page).getByRole('button', { name: 'Cancel read', exact: true }).click(); await expect(output(page)).toHaveText('Cancelled');
  await page.evaluate(() => (window as any).__extensionContext.release()); await expect(output(page)).toHaveText('Cancelled');
  await panel(page).getByRole('button', { name: 'Close project context', exact: true }).focus(); await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  await page.locator('.task-item[data-id="session-1"]').click(); await expect(page.locator('#prompt')).toHaveValue('Preserve project read draft');
});
test('extensions project reads: disable clears scoped grants and restores core with the draft intact', async ({ page }) => {
  await setup(page); await page.locator('#prompt').fill('Keep read draft');
  await panel(page).getByRole('button', { name: 'Allow file content', exact: true }).click(); await expect(output(page)).toContainText('Synthetic project A');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.project-reads'); });
  await expect(panel(page)).toHaveCount(0); await expect(page.locator('[data-extension-contribution="sample.project-reads/header"]')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('Keep read draft');
});
test('extensions project reads: stale revision, forged retarget/mutation and removed project return fixed errors', async ({ page }) => {
  await setup(page);
  const replies = await page.evaluate(() => {
    const fixture = (window as any).__extensionContext, call = fixture.call;
    const handle = call({ op: 'capture', id: 'sample.project-reads/header', version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId: 'project-1' } }).value.handle;
    call({ op: 'readConsent', handle, capability: 'projects.files.read', path: 'paged.txt', allow: true });
    const read = { op: 'read', handle, resource: 'file', path: 'paged.txt' }, first = call(read).value;
    fixture.readData.files['project-1']['paged.txt'] = 'changed';
    const replies = [call({ ...read, cursor: first.nextCursor, revision: first.revision }), call({ ...read, projectId: 'project-2' }), call({ op: 'write', handle, path: 'paged.txt', content: 'mutation' })];
    fixture.removeProject('project-1'); replies.push(call(read)); return replies;
  });
  expect(replies.map((reply: any) => reply.error)).toEqual(['StaleContext', 'InvalidShape', 'InvalidShape', 'NotFound'].map(code => ({ schemaVersion: 1, code, path: '$', ids: [] })));
});
