import { expect, test, type Page } from '@playwright/test';

const support = (page: Page) => page.locator('[data-action="support"]');
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent' });

async function open(page: Page, behavior = 'mock'): Promise<void> {
  await page.addInitScript(({ behavior }) => {
    (window as any).__supportFixture = { behavior, calls: 0, opened: [] };
    window.open = (...args: any[]) => { (window as any).__supportFixture.opened.push(args); return null; };
  }, { behavior });
  await page.route('**/src/preview.ts*', async route => {
    const response = await route.fetch();
    const source = await response.text();
    const marker = /switch\s*\(command\)\s*\{/;
    expect(source).toMatch(marker);
    await route.fulfill({ response, body: source.replace(marker, `
      const supportFixture = window.__supportFixture;
      if (command === 'open_support') {
        supportFixture.calls++;
        supportFixture.args = args;
        if (supportFixture.behavior === 'hold') await new Promise(resolve => { supportFixture.resolve = resolve; });
        if (supportFixture.behavior === 'fail') throw new Error('Could not open support. Please try again.');
        if (supportFixture.behavior !== 'preview') return;
      }
      switch (command) {
    `) });
  });
  await page.goto('/', { waitUntil: 'domcontentloaded' });
  await expect(prompt(page)).toBeEnabled();
}

const calls = (page: Page) => page.evaluate(() => (window as any).__supportFixture.calls);

test('Help stays at the left of the sidebar footer and opens only on a keyboard request', async ({ page }) => {
  await open(page);
  await expect(support(page)).toHaveCount(1);
  await expect(support(page)).toHaveAccessibleName('Help & support');
  await expect(page.locator('.sidebar-bottom > button').first()).toHaveAttribute('data-action', 'support');
  await expect(support(page)).toBeVisible();
  expect(await calls(page)).toBe(0);
  await support(page).focus();
  await page.keyboard.press('Enter');
  await expect.poll(() => calls(page)).toBe(1);
  await expect(support(page)).toBeEnabled();
  expect(await page.evaluate(() => (window as any).__supportFixture.args)).toEqual({});
});

test('one Help button follows the sidebar and board without losing its DOM identity', async ({ page }) => {
  await open(page);
  const original = await support(page).elementHandle();
  await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
  await expect(page.locator('.header-leading > [data-action="support"]')).toBeVisible();
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(support(page)).toBeVisible();
  await expect(support(page)).toHaveCount(1);
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Conversation', exact: true }).click();
  await page.getByRole('button', { name: 'Show sidebar', exact: true }).click();
  await expect(page.locator('.sidebar-bottom > [data-action="support"]')).toBeVisible();
  expect(await original!.evaluate(node => node === document.querySelector('[data-action="support"]'))).toBe(true);
  expect(await calls(page)).toBe(0);
});

test('opening support gives immediate feedback and prevents duplicate opens across view changes', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await open(page, 'hold');
  await support(page).click();
  await expect(support(page)).toBeDisabled();
  await expect(support(page)).toHaveAttribute('aria-busy', 'true');
  await expect(support(page)).toHaveAccessibleName('Opening support…');
  await expect(support(page).locator('.support-spinner')).toBeVisible();
  await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click();
  await expect(support(page)).toBeVisible();
  await support(page).dispatchEvent('click');
  expect(await calls(page)).toBe(1);
  await page.evaluate(() => (window as any).__supportFixture.resolve());
  await expect(support(page)).toBeEnabled();
  await expect(support(page)).not.toHaveAttribute('aria-busy', 'true');
  await expect(support(page)).toHaveAccessibleName('Help & support');
});

test('support recovers after a failed browser launch', async ({ page }) => {
  await open(page, 'fail');
  await support(page).click();
  await expect(page.locator('#toast')).toHaveText('Could not open support. Please try again.');
  await expect(support(page)).toBeEnabled();
  await expect(page.locator('#dialog')).not.toBeVisible();
  await page.evaluate(() => { (window as any).__supportFixture.behavior = 'mock'; });
  await support(page).click();
  await expect.poll(() => calls(page)).toBe(2);
  await expect(support(page)).toHaveAccessibleName('Help & support');
});

test('preview opens the GitHub issue tracker without sending customer or workspace details', async ({ page }) => {
  await open(page, 'preview');
  await support(page).click();
  await expect.poll(() => page.evaluate(() => (window as any).__supportFixture.opened)).toEqual([
    ['https://github.com/aicodeking/pandacode/issues', '_blank', 'noopener,noreferrer'],
  ]);
});

test('Help stays visible in narrow windows with large interface text', async ({ page }) => {
  await page.setViewportSize({ width: 460, height: 740 });
  await page.addInitScript(() => localStorage.setItem('pandacode.uiScale', '1.6'));
  await open(page);
  for (const mode of ['sidebar', 'collapsed', 'board']) {
    if (mode === 'collapsed') await page.getByRole('button', { name: 'Hide sidebar', exact: true }).click();
    if (mode === 'board') { await page.getByRole('button', { name: /^Workspace view: / }).click(); await page.getByRole('menuitemradio', { name: 'Board', exact: true }).click(); }
    await expect(support(page)).toBeVisible();
    const rect = await support(page).boundingBox();
    expect(rect!.width).toBeGreaterThanOrEqual(28);
    expect(rect!.x).toBeGreaterThanOrEqual(0);
    expect(rect!.x + rect!.width).toBeLessThanOrEqual(460);
    expect(rect!.y + rect!.height).toBeLessThanOrEqual(740);
    await support(page).focus();
    await expect(support(page)).toBeFocused();
  }
});

test('Settings shows an About section with the version and GitHub links', async ({ page }) => {
  await open(page);
  await page.getByRole('button', { name: 'Settings', exact: true }).click();
  const settings = page.getByRole('region', { name: 'Settings', exact: true });
  await settings.getByRole('tab', { name: 'About & updates', exact: true }).click();
  const about = settings.locator('.settings-about');
  await expect(about).toBeVisible();
  await expect(about.locator('.settings-about-version')).toHaveText('Version Preview');
  const urls = await about.locator('[data-action="open-url"]').evaluateAll(nodes => nodes.map(node => (node as HTMLElement).dataset.url));
  expect(urls).toEqual(expect.arrayContaining([
    'https://github.com/aicodeking/pandacode',
    'https://github.com/aicodeking/pandacode/issues',
    'https://github.com/aicodeking/pandacode/releases',
  ]));
  await expect(about.getByRole('button', { name: 'Releases', exact: true })).toBeVisible();
  await expect(about.getByRole('button', { name: 'PandaCode License' })).toBeVisible();
  await expect(settings).not.toContainText('License & updates');
  await about.getByRole('button', { name: 'Releases', exact: true }).click();
  await expect.poll(() => page.evaluate(() => (window as any).__supportFixture.opened)).toEqual([
    ['https://github.com/aicodeking/pandacode/releases', '_blank', 'noopener,noreferrer'],
  ]);
});
