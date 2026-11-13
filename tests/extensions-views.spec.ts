import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/data-panel/extension.json', import.meta.url), 'utf8'));
const id = 'sample.data-panel/overview', notes = 'sample.data-panel/notes';
const tab = (page: Page, view = id) => page.locator(`.inspector-tab[data-view="${view}"] [role="tab"]`);
const panel = (page: Page) => page.getByRole('region', { name: 'Data panel — sample.data-panel', exact: true });
async function setup(page: Page, seed = true, selected = false) {
  await page.addInitScript(({ manifest, seed, selected }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(seed ? [{ manifest, enabled: true, icons: {} }] : []));
    if (selected && localStorage.getItem('pandacode.inspector.tabs') === null) localStorage.setItem('pandacode.inspector.tabs', JSON.stringify({ open: ['changes', 'sample.data-panel/overview'], selected: 'sample.data-panel/overview' }));
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
  }, { manifest, seed, selected });
  await page.goto('/?extensions-baseline&data-panel');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
}
async function add(page: Page, title: string) {
  await page.locator('[data-action="inspector-add-tab"]').click();
  await page.getByRole('menuitem', { name: title, exact: true }).click();
}
async function enable(page: Page, enabled: boolean) {
  // After reload a built-in fallback tab can be selected before the lazy preview bridge
  // finishes loading. Wait for the actual transport, not that intermediate DOM state.
  await expect.poll(() => page.evaluate(enabled => typeof (window as any)[enabled ? '__previewEnableExtension' : '__previewDisableExtension'], enabled)).toBe('function');
  await page.evaluate(async enabled => { await (window as any)[enabled ? '__previewEnableExtension' : '__previewDisableExtension']('sample.data-panel'); }, enabled);
}
async function overlay(page: Page, value: object) {
  await page.evaluate(value => {
    const key = 'pandacode.extensions.layout.v1';
    localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, extensionLayoutsEnabled: true, visibility: {}, orders: {}, ...value }));
    dispatchEvent(new StorageEvent('storage', { key }));
  }, value);
}

test('extensions views: install the data panel and render the full declared control family with keyboard navigation', async ({ page }) => {
  await setup(page, false);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.data-panel', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await page.getByRole('button', { name: 'Open data panel', exact: true }).click();
  await expect(tab(page)).toHaveAttribute('aria-selected', 'true');
  await expect(panel(page).getByRole('list', { name: 'Reports' })).toContainText('Build summary');
  await expect(panel(page).getByRole('table', { name: 'Results' })).toContainText('TypesPassed');
  await expect(panel(page).getByRole('progressbar', { name: 'Report completion' })).toHaveAttribute('value', '75');
  const folder = panel(page).getByRole('treeitem', { name: 'Reports folder', exact: true });
  await folder.focus(); await folder.press('ArrowRight'); await expect(folder).toHaveAttribute('aria-expanded', 'true');
  await folder.press('ArrowDown'); await expect(panel(page).getByRole('treeitem', { name: 'summary.json' })).toBeFocused();
  await page.keyboard.press('ArrowLeft'); await expect(folder).toBeFocused();
  await folder.press('ArrowLeft'); await expect(folder).toHaveAttribute('aria-expanded', 'false');
  await panel(page).getByRole('tab', { name: 'Summary', exact: true }).focus(); await page.keyboard.press('End');
  await expect(panel(page).getByRole('tab', { name: 'Details', exact: true })).toBeFocused();
  await expect(panel(page).getByRole('tabpanel')).toHaveText('Detailed report content.');
  await panel(page).getByRole('button', { name: 'Refresh panel', exact: true }).press('Enter');
  await expect(page.locator('#toast')).toHaveText('Data panel refreshed');
  await tab(page).focus(); await page.keyboard.press('Home'); await expect(tab(page, 'changes')).toBeFocused();
  await page.keyboard.press('Enter'); await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await page.keyboard.press('End'); await expect(tab(page)).toBeFocused(); await page.keyboard.press('Enter');
  await expect(panel(page)).toBeVisible();
});

test('extensions views: selected extension intent survives disable, missing restart and re-enable', async ({ page }) => {
  await setup(page, true, true); await expect(panel(page)).toBeVisible();
  await panel(page).getByRole('button', { name: 'Refresh panel', exact: true }).focus();
  await enable(page, false); await expect(tab(page)).toHaveCount(0); await expect(tab(page, 'changes')).toBeFocused();
  await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.inspector.tabs')!).selected)).toBe(id);
  await page.reload(); await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await enable(page, true); await expect(tab(page)).toHaveAttribute('aria-selected', 'true'); await expect(panel(page)).toBeVisible();
  await page.evaluate(() => { (window as any).__retainedPackage = localStorage.getItem('pandacode.preview.extensions.v1'); localStorage.setItem('pandacode.preview.extensions.v1', '[]'); });
  await page.evaluate(async () => (window as any).__previewRefreshExtensions());
  await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await page.evaluate(() => localStorage.setItem('pandacode.preview.extensions.v1', (window as any).__retainedPackage));
  await page.evaluate(async () => (window as any).__previewRefreshExtensions());
  await expect(panel(page)).toBeVisible();
});

test('extensions views: explicit built-in selection supersedes dormant selection without losing the open extension tab', async ({ page }) => {
  await setup(page, true, true); await expect(panel(page)).toBeVisible(); await enable(page, false);
  await tab(page, 'changes').click(); await enable(page, true);
  await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(tab(page)).toBeVisible(); await expect(panel(page)).toHaveCount(0);
  await tab(page).click(); await expect(panel(page)).toBeVisible();
});

test('extensions views: catalog visibility/order overlays apply to dynamic tabs and restore dormant preferences', async ({ page }) => {
  await setup(page, true, true); await expect(panel(page)).toBeVisible(); await add(page, 'Panel notes');
  await overlay(page, { orders: { 'panda.inspector.views': [notes, id] } });
  await expect.poll(() => page.locator('.inspector-tab[data-extension-view]:not([hidden])').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.view))).toEqual([notes, id]);
  await tab(page).click(); await overlay(page, { visibility: { [id]: false }, orders: { 'panda.inspector.views': [notes, id] } });
  await expect(tab(page)).toBeHidden(); await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await overlay(page, { orders: { 'panda.inspector.views': [notes, id] } }); await expect(panel(page)).toBeVisible();
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByLabel('Item owner', { exact: true }).selectOption('sample.data-panel');
  await expect(page.locator(`[data-catalog-item="${id}"]`)).toContainText('Type: view');
  await expect(page.getByRole('button', { name: 'Hide Data panel', exact: true })).toBeVisible();
  const row = page.locator(`[data-order-id="${id}"]`);
  await row.focus(); await row.press('Alt+ArrowUp');
  await expect(page.locator('[aria-label="Order sample.data-panel panda.inspector.views"] [data-order-id]').first()).toHaveAttribute('data-order-id', id);
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
  await expect.poll(() => page.locator('.inspector-tab[data-extension-view]:not([hidden])').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.view))).toEqual([id, notes]);
  await enable(page, false); await enable(page, true); await expect(panel(page)).toBeVisible();
});

test('extensions views: switching, closing and hiding dispose detached listeners and transient dialogs', async ({ page }) => {
  await page.addInitScript(() => {
    const original = EventTarget.prototype.addEventListener;
    (window as any).__viewListenerSignals = [];
    EventTarget.prototype.addEventListener = function (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
      if (this instanceof Element && this.closest('.extension-inspector-view') && typeof options === 'object' && options.signal) (window as any).__viewListenerSignals.push(options.signal);
      return original.call(this, type, callback, options);
    };
  });
  await setup(page, true, true); await expect(panel(page)).toBeVisible();
  await page.evaluate(() => { (window as any).__detachedPanelButton = document.querySelector('.extension-view-toolbar button'); });
  await panel(page).getByRole('button', { name: 'Panel options', exact: true }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await tab(page, 'changes').evaluate((node: HTMLElement) => node.click());
  await expect(page.getByRole('dialog')).not.toBeVisible(); await expect(panel(page)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__viewListenerSignals.length > 0 && (window as any).__viewListenerSignals.every((signal: AbortSignal) => signal.aborted))).toBe(true);
  await page.evaluate(() => { document.querySelector('#toast')!.textContent = 'No late action'; (window as any).__detachedPanelButton.click(); });
  await expect(page.locator('#toast')).toHaveText('No late action');
  await tab(page).click(); await expect(panel(page)).toBeVisible();
  await tab(page).focus(); await page.keyboard.press('Delete'); await expect(tab(page)).toBeHidden();
  await add(page, 'Data panel'); await expect(panel(page)).toBeVisible();
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click(); await expect(panel(page)).toHaveCount(0);
  await page.locator('#inspector-toggle').click(); await expect(panel(page)).toBeVisible();
});

test('extensions views: presentation lifecycle preserves running core task, file session, terminal and draft', async ({ page }) => {
  await setup(page); await openInspectorTab(page, 'tab-files');
  await page.locator('.file-row [data-action="open-file"]').first().click();
  await expect(page.locator('#file-tabs')).toBeVisible();
  const file = await page.locator('#file-tabs').textContent();
  await page.locator('#terminal-toggle').click(); await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdRun = true; });
  await page.locator('#prompt').fill('Keep this task running'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('#prompt')).toBeEnabled(); await page.locator('#prompt').fill('Unsent panel draft');
  await page.getByRole('button', { name: 'Open data panel', exact: true }).click(); await expect(panel(page)).toBeVisible();
  await tab(page, 'changes').click(); await tab(page).click(); await enable(page, false);
  await expect(page.locator('#prompt')).toHaveValue('Unsent panel draft');
  await expect(page.locator('#terminal-host .xterm-screen')).toBeVisible();
  await page.locator('#terminal-host .xterm-helper-textarea').pressSequentially('echo preserved');
  await page.locator('[data-action="tab-open-files"]').click(); await expect(page.locator('#file-tabs')).toHaveText(file!);
  const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls);
  expect(calls.filter((call: any) => ['close_terminal', 'stop_session', 'stop_task', 'cancel_task', 'delete_session'].includes(call.command))).toEqual([]);
  expect(calls.filter((call: any) => call.command === 'start_terminal')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'send_message')).toHaveLength(1);
  expect(calls.filter((call: any) => call.command === 'write_terminal').map((call: any) => call.args.data).join('')).toBe('echo preserved');
});

test('extensions views: malformed/conflicting packages and safe recovery keep a built-in inspector, never package markup', async ({ page }) => {
  await setup(page, true, true); await expect(panel(page)).toBeVisible();
  await page.evaluate(() => { const key = 'pandacode.preview.extensions.v1', values = JSON.parse(localStorage.getItem(key)!); values[0].manifest.contributes.views[0].controls[4].value = 101; localStorage.setItem(key, JSON.stringify(values)); });
  await page.evaluate(async () => (window as any).__previewRefreshExtensions());
  await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true'); await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
  await page.evaluate(manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }, { manifest, enabled: true, icons: {} }])); }, manifest);
  await page.evaluate(async () => (window as any).__previewRefreshExtensions()); await expect(tab(page)).toHaveCount(0);
  await page.goto('/?extensions-baseline&data-panel&safe-mode'); await expect(tab(page, 'changes')).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('#prompt')).toBeEnabled(); await expect(page.locator('#inspector-content .changes-view')).toBeVisible();
});

test('extensions views: declared strings remain inert text in every control, including title and toolbar', async ({ page }) => {
  await setup(page, true, true); await expect(panel(page)).toBeVisible();
  const text = '<img src="/not-an-extension-resource" onerror="document.body.dataset.extensionExecuted=1">';
  await page.evaluate(text => {
    const key = 'pandacode.preview.extensions.v1', packages = JSON.parse(localStorage.getItem(key)!);
    const view = packages[0].manifest.contributes.views[0];
    view.title = text; view.text = text; view.controls[0].items[0] = text; view.controls[1].items[0].label = text;
    view.controls[2].rows[0][0] = text; view.controls[3].items[0].text = text;
    packages[0].manifest.contributes.commands[1].title = text;
    localStorage.setItem(key, JSON.stringify(packages));
  }, text);
  await page.evaluate(async () => (window as any).__previewRefreshExtensions());
  const content = page.locator('.extension-inspector-view');
  await expect(content).toContainText(text); await expect(tab(page)).toHaveAccessibleName(text);
  await expect(content.locator('img, script, iframe')).toHaveCount(0);
  expect(await page.locator('body').getAttribute('data-extension-executed')).toBeNull();
  await expect(page.locator('#prompt')).toBeEnabled();
});
