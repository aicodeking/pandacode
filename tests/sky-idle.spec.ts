import { expect, test, type Page } from '@playwright/test';

/** The idle rate (src/sky-window.ts): a sky at rest paints ~8 fps; after a quiet stretch with no run, wind or pointer it
 * drops to the scene's idle rate (~3 fps for the daytime sky, more for a scene with fast motion), keeps the resting
 * scene pace, and comes back to the full rate on the next activity. `__sky.idleAfterMs` (preview only) shortens the
 * quiet stretch so the spec does not wait the real 10 s. */
/** The resting pace as shipped (0.3.126): 8 fps timer frames of ~125 ms, each clamped to .1 s of scene time. */
const SHIPPED_REST_PACE = .8;
const sky = (page: Page) => page.locator('.thread-sky');
type Paint = { at: number; time: number; frames: number };

async function open(page: Page, scene = 'sky', at = '12:00'): Promise<void> {
  await page.goto(`/?sky=${at}&scene=${scene}`);
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

const withinTenPercent = (value: number, of: number): boolean => Math.abs(value - of) / of < .1;

test('the resting sky drops to the idle rate after a quiet stretch and keeps the shipped resting pace', async ({ page }) => {
  await open(page);
  await setIdleAfter(page, 1e9);
  const rest = await measure(page, 2000);
  console.log(`rest: ${rest.fps.toFixed(2)} fps, ${rest.ratio.toFixed(3)} scene s per wall s`);
  expect(rest.fps, `${rest.fps.toFixed(1)} fps at rest`).toBeGreaterThan(5);
  // The ~8 fps rest runs the scene at the shipped ~0.8 of the wall clock (125 ms frames clamped to .1 s), never faster.
  expect(withinTenPercent(rest.ratio, SHIPPED_REST_PACE), `scene seconds per wall second at rest (${rest.ratio.toFixed(3)})`).toBe(true);
  expect(rest.ratio).toBeLessThanOrEqual(SHIPPED_REST_PACE + .01);
  expect(await slow(page)).toBe(false);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).__sky.idleFps as number), 'the daytime sky idles at 3 fps').toBe(3);
  const idle = await measure(page, 3000);
  console.log(`idle: ${idle.fps.toFixed(2)} fps, ${idle.ratio.toFixed(3)} scene s per wall s`);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps when idle`).toBeGreaterThanOrEqual(2);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps when idle`).toBeLessThanOrEqual(4);
  // The scene keeps the resting pace (the old .1 s clamp would make this ~0.3; the wall clock, 1.0, would speed it up).
  expect(withinTenPercent(idle.ratio, SHIPPED_REST_PACE), `scene seconds per wall second when idle (${idle.ratio.toFixed(3)})`).toBe(true);
  expect(idle.ratio).toBeLessThanOrEqual(SHIPPED_REST_PACE + .01);
  // So the drift does not visibly change speed at the switch: the two rates' paces agree within 10%.
  expect(withinTenPercent(idle.ratio, rest.ratio), `rest ${rest.ratio.toFixed(3)} vs idle ${idle.ratio.toFixed(3)}`).toBe(true);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

test('a scene with fast motion never drops to 3 fps when idle', async ({ page }) => {
  // Rain's sliding drops would jump tens of pixels a paint at 3 fps: it keeps its full rest rate.
  await open(page, 'rain');
  await setIdleAfter(page, 0);
  await page.waitForTimeout(600);
  expect(await page.evaluate(() => (window as any).__sky.idleFps as number)).toBe(8);
  const rain = await measure(page, 2000);
  expect(rain.fps, `${rain.fps.toFixed(1)} fps for idle rain`).toBeGreaterThan(5);
  expect(withinTenPercent(rain.ratio, SHIPPED_REST_PACE), `rain pace ${rain.ratio.toFixed(3)}`).toBe(true);
  // The aurora's shimmer and the stars' twinkle: 6 fps, at the same pace.
  await open(page, 'aurora', '23:00');
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).__sky.idleFps as number)).toBe(6);
  const aurora = await measure(page, 2000);
  expect(aurora.fps, `${aurora.fps.toFixed(1)} fps for the idle aurora`).toBeGreaterThan(4.5);
  expect(withinTenPercent(aurora.ratio, SHIPPED_REST_PACE), `aurora pace ${aurora.ratio.toFixed(3)}`).toBe(true);
  // The sky at night twinkles too; by day it has nothing fast and idles at 3.
  await open(page, 'sky', '23:00');
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  expect(await page.evaluate(() => (window as any).__sky.idleFps as number)).toBe(6);
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
  // The wake keeps the clock: the first frame spans the idle wait at the resting pace (a wake that restarted the clock
  // would lose it), the burst after it runs at the wall clock, and no single frame jumped ahead of it. Paint times are
  // read off a 2 ms poll and rAF stamps can trail it by a frame or two, hence the margins.
  const before = list[index - 1], first = list[index], end = list.at(-1)!;
  const expected = SHIPPED_REST_PACE * (first.at - before.at) / 1000 + (end.at - first.at) / 1000;
  expect(Math.abs((end.time - before.time) - expected), 'scene time across the wake').toBeLessThan(.05);
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
