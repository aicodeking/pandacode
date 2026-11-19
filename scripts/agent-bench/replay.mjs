// Replays every `pandacode_explore` call of the recorded AFTER runs against the current engine,
// on the same pinned trees, with no model time. It measures what the engine changes: reply bytes,
// empty searches inside a glob, call time, and gold files in the replies. Gold is a smoke test,
// not a quality measure: most gold files are named in the call's own arguments, so `earned`
// counts, per run, only gold a reply showed to a call that did not name it. Usage:
//   node scripts/agent-bench/replay.mjs [--runs <dir,...>] [--bin <test binary>] [--save out.json] [--compare base.json]
//     [--tasks a,b] [--dump replies.jsonl] [--gap-ms 3000: the model's time between calls]
import { spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { parseArgs } from 'node:util';
import { fileURLToPath } from 'node:url';
import { assertExplorable, freeGiB, REPO, repoDir, safeEnv, WORK_ROOT } from './lib.mjs';
import { mentions } from './metrics.mjs';

// Recorded runs, repos and the replay's scratch trees all live in the bench cache, never /tmp.
const CACHE = join(homedir(), 'Library/Caches/pandacode-bench');
const OUT = join(CACHE, 'v2');
const MIN_FREE_GIB = 3;
const read = name => JSON.parse(readFileSync(join(REPO, 'scripts/agent-bench', name), 'utf8'));
/** Tuned and held-out tasks together: batch E onward recorded both, and each run names its task. */
export const mergeTasks = (...sets) => ({ repos: Object.assign({}, ...sets.map(set => set.repos)), localization: sets.flatMap(set => set.localization) });
const TASKS = mergeTasks(read('tasks.json'), read('tasks-heldout.json'));

/** The explore calls of one transcript, in order, with the reply text each got. */
export function exploreCalls(streamText) {
  const calls = [];
  const byId = new Map();
  for (const line of streamText.split('\n')) {
    let event;
    try { event = JSON.parse(line); } catch { continue; }
    for (const block of event.message?.content ?? []) {
      if (event.type === 'assistant' && block.type === 'tool_use' && String(block.name).endsWith('pandacode_explore')) {
        const call = { args: block.input ?? {}, reply: null };
        byId.set(block.id, call);
        calls.push(call);
      }
      if (event.type === 'user' && block.type === 'tool_result' && byId.has(block.tool_use_id)) {
        const content = block.content;
        byId.get(block.tool_use_id).reply = typeof content === 'string' ? content : (content ?? []).map(part => part.text ?? '').join('');
      }
    }
  }
  return calls;
}

/** Gold files that some reply names. */
export const goldShown = (gold, replies) => gold.filter(path => replies.some(reply => mentions(reply ?? '', path)));

/** Gold that some reply showed to a call whose own arguments did not name it. */
export const goldEarned = (gold, calls) => gold.filter(path => calls.some(({ args, reply }) => !mentions(JSON.stringify(args ?? {}), path) && mentions(reply ?? '', path)));

/** Earned gold of each run that the same run no longer earns, as `task run N: path` (N from 1). */
export const lostEarned = (task, before, now) => before.flatMap((paths, run) => paths.filter(path => !(now[run] ?? []).includes(path)).map(path => `${task} run ${run + 1}: ${path}`));

/** Searches that asked for a glob and found nothing in it, and how many of those the reply still answers. */
export function emptyGlobSearches(calls) {
  let empty = 0;
  let answered = 0;
  for (const { args, reply } of calls) {
    if (!args.glob?.length && typeof args.glob !== 'string') continue;
    let value;
    try { value = JSON.parse(reply); } catch { continue; }
    for (const search of value.search ?? []) {
      if (search.matches !== 0) continue;
      empty++;
      if (search.outside_glob?.hits?.length) answered++;
    }
  }
  return { empty, answered };
}

const median = values => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
};

/** The recorded AFTER localization runs, grouped by task. */
function recordedRuns(dirs) {
  const tasks = new Map();
  for (const dir of dirs) {
    for (const name of readdirSync(dir)) {
      if (!name.startsWith('loc__') || !name.endsWith('__after')) continue;
      const stream = join(dir, name, 'stream.jsonl');
      if (!existsSync(stream)) continue;
      const calls = exploreCalls(readFileSync(stream, 'utf8'));
      const id = name.split('__')[1];
      if (!tasks.has(id)) tasks.set(id, []);
      tasks.get(id).push({ run: name, calls });
    }
  }
  return tasks;
}

function testBinary() {
  const built = spawnSync('cargo', ['test', '--lib', '--no-run', '--message-format=json'], {
    cwd: join(REPO, 'src-tauri'), encoding: 'utf8', maxBuffer: 1 << 28, env: { ...process.env, CARGO_INCREMENTAL: '0' },
  });
  const executable = built.stdout.split('\n').flatMap(line => {
    try { const m = JSON.parse(line); return m.executable && m.profile?.test ? [m.executable] : []; } catch { return []; }
  })[0];
  if (!executable) throw new Error(`no test binary: ${built.stderr.slice(-800)}`);
  return executable;
}

/** The task's tree at its source commit's parent, as the runner made it, with a `.git` so gitignore applies. */
function materialize(task, dir) {
  assertExplorable(dir);
  const gitDir = repoDir(task.repo, OUT);
  const parent = spawnSync('git', ['-C', gitDir, 'rev-parse', `${task.commit}^`], { encoding: 'utf8' }).stdout.trim();
  mkdirSync(dir, { recursive: true });
  const archive = spawnSync('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', gitDir, parent, dir], { encoding: 'utf8' });
  if (archive.status !== 0) throw new Error(`${task.id}: ${archive.stderr}`);
  for (const path of TASKS.repos[task.repo]?.prune ?? []) rmSync(join(dir, path), { recursive: true, force: true });
  mkdirSync(join(dir, '.git'), { recursive: true });
}

/** Runs one recorded run's calls in one fresh process, as its server did. */
function replayRun(bin, root, calls, scratch, gapMs = 0) {
  const input = join(scratch, 'in.jsonl');
  const output = join(scratch, 'out.jsonl');
  writeFileSync(input, calls.map(call => JSON.stringify(call.args)).join('\n'));
  rmSync(output, { force: true });
  const run = spawnSync(bin, ['explore::oracle::explore_replay', '--exact', '--ignored', '--test-threads=1'], {
    env: safeEnv({ PANDACODE_REPLAY_ROOT: root, PANDACODE_REPLAY_IN: input, PANDACODE_REPLAY_OUT: output, PANDACODE_REPLAY_GAP_MS: String(gapMs) }), encoding: 'utf8', maxBuffer: 1 << 26,
  });
  if (run.status !== 0 || !existsSync(output)) throw new Error(`replay failed: ${run.stdout.slice(-800)}${run.stderr.slice(-800)}`);
  return readFileSync(output, 'utf8').split('\n').filter(Boolean).map(line => JSON.parse(line));
}

function summarize(task, runs, replayed) {
  const recordedReplies = runs.flatMap(run => run.calls.map(call => call.reply));
  const replies = replayed.flatMap(run => run.map(call => call.text));
  const replayCalls = runs.flatMap((run, r) => run.calls.map((call, c) => ({ args: call.args, reply: replayed[r][c].text })));
  const firstCallMs = replayed.map(run => run[0]?.ms ?? 0);
  return {
    task: task.id, repo: task.repo ?? 'pandacode', runs: runs.length, calls: replies.length, gold: task.gold.length,
    recordedBytes: recordedReplies.reduce((sum, reply) => sum + (reply?.length ?? 0), 0),
    replayBytes: replies.reduce((sum, reply) => sum + reply.length, 0),
    goldRecorded: goldShown(task.gold, recordedReplies), goldReplayed: goldShown(task.gold, replies),
    earnedRecorded: runs.map(run => goldEarned(task.gold, run.calls)),
    earnedReplayed: runs.map((run, r) => goldEarned(task.gold, run.calls.map((call, c) => ({ args: call.args, reply: replayed[r][c].text })))),
    emptyGlob: emptyGlobSearches(replayCalls), emptyGlobRecorded: emptyGlobSearches(runs.flatMap(run => run.calls)),
    errors: replayed.flat().filter(call => call.error).length,
    medianMs: median(replayed.flat().map(call => call.ms)), firstCallMs: median(firstCallMs),
  };
}

function report(rows, base) {
  const prior = new Map((base ?? []).map(row => [row.task, row]));
  const total = key => rows.reduce((sum, row) => sum + row[key], 0);
  const earned = (row, key) => row[key].reduce((sum, run) => sum + run.length, 0);
  console.log('task                         calls  recorded   replay    base  gold rec/now  earned rec/now  emptyGlob ans  first ms  median ms');
  for (const row of rows) {
    const was = prior.get(row.task);
    console.log(`${row.task.padEnd(28)} ${String(row.calls).padStart(5)} ${String(row.recordedBytes).padStart(9)} ${String(row.replayBytes).padStart(8)} ${String(was?.replayBytes ?? '').padStart(7)}  ${row.goldRecorded.length}/${row.goldReplayed.length} of ${row.gold}   ${String(earned(row, 'earnedRecorded')).padStart(5)}/${String(earned(row, 'earnedReplayed')).padEnd(5)}   ${String(row.emptyGlob.empty).padStart(4)} ${String(row.emptyGlob.answered).padStart(3)}  ${row.firstCallMs.toFixed(0).padStart(8)} ${row.medianMs.toFixed(0).padStart(9)}`);
  }
  // Against the base's per-run earned gold when it has it, else the recorded replies'.
  const earnedLost = rows.flatMap(row => lostEarned(row.task, prior.get(row.task)?.earnedReplayed ?? row.earnedRecorded, row.earnedReplayed));
  const lost = rows.flatMap(row => {
    const was = prior.get(row.task)?.goldReplayed ?? row.goldRecorded;
    return was.filter(path => !row.goldReplayed.includes(path)).map(path => `${row.task}: ${path}`);
  });
  const baseBytes = base ? base.reduce((sum, row) => sum + row.replayBytes, 0) : null;
  console.log(JSON.stringify({
    calls: total('calls'), recordedBytes: total('recordedBytes'), replayBytes: total('replayBytes'), baseBytes,
    change: baseBytes ? Number((total('replayBytes') / baseBytes - 1).toFixed(3)) : null,
    emptyGlob: rows.reduce((sum, row) => sum + row.emptyGlob.empty, 0), emptyGlobAnswered: rows.reduce((sum, row) => sum + row.emptyGlob.answered, 0),
    emptyGlobRecorded: rows.reduce((sum, row) => sum + row.emptyGlobRecorded.empty, 0), errors: total('errors'), goldLost: lost,
    earnedRecorded: rows.reduce((sum, row) => sum + earned(row, 'earnedRecorded'), 0), earnedReplayed: rows.reduce((sum, row) => sum + earned(row, 'earnedReplayed'), 0),
    earnedBase: base?.every(row => row.earnedReplayed) ? base.reduce((sum, row) => sum + earned(row, 'earnedReplayed'), 0) : null, earnedLost,
  }));
  return [...lost, ...earnedLost];
}

async function main() {
  const { values: args } = parseArgs({ options: {
    runs: { type: 'string', default: `${OUT}/runs/A,${OUT}/runs/B` }, bin: { type: 'string' }, save: { type: 'string' },
    compare: { type: 'string' }, tasks: { type: 'string' }, dump: { type: 'string' }, 'gap-ms': { type: 'string', default: '0' },
  } });
  const recorded = recordedRuns(args.runs.split(','));
  const bin = args.bin ?? testBinary();
  const only = args.tasks?.split(',');
  mkdirSync(CACHE, { recursive: true });
  // Trees are explore roots, so never under ~/Library (see WORK_ROOT in lib.mjs).
  mkdirSync(WORK_ROOT, { recursive: true });
  const scratch = mkdtempSync(join(assertExplorable(WORK_ROOT), 'replay-'));
  const rows = [];
  try {
    for (const task of TASKS.localization.filter(task => recorded.has(task.id) && (!only || only.includes(task.id)))) {
      if (freeGiB(CACHE) < MIN_FREE_GIB) throw new Error(`under ${MIN_FREE_GIB} GiB free`);
      const runs = recorded.get(task.id).filter(run => run.calls.length);
      const root = join(scratch, 'tree');
      materialize(task, root);
      try {
        const replayed = runs.map(run => replayRun(bin, root, run.calls, scratch, Number(args['gap-ms'])));
        rows.push(summarize(task, runs, replayed));
        if (args.dump) appendFileSync(args.dump, runs.flatMap((run, r) => run.calls.map((call, c) => `${JSON.stringify({ task: task.id, args: call.args, reply: replayed[r][c].text })}\n`)).join(''));
      } finally {
        rmSync(root, { recursive: true, force: true });
      }
    }
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
  const base = args.compare ? JSON.parse(readFileSync(args.compare, 'utf8')) : null;
  const lost = report(rows, base);
  if (args.save) writeFileSync(args.save, JSON.stringify(rows, null, 2));
  process.exitCode = lost.length ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main();
