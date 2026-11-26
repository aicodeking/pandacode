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

/* Older turns whose long replies clamp under Read more (transcript-view.ts prepend and joinPage). */
const CLAMPED_TURNS = 60;
/** Turns whose reply runs past LAZY_REPLY_CHARS (8000), so it formats only as it nears the reader. */
const LAZY_TURNS = [3, 25, 41];
const CUT_TURN = 10;
/** `count` turns of a prompt and a 24-paragraph reply (clamped under Read more), the LAZY_TURNS' replies over 9,000
 *  characters. Turn CUT_TURN carries a tool too, so the newest 100 messages start inside it. */
function clampedThreadOf(count: number): FixtureMessage[] {
  let n = 0;
  return Array.from({ length: count }, (_, turn) => {
    const lazy = LAZY_TURNS.includes(turn);
    const reply = Array.from({ length: lazy ? 90 : 24 }, (_, p) => `${lazy ? 'Lazy' : 'Reply'} ${label(turn)} paragraph ${p}. The quick brown fox jumps over the lazy dog again and again until the line wraps.`).join('\n\n');
    const prompt = say(n++, 'user', `Prompt ${label(turn)}: explain part ${label(turn)}`);
    const tool = turn === CUT_TURN ? [say(n++, 'tool', toolRecord(n, 4))] : [];
    return [prompt, ...tool, say(n++, 'assistant', reply)];
  }).flat();
}

/** Records, for every step up (rows inserted at the transcript's top) and every older page joined into the oldest row
 *  (redrawRow, which first moves the row's formatted text out), how far the prompt or reply on the reading line moved
 *  from the task's first change to the end of that task; and the tallest folded reply seen in any frame. */
const probePrepends = (page: Page) => transcriptOf(page).evaluate(node => {
  const probe = { shifts: [] as number[], joins: [] as number[], maxReply: 0, lazyPaints: 0, unclamped: 0 };
  (window as any).__prependProbe = probe;
  const line = () => node.getBoundingClientRect().top + (parseFloat(getComputedStyle(node).scrollPaddingTop) || 0);
  const anchor = () => {
    const at = line();
    return [...node.querySelectorAll<HTMLElement>('.user-message, .turn-card-reply')]
      .filter(item => item.getBoundingClientRect().bottom > at)
      .sort((a, b) => Math.abs(a.getBoundingClientRect().top - at) - Math.abs(b.getBoundingClientRect().top - at))[0];
  };
  /** The reading line's content as the task found it, before its first change; measured again once the task ends. */
  let baseline: { held: HTMLElement | undefined; top: number; first: ChildNode | null; inserted: boolean } | undefined;
  const capture = (): NonNullable<typeof baseline> => {
    if (baseline) return baseline;
    const held = anchor(), taken = { held, top: held?.getBoundingClientRect().top ?? 0, first: node.firstChild, inserted: false };
    baseline = taken;
    // The task's own work (the clamps and the restore) runs to its end before a microtask.
    queueMicrotask(() => {
      baseline = undefined;
      if (!taken.inserted || !taken.held?.isConnected) return;
      const shift = taken.held.getBoundingClientRect().top - taken.top;
      // A redraw takes the old first row out in the same task; a step leaves it below the new rows.
      (taken.first?.isConnected ? probe.shifts : probe.joins).push(shift);
    });
    return taken;
  };
  const replaceWith = Element.prototype.replaceWith;
  Element.prototype.replaceWith = function (this: Element, ...nodes: (Node | string)[]) {
    // A formatted node kept from the row moves out of the document's row into the new one (main.ts paintSavedMarkdown).
    if (node.contains(this) || nodes.some(moved => moved instanceof Node && node.contains(moved))) capture();
    return replaceWith.apply(this, nodes);
  };
  const insert = node.insertBefore;
  node.insertBefore = function <T extends Node>(this: HTMLElement, child: T, ref: Node | null): T {
    if (child instanceof DocumentFragment && ref === node.firstChild) capture().inserted = true;
    return insert.call(this, child, ref) as T;
  };
  // A long folded reply formats as it nears the reader: its text must never sit in the document without its clamp,
  // checked when the task that wrote it ends (raw text first, or a clamp left to the next frame's observer, fail).
  new MutationObserver(records => {
    const replies = new Set(records.flatMap(record => {
      const reply = (record.target instanceof Element ? record.target : record.target.parentElement)?.closest<HTMLElement>('.turn-card-reply');
      return reply && !reply.hasAttribute('data-open') && reply.textContent!.includes('Lazy ') ? [reply] : [];
    }));
    for (const reply of replies) {
      if (reply.querySelector('.turn-card-reply-content')!.textContent!.length < 8000) continue;
      probe.lazyPaints++;
      if (!reply.hasAttribute('data-overflow')) probe.unclamped++;
    }
  }).observe(node, { childList: true, characterData: true, subtree: true });
  const frame = () => {
    for (const reply of node.querySelectorAll<HTMLElement>('.turn-card-reply:not([data-open]):not(.is-live)')) probe.maxReply = Math.max(probe.maxReply, reply.offsetHeight);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
});
/** The prompt or reply nearest the reading line is marked; answers its top. */
const readingAnchor = (page: Page) => transcriptOf(page).evaluate(node => {
  const at = node.getBoundingClientRect().top + (parseFloat(getComputedStyle(node).scrollPaddingTop) || 0);
  const held = [...node.querySelectorAll<HTMLElement>('.user-message, .turn-card-reply')]
    .filter(item => item.getBoundingClientRect().bottom > at)
    .sort((a, b) => Math.abs(a.getBoundingClientRect().top - at) - Math.abs(b.getBoundingClientRect().top - at))[0];
  (window as any).__readingAnchor = held;
  return held.getBoundingClientRect().top;
});
const readingAnchorTop = (page: Page) => page.evaluate(() => ((window as any).__readingAnchor as HTMLElement).getBoundingClientRect().top);

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

/** The open mirror thread's agent streams `text`, as the host's events do. */
const streamText = (page: Page, text: string) => page.evaluate(chunk => (window as any).__previewEmit('agent-event', { sessionId: 'mirror-long', kind: 'text', text: chunk }), text);
const streamParagraph = (n: number) => `\n\nStreamed paragraph ${n}. The agent keeps writing while the reader looks back; every line wraps a few times over to grow the live reply quickly.`;
/** Two animation frames: a scroll event and a ResizeObserver pass have both run. */
const twoFrames = (page: Page) => page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));

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

    test('tiny positive wheel jitter after an upward swipe never snaps back to the bottom', async ({ page }) => {
      const errors = await openThread(page);
      // A live turn is under way (its first chunk sizes the composer's working state), and the thread follows it.
      await streamText(page, streamParagraph(0));
      await expect(page.locator('#stream-region .live-text')).toContainText('Streamed paragraph 0.');
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      const last = promptOf(page, TURNS - 1);
      // A real upward swipe, then the trackpad settling: a couple of tiny positive deltas straight after it.
      const area = await plainPoint(page);
      const before = await topOf(last);
      await page.mouse.move(area.x, area.y);
      await page.mouse.wheel(0, -40);
      await page.mouse.wheel(0, 1);
      await page.mouse.wheel(0, 2);
      await scrollSettled(page);
      // The thread moved with the swipe (40 up, at most the 3px of jitter back), not back to where it was. The gap alone
      // can read 0 here: scrolling up gives back the blank room the live card left under it, the part below the window.
      expect(await topOf(last) - before).toBeGreaterThan(30);
      const held = await topOf(last);
      // More of the reply streams in, and the bottom grows: the reader stays where the swipe left them.
      for (let n = 1; n < 4; n++) { await streamText(page, streamParagraph(n)); await twoFrames(page); }
      await expect(page.locator('#stream-region .live-text')).toContainText('Streamed paragraph 3.');
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(last) - held)).toBeLessThanOrEqual(1);
      expect(await gap(page)).toBeGreaterThan(200);

      // The tight case: the swipe left the reader within the restick gap of the end, and the settling deltas arrive
      // there (an elastic bounce reports no movement). Before the fix the first +1 re-pinned the follow.
      await latest(page).click();
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>('#transcript')!;
        transcript.dispatchEvent(new WheelEvent('wheel', { deltaY: -2, bubbles: true }));
        transcript.scrollTop -= 2;
      });
      await twoFrames(page);
      await page.evaluate(() => {
        const transcript = document.querySelector<HTMLElement>('#transcript')!;
        for (const deltaY of [1, 2]) transcript.dispatchEvent(new WheelEvent('wheel', { deltaY, bubbles: true }));
      });
      // WebKit scrolls by a dispatched wheel's delta (here back down to the old end, as a trackpad's settling does);
      // Chromium does not. Either way the follow must not come back: measured once that scroll has landed.
      await twoFrames(page);
      const nudged = await topOf(last);
      await growThread(page);
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(last) - nudged)).toBeLessThanOrEqual(1);
      expect(await gap(page)).toBeGreaterThan(200);
      expect(errors).toEqual([]);
    });

    test('an upward scroll during a live stream releases cleanly and stays released as more text arrives', async ({ page }) => {
      const errors = await openThread(page);
      await scrollSettled(page);
      // The agent starts writing: a follower stays pinned to the growing live reply.
      for (let n = 0; n < 4; n++) await streamText(page, streamParagraph(n));
      const live = page.locator('#stream-region .live-text');
      await expect(live).toContainText('Streamed paragraph 3.');
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      const streamHeight = () => page.locator('#stream-region').evaluate(node => node.getBoundingClientRect().height);
      const startHeight = await streamHeight();

      // The reader scrolls up while text keeps arriving, the first chunk inside the same gesture.
      await wheelAt(page, await plainPoint(page), -300);
      await streamText(page, streamParagraph(4));
      await scrollSettled(page);
      expect(await gap(page)).toBeGreaterThan(200);
      const last = promptOf(page, TURNS - 1);
      const held = await topOf(last), heldTop = await scrollTop(page);
      for (let n = 5; n < 15; n++) {
        await streamText(page, streamParagraph(n));
        await twoFrames(page);
        expect(Math.abs(await topOf(last) - held)).toBeLessThanOrEqual(1);
      }
      await expect(live).toContainText('Streamed paragraph 14.');
      await page.waitForTimeout(300);
      // The live reply grew under the reader, who did not move.
      expect(await streamHeight()).toBeGreaterThan(startHeight + 100);
      expect(Math.abs(await topOf(last) - held)).toBeLessThanOrEqual(1);
      expect(Math.abs(await scrollTop(page) - heldTop)).toBeLessThanOrEqual(1);
      expect(await gap(page)).toBeGreaterThan(300);
      await expect(latest(page)).toBeVisible();

      // A scripted scroll up (a scrollbar drag or keys) mid-stream lets go the same way.
      await latest(page).click();
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      await scrollSettled(page);
      await transcriptOf(page).evaluate(node => { node.scrollTop -= 400; });
      await twoFrames(page);
      const scripted = await topOf(last);
      for (let n = 15; n < 20; n++) { await streamText(page, streamParagraph(n)); await twoFrames(page); }
      await expect(live).toContainText('Streamed paragraph 19.');
      await page.waitForTimeout(300);
      expect(Math.abs(await topOf(last) - scripted)).toBeLessThanOrEqual(1);
      expect(await gap(page)).toBeGreaterThan(400);
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

    test('the rail is bare (transparent, square, no shadow) while the hover preview is a visible card', async ({ page }) => {
      const errors = await openThread(page);
      const railStyle = () => rail(page).evaluate(node => {
        const style = getComputedStyle(node);
        return { background: style.backgroundColor, image: style.backgroundImage, radius: style.borderRadius, shadow: style.boxShadow, border: style.borderTopWidth };
      });
      expect(await railStyle()).toEqual({ background: 'rgba(0, 0, 0, 0)', image: 'none', radius: '0px', shadow: 'none', border: '0px' });
      // Away from the bottom (the chevron shown) and with a tick hovered it stays bare.
      await wheelOverTranscript(page, -900);
      await scrollSettled(page);
      await expect(latest(page)).toBeVisible();
      await ticks(page).nth(4).hover();
      await expect(preview(page)).toBeVisible();
      expect(await railStyle()).toEqual({ background: 'rgba(0, 0, 0, 0)', image: 'none', radius: '0px', shadow: 'none', border: '0px' });

      // The preview bubble keeps its glass: an opaque-enough fill, a hairline edge, rounded corners and a real size.
      const card = await preview(page).evaluate(node => {
        const style = getComputedStyle(node), box = node.getBoundingClientRect();
        const alpha = (color: string) => { const parts = color.match(/[\d.]+/g)?.map(Number) ?? []; return color.startsWith('rgba') || color.includes('/') ? parts[3] ?? 1 : parts.length ? 1 : 0; };
        return { fillAlpha: alpha(style.backgroundColor), shadow: style.boxShadow, radius: parseFloat(style.borderTopLeftRadius), width: box.width, height: box.height };
      });
      expect(card.fillAlpha).toBeGreaterThan(0.3);
      expect(card.shadow).not.toBe('none');
      expect(card.radius).toBeGreaterThan(0);
      expect(card.width).toBeGreaterThan(60);
      expect(card.height).toBeGreaterThan(20);
      await expect.poll(() => preview(page).evaluate(node => Number(getComputedStyle(node).opacity))).toBe(1);
      await expect(preview(page).locator('.thread-scroll-preview-text')).toHaveText('Prompt 04: explain part 04');
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

  test.describe('older turns with clamped replies', () => {
    test('holdPlace and captureTranscriptAnchor measure the final layout, whatever CSS.supports says of overflow-anchor', async ({ page }) => {
      await page.goto('/');
      const result = await page.evaluate(async () => {
        const { holdPlace } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-window.ts`);
        const { captureTranscriptAnchor } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-scroll.ts`);
        // WebKit 26 answers true here yet does not anchor the transcript: the scroller below never anchors either.
        const claims = CSS.supports('overflow-anchor', 'auto');
        const make = () => {
          const scroller = document.body.appendChild(document.createElement('div'));
          scroller.style.cssText = 'position:fixed;inset:0;overflow:auto;overflow-anchor:none;background:white;z-index:9999';
          scroller.innerHTML = Array.from({ length: 200 }, (_, index) => `<article data-message-id="${index}" style="height:100px">${index}</article>`).join('');
          scroller.scrollTop = 10_000;
          return scroller;
        };
        const land = (scroller: HTMLElement) => {
          // An older turn lands above with an unclamped reply (5000px) that clamps (to 300px) before the restore.
          const added = document.createElement('article');
          added.style.height = '5000px';
          scroller.prepend(added);
          added.style.height = '300px';
        };
        const top = (scroller: HTMLElement) => scroller.querySelector('[data-message-id="100"]')!.getBoundingClientRect().top;
        const held = make(), before = top(held), restore = holdPlace(held);
        land(held);
        restore();
        const pending = make(), pendingBefore = top(pending), restorePending = holdPlace(pending);
        // The clamp still to come is counted, never dropped as if the engine would make up for it.
        const late = document.createElement('article');
        late.style.height = '5000px';
        pending.prepend(late);
        restorePending(-4700);
        late.style.height = '300px';
        const pendingMoved = top(pending) - pendingBefore;
        const anchored = make(), anchoredBefore = top(anchored), restoreAnchor = captureTranscriptAnchor(anchored);
        land(anchored);
        restoreAnchor();
        const result = { claims, held: top(held) - before, pending: pendingMoved, anchored: top(anchored) - anchoredBefore };
        [held, pending, anchored].forEach(node => node.remove());
        return result;
      });
      expect(Math.abs(result.held)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.pending)).toBeLessThanOrEqual(1);
      expect(Math.abs(result.anchored)).toBeLessThanOrEqual(1);
    });

    test('prepending older clamped turns and an older page never snaps the reader back to the bottom', async ({ page }) => {
      test.setTimeout(120_000);
      const errors = watchErrors(page);
      await page.addInitScript(() => localStorage.setItem('pandacode.wallpapers', 'false'));
      await exposePreviewMessages(page);
      await seedMirror(page);
      await setThread(page, 'mirror-long', clampedThreadOf(CLAMPED_TURNS));
      await mirrorRow(page).click();
      await expect(promptOf(page, CLAMPED_TURNS - 1)).toBeVisible();
      await settled(page);
      await expect.poll(() => gap(page)).toBeLessThanOrEqual(2);
      // The first page cuts turn 10 and the oldest turns are not loaded at all: an older page has to be fetched and joined.
      await expect(promptOf(page, 0)).toHaveCount(0);
      await probePrepends(page);

      let reachedTop = false, lastGap = 0;
      for (let gesture = 0; gesture < 60 && !reachedTop; gesture++) {
        await wheelAt(page, await plainPoint(page), -1400);
        await scrollSettled(page);
        // Whatever lands now (a step held back for the gesture, an older page, a lazy reply formatting near the reader)
        // must leave what is on the reading line where it is.
        const before = await readingAnchor(page);
        await settled(page);
        await page.waitForTimeout(250);
        await settled(page);
        const after = await readingAnchorTop(page);
        expect(Math.abs(after - before), `gesture ${gesture}: the reading line moved by ${after - before}px`).toBeLessThanOrEqual(4);
        // Never back toward the bottom: every gesture leaves more of the thread below the reader than the last one did.
        const below = await gap(page);
        expect(below, `gesture ${gesture}: the reader went back toward the bottom`).toBeGreaterThan(Math.max(1000, lastGap - 4));
        lastGap = below;
        reachedTop = await promptOf(page, 0).count() > 0 && await scrollTop(page) <= 2;
      }
      expect(reachedTop).toBe(true);
      const probe = await page.evaluate(() => (window as any).__prependProbe as { shifts: number[]; joins: number[]; maxReply: number; lazyPaints: number; unclamped: number });
      // Several steps up landed, each keeping the reader within a few pixels; the fetched page joined the cut turn.
      expect(probe.shifts.length).toBeGreaterThanOrEqual(2);
      for (const shift of probe.shifts) expect(Math.abs(shift)).toBeLessThanOrEqual(4);
      expect(probe.joins.length).toBeGreaterThanOrEqual(1);
      for (const shift of probe.joins) expect(Math.abs(shift)).toBeLessThanOrEqual(4);
      await expect(transcriptOf(page).locator('.user-message').filter({ hasText: 'Prompt 10:' })).toHaveCount(1);
      // Every lazy reply formatted and clamped under Read more; its text never sat in the document unclamped (the saved
      // markup already holds it escaped, clamped as it draws, so this guards the lazy paint rather than reproduce a spike).
      for (const turn of LAZY_TURNS) {
        const reply = transcriptOf(page).locator('.turn-card-reply').filter({ hasText: `Lazy ${label(turn)} paragraph 0.` });
        await expect(reply).toHaveCount(1);
        await expect(reply).toHaveAttribute('data-overflow', '');
        await expect(reply.locator('p').first()).toBeAttached();
      }
      const clamped = await transcriptOf(page).locator('.turn-card-reply[data-overflow]:not([data-open])').evaluateAll(replies => Math.max(...replies.map(reply => (reply as HTMLElement).offsetHeight)));
      expect(probe.maxReply).toBeLessThanOrEqual(clamped + 40);
      expect(probe.lazyPaints).toBeGreaterThanOrEqual(1);
      expect(probe.unclamped).toBe(0);
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
