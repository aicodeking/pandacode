import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/settings-laboratory/extension.json', import.meta.url), 'utf8'));
const other = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const status = (page: Page) => page.locator('[data-extension-contribution="sample.settings-laboratory/status"]');
async function open(page: Page, seed = false, ready = true) {
  await page.addInitScript(({ seed, manifest, other }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (seed && localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, other].map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { seed, manifest, other });
  await page.goto('/?settings-laboratory'); await expect(page.locator('#prompt')).toBeEnabled();
  if (seed && ready) await expect(status(page)).toBeVisible();
}
async function settings(page: Page) { await page.getByRole('button', { name: 'Settings', exact: true }).click(); await expect(page.getByRole('heading', { name: 'Settings', exact: true })).toBeVisible(); }
async function back(page: Page) { await page.getByRole('button', { name: 'Back to the workspace' }).click(); }
async function palette(page: Page, query: string) {
  const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.keyboard.press(`${mod}+k`); await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill(query);
}
async function invokePalette(page: Page, query: string) { await palette(page, query); await page.locator('#command-results button').first().click(); }

test.describe.serial('extensions settings actions installed lifecycle', () => {
  let page: Page;
  test.beforeAll(async ({ browser, baseURL }) => { page = await browser.newPage({ baseURL, viewport: { width: 1440, height: 940 } }); });
  test.afterAll(async () => { await page?.context().close(); });
  test('extensions settings actions: real UI install adds namespaced page/status, not core preferences', async () => {
    await open(page); await page.locator('#prompt').fill('Keep this draft');
    await settings(page); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
    await page.getByRole('button', { name: 'Install local package' }).click();
    await expect(page.getByRole('tab', { name: 'Laboratory preferences', exact: true })).toHaveCount(0);
    await page.getByRole('button', { name: `Enable ${manifest.id}`, exact: true }).click();
    await page.getByRole('tab', { name: 'Laboratory preferences', exact: true }).click();
    await expect(page.getByLabel('Report label', { exact: true })).toHaveValue('Local report');
    await page.getByLabel('Report label', { exact: true }).fill('My persistent label');
    await page.getByLabel('Include summary', { exact: true }).uncheck();
    await page.getByLabel('Report format', { exact: true }).selectOption('long');
    await page.getByRole('button', { name: 'Save extension settings', exact: true }).click();
    await expect(page.getByText('Extension settings saved.', { exact: true })).toBeVisible();
    await back(page); await expect(status(page)).toBeVisible(); await expect(status(page).locator('svg')).toHaveCount(1);
    await status(page).click(); await page.getByRole('menuitem', { name: 'Show laboratory note', exact: true }).click();
    await expect(page.locator('#toast')).toHaveText('Settings laboratory command invoked');
    await expect(page.locator('#prompt')).toHaveValue('Keep this draft');
  });
  test('extensions settings actions: reload/deep-link restores values and palette invokes hidden allowed commands only', async () => {
    await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
    await invokePalette(page, 'Settings Laboratory preferences');
    await expect(page.getByLabel('Report label', { exact: true })).toHaveValue('My persistent label');
    await expect(page.getByLabel('Include summary', { exact: true })).not.toBeChecked();
    await expect(page.getByLabel('Report format', { exact: true })).toHaveValue('long');
    await back(page);
    await expect(page.locator('[data-extension-contribution="sample.settings-laboratory/hidden"]')).toBeHidden();
    await invokePalette(page, 'Laboratory status'); await expect(page.locator('#toast')).toHaveText('Settings laboratory command invoked');
    await invokePalette(page, 'Laboratory unavailable'); await expect(page.locator('#toast')).toHaveText('Extension command is unavailable in this context.');
  });
  test('extensions settings actions: disable removes only contributions; re-enable restores dormant settings', async () => {
    await settings(page); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
    await page.getByRole('button', { name: `Disable ${manifest.id}`, exact: true }).click();
    await expect(page.getByRole('tab', { name: 'Laboratory preferences', exact: true })).toHaveCount(0);
    await expect(status(page)).toHaveCount(0);
    await back(page); await palette(page, 'Laboratory status');
    await expect(page.locator('#command-results [data-action="extension-command"]')).toHaveCount(0); await page.keyboard.press('Escape');
    await settings(page); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
    await page.getByRole('button', { name: `Enable ${manifest.id}`, exact: true }).click();
    await page.getByRole('tab', { name: 'Laboratory preferences', exact: true }).click();
    await expect(page.getByLabel('Report label', { exact: true })).toHaveValue('My persistent label');
  });
});

test('extensions settings actions: conflicts are explicit, saved and core shortcut remains reachable', async ({ page }) => {
  await open(page, true); await settings(page); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByText('Conflict: reserved core shortcut; use the command palette instead.', { exact: true })).toBeVisible();
  await page.getByLabel('Resolve Mod+Shift+KeyU', { exact: true }).selectOption('sample.settings-laboratory/conflict');
  await expect(page.getByText('Shortcut choice saved.', { exact: true })).toBeVisible(); await back(page);
  const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.locator('#sidebar-toggle').focus(); await page.keyboard.press(`${mod}+Shift+u`);
  await expect(page.locator('#toast')).toHaveText('Alternative laboratory command invoked');
  await palette(page, 'Laboratory status'); await expect(page.locator('#command-results')).toContainText('Laboratory status');
  await page.keyboard.press('Escape'); await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await settings(page); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await expect(page.getByLabel('Resolve Mod+Shift+KeyU', { exact: true })).toHaveValue('sample.settings-laboratory/conflict');
});

test('extensions settings actions: input/contenteditable/IME/229 and open dialogs never intercept extension shortcuts', async ({ page }) => {
  await open(page, true);
  await page.evaluate(() => localStorage.setItem('pandacode.extensions.keybindings.v1', JSON.stringify({ 'Mod+Shift+KeyU': 'sample.settings-laboratory/shortcut' })));
  const intercepted = await page.evaluate(() => {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt')!, trigger = document.querySelector<HTMLButtonElement>('#sidebar-toggle')!;
    const input = (target: HTMLElement, extra = {}) => { const event = new KeyboardEvent('keydown', { bubbles: true, cancelable: true, code: 'KeyU', key: 'U', ctrlKey: true, shiftKey: true, ...extra }); target.dispatchEvent(event); return event.defaultPrevented; };
    const editable = document.createElement('div'); editable.contentEditable = 'true'; document.body.append(editable);
    const results = [input(prompt), input(editable), input(trigger, { isComposing: true }), input(trigger, { keyCode: 229 }), input(trigger, { repeat: true })]; editable.remove(); return results;
  });
  expect(intercepted).toEqual([false, false, false, false, false]);
  await palette(page, 'Laboratory status');
  const mod = await page.evaluate(() => /Mac/.test(navigator.platform) ? 'Meta' : 'Control');
  await page.getByRole('textbox', { name: 'Search tasks and commands' }).press(`${mod}+Shift+u`);
  await expect(page.getByRole('dialog', { name: 'Go to anything', exact: true })).toBeVisible();
  await expect(page.locator('#toast')).not.toHaveText('Settings laboratory command invoked');
});

test('extensions settings actions: palette dialog keeps host focus/cancel and settings navigation stays keyboard accessible', async ({ page }) => {
  await open(page, true); await invokePalette(page, 'Laboratory form');
  const dialog = page.getByRole('dialog', { name: 'Laboratory form — sample.settings-laboratory', exact: true });
  await expect(dialog).toBeVisible(); await page.getByLabel('Local note', { exact: true }).fill('Transient only');
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.locator('#prompt')).toBeFocused();
  await settings(page); const tab = page.getByRole('tab', { name: 'Laboratory preferences', exact: true });
  await tab.focus(); await page.keyboard.press('Home'); await expect(page.getByRole('tab', { name: 'Recommended', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(tab).toBeFocused(); await expect(page.getByLabel('Report label', { exact: true })).toBeVisible();
});

test('extensions settings actions: startup refresh adds commands to an already open palette after delayed package loading', async ({ page }) => {
  let release!: () => void, requested = false;
  const gate = new Promise<void>(done => { release = done; });
  await page.route('**/*preview*', async route => {
    const url = route.request().url();
    if (!/\/src\/extensions\/preview\.ts(?:\?|$)|\/assets\/preview-[^/]+\.js(?:\?|$)/.test(url)) { await route.continue(); return; }
    const response = await route.fetch();
    if ((await response.text()).includes('Corrupt preview extension record')) { requested = true; await gate; }
    await route.fulfill({ response });
  });
  try {
    await open(page, true, false); await expect.poll(() => requested).toBe(true);
    await palette(page, 'Laboratory form');
    await expect(page.locator('#command-results [data-action="extension-command"]')).toHaveCount(0);
    release();
    await expect(page.locator('#command-results [data-action="extension-command"]')).toHaveCount(1);
    await page.locator('#command-results [data-action="extension-command"]').click();
    await expect(page.getByLabel('Local note', { exact: true })).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('#prompt')).toBeFocused();
  } finally { release(); }
});

test('extensions settings actions: disabling one owner preserves another owner unsaved fields and focused node', async ({ page }) => {
  const companion = structuredClone(other);
  companion.contributes.settings = [{ id: 'sample.project-helper/preferences', title: 'Companion preferences', fields: [{ id: 'note', kind: 'text', label: 'Companion note' }] }];
  await page.addInitScript(({ manifest, companion }) => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, companion].map(manifest => ({ manifest, enabled: true, icons: {} })))); }, { manifest, companion });
  await open(page, true); await settings(page); await page.getByRole('tab', { name: 'Companion preferences', exact: true }).click();
  const input = page.getByLabel('Companion note', { exact: true }); await input.fill('Unsaved companion draft'); await input.focus();
  const node = await input.elementHandle();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.settings-laboratory'); });
  await expect(input).toHaveValue('Unsaved companion draft'); await expect(input).toBeFocused();
  expect(await node!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.getByRole('tab', { name: 'Companion preferences', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.getByRole('tab', { name: 'Laboratory preferences', exact: true })).toHaveCount(0);
});

for (const name of ['colors', 'wallpapers']) test(`extensions settings actions: named ${name} body/actions preserve host Done, Escape and disable cleanup`, async ({ page }) => {
  await open(page, true); await invokePalette(page, `${name === 'colors' ? 'Colors' : 'Wallpapers'} dialog`);
  const dialog = page.getByRole('dialog', { name: name === 'colors' ? 'Colors' : 'Wallpapers', exact: true });
  await expect(dialog.locator(`[data-extension-location="panda.dialog.${name}.bodyExtras"]`)).toContainText('Additional');
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Laboratory status', exact: true }).click(); await expect(page.locator('#toast')).toHaveText('Settings laboratory command invoked');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.settings-laboratory'); });
  await expect(dialog).toBeVisible(); await expect(dialog.locator('[data-extension-contribution]')).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  expect(await dialog.evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape'); await expect(dialog).not.toBeVisible();
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
  await invokePalette(page, `${name === 'colors' ? 'Colors' : 'Wallpapers'} dialog`);
  await expect(dialog.locator('[data-extension-contribution]')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Done', exact: true }).click(); await expect(dialog).not.toBeVisible();
});

test('extensions settings actions: protected privacy and recovery remain host-only and reachable', async ({ page }) => {
  await open(page, true); await settings(page); await page.getByRole('tab', { name: 'Agents', exact: true }).click();
  await page.locator('#settings-panel-agents details').getByText('Advanced', { exact: true }).click();
  await expect(page.getByText('Privacy', { exact: true })).toBeVisible();
  await expect(page.locator('#settings-panel-agents [data-extension-contribution]')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(page.getByText(/Safe mode: packages are not loaded/)).toBeVisible();
  await expect(page.getByRole('tab', { name: 'Laboratory preferences', exact: true })).toHaveCount(0);
  await expect(page.locator('[data-extension-contribution]')).toHaveCount(0);
  await back(page); await invokePalette(page, 'Colors dialog');
  await expect(page.getByRole('dialog', { name: 'Colors', exact: true }).getByRole('button', { name: 'Done', exact: true })).toBeVisible();
  await expect(page.locator('#dialog [data-extension-contribution]')).toHaveCount(0);
});
