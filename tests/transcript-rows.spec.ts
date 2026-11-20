import { expect, test, type Page } from '@playwright/test';
import { agentTurns, exposePreviewMessages, pairs, say, scrollTopUntil, settled } from './transcript-fixtures';

/* The row reuse in src/transcript-rows.ts against a real DOM, and the tile paths built on it. */

async function blank(page: Page): Promise<void> {
  await page.goto('/');
  await page.locator('#navigation .task-item').first().waitFor();
}

test.describe('drawRows', () => {
  test('parseRow keeps every top-level node of a turn, in order', async ({ page }) => {
    await blank(page);
    const names = await page.evaluate(async () => {
      const { parseRow } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-rows.ts`);
      return parseRow('<article></article>text<section></section>').nodes.map((node: Node) => node.nodeName);
    });
    expect(names).toEqual(['ARTICLE', '#text', 'SECTION']);
  });

  test('an unchanged row keeps its node, open fold and focus across a redraw', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { drawRows } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-rows.ts`);
      const host = document.body.appendChild(document.createElement('div'));
      const row = (name: string) => `<details data-row="${name}"><summary tabindex="0">${name}</summary>body</details>`;
      const first = drawRows(host, [], [row('a'), row('b')], '<i data-trailing></i>');
      const a = host.querySelector<HTMLDetailsElement>('[data-row="a"]')!, oldTrailing = host.querySelector('[data-trailing]')!;
      a.open = true;
      a.querySelector('summary')!.focus();
      const second = drawRows(host, first.rows, [row('a'), row('b'), row('c')], '<i data-trailing></i>');
      return {
        same: host.querySelector('[data-row="a"]') === a, open: a.open, focused: document.activeElement === a.querySelector('summary'),
        order: [...host.querySelectorAll('[data-row]')].map(node => (node as HTMLElement).dataset.row),
        added: second.added.map((node: Element) => node.getAttribute('data-row') ?? 'trailing'),
        trailingLast: host.lastElementChild!.hasAttribute('data-trailing'), oldTrailingGone: !oldTrailing.isConnected, rows: second.rows.length,
      };
    });
    expect(result).toEqual({ same: true, open: true, focused: true, order: ['a', 'b', 'c'], added: ['c', 'trailing'], trailingLast: true, oldTrailingGone: true, rows: 3 });
  });

  test('only the changed row in the middle is replaced, and rows prepended land above', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { drawRows } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-rows.ts`);
      const host = document.body.appendChild(document.createElement('div'));
      const first = drawRows(host, [], ['<p>a</p>', '<p>b</p>', '<p>c</p>'], '');
      const [a, b, c] = [...host.children];
      const second = drawRows(host, first.rows, ['<p>a</p>', '<p>B</p>', '<p>c</p>'], '');
      const middle = { kept: host.children[0] === a && host.children[2] === c, replaced: host.children[1] !== b && !b.isConnected };
      const kept = [...host.children];
      drawRows(host, second.rows, ['<p>z</p>', '<p>a</p>', '<p>B</p>', '<p>c</p>'], '');
      return { middle, text: host.textContent, tailKept: kept.every(node => node.isConnected) };
    });
    expect(result).toEqual({ middle: { kept: true, replaced: true }, text: 'zaBc', tailKept: true });
  });

  test('rows that left the host are drawn afresh, never reinserted', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { drawRows, rowsIntact } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-rows.ts`);
      const host = document.body.appendChild(document.createElement('div'));
      const first = drawRows(host, [], ['<p>a</p>'], '');
      const old = host.firstChild!;
      host.innerHTML = '<p>placeholder</p>';
      const intact = rowsIntact(host, first.rows);
      drawRows(host, first.rows, ['<p>a</p>'], '');
      return { intact, text: host.textContent, fresh: host.firstChild !== old };
    });
    expect(result).toEqual({ intact: false, text: 'a', fresh: true });
  });

  test('a repeated turn key still gets a unique reply id', async ({ page }) => {
    await blank(page);
    const ids = await page.evaluate(async () => {
      const { replyHtml } = await import(/* @vite-ignore */ `${location.origin}/src/turn-card.ts`);
      const host = document.createElement('div');
      host.innerHTML = replyHtml('one', 'same key', '', false, '1') + replyHtml('two', 'same key', '', false, '2');
      return [...host.querySelectorAll('.turn-card-reply-body')].map(node => node.id);
    });
    expect(new Set(ids).size).toBe(2);
  });

  test('watchReplies measures only the rows it is given', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { replyHtml, watchReplies } = await import(/* @vite-ignore */ `${location.origin}/src/turn-card.ts`);
      const host = document.body.appendChild(document.createElement('div'));
      const tall = `<div style="height:2000px">tall</div>`;
      host.innerHTML = `<section>${replyHtml(tall, 'a')}</section><section>${replyHtml(tall, 'b')}</section>`;
      watchReplies([host.children[1]]);
      return [...host.querySelectorAll('.turn-card-reply')].map(node => node.hasAttribute('data-overflow'));
    });
    expect(result).toEqual([false, true]);
  });

  test('a request made while a step formats is asked again once that step is done', async ({ page }) => {
    await blank(page);
    const order = await page.evaluate(async () => {
      const { stepWhenFormatted } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-window.ts`);
      const busy = new Map(), seen: string[] = [];
      let done!: () => void;
      const finished = new Promise<void>(resolve => { done = resolve; });
      const first = stepWhenFormatted(busy, 'thread', [], () => seen.push('stale step'), () => {});
      // Asked while the first step formats: not formatted twice, but not lost either.
      const second = stepWhenFormatted(busy, 'thread', [], () => seen.push('never'), () => {}, () => { seen.push('asked again'); done(); });
      await finished;
      return { first, second, seen, idle: !busy.has('thread') };
    });
    expect(order).toEqual({ first: true, second: false, seen: ['stale step', 'asked again'], idle: true });
  });

  test('trimmed rows leave in one go, and anything drawn between them stays', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { parseRow } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-rows.ts`);
      const { removeRows } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-window.ts`);
      const host = document.body.appendChild(document.createElement('div'));
      const draw = () => { const rows = ['<p>a</p>', '<p>b</p>text', '<p>c</p>'].map(parseRow); host.replaceChildren(...rows.flatMap(row => row.nodes)); return rows; };
      let rows = draw();
      removeRows(rows.slice(0, 2));
      const run = host.innerHTML;
      rows = draw();
      rows[1].nodes[0].before(Object.assign(document.createElement('i'), { textContent: 'decoration' }));
      removeRows(rows.slice(0, 2));
      return { run, between: host.innerHTML };
    });
    expect(result).toEqual({ run: '<p>c</p>', between: '<i>decoration</i><p>c</p>' });
  });

  test('a position is captured from the rows near the view, not every anchor', async ({ page }) => {
    await blank(page);
    const result = await page.evaluate(async () => {
      const { captureTranscriptAnchor } = await import(/* @vite-ignore */ `${location.origin}/src/transcript-scroll.ts`);
      const scroller = document.body.appendChild(document.createElement('div'));
      scroller.style.cssText = 'position:fixed;inset:0;overflow:auto;background:white;z-index:9999';
      scroller.innerHTML = Array.from({ length: 3000 }, (_, index) => `<article data-message-id="${index}" style="height:40px">${index}</article>`).join('');
      scroller.scrollTop = 60_000;
      const original = Element.prototype.getClientRects;
      let reads = 0;
      Element.prototype.getClientRects = function (this: Element) { reads++; return original.call(this); };
      const restore = captureTranscriptAnchor(scroller);
      Element.prototype.getClientRects = original;
      const row = scroller.querySelector('[data-message-id="1600"]')!, before = row.getBoundingClientRect().top;
      const added = document.createElement('article');
      added.style.height = '500px';
      scroller.prepend(added);
      restore();
      return { reads, moved: Math.abs(row.getBoundingClientRect().top - before) };
    });
    expect(result.reads).toBeLessThan(200);
    expect(result.moved).toBeLessThanOrEqual(1);
  });
});

test.describe('long threads in tiles', () => {
  test.describe.configure({ timeout: 60_000 });
  const tile = (page: Page, id: string) => page.locator(`.thread-tile[data-tile="${id}"]`);
  const text = (n: number) => `Message ${String(n).padStart(3, '0')}`;

  /** session-2 holds 50 turns and sits in an unfocused tile it was restored to, never opened in the pane. */
  async function tiled(page: Page): Promise<void> {
    await page.setViewportSize({ width: 1440, height: 900 });
    await exposePreviewMessages(page, { 'session-2': pairs(50, 'session-2') });
    await page.addInitScript(() => localStorage.setItem('pandacode.tiles', JSON.stringify(['session-1', 'session-2'])));
    await page.goto('/');
    // Tiles are restored with the first thread the pane opens: wait for that, then for the tile's own page, each on its
    // signal rather than one short timeout that a slow engine (WebKit) or a loaded machine could outrun.
    await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
    await expect(tile(page, 'session-2'), 'session-2 restored as a tile').toHaveCount(1, { timeout: 20_000 });
    await expect(tile(page, 'session-2').locator('.thread-mirror')).toBeVisible({ timeout: 20_000 });
    await expect(tile(page, 'session-2').getByText(text(99), { exact: true })).toHaveCount(1, { timeout: 20_000 });
    // A step formats its turns before drawing them, and the first formatting loads the Markdown modules: on a loaded
    // machine and a cold dev server that alone outlasts a scroll's wait, so the tile's own replies are formatted first.
    await expect(tile(page, 'session-2').locator('[data-markdown] p').first()).toBeAttached({ timeout: 30_000 });
  }
  const scrollTileUp = (page: Page, n: number): Promise<void> => scrollTopUntil(page, '.thread-tile[data-tile="session-2"] .transcript', text(n));

  test('a tile opens on its window and widens as the reader nears the top, holding their place', async ({ page }) => {
    await tiled(page);
    await expect(tile(page, 'session-2').getByText(text(59), { exact: true })).toHaveCount(0);
    const scroller = tile(page, 'session-2').locator('.transcript');
    await settled(page, '.thread-tile[data-tile="session-2"] .transcript');
    // Measured in the task that scrolls, so nothing can draw between the scroll and the baseline.
    const before = await scroller.evaluate((node, wanted) => {
      node.scrollTop = 1;
      return [...node.querySelectorAll('.user-prose')].find(item => item.textContent === wanted)!.getBoundingClientRect().top;
    }, text(70));
    await expect(tile(page, 'session-2').getByText(text(59), { exact: true })).toHaveCount(1, { timeout: 20_000 });
    await expect.poll(() => scroller.evaluate((node, wanted) => [...node.querySelectorAll('.user-prose')].find(item => item.textContent === wanted)!.getBoundingClientRect().top, text(70))).toBeCloseTo(before, 0);
  });

  test('a folded tool in an unfocused tile draws its body when it opens', async ({ page }) => {
    await page.setViewportSize({ width: 1440, height: 900 });
    await exposePreviewMessages(page, { 'session-2': agentTurns(12, 'session-2') });
    await page.addInitScript(() => localStorage.setItem('pandacode.tiles', JSON.stringify(['session-1', 'session-2'])));
    await page.goto('/');
    await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
    const tool = tile(page, 'session-2').locator('details.tool-trace').last();
    await expect(tool.locator('[data-tool-body]')).toHaveCount(1, { timeout: 20_000 });
    await tool.evaluate(node => { (node as HTMLDetailsElement).open = true; });
    await expect(tool.locator('.tool-activity-body')).toContainText('contents');
    await expect(tool.locator('[data-tool-body]')).toHaveCount(0);
    await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', 'session-1');
  });

  test('a running thread opened from a scrolled tile keeps the turns the tile drew', async ({ page }) => {
    await tiled(page);
    await scrollTileUp(page, 59);
    // No remembered page: the pane draws its live card before the page arrives, and the widened window must survive that.
    await page.evaluate(() => (window as any).__previewEmit('agent-event', { sessionId: 'session-2', kind: 'text', text: 'Still working on it.' }));
    await tile(page, 'session-2').locator('.thread-tile-title').click();
    await expect(page.locator('#navigation .task-item.selected')).toHaveAttribute('data-id', 'session-2');
    const transcript = page.locator('#transcript');
    await expect(transcript.getByText(text(98), { exact: true })).toHaveCount(1);
    await expect(transcript.getByText(text(59), { exact: true })).toHaveCount(1);
  });

  test('a worker older than the window waits for its turn to be drawn', async ({ page }) => {
    await exposePreviewMessages(page);
    await page.goto('/');
    await page.locator('#navigation .task-item').first().waitFor();
    await page.evaluate(() => (window as any).__previewMirrorTeam());
    // The workers were created now: only the first turn started before them.
    const later = Date.now() + 3_600_000;
    const list = Array.from({ length: 30 }, (_, turn) => {
      const at = turn ? later + turn * 2000 : 1_700_000_000_000;
      return [say(turn * 2, 'user', text(turn * 2), 'mirror-team', at), say(turn * 2 + 1, 'assistant', text(turn * 2 + 1), 'mirror-team', at + 1000)];
    }).flat();
    await page.evaluate(([messages]) => { (window as any).__previewMessages['mirror-team'] = messages; }, [list] as const);
    await page.locator('#navigation .task-item').filter({ hasText: 'Remote team task' }).click();
    const transcript = page.locator('#transcript');
    await expect(transcript.getByText(text(59), { exact: true })).toHaveCount(1);
    await expect(transcript.getByText(text(1), { exact: true })).toHaveCount(0);
    await page.waitForTimeout(200);
    await expect(transcript.locator('.team-progress-worker')).toHaveCount(0);
    await scrollTopUntil(page, '#transcript', text(1));
    await expect(transcript.locator('.team-progress-slot:not([hidden]) .team-progress')).toHaveCount(1);
  });
});
