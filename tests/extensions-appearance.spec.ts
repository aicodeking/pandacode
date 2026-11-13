import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/appearance/extension.json', import.meta.url), 'utf8'));
async function setup(page: Page, mode = 'dark') {
  await page.addInitScript(({ mode }) => { localStorage.setItem('pandacode.theme', mode); (window as any).__extensionsBaseline = { version: 1, calls: [] }; }, { mode });
  await page.goto('/?extensions-baseline&appearance');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__previewEnableExtension)).toBe('function');
}
async function install(page: Page) {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  await page.getByRole('button', { name: 'Install local package', exact: true }).click();
  await page.getByRole('button', { name: 'Enable sample.appearance', exact: true }).click();
  await page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
}
const bg = (page: Page) => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue('--bg').trim());
for (const mode of ['light', 'dark']) test(`extensions appearance: ${mode} install, icons at recursive levels, zoom, restore and isolated tokens`, async ({ page }) => {
  await setup(page, mode);
  const original = await bg(page);
  const originalIcon = await page.locator('svg[data-host-icon="settings"]').first().innerHTML();
  const fileUrl = await page.evaluate(async () => {
    const { fileIcon } = await (window as any).__previewAppearanceModules();
    const sample = document.createElement('div'); sample.id = 'appearance-file-sample'; sample.innerHTML = fileIcon('report.ts', false); document.body.append(sample);
    return sample.querySelector('img')!.src;
  });
  await install(page);
  await expect.poll(() => bg(page)).toBe(mode === 'dark' ? '#182239' : '#f2f5ff');
  expect(await page.locator('svg[data-host-icon="settings"]').first().innerHTML()).not.toBe(originalIcon);
  await expect(page.locator('#appearance-file-sample svg')).toHaveCount(1);
  await page.evaluate(() => { document.documentElement.style.zoom = '1.6'; });
  const trigger = page.getByRole('button', { name: 'Appearance laboratory', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter');
  const sub = page.getByRole('menuitem', { name: 'Appearance submenu', exact: true });
  await expect(sub.locator('svg').first()).toBeVisible(); await expect(sub.locator('svg').first().locator('path')).toHaveAttribute('d', 'M12 3 21 12 12 21 3 12Z'); await sub.focus(); await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Appearance action', exact: true }).locator('svg')).toBeVisible();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape'); await expect(trigger).toBeFocused();
  const tokens = await page.evaluate(async () => { const module = await (window as any).__previewAppearanceModules(); return module.appearanceSnapshot(); });
  expect(tokens.tokens['--bg']).toBe(mode === 'dark' ? '#182239' : '#f2f5ff');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.appearance'); });
  await expect.poll(() => bg(page)).toBe(original);
  expect(await page.locator('svg[data-host-icon="settings"]').first().innerHTML()).toBe(originalIcon);
  await expect(page.locator('#appearance-file-sample img')).toHaveAttribute('src', fileUrl);
  expect(await page.evaluate(() => ['--ds-radius-card', '--ds-row-pad-y', 'font-family'].map(key => document.documentElement.style.getPropertyValue(key)))).toEqual(['', '', '']);
});

test('extensions appearance: imported user palette survives package and accessibility precedence', async ({ page }) => {
  await setup(page);
  await page.evaluate(async () => { const { palette } = await (window as any).__previewAppearanceModules(); palette.setVsix({ id: 'test', name: 'Test', extension: 'test', kind: 'dark', colors: { 'editor.background': '#101820', 'editor.foreground': '#eef2ff', 'button.background': '#99bbff' } }); });
  const original = await bg(page);
  await install(page);
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await expect.poll(() => bg(page)).toBe(original);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ds-radius-card'))).toBe('');
  await page.emulateMedia({ contrast: 'no-preference', forcedColors: 'active' });
  await expect.poll(() => bg(page)).toBe(original);
  await page.emulateMedia({ forcedColors: 'none' });
  await expect.poll(() => bg(page)).toBe('#182239');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.appearance'); });
  await expect.poll(() => bg(page)).toBe(original);
});

test('extensions appearance: invalid data, geometry and executable SVG rejected; missing icon and conflicts fall back', async ({ page }) => {
  await setup(page);
  const result = await page.evaluate(async manifest => {
    const { validateContract, safeAppearanceIcon } = await (window as any).__previewAppearanceModules();
    const invalid = [ { radius: 100 }, { font: 'url(https://bad.test)' }, { css: 'body{display:none}' }, { light: { ...manifest.contributes.themes[0].light, accent: 'url(bad)' } }, { light: { ...manifest.contributes.themes[0].light, foreground: '#f2f5ff' } } ];
    return { valid: validateContract('packages', [manifest]).ok, rejected: invalid.map(change => { const value = structuredClone(manifest); Object.assign(value.contributes.themes[0], change); return !validateContract('packages', [value]).ok; }), unsafe: ['<svg><script>bad()</script></svg>', '<svg><image href="https://bad.test"/></svg>', '<svg><path fill="url(https://bad.test)"/></svg>'].map(safeAppearanceIcon) };
  }, manifest);
  expect(result.valid).toBe(true); expect(result.rejected).toEqual([true, true, true, true, true]); expect(result.unsafe).toEqual([undefined, undefined, undefined]);
  await page.evaluate(async manifest => {
    const { applyExtensionAppearance, appearanceIcon } = await (window as any).__previewAppearanceModules();
    applyExtensionAppearance({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }], diagnostics: [] });
    if (appearanceIcon('settings') !== undefined) throw Error('Missing asset did not fall back');
    applyExtensionAppearance({ safeMode: false, packages: [{ manifest, enabled: true, icons: {} }, { manifest, enabled: true, icons: {} }], diagnostics: [] });
  }, manifest);
  expect(await page.evaluate(() => document.documentElement.style.getPropertyValue('--ds-radius-card'))).toBe('');
});

test('extensions appearance: isolated view receives frozen token snapshot and read-only change events', async ({ page }) => {
  const rich = JSON.parse(readFileSync(new URL('./fixtures/extensions/rich-view/extension.json', import.meta.url), 'utf8'));
  await page.addInitScript(({ manifest, rich }) => {
    localStorage.setItem('pandacode.theme', 'dark');
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify([manifest, rich].map(manifest => ({ manifest, enabled: true, icons: {} }))));
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
  }, { manifest, rich });
  await page.goto('/?extensions-baseline&appearance&rich-view-characterization');
  await page.getByRole('button', { name: 'Open isolated report', exact: true }).click();
  const opened = page.waitForEvent('popup');
  await page.getByRole('button', { name: 'Open isolated extension window', exact: true }).click();
  const popup = await opened;
  await expect(popup.getByRole('status')).toHaveText('Isolated extension view');
  const frame = popup.frames().find(frame => frame.parentFrame())!;
  const initial = await frame.evaluate(() => {
    let snapshot: any;
    (window as any).pandaView.onDidInitialize((value: any) => { snapshot = value; });
    (window as any).pandaView.onDidChangeTheme((value: any) => { (window as any).__lastTheme = value; });
    return { bg: snapshot.theme.tokens['--bg'], frozen: Object.isFrozen(snapshot.theme.tokens) };
  });
  expect(initial).toEqual({ bg: '#182239', frozen: true });
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.appearance'); });
  await expect.poll(() => frame.evaluate(() => (window as any).__lastTheme?.tokens['--bg'])).not.toBe('#182239');
  expect(await frame.evaluate(() => Object.isFrozen((window as any).__lastTheme.tokens))).toBe(true);
  await popup.close();
});

test('extensions appearance: reduced transparency and motion retain solid readable controls and visible focus', async ({ page, browserName }) => {
  await setup(page); await install(page);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  if (browserName === 'chromium') {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-transparency', value: 'reduce' }, { name: 'prefers-reduced-motion', value: 'reduce' }] });
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-transparency: reduce)').matches)).toBe(true);
    await cdp.detach();
  }
  const trigger = page.getByRole('button', { name: 'Appearance laboratory', exact: true });
  await trigger.focus(); await page.keyboard.press('Enter'); await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
  const focus = await trigger.evaluate(node => ({ outline: getComputedStyle(node).outlineStyle, color: getComputedStyle(node).outlineColor }));
  expect(focus.outline).not.toBe('none'); expect(focus.color).not.toBe('rgba(0, 0, 0, 0)');
});
