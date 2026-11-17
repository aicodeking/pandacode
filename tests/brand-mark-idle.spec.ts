import { expect, test, type Page } from '@playwright/test';

/** The header panda (src/brand-mark.ts) sleeps between its rest blinks. It also stops entirely while the window is
 * blurred or hidden, and after ~2 minutes with no pointer or keyboard input; the next input or focus brings it back.
 * `__brand` (preview only) counts the mark's animation frames and shortens the no-input stretch via `idleAfterMs`. */
type Brand = { frames: number; dormant: boolean; idleAfterMs: number };
const brand = (page: Page) => page.getByRole('button', { name: 'Replay PandaCode animation', exact: true });
const read = (page: Page) => page.evaluate(() => {
  const b = (window as any).__brand as Brand;
  return { frames: b.frames, dormant: b.dormant };
});
const setIdleAfter = (page: Page, ms: number) => page.evaluate(value => { (window as any).__brand.idleAfterMs = value; }, ms);
const frames = async (page: Page) => (await read(page)).frames;

/** Counts requestAnimationFrame calls made from brand-mark.ts and every eye transform the mark writes. */
async function instrument(page: Page): Promise<void> {
  await page.addInitScript(() => {
    const w = window as any;
    w.__brandRaf = 0; w.__allRaf = 0; w.__eyes = [] as string[];
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (callback: FrameRequestCallback) => {
      w.__allRaf++;
      if (new Error().stack?.includes('brand-mark')) w.__brandRaf++;
      return raf(callback);
    };
  });
}
const watchEyes = (page: Page) => page.evaluate(() => {
  const w = window as any, eye = document.querySelector('.brand-name [data-part="eyeL"]')!;
  w.__eyes = [];
  new MutationObserver(records => { for (const r of records) w.__eyes.push((r.target as Element).getAttribute('transform')); })
    .observe(eye, { attributes: true, attributeFilter: ['transform'] });
});
const eyeScale = (value: string) => Number(/scale\(1 ([\d.e-]+)\)/.exec(value)?.[1] ?? NaN);

async function open(page: Page): Promise<void> {
  await instrument(page);
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled({ timeout: 20_000 });
  await expect(page.locator('html')).toHaveAttribute('data-ready', '');
  await expect(brand(page)).toHaveAttribute('data-brand-ready', '');
  await expect(brand(page)).not.toHaveAttribute('data-brand-launch', { timeout: 15_000 });
  await page.waitForFunction(() => (window as any).__brand !== undefined);
}

/** The startup show and its breaths run continuously; past them only rest blinks remain (slower under load). */
const untilRestBlinks = (page: Page) => expect.poll(() => page.evaluate(() => {
  const b = (window as any).__brand; return b.time >= b.restFrom;
}), { timeout: 90_000 }).toBe(true);

test.describe('brand mark at idle', () => {
  test.describe.configure({ timeout: 120_000 });

  for (const phase of ['startup show', 'rest blinks'] as const) test(`no animation frames while the window is blurred during the ${phase}; focus resumes them`, async ({ page }) => {
    await open(page);
    await setIdleAfter(page, 1e9);
    if (phase === 'rest blinks') await untilRestBlinks(page);
    await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    // A rest blink already in flight finishes first; the startup show skips straight to rest.
    await page.waitForTimeout(1000);
    const before = await page.evaluate(() => (window as any).__brandRaf as number);
    const from = await frames(page);
    await page.waitForTimeout(7000);
    expect(await frames(page), 'brand frames while blurred').toBe(from);
    expect(await page.evaluate(() => (window as any).__brandRaf as number), 'brand rAF while blurred').toBe(before);
    expect(await brand(page).locator('[data-part="eyeL"]').getAttribute('transform'), 'eyes rest open while blurred').toBe('translate(0 10.3) scale(1 1) translate(0 -10.3)');
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect.poll(() => frames(page), { timeout: 10_000 }).toBeGreaterThan(from);
  });

  test('stops after the no-input threshold and resumes on the next input', async ({ page }) => {
    await open(page);
    await setIdleAfter(page, 0);
    await expect.poll(async () => (await read(page)).dormant, { timeout: 20_000 }).toBe(true);
    const from = await frames(page), raf = await page.evaluate(() => (window as any).__brandRaf as number);
    await page.waitForTimeout(7000);
    expect(await frames(page), 'brand frames when dormant').toBe(from);
    expect(await page.evaluate(() => (window as any).__brandRaf as number), 'brand rAF when dormant').toBe(raf);
    // The eyes rest open while the mark sleeps.
    expect(await brand(page).locator('[data-part="eyeL"]').getAttribute('transform')).toBe('translate(0 10.3) scale(1 1) translate(0 -10.3)');
    await setIdleAfter(page, 1e9);
    await page.keyboard.press('Shift');
    await expect.poll(async () => (await read(page)).dormant).toBe(false);
    await expect.poll(() => frames(page)).toBeGreaterThan(from);
  });

  test('pointer movement also counts as input', async ({ page }) => {
    await open(page);
    await setIdleAfter(page, 0);
    await expect.poll(async () => (await read(page)).dormant, { timeout: 20_000 }).toBe(true);
    await setIdleAfter(page, 1e9);
    await page.mouse.move(400, 300);
    await page.mouse.move(420, 320);
    await expect.poll(async () => (await read(page)).dormant).toBe(false);
  });

  test('rest blinks keep their frames while the user is active', async ({ page }) => {
    await open(page);
    await setIdleAfter(page, 1e9);
    // The startup show and its breaths run continuously; wait for the first quiet stretch between rest blinks.
    await untilRestBlinks(page);
    await watchEyes(page);
    // Rest blinks come about every 5 s; a double blink every third.
    await expect.poll(() => page.evaluate(() => ((window as any).__eyes as string[]).length), { timeout: 20_000 }).toBeGreaterThan(4);
    await page.waitForTimeout(1000);
    const eyes = await page.evaluate(() => (window as any).__eyes as string[]);
    const scales = eyes.map(eyeScale);
    expect(scales.every(Number.isFinite)).toBe(true);
    expect(Math.min(...scales), 'the blink closes the eyes').toBeLessThan(.4);
    expect(scales[scales.length - 1], 'the eyes reopen fully').toBe(1);
    // Only changes are written: no two consecutive writes repeat the same value.
    expect(eyes.some((value, i) => i > 0 && value === eyes[i - 1]), 'repeated eye writes').toBe(false);
    // Between blinks the loop sleeps on a timer: frames come in short bursts, not continuously.
    const from = await frames(page);
    await page.waitForTimeout(10_000);
    const per10s = (await frames(page)) - from;
    expect(per10s).toBeGreaterThan(0);
    expect(per10s, 'frames over 10 s at rest').toBeLessThan(200);
  });

  test('measure: brand rAF per minute over 60 s idle', async ({ page }) => {
    test.skip(!process.env.BRAND_IDLE_MEASURE, 'set BRAND_IDLE_MEASURE=1 (and BRAND_IDLE_AFTER_MS / BRAND_IDLE_BLUR) to measure');
    test.setTimeout(180_000);
    await instrument(page);
    await page.goto('/', { waitUntil: 'domcontentloaded' });
    await expect(page.locator('html')).toHaveAttribute('data-ready', '');
    await expect(brand(page)).not.toHaveAttribute('data-brand-launch', { timeout: 15_000 });
    await page.waitForTimeout(30_000); // well past the startup show and its breaths, even under load
    if (process.env.BRAND_IDLE_AFTER_MS) {
      await setIdleAfter(page, Number(process.env.BRAND_IDLE_AFTER_MS));
      await expect.poll(async () => (await read(page)).dormant, { timeout: 20_000 }).toBe(true);
    }
    if (process.env.BRAND_IDLE_BLUR) await page.evaluate(() => window.dispatchEvent(new Event('blur')));
    const count = () => page.evaluate(() => ({ brand: (window as any).__brandRaf as number, all: (window as any).__allRaf as number }));
    await page.evaluate(() => {
      const w = window as any; w.__brandWrites = 0;
      new MutationObserver(records => { w.__brandWrites += records.length; })
        .observe(document.querySelector('.brand-name')!, { attributes: true, subtree: true });
    });
    const a = await count();
    await page.waitForTimeout(60_000);
    const b = await count();
    const writes = await page.evaluate(() => (window as any).__brandWrites as number);
    console.log(`brand rAF/min: ${b.brand - a.brand}; all rAF/min: ${b.all - a.all}; brand attribute writes/min: ${writes}`);
  });
});
