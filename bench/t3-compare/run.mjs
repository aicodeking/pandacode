// Runs W1 against PandaCode's and T3 Code's production builds in system Chrome and writes
// results/<date>.json and results/summary.md. See README.md. Env: T3CODE_DIR (required), RUNS (5).
import { spawn, execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { W1_TEXT, W1_DELTAS, W1_TIMES, SENTINEL } from './workload.mjs';
import { pandacodeSchedule, t3Schedule } from './schedule.mjs';

const here = fileURLToPath(new URL('.', import.meta.url));
const repo = fileURLToPath(new URL('../../', import.meta.url));
const { chromium } = createRequire(`${repo}package.json`)('@playwright/test');
const T3 = process.env.T3CODE_DIR;
if (!T3) throw new Error('Set T3CODE_DIR to the t3code checkout built by setup-t3.sh.');
const RUNS = Number(process.env.RUNS ?? 5);
const VIEWPORT = { width: 1440, height: 940 }, SCALE = 2, SETTLE_MS = 1000;
const sizes = W1_DELTAS.map(d => d.length);
const APPS = {
  pandacode: {
    port: Number(process.env.PC_PORT ?? 4173), cwd: repo, plan: pandacodeSchedule(W1_TIMES, sizes),
    serve: ['./node_modules/.bin/vite', 'preview', '--outDir', 'bench/t3-compare/.dist-pandacode'], path: '/',
    target: '.live-text',
    async open(page, base) {
      await page.goto(`${base}/`, { waitUntil: 'networkidle' });
      await page.locator('.task-item[data-id="session-1"]').click();
      await page.locator('#prompt[data-session-id="session-1"]').waitFor();
    },
  },
  t3: {
    port: Number(process.env.T3_PORT ?? 4174), cwd: `${T3}/apps/web`, plan: t3Schedule(W1_TIMES, sizes),
    serve: ['./node_modules/.bin/vp', 'preview', '--config', 'zbench/vite.bench.config.ts'], path: '/zbench/bench.html',
    target: '[data-message-id="live-assistant"]',
    async open(page, base) {
      await page.goto(`${base}/zbench/bench.html`, { waitUntil: 'networkidle' });
      await page.waitForFunction(() => window.__t3bench.ready(), null, { timeout: 30_000 });
      await page.waitForTimeout(1500);
      await page.evaluate(() => window.__t3bench.start());
    },
  },
};

const sh = (cmd, args, cwd) => execFileSync(cmd, args, { cwd, encoding: 'utf8' }).trim();
// The preview CLIs start their own child processes, so stop the whole group.
const stop = child => { try { process.kill(-child.pid); } catch {} };
async function serve(app) {
  const child = spawn(app.serve[0], [...app.serve.slice(1), '--host', '127.0.0.1', '--port', String(app.port), '--strictPort'],
    { cwd: app.cwd, stdio: 'ignore', detached: true, env: { ...process.env, NODE_ENV: 'production' } });
  const base = `http://127.0.0.1:${app.port}`;
  for (let i = 0; i < 100; i++) {
    if (child.exitCode !== null) throw new Error(`${app.serve.join(' ')} exited; is port ${app.port} free?`);
    if (await fetch(base + app.path).then(r => r.ok, () => false)) return { child, base };
    await new Promise(r => setTimeout(r, 200));
  }
  stop(child);
  throw new Error(`${app.serve.join(' ')} did not serve ${app.path} on ${base}`);
}

// In the page: deliver each planned event at its time, then wait for the frame showing the end.
async function replay({ text, plan, kind, target, sentinel, idle }) {
  const deliver = kind === 'pandacode'
    ? (from, end) => window.__previewEmit('agent-event', { sessionId: 'session-1', kind: 'text', text: text.slice(from, end) })
    : (_, end) => window.__t3bench.update(text.slice(0, end));
  const frame = () => new Promise(r => requestAnimationFrame(r));
  const t0 = performance.now();
  if (idle) { // baseline: the same span with nothing delivered
    await new Promise(r => setTimeout(r, plan.at(-1).at));
    return { wallMs: Math.round(performance.now() - t0) };
  }
  let from = 0, maxLateMs = 0;
  for (const { at, end } of plan) {
    const wait = t0 + at - performance.now();
    if (wait > 0) await new Promise(r => setTimeout(r, wait));
    maxLateMs = Math.max(maxLateMs, performance.now() - t0 - at);
    await deliver(from, end);
    from = end;
  }
  const last = performance.now();
  while (!document.querySelector(target)?.textContent.includes(sentinel)) {
    if (performance.now() - last > 30_000) throw new Error('final text never appeared');
    await frame();
  }
  await frame(); // runs after the frame that drew the final text was painted
  const fiberKey = el => Object.keys(el).find(k => k.startsWith('__reactFiber'));
  const fiberHost = [...document.querySelectorAll('body *')].find(fiberKey);
  return {
    wallMs: Math.round(performance.now() - t0), finalPaintMs: Math.round(performance.now() - last), maxLateMs: Math.round(maxLateMs),
    shownChars: document.querySelector(target).textContent.length,
    elements: Object.fromEntries(['pre', 'table', 'li', 'h2', 'blockquote', 'a'].map(tag => [tag, document.querySelector(target).querySelectorAll(tag).length])),
    reactDevBuild: fiberHost ? '_debugOwner' in fiberHost[fiberKey(fiberHost)] : null,
  };
}

async function measure(kind, base, idle) {
  const app = APPS[kind];
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  try {
    const page = await (await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE })).newPage();
    const errors = [];
    page.on('pageerror', e => errors.push(e.message));
    await app.open(page, base);
    await page.waitForTimeout(1000);
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Performance.enable');
    const metrics = async () => Object.fromEntries((await cdp.send('Performance.getMetrics')).metrics.map(m => [m.name, m.value]));
    const heap = async () => { await cdp.send('HeapProfiler.collectGarbage'); return (await cdp.send('Runtime.getHeapUsage')).usedSize / 2 ** 20; };
    await page.evaluate(() => {
      window.__mutations = 0;
      new MutationObserver(list => { window.__mutations += list.length; })
        .observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true });
    });
    const heapBeforeMB = await heap(), m0 = await metrics();
    const run = await page.evaluate(replay, { text: W1_TEXT, plan: app.plan, kind, target: app.target, sentinel: SENTINEL, idle });
    await page.waitForTimeout(SETTLE_MS);
    const m1 = await metrics(), heapAfterMB = await heap();
    const ms = key => Math.round((m1[key] - m0[key]) * 1000);
    return {
      app: kind, mode: idle ? 'idle' : 'w1', events: idle ? 0 : app.plan.length, ...run,
      taskMs: ms('TaskDuration'), scriptMs: ms('ScriptDuration'), layoutMs: ms('LayoutDuration'), styleMs: ms('RecalcStyleDuration'),
      otherMs: ms('TaskDuration') - ms('ScriptDuration') - ms('LayoutDuration') - ms('RecalcStyleDuration'),
      heapBeforeMB: +heapBeforeMB.toFixed(1), heapAfterMB: +heapAfterMB.toFixed(1),
      mutationRecords: await page.evaluate(() => window.__mutations), pageErrors: errors,
      chrome: browser.version(),
    };
  } finally {
    await browser.close();
  }
}

const servers = {};
try {
  for (const kind of Object.keys(APPS)) servers[kind] = await serve(APPS[kind]);
  const runs = [];
  // Alternate the order each round so drift (heat, background load) hits both apps alike.
  for (let i = 0; i < RUNS; i++) for (const kind of i % 2 ? ['t3', 'pandacode'] : ['pandacode', 't3']) for (const idle of [false, true]) {
    const result = await measure(kind, servers[kind].base, idle);
    if (!idle && result.shownChars < 40_000) throw new Error(`${kind}: only ${result.shownChars} characters shown`);
    console.log(i + 1, kind, result.mode, result.taskMs, 'ms task', result.wallMs, 'ms wall');
    runs.push({ run: i + 1, ...result });
  }
  const date = new Date().toLocaleDateString('sv'); // YYYY-MM-DD, local
  const meta = {
    date, workload: { bytes: W1_TEXT.length, deltas: W1_DELTAS.length, deltaMs: W1_TIMES[1], durationMs: W1_TIMES.at(-1) },
    machine: {
      model: sh('sysctl', ['-n', 'hw.model']), cpu: sh('sysctl', ['-n', 'machdep.cpu.brand_string']),
      ramGB: Number(sh('sysctl', ['-n', 'hw.memsize'])) / 2 ** 30, macos: sh('sw_vers', ['-productVersion']),
    },
    chrome: runs[0].chrome, runsPerAppAndMode: RUNS, viewport: VIEWPORT, deviceScaleFactor: SCALE, headless: true, settleMs: SETTLE_MS,
    pandacode: { commit: sh('git', ['rev-parse', 'HEAD'], repo), dirtySrc: sh('git', ['status', '--porcelain', '--', 'src'], repo) !== '' },
    t3code: { repo: 'https://github.com/pingdotgg/t3code', commit: sh('git', ['rev-parse', 'HEAD'], T3) },
  };
  mkdirSync(`${here}results`, { recursive: true });
  writeFileSync(`${here}results/${date}.json`, JSON.stringify({ ...meta, runs }, null, 1) + '\n');
  writeFileSync(`${here}results/summary.md`, summary(meta, runs));
  console.log(summary(meta, runs));
} finally {
  for (const { child } of Object.values(servers)) stop(child);
}

function summary(meta, runs) {
  const W1 = [['taskMs', 'Main-thread task time (ms)'], ['scriptMs', '  of which script (ms)'], ['layoutMs', '  of which layout (ms)'],
    ['styleMs', '  of which style recalc (ms)'],
    ['otherMs', '  other: HTML parsing, paint, GC… (ms)'], ['wallMs', 'Wall time (ms)'], ['finalPaintMs', 'Last delivery to final paint (ms)'],
    ['maxLateMs', 'Worst delivery lateness (ms)'], ['heapBeforeMB', 'JS heap before, after GC (MB)'], ['heapAfterMB', 'JS heap after, after GC (MB)'],
    ['mutationRecords', 'DOM mutation records'], ['events', 'Updates delivered to the UI']];
  const IDLE = [['taskMs', 'Main-thread task time (ms)'], ['scriptMs', '  of which script (ms)'], ['mutationRecords', 'DOM mutation records']];
  const values = (app, mode, key) => runs.filter(r => r.app === app && r.mode === mode).map(r => r[key]).sort((a, b) => a - b);
  const median = v => v.length % 2 ? v[v.length >> 1] : (v[v.length / 2 - 1] + v[v.length / 2]) / 2;
  const cell = v => `${+median(v).toFixed(1)} (${v[0]}–${v.at(-1)})`;
  const ratio = (p, t) => median(t) ? (median(p) / median(t)).toFixed(2) : '–';
  const table = (mode, keys) => '| Metric | PandaCode | T3 Code | Ratio |\n| --- | ---: | ---: | ---: |\n' + keys.map(([key, label]) => {
    const p = values('pandacode', mode, key), t = values('t3', mode, key);
    return `| ${label} | ${cell(p)} | ${cell(t)} | ${ratio(p, t)} |`;
  }).join('\n');
  const net = app => median(values(app, 'w1', 'taskMs')) - median(values(app, 'idle', 'taskMs'));
  const spread = (app, mode) => { const v = values(app, mode, 'taskMs'); return `${Math.round((v.at(-1) - v[0]) / median(v) * 100)}%`; };
  const n = runs.filter(r => r.app === 'pandacode' && r.mode === 'w1').length;
  return `# W1 results, ${meta.date}\n\n` +
    `${n} cold runs per app and mode, median (min–max). Ratio = PandaCode / T3 Code (below 1: PandaCode used less).\n\n` +
    `## W1: 50,000 B streamed as 2,000 × 25 B deltas over ${meta.workload.durationMs / 1000} s\n\n${table('w1', W1)}\n\n` +
    `## Idle baseline: same page state, same ${meta.workload.durationMs / 1000} s, nothing delivered\n\n${table('idle', IDLE)}\n\n` +
    `Streaming cost above idle (median W1 task time minus median idle task time): PandaCode ${Math.round(net('pandacode'))} ms, ` +
    `T3 Code ${Math.round(net('t3'))} ms (ratio ${(net('pandacode') / net('t3')).toFixed(2)}).\n\n` +
    `Spread of W1 task time, (max − min) / median: PandaCode ${spread('pandacode', 'w1')}, T3 Code ${spread('t3', 'w1')}.\n\n` +
    `Machine: ${meta.machine.model}, ${meta.machine.cpu}, ${meta.machine.ramGB} GB, macOS ${meta.machine.macos}. ` +
    `Chrome ${meta.chrome} (headless), ${meta.viewport.width}×${meta.viewport.height} at ${meta.deviceScaleFactor}x. ` +
    `PandaCode ${meta.pandacode.commit.slice(0, 7)}${meta.pandacode.dirtySrc ? ' (uncommitted src changes)' : ''}, ` +
    `T3 Code ${meta.t3code.commit.slice(0, 7)}. Raw numbers: ${meta.date}.json. Method: ../README.md.\n`;
}
