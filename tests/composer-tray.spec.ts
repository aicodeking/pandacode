import { expect, test, type Page } from '@playwright/test';

const tray = (page: Page) => page.locator('#composer-area .composer-tray');
const mode = (page: Page) => page.locator('#mode-picker-trigger');
const saver = (page: Page) => page.locator('.composer-saver-button');
const iconColor = (page: Page) => mode(page).locator('.icon').first().evaluate(el => getComputedStyle(el).color);
const popped = (page: Page) => page.evaluate(() => (window as unknown as { trayLog: TrayLog }).trayLog.popped);

test('mode, Team, Saver and checkout are icons whose labels stay in the DOM', async ({ page }) => {
  await page.goto('/');
  await expect(tray(page)).toBeVisible();
  for (const [locator, text] of [[mode(page), 'Standard'], [saver(page), 'Saver'], [tray(page).locator('.composer-local'), 'Local']] as const) {
    await expect(locator).toContainText(text);
    await expect(locator.locator('.sr-only')).toHaveText(text);
    expect((await locator.boundingBox())!.width).toBeLessThan(44);
  }
  await expect(mode(page)).toHaveAttribute('data-tip', /^Standard:/);
  await expect(mode(page)).toHaveAccessibleName('Mode: Standard');
});

test('with no branch to show, the tray stays packed from the left', async ({ page }) => {
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch(), source = await response.text();
    await route.fulfill({ response, body: source.replace(/isRepo: true/, 'isRepo: false') });
  });
  await page.goto('/');
  await expect(tray(page)).toBeVisible();
  await expect(tray(page).locator('.composer-local')).toBeVisible();
  await expect(page.locator('#branch-chip')).toHaveCount(0);
  // While git status loads, a placeholder holds the branch's place on the right; once it has gone, nothing is left spread out.
  await expect(tray(page).locator('.branch-chip-pending')).toHaveCount(0);
  await expect.poll(() => tray(page).evaluate(row => {
    const boxes = [...row.querySelectorAll<HTMLElement>('.composer-tools, .composer-context > *')].filter(item => item.getClientRects().length).map(item => item.getBoundingClientRect());
    return Math.max(...boxes.slice(1).map((box, index) => box.left - boxes[index].right));
  })).toBeLessThan(16);
});

test('the branch chip names its branch and checkout in a tip, not a title', async ({ page }) => {
  await page.goto('/');
  const chip = page.locator('#branch-chip');
  await expect(chip).toHaveAttribute('data-tip', /^Branch \S+ · (checkout|worktree) at \//);
  await expect(chip).not.toHaveAttribute('title', /./);
});

test('each mode tones its icon and menu row, and only a real change pops', async ({ page }) => {
  await page.goto('/');
  await expect(mode(page)).toBeVisible();
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ready'));
  const neutral = await iconColor(page);
  const colors = new Set([neutral]);
  for (const name of ['Accept edits', 'Plan mode', 'Full access']) {
    await mode(page).click();
    const row = page.getByRole('menuitemradio', { name });
    await expect(row.locator('svg').first()).toHaveAttribute('data-state-tone', /edit|plan|full/);
    await record(page, '#mode-picker-trigger');
    await row.click();
    await expect(mode(page)).toContainText(name);
    await expect.poll(() => popped(page)).toBe(true);
    await expect.poll(async () => { await page.waitForTimeout(250); return iconColor(page); }).not.toBe(neutral);
    colors.add(await iconColor(page));
  }
  expect(colors.size).toBe(4);
  // A redraw of the same state plays nothing: a thread round trip redraws the composer.
  await page.waitForTimeout(250);
  await record(page, '#mode-picker-trigger');
  await page.locator('#navigation .task-item', { hasText: 'Add keyboard shortcuts' }).click();
  await page.waitForTimeout(400);
  expect(await popped(page)).toBe(false);
});

test('Saver on takes its tone and fill, and off goes back to neutral', async ({ page }) => {
  await page.goto('/');
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'false');
  const off = await saver(page).evaluate(el => getComputedStyle(el).backgroundColor);
  await saver(page).click();
  await page.locator('.saver-switch').first().click();
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'true');
  await page.keyboard.press('Escape');
  await expect.poll(() => saver(page).evaluate(el => getComputedStyle(el).backgroundColor)).not.toBe(off);
});

for (const width of [1200, 829, 640, 520, 420]) test(`the tray fits a ${width}px composer on one row`, async ({ page }) => {
  await page.goto('/');
  await page.locator('#navigation .task-item', { hasText: 'Add keyboard shortcuts' }).click();
  await expect(tray(page).locator('.link-chip')).toBeVisible();
  await page.locator('#composer-area').evaluate((el, width) => { el.style.width = `${width}px`; el.style.maxWidth = `${width}px`; }, width);
  await page.waitForTimeout(100);
  const fit = await tray(page).evaluate(el => {
    const edge = el.getBoundingClientRect().right, items = [...el.querySelectorAll<HTMLElement>('button,.composer-local,.composer-computer,.branch-chip,.link-chip')].filter(item => item.offsetWidth);
    return { overflow: el.scrollWidth - el.clientWidth, past: items.filter(item => item.getBoundingClientRect().right > edge + 1).length, tops: new Set(items.map(item => Math.round(item.getBoundingClientRect().top + item.offsetHeight / 2))).size };
  });
  expect(fit).toEqual({ overflow: 0, past: 0, tops: 1 });
  // The composer sits inside #composer-area's 30px side padding; plain Local hides at composer ≤460px by design.
  await expect(tray(page).locator('.composer-local')).toBeVisible({ visible: width - 60 > 460 });
});

test('every tray icon gives one tip, state first, on hover and on keyboard focus', async ({ page, browserName }) => {
  // WebKit on macOS skips buttons on a plain Tab (Safari's default); Alt+Tab walks every control.
  const tab = browserName === 'webkit' ? 'Alt+Tab' : 'Tab';
  await page.goto('/');
  await expect(mode(page)).toBeVisible();
  await expect(mode(page)).toHaveAttribute('aria-description', /\S/);
  const team = page.locator('#team-trigger');
  await expect(team).toHaveAttribute('aria-description', /^Team: off\./);
  const local = tray(page).locator('.composer-local');
  for (const [locator, tip] of [[mode(page), /^Standard:/], [team, /^Team: off\./], [saver(page), /^Token saver: off/], [local, /^Local:/]] as const) {
    await expect(locator).toHaveAttribute('data-tip', tip);
    await expect(locator).not.toHaveAttribute('title', /./);
    await locator.hover();
    await expect(page.locator('.tip-bubble')).toHaveText(tip);
    await page.mouse.move(0, 0);
  }
  // Keyboard: Tab from the mode button reaches Team and shows its tip.
  await mode(page).focus();
  await page.keyboard.press(tab);
  await expect(team).toBeFocused();
  await expect(page.locator('.tip-bubble')).toHaveText(/^Team: off\./);
  await local.focus();
  await page.keyboard.press(`Shift+${tab}`);
  await page.keyboard.press(tab);
  await expect(local).toBeFocused();
  await expect(page.locator('.tip-bubble')).toHaveText(/^Local:/);
});

test('Team\'s tip clears the prompt at 620px wide', async ({ page }) => {
  await page.setViewportSize({ width: 620, height: 800 });
  await page.goto('/');
  await page.locator('#team-trigger').hover();
  const bubble = (await page.locator('.tip-bubble').boundingBox())!, input = (await page.locator('#prompt').boundingBox())!;
  // Above the tray it may overlap the input's lower edge, but the prompt's first line stays readable.
  expect(bubble.y).toBeGreaterThan(input.y + 30);
});

test('computer, Local, worktree, Team and Terminal use different glyphs', async ({ page }) => {
  await page.goto('/');
  await expect(mode(page)).toBeVisible();
  const paths = async (selector: string) => page.locator(selector).first().locator('svg').first().innerHTML();
  const glyphs = [await paths('.composer-local'), await paths('#team-trigger'), await paths('[data-action="terminal"]')];
  expect(new Set(glyphs).size).toBe(glyphs.length);
});

/** Records whether a colour or fill transition started on `selector` (or inside it) and its icon popped, until read (`take`) and reset.
 * Both are caught where they start (`transitionrun`, `animate()`), not by sampling frames: a starved frame
 * under load can skip a whole 180 ms animation or transition. */
type TrayLog = { faded: boolean; popped: boolean };
const record = (page: Page, selector: string) => page.evaluate(sel => {
  const w = window as unknown as { trayLog: TrayLog; trayHooked?: boolean; traySel: string };
  w.trayLog = { faded: false, popped: false }; w.traySel = sel;
  if (w.trayHooked) return;
  w.trayHooked = true;
  const animate = Element.prototype.animate;
  Element.prototype.animate = function (this: Element, ...args: Parameters<Element['animate']>) {
    if (this.matches('.icon') && this.closest(w.traySel) && JSON.stringify(args[0]).includes('scale')) w.trayLog.popped = true;
    return animate.apply(this, args);
  };
  document.addEventListener('transitionrun', event => { if (/^(background-)?color$/.test(event.propertyName) && (event.target as Element).closest?.(w.traySel)) w.trayLog.faded = true; }, true);
}, selector);
/** Waits until the icon popped and the colour started fading (at most 1 s; a no-op change waits it out;
 * `transitionrun` lands a frame after the pop), then reads and resets. */
const take = async (page: Page) => {
  await page.waitForFunction(() => { const log = (window as unknown as { trayLog: TrayLog }).trayLog; return log.popped && log.faded; }, undefined, { timeout: 1000 }).catch(() => {});
  return page.evaluate(() => {
    const w = window as unknown as { trayLog: TrayLog }, out = w.trayLog;
    w.trayLog = { faded: false, popped: false }; return out;
  });
};

test('Team on and off and Saver on cross-fade their colour and pop the icon, only on a real change', async ({ page }) => {
  await page.goto('/');
  await page.waitForFunction(() => document.documentElement.hasAttribute('data-ready'));
  const team = page.locator('#team-trigger');
  await record(page, '#team-trigger');
  // Opening and closing the menu with no pick changes nothing (the first open loads the menu module).
  await team.click();
  await expect(page.getByRole('menuitemradio', { name: 'No team' })).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press('Escape');
  expect((await take(page)).popped).toBe(false);
  for (const [name, on] of [['Balanced team', ''], ['No team', null]] as const) {
    await team.click();
    await page.getByRole('menuitemradio', { name }).click();
    await expect.poll(() => team.getAttribute('data-on')).toBe(on);
    await expect(team).toHaveAttribute('aria-busy', 'false');
    // Popped, and its colour cross-faded.
    expect(await take(page)).toEqual({ faded: true, popped: true });
  }
  await saver(page).click();
  await record(page, '.composer-saver-button');
  await page.locator('.saver-switch').first().click();
  await expect(saver(page)).toHaveAttribute('aria-pressed', 'true');
  expect(await take(page)).toEqual({ faded: true, popped: true });
});
