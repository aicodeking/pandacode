import { expect, test, type Page } from '@playwright/test';

/** The idle rate (src/sky-window.ts): a sky at rest paints ~8 fps; after a quiet stretch with no run, wind or pointer it
 * drops to ~3 fps, keeps its scene clock on the wall clock, and comes back to the full rate on the next activity.
 * `__sky.idleAfterMs` (preview only) shortens the quiet stretch so the spec does not wait the real 10 s. */
const sky = (page: Page) => page.locator('.thread-sky');
type Paint = { at: number; time: number; frames: number };

async function open(page: Page): Promise<void> {
  await page.goto('/?sky=12:00&scene=sky');
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#transcript .message').first()).toBeVisible();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
}
const setIdleAfter = (page: Page, ms: number) => page.evaluate(value => { (window as any).__sky.idleAfterMs = value; }, ms);
const slow = (page: Page) => page.evaluate(() => (window as any).__sky.slow as boolean);
const frames = (page: Page) => page.evaluate(() => (window as any).__sky.frames as number);
/** Waits for the next paint and returns when it landed (to a few ms), with the scene time it painted. */
const nextPaint = (page: Page) => page.evaluate(() => new Promise<Paint>(resolve => {
  const read = (window as any).__sky, from = read.frames as number;
  const poll = (): void => {
    if (read.frames !== from) resolve({ at: performance.now(), time: read.time as number, frames: read.frames as number });
    else setTimeout(poll, 2);
  };
  poll();
}));
/** Paints and scene seconds over about `ms` of wall clock, measured paint to paint. */
async function measure(page: Page, ms: number): Promise<{ fps: number; ratio: number }> {
  const from = await nextPaint(page);
  await page.waitForTimeout(ms);
  const to = await nextPaint(page);
  const wall = (to.at - from.at) / 1000;
  return { fps: (to.frames - from.frames) / wall, ratio: (to.time - from.time) / wall };
}

test('the resting sky drops to the idle rate after a quiet stretch and keeps scene time on the wall clock', async ({ page }) => {
  await open(page);
  await setIdleAfter(page, 1e9);
  const rest = await measure(page, 2000);
  expect(rest.fps, `${rest.fps.toFixed(1)} fps at rest`).toBeGreaterThan(5);
  // The ~8 fps rest keeps the wall clock too (REST_DT): with the plain .1 s clamp its 125 ms frames ran the scene at ~0.8.
  expect(rest.ratio, `scene seconds per wall second at rest (${rest.ratio.toFixed(3)})`).toBeGreaterThan(.9);
  expect(rest.ratio).toBeLessThan(1.1);
  expect(await slow(page)).toBe(false);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  const idle = await measure(page, 3000);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps when idle`).toBeGreaterThanOrEqual(2);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps when idle`).toBeLessThanOrEqual(4);
  // The scene keeps moving at the wall clock's pace: the old .1 s clamp would make this ~0.3.
  expect(idle.ratio, `scene seconds per wall second when idle (${idle.ratio.toFixed(3)})`).toBeGreaterThan(.9);
  expect(idle.ratio).toBeLessThan(1.1);
  // So the drift does not visibly change speed at the switch: the two rates' clocks agree within 10%.
  expect(Math.abs(idle.ratio - rest.ratio) / rest.ratio, `rest ${rest.ratio.toFixed(3)} vs idle ${idle.ratio.toFixed(3)}`).toBeLessThan(.1);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

/** Records every paint (time, scene seconds) from now on, polled every 2 ms in the page, so the first paint after an
 * action is never missed to a round trip. */
const record = (page: Page) => page.evaluate(() => {
  const read = (window as any).__sky, paints: Paint[] = [];
  let seen = read.frames as number;
  (window as any).__paints = paints;
  const poll = (): void => {
    if (read.frames !== seen) { seen = read.frames; paints.push({ at: performance.now(), time: read.time, frames: seen }); }
    if (paints.length < 400) setTimeout(poll, 2);
  };
  poll();
});
const paints = (page: Page) => page.evaluate(() => (window as any).__paints as Paint[]);

test('the pointer over the sky brings the full rate back at once, without a jump in scene time', async ({ page }) => {
  await open(page);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  await nextPaint(page);
  await page.evaluate(() => addEventListener('pointermove', () => { (window as any).__movedAt ??= performance.now(); }, { capture: true }));
  await record(page);
  await expect.poll(async () => (await paints(page)).length, { intervals: [10] }).toBeGreaterThan(0);
  await page.mouse.move(700, 600); await page.mouse.move(760, 640, { steps: 6 });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await page.waitForTimeout(300);
  const moved = await page.evaluate(() => (window as any).__movedAt as number), list = await paints(page);
  const index = list.findIndex(paint => paint.at > moved);
  expect(index, 'a paint after the pointer moved').toBeGreaterThan(0);
  // Not the rest of a 333 ms idle wait: one rAF (headless Chrome wakes its first rAF ~50-75 ms after input, the same from
  // the 8 fps rest state).
  expect(list[index].at - moved, 'the first paint after the pointer moved').toBeLessThan(150);
  // The wake keeps the clock: from the last idle paint to the end of the burst the scene advanced by the wall time (a
  // wake that restarted the clock would lose the ~300 ms idle wait here), and no single frame jumped ahead of it. Paint
  // times are read off a 2 ms poll and rAF stamps can trail it by a frame or two, hence the margins.
  const before = list[index - 1], end = list.at(-1)!;
  expect(Math.abs((end.time - before.time) - (end.at - before.at) / 1000), 'scene time across the wake').toBeLessThan(.05);
  for (let i = index; i < list.length; i++)
    expect(list[i].time - list[i - 1].time, `scene step at paint ${i}`).toBeLessThanOrEqual((list[i].at - list[i - 1].at) / 1000 + .05);
  expect(list.length - index, 'the pointer burst paints well past the idle rate in 300 ms').toBeGreaterThan(5);
});

test('a run starting brings the full rate back at once', async ({ page }) => {
  await open(page);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  await nextPaint(page);
  await record(page);
  const started = await page.locator('#transcript').evaluate(node => { node.setAttribute('data-running', ''); return performance.now(); });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind'))).toBeGreaterThan(0);
  const list = await paints(page), first = list.find(paint => paint.at > started);
  expect(first, 'a paint after the run started').toBeDefined();
  expect(first!.at - started, 'the first paint after the run started').toBeLessThan(150);
  expect(await slow(page), 'a running thread is never at the idle rate').toBe(false);
  // A run paints at the churn cap (8 fps), never the idle 3.
  const busy = await measure(page, 1500);
  expect(busy.fps, `${busy.fps.toFixed(1)} fps during a run`).toBeGreaterThan(5);
});

test('reduced motion keeps its one still frame, idle rate or not', async ({ page }) => {
  await open(page);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
  expect(await slow(page)).toBe(false);
  await page.waitForTimeout(200);
  const still = await frames(page);
  await page.mouse.move(700, 600); await page.mouse.move(760, 640, { steps: 5 });
  await page.waitForTimeout(800);
  expect(await frames(page)).toBe(still);
});
