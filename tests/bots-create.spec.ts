import { expect, test, type Page } from '@playwright/test';

/* New bot form (live icon, color, face, purpose, suggestions) and the Profile settings,
 * which save as you go. */
const bots = (page: Page) => page.getByRole('dialog', { name: /^(Bots|New bot)$/ });
const form = (page: Page) => bots(page).getByRole('form', { name: 'New bot' });
const panel = (page: Page, name: string) => page.getByRole('dialog', { name: `${name} settings` });
const crumb = (page: Page) => page.locator('#breadcrumb .bot-crumb');
const purpose = (page: Page) => form(page).getByRole('textbox', { name: 'What should this bot help with?' });

async function openNewBot(page: Page): Promise<void> {
  await page.goto('/');
  const bar = page.locator('.sidebar-bots-bar');
  if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
  const sidebar = page.getByRole('region', { name: 'Bots', exact: true });
  await sidebar.getByRole('button', { name: 'Add bot or channel' }).click();
  await sidebar.getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New bot' }).click();
  // The bots module loads lazily, so the first open may wait for it.
  await expect(form(page)).toBeVisible({ timeout: 15_000 });
}

async function createBot(page: Page, name: string): Promise<void> {
  await openNewBot(page);
  await form(page).getByRole('textbox', { name: 'Name' }).fill(name);
  await form(page).getByRole('button', { name: 'Create bot' }).click();
  await expect(bots(page)).toBeHidden();
  await expect(crumb(page)).toContainText(name);
}

test.describe('new bot', () => {
  test('validates the name, previews the icon and counts the purpose', async ({ page }) => {
    await openNewBot(page);
    const name = form(page).getByRole('textbox', { name: 'Name' });
    await form(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(form(page).locator('#bc-name-error')).toHaveText('Give the bot a name.');
    await expect(name).toHaveAttribute('aria-invalid', 'true');
    await expect(name).toBeFocused();
    await name.fill('Scout');
    await expect(form(page).locator('#bc-name-error')).toHaveCount(0);
    await expect(name).not.toHaveAttribute('aria-invalid', 'true');

    await purpose(page).fill('Watch my builds');
    await expect(form(page).locator('.bc-count')).toHaveText('15 / 2000');
    // Color tints the preview and every face in the row; a face changes only the face.
    await form(page).getByRole('button', { name: 'Blue', exact: true }).click();
    await expect(form(page).locator('.bc-preview .bot-avatar')).toHaveAttribute('style', /--panda-bg:#3b82f6/);
    await form(page).getByRole('button', { name: 'Glasses panda' }).click();
    await expect(form(page).getByRole('button', { name: 'Glasses panda' })).toHaveAttribute('aria-pressed', 'true');
    await expect(form(page).locator('.bc-preview .bot-avatar')).toHaveAttribute('style', /--panda-bg:#3b82f6/);

    await form(page).getByRole('button', { name: 'Create bot' }).click();
    await expect(bots(page)).toBeHidden();
    await expect(crumb(page)).toContainText('Scout');
    await expect(crumb(page).locator('.bot-avatar svg')).toBeVisible();
    // The purpose belongs to the bot profile, not a synthetic user turn.
    await expect(page.locator('#transcript')).not.toContainText('Your ongoing role is: Watch my builds');
    await expect(page.locator('#transcript .user-message, #transcript .agent-message')).toHaveCount(0);
    await page.locator('#breadcrumb').getByRole('button', { name: 'Scout settings', exact: true }).click();
    await expect(panel(page, 'Scout').getByRole('textbox', { name: 'Instructions' })).toHaveValue('Watch my builds');
  });

  test('a suggestion fills the name and purpose until either is edited', async ({ page }) => {
    await openNewBot(page);
    const rail = bots(page).getByRole('region', { name: 'Suggestions' });
    await expect(rail.getByRole('button')).toHaveCount(8);
    const card = rail.getByRole('button', { name: /Code Reviewer/ });
    await card.click();
    await expect(card).toHaveAttribute('aria-pressed', 'true');
    await expect(form(page).getByRole('textbox', { name: 'Name' })).toHaveValue('Code Reviewer');
    await expect(purpose(page)).toHaveValue(/^Review the diffs/);
    await rail.getByRole('button', { name: /Writer/ }).click();
    await expect(form(page).getByRole('textbox', { name: 'Name' })).toHaveValue('Writer');
    await expect(card).toHaveAttribute('aria-pressed', 'false');
    await form(page).getByRole('textbox', { name: 'Name' }).fill('Quill');
    await expect(rail.getByRole('button', { name: /Writer/ })).toHaveAttribute('aria-pressed', 'false');
    await expect(purpose(page)).toHaveValue(/^Help me draft/);
  });
});

test.describe('bot profile', () => {
  test('saves as you go, with a confirmation before full access', async ({ page }) => {
    await createBot(page, 'Scout');
    await page.locator('#breadcrumb').getByRole('button', { name: 'Scout settings', exact: true }).click();
    const settings = panel(page, 'Scout');
    await expect(settings).toBeVisible();
    await expect(settings.getByRole('button', { name: 'Save' })).toHaveCount(0);
    const saved = settings.locator('.bs-saved');

    await settings.getByRole('textbox', { name: 'Title' }).fill('Finds answers');
    await expect(saved).toHaveText('Saved');
    await expect(settings.locator('.bp-meta')).toContainText('Finds answers');

    // An empty name is not saved.
    await settings.getByRole('textbox', { name: 'Name' }).fill('');
    await expect(settings.locator('#bp-name-error')).toHaveText('Give the bot a name.');
    await settings.getByRole('button', { name: 'Change icon' }).click();
    await settings.getByRole('dialog', { name: 'Icon' }).getByRole('button', { name: 'Reset', exact: true }).click();
    await expect(settings.locator('.bp-name')).toHaveText('Scout');
    await expect(settings.getByRole('textbox', { name: 'Name' })).toHaveValue('Scout');
    await page.keyboard.press('Escape');
    await settings.getByRole('textbox', { name: 'Name' }).fill('Scout');

    // Icon popover: a color and a face apply at once.
    await settings.getByRole('button', { name: 'Change icon' }).click();
    const pop = settings.getByRole('dialog', { name: 'Icon' });
    await pop.getByRole('button', { name: 'Teal', exact: true }).click();
    await pop.getByRole('button', { name: 'Wink panda' }).click();
    await expect(settings.locator('.bp-avatar')).toHaveAttribute('style', /--panda-bg:#14b8a6/);
    await page.keyboard.press('Escape');
    await expect(pop).toBeHidden();

    await settings.getByRole('checkbox', { name: 'Notifications' }).uncheck();
    await expect(saved).toHaveText('Saved');
    await settings.locator('.bs-advanced summary').click();
    await settings.getByRole('combobox', { name: 'While working' }).selectOption('steer');
    await settings.getByRole('checkbox', { name: 'Show the plan before long tasks' }).check();

    const add = settings.getByRole('combobox', { name: 'Add a backup model' });
    await add.selectOption({ index: 1 });
    await expect(settings.locator('.bp-backups li')).toHaveCount(1);
    await settings.getByRole('combobox', { name: 'Switching to a backup' }).selectOption('auto');

    const rules = settings.getByRole('radiogroup', { name: 'Rules' });
    const full = rules.getByRole('radio', { name: 'Full access' });
    await full.click();
    const confirm = settings.getByRole('alertdialog', { name: 'Give Scout full access?' });
    await confirm.getByRole('button', { name: 'Cancel' }).click();
    await expect(rules.getByRole('radio', { name: 'Ask first' })).toHaveAttribute('aria-checked', 'true');
    await full.click();
    await settings.getByRole('alertdialog').getByRole('button', { name: 'Allow full access' }).click();
    await expect(full).toHaveAttribute('aria-checked', 'true');
    await expect(saved).toHaveText('Saved');

    // Everything is still there after closing and reopening.
    await page.keyboard.press('Escape');
    await expect(settings).toBeHidden();
    await page.locator('#breadcrumb').getByRole('button', { name: 'Scout settings', exact: true }).click();
    await expect(settings.getByRole('textbox', { name: 'Title' })).toHaveValue('Finds answers');
    await expect(settings.getByRole('checkbox', { name: 'Notifications' })).not.toBeChecked();
    await expect(settings.getByRole('radiogroup', { name: 'Rules' }).getByRole('radio', { name: 'Full access' })).toHaveAttribute('aria-checked', 'true');
    await expect(settings.locator('.bp-backups li')).toHaveCount(1);
    await expect(settings.getByRole('combobox', { name: 'Switching to a backup' })).toHaveValue('auto');
    await settings.locator('.bs-advanced summary').click();
    await expect(settings.getByRole('combobox', { name: 'While working' })).toHaveValue('steer');
    await expect(settings.getByRole('checkbox', { name: 'Show the plan before long tasks' })).toBeChecked();
    await expect(settings.locator('.bp-avatar')).toHaveAttribute('style', /--panda-bg:#14b8a6/);
  });
});
