import { expect, test, type Locator } from '@playwright/test';
import { expectToken, expectRole, expectNestedRadius, openWorkspace, codeRatio } from './design-roles-helpers';

// Shadow DOM typography: rich-HTML, custom views, Markdown parity and compact contexts.

const px = (locator: Locator, prop: 'fontSize' | 'lineHeight' = 'fontSize') => locator.evaluate((el, p) => parseFloat(getComputedStyle(el)[p]), prop);

/** Bare Shadow DOM headings are relative: h1/h2 are --md-heading-lg (1.19em), h3..h6 are 1em; all 600 with --tracking-none, like Markdown h1/h2. */
async function expectBareHeading(heading: Locator, contextSize: number, kind: 'lg' | 'em'): Promise<void> {
  await expect(heading).toBeVisible({ timeout: 30_000 });
  const label = await heading.evaluate(el => el.tagName);
  expect(await px(heading), `${label} size in a ${contextSize}px context`).toBeCloseTo(contextSize * (kind === 'lg' ? 1.19 : 1), 1);
  await expect(heading, `${label} weight`).toHaveCSS('font-weight', '600');
  await expectToken(heading, 'lineHeight', '--type-title-leading', true);
  await expectToken(heading, 'letterSpacing', '--tracking-none', true);
}

/** Bare body row headers (tbody th, th[scope=row]) are 1em medium with inherited leading: the same size as their cells. */
async function expectRowHeader(row: Locator, cell: Locator, contextSize: number): Promise<void> {
  await expect(row).toBeVisible({ timeout: 30_000 });
  expect(await px(cell), 'cell size').toBeCloseTo(contextSize, 1);
  expect(await px(row), 'row header matches its cell').toBeCloseTo(await px(cell), 2);
  await expect(row).toHaveCSS('font-weight', '500');
  await expectToken(row, 'letterSpacing', '--tracking-none', true);
  expect(await px(row, 'lineHeight'), 'row header inherits the cell leading, not caption 1.3').toBeCloseTo(await px(cell, 'lineHeight'), 1);
}

test('design role: pandacode-ui rich-markdown and gu-custom Shadow DOM typography', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.waitForSelector('html[data-ready]', { timeout: 30_000 });

  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const [{ markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-shadow-type-host';
    host.className = 'markdown';
    (document.querySelector('#transcript') ?? document.body).append(host);

    // 1. Real <pandacode-ui> carrying a .rich-markdown block inside its Shadow DOM.
    const richUiWrap = document.createElement('div');
    richUiWrap.dataset.probe = 'rich-ui';
    richUiWrap.innerHTML = await markdownHtml('```ui\n{"type":"card","title":"Host"}\n```');
    host.append(richUiWrap);

    const uiEl = richUiWrap.querySelector('pandacode-ui')!;
    await new Promise<void>(resolve => {
      const check = () => {
        if (uiEl.shadowRoot?.querySelector('.gu-card')) resolve();
        else setTimeout(check, 20);
      };
      check();
    });
    const richBox = document.createElement('div');
    richBox.dataset.probe = 'rich-md';
    uiEl.shadowRoot!.querySelector('.gu')!.append(richBox);
    await richMarkdown(
      richBox,
      [
        '# Heading One',
        '',
        '### Heading Three',
        '',
        'Math $x^2$ and `inline` and [GitHub](https://github.com/pandacode/app).',
        '',
        '```ts',
        'const n = 42;',
        '```',
      ].join('\n'),
      { image: async () => '' },
    );

    // 2. Real <pandacode-ui> custom view (.gu-custom Shadow DOM) with <button>, <small>, and <strong><kbd>.
    const customWrap = document.createElement('div');
    customWrap.dataset.probe = 'custom-ui';
    customWrap.innerHTML = await markdownHtml(
      '```ui\n' + JSON.stringify({
        type: 'custom',
        html: '<div class="markdown"><h1>Title <small>Note</small> <button>Action</button></h1><p><strong><kbd>⌘K</kbd></strong></p></div>',
      }) + '\n```',
    );
    host.append(customWrap);

    // 3. Shadow DOM .gu-custom and .rich-html inside a bold/tight ancestor: :host resets weight & tracking;
    //    zero-specificity heading roles remain overridable by author CSS.
    const boldTight = document.createElement('div');
    boldTight.dataset.probe = 'bold-tight-ancestor';
    boldTight.style.cssText = 'font-weight:700;letter-spacing:var(--tracking-tight)';
    host.append(boldTight);

    const customResetWrap = document.createElement('div');
    customResetWrap.dataset.probe = 'custom-reset-ui';
    customResetWrap.innerHTML = await markdownHtml(
      '```ui\n' + JSON.stringify({
        type: 'custom',
        css: 'h2.custom-heading{font-weight:400}',
        html: '<p>Body reset <tt>tt</tt></p><h1>Title <code>tag</code></h1><h2 class="bare-heading">Bare</h2><h2 class="custom-heading">Custom</h2><table><tbody><tr><th scope="col">Col</th></tr><tr><th scope="row">Row</th><td>Val</td></tr></tbody></table>',
      }) + '\n```',
    );
    boldTight.append(customResetWrap);

    const richHtmlBox = document.createElement('div');
    richHtmlBox.dataset.probe = 'rich-html-reset';
    boldTight.append(richHtmlBox);
    await richMarkdown(
      richHtmlBox,
      '```html\n<p>Body reset <tt>tt</tt></p><h1>Title <code>tag</code></h1><h2 class="bare-heading">Bare</h2><h2 class="custom-heading" style="font-weight:400">Custom</h2><table><tbody><tr><th scope="col">Col</th></tr><tr><th scope="row">Row</th><td>Val</td></tr></tbody></table>\n```',
      { image: async () => '' },
    );

    // 4. Light DOM .markdown inside .agent-input legend resets to regular weight (400).
    await import(/* @vite-ignore */ '/src/agent-input.css');
    const agentInput = document.createElement('div');
    agentInput.className = 'agent-input';
    agentInput.dataset.probe = 'agent-input-legend';
    agentInput.innerHTML = '<fieldset class="agent-input-question"><legend><span class="markdown">Legend markdown</span></legend></fieldset>';
    host.append(agentInput);
  });

  const host = page.locator('#design-role-shadow-type-host');

  // Verify <pandacode-ui> .rich-markdown Shadow DOM typography.
  const richMd = host.locator('[data-probe="rich-ui"] pandacode-ui').locator('[data-probe="rich-md"].rich-markdown');
  await expect(richMd).toBeVisible({ timeout: 30_000 });

  const h1 = richMd.locator('h1');
  const h1Metrics = await h1.evaluate(el => {
    const cs = getComputedStyle(el);
    return { fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight, lineHeight: parseFloat(cs.lineHeight) };
  });
  expect(h1Metrics.fontSize).toBeCloseTo(19.04, 1);
  expect(h1Metrics.fontWeight).toBe('600');
  expect(h1Metrics.lineHeight).toBeCloseTo(23.8, 1);

  const h3 = richMd.locator('h3');
  const h3Metrics = await h3.evaluate(el => {
    const cs = getComputedStyle(el);
    return { fontSize: parseFloat(cs.fontSize), fontWeight: cs.fontWeight };
  });
  expect(h3Metrics.fontSize).toBeCloseTo(16, 1);
  expect(h3Metrics.fontWeight).toBe('600');

  const katex = richMd.locator('.katex').first();
  await expect(katex).toBeVisible({ timeout: 30_000 });
  const katexSize = await katex.evaluate(el => parseFloat(getComputedStyle(el).fontSize));
  expect(katexSize).toBeCloseTo(16.8, 1);
  expect(katexSize).not.toBeCloseTo(19.36, 1);

  const inlineCode = richMd.locator('p code').first();
  await expect(inlineCode).toBeVisible();
  expect(await inlineCode.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(14.4, 1);

  const fencedPre = richMd.locator('pre').first();
  const fencedCode = fencedPre.locator('code').first();
  await expect(fencedPre).toBeVisible();
  const preMetrics = await fencedPre.evaluate(el => {
    const cs = getComputedStyle(el);
    return { fontSize: parseFloat(cs.fontSize), lineHeight: parseFloat(cs.lineHeight) };
  });
  expect(preMetrics.fontSize).toBeCloseTo(12, 1);
  expect(preMetrics.lineHeight).toBeCloseTo(18.6, 1);
  expect(await fencedCode.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(12, 1);

  const mdCite = richMd.locator('.md-cite').first();
  await expect(mdCite).toBeVisible();
  expect(await mdCite.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(16 * 0.82, 1);

  // Verify .gu-custom Shadow DOM <button>, <small>, and <strong><kbd>.
  const customRoot = host.locator('[data-probe="custom-ui"] pandacode-ui').locator('.gu-custom');
  await expect(customRoot).toBeVisible({ timeout: 30_000 });
  const customBtn = customRoot.locator('.markdown h1 button');
  await expect(customBtn).toBeVisible({ timeout: 30_000 });
  expect(await customBtn.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(14, 1);
  await expect(customBtn).toHaveCSS('font-weight', '500');

  const customSmall = customRoot.locator('.markdown h1 small');
  await expect(customSmall).toBeVisible();
  await expect(customSmall).toHaveCSS('font-weight', '400');

  const customKbd = customRoot.locator('.markdown strong kbd');
  await expect(customKbd).toBeVisible();
  await expect(customKbd).toHaveCSS('font-weight', '400');

  // Verify body resets, bare heading defaults, author overrides and scoped table headers in both shadow builders.
  const customResetHost = host.locator('[data-probe="custom-reset-ui"] pandacode-ui').locator('.gu-custom');
  await expect(customResetHost).toBeVisible({ timeout: 30_000 });
  const richHtmlHost = host.locator('[data-probe="rich-html-reset"] .rich-html');
  await expect(richHtmlHost).toBeVisible({ timeout: 30_000 });
  // The custom view sits on <pandacode-ui>'s 14px body; rich-HTML inherits the surrounding 16px conversation Markdown.
  for (const [label, shadowHost, textRole, textSize] of [
    ['.gu-custom', customResetHost, 'body', 14],
    ['.rich-html', richHtmlHost, 'prose', 16],
  ] as const) {
    await expectRole(shadowHost.locator('p'), textRole);
    await expect(shadowHost.locator('p'), `${label} body blocks ancestor weight`).toHaveCSS('font-weight', '400');
    expect(await px(shadowHost.locator('p'))).toBeCloseTo(textSize, 1);
    // Bare h1/h2 are --md-heading-lg (1.19em) of the context, not the fixed title/heading roles.
    await expectBareHeading(shadowHost.locator('h1'), textSize, 'lg');
    await expectBareHeading(shadowHost.locator('h2.bare-heading'), textSize, 'lg');
    const headingCode = shadowHost.locator('h1 code');
    const headingSize = await px(shadowHost.locator('h1'));
    expect(await px(headingCode), `${label} heading code follows heading size`).toBeCloseTo(headingSize * 0.9, 2);
    await expectToken(headingCode, 'letterSpacing', '--tracking-none', true);
    // <tt> shares the --mono family with code, not the body face.
    const tt = shadowHost.locator('p tt');
    const ttFamily = await tt.evaluate(el => getComputedStyle(el).fontFamily);
    expect(ttFamily, `${label} tt uses --mono`).toBe(await headingCode.evaluate(el => getComputedStyle(el).fontFamily));
    expect(ttFamily, `${label} tt is not the body face`).not.toBe(await shadowHost.locator('p').evaluate(el => getComputedStyle(el).fontFamily));
    await expect(shadowHost.locator('h2.custom-heading'), `${label} author CSS overrides default`).toHaveCSS('font-weight', '400');
    await expect(shadowHost.locator('thead')).toHaveCount(0);
    await expectRole(shadowHost.locator('th[scope="col"]'), 'caption', '--weight-medium');
    await expectRowHeader(shadowHost.locator('th[scope="row"]'), shadowHost.locator('td').first(), textSize);
  }

  // Light DOM .markdown inside .agent-input legend computes regular weight (400) while legend is 500.
  const agentLegend = host.locator('[data-probe="agent-input-legend"] legend');
  const agentLegendMd = agentLegend.locator('.markdown');
  await expect(agentLegendMd).toBeVisible();
  await expect(agentLegend).toHaveCSS('font-weight', '500');
  await expect(agentLegendMd).toHaveCSS('font-weight', '400');
});

test('design role: nested markdown quotes, admonitions, and cross-ShadowRoot pandacode-ui', async ({ page }) => {
  test.setTimeout(60_000);
  await page.goto('/?cards', { waitUntil: 'domcontentloaded' });
  await page.locator('.task-item', { hasText: 'Turn cards' }).click();
  const reply = page.locator('.turn-card:not(.is-live) .turn-card-reply').first();
  await expect(reply).toBeVisible({ timeout: 30_000 });

  await reply.evaluate(async el => {
    el.setAttribute('data-open', '');
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const [{ markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);

    async function populateNested(container: HTMLElement): Promise<void> {
      const innerMd = [
        '```ts',
        'const nested = true;',
        '```',
        '',
        '> Inner quote',
        '',
        '> [!TIP]',
        '> Inner admonition',
        '',
        '```ui',
        '{"type":"card","title":"Nested UI","body":"Inside quote"}',
        '```',
      ].join('\n');
      container.innerHTML = await markdownHtml(innerMd);
      const richHost = document.createElement('div');
      richHost.dataset.probe = 'rich';
      container.append(richHost);
      await richMarkdown(richHost, '```chart\n{"type":"bar","labels":["A"],"series":[{"values":[1]}]}\n```', { image: async () => '' });
    }

    // 1. Top-level .markdown outside .turn-card-reply: 10px quote/admonition -> 8px nested pre/quote/admonition/pandacode-ui/rich-markdown.
    const topHost = document.createElement('div');
    topHost.id = 'design-role-nested-md-top';
    topHost.className = 'markdown';
    (document.querySelector('#transcript') ?? document.body).append(topHost);

    const topQuote = document.createElement('blockquote');
    topQuote.dataset.probe = 'top-quote';
    topHost.append(topQuote);
    await populateNested(topQuote);

    const topAdmon = document.createElement('aside');
    topAdmon.className = 'md-admonition md-admonition-note';
    topAdmon.dataset.probe = 'top-admon';
    topHost.append(topAdmon);
    await populateNested(topAdmon);

    // 2. Inside .turn-card-reply: 8px quote/admonition -> 6px nested pre/quote/admonition/pandacode-ui/rich-markdown + 2px copy button.
    const replyBody = el.querySelector('.turn-card-reply-body') ?? el;
    const replyHost = document.createElement('div');
    replyHost.id = 'design-role-nested-md-reply';
    replyHost.className = 'markdown';
    replyBody.append(replyHost);

    const replyQuote = document.createElement('blockquote');
    replyQuote.dataset.probe = 'reply-quote';
    replyHost.append(replyQuote);
    await populateNested(replyQuote);

    const replyAdmon = document.createElement('aside');
    replyAdmon.className = 'md-admonition md-admonition-note';
    replyAdmon.dataset.probe = 'reply-admon';
    replyHost.append(replyAdmon);
    await populateNested(replyAdmon);

    // 3. Cross-ShadowRoot <pandacode-ui> nesting inside .turn-card-reply: 10px reply -> 8px outer .gu-card -> 6px inner .gu-card.
    const crossHost = document.createElement('div');
    crossHost.id = 'design-role-cross-shadow-gu';
    crossHost.className = 'markdown';
    const innerUiFence = '```ui\n{"type":"card","title":"Inner Shadow Card","body":"Deep"}\n```';
    crossHost.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({ type: 'card', title: 'Outer Shadow Card', body: innerUiFence }) + '\n```');
    replyBody.append(crossHost);
  });

  // Top-level .markdown: 10px (--radius-inner) -> 8px (--radius-control)
  const topHost = page.locator('#design-role-nested-md-top');
  for (const probe of ['top-quote', 'top-admon'] as const) {
    const outer = topHost.locator(`[data-probe="${probe}"]`);
    await expect(outer).toBeVisible({ timeout: 30_000 });
    await expectNestedRadius(outer.locator('pre').first(), outer, '--radius-control', '--radius-inner');
    await expectNestedRadius(outer.locator('blockquote').first(), outer, '--radius-control', '--radius-inner');
    await expectNestedRadius(outer.locator('.md-admonition').first(), outer, '--radius-control', '--radius-inner');
    await expectNestedRadius(outer.locator('pandacode-ui').locator('.gu-card').first(), outer, '--radius-control', '--radius-inner');
    await expectNestedRadius(outer.locator('[data-probe="rich"] .rich-chart').first(), outer, '--radius-control', '--radius-inner');
  }

  // Inside .turn-card-reply: 10px reply -> 8px quote/admonition -> 6px nested elements + 2px copy button
  const replyHost = page.locator('#design-role-nested-md-reply');
  for (const probe of ['reply-quote', 'reply-admon'] as const) {
    const outer = replyHost.locator(`[data-probe="${probe}"]`);
    await expect(outer).toBeVisible({ timeout: 30_000 });
    await expectNestedRadius(outer, reply, '--radius-control', '--radius-inner');
    await expectNestedRadius(outer.locator('pre').first(), outer, '--radius-chip', '--radius-control');
    await expectNestedRadius(outer.locator('blockquote').first(), outer, '--radius-chip', '--radius-control');
    await expectNestedRadius(outer.locator('.md-admonition').first(), outer, '--radius-chip', '--radius-control');
    await expectNestedRadius(outer.locator('pandacode-ui').locator('.gu-card').first(), outer, '--radius-chip', '--radius-control');
    await expectNestedRadius(outer.locator('[data-probe="rich"] .rich-chart').first(), outer, '--radius-chip', '--radius-control');
    const copyBtn = outer.locator('pandacode-code button').first();
    await expect(copyBtn).toBeAttached({ timeout: 30_000 });
    await expectToken(copyBtn, 'borderTopLeftRadius', '--radius-hair');
  }

  // Cross-ShadowRoot <pandacode-ui> nesting inside .turn-card-reply: 10px -> 8px -> 6px
  const outerUiCard = page.locator('#design-role-cross-shadow-gu > pandacode-ui').locator('.gu-card').first();
  const innerUiCard = outerUiCard.locator('pandacode-ui').locator('.gu-card').first();
  await expect(outerUiCard).toBeVisible({ timeout: 30_000 });
  await expect(innerUiCard).toBeVisible({ timeout: 30_000 });
  await expectNestedRadius(outerUiCard, reply, '--radius-control', '--radius-inner');
  await expectNestedRadius(innerUiCard, outerUiCard, '--radius-chip', '--radius-control');
});

test('design role: Markdown row headers follow main and side-thread cells while columns stay captions', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/task-board.css');
    const host = document.createElement('div');
    host.id = 'design-role-markdown-table';
    host.style.cssText = 'position:fixed;inset:40px 40px auto;max-height:80vh;overflow:auto;z-index:999;background:var(--bg)';
    const table = '<table><thead><tr><th data-column>Column</th><th scope="row" data-row>Scoped row in head</th></tr></thead><tbody><tr><th data-row>Implicit row</th><td>Cell</td></tr><tr><th scope="row" data-row>Row</th><td>Cell</td></tr><tr><th scope="rowgroup" data-row>Group</th><td>Cell</td></tr><tr><th scope="col" data-column>Scoped column in body</th><th scope="colgroup" data-column>Column group</th></tr></tbody></table>';
    host.innerHTML = `<div data-context="main"><div class="markdown">${table}</div></div><div data-context="side" class="side-thread"><div class="markdown">${table}</div></div>`;
    document.body.append(host);
  });
  for (const [context, proseSize] of [['main', 16], ['side', 12]] as const) {
    const table = page.locator(`#design-role-markdown-table [data-context="${context}"] table`);
    const cellSize = await table.locator('td').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize));
    expect(cellSize).toBeCloseTo(proseSize, 2);
    await expect(table.locator('th[data-row]')).toHaveCount(4);
    for (const row of await table.locator('th[data-row]').all()) {
      expect(await row.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(cellSize, 2);
      await expect(row).toHaveCSS('font-weight', '500');
      await expectToken(row, 'letterSpacing', '--tracking-none', true);
    }
    for (const column of await table.locator('th[data-column]').all()) await expectRole(column, 'caption', '--weight-medium');
  }
});

test('design role: small resets tracking inside bare custom-view Shadow DOM headings', async ({ page }) => {
  await openWorkspace(page);
  await page.evaluate(async () => {
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const { markdownHtml } = await import(/* @vite-ignore */ '/src/dom.ts');
    const host = document.createElement('div');
    host.id = 'design-role-bare-small';
    host.style.cssText = 'position:fixed;inset:40px auto auto 40px;width:600px;z-index:999;background:var(--bg)';
    host.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({
      type: 'custom', html: '<h1>Title <small>sub</small></h1><h2>Head <small>sub2</small></h2>',
    }) + '\n```');
    document.body.append(host);
  });
  const custom = page.locator('#design-role-bare-small .gu-custom');
  for (const heading of ['h1', 'h2']) {
    await expectBareHeading(custom.locator(heading), 14, 'lg');
    const small = custom.locator(`${heading} small`);
    await expectRole(small, 'meta');
    expect(await small.evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeCloseTo(12, 2);
    await expect(small).toHaveCSS('font-weight', '400');
    await expect(small).toHaveCSS('letter-spacing', /^(0px|normal)$/);
  }
});

const R6_SHADOW_FIXTURE = [
  '<p>Para <code>p</code></p>',
  '<ul><li>Item <code>li</code></li></ul>',
  '<div><a href="#r6">Link <code>a</code></a></div>',
  '<div><strong>Bold <code>strong</code></strong></div>',
  '<blockquote>Quote <code>bq</code></blockquote>',
  '<table><thead><tr><th>Head <code>th</code></th></tr></thead><tbody><tr><td>Cell <code>td</code></td></tr></tbody></table>',
  '<div><small>Small <code>small</code></small></div>',
  '<h2>Head <code>h2</code></h2>',
  '<h4>Sub <code>h4</code></h4>',
  '<pre><code>block</code></pre>',
  '<p class="r6-bold">Prose <strong>bold</strong> and <strong><code>boldcode</code></strong></p>',
].join('');

test('design role: Round 6 bare Shadow DOM inline code ratio, thead code leading and prose bold', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.evaluate(async fixture => {
    await import(/* @vite-ignore */ '/src/generative-ui.ts');
    const [{ markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-r6-shadow';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    document.body.append(host);
    const custom = document.createElement('div');
    custom.dataset.r6 = 'custom';
    custom.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({ type: 'custom', html: fixture }) + '\n```');
    host.append(custom);
    const rich = document.createElement('div');
    rich.dataset.r6 = 'rich';
    host.append(rich);
    await richMarkdown(rich, '```html\n' + fixture + '\n```', { image: async () => '' });
  }, R6_SHADOW_FIXTURE);

  const roots = [
    ['bare custom view', page.locator('#design-role-r6-shadow [data-r6="custom"] .gu-custom')],
    ['rich-HTML', page.locator('#design-role-r6-shadow [data-r6="rich"] .rich-html')],
  ] as const;
  const inline = ['p > code', 'li > code', 'a > code', 'strong > code', 'blockquote > code', 'td > code',
    'small > code', 'thead th > code', 'h2 > code', 'h4 > code'];
  for (const [label, root] of roots) {
    await test.step(label, async () => {
      await expect(root).toBeVisible({ timeout: 30_000 });
      for (const selector of inline) {
        const ratio = await codeRatio(root.locator(selector).first());
        expect(Math.abs(ratio - 0.9), `${label} ${selector} ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);
      }

      // Unitless leading resolves per element, so compare the leading-to-size ratio: inherited caption 1.3, not code 1.55.
      const leading = await root.locator('thead th > code').evaluate(el => {
        const own = getComputedStyle(el);
        const th = getComputedStyle(el.parentElement!);
        return { code: parseFloat(own.lineHeight) / parseFloat(own.fontSize), th: parseFloat(th.lineHeight) / parseFloat(th.fontSize), thPx: parseFloat(th.lineHeight) };
      });
      expect(leading.thPx, `${label} thead th line-height`).toBeCloseTo(14.3, 0);
      expect(Math.abs(leading.code - leading.th), `${label} thead code leading ${leading.code.toFixed(3)} != th ${leading.th.toFixed(3)}`).toBeLessThanOrEqual(0.02);
      expect(leading.code, `${label} thead code must not use --leading-code`).toBeLessThan(1.5);

      const pre = root.locator('pre');
      const preCode = pre.locator('code');
      expect(await codeRatio(preCode), `${label} pre code ratio`).toBeCloseTo(1, 2);
      expect(await pre.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), `${label} pre size`).toBeCloseTo(12, 1);

      const bold = root.locator('p.r6-bold > strong').first();
      await expect(bold, `${label} prose bold matches Markdown`).toHaveCSS('font-weight', '600');
      await expect(root.locator('p.r6-bold strong > code'), `${label} bold code stays medium`).toHaveCSS('font-weight', '500');
    });
  }
});

const R7_SHADOW_FIXTURE = '<p class="r7-text">Text <code>code</code></p><h4>Sub</h4><p><strong>Bold</strong></p>';

test('design role: Round 7 rich-HTML inherits its context size and bare h4 matches prose bold', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.evaluate(async fixture => {
    await Promise.all(['/src/github-hub.css', '/src/task-board.css', '/src/rich-markdown.css', '/src/generative-ui.ts']
      .map(href => import(/* @vite-ignore */ href)));
    const [{ markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-r7';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    // richMarkdown() makes each box a .markdown block, so rich-HTML follows that box's --thread-font.
    host.innerHTML = `
      <div class="markdown"><div data-r7="main"></div></div>
      <div class="gh-job-summary markdown"><div data-r7="gh"></div></div>
      <div class="side-thread"><div class="markdown"><div data-r7="side"></div></div></div>
      <div style="font-size:var(--type-body)"><div data-r7-ui="custom"></div></div>
      <div data-r7-ui="rich"></div>`;
    document.body.append(host);
    const html = '```html\n' + fixture + '\n```';
    for (const box of host.querySelectorAll<HTMLElement>('[data-r7]')) await richMarkdown(box, html, { image: async () => '' });
    const ui = '```ui\n' + JSON.stringify({ type: 'custom', html: fixture }) + '\n```';
    host.querySelector('[data-r7-ui="custom"]')!.innerHTML = await markdownHtml(ui);
    const richUi = host.querySelector('[data-r7-ui="rich"]')!;
    richUi.innerHTML = await markdownHtml(ui);
    const uiEl = richUi.querySelector('pandacode-ui')!;
    await new Promise<void>(resolve => {
      const check = () => (uiEl.shadowRoot?.querySelector('.gu-custom') ? resolve() : setTimeout(check, 20));
      check();
    });
    const nested = document.createElement('div');
    nested.dataset.r7 = 'ui';
    uiEl.shadowRoot!.querySelector('.gu-custom')!.after(nested);
    await richMarkdown(nested, html, { image: async () => '' });
  }, R7_SHADOW_FIXTURE);

  const r7 = '#design-role-r7';
  const roots = [
    ['main conversation rich-HTML', page.locator(`${r7} [data-r7="main"] .rich-html`), '--type-prose', 16],
    ['gh-job-summary rich-HTML', page.locator(`${r7} [data-r7="gh"] .rich-html`), '--type-meta', 12],
    ['side-thread rich-HTML', page.locator(`${r7} [data-r7="side"] .rich-html`), '--type-meta', 12],
    ['bare custom view in a body wrapper', page.locator(`${r7} [data-r7-ui="custom"] pandacode-ui`).locator('.gu-custom'), '--type-body', 14],
    // A rich Markdown block inside <pandacode-ui> is prose (as the rich-markdown check above), so its rich-HTML is 16px too.
    ['rich-HTML in Markdown inside pandacode-ui', page.locator(`${r7} [data-r7-ui="rich"] pandacode-ui`).locator('[data-r7="ui"] .rich-html'), '--type-prose', 16],
  ] as const;
  for (const [label, root, token, size] of roots) {
    await test.step(label, async () => {
      await expect(root).toBeVisible({ timeout: 30_000 });
      const text = root.locator('p.r7-text');
      expect(await text.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), `${label} text size`).toBeCloseTo(size, 1);
      await expectToken(text, 'fontSize', token);
      const code = text.locator('code');
      expect(await code.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), `${label} inline code`).toBeCloseTo(size * 0.9, 1);
      const ratio = await codeRatio(code);
      expect(Math.abs(ratio - 0.9), `${label} code ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);

      const h4 = root.locator('h4');
      await expect(h4, `${label} h4 weight`).toHaveCSS('font-weight', '600');
      await expect(root.locator('p > strong'), `${label} prose bold`).toHaveCSS('font-weight', '600');
      expect(await h4.evaluate(el => parseFloat(getComputedStyle(el).fontSize)), `${label} h4 is 1em`).toBeCloseTo(size, 1);
    });
  }
});

const R8_SHADOW_FIXTURE = [
  '<h1>One</h1><h2>Two</h2><h3>Three</h3><h4>Four</h4>',
  '<p class="r8-text">Text <samp>out</samp> and <code>code</code></p>',
  '<table><tbody><tr><th>Implicit</th><td>Cell</td></tr><tr><th scope="row">Scoped</th><td>Cell</td></tr></tbody></table>',
  '<pre class="r8-samp"><samp>block out</samp></pre><pre class="r8-code"><code>block code</code></pre>',
].join('');

test('design role: Round 8 relative bare headings, row headers and inline samp across rich-HTML contexts and custom views', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  await page.evaluate(async fixture => {
    await Promise.all(['/src/github-hub.css', '/src/task-board.css', '/src/rich-markdown.css', '/src/generative-ui.ts']
      .map(href => import(/* @vite-ignore */ href)));
    const [{ markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-r8';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    host.innerHTML = `
      <div class="markdown"><div data-r8="main"></div></div>
      <div class="gh-job-summary markdown"><div data-r8="gh"></div></div>
      <div class="side-thread"><div class="markdown"><div data-r8="side"></div></div></div>
      <div data-r8-ui="custom"></div>`;
    document.body.append(host);
    for (const box of host.querySelectorAll<HTMLElement>('[data-r8]')) await richMarkdown(box, '```html\n' + fixture + '\n```', { image: async () => '' });
    host.querySelector('[data-r8-ui="custom"]')!.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({ type: 'custom', html: fixture }) + '\n```');
  }, R8_SHADOW_FIXTURE);

  const r8 = '#design-role-r8';
  const roots = [
    ['main conversation rich-HTML', page.locator(`${r8} [data-r8="main"] .rich-html`), 16],
    ['gh-job-summary rich-HTML', page.locator(`${r8} [data-r8="gh"] .rich-html`), 12],
    ['side-thread rich-HTML', page.locator(`${r8} [data-r8="side"] .rich-html`), 12],
    ['bare pandacode-ui custom view', page.locator(`${r8} [data-r8-ui="custom"] pandacode-ui`).locator('.gu-custom'), 14],
  ] as const;
  for (const [label, root, size] of roots) {
    await test.step(label, async () => {
      await expect(root).toBeVisible({ timeout: 30_000 });
      const text = root.locator('p.r8-text');
      expect(await px(text), `${label} prose size`).toBeCloseTo(size, 1);

      const [h1, h2, h3, h4] = await Promise.all(['h1', 'h2', 'h3', 'h4'].map(tag => px(root.locator(tag))));
      expect(h1, `${label} h1 > h3`).toBeGreaterThan(h3 + 1);
      expect(h1, `${label} h1 == h2`).toBeCloseTo(h2, 2);
      expect(h3, `${label} h3 == h4`).toBeCloseTo(h4, 2);
      expect(h3, `${label} h3 == p`).toBeCloseTo(size, 1);
      await expectBareHeading(root.locator('h1'), size, 'lg');
      await expectBareHeading(root.locator('h2'), size, 'lg');
      await expectBareHeading(root.locator('h3'), size, 'em');
      await expectBareHeading(root.locator('h4'), size, 'em');

      const rows = root.locator('tbody th');
      await expect(rows).toHaveCount(2);
      for (const row of await rows.all()) await expectRowHeader(row, row.locator('xpath=following-sibling::td[1]'), size);

      const samp = text.locator('samp');
      const ratio = await codeRatio(samp);
      expect(Math.abs(ratio - 0.9), `${label} inline samp ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);
      expect(await px(samp), `${label} inline samp matches inline code`).toBeCloseTo(await px(text.locator('code')), 2);
      expect(await px(root.locator('pre.r8-samp samp')), `${label} pre samp`).toBeCloseTo(12, 1);
      expect(await px(root.locator('pre.r8-code code')), `${label} pre code`).toBeCloseTo(12, 1);
    });
  }
});

const R10_MONO_FIXTURE = [
  '<p class="r10-text">Text <code>code</code> <samp>samp</samp> <tt>tt</tt>',
  ' <strong><code>bold code</code> <samp>bold samp</samp> <tt>bold tt</tt></strong></p>',
  '<pre class="r10-code"><code>block code</code></pre><pre class="r10-samp"><samp>block samp</samp></pre><pre class="r10-tt"><tt>block tt</tt></pre>',
].join('');

test('design role: inline and block code, samp and tt match across Light DOM, Shadow DOM and bare Shadow DOM hosts', async ({ page }) => {
  test.setTimeout(60_000);
  await openWorkspace(page);
  const mono = await page.evaluate(async fixture => {
    const [{ generativeSheet }, { markdownHtml }, { richMarkdown }] = await Promise.all([
      import(/* @vite-ignore */ '/src/generative-ui.ts'),
      import(/* @vite-ignore */ '/src/dom.ts'),
      import(/* @vite-ignore */ '/src/rich-markdown.ts'),
    ]);
    const host = document.createElement('div');
    host.id = 'design-role-r10';
    host.style.cssText = 'position:fixed;inset:20px;overflow:auto;z-index:999;background:var(--bg)';
    host.innerHTML = '<div class="markdown" data-r10="light"></div><div data-r10-host="shadow"></div><div data-r10="custom"></div><div data-r10="rich"></div>';
    document.body.append(host);
    host.querySelector('[data-r10="light"]')!.innerHTML = fixture;
    const shadow = host.querySelector('[data-r10-host="shadow"]')!.attachShadow({ mode: 'open' });
    shadow.adoptedStyleSheets = [generativeSheet()];
    shadow.innerHTML = `<div class="markdown" data-r10="shadow">${fixture}</div>`;
    host.querySelector('[data-r10="custom"]')!.innerHTML = await markdownHtml('```ui\n' + JSON.stringify({ type: 'custom', html: fixture }) + '\n```');
    await richMarkdown(host.querySelector<HTMLElement>('[data-r10="rich"]')!, '```html\n' + fixture + '\n```', { image: async () => '' });
    const probe = document.createElement('span');
    probe.style.fontFamily = 'var(--mono)';
    host.append(probe);
    return getComputedStyle(probe).fontFamily;
  }, R10_MONO_FIXTURE);

  const r10 = '#design-role-r10';
  const roots = [
    ['Light DOM .markdown', page.locator(`${r10} [data-r10="light"]`), true],
    ['Shadow DOM .markdown (generativeSheet)', page.locator(`${r10} [data-r10-host="shadow"]`).locator('[data-r10="shadow"]'), true],
    ['bare .gu-custom', page.locator(`${r10} [data-r10="custom"] pandacode-ui`).locator('.gu-custom'), false],
    ['bare .rich-html', page.locator(`${r10} [data-r10="rich"] .rich-html`), false],
  ] as const;
  for (const [label, root, blocks] of roots) {
    await test.step(label, async () => {
      await expect(root).toBeVisible({ timeout: 30_000 });
      const text = root.locator('p.r10-text');
      const code = text.locator(':scope > code');
      const codePx = await px(code);
      for (const tag of ['code', 'samp', 'tt']) {
        const inline = text.locator(`:scope > ${tag}`);
        const ratio = await codeRatio(inline);
        expect(Math.abs(ratio - 0.9), `${label} inline ${tag} ratio ${ratio.toFixed(3)}`).toBeLessThanOrEqual(0.02);
        expect(await px(inline), `${label} inline ${tag} matches inline code`).toBeCloseTo(codePx, 2);
        await expect(inline, `${label} inline ${tag} uses --mono`).toHaveCSS('font-family', mono);
        await expect(text.locator(`strong > ${tag}`), `${label} strong ${tag} stays medium`).toHaveCSS('font-weight', '500');
      }
      if (!blocks) return;
      for (const tag of ['code', 'samp', 'tt']) {
        const block = root.locator(`pre.r10-${tag} > ${tag}`);
        expect(await codeRatio(block), `${label} pre ${tag} inherits, never 0.9em again`).toBeCloseTo(1, 2);
        expect(await px(block), `${label} pre ${tag} is --mono-size`).toBeCloseTo(12, 1);
        await expectToken(block, 'fontSize', '--mono-size');
        await expectToken(block, 'lineHeight', '--leading-code', true);
        await expect(block, `${label} pre ${tag} uses --mono`).toHaveCSS('font-family', mono);
      }
    });
  }
});
