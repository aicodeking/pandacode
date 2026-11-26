import { expect, test, type Page } from '@playwright/test';
import { utils, write } from 'xlsx';
import { openInspectorTab } from './inspector-tab-helper';

const open = async (page: Page, name: string) => {
  await page.locator('.file-row').getByRole('button', { name, exact: true }).click();
  await expect(page.locator('#file-tabs').getByRole('tab', { name, exact: true })).toHaveAttribute('aria-selected', 'true');
};

let errors: string[] = [];
test.beforeEach(async ({ page }) => {
  errors = [];
  page.on('pageerror', error => errors.push(error.message));
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

test('a spreadsheet shows a grid per sheet and says when rows are cut off', async ({ page }) => {
  await open(page, 'budget.xlsx');
  const viewer = page.locator('.office-viewer[data-kind="sheet"]');
  await expect(viewer.getByRole('button', { name: 'Budget', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.sheet-grid thead th').nth(1)).toHaveText('A');
  // Column letters and the row-number gutter share caption medium (11px, 500).
  for (const [selector, size, leading] of [
    ['thead th', 11, 14.3], ['tbody th', 11, 14.3],
  ] as const) {
    const header = viewer.locator('.sheet-grid').locator(selector).first();
    await expect(header).toHaveCSS('font-weight', '500');
    const metrics = await header.evaluate(element => {
      const style = getComputedStyle(element);
      return { size: parseFloat(style.fontSize), leading: parseFloat(style.lineHeight) };
    });
    expect(metrics.size).toBeCloseTo(size, 1);
    expect(metrics.leading).toBeCloseTo(leading, 1);
  }
  const gutterStyle = (selector: string) => viewer.locator('.sheet-grid').locator(selector).first().evaluate(element => {
    const style = getComputedStyle(element);
    return { size: style.fontSize, weight: style.fontWeight, leading: style.lineHeight };
  });
  expect(await gutterStyle('tbody th')).toEqual(await gutterStyle('thead th'));
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('Hosting');
  await expect(viewer.locator('.sheet-grid tbody tr').nth(1)).toContainText('120');
  const cell = viewer.locator('.sheet-grid tbody tr').nth(1).locator('td').first();
  await expect(cell).toHaveCSS('font-size', '14px');
  for (const value of [
    'Production hosting with backups and monitoring — annual renewal USD 120.00',
    'Production hosting\nAnnual renewal',
    `${'ProductionBackup'.repeat(8)}USD120.00`,
  ]) {
    const layout = await cell.evaluate((element, text) => {
      element.textContent = text;
      const range = document.createRange();
      range.selectNodeContents(element);
      return {
        lines: range.getClientRects().length,
        width: element.getBoundingClientRect().width,
        clipped: element.scrollWidth > element.clientWidth || element.scrollHeight > element.clientHeight,
      };
    }, value);
    expect(layout.lines).toBeGreaterThan(1);
    expect(layout.width).toBeLessThanOrEqual(360);
    expect(layout.clipped).toBe(false);
  }
  await expect(viewer.locator('.office-bar span')).toHaveCount(0);
  await viewer.getByRole('button', { name: 'Log', exact: true }).click();
  await expect(viewer.locator('.sheet-grid tbody tr')).toHaveCount(2000);
  await expect(viewer.locator('.office-bar span')).toContainText('first 2,000 rows');
});

test('a spreadsheet shows a grid that scrolls horizontally and keeps short dates on one line', async ({ page }) => {
  const date = '2026-11-10';
  const book = utils.book_new();
  utils.book_append_sheet(book, utils.aoa_to_sheet([Array.from({ length: 24 }, () => date)]), 'Dates');
  await page.route('**/tests/fixtures/sample.xlsx', route => route.fulfill({
    body: write(book, { bookType: 'xlsx', type: 'buffer' }),
  }));
  await open(page, 'budget.xlsx');
  await page.setViewportSize({ width: 800, height: 940 });

  const grid = page.getByRole('table', { name: 'Dates' });
  const cell = grid.getByRole('cell', { name: date, exact: true }).first();
  await expect(cell).toBeVisible();
  const lines = await cell.evaluate(element => {
    const range = document.createRange();
    range.selectNodeContents(element);
    return range.getClientRects().length;
  });
  expect(lines).toBe(1);
  const scrolled = await page.locator('.sheet-scroll').evaluate(element => {
    element.scrollLeft = element.scrollWidth;
    return element.scrollLeft;
  });
  expect(scrolled).toBeGreaterThan(0);
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

test('an image opens in a tab fitted to it, with its size and an actual-size toggle', async ({ page }) => {
  await open(page, 'screenshot.png');
  const viewer = page.locator('.office-viewer[data-kind="image"]');
  await expect(viewer.locator('.office-bar')).toContainText('4 × 3 px');
  const image = viewer.getByRole('img', { name: 'screenshot.png' });
  await expect(image).toHaveAttribute('src', /^data:image\/png;base64,/);
  await expect(image).toHaveCSS('border-radius', '10px');
  await expect(page.locator('#browser-panel')).toBeHidden();
  const actual = viewer.getByRole('button', { name: 'Actual size', exact: true });
  await actual.click();
  await expect(actual).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer).toHaveAttribute('data-actual', '');
  await expect(image).toHaveCSS('border-radius', '0px');
  await image.click();
  await expect(actual).toHaveAttribute('aria-pressed', 'false');
  await expect(image).toHaveCSS('border-radius', '10px');
});
