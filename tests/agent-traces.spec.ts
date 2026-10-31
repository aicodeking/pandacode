import { test, expect, type Page } from '@playwright/test';

// Steps are the tool rows hanging off the turn's rail; a step's result card is open when its <details> is.
const STEP = 'details.tool-trace';
const OPEN_STEP = `${STEP}[open]`;
const BRAND = '.tool-trace-chip:has(.brand-icon)';
const CITE = '.md-cite';
const STEPS = ['Slack', 'Granola', 'Gmail', 'GitHub', 'Linear'];
// Cards that stay open: neither closed nor already folding (`data-closing`), so a fold is timed from its start.
const keptSteps = (page: Page) => page.locator(STEP).evaluateAll(list => list.flatMap((step, i) => (step as HTMLDetailsElement).open && !(step as HTMLElement).hasAttribute('data-closing') ? [i] : []));
const openSteps = (page: Page) => page.locator(STEP).evaluateAll(list => list.flatMap((step, i) => (step as HTMLDetailsElement).open ? [i] : []));

async function open(page: Page, title: string) {
  await page.clock.install();
  await page.goto('/?trace');
  await page.locator('.task-item', { hasText: title }).click();
  await expect(page.locator('.task-item.selected .task-title')).toHaveText(title);
}

async function send(page: Page, text: string) {
  await page.locator('#prompt').fill(text);
  await page.locator('#prompt').press('Enter');
}

/** The preview bridge adds its own latency, so phases follow the replay's events rather than absolute times:
 * advance the fake clock in 50 ms steps until `ready` holds. */
async function advanceUntil(page: Page, ready: () => Promise<boolean>) {
  for (let step = 0; step < 400; step++) {
    if (await ready()) return;
    await page.clock.runFor(50);
    // Rendering frames (and the Web Animations they drive) need real time; the fake clock does not supply it.
    await page.waitForTimeout(16);
  }
  throw new Error('The replay never reached the expected state');
}
const statuses = (page: Page) => page.locator(STEP).evaluateAll(list => list.map(step => (step as HTMLElement).dataset.toolStatus));
const finished = (page: Page, count: number) => async () => (await statuses(page)).filter(status => status === 'completed').length >= count;

test('Morning brief replays the reference: header mirrors the step, two newest cards open, folds to one summary', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  await open(page, 'Morning brief');
  await send(page, 'Give me my morning brief');
  const header = page.locator('#stream-region .live-activity .turn-activity-label');

  // Slack runs as the only step: no card until its result, and the header mirrors its sentence.
  await advanceUntil(page, async () => (await statuses(page)).length === 1);
  await expect(page.locator(STEP).first()).toHaveAttribute('data-tool-status', 'running');
  await expect(page.locator(STEP).first().locator(':scope > summary')).toContainText('Searched');
  await expect(page.locator(STEP).first().locator(BRAND)).toContainText('Slack');
  await expect(page.locator(STEP).first()).toContainText('for messages since yesterday');
  await expect(header).toHaveAttribute('data-mode', 'step');
  await expect(header).toContainText('for messages since yesterday');
  expect(await openSteps(page)).toEqual([]);

  // Slack's result opens its card, which stays open while Granola runs.
  await advanceUntil(page, async () => (await statuses(page)).join() === 'completed,running');
  await expect(header).toContainText('Granola');
  await expect.poll(() => openSteps(page)).toEqual([0]);
  await expect(page.locator(STEP).first().locator('.trace-row')).toHaveCount(3);
  await expect(page.locator(STEP).first().locator('.tool-trace-more')).toHaveText('+1 more');

  // Granola's card opens beside Slack's: the reference keeps the two newest results open.
  await advanceUntil(page, finished(page, 2));
  await expect.poll(() => openSteps(page)).toEqual([0, 1]);

  // Gmail's result arrives and Slack's card, two results back, folds away.
  await advanceUntil(page, finished(page, 3));
  await expect.poll(() => openSteps(page)).toEqual([1, 2]);

  // Every step finishes in order, each with its brand chip; GitHub and Linear are the open pair.
  await advanceUntil(page, finished(page, 5));
  await expect(page.locator(STEP)).toHaveCount(5);
  for (const [i, brand] of STEPS.entries()) await expect(page.locator(STEP).nth(i).locator(BRAND)).toContainText(brand);
  await expect.poll(() => openSteps(page)).toEqual([3, 4]);
  await expect(page.locator(STEP).nth(3).locator('.trace-mark.is-pull')).toHaveCount(3);
  await expect(page.locator(STEP).nth(4).locator('.trace-mark.is-issue')).toHaveCount(3);

  // Measured at 30 fps: GitHub and Linear stay open while the answer's first block streams, fold ~1.05 s
  // after it starts, and the turn folds to its summary ~2.45 s after it starts.
  await advanceUntil(page, async () => ((await page.locator('#stream-region .live-text').textContent()) ?? '').includes('Meetings'));
  const answerAt = await page.evaluate(() => Date.now());
  await expect(page.locator(STEP)).toHaveCount(5);
  expect(await openSteps(page)).toEqual([3, 4]);
  await advanceUntil(page, async () => (await keptSteps(page)).length === 0);
  const cardsAt = await page.evaluate(() => Date.now());
  expect(cardsAt - answerAt).toBeGreaterThanOrEqual(900);
  expect(cardsAt - answerAt).toBeLessThanOrEqual(1300);
  await advanceUntil(page, async () => ((await page.locator('.turn-activity-label').first().textContent()) ?? '').includes('Ran 2 searches'));
  const turnAt = await page.evaluate(() => Date.now());
  expect(turnAt - answerAt).toBeGreaterThanOrEqual(2250);
  expect(turnAt - answerAt).toBeLessThanOrEqual(2750);

  // Finished: one folded summary with brand marks, then the answer with citation chips.
  await advanceUntil(page, async () => !await page.locator('#stream-region .live-activity').count() && !await page.locator('.task-item.selected.running').count());
  const turn = page.locator('details.turn-activity.is-steps');
  await expect(turn.locator('.turn-activity-label')).toContainText('Ran 2 searches and read 3 sources');
  await expect(turn.locator('.turn-activity-label .tool-trace-stack .brand-icon')).toHaveCount(3);
  await expect(turn).not.toHaveAttribute('open', '');
  await expect(page.locator(OPEN_STEP)).toHaveCount(0);
  await expect(page.getByText('Kickoff with Northwind: scope agreed, invoice at month end')).toBeVisible();
  await expect(page.locator(CITE)).toHaveCount(3);
  await expect(page.locator(CITE).nth(0)).toContainText('notes');
  await expect(page.locator(CITE).nth(1)).toContainText('one');
  await expect(page.locator(CITE).nth(2)).toContainText('commit');
  await expect(page.locator('a[href="mailto:jane.doe@example.com"]')).toBeVisible();
  // The folded summary opens onto the same steps, every card closed, with no group headers.
  await turn.locator('.turn-activity-summary').click();
  await expect(turn.locator(`${STEP} > summary`).first()).toBeVisible();
  await expect(turn.locator('.tool-group-summary').first()).toBeHidden();
  expect(errors).toEqual([]);
});

test('Morning brief leaves cards the reader toggled by hand alone, and stays open while one is read', async ({ page }) => {
  await open(page, 'Morning brief');
  await send(page, 'Brief me');
  await advanceUntil(page, async () => (await statuses(page)).join() === 'completed,running');
  await expect.poll(() => openSteps(page)).toEqual([0]);
  // Closed by hand: Granola's result would keep Slack open, but the reader's choice wins.
  await page.locator(STEP).first().locator(':scope > summary').click();
  await expect.poll(() => openSteps(page)).toEqual([]);
  await advanceUntil(page, finished(page, 2));
  await expect.poll(() => openSteps(page)).toEqual([1]);
  // Re-opened by hand: Granola stays open through later results and the streaming answer.
  await page.locator(STEP).nth(1).locator(':scope > summary').click();
  await page.locator(STEP).nth(1).locator(':scope > summary').click();
  await expect.poll(() => openSteps(page)).toEqual([1]);
  await advanceUntil(page, async () => ((await page.locator('#stream-region .live-text').textContent()) ?? '').includes('Meetings'));
  await expect.poll(() => openSteps(page)).toEqual([1]);
  // The run ends without folding the turn the reader is in; the card stays open in saved history.
  await advanceUntil(page, async () => !await page.locator('#stream-region .live-activity').count() && !await page.locator('.task-item.selected.running').count());
  await expect(page.locator('details.turn-activity.is-steps')).toHaveAttribute('open', '');
  await expect.poll(() => openSteps(page)).toEqual([1]);
});

test('Morning brief keeps its tool history after the run and on reload of the thread', async ({ page }) => {
  await open(page, 'Morning brief');
  await send(page, 'Brief me');
  await page.clock.runFor(12000);
  await expect(page.locator('.task-item.selected')).not.toHaveClass(/running/);
  const saved = () => page.locator('[data-tool-name]').evaluateAll(list => list.map(card => card.getAttribute('data-tool-name')));
  const names = ['mcp__slack__search_messages', 'mcp__granola__get_meetings', 'mcp__gmail__search_threads', 'mcp__github__list_pull_requests', 'mcp__linear__list_issues'];
  expect(await saved()).toEqual(names);
  await expect(page.locator('.turn-activity-label', { hasText: 'Ran 2 searches and read 3 sources' })).toBeVisible();
  await page.locator('.task-item', { hasText: 'Tool gallery' }).click();
  await page.locator('.task-item', { hasText: 'Morning brief' }).click();
  await expect(page.locator('[data-tool-name]')).toHaveCount(5);
  expect(await saved()).toEqual(names);
  await expect(page.locator('.turn-activity-label', { hasText: 'Ran 2 searches and read 3 sources' })).toBeVisible();
});

test('Tool gallery renders a card for every tool kind without console errors', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', error => errors.push(error.message));
  page.on('console', message => { if (message.type() === 'error') errors.push(message.text()); });
  await open(page, 'Tool gallery');
  const cards = page.locator('[data-tool-name]');
  await expect(cards).toHaveCount(16);
  const names = await cards.evaluateAll(list => list.map(card => card.getAttribute('data-tool-name')));
  expect(names).toEqual(['Bash', 'Read', 'Edit', 'MultiEdit', 'Write', 'Grep', 'Glob', 'WebSearch', 'WebFetch', 'TodoWrite', 'Task', 'Skill', 'mcp__pandacode_architect__pandacode_dispatch_workers', 'mcp__docs__search_docs', 'Bash', 'Bash']);
  const statuses = await cards.evaluateAll(list => list.map(card => card.getAttribute('data-tool-status')));
  expect(statuses.slice(-2)).toEqual(['failed', 'running']);
  // Cards may sit inside a folded turn, so read their text rather than requiring visibility.
  const text = await cards.evaluateAll(list => list.map(card => card.textContent ?? '').join('\n'));
  for (const label of ['npm test', 'search-index.ts', 'normalize.ts', 'unicode case folding javascript', 'developer.mozilla.org', 'Normalizing queries', 'Audit search callers', 'simplify', 'Search fix', 'npm run lint', 'npm run build']) expect(text, label).toContain(label);
  expect(errors).toEqual([]);
});

test('header glyph states, two-tone header text, and no frozen shimmer under reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await open(page, 'Morning brief');
  await send(page, 'Give me my morning brief');
  const header = page.locator('#stream-region .live-activity .turn-activity-label');
  await advanceUntil(page, async () => await header.getAttribute('data-mode') === 'status');
  // Before the first step: the dot cluster and `Working` dark with a dim ` on it…` (never `Starting agent`).
  await expect(header.locator('.trace-glyph.is-dots > i')).toHaveCount(4);
  await expect(header.locator('.trace-status-lead')).toHaveText('Working');
  await expect(header.locator('.trace-status-rest')).toHaveText(' on it…');
  const lead = await header.locator('.trace-status-lead').evaluate(node => getComputedStyle(node).color);
  expect(lead).not.toBe(await header.locator('.trace-status-rest').evaluate(node => getComputedStyle(node).color));
  await advanceUntil(page, async () => await header.getAttribute('data-mode') === 'step');
  await expect(header.locator('.trace-glyph.is-step .icon')).toHaveCount(1);
  const tone = (selector: string) => header.locator(selector).first().evaluate(node => getComputedStyle(node).color);
  expect(await tone('.tool-trace-verb')).not.toBe(await tone('.tool-trace-object'));
  // The shimmer's mask lives with its animation, so reduced motion leaves no dim band behind.
  expect(await header.locator('.trace-sentence').evaluate(node => getComputedStyle(node).maskImage)).toBe('none');
  // While the answer streams after the tools, the glyph becomes level bars.
  await advanceUntil(page, async () => await header.locator('.trace-glyph.is-bars').count() > 0 || await header.getAttribute('data-mode') === 'folded');
  await advanceUntil(page, async () => await header.getAttribute('data-mode') === 'folded');
  await expect(header.locator('.trace-summary-text')).toHaveCSS('white-space', 'nowrap');
});
