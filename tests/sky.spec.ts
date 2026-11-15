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

test.describe('thread sky', () => {
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
  await freezeClock(page);
  await host(page);
  const scale = () => page.evaluate(() => (window as any).__sky.scale as number);
  expect(await scale()).toBe(.6);
  // The wind ramps at 30 fps, then uses 4 fps; the governor also samples those timer paints.
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.evaluate(() => { (window as any).__sky.quietMs = 400; (window as any).__sky.forcePaintMs = 20; });
  await page.clock.runFor(8000);
  expect(await scale()).toBe(.45);
  // Still slow: it stays down.
  await page.clock.runFor(1500);
  expect(await scale()).toBe(.45);
  await page.evaluate(() => { (window as any).__sky.forcePaintMs = 1; });
  // Two 30-frame sample windows at 4 fps clear any mixed slow/fast window, then recover.
  await page.clock.runFor(16000);
  expect(await scale()).toBe(.6);
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
/** Park the pointer on a non-readable stretch of the transcript so the sky is on its rAF burst.
 * A 100 ms probe then contains a paint unless a reader hold is deferring the loop. `data-running` cannot be that
 * baseline: a streaming run paints at the idle 8 fps, and a 100 ms probe can fall between those ticks with the hold
 * deleted. The prepend changes `scrollHeight`, which caps the scene for GROWTH_MS, so the burst is measured only after
 * a paint has sampled the new height and that window has passed. */
async function burstOverTranscript(page: Page): Promise<void> {
  const transcript = page.locator('#transcript');
  const sampled = await frames(page);
  await transcript.evaluate(node => {
    let pad = node.querySelector<HTMLElement>('#sky-hold-open');
    if (!pad) {
      pad = document.createElement('div');
      pad.id = 'sky-hold-open';
      pad.style.height = '420px';
      node.prepend(pad);
    }
    node.scrollTop = 0;
  });
  await expect.poll(() => frames(page), { timeout: 2000 }).toBeGreaterThan(sampled);
  // Past GROWTH_MS even if the paint that sampled the new height was the one after this.
  await page.waitForTimeout(400);
  const box = (await page.locator('#sky-hold-open').boundingBox())!;
  // Below a floating header: the top of the pad can sit under it, and the header is a readable surface.
  await page.mouse.move(box.x + 36, box.y + Math.min(160, Math.max(48, box.height / 3)));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  const from = await frames(page);
  await page.waitForTimeout(100);
  expect(await frames(page) - from, 'the pointer burst paints inside the hold probe, so an empty probe is the hold').toBeGreaterThan(0);
}

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
  // The pointer burst, not a streaming run: the run paints at 8 fps, and a 100 ms probe can be empty with the hold
  // deleted. The wheel is dispatched on the transcript while the pointer stays on the open pad, so the burst keeps
  // running underneath the hold.
  await burstOverTranscript(page);
  const rested = await gapFromBottom(page);
  await monitorHold(page, '#transcript', 'wheel');
  const scrolling = await expectHeld(page, 'wheel scroll', async () => {
    await transcript.evaluate(node => {
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 240 }));
      node.scrollTop += 240;
    });
    // The probe closes at two thirds of the hold. Read it after that.
    await page.waitForTimeout(130);
  });
  expect(await gapFromBottom(page), 'the wheel scrolled the transcript').toBeLessThan(rested);
  // The same for real keystrokes in the prompt. Focus stays on the field; the pointer stays on the open pad, so a
  // missing hold still paints inside the probe. `keydown` and `input` each arm the hold.
  await page.locator('#prompt').focus();
  await monitorHold(page, '#prompt', 'keydown');
  const typing = await expectHeld(page, 'keystroke', async () => { await page.keyboard.type('a swift grey fox', { delay: 40 }); });
  expect(await page.locator('#prompt').inputValue()).toContain('a swift grey fox');
  // Off the open sky: the parting settles and the loop returns to idle. The hold never left it running on its own.
  const message = (await page.locator('#transcript .message').first().boundingBox())!;
  await page.mouse.move(message.x + 30, message.y + message.height / 2);
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(Math.max(scrolling.at(-1)!.from, typing.at(-1)!.from));
  await expect.poll(async () => sky(page).getAttribute('data-sky-state'), { timeout: 4000 }).toBe('idle');
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
  // The pointer over the bare sky (not over a readable surface), so the parting spring is live. A run is live too, which
  // caps the loop at the idle cadence until the attribute is removed inside the hold; the resume is then the pointer's
  // own frames. The frame below integrates both springs across a wait past the clamp.
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
  // The pane's sky stays on the pointer burst. The wheel is dispatched on the side log, which is what arms the hold;
  // moving the pointer onto the log would leave the sky and drop the baseline back to the idle cadence.
  await burstOverTranscript(page);
  await monitorHold(page, '.btw-transcript', 'wheel');
  const scrolling = await expectHeld(page, 'side-thread wheel scroll', async () => {
    await sideLog.evaluate(node => {
      node.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, deltaY: 160 }));
      node.scrollTop += 160;
    });
    await page.waitForTimeout(130);
  });
  expect(await sideLog.evaluate(node => node.scrollTop), 'the wheel scrolled the side thread').toBeGreaterThan(0);
  await page.mouse.move(4, 4);
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(scrolling.at(-1)!.from);
  await expect.poll(async () => sky(page).getAttribute('data-sky-state'), { timeout: 4000 }).toBe('idle');
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
  // Same baseline as the scroll test: the pointer burst, with the keystrokes landing in the side composer.
  await burstOverTranscript(page);
  const input = page.locator('.btw-input');
  await input.focus();
  await expect(input).toBeFocused();
  await monitorHold(page, '.btw-input', 'keydown');
  const typing = await expectHeld(page, 'keystroke in the side composer', async () => { await page.keyboard.type('a swift grey fox', { delay: 40 }); });
  expect(await input.inputValue(), 'the keystrokes reached the side composer').toContain('a swift grey fox');
  await page.mouse.move(4, 4);
  await expect.poll(() => frames(page), { intervals: [25], timeout: 4000 }).toBeGreaterThan(typing.at(-1)!.from);
  await expect.poll(async () => sky(page).getAttribute('data-sky-state'), { timeout: 4000 }).toBe('idle');
});

/** One measured window of a live run: the frames painted, the paints inside each short window, and the wind and state read
 * beside them. Both windows a test measures run for the same wall time over the same number of ticks, so their frame counts
 * are comparable; the only difference is whether output arrives and is pinned. "Standing still" is not hypothetical: it is
 * every run between two rows of output — the model thinking, a tool running — and the wind is up there too. */
async function measureRun(page: Page, growing: boolean, ticks = 5, tickMs = 300): Promise<{ painted: number; paints: number[]; wind: string[]; states: string[]; elapsedMs: number }> {
  const transcript = page.locator('#transcript');
  const startedAt = Date.now();
  const start = await frames(page), paints: number[] = [], wind: string[] = [], states: string[] = [];
  let previous = 0;
  for (let tick = 0; tick < ticks; tick++) {
    if (growing) {
      // The same pin `main.ts` writes for a row of output (`followTranscript`, `stickTranscript`, `settleIn`): append the
      // row where a run's output lands (`#stream-region`, the transcript's last child), then put the bottom of the
      // transcript on screen. A scroll position is not reader intent, so it holds nothing.
      const gap = await transcript.evaluate(node => {
        const row = document.createElement('div');
        row.style.height = '40px';
        (node.querySelector('#stream-region') ?? node).append(row);
        node.scrollTop = node.scrollHeight;
        return Math.round(node.scrollHeight - node.scrollTop - node.clientHeight);
      });
      expect(gap, 'the pin lands at the bottom').toBe(0);
    }
    await page.waitForTimeout(tickMs);
    const painted = (await frames(page)) - start;
    paints.push(painted - previous); previous = painted;
    wind.push((await sky(page).getAttribute('data-wind'))!);
    states.push((await sky(page).getAttribute('data-sky-state'))!);
  }
  return { painted: previous, paints, wind, states, elapsedMs: Date.now() - startedAt };
}

/* The streaming cadence, stated as the contract rather than as the frame count 30 fps used to give. A live run churns the
 * transcript — it is streaming, and `main.ts` pins the transcript to the bottom on every row of output — so the canvas
 * drops to the idle cadence while that lasts: the scene keeps painting, the wind is up, the state never falls back to idle
 * and no short window is empty, but it paints at roughly a quarter of the wind's rate instead of on every other frame. The
 * assertion is one-sided and rate-based rather than a ratio against a second window: a live run never reaches the wind
 * cadence at all (`churning` includes `running()`), so there is no still-run denominator to divide by, and a rate bound
 * derived from the wall time this box actually took keeps a slow box from failing where a fast one passes. A revert to a
 * single cadence reads ~30 fps and fails.
 *
 * `main.ts` pins the transcript to the bottom on every frame of output, and the sky reads reader intent off the input
 * events, never off a scroll position: those scrolls are the app's and must hold nothing, or a streaming run — the one
 * thing that drives the wind — would freeze its own scene. */
test('a run that is growing keeps its wind while the app pins the transcript, and paints at the idle rate', async ({ page }) => {
  // Two measured windows of ~1.5 s each, plus the wind's ramp: the default 20 s is a stopwatch on a loaded box, not a
  // statement about the cadence.
  test.slow();
  await page.setViewportSize({ width: 1280, height: 860 });
  await open(page);
  await lengthenThread(page);
  const transcript = page.locator('#transcript');
  expect(await transcript.evaluate(node => node.scrollHeight - node.clientHeight), 'the thread scrolls').toBeGreaterThan(200);
  await transcript.evaluate(node => node.setAttribute('data-running', ''));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await expect.poll(async () => Number(await sky(page).getAttribute('data-wind')), { timeout: 4000 }).toBeGreaterThan(.97);
  // Five 300 ms windows of a run that appends a row and pins the bottom on every tick.
  const growing = await measureRun(page, true);

  // The growing run keeps its wind: it still paints, no 300 ms of it is empty (a stall of more than twice the idle
  // interval, where an empty window at the idle rate is impossible), and the state says "moving" throughout.
  expect(growing.painted, 'the growing run still paints frames').toBeGreaterThan(0);
  for (const [index, count] of growing.paints.entries())
    expect(count, `no zero-frame window: ${count} paints in the ${index + 1}. 300 ms of a growing run`).toBeGreaterThan(0);
  for (const [index, value] of growing.wind.entries())
    expect(Number(value), `wind at ${(index + 1) * 300} ms of the growing run is still up`).toBeGreaterThan(0);
  for (const state of growing.states) expect(state, 'the growing run never falls out of moving').toBe('moving');

  // The rate bound, from the wall time this box actually took: the wind's 30 fps is what a run used to cost, the cap is the
  // idle 8 fps, and 18 fps sits between them with room for a box that is slow but not reverting (measured on this one:
  // ~8-10 fps while a run churns, 30 fps on the same tree with the cap removed).
  const seconds = growing.elapsedMs / 1000;
  const fps = growing.painted / seconds;
  expect(growing.painted, `the growing run painted ${growing.painted} frames in ${seconds.toFixed(2)} s (${fps.toFixed(1)} fps)`)
    .toBeLessThanOrEqual(seconds * 18);
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

/** An isolated host lets lifecycle checks drive real WebGL without the app's unrelated timers. */
async function host(page: Page, tile = false, scene?: string): Promise<void> {
  await page.route('**/sky-harness', route => route.fulfill({ contentType: 'text/html', body: '<html data-theme="light" data-ready><body><div id="workspace"><div id="pane" style="position:relative;width:800px;height:600px"></div></div></body></html>' }));
  await page.goto('/sky-harness');
  await page.evaluate(async ({ tile, scene }) => {
    const path = '/src/sky-window.ts';
    const { mountSky } = await import(path);
    const pane = document.querySelector('#pane') as HTMLElement;
    const workspace = document.querySelector('#workspace') as HTMLElement;
    const state = { wanted: true, controller: null as any };
    (window as any).skyHost = state;
    state.controller = mountSky(pane, workspace, { wanted: () => state.wanted, expose: true, tileRoot: tile ? pane : undefined, pinnedScene: scene });
  }, { tile, scene });
  await expect(sky(page)).toHaveAttribute('data-gl', '');
}

async function freezeClock(page: Page): Promise<void> {
  const time = new Date('2026-01-01T00:00:00Z');
  await page.clock.install({ time });
  await page.clock.pauseAt(new Date(time.getTime() + 1000));
}

/** Read the actual shader clock and drift, rather than inferring scene speed from frame counts. */
const sceneClock = (page: Page) => page.locator('.thread-sky>canvas').first().evaluate(node => {
  const gl = (node as HTMLCanvasElement).getContext('webgl')!;
  const program = gl.getParameter(gl.CURRENT_PROGRAM) as WebGLProgram;
  return { now: performance.now() / 1000,
    time: gl.getUniform(program, gl.getUniformLocation(program, 'time')) as number,
    drift: gl.getUniform(program, gl.getUniformLocation(program, 'drift')) as number };
});

for (const tile of [false, true]) test(`scene time and drift track wall time at the ${tile ? 'tile' : 'steady'} cadence and on pointer wake`, async ({ page }) => {
  await freezeClock(page);
  await host(page, tile);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.clock.runFor(2500);
  await expect(sky(page)).toHaveAttribute('data-wind', '1');
  const start = await sceneClock(page), startFrames = await frames(page);
  await page.clock.runFor(4000);
  const steady = await sceneClock(page), paints = (await frames(page)) - startFrames;
  expect(paints).toBeGreaterThanOrEqual(tile ? 7 : 15);
  expect(paints).toBeLessThanOrEqual(tile ? 9 : 17);
  expect(steady.time - start.time).toBeCloseTo(steady.now - start.now, 1);
  expect(steady.drift - start.drift).toBeCloseTo((steady.now - start.now) * .122, 2);
  // Wake between timer slots: neither the time before the pointer nor its faster cadence changes scene speed.
  await page.clock.runFor(200);
  await page.mouse.move(400, 400);
  await page.clock.runFor(2000);
  const awake = await sceneClock(page);
  expect(Math.abs((awake.time - steady.time) - (awake.now - steady.now))).toBeLessThan(.55);
  expect(Math.abs((awake.drift - steady.drift) - (awake.now - steady.now) * .122)).toBeLessThan(.07);
});

for (const scene of ['rain', 'lagoon', 'dunes', 'ocean']) for (const tile of [false, true]) {
  test(`${scene} keeps fast motion smooth at the ${tile ? 'tile' : 'focused'} cadence, then settles`, async ({ page }) => {
    await freezeClock(page);
    await host(page, tile, scene);
    await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
    await page.clock.runFor(2500);
    await expect(sky(page)).toHaveAttribute('data-wind', '1');
    const start = await sceneClock(page), before = await frames(page);
    await page.clock.runFor(2000);
    const end = await sceneClock(page), paints = (await frames(page)) - before;
    expect(paints).toBeGreaterThanOrEqual(tile ? 11 : 28);
    expect(paints).toBeLessThanOrEqual(tile ? 13 : 31);
    expect(end.time - start.time).toBeCloseTo(end.now - start.now, 1);
    expect(end.drift - start.drift).toBeCloseTo((end.now - start.now) * .122, 2);
    await page.locator('#pane').evaluate(node => node.removeAttribute('data-running'));
    await page.clock.runFor(8500);
    await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
    const still = await frames(page);
    await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
    await page.clock.runFor(2000);
    expect(await frames(page)).toBe(still);
  });
}

for (const tile of [false, true]) test(`a quiet ${tile ? 'focused tile' : 'sky'} settles, refreshes its clock slowly and wakes on input, theme, resize and runs`, async ({ page }) => {
  await freezeClock(page);
  await host(page, tile);
  if (tile) await page.locator('#pane').evaluate(node => node.setAttribute('data-focused', ''));
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  const still = await frames(page);
  await page.clock.runFor(10_000);
  expect(await frames(page)).toBe(still);
  await page.clock.runFor(180_000);
  expect(await frames(page)).toBe(still + 1);
  await page.mouse.move(400, 400);
  await page.clock.runFor(50);
  await expect.poll(() => frames(page)).toBeGreaterThan(still + 1);
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  await page.evaluate(() => { document.documentElement.dataset.theme = 'dark'; });
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await page.clock.runFor(8500);
  await page.locator('#pane').evaluate(node => { node.style.width = '700px'; });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await page.clock.runFor(8500);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.clock.runFor(2000);
  await expect(sky(page)).toHaveAttribute('data-wind', '1');
  const running = await frames(page);
  await page.clock.runFor(2000);
  const paints = (await frames(page)) - running;
  expect(paints).toBeGreaterThanOrEqual(tile ? 3 : 7);
  expect(paints).toBeLessThanOrEqual(tile ? 5 : 9);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'static');
  const reduced = await frames(page);
  await page.clock.runFor(2000);
  expect(await frames(page)).toBe(reduced);
  for (const covered of [true, false]) {
    await page.locator('#workspace').evaluate((node, covered) => node.classList.toggle('settings-open', covered), covered);
    await expect(sky(page)).toHaveAttribute('data-sky-state', covered ? 'paused' : 'static');
  }
});

test('tiles keep painting at 2 fps after the ramp, including beneath the focused pane', async ({ page }) => {
  await freezeClock(page);
  await host(page, true);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.clock.runFor(2500);
  const start = await frames(page);
  await page.clock.runFor(2000);
  expect((await frames(page)) - start).toBeLessThanOrEqual(5);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-focused', ''));
  await page.clock.runFor(2000);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  const focused = await frames(page);
  expect(focused - start).toBeGreaterThanOrEqual(7);
  expect(focused - start).toBeLessThanOrEqual(9);
  await page.locator('#pane').evaluate(node => node.removeAttribute('data-focused'));
  await page.clock.runFor(100);
  expect(await frames(page)).toBeGreaterThan(focused);
});

test('disable releases the context and cancelled fade, and enable creates a fresh canvas', async ({ page }) => {
  await host(page);
  await page.evaluate(() => (window as any).skyHost.controller.setThread('first'));
  const before = await page.locator('.thread-sky>canvas').first().elementHandle();
  await page.evaluate(() => {
    const host = (window as any).skyHost;
    for (let i = 0; i < 20 && !document.querySelector('[data-fading]'); i++) host.controller.setThread(`scene-${i}`);
    document.querySelector('.thread-sky-fade')!.getAnimations().forEach(animation => animation.pause());
  });
  await expect(sky(page)).toHaveAttribute('data-fading', 'true');
  await page.locator('.thread-sky-fade').evaluate(node => node.getAnimations().forEach(animation => animation.cancel()));
  await expect(sky(page)).not.toHaveAttribute('data-fading');
  expect(await page.locator('.thread-sky-fade').evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height])).toEqual([0, 0]);
  await page.evaluate(() => {
    const host = (window as any).skyHost;
    for (let i = 20; i < 40 && !document.querySelector('[data-fading]'); i++) host.controller.setThread(`scene-${i}`);
    host.wanted = false; host.controller.refresh();
  });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'off');
  await expect(sky(page)).not.toHaveAttribute('data-gl');
  expect(await before!.evaluate(node => [node.width, node.height, node.getContext('webgl')!.isContextLost()])).toEqual([0, 0, true]);
  expect(await page.locator('.thread-sky-fade').evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height])).toEqual([0, 0]);
  await page.evaluate(() => { const host = (window as any).skyHost; host.wanted = true; host.controller.refresh(); });
  await expect(sky(page)).toHaveAttribute('data-gl', '');
  const start = await frames(page);
  await expect.poll(() => frames(page)).toBeGreaterThan(start);
});

test('precompile respects native idle support and preserves the live scene across pauses', async ({ page }) => {
  await host(page);
  const nativeIdle = await page.evaluate(() => typeof requestIdleCallback === 'function');
  const scene = await page.evaluate(() => (window as any).__sky.scene);
  await page.evaluate(() => { document.querySelector('#workspace')!.classList.add('settings-open'); });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  const compiled = await page.evaluate(() => (window as any).__sky.compiled.length);
  await page.waitForTimeout(1500);
  expect(await page.evaluate(() => (window as any).__sky.compiled.length)).toBe(compiled);
  const paused = await frames(page);
  await page.evaluate(() => { document.querySelector('#workspace')!.classList.remove('settings-open'); });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await expect.poll(() => frames(page)).toBeGreaterThan(paused);
  await expect.poll(() => page.evaluate(() => (window as any).__sky.compiled.length)).toBe(nativeIdle ? 2 : 1);
  await page.waitForTimeout(1000);
  expect(await page.evaluate(() => (window as any).__sky.compiled.length)).toBe(nativeIdle ? 2 : 1);
  expect(await page.evaluate(() => (window as any).__sky.scene)).toBe(scene);
  await expect(sky(page)).toHaveAttribute('data-gl', '');
});


test('the fallback governor measures paints on timers without a GPU timing extension', async ({ page }) => {
  await page.addInitScript(() => {
    const prototype = WebGLRenderingContext.prototype;
    const extension = prototype.getExtension, draw = prototype.drawArrays;
    prototype.getExtension = function(name: string) { return name === 'EXT_disjoint_timer_query' ? null : extension.call(this, name); };
    prototype.drawArrays = function(...args: Parameters<typeof draw>) {
      const until = performance.now() + 12;
      while (performance.now() < until) { /* Simulate slow submission on a driver without GPU timers. */ }
      draw.apply(this, args);
    };
  });
  await host(page);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'idle');
  await expect.poll(() => page.evaluate(() => (window as any).__sky.scale), { timeout: 7000 }).toBe(.45);
});

test('when the sky settles or pauses long, it snapshots onto the still canvas and parks WebGL', async ({ page }) => {
  await freezeClock(page);
  await host(page);
  await page.evaluate(() => (window as any).skyHost.controller.setThread('first'));
  const glSize = () => page.locator('.thread-sky>canvas').first().evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height]);
  const stillState = () => page.locator('.thread-sky-still').evaluate(node => {
    const c = node as HTMLCanvasElement;
    const pixel = c.width > 0 ? [...c.getContext('2d')!.getImageData(2, 2, 1, 1).data] : [0, 0, 0, 0];
    return { hidden: c.hidden, width: c.width, height: c.height, nonBlack: pixel.slice(0, 3).some(v => v > 0) };
  });
  const initialGl = await page.locator('.thread-sky>canvas').first().elementHandle();
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });

  // 1. Settling at 8500ms snapshots onto .thread-sky-still, keeps data-gl="", and loses + zeroes WebGL.
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  await expect(sky(page)).toHaveAttribute('data-gl', '');
  expect(await initialGl!.evaluate(node => [node.width, node.height, node.getContext('webgl')!.isContextLost()])).toEqual([0, 0, true]);
  expect(await glSize()).toEqual([0, 0]);
  await expect(page.locator('.thread-sky-still')).toBeVisible();
  const settledStill = await stillState();
  expect(settledStill.hidden).toBe(false);
  expect(settledStill.width).toBeGreaterThan(0);
  expect(settledStill.height).toBeGreaterThan(0);
  expect(settledStill.nonBlack).toBe(true);

  // 2. Advancing 180_000ms refreshes the still snapshot (frames + 1) and immediately re-parks WebGL.
  const beforeClock = await frames(page);
  await page.clock.runFor(180_000);
  expect(await frames(page)).toBe(beforeClock + 1);
  expect(await glSize()).toEqual([0, 0]);
  await expect(page.locator('.thread-sky-still')).toBeVisible();
  await expect(sky(page)).toHaveAttribute('data-gl', '');
  expect((await stillState()).nonBlack).toBe(true);

  // 3a. Pointer wake resumes live WebGL and clears .thread-sky-still ([0, 0], hidden).
  await page.mouse.move(400, 400);
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });

  // 3b. Settling again and waking via data-running clears .thread-sky-still cleanly.
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });
  await page.locator('#pane').evaluate(node => node.removeAttribute('data-running'));
  await page.clock.runFor(10_500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');

  // 3c. setThread crossfade from settled state copies stillCanvas to .thread-sky-fade and resumes live WebGL.
  expect(await glSize()).toEqual([0, 0]);
  const beforeFades = await page.evaluate(() => (window as any).__sky.fades as number);
  const fadeInfo = await page.evaluate(() => {
    const host = (window as any).skyHost, current = (window as any).__sky.scene;
    for (let i = 0; i < 40 && (window as any).__sky.scene === current; i++) host.controller.setThread(`settled-fade-${i}`);
    const fade = document.querySelector('.thread-sky-fade') as HTMLCanvasElement;
    return [fade.hidden, fade.width, fade.height] as const;
  });
  expect(await page.evaluate(() => (window as any).__sky.fades as number)).toBe(beforeFades + 1);
  expect(fadeInfo[0]).toBe(false);
  expect(fadeInfo[1]).toBeGreaterThan(0);
  expect(fadeInfo[2]).toBeGreaterThan(0);
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });
  await page.locator('.thread-sky-fade').evaluate(node => node.getAnimations().forEach(animation => animation.finish()));
  await expect(sky(page)).not.toHaveAttribute('data-fading');

  // 3d. wanted = false -> true from settled state clears .thread-sky-still and restores live WebGL cleanly.
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  await page.evaluate(() => { const host = (window as any).skyHost; host.wanted = false; host.controller.refresh(); });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'off');
  await expect(sky(page)).not.toHaveAttribute('data-gl');
  expect(await glSize()).toEqual([0, 0]);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });
  await page.evaluate(() => { const host = (window as any).skyHost; host.wanted = true; host.controller.refresh(); });
  await expect(sky(page)).toHaveAttribute('data-gl', '');
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });

  // Brief pause (1.5s) preserves live WebGL; continuous 10s pause snapshots and parks WebGL until resumed.
  await page.locator('#workspace').evaluate(node => node.classList.add('settings-open'));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  await page.clock.runFor(1500);
  expect((await glSize())[0]).toBeGreaterThan(0);
  await page.clock.runFor(9000);
  expect(await glSize()).toEqual([0, 0]);
  const pausedStill = await stillState();
  expect(pausedStill.hidden).toBe(false);
  expect(pausedStill.width).toBeGreaterThan(0);
  expect(pausedStill.nonBlack).toBe(true);
  await page.locator('#workspace').evaluate(node => node.classList.remove('settings-open'));
  await page.clock.runFor(50);
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await stillState()).toEqual({ hidden: true, width: 0, height: 0, nonBlack: false });

  // Closed <details> bodies skip the .icon drop-shadow filter while open/summary icons keep it.
  const filters = await page.evaluate(() => {
    document.documentElement.style.setProperty('--bg', '#ffffff');
    const workspace = document.querySelector('#workspace')!;
    workspace.className = 'workspace';
    const pane = document.querySelector('#pane')!;
    pane.className = 'main-pane';
    const probe = document.createElement('div');
    probe.id = 'transcript';
    probe.innerHTML = '<details id="outer"><summary><svg class="icon" id="sum-icon"></svg></summary><div><details id="inner"><summary><svg class="icon" id="trace-sum-icon"></svg></summary><div><svg class="icon" id="trace-body-icon"></svg></div></details></div></details>';
    pane.append(probe);
    const sumFilter = getComputedStyle(probe.querySelector('#sum-icon')!).filter;
    const closedFilter = getComputedStyle(probe.querySelector('#trace-sum-icon')!).filter;
    (probe.querySelector('#outer') as HTMLDetailsElement).open = true;
    const openedTraceSumFilter = getComputedStyle(probe.querySelector('#trace-sum-icon')!).filter;
    const closedTraceBodyFilter = getComputedStyle(probe.querySelector('#trace-body-icon')!).filter;
    probe.remove();
    return { sumFilter, closedFilter, openedTraceSumFilter, closedTraceBodyFilter };
  });
  expect(filters.sumFilter).toBe('none');
  expect(filters.closedFilter).toBe('none');
  expect(filters.openedTraceSumFilter).toBe('none');
  expect(filters.closedTraceBodyFilter).toBe('none');
});

test('a settled sky stays settled without recreating WebGL across focus, visibility and view switches, and wakes on pointer or run', async ({ page }) => {
  await freezeClock(page);
  await host(page);
  const glSize = () => page.locator('.thread-sky>canvas').first().evaluate(node => [(node as HTMLCanvasElement).width, (node as HTMLCanvasElement).height]);
  const compiledCount = () => page.evaluate(() => ((window as any).__sky.compiled as string[]).length);

  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  expect(await compiledCount()).toBe(0);
  const settledFrames = await frames(page);

  // 1. Settings / Board / GitHub view cover and return keep settled state without spinning up WebGL.
  for (const cls of ['settings-open', 'board-view', 'github-view']) {
    await page.locator('#workspace').evaluate((node, c) => node.classList.add(c), cls);
    await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
    await page.clock.runFor(200);
    await page.locator('#workspace').evaluate((node, c) => node.classList.remove(c), cls);
    await page.clock.runFor(200);
    await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
    expect(await glSize()).toEqual([0, 0]);
    expect(await compiledCount()).toBe(0);
    expect(await frames(page)).toBe(settledFrames);
  }

  // 2. Document hidden -> visible and blur -> focus keep settled state without spinning up WebGL.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, get: () => false });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await page.clock.runFor(200);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  expect(await frames(page)).toBe(settledFrames);

  await page.evaluate(() => window.dispatchEvent(new Event('blur')));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await page.clock.runFor(200);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  expect(await frames(page)).toBe(settledFrames);

  // 2b. Crossing a >3 min clock bucket while covered repaints 1 frame on return and immediately re-parks to settled.
  await page.locator('#workspace').evaluate(node => node.classList.add('settings-open'));
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'paused');
  await page.clock.runFor(200_000);
  await page.locator('#workspace').evaluate(node => node.classList.remove('settings-open'));
  await page.clock.runFor(200);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  expect(await compiledCount()).toBe(0);
  expect(await frames(page)).toBe(settledFrames + 1);

  // 3. Moving the pointer over the sky wakes WebGL immediately.
  await page.mouse.move(320, 260);
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  expect((await glSize())[0]).toBeGreaterThan(0);
  expect(await frames(page)).toBeGreaterThan(settledFrames + 1);

  // Settle again, then verify starting a run wakes WebGL immediately.
  await page.clock.runFor(8500);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'settled');
  expect(await glSize()).toEqual([0, 0]);
  await page.locator('#pane').evaluate(node => node.setAttribute('data-running', ''));
  await page.clock.runFor(50);
  await expect(sky(page)).toHaveAttribute('data-sky-state', 'moving');
  expect((await glSize())[0]).toBeGreaterThan(0);
});
});
