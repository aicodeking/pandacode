import { test as base } from '@playwright/test';
import { cpus, freemem } from 'node:os';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { writeFile } from 'node:fs/promises';

// Opt-in observations, never readiness waits, retries, cache warming or changed test budgets.
// Server timings come from the ignored review-only Vite configuration, not product code.
export const test = base.extend<{ phaseEvidence: void }>({
  phaseEvidence: [async ({ page, browserName }, use, info) => {
    if (!process.env.PANDACODE_PHASES || browserName !== 'chromium') { await use(); return; }
    const started = Date.now();
    const cpuStart = cpus();
    const loop = monitorEventLoopDelay({ resolution: 20 });
    loop.enable();
    const utilization = performance.eventLoopUtilization();
    const events: unknown[] = [];
    const record = (kind: string, data: unknown) => {
      if (events.length < 12000) events.push({ at: Date.now() - started, kind, data });
    };
    const session = await page.context().newCDPSession(page);
    await session.send('Network.enable');
    await session.send('Performance.enable');
    session.on('Network.requestWillBeSent', event => record('request', { id: event.requestId, url: event.request.url, timestamp: event.timestamp, wallTime: event.wallTime, type: event.type }));
    session.on('Network.responseReceived', event => record('response', { id: event.requestId, url: event.response.url, status: event.response.status, timing: event.response.timing, headers: event.response.headers }));
    session.on('Network.loadingFinished', event => record('finished', { id: event.requestId, timestamp: event.timestamp, bytes: event.encodedDataLength }));
    session.on('Network.loadingFailed', event => record('failed', { id: event.requestId, error: event.errorText, canceled: event.canceled }));
    page.on('pageerror', error => record('pageerror', error.message));
    page.on('domcontentloaded', () => record('domcontentloaded', page.url()));
    await page.addInitScript(() => {
      const data: unknown[] = [];
      (window as any).__browserPhases = data;
      const record = (kind: string, value: unknown) => { if (data.length < 2000) data.push({ at: performance.now(), kind, value }); };
      new PerformanceObserver(list => {
        for (const entry of list.getEntries()) record('longtask', { start: entry.startTime, duration: entry.duration });
      }).observe({ type: 'longtask', buffered: true });
      const selectors = ['#prompt:not(:disabled)', '.import-sources', 'input[aria-label="Browser URL"]', '.xterm-screen', '.settings-nav'];
      const seen = new Set<string>();
      const observer = new MutationObserver(() => {
        for (const selector of selectors) if (!seen.has(selector) && document.querySelector(selector)) {
          seen.add(selector); record('mounted', selector);
        }
        if (seen.size === selectors.length) observer.disconnect();
      });
      observer.observe(document, { subtree: true, childList: true, attributes: true, attributeFilter: ['disabled'] });
    });
    try { await use(); } finally {
      loop.disable();
      const cpuEnd = cpus();
      const cpu = cpuEnd.map((end, index) => {
        const start = cpuStart[index]?.times ?? end.times;
        const total = Object.keys(start).reduce((sum, key) => sum + end.times[key as keyof typeof start] - start[key as keyof typeof start], 0);
        return total ? 1 - (end.times.idle - start.idle) / total : 0;
      });
      // Teardown collection is bounded and outside every existing assertion's timing boundary.
      let timer: ReturnType<typeof setTimeout> | undefined;
      const browser = await Promise.race([
        page.evaluate(() => ({ phases: (window as any).__browserPhases, resources: performance.getEntriesByType('resource').map(entry => entry.toJSON()) })).catch(error => ({ unavailable: String(error) })),
        new Promise(resolve => { timer = setTimeout(() => resolve({ unavailable: 'bounded teardown collection expired' }), 1000); }),
      ]);
      clearTimeout(timer);
      const metrics = await session.send('Performance.getMetrics').catch(() => null);
      await session.detach();
      const path = info.outputPath('browser-phases.json');
      await writeFile(path, JSON.stringify({ version: 1, title: info.title, status: info.status, elapsedMs: Date.now() - started, freeMemoryBytes: freemem(), cpuBusyFraction: cpu.reduce((a, b) => a + b, 0) / cpu.length, driverLoop: { maxMs: loop.max / 1e6, p99Ms: loop.percentile(99) / 1e6, utilization: performance.eventLoopUtilization(utilization) }, events, browser, metrics }));
      await info.attach('browser-phases', { contentType: 'application/json', path });
    }
  }, { auto: true }],
});
