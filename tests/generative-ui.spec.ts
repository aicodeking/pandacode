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
  // Install before navigation: reloading during startup can cancel module imports in WebKit.
  await page.addInitScript(() => Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText: async (text: string) => { (window as any).__copied = text; } } }));
  await page.goto('/');
  await expect(page.locator('#prompt')).toBeVisible({ timeout: 30_000 });
});
test.afterEach(async ({ page }) => { expect(errors.get(page)).toEqual([]); });

test('a table sorts, a chart draws and tabs switch with the keyboard', async ({ page }) => {
  await render(page, `Here are the results.\n\n${fence({ type: 'table', title: 'Bundles', columns: ['Name', { label: 'KB', align: 'right' }], rows: [['main', 80], ['vendor', 9], ['lazy', 120]] })}\n\n${fence({ type: 'chart', chart: 'area', title: 'Weekly', labels: ['M', 'T', 'W'], series: [{ name: 'Runs', values: [3, 5, 4] }] })}\n\n${fence({ type: 'tabs', tabs: [{ label: 'Summary', body: 'First **tab**' }, { label: 'Details', children: [{ type: 'callout', tone: 'warning', body: 'Second tab' }] }] })}`);
  const table = view(page, 0);
  await expect(table.locator('caption, figcaption')).toHaveText('Bundles');
  await expect(table.locator('tbody tr').first()).toContainText('main');
  for (const header of await table.locator('th, .gu-sort').all()) {
    const size = await header.evaluate(el => [parseFloat(getComputedStyle(el).fontSize), parseFloat(getComputedStyle(el).lineHeight)]);
    expect(size[0]).toBeCloseTo(11, 2);
    expect(size[1]).toBeCloseTo(14.3, 2);
    await expect(header).toHaveCSS('font-weight', '500');
    await expect(header).toHaveCSS('letter-spacing', 'normal');
  }
  await expect(table.locator('th').nth(1)).toHaveAttribute('scope', 'col');
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

test('generated cards use role-specific leading and keep relative Markdown headings', async ({ page }) => {
  const text = [
    ...Array.from({ length: 6 }, (_, index) => `${'#'.repeat(index + 1)} Heading ${index + 1}`),
    '**Strong emphasis** and __Bold emphasis__.',
    '| Name | KB |\n| --- | ---: |\n| main | 80 |',
    '```ts\nconst answer = 42;\n```',
  ].join('\n\n');
  await render(page, fence({
    type: 'card', body: text,
    children: [{ type: 'stats', items: [{ label: 'Tests', value: 412, hint: 'Last run' }] }],
    actions: [{ label: 'Run tests' }],
  }));
  const card = view(page);
  const md = card.locator('.gu-md');
  await expect(md.locator('h6')).toHaveText('Heading 6');
  for (const compact of [false, true]) {
    await page.locator('#ui-probe').evaluate((el, small) => (el as HTMLElement).style.setProperty('--thread-font', small ? 'var(--type-meta)' : 'var(--type-prose)'), compact);
    const base = compact ? 12 : 16;
    const prose = await md.locator('p').evaluate(el => {
      const style = getComputedStyle(el);
      return [parseFloat(style.fontSize), parseFloat(style.lineHeight)];
    });
    expect(prose[0]).toBeCloseTo(base, 2);
    expect(prose[1]).toBeCloseTo(base * 1.6, 2);
    for (let level = 1; level <= 6; level++) {
      const heading = md.getByRole('heading', { level });
      const size = base * (level <= 2 ? 1.19 : 1);
      const style = await heading.evaluate(el => {
        const cs = getComputedStyle(el);
        return [parseFloat(cs.fontSize), parseFloat(cs.lineHeight)];
      });
      expect(style[0]).toBeCloseTo(size, 2);
      expect(style[1]).toBeCloseTo(size * 1.25, 2);
      await expect(heading).toHaveCSS('font-weight', '600');
      await expect(heading).toHaveCSS('letter-spacing', 'normal');
    }
    const preStyle = await md.locator('pre').evaluate(el => {
      const cs = getComputedStyle(el);
      return [parseFloat(cs.fontSize), parseFloat(cs.lineHeight)];
    });
    expect(preStyle[0]).toBeCloseTo(12, 2);
    expect(preStyle[1]).toBeCloseTo(12 * 1.55, 2);
    const preCodeSize = await md.locator('pre > code').evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(preCodeSize).toBeCloseTo(12, 2);
  }
  for (const [selector, expected] of Object.entries({ '.gu-button': 19.6, '.gu-hint': 16.8, '.gu-stat-label': 14.3 })) {
    const leading = await card.locator(selector).evaluate(el => parseFloat(getComputedStyle(el).lineHeight));
    expect(leading, selector).toBeCloseTo(expected, 2);
  }
  for (const strong of await md.locator('strong').all()) await expect(strong).toHaveCSS('font-weight', '600');
  for (const header of await md.getByRole('columnheader').all()) {
    const size = await header.evaluate(el => [parseFloat(getComputedStyle(el).fontSize), parseFloat(getComputedStyle(el).lineHeight)]);
    expect(size[0]).toBeCloseTo(11, 2);
    expect(size[1]).toBeCloseTo(14.3, 2);
    await expect(header).toHaveCSS('font-weight', '500');
    await expect(header).toHaveCSS('letter-spacing', 'normal');
  }
  await expect(md.locator('td').last()).toHaveText('80');
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

test('generated markdown styles admonitions, task checkboxes, bold inline code, step meta, and nested radii', async ({ page }) => {
  await render(page, fence({
    type: 'card',
    title: 'Outer card',
    body: '**`boldCode`**\n\n> [!NOTE]\n> Inside generated markdown.\n\n- [x] Done item\n- [ ] Open item',
    children: [
      { type: 'callout', tone: 'info', body: 'Nested surface' },
      { type: 'plan', items: [{ title: 'Step 1', detail: 'Detail **copy**', status: 'done' }] },
      { type: 'checklist', items: [{ text: 'Check', done: true }] },
      { type: 'custom', html: '<h1>Custom heading</h1><strong>Custom strong</strong>' },
    ],
  }));
  const ui = view(page);
  await expect(ui.locator('.gu-card')).toHaveCSS('border-radius', '10px');
  await expect(ui.locator('.gu-callout')).toHaveCSS('border-radius', '8px');
  await expect(ui.locator('.gu-check')).toHaveCSS('border-radius', '2px');
  await expect(ui.locator('.gu-md .md-checkbox').first()).toHaveCSS('border-radius', '2px');
  await expect(ui.locator('.gu-md .md-admonition-title')).toHaveCSS('text-transform', 'uppercase');
  await expect(ui.locator('.gu-md .md-admonition-title')).toHaveCSS('font-weight', '600');
  await expect(ui.locator('.gu-md strong code')).toHaveCSS('font-weight', '500');
  const stepDetail = await ui.locator('.gu-step-detail').evaluate(el => {
    const cs = getComputedStyle(el);
    return [parseFloat(cs.fontSize), parseFloat(cs.lineHeight)];
  });
  expect(stepDetail[0]).toBeCloseTo(12, 2);
  expect(stepDetail[1]).toBeCloseTo(16.8, 2);
  const customWeights = await ui.locator('.gu-custom').evaluate(host => {
    const root = host.shadowRoot!;
    return {
      h1Weight: getComputedStyle(root.querySelector('h1')!).fontWeight,
      h1Size: parseFloat(getComputedStyle(root.querySelector('h1')!).fontSize),
      strongWeight: getComputedStyle(root.querySelector('strong')!).fontWeight,
    };
  });
  expect(customWeights.h1Weight).toBe('600');
  // A bare custom-view h1 is --md-heading-lg (1.19em) of the 14px <pandacode-ui> body, not the fixed 19px title.
  expect(customWeights.h1Size).toBeCloseTo(14 * 1.19, 2);
  expect(customWeights.strongWeight).toBe('500');
});

test('KaTeX clips .katex-mathml inside <pandacode-ui> shadow DOM and host/nested radii, form weights and custom markdown stay on scale', async ({ page }) => {
  await render(page, fence({
    type: 'card',
    title: 'Math & nested controls',
    body: 'Inline math $E = mc^2$ and display:\n\n$$\n\\int_0^1 x^2\\,dx = \\frac{1}{3}\n$$',
    children: [
      { type: 'form', title: 'Config', fields: [{ name: 'name', label: 'Name', value: 'orbit' }], submit: 'Save' },
      { type: 'code', file: 'sum.ts', code: 'export const x = 1;' },
      { type: 'tabs', tabs: [{ label: 'One', body: 'First' }, { label: 'Two', body: 'Second' }] },
      { type: 'custom', html: '<div class="markdown"><h1>MD Heading</h1><p><strong><code>boldCode</code></strong></p><pre><code>preCode</code></pre></div><p class="samp-line">Run <samp>out</samp></p><pre class="pre-samp"><samp>block</samp></pre><kbd>Esc</kbd><table><thead><tr><th>Col</th></tr></thead><tbody><tr><th>Row</th><td>Val</td></tr></tbody></table><code>fn()</code><button>Act</button>' },
    ],
  }));
  const ui = view(page);
  await expect(ui.locator('.gu-md .katex-html').first()).toBeVisible();
  const katexSize = await ui.locator('.gu-md .katex').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(katexSize).toBeCloseTo(16.8, 1);
  const mathClip = await ui.locator('.gu-md .katex-mathml').first().evaluate(el => {
    const cs = getComputedStyle(el);
    const rect = el.getBoundingClientRect();
    return { position: cs.position, overflow: cs.overflow, width: rect.width, height: rect.height };
  });
  expect(mathClip.position).toBe('absolute');
  expect(mathClip.overflow).toBe('hidden');
  expect(mathClip.width).toBeLessThanOrEqual(1.5);
  expect(mathClip.height).toBeLessThanOrEqual(1.5);

  const hostType = await ui.evaluate(el => {
    const cs = getComputedStyle(el);
    return [parseFloat(cs.fontSize), parseFloat(cs.lineHeight)];
  });
  expect(hostType[0]).toBeCloseTo(14, 2);
  expect(hostType[1]).toBeCloseTo(19.6, 2);

  await expect(ui.locator('.gu-field input')).toHaveCSS('font-weight', '400');
  await expect(ui.locator('.gu-field input')).toHaveCSS('border-radius', '6px');
  await expect(ui.locator('.gu-copy')).toHaveCSS('border-radius', '6px');
  await expect(ui.locator('[role=tab]').first()).toHaveCSS('border-radius', '6px');
  await expect(ui.locator('.gu-form .gu-button')).toHaveCSS('border-radius', '6px');

  const customMetrics = await ui.locator('.gu-custom').evaluate(host => {
    const root = host.shadowRoot!;
    const h1 = getComputedStyle(root.querySelector('.markdown h1')!);
    const boldCode = getComputedStyle(root.querySelector('.markdown strong code')!);
    const preCode = getComputedStyle(root.querySelector('.markdown pre code')!);
    const samp = getComputedStyle(root.querySelector('.samp-line samp')!);
    const sampLine = getComputedStyle(root.querySelector('.samp-line')!);
    const preSamp = getComputedStyle(root.querySelector('.pre-samp samp')!);
    const rowTd = getComputedStyle(root.querySelector('tbody td')!);
    const kbd = getComputedStyle(root.querySelector('kbd')!);
    const colTh = getComputedStyle(root.querySelector('thead th')!);
    const rowTh = getComputedStyle(root.querySelector('tbody th')!);
    const btn = getComputedStyle(root.querySelector('button')!);
    return {
      h1Weight: h1.fontWeight,
      h1Size: parseFloat(h1.fontSize),
      boldCodeWeight: boldCode.fontWeight,
      boldCodeSize: parseFloat(boldCode.fontSize),
      boldCodeLeading: parseFloat(boldCode.lineHeight),
      preCodeSize: parseFloat(preCode.fontSize),
      sampFont: samp.fontFamily,
      sampSize: parseFloat(samp.fontSize),
      sampLineSize: parseFloat(sampLine.fontSize),
      preSampSize: parseFloat(preSamp.fontSize),
      rowLeading: parseFloat(rowTh.lineHeight),
      cellSize: parseFloat(rowTd.fontSize),
      cellLeading: parseFloat(rowTd.lineHeight),
      kbdSize: parseFloat(kbd.fontSize),
      kbdLeading: parseFloat(kbd.lineHeight),
      colSize: parseFloat(colTh.fontSize),
      colWeight: colTh.fontWeight,
      rowSize: parseFloat(rowTh.fontSize),
      rowWeight: rowTh.fontWeight,
      btnRadius: btn.borderRadius,
    };
  });
  expect(customMetrics.h1Weight).toBe('600');
  expect(customMetrics.h1Size).toBeCloseTo(16 * 1.19, 1);
  expect(customMetrics.boldCodeWeight).toBe('500');
  expect(customMetrics.boldCodeSize).toBeCloseTo(16 * 0.9, 1);
  expect(customMetrics.boldCodeLeading).toBeCloseTo(16 * 0.9 * 1.6, 1);
  expect(customMetrics.preCodeSize).toBeCloseTo(12, 1);
  expect(customMetrics.sampFont.toLowerCase()).toMatch(/mono|menlo|consolas/);
  // Inline samp is 0.9em of its line like inline code; only pre samp takes the 12px mono size.
  expect(customMetrics.sampLineSize).toBeCloseTo(14, 1);
  expect(Math.abs(customMetrics.sampSize / customMetrics.sampLineSize - 0.9)).toBeLessThanOrEqual(0.02);
  expect(customMetrics.preSampSize).toBeCloseTo(12, 1);
  expect(customMetrics.kbdSize).toBeCloseTo(11, 1);
  expect(customMetrics.kbdLeading).toBeCloseTo(14.3, 1);
  expect(customMetrics.colSize).toBeCloseTo(11, 1);
  expect(customMetrics.colWeight).toBe('500');
  expect(customMetrics.rowSize).toBeCloseTo(14, 1);
  expect(customMetrics.rowSize).toBeCloseTo(customMetrics.cellSize, 2);
  expect(customMetrics.rowLeading).toBeCloseTo(customMetrics.cellLeading, 1);
  expect(customMetrics.rowWeight).toBe('500');
  expect(customMetrics.btnRadius).toBe('6px');

  // Top-level .gu-md pre is 8px with 6px copy button, and <pandacode-code> never mutates its light-DOM class.
  await render(page, `${fence({ type: 'markdown', text: '```ts\nconst top = 1;\n```' })}\n\n${fence({ type: 'card', body: '```ts\nconst nested = 2;\n```' })}`);
  const topCodeMetrics = await view(page, 0).locator('pandacode-code').evaluate(el => {
    const btn = getComputedStyle(el.shadowRoot!.querySelector('button')!);
    const pre = getComputedStyle(el.querySelector('pre')!);
    return { cls: el.getAttribute('class'), preRadius: pre.borderRadius, btnRadius: btn.borderRadius, btnSize: parseFloat(btn.fontSize) };
  });
  expect(topCodeMetrics.cls).toBeNull();
  expect(topCodeMetrics.preRadius).toBe('8px');
  expect(topCodeMetrics.btnRadius).toBe('6px');
  expect(topCodeMetrics.btnSize).toBeCloseTo(16, 1);
  const cardCodeMetrics = await view(page, 1).locator('pandacode-code').evaluate(el => {
    const btn = getComputedStyle(el.shadowRoot!.querySelector('button')!);
    const pre = getComputedStyle(el.querySelector('pre')!);
    return { cls: el.getAttribute('class'), preRadius: pre.borderRadius, btnRadius: btn.borderRadius };
  });
  expect(cardCodeMetrics.cls).toBeNull();
  expect(cardCodeMetrics.preRadius).toBe('6px');
  expect(cardCodeMetrics.btnRadius).toBe('2px');

  // Inside an 8px .turn-card-reply host, nested card children step down to 6px (< 8px),
  // controls inside 6px containers step down to 2px, and wide display math scrolls inside .md-math-block.
  await page.evaluate(async source => {
    const { markdownHtml } = await import('/src/dom.ts');
    let host = document.querySelector<HTMLElement>('#reply-probe');
    if (!host) {
      host = document.createElement('div');
      host.id = 'reply-probe';
      host.className = 'turn-card-reply markdown';
      host.style.cssText = 'position:fixed;inset:40px 40px auto auto;width:240px;z-index:999;padding:12px;background:var(--bg)';
      document.body.append(host);
    }
    host.innerHTML = await markdownHtml(source);
  }, fence({
    type: 'card',
    title: 'In reply',
    body: '$$\n\\sum_{k=1}^{n} a_k x^k + \\sum_{j=1}^{m} b_j y^j + \\sum_{r=1}^{p} c_r z^r = \\frac{\\alpha + \\beta + \\gamma + \\delta}{\\epsilon + \\zeta}\n$$\n\n```ts\nconst nested = 1;\n```',
    children: [
      { type: 'callout', tone: 'info', body: 'Nested in reply' },
      { type: 'form', title: 'Nested form', fields: [{ name: 'name', label: 'Name', value: 'x' }], submit: 'Go' },
      { type: 'code', file: 'n.ts', code: 'export const n = 1;' },
      { type: 'tabs', tabs: [{ label: 'A', body: 'a' }] },
      { type: 'custom', html: '<button>Tight</button>' },
      { type: 'card', title: 'Depth 2', body: '```ts\nconst deep = 3;\n```', children: [{ type: 'callout', tone: 'note', body: 'Depth 3' }] },
    ],
  }) + '\n\n```ui\n{"type":"callout","body":"half');
  const replyUi = page.locator('#reply-probe pandacode-ui').nth(0);
  await expect(replyUi.locator('.gu-card').first()).toHaveCSS('border-radius', '8px');
  await expect(replyUi.locator('.gu-callout').first()).toHaveCSS('border-radius', '6px');
  await expect(replyUi.locator('.gu-card .gu-card .gu-callout')).toHaveCSS('border-radius', '2px');
  await expect(replyUi.locator('.gu-card .gu-card .gu-md pre')).toHaveCSS('border-radius', '2px');
  await expect(replyUi.locator('.gu-form .gu-field input')).toHaveCSS('border-radius', '2px');
  await expect(replyUi.locator('.gu-form .gu-button')).toHaveCSS('border-radius', '2px');
  await expect(replyUi.locator('.gu-code .gu-copy')).toHaveCSS('border-radius', '2px');
  await expect(replyUi.locator('[role=tab]').first()).toHaveCSS('border-radius', '2px');
  expect(await replyUi.locator('.gu-custom').evaluate(el => getComputedStyle(el.shadowRoot!.querySelector('button')!).borderRadius)).toBe('2px');
  expect(await replyUi.locator('pandacode-code').first().evaluate(el => getComputedStyle(el.shadowRoot!.querySelector('button')!).borderRadius)).toBe('2px');
  await expect(page.locator('#reply-probe pandacode-ui').nth(1).locator('.gu-pending')).toHaveCSS('border-radius', '8px');
  const mathContainment = await replyUi.evaluate(host => {
    const root = host.shadowRoot!;
    const card = root.querySelector<HTMLElement>('.gu-card')!;
    const block = root.querySelector<HTMLElement>('.gu-md .md-math-block')!;
    return {
      overflowX: getComputedStyle(block).overflowX,
      cardScrollWidth: card.scrollWidth,
      cardClientWidth: card.clientWidth,
    };
  });
  expect(mathContainment.overflowX).toBe('auto');
  expect(mathContainment.cardScrollWidth).toBeLessThanOrEqual(mathContainment.cardClientWidth + 1);

  // Inside an 8px tight host (.gh-job-summary), surfaces step down to 6px, nested children/controls to 2px, and .gu-pending is 6px.
  await page.evaluate(async source => {
    const { markdownHtml } = await import('/src/dom.ts');
    let host = document.querySelector<HTMLElement>('#tight-probe');
    if (!host) {
      host = document.createElement('div');
      host.id = 'tight-probe';
      host.className = 'gh-job-summary markdown';
      host.style.cssText = 'position:fixed;inset:40px auto auto 700px;width:240px;z-index:999;padding:12px;background:var(--bg)';
      document.body.append(host);
    }
    host.innerHTML = await markdownHtml(source);
  }, fence({
    type: 'card',
    title: 'In summary',
    body: '```ts\nconst tight = 1;\n```',
    children: [{ type: 'callout', tone: 'info', body: 'Child' }],
    actions: [{ label: 'Run' }],
  }) + '\n\n```ui\n{"type":"callout","body":"half');
  const tightUi = page.locator('#tight-probe pandacode-ui').nth(0);
  await expect(tightUi.locator('.gu-card')).toHaveCSS('border-radius', '6px');
  await expect(tightUi.locator('.gu-callout')).toHaveCSS('border-radius', '2px');
  await expect(tightUi.locator('.gu-md pre')).toHaveCSS('border-radius', '2px');
  await expect(tightUi.locator('.gu-button')).toHaveCSS('border-radius', '2px');
  expect(await tightUi.locator('pandacode-code').evaluate(el => getComputedStyle(el.shadowRoot!.querySelector('button')!).borderRadius)).toBe('2px');
  await expect(page.locator('#tight-probe pandacode-ui').nth(1).locator('.gu-pending')).toHaveCSS('border-radius', '6px');
});
