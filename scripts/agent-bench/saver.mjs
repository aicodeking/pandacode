#!/usr/bin/env node
// Token saver benchmark: what the lead's choice of saver packs saves on worker runs. Dev-only.
// Method and pre-registration: docs/token-saver-benchmark.md.
import { createHash, randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';
import { appendLedger, ledgerTotals, readLedger, writeAtomic } from './ledger.mjs';
import { REPO, WORK_ROOT, applyFix, applyStub, assertBuild, assertExplorable, claimRunner, cloneTarget, exploreClause, gradeEdit, harnessArgs, isRust, materialize, measuredRun, must, overlayTests, pinDependencies, pinnedSeed, pool, readyExplore, repoDir, runClaude, safeEnv, seededJobs, stopChildrenOnSignal } from './lib.mjs';
import { fieldUsd, gradeLocalization, metrics, scoreRubric } from './metrics.mjs';
import { bootstrapCi, mean, random } from './stats.mjs';
export { fieldUsd };

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
// ALL (every pack) was dropped in S1v2: one seed made it descriptive only. S1v3 runs 5 seeds per arm.
export const ARMS = ['NONE', 'CHOSEN'];
export const PACK_IDS = ['caveman', 'lean-code', 'quiet-tools', 'rtk'];
export const LEVELS = ['lite', 'full', 'ultra'];
const RUNNER_FILES = ['saver.mjs', 'lib.mjs', 'metrics.mjs', 'ledger.mjs'];
// Billed means per run: loc and edit from batch E's AFTER arm, report and selector from the S1 smoke tests.
const ESTIMATE = { loc: 0.17, edit: 0.17, report: 0.20, selector: 0.015 };
// The worker brief's default result summary limit (`summaryLimit` in src/architect.ts).
export const SUMMARY_LIMIT = 3072;

// ---------- Pure parts (saver.test.mjs) ----------

/** Rust string literal body → text: `\` line continuations, \n, \t, \", \\. Raw strings pass through. */
export function unescapeRust(body, raw = false) {
  if (raw) return body;
  return body.replace(/\\\r?\n\s*/g, '').replace(/\\(["\\nt'])/g, (_, c) => ({ n: '\n', t: '\t' }[c] ?? c));
}

const LITERAL = /"((?:[^"\\]|\\.)*)"/y;
/** The Rust string literal that starts at `at` (the opening quote), unescaped. */
const literalAt = (text, at) => { LITERAL.lastIndex = at; const m = LITERAL.exec(text); return m ? unescapeRust(m[1]) : null; };

/**
 * The lead's token saver guidance as shipped in the architect's dispatch tool: the description from
 * `tokenSaver:` onward, plus the parameter's own description (`token_saver_schema`) when it exists.
 */
export function findLeadGuidance(files) {
  let found = null;
  for (const { path, text } of files) {
    const at = text.indexOf('"Start assignments');
    const description = at >= 0 ? literalAt(text, at) : null;
    if (description?.includes('tokenSaver:')) { found = { path, sentence: description.slice(description.indexOf('tokenSaver:')) }; break; }
  }
  if (!found) return null;
  let schema = null;
  for (const { path, text } of files) {
    const fn = text.indexOf('fn token_saver_schema');
    if (fn < 0) continue;
    const key = text.slice(fn).search(/"description"\s*:\s*"/);
    if (key < 0) continue;
    const quote = text.indexOf('"', text.indexOf(':', fn + key));
    schema = { path, text: literalAt(text, quote) };
    break;
  }
  return schema
    ? { source: `${found.path}: dispatch_tool description; ${schema.path}: token_saver_schema`, text: `${found.sentence}\ntokenSaver parameter: ${schema.text}` }
    : { source: `${found.path}: dispatch_tool description`, text: found.sentence };
}

/** The report sentence of a worker's brief (the worker rules in architect.rs), with the default limit. */
export function findWorkerReport(files, limit = SUMMARY_LIMIT) {
  for (const { path, text } of files) {
    const m = text.match(/Provide a concise final report \(under \{\} UTF-8 bytes\)(?:[^"\\]|\\.)*/);
    if (m) return { source: `${path}: worker rules`, text: unescapeRust(m[0]).replace('{}', String(limit)) };
  }
  return null;
}

/** Every architect source, as findLeadGuidance and findWorkerReport read them. */
export function architectSources(repo = REPO) {
  return [join(repo, 'src-tauri/src/architect.rs'), ...listFiles(join(repo, 'src-tauri/src/architect'))]
    .filter(file => file.endsWith('.rs')).map(file => ({ path: file.slice(repo.length + 1), text: readFileSync(file, 'utf8') }));
}

/**
 * The selector's reply → a pick, validated as `token_saver::parse` validates an assignment:
 * "none", or {packs, level} with known packs and a level only beside caveman (default full).
 * Omitted or null inherits the lead thread's saver, which is none here. Invalid → no block.
 */
export function parseSelection(text) {
  const value = String(text ?? '');
  const fenced = [...value.matchAll(/```(?:json)?[^\n]*\n([\s\S]*?)```/g)].map(m => m[1]).reverse();
  const start = value.indexOf('{');
  const bare = start >= 0 ? [value.slice(start, value.lastIndexOf('}') + 1)] : [];
  let parsed;
  for (const candidate of [...fenced, ...bare]) {
    try { const v = JSON.parse(candidate); if (v && typeof v === 'object' && !Array.isArray(v)) { parsed = v; break; } } catch { /* next */ }
  }
  const none = { packs: [], level: 'full' };
  const invalid = error => ({ ok: false, error, ...none });
  if (!parsed) return invalid('no JSON object');
  const saver = parsed.tokenSaver;
  if (saver === undefined || saver === null || saver === 'none') return { ok: true, ...none };
  if (typeof saver !== 'object' || Array.isArray(saver) || !Array.isArray(saver.packs) || Object.keys(saver).some(key => key !== 'packs' && key !== 'level')) return invalid('tokenSaver is "none" or {packs, level}');
  const unknown = saver.packs.filter(id => !PACK_IDS.includes(id));
  if (unknown.length) return invalid(`unknown pack ${unknown[0]}`);
  const caveman = saver.packs.includes('caveman');
  if (saver.level != null && !caveman) return invalid('level applies only with caveman');
  if (saver.level != null && !LEVELS.includes(saver.level)) return invalid(`unknown level ${saver.level}`);
  return { ok: true, packs: PACK_IDS.filter(id => saver.packs.includes(id)), level: saver.level ?? 'full' };
}

/**
 * What the app appends to a worker's assignment (`saver_block` in architect.rs): `Applied::block()`,
 * the shipped guidance after a blank line, once rtk is dropped when missing; nothing for no packs.
 * The window's `contextFor()` sends the same text on a fresh thread's first message.
 */
export function saverBlock(guidance, pick, available) {
  const active = pick.packs.filter(id => id !== 'rtk' || available.rtk);
  return active.length ? `\n\n${guidance(pick.packs, pick.level, available)}` : '';
}

/** The selector: the lead's shipped guidance and the assignment; it answers with tokenSaver only. */
export function selectorPrompt(leadGuidance, assignment) {
  const system = [
    'You are the lead agent of a PandaCode team. You are about to dispatch the assignment below to one worker with pandacode_dispatch_workers.',
    'The dispatch tool documents its tokenSaver option as follows:',
    leadGuidance,
    'Your own thread has no token saver, so leaving tokenSaver out means none.',
    'Reply with only one JSON object of the form {"tokenSaver": <value>}, where <value> is the tokenSaver value you would pass for this assignment. No other text.',
  ].join('\n\n');
  return { system, user: `Assignment for the worker:\n\n${assignment}` };
}

/**
 * Jobs in a seeded random order. Each (task, seed) group runs its arms in a shuffled order.
 */
export const assignJobs = (tasks, seeds, arms, batchSeed) => seededJobs(tasks.flatMap(task => seeds.map(seed => ({ task, seed }))), () => arms, batchSeed);

/** Every task the saver batch runs, with its set, from tasks-saver.json and tasks.json. */
export function loadTasks(saverFile = join(HERE, 'tasks-saver.json'), baseFile = join(HERE, 'tasks.json')) {
  const saver = JSON.parse(readFileSync(saverFile, 'utf8'));
  const base = JSON.parse(readFileSync(baseFile, 'utf8'));
  const find = (list, id) => { const task = list.find(t => t.id === id); if (!task) throw new Error(`unknown task ${id}`); return task; };
  return {
    saver, base,
    tasks: [
      ...saver.loc.map(id => ({ ...find(base.localization, id), set: 'loc' })),
      ...saver.edit.map(id => ({ ...find(base.edit, id), set: 'edit' })),
      ...saver.report.map(task => ({ ...task, set: 'report' })),
    ],
  };
}

/** The task prompt before any saver block. */
export const workerPrompt = (task, base) => (task.set === 'loc' ? `${task.prompt}\n\n${base.localizationSuffix}` : task.prompt);
/** What a worker gets: its brief's report sentence, the assignment, then the saver block, as the app sends them. */
export const workerMessage = (report, prompt, block) => `${report}\n\n${prompt}${block}`;


// ---------- Gate simulation (docs/token-saver-benchmark.md, "Task-success gate") ----------

/**
 * P(the pooled task-success gate passes) for each margin when CHOSEN's true effect on every task is
 * `effect`. Edit tasks pass with their observed rate; each report rubric item is hit with its own
 * rate; a task's value is its mean over `seeds` runs, and the gate is analyze.mjs's: the lower end
 * of the bootstrap CI of the mean per-task difference must clear the margin.
 */
export function simulateGate({ editRates, reportItems, seeds = 3, reps = 1000, margins, effect = 0, seed = 0x5a7e, rounds = 2000 }) {
  const next = random(seed);
  const clamp = p => Math.min(1, Math.max(0, p));
  const runs = (p, n) => { let hits = 0; for (let i = 0; i < n; i++) if (next() < p) hits++; return hits / n; };
  const report = (items, shift) => { let sum = 0; for (let s = 0; s < seeds; s++) sum += mean(items.map(q => (next() < clamp(q + shift) ? 1 : 0))); return sum / seeds; };
  const passes = margins.map(() => 0);
  for (let rep = 0; rep < reps; rep++) {
    const diffs = [
      ...editRates.map(p => runs(clamp(p + effect), seeds) - runs(p, seeds)),
      ...reportItems.map(items => report(items, effect) - report(items, 0)),
    ];
    const [low] = bootstrapCi(diffs, rounds, (seed + rep * 7919) >>> 0);
    margins.forEach((margin, i) => { if (low > margin) passes[i]++; });
  }
  return Object.fromEntries(margins.map((margin, i) => [margin, passes[i] / reps]));
}

/** Per-task pass rates of BEFORE in batches E and E2 (4 runs each), shrunk by +0.5/+1 so none is exactly 0 or 1. */
export function editRatesFromCsv(texts, ids) {
  const rows = texts.flatMap(text => {
    const [header, ...lines] = text.trim().split('\n');
    const keys = header.split(',');
    return lines.map(line => Object.fromEntries(line.split(',').map((v, i) => [keys[i], v])));
  }).filter(r => r.set === 'edit' && r.arm === 'before');
  return ids.map(id => {
    const mine = rows.filter(r => r.task === id);
    return (mine.filter(r => r.success === 'true').length + 0.5) / (mine.length + 1);
  });
}

/** Report items' hit rates, assumed (no NONE data yet): spread evenly over 0.35–0.95 within each rubric. */
export const assumedItemRates = count => Array.from({ length: count }, (_, i) => (count === 1 ? 0.65 : 0.35 + 0.6 * i / (count - 1)));

export const SIM_MARGINS = [-0.05, -0.1, -0.125, -0.15, -0.175, -0.2, -0.25];
// S1v3 runs 5 seeds per arm (S1v2's 3 needed a -0.20 margin).
export const SAVER_SEEDS = [1, 2, 3, 4, 5];
export function simulationReport({ seeds = SAVER_SEEDS.length, reps = 2000 } = {}) {
  const { saver } = loadTasks();
  const csv = ['v5-E.csv', 'v5-E2.csv'].map(name => readFileSync(join(HERE, 'results', 'runs', name), 'utf8'));
  const editRates = editRatesFromCsv(csv, saver.edit);
  const reportItems = saver.report.map(t => assumedItemRates(t.rubric.length));
  const at = effect => simulateGate({ editRates, reportItems, seeds, reps, margins: SIM_MARGINS, effect });
  return { seeds, reps, tasks: editRates.length + reportItems.length, editRates: editRates.map(r => Number(r.toFixed(3))), noEffect: at(0), trueDrop5: at(-0.05), trueDrop10: at(-0.1), trueDrop20: at(-0.2) };
}

// ---------- Runner ----------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const { values: args } = isMain ? parseArgs({ options: {
  out: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/saver') },
  from: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2') },  // repos, sanity.json, pinned harness
  batch: { type: 'string', default: 'S1v3' },
  snapshot: { type: 'string', default: 'bin-f' },  // the explore server snapshot in --from (run.mjs --prepare --snapshot)
  'batch-seed': { type: 'string' },
  arm: { type: 'string', default: ARMS.join(',') },
  set: { type: 'string', default: 'loc,edit,report' },
  tasks: { type: 'string' },
  seeds: { type: 'string', default: SAVER_SEEDS.join(',') },
  'sim-seeds': { type: 'string' },  // --simulate at another seed count
  concurrency: { type: 'string', default: '4' },
  'min-free-gib': { type: 'string', default: '6' },
  'run-timeout-min': { type: 'string', default: '25' },
  'total-budget-usd': { type: 'string', default: '1000' },
  'run-cap-usd': { type: 'string', default: '5' },
  prepare: { type: 'boolean', default: false },
  'check-tasks': { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  simulate: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
  status: { type: 'boolean', default: false },
  force: { type: 'boolean', default: false },
} }) : { values: {} };

const OUT = args.out;
const FROM = args.from;
const PIDS = OUT && join(OUT, 'pids.json');
const LEDGER = OUT && join(OUT, 'ledger.jsonl');
const META = OUT && join(OUT, 'snapshot', 'meta.json');
const SNAPSHOT_TS = OUT && join(OUT, 'snapshot', 'token-saver.mts');
// token-saver.ts imports its pack text from here, so the snapshot keeps a copy beside it.
const SNAPSHOT_PACKS = OUT && join(OUT, 'snapshot', 'token-saver-packs.json');
const WORK = OUT && join(WORK_ROOT, `saver-${sha(OUT).slice(0, 8)}`);
const RUNNER_HASH = sha(RUNNER_FILES.map(file => readFileSync(join(HERE, file), 'utf8')).join('\0'));
const MIN_FREE_GIB = Number(args['min-free-gib'] ?? 6);
const runCap = () => Number(args['run-cap-usd']);
const diskNeed = task => (task.set === 'edit' && isRust(task) ? 1.5 : task.repo === 'vscode' ? 0.5 : 0.2);

/** The texts a batch pins, read from the live tree: lead guidance, worker report sentence, LOOK. */
function liveTexts() {
  const architect = architectSources();
  const lead = findLeadGuidance(architect);
  if (!lead) throw new Error('no tokenSaver guidance in the dispatch tool description (src-tauri/src/architect.rs)');
  const report = findWorkerReport(architect);
  if (!report) throw new Error('no report sentence in the worker rules (src-tauri/src/architect.rs)');
  const look = exploreClause();
  return { lead: { ...lead, sha256: sha(lead.text) }, report: { ...report, sha256: sha(report.text) }, look: { text: look, sha256: sha(look) } };
}

async function prepare() {
  mkdirSync(dirname(META), { recursive: true });
  const harness = join(FROM, 'harness');
  if (!existsSync(join(harness, 'claude'))) throw new Error(`no pinned harness in ${harness}; run run.mjs --prepare first`);
  const explore = join(FROM, args.snapshot, 'meta.json');
  if (!existsSync(explore)) throw new Error(`no explore snapshot ${args.snapshot} in ${FROM}; run run.mjs --prepare --snapshot ${args.snapshot} first`);
  mkdirSync(dirname(SNAPSHOT_TS), { recursive: true });
  copyFileSync(join(REPO, 'src', 'token-saver.ts'), SNAPSHOT_TS);
  copyFileSync(join(REPO, 'src', 'token-saver-packs.json'), SNAPSHOT_PACKS);
  const { lead, report, look } = liveTexts();
  // The worker's block is built natively by token_saver::guidance, which its own test holds equal to the window's.
  const native = join(REPO, 'src-tauri/src/token_saver.rs');
  const rtk = await must('rtk', ['--version'], { env: safeEnv() }).then(out => out.trim(), () => null);
  const server = JSON.parse(readFileSync(explore, 'utf8'));
  const meta = {
    harness: (await must(join(harness, 'claude'), ['--version'], { env: safeEnv() })).trim(),
    tokenSaverSha256: sha(readFileSync(SNAPSHOT_TS)), packsSha256: sha(readFileSync(SNAPSHOT_PACKS)), nativeTokenSaverSha256: existsSync(native) ? sha(readFileSync(native)) : null,
    leadGuidance: lead, workerReport: report, look,
    explore: { snapshot: args.snapshot, binaryHash: server.binaryHash, sourcesHash: server.sourcesHash },
    // Round 17 on: the build inputs run.mjs --prepare snapshotted beside the explore server (null before).
    build: server.build ?? null,
    rtk, tasksSaverSha256: sha(readFileSync(join(HERE, 'tasks-saver.json'))), preparedAt: new Date().toISOString(),
  };
  writeFileSync(META, JSON.stringify(meta, null, 2));
  console.log(JSON.stringify({ ...meta, leadGuidance: { ...lead, text: `${lead.text.slice(0, 200)}…` } }, null, 1));
}
const listFiles = dir => (existsSync(dir) ? readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? listFiles(p) : [p]; }) : []);

/** Refuses to run when anything the snapshot pinned has changed in the tree since --prepare. */
export function assertUnchanged(meta, live) {
  for (const key of ['leadGuidance', 'workerReport', 'look']) {
    const now = live[{ leadGuidance: 'lead', workerReport: 'report', look: 'look' }[key]].sha256;
    if (meta[key]?.sha256 !== now) throw new Error(`${key} changed since --prepare (${meta[key]?.sha256?.slice(0, 12)} → ${now.slice(0, 12)}): rerun --prepare and use a new batch name`);
  }
}

async function loadMeta() {
  if (!existsSync(META)) throw new Error('run saver.mjs --prepare first');
  const meta = JSON.parse(readFileSync(META, 'utf8'));
  if (sha(readFileSync(SNAPSHOT_TS)) !== meta.tokenSaverSha256 || sha(readFileSync(SNAPSHOT_PACKS)) !== meta.packsSha256) throw new Error('token-saver snapshot changed since --prepare');
  if (meta.tasksSaverSha256 !== sha(readFileSync(join(HERE, 'tasks-saver.json')))) throw new Error('tasks-saver.json changed since --prepare');
  assertUnchanged(meta, liveTexts());
  const server = join(FROM, meta.explore.snapshot, 'explore-serve');
  if (!existsSync(server) || sha(readFileSync(server)) !== meta.explore.binaryHash) throw new Error(`explore snapshot ${meta.explore.snapshot} changed since --prepare`);
  const live = (await must('claude', ['--version'], { env: safeEnv() })).trim();
  if (live !== meta.harness) throw new Error(`harness is ${live}, prepared with ${meta.harness}`);
  return { meta, saver: await import(pathToFileURL(SNAPSHOT_TS)), server };
}

/**
 * A checkout for the task: loc and edit as run.mjs makes them; reports as their kind needs. `from`
 * holds the bare repos; `build` pins a Rust edit's dependencies (snapshot meta.build).
 */
export async function checkout(task, work, { build = null, from = FROM } = {}) {
  const prune = Object.fromEntries(Object.entries(JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8')).repos).map(([repo, r]) => [repo, r.prune]));
  const gitDir = repoDir(task.repo, from);
  const node = task.set === 'edit' || task.kind === 'failing';
  if (task.kind === 'explain') return materialize(gitDir, task.at, work);
  const parent = (await must('git', ['-C', gitDir, 'rev-parse', `${task.commit}^`])).trim();
  const removed = await materialize(gitDir, parent, work, { nodeModules: node, prepare: task.set === 'edit' && isRust(task) ? tree => pinDependencies(tree, build?.dir) : null });
  for (const path of prune[task.repo] ?? []) rmSync(join(work, path), { recursive: true, force: true });
  if (task.kind === 'review') { await applyFix(task, parent, work, gitDir); applyStub(task.plant, work); }
  if (task.kind === 'failing') await overlayTests(task, work, gitDir);
  return removed;
}

async function checkTasks() {
  const { tasks } = loadTasks();
  let problems = 0;
  const complain = (id, text) => { problems++; console.log(`PROBLEM ${id}: ${text}`); };
  const ids = tasks.map(t => t.id);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) complain(id, 'duplicate id');
  const sanity = existsSync(join(FROM, 'sanity.json')) ? JSON.parse(readFileSync(join(FROM, 'sanity.json'), 'utf8')) : {};
  for (const task of tasks) {
    if (task.set === 'edit' && sanity[task.id]?.verdict !== 'ok') complain(task.id, 'edit task not sanity-checked ok');
    if (task.set !== 'report') continue;
    for (const item of task.rubric) for (const source of item.line) { try { new RegExp(source, 'i'); } catch (error) { complain(task.id, `${item.id}: ${error.message}`); } }
    for (const { path, find } of task.plant ?? []) {
      const text = await must('git', ['-C', REPO, 'show', `${task.commit}:${path}`]);
      const count = text.split(find).length - 1;
      if (count !== 1) complain(task.id, `plant anchor found ${count} times in ${path}`);
    }
    if (task.kind === 'failing') {
      const expected = sanity[`edit-${task.id.replace(/^rep-fail-/, '')}`]?.parentFailed;
      for (const name of expected ?? []) if (!task.rubric.some(item => item.line.length === 1 && name.startsWith(item.line[0]))) complain(task.id, `failing test not in rubric: ${name}`);
    }
    console.log(`${task.id.padEnd(26)} ${task.kind.padEnd(8)} ${task.rubric.length} rubric items`);
  }
  console.log(JSON.stringify({ tasks: tasks.length, bySet: Object.fromEntries(['loc', 'edit', 'report'].map(s => [s, tasks.filter(t => t.set === s).length])), problems }));
  if (problems) process.exitCode = 1;
}

/** One tool-less call per (task, seed), cached, recorded and costed apart. */
async function selection(task, seed, prompt, meta, saverConfig) {
  const dir = join(OUT, 'selections');
  mkdirSync(dir, { recursive: true });
  // Keyed by the guidance it saw, so a new guidance never reuses an old pick.
  const key = `${task.id}__s${seed}__g${meta.leadGuidance.sha256.slice(0, 12)}`;
  const file = join(dir, `${key}.json`);
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const { system, user } = selectorPrompt(meta.leadGuidance.text, prompt);
  const attempt = randomBytes(6).toString('hex');
  appendLedger(LEDGER, { type: 'start', attempt, id: `select__${task.id}__s${seed}`, batch: 'selections', capUsd: 1 });
  const empty = join(WORK, `select-${attempt}`);
  mkdirSync(empty, { recursive: true });
  const stream = join(dir, `${key}.jsonl`);
  const argv = ['--output-format', 'stream-json', '--verbose', '--model', saverConfig.selectorModel, '--tools', '', '--system-prompt', system,
    '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', 'project', '--no-session-persistence', '--max-budget-usd', '1'];
  const run = await runClaude([user], empty, stream, argv, 180_000, {}, PIDS);
  rmSync(empty, { recursive: true, force: true });
  const m = metrics(readFileSync(stream, 'utf8'));
  appendLedger(LEDGER, { type: 'end', attempt, billedUsd: m.costUsd ?? 0 });
  const pick = parseSelection(m.answer);
  const record = { task: task.id, seed, ...pick, raw: m.answer.slice(0, 2000), usd: m.costUsd ?? 0, fieldUsd: fieldUsd(m.tokens?.output), tokens: m.tokens, model: m.init.model, exitCode: run.code, systemSha256: sha(system), leadGuidanceSha256: meta.leadGuidance.sha256 };
  writeAtomic(file, JSON.stringify(record, null, 1));
  return record;
}

/** One worker run: the arm's saver block on the worker's brief and task, measured and graded. */
async function oneRun(job, batchDir, ctx) {
  const { task, arm, seed } = job;
  const { meta, saver, base, saverConfig } = ctx;
  const id = `${task.set}__${task.id}__s${seed}__${arm}`;
  const runDir = join(batchDir, id);
  if (existsSync(join(runDir, 'run.json')) && !args.force) return { skipped: true };
  const prompt = workerPrompt(task, base);
  const record = { id, set: task.set, task: task.id, kind: task.kind ?? task.set, arm, seed, model: saverConfig.workerModel, group: job.group, armOrder: job.order, startedAt: new Date().toISOString() };
  if (task.set === 'loc') record.gold = task.gold;
  let pick = { packs: [], level: 'full' };
  if (arm === 'CHOSEN') { record.selector = await selection(task, seed, prompt, meta, saverConfig); pick = record.selector; }
  const block = saverBlock(saver.guidance, pick, { rtk: Boolean(meta.rtk) });
  record.saver = { packs: pick.packs, level: pick.level, blockChars: block.length, blockSha256: block ? sha(block) : null };
  const message = workerMessage(meta.workerReport.text, prompt, block);
  record.hashes = { prompt: sha(prompt), message: sha(message), tokenSaver: meta.tokenSaverSha256, packs: meta.packsSha256, leadGuidance: meta.leadGuidance.sha256, workerReport: meta.workerReport.sha256, look: meta.look.sha256, explore: meta.explore.binaryHash, runner: RUNNER_HASH };
  return measuredRun({
    runDir, ledger: LEDGER, workRoot: WORK, batch: basename(batchDir), id, capUsd: runCap(), record, force: args.force,
    body: (work, held) => workerTurn(task, message, work, runDir, held, ctx, record),
  });
}

/** The worker's checkout, explore server and turn, then its grade. */
async function workerTurn(task, message, work, runDir, held, ctx, record) {
  const { meta, saverConfig, verified, server: bin } = ctx;
  record.agentFilesRemoved = await checkout(task, work, { build: meta.build });
  const target = task.set === 'edit' && isRust(task) ? join(dirname(work), 'target') : null;
  if (target) { assertBuild(meta.build); await cloneTarget(target, meta.build?.target); }
  // Every arm has pandacode_explore and its LOOK clause, as workers have in the app.
  const explore = await readyExplore(bin, work, runDir, PIDS);
  held.server = explore.server;
  const argv = harnessArgs({ arm: 'after', model: saverConfig.workerModel, config: explore.config, instructions: { after: meta.look.text }, runBudget: runCap() });
  const stream = join(runDir, 'stream.jsonl');
  const run = await runClaude([message], work, stream, argv, Number(args['run-timeout-min']) * 60_000, target ? { CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' } : {}, PIDS);
  const { stepText, stepUsage, ...metric } = metrics(readFileSync(stream, 'utf8'));
  Object.assign(record, { wallMs: run.wallMs, exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr, billedUsd: metric.costUsd ?? 0, ...metric });
  const pinned = ctx.base.harness.models[saverConfig.workerModel];
  if (record.init?.model && record.init.model !== pinned) ctx.aborted = `model resolved to ${record.init.model}, pinned ${pinned}`;
  if (task.set === 'edit') {
    record.grade = await gradeEdit(task, work, target, verified);
    record.success = record.grade.pass;
  } else if (task.set === 'loc') {
    record.grade = gradeLocalization({ ...metric, stepText }, task.gold);
    record.success = record.grade.answered && !run.timedOut && !metric.isError;
  } else {
    record.grade = scoreRubric(metric.answer, task.rubric, task.kind);
    record.success = !run.timedOut && !metric.isError;
  }
}

function runBatch(jobs, batchDir, ctx) {
  return pool(jobs, {
    limit: Number(args.concurrency), batchDir, out: OUT, ledger: LEDGER, minFreeGiB: MIN_FREE_GIB, budget: Number(args['total-budget-usd']),
    // A CHOSEN run may also make its selector call, capped at $1.
    cap: job => runCap() + (job.arm === 'CHOSEN' ? 1 : 0), diskNeed: job => diskNeed(job.task), writes: job => job.task.set === 'edit' && isRust(job.task),
    runOne: job => oneRun(job, batchDir, ctx), aborted: () => ctx.aborted,
    name: j => `${j.task.set}/${j.task.id}/s${j.seed}/${j.arm}`,
    log: (r, { spentUsd, next, total }) => console.log(`${new Date().toISOString().slice(11, 19)} ${r.id} ok=${r.success} out=${r.tokens?.output} steps=${r.steps} $${r.billedUsd?.toFixed(3)} packs=${r.saver.packs.join('+') || '-'} spent=$${spentUsd.toFixed(2)} ${next}/${total}`),
  });
}

function batchSeed(batchDir, meta) {
  const pins = { harness: meta.harness, tokenSaverSha256: meta.tokenSaverSha256, packsSha256: meta.packsSha256, leadGuidanceSha256: meta.leadGuidance.sha256, workerReportSha256: meta.workerReport.sha256, lookSha256: meta.look.sha256, exploreBinary: meta.explore.binaryHash, tasksSaverSha256: sha(readFileSync(join(HERE, 'tasks-saver.json'))), tasksSha256: sha(readFileSync(join(HERE, 'tasks.json'))),
    cargoLockSha256: meta.build?.cargoLockSha256, cargoTomlSha256: meta.build?.cargoTomlSha256, depsSha256: meta.build?.deps?.sha256 };
  return pinnedSeed(join(batchDir, 'batch.json'), pins, RUNNER_HASH, args['batch-seed']);
}

async function main() {
  mkdirSync(OUT, { recursive: true });
  process.env.PATH = `${join(FROM, 'harness')}:${process.env.PATH}`;
  assertExplorable(WORK);
  if (args.status) return console.log(JSON.stringify({ ...ledgerTotals(readLedger(LEDGER)), open: undefined }, null, 1));
  stopChildrenOnSignal();
  if (args.prepare) return prepare();
  if (args['check-tasks']) return checkTasks();
  if (args.simulate) return console.log(JSON.stringify(simulationReport(args['sim-seeds'] ? { seeds: Number(args['sim-seeds']) } : {}), null, 1));
  const { saver: saverConfig, base, tasks: all } = loadTasks();
  const sets = args.set.split(',');
  const wanted = args.smoke ? (args.tasks ?? saverConfig.smokeTasks.join(',')).split(',') : args.tasks?.split(',');
  const sanityFile = join(FROM, 'sanity.json');
  const verified = existsSync(sanityFile) ? JSON.parse(readFileSync(sanityFile, 'utf8')) : {};
  const tasks = all.filter(t => (wanted ? wanted.includes(t.id) : sets.includes(t.set)) && (t.set !== 'edit' || args.plan || verified[t.id]?.verdict === 'ok'));
  const seeds = args.smoke ? [99] : args.seeds.split(',').map(Number);
  const arms = args.arm.split(',');
  if (arms.some(arm => !ARMS.includes(arm))) throw new Error(`arms are ${ARMS.join(',')}`);
  if (args.plan) {
    const jobs = assignJobs(tasks, seeds, arms, 1);
    const selectors = jobs.filter(j => j.arm === 'CHOSEN').length;
    const usd = jobs.reduce((sum, j) => sum + ESTIMATE[j.task.set], 0) + selectors * ESTIMATE.selector;
    console.log(JSON.stringify({ batch: args.batch, tasks: tasks.length, seeds, runs: jobs.length, selectorCalls: selectors, byArm: Object.fromEntries(arms.map(a => [a, jobs.filter(j => j.arm === a).length])), bySet: Object.fromEntries(['loc', 'edit', 'report'].map(set => [set, jobs.filter(j => j.task.set === set).length])), estimateUsd: Number(usd.toFixed(2)) }));
    return;
  }
  const { meta, saver, server } = await loadMeta();
  claimRunner({ out: OUT, pids: PIDS, ledger: LEDGER, work: WORK });
  process.on('exit', () => rmSync(WORK, { recursive: true, force: true, maxRetries: 2 }));
  const batchDir = join(OUT, 'runs', args.smoke ? `smoke-${args.batch}` : args.batch);
  mkdirSync(batchDir, { recursive: true });
  const seed = args.smoke ? 99 : batchSeed(batchDir, meta);
  await runBatch(assignJobs(tasks, seeds, arms, seed), batchDir, { meta, saver, base, saverConfig, verified, server, aborted: null });
}

if (isMain) await main();
