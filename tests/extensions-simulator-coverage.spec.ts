import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/simulator/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewSimulator());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = [], platform = 'MacIntel') {
  await page.addInitScript(({ packages, platform }) => {
    Object.defineProperty(navigator, 'platform', { value: platform });
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    (window as any).__clipboardWrites = [];
    Object.defineProperty(navigator, 'clipboard', { value: { write: async (items: unknown) => (window as any).__clipboardWrites.push(items), writeText: async (text: string) => (window as any).__clipboardWrites.push(text) } });
    if (!(window as any).ClipboardItem) (window as any).ClipboardItem = class { constructor(public data: unknown) {} };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, platform });
  await page.goto('/?extensions-baseline&simulator-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-simulator');
  await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await expect.poll(async () => (await props(page))?.loading).toBe(false);
  await expect(page.locator('.sim-device')).toBeEnabled();
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('Simulator presentation', { exact: true }).selectOption('sample.simulator/controls'); await back(page); }
async function action(page: Page, controlId: string, value = '') {
  return page.evaluate(({ controlId, value }) => {
    const p = (window as any).__previewSimulator();
    const a = { contractVersion: 1, context: p.context, project: p.project, session: p.session, device: p.device, platform: p.platform, revision: p.revision, controlId, value, requestId: crypto.randomUUID() };
    (window as any).__capturedSimulator = a; return (window as any).__previewSimulatorAction(a);
  }, { controlId, value });
}
const settled = async (page: Page) => expect.poll(async () => (await props(page)).busy).toBe(false);
test('simulator: zero extensions keep original device, keyboard input, frame and focus lifecycle', async ({ page }) => {
  await setup(page);
  await expect(page.locator('[data-simulator-provider]')).toHaveCount(0);
  await expect(page.locator('.sim-device-name')).toHaveText('iPhone 17 Pro');
  await expect.poll(async () => (await calls(page, 'simulator_frame')).some((call: any) => call.args.after > 0)).toBe(true);
  expect(await page.locator('.sim-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sim')))).toEqual(['power', 'back', 'home', 'recents', 'lock', 'pose', 'appearance', 'capture', 'finish']);
  const node = await page.locator('.sim-stage').elementHandle(), before = await props(page);
  await page.locator('.sim-stage').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })));
  expect(await calls(page, 'simulator_input')).toHaveLength(0);
  await page.locator('.sim-stage').focus(); await page.keyboard.type('hello');
  await expect.poll(async () => (await calls(page, 'simulator_input')).filter((call: any) => call.args.input.kind === 'type').length).toBe(1);
  await page.locator('[data-sim="home"]').focus(); await page.keyboard.press('Enter');
  await expect.poll(async () => (await calls(page, 'simulator_input')).at(-1)?.args.input.button).toBe('home');
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click();
  await expect.poll(async () => (await props(page)).visible).toBe(false);
  await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  expect((await props(page)).device).toBe(before.device);
  expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true);
  expect(await calls(page, 'simulator_select')).toHaveLength(1);
  expect((await props(page)).devices.every((d: any) => !d.name && !d.runtime)).toBe(true);
});
test('simulator: installed selected fixture exposes actions/context/layout and recovers identical nodes on disable/safe mode', async ({ page }) => {
  await setup(page); const node = await page.locator('.sim-stage').elementHandle(), before = await props(page), selections = await calls(page, 'simulator_select');
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.simulator', exact: true }).click();
  await region.getByLabel('Simulator presentation', { exact: true }).selectOption('sample.simulator/controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Home before power', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.simulator.controls');
  await region.getByRole('button', { name: 'Hide Light / dark', exact: true }).click(); await back(page);
  await expect(page.locator('[data-simulator-provider="sample.simulator/controls"]')).toBeVisible();
  expect(await page.locator('.sim-dock').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  await expect(page.locator('[data-sim="appearance"]')).toBeHidden();
  expect(await page.locator('.sim-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sim')))).toEqual(expect.arrayContaining(['home', 'power']));
  const ordered = await page.locator('.sim-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-sim')));
  expect(ordered.indexOf('home')).toBeLessThan(ordered.indexOf('power'));
  await page.getByRole('button', { name: 'Simulator tools', exact: true }).click();
  await page.locator('.sim-device').focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Simulator tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.sim-device')).toBeFocused();
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.simulator', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-simulator-provider]')).toHaveCount(0); await expect(page.locator('[data-sim="appearance"]')).toBeVisible();
  expect((await props(page)).device).toBe(before.device); expect(await calls(page, 'simulator_select')).toEqual(selections);
  expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true);
  expect(await page.locator('.sim-dock').evaluate(node => getComputedStyle(node).order)).toBe('0');
});
test('simulator: original handlers cover pose/finish/power/navigation/device/reset and explicit clipboard/create policy', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  for (const id of ['home', 'lock', 'appearance', 'reset']) {
    const control = (await props(page)).controls.find((c: any) => c.id === id);
    expect(await action(page, id)).toEqual(control.enabled ? { ok: true } : { ok: false, reason: 'UnsupportedCapability' }); await settled(page);
  }
  const finish = (await props(page)).controls.find((c: any) => c.id === 'finish').values.at(-1);
  expect(await action(page, 'finish', finish)).toEqual({ ok: true }); await settled(page); expect((await props(page)).finish).toBe(finish);
  expect(await action(page, 'capture')).toEqual({ ok: true }); expect(await calls(page, 'simulator_capture')).toHaveLength(0);
  await page.keyboard.press('Escape'); expect(await calls(page, 'simulator_capture')).toHaveLength(0);
  expect(await action(page, 'capture')).toEqual({ ok: true }); await page.getByRole('menuitemradio', { name: 'Write to clipboard', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'simulator_capture')).length).toBe(1); await settled(page);
  expect(await page.evaluate(() => (window as any).__clipboardWrites.length)).toBe(1);
  expect(await action(page, 'add-duo')).toEqual({ ok: true }); expect(await calls(page, 'simulator_create_duo')).toHaveLength(0);
  await page.getByRole('menuitemradio', { name: 'Create iPhone Duo simulator', exact: true }).click(); await settled(page);
  await expect.poll(async () => (await props(page)).devices.some((d: any) => d.name === 'iPhone Duo')).toBe(true);
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  expect(await action(page, 'pose', 'book')).toEqual({ ok: true }); await settled(page); expect((await props(page)).pose).toBe('book');
  const android = (await props(page)).devices.find((d: any) => d.platform === 'android');
  expect(await action(page, 'device', android.id)).toEqual({ ok: true }); await settled(page);
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  for (const id of ['back', 'recents', 'home', 'lock']) { expect(await action(page, id)).toEqual({ ok: true }); await settled(page); }
  for (const id of ['back', 'recents', 'home', 'lock']) expect((await calls(page, 'simulator_input')).some((call: any) => call.args.input.button === id)).toBe(true);
  expect(await calls(page, 'simulator_pose')).toHaveLength(1); expect(await calls(page, 'simulator_create_duo')).toHaveLength(1);
});
test('simulator: AXe/setup effects need a real user choice and platform paths explain unsupported capabilities', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.simulatorStatus = { axe: false, android: false }; });
  // Original host refresh, not package-owned fake status or native device evidence.
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await expect(page.locator('.sim-axe')).toBeVisible();
  expect(await action(page, 'copy-axe')).toEqual({ ok: true }); expect(await page.evaluate(() => (window as any).__clipboardWrites.length)).toBe(0);
  await page.getByRole('menuitemradio', { name: 'Write to clipboard', exact: true }).click(); await settled(page);
  expect(await page.evaluate(() => (window as any).__clipboardWrites[0])).toContain('brew install');
  expect(await action(page, 'android-setup')).toEqual({ ok: true }); expect(await calls(page, 'android_setup')).toHaveLength(0);
  await page.keyboard.press('Escape'); expect(await calls(page, 'android_setup')).toHaveLength(0);
  expect(await action(page, 'android-setup')).toEqual({ ok: true }); await page.getByRole('menuitemradio', { name: 'Download Android tools (about 2 GB)', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'android_setup')).length).toBe(1); await settled(page);
});
test('simulator: Android-only paths have real platform reasons rather than missing implementation', async ({ page }) => {
  await setup(page, [manifest], 'Win32'); await select(page);
  const p = await props(page); expect(p.platform).toBe('android');
  expect(p.devices.every((d: any) => d.platform === 'android')).toBe(true);
  for (const id of ['add-duo', 'android-setup', 'copy-axe', 'pose']) {
    expect(p.controls.find((c: any) => c.id === id).reason).not.toBe(''); expect(await action(page, id)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  }
  expect(p.controls.find((c: any) => c.id === 'android-setup').reason).toContain('Android Studio');
});
test('simulator: busy/stale/foreign/replay/fault/conflict recovery never duplicates operations or retargets tasks', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.simulator'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.simulator/controls' }] };
  const future = structuredClone(other); future.id = 'future.simulator'; future.contributes.components[0].id = 'future.simulator/controls'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]);
  const region = await explorer(page); await expect(region.getByLabel('Simulator presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.simulator/controls"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Simulator presentation', { exact: true }).selectOption('sample.simulator/controls'); await back(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'simulator_input'; });
  expect(await action(page, 'home')).toEqual({ ok: true }); expect(await action(page, 'home')).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  expect(await calls(page, 'simulator_input')).toHaveLength(1);
  expect(await action(page, 'execute')).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await action(page, 'home')).toEqual({ ok: true }); await settled(page);
  await page.evaluate(() => { (window as any).__staleSimulator = (window as any).__capturedSimulator; });
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await page.evaluate(() => (window as any).__previewSimulatorAction((window as any).__staleSimulator))).toEqual({ ok: false, reason: 'StaleContext' });
  if (!(await page.locator('#simulator-panel').isVisible())) { await openInspectorTab(page, 'tab-simulator'); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click(); }
  const before = await props(page), node = await page.locator('.sim-stage').elementHandle(); await page.locator('.sim-stage').focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applySimulatorPresentation(document.querySelector('#simulator-panel'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-simulator-presentation-status]')).toContainText('Built-in simulator remains active'); await expect(page.locator('.sim-stage')).toBeFocused();
  expect(await action(page, 'home')).toEqual({ ok: false, reason: 'Revoked' }); expect((await props(page)).device).toBe(before.device); expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true);
});
test('simulator: status error recovery and disable during pending input or consent preserve original controller', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const before = await props(page), node = await page.locator('.sim-stage').elementHandle();
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'simulator_status'; });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await expect(page.locator('.sim-status')).toContainText('Baseline rejected simulator_status');
  expect(await action(page, 'home')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click(); await expect(page.locator('.sim-status')).toBeHidden();
  expect(await action(page, 'capture')).toEqual({ ok: true }); await expect(page.getByRole('menu', { name: 'Allow Simulator action?', exact: true })).toBeVisible();
  // Hiding the host revokes pending user consent and closes its owned menu.
  await page.locator('.inspector-tabs [data-action="tab-changes"]').evaluate(node => (node as HTMLElement).click());
  await expect(page.getByRole('menu', { name: 'Allow Simulator action?', exact: true })).toHaveCount(0);
  await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.simulator', exact: true }).click(); await back(page);
  expect(await action(page, 'capture')).toEqual({ ok: false, reason: 'Revoked' }); expect(await calls(page, 'simulator_capture')).toHaveLength(0);
  await explorer(page); await page.getByRole('button', { name: 'Enable sample.simulator', exact: true }).click(); await back(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'simulator_input'; });
  expect(await action(page, 'home')).toEqual({ ok: true });
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.simulator', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  expect(await calls(page, 'simulator_input')).toHaveLength(1); expect((await props(page)).device).toBe(before.device); expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true);
});
for (const [index, controls] of [
  { appearance: 'Light / dark', back: 'Back', capture: 'Copy screenshot' },
  { 'copy-axe': 'Copy AXe install command', device: 'Choose simulator', finish: 'Device finish', home: 'Home', lock: 'Lock' },
  { pose: 'Device pose', power: 'Boot / shut down', recents: 'Recent apps', reset: 'Face forward' },
].entries()) test(`simulator: discovered control visibility page ${index + 1} is reversible without remount`, async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.simulatorStatus = { axe: false, android: false }; });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await expect(page.locator('.sim-axe')).toBeVisible();
  const before = await props(page), node = await page.locator('.sim-stage').elementHandle(), region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.simulator.controls');
  for (let pageIndex = 0; pageIndex < index; pageIndex++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  for (const [id, label] of Object.entries(controls)) {
    await region.getByRole('button', { name: `Hide ${label}`, exact: true }).click();
    await expect(page.locator(`[data-sim="${id}"]`)).toHaveAttribute('data-layout-hidden', '');
    await region.getByRole('button', { name: `Show ${label}`, exact: true }).click();
    await expect(page.locator(`[data-sim="${id}"]`)).not.toHaveAttribute('data-layout-hidden', '');
  }
  await back(page);
  expect((await props(page)).device).toBe(before.device); expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true); expect(await calls(page, 'simulator_select')).toHaveLength(1);
});
test('simulator: setup and Add Duo visibility retain compatible original device-menu anchors', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.simulatorStatus = { axe: false, android: false }; });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-simulator"]').click();
  await expect(page.locator('.sim-axe')).toBeVisible();
  const before = await props(page), node = await page.locator('.sim-stage').elementHandle(), region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.simulator.controls');
  for (const label of ['Add iPhone Duo', 'Set up Android emulator']) await region.getByRole('button', { name: `Hide ${label}`, exact: true }).click();
  await back(page); await page.locator('.sim-device').click();
  await expect(page.getByRole('menuitemradio', { name: /Add iPhone Duo|Set up Android emulator/ })).toHaveCount(0); await page.keyboard.press('Escape');
  await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.simulator.controls');
  for (const label of ['Add iPhone Duo', 'Set up Android emulator']) await region.getByRole('button', { name: `Show ${label}`, exact: true }).click();
  await back(page); await page.locator('.sim-device').click();
  await expect(page.getByRole('menuitemradio', { name: /Add iPhone Duo/ })).toBeVisible(); await expect(page.getByRole('menuitemradio', { name: /Set up Android emulator/ })).toBeVisible(); await page.keyboard.press('Escape');
  expect((await props(page)).device).toBe(before.device); expect(await node!.evaluate(node => node === document.querySelector('.sim-stage'))).toBe(true); expect(await calls(page, 'simulator_select')).toHaveLength(1);
});
test('simulator: an original pending device selection rejects competing public operations', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'simulator_select'; });
  await page.locator('.sim-device').click(); await page.getByRole('menuitemradio', { name: /iPad Air 11-inch/ }).click();
  await expect.poll(async () => (await props(page)).busy).toBe(true);
  expect(await action(page, 'home')).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  await expect(page.locator('.sim-device-name')).toHaveText('iPad Air 11-inch (M3)');
  expect(await calls(page, 'simulator_select')).toHaveLength(2); expect(await calls(page, 'simulator_input')).toHaveLength(0);
});
