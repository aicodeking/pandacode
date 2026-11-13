import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/browser/extension.json', import.meta.url), 'utf8'));
const address = (page: Page) => page.getByRole('textbox', { name: 'Browser URL', exact: true });
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&browser-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(address(page)).toBeEnabled();
}
const props = (page: Page) => page.evaluate(() => (window as any).__previewBrowser());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function navigate(page: Page) {
  await address(page).fill('localhost:3000'); await page.getByRole('button', { name: 'Open URL', exact: true }).click();
  await expect(page.getByText('Browser preview · sample page', { exact: true })).toBeVisible();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Browser presentation', { exact: true }).selectOption('sample.browser/controls'); await back(page); }
async function action(page: Page, controlId: string, value = '') {
  return page.evaluate(({ controlId, value }) => {
    const p = (window as any).__previewBrowser();
    const a = { contractVersion: 1, context: p.context, guest: p.guest, project: p.project, session: p.session, revision: p.revision, controlId, value, requestId: crypto.randomUUID() };
    (window as any).__capturedBrowser = a; return (window as any).__previewBrowserAction(a);
  }, { controlId, value });
}
test('browser: zero extensions preserve original navigation, controls and synthetic guest across hide/restore', async ({ page }) => {
  await setup(page); await navigate(page);
  const before = await props(page), opens = await calls(page, 'browser_open'), closes = await calls(page, 'browser_close');
  await expect(page.locator('[data-browser-provider]')).toHaveCount(0);
  await page.getByRole('button', { name: 'Close browser', exact: true }).click();
  await expect(address(page)).toBeHidden();
  await expect.poll(async () => (await calls(page, 'browser_bounds')).at(-1)?.args.visible).toBe(false);
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect(address(page)).toHaveValue('http://localhost:3000/');
  expect((await props(page)).guest).toBe(before.guest);
  expect(await calls(page, 'browser_open')).toEqual(opens); expect(await calls(page, 'browser_close')).toEqual(closes);
  await page.getByRole('button', { name: 'Reload page', exact: true }).focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await calls(page, 'browser_action')).at(-1)?.args.action).toBe('reload');
});
test('browser: local install/selection, action/context/control layout and move/disable/safe restore retain guest and nodes', async ({ page }) => {
  await setup(page); await navigate(page);
  const original = await address(page).elementHandle(), before = await props(page), opens = await calls(page, 'browser_open'), closes = await calls(page, 'browser_close');
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.browser', exact: true }).click();
  await region.getByLabel('Browser presentation', { exact: true }).selectOption('sample.browser/controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Reload before back', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.browser.controls');
  await region.getByRole('button', { name: 'Hide Go forward', exact: true }).click(); await back(page);
  await expect(page.locator('[data-browser-provider="sample.browser/controls"]')).toBeVisible();
  expect(await page.locator('.browser-toolbar').evaluate(node => getComputedStyle(node).order)).toBe('1');
  await expect(page.getByRole('button', { name: 'Go forward', exact: true })).toBeHidden();
  expect((await page.locator('.browser-toolbar > [data-browser-action]').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-browser-action')))).indexOf('reload')).toBeLessThan(2);
  await page.getByRole('button', { name: 'Browser tools', exact: true }).click(); await expect(page.locator('.browser-notice')).toContainText('host-owned');
  await page.locator('.browser-location').click({ button: 'right' }); await page.getByRole('menuitem', { name: 'Browser tools', exact: true }).click();
  await page.getByRole('group', { name: 'Browser page actions', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Browser tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(page.getByRole('group', { name: 'Browser page actions', exact: true })).toBeFocused();
  expect((await props(page)).guest).toBe(before.guest); expect(await original!.evaluate(node => node === document.querySelector('.browser-address input'))).toBe(true);
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.browser', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-browser-provider]')).toHaveCount(0); expect((await props(page)).guest).toBe(before.guest);
  expect(await calls(page, 'browser_open')).toEqual(opens); expect(await calls(page, 'browser_close')).toEqual(closes);
  expect(await page.locator('.browser-toolbar').evaluate(node => getComputedStyle(node).order)).toBe('0');
});
test('browser: captured actions use original handlers once and reject malformed, stale and switched identities', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await navigate(page);
  expect(await action(page, 'reload')).toEqual({ ok: true });
  expect((await calls(page, 'browser_action')).filter((call: any) => call.args.action === 'reload')).toHaveLength(1);
  expect(await page.evaluate(() => (window as any).__previewBrowserAction((window as any).__capturedBrowser))).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(() => { (window as any).__staleBrowser = (window as any).__capturedBrowser; });
  expect(await action(page, 'navigate', 'javascript:alert(1)')).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await action(page, 'execute')).toEqual({ ok: false, reason: 'InvalidArguments' });
  const p = await props(page);
  expect(await page.evaluate(p => (window as any).__previewBrowserAction({ contractVersion: 1, context: p.context, guest: 'forged', project: p.project, session: p.session, revision: p.revision, controlId: 'reload', value: '', requestId: 'forged' }), p)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.locator('.task-item[data-id="session-2"]').click();
  await page.getByRole('button', { name: 'Open browser', exact: true }).click();
  await expect.poll(async () => (await props(page))?.session).toBe('session-2');
  expect(await page.evaluate(() => (window as any).__previewBrowserAction((window as any).__staleBrowser))).toEqual({ ok: false, reason: 'StaleContext' });
});
test('browser: picked context is bounded plain text and screenshot/pick use original task handlers', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await navigate(page);
  expect(await action(page, 'pick')).toEqual({ ok: true });
  await expect(page.getByRole('button', { name: 'Attach an element', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await page.locator('.browser-sample-button').click();
  const picked = (await props(page)).picked;
  expect(picked).toEqual({ tag: 'button', text: 'Try the interaction' }); expect(JSON.stringify(picked)).not.toMatch(/selector|html|bounds/);
  await expect(page.locator('.browser-context-chip')).toHaveCount(1);
  expect(await action(page, 'capture')).toEqual({ ok: true });
  await expect(page.locator('.browser-context-chip')).toHaveCount(2); expect(await calls(page, 'browser_capture')).toHaveLength(1);
});
test('browser: conflict/future/fault recover original controls and revoke provider without guest restart', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.browser'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.browser/controls' }] };
  const future = structuredClone(other); future.id = 'future.browser'; future.contributes.components[0].id = 'future.browser/controls'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); await navigate(page);
  const region = await explorer(page); await expect(region.getByLabel('Browser presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.browser/controls"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Browser presentation', { exact: true }).selectOption('sample.browser/controls'); await back(page);
  const before = await props(page), opens = await calls(page, 'browser_open'); await address(page).focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyBrowserPresentation(document.querySelector('.browser-instance'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-browser-presentation-status]')).toContainText('Built-in browser remains active');
  await expect(address(page)).toBeFocused(); expect((await props(page)).guest).toBe(before.guest); expect(await calls(page, 'browser_open')).toEqual(opens);
  expect(await action(page, 'reload')).toEqual({ ok: false, reason: 'Revoked' });
});
