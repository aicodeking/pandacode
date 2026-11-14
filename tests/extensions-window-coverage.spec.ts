import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
/**
 * Auxiliary-window and native-menu coverage (T57). Browser fixtures only: the preview's synthetic IPC,
 * shared storage and synthetic OS-menu delivery. The native menu build, check state, layout and dispatch
 * policy are proved by the Rust tests named in windowCoverage; installed-window qualification is deferred.
 */
const fixture = (name: string) => JSON.parse(readFileSync(new URL(`./fixtures/extensions/${name}/extension.json`, import.meta.url), 'utf8'));
const coverage = fixture('window-coverage'), companion = fixture('sample-project-helper');
const ledger = JSON.parse(readFileSync(new URL('./fixtures/extensions/surfaces.json', import.meta.url), 'utf8'));
const windows = ledger.windowCoverage['panda.windows'];
const LAYOUT = 'pandacode.extensions.layout.v1';
const WINDOWS = {
  tray: { url: '/?view=tray', core: 'Open PandaCode', width: 340 },
  launcher: { url: '/?view=launcher', core: 'Close launcher', width: 650 },
  'agents-dock': { url: '/agents-dock.html', core: 'Unpin widget', width: 650 },
} as const;
type Label = keyof typeof WINDOWS;
const id = (local: string) => `sample.window-coverage/${local}`;
const contribution = (page: Page, local: string) => page.locator(`[data-extension-contribution="${id(local)}"]`);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Window coverage format — sample.window-coverage', exact: true });
const nativeLayout = (page: Page) => page.evaluate(() => (window as any).__previewNativeLayout ?? null);

async function seed(context: BrowserContext, packages: unknown[] = [coverage, companion]) {
  await context.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.agents-dock', 'true');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
}
async function main(page: Page, contributions = true) {
  await page.goto('/?window-laboratory'); await expect(page.locator('#prompt')).toBeEnabled();
  if (contributions) await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
}
async function auxiliary(context: BrowserContext, label: Label) {
  const page = await context.newPage(); await page.setViewportSize({ width: WINDOWS[label].width, height: 560 });
  await page.goto(WINDOWS[label].url);
  if (label === 'agents-dock') await page.getByRole('button', { name: /Running agents.*Press to expand/ }).click();
  return page;
}
async function explorer(page: Page, location?: string) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  const region = page.getByRole('region', { name: 'Surface explorer' });
  if (location) await region.getByLabel('Item location', { exact: true }).selectOption(location);
  return region;
}
async function openTrayTools(page: Page) {
  await contribution(page, 'tray-tools').click();
  await expect(page.getByRole('menuitemcheckbox', { name: 'Follow running agents', exact: true })).toBeVisible();
}

test('Window coverage: every auxiliary-window, tray and native-menu member has an adapter or a specific exception, a fallback and separated evidence', () => {
  const families = ledger.families.filter((family: any) => ['panda.tray', 'panda.windows'].includes(family.id)).flatMap((family: any) => family.members.map(([local]: string[]) => `${family.id}.${local}`));
  expect(Object.keys(windows.members).sort()).toEqual([...families, 'panda.agents.widget'].sort());
  for (const [member, row] of Object.entries<any>(windows.members)) {
    expect(['adapter', 'protected', 'platform'], member).toContain(row.disposition);
    expect(row.fallback.length, member).toBeGreaterThan(20);
    if (row.disposition !== 'adapter') expect(row.reason, member).toMatch(/\w{4,}.*\w{4,}/);
    for (const path of row.evidence) expect(() => readFileSync(new URL(`../${path}`, import.meta.url)), path).not.toThrow();
  }
  expect(JSON.stringify(windows)).not.toMatch(/\blater\b/i);
  // Native evidence is real Rust adapter/menu policy; browser evidence is synthetic preview IPC.
  expect(windows.evidence.native.every((path: string) => path.endsWith('.rs'))).toBe(true);
  expect(windows.evidence.browser.every((path: string) => path.endsWith('.spec.ts'))).toBe(true);
  expect(windows.deferred).toMatch(/deferred, not passed/);
  expect(ledger.controlsAudit.gaps['panda.agents/widget-window']).toMatchObject({ severity: 'closed', lead: 'T57' });
  const configs = ['../playwright.config.ts', '../playwright.webkit.config.ts', '../.github/workflows/ci.yml'].map(path => readFileSync(new URL(path, import.meta.url), 'utf8'));
  for (const config of configs) expect(config).toContain('extensions-window-coverage.spec.ts');
});

test('Window coverage: with zero extensions every auxiliary window keeps its core controls and recovery, and its protected controls are discoverable', async ({ page, context }) => {
  await seed(context, []);
  for (const label of Object.keys(WINDOWS) as Label[]) {
    const window = await auxiliary(context, label);
    await expect(window.locator('[data-extension-contribution]')).toHaveCount(0);
    await expect(window.getByRole('button', { name: WINDOWS[label].core, exact: true }).last()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Disable extensions for this launch', exact: true })).toBeVisible();
    await window.close();
  }
  await main(page, false);
  const region = await explorer(page, 'panda.agentsDock.protected');
  const items = region.getByRole('list', { name: 'Surface items' });
  await expect(items.locator('[data-catalog-item="panda.agentsDock.protected/unpin"]')).toContainText('Unpin widget — closes the pinned window');
  await expect(items.locator('[data-catalog-item="panda.agentsDock.protected/lifetime"]')).toContainText('Operations: inspect');
  // Protected window controls never offer a hide toggle.
  await expect(region.getByRole('list', { name: 'Item visibility' }).getByRole('button')).toHaveCount(0);
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.tray.protected');
  await expect(items.locator('[data-catalog-item="panda.tray.protected/native-icons"]')).toContainText('platform: OS menus take raster images');
  await expect(items.locator('[data-catalog-item="panda.tray.protected/recovery"]')).toContainText('Operations: inspect');
  // Native menu limits are discoverable with their host alternatives.
  await expect(region.getByRole('list', { name: 'Public surfaces' })).toContainText('Fallbacks: select → host-quick-pick, form → main-dialog, icons → panda.tray.actions, status → panda.tray.actions, badge → panda.tray.actions');
});

test('Window coverage: tray popover check/radio state, status, host hide/reorder and recovery keep core controls and preferences', async ({ page, context }) => {
  test.setTimeout(60_000);
  await seed(context); await main(page); await page.locator('#prompt').fill('Keep this main draft');
  const tray = await auxiliary(context, 'tray');
  await expect(contribution(tray, 'tray-tools').locator('svg rect')).toHaveCount(1);
  await expect(contribution(tray, 'tray-state')).toHaveText('Coverage ready');
  await openTrayTools(tray);
  await expect(tray.getByRole('menuitemcheckbox', { name: 'Follow running agents', exact: true })).toHaveAttribute('aria-checked', 'false');
  await expect(tray.getByRole('menuitemradio', { name: 'Compact', exact: true })).toHaveAttribute('aria-checked', 'true');
  await tray.getByRole('menuitemcheckbox', { name: 'Follow running agents', exact: true }).click();
  await expect(tray.locator('.extension-window-notice')).toHaveText('Follow preference changed');
  await openTrayTools(tray);
  await expect(tray.getByRole('menuitemcheckbox', { name: 'Follow running agents', exact: true })).toHaveAttribute('aria-checked', 'true');
  await tray.getByRole('menuitemradio', { name: 'Comfortable', exact: true }).click();
  await openTrayTools(tray);
  await expect(tray.getByRole('menuitemradio', { name: 'Comfortable', exact: true })).toHaveAttribute('aria-checked', 'true');
  await expect(tray.getByRole('menuitemradio', { name: 'Compact', exact: true })).toHaveAttribute('aria-checked', 'false');
  await tray.keyboard.press('Escape'); await expect(contribution(tray, 'tray-tools')).toBeFocused();
  // The main window's host explorer hides and reorders the popover contributions through shared layout storage.
  const region = await explorer(page, 'panda.tray.actions');
  await region.getByRole('button', { name: 'Hide Coverage state', exact: true }).click();
  await expect(contribution(tray, 'tray-state')).toBeHidden();
  await region.getByRole('button', { name: 'Show Coverage state', exact: true }).click();
  await expect(contribution(tray, 'tray-state')).toBeVisible();
  const order = () => tray.locator('[data-extension-contribution^="sample.window-coverage/"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.extensionContribution));
  await expect.poll(order).toEqual([id('tray-state'), id('tray-tools')]);
  await region.getByRole('list', { name: 'Order sample.window-coverage panda.tray.actions' }).getByRole('button', { name: 'Move Coverage tools before', exact: true }).click();
  await expect.poll(order).toEqual([id('tray-tools'), id('tray-state')]);
  await expect(region.getByRole('alert')).toHaveCount(0);
  await expect(tray.getByRole('button', { name: 'Open PandaCode', exact: true }).last()).toBeVisible(); await expect(tray.getByRole('button', { name: 'Quit', exact: true })).toBeVisible();
  // Recovery from the popover removes contributions everywhere, keeps the draft and retains the order preference.
  await tray.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(tray.locator('[data-extension-contribution]')).toHaveCount(0);
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('Keep this main draft');
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).orders['panda.tray.actions'], LAYOUT)).toEqual([id('tray-tools'), id('tray-state')]);
});

test('Window coverage: the main window sends the OS menu only its global hide/order, and native selections open host alternatives', async ({ page, context }) => {
  test.setTimeout(60_000);
  await seed(context); await main(page);
  await expect.poll(() => nativeLayout(page)).toEqual({ hidden: [], order: [id('native-extra'), id('native-menu'), id('native-status')] });
  const region = await explorer(page, 'panda.tray.menu');
  await region.getByRole('button', { name: 'Hide Native coverage more', exact: true }).click();
  await expect.poll(() => nativeLayout(page)).toEqual({ hidden: [id('native-extra')], order: [id('native-extra'), id('native-menu'), id('native-status')] });
  await region.getByRole('list', { name: 'Order sample.window-coverage panda.tray.menu' }).getByRole('button', { name: 'Move Native coverage tools before', exact: true }).click();
  await expect.poll(async () => (await nativeLayout(page))?.order).toEqual([id('native-menu'), id('native-extra'), id('native-status')]);
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click(); await expect(page.locator('#prompt')).toBeVisible();
  // A native check item runs its declared command; a native select opens the main host quick pick.
  await page.evaluate(local => (window as any).__previewNativeExtensionAction(local), id('native-follow'));
  await expect(page.locator('#toast')).toHaveText('Follow preference changed');
  await page.evaluate(local => (window as any).__previewNativeExtensionAction(local), id('native-form'));
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search Coverage format', exact: true })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog(page)).not.toBeVisible();
  // Safe recovery sends an empty layout while the user's preferences stay stored for the next launch.
  await explorer(page); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect.poll(() => nativeLayout(page)).toEqual({ hidden: [], order: [] });
  expect(await page.evaluate(key => JSON.parse(localStorage.getItem(key)!).visibility, LAYOUT)).toMatchObject({ [id('native-extra')]: false });
});

test('Window coverage: forged cross-window requests and passive native entries are refused without opening UI', async ({ page, context }) => {
  await seed(context); await main(page); await page.locator('#prompt').fill('Untouched draft');
  const forge = (request: Record<string, string>) => page.evaluate(request => window.dispatchEvent(new StorageEvent('storage', { key: 'pandacode.preview.extensions.presentation', newValue: JSON.stringify({ request, nonce: crypto.randomUUID() }) })), request);
  // A dock action claimed from the tray surface, a passive status and a raw command ID never resolve.
  for (const request of [{ surfaceId: 'panda.tray.actions', id: id('dock-form'), version: '1.0.0' }, { surfaceId: 'panda.tray.menu', id: id('native-status'), version: '1.0.0' }, { surfaceId: 'panda.tray.menu', id: id('form'), version: '1.0.0' }, { surfaceId: 'panda.tray.protected', id: 'panda.tray.protected/quit', version: '1.0.0' }]) {
    await forge(request);
    await expect(page.locator('#toast'), request.id).toContainText('PermissionDenied');
    await expect(dialog(page)).toHaveCount(0);
  }
  await expect(page.locator('#prompt')).toHaveValue('Untouched draft');
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
});

test('Window coverage: closing the pinned widget window cancels only its form; other windows, packages and the draft survive', async ({ page, context }) => {
  test.setTimeout(60_000);
  await seed(context); await main(page); await page.locator('#prompt').fill('Draft kept across windows');
  const tray = await auxiliary(context, 'tray'), dock = await auxiliary(context, 'agents-dock');
  await expect(contribution(dock, 'dock-tools')).toBeVisible(); await expect(contribution(tray, 'tray-tools')).toBeVisible();
  await contribution(dock, 'dock-tools').click();
  await dock.getByRole('menuitem', { name: 'Choose coverage format', exact: true }).click();
  await expect(dialog(page)).toBeVisible(); await expect(dock.locator('dialog')).toHaveCount(0);
  await dock.close();
  await expect(dialog(page)).not.toBeVisible();
  await expect(contribution(tray, 'tray-tools')).toBeVisible();
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
  await expect(page.locator('#prompt')).toHaveValue('Draft kept across windows');
  await expect(page.locator('#toast')).not.toHaveText('Window coverage confirmed');
  // Reopening (Pin) remounts the registrations; Unpin is host-owned and touches no package.
  const reopened = await auxiliary(context, 'agents-dock');
  await expect(contribution(reopened, 'dock-tools')).toBeVisible();
  await reopened.getByRole('button', { name: 'Unpin widget', exact: true }).click();
  await expect(contribution(tray, 'tray-tools')).toBeVisible();
  const region = await explorer(page);
  await expect(page.getByRole('button', { name: 'Disable sample.window-coverage', exact: true })).toHaveCount(1);
  await expect(region).toBeVisible();
});

test('Window coverage: a failed package batch fails closed in auxiliary windows and the OS menu while core work stays usable', async ({ page, context }) => {
  await seed(context, [coverage, coverage]);
  for (const label of Object.keys(WINDOWS) as Label[]) {
    const window = await auxiliary(context, label);
    await expect(window.locator('[data-extension-contribution]')).toHaveCount(0);
    await expect(window.getByRole('button', { name: WINDOWS[label].core, exact: true }).last()).toBeVisible();
    await expect(window.getByRole('button', { name: 'Disable extensions for this launch', exact: true })).toBeVisible();
    await window.close();
  }
  await main(page, false);
  await expect.poll(() => nativeLayout(page)).toEqual({ hidden: [], order: [] });
  await page.locator('#prompt').fill('Still usable'); await expect(page.locator('#prompt')).toHaveValue('Still usable');
});
