// The runner core in lib.mjs that run.mjs and saver.mjs share: recovery, batch pins, job order, pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { appendLedger, ledgerTotals, readLedger } from './ledger.mjs';
import { assertBuild, claimRunner, cloneTarget, depsFingerprint, exploreClause, snapshotBuild, startTime, harnessArgs, reuseClause, measuredRun, pinnedSeed, pool, reportedCost, seededJobs } from './lib.mjs';
import { armsFor, beforeValues, buildJobs, customToolCalls, simulateEditSteps, simulateNonInferior, REUSE_ARMS, REUSE_CHAIN, REUSE_CHECK, reuseChain, reuseMessage, storedTools } from './run.mjs';
import { assignJobs } from './saver.mjs';
import { wilcoxon } from './stats.mjs';
import { editStepsGate, parseCsv, reuseReport, runFromRow, runsCsv } from './analyze.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'bench-core-'));
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

test('Linux cache cloning uses portable cp flags and preserves independent files, metadata and symlinks', () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source cache');
    const to = join(dir, 'private cache');
    const bin = join(dir, 'bin');
    const fingerprint = join('.fingerprint', 'fixture-123');
    for (const path of ['deps', fingerprint, 'incremental', 'empty']) mkdirSync(join(source, path), { recursive: true });
    mkdirSync(bin);
    // Reject non-POSIX flags like GNU cp rejects -c, then exercise the host's real copy behavior.
    writeFileSync(join(bin, 'cp'), '#!/bin/sh\nfor arg do\n  case "$arg" in -R|-p) ;; -*) echo "unsupported cp flag: $arg" >&2; exit 64 ;; esac\ndone\nexec /bin/cp "$@"\n');
    chmodSync(join(bin, 'cp'), 0o755);
    const artifact = join('deps', 'libfixture-123.rlib');
    writeFileSync(join(source, artifact), 'dependency');
    chmodSync(join(source, artifact), 0o751);
    const stamp = new Date('2020-01-02T03:04:05Z');
    utimesSync(join(source, artifact), stamp, stamp);
    utimesSync(join(source, 'empty'), stamp, stamp);
    symlinkSync('libfixture-123.rlib', join(source, 'deps', 'linked'));
    symlinkSync('../absent', join(source, 'deps', 'dangling'));
    for (const path of [join(fingerprint, 'run-build-script-fixture'), join(fingerprint, 'build-script-build'), join('incremental', 'state')]) writeFileSync(join(source, path), 'cached');
    const copied = spawnSync(process.execPath, ['--input-type=module', '-e', `
      Object.defineProperty(process, 'platform', { value: 'linux' });
      const { cloneTarget } = await import(${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)});
      await cloneTarget(process.argv[1], process.argv[2]);
    `, to, source], { env: { ...process.env, PATH: bin + delimiter + process.env.PATH }, encoding: 'utf8', timeout: 10_000 });
    assert.equal(copied.status, 0, copied.stderr);
    const debug = join(to, 'debug');
    assert.deepEqual(depsFingerprint(debug), depsFingerprint(source));
    assert.equal(statSync(join(debug, artifact)).mode, statSync(join(source, artifact)).mode);
    assert.equal(statSync(join(debug, artifact)).mtimeMs, stamp.getTime());
    assert.equal(statSync(join(debug, 'empty')).mtimeMs, stamp.getTime());
    assert.equal(readlinkSync(join(debug, 'deps', 'linked')), 'libfixture-123.rlib');
    assert.equal(readlinkSync(join(debug, 'deps', 'dangling')), '../absent');
    assert.ok(!existsSync(join(debug, 'incremental')));
    assert.deepEqual(readdirSync(join(debug, fingerprint)), ['build-script-build']);
    writeFileSync(join(debug, 'deps', 'linked'), 'changed clone');
    assert.equal(readFileSync(join(debug, artifact), 'utf8'), 'changed clone');
    assert.equal(readFileSync(join(source, artifact), 'utf8'), 'dependency');
    assert.equal(readFileSync(join(source, fingerprint, 'run-build-script-fixture'), 'utf8'), 'cached');
    assert.equal(readFileSync(join(source, 'incremental', 'state'), 'utf8'), 'cached');
    assert.equal(statSync(join(source, artifact)).mtimeMs, stamp.getTime());
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cloned Cargo cache regenerates missing build outputs without changing the source cache', async () => {
  const dir = scratch();
  const tree = path => readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name)).flatMap(entry => {
    const file = join(path, entry.name);
    return entry.isDirectory() ? tree(file).map(([name, bytes]) => [join(entry.name, name), bytes]) : [[entry.name, readFileSync(file).toString('hex')]];
  });
  try {
    const crate = join(dir, 'crate');
    const cached = join(dir, 'cached');
    mkdirSync(join(crate, 'src'), { recursive: true });
    writeFileSync(join(crate, 'Cargo.toml'), '[package]\nname = "cache-regeneration-fixture"\nversion = "0.1.0"\nedition = "2021"\n');
    writeFileSync(join(crate, 'build.rs'), 'fn main() { println!("cargo:rerun-if-changed=build.rs"); let out = std::env::var("OUT_DIR").unwrap(); std::fs::write(std::path::Path::new(&out).join("generated.rs"), "pub const VALUE: u32 = 42;").unwrap(); }');
    const source = 'include!(concat!(env!("OUT_DIR"), "/generated.rs"));\n';
    writeFileSync(join(crate, 'src', 'lib.rs'), source);
    const cargo = target => spawnSync('cargo', ['build', '--offline'], { cwd: crate, env: { ...process.env, CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' }, encoding: 'utf8' });
    const initial = cargo(cached);
    assert.equal(initial.status, 0, initial.stderr);
    const debug = join(cached, 'debug');
    const generated = tree(join(debug, 'build')).filter(([name]) => name.endsWith('generated.rs'));
    assert.equal(generated.length, 1);
    rmSync(join(debug, 'build', generated[0][0]));
    const before = tree(cached);
    const deps = depsFingerprint(debug);
    const cloned = join(dir, 'disposable');
    await cloneTarget(cloned, debug);
    assert.deepEqual(depsFingerprint(join(cloned, 'debug')), deps);
    // Force the consumer to compile while leaving build.rs and its successful execution cached.
    writeFileSync(join(crate, 'src', 'lib.rs'), source + 'pub fn value() -> u32 { VALUE }\n');
    const rebuilt = cargo(cloned);
    assert.equal(rebuilt.status, 0, rebuilt.stderr);
    assert.equal(readFileSync(join(cloned, 'debug', 'build', generated[0][0]), 'utf8'), 'pub const VALUE: u32 = 42;');
    assert.deepEqual(tree(cached), before);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('cloneTarget removes run-build-script fingerprints in both flat and nested layouts without touching build-script-build or source', async () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source', 'debug');
    const flat = join('.fingerprint', 'flat-pkg-1234');
    const nested = join('.fingerprint', 'nested-pkg', '5678abcd');
    for (const rel of ['deps', flat, nested]) mkdirSync(join(source, rel), { recursive: true });
    writeFileSync(join(source, 'deps', 'libfixture-123.rlib'), 'dep');
    for (const rel of [
      join(flat, 'run-build-script-build-script-build'),
      join(flat, 'run-build-script-build-script-build.json'),
      join(flat, 'build-script-build'),
      join(flat, 'build-script-build.json'),
      join(nested, 'run-build-script-build-script-build'),
      join(nested, 'run-build-script-build-script-build.json'),
      join(nested, 'build-script-build'),
      join(nested, 'build-script-build.json'),
    ]) writeFileSync(join(source, rel), 'cached');
    const to = join(dir, 'cloned');
    await cloneTarget(to, source);
    const cloned = join(to, 'debug');
    assert.deepEqual(readdirSync(join(cloned, flat)).sort(), ['build-script-build', 'build-script-build.json']);
    assert.deepEqual(readdirSync(join(cloned, nested)).sort(), ['build-script-build', 'build-script-build.json']);
    assert.deepEqual(readdirSync(join(source, flat)).sort(), [
      'build-script-build', 'build-script-build.json', 'run-build-script-build-script-build', 'run-build-script-build-script-build.json',
    ]);
    assert.deepEqual(readdirSync(join(source, nested)).sort(), [
      'build-script-build', 'build-script-build.json', 'run-build-script-build-script-build', 'run-build-script-build-script-build.json',
    ]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('G2-1: snapshot, verification and cloning share an explicit dependency cache; old metadata keeps its default', async () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source');
    const target = join(dir, 'private', 'debug');
    mkdirSync(source);
    mkdirSync(join(target, 'deps'), { recursive: true });
    for (const name of ['Cargo.toml', 'Cargo.lock']) writeFileSync(join(source, name), name);
    writeFileSync(join(target, 'deps', 'libfixture-123.rlib'), 'fixture');
    const build = snapshotBuild(join(dir, 'snapshot'), source, target);
    assert.equal(build.target, target);
    assert.deepEqual(build.deps, depsFingerprint(target));
    assert.doesNotThrow(() => assertBuild(build));
    const to = join(dir, 'clone');
    await cloneTarget(to, build.target);
    assert.equal(readFileSync(join(to, 'debug', 'deps', 'libfixture-123.rlib'), 'utf8'), 'fixture');
    assert.deepEqual(depsFingerprint(join(to, 'debug')), build.deps);
    writeFileSync(join(target, 'deps', 'libextra-456.rlib'), 'drift');
    assert.throws(() => assertBuild(build), /dependencies changed/);
    const legacy = snapshotBuild(join(dir, 'legacy'), source);
    assert.equal(Object.hasOwn(legacy, 'target'), false);
    assert.equal(legacy.deps, null);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('recovery charges an open run the larger of its cap and its reported cost, then clears the checkouts', async () => {
  const out = scratch();
  try {
    const ledger = join(out, 'ledger.jsonl');
    const work = join(out, 'work');
    mkdirSync(join(work, 'x'), { recursive: true });
    appendLedger(ledger, { type: 'start', attempt: 'a1', id: 'r1', batch: 'B', capUsd: 1 });
    appendLedger(ledger, { type: 'start', attempt: 'a2', id: 'r2', batch: 'B', capUsd: 1 });
    mkdirSync(join(out, 'runs', 'B', 'r1'), { recursive: true });
    writeFileSync(join(out, 'runs', 'B', 'r1', 'stream.jsonl'), '{"type":"result","total_cost_usd":0.4}\n{"type":"result","total_cost_usd":2.5}\n');
    const recovered = await quiet(() => claimRunner({ out, pids: join(out, 'pids.json'), ledger, work }));
    assert.deepEqual(recovered.interruptedRuns, ['r1', 'r2']);
    const charged = Object.fromEntries(readLedger(ledger).filter(e => e.type === 'interrupted').map(e => [e.id, e.chargedUsd]));
    assert.deepEqual(charged, { r1: 2.5, r2: 1 });
    assert.equal(ledgerTotals(readLedger(ledger)).totalUsd, 3.5);
    assert.ok(!existsSync(work));
    assert.equal(JSON.parse(readFileSync(join(out, 'runner.json'), 'utf8')).pid, process.pid);
    assert.equal(reportedCost('not json\n'), null);
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a batch keeps its seed and refuses other pins, including one it never had', async () => {
  const dir = scratch();
  try {
    const file = join(dir, 'batch.json');
    const seed = pinnedSeed(file, { a: '1', b: undefined }, 'r1', 42);
    assert.equal(seed, 42);
    assert.equal(await quiet(() => pinnedSeed(file, { a: '1', b: undefined }, 'r2', 7)), 42);
    assert.throws(() => pinnedSeed(file, { a: '2' }, 'r1'), /another a/);
    assert.throws(() => pinnedSeed(file, { a: '1', b: 'x' }, 'r1'), /another b/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('both runners order jobs with the one seeded shuffle', () => {
  const tasks = Array.from({ length: 5 }, (_, i) => ({ id: `t${i}` }));
  const saver = assignJobs(tasks, [1, 2], ['NONE', 'CHOSEN'], 9);
  const direct = seededJobs(tasks.flatMap(task => [1, 2].map(seed => ({ task, seed }))), () => ['NONE', 'CHOSEN'], 9);
  assert.deepEqual(saver.map(j => `${j.task.id}${j.seed}${j.arm}${j.group}`), direct.map(j => `${j.task.id}${j.seed}${j.arm}${j.group}`));
});

test('after-e runs only on edit sets, with AFTER\'s server and its own instruction', () => {
  const jobs = buildJobs({ loc: [{ id: 'l' }], edit: [{ id: 'e' }], edit2: [{ id: 'f' }] }, () => [11, 12], ['before', 'after', 'after-e'], 'sonnet', 3);
  const count = set => jobs.filter(j => j.set === set).length;
  assert.deepEqual([count('loc'), count('edit'), count('edit2')], [4, 6, 6]);
  assert.ok(!jobs.some(j => j.set === 'loc' && j.arm === 'after-e'));
  assert.deepEqual(armsFor(['before', 'after-e'], 'long'), ['before']);
  const base = { model: 'sonnet', config: 'mcp.json', instructions: { after: 'NEW', 'after-e': 'OLD' }, runBudget: 1 };
  const after = harnessArgs({ ...base, arm: 'after' });
  const e = harnessArgs({ ...base, arm: 'after-e' });
  assert.deepEqual(e.slice(0, -1), after.slice(0, -1));
  assert.deepEqual([after.at(-1), e.at(-1)], ['NEW', 'OLD']);
});

/** A pool over fake runs: `costs[i]` is what job i bills (`skip` marks it already done); each run takes `ms`. */
async function fakePool({ costs, cap = 1, budget, limit = 2, ms = 5, free = () => 100, aborted, skip = () => false }) {
  const out = scratch();
  const ledger = join(out, 'ledger.jsonl');
  const started = [];
  let running = 0, peak = 0, waits = 0;
  const jobs = costs.map((usd, i) => ({ id: `j${i}`, usd }));
  const runOne = async job => {
    if (skip(job)) return { skipped: true };
    started.push(job.id);
    peak = Math.max(peak, ++running);
    appendLedger(ledger, { type: 'start', attempt: job.id, id: job.id, batch: 'B', capUsd: cap });
    await new Promise(done => setTimeout(done, ms));
    appendLedger(ledger, { type: 'end', attempt: job.id, billedUsd: job.usd });
    running--;
    return { id: job.id };
  };
  try {
    const report = await quiet(() => pool(jobs, { limit, batchDir: out, out, ledger, minFreeGiB: 6, budget, cap: () => cap, diskNeed: () => 1, runOne, free, aborted, sleep: () => (++waits > 2000 ? Promise.reject(new Error('stuck waiting for disk')) : new Promise(done => setTimeout(done, 1))) }));
    return { report, started, peak, exitCode: process.exitCode };
  } finally { rmSync(out, { recursive: true, force: true }); process.exitCode = 0; }
}

test('the pool never stops early while a run in flight may free its cap', async () => {
  // Budget 2.5 with caps of 1: two runs in flight reserve 2. Each bills 0.1, so all ten fit.
  const { report, started } = await fakePool({ costs: Array(10).fill(0.1), budget: 2.5 });
  assert.equal(started.length, 10);
  assert.equal(report.stoppedBy, null);
  // Runs that bill their whole cap stop it once nothing is in flight to free anything.
  const full = await fakePool({ costs: Array(10).fill(1), budget: 3 });
  assert.equal(full.started.length, 3);
  assert.match(full.report.stoppedBy, /^budget/);
  assert.equal(full.report.remaining.length, 7);
});

test('the pool waits for disk instead of starting a run that would cross the floor', async () => {
  let calls = 0;
  const free = () => (++calls < 6 ? 6.5 : 100);  // 6.5 GiB free, 1 needed, floor 6: wait, then go
  const { started } = await fakePool({ costs: [0, 0], budget: 10, free });
  assert.equal(started.length, 2);
  assert.ok(calls >= 6);
});

test('the pool holds each running job\'s disk need, so parallel jobs never cross the floor together', { timeout: 10_000 }, async () => {
  // 7.5 GiB free, floor 6, 1 GiB per job: one fits, a second would leave 5.5, so it waits for the first.
  const held = await fakePool({ costs: [0, 0, 0], budget: 10, free: () => 7.5 });
  assert.equal(held.started.length, 3);
  assert.equal(held.peak, 1);
  assert.equal((await fakePool({ costs: [0, 0, 0], budget: 10, ms: 20 })).peak, 2);
});

test('the pool gives up after an hour without disk, stops on aborted(), and counts only runs that ran', async t => {
  let now = 0;
  t.mock.method(Date, 'now', () => (now += 20 * 60_000));
  const disk = await fakePool({ costs: [0, 0], budget: 10, limit: 1, free: () => 6.5 });
  assert.deepEqual(disk.started, []);
  assert.match(disk.report.stoppedBy, /^low disk: 6\.5 GiB free, floor 6/);
  assert.equal(disk.report.remaining.length, 2);
  assert.equal(disk.exitCode, 3);
  assert.ok(now <= 4 * 60 * 60_000, 'it gave up about an hour in');
  t.mock.restoreAll();
  let calls = 0;
  const abort = await fakePool({ costs: [0, 0, 0], budget: 10, limit: 1, aborted: () => (calls++ ? 'model resolved to x' : null) });
  assert.deepEqual(abort.started, ['j0']);
  assert.equal(abort.report.stoppedBy, 'model resolved to x');
  assert.equal(abort.exitCode, 3);
  const skipped = await fakePool({ costs: [0, 0, 0], budget: 10, skip: job => job.id !== 'j1' });
  assert.equal(skipped.report.ran, 1);
  assert.equal(skipped.report.stoppedBy, null);
  assert.equal(skipped.exitCode, 0, 'a batch that finishes leaves the exit code alone');
});

test('a measured run kills its server, removes mcp.json, reruns with force, and keeps a reported cost on a throw', async () => {
  const dir = scratch();
  try {
    const ledger = join(dir, 'ledger.jsonl');
    const runDir = join(dir, 'run');
    const args = { runDir, ledger, workRoot: join(dir, 'work'), batch: 'B', id: 'r', capUsd: 1 };
    const signals = [];
    const ok = await measuredRun({ ...args, record: { billedUsd: 0.25 }, body: async (work, held) => {
      held.server = { kill: signal => signals.push(signal) };
      writeFileSync(join(runDir, 'mcp.json'), '{}');
    } });
    assert.deepEqual(signals, ['SIGKILL']);
    assert.ok(!existsSync(join(runDir, 'mcp.json')));
    assert.ok(ok.finishedAt);
    let ran = 0;
    await measuredRun({ ...args, record: {}, force: true, body: async () => { ran++; } });
    assert.equal(ran, 1, 'force reruns a run that has run.json');
    const kept = await measuredRun({ ...args, record: { billedUsd: 0.4 }, force: true, body: async () => { throw new Error('late'); } });
    assert.equal(kept.billedUsd, 0.4);
    const ends = readLedger(ledger).filter(e => e.type === 'end').map(e => e.billedUsd);
    assert.deepEqual(ends, [0.25, 0, 0.4]);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('claimRunner refuses a live runner and records its own PID', async () => {
  const out = scratch();
  try {
    const args = { out, pids: join(out, 'pids.json'), ledger: join(out, 'ledger.jsonl'), work: join(out, 'work') };
    writeFileSync(join(out, 'runner.json'), JSON.stringify({ pid: process.ppid, started: startTime(process.ppid) }));
    assert.throws(() => claimRunner(args), new RegExp(`runner ${process.ppid} is still working`));
    // A recorded PID whose start time differs is a reused number, not the runner.
    writeFileSync(join(out, 'runner.json'), JSON.stringify({ pid: process.ppid, started: 'long ago' }));
    await quiet(() => claimRunner(args));
    assert.equal(readFileSync(join(out, 'runner.pid'), 'utf8'), String(process.pid));
  } finally { rmSync(out, { recursive: true, force: true }); }
});

test('a measured run writes run.json and ends its ledger entry even when its body throws', async () => {
  const dir = scratch();
  try {
    const ledger = join(dir, 'ledger.jsonl');
    const args = { runDir: join(dir, 'run'), ledger, workRoot: join(dir, 'work'), batch: 'B', id: 'r', capUsd: 1 };
    const record = await measuredRun({ ...args, record: {}, body: async work => { mkdirSync(work, { recursive: true }); throw new Error('boom'); } });
    assert.equal(record.success, false);
    assert.equal(record.billedUsd, 0, 'a run that threw before reporting bills 0');
    assert.match(record.failure, /boom/);
    assert.deepEqual(readdirSync(join(dir, 'work')), [], 'the checkout is gone');
    assert.deepEqual(ledgerTotals(readLedger(ledger)).open, []);
    assert.deepEqual(await measuredRun({ ...args, record: {}, body: async () => {} }), { skipped: true });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('the edit-steps test is one-sided non-superiority at +5%', () => {
  assert.ok(wilcoxon([-1, -2, -3, -4, -5, -6], { side: 'less' }) < 0.05);
  assert.ok(wilcoxon([1, 2, 3, 4, 5, 6], { side: 'less' }) > 0.95);
  // 5 edit and 5 edit2 tasks pool into one test; a loc task never counts.
  const runs = rel => [...Array.from({ length: 10 }, (_, i) => ['before', 'after'].map(arm => ({
    set: i < 5 ? 'edit' : 'edit2', task: `t${i}`, arm, steps: arm === 'before' ? 10 : 10 * (1 + rel + (i % 3) * 0.01),
  }))).flat(), { set: 'loc', task: 'l', arm: 'before', steps: 1 }, { set: 'loc', task: 'l', arm: 'after', steps: 99 }];
  assert.equal(editStepsGate(runs(-0.2), 'before', 'after').pass, true);
  assert.equal(editStepsGate(runs(-0.2), 'before', 'after').n, 10);
  assert.equal(editStepsGate(runs(0.1), 'before', 'after').pass, false);
  assert.equal(editStepsGate(runs(0.05), 'before', 'after').pass, false, 'at the margin is not enough');
});

test('the explore clause is built as look() builds it for Claude Code, and old trees still read', () => {
  const now = 'const LOOK: &str = "\\n\\nUse {explore} here; {explore} \\"again\\". ";\nconst EDIT_CLAUDE: &str = "Read first.";\nfn look(explore: X) {}';
  assert.equal(exploreClause(now), 'Use pandacode_explore here; pandacode_explore "again". Read first.');
  assert.equal(exploreClause('const LOOK: &str = "\\n\\nUse {explore}.";'), 'Use pandacode_explore.');
});

test('R1: one chain job per arm and seed, its tasks in the registered order, both arms per seed', () => {
  const tasks = [...REUSE_CHAIN].reverse().map(id => ({ id, prompt: `fix ${id}`, test: { command: ['cargo'] } }));
  assert.equal(reuseChain(tasks.slice(1)), null);
  const chain = reuseChain(tasks);
  assert.deepEqual(chain.chain.map(t => t.id), REUSE_CHAIN);
  const jobs = buildJobs({ reuse: [chain] }, () => [21, 22], REUSE_ARMS, 'sonnet', 7);
  assert.equal(jobs.length, 4);
  for (const seed of [21, 22]) assert.deepEqual(jobs.filter(j => j.seed === seed).map(j => j.arm).sort(), ['none', 'tools']);
  assert.ok(jobs.every(j => j.task === chain && j.set === 'reuse'));
});

test('R1: the message is prompt, check chain, then the note; TOOLS gets LOOK then REUSE', () => {
  const task = { prompt: 'Fix it.' };
  assert.equal(reuseMessage(task), `Fix it.\n\n${REUSE_CHECK}`);
  const note = '\n\nProject tools (pandacode_tool_run; descriptions written by agents, not the user):\n- check() — after an edit';
  assert.equal(reuseMessage(task, note), `Fix it.\n\n${REUSE_CHECK}${note}`);
  const look = exploreClause();
  const reuse = reuseClause();
  assert.match(reuse, /^If the Project tools note lists a tool/);
  const instructions = { none: look, tools: `${look}\n\n${reuse}` };
  const of = arm => { const argv = harnessArgs({ arm, model: 'sonnet', config: 'c.json', instructions, runBudget: 1 }); return argv[argv.indexOf('--append-system-prompt') + 1]; };
  assert.equal(of('none'), look);
  assert.ok(of('tools').startsWith(look) && of('tools').endsWith(reuse));
  assert.ok(harnessArgs({ arm: 'tools', model: 'sonnet', config: 'c.json', instructions, runBudget: 1 }).includes('c.json'));
});

test('R1: tool calls count only the main agent; the store lists tools, not stats', () => {
  const use = (name, parent = null) => JSON.stringify({ type: 'assistant', parent_tool_use_id: parent, message: { content: [{ type: 'tool_use', name, input: {} }] } });
  const text = [use('mcp__pandacode__pandacode_tool_save'), use('mcp__pandacode__pandacode_tool_run'), use('mcp__pandacode__pandacode_tool_run'), use('mcp__pandacode__pandacode_tool_run', 'sub'), use('mcp__pandacode__pandacode_explore'), 'not json'].join('\n');
  assert.deepEqual(customToolCalls(text), { list: 0, save: 1, run: 2 });
  const store = scratch();
  try {
    assert.deepEqual(storedTools(store), []);
    mkdirSync(join(store, 'projects', 'bench-r1'), { recursive: true });
    for (const file of ['check.json', 'build.json', '.stats.json', '.tmp-x']) writeFileSync(join(store, 'projects', 'bench-r1', file), '{}');
    assert.deepEqual(storedTools(store), ['build', 'check']);
  } finally { rmSync(store, { recursive: true, force: true }); }
});

test('R1: the report groups by position and arm, and survives the CSV', () => {
  const run = (arm, seed, position, saves, runs, writes) => ({ set: 'reuse', task: `t${position}`, arm, seed, model: 'sonnet', tags: [], steps: 4 + position, costUsd: 0.2, tokens: { output: 100 }, firstStep: { cacheWrite: 5000 }, laterWrites: writes, success: true, reuse: { position, calls: { save: saves, run: runs, list: 0 }, toolsAfter: saves ? ['check'] : [] } });
  const runs = [run('tools', 21, 1, 1, 0, [100, 300]), run('tools', 22, 1, 0, 0, []), run('tools', 21, 2, 0, 2, [50]), run('none', 21, 1, 0, 0, [10])];
  const report = reuseReport(runs);
  const at = (position, arm) => report.positions.find(p => p.position === position && p.arm === arm);
  assert.deepEqual([at(1, 'tools').runs, at(1, 'tools').toolSaves, at(1, 'tools').laterWritesPerStep], [2, 0.5, 100]);
  assert.equal(at(2, 'tools').toolRuns, 2);
  assert.equal(report.chains.length, 4);
  const back = parseCsv(runsCsv(runs, 'R1')).map(row => runFromRow(row, 'R1'));
  assert.deepEqual(reuseReport(back).positions, report.positions);
});

test('run.mjs --simulate: a gate with no noise always passes with no effect and never with a large loss', () => {
  const flat = Array.from({ length: 10 }, () => [0.8, 0.8]);
  assert.equal(simulateNonInferior({ values: flat, kind: 'score', reps: 30, rounds: 200 }), 1);
  assert.equal(simulateNonInferior({ values: flat, kind: 'score', effect: -0.1, reps: 30, rounds: 200 }), 0);
  const always = Array.from({ length: 10 }, () => [1, 1, 1, 1]);
  assert.equal(simulateNonInferior({ values: always, kind: 'rate', reps: 30, rounds: 200, shrink: false }), 1);
  assert.ok(simulateNonInferior({ values: always, kind: 'rate', reps: 200, rounds: 200 }) < 1, 'shrinkage leaves room to fail');
  // Edit steps: no noise, so the test passes exactly when the true change sits clear below +5%.
  const steps = Array.from({ length: 20 }, (_, i) => [5 + i % 4, 5 + i % 4]);
  assert.equal(simulateEditSteps({ values: steps, effect: -0.1, reps: 5, rounds: 200 }), 1);
  assert.equal(simulateEditSteps({ values: steps, effect: 0.1, reps: 5, rounds: 200 }), 0);
  const runs = [{ arm: 'before', set: 'loc', task: 'a', v: 1 }, { arm: 'after', set: 'loc', task: 'a', v: 2 }, { arm: 'before', set: 'loc', task: 'h', tags: ['held-out'], v: 3 }, { arm: 'before', set: 'edit', task: 'e', v: 4 }];
  assert.deepEqual(beforeValues(runs, ['loc'], r => r.v), [[1]]);
});
