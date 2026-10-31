// Renders every App Store screenshot set from the pages in this folder.
// Run from the repo root: node docs/app-store/mockups/render.mjs [set ...]
// Each page is laid out at a fixed design width and scaled to the set's pixel size, so one
// layout serves several sizes (index.html is drawn at 1320 wide for both iPhone sets).
import { chromium } from 'playwright';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { mkdirSync } from 'node:fs';
import path from 'node:path';

const here = path.dirname(fileURLToPath(import.meta.url));
const phone = ['01-inbox', '02-task', '03-approval', '04-working', '05-new-task', '06-settings'];
const sets = [
  // App Store Connect: iPhone 6.9" (Dynamic Island, large display).
  { dir: 'iphone-6.9', page: 'index.html', width: 1320, height: 2868, design: 1320, names: phone },
  // App Store Connect: iPhone 6.3" (Dynamic Island, medium display). Required.
  { dir: 'iphone-6.3', page: 'index.html', width: 1206, height: 2622, design: 1320, names: phone },
  // App Store Connect: iPhone Duo, inner display, landscape.
  { dir: 'iphone-duo-inner', page: 'duo.html?inner', width: 2853, height: 2007, design: 2853,
    names: ['01-side-by-side', '02-approval', '03-working', '04-new-thread', '05-settings'] },
  // App Store Connect: iPhone Duo, outer display, portrait.
  { dir: 'iphone-duo-outer', page: 'duo.html?outer', width: 1398, height: 2034, design: 1398,
    names: ['01-inbox', '02-task', '03-approval', '04-working'] },
];

const only = process.argv.slice(2);
const browser = await chromium.launch({ channel: 'chrome' });
for (const set of sets.filter(s => !only.length || only.includes(s.dir))) {
  const scale = set.width / set.design;
  const page = await browser.newPage({
    viewport: { width: set.design, height: Math.round(set.height / scale) },
    deviceScaleFactor: scale,
  });
  const out = path.join(here, '..', 'screenshots', set.dir);
  mkdirSync(out, { recursive: true });
  for (const [i, name] of set.names.entries()) {
    const [file, query = ''] = set.page.split('?');
    const url = `${pathToFileURL(path.join(here, file))}?${query ? `${query}&` : ''}${i + 1}`;
    await page.goto(url);
    await page.evaluate(() => Promise.all([document.fonts.ready, ...[...document.images].map(img => img.decode())]));
    const png = await page.screenshot({ path: path.join(out, `${name}.png`) });
    // App Store Connect rejects any other size, so fail loudly here instead.
    const size = [png.readUInt32BE(16), png.readUInt32BE(20)];
    if (size[0] !== set.width || size[1] !== set.height) {
      throw new Error(`${set.dir}/${name}.png is ${size.join('x')}, expected ${set.width}x${set.height}`);
    }
    console.log(`${set.dir}/${name}.png`);
  }
  await page.close();
}
await browser.close();
