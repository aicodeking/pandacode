import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S0607 (upstream sync P6): grouped, dismissable thread errors and the one toast after the 0.3.128 merge. Browser
 * fixtures only: the extensions baseline transport with session-1's seeded error rows and the packaged fixture
 * tests/fixtures/extensions/upstream-errors/manifest.json, installed and enabled through the same Settings flow a user
 * follows. No real harness runs. Native authority and lifecycle checks, and installed WebView qualification, are separate
 * evidence (docs/extensions/upstream-errors.md); this file never stands in for them. */
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-errors/manifest.json', import.meta.url), 'utf8'));
const PROVIDER = 'sample.upstream-errors/timeline';
const BASE = '/?extensions-baseline&upstream-errors&replacement';
const LIMIT = 'Rate limit exceeded: try again in a minute.';
const DETAIL = 'Request failed\n  at step 3 of 5\n  retry later';
const SEEDED = (() => {
  const at = Date.now() - 20_000;
  return [
    { id: 91_001, sessionId: 'session-1', role: 'user', content: 'Run the whole suite.', createdAt: at },
    { id: 91_002, sessionId: 'session-1', role: 'error', content: LIMIT, createdAt: at + 1_000 },
    { id: 91_003, sessionId: 'session-1', role: 'error', content: `Error: ${LIMIT}`, createdAt: at + 2_000 },
    { id: 91_004, sessionId: 'session-1', role: 'error', content: DETAIL, createdAt: at + 3_000 },
  ];
})();
const props = (page: Page) => page.evaluate(() => (window as any).__previewUpstreamErrors());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const prompt = (page: Page) => page.locator('#prompt');
const transcript = (page: Page) => page.locator('#transcript');
const toast = (page: Page) => page.locator('#toast');
const rows = (page: Page) => transcript(page).locator('.message-error[data-error-key]');
const detailRow = (page: Page) => rows(page).filter({ hasText: 'Request failed' });
const limitRow = (page: Page) => rows(page).filter({ hasText: 'Rate limit exceeded' });
const order = (row: ReturnType<typeof rows>) => row.locator(':scope > .error-row-head > button').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.action));
const choice = (page: Page, name: string) => page.getByRole('menuitemradio', { name: `Continue: ${name}`, exact: true });
async function setup(page: Page, packages: unknown[] = [], url = BASE) {
  await page.addInitScript(({ packages, seeded }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], seedMessages: { 'session-1': seeded } };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, { packages, seeded: SEEDED });
  await load(page, url);
}
/** Another page load: the adoption mounts once extensions load. */
async function load(page: Page, url = BASE) {
  await page.goto(url); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await expect(rows(page)).toHaveCount(2);
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
async function select(page: Page, id = PROVIDER) { await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(id); await back(page); await expect(transcript(page)).toHaveAttribute('data-component-provider', id); }
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(({ controlId, changes, nth }) => {
    const p = (window as any).__previewUpstreamErrors(), control = p.controls.filter((item: any) => item.controlId === controlId)[nth] ?? p.controls[0];
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, task: p.task, revision: p.revision, control: control?.id ?? 'none', controlId, resource: control?.resource ?? '', requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewUpstreamErrorsAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
async function proposal(page: Page, location: string, title: string) {
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  await region.getByRole('button', { name: `Grant UI customization and select ${title}`, exact: true }).click();
  return region;
}
async function visibility(page: Page, region: ReturnType<Page['locator']>, location: string, label: string, verb: 'Hide' | 'Show') {
  await region.getByLabel('Item location', { exact: true }).selectOption(location);
  const button = region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: `${verb} ${label}`, exact: true });
  for (let cursor = 0; cursor < 6 && !await button.count(); cursor++) await region.getByRole('button', { name: 'Next items', exact: true }).click();
  await button.click();
}
const noEffects = async (page: Page) => { for (const command of ['dismiss_error_messages', 'delete_message', 'send_message']) expect(await calls(page, command), command).toEqual([]); };

test('Upstream errors: with no package the rows, dismissal, Undo and the toast behave as upstream (keyboard and focus included)', async ({ page }) => {
  test.setTimeout(60_000);
  await setup(page);
  await expect(page.locator('#transcript [data-layout-hidden], #transcript [data-thread-errors]')).toHaveCount(0);
  expect(await props(page)).toMatchObject({ visible: true, busy: false, safeMode: false, groups: 2, failover: false });
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  // Upstream's grouping: the repeated limit error is one row counted twice; only the multi-line one has details.
  await expect(limitRow(page).locator('.error-row-count')).toContainText('×2');
  expect(await order(limitRow(page))).toEqual(['dismiss-error']);
  expect(await order(detailRow(page))).toEqual(['toggle-error', 'dismiss-error']);
  const toggle = detailRow(page).getByRole('button', { name: 'Error details', exact: true });
  await toggle.focus(); await page.keyboard.press('Enter');
  await expect(toggle).toHaveAttribute('aria-expanded', 'true'); await expect(detailRow(page).locator('.error-row-detail')).toBeVisible();
  await expect(toggle).toBeFocused();
  await page.keyboard.press('Space'); await expect(toggle).toHaveAttribute('aria-expanded', 'false');
  // Dismiss one: the row goes, the toast offers Undo, Undo brings it back and focus stays in the thread.
  await limitRow(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(rows(page)).toHaveCount(1); await expect(toast(page)).toContainText('Error dismissed');
  await toast(page).getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(rows(page)).toHaveCount(2);
  expect(await calls(page, 'dismiss_error_messages')).toEqual([]);
  // Dismiss all dismisses both groups; Escape inside the toast closes it (the dismissal then commits).
  await transcript(page).getByRole('button', { name: 'Dismiss all', exact: true }).click();
  await expect(rows(page)).toHaveCount(0); await expect(toast(page)).toContainText('2 errors dismissed');
  await page.keyboard.press('F6'); await expect(toast(page).getByRole('button', { name: 'Undo', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(toast(page)).toBeHidden();
  await expect.poll(async () => (await calls(page, 'dismiss_error_messages')).length).toBeGreaterThan(0);
});

test('Upstream errors: an installed package customizes rows and the toast through the real install and enable flow, and captured actions reject stale context', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page);
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.upstream-errors', exact: true }).click();
  await expect(region.getByLabel('Transcript presentation')).toHaveValue('');
  await back(page);
  await select(page);
  // Captured Details opens the original disclosure once; the revision it was built for is then stale.
  const open = await action(page, 'error-details');
  expect(await send(page, open)).toEqual({ ok: true });
  await expect(detailRow(page).locator('.error-row-detail')).toBeVisible();
  expect(await send(page, open)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await send(page, { ...(await action(page, 'error-details')), requestId: open.requestId })).toEqual({ ok: false, reason: 'AlreadyApplied' });
  expect(await act(page, 'error-details')).toEqual({ ok: true }); await expect(detailRow(page).locator('.error-row-detail')).toBeHidden();
  // Malformed, foreign and protected requests.
  expect(await send(page, { ...(await action(page, 'error-details')), extra: 1 })).toEqual({ ok: false, reason: 'InvalidArguments' });
  expect(await send(page, { ...(await action(page, 'error-details')), contractVersion: 2 })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  for (const controlId of ['error-read', 'error-journal', 'toast-undo', 'toast-suppress']) expect(await send(page, { ...(await action(page, 'error-details')), controlId })).toEqual({ ok: false, reason: 'PermissionDenied' });
  // Dismiss needs a fresh host choice bound to the same thread and revision; Escape declines it and nothing is dismissed.
  const dismiss = await action(page, 'error-dismiss', {}, 1);
  expect(await send(page, dismiss)).toEqual({ ok: true }); expect((await props(page)).busy).toBe(true);
  await expect(choice(page, 'Dismiss this error')).toBeVisible();
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Busy' });
  await page.keyboard.press('Escape'); await expect(choice(page, 'Dismiss this error')).toHaveCount(0);
  await expect(rows(page)).toHaveCount(2); await noEffects(page);
  // A choice taken after the rows changed does nothing: the revision it was asked for no longer holds.
  expect(await act(page, 'error-dismiss', {}, 1)).toEqual({ ok: true });
  await expect(choice(page, 'Dismiss this error')).toBeVisible();
  await page.evaluate(() => (window as any).__extensionsBaseline.emitAgent({ sessionId: 'session-1', kind: 'error', text: 'A new failure arrived.' }));
  await choice(page, 'Dismiss this error').click();
  await expect(rows(page)).toHaveCount(3); await noEffects(page);
  // The same after the choice: Dismiss runs the original handler, with its Undo toast, once.
  expect(await act(page, 'error-dismiss', {}, 1)).toEqual({ ok: true }); await choice(page, 'Dismiss this error').click();
  await expect(rows(page)).toHaveCount(2); await expect(toast(page)).toContainText('Error dismissed');
  // The toast: its close button is a captured control; its text, Undo and actions are not.
  expect((await props(page)).toast).toMatchObject({ showing: true, undo: true, closable: true });
  expect(JSON.stringify(await props(page))).not.toContain('Error dismissed');
  const close = await action(page, 'toast-close');
  expect(await send(page, close)).toEqual({ ok: true }); await expect(toast(page)).toBeHidden();
  expect(await send(page, { ...close, requestId: 'again' })).toEqual({ ok: false, reason: 'StaleContext' });
  // Switching task changes the captured task.
  const elsewhere = await action(page, 'error-details');
  await page.locator('#navigation .task-item[data-id="session-2"]').click(); await expect(page.locator('#navigation .task-item[data-id="session-2"]')).toHaveAttribute('aria-current', 'page');
  expect(await send(page, elsewhere)).toEqual({ ok: false, reason: 'StaleContext' });
});

test('Upstream errors: Details and Dismiss order, hiding and restoring persist across a reload; Dismiss, Dismiss all and the failover notice never hide', async ({ page }) => {
  test.setTimeout(90_000);
  await setup(page, [manifest]);
  await proposal(page, 'panda.thread.errors.controls', 'Dismiss before Error details'); await back(page);
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.thread.errors.controls');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Hide Dismiss error', exact: true })).toHaveCount(0);
  await visibility(page, region, 'panda.thread.errors.controls', 'Error details', 'Hide');
  await back(page);
  const check = async () => {
    await expect.poll(() => order(detailRow(page))).toEqual(['dismiss-error', 'toggle-error']);
    await expect(detailRow(page).locator('[data-action="toggle-error"]')).toHaveAttribute('data-layout-hidden', '');
    await expect(detailRow(page).getByRole('button', { name: 'Dismiss error', exact: true })).toBeVisible();
    await expect(transcript(page).getByRole('button', { name: 'Dismiss all', exact: true })).toBeVisible();
  };
  await check();
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await check();
  // Keyboard: Tab reaches Dismiss then Dismiss all; the hidden Details is skipped, and focus never lands on it.
  await detailRow(page).getByRole('button', { name: 'Dismiss error', exact: true }).focus();
  await page.keyboard.press('Tab'); await expect(transcript(page).getByRole('button', { name: 'Dismiss all', exact: true })).toBeFocused();
  // A forged overlay cannot hide Dismiss.
  await page.evaluate(() => { const key = 'pandacode.extensions.layout.v1', value = JSON.parse(localStorage.getItem(key)!); value.visibility = { ...value.visibility, 'panda.thread.errors.controls/dismiss': false }; localStorage.setItem(key, JSON.stringify(value)); });
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await expect.poll(async () => Boolean(await props(page))).toBe(true);
  await expect(detailRow(page).getByRole('button', { name: 'Dismiss error', exact: true })).toBeVisible();
  // Dismissing with Details hidden still works once, with its Undo.
  await detailRow(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(rows(page)).toHaveCount(1); await toast(page).getByRole('button', { name: 'Undo', exact: true }).click(); await expect(rows(page)).toHaveCount(2);
  // Restore: Show brings Details back in place.
  const again = await explorer(page);
  await visibility(page, again, 'panda.thread.errors.controls', 'Error details', 'Show');
  await back(page);
  await expect(detailRow(page).locator('[data-action="toggle-error"]')).not.toHaveAttribute('data-layout-hidden', '');
  await expect(detailRow(page).getByRole('button', { name: 'Error details', exact: true })).toBeVisible();
});

test('Upstream errors: grant, revoke, fault, disable, uninstall and safe mode restore the upstream rows with the thread, draft and focus intact', async ({ page }) => {
  test.setTimeout(90_000);
  const other = structuredClone(manifest); other.id = 'other.upstream-errors'; other.permissions = ['tasks.transcript.read']; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.upstream-errors/timeline' }] };
  await setup(page, [manifest, other]);
  await proposal(page, 'panda.thread.errors.controls', 'Dismiss before Error details'); await back(page);
  // Two compatible providers: neither is selected automatically; a provider without the ui.contribute grant has no authority.
  await explorer(page); await expect(page.getByLabel('Transcript presentation', { exact: true })).toHaveValue(''); await back(page);
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  await select(page, 'other.upstream-errors/timeline');
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'PermissionDenied' });
  await select(page);
  expect(await act(page, 'error-details')).toEqual({ ok: true });
  await prompt(page).fill('Keep this draft'); await prompt(page).focus();
  const check = async () => {
    await expect(prompt(page)).toHaveValue('Keep this draft'); await expect(prompt(page)).toBeFocused();
    await expect(rows(page)).toHaveCount(2); await noEffects(page);
  };
  await check();
  // Revoke: leaving the provider ends captured control, and the user's own order stays.
  await explorer(page); await page.getByLabel('Transcript presentation', { exact: true }).selectOption(''); await back(page);
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  await expect.poll(() => order(detailRow(page))).toEqual(['dismiss-error', 'toggle-error']);
  await select(page);
  // A faulting transcript recipe falls back to the built-in transcript: captured control stops, the rows stay.
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('controlled fault'); }); });
  await expect(transcript(page)).not.toHaveAttribute('data-component-provider');
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  await prompt(page).focus(); await check();
  await select(page);
  // Disable, uninstall and safe mode put the host's own order back (details first) and remove every marker.
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.upstream-errors'));
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  await expect.poll(() => order(detailRow(page))).toEqual(['toggle-error', 'dismiss-error']);
  await prompt(page).focus(); await check();
  await page.evaluate(() => (window as any).__previewUpstreamErrorsUninstall('sample.upstream-errors'));
  await expect.poll(() => order(detailRow(page))).toEqual(['toggle-error', 'dismiss-error']);
  await expect(page.locator('#transcript [data-layout-hidden]')).toHaveCount(0);
  await prompt(page).focus(); await check();
  await page.evaluate(() => (window as any).__previewUpstreamErrorsSafeMode());
  await expect.poll(async () => (await props(page)).safeMode).toBe(true);
  expect(await act(page, 'error-details')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(page.locator('#transcript [data-layout-hidden], [data-extension-contribution^="sample.upstream-errors/"]')).toHaveCount(0);
  // The host still dismisses in safe mode, once, with Undo.
  await limitRow(page).getByRole('button', { name: 'Dismiss error', exact: true }).click();
  await expect(rows(page)).toHaveCount(1); await expect(toast(page)).toContainText('Error dismissed');
  await expect(prompt(page)).toHaveValue('Keep this draft');
});
