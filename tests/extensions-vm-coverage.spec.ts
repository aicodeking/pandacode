import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/vm/extension.json', import.meta.url), 'utf8'));
const props = (page: Page) => page.evaluate(() => (window as any).__previewVm());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = [], empty = false) {
  await page.addInitScript(packages => {
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto(`/?extensions-baseline&vm-coverage&replacement${empty ? '&vm-empty' : ''}`);
  await expect(page.locator('#prompt')).toBeEnabled();
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  await openInspectorTab(page, 'tab-vm'); await page.locator('.inspector-tabs [data-action="tab-vm"]').click();
  await expect.poll(async () => (await props(page))?.loading).toBe(false);
}
async function explorer(page: Page) { await page.locator('.vm-select').focus(); await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('VM presentation', { exact: true }).selectOption('sample.vm/controls'); await back(page); }
async function action(page: Page, controlId: string, value = '') {
  return page.evaluate(({ controlId, value }) => {
    const p = (window as any).__previewVm();
    const a = { contractVersion: 1, context: p.context, project: p.project, session: p.session, machine: p.machine, connection: p.connection, platform: p.platform, revision: p.revision, controlId, value, requestId: crypto.randomUUID() };
    (window as any).__capturedVm = a; return (window as any).__previewVmAction(a);
  }, { controlId, value });
}
const settled = async (page: Page) => expect.poll(async () => (await props(page)).busy).toBe(false);
async function refresh(page: Page) { await page.locator('.inspector-tabs [data-action="tab-changes"]').click(); await page.locator('.inspector-tabs [data-action="tab-vm"]').click(); await settled(page); }
test('vm: zero extensions retain original frame, serialized input, selection and IME/focus', async ({ page }) => {
  await setup(page);
  await expect(page.locator('[data-vm-provider]')).toHaveCount(0);
  await expect(page.locator('.vm-name')).toHaveText('preview-macos');
  await expect(page.locator('.vm-screen')).toBeVisible();
  const node = await page.locator('.vm-stage').elementHandle(), before = await props(page);
  expect(before.machines.every((m: any) => !m.name && !m.detail)).toBe(true);
  await page.locator('.vm-stage').focus();
  await page.locator('.vm-stage').evaluate(node => node.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true })));
  expect(await calls(page, 'vm_input')).toHaveLength(0);
  await page.keyboard.type('hello'); await expect.poll(async () => (await calls(page, 'vm_input')).length).toBe(1);
  expect((await calls(page, 'vm_input'))[0].args).toEqual({ name: 'preview-macos', input: { action: 'type', text: 'hello' } });
  await refresh(page); expect((await props(page)).machine).toBe(before.machine);
  expect(await node!.evaluate(node => node === document.querySelector('.vm-stage'))).toBe(true);
  expect(await calls(page, 'vm_show')).toHaveLength(0);
});
test('vm: install, selected recipe, actions/context/layout and safe recovery preserve original nodes', async ({ page }) => {
  await setup(page); const node = await page.locator('.vm-screen').elementHandle(), before = await props(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.vm', exact: true }).click();
  await region.getByLabel('VM presentation', { exact: true }).selectOption('sample.vm/controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Share before power', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.vm.controls');
  await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await region.getByRole('button', { name: 'Hide Share project read-only', exact: true }).click(); await back(page);
  await expect(page.locator('[data-vm-provider="sample.vm/controls"]')).toBeVisible();
  expect(await page.locator('.vm-dock').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  await expect(page.locator('[data-vm="share"]')).toBeHidden();
  const ordered = await page.locator('.vm-actions > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-vm')));
  expect(ordered.indexOf('share')).toBeLessThan(ordered.indexOf('power'));
  await page.getByRole('button', { name: 'VM tools', exact: true }).click();
  await page.locator('.vm-select').focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'VM tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape'); await expect(page.locator('.vm-select')).toBeFocused();
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.vm', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(page.locator('[data-vm-provider]')).toHaveCount(0); await expect(page.locator('[data-vm="share"]')).toBeVisible();
  expect((await props(page)).machine).toBe(before.machine); expect(await node!.evaluate(node => node === document.querySelector('.vm-screen'))).toBe(true);
  expect(await calls(page, 'vm_power')).toHaveLength(0); expect(await calls(page, 'vm_create')).toHaveLength(0);
});
test('vm: local/cloud select, power, suspend, desktop and input use original handlers and policy', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  expect(await action(page, 'input')).toEqual({ ok: true }); await expect(page.locator('.vm-stage')).toBeFocused();
  expect(await action(page, 'suspend')).toEqual({ ok: true }); await settled(page);
  expect((await calls(page, 'vm_power')).at(-1).args.action).toBe('suspend');
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  const linux = (await props(page)).machines.find((m: any) => m.name === 'preview-linux');
  expect(await action(page, 'select', linux.id)).toEqual({ ok: true }); await settled(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.vmStatus = { vms: [{ name: 'preview-linux', running: true, attached: true, os: 'linux', memoryMb: 2048, cpus: 2, sizeGb: 5, desktop: 'failed' }] }; });
  await refresh(page); await expect(page.locator('[data-vm="desktop"]')).toBeVisible();
  expect(await action(page, 'desktop')).toEqual({ ok: true }); await settled(page); expect(await calls(page, 'vm_desktop')).toHaveLength(1);
  expect(await action(page, 'suspend')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const cloud = (await props(page)).machines.find((m: any) => m.platform === 'cloud');
  expect(await action(page, 'select', cloud.id)).toEqual({ ok: true }); await settled(page);
  // Remove the synthetic local override so the host follows its real selected cloud ID.
  await page.evaluate(() => { delete (window as any).__extensionsBaseline.vmStatus; }); await refresh(page);
  expect((await props(page)).platform).toBe('cloud');
  expect(await action(page, 'share')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await action(page, 'suspend')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  expect((await calls(page, 'cloud_power')).at(-1).args).toEqual({ id: 'daytona:preview-cloud', action: 'stop' });
});
test('vm: setup/create/delete/share cannot provision or escalate without host user choice', async ({ page }) => {
  await setup(page, [manifest], true); await select(page);
  expect(await action(page, 'setup')).toEqual({ ok: true }); expect(await calls(page, 'vm_setup')).toHaveLength(0);
  await page.keyboard.press('Escape'); expect(await calls(page, 'vm_setup')).toHaveLength(0);
  expect(await action(page, 'setup')).toEqual({ ok: true }); await page.getByRole('menuitemradio', { name: 'Download and verify Tart', exact: true }).click(); await settled(page);
  expect(await calls(page, 'vm_setup')).toHaveLength(1);
  expect(await action(page, 'new')).toEqual({ ok: true }); expect(await calls(page, 'vm_create')).toHaveLength(0);
  await page.getByRole('menuitemradio', { name: 'Choose a new machine', exact: true }).click();
  await page.getByRole('menuitemradio', { name: /Ubuntu 24.04/ }).click(); await settled(page);
  expect(await calls(page, 'vm_create')).toHaveLength(1);
  const before = await props(page); expect(before.share).toBe(false);
  expect(await action(page, 'share')).toEqual({ ok: true }); expect((await props(page)).share).toBe(false);
  await page.getByRole('menuitemradio', { name: 'Change read-only share preference', exact: true }).click(); expect((await props(page)).share).toBe(true);
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page); expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  expect(typeof (await calls(page, 'vm_power')).at(-1).args.share).toBe('string');
  expect(await action(page, 'delete')).toEqual({ ok: true }); expect((await calls(page, 'vm_power')).some((c: any) => c.args.action === 'delete')).toBe(false);
  await page.getByRole('menuitemradio', { name: 'Delete selected machine', exact: true }).click(); await settled(page);
  expect((await calls(page, 'vm_power')).filter((c: any) => c.args.action === 'delete')).toHaveLength(1);
});
test('vm: busy/stale/replay/malformed/conflict/fault and pending disable do not duplicate or retarget', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.vm'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.vm/controls' }] };
  const future = structuredClone(other); future.id = 'future.vm'; future.contributes.components[0].id = 'future.vm/controls'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('VM presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.vm/controls"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('VM presentation', { exact: true }).selectOption('sample.vm/controls'); await back(page);
  const before = await props(page), node = await page.locator('.vm-stage').elementHandle();
  expect(await action(page, 'input')).toEqual({ ok: true });
  expect(await page.evaluate(() => (window as any).__previewVmAction((window as any).__capturedVm))).toEqual({ ok: false, reason: 'AlreadyApplied' });
  expect(await action(page, 'execute')).toEqual({ ok: false, reason: 'InvalidArguments' });
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'vm_power'; });
  expect(await action(page, 'power')).toEqual({ ok: true }); expect(await action(page, 'power')).toEqual({ ok: false, reason: 'Busy' });
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.vm', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand()); await settled(page);
  expect(await calls(page, 'vm_power')).toHaveLength(1); expect((await props(page)).machine).toBe(before.machine);
  expect(await node!.evaluate(node => node === document.querySelector('.vm-stage'))).toBe(true);
  await explorer(page); await page.getByRole('button', { name: 'Enable sample.vm', exact: true }).click(); await back(page);
  expect(await action(page, 'input')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await action(page, 'power')).toEqual({ ok: true }); await settled(page);
  expect(await action(page, 'input')).toEqual({ ok: true }); await page.evaluate(() => { (window as any).__staleVm = (window as any).__capturedVm; });
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await page.evaluate(() => (window as any).__previewVmAction((window as any).__staleVm))).toEqual({ ok: false, reason: 'StaleContext' });
  if (!(await page.locator('#vm-panel').isVisible())) { await openInspectorTab(page, 'tab-vm'); await page.locator('.inspector-tabs [data-action="tab-vm"]').click(); }
  await page.locator('.vm-stage').focus();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyVmPresentation(document.querySelector('#vm-panel'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-vm-presentation-status]')).toContainText('Built-in VM remains active'); await expect(page.locator('.vm-stage')).toBeFocused();
  expect(await action(page, 'power')).toEqual({ ok: false, reason: 'Revoked' });
});
test('vm: offline status recovery and hiding pending consent preserve the machine/controller', async ({ page }) => {
  await setup(page, [manifest]); await select(page); const before = await props(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.failOnce = 'vm_status'; }); await refresh(page);
  await expect(page.locator('.vm-status')).toContainText('Baseline rejected vm_status');
  expect((await props(page)).machine).toBe(before.machine);
  expect(await action(page, 'delete')).toEqual({ ok: true });
  await page.locator('.inspector-tabs [data-action="tab-changes"]').evaluate(node => (node as HTMLElement).click());
  await expect(page.getByRole('menu', { name: 'Allow VM action?', exact: true })).toHaveCount(0);
  expect((await calls(page, 'vm_power')).some((c: any) => c.args.action === 'delete')).toBe(false);
  await page.locator('.inspector-tabs [data-action="tab-vm"]').click(); expect((await props(page)).machine).toBe(before.machine);
  await expect(page.locator('.vm-status')).toBeHidden();
});
test('vm: unsupported local policy is explicit and never broadens the original platform gate', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.vmStatus = { supported: false }; }); await refresh(page);
  for (const control of ['setup', 'power', 'desktop', 'suspend', 'input', 'delete']) {
    expect((await props(page)).controls.find((c: any) => c.id === control).reason).toContain('Apple silicon');
    expect(await action(page, control)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  }
  expect(await calls(page, 'vm_power')).toHaveLength(0); expect(await calls(page, 'vm_setup')).toHaveLength(0);
});
test('vm: pending original input survives disable exactly once and cloud provisioning needs host choices', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const before = await props(page), node = await page.locator('.vm-screen').elementHandle();
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'vm_input'; });
  await page.locator('.vm-stage').focus(); await page.keyboard.type('abc');
  await expect.poll(async () => (await calls(page, 'vm_input')).length).toBe(1);
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.vm', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await page.locator('.vm-stage').focus(); await page.keyboard.type('def');
  await expect.poll(async () => (await calls(page, 'vm_input')).length).toBe(2);
  expect((await calls(page, 'vm_input')).map((c: any) => c.args)).toEqual([{ name: 'preview-macos', input: { action: 'type', text: 'abc' } }, { name: 'preview-macos', input: { action: 'type', text: 'def' } }]);
  expect((await props(page)).machine).toBe(before.machine); expect(await node!.evaluate(node => node === document.querySelector('.vm-screen'))).toBe(true);
  await explorer(page); await page.getByRole('button', { name: 'Enable sample.vm', exact: true }).click(); await back(page);
  expect(await action(page, 'new')).toEqual({ ok: true }); expect(await calls(page, 'cloud_create')).toHaveLength(0);
  await page.getByRole('menuitemradio', { name: 'Choose a new machine', exact: true }).click();
  expect(await calls(page, 'cloud_create')).toHaveLength(0);
  await page.getByRole('menuitemradio', { name: /Daytona desktop/ }).click(); await settled(page);
  expect(await calls(page, 'cloud_create')).toHaveLength(1); expect((await props(page)).platform).toBe('cloud');
  expect(await action(page, 'delete')).toEqual({ ok: true }); expect(await calls(page, 'cloud_power')).toHaveLength(0);
  await page.getByRole('menuitemradio', { name: 'Delete selected machine', exact: true }).click(); await settled(page);
  expect((await calls(page, 'cloud_power')).map((c: any) => c.args.action)).toEqual(['delete']);
});
test('vm: every discovered control visibility is reversible without remounting its frame controller', async ({ page }) => {
  await setup(page, [manifest]); await select(page); const before = await props(page), node = await page.locator('.vm-screen').elementHandle(), region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.vm.controls');
  for (const name of ['Delete VM', 'Add a desktop', 'VM input', 'New VM', 'Start / stop VM']) {
    await region.getByRole('button', { name: `Hide ${name}`, exact: true }).click(); await region.getByRole('button', { name: `Show ${name}`, exact: true }).click();
  }
  await region.getByRole('button', { name: 'Next items', exact: true }).click();
  for (const name of ['Choose VM', 'Set up VMs', 'Share project read-only', 'Suspend VM']) {
    await region.getByRole('button', { name: `Hide ${name}`, exact: true }).click(); await region.getByRole('button', { name: `Show ${name}`, exact: true }).click();
  }
  await back(page); expect((await props(page)).machine).toBe(before.machine); expect(await node!.evaluate(node => node === document.querySelector('.vm-screen'))).toBe(true);
});
