#!/usr/bin/env node
// Batch G1: the same agent (Claude Code, Sonnet) launched the way plain `claude -p`, T3 Code and
// PandaCode launch it. Dev-only. Method, pre-registration and commands: docs/gui-benchmark.md.
// `gui.mjs --t3-stub <tools.json>` is the stdio MCP server that stands in for T3 Code's own.
import { createHash } from 'node:crypto';
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RECALL_MARGIN, assertSanitized, loadRuns, nonInferior, simulateNonInferior } from './analyze.mjs';
import { REPO, WORK_ROOT, assertBuild, assertExplorable, claimRunner, cloneTarget, exploreClause, gradeEdit, isRust, materialize, measuredRun, must, pinDependencies, pinnedSeed, pool, readyExplore, register, repoDir, reportedCost, runClaude, safeEnv, seededJobs, stopChildrenOnSignal } from './lib.mjs';
import { gradeLocalization, metrics, parseEvents } from './metrics.mjs';
import { architectSources, findWorkerReport, unescapeRust, workerMessage } from './saver.mjs';
import { armFlag, logRatio, newLists, power, wilcoxonNormal } from './s3.mjs';
import { bootstrapCi, holm, mean, random } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
export const BASELINE = 'PLAIN';
/** Registered arms; PANDA_W (round 18's team worker launch) is optional and descriptive only. */
export const ARMS = ['PLAIN', 'T3', 'PANDA'];
export const OPTIONAL_ARMS = ['PANDA_W'];
export const SETS = ['loc', 'edit', 'edit2'];
/** Pooled edit-pass gate margin, from `--simulate` (docs/gui-benchmark.md, "Gates"). */
export const EDIT_PASS_MARGIN = -0.2;
const RUNNER_FILES = ['gui.mjs', 'lib.mjs', 'metrics.mjs', 'ledger.mjs', 'saver.mjs', 's3.mjs'];
// Billed mean per run: batch E's AFTER (loc, edit); edit2 assumed as edit (run.mjs ESTIMATE). T3 lists
// about 12k more tokens of tools and instructions, written once and read per step: +$0.10 assumed.
const ESTIMATE = { loc: 0.17, edit: 0.17, edit2: 0.17 };
const ARM_EXTRA = { PLAIN: 0, T3: 0.10, PANDA: 0.01, PANDA_W: 0 };
const STUB_TEXT = 'T3 Code is not connected in this benchmark run. Continue without T3 tools.';
/** Deviation G1-1: PANDA serves a real task's whole catalog (`bench_panda_host` in mcp_host/tests.rs). */
export const PANDA_SERVE_TEST = 'providers::mcp_host::tests::panda_catalog_mcp_serve';
const PANDA_DUMP_TEST = 'providers::mcp_host::tests::panda_catalog_dump';
/** Tools PANDA serves for real; the rest of its catalog answers with a stub error. */
export const PANDA_REAL = ['pandacode_explore', 'pandacode_tool_save', 'pandacode_track_files', 'pandacode_title'];
/** Tool count and UTF-8 bytes of a tools/list `tools` array, as JSON. */
export const catalogSize = tools => ({ tools: tools.length, bytes: Buffer.byteLength(JSON.stringify(tools)) });

/**
 * `has_mobile_project` in simulator/tools.rs: an iOS or Android project within 4 folders,
 * breadth-first, at most 2000 entries. It decides whether a real task lists the simulator tools.
 */
export function mobileProject(root) {
  const SKIP = ['node_modules', 'target', 'build', 'dist', 'Pods', 'vendor', 'DerivedData', 'out'];
  const read = (dir, file) => { try { return readFileSync(join(dir, file), 'utf8'); } catch { return ''; } };
  const marks = (dir, entry) => {
    const name = entry.name;
    if (name === 'ios' || name === 'android') return entry.isDirectory();
    if (name === 'Package.swift') return read(dir, name).includes('.iOS');
    if (name === 'app.json') return read(dir, name).includes('"expo"');
    if (name === 'build.gradle' || name === 'build.gradle.kts') return read(dir, name).includes('com.android');
    return name.endsWith('.xcodeproj') || name.endsWith('.xcworkspace');
  };
  const queue = [[root, 0]];
  let seen = 0;
  while (queue.length) {
    const [dir, depth] = queue.shift();
    let entries = [];
    try { entries = readdirSync(dir, { withFileTypes: true }); } catch { continue; }
    for (const entry of entries) {
      if (++seen > 2000) return false;
      if (marks(dir, entry)) return true;
      if (depth + 1 < 4 && !entry.name.startsWith('.') && !SKIP.includes(entry.name) && entry.isDirectory()) queue.push([join(dir, entry.name), depth + 1]);
    }
  }
  return false;
}

// ---------- Launch texts, read from the sources (gui.test.mjs) ----------

/** A Rust `const NAME: &str = "…"` or `r#"…"#` body, unescaped. */
export function rustConst(text, name) {
  const raw = text.match(new RegExp(`const ${name}: &str = r#"([\\s\\S]*?)"#;`));
  if (raw) return raw[1];
  const plain = text.match(new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`));
  if (!plain) throw new Error(`const ${name} not found`);
  return unescapeRust(plain[1]);
}
/** The string a Rust `fn name() -> &'static str { "…" }` returns. */
export function rustFnString(text, name) {
  const m = text.match(new RegExp(`fn ${name}\\(\\) -> &'static str \\{\\s*"((?:[^"\\\\]|\\\\.)*)"`));
  if (!m) throw new Error(`fn ${name} not found`);
  return unescapeRust(m[1]);
}

const read = path => readFileSync(join(REPO, path), 'utf8');
export const pandaSources = () => ({ appInstructions: read('src-tauri/src/app_instructions.rs'), titles: read('src-tauri/src/session_titles.rs'), run: read('src-tauri/src/run_script.rs'), changes: read('src-tauri/src/turn_changes/host.rs') });

/**
 * `app_instructions` in app_instructions.rs for Claude Code with explore on. A plain task (`worker`
 * false, not a chat, agent-made tools enabled: `tools: true`) gets titles, run script, change tracking,
 * TURN_ENDS, look(), REUSE and the three UI texts; a managed worker gets change tracking, TURN_ENDS, look().
 */
export function pandaInstructions(src, { worker = false } = {}) {
  const c = name => rustConst(src.appInstructions, name);
  const look = `${c('LOOK').replace('{explore}', 'pandacode_explore')}${c('EDIT_CLAUDE')}`;
  const changes = rustFnString(src.changes, 'instruction');
  if (worker) return [changes, c('TURN_ENDS'), look].join('');
  return [rustConst(src.titles, 'GUIDANCE'), rustConst(src.run, 'INSTRUCTIONS'), changes, c('TURN_ENDS'), look, c('REUSE'), c('RICH_QUESTIONS'), c('GENERATIVE_UI'), c('VISUAL_PROGRESS')].join('');
}

/** Flags every arm shares: the house harness setup (no user settings, permissions skipped, a cap). */
export const common = (model, cap) => ['--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', model, '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', String(cap)];

/**
 * T3 Code's flags from its query options, mapped as the Agent SDK's ProcessTransport maps them.
 * `--permission-prompt-tool stdio` (from canUseTool) is left out: nothing answers it headless, and
 * bypassPermissions never asks.
 */
export function t3Flags(options, cwd) {
  const out = [];
  if (options.thinking?.type === 'adaptive') out.push('--thinking=adaptive');
  if (options.thinking?.display) out.push(`--thinking-display=${options.thinking.display}`);
  if (options.effort) out.push(`--effort=${options.effort}`);
  if (options.tools?.type === 'preset') out.push('--tools=default');
  if (options.includePartialMessages) out.push('--include-partial-messages');
  for (const dir of options.additionalDirectories ?? []) out.push(`--add-dir=${dir === options.cwd ? cwd : dir}`);
  // extraArgs and settings both become flags; the SDK's settings value wins over an extraArgs one.
  const extra = { ...options.extraArgs, ...(options.settings ? { settings: JSON.stringify(options.settings) } : {}) };
  for (const [key, value] of Object.entries(extra)) if (key !== 'thinking-display' || !options.thinking?.display) out.push(`--${key}=${value}`);
  return out;
}

/**
 * The harness flags and environment of one arm. `mcp` is the MCP config JSON (or null), `texts` the
 * instruction texts from --prepare, `t3` the snapshot in tasks-gui.json.
 */
export function armLaunch(arm, { model, cap, cwd, mcp, texts, t3, worker = 'rw', lists }) {
  const base = common(model, cap);
  if (arm === 'PLAIN') return { argv: [...base, '--dangerously-skip-permissions', '--mcp-config', '{"mcpServers":{}}'], env: {} };
  if (arm === 'T3') {
    return {
      argv: [...base, ...t3Flags(t3.queryOptions, cwd), '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--mcp-config', mcp, '--append-system-prompt', t3.systemAppend],
      env: { CLAUDE_CODE_ENTRYPOINT: 'sdk-ts' },
    };
  }
  if (arm === 'PANDA') {
    // providers.rs configure_command for a Full access plain task.
    return { argv: [...base, '--include-partial-messages', '--replay-user-messages', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', '--disallowedTools=ScheduleWakeup,Monitor,CronCreate', '--mcp-config', mcp, '--append-system-prompt', texts.panda], env: {} };
  }
  if (arm === 'PANDA_W') {
    return { argv: [...base, '--include-partial-messages', '--replay-user-messages', '--permission-mode', 'bypassPermissions', '--allow-dangerously-skip-permissions', armFlag('NEW', worker, lists), '--mcp-config', mcp, '--append-system-prompt', texts.worker], env: {} };
  }
  throw new Error(`unknown arm ${arm}`);
}

/** The task's message per arm: a worker gets its brief's report sentence first, as the app sends it. */
export const armMessage = (arm, prompt, report) => (arm === 'PANDA_W' ? workerMessage(report, prompt, '') : prompt);

// ---------- T3 MCP stand-in ----------

/**
 * One JSON-RPC reply of the stand-in for T3 Code's MCP server: the snapshot's exact tool list
 * (names, descriptions, input schemas, `_meta`); every call answers with an error and no effect.
 */
export function t3StubReply(message, tools) {
  if (message.id === undefined) return null;
  const ok = result => ({ jsonrpc: '2.0', id: message.id, result });
  switch (message.method) {
    case 'initialize': return ok({ protocolVersion: message.params?.protocolVersion ?? '2025-06-18', capabilities: { tools: { listChanged: false } }, serverInfo: { name: 'T3 Code', version: 'bench' } });
    case 'tools/list': return ok({ tools });
    case 'tools/call': return ok({ content: [{ type: 'text', text: STUB_TEXT }], isError: true });
    case 'ping': return ok({});
    default: return { jsonrpc: '2.0', id: message.id, error: { code: -32601, message: `Method not found: ${message.method}` } };
  }
}

function serveStub(file, log) {
  const tools = JSON.parse(readFileSync(file, 'utf8'));
  createInterface({ input: process.stdin }).on('line', line => {
    let message;
    try { message = JSON.parse(line); } catch { return; }
    if (message.method === 'tools/call' && log) appendFileSync(log, `${JSON.stringify({ name: message.params?.name })}\n`);
    const reply = t3StubReply(message, tools);
    if (reply) process.stdout.write(`${JSON.stringify(reply)}\n`);
  });
}
const stubConfig = (toolsFile, log) => JSON.stringify({ mcpServers: { 't3-code': { type: 'stdio', command: process.execPath, args: [fileURLToPath(import.meta.url), '--t3-stub', toolsFile], env: { T3_STUB_LOG: log } } } });

// ---------- Tasks ----------

export function loadGui(dir = HERE) {
  const gui = JSON.parse(readFileSync(join(dir, 'tasks-gui.json'), 'utf8'));
  const base = JSON.parse(readFileSync(join(dir, 'tasks.json'), 'utf8'));
  const v2 = JSON.parse(readFileSync(join(dir, 'tasks-edit-v2.json'), 'utf8'));
  const tasks = [
    ...base.localization.filter(t => !t.tags?.includes('held-out')).map(t => ({ ...t, set: 'loc' })),
    ...base.edit.map(t => ({ ...t, set: 'edit' })),
    ...v2.edit.map(t => ({ ...t, set: 'edit2' })),
  ];
  return { gui, base, tasks, repos: { ...base.repos, ...v2.repos } };
}
export const promptOf = (task, base) => (task.set === 'loc' ? `${task.prompt}\n\n${base.localizationSuffix}` : task.prompt);
export const jobsFor = (tasks, seeds, arms, batchSeed) => seededJobs(tasks.flatMap(task => seeds.map(seed => ({ task, seed }))), () => arms, batchSeed);
export function plan(tasks, seeds, arms) {
  const jobs = jobsFor(tasks, seeds, arms, 1);
  const usd = jobs.reduce((sum, j) => sum + ESTIMATE[j.task.set] + ARM_EXTRA[j.arm], 0);
  return { tasks: tasks.length, bySet: Object.fromEntries(SETS.map(s => [s, tasks.filter(t => t.set === s).length])), seeds, arms, runs: jobs.length, byArm: Object.fromEntries(arms.map(a => [a, jobs.filter(j => j.arm === a).length])), estimateUsd: Number(usd.toFixed(2)) };
}

// ---------- Analysis (registered: prereg:G1) ----------

const MEASURES = {
  steps: r => r.steps ?? 0,
  billedUsd: r => r.billedUsd ?? r.costUsd ?? 0,
  wallMs: r => r.wallMs ?? 0,
  outputTokens: r => r.tokens?.output ?? 0,
  cacheReadTokens: r => r.tokens?.cacheRead ?? 0,
  cacheWriteTokens: r => r.tokens?.cacheWrite ?? 0,
  firstStepCacheWrite: r => r.firstStep?.cacheWrite ?? 0,
};
const byTask = (runs, arm, f) => {
  const map = new Map();
  for (const r of runs.filter(r => r.arm === arm)) { if (!map.has(r.task)) map.set(r.task, []); map.get(r.task).push(f(r)); }
  return map;
};
/** Per task, [mean PLAIN, mean arm] over seeds, for tasks both ran. */
export function pairs(runs, arm, f) {
  const a = byTask(runs, BASELINE, f), b = byTask(runs, arm, f);
  return [...a.keys()].filter(task => b.has(task)).sort().map(task => [mean(a.get(task)), mean(b.get(task))]);
}
/** Ratio of means (mean arm / mean PLAIN − 1) and the absolute difference, each with a 95% bootstrap CI over tasks. */
export function ratioOfMeans(list, { rounds = 20_000, seed = 0x2545f491 } = {}) {
  if (!list.length) return null;
  const stat = l => { const a = mean(l.map(p => p[0])), b = mean(l.map(p => p[1])); return [b / a - 1, b - a]; };
  const next = random(seed);
  const draws = Array.from({ length: rounds }, () => stat(Array.from(list, () => list[Math.floor(next() * list.length)])));
  const ci = k => { const s = draws.map(d => d[k]).sort((x, y) => x - y); return [s[Math.floor(rounds * 0.025)], s[Math.floor(rounds * 0.975)]]; };
  const [ratio, diff] = stat(list);
  return { plain: mean(list.map(p => p[0])), arm: mean(list.map(p => p[1])), ratioOfMeans: ratio, ratioCi: ci(0), absolute: diff, absoluteCi: ci(1) };
}
const verdict = (t, p) => (p < 0.05 && (t.ci[1] < 0 || t.ci[0] > 0) ? (t.change < 0 ? 'lower' : 'higher') : t.change < 0 ? 'not shown to be lower' : 'not shown to be higher');

/**
 * Primary: steps and billed cost of T3 and PANDA against PLAIN, per task d = log(mean arm / mean
 * PLAIN), two-sided Wilcoxon and 95% bootstrap CI of mean d, Holm over the four tests. Gates per arm:
 * recall and precision (loc, margin −0.05), edit pass pooled over edit and edit2 (EDIT_PASS_MARGIN).
 * PANDA_W and everything else are descriptive.
 */
export function analyze(runs) {
  const arms = [...ARMS.slice(1), ...OPTIONAL_ARMS].filter(arm => runs.some(r => r.arm === arm));
  const out = { runs: runs.length, arms: {} };
  const primary = [];
  for (const arm of arms) {
    const table = {};
    for (const [name, f] of Object.entries(MEASURES)) {
      const list = pairs(runs, arm, f);
      const t = logRatio(list);
      table[name] = t && { ...t, ...ratioOfMeans(list), read: 'descriptive' };
      if (t && ARMS.includes(arm) && (name === 'steps' || name === 'billedUsd')) primary.push([arm, name]);
    }
    const bySet = Object.fromEntries(SETS.map(set => [set, Object.fromEntries(['steps', 'billedUsd'].map(name => [name, logRatio(pairs(runs.filter(r => r.set === set), arm, MEASURES[name]))]))]));
    const loc = runs.filter(r => r.set === 'loc');
    const edits = runs.filter(r => r.set === 'edit' || r.set === 'edit2');
    const gates = {
      recall: nonInferior(loc, BASELINE, arm, r => r.grade?.recall ?? 0, RECALL_MARGIN),
      precision: nonInferior(loc, BASELINE, arm, r => r.grade?.precision ?? 0, RECALL_MARGIN),
      editPass: nonInferior(edits, BASELINE, arm, r => (r.success ? 1 : 0), EDIT_PASS_MARGIN),
    };
    if (!ARMS.includes(arm)) for (const g of Object.values(gates)) if (g) delete g.pass;
    const t3Calls = runs.filter(r => r.arm === arm).map(r => r.t3Calls ?? 0);
    out.arms[arm] = { registered: ARMS.includes(arm), table, bySet, gates, t3CallsPerRun: mean(t3Calls), pandaStubCallsPerRun: mean(runs.filter(r => r.arm === arm).map(r => r.pandaStubCalls ?? 0)), toolsListed: [...new Set(runs.filter(r => r.arm === arm).map(r => r.init?.tools?.length))] };
  }
  const adjusted = holm(primary.map(([arm, name]) => out.arms[arm].table[name].p));
  primary.forEach(([arm, name], i) => Object.assign(out.arms[arm].table[name], { pHolm: adjusted[i], read: verdict(out.arms[arm].table[name], adjusted[i]) }));
  return out;
}

// ---------- Power and gate calibration (no model time) ----------

const HISTORY = ['v5-E.csv', 'v5-E2.csv', 'v6-Fv2.csv'].map(name => join(HERE, 'results', 'runs', name));
/** Per task, BEFORE's values (no MCP, no instruction: the arm closest to PLAIN) from E, E2 and Fv2. */
export function beforeByTask(runs, sets, get) {
  const mine = runs.filter(r => r.arm === 'before' && sets.includes(r.set) && !r.tags?.includes('held-out'));
  return [...new Set(mine.map(r => r.task))].sort().map(task => mine.filter(r => r.task === task).map(get).filter(x => x != null));
}
/**
 * Power of each primary test (Holm over four, bounded by Bonferroni: p × 4 < 0.05) for a true change
 * of `effect` on every task, and every gate's pass rate with no effect and with a true loss of 0.10.
 */
export function calibrate({ seeds = 2, reps = 400, files = HISTORY } = {}) {
  const runs = loadRuns(files, 'sonnet');
  const units = 40;
  const bonferroni = d => Math.min(1, wilcoxonNormal(d) * 4);
  const pw = (values, effect, spread) => power(values.filter(l => l.length && l.every(x => x > 0)), { effect, seeds, units, reps, spread, test: bonferroni });
  const steps = beforeByTask(runs, ['loc', 'edit', 'edit2'], r => r.steps);
  const cost = beforeByTask(runs, ['loc', 'edit', 'edit2'], r => r.costUsd);
  const powerRows = Object.fromEntries([['steps', steps], ['billedUsd', cost]].map(([name, values]) => [name, Object.fromEntries([0.05, 0.15].map(spread => [`spread ${spread}`, Object.fromEntries([0, -0.1, -0.15, -0.2].map(e => [e, pw(values, e, spread)]))]))]));
  const gates = [
    ['recall', beforeByTask(runs, ['loc'], r => r.grade?.recall ?? 0), 'score', RECALL_MARGIN],
    ['precision', beforeByTask(runs, ['loc'], r => r.grade?.precision ?? 0), 'score', RECALL_MARGIN],
    ...[-0.05, -0.1, -0.15, -0.2].map(m => [`edit pass pooled, margin ${m}`, beforeByTask(runs, ['edit', 'edit2'], r => (r.success ? 1 : 0)), 'rate', m]),
  ].map(([gate, values, kind, margin]) => ({ gate, tasks: values.length, margin, noEffect: simulateNonInferior({ values, kind, margin, seeds, reps: reps * 2 }), trueLoss10: simulateNonInferior({ values, kind, margin, seeds, effect: -0.1, reps: reps * 2 }) }));
  return { seeds, units, reps, history: files.map(f => basename(f)), test: 'normal-approximation Wilcoxon × 4 (Bonferroni bound on Holm), CI 2000 rounds', power: powerRows, gates };
}

// ---------- Runner ----------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const { values: args } = isMain ? parseArgs({ options: {
  't3-stub': { type: 'string' },
  out: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/gui') },
  from: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2') },
  snapshot: { type: 'string', default: 'bin-g' },
  batch: { type: 'string', default: 'G1' },
  'batch-seed': { type: 'string' },
  arm: { type: 'string', default: ARMS.join(',') },
  set: { type: 'string', default: SETS.join(',') },
  tasks: { type: 'string' },
  seeds: { type: 'string', default: '1,2,3' },
  concurrency: { type: 'string', default: '4' },
  'min-free-gib': { type: 'string', default: '6' },
  'run-cap-usd': { type: 'string', default: '3' },
  'run-timeout-min': { type: 'string', default: '25' },
  'total-budget-usd': { type: 'string', default: '150' },
  prepare: { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
  analyze: { type: 'boolean', default: false },
  simulate: { type: 'boolean', default: false },
  register: { type: 'boolean', default: false },
  summary: { type: 'string' },
  csv: { type: 'string' },
  force: { type: 'boolean', default: false },
} }) : { values: {} };

const OUT = args.out;
const FROM = args.from;
const PIDS = OUT && join(OUT, 'pids.json');
const LEDGER = OUT && join(OUT, 'ledger.jsonl');
const META = OUT && join(OUT, 'meta.json');
const WORK = OUT && join(WORK_ROOT, `gui-${sha(OUT).slice(0, 8)}`);
const RUNNER_HASH = isMain ? sha(RUNNER_FILES.map(file => readFileSync(join(HERE, file), 'utf8')).join('\0')) : null;

/** Texts and pins the batch runs with, from the live tree; --batch refuses if any changed since. */
function liveTexts(gui) {
  const src = pandaSources();
  const panda = pandaInstructions(src);
  const worker = pandaInstructions(src, { worker: true });
  const report = findWorkerReport(architectSources());
  if (!report) throw new Error('no report sentence in the worker rules');
  if (!worker.includes(exploreClause())) throw new Error('the worker text does not carry exploreClause()');
  return { panda, worker, report: report.text, lists: newLists(), t3Append: gui.t3.systemAppend, t3Tools: gui.t3.tools };
}
const textHashes = texts => Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, sha(typeof v === 'string' ? v : JSON.stringify(v))]));

async function prepare(gui) {
  const harness = join(FROM, 'harness', 'claude');
  if (!existsSync(harness)) throw new Error(`no pinned harness in ${FROM}; run run.mjs --prepare first`);
  const snap = join(FROM, args.snapshot, 'meta.json');
  if (!existsSync(snap)) throw new Error(`no explore snapshot ${args.snapshot}: run run.mjs --prepare --edit-v2 --snapshot ${args.snapshot} first`);
  const server = JSON.parse(readFileSync(snap, 'utf8'));
  const texts = liveTexts(gui);
  mkdirSync(OUT, { recursive: true });
  writeFileSync(join(OUT, 't3-tools.json'), JSON.stringify(gui.t3.tools));
  const catalogFile = join(OUT, 'panda-tools.json');
  await must(join(FROM, args.snapshot, 'explore-serve'), [PANDA_DUMP_TEST, '--exact', '--ignored'], { env: safeEnv({ PANDACODE_BENCH_CATALOG: catalogFile }) });
  const catalog = JSON.parse(readFileSync(catalogFile, 'utf8'));
  const meta = {
    harness: (await must(harness, ['--version'], { env: safeEnv() })).trim(), snapshot: args.snapshot, exploreBinary: server.binaryHash, build: server.build ?? null,
    texts, hashes: textHashes(texts), catalogs: { T3: catalogSize(gui.t3.tools), PANDA: catalogSize(catalog.plain), PANDA_mobile: catalogSize(catalog.mobile), pandaNames: catalog.mobile.map(t => t.name) }, tasksGui: sha(readFileSync(join(HERE, 'tasks-gui.json'))), preparedAt: new Date().toISOString(),
  };
  writeFileSync(META, JSON.stringify(meta, null, 1));
  console.log(JSON.stringify({ ...meta, texts: Object.fromEntries(Object.entries(texts).map(([k, v]) => [k, typeof v === 'string' ? v.length : JSON.stringify(v).length])) }, null, 1));
}

async function loadMeta(gui) {
  if (!existsSync(META)) throw new Error('run gui.mjs --prepare first');
  const meta = JSON.parse(readFileSync(META, 'utf8'));
  const now = textHashes(liveTexts(gui));
  for (const [key, value] of Object.entries(meta.hashes)) if (now[key] !== value) throw new Error(`${key} changed since --prepare: rerun --prepare and use a new batch name`);
  if (meta.tasksGui !== sha(readFileSync(join(HERE, 'tasks-gui.json')))) throw new Error('tasks-gui.json changed since --prepare');
  const server = join(FROM, meta.snapshot, 'explore-serve');
  if (sha(readFileSync(server)) !== meta.exploreBinary) throw new Error(`explore snapshot ${meta.snapshot} changed since --prepare`);
  const live = (await must('claude', ['--version'], { env: safeEnv() })).trim();
  if (live !== meta.harness) throw new Error(`harness is ${live}, prepared with ${meta.harness}`);
  return { meta, server };
}

async function checkout(task, work, repos, build) {
  const gitDir = repoDir(task.repo, FROM);
  const parent = (await must('git', ['-C', gitDir, 'rev-parse', `${task.commit}^`])).trim();
  const edit = task.set !== 'loc';
  const rust = edit && isRust(task);
  const removed = await materialize(gitDir, parent, work, { nodeModules: edit && gitDir === REPO, prepare: rust ? tree => pinDependencies(tree, build?.dir) : null });
  for (const path of repos[task.repo]?.prune ?? []) rmSync(join(work, path), { recursive: true, force: true });
  const target = rust ? join(dirname(work), 'target') : null;
  if (target) { assertBuild(build); await cloneTarget(target, build?.target); }
  return { gitDir, removed, target };
}

/** G1-2/G1-3: stop on service denial or missing measurements; keep ordinary measured failures. */
export function runBlocker(record, text) {
  if (record.invalid) return record.invalid;
  const events = parseEvents(text);
  const errors = events.filter(e => (e.type === 'result' && e.is_error) || e.error).map(e => [e.subtype, e.errors, typeof e.error === 'string' ? e.error : [e.error?.type, e.error?.code, e.error?.message]]);
  if (/quota|rate.?limit|usage.?limit|hit your limit|out of extra usage|insufficient.*credit|credit balance/i.test(JSON.stringify(errors))) return 'quota or rate limit';
  const final = events.filter(e => e.type === 'result').at(-1)?.result ?? record.answer ?? '';
  if (/^(?:(?:you['’]ve|you have) hit your (?:usage )?limit(?:\s*·|[.!]?$)|API Error:\s*(?:401|403|429)\b)/i.test(final.trim())) return 'quota or rate limit';
  if (!Number.isFinite(record.billedUsd) || record.billedUsd <= 0) return 'missing or zero billing';
  if (!(record.tokens?.output > 0) || !(record.steps > 0)) return 'empty model output';
  return null;
}

async function oneRun(job, batchDir, ctx) {
  const { task, arm, seed } = job;
  const { meta, gui, base } = ctx;
  const id = `${task.set}__${task.id}__s${seed}__${arm}`;
  const runDir = join(batchDir, id);
  const prompt = promptOf(task, base);
  const message = armMessage(arm, prompt, meta.texts.report);
  const model = gui.model;
  const cap = Number(args['run-cap-usd']);
  const record = { id, set: task.set, task: task.id, arm, seed, model, group: job.group, armOrder: job.order, startedAt: new Date().toISOString(), repo: task.repo ?? 'pandacode', gold: task.gold, hashes: { message: sha(message), ...meta.hashes, explore: meta.exploreBinary, runner: RUNNER_HASH } };
  const result = await measuredRun({
    runDir, ledger: LEDGER, workRoot: WORK, batch: basename(batchDir), id, capUsd: cap, record, force: args.force,
    body: async (work, held) => {
      const { gitDir, removed, target } = await checkout(task, work, ctx.repos, meta.build);
      record.agentFilesRemoved = removed;
      let mcp = null;
      const stubLog = join(runDir, 't3-calls.jsonl');
      if (arm === 'T3') mcp = stubConfig(join(OUT, 't3-tools.json'), stubLog);
      if (arm === 'PANDA' || arm === 'PANDA_W') {
        // PANDA (deviation G1-1): a real task's catalog, explore and the agent-made tools (empty store) real.
        const store = join(dirname(work), 'tools');
        if (arm === 'PANDA') record.mobile = mobileProject(work);
        const tools = arm === 'PANDA' ? { test: PANDA_SERVE_TEST, env: { PANDACODE_BENCH_TOOLS: store, PANDACODE_BENCH_PROJECT: 'bench-g1', PANDACODE_BENCH_SESSION: id, PANDACODE_BENCH_NOTE: join(runDir, 'note.txt'), PANDACODE_BENCH_MOBILE: record.mobile ? '1' : '0' } } : undefined;
        if (tools) mkdirSync(store, { recursive: true });
        const explore = await readyExplore(ctx.server, work, runDir, PIDS, tools);
        held.server = explore.server;
        mcp = readFileSync(explore.config, 'utf8');
      }
      const launch = armLaunch(arm, { model, cap, cwd: work, mcp, texts: meta.texts, t3: gui.t3, worker: task.set === 'loc' ? 'ro' : 'rw', lists: meta.texts.lists });
      const stream = join(runDir, 'stream.jsonl');
      const env = { ...launch.env, ...(target ? { CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' } : {}) };
      const run = await runClaude([message], work, stream, launch.argv, Number(args['run-timeout-min']) * 60_000, env, PIDS);
      const text = readFileSync(stream, 'utf8');
      const { stepText, stepUsage, ...metric } = metrics(text);
      Object.assign(record, { wallMs: run.wallMs, exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr, billedUsd: reportedCost(text) ?? 0, ...metric });
      record.t3Calls = existsSync(stubLog) ? readFileSync(stubLog, 'utf8').split('\n').filter(Boolean).length : 0;
      if (arm === 'PANDA') record.pandaStubCalls = pandaStubCalls(text);
      const pinned = base.harness.models[model];
      if (record.init?.model && record.init.model !== pinned) ctx.aborted = `model resolved to ${record.init.model}, pinned ${pinned}`;
      if (record.init?.version && record.init.version !== base.harness.version) ctx.aborted = `harness is ${record.init.version}, pinned ${base.harness.version}`;
      if (arm === 'T3' && !record.init?.mcp?.some(s => s.name === 't3-code' && s.status === 'connected')) ctx.aborted = `${id}: the t3-code stand-in did not connect`;
      if (arm === 'PANDA' && !record.init?.mcp?.some(s => s.name === 'pandacode_architect' && s.status === 'connected')) ctx.aborted = `${id}: the PandaCode catalog server did not connect`;
      const blocker = runBlocker(record, text);
      if (blocker) {
        Object.assign(record, { invalid: blocker, success: false });
        ctx.aborted ??= `${id}: ${blocker}`;
        return;
      }
      if (task.set === 'loc') {
        record.grade = gradeLocalization({ ...metric, stepText }, task.gold);
        record.success = record.grade.answered && !run.timedOut && !metric.isError;
      } else {
        record.grade = await gradeEdit(task, work, target, ctx.verified, gitDir);
        record.success = record.grade.pass && !run.timedOut && !metric.isError && run.code === 0;
      }
    },
  });
  const blocker = !result.skipped && runBlocker(result, '');
  if (blocker) ctx.aborted ??= `${id}: ${blocker}`;
  return result;
}

/** Every run, off-model ones too (`model` says which), without paths or transcripts. */
export function runsCsv(runs) {
  const cols = { id: r => r.id, set: r => r.set, task: r => r.task, arm: r => r.arm, seed: r => r.seed, model: r => r.init?.model, steps: r => r.steps, billedUsd: r => r.billedUsd, wallMs: r => r.wallMs, input: r => r.tokens?.input, cacheRead: r => r.tokens?.cacheRead, cacheWrite: r => r.tokens?.cacheWrite, output: r => r.tokens?.output, firstWrite: r => r.firstStep?.cacheWrite, tools: r => r.init?.tools?.length, mobile: r => r.mobile, t3Calls: r => r.t3Calls, pandaStubCalls: r => r.pandaStubCalls, explore: r => r.tools?.explore, recall: r => r.grade?.recall, precision: r => r.grade?.precision, success: r => r.success, timedOut: r => r.timedOut };
  const rows = [...runs].sort((a, b) => a.id.localeCompare(b.id)).map(r => Object.values(cols).map(f => f(r) ?? '').join(','));
  return `${Object.keys(cols).join(',')}\n${rows.join('\n')}\n`;
}

/** PANDA's calls to its stubbed tools (anything but PANDA_REAL), from the transcript's tool_use blocks. */
export const pandaStubCalls = text => new Set([...text.matchAll(/"type":"tool_use","id":"([^"]*)","name":"mcp__pandacode_architect__(pandacode_[a-z_]+)"/g)].filter(m => !PANDA_REAL.includes(m[2])).map(m => m[1])).size;

const readRuns = dir => readdirSync(dir).filter(name => existsSync(join(dir, name, 'run.json'))).map(name => JSON.parse(readFileSync(join(dir, name, 'run.json'), 'utf8')));

async function main() {
  if (args['t3-stub']) return serveStub(args['t3-stub'], process.env.T3_STUB_LOG);
  const { gui, base, tasks: all, repos } = loadGui();
  const sets = args.set.split(',');
  const tasks = all.filter(t => sets.includes(t.set) && (!args.tasks || args.tasks.split(',').includes(t.id)));
  const seeds = args.smoke ? [99] : args.seeds.split(',').map(Number);
  const arms = args.arm.split(',');
  if (arms.some(arm => ![...ARMS, ...OPTIONAL_ARMS].includes(arm))) throw new Error(`arms are ${[...ARMS, ...OPTIONAL_ARMS].join(',')}`);
  const batchDir = join(OUT, 'runs', args.smoke ? `smoke-${args.batch}` : args.batch);
  if (args.plan) return console.log(JSON.stringify({ batch: args.batch, ...plan(tasks, seeds, arms), withWorkerArm: plan(tasks, seeds, [...arms.filter(a => a !== 'PANDA_W'), 'PANDA_W']).estimateUsd }, null, 1));
  if (args.simulate) return console.log(JSON.stringify(calibrate({ seeds: seeds.length }), null, 1));
  if (args.register) return console.log(JSON.stringify(register({ batch: args.batch, doc: 'docs/gui-benchmark.md', pins: ['tasks-gui.json', 'tasks.json', 'tasks-edit-v2.json', 'gui.mjs'] })));
  if (args.analyze) {
    const all = readRuns(batchDir);
    const invalid = all.filter(r => runBlocker(r, '') !== null);
    if (invalid.length) throw new Error(`${invalid.length} invalid harness attempts: preserve raw records and report the incomplete batch; do not analyze them as performance results`);
    const kept = all.filter(r => r.init?.model === base.harness.models[gui.model]);
    const summary = { ...analyze(kept), excludedOffModel: all.filter(r => !kept.includes(r)).map(r => r.id) };
    if (args.summary) writeFileSync(args.summary, `${assertSanitized(JSON.stringify(summary, null, 1))}\n`);
    if (args.csv) writeFileSync(args.csv, assertSanitized(runsCsv(all)));
    return console.log(JSON.stringify(summary, null, 1));
  }
  mkdirSync(OUT, { recursive: true });
  process.env.PATH = `${join(FROM, 'harness')}:${process.env.PATH}`;
  assertExplorable(WORK);
  stopChildrenOnSignal();
  if (args.prepare) return prepare(gui);
  if (!(Number(args['min-free-gib']) >= 6)) throw new Error('--min-free-gib may not go below 6 with edits: other tasks share this disk');
  const { meta, server } = await loadMeta(gui);
  const verified = JSON.parse(readFileSync(join(FROM, 'sanity.json'), 'utf8'));
  const runnable = tasks.filter(t => t.set === 'loc' || verified[t.id]?.verdict === 'ok');
  if (runnable.length !== tasks.length) throw new Error(`edit tasks not sanity-checked ok: ${tasks.filter(t => !runnable.includes(t)).map(t => t.id).join(',')}`);
  claimRunner({ out: OUT, pids: PIDS, ledger: LEDGER, work: WORK });
  mkdirSync(batchDir, { recursive: true });
  const pins = { harness: meta.harness, exploreBinary: meta.exploreBinary, tasksGui: meta.tasksGui, tasks: sha(readFileSync(join(HERE, 'tasks.json'))), tasksEditV2: sha(readFileSync(join(HERE, 'tasks-edit-v2.json'))), ...meta.hashes, depsSha256: meta.build?.deps?.sha256 };
  const batchSeed = args.smoke ? 99 : pinnedSeed(join(batchDir, 'batch.json'), pins, RUNNER_HASH, args['batch-seed']);
  const ctx = { meta, gui, base, repos, server, verified, aborted: null };
  await pool(jobsFor(tasks, seeds, arms, batchSeed), {
    limit: Number(args.concurrency), batchDir, out: OUT, ledger: LEDGER, minFreeGiB: Number(args['min-free-gib']), budget: Number(args['total-budget-usd']),
    cap: () => Number(args['run-cap-usd']), diskNeed: job => (job.task.set !== 'loc' && isRust(job.task) ? 1.5 : job.task.repo === 'vscode' ? 0.5 : 0.2),
    writes: job => job.task.set !== 'loc' && isRust(job.task),
    runOne: job => oneRun(job, batchDir, ctx), aborted: () => ctx.aborted,
    name: j => `${j.task.set}/${j.task.id}/s${j.seed}/${j.arm}`,
    log: (r, { spentUsd, next, total }) => console.log(`${new Date().toISOString().slice(11, 19)} ${r.id} ok=${r.success} steps=${r.steps} tools=${r.init?.tools?.length} t3=${r.t3Calls} $${r.billedUsd?.toFixed(3)} spent=$${spentUsd.toFixed(2)} ${next}/${total}`),
  });
}

if (isMain) await main();
