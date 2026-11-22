// Process, checkout, harness and test helpers shared by run.mjs, saver.mjs and scan-edits.mjs.
import { spawn, spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { chmodSync, copyFileSync, createWriteStream, existsSync, mkdirSync, readdirSync, readFileSync, realpathSync, rmSync, statfsSync, symlinkSync, writeFileSync } from 'node:fs';
import { rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, relative, sep } from 'node:path';
import { appendLedger, interruptedCharge, ledgerTotals, readLedger, writeAtomic } from './ledger.mjs';
import { random } from './stats.mjs';
import { analysisHashes } from './analyze.mjs';
import { fileURLToPath } from 'node:url';

export const REPO = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

/**
 * Where checkouts an agent or the explore server works in are made. Recorded data may sit in
 * ~/Library/Caches, but pandacode_explore refuses roots there, so trees never do.
 */
export const WORK_ROOT = process.env.PANDACODE_BENCH_WORK ?? join(tmpdir(), 'pandacode-bench-work');
// Mirrors the engine's home rules (src-tauri/src/workspace/secret_paths.rs): dot folders and app data
// under home are refused as roots, except HOME_ALLOWED. Compared in lower case, like the engine.
const HOME_APP_DATA = ['.config', '.local', 'library', 'appdata'];
const HOME_ALLOWED = ['.config/nvim', '.config/fish', '.config/zed', '.config/helix', '.config/alacritty', '.config/kitty', '.config/wezterm', 'library/mobile documents/com~apple~clouddocs'];
/** The real path of `dir`, through its nearest existing ancestor, so a symlink (old /tmp/pandacode-bench) can't hide it. */
const realOf = dir => (existsSync(dir) ? realpathSync(dir) : join(realOf(dirname(dir)), basename(dir)));
/** Refuses a tree root the explore tool would refuse, before anything is written there. */
export function assertExplorable(dir, home = homedir()) {
  const below = relative(realOf(home), realOf(dir));
  if (below === '' || below.startsWith('..')) return dir;
  const rel = below.split(sep).join('/').toLowerCase();
  const refused = rel.startsWith('.') || HOME_APP_DATA.some(folder => rel === folder || rel.startsWith(`${folder}/`));
  if (refused && !HOME_ALLOWED.some(allowed => rel === allowed || rel.startsWith(`${allowed}/`))) {
    throw new Error(`${dir} is under a home folder pandacode_explore refuses as a root; set PANDACODE_BENCH_WORK elsewhere`);
  }
  return dir;
}
const ENV_KEEP = /^(HOME|PATH|USER|LOGNAME|SHELL|LANG|LC_.*|TMPDIR|TERM|CARGO_HOME|RUSTUP_HOME|ANTHROPIC_.*)$/;
// The harness must talk only to its model API, and must not update itself mid-benchmark.
const ENV_SET = {
  DISABLE_TELEMETRY: '1', DISABLE_ERROR_REPORTING: '1', DISABLE_AUTOUPDATER: '1', DISABLE_BUG_COMMAND: '1',
  CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1', CLAUDE_CODE_DISABLE_AUTO_MEMORY: '1', ENABLE_CLAUDEAI_MCP_SERVERS: 'false',
};
export const safeEnv = extra => ({
  ...Object.fromEntries(Object.entries(process.env).filter(([key]) => ENV_KEEP.test(key))),
  ...ENV_SET,
  ...extra,
});

// Only PIDs this process started are ever signalled. PandaCode's own agents also match `claude -p`,
// so a pattern kill (pkill, killall) would stop unrelated tasks.
const children = new Map();
/** When a process started, which tells a recorded PID from a later process that reused the number. */
export const startTime = pid => spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' }).stdout.trim();
export function track(child, pidFile, { autoUntrack = true } = {}) {
  children.set(child, { pid: child.pid, started: child.pid ? startTime(child.pid) : '' });
  const save = () => { if (pidFile) writeAtomic(pidFile, JSON.stringify([...children.values()].filter(Boolean))); };
  save();
  child.untrack = () => { children.delete(child); save(); };
  if (autoUntrack) child.on('close', child.untrack);
  return child;
}
/** Children lead their own process group, so stopping one also stops what it started (cargo's rustc). */
export function signalGroup(pid, signal = 'SIGTERM') {
  try { process.kill(-pid, signal); } catch { try { process.kill(pid, signal); } catch { /* already gone */ } }
}
/** A closed group leader does not imply its redirected-stdio descendants have exited. */
export function groupAlive(pid) {
  if (process.platform === 'win32') return false;
  try { process.kill(-pid, 0); return true; } catch (error) { return error?.code === 'EPERM'; }
}
/** Keep ownership until TERM succeeds or KILL has had a bounded window to finish. */
export async function terminateGroup(pid, graceMs = 5000, pollMs = 50) {
  signalGroup(pid, 'SIGTERM');
  if (process.platform === 'win32') return;
  const waitForExit = async durationMs => {
    const deadline = Date.now() + durationMs;
    while (groupAlive(pid)) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) return false;
      await new Promise(resolve => setTimeout(resolve, Math.min(pollMs, remaining)));
    }
    return true;
  };
  if (!await waitForExit(graceMs)) {
    signalGroup(pid, 'SIGKILL');
    await waitForExit(1000);
  }
}
/** After a crash: signals only recorded PIDs that are still the same process, and says how many. */
export function stopRecorded(pidFile) {
  if (!existsSync(pidFile)) return 0;
  let stopped = 0;
  for (const { pid, started } of JSON.parse(readFileSync(pidFile, 'utf8'))) {
    if (started && startTime(pid) === started) {
      signalGroup(pid);
      stopped++;
    }
  }
  return stopped;
}
/** taskkill covers descendants on Windows; bound its own lifetime as well. */
function terminateWindowsTree(child) {
  return new Promise(resolve => {
    const killer = spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], {
      stdio: 'ignore', windowsHide: true, timeout: 2000, killSignal: 'SIGKILL',
    });
    killer.on('error', () => { child.kill(); resolve(); });
    killer.on('close', status => { if (status !== 0) child.kill(); resolve(); });
  });
}
export function stopChildrenOnSignal({ graceMs = 2000 } = {}) {
  let stopping = false;
  const stop = async signal => {
    if (stopping) return;
    stopping = true;
    // Capture ownership before close handlers can untrack a leader with live descendants.
    const live = [...children].map(([child, { pid }]) => ({ child, pid, untrack: child.untrack }));
    await Promise.allSettled(live.map(async ({ child, pid, untrack }) => {
      try {
        if (!pid) child.kill();
        else if (process.platform === 'win32') await terminateWindowsTree(child);
        else await terminateGroup(pid, graceMs);
      } finally { untrack(); }
    }));
    process.exit(signal === 'SIGINT' ? 130 : 143);
  };
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => { void stop(signal); });
}

// Anything slow must not block the event loop: other runs' stdout pipes and wall clocks live on it.
export const sh = (command, argv, options = {}) => new Promise((resolve, reject) => {
  const { timeout, killGraceMs = 5000, ...spawnOptions } = options;
  const windows = process.platform === 'win32';
  const child = track(spawn(command, argv, {
    stdio: ['ignore', 'pipe', 'pipe'], detached: !windows, ...spawnOptions,
    ...(timeout > 0 && !windows ? { detached: true } : {}),
  }), null, { autoUntrack: false });
  let stdout = '';
  let stderr = '';
  let timedOut = false;
  let cleanup = null;
  const timer = timeout > 0 ? setTimeout(() => {
    timedOut = true;
    if (windows && child.pid) {
      cleanup = terminateWindowsTree(child);
    } else {
      cleanup = child.pid ? terminateGroup(child.pid, killGraceMs) : (child.kill(), Promise.resolve());
    }
  }, timeout) : null;
  timer?.unref();
  child.stdout.on('data', data => { stdout += data; });
  child.stderr.on('data', data => { stderr += data; });
  child.on('error', async error => {
    clearTimeout(timer);
    await cleanup;
    child.untrack();
    reject(error);
  });
  child.on('close', async status => {
    clearTimeout(timer);
    if (timedOut) await cleanup;
    else if (!windows && child.pid && groupAlive(child.pid)) await terminateGroup(child.pid, killGraceMs);
    child.untrack();
    // A shell can handle TERM with exit zero; it still exceeded its deadline.
    resolve({ status: timedOut ? null : status, stdout, stderr, timedOut });
  });
});
export const must = async (command, argv, options) => {
  const result = await sh(command, argv, options);
  if (result.status !== 0) throw new Error(`${command} ${argv.join(' ')}: ${result.stderr.slice(-800)}`);
  return result.stdout;
};
export const freeGiB = out => { const s = statfsSync(out); return s.bavail * s.bsize / 2 ** 30; };

/** The git directory holding a task's repo: this checkout, or a bare clone under <out>/repos. */
export const repoDir = (repo, out) => (!repo || repo === 'pandacode' ? REPO : join(out, 'repos', `${repo}.git`));

/**
 * Agent settings a checkout must not carry. The harness runs with permissions skipped and
 * `--setting-sources project`, so a repo's `.claude/` (settings, hooks, skills, commands), `.mcp.json`
 * or `CLAUDE.md` anywhere in the tree would configure the agent under test. `AGENTS.md` is kept: it
 * is the project's own documentation and was in every recorded PandaCode checkout.
 */
const AGENT_FILE = /(^|\/)(CLAUDE(\.local)?\.md|\.mcp\.json)$|(^|\/)\.claude\//;
/** The paths to delete for `paths` (a tree's file list): files, or a whole `.claude` folder once. */
export const agentFiles = paths => [...new Set(paths.filter(path => AGENT_FILE.test(path)).map(path => path.replace(/((?:^|\/)\.claude)\/.*$/, '$1')))].sort();

/**
 * A fresh copy of `commit` with its own one-commit history, so history can't leak answers, and with
 * no agent settings (`agentFiles`). Returns the agent setting paths it removed.
 */
export async function materialize(gitDir, commit, dir, { nodeModules = false, prepare = null } = {}) {
  assertExplorable(dir);
  mkdirSync(dir, { recursive: true });
  await must('sh', ['-c', 'git -C "$1" archive "$2" | tar -x -C "$3"', 'sh', gitDir, commit, dir]);
  const removed = agentFiles((await must('git', ['-C', gitDir, 'ls-tree', '-r', '--name-only', commit])).split('\n'));
  for (const path of removed) rmSync(join(dir, path), { recursive: true, force: true });
  if (gitDir === REPO) {
    mkdirSync(join(dir, 'dist'), { recursive: true }); // tauri's generate_context! needs frontendDist to exist
    writeFileSync(join(dir, 'dist', 'index.html'), '<!doctype html>\n');
  }
  if (nodeModules && !existsSync(join(dir, 'node_modules'))) symlinkSync(join(REPO, 'node_modules'), join(dir, 'node_modules'));
  prepare?.(dir);
  const git = (...rest) => must('git', ['-C', dir, '-c', 'user.name=bench', '-c', 'user.email=bench@localhost', ...rest]);
  await git('init', '-q');
  writeFileSync(join(dir, '.git', 'info', 'exclude'), 'dist/\nnode_modules\n');
  await git('add', '-A');
  await git('commit', '-q', '-m', 'snapshot', '--no-gpg-sign');
  return removed;
}

const TEST_MODULE = /^#\[cfg\((?:test|all\(test[^\]]*\))\)\]\s*\n\s*(pub\(crate\) )?mod tests\b/m;
/** Replaces everything from the inline test module on with the commit's test module. */
export function withCommitTests(current, fromCommit) {
  const a = current.search(TEST_MODULE);
  const b = fromCommit.search(TEST_MODULE);
  if (b < 0) throw new Error('commit has no inline test module');
  return (a < 0 ? `${current}\n` : current.slice(0, a)) + fromCommit.slice(b);
}
export async function overlayTests(task, dir, gitDir = REPO) {
  for (const { path, mode } of task.overlay) {
    const theirs = await must('git', ['-C', gitDir, 'show', `${task.commit}:${path}`]);
    const target = join(dir, path);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, mode === 'file' ? theirs : withCommitTests(readFileSync(target, 'utf8'), theirs));
  }
}
/** A stub adds only the symbols the commit's tests name, with no fix behind them. */
export function applyStub(stub, dir) {
  for (const { path, find, replace } of stub ?? []) {
    const target = join(dir, path);
    const text = readFileSync(target, 'utf8');
    if (!text.includes(find)) throw new Error(`stub anchor not found in ${path}: ${find}`);
    writeFileSync(target, text.replace(find, () => replace));
  }
}
/** Copies the commit's files over the checkout: the real fix. */
export async function applyFix(task, parent, dir, gitDir = REPO) {
  const files = (await must('git', ['-C', gitDir, 'diff', '--name-status', '--no-renames', parent, task.commit])).trim().split('\n');
  for (const line of files) {
    const [state, path] = line.split('\t');
    if (state === 'D') continue;
    const blob = await new Promise((resolve, reject) => {
      const child = spawn('git', ['-C', gitDir, 'show', `${task.commit}:${path}`], { stdio: ['ignore', 'pipe', 'ignore'] });
      const chunks = [];
      child.stdout.on('data', d => chunks.push(d));
      child.on('error', reject);
      child.on('close', () => resolve(Buffer.concat(chunks)));
    });
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), blob);
  }
}
export async function runCommand(test, dir, targetDir, timeoutMs = 20 * 60_000) {
  const started = Date.now();
  const result = await sh(test.command[0], test.command.slice(1), {
    cwd: join(dir, test.cwd), timeout: timeoutMs,
    env: safeEnv(targetDir ? { CARGO_TARGET_DIR: targetDir, CARGO_INCREMENTAL: '0' } : {}),
  });
  const output = `${result.stdout}\n${result.stderr}`;
  return { pass: !result.timedOut && result.status === 0, ms: Date.now() - started, kind: result.timedOut ? 'timeout' : failureKind(output, result.status), failed: failedTests(output), tail: output.slice(-3000), timedOut: result.timedOut };
}
/** `pass`, `assertion` (the tests ran and failed) or `build` (they never ran). */
export function failureKind(output, status) {
  if (status === 0) return 'pass';
  // Checked first: cargo ends a failed test run with its own `error: test failed`.
  if (/test result: FAILED/.test(output)) return 'assertion';
  // Bun: `(fail) <name> [<ms>]`, checked before the build patterns, which its stack traces can match.
  if (/^\(fail\) /m.test(output)) return 'assertion';
  if (/could not compile|^error(\[E\d+\])?:/m.test(output)) return 'build';
  if (/does not provide an export|ERR_MODULE_NOT_FOUND|SyntaxError|Cannot find module/.test(output)) return 'build';
  return /^not ok \d+|^✖ /m.test(output) ? 'assertion' : 'build';
}
/** Names of failed tests, from cargo's, node's or Bun's output. */
export function failedTests(output) {
  const rust = [...output.matchAll(/^test (\S+)(?: - .*)? \.\.\. FAILED$/gm)].map(m => m[1]);
  const node = [...output.matchAll(/^\s*not ok \d+ - (.+)$/gm)].map(m => m[1]);
  const bun = [...output.matchAll(/^\(fail\) (.+?)(?: \[[\d.]+m?s\])?$/gm)].map(m => m[1]);
  return [...new Set([...rust, ...node, ...bun])].sort();
}

/**
 * A run's independent dependency cache: an APFS clone on macOS, a portable copy elsewhere, removed
 * with the run. Incremental data is keyed by path, so a clone at a new path can't reuse it.
 */
export async function cloneTarget(to, source = join(REPO, 'src-tauri', 'target', 'debug')) {
  mkdirSync(to, { recursive: true });
  await must('cp', [...(process.platform === 'darwin' ? ['-c'] : []), '-R', '-p', source, join(to, 'debug')], { timeout: 20 * 60_000 });
  await rm(join(to, 'debug', 'incremental'), { recursive: true, force: true, maxRetries: 3 });
  // Dependency identity (depsFingerprint) does not guarantee build-output completeness.
  // Rerun build scripts at the relocated OUT_DIR; retain their compilation cache and the source.
  const stripBuildScriptRuns = async dir => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const path = join(dir, entry.name);
      if (entry.isDirectory()) await stripBuildScriptRuns(path);
      else if (entry.name.startsWith('run-build-script-')) await rm(path, { force: true });
    }
  };
  const fingerprints = join(to, 'debug', '.fingerprint');
  if (existsSync(fingerprints)) await stripBuildScriptRuns(fingerprints);
  // -Zbuild-dir-new-layout stores these in build/<pkg>/<hash>/fingerprint instead.
  // Invalidate execution there too; keep run/{stdout,root-output,invoked.timestamp},
  // compiled build scripts and out/ artifacts. Never traverse output trees or symlinks.
  const build = join(to, 'debug', 'build');
  if (existsSync(build)) for (const pkg of readdirSync(build, { withFileTypes: true })) {
    if (!pkg.isDirectory()) continue;
    const pkgPath = join(build, pkg.name);
    for (const unit of readdirSync(pkgPath, { withFileTypes: true })) {
      // Flat layouts have out/ here; package names themselves may be out, run or fingerprint.
      if (!unit.isDirectory() || unit.name === 'out' || unit.name === 'run') continue;
      const unitPath = join(pkgPath, unit.name);
      for (const entry of readdirSync(unitPath, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name === 'fingerprint') await stripBuildScriptRuns(join(unitPath, entry.name));
      }
    }
  }
}
/**
 * The old commit builds with today's dependencies, the ones already built in that target. Its own
 * manifest would rebuild 80 crates per run, which this disk can't hold. Tests and fixes are unaffected.
 * `from` is where Cargo.lock and Cargo.toml come from: the snapshot `--prepare` took (`snapshotBuild`),
 * or, for batches prepared before round 17, the live tree.
 */
export const pinDependencies = (dir, from = join(REPO, 'src-tauri')) => {
  copyFileSync(join(from, 'Cargo.lock'), join(dir, 'src-tauri', 'Cargo.lock'));
  copyFileSync(join(from, 'Cargo.toml'), join(dir, 'src-tauri', 'Cargo.toml'));
};

/** Artifacts of the workspace's own crates, which change with every source edit and are rebuilt per run. */
const OWN_CRATE = /^(lib)?pandacode(_lib)?[-.]/;
/**
 * The dependencies a Rust run's cloned target holds: the sha256 of the sorted artifact names in
 * `target/debug/deps` (cargo puts each crate's version, features and profile in the name's hash),
 * leaving out the workspace's own crates.
 */
export function depsFingerprint(target = join(REPO, 'src-tauri', 'target', 'debug')) {
  const deps = join(target, 'deps');
  if (!existsSync(deps)) return null;
  const names = readdirSync(deps).filter(name => !OWN_CRATE.test(name)).sort();
  return { sha256: createHash('sha256').update(names.join('\n')).digest('hex'), files: names.length };
}

/**
 * Batch build inputs (round 17 on): copies Cargo.lock and Cargo.toml into `dir` and records their
 * sha256 with the dependency fingerprint of `target/debug`. Runs pin these and refuse a drifted target.
 */
export function snapshotBuild(dir, source = join(REPO, 'src-tauri'), target) {
  mkdirSync(dir, { recursive: true });
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  for (const name of ['Cargo.lock', 'Cargo.toml']) copyFileSync(join(source, name), join(dir, name));
  return { dir, cargoLockSha256: hash(join(dir, 'Cargo.lock')), cargoTomlSha256: hash(join(dir, 'Cargo.toml')), deps: depsFingerprint(target ?? join(source, 'target', 'debug')), ...(target ? { target } : {}) };
}

/** Refuses a run when the snapshot's manifests or the live target's dependencies drifted since --prepare. */
export function assertBuild(build) {
  if (!build) return;
  const hash = file => createHash('sha256').update(readFileSync(file)).digest('hex');
  if (hash(join(build.dir, 'Cargo.lock')) !== build.cargoLockSha256 || hash(join(build.dir, 'Cargo.toml')) !== build.cargoTomlSha256) throw new Error('the Cargo.lock/Cargo.toml snapshot changed since --prepare');
  const live = depsFingerprint(build.target);
  if (live?.sha256 !== build.deps?.sha256) throw new Error(`Rust dependencies changed since --prepare (${build.deps?.sha256?.slice(0, 12)} → ${live?.sha256?.slice(0, 12)}); rerun --prepare and use a new batch name`);
}

export const isRust = task => task.test?.command[0] === 'cargo';

/** Sends the messages one at a time over stream-json, the way the app does, each after the last result. */
export function runClaude(messages, cwd, stream, argv, timeoutMs, extraEnv, pidFile, { killGraceMs = 5000 } = {}) {
  return new Promise(resolve => {
    const started = Date.now();
    const child = track(spawn('claude', ['-p', '--input-format', 'stream-json', ...argv], { cwd, env: safeEnv(extraEnv), stdio: ['pipe', 'pipe', 'pipe'], detached: true }), pidFile, { autoUntrack: false });
    const out = createWriteStream(stream);
    out.on('error', () => {}); // a failed output stream must not crash the batch
    const queue = [...messages];
    const send = () => {
      const content = queue.shift();
      child.stdin.write(`${JSON.stringify({ type: 'user', message: { role: 'user', content } })}\n`);
      if (!queue.length) child.stdin.end();
    };
    let stderr = '';
    let buffer = '';
    child.stdout.on('data', data => {
      out.write(data);
      buffer += data;
      for (let at = buffer.indexOf('\n'); at >= 0; at = buffer.indexOf('\n')) {
        if (queue.length && buffer.slice(0, at).includes('"type":"result"')) send();
        buffer = buffer.slice(at + 1);
      }
    });
    child.stderr.on('data', data => { stderr += data; });
    child.stdin.on('error', () => {}); // a harness that died early is reported by its exit code
    let settled = false;
    let timedOut = false;
    let cleanup = null;
    const timer = setTimeout(() => {
      timedOut = true;
      cleanup = child.pid ? terminateGroup(child.pid, killGraceMs) : (child.kill('SIGTERM'), Promise.resolve());
    }, timeoutMs);
    child.once('error', async error => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      await cleanup;
      child.untrack();
      out.end(() => resolve({ code: null, timedOut: false, spawnError: error.code ?? error.message, wallMs: Date.now() - started, stderr: (stderr || error.message || String(error)).slice(-2000) }));
    });
    child.once('close', async code => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (timedOut) await cleanup;
      else if (child.pid && groupAlive(child.pid)) await terminateGroup(child.pid, killGraceMs);
      child.untrack();
      out.end(() => resolve({ code, timedOut, wallMs: Date.now() - started, stderr: stderr.slice(-2000) }));
    });
    send();
  });
}

/** Only the arm's own lines differ between arms. */
export function harnessArgs({ arm, model, config, instructions, runBudget }) {
  const common = [
    '--output-format', 'stream-json', '--verbose', '--include-hook-events', '--model', model,
    '--strict-mcp-config', '--setting-sources', 'project', '--no-session-persistence',
    '--dangerously-skip-permissions', '--max-budget-usd', String(runBudget),
  ];
  // after-e (batch Fv2): AFTER's server with batch E's LOOK text, on edits only.
  // none/tools (batch R1): AFTER's flags; tools' text is LOOK then REUSE, its server adds the tools.
  if (['after', 'after-e', 'none', 'tools'].includes(arm)) return [...common, '--mcp-config', config, '--append-system-prompt', instructions[arm]];
  if (arm === 'instruction') return [...common, '--mcp-config', '{"mcpServers":{}}', '--append-system-prompt', instructions.instruction];
  return [...common, '--mcp-config', '{"mcpServers":{}}'];
}

export async function gradeEdit(task, work, target, verified, gitDir = REPO) {
  await overlayTests(task, work, gitDir);
  const test = await runCommand(task.test, work, target);
  const suite = task.suite ? await runCommand(task.suite, work, target) : null;
  const baseline = new Set(verified[task.id]?.suiteBaselineFailed ?? []);
  const newFailures = (suite?.failed ?? []).filter(name => !baseline.has(name));
  const suiteOk = !suite || suite.pass || (suite.kind === 'assertion' && suite.failed.length > 0 && !newFailures.length);
  const status = (await sh('git', ['-C', work, 'status', '--porcelain'])).stdout.split('\n').filter(Boolean);
  const overlaid = new Set(task.overlay.map(o => o.path));
  const changed = status.map(line => line.slice(3)).filter(path => !overlaid.has(path) && path !== 'src-tauri/Cargo.lock' && path !== 'src-tauri/Cargo.toml');
  return { pass: test.pass && suiteOk, testPass: test.pass, testKind: test.kind, testFailed: test.failed, newSuiteFailures: newFailures, suiteKind: suite?.kind ?? null, testMs: test.ms, tail: test.tail.slice(-1000), changed };
}


const rustConst = (instructions, name) => {
  const match = instructions.match(new RegExp(`const ${name}: &str = "((?:[^"\\\\]|\\\\.)*)";`));
  if (!match) throw new Error(`${name} not found in app_instructions.rs`);
  return match[1].replace(/\\(["\\n])/g, (_, c) => (c === 'n' ? '\n' : c));
};
/**
 * The explore clause as `look()` in app_instructions.rs builds it for Claude Code (`claude_code` true): `LOOK`
 * with every `{explore}` replaced, then `EDIT_CLAUDE`; older trees had `LOOK` alone.
 */
export function exploreClause(instructions = readFileSync(join(REPO, 'src-tauri/src/app_instructions.rs'), 'utf8')) {
  const look = rustConst(instructions, 'LOOK').replaceAll('{explore}', 'pandacode_explore');
  const edit = /fn look\(/.test(instructions) ? rustConst(instructions, 'EDIT_CLAUDE') : '';
  return `${look}${edit}`.trim();
}

/** `REUSE` from app_instructions.rs, the instruction that comes with agent-made tools (batch R1). */
export const reuseClause = (instructions = readFileSync(join(REPO, 'src-tauri/src/app_instructions.rs'), 'utf8')) => rustConst(instructions, 'REUSE').trim();

const SERVE_TEST = 'providers::mcp_host::tests::explore_mcp_serve';
/** Batch R1: explore plus the agent-made tools (`PANDACODE_BENCH_TOOLS`, `_PROJECT`, `_SESSION`, `_NOTE` in `env`). */
export const TOOLS_SERVE_TEST = 'providers::mcp_host::tests::custom_tools_mcp_serve';
/** The explore MCP server of a prepared snapshot, rooted at `root`; it writes its MCP config to `runDir/mcp.json`. */
export function startExplore(bin, root, runDir, pidFile, { test = SERVE_TEST, env = {} } = {}) {
  assertExplorable(root);
  const config = join(runDir, 'mcp.json');
  const server = track(spawn(bin, [test, '--exact', '--ignored', '--nocapture'], {
    env: safeEnv({ ...env, PANDACODE_BENCH_ROOT: root, PANDACODE_BENCH_CONFIG: config }), stdio: 'ignore', detached: true,
  }), pidFile);
  return { server, config };
}
export async function waitForFile(path, ms = 15_000) {
  const end = Date.now() + ms;
  while (!existsSync(path)) {
    if (Date.now() > end) throw new Error('explore server did not start');
    await new Promise(done => setTimeout(done, 50));
  }
}

/** The text between `<!-- X -->` and `<!-- /X -->`, X being `prereg:<batch>` or `deviation:<id>`. */
export function markedSection(doc, marker) {
  const open = `<!-- ${marker} -->`;
  const start = doc.indexOf(open);
  const end = doc.indexOf(`<!-- /${marker} -->`);
  if (start < 0 || end < start) throw new Error(`no section ${marker}`);
  return doc.slice(start + open.length, end);
}

/**
 * Appends a pre-registration or deviation to results/preregistrations.jsonl: the section's sha256,
 * the time, the sha256 of each pinned task file, and the previous line's sha256 (an append-only chain).
 */
export function register({ batch, doc, marker = `prereg:${batch}`, pins = [], supersedes = null, note = null, now = new Date() }, file = join(REPO, 'scripts/agent-bench/results/preregistrations.jsonl')) {
  const hash = text => createHash('sha256').update(text).digest('hex');
  const lines = readFileSync(file, 'utf8').split('\n').filter(Boolean);
  const section = markedSection(readFileSync(join(REPO, doc), 'utf8'), marker);
  const entry = {
    batch, kind: marker.startsWith('deviation:') ? 'deviation' : 'prereg', writtenAt: now.toISOString(), doc, marker, sectionSha256: hash(section),
    files: Object.fromEntries(pins.map(name => [name, hash(readFileSync(join(REPO, 'scripts/agent-bench', name)))])),
    // Round 17 on: the analysis code too, so analyze.mjs can say when it is not the registered code.
    analysis: analysisHashes(),
    ...(supersedes ? { supersedes } : {}), ...(note ? { note } : {}), prev: lines.length ? hash(lines.at(-1)) : null,
  };
  writeFileSync(file, `${[...lines, JSON.stringify(entry)].join('\n')}\n`);
  return entry;
}

// ---------- Runner core, shared by run.mjs and saver.mjs ----------

/** The last cumulative `total_cost_usd` a transcript reported, or null. */
export const reportedCost = text => text.split('\n').flatMap(line => { try { const e = JSON.parse(line); return e.type === 'result' ? [e.total_cost_usd] : []; } catch { return []; } }).at(-1) ?? null;

/**
 * Startup after a crash or restart: one runner per `out`. Stops what the last runner left, charges
 * each run it never ended the larger of its cap and the cost its transcript last reported
 * (`out/runs/<batch>/<id>/stream.jsonl`), and clears its checkouts. Those runs have no run.json, so
 * they start again.
 */
export function claimRunner({ out, pids, ledger, work }) {
  const runner = join(out, 'runner.json');
  if (existsSync(runner)) {
    const { pid, started } = JSON.parse(readFileSync(runner, 'utf8'));
    if (pid !== process.pid && startTime(pid) === started) throw new Error(`runner ${pid} is still working on ${out}`);
  }
  writeAtomic(runner, JSON.stringify({ pid: process.pid, started: startTime(process.pid) }));
  writeFileSync(join(out, 'runner.pid'), String(process.pid));
  const stopped = stopRecorded(pids);
  const { open } = ledgerTotals(readLedger(ledger));
  for (const attempt of open) {
    const stream = join(out, 'runs', attempt.batch, attempt.id, 'stream.jsonl');
    const reported = existsSync(stream) ? reportedCost(readFileSync(stream, 'utf8')) : null;
    appendLedger(ledger, { type: 'interrupted', attempt: attempt.attempt, id: attempt.id, reportedUsd: reported, chargedUsd: interruptedCharge(attempt.capUsd, reported) });
  }
  rmSync(work, { recursive: true, force: true, maxRetries: 3 });
  const recovered = { stoppedProcesses: stopped, interruptedRuns: open.map(a => a.id) };
  if (stopped || open.length) console.log(JSON.stringify({ recovered }));
  return recovered;
}

/**
 * A batch keeps its seed and pins for life, so a resumed batch can't mix versions. A pin whose value
 * is undefined must be absent from the saved batch too. A runner change is allowed but noted: each
 * run records its own runner hash.
 */
export function pinnedSeed(file, pins, runnerHash, requested = null) {
  if (existsSync(file)) {
    const saved = JSON.parse(readFileSync(file, 'utf8'));
    for (const [key, value] of Object.entries(pins)) if (saved[key] !== value) throw new Error(`${basename(dirname(file))} was started with another ${key}; use a new batch name`);
    if (saved.runnerHash && saved.runnerHash !== runnerHash) console.log('note: the runner changed since this batch started; run.json hashes.runner tells the runs apart');
    return saved.seed;
  }
  const seed = requested != null ? Number(requested) : randomBytes(4).readUInt32LE();
  writeAtomic(file, JSON.stringify({ seed, ...pins, runnerHash, createdAt: new Date().toISOString() }, null, 1));
  return seed;
}

/**
 * Jobs in a seeded random order: the groups are shuffled, then each group's arms (`armsOf(group)`),
 * which run next to each other. Every arm order is equally likely per group.
 */
export function seededJobs(groups, armsOf, batchSeed) {
  const next = random(batchSeed);
  const shuffled = list => {
    const copy = [...list];
    for (let i = copy.length - 1; i > 0; i--) {
      const j = Math.floor(next() * (i + 1));
      [copy[i], copy[j]] = [copy[j], copy[i]];
    }
    return copy;
  };
  return shuffled(groups).flatMap((g, group) => {
    const order = shuffled(armsOf(g));
    return order.map(arm => ({ ...g, arm, order, group }));
  });
}

/** Stops before a run could cross the budget. The ledger total already holds every in-flight run's cap. */
export const canStart = ({ totalUsd, cap, budget }) => totalUsd + cap <= budget;

export const DISK_WAIT_MS = 60 * 60_000;
/** Stops the process when the disk reaches the floor while `active()` (a writer runs, or always). */
export function guardDisk(out, minFreeGiB, active, free = freeGiB) {
  return setInterval(() => {
    if (free(out) >= minFreeGiB || !active()) return;
    console.log(JSON.stringify({ stoppedBy: 'low disk', freeGiB: Number(free(out).toFixed(2)) }));
    process.kill(process.pid, 'SIGTERM');
  }, 3000).unref();
}

/**
 * Runs `jobs`, `limit` at a time, in order.
 * - Disk: a job starts only if the disk stays `minFreeGiB` above what running jobs may still write
 *   (`diskNeed`). Other tasks' builds move it by gigabytes for minutes, so it waits, up to an hour.
 *   Only jobs that `write` are stopped by the floor (`guardDisk`).
 * - Budget: a job starts only if its `cap` fits. A run in flight usually comes in under its cap and
 *   frees the rest, so a worker that can't start one just ends, and the last one decides.
 * - `aborted()` (a pinned model or harness check) stops it before the next job.
 * Writes `<batchDir>/report.json` and returns it.
 */
export async function pool(jobs, { limit, batchDir, out, ledger, minFreeGiB, budget, cap, diskNeed, writes = () => false, runOne, aborted = () => null, log = () => {}, name = job => job.id, sleep = ms => new Promise(done => setTimeout(done, ms)), free = freeGiB }) {
  const spent = () => ledgerTotals(readLedger(ledger)).totalUsd;
  let next = 0, inFlight = 0, diskHeld = 0, writers = 0, lowSince = null, stop = null;
  const ran = [];
  const guard = guardDisk(out, minFreeGiB, () => writers > 0, free);
  const worker = async () => {
    while (next < jobs.length && !stop) {
      if (aborted()) { stop = aborted(); return; }
      const job = jobs[next];
      if (free(out) - diskHeld - diskNeed(job) < minFreeGiB) {
        lowSince ??= Date.now();
        if (Date.now() - lowSince > DISK_WAIT_MS) { stop = `low disk: ${free(out).toFixed(1)} GiB free, floor ${minFreeGiB}`; return; }
        await sleep(15_000);
        continue;
      }
      lowSince = null;
      if (!canStart({ totalUsd: spent(), cap: cap(job), budget })) {
        if (!inFlight) stop = `budget: $${spent().toFixed(2)} of $${budget}`;
        return;
      }
      next++;
      inFlight++;
      const need = diskNeed(job);
      const writer = writes(job);
      diskHeld += need;
      if (writer) writers++;
      const result = await runOne(job).finally(() => { diskHeld -= need; if (writer) writers--; inFlight--; });
      if (result.skipped) continue;
      ran.push(result.id);
      log(result, { spentUsd: spent(), next, total: jobs.length });
    }
  };
  await Promise.all(Array.from({ length: limit }, worker));
  clearInterval(guard);
  const report = { batch: basename(batchDir), stoppedBy: stop, ran: ran.length, remaining: jobs.slice(next).map(name), spentUsd: spent(), budgetUsd: budget };
  writeAtomic(join(batchDir, 'report.json'), JSON.stringify(report, null, 1));
  console.log(JSON.stringify({ ...report, remaining: report.remaining.length }));
  if (stop) process.exitCode = 3;
  return report;
}

/**
 * One measured run in `runDir`: ledger start, `body(work, held)` filling `record` (a throw becomes
 * its `failure`), then cleanup that never ends the batch, run.json, ledger end. `held.server` is
 * killed at the end. Returns `{ skipped: true }` when run.json exists and `force` is off.
 */
export async function measuredRun({ runDir, ledger, workRoot, batch, id, capUsd, record, force = false, body }) {
  const final = join(runDir, 'run.json');
  if (existsSync(final) && !force) return { skipped: true };
  rmSync(runDir, { recursive: true, force: true });
  mkdirSync(runDir, { recursive: true });
  const attempt = randomBytes(6).toString('hex');
  appendLedger(ledger, { type: 'start', attempt, id, batch, capUsd });
  const work = join(workRoot, attempt, 'repo');
  const held = { server: null };
  try {
    await body(work, held);
  } catch (error) {
    Object.assign(record, { success: false, failure: String(error), wallMs: record.wallMs ?? null, billedUsd: record.billedUsd ?? 0 });
  } finally {
    if (held.server?.pid) signalGroup(held.server.pid, 'SIGKILL'); else held.server?.kill('SIGKILL');
    // A tool the agent left running can still be writing into the checkout.
    await rm(dirname(work), { recursive: true, force: true, maxRetries: 5, retryDelay: 500 }).catch(error => { record.cleanupError = String(error).slice(0, 200); });
    rmSync(join(runDir, 'mcp.json'), { force: true });
  }
  record.finishedAt = new Date().toISOString();
  writeAtomic(final, JSON.stringify(record, null, 1));
  appendLedger(ledger, { type: 'end', attempt, billedUsd: record.billedUsd ?? 0 });
  return record;
}

/** The explore server for a run, started and ready, its config readable only by this user. */
export async function readyExplore(bin, root, runDir, pidFile, options) {
  const started = startExplore(bin, root, runDir, pidFile, options);
  await waitForFile(started.config);
  chmodSync(started.config, 0o600);
  return started;
}
