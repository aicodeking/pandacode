import { test as base, expect, type Page } from '@playwright/test';
import { readdir, readFile } from 'node:fs/promises';

const repo = 'https://github.com/aicodeking/pandacode';

/* The reading pages: /changelog lists every releases/X.Y.Z.md, /privacy states that
 * PandaCode collects nothing, /license carries the LICENSE text word for word, and all three work without scripts. */
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

const releaseFiles = async () => (await readdir(new URL('../../releases/', import.meta.url)))
  .filter(name => /^\d+\.\d+\.\d+\.md$/.test(name)).map(name => name.slice(0, -3));
const newest = (versions: string[]) => [...versions].sort((a, b) => b.localeCompare(a, undefined, { numeric: true }))[0];

async function expectNoOverflow(page: Page) {
  expect(await page.evaluate(() => document.documentElement.scrollWidth - innerWidth)).toBe(0);
}

test('changelog lists every release, newest first, with dates and working anchors', async ({ page }) => {
  const versions = await releaseFiles();
  await page.goto('/changelog/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('What’s new in PandaCode.');
  await expect(page.locator('.release')).toHaveCount(versions.length);
  const latest = newest(versions);
  const first = page.locator('.release').first();
  await expect(first.locator('h2')).toHaveText(latest);
  await expect(first.locator('.release-badge')).toHaveText('Latest');
  await expect(page.locator('.release time')).toHaveCount(versions.length);
  await expect(page.locator('.changelog-latest')).toContainText(latest);
  // Repeated signing boilerplate is stated once, not under every release.
  await expect(page.locator('.release-body', { hasText: 'This is an Alpha preview' })).toHaveCount(0);
  await expect(page.locator('.changelog-note')).toContainText('Alpha preview');
  // Bullets written without a blank line after their lead-in, and nested bullets, render as lists.
  await expect(page.locator('.release-body')).not.toContainText([/\. - [A-Z]/]);
  await expect(page.locator('#v0-2-44 .release-body li li').first()).toBeVisible();

  const rail = page.locator('.changelog-rail');
  await rail.getByRole('link', { name: '0.2.20', exact: true }).click();
  await expect(page).toHaveURL(/#v0-2-20$/);
  await expect(page.locator('#v0-2-20')).toBeInViewport();
  await expect(page.locator('#v0-2-20')).toHaveCSS('opacity', '1');
  await expect(rail.getByRole('link', { name: '0.2.20', exact: true })).toHaveAttribute('aria-current', 'location');
  await expectNoOverflow(page);
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('Changelog');
});

test('privacy policy says PandaCode collects nothing, with a contents rail', async ({ page }) => {
  await page.goto('/privacy/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Privacy, plainly put.');
  await expect(page.locator('.legal-updated time')).toHaveAttribute('datetime', /^\d{4}-\d{2}-\d{2}$/);
  const prose = page.locator('.legal-prose');
  for (const fact of [
    'PandaCode collects nothing.',
    'no accounts, no license checks, no telemetry, no analytics, no crash reports and no PandaCode servers',
    'formulae.brew.sh', 'downloads.claude.ai', 'api.github.com', 'cdn.kimi.com', 'about every 6 hours',
    'raw.githubusercontent.com', 'at most once a day',
    'It sets no cookies, runs no analytics',
    'our web host may keep standard server logs',
    'Agents act with the permissions you give them',
  ]) await expect(page.locator('main')).toContainText(fact);
  await expect(page.locator('main')).not.toContainText(/Cloudflare Web Analytics|Stripe|Featurebase|__Host-|license key|subscription|Standard Contractual Clauses/i);
  await expect(prose.locator('section')).toHaveCount(await page.locator('.legal-toc a').count());
  await page.locator('.legal-toc').getByRole('link', { name: 'This website' }).click();
  await expect(page.locator('#website')).toBeInViewport();
  await expect(page.locator('#website')).toHaveCSS('opacity', '1');
  await expect(page.locator('.legal-toc a.is-current')).toHaveText('This website');
  await expect(prose.getByRole('link', { name: 'GitHub issues' })).toHaveAttribute('href', `${repo}/issues`);
  await expect(prose.getByRole('link', { name: 'security policy' })).toHaveAttribute('href', `${repo}/security/policy`);
  await expect(prose.getByRole('link', { name: 'PandaCode License' })).toHaveAttribute('href', '/license/');
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('Privacy');
  await expectNoOverflow(page);
});

test('license page carries LICENSE word for word, including the fork credit, and the agent permissions note', async ({ page }) => {
  await page.goto('/license/');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('The PandaCode License.');
  // Same paragraphs as the repository's LICENSE; only quote marks are typeset.
  const normalize = (text: string) => text.replace(/[“”]/g, '"').replace(/’/g, "'").replace(/\s+/g, ' ').trim();
  const license = (await readFile(new URL('../../LICENSE', import.meta.url), 'utf8')).split(/\n\s*\n/).map(normalize).filter(Boolean);
  const shown = (await page.locator('.license-text p').allTextContents()).map(normalize);
  expect(shown).toEqual(license);
  expect(license.join(' ')).toContain('"This is a fork of PandaCode" together with a link to https://github.com/aicodeking/pandacode');
  await expect(page.locator('#summary')).toContainText('This is a fork of PandaCode');
  await expect(page.locator('#agents')).toContainText('act with the permissions you grant');
  await expect(page.locator('.legal-prose').getByRole('link', { name: 'GitHub issues' })).toHaveAttribute('href', `${repo}/issues`);
  await expect(page.locator('.legal-prose').getByRole('link', { name: 'Privacy Policy' })).toHaveAttribute('href', '/privacy/');
  await expect(page.locator('.legal-prose section')).toHaveCount(await page.locator('.legal-toc a').count());
  await expect(page.locator('.nav-links a[aria-current="page"]')).toHaveText('License');
  await expectNoOverflow(page);
});

test('reading pages are complete without JavaScript', async ({ browser, baseURL }, info) => {
  const context = await browser.newContext({ javaScriptEnabled: false, viewport: info.project.use.viewport, isMobile: info.project.use.isMobile });
  const page = await context.newPage();
  for (const path of ['/changelog/', '/privacy/', '/license/']) {
    await page.goto(`${baseURL}${path}`);
    await expect(page.locator('html')).not.toHaveClass(/motion-ready/);
    const last = page.locator('.release, .legal-prose section').last();
    await last.scrollIntoViewIfNeeded();
    await expect(last).toHaveCSS('opacity', '1');
    const footer = page.locator('footer');
    await expect(footer.getByRole('link', { name: 'License', exact: true })).toHaveAttribute('href', '/license/');
    await expect(footer.getByRole('link', { name: 'GitHub', exact: true })).toHaveAttribute('href', repo);
    await expect(footer.getByRole('link', { name: 'Support', exact: true })).toHaveAttribute('href', '/support/');
    await expect(footer.getByRole('link', { name: 'Issues', exact: true })).toHaveAttribute('href', `${repo}/issues`);
    await expect(page.locator('.navigation .button')).toHaveAttribute('href', `${repo}/releases/latest`);
    await expectNoOverflow(page);
  }
  await context.close();
});
