import { test, expect, type Page, type ElementHandle } from '@playwright/test';
import layoutA from './fixtures/extensions/layout-a/extension.json' with { type: 'json' };
import layoutB from './fixtures/extensions/layout-b/extension.json' with { type: 'json' };
const key = 'pandacode.extensions.layout.v1';
async function open(page: Page) {
  await page.goto('/?extensions-baseline'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
test('extensions layout: hide, public command, reload, keyboard recovery and restore', async ({ page }) => {
  await open(page);
  const region = await explorer(page);
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const before = await page.locator('#theme-toggle').getAttribute('aria-pressed');
  await region.getByRole('button', { name: 'Run Toggle theme', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toHaveAttribute('aria-pressed', before === 'true' ? 'false' : 'true');
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const recovered = await explorer(page);
  await recovered.getByRole('button', { name: 'Hide Settings', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('.sidebar-bottom [data-action="settings"]')).toBeHidden();
  const external = await explorer(page);
  await external.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Settings', exact: true })).toBeVisible();
});
test('extensions layout: focused control transfers focus and hidden controls cannot regain it', async ({ page }) => {
  await open(page);
  // Another window's preference change uses the normal browser storage notification.
  await page.locator('#theme-toggle').focus();
  const other = await page.context().newPage();
  await other.goto('/');
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar.footer/theme': false }, extensionLayoutsEnabled: true })), key);
  await other.close();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  expect(await page.evaluate(() => document.activeElement !== document.body && document.activeElement?.checkVisibility())).toBe(true);
  await page.locator('#theme-toggle').evaluate((element: HTMLElement) => element.focus());
  await expect(page.locator('#theme-toggle')).not.toBeFocused();
  await page.keyboard.press('Tab'); await expect(page.locator('#theme-toggle')).not.toBeFocused();
});
test('extensions layout: actual project choices override global choices after reload, project reset reveals global', async ({ page }) => {
  await open(page); let region = await explorer(page);
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  await region.getByLabel('Layout scope', { exact: true }).selectOption('project');
  await region.getByRole('button', { name: 'Show Toggle theme', exact: true }).click();
  const saved = await page.evaluate(key => ({ global: JSON.parse(localStorage.getItem(key)!), project: JSON.parse(localStorage.getItem(`${key}.project.project-1`)!) }), key);
  expect(saved.global.visibility['panda.sidebar.footer/theme']).toBe(false);
  expect(saved.project.visibility['panda.sidebar.footer/theme']).toBe(true);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  region = await explorer(page);
  await region.getByRole('button', { name: 'Reset project layout', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
});
test('extensions layout: hiding an anchored menu closes it and sidebar focus moves to surviving workspace', async ({ page }) => {
  await open(page);
  await page.locator('#sidebar-toggle').click();
  await page.locator('#view-menu').click();
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toBeVisible();
  const other = await page.context().newPage(); await other.goto('/');
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.workspace.header.actions/view-menu': false }, extensionLayoutsEnabled: true })), key);
  await expect(page.locator('#view-menu')).toBeHidden();
  await expect(page.getByRole('menuitemradio', { name: 'Conversation', exact: true })).toHaveCount(0);
  await expect(page.locator('#view-divider')).toBeHidden();
  await page.locator('#sidebar-toggle').click();
  await page.locator('.task-item.selected').focus();
  await other.evaluate(key => localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar': false }, extensionLayoutsEnabled: true })), key);
  await expect(page.locator('.sidebar')).toBeHidden(); await expect(page.locator('#prompt')).toBeFocused();
  await other.close();
});
test('extensions layout: sidebar overlay preserves live task, draft and terminal identity', async ({ page }) => {
  await page.addInitScript(() => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; });
  await open(page); await page.locator('#prompt').fill('sidebar continuity draft');
  await page.locator('#terminal-toggle').click();
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  const terminal = await page.locator('#terminal-host .xterm-screen').elementHandle();
  const prompt = await page.locator('#prompt').elementHandle();
  const selected = await page.locator('.task-item.selected').getAttribute('data-id');
  const region = await explorer(page);
  await region.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('.sidebar')).toBeHidden();
  await expect(page.locator('#prompt')).toHaveValue('sidebar continuity draft');
  expect(await prompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await terminal!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  expect(await page.locator('.task-item.selected').getAttribute('data-id')).toBe(selected);
  const restored = await explorer(page);
  await restored.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await restored.getByRole('button', { name: 'Disable extension layouts', exact: true }).click();
  await expect(restored.getByText('Extension layout proposals are disabled.', { exact: false })).toBeVisible();
  const effects = await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((entry: any) => ['start_terminal', 'close_terminal', 'cancel_session', 'delete_session'].includes(entry.command)).map((entry: any) => entry.command));
  expect(effects).toEqual(['start_terminal']);
});
test('extensions layout: corrupt global overlay preserves project preferences and unrelated storage', async ({ page }) => {
  await page.addInitScript(key => {
    localStorage.setItem(key, '{broken');
    localStorage.setItem(`${key}.project.project-1`, JSON.stringify({ schemaVersion: 1, visibility: { 'panda.sidebar.footer/theme': false, 'missing.extension/action': false }, extensionLayoutsEnabled: true }));
    localStorage.setItem('layout-test-sentinel', 'drafts and projects untouched');
  }, key);
  await open(page);
  await expect(page.locator('#theme-toggle')).toBeHidden();
  const region = await explorer(page);
  await expect(region.getByText(/Invalid or unavailable layout preferences/)).toBeVisible();
  await region.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await expect(page.locator('#theme-toggle')).toBeHidden();
  await region.getByRole('button', { name: 'Reset project layout', exact: true }).click();
  expect(await page.evaluate(() => localStorage.getItem('layout-test-sentinel'))).toBe('drafts and projects untouched');
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
});
test('extensions layout: contributed choices stay dormant through disable and safe-mode rollback preserves overlays', async ({ page }) => {
  await open(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await region.getByLabel('Item owner', { exact: true }).selectOption('sample.project-helper');
  await region.locator('[data-layout-item="sample.project-helper/header"]').click();
  const contribution = page.locator('[data-extension-contribution="sample.project-helper/header"]');
  await expect(contribution).toBeHidden();
  await page.getByRole('button', { name: 'Disable sample.project-helper', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.project-helper', exact: true }).click();
  await expect(contribution).toBeHidden();
  await region.getByLabel('Item owner', { exact: true }).selectOption('panda.core');
  await region.getByRole('button', { name: 'Hide Toggle theme', exact: true }).click();
  const stored = await page.evaluate(key => localStorage.getItem(key), key);
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await expect(page.locator('#theme-toggle')).toBeVisible();
  expect(await page.evaluate(key => localStorage.getItem(key), key)).toBe(stored);
});

const footerOrder = (page: Page) => page.locator('.sidebar-bottom > button').evaluateAll(nodes => nodes.map(node => node.id || node.getAttribute('data-action') || node.className));
test('extensions layout: keyboard and pointer share persisted ordering with trusted native drag events discarded', async ({ page }) => {
  await page.addInitScript(() => {
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) window.addEventListener(type, event => { if (event.isTrusted) event.stopImmediatePropagation(); }, true);
  });
  await open(page); let region = await explorer(page);
  const usage = region.locator('[data-order-id="panda.sidebar.footer/usage"]');
  await usage.focus(); await page.keyboard.press('Alt+ArrowUp');
  const keyboard = await footerOrder(page);
  expect(keyboard.slice(0, 2)).toEqual(['agent-usage-button', 'support-button']);
  const saved = await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).orders, key);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  // The composer becomes usable before the asynchronous extension/safe-mode snapshot resolves.
  await expect.poll(() => footerOrder(page)).toEqual(keyboard);
  region = await explorer(page);
  await region.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await usage.scrollIntoViewIfNeeded();
  const source = (await usage.boundingBox())!;
  const target = (await region.locator('[data-order-id="panda.sidebar.footer/support"]').boundingBox())!;
  await page.mouse.move(source.x + 20, source.y + 10); await page.mouse.down();
  await page.mouse.move(source.x + 70, source.y + 12, { steps: 5 });
  await expect(page.locator('.drag-ghost')).toBeVisible();
  await page.mouse.move(target.x + 20, target.y + 3, { steps: 6 }); await page.mouse.up();
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  expect(await footerOrder(page)).toEqual(keyboard);
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).orders, key)).toEqual(saved);
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => footerOrder(page)).toEqual(keyboard);
});

for (const reversed of [false, true]) test.describe(`extensions layout: conflicting proposal activation order ${reversed}`, () => {
  test.describe.configure({ mode: 'serial' });
  let page: Page, baseline: string[], livePrompt: ElementHandle<HTMLElement | SVGElement> | null;
  test.beforeAll(async ({ browser }, info) => { page = await browser.newPage({ baseURL: info.project.use.baseURL, viewport: info.project.use.viewport }); });
  test.afterAll(async () => { await page.close(); });
  test('explicit selection wins; activation alone grants nothing', async () => {
  await page.addInitScript(packages => { if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, reversed ? [layoutB, layoutA] : [layoutA, layoutB]);
  await open(page); await page.locator('#prompt').fill('layout proposal continuity');
  const prompt = await page.locator('#prompt').elementHandle();
  baseline = await footerOrder(page); const region = await explorer(page);
  await expect(region.getByRole('list', { name: 'Layout proposals' })).toContainText('Conflict: sample.layout-b');
  await expect(region.getByRole('list', { name: 'Layout proposals' })).toContainText('Owner: sample.layout-a @ 1.0.0');
  expect(await footerOrder(page)).toEqual(baseline, 'activation alone grants no customization');
  await region.getByRole('button', { name: 'Grant UI customization and select Theme first', exact: true }).click();
  expect(await prompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  const ordered = await footerOrder(page); expect(ordered.indexOf('theme-toggle')).toBeLessThan(ordered.indexOf('support-button'));
  });
  test('restart retains selection; disabling the winner never selects a competitor', async () => {
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  livePrompt = await page.locator('#prompt').elementHandle(); await page.locator('#prompt').fill('live recovery draft');
  await expect.poll(async () => { const ordered = await footerOrder(page); return ordered.indexOf('theme-toggle') < ordered.indexOf('support-button'); }).toBe(true);
  await explorer(page);
  await page.getByRole('button', { name: 'Disable sample.layout-a', exact: true }).click();
  expect(await footerOrder(page)).toEqual(baseline, 'another active proposal cannot take over');
  await page.getByRole('button', { name: 'Enable sample.layout-a', exact: true }).click();
  });
  test('user ordering overrides either proposal and survives disable without remounting', async () => {
  const restored = page.getByRole('region', { name: 'Surface explorer' });
  const support = restored.locator('[data-order-id="panda.sidebar.footer/support"]');
  await support.focus(); await page.keyboard.press('Alt+ArrowUp');
  const explicit = await footerOrder(page);
  await restored.getByRole('button', { name: 'Grant UI customization and select Support first', exact: true }).click();
  expect(await footerOrder(page)).toEqual(explicit);
  await page.getByRole('button', { name: 'Disable sample.layout-b', exact: true }).click();
  expect(await footerOrder(page)).toEqual(explicit);
  await restored.getByRole('button', { name: 'Disable extension layouts', exact: true }).click();
  expect(await footerOrder(page)).toEqual(explicit);
   await expect(restored.getByRole('button', { name: 'Move Composer to Inspector', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  expect(await livePrompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  await expect(page.locator('#prompt')).toHaveValue('live recovery draft');
  });
});
