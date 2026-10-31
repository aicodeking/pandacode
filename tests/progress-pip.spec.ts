import { expect, test, type Page } from '@playwright/test';

// The visual progress picture-in-picture over the first preview thread, opened with
// ?progress (six iterations from src/preview-progress.ts) or ?progress=many (40).
// Wide enough that the pane passes the 1000 px "start collapsed" threshold beside the inspector.
test.use({ viewport: { width: 1760, height: 960 } });
const errors = new WeakMap<Page, string[]>();
test.afterEach(async ({ page }) => { expect(errors.get(page) ?? []).toEqual([]); });

type Options = { collapsed?: boolean; query?: string; theme?: 'light' | 'dark'; running?: boolean };
async function open(page: Page, { collapsed = false, query = 'progress', theme, running = false }: Options = {}): Promise<void> {
  const runtime: string[] = []; errors.set(page, runtime);
  page.on('pageerror', error => runtime.push(error.message));
  await page.addInitScript(({ value, theme }) => {
    if (sessionStorage.getItem('pp-seeded')) return;
    sessionStorage.setItem('pp-seeded', '1');
    localStorage.setItem('pandacode.progressPip', JSON.stringify({ collapsed: value, corner: 'tl' }));
    if (theme) localStorage.setItem('pandacode.theme', theme);
  }, { value: collapsed, theme });
  if (running) await page.route('**/src/preview.ts*', async route => {
    // Runs stay open, as a long turn would, and every command is recorded.
    const response = await route.fetch(), source = await response.text(), marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `(window.__ppCalls ??= []).push(command);
      if (command === 'send_message') { session(args.sessionId).status = 'running'; return; }
      switch (command) {`) });
  });
  await page.goto(`/?${query}`);
  await expect(page.locator('#prompt')).toBeVisible();
  await expect(pip(page)).toBeVisible();
}
const pip = (page: Page) => page.locator('#progress-pip');
const pill = (page: Page) => page.locator('#progress-pip .pp-pill');
const card = (page: Page) => page.locator('#progress-pip .pp-card');
const meta = (page: Page) => card(page).locator('.pp-meta');
const live = (page: Page) => card(page).locator('.pp-layer:not(.is-leaving)');
const strip = (page: Page) => card(page).getByRole('group', { name: 'Iterations' });
const paneBox = async (page: Page) => (await page.locator('.conversation-pane').boundingBox())!;
const opacity = (page: Page) => card(page).evaluate(el => Number(getComputedStyle(el).opacity));
/** The stage shows exactly one layer, of this iteration. */
async function settled(page: Page, iteration: number, scope = card(page)): Promise<void> {
  await expect.poll(() => scope.locator('.pp-stage').evaluate(stage => {
    const layers = stage.querySelectorAll(':scope > .pp-layer');
    return layers.length === 1 ? layers[0].querySelector('.pp-media')?.getAttribute('alt') ?? '' : '';
  })).toMatch(new RegExp(`^Iteration ${iteration}:`));
}
/** Every finite, time-based animation on the page has finished (looping status pulses and
 * scroll-driven fades, such as the inspector tab strip's, keep going). */
const still = (page: Page) => page.waitForFunction(() => document.getAnimations().every(a => a.playState !== 'running' || a.timeline !== document.timeline || a.effect?.getTiming().iterations === Infinity));
async function shoot(page: Page, name: string, clip?: { width: number; height: number }): Promise<void> {
  await card(page).hover({ position: { x: 120, y: 14 } });
  await still(page);
  const pane = await paneBox(page);
  await page.screenshot({ path: `test-results/progress-pip-${name}.png`, ...(clip ? { clip: { x: pane.x, y: pane.y, ...clip } } : {}) });
}
/** Is the point at this fraction of the card's box hit by the PiP or by what lies under it? */
const hitsPip = (page: Page, fx: number, fy: number) => card(page).evaluate((el, [fx, fy]) => {
  const r = el.getBoundingClientRect();
  return Boolean(document.elementFromPoint(r.left + r.width * fx, r.top + r.height * fy)?.closest('#progress-pip'));
}, [fx, fy]);

test('sits top-left with numbered marks and a legend, and steps through the filmstrip', async ({ page }) => {
  await open(page, { theme: 'dark' });
  const pane = await paneBox(page), box = (await pip(page).boundingBox())!;
  expect(box.x - pane.x).toBeLessThan(30);
  expect(box.y - pane.y).toBeLessThan(30);
  expect(box.width).toBeLessThan(360);
  const composer = (await page.locator('#composer-area').boundingBox())!;
  expect(box.y + box.height).toBeLessThanOrEqual(composer.y);
  // Reached before the transcript in tab order.
  expect(await page.evaluate(() => Boolean(document.querySelector('#progress-pip')!.compareDocumentPosition(document.querySelector('#transcript')!) & Node.DOCUMENT_POSITION_FOLLOWING))).toBe(true);
  await expect(meta(page)).toContainText('Iteration 6 of 6');
  await settled(page, 6);
  await expect(live(page).locator('.pp-mark')).toHaveCount(3);
  await expect(live(page).locator('.pp-badge')).toHaveText(['1', '2', '3']);
  await expect(live(page).locator('.pp-chip.is-on')).toHaveCount(0);
  const legend = card(page).getByRole('list', { name: 'Annotations' });
  await expect(legend.getByRole('listitem')).toHaveText(['1Latency chart', '2Check icon contrast', '3Keyboard hint']);
  await expect(card(page).getByRole('img', { name: /Iteration 6: Dark theme/ })).toBeVisible();
  expect(await card(page).evaluate(el => el.scrollHeight <= el.clientHeight + 1)).toBe(true);
  await shoot(page, 'expanded-dark', { width: 520, height: 640 });
  // A legend row lights its mark and shows its label inside the stage.
  await legend.getByRole('listitem').nth(2).hover();
  const chip = live(page).locator('.pp-chip.is-on');
  await expect(chip).toHaveText('Keyboard hint');
  await expect(live(page).locator('.pp-badge.is-on')).toHaveText('3');
  const stage = (await card(page).locator('.pp-stage').boundingBox())!, label = (await chip.boundingBox())!;
  expect(label.x).toBeGreaterThanOrEqual(stage.x);
  expect(label.x + label.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
  expect(label.y).toBeGreaterThanOrEqual(stage.y);

  await strip(page).getByRole('button', { name: /^Iteration 3: Idea/ }).click();
  await expect(meta(page)).toContainText('Iteration 3 of 6');
  await expect(card(page).locator('.pp-tag').first()).toContainText('Idea');
  await expect(strip(page).getByRole('button', { name: /^Iteration 3/ })).toHaveAttribute('aria-current', 'step');
  await settled(page, 3);
  // Pins carry their own number: no extra badge.
  await expect(live(page).locator('.pp-badge')).toHaveCount(0);
  await expect(live(page).locator('.pp-pin-n')).toHaveText(['1', '2']);
  await page.keyboard.press('ArrowLeft');
  await expect(meta(page)).toContainText('Iteration 2 of 6');
  await expect(strip(page).getByRole('button', { name: /^Iteration 2/ })).toBeFocused();
  await page.keyboard.press('End');
  await expect(meta(page)).toContainText('Iteration 6 of 6');
  await card(page).getByRole('button', { name: 'Previous iteration', exact: true }).click();
  await expect(meta(page)).toContainText('Iteration 5 of 6');
  await settled(page, 5);
  await expect(live(page).locator('.pp-spot')).toHaveCount(1);
  // The toolbar is one tab stop with arrow keys.
  await page.keyboard.press('ArrowRight');
  await expect(card(page).getByRole('button', { name: 'Play iterations' })).toBeFocused();
  await expect(card(page).getByRole('button', { name: 'Play iterations' })).toHaveAttribute('tabindex', '0');
  const marks = card(page).getByRole('button', { name: 'Show annotations' });
  await marks.click();
  await expect(marks).toHaveAttribute('aria-pressed', 'false');
  await expect(live(page).locator('.pp-marks')).toHaveCount(0);
  await expect(legend).toHaveCount(0);
  await marks.click();
  await expect(live(page).locator('.pp-marks')).toHaveCount(1);
});

test('keeps a portrait snapshot short on a blurred band, in the light theme', async ({ page }) => {
  await open(page, { theme: 'light' });
  await strip(page).getByRole('button', { name: /^Iteration 5: Phone layout/ }).click();
  await settled(page, 5);
  const frame = (await live(page).locator('.pp-frame').boundingBox())!, stage = (await card(page).locator('.pp-stage').boundingBox())!;
  expect(frame.height / frame.width).toBeGreaterThan(1.8);
  expect(stage.height).toBeLessThanOrEqual(241);
  await expect(live(page).locator('.pp-band')).toHaveCount(1);
  await shoot(page, 'portrait', { width: 520, height: 640 });
  await strip(page).getByRole('button', { name: /^Iteration 4/ }).click();
  await settled(page, 4);
  await expect(live(page).locator('.pp-band')).toHaveCount(0);
  await shoot(page, 'expanded-light', { width: 520, height: 640 });
});

test('collapses to a pill, persists, and expands again', async ({ page }) => {
  await open(page);
  await card(page).getByRole('button', { name: 'Collapse visual progress' }).click();
  const button = page.getByRole('button', { name: /^Show visual progress, iteration 6 of 6/ });
  await expect(button).toBeFocused();
  await expect(button).toHaveAttribute('aria-expanded', 'false');
  await expect(button).toContainText('Dark theme and latency chart');
  await expect(button).toContainText('6 iterations');
  await expect(card(page)).toHaveCount(0);
  expect((await pill(page).boundingBox())!.width).toBeLessThanOrEqual(240);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('pandacode.progressPip') ?? '{}')).collapsed).toBe(true);
  await page.reload();
  await page.getByRole('button', { name: /^Show visual progress/ }).click();
  await expect(card(page).getByRole('button', { name: 'Collapse visual progress' })).toHaveAttribute('aria-expanded', 'true');
  await expect(pill(page)).toHaveCount(0);
  expect(JSON.parse(await page.evaluate(() => localStorage.getItem('pandacode.progressPip') ?? '{}')).collapsed).toBe(false);
  // Rapid toggling settles on the last request with one shape left.
  await card(page).getByRole('button', { name: 'Collapse visual progress' }).click();
  await page.getByRole('button', { name: /^Show visual progress/ }).click();
  await expect(card(page)).toHaveCount(1);
  await expect(pill(page)).toHaveCount(0);
});

test('starts collapsed in a narrow pane and softens while the pointer reads the transcript', async ({ page }) => {
  await page.setViewportSize({ width: 900, height: 800 });
  await open(page);
  await expect(pill(page)).toBeVisible();
  await expect(card(page)).toHaveCount(0);
  await still(page);
  await page.screenshot({ path: 'test-results/progress-pip-narrow.png' });
  await page.getByRole('button', { name: /^Show visual progress/ }).click();
  await expect(card(page)).toBeVisible();
  const transcript = (await page.locator('#transcript').boundingBox())!;
  await page.mouse.move(transcript.x + transcript.width - 60, transcript.y + 200);
  await expect.poll(() => opacity(page)).toBeLessThan(0.45);
  await page.mouse.move(transcript.x + transcript.width - 40, transcript.y + 220);
  await card(page).locator('.pp-head').hover();
  await expect.poll(() => opacity(page)).toBe(1);
  // With reduced motion the morph is instant and still leaves one shape.
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await card(page).getByRole('button', { name: 'Collapse visual progress' }).click();
  await expect(card(page)).toHaveCount(0);
  await expect(pill(page)).toBeFocused();
  await pill(page).click();
  await expect(card(page)).toBeVisible();
  await expect(pill(page)).toHaveCount(0);
});

test('softens while typing or scrolling by hand, lets clicks through, and wakes on hover', async ({ page }) => {
  await open(page);
  await settled(page, 6);
  // The app's own scrolling (stick to bottom) never softens it.
  await page.locator('#transcript').evaluate(el => { el.scrollTop = 0; el.dispatchEvent(new Event('scroll')); });
  await expect(pip(page)).not.toHaveClass(/is-dim/);
  await page.locator('#prompt').pressSequentially('Make the chart taller');
  await expect(pip(page)).toHaveClass(/is-dim/);
  await expect.poll(() => opacity(page)).toBeLessThan(0.6);
  // While soft only the header takes the pointer; the rest passes to the transcript.
  expect(await hitsPip(page, 0.5, 0.5)).toBe(false);
  expect(await hitsPip(page, 0.5, 0.03)).toBe(true);
  // Idle again: it comes back by itself.
  await expect(pip(page)).not.toHaveClass(/is-dim/, { timeout: 4000 });
  expect(await hitsPip(page, 0.5, 0.5)).toBe(true);
  const transcript = (await page.locator('#transcript').boundingBox())!;
  await page.mouse.move(transcript.x + transcript.width - 80, transcript.y + 120);
  await page.mouse.wheel(0, -200);
  await expect(pip(page)).toHaveClass(/is-dim/);
  await card(page).locator('.pp-head').hover();
  await expect(pip(page)).not.toHaveClass(/is-dim/);
  await expect.poll(() => opacity(page)).toBe(1);
});

test('the slideshow runs with the pointer on Play and holds only on the image', async ({ page }) => {
  await open(page);
  await strip(page).getByRole('button', { name: /^Iteration 1/ }).click();
  await expect(meta(page)).toContainText('Iteration 1 of 6');
  await card(page).getByRole('button', { name: 'Play iterations' }).click();
  const pause = card(page).getByRole('button', { name: 'Pause' });
  await expect(pause).toHaveAttribute('aria-pressed', 'true');
  // The pointer stays on the Play button: it keeps going.
  await expect(meta(page)).toContainText('Iteration 2 of 6', { timeout: 5000 });
  await card(page).locator('.pp-stage').hover();
  const ring = () => card(page).locator('.pp-ring circle').evaluate(el => el.getAnimations()[0]?.playState);
  await expect.poll(ring).toBe('paused');
  await expect(card(page).locator('.pp-ring')).toBeVisible();
  await page.waitForTimeout(600);
  await expect(meta(page)).toContainText('Iteration 2 of 6');
  await pause.hover();
  await expect.poll(ring).toBe('running');
  await expect(meta(page)).toContainText('Iteration 3 of 6', { timeout: 5000 });
  await pause.click();
  await expect(card(page).getByRole('button', { name: 'Play iterations' })).toHaveAttribute('aria-pressed', 'false');
});

test('Esc closes what the PiP has open and otherwise stays the app\'s', async ({ page }) => {
  await open(page, { running: true });
  const stops = () => page.evaluate(() => (window as any).__ppCalls.filter((c: string) => c === 'stop_session').length);
  await page.locator('#prompt').fill('Build the feature');
  await page.locator('#prompt').press('Enter');
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  await expect(card(page).locator('.pp-title .pp-live')).toBeVisible();
  await card(page).getByRole('button', { name: 'Open large view' }).press('Enter');
  await expect(page.locator('dialog.pp-lightbox')).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.pp-lightbox')).toHaveCount(0);
  await card(page).getByRole('button', { name: 'Clear visual history' }).click();
  await page.keyboard.press('Escape');
  await expect(card(page).locator('.pp-confirm')).toBeHidden();
  await strip(page).getByRole('button', { name: /^Iteration 2/ }).focus();
  await page.keyboard.press('Escape');
  await expect(pill(page)).toBeFocused();
  await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
  expect(await stops()).toBe(0);
  // Nothing left to close: Esc on the pill reaches the app, which stops the agent.
  await page.keyboard.press('Escape');
  await expect.poll(stops).toBe(1);
});

test('compares iterations, opens the lightbox with linked legend, and clears with confirmation', async ({ page }) => {
  await open(page);
  await settled(page, 6);
  await card(page).getByRole('button', { name: 'Compare with the previous iteration' }).click();
  const slider = card(page).getByRole('slider', { name: 'Compare iteration 5 with 6' });
  await expect(slider).toBeVisible();
  await expect(card(page).locator('.pp-stage > .pp-layer')).toHaveCount(1);
  await expect(live(page).locator('.pp-tag-before')).toHaveText('Before · 5');
  await expect(live(page).locator('.pp-tag-after')).toHaveText('After · 6');
  await slider.fill('40');
  await expect(live(page).locator('.pp-divider')).toHaveAttribute('style', /left:\s*40%/);
  await shoot(page, 'compare', { width: 520, height: 640 });
  await card(page).getByRole('button', { name: 'Compare with the previous iteration' }).click();
  await settled(page, 6);

  await card(page).getByRole('button', { name: 'Previous iteration', exact: true }).click();
  await settled(page, 5);
  await card(page).getByRole('button', { name: 'Previous iteration', exact: true }).click();
  await settled(page, 4);
  await card(page).getByRole('button', { name: 'Open large view' }).click();
  const box = page.getByRole('dialog', { name: /Iteration 4 of 6/ });
  await expect(box).toBeVisible();
  // Opened with the pointer: the dialog has focus, not the close button.
  await expect(box).toBeFocused();
  await settled(page, 4, box);
  // Numbered badges like the PiP; a legend row shows its label on the image.
  await expect(box.locator('.pp-badge')).toHaveText(['1', '2']);
  await expect(box.locator('.pp-pin-n')).toHaveText(['3']);
  await expect(box.locator('.pp-chip.is-on')).toHaveCount(0);
  const rows = box.getByRole('list', { name: 'Annotations' }).getByRole('listitem');
  await expect(rows).toHaveCount(3);
  await page.keyboard.press('ArrowRight');
  await expect(page.getByRole('dialog', { name: /Iteration 5 of 6/ })).toBeVisible();
  await page.keyboard.press('ArrowLeft');
  await settled(page, 4, box);
  await rows.nth(1).hover();
  await expect(box.locator('.pp-chip.is-on')).toHaveText('⌘K');
  const stage = (await box.locator('.pp-stage').boundingBox())!, chip = (await box.locator('.pp-chip.is-on').boundingBox())!;
  expect(chip.x + chip.width).toBeLessThanOrEqual(stage.x + stage.width + 0.5);
  expect(chip.y).toBeGreaterThanOrEqual(stage.y);
  await still(page);
  await page.screenshot({ path: 'test-results/progress-pip-lightbox.png' });
  await page.keyboard.press('Escape');
  await expect(page.locator('dialog.pp-lightbox')).toHaveCount(0);
  await expect(card(page).getByRole('button', { name: 'Open large view' })).toBeFocused();
  await expect(meta(page)).toContainText('Iteration 4 of 6');

  await card(page).getByRole('button', { name: 'Clear visual history' }).click();
  await expect(card(page).getByText('Clear all 6 iterations from this thread?')).toBeVisible();
  await card(page).getByRole('button', { name: 'Cancel' }).click();
  await expect(card(page).getByRole('button', { name: 'Clear visual history' })).toBeFocused();
  await card(page).getByRole('button', { name: 'Clear visual history' }).click();
  await card(page).getByRole('button', { name: 'Clear', exact: true }).click();
  await expect(pip(page)).toBeHidden();
  await expect(page.locator('#prompt')).toBeFocused();
});

test('glides to a new iteration when viewing the latest, nudges otherwise', async ({ page }) => {
  await open(page);
  const add = (title: string) => page.evaluate(async t => { const { previewProgress } = await import('/src/preview-progress.ts' as string); previewProgress.add('session-1', t); }, title);
  await add('Polish pass');
  await expect(meta(page)).toContainText('Iteration 7 of 7');
  await strip(page).getByRole('button', { name: /^Iteration 2/ }).click();
  await expect(strip(page).getByRole('button', { name: /^Iteration 2/ })).toBeFocused();
  await settled(page, 2);
  const stage = await live(page).elementHandle();
  await add('Second polish');
  await expect(meta(page)).toContainText('Iteration 2 of 8');
  await expect(card(page).getByRole('button', { name: 'Iteration 8: Second polish, new' })).toHaveClass(/is-new/);
  // The strip was appended to, not rebuilt: focus and the stage stay put.
  await expect(strip(page).getByRole('button', { name: /^Iteration 2/ })).toBeFocused();
  expect(await stage!.evaluate(el => el.isConnected && !el.classList.contains('is-leaving'))).toBe(true);
  await page.locator('#view-menu').first().click();
  await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(pip(page)).toBeHidden();
});

test('loads filmstrip thumbnails lazily and drops them on a thread switch', async ({ page }) => {
  await open(page, { query: 'progress=many' });
  await expect(meta(page)).toContainText('Iteration 40 of 40');
  const thumbs = card(page).locator('.pp-strip img[data-thumb]');
  await expect(thumbs).toHaveCount(40);
  await expect(thumbs.nth(39)).toHaveAttribute('src', /^data:image\//);
  const calls = () => page.evaluate(async () => (await import('/src/preview-progress.ts' as string)).previewProgress.thumbCalls.slice() as string[]);
  const loaded = await calls();
  expect(loaded.length).toBeLessThan(20);
  expect(loaded).not.toContain('many-1');
  await strip(page).getByRole('button', { name: /^Iteration 40/ }).focus();
  await page.keyboard.press('Home');
  await expect(meta(page)).toContainText('Iteration 1 of 40');
  await expect(thumbs.nth(0)).toHaveAttribute('src', /^data:image\//);
  expect(await calls()).toContain('many-1');
  // Another thread has no snapshots; coming back fetches the thumbnails again.
  const before = (await calls()).length;
  await page.locator('.task-item[data-id="session-4"]').click();
  await expect(pip(page)).toBeHidden();
  await page.locator('.task-item[data-id="session-1"]').click();
  await expect(meta(page)).toContainText('Iteration 40 of 40');
  await expect(thumbs.nth(39)).toHaveAttribute('src', /^data:image\//);
  expect((await calls()).length).toBeGreaterThan(before);
});
