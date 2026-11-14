import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: every cloud command is the in-memory preview mock with a preview-only key;
// no provider is called, nothing is provisioned, stopped or deleted, and no spend is possible.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/cloud/extension.json', import.meta.url), 'utf8'));
const OPERATIONS = ['cloud_agent_action', 'cloud_agent_start', 'cloud_connect', 'cloud_disconnect', 'cloud_create', 'cloud_power', 'cloud_setup_sandboxes', 'cloud_agent_set_claude_token'];
const UNRELATED = ['stop_session', 'architect_control'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewCloud());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const count = (page: Page, names: string[]) => page.evaluate(names => (window as any).__extensionsBaseline.calls.filter((call: any) => names.includes(call.command)).length, names);
const actions = (page: Page) => page.evaluate(() => (window as any).__cloudActions ?? []);
const strip = (page: Page) => page.locator('#composer-area .cloud-strip');
const menuButton = (page: Page) => page.getByRole('button', { name: 'Cloud machine actions', exact: true });
const menu = (page: Page) => page.getByRole('menu', { name: 'Cloud machine', exact: true });
const chip = (page: Page) => page.locator('#composer-area .composer-computer-fixed[data-remote="cloud"]');
const confirm = (page: Page) => page.getByRole('dialog', { name: 'Delete cloud machine?' });
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&cloud-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-2');
  await expect(strip(page)).toContainText('E2B · Ready'); await expect.poll(async () => (await props(page))?.mode).toBe('task');
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page, id = 'sample.cloud/strip-below') { const region = await explorer(page); await region.getByLabel('Cloud machine presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator(`#composer-area .cloud-strip[data-cloud-provider="${id}"]`)).toBeVisible(); }
/** Builds a captured action from the live presentation. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, index = 0) {
  return page.evaluate(({ controlId, changes, index }) => {
    const p = (window as any).__previewCloud(), control = p.controls.filter((control: any) => control.controlId === controlId)[index];
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, provider: p.provider, machine: p.machine, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, index });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewCloudAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}) => send(page, await action(page, controlId, changes));
async function allow(page: Page) {
  await menuButton(page).click(); await menu(page).getByRole('menuitem', { name: /Allow cloud machine control for sample\.cloud/ }).click(); await expect(menu(page)).toBeHidden();
  await menuButton(page).click(); await expect(menu(page).getByRole('menuitem', { name: /Revoke cloud machine control for sample\.cloud/ })).toBeVisible(); await page.keyboard.press('Escape');
}
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();

test('Cloud extension: discovery/install/enable never touches a provider; the selected strip-below recipe uses original handlers', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.cloud', exact: true }).click();
  await expect(region.getByLabel('Cloud machine presentation')).toHaveValue(''); await region.getByLabel('Cloud machine presentation').selectOption('sample.cloud/strip-below'); await back(page);
  expect(await count(page, OPERATIONS)).toBe(0);
  await expect(strip(page)).toHaveCSS('order', '1'); await expect(page.locator('#composer-area')).toHaveCSS('display', 'flex');
  const [stripBox, composerBox] = await Promise.all([strip(page).boundingBox(), page.locator('#composer').boundingBox()]);
  expect(stripBox!.y).toBeGreaterThan(composerBox!.y);
  const p = await props(page);
  expect(p).toMatchObject({ mode: 'task', stage: 'ready', label: 'E2B', visible: true, busy: false, pending: 'none', confirm: false, error: false, supported: true });
  expect(p.machine).not.toBe(''); expect(JSON.stringify(p)).not.toContain('e2b:pc-fixture'); expect(JSON.stringify(p)).not.toContain('preview-only');
  expect(p.controls.map((control: any) => control.controlId)).toEqual(['machine-menu', 'sync', 'open', 'stop', 'delete']);
  expect(await act(page, 'machine-menu')).toEqual({ ok: true });
  await expect(menu(page).getByRole('menuitem', { name: 'Sync changes', exact: true })).toBeVisible(); await expect(menu(page).getByRole('menuitem', { name: 'Machine notes', exact: true })).toBeVisible();
  await menu(page).getByRole('menuitem', { name: 'Machine notes', exact: true }).click(); await expect(page.locator('#toast')).toContainText('Machines, spend and credentials stay with PandaCode');
  await chip(page).focus(); await page.keyboard.press('Shift+F10');
  await expect(menu(page).getByRole('menuitem', { name: 'Machine notes', exact: true })).toBeVisible(); await expect(menu(page).getByRole('menuitem', { name: 'Stop machine', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(chip(page)).toBeFocused();
  await strip(page).locator('.cloud-strip-text').click({ button: 'right' }); await expect(menu(page).getByRole('menuitem', { name: 'Machine notes', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  expect(await count(page, OPERATIONS)).toBe(0); expect(await actions(page)).toEqual([]);
});

test('Cloud extension: zero extensions keep the original strip and menu, withhold metadata and select nothing', async ({ page }) => {
  await setup(page); const p = await props(page);
  expect(p.label).toBe(''); await expect(page.locator('[data-cloud-provider]')).toHaveCount(0); await expect(strip(page)).toHaveCSS('order', '0');
  expect(await act(page, 'sync')).toEqual({ ok: false, reason: 'Revoked' });
  // Without a selected provider or a contribution, the strip keeps the browser's own context menu.
  await chip(page).focus(); await page.keyboard.press('Shift+F10'); await expect(menu(page)).toHaveCount(0);
  await menuButton(page).click(); await expect(menu(page).getByRole('menuitem', { name: /cloud machine control/ })).toHaveCount(0);
  await menu(page).getByRole('menuitem', { name: 'Sync changes', exact: true }).click();
  await expect(strip(page)).toContainText('Syncing changes'); await expect(strip(page)).toContainText('E2B · Ready');
  expect(await actions(page)).toEqual(['sync']); expect(await calls(page, 'cloud_agent_action')).toHaveLength(1);
});

test('Cloud extension: machine actions need consent and a fresh choice; stale, replayed and forged requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const stale = await action(page, 'open');
  expect(await act(page, 'sync')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  for (const changes of [{ controlId: 'delete-confirm' }, { controlId: 'cloud-start' }, { controlId: 'credentials' }, { apiKey: 'preview-only' }, { region: 'us-east' }, { prompt: 'spend' }]) expect(await act(page, 'sync', changes)).toEqual({ ok: false, reason: 'InvalidArguments' });
  const request = await action(page, 'sync');
  expect(await send(page, request)).toEqual({ ok: true }); expect(await actions(page)).toEqual([]);
  await proceed(page, 'Sync changes');
  await expect(strip(page)).toContainText('Syncing changes'); await expect(strip(page)).toContainText('E2B · Ready');
  expect(await actions(page)).toEqual(['sync']); expect((await calls(page, 'cloud_agent_action'))[0].args).toEqual({ sessionId: 'session-2', action: 'sync' });
  expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  // Dismissing the fresh host choice runs nothing.
  expect(await act(page, 'stop')).toEqual({ ok: true }); await expect(page.getByRole('menuitemradio', { name: 'Continue: Stop machine', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); expect(await actions(page)).toEqual(['sync']);
  await page.context().setOffline(true);
  expect(await act(page, 'stop')).toEqual({ ok: false, reason: 'Offline' });
  expect(await act(page, 'machine-menu')).toEqual({ ok: true }); await expect(menu(page)).toBeVisible(); await page.keyboard.press('Escape');
  await page.context().setOffline(false);
  expect(await count(page, ['cloud_agent_start', 'cloud_connect', 'cloud_create'])).toBe(0);
});

test('Cloud extension: delete keeps the original confirmation; only its cancel acts while open, and a confirmed delete runs once', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await allow(page);
  expect(await act(page, 'delete')).toEqual({ ok: true }); await proceed(page, 'Delete machine…');
  await expect(confirm(page)).toBeVisible();
  await expect.poll(async () => (await props(page)).confirm).toBe(true);
  expect(await props(page)).toMatchObject({ busy: true, pending: 'delete' });
  expect(await act(page, 'stop')).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'delete-cancel', { controlId: 'delete-confirm' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'delete-cancel')).toEqual({ ok: true }); await expect(confirm(page)).toHaveCount(0);
  await expect.poll(async () => (await props(page)).pending).toBe('none'); expect(await actions(page)).toEqual([]);
  expect(await act(page, 'delete')).toEqual({ ok: true }); await proceed(page, 'Delete machine…');
  await confirm(page).getByRole('button', { name: 'Delete machine', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Deleted the cloud machine'); expect(await actions(page)).toEqual(['delete']);
  await expect(strip(page)).toContainText('Stopped'); expect((await props(page)).machine).toBe('');
});

test('Cloud extension: a pending stop on A is exclusive and never applies to B or interrupts other agents', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await allow(page);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'cloud_agent_action'; });
  expect(await act(page, 'stop')).toEqual({ ok: true }); await proceed(page, 'Stop machine');
  await expect.poll(async () => (await props(page)).pending).toBe('stop'); await expect(strip(page).locator('.support-spinner')).toBeVisible();
  const a = await action(page, 'machine-menu'); expect(await act(page, 'sync')).toEqual({ ok: false, reason: 'Busy' });
  await menuButton(page).click(); await expect(menu(page).getByRole('menuitem', { name: 'Sync changes', exact: true })).toBeDisabled(); await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-1"]').click(); await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-1');
  expect(await send(page, a)).toEqual({ ok: false, reason: 'StaleContext' }); expect((await props(page)).mode).not.toBe('task');
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect.poll(() => actions(page)).toEqual(['stop']);
  expect(await calls(page, 'cloud_agent_action')).toHaveLength(1); expect((await calls(page, 'cloud_agent_action'))[0].args.sessionId).toBe('session-2');
  await expect(page.locator('#prompt')).toHaveAttribute('data-session-id', 'session-1'); expect(await count(page, UNRELATED)).toBe(0);
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(strip(page)).toContainText('E2B · Stopped'); expect((await props(page)).pending).toBe('none');
});

test('Cloud extension: a New task chooses a cloud target only after consent and a fresh choice, and never provisions', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  await page.locator('.new-task-button').click(); await expect.poll(async () => (await props(page)).mode).toBe('choice');
  const computer = page.locator('#composer-computer'); await expect(computer).toHaveAccessibleName('Computer: This computer');
  let p = await props(page); expect(p.provider).toBe(''); expect(p.controls.map((control: any) => control.controlId)).toEqual(['target-cloud', 'target-setup']);
  expect(await act(page, 'target-cloud')).toEqual({ ok: false, reason: 'PermissionDenied' });
  await computer.click(); await page.getByRole('menu', { name: 'Run on' }).getByRole('menuitemradio', { name: /Allow cloud machine control for sample\.cloud/ }).click();
  const request = await action(page, 'target-cloud');
  expect(await send(page, request)).toEqual({ ok: true }); await proceed(page, 'Run the next message on this cloud provider');
  await expect(computer).toHaveAccessibleName('Computer: Cloud · E2B');
  p = await props(page); expect(p.provider).not.toBe(''); expect(p.label).toBe('E2B');
  expect(await send(page, { ...request, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await count(page, OPERATIONS)).toBe(0);
  expect(await act(page, 'target-setup')).toEqual({ ok: true });
  await expect(page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tabpanel', { name: 'Cloud sandboxes' })).toBeVisible();
  expect(await count(page, OPERATIONS)).toBe(0);
});

test('Cloud extension: the open confirmation and chosen task survive fault, disable and safe mode; the user confirms once', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await allow(page);
  expect(await act(page, 'delete')).toEqual({ ok: true }); await proceed(page, 'Delete machine…'); await expect(confirm(page)).toBeVisible();
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyCloudPresentation(document.querySelector('#composer-area .cloud-strip'), () => { throw Error('controlled fault'); }); });
  expect(await act(page, 'delete-cancel')).toEqual({ ok: false, reason: 'Revoked' });
  await page.evaluate(() => (window as any).__previewCloudStage('session-2', 'ready'));
  await expect(page.locator('#composer-area .cloud-strip[data-cloud-provider]')).toHaveCount(0);
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.cloud'));
  await page.evaluate(() => (window as any).__previewCloudSafeMode());
  await expect(confirm(page)).toBeVisible(); await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-2');
  await expect(strip(page)).toHaveCSS('order', '0'); expect(await actions(page)).toEqual([]);
  await confirm(page).getByRole('button', { name: 'Delete machine', exact: true }).click();
  await expect.poll(() => actions(page)).toEqual(['delete']); await expect(page.locator('#toast')).toContainText('Deleted the cloud machine');
  await menuButton(page).click(); await menu(page).getByRole('menuitem', { name: 'Sync changes', exact: true }).click();
  await expect.poll(() => actions(page)).toEqual(['delete', 'sync']);
});

test('Cloud extension: conflict and future providers never auto-select; forged identity is stale', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.cloud'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.cloud/strip-below' }] };
  const future = structuredClone(other); future.id = 'future.cloud'; future.contributes.components[0].id = 'future.cloud/strip-below'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Cloud machine presentation')).toHaveValue(''); await expect(region.locator('option[value="future.cloud/strip-below"]')).toHaveAttribute('disabled', '');
  await back(page); await expect(page.locator('[data-cloud-provider]')).toHaveCount(0);
  await select(page, 'other.cloud/strip-below'); await expect(strip(page)).toHaveCSS('order', '1');
  // other.cloud asks for no connections.summary: the provider label stays withheld.
  expect((await props(page)).label).toBe('');
  for (const field of ['project', 'task', 'provider', 'machine', 'context']) expect(await act(page, 'machine-menu', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'machine-menu', { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await count(page, OPERATIONS)).toBe(0);
});

const rows = async (page: Page) => { await menuButton(page).click(); const labels = await menu(page).getByRole('menuitem').evaluateAll(nodes => nodes.map(node => node.getAttribute('aria-label') ?? '')); await page.keyboard.press('Escape'); return labels; };
test('Cloud extension: compatible menu order and reversible row and target visibility recover in safe mode', async ({ page }) => {
  // The default order (Sync before Stop) is asserted after safe-mode recovery below.
  await setup(page, [manifest]); await select(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.cloud.actions');
  await region.getByRole('button', { name: 'Grant UI customization and select Stop before syncing', exact: true }).click();
  const next = region.getByRole('button', { name: 'Next items', exact: true });
  for (let cursor = 0; cursor < 3 && !await region.getByRole('button', { name: 'Hide Open machine', exact: true }).count(); cursor++) await next.click();
  await region.getByRole('button', { name: 'Hide Open machine', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.cloud.targets');
  await region.getByRole('button', { name: 'Hide Set up cloud providers…', exact: true }).click(); await back(page);
  let labels = await rows(page); expect(labels.indexOf('Stop machine')).toBeLessThan(labels.indexOf('Sync changes')); expect(labels.indexOf('Open machine')).toBe(-1);
  expect(await act(page, 'open')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.locator('.new-task-button').click(); await page.locator('#composer-computer').click();
  const runOn = page.getByRole('menu', { name: 'Run on' });
  await expect(runOn.getByRole('menuitemradio', { name: 'Cloud · E2B' })).toBeVisible(); await expect(runOn.getByRole('menuitemradio', { name: 'Set up cloud providers…' })).toHaveCount(0); await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-2"]').click(); await expect(strip(page)).toBeVisible();
  await page.evaluate(() => (window as any).__previewCloudSafeMode());
  labels = await rows(page); expect(labels.indexOf('Sync changes')).toBeLessThan(labels.indexOf('Stop machine')); expect(labels.indexOf('Open machine')).toBeGreaterThan(-1);
  expect(await count(page, OPERATIONS)).toBe(0);
});

test('Cloud extension: reversible strip control visibility keeps focus through redraws and recovery', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.cloud.controls');
  await region.getByRole('button', { name: 'Hide Cloud machine status', exact: true }).click(); await back(page);
  await expect(strip(page).locator('.cloud-strip-status')).toBeHidden(); await expect(menuButton(page)).toBeVisible();
  await menuButton(page).focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(menuButton(page)).toBeFocused();
  await page.evaluate(() => (window as any).__previewCloudStage('session-2', 'syncing')); await expect(strip(page)).toHaveAttribute('data-stage', 'syncing'); await expect(menuButton(page)).toBeFocused();
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(strip(page).locator('.cloud-strip-status')).toBeVisible(); await expect(strip(page)).toHaveCSS('order', '0');
  expect(await count(page, OPERATIONS)).toBe(0);
});
