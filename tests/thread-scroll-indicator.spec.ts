import { expect, test, type Locator, type Page } from '@playwright/test';
import { exposePreviewMessages, say, setThread, settled, type FixtureMessage } from './transcript-fixtures';

/* The left-side thread scroll indicator (src/thread-scroll-indicator.ts) and the scroll fixes it shipped with
 * (src/transcript-scroll.ts, src/main.ts): the reader's position is theirs, a jump of ours lands and stays, and the
 * rail takes no layout. Every test fails on anything thrown in the page. */

const TURNS = 12;
const transcriptOf = (page: Page) => page.locator('#transcript');
const rail = (page: Page) => page.locator('#thread-scroll-indicator');
const ticks = (page: Page) => rail(page).locator('.thread-scroll-tick');
const latest = (page: Page) => rail(page).locator('[data-scroll-action="latest"]');
const earlier = (page: Page) => rail(page).locator('[data-scroll-action="earlier"]');
const preview = (page: Page) => page.locator('#thread-scroll-preview');
const mirrorRow = (page: Page) => page.locator('#navigation .task-item').filter({ hasText: 'Long remote thread' });
const label = (turn: number) => String(turn).padStart(2, '0');
const promptOf = (page: Page, turn: number) => transcriptOf(page).locator('.user-message').filter({ hasText: `Prompt ${label(turn)}:` });
const message = (page: Page, n: number) => transcriptOf(page).getByText(`Message ${String(n).padStart(3, '0')}`, { exact: true });

/** Fails the test on anything thrown in the page. WebKit's benign ResizeObserver loop notice is ignored, as elsewhere in the suite. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => { if (!error.message.startsWith('ResizeObserver loop')) errors.push(error.message); });
  return errors;
}

const toolRecord = (n: number, lines: number) => JSON.stringify({
  type: 'tool_activity', version: 1, id: `t${n}`, name: 'Read', status: 'completed', input: `src/file-${n}.ts`,
  output: Array.from({ length: lines }, (_, line) => `line ${line} of file ${n}`).join('\n'),
});

/** `count` turns of a prompt (`Prompt 00: …`), a Read tool with a long output and a several-paragraph reply. */
function threadOf(count: number): FixtureMessage[] {
  return Array.from({ length: count }, (_, turn) => {
    const n = turn * 3;
    const reply = Array.from({ length: 6 }, (_, p) => `Reply ${label(turn)} paragraph ${p}. The quick brown fox jumps over the lazy dog again and again until the line wraps.`).join('\n\n');
    return [say(n, 'user', `Prompt ${label(turn)}: explain part ${label(turn)}`), say(n + 1, 'tool', toolRecord(n + 1, 80)), say(n + 2, 'assistant', reply)];
  }).flat();
}

async function seedMirror(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => (window as any).__previewMirrorThread(400, 400));
}

/** The mirror thread holding a `TURNS`-turn conversation, opened and pinned to the bottom with the rail shown. */
async function openThread(page: Page, count = TURNS): Promise<string[]> {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await exposePreviewMessages(page);
  await seedMirror(page);
  await setThread(page, 'mirror-long', threadOf(count));
  await mirrorRow(page).click();
  await expect(promptOf(page, count - 1)).toBeVisible();
  await expect(rail(page)).toBeVisible();
  await expect(ticks(page)).toHaveCount(count);
  // Every reply formats and then clamps (Read more) a moment after opening. A clamp landing after the reader has
  // scrolled can move them (a separate, older bug), so the reader's moves are tested from a settled thread.
  await expect.poll(() => transcriptOf(page).locator('.turn-card-reply').evaluateAll(replies => replies.filter(reply => !reply.querySelector('p')).length)).toBe(0);
  await expect.poll(() => transcriptOf(page).locator('.turn-card-reply[data-overflow]').count()).toBeGreaterThan(0);
  await settled(page);
  await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
  return errors;
}

/** The long mirror thread: 400 messages, its loaded page 300–399 as 50 turns of which the newest 20 are drawn. */
async function openLong(page: Page): Promise<string[]> {
  const errors = watchErrors(page);
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
  await seedMirror(page);
  await mirrorRow(page).click();
  await expect(message(page, 399)).toBeVisible();
  await expect(message(page, 359)).toHaveCount(0);
  await expect(rail(page)).toBeVisible();
  await settled(page);
  return errors;
}

const gap = (page: Page) => transcriptOf(page).evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight);
const scrollTop = (page: Page) => transcriptOf(page).evaluate(node => node.scrollTop);
const readingLine = (page: Page) => transcriptOf(page).evaluate(node => node.getBoundingClientRect().top + (parseFloat(getComputedStyle(node).scrollPaddingTop) || 0));
/** How far `target`'s top is from the transcript's reading line. */
const offReadingLine = async (page: Page, target: Locator) => (await target.boundingBox())!.y - await readingLine(page);
/** Whether `target` sits on the reading line, or as near as the scroll allows: the thread's first turn cannot come
 *  further down than the transcript's top padding puts it, so at scrollTop 0 it may rest just above the line. */
const landed = async (page: Page, target: Locator): Promise<boolean> => {
  const off = await offReadingLine(page, target);
  return Math.abs(off) <= 2 || (await scrollTop(page) === 0 && off < 0 && off > -40);
};
/** The viewport y of `target`'s top. */
const topOf = async (target: Locator) => (await target.boundingBox())!.y;
const rect = (page: Page, selector: string) => page.locator(selector).first().evaluate(node => node.getBoundingClientRect().toJSON() as DOMRect);
const activeTick = (page: Page) => ticks(page).evaluateAll(nodes => nodes.findIndex(node => node.hasAttribute('data-active')));
/** The turn whose prompt top is the last at or above the reading line, as the rail works it out. */
const turnAtReadingLine = (page: Page) => transcriptOf(page).evaluate(node => {
  const line = node.getBoundingClientRect().top + (parseFloat(getComputedStyle(node).scrollPaddingTop) || 0);
  const tops = [...node.querySelectorAll(':scope > .user-message')].map(item => item.getBoundingClientRect().top);
  return Math.max(0, tops.reduce((found, top, index) => (top <= line ? index : found), 0));
});
/** Waits until the transcript's scrollTop holds still for a few frames: a smooth jump or follow has landed. */
const scrollSettled = (page: Page) => expect.poll(async () => { const a = await scrollTop(page); await page.waitForTimeout(120); return Math.abs(a - await scrollTop(page)) < 0.5; }, { timeout: 5_000 }).toBe(true);

async function wheelOverTranscript(page: Page, deltaY: number): Promise<void> {
  const area = await rect(page, '#transcript');
  await page.mouse.move(area.left + area.width / 2, area.top + area.height / 2);
  await page.mouse.wheel(0, deltaY);
}

async function wheelAt(page: Page, point: { x: number; y: number }, deltaY: number): Promise<void> {
  await page.mouse.move(point.x, point.y);
  await page.mouse.wheel(0, deltaY);
}
/** A point over the transcript with no nested scroller under it (a code block or tool output would take the wheel). */
const plainPoint = (page: Page) => transcriptOf(page).evaluate(node => {
  const box = node.getBoundingClientRect(), x = box.left + box.width / 2;
  for (let y = box.top + 30; y < box.bottom - 10; y += 16) {
    const hit = document.elementFromPoint(x, y);
    if (hit && node.contains(hit) && !hit.closest('pre, .thinking-text, .error-row-detail')) return { x, y };
  }
  throw new Error('No plain point over the transcript');
});

/** Grows the bottom of the thread: a follower stays pinned, a reader who left stays where they were. */
const growThread = (page: Page, height = 240) => page.locator('#stream-region').evaluate((node, px) => {
  const extra = document.createElement('div');
  extra.className = 'scroll-test-growth'; extra.style.height = `${px}px`;
  node.append(extra);
}, height);

test.describe('thread scroll indicator', () => {
  test.describe('scroll snap-back fixes', () => {
    test('gentle 1–2px steps up from the bottom release the follow and never snap back', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      // Scripted steps reach only the scroll handler (a scrollbar drag or keys): the move up itself releases. What the
      // reader sees moves down by the step each time (scrollTop alone may also absorb a row growing above, anchored).
      const last = promptOf(page, TURNS - 1);
      for (const step of [1, 1, 2, 1]) {
        const before = await topOf(last);
        await transcriptOf(page).evaluate((node, px) => { node.scrollTop -= px; }, step);
        await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
        expect(Math.abs(await topOf(last) - (before + step))).toBeLessThanOrEqual(0.5);
      }
      expect(await gap(page)).toBeGreaterThanOrEqual(4);
      const held = await topOf(last);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(last) - held)).toBeLessThanOrEqual(0.5);
      expect(await gap(page)).toBeGreaterThan(200);

      // A real 2px wheel nudge after coming back to the bottom also lets go.
      await latest(page).click();
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      await wheelOverTranscript(page, -2);
      await page.waitForTimeout(150);
      const nudged = await topOf(last);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(last) - nudged)).toBeLessThanOrEqual(0.5);
      expect(await gap(page)).toBeGreaterThan(200);
      expect(errors).toEqual([]);
    });

    test('selecting the open thread again keeps the reader where they scrolled', async ({ page }) => {
      const errors = await openThread(page);
      await wheelOverTranscript(page, -900);
      await scrollSettled(page);
      const held = await scrollTop(page);
      expect(await gap(page)).toBeGreaterThan(200);
      await mirrorRow(page).click();
      await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', 'mirror-long');
      await page.waitForTimeout(600);
      await scrollSettled(page);
      expect(Math.abs(await scrollTop(page) - held)).toBeLessThanOrEqual(2);
      expect(await gap(page)).toBeGreaterThan(200);
      expect(errors).toEqual([]);
    });

    test('a wheel a nested tool output can still take leaves the thread following', async ({ page }) => {
      const errors = await openThread(page);
      // The last turn's tool output, opened by script so no focus lands in it (focus in a tool holds the follow).
      const pre = transcriptOf(page).locator('.turn-card').last().locator('.tool-activity pre[aria-label="Tool output"]');
      await transcriptOf(page).locator('.turn-card').last().evaluate(card => {
        card.querySelector<HTMLDetailsElement>('details.turn-activity')!.open = true;
        card.querySelector<HTMLDetailsElement>('details.tool-activity')!.open = true;
      });
      // The raw input/output sit in their own fold under the file preview.
      await transcriptOf(page).locator('.turn-card').last().locator('details.tool-trace-raw').evaluate(node => { (node as HTMLDetailsElement).open = true; });
      await expect(pre).toBeVisible();
      await expect.poll(() => pre.evaluate(node => node.scrollHeight > node.clientHeight + 20)).toBe(true);
      // Back to the bottom and following, with the output in view and scrolled to its end.
      await transcriptOf(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
      await wheelAt(page, await plainPoint(page), 40);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await pre.evaluate(node => { node.scrollTop = node.scrollHeight; });
      const box = (await pre.boundingBox())!, area = await rect(page, '#transcript');
      const y = Math.min(box.y + box.height - 20, area.bottom - 20);
      expect(y).toBeGreaterThan(Math.max(box.y, area.top) + 10);
      const preTop = await pre.evaluate(node => node.scrollTop);
      await page.mouse.move(box.x + box.width / 2, y);
      await page.mouse.wheel(0, -60);
      await expect.poll(() => pre.evaluate(node => node.scrollTop)).toBeLessThan(preTop);
      await page.waitForTimeout(150);
      await growThread(page);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await page.waitForTimeout(250);
      expect(await gap(page)).toBeLessThanOrEqual(2);

      // The same wheel over the thread itself lets go: the check above is not vacuous.
      await wheelAt(page, await plainPoint(page), -60);
      await page.waitForTimeout(150);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(await gap(page)).toBeGreaterThan(200);
      expect(errors).toEqual([]);
    });

    test('a wheel up during a smooth jump cancels it at once, with no snap back', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      const start = await scrollTop(page);
      // In one task each: the jump starts, then (two frames on, mid-flight) the reader's wheel arrives. What they see is
      // tracked by the row then on screen (a far row laying out may shift scrollTop, anchored, without moving it).
      const moving = await page.evaluate(async () => {
        const tick = document.querySelectorAll<HTMLButtonElement>('#thread-scroll-indicator .thread-scroll-tick')[3];
        tick.dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const transcript = document.querySelector<HTMLElement>('#transcript')!;
        const mid = transcript.scrollTop;
        transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -120, bubbles: true }));
        transcript.scrollTop = mid - 120;
        const box = transcript.getBoundingClientRect();
        const rows = [...transcript.querySelectorAll<HTMLElement>(':scope > .user-message')];
        const seen = rows.findIndex(row => { const top = row.getBoundingClientRect().top; return top >= box.top && top < box.bottom; });
        return { mid, seen, top: rows[seen]?.getBoundingClientRect().top ?? NaN };
      });
      expect(moving.mid).toBeLessThan(start - 1);
      expect(moving.seen).toBeGreaterThanOrEqual(0);
      const seen = transcriptOf(page).locator(':scope > .user-message').nth(moving.seen);
      await page.waitForTimeout(500);
      // Neither the jump's remaining frames nor a follow moved the reader after their wheel.
      expect(Math.abs(await topOf(seen) - moving.top)).toBeLessThanOrEqual(1);
      expect(Math.abs(await offReadingLine(page, promptOf(page, 3)))).toBeGreaterThan(20);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(seen) - moving.top)).toBeLessThanOrEqual(1);
      expect(errors).toEqual([]);
    });

    test('focus left in a tool summary does not stop Jump to latest from following', async ({ page }) => {
      const errors = await openThread(page);
      const summary = transcriptOf(page).locator('.turn-card').last().locator('.turn-activity-summary');
      await summary.focus();
      await expect(summary).toBeFocused();
      await wheelOverTranscript(page, -700);
      await scrollSettled(page);
      expect(await gap(page)).toBeGreaterThan(300);
      await expect(latest(page)).toBeVisible();
      await latest(page).click();
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      await growThread(page);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await expect(latest(page)).toBeHidden();
      expect(errors).toEqual([]);
    });
  });

  test.describe('rail', () => {
    test('shows on a thread, and not on the New task page or in a narrow window', async ({ page }) => {
      const errors = await openThread(page);
      const box = await rect(page, '#thread-scroll-indicator');
      const pane = await rect(page, '.conversation-pane');
      // At the pane's left edge, between the top band and the composer.
      expect(box.left - pane.left).toBeLessThan(20);
      expect(box.bottom).toBeLessThanOrEqual((await rect(page, '#composer-area')).top);
      expect(box.top).toBeGreaterThanOrEqual((await rect(page, '.workspace-header')).bottom);
      await expect(rail(page)).toHaveAttribute('aria-label', 'Thread navigation');

      await page.locator('.new-task-button').click();
      await expect(page.locator('.conversation-pane.new-task-page')).toBeVisible();
      await expect(rail(page)).toBeHidden();
      await mirrorRow(page).click();
      await expect(rail(page)).toBeVisible();

      await page.setViewportSize({ width: 640, height: 800 });
      await expect(rail(page)).toBeHidden();
      await expect(preview(page)).toBeHidden();
      await page.setViewportSize({ width: 1280, height: 800 });
      await expect(rail(page)).toBeVisible();
      expect(errors).toEqual([]);
    });

    test('takes no layout: the thread and composer measure the same with the rail gone', async ({ page }) => {
      const errors = await openThread(page);
      const measure = () => page.evaluate(() => Object.fromEntries(['#transcript', '#composer', '#composer-area']
        .map(selector => { const box = document.querySelector(selector)!.getBoundingClientRect(); return [selector, { left: box.left, right: box.right, width: box.width, top: box.top }]; })));
      const shown = await measure();
      await rail(page).evaluate(node => { (node as HTMLElement).style.display = 'none'; });
      expect(await measure()).toEqual(shown);
      await rail(page).evaluate(node => { (node as HTMLElement).style.display = ''; });
      const pane = await rect(page, '.conversation-pane');
      expect(shown['#transcript'].left).toBe(pane.left);
      expect(shown['#transcript'].right).toBe(pane.right);
      expect(await rail(page).evaluate(node => getComputedStyle(node).position)).toBe('absolute');
      expect(errors).toEqual([]);
    });

    test('the current tick follows the reading line; Jump to latest shows only away from the bottom', async ({ page }) => {
      const errors = await openThread(page);
      await expect.poll(() => activeTick(page)).toBe(TURNS - 1);
      await expect(latest(page)).toBeHidden();
      await expect(ticks(page).nth(TURNS - 1)).toHaveAttribute('aria-current', 'location');
      for (let step = 0; step < 4; step++) {
        await wheelOverTranscript(page, -500);
        await scrollSettled(page);
        await expect(latest(page)).toBeVisible();
        const expected = await turnAtReadingLine(page);
        await expect.poll(() => activeTick(page)).toBe(expected);
      }
      const high = await activeTick(page);
      expect(high).toBeLessThan(TURNS - 2);
      await wheelOverTranscript(page, 700);
      await scrollSettled(page);
      const expected = await turnAtReadingLine(page);
      expect(expected).toBeGreaterThan(high);
      await expect.poll(() => activeTick(page)).toBe(expected);
      await expect(rail(page).locator('[aria-current="location"]')).toHaveCount(1);
      // Back at the bottom by the wheel: the newest turn is current and the chevron goes.
      await wheelOverTranscript(page, 20_000);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await expect(latest(page)).toBeHidden();
      await expect.poll(() => activeTick(page)).toBe(TURNS - 1);
      expect(errors).toEqual([]);
    });

    test('hovering or focusing a tick previews its turn; Escape and leaving dismiss it', async ({ page }) => {
      const errors = await openThread(page);
      await ticks(page).nth(2).hover();
      await expect(preview(page)).toBeVisible();
      await expect(preview(page).locator('.thread-scroll-preview-title')).toHaveText(`Turn 3 of ${TURNS}`);
      await expect(preview(page).locator('.thread-scroll-preview-text')).toHaveText('Prompt 02: explain part 02');
      await expect(preview(page)).toHaveAttribute('role', 'tooltip');
      // Right of the rail, centred on the tick within the free band.
      const bubble = await rect(page, '#thread-scroll-preview'), bar = await rect(page, '#thread-scroll-indicator');
      expect(bubble.left).toBeGreaterThanOrEqual(bar.right);
      // Moving to the next tick swaps the text at once.
      await ticks(page).nth(5).hover();
      await expect(preview(page).locator('.thread-scroll-preview-text')).toHaveText('Prompt 05: explain part 05');
      const area = await rect(page, '#transcript');
      await page.mouse.move(area.left + area.width / 2, area.top + area.height / 2);
      await expect(preview(page)).toBeHidden();

      await ticks(page).nth(7).focus();
      await expect(preview(page)).toBeVisible();
      await expect(preview(page).locator('.thread-scroll-preview-title')).toHaveText(`Turn 8 of ${TURNS}`);
      await page.keyboard.press('Escape');
      await expect(preview(page)).toBeHidden();
      await expect(ticks(page).nth(7)).toBeFocused();
      expect(errors).toEqual([]);
    });

    test('one click on a drawn turn eases it to the reading line, and it stays there', async ({ page }) => {
      const errors = await openThread(page);
      const target = promptOf(page, 4);
      await ticks(page).nth(4).click();
      await expect.poll(async () => Math.abs(await offReadingLine(page, target))).toBeLessThanOrEqual(2);
      await expect.poll(() => activeTick(page)).toBe(4);
      await expect(latest(page)).toBeVisible();
      await page.waitForTimeout(600);
      expect(Math.abs(await offReadingLine(page, target))).toBeLessThanOrEqual(2);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await offReadingLine(page, target))).toBeLessThanOrEqual(2);
      // A second jump further down lands too.
      await ticks(page).nth(9).click();
      await expect.poll(async () => Math.abs(await offReadingLine(page, promptOf(page, 9)))).toBeLessThanOrEqual(2);
      await page.waitForTimeout(400);
      expect(Math.abs(await offReadingLine(page, promptOf(page, 9)))).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    });

    test('a row above that changes size mid-jump does not stop the jump', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      // Formatting or a clamp landing above the reader shifts scrollTop (scroll anchoring) while the jump eases there:
      // the jump must still land, not read the shift as the reader taking over.
      await page.evaluate(async () => {
        const transcript = document.querySelector<HTMLElement>('#transcript')!;
        document.querySelectorAll<HTMLButtonElement>('#thread-scroll-indicator .thread-scroll-tick')[4].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const line = transcript.getBoundingClientRect().top;
        const above = [...transcript.querySelectorAll<HTMLElement>(':scope > .turn-card')].filter(card => card.getBoundingClientRect().bottom < line).at(-1);
        if (!above) throw new Error('No row above the reader mid-jump');
        const grown = document.createElement('div');
        grown.style.height = '200px';
        above.append(grown);
      });
      await expect.poll(async () => Math.abs(await offReadingLine(page, promptOf(page, 4)))).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    });

    test('one click on Jump to latest returns to the bottom and follows again', async ({ page }) => {
      const errors = await openThread(page);
      await wheelOverTranscript(page, -1200);
      await scrollSettled(page);
      expect(await gap(page)).toBeGreaterThan(600);
      await latest(page).click();
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await expect(latest(page)).toBeHidden();
      await expect.poll(() => activeTick(page)).toBe(TURNS - 1);
      await growThread(page);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await page.waitForTimeout(300);
      expect(await gap(page)).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    });

    test('keyboard: one Tab stop, arrows, Home and End move it, Enter and Space jump, Escape closes the preview', async ({ page }) => {
      const errors = await openThread(page);
      const tabStops = () => rail(page).locator('button').evaluateAll(nodes => nodes.filter(node => (node as HTMLButtonElement).tabIndex === 0).length);
      expect(await tabStops()).toBe(1);
      await expect(ticks(page).nth(TURNS - 1)).toHaveAttribute('tabindex', '0');
      await ticks(page).nth(TURNS - 1).focus();
      await page.keyboard.press('ArrowUp');
      await expect(ticks(page).nth(TURNS - 2)).toBeFocused();
      await expect(ticks(page).nth(TURNS - 2)).toHaveAttribute('tabindex', '0');
      expect(await tabStops()).toBe(1);
      await page.keyboard.press('Home');
      await expect(ticks(page).first()).toBeFocused();
      await page.keyboard.press('ArrowUp');
      // Arrows wrap: up from the first stop is the last.
      await expect(ticks(page).nth(TURNS - 1)).toBeFocused();
      for (let step = 0; step < 3; step++) await page.keyboard.press('ArrowUp');
      await expect(ticks(page).nth(TURNS - 4)).toBeFocused();
      await expect(preview(page).locator('.thread-scroll-preview-text')).toHaveText(`Prompt ${label(TURNS - 4)}: explain part ${label(TURNS - 4)}`);
      await page.keyboard.press('Enter');
      await expect.poll(async () => Math.abs(await offReadingLine(page, promptOf(page, TURNS - 4)))).toBeLessThanOrEqual(2);
      await expect(ticks(page).nth(TURNS - 4)).toBeFocused();
      await page.keyboard.press('ArrowUp');
      await page.keyboard.press('ArrowUp');
      await expect(ticks(page).nth(TURNS - 6)).toBeFocused();
      await page.keyboard.press('Space');
      await expect.poll(async () => Math.abs(await offReadingLine(page, promptOf(page, TURNS - 6)))).toBeLessThanOrEqual(2);
      await expect(preview(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(preview(page)).toBeHidden();
      // Away from the bottom the chevron is the last stop: End reaches it, and Enter jumps to the latest reply.
      await expect(latest(page)).toBeVisible();
      await page.keyboard.press('End');
      await expect(latest(page)).toBeFocused();
      await page.keyboard.press('Enter');
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await expect(latest(page)).toBeHidden();
      expect(await tabStops()).toBe(1);
      expect(errors).toEqual([]);
    });

    test('a wheel over the rail scrolls the thread', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      const box = await rect(page, '#thread-scroll-indicator');
      const hit = await page.evaluate(([x, y]) => document.elementFromPoint(x, y)?.closest('#thread-scroll-indicator') !== null, [box.left + box.width / 2, box.top + box.height / 2]);
      expect(hit).toBe(true);
      await page.mouse.move(box.left + box.width / 2, box.top + box.height / 2);
      const before = await scrollTop(page);
      await page.mouse.wheel(0, -300);
      await expect.poll(async () => before - await scrollTop(page)).toBeGreaterThan(280);
      await scrollSettled(page);
      const up = await scrollTop(page);
      expect(before - up).toBeLessThan(320);
      // The wheel released the follow like one over the thread: the reader is not pulled back down.
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await scrollTop(page) - up)).toBeLessThanOrEqual(1);
      await page.mouse.wheel(0, 120);
      await expect.poll(async () => await scrollTop(page) - up).toBeGreaterThan(100);
      expect(errors).toEqual([]);
    });
  });

  test.describe('long windowed thread', () => {
    test('one click on a turn not drawn yet draws down to it and lands there', async ({ page }) => {
      const errors = await openLong(page);
      // 50 turns fold into ranges; the first tick is the oldest loaded turn (Message 300), far above the window.
      await expect(ticks(page).first()).toHaveAttribute('data-preview-text', 'Message 300');
      await expect(message(page, 300)).toHaveCount(0);
      await ticks(page).first().click();
      await expect(message(page, 300)).toHaveCount(1);
      const target = transcriptOf(page).locator('.user-message[data-message-id="100300"]');
      await expect.poll(() => landed(page, target), { timeout: 10_000 }).toBe(true);
      await expect.poll(() => activeTick(page)).toBe(0);
      await page.waitForTimeout(600);
      expect(await landed(page, target)).toBe(true);
      await expect(target).toBeInViewport();
      expect(await gap(page)).toBeGreaterThan(500);
      // And back down to the newest reply, following again.
      await latest(page).click();
      await expect.poll(() => gap(page), { timeout: 10_000 }).toBeLessThanOrEqual(2);
      await expect(message(page, 399)).toBeInViewport();
      expect(errors).toEqual([]);
    });

    test('one click on Load earlier fetches an older page and lands on its newest turn', async ({ page }) => {
      const errors = await openLong(page);
      await expect(earlier(page)).toBeVisible();
      await expect(message(page, 298)).toHaveCount(0);
      await earlier(page).hover();
      await expect(preview(page).locator('.thread-scroll-preview-title')).toHaveText('Load earlier messages');
      await earlier(page).click();
      await expect(message(page, 298)).toHaveCount(1, { timeout: 10_000 });
      const target = transcriptOf(page).locator('.user-message[data-message-id="100298"]');
      await expect.poll(() => landed(page, target), { timeout: 10_000 }).toBe(true);
      await page.waitForTimeout(500);
      expect(await landed(page, target)).toBe(true);
      await expect(target).toBeInViewport();
      // The rail counts the fetched page's turns too.
      await expect(ticks(page).first()).toHaveAttribute('data-preview-title', /of 100$/);
      expect(errors).toEqual([]);
    });
  });

  test.describe('reduced motion', () => {
    test.use({ reducedMotion: 'reduce' });

    test('a one-click jump lands at once, without easing', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      // Where the target sits at every scroll the transcript reports: an eased jump passes through several positions,
      // an instant one is already there at its first write (and in the same task as the click).
      const seen = await page.evaluate(async () => {
        const transcript = document.querySelector<HTMLElement>('#transcript')!;
        const target = [...transcript.querySelectorAll<HTMLElement>(':scope > .user-message')][6];
        const off = () => Math.round(target.getBoundingClientRect().top - transcript.getBoundingClientRect().top - (parseFloat(getComputedStyle(transcript).scrollPaddingTop) || 0));
        const offs: number[] = [];
        const record = () => offs.push(off());
        transcript.addEventListener('scroll', record);
        document.querySelectorAll<HTMLButtonElement>('#thread-scroll-indicator .thread-scroll-tick')[6].dispatchEvent(new MouseEvent('click', { bubbles: true, detail: 1 }));
        await new Promise(resolve => setTimeout(resolve, 0));
        const immediate = off();
        await new Promise(resolve => setTimeout(resolve, 400));
        transcript.removeEventListener('scroll', record);
        return { immediate, offs };
      });
      expect(Math.abs(seen.immediate)).toBeLessThanOrEqual(2);
      expect(seen.offs.length).toBeGreaterThan(0);
      expect(Math.abs(seen.offs[0])).toBeLessThanOrEqual(2);
      expect(Math.abs(await offReadingLine(page, promptOf(page, 6)))).toBeLessThanOrEqual(2);
      expect(errors).toEqual([]);
    });
  });
});
