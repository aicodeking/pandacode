import { expect, test, type Page } from '@playwright/test';

const sidebar = (page: Page) => page.getByRole('region', { name: 'Bots', exact: true });

async function showBots(page: Page): Promise<void> {
  await page.goto('/?bots=sample');
  const bar = page.locator('.sidebar-bots-bar');
  if (await bar.getAttribute('aria-pressed') !== 'true') await bar.click();
  await expect(sidebar(page)).toBeVisible();
}

test.describe('shared bot channels', () => {
  test('creates a channel from the sidebar and opens its settings', async ({ page }) => {
    await showBots(page);
    await page.getByRole('button', { name: 'Add bot or channel' }).click();
    await page.getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New channel' }).click();

    const dialog = page.getByRole('dialog', { name: 'New channel' });
    await dialog.getByRole('textbox', { name: 'Channel name' }).fill('release-test');
    await dialog.getByRole('checkbox', { name: 'Scout' }).check();
    await dialog.getByRole('checkbox', { name: 'Writer' }).check();
    await dialog.getByRole('button', { name: 'Create channel' }).click();

    await expect(sidebar(page).getByRole('group', { name: 'Channels' })).toContainText('#release-test');
    const channel = page.locator('.conversation-pane.channel-thread .bc-channel');
    await expect(page.locator('#breadcrumb')).toContainText('#release-test');
    await expect(channel.getByText('Add bots in channel settings to start work.')).toHaveCount(0);
    await channel.getByRole('button', { name: 'Channel settings' }).click();
    await expect(page.getByRole('dialog', { name: 'Channel settings' })).toBeVisible();
  });

  test('an empty channel explains how to start and an archived channel is preview only', async ({ page }) => {
    await showBots(page);
    await page.getByRole('button', { name: 'Add bot or channel' }).click();
    await page.getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New channel' }).click();
    const create = page.getByRole('dialog', { name: 'New channel' });
    await create.getByRole('textbox', { name: 'Channel name' }).fill('notes');
    await create.getByRole('button', { name: 'Create channel' }).click();
    const channel = page.locator('.conversation-pane.channel-thread .bc-channel');
    await expect(channel).toContainText('Add bots in channel settings to start work.');
    await expect(channel.locator('textarea')).toHaveCount(0);
    await page.getByRole('button', { name: 'Back to conversation' }).click();

    const row = sidebar(page).getByRole('button', { name: '#notes' });
    await row.click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Delete' }).click();
    await expect(sidebar(page).getByRole('group', { name: 'Deleted channels' })).toContainText('#notes');
    await sidebar(page).getByRole('button', { name: '#notes' }).click();
    const archived = page.locator('.conversation-pane.channel-thread .bc-channel');
    await expect(archived).toContainText('Deleted channel. Preview only.');
    await expect(archived.locator('textarea')).toHaveCount(0);
    await expect(archived.getByRole('button', { name: 'Channel settings' })).toHaveCount(0);
  });

  test('routes to at most two mentioned bots and lets the user stop and reassign', async ({ page }) => {
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    const channel = page.locator('.conversation-pane.channel-thread .bc-channel');
    await page.getByRole('textbox', { name: 'Message channel' }).fill('@Scout and @Writer and @Ledger, review launch.');
    await page.locator('#shared-channel-composer button[type=submit]').click();
    await expect(channel.locator('.bc-assigned')).toHaveCount(2);
    await expect(channel.locator('.bc-assigned')).toContainText(['Assigned to Scout', 'Assigned to Writer']);
    await expect(channel.locator('.bc-working-status')).toHaveText('Scout and Writer are working');
    await page.locator('#composer-area').getByRole('button', { name: 'Stop' }).click();
    await expect(page.locator('#composer-area .bc-channel-actions')).toContainText('This message stopped.');
    await page.locator('#composer-area').getByRole('button', { name: /Reassign/ }).click();
    await page.locator('#composer-area .bc-reassign-menu').getByRole('button', { name: 'Ledger' }).click();
    await expect(channel.locator('.bc-assigned').last()).toContainText('Assigned to Ledger');
    await expect(channel.locator('.bc-working-status')).toHaveText('Ledger is working');
  });

  test('keeps an open Reassign menu through a refresh and names who Stop stops', async ({ page }) => {
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    await page.getByRole('textbox', { name: 'Message channel' }).fill('@Writer draft the post.');
    await page.getByRole('textbox', { name: 'Message channel' }).press('Enter');
    const actions = page.locator('#composer-area .bc-channel-actions');
    await expect(actions.getByRole('button', { name: 'Stop Writer' })).toBeVisible();
    await expect(actions.getByRole('status')).toHaveCount(0);
    await actions.getByRole('button', { name: 'Stop Writer' }).click();
    await actions.getByRole('button', { name: /Reassign/ }).click();
    const menu = page.locator('#composer-area .bc-reassign-menu');
    await expect(menu).toBeVisible();
    const before = await page.evaluate(() => document.querySelector('#composer-area .bc-reassign-menu'));
    await page.evaluate(() => (window as any).__previewEmit('bot-shared-channel-changed', {}));
    // The refresh rewrote the actions (a new menu element), and the menu is still open.
    await expect.poll(() => page.evaluate(old => document.querySelector('#composer-area .bc-reassign-menu') !== old, before)).toBe(true);
    await expect(menu).toBeVisible();
    await expect(actions.getByRole('button', { name: /Reassign/ })).toHaveAttribute('aria-expanded', 'true');
  });

  test('a failed post can be continued, and removing a member stops its work', async ({ page }) => {
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    const channel = page.locator('.conversation-pane.channel-thread .bc-channel');
    const actions = page.locator('#composer-area .bc-channel-actions');
    await expect(channel.locator('.bc-history')).toBeVisible();
    await page.getByRole('textbox', { name: 'Message channel' }).fill('[post-fails] ship it');
    await page.getByRole('textbox', { name: 'Message channel' }).press('Enter');
    await expect(actions).toContainText('This message failed.');
    await actions.getByRole('button', { name: 'Continue' }).click();
    await expect(channel.locator('.bc-working-status')).toHaveText('Scout is working');
    await expect(channel.locator('.bc-assigned')).toHaveCount(2);

    await channel.getByRole('button', { name: 'Channel settings' }).click();
    const settings = page.getByRole('dialog', { name: 'Channel settings' });
    await settings.getByRole('checkbox', { name: 'Scout' }).uncheck();
    await settings.getByRole('button', { name: 'Save' }).click();
    await expect(actions).toContainText('This message stopped.');
    await expect(channel.locator('.bc-working')).toHaveCount(0);
    await expect(channel.locator('.bc-assigned').last()).toContainText('Stopped');
  });

  test('unsent channel text survives a reload, goes when sent, and a deleted channel\'s text goes at boot', async ({ page }) => {
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    const box = page.getByRole('textbox', { name: 'Message channel' });
    await box.fill('half a thought');
    // Written at once, as a crash would find it; a channel that no longer exists has text left too.
    expect(await page.evaluate(() => JSON.parse(localStorage.getItem('pandacode.draft:channel:sample-launch') ?? 'null')?.text)).toBe('half a thought');
    await page.evaluate(() => localStorage.setItem('pandacode.draft:channel:gone-channel', JSON.stringify({ t: Date.now(), text: 'orphan' })));
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    await expect(box).toHaveValue('half a thought');
    await expect.poll(() => page.evaluate(() => localStorage.getItem('pandacode.draft:channel:gone-channel'))).toBeNull();
    await box.fill('@Writer half a thought, finished');
    await box.press('Enter');
    await expect(page.locator('.conversation-pane.channel-thread .bc-assigned').last()).toContainText('Assigned to Writer');
    expect(await page.evaluate(() => localStorage.getItem('pandacode.draft:channel:sample-launch'))).toBeNull();
    await expect(box).toHaveValue('');
  });

  test('uses the channel lead when a post has no bot mention', async ({ page }) => {
    await showBots(page);
    await sidebar(page).getByRole('button', { name: '#launch' }).click();
    const channel = page.locator('.conversation-pane.channel-thread .bc-channel');
    await expect(sidebar(page).locator('.channel-row[aria-current="page"]')).toHaveText('#launch');
    await expect(sidebar(page).locator('.bot-row.selected')).toHaveCount(0);
    await expect(page.locator('#shared-channel-composer .send-button')).toBeVisible();
    await expect(channel.locator('.bc-history')).toBeVisible();
    // Enter sends, like the task composer.
    await page.getByRole('textbox', { name: 'Message channel' }).fill('Review launch.');
    await page.getByRole('textbox', { name: 'Message channel' }).press('Enter');
    await expect(channel.locator('.bc-assigned')).toHaveCount(1);
    await expect(channel.locator('.bc-assigned')).toContainText('Assigned to Scout');
  });
});
