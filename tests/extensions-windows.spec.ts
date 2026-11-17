import { test, expect, type Page, type BrowserContext } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/window-laboratory/extension.json', import.meta.url), 'utf8'));
const companion = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const families = [
  { label: 'tray', url: '/?view=tray', id: 'tray', core: 'Open PandaCode' },
  { label: 'launcher', url: '/?view=launcher', id: 'launcher', core: 'Close launcher' },
  { label: 'agents-dock', url: '/agents-dock.html', id: 'dock', core: 'Unpin widget' },
];
async function seed(context: BrowserContext, packages = [manifest, companion]) {
  await context.addInitScript(packages => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    localStorage.setItem('pandacode.preview.agents-dock', 'true');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
}
async function main(page: Page) {
  await page.goto('/?window-laboratory'); await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
}
async function auxiliary(context: BrowserContext, family: typeof families[number]) {
  const page = await context.newPage(); await page.setViewportSize({ width: family.label === 'tray' ? 340 : 650, height: 560 });
  await page.goto(family.url);
  if (family.label === 'agents-dock') await page.getByRole('button', { name: /Running agents.*Press to expand/ }).click();
  return page;
}
const trigger = (page: Page, id: string) => page.locator(`[data-extension-contribution="sample.window-laboratory/${id}"]`);
const dialog = (page: Page) => page.getByRole('dialog', { name: 'Window laboratory select — sample.window-laboratory', exact: true });
async function openForm(page: Page, id: string) {
  await trigger(page, id).click();
  await expect(page.getByRole('menuitem', { name: 'Reports', exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Choose report format', exact: true })).toBeFocused();
  await page.keyboard.press('Enter');
}
for (const family of families) {
  test(`extensions windows: ${family.label} has no inherited workspace and retains core controls with zero extensions`, async ({ context }) => {
    await seed(context, []); const page = await auxiliary(context, family);
    await expect(page.locator('[data-extension-contribution]')).toHaveCount(0);
    await expect(page.locator('#prompt, .workspace')).toHaveCount(0);
    await expect(page.getByRole('button', { name: family.core, exact: true }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disable extensions for this launch', exact: true })).toBeVisible();
    if (family.label === 'tray') await expect(page.getByRole('button', { name: 'Quit', exact: true })).toBeVisible();
    if (family.label === 'launcher') { await page.locator('#launcher-prompt').fill('Keep launcher draft'); await expect(page.locator('#launcher-prompt')).toHaveValue('Keep launcher draft'); }
  });
  test(`extensions windows: ${family.label} scoped submenu/icons, Escape and host form select work without replacing core UI`, async ({ page: workspace, context }) => {
    await seed(context); await main(workspace); await workspace.locator('#prompt').fill('Keep main draft');
    const page = await auxiliary(context, family);
    await expect(trigger(page, family.id)).toBeVisible(); await expect(trigger(page, family.id).locator('svg rect')).toHaveCount(1);
    await trigger(page, family.id).click(); await page.keyboard.press('ArrowRight');
    await expect(page.getByRole('menuitem', { name: 'Choose report format', exact: true }).locator('svg rect')).toHaveCount(1);
    await page.keyboard.press('Escape'); await expect(page.getByRole('menuitem', { name: 'Reports', exact: true })).toBeFocused();
    await page.keyboard.press('Escape'); await expect(trigger(page, family.id)).toBeFocused();
    await expect(page.getByRole('button', { name: family.core, exact: true }).last()).toBeVisible();
    await openForm(page, family.id); await expect(dialog(workspace)).toBeVisible();
    await expect(page.locator('dialog')).toHaveCount(0);
    await workspace.getByRole('button', { name: 'Window report format', exact: true }).click();
    await workspace.getByRole('searchbox', { name: 'Search Window report format', exact: true }).fill('Long');
    await workspace.getByRole('menuitemradio', { name: 'Long report', exact: true }).click();
    await dialog(workspace).getByRole('button', { name: 'Confirm', exact: true }).click();
    await expect(workspace.locator('#toast')).toHaveText('Window report confirmed');
    await expect(workspace.locator('#toast')).toBeVisible();
    await expect(workspace.locator('#prompt')).toHaveValue('Keep main draft');
    await page.close(); await expect(workspace.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
  });
}
test('extensions windows: synthetic native menu select opens host quick pick immediately and denied command never opens UI', async ({ page, context }) => {
  await seed(context); await main(page);
  await page.evaluate(() => (window as any).__previewNativeExtensionAction('sample.window-laboratory/native-form'));
  await expect(dialog(page)).toBeVisible();
  await expect(page.getByRole('searchbox', { name: 'Search Window report format', exact: true })).toBeVisible();
  await expect(page.getByRole('menuitemradio', { name: 'Unavailable report', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await expect(dialog(page)).toBeVisible();
  await page.keyboard.press('Escape'); await expect(dialog(page)).not.toBeVisible(); await expect(page.locator('#prompt')).toBeFocused();
  // Q116 (R0306): retained. A native menu entry whose command the package does not own is refused before any UI opens
  // (predictability: a menu item runs only its declared command; not a security limit).
  await page.evaluate(() => (window as any).__previewNativeExtensionAction('sample.window-laboratory/native-denied'));
  await expect(page.locator('#toast')).toContainText('PermissionDenied'); await expect(page.locator('#toast')).toBeVisible(); await expect(dialog(page)).not.toBeVisible();
});
test('extensions windows: closing one secondary window leaves other registrations and workspace draft intact', async ({ page, context }) => {
  await seed(context); await main(page); await page.locator('#prompt').fill('Persistent main draft');
  const original = await page.locator('[data-extension-contribution="sample.project-helper/header"]').elementHandle();
  const tray = await auxiliary(context, families[0]), launcher = await auxiliary(context, families[1]);
  await expect(trigger(tray, 'tray')).toBeVisible(); await expect(trigger(launcher, 'launcher')).toBeVisible();
  await tray.close(); await expect(trigger(launcher, 'launcher')).toBeVisible();
  expect(await original!.evaluate(node => node.isConnected)).toBe(true);
  await expect(page.locator('#prompt')).toHaveValue('Persistent main draft');
  await page.locator('[data-extension-contribution="sample.project-helper/header"]').click(); await expect(page.locator('#toast')).toHaveText('Extension installed successfully');
});
test('extensions windows: main disable cancels forwarded form and revokes only that owner in every open window', async ({ page, context }) => {
  await seed(context); await main(page); const tray = await auxiliary(context, families[0]), launcher = await auxiliary(context, families[1]);
  await openForm(tray, 'tray'); await expect(dialog(page)).toBeVisible();
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.window-laboratory'); });
  await expect(dialog(page)).not.toBeVisible();
  await expect(trigger(tray, 'tray')).toHaveCount(0); await expect(trigger(launcher, 'launcher')).toHaveCount(0);
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
  await expect(tray.getByRole('button', { name: 'Open PandaCode', exact: true }).last()).toBeVisible(); await expect(tray.getByRole('button', { name: 'Quit', exact: true })).toBeVisible();
});
test('extensions windows: protected auxiliary recovery disables contributions in all windows without changing draft', async ({ page, context }) => {
  await seed(context); await main(page); await page.locator('#prompt').fill('Recover this draft'); const tray = await auxiliary(context, families[0]);
  await expect(trigger(tray, 'tray')).toBeVisible();
  await tray.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click();
  await expect(tray.locator('[data-extension-contribution]')).toHaveCount(0); await expect(page.locator('[data-extension-contribution]')).toHaveCount(0);
  await expect(page.locator('#prompt')).toHaveValue('Recover this draft'); await expect(tray.getByRole('button', { name: 'Quit', exact: true })).toBeVisible();
});
test('extensions windows: actual host UI installs/enables the fixture and secondary reload discovers it', async ({ page, context }) => {
  await seed(context, [companion]); await main(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click(); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.window-laboratory', exact: true }).click();
  const tray = await auxiliary(context, families[0]); await expect(trigger(tray, 'tray')).toBeVisible();
  await tray.reload(); await expect(trigger(tray, 'tray')).toBeVisible();
});
test('extensions windows: conflicting package batch fails closed in every actual auxiliary window while recovery stays reachable', async ({ context }) => {
  await seed(context, [manifest, manifest]);
  for (const family of families) {
    const page = await auxiliary(context, family);
    await expect(page.locator('[data-extension-contribution]')).toHaveCount(0);
    await expect(page.getByRole('button', { name: family.core, exact: true }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: 'Disable extensions for this launch', exact: true })).toBeVisible();
    await page.close();
  }
});
test('extensions windows: duplicate native lifecycle notifications retain the exact focused form and registration', async ({ page, context }) => {
  await seed(context); await main(page);
  const original = await page.locator('[data-extension-contribution="sample.project-helper/header"]').elementHandle();
  await page.evaluate(() => (window as any).__previewNativeExtensionAction('sample.window-laboratory/native-form'));
  await expect(dialog(page)).toBeVisible(); await page.keyboard.press('Escape');
  const select = page.getByRole('button', { name: 'Window report format', exact: true }); await select.focus();
  const field = await select.elementHandle();
  // The opt-in preview hook awaits the real manager snapshot path, not an arbitrary timer.
  await page.evaluate(async () => { await (window as any).__previewExtensionsChanged(); });
  await expect(dialog(page)).toBeVisible(); await expect(select).toBeFocused();
  expect(await field!.evaluate(node => node.isConnected)).toBe(true); expect(await original!.evaluate(node => node.isConnected)).toBe(true);
});
test('extensions windows: closing the origin cancels only its forwarded UI and keeps other window definitions active', async ({ page, context }) => {
  await seed(context); await main(page); const tray = await auxiliary(context, families[0]), launcher = await auxiliary(context, families[1]);
  await openForm(tray, 'tray'); await expect(dialog(page)).toBeVisible();
  await launcher.close(); await expect(dialog(page)).toBeVisible();
  await tray.close(); await expect(dialog(page)).not.toBeVisible();
  await expect(page.locator('[data-extension-contribution="sample.project-helper/header"]')).toBeVisible();
  const reopened = await auxiliary(context, families[0]); await expect(trigger(reopened, 'tray')).toBeVisible();
  await expect(page.locator('#toast')).not.toHaveText('Window report confirmed');
});
