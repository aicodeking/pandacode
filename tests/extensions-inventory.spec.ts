import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-context/extension.json', import.meta.url), 'utf8'));
const panel = (page: Page) => page.getByRole('region', { name: 'Project context inspector', exact: true });
const output = (page: Page) => panel(page).locator('.extension-context-output');
const stream = (page: Page) => panel(page).locator('.extension-context-stream');
async function setup(page: Page) {
  await page.addInitScript(manifest => { localStorage.setItem('pandacode.wallpapers', 'false'); localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); }, manifest);
  await page.goto('/?project-context'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('[data-extension-contribution="sample.project-context/header"]').click(); await expect(output(page)).toHaveText('PermissionDenied');
}
test('extensions inventory: consent shows observed CLI states/versions/capabilities and scoped non-secret connections', async ({ page }) => {
  await setup(page);
  await panel(page).getByRole('button', { name: 'Watch harnesses', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Allow harness inventory', exact: true }).click();
  await expect(output(page)).toContainText('Claude Code · Installed · version 2.1.0 · host capabilities: start, cancel');
  await expect(output(page)).toContainText('Codex · Absent · version Unknown'); await expect(output(page)).toContainText('Kimi · Unknown · version Unknown');
  await panel(page).getByRole('button', { name: 'Allow connection summaries', exact: true }).click();
  await expect(output(page)).toContainText('claude (context-connection) · Configured · authentication Unknown · harness.launch');
  await expect(output(page)).not.toContainText('other-connection');
  expect(await page.evaluate(() => (window as any).__extensionContext.subscriptionCount())).toBe(1);
});
test('extensions inventory: live owned-job terminal events, progress coalescing and explicit resync render safely', async ({ page }) => {
  await setup(page); await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click();
  await expect(stream(page)).toContainText('Watching granted stream'); await expect(output(page)).toContainText('session-1'); await expect(output(page)).not.toContainText('session-4');
  await page.evaluate(() => { const f = (window as any).__extensionContext; f.record('session-1', 'progress', 'running'); f.record('session-1', 'progress', 'running'); });
  await expect(stream(page)).toContainText('Resynced snapshot'); await expect(output(page)).toContainText('session-1 · running');
  await page.evaluate(() => (window as any).__extensionContext.record('session-1', 'terminal', 'completed'));
  await expect(output(page)).toContainText('session-1 · completed'); await expect(stream(page)).toContainText('terminal: session-1 completed');
  const text = await panel(page).textContent(); for (const secret of ['TRANSCRIPT_SENTINEL', '/Users/', 'SECRET', 'resumeId', 'environment', 'pid:']) expect(text).not.toContain(secret);
});
test('extensions inventory: captured A subscription survives navigation to B without inheriting B streams', async ({ page }) => {
  await setup(page); await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click(); await expect(output(page)).toContainText('session-1');
  await page.locator('.task-item[data-id="session-4"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-4');
  await page.evaluate(() => { const f = (window as any).__extensionContext; f.record('session-4', 'terminal', 'failed'); f.record('session-1', 'terminal', 'stopped'); });
  await expect(output(page)).toContainText('session-1 · stopped'); await expect(output(page)).not.toContainText('session-4'); await expect(stream(page)).not.toContainText('session-4');
  await panel(page).getByRole('button', { name: 'Close project context', exact: true }).click();
  await page.locator('[data-extension-contribution="sample.project-context/header"]').click(); await expect(output(page)).toHaveText('PermissionDenied');
  await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click();
  await expect(output(page)).toContainText('session-4 · failed'); await expect(output(page)).not.toContainText('session-1');
});
test('extensions inventory: revocation, Escape and disable release all subscriptions and retain the draft', async ({ page }) => {
  await setup(page); await page.locator('#prompt').fill('Inventory draft');
  await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click(); await expect(stream(page)).toContainText('Watching granted stream');
  await panel(page).getByRole('button', { name: 'Revoke owned-job summaries', exact: true }).click(); await expect(output(page)).toHaveText('PermissionDenied');
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.subscriptionCount())).toBe(0);
  await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click(); await expect(stream(page)).toContainText('Watching granted stream');
  await panel(page).getByRole('button', { name: 'Close project context', exact: true }).focus(); await page.keyboard.press('Escape'); await expect(panel(page)).toHaveCount(0);
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.subscriptionCount())).toBe(0);
  await page.locator('[data-extension-contribution="sample.project-context/header"]').click();
  await panel(page).getByRole('button', { name: 'Watch jobs', exact: true }).click(); await expect(stream(page)).toContainText('Watching granted stream');
  await page.evaluate(async () => (window as any).__previewDisableExtension('sample.project-context'));
  await expect(panel(page)).toHaveCount(0); await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.subscriptionCount())).toBe(0); await expect(page.locator('#prompt')).toHaveValue('Inventory draft');
});
test('extensions inventory: project removal closes a live stream with a fixed NotFound error', async ({ page }) => {
  await setup(page); await panel(page).getByRole('button', { name: 'Allow owned-job summaries', exact: true }).click(); await expect(stream(page)).toContainText('Watching granted stream');
  await page.evaluate(() => (window as any).__extensionContext.removeProject('project-1'));
  await expect(output(page)).toHaveText('NotFound'); await expect(stream(page)).toHaveText('Subscription closed');
  await expect.poll(() => page.evaluate(() => (window as any).__extensionContext.subscriptionCount())).toBe(0);
});
