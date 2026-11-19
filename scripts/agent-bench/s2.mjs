#!/usr/bin/env node
// Batch S2: what trimming a read-only team worker's native Claude Code tools saves. Dev-only.
// Method, pre-registration and results: docs/worker-tokens.md.
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { REPO, WORK_ROOT, assertExplorable, claimRunner, exploreClause, harnessArgs, measuredRun, must, pinnedSeed, pool, readyExplore, register, runClaude, safeEnv, stopChildrenOnSignal } from './lib.mjs';
import { blindRescore } from './analyze.mjs';
import { gradeLocalization, metrics, scoreRubric } from './metrics.mjs';
import { architectSources, assignJobs, checkout, findWorkerReport, loadTasks, workerMessage, workerPrompt } from './saver.mjs';
import { bootstrapCi, holm, mean, wilcoxon } from './stats.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const sha = text => createHash('sha256').update(text).digest('hex');
export const ARMS = ['BASE', 'LEAN'];
const RUNNER_FILES = ['s2.mjs', 'saver.mjs', 'lib.mjs', 'metrics.mjs', 'ledger.mjs'];

/** The app's own `--disallowedTools` lists, read from providers.rs. */
export function deniedTools(source = readFileSync(join(REPO, 'src-tauri/src/providers.rs'), 'utf8')) {
  const read = name => {
    const m = source.match(new RegExp(`const ${name}: &str = "([^"]*)";`));
    if (!m) throw new Error(`no ${name} in providers.rs`);
    return m[1];
  };
  return { session: read('CLAUDE_SESSION_BOUND_TOOLS'), worker: read('CLAUDE_WORKER_DENIED_TOOLS'), readOnly: read('CLAUDE_READ_ONLY_DENIED_TOOLS') };
}

/** BASE: the launch every task had before; LEAN: a read-only worker's launch (`claude_disallowed_tools(Some(true))`). */
export const armFlag = (arm, lists) => `--disallowedTools=${(arm === 'LEAN' ? [lists.session, lists.worker, lists.readOnly] : [lists.session]).join(',')}`;

/** The S2 tasks: S1's localization and report tasks, as read-only workers. */
export function loadS2(file = join(HERE, 'tasks-s2.json')) {
  const s2 = JSON.parse(readFileSync(file, 'utf8'));
  const { saver, base, tasks } = loadTasks();
  const wanted = new Set([...s2.loc, ...s2.report]);
  const picked = tasks.filter(t => wanted.has(t.id));
  if (picked.length !== wanted.size) throw new Error('tasks-s2.json names a task tasks-saver.json lacks');
  return { s2, saver, base, tasks: picked };
}

// ---------- Analysis ----------

/** Quality of one run on its own scale: loc recall/precision, report rubric recall. */
const quality = r => (r.set === 'loc'
  ? { recall: r.grade?.recall ?? 0, precision: r.grade?.precision ?? 0 }
  : { rubric: r.grade?.recall ?? 0 });
const inputCache = r => (r.tokens ? r.tokens.input + r.tokens.cacheRead + r.tokens.cacheWrite : 0);
const MEASURES = {
  billedUsd: r => r.billedUsd ?? 0,
  firstStepCacheWrite: r => r.firstStep?.cacheWrite ?? 0,
  inputCacheTokens: inputCache,
  outputTokens: r => r.tokens?.output ?? 0,
  steps: r => r.steps ?? 0,
  wallMs: r => r.wallMs ?? 0,
};

/** Per-task means per arm, then BASE → LEAN per-task relative changes and quality differences. */
export function analyze(runs) {
  const byTask = new Map();
  for (const r of runs) {
    if (!byTask.has(r.task)) byTask.set(r.task, { set: r.set, BASE: [], LEAN: [] });
    byTask.get(r.task)[r.arm]?.push(r);
  }
  const paired = [...byTask.entries()].filter(([, t]) => t.BASE.length && t.LEAN.length);
  const avg = (list, f) => mean(list.map(f));
  const table = {};
  for (const [name, f] of Object.entries(MEASURES)) {
    const base = paired.map(([, t]) => avg(t.BASE, f));
    const lean = paired.map(([, t]) => avg(t.LEAN, f));
    const rel = base.map((b, i) => (b ? lean[i] / b - 1 : 0));
    const ci = bootstrapCi(rel);
    table[name] = { base: mean(base), lean: mean(lean), relMean: mean(rel), ci, p: wilcoxon(base.map((b, i) => lean[i] - b)) };
  }
  // Primary: cost. Secondaries: first-step write and input+cache, Holm-adjusted together.
  const [p1, p2] = holm([table.firstStepCacheWrite.p, table.inputCacheTokens.p]);
  table.firstStepCacheWrite.pHolm = p1;
  table.inputCacheTokens.pHolm = p2;
  const gates = {};
  for (const [key, set] of [['recall', 'loc'], ['precision', 'loc'], ['rubric', 'report']]) {
    const tasks = paired.filter(([, t]) => t.set === set);
    const diff = tasks.map(([, t]) => avg(t.LEAN, r => quality(r)[key]) - avg(t.BASE, r => quality(r)[key]));
    const ci = bootstrapCi(diff);
    gates[key] = { tasks: tasks.length, base: mean(tasks.map(([, t]) => avg(t.BASE, r => quality(r)[key]))), lean: mean(tasks.map(([, t]) => avg(t.LEAN, r => quality(r)[key]))), diff: mean(diff), ci };
  }
  return { tasks: paired.length, runs: runs.length, table, quality: gates, tools: Object.fromEntries(ARMS.map(arm => [arm, [...new Set(runs.filter(r => r.arm === arm).map(r => r.init?.tools?.length))]])) };
}

/**
 * Main-agent tool calls per arm, from each run's `tools` (metrics.mjs counts only the main agent's
 * tool_use blocks): explore calls, Bash calls (search and other), and runs with any Bash call.
 */
export function toolCounts(runs) {
  const bash = r => (r.tools?.BashSearch ?? 0) + (r.tools?.BashOther ?? 0);
  const sum = (list, f) => list.reduce((n, r) => n + f(r), 0);
  return Object.fromEntries([...new Set(runs.map(r => r.arm))].sort().map(arm => {
    const mine = runs.filter(r => r.arm === arm);
    return [arm, { runs: mine.length, explore: sum(mine, r => r.tools?.explore ?? 0), bash: sum(mine, bash), bashSearch: sum(mine, r => r.tools?.BashSearch ?? 0), runsWithBash: mine.filter(r => bash(r) > 0).length }];
  }));
}

// ---------- Runner ----------

const isMain = process.argv[1] === fileURLToPath(import.meta.url);
const { values: args } = isMain ? parseArgs({ options: {
  out: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/s2') },
  from: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2') },
  batch: { type: 'string', default: 'S2' },
  snapshot: { type: 'string', default: 'bin-f' },
  seeds: { type: 'string', default: '1,2,3' },
  tasks: { type: 'string' },
  concurrency: { type: 'string', default: '4' },
  'run-cap-usd': { type: 'string', default: '5' },
  'run-timeout-min': { type: 'string', default: '25' },
  'total-budget-usd': { type: 'string', default: '1000' },
  register: { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
  analyze: { type: 'boolean', default: false },
  tools: { type: 'boolean', default: false },  // with --analyze: main-agent tool calls per arm
  'strict-rubrics': { type: 'string' },  // with --analyze, POST-HOC: rescore report answers with these rubrics (blindRescore)
  summary: { type: 'string' },
  csv: { type: 'string' },
} }) : { values: {} };

const OUT = args.out;
const FROM = args.from;
const PIDS = OUT && join(OUT, 'pids.json');
const LEDGER = OUT && join(OUT, 'ledger.jsonl');
const WORK = OUT && join(WORK_ROOT, `s2-${sha(OUT).slice(0, 8)}`);
const RUNNER_HASH = sha(RUNNER_FILES.map(file => readFileSync(join(HERE, file), 'utf8')).join('\0'));

async function oneRun(job, batchDir, ctx) {
  const { task, arm, seed } = job;
  const id = `${task.set}__${task.id}__s${seed}__${arm}`;
  const runDir = join(batchDir, id);
  if (existsSync(join(runDir, 'run.json'))) return { skipped: true };
  const message = workerMessage(ctx.report.text, workerPrompt(task, ctx.base), '');
  const flag = armFlag(arm, ctx.lists);
  const record = { id, set: task.set, task: task.id, kind: task.kind ?? task.set, arm, seed, model: ctx.saver.workerModel, group: job.group, armOrder: job.order, flag, startedAt: new Date().toISOString(), hashes: { message: sha(message), report: ctx.report.sha256, look: sha(ctx.look), runner: RUNNER_HASH } };
  if (task.set === 'loc') record.gold = task.gold;
  return measuredRun({
    runDir, ledger: LEDGER, workRoot: WORK, batch: args.batch, id, capUsd: Number(args['run-cap-usd']), record,
    body: async (work, held) => {
      record.agentFilesRemoved = await checkout(task, work, { from: FROM });
      const explore = await readyExplore(ctx.server, work, runDir, PIDS);
      held.server = explore.server;
      const argv = [...harnessArgs({ arm: 'after', model: ctx.saver.workerModel, config: explore.config, instructions: { after: ctx.look }, runBudget: Number(args['run-cap-usd']) }), flag];
      const stream = join(runDir, 'stream.jsonl');
      const run = await runClaude([message], work, stream, argv, Number(args['run-timeout-min']) * 60_000, {}, PIDS);
      const { stepText, stepUsage, ...metric } = metrics(readFileSync(stream, 'utf8'));
      Object.assign(record, { wallMs: run.wallMs, exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr, billedUsd: metric.costUsd ?? 0, ...metric });
      const pinned = ctx.base.harness.models[ctx.saver.workerModel];
      if (record.init?.model && record.init.model !== pinned) ctx.aborted = `model resolved to ${record.init.model}, pinned ${pinned}`;
      record.grade = task.set === 'loc' ? gradeLocalization({ ...metric, stepText }, task.gold) : scoreRubric(metric.answer, task.rubric, task.kind);
      record.success = !run.timedOut && !metric.isError && (task.set !== 'loc' || record.grade.answered);
    },
  });
}

const readRuns = dir => readdirSync(dir).filter(name => existsSync(join(dir, name, 'run.json'))).map(name => JSON.parse(readFileSync(join(dir, name, 'run.json'), 'utf8')));

async function main() {
  const { s2, saver, base, tasks: all } = loadS2();
  const tasks = args.tasks ? all.filter(t => args.tasks.split(',').includes(t.id)) : all;
  const seeds = args.smoke ? [99] : args.seeds.split(',').map(Number);
  const batchDir = join(OUT, 'runs', args.smoke ? `smoke-${args.batch}` : args.batch);
  if (args.analyze) {
    const strict = args['strict-rubrics'] && Object.fromEntries(JSON.parse(readFileSync(args['strict-rubrics'], 'utf8')).report.map(t => [t.id, t]));
    const kept = readRuns(batchDir).filter(r => r.init?.model === base.harness.models[saver.workerModel]);
    const runs = strict ? blindRescore(kept, strict) : kept;
    const summary = args.tools ? toolCounts(runs) : analyze(runs);
    if (args.summary) writeFileSync(args.summary, `${JSON.stringify(summary, null, 1)}\n`);
    if (args.csv) {
      const cols = ['id', 'task', 'set', 'arm', 'seed', 'billedUsd', 'steps', 'wallMs'];
      const rows = runs.sort((a, b) => a.id.localeCompare(b.id)).map(r => [...cols.map(c => r[c]), r.tokens?.input, r.tokens?.cacheRead, r.tokens?.cacheWrite, r.tokens?.output, r.firstStep?.cacheRead, r.firstStep?.cacheWrite, r.init?.tools?.length, r.grade?.recall, r.grade?.precision].join(','));
      writeFileSync(args.csv, `${[...cols, 'input', 'cacheRead', 'cacheWrite', 'output', 'firstRead', 'firstWrite', 'tools', 'recall', 'precision'].join(',')}\n${rows.join('\n')}\n`);
    }
    return console.log(JSON.stringify(summary, null, 1));
  }
  if (args.register) {
    const entry = register({ batch: args.batch, doc: 'docs/worker-tokens.md', pins: ['tasks-s2.json', 'tasks-saver.json', 'tasks.json', 's2.mjs'] });
    return console.log(JSON.stringify(entry));
  }
  const jobs = assignJobs(tasks, seeds, ARMS, 1);
  if (args.plan) return console.log(JSON.stringify({ tasks: tasks.length, seeds, runs: jobs.length, estimateUsd: Number((jobs.length * s2.estimateUsdPerRun).toFixed(2)) }));
  mkdirSync(OUT, { recursive: true });
  process.env.PATH = `${join(FROM, 'harness')}:${process.env.PATH}`;
  assertExplorable(WORK);
  stopChildrenOnSignal();
  const harness = (await must('claude', ['--version'], { env: safeEnv() })).trim();
  if (harness !== s2.harness) throw new Error(`harness is ${harness}, S2 pins ${s2.harness}`);
  const server = join(FROM, args.snapshot, 'explore-serve');
  const serverHash = sha(readFileSync(server));
  if (serverHash !== s2.exploreBinary) throw new Error(`explore snapshot ${args.snapshot} is ${serverHash.slice(0, 12)}, S2 pins ${s2.exploreBinary.slice(0, 12)}`);
  const report = findWorkerReport(architectSources());
  const ctx = { saver, base, lists: deniedTools(), report: { ...report, sha256: sha(report.text) }, look: exploreClause(), server, aborted: null };
  claimRunner({ out: OUT, pids: PIDS, ledger: LEDGER, work: WORK });
  mkdirSync(batchDir, { recursive: true });
  const batchSeed = args.smoke ? 99 : pinnedSeed(join(batchDir, 'batch.json'), { harness, exploreBinary: serverHash, lists: sha(JSON.stringify(ctx.lists)), tasksS2: sha(readFileSync(join(HERE, 'tasks-s2.json'))) }, RUNNER_HASH);
  await pool(assignJobs(tasks, seeds, ARMS, batchSeed), {
    limit: Number(args.concurrency), batchDir, out: OUT, ledger: LEDGER, minFreeGiB: 6, budget: Number(args['total-budget-usd']),
    cap: () => Number(args['run-cap-usd']), diskNeed: job => (job.task.repo === 'vscode' ? 0.5 : 0.2),
    runOne: job => oneRun(job, batchDir, ctx), aborted: () => ctx.aborted,
    name: j => `${j.task.id}/s${j.seed}/${j.arm}`,
    log: (r, { spentUsd, next, total }) => console.log(`${new Date().toISOString().slice(11, 19)} ${r.id} tools=${r.init?.tools?.length} first=${r.firstStep?.cacheWrite} $${r.billedUsd?.toFixed(3)} spent=$${spentUsd.toFixed(2)} ${next}/${total}`),
  });
}

if (isMain) await main();
