import { expect, test, type Page } from '@playwright/test';

// One card per agent turn (src/turn-card.ts): header (sentence + elapsed time) over the trace,
// the reply's inner card (clamped, Read more), and a footer that opens the turn's diff.
const transcript = (page: Page) => page.getByRole('log', { name: 'Conversation', exact: true });
const cards = (page: Page) => transcript(page).locator('.turn-card:not(.is-live)');

async function open(page: Page): Promise<string[]> {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.goto('/?cards');
  await page.locator('.task-item', { hasText: 'Turn cards' }).click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText('Turn cards');
  await expect(cards(page)).toHaveCount(2);
  return errors;
}

test('saved turns: header sentence and time, clamped reply, footer only with changes', async ({ page }) => {
  const errors = await open(page);
  const [short, long] = [cards(page).nth(0), cards(page).nth(1)];
  await expect(short.locator('.turn-activity-label')).toHaveText('Replied');
  await expect(short.locator('.turn-card-time')).toHaveText('4s');
  await expect(short.locator('.turn-card-foot')).toHaveCount(0);
  await expect(short.locator('.turn-card-more')).toBeHidden();
  await expect(long.locator('.turn-activity-label')).toContainText('Read 2 files');
  await expect(long.locator('.turn-card-time')).toHaveText('1h 30m 10s');
  // The header opens the step trace inside the card.
  const header = long.locator('.turn-activity-summary');
  await expect(long.locator('.turn-activity-body')).toBeHidden();
  await header.click();
  await expect(long.locator('details.turn-activity')).toHaveAttribute('open', '');
  await expect(long.locator('.turn-activity-body details.tool-trace')).toHaveCount(3);
  await header.click();
  const foot = long.locator('.turn-card-foot');
  await expect(foot).toContainText('3 changed files');
  await expect(foot.locator('.change-additions')).toHaveText('+6');
  await expect(foot.locator('.change-deletions')).toHaveText('−2');
  await expect(foot.locator('.change-dots>span')).toHaveCount(5);
  expect(errors).toEqual([]);
});

test('find in thread opens a clamped reply when the match is past its clamp', async ({ page }) => {
  await open(page);
  const reply = cards(page).nth(1).locator('.turn-card-reply');
  await expect(reply).not.toHaveAttribute('data-open', '');
  await page.keyboard.press('ControlOrMeta+f');
  await page.getByRole('search').getByRole('searchbox', { name: 'Find in thread', exact: true }).fill('an incremental update would avoid the rebuild');
  await expect(page.getByRole('search').locator('.thread-find-count')).toHaveText('1 of 1');
  await expect(reply).toHaveAttribute('data-open', '');
  await expect(reply.locator('.turn-card-more')).toHaveText('Show less');
});

test('Read more expands and collapses the reply, by pointer and keyboard', async ({ page }) => {
  await open(page);
  const reply = cards(page).nth(1).locator('.turn-card-reply');
  const body = reply.locator('.turn-card-reply-body'), more = reply.locator('.turn-card-more');
  await expect(more).toBeVisible();
  await expect(more).toHaveAttribute('aria-expanded', 'false');
  expect(await more.getAttribute('aria-controls')).toBe(await body.getAttribute('id'));
  const clamped = (await body.boundingBox())!.height;
  await more.click();
  await expect(more).toHaveText('Show less');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
  await expect.poll(async () => (await body.boundingBox())!.height).toBeGreaterThan(clamped + 40);
  await expect(reply).toContainText('an incremental update would avoid the rebuild entirely');
  await more.focus();
  await page.keyboard.press('Enter');
  await expect(more).toHaveText('Read more');
  await expect.poll(async () => Math.round((await body.boundingBox())!.height)).toBe(Math.round(clamped));
  await page.keyboard.press('Space');
  await expect(more).toHaveAttribute('aria-expanded', 'true');
});

test('the footer opens the turn diff', async ({ page }) => {
  await open(page);
  await cards(page).nth(1).locator('.turn-card-foot-open').click();
  const review = page.locator('.change-review-dialog');
  await expect(review).toBeVisible();
  await expect(review).toContainText('search');
});

test('a live turn shows a loading state, ticks its time and freezes it at the end', async ({ page }) => {
  await page.clock.install();
  await open(page);
  await page.clock.pauseAt(await page.evaluate(() => Date.now() + 500));
  await page.locator('#prompt').fill('Explain the preview');
  await page.locator('#prompt').press('Enter');
  const live = page.locator('#stream-region .turn-card.is-live');
  await expect(live).toBeVisible();
  await expect(live.locator('.turn-card-skeleton')).toBeVisible();
  await expect(live.locator('.turn-activity-label')).not.toBeEmpty();
  await expect(live.locator('.turn-card-time[data-live]')).toBeVisible();
  // Text replaces the skeleton inside the inner card.
  for (let step = 0; step < 40 && !(await live.locator('.live-message:not([hidden])').count()); step++) { await page.clock.runFor(50); await page.waitForTimeout(16); }
  await expect(live.locator('.turn-card-reply .live-text')).not.toBeEmpty();
  await expect(live.locator('.turn-card-skeleton')).toBeHidden();
  for (let step = 0; step < 80 && await page.getByRole('button', { name: 'Stop task', exact: true }).isVisible(); step++) { await page.clock.runFor(100); await page.waitForTimeout(16); }
  await expect(page.locator('#stream-region .turn-card')).toHaveCount(0);
  const last = cards(page).last();
  await expect(last).toContainText('This is the browser preview.');
  await expect(last.locator('.turn-card-foot')).toContainText('changed files');
  // The reply the reader watched stream stays open; the time no longer ticks.
  await expect(last.locator('.turn-card-reply')).toHaveAttribute('data-open', '');
  const time = last.locator('.turn-card-time');
  await expect(time).not.toHaveAttribute('data-live', '');
  const frozen = await time.textContent();
  await page.clock.runFor(5000);
  await expect(time).toHaveText(frozen!);
});

const liveEvent = (page: Page, event: Record<string, unknown>) => page.evaluate(async event => {
  const sessionId = document.querySelector<HTMLElement>('.task-item.selected')!.dataset.id;
  (window as any).__previewEmit('agent-event', { sessionId, text: '', ...event });
}, event);
const step = (id: string, status: string, output = '') => ({ kind: 'tool', tool: { id, name: 'Bash', status, input: `run ${id}`, output } });

test('the reply loads only until the first text, then keeps the latest text, even between steps', async ({ page }) => {
  await open(page);
  const live = page.locator('#stream-region .turn-card.is-live'), skeleton = live.locator('.turn-card-skeleton');
  const reply = live.locator('.turn-card-reply .live-text');
  await liveEvent(page, step('one', 'running'));
  await expect(skeleton).toBeVisible();
  await liveEvent(page, { kind: 'text', text: 'Reading the config first.' });
  await expect(reply).toHaveText('Reading the config first.');
  await expect(skeleton).toBeHidden();
  // A step after the text never hands the reply back to the skeleton, nor repeats the text in the trace.
  await liveEvent(page, step('one', 'completed', 'done'));
  await liveEvent(page, { kind: 'message_start' });
  await liveEvent(page, step('two', 'running'));
  await expect(live.locator('[data-tool-key$="two"]')).toBeAttached();
  await expect(reply).toHaveText('Reading the config first.');
  await expect(skeleton).toBeHidden();
  await expect(live.locator('.live-tools .activity-commentary')).toHaveCount(0);
  // Newer text takes the reply, and the earlier text joins the trace in order.
  await liveEvent(page, { kind: 'text', text: 'Now running the tests.' });
  await expect(reply).toHaveText('Now running the tests.');
  await expect(skeleton).toBeHidden();
  await expect(live.locator('.live-tools .activity-commentary')).toHaveText('Reading the config first.');
});

test('collapsing a step while the turn runs gives its height back, with no blank band under the card', async ({ page }) => {
  await open(page);
  const live = page.locator('#stream-region .turn-card.is-live');
  const output = Array.from({ length: 40 }, (_, line) => `line ${line}`).join('\n');
  await liveEvent(page, { kind: 'text', text: 'Working on it.' });
  await liveEvent(page, step('long', 'completed', output));
  const row = live.locator('details[data-tool-key$="long"]'), summary = row.locator(':scope > summary');
  await expect(summary).toBeVisible();
  const height = async () => (await live.boundingBox())!.height;
  // Closed first (a finished step may unfold by itself), then measured once it has landed.
  await expect(async () => {
    if (await row.evaluate(node => (node as HTMLDetailsElement).open)) await summary.click();
    await expect(row).not.toHaveAttribute('open', '', { timeout: 500 });
  }).toPass();
  await page.waitForTimeout(500);
  const closed = await height();
  await summary.click();
  await expect(row).toHaveAttribute('open', '');
  await expect.poll(height).toBeGreaterThan(closed + 40);
  await summary.click();
  await expect(row).not.toHaveAttribute('open', '');
  await expect.poll(height).toBeLessThan(closed + 4);
  // It holds from there: it does not spring back to the tallest height it reached.
  await page.waitForTimeout(600);
  expect(await height()).toBeLessThan(closed + 4);
});

test('the live card shrinks back as a long output folds by itself, leaving no blank band', async ({ page }) => {
  await open(page);
  const live = page.locator('#stream-region .turn-card.is-live');
  const output = Array.from({ length: 400 }, (_, line) => `output line ${line}`).join('\n');
  await liveEvent(page, { kind: 'text', text: 'Looking into it.' });
  await liveEvent(page, step('long', 'running'));
  await liveEvent(page, step('long', 'completed', output));
  const long = live.locator('details[data-tool-key$="long"]');
  await expect(long).toHaveAttribute('open', '');
  await page.waitForTimeout(500);
  const tallest = (await live.boundingBox())!.height;
  // Newer steps take its place among the open result cards, so the long one folds.
  for (const id of ['b', 'c']) {
    await liveEvent(page, step(id, 'running'));
    await page.waitForTimeout(150);
    await liveEvent(page, step(id, 'completed', 'short'));
    await page.waitForTimeout(350);
  }
  await expect(long).not.toHaveAttribute('open', '');
  await expect.poll(async () => (await live.boundingBox())!.height).toBeLessThan(tallest - 60);
  await page.waitForTimeout(400);
  // The card is exactly its content: nothing props it open.
  const { height, content } = await live.evaluate(card => {
    const last = [...card.children].filter(child => child.getClientRects().length).at(-1)!;
    return { height: card.getBoundingClientRect().bottom, content: last.getBoundingClientRect().bottom };
  });
  expect(height - content).toBeLessThan(16);
  expect(await live.evaluate(card => (card as HTMLElement).style.minHeight)).toBe('');
});

test('what sits above the live card stays still as it shrinks', async ({ page }) => {
  await open(page);
  const live = page.locator('#stream-region .turn-card.is-live');
  const output = Array.from({ length: 400 }, (_, line) => `output line ${line}`).join('\n');
  const cardTop = () => live.evaluate(card => card.getBoundingClientRect().top);
  await liveEvent(page, { kind: 'text', text: 'Looking into it.' });
  // Pinned to the end of a thread that overflows, with the card's top in view.
  await liveEvent(page, step('long', 'completed', output));
  await page.waitForTimeout(500);
  await page.locator('#transcript').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  const long = live.locator('details[data-tool-key$="long"]');
  await expect(long).toHaveAttribute('open', '');
  const held = await cardTop();
  expect(held).toBeGreaterThan(60);
  const before = (await live.boundingBox())!.height;
  await long.locator(':scope > summary').evaluate(node => (node as HTMLElement).click());
  await expect.poll(async () => (await live.boundingBox())!.height).toBeLessThan(before - 60);
  await page.waitForTimeout(400);
  expect(Math.abs(await cardTop() - held)).toBeLessThan(2);

});

test('a card taller than the window folds down into view, never leaving the window empty', async ({ page }) => {
  await open(page);
  await page.setViewportSize({ width: 1440, height: 620 });
  const live = page.locator('#stream-region .turn-card.is-live');
  const output = Array.from({ length: 400 }, (_, line) => `output line ${line}`).join('\n');
  await liveEvent(page, { kind: 'text', text: 'Looking into it.' });
  for (const id of ['a', 'b', 'c']) await liveEvent(page, step(id, 'completed', output));
  await page.waitForTimeout(700);
  await page.locator('#transcript').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  expect(await live.evaluate(card => card.getBoundingClientRect().top)).toBeLessThan(0);
  await liveEvent(page, { kind: 'text', text: 'Here is the answer.' });
  await expect.poll(() => live.locator('details.turn-activity').evaluate(node => (node as HTMLElement).dataset.folded !== undefined), { timeout: 3000 }).toBe(true);
  await page.waitForTimeout(500);
  const shown = await live.evaluate(card => { const box = card.getBoundingClientRect(), view = document.querySelector('#transcript')!.getBoundingClientRect(); return { top: box.top, bottom: box.bottom, viewTop: view.top, viewBottom: view.bottom }; });
  expect(shown.top).toBeGreaterThanOrEqual(shown.viewTop);
  expect(shown.top).toBeLessThan(shown.viewBottom - 40);
});

test('the live time ticks while the turn runs', async ({ page }) => {
  await page.clock.install();
  await page.goto('/?trace');
  await page.locator('.task-item', { hasText: 'Morning brief' }).click();
  await page.locator('#prompt').fill('Give me my morning brief');
  await page.locator('#prompt').press('Enter');
  const time = page.locator('#stream-region .turn-card.is-live .turn-card-time[data-live]');
  await expect(time).toBeVisible();
  for (let step = 0; step < 50 && (await time.textContent()) !== '2s'; step++) { await page.clock.runFor(100); await page.waitForTimeout(16); }
  await expect(time).toHaveText('2s');
  expect(await time.evaluate(node => getComputedStyle(node).fontVariantNumeric)).toContain('tabular-nums');
});

test('reduced motion leaves no card animations', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page);
  const animations = () => page.evaluate(() => document.getAnimations().filter(animation => {
    const target = (animation.effect as KeyframeEffect | null)?.target;
    return target instanceof Element && target.closest('.turn-card');
  }).length);
  await cards(page).nth(1).locator('.turn-card-more').click();
  await cards(page).nth(1).locator('.turn-activity-summary').click();
  expect(await animations()).toBe(0);
  await page.locator('#prompt').fill('Explain the preview');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#stream-region .turn-card.is-live')).toBeVisible();
  expect(await animations()).toBe(0);
  await expect(page.locator('#stream-region .turn-card')).toHaveCount(0, { timeout: 8000 });
  expect(await animations()).toBe(0);
});

test('the live card hands off to the saved card in one frame, eases once at the end, and the prompt does not jump', async ({ page }) => {
  const errors = await open(page);
  // Sampled every frame from the send until well after the saved card took over.
  await page.evaluate(() => {
    const frames: { cards: number; live: number; liveHeight: number | null; lastHeight: number | null; text: boolean; done: boolean; folded: boolean; bubble: number | null; height: number }[] = [];
    (window as unknown as { __frames: typeof frames }).__frames = frames;
    const loop = () => {
      const shown = [...document.querySelectorAll<HTMLElement>('#transcript .turn-card')].filter(card => card.getClientRects().length);
      const live = document.querySelector<HTMLElement>('#stream-region .turn-card.is-live');
      const bubble = [...document.querySelectorAll<HTMLElement>('#transcript .user-message')].at(-1);
      frames.push({ cards: shown.length, live: shown.filter(card => card.classList.contains('is-live')).length, liveHeight: live?.getClientRects().length ? live.getBoundingClientRect().height : null, lastHeight: shown.at(-1)?.getBoundingClientRect().height ?? null,
        text: Boolean(live?.querySelector('.live-message:not([hidden])')), done: Boolean(live?.hasAttribute('data-done')), folded: Boolean(live?.querySelector('.turn-activity[data-folded]')), bubble: bubble ? bubble.getBoundingClientRect().top : null, height: document.querySelector('#transcript')!.scrollHeight });
      // Read after the frame has painted: an animation frame runs before the transcript's observer settles the scroll, so it would see a position nobody does.
      if (frames.length < 900) requestAnimationFrame(() => { const channel = new MessageChannel(); channel.port1.onmessage = loop; channel.port2.postMessage(0); });
    };
    loop();
  });
  await page.locator('#prompt').fill('Explain the preview');
  await page.locator('#prompt').press('Enter');
  await expect(page.locator('#stream-region .turn-card')).toHaveCount(0, { timeout: 10000 });
  await expect(cards(page)).toHaveCount(3);
  await page.waitForTimeout(1200);
  const frames = await page.evaluate(() => (window as unknown as { __frames: { cards: number; live: number; liveHeight: number | null; lastHeight: number | null; text: boolean; done: boolean; folded: boolean; bubble: number | null; height: number }[] }).__frames);
  const liveFrames = frames.map((frame, index) => ({ ...frame, index })).filter(frame => frame.live);
  expect(liveFrames.length).toBeGreaterThan(5);
  // Never two cards for one turn: two saved turns plus either the live card or the new saved one.
  expect(Math.max(...frames.map(frame => frame.cards))).toBe(3);
  const folded = liveFrames.findIndex(frame => frame.folded);
  expect(folded, 'the trace folds while the reply streams').toBeGreaterThan(-1);
  expect(liveFrames[folded].done, 'the trace folded before the run ended').toBe(false);
  // From the first token on, the prompt above the card moves only with the follow (the reply growing; a result card
  // unfolding is followed at most FOLLOW_MAX_LAG behind), never down while the trace folds (blank room takes its
  // height), and not at all from the handoff on: the live card is at its saved shape and nothing moves by itself.
  const from = liveFrames.find(frame => frame.text)!.index, swap = liveFrames.at(-1)!.index + 1;
  for (let i = from + 1; i < frames.length; i++) {
    const step = frames[i].bubble! - frames[i - 1].bubble!;
    expect(Math.abs(step), `prompt moved ${step}px at frame ${i}`).toBeLessThanOrEqual(i >= swap ? 1 : 40);
    if (i < swap) expect(step, `prompt slid down ${step}px at frame ${i}`).toBeLessThanOrEqual(1);
  }
  expect(frames.length - swap, 'sampled a second after the run').toBeGreaterThan(40);
  // The handoff is one ease (the footer): one direction, gently.
  const after = frames.slice(swap - 1).map(frame => frame.lastHeight!), direction = Math.sign(after.at(-1)! - after[0]);
  for (let i = 1; i < after.length; i++) {
    const step = after[i] - after[i - 1];
    expect(Math.abs(step), `the saved card moved ${step}px in a frame`).toBeLessThanOrEqual(16);
    expect(step * direction, `the saved card reversed at frame ${swap - 1 + i}`).toBeGreaterThanOrEqual(-0.5);
  }
  // Each redraw is one layout: a saved reply is clamped in the task it is drawn, so no frame sees it at full height (a spike).
  for (let i = 1; i < frames.length - 1; i++) expect(frames[i].height - Math.max(frames[i - 1].height, frames[i + 1].height), `scroll height spiked at frame ${i}`).toBeLessThan(40);
  expect(errors).toEqual([]);
});

test('the handoff keeps focus on the same control: the header, then Copy', async ({ page }) => {
  await open(page);
  for (const [control, live] of [['header', '.turn-activity-summary'], ['Copy', '.turn-card-reply [data-message-action="copy"]']] as const) {
    await page.locator('#prompt').fill('Explain the preview');
    await page.locator('#prompt').press('Enter');
    const card = page.locator('#stream-region .turn-card.is-live');
    if (control === 'Copy') await expect(card.locator('.live-message')).toBeVisible();
    await card.locator(live).focus();
    await expect(page.locator('#stream-region .turn-card')).toHaveCount(0, { timeout: 10000 });
    const saved = cards(page).last();
    await expect(saved.locator(control === 'header' ? ':scope > details.turn-activity > .turn-activity-summary' : '.turn-card-reply-row [data-message-action="copy"]'), `${control} keeps focus`).toBeFocused();
  }
});

test('a reader focused on a trace step keeps the trace open and the step focused at the handoff', async ({ page }) => {
  await page.goto('/?trace');
  await page.locator('.task-item', { hasText: 'Morning brief' }).click();
  await page.locator('#prompt').fill('Give me my morning brief');
  await page.locator('#prompt').press('Enter');
  const live = page.locator('#stream-region .turn-card.is-live');
  const step = live.locator('details.tool-trace:not([data-mirrored]) > summary').first();
  await expect(step).toBeVisible({ timeout: 10000 });
  const key = await step.evaluate(node => (node.parentElement as HTMLElement).dataset.toolKey!);
  await step.focus();
  // The reply starts and the run ends without folding the trace under the reader.
  await expect(page.locator('#stream-region .turn-card')).toHaveCount(0, { timeout: 20000 });
  const saved = transcript(page).locator('.turn-card:not(.is-live)').last();
  await expect(saved.locator(':scope > details.turn-activity')).toHaveAttribute('open', '');
  await expect(saved.locator(`[data-tool-key="${key}"] > summary`)).toBeFocused();
});

test('a send eases the thread to the new turn', async ({ page }) => {
  await open(page);
  const tops = () => page.evaluate(() => {
    const frames: [number, number][] = [];
    (window as unknown as { __tops: [number, number][] }).__tops = frames;
    // Queried each frame: the send redraws the transcript.
    const loop = (now: number) => { frames.push([now, document.querySelector<HTMLElement>('#transcript .turn-card')!.getBoundingClientRect().top]); if (frames.length < 24) requestAnimationFrame(loop); };
    requestAnimationFrame(loop);
  });
  // In px per 60 Hz frame, so a slow frame under load is not read as a leap.
  const steps = async () => { await page.waitForTimeout(800); const frames = await page.evaluate(() => (window as unknown as { __tops: [number, number][] }).__tops); return frames.slice(1).map(([at, top], i) => Math.abs(top - frames[i][1]) / Math.max(1, (at - frames[i][0]) / (1000 / 60))); };
  // The thread grows past the window (the bubble and the skeleton card): the scroll follows on a spring, never in one leap.
  await tops();
  await page.locator('#prompt').fill('Explain the preview');
  await page.locator('#prompt').press('Enter');
  expect(Math.max(...await steps())).toBeLessThanOrEqual(60);
});

test('Show less at the end of the thread keeps the reply top still', async ({ page }) => {
  await open(page);
  // The room the reply gives up past what the scroll can lose stays as blank space, so its top holds.
  const reply = cards(page).nth(1).locator('.turn-card-reply'), more = reply.locator('.turn-card-more');
  await more.click();
  await expect(more).toHaveText('Show less');
  await page.waitForTimeout(300);
  await page.locator('#transcript').evaluate(node => { node.scrollTop = node.scrollHeight; });
  await page.waitForTimeout(100);
  const top = (await reply.boundingBox())!.y;
  await more.click();
  await expect(more).toHaveText('Read more');
  await page.waitForTimeout(400);
  expect(Math.abs((await reply.boundingBox())!.y - top)).toBeLessThanOrEqual(1);
});
