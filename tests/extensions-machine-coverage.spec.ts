import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the account, computers, link requests and threads are the in-memory preview
// mock (src/preview-remote.ts). No relay, real computer, pairing or security setting is involved.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/machines/extension.json', import.meta.url), 'utf8'));
const OPERATIONS = ['remote_start_task', 'remote_repo_check', 'remote_reconnect', 'remote_resubscribe', 'remote_cancel_start', 'orchestration_link_respond', 'orchestration_set_link', 'orchestration_set_enabled', 'remote_set_host_enabled', 'remote_revoke_device', 'stop_session'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewMachines());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const count = (page: Page, names: string[]) => page.evaluate(names => (window as any).__extensionsBaseline.calls.filter((call: any) => names.includes(call.command)).length, names);
const slot = (page: Page) => page.locator('#composer-area #machine-orchestration');
const card = (page: Page) => slot(page).locator('.machine-link-card');
const computer = (page: Page) => page.locator('#composer-area #composer-computer');
const runOn = (page: Page) => page.getByRole('menu', { name: 'Run on' });
const linkDialog = (page: Page) => page.getByRole('dialog', { name: 'Link a machine' });
const prompt = (page: Page) => page.locator('#prompt');
const taskId = async (page: Page) => (await prompt(page).getAttribute('data-session-id'))!;
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&machines-coverage&replacement'); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => (await props(page))?.signedIn).toBe(true);
  await page.waitForFunction(() => typeof (window as any).__machineLinkRequest === 'function' && typeof (window as any).__remoteOnline === 'function');
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page, id = 'sample.machines/coordination-below') { const region = await explorer(page); await region.getByLabel('Machine presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator(`#machine-orchestration[data-machines-provider="${id}"]`)).toHaveCount(1); }
async function newTask(page: Page) { await page.locator('.new-task-button').click(); await expect.poll(async () => (await props(page)).mode).toBe('choice'); return taskId(page); }
async function openTask(page: Page, id: string) { await page.locator(`.task-item[data-id="${id}"]`).click(); await expect(prompt(page)).toHaveAttribute('data-session-id', id); }
/** Builds a captured action from the live presentation. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, index = 0) {
  return page.evaluate(({ controlId, changes, index }) => {
    const p = (window as any).__previewMachines(), control = p.controls.filter((control: any) => control.controlId === controlId)[index];
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, host: p.host, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, index });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewMachinesAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, index = 0) => send(page, await action(page, controlId, changes, index));
/** Host-user machine control consent from the original Run on menu of a New task. */
async function allow(page: Page) {
  await computer(page).click(); await runOn(page).getByRole('menuitemradio', { name: /Allow machine control for sample\.machines/ }).click(); await expect(runOn(page)).toHaveCount(0);
}
async function choose(page: Page, name: string) { await computer(page).click(); await runOn(page).getByRole('menuitemradio', { name, exact: true }).click(); await expect(computer(page)).toHaveAccessibleName(`Computer: ${name}`); }
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
const linkRequest = (page: Page, sessionId: string) => page.evaluate(id => (window as any).__machineLinkRequest(id, null, 'Run the GPU suite there') as string, sessionId);

test('Machines extension: discovery/install/enable never touches a computer; the selected coordination-below recipe uses original handlers', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.machines', exact: true }).click();
  await expect(region.getByLabel('Machine presentation', { exact: true })).toHaveValue(''); await region.getByLabel('Machine presentation', { exact: true }).selectOption('sample.machines/coordination-below'); await back(page);
  expect(await count(page, OPERATIONS)).toBe(0);
  const id = await taskId(page); await linkRequest(page, id); await expect(card(page)).toBeVisible();
  await expect(slot(page)).toHaveCSS('order', '1'); await expect(page.locator('#composer-area')).toHaveCSS('display', 'flex');
  const [slotBox, composerBox] = await Promise.all([slot(page).boundingBox(), page.locator('#composer').boundingBox()]);
  expect(slotBox!.y).toBeGreaterThan(composerBox!.y);
  const p = await props(page);
  expect(p).toMatchObject({ mode: 'none', visible: true, busy: false, pending: 'none', linking: false, signedIn: true, orchestration: true, requests: 1, host: '' });
  expect(JSON.stringify(p)).not.toMatch(/dev-studio|Studio iMac|GPU suite/);
  expect(p.controls.map((control: any) => control.controlId)).toEqual(['link-decline', 'link-open']);
  expect(await act(page, 'link-open')).toEqual({ ok: true }); await expect(linkDialog(page)).toBeVisible();
  await expect.poll(async () => (await props(page)).linking).toBe(true); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'link-decline')).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'link-cancel', { controlId: 'link-confirm' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'link-cancel')).toEqual({ ok: true }); await expect(linkDialog(page)).toHaveCount(0);
  await expect(card(page)).toBeVisible(); expect(await count(page, OPERATIONS)).toBe(0);
});

test('Machines extension: zero extensions keep the original Run on and link card, withhold metadata and select nothing', async ({ page }) => {
  await setup(page); await newTask(page);
  expect((await props(page)).label).toBe(''); await expect(page.locator('[data-machines-provider]')).toHaveCount(0);
  expect(await act(page, 'target-device')).toEqual({ ok: false, reason: 'Revoked' });
  await computer(page).click(); await expect(runOn(page).getByRole('menuitemradio', { name: /machine control/ })).toHaveCount(0); await page.keyboard.press('Escape');
  await choose(page, 'Studio iMac'); expect((await props(page)).label).toBe('');
  const id = await taskId(page), request = await linkRequest(page, id);
  await card(page).getByRole('button', { name: 'Not now', exact: true }).click(); await expect(card(page)).toHaveCount(0);
  expect((await calls(page, 'orchestration_link_respond')).map((call: any) => call.args)).toEqual([{ requestId: request }]);
  expect(await count(page, ['remote_start_task', 'orchestration_set_link'])).toBe(0);
});

test('Machines extension: choosing a computer needs consent and a fresh choice; stale, replayed and forged requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await newTask(page);
  let p = await props(page);
  expect(p.controls.map((control: any) => control.controlId)).toEqual(['computer-menu', 'target-local', 'target-device', 'target-device', 'target-device']);
  expect(p.controls.map((control: any) => control.enabled)).toEqual([true, true, true, true, false]); expect(p.host).toBe('');
  expect(await act(page, 'target-device')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  for (const changes of [{ controlId: 'remote-start' }, { controlId: 'pairing' }, { controlId: 'behind-continue' }, { deviceId: 'dev-studio' }, { access: 'full' }, { prompt: 'run' }]) expect(await act(page, 'target-device', changes)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'target-device', {}, 2)).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const request = await action(page, 'target-device');
  expect(await send(page, request)).toEqual({ ok: true }); await proceed(page, 'Run the next message on the chosen computer');
  await expect(computer(page)).toHaveAccessibleName('Computer: Studio iMac');
  p = await props(page); expect(p.host).not.toBe(''); expect(p.label).toBe('Studio iMac');
  expect(await send(page, { ...request, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' });
  // Dismissing the fresh host choice runs nothing.
  expect(await act(page, 'target-local')).toEqual({ ok: true }); await expect(page.getByRole('menuitemradio', { name: 'Continue: Run the next message on this computer', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(computer(page)).toHaveAccessibleName('Computer: Studio iMac');
  expect(await act(page, 'computer-menu')).toEqual({ ok: true }); await expect(runOn(page)).toBeVisible(); await page.keyboard.press('Escape');
  expect(await count(page, OPERATIONS)).toBe(0);
});

test('Machines extension: disconnect and reconnect keep the chosen computer without a start or retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await newTask(page); await allow(page); await choose(page, 'Studio iMac');
  const host = (await props(page)).host;
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', false));
  await expect.poll(async () => (await props(page)).hostOffline).toBe(true);
  await expect(computer(page)).toHaveAccessibleName(/Computer: Studio iMac · Offline/);
  expect(await act(page, 'target-device')).toEqual({ ok: false, reason: 'UnsupportedCapability' }); expect((await props(page)).host).toBe(host);
  await page.evaluate(() => (window as any).__remoteOnline('dev-studio', true));
  await expect.poll(async () => (await props(page)).hostOffline).toBe(false); expect((await props(page)).host).toBe(host);
  await expect(computer(page)).toHaveAccessibleName('Computer: Studio iMac');
  await linkRequest(page, await taskId(page)); await expect(card(page)).toBeVisible();
  await page.context().setOffline(true);
  expect(await act(page, 'link-decline')).toEqual({ ok: false, reason: 'Offline' });
  expect(await act(page, 'computer-menu')).toEqual({ ok: true }); await expect(runOn(page)).toBeVisible(); await page.keyboard.press('Escape');
  await page.context().setOffline(false);
  expect(await count(page, OPERATIONS)).toBe(0);
});

test('Machines extension: a pending start on A is exclusive; switching tasks never retargets it or starts twice', async ({ page }) => {
  await setup(page, [manifest]); await select(page); const id = await newTask(page); await allow(page); await choose(page, 'Studio iMac');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'remote_repo_check'; });
  await prompt(page).fill('Run the slow suite over there'); await prompt(page).press('Enter');
  await expect.poll(async () => (await props(page)).pending).toBe('checking'); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'target-local')).toEqual({ ok: false, reason: 'Busy' });
  const captured = await action(page, 'computer-menu');
  await openTask(page, 'session-1');
  expect(await send(page, captured)).toEqual({ ok: false, reason: 'StaleContext' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(async () => (await calls(page, 'remote_start_task')).length).toBe(1);
  expect((await calls(page, 'remote_start_task'))[0].args).toMatchObject({ sessionId: id, deviceId: 'dev-studio' });
  await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
  await page.waitForTimeout(500); expect(await calls(page, 'remote_start_task')).toHaveLength(1); expect(await count(page, ['stop_session', 'remote_cancel_start'])).toBe(0);
});

test('Machines extension: behind-GitHub keeps its original confirmation; only Cancel acts while open and Continue stays with the user', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await newTask(page); await allow(page); await choose(page, 'Studio iMac');
  await page.evaluate(() => { (window as any).__remoteBehind = { ahead: 2 }; });
  await prompt(page).fill('Ship it there'); await prompt(page).press('Enter');
  const behind = page.getByRole('dialog', { name: 'GitHub is behind this computer' }); await expect(behind).toBeVisible();
  await expect.poll(async () => (await props(page)).behind).toBe(true); expect((await props(page)).busy).toBe(true);
  expect(await act(page, 'target-local')).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'behind-cancel', { controlId: 'behind-continue' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'behind-cancel')).toEqual({ ok: true }); await expect(behind).toHaveCount(0);
  await expect.poll(async () => (await props(page)).behind).toBe(false); expect(await calls(page, 'remote_start_task')).toHaveLength(0);
  await prompt(page).fill('Ship it there'); await prompt(page).press('Enter'); await expect(behind).toBeVisible();
  await behind.getByRole('button', { name: 'Continue', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'remote_start_task')).length).toBe(1);
});

test('Machines extension: Link opens the original dialog; declining needs consent and a fresh choice; the submit and access stay with the user', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await newTask(page); await allow(page);
  await openTask(page, 'session-1');
  const first = await linkRequest(page, 'session-1'); await expect(card(page)).toBeVisible();
  for (const changes of [{ controlId: 'link-confirm' }, { controlId: 'unlink' }, { controlId: 'orchestration' }, { access: 'full' }, { deviceId: 'dev-studio' }]) expect(await act(page, 'link-decline', changes)).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'link-decline')).toEqual({ ok: true }); await proceed(page, 'Decline link request');
  await expect(card(page)).toHaveCount(0);
  expect((await calls(page, 'orchestration_link_respond')).map((call: any) => call.args)).toEqual([{ requestId: first }]);
  const second = await linkRequest(page, 'session-1'); await expect(card(page)).toBeVisible();
  expect(await act(page, 'link-open')).toEqual({ ok: true }); await expect(linkDialog(page)).toBeVisible();
  expect(await count(page, ['orchestration_set_link'])).toBe(0); expect(await calls(page, 'orchestration_link_respond')).toHaveLength(1);
  await linkDialog(page).getByRole('radio', { name: /Studio iMac/ }).check(); await linkDialog(page).getByRole('button', { name: 'Continue' }).click();
  await linkDialog(page).getByRole('button', { name: 'Link', exact: true }).click(); await expect(linkDialog(page)).toHaveCount(0);
  expect((await calls(page, 'orchestration_link_respond')).map((call: any) => call.args)).toEqual([{ requestId: first }, { requestId: second, deviceId: 'dev-studio', access: 'ask' }]);
});

test('Machines extension: lineage open and stop use original handlers; the context menu carries package entries', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await newTask(page); await allow(page);
  const child = await page.evaluate(() => (window as any).__machineChild('session-1', { title: 'GPU suite', launch: true }) as string);
  await openTask(page, 'session-1');
  await expect.poll(async () => (await props(page)).running).toBe(1);
  expect((await props(page)).controls.map((control: any) => control.controlId)).toEqual(['lineage-open', 'lineage-stop', 'stop-all']);
  const wait = slot(page).locator('.lineage-wait'); await expect(wait).toBeVisible();
  await wait.click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Machine', exact: true });
  await expect(menu.getByRole('menuitem', { name: 'Stop all threads', exact: true })).toBeVisible(); await expect(menu.getByRole('menuitem', { name: 'Machine notes', exact: true })).toBeVisible();
  await menu.getByRole('menuitem', { name: 'Machine notes', exact: true }).click(); await expect(page.locator('#toast')).toContainText('Computers, links and access stay with PandaCode');
  expect(await count(page, ['stop_session'])).toBe(0);
  expect(await act(page, 'lineage-stop')).toEqual({ ok: true }); await proceed(page, 'Stop thread');
  await expect.poll(async () => (await calls(page, 'stop_session')).map((call: any) => call.args.sessionId)).toEqual([child]);
  expect(await act(page, 'lineage-open')).toEqual({ ok: true }); await expect(prompt(page)).toHaveAttribute('data-session-id', child);
  expect(await calls(page, 'stop_session')).toHaveLength(1); expect(await count(page, ['remote_start_task', 'orchestration_link_respond'])).toBe(0);
});

test('Machines extension: fault, disable and safe mode keep the open Link dialog and chosen computer; the user links once', async ({ page }) => {
  await setup(page, [manifest]); await select(page); const id = await newTask(page); await choose(page, 'Studio iMac');
  const request = await linkRequest(page, id); await expect(card(page)).toBeVisible();
  expect(await act(page, 'link-open')).toEqual({ ok: true }); await expect(linkDialog(page)).toBeVisible();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyMachinesPresentation(document.querySelector('#machine-orchestration'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'link-cancel')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('#machine-orchestration[data-machines-provider]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.machines'));
  await page.evaluate(() => (window as any).__previewMachinesSafeMode());
  await expect(linkDialog(page)).toBeVisible(); await expect(prompt(page)).toHaveAttribute('data-session-id', id);
  await linkDialog(page).getByRole('radio', { name: /Home NAS/ }).check(); await linkDialog(page).getByRole('button', { name: 'Continue' }).click();
  await linkDialog(page).getByRole('button', { name: 'Link', exact: true }).click(); await expect(linkDialog(page)).toHaveCount(0);
  expect((await calls(page, 'orchestration_link_respond')).map((call: any) => call.args)).toEqual([{ requestId: request, deviceId: 'dev-nas', access: 'ask' }]);
  await expect(computer(page)).toHaveAccessibleName('Computer: Studio iMac'); await expect(slot(page)).toHaveCSS('order', '0');
  expect(await count(page, ['remote_start_task', 'orchestration_set_link'])).toBe(0);
});

test('Machines extension: conflict and future providers never auto-select; forged identity is stale', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.machines'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.machines/coordination-below' }] };
  const future = structuredClone(other); future.id = 'future.machines'; future.contributes.components[0].id = 'future.machines/coordination-below'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Machine presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.machines/coordination-below"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(page.locator('[data-machines-provider]')).toHaveCount(0);
  await select(page, 'other.machines/coordination-below'); await newTask(page); await choose(page, 'Studio iMac');
  // other.machines asks for no connections.summary: the computer name stays withheld.
  expect((await props(page)).label).toBe('');
  for (const field of ['project', 'task', 'host', 'context']) expect(await act(page, 'computer-menu', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'computer-menu', { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await count(page, OPERATIONS)).toBe(0);
});

const runOnLabels = async (page: Page) => { await computer(page).click(); const labels = await runOn(page).getByRole('menuitemradio').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? node.textContent ?? '')); await page.keyboard.press('Escape'); return labels; };
test('Machines extension: compatible Run on order and reversible target and link visibility keep focus and recover in safe mode', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.machines.targets');
  await region.getByRole('button', { name: 'Grant UI customization and select Other computers first', exact: true }).click();
  await region.getByRole('button', { name: 'Hide This computer', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.machines.controls');
  await region.getByRole('button', { name: 'Hide Decline link request', exact: true }).click(); await back(page);
  const id = await newTask(page);
  let labels = await runOnLabels(page); expect(labels.findIndex(label => label.includes('This computer'))).toBe(-1); expect(labels[0]).toContain('Studio iMac');
  expect(await act(page, 'target-local')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await linkRequest(page, id); await expect(card(page)).toBeVisible();
  await expect(card(page).getByRole('button', { name: 'Not now', exact: true })).toBeHidden();
  expect(await act(page, 'link-decline')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  const link = card(page).getByRole('button', { name: 'Link…', exact: true }); await link.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(link).toBeFocused();
  await page.evaluate(() => (window as any).__previewMachinesSafeMode());
  await expect(card(page).getByRole('button', { name: 'Not now', exact: true })).toBeVisible(); await expect(link).toBeFocused();
  labels = await runOnLabels(page); expect(labels[0]).toContain('This computer');
  expect(await count(page, OPERATIONS)).toBe(0);
});
