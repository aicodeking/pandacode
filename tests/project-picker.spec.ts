import { expect, test, type Page } from '@playwright/test';

async function openNewTask(page: Page) {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({
      response,
      body: source.replace(marker, `
        (window.__removed ??= []);
        if (command === 'remove_project') window.__removed.push(args.projectId);
        switch (command) {
      `),
    });
  });
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.locator('.new-task-button').click();
  await expect(page.locator('#welcome-project')).toBeVisible();
}

const projectPicker = (page: Page) => page.getByRole('dialog', { name: 'Choose project', exact: true });

test('cancelling removal keeps the project, confirming removes it from the project picker', async ({ page }) => {
  await openNewTask(page);
  await page.locator('#welcome-project').click();
  const picker = projectPicker(page);
  await expect(picker).toBeVisible();

  // "No project" is synthetic and does not offer a remove button.
  const noProjectRow = picker.locator('.project-menu-row', { hasText: 'No project' });
  await expect(noProjectRow.locator('.project-menu-remove')).toHaveCount(0);

  // Real projects render the remove button as a sibling, never nested inside the option button.
  const targetRow = picker.locator('.project-menu-row', { hasText: 'pandacode' });
  const removeButton = targetRow.getByRole('button', { name: 'Remove pandacode from list', exact: true });
  await expect(removeButton).toHaveAttribute('title', 'Remove from list');
  expect(await removeButton.evaluate(button => button.closest('.project-menu-option') === null)).toBe(true);

  // Hovering reveals the remove button; clicking it closes the picker before opening the confirm modal.
  await targetRow.hover();
  await expect(removeButton).toHaveCSS('opacity', '1');
  await removeButton.click();
  await expect(picker).toHaveCount(0);

  const confirmDialog = page.locator('#dialog');
  await expect(confirmDialog).toBeVisible();
  await expect(confirmDialog).toContainText('Remove pandacode?');
  await expect(confirmDialog).toContainText('The folder stays on disk.');

  // Cancelling keeps the project in the list and does not invoke remove_project.
  await confirmDialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(confirmDialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__removed)).toEqual([]);

  await page.locator('#welcome-project').click();
  await expect(picker.getByRole('option', { name: /^pandacode — / })).toBeVisible();

  // Confirming removes the project from PandaCode and the picker list.
  const rowAgain = picker.locator('.project-menu-row', { hasText: 'pandacode' });
  await rowAgain.hover();
  await rowAgain.getByRole('button', { name: 'Remove pandacode from list', exact: true }).click();
  await expect(picker).toHaveCount(0);
  await expect(confirmDialog).toBeVisible();
  await confirmDialog.getByRole('button', { name: 'Remove project', exact: true }).click();
  await expect(confirmDialog).toBeHidden();
  expect(await page.evaluate(() => (window as any).__removed)).toEqual(['project-2']);

  // Re-opening the picker shows pandacode is gone while orbit remains.
  await page.locator('#welcome-project').click();
  await expect(picker.getByRole('option', { name: /^pandacode — / })).toHaveCount(0);
  await expect(picker.getByRole('option', { name: /^orbit — / })).toBeVisible();
});

test('keyboard navigation works cleanly across rows with sibling remove buttons', async ({ page }) => {
  await openNewTask(page);
  const trigger = page.locator('#welcome-project');
  await trigger.click();
  const picker = projectPicker(page);
  const search = picker.getByRole('searchbox', { name: 'Search projects', exact: true });
  await expect(search).toBeFocused();

  // ArrowDown / ArrowUp traverse only project options, skipping remove buttons.
  const options = picker.getByRole('option');
  await expect(options).toHaveCount(3);
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(0)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(1)).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(options.nth(2)).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(options.nth(1)).toBeFocused();

  // Escape closes the picker and restores focus to the trigger.
  await page.keyboard.press('Escape');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toBeFocused();

  // Re-open and select pandacode with Arrow keys + Enter.
  await trigger.click();
  await expect(search).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(picker.getByRole('option', { name: /^pandacode — / })).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(picker).toHaveCount(0);
  await expect(trigger).toHaveText('pandacode');
});
