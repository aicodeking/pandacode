import { expect, test, type Page } from '@playwright/test';

// The diff engine (@pierre/diffs worker pool and Shiki) loads at idle only while the inspector is open:
// with it closed, a project with git changes must not spawn diff workers on its own.

const DIFF_IDLE_AFTER = 15_000;

// At 920px or narrower a thread opens with the inspector closed, as when the user has closed it.
async function boot(page: Page): Promise<void> {
  await page.setViewportSize({ width: 900, height: 900 });
  await page.clock.install();
  await page.addInitScript(() => {
    const urls: string[] = [];
    (window as any).__workers = urls;
    const Native = window.Worker;
    (window as any).Worker = class extends Native {
      constructor(url: string | URL, options?: WorkerOptions) { super(url, options); urls.push(String(url)); }
    };
  });
  await page.goto('/');
  await page.waitForSelector('html[data-ready]');
}

const diffWorkers = (page: Page) => page.evaluate(() => ((window as any).__workers as string[]).filter(url => /diffs|worker\.js|worker-/i.test(url)).length);

test('with the inspector closed, no diff worker starts after the idle delay', async ({ page }) => {
  await boot(page);
  await expect(page.locator('#inspector')).toBeHidden();
  // Let git_status land (the preview checkout has changes), then pass the idle moment twice over.
  await page.clock.runFor(2_000);
  await page.clock.runFor(DIFF_IDLE_AFTER * 2);
  await page.evaluate(() => new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve))));
  await page.waitForTimeout(500);
  expect(await diffWorkers(page)).toBe(0);
});

test('opening the inspector warms the diff engine', async ({ page }) => {
  await boot(page);
  await page.clock.runFor(DIFF_IDLE_AFTER * 2);
  expect(await diffWorkers(page)).toBe(0);
  await page.locator('#inspector-toggle').click();
  await expect(page.locator('#inspector')).toBeVisible();
  await expect.poll(() => diffWorkers(page), { timeout: 10_000 }).toBeGreaterThan(0);
});
