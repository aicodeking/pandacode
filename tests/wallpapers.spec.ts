import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/New_York' });
const scene = (page: Page) => page.locator('.workspace');
const images = (page: Page) => page.locator('.workspace-wallpaper img');
/** Daily wallpapers live in Settings → Appearance. */
async function appearance(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  await page.getByRole('region', { name: 'Settings', exact: true }).getByRole('tab', { name: 'Appearance', exact: true }).click();
}
async function open(page: Page, time = '2026-09-14T09:00:00-04:00') {
  const requestedTime = new Date(time);
  // Leave startup room before the tested boundary, then advance only when the test asks.
  await page.clock.install({ time: new Date(requestedTime.getTime() - 60_000) });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await page.clock.pauseAt(requestedTime);
}

async function expectClearBars(page: Page) {
  for (const selector of ['.workspace-header']) {
    const bar = page.locator(selector);
    await expect(bar).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
    await expect(bar).toHaveCSS('background-image', 'none');
    await expect(bar).toHaveCSS('backdrop-filter', 'none');
    await expect(bar).toHaveCSS('border-top-width', '0px');
    await expect(bar).toHaveCSS('border-bottom-width', '0px');
  }
}

async function expectSceneCoversBars(page: Page) {
  await expectClearBars(page);
  const backdrop = await page.locator('.workspace-wallpaper').boundingBox();
  const main = await scene(page).boundingBox();
  expect(backdrop).not.toBeNull();
  expect(main).not.toBeNull();
  for (const edge of ['x', 'y', 'width', 'height'] as const) {
    expect(backdrop![edge]).toBeCloseTo(main![edge], 1);
  }
  for (const selector of ['.sidebar', '.workspace-header']) {
    if (!await page.locator(selector).isVisible()) continue;
    const bounds = await page.locator(selector).boundingBox();
    expect(bounds).not.toBeNull();
    expect(bounds!.x).toBeGreaterThanOrEqual(backdrop!.x);
    expect(bounds!.y).toBeGreaterThanOrEqual(backdrop!.y);
    expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(backdrop!.x + backdrop!.width + 0.1);
    expect(bounds!.y + bounds!.height).toBeLessThanOrEqual(backdrop!.y + backdrop!.height + 0.1);
  }
}

async function barStyles(page: Page) {
  return page.locator('.workspace-header,.sidebar').evaluateAll(bars => bars.map(bar => {
    const style = getComputedStyle(bar);
    return {
      background: style.backgroundColor,
      image: style.backgroundImage,
      topBorder: style.borderTop,
      bottomBorder: style.borderBottom,
      blur: style.backdropFilter || style.getPropertyValue('-webkit-backdrop-filter'),
    };
  }));
}

test('wallpapers load one scene shared by thread and board without remounting it', async ({ page }) => {
  const requests: string[] = [];
  page.on('request', request => { if (request.url().includes('/wallpapers/')) requests.push(request.url()); });
  await open(page);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await expect(images(page)).toHaveCount(1);
  await expectSceneCoversBars(page);
  await page.evaluate(() => { (window as any).__scene = document.querySelector('.workspace-wallpaper img'); });
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(page.locator('#project-board')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expectSceneCoversBars(page);
  await page.setViewportSize({ width: 1100, height: 780 });
  await expectSceneCoversBars(page);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
  await expect(page.locator('.conversation-pane')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expectSceneCoversBars(page);
  await expect(images(page)).toHaveCount(1);
  expect(await page.evaluate(() => (window as any).__scene === document.querySelector('.workspace-wallpaper img'))).toBe(true);
  await page.clock.runFor(5000);
  expect(requests).toHaveLength(1);
  await expect(page.locator('.workspace-wallpaper')).toHaveAttribute('aria-hidden', 'true');
  await expect(page.locator('.workspace-wallpaper')).toHaveCSS('pointer-events', 'none');
});

for (const theme of ['light', 'dark']) {
  test(`wallpapers restore normal header surfaces when disabled or contrast increases in ${theme} mode`, async ({ page }) => {
    await page.addInitScript(theme => {
      localStorage.setItem('pandacode.theme', theme);
      localStorage.setItem('pandacode.wallpapers', 'false');
    }, theme);
    await open(page);
    const normal = await barStyles(page);
    await page.emulateMedia({ contrast: 'more' });
    const highContrast = await barStyles(page);
    await page.emulateMedia({ contrast: 'no-preference' });
    await appearance(page);
    const toggle = page.getByRole('checkbox', { name: 'Daily wallpapers', exact: true });
    await toggle.check();
    await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
    await expectClearBars(page);
    await toggle.uncheck();
    await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
    await expect(images(page)).toHaveCount(0);
    expect(await barStyles(page)).toEqual(normal);
    await toggle.check();
    await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
    await page.emulateMedia({ contrast: 'more' });
    await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
    await expect(images(page)).toHaveCount(0);
    expect(await barStyles(page)).toEqual(highContrast);
  });
}

test('wallpapers change at noon without replacing the composer, draft, or open dropdown', async ({ page }) => {
  await open(page, '2026-09-14T11:59:59-04:00');
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Keep my draft through the wallpaper transition');
  await page.getByRole('button', { name: 'Choose harness and model', exact: true }).click();
  const menu = page.getByRole('dialog', { name: 'Harness and model', exact: true });
  await expect(menu).toBeVisible();
  await page.evaluate(() => { (window as any).__wallpaperControls = [document.querySelector('#prompt'), document.querySelector('.model-menu')]; });
  await page.clock.runFor(1100);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-afternoon');
  await expect(prompt).toHaveValue('Keep my draft through the wallpaper transition');
  await expect(menu).toBeVisible();
  expect(await page.evaluate(() => (window as any).__wallpaperControls.every((node: Element | null, i: number) => node === document.querySelector(i ? '.model-menu' : '#prompt')))).toBe(true);
  await page.clock.runFor(1000);
  await expect(images(page)).toHaveCount(1);
});

test('wallpapers switch weekday at midnight and catch up after a clock change on focus', async ({ page }) => {
  await open(page, '2026-09-20T23:59:59-04:00');
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'sun-night');
  await page.clock.runFor(1100);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-night');
  await page.clock.setSystemTime(new Date('2026-09-23T15:00:00-04:00'));
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'wed-afternoon');
  await page.clock.runFor(1000);
  await expect(images(page)).toHaveCount(1);
});

test('wallpapers can be disabled and the preference survives reopening the app', async ({ page }) => {
  await open(page);
  await expect(images(page)).toHaveCount(1);
  await appearance(page);
  const toggle = page.getByRole('checkbox', { name: 'Daily wallpapers', exact: true });
  await toggle.uncheck();
  await expect(images(page)).toHaveCount(0);
  await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
  await page.reload();
  await expect(page.locator('.task-item.selected')).toBeVisible();
  await expect(images(page)).toHaveCount(0);
  await appearance(page);
  await expect(toggle).not.toBeChecked();
  await toggle.check();
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
});

test('wallpapers defer to increased contrast and reduced motion', async ({ page }) => {
  await page.emulateMedia({ contrast: 'more', reducedMotion: 'reduce' });
  await open(page, '2026-09-14T11:59:59-04:00');
  await expect(images(page)).toHaveCount(0);
  await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
  await page.emulateMedia({ contrast: 'no-preference', reducedMotion: 'reduce' });
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await page.clock.runFor(1100);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-afternoon');
  await expect(images(page)).toHaveCount(1);
  expect(await page.locator('.workspace-wallpaper').evaluate(node => node.getAnimations({ subtree: true }).length)).toBe(0);
});

test('wallpapers keep the last decoded scene if the next image fails', async ({ page }) => {
  await page.route('**/wallpapers/mon-afternoon.webp', route => route.abort());
  await open(page, '2026-09-14T11:59:59-04:00');
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const failedImage = page.waitForEvent('requestfailed', request => request.url().endsWith('/wallpapers/mon-afternoon.webp'));
  await page.clock.runFor(1100);
  await failedImage;
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  await expect(images(page)).toHaveCount(1);
  await expect(page.getByRole('textbox', { name: 'Message your coding agent' })).toBeEnabled();
});

test('wallpapers ignore a stale decode after being disabled', async ({ page }) => {
  let release: (() => void) | undefined;
  await page.route('**/wallpapers/*', async route => {
    await new Promise<void>(resolve => { release = resolve; });
    await route.continue();
  });
  await open(page);
  await expect.poll(() => Boolean(release)).toBe(true);
  await appearance(page);
  await page.getByRole('checkbox', { name: 'Daily wallpapers', exact: true }).uncheck();
  release!();
  await page.clock.runFor(1000);
  await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
  await expect(images(page)).toHaveCount(0);
});

test('wallpapers match the sidebar frost in rounded board task details without a divider', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 940 });
  await open(page);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const sidebarMaterial = await page.locator('.sidebar').evaluate(el => {
    const style = getComputedStyle(el);
    return { background: style.backgroundColor, frost: style.backdropFilter };
  });
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await page.getByRole('button', { name: 'Open task: Make search feel instant', exact: true }).click();
  const details = page.getByRole('region', { name: 'Task details', exact: true });
  await expect(details).toBeVisible();
  await expect(details).toHaveCSS('position', 'absolute');
  // The drawer's material sits behind its children, so nested popovers can
  // sample and blur the transcript instead of inheriting a backdrop boundary.
  await expect(details).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(details).toHaveCSS('backdrop-filter', 'none');
  const drawerMaterial = await details.evaluate(el => {
    const style = getComputedStyle(el, '::before');
    return { background: style.backgroundColor, frost: style.backdropFilter, pointerEvents: style.pointerEvents };
  });
  expect(drawerMaterial).toEqual({ ...sidebarMaterial, pointerEvents: 'none' });
  await expect(details).toHaveCSS('border-left-width', '0px');
  await expect(details).toHaveCSS('opacity', '1');
  await expect(page.locator('#project-board')).toHaveCSS('background-color', 'rgba(0, 0, 0, 0)');
  await expect(images(page)).toHaveCount(1);
});
