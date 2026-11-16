import { crc32, deflateSync } from 'node:zlib';
import { expect, test, type Page } from '@playwright/test';
import { openInspectorTab } from './inspector-tab-helper';

function widePng(width = 1600, height = 1200): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const length = Buffer.alloc(4); length.writeUInt32BE(data.length, 0);
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(body) >>> 0, 0);
    return Buffer.concat([length, body, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4); ihdr[8] = 8; ihdr[9] = 0;
  const raw = Buffer.alloc(height * (1 + width), 0x90);
  for (let y = 0; y < height; y++) raw[y * (1 + width)] = 0;
  return Buffer.concat([
    Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

declare global {
  interface Window {
    pdfWorkers: { live: number; started: number; hold: boolean; pending: number; release(): void };
  }
}

const open = async (page: Page, name: string) => {
  await page.locator('.file-row').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#file-tabs').getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
};

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.addInitScript(() => {
    const live = new Set<Worker>(), queued = new Map<Worker, () => void>();
    const stats = window.pdfWorkers = { live: 0, started: 0, hold: false, pending: 0, release() {
      stats.hold = false;
      for (const send of queued.values()) send();
      queued.clear(); stats.pending = 0;
    } };
    window.Worker = class extends Worker {
      constructor(...args: ConstructorParameters<typeof Worker>) {
        super(...args);
        if (String(args[0]).includes('pdf.worker')) { live.add(this); stats.started++; stats.live = live.size; }
      }
      postMessage(message: unknown, transfer: Transferable[] = []): void {
        if (stats.hold && (message as { action?: string })?.action === 'GetDocRequest') {
          queued.set(this, () => super.postMessage(message, transfer)); stats.pending = queued.size;
        } else super.postMessage(message, transfer);
      }
      terminate(): void {
        queued.delete(this); stats.pending = queued.size;
        live.delete(this); stats.live = live.size; super.terminate();
      }
    };
  });
  await page.goto('/');
  await openInspectorTab(page, 'Files');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
});
test.afterEach(() => { expect(errors).toEqual([]); });

test('a PDF opens in a tab with every page drawn from its bytes', async ({ page }) => {
  await open(page, 'report.pdf');
  const viewer = page.locator('.office-viewer[data-kind="pdf"]');
  await expect(viewer.locator('.office-bar')).toHaveText('2 pages');
  await expect(viewer.locator('.pdf-page')).toHaveCount(2);
  await expect(viewer.locator('.pdf-page').first().locator('canvas')).toBeVisible();
  // The tab still offers the browser preview, and binary files have no Copy action.
  await expect(page.getByRole('button', { name: 'Preview in browser', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toHaveCount(0);
  await expect(page.locator('#browser-panel')).toBeHidden();
});

test('a Word document renders its paragraphs', async ({ page }) => {
  await open(page, 'proposal.docx');
  const viewer = page.locator('.office-viewer[data-kind="docx"]');
  await expect(viewer).toContainText('Project proposal');
  await expect(viewer).toContainText('Hello from Word.');
});

test('distant PDF canvases release their pixels and redraw when approached again', async ({ page }) => {
  await open(page, 'report.pdf');
  const slots = page.locator('.pdf-page');
  const first = slots.first();
  await expect(first.locator('canvas')).toBeVisible();
  const original = await first.locator('canvas').elementHandle();
  // Separate the sample's two pages far enough to leave the retention buffer.
  await first.evaluate(slot => {
    const spacer = document.createElement('div');
    spacer.style.height = '5000px'; spacer.style.flexShrink = '0';
    slot.after(spacer);
  });
  await slots.last().scrollIntoViewIfNeeded();
  await expect(slots.last().locator('canvas')).toBeVisible();
  await expect(first.locator('canvas')).toHaveCount(0);
  expect(await original!.evaluate(canvas => [canvas.width, canvas.height, canvas.isConnected])).toEqual([0, 0, false]);
  await first.scrollIntoViewIfNeeded();
  await expect(first.locator('canvas')).toBeVisible();
  expect(await first.locator('canvas').evaluate(canvas => canvas.width * canvas.height)).toBeGreaterThan(0);
});

test('a spreadsheet shows a grid per sheet and says when rows are cut off', async ({ page }) => {
  await open(page, 'budget.xlsx');
  const viewer = page.locator('.office-viewer[data-kind="sheet"]');
  await expect(viewer.getByRole('button', { name: 'Budget', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.sheet-grid thead th').nth(1)).toHaveText('A');
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('Hosting');
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('120');
  await expect(viewer.locator('.office-bar span')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(viewer.locator('.sheet-grid tbody tr')).toHaveCount(2000);
  await expect(viewer.locator('.office-bar span')).toContainText('first 2,000 rows');
});

test('switching away from a document and back keeps it, and closing it disposes the viewer', async ({ page }) => {
  await open(page, 'report.pdf');
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
  await open(page, 'proposal.docx');
  await expect(page.locator('.office-viewer[data-kind="docx"]')).toContainText('Hello from Word.');
  await page.locator('#file-tabs').getByRole('tab', { name: 'report.pdf', exact: true }).click();
  await expect(page.locator('.office-viewer[data-kind="pdf"] .office-bar')).toHaveText('2 pages');
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await page.getByRole('button', { name: 'Close proposal.docx', exact: true }).click();
  await expect(page.locator('#file-tabs')).toBeHidden();
});

test('hiding a PDF disposes the viewer worker and restores the selected page and reading position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  let reads = 0;
  page.on('request', request => { if (request.url().includes('/tests/fixtures/sample.pdf')) reads++; });
  await open(page, 'report.pdf');
  const last = page.locator('.pdf-page').last();
  await last.scrollIntoViewIfNeeded();
  await expect(last.locator('canvas')).toBeVisible();
  const canvas = await last.locator('canvas').elementHandle();
  const body = page.locator('.file-view-body');
  const scroll = await body.evaluate(node => node.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(1);
  const started = await page.evaluate(() => window.pdfWorkers.started);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  expect(await canvas!.evaluate(node => [node.width, node.height, node.isConnected])).toEqual([0, 0, false]);
  await page.getByRole('tab', { name: 'Open files', exact: true }).click();
  await expect(page.locator('#file-tabs').getByRole('tab', { name: 'report.pdf', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(last.locator('canvas')).toBeVisible();
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeCloseTo(scroll, 0);
  expect(await page.evaluate(() => window.pdfWorkers.started)).toBe(started + 1);
  expect(reads).toBe(1);
  // Hiding the entire inspector uses the same lifetime, even with Open files still selected.
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.locator('#inspector-toggle').click();
  await expect(last.locator('canvas')).toBeVisible();
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeCloseTo(scroll, 0);
  // Exercise the webview's document visibility event independently of the inspector attributes.
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect(last.locator('canvas')).toBeVisible();
  await expect.poll(() => body.evaluate(node => node.scrollTop)).toBeCloseTo(scroll, 0);
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});

test('hiding during PDF loading disposes the viewer without a stale render after reveal or close', async ({ page }) => {
  await page.evaluate(() => { window.pdfWorkers.hold = true; });
  await open(page, 'report.pdf');
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.pending)).toBe(1);
  for (let cycle = 0; cycle < 3; cycle++) {
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
    await page.getByRole('tab', { name: 'Open files', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.pdfWorkers.pending)).toBe(1);
  }
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.evaluate(() => window.pdfWorkers.release());
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await open(page, 'report.pdf');
  await expect(page.locator('.pdf-page canvas').first()).toBeVisible();
  await expect(page.locator('.office-bar')).toHaveText('2 pages');
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(1);
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});

test('a broken PDF disposes the viewer worker and keeps its error after hiding and reopening', async ({ page }) => {
  await page.route('**/tests/fixtures/sample.pdf', route => route.fulfill({ body: 'invalid PDF bytes' }));
  await open(page, 'report.pdf');
  await expect(page.locator('#file-view [role="alert"]')).toContainText('This file could not be opened:');
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await page.getByRole('tab', { name: 'Open files', exact: true }).click();
  await expect(page.locator('#file-view [role="alert"]')).toContainText('This file could not be opened:');
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
});

test('a PDF file reply after closing disposes the viewer without replacing the next selected file', async ({ page }) => {
  let release!: () => void, requested!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  const request = new Promise<void>(resolve => { requested = resolve; });
  await page.route('**/tests/fixtures/sample.pdf', async route => {
    requested(); await gate; await route.continue();
  });
  await open(page, 'report.pdf');
  await request;
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await open(page, 'package.json');
  const response = page.waitForResponse('**/tests/fixtures/sample.pdf');
  release(); await (await response).finished();
  await expect(page.locator('#file-tabs').getByRole('tab', { name: 'package.json', exact: true })).toHaveAttribute('aria-selected', 'true');
  await expect(page.locator('.code-preview')).toContainText('"name": "orbit"');
  await expect(page.locator('.pdf-page')).toHaveCount(0);
  expect(await page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});

test('a PDF reread disposes the viewer still loading without losing its saved reading position', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 500 });
  await open(page, 'report.pdf');
  await page.locator('.pdf-page').last().scrollIntoViewIfNeeded();
  const scroll = await page.locator('.file-view-body').evaluate(node => node.scrollTop);
  expect(scroll).toBeGreaterThan(0);
  await open(page, 'proposal.docx');
  await expect(page.locator('.office-viewer[data-kind="docx"]')).toContainText('Hello from Word.');
  let release!: () => void;
  const gate = new Promise<void>(resolve => { release = resolve; });
  await page.route('**/tests/fixtures/sample.pdf', async route => {
    const response = await route.fetch(), bytes = await response.body();
    await gate;
    await route.fulfill({ response, body: Buffer.concat([bytes, Buffer.from('\n% changed\n')]) });
  });
  await page.evaluate(() => { window.pdfWorkers.hold = true; });
  await page.locator('#file-tabs').getByRole('tab', { name: 'report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.pending)).toBe(1);
  const started = await page.evaluate(() => window.pdfWorkers.started);
  release();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.started)).toBe(started + 1);
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.pending)).toBe(1);
  await page.evaluate(() => window.pdfWorkers.release());
  await expect(page.locator('.pdf-page').last().locator('canvas')).toBeVisible();
  await expect.poll(() => page.locator('.file-view-body').evaluate(node => node.scrollTop)).toBeCloseTo(scroll, 0);
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});

test('an image opens in a tab fitted to it, with its size and an actual-size toggle', async ({ page }) => {
  await open(page, 'screenshot.png');
  const viewer = page.locator('.office-viewer[data-kind="image"]');
  await expect(viewer.locator('.office-bar')).toContainText('4 × 3 px');
  await expect(viewer.getByRole('img', { name: 'screenshot.png' })).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(page.locator('#browser-panel')).toBeHidden();
  const actual = viewer.getByRole('button', { name: 'Actual size', exact: true });
  await actual.click();
  await expect(actual).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer).toHaveAttribute('data-actual', '');
});

// Generated text-only PDF: page 1 is portrait; the remaining 23 pages are landscape.
test('a mixed-orientation PDF disposes the viewer and restores its page across hidden lifetimes', async ({ page }) => {
  test.setTimeout(40_000);
  await page.setViewportSize({ width: 1440, height: 650 });
  await page.route('**/tests/fixtures/sample.pdf', route => route.fulfill({
    path: 'tests/fixtures/mixed-orientation.pdf', contentType: 'application/pdf',
  }));
  await open(page, 'report.pdf');
  await expect(page.locator('.pdf-page')).toHaveCount(24);
  for (let number = 1; number <= 18; number++) {
    const slot = page.locator(`.pdf-page[data-page="${number}"]`);
    await slot.scrollIntoViewIfNeeded();
    await expect(slot.locator('canvas')).toBeVisible();
  }
  const body = page.locator('.file-view-body');
  // Put a known page and a nonzero within-page offset at the reading edge below the sticky bar.
  await body.evaluate(node => {
    const slot = node.querySelector('[data-page="18"]')!.getBoundingClientRect();
    node.scrollTop += slot.top - node.getBoundingClientRect().top - 40 + slot.height * .3;
  });
  const position = () => body.evaluate(node => {
    const edge = node.getBoundingClientRect().top + 40;
    const slots = [...node.querySelectorAll<HTMLElement>('.pdf-page')];
    const slot = slots.find(slot => slot.getBoundingClientRect().bottom > edge)!;
    const rect = slot.getBoundingClientRect();
    return { page: Number(slot.dataset.page), fraction: (edge - rect.top) / rect.height };
  });
  await expect.poll(async () => (await position()).page).toBe(18);
  const before = await position();
  const originalWidth = await body.evaluate(node => node.clientWidth);
  const restored = async () => {
    await expect(page.locator('.pdf-page[data-page="18"] canvas')).toBeVisible();
    await expect.poll(async () => (await position()).page).toBe(before.page);
    await expect.poll(async () => Math.abs((await position()).fraction - before.fraction)).toBeLessThan(.04);
    await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(1);
  };
  for (let cycle = 0; cycle < 2; cycle++) {
    await page.getByRole('tab', { name: 'Files', exact: true }).click();
    await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
    await expect(page.locator('.pdf-page')).toHaveCount(0);
    await page.getByRole('tab', { name: 'Open files', exact: true }).click();
    await restored();
  }
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  // Change the inspector width while hidden; a raw pixel offset cannot retain the reading page.
  await page.locator('#inspector').evaluate(node => { node.style.width = '520px'; });
  await page.locator('#inspector-toggle').click();
  await restored();
  expect(await body.evaluate(node => node.clientWidth)).toBeGreaterThan(originalWidth + 50);
  await page.evaluate(() => {
    Object.defineProperty(document, 'hidden', { configurable: true, value: true });
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await page.evaluate(() => {
    delete (document as unknown as { hidden?: boolean }).hidden;
    document.dispatchEvent(new Event('visibilitychange'));
  });
  await restored();
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});

test('hiding image, Word and spreadsheet tabs disposes the viewer DOM and restores zoom and sheet state', async ({ page }) => {
  // 1. Image tab: toggle Actual size on a wide PNG, pan horizontally & vertically, hide #file-panel, verify img released, show and verify Actual size + scroll restored.
  const pngBytes = widePng(1600, 1200);
  await page.route('**/tests/fixtures/sample.png', route => route.fulfill({ body: pngBytes, contentType: 'image/png' }));
  await page.setViewportSize({ width: 1280, height: 620 });
  await open(page, 'screenshot.png');
  const imageViewer = page.locator('.office-viewer[data-kind="image"]');
  await expect(imageViewer.locator('.office-bar')).toContainText('1,600 × 1,200 px');
  const imgHandle = await imageViewer.locator('img').elementHandle();
  await imageViewer.getByRole('button', { name: 'Actual size', exact: true }).click();
  await expect(imageViewer).toHaveAttribute('data-actual', '');
  const imageStage = imageViewer.locator('.image-stage');
  const fileBody = page.locator('.file-view-body');
  await imageStage.evaluate(node => { node.scrollLeft = 240; node.dispatchEvent(new Event('scroll')); });
  await fileBody.evaluate(node => { node.scrollTop = 180; node.dispatchEvent(new Event('scroll')); });
  const stageLeft = await imageStage.evaluate(node => node.scrollLeft);
  const bodyTop = await fileBody.evaluate(node => node.scrollTop);
  expect(stageLeft).toBeGreaterThan(100);
  expect(bodyTop).toBeGreaterThan(40);
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.locator('#file-panel')).toBeHidden();
  await expect(page.locator('#file-view img')).toHaveCount(0);
  expect(await imgHandle!.evaluate(img => [img.getAttribute('src'), img.isConnected])).toEqual([null, false]);
  await page.getByRole('tab', { name: 'Open files', exact: true }).click();
  await expect(imageViewer).toHaveAttribute('data-actual', '');
  await expect(imageViewer.getByRole('button', { name: 'Actual size', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(imageViewer.locator('img')).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect.poll(() => imageViewer.locator('.image-stage').evaluate(node => node.scrollLeft)).toBeCloseTo(stageLeft, 0);
  await expect.poll(() => fileBody.evaluate(node => node.scrollTop)).toBeCloseTo(bodyTop, 0);

  // 2. Word document tab: hide #inspector, verify .docx-host unmounted, show and verify content restored.
  await open(page, 'proposal.docx');
  await expect(page.locator('.office-viewer[data-kind="docx"]')).toContainText('Hello from Word.');
  const docxHost = await page.locator('.docx-host').elementHandle();
  await page.getByRole('button', { name: 'Hide inspector', exact: true }).click();
  await expect(page.locator('#file-view .docx-host')).toHaveCount(0);
  expect(await docxHost!.evaluate(host => [host.shadowRoot?.childElementCount ?? 0, host.isConnected])).toEqual([0, false]);
  await page.locator('#inspector-toggle').click();
  await expect(page.locator('.office-viewer[data-kind="docx"]')).toContainText('Hello from Word.');

  // 3. Spreadsheet tab: select second sheet ('Log') and scroll .sheet-scroll, hide and restore cleanly.
  await open(page, 'budget.xlsx');
  const sheetViewer = page.locator('.office-viewer[data-kind="sheet"]');
  await sheetViewer.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(sheetViewer.getByRole('button', { name: 'Log', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await sheetViewer.locator('.sheet-scroll').evaluate(node => { node.scrollTop = 420; node.dispatchEvent(new Event('scroll')); });
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect(page.locator('#file-view .sheet-grid')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Open files', exact: true }).click();
  await expect(sheetViewer.getByRole('button', { name: 'Log', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect.poll(() => sheetViewer.locator('.sheet-scroll').evaluate(node => node.scrollTop)).toBeCloseTo(420, 0);
});

test('a direct deep jump in a mixed-orientation PDF disposes the viewer and re-anchors accurately on reveal', async ({ page }) => {
  await page.setViewportSize({ width: 1440, height: 650 });
  await page.route('**/tests/fixtures/sample.pdf', route => route.fulfill({
    path: 'tests/fixtures/mixed-orientation.pdf', contentType: 'application/pdf',
  }));
  await open(page, 'report.pdf');
  await expect(page.locator('.pdf-page')).toHaveCount(24);
  await expect(page.locator('.pdf-page[data-page="1"] canvas')).toBeVisible();

  const body = page.locator('.file-view-body');
  // Jump directly to page 20 while pages 2..24 still carry page 1's portrait placeholder aspect ratio, then hide immediately.
  const before = await body.evaluate(node => {
    const slot = node.querySelector('[data-page="20"]')!.getBoundingClientRect();
    node.scrollTop += slot.top - node.getBoundingClientRect().top - 40 + slot.height * .35;
    node.dispatchEvent(new Event('scroll'));
    const edge = node.getBoundingClientRect().top + 40;
    const slots = [...node.querySelectorAll<HTMLElement>('.pdf-page')];
    const current = slots.find(s => s.getBoundingClientRect().bottom > edge)!;
    const rect = current.getBoundingClientRect();
    return { page: Number(current.dataset.page), fraction: (edge - rect.top) / rect.height };
  });
  expect(before.page).toBe(20);
  const position = () => body.evaluate(node => {
    const edge = node.getBoundingClientRect().top + 40;
    const slots = [...node.querySelectorAll<HTMLElement>('.pdf-page')];
    const slot = slots.find(s => s.getBoundingClientRect().bottom > edge)!;
    const rect = slot.getBoundingClientRect();
    return { page: Number(slot.dataset.page), fraction: (edge - rect.top) / rect.height };
  });

  await page.getByRole('tab', { name: 'Files', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
  await expect(page.locator('.pdf-page')).toHaveCount(0);
  await page.getByRole('tab', { name: 'Open files', exact: true }).click();

  await expect(page.locator('.pdf-page[data-page="20"] canvas')).toBeVisible();
  await expect.poll(async () => (await position()).page).toBe(20);
  await expect.poll(async () => Math.abs((await position()).fraction - before.fraction)).toBeLessThan(.04);
  await page.getByRole('button', { name: 'Close report.pdf', exact: true }).click();
  await expect.poll(() => page.evaluate(() => window.pdfWorkers.live)).toBe(0);
});
