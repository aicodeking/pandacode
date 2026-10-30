import { expect, test, type Page } from '@playwright/test';

// Menus and dialogs read as one line per row: short details sit beside the label,
// long ones move behind an info mark whose tooltip appears on hover and keyboard focus.
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });

async function open(page: Page): Promise<void> {
  await page.goto('/');
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1');
  await expect(prompt(page)).toBeEnabled();
}

test('menu rows keep label and detail on one line and never wrap', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Attach files for context' }).click();
  const rows = page.getByRole('dialog', { name: 'Attach', exact: true }).getByRole('menuitem');
  await expect(rows).toHaveCount(5);
  const heights = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  for (const height of heights) expect(height).toBeLessThanOrEqual(36);
  const first = rows.first();
  await expect(first.locator('.choice-menu-label')).toHaveText('Attach files…');
  await expect(first.locator('.choice-menu-description')).toHaveText('Images, PDFs, documents');
  const [labelTop, detailTop] = await first.evaluate(node => [node.querySelector('.choice-menu-label')!.getBoundingClientRect().top, node.querySelector('.choice-menu-description')!.getBoundingClientRect().top]);
  expect(Math.abs(labelTop - detailTop)).toBeLessThan(6);
  await page.keyboard.press('Escape');
});

test('long menu details move behind an info mark with a tooltip on hover and on keyboard focus', async ({ page }) => {
  await open(page);
  await page.locator('#mode-picker-trigger').click();
  const menu = page.getByRole('dialog', { name: 'Permissions', exact: true });
  const row = menu.getByRole('menuitemradio').first();
  await expect(row.locator('.choice-menu-description')).toHaveCount(0);
  const mark = row.locator('.info-mark');
  await expect(mark).toHaveCount(1);
  const detail = (await mark.getAttribute('data-tip'))!;
  expect(detail.length).toBeGreaterThan(40);
  // The description still reaches assistive technology through aria-describedby.
  const describedBy = (await row.getAttribute('aria-describedby'))!;
  await expect(menu.locator(`#${describedBy}`)).toHaveText(detail);
  await expect(menu.locator(`#${describedBy}`)).toHaveClass(/sr-only/);
  // Hover shows one shared bubble; leaving the row hides it.
  const box = (await mark.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const bubble = page.getByRole('tooltip');
  await expect(bubble).toHaveText(detail);
  await expect(bubble).toHaveCount(1);
  await page.mouse.move(5, 5);
  await expect(bubble).toHaveCount(0);
  // Keyboard focus on a row with a mark shows the same bubble.
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowUp');
  await expect(row).toBeFocused();
  await expect(page.getByRole('tooltip')).toHaveText(detail);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('tooltip')).toHaveCount(0);
  await expect(menu).toHaveCount(0);
});

test('dialogs fold long descriptions and static field hints behind marks while keeping them readable', async ({ page }) => {
  await open(page);
  await page.locator('#branch-chip').click();
  await page.getByRole('menuitem', { name: /New task in a worktree/ }).click();
  const dialog = page.locator('#dialog');
  await expect(dialog.locator('.dialog-title h2')).toHaveText('New task in a worktree');
  const description = dialog.locator('.dialog-description');
  await expect(description).toHaveClass(/sr-only/);
  await expect(dialog).toHaveAttribute('aria-describedby', await description.evaluate(node => node.id));
  const titleMark = dialog.locator('.dialog-title .info-mark');
  await expect(titleMark).toHaveAttribute('data-tip', await description.evaluate(node => node.textContent!.trim()));
  // The live branch preview stays visible; the static base-branch hint becomes a label mark.
  await expect(dialog.locator('#branch-preview')).toBeVisible();
  await expect(dialog.locator('#branch-base-help')).toHaveClass(/sr-only/);
  await expect(dialog.locator('label[for="branch-base"] + .info-mark')).toHaveAttribute('data-tip', /Local branches load/);
  // The mark never leaks into the field's accessible name.
  await expect(dialog.getByRole('combobox', { name: 'Start from', exact: true })).toBeVisible();
  const box = (await titleMark.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  const bubble = page.getByRole('tooltip');
  await expect(bubble).toContainText('isolated checkout');
  // The bubble shares the dialog's top layer so it is not hidden behind the modal.
  expect(await bubble.evaluate(node => Boolean(node.closest('dialog[open]')))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

test('setting rows on the Settings page stay one line tall with notes and live status inline', async ({ page }) => {
  await open(page);
  await page.keyboard.press('Meta+,');
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const group = (name: string) => settings.getByRole('tab', { name, exact: true });
  const rows = settings.locator('.settings-panel:not([hidden]) .setting-row');
  await expect(rows.first()).toBeVisible();
  const heights = await rows.evaluateAll(nodes => nodes.map(node => node.getBoundingClientRect().height));
  for (const height of heights) expect(height).toBeLessThanOrEqual(64);
  // The page is wide enough for notes to stay readable beside each title, without marks.
  const compact = rows.filter({ hasText: 'Compact conversation' });
  await expect(compact.locator('small')).toBeVisible();
  await expect(compact.locator('.info-mark')).toHaveCount(0);
  await group('Tools & add-ons').click();
  const jev = rows.filter({ hasText: 'Jev' });
  await expect(jev.locator('small')).toBeVisible();
  await expect(jev.locator('small')).toHaveText('Browser tests and decision assistance. Your agents work without it.');
  await expect(jev.locator('.info-mark')).toHaveCount(0);
  expect((await jev.boundingBox())!.height).toBeLessThanOrEqual(64);
  // The GitHub status stays live and inline.
  await group('GitHub').click();
  const github = rows.filter({ hasText: 'GitHub' });
  await expect(github.locator('.github-settings-status')).toHaveText('Connected as you · orbit-labs/orbit');
  await expect(github.locator('.info-mark')).toHaveCount(0);
});

test('the project menu is flat glass with equal insets, a borderless search and a trailing check on the choice', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.sidebar.sort', JSON.stringify({ group: 'flat' })));
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.locator('#project-filter').click();
  const menu = page.locator('.floating-menu').first();
  await expect(menu).toBeVisible();
  // Measure once the menu has arrived (it scales in a few percent).
  await expect.poll(() => menu.evaluate(element => element.getAnimations().length)).toBe(0);
  const layout = await menu.evaluate(element => {
    const box = element.getBoundingClientRect(), border = parseFloat(getComputedStyle(element).borderTopWidth);
    const search = element.querySelector<HTMLElement>('[class*="menu-search"]')!;
    const rows = [...element.querySelectorAll('[role="menuitemradio"],[role="option"]')].map(row => row.getBoundingClientRect());
    const style = getComputedStyle(search);
    return {
      insets: [search.getBoundingClientRect().top - box.top, rows[0].left - box.left, box.right - rows[0].right, box.bottom - rows[rows.length - 1].bottom].map(value => Math.round(value - border)),
      searchBorders: [style.borderTopWidth, style.borderLeftWidth, style.borderRightWidth, style.borderBottomWidth],
      ticks: [...element.querySelectorAll('[aria-checked="true"]>.icon:last-child,[aria-selected="true"]>.icon:last-child')].filter(icon => icon.getClientRects().length > 0).length,
      surface: { glass: getComputedStyle(element).backgroundImage === 'none' && /^rgba\(/.test(getComputedStyle(element).backgroundColor), blur: getComputedStyle(element).backdropFilter.includes('blur'), width: Math.round(box.width) },
    };
  });
  expect(new Set(layout.insets).size).toBe(1);
  expect(layout.searchBorders).toEqual(['0px', '0px', '0px', '0px']);
  // "All projects" is the current choice: one trailing check, no filled row.
  expect(layout.ticks).toBe(1);
  // The flat --glass-* material (AGENTS.md): a translucent solid fill, no gradient; reduced transparency/contrast fall back to a solid panel.
  expect(layout.surface).toEqual({ glass: true, blur: true, width: 300 });
});
