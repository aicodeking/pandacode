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
  expect(filters.sumFilter).toContain('drop-shadow');
  expect(filters.closedFilter).toBe('none');
  expect(filters.openedTraceSumFilter).toContain('drop-shadow');
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
