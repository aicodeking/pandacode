import { expect, test, type Page } from '@playwright/test';

/** Renders Markdown through the app's own pipeline (Enriched Markdown → sanitizer → KaTeX). */
async function render(page: Page, markdown: string): Promise<void> {
  await page.evaluate(async source => {
    const { markdownHtml } = await import('/src/dom.ts');
    let host = document.querySelector<HTMLElement>('#markdown-probe');
    if (!host) {
      host = document.createElement('div');
      host.id = 'markdown-probe';
      host.className = 'markdown';
      host.style.cssText = 'position:fixed;inset:40px auto auto 40px;width:640px;max-height:90vh;overflow:auto;z-index:999;padding:20px;background:var(--bg);border-radius:12px;box-shadow:0 10px 40px rgb(0 0 0 / .3)';
      document.body.append(host);
    }
    host.innerHTML = await markdownHtml(source);
  }, markdown);
}
const probe = (page: Page) => page.locator('#markdown-probe');

test.beforeEach(async ({ page }) => { await page.goto('/'); });

test.describe('enriched markdown', () => {
  test('renders CommonMark and GitHub extensions', async ({ page }) => {
    await render(page, '# Title\n\nSome **bold**, *em*, `code` and ~~gone~~ with a [link](https://example.com "Example").\n\n3. three\n4. four\n\n- tight\n- list\n\n> quoted\n\n---\n\n```ts\nconst x = 1 < 2;\n```');
    await expect(probe(page).locator('h1')).toHaveText('Title');
    await expect(probe(page).locator('strong')).toHaveText('bold');
    await expect(probe(page).locator('em')).toHaveText('em');
    await expect(probe(page).locator('p > code')).toHaveText('code');
    await expect(probe(page).locator('del')).toHaveText('gone');
    // The engine keeps link targets but not their optional titles.
    await expect(probe(page).locator('a[href="https://example.com"]')).toHaveText('link');
    await expect(probe(page).locator('ol')).toHaveAttribute('start', '3');
    await expect(probe(page).locator('ul > li').first()).toHaveText('tight');
    await expect(probe(page).locator('ul > li > p')).toHaveCount(0);
    await expect(probe(page).locator('blockquote')).toContainText('quoted');
    await expect(probe(page).locator('hr')).toHaveCount(1);
    await expect(probe(page).locator('pre > code.language-ts')).toHaveText('const x = 1 < 2;\n');
  });

  test('shows task lists, admonitions and aligned tables', async ({ page }) => {
    await render(page, '- [x] shipped\n- [ ] next\n\n> [!WARNING]\n> Back up first.\n\n> [!TIP]\n> Use the queue.\n\n| Left | Middle | Right |\n|:-----|:------:|------:|\n| a | b | c |');
    await expect(probe(page).locator('ul.md-task-list > li')).toHaveCount(2);
    await expect(probe(page).locator('li.md-task-done')).toHaveText('shipped');
    await expect(probe(page).getByRole('img', { name: 'Done', exact: true })).toHaveCount(1);
    await expect(probe(page).getByRole('img', { name: 'Not done', exact: true })).toHaveCount(1);
    const warning = probe(page).locator('aside.md-admonition-warning');
    await expect(warning).toHaveAttribute('role', 'note');
    await expect(warning.locator('.md-admonition-title')).toHaveText('Warning');
    await expect(warning).toContainText('Back up first.');
    await expect(probe(page).locator('aside.md-admonition-tip')).toContainText('Use the queue.');
    await expect(probe(page).locator('th.md-align-center')).toHaveText('Middle');
    await expect(probe(page).locator('td.md-align-right')).toHaveText('c');
    await expect(probe(page).locator('td').first()).toHaveClass('md-align-left');
  });

  test('typesets inline and display math, but leaves prices alone', async ({ page }) => {
    await render(page, 'Energy is $E=mc^2$, which costs $5 and $10.\n\n$$\\int_0^1 x\\,dx = \\tfrac{1}{2}$$');
    await expect(probe(page).locator('p .katex')).toHaveCount(1);
    await expect(probe(page).locator('p .katex-mathml annotation')).toHaveText('E=mc^2');
    await expect(probe(page).locator('p')).toContainText('costs $5 and $10.');
    await expect(probe(page).locator('.md-math-block .katex-display')).toHaveCount(1);
    await expect(probe(page).locator('.md-math-block annotation')).toHaveText('\\int_0^1 x\\,dx = \\tfrac{1}{2}');
    await page.screenshot({ path: test.info().outputPath('math.png') });
  });

  test('never turns agent text into markup, scripts or loaded media', async ({ page }) => {
    await render(page, 'a <script>window.__owned = 1</script> b\n\n<img src=x onerror="window.__owned = 2">\n\n[click](javascript:window.__owned=3) ![photo](https://example.com/p.png)\n\n$\\href{javascript:alert(1)}{x}$ and $\\htmlStyle{color:red}{y}$');
    expect(await page.evaluate(() => (window as any).__owned)).toBeUndefined();
    await expect(probe(page).locator('script, img, iframe, [onerror], [style*="color:red"]')).toHaveCount(0);
    await expect(probe(page)).toContainText('<script>window.__owned = 1</script>');
    await expect(probe(page).locator('a[href^="javascript"]')).toHaveCount(0);
    await expect(probe(page).locator('a.md-media')).toHaveAttribute('href', 'https://example.com/p.png');
    await expect(probe(page).locator('a.md-media')).toHaveText('photo');
    await expect(probe(page).locator('.katex a')).toHaveCount(0);
  });

  test('chips only real cited links, and a streaming link shows its label at once with no URL syntax', async ({ page }) => {
    await render(page, 'See [notes](https://granola.ai/notes/1), [slack](slack), [https://github.com/a/b](https://github.com/a/b) and [mail](mailto:jane@example.com).');
    await expect(probe(page).locator('a.md-cite')).toHaveCount(1);
    await expect(probe(page).locator('a.md-cite')).toHaveText('notes');
    await expect(probe(page).locator('a.md-cite .brand-icon')).toHaveCount(1);
    await expect(probe(page).locator('a[href="mailto:jane@example.com"]')).not.toHaveClass(/md-cite/);
    const shown = await page.evaluate(async () => {
      const { streamMarkdown, settledMarkdown } = await import('/src/streaming-markdown.ts');
      const host = document.createElement('div'); document.body.append(host);
      const frames: string[] = [];
      for (const value of ['Kickoff [no', 'Kickoff [notes](https://gran', 'Kickoff [notes](https://granola.ai/n)']) {
        streamMarkdown(host, value);
        await new Promise(resolve => setTimeout(resolve, 120));
        frames.push((host.textContent ?? '').trim());
      }
      return { frames, settled: [settledMarkdown('a [x](http'), settledMarkdown('a [x]('), settledMarkdown('- [ ] task'), settledMarkdown('- [x'), settledMarkdown('[x](y) done'), settledMarkdown('run `npm'), settledMarkdown('```\nlist[0'), settledMarkdown('see ![chart](ht')] };
    });
    // Never held back: an open link already reads as its label.
    expect(shown.frames[0]).toBe('Kickoff no');
    expect(shown.frames[1]).toBe('Kickoff notes');
    expect(shown.frames[2]).toContain('notes');
    expect(shown.frames[2]).not.toContain('](');
    const open = '(#pandacode-open-link)';
    expect(shown.settled).toEqual([`a [x]${open}`, `a [x]${open}`, '- [ ] task', '- [x', '[x](y) done', 'run `npm`', '```\nlist[0', 'see ']);
  });

  test('keeps local file links as workspace paths', async ({ page }) => {
    await render(page, 'See [main](file:///Users/you/Projects/orbit/src/main.ts) and [a](src/a.ts).');
    await expect(probe(page).locator('a').first()).toHaveAttribute('href', '/Users/you/Projects/orbit/src/main.ts');
    await expect(probe(page).locator('a').nth(1)).toHaveAttribute('href', 'src/a.ts');
  });

  test('the parser runs under the app CSP, which needs wasm-unsafe-eval', async ({ page }) => {
    const probeCsp = async (scriptSrc: string) => {
      await page.route('**/csp-probe.html', route => route.fulfill({
        contentType: 'text/html',
        headers: { 'Content-Security-Policy': `default-src 'self'; ${scriptSrc}; style-src 'self' 'unsafe-inline'` },
        body: '<!doctype html><script type="module" src="/csp-probe.js"></script>',
      }));
      await page.route('**/csp-probe.js', route => route.fulfill({ contentType: 'text/javascript', body: `
        import create from '/src/vendor/enriched-markdown/md4c.js';
        create().then(w => { document.title = JSON.parse(w.cwrap('parseMarkdown', 'string', ['string','number','number','number','number','number','number','number','number'])('**ok**',0,1,0,0,0,0,0,1)).children[0].children[0].type; })
          .catch(() => { document.title = 'blocked'; });` }));
      await page.goto('/csp-probe.html');
      await expect(page).not.toHaveTitle('');
      return page.title();
    };
    expect(await probeCsp("script-src 'self'")).toBe('blocked');
    await page.unrouteAll();
    expect(await probeCsp("script-src 'self' 'wasm-unsafe-eval'")).toBe('Strong');
  });
});

// A reply with a table, lists, math and a long code fence: the fence is one giant block, which the
// painter renders line by line instead of re-parsing it every frame.
const FENCE = Array.from({ length: 300 }, (_, i) => `export const value${i} = compute(${i}) < limit && flag; // line ${i}`).join('\n');
const REPLY = `## Result\n\n| File | Change |\n| --- | ---: |\n| alpha | 1 |\n| beta | $x^2$ |\n\n- first item\n- second **bold**\n  - nested\n\n1. one\n2. two\n\nEnergy is $E=mc^2$, which costs $5.\n\n$$\n\\int_0^1 x\\,dx = \\tfrac{1}{2}\n$$\n\n\`\`\`ts\n${FENCE}\n\`\`\`\n\nDone. End of reply.\n`;

test.describe('streamed markdown', () => {
  test('an open code fence paints line by line and every frame equals a cold render', async ({ page }) => {
    const result = await page.evaluate(async reply => {
      const { markdownHtml } = await import('/src/dom.ts');
      const { streamMarkdown } = await import('/src/streaming-markdown.ts');
      const cold = async (value: string) => { const t = document.createElement('template'); t.innerHTML = await markdownHtml(value, false); return t.innerHTML; };
      const frame = () => new Promise(resolve => requestAnimationFrame(resolve));
      const host = document.createElement('div'); document.body.append(host);
      const open = reply.indexOf('```ts\n') + 6, close = reply.lastIndexOf('```');
      const mismatches: number[] = [];
      let lineByLine = 0, checked = 0;
      const ends = [...Array.from({ length: Math.ceil((close - open) / 397) }, (_, i) => open + i * 397), reply.length];
      for (const end of ends) {
        const value = reply.slice(0, end), expected = await cold(value);
        streamMarkdown(host, value);
        for (let i = 0; i < 40 && host.innerHTML !== expected; i++) await frame();
        if (host.innerHTML !== expected) mismatches.push(end);
        if (host.querySelector('pre code')?.childNodes.length === 2) lineByLine++;
        checked++;
      }
      return { mismatches, lineByLine, checked };
    }, REPLY);
    expect(result.mismatches).toEqual([]);
    // The fence's complete lines and the streaming line are painted apart while it is open.
    expect(result.lineByLine).toBeGreaterThan(result.checked / 2);
  });

  test('a reply streamed through agent events ends equal to a cold render and redraws from the cache', async ({ page }) => {
    await page.route('**/src/preview.ts*', async route => {
      const response = await route.fetch();
      const source = await response.text();
      const patches: [string, string][] = [
        ['const output = "This is the browser preview.', 'const output = window.__markdownReply ?? "This is the browser preview.'],
        ['cursor + 13)', 'cursor + 61)'], ['cursor += 13', 'cursor += 61'], ['setTimeout(tick, 24)', 'setTimeout(tick, 4)'],
      ];
      for (const [from] of patches) expect(source).toContain(from);
      await route.fulfill({ response, body: patches.reduce((body, [from, to]) => body.replace(from, to), source) });
    });
    await page.reload();
    await page.evaluate(reply => { (window as any).__markdownReply = reply; }, REPLY);
    await page.getByRole('button', { name: 'New task ⌘ N', exact: true }).click();
    const prompt = page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
    await prompt.fill('Stream the Markdown reply');
    await prompt.press('Enter');
    const transcript = page.getByRole('log', { name: 'Conversation', exact: true });
    const reply = transcript.locator('.agent-message .message-content').filter({ hasText: 'End of reply.' });
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeHidden({ timeout: 15_000 });
    await expect(reply).toHaveCount(1);
    const cold = () => page.evaluate(async value => {
      const { markdownHtml } = await import('/src/dom.ts');
      const template = document.createElement('template'); template.innerHTML = await markdownHtml(value, false);
      return template.innerHTML;
    }, REPLY);
    const expected = await cold();
    expect(expected).toContain('<table>');
    expect(expected).toContain('class="katex');
    await expect.poll(() => reply.evaluate(node => node.innerHTML)).toBe(expected);
    // The finished reply is cached; mark the entry so a redraw from it is told apart from a parse.
    const cached = await page.evaluate(async value => {
      const { markdownCache } = await import('/src/dom.ts');
      const html = markdownCache.get(value);
      if (html !== undefined) markdownCache.set(value, `${html}<!--from-cache-->`);
      return html;
    }, REPLY);
    expect(cached).toBe(expected);
    const task = await page.locator('.task-item.selected').getAttribute('data-id');
    await page.locator('.task-item:not(.selected)').first().click();
    await expect(reply).toHaveCount(0);
    await page.locator(`.task-item[data-id="${task}"]`).click();
    await expect.poll(() => reply.evaluate(node => node.innerHTML)).toBe(`${expected}<!--from-cache-->`);
  });
});
