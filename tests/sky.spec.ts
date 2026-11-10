import { expect, test, type Page } from '@playwright/test';
import { readdirSync, readFileSync } from 'node:fs';

/** The thread is a window onto a live scene (src/sky-window.ts, src/scenes/) while Wallpapers is off, which is the
 * default. Host behaviour is checked on the sky; readability runs for every registered scene (`?scene=<id>`). */
const sceneDir = new URL('../src/scenes/', import.meta.url);
const SCENE_IDS = readdirSync(sceneDir).filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(new URL(name, sceneDir), 'utf8')).filter(source => /export const scene\b/.test(source))
  .map(source => source.match(/\bid:\s*'([^']+)'/)![1]).sort();
const sky = (page: Page) => page.locator('.thread-sky');
const frames = (page: Page) => page.evaluate(() => (window as any).__sky.frames as number);

async function open(page: Page, time = '12:00', theme: 'light' | 'dark' = 'light', scene = 'sky'): Promise<void> {
  await page.addInitScript(value => localStorage.setItem('pandacode.theme', value), theme);
  await page.goto(`/?sky=${time}&scene=${scene}`);
  await expect(page.locator('#prompt')).toBeEnabled();
  await expect(page.locator('#transcript .message').first()).toBeVisible();
}

test('the sky is the default scene and the Wallpapers switch starts off', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toBeVisible();
  await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'sky');
  await expect(page.locator('.workspace')).not.toHaveAttribute('data-wallpaper');
  // The sky sits behind the conversation inside the main pane, never over the sidebar, and takes no input.
  const [layer, pane] = await Promise.all([sky(page).boundingBox(), page.locator('.main-pane').boundingBox()]);
  expect(layer).toEqual(pane);
  await expect(sky(page)).toHaveCSS('pointer-events', 'none');
  await expect(sky(page)).toHaveAttribute('aria-hidden', 'true');
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Appearance', exact: true }).click();
  const toggle = page.getByRole('checkbox', { name: 'Wallpapers', exact: true });
  await expect(toggle).not.toBeChecked();
  // Settings covers the thread: the sky pauses.
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  // The Custom swatch is a hue wheel until a custom colour is picked, never a copy of Blue.
  await expect(page.locator('.accent-custom .accent-swatch')).toHaveClass(/accent-swatch-pick/);
  const builtIn = page.locator('.vsix-choice[data-theme-id=""] small');
  await expect(builtIn).toHaveText('Built in · your accent, over the sky');
  await toggle.check();
  await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'wallpaper');
  await expect(sky(page)).toBeHidden();
  // The theme and accent rows follow the switch at once.
  await expect(builtIn).toHaveText('Built in · accent and wallpaper apply');
  await toggle.uncheck();
  await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'sky');
  await expect(builtIn).toHaveText('Built in · your accent, over the sky');
});

test('a running agent raises the wind smoothly and lets it fall again', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-wind', '0');
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  // Eased over about a second, never a jump.
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind'))).toBeGreaterThan(0);
  const early = Number(await sky(page).getAttribute('data-wind'));
  expect(early).toBeLessThan(.9);
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBeGreaterThan(.97);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await page.locator('#transcript').evaluate(node => node.removeAttribute('data-running'));
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBe(0);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

test('the sky pauses while the document is hidden and resumes when shown', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  const hide = (hidden: boolean) => page.evaluate(value => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => value });
    document.dispatchEvent(new Event('visibilitychange'));
  }, hidden);
  await hide(true);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  const before = await frames(page);
  await page.waitForTimeout(600);
  expect(await frames(page)).toBe(before);
  await hide(false);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await expect.poll(() => frames(page)).toBeGreaterThan(before);
});

test('the sky pauses in the board and GitHub views and resumes in the conversation', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  for (const view of ['Board', 'GitHub']) {
    await page.getByRole('button', { name: /^Workspace view: / }).click();
    await page.getByRole('menuitemradio', { name: view, exact: true }).click();
    await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
    await expect(page.locator('.workspace')).not.toHaveAttribute('data-scene');
    const before = await frames(page);
    await page.waitForTimeout(600);
    expect(await frames(page), `no paints in ${view}`).toBe(before);
  }
  await page.getByRole('button', { name: /^Workspace view: / }).click();
  await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'sky');
});

test('the pointer over a message or the composer leaves the clouds alone', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  const box = (await page.locator('#composer').boundingBox())!;
  await page.mouse.move(box.x + 40, box.y + 20); await page.mouse.move(box.x + 120, box.y + 30, { steps: 6 });
  await page.waitForTimeout(200);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

test('the wind starts on the frame the run starts', async ({ page }) => {
  await open(page);
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving', { timeout: 100 });
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 150, intervals: [16] }).toBeGreaterThan(0);
});

test('at rest the sky paints at a low frame rate, and reduced motion leaves one still frame', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  const start = await frames(page);
  await page.waitForTimeout(2000);
  const idle = (await frames(page)) - start;
  expect(idle).toBeGreaterThan(4);
  expect(idle).toBeLessThanOrEqual(20);
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  const still = await frames(page);
  await page.mouse.move(600, 400); await page.mouse.move(700, 450, { steps: 5 });
  await page.waitForTimeout(800);
  expect(await frames(page)).toBe(still);
  await expect(sky(page)).toHaveAttribute('data-wind', '0');
});

test('the governor drops the render scale under long paints and restores it after a quiet stretch', async ({ page }) => {
  await open(page);
  const scale = () => page.evaluate(() => (window as any).__sky.scale as number);
  expect(await scale()).toBe(.6);
  // The wind keeps the loop at 30 fps, so 30 samples arrive in about a second.
  await page.locator('#transcript').evaluate(node => node.setAttribute('data-running', ''));
  await page.evaluate(() => { (window as any).__sky.quietMs = 400; (window as any).__sky.forcePaintMs = 20; });
  await expect.poll(scale, { timeout: 5000 }).toBe(.45);
  // Still slow: it stays down.
  await page.waitForTimeout(1500);
  expect(await scale()).toBe(.45);
  await page.evaluate(() => { (window as any).__sky.forcePaintMs = 1; });
  await expect.poll(scale, { timeout: 5000 }).toBe(.6);
});

/* There is deliberately no "a reader hold never feeds the paint cost" test here. The governor samples one path only: with
 * `timing` 'frame' it reads the rAF interval of a frame (`onFrame`, src/sky-window.ts), so a hold is invisible to it by
 * construction — the timer that ends a hold is not a frame, and the loop only runs on rAF while the pointer stirs the
 * clouds. To put a wait in front of `sample()` at all, a test has to drive that rAF burst, and there the share of the
 * budget the sampled frames spend is the box's own paint speed: on this suite's renderer, with the pointer stirring (rAF,
 * `timing` 'frame'), the sky painted at ~11 fps and the governor took the scale to .45 — the right answer for a paint that
 * misses the budget, not the regression. A spec asserting the scale stays up would be asserting that the machine paints
 * inside 8 ms, and a spec that stays off the sampled path (a 30 fps wind timer, `onFrame` false) cannot fail however the
 * hold is broken. What a hold does is covered by the hold tests below: no paint inside its window, and a resume after it.
 */
test('the pointer over the sky stirs the clouds without taking clicks, focus or selection', async ({ page }) => {
  await open(page);
  await page.locator('#prompt').focus();
  const start = await frames(page);
  await page.mouse.move(700, 600); await page.mouse.move(760, 640, { steps: 6 });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await expect.poll(() => frames(page)).toBeGreaterThan(start + 3);
  await expect(page.locator('#prompt')).toBeFocused();
  // Once the pointer rests, the clouds settle and the loop drops back to the idle rate within about a second.
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle', { timeout: 1500 });
  expect(await page.evaluate(() => (window as any).__sky.scale)).toBeGreaterThan(0);
  // Text under the pointer stays selectable (a word near the start: the box's centre can fall on a space).
  const message = page.locator('#transcript .message-content').first();
  await message.dblclick({ position: { x: 40, y: 14 } });
  expect(await page.evaluate(() => getSelection()?.toString().trim().length ?? 0)).toBeGreaterThan(0);
});

/** Reader input holds the sky (`hold` in src/sky-window.ts): the canvas is the backdrop of the whole transcript, so every
 * frame it paints makes the compositor redo the region above it. The hold only defers the loop by `HOLD_MS` after the last
 * reader event — a wheel, a touch drag or a press on the transcript, a keystroke or text input in the composer — it never
 * stops it. It does not hand the scene the elapsed time back either: `dt` is clamped at .1 s, so a hold longer than 100 ms
 * (every hold `HOLD_MS` = 150 arms) is dropped, and the clouds resume where they were, .1 s further on, never jumped. */
const HOLD_MS = 150;
/** The seeded thread is one bubble and a folded card, shorter than any pane: a tall row stands in for the long thread a
 * reader scrolls and a run pins to the bottom. It is appended to the scroller itself, so `main.ts`'s pin (which re-pins on
 * a childList outside the transcript) leaves the scroll to the test. */
async function lengthenThread(page: Page): Promise<void> {
  await page.locator('#transcript').evaluate(node => {
    const long = document.createElement('div');
    long.id = 'sky-hold-filler';
    long.style.height = '1200px';
    node.append(long);
  });
}
/** Gap between the bottom of the transcript and its last content, the distance `main.ts`'s own pins leave (~0). */
const gapFromBottom = (page: Page) => page.locator('#transcript')
  .evaluate(node => Math.round(node.scrollHeight - node.scrollTop - node.clientHeight));

/** Measured, not assumed: text colours against the darkest and lightest pixel behind each element, with the text hidden. */
async function worstContrast(page: Page, selectors: string[], inset = 0): Promise<{ selector: string; ratio: number }[]> {
  const targets = await page.evaluate(([list, inset]) => list.flatMap(selector => [...document.querySelectorAll<HTMLElement>(selector)]
    .filter(node => node.checkVisibility({ contentVisibilityAuto: true, visibilityProperty: true }) && node.getBoundingClientRect().height > 0).slice(0, 3)
    .map(node => {
      // Only the part on screen: text in the transcript is clipped above the composer.
      const box = node.getBoundingClientRect(), clip = node.closest('#transcript')?.getBoundingClientRect();
      const composer = document.querySelector('#composer-area')!.getBoundingClientRect();
      const top = Math.max(box.top, clip?.top ?? 0), bottom = Math.min(box.bottom, clip ? Math.min(clip.bottom, composer.top) : box.bottom);
      // `inset` keeps a pill's own rounded corners (sky behind no text) out of the sample.
      return { selector, color: getComputedStyle(node).color, box: { x: box.x + inset, y: top + inset, width: box.width - 2 * inset, height: Math.max(0, bottom - top - 2 * inset) } };
    }).filter(item => item.box.height > 4)), [selectors, inset] as const);
  await page.addStyleTag({ content: '*,*::placeholder{color:transparent !important;-webkit-text-fill-color:transparent !important;caret-color:transparent !important} svg{visibility:hidden}' });
  await page.waitForTimeout(300);
  const shot = (await page.screenshot()).toString('base64');
  return page.evaluate(async ([data, items]) => {
    const image = new Image(); image.src = `data:image/png;base64,${data}`; await image.decode();
    const canvas = document.createElement('canvas'); canvas.width = image.width; canvas.height = image.height;
    const context = canvas.getContext('2d')!; context.drawImage(image, 0, 0);
    const scale = image.width / innerWidth;
    const lin = (c: number) => { c /= 255; return c <= .04045 ? c / 12.92 : ((c + .055) / 1.055) ** 2.4; };
    const lum = (r: number, g: number, b: number) => .2126 * lin(r) + .7152 * lin(g) + .0722 * lin(b);
    const probe = document.createElement('canvas').getContext('2d')!;
    return items.map(({ selector, color, box }) => {
      probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
      const [r, g, b] = probe.getImageData(0, 0, 1, 1).data;
      const text = lum(r, g, b);
      const pixels = context.getImageData(Math.round(box.x * scale), Math.round(box.y * scale), Math.max(1, Math.round(box.width * scale)), Math.max(1, Math.round(box.height * scale))).data;
      let worst = Infinity;
      for (let i = 0; i < pixels.length; i += 4) {
        const y = lum(pixels[i], pixels[i + 1], pixels[i + 2]);
        worst = Math.min(worst, (Math.max(y, text) + .05) / (Math.min(y, text) + .05));
      }
      return { selector, ratio: Math.round(worst * 100) / 100 };
    });
  }, [shot, targets] as const);
}

type HoldWindow = { from: number; to: number; took: number };
type PartingSample = { at: number; frames: number; amt: number; vel: number; target: number };
/** Open a window in the page on each reader input of `type` and record the frames it paints. The window is opened and
 * closed in the page, so no round trip can stretch it: it opens on the reader's own event (the one that arms the hold) and
 * closes at two thirds of HOLD_MS (100 ms). Every window is recorded, counted or not: one whose close the box stalled past
 * HOLD_MS less 5 ms ended outside the hold, so it says nothing either way and `expectHeld` drops it and names the stall. */
async function monitorHold(page: Page, selector: string, type: 'wheel' | 'keydown'): Promise<void> {
  await page.evaluate(([selector, type, holdMs]) => {
    const read = window as any;
    read.__hold = [];
    document.querySelector(selector)!.addEventListener(type, () => {
      if (read.__hold.length >= 40) return;
      const from = read.__sky.frames, at = performance.now();
      window.setTimeout(() => {
        const to = read.__sky.frames, took = Math.round(performance.now() - at);
        read.__hold.push({ from, to, took });
      }, holdMs * 2 / 3);
    }, { capture: true, passive: true });
  }, [selector, type, HOLD_MS] as const);
}
const holdWindows = (page: Page) => page.evaluate(() => (window as any).__hold as HoldWindow[]);
/** A window only speaks about the hold when its close landed inside it: HOLD_MS less 5 ms is the latest it can. */
const insideHold = (window: HoldWindow): boolean => window.took <= HOLD_MS - 5;
/** Why no window could be counted, for the failure message: a stalled timer, or no reader event at all. */
const stallReport = (windows: HoldWindow[]): string => windows.length
  ? `every probe closed late (${windows.slice(0, 3).map(window => `${window.took} ms of ${HOLD_MS} ms`).join(', ')}): the box stalled the timer past the hold`
  : 'no reader event reached the probe at all';
/** The hold only defers frames, so a window that closed inside it must contain no paint at all. A box too loaded to close
 * the 100 ms probe inside the 150 ms hold cannot say either way, so those windows are dropped and the reader's own
 * sequence is replayed, up to `rounds` times, until one lands — a loaded box then reports itself (`stallReport`) instead
 * of failing as "0 windows". Retrying cannot fake a pass: a missing hold does not stall the probe, it paints inside the
 * first window it opens, so the very first round fails. */
async function expectHeld(page: Page, what: string, run: () => Promise<void>, rounds = 3): Promise<HoldWindow[]> {
  let counted: HoldWindow[] = [], last: HoldWindow[] = [];
  for (let round = 0; round < rounds; round++) {
    await page.evaluate(() => { (window as any).__hold = []; });
    await run();
    last = await holdWindows(page);
    counted = last.filter(insideHold);
    if (counted.length) break;
  }
  expect(counted.length, `the ${what} reached the app, and the sky held for it: ${stallReport(last)}`).toBeGreaterThan(0);
  for (const window of counted) expect(window.to, `no paint ${window.took} ms into the ${HOLD_MS} ms hold a ${what} opens`).toBe(window.from);
  return counted;
}

test('the reader scrolling the transcript or typing in the prompt holds the sky, which resumes after the hold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  await lengthenThread(page);
  const transcript = page.locator('#transcript');
  expect(await transcript.evaluate(node => node.scrollHeight - node.clientHeight), 'the thread scrolls').toBeGreaterThan(200);
  // The reader at the top of a long thread, wheeling down through it. The hold reads the reader's intent off the event
  // (the wheel), not off the scroll position, so it does not matter where the transcript comes to rest.
  await transcript.evaluate(node => { node.scrollTop = 0; });
  const rest = await gapFromBottom(page);
  expect(rest, 'the thread has a way to scroll').toBeGreaterThan(200);
  // Over the reader's own bubble, which is a READABLE surface: the pointer never stirs the clouds, so the hold is the
  // only thing keeping frames off.
  const message = (await page.locator('#transcript .message').first().boundingBox())!;
  await page.mouse.move(message.x + 30, message.y + message.height / 2);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');

  // The reader scrolls while a run streams: the wind has the sky painting at 30 fps, so a window the hold does not cover
  // has frames in it, and the scroll must stop even the wind.
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  // The window opens on the wheel itself — the reader's intent, and the event the hold answers — so it starts where the
  // hold is armed; a scroll event can follow the wheel tens of milliseconds later on a busy frame.
  await monitorHold(page, '#transcript', 'wheel');
  const scrolling = await expectHeld(page, 'wheel scroll', async () => {
    for (let notch = 0; notch < 4; notch++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
  });
  const scrolledTo = await gapFromBottom(page);
  expect(scrolledTo, 'the wheel scrolled the transcript').toBeLessThan(rest);
  // The hold only defers the loop: with the reader's hand off it, the run's wind falls away again.
  await transcript.evaluate(node => node.removeAttribute('data-running'));
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBe(0);
  await expect(sky(page), 'the hold never leaves the sky saying it moved').toHaveAttribute('data-sky-state', 'idle');

  // The same for real keystrokes in the prompt: `keydown` and `input` each arm the hold.
  await page.locator('#prompt').click();
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await monitorHold(page, '#prompt', 'keydown');
  const typing = await expectHeld(page, 'keystroke', async () => { await page.keyboard.type('a swift grey fox', { delay: 40 }); });
  await expect(sky(page), 'the hold never leaves the sky saying it moved').not.toHaveAttribute('data-sky-state', 'moving');
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(typing.at(-1)!.from);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  expect(await page.locator('#prompt').inputValue()).toContain('a swift grey fox');
});

/* The resumed frame after a hold longer than `dt`'s .1 s clamp. `step` now integrates that spanned time in substeps of at
 * most 1/60 s, which is what keeps the springs inside their design range: before that, one .1 s Euler step drove the
 * pointer-parting spring (`pointer.amt`, contract 0..1, `u_ptrAmt` in src/scenes/*) to ~2.8 from rest and inverted its
 * velocity mid-ramp. What this test can pin from outside is the part of that which is observable: no paint inside the hold,
 * one tick's paint at a time after it (never a catch-up burst), `data-wind` inside its own 0..1 range on every sampled
 * frame, and a state that never leaves idle/moving. The parting spring's own amount is not among those observables — a
 * WebGL frame is not a stable pixel comparison (drift, dpr, driver) — so it is pinned by the next test instead, off
 * `__sky.ptrAmt`/`ptrVel`/`ptrTarget` (preview only): `a resumed frame steps the pointer parting in substeps …` asserts
 * the 0..1 contract and the per-frame step on every frame across the same resume. This one stays with what the frame
 * counter and the layer's data attributes say, and so holds at any frame rate. */
test('a long hold resumes the sky one frame at a time, with every observable amount inside its range', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  await lengthenThread(page);
  const transcript = page.locator('#transcript');
  await transcript.evaluate(node => { node.scrollTop = 0; });
  // The pointer over the bare sky (not over a readable surface), so the parting spring is live and the loop holds 60 fps;
  // a run, so the wind spring is live too. The frame below therefore integrates both springs across a wait past the clamp.
  await page.mouse.move(700, 600); await page.mouse.move(760, 640, { steps: 6 });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBeGreaterThan(.9);
  await page.waitForTimeout(200);
  const timeline = await page.evaluate(async (holdMs: number) => {
    const read = window as any, layer = document.querySelector('.thread-sky') as HTMLElement, scroller = document.querySelector('#transcript')!;
    const sample = () => ({ frames: read.__sky.frames as number, wind: Number(layer.dataset.wind), state: String(layer.dataset.skyState) });
    const from = sample(), start = performance.now(), samples: { at: number; frames: number; wind: number; state: string }[] = [];
    // Arm the hold on the reader's own event, then flip the run off inside it: the resumed frame is then the one frame that
    // integrates the wind falling from 1 across the whole wait, the largest step the .1 s clamp ever allows.
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
    scroller.removeAttribute('data-running');
    while (performance.now() - start < holdMs + 220) {
      await new Promise(resolve => requestAnimationFrame(resolve));
      samples.push({ at: Math.round(performance.now() - start), ...sample() });
    }
    return { from, samples };
  }, HOLD_MS);
  const held = timeline.samples.filter(point => point.at < HOLD_MS - 20);
  expect(held.length, 'the hold was sampled while it lasted').toBeGreaterThan(2);
  for (const point of held) expect(point.frames, `no paint ${point.at} ms into the ${HOLD_MS} ms hold`).toBe(timeline.from.frames);
  // The frames after it: one tick's paint per sampled animation frame (two only when a timer tick and a rAF tick land between
  // two samples), and no burst — a loop that replayed the held time as extra frames would paint far more than the 60 fps the
  // span allows.
  const resumed = timeline.samples.filter(point => point.at >= HOLD_MS - 20);
  expect(resumed.length, 'the resume was sampled').toBeGreaterThan(3);
  const span = resumed.at(-1)!.at - resumed[0].at, paints = resumed.at(-1)!.frames - timeline.from.frames;
  expect(paints, 'the sky resumed and painted after the hold').toBeGreaterThan(0);
  expect(paints, `no catch-up burst on resume: ${paints} paints in ${span} ms`).toBeLessThanOrEqual(Math.ceil(span / 16) + 2);
  let previous = timeline.from.frames;
  for (const point of resumed) {
    expect(point.frames - previous, `at most one tick's paint between two sampled frames (${point.at} ms)`).toBeLessThanOrEqual(2);
    previous = point.frames;
    // `wind` is an amount, 0..1, and `data-wind` is its tenths: a resumed frame that integrated the wait as one step, or ran
    // its substeps without dividing `dt` between them, carries it out of that range here.
    expect(point.wind, `wind ${point.wind} at ${point.at} ms stays in 0..1`).toBeGreaterThanOrEqual(0);
    expect(point.wind, `wind ${point.wind} at ${point.at} ms stays in 0..1`).toBeLessThanOrEqual(1);
    expect(['idle', 'moving'], `state ${point.state} at ${point.at} ms`).toContain(point.state);
  }
});

/** The parting spring's contract (0..1, `ptrAmt` in src/scenes/types.ts) and the two other bounds the resumed frame is held
 * to; each is derived in the docblock below. */
const PARTING_SLACK = .02, PARTING_JUMP = .75, PARTING_VELOCITY = 8;

/* The invariant the substepped resume exists for, stated as the reviewers stated it: the parting amount stays inside 0..1
 * and never moves further between two frames than the substeps of a clamped `dt` can move it.
 *
 * The scenario is built so that the resumed frame is the frame that first steps the spring, from rest and with the pointer
 * holding it at full: the mouse is parked on a message (a READABLE surface) up to the wheel, so `step`'s settle reset has
 * `pointer.amt` and its velocity at exactly 0 with `target` 0; the wheel on the transcript arms the hold; and the mouse
 * then arrives over the bare sky *inside* the hold. `move` only sets `target = 1` (and `wake` returns on `holding()`), so
 * nothing steps and nothing paints before the resume — and `last`, the clock `dt` is measured from, still holds the
 * pre-hold paint, because the arrival takes the `holding()` path rather than `schedule()`, which zeroes it. The resumed
 * frame therefore carries the whole hold as `dt` clamped at .1 s, with `target` 1 (the arrival is under ~130 ms old at the
 * resume, well inside the 350 ms the pointer rests before `step` drops it).
 *
 * From rest that single .1 s Euler step lands `amt` at 2.8 (k = 280, c = 33: 280 * .1 * .1), and the six substeps of
 * 1/60 s that `step` actually runs land it at .5762. Tolerances, chosen around those two numbers:
 *  - the amount, `1 + PARTING_SLACK` = 1.02: the rising branch is a hair underdamped (c = 33 against 2 * sqrt(280) = 33.5),
 *    so a legitimate frame can cross 1 by a few parts in a thousand, while the un-substepped step is 2.8, a hundred times
 *    further out;
 *  - the change between two samples, PARTING_JUMP = .75 per paint: the fastest substep of that resume moves `amt` .1115
 *    (measured over the six: .0778, .1067, .1115, .1049, .0938, .0815), so six of them move it .5762, and a sampled
 *    animation frame can straddle one further 60 fps tick (+.07, a single 1/60 s step) — .65 at the very worst, while the
 *    un-substepped step moves it 2.8 and even a mid-ramp inversion moves it ~.9. The bound counts the paints the interval
 *    contains (at most two), because a box loaded enough to starve rAF legitimately lands two ticks between two samples
 *    (this suite runs with 4 workers, each painting a WebGL sky);
 *  - the velocity, PARTING_VELOCITY = 8: the same substep table peaks at 6.687, and one .1 s step from rest inverts it to
 *    28, which is the "inverted velocity mid-ramp" a reader would see as a snap.
 * The peak amount after the resume is also checked (> .5): a resumed frame that dropped the hold's time (`dt` 0) would
 * leave `amt` at 0 and pass every bound above, so the test has to see the spring actually step. */
test('a resumed frame steps the pointer parting in substeps, so its amount stays in 0..1 across a reader hold', async ({ page }) => {
  test.slow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  // The pointer parked on a message: a READABLE surface, so the parting stays at rest and the settled spring is reset to 0.
  const message = (await page.locator('#transcript .message').first().boundingBox())!;
  await page.mouse.move(message.x + 30, message.y + message.height / 2);
  await expect.poll(() => page.evaluate(() => (window as any).__sky.ptrAmt as number), { message: 'the parting spring is at rest' }).toBe(0);
  expect(await page.evaluate(() => (window as any).__sky.ptrVel), 'the parting spring is at rest').toBe(0);
  expect(await page.evaluate(() => (window as any).__sky.ptrTarget), 'the pointer is on a readable surface').toBe(0);
  // The wheel arms the hold, and the sampler starts, in the same task, so `at` 0 is the hold's own start; the sampler then
  // lives in the page (one round trip inside the hold would otherwise cost the arrival), and so does the arrival's own
  // clock, taken on the event rather than on a sampled frame, which a starved rAF chain could put late.
  await page.evaluate((holdMs: number) => {
    const read = window as any, scroller = document.querySelector('#transcript')!, pane = document.querySelector('.main-pane')!;
    read.__parting = { from: read.__sky.frames as number, start: performance.now(), arrivalAt: 0, samples: [] as PartingSample[] };
    pane.addEventListener('pointermove', () => {
      if (!read.__parting.arrivalAt) read.__parting.arrivalAt = Math.round(performance.now() - read.__parting.start);
    }, { capture: true, once: true });
    const sample = (): void => {
      const parting = read.__parting, at = Math.round(performance.now() - parting.start);
      parting.samples.push({ at, frames: read.__sky.frames as number, amt: read.__sky.ptrAmt as number, vel: read.__sky.ptrVel as number, target: read.__sky.ptrTarget as number });
      if (at < holdMs + 1200) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
    scroller.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 120 }));
  }, HOLD_MS);
  // The mouse arrives over the open sky inside the hold: real input, and only `target` moves.
  await page.mouse.move(760, 640);
  await page.waitForTimeout(HOLD_MS + 1300);
  const { from, samples, arrivalAt } = await page.evaluate(() => (window as any).__parting) as { from: number; samples: PartingSample[]; arrivalAt: number };
  const arrived = samples.find(point => point.target > 0);
  expect(arrived, 'the mouse reached the open sky (not a measured or readable surface)').toBeTruthy();
  expect(arrivalAt, 'the mouse arrived inside the hold, so the resumed frame is the one that first steps the spring')
    .toBeGreaterThan(0);
  expect(arrivalAt, `the mouse arrived ${arrivalAt} ms into the ${HOLD_MS} ms hold: too late to be the resumed frame's input`)
    .toBeLessThan(HOLD_MS - 20);
  // The hold only defers the loop: nothing painted and nothing stepped inside it, so the resume starts from rest.
  const held = samples.filter(point => point.at < HOLD_MS - 20);
  expect(held.length, 'the hold was sampled while it lasted').toBeGreaterThan(2);
  for (const point of held) {
    expect(point.frames, `no paint ${point.at} ms into the ${HOLD_MS} ms hold`).toBe(from);
    expect(point.amt, `no step ${point.at} ms into the ${HOLD_MS} ms hold`).toBe(0);
  }
  const resumed = samples.filter(point => point.at >= HOLD_MS - 20);
  expect(samples.length, 'the hold and the resume were sampled').toBeGreaterThan(3);
  expect(resumed.length, `the resume was sampled (${samples.length} samples in all)`).toBeGreaterThan(2);
  expect(resumed[0].target, 'the pointer was already parting the clouds when the hold ended').toBe(1);
  expect(resumed.at(-1)!.frames, 'the sky resumed and painted after the hold').toBeGreaterThan(from);
  const peak = Math.max(...resumed.map(point => point.amt));
  expect(peak, `the resumed frame stepped the spring (peak amt ${peak}): the held .1 s reached it`).toBeGreaterThan(.5);
  // Every sampled frame, the resume included, keeps the amount in the range the scenes draw with (~2.8 un-substepped) and
  // the velocity inside the one the substeps themselves reach (~28 un-substepped).
  for (const point of samples) {
    expect(point.amt, `amt ${point.amt} at ${point.at} ms stays in 0..1`).toBeGreaterThanOrEqual(0);
    expect(point.amt, `amt ${point.amt} at ${point.at} ms stays in 0..1`).toBeLessThanOrEqual(1 + PARTING_SLACK);
    expect(Math.abs(point.vel), `vel ${point.vel} at ${point.at} ms stays within the substeps' own peak`).toBeLessThanOrEqual(PARTING_VELOCITY);
  }
  // No single frame jumps: between two samples, the change is at most the six-substep step (the .1 s resume's ~.58) for
  // every paint in the interval (two at most: the resume's, and one 60 fps tick more), so a box that starved rAF for a frame
  // or two is not mistaken for a jump — while the amount's whole range is 0..1, so even a badly starved interval stays in.
  for (let i = 1; i < samples.length; i++) {
    const change = Math.abs(samples[i].amt - samples[i - 1].amt);
    const paints = Math.min(2, Math.max(1, samples[i].frames - samples[i - 1].frames));
    expect(change, `amt ${samples[i - 1].amt} -> ${samples[i].amt} between ${samples[i - 1].at} and ${samples[i].at} ms is ${paints} frame(s) of stepping`)
      .toBeLessThanOrEqual(PARTING_JUMP * paints);
  }
});

test('the reader scrolling the side thread holds the sky, which resumes after the hold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  // A real side thread: `/btw` in the main prompt opens the panel in the inspector and its log there, an opaque panel
  // (`--panel-surface`) over the same main pane. No sky shows behind it; its scrolls hold that pane's sky all the same.
  const prompt = page.locator('#prompt');
  await prompt.fill('/btw what does the index cost?');
  await prompt.press('Enter');
  const sideLog = page.locator('.btw-transcript');
  await expect(sideLog).toBeVisible();
  await expect(page.locator('.btw-head small')).toHaveText(/^Ready/);
  // A tall row in the side scroller, as `lengthenThread` gives the transcript: the seeded answer is shorter than the panel.
  await sideLog.evaluate(node => {
    const long = document.createElement('div');
    long.style.height = '1200px';
    node.append(long);
  });
  expect(await sideLog.evaluate(node => node.scrollHeight - node.clientHeight), 'the side thread scrolls').toBeGreaterThan(200);
  await sideLog.evaluate(node => { node.scrollTop = 0; });
  // The wind has the sky painting at 30 fps, so a window the hold does not cover has frames in it.
  const transcript = page.locator('#transcript');
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');

  const box = (await sideLog.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await monitorHold(page, '.btw-transcript', 'wheel');
  const scrolling = await expectHeld(page, 'side-thread wheel scroll', async () => {
    for (let notch = 0; notch < 4; notch++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
  });
  expect(await sideLog.evaluate(node => node.scrollTop), 'the wheel scrolled the side thread').toBeGreaterThan(0);
  // The hold only defers the loop: with the reader's hand off it, the wind falls away and frames come back.
  await transcript.evaluate(node => node.removeAttribute('data-running'));
  await page.mouse.move(4, 4);
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(scrolling.at(-1)!.to);
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBe(0);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

test('the reader typing in the side thread holds the sky, which resumes after the hold', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  // A real side thread, opened the way the scroll test above opens it: `/btw` in the main prompt puts the panel and its log
  // in the inspector, an opaque `--panel-surface` panel over the same main pane — no sky shows behind it, and its keystrokes
  // hold that pane's sky all the same.
  const prompt = page.locator('#prompt');
  await prompt.fill('/btw what does the index cost?');
  await prompt.press('Enter');
  const sideLog = page.locator('.btw-transcript');
  await expect(sideLog).toBeVisible();
  await expect(page.locator('.btw-head small')).toHaveText(/^Ready/);
  // The wind has the sky painting at 30 fps, so a window the hold does not cover has frames in it.
  const transcript = page.locator('#transcript');
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');

  // Real keystrokes in the side composer: `keydown` and the `input` that follows each arm the hold, like the main prompt.
  const input = page.locator('.btw-input');
  await input.click();
  await expect(input).toBeFocused();
  await monitorHold(page, '.btw-input', 'keydown');
  const typing = await expectHeld(page, 'keystroke in the side composer', async () => { await page.keyboard.type('a swift grey fox', { delay: 40 }); });
  expect(await input.inputValue(), 'the keystrokes reached the side composer').toContain('a swift grey fox');
  // The hold only defers the loop: with the reader's hand off it, the wind falls away and frames come back.
  await transcript.evaluate(node => node.removeAttribute('data-running'));
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(typing.at(-1)!.from);
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBe(0);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
});

test('a run keeps its wind while the app pins the transcript to the bottom', async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  await lengthenThread(page);
  const transcript = page.locator('#transcript');
  expect(await transcript.evaluate(node => node.scrollHeight - node.clientHeight), 'the thread scrolls').toBeGreaterThan(200);
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  const start = await frames(page);
  // `main.ts` pins the transcript to the bottom on every frame of output (`followTranscript`, `stickTranscript`,
  // `settleIn`), and the sky reads reader intent off the input events, never off a scroll position: those scrolls are the
  // app's and must hold nothing, or a streaming run — the one thing that drives the wind — would freeze it. Each pin here
  // follows a row of new output and then writes the same bottom those three write, eight times over ~800 ms.
  for (let pin = 0; pin < 8; pin++) {
    const gap = await transcript.evaluate(node => {
      const row = document.createElement('div');
      row.style.height = '40px';
      node.append(row);
      node.scrollTop = node.scrollHeight;
      return Math.round(node.scrollHeight - node.scrollTop - node.clientHeight);
    });
    expect(gap, 'the pin lands at the bottom').toBe(0);
    await page.waitForTimeout(100);
  }
  // The wind paints straight through the pinned scrolls: ~30-44 frames over the ~800 ms here, against ~6 for a hold that
  // answers the app's own scrolls, so 12 leaves room for a loaded box and still catches the regression.
  expect((await frames(page)) - start, 'the pinned run still paints frames').toBeGreaterThan(12);
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBeGreaterThan(.9);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
});

test('over the sky the glass is a plain fill, and only the header keeps its halo', async ({ page }) => {
  await open(page);
  await expect(sky(page)).toHaveAttribute('data-gl', '');
  // The two surfaces this material is built on. The composer is read inside #composer-area, where the sky rule lands; a
  // `none` on an element that never had a blur would pin nothing.
  const composer = page.locator('#composer-area .composer');
  await expect(composer).toHaveCount(1);
  const card = page.locator('#transcript .turn-card').first();
  await expect(card).toBeVisible();
  for (const [name, target] of [['composer', composer], ['turn card', card]] as const) {
    // The fill is the documented glass — `color-mix(in srgb, var(--bg) 92%, transparent)` — so it is resolved into channels
    // and checked against THIS element's own `--bg` at 92%: an 88% fill (the tile bar's old number) or a tint of another
    // surface's tone fails, where "alpha > .5" passed both. Read through a canvas, so `rgb()`/`rgba()`/`color(srgb …)` agree.
    const style = await target.evaluate(node => {
      const computed = getComputedStyle(node), probe = document.createElement('canvas').getContext('2d')!;
      // A canvas keeps its last fillStyle when handed a value it cannot parse, so clear it first and read the pixel back.
      const channels = (color: string) => {
        probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
        const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
        return { r, g, b, a };
      };
      return { backdrop: computed.backdropFilter, background: computed.backgroundColor, textShadow: computed.textShadow,
        fill: channels(computed.backgroundColor), base: channels(computed.getPropertyValue('--bg').trim()) };
    });
    expect(style.backdrop, `${name}: a blur over the animating sky re-blurs on every canvas frame and scroll step`).toBe('none');
    // 92% of 255 is 234.6, and a canvas alpha is an 8-bit byte: one step either way is the rounding, not the mix.
    expect(Math.abs(style.fill.a - .92 * 255), `${name}: the fill ${style.background} must be --bg at 92%, the glass's number`).toBeLessThanOrEqual(1.5);
    for (const channel of ['r', 'g', 'b'] as const)
      expect(Math.abs(style.fill[channel] - style.base[channel]), `${name}: the fill ${style.background} must resolve to this element's own --bg ${JSON.stringify(style.base)}, not another surface's tone`).toBeLessThanOrEqual(1);
    expect(style.textShadow, `${name}: text on the card carries no halo`).toBe('none');
  }
  // Nothing in the scrollers carries a live filter: a text-shadow or an icon drop-shadow is re-rastered on every canvas
  // frame and every scroll step. The two roots are covered even when empty (the run's own #stream-region).
  const filtered = await page.evaluate(() => [...new Set([...document.querySelectorAll('#transcript, #stream-region')].flatMap(root => [root, ...root.querySelectorAll('*')]))].flatMap(node => {
    const style = getComputedStyle(node);
    if (style.textShadow === 'none' && style.filter === 'none') return [];
    const classes = (node.getAttribute('class') ?? '').trim().split(/\s+/).slice(0, 3).join('.');
    return [{ node: `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ''}${classes ? `.${classes}` : ''}`, textShadow: style.textShadow, filter: style.filter }];
  }));
  expect(filtered, 'no text-shadow or filter inside #transcript/#stream-region').toEqual([]);
  // The header sits outside the scroller, so its halo is the one the patch keeps.
  const halo = await page.locator('.workspace-header').first().evaluate(node => getComputedStyle(node).textShadow);
  expect(halo, 'the workspace header keeps its page-tone halo').not.toBe('none');
});

/** Text on the bare sky (no card behind it): agent prose, inline code, meta, trace rows, the changed-files list; plus the composer. */
const TEXT = ['#transcript .message-content', '#transcript .markdown :not(pre)>code', '.message-meta strong', '.message-meta time', '.turn-activity-label',
  '.trace-row-head', '.trace-row-meta', '.composer-tray .model-detail', '.composer-tray .branch-chip', '.turn-change-list'];
/** Nothing but the composer and the user's bubble draws a fill behind thread text over the sky. */
const BARE = ['#transcript>.message:not(.user-message)', '#transcript>.turn-activity', '.message>.message-actions', '.workspace-header .preview-status'];
for (const scene of SCENE_IDS) for (const theme of ['light', 'dark'] as const) {
  const over = scene === 'sky' ? 'the sky' : `the ${scene} scene`;
  for (const time of ['06:30', '12:00', '18:40', '23:00']) {
    test(`thread text clears 4.5:1 over ${over} at ${time} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 860 });
      await open(page, time, theme, scene);
      await expect(sky(page)).toHaveAttribute('data-thread-scene', scene);
      await expect(sky(page)).toHaveAttribute('data-gl', '');
      await page.locator('#transcript .turn-activity-summary').first().click();
      await page.waitForTimeout(300);
      for (const selector of BARE) for (const node of await page.locator(selector).all()) {
        await expect(node, selector).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
        await expect(node, selector).toHaveCSS('backdrop-filter', 'none');
      }
      const results = await worstContrast(page, TEXT);
      if (process.env.SKY_LOG) console.log(time, theme, JSON.stringify(results));
      expect(results.length).toBeGreaterThan(4);
      for (const result of results) expect(result.ratio, `${result.selector} at ${time} ${theme}`).toBeGreaterThanOrEqual(4.5);
    });
    test(`reply action icons clear 3:1 on bare ${over} at ${time} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1280, height: 860 });
      await open(page, time, theme, scene);
      await expect(sky(page)).toHaveAttribute('data-gl', '');
      const message = page.locator('#transcript>.message').first();
      await message.hover();
      const actions = message.locator(':scope>.message-actions');
      await expect(actions).toHaveCSS('opacity', '1');
      const results = await worstContrast(page, ['#transcript>.message:hover>.message-actions button']);
      if (process.env.SKY_LOG) console.log(time, theme, JSON.stringify(results));
      expect(results.length).toBeGreaterThan(0);
      for (const result of results) expect(result.ratio, `reply actions at ${time} ${theme}`).toBeGreaterThanOrEqual(3);
    });
    test(`header items read on bare ${over} at ${time} in ${theme}`, async ({ page }) => {
      await page.setViewportSize({ width: 1440, height: 860 });
      await page.addInitScript(() => localStorage.setItem('pandacode.preview.agents-dock', JSON.stringify({ enabled: true, keepOnScreen: true, pinned: false })));
      await open(page, time, theme, scene);
      await expect(sky(page)).toHaveAttribute('data-gl', '');
      // The count badge overlaps the icon's corner by design; measure the icon against the sky behind it.
      await page.addStyleTag({ content: '.agents-dock-count{visibility:hidden !important}' });
      const results = await worstContrast(page, ['.workspace-header .agents-dock-trigger>.icon', '.workspace-header .preview-status']);
      const icons = results.filter(result => result.selector.endsWith('.icon')), text = results.filter(result => !result.selector.endsWith('.icon'));
      if (process.env.SKY_LOG) console.log(time, theme, JSON.stringify([...icons, ...text]));
      expect(icons.length).toBeGreaterThan(0);
      expect(text.length).toBeGreaterThan(0);
      for (const result of icons) expect(result.ratio, `${result.selector} at ${time} ${theme}`).toBeGreaterThanOrEqual(3);
      for (const result of text) expect(result.ratio, `${result.selector} at ${time} ${theme}`).toBeGreaterThanOrEqual(4.5);
    });
  }
  for (const time of ['06:30', '12:00', '18:40', '23:00']) test(`the new-task heading clears 4.5:1 over ${over} at ${time} in ${theme}`, async ({ page }) => {
    await open(page, time, theme, scene);
    await page.getByRole('button', { name: /^New task/ }).click();
    await expect(page.locator('.new-task-welcome h1')).toBeVisible();
    await page.waitForTimeout(400);
    await expect(page.locator('.new-task-welcome')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    const results = await worstContrast(page, ['.new-task-welcome h1', '.welcome-project']);
    if (process.env.SKY_LOG) console.log('new task', time, theme, JSON.stringify(results));
    expect(results.length).toBeGreaterThan(0);
    for (const result of results) expect(result.ratio, result.selector).toBeGreaterThanOrEqual(4.5);
  });
}
