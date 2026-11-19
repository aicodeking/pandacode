#!/usr/bin/env node
// Batch S3: round 18's team worker launch against the one before it, with a real skills library. Dev-only.
// Method, pre-registration and results: docs/worker-tokens-benchmark.md.
import { createHash } from 'node:crypto';
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { blindRescore } from './analyze.mjs';
import { REPO, TOOLS_SERVE_TEST, WORK_ROOT, assertExplorable, claimRunner, exploreClause, harnessArgs, measuredRun, must, pinnedSeed, pool, readyExplore, register, reuseClause, runClaude, safeEnv, stopChildrenOnSignal } from './lib.mjs';
import { gradeLocalization, metrics, scoreRubric } from './metrics.mjs';
import { deniedTools, loadS2, toolCounts } from './s2.mjs';
import { architectSources, assignJobs, checkout, findWorkerReport, workerMessage, workerPrompt } from './saver.mjs';
import { bootstrapCi, holm, mean, random, wilcoxon } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
export const ARMS = ['BASE', 'NEW'];
/** Every S2 task runs as a read-only worker and as a writer: one unit per task and worker kind. */
export const WORKERS = ['ro', 'rw'];
const RUNNER_FILES = ['s3.mjs', 's2.mjs', 'saver.mjs', 'lib.mjs', 'metrics.mjs', 'ledger.mjs'];

/**
 * The lists the app launched workers with before round 18 (S2's LEAN flag, recorded in every S2
 * run.json; S2's batch.json pins their sha256 as `lists`). Skill stayed on.
 */
export const PRE_R18 = {
  session: 'ScheduleWakeup,Monitor,CronCreate',
  worker: 'Agent,Task,Workflow,ListAgents,SendMessage,TaskStop,RemoteTrigger,CronDelete,CronList,EnterWorktree,ExitWorktree',
  readOnly: 'Edit,Write,NotebookEdit',
};
export const S2_LISTS_SHA = '8a7e2bc54df7dd580e6e4f4985ee52ee773cd3d80037f075d988abafa748329e';

/** Round 18's lists, read from providers.rs: S2's three plus `CLAUDE_SKILL_TOOL`. */
export function newLists(source = readFileSync(join(REPO, 'src-tauri/src/providers.rs'), 'utf8')) {
  const skill = source.match(/const CLAUDE_SKILL_TOOL: &str = "([^"]*)";/);
  if (!skill) throw new Error('no CLAUDE_SKILL_TOOL in providers.rs');
  return { ...deniedTools(source), skill: skill[1] };
}

/** `--disallowedTools` per arm and kind, as `claude_disallowed_tools` builds it. */
export function armFlag(arm, worker, lists) {
  const l = arm === 'BASE' ? PRE_R18 : lists;
  const parts = [l.session, l.worker, ...(worker === 'ro' ? [l.readOnly] : []), ...(arm === 'NEW' ? [l.skill] : [])];
  return `--disallowedTools=${parts.join(',')}`;
}

/**
 * What is wrong with a run's launch for its arm, from its init event, or null. S3 copies the user's
 * skills in and BASE must list one; S3b (`bundledOnly`) must list none of them, only bundled skills.
 */
export function launchProblem(arm, init, copied, { bundledOnly = false } = {}) {
  const tools = init?.tools ?? [];
  const agentMade = ['list', 'save', 'run'].filter(name => tools.some(tool => tool.endsWith(`pandacode_tool_${name}`)));
  const listedCopied = (init?.skills ?? []).some(name => copied.has(name));
  if (bundledOnly && listedCopied) return 'a user skill is listed in a bundled-only run';
  if (arm === 'BASE') {
    if (!tools.includes('Skill')) return 'BASE has no Skill tool';
    if (!bundledOnly && !listedCopied) return 'no copied skill listed in a BASE run';
    if (bundledOnly && !(init?.skills ?? []).length) return 'no bundled skill listed in a BASE run';
    if (agentMade.length !== 3) return `BASE lists agent-made tools ${agentMade.join(',') || 'none'}`;
  } else if (tools.includes('Skill') || agentMade.length) return 'NEW lists Skill or agent-made tools';
  return null;
}

// ---------- Analysis (registered: log-ratio scale for the test and the CI) ----------

const MEASURES = {
  billedUsd: r => r.billedUsd ?? 0,
  firstStepCacheWrite: r => r.firstStep?.cacheWrite ?? 0,
  steps: r => r.steps ?? 0,
  outputTokens: r => r.tokens?.output ?? 0,
  cacheReadTokens: r => r.tokens?.cacheRead ?? 0,
  wallMs: r => r.wallMs ?? 0,
};
const unitOf = r => `${r.task}|${r.worker}`;

/**
 * Per unit (task × kind): d = log(mean NEW / mean BASE) over seeds. Two-sided Wilcoxon on d and a 95%
 * bootstrap CI of mean d, both on that scale; the change is reported as exp(mean d) − 1.
 */
export function logRatio(pairs) {
  const d = pairs.filter(([a, b]) => a > 0 && b > 0).map(([a, b]) => Math.log(b / a));
  if (!d.length) return null;
  const ci = bootstrapCi(d);
  return { n: d.length, meanLog: mean(d), change: Math.exp(mean(d)) - 1, ci: ci.map(x => Math.exp(x) - 1), p: wilcoxon(d) };
}

const units = (runs, filter = () => true) => {
  const map = new Map();
  for (const r of runs.filter(filter)) {
    if (!map.has(unitOf(r))) map.set(unitOf(r), { set: r.set, worker: r.worker, BASE: [], NEW: [] });
    map.get(unitOf(r))[r.arm]?.push(r);
  }
  return [...map.values()].filter(u => u.BASE.length && u.NEW.length);
};

/** The registered analysis: primary cost, secondaries first-step write and steps (Holm), the rest descriptive. */
export function analyze(runs) {
  const paired = units(runs);
  const avg = (list, f) => mean(list.map(f));
  const table = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const t = logRatio(paired.map(u => [avg(u.BASE, f), avg(u.NEW, f)]));
    table[name] = t && { base: mean(paired.map(u => avg(u.BASE, f))), new: mean(paired.map(u => avg(u.NEW, f))), ...t };
  }
  const read = (t, adjusted) => (adjusted < 0.05 && (t.ci[1] < 0 || t.ci[0] > 0) ? (t.change < 0 ? 'lower' : 'higher') : t.change < 0 ? 'not shown to be lower' : 'not shown to be higher');
  table.billedUsd.read = read(table.billedUsd, table.billedUsd.p);
  const [p1, p2] = holm([table.firstStepCacheWrite.p, table.steps.p]);
  Object.assign(table.firstStepCacheWrite, { pHolm: p1, read: read(table.firstStepCacheWrite, p1) });
  Object.assign(table.steps, { pHolm: p2, read: read(table.steps, p2) });
  for (const name of ['outputTokens', 'cacheReadTokens', 'wallMs']) table[name].read = 'descriptive';
  const byWorker = Object.fromEntries(WORKERS.map(worker => [worker, logRatio(units(runs, r => r.worker === worker).map(u => [avg(u.BASE, MEASURES.billedUsd), avg(u.NEW, MEASURES.billedUsd)]))]));
  return { units: paired.length, runs: runs.length, table, costByWorker: byWorker, quality: quality(paired), tools: toolCounts(runs), toolsListed: Object.fromEntries(ARMS.map(arm => [arm, [...new Set(runs.filter(r => r.arm === arm).map(r => r.init?.tools?.length))]])), skillsListed: Object.fromEntries(ARMS.map(arm => [arm, [...new Set(runs.filter(r => r.arm === arm).map(r => r.init?.skills?.length))]])) };
}

/**
 * From S3b on (registered with it): the ratio of means, mean NEW / mean BASE − 1 over unit means, and the
 * absolute saving per run, mean BASE − mean NEW in dollars, each with a 95% bootstrap CI over units
 * (the same resampled units for both).
 */
export function absoluteSaving(runs, { rounds = 20_000, seed = 0x2545f491 } = {}) {
  const pairs = units(runs).map(u => [mean(u.BASE.map(MEASURES.billedUsd)), mean(u.NEW.map(MEASURES.billedUsd))]);
  if (!pairs.length) return null;
  const stat = list => { const b = mean(list.map(p => p[0])), n = mean(list.map(p => p[1])); return [n / b - 1, b - n]; };
  const next = random(seed);
  const draws = Array.from({ length: rounds }, () => stat(Array.from(pairs, () => pairs[Math.floor(next() * pairs.length)])));
  const ci = k => { const sorted = draws.map(d => d[k]).sort((a, b) => a - b); return [sorted[Math.floor(rounds * 0.025)], sorted[Math.floor(rounds * 0.975)]]; };
  const [ratio, saving] = stat(pairs);
  return { units: pairs.length, base: mean(pairs.map(p => p[0])), new: mean(pairs.map(p => p[1])), ratioOfMeans: ratio, ratioCi: ci(0), savingUsd: saving, savingCi: ci(1) };
}

/** Descriptive: loc recall and precision, report rubric recall (strict rubrics when rescored), NEW − BASE per unit. */
function quality(paired) {
  const out = {};
  for (const [key, set] of [['recall', 'loc'], ['precision', 'loc'], ['rubric', 'report']]) {
    const get = r => (key === 'precision' ? r.grade?.precision : r.grade?.recall) ?? 0;
    const list = paired.filter(u => u.set === set);
    const diff = list.map(u => mean(u.NEW.map(get)) - mean(u.BASE.map(get)));
    out[key] = { units: list.length, base: mean(list.map(u => mean(u.BASE.map(get)))), new: mean(list.map(u => mean(u.NEW.map(get)))), diff: mean(diff), ci: bootstrapCi(diff), read: 'descriptive' };
  }
  return out;
}

// ---------- Power (registered before S3; from S2's run-level variance) ----------

/**
 * P(S3's primary reads "lower") when NEW's true cost is (1 + effect) × BASE's. Each unit is an S2 task
 * (cycled over `units`); both arms draw `seeds` runs with replacement from that task's six S2 runs
 * (both arms pooled; S2's own change was −1.8%), NEW's costs times (1 + effect). The rule is the
 * registered one: Wilcoxon p < 0.05 and the CI of mean d below 0. `spread` adds a normal per-unit
 * effect (sd on the log scale): resampling six runs alone gives d an sd of 0.059 at 3 seeds where S2
 * observed 0.072, so S2's own calibration is sqrt(0.072² − 0.059²) = 0.042 (`S2_SPREAD`).
 */
export const S2_SPREAD = 0.042;
export function power(costsByTask, { effect = -0.1, seeds = 3, units = 56, reps = 400, rounds = 2000, seed = 0x53, spread = 0, test = wilcoxonNormal } = {}) {
  const next = random(seed);
  const draw = list => mean(Array.from({ length: seeds }, () => list[Math.floor(next() * list.length)]));
  const normal = () => Math.sqrt(-2 * Math.log(1 - next())) * Math.cos(2 * Math.PI * next());
  let hits = 0;
  for (let rep = 0; rep < reps; rep++) {
    const d = Array.from({ length: units }, (_, i) => { const list = costsByTask[i % costsByTask.length]; return Math.log((draw(list) * (1 + effect)) / draw(list)) + spread * normal(); });
    const ci = bootstrapCi(d, rounds, (seed + rep * 7919) >>> 0);
    if (test(d) < 0.05 && ci[1] < 0) hits++;
  }
  return hits / reps;
}

const erfc = x => { const t = 1 / (1 + 0.3275911 * x); return t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429)))) * Math.exp(-x * x); };
/**
 * Two-sided Wilcoxon signed-rank p by the normal approximation (midranks, tie-corrected variance).
 * Only the power estimate uses it, for speed; the analysis uses stats.mjs's exact or sampled test.
 */
export function wilcoxonNormal(diffs) {
  const nonzero = diffs.filter(d => d !== 0);
  const n = nonzero.length;
  if (!n) return 1;
  const order = nonzero.map((d, i) => [Math.abs(d), i]).sort((a, b) => a[0] - b[0]);
  const ranks = new Array(n);
  let ties = 0;
  for (let i = 0; i < n;) {
    let j = i;
    while (j + 1 < n && order[j + 1][0] === order[i][0]) j++;
    for (let k = i; k <= j; k++) ranks[order[k][1]] = (i + j) / 2 + 1;
    ties += (j - i + 1) ** 3 - (j - i + 1);
    i = j + 1;
  }
  const positive = nonzero.reduce((sum, d, i) => sum + (d > 0 ? ranks[i] : 0), 0);
  const sd = Math.sqrt(n * (n + 1) * (2 * n + 1) / 24 - ties / 48);
  const z = Math.max(0, Math.abs(positive - n * (n + 1) / 4) - 0.5) / sd;
  return Math.min(1, erfc(z / Math.SQRT2));
}

/**
 * S3b's power input: S3's runs per unit (task × kind), NEW's divided by that unit's own NEW/BASE ratio so
 * both arms sit at BASE's level, and the sd of S3's observed per-unit d (`observedSd`) to calibrate τ.
 */
export function s3Costs(runs) {
  const paired = units(runs);
  const d = paired.map(u => Math.log(mean(u.NEW.map(MEASURES.billedUsd)) / mean(u.BASE.map(MEASURES.billedUsd))));
  const md = mean(d);
  return { costs: paired.map((u, i) => [...u.BASE.map(MEASURES.billedUsd), ...u.NEW.map(r => MEASURES.billedUsd(r) / Math.exp(d[i]))]), observedSd: Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / (d.length - 1)) };
}

/** The sd of d that resampling alone gives (no τ), for calibrating τ = sqrt(observed² − this²). */
export function resampledSd(costsByTask, { seeds = 3, units = 56, reps = 400, seed = 0x53 } = {}) {
  const next = random(seed);
  const draw = list => mean(Array.from({ length: seeds }, () => list[Math.floor(next() * list.length)]));
  const d = Array.from({ length: reps * units }, (_, i) => { const list = costsByTask[i % costsByTask.length]; return Math.log(draw(list) / draw(list)); });
  const md = mean(d);
  return Math.sqrt(d.reduce((s, x) => s + (x - md) ** 2, 0) / (d.length - 1));
}

export function s2Costs(dir) {
  const byTask = new Map();
  for (const name of readdirSync(dir)) {
    const file = join(dir, name, 'run.json');
    if (!existsSync(file)) continue;
    const r = JSON.parse(readFileSync(file, 'utf8'));
    if (!byTask.has(r.task)) byTask.set(r.task, []);
    byTask.get(r.task).push(r.billedUsd);
  }
  return [...byTask.keys()].sort().map(task => byTask.get(task));
}

// ---------- Skills (a copy of the user's own, loaded with --add-dir) ----------

const listFiles = dir => readdirSync(dir).flatMap(name => { const p = join(dir, name); return statSync(p).isDirectory() ? listFiles(p) : [p]; });
/** sha256 over the copy's relative paths and contents. */
export const treeHash = dir => sha(listFiles(dir).sort().map(p => `${relative(dir, p)}\0${sha(readFileSync(p))}`).join('\n'));

// ---------- Runner ----------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const { values: args } = isMain ? parseArgs({ options: {
  out: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/s3') },
  from: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2') },
  s2: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/s2/runs/S2') },
  skills: { type: 'string', default: join(homedir(), '.claude/skills') },
  batch: { type: 'string', default: 'S3' },
  snapshot: { type: 'string', default: 'bin-f' },
  seeds: { type: 'string', default: '1,2,3' },
  tasks: { type: 'string' },
  concurrency: { type: 'string', default: '4' },
  'min-free-gib': { type: 'string', default: '6' },  // no edits here, so 3 is the lowest allowed (as run.mjs)
  'run-cap-usd': { type: 'string', default: '5' },
  'run-timeout-min': { type: 'string', default: '25' },
  'total-budget-usd': { type: 'string', default: '1000' },
  'copy-skills': { type: 'boolean', default: false },
  // S3b: no copied user skills (no --add-dir), so only Claude Code's bundled skills are listed.
  'bundled-only': { type: 'boolean', default: false },
  // S3b's power: simulate from these S3 runs instead of S2's.
  'power-from': { type: 'string' },
  register: { type: 'boolean', default: false },
  power: { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
  analyze: { type: 'boolean', default: false },
  'strict-rubrics': { type: 'string' },
  summary: { type: 'string' },
  csv: { type: 'string' },
} }) : { values: {} };

const OUT = args.out;
const PIDS = OUT && join(OUT, 'pids.json');
const LEDGER = OUT && join(OUT, 'ledger.jsonl');
const SKILLS_HOME = OUT && join(OUT, 'skills-home');
const WORK = OUT && join(WORK_ROOT, `s3-${sha(OUT).slice(0, 8)}`);
const RUNNER_HASH = sha(RUNNER_FILES.map(file => readFileSync(join(HERE, file), 'utf8')).join('\0'));

async function oneRun(job, batchDir, ctx) {
  const { task, arm, seed } = job;
  const { worker } = task;
  const id = `${task.set}__${task.id}__${worker}__s${seed}__${arm}`;
  const runDir = join(batchDir, id);
  if (existsSync(join(runDir, 'run.json'))) return { skipped: true };
  const message = workerMessage(ctx.report.text, workerPrompt(task, ctx.base), '');
  const flag = armFlag(arm, worker, ctx.lists);
  const record = { id, set: task.set, task: task.id, kind: task.kind ?? task.set, worker, arm, seed, model: ctx.saver.workerModel, group: job.group, armOrder: job.order, flag, startedAt: new Date().toISOString(), hashes: { message: sha(message), report: ctx.report.sha256, look: sha(ctx.look), reuse: sha(ctx.reuse), skills: ctx.skillsHash, runner: RUNNER_HASH } };
  if (task.set === 'loc') record.gold = task.gold;
  return measuredRun({
    runDir, ledger: LEDGER, workRoot: WORK, batch: args.batch, id, capUsd: Number(args['run-cap-usd']), record,
    body: async (work, held) => {
      record.agentFilesRemoved = await checkout(task, work, { from: args.from });
      // BASE: explore plus the agent-made tools as workers had them before round 18: bin-f lists
      // list, save and run with their full descriptions, and an empty store sends no Project tools note.
      const store = join(dirname(work), 'tools');
      const tools = arm === 'BASE' ? { test: TOOLS_SERVE_TEST, env: { PANDACODE_BENCH_TOOLS: store, PANDACODE_BENCH_PROJECT: 'bench-s3', PANDACODE_BENCH_SESSION: id, PANDACODE_BENCH_NOTE: join(runDir, 'note.txt') } } : undefined;
      if (tools) mkdirSync(store, { recursive: true });
      const explore = await readyExplore(ctx.server, work, runDir, PIDS, tools);
      held.server = explore.server;
      const argv = [...harnessArgs({ arm: 'after', model: ctx.saver.workerModel, config: explore.config, instructions: { after: arm === 'BASE' ? `${ctx.look}\n\n${ctx.reuse}` : ctx.look }, runBudget: Number(args['run-cap-usd']) }), flag, ...(args['bundled-only'] ? [] : ['--add-dir', SKILLS_HOME])];
      const stream = join(runDir, 'stream.jsonl');
      const run = await runClaude([message], work, stream, argv, Number(args['run-timeout-min']) * 60_000, {}, PIDS);
      const { stepText, stepUsage, ...metric } = metrics(readFileSync(stream, 'utf8'));
      Object.assign(record, { wallMs: run.wallMs, exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr, billedUsd: metric.costUsd ?? 0, ...metric });
      const pinned = ctx.base.harness.models[ctx.saver.workerModel];
      if (record.init?.model && record.init.model !== pinned) ctx.aborted = `model resolved to ${record.init.model}, pinned ${pinned}`;
      // The skills must be listed while Skill is on; a BASE run without them would measure nothing.
      const problem = launchProblem(arm, record.init, ctx.copied, { bundledOnly: args['bundled-only'] });
      if (problem) ctx.aborted = `${id}: ${problem}`;
      record.grade = task.set === 'loc' ? gradeLocalization({ ...metric, stepText }, task.gold) : scoreRubric(metric.answer, task.rubric, task.kind);
      record.success = !run.timedOut && !metric.isError && (task.set !== 'loc' || record.grade.answered);
    },
  });
}

const readRuns = dir => readdirSync(dir).filter(name => existsSync(join(dir, name, 'run.json'))).map(name => JSON.parse(readFileSync(join(dir, name, 'run.json'), 'utf8')));

function analyzeMain(batchDir, saver, base) {
  const strict = args['strict-rubrics'] && Object.fromEntries(JSON.parse(readFileSync(args['strict-rubrics'], 'utf8')).report.map(t => [t.id, t]));
  const kept = readRuns(batchDir).filter(r => r.init?.model === base.harness.models[saver.workerModel]);
  const runs = strict ? blindRescore(kept, strict) : kept;
  const summary = { ...analyze(runs), absolute: absoluteSaving(runs) };
  if (args.summary) writeFileSync(args.summary, `${JSON.stringify(summary, null, 1)}\n`);
  if (args.csv) {
    const cols = ['id', 'task', 'set', 'worker', 'arm', 'seed', 'billedUsd', 'steps', 'wallMs'];
    const rows = runs.sort((a, b) => a.id.localeCompare(b.id)).map(r => [...cols.map(c => r[c]), r.tokens?.input, r.tokens?.cacheRead, r.tokens?.cacheWrite, r.tokens?.output, r.firstStep?.cacheRead, r.firstStep?.cacheWrite, r.init?.tools?.length, r.init?.skills?.length, r.tools?.explore, (r.tools?.BashSearch ?? 0) + (r.tools?.BashOther ?? 0), r.grade?.recall, r.grade?.precision].join(','));
    writeFileSync(args.csv, `${[...cols, 'input', 'cacheRead', 'cacheWrite', 'output', 'firstRead', 'firstWrite', 'tools', 'skills', 'explore', 'bash', 'recall', 'precision'].join(',')}\n${rows.join('\n')}\n`);
  }
  console.log(JSON.stringify(summary, null, 1));
}

async function main() {
  const { s2, saver, base, tasks: all } = loadS2();
  const tasks = args.tasks ? all.filter(t => args.tasks.split(',').includes(t.id)) : all;
  const seeds = args.smoke ? [99] : args.seeds.split(',').map(Number);
  const batchDir = join(OUT, 'runs', args.smoke ? `smoke-${args.batch}` : args.batch);
  if (args.analyze) return analyzeMain(batchDir, saver, base);
  if (args.power && args['power-from']) {
    const { costs, observedSd } = s3Costs(readRuns(args['power-from']).filter(r => r.init?.model === base.harness.models[saver.workerModel]));
    const tau = Math.sqrt(Math.max(0, observedSd ** 2 - resampledSd(costs) ** 2));
    const grid = spread => Object.fromEntries([1, 2, 3].map(n => [n, Object.fromEntries([0, -0.05, -0.08].map(e => [e, power(costs, { effect: e, seeds: n, spread })]))]));
    return console.log(JSON.stringify({ s3Units: costs.length, observedSd, resampledSd: resampledSd(costs), tau, units: 56, reps: 400, test: 'normal-approximation Wilcoxon, CI 2000 rounds', spread: { [tau.toFixed(3)]: grid(tau), [(2 * tau).toFixed(3)]: grid(2 * tau) } }));
  }
  if (args.power) {
    const costs = s2Costs(args.s2);
    const grid = spread => Object.fromEntries([1, 2, 3].map(n => [n, Object.fromEntries([0, -0.05, -0.1].map(e => [e, power(costs, { effect: e, seeds: n, spread })]))]));
    return console.log(JSON.stringify({ s2Tasks: costs.length, units: 56, reps: 400, test: 'normal-approximation Wilcoxon, CI 2000 rounds', spread: { [S2_SPREAD]: grid(S2_SPREAD), [2 * S2_SPREAD]: grid(2 * S2_SPREAD) } }));
  }
  if (args.register) return console.log(JSON.stringify(register({ batch: args.batch, doc: 'docs/worker-tokens-benchmark.md', pins: ['tasks-s2.json', 'tasks-saver.json', 'tasks.json', 's3.mjs'] })));
  if (args['copy-skills']) {
    // A copy of the user's skills only: no settings, hooks, plugins or memory.
    rmSync(SKILLS_HOME, { recursive: true, force: true });
    // Links that point nowhere (a skill uninstalled elsewhere) are left out, as Claude Code lists nothing for them.
    cpSync(args.skills, join(SKILLS_HOME, '.claude', 'skills'), { recursive: true, dereference: true, filter: src => existsSync(src) });
    return console.log(JSON.stringify({ skills: readdirSync(join(SKILLS_HOME, '.claude', 'skills')).length, sha256: treeHash(SKILLS_HOME) }));
  }
  const groups = tasks.flatMap(task => WORKERS.map(worker => ({ ...task, worker })));
  const jobsOf = batchSeed => assignJobs(groups, seeds, ARMS, batchSeed);
  if (args.plan) return console.log(JSON.stringify({ units: groups.length, seeds, runs: jobsOf(1).length, estimateUsd: Number((jobsOf(1).length * s2.estimateUsdPerRun * 1.1).toFixed(2)) }));
  if (!(Number(args['min-free-gib']) >= 3)) throw new Error('--min-free-gib may not go below 3: other tasks share this disk');
  mkdirSync(OUT, { recursive: true });
  process.env.PATH = `${join(args.from, 'harness')}:${process.env.PATH}`;
  assertExplorable(WORK);
  stopChildrenOnSignal();
  const harness = (await must('claude', ['--version'], { env: safeEnv() })).trim();
  if (harness !== s2.harness) throw new Error(`harness is ${harness}, S3 pins ${s2.harness}`);
  if (sha(JSON.stringify(PRE_R18)) !== S2_LISTS_SHA) throw new Error('PRE_R18 is not the S2 LEAN launch');
  const server = join(args.from, args.snapshot, 'explore-serve');
  const serverHash = sha(readFileSync(server));
  if (serverHash !== s2.exploreBinary) throw new Error(`explore snapshot ${args.snapshot} is ${serverHash.slice(0, 12)}, S3 pins ${s2.exploreBinary.slice(0, 12)}`);
  if (!args['bundled-only'] && !existsSync(join(SKILLS_HOME, '.claude', 'skills'))) throw new Error('run s3.mjs --copy-skills first');
  const report = findWorkerReport(architectSources());
  const lists = newLists();
  // Bundled-only: no copy is loaded, and the user's own skill names are the ones that must not be listed.
  const skillsHash = args['bundled-only'] ? 'none' : treeHash(SKILLS_HOME);
  const copied = new Set(readdirSync(args['bundled-only'] ? args.skills : join(SKILLS_HOME, '.claude', 'skills')));
  const ctx = { saver, base, lists, report: { ...report, sha256: sha(report.text) }, look: exploreClause(), reuse: reuseClause(), server, skillsHash, copied, aborted: null };
  claimRunner({ out: OUT, pids: PIDS, ledger: LEDGER, work: WORK });
  mkdirSync(batchDir, { recursive: true });
  const batchSeed = args.smoke ? 99 : pinnedSeed(join(batchDir, 'batch.json'), { harness, exploreBinary: serverHash, lists: sha(JSON.stringify(lists)), skills: skillsHash, report: ctx.report.sha256, look: sha(ctx.look), reuse: sha(ctx.reuse), tasksS2: sha(readFileSync(join(HERE, 'tasks-s2.json'))) }, RUNNER_HASH);
  await pool(jobsOf(batchSeed), {
    limit: Number(args.concurrency), batchDir, out: OUT, ledger: LEDGER, minFreeGiB: Number(args['min-free-gib']), budget: Number(args['total-budget-usd']),
    cap: () => Number(args['run-cap-usd']), diskNeed: job => (job.task.repo === 'vscode' ? 0.5 : 0.2),
    runOne: job => oneRun(job, batchDir, ctx), aborted: () => ctx.aborted,
    name: j => `${j.task.id}/${j.task.worker}/s${j.seed}/${j.arm}`,
    log: (r, { spentUsd, next, total }) => console.log(`${new Date().toISOString().slice(11, 19)} ${r.id} tools=${r.init?.tools?.length} skills=${r.init?.skills?.length} first=${r.firstStep?.cacheWrite} $${r.billedUsd?.toFixed(3)} spent=$${spentUsd.toFixed(2)} ${next}/${total}`),
  });
}

if (isMain) await main();
