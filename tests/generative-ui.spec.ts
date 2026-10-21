import { expect, test, type Page } from '@playwright/test';

/** Renders Markdown through the app's own pipeline into a probe beside the open task. */
async function render(page: Page, markdown: string): Promise<void> {
  await page.evaluate(async source => {
    const { markdownHtml } = await import('/src/dom.ts');
    let host = document.querySelector<HTMLElement>('#ui-probe');
    if (!host) {
      host = document.createElement('div');
      host.id = 'ui-probe';
      host.className = 'markdown';
      host.style.cssText = 'position:fixed;inset:40px auto auto 40px;width:640px;max-height:80vh;overflow:auto;z-index:999;padding:20px;background:var(--bg)';
      document.body.append(host);
    }
    host.innerHTML = await markdownHtml(source);
  }, markdown);
}
const view = (page: Page, index = 0) => page.locator('#ui-probe pandacode-ui').nth(index);
const fence = (spec: unknown) => `\`\`\`ui\n${JSON.stringify(spec)}\n\`\`\``;

const errors = new WeakMap<Page, string[]>();
test.beforeEach(async ({ page }) => {
  const list: string[] = []; errors.set(page, list);
  page.on('pageerror', error => list.push(error.message));
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeVisible();
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

test('a table sorts, a chart draws and tabs switch with the keyboard', async ({ page }) => {
  await render(page, `Here are the results.\n\n${fence({ type: 'table', title: 'Bundles', columns: ['Name', { label: 'KB', align: 'right' }], rows: [['main', 80], ['vendor', 9], ['lazy', 120]] })}\n\n${fence({ type: 'chart', chart: 'area', title: 'Weekly', labels: ['M', 'T', 'W'], series: [{ name: 'Runs', values: [3, 5, 4] }] })}\n\n${fence({ type: 'tabs', tabs: [{ label: 'Summary', body: 'First **tab**' }, { label: 'Details', children: [{ type: 'callout', tone: 'warning', body: 'Second tab' }] }] })}`);
  const table = view(page, 0);
  await expect(table.locator('caption, figcaption')).toHaveText('Bundles');
  await expect(table.locator('tbody tr').first()).toContainText('main');
  await table.getByRole('button', { name: 'KB' }).click();
  await expect(table.locator('tbody tr').first()).toContainText('vendor');
  await expect(table.locator('th').nth(1)).toHaveAttribute('aria-sort', 'ascending');
  await table.getByRole('button', { name: 'KB' }).click();
  await expect(table.locator('tbody tr').first()).toContainText('lazy');

  const chart = view(page, 1);
  await expect(chart.getByRole('img', { name: 'Weekly' })).toBeVisible();
  await expect(chart.locator('polygon')).toHaveCount(1);

  const tabs = view(page, 2);
  await expect(tabs.getByRole('tab')).toHaveCount(2);
  await expect(tabs.getByRole('tabpanel', { name: 'Summary' })).toContainText('First tab');
  await tabs.getByRole('tab', { name: 'Summary' }).focus();
  await page.keyboard.press('ArrowRight');
  await expect(tabs.getByRole('tab', { name: 'Details' })).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.getByRole('alert')).toHaveText('Second tab');
});

test('buttons and forms fill the composer for the user to send', async ({ page }) => {
  await render(page, `${fence({ type: 'plan', title: 'Plan', items: [{ title: 'Read code', status: 'done' }, { title: 'Fix', status: 'active' }], actions: [{ label: 'Implement plan', prompt: 'Implement the plan.', tone: 'primary' }] })}\n\n${fence({ type: 'form', fields: [{ name: 'env', label: 'Environment', options: ['staging', 'prod'] }, { name: 'dry', label: 'Dry run', type: 'checkbox' }], submit: 'Prepare', prompt: 'Deploy to {env}, dry run {dry}.' })}`);
  await view(page, 0).getByRole('button', { name: 'Implement plan' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Implement the plan.');
  await expect(page.locator('#prompt')).toBeFocused();
  await page.locator('#prompt').fill('');
  const form = view(page, 1);
  await form.getByLabel('Environment').selectOption('prod');
  await form.getByLabel('Dry run').check();
  await form.getByRole('button', { name: 'Prepare' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Deploy to prod, dry run yes.');
});

test('custom views are sanitized, scoped and only fill the composer', async ({ page }) => {
  await render(page, 'Outside\n\n' + fence({
    type: 'custom', state: { picked: 'none' },
    css: 'p{color:red} .x{background:url(https://evil.test/a.png)}',
    html: '<p class="x" onclick="window.__pwned=1">Pick</p><script>window.__pwned=1</script><img src="https://evil.test/i.png"><iframe src="https://evil.test"></iframe>'
      + '<button data-ui-set="picked=blue">Blue</button><span data-ui-bind="picked"></span><button data-ui-toggle="#more">More</button><div id="more" hidden>Hidden</div>'
      + '<button data-ui-prompt="Use {picked}">Use it</button>',
  }));
  const custom = view(page).locator('.gu-custom');
  await expect(custom.getByText('Pick')).toBeVisible();
  const leftovers = await custom.evaluate(host => {
    const root = host.shadowRoot!;
    return { script: root.querySelectorAll('script').length, iframe: root.querySelectorAll('iframe').length, onclick: root.querySelectorAll('[onclick]').length, remote: root.querySelectorAll('img[src]').length, css: root.innerHTML.includes('evil.test') };
  });
  expect(leftovers).toEqual({ script: 0, iframe: 0, onclick: 0, remote: 0, css: false });
  // Scoped: the custom red paragraph rule does not reach the app.
  await expect(page.locator('#ui-probe > p')).not.toHaveCSS('color', 'rgb(255, 0, 0)');
  await expect(custom.getByText('Pick')).toHaveCSS('color', 'rgb(255, 0, 0)');
  await custom.getByRole('button', { name: 'Blue' }).click();
  await expect(custom.locator('[data-ui-bind]')).toHaveText('blue');
  await expect(custom.getByText('Hidden')).toBeHidden();
  await custom.getByRole('button', { name: 'More' }).click();
  await expect(custom.getByText('Hidden')).toBeVisible();
  await custom.getByRole('button', { name: 'Use it' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Use blue');
  expect(await page.evaluate(() => (window as any).__pwned)).toBeUndefined();
});

test('invalid specs fall back to their source, unknown types to their data, open fences wait', async ({ page }) => {
  await render(page, '```ui\n{"type": "table",\n```\n\n' + fence({ type: 'hologram', depth: 3 }) + '\n\n```chart\n{"type":"pie","labels":["a","b"],"series":[{"values":[1,3]}]}\n```');
  await expect(view(page, 0).getByText('This view is not valid JSON.')).toBeVisible();
  await expect(view(page, 0).locator('.gu-failed pre')).toContainText('"type": "table"');
  await expect(view(page, 1)).toContainText('no “hologram” view');
  await expect(view(page, 2).locator('svg path')).toHaveCount(2);
  await render(page, 'Working on it\n\n```ui\n{"type":"callout","body":"half');
  await expect(view(page, 0)).toHaveClass('pending');
  await expect(view(page, 0).getByRole('status', { name: 'Building view' })).toHaveText('');
});

test('stats, tree, diff, code and checklist render as labelled, copyable views', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } }));
  await page.reload();
  await expect(page.locator('#prompt')).toBeVisible();
  await render(page, fence({ type: 'grid', columns: 2, children: [
    { type: 'stats', items: [{ label: 'Tests', value: 412, delta: '+12', spark: [1, 3, 2, 5] }, { label: 'Bundle', value: '78 KB', delta: '-2 KB' }] },
    { type: 'tree', paths: ['src/a.ts', 'src/b.ts'] },
    { type: 'diff', file: 'src/a.ts', diff: '@@ -1 +1 @@\n-old\n+new' },
    { type: 'code', file: 'main.ts', code: 'export {}' },
    { type: 'checklist', title: 'Ship', items: [{ text: 'Typecheck', done: true }, 'Release'] },
  ] }));
  const ui = view(page);
  await expect(ui.locator('.gu-stat-value').first()).toHaveText('412');
  await expect(ui.locator('.gu-down')).toContainText('-2 KB');
  await expect(ui.getByRole('tree')).toContainText('a.ts');
  await expect(ui.locator('.gu-add')).toHaveText('+new\n');
  await expect(ui.locator('.gu-del')).toHaveText('-old\n');
  await expect(ui.locator('.gu-title').filter({ hasText: 'Ship · 1/2' })).toBeVisible();
  await ui.getByRole('button', { name: 'Copy main.ts' }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('export {}');
});

test('details collapse, follow-up directives become chips, code blocks copy and mermaid shows its source', async ({ page }) => {
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } }));
  await page.reload();
  await expect(page.locator('#prompt')).toBeVisible();
  await render(page, '<details><summary>Why</summary>\n\nBecause **reasons**.\n\n</details>\n\nNext steps :codex-followup[Run tests]{prompt="Run the full test suite."}\n\n```ts\nconst a = 1;\n```\n\n```mermaid\ngraph TD; A-->B\n```\n\n> [!TIP]\n> Alerts still work.');
  const probe = page.locator('#ui-probe');
  await expect(probe.locator('details > summary')).toHaveText('Why');
  await expect(probe.getByText('Because')).toBeHidden();
  await probe.locator('details > summary').click();
  await expect(probe.locator('details strong')).toHaveText('reasons');
  await expect(probe.locator('p').filter({ hasText: 'Next steps' })).not.toContainText('codex-followup');
  await probe.getByRole('button', { name: 'Run tests' }).click();
  await expect(page.locator('#prompt')).toHaveValue('Run the full test suite.');
  await expect(probe.locator('pandacode-code pre > code.language-ts')).toHaveText('const a = 1;\n');
  // The copy button adds no text: a message reads (and copies) as its code alone.
  await expect(probe.locator('pandacode-code')).toHaveText('const a = 1;');
  await probe.locator('pandacode-code').hover();
  await probe.getByRole('button', { name: 'Copy code' }).click();
  expect(await page.evaluate(() => (window as any).__copied)).toBe('const a = 1;\n');
  await expect(probe.locator('.gu-code-head')).toContainText('Diagram · Mermaid');
  await expect(probe.locator('aside.md-admonition-tip')).toContainText('Alerts still work.');
});
