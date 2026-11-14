import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
// Browser fixtures only: every moodboard command is the in-memory preview store and the only image is a generated
// one-pixel PNG; no real or private image is read, and nothing outside the test profile needs cleanup.
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/moodboards/extension.json', import.meta.url), 'utf8'));
const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGP4z8AAAAMBAQDJ/pLvAAAAAElFTkSuQmCC', 'base64');
const MUTATIONS = ['create_moodboard', 'rename_moodboard', 'delete_moodboard', 'add_moodboard_image', 'import_moodboard_images', 'update_moodboard_image', 'remove_moodboard_image'];
const props = (page: Page) => page.evaluate(() => (window as any).__previewMoodboard());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
const count = (page: Page, command: string) => calls(page, command).then(list => list.length);
const touched = (page: Page) => page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command.includes('moodboard')).length);
const mutations = (page: Page) => page.evaluate(names => (window as any).__extensionsBaseline.calls.filter((call: any) => names.includes(call.command)).length, MUTATIONS);
const dialog = (page: Page) => page.locator('#dialog.moodboards-dialog');
const library = (page: Page) => page.locator('#moodboards-content');
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => { (window as any).__extensionsBaseline = { version: 1, calls: [] }; localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} })))); }, packages);
  await page.goto('/?extensions-baseline&moodboards-coverage&replacement'); await expect(page.locator('#prompt')).toBeEnabled();
}
async function explorer(page: Page) { await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click(); return page.getByRole('region', { name: 'Surface explorer' }); }
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function select(page: Page, id = 'sample.moodboards/images-first') { const region = await explorer(page); await region.getByLabel('Moodboard presentation', { exact: true }).selectOption(id); await back(page); }
async function open(page: Page) {
  await page.getByRole('button', { name: 'Project moodboards', exact: true }).click(); await expect(dialog(page)).toBeVisible();
  await expect.poll(async () => (await props(page))?.visible).toBe(true);
}
async function create(page: Page, name: string) {
  await dialog(page).getByRole('button', { name: 'New moodboard', exact: true }).click();
  await dialog(page).getByRole('textbox', { name: 'Moodboard name', exact: true }).fill(name);
  await dialog(page).getByRole('button', { name: 'Create moodboard', exact: true }).click();
  await expect(dialog(page).getByRole('textbox', { name: 'Board name', exact: true })).toHaveValue(name);
}
async function add(page: Page, name = 'Reference.png') {
  await dialog(page).locator('.moodboard-file-input').setInputFiles({ name, mimeType: 'image/png', buffer: pixel });
  await expect(dialog(page).getByRole('textbox', { name: `Caption for ${name}`, exact: true })).toBeVisible();
  await expect(dialog(page).locator('.moodboard-image-preview img').first()).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
}
/** Builds a captured action from the live presentation; `nth` picks among same-kind controls in host order. */
async function action(page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) {
  return page.evaluate(async ({ controlId, changes, nth }) => {
    const p = await (window as any).__previewMoodboard(), control = p.controls.filter((control: any) => control.controlId === controlId)[nth];
    if (!control) throw Error(`Missing ${controlId}`);
    return { contractVersion: 1, window: 'main', context: p.context, project: p.project, board: p.board, image: p.image, destination: p.destination, revision: p.revision, control: control.id, controlId, resource: control.resource, requestId: crypto.randomUUID(), ...changes };
  }, { controlId, changes, nth });
}
const send = (page: Page, input: unknown) => page.evaluate(input => (window as any).__previewMoodboardAction(input), input);
const act = async (page: Page, controlId: string, changes: Record<string, unknown> = {}, nth = 0) => send(page, await action(page, controlId, changes, nth));
const boardIndex = (page: Page, name: string) => library(page).locator('[data-mood-board]').evaluateAll((nodes, name) => nodes.findIndex(node => node.querySelector('.moodboard-list-name')?.textContent === name), name);
async function allow(page: Page) {
  await library(page).getByRole('button', { name: 'Allow moodboard control for sample.moodboards', exact: true }).click();
  await expect(library(page).getByRole('button', { name: 'Revoke moodboard control for sample.moodboards', exact: true })).toBeVisible();
}
/** A reopened library lists, then loads its newest board; requests before that are rightly Busy or stale. */
const loaded = (page: Page) => expect.poll(async () => { const p = await props(page); return Boolean(p.board) && !p.loading && !p.busy; }).toBe(true);
const proceed = (page: Page, label: string) => page.getByRole('menuitemradio', { name: `Continue: ${label}`, exact: true }).click();
const fault = (page: Page) => page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyMoodboardPresentation(document.querySelector('#moodboards-content'), () => { throw Error('controlled fault'); }); });

test('Moodboard extension: discovery/install/enable never touches boards; selected images-first state uses original handlers', async ({ page }) => {
  await setup(page); const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.moodboards', exact: true }).click();
  await expect(region.getByLabel('Moodboard presentation')).toHaveValue(''); await region.getByLabel('Moodboard presentation').selectOption('sample.moodboards/images-first'); await back(page);
  expect(await touched(page)).toBe(0);
  await open(page); await expect(page.locator('.moodboards[data-moodboard-provider="sample.moodboards/images-first"]')).toBeVisible();
  await create(page, 'Direction'); await add(page);
  await expect(library(page).locator('.moodboard-library')).toHaveCSS('order', '2');
  const p = await props(page);
  expect(p).toMatchObject({ visible: true, loading: false, busy: false, draft: false, create: false, confirm: false, preview: false, attach: true, boardName: 'Direction', boardCount: 1, imageCount: 1, image: '' });
  expect(p.destination).not.toBe(''); expect(p.board).not.toBe('');
  expect(p.controls.map((control: any) => control.controlId)).toEqual(['board-new', 'board-select', 'board-rename', 'image-add', 'board-delete', 'delete-cancel', 'image-preview', 'image-remove', 'image-caption', 'attach']);
  expect(JSON.stringify(p)).not.toMatch(/Reference\.png|data:image|session-1/);
  const before = await mutations(page);
  expect(await act(page, 'image-preview')).toEqual({ ok: true });
  const preview = page.getByRole('dialog', { name: 'Image preview', exact: true }); await expect(preview.locator('img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect.poll(async () => (await props(page)).preview).toBe(true); expect((await props(page)).image).not.toBe('');
  // Controls under the open preview are inert.
  expect(await act(page, 'board-delete')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  expect(await act(page, 'preview-close')).toEqual({ ok: true }); await expect(preview).toBeHidden(); expect((await props(page)).image).toBe('');
  expect(await act(page, 'board-new')).toEqual({ ok: true }); await expect(dialog(page).getByRole('textbox', { name: 'Moodboard name', exact: true })).toBeFocused();
  await page.keyboard.press('Escape'); await expect(dialog(page).getByRole('textbox', { name: 'Moodboard name', exact: true })).toBeHidden(); await expect(dialog(page)).toBeVisible();
  // Messages land in the library's own status line: the app toast sits under the modal library.
  await library(page).getByRole('button', { name: 'Reference tools', exact: true }).click(); await expect(library(page).getByRole('status')).toContainText('stay with PandaCode');
  await library(page).locator('.moodboard-image-card').click({ button: 'right' });
  for (const name of ['View image', 'Edit caption', 'Remove image', 'Reference tools']) await expect(page.getByRole('menuitem', { name, exact: true })).toBeVisible();
  await page.getByRole('menuitem', { name: 'Edit caption', exact: true }).click(); await expect(dialog(page).getByRole('textbox', { name: 'Caption for Reference.png' })).toBeFocused();
  await library(page).getByRole('button', { name: 'View Reference.png', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Reference tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(library(page).getByRole('button', { name: 'View Reference.png', exact: true })).toBeFocused(); await expect(dialog(page)).toBeVisible();
  expect(await mutations(page)).toBe(before);
});

test('Moodboard extension: zero extensions keep the original library, withhold metadata and select nothing', async ({ page }) => {
  await setup(page); await open(page); await create(page, 'Plain'); await add(page);
  const p = await props(page); expect(p.boardName).toBe(''); await expect(page.locator('[data-moodboard-provider]')).toHaveCount(0);
  await expect(library(page).locator('.moodboard-library')).toHaveCSS('order', '0');
  expect(await act(page, 'image-preview')).toEqual({ ok: false, reason: 'Revoked' });
  await expect(library(page).locator('[data-moodboard-consent]')).toBeHidden();
  await library(page).locator('.moodboard-image-card').click({ button: 'right' }); await expect(page.getByRole('menuitem', { name: 'View image', exact: true })).toHaveCount(0);
  await dialog(page).getByRole('button', { name: 'Attach to task', exact: true }).click(); await expect(dialog(page)).toBeHidden();
  await expect(page.locator('#attachments')).toContainText('Plain'); expect(await count(page, 'add_moodboard_image')).toBe(1);
});

test('Moodboard extension: removing and attaching need consent and a fresh choice; replayed and forged requests never retarget', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await open(page); await create(page, 'One'); await add(page, 'a.png');
  expect(await act(page, 'image-remove')).toEqual({ ok: false, reason: 'PermissionDenied' }); expect(await act(page, 'attach')).toEqual({ ok: false, reason: 'PermissionDenied' });
  await allow(page);
  for (const forged of [{ path: '/Users/you/a.png' }, { dataUrl: 'data:image/png;base64,AA==' }, { caption: 'x' }, { controlId: 'delete-confirm' }, { controlId: 'file-picker' }]) expect(await act(page, 'image-remove', forged)).toEqual({ ok: false, reason: 'InvalidArguments' });
  const request = await action(page, 'image-remove');
  expect(await send(page, request)).toEqual({ ok: true }); expect(await count(page, 'remove_moodboard_image')).toBe(0);
  await proceed(page, 'Remove image'); await expect(library(page).locator('.moodboard-image-card')).toHaveCount(0);
  expect(await count(page, 'remove_moodboard_image')).toBe(1); expect(await send(page, request)).toEqual({ ok: false, reason: 'StaleContext' });
  await add(page, 'b.png');
  const attach = await action(page, 'attach');
  expect(await send(page, attach)).toEqual({ ok: true }); expect(await send(page, attach)).toEqual({ ok: false, reason: 'AlreadyApplied' });
  await expect(page.locator('#attachments')).not.toContainText('One');
  await proceed(page, 'Attach to task'); await expect(dialog(page)).toBeHidden(); await expect(page.locator('#attachments')).toContainText('One');
  // A second library mount starts without consent; the original handler refuses a duplicate attachment.
  await open(page); await loaded(page); expect(await act(page, 'attach')).toEqual({ ok: false, reason: 'PermissionDenied' }); await allow(page);
  expect(await act(page, 'attach')).toEqual({ ok: true }); await proceed(page, 'Attach to task');
  await expect(page.locator('#toast')).toContainText('Moodboard already attached'); await page.keyboard.press('Escape');
  await expect(page.locator('#attachments [data-action="detach-moodboard"]')).toHaveCount(1);
  expect(await count(page, 'remove_moodboard_image')).toBe(1); expect(await count(page, 'delete_moodboard')).toBe(0);
});

test('Moodboard extension: pending load and add keep their board, run once and survive fault, disable and safe mode', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await open(page); await create(page, 'Alpha'); await create(page, 'Beta');
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'read_moodboard'; });
  await library(page).getByRole('button', { name: 'Alpha 0 images', exact: true }).click();
  await expect.poll(async () => (await props(page)).loading).toBe(true);
  expect(await act(page, 'board-select', {}, await boardIndex(page, 'Beta'))).toEqual({ ok: false, reason: 'Busy' });
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect(library(page).locator('.moodboard-list-item[aria-pressed="true"]')).toContainText('Alpha'); await expect.poll(async () => (await props(page)).loading).toBe(false);
  await page.evaluate(() => { (window as any).__extensionsBaseline.holdCommand = 'add_moodboard_image'; });
  await dialog(page).locator('.moodboard-file-input').setInputFiles({ name: 'held.png', mimeType: 'image/png', buffer: pixel });
  await expect.poll(async () => (await props(page)).busy).toBe(true);
  const beta = await action(page, 'board-select', {}, await boardIndex(page, 'Beta')); expect(await send(page, beta)).toEqual({ ok: false, reason: 'Busy' });
  const reads = await count(page, 'read_moodboard'), lists = await count(page, 'list_moodboards');
  await fault(page);
  await expect(page.locator('[data-moodboard-provider]')).toHaveCount(0); expect(await send(page, beta)).toEqual({ ok: false, reason: 'Revoked' });
  await page.evaluate(() => (window as any).__previewDisableExtension('sample.moodboards'));
  await page.evaluate(() => (window as any).__previewMoodboardSafeMode());
  await expect(dialog(page)).toBeVisible(); await expect(library(page).locator('.moodboard-library')).toHaveCSS('order', '0');
  await page.evaluate(() => (window as any).__extensionsBaseline.releaseCommand());
  await expect(dialog(page).getByRole('textbox', { name: 'Caption for held.png', exact: true })).toBeVisible();
  await expect(library(page).locator('.moodboard-image-preview img')).toHaveAttribute('src', /^data:image\/jpeg;base64,/);
  await expect(library(page).locator('.moodboard-list-item[aria-pressed="true"]')).toContainText('Alpha');
  expect(await count(page, 'add_moodboard_image')).toBe(1); expect((await calls(page, 'add_moodboard_image'))[0].args.name).toBe('held.png');
  // Recovery changed presentation only: no reload of the library or the board.
  expect(await count(page, 'read_moodboard')).toBe(reads); expect(await count(page, 'list_moodboards')).toBe(lists);
  expect(await send(page, beta)).toEqual({ ok: false, reason: 'Revoked' });
});

test('Moodboard extension: unsaved caption and name drafts stay; redrawing requests wait and recovery never replaces them', async ({ page }) => {
  await setup(page, [manifest]); await select(page); await open(page); await create(page, 'One'); await add(page); await create(page, 'Two');
  await library(page).getByRole('button', { name: 'One 1 image', exact: true }).click(); await expect(library(page).locator('.moodboard-list-item[aria-pressed="true"]')).toContainText('One');
  await allow(page);
  const caption = dialog(page).getByRole('textbox', { name: 'Caption for Reference.png', exact: true }); await caption.fill('Keep this spacing');
  await expect.poll(async () => (await props(page)).draft).toBe(true);
  expect(await act(page, 'board-select', {}, await boardIndex(page, 'Two'))).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'image-remove')).toEqual({ ok: false, reason: 'Busy' }); expect(await act(page, 'attach')).toEqual({ ok: false, reason: 'Busy' });
  expect(await act(page, 'image-caption')).toEqual({ ok: true }); await expect(caption).toBeFocused();
  await page.evaluate(() => (window as any).__previewMoodboardSafeMode());
  await expect(caption).toHaveValue('Keep this spacing'); await expect(caption).toBeFocused();
  expect(await count(page, 'update_moodboard_image')).toBe(0); expect(await act(page, 'image-caption')).toEqual({ ok: false, reason: 'Revoked' });
  await caption.blur(); await expect(library(page).getByRole('status')).toContainText('Caption saved');
  expect(await count(page, 'update_moodboard_image')).toBe(1); expect((await calls(page, 'update_moodboard_image'))[0].args.caption).toBe('Keep this spacing');
  const title = dialog(page).getByRole('textbox', { name: 'Board name', exact: true }); await title.fill('One revised'); await title.press('Enter');
  await expect(library(page).getByRole('navigation', { name: 'Moodboards' })).toContainText('One revised'); expect(await count(page, 'rename_moodboard')).toBe(1);
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeHidden(); await open(page);
  await expect(dialog(page).getByRole('textbox', { name: 'Caption for Reference.png', exact: true })).toHaveValue('Keep this spacing');
});

test('Moodboard extension: delete stays host-confirmed and the file chooser opens only from a fresh choice', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.moodboards.protected');
  await expect(region.getByRole('list', { name: 'Item visibility', exact: true }).getByRole('button')).toHaveCount(0); await back(page);
  await open(page); await create(page, 'Keep me');
  expect(await act(page, 'board-delete')).toEqual({ ok: true }); await expect(dialog(page)).toContainText('Delete this board and its images?');
  await expect.poll(async () => (await props(page)).confirm).toBe(true);
  expect(await act(page, 'delete-cancel')).toEqual({ ok: true }); await expect(dialog(page).getByText('Delete this board and its images?')).toBeHidden();
  expect(await count(page, 'delete_moodboard')).toBe(0);
  let chooser = false; page.on('filechooser', () => { chooser = true; });
  expect(await act(page, 'image-add')).toEqual({ ok: true }); await expect(page.getByRole('menuitemradio', { name: 'Continue: Add images', exact: true })).toBeVisible();
  expect(chooser).toBe(false); expect(await count(page, 'add_moodboard_image')).toBe(0);
  const picked = page.waitForEvent('filechooser'); await proceed(page, 'Add images');
  await (await picked).setFiles({ name: 'Chosen.png', mimeType: 'image/png', buffer: pixel });
  await expect(dialog(page).getByRole('textbox', { name: 'Caption for Chosen.png', exact: true })).toBeVisible();
  expect(await count(page, 'add_moodboard_image')).toBe(1); expect(await count(page, 'import_moodboard_images')).toBe(0);
});

test('Moodboard extension: conflict and future providers never auto-select; forged identity and switched boards are stale', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.moodboards'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.moodboards/images-first' }] };
  const future = structuredClone(other); future.id = 'future.moodboards'; future.contributes.components[0].id = 'future.moodboards/images-first'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const region = await explorer(page);
  await expect(region.getByLabel('Moodboard presentation')).toHaveValue(''); await expect(region.locator('option[value="future.moodboards/images-first"]')).toHaveAttribute('disabled', '');
  await back(page); await open(page); await expect(page.locator('[data-moodboard-provider]')).toHaveCount(0); await page.keyboard.press('Escape');
  await select(page, 'other.moodboards/images-first'); await open(page); await expect(library(page).locator('.moodboard-library')).toHaveCSS('order', '2');
  await create(page, 'First'); await add(page); await create(page, 'Second');
  await library(page).getByRole('button', { name: 'First 1 image', exact: true }).click(); await expect(dialog(page).getByRole('textbox', { name: 'Caption for Reference.png' })).toBeVisible();
  for (const field of ['project', 'board', 'image', 'destination']) expect(await act(page, 'image-preview', { [field]: 'forged' })).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await act(page, 'image-preview', { revision: 0 })).toEqual({ ok: false, reason: 'StaleContext' });
  const first = await action(page, 'image-preview');
  await library(page).getByRole('button', { name: 'Second 0 images', exact: true }).click(); await expect(library(page).locator('.moodboard-image-card')).toHaveCount(0);
  expect(await send(page, first)).toEqual({ ok: false, reason: 'StaleContext' }); await expect(page.getByRole('dialog', { name: 'Image preview', exact: true })).toHaveCount(0);
  expect(await count(page, 'remove_moodboard_image')).toBe(0);
});

test('Moodboard extension: compatible toolbar order, reversible visibility and focus-safe recovery', async ({ page }) => {
  await setup(page, [manifest]); await select(page);
  const region = await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.moodboards.controls');
  await region.getByRole('button', { name: 'Grant UI customization and select Delete before adding', exact: true }).click();
  await region.getByRole('button', { name: 'Hide Attach to task', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.moodboards.context');
  await region.getByRole('button', { name: 'Hide Remove image', exact: true }).click(); await back(page);
  await open(page); await create(page, 'Ordered'); await add(page);
  const order = () => library(page).locator('.moodboard-toolbar > button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-mood-action')));
  expect(await order()).toEqual(['delete', 'add']);
  await expect(dialog(page).getByRole('button', { name: 'Attach to task', exact: true })).toBeHidden();
  expect(await act(page, 'attach')).toEqual({ ok: false, reason: 'UnsupportedCapability' });
  await library(page).locator('.moodboard-image-card').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'View image', exact: true })).toBeVisible(); await expect(page.getByRole('menuitem', { name: 'Remove image', exact: true })).toHaveCount(0);
  await page.keyboard.press('Escape');
  const remove = dialog(page).getByRole('button', { name: 'Delete moodboard', exact: true }); await remove.focus();
  await page.evaluate(() => window.dispatchEvent(new Event('pandacode-components-change'))); await expect(remove).toBeFocused();
  await page.evaluate(() => (window as any).__previewMoodboardSafeMode());
  await expect(dialog(page).getByRole('button', { name: 'Attach to task', exact: true })).toBeVisible(); expect(await order()).toEqual(['add', 'delete']);
  await expect(remove).toBeFocused(); await expect(library(page).locator('.moodboard-library')).toHaveCSS('order', '0');
  expect(await mutations(page)).toBe(2);
});
