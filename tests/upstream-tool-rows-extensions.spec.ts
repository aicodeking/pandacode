import { expect, test, type Locator, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S0603 (upstream sync P6): the reworked tool rows and result cards (tool-activity.ts, tool-trace-*.ts) draw exactly as
 * upstream does with no package, and an installed package that asks for them gets one action marker per row and per
 * card, at `panda.thread.trace.actions` with `selection.kind` "tool-row" or "tool-card". This is browser-preview
 * evidence of the adapter (src/extensions/upstream-tool-rows.ts); it is not installed-WebView qualification, and the
 * native authority and lifecycle checks (grants, safe mode on disk, uninstall) are separate native fixtures. See
 * docs/extensions/upstream-tool-rows.md. */
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-tool-rows/manifest.json', import.meta.url), 'utf8'));
const ID = manifest.id as string;
const LOCATION = 'panda.thread.trace.actions';
const URL_QUERY = '/?extensions-baseline&upstream-tool-rows';

const at = Date.now() - 30_000;
const call = (id: string, name: string, input: unknown, output: string, status = 'completed') => ({ type: 'tool_activity', version: 1, id, name, status, input: JSON.stringify(input), output });
const CALLS = [
  call('tool-bash', 'Bash', { command: 'git status --short', description: 'Show the working tree' }, ' M src/a.ts\n?? notes.md'),
  call('tool-read', 'Read', { file_path: '/work/orbit/src/a.ts' }, 'export const a = 1;\nexport const b = 2;'),
  call('tool-mcp', 'mcp__orbit__lookup', { query: 'tokens' }, '{"hits":2,"items":["a","b"]}'),
];
const seeded = [
  { id: 91_001, sessionId: 'session-1', role: 'user', content: 'Check the tree and look up tokens.', createdAt: at },
  ...CALLS.map((entry, index) => ({ id: 91_002 + index, sessionId: 'session-1', role: 'tool', createdAt: at + (index + 1) * 100, content: JSON.stringify(entry) })),
  { id: 91_100, sessionId: 'session-1', role: 'assistant', content: 'The tree has two changes and the lookup found two hits.', createdAt: at + 5_000 },
];

const prompt = (page: Page) => page.locator('#prompt');
const rows = (page: Page) => page.locator('.turn-card .tool-activity.tool-trace[data-tool-key]');
const slots = (page: Page, part?: 'row' | 'card') => page.locator(part ? `[data-upstream-tool-slot="${part}"]` : '[data-upstream-tool-slot]');
const contributed = (scope: Page | Locator, id: string) => scope.locator(`[data-extension-contribution="${ID}/${id}"]`);
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command => ((window as any).__extensionsBaseline?.calls ?? []).filter((entry: any) => entry.command === command), command);

async function open(page: Page, packages: unknown[] = []) {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(({ packages, seeded }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    (window as any).__extensionsBaseline = { version: 1, calls: [], seedMessages: { 'session-1': seeded } };
    if (!localStorage.getItem('pandacode.preview.extensions.v1')) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(item => ({ manifest: item, enabled: true, icons: {} }))));
  }, { packages, seeded });
  await page.goto(URL_QUERY);
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.turn-card').last()).toContainText('The tree has two changes');
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport?.(); });
  return errors;
}
/** Opens the turn's activity and its tool group, then every row, so each result card is drawn. */
async function reveal(page: Page) {
  const card = page.locator('.turn-card').last();
  const activity = card.locator('details.turn-activity');
  if (await activity.count() && await activity.getAttribute('open') === null) await activity.locator(':scope > summary').click();
  const group = card.locator('details.tool-group').last();
  if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  await expect(rows(page)).toHaveCount(CALLS.length);
  for (const row of await rows(page).all()) if (await row.evaluate(node => node.tagName === 'DETAILS' && !(node as HTMLDetailsElement).open)) await row.locator(':scope > summary').click();
}
/** A row's drawn markup with this adapter's markers and mounted controls removed: what the renderer itself drew. */
const drawn = (page: Page) => rows(page).evaluateAll(nodes => nodes.map(node => {
  const copy = node.cloneNode(true) as HTMLElement;
  copy.querySelectorAll('[data-upstream-tool-slot], .extension-action-slot').forEach(slot => slot.remove());
  copy.removeAttribute('open');
  return copy.outerHTML.replace(/\sopen=""/g, '');
}));
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = async (page: Page) => { await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(prompt(page)).toBeVisible(); };
/** The real install and enable flow of the Extensions page (the preview transport of extensions_install/enable). */
async function install(page: Page) {
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${ID}`, exact: true }).click();
  await expect(page.getByRole('button', { name: `Disable ${ID}`, exact: true })).toBeVisible();
  return region;
}
const selection = (context: any) => context?.selection as { kind: string; ids: string[] };
/** Opens a contributed dialog action, loads its options (recording the captured context) and cancels it. */
async function captured(page: Page, trigger: Locator, tags: string) {
  const before = (await page.evaluate(() => (window as any).__extensionDialogTransport.calls.length)) as number;
  await trigger.click();
  await page.getByRole('button', { name: tags, exact: true }).click();
  await expect(page.getByRole('menuitemradio', { name: 'Alpha', exact: true })).toBeVisible();
  const recorded = await page.evaluate(() => (window as any).__extensionDialogTransport.calls);
  await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(recorded.length).toBeGreaterThan(before);
  return recorded.at(-1).context;
}

test('upstream tool rows: with no package every row and card draws as upstream and nothing is added', async ({ page }) => {
  const errors = await open(page);
  await reveal(page);
  await expect(slots(page)).toHaveCount(0);
  await expect(page.locator('.turn-card [data-extension-contribution], .tool-activity .extension-header-actions')).toHaveCount(0);
  // Upstream's row facts: kind, name and status are on the row, the sentence verb and the result card are drawn.
  expect(await rows(page).evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.toolKind))).toEqual(['shell', 'read', 'mcp']);
  await expect(rows(page).first().locator('.tool-trace-verb')).toHaveText('Ran');
  await expect(rows(page).first().locator('.tool-activity-body')).toContainText('notes.md');
  // A row still opens and closes from its summary by pointer and keyboard.
  const first = rows(page).first().locator(':scope > summary');
  await first.focus(); await page.keyboard.press('Enter');
  await expect(rows(page).first()).not.toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(rows(page).first()).toHaveAttribute('open', '');
  // The row and card count never changed by merely looking.
  await expect(rows(page)).toHaveCount(CALLS.length);
  expect(errors).toEqual([]);
});

test('upstream tool rows: an installed package gets a captured action on each row and card, the renderer is untouched', async ({ page }) => {
  test.setTimeout(90_000);
  const errors = await open(page);
  await reveal(page);
  const before = await drawn(page);
  await install(page); await back(page);
  await reveal(page);
  // One row marker and one card marker per call, each with only the actions that ask for its kind.
  await expect(slots(page, 'row')).toHaveCount(CALLS.length);
  await expect(slots(page, 'card')).toHaveCount(CALLS.length);
  for (const row of await rows(page).all()) {
    await expect(contributed(row.locator('[data-upstream-tool-slot="row"]'), 'row-notes')).toHaveCount(1);
    await expect(contributed(row.locator('[data-upstream-tool-slot="row"]'), 'row-flag')).toHaveCount(1);
    await expect(contributed(row.locator('[data-upstream-tool-slot="row"]'), 'card-notes')).toBeHidden();
    await expect(contributed(row.locator('[data-upstream-tool-slot="card"]'), 'card-notes')).toBeVisible();
    await expect(contributed(row.locator('[data-upstream-tool-slot="card"]'), 'row-notes')).toBeHidden();
  }
  // The renderer's own markup, badges and thumbnails are untouched.
  expect(await drawn(page)).toEqual(before);
  // Context: the action names the row's captured task, the tool call, its name and kind, and an MCP call's server.
  const mcp = rows(page).nth(2);
  const context = await captured(page, contributed(mcp.locator('[data-upstream-tool-slot="row"]'), 'row-notes'), 'Row tags');
  expect(selection(context).kind).toBe('tool-row');
  expect(context.sessionId).toBe('session-1');
  expect(selection(context).ids.slice(1)).toEqual(['mcp__orbit__lookup', 'mcp', 'orbit']);
  expect(JSON.stringify(context)).not.toMatch(/tokens|hits|notes\.md|a\.ts/);
  const card = await captured(page, contributed(mcp.locator('[data-upstream-tool-slot="card"]'), 'card-notes'), 'Card tags');
  expect(selection(card).kind).toBe('tool-card');
  expect(selection(card).ids[0]).toBe(selection(context).ids[0]);
  // A plain action runs without moving the row or sending anything.
  await contributed(rows(page).first().locator('[data-upstream-tool-slot="row"]'), 'row-flag').click();
  await expect(page.locator('.toast, [role="status"]').filter({ hasText: 'Row flagged.' }).first()).toBeVisible();
  await expect(rows(page).first()).toHaveAttribute('open', '');
  expect(await calls(page, 'send_message')).toEqual([]);
  expect(errors).toEqual([]);
});

test('upstream tool rows: a changed outcome is a new target and a stale control is gone', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, [manifest]);
  await reveal(page);
  const row = rows(page).first();
  const slot = row.locator('[data-upstream-tool-slot="row"]');
  await expect(slot).toHaveCount(1);
  const old = await slot.evaluate(node => { (window as any).__oldToolSlot = node; return (node as HTMLElement).dataset.upstreamToolIdentity; });
  // The call's outcome changes under the open row (a later run reports a failure): the old marker is replaced.
  await row.evaluate(node => { (node as HTMLElement).dataset.toolStatus = 'failed'; (node as HTMLElement).dataset.toolFailed = ''; });
  await expect.poll(() => slot.evaluate(node => (node as HTMLElement).dataset.upstreamToolIdentity)).not.toBe(old);
  expect(await page.evaluate(() => (window as any).__oldToolSlot.isConnected)).toBe(false);
  await expect(row.locator('[data-upstream-tool-slot="row"]')).toHaveCount(1);
  // The same outcome again keeps the mounted controls (no churn, no lost focus).
  const flag = contributed(row.locator('[data-upstream-tool-slot="row"]'), 'row-flag');
  await flag.focus();
  await row.evaluate(node => { (node as HTMLElement).dataset.toolStatus = 'failed'; });
  await expect(flag).toBeFocused();
  // A row that leaves the page takes its marker with it.
  await row.evaluate(node => node.remove());
  await expect(rows(page)).toHaveCount(CALLS.length - 1);
  await expect(slots(page, 'row')).toHaveCount(CALLS.length - 1);
});

test('upstream tool rows: keyboard reaches the actions and a row opens only from its own summary', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page, [manifest]);
  await reveal(page);
  const row = rows(page).first();
  const notes = contributed(row.locator('[data-upstream-tool-slot="row"]'), 'row-notes');
  await row.locator(':scope > summary').focus();
  await page.keyboard.press('Tab');
  await expect(notes).toBeFocused();
  await page.keyboard.press('Tab');
  await expect(contributed(row.locator('[data-upstream-tool-slot="row"]'), 'row-flag')).toBeFocused();
  // Space or Enter on a contributed button runs it and never toggles the row.
  await page.keyboard.press('Enter');
  await expect(row).toHaveAttribute('open', '');
  await page.keyboard.press('Shift+Tab'); await page.keyboard.press('Shift+Tab');
  await expect(row.locator(':scope > summary')).toBeFocused();
  await page.keyboard.press('Space');
  await expect(row).not.toHaveAttribute('open', '');
  await page.keyboard.press('Space');
  await expect(row).toHaveAttribute('open', '');
});

test('upstream tool rows: hide, reorder and restore the contributed actions, with focus kept', async ({ page }) => {
  test.setTimeout(120_000);
  await open(page, [manifest]);
  await reveal(page);
  const names = (row: Locator) => row.locator('[data-upstream-tool-slot="row"] [data-extension-contribution]:visible').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.extensionContribution!.split('/')[1]));
  expect(await names(rows(page).first())).toEqual(['row-notes', 'row-flag']);
  const region = await explorer(page);
  await region.getByLabel('Item location', { exact: true }).selectOption(LOCATION);
  // Reorder: Row flag moves before Row notes in every row, on the same nodes.
  await region.getByRole('button', { name: 'Move Row flag before', exact: true }).click();
  await back(page);
  for (const row of await rows(page).all()) expect(await names(row)).toEqual(['row-flag', 'row-notes']);
  // Hide: Row flag leaves every row but stays declared; Show restores it.
  const again = await explorer(page);
  await again.getByLabel('Item location', { exact: true }).selectOption(LOCATION);
  const visibility = again.getByRole('list', { name: 'Item visibility', exact: true });
  const hide = visibility.getByRole('button', { name: 'Hide Row flag', exact: true });
  for (let cursor = 0; cursor < 6 && !await hide.count(); cursor++) await again.getByRole('button', { name: 'Next items', exact: true }).click();
  await hide.click(); await back(page);
  for (const row of await rows(page).all()) expect(await names(row)).toEqual(['row-notes']);
  const restore = await explorer(page);
  await restore.getByLabel('Item location', { exact: true }).selectOption(LOCATION);
  const show = restore.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button', { name: 'Show Row flag', exact: true });
  for (let cursor = 0; cursor < 6 && !await show.count(); cursor++) await restore.getByRole('button', { name: 'Next items', exact: true }).click();
  await show.click(); await back(page);
  for (const row of await rows(page).all()) expect(await names(row)).toEqual(['row-flag', 'row-notes']);
  // The preference survives a reload.
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await reveal(page);
  expect(await names(rows(page).first())).toEqual(['row-flag', 'row-notes']);
});

test('upstream tool rows: revoke, disable, uninstall, fault and safe mode restore the upstream rows', async ({ page }) => {
  test.setTimeout(120_000);
  const errors = await open(page);
  await reveal(page);
  const before = await drawn(page);
  await install(page); await back(page); await reveal(page);
  await expect(slots(page, 'row')).toHaveCount(CALLS.length);
  // Revoke: Disable extension layouts withdraws only the layout proposals; the actions stay (a separate grant).
  const settings = await explorer(page);
  await settings.getByRole('button', { name: 'Disable extension layouts', exact: true }).click().catch(() => undefined);
  await back(page);
  await expect(slots(page, 'row')).toHaveCount(CALLS.length);
  // Disable removes every marker and control at once; Enable brings them back on the same rows.
  await page.evaluate(id => (window as any).__previewDisableExtension(id), ID);
  await expect(slots(page)).toHaveCount(0);
  await expect(page.locator(`[data-extension-contribution^="${ID}/"]`)).toHaveCount(0);
  expect(await drawn(page)).toEqual(before);
  await explorer(page);
  await page.getByRole('button', { name: `Enable ${ID}`, exact: true }).click();
  await back(page);
  await expect(slots(page, 'row')).toHaveCount(CALLS.length);
  // A fault in one row drops only that row's markers; the renderer and the other rows go on.
  await rows(page).first().evaluate(node => { Object.defineProperty(node, 'dataset', { get() { throw Error('controlled fault'); }, configurable: true }); });
  await rows(page).nth(1).evaluate(node => { (node as HTMLElement).dataset.toolStatus = 'failed'; });
  await expect(rows(page).first().locator('[data-upstream-tool-slot]')).toHaveCount(0);
  await expect(rows(page).nth(1).locator('[data-upstream-tool-slot="row"]')).toHaveCount(1);
  await expect(prompt(page)).toBeEnabled();
  // Safe mode: no marker, no control, the upstream rows only.
  await page.keyboard.press('ControlOrMeta+,');
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await back(page);
  await expect(slots(page)).toHaveCount(0);
  await expect(page.locator(`[data-extension-contribution^="${ID}/"]`)).toHaveCount(0);
  await expect(rows(page)).toHaveCount(CALLS.length);
  expect(errors.filter(message => !message.includes('controlled fault'))).toEqual([]);
});

test('upstream tool rows: uninstall removes the package and its markers, and the next load is the upstream rows', async ({ page }) => {
  test.setTimeout(90_000);
  await open(page);
  await reveal(page);
  await install(page); await back(page); await reveal(page);
  await expect(slots(page, 'card')).toHaveCount(CALLS.length);
  await explorer(page);
  await page.getByRole('button', { name: `Uninstall ${ID}`, exact: true }).click();
  await back(page);
  await expect(slots(page)).toHaveCount(0);
  await page.reload(); await expect(prompt(page)).toBeEnabled(); await reveal(page);
  await expect(slots(page)).toHaveCount(0);
  await expect(page.locator(`[data-extension-contribution^="${ID}/"]`)).toHaveCount(0);
});
