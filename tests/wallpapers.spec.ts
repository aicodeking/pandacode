import { expect, test, type Page } from '@playwright/test';

test.use({ timezoneId: 'America/New_York' });

/** Wallpapers are off by default (the thread shows the sky); these specs start with them on unless a test saves its own choice. */
test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    if (localStorage.getItem('pandacode.wallpaperPreferences') === null && localStorage.getItem('pandacode.wallpapers') === null) {
      localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: true, visibility: 20, blur: 0, set: 'automatic', pinned: null }));
    }
  });
});
const scene = (page: Page) => page.locator('.workspace');
const images = (page: Page) => page.locator('.workspace-wallpaper img');
/** Wallpapers live in Settings → Appearance (off by default; the thread shows the sky). */
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

/** The scene fills the main pane (the thread is a window); the sidebar sits on the frame and never shows it. */
async function expectSceneCoversBars(page: Page) {
  await expectClearBars(page);
  const backdrop = await page.locator('.workspace-wallpaper').boundingBox();
  const main = await page.locator('.main-pane').boundingBox();
  expect(backdrop).not.toBeNull();
  expect(main).not.toBeNull();
  for (const edge of ['x', 'y', 'width', 'height'] as const) {
    expect(backdrop![edge]).toBeCloseTo(main![edge], 1);
  }
  for (const selector of ['.workspace-header']) {
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
    // Colours ease over 180 ms: sample what they settle on.
    await page.waitForTimeout(400);
    const highContrast = await barStyles(page);
    await page.emulateMedia({ contrast: 'no-preference' });
    await appearance(page);
    const toggle = page.getByRole('checkbox', { name: 'Wallpapers', exact: true });
    await toggle.check();
    await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
    await expectClearBars(page);
    await toggle.uncheck();
    await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
    await expect(images(page)).toHaveCount(0);
    await expect.poll(() => barStyles(page)).toEqual(normal);
    await toggle.check();
    await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
    await page.emulateMedia({ contrast: 'more' });
    await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
    await expect(images(page)).toHaveCount(0);
    await expect.poll(() => barStyles(page)).toEqual(highContrast);
  });
}

test('wallpapers change at noon without replacing the composer, draft, or open dropdown', async ({ page }) => {
  await open(page, '2026-09-14T11:59:59-04:00');
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  const prompt = page.getByRole('textbox', { name: 'Message your coding agent' });
  await prompt.fill('Keep my draft through the wallpaper transition');
  await page.getByRole('button', { name: /^Model: / }).click();
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
  const toggle = page.getByRole('checkbox', { name: 'Wallpapers', exact: true });
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
  await page.getByRole('checkbox', { name: 'Wallpapers', exact: true }).uncheck();
  release!();
  await page.clock.runFor(1000);
  await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
  await expect(images(page)).toHaveCount(0);
});

test('wallpapers give rounded board task details the frost material without a divider', async ({ page }) => {
  await page.setViewportSize({ width: 1100, height: 940 });
  await open(page);
  await expect(scene(page)).toHaveAttribute('data-wallpaper', 'mon-morning');
  // The drawer is the wallpaper frost material (--workspace-frost-surface over --workspace-frost).
  const sidebarMaterial = await page.locator('.workspace').evaluate(el => {
    const probe = document.createElement('div');
    probe.style.background = 'var(--workspace-frost-surface)'; probe.style.backdropFilter = 'var(--workspace-frost)';
    el.append(probe);
    const style = getComputedStyle(probe), material = { background: style.backgroundColor, frost: style.backdropFilter };
    probe.remove();
    return material;
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

/** The glass split, which is by scene and not by surface: a wallpaper is one decoded `<img>` with no frame loop, so its
 * frost is paid on a scroll step alone (src/turn-card.css `[data-scene="wallpaper"] .turn-card`, src/thread-tiles.css the
 * tile bar and the mirror composer); the sky paints its canvas every frame, so the same three surfaces carry no blur at all
 * there. The three numbers are named here rather than merely "some blur", so an edit that changes one fails in this spec;
 * colours are deliberately left alone, so a theme change cannot fail a test about frost. */
const CARD_FROST = 'blur(22px) saturate(1.25)', TILE_BAR_FROST = 'blur(16px) saturate(1.15)', TILE_COMPOSER_FROST = 'blur(22px) saturate(1.25)';
/** The reading column's own blur, and the one left after the split: `--thread-frost` in src/wallpapers.css, which
 * `.conversation-pane .composer` spends as its `backdrop-filter`. Over a wallpaper that is the only blur the thread pays
 * and it is paid on a scroll step (the wallpaper is one decoded `<img>`); over the sky the same variable is `none`
 * (src/sky-window.css), because the canvas paints every frame and a blur over it would re-blur its backdrop on each one.
 * Named, like the three above, so flipping either half of the variable fails here. */
const COMPOSER_FROST = 'blur(18px) saturate(1.1)';
const COMPOSER = '#composer-area .composer';
const backdrop = (page: Page, selector: string) => page.locator(selector).first()
  .evaluate(node => getComputedStyle(node).backdropFilter);
/** One value per surface. `-webkit-backdrop-filter` is deliberately not read: Chrome computes the prefixed property as the
 * standard one (an alias), so a rule that lost either half of the pair would fail here anyway. */
async function expectBackdrop(page: Page, what: string, selector: string, expected: string): Promise<void> {
  await expect(page.locator(selector).first(), `${what}: ${selector}`).toBeVisible();
  await expect.poll(() => backdrop(page, selector), `${what} must compute backdrop-filter: ${expected}`).toBe(expected);
}
/** The tiled layout, without the clock (`?cards`, as tests/thread-tiles.spec.ts opens it): ⌘-clicking a sidebar row gives two
 * tiles — the focused pane's turn card and the mirror's bar and composer, the three surfaces the split covers. */
async function tileTwoThreads(page: Page): Promise<void> {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?cards');
  await expect(page.locator('#composer')).toBeVisible();
  const rows = page.locator('#navigation .task-item[data-id]');
  await expect(rows.nth(1)).toBeVisible();
  const ids = await rows.evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.id!));
  const focused = await page.locator('#navigation .task-item.selected').getAttribute('data-id');
  const other = ids.find(id => id !== focused)!;
  await page.locator(`#navigation .task-item[data-id="${other}"]`).click({ modifiers: ['Meta'] });
  await expect(page.locator('.thread-tile')).toHaveCount(2);
  await expect(page.locator('.thread-tile-bar')).toHaveCount(2);
  // Every tile carries a mirror; only the one showing an unfocused thread is on screen.
  await expect(page.locator('.thread-mirror:not([hidden]) .thread-mirror-composer')).toHaveCount(1);
}

test('wallpapers keep the documented frost on the turn card, the tile bar and the mirror composer', async ({ page }) => {
  await tileTwoThreads(page);
  // Which scene the clock picks is not what this test is about: any wallpaper keeps the frost.
  await expect(scene(page)).toHaveAttribute('data-wallpaper', /^(mon|tue|wed|thu|fri|sat|sun)-(morning|afternoon|night)$/);
  await expect(scene(page)).toHaveAttribute('data-scene', 'wallpaper');
  // The card the reading pane draws, over the static scene: the frost the sky rule has to give up.
  await expectBackdrop(page, 'turn card', '.conversation-pane .turn-card', CARD_FROST);
  await expectBackdrop(page, 'tile bar', '.thread-tile-bar', TILE_BAR_FROST);
  await expectBackdrop(page, 'mirror composer', '.thread-mirror:not([hidden]) .thread-mirror-composer', TILE_COMPOSER_FROST);
});

test('over the sky the turn card, the tile bar and the mirror composer carry no blur', async ({ page }) => {
  // The animating canvas re-blurs its backdrop on every frame, so the frost above is wallpaper-only: `none` on all three.
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpaperPreferences',
    JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null })));
  await tileTwoThreads(page);
  await expect(scene(page)).not.toHaveAttribute('data-wallpaper');
  await expect(scene(page)).toHaveAttribute('data-scene', 'sky');
  await expectBackdrop(page, 'turn card', '.conversation-pane .turn-card', 'none');
  await expectBackdrop(page, 'tile bar', '.thread-tile-bar', 'none');
  await expectBackdrop(page, 'mirror composer', '.thread-mirror:not([hidden]) .thread-mirror-composer', 'none');
});

test('wallpapers keep the documented frost on the composer', async ({ page }) => {
  await open(page);
  await expect(scene(page)).toHaveAttribute('data-scene', 'wallpaper');
  // A non-`none` value that names the blur, not merely "some blur": this is the composer's whole material over a scene
  // that never repaints, so a flat composer is the regression, not a cheap one.
  const frost = await backdrop(page, COMPOSER);
  expect(frost, 'the composer keeps a blur over a wallpaper').not.toBe('none');
  expect(frost, 'the composer blur is the documented one').toContain('blur(18px)');
  await expectBackdrop(page, 'composer', COMPOSER, COMPOSER_FROST);
});

test('over the sky the composer carries no blur', async ({ page }) => {
  // Same element, animating backdrop: `--thread-frost` is `none` there, so the prompt box is a plain fill.
  await page.addInitScript(() => localStorage.setItem('pandacode.wallpaperPreferences',
    JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null })));
  await open(page);
  await expect(scene(page)).toHaveAttribute('data-scene', 'sky');
  await expectBackdrop(page, 'composer', COMPOSER, 'none');
});
