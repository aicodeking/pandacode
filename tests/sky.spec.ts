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
