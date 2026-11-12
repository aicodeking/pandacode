import { expect, test, type Page } from '@playwright/test';
import { agentTurns, exposePreviewMessages, settled } from './transcript-fixtures';

/* Budgets for a long agent thread. Timing is taken in the page, after a warm-up open has loaded every module, so a cold
 * dev server cannot fail it. Each budget is about three times what the windowed transcript measured (Apple silicon,
 * Chromium: open and send ~50 ms with no long task over ~65 ms; one step up at 4x CPU ~190 ms, every later one up to
 * ~330 ms), so a loaded machine passes while drawing whole pages (an open of seconds) does not. Steps deep in history
 * stay flat only because far cards skip layout; with that off they grow toward a second, too noisy for timing alone, so
 * that test also checks exactly that the far cards are set aside. The window check is exact. Chromium only (long tasks,
 * CPU throttling). */

// A benchmark: run with PERF=1 or by naming this file (playwright.config.ts perfSpecs). The window and far-row
// structure it relies on is checked without timing in transcript-window.spec.ts.
test.skip(({ browserName }) => browserName !== 'chromium', 'long tasks and CPU throttling are Chromium only');

/** The most a cold dev server may take to serve the app and the warm-up thread. */
const WARM_MS = 180_000;
const OPEN_MS = 200, LONG_TASK_MS = 200, SCROLL_TASK_MS = 200, SEND_MS = 200, STEP_TASK_MS = 500;
/** Steps taken deep into history, and the budget for the last of them. */
const STEPS = 16, LATE_STEP_MS = 1000;
/** A first page holds 100 messages, 17 six-message turns; the 40-message window draws about seven. */
const WINDOW_CARDS = 10;
/** The measured thread is long enough for every step below to draw more; the warm-up one is a page. */
const SESSION = 'session-2', SESSION_TURNS = 200, WARM = 'session-1', LAST = 'Result 199', WARM_LAST = 'Result 099';

const reply = (label: string) => `## Result ${label}\n\n${'Some **formatted** text with `code` in it. '.repeat(30)}\n\n- one\n- two\n\n\`\`\`ts\nconst value = ${Number(label)};\n\`\`\``;

const watchLongTasks = (page: Page) => page.addInitScript(() => {
  (window as any).__longest = 0;
  new PerformanceObserver(list => { for (const entry of list.getEntries()) (window as any).__longest = Math.max((window as any).__longest, entry.duration); }).observe({ entryTypes: ['longtask'] });
});
const takeLongest = (page: Page) => page.evaluate(() => { const longest = (window as any).__longest as number; (window as any).__longest = 0; return longest; });
const cards = (page: Page) => page.locator('#transcript .turn-card');

/** Clicks a thread's row in the page and times it until `heading` is drawn. */
const openMs = (page: Page, id: string, heading: string) => page.evaluate(([session, wanted]) => new Promise<number>(resolve => {
  const start = performance.now();
  (document.querySelector(`#navigation .task-item[data-id="${session}"]`) as HTMLElement).click();
  const check = () => [...document.querySelectorAll('#transcript h2')].some(node => node.textContent === wanted) ? resolve(performance.now() - start) : requestAnimationFrame(check);
  check();
}), [id, heading] as const);

/** Warmed up on another long thread, then settled on it with the measured thread never opened. */
async function warmed(page: Page): Promise<void> {
  await watchLongTasks(page);
  await exposePreviewMessages(page, { [SESSION]: agentTurns(SESSION_TURNS, SESSION, reply), [WARM]: agentTurns(100, WARM, reply) });
  // A cold dev server transforms every module on first request, which can take minutes on a loaded machine: the
  // warm-up waits as long as the test allows, and only the timed steps after it have budgets.
  await page.goto('/', { timeout: WARM_MS });
  await page.locator(`#navigation .task-item[data-id="${WARM}"]`).waitFor({ timeout: WARM_MS });
  await expect(page.locator('#transcript').getByRole('heading', { name: WARM_LAST })).toBeVisible({ timeout: WARM_MS });
  await settled(page);
  await takeLongest(page);
}

test('a long agent thread opens, switches, scrolls back and sends within budget', async ({ page }) => {
  test.setTimeout(WARM_MS + 120_000);
  await warmed(page);
  const transcript = page.locator('#transcript');

  const measured: Record<string, number> = {};
  const within = (name: string, value: number, budget: number) => { measured[name] = Math.round(value); expect(value, name).toBeLessThan(budget); };
  within('first open', await openMs(page, SESSION, LAST), OPEN_MS);
  // Past the trim's settle: a window, not the page, and it stays one.
  await page.waitForTimeout(800);
  expect(await cards(page).count()).toBeLessThanOrEqual(WINDOW_CARDS);
  within('longest task opening', await takeLongest(page), LONG_TASK_MS);

  await page.locator(`#navigation .task-item[data-id="${WARM}"]`).click();
  await expect(transcript.locator('.turn-card').first()).toBeVisible();
  await settled(page);
  await takeLongest(page);
  within('switching back', await openMs(page, SESSION, LAST), OPEN_MS);
  within('longest task switching', await takeLongest(page), LONG_TASK_MS);

  // Up through the loaded page and into a fetched one.
  const start = await cards(page).count();
  await expect(async () => {
    await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
    expect(await cards(page).count()).toBeGreaterThan(start + 12);
  }).toPass({ timeout: 45_000 });
  within('longest task scrolling back', await takeLongest(page), SCROLL_TASK_MS);

  await transcript.evaluate(node => { node.scrollTop = node.scrollHeight; });
  const prompt = page.locator('#prompt');
  await prompt.fill('One more thing');
  const sent = page.evaluate(text => new Promise<number>(resolve => {
    const host = document.querySelector('#transcript')!;
    let pressed = 0;
    document.querySelector('#prompt')!.addEventListener('keydown', () => { pressed = performance.now(); }, { once: true, capture: true });
    const seen = new MutationObserver(() => { if (pressed && host.textContent?.includes(text)) { seen.disconnect(); resolve(performance.now() - pressed); } });
    seen.observe(host, { childList: true, subtree: true, characterData: true });
  }), 'One more thing');
  await prompt.press('Enter');
  within('sending', await sent, SEND_MS);
  within('longest task sending', await takeLongest(page), LONG_TASK_MS);
  test.info().annotations.push({ type: 'measured (ms)', description: JSON.stringify(measured) });
  console.info(`measured (ms): ${JSON.stringify(measured)}`);
});

test('one step up stays short with the CPU slowed four times', async ({ page }) => {
  test.setTimeout(WARM_MS + 120_000);
  await warmed(page);
  await openMs(page, SESSION, LAST);
  await settled(page);
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  await takeLongest(page);
  const before = await cards(page).count();
  await page.locator('#transcript').evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
  await expect.poll(() => cards(page).count(), { timeout: 30_000 }).toBeGreaterThan(before);
  await settled(page);
  const longest = await takeLongest(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  test.info().annotations.push({ type: 'longest step task (ms)', description: String(Math.round(longest)) });
  console.info(`longest step task at 4x: ${Math.round(longest)} ms`);
  expect(longest, 'longest task in one step').toBeLessThan(STEP_TASK_MS);
});

test('the last of many steps up stays short with the CPU slowed four times', async ({ page }) => {
  test.setTimeout(WARM_MS + 240_000);
  await warmed(page);
  await openMs(page, SESSION, LAST);
  await settled(page);
  const transcript = page.locator('#transcript');
  const client = await page.context().newCDPSession(page);
  await client.send('Emulation.setCPUThrottlingRate', { rate: 4 });
  const steps: number[] = [];
  for (let step = 0; step < STEPS; step++) {
    await takeLongest(page);
    const before = await cards(page).count();
    // A step that fetches a page draws on the next scroll, so the scroll repeats until the step lands.
    await expect(async () => {
      await transcript.evaluate(node => { node.scrollTop = 0; node.dispatchEvent(new Event('scroll')); });
      expect(await cards(page).count()).toBeGreaterThan(before);
    }).toPass({ timeout: 30_000 });
    await settled(page);
    steps.push(await takeLongest(page));
  }
  await client.send('Emulation.setCPUThrottlingRate', { rate: 1 });
  const nodes = await transcript.evaluate(node => node.querySelectorAll('*').length);
  // Timing alone is noisy: the cards far above the reader must also be out of layout, which is what keeps a step flat.
  const asideCards = await transcript.evaluate(node => [...node.querySelectorAll<HTMLElement>(':scope > *')].filter(row => row.style.contentVisibility === 'auto' && (row.matches('.turn-card') || row.querySelector('.turn-card'))).length);
  test.info().annotations.push({ type: 'step tasks at 4x (ms)', description: steps.map(Math.round).join(', ') });
  console.info(`step tasks at 4x: ${steps.map(Math.round).join(', ')} ms; ${await cards(page).count()} cards, ${nodes} nodes`);
  expect(asideCards, 'cards far from the reader skip layout').toBeGreaterThan((await cards(page).count()) / 2);
  // The median of the last three steps: one noisy frame on a loaded machine does not decide it.
  const late = steps.slice(-3).sort((a, b) => a - b)[1];
  expect(late, 'longest task in the last steps up').toBeLessThan(LATE_STEP_MS);
});
