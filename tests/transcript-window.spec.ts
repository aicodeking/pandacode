import { expect, test, type Page } from '@playwright/test';
import { accountSwitch, agentTurns, announceMirror, exposePreviewMessages, pairs, say, scrollTopUntil, setThread, settled, toolTurns } from './transcript-fixtures';

/* A long thread draws only its newest turns (src/transcript-rows.ts). The mirror thread's page holds messages
 * 300–399 as 50 two-message turns, so the 40-message window opens at message 360. */

const OLDEST_DRAWN = 360, OLDEST_LOADED = 300;
const transcriptOf = (page: Page) => page.locator('#transcript');
const message = (page: Page, n: number) => transcriptOf(page).getByText(`Message ${String(n).padStart(3, '0')}`, { exact: true });

/** Fails the test on anything thrown, in a handler or a promise. */
function watchErrors(page: Page): string[] {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  return errors;
}

async function seed(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => (window as any).__previewMirrorThread(400, 400));
}
const row = (page: Page) => page.locator('#navigation .task-item').filter({ hasText: 'Long remote thread' });

async function openLong(page: Page): Promise<void> {
  await seed(page);
  await row(page).click();
  await expect(message(page, 399)).toBeVisible();
  await expect(message(page, OLDEST_DRAWN)).toHaveCount(1);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);
}

/** The mirror thread holding `list` instead, opened. */
async function openThread(page: Page, list: Parameters<typeof setThread>[2]): Promise<void> {
  await exposePreviewMessages(page);
  await seed(page);
  await setThread(page, 'mirror-long', list);
  await row(page).click();
}

const scrollUntilDrawn = (page: Page, n: number): Promise<void> => scrollTopUntil(page, '#transcript', `Message ${String(n).padStart(3, '0')}`);

const drawnNumbers = (page: Page) => transcriptOf(page).evaluate(node => [...new Set((node.textContent ?? '').match(/Message \d{3}/g) ?? [])].map(text => Number(text.slice(8))));

test.describe('transcript window', () => {
test('scrolling up draws older turns above the window, in order, and holds the reader', async ({ page }) => {
  const errors = watchErrors(page);
  await openLong(page);
  await settled(page);
  // Measured in the task that scrolls, so nothing can draw between the scroll and the baseline.
  const before = await transcriptOf(page).evaluate((node, text) => {
    node.scrollTop = 200;
    return [...node.querySelectorAll('.user-prose')].find(item => item.textContent === text)!.getBoundingClientRect().top;
  }, `Message ${OLDEST_DRAWN + 10}`);
  // One step: 40 more messages of the 60 left, never the whole page.
  await expect(message(page, OLDEST_DRAWN - 40)).toHaveCount(1);
  await expect(message(page, OLDEST_DRAWN - 41)).toHaveCount(0);
  expect(Math.abs((await message(page, OLDEST_DRAWN + 10).boundingBox())!.y - before)).toBeLessThanOrEqual(1);
  const shown = await drawnNumbers(page);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => shown[0] + index));
  expect(shown.at(-1)).toBe(399);
  expect(errors).toEqual([]);
});

test('scrolling past the loaded page fetches older messages and keeps them in order', async ({ page }) => {
  const errors = watchErrors(page);
  await openLong(page);
  await scrollUntilDrawn(page, OLDEST_LOADED - 1);
  await scrollUntilDrawn(page, OLDEST_LOADED - 60);
  const shown = await drawnNumbers(page);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => shown[0] + index));
  expect(errors).toEqual([]);
});

test('find reaches a match in a turn not drawn yet', async ({ page }) => {
  const errors = watchErrors(page);
  await openLong(page);
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Message 310');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(message(page, 310)).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a shared channel round trip leaves scrolling and find working', async ({ page }) => {
  const errors = watchErrors(page);
  await openLong(page);
  await page.locator('.sidebar-bots-bar').click();
  await page.getByRole('button', { name: 'Add bot or channel' }).click();
  await page.getByRole('menu', { name: 'Create' }).getByRole('menuitem', { name: 'New channel' }).click();
  const create = page.getByRole('dialog', { name: 'New channel' });
  await create.getByRole('textbox', { name: 'Channel name' }).fill('notes');
  await create.getByRole('button', { name: 'Create channel' }).click();
  await expect(page.locator('.conversation-pane.channel-thread .bc-channel')).toBeVisible();

  // The channel replaced the rows while the thread stayed selected: neither may reach for them.
  await transcriptOf(page).evaluate(node => { node.dispatchEvent(new Event('scroll')); node.dispatchEvent(new WheelEvent('wheel', { deltaY: -10 })); });
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  await find.fill('Message');
  await find.press('Escape');
  await page.waitForTimeout(100);
  expect(errors).toEqual([]);

  await page.getByRole('button', { name: 'Back to conversation' }).click();
  await expect(message(page, 399)).toHaveCount(1);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);
  await scrollUntilDrawn(page, OLDEST_DRAWN - 1);
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Message 310');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  expect(errors).toEqual([]);
});

test('the first open of a running long thread draws only the window', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page);
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'mirror-long', kind: 'text', text: 'Still working on it.' }));
  await row(page).click();
  await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(1);
  // The run's own reply (399) is the live card's; its prompt is the newest saved row.
  await expect(message(page, 398)).toHaveCount(1);
  await expect(message(page, OLDEST_DRAWN)).toHaveCount(1);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);
  expect(errors).toEqual([]);
});

test('find formats older turns before searching them, and an empty bar draws nothing', async ({ page }) => {
  const errors = watchErrors(page);
  await openThread(page, Array.from({ length: 50 }, (_, turn) => [say(turn * 2, 'user', `Question ${turn}`), say(turn * 2 + 1, 'assistant', `The **needle${turn}** answer`)]).flat());
  await expect(transcriptOf(page).locator('strong', { hasText: /^needle49$/ })).toHaveCount(1, { timeout: 20_000 });
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  await expect(find).toBeFocused();
  await page.waitForTimeout(150);
  await expect(transcriptOf(page).getByText('Question 5', { exact: true })).toHaveCount(0);
  // Spans the bold, so it only matches formatted text (raw reads `**needle5** answer`).
  await find.fill('needle5 answer');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(transcriptOf(page).locator('strong', { hasText: /^needle5$/ })).toBeInViewport();
  expect(errors).toEqual([]);
});

test('a Find bar left open draws nothing in a thread it merely arrives at', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page);
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Message');
  await row(page).click();
  await expect(message(page, 399)).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);

  // The reader's query draws this thread; leaving and coming back, with the bar still open, does not draw it again.
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Message 3');
  // Only down to the newest match above the window; the count still includes the ones not drawn.
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(1);
  await expect(page.locator('.thread-find-count')).toHaveText(/ of 100$/);
  await expect(message(page, OLDEST_LOADED)).toHaveCount(0);
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(message(page, 399)).toHaveCount(0);
  await row(page).click();
  await expect(message(page, 399)).toHaveCount(1);
  await page.waitForTimeout(300);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);
  expect(errors).toEqual([]);
});

// A last turn with an account note, then a message joining it: the row redraws and the note's old node goes back in.
const noted = () => [...pairs(46), accountSwitch(92, 'Moved to the backup account')];
async function joinLastTurn(page: Page, n: number): Promise<void> {
  await page.evaluate(extra => (window as any).__previewMessages['mirror-long'].push(extra), say(n, 'assistant', `Message 0${n}`));
  await announceMirror(page, 'mirror-long');
  await expect(message(page, n)).toHaveCount(1);
  await expect(transcriptOf(page).locator('details.account-switch-note')).toHaveCount(1);
}

test('a kept account note leaves scrolling up working and the widened window in place', async ({ page }) => {
  const errors = watchErrors(page);
  await openThread(page, noted());
  await expect(message(page, 91)).toHaveCount(1);
  await expect(message(page, 51)).toHaveCount(0);
  await joinLastTurn(page, 93);
  // The redraw left the rows listed, so the window still widens and a later redraw keeps it.
  await scrollUntilDrawn(page, 40);
  const widest = (await drawnNumbers(page))[0];
  await joinLastTurn(page, 94);
  expect((await drawnNumbers(page))[0]).toBe(widest);
  expect(errors).toEqual([]);
});

test('a kept account note leaves find working', async ({ page }) => {
  const errors = watchErrors(page);
  await openThread(page, noted());
  await expect(message(page, 91)).toHaveCount(1);
  await joinLastTurn(page, 93);
  await expect(message(page, 51)).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Message 002');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  expect(errors).toEqual([]);
});

test('a page of long agent turns keeps drawing until the window can scroll', async ({ page }) => {
  const errors = watchErrors(page);
  // Thirteen messages a turn fold to one short card, so the budget's three turns cannot fill the window.
  await openThread(page, Array.from({ length: 8 }, (_, turn) => [say(turn * 13, 'user', `Question ${turn}`), ...Array.from({ length: 12 }, (_, step) => say(turn * 13 + 1 + step, 'assistant', `Step ${turn}.${step}`))]).flat());
  await expect(transcriptOf(page).getByText('Question 7', { exact: true })).toHaveCount(1);
  await expect.poll(() => transcriptOf(page).evaluate(node => node.scrollHeight - node.clientHeight)).toBeGreaterThan(0);
  await expect(transcriptOf(page).getByText('Question 4', { exact: true })).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a first page of a few huge folded cards fetches older pages until the window can scroll', async ({ page }) => {
  const errors = watchErrors(page);
  // Fifty messages a turn (a prompt and 49 tools) fold to one short card: the first page of 100 is two cards.
  const tool = (n: number) => JSON.stringify({ type: 'tool_activity', version: 1, id: `f${n}`, name: 'Read', status: 'completed', input: `src/f-${n}.ts`, output: 'x' });
  const list = Array.from({ length: 12 }, (_, turn) => [say(turn * 50, 'user', `Ask ${String(turn).padStart(2, '0')}`), ...Array.from({ length: 49 }, (_, step) => say(turn * 50 + 1 + step, 'tool', tool(turn * 50 + 1 + step)))]).flat();
  await openThread(page, list);
  await expect(transcriptOf(page).getByText('Ask 11', { exact: true })).toHaveCount(1);
  await expect.poll(() => transcriptOf(page).evaluate(node => node.scrollHeight - node.clientHeight), { timeout: 15_000 }).toBeGreaterThan(0);
  // Turns from a fetched page are drawn, in order.
  await expect(transcriptOf(page).getByText('Ask 09', { exact: true })).toHaveCount(1);
  const asks = await transcriptOf(page).evaluate(node => [...(node.textContent ?? '').matchAll(/Ask (\d\d)/g)].map(match => Number(match[1])));
  expect(asks).toEqual([...asks].sort((a, b) => a - b));
  expect(errors).toEqual([]);
});

test('find counts turns not drawn yet as it finds them once drawn: punctuation, blocks and entities', async ({ page }) => {
  const errors = watchErrors(page);
  // Forty turns, all in the first page; the special replies sit in the oldest, which the window does not draw.
  const replies: Record<number, string> = { 1: 'Use C# here.', 2: 'Set `a_b` now.', 3: '# Title\n\nPara text', 0: 'Tom &amp; Jerry, cicada cocoa' };
  const list = Array.from({ length: 40 }, (_, turn) => [say(turn * 2, 'user', `Question ${turn}`), say(turn * 2 + 1, 'assistant', replies[turn] ?? `Cicada cocoa cache ${turn}`)]).flat();
  await openThread(page, list);
  await expect(transcriptOf(page).getByText('Question 39', { exact: true })).toHaveCount(1);
  await expect(transcriptOf(page).getByText('Question 1', { exact: true })).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' }), count = page.locator('.thread-find-count');
  // Newest first, so each is counted in memory before its turn draws.
  // A heading and the paragraph after it are two blocks: no match spans them, drawn or not.
  await find.fill('title para');
  await expect(count).toHaveText('No results');
  await find.press('Enter');
  await page.waitForTimeout(300);
  await expect(count).toHaveText('No results');
  await expect(transcriptOf(page).getByText('Question 3', { exact: true })).toHaveCount(0);
  // Markdown punctuation in the query is compared as written (C# is not every c, a_b not ab).
  for (const [query, turn] of [['para text', 3], ['a_b', 2], ['C#', 1]] as const) {
    await find.fill(query);
    await find.fill(query);
    await expect(count, query).toHaveText('1 of 1');
    await expect(transcriptOf(page).getByText(`Question ${turn}`, { exact: true })).toHaveCount(1);
  }
  // An entity reads as the page draws it: the count for the oldest turn, not drawn yet, is the one it has once drawn.
  await find.fill('tom & jerry');
  // Counted by the formatted text once every reply is formatted (by the search, formatForFind, or a step drawing it):
  // wait for that, not for a time, then search afresh, since the bar counts when it searches.
  const sources = list.filter(item => item.role === 'assistant').map(item => item.content);
  await expect.poll(() => page.evaluate(async all => {
    const { markdownCache } = await import(/* @vite-ignore */ `${location.origin}/src/dom.ts`);
    return all.every(source => markdownCache.get(source) !== undefined);
  }, sources)).toBe(true);
  await find.fill('');
  await expect(count).toHaveText('');
  await find.fill('tom & jerry');
  await expect(count).not.toHaveText('');
  const counted = await count.textContent();
  await scrollTopUntil(page, '#transcript', 'Question 0');
  await find.fill('');
  await find.fill('tom & jerry');
  await expect(count).toHaveText(counted!);
  expect(errors).toEqual([]);
});

test('coming back to the bottom gives widened turns back without moving the reader', async ({ page }) => {
  const errors = watchErrors(page);
  await openLong(page);
  await scrollUntilDrawn(page, OLDEST_LOADED);
  const widened = (await drawnNumbers(page)).length;
  await transcriptOf(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect.poll(async () => (await drawnNumbers(page)).length, { timeout: 5000 }).toBeLessThan(widened);
  expect(await transcriptOf(page).evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
  await expect(message(page, 399)).toBeInViewport();
  // It stays narrow on its own, and the turns come back as any older ones do.
  const narrowed = (await drawnNumbers(page))[0];
  await page.waitForTimeout(800);
  expect((await drawnNumbers(page))[0]).toBe(narrowed);
  await scrollUntilDrawn(page, narrowed - 1);
  const shown = await drawnNumbers(page);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => shown[0] + index));
  expect(errors).toEqual([]);
});

test('a fetched page that joins the oldest drawn turn redraws only that turn', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page);
  await seed(page);
  // 150 messages: the first page cuts a turn, so the older page's last messages join the oldest drawn one.
  await setThread(page, 'mirror-long', [...pairs(25), say(50, 'user', 'Message 050'), ...Array.from({ length: 99 }, (_, step) => say(51 + step, step % 3 === 2 ? 'user' : 'assistant', `Message ${String(51 + step).padStart(3, '0')}`))]);
  await row(page).click();
  await expect(message(page, 149)).toHaveCount(1);
  await scrollUntilDrawn(page, 50);
  const kept = await transcriptOf(page).evaluate(node => { const last = node.querySelector('article.message:last-of-type')!; (window as any).__kept = last; return last.textContent; });
  expect(kept).toBeTruthy();
  await scrollUntilDrawn(page, 49);
  await scrollUntilDrawn(page, 0);
  expect(await transcriptOf(page).evaluate(node => node.contains((window as any).__kept))).toBe(true);
  const shown = await drawnNumbers(page);
  expect(shown).toEqual(Array.from({ length: 150 }, (_, index) => index));
  expect(errors).toEqual([]);
});

const text = (page: Page, value: string) => transcriptOf(page).getByText(value, { exact: true });
const CARD_LIMIT = 10;
/** Records the card count after every change to the transcript's rows, from before the thread opens. */
const sampleCards = (page: Page) => page.evaluate(() => {
  const w = window as any, host = document.querySelector('#transcript')!;
  w.__cardCounts = [];
  w.__cardSampler?.disconnect();
  w.__cardSampler = new MutationObserver(() => w.__cardCounts.push(host.querySelectorAll('.turn-card').length));
  w.__cardSampler.observe(host, { childList: true });
});
const cardSamples = (page: Page) => page.evaluate(() => (window as any).__cardCounts as number[]);

test('opening a long thread draws its window and never widens while pinned', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page);
  await seed(page);
  // A page of 16 turns, and a window short enough that the pin sits inside ROWS_MARGIN of the top.
  await setThread(page, 'mirror-long', agentTurns(16));
  await sampleCards(page);
  await row(page).click();
  await expect(text(page, 'Result 015')).toHaveCount(1);
  const opened = await transcriptOf(page).locator('.turn-card').count();
  expect(opened).toBeLessThanOrEqual(CARD_LIMIT);
  // Past the trim's settle, so a draw-then-trim would have shown in the samples.
  await page.waitForTimeout(900);
  const top = await transcriptOf(page).evaluate(node => node.scrollTop);
  expect(top, 'the pin is within reach of the top').toBeLessThan(1600);
  expect(await transcriptOf(page).evaluate(node => node.scrollHeight - node.scrollTop - node.clientHeight)).toBeLessThanOrEqual(2);
  const settled = await transcriptOf(page).locator('.turn-card').count();
  expect(settled).toBe(opened);
  expect(Math.max(...await cardSamples(page))).toBeLessThanOrEqual(settled);

  // Coming back to the remembered page is the same draw.
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(text(page, 'Result 015')).toHaveCount(0);
  await sampleCards(page);
  await row(page).click();
  await expect(text(page, 'Result 015')).toHaveCount(1);
  await page.waitForTimeout(900);
  expect(await transcriptOf(page).locator('.turn-card').count()).toBe(settled);
  expect(Math.max(...await cardSamples(page))).toBeLessThanOrEqual(settled);
  expect(errors).toEqual([]);
});

test('a trim keeps the folds the reader opened, for when the turns come back', async ({ page }) => {
  const errors = watchErrors(page);
  const note = accountSwitch(14, 'Moved to the backup account');
  const list = toolTurns(25);
  // In turn 1, after its reply.
  await openThread(page, [...list.slice(0, 8), note, ...list.slice(8)]);
  await expect(text(page, 'Result 024')).toHaveCount(1);
  await scrollTopUntil(page, '#transcript', 'Prompt 001');

  const card = transcriptOf(page).locator('.turn-card').filter({ hasText: 'Result 001' });
  await card.locator('.turn-activity-summary').click();
  await card.locator('details.tool-trace > summary').first().click();
  await expect(card.locator('details.tool-trace').first().locator('.tool-activity-body')).toContainText('contents');
  await transcriptOf(page).locator('details.account-switch-note > summary').click();
  await page.evaluate(() => (document.activeElement as HTMLElement | null)?.blur());

  await transcriptOf(page).evaluate(node => { node.scrollTop = node.scrollHeight; });
  await expect(text(page, 'Prompt 001')).toHaveCount(0, { timeout: 5000 });
  await expect(transcriptOf(page).locator('details.account-switch-note')).toHaveCount(0);

  await scrollTopUntil(page, '#transcript', 'Prompt 001');
  await expect(card.locator('details.turn-activity')).toHaveAttribute('open', '');
  await expect(card.locator('details.tool-trace').first()).toHaveAttribute('open', '');
  await expect(card.locator('details.tool-trace').first().locator('.tool-activity-body')).toContainText('contents');
  await expect(transcriptOf(page).locator('details.account-switch-note')).toHaveAttribute('open', '');
  await expect(card.locator('details.tool-trace').nth(1)).not.toHaveAttribute('open', '');
  expect(errors).toEqual([]);
});

test('a fetched page joining the only drawn turn keeps its workers and threads card', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page);
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.waitForFunction(() => typeof (window as any).__orchestrationEnable === 'function' && typeof (window as any).__machineChild === 'function');
  const launch = await page.evaluate(() => {
    const w = window as any;
    w.__orchestrationEnable(true);
    w.__previewMirrorTeam();
    w.__machineChild('mirror-team', { title: 'Side thread', status: 'idle', machine: { id: 'dev-mini', name: 'ProMini' }, launch: true });
    return w.__previewMessages['mirror-team'].at(-1);
  });
  const SESSION = 'mirror-team', at = 1_700_000_000_000, later = Date.now() + 3_600_000;
  const label = (n: number) => `Message ${String(n).padStart(3, '0')}`;
  // One turn of 50 messages holding the launch, cut by the first page at message 20; the workers belong to it.
  const first = Array.from({ length: 50 }, (_, n) => n === 45 ? { ...launch, id: 100_045, createdAt: at } : say(n, n ? 'assistant' : 'user', label(n), SESSION, at));
  const rest = Array.from({ length: 35 }, (_, turn) => [say(50 + turn * 2, 'user', label(50 + turn * 2), SESSION, later + turn * 2000), say(51 + turn * 2, 'assistant', label(51 + turn * 2), SESSION, later + turn * 2000 + 1000)]).flat();
  await setThread(page, SESSION, [...first, ...rest]);
  await page.locator('#navigation .task-item').filter({ hasText: 'Remote team task' }).click();
  await expect(message(page, 119)).toHaveCount(1);
  await scrollUntilDrawn(page, 0);
  await expect(transcriptOf(page).locator('.machine-threads')).toHaveCount(1);
  await expect(transcriptOf(page).locator('.team-progress-slot:not([hidden]) .team-progress')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a folded tool draws its body only when opened, and find still opens the fold around a match', async ({ page }) => {
  const errors = watchErrors(page);
  await openThread(page, agentTurns(16));
  await expect(text(page, 'Result 015')).toHaveCount(1);
  const card = transcriptOf(page).locator('.turn-card').filter({ hasText: 'Result 015' });
  await expect(card.locator('[data-tool-body]')).toHaveCount(3);
  await expect(card.locator('.tool-activity-body pre')).toHaveCount(0);

  // Narration inside a closed fold is still there to be found.
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('searchbox', { name: 'Find in thread' }).fill('Looking at part 015');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(card.locator('details.turn-activity')).toHaveAttribute('open', '');
  await page.getByRole('searchbox', { name: 'Find in thread' }).press('Escape');

  await card.locator('.tool-group-summary').first().click();
  await card.locator('details.tool-trace > summary').first().click();
  await expect(card.locator('details.tool-trace').first().locator('.tool-activity-body')).toContainText('contents');
  await expect(card.locator('[data-tool-body]')).toHaveCount(2);
  expect(errors).toEqual([]);
});

test('find reaches text inside a closed tool in a turn not drawn yet, and steps back to matches above the window', async ({ page }) => {
  const errors = watchErrors(page);
  // Sixteen turns: all in the first page (Find searches what is loaded), about six drawn.
  const list = agentTurns(16);
  list[2 * 6 + 3] = say(2 * 6 + 3, 'tool', JSON.stringify({ type: 'tool_activity', version: 1, id: 'needle', name: 'Read', status: 'completed', input: 'src/deep.ts', output: 'the hidden needle line' }));
  await openThread(page, list);
  await expect(text(page, 'Result 015')).toHaveCount(1);
  await expect(text(page, 'Result 002')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  await find.fill('hidden needle');
  await expect(page.locator('.thread-find')).toHaveAttribute('data-counted', 'hidden needle');
  // The tool's body shows the line twice (its file preview and the raw record): counted in memory as it draws, so the
  // count reads the same before the turn is drawn and after.
  await expect(page.locator('.thread-find-count')).toHaveText('2 of 2');
  await expect(transcriptOf(page).locator('.tool-activity-body', { hasText: 'the hidden needle line' })).toBeInViewport();
  await expect(page.locator('.thread-find-count')).toHaveText('2 of 2');
  await expect(text(page, 'Result 002')).toHaveCount(1);

  // Stepping back past the oldest drawn match draws down to the next one above it (the reader nearing the top may
  // already have drawn it), and the count holds every match, drawn or not.
  await find.fill('Result 0');
  await expect(page.locator('.thread-find')).toHaveAttribute('data-counted', 'Result 0');
  await expect(page.locator('.thread-find-count')).toHaveText(/ of 16$/);
  const label = (await page.locator('.thread-find-count').textContent())!;
  for (let at = Number(label.split(' ')[0]); at > 2; at--) await find.press('Shift+Enter');
  await expect(page.locator('.thread-find-count')).toHaveText('2 of 16');
  await find.press('Shift+Enter');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 16');
  await expect(text(page, 'Result 000')).toBeInViewport();
  expect(errors).toEqual([]);
});

test('find formats a long folded reply drawn far from the reader before searching it', async ({ page }) => {
  const errors = watchErrors(page);
  const tall = (turn: number) => `Question ${turn}\n\n${Array.from({ length: 30 }, (_, line) => `line ${line}`).join('\n\n')}`;
  const long = `The **zebra** crossing, see [the docs](https://example.com). ${'Filler words here. '.repeat(600)}`;
  await openThread(page, [say(0, 'user', 'Start'), say(1, 'assistant', long), ...Array.from({ length: 14 }, (_, turn) => [say(2 + turn * 2, 'user', tall(turn)), say(3 + turn * 2, 'assistant', `Reply ${turn}`)]).flat()]);
  await expect(text(page, 'Reply 13')).toBeVisible();
  // Drawn, but far above the reader: left to format as it nears them, it still shows its Markdown source.
  const reply = transcriptOf(page).locator('.turn-card-reply .markdown').filter({ hasText: 'zebra' });
  await expect(reply).toContainText('**zebra**');
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  // Spans the bold, so it matches only once the reply is formatted.
  await find.fill('zebra crossing');
  await expect(page.locator('.thread-find')).toHaveAttribute('data-counted', 'zebra crossing');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(reply.locator('strong', { hasText: /^zebra$/ })).toHaveCount(1);
  await find.fill('](');
  await expect(page.locator('.thread-find-count')).toHaveText('No results');
  expect(errors).toEqual([]);
});

test('find counts only what the page draws: an attached file and a tool name draw no turns and find nothing', async ({ page }) => {
  const errors = watchErrors(page);
  const list = agentTurns(16);
  list[2 * 6] = say(2 * 6, 'user', 'Prompt 002\n\nFile context: src/notes.txt\n```\nthe zebracorn line\n```');
  list[2 * 6 + 3] = say(2 * 6 + 3, 'tool', JSON.stringify({ type: 'tool_activity', version: 1, id: 'named', name: 'Frobnicator', status: 'completed', input: 'src/a.ts', output: '' }));
  await openThread(page, list);
  await expect(text(page, 'Result 015')).toHaveCount(1);
  await expect(text(page, 'Result 002')).toHaveCount(0);
  await page.keyboard.press('ControlOrMeta+f');
  const find = page.getByRole('searchbox', { name: 'Find in thread' });
  for (const word of ['zebracorn', 'Frobnicator']) {
    await find.fill(word);
    await expect(page.locator('.thread-find-count')).toHaveText('No results');
    await find.press('Enter');
    await page.waitForTimeout(300);
    await expect(page.locator('.thread-find-count')).toHaveText('No results');
    await expect(text(page, 'Result 002')).toHaveCount(0);
  }
  // What the user typed is still found, and draws its turn.
  await find.fill('Prompt 002');
  await expect(page.locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(text(page, 'Result 002')).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a thread draws as soon as its messages arrive, ahead of its task details', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page, { 'session-2': pairs(30, 'session-2') });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => { (window as any).__holdTask = 'session-2'; });
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await expect(message(page, 59)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTask)).toBe('function');
  // A run finishing replaces the page while the details are still out: sending still waits for them.
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-2', kind: 'text', text: 'Late words.' }));
  await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-2', kind: 'done', text: '' }));
  await page.waitForTimeout(500);
  await expect(page.locator('#prompt')).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseTask());
  await expect(page.locator('#prompt')).toBeEnabled();
  // The run's reply stands in for everything after the last prompt until its saved page lands (finishResponse, which
  // waits for the task list the hold kept back): a chain of its own, apart from the details that enable sending.
  await expect(transcriptOf(page).locator('#stream-region .turn-card.is-live')).toHaveCount(0);
  await expect(message(page, 59)).toHaveCount(1);
  expect(errors).toEqual([]);
});

test('a thread left before its team landed still waits for the team when it comes back', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page, { 'session-2': pairs(30, 'session-2') });
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
  await page.evaluate(() => { (window as any).__holdTeam = 'session-2'; });
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await expect(message(page, 59)).toHaveCount(1);
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTeam)).toBe('function');
  await expect(page.locator('#prompt')).toBeDisabled();
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(message(page, 59)).toHaveCount(0);
  // Back on the remembered page, drawn at once: sending still waits for the team.
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await expect(message(page, 59)).toHaveCount(1);
  await page.waitForTimeout(500);
  await expect(page.locator('#prompt')).toBeDisabled();
  await page.evaluate(() => (window as any).__releaseTeam());
  await expect(page.locator('#prompt')).toBeEnabled();
  expect(errors).toEqual([]);
});

test('switching straight back to a thread reattaches its rows, redrawing only what changed', async ({ page }) => {
  const errors = watchErrors(page);
  await exposePreviewMessages(page, { 'session-2': pairs(30, 'session-2') });
  await page.goto('/');
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  await expect(message(page, 59)).toHaveCount(1);
  await transcriptOf(page).locator('.user-message').first().evaluate(node => node.setAttribute('data-kept', ''));
  await page.locator('#navigation .task-item[data-id="session-1"]').click();
  await expect(message(page, 59)).toHaveCount(0);
  await expect(transcriptOf(page).locator('[data-kept]')).toHaveCount(0);
  // A reply joins while the thread is away: it draws, and the rows that did not change are the same nodes.
  await page.evaluate(list => (window as any).__previewMessages['session-2'].push(...list), [say(60, 'user', 'Message 060', 'session-2'), say(61, 'assistant', 'The **new** reply', 'session-2')]);
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  // The remembered rows go back at once; the new turn draws when the thread's page arrives, then formats.
  await expect(message(page, 60)).toHaveCount(1);
  await expect(transcriptOf(page).locator('strong', { hasText: /^new$/ })).toHaveCount(1);
  await expect(transcriptOf(page).locator('[data-kept]')).toHaveCount(1);
  await expect(message(page, 59)).toHaveCount(1);
  const shown = (await drawnNumbers(page)).filter(n => n < 60);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => shown[0] + index));
  expect(shown.at(-1)).toBe(59);
  expect(errors).toEqual([]);
});

test('events streaming for background threads leave an opened long thread alone', async ({ page }) => {
  const errors = watchErrors(page);
  await seed(page);
  // Several threads stream at a frame's pace for the whole test.
  await page.evaluate(() => {
    const w = window as any;
    let tick = 0;
    w.__background = setInterval(() => {
      tick++;
      for (const sessionId of ['session-1', 'session-2', 'session-3', 'session-4']) {
        w.__previewEmit('agent-event', { sessionId, kind: 'text', text: `Background words ${tick}. ` });
        if (tick % 10 === 0) w.__previewEmit('agent-event', { sessionId, kind: 'tool', text: '', data: { type: 'tool_activity', version: 1, id: `bg-${sessionId}-${tick}`, name: 'Read', status: 'completed', input: 'a.ts', output: 'x' } });
      }
    }, 16);
  });
  await row(page).click();
  await expect(message(page, 399)).toBeVisible();
  await expect(message(page, OLDEST_DRAWN)).toHaveCount(1);
  await page.waitForTimeout(600);
  await expect(message(page, OLDEST_DRAWN - 1)).toHaveCount(0);
  await scrollUntilDrawn(page, OLDEST_LOADED);
  await settled(page);
  const held = await transcriptOf(page).evaluate(node => node.scrollTop);
  expect(held).toBeLessThan(await transcriptOf(page).evaluate(node => node.scrollHeight - node.clientHeight));
  await page.evaluate(() => clearInterval((window as any).__background));
  await expect(transcriptOf(page)).not.toContainText('Background words');
  await expect(page.locator('#stream-region .turn-card.is-live')).toHaveCount(0);
  const shown = await drawnNumbers(page);
  expect(shown).toEqual(Array.from({ length: shown.length }, (_, index) => shown[0] + index));
  expect(shown.at(-1)).toBe(399);
  // WebKit reports a resize deferred to the next frame as an error; under this load that is expected and nothing threw.
  expect(errors.filter(error => !error.startsWith('ResizeObserver loop'))).toEqual([]);
});

test('a row set aside that changed size holds the reader still as it comes near', async ({ page }) => {
  const errors = watchErrors(page);
  // As WKWebView: no scroll anchoring, so the hold is the transcript's own correction (skipFarRows).
  await page.addInitScript(() => {
    const supports = CSS.supports.bind(CSS);
    CSS.supports = ((...args: [string, string?]) => /overflow-anchor/.test(args.join(' ')) ? false : supports(...(args as [string, string]))) as typeof CSS.supports;
    document.addEventListener('DOMContentLoaded', () => document.head.append(Object.assign(document.createElement('style'), { textContent: '#transcript{overflow-anchor:none}' })));
  });
  await openLong(page);
  await scrollUntilDrawn(page, OLDEST_LOADED);
  const transcript = transcriptOf(page);
  // Mid-thread, so the oldest rows sit far above the reader and nothing trims.
  await transcript.evaluate(node => { node.scrollTop = Math.min(3600, node.scrollHeight - node.clientHeight - 400); });
  const first = transcript.locator(':scope > *').first();
  await expect.poll(() => first.evaluate(node => (node as HTMLElement).style.contentVisibility), { message: 'the oldest row is set aside' }).toBe('auto');
  // It grows while aside (a worker joining its slot): its box keeps the height it was set aside at.
  await first.evaluate(node => node.append(Object.assign(document.createElement('div'), { style: 'height:400px' })));
  // Scrolled up so it comes near (still past ROWS_MARGIN, so nothing older draws); the reader's line is measured in
  // the task that scrolls.
  const before = await transcript.evaluate(node => {
    node.scrollTop = 1800;
    const box = node.getBoundingClientRect();
    const seen = [...node.querySelectorAll<HTMLElement>('.user-prose')].find(item => { const top = item.getBoundingClientRect().top; return top > box.top + 40 && top < box.bottom - 40; })!;
    (window as any).__anchor = seen;
    return seen.getBoundingClientRect().top;
  });
  await expect.poll(() => first.evaluate(node => (node as HTMLElement).style.contentVisibility)).toBe('');
  await settled(page);
  expect(Math.abs(await transcript.evaluate(() => (window as any).__anchor.getBoundingClientRect().top) - before)).toBeLessThanOrEqual(2);
  expect(errors).toEqual([]);
});

test('a long agent thread opens on a window, and steps deep into it set the far cards aside', async ({ page }) => {
  const errors = watchErrors(page);
  const long = (label: string) => `## Result ${label}\n\n${'Some **formatted** text. '.repeat(30)}`;
  await exposePreviewMessages(page, { 'session-2': agentTurns(60, 'session-2', long) });
  await page.goto('/');
  await page.locator('#navigation .task-item[data-id="session-2"]').click();
  const transcript = transcriptOf(page), cards = transcript.locator('.turn-card');
  await expect(transcript.getByRole('heading', { name: 'Result 059' })).toBeVisible({ timeout: 20_000 });
  await page.waitForTimeout(800);
  expect(await cards.count()).toBeLessThanOrEqual(10);
  await expect(async () => {
    await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    expect(await cards.count()).toBeGreaterThanOrEqual(40);
  }).toPass({ timeout: 45_000 });
  await settled(page);
  const aside = await transcript.evaluate(node => [...node.querySelectorAll<HTMLElement>(':scope > *')].filter(row => row.style.contentVisibility === 'auto' && (row.matches('.turn-card') || row.querySelector('.turn-card'))).length);
  expect(aside, 'cards far from the reader skip layout').toBeGreaterThan((await cards.count()) / 3);
  expect(errors).toEqual([]);
});
});

test.describe('a team that lands after the rows', () => {
  const BASE_TIME = 1_700_000_000_000;
  /** A finished team whose one worker was spawned in the turn starting at message `n`. */
  const teamFor = (sessionId: string, n: number) => ({
    sessionId, status: 'completed', round: 1, revision: 1, error: null, summary: null, updatedAt: BASE_TIME,
    config: { auto: true, workers: [], maxParallel: 0, maxRounds: 6, maxAssignments: 0, workspace: 'shared', summaryLimit: 0 },
    workers: [{ id: 'late-worker', sessionId: 'late-worker-session', profileId: 'auto', name: 'Late worker', provider: 'codex', model: 'gpt-5.5', status: 'completed', assignment: 'Part 1', summary: 'Done', error: null, dependsOn: [], files: [], readOnly: false, attempt: 1, abandoned: false, checkpoint: null, createdAt: BASE_TIME + n * 1000 + 500, updatedAt: BASE_TIME + n * 1000 + 500 }],
  });

  for (const turns of [3, 40]) {
    test(`workers stay in a ${turns}-turn thread whose team arrives after its rows`, async ({ page }) => {
      const errors = watchErrors(page);
      const lastUser = (turns - 1) * 2;
      await exposePreviewMessages(page, { 'session-2': pairs(turns, 'session-2') });
      await page.addInitScript(([team]) => { (window as any).__teams = { 'session-2': team }; (window as any).__holdTeam = 'session-2'; }, [teamFor('session-2', lastUser)] as const);
      await page.goto('/');
      await page.locator('#navigation .task-item[data-id="session-2"]').click();
      await expect(message(page, lastUser + 1)).toHaveCount(1);
      // The rows are on screen while the team is still on the way: each card's slot is there, hidden and empty.
      await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTeam)).toBe('function');
      await expect(transcriptOf(page).locator('.team-progress-slot:not([hidden])')).toHaveCount(0);
      await expect(transcriptOf(page).locator('.team-progress-worker')).toHaveCount(0);
      // The team fills the slots; the cards themselves are not drawn again.
      await transcriptOf(page).locator('.turn-card').last().evaluate(card => card.setAttribute('data-before-team', ''));
      await page.evaluate(() => (window as any).__releaseTeam());
      const worker = transcriptOf(page).locator('.team-progress-worker[data-worker-id="late-worker"]');
      // The team lands with the architect module, imported on first use: slow on a loaded machine.
      await expect(worker).toBeAttached({ timeout: 20_000 });
      // In its own turn's card, not the live host at the end.
      await expect(transcriptOf(page).locator('.turn-card .team-progress-slot .team-progress-worker[data-worker-id="late-worker"]')).toBeAttached();
      await expect(transcriptOf(page).locator('.turn-card[data-before-team]')).toHaveCount(1);
      await page.waitForTimeout(500);
      await expect(worker).toBeAttached();
      expect(errors).toEqual([]);
    });
  }

  test('a remote thread whose team arrives after its rows keeps its workers', async ({ page }) => {
    const errors = watchErrors(page);
    await exposePreviewMessages(page);
    await page.addInitScript(() => { (window as any).__holdTeam = 'mirror-team'; });
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    await page.evaluate(() => (window as any).__previewMirrorTeam());
    await page.locator('#navigation .task-item[data-id="mirror-team"]').click();
    await expect(transcriptOf(page).getByText('Split the docs work')).toBeVisible();
    await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseTeam)).toBe('function');
    await page.evaluate(() => (window as any).__releaseTeam());
    await expect(transcriptOf(page).locator('.team-progress-worker[data-worker-id="w1"]')).toBeAttached({ timeout: 20_000 });
    await page.waitForTimeout(500);
    await expect(transcriptOf(page).locator('.team-progress-worker[data-worker-id="w1"]')).toBeAttached();
    expect(errors).toEqual([]);
  });
});
