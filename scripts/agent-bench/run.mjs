#!/usr/bin/env node
// Three-arm benchmark of pandacode_explore. Dev-only; see README.md.
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { appendLedger, ledgerTotals, readLedger, writeAtomic } from './ledger.mjs';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { DISK_WAIT_MS, REPO, WORK_ROOT, assertBuild, snapshotBuild, canStart, claimRunner, cloneTarget, gradeEdit, guardDisk, harnessArgs, isRust, measuredRun, pinDependencies, pinnedSeed, pool, readyExplore, reportedCost, runClaude, applyFix, applyStub, assertExplorable, freeGiB, materialize, must, overlayTests, repoDir, runCommand, safeEnv, seededJobs, sh, stopChildrenOnSignal, exploreClause, register, reuseClause, startExplore as startServer, TOOLS_SERVE_TEST, waitForFile } from './lib.mjs';
export { canStart, harnessArgs };
import { gradeLocalization, LONG_CONTEXT, metrics } from './metrics.mjs';
import { bootstrapCi, mean, random, wilcoxon } from './stats.mjs';
import { EDIT_STEPS_MARGIN, loadRuns, RECALL_MARGIN, simulateNonInferior } from './analyze.mjs';
export { simulateNonInferior };

const HERE = dirname(fileURLToPath(import.meta.url));
const BASE_TASKS = JSON.parse(readFileSync(join(HERE, 'tasks.json'), 'utf8'));
// Held-out tasks were fixed before batch E and are never used for tuning; only `--heldout` runs them.
const HELDOUT = JSON.parse(readFileSync(join(HERE, 'tasks-heldout.json'), 'utf8'));
const TASKS = { ...BASE_TASKS, repos: { ...BASE_TASKS.repos, ...HELDOUT.repos } };
const ALL_LOCALIZATION = [...TASKS.localization, ...HELDOUT.localization];
// Changing any of these changes what a run measures, so every run records their hash.
const RUNNER_FILES = ['run.mjs', 'lib.mjs', 'metrics.mjs', 'ledger.mjs'];
const ARMS = ['before', 'instruction', 'after'];
// Batch Fv2's third arm: AFTER with batch E's LOOK (from E's snapshot, --look-e), on edit sets only.
const EDIT_ONLY_ARMS = ['after-e'];
// Per-run caps, well over what v1 runs cost: the budget check reserves them for every run in flight.
const RUN_BUDGET = { loc: 1, edit: 1, edit2: 1, long: 2, reuse: 1 };
// --run-cap-usd scales them (batch E deviation 3: no run may be cut short by its cap); long context gets twice it.
const runCap = (set, model) => RUN_BUDGET[set] * Number(args['run-cap-usd']) * (model === 'opus' ? 5 : 1);
// reuse: per chain of 3 runs, at R1's registered $3 for 12 runs.
const ESTIMATE = { loc: 0.17, edit: 0.17, edit2: 0.17, long: 0.86, reuse: 0.75 };  // batch E's billed mean per run (edit2: assumed as edit)
// Long-context runs: the filler turn must be read from cache at the task's first step.
const LONG_WARM_MIN = 0.8 * LONG_CONTEXT;

const { values: args } = parseArgs({ options: {
  out: { type: 'string', default: join(homedir(), 'Library/Caches/pandacode-bench/v2') },
  batch: { type: 'string', default: 'A' },
  'batch-seed': { type: 'string' },     // recorded in batch.json; a resumed batch reuses it
  set: { type: 'string', default: 'loc,edit' },
  arm: { type: 'string', default: ARMS.join(',') },
  tasks: { type: 'string' },
  seeds: { type: 'string' },            // "1,2"; default 2 per task
  model: { type: 'string', default: 'sonnet' },
  concurrency: { type: 'string', default: '4' },
  'min-free-gib': { type: 'string', default: '6' },
  snapshot: { type: 'string', default: 'bin' },          // explore server snapshot dir: one per engine version
  'server-profile': { type: 'string', default: 'fast-release' },  // the shipped opt-level, without LTO
  'build-dir': { type: 'string' },                       // CARGO_TARGET_DIR for --prepare
  'look-e': { type: 'string', default: 'bin-e' },          // --prepare: the snapshot whose LOOK the after-e arm gets
  'no-long': { type: 'boolean', default: false },         // smoke without the long-context probe
   // other tasks share this disk; never go below 6
  'run-timeout-min': { type: 'string', default: '25' },
  'total-budget-usd': { type: 'string', default: '60' },
  'run-cap-usd': { type: 'string', default: '1' },       // per-run --max-budget-usd for loc and edit; long gets 2x
  prepare: { type: 'boolean', default: false },
  sanity: { type: 'boolean', default: false },
  smoke: { type: 'boolean', default: false },
  plan: { type: 'boolean', default: false },
  status: { type: 'boolean', default: false },
  'check-tasks': { type: 'boolean', default: false },
  heldout: { type: 'boolean', default: false },          // add tasks-heldout.json to the localization set
  'edit-v2': { type: 'boolean', default: false },
  // Pre-registrations and deviations (results/preregistrations.jsonl): --register F --doc docs/x.md --pins tasks.json,…
  register: { type: 'string' },
  doc: { type: 'string', default: 'docs/agent-loop-benchmark.md' },
  marker: { type: 'string' },            // default prereg:<batch>; deviation:<id> for a deviation
  pins: { type: 'string', default: '' },
  supersedes: { type: 'string' },
  note: { type: 'string' },
  // POST-HOC (round 17): P(pass) of each Fv2 gate with no effect and with a true loss, from BEFORE runs (docs, Fv2-2).
  simulate: { type: 'boolean', default: false },
  'sim-reps': { type: 'string', default: '1000' },
  'sim-runs': { type: 'string', default: ['v5-E.csv', 'v5-E2.csv', 'v6-Fv2.csv'].map(name => join(HERE, 'results', 'runs', name)).join(',') },
  force: { type: 'boolean', default: false },
} });

// Edit tasks v2 (batch F) are their own registered set with their own gate; only `--edit-v2` runs them.
const EDIT_V2_FILE = join(HERE, 'tasks-edit-v2.json');
const EDIT_V2 = args['edit-v2'] ? JSON.parse(readFileSync(EDIT_V2_FILE, 'utf8')) : null;
if (EDIT_V2) {
  const clash = EDIT_V2.edit.find(t => TASKS.edit.some(e => e.id === t.id));
  if (clash) throw new Error(`tasks-edit-v2.json reuses the id ${clash.id}`);
  for (const [repo, source] of Object.entries(EDIT_V2.repos ?? {})) {
    if (TASKS.repos[repo] && JSON.stringify(TASKS.repos[repo]) !== JSON.stringify(source)) throw new Error(`tasks-edit-v2.json redefines the repo ${repo}`);
    TASKS.repos[repo] = source;
  }
}
const isEditSet = set => set === 'edit' || set === 'edit2' || set === 'reuse';

// Batch R1 (--set reuse): one job is a chain of these edit2 tasks in this order, by one arm and seed,
// sharing one tool store and project id; each task is its own harness process (a new thread).
export const REUSE_CHAIN = ['e2-boat-trial-ttl', 'e2-pnpm-global-bin', 'e2-do-ssh-key'];
export const REUSE_CHECK = 'Before you finish, check your change from src-tauri: run cargo fmt on the files you changed, then cargo check --lib, then cargo test --lib with the module you changed as the filter.';
export const REUSE_ARMS = ['none', 'tools'];
const REUSE_PROJECT = 'bench-r1';
/** The chain as one job's task; null unless every chain task is in `tasks`. */
export const reuseChain = tasks => {
  const chain = REUSE_CHAIN.map(id => tasks.find(task => task.id === id));
  return chain.every(Boolean) ? { id: 'r1-chain', repo: 'pandacode', test: chain[0].test, chain } : null;
};
/** An R1 task's message: the prompt, the shared check chain, then the catalog note as the app appends it. */
export const reuseMessage = (task, note = '') => `${task.prompt}\n\n${REUSE_CHECK}${note}`;
/** Calls of the agent-made tools in a transcript. */
export function customToolCalls(text) {
  const calls = { list: 0, save: 0, run: 0 };
  for (const line of text.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    if (event.type !== 'assistant' || event.parent_tool_use_id) continue;
    for (const block of event.message?.content ?? []) {
      const kind = block.type === 'tool_use' && block.name.match(/pandacode_tool_(list|save|run)$/)?.[1];
      if (kind) calls[kind]++;
    }
  }
  return calls;
}
/** Names of the project tools in an R1 store. */
export const storedTools = (store, project = REUSE_PROJECT) => {
  const dir = join(store, 'projects', project);
  return existsSync(dir) ? readdirSync(dir).filter(file => file.endsWith('.json') && !file.startsWith('.')).map(file => file.slice(0, -5)).sort() : [];
};
// With the edits, --edit-v2 adds its set; alone (long context, for batch.json's pins) it adds nothing.
if (EDIT_V2 && args.set.split(',').includes('edit') && !args.set.split(',').includes('edit2')) args.set += ',edit2';

const MIN_FREE_GIB = Number(args['min-free-gib']);
// Runs that only check out a tree may go down to 3 GiB; anything that builds Rust keeps the 6 GiB floor.
if (MIN_FREE_GIB < 3 || (MIN_FREE_GIB < 6 && args.set.split(',').some(isEditSet))) throw new Error('--min-free-gib may not go below 6 with edits, or 3 without: other tasks share this disk');
// What a run may still write: a Rust edit rebuilds the crate in its clone; others hold one checkout.
const diskNeed = job => (isEditSet(job.set) && isRust(job.task) ? RUST_RUN_GIB : job.task.repo === 'vscode' ? 0.5 : 0.2);
const OUT = args.out;
const BIN = join(OUT, args.snapshot, 'explore-serve');
const META = join(OUT, args.snapshot, 'meta.json');
const PIDS = join(OUT, 'pids.json');
const LEDGER = join(OUT, 'ledger.jsonl');
const HARNESS_DIR = join(OUT, 'harness');
process.env.PATH = `${HARNESS_DIR}:${process.env.PATH}`;
const sha = text => createHash('sha256').update(text).digest('hex');
// Checkouts, sanity trees and explore roots, one folder per --out (see WORK_ROOT in lib.mjs).
const WORK = assertExplorable(join(WORK_ROOT, `run-${sha(OUT).slice(0, 8)}`));
const RUNNER_HASH = sha(RUNNER_FILES.map(file => readFileSync(join(HERE, file), 'utf8')).join('\0'));
const loadMeta = () => JSON.parse(readFileSync(META, 'utf8'));
/** The build inputs --prepare snapshotted, or null for a snapshot prepared before round 17. */
const preparedBuild = () => (existsSync(META) ? loadMeta().build ?? null : null);
const RUST_RUN_GIB = 1.5;

/** A deterministic filler of about `chars` characters, identical in every run and arm. */
export function fillerText(chars, seed = 0x5eed) {
  const words = 'the a to of and in is it for on with as that this by from at be are was were build test file line code run task note value order state report change check update branch commit server client request response token cache index search module function'.split(' ');
  const next = random(seed);
  const lines = [];
  let length = 0;
  for (let n = 1; length < chars; n++) {
    const line = `Note ${n}: ${Array.from({ length: 14 }, () => words[Math.floor(next() * words.length)]).join(' ')}.`;
    lines.push(line);
    length += line.length + 1;
  }
  return lines.join('\n');
}

// ---------- Gate calibration (POST-HOC, written after Fv2's results; docs deviation Fv2-2) ----------

/** Per task, BEFORE's values of `get`, one list per task, from runs of `set`s (held-out tasks left out). */
export function beforeValues(runs, sets, get) {
  const mine = runs.filter(r => r.arm === 'before' && sets.includes(r.set) && !r.tags?.includes('held-out'));
  return [...new Set(mine.map(r => r.task))].sort().map(task => mine.filter(r => r.task === task).map(get).filter(x => x != null));
}

/**
 * P(Fv2's edit-steps non-superiority test passes) when AFTER's true change in steps is `effect`
 * (+0.10 = 10% more steps): per task, BEFORE's mean steps times per-run noise resampled from all
 * BEFORE edit runs (each run over its task's mean, widened by sqrt(n/(n-1))), `seeds` runs per arm, and
 * editStepsGate's rule (one-sided Wilcoxon on change − margin, p < 0.05, and the CI's top below it).
 */
export function simulateEditSteps({ values, effect = 0, margin = EDIT_STEPS_MARGIN, seeds = 2, reps = 400, rounds = 2000, seed = 0x57e9 }) {
  const next = random(seed);
  const base = values.map(list => mean(list));
  const noise = values.flatMap((list, i) => (list.length > 1 ? list.map(x => 1 + (x / base[i] - 1) * Math.sqrt(list.length / (list.length - 1))) : []));
  const run = (b, shift) => { let sum = 0; for (let s = 0; s < seeds; s++) sum += b * (1 + shift) * noise[Math.floor(next() * noise.length)]; return sum / seeds; };
  let passes = 0;
  for (let rep = 0; rep < reps; rep++) {
    const rel = base.map(b => run(b, effect) / run(b, 0) - 1);
    const ci = bootstrapCi(rel, rounds, (seed + rep * 7919) >>> 0);
    if (wilcoxon(rel.map(x => x - margin), { side: 'less' }) < 0.05 && ci[1] < margin) passes++;
  }
  return passes / reps;
}

/** Every Fv2 gate with no effect and with a true loss of 0.10 (10% more steps for the edit-steps test). */
export function gateCalibration(runs, { reps = 1000 } = {}) {
  const quality = [
    ['recall (tuned, 20 tasks)', ['loc'], r => r.grade?.recall ?? 0, 'score'],
    ['precision (tuned, 20 tasks)', ['loc'], r => r.grade?.precision ?? 0, 'score'],
    ['edit pass (6 edits)', ['edit'], r => (r.success ? 1 : 0), 'rate'],
    ['edit pass, edit2 (14 tasks)', ['edit2'], r => (r.success ? 1 : 0), 'rate'],
  ];
  const rows = quality.map(([gate, sets, get, kind]) => {
    const values = beforeValues(runs, sets, get);
    const row = { gate, tasks: values.length, beforeRuns: values.reduce((n, l) => n + l.length, 0), margin: RECALL_MARGIN, noEffect: simulateNonInferior({ values, kind, reps }), trueLoss10: simulateNonInferior({ values, kind, effect: -0.1, reps }) };
    // Shrinkage pulls a task BEFORE always passed toward 0.5; observed rates are the other bound.
    return kind === 'rate' ? { ...row, observedRates: { noEffect: simulateNonInferior({ values, kind, reps, shrink: false }), trueLoss10: simulateNonInferior({ values, kind, effect: -0.1, reps, shrink: false }) } } : row;
  });
  const steps = beforeValues(runs, ['edit', 'edit2'], r => r.steps);
  const stepReps = Math.min(reps, 400);
  rows.push({ gate: 'edit steps non-superiority (20 tasks)', tasks: steps.length, beforeRuns: steps.reduce((n, l) => n + l.length, 0), margin: EDIT_STEPS_MARGIN,
    noEffect: simulateEditSteps({ values: steps, reps: stepReps }), trueLoss10: simulateEditSteps({ values: steps, effect: 0.1, reps: stepReps }), trueGain10: simulateEditSteps({ values: steps, effect: -0.1, reps: stepReps }) });
  return { label: 'POST-HOC calibration, written after Fv2\'s results were known', design: 'Fv2: 2 seeds per arm, registered margins, bootstrap 2000 rounds', reps, stepReps, rows };
}

async function fetchTree(repo, commit, depth = 1) {
  const dir = repoDir(repo, OUT);
  // A blobless clone would otherwise fetch blobs one at a time inside `git archive`.
  await must('git', ['-C', dir, 'fetch', '-q', '--no-filter', `--depth=${depth}`, 'origin', commit]);
}

async function prepare() {
  mkdirSync(dirname(BIN), { recursive: true });
  mkdirSync(join(OUT, 'repos'), { recursive: true });
  // The pinned harness, kept apart from the user's own claude, which updates itself.
  mkdirSync(HARNESS_DIR, { recursive: true });
  const pinned = join(process.env.HOME, '.local/share/claude/versions', TASKS.harness.version);
  if (!existsSync(join(HARNESS_DIR, 'claude')) && existsSync(pinned)) await must('cp', ['-c', pinned, join(HARNESS_DIR, 'claude')]);
  // The app ships an optimized build, so the server must be one too: a debug binary inflates tool time.
  const profile = args['server-profile'];
  const env = { ...process.env, CARGO_INCREMENTAL: '0', ...(args['build-dir'] ? { CARGO_TARGET_DIR: args['build-dir'] } : {}) };
  const stdout = await must('cargo', ['test', '--lib', '--no-run', '--message-format=json', '--profile', profile], { cwd: join(REPO, 'src-tauri'), env });
  const built = stdout.split('\n').flatMap(line => {
    try { const m = JSON.parse(line); return m.executable && m.profile?.test ? [m] : []; } catch { return []; }
  })[0];
  if (!built) throw new Error('no test binary');
  const executable = built.executable;
  const server = { profile, optLevel: built.profile.opt_level, debugAssertions: built.profile.debug_assertions };
  if (server.optLevel === '0') throw new Error('the explore server must be an optimized build');
  copyFileSync(executable, BIN);
  chmodSync(BIN, 0o755);
  const sources = (await must('git', ['-C', REPO, 'ls-files', '-c', '-o', '--exclude-standard', 'src-tauri/src/explore', 'src-tauri/src/explore.rs', 'src-tauri/src/workspace/secret_paths.rs', 'src-tauri/src/providers/mcp_host.rs', 'src-tauri/src/lib.rs'])).trim().split('\n').sort();
  const hash = createHash('sha256');
  for (const file of sources) hash.update(readFileSync(join(REPO, file)));
  const clause = exploreClause();
  const lookE = lookOf(join(OUT, args['look-e'], 'meta.json'));
  const meta = {
    server, binaryHash: sha(readFileSync(BIN)), sourcesHash: hash.digest('hex'), sourceFiles: sources.length,
    // none and tools are batch R1's arms: AFTER's LOOK, and LOOK then REUSE as app_instructions joins them.
    instructions: { after: clause, instruction: TASKS.instructionOnly, none: clause, tools: `${clause}\n\n${reuseClause()}`, ...(lookE ? { 'after-e': lookE.text } : {}) },
    ...(lookE ? { afterE: { snapshot: args['look-e'], binaryHash: lookE.binaryHash, lookSha256: sha(lookE.text) } } : {}),
    harness: (await must('claude', ['--version'], { env: safeEnv() })).trim(),
    // Round 17 on: the manifests Rust edits build with, copied here, and the target's dependencies, pinned.
    build: snapshotBuild(join(dirname(BIN), 'build')),
  };
  writeFileSync(META, JSON.stringify(meta, null, 2));
  for (const repo of Object.keys(TASKS.repos)) await syncRepo(repo);
  console.log(meta);
}

/** The AFTER instruction a prepared snapshot recorded (batch E's LOOK for the after-e arm), or null. */
export function lookOf(metaFile) {
  if (!existsSync(metaFile)) return null;
  const meta = JSON.parse(readFileSync(metaFile, 'utf8'));
  return meta.instructions?.after ? { text: meta.instructions.after, binaryHash: meta.binaryHash } : null;
}

/** Clones a public repo if missing and fetches every task's parent tree. */
async function syncRepo(repo) {
  const source = TASKS.repos[repo];
  const dir = repoDir(repo, OUT);
  if (!existsSync(dir)) await must('git', ['clone', '-q', '--bare', '--filter=blob:none', `--depth=${source.depth}`, source.url, dir]);
  for (const task of ALL_LOCALIZATION.filter(t => t.repo === repo)) {
    await must('git', ['-C', dir, 'cat-file', '-e', `${task.commit}^`]).catch(() => { throw new Error(`${task.id}: ${task.commit}^ is not in the clone`); });
    await fetchTree(repo, (await must('git', ['-C', dir, 'rev-parse', `${task.commit}^`])).trim());
  }
  // Edit tasks also read the commit's own tests and fix. Depth 2 fetches the commit and its parent
  // whole; depth 1 would mark the commit shallow and cut off its parent for every later --prepare.
  for (const task of (EDIT_V2?.edit ?? []).filter(t => t.repo === repo)) {
    await fetchTree(repo, task.commit, 2);
    await must('git', ['-C', dir, 'cat-file', '-e', `${task.commit}^`]).catch(() => { throw new Error(`${task.id}: ${task.commit}^ is not in the clone`); });
  }
}

const GOLD_SKIP = /^(docs\/|.*\.md$|.*\.lock$|package-lock\.json$|yarn\.lock$|website\/|releases\/|playwright\.[^/]*$)/;
/** Gold is what the source commit changed that already existed at its parent. */
export const goldFromStatus = status => status.trim().split('\n').map(line => line.split('\t')).filter(([state, path]) => state !== 'A' && !GOLD_SKIP.test(path)).map(([, path]) => path).sort();

async function checkTasks() {
  let problems = 0;
  const complain = (id, text) => { problems++; console.log(`PROBLEM ${id}: ${text}`); };
  const coverage = {};
  for (const repo of Object.keys(TASKS.repos)) if (!existsSync(repoDir(repo, OUT))) await syncRepo(repo);
  const ids = ALL_LOCALIZATION.map(t => t.id);
  for (const id of ids.filter((id, i) => ids.indexOf(id) !== i)) complain(id, 'duplicate id across task files');
  for (const task of ALL_LOCALIZATION) {
    const dir = repoDir(task.repo, OUT);
    const status = await must('git', ['-C', dir, 'diff-tree', '--no-commit-id', '--name-status', '--no-renames', '-r', '-m', '--first-parent', task.commit]);
    const gold = goldFromStatus(status);
    if (JSON.stringify(gold) !== JSON.stringify([...task.gold].sort())) complain(task.id, `gold differs from ${task.commit}: ${gold.join(' ')}`);
    for (const path of task.gold) {
      const exists = await sh('git', ['-C', dir, 'cat-file', '-e', `${task.commit}^:${path}`]);
      if (exists.status !== 0) complain(task.id, `${path} does not exist at the parent`);
      if (task.prompt.includes(path)) complain(task.id, `prompt names ${path}`);
    }
    for (const tag of task.tags ?? []) coverage[tag] = (coverage[tag] ?? 0) + 1;
    console.log(`${task.id.padEnd(28)} ${task.commit} ${String(task.gold.length).padStart(2)} files  ${(task.tags ?? []).join(',')}`);
  }
  console.log('coverage', coverage, 'tasks', TASKS.localization.length, 'held out', HELDOUT.localization.length, 'problems', problems);
  if (problems) process.exitCode = 1;
}

/** Each edit task must fail at parent + tests, fail again with only the symbols stubbed, and pass with the fix. */
async function sanity(selected) {
  const file = join(OUT, 'sanity.json');
  const report = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : {};
  // One path for all tasks, so cargo replaces the crate's artifacts instead of adding another copy.
  const dir = join(WORK, 'sanity', 'current');
  for (const task of selected) {
    const gitDir = repoDir(task.repo, OUT);
    const parent = (await must('git', ['-C', gitDir, 'rev-parse', `${task.commit}^`])).trim();
    const fresh = async () => {
      rmSync(dir, { recursive: true, force: true, maxRetries: 3 });
      // Other repos (Hono) install nothing: Bun runs their tests as they are.
      await materialize(gitDir, parent, dir, { nodeModules: gitDir === REPO, prepare: isRust(task) ? tree => pinDependencies(tree, preparedBuild()?.dir) : null });
      for (const path of TASKS.repos[task.repo]?.prune ?? []) rmSync(join(dir, path), { recursive: true, force: true });
    };
    const target = isRust(task) ? join(WORK, 'sanity', 'target') : null;
    if (target) { const build = preparedBuild(); assertBuild(build); await cloneTarget(target, build?.target); }
    await fresh();
    await overlayTests(task, dir, gitDir);
    const before = await runCommand(task.test, dir, target, 40 * 60_000);
    let stubbed = null;
    if (task.stub?.length) {
      await fresh();
      applyStub(task.stub, dir);
      await overlayTests(task, dir, gitDir);
      stubbed = await runCommand(task.test, dir, target, 40 * 60_000);
    }
    await fresh();
    await applyFix(task, parent, dir, gitDir);
    const fixed = await runCommand(task.test, dir, target, 40 * 60_000);
    const suite = task.suite ? await runCommand(task.suite, dir, target, 40 * 60_000) : null;
    const noStubNeeded = !task.stub?.length && before.kind === 'assertion';
    const mutationCaught = noStubNeeded || stubbed?.kind === 'assertion';
    const verdict = before.kind !== 'pass' && mutationCaught && fixed.pass ? 'ok' : 'EXCLUDE';
    report[task.id] = {
      verdict, parent: before.kind, parentFailed: before.failed, stub: stubbed?.kind ?? (noStubNeeded ? 'not needed' : 'missing'), stubFailed: stubbed?.failed ?? [],
      fix: fixed.kind, suiteBaselineFailed: suite?.failed ?? [], suiteMs: suite?.ms ?? 0,
    };
    console.log(task.id, verdict, JSON.stringify({ parent: before.kind, stub: report[task.id].stub, fix: fixed.kind, suiteFailed: suite?.failed.length }));
    writeAtomic(file, JSON.stringify(report, null, 2));
    rmSync(join(WORK, 'sanity'), { recursive: true, force: true, maxRetries: 3 });
    if (freeGiB(OUT) < MIN_FREE_GIB) throw new Error('low disk');
  }
}

const startExplore = (root, runDir) => startServer(BIN, root, runDir, PIDS);

let aborted = null;
function checkHarness(record) {
  const expected = TASKS.harness.models[record.model];
  if (record.init?.model && record.init.model !== expected) aborted = `model resolved to ${record.init.model}, pinned ${expected}`;
  if (record.init?.version && record.init.version !== TASKS.harness.version) aborted = `harness is ${record.init.version}, pinned ${TASKS.harness.version}`;
}
const usesExplore = arm => ['after', 'after-e', 'none', 'tools'].includes(arm);

/** What one run records before it starts: identity, arm order, and the hash of everything it measures with. */
function runRecord({ task, set, arm, seed, model, order, group }, id, meta) {
  return {
    id, set, task: task.id, arm, seed, model, group, armOrder: order, startedAt: new Date().toISOString(), warmTurns: set === 'long' ? 1 : 0,
    repo: task.repo ?? 'pandacode', sourceCommit: task.commit, gold: task.gold,
    server: usesExplore(arm) ? meta.server ?? { profile: 'test (debug)', optLevel: '0' } : null,
    hashes: { instruction: arm === 'before' ? null : sha(meta.instructions[arm]), binary: usesExplore(arm) ? meta.binaryHash : null, sources: meta.sourcesHash, runner: RUNNER_HASH,
      ...(meta.build ? { cargoLock: meta.build.cargoLockSha256, cargoToml: meta.build.cargoTomlSha256, deps: meta.build.deps?.sha256 } : {}) },
  };
}

/** The task's parent tree in `work`, pruned; for a Rust edit, also its clone of the dependency cache. */
async function checkout(task, set, work, record, build = null) {
  const gitDir = repoDir(task.repo, OUT);
  record.commit = (await must('git', ['-C', gitDir, 'rev-parse', `${task.commit}^`])).trim();
  const rust = isEditSet(set) && isRust(task);
  record.agentFilesRemoved = await materialize(gitDir, record.commit, work, { nodeModules: isEditSet(set) && gitDir === REPO, prepare: rust ? tree => pinDependencies(tree, build?.dir) : null });
  for (const path of TASKS.repos[task.repo]?.prune ?? []) rmSync(join(work, path), { recursive: true, force: true });
  const target = rust ? join(dirname(work), 'target') : null;
  if (target) { assertBuild(build); await cloneTarget(target, build?.target); }
  return { gitDir, target };
}

/** The agent's turn(s) in `work`, measured from its transcript. */
async function agentTurn({ task, set, arm, model, message }, work, runDir, target, config, meta, record) {
  const prompt = message ?? (isEditSet(set) ? task.prompt : `${task.prompt}\n\n${TASKS.localizationSuffix}`);
  record.hashes.prompt = sha(prompt);
  const filler = set === 'long' ? `Background notes for later. Do not use any tool. Reply only with OK.\n\n${fillerText(TASKS.long.fillerChars)}` : null;
  if (filler) record.hashes.filler = sha(filler);
  const argv = harnessArgs({ arm, model, config, instructions: meta.instructions, runBudget: runCap(set, model) });
  const stream = join(runDir, 'stream.jsonl');
  // The agent builds in its own clone of the warmed dependency cache, kept outside the checkout.
  const run = await runClaude(filler ? [filler, prompt] : [prompt], work, stream, argv, Number(args['run-timeout-min']) * 60_000, target ? { CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' } : {}, PIDS);
  const text = readFileSync(stream, 'utf8');
  const { stepUsage, ...metric } = metrics(text, { skip: record.warmTurns });
  Object.assign(record, { wallMs: run.wallMs, exitCode: run.code, timedOut: run.timedOut, stderr: run.stderr, billedUsd: reportedCost(text) ?? 0, ...metric });
  delete record.stepText;
  checkHarness(record);
  if (set === 'long') record.longContext = { firstStepCacheRead: metric.firstStep.cacheRead, valid: metric.firstStep.cacheRead >= LONG_WARM_MIN };
  return { run, metric };
}

async function oneRun(job, batchDir, meta, verified) {
  const { task, set, arm, seed, model } = job;
  const id = `${set}__${task.id}__${model}__s${seed}__${arm}`;
  const runDir = join(batchDir, id);
  const record = runRecord(job, id, meta);
  const store = set === 'reuse' ? join(batchDir, `${arm}-s${seed}`, 'tools') : null;
  return measuredRun({
    runDir, ledger: LEDGER, workRoot: WORK, batch: basename(batchDir), id, capUsd: runCap(set, model), record, force: args.force,
    body: async (work, held) => {
      const { gitDir, target } = await checkout(task, set, work, record, meta.build);
      // R1's TOOLS server runs tools with the agent's own build cache, as the app's tools inherit its environment.
      const tools = arm === 'tools' && store ? {
        test: TOOLS_SERVE_TEST,
        env: { PANDACODE_BENCH_TOOLS: store, PANDACODE_BENCH_PROJECT: REUSE_PROJECT, PANDACODE_BENCH_SESSION: id, PANDACODE_BENCH_NOTE: join(runDir, 'note.txt'), ...(target ? { CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' } : {}) },
      } : undefined;
      if (tools) mkdirSync(store, { recursive: true });
      const explore = usesExplore(arm) ? await readyExplore(BIN, work, runDir, PIDS, tools) : null;
      held.server = explore?.server;
      const note = tools ? readFileSync(join(runDir, 'note.txt'), 'utf8') : '';
      if (store) record.reuse = { position: job.position, chain: `${arm}-s${seed}`, note: note.length > 0, toolsBefore: storedTools(store) };
      const turn = store ? { ...job, message: reuseMessage(task, note) } : job;
      const { run, metric } = await agentTurn(turn, work, runDir, target, explore?.config ?? null, meta, record);
      if (store) Object.assign(record.reuse, { calls: customToolCalls(readFileSync(join(runDir, 'stream.jsonl'), 'utf8')), toolsAfter: storedTools(store) });
      if (isEditSet(set)) {
        record.grade = await gradeEdit(task, work, target, verified, gitDir);
        record.success = record.grade.pass;
      } else {
        record.grade = gradeLocalization(metric, task.gold);
        record.success = record.grade.answered && !run.timedOut && !metric.isError;
      }
    },
  });
}

/** An R1 chain: its tasks in order, each skipped if already finished; stops if the batch aborts. */
async function chainRun(job, batchDir, meta, verified) {
  let last = { skipped: true };
  for (const [index, task] of job.task.chain.entries()) {
    if (aborted) break;
    const result = await oneRun({ ...job, task, position: index + 1 }, batchDir, meta, verified);
    if (!result.skipped) last = result;
  }
  return last;
}

/** Arms a group runs: edit-only arms (after-e) are dropped from other sets. */
export const armsFor = (arms, set) => arms.filter(arm => isEditSet(set) || !EDIT_ONLY_ARMS.includes(arm));

/** Every arm order is equally likely per task and seed, from the batch's recorded seed. */
export function buildJobs(selected, seedsFor, arms, model, batchSeed) {
  const groups = Object.entries(selected).flatMap(([set, tasks]) => tasks.flatMap(task => seedsFor(set).map(seed => ({ task, set, seed }))));
  return seededJobs(groups, g => armsFor(arms, g.set), batchSeed).map(job => ({ ...job, model }));
}

function status() {
  const totals = ledgerTotals(readLedger(LEDGER));
  const runs = join(OUT, 'runs');
  const batches = existsSync(runs) ? readdirSync(runs).map(name => ({ batch: name, finished: readdirSync(join(runs, name)).filter(run => existsSync(join(runs, name, run, 'run.json'))).length })) : [];
  console.log(JSON.stringify({ ...totals, open: totals.open.map(a => a.id), batches }, null, 1));
}

function runBatch(jobs, batchDir, meta, verified) {
  return pool(jobs, {
    limit: Number(args.concurrency), batchDir, out: OUT, ledger: LEDGER, minFreeGiB: MIN_FREE_GIB, budget: Number(args['total-budget-usd']),
    cap: job => runCap(job.set, job.model) * (job.task.chain?.length ?? 1), diskNeed, writes: job => isEditSet(job.set) && isRust(job.task),
    runOne: job => (job.task.chain ? chainRun : oneRun)(job, batchDir, meta, verified), aborted: () => aborted,
    name: j => `${j.set}/${j.task.id}/s${j.seed}/${j.arm}`,
    log: (r, { spentUsd, next, total }) => console.log(`${new Date().toISOString().slice(11, 19)} ${r.id} ok=${r.success} steps=${r.steps} $${r.billedUsd?.toFixed(3)} explore=${r.tools?.explore} spent=$${spentUsd.toFixed(2)} ${next}/${total}`),
  });
}

/** A batch keeps its seed, tool snapshot and task list for life, so a resumed batch can't mix versions. */
function batchSeed(batchDir, meta) {
  const pins = {
    binaryHash: meta.binaryHash, sourcesHash: meta.sourcesHash, harness: meta.harness, tasksHash: sha(readFileSync(join(HERE, 'tasks.json'))),
    heldoutHash: args.heldout ? sha(readFileSync(join(HERE, 'tasks-heldout.json'))) : undefined,
    editV2Hash: EDIT_V2 ? sha(readFileSync(EDIT_V2_FILE)) : undefined,
    // Batches with the after-e arm also pin its LOOK text.
    afterELookSha256: args.arm.split(',').includes('after-e') ? meta.afterE?.lookSha256 : undefined,
    // Round 17 on: the build inputs of Rust edits.
    cargoLockSha256: meta.build?.cargoLockSha256, cargoTomlSha256: meta.build?.cargoTomlSha256, depsSha256: meta.build?.deps?.sha256,
  };
  return pinnedSeed(join(batchDir, 'batch.json'), pins, RUNNER_HASH, args['batch-seed']);
}

/** Waits, starting nothing, while a run's checkout would take the disk under the floor. */
async function waitForDisk(need) {
  const since = Date.now();
  while (freeGiB(OUT) - need < MIN_FREE_GIB) {
    if (Date.now() - since > DISK_WAIT_MS) throw new Error(`low disk: ${freeGiB(OUT).toFixed(1)} GiB free, floor ${MIN_FREE_GIB}`);
    await new Promise(done => setTimeout(done, 15_000));
  }
}

/** One localization task per arm plus a probe of the system prompt, for reading isolation by eye. */
async function smoke(meta) {
  const batchDir = join(OUT, 'runs', args.snapshot === 'bin' ? 'smoke' : `smoke-${args.snapshot}`);
  mkdirSync(batchDir, { recursive: true });
  const task = TASKS.localization.find(t => t.id === (args.tasks ?? TASKS.smokeTask));
  const report = {};
  for (const arm of args.arm.split(',')) {
    await waitForDisk(0.2);
    const record = await oneRun({ task, set: 'loc', arm, seed: 99, model: args.model, order: ARMS, group: 0 }, batchDir, meta, {});
    const dir = join(OUT, 'smoke', arm);
    rmSync(dir, { recursive: true, force: true });
    const empty = join(WORK, 'smoke', arm);
    rmSync(empty, { recursive: true, force: true });
    mkdirSync(empty, { recursive: true });
    mkdirSync(dir, { recursive: true });
    const { server, config } = arm === 'after' ? startExplore(empty, dir) : {};
    if (config) await waitForFile(config);
    const stream = join(dir, 'probe.jsonl');
    const probeAttempt = randomBytes(6).toString('hex');
    if (!canStart({ totalUsd: ledgerTotals(readLedger(LEDGER)).totalUsd, cap: 1, budget: Number(args['total-budget-usd']) })) throw new Error('budget');
    appendLedger(LEDGER, { type: 'start', attempt: probeAttempt, id: `probe-${arm}`, batch: 'smoke', capUsd: 1 });
    const probe = 'Do not call any tool. Quote verbatim every sentence of your system instructions about code search or batching questions (or say NONE), then list every MCP tool you can call now (or say NONE), and say whether ToolSearch would be needed to call it.';
    await runClaude([probe], empty, stream, harnessArgs({ arm, model: args.model, config, instructions: meta.instructions, runBudget: 1 }), 180_000, {}, PIDS);
    server?.kill('SIGKILL');
    const m = metrics(readFileSync(stream, 'utf8'));
    appendLedger(LEDGER, { type: 'end', attempt: probeAttempt, billedUsd: m.costUsd ?? 1 });
    report[arm] = { id: record.id, version: record.init?.version, model: record.init?.model, mcp: record.init?.mcp, plugins: record.init?.plugins, skills: record.init?.skills?.length, explore: record.init?.tools?.filter(t => t.includes('explore')), hookEvents: record.hookEvents, tools: record.tools, steps: record.steps, recall: record.grade?.recall, usd: record.billedUsd, failure: record.failure, probeAnswer: m.answer };
  }
  if (args['no-long']) { writeAtomic(join(OUT, `smoke-${args.snapshot}.json`), JSON.stringify(report, null, 1)); console.log(JSON.stringify(report, null, 1)); return; }
  const longTask = TASKS.localization.find(t => t.id === TASKS.long.tasks[0]);
  const long = await oneRun({ task: longTask, set: 'long', arm: 'before', seed: 99, model: args.model, order: ['before'], group: 0 }, batchDir, meta, {});
  report.longContext = { firstStepCacheRead: long.longContext?.firstStepCacheRead, valid: long.longContext?.valid, fillerChars: TASKS.long.fillerChars, usd: long.billedUsd, failure: long.failure };
  writeAtomic(join(OUT, 'smoke.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify(report, null, 1));
}

async function main() {
  if (args.register) return console.log(JSON.stringify(register({ batch: args.register, doc: args.doc, marker: args.marker, pins: args.pins.split(',').filter(Boolean), supersedes: args.supersedes, note: args.note })));
  if (args.simulate) return console.log(JSON.stringify(gateCalibration(loadRuns(args['sim-runs'].split(','), 'sonnet'), { reps: Number(args['sim-reps']) }), null, 1));
  mkdirSync(OUT, { recursive: true });
  if (args.status) return status();
  stopChildrenOnSignal();
  if (args.prepare) return prepare();
  if (args['check-tasks']) return checkTasks();
  const wanted = args.smoke ? null : args.tasks?.split(',');
  const pick = list => (wanted ? list.filter(task => wanted.includes(task.id)) : list);
  if (args.sanity) { guardDisk(OUT, MIN_FREE_GIB, () => true); return sanity(pick([...TASKS.edit, ...(EDIT_V2?.edit ?? [])])); }
  const sanityFile = join(OUT, 'sanity.json');
  const verified = existsSync(sanityFile) ? JSON.parse(readFileSync(sanityFile, 'utf8')) : {};
  const sets = args.set.split(',');
  const selected = {};
  if (sets.includes('loc')) selected.loc = pick(args.heldout ? ALL_LOCALIZATION : TASKS.localization);
  if (sets.includes('edit')) selected.edit = pick(TASKS.edit).filter(task => args.plan || verified[task.id]?.verdict === 'ok');
  if (sets.includes('edit2')) {
    if (!EDIT_V2) throw new Error('the edit2 set needs --edit-v2');
    selected.edit2 = pick(EDIT_V2.edit).filter(task => args.plan || verified[task.id]?.verdict === 'ok');
  }
  if (sets.includes('long')) selected.long = TASKS.localization.filter(task => TASKS.long.tasks.includes(task.id));
  if (sets.includes('reuse')) {
    if (!EDIT_V2) throw new Error('the reuse set needs --edit-v2');
    const chain = reuseChain(EDIT_V2.edit.filter(task => args.plan || verified[task.id]?.verdict === 'ok'));
    if (!chain) throw new Error(`the reuse chain needs every one of ${REUSE_CHAIN.join(', ')} with sanity verdict ok`);
    selected.reuse = [chain];
  }
  const seedsFor = set => (set === 'long' ? [1] : args.seeds ? args.seeds.split(',').map(Number) : [1, 2]);
  const arms = sets.includes('long') ? ['before', 'after'] : sets.includes('reuse') ? REUSE_ARMS : args.arm.split(',');
  if (args.plan) {
    const jobs = buildJobs(selected, seedsFor, arms, args.model, 1);
    const count = set => jobs.filter(j => j.set === set).length;
    const estimate = Object.keys(selected).reduce((sum, set) => sum + count(set) * ESTIMATE[set], 0);
    console.log(JSON.stringify({ batch: args.batch, runs: Object.fromEntries(Object.keys(selected).map(set => [set, count(set)])), estimateUsd: Number(estimate.toFixed(2)) }));
    return;
  }
  if (!existsSync(META)) throw new Error('run --prepare first');
  const meta = loadMeta();
  if (meta.harness !== `${TASKS.harness.version} (Claude Code)`) throw new Error(`harness is ${meta.harness}, pinned ${TASKS.harness.version}`);
  const live = (await must('claude', ['--version'], { env: safeEnv() })).trim();
  if (live !== meta.harness) throw new Error(`harness changed since --prepare: ${live}`);
  claimRunner({ out: OUT, pids: PIDS, ledger: LEDGER, work: WORK });
  // A stop must hand the disk straight back; a resume needs nothing from these checkouts.
  process.on('exit', () => rmSync(WORK, { recursive: true, force: true, maxRetries: 2 }));
  if (args.smoke) return smoke(meta);
  if (sets.some(isEditSet) && !Object.keys(verified).length) throw new Error('run --sanity first');
  if (sets.some(isEditSet)) assertBuild(meta.build);
  const batchDir = join(OUT, 'runs', args.batch);
  mkdirSync(batchDir, { recursive: true });
  const seed = batchSeed(batchDir, meta);
  if (arms.includes('tools') && !meta.instructions.tools) throw new Error('the reuse set needs --prepare from a runner that records the tools text');
  if (arms.includes('after-e') && !meta.instructions['after-e']) throw new Error(`the after-e arm needs --prepare with --look-e (no ${args['look-e']}/meta.json)`);
  await runBatch(buildJobs(selected, seedsFor, arms, args.model, seed), batchDir, meta, verified);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
