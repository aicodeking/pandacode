import { test, expect, type Page } from '@playwright/test';
import { readFileSync } from 'node:fs';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/terminal/extension.json', import.meta.url), 'utf8'));
const drawer = (page: Page) => page.locator('#terminal-drawer');
const screen = (page: Page) => drawer(page).locator('.xterm-screen:visible');
const props = (page: Page) => page.evaluate(() => (window as any).__previewTerminal());
const calls = (page: Page, command: string) => page.evaluate(command => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === command), command);
async function setup(page: Page, packages: unknown[] = []) {
  await page.addInitScript(packages => {
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
    localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(packages.map(manifest => ({ manifest, enabled: true, icons: {} }))));
  }, packages);
  await page.goto('/?extensions-baseline&terminal-coverage&replacement');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
  await expect(screen(page)).toContainText('real PTY');
}
async function explorer(page: Page) {
  await page.keyboard.press('ControlOrMeta+,'); await page.getByRole('tab', { name: 'Extensions', exact: true }).click();
  return page.getByRole('region', { name: 'Surface explorer' });
}
const back = (page: Page) => page.getByRole('button', { name: 'Back to the workspace', exact: true }).click();
async function action(page: Page, controlId: string, tab = '') {
  return page.evaluate(({ controlId, tab }) => {
    const p = (window as any).__previewTerminal();
    const a = { contractVersion: 1, context: p.context, group: p.group, project: p.project, session: p.session, revision: p.revision, tab, controlId, requestId: crypto.randomUUID() };
    (window as any).__capturedTerminal = a; return (window as any).__previewTerminalAction(a);
  }, { controlId, tab });
}
test('terminal: zero extensions retain keyboard tab focus, close consent and background output', async ({ page }) => {
  await setup(page); await drawer(page).getByRole('button', { name: 'New terminal', exact: true }).click();
  await expect(drawer(page).getByRole('tab')).toHaveCount(2);
  await drawer(page).getByRole('tab', { name: 'Terminal 2', exact: true }).focus(); await page.keyboard.press('Home');
  await expect(drawer(page).getByRole('tab', { name: 'Terminal 1', exact: true })).toBeFocused();
  await page.keyboard.press('End'); await expect(drawer(page).getByRole('tab', { name: 'Terminal 2', exact: true })).toBeFocused();
  await page.evaluate(() => { (window as any).__previewTerminalActivity = { running: true, processNames: ['node'], uncertain: false }; });
  await drawer(page).getByRole('button', { name: 'Close terminal', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Close terminal?', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(drawer(page).getByRole('button', { name: 'Close terminal', exact: true })).toBeFocused();
  const state = await props(page), starts = await calls(page, 'start_terminal');
  await drawer(page).getByRole('button', { name: 'Minimize terminal', exact: true }).click();
  await page.evaluate(() => (window as any).__previewTerminalEmit((window as any).__previewTerminalIds[1], '\r\nBackground job continued\r\n'));
  // The host controller and selected tab survive hiding; no close or new start.
  await page.getByRole('button', { name: 'Toggle terminal', exact: true }).click();
  await expect(screen(page)).toContainText('Background job continued');
  expect((await props(page)).selected).toBe(state.selected); expect(await calls(page, 'start_terminal')).toEqual(starts); expect(await calls(page, 'close_terminal')).toHaveLength(0);
});
test('terminal: install/select, controls, compatible move/hide/restore and disable/safe mode retain live controller', async ({ page }) => {
  await setup(page); const before = await props(page), original = await screen(page).elementHandle(), starts = await calls(page, 'start_terminal');
  const region = await explorer(page);
  await page.getByRole('button', { name: 'Install local package', exact: true }).click(); await page.getByRole('button', { name: 'Enable sample.terminal', exact: true }).click();
  await region.getByLabel('Terminal presentation', { exact: true }).selectOption('sample.terminal/tabs');
  await region.getByRole('button', { name: 'Grant UI customization and select Minimize before new', exact: true }).click();
  await region.getByLabel('Item location', { exact: true }).selectOption('panda.terminal.controls');
  await region.getByRole('button', { name: 'Hide New terminal', exact: true }).click();
  await region.getByRole('button', { name: 'Move Terminal to Inspector', exact: true }).click(); await back(page);
  await expect(drawer(page)).toHaveAttribute('data-terminal-provider', 'sample.terminal/tabs');
  await expect(drawer(page).getByRole('button', { name: 'New terminal', exact: true })).toBeHidden();
  expect(await drawer(page).locator('.drawer-heading').evaluate(node => getComputedStyle(node).order)).toBe('1');
  expect(await drawer(page).locator('.terminal-heading-actions').first().locator('button').evaluateAll(nodes => nodes.map(node => node.getAttribute('data-terminal-action')))).toEqual(['minimize', 'new', 'close']);
  await drawer(page).getByRole('button', { name: 'Terminal tools', exact: true }).click();
  await expect(page.getByText('Terminal PTY and launch policy remain host-owned.', { exact: true })).toBeVisible();
  await drawer(page).getByRole('tab', { name: 'Terminal 1', exact: true }).click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Terminal tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await drawer(page).getByRole('tab', { name: 'Terminal 1', exact: true }).focus(); await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'Terminal tools', exact: true })).toBeVisible(); await page.keyboard.press('Escape');
  await expect(drawer(page).getByRole('tab', { name: 'Terminal 1', exact: true })).toBeFocused();
  await explorer(page); await region.getByRole('button', { name: 'Hide Terminal', exact: true }).click(); await back(page); await expect(drawer(page)).toBeHidden();
  await explorer(page); await region.getByRole('button', { name: 'Show Terminal', exact: true }).click(); await region.getByRole('button', { name: 'Restore built-in view placement', exact: true }).click(); await back(page);
  await expect(screen(page)).toBeVisible(); expect((await props(page)).selected).toBe(before.selected);
  await page.evaluate(() => (window as any).__previewTerminalEmit((window as any).__previewTerminalIds[0], '\r\nSame live controller after placement\r\n'));
  await expect(screen(page)).toContainText('Same live controller after placement');
  expect(await original!.evaluate(node => node === document.querySelector('#terminal-host .xterm-screen'))).toBe(true);
  await explorer(page); await page.getByRole('button', { name: 'Disable sample.terminal', exact: true }).click(); await page.getByRole('button', { name: 'Disable extensions for this launch', exact: true }).click(); await back(page);
  await expect(drawer(page)).not.toHaveAttribute('data-terminal-provider'); expect((await props(page)).group).toBe(before.group);
  expect(await calls(page, 'start_terminal')).toEqual(starts); expect(await calls(page, 'close_terminal')).toHaveLength(0);
});
test('terminal: captured original new/select/close actions reject stale and forged dispatch and keep busy close approval', async ({ page }) => {
  await setup(page, [manifest]); const region = await explorer(page); await region.getByLabel('Terminal presentation', { exact: true }).selectOption('sample.terminal/tabs'); await back(page);
  const before = await props(page); expect(await action(page, 'new')).toEqual({ ok: true }); await expect(drawer(page).getByRole('tab')).toHaveCount(2);
  expect(await page.evaluate(() => (window as any).__previewTerminalAction((window as any).__capturedTerminal))).toEqual({ ok: false, reason: 'StaleContext' });
  expect(await action(page, 'select', before.selected)).toEqual({ ok: true }); await expect(drawer(page).getByRole('tab', { name: 'Terminal 1', exact: true })).toHaveAttribute('aria-selected', 'true');
  expect(await action(page, 'select', '1234')).toEqual({ ok: false, reason: 'InvalidArguments' }); expect(await action(page, 'execute')).toEqual({ ok: false, reason: 'InvalidArguments' });
  await explorer(page); await region.getByLabel('Item location', { exact: true }).selectOption('panda.terminal.controls');
  await region.getByRole('button', { name: 'Hide Close terminal tab', exact: true }).click(); await back(page);
  await page.evaluate(() => { (window as any).__previewTerminalActivity = { running: true, processNames: ['node'], uncertain: false }; });
  expect(await action(page, 'close', before.selected)).toEqual({ ok: true }); await expect(page.getByRole('dialog', { name: 'Close terminal?', exact: true })).toBeVisible();
  expect(await calls(page, 'close_terminal')).toHaveLength(0); await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-2"]').click();
  expect(await page.evaluate(() => (window as any).__previewTerminalAction((window as any).__capturedTerminal))).toEqual({ ok: false, reason: 'StaleContext' });
});
test('terminal: conflicting/future/faulted providers restore original live host without duplicate launch', async ({ page }) => {
  const other = structuredClone(manifest); other.id = 'other.terminal'; other.contributes = { components: [{ ...manifest.contributes.components[0], id: 'other.terminal/tabs' }] };
  const future = structuredClone(other); future.id = 'future.terminal'; future.contributes.components[0].id = 'future.terminal/tabs'; future.contributes.components[0].contractVersion = 2;
  await setup(page, [manifest, other, future]); const before = await props(page), starts = await calls(page, 'start_terminal');
  const region = await explorer(page); await expect(region.getByLabel('Terminal presentation', { exact: true })).toHaveValue(''); await expect(region.locator('option[value="future.terminal/tabs"]')).toHaveAttribute('disabled', '');
  await region.getByLabel('Terminal presentation', { exact: true }).selectOption('sample.terminal/tabs'); await back(page);
  await page.evaluate(async () => { const api = await (window as any).__previewReplacementModules(); api.applyTerminalPresentation(document.querySelector('#terminal-drawer'), () => { throw Error('controlled fault'); }); });
  await expect(page.locator('[data-terminal-presentation-status]')).toContainText('Built-in terminal remains active'); expect((await props(page)).selected).toBe(before.selected);
  expect(await action(page, 'minimize')).toEqual({ ok: false, reason: 'Revoked' }); expect(await calls(page, 'start_terminal')).toEqual(starts); expect(await calls(page, 'close_terminal')).toHaveLength(0);
});
