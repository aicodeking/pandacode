import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: the extensions baseline transport with a held synthetic run and the preview's seeded council.
// No real harness runs; installed WebView qualification is separate and not claimed by this file.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/composer-panels/extension.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.composer-panels/toolbar';
const BASE = '/?extensions-baseline&composer-panels&replacement';
const props = (page: Page) => page.evaluate(() => (window as any).__previewPanels());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const toast = (page: Page) => page.locator('#toast');
const queue = (page: Page) => page.getByRole('region', { name: 'Queued messages', exact: true });
const rows = (page: Page) => queue(page).locator('.queue-row');
const texts = (page: Page) => rows(page).locator('.queue-text').allTextContents();
const rowControls = (page: Page, index = 0) => rows(page).nth(index).locator('.queue-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.queueControl ?? (node as HTMLElement).dataset.action));
const saverFooter = (page: Page) => page.locator('.saver-panel .saver-foot > *').evaluateAll(nodes => nodes.map(node => node.className.split(' ')[0]));
const councilRows = (page: Page) => page.locator('.council-panel > [data-field-row]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.fieldRow));
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.addInitScript(({ packages }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages });
  await page.goto(url); await expect(prompt(page)).toBeEnabled();
  await expect.poll(async () => Boolean(await props(page))).toBe(true);
}
/** Another page load: the adoption mounts once extensions load. */
async function load(page: Page, url: string) { await page.goto(url); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true); }
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(id); await back(page); await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', id); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewPanels(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewPanelsAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
async function run(page: Page) {
  await prompt(page).fill('Start synthetic work'); await prompt(page).press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
}
async function enqueue(page: Page, ...messages: string[]) {
  for (const message of messages) { await prompt(page).fill(message); await prompt(page).press('Enter'); await expect(rows(page).locator('.queue-text', { hasText: message })).toHaveCount(1); }
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
const noQueueEffects = async (page: Page) => { expect(await calls(page, 'queue_remove')).toEqual([]); expect(await calls(page, 'queue_reorder')).toEqual([]); expect(await calls(page, 'steer_task')).toEqual([]); };
const saverButton = (page: Page) => page.locator('#composer .composer-saver-button');
/** Messages that started a turn: a plain thread sends, a team thread starts its lead. */
const sent = async (page: Page) => (await calls(page, 'send_message')).length + (await calls(page, 'architect_start')).length;

test('Composer panels extension: zero extensions keep the queue (hold, edit, reorder, steer), token saver and council panels', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await run(page);
  await enqueue(page, 'First follow-up', 'Second follow-up');
  expect(await rowControls(page)).toEqual(['steer', 'send-now', 'edit', 'queue-remove']);
  await expect(queue(page).locator('[data-queue-extension-actions], [data-layout-hidden]')).toHaveCount(0);
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, busy: false, safeMode: false, running: true, held: false, saver: false, council: false, cycle: '' });
  expect(p.entries).toHaveLength(2);
  expect(await act(page, 'queue-edit')).toEqual({ ok: false, reason: 'Revoked' });
  // Edit, reorder with Alt+arrow and steer on the original nodes.
  await rows(page).nth(1).locator('[data-queue-control="edit"]').click();
  await queue(page).getByRole('textbox', { name: 'Edit queued message' }).fill('Second follow-up, edited');
  await queue(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => texts(page)).toEqual(['First follow-up', 'Second follow-up, edited']);
  await rows(page).nth(1).focus(); await page.keyboard.press('Alt+ArrowUp');
  await expect.poll(() => texts(page)).toEqual(['Second follow-up, edited', 'First follow-up']);
  await expect(rows(page).nth(0)).toBeFocused();
  await rows(page).nth(1).locator('[data-queue-control="steer"]').click();
  await expect.poll(async () => (await calls(page, 'steer_task')).map((call: any) => call.args.text)).toEqual(['First follow-up']);
  await expect.poll(() => texts(page)).toEqual(['Second follow-up, edited']);
  // The token saver panel keeps its footer and closes on Escape back to its button.
  await saverButton(page).click(); await expect(page.locator('.saver-panel')).toBeVisible();
  expect(await saverFooter(page)).toEqual(['saver-default', 'saver-off']);
  await expect(page.locator('.saver-panel [data-saver-extension-actions]')).toHaveCount(0);
  expect((await props(page)).saver).toBe(true);
  await page.keyboard.press('Escape'); await expect(page.locator('.saver-panel')).toHaveCount(0);
  expect((await calls(page, 'send_message')).length).toBe(1);
  // Council: the seeded asking cycle keeps its strip and its three decisions.
  await load(page, `${BASE}&council=asking`);
  const strip = page.locator('#composer .council-strip');
  await expect(strip).toBeVisible(); await expect(strip.locator('[data-council-extension-actions]')).toHaveCount(0);
  await expect(strip.getByRole('button', { name: 'Keep fixing', exact: true })).toBeVisible();
  await expect(strip.getByRole('button', { name: 'Accept and finish', exact: true })).toBeVisible();
  await strip.locator('.council-strip-toggle').click(); await expect(strip.locator('.council-row').first()).toBeVisible();
  await page.locator('#composer .composer-council-button').click();
  expect(await councilRows(page)).toEqual(['target', 'maxRounds', 'reviewers']);
  await page.keyboard.press('Escape'); await expect(page.locator('.council-panel')).toHaveCount(0);
});

test('Composer panels extension: an installed package adds queue row, token saver and council strip actions that run with the captured target', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.composer-panels', exact: true }).click();
  await expect(region.getByLabel('Composer presentation')).toHaveValue('');
  await back(page);
  await run(page);
  await enqueue(page, 'Queued with notes');
  // Queue row: the contributed action leads the row's own controls and keeps the entry.
  const queueNotes = rows(page).first().getByRole('button', { name: 'Queue notes', exact: true });
  await expect(queueNotes).toBeVisible();
  await queueNotes.click(); await expect(toast(page)).toContainText('Queued messages stay with PandaCode.');
  expect(await texts(page)).toEqual(['Queued with notes']); await noQueueEffects(page);
  // Token saver: the contributed action sits above the footer; the panel stays open and its switches untouched.
  await saverButton(page).click(); await expect(page.locator('.saver-panel')).toBeVisible();
  const saverNotes = page.locator('.saver-panel').getByRole('button', { name: 'Saver notes', exact: true });
  await saverNotes.click(); await expect(toast(page)).toContainText("Token saver packs stay the user's choice.");
  await expect(page.locator('.saver-panel')).toBeVisible();
  await expect(page.locator('.saver-panel .saver-switch[aria-checked="true"]')).toHaveCount(0);
  // A pack switched on by the user redraws the panel; the contributed action stays mounted.
  await page.locator('.saver-panel .saver-switch').first().click();
  await expect(page.locator('.saver-panel .saver-switch').first()).toHaveAttribute('aria-checked', 'true');
  await expect(saverNotes).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.saver-panel')).toHaveCount(0);
  // Council: the strip's contributed action runs with the cycle; no decision is taken.
  await load(page, `${BASE}&council=asking`);
  const councilNotes = page.locator('#composer .council-strip').getByRole('button', { name: 'Council notes', exact: true });
  await councilNotes.click(); await expect(toast(page)).toContainText('Council decisions stay with the user.');
  expect(await calls(page, 'architect_council_accept')).toEqual([]); expect(await calls(page, 'architect_set_council')).toEqual([]);
  await expect(page.locator('#composer .council-strip')).toHaveAttribute('data-state', 'asking');
});

test('Composer panels extension: captured queue and token saver actions run original handlers; protected, stale and forged requests fail', async ({ page }) => {
  // Several Settings round trips and a held run: the established 60 s budget of multi-step coverage cases.
  test.setTimeout(60_000);
  await setup(page, [manifest]); await select(page);
  await run(page); await enqueue(page, 'Alpha follow-up', 'Beta follow-up');
  // A package never removes, saves, reorders, switches packs or decides for Council: refused, whatever else it names.
  for (const controlId of ['queue-remove', 'queue-save', 'queue-cancel', 'queue-reorder', 'saver-pack', 'saver-level', 'saver-install', 'council-accept', 'council-dismiss', 'council-keep-fixing', 'council-set']) expect(await act(page, 'queue-steer', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await act(page, 'queue-steer', { text: 'forged text' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'queue-steer', { selector: '.queue-row' })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await act(page, 'queue-steer', { contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const field of ['context', 'project', 'task', 'control', 'resource']) expect(await act(page, 'queue-edit', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  await noQueueEffects(page); expect(await texts(page)).toEqual(['Alpha follow-up', 'Beta follow-up']);
  // Edit opens the original editor on the captured (second) entry; the user cancels it.
  expect(await act(page, 'queue-edit', {}, 1)).toEqual({ ok: true });
  await expect(rows(page).nth(1)).toHaveClass(/editing/); await expect(rows(page).nth(0)).not.toHaveClass(/editing/);
  await queue(page).getByRole('button', { name: 'Cancel edit', exact: true }).click(); await expect(queue(page).locator('.editing')).toHaveCount(0);
  // An entry edited after the request was captured is another target.
  const stale = await action(page, 'queue-steer', {}, 0);
  await rows(page).nth(0).locator('[data-queue-control="edit"]').click();
  await queue(page).getByRole('textbox', { name: 'Edit queued message' }).fill('Alpha follow-up, edited');
  await queue(page).getByRole('button', { name: 'Save', exact: true }).click();
  await expect.poll(() => texts(page)).toEqual(['Alpha follow-up, edited', 'Beta follow-up']);
  expect(await send(page, stale)).toEqual({ ok: false, reason: 'StaleContext' });
  // Steer needs a fresh host choice bound to the same entry; Escape declines it and nothing steers.
  expect(await act(page, 'queue-steer', {}, 0)).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  const continueSteer = page.getByRole('menuitemradio', { name: 'Continue: Steer this queued message into the running turn', exact: true });
  await expect(continueSteer).toBeVisible();
  expect(await act(page, 'queue-edit')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(continueSteer).toHaveCount(0);
  await noQueueEffects(page);
  expect(await act(page, 'queue-steer', {}, 0)).toEqual({ ok: true }); await continueSteer.click();
  await expect.poll(async () => (await calls(page, 'steer_task')).map((call: any) => call.args.text)).toEqual(['Alpha follow-up, edited']);
  await expect.poll(() => texts(page)).toEqual(['Beta follow-up']);
  // Send now runs the original handler for the captured entry (into the running turn here), once.
  expect(await act(page, 'queue-send-now', {}, 0)).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Send into the running turn', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'steer_task')).map((call: any) => call.args.text)).toEqual(['Alpha follow-up, edited', 'Beta follow-up']);
  await expect(queue(page)).toHaveCount(0);
  expect((await calls(page, 'send_message')).length).toBe(1); expect(await calls(page, 'stop_session')).toEqual([]);
  // Token saver: controls exist only while its panel is open for this task; Turn all off needs the fresh choice and
  // keeps the panel open.
  expect((await props(page)).saver).toBe(false);
  await saverButton(page).click(); await expect(page.locator('.saver-panel')).toBeVisible();
  expect(await act(page, 'saver-off')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.locator('.saver-panel .saver-switch').first().click();
  await expect(page.locator('.saver-panel .saver-switch').first()).toHaveAttribute('aria-checked', 'true');
  expect(await act(page, 'saver-off')).toEqual({ ok: true });
  await page.getByRole('menuitemradio', { name: 'Continue: Turn every token saver pack off', exact: true }).click();
  await expect(page.locator('.saver-panel')).toBeVisible();
  await expect(page.locator('.saver-panel .saver-switch').first()).toHaveAttribute('aria-checked', 'false');
  // Switching task changes the captured task: a request made for the first task is refused there.
  const elsewhere = await action(page, 'saver-default');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
  expect((await calls(page, 'steer_task')).length).toBe(2); expect((await calls(page, 'send_message')).length).toBe(1);
});

test('Composer panels extension: captured council actions open the original disclosure, reviewer and panel; decisions and stale cycles are refused', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page, [manifest], `${BASE}&council=asking`); await select(page);
  const strip = page.locator('#composer .council-strip');
  const p = await props(page); expect(p).toMatchObject({ council: true }); expect(p.cycle).not.toBe('');
  for (const controlId of ['council-accept', 'council-dismiss', 'council-keep-fixing', 'council-set']) expect(await act(page, 'council-strip-toggle', { controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  expect(await calls(page, 'architect_council_accept')).toEqual([]); expect(await calls(page, 'send_message')).toEqual([]);
  await expect(strip).toHaveAttribute('data-state', 'asking');
  // The disclosure, a reviewer row and Lower target run their original handlers on the captured cycle.
  expect(await act(page, 'council-strip-toggle')).toEqual({ ok: true });
  await expect(strip.locator('.council-strip-toggle')).toHaveAttribute('aria-expanded', 'true');
  await expect(strip.locator('.council-row')).toHaveCount(3);
  expect(await act(page, 'council-lower-target')).toEqual({ ok: true });
  await expect(page.locator('.council-panel[data-compact="target"]')).toBeVisible();
  await page.keyboard.press('Escape'); await expect(page.locator('.council-panel')).toHaveCount(0);
  expect(await act(page, 'council-open-worker')).toEqual({ ok: true });
  await expect(page.locator('.architect-worker-meta strong')).toHaveText('Correctness');
  await page.locator('.architect-panel').getByRole('button', { name: 'Back to workers', exact: true }).click();
  // The user's own Accept and finish changes the cycle's state: a request captured while it was asking is refused.
  const asking = await action(page, 'council-strip-toggle');
  await strip.getByRole('button', { name: 'Accept and finish', exact: true }).click();
  await expect.poll(async () => (await calls(page, 'architect_council_accept')).length).toBe(1);
  expect(await send(page, asking)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await calls(page, 'architect_set_council')).toEqual([]);
  // A passed cycle gives way to a new one with the next message: requests captured for the old cycle are refused.
  await load(page, `${BASE}&council=passed`);
  await expect(strip).toHaveAttribute('data-state', 'passed');
  const passed = await action(page, 'council-strip-toggle'), cycle = (await props(page)).cycle;
  expect(cycle).not.toBe('');
  await prompt(page).fill('Start the next cycle'); await prompt(page).press('Enter');
  await expect.poll(async () => (await props(page)).cycle).not.toBe(cycle);
  expect(await send(page, passed)).toEqual({ ok: false, reason: 'StaleContext' });
});

test('Composer panels extension: queue, token saver and council order and hiding persist across a reload and never touch protected controls', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]); await select(page);
  await proposal(page, 'panda.composer.queue.controls', 'Steer after Edit'); await back(page);
  await proposal(page, 'panda.composer.saver.controls', 'Start new threads after Turn all off'); await back(page);
  await proposal(page, 'panda.composer.council.controls', 'Target after Reviewers'); await back(page);
  let region = await hide(page, 'panda.composer.queue.controls', 'Send queued message now');
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.composer.saver.controls');
  await region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Start new threads like this', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.composer.council.controls');
  await region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Reviewers', exact: true }).click();
  await expect(region.getByRole('button', { name: /^Hide Target score/ })).toHaveCount(0);
  await back(page);
  await run(page); await enqueue(page, 'One', 'Two');
  const check = async (running = true) => {
    // A reload ends the held synthetic run: the queue is paused and has no Steer.
    await expect.poll(() => rowControls(page)).toEqual(running ? ['send-now', 'edit', 'steer', 'queue-remove'] : ['send-now', 'edit', 'queue-remove']);
    await expect(rows(page).first().locator('[data-queue-control="send-now"]')).toBeHidden();
    await expect(rows(page).first().getByRole('button', { name: 'Remove queued message 1', exact: true })).toBeVisible();
    await saverButton(page).click(); await expect(page.locator('.saver-panel')).toBeVisible();
    expect(await saverFooter(page)).toEqual(['saver-off', 'saver-default']);
    await expect(page.locator('.saver-panel .saver-default')).toBeHidden(); await expect(page.locator('.saver-panel .saver-switch').first()).toBeVisible();
    await page.keyboard.press('Escape'); await expect(page.locator('.saver-panel')).toHaveCount(0);
  };
  await check();
  expect(await act(page, 'queue-send-now')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await check(false);
  await load(page, `${BASE}&council=asking`);
  await page.locator('#composer .composer-council-button').click(); await expect(page.locator('.council-panel')).toBeVisible();
  await expect.poll(() => councilRows(page)).toEqual(['maxRounds', 'reviewers', 'target']);
  await expect(page.locator('.council-panel [data-field-row="reviewers"]')).toBeHidden(); await expect(page.locator('.council-panel [data-field-row="target"]')).toBeVisible();
  await page.keyboard.press('Escape');
  // A forged overlay cannot hide the target row, Delete or the council's decisions.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.composer.council.controls/target': false, 'panda.composer.panels.protected/queue-remove': false, 'panda.composer.panels.protected/council-decisions': false }; localStorage.setItem(key, JSON.stringify(value)); window.dispatchEvent(new StorageEvent('storage', { key })); });
  await page.locator('#composer .composer-council-button').click();
  await expect(page.locator('.council-panel [data-field-row="target"]')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(rows(page).first().getByRole('button', { name: 'Remove queued message 1', exact: true })).toBeVisible();
  await expect(page.locator('#composer .council-strip').getByRole('button', { name: 'Keep fixing', exact: true })).toBeVisible();
  expect(await calls(page, 'queue_remove')).toEqual([]); expect(await calls(page, 'architect_set_council')).toEqual([]);
});

test('Composer panels extension: queued messages, their order, the council cycle and focus survive conflict, fault, disable and safe mode with no duplicate send', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.composer-panels'; other.permissions = ['ui.contribute']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.composer-panels/toolbar' }], commands: [{ id: 'other.composer-panels/notes', title: 'Other notes', action: { kind: 'showMessage', message: 'Other package.' } }], menus: [{ id: 'other.composer-panels/queue', command: 'other.composer-panels/notes', location: 'panda.composer.queue.actions', presentation: 'button', text: 'Other notes' }] };
  // Two queued messages held after a restart, beside the seeded asking council cycle.
  await page.addInitScript(() => {
    if (localStorage.getItem('pandacode.preview.queue')) return;
    const at = Date.now();
    localStorage.setItem('pandacode.preview.queue', JSON.stringify([['queued-1', 'Held first'], ['queued-2', 'Held second']].map(([id, text], position) => ({ id, sessionId: 'session-1', position, text, attachments: [], createdAt: at, updatedAt: at }))));
  });
  await setup(page, [manifest, other], `${BASE}&council=asking`);
  // Two compatible providers: neither is selected automatically.
  await explorer(page); await expect(page.getByLabel('Composer presentation', { exact: true })).toHaveValue(''); await back(page);
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  await select(page, 'other.composer-panels/toolbar');
  // Both packages contribute to each queue row; neither displaces a row's own controls.
  await expect(rows(page).first().getByRole('button', { name: 'Other notes', exact: true })).toBeVisible();
  await expect(rows(page).first().getByRole('button', { name: 'Queue notes', exact: true })).toBeVisible();
  const cycle = (await props(page)).cycle;
  await prompt(page).fill('Keep this draft'); await prompt(page).focus();
  const sends = await sent(page);
  const check = async () => {
    expect(await texts(page)).toEqual(['Held first', 'Held second']);
    await expect(queue(page).locator('.queue-hold')).toHaveText('Paused after restart');
    await expect(page.locator('#composer .council-strip')).toHaveAttribute('data-state', 'asking');
    expect((await props(page)).cycle).toBe(cycle);
    await expect(prompt(page)).toHaveValue('Keep this draft'); await expect(prompt(page)).toBeFocused();
    expect(await sent(page)).toBe(sends); expect(await calls(page, 'queue_remove')).toEqual([]); expect(await calls(page, 'queue_reorder')).toEqual([]);
    expect(await calls(page, 'architect_council_accept')).toEqual([]); expect(await calls(page, 'steer_task')).toEqual([]);
  };
  await check();
  // A faulting composer recipe falls back to the built-in composer: captured actions stop; the panels stay.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyComposerPresentation(document.querySelector('#composer'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('#composer')).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'queue-resume')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  await page.evaluate(() => (window as any).__previewDisableExtension('other.composer-panels'));
  await expect(rows(page).first().getByRole('button', { name: 'Other notes', exact: true })).toHaveCount(0);
  await check();
  await explorer(page); await page.getByLabel('Composer presentation', { exact: true }).selectOption(PROVIDER); await back(page);
  await expect(page.locator('#composer')).toHaveAttribute('data-component-provider', PROVIDER);
  await prompt(page).focus(); await check();
  // A captured Resume asks first; Escape declines it and the held queue stays.
  expect(await act(page, 'queue-resume')).toEqual({ ok: true });
  const continueResume = page.getByRole('menuitemradio', { name: 'Continue: Resume the held queue', exact: true });
  await expect(continueResume).toBeVisible(); await page.keyboard.press('Escape'); await expect(continueResume).toHaveCount(0);
  await prompt(page).focus(); await check();
  // Safe mode restores the built-in panels: no slot, nothing captured, the queue, its hold, the cycle and focus stay.
  await page.evaluate(() => (window as any).__previewPanelsSafeMode());
  await expect(page.locator('#composer [data-queue-extension-actions], #composer [data-council-extension-actions]')).toHaveCount(0);
  expect((await props(page)).safeMode).toBe(true);
  expect(await act(page, 'queue-resume')).toEqual({ ok: false, reason: 'Revoked' });
  await check();
  // The host still resumes the held queue: once.
  await queue(page).getByRole('button', { name: 'Resume', exact: true }).click();
  await expect.poll(() => sent(page)).toBe(sends + 1);
  await expect.poll(() => texts(page)).toEqual(['Held second']);
  expect(await sent(page)).toBe(sends + 1);
});
