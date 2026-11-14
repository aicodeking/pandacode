import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: preferences live in this page's storage and every native command is the preview mock.
// No real settings file, credential, pairing or update is read or written.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/settings-core/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.settings-core/actions-first';
const props = (page: Page) => page.evaluate(() => (window as any).__previewSettings());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const root = (page: Page) => page.locator('#settings-page');
const tab = (page: Page, name: string) => page.locator('.settings-nav-list').getByRole('tab', { name, exact: true });
const panel = (page: Page, id: string) => page.locator(`#settings-panel-${id}`);
const sections = (page: Page) => page.locator('.settings-nav-list > [role="tab"]').evaluateAll(nodes => nodes.filter(node => !node.hasAttribute('data-layout-hidden')).map(node => node.textContent?.trim() ?? ''));
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&settings-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function settings(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await expect(tab(page, 'General')).toBeVisible(); }
async function open(page: Page, name: string, id: string) { await tab(page, name).click(); await expect(panel(page, id)).toBeVisible(); }
async function explorer(page: Page) { await open(page, 'Extensions', 'extensions'); return page.getByRole('region', { name: 'Surface explorer' }); }
async function select(page: Page, id = PROVIDER) { const region = await explorer(page); await region.getByLabel('Settings presentation', { exact: true }).selectOption(id); await expect(root(page)).toHaveAttribute('data-settings-provider', id); }
/** Builds a captured action from the live presentation. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, changes }) => {
    const p = (window as any).__previewSettings(), control = p.controls.find((control: any) => control.controlId === controlId);
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, page: p.page, revision: p.revision, control: control.id, controlId, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewSettingsAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, changes));
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
async function palette(page: Page, words: string, label: string) {
  await page.keyboard.press(process.platform === 'darwin' ? 'Meta+K' : 'Control+K');
  await page.getByRole('textbox', { name: 'Search tasks and commands' }).fill(words);
  await page.locator('#command-results button[data-action="settings-page"]', { hasText: label }).click();
}
const BUILT_IN = ['Recommended', 'General', 'Appearance', 'Voice', 'Agents', 'Schedules', 'Tools', 'Connections', 'Extensions', 'About'];

test('Settings extension: zero extensions keep every section, page, keyboard path and original handler', async ({ page }) => {
  await setup(page); await settings(page);
  expect(await sections(page)).toEqual(BUILT_IN); await expect(root(page)).not.toHaveAttribute('data-settings-provider');
  const p = await props(page);
  expect(p).toMatchObject({ page: 'recommended', section: 'recommended', visible: true, busy: false, safeMode: false, controls: [] });
  expect(p.sections.filter((section: any) => section.pinned).map((section: any) => section.id)).toEqual(['voice', 'agents', 'connections', 'extensions', 'about']);
  await open(page, 'General', 'general');
  expect((await props(page)).controls.map((control: any) => control.controlId)).toEqual(['compact-mode', 'expand-tool-activity']);
  expect(await act(page, 'compact-mode')).toEqual({ ok: false, reason: 'Revoked' }); await expect(page.locator('#compact-mode')).not.toBeChecked();
  await expect(panel(page, 'general').locator('.settings-panel-head .extension-header-actions')).toBeHidden();
  await tab(page, 'General').focus(); await page.keyboard.press('ArrowDown'); await expect(tab(page, 'Appearance')).toBeFocused(); await expect(panel(page, 'appearance')).toBeVisible();
  await page.keyboard.press('End'); await expect(tab(page, 'About')).toBeFocused();
  await tab(page, 'Appearance').focus(); await page.keyboard.press('Shift+F10'); await expect(page.locator('.floating-menu')).toHaveCount(0);
  await open(page, 'General', 'general'); await page.locator('#compact-mode').click(); await expect(page.locator('body')).toHaveClass(/compact/);
  await palette(page, 'providers', 'Settings › Agents › Providers'); await expect(panel(page, 'providers')).toBeVisible();
  await expect(page.locator('[data-extension-settings-group]')).toHaveCount(0);
});

test('Settings extension: install/enable writes no preference; the selected recipe adds page and section actions', async ({ page }) => {
  await setup(page); await settings(page); const region = await explorer(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.settings-core', exact: true }).click();
  await expect(region.getByLabel('Settings presentation')).toHaveValue(''); await expect(root(page)).not.toHaveAttribute('data-settings-provider');
  await region.getByLabel('Settings presentation').selectOption(PROVIDER); await expect(root(page)).toHaveAttribute('data-settings-provider', PROVIDER);
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  expect(await page.evaluate(() => localStorage.getItem('pandacode.preview.extension-settings.v1.sample.settings-core.sample.settings-core/report'))).toBeNull();
  await open(page, 'General', 'general'); await expect(page.locator('#compact-mode')).not.toBeChecked();
  const actions = panel(page, 'general').locator('.settings-panel-head .extension-header-actions');
  await expect(actions).toHaveCSS('order', '-1'); await expect(panel(page, 'general').locator('.settings-panel-head')).toHaveCSS('display', 'flex');
  await actions.getByRole('button', { name: 'Settings notes', exact: true }).click(); await expect(page.locator('#toast')).toContainText('Settings ownership stays with PandaCode');
  await tab(page, 'General').focus(); await page.keyboard.press('Shift+F10');
  const menu = page.getByRole('dialog', { name: 'General section', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Open General', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Settings notes', exact: true }).click(); await expect(page.locator('#toast')).toContainText('Settings ownership stays with PandaCode');
  await tab(page, 'Appearance').click({ button: 'right' }); await page.keyboard.press('Escape'); await expect(tab(page, 'Appearance')).toBeFocused();
  await expect(panel(page, 'general')).toBeVisible();
  const p = await props(page); expect(p).toMatchObject({ page: 'general', section: 'general', visible: true, safeMode: false });
});

test('Settings extension: actions run original handlers after a fresh choice; stale, replayed, forged and busy requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await settings(page); await select(page); await open(page, 'General', 'general');
  const stale = await action(page, 'expand-tool-activity');
  expect(await act(page, 'compact-mode', { controlId: 'turn-checks' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'compact-mode', { selector: '#compact-mode' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'compact-mode', { value: true })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'compact-mode', { page: 'appearance' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'compact-mode', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const request = await action(page, 'compact-mode');
  expect(await send(page, request)).toEqual({ ok: true }); await expect(page.locator('#compact-mode')).not.toBeChecked();
  expect((await props(page)).busy).toBe(true); expect(await act(page, 'expand-tool-activity')).toEqual({ ok: false, reason: 'Busy' });
  await proceed(page, 'Compact conversation'); await expect(page.locator('#compact-mode')).toBeChecked(); await expect(page.locator('body')).toHaveClass(/compact/);
  // The answered choice changed the captured state: the same request is refused, never run twice.
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' }); await expect(page.locator('#compact-mode')).toBeChecked();
  expect(await act(page, 'expand-tool-activity')).toEqual({ ok: true }); await page.keyboard.press('Escape');
  await expect(page.locator('#expand-tool-activity')).not.toBeChecked(); expect((await props(page)).busy).toBe(false);
  await open(page, 'Appearance', 'appearance');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' }); await expect(page.locator('#expand-tool-activity')).not.toBeChecked();
  await open(page, 'Agents', 'agents');
  expect((await props(page)).controls.map((control: any) => control.controlId)).toEqual(['default-provider', 'default-model', 'agent-updates', 'refresh-agents']);
  expect(await act(page, 'agent-updates')).toEqual({ ok: true }); await expect(page.locator('#dialog')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('#dialog')).toBeHidden(); await expect(panel(page, 'agents')).toBeVisible();
  await open(page, 'About', 'about'); await page.context().setOffline(true);
  expect(await act(page, 'support')).toEqual({ ok: false, reason: 'Offline' }); await page.context().setOffline(false);
  expect(await act(page, 'support')).toEqual({ ok: true }); expect(await calls(page, 'open_external_url')).toHaveLength(0); await page.keyboard.press('Escape');
  for (const field of ['context', 'project', 'control']) expect(await act(page, 'support', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'support', { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
});

test('Settings extension: compatible section and row order, reversible visibility, pinned protected sections and deep links', async ({ page }) => {
  await setup(page, [manifest]); await settings(page); await select(page);
  const region = page.getByRole('region', { name: 'Surface explorer' });
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.settings.sections');
  await region.getByRole('button', { name: 'Grant UI customization and select Appearance before General', exact: true }).click();
  await expect.poll(() => sections(page)).toEqual(['Recommended', 'Appearance', 'General', 'Voice', 'Agents', 'Schedules', 'Tools', 'Connections', 'Extensions', 'About']);
  const next = region.getByRole('button', { name: 'Next items', exact: true });
  const hide = async (name: string) => { for (let cursor = 0; cursor < 4 && !await region.getByRole('button', { name, exact: true }).count(); cursor++) await next.click(); await region.getByRole('button', { name, exact: true }).click(); };
  await hide('Hide General');
  for (const pinned of ['Extensions', 'About', 'Voice', 'Agents', 'Connections']) await expect(region.getByRole('button', { name: `Hide ${pinned}`, exact: true })).toHaveCount(0);
  await expect(tab(page, 'General')).toBeHidden(); expect(await sections(page)).not.toContain('General');
  await tab(page, 'Appearance').focus(); await page.keyboard.press('ArrowDown'); await expect(tab(page, 'Voice')).toBeFocused();
  await palette(page, 'compact', 'Settings › General'); await expect(panel(page, 'general')).toBeVisible(); await expect(tab(page, 'General')).toBeVisible();
  expect((await props(page)).sections.find((section: any) => section.id === 'general').hidden).toBe(false);
  await open(page, 'Appearance', 'appearance'); await expect(tab(page, 'General')).toBeHidden();
  expect((await props(page)).sections.find((section: any) => section.id === 'general').hidden).toBe(true);
  // A forged overlay cannot hide pinned sections or the protected project-checks consent.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key) ?? 'null') ?? { schemaVersion: 1, visibility: {}, extensionLayoutsEnabled: true, orders: {}, selected: {} }; value.visibility = { ...value.visibility, 'panda.settings.sections/extensions': false, 'panda.settings.sections/about': false, 'panda.settings.controls/turn-checks': false, 'panda.settings.protected/turn-checks': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(tab(page, 'Extensions')).toBeVisible(); await expect(tab(page, 'About')).toBeVisible();
  await open(page, 'Agents', 'agents'); await expect(page.locator('#turn-checks')).toBeVisible();
  await open(page, 'Extensions', 'extensions');
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.settings.controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Tool activity first', exact: true }).click();
  await hide('Hide Expand tool activity');
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.settings.protected');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button')).toHaveCount(0);
  await palette(page, 'compact', 'Settings › General');
  await expect(page.locator('#expand-tool-activity')).toBeHidden(); await expect(page.locator('#compact-mode')).toBeVisible();
  expect(await act(page, 'expand-tool-activity')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.locator('#compact-mode').focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(page.locator('#compact-mode')).toBeFocused();
  await open(page, 'Extensions', 'extensions'); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect.poll(() => sections(page)).toEqual(BUILT_IN); await expect(root(page)).not.toHaveAttribute('data-settings-provider');
  await open(page, 'General', 'general'); await expect(page.locator('#expand-tool-activity')).toBeVisible();
  const order = await panel(page, 'general').locator('.setting-row').evaluateAll(rows => rows.map(row => row.querySelector('input')?.id ?? ''));
  expect(order.indexOf('compact-mode')).toBeLessThan(order.indexOf('expand-tool-activity'));
  expect(await act(page, 'compact-mode')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
});

test('Settings extension: shared fields use the package namespace; fault, disable and safe mode keep the page, focus and unsaved core edits', async ({ page }) => {
  await setup(page, [manifest]); await settings(page); await select(page);
  await palette(page, 'report fields', 'Settings › General › Report fields');
  await expect(panel(page, 'general')).toBeVisible();
  const group = page.getByRole('region', { name: 'Report fields · sample.settings-core', exact: true });
  await expect(group).toBeVisible(); await expect(group).toContainText('Extension: sample.settings-core');
  const label = group.getByRole('textbox', { name: 'Report label', exact: true }); await expect(label).toHaveValue('Local report');
  await label.fill(''); await group.getByRole('button', { name: 'Save extension settings', exact: true }).click();
  expect(await label.evaluate(input => (input as HTMLInputElement).validity.valueMissing)).toBe(true); expect(await page.evaluate(() => localStorage.getItem('pandacode.preview.extension-settings.v1.sample.settings-core.sample.settings-core/report'))).toBeNull();
  await label.fill('Weekly'); await label.focus();
  await label.dispatchEvent('keydown', { key: 'Enter', keyCode: 229, isComposing: true }); expect(await page.evaluate(() => localStorage.getItem('pandacode.preview.extension-settings.v1.sample.settings-core.sample.settings-core/report'))).toBeNull();
  await group.getByRole('button', { name: 'Save extension settings', exact: true }).click(); await expect(group).toContainText('Extension settings saved');
  // Stored only in the package's own namespace, through the original extension settings handler.
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('pandacode.preview.extension-settings.v1.sample.settings-core.sample.settings-core/report')) ?? 'null')).toEqual({ label: 'Weekly', summary: true });
  expect(await page.evaluate(() => localStorage.getItem('pandacode.compact'))).toBeNull();
  // Unsaved core edit on another page survives every recovery path with its page and focus.
  await open(page, 'Agents', 'agents'); await page.getByRole('tab', { name: 'Agent teams', exact: true }).click(); await expect(panel(page, 'teams')).toBeVisible();
  const team = panel(page, 'teams').getByRole('textbox', { name: 'Lead guidance', exact: true }); await team.fill('Unsaved roster'); await team.focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySettingsPresentation(document.querySelector('#settings-page'), () => { throw Error('controlled fault'); }); });
  await expect(root(page)).not.toHaveAttribute('data-settings-provider'); expect(await act(page, 'compact-mode').catch(() => 'no-control')).toBe('no-control');
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change')));
  await expect(team).toHaveValue('Unsaved roster'); await expect(team).toBeFocused(); await expect(panel(page, 'teams')).toBeVisible();
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.settings-core'));
  await expect(page.locator('[data-extension-settings-group]')).toHaveCount(0);
  await expect(team).toHaveValue('Unsaved roster'); await expect(team).toBeFocused(); await expect(panel(page, 'teams')).toBeVisible();
  await page.evaluate(() => (window as any).__previewSettingsSafeMode());
  await expect(team).toHaveValue('Unsaved roster'); await expect(team).toBeFocused(); await expect(panel(page, 'teams')).toBeVisible();
  expect((await props(page)).safeMode).toBe(true);
});

test('Settings extension: conflict and future providers never auto-select; a faulted recipe reports once and recovers', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.settings-core'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.settings-core/actions-first' }] };
  const future = structuredClone(other); future.id = 'future.settings-core'; future.contributes.components[0].id = 'future.settings-core/actions-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); await settings(page); const region = await explorer(page);
  await expect(region.getByLabel('Settings presentation')).toHaveValue(''); await expect(region.locator('option[value="future.settings-core/actions-first"]')).toHaveAttribute('disabled', '');
  await expect(root(page)).not.toHaveAttribute('data-settings-provider');
  await select(page, 'other.settings-core/actions-first'); await open(page, 'General', 'general');
  expect(await act(page, 'compact-mode', { requestId: 'x'.repeat(129) })).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySettingsPresentation(document.querySelector('#settings-page'), () => { throw Error('controlled fault'); }); });
  await expect(root(page)).not.toHaveAttribute('data-settings-provider');
  expect(await act(page, 'compact-mode')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(panel(page, 'general')).toBeVisible(); await expect(page.locator('#compact-mode')).not.toBeChecked();
});
