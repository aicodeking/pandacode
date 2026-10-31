import { mkdirSync, writeFileSync } from 'node:fs';
import { expect, test, type Page } from '@playwright/test';

// Benchmark harness for the inspector's Changes view: one scrolling list (`.cv-body`) of
// every changed file with its diff inline. It records timings and only fails on errors
// (and on large files that are not virtualized), never on numbers. `?bench=diff` makes the
// preview's git_status list bench/* files whose git_diff patches are synthetic and seeded
// (src/preview.ts, BENCH_DIFFS); `&benchFiles=a,b` lists only those. Skipped by plain
// `npx playwright test`; it runs when named or with PERF=1.
// PW_PORT starts this checkout's own server (never another worktree's on 1420) and
// writes to playwright-report/port-<port>/; PW_PROD=1 measures a production build.
//   Chromium dev:  PW_PORT=1437 npx playwright test tests/diff-perf.spec.ts
//   Chromium prod: PW_PROD=1 PW_PORT=1438 npx playwright test tests/diff-perf.spec.ts
//   WebKit (the real target is WKWebView), dev and prod:
//     PW_PORT=1439 npx playwright test -c playwright.webkit.config.ts tests/diff-perf.spec.ts
//     PW_PROD=1 PW_PORT=1440 npx playwright test -c playwright.webkit.config.ts tests/diff-perf.spec.ts
// Results: <outputDir>/diff-perf-<browser>-<dev|prod>.json plus a console table.
// Timings are sampled once per animation frame (±1 frame). Metrics, from the Changes tab
// click: line = first diff row visible in the list; hl = first visible syntax-colored
// token; hlAll = every non-empty visible row colored; ready = the bench file's viewer ready.
// Bench paths sort before the preview's own src/* files, so the bench file is on top.

const SIZES = ['bench/small.ts', 'bench/medium.ts', 'bench/large.ts', 'bench/multi', 'bench/huge.ts'];
const RUNS = { cold: 3, warm: 5, refresh: 3 };
// The 30k-line patch takes longer per open, so it gets fewer runs.
const HUGE_RUNS = { cold: 2, warm: 2, refresh: 1 };
const mode = process.env.PW_PROD ? 'prod' : 'dev';
const results: Record<string, Record<string, unknown>> = {};

test.describe.configure({ mode: 'serial' });
test.setTimeout(300_000);

declare global { interface Window { __diffBench: any; __benchDiffs?: Record<string, () => string> } }

// In-page probes, installed before the app so the long-task buffer covers every open.
function installProbes(): void {
  // Open the inspector on Files, so every measured open of Changes is a click.
  localStorage.setItem('pandacode.inspector.tabs', JSON.stringify({ open: ['changes', 'files'], selected: 'files' }));
  const longtasks: { start: number; duration: number }[] = [];
  const supported = typeof PerformanceObserver !== 'undefined' && PerformanceObserver.supportedEntryTypes?.includes('longtask');
  if (supported) new PerformanceObserver(list => { for (const e of list.getEntries()) longtasks.push({ start: e.startTime, duration: e.duration }); }).observe({ type: 'longtask', buffered: true });
  const frame = () => new Promise<number>(resolve => requestAnimationFrame(resolve));
  const scroller = () => document.querySelector<HTMLElement>('#inspector-content .changes-view .cv-body');
  const viewer = (path: string) => document.querySelector<HTMLElement>(`#inspector-content .cv-file[data-path="${path}"] .diff-viewer`);
  const shadows = () => [...document.querySelectorAll('#inspector-content .changes-view diffs-container')].flatMap(c => c.shadowRoot ? [c.shadowRoot] : []);
  // Plain rows are bare <span>s; Shiki's rows carry --diffs-token-* colors.
  const TOKEN = 'span[style*="--diffs-token"]';
  /** Non-empty rows inside the list's viewport. */
  const visibleRows = () => {
    const view = scroller()?.getBoundingClientRect();
    if (!view) return [];
    return shadows().flatMap(shadow => [...shadow.querySelectorAll('[data-line]')].filter(row => {
      const box = row.getBoundingClientRect();
      return box.bottom > view.top && box.top < view.bottom && box.height > 0 && !!row.textContent?.trim();
    }));
  };
  const coloredAll = () => { const rows = visibleRows(); return rows.length > 0 && rows.every(row => row.querySelector(TOKEN)); };
  const renderedRows = () => shadows().reduce((sum, shadow) => sum + shadow.querySelectorAll('[data-line]').length, 0);
  const blocked = (t0: number, t1: number) => supported ? longtasks.filter(e => e.start >= t0 && e.start < t1).reduce((sum, e) => sum + e.duration, 0) : undefined;
  const round = (n: number | undefined) => n === undefined ? null : Math.round(n * 10) / 10;
  const tab = (view: string) => document.querySelector<HTMLElement>(`#inspector .inspector-tab[data-view="${view}"] .inspector-tab-button`);
  window.__diffBench = {
    /** Shows Files, then clicks Changes: → line, hl, hlAll, ready for `path`. */
    async open(path: string) {
      tab('files')!.click();
      await frame(); await frame();
      if (scroller()) throw new Error('Changes view still shown');
      const t0 = performance.now();
      tab('changes')!.click();
      const at: Record<'line' | 'ready' | 'hl' | 'hlAll', number | undefined> = { line: undefined, ready: undefined, hl: undefined, hlAll: undefined };
      let state = '';
      while (performance.now() - t0 < 30_000) {
        await frame();
        const now = performance.now() - t0;
        state = viewer(path)?.dataset.diffState ?? '';
        if (state === 'fallback') throw new Error('Diff fell back: ' + viewer(path)?.textContent?.slice(0, 200));
        const rows = visibleRows();
        at.line ??= rows.length ? now : undefined;
        at.hl ??= rows.some(row => row.querySelector(TOKEN)) ? now : undefined;
        at.hlAll ??= at.hl !== undefined && coloredAll() ? now : undefined;
        at.ready ??= state === 'ready' ? now : undefined;
        if (at.ready !== undefined && at.hlAll !== undefined) break;
        // Some rows may never color (e.g. over the tokenize limit): stop 5 s after ready.
        if (at.ready !== undefined && now - at.ready > 5_000) break;
      }
      if (at.ready === undefined) throw new Error('Diff never became ready (state ' + state + ')');
      const end = performance.now();
      // Two more frames so a long task that ended with the render is reported.
      await frame(); await frame();
      return { line: round(at.line), hl: round(at.hl), hlAll: round(at.hlAll), ready: round(at.ready), longTasks: round(blocked(t0, end)), engine: viewer(path)?.dataset.diffEngine ?? null };
    },
    /** Refresh with the list shown: were viewers remounted, did a frame paint with no rows? */
    async refresh() {
      const before = new Set(document.querySelectorAll('#inspector-content .diff-viewer'));
      const list = scroller();
      if (!before.size || !list) throw new Error('Open Changes first');
      const top = list.scrollTop;
      const t0 = performance.now();
      document.querySelector<HTMLElement>('#inspector-refresh')!.click();
      let blankFrames = 0;
      // A quiet refetch (main.ts) plus the view's 1 s refetch gap: watch two seconds.
      while (performance.now() - t0 < 2_000) {
        await frame();
        if (!visibleRows().length) blankFrames++;
      }
      const after = [...document.querySelectorAll('#inspector-content .diff-viewer')];
      await frame();
      return { remounted: after.filter(el => !before.has(el)).length, sameList: scroller() === list, scrollDrift: round(Math.abs((scroller()?.scrollTop ?? 0) - top)), blankFrames, longTasks: round(blocked(t0, performance.now())) };
    },
    /** Scrolls `span` px from `from` (a fraction; default the whole list) in rAF steps; frame times, peak rendered rows, colored at the end. */
    async scroll(duration = 3_000, from = 0, span?: number) {
      const list = scroller();
      if (!list) throw new Error('No Changes list');
      const origin = (list.scrollHeight - list.clientHeight) * from;
      list.scrollTop = origin;
      await frame(); await frame();
      const max = span ?? list.scrollHeight - list.clientHeight - origin, deltas: number[] = [];
      let peakRows = renderedRows(), blankFrames = 0;
      let last = await frame();
      const start = last;
      for (;;) {
        const progress = Math.min(1, (last - start) / duration);
        list.scrollTop = origin + max * progress;
        if (progress === 1) break;
        const now = await frame();
        deltas.push(now - last);
        last = now;
        peakRows = Math.max(peakRows, renderedRows());
        if (!visibleRows().length) blankFrames++;
      }
      const sorted = [...deltas].sort((a, b) => a - b);
      await frame(); await frame();
      return { frames: deltas.length, p95: round(sorted[Math.floor(sorted.length * 0.95)]), max: round(sorted.at(-1)), over34: deltas.filter(d => d > 34).length, scrollHeight: list.scrollHeight, peakRows, blankFrames, colored: coloredAll(), longTasks: round(blocked(start, last)) };
    },
    /** Parks the list at `fraction` of its height; once rows show, does the top row stay where it is while rows render and color? */
    async hold(at: number | string, wait = 1_500) {
      const list = scroller()!;
      // A fraction of the list, or a file path: park with that file's top mid-viewport.
      const file = typeof at === 'string' ? list.querySelector<HTMLElement>(`.cv-file[data-path="${at}"]`) : null;
      list.scrollTop = file ? file.offsetTop - list.clientHeight / 2 : (list.scrollHeight - list.clientHeight) * Number(at);
      let row: Element | undefined;
      for (let i = 0; i < 30 && !row; i++) { await frame(); row = visibleRows()[0]; }
      if (!row) throw new Error('No rows after parking at ' + at);
      const shadow = row.getRootNode() as ShadowRoot, index = row.getAttribute('data-line-index');
      const offset = () => shadow.querySelector(`[data-line][data-line-index="${index}"]`)?.getBoundingClientRect().top ?? NaN;
      const top = offset(), scrollTop = list.scrollTop;
      const t0 = performance.now();
      while (performance.now() - t0 < wait) await frame();
      return { rowDrift: round(Math.abs(offset() - top)), scrollDrift: round(Math.abs(list.scrollTop - scrollTop)), colored: coloredAll() };
    },
    renderedRows,
  };
}

const median = (values: unknown[]): unknown => {
  const sorted = values.filter((v): v is number => typeof v === 'number').sort((a, b) => a - b);
  if (!sorted.length) return values.find(v => v !== null && v !== undefined) ?? null;
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) * 5) / 10;
};
const medians = (runs: Record<string, unknown>[]) => runs.length ? Object.fromEntries(Object.keys(runs[0]).map(key => [key, typeof runs[0][key] === 'boolean' ? runs.every(r => r[key]) : median(runs.map(r => r[key]))])) : {};

async function load(page: Page, files?: string[]): Promise<void> {
  await page.goto(`/?bench=diff${files ? `&benchFiles=${files.join(',')}` : ''}`);
  await expect(page.locator('.task-item.selected')).toHaveAttribute('data-id', 'session-1', { timeout: 20_000 });
  await expect(page.locator('#inspector .inspector-tab[data-view="changes"]'), 'No Changes tab: the server is not serving this checkout. Rerun with PW_PORT=1437.').toBeVisible();
  await expect(page.locator('#inspector .inspector-tab[data-view="files"] .inspector-tab-button')).toBeVisible();
  // Let the diff engine start after the first paint, as it does before a real first click.
  await page.waitForTimeout(500);
}
const open = (page: Page, path: string) => page.evaluate(path => window.__diffBench.open(path), path);

const pageErrors: string[] = [];
test.beforeEach(async ({ page }) => {
  page.on('pageerror', error => pageErrors.push(error.message));
  await page.addInitScript(installProbes);
});
test.afterEach(() => { expect(pageErrors.splice(0)).toEqual([]); });

for (const path of SIZES) {
  test(`diff perf ${path}`, async ({ page }) => {
    const runs = path === 'bench/huge.ts' ? HUGE_RUNS : RUNS;
    await load(page, [path]);
    const patch = await page.evaluate(path => {
      const text = window.__benchDiffs![path]();
      return { bytes: text.length, lines: text.split('\n').length, files: text.split('\ndiff --git').length };
    }, path);
    // Cold: a fresh page each time, so the viewer's first mount and highlighting run again.
    const cold = [];
    for (let i = 0; i < runs.cold; i++) {
      if (i) await load(page, [path]);
      cold.push(await open(page, path));
    }
    // Warm: Files then Changes again; the view remounts and the pool holds the highlighted rows.
    const warm = [];
    for (let i = 0; i < runs.warm; i++) warm.push(await open(page, path));
    const refresh = [];
    for (let i = 0; i < runs.refresh; i++) refresh.push(await page.evaluate(() => window.__diffBench.refresh()));
    for (const run of refresh) expect(run.remounted, 'A refresh with unchanged patches remounted a viewer').toBe(0);
    results[path] = { patch, cold: { ...medians(cold), first: cold[0] }, warm: medians(warm), refresh: medians(refresh), runs: { cold, warm, refresh } };
    test.info().annotations.push({ type: 'diff-perf', description: JSON.stringify({ path, ...results[path], runs: undefined }) });
  });
}

// Every bench file plus the preview's own: the huge, large and multi patches in one list.
test('diff perf scroll the whole list', async ({ page }) => {
  await load(page);
  const lines = await page.evaluate(() => Object.values(window.__benchDiffs!).reduce((sum, patch) => sum + patch().split('\n').length, 0));
  const opened = await open(page, 'bench/huge.ts');
  // Let every patch load and mount (the list fetches patches as they near the viewport).
  await page.waitForTimeout(1_500);
  const scroll = await page.evaluate(() => window.__diffBench.scroll());
  const again = await page.evaluate(() => window.__diffBench.scroll());
  // A fast trackpad fling (3000 px/s) through the middle of the huge file.
  const fling = await page.evaluate(() => window.__diffBench.scroll(3_000, 0.3, 9_000));
  const holds = [];
  // The last one parks where two virtualized files (huge, then large) share the viewport.
  for (const at of [0.1, 0.35, 0.6, 'bench/large.ts', 'bench/multi']) holds.push(await page.evaluate(at => window.__diffBench.hold(at), at));
  const refresh = await page.evaluate(() => window.__diffBench.refresh());
  expect(refresh.remounted, 'A refresh with unchanged patches remounted a viewer').toBe(0);
  // Virtualized: only rows near the viewport are in the DOM, never the whole 36k-line list.
  expect(scroll.peakRows, `rendered ${scroll.peakRows} of ${lines} rows`).toBeLessThan(lines / 4);
  // Hunk groups mount in later frames; each container with rows still has the Changes view's shadow CSS.
  const unstyled = await page.evaluate(() => [...document.querySelectorAll('#inspector-content .changes-view diffs-container')]
    .filter(c => c.shadowRoot?.querySelector('[data-line]') && ![...c.shadowRoot?.querySelectorAll('style') ?? []].some(style => style.textContent?.includes("[data-separator='metadata']"))).length);
  expect(unstyled, 'diffs-containers without the Changes view CSS').toBe(0);
  for (const hold of holds) expect(hold.rowDrift, 'The visible rows moved while parked').toBeLessThan(2);
  results['scroll list'] = { lines, opened, scroll, again, fling, holds, refresh };
});

// Where the main thread's time goes on the largest single file: Chromium's sampling profiler.
// Work moved to a highlighter worker does not show up here.
test('diff perf profile bench/large.ts', async ({ page, browserName }) => {
  test.skip(browserName !== 'chromium', 'CDP profiler is Chromium only');
  await load(page, ['bench/large.ts']);
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('Profiler.enable');
  await cdp.send('Profiler.setSamplingInterval', { interval: 200 });
  await cdp.send('Profiler.start');
  const opened = await open(page, 'bench/large.ts');
  const { profile } = await cdp.send('Profiler.stop');
  const bucket = (url: string, name: string) => {
    // Shiki is bundled inside @pierre/diffs; its JS regex engine shows up as RegExp frames and these helpers.
    if (name.startsWith('RegExp:') || /^(findNextMatchSync|#execCore|toRegExp|_tokenizeString|tokenizeLine)/.test(name)) return 'shiki tokenize';
    if (!url) return name === '(garbage collector)' ? 'gc' : name === '(program)' ? 'browser (style/layout/paint)' : name === '(idle)' ? 'idle' : 'native/other';
    if (/oniguruma|vscode-textmate|shiki|@shikijs/.test(url)) return 'shiki';
    if (/@pierre|pierre_diffs|\/assets\/(diff|index|worker)/.test(url)) return '@pierre/diffs';
    if (/\/src\//.test(url)) return 'app src';
    return 'other js';
  };
  const total = new Map<string, number>(), byFunction = new Map<string, number>(), self = new Map<number, number>();
  const nodes = new Map(profile.nodes.map(node => [node.id, node]));
  const deltas = profile.timeDeltas ?? [];
  (profile.samples ?? []).forEach((id, i) => self.set(id, (self.get(id) ?? 0) + (deltas[i] ?? 0) / 1000));
  for (const [id, ms] of self) {
    const frame = nodes.get(id)!.callFrame;
    const key = bucket(frame.url, frame.functionName);
    total.set(key, (total.get(key) ?? 0) + ms);
    const fn = ((frame.functionName.startsWith('RegExp:') ? 'RegExp (shiki grammar)' : frame.functionName || '(anonymous)') + (frame.url ? ' ' + frame.url.replace(/^.*?(node_modules\/|src\/|assets\/)/, '$1').replace(/\?.*$/, '') + ':' + frame.lineNumber : '')).slice(0, 90);
    byFunction.set(fn, (byFunction.get(fn) ?? 0) + ms);
  }
  const top = [...byFunction].sort((a, b) => b[1] - a[1]).slice(0, 15).map(([fn, ms]) => ({ ms: Math.round(ms * 10) / 10, fn }));
  results['profile bench/large.ts'] = { open: opened, selfTimeMs: Object.fromEntries([...total].map(([k, v]) => [k, Math.round(v)] as const).sort((a, b) => b[1] - a[1])), topFunctions: top };
});

test.afterAll(async ({ browserName }, testInfo) => {
  const file = `${testInfo.project.outputDir}/diff-perf-${browserName}-${mode}.json`;
  mkdirSync(testInfo.project.outputDir, { recursive: true });
  writeFileSync(file, JSON.stringify({ browser: browserName, mode, at: new Date().toISOString(), results }, null, 2));
  const table = Object.entries(results).filter(([key]) => key.startsWith('bench/')).map(([path, r]: [string, any]) => ({
    path, lines: r.patch.lines, engine: r.cold.engine,
    coldLine: r.cold.line, coldHl: r.cold.hl, coldHlAll: r.cold.hlAll, coldReady: r.cold.ready, coldLong: r.cold.longTasks,
    warmLine: r.warm.line, warmHl: r.warm.hl, warmHlAll: r.warm.hlAll, warmLong: r.warm.longTasks,
    refreshBlank: r.refresh.blankFrames, remounted: r.refresh.remounted, refreshLong: r.refresh.longTasks,
  }));
  console.log(`diff perf (${browserName}, ${mode}, ms medians) → ${file}`);
  console.table(table);
  if (results['scroll list']) console.log('scroll list', JSON.stringify(results['scroll list']));
  if (results['profile bench/large.ts']) console.log(JSON.stringify(results['profile bench/large.ts'], null, 2));
});
