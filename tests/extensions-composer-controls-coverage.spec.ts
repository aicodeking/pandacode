import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with a held synthetic run. No real harness runs; installed
// WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/composer-controls/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.composer-controls/toolbar';
const props = (page: Page) => page.evaluate(() => (window as any).__previewComposer());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const toast = (page: Page) => page.locator('#toast');
const tools = (page: Page) => page.locator('#composer .composer-tools > button').evaluateAll(nodes => nodes.map(node => node.className.split(' ').find(name => /^(model-picker|mode-picker|composer-(team|saver|council)-button)$/.test(name)) ?? ''));
const steerParts = (page: Page) => page.locator('#composer .composer-steer-bar > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action));
const rail = (page: Page) => page.locator('.model-menu .model-menu-rail [role="tab"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.view));
async function setup(page: Page, packages: unknown[] = [], baseline: Record<string, unknown> = {}) {
  await page.addInitScript(({ packages, baseline }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true, ...baseline };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, baseline });
  await page.goto('/?extensions-baseline&composer-controls&replacement'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.controls.length ?? 0).toBeGreaterThan(0);
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', id); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, changes }) => {
    const p = (window as any).__previewComposer(), control = p.controls.find((item: any) => item.controlId === controlId) ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewComposerAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, changes));
async function run(page: Page) {
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(page.locator('#composer .composer-steer-bar > .steer-button')).toBeVisible();
}
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function hide(page: Page, location: string, label: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `Hide ${label}`, exact: true });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
  return region;
}
const noEffects = async (page: Page) => { expect(await calls(page, 'update_session')).toEqual([]); expect(await calls(page, 'configure_session')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]); };

test('Composer controls extension: zero extensions keep the tray, model picker, Permissions menu, steer bar, IME and Escape', async ({ page }) => {
  await setup(page);
  expect(await tools(page)).toEqual(['model-picker', 'mode-picker', 'composer-team-button', 'composer-saver-button', 'composer-council-button']);
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, running: false, steering: false, draft: false, mode: 'ask' });
  expect(await act(page, 'mode')).toEqual({ ok: false, reason: 'Revoked' });
  // The Permissions menu keeps its radio rows and nothing else.
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(menu.getByRole('menuitemradio', { name: 'Standard', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(menu.getByRole('menuitem')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  // The model picker has its rail and no action row.
  await page.locator('#model-picker-trigger').click(); await expect(page.locator('.model-menu')).toBeVisible();
  expect((await rail(page)).slice(0, 3)).toEqual(['recent', 'h:claude', 'h:codex']);
  await expect(page.locator('.model-menu-extensions button')).toHaveCount(0);
  await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0);
  // IME: the committing Enter (keyCode 229) never sends.
  await prompt(page).dispatchEvent('compositionstart');
  await prompt(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  await prompt(page).dispatchEvent('compositionend', { data: '語' });
  await prompt(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  expect(await calls(page, 'send_message')).toEqual([]);
  await run(page);
  expect(await steerParts(page)).toEqual(['steer-edit', 'steer', 'steer-clear']);
  await expect(page.locator('#composer .composer-steer-bar [data-extension-contribution]')).toHaveCount(0);
  expect(await props(page)).toMatchObject({ running: true, steering: true });
  // Escape in the steer bar returns to the prompt and never stops the turn.
  await prompt(page).fill('Steer draft'); await page.locator('#composer .steer-button').focus(); await page.keyboard.press('Escape');
  await expect(prompt(page)).toBeFocused(); await expect(prompt(page)).toHaveValue('Steer draft');
  expect(await calls(page, 'stop_session')).toEqual([]); expect(await calls(page, 'steer_task')).toEqual([]);
  expect((await calls(page, 'send_message')).length).toBe(1);
});

test('Composer controls extension: an installed package adds model picker, Permissions menu and steer bar actions that run with the captured task', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page);
  const region = await explorer(page);
  const before = await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))));
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.composer-controls', exact: true }).click();
  await expect(region.getByLabel('Composer presentation')).toHaveValue('');
  expect(await page.evaluate(() => JSON.stringify(Object.keys(localStorage).sort().filter(key => !key.startsWith('pandacode.preview.extensions') && !key.startsWith('pandacode.components'))))).toBe(before);
  await back(page);
  // Model picker: the contributed action row, reachable by Tab, runs with the captured task and model.
  await page.locator('#model-picker-trigger').click(); await expect(page.locator('.model-menu')).toBeVisible();
  const notes = page.locator('.model-menu-extensions').getByRole('button', { name: 'Model notes', exact: true });
  await expect(notes).toBeVisible();
  await page.keyboard.press('Tab'); await page.keyboard.press('Tab'); await page.keyboard.press('Tab');
  await expect(notes).toBeFocused();
  await notes.click(); await expect(toast(page)).toContainText('The model choice stays with PandaCode.');
  await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0);
  // Permissions: the modes keep their rows and order; the contributed row follows them.
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  const rows = await menu.getByRole('menuitem').evaluateAll(nodes => nodes.map(node => node.textContent?.trim()));
  expect(rows.at(-1)).toBe('Permission notes'); expect(rows[0]).toContain('Standard');
  await expect(menu.getByRole('menuitem', { name: /Standard/ })).toHaveAttribute('aria-current', 'true');
  await menu.getByRole('menuitem', { name: 'Permission notes', exact: true }).click(); await expect(toast(page)).toContainText('Approval modes stay host authority.');
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'ask');
  // A mode chosen by the user in the same menu still runs the original handler, once.
  await page.locator('#mode-picker-trigger').click();
  await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitem', { name: /Plan mode/ }).click();
  await expect(page.locator('#mode-picker-trigger')).toHaveAttribute('data-mode', 'plan');
  await expect.poll(() => calls(page, 'update_session')).toHaveLength(1);
  // With the package's actions mounted, the committing IME Enter still never sends.
  await prompt(page).dispatchEvent('compositionstart');
  await prompt(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229, isComposing: true });
  await prompt(page).dispatchEvent('compositionend', { data: '語' });
  await prompt(page).dispatchEvent('keydown', { key: 'Enter', code: 'Enter', keyCode: 229 });
  expect(await calls(page, 'send_message')).toEqual([]);
  // Steer bar: the contributed action sits in the bar, keeps the draft, and Escape there returns to the prompt.
  await run(page);
  await prompt(page).fill('Keep this steer draft');
  const steerNotes = page.locator('#composer .composer-steer-bar').getByRole('button', { name: 'Steer notes', exact: true });
  await steerNotes.click(); await expect(toast(page)).toContainText('Steering keeps the running turn and its draft.');
  await steerNotes.focus(); await page.keyboard.press('Escape'); await expect(prompt(page)).toBeFocused();
  await expect(prompt(page)).toHaveValue('Keep this steer draft');
  expect(await calls(page, 'steer_task')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
  expect((await calls(page, 'send_message')).length).toBe(1);
});

test('Composer controls extension: captured actions run original handlers; mode and model changes, stale, replayed and forged requests fail', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  // A package never changes the approval mode or the model itself: the request is refused, whatever it names.
  for (const controlId of ['mode-set', 'model-set', 'effort-set', 'team-set', 'send', 'stop', 'approve']) expect(await act(page, 'mode', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'mode', { mode: 'full' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'mode', { selector: '#mode-picker-trigger' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'mode', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await noEffects(page);
  // Mode opens the original Permissions menu: only the user's own choice there changes the mode.
  const mode = await action(page, 'mode');
  expect(await send(page, mode)).toEqual({ ok: true });
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  await expect(menu).toBeVisible(); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'model')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(menu).toHaveCount(0);
  // The menu changed the captured state: the same request is refused, never replayed.
  expect(await send(page, mode)).toEqual({ ok: false, reason: 'StaleContext' });
  await noEffects(page);
  // Model opens the original picker; nothing is selected until the user picks.
  expect(await act(page, 'model')).toEqual({ ok: true }); await expect(page.locator('.model-menu')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0);
  await noEffects(page);
  // Steer needs a fresh host choice bound to the same task and draft; Escape declines it and nothing steers or stops.
  await run(page);
  await prompt(page).fill('Steer from the package');
  expect(await act(page, 'steer')).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  const continueSteer = page.getByRole('menuitemradio', { name: 'Continue: Steer the running turn', exact: true });
  await expect(continueSteer).toBeVisible();
  await page.keyboard.press('Escape'); await expect(continueSteer).toHaveCount(0);
  expect(await calls(page, 'steer_task')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
  await expect(prompt(page)).toHaveValue('Steer from the package');
  // An edited draft is another target: a request captured before the edit is refused.
  const stale = await action(page, 'steer');
  await prompt(page).fill('Steer the edited draft');
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'steer')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Steer the running turn', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'steer_task')).length).toBe(1);
  expect((await calls(page, 'steer_task'))[0].args).toMatchObject({ sessionId: 'session-1', text: 'Steer the edited draft' });
  // Clear needs the same fresh choice; Edit focuses the prompt directly.
  await prompt(page).fill('Draft to clear');
  expect(await act(page, 'steer-clear')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Clear the draft', exact: true }).click();
  await expect(prompt(page)).toHaveValue('');
  await page.locator('#model-picker-trigger').focus();
  expect(await act(page, 'steer-edit')).toEqual({ ok: true }); await expect(prompt(page)).toBeFocused();
  // Switching task changes the captured task: requests made for the first task are refused there.
  const elsewhere = await action(page, 'mode');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'mode', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await calls(page, 'steer_task')).length).toBe(1); expect(await calls(page, 'stop_session')).toEqual([]);
  expect((await calls(page, 'update_session')).length).toBe(0);
});

test('Composer controls extension: tray and model picker order and hiding persist across a reload and never touch pinned controls', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.composer.tray.controls', 'Model picker after Council'); await back(page);
  await expect.poll(() => tools(page)).toEqual(['mode-picker', 'composer-team-button', 'composer-saver-button', 'composer-council-button', 'model-picker']);
  const region = await hide(page, 'panda.composer.tray.controls', 'Token saver');
  await expect(region.getByRole('button', { name: /^Hide (Model picker|Approval mode)/ })).toHaveCount(0);
  // The user's own order: Codex before Claude Code in the picker's rail; Kimi hidden there.
  await region.getByRole('button', { name: 'Move Harness codex before', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.composer.model.entries');
  const kimi = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Harness kimi', exact: true });
  for (let cursor = 0; cursor < 6 && !await kimi.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await kimi.click();
  await back(page);
  await expect(page.locator('#composer .composer-saver-button')).toBeHidden();
  expect(await act(page, 'saver')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const picker = async () => {
    await page.locator('#model-picker-trigger').click(); await expect(page.locator('.model-menu')).toBeVisible();
    const tabs = await rail(page); await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0); return tabs;
  };
  let tabs = await picker();
  expect(tabs.indexOf('h:codex')).toBeLessThan(tabs.indexOf('h:claude')); expect(tabs).not.toContain('h:kimi');
  // Search still covers a hidden harness.
  await page.locator('#model-picker-trigger').click(); await page.keyboard.type('kimi');
  await expect(page.locator('.model-menu-list [data-provider="kimi"]').first()).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(page.locator('.model-menu')).toHaveCount(0);
  // Preferences persist across a reload and restore on the original nodes and rail.
  await prompt(page).fill('Draft across reload');
  await page.reload(); await expect(prompt(page)).toBeEnabled();
  await expect.poll(() => tools(page)).toEqual(['mode-picker', 'composer-team-button', 'composer-saver-button', 'composer-council-button', 'model-picker']);
  await expect(page.locator('#composer .composer-saver-button')).toBeHidden();
  tabs = await picker(); expect(tabs.indexOf('h:codex')).toBeLessThan(tabs.indexOf('h:claude')); expect(tabs).not.toContain('h:kimi');
  // The task's own harness never leaves the rail, even through a forged overlay.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.composer.model.entries/claude': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  expect(await picker()).toContain('h:claude');
  await noEffects(page);
});

test('Composer controls extension: steer bar order and hiding, forged overlays and safe mode restore the built-in composer', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.composer.steering.controls', 'Edit draft after Clear'); await back(page);
  const region = await hide(page, 'panda.composer.steering.controls', 'Edit draft');
  await expect(region.getByRole('button', { name: /^Hide Steer/ })).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.composer.tray.controls');
  await region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Council', exact: true }).click();
  await back(page);
  await run(page);
  await expect.poll(() => steerParts(page)).toEqual(['steer', 'steer-clear', 'steer-edit']);
  await expect(page.locator('#composer .composer-steer-edit')).toBeHidden(); await expect(page.locator('#composer .steer-button')).toBeVisible();
  await expect(page.locator('#composer .composer-council-button')).toBeHidden();
  // A forged overlay cannot hide the model picker, the approval mode or Steer.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.composer.tray.controls/model': false, 'panda.composer.tray.controls/mode': false, 'panda.composer.steering.controls/steer': false, 'panda.composer.protected/draft': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await expect(page.locator('#model-picker-trigger')).toBeVisible(); await expect(page.locator('#mode-picker-trigger')).toBeVisible(); await expect(page.locator('#composer .steer-button')).toBeVisible();
  await expect(page.locator('#model-picker-trigger')).not.toHaveAttribute('data-layout-hidden');
  // Safe mode restores the built-in order and every hidden control; the draft and focus stay; captured actions stop.
  await prompt(page).fill('Safe mode draft'); await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewComposerSafeMode());
  await expect.poll(() => steerParts(page)).toEqual(['steer-edit', 'steer', 'steer-clear']);
  await expect(page.locator('#composer .composer-steer-edit')).toBeVisible(); await expect(page.locator('#composer .composer-council-button')).toBeVisible();
  await expect(prompt(page)).toHaveValue('Safe mode draft'); await expect(prompt(page)).toBeFocused();
  expect(await act(page, 'steer')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).safeMode).toBe(true);
  expect(await calls(page, 'steer_task')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
});

test('Composer controls extension: a running turn, its draft, model, mode and focus survive conflict, fault, disable and safe mode', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  const other = structuredClone(manifest); other.id = 'other.composer-controls'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.composer-controls/toolbar' }], commands: [{ id: 'other.composer-controls/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.composer-controls/permissions', command: 'other.composer-controls/notes', location: 'panda.composer.permissions.actions' }] };
  await setup(page, [manifest, other]);
  // Two compatible providers: neither is selected automatically.
  let region = await explorer(page);
  await expect(page.getByLabel('Composer presentation', { exact: true })).toHaveValue('');
  await back(page); await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await select(page, 'other.composer-controls/toolbar');
  // Both packages contribute to Permissions: both rows follow the pinned modes; neither displaces a mode.
  await page.locator('#mode-picker-trigger').click();
  const rows = await page.getByRole('dialog', { name: 'Permissions', exact: true }).getByRole('menuitem').evaluateAll(nodes => nodes.map(node => node.textContent?.trim() ?? ''));
  expect(rows.slice(-2).sort()).toEqual(['Other notes', 'Permission notes']); expect(rows.slice(0, -2).every(row => /Standard|Accept edits|Approve for me|Plan mode|Full access/.test(row))).toBe(true);
  await page.keyboard.press('Escape');
  await run(page);
  await prompt(page).fill('Keep this composer draft');
  await page.evaluate(() => { (window as any).__composerNodes = { prompt: document.querySelector('#prompt'), model: document.querySelector('#model-picker-trigger')?.textContent, mode: document.querySelector('#mode-picker-trigger')?.getAttribute('data-mode') }; });
  const sends = (await calls(page, 'send_message')).length;
  const check = async () => {
    expect(await page.evaluate(() => { const w = window as any; return w.__composerNodes.prompt === document.querySelector('#prompt') && w.__composerNodes.model === document.querySelector('#model-picker-trigger')?.textContent && w.__composerNodes.mode === document.querySelector('#mode-picker-trigger')?.getAttribute('data-mode'); })).toBe(true);
    await expect(prompt(page)).toHaveValue('Keep this composer draft');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await expect(page.locator('#composer .steer-button')).toBeVisible();
    expect((await calls(page, 'send_message')).length).toBe(sends); expect(await calls(page, 'steer_task')).toEqual([]); expect(await calls(page, 'stop_session')).toEqual([]);
    expect(await calls(page, 'update_session')).toEqual([]); expect(await calls(page, 'configure_session')).toEqual([]);
  };
  await check();
  // Stream events redraw nothing the composer owns.
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'text', text: 'A live synthetic reply.' }));
  await expect(page.locator('#stream-region')).toContainText('A live synthetic reply.');
  await check();
  // A faulting composer recipe falls back to the built-in composer: captured actions stop, the draft stays.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'steer')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.composer-controls'));
  await check(); await expect(prompt(page)).toBeFocused();
  region = await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', PROVIDER);
  await check();
  // Exactly once: one captured Steer after one fresh choice steers once.
  expect(await act(page, 'steer')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Steer the running turn', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'steer_task')).length).toBe(1);
  await expect(prompt(page)).toHaveValue('');
  await prompt(page).fill('Draft before safe mode'); await prompt(page).focus();
  await page.evaluate(() => (window as any).__previewComposerSafeMode());
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await expect(prompt(page)).toHaveValue('Draft before safe mode'); await expect(prompt(page)).toBeFocused();
  await expect(page.locator('#composer .composer-steer-bar [data-extension-contribution]')).toHaveCount(0);
  expect((await props(page)).safeMode).toBe(true);
  // The host still steers and stops: once each.
  await page.locator('#composer .steer-button').click();
  await expect.poll(async () => (await calls(page, 'steer_task')).length).toBe(2);
  await page.getByRole('button', { name: 'Stop task', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'stop_session')).length).toBe(1);
  expect((await calls(page, 'send_message')).length).toBe(sends);
  void region;
});
