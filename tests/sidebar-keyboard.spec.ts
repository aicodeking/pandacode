import { expect, test, type Page } from '@playwright/test';

// The task list is one Tab stop with arrow keys inside; ⌘1…9 and ⌘⇧[ / ] move between tasks.
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tabStops = (page: Page) => page.locator('#navigation').evaluate(nav => [...nav.querySelectorAll<HTMLElement>('button')].filter(b => b.tabIndex >= 0 && b.getClientRects().length).map(b => b.dataset.id ?? b.dataset.action));

async function open(page: Page): Promise<void> {
  // Pending tasks sit in Finished too (only Active, Finished and Settled exist); keep the sample
  // tasks pending so they list in a known order.
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const body = (await response.text()).replace(/const providers\s*=/, `for (const s of sessions) s.taskStage = 'pending';\n$&`);
    await route.fulfill({ response, body });
  });
  await page.addInitScript(() => { const key = 'pandacode.sidebar.sort'; localStorage.setItem(key, JSON.stringify({ ...JSON.parse(localStorage.getItem(key) || '{}'), group: 'flat' })); });
  await page.goto('/');
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
}

test('the list is a single Tab stop and arrow keys move between rows and headings', async ({ page }) => {
  await open(page);
  expect(await tabStops(page)).toEqual(['session-1']);
  await row(page, 'session-1').focus();
  await page.keyboard.press('ArrowDown');
  await expect(row(page, 'session-2')).toBeFocused();
  expect(await tabStops(page)).toEqual(['session-2']);
  await page.keyboard.press('ArrowUp');
  await page.keyboard.press('ArrowUp');
  const heading = page.locator('.section-fold[data-section="review"]');
  await expect(heading).toBeFocused();
  // ← closes the section, → opens it again; the closed state is remembered.
  await page.keyboard.press('ArrowLeft');
  await expect(heading).toHaveAttribute('aria-expanded', 'false');
  await page.keyboard.press('ArrowRight');
  await expect(heading).toHaveAttribute('aria-expanded', 'true');
  await page.keyboard.press('End');
  await expect(row(page, 'session-4')).toBeFocused();
  await page.keyboard.press('Enter');
  await expect(row(page, 'session-4')).toHaveAttribute('aria-current', 'page');
});

test('row actions stay out of the Tab order and the menu key opens the row menu', async ({ page }) => {
  await open(page);
  await expect(page.locator('#navigation .task-action[tabindex="0"]')).toHaveCount(0);
  await row(page, 'session-2').focus();
  await page.keyboard.press('Shift+F10');
  await expect(page.getByRole('dialog', { name: 'Task actions', exact: true }).getByRole('menuitem', { name: 'Pin task', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(row(page, 'session-2')).toBeFocused();
});

test('⌘1…9 open the nth task and ⌘⇧[ / ] step through tasks', async ({ page }) => {
  await open(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.locator('#transcript').click();
  await page.keyboard.press(`${mod}+2`);
  await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press(`${mod}+Shift+BracketRight`);
  await expect(row(page, 'session-3')).toHaveAttribute('aria-current', 'page');
  await page.keyboard.press(`${mod}+Shift+BracketLeft`);
  await expect(row(page, 'session-2')).toHaveAttribute('aria-current', 'page');
});

test('/ focuses the filter from the sidebar and ⌘Z undoes settling a task', async ({ page }) => {
  await open(page);
  await row(page, 'session-2').focus();
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Filter tasks', exact: true })).toBeFocused();
  await page.keyboard.press('Escape');
  await row(page, 'session-3').focus();
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  await page.keyboard.press(`${mod}+Enter`);
  await expect(page.locator('#toast')).toContainText('Task settled');
  await expect(page.locator('#navigation [data-thread-group="completed"]')).toBeVisible();
  await page.locator('#navigation').focus().catch(() => undefined);
  await page.keyboard.press(`${mod}+z`);
  await expect(page.locator('#navigation [data-thread-group="completed"]')).toHaveCount(0);
  await expect(row(page, 'session-3')).toHaveCount(1);
});

test('jump shortcuts never fire while typing, and / focuses the filter from the page body', async ({ page }) => {
  await open(page);
  const mod = process.platform === 'darwin' ? 'Meta' : 'Control';
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
  await prompt.focus();
  await page.keyboard.press(`${mod}+2`);
  await page.keyboard.press(`${mod}+Shift+BracketRight`);
  await expect(row(page, 'session-1')).toHaveAttribute('aria-current', 'page');
  await expect(prompt).toBeFocused();
  await prompt.fill('a/b');
  await expect(page.getByRole('searchbox', { name: 'Filter tasks', exact: true })).not.toBeFocused();
  await prompt.fill('');
  await page.evaluate(() => (document.activeElement as HTMLElement).blur());
  await page.keyboard.press('/');
  await expect(page.getByRole('searchbox', { name: 'Filter tasks', exact: true })).toBeFocused();
});

test('/ also works from the transcript, but not on a control outside the list, and is left alone when the filter is hidden', async ({ page }) => {
  await open(page);
  const filter = page.getByRole('searchbox', { name: 'Filter tasks', exact: true });
  await page.locator('#transcript').evaluate(node => { node.tabIndex = -1; node.focus(); });
  await page.keyboard.press('/');
  await expect(filter).toBeFocused();
  await filter.press('Escape');
  await page.getByRole('button', { name: 'Workspace view: Conversation', exact: true }).focus();
  await page.keyboard.press('/');
  await expect(filter).not.toBeFocused();
  await page.setViewportSize({ width: 600, height: 800 });
  await expect(filter).toBeHidden();
  await page.locator('#transcript').evaluate(node => node.focus());
  const prevented = await page.evaluate(() => new Promise<boolean>(resolve => {
    document.addEventListener('keydown', event => resolve(event.defaultPrevented), { once: true });
    document.activeElement!.dispatchEvent(new KeyboardEvent('keydown', { key: '/', bubbles: true, cancelable: true }));
  }));
  expect(prevented).toBe(false);
});

test('in the sort menu ↓/↑ step over the per-section row, ←/→ move along it; focus looks like hover', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Sort and view', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sort and view', exact: true });
  const item = (name: string) => dialog.getByRole('group', { name: 'Sort tasks', exact: true }).getByRole('menuitemradio', { name, exact: true });
  const segment = (name: string) => dialog.getByRole('group', { name: 'Show per section', exact: true }).getByRole('menuitemradio', { name, exact: true });
  await expect(dialog.locator('.choice-menu-option:focus')).toHaveCount(1);
  // Entering the row lands on its current choice…
  await page.keyboard.press('End');
  await expect(segment('6 tasks')).toBeFocused();
  // …→ moves along it, and ↑/↓ leave it whole.
  await page.keyboard.press('ArrowRight');
  await expect(segment('10 tasks')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  await expect(item('Created')).toBeFocused();
  await page.keyboard.press('ArrowDown');
  await expect(segment('6 tasks')).toBeFocused();
  await page.keyboard.press('ArrowLeft');
  await expect(segment('3 tasks')).toBeFocused();
  await page.keyboard.press('ArrowUp');
  const focused = item('Created');
  await expect(focused).toBeFocused();
  await expect(focused).toHaveCSS('outline-style', 'none');
  await expect(focused).toHaveCSS('box-shadow', /0px 0px 0px 1px inset/);
  expect(await focused.evaluate(node => getComputedStyle(node).backgroundColor)).not.toBe('rgba(0, 0, 0, 0)');
});
