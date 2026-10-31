// Renders the launch banners from banners.html into docs/app-store/banners/.
// Run from the repo root: node docs/app-store/mockups/render-banners.mjs [name ...]
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const out = path.join(here, '..', 'banners');
const banners = [
  'social-1600x900', 'github-social-1280x640', 'play-feature-1024x500',
  'website-hero-2400x1200', 'square-1080x1080',
  // App Store Connect creative assets: product page header and search results.
  'app-store/header-3840x1646', 'app-store/header-5244x2950',
  'app-store/search-results-3840x2560', 'app-store/search-results-1920x1280',
];

mkdirSync(path.join(out, 'app-store'), { recursive: true });
const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
for (const name of banners.filter(n => !only.length || only.includes(n))) {
  const [width, height] = name.split('-').at(-1).split('x').map(Number);
  const page = await browser.newPage({ viewport: { width, height }, deviceScaleFactor: 1 });
  await page.goto(`${pathToFileURL(path.join(here, 'banners.html'))}?${name}`);
  await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(img => img.decode())]));
  await page.screenshot({ path: path.join(out, `${name}.png`) });
  await page.close();
  console.log(`${name}.png`);
}
await browser.close();
