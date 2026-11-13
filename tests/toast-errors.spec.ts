import { expect, test, type Page } from '@playwright/test';
import { pauseClock } from './page-clock-helper';

// Toast (main.ts notify): close button, Escape, repeat count; and the global unhandled-rejection toast.
const toast = (page: Page) => page.locator('#toast');
const bot = (page: Page, text: string) => page.evaluate(t => (window as any).__previewEmit('bot-notification', { botId: 'b', text: t }), text);

test.describe('toast notices', () => {
  // Cold page loads take several seconds on a busy machine; the assertions themselves run on a paused clock.
  test.describe.configure({ timeout: 60_000 });
  // The page clock is installed at a fixed instant before the first script, boot runs on it in real time, and once the
  // app is up it is paused at a fixed instant far enough ahead that no boot reaches it (pauseAt cannot go back). From
  // then on time moves only with fastForward/runFor: a toast's 4.5 s life and Escape's 2 s grace cannot run out on a
  // loaded machine. stop_session calls are counted (window.__stops).
  const BOOT = Date.UTC(2026, 10, 11, 10), PAUSED_AT = BOOT + 10 * 60_000;
  test.beforeEach(async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch(), source = await response.text(), marker = /case ["']stop_session["']: \{/;
      expect(source).toMatch(marker);
      await route.fulfill({ response, body: source.replace(marker, match => `${match} window.__stops = (window.__stops || 0) + 1;`) });
    });
    await page.clock.install({ time: BOOT });
    await page.goto('/');
    await expect(page.locator('.task-item').first()).toBeVisible({ timeout: 30_000 });
    await pauseClock(page, PAUSED_AT);
  });

  test('the toast lives 4.5 s on the paused clock, and only the clock moves it', async ({ page }) => {
    await bot(page, 'Hello there');
    await expect(toast(page)).toBeVisible();
    await page.clock.runFor(4_000);
    await expect(toast(page)).toBeVisible();
    await page.clock.runFor(1_000);
    await expect(toast(page)).toBeHidden();
  });

  test('a failure repeating a plain notice starts a fresh danger toast instead of counting', async ({ page }) => {
    await bot(page, 'Project folder is missing');
    await expect(toast(page).locator('.toast-icon')).toHaveCount(0);
    await page.evaluate(() => { Promise.reject('Project folder is missing'); });
    await expect(toast(page).locator('.toast-icon[data-state-tone="danger"]')).toHaveCount(1);
    await expect(toast(page).locator('.toast-count')).toHaveCount(0);
  });

  test('with a dialog open, Escape closes the dialog and leaves a fresh error toast', async ({ page }) => {
    await page.locator('.task-item', { hasText: 'Explore the project' }).first().click({ button: 'right' });
    await page.getByRole('menuitem', { name: 'Rename…', exact: true }).click();
    const dialog = page.getByRole('dialog', { name: 'Rename task', exact: true });
    await expect(dialog).toBeVisible();
    await page.evaluate(() => { Promise.reject('Project folder is missing'); });
    await expect(toast(page)).toContainText('Project folder is missing');
    await page.keyboard.press('Escape');
    await expect(dialog).toBeHidden();
    await expect(toast(page)).toBeVisible();
  });

  test('at the narrowest window the toast stays off the composer controls', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 700 });
    await page.locator('.task-item', { hasText: 'Explore the project' }).first().click();
    await bot(page, 'A notice long enough to wrap onto a second line in the corner toast at this width.');
    await expect(toast(page)).toBeVisible();
    const overlaps = await page.evaluate(() => {
      const box = document.querySelector('#toast')!.getBoundingClientRect();
      return [...document.querySelectorAll<HTMLElement>('#composer-area button, #composer-area [role="button"], #composer-area textarea')].filter(node => {
        const r = node.getBoundingClientRect();
        return r.width && r.height && r.left < box.right && r.right > box.left && r.top < box.bottom && r.bottom > box.top;
      }).map(node => node.getAttribute('aria-label') || node.className);
    });
    await page.screenshot({ path: test.info().outputPath('toast-860.png') });
    expect(overlaps).toEqual([]);
  });

  test('close button dismisses the toast and is reachable by keyboard', async ({ page }) => {
    await bot(page, 'Hello there');
    await expect(toast(page)).toBeVisible();
    const close = toast(page).getByRole('button', { name: 'Dismiss' });
    await close.focus();
    await page.keyboard.press('Enter');
    await expect(toast(page)).toBeHidden();
  });

  test('only the toast text is a live region: its buttons are outside it, and a new toast reuses it', async ({ page }) => {
    // The region is there, empty, before the first toast: its first text is a change screen readers announce.
    const region = await toast(page).locator('.toast-text').elementHandle();
    await expect(toast(page).locator('.toast-text')).toHaveText('');
    await expect(toast(page).locator('.toast-text')).toHaveAttribute('role', 'status');
    await bot(page, 'Hello there');
    expect(await toast(page).locator('.toast-text').evaluate((label, before) => label === before, region)).toBe(true);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page)).not.toHaveAttribute('role', /.+/);
    await expect(toast(page)).not.toHaveAttribute('aria-live', /.+/);
    const live = toast(page).locator('[role="status"], [role="alert"], [aria-live]');
    await expect(live).toHaveCount(1);
    await expect(live).toHaveClass(/toast-text/);
    await expect(live).toHaveAttribute('role', 'status');
    // Not atomic: a count bump announces only "Repeated N times".
    await expect(live).toHaveAttribute('aria-atomic', 'false');
    await expect(live.locator('button')).toHaveCount(0);
    const node = await live.elementHandle();
    await bot(page, 'Other thing');
    await expect(live).toHaveText('Other thing');
    expect(await node!.evaluate(element => element.isConnected)).toBe(true);
  });

  test('a clamped toast shows its whole text while focus is in it or the pointer is on it', async ({ page }) => {
    const long = Array.from({ length: 12 }, (_, index) => `Line ${index} of a long failure message that wraps in the toast.`).join(' ');
    await bot(page, long);
    await expect(toast(page)).toBeVisible();
    const clamped = () => toast(page).evaluate(element => element.scrollHeight > element.clientHeight + 1 || getComputedStyle(element).webkitLineClamp !== 'none');
    expect(await clamped()).toBe(true);
    await toast(page).getByRole('button', { name: 'Dismiss' }).focus();
    expect(await clamped()).toBe(false);
    await page.locator('#prompt').focus();
    expect(await clamped()).toBe(true);
    await toast(page).hover();
    expect(await clamped()).toBe(false);
  });

  test('Escape dismisses a visible toast; a text title keeps the full message', async ({ page }) => {
    const long = 'A long notice. '.repeat(30).trim().slice(0, 160);
    await bot(page, long);
    await expect(toast(page)).toBeVisible();
    await expect(toast(page).locator('.toast-text')).toHaveAttribute('title', long);
    await page.keyboard.press('Escape');
    await expect(toast(page)).toBeHidden();
  });

  test('an identical message bumps only the count; the message text node is left alone', async ({ page }) => {
    await bot(page, 'Same thing');
    const text = await toast(page).locator('.toast-text').evaluateHandle(node => node.firstChild!);
    await page.evaluate(() => {
      (window as any).__toastMutations = [];
      new MutationObserver(records => { for (const record of records) (window as any).__toastMutations.push((record.target as Element).className ?? record.target.nodeName); })
        .observe(document.querySelector('#toast')!, { childList: true, subtree: true, characterData: true });
    });
    await bot(page, 'Same thing');
    await bot(page, 'Same thing');
    await expect(toast(page).locator('.toast-count')).toHaveText('×3');
    await expect(toast(page).locator('.toast-counter .sr-only')).toHaveText('Repeated 3 times');
    expect(await text.evaluate(node => node.isConnected)).toBe(true);
    expect(new Set(await page.evaluate(() => (window as any).__toastMutations))).toEqual(new Set(['toast-counter']));
    await bot(page, 'Other thing');
    await expect(toast(page).locator('.toast-count')).toHaveCount(0);
  });

  test('an unhandled rejection shows one calm toast without internals, and a loop does not spam', async ({ page }) => {
    const logged: string[] = [];
    page.on('console', message => { if (message.type() === 'error') logged.push(message.text()); });
    await page.evaluate(() => { for (let i = 0; i < 5; i++) Promise.reject(new TypeError("Cannot read properties of undefined (reading 'x')")); });
    await expect(toast(page)).toContainText('Something went wrong. If it keeps happening, restart PandaCode.');
    await expect(toast(page)).not.toContainText('Cannot read');
    await expect(toast(page).locator('.toast-icon[data-state-tone="danger"]')).toHaveCount(1);
    await expect(toast(page).locator('.toast-count')).toHaveCount(0);
    await expect.poll(() => logged.some(line => line.includes('Cannot read properties of undefined'))).toBe(true);
    await page.evaluate(() => { Promise.reject(new DOMException('stop', 'AbortError')); });
    await expect(toast(page)).not.toContainText('stop');
  });

  test('a rejected IPC call with a string reason shows that reason', async ({ page }) => {
    await page.evaluate(() => { Promise.reject('Project folder is missing'); });
    await expect(toast(page)).toContainText('Project folder is missing');
  });

  test('a plain notice keeps the accent dot; the close button is 28px', async ({ page }) => {
    await bot(page, 'Hello there');
    await expect(toast(page).locator('.toast-icon')).toHaveCount(0);
    const size = await toast(page).locator('.toast-close').evaluate(node => { const { width, height } = node.getBoundingClientRect(); return [width, height]; });
    expect(size.map(Math.round)).toEqual([28, 28]);
  });

  /** Starts a run in the open thread. */
  async function running(page: Page): Promise<void> {
    await page.locator('.task-item', { hasText: 'Explore the project' }).first().click();
    const session = await page.locator('.task-item.selected').getAttribute('data-id');
    await page.evaluate(id => (window as any).__previewEmit('agent-event', { sessionId: id, kind: 'status', text: 'Working' }), session);
    await expect(page.locator('#stream-region')).not.toBeEmpty();
  }
  const stops = (page: Page): Promise<number> => page.evaluate(() => (window as any).__stops ?? 0);

  test('while an agent runs, Escape closes an error toast that just appeared, then stops the agent', async ({ page }) => {
    await running(page);
    await page.evaluate(() => { Promise.reject('Project folder is missing'); });
    await expect(toast(page)).toContainText('Project folder is missing');
    await page.locator('body').press('Escape');
    await expect(toast(page)).toBeHidden();
    expect(await stops(page)).toBe(0);
    // With no toast in the way, Escape stops the agent as before.
    await page.locator('body').press('Escape');
    await expect.poll(() => stops(page)).toBe(1);
  });

  test('where :popover-open is not supported (WebKit before 17), Escape still stops the agent and closes toasts', async ({ page }) => {
    await page.evaluate(() => {
      for (const name of ['querySelector', 'querySelectorAll'] as const) {
        const original = Document.prototype[name] as (selector: string) => unknown;
        (Document.prototype as any)[name] = function (this: Document, selector: string) {
          if (selector.includes(':popover-open')) throw new DOMException(`'${selector}' is not a valid selector.`, 'SyntaxError');
          return original.call(this, selector);
        };
      }
    });
    await running(page);
    await page.locator('body').press('Escape');
    await expect.poll(() => stops(page)).toBe(1);
    await expect(toast(page)).toBeHidden();
    await page.evaluate(() => { Promise.reject('Project folder is missing'); });
    await expect(toast(page)).toContainText('Project folder is missing');
    await page.locator('body').press('Escape');
    await expect(toast(page)).toBeHidden();
  });

  test('a toast lifted above the composer is placed again when the composer grows', async ({ page }) => {
    await page.setViewportSize({ width: 860, height: 700 });
    await page.locator('.task-item', { hasText: 'Explore the project' }).first().click();
    await bot(page, 'A notice long enough to wrap onto a second line in the corner toast at this width.');
    await expect(toast(page)).toBeVisible();
    const gap = () => page.evaluate(() => document.querySelector('#composer-area')!.getBoundingClientRect().top - document.querySelector('#toast')!.getBoundingClientRect().bottom);
    // Polled: the entrance moves the toast a few pixels before it rests.
    await expect.poll(gap).toBeGreaterThanOrEqual(0);
    const before = await page.evaluate(() => document.querySelector('#composer-area')!.getBoundingClientRect().top);
    await page.locator('#prompt').fill(Array.from({ length: 8 }, (_, line) => `line ${line}`).join('\n'));
    await expect.poll(() => page.evaluate(() => document.querySelector('#composer-area')!.getBoundingClientRect().top)).toBeLessThan(before - 20);
    await expect.poll(gap).toBeGreaterThanOrEqual(0);
  });

  test('with the slash picker open and a toast visible, one Escape closes only the picker', async ({ page }) => {
    await page.locator('.task-item', { hasText: 'Explore the project' }).first().click();
    await page.locator('#prompt').fill('');
    await page.locator('#prompt').pressSequentially('/');
    const picker = page.locator('.slash-menu:not([aria-hidden="true"])');
    await expect(picker).toBeVisible();
    await bot(page, 'Hello there');
    await expect(toast(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(picker).toBeHidden();
    await expect(toast(page)).toBeVisible();
    await page.keyboard.press('Escape');
    await expect(toast(page)).toBeHidden();
  });

  // The other pickers a toast can sit beside: each takes the first Escape for itself (the toast's Escape checks
  // defaultPrevented and open menus), and the toast is closed only by the next.
  const pickers: { name: string; open: (page: Page) => Promise<void>; shown: (page: Page) => ReturnType<Page['locator']> }[] = [
    { name: 'file-mention picker', open: page => page.locator('#prompt').pressSequentially('@'), shown: page => page.locator('.file-mention-menu:not([aria-hidden="true"])') },
    { name: 'model picker', open: async page => { await page.locator('#model-picker-trigger').click(); await expect.poll(async () => { await page.clock.runFor(200); return page.locator('.model-menu').count(); }, { timeout: 30_000 }).toBe(1); }, shown: page => page.getByRole('dialog', { name: 'Harness and model', exact: true }) },
    { name: 'find bar', open: page => page.locator('#prompt').press('ControlOrMeta+f'), shown: page => page.getByRole('searchbox', { name: 'Find in thread', exact: true }) },
  ];
  // The model picker waits on preview IPC calls, which answer on timers, and the clock is paused: runFor lets them fire.
  for (const picker of pickers) {
    test(`with the ${picker.name} open and a toast visible, one Escape closes only the picker`, async ({ page }) => {
      await page.locator('.task-item', { hasText: 'Explore the project' }).first().click();
      await page.locator('#prompt').fill('');
      await picker.open(page);
      await expect(picker.shown(page)).toBeVisible();
      await bot(page, 'Hello there');
      await expect(toast(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(picker.shown(page)).toBeHidden();
      await expect(toast(page)).toBeVisible();
      await page.keyboard.press('Escape');
      await expect(toast(page)).toBeHidden();
    });
  }

  test('a plain notice that just appeared does not take Escape from Stop', async ({ page }) => {
    await running(page);
    await bot(page, 'Fresh notice');
    await expect(toast(page)).toBeVisible();
    await page.locator('body').press('Escape');
    await expect.poll(() => stops(page)).toBe(1);
    await expect(toast(page)).toBeVisible();
  });
});
