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

test('Still sky pauses animation, survives reload, and hides while wallpapers are on', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await open(page);
  await nextPaint(page);

  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  const openAppearance = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click();
    await settings.getByRole('tab', { name: 'Appearance', exact: true }).click();
  };
  const back = settings.getByRole('button', { name: 'Back to the workspace' });
  const stillSky = settings.getByRole('checkbox', { name: 'Still sky', exact: true });
  const wallpapers = settings.getByRole('checkbox', { name: 'Wallpapers', exact: true });

  await openAppearance();
  await expect(stillSky).toBeVisible();
  await expect(stillSky).not.toBeChecked();
  await stillSky.check();
  await back.click();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
  const still = await frames(page);
  await page.waitForTimeout(400);
  expect(await frames(page)).toBe(still);
  await page.mouse.move(700, 600);
  await page.mouse.move(760, 640, { steps: 5 });
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  await page.waitForTimeout(400);
  expect(await frames(page)).toBe(still);
  await expect(sky(page)).toHaveAttribute('data-wind', '0');

  await page.reload();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
  await openAppearance();
  await expect(stillSky).toBeChecked();
  await wallpapers.check();
  await expect(settings.getByText('Still sky', { exact: true })).toBeHidden();
  await wallpapers.uncheck();
  await expect(stillSky).toBeVisible();
  await expect(stillSky).toBeChecked();
  await stillSky.uncheck();
  const paused = await frames(page);
  await back.click();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await expect.poll(() => frames(page)).toBeGreaterThan(paused + 1);
});

/** The rate governor (src/sky-window.ts `rateSample`): where a painted frame costs tens of milliseconds of main-thread work
 * (a CPU-composited WebKit, #348/#351), the rest and idle rates halve at the same pace. `__sky.forceFrameMs` (preview
 * only) stands in for the measured cost. */
const forceFrameMs = (page: Page, ms: number | null) => page.evaluate(value => { (window as any).__sky.forceFrameMs = value; }, ms);
const halved = (page: Page) => page.evaluate(() => (window as any).__sky.rateHalved as boolean);

test('costly frames halve the rest and idle rates at the shipped pace, and cheap ones bring them back', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await setIdleAfter(page, 1e9);
  await forceFrameMs(page, 40);
  await expect.poll(() => halved(page), { timeout: 5000 }).toBe(true);
  await nextPaint(page);
  const rest = await measure(page, 2500);
  console.log(`costly rest: ${rest.fps.toFixed(2)} fps, ${rest.ratio.toFixed(3)} scene s per wall s`);
  expect(rest.fps, `${rest.fps.toFixed(1)} fps at a costly rest`).toBeGreaterThan(3);
  expect(rest.fps, `${rest.fps.toFixed(1)} fps at a costly rest`).toBeLessThan(5);
  expect(withinTenPercent(rest.ratio, SHIPPED_REST_PACE), `costly rest pace (${rest.ratio.toFixed(3)})`).toBe(true);
  // The idle rate halves too, to the 2 fps floor for the daytime sky's 3.
  await setIdleAfter(page, 0);
  await nextPaint(page);
  const idle = await measure(page, 3500);
  console.log(`costly idle: ${idle.fps.toFixed(2)} fps, ${idle.ratio.toFixed(3)} scene s per wall s`);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps at a costly idle`).toBeGreaterThan(1.5);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps at a costly idle`).toBeLessThan(2.6);
  expect(withinTenPercent(idle.ratio, SHIPPED_REST_PACE), `costly idle pace (${idle.ratio.toFixed(3)})`).toBe(true);
  // Cheap frames again: the rates come back, at the same pace.
  await forceFrameMs(page, 1);
  await expect.poll(() => halved(page), { timeout: 10_000 }).toBe(false);
  await setIdleAfter(page, 1e9);
  await nextPaint(page);
  const back = await measure(page, 2000);
  console.log(`restored rest: ${back.fps.toFixed(2)} fps, ${back.ratio.toFixed(3)} scene s per wall s`);
  expect(back.fps, `${back.fps.toFixed(1)} fps once frames are cheap`).toBeGreaterThan(5);
  expect(withinTenPercent(back.ratio, SHIPPED_REST_PACE), `restored pace (${back.ratio.toFixed(3)})`).toBe(true);
});

test('costly frames keep rain at its 4 fps floor, and a run keeps its rate', async ({ page }) => {
  await open(page, 'rain');
  await forceFrameMs(page, 40);
  await setIdleAfter(page, 0);
  await expect.poll(() => halved(page), { timeout: 5000 }).toBe(true);
  await nextPaint(page);
  const rain = await measure(page, 2500);
  expect(rain.fps, `${rain.fps.toFixed(1)} fps for costly idle rain`).toBeGreaterThan(3);
  expect(rain.fps, `${rain.fps.toFixed(1)} fps for costly idle rain`).toBeLessThan(5);
  expect(withinTenPercent(rain.ratio, SHIPPED_REST_PACE), `costly rain pace ${rain.ratio.toFixed(3)}`).toBe(true);
  // A run churning the transcript keeps its 8 fps cap however costly the frames: streaming rates are untouched.
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  const busy = await measure(page, 1500);
  expect(busy.fps, `${busy.fps.toFixed(1)} fps during a costly run`).toBeGreaterThan(5);
  expect(await slow(page)).toBe(false);
});

test('cheap frames keep the shipped rest and idle rates', async ({ page }) => {
  await open(page);
  // What this renderer measures on its own (logged only: a loaded box can make a real frame look costly).
  await page.waitForTimeout(1500);
  console.log(`measured frame costs: ${(await page.evaluate(() => (window as any).__sky.frameCosts as number[])).map(ms => ms.toFixed(1)).join(', ')}`);
  await forceFrameMs(page, 2);
  await setIdleAfter(page, 1e9);
  await page.waitForTimeout(1200);
  expect(await halved(page)).toBe(false);
  const rest = await measure(page, 2000);
  expect(rest.fps, `${rest.fps.toFixed(1)} fps at a cheap rest`).toBeGreaterThan(5);
  expect(withinTenPercent(rest.ratio, SHIPPED_REST_PACE), `cheap rest pace (${rest.ratio.toFixed(3)})`).toBe(true);
  await setIdleAfter(page, 0);
  await expect.poll(() => slow(page)).toBe(true);
  const idle = await measure(page, 3000);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps at a cheap idle`).toBeGreaterThanOrEqual(2);
  expect(idle.fps, `${idle.fps.toFixed(1)} fps at a cheap idle`).toBeLessThanOrEqual(4);
  expect(await halved(page)).toBe(false);
});

/** Costly paint (src/sky-window.ts `paintVerdict`, #348/#351): frame costs that stay over budget set
 * `html[data-costly-paint]`, and the glass (src/motion.css) takes its solid reduced-transparency fill; a later
 * costly-to-cheap improvement measured with solid fill clears it after a hysteresis. Once settled, the probe stops and samples a fresh burst of 8 frames every 30 s. `__sky.costlyPaintMs`,
 * `cheapPaintMs` and `resampleMs` (preview only) shorten those spans. */
const setSky = (page: Page, values: Record<string, number>) => page.evaluate(entries => { Object.assign((window as any).__sky, entries); }, values);
const costlyPaint = (page: Page) => page.evaluate(() => document.documentElement.hasAttribute('data-costly-paint'));
/** A glass tooltip (`.tip-bubble`), and what the panel token resolves to: the solid fill it takes when paint is costly. */
const glass = (page: Page) => page.evaluate(() => {
  let tip = document.querySelector<HTMLElement>('#costly-paint-tip');
  if (!tip) {
    tip = Object.assign(document.createElement('div'), { id: 'costly-paint-tip', className: 'tip-bubble', textContent: 'Tip' });
    document.body.append(tip);
  }
  const panel = document.createElement('div');
  panel.style.background = 'var(--panel)';
  document.body.append(panel);
  const solid = getComputedStyle(panel).backgroundColor;
  panel.remove();
  const style = getComputedStyle(tip);
  const blurred = [...document.querySelectorAll('*')].filter(el => getComputedStyle(el).backdropFilter !== 'none').length;
  return { filter: style.backdropFilter, background: style.backgroundColor, solid, blurred };
});

/** Background alpha of other glass surfaces (progress pip, Agents dock, goal banner, Codex activity, sidebar row actions),
 * probed with stand-ins placed in the workspace, where their fill tokens are defined. */
const SURFACES = ['button.pp-pill', 'div.pp-card', 'div.agents-dock-popover', 'div.agents-dock-window-panel', 'div.goal-banner', 'div.jev-activity>button', 'div.skill-manager-float'];
const surfaceAlphas = (page: Page) => page.evaluate(specs => {
  const host = document.querySelector('.workspace') ?? document.body;
  const alpha = (color: string): number => {
    const parts = color.match(/[\d.]+/g)?.map(Number) ?? [];
    if (color.startsWith('color(')) return parts.length > 3 ? parts[parts.length - 1] : 1;
    return parts.length > 3 ? parts[3] : parts.length === 3 ? 1 : 0;
  };
  return Object.fromEntries(specs.map(spec => {
    const [outer, inner] = spec.split('>');
    const make = (tagged: string) => { const [tag, cls] = tagged.split('.'); return Object.assign(document.createElement(tag), { className: cls }); };
    const probe = make(outer);
    const target = inner ? probe.appendChild(make(inner)) : probe;
    host.append(probe);
    const value = alpha(getComputedStyle(target).backgroundColor);
    probe.remove();
    return [spec, value];
  }));
}, SURFACES);

test('sustained costly paints turn the glass solid, and a later improvement brings it back', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await setIdleAfter(page, 1e9);
  // Load the lazy progress pip stylesheet before measuring its real glass fill.
  await page.evaluate(async () => { await import('/src/progress-pip.ts'); });
  const before = await glass(page);
  const seeThrough = await surfaceAlphas(page);
  for (const spec of ['button.pp-pill', 'div.agents-dock-popover']) expect(seeThrough[spec], `${spec} is see-through glass on a cheap renderer`).toBeLessThan(1);
  expect(before.filter, 'the glass blurs on a cheap renderer').toContain('blur');
  expect(before.background).not.toBe(before.solid);
  expect(await costlyPaint(page)).toBe(false);
  await setSky(page, { costlyPaintMs: 1500, cheapPaintMs: 1500 });
  await forceFrameMs(page, 40);
  await expect.poll(() => costlyPaint(page), { timeout: 15_000 }).toBe(true);
  const costly = await glass(page);
  expect(costly.filter, 'no blur while paint is costly').toBe('none');
  expect(costly.background, 'the solid reduced-transparency fill').toBe(costly.solid);
  expect(costly.blurred, 'elements still blurring their backdrop').toBe(0);
  const opaque = await surfaceAlphas(page);
  for (const spec of SURFACES) expect(opaque[spec], `${spec} takes a solid fill while paint is costly`).toBe(1);
  // Establish that solid rendering is still costly before the independent renderer improvement.
  await expect.poll(() => page.evaluate(() => (window as any).__sky.solidPaintCost), { timeout: 10_000 }).toBe(40);
  await forceFrameMs(page, 1);
  await expect.poll(() => costlyPaint(page), { timeout: 15_000 }).toBe(false);
  const back = await glass(page);
  expect(back.filter).toContain('blur');
  expect(back.background).toBe(before.background);
  expect(await surfaceAlphas(page), 'the glass surfaces are see-through again').toEqual(seeThrough);
});

test('cheap paints never set costly paint, and the probe goes quiet once settled, sampling a burst now and then', async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    (window as any).__costlyPaintSeen = false;
    new MutationObserver(() => { if (document.documentElement.hasAttribute('data-costly-paint')) (window as any).__costlyPaintSeen = true; })
      .observe(document.documentElement, { attributes: true, attributeFilter: ['data-costly-paint'] });
  });
  await open(page);
  await setIdleAfter(page, 1e9);
  const samples = () => page.evaluate(() => (window as any).__sky.samples as number);
  const settled = () => page.evaluate(() => (window as any).__sky.resampleIn as number > 0);
  // The renderer's own costs settle as well (logged only: a loaded box can make a real frame look costly).
  await page.waitForTimeout(1500);
  console.log(`measured frame costs: ${(await page.evaluate(() => (window as any).__sky.frameCosts as number[])).map(ms => ms.toFixed(1)).join(', ')}; settled: ${await settled()}`);
  await setSky(page, { resampleMs: 3000 });
  await forceFrameMs(page, 2);
  await expect.poll(settled, { timeout: 10_000 }).toBe(true);
  const from = await samples(), paintsFrom = await frames(page);
  await page.waitForTimeout(1500);
  expect(await frames(page), 'the sky keeps painting').toBeGreaterThan(paintsFrom);
  expect(await samples(), 'no samples while settled').toBe(from);
  // The next burst: 8 fresh frames, then quiet again.
  await expect.poll(samples, { timeout: 10_000 }).toBe(from + 8);
  await expect.poll(settled).toBe(true);
  expect(await samples()).toBe(from + 8);
  expect(await page.evaluate(() => (window as any).__costlyPaintSeen as boolean), 'costly paint on a cheap renderer').toBe(false);
  expect(await costlyPaint(page)).toBe(false);
});

test('cheap solid frames cannot repeatedly restore expensive glass', async ({ page }) => {
  test.setTimeout(30_000);
  await open(page);
  await setIdleAfter(page, 1e9);
  await setSky(page, { costlyPaintMs: 300, cheapPaintMs: 300, resampleMs: 300 });
  await page.evaluate(() => {
    const read = (window as any).__sky;
    (window as any).__glassSwitches = [];
    const update = () => {
      const solid = document.documentElement.hasAttribute('data-costly-paint');
      (window as any).__glassSwitches.push(solid);
      read.forceFrameMs = solid ? 1 : 40;
    };
    new MutationObserver(update).observe(document.documentElement, { attributes: true, attributeFilter: ['data-costly-paint'] });
    update();
  });
  await expect.poll(() => costlyPaint(page), { timeout: 10_000 }).toBe(true);
  const from = await frames(page);
  await page.waitForTimeout(6500);
  expect(await page.evaluate(() => (window as any).__glassSwitches)).toEqual([false, true]);
  expect(await frames(page), 'solid fallback keeps the sky moving').toBeGreaterThan(from);
  expect((await glass(page)).filter).toBe('none');
});

test('a later sustained costly solid period, then sustained cheap solid frames, bring the glass back', async ({ page }) => {
  test.setTimeout(60_000);
  await open(page);
  await setIdleAfter(page, 1e9);
  await setSky(page, { costlyPaintMs: 2500, cheapPaintMs: 600, resampleMs: 300 });
  const solidCost = () => page.evaluate(() => (window as any).__sky.solidPaintCost as number | null);
  await forceFrameMs(page, 40);
  await expect.poll(() => costlyPaint(page), { timeout: 15_000 }).toBe(true);
  // The first solid frames are cheap: that only shows the fallback helped, so the probe settles and nothing recovers.
  await forceFrameMs(page, 1);
  await expect.poll(() => page.evaluate(() => (window as any).__sky.resampleIn as number), { timeout: 10_000 }).toBeGreaterThan(0);
  await page.waitForTimeout(1500);
  expect(await costlyPaint(page)).toBe(true);
  expect(await solidCost()).toBeNull();
  // A spike shorter than the costly sustain is no evidence either.
  await forceFrameMs(page, 40);
  await page.waitForTimeout(2000);
  await forceFrameMs(page, 1);
  await page.waitForTimeout(1500);
  expect(await solidCost(), 'a short costly spike is not recovery evidence').toBeNull();
  expect(await costlyPaint(page)).toBe(true);
  // Solid frames that stay costly for the whole sustain, then stay cheap for the hysteresis, restore the glass.
  await forceFrameMs(page, 40);
  await expect.poll(solidCost, { timeout: 15_000 }).toBe(40);
  expect(await costlyPaint(page), 'still solid while solid frames are costly').toBe(true);
  await forceFrameMs(page, 1);
  await expect.poll(() => costlyPaint(page), { timeout: 15_000 }).toBe(false);
  expect((await glass(page)).filter).toContain('blur');
  expect(await solidCost(), 'the evidence is spent once glass is back').toBeNull();
});
