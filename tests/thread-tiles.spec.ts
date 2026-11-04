import { expect, test, type Page } from '@playwright/test';

const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tile = (page: Page, id: string) => page.locator(`.thread-tile[data-tile="${id}"]`);
const box = async (page: Page, selector: string) => page.locator(selector).first().evaluate(node => { const { left, top, right, bottom } = node.getBoundingClientRect(); return { left, top, right, bottom }; });
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?cards');
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#navigation .task-item').nth(1)).toBeVisible();
}
async function threads(page: Page): Promise<string[]> {
  return page.locator('#navigation .task-item[data-id]').evaluateAll(rows => rows.map(node => (node as HTMLElement).dataset.id!));
}
const current = (page: Page) => page.locator('#navigation .task-item.selected').getAttribute('data-id');

test.describe('thread tiles', () => {
  test('one thread has no tiles and the pane keeps its plain layout', async ({ page }) => {
    await open(page);
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    expect(await page.locator('.work-area').getAttribute('data-tiles')).toBeNull();
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('⌘-click opens a thread side by side, inside the thread area', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect.poll(() => current(page)).toBe(other);
    // A new tile arrives with a slight scale: read the positions once it has landed.
    await page.locator('.thread-tile').evaluateAll(tiles => Promise.all(tiles.flatMap(tile => tile.getAnimations().map(animation => animation.finished.catch(() => undefined)))));
    const a = await box(page, `.thread-tile[data-tile="${first}"]`), b = await box(page, `.thread-tile[data-tile="${other}"]`), area = await box(page, '.work-area');
    expect(a.top).toBe(b.top);
    expect(b.left).toBeGreaterThanOrEqual(a.right);
    for (const rect of [a, b]) { expect(rect.left).toBeGreaterThanOrEqual(area.left); expect(rect.right).toBeLessThanOrEqual(area.right); expect(rect.bottom).toBeLessThanOrEqual(area.bottom); }
    const sidebar = await box(page, '.sidebar'), inspector = await box(page, '#inspector');
    expect(a.left).toBeGreaterThanOrEqual(sidebar.right);
    expect(b.right).toBeLessThanOrEqual(inspector.left);
    // The real pane sits in the focused tile, under its bar.
    const pane = await box(page, '.work-area>.conversation-pane');
    expect(pane.left).toBe(b.left);
    expect(pane.top).toBe(b.top + 38);
    await expect(tile(page, other).locator('.thread-mirror')).toBeHidden();
    await expect(tile(page, first).locator('.thread-mirror')).toBeVisible();
    await expect(tile(page, first).locator('.turn-card, .message').first()).toBeVisible();
  });

  test('dragging a thread from the sidebar shows them side by side before the drop', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    const from = await row(page, other).boundingBox(), area = await box(page, '.work-area');
    await page.mouse.move(from!.x + 40, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 80, from!.y + 20, { steps: 3 });
    await page.mouse.move(area.right - 80, (area.top + area.bottom) / 2, { steps: 6 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect(tile(page, other)).toHaveAttribute('data-ghost', '');
    await expect(tile(page, other).locator('.turn-card, .message').first()).toBeVisible();
    // The pointer is on the right, so the dragged thread settles there.
    await expect.poll(async () => (await box(page, `.thread-tile[data-tile="${other}"]`)).left - (await box(page, `.thread-tile[data-tile="${first}"]`)).left).toBeGreaterThan(100);
    await page.mouse.up();
    await expect.poll(() => current(page)).toBe(other);
    await expect(tile(page, other)).not.toHaveAttribute('data-ghost', '');
    await expect(page.locator('.thread-tile')).toHaveCount(2);
  });

  test('a drag that leaves the area puts everything back', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    const from = await row(page, other).boundingBox(), area = await box(page, '.work-area');
    await page.mouse.move(from!.x + 40, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 80, from!.y + 20, { steps: 3 });
    await page.mouse.move(area.right - 80, (area.top + area.bottom) / 2, { steps: 6 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await page.mouse.move(from!.x + 40, from!.y + 10, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    expect(await current(page)).toBe(first);
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('clicking a view focuses it, and the sidebar replaces only the focused tile', async ({ page }) => {
    await open(page);
    const all = await threads(page), first = (await current(page))!, rest = all.filter(id => id !== first);
    await row(page, rest[0]).click({ modifiers: ['Meta'] });
    await expect.poll(() => current(page)).toBe(rest[0]);
    await tile(page, first).locator('.thread-mirror').click();
    await expect.poll(() => current(page)).toBe(first);
    await expect(tile(page, first).locator('.thread-mirror')).toBeHidden();
    await expect(tile(page, rest[0]).locator('.thread-mirror')).toBeVisible();
    await row(page, rest[1]).click();
    await expect(tile(page, rest[1])).toHaveCount(1);
    await expect(tile(page, first)).toHaveCount(0);
    await expect(tile(page, rest[0])).toHaveCount(1);
  });

  test('closing down to one thread returns to the plain pane, and tiles survive a reload', async ({ page }) => {
    await open(page);
    const all = await threads(page), first = (await current(page))!, rest = all.filter(id => id !== first);
    await row(page, rest[0]).click({ modifiers: ['Meta'] });
    await row(page, rest[1]).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('#composer')).toBeVisible();
    const again = page.locator('.thread-tile');
    await expect(again).toHaveCount(3);
    await tile(page, rest[1]).locator('.thread-tile-bar').hover();
    await tile(page, rest[1]).locator('.thread-tile-close').click();
    await expect(again).toHaveCount(2);
    await tile(page, rest[0]).locator('.thread-tile-bar').hover();
    await tile(page, rest[0]).locator('.thread-tile-close').click();
    await expect(again).toHaveCount(0);
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('a window too small for the tiles shows the focused thread alone', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await page.setViewportSize({ width: 620, height: 700 });
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
  });

  test('a wallpaper is cut to the tiles, so the frame shows between them and at their corners', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: true, visibility: 60, blur: 0, set: 'automatic', pinned: null })));
    await open(page);
    await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'wallpaper');
    const clip = () => page.locator('.workspace-wallpaper').evaluate(node => (node as HTMLElement).style.clipPath);
    expect(await clip()).toBe('');
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect.poll(async () => ((await clip()).match(/M/g) ?? []).length).toBe(2);
    // The cut lines up with each tile, in the wallpaper's own coordinates.
    const cut = await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('.workspace-wallpaper')!, from = layer.getBoundingClientRect();
      const left = [...layer.style.clipPath.matchAll(/M([\d.]+) ([\d.]+)/g)].map(match => Number(match[1]));
      return { left, tiles: [...document.querySelectorAll('.thread-tile')].map(tile => tile.getBoundingClientRect().left - from.left), radius: parseFloat(getComputedStyle(document.querySelector('.thread-tile')!).borderTopLeftRadius) };
    });
    cut.left.forEach((value, index) => expect(Math.abs(value - cut.radius - cut.tiles[index])).toBeLessThan(1));
    await tile(page, other).locator('.thread-tile-bar').hover();
    await tile(page, other).locator('.thread-tile-close').click();
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    await expect.poll(clip).toBe('');
  });

  test('every tile shows its own thread in the sky and moves nothing under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect(page.locator('.thread-tile>.thread-sky')).toHaveCount(2);
    expect(await page.evaluate(() => document.getAnimations().filter(animation => (animation.effect as KeyframeEffect | null)?.target?.closest?.('.thread-tile')).length)).toBe(0);
  });
});
