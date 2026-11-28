// The runner core in lib.mjs that run.mjs and saver.mjs share: recovery, batch pins, job order, pool.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, readlinkSync, rmSync, statSync, symlinkSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { appendLedger, ledgerTotals, readLedger } from './ledger.mjs';
import { assertBuild, claimRunner, cloneTarget, depsFingerprint, exploreClause, gradeEdit, groupAlive, snapshotBuild, startTime, harnessArgs, reuseClause, measuredRun, pinnedSeed, pool, reportedCost, runClaude, runCommand, seededJobs, sh, signalGroup, suiteAcceptable } from './lib.mjs';
import { armsFor, beforeValues, buildJobs, customToolCalls, simulateEditSteps, simulateNonInferior, REUSE_ARMS, REUSE_CHAIN, REUSE_CHECK, reuseChain, reuseMessage, storedTools } from './run.mjs';
import { assignJobs } from './saver.mjs';
import { wilcoxon } from './stats.mjs';
import { editStepsGate, parseCsv, reuseReport, runFromRow, runsCsv } from './analyze.mjs';

const scratch = () => mkdtempSync(join(tmpdir(), 'bench-core-'));
const quiet = async fn => { const log = console.log; console.log = () => {}; try { return await fn(); } finally { console.log = log; } };

for (const runner of ['track', 'sh', 'runCommand']) for (const signal of ['SIGINT', 'SIGTERM']) {
  test(`${runner} ${signal} awaits owned process-group cleanup before runner exit`, { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const dir = scratch();
    const sleeperFile = join(dir, 'sleeper.pid');
    const pidFile = join(dir, 'pids.json');
    const ignoresTerm = signal === 'SIGTERM' || runner !== 'track';
    const script = `${ignoresTerm ? "trap '' TERM\n" : ''}echo $$ > "$1"\nexec sleep 30`;
    const command = ['sh', '-c', script, 'sh', sleeperFile];
    const source = `
      import { spawn } from 'node:child_process';
      import { track, sh, runCommand, stopChildrenOnSignal } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};
      stopChildrenOnSignal({ graceMs: 300 });
      const command = ${JSON.stringify(command)};
      if (${JSON.stringify(runner)} === 'track') {
        track(spawn(command[0], command.slice(1), { detached: true, stdio: 'ignore' }), ${JSON.stringify(pidFile)});
      } else if (${JSON.stringify(runner)} === 'sh') {
        await sh(command[0], command.slice(1), { timeout: 30_000 });
      } else {
        await runCommand({ command, cwd: '.' }, ${JSON.stringify(dir)}, null, 30_000);
      }
    `;
    const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', data => { stderr += data; });
    const exited = new Promise((resolve, reject) => { child.on('error', reject); child.on('exit', (code, signal) => resolve({ code, signal })); });
    let deadline;
    try {
      const startupDeadline = Date.now() + 5000;
      while (!existsSync(sleeperFile) || !readFileSync(sleeperFile, 'utf8').trim() || (runner === 'track' && !existsSync(pidFile))) {
        assert.ok(Date.now() < startupDeadline, `fixture did not start: ${stderr}`);
        assert.equal(child.exitCode, null, `fixture exited early: ${stderr}`);
        await new Promise(resolve => setTimeout(resolve, 20));
      }
      const sleeper = Number(readFileSync(sleeperFile, 'utf8').trim());
      assert.ok(Number.isInteger(sleeper) && sleeper > 1);
      if (runner === 'track') assert.equal(JSON.parse(readFileSync(pidFile, 'utf8'))[0].pid, sleeper);
      const started = Date.now();
      child.kill(signal);
      const result = await Promise.race([
        exited,
        new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error(`signal cleanup exceeded four seconds: ${stderr}`)), 4000); }),
      ]);
      assert.deepEqual(result, { code: signal === 'SIGINT' ? 130 : 143, signal: null });
      assert.ok(Date.now() - started < 4000, 'runner exit must be bounded');
      if (ignoresTerm) assert.ok(Date.now() - started >= 250, 'runner must await the TERM grace period before KILL');
      assert.throws(() => process.kill(sleeper, 0), { code: 'ESRCH' });
      if (runner === 'track') assert.deepEqual(JSON.parse(readFileSync(pidFile, 'utf8')), []);
    } finally {
      clearTimeout(deadline);
      if (existsSync(sleeperFile)) signalGroup(Number(readFileSync(sleeperFile, 'utf8').trim()), 'SIGKILL');
      child.kill('SIGKILL');
      await exited;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('sh timeout closes inherited stdout before a shell grandchild exits naturally', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const started = Date.now();
  const result = await sh('sh', ['-c', 'sleep 3; echo done'], { timeout: 200 });
  assert.ok(Date.now() - started < 2500, 'timeout must not wait three seconds for inherited stdout');
  assert.equal(result.timedOut, true);
  assert.notEqual(result.status, 0);
  assert.equal(result.stdout, '');
});

for (const runner of ['sh', 'runCommand']) test(`${runner} timeout kills its grandchild even when the shell handles TERM with exit zero`, { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = scratch();
  const descendantFile = join(dir, 'descendant.pid');
  let running;
  try {
    // Reap the terminated child before exiting zero: timeout must still count as failure.
    const script = 'trap \'wait "$descendant"; exit 0\' TERM\nsleep 30 &\ndescendant=$!\necho "$descendant" > "$1"\nwait "$descendant"';
    const command = ['sh', '-c', script, 'sh', descendantFile];
    const started = Date.now();
    running = runner === 'sh' ? sh(command[0], command.slice(1), { timeout: 200 })
      : runCommand({ command, cwd: '.' }, dir, null, 200);
    const result = await running;
    assert.ok(Date.now() - started < 2500, 'timeout must terminate the whole group promptly');
    assert.equal(result.timedOut, true);
    if (runner === 'sh') assert.notEqual(result.status, 0);
    else { assert.equal(result.pass, false); assert.equal(result.kind, 'timeout'); }
    const descendant = Number(readFileSync(descendantFile, 'utf8').trim());
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  } finally {
    if (existsSync(descendantFile)) {
      try { process.kill(Number(readFileSync(descendantFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
    }
    if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sh timeout awaits SIGKILL cleanup after a TERM-ignoring descendant redirects stdio', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = scratch();
  const descendantFile = join(dir, 'descendant.pid');
  const parentFile = join(dir, 'parent.pid');
  let running;
  try {
    const script = 'echo $$ > "$1"\ntrap \'exit 0\' TERM\nsh -c \'trap "" TERM; echo $$ > "$1"; exec sleep 30\' sh "$2" </dev/null >/dev/null 2>&1 &\nwait "$!"';
    const started = Date.now();
    running = sh('sh', ['-c', script, 'sh', parentFile, descendantFile], { timeout: 200, killGraceMs: 300 });
    const result = await running;
    assert.equal(result.timedOut, true);
    assert.notEqual(result.status, 0);
    assert.ok(Date.now() - started >= 450, 'resolution must await group cleanup after the shell closes');
    assert.ok(Date.now() - started < 2500, 'SIGKILL must stop the descendant before its natural exit');
    const descendant = Number(readFileSync(descendantFile, 'utf8').trim());
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  } finally {
    if (existsSync(descendantFile)) {
      try { process.kill(Number(readFileSync(descendantFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
    }
    if (existsSync(parentFile)) signalGroup(Number(readFileSync(parentFile, 'utf8').trim()), 'SIGKILL');
    if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('sh preserves output and exit status without a timeout or before its deadline, and rejects spawn errors', async () => {
  for (const options of [{}, { timeout: 10_000 }]) {
    assert.deepEqual(await sh(process.execPath, ['-e', 'process.stdout.write("out"); process.stderr.write("err"); process.exitCode = 7;'], options), {
      status: 7, stdout: 'out', stderr: 'err', timedOut: false,
    });
  }
  const dir = scratch();
  try {
    await assert.rejects(sh(join(dir, 'missing-command'), [], { timeout: 200 }), { code: 'ENOENT' });
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const { spawnError, brokenOutput = false } of [{ spawnError: 'ENOENT' }, { spawnError: 'EACCES' }, { spawnError: 'ENOENT', brokenOutput: true }]) test(`runClaude spawn failure ${spawnError}${brokenOutput ? ' with output stream error' : ''} resolves and clears PID tracking`, { skip: spawnError === 'EACCES' && process.platform === 'win32', timeout: 15_000 }, () => {
  const dir = scratch();
  const pidFile = join(dir, 'pids.json');
  try {
    if (spawnError === 'EACCES') {
      writeFileSync(join(dir, 'claude'), '#!/bin/sh\nexit 0\n');
      chmodSync(join(dir, 'claude'), 0o644);
    }
    // Isolate the missing error listener's unhandled-event crash from the test runner.
    const source = `
      import { runClaude } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};
      const result = await runClaude(['hello'], ${JSON.stringify(dir)}, ${JSON.stringify(brokenOutput ? dir : join(dir, 'stream.jsonl'))}, [], 5000,
        { PATH: ${JSON.stringify(dir)} }, ${JSON.stringify(pidFile)});
      console.log(JSON.stringify(result));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.code, null);
    assert.equal(result.timedOut, false);
    assert.equal(result.spawnError, spawnError);
    assert.match(result.stderr, new RegExp(spawnError));
    assert.ok(result.wallMs < 5000, 'spawn failure must clear its deadline');
    assert.deepEqual(JSON.parse(readFileSync(pidFile, 'utf8')), []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

for (const runner of ['runClaude', 'sh', 'runCommand']) for (const ignoresTerm of [false, true]) {
  test(`${runner} normal exit cleans redirected-stdio descendants${ignoresTerm ? ' ignoring TERM' : ''}`, { skip: process.platform === 'win32', timeout: 15_000 }, async () => {
    const dir = scratch();
    const descendantFile = join(dir, 'descendant.pid');
    const parentFile = join(dir, 'parent.pid');
    const pidFile = join(dir, 'pids.json');
    let running;
    try {
      const stub = join(dir, 'claude');
      writeFileSync(stub, `#!/bin/sh
 echo $$ > "$PARENT_PID_FILE"
 sh -c '${ignoresTerm ? 'trap "" TERM; ' : ''}echo $$ > "$DESCENDANT_PID_FILE"; exec sleep 30' </dev/null >/dev/null 2>&1 &
 # Do not exit until the child has installed its signal handler and written its PID.
 attempts=0
 while [ ! -s "$DESCENDANT_PID_FILE" ]; do
   attempts=$((attempts + 1))
   [ "$attempts" -lt 500 ] || exit 99
   sleep 0.01
 done
 exit 0
`);
      chmodSync(stub, 0o755);
      const env = { PATH: dir + delimiter + process.env.PATH, PARENT_PID_FILE: parentFile, DESCENDANT_PID_FILE: descendantFile };
      if (runner === 'runClaude') {
        running = runClaude(['hello'], dir, join(dir, 'stream.jsonl'), [], 10_000, env, pidFile, { killGraceMs: 300 });
      } else if (runner === 'sh') {
        // Also cover commands without deadlines, which own detached groups too.
        running = sh(stub, [], { env: { ...process.env, ...env }, killGraceMs: 300 });
      } else {
        running = runCommand({ command: ['sh', '-c', 'export PARENT_PID_FILE="$1" DESCENDANT_PID_FILE="$2"; exec "$3"', 'sh', parentFile, descendantFile, stub], cwd: '.' }, dir, null, 10_000);
      }
      const result = await running;
      assert.equal(result.timedOut, false);
      if (runner === 'runClaude') assert.equal(result.code, 0);
      else if (runner === 'sh') assert.equal(result.status, 0);
      else { assert.equal(result.pass, true); assert.equal(result.kind, 'pass'); }
      const parent = Number(readFileSync(parentFile, 'utf8').trim());
      const descendant = Number(readFileSync(descendantFile, 'utf8').trim());
      assert.ok(Number.isInteger(descendant) && descendant > 1);
      assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
      assert.equal(groupAlive(parent), false, 'cleanup must finish before resolution');
      if (runner === 'runClaude') assert.deepEqual(JSON.parse(readFileSync(pidFile, 'utf8')), []);
    } finally {
      if (existsSync(descendantFile)) {
        try { process.kill(Number(readFileSync(descendantFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
      }
      if (existsSync(parentFile)) signalGroup(Number(readFileSync(parentFile, 'utf8').trim()), 'SIGKILL');
      if (running) await running;
      rmSync(dir, { recursive: true, force: true });
    }
  });
}

test('suiteAcceptable accepts absent and passing suites with or without a baseline', () => {
  for (const baseline of [undefined, null, new Set(), ['known_failure']]) {
    assert.equal(suiteAcceptable(null, baseline), true);
    assert.equal(suiteAcceptable(undefined, baseline), true);
    assert.equal(suiteAcceptable({ pass: true, kind: 'pass', failed: [] }, baseline), true);
  }
});

test('suiteAcceptable rejects build, timeout, other and unnamed assertion failures with or without a baseline', () => {
  const broken = [
    { pass: false, kind: 'build', failed: [] },
    { pass: false, kind: 'timeout', failed: [] },
    { pass: false, kind: 'other', failed: ['known_failure'] },
    { pass: false, kind: 'build', failed: ['known_failure'] },
    { pass: false, kind: 'assertion', failed: [] },
    { pass: false, kind: 'assertion' },
  ];
  for (const suite of broken) {
    for (const baseline of [undefined, null, new Set(['known_failure']), ['known_failure']]) {
      assert.equal(suiteAcceptable(suite, baseline), false, `${suite.kind} ${JSON.stringify(suite.failed)} ${baseline}`);
    }
  }
});

test('suiteAcceptable accepts a parsed assertion failure without a baseline (sanity)', () => {
  assert.equal(suiteAcceptable({ pass: false, kind: 'assertion', failed: ['anything'] }), true);
  assert.equal(suiteAcceptable({ pass: false, kind: 'assertion', failed: ['anything'] }, null), true);
});

test('suiteAcceptable accepts baseline-only assertion failures and rejects new ones', () => {
  const baselineOnly = { pass: false, kind: 'assertion', failed: ['known_failure', 'other_known'] };
  const withNew = { pass: false, kind: 'assertion', failed: ['known_failure', 'new_failure'] };
  for (const baseline of [new Set(['known_failure', 'other_known']), ['known_failure', 'other_known']]) {
    assert.equal(suiteAcceptable(baselineOnly, baseline), true);
    assert.equal(suiteAcceptable(withNew, baseline), false);
  }
  assert.equal(suiteAcceptable(baselineOnly, new Set()), false);
  assert.equal(suiteAcceptable(baselineOnly, []), false);
});

for (const fixture of [
  { name: 'build error', output: 'error: could not compile fixture', kind: 'build', pass: false },
  { name: 'unparsed nonzero failure', output: 'process crashed', kind: 'build', pass: false },
  { name: 'assertion without parsed names', output: 'test result: FAILED', kind: 'assertion', pass: false },
  { name: 'only baseline assertions', output: 'test known_failure ... FAILED\ntest result: FAILED', kind: 'assertion', pass: true },
  { name: 'new assertion', output: 'test new_failure ... FAILED\ntest result: FAILED', kind: 'assertion', pass: false },
  { name: 'passing suite', output: '', kind: 'pass', pass: true, status: 0 },
  { name: 'no suite', kind: null, pass: true },
]) test(`gradeEdit checks suite outcome: ${fixture.name}`, async () => {
  const dir = scratch();
  try {
    const initialized = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const task = {
      id: 'suite-fixture', overlay: [],
      test: { command: [process.execPath, '-e', 'process.exit(0)'], cwd: '.' },
      ...(fixture.kind ? { suite: { command: [process.execPath, '-e', `console.log(${JSON.stringify(fixture.output)}); process.exit(${fixture.status ?? 1})`], cwd: '.' } } : {}),
    };
    const result = await gradeEdit(task, dir, null, { [task.id]: { suiteBaselineFailed: ['known_failure'] } });
    assert.equal(result.testPass, true);
    assert.equal(result.suiteKind, fixture.kind);
    assert.equal(result.pass, fixture.pass);
    assert.deepEqual(result.newSuiteFailures, fixture.name === 'new assertion' ? ['new_failure'] : []);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('gradeEdit rejects a suite timeout after the focused test passes', { timeout: 15_000 }, () => {
  const dir = scratch();
  try {
    const initialized = spawnSync('git', ['init', '-q', dir], { encoding: 'utf8' });
    assert.equal(initialized.status, 0, initialized.stderr);
    const source = `
      import { gradeEdit } from ${JSON.stringify(new URL('./lib.mjs', import.meta.url).href)};
      // Shorten only runCommand's 20-minute default; exercise its real timer and group cleanup.
      const schedule = globalThis.setTimeout;
      globalThis.setTimeout = (fn, ms, ...args) => schedule(fn, ms === 20 * 60_000 ? 500 : ms, ...args);
      const task = { id: 'timeout', overlay: [],
        test: { command: [process.execPath, '-e', 'process.exit(0)'], cwd: '.' },
        suite: { command: [process.execPath, '-e', 'setInterval(() => {}, 1000)'], cwd: '.' } };
      console.log(JSON.stringify(await gradeEdit(task, ${JSON.stringify(dir)}, null, {})));
    `;
    const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], { encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.status, 0, child.stderr);
    const result = JSON.parse(child.stdout.trim());
    assert.equal(result.testPass, true);
    assert.equal(result.suiteKind, 'timeout');
    assert.deepEqual(result.newSuiteFailures, []);
    assert.equal(result.pass, false);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('runClaude timeout waits for SIGKILL of a TERM-ignoring descendant with redirected stdio', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = scratch();
  const descendantFile = join(dir, 'descendant.pid');
  const parentFile = join(dir, 'parent.pid');
  const pidFile = join(dir, 'pids.json');
  let running;
  try {
    const stub = join(dir, 'claude');
    writeFileSync(stub, `#!/bin/sh
echo $$ > "$PARENT_PID_FILE"
trap 'exit 0' TERM
sh -c 'trap "" TERM; echo $$ > "$DESCENDANT_PID_FILE"; exec sleep 30' </dev/null >/dev/null 2>&1 &
descendant=$!
wait "$descendant"
`);
    chmodSync(stub, 0o755);
    // Leave time for the executable fixture and its child to start on a busy test host.
    running = runClaude(['hello'], dir, join(dir, 'stream.jsonl'), [], 2000, {
      PATH: dir + delimiter + process.env.PATH, PARENT_PID_FILE: parentFile, DESCENDANT_PID_FILE: descendantFile,
    }, pidFile, { killGraceMs: 300 });
    const result = await running;
    assert.equal(result.timedOut, true);
    assert.ok(result.wallMs >= 2250, 'timeout must wait through the grace window after the parent closes');
    const descendant = Number(readFileSync(descendantFile, 'utf8').trim());
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
    assert.deepEqual(JSON.parse(readFileSync(pidFile, 'utf8')), []);
  } finally {
    if (existsSync(descendantFile)) {
      try { process.kill(Number(readFileSync(descendantFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
    }
    if (existsSync(parentFile)) signalGroup(Number(readFileSync(parentFile, 'utf8').trim()), 'SIGKILL');
    if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
});

test('runClaude timeout kills the process group and closes inherited stdout promptly', { skip: process.platform === 'win32', timeout: 10_000 }, async () => {
  const dir = scratch();
  const descendantFile = join(dir, 'descendant.pid');
  const parentFile = join(dir, 'parent.pid');
  let deadline;
  let running;
  try {
    const stub = join(dir, 'claude');
    // The shell reaps its child on TERM, avoiding a zombie even on hosts with a slow init reaper.
    writeFileSync(stub, '#!/bin/sh\necho $$ > "$PARENT_PID_FILE"\ntrap \'wait "$descendant"; exit 0\' TERM\nsleep 30 &\ndescendant=$!\necho "$descendant" > "$DESCENDANT_PID_FILE"\nwait "$descendant"\n');
    chmodSync(stub, 0o755);
    const started = Date.now();
    running = runClaude(['hello'], dir, join(dir, 'stream.jsonl'), [], 2000, {
      PATH: dir + delimiter + process.env.PATH, PARENT_PID_FILE: parentFile, DESCENDANT_PID_FILE: descendantFile,
    });
    const result = await Promise.race([
      running,
      new Promise((_, reject) => { deadline = setTimeout(() => reject(new Error('runClaude did not close within 5 seconds')), 5000); }),
    ]);
    assert.equal(result.timedOut, true);
    assert.ok(Date.now() - started < 5000, 'timeout must close stdout well before the descendant exits naturally');
    const descendant = Number(readFileSync(descendantFile, 'utf8').trim());
    assert.ok(Number.isInteger(descendant) && descendant > 1);
    assert.throws(() => process.kill(descendant, 0), { code: 'ESRCH' });
  } finally {
    clearTimeout(deadline);
    if (existsSync(descendantFile)) {
      try { process.kill(Number(readFileSync(descendantFile, 'utf8').trim()), 'SIGKILL'); } catch { /* already gone */ }
    }
    if (existsSync(parentFile)) signalGroup(Number(readFileSync(parentFile, 'utf8').trim()));
    if (running) await running;
    rmSync(dir, { recursive: true, force: true });
  }
});

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

for (const layout of ['flat', 'nested']) test(`cloned Cargo cache regenerates missing build outputs in the ${layout} layout without changing the source cache`, async () => {
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
    // Scope the unstable layout opt-in to this dependency-free fixture; exercise both layouts on stable Cargo.
    const cargo = target => spawnSync('cargo', ['build', '--offline', '--config', `unstable.build-dir-new-layout=${layout === 'nested'}`], { cwd: crate, env: { ...process.env, RUSTC_BOOTSTRAP: '1', CARGO_TARGET_DIR: target, CARGO_INCREMENTAL: '0' }, encoding: 'utf8', timeout: 60_000 });
    const initial = cargo(cached);
    assert.equal(initial.status, 0, initial.stderr);
    const debug = join(cached, 'debug');
    const generated = tree(join(debug, 'build')).filter(([name]) => name.endsWith('generated.rs'));
    assert.equal(generated.length, 1);
    assert.match(generated[0][0].split(/[\\/]/).join('/'), layout === 'nested'
      ? /^cache-regeneration-fixture\/[0-9a-f]+\/(?:build-script-execution\/)?out\/generated\.rs$/
      : /^cache-regeneration-fixture-[0-9a-f]+\/out\/generated\.rs$/);
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

for (const pkg of ['new-layout-pkg', 'out', 'run', 'fingerprint']) test(`cloneTarget removes execution fingerprints for ${pkg} while retaining compiled artifacts and run markers`, async () => {
  const dir = scratch();
  try {
    const source = join(dir, 'source', 'debug');
    const flat = join('.fingerprint', 'flat-pkg-1234');
    const nested = join('.fingerprint', 'nested-pkg', '5678abcd');
    const buildUnit = join('build', pkg, '9abcdef0');
    const buildFingerprint = join(buildUnit, 'fingerprint');
    const flatRun = join('build', 'flat-pkg-1234');
    const preserved = [
      join(flatRun, 'invoked.timestamp'), join(flatRun, 'output'), join(flatRun, 'root-output'),
      join(buildUnit, 'run', 'invoked.timestamp'), join(buildUnit, 'run', 'stdout'), join(buildUnit, 'run', 'stderr'), join(buildUnit, 'run', 'root-output'),
      join(buildUnit, 'build-script-execution', 'output'), join(buildUnit, 'build-script-execution', 'root-output'),
      join(buildUnit, 'build-script-execution', 'out', 'fingerprint', 'run-build-script-generated-file'),
      join(buildUnit, 'out', 'build_script_build'), join(buildUnit, 'out', 'fingerprint', 'run-build-script-generated-file'),
    ];
    for (const rel of ['deps', flat, nested, buildFingerprint, flatRun, join(buildUnit, 'run'), join(buildUnit, 'out', 'fingerprint'), join(buildUnit, 'build-script-execution', 'out', 'fingerprint')]) mkdirSync(join(source, rel), { recursive: true });
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
      join(buildFingerprint, 'run-build-script-build-script-build'),
      join(buildFingerprint, 'run-build-script-build-script-build.json'),
      join(buildFingerprint, 'build-script-build-script-build'),
      join(buildFingerprint, 'build-script-build-script-build.json'),
      ...preserved,
    ]) writeFileSync(join(source, rel), 'cached');
    // A copied directory symlink must never let cleanup reach back into the source cache.
    symlinkSync(join(source, 'build', pkg), join(source, 'build', 'linked-pkg'));
    const to = join(dir, 'cloned');
    await cloneTarget(to, source);
    const cloned = join(to, 'debug');
    assert.deepEqual(readdirSync(join(cloned, flat)).sort(), ['build-script-build', 'build-script-build.json']);
    assert.deepEqual(readdirSync(join(cloned, nested)).sort(), ['build-script-build', 'build-script-build.json']);
    assert.deepEqual(readdirSync(join(cloned, buildFingerprint)).sort(), ['build-script-build-script-build', 'build-script-build-script-build.json']);
    assert.deepEqual(depsFingerprint(cloned), depsFingerprint(source));
    assert.equal(readlinkSync(join(cloned, 'build', 'linked-pkg')), join(source, 'build', pkg));
    for (const rel of preserved) {
      assert.equal(readFileSync(join(cloned, rel), 'utf8'), 'cached');
      assert.equal(readFileSync(join(source, rel), 'utf8'), 'cached');
    }
    assert.deepEqual(readdirSync(join(source, buildFingerprint)).sort(), [
      'build-script-build-script-build', 'build-script-build-script-build.json', 'run-build-script-build-script-build', 'run-build-script-build-script-build.json',
    ]);
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
