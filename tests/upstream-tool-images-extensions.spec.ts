import { expect, test, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';

/* S0604 (upstream sync P6): the tool image viewer (src/tool-image-viewer.ts) opens the image an agent viewed. A
 * package installed through the real Install local package and Enable flow adds owner-labelled notes and secondary
 * actions to its band (docs/extensions/upstream-tool-images.md); the viewer's own close, zoom, copy, reveal and
 * previous/next never change, and with no package, a disabled one, a faulted one or safe mode it is upstream's.
 * Browser fixtures only (Chromium and WebKit through the Vite preview): every native command is the preview mock, so
 * this is preview evidence, never installed-WebView acceptance. The native image authorization (`tool_image`) is
 * proved by tool_images.rs and tests/upstream-semantic-remote-images.spec.ts. */
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-tool-images/manifest.json', import.meta.url), 'utf8'));
const DIALOG = 'tool-image-viewer';
const PATHS = ['shots/first.png', 'shots/second.png', 'shots/third.png'];

const viewer = (page: Page) => page.locator('dialog.tool-image-viewer');
const band = (page: Page) => viewer(page).locator('.tool-image-viewer-plate > .dialog-extension-extras[data-dialog-accessory="tool-image-viewer"]');
const accessory = (page: Page) => page.evaluate(id => (window as any).__previewOwnedAccessory(id), DIALOG);
const admit = (page: Page, input: unknown) => page.evaluate(([id, input]) => (window as any).__previewOwnedAdmission(id, input), [DIALOG, input] as const);
const calls = (page: Page, command: string): Promise<any[]> => page.evaluate(command =>
  ((window as any).__extensionsBaseline?.calls ?? []).filter((entry: any) => entry.command === command).map((entry: any) => entry.args), command);

async function setup(page: Page, installed = false) {
  const at = Date.now() - 20_000;
  const seeded = [
    { id: 91_001, sessionId: 'session-1', role: 'user', content: 'Look at the screenshots.', createdAt: at },
    ...PATHS.map((path, index) => ({ id: 91_002 + index, sessionId: 'session-1', role: 'tool', createdAt: at + (index + 1) * 100,
      content: JSON.stringify({ type: 'tool_activity', version: 1, id: `tool-image-${index}`, name: 'Read', status: 'completed', input: JSON.stringify({ file_path: path }), output: '[Non-text content omitted]' }) })),
    { id: 91_100, sessionId: 'session-1', role: 'assistant', content: 'All three screenshots show the settings.', createdAt: at + 5_000 },
  ];
  await page.addInitScript(([seeded, installed, manifest]) => {
    localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null }));
    (window as any).__extensionsBaseline = { version: 1, calls: [], seedMessages: { 'session-1': seeded } };
    if (installed && localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }]));
  }, [seeded, installed, manifest] as const);
  await page.goto('/?extensions-baseline&owned-dialog-coverage&upstream-tool-images');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(page.locator('#prompt')).toBeEnabled();
}

/** Opens the viewer on the nth image through its original opener: the thumbnail in the tool row. */
async function openImage(page: Page, index = 0) {
  const card = page.locator('.turn-card').last();
  await expect(card).toContainText('All three screenshots show the settings.');
  const activity = card.locator('details.turn-activity');
  if (await activity.getAttribute('open') === null) await activity.locator(':scope > summary').click();
  const group = card.locator('details.tool-group').last();
  if (await group.count() && await group.getAttribute('open') === null) await group.locator(':scope > summary').click();
  const thumb = card.locator(`.tool-image-thumb[data-tool-image="${PATHS[index]}"]`);
  await expect(thumb).toHaveClass(/\bis-loaded\b/);
  await thumb.click();
  await expect(viewer(page)).toBeVisible();
  await expect(viewer(page).locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
  return thumb;
}

async function install(page: Page) {
  await page.keyboard.press('ControlOrMeta+,');
  await page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: `Enable ${manifest.id}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
}
const manager = async (page: Page) => {
  await page.keyboard.press('ControlOrMeta+,');
  await page.locator('.settings-nav-list').getByRole('tab', { name: 'Extensions', exact: true }).click();
};
const NOTE = `${manifest.id}: Image tools from this package; the viewer keeps its own zoom, copy, reveal and close.`;

test('upstream tool images: with no package the viewer is upstream\'s, keys step and Escape returns focus', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page);
  const thumb = await openImage(page, 0);
  await expect(band(page)).toBeHidden();
  await expect(viewer(page).locator('[data-extension-contribution]')).toHaveCount(0);
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('1 of 3');
  await expect(viewer(page).getByRole('button', { name: 'Close image', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('2 of 3');
  await viewer(page).getByRole('button', { name: 'Copy path', exact: true }).focus();
  await page.keyboard.press('ArrowLeft');
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('1 of 3');
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(thumb).toBeFocused();
  // The image is asked for the way upstream asks: the thread and path, one whole-image request per viewed image.
  for (const args of (await calls(page, 'tool_image')).filter(args => args.maxEdge === undefined)) expect(Object.keys(args).sort()).toEqual(['path', 'sessionId']);
  expect(errors).toEqual([]);
});

test('upstream tool images: an installed package adds notes and actions in its band and the viewer keeps its own controls', async ({ page }) => {
  const errors: string[] = []; page.on('pageerror', error => errors.push(error.message));
  await setup(page); await install(page);
  await openImage(page, 0);
  const slot = band(page);
  await expect(slot).toBeVisible();
  await expect(slot.locator('[data-extension-location="panda.dialog.tool-image-viewer.bodyExtras"]')).toHaveText(NOTE);
  const buttons = slot.locator('[data-extension-location="panda.dialog.tool-image-viewer.actions"] button');
  await expect(buttons).toHaveText(['Annotate image', 'Share image']);
  // Owner-labelled, and the viewer's own header and zoom stay where the host put them.
  for (const name of ['Close image', 'Copy path', 'Show actual size']) await expect(viewer(page).getByRole('button', { name })).toHaveCount(1);
  const captured = await accessory(page);
  expect(captured).toMatchObject({ contractVersion: 1, window: 'main', dialog: DIALOG, target: 'task', task: 'session-1' });
  expect(captured.mount).toMatch(/^tool-image-viewer\/\d+$/);
  expect(Object.keys(captured).sort()).toEqual(['contractVersion', 'dialog', 'mount', 'project', 'revision', 'target', 'task', 'window']);
  await buttons.first().click();
  await expect(slot.locator('.dialog-extension-status')).toHaveText('Annotate image: the viewer keeps its own controls');
  await expect(viewer(page)).toBeVisible();
  expect(await accessory(page)).toEqual(captured);
  // Arrow keys on a band control move between its own controls; they never step the image.
  await buttons.first().focus(); await page.keyboard.press('ArrowRight');
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('1 of 3');
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await expect(page.locator('.dialog-extension-extras')).toHaveCount(0);
  expect(await admit(page, captured)).toEqual({ ok: false, reason: 'Revoked' });
  expect(errors).toEqual([]);
});

test('upstream tool images: stepping to another image captures it afresh and rejects an action taken for the previous one', async ({ page }) => {
  await setup(page, true);
  await openImage(page, 0);
  const slot = band(page);
  await expect(slot).toBeVisible();
  const first = await accessory(page);
  expect(await admit(page, first)).toEqual({ ok: true });
  await viewer(page).getByRole('button', { name: 'Next image', exact: true }).click();
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('2 of 3');
  await expect.poll(async () => (await accessory(page))?.mount).not.toBe(first.mount);
  const second = await accessory(page);
  expect(second.revision).toBeGreaterThan(first.revision);
  expect(await admit(page, first)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await admit(page, second)).toEqual({ ok: true });
  await expect(slot).toBeVisible();
  // A thread switch behind the open viewer changes nothing in the capture.
  const other = await page.evaluate(() => [...document.querySelectorAll<HTMLElement>('.task-item[data-id]')].map(node => node.dataset.id).find(value => value && value !== 'session-1'));
  expect(other).toBeTruthy();
  await page.evaluate(id => (window as any).__previewSelectTask(id), other);
  expect(await accessory(page)).toEqual(second);
  expect(await admit(page, second)).toEqual({ ok: true });
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  expect(await admit(page, second)).toEqual({ ok: false, reason: 'Revoked' });
  // Reopening is a new mount: neither old capture is admitted.
  await page.evaluate(id => (window as any).__previewSelectTask(id), 'session-1');
  await openImage(page, 0);
  const reopened = await accessory(page);
  expect(reopened.mount).not.toBe(first.mount); expect(reopened.mount).not.toBe(second.mount);
  expect(await admit(page, first)).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await admit(page, { ...reopened, dialog: 'machine-link' })).toEqual({ ok: false, reason: 'UnsupportedCapability' });
});

test('upstream tool images: hide, show and restore the package actions, and keyboard focus stays in the viewer', async ({ page }) => {
  await setup(page, true);
  await manager(page);
  const region = page.getByRole('region', { name: 'Surface explorer' });
  await region.getByRole('button', { name: 'Hide Annotate image', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await openImage(page, 0);
  const buttons = band(page).locator('[data-extension-location="panda.dialog.tool-image-viewer.actions"] button');
  await expect(buttons.filter({ hasText: 'Annotate image' })).toBeHidden();
  await expect(buttons.filter({ hasText: 'Share image' })).toBeVisible();
  // Keyboard: Tab from the close button reaches the visible band action without leaving the dialog; Escape closes.
  await viewer(page).getByRole('button', { name: 'Close image', exact: true }).focus();
  for (let index = 0; index < 12 && !(await buttons.filter({ hasText: 'Share image' }).evaluate(node => node === document.activeElement)); index++) await page.keyboard.press('Tab');
  await expect(buttons.filter({ hasText: 'Share image' })).toBeFocused();
  expect(await viewer(page).evaluate(node => node.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  await manager(page);
  await region.getByRole('button', { name: 'Reset global layout', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await openImage(page, 0);
  await expect(buttons).toHaveText(['Annotate image', 'Share image']);
});

test('upstream tool images: disable, uninstall, fault and safe mode remove only the band and keep the viewer', async ({ page }) => {
  await setup(page, true);
  await openImage(page, 1);
  const slot = band(page);
  await expect(slot).toBeVisible();
  const counter = viewer(page).locator('.tool-image-viewer-count');
  await expect(counter).toHaveText('2 of 3');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.tool-image-viewer'); });
  await expect(page.locator('dialog.tool-image-viewer [data-extension-contribution]')).toHaveCount(0);
  await expect(viewer(page)).toBeVisible(); await expect(counter).toHaveText('2 of 3');
  await expect(viewer(page).locator('.tool-image-viewer-image')).toHaveAttribute('src', /^data:image\//);
  // A faulted record empties the band at once; the viewer and its image stay.
  await page.evaluate(async manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); await (window as any).__previewDialogRefresh(); }, manifest);
  await expect(slot.getByRole('button', { name: 'Annotate image', exact: true })).toBeVisible();
  await page.evaluate(async () => { localStorage.setItem('pandacode.preview.extensions.v1', '{"broken":'); await (window as any).__previewDialogRefresh(); });
  await expect(page.locator('dialog.tool-image-viewer [data-extension-contribution]')).toHaveCount(0);
  await expect(viewer(page)).toBeVisible(); await expect(counter).toHaveText('2 of 3');
  // Safe mode does the same.
  await page.evaluate(async manifest => { localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([{ manifest, enabled: true, icons: {} }])); await (window as any).__previewDialogRefresh(); }, manifest);
  await expect(slot.getByRole('button', { name: 'Share image', exact: true })).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewDialogSafeMode(); });
  await expect(page.locator('dialog.tool-image-viewer [data-extension-contribution]')).toHaveCount(0);
  await expect(viewer(page)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(viewer(page)).toHaveCount(0);
  // Uninstall through the manager leaves the viewer upstream's on the next opening.
  await page.goto('/?extensions-baseline&owned-dialog-coverage&upstream-tool-images');
  await expect(page.locator('#prompt')).toBeEnabled();
  await manager(page);
  await page.getByRole('button', { name: `Uninstall ${manifest.id}`, exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace' }).click();
  await openImage(page, 0);
  await expect(band(page)).toBeHidden(); await expect(viewer(page).locator('[data-extension-contribution]')).toHaveCount(0);
  await expect(viewer(page).locator('.tool-image-viewer-count')).toHaveText('1 of 3');
});
