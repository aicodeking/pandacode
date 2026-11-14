import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/btw/extension.json', import.meta.url), 'utf8'));
const input = (page: Page) => page.locator('.btw-input');
const props = (page: Page) => page.evaluate(() => (window as any).__previewBtw());
const calls = (page: Page, command: string) => page.evaluate(command => ((window as any).__btwCalls ?? []).filter((c: any) => c.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))), packages);
  await page.goto('/?btw-coverage&replacement&extensions-baseline'); await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(() => { (window as any).__mainId = document.querySelector<HTMLTextAreaElement>('#prompt')!.dataset.sessionId; });
  await page.locator('#prompt').fill('Main task keeps working'); await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await page.locator('#prompt').fill('/btw side question'); await page.locator('#prompt').press('Enter');
  await expect(page.locator('.btw-transcript .agent-message')).toHaveCount(1);
  await expect(page.getByRole('button', { name: 'Send to side thread', exact: true })).toBeEnabled();
}
async function explorer(page: Page) {
  await input(page).focus(); await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function grant(page: Page) {
  for (const name of ['Allow side-task control for sample.btw', 'Allow answer insertion for sample.btw']) {
    const button = page.getByRole('button', { name, exact: true }); if (await button.count()) await button.click();
  }
}
async function select(page: Page) { const region = await explorer(page); await region.getByLabel('BTW presentation', { exact: true }).selectOption('sample.btw/conversation'); await back(page); await grant(page); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}) {
  return page.evaluate(({ controlId, changes }) => {
    const p = (window as any).__previewBtw();
    const a = { contractVersion: 1, window: p.window, context: p.context, project: p.project, main: p.main, side: p.side, revision: p.revision, controlId, resource: '', requestId: crypto.randomUUID(), ...changes };
    (window as any).__capturedBtw = a; return (window as any).__previewBtwAction(a);
  }, { controlId, changes });
}
test('btw: zero extensions preserve independent original send, IME and Escape', async ({ page }) => {
  await setup(page); await expect(page.locator('[data-btw-provider]')).toHaveCount(0);
  await input(page).fill('IME draft'); await input(page).dispatchEvent('keydown', { key: 'Enter', keyCode: 229, bubbles: true });
  expect(await calls(page, 'send_message')).toHaveLength(2); await expect(input(page)).toHaveValue('IME draft');
  await input(page).press('Escape'); await expect(page.locator('#prompt')).toBeFocused();
  await input(page).press('Enter'); await expect(page.locator('.btw-transcript .agent-message')).toHaveCount(2);
  const sent = await calls(page, 'send_message'); expect(sent[2].args.sessionId).toBe(sent[1].args.sessionId); expect(sent[2].args.sessionId).not.toBe(sent[0].args.sessionId);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
test('btw: local install and explicit selection cover header/composer/shared message/context and original answer insertion', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.btw', exact: true }).click();
  await expect(region.getByLabel('BTW presentation', { exact: true })).toHaveValue('');
  await region.getByLabel('BTW presentation', { exact: true }).selectOption('sample.btw/conversation'); await back(page);
  expect(await action(page, 'insert', { resource: (await props(page)).messages[0] })).toEqual({ ok: false, reason: 'PermissionDenied' });
  await grant(page);
  await expect(page.locator('[data-btw-provider="sample.btw/conversation"]')).toBeVisible();
  expect(await page.locator('.btw-composer-area').evaluate(node => getComputedStyle(node).order)).toBe('-1');
  for (const location of ['panda.btw.header', 'panda.btw.composer', 'panda.thread.message.actions']) await expect(page.locator(`.btw-panel [data-extension-location="${location}"]`).first()).toBeVisible();
  await page.locator('.btw-head strong').click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'Side conversation tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await page.locator('#prompt').fill('Main draft'); const before = (await calls(page, 'send_message')).length;
  expect(await action(page, 'insert', { resource: (await props(page)).messages[0] })).toEqual({ ok: true });
  await expect(page.locator('#prompt')).toHaveValue(/Main draft[\s\S]*browser preview/); expect(await calls(page, 'send_message')).toHaveLength(before);
  expect(await action(page, 'model')).toEqual({ ok: true }); await expect(page.locator('.model-menu')).toBeVisible(); await page.keyboard.press('Escape');
});
test('btw: captured forged/stale requests, exact-once send and protected approval reject without main effects', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await input(page).fill('Exactly once');
  await page.getByRole('button', { name: 'Revoke side-task control for sample.btw', exact: true }).click();
  expect(await action(page, 'send')).toEqual({ ok: false, reason: 'PermissionDenied' });
  await page.getByRole('button', { name: 'Allow side-task control for sample.btw', exact: true }).click();
  await page.getByRole('button', { name: 'Revoke answer insertion for sample.btw', exact: true }).click();
  expect(await action(page, 'insert', { resource: (await props(page)).messages[0] })).toEqual({ ok: false, reason: 'PermissionDenied' });
  await page.getByRole('button', { name: 'Allow answer insertion for sample.btw', exact: true }).click();
  const p = await props(page);
  for (const key of ['main', 'side', 'project', 'context', 'revision']) expect(await action(page, 'send', { [key]: key === 'revision' ? p.revision + 1 : 'foreign' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await action(page, 'approval-allow')).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await action(page, 'send')).toEqual({ ok: true });
  expect(await page.evaluate(() => (window as any).__previewBtwAction((window as any).__capturedBtw))).toMatchObject({ ok: false });
  await expect(page.locator('.btw-transcript .agent-message')).toHaveCount(2);
  const sent = await calls(page, 'send_message'); expect(sent).toHaveLength(3); expect(sent[2].args.sessionId).toBe(sent[1].args.sessionId);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
test('btw: movement, disable and safe mode preserve editor node, undo, draft, queue and stream ownership', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const sideId = (await calls(page, 'send_message'))[1].args.sessionId;
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await input(page).fill('Run on side'); await input(page).press('Enter'); await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  await input(page).fill('Queued only on side'); await input(page).press('Enter'); await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1);
  await input(page).pressSequentially('Undo preserved');
  const editor = await input(page).elementHandle(); await input(page).evaluate(node => { (window as any).__btwEditor = node; });
  const region = await explorer(page); await region.getByLabel('BTW presentation', { exact: true }).selectOption(''); await back(page);
  expect(await input(page).evaluate(node => node === (window as any).__btwEditor)).toBe(true);
  await select(page); await explorer(page); await page.getByRole('button', { name: 'Disable sample.btw', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  expect(await input(page).evaluate(node => node === (window as any).__btwEditor)).toBe(true); await expect(input(page)).toHaveValue('Undo preserved');
  await input(page).focus(); await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('');
  expect(await editor?.evaluate(node => node.isConnected)).toBe(true);
  expect((await calls(page, 'queue_add'))[0].args.sessionId).toBe(sideId); await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1);
  expect(await action(page, 'stop')).toEqual({ ok: false, reason: 'Revoked' });
  await page.getByRole('button', { name: 'Stop side thread', exact: true }).click();
  await expect.poll(() => calls(page, 'stop_session').then(list => list.map(c => c.args.sessionId))).toEqual([sideId]);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
test('btw: captured queue edit/save and steer use original side handlers once', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const sideId = (await calls(page, 'send_message'))[1].args.sessionId;
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await input(page).fill('Running'); expect(await action(page, 'send')).toEqual({ ok: true });
  await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  await input(page).fill('Queued'); expect(await action(page, 'send')).toEqual({ ok: true });
  await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1);
  let resource = (await props(page)).queues[0];
  expect(await action(page, 'queue-edit', { resource })).toEqual({ ok: true });
  await expect(page.locator('.btw-panel .queue-edit')).toBeFocused(); await page.locator('.btw-panel .queue-edit').fill('Edited captured queue');
  expect(await action(page, 'queue-save', { resource })).toEqual({ ok: true });
  await expect(page.locator('.btw-panel .queue-edit')).toHaveCount(0);
  expect(await calls(page, 'queue_update')).toHaveLength(1);
  expect((await calls(page, 'queue_add'))[0].args.sessionId).toBe(sideId);
  await input(page).fill('Steer captured'); expect(await action(page, 'steer')).toEqual({ ok: true });
  await expect.poll(() => calls(page, 'steer_task').then(list => list.map(c => c.args))).toEqual([{ sessionId: sideId, text: 'Steer captured' }]);
  resource = (await props(page)).queues[0]; expect(await action(page, 'queue-remove', { resource })).toEqual({ ok: true });
  await expect(page.locator('.btw-panel .queue-row')).toHaveCount(0);
});
test('btw: conflicting/future providers never auto-select; fault preserves approvals, stream and main/side drafts', async ({ page }) => {
  const future = { ...manifest, id: 'sample.future', contributes: { components: [{ ...manifest.contributes.components[0], id: 'sample.future/conversation', contractVersion: 2 }] } };
  await setup(page, [manifest, future]);
  await expect(page.locator('[data-btw-provider]')).toHaveCount(0);
  const region = await explorer(page); await expect(region.getByLabel('BTW presentation', { exact: true }).locator('option[value="sample.future/conversation"]')).toHaveAttribute('disabled', ''); await back(page);
  await select(page); await page.locator('#prompt').fill('Main draft survives'); await input(page).fill('Side draft survives');
  await input(page).evaluate(node => { (window as any).__btwEditor = node; });
  const sideId = (await calls(page, 'send_message'))[1].args.sessionId;
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await input(page).fill('Start side stream'); await input(page).press('Enter'); await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  await input(page).fill('Side draft survives');
  await page.evaluate(async sideId => {
    (window as any).__btwEmit('agent-event', { sessionId: sideId, kind: 'approval', requestId: 'side-approval', text: 'Run npm test?' });
    const { applyBtwPresentation } = await (window as any).__previewReplacementModules();
    applyBtwPresentation(document.querySelector('.btw-panel')!, () => { throw Error('qualification fault'); });
  }, sideId);
  await expect(page.locator('[data-btw-presentation-status]')).toContainText('Built-in conversation remains active');
  expect(await input(page).evaluate(node => node === (window as any).__btwEditor)).toBe(true);
  await expect(input(page)).toHaveValue('Side draft survives'); await expect(page.locator('#prompt')).toHaveValue('Main draft survives');
  expect(await action(page, 'approval-allow')).toEqual({ ok: false, reason: 'Revoked' });
  const approval = page.locator('.btw-panel').getByRole('region', { name: 'Approval needed', exact: true });
  await approval.getByRole('button', { name: 'Approve', exact: true }).click();
  await expect.poll(() => calls(page, 'respond_approval').then(list => list.map(c => c.args))).toEqual([{ sessionId: sideId, requestId: 'side-approval', approved: true }]);
  await input(page).press('Escape'); await expect(page.locator('#prompt')).toBeFocused();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
test('btw: main-side-main switches keep original editor undo and drafts without cross-task text', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const sent = await calls(page, 'send_message'), mainId = sent[0].args.sessionId, sideId = sent[1].args.sessionId;
  await page.locator('#prompt').fill('Main private draft'); await input(page).pressSequentially('Side private draft');
  await input(page).evaluate(node => { (window as any).__btwEditor = node; });
  await page.getByRole('button', { name: 'Open side thread as a full thread', exact: true }).click();
  await expect(page.locator(`.task-item[data-id="${sideId}"]`)).toHaveAttribute('aria-current', 'page');
  await page.locator(`.task-item[data-id="${mainId}"]`).click(); await expect(input(page)).toHaveValue('Side private draft');
  expect(await input(page).evaluate(node => node === (window as any).__btwEditor)).toBe(true);
  await expect(page.locator('#prompt')).toHaveValue('Main private draft');
  await input(page).focus(); await input(page).press('ControlOrMeta+z'); await expect(input(page)).toHaveValue('');
  expect(await calls(page, 'send_message')).toHaveLength(2);
  await page.getByRole('button', { name: 'Open side thread as a full thread', exact: true }).click();
  await page.locator('#prompt').fill('Side draft edited in full thread');
  await page.locator(`.task-item[data-id="${mainId}"]`).click();
  await expect(input(page)).toHaveValue('Side draft edited in full thread'); await expect(page.locator('#prompt')).toHaveValue('Main private draft');
});
test('btw: public control visibility/order restores without hiding protected Stop or losing draft', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await input(page).fill('Layout draft stays');
  const region = await explorer(page);
  await region.getByLabel('Item owner', { exact: true }).selectOption('panda.core');
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.btw.controls');
  await expect(region.getByRole('button', { name: 'Hide Stop side task', exact: true })).toHaveCount(0);
  await expect(region.getByRole('button', { name: 'Hide Side draft', exact: true })).toHaveCount(0);
  await region.getByRole('button', { name: 'Hide Side model', exact: true }).click();
  await region.getByRole('button', { name: 'Move Open side thread before', exact: true }).click(); await back(page);
  await expect(page.locator('.btw-panel [data-action="model"]')).toBeHidden(); await expect(input(page)).toHaveValue('Layout draft stays');
  expect(await page.locator('.btw-actions > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.btw))).toEqual(['open', 'new', 'close']);
  const next = await explorer(page); await next.getByLabel('Item owner', { exact: true }).selectOption('panda.core'); await next.getByLabel('Item location', { exact: true }).selectOption('panda.btw.controls'); await next.getByRole('button', { name: 'Show Side model', exact: true }).click(); await back(page);
  await expect(page.locator('.btw-panel [data-action="model"]')).toBeVisible(); await expect(input(page)).toHaveValue('Layout draft stays');
  expect(await calls(page, 'send_message')).toHaveLength(2);
});
test('btw: pending queue save retains newer edit and completes once only for captured side after a main switch', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const sent = await calls(page, 'send_message'), mainId = sent[0].args.sessionId;
  await page.evaluate(() => { (window as any).__holdSide = true; });
  await input(page).fill('Keep working'); await input(page).press('Enter'); await expect(page.getByRole('button', { name: 'Stop side thread', exact: true })).toBeVisible();
  await input(page).fill('Queue original'); await input(page).press('Enter'); await expect(page.locator('.btw-panel .queue-row')).toHaveCount(1);
  const resource = (await props(page)).queues[0]; expect(await action(page, 'queue-edit', { resource })).toEqual({ ok: true });
  await expect(page.locator('.btw-panel .queue-edit')).toBeVisible(); await page.locator('.btw-panel .queue-edit').fill('Captured save');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'queue_update'; });
  expect(await action(page, 'queue-save', { resource })).toEqual({ ok: true });
  expect(await action(page, 'queue-save', { resource })).toEqual({ ok: false, reason: 'Busy' });
  await page.locator('.btw-panel .queue-edit').fill('New edit while save pending');
  await page.locator('.task-item[data-id="session-2"]').click();
  const before = await calls(page, 'queue_update'); expect(before).toHaveLength(1);
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await page.locator(`.task-item[data-id="${mainId}"]`).click();
  await expect(page.locator('.btw-panel .queue-edit')).toHaveValue('New edit while save pending');
  expect(await calls(page, 'queue_update')).toHaveLength(1); expect(await calls(page, 'send_message')).toHaveLength(3);
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
});
