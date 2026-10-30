import { expect, test, type Page } from '@playwright/test';

// Settings → General lists user projects; Remove asks first and calls the preview's remove_project.
async function open(page: Page, settings = true) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      (window.__removed ??= []);
      if (command === 'remove_project') { if (window.__refuse) throw new Error('Stop this project\\'s agents first.'); window.__removed.push(args.projectId); }
      if (command === 'rename_project' && window.__refuseRename) throw new Error('Could not save the project name.');
      switch (command) {
    `) });
  });
  await page.addInitScript(() => { const key = 'pandacode.sidebar.sort'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), group: 'flat' })); });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  if (!settings) return;
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('#projects-settings .project-row').first()).toBeVisible();
}
const rows = (page: Page) => page.locator('#projects-settings .project-row');

test('project dropdown removes a project without selecting it and keeps cancellation safe', async ({ page }, testInfo) => {
  await open(page, false);
  const trigger = page.getByRole('button', { name: 'Filter projects', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const projects = menu.getByRole('menuitemradio').filter({ hasNotText: 'All projects' });
  const target = projects.last();
  const name = await target.getAttribute('aria-label');
  const before = await projects.count();
  await menu.screenshot({ path: testInfo.outputPath('project-dropdown-remove.png') });
  const remove = menu.getByRole('menuitem', { name: `Remove ${name} from PandaCode`, exact: true });
  await remove.click();
  await expect(page.locator('#project-filter')).toContainText('All projects');
  const dialog = page.getByRole('dialog', { name: `Remove ${name}?`, exact: true });
  await expect(dialog).toContainText('The folder stays on disk');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([]);
  await trigger.click();
  await expect(projects).toHaveCount(before);
  // Keyboard users step through Rename and Remove with →, then return with ←.
  await target.focus();
  await page.keyboard.press('ArrowRight');
  await expect(menu.getByRole('menuitem', { name: `Rename ${name}`, exact: true })).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await expect(remove).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await page.keyboard.press('ArrowLeft');
  await expect(target).toBeFocused();
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Enter');
  const id = await page.locator('#remove-project-form').getAttribute('data-project-id');
  await dialog.getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(dialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([id]);
  await trigger.click();
  await expect(projects).toHaveCount(before - 1);
  await expect(remove).toHaveCount(0);
});

test('project dropdown renames the selected project and preserves its folder', async ({ page }, testInfo) => {
  await open(page, false);
  const trigger = page.getByRole('button', { name: 'Filter projects', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const target = menu.getByRole('menuitemradio').last();
  const name = (await target.getAttribute('aria-label'))!;
  const description = (await target.getAttribute('aria-describedby'))!;
  const path = await page.locator(`#${description}`).textContent();
  await target.click();
  await trigger.click();
  await menu.getByRole('menuitem', { name: `Rename ${name}`, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Rename project', exact: true });
  const field = dialog.getByRole('textbox', { name: 'Project name', exact: true });
  await expect(field).toHaveValue(name);
  await field.fill('Cancelled name');
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.locator('#project-filter')).toContainText(name);
  await trigger.click();
  await menu.getByRole('menuitem', { name: `Rename ${name}`, exact: true }).click();
  await field.fill('Renamed workspace');
  await dialog.screenshot({ path: testInfo.outputPath('rename-project-dialog.png') });
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toBeHidden();
  await expect(page.locator('#project-filter')).toContainText('Renamed workspace');
  await trigger.click();
  const renamed = menu.getByRole('menuitemradio', { name: 'Renamed workspace', exact: true });
  await expect(renamed).toHaveAttribute('aria-checked', 'true');
  const renamedDescription = await renamed.getAttribute('aria-describedby');
  await expect(page.locator(`#${renamedDescription}`)).toHaveText(path!);
  await menu.screenshot({ path: testInfo.outputPath('project-dropdown-rename.png') });
});

test('project dropdown rename keeps the dialog and entered name when saving fails', async ({ page }) => {
  await open(page, false);
  await page.evaluate(() => { (window as any).__refuseRename = true; });
  await page.getByRole('button', { name: 'Filter projects', exact: true }).click();
  await page.getByRole('dialog', { name: 'Filter projects', exact: true }).getByRole('menuitem', { name: /^Rename / }).first().click();
  const dialog = page.getByRole('dialog', { name: 'Rename project', exact: true });
  const field = dialog.getByRole('textbox', { name: 'Project name', exact: true });
  await field.fill('My new name');
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Could not save');
  await expect(field).toHaveValue('My new name');
  await page.evaluate(() => { (window as any).__refuseRename = false; });
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toBeHidden();
});

test('project dropdown clears the selected project after confirmation', async ({ page }) => {
  await open(page, false);
  const trigger = page.getByRole('button', { name: 'Filter projects', exact: true });
  await trigger.click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const project = menu.getByRole('menuitemradio').last();
  const name = await project.getAttribute('aria-label');
  await project.click();
  await expect(page.locator('#project-filter')).toContainText(name!);
  await trigger.click();
  await menu.getByRole('menuitem', { name: `Remove ${name} from PandaCode`, exact: true }).click();
  await page.locator('#dialog').getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(page.locator('#dialog')).toBeHidden();
  await expect(page.locator('#project-filter')).toContainText('All projects');
  await trigger.click();
  await expect(menu.getByRole('menuitemradio', { name: name!, exact: true })).toHaveCount(0);
});

test('project dropdown removal preserves a project when its running agents prevent removal', async ({ page }) => {
  await open(page, false);
  await page.evaluate(() => { (window as any).__refuse = true; });
  await page.getByRole('button', { name: 'Filter projects', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Filter projects', exact: true });
  const remove = menu.getByRole('menuitem', { name: /^Remove .* from PandaCode$/ }).first();
  await remove.click();
  const dialog = page.locator('#dialog');
  await dialog.getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(page.locator('#toast')).toContainText('Stop this project');
  await expect(dialog).toBeVisible();
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([]);
});

test('cancel keeps the project, confirm removes it', async ({ page }) => {
  await open(page);
  const before = await rows(page).count();
  const first = rows(page).first();
  const id = await first.getAttribute('data-project');
  await first.getByRole('button', { name: /^Remove / }).click();
  await expect(first).toContainText('The folder stays on disk');
  await first.getByRole('button', { name: 'Cancel' }).click();
  await expect(rows(page)).toHaveCount(before);
  await rows(page).first().getByRole('button', { name: /^Remove / }).click();
  await rows(page).first().getByRole('button', { name: 'Remove project' }).click();
  await expect(page.locator(`#projects-settings [data-project="${id}"]`)).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([id]);
});

test('a native refusal is shown and the project stays', async ({ page }) => {
  await open(page);
  await page.evaluate(() => { (window as any).__refuse = true; });
  const before = await rows(page).count();
  await rows(page).first().getByRole('button', { name: /^Remove / }).click();
  await rows(page).first().getByRole('button', { name: 'Remove project' }).click();
  await expect(page.locator('#projects-settings [role="alert"]')).toContainText('Stop this project');
  await expect(rows(page)).toHaveCount(before);
});
