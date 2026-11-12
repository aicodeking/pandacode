import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const laboratory = JSON.parse(readFileSync(new URL('./fixtures/extensions/menu-laboratory/extension.json', import.meta.url), 'utf8'));
const trigger = (page: Page) => page.locator('[data-extension-contribution="sample.menu-laboratory/header"]');
const modal = (page: Page) => page.locator('#dialog');
async function setup(page: Page, location = 'panda.workspace.header.actions', direct = false) {
  const manifest = structuredClone(laboratory);
  manifest.contributes.menus[0].location = location;
  if (direct) delete manifest.contributes.menus[0].items;
  await page.addInitScript(manifest => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
  }, manifest);
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(trigger(page)).toBeAttached();
  if (location === 'panda.inspector.actions') {
    const toggle = page.locator('#inspector-toggle');
    await expect(toggle).toHaveAttribute('aria-pressed', /true|false/);
    if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  }
  await expect(trigger(page)).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function open(page: Page, direct = false) {
  await trigger(page).click();
  if (!direct) {
    await page.getByRole('menuitem', { name: 'Reports', exact: true }).press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Configure report', exact: true }).press('Enter');
  }
  await expect(modal(page)).toBeVisible();
  await expect(modal(page)).toHaveAccessibleName('Report options — sample.menu-laboratory');
}
async function fillRequired(page: Page) {
  await page.getByRole('textbox', { name: 'Report name', exact: true }).fill('Quarterly report');
  await page.getByRole('button', { name: 'Report format', exact: true }).click();
  await page.getByRole('menuitemradio', { name: 'Full report', exact: true }).click();
}
async function calls(page: Page) { return page.evaluate(() => (window as any).__extensionDialogTransport.calls); }

for (const location of ['panda.workspace.header.actions', 'panda.sidebar.footer', 'panda.inspector.actions']) {
  test(`extensions dialogs: ${location} owns a modal and viewport-positioned select, Escape restores the trigger`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await setup(page, location); await open(page);
    await expect(page.getByRole('textbox', { name: 'Report name', exact: true })).toBeFocused();
    await expect(page.getByRole('switch', { name: 'Include details', exact: true })).toBeChecked();
    await page.getByRole('button', { name: 'Report format', exact: true }).click();
    await expect(page.getByRole('menuitemradio', { name: 'Unavailable', exact: true })).toBeDisabled();
    expect(await page.locator('.choice-menu').evaluate(node => node.closest('dialog')?.id)).toBe('dialog');
    const bounds = await page.locator('.choice-menu').boundingBox(); const viewport = page.viewportSize()!;
    expect(bounds!.x).toBeGreaterThanOrEqual(11); expect(bounds!.y).toBeGreaterThanOrEqual(11);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(viewport.width - 11); expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(viewport.height - 11);
    await page.keyboard.press('Escape'); await expect(modal(page)).toBeVisible();
    await expect(page.getByRole('button', { name: 'Report format', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(modal(page)).not.toBeVisible();
    await expect(trigger(page)).toBeFocused(); await expect(page.locator('#toast')).toHaveText('Report cancelled');
    expect(await calls(page)).toEqual([]);
  });
}

test('extensions dialogs: validation retains inputs; text/switch/multi-select values confirm exactly once', async ({ page }) => {
  await setup(page); await open(page);
  await page.getByRole('textbox', { name: 'Report name', exact: true }).fill('Hi');
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect(page.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue('Hi');
  await expect(page.getByRole('textbox', { name: 'Report name', exact: true })).toHaveAttribute('aria-invalid', 'true');
  await expect(modal(page).getByRole('alert')).toHaveText('Check the highlighted fields.');
  await fillRequired(page); await page.getByRole('switch', { name: 'Include details' }).uncheck();
  await page.getByRole('button', { name: 'Report tags', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true })).toHaveAttribute('aria-checked', 'true');
  await page.getByRole('menuitemcheckbox', { name: 'Beta', exact: true }).click();
  await page.getByRole('button', { name: 'Done', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Report tags', exact: true })).toHaveText('Alpha, Beta');
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect(modal(page)).toContainText('Create this report?');
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
  await expect(page.locator('#toast')).toHaveText('Report confirmed');
  const validation = (await calls(page)).filter((call: any) => call.kind === 'validate');
  expect(validation).toHaveLength(1);
  expect(validation[0].values).toEqual({ name: 'Quarterly report', details: false, format: 'full', tags: ['alpha', 'beta'] });
});

test('extensions dialogs: async loading, stale replies, empty results, errors/retry and multi-select search', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true); await open(page, true);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await page.getByRole('button', { name: 'Report tags', exact: true }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Loading options…' })).toBeVisible();
  const search = page.getByRole('searchbox', { name: 'Search Report tags', exact: true });
  await search.fill('a'); await search.fill('b');
  await expect.poll(async () => (await calls(page)).length).toBe(3);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.release(2); });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Beta', exact: true })).toBeVisible();
  await page.evaluate(() => { const t = (window as any).__extensionDialogTransport; t.release(0); t.release(1); t.holdOptions = false; });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true })).toHaveCount(0);
  expect((await calls(page)).slice(0, 2).map((call: any) => call.aborted)).toEqual([true, true]);
  await search.fill('none'); await expect(page.getByRole('status').filter({ hasText: 'No matching options.' })).toBeVisible();
  await page.evaluate(() => { (window as any).__extensionDialogTransport.failOptions = true; });
  await search.fill('a'); await expect(page.getByRole('alert').filter({ hasText: 'Options could not be loaded.' })).toBeVisible();
  await page.evaluate(() => { (window as any).__extensionDialogTransport.failOptions = false; });
  await page.getByRole('button', { name: 'Retry options', exact: true }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
  await page.keyboard.press('Escape'); await expect(modal(page)).toBeVisible();
  await expect(page.getByRole('button', { name: 'Report tags', exact: true })).toHaveText('Alpha');
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(trigger(page)).toBeFocused();
});

test('extensions dialogs: IME Enter and 229 cannot submit; ordinary Enter validates and Escape aborts pending validation', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true); await open(page, true); await fillRequired(page);
  await page.getByRole('textbox', { name: 'Report name', exact: true }).focus();
  const prevented = await page.getByRole('textbox', { name: 'Report name', exact: true }).evaluate(node => [
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', isComposing: true, bubbles: true, cancelable: true })),
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true, cancelable: true })),
    !node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', keyCode: 229, bubbles: true, cancelable: true })),
  ]);
  expect(prevented).toEqual([true, true, true]); expect(await calls(page)).toEqual([]);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.keyboard.press('Enter'); await expect(modal(page).getByRole('status')).toHaveText('Validating…');
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await page.keyboard.press('Escape'); await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toBeFocused();
  expect((await calls(page))[0].aborted).toBe(true);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.locator('#toast')).toHaveText('Report cancelled');
  await expect(modal(page)).not.toBeVisible(); await expect(page.locator('#prompt')).toBeEnabled();
});

test('extensions dialogs: unloading cancels pending callbacks and detached controls have no side effect', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true); await open(page, true); await fillRequired(page);
  await page.evaluate(() => { (window as any).__staleExtensionForm = document.querySelector('#dialog form'); (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  // Reentrant host dispatch cannot steal the existing owner's disposal handle.
  await trigger(page).evaluate((node: HTMLElement) => node.click());
  await expect(modal(page)).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.menu-laboratory'); });
  await expect(modal(page)).not.toBeVisible(); await expect(trigger(page)).toHaveCount(0);
  expect((await calls(page))[0].aborted).toBe(true);
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.isConnected)).toBe(true);
  await page.evaluate(() => { (window as any).__staleExtensionForm.requestSubmit(); (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.locator('#toast')).not.toHaveText('Report confirmed');
  await page.keyboard.press('ControlOrMeta+k'); await expect(modal(page)).toBeVisible();
  await expect(modal(page)).not.toHaveClass(/extension-dialog/);
});

test('extensions dialogs: unloading an open async picker aborts its request and cannot mount late options', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true); await open(page, true);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await page.getByRole('button', { name: 'Report tags', exact: true }).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.menu-laboratory'); });
  await expect(page.locator('.choice-menu')).toHaveCount(0); await expect(modal(page)).not.toBeVisible();
  expect((await calls(page))[0].aborted).toBe(true);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true })).toHaveCount(0);
  await expect(page.locator('#toast')).not.toHaveText('Report cancelled');
  await expect(page.locator('#prompt')).toBeEnabled();
});

test('extensions dialogs: asynchronous validation errors retry without clearing fields or retargeting after host navigation', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true);
  const original = await page.locator('.task-item.selected').getAttribute('data-id');
  expect(original).toBeTruthy();
  await open(page, true); await fillRequired(page);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.failValidation = true; });
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect(modal(page).getByRole('alert')).toHaveText('Validation failed. Try again.');
  await expect(page.getByRole('textbox', { name: 'Report name', exact: true })).toHaveValue('Quarterly report');
  // A host-initiated navigation can occur while modal background controls are inert.
  await page.locator('.task-item:not(.selected)').first().evaluate((node: HTMLElement) => node.click());
  await expect(page.locator('.task-item.selected')).not.toHaveAttribute('data-id', original!);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.failValidation = false; });
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect(modal(page)).toContainText('Create this report?');
  const validation = (await calls(page)).filter((call: any) => call.kind === 'validate');
  expect(validation).toHaveLength(2);
  expect(validation.map((call: any) => call.context.sessionId)).toEqual([original, original]);
  await page.getByRole('button', { name: 'Cancel', exact: true }).click(); await expect(trigger(page)).toBeFocused();
});

test('extensions dialogs: existing host modal cannot be stolen; host replacement aborts the old owner without closing the new one', async ({ page }) => {
  await setup(page, 'panda.workspace.header.actions', true);
  await page.keyboard.press('ControlOrMeta+k'); await expect(modal(page)).toBeVisible();
  const hostClass = await modal(page).getAttribute('class');
  await trigger(page).evaluate((node: HTMLElement) => node.click());
  await expect(modal(page)).toHaveAttribute('class', hostClass!);
  await page.keyboard.press('Escape'); await open(page, true); await fillRequired(page);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.getByRole('button', { name: 'Create report', exact: true }).click();
  await expect.poll(async () => (await calls(page)).length).toBe(1);
  await page.keyboard.press('ControlOrMeta+k');
  await expect(modal(page)).not.toHaveClass(/extension-dialog/); await expect(modal(page)).toBeVisible();
  await page.evaluate(() => { (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(modal(page)).toBeVisible(); await expect(page.locator('#toast')).not.toHaveText('Report confirmed');
  expect((await calls(page))[0].aborted).toBe(true);
});
