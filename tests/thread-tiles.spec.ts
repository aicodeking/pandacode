import { expect, test, type Locator, type Page } from '@playwright/test';

/** Reader input holds a sky for this long past the last wheel or key (`HOLD_MS` in src/sky-window.ts). */
const HOLD_MS = 150;
const row = (page: Page, id: string) => page.locator(`#navigation .task-item[data-id="${id}"]`);
const tile = (page: Page, id: string) => page.locator(`.thread-tile[data-tile="${id}"]`);
const box = async (page: Page, selector: string) => page.locator(selector).first().evaluate(node => { const { left, top, right, bottom } = node.getBoundingClientRect(); return { left, top, right, bottom }; });
async function open(page: Page) {
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto('/?cards');
  await expect(page.locator('#composer')).toBeVisible();
  await expect(page.locator('#navigation .task-item').nth(1)).toBeVisible();
}
async function threads(page: Page): Promise<string[]> {
  return page.locator('#navigation .task-item[data-id]').evaluateAll(rows => rows.map(node => (node as HTMLElement).dataset.id!));
}
const current = (page: Page) => page.locator('#navigation .task-item.selected').getAttribute('data-id');
/** An element's fill and its own `--bg`, read through a canvas so `rgb()`, `rgba()` and `color(srgb …)` resolve alike: the
 * glass is `color-mix(--bg 92%)`, so it has to match a tone AND an alpha, not merely "some alpha" (> .5 passes 88% too). */
const glass = (target: Locator) => target.evaluate(node => {
  const computed = getComputedStyle(node), probe = document.createElement('canvas').getContext('2d')!;
  // A canvas keeps its last fillStyle when handed a value it cannot parse, so clear it first and read the pixel back.
  const channels = (color: string) => {
    probe.fillStyle = '#000'; probe.fillStyle = color; probe.fillRect(0, 0, 1, 1);
    const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
    return { r, g, b, a };
  };
  return { backdrop: computed.backdropFilter, background: computed.backgroundColor,
    fill: channels(computed.backgroundColor), base: channels(computed.getPropertyValue('--bg').trim()) };
});
/** The documented glass: the element's own `--bg`, at 92% (92% of 255 is 234.6, and a canvas alpha is an 8-bit byte). */
function expectGlass(name: string, style: { backdrop: string; background: string; fill: { r: number; g: number; b: number; a: number }; base: { r: number; g: number; b: number } }): void {
  expect(style.backdrop, `${name}: a blur over a tile’s animating sky re-blurs its backdrop on every canvas frame and scroll step`).toBe('none');
  expect(Math.abs(style.fill.a - .92 * 255), `${name}: the fill ${style.background} must be --bg at 92%, the glass’s number`).toBeLessThanOrEqual(1.5);
  for (const channel of ['r', 'g', 'b'] as const)
    expect(Math.abs(style.fill[channel] - style.base[channel]), `${name}: the fill ${style.background} must resolve to this element’s own --bg ${JSON.stringify(style.base)}`).toBeLessThanOrEqual(1);
}

test.describe('thread tiles', () => {
  test('one thread has no tiles and the pane keeps its plain layout', async ({ page }) => {
    await open(page);
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    expect(await page.locator('.work-area').getAttribute('data-tiles')).toBeNull();
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('⌘-click opens a thread side by side, inside the thread area', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect.poll(() => current(page)).toBe(other);
    // A new tile arrives with a slight scale: read the positions once it has landed.
    await page.locator('.thread-tile').evaluateAll(tiles => Promise.all(tiles.flatMap(tile => tile.getAnimations().map(animation => animation.finished.catch(() => undefined)))));
    const a = await box(page, `.thread-tile[data-tile="${first}"]`), b = await box(page, `.thread-tile[data-tile="${other}"]`), area = await box(page, '.work-area');
    expect(a.top).toBe(b.top);
    expect(b.left).toBeGreaterThanOrEqual(a.right);
    for (const rect of [a, b]) { expect(rect.left).toBeGreaterThanOrEqual(area.left); expect(rect.right).toBeLessThanOrEqual(area.right); expect(rect.bottom).toBeLessThanOrEqual(area.bottom); }
    const sidebar = await box(page, '.sidebar'), inspector = await box(page, '#inspector');
    expect(a.left).toBeGreaterThanOrEqual(sidebar.right);
    expect(b.right).toBeLessThanOrEqual(inspector.left);
    // The real pane sits in the focused tile, under its bar.
    const pane = await box(page, '.work-area>.conversation-pane');
    expect(pane.left).toBe(b.left);
    expect(pane.top).toBe(b.top + 38);
    await expect(tile(page, other).locator('.thread-mirror')).toBeHidden();
    await expect(tile(page, first).locator('.thread-mirror')).toBeVisible();
    await expect(tile(page, first).locator('.turn-card, .message').first()).toBeVisible();
  });

  test('dragging a thread from the sidebar shows them side by side before the drop', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    const from = await row(page, other).boundingBox(), area = await box(page, '.work-area');
    await page.mouse.move(from!.x + 40, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 80, from!.y + 20, { steps: 3 });
    await page.mouse.move(area.right - 80, (area.top + area.bottom) / 2, { steps: 6 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect(tile(page, other)).toHaveAttribute('data-ghost', '');
    await expect(tile(page, other).locator('.turn-card, .message').first()).toBeVisible();
    // The pointer is on the right, so the dragged thread settles there.
    await expect.poll(async () => (await box(page, `.thread-tile[data-tile="${other}"]`)).left - (await box(page, `.thread-tile[data-tile="${first}"]`)).left).toBeGreaterThan(100);
    await page.mouse.up();
    await expect.poll(() => current(page)).toBe(other);
    await expect(tile(page, other)).not.toHaveAttribute('data-ghost', '');
    await expect(page.locator('.thread-tile')).toHaveCount(2);
  });

  test('a drag that leaves the area puts everything back', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    const from = await row(page, other).boundingBox(), area = await box(page, '.work-area');
    await page.mouse.move(from!.x + 40, from!.y + 10);
    await page.mouse.down();
    await page.mouse.move(from!.x + 80, from!.y + 20, { steps: 3 });
    await page.mouse.move(area.right - 80, (area.top + area.bottom) / 2, { steps: 6 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await page.mouse.move(from!.x + 40, from!.y + 10, { steps: 6 });
    await page.mouse.up();
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    expect(await current(page)).toBe(first);
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('clicking a view focuses it, and the sidebar replaces only the focused tile', async ({ page }) => {
    await open(page);
    const all = await threads(page), first = (await current(page))!, rest = all.filter(id => id !== first);
    await row(page, rest[0]).click({ modifiers: ['Meta'] });
    await expect.poll(() => current(page)).toBe(rest[0]);
    await tile(page, first).locator('.thread-mirror').click();
    await expect.poll(() => current(page)).toBe(first);
    await expect(tile(page, first).locator('.thread-mirror')).toBeHidden();
    await expect(tile(page, rest[0]).locator('.thread-mirror')).toBeVisible();
    await row(page, rest[1]).click();
    await expect(tile(page, rest[1])).toHaveCount(1);
    await expect(tile(page, first)).toHaveCount(0);
    await expect(tile(page, rest[0])).toHaveCount(1);
  });

  test('closing down to one thread returns to the plain pane, and tiles survive a reload', async ({ page }) => {
    await open(page);
    const all = await threads(page), first = (await current(page))!, rest = all.filter(id => id !== first);
    await row(page, rest[0]).click({ modifiers: ['Meta'] });
    await row(page, rest[1]).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(3);
    await page.reload();
    await expect(page.locator('#composer')).toBeVisible();
    const again = page.locator('.thread-tile');
    await expect(again).toHaveCount(3);
    await tile(page, rest[1]).locator('.thread-tile-bar').hover();
    await tile(page, rest[1]).locator('.thread-tile-close').click();
    await expect(again).toHaveCount(2);
    await tile(page, rest[0]).locator('.thread-tile-bar').hover();
    await tile(page, rest[0]).locator('.thread-tile-close').click();
    await expect(again).toHaveCount(0);
    expect(await page.locator('.conversation-pane').first().getAttribute('style')).toBeNull();
  });

  test('a window too small for the tiles shows the focused thread alone', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await page.setViewportSize({ width: 620, height: 700 });
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    await page.setViewportSize({ width: 1440, height: 900 });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
  });

  test('a wallpaper is cut to the tiles, so the frame shows between them and at their corners', async ({ page }) => {
    await page.addInitScript(() => localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: true, visibility: 60, blur: 0, set: 'automatic', pinned: null })));
    await open(page);
    await expect(page.locator('.workspace')).toHaveAttribute('data-scene', 'wallpaper');
    const clip = () => page.locator('.workspace-wallpaper').evaluate(node => (node as HTMLElement).style.clipPath);
    expect(await clip()).toBe('');
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect.poll(async () => ((await clip()).match(/M/g) ?? []).length).toBe(2);
    // The cut lines up with each tile, in the wallpaper's own coordinates.
    const cut = await page.evaluate(() => {
      const layer = document.querySelector<HTMLElement>('.workspace-wallpaper')!, from = layer.getBoundingClientRect();
      const left = [...layer.style.clipPath.matchAll(/M([\d.]+) ([\d.]+)/g)].map(match => Number(match[1]));
      return { left, tiles: [...document.querySelectorAll('.thread-tile')].map(tile => tile.getBoundingClientRect().left - from.left), radius: parseFloat(getComputedStyle(document.querySelector('.thread-tile')!).borderTopLeftRadius) };
    });
    cut.left.forEach((value, index) => expect(Math.abs(value - cut.radius - cut.tiles[index])).toBeLessThan(1));
    await tile(page, other).locator('.thread-tile-bar').hover();
    await tile(page, other).locator('.thread-tile-close').click();
    await expect(page.locator('.thread-tile')).toHaveCount(0);
    await expect.poll(clip).toBe('');
  });

  test('every tile shows its own thread in the sky and moves nothing under reduced motion', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    await expect(page.locator('.thread-tile>.thread-sky')).toHaveCount(2);
    expect(await page.evaluate(() => document.getAnimations().filter(animation => (animation.effect as KeyframeEffect | null)?.target?.closest?.('.thread-tile')).length)).toBe(0);
  });

  test('scrolling a tile’s own rows holds that tile’s sky, and it resumes after the hold', async ({ page }) => {
    // Every tile is its own `mountSky` (src/thread-tiles.ts), with its canvas behind the whole mirror, so "that tile stopped
    // painting" has to be counted per canvas: every paint is one full-screen `drawArrays(gl.TRIANGLES, 0, 3)`. Counting the
    // draw call is the only per-tile frame count there is — `window.__sky` is the main pane's instance.
    await page.addInitScript(() => {
      const paints = new WeakMap<HTMLCanvasElement, number>();
      const original = HTMLCanvasElement.prototype.getContext;
      HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, type: string, ...rest: unknown[]) {
        const context = (original as any).call(this, type, ...rest);
        if (type === 'webgl' && context && !context.__counted) {
          context.__counted = true;
          const drawArrays = context.drawArrays.bind(context);
          context.drawArrays = (mode: number, first: number, count: number) => {
            paints.set(context.canvas as HTMLCanvasElement, (paints.get(context.canvas) ?? 0) + 1);
            return drawArrays(mode, first, count);
          };
        }
        return context;
      } as typeof original;
      (window as any).__paints = (canvas: HTMLCanvasElement) => paints.get(canvas) ?? 0;
    });
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    // The unfocused tile is the live mirror, and its own scene has painted behind it.
    const layer = tile(page, first).locator(':scope>.thread-sky');
    await expect(layer).toHaveAttribute('data-gl', '');
    const rows = tile(page, first).locator('.thread-mirror-rows');
    await expect(rows).toBeVisible();
    // A tall row stands in for the long thread a reader scrolls, and the reader starts at its top.
    await rows.evaluate(node => {
      const long = document.createElement('div');
      long.style.height = '1200px';
      node.append(long);
    });
    expect(await rows.evaluate(node => node.scrollHeight - node.clientHeight), 'the tile’s rows scroll').toBeGreaterThan(200);
    await rows.evaluate(node => { node.scrollTop = 0; });
    const canvas = layer.locator(':scope>canvas:not(.thread-sky-fade)');
    const paints = () => canvas.evaluate(node => (window as any).__paints(node) as number);
    // A run in that thread keeps its own sky painting: `data-running` on the tile is what its `mountSky` reads.
    await tile(page, first).evaluate(node => node.setAttribute('data-running', ''));
    await expect(layer).toHaveAttribute('data-sky-state', 'moving');
    const before = await paints();
    await expect.poll(paints, { intervals: [50], timeout: 4000 }).toBeGreaterThan(before + 3);
    // A window opens on the wheel itself — the event that arms the hold — and closes at two thirds of HOLD_MS, in the page,
    // so no round trip can stretch it; one the box stalled past is dropped rather than counted.
    await page.evaluate(([selector, holdMs]) => {
      const read = window as any;
      read.__tileHold = [];
      const scroller = document.querySelector<HTMLElement>(selector)!;
      const canvas = scroller.closest('.thread-tile')!.querySelector<HTMLCanvasElement>('.thread-sky>canvas:not(.thread-sky-fade)')!;
      scroller.addEventListener('wheel', () => {
        if (read.__tileHold.length >= 40) return;
        const from = read.__paints(canvas), at = performance.now();
        window.setTimeout(() => {
          const to = read.__paints(canvas), took = Math.round(performance.now() - at);
          if (took <= holdMs - 5) read.__tileHold.push({ from, to, took });
        }, holdMs * 2 / 3);
      }, { capture: true, passive: true });
    }, [`[data-tile="${first}"] .thread-mirror-rows`, HOLD_MS] as const);
    const box = (await rows.boundingBox())!;
    await page.mouse.move(box.x + box.width / 2, box.y + 40);
    for (let notch = 0; notch < 4; notch++) { await page.mouse.wheel(0, 120); await page.waitForTimeout(120); }
    const windows = await page.evaluate(() => (window as any).__tileHold as { from: number; to: number; took: number }[]);
    expect(windows.length, 'the wheel reached the tile, and its sky held for it').toBeGreaterThan(0);
    for (const window of windows) expect(window.to, `no paint ${window.took} ms into the ${HOLD_MS} ms hold the wheel opens`).toBe(window.from);
    expect(await rows.evaluate(node => node.scrollTop), 'the wheel scrolled the tile’s rows').toBeGreaterThan(0);
    // The hold only defers that tile's loop: it paints again once the reader's hand is off.
    await expect.poll(paints, { intervals: [50], timeout: 4000 }).toBeGreaterThan(windows.at(-1)!.from);
    await expect(layer).toHaveAttribute('data-sky-state', 'moving');
  });

  test('the tile bar is a plain 92% fill, with no backdrop blur', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    // Each tile draws its own live sky behind its bar, so the bar is the main pane's plain glass: no blur (a blur here
    // re-blurs on every canvas frame and scroll step) and the documented 92% fill, not the 88% this rule carried while it
    // had one. Both bars, so an override on the focused tile cannot slip through.
    expectGlass('focused tile bar', await glass(tile(page, other).locator('.thread-tile-bar')));
    expectGlass('mirror tile bar', await glass(tile(page, first).locator('.thread-tile-bar')));
  });

  test('a tile’s mirror composer over its own scene is a plain fill, with no backdrop blur', async ({ page }) => {
    await open(page);
    const first = (await current(page))!, other = (await threads(page)).find(id => id !== first)!;
    await row(page, other).click({ modifiers: ['Meta'] });
    await expect(page.locator('.thread-tile')).toHaveCount(2);
    // The unfocused tile is the read-only view, and it holds the mirror composer.
    const mirror = tile(page, first).locator('.thread-mirror');
    await expect(mirror).toBeVisible();
    // The tile's own scene is on: its sky layer has painted behind the mirror.
    await expect(tile(page, first).locator(':scope>.thread-sky')).toHaveAttribute('data-gl', '');
    const composer = mirror.locator('.thread-mirror-composer');
    await expect(composer).toBeVisible();
    // The plain fill still has to carry the glass: the same `color-mix(--bg 92%)` the main pane gives its composer, checked
    // against this element's own tone, not merely "alpha > .5" (which an 88% or another surface's tint would also pass).
    expectGlass('mirror composer', await glass(composer));
  });
});
