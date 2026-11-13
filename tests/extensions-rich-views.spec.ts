import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/rich-view/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page, characterize = true, installed = true) {
  await page.addInitScript(({ manifest, installed }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(installed ? [{ manifest, enabled: true, icons: {} }] : []));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
  }, { manifest, installed });
  await page.goto(`/?extensions-baseline&rich-view${characterize ? '&rich-view-characterization' : ''}`);
  await expect(page.locator('#prompt')).toBeEnabled();
}
async function open(page: Page, keyboard = false) {
  await page.getByRole('button', { name: 'Open isolated report', exact: true }).click();
  const popupPromise = page.waitForEvent('popup');
  const trigger = page.getByRole('button', { name: 'Open isolated extension window', exact: true });
  if (keyboard) { await trigger.focus(); await trigger.press('Enter'); } else await trigger.click();
  const popup = await popupPromise;
  await expect(popup.getByRole('status')).toHaveText('Isolated extension view');
  return popup;
}

test('extensions rich views: installed local assets receive only presentation DTO/theme in an explicit window', async ({ page }) => {
  await setup(page, true, false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.rich-view', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.locator('#terminal-toggle').click();
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  await page.locator('#prompt').fill('Preserve this running task'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('#prompt').fill('Preserved window draft');
  const popup = await open(page, true);
  const frame = popup.frameLocator('iframe');
  await expect(frame.locator('#report')).toHaveText('sample.rich-view 1.0.0: Isolated report');
  await expect(frame.locator('#theme')).toContainText('window: extension-view-');
  expect(await popup.evaluate(() => opener === null)).toBe(true);
  await popup.close();
  await expect(page.locator('#prompt')).toHaveValue('Preserved window draft');
  await expect(page.getByRole('button', { name: 'Open isolated report', exact: true })).toBeVisible();
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.filter((call: any) => ['close_terminal', 'stop_session', 'stop_task', 'cancel_task', 'delete_session'].includes(call.command))).toEqual([]);
  expect(calls.filter((call: any) => call.command === 'start_terminal')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'send_message')).toHaveLength(1);
});

test('extensions rich views: opaque frame rejects DOM/IPC/top navigation/eval and remote script/image/fetch attacks', async ({ page, context }) => {
  // Route-abort is a final safety net. Record requests separately: CSP must prevent reaching it.
  const network: string[] = [];
  await context.route('https://extension-invalid.example/**', route => { network.push(route.request().url()); return route.abort(); });
  await setup(page); const popup = await open(page); const frame = popup.frameLocator('iframe');
  await frame.locator('#probe').click();
  await expect(frame.locator('#attacks')).toHaveText(JSON.stringify({ parentDom: false, rawIpc: false, topNavigation: false, eval: false, network: false }));
  await expect.poll(() => frame.locator('img').count()).toBe(1);
  expect(network).toEqual([]);
  await expect(popup.locator('iframe')).toHaveAttribute('sandbox', 'allow-scripts');
  expect(popup.url()).not.toContain('extension-escaped');
  await popup.close();
});

test('extensions rich views: sibling-source and stale initialization cannot retarget an initialized view; disable closes only owned UI', async ({ page }) => {
  await setup(page); const first = await open(page); const second = await open(page);
  const before = await second.frameLocator('iframe').locator('#report').textContent();
  await second.evaluate(() => {
    const frame = document.querySelector('iframe')!;
    const session = JSON.parse(frame.srcdoc.match(/id="panda-view-session">([^<]+)/)![1]);
    const fake = { schemaVersion: 1, session, kind: 'init', sequence: 1, dto: { schemaVersion: 1, owner: 'sample.rich-view', version: '1.0.0', viewId: 'sample.rich-view/report', windowId: 'forged', title: 'FORGED', text: 'forged' }, theme: { schemaVersion: 1, colorScheme: 'dark' } };
    // Parent-to-shell is not the isolated frame source. A duplicate parent init is stale.
    dispatchEvent(new MessageEvent('message', { data: { schemaVersion: 1, session, kind: 'ready', sequence: 1 }, source: window, origin: 'null' }));
    document.querySelector('iframe')!.contentWindow!.postMessage(fake, '*');
  });
  await expect(second.frameLocator('iframe').locator('#report')).toHaveText(before!);
  await first.close(); expect(second.isClosed()).toBe(false);
  await page.evaluate(async () => (window as any).__previewDisableExtension('sample.rich-view'));
  await expect.poll(() => second.isClosed()).toBe(true);
  await expect(page.locator('#prompt')).toBeEnabled();
});

test('extensions rich views: unqualified targets expose a usable host fallback and never create a window', async ({ page }) => {
  await setup(page, false); let popups = 0; page.on('popup', () => popups++);
  await page.getByRole('button', { name: 'Open isolated report', exact: true }).click();
  await page.getByRole('button', { name: 'Open isolated extension window', exact: true }).click();
  await expect(page.locator('.extension-inspector-view [role="status"]')).toContainText('Rich HTML views are disabled');
  await expect(page.locator('.extension-inspector-view')).toContainText('host-rendered fallback');
  expect(popups).toBe(0); await expect(page.locator('#prompt')).toBeEnabled();
});

test('extensions rich views: zero extensions and safe mode never create rich presentation', async ({ page }) => {
  await setup(page, true, false);
  await expect(page.getByRole('button', { name: 'Open isolated report', exact: true })).toHaveCount(0);
  await expect(page.locator('iframe')).toHaveCount(0);
  await page.evaluate(manifest => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])), manifest);
  await page.goto('/?extensions-baseline&rich-view&rich-view-characterization&safe-mode');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.getByRole('button', { name: 'Open isolated report', exact: true })).toHaveCount(0);
});

test('extensions rich views: owning host teardown closes presentation without an orphan popup', async ({ page }) => {
  await setup(page); const popup = await open(page);
  const closed = popup.waitForEvent('close');
  await page.reload(); await closed;
  await expect(page.locator('#prompt')).toBeEnabled();
});
