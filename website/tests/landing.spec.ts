import { test as base, expect, type Page, type TestInfo } from '@playwright/test';
import { mkdir, writeFile } from 'node:fs/promises';

const screenshots = '/private/tmp/pandacode-landing-checks';
const repo = 'https://github.com/aicodeking/pandacode';
const releases = `${repo}/releases/latest`;
const issues = `${repo}/issues`;
const test = base.extend<{ browserHealth: void }>({
  browserHealth: [async ({ page }, use) => {
    const errors: string[] = [];
    page.on('pageerror', error => errors.push(error.message));
    page.on('console', message => {
      if (message.type() === 'error' || message.type() === 'warning') errors.push(`${message.type()}: ${message.text()}`);
    });
    page.on('response', response => {
      if (response.status() >= 400) errors.push(`HTTP ${response.status()}: ${response.url()}`);
    });
    await use();
    expect(errors, 'The page should have no runtime errors, warnings, or missing resources').toEqual([]);
  }, { auto: true }],
});

async function capture(page: Page, info: TestInfo, name: string) {
  const live = Boolean(process.env.PANDACODE_SITE_URL);
  // WebKit always injects a stylesheet to sync screenshots, even with animations/carets unchanged.
  // Keep live CSP assertions strict; collect WebKit visual references in the local runs.
  if (live && info.project.use.browserName === 'webkit') return;
  const directory = `${screenshots}/${info.project.name}`;
  await mkdir(directory, { recursive: true });
  await page.screenshot({ path: `${directory}/${name}.png`, animations: live ? 'allow' : 'disabled', caret: live ? 'initial' : 'hide' });
}

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => ({ document: document.documentElement.scrollWidth, viewport: innerWidth })))
    .toEqual(expect.objectContaining({ document: await page.evaluate(() => innerWidth) }));
}

async function selectScene(page: Page, scene: string) {
  const button = page.locator(`[data-show-scene="${scene}"]`);
  await button.click();
  await expect(button).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator(`#story-demo [data-preview-scene="${scene}"]`)).toBeVisible();
}

test('hero, supported harnesses, and complete page have valid resources and responsive layout', async ({ page }, info) => {
  await page.goto('/');
  await expect(page).toHaveTitle('PandaCode — A calmer place to build.');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Great work.A calmer place.');
  await expect(page.locator('.hero-landscape img')).toBeVisible();
  await expect(page.locator('.hero-description')).toHaveText('Your favorite coding agents.One thoughtfully quiet workspace.');
  for (const id of ['hero-distribution', 'download-distribution']) {
    const disclosure = page.locator(`#${id}`);
    await expect(disclosure).toContainText('macOS · Windows · Linux');
    await expect(disclosure).toContainText('Unsigned build');
    await expect(disclosure).toContainText('Windows x64 and arm64: unsigned installer');
    await expect(disclosure).toContainText('Linux x86_64 and aarch64: AppImage');
    await expect(disclosure).toContainText('Apple silicon or Intel · macOS 12+');
    await expect(disclosure).toContainText('Not notarized by Apple');
    await expect(disclosure).toContainText('macOS blocks the first launch');
    await expect(disclosure.getByRole('link', { name: /First-launch help/ })).toHaveAttribute('href', 'https://support.apple.com/en-us/102445');
    await expect(page.locator(`[data-download][aria-describedby~="${id}"]`)).toHaveCount(1);
  }
  await capture(page, info, 'hero');
  for (const name of ['Claude Code', 'Codex', 'Kimi Code', 'OpenCode', 'GLM', 'Antigravity']) {
    await expect(page.locator('.harness-list')).toContainText(name);
  }
  for (const section of ['#hero-demo', '#whats-new', '.nf-grid', '#experience', '.overlay-feature', '#your-space', '#open-source', '#comparison', '#download', '#preview-notes']) {
    await page.locator(section).scrollIntoViewIfNeeded();
    await expectNoOverflow(page);
  }
  await expect(page.locator('#preview-notes')).toContainText('free, open-source software');
  await expect(page.locator('#preview-notes')).toContainText('provider subscriptions and model usage are separate');
  await expect(page.locator('#preview-notes')).toContainText('Apple silicon and Intel Macs, Windows x64 and arm64, and Linux x86_64 and aarch64 are published on GitHub Releases');
  await expect(page.locator('#preview-notes').getByRole('link', { name: 'PandaCode License' })).toHaveAttribute('href', '/license/');
  await expect(page.locator('#preview-notes').getByRole('link', { name: /Report an issue/ })).toHaveAttribute('href', issues);
  await expect.poll(() => page.locator('img:visible').evaluateAll(images => images.filter(image => !(image as HTMLImageElement).complete || !(image as HTMLImageElement).naturalWidth).map(image => (image as HTMLImageElement).src))).toEqual([]);
  const resources = await page.evaluate(() => performance.getEntriesByType('resource').map(entry => {
    const resource = entry as PerformanceResourceTiming;
    return { name: new URL(resource.name).pathname, type: resource.initiatorType, transferred: resource.transferSize, decoded: resource.decodedBodySize };
  }));
  await mkdir(`${screenshots}/${info.project.name}`, { recursive: true });
  await writeFile(`${screenshots}/${info.project.name}/resources.json`, JSON.stringify(resources, null, 2));
});

async function expectPreviewDisclosures(page: Page) {
  const badge = page.locator('.navigation .release-tag');
  await expect(badge).toBeVisible();
  await expect(badge).toHaveText('Preview');
  const brand = page.locator('.navigation .wordmark');
  const [brandBox, badgeBox] = await Promise.all([brand.boundingBox(), badge.boundingBox()]);
  expect(brandBox).not.toBeNull();
  expect(badgeBox).not.toBeNull();
  expect(Math.abs((brandBox!.y + brandBox!.height / 2) - (badgeBox!.y + badgeBox!.height / 2))).toBeLessThan(20);
  expect(badgeBox!.x - brandBox!.x - brandBox!.width).toBeLessThan(32);
  for (const id of ['hero-alpha', 'download-alpha']) {
    const disclosure = page.locator(`#${id}`);
    await disclosure.scrollIntoViewIfNeeded();
    await expect(disclosure).toBeVisible();
    await expect(disclosure).toContainText('An Alpha preview.');
    await expect(disclosure).toContainText('Expect bugs and changes');
    const download = page.locator(`[data-download][aria-describedby~="${id}"]`);
    await expect(download).toHaveCount(1);
    expect(await disclosure.evaluate((notice, id) => Boolean(notice.compareDocumentPosition(document.querySelector(`[data-download][aria-describedby~="${id}"]`)!) & Node.DOCUMENT_POSITION_FOLLOWING), id)).toBe(true);
    const descriptions = (await download.getAttribute('aria-describedby'))!.split(/\s+/);
    expect(descriptions).toContain(id.replace('-alpha', '-distribution'));
  }
}

async function expectPrivacyDetails(page: Page) {
  const privacy = page.locator('#privacy');
  await privacy.scrollIntoViewIfNeeded();
  await expect(privacy.getByRole('heading', {name: 'Your work. Your business.'})).toBeVisible();
  await expect(privacy).toContainText(/local|on your Mac/i);
  await expect(privacy).toContainText(/provider|third.party/i);
  await expect(privacy.locator('.privacy-intro')).toContainText('PandaCode collects nothing.');
  await expect(privacy.locator('.privacy-intro')).toContainText('no telemetry, no analytics');
  await expect(privacy).not.toContainText(/Cloudflare Web Analytics|Featurebase|Stripe|license key/i);
  await expect(privacy.getByRole('link', {name: 'GitHub issues'})).toHaveAttribute('href', issues);
  const details = privacy.locator('details');
  const summary = details.locator('summary');
  await expect(summary).toHaveAccessibleName('What about this website?');
  await expect(details).not.toHaveAttribute('open', '');
  await summary.click();
  await expect(details).toHaveAttribute('open', '');
  await expect(details).toContainText('sets no cookies, runs no analytics');
  await expect(details).toContainText('standard server logs');
  await expect(details.locator('p').first()).toBeVisible();
  await summary.click();
  await expect(details).not.toHaveAttribute('open', '');
  await expect(privacy.getByRole('link', {name: /full privacy policy/})).toHaveAttribute('href', '/privacy/');
  const footer = page.locator('footer');
  await expect(footer.getByRole('link', {name: 'Privacy', exact: true})).toHaveAttribute('href', '/privacy/');
  await expect(footer.getByRole('link', {name: 'License', exact: true})).toHaveAttribute('href', '/license/');
  await expect(footer.getByRole('link', {name: 'Changelog', exact: true})).toHaveAttribute('href', '/changelog/');
  await expect(footer.getByRole('link', {name: 'GitHub', exact: true})).toHaveAttribute('href', repo);
  await expect(footer.getByRole('link', {name: 'Support', exact: true})).toHaveAttribute('href', issues);
  await expect(footer.getByRole('link', {name: 'Terms'})).toHaveCount(0);
}

async function expectComparison(page: Page) {
  const comparison = page.locator('#comparison');
  await comparison.scrollIntoViewIfNeeded();
  const table = comparison.getByRole('table');
  await expect(table).toBeVisible();
  const headers = table.getByRole('columnheader');
  await expect(headers).toHaveCount(5);
  for (const [index, name] of ['Feature', 'PandaCode', 'T3 Code', 'Conductor', 'Herdr'].entries()) {
    await expect(headers.nth(index)).toContainText(name);
    await expect(headers.nth(index)).toHaveAttribute('scope', 'col');
  }
  await expect(table).toHaveAccessibleName(/PandaCode.*T3 Code.*Conductor.*Herdr/);
  expect(await table.locator('tbody tr').count()).toBeGreaterThan(1);
  await expect(table.getByRole('row', {name: /Price & license/})).toContainText('Open source · MIT-based · No account');
  await expect(table).not.toContainText('$20');
  const sources = await comparison.locator('a[href^="https://"]').evaluateAll(links => links.map(link => ({name: link.textContent?.trim(), href: (link as HTMLAnchorElement).href})));
  expect(new Set(sources.map(source => new URL(source.href).hostname)).size).toBeGreaterThanOrEqual(3);
  for (const name of ['T3 Code', 'Conductor', 'Herdr']) expect(sources.some(source => source.name?.includes(name))).toBe(true);
  await expectNoOverflow(page);
}

test('preview disclosures, privacy details, and comparison remain clear before download', async ({page, browserName}, info) => {
  await page.goto('/');
  await expectPreviewDisclosures(page);
  await expectPrivacyDetails(page);
  await capture(page, info, 'privacy');
  await expectComparison(page);
  await capture(page, info, 'comparison');
  const scroll = page.locator('#comparison [tabindex="0"]');
  await expect(scroll).toHaveCount(1);
  await scroll.focus();
  await expect(scroll).toBeFocused();
  if (info.project.use.isMobile) {
    expect(await scroll.evaluate(element => element.scrollWidth > element.clientWidth)).toBe(true);
    if (browserName === 'webkit') {
      // Mobile WebKit lacks native keyboard scrolling in Playwright; focus and overflow are verified separately.
      await scroll.evaluate(element => element.scrollBy({left: 160, behavior: 'instant'}));
    } else await scroll.press('ArrowRight');
    await expect.poll(() => scroll.evaluate(element => element.scrollLeft)).toBeGreaterThan(0);
    await expectNoOverflow(page);
  }
});

test('download and source links go to GitHub, open safely, and fetch nothing until clicked', async ({page, context}) => {
  const githubRequests: string[] = [];
  await context.route('https://github.com/**', route => {
    githubRequests.push(route.request().url());
    return route.fulfill({contentType: 'text/html', body: '<h1>GitHub</h1>'});
  });
  await page.goto('/');
  const hero = page.locator('.hero-actions');
  await expect(hero.getByRole('link', {name: /Download PandaCode/})).toHaveAttribute('href', releases);
  await expect(hero.getByRole('link', {name: /Star on GitHub/})).toHaveAttribute('href', repo);
  await expect(page.locator('.download-content').getByRole('link', {name: /Download PandaCode/})).toHaveAttribute('href', releases);
  await expect(page.locator('.download-content').getByRole('link', {name: /View the source on GitHub/})).toHaveAttribute('href', repo);
  const direct = page.locator('[data-platform-download]');
  await expect(direct).toHaveCount(6);
  for (const [index, file] of [
    'PandaCode-macOS-arm64.dmg', 'PandaCode-macOS-x64.dmg',
    'PandaCode-Windows-x64-setup.exe', 'PandaCode-Windows-arm64-setup.exe',
    'PandaCode-Linux-x86_64.AppImage', 'PandaCode-Linux-aarch64.AppImage',
  ].entries()) {
    await expect(direct.nth(index)).toHaveAttribute('href', `${repo}/releases/latest/download/${file}`);
  }
  for (const link of await page.locator('a[href^="https://github.com/"]:not([data-platform-download])').all()) {
    await expect(link).toHaveAttribute('target', '_blank');
    await expect(link).toHaveAttribute('rel', /noopener/);
  }
  await expect(page.locator('[data-checkout], .checkout-feedback, .noscript-note')).toHaveCount(0);
  await expect(page.locator('a[href*="/account"], a[href*="/terms"], a[href*="featurebase"]')).toHaveCount(0);
  await expect(page.locator('body')).not.toContainText(/\$20|Stripe|Opening checkout|Cancel anytime|two devices|PandaCode Pro/i);
  expect(githubRequests).toEqual([]);
  const opened = context.waitForEvent('page');
  await hero.getByRole('link', {name: /Download PandaCode/}).click();
  const tab = await opened;
  await expect(tab).toHaveURL(releases);
  expect(await tab.evaluate(() => window.opener)).toBeNull();
  expect(githubRequests).toEqual([releases]);
  await tab.close();
});

test('the open-source section explains the license, privacy and building from source', async ({ page }) => {
  await page.goto('/');
  const pill = page.locator('.hero-pills').getByRole('link', { name: /Free & open source/ });
  await expect(pill).toBeVisible();
  await expect(pill).toContainText('OSS');
  await pill.click();
  const section = page.locator('#open-source');
  await expect(section).toBeInViewport();
  await expect(section.getByRole('heading', { level: 2 })).toHaveText('Free to use.Open to everyone.');
  for (const fact of ['MIT-based license.', 'No account.', 'No telemetry.', 'Bring your own agents.', 'Built in the open.']) await expect(section).toContainText(fact);
  const build = section.locator('pre');
  for (const command of [`git clone ${repo}.git`, 'cd pandacode', 'npm ci', 'npm run desktop']) await expect(build).toContainText(command);
  await expect(section.getByRole('link', { name: /Star on GitHub/ })).toHaveAttribute('href', repo);
  await expect(section.getByRole('link', { name: /Contribute/ })).toHaveAttribute('href', issues);
  await expect(section.getByRole('link', { name: /Read the license/ })).toHaveAttribute('href', '/license/');
  await expectNoOverflow(page);
});

test('the site makes only same-origin requests and hosts no checkout, account or downloads', async ({ page, request, baseURL }) => {
  const origin = new URL(baseURL!).origin;
  const requests: string[] = [];
  page.on('request', req => requests.push(req.url()));
  for (const path of ['/', '/changelog/', '/privacy/', '/license/']) {
    await page.goto(path);
    await page.evaluate(async () => {
      for (let y = 0; y < document.documentElement.scrollHeight; y += innerHeight / 2) {
        window.scrollTo({ top: y, behavior: 'instant' });
        await new Promise(resolve => setTimeout(resolve, 40));
      }
    });
    await page.waitForLoadState('networkidle');
  }
  const foreign = requests.filter(url => !url.startsWith('data:') && new URL(url).origin !== origin);
  expect(foreign, 'Every request should stay on this site').toEqual([]);
  for (const path of ['/account', '/terms/', '/downloads/PandaCode-macOS-arm64.zip']) {
    expect((await request.get(path)).status(), path).toBe(404);
  }
});

test('scroll follows all four story chapters and manual controls remain selected until scrolling', async ({ page, browserName }, info) => {
  await page.goto('/');
  for (const scene of ['conversation', 'board', 'team', 'review']) {
    const chapter = page.locator(`.story-step[data-scene="${scene}"]`);
    await chapter.scrollIntoViewIfNeeded();
    await expect(page.locator('#story-demo .app-window')).toHaveAttribute('data-current-scene', scene);
    await expect(page.locator(`[data-show-scene="${scene}"]`)).toHaveAttribute('aria-pressed', 'true');
    await expectNoOverflow(page);
    if (scene === 'board') await capture(page, info, 'storyboard');
  }
  await selectScene(page, 'board');
  await selectScene(page, 'team');
  await selectScene(page, 'conversation');
  await expect(page.locator('#story-demo .app-window')).toHaveAttribute('data-current-scene', 'conversation');
  if (browserName === 'webkit' && info.project.use.isMobile) {
    // Playwright mobile WebKit has no wheel/swipe API or native keyboard scrolling.
    await page.locator('body').dispatchEvent('touchmove');
    await page.evaluate(() => window.scrollBy({ top: 20, behavior: 'instant' }));
  } else await page.mouse.wheel(0, 20);
  await expect(page.locator('#story-demo .app-window')).toHaveAttribute('data-current-scene', 'review');
  if (!(browserName === 'webkit' && info.project.use.isMobile)) {
    await page.locator('.story-step[data-scene="board"]').scrollIntoViewIfNeeded();
    await selectScene(page, 'conversation');
    const beforeKeyScroll = await page.evaluate(() => scrollY);
    await page.locator('[data-show-scene="conversation"]').press('PageDown');
    await expect.poll(() => page.evaluate(() => scrollY)).toBeGreaterThan(beforeKeyScroll);
    await expect(page.locator('#story-demo .app-window')).not.toHaveAttribute('data-current-scene', 'conversation');
  }
});

test('model pickers select providers, dismiss outside, and return keyboard focus', async ({ page }) => {
  await page.goto('/');
  for (const host of ['#hero-demo', '#story-demo']) {
    if (host === '#story-demo') await selectScene(page, 'conversation');
    const preview = page.locator(host);
    const trigger = preview.getByRole('button', { name: 'Choose a model in the preview' });
    const menu = preview.locator('.model-menu');
    await trigger.click();
    await expect(trigger).toHaveAttribute('aria-expanded', 'true');
    await expect(menu.locator('[data-model="claude"]')).toBeFocused();
    await menu.getByRole('button', { name: 'GPT-6 Astra' }).click();
    await expect(trigger).toContainText('GPT-6 Astra');
    await expect(preview.locator('.response-provider')).toHaveText('Codex');
    await expect(menu).toBeHidden();
    await expect(trigger).toBeFocused();
    await trigger.click();
    await page.keyboard.press('Escape');
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await expect(trigger).toBeFocused();
    await trigger.click();
    await preview.locator('.app-header').click();
    await expect(menu).toBeHidden();
    await expect(trigger).toHaveAttribute('aria-expanded', 'false');
  }
});

test('task peeks, worker updates, and both diff layouts respond to controls', async ({ page }) => {
  await page.goto('/');
  await selectScene(page, 'board');
  const task = page.locator('#story-demo').getByRole('button', { name: 'A home for your ideas meadow' });
  await task.click();
  const detail = page.locator('.board-task-detail');
  await expect(detail).toBeVisible();
  await expect(detail.getByRole('heading')).toHaveText('A home for your ideas');
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(task).toBeFocused();
  await task.click();
  await page.getByRole('button', { name: 'Close task preview' }).click();
  await expect(detail).toBeHidden();
  await selectScene(page, 'team');
  for (const [worker, title] of [['interface', 'The interface · Codex'], ['details', 'The details · Kimi Code'], ['checks', 'The checks · OpenCode']]) {
    await page.locator(`[data-worker="${worker}"]`).click();
    await expect(page.locator('.team-note strong')).toHaveText(title);
  }
  await selectScene(page, 'review');
  await page.getByRole('button', { name: 'Split', exact: true }).click();
  await expect(page.locator('.diff-content')).toHaveClass(/is-split/);
  await expect(page.getByRole('button', { name: 'Split', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(page.locator('.diff-lines')).toHaveCSS('display', 'grid');
  await page.getByRole('button', { name: 'Unified', exact: true }).click();
  await expect(page.locator('.diff-content')).not.toHaveClass(/is-split/);
  await expectNoOverflow(page);
  await selectScene(page, 'conversation');
  await page.locator('#story-demo [data-open-review]').click();
  await expect(page.locator('#story-demo [data-preview-scene="review"]')).toBeVisible();
});

test('quick look opens both active threads and returns to the list', async ({ page }) => {
  await page.goto('/');
  const quick = page.locator('#quick-preview');
  for (const [name, provider, copy] of [
    ['A home for your ideas', 'Claude Code', 'The layout is taking shape.'],
    ['Make it feel effortless', 'Codex', 'The interactions are working smoothly.'],
  ]) {
    const task = quick.getByRole('button', { name: new RegExp(name) });
    await task.click();
    await expect(quick.locator('.quick-reader')).toBeVisible();
    await expect(quick.locator('.quick-list')).toBeHidden();
    await expect(quick.getByRole('heading')).toHaveText(name);
    await expect(quick.locator('.quick-response strong')).toContainText(provider);
    await expect(quick.locator('.quick-response p')).toContainText(copy);
    await expect(quick.getByRole('button', { name: 'Active agents' })).toBeFocused();
    await quick.getByRole('button', { name: 'Active agents' }).click();
    await expect(quick.locator('.quick-reader')).toBeHidden();
    await expect(quick.locator('.quick-list')).toBeVisible();
    await expect(task).toBeFocused();
    await task.click();
    await page.keyboard.press('Escape');
    await expect(quick.locator('.quick-reader')).toBeHidden();
    await expect(task).toBeFocused();
  }
});

test('scenery switches real images and honors reduced motion', async ({ page }, info) => {
  await page.goto('/');
  for (const [key, file, greeting] of [
    ['afternoon', 'lake-dawn', 'Let your thoughts wander.'],
    ['night', 'twilight-lake', 'Good ideas stay up late.'],
    ['morning', 'morning-bamboo', 'A little room to breathe.'],
  ]) {
    const button = page.locator(`button[data-wallpaper="${key}"]`);
    await button.click();
    await expect(page.locator('#scenery-preview')).toHaveAttribute('data-wallpaper', key);
    await expect(button).toHaveAttribute('aria-pressed', 'true');
    await expect(page.locator('#scenery-greeting')).toHaveText(greeting);
    await expect.poll(() => page.locator('#scenery-image').evaluate((image: HTMLImageElement) => image.complete && image.naturalWidth > 0 && image.currentSrc)).toContain(file);
    await expectNoOverflow(page);
  }
  if (info.project.use.reducedMotion === 'reduce') {
    expect(await page.evaluate(() => matchMedia('(prefers-reduced-motion: reduce)').matches)).toBe(true);
    await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto');
    await expect(page.locator('#hero-demo .app-scene')).toHaveCSS('animation-name', 'none');
    expect(await page.locator('#scenery-image').evaluate(image => image.getAnimations().length)).toBe(0);
    await expect(page.locator('.section-heading').first()).toHaveCSS('opacity', '1');
  }
});

test('server-rendered hero and feature copy remain visible without JavaScript', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile });
  const page = await context.newPage();
  await page.goto(baseURL!);
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Great work.A calmer place.');
  await expect(page.locator('.hero-description')).toBeVisible();
  await expect(page.locator('.hero-landscape img')).toBeVisible();
  await expect(page.locator('html')).not.toHaveClass(/motion-ready/);
  for (const heading of ['#experience-title', '#overlay-title', '#space-title', '#light-title', '#download-title']) {
    await page.locator(heading).scrollIntoViewIfNeeded();
    await expect(page.locator(heading)).toBeVisible();
    await expect(page.locator(heading)).toHaveCSS('opacity', '1');
  }
  await expect(page.locator('.download-content .button')).toContainText('Download PandaCode');
  await expect(page.locator('.download-content .button')).toHaveAttribute('href', releases);
  await expect(page.locator('#open-source pre')).toContainText('npm run desktop');
  await expect(page.locator('#download-distribution')).toBeVisible();
  await expect(page.locator('#download-distribution')).toContainText('Not notarized by Apple');
  await expectPreviewDisclosures(page);
  await expectPrivacyDetails(page);
  await expectComparison(page);
  await expect(page.locator('.noscript-note')).toHaveCount(0);
  await expect(page.locator('a[href*="/downloads/"]')).toHaveCount(0);
  await context.close();
});

test('what’s new scenes play on screen, rest under reduced motion, and read without JavaScript', async ({ page, browser, baseURL }, info) => {
  await page.goto('/');
  await expect(page.getByRole('link', { name: /Bots, agent teams, VMs & deploys/ })).toHaveAttribute('href', '#whats-new');
  const section = page.locator('#whats-new');
  await expect(section.getByRole('heading', { level: 2 })).toHaveText('More hands.Fewer tabs.');
  for (const title of ['Agents that never clock out.', 'Its own computer.', 'Your app, beside the chat.', 'From “looks good” to live.']) await expect(section.getByRole('heading', { name: title })).toHaveCount(1);
  const bots = section.locator('[data-nf="bots"]');
  await bots.scrollIntoViewIfNeeded();
  const chip = bots.locator('.nf-chip');
  if (info.project.use.reducedMotion === 'reduce') {
    await expect(bots).toHaveClass(/is-still/);
    await expect(chip).toBeVisible();
    await expect(chip).toHaveCSS('opacity', '1');
    await expect(section.locator('.nf-count')).toHaveText('≈ 11 tokens');
  } else {
    // The conversation plays out, then the schedule lands.
    await expect(bots).toHaveClass(/is-playing/);
    await expect(bots.locator('.nf-msg.me').first()).toHaveClass(/\bon\b/, { timeout: 4_000 });
    await expect(chip.locator('xpath=..')).toHaveClass(/\bon\b/, { timeout: 10_000 });
    const saver = section.locator('[data-nf="saver"]');
    await saver.scrollIntoViewIfNeeded();
    await expect(saver.locator('.nf-count')).toHaveText('≈ 31 tokens', { timeout: 8_000 });
    await expect(saver.locator('.nf-count')).toHaveText('≈ 11 tokens', { timeout: 8_000 });
    await expect(saver.locator('.nf-saver')).toHaveAttribute('data-level', '3');
  }
  await expectNoOverflow(page);
  await capture(page, info, 'whats-new');
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile });
  const still = await context.newPage();
  await still.goto(baseURL!);
  const heading = still.locator('#new-title');
  await heading.scrollIntoViewIfNeeded();
  await expect(heading).toHaveCSS('opacity', '1');
  await expect(still.locator('[data-nf="bots"] .nf-chip')).toBeVisible();
  await expect(still.locator('[data-nf="deploy"] .nf-live')).toContainText('meadow.vercel.app');
  await context.close();
});
