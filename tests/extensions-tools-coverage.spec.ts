import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';

// Only public JSON manifests enter packages. DOM probes/fault injection are host
// preview instrumentation, not package APIs or installed device qualification.
const manifests = ['simulator', 'vm', 'design', 'btw'].map(name => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8')));
const laboratory = JSON.parse(readFileSync(new URL('./fixtures/extensions/view-laboratory/extension.json', import.meta.url), 'utf8'));
const choices = [['Simulator', 'sample.simulator/controls'], ['VM', 'sample.vm/controls'], ['Design', 'sample.design/comments'], ['BTW', 'sample.btw/conversation']] as const;
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.addInitScript(packages => {
    if (window !== window.top) return;
    Object.defineProperty(navigator, 'platform', { value: 'MacIntel' });
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&simulator-coverage&vm-coverage&design-coverage&btw-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(() => { (window as any).__mainId = document.querySelector<HTMLTextAreaElement>('#prompt')!.dataset.sessionId; });
}
async function view(page: Page, name: string) {
  if (!(await page.locator('#inspector').isVisible())) await page.locator('#inspector-toggle').click();
  const id = `tab-${name.toLowerCase()}`;
  if (name !== 'BTW') await openInspectorTab(page, id);
  await page.locator(`.inspector-tabs [data-action="${id}"]`).click();
  if (name === 'Simulator' || name === 'VM' || name === 'Design') await expect.poll(() => page.evaluate(name => (window as any)[`__preview${name === 'VM' ? 'Vm' : name}`]()?.loading, name)).toBe(false);
}
async function side(page: Page) {
  await page.locator('#prompt').fill('Main keeps working'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.locator('#prompt').fill('/btw captured side'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('.btw-transcript .agent-message')).toHaveCount(1);
}
async function explorer(page: Page) {
  // The VM stage deliberately owns keyboard input. Settings starts at host input.
  await page.locator('#prompt').focus(); await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function selectAll(page: Page) {
  const region = await explorer(page);
  for (const [label, id] of choices) await region.getByLabel(`${label} presentation`, { exact: true }).selectOption(id);
  await back(page);
}

test('extensions tools: zero extensions retain four original hosts and independent side operations', async ({ page }) => {
  await setup(page);
  await view(page, 'Simulator'); await expect(page.locator('.sim-device-name')).toHaveText('iPhone 17 Pro');
  await page.locator('[data-sim="home"]').click(); await expect.poll(() => calls(page, 'simulator_input').then(c => c.length)).toBe(1);
  await view(page, 'VM'); await expect(page.locator('.vm-screen')).toBeVisible();
  await page.locator('.vm-stage').focus(); await page.keyboard.type('vm only');
  await expect.poll(() => calls(page, 'vm_input').then(c => c.length)).toBe(1);
  await view(page, 'Design'); await expect(page.locator('.design-board iframe')).toHaveCount(2);
  await page.locator('[data-design="in"]').click();
  await side(page);
  await expect(page.locator('[data-simulator-provider],[data-vm-provider],[data-design-provider],[data-btw-provider]')).toHaveCount(0);
  const sent = await calls(page, 'send_message'); expect(sent).toHaveLength(2);
  expect(sent[0].args.sessionId).not.toBe(sent[1].args.sessionId);
  expect(await calls(page, 'design_save_comments')).toHaveLength(0);
});

test('extensions tools: all selected together preserve captured devices, Design edits and BTW queue across disable and safe recovery', async ({ page }) => {
  await setup(page, manifests.slice(0, 3)); await side(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.btw', exact: true }).click();
  for (const [label, id] of choices) { await expect(region.getByLabel(`${label} presentation`, { exact: true })).toHaveValue(''); await region.getByLabel(`${label} presentation`, { exact: true }).selectOption(id); }
  await back(page);
  const sent = await calls(page, 'send_message'), main = sent[0].args.sessionId, sideId = sent[1].args.sessionId;
  await page.getByRole('button', { name: 'Allow side-task control for sample.btw', exact: true }).click();
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await page.locator('.btw-input').fill('Run side'); await page.locator('.btw-input').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  await page.locator('.btw-input').fill('Queued side'); await page.locator('.btw-input').press('Enter');
  await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1);
  await page.locator('.btw-input').pressSequentially('Side draft survives');
  const editor = await page.locator('.btw-input').elementHandle();
  await page.locator('#prompt').fill('Main draft survives');
  await view(page, 'Simulator');
  const stage = await page.locator('.sim-stage').elementHandle(), simulator = await page.evaluate(() => (window as any).__previewSimulator());
  await expect(page.locator('[data-simulator-provider="sample.simulator/controls"]')).toBeVisible();
  await page.locator('.sim-stage').focus(); await page.keyboard.type('old device');
  await page.locator('.sim-device').click(); await page.getByRole('menuitemradio', { name: /iPad Air 11-inch/ }).click();
  await expect(page.locator('.sim-device-name')).toContainText('iPad Air');
  expect((await calls(page, 'simulator_input'))[0].args.udid).toBe((await calls(page, 'simulator_select'))[0].args.udid);
  const selectedDevice = await page.evaluate(() => (window as any).__previewSimulator().device);
  expect(selectedDevice).not.toBe(simulator.device);
  await view(page, 'VM'); const canvas = await page.locator('.vm-screen').elementHandle();
  await expect(page.locator('[data-vm-provider="sample.vm/controls"]')).toBeVisible();
  await page.locator('.vm-stage').focus(); await page.keyboard.type('old machine');
  await page.locator('.vm-select').click(); await page.getByRole('menuitemradio', { name: 'preview-linux', exact: true }).click();
  await expect(page.locator('.vm-name')).toHaveText('preview-linux');
  expect((await calls(page, 'vm_input'))[0].args.name).toBe('preview-macos');
  const vm = await page.evaluate(() => (window as any).__previewVm());
  await view(page, 'Design'); await expect(page.locator('[data-design-provider="sample.design/comments"]')).toBeVisible();
  await expect(page.frameLocator('iframe[title="home.html"]').getByRole('heading', { name: 'Ship calmer releases' })).toBeAttached();
  await page.locator('[data-design="comment"]').click();
  expect(await page.evaluate(() => {
    const p = (window as any).__previewDesign(), b = p.artboards[0];
    const a = { contractVersion: 1, context: p.context, project: p.project, session: p.session, revision: p.revision, selection: p.selection, artboard: b.id, comment: '', resourceRevision: b.revision, controlId: 'select', value: '', x: 50, y: 150, requestId: crypto.randomUUID() };
    return (window as any).__previewDesignAction(a);
  })).toEqual({ ok: true });
  await page.locator('#design-comment-text').fill('Captured integrated comment');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'design_save_comments'; });
  await page.locator('.design-new [type="submit"]').click();
  await expect.poll(() => calls(page, 'design_save_comments').then(c => c.length)).toBe(1);
  await page.locator('#design-comment-text').fill('Newer Design draft');
  const draft = await page.locator('#design-comment-text').elementHandle();
  const frame = await page.locator('iframe[title="home.html"]').elementHandle();
  await page.locator('iframe[title="home.html"]').evaluate((f: HTMLIFrameElement) => { (window as any).__toolsFrameDocument = f.contentDocument; });
  const before = await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((c: any) => ['simulator_select', 'simulator_input', 'vm_show', 'vm_input', 'vm_power', 'cloud_power', 'design_save_comments', 'send_message', 'queue_add', 'stop_session'].includes(c.command)));
  await explorer(page);
  for (const owner of ['sample.simulator', 'sample.vm', 'sample.design', 'sample.btw']) await page.getByRole('button', { name: `Disable ${owner}`, exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(() => page.evaluate(() => (window as any).__previewDesign().busy)).toBe(false);
  await expect(page.locator('#design-comment-text')).toHaveValue('Newer Design draft');
  expect(await draft!.evaluate(n => n === document.querySelector('#design-comment-text'))).toBe(true);
  expect(await frame!.evaluate((f: HTMLIFrameElement) => f.contentDocument === (window as any).__toolsFrameDocument)).toBe(true);
  await view(page, 'Simulator'); expect(await page.evaluate(() => (window as any).__previewSimulator().device)).toBe(selectedDevice);
  expect(await stage!.evaluate(n => n === document.querySelector('.sim-stage'))).toBe(true);
  await view(page, 'VM'); expect((await page.evaluate(() => (window as any).__previewVm())).machine).toBe(vm.machine);
  expect(await canvas!.evaluate(n => n === document.querySelector('.vm-screen'))).toBe(true);
  await view(page, 'BTW'); await expect(page.locator('.btw-input')).toHaveValue('Side draft survives');
  expect(await editor!.evaluate(n => n === document.querySelector('.btw-input'))).toBe(true);
  await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1); await expect(page.locator('#prompt')).toHaveValue('Main draft survives');
  await expect(page.locator('[data-simulator-provider],[data-vm-provider],[data-design-provider],[data-btw-provider]')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((c: any) => ['simulator_select', 'simulator_input', 'vm_show', 'vm_input', 'vm_power', 'cloud_power', 'design_save_comments', 'send_message', 'queue_add', 'stop_session'].includes(c.command)))).toEqual(before);
  expect((await calls(page, 'design_save_comments'))[0].args.sessionId).toBe(main);
  expect((await calls(page, 'queue_add'))[0].args.sessionId).toBe(sideId);
  await page.getByRole('button', { name: 'Stop side thread', exact: true }).click();
  await expect.poll(() => calls(page, 'stop_session').then(c => c.map((c: any) => c.args.sessionId))).toEqual([sideId]);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

test('extensions tools: simultaneous conflicts and presentation faults keep built-ins and other providers usable', async ({ page }) => {
  const rivals = manifests.map(m => ({ ...m, id: `other.${m.id.split('.')[1]}`, contributes: { components: [{ ...m.contributes.components[0], id: m.contributes.components[0].id.replace('sample.', 'other.') }] } }));
  await setup(page, [...manifests, ...rivals]); await side(page);
  const region = await explorer(page);
  for (const [label] of choices) await expect(region.getByLabel(`${label} presentation`, { exact: true })).toHaveValue('');
  await back(page); await selectAll(page);
  await page.locator('.btw-input').fill('Fault draft');
  for (const [name, fn, root, marker] of [['Simulator', 'applySimulatorPresentation', '#simulator-panel', 'simulator'], ['VM', 'applyVmPresentation', '#vm-panel', 'vm'], ['Design', 'applyDesignPresentation', '#design-panel', 'design'], ['BTW', 'applyBtwPresentation', '.btw-panel', 'btw']]) {
    await view(page, name);
    await page.evaluate(async ({ fn, root }) => { const api = await (window as any).__previewReplacementModules(); api[fn](document.querySelector(root), () => { throw Error('integrated controlled fault'); }); }, { fn, root });
    await expect(page.locator(`[data-${marker}-presentation-status]`)).toContainText('Built-in');
  }
  await expect(page.locator('.btw-input')).toHaveValue('Fault draft');
  expect(await calls(page, 'send_message')).toHaveLength(2); expect(await calls(page, 'design_save_comments')).toHaveLength(0);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});

for (const [name, location] of [['Simulator', 'panda.simulator.actions'], ['VM', 'panda.vm.actions'], ['Design', 'panda.design.actions'], ['BTW', 'panda.btw.header']]) {
  test(`extensions tools: ${name} shares public command/icon/nested-menu/dialog/select and disposal contracts`, async ({ page }) => {
    const manifest = structuredClone(laboratory); manifest.contributes.menus = [{ ...manifest.contributes.menus[0], location }];
    await setup(page, [manifest]);
    await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
    if (name === 'BTW') await side(page); else await view(page, name);
    const trigger = page.getByRole('button', { name: 'View laboratory', exact: true });
    await expect(trigger.locator('svg rect')).toHaveCount(1); await trigger.click();
    const tools = page.getByRole('menuitem', { name: 'Object tools', exact: true });
    await expect(tools.locator('svg rect')).toHaveCount(1); await tools.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Choose object options', exact: true }).press('Enter');
    await expect(page.getByRole('dialog')).toHaveAccessibleName('Clicked object — sample.view-laboratory');
    await page.getByRole('button', { name: 'Object options', exact: true }).click();
    await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
    const captured = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
    expect(captured).toHaveLength(1); expect(captured[0].context).toMatchObject({ surfaceId: location, projectId: 'project-1' });
    const expectedSession = name === 'BTW' ? (await calls(page, 'send_message'))[1].args.sessionId : 'session-1';
    expect(captured[0].context.sessionId).toBe(expectedSession);
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(trigger).toBeFocused();
    await explorer(page); await page.getByRole('button', { name: 'Disable sample.view-laboratory', exact: true }).click(); await back(page);
    await expect(trigger).toHaveCount(0);
    expect(await calls(page, 'design_save_comments')).toHaveLength(0); expect(await calls(page, 'vm_power')).toHaveLength(0);
  });
}
