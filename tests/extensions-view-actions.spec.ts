import { test, expect, type Page, type Locator } from '@playwright/test';
import { readFileSync } from 'node:fs';
import { openInspectorTab } from './inspector-tab-helper';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/view-laboratory/extension.json', import.meta.url), 'utf8'));
const layoutKey = 'pandacode.extensions.layout.v1';
const locations = manifest.contributes.menus.map((menu: any) => menu.location) as string[];
const contribution = (location: string) => manifest.contributes.menus.find((menu: any) => menu.location === location);
const dialog = (page: Page) => page.locator('#dialog');
const calls = (page: Page) => page.evaluate(() => (window as any).__extensionDialogTransport.calls);

async function setup(page: Page, enabled = true, packageManifest = manifest) {
  await page.addInitScript(({ manifest, enabled }) => {
    localStorage.setItem('pandacode.wallpapers', 'false');
    if (localStorage.getItem('pandacode.preview.extensions.v1') === null) localStorage.setItem('pandacode.preview.extensions.v1', JSON.stringify(enabled ? [{ manifest, enabled: true, icons: {} }] : []));
    (window as any).__extensionsBaseline = { version: 1, calls: [] };
  }, { manifest: packageManifest, enabled });
  await page.goto('/?extensions-baseline');
  await expect(page.locator('#prompt')).toBeEnabled();
  await page.evaluate(async () => { await (window as any).__previewExtensionDialogTransport(); });
}
async function view(page: Page, name: string) {
  const toggle = page.locator('#inspector-toggle');
  if (await toggle.getAttribute('aria-pressed') === 'false') await toggle.click();
  await openInspectorTab(page, `tab-${name}`);
  await page.locator(`.inspector-tab[data-view="${name}"] [role="tab"]`).click();
}
async function surface(page: Page, location: string): Promise<{ source: Locator; ids?: string[]; projectId: string; sessionId?: string }> {
  if (location.includes('.task.context')) {
    const source = page.locator('.task-item[data-id="session-2"]');
    await source.click({ button: 'right' });
    return { source, ids: ['session-2'], projectId: 'project-1', sessionId: 'session-2' };
  }
  if (location.includes('.project.context')) {
    await page.locator('#project-filter').click();
    await page.getByRole('menuitemradio', { name: 'pandacode', exact: true }).click({ button: 'right' });
    return { source: page.locator('#project-filter'), ids: ['project-2'], projectId: 'project-2' };
  }
  const name = location.split('.')[2]; await view(page, name);
  if (location.endsWith('.toolbar')) return { source: page.locator(`[data-extension-contribution="${contribution(location).id}"]`), projectId: 'project-1', sessionId: 'session-1' };
  let source: Locator, path: string;
  if (name === 'files') {
    source = page.locator('.file-row [data-action="open-file"]').first(); path = (await source.getAttribute('data-path'))!;
    await source.click({ button: 'right' });
  } else if (name === 'changes') {
    source = page.locator('.cv-file').first().getByRole('button', { name: 'File actions', exact: true });
    path = (await page.locator('.cv-file').first().getAttribute('data-path'))!; await source.click();
  } else {
    await page.getByRole('searchbox', { name: 'Search in files' }).fill('search');
    source = page.locator('.search-file').first(); await expect(source).toBeVisible(); path = (await source.getAttribute('data-search-open'))!;
    await source.click({ button: 'right' });
  }
  return { source, ids: [path], projectId: 'project-1', sessionId: 'session-1' };
}
async function openContribution(page: Page, location: string, pending = false) {
  const menu = contribution(location);
  if (location.endsWith('.toolbar')) await page.locator(`[data-extension-contribution="${menu.id}"]`).click();
  else {
    const trigger = page.getByRole('menuitem', { name: 'View laboratory', exact: true });
    await expect(trigger.locator('svg rect')).toHaveCount(1); await trigger.press('ArrowRight');
  }
  if (menu.items) {
    const tools = page.getByRole('menuitem', { name: 'Object tools', exact: true });
    await expect(tools.locator('svg rect')).toHaveCount(1); await tools.press('ArrowRight');
    await page.getByRole('menuitem', { name: 'Choose object options', exact: true }).press('Enter');
  }
  await expect(dialog(page)).toHaveAccessibleName('Clicked object — sample.view-laboratory');
  await page.getByRole('button', { name: 'Object options', exact: true }).click();
  if (pending) await expect(page.getByText('Loading options…', { exact: true })).toBeVisible();
  else await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true })).toBeVisible();
}
for (const location of locations) {
  test(`extensions view actions: ${location} renders icons/submenus/select and uses the clicked IDs`, async ({ page }) => {
    await setup(page); const clicked = await surface(page, location); await openContribution(page, location);
    const recorded = await calls(page); expect(recorded).toHaveLength(1);
    expect(recorded[0].context).toMatchObject({ surfaceId: location, projectId: clicked.projectId, ...(clicked.sessionId ? { sessionId: clicked.sessionId } : {}) });
    if (clicked.ids) expect(recorded[0].context.selection.ids).toEqual(clicked.ids);
    if (location.includes('.project.context')) expect(recorded[0].context.sessionId).toBeUndefined();
    await page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true }).click();
    await page.keyboard.press('Escape'); await page.getByRole('button', { name: 'Cancel', exact: true }).click();
    await expect(dialog(page)).not.toBeVisible(); await expect(clicked.source).toBeFocused();
    await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  });
  test(`extensions view actions: ${location} applies scoped hide and mixed core/contribution order`, async ({ page }) => {
    await setup(page); const item = contribution(location), toolbar = location.endsWith('.toolbar');
    const core = `${location}/${toolbar ? 'refresh' : location.includes('task.context') ? 'pin' : location.includes('project.context') ? 'new' : location.includes('changes.context') ? 'stage' : 'open'}`;
    await page.evaluate(({ key, id, core, location }) => {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { [core]: false }, extensionLayoutsEnabled: true, orders: { [location]: [id, core] } }));
      dispatchEvent(new StorageEvent('storage', { key }));
    }, { key: layoutKey, id: item.id, core, location });
    await surface(page, location);
    if (toolbar) {
      await expect(page.locator('#inspector-refresh')).toBeHidden();
      const trigger = page.locator(`[data-extension-contribution="${item.id}"]`);
      expect(await trigger.evaluate(node => node.parentElement?.firstElementChild === node)).toBe(true);
    } else {
      await expect(page.locator('.choice-menu-option').first()).toHaveText('View laboratory');
      const hiddenLabel = location.includes('task.context') ? 'Pin task' : location.includes('project.context') ? 'New task' : location.includes('changes.context') ? 'Stage file' : 'Open file';
      await expect(page.getByRole('menuitem', { name: hiddenLabel, exact: true })).toHaveCount(0);
    }
    await page.keyboard.press('Escape');
    await page.evaluate(({ key, id }) => {
      localStorage.setItem(key, JSON.stringify({ schemaVersion: 1, visibility: { [id]: false }, extensionLayoutsEnabled: true })); dispatchEvent(new StorageEvent('storage', { key }));
    }, { key: layoutKey, id: item.id });
    await surface(page, location);
    if (toolbar) { await expect(page.locator(`[data-extension-contribution="${item.id}"]`)).toBeHidden(); await expect(page.locator('#inspector-refresh')).toBeVisible(); }
    else await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toHaveCount(0);
  });
}

for (const mode of ['zero extensions', 'after disable']) for (const name of ['files', 'changes', 'search', 'task', 'project']) {
  test(`extensions view actions: legacy ${name} command works with ${mode}`, async ({ page }) => {
    await setup(page, mode !== 'zero extensions');
    if (mode === 'after disable') await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.view-laboratory'); });
    const location = name === 'task' || name === 'project' ? `panda.sidebar.${name}.context` : `panda.inspector.${name}.context`;
    const clicked = await surface(page, location);
    await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toHaveCount(0);
    if (name === 'task') {
      await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
      await expect(page.locator('[data-thread-group="pinned"] .task-item')).toHaveAttribute('data-id', 'session-2');
    } else if (name === 'project') {
      await page.getByRole('menuitem', { name: 'New task', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === 'create_session').map((call: any) => call.args.projectId))).toEqual(['project-2']);
    } else if (name === 'changes') {
      await page.getByRole('menuitem', { name: 'Stage file', exact: true }).click();
      await expect.poll(() => page.evaluate(() => (window as any).__extensionsBaseline.calls.filter((call: any) => call.command === 'git_stage').length)).toBe(1);
    } else {
      await page.getByRole('menuitem', { name: 'Open file', exact: true }).click();
      await expect(page.locator('.file-tabs')).toContainText(clicked.ids![0].split('/').at(-1)!);
    }
  });
}

test('extensions view actions: task callback stays captured across navigation, source removal aborts and cannot focus another row', async ({ page }) => {
  await setup(page); const location = 'panda.sidebar.task.context';
  await surface(page, location); await openContribution(page, location);
  await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await expect(dialog(page).getByRole('status')).toHaveText('Validating…');
  await page.locator('.task-item[data-id="session-4"]').evaluate((node: HTMLElement) => node.click());
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-4');
  expect((await calls(page)).at(-1).context).toMatchObject({ projectId: 'project-1', sessionId: 'session-2', selection: { ids: ['session-2'] } });
  await page.locator('.task-item[data-id="session-2"]').evaluate(node => node.remove());
  await expect(dialog(page)).not.toBeVisible(); expect((await calls(page)).at(-1).aborted).toBe(true);
  await expect(page.locator('.task-item[data-id="session-4"]')).not.toBeFocused();
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body)).toBe(true);
  await page.evaluate(() => (window as any).__extensionDialogTransport.releaseAll());
  await expect(page.locator('#toast')).not.toHaveText('Object confirmed');
});
test('extensions view actions: removing a search source while options load cancels late replies and restores surviving focus', async ({ page }) => {
  await setup(page); const location = 'panda.inspector.search.context'; const clicked = await surface(page, location);
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdOptions = true; });
  await openContribution(page, location, true);
  await clicked.source.evaluate(node => node.remove());
  await expect(dialog(page)).not.toBeVisible(); expect((await calls(page))[0].aborted).toBe(true);
  await page.evaluate(() => (window as any).__extensionDialogTransport.releaseAll());
  await expect(page.getByRole('menuitemcheckbox', { name: 'Alpha', exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body)).toBe(true);
});
test('extensions view actions: package unload aborts toolbar validation after navigation and restores core nodes', async ({ page }) => {
  await setup(page); const location = 'panda.inspector.changes.toolbar';
  await surface(page, location); const refresh = await page.locator('#inspector-refresh').elementHandle(); await openContribution(page, location); await page.keyboard.press('Escape');
  await page.evaluate(() => { (window as any).__extensionDialogTransport.holdValidation = true; });
  await page.getByRole('button', { name: 'Confirm', exact: true }).click();
  await page.locator('.task-item[data-id="session-4"]').evaluate((node: HTMLElement) => node.click());
  expect((await calls(page)).at(-1).context.sessionId).toBe('session-1');
  await page.evaluate(async () => { await (window as any).__previewDisableExtension('sample.view-laboratory'); (window as any).__extensionDialogTransport.releaseAll(); });
  await expect(dialog(page)).not.toBeVisible(); expect((await calls(page)).at(-1).aborted).toBe(true);
  expect(await refresh!.evaluate(node => node === document.querySelector('#inspector-refresh'))).toBe(true);
  await expect(page.locator('#toast')).not.toHaveText('Object confirmed');
  expect(await page.evaluate(() => document.activeElement?.isConnected && document.activeElement !== document.body)).toBe(true);
});
test('extensions view actions: keyboard project context leaves selection unchanged and colliding packages fail closed', async ({ page }) => {
  await setup(page);
  await page.locator('#project-filter').click();
  await page.getByRole('menuitemradio', { name: 'pandacode', exact: true }).press('Shift+F10');
  await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toBeVisible();
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await page.keyboard.press('Escape');
  await page.evaluate(() => {
    const key = 'pandacode.preview.extensions.v1', value = JSON.parse(localStorage.getItem(key)!);
    value.push(structuredClone(value[0])); localStorage.setItem(key, JSON.stringify(value));
  });
  await page.reload(); await expect(page.locator('#prompt')).toBeEnabled();
  await page.locator('.task-item[data-id="session-2"]').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await expect(page.locator('[data-thread-group="pinned"] .task-item')).toHaveAttribute('data-id', 'session-2');
});
test('extensions view actions: valid maximum-size contributions cannot overflow or displace legacy task actions', async ({ page }) => {
  const large = structuredClone(manifest), menu = structuredClone(contribution('panda.sidebar.task.context'));
  menu.items = Array.from({ length: 128 }, (_, index) => ({ id: `sample.view-laboratory/item-${index}`, kind: 'command', title: `Action ${index}`, command: 'sample.view-laboratory/report' }));
  large.contributes.menus = [menu];
  await setup(page, true, large); await surface(page, 'panda.sidebar.task.context');
  await expect(page.locator('#toast')).toContainText('128-item limit');
  await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toHaveCount(0);
  await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await expect(page.locator('[data-thread-group="pinned"] .task-item')).toHaveAttribute('data-id', 'session-2');
});

test('extensions view actions: command-disabled nested choices and direct context actions are visibly disabled', async ({ page }) => {
  const value = structuredClone(manifest);
  value.contributes.commands[0].enabled = false;
  value.contributes.commands.push({ id: 'sample.view-laboratory/allowed', title: 'Available menu', action: { kind: 'showMessage', message: 'Allowed' } });
  const toolbar = value.contributes.menus[0], context = value.contributes.menus.at(-1);
  toolbar.command = 'sample.view-laboratory/allowed'; delete context.items;
  value.contributes.menus = [toolbar, context];
  await setup(page, true, value); await view(page, 'files');
  await page.locator('[data-extension-contribution="sample.view-laboratory/files-toolbar"]').click();
  await page.getByRole('menuitem', { name: 'Object tools', exact: true }).press('ArrowRight');
  await expect(page.getByRole('menuitem', { name: 'Choose object options', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape'); await page.keyboard.press('Escape');
  await page.locator('.task-item[data-id="session-2"]').click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'View laboratory', exact: true })).toBeDisabled();
  await expect(dialog(page)).not.toBeVisible();
  expect(await calls(page)).toEqual([]);
  await page.getByRole('menuitem', { name: 'Pin task', exact: true }).click();
  await expect(page.locator('[data-thread-group="pinned"] .task-item')).toHaveAttribute('data-id', 'session-2');
});
