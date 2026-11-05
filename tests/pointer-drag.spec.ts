import { expect, test, type Page } from '@playwright/test';

// Tauri's file-drop handler claims every drag at the native view, so WKWebView never sends the page dragover or drop
// (wry `drag_drop.rs`). These specs discard the browser's own drag events the same way, so a drag can only work here the
// way it works in the app. Titles start with "pointer drag" for the WebKit grep.
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    (window as any).__nativeDragEvents = 0;
    for (const type of ['dragenter', 'dragover', 'dragleave', 'drop']) {
      window.addEventListener(type, event => { if (event.isTrusted) { (window as any).__nativeDragEvents++; event.stopImmediatePropagation(); } }, true);
    }
  });
});

const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const threads = (page: Page) => page.locator('#navigation .task-item[data-id]').evaluateAll(rows => rows.map(item => (item as HTMLElement).dataset.id!));
const current = (page: Page) => page.locator('#navigation .task-item.selected').getAttribute('data-id');
const box = async (page: Page, selector: string) => { const b = (await page.locator(selector).first().boundingBox())!; return { ...b, right: b.x + b.width, bottom: b.y + b.height }; };
async function open(page: Page) {
  await page.goto('/?sky=12:00');
  await page.locator('#navigation .task-item').first().waitFor();
  await expect(page.locator('#transcript')).toBeVisible();
  await page.waitForTimeout(600);
}
async function dragTo(page: Page, id: string, x: number, y: number) {
  const from = (await row(page, id).boundingBox())!;
  await page.mouse.move(from.x + 40, from.y + 10);
  await page.mouse.down();
  await page.mouse.move(from.x + 80, from.y + 20, { steps: 3 });
  await page.mouse.move(x, y, { steps: 6 });
}

test('pointer drag: a sidebar thread tiles beside the open one, with the native view swallowing drags', async ({ page }) => {
  await open(page);
  const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
  const area = await box(page, '.work-area');
  await dragTo(page, other, area.right - 80, (area.y + area.bottom) / 2);
  await expect(page.locator('.drag-ghost')).toBeVisible();
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  await expect(page.locator(`.thread-tile[data-tile="${other}"]`)).toHaveAttribute('data-ghost', '');
  await page.mouse.up();
  await expect.poll(() => current(page)).toBe(other);
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await expect(page.locator('html')).not.toHaveAttribute('data-pointer-drag');
});

test('pointer drag: a tile moves by its bar', async ({ page }) => {
  await open(page);
  const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
  await row(page, other).click({ modifiers: ['ControlOrMeta'] });
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  const order = () => page.locator('.thread-tile').evaluateAll(tiles => [...tiles].sort((a, b) => a.getBoundingClientRect().left - b.getBoundingClientRect().left).map(tile => (tile as HTMLElement).dataset.tile));
  const before = await order();
  const left = await box(page, `.thread-tile[data-tile="${before[0]}"]`), right = await box(page, `.thread-tile[data-tile="${before[1]}"]`);
  await page.mouse.move(left.x + left.width / 2, left.y + 18);
  await page.mouse.down();
  await page.mouse.move(left.x + left.width / 2 + 30, left.y + 22, { steps: 3 });
  await page.mouse.move(right.right - 30, (right.y + right.bottom) / 2, { steps: 8 });
  await expect.poll(order).toEqual([before[1], before[0]]);
  await page.mouse.up();
  await expect.poll(order).toEqual([before[1], before[0]]);
});

test('pointer drag: Escape cancels, puts the tiles back and stops nothing else', async ({ page }) => {
  await open(page);
  const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
  const area = await box(page, '.work-area');
  await dragTo(page, other, area.right - 80, (area.y + area.bottom) / 2);
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  await page.keyboard.press('Escape');
  await expect(page.locator('.thread-tile')).toHaveCount(0);
  await expect(page.locator('.drag-ghost')).toHaveCount(0);
  await page.mouse.up();
  expect(await current(page)).toBe(first);
});

test('pointer drag: releasing back on the sidebar row does not click it', async ({ page }) => {
  await open(page);
  const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
  const from = (await row(page, other).boundingBox())!;
  await dragTo(page, other, from.x + 60, from.y + 14);
  await page.mouse.up();
  await page.waitForTimeout(150);
  expect(await current(page)).toBe(first);
  // The next ordinary click still lands.
  await row(page, other).click();
  await expect.poll(() => current(page)).toBe(other);
});

test('pointer drag: a thread dropped on a new task page simply opens', async ({ page }) => {
  await open(page);
  const ids = await threads(page);
  await page.locator('.new-task-button').click();
  await expect(page.locator('.conversation-pane.new-task-page')).toBeVisible();
  const area = await box(page, '.work-area');
  await dragTo(page, ids[1], (area.x + area.right) / 2, (area.y + area.bottom) / 2);
  await page.mouse.up();
  await expect.poll(() => current(page)).toBe(ids[1]);
  await expect(page.locator('.thread-tile')).toHaveCount(0);
});

test('pointer drag: sidebar rows reorder under Manual', async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem('pandacode.sidebar.sort', JSON.stringify({ sort: 'manual' })));
  await open(page);
  const finished = () => page.locator('#navigation [data-thread-group="review"] .task-item[data-reorderable="true"]').evaluateAll(rows => rows.map(item => (item as HTMLElement).dataset.id!));
  const before = await finished();
  expect(before.length).toBeGreaterThan(1);
  const target = (await row(page, before[before.length - 1]).boundingBox())!;
  await dragTo(page, before[0], target.x + 40, target.y + target.height - 6);
  await expect(row(page, before[before.length - 1])).toHaveClass(/drop-after/);
  await page.mouse.up();
  await expect.poll(finished).toEqual([...before.slice(1), before[0]]);
});

test('pointer drag: queued messages reorder with the native view swallowing drags', async ({ page }) => {
  await open(page);
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await prompt.fill('Start'); await prompt.press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  for (const text of ['One', 'Two']) { await prompt.fill(text); await prompt.press('Enter'); }
  const rows = page.locator('.queue-list > .queue-row');
  await expect(rows).toHaveCount(2);
  const queued = rows.locator('.queue-text');
  const start = await queued.allTextContents();
  await rows.nth(1).dragTo(rows.nth(0));
  await expect(queued).toHaveText([start[1], start[0]]);
});

test('pointer drag: selected text is left to the browser', async ({ page }) => {
  await open(page);
  // A non-draggable start: nothing is replayed, so no ghost and no state to clean up.
  const replayed = await page.evaluate(() => {
    const note = document.createElement('p'); note.textContent = 'plain text'; document.body.append(note);
    let seen = 0; window.addEventListener('dragstart', event => { if (!event.isTrusted) seen++; }, true);
    note.dispatchEvent(new DragEvent('dragstart', { bubbles: true, cancelable: true }));
    const ghost = document.querySelector('.drag-ghost'); note.remove();
    return { seen, ghost: Boolean(ghost) };
  });
  expect(replayed).toEqual({ seen: 1, ghost: false });
});
