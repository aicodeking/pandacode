import { expect, test, type CDPSession, type Page, type TestInfo } from '@playwright/test';
import { createHash } from 'node:crypto';
import { arch, cpus, freemem, platform, release, totalmem } from 'node:os';
import { readFileSync, writeFileSync } from 'node:fs';

// M10 performance, scale and resource-lifetime gates. Budgets come from the frozen M0 files; a
// noisy or otherwise incomparable population is reported as such and never counted as a pass.
const read = (path: string) => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const fixture = read('./fixtures/extensions/baseline.json');
const frozen = read('./fixtures/extensions/performance-baselines.json');
const scale = read('./fixtures/extensions/performance-scale.json');
const dataPanel = read('./fixtures/extensions/data-panel/extension.json');
const transcript = read('./fixtures/extensions/transcript/extension.json');
const packagesKey = 'pandacode.preview.extensions.v1';

test.use({ viewport: fixture.viewport, locale: fixture.locale, timezoneId: fixture.timezone, reducedMotion: 'reduce' });
const prompt = (page: Page) => page.getByRole('textbox', { name: 'Message your coding agent', exact: true });
const selected = (page: Page) => page.locator('.task-item.selected');

type Stats = { samples: number[]; median: number; p95: number };
const stats = (values: number[]): Stats => { const sorted = [...values].sort((a, b) => a - b); return { samples: values, median: sorted[Math.floor(sorted.length / 2)], p95: sorted[Math.ceil(sorted.length * .95) - 1] }; };
const dispersion = (value: Stats) => value.median > 0 ? (value.p95 - value.median) / value.median : 0;

/** Whole-machine CPU use over an idle window, before the page starts sampling. */
async function machineBusyPercent(ms = 3000): Promise<number> {
  const total = () => cpus().reduce((sum, cpu) => { const t = cpu.times; return { idle: sum.idle + t.idle, all: sum.all + t.idle + t.user + t.sys + t.nice + t.irq }; }, { idle: 0, all: 0 });
  // Windows updates per-core idle time coarsely; a shorter window can read as zero idle.
  const before = total(); await new Promise(resolve => setTimeout(resolve, ms)); const after = total();
  return Math.round(1000 * (1 - (after.idle - before.idle) / Math.max(1, after.all - before.all))) / 10;
}

/** Same comparison rule as M0: baseline + max(5%, noise floor), independently for median and p95. */
function compare(name: string, actual: Stats, reference: { median: number; p95: number } | undefined, reasons: string[]) {
  const ceiling = (value: number) => value + Math.max(value * fixture.budgets.startupIncreasePercent / 100, fixture.budgets.noiseFloorMs);
  const own = [...reasons];
  if (dispersion(actual) > scale.budgets.noise.maxDispersion) own.push(`dispersion ${dispersion(actual).toFixed(2)} > ${scale.budgets.noise.maxDispersion}`);
  if (!reference) return { name, ...actual, verdict: 'incomparable', reasons: [...own, 'no frozen reference for this engine/metric'] };
  const medianCeiling = ceiling(reference.median), p95Ceiling = ceiling(reference.p95);
  const within = actual.median <= medianCeiling && actual.p95 <= p95Ceiling;
  return { name, ...actual, reference: { median: reference.median, p95: reference.p95 }, medianCeiling, p95Ceiling,
    verdict: own.length ? 'incomparable' : within ? 'within' : 'over', withinCeilings: within, reasons: own };
}

async function metadata(page: Page, info: TestInfo, busy: number) {
  return { fixture: fixture.fixture, scaleFixture: scale.fixture, fixtureSha256: createHash('sha256').update(JSON.stringify(fixture)).digest('hex'),
    build: process.env.PW_PROD ? 'vite-production' : 'vite-development', revision: process.env.BASELINE_REVISION ?? null,
    platform: platform(), release: release(), browser: info.project.use.browserName ?? 'chromium', browserVersion: page.context().browser()?.version(),
    machine: { architecture: arch(), cpu: cpus()[0]?.model ?? null, logicalProcessors: cpus().length, totalMemoryBytes: totalmem(), freeMemoryBytes: freemem(), node: process.version, busyPercentBeforeSampling: busy } };
}

function populationReasons(busy: number): string[] {
  const reasons: string[] = [];
  if (!process.env.PW_PROD) reasons.push('development build; the frozen population is vite-production');
  if (busy > scale.budgets.noise.maxMachineBusyPercent) reasons.push(`machine ${busy}% busy before sampling (> ${scale.budgets.noise.maxMachineBusyPercent}%)`);
  return reasons;
}

function record(info: TestInfo, name: string, value: unknown) {
  const path = info.outputPath(`${name}.json`);
  writeFileSync(path, JSON.stringify(value, null, 2));
  return info.attach(name, { path, contentType: 'application/json' });
}

/** Relative gates fail only on a comparable population; incomparable ones are annotated, not passed. */
function gate(info: TestInfo, results: { name: string; verdict: string; reasons?: string[] }[]) {
  for (const result of results) if (result.verdict === 'incomparable') info.annotations.push({ type: 'incomparable', description: `${result.name}: ${result.reasons?.join('; ')}` });
  expect(results.filter(result => result.verdict === 'over').map(result => result.name)).toEqual([]);
}

async function open(page: Page, query = '') {
  await page.clock.setFixedTime(new Date(fixture.time));
  await page.addInitScript(() => {
    localStorage.setItem('pandacode.theme', 'light');
    localStorage.setItem('pandacode.wallpaperPreferences', JSON.stringify({ version: 3, enabled: false, visibility: 20, blur: 0, set: 'automatic', pinned: null }));
    (window as any).__extensionsBaseline = { version: 1, calls: [], holdRun: true };
    // Chromium reports long tasks; WebKit has no longtask entry type, so frame gaps are the proxy there.
    (window as any).__longTasks = [];
    if (PerformanceObserver.supportedEntryTypes?.includes('longtask')) new PerformanceObserver(list => { for (const entry of list.getEntries()) (window as any).__longTasks.push({ start: entry.startTime, duration: entry.duration }); }).observe({ type: 'longtask', buffered: true });
  });
  await page.goto(`/?extensions-baseline${query}`);
  await expect(prompt(page)).toBeEnabled();
  await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
}

/** In-page interaction timing: action → first frame where `ready()` holds, with long tasks and frame gaps. */
async function interaction(page: Page, action: 'switch' | 'menu', expectedItems = 0) {
  return page.evaluate(async ({ action, expectedItems }) => {
    const longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
    const start = performance.now(); let last = start, maxFrameGap = 0;
    if (action === 'switch') (document.querySelector('.task-item[data-id="session-2"]') as HTMLElement).click();
    else {
      const row = document.querySelector('.task-item[data-id="session-2"]') as HTMLElement, box = row.getBoundingClientRect();
      row.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, button: 2, clientX: box.left + 20, clientY: box.top + 8 }));
    }
    const ready = () => {
      if (action === 'switch') {
        const field = document.querySelector<HTMLTextAreaElement>('#prompt');
        return field?.dataset.sessionId === 'session-2' && !field.disabled && document.querySelector('.task-item.selected')?.getAttribute('data-id') === 'session-2';
      }
      const items = [...document.querySelectorAll('.choice-menu [role="menuitem"]')];
      return items.some(item => item.textContent?.includes('Pin task')) && items.filter(item => item.textContent?.startsWith('Perf ')).length === expectedItems;
    };
    for (;;) {
      const now = await new Promise<number>(resolve => requestAnimationFrame(resolve));
      maxFrameGap = Math.max(maxFrameGap, now - last); last = now;
      if (ready()) break;
      if (performance.now() - start > 10_000) throw new Error(`${action} never became ready`);
    }
    const duration = performance.now() - start;
    // Long-task entries arrive asynchronously; give the observer a few frames to report this interaction.
    for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve));
    const longTasks = longTaskSupported ? (window as any).__longTasks.filter((entry: { start: number; duration: number }) => entry.start + entry.duration > start).map((entry: { duration: number }) => Math.round(entry.duration)) : null;
    return { duration, maxFrameGap: Math.round(maxFrameGap), longTasks, maxLongTask: longTasks ? Math.max(0, ...longTasks) : null };
  }, { action, expectedItems });
}

/** Deterministic synthetic packages; every contribution is a declarative menu entry, nothing executes. */
function scalePackages() {
  const pad = (value: number, size: number) => String(value).padStart(size, '0');
  return Array.from({ length: scale.packages }, (_, p) => {
    const id = `${scale.publisher}.ext-${pad(p + 1, 2)}`;
    const commands = Array.from({ length: scale.perContextLocation }, (_, c) => ({ id: `${id}/run-${c + 1}`, title: `Perf ${pad(p + 1, 2)} action ${c + 1}`, action: { kind: 'showMessage', message: `Perf ${pad(p + 1, 2)} action ${c + 1}` } }));
    const menus: Record<string, unknown>[] = scale.visibleLocations.map((location: string, v: number) => ({ id: `${id}/visible-${v + 1}`, location, command: commands[0].id, presentation: 'button', text: `P${pad(p + 1, 2)}`, group: 'extensions', order: p }));
    for (const location of scale.contextLocations) for (const command of commands) menus.push({ id: `${id}/m-${pad(menus.length + 1, 3)}`, location, command: command.id, group: 'extensions', order: p });
    return { manifest: { manifestVersion: 1, id, version: '1.0.0', engines: { pandacodeApi: '^1.0.0' }, extensionKind: 'ui', permissions: ['ui.contribute'], contributes: { commands, menus } }, enabled: true, icons: {} };
  });
}

test.describe('extensions performance', () => {
  test('zero-extension startup, task switch and heap compare against the frozen M0 population', async ({ page, browserName }, info) => {
    test.setTimeout(120_000);
    const busy = await machineBusyPercent();
    const startup: number[] = [], taskSwitch: number[] = [], legacy: number[] = [], heap: (number | null)[] = [];
    await open(page);
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    for (let sample = 0; sample < fixture.samples; sample++) {
      const navigationStart = performance.now();
      await page.reload();
      await expect(prompt(page)).toBeEnabled();
      await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
      startup.push(performance.now() - navigationStart);
      taskSwitch.push((await interaction(page, 'switch')).duration);
      await page.locator('.task-item[data-id="session-1"]').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
      // The original actionability + protocol round-trip method, compared only with itself.
      const before = performance.now();
      await page.locator('.task-item[data-id="session-2"]').click();
      await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-2'); await expect(prompt(page)).toBeEnabled();
      legacy.push(performance.now() - before);
      await page.locator('.task-item[data-id="session-1"]').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
      const metrics = await cdp?.send('Performance.getMetrics');
      heap.push(metrics?.metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null);
    }
    await cdp?.detach();
    const engine = frozen.engines[browserName];
    const reasons = populationReasons(busy);
    // The frozen population belongs to one machine; another machine (e.g. a CI runner) is incomparable.
    if (platform() !== frozen.platform || cpus()[0]?.model !== frozen.machine.cpu || cpus().length !== frozen.machine.logicalProcessors) reasons.push(`different machine from the frozen population (${frozen.machine.cpu}, ${frozen.platform})`);
    const version = page.context().browser()?.version() ?? '';
    if (engine && version.split('.')[0] !== String(engine.version).split('.')[0]) reasons.push(`${browserName} ${version} differs from frozen ${engine.version}`);
    const results = [
      compare('startupMs', stats(startup), engine?.startupMs, reasons),
      compare('taskSwitchMs', stats(taskSwitch), engine?.taskSwitchMs, reasons),
      compare('legacyAutomationSwitchMs', stats(legacy), engine?.legacyAutomationSwitchMs, reasons),
    ];
    const frozenHeap = engine?.jsHeapBytes?.filter((value: number | null) => value !== null) ?? [];
    const heapComparison = heap.every(value => value !== null) && frozenHeap.length
      ? { medianBytes: stats(heap as number[]).median, frozenMedianBytes: stats(frozenHeap).median, deltaMiB: (stats(heap as number[]).median - stats(frozenHeap).median) / 1048576,
          note: 'Uncollected JS heap proxy; the 15 MiB native resident-memory budget remains unqualified in a browser preview.' }
      : { unavailableReason: 'CDP heap metric unavailable in WebKit' };
    await record(info, 'zero-extension', { ...await metadata(page, info, busy), sampleCount: fixture.samples, results, jsHeapBytes: heap, heapComparison, residentMemoryMiB: null, residentMemoryUnavailableReason: 'Browser preview cannot qualify native webview/host RSS' });
    expect(Math.max(...startup)).toBeLessThan(fixture.budgets.startupAbsoluteMs);
    expect(stats(taskSwitch).p95).toBeLessThan(fixture.budgets.taskSwitchAbsoluteMs);
    expect(stats(legacy).p95).toBeLessThan(fixture.budgets.taskSwitchAbsoluteMs);
    gate(info, results);
  });

  test('one thousand contributions across twenty extensions resolve with bounded interaction work', async ({ page, browserName }, info) => {
    test.setTimeout(180_000);
    const packages = scalePackages();
    const total = packages.reduce((sum, item) => sum + item.manifest.contributes.menus.length, 0);
    expect(packages).toHaveLength(scale.packages); expect(total).toBe(scale.packages * scale.contributionsPerPackage);
    const perMenu = scale.packages * scale.perContextLocation;
    const busy = await machineBusyPercent();
    await open(page, '&extension-performance');
    // Prove the long-task instrument reports a known 120 ms block before trusting its zero counts.
    const probe = await page.evaluate(async () => {
      if (!PerformanceObserver.supportedEntryTypes?.includes('longtask')) return null;
      const start = performance.now();
      // A separate macrotask, so the block is one scheduler task rather than part of the evaluate call.
      await new Promise<void>(resolve => setTimeout(() => { const begin = performance.now(); while (performance.now() - begin < 120) { /* deliberate block */ } resolve(); }, 0));
      // Entries are delivered asynchronously after the task ends; wait up to a second for this one.
      const seen = () => (window as any).__longTasks.filter((entry: { start: number; duration: number }) => entry.start + entry.duration > start).map((entry: { duration: number }) => entry.duration);
      for (let waited = 0; !seen().length && waited < 60; waited++) await new Promise(resolve => requestAnimationFrame(resolve));
      return Math.max(0, ...seen());
    });
    if (browserName === 'chromium') expect(probe).toBeGreaterThanOrEqual(100);
    const population = { zero: { startup: [] as number[], taskSwitch: [] as unknown[], menu: [] as unknown[] }, scaled: { startup: [] as number[], taskSwitch: [] as unknown[], menu: [] as unknown[], resolution: [] as unknown[] } };
    // Interleaved so both populations share the same machine load.
    for (let sample = 0; sample < scale.samples; sample++) for (const kind of ['zero', 'scaled'] as const) {
      await page.evaluate(({ key, value }) => localStorage.setItem(key, value), { key: packagesKey, value: JSON.stringify(kind === 'zero' ? [] : packages) });
      const navigationStart = performance.now();
      await page.reload();
      await expect(prompt(page)).toBeEnabled();
      await expect(selected(page)).toHaveAttribute('data-id', 'session-1');
      await expect(page.locator('[data-extension-contribution^="perf.ext-"]')).toHaveCount(kind === 'zero' ? 0 : scale.packages * scale.visibleLocations.length);
      population[kind].startup.push(performance.now() - navigationStart);
      population[kind].taskSwitch.push(await interaction(page, 'switch'));
      await page.locator('.task-item[data-id="session-1"]').click(); await expect(prompt(page)).toHaveAttribute('data-session-id', 'session-1');
      population[kind].menu.push(await interaction(page, 'menu', kind === 'zero' ? 0 : perMenu));
      await page.keyboard.press('Escape'); await expect(page.locator('.choice-menu')).toHaveCount(0);
      if (kind === 'scaled') {
        // Contribution resolution after a lifecycle change remounts every location from the snapshot.
        population.scaled.resolution.push(await page.evaluate(async () => {
          const api = (window as any).__extensionPerformance, longTaskSupported = PerformanceObserver.supportedEntryTypes?.includes('longtask') ?? false;
          const start = performance.now();
          await api.enable('perf.ext-20', false); await api.enable('perf.ext-20', true);
          await new Promise(resolve => requestAnimationFrame(resolve));
          const duration = performance.now() - start;
          for (let i = 0; i < 6; i++) await new Promise(resolve => requestAnimationFrame(resolve));
          const longTasks = longTaskSupported ? (window as any).__longTasks.filter((entry: { start: number; duration: number }) => entry.start + entry.duration > start).map((entry: { duration: number }) => Math.round(entry.duration)) : null;
          return { duration, longTasks, maxLongTask: longTasks ? Math.max(0, ...longTasks) : null, visible: document.querySelectorAll('[data-extension-contribution^="perf.ext-"]').length };
        }));
      }
    }
    // The real pointer path shows every contributed item in the captured task menu, plus built-ins.
    await page.locator('.task-item[data-id="session-2"]').click({ button: 'right' });
    await expect(page.locator('.choice-menu [role="menuitem"]', { hasText: /^Perf / })).toHaveCount(perMenu);
    await expect(page.getByRole('menuitem', { name: 'Pin task', exact: true })).toBeVisible();
    await page.keyboard.press('Escape');
    expect(await page.evaluate(() => document.querySelector('#toast')?.textContent ?? '')).not.toContain('128-item limit');

    type Timed = { duration: number; maxFrameGap?: number; longTasks: number[] | null; maxLongTask: number | null };
    const durations = (values: unknown[]) => stats((values as Timed[]).map(value => value.duration));
    const over = (values: unknown[]) => (values as Timed[]).filter(value => (value.maxLongTask ?? 0) > scale.budgets.interactionLongTaskMs).length;
    const reasons = populationReasons(busy);
    const zeroSwitch = durations(population.zero.taskSwitch), zeroMenu = durations(population.zero.menu);
    // The +5% rule budgets the zero-extension app against M0. With 1,000 active contributions the plan
    // asks for bounded work and no new long task, so the cost over zero is reported, not gated at 5%.
    const costOverZero = {
      startupMedianMs: stats(population.scaled.startup).median - stats(population.zero.startup).median,
      taskSwitchMedianMs: durations(population.scaled.taskSwitch).median - zeroSwitch.median,
      menuOpenMedianMs: durations(population.scaled.menu).median - zeroMenu.median,
    };
    const longTaskSupported = (population.scaled.taskSwitch as Timed[])[0].longTasks !== null;
    const longTask = longTaskSupported ? {
      name: 'newInteractionLongTasksOver50ms',
      zero: { taskSwitch: over(population.zero.taskSwitch), menu: over(population.zero.menu) },
      scaled: { taskSwitch: over(population.scaled.taskSwitch), menu: over(population.scaled.menu) },
    } : null;
    const longTaskVerdict = !longTask ? { name: 'newInteractionLongTasksOver50ms', verdict: 'incomparable', reasons: ['longtask entries unavailable in WebKit; frame gaps recorded instead'] }
      : { name: 'newInteractionLongTasksOver50ms', verdict: reasons.length ? 'incomparable' : longTask.scaled.taskSwitch > longTask.zero.taskSwitch || longTask.scaled.menu > longTask.zero.menu ? 'over' : 'within', reasons };
    await record(info, 'scale', { ...await metadata(page, info, busy), packages: scale.packages, contributions: total, contributionsPerContextMenu: perMenu, samplesPerPopulation: scale.samples,
      zero: { startupMs: stats(population.zero.startup), taskSwitch: population.zero.taskSwitch, menu: population.zero.menu },
      scaled: { startupMs: stats(population.scaled.startup), taskSwitch: population.scaled.taskSwitch, menu: population.scaled.menu, resolution: population.scaled.resolution },
      menuOpenMs: { zero: zeroMenu, scaled: durations(population.scaled.menu) }, resolutionMs: durations(population.scaled.resolution), costOverZero, longTaskProbeMs: probe, longTask, longTaskVerdict });
    expect((population.scaled.resolution as { visible: number }[]).every(value => value.visible === scale.packages * scale.visibleLocations.length)).toBe(true);
    expect(durations(population.scaled.menu).p95).toBeLessThan(scale.budgets.menuOpenAbsoluteMs);
    expect(durations(population.scaled.resolution).p95).toBeLessThan(scale.budgets.resolutionAbsoluteMs);
    expect(stats(population.scaled.startup).p95).toBeLessThan(fixture.budgets.startupAbsoluteMs);
    expect(durations(population.scaled.taskSwitch).p95).toBeLessThan(fixture.budgets.taskSwitchAbsoluteMs);
    gate(info, [longTaskVerdict]);
    if (browserName === 'webkit') info.annotations.push({ type: 'limit', description: 'WebKit has no longtask entries; frame gaps are recorded as a proxy, not a gate.' });
  });

  test('one hundred enable/disable/open/close cycles leave no owned registrations and memory settles', async ({ page, browserName }, info) => {
    test.setTimeout(420_000);
    await page.addInitScript(({ key, manifest }) => {
      if (localStorage.getItem(key) === null) localStorage.setItem(key, JSON.stringify([{ manifest, enabled: true, icons: {} }]));
      if (localStorage.getItem('pandacode.inspector.tabs') === null) localStorage.setItem('pandacode.inspector.tabs', JSON.stringify({ open: ['changes', 'sample.data-panel/overview'], selected: 'sample.data-panel/overview' }));
      // Window/document listeners outlive DOM nodes, so they are where a lifecycle leak would accumulate.
      const live = new Map<string, number>(), key2 = (target: EventTarget, type: string, capture: boolean) => `${target === window ? 'window' : 'document'}:${type}:${capture}`;
      const callbacks = new WeakMap<object, Set<string>>();
      const add = EventTarget.prototype.addEventListener, remove = EventTarget.prototype.removeEventListener;
      EventTarget.prototype.addEventListener = function (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | AddEventListenerOptions) {
        if ((this === window || this === document) && callback) {
          const capture = typeof options === 'boolean' ? options : !!options?.capture, id = key2(this, type, capture);
          const seen = callbacks.get(callback) ?? new Set(); callbacks.set(callback, seen);
          const signal = typeof options === 'object' ? options.signal : undefined;
          // `once` listeners remove themselves when they fire, which this count cannot observe.
          if (!seen.has(id) && !signal?.aborted && !(typeof options === 'object' && options.once)) {
            seen.add(id); live.set(id, (live.get(id) ?? 0) + 1);
            signal?.addEventListener('abort', () => { if (seen.delete(id)) live.set(id, live.get(id)! - 1); }, { once: true });
          }
        }
        return add.call(this, type, callback, options);
      };
      EventTarget.prototype.removeEventListener = function (type: string, callback: EventListenerOrEventListenerObject | null, options?: boolean | EventListenerOptions) {
        if ((this === window || this === document) && callback) {
          const capture = typeof options === 'boolean' ? options : !!options?.capture, id = key2(this, type, capture);
          if (callbacks.get(callback)?.delete(id)) live.set(id, live.get(id)! - 1);
        }
        return remove.call(this, type, callback, options);
      };
      (window as any).__globalListeners = () => Object.fromEntries([...live].filter(([, count]) => count > 0));
    }, { key: packagesKey, manifest: dataPanel });
    await open(page, '&data-panel&extension-performance');
    const panel = page.getByRole('region', { name: 'Data panel — sample.data-panel', exact: true });
    const header = page.locator('[data-extension-contribution="sample.data-panel/header"]');
    const cdp = browserName === 'chromium' ? await page.context().newCDPSession(page) : null;
    await cdp?.send('Performance.enable');
    const heapAfterGc = async () => {
      // Test-owned recorders (IPC call log, long-task list) grow by design; empty them first.
      await page.evaluate(() => { (window as any).__extensionsBaseline.calls.length = 0; (window as any).__longTasks.length = 0; });
      if (!cdp) return null;
      await cdp.send('HeapProfiler.collectGarbage');
      return (await cdp.send('Performance.getMetrics')).metrics.find(metric => metric.name === 'JSHeapUsedSize')?.value ?? null;
    };
    const counts = () => page.evaluate(async () => {
      const api = (window as any).__extensionPerformance;
      return { changeListeners: await api.changeListeners(), nativeListeners: api.nativeListeners(), globalListeners: (window as any).__globalListeners(),
        contributionNodes: document.querySelectorAll('[data-extension-contribution]').length, viewNodes: document.querySelectorAll('.extension-inspector-view').length,
        openDialogs: document.querySelectorAll('dialog[open]').length, menus: document.querySelectorAll('.choice-menu').length };
    });
    const enable = (enabled: boolean) => page.evaluate(async enabled => (window as any).__extensionPerformance.enable('sample.data-panel', enabled), enabled);
    const cycle = async () => {
      await enable(true);
      await expect(header).toBeVisible(); await expect(panel).toBeVisible();
      await panel.getByRole('button', { name: 'Panel options', exact: true }).click();
      await expect(page.locator('dialog[open]')).toHaveCount(1);
      await page.keyboard.press('Escape'); await expect(page.locator('dialog[open]')).toHaveCount(0);
      await enable(false);
      await expect(header).toHaveCount(0); await expect(panel).toHaveCount(0);
    };
    await expect(panel).toBeVisible(); await enable(false); await expect(panel).toHaveCount(0);
    // One warm-up cycle loads lazy modules; the zero-extension state after it is the reference.
    await cycle();
    const reference = await counts();
    const heap: { cycle: number; bytes: number | null; at: ReturnType<typeof counts> extends Promise<infer T> ? T : never }[] = [{ cycle: 0, bytes: await heapAfterGc(), at: reference }];
    // Retained-object census: class counts from a heap snapshot. Engine caches (JIT code, style
    // sharing, bounded performance-timeline buffers) are reported but not attributed to extensions.
    const census = async () => {
      let chunks = '';
      const onChunk = (event: { chunk: string }) => { chunks += event.chunk; };
      cdp!.on('HeapProfiler.addHeapSnapshotChunk', onChunk);
      await heapAfterGc(); await cdp!.send('HeapProfiler.takeHeapSnapshot', { reportProgress: false });
      cdp!.off('HeapProfiler.addHeapSnapshotChunk', onChunk);
      const snapshot = JSON.parse(chunks), fields: string[] = snapshot.snapshot.meta.node_fields, types: string[] = snapshot.snapshot.meta.node_types[0];
      const [type, name, size] = ['type', 'name', 'self_size'].map(field => fields.indexOf(field)), counts = new Map<string, { count: number; bytes: number }>();
      for (let i = 0; i < snapshot.nodes.length; i += fields.length) {
        const key = `${types[snapshot.nodes[i + type]]}:${String(snapshot.strings[snapshot.nodes[i + name]]).slice(0, 80)}`;
        const value = counts.get(key) ?? { count: 0, bytes: 0 }; value.count++; value.bytes += snapshot.nodes[i + size]; counts.set(key, value);
      }
      return counts;
    };
    const warmCycles = 20;
    let warm: Awaited<ReturnType<typeof census>> | undefined;
    const started = performance.now();
    for (let index = 1; index <= scale.lifetimeCycles; index++) {
      if (cdp && index === warmCycles + 1) warm = await census();
      await cycle();
      if (index % 10 === 0) heap.push({ cycle: index, bytes: await heapAfterGc(), at: await counts() });
    }
    const elapsedMs = performance.now() - started;
    const measured = scale.lifetimeCycles - warmCycles;
    const growth = warm ? [...await census()].map(([key, value]) => ({ key, count: value.count - (warm!.get(key)?.count ?? 0), bytes: value.bytes - (warm!.get(key)?.bytes ?? 0) })).filter(entry => entry.count >= measured / 2).sort((a, b) => b.count - a.count) : null;
    // One or more retained JS objects/closures/strings or DOM nodes per cycle is a leak.
    const perCycle = growth?.filter(entry => entry.count >= measured && (/^(object|closure|array|string|concatenated string|sliced string|regexp|hidden):/.test(entry.key) || /^native:(Detached |HTML|SVG|Text$|Comment$|EventListener)/.test(entry.key))) ?? null;
    const final = await counts();
    const bytes = heap.map(sample => sample.bytes).filter((value): value is number => value !== null);
    const monotonic = bytes.length > 2 && bytes.every((value, i) => i === 0 || value > bytes[i - 1]);
    const warmed = heap.find(sample => sample.cycle === 10)?.bytes ?? null;
    const settleMiB = warmed !== null && bytes.length ? (bytes.at(-1)! - warmed) / 1048576 : null;
    await record(info, 'lifetime', { ...await metadata(page, info, -1), cycles: scale.lifetimeCycles, elapsedMs, reference, final, heap,
      heapSettleMiBFromCycle10: settleMiB, heapMonotonic: monotonic, retainedGrowthFromCycle20: growth, perCycleRetained: perCycle,
      heapUnavailableReason: cdp ? null : 'CDP heap metric unavailable in WebKit; registration counts still gate',
      processNote: 'Browser preview starts no child processes; the native supervisor lifetime test checks real descendants.' });
    await cdp?.detach();
    expect(final).toEqual({ ...reference, contributionNodes: 0, viewNodes: 0, openDialogs: 0, menus: 0 });
    for (const sample of heap) expect(sample.at).toEqual(reference);
    if (cdp) {
      expect(perCycle).toEqual([]);
      expect(settleMiB!).toBeLessThan(scale.budgets.heapSettleMiB);
      if (monotonic) info.annotations.push({ type: 'heap', description: `JS heap rose at every sample (${settleMiB!.toFixed(2)} MiB after cycle 10); retained-class census attributes it in lifetime.json` });
    }
  });

  test('crash injection during a streaming task keeps every core event, one completion and the resume ID', async ({ page }) => {
    test.setTimeout(60_000);
    await page.addInitScript(({ key, manifest }) => {
      localStorage.setItem(key, JSON.stringify([{ manifest, enabled: true, icons: {} }]));
      localStorage.setItem('pandacode.components.v1', JSON.stringify({ schemaVersion: 1, selected: { 'panda.transcript': 'sample.transcript/timeline' } }));
    }, { key: packagesKey, manifest: transcript });
    await open(page, '&replacement&transcript-conformance');
    await expect(page.locator('#transcript')).toHaveAttribute('data-component-provider', 'sample.transcript/timeline');
    await prompt(page).fill('Recorded crash-injection run'); await prompt(page).press('Enter');
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    const before = await page.evaluate(() => (window as any).__previewTranscriptState());
    const faults = ['failure', 'disable', 'enable', 'refresh', 'failure', 'disable', 'enable', 'refresh', 'failure', 'safe-mode'];
    const chunks: string[] = [];
    for (let index = 0; index < 30; index++) {
      const text = `[chunk ${String(index).padStart(2, '0')}] `;
      chunks.push(text);
      await page.evaluate(text => (window as any).__previewTranscriptFrame({ sessionId: 'session-1', kind: 'text', text }), text);
      if (index % 3 === 2) await page.evaluate(async fault => {
        const api = await (window as any).__previewReplacementModules(), manager = await (window as any).__previewTranscriptModules();
        if (fault === 'failure') api.applyTranscriptPresentation(document.querySelector('#transcript'), () => { throw Error('injected transcript crash'); });
        else if (fault === 'disable') await manager.enableExtension('sample.transcript', false);
        else if (fault === 'enable') await manager.enableExtension('sample.transcript', true);
        else if (fault === 'refresh') await manager.loadExtensions();
        else await manager.enterExtensionsSafeMode();
      }, faults[(index - 2) / 3]);
    }
    await expect(page.locator('#stream-region .live-text')).toContainText(chunks.join('').trim());
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toBeVisible();
    await page.evaluate(() => (window as any).__previewTranscriptFrame({ sessionId: 'session-1', kind: 'done', text: '' }));
    await expect(page.getByRole('button', { name: 'Stop task', exact: true })).toHaveCount(0);
    const after = await page.evaluate(() => (window as any).__previewTranscriptState());
    expect(after.task.resumeId).toBe(before.task.resumeId);
    expect(after.messages.slice(0, before.messages.length).map((row: any) => row.id)).toEqual(before.messages.map((row: any) => row.id));
    const replies = after.messages.slice(before.messages.length).filter((row: any) => row.role === 'assistant');
    expect(replies.map((row: any) => row.content)).toEqual([chunks.join('')]);
    const calls = await page.evaluate(() => (window as any).__extensionsBaseline.calls.map((call: any) => call.command));
    expect(calls.filter((command: string) => command === 'send_message')).toHaveLength(1);
    expect(calls.filter((command: string) => command === 'stop_session')).toHaveLength(0);
  });
});
