import { expect, test } from '@playwright/test';
import { replaceEditor } from './file-editor-helper';
import { openInspectorTab } from './inspector-tab-helper';

test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#inspector')).toBeVisible();
  await openInspectorTab(page, 'Files');
  await page.getByRole('tab', { name: 'Files', exact: true }).click();
});

test('renders Markdown as a reader and switches to raw source', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const viewer = page.locator('.document-viewer');
  await expect(viewer.locator('.doc-reader h1')).toHaveText('Orbit');
  await expect(viewer.locator('.doc-reader li')).toHaveCount(2);
  await expect(viewer.locator('.doc-stats')).toContainText('min read');
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Attach', exact: true })).toBeVisible();
  await expect(viewer.locator('.doc-reader')).toHaveCSS('user-select', 'text');
  await viewer.getByRole('button', { name: 'Raw', exact: true }).click();
  await expect(viewer.getByRole('button', { name: 'Raw', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('.doc-raw')).toContainText('# Orbit');
  await expect(viewer.locator('.doc-raw')).toContainText('## Usage');

  // The choice is remembered for Markdown files during the session.
  await page.getByRole('button', { name: 'Close README.md', exact: true }).click();
  await expect(page.locator('.document-viewer')).toHaveCount(0);
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  await expect(page.locator('.document-viewer .doc-raw')).toContainText('# Orbit');
});

test('renders README HTML with workspace images, like a GitHub README', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.document-viewer .doc-reader');
  await expect(reader.locator('[align="center"]')).toBeVisible();
  await expect(reader).not.toContainText('<div');
  const banner = reader.getByRole('img', { name: 'Orbit banner' });
  await expect(banner).toHaveAttribute('src', /^data:image\//);
  await expect(banner).toHaveAttribute('width', '100%');
  // Remote images are never fetched: a badge becomes its text, still linked.
  await expect(reader.locator('img[src^="http"]')).toHaveCount(0);
  await expect(reader.getByRole('link', { name: 'Build' })).toHaveAttribute('href', 'https://example.com/ci');
  await expect(reader.locator('script, [onerror], [download], .toast')).toHaveCount(0);
});

test('Markdown preview uses relative headings and one prose size for paragraphs and table cells', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', '# Title\n\n## Section\n\n### Group\n\n#### Detail\n\nA paragraph.\n\n| Header |\n| --- |\n| Cell |');
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  await expect(reader.locator('td')).toHaveText('Cell');
  const sizes = await reader.locator('h1, h2, h3, h4, p, th, td').evaluateAll(nodes =>
    nodes.map(node => parseFloat(getComputedStyle(node).fontSize)));
  const [h1, h2, h3, h4, prose, caption, cell] = sizes;
  expect(h1).toBeCloseTo(prose * 1.19, 2);
  expect(h2).toBe(h1);
  expect(h3).toBe(prose);
  expect(h4).toBe(h3);
  await expect(reader.locator('h3')).toHaveCSS('font-weight', await reader.locator('h4').evaluate(node => getComputedStyle(node).fontWeight));
  expect(cell).toBe(prose);
  expect(caption).toBeLessThan(prose);
});

test('raw-HTML Markdown preview preserves GitHub admonitions and GFM task checkboxes without raw inputs', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', [
    '<div align="center"><h1>Orbit</h1></div>',
    '',
    '> [!NOTE]',
    '> Admonitions survive raw-HTML Markdown preview.',
    '',
    '> [!WARNING]',
    '> **Watch out** for regressions.',
    '',
    '- [x] Completed task',
    '- [ ] Pending task',
    '',
    '<input type="checkbox" onclick="window.__xss=1"><script>window.__xss=1</script>',
  ].join('\n'));
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  await expect(reader.locator('[align="center"] h1')).toHaveText('Orbit');
  await expect(reader.locator('aside.md-admonition.md-admonition-note .md-admonition-title')).toHaveText('Note');
  await expect(reader.locator('aside.md-admonition.md-admonition-note')).toContainText('Admonitions survive raw-HTML Markdown preview.');
  await expect(reader.locator('aside.md-admonition.md-admonition-warning .md-admonition-title')).toHaveText('Warning');
  await expect(reader.locator('aside.md-admonition.md-admonition-warning strong')).toHaveText('Watch out');
  await expect(reader.locator('ul.md-task-list')).toHaveCount(1);
  await expect(reader.locator('li.md-task')).toHaveCount(2);
  await expect(reader.locator('li.md-task.md-task-done')).toContainText('Completed task');
  await expect(reader.locator('li.md-task.md-task-done .md-checkbox')).toHaveAttribute('aria-label', 'Done');
  await expect(reader.locator('li.md-task:not(.md-task-done) .md-checkbox')).toHaveAttribute('aria-label', 'Not done');
  await expect(reader.locator('input, script')).toHaveCount(0);
  expect(await page.evaluate(() => (window as any).__xss)).toBeUndefined();
});

test('renders Markdown as a reader with mixed GFM task lists in a narrow raw-HTML README', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', [
    '<div>Schedule</div>',
    '',
    '1. [x] Review the schedule on <strong>Tuesday</strong> before the team meeting.',
    '   - Bring the updated draft.',
    '2. Share the meeting notes.',
  ].join('\n'));
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  await reader.evaluate(el => { (el as HTMLElement).style.maxWidth = '220px'; });
  const task = reader.locator('ol > li.md-task');
  await expect(task.locator('.md-checkbox')).toHaveAttribute('aria-label', 'Done');
  await expect(task.locator('strong')).toHaveText('Tuesday');
  await expect(task.locator('ul')).toHaveText('Bring the updated draft.');
  const layout = await task.evaluate(el => {
    const word = el.querySelector('strong')!;
    const nested = el.querySelector('ul')!;
    const taskText = document.createRange();
    taskText.setStartAfter(el.querySelector('.md-checkbox')!);
    taskText.setEndBefore(nested);
    return {
      wordHeight: word.getBoundingClientRect().height,
      textBottom: taskText.getBoundingClientRect().bottom,
      nestedTop: nested.getBoundingClientRect().top,
    };
  });
  expect(layout.wordHeight).toBeLessThan(40);
  expect(layout.nestedTop).toBeGreaterThan(layout.textBottom);
  const ordinaryItem = reader.locator('ol > li:not(.md-task)');
  await expect(ordinaryItem).toHaveText('Share the meeting notes.');
  await expect(ordinaryItem).toHaveCSS('list-style-type', 'decimal');
});

test('raw-HTML Markdown preview preserves GitHub admonitions, trims the leading break, and keeps cited quotes', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', [
    '<blockquote><p>[!NOTE]\n<br>Body text</p></blockquote>',
    '',
    '<blockquote cite="https://example.com"><p>[!NOTE]\nCited</p></blockquote>',
  ].join('\n'));
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  const note = reader.locator('.md-admonition-note');
  await expect(note.locator('p')).toHaveText(['Note', 'Body text']);
  await expect(note.locator('br')).toHaveCount(0);
  await expect(reader.locator('blockquote[cite="https://example.com"]')).toHaveText('[!NOTE] Cited');
});

test('shows code with line numbers that are not selectable and a wrap toggle', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="package.json"]').click();
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const viewer = page.locator('.document-viewer');
  await expect(viewer.locator('.code-preview')).toContainText('"name": "orbit"');
  await expect(viewer.locator('[data-gutter] [data-line-index]').first()).toBeVisible();
  await expect(viewer.locator('[data-gutter]').first()).toHaveCSS('user-select', 'none');
  await expect.poll(() => viewer.locator('[data-content] span').evaluateAll(nodes => new Set(nodes.map(node => getComputedStyle(node).color)).size)).toBeGreaterThan(1);
  await expect(viewer.locator('.doc-view-switch')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copy file', exact: true })).toBeVisible();
  const wrap = viewer.getByRole('button', { name: 'Wrap', exact: true });
  await expect(wrap).toHaveAttribute('aria-pressed', 'false');
  await wrap.click();
  await expect(viewer.getByRole('button', { name: 'Wrap', exact: true })).toHaveAttribute('aria-pressed', 'true');
  await expect(viewer.locator('[data-overflow="wrap"]')).toBeVisible();
});

test('raw HTML tables without thead promote a header-only first row so column headers use caption scale', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', [
    '<table>',
    '  <tr><th>Feature</th><th>Status</th></tr>',
    '  <tr><th>Preview</th><td>Ready</td></tr>',
    '</table>',
  ].join('\n'));
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  await expect(reader.locator('thead th')).toHaveText(['Feature', 'Status']);
  await expect(reader.locator('tbody th')).toHaveText(['Preview']);
  const colHeader = await reader.locator('thead th').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { size: parseFloat(cs.fontSize), leading: parseFloat(cs.lineHeight), weight: cs.fontWeight };
  });
  expect(colHeader.size).toBeCloseTo(11, 2);
  expect(colHeader.leading).toBeCloseTo(14.3, 2);
  expect(colHeader.weight).toBe('500');
  const rowHeader = await reader.locator('tbody th').first().evaluate(el => {
    const cs = getComputedStyle(el);
    return { size: parseFloat(cs.fontSize), weight: cs.fontWeight };
  });
  expect(rowHeader.size).toBeCloseTo(16, 2);
  expect(rowHeader.size).toBe(await reader.locator('tbody td').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize)));
  expect(rowHeader.weight).toBe('500');
});

test('renders Markdown as a reader with a raw HTML row group header in the table body', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', [
    '<table><tbody>',
    '<tr><th scope="rowgroup">Group</th><th>Detail</th></tr>',
    '<tr><td>A</td><td>B</td></tr>',
    '</tbody></table>',
  ].join('\n'));
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const table = page.locator('.doc-reader.markdown table');
  await expect(table.locator('tbody th[scope="rowgroup"]')).toHaveText('Group');
  expect(await table.locator('th[scope="rowgroup"]').evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(16, 2);
  await expect(table.locator('th[scope="rowgroup"]')).toHaveCSS('font-weight', '500');
  await expect(table.locator('tbody th')).toHaveText(['Group', 'Detail']);
  await expect(table.locator('thead')).toHaveCount(0);
});


test('renders Markdown as a reader without promoting a spanning raw HTML table header', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', '<table><tr><th rowspan="2">Package</th><th>Latest</th></tr><tr><td>v2.1</td></tr><tr><td>Panda</td><td>v2.0</td></tr></table>');
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const table = page.locator('.doc-reader.markdown table');
  await expect(table.locator('thead')).toHaveCount(0);
  await expect(table.locator('th[rowspan="2"]')).toHaveText('Package');
  const latest = await table.getByText('Latest', { exact: true }).boundingBox();
  const version = await table.getByText('v2.1', { exact: true }).boundingBox();
  expect(latest).not.toBeNull();
  expect(version).not.toBeNull();
  expect(version!.x).toBeCloseTo(latest!.x, 1);
});

test('renders Markdown as a reader with decimal numbering across an ordered task item', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', '1. First\n2. [x] Task in the sequence\n3. Third');
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const list = page.locator('.doc-reader.markdown ol');
  await expect(list.locator(':scope > li')).toHaveCount(3);
  await expect(list.locator('li.md-task')).toHaveCSS('display', 'list-item');
  await expect(list.locator(':scope > li').nth(2)).toHaveText('Third');
  await expect(list.locator(':scope > li').nth(2)).toHaveCSS('list-style-type', 'decimal');
  await expect(list).not.toHaveAttribute('start');
  await expect(list.locator('li[value]')).toHaveCount(0);
});

test('raw-HTML Markdown preview preserves GitHub admonitions without converting an inline quotation', async ({ page }) => {
  await page.locator('[data-action="open-file"][data-path="README.md"]').click();
  await replaceEditor(page, 'README.md', '<blockquote><p>[!NOTE]<strong> worthy of quotation</strong></p></blockquote>');
  await page.locator('#file-panel').getByRole('button', { name: 'Preview', exact: true }).click();
  const reader = page.locator('.doc-reader.markdown');
  await expect(reader.locator('blockquote')).toHaveText('[!NOTE] worthy of quotation');
  await expect(reader.locator('blockquote strong')).toHaveText(' worthy of quotation');
  await expect(reader.locator('aside.md-admonition')).toHaveCount(0);
});
