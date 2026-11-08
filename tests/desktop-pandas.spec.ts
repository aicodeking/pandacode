import { expect, test, type Page } from '@playwright/test';

const repository = 'https://github.com/aicodeking/pandacode';
const starRequest = 'I am sad because people are not starring my repo.. If you like it can you star it, please?';
const brand = (page: Page) => page.getByRole('button', { name: 'Replay PandaCode animation', exact: true });
const star = (page: Page) => page.getByRole('button', { name: 'Star PandaCode on GitHub', exact: true });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });

async function open(page: Page): Promise<void> {
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled({ timeout: 20_000 });
}

async function recordWindowOpens(page: Page): Promise<void> {
  await page.addInitScript(() => {
    (window as any).__externalUrlOpens = [];
    window.open = ((url?: string | URL) => {
      (window as any).__externalUrlOpens.push(String(url ?? ''));
      return null;
    }) as typeof window.open;
  });
}

const intro = (page: Page) => page.locator('.desktop-brand-launch');
const T0 = new Date('2026-11-08T12:00:00Z').getTime();

/** Freezes time before the first script runs, so startup proceeds only as the test advances it. */
async function openAtStartup(page: Page): Promise<void> {
  await page.clock.install({ time: T0 });
  await page.clock.pauseAt(T0 + 1000);
  await open(page);
  // A font finishing later counts as a layout change and would end the intro on its own.
  await page.evaluate(() => document.fonts.ready.then(() => undefined));
  await expect(intro(page)).toHaveCount(0);
  // Before the startup gate opens, the header mark must not flash ahead of the intro.
  expect(await stageOpacity(page)).toBe('0');
  await page.clock.runFor(100);
  await expect(page.locator('html')).toHaveAttribute('data-ready', '');
  await expect(intro(page)).toBeAttached();
  await expect(intro(page)).toHaveAttribute('aria-hidden', 'true');
  await expect(brand(page)).toHaveAttribute('data-brand-launch', '');
}

const stageOpacity = (page: Page) => brand(page).locator('.desktop-brand-stage').evaluate(el => getComputedStyle(el).opacity);

async function wanderPointer(page: Page): Promise<void> {
  for (const [x, y] of [[700, 300], [720, 340], [640, 420]]) await page.mouse.move(x, y, { steps: 3 });
  await page.clock.runFor(50);
}

test.describe('desktop pandas', () => {
  test('startup panda finishes its handoff and leaves the desktop brand visible', async ({ page }) => {
    await openAtStartup(page);
    await wanderPointer(page);
    await page.clock.runFor(500);
    await expect(intro(page)).toBeAttached();
    await page.clock.runFor(1500);
    await expect(intro(page)).toHaveCount(0);
    await expect(brand(page)).not.toHaveAttribute('data-brand-launch');
    await expect(brand(page)).toBeVisible();
    await expect.poll(() => stageOpacity(page)).toBe('1');
    await expect(brand(page)).toHaveText('PandaCode');
  });

  test('passive pointer movement leaves the startup panda running', async ({ page }) => {
    await openAtStartup(page);
    await wanderPointer(page);
    await prompt(page).hover();
    await expect(intro(page)).toBeAttached();
    await expect(brand(page)).toHaveAttribute('data-brand-launch', '');
  });

  test('startup panda yields to a click on the composer without losing input', async ({ page }) => {
    await openAtStartup(page);
    await wanderPointer(page);
    await expect(intro(page)).toBeAttached();
    await prompt(page).click();
    await expect(intro(page)).toHaveCount(0);
    await page.keyboard.type('Keep typing while PandaCode starts.');
    await expect(prompt(page)).toHaveValue('Keep typing while PandaCode starts.');
    await expect(prompt(page)).toBeFocused();
  });

  test('startup panda yields to typing without losing the first keystroke', async ({ page }) => {
    await openAtStartup(page);
    await prompt(page).focus();
    await expect(intro(page)).toBeAttached();
    await page.keyboard.type('Typed during the intro.');
    await expect(intro(page)).toHaveCount(0);
    await expect(prompt(page)).toHaveValue('Typed during the intro.');
    await expect(prompt(page)).toBeFocused();
  });

  test('reduced motion skips the intro and keeps the panda static on replay', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.clock.install();
    await open(page);
    await expect(page.locator('html')).toHaveAttribute('data-ready', '');
    await expect(brand(page)).toBeVisible();
    await expect(page.locator('.desktop-brand-launch')).toHaveCount(0);
    const stage = brand(page).locator('.desktop-brand-stage');
    const still = await stage.innerHTML();
    await brand(page).click();
    await page.clock.runFor(2000);
    expect(await stage.innerHTML()).toBe(still);
    await expect(page.locator('.desktop-brand-launch')).toHaveCount(0);
  });

  const titleBarCases = [
    { platform: 'other', width: 440, word: true },
    { platform: 'macos', width: 440, word: true },
    { platform: 'macos', width: 235, word: true },
    { platform: 'macos', width: 190, word: false },
  ] as const;
  for (const { platform, width, word } of titleBarCases) {
    test(`desktop PandaCode fits the 55px title bar on ${platform} at ${width}px`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 940 });
      await page.addInitScript(width => localStorage.setItem('pandacode.sidebarWidth', String(width)), width);
      await open(page);
      await page.evaluate(async platform => {
        const { initializeNativeAppearance } = await import('/src/appearance.ts');
        initializeNativeAppearance(async () => ({ platform, material: 'solid' }));
      }, platform);
      await expect(page.locator('html')).toHaveAttribute('data-native-platform', platform);
      await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width), { timeout: 15_000 }).toBe(width);
      await expect(brand(page)).toBeVisible();
      await expect(page.locator('.brand-name')).toHaveText('PandaCode');
      await expect(brand(page)).toHaveAttribute('data-tauri-drag-region', 'false');
      await expect(page.locator('.brand')).toHaveAttribute('data-tauri-drag-region', '');
      // The drawn mark (word and panda, which overflow the button box) must clear every neighbour.
      await expect(async () => {
        const m = await page.evaluate(() => {
          const box = (el: Element | null) => {
            if (!el || !el.getClientRects().length) return null;
            const style = getComputedStyle(el);
            if (style.visibility === 'hidden' || Number(style.opacity) === 0) return null;
            const r = el.getBoundingClientRect();
            return r.width > 0 && r.height > 0 ? { x: r.x, y: r.y, right: r.right, bottom: r.bottom } : null;
          };
          const host = document.querySelector<HTMLElement>('.brand-name')!;
          const word = host.querySelector<HTMLElement>('.desktop-brand-word');
          const probe = document.createElement('div');
          probe.style.cssText = 'position:absolute;visibility:hidden;width:var(--traffic-light-gutter)';
          document.body.append(probe);
          const gutter = probe.getBoundingClientRect().width;
          probe.remove();
          return {
            host: box(host), word: box(word), panda: box(host.querySelector('.desktop-brand-panda')),
            fontPx: word ? 20 * word.getBoundingClientRect().width / word.offsetWidth : 0,
            menu: box(document.querySelector('.brand #view-menu')), toggle: box(document.querySelector('#sidebar-toggle')),
            sidebar: box(document.querySelector('.sidebar')),
            gutter: document.documentElement.dataset.nativePlatform === 'macos' ? gutter : 0,
          };
        });
        expect(m.panda, 'panda is drawn').not.toBeNull();
        if (word) {
          expect(m.word, 'word is drawn').not.toBeNull();
          expect(m.fontPx, 'word stays legible').toBeGreaterThanOrEqual(11);
        }
        const parts = [m.host!, m.panda!, ...(m.word ? [m.word] : [])];
        for (const r of parts) {
          expect(r.y).toBeGreaterThanOrEqual(0);
          expect(r.bottom).toBeLessThanOrEqual(55);
          expect(r.x).toBeGreaterThanOrEqual(m.sidebar!.x + m.gutter);
          expect(r.right).toBeLessThanOrEqual(m.menu!.x);
          if (m.toggle) expect(r.right <= m.toggle.x || r.x >= m.toggle.right, 'clears the sidebar toggle').toBe(true);
        }
      }).toPass({ timeout: 10_000 });
    });
  }

  test('the 58px rail keeps its footer and hides the wordmark', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.setViewportSize({ width: 620, height: 940 });
    await open(page);
    await expect.poll(() => page.locator('.sidebar').evaluate(node => node.getBoundingClientRect().width), { timeout: 15_000 }).toBe(58);
    await expect(brand(page)).toBeHidden();
    await expect(page.locator('.sidebar-bottom > button')).toHaveCount(5);
  });

  // Each shape must render where its own SVG attributes put it: page CSS (a fill-box transform
  // origin, say) must never move a rotated eye or ear off the authored geometry.
  for (const [name, art] of [['star panda', '.star-panda-art'], ['header panda', '.brand-name .desktop-brand-panda']] as const) {
    test(`${name} eyes and ears render at their authored geometry`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: 1440, height: 940 });
      await open(page);
      await expect(page.locator(art).first()).toBeVisible();
      const drift = await page.locator(art).first().evaluate((svg: SVGSVGElement) => {
        const shapes = (root: Element) => [...root.querySelectorAll('ellipse, circle, path, rect')].filter(el => !el.closest('defs'));
        const units = svg.viewBox.baseVal.width;
        const measure = (root: SVGSVGElement) => {
          const frame = root.getBoundingClientRect();
          return shapes(root).map(el => {
            const r = el.getBoundingClientRect(), k = units / frame.width;
            return [(r.x - frame.x) * k, (r.y - frame.y) * k, r.width * k, r.height * k];
          });
        };
        const live = measure(svg);
        const clone = svg.cloneNode(true) as SVGSVGElement;
        for (const el of [clone, ...clone.querySelectorAll('*')]) { el.removeAttribute('class'); el.removeAttribute('style'); }
        clone.setAttribute('width', String(units * 10));
        clone.setAttribute('height', String(svg.viewBox.baseVal.height * 10));
        const holder = document.createElement('div');
        holder.style.cssText = 'position:fixed;left:0;top:0;pointer-events:none;opacity:0;contain:layout';
        holder.append(clone);
        document.body.append(holder);
        const authored = measure(clone);
        holder.remove();
        const named = shapes(svg).map(el => [...el.classList, el.closest('[data-part]')?.getAttribute('data-part'), el.parentElement?.getAttribute('class')].filter(Boolean).join(' '));
        return live.map((box, i) => ({ shape: `${i}:${named[i]}`, delta: Math.max(...box.map((v, j) => Math.abs(v - authored[i][j]))) }));
      });
      expect(drift.length).toBeGreaterThan(5);
      expect(drift.filter(d => d.delta > 0.25)).toEqual([]);
    });
  }

  test('star panda shares the exact hover and keyboard tooltip', async ({ page, browserName }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await open(page);
    await expect(star(page)).toHaveAccessibleDescription(starRequest);
    await expect(star(page)).not.toHaveAttribute('title');
    await star(page).hover();
    const tip = page.getByRole('tooltip');
    await expect(tip).toHaveCount(1);
    await expect(tip).toHaveClass(/tip-bubble/);
    await expect(tip).toHaveText(starRequest);
    await page.mouse.move(700, 300);
    await expect(tip).toHaveCount(0);
    await page.getByRole('button', { name: 'Settings', exact: true }).focus();
    // WebKit's default Tab skips buttons; Option-Tab is its full keyboard navigation.
    await page.keyboard.press(browserName === 'webkit' ? 'Alt+Tab' : 'Tab');
    await expect(star(page)).toBeFocused();
    await expect(tip).toHaveCount(1);
    await expect(tip).toHaveText(starRequest);
    await page.keyboard.press('Escape');
    await expect(tip).toHaveCount(0);
  });

  test('star panda opens the canonical repo once only after an explicit click', async ({ page }) => {
    const repoRequests: string[] = [];
    await page.route(/^https:\/\/(?:api\.)?github\.com\//, async route => {
      repoRequests.push(route.request().url());
      await route.abort();
    });
    await recordWindowOpens(page);
    await open(page);
    await star(page).hover();
    await expect(page.getByRole('tooltip')).toHaveText(starRequest);
    expect(await page.evaluate(() => (window as any).__externalUrlOpens)).toEqual([]);
    expect(repoRequests).toEqual([]);
    await star(page).click();
    await expect.poll(() => page.evaluate(() => (window as any).__externalUrlOpens)).toEqual([repository]);
    expect(repoRequests).toEqual([]);
    await expect(star(page)).toBeEnabled();
    await expect(page).toHaveURL(/\/$/);
  });

  for (const width of [190, 235, 440, 58]) {
    test(`sidebar footer fits ${width}px with Help first and star beside Settings`, async ({ page }) => {
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.setViewportSize({ width: width === 58 ? 620 : 1440, height: 940 });
      await page.addInitScript(width => localStorage.setItem('pandacode.sidebarWidth', String(width === 58 ? 235 : width)), width);
      await open(page);
      const sidebar = page.locator('.sidebar');
      await expect.poll(() => sidebar.evaluate(node => node.getBoundingClientRect().width)).toBe(width);
      const footer = page.locator('.sidebar-bottom');
      const buttons = footer.locator(':scope > button');
      await expect(buttons).toHaveCount(5);
      await expect(buttons.first()).toHaveAccessibleName('Help & support');
      await expect(footer.locator('[data-action="settings"] + button')).toHaveAccessibleName('Star PandaCode on GitHub');
      await expect(footer.locator('.star-panda + button')).toHaveAttribute('id', 'theme-toggle');
      const bounds = (await sidebar.boundingBox())!;
      const boxes = [];
      for (const button of await buttons.all()) {
        await expect(button).toBeVisible();
        await expect(button).toBeEnabled();
        const box = (await button.boundingBox())!;
        expect(box.width).toBeGreaterThanOrEqual(28);
        expect(box.height).toBeGreaterThanOrEqual(28);
        expect(box.x).toBeGreaterThanOrEqual(bounds.x);
        expect(box.x + box.width).toBeLessThanOrEqual(bounds.x + bounds.width);
        expect(box.y + box.height).toBeLessThanOrEqual(bounds.y + bounds.height);
        for (const previous of boxes) {
          const overlaps = box.x < previous.x + previous.width && box.x + box.width > previous.x
            && box.y < previous.y + previous.height && box.y + box.height > previous.y;
          expect(overlaps).toBe(false);
        }
        boxes.push(box);
      }
    });
  }
});
