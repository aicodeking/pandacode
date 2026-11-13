import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/test-runner/extension.json', 'utf8'));
async function seed(page: Page) {
  await page.addInitScript(manifest => {
    const other = JSON.parse(JSON.stringify(manifest).replaceAll(manifest.id, 'other.test-runner'));
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, other].map(manifest => ({ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } }))));
  }, manifest);
  await page.goto('/?extension-jobs'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function capture(page: Page, owner = manifest.id, projectId = 'project-1') {
  return page.evaluate(async ({ owner, projectId }) => {
    const reply = await (window as any).__extensionJobs.context({ op: 'capture', id: `${owner}/run`, version: '1.0.0', context: { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.commands', projectId, revision: 1 } });
    if (!reply.ok) throw new Error(reply.error.code); return reply.value.handle as string;
  }, { owner, projectId });
}
async function call(page: Page, handle: string, request: Record<string, unknown>, owner = manifest.id) {
  return page.evaluate(({ handle, request, owner }) => (window as any).__extensionJobs.call(handle, { tool: `${owner}/test`, ...request }), { handle, request, owner });
}
test('extensions jobs: scoped authorization, literal text, forged cancellation and single terminal states', async ({ page }) => {
  await seed(page);
  const a = await capture(page), b = await capture(page, manifest.id, 'project-2'), other = await capture(page, 'other.test-runner');
  expect((await call(page, a, { op: 'start', args: [] })).error.code).toBe('PermissionDenied');
  expect((await call(page, a, { op: 'grant', allow: true })).ok).toBe(true);
  expect((await call(page, b, { op: 'start', args: [] })).error.code).toBe('PermissionDenied');
  const text = 'project; $(whoami) & --eval="bad"';
  const job = (await call(page, a, { op: 'start', args: [text] })).value.job;
  for (const [handle, owner] of [[b, manifest.id], [other, 'other.test-runner']]) expect((await call(page, handle, { op: 'cancel', job }, owner)).error.code).toBe('PermissionDenied');
  expect((await call(page, a, { op: 'cancel', job: '1234', pid: 1234 })).error.code).toBe('InvalidShape');
  expect((await call(page, a, { op: 'start', args: [], cwd: '../other' })).error.code).toBe('InvalidShape');
  for (let i = 0; i < 3; i++) await call(page, a, { op: 'poll', job });
  const complete = (await call(page, a, { op: 'poll', job })).value;
  expect(complete.state).toBe('completed'); expect(complete.result.args).toEqual([text]);
  expect((await call(page, a, { op: 'cancel', job })).value).toEqual(complete);
  const wait = (await call(page, a, { op: 'start', args: ['wait'] })).value.job;
  await call(page, a, { op: 'grant', allow: false });
  expect((await call(page, a, { op: 'poll', job: wait })).value.state).toBe('cancelled');
  expect((await call(page, a, { op: 'start', args: [] })).error.code).toBe('PermissionDenied');
  await call(page, a, { op: 'grant', allow: true });
  const timeout = (await call(page, a, { op: 'start', args: ['timeout'] })).value.job;
  for (let i = 0; i < 3; i++) await call(page, a, { op: 'poll', job: timeout });
  expect((await call(page, a, { op: 'cancel', job: timeout })).value.state).toBe('timeout');
});
test('extensions jobs: button, progress, cancel, Escape/focus and unrelated composer continuity', async ({ page }) => {
  await seed(page);
  const button = page.locator('[data-extension-contribution="sample.test-runner/button"]');
  await button.click();
  const panel = page.getByRole('region', { name: 'Extension tool', exact: true });
  await expect(panel.getByRole('status')).toHaveText('Not authorized — no process started');
  await panel.getByLabel('Literal argument (optional)').fill('wait');
  await panel.getByRole('button', { name: 'Authorize this project and run tool', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Job running');
  await panel.getByRole('button', { name: 'Cancel owned job', exact: true }).click();
  await expect(panel.getByRole('status')).toContainText('Job cancelled');
  await page.keyboard.press('Escape'); await expect(panel).toHaveCount(0); await expect(button).toBeFocused();
  await page.locator('#prompt').fill('core draft preserved');
  await button.click(); await panel.getByRole('button', { name: 'Authorize this project and run tool', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Job completed');
  await expect(panel.getByLabel('Tool progress and result')).toContainText('"passed":1');
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.test-runner'));
  await expect(panel).toHaveCount(0); await expect(page.locator('#prompt')).toHaveValue('core draft preserved');
  await expect(page.getByRole('button', { name: 'Run local tests', exact: true })).toHaveCount(1);
});
test('extensions jobs: same-owner invocations cannot inherit grants or cancel each other and release stops only owned work', async ({ page }) => {
  await seed(page);
  const a = await capture(page), b = await capture(page);
  await call(page, a, { op: 'grant', allow: true });
  expect((await call(page, b, { op: 'start', args: [] })).error?.code).toBe('PermissionDenied');
  const job = (await call(page, a, { op: 'start', args: ['wait'] })).value.job;
  expect((await call(page, b, { op: 'cancel', job })).error?.code).toBe('PermissionDenied');
  await call(page, b, { op: 'grant', allow: true });
  const other = (await call(page, b, { op: 'start', args: ['wait'] })).value.job;
  await page.evaluate(handle => (window as any).__extensionJobs.context({ op: 'release', handle }), a);
  expect((await call(page, b, { op: 'poll', job: other })).value.state).toBe('running');
  const fresh = await capture(page);
  expect((await call(page, fresh, { op: 'start', args: [] })).error?.code).toBe('PermissionDenied');
});
test('extensions jobs: local package install requires separate executable trust before scoped tool consent', async ({ page }) => {
  await page.goto('/?extension-jobs'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.test-runner', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  await page.getByRole('button', { name: 'Review executable trust sample.test-runner', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  await dialog.getByRole('button', { name: 'Review full authority', exact: true }).click(); await dialog.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.test-runner', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Run local tests', exact: true }).click();
  const panel = page.getByRole('region', { name: 'Extension tool', exact: true });
  await expect(panel.getByRole('status')).toHaveText('Not authorized — no process started');
  await panel.getByRole('button', { name: 'Authorize this project and run tool', exact: true }).click();
  await expect(panel.getByRole('status')).toHaveText('Job completed');
});
