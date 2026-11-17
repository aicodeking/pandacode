import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

// PREVIEW column (browser iframe). The installed native webview column is runtime_rich_mount::tests and the
// installed qualification record; this spec never stands for it.
const rich = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-mount/extension.json', import.meta.url), 'utf8'));
const plain = JSON.parse(readFileSync(new URL('./fixtures/extensions/runtime-rich-mount/declarative/extension.json', import.meta.url), 'utf8'));
type Seed = { manifest: unknown; enabled: boolean; icons: Record<string, string>; executable?: { digest: string; trusted: boolean } };
const trustedRich: Seed = { manifest: rich, enabled: true, icons: {}, executable: { digest: 'preview-rich-mount', trusted: true } };

async function setup(page: Page, packages: Seed[], query = '') {
  await page.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, packages);
  await page.goto(`/?extensions-baseline&rich-mount${query}`);
  await expect(page.locator('#prompt')).toBeEnabled();
}
const grant = (page: Page, op: 'grant' | 'revoke') => page.evaluate(op => (window as any).__extensionRuntimeGrants.changeRuntimeGrant({ op, id: 'sample.rich-mount', permission: 'ui.richViews' }), op);
const slot = (page: Page) => page.locator('.extension-rich-panel');
const board = (page: Page) => page.frameLocator('.extension-rich-panel iframe').frameLocator('iframe').locator('#board');
async function openBoard(page: Page) { await page.getByRole('button', { name: 'Open mounted board', exact: true }).click(); await expect(slot(page)).toBeVisible(); }
async function runningTask(page: Page) {
  await page.locator('#prompt').fill('Keep this recorded task running'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#prompt').fill('Preserved draft beside the panel');
}
async function taskUntouched(page: Page) {
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#prompt')).toHaveValue('Preserved draft beside the panel');
  await page.locator('#prompt').press('End'); await page.keyboard.type('!');
  await expect(page.locator('#prompt')).toHaveValue('Preserved draft beside the panel!');
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.filter((call: any) => ['stop_session', 'stop_task', 'cancel_task', 'delete_session', 'close_terminal'].includes(call.command))).toEqual([]);
  expect(calls.filter((call: any) => call.command === 'send_message')).toHaveLength(1);
}

test('extensions rich mount: an installed rich panel opens in the inspector and a separate window only after trust and grant; a declarative view needs neither', async ({ page }) => {
  await setup(page, [{ manifest: plain, enabled: true, icons: {} }]);
  // Declarative views work without executable trust.
  await page.getByRole('button', { name: 'Open plain summary', exact: true }).click();
  await expect(page.locator('.extension-inspector-view')).toContainText('Fix the build');
  await expect(page.locator('.extension-inspector-view iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.rich-mount', exact: true }).click();
  await expect(page.getByRole('alert')).toHaveText('ExecutableTrustRequired');
  await page.getByRole('button', { name: 'Review executable trust sample.rich-mount', exact: true }).click();
  const trust = page.getByRole('dialog', { name: 'Trust executable extension? — panda.core', exact: true });
  await trust.getByRole('button', { name: 'Review full authority', exact: true }).click();
  await trust.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.rich-mount', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  // Trusted but not granted: the host-rendered text and a note, no frame and no window.
  let popups = 0; page.on('popup', () => popups++);
  await openBoard(page);
  await expect(page.locator('.extension-inspector-view')).toContainText('Host-rendered board summary');
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'PermissionDenied');
  await expect(slot(page)).toContainText('Grant ui.richViews to sample.rich-mount');
  await expect(slot(page).locator('iframe')).toHaveCount(0);
  await page.getByRole('button', { name: 'Open isolated extension window', exact: true }).click();
  await expect(page.locator('.extension-inspector-view [role="status"]')).toContainText('Grant ui.richViews');
  expect(popups).toBe(0);
  // Granted: the inspector placement mounts at once, and the separate window opens.
  await grant(page, 'grant');
  await expect(board(page)).toHaveText('sample.rich-mount 1.0.0: Mounted board');
  await expect(page.frameLocator('.extension-rich-panel iframe').frameLocator('iframe').locator('#placement')).toContainText('mount: extension-panel-');
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open isolated extension window', exact: true }).click();
  const popup = await opened;
  await expect(popup.getByRole('status')).toHaveText('Isolated extension view');
  await expect(popup.frameLocator('iframe').locator('#board')).toHaveText('sample.rich-mount 1.0.0: Mounted board');
  await expect(popup.frameLocator('iframe').locator('#placement')).toContainText('mount: extension-view-');
  await popup.close();
  await expect(board(page)).toBeVisible();
});

test('extensions rich mount: placement and first mount are a browser iframe here, never the native webview command', async ({ page }) => {
  await setup(page, [trustedRich]); await grant(page, 'grant'); await openBoard(page);
  await expect(board(page)).toBeVisible();
  await expect(slot(page)).toHaveAttribute('data-rich-mount', 'browser-iframe');
  await expect(slot(page)).toHaveAttribute('data-mount-id', /^extension-panel-/);
  await expect(slot(page).locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(await page.frameLocator('.extension-rich-panel iframe').locator('iframe').getAttribute('sandbox')).toBe('allow-scripts');
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((call: any) => call.command));
  expect(calls.filter((command: string) => command.startsWith('extensions_rich_mount_'))).toEqual([]);
  // `placement: "window"` opens in the window first: the inspector keeps the host-rendered view and the button only.
  const windowFirst = structuredClone(rich); windowFirst.contributes.views[0].rich.placement = 'window';
  await page.evaluate(seed => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([seed])), { ...trustedRich, manifest: windowFirst });
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Open mounted board', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Open isolated extension window', exact: true })).toBeVisible();
  await expect(slot(page)).toHaveCount(0);
});

test('extensions rich mount: revoke, disable and safe mode destroy the frame and restore the built-in view', async ({ page }) => {
  await setup(page, [trustedRich]); await grant(page, 'grant'); await runningTask(page); await openBoard(page);
  await expect(board(page)).toBeVisible();
  await grant(page, 'revoke');
  await expect(slot(page).locator('iframe')).toHaveCount(0);
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'PermissionDenied');
  await grant(page, 'grant');
  await expect(board(page)).toBeVisible();
  await page.evaluate(async () => (window as any).__previewDisableExtension('sample.rich-mount'));
  await expect(page.locator('.extension-rich-panel iframe')).toHaveCount(0);
  await expect(page.locator('.extension-inspector-view')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Open mounted board', exact: true })).toHaveCount(0);
  await taskUntouched(page);
  await page.evaluate(seed => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([seed])), trustedRich);
  await page.goto('/?extensions-baseline&rich-mount&safe-mode');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open mounted board', exact: true })).toHaveCount(0);
  await expect(page.locator('.extension-rich-panel')).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
});

test('extensions rich mount: a throwing panel is shown failed with a reload control and the recorded task keeps running', async ({ page }) => {
  await setup(page, [trustedRich]); await grant(page, 'grant'); await runningTask(page); await openBoard(page);
  await expect(board(page)).toBeVisible();
  await page.frameLocator('.extension-rich-panel iframe').frameLocator('iframe').locator('#throw').click();
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'error');
  await expect(slot(page).locator('iframe')).toHaveCount(0);
  await expect(slot(page)).toContainText('The extension panel failed and was closed');
  await taskUntouched(page);
  await slot(page).getByRole('button', { name: 'Reload panel', exact: true }).click();
  await expect(board(page)).toHaveText('sample.rich-mount 1.0.0: Mounted board');
});

test('extensions rich mount: a looping panel is closed by the host watchdog and the recorded task keeps running', async ({ page, browserName }) => {
  // A browser iframe shares the host page's process unless the engine isolates sandboxed frames (Chromium does).
  // WebKit has no out-of-process frames, so this containment is proven there by the installed native webview
  // (a separate webview process and the native title watchdog in runtime_rich_mount.rs), not by this preview spec.
  test.skip(browserName !== 'chromium', 'browser iframe loop containment needs out-of-process sandboxed frames');
  await setup(page, [trustedRich]); await grant(page, 'grant'); await runningTask(page); await openBoard(page);
  await expect(board(page)).toBeVisible();
  await page.frameLocator('.extension-rich-panel iframe').frameLocator('iframe').locator('#loop').click({ timeout: 3000, noWaitAfter: true }).catch(() => {});
  await expect(slot(page)).toHaveAttribute('data-rich-state', 'unresponsive', { timeout: 20_000 });
  await expect(slot(page).locator('iframe')).toHaveCount(0);
  await expect(slot(page).getByRole('button', { name: 'Reload panel', exact: true })).toBeVisible();
  await taskUntouched(page);
});
