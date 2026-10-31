import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/New_York' });
const storageKey = 'pandacode.wallpaperPreferences';
const workspace = (page: Page) => page.locator('.workspace');
const sceneImages = (page: Page) => page.locator('.workspace-wallpaper img');
const slider = (page: Page) => page.getByRole('slider', { name: 'Wallpaper visibility', exact: true });
const blurSlider = (page: Page) => page.getByRole('slider', { name: 'Wallpaper blur', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });
const setButton = (page: Page, name: string) => page.getByRole('button', { name: `${name} wallpaper set`, exact: true });
const defaultButton = (page: Page, day: string, period: string) => page.getByRole('button', { name: `Set ${day} ${period} as default`, exact: true });
const automatic = (page: Page) => page.getByRole('button', { name: 'Automatic weekly rotation', exact: true });
const settings = (page: Page) => page.getByRole('region', { name: 'Settings', exact: true });
const appearance = (page: Page) => settings(page).getByRole('tab', { name: 'Appearance', exact: true }).click();
const preferences = (page: Page) => page.evaluate(key => JSON.parse(localStorage.getItem(key) ?? 'null'), storageKey);

async function open(page: Page): Promise<void> {
  await page.clock.install({ time: new Date('2026-09-14T09:00:00-04:00') });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
  await expect(page.locator('.task-item.selected')).toHaveCount(1);
}

async function customize(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await appearance(page);
  await expect(settings(page).getByRole('heading', { name: 'Wallpapers', exact: true })).toBeVisible();
  await expect(slider(page)).toBeVisible();
}

async function timeTo(page: Page, time: string): Promise<void> {
  await page.clock.setSystemTime(new Date(time));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
}

async function scrimAlphas(page: Page): Promise<number[]> {
  return page.locator('.workspace-wallpaper').evaluate(node => {
    const background = getComputedStyle(node, '::after').backgroundColor;
    return [...background.matchAll(/rgba?\(([^)]+)\)/g)].map(match => {
      const parts = match[1].match(/[\d.]+/g) ?? [];
      return parts.length === 4 ? Number(parts[3]) : 1;
    });
  });
}

test('wallpapers settings drag visibility live without replacing controls, draft, or scene', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => {
    if (/\/wallpapers\/(?:mon|tue|wed|thu|fri|sat|sun)-(?:morning|afternoon|night)\.webp$/.test(new URL(request.url()).pathname)) requests.push(request.url());
  });
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await prompt(page).fill('Keep this draft while I choose a wallpaper.');
  const originalPrompt = await prompt(page).elementHandle();
  const originalScene = await sceneImages(page).elementHandle();
  await customize(page);
  const originalSlider = await slider(page).elementHandle();
  const originalPreview = await page.locator('.wallpaper-settings-preview').elementHandle();
  const initialAlphas = await scrimAlphas(page);
  await page.clock.runFor(400);
  const bounds = await slider(page).boundingBox();
  expect(bounds).not.toBeNull();
  const y = bounds!.y + bounds!.height / 2;
  await page.mouse.move(bounds!.x + bounds!.width * .2, y);
  await page.mouse.down();
  await page.mouse.move(bounds!.x + bounds!.width * .55, y, { steps: 5 });
  const intermediate = Number(await slider(page).inputValue());
  expect(intermediate).toBeGreaterThan(45);
  expect(intermediate).toBeLessThan(65);
  expect((await scrimAlphas(page))[0]).toBeLessThan(initialAlphas[0]);
  await page.mouse.move(bounds!.x + bounds!.width * .8, y, { steps: 5 });
  expect(Number(await slider(page).inputValue())).toBeGreaterThan(intermediate + 15);
  await page.mouse.up();
  const finalValue = Number(await slider(page).inputValue());
  await expect.poll(async () => (await preferences(page)).visibility).toBe(finalValue);
  expect(await originalSlider!.evaluate(node => node.isConnected)).toBe(true);
  expect(await originalPreview!.evaluate(node => node.isConnected)).toBe(true);
  expect(await originalPrompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await originalScene!.evaluate(node => node === document.querySelector('.workspace-wallpaper img'))).toBe(true);
  await expect(page.locator('#prompt')).toHaveValue('Keep this draft while I choose a wallpaper.');
  expect(requests).toHaveLength(1);
  await page.keyboard.press('Escape');
  await expect(settings(page)).toBeHidden();
  await expect(page.locator('#settings-page img')).toHaveCount(0);
  expect(await originalPreview!.evaluate(node => node.isConnected)).toBe(false);
  expect((await preferences(page)).visibility).toBe(finalValue);
});

test('wallpapers settings drag blur live while keeping text sharp and the scene and controls mounted', async ({ page }) => {
  const fullSceneRequests: string[] = [];
  page.on('request', request => {
    if (/^\/wallpapers\/\w+-(morning|afternoon|night)\.webp$/.test(new URL(request.url()).pathname)) fullSceneRequests.push(request.url());
  });
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await prompt(page).fill('Keep this draft sharp while the scenery softens.');
  const originalScene = await sceneImages(page).elementHandle();
  const originalPrompt = await prompt(page).elementHandle();
  await customize(page);
  await expect(blurSlider(page)).toHaveValue('0');
  const originalBlur = await blurSlider(page).elementHandle();
  const originalPreview = await page.locator('.wallpaper-preview-image').elementHandle();
  const originalVisibility = await slider(page).inputValue();
  await page.clock.runFor(400);
  const bounds = (await blurSlider(page).boundingBox())!;
  const y = bounds.y + bounds.height / 2;
  await page.mouse.move(bounds.x + 9, y);
  await page.mouse.down();
  await page.mouse.move(bounds.x + bounds.width * .3, y, { steps: 5 });
  const intermediate = Number(await blurSlider(page).inputValue());
  expect(intermediate).toBeGreaterThan(4);
  expect(intermediate).toBeLessThan(10);
  await expect(sceneImages(page)).toHaveCSS('filter', `blur(${intermediate}px)`);
  await page.mouse.move(bounds.x + bounds.width * .8, y, { steps: 5 });
  const finalBlur = Number(await blurSlider(page).inputValue());
  expect(finalBlur).toBeGreaterThan(intermediate + 6);
  await expect(sceneImages(page)).toHaveCSS('filter', `blur(${finalBlur}px)`);
  await page.mouse.up();
  await expect.poll(async () => (await preferences(page)).blur).toBe(finalBlur);
  const previewBlur = await page.locator('.wallpaper-preview-image').evaluate(node => parseFloat(getComputedStyle(node).filter.replace('blur(', '')));
  expect(previewBlur).toBeCloseTo(finalBlur * .35, 2);
  const sharp = await page.locator('.workspace,.main-pane,#transcript,#composer,#prompt,.wallpaper-preview-workspace').evaluateAll(nodes => nodes.map(node => getComputedStyle(node).filter));
  expect(sharp.every(filter => filter === 'none')).toBe(true);
  const coverage = await sceneImages(page).evaluate(image => {
    const scene = image.getBoundingClientRect(), layer = image.parentElement!.getBoundingClientRect();
    return { left: layer.left - scene.left, right: scene.right - layer.right, top: layer.top - scene.top, bottom: scene.bottom - layer.bottom };
  });
  expect(Object.values(coverage).every(bleed => bleed >= finalBlur * 3 - 1)).toBe(true);
  await expect(slider(page)).toHaveValue(originalVisibility);
  await expect(page.locator('#prompt')).toHaveValue('Keep this draft sharp while the scenery softens.');
  expect(await originalScene!.evaluate(node => node === document.querySelector('.workspace-wallpaper img'))).toBe(true);
  expect(await originalPrompt!.evaluate(node => node === document.querySelector('#prompt'))).toBe(true);
  expect(await originalBlur!.evaluate(node => node.isConnected)).toBe(true);
  expect(await originalPreview!.evaluate(node => node.isConnected)).toBe(true);
  expect(fullSceneRequests).toHaveLength(1);
});

test('wallpapers settings retain blur independently of a pinned scene and solid visibility across launches', async ({ page }) => {
  await open(page);
  await customize(page);
  await setButton(page, 'Thursday').click();
  await defaultButton(page, 'Thursday', 'night').click();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-night');
  await slider(page).focus();
  await page.keyboard.press('Home');
  await expect(sceneImages(page)).toHaveCount(0);
  await expect(blurSlider(page)).toBeEnabled();
  await blurSlider(page).focus();
  await page.keyboard.press('End');
  await expect(blurSlider(page)).toHaveValue('24');
  await expect.poll(async () => await preferences(page)).toMatchObject({ blur: 24, visibility: 0, set: 'thu', pinned: 'thu-night' });
  await expect(sceneImages(page)).toHaveCount(0);
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await expect(sceneImages(page)).toHaveCount(0);
  await customize(page);
  await expect(blurSlider(page)).toHaveValue('24');
  await expect(slider(page)).toHaveValue('0');
  await expect(defaultButton(page, 'Thursday', 'night')).toHaveAttribute('aria-pressed', 'true');
  await slider(page).focus();
  await page.keyboard.press('End');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-night');
  await expect(sceneImages(page)).toHaveCSS('filter', 'blur(24px)');
  await blurSlider(page).focus();
  await page.keyboard.press('Home');
  await expect(blurSlider(page)).toHaveValue('0');
  await expect(sceneImages(page)).toHaveCSS('filter', 'none');
  await expect.poll(async () => await preferences(page)).toMatchObject({ blur: 0, visibility: 100, pinned: 'thu-night' });
});

test('wallpapers settings support solid and full wallpaper endpoints and persist keyboard changes', async ({ page }) => {
  await open(page);
  await customize(page);
  await slider(page).focus();
  await page.keyboard.press('End');
  await expect(slider(page)).toHaveValue('100');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const fullAlphas = await scrimAlphas(page);
  expect(fullAlphas.length).toBeGreaterThan(0);
  expect(fullAlphas.every(alpha => alpha === 0)).toBe(true);
  await page.keyboard.press('Home');
  await expect(slider(page)).toHaveValue('0');
  await expect(workspace(page)).not.toHaveAttribute('data-wallpaper');
  await expect(sceneImages(page)).toHaveCount(0);
  await expect(page.locator('.main-pane')).toHaveCSS('background-color', 'rgb(28, 28, 27)');
  await expect.poll(async () => (await preferences(page)).visibility).toBe(0);
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await expect(sceneImages(page)).toHaveCount(0);
  await customize(page);
  await expect(slider(page)).toHaveValue('0');
  await slider(page).focus();
  await page.keyboard.press('ArrowRight');
  expect(Number(await slider(page).inputValue())).toBeGreaterThan(0);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const value = Number(await slider(page).inputValue());
  await expect.poll(async () => (await preferences(page)).visibility).toBe(value);
  await page.reload();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await customize(page);
  await expect(slider(page)).toHaveValue(String(value));
});

test('wallpapers settings choose a set that follows time of day and persists across launches', async ({ page }) => {
  await open(page);
  await customize(page);
  await setButton(page, 'Friday').click();
  await expect(setButton(page, 'Friday')).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'fri-morning');
  await timeTo(page, '2026-09-15T15:00:00-04:00');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'fri-afternoon');
  await expect(page.locator('.wallpaper-settings-preview')).toHaveAttribute('data-wallpaper', 'fri-afternoon');
  await page.reload();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'fri-afternoon');
  await customize(page);
  await expect(setButton(page, 'Friday')).toHaveAttribute('aria-pressed', 'true');
  await timeTo(page, '2026-09-16T01:00:00-04:00');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'fri-night');
  await automatic(page).click();
  await expect(automatic(page)).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'wed-night');
});

test('wallpapers settings discard a pending scene when returning to the current wallpaper', async ({ page }) => {
  await page.addInitScript(() => {
    const decode = HTMLImageElement.prototype.decode;
    HTMLImageElement.prototype.decode = async function () {
      await decode.call(this);
      if (new URL(this.src).pathname === '/wallpapers/tue-morning.webp') {
        await new Promise<void>(resolve => { (window as any).__releaseWallpaperDecode = resolve; });
      }
    };
  });
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const originalScene = await sceneImages(page).elementHandle();
  await customize(page);
  await setButton(page, 'Tuesday').click();
  await expect.poll(() => page.evaluate(() => typeof (window as any).__releaseWallpaperDecode)).toBe('function');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await setButton(page, 'Monday').click();
  await expect.poll(async () => (await preferences(page)).set).toBe('mon');
  await page.evaluate(async () => {
    (window as any).__releaseWallpaperDecode();
    await Promise.resolve();
    await Promise.resolve();
  });
  await page.clock.runFor(1000);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await expect(page.locator('.wallpaper-settings-preview')).toHaveAttribute('data-wallpaper', 'mon-morning');
  await expect(setButton(page, 'Monday')).toHaveAttribute('aria-pressed', 'true');
  await expect(sceneImages(page)).toHaveCount(1);
  expect(await originalScene!.evaluate(node => node === document.querySelector('.workspace-wallpaper img'))).toBe(true);
});

test('wallpapers settings pin a default scene until rotation is explicitly resumed', async ({ page }) => {
  await open(page);
  await customize(page);
  await setButton(page, 'Thursday').click();
  await defaultButton(page, 'Thursday', 'night').click();
  await expect(defaultButton(page, 'Thursday', 'night')).toHaveAttribute('aria-pressed', 'true');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-night');
  await expect.poll(async () => (await preferences(page)).pinned).toBe('thu-night');
  await timeTo(page, '2026-09-19T15:00:00-04:00');
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-night');
  await page.reload();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-night');
  await customize(page);
  await expect(defaultButton(page, 'Thursday', 'night')).toHaveAttribute('aria-pressed', 'true');
  await page.getByRole('button', { name: 'Resume rotation', exact: true }).click();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-afternoon');
  await expect.poll(async () => (await preferences(page)).pinned).toBeNull();
  await defaultButton(page, 'Thursday', 'morning').click();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'thu-morning');
  await setButton(page, 'Sunday').click();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'sun-afternoon');
  await expect.poll(async () => (await preferences(page)).pinned).toBeNull();
});

test('wallpapers settings migrate the disabled preference and retain a favorite through disabling', async ({ page }) => {
  await page.addInitScript(() => { localStorage.setItem('pandacode.wallpapers', 'false'); });
  await open(page);
  await expect(sceneImages(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await appearance(page);
  const enabled = page.getByRole('checkbox', { name: 'Daily wallpapers', exact: true });
  await expect(enabled).not.toBeChecked();
  await expect(slider(page)).toHaveValue('0');
  await setButton(page, 'Tuesday').click();
  await defaultButton(page, 'Tuesday', 'afternoon').click();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'tue-afternoon');
  await enabled.uncheck();
  await expect(sceneImages(page)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem('pandacode.wallpapers'))).toBe('false');
  await page.reload();
  await expect(prompt(page)).toBeEnabled();
  await expect(sceneImages(page)).toHaveCount(0);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await appearance(page);
  await expect(enabled).not.toBeChecked();
  await expect(slider(page)).toHaveValue('0');
  await expect(defaultButton(page, 'Tuesday', 'afternoon')).toHaveAttribute('aria-pressed', 'true');
  await enabled.check();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'tue-afternoon');
  expect(await page.evaluate(() => localStorage.getItem('pandacode.wallpapers'))).toBe('true');
  await page.reload();
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'tue-afternoon');
});

test('wallpapers settings ignore malformed storage and never request arbitrary wallpaper paths', async ({ page }) => {
  const requested: string[] = [];
  page.on('request', request => { if (request.url().includes('/wallpapers/')) requested.push(new URL(request.url()).pathname); });
  await page.addInitScript(key => {
    localStorage.setItem(key, JSON.stringify({ enabled: 'false', visibility: '90', blur: '24', set: '../elsewhere', pinned: 'https://example.com/image' }));
  }, storageKey);
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await customize(page);
  await expect(slider(page)).toHaveValue('20');
  await expect(blurSlider(page)).toHaveValue('0');
  await expect(automatic(page)).toHaveAttribute('aria-pressed', 'true');
  expect(requested.some(path => path.includes('elsewhere') || path.includes('example.com'))).toBe(false);
});

test('wallpapers settings recover from malformed JSON and respect contrast without losing customization', async ({ page }) => {
  await page.addInitScript(key => {
    if (!sessionStorage.getItem('wallpaper-storage-seeded')) {
      localStorage.setItem(key, '{broken');
      sessionStorage.setItem('wallpaper-storage-seeded', 'true');
    }
  }, storageKey);
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await customize(page);
  await setButton(page, 'Wednesday').click();
  await defaultButton(page, 'Wednesday', 'afternoon').click();
  await slider(page).focus();
  await page.keyboard.press('End');
  await page.keyboard.press('ArrowLeft');
  await expect.poll(async () => (await preferences(page)).visibility).toBe(99);
  await blurSlider(page).focus();
  await page.keyboard.press('End');
  await expect.poll(async () => (await preferences(page)).blur).toBe(24);
  const saved = await preferences(page);
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await expect(workspace(page)).not.toHaveAttribute('data-wallpaper');
  await expect(sceneImages(page)).toHaveCount(0);
  expect(await preferences(page)).toEqual(saved);
  await expect(slider(page)).toHaveValue('99');
  await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'reduce' });
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'wed-afternoon');
  expect(await page.locator('.workspace-wallpaper').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
  expect(await preferences(page)).toEqual(saved);
});

test('wallpapers settings keep their picker within a narrow window without loading every full scene', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 780 });
  const fullScenes = new Set<string>();
  page.on('request', request => {
    const path = new URL(request.url()).pathname;
    if (/^\/wallpapers\/(?:mon|tue|wed|thu|fri|sat|sun)-(?:morning|afternoon|night)\.webp$/.test(path)) fullScenes.add(path);
  });
  await open(page);
  await expect(workspace(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  // The collapsed sidebar has no Settings button at this width; the standard shortcut remains available.
  await page.keyboard.press('Meta+,');
  await appearance(page);
  await expect(slider(page)).toBeVisible();
  const bounds = await settings(page).boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x).toBeGreaterThanOrEqual(0);
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(620);
  expect(await settings(page).locator('.settings-content').evaluate(node => node.scrollWidth - node.clientWidth)).toBeLessThanOrEqual(1);
  const picker = await page.locator('.wallpaper-settings').boundingBox();
  expect(picker!.x + picker!.width).toBeLessThanOrEqual(620);
  await setButton(page, 'Sunday').scrollIntoViewIfNeeded();
  await expect(setButton(page, 'Sunday')).toBeVisible();
  await page.clock.runFor(500);
  expect(fullScenes.size).toBe(1);
});
