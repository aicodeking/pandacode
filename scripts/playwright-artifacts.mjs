import { createHash, randomUUID } from 'node:crypto';
import { existsSync, linkSync, lstatSync, mkdirSync, openSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, unlinkSync, writeFileSync, closeSync } from 'node:fs';
import { isAbsolute, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

const leaseEnvironment = 'PANDACODE_BROWSER_TEST_LEASE';
const ownedLeases = new Map();

export function artifactPaths(root = process.cwd(), engine = 'chromium') {
  const cache = join(root, 'node_modules', '.cache', 'pandacode-browser-tests');
  return {
    cache,
    lock: join(cache, 'run.lock'),
    production: join(cache, 'production'),
    manifest: join(cache, 'production.json'),
    reports: join(root, 'playwright-report', 'latest', engine),
  };
}

export function reportDirectory(root, engine, archive) {
  if (!archive) return artifactPaths(root, engine).reports;
  const archiveRoot = resolve(root, 'playwright-report', 'archive');
  const directory = resolve(root, archive);
  const inside = relative(archiveRoot, directory);
  if (!inside || inside.startsWith('..') || isAbsolute(inside)) {
    throw new Error('PW_REPORT_DIR must name a dedicated folder under playwright-report/archive/.');
  }
  return engine === 'webkit' ? join(directory, 'webkit') : join(directory, 'chromium');
}

function readLease(path, root) {
  if (lstatSync(path).isSymbolicLink()) throw new Error(`Refusing a linked browser-test lease: ${path}`);
  const value = JSON.parse(readFileSync(path, 'utf8'));
  if (value.schema !== 1 || value.root !== root || !Number.isSafeInteger(value.pid) || value.pid <= 0 || typeof value.id !== 'string' ||
    (value.children !== undefined && (!Array.isArray(value.children) || value.children.some(pid => !Number.isSafeInteger(pid) || pid <= 0)))) {
    throw new Error(`Unrecognized browser-test lease; inspect it before removing it: ${path}`);
  }
  return value;
}

// Readers never take the update lock, so the lease file must change atomically: a reader sees
// either the previous or the next complete record, never a truncated one.
function writeLease(path, lease) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(lease));
  for (let attempt = 0; ; attempt++) {
    try { renameSync(temporary, path); return; }
    catch (error) {
      // Windows refuses to replace a file another process is reading at that instant.
      if (!['EPERM', 'EACCES', 'EBUSY'].includes(error.code) || attempt >= 400) { rmSync(temporary, { force: true }); throw error; }
      pause(5 + (attempt % 10));
    }
  }
}

// Exclusive creation with complete contents: link fails with EEXIST if the lease already exists.
function createLease(path, lease) {
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  writeFileSync(temporary, JSON.stringify(lease));
  try { linkSync(temporary, path); } finally { unlinkSync(temporary); }
}

function pause(ms) { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); }

// Workers join and leave concurrently; serialize their read-modify-write so no child is lost.
function updateLease(path, root, change) {
  const guard = `${path}.update`;
  let fd;
  for (let attempt = 0; fd === undefined; attempt++) {
    try { fd = openSync(guard, 'wx'); }
    catch (error) {
      // Windows reports a guard another process just unlinked (delete pending) as EPERM/EACCES.
      const busy = ['EEXIST', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code);
      // Wait longer than one holder's whole rename retry window (writeLease).
      if (!busy || attempt >= 2000) throw busy ? new Error(`Browser-test lease update is stuck; inspect ${guard}.`) : error;
      pause(10);
    }
  }
  try {
    if (!existsSync(path)) return;
    const current = readLease(path, root);
    const next = change(current);
    if (next) writeLease(path, next);
  } finally {
    closeSync(fd);
    unlinkSync(guard);
  }
}

function alive(pid) {
  try { process.kill(pid, 0); return true; }
  catch (error) {
    if (error.code === 'ESRCH') return false;
    // Windows answers EPERM for an exited process whose handle is still held (or a reused PID of a
    // protected process). Lease PIDs are this user's own node processes, which are always signalable.
    if (error.code === 'EPERM') return process.platform !== 'win32';
    throw error;
  }
}

// Acquire while loading the runner config, BEFORE Playwright clears outputDir.
// A globalSetup or webServer-only lock would protect the build but not the reports.
export function acquireBrowserRun({ root = process.cwd(), argv = process.argv, allowInherited = false, installExitHandler = true } = {}) {
  if (argv.some(arg => ['--list', '--help', '-h', '--version'].includes(arg))) return () => {};
  root = realpathSync(root);
  const paths = artifactPaths(root);
  if (ownedLeases.has(paths.lock)) return ownedLeases.get(paths.lock);
  const worker = argv.some(arg => /[\\/]workerProcessEntry\.js$/.test(arg));
  if ((allowInherited || worker) && process.env[leaseEnvironment] && existsSync(paths.lock)) {
    const lease = readLease(paths.lock, root);
    if (process.env[leaseEnvironment] === lease.id && alive(lease.pid)) {
      // A surviving preview must protect its build even if the runner itself is interrupted.
      updateLease(paths.lock, root, current => current.id === lease.id ? { ...current, children: [...new Set([...(current.children ?? []), process.pid])] } : null);
      let released = false;
      const releaseChild = () => {
        if (released) return;
        released = true;
        updateLease(paths.lock, root, current => current.id === lease.id ? { ...current, children: (current.children ?? []).filter(pid => pid !== process.pid) } : null);
      };
      if (installExitHandler) process.once('exit', releaseChild);
      return releaseChild;
    }
  }
  mkdirSync(paths.cache, { recursive: true });
  const lease = { schema: 1, root, pid: process.pid, id: randomUUID() };
  let created = false;
  for (let attempt = 0; attempt < 2; attempt++) {
    try { createLease(paths.lock, lease); created = true; break; }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      // Serialize stale-owner recovery too: two reclaimers must never unlink a new live lease.
      const recovery = `${paths.lock}.reclaim`;
      let recoveryFd;
      try { recoveryFd = openSync(recovery, 'wx'); }
      catch (recoveryError) {
        if (recoveryError.code !== 'EEXIST') throw recoveryError;
        throw new Error(`Another runner is checking the browser-test lease. Retry after it exits; if interrupted, inspect ${recovery}.`);
      }
      try {
        if (existsSync(paths.lock)) {
          const previous = readLease(paths.lock, root);
          const active = [previous.pid, ...(previous.children ?? [])].find(alive);
          if (active) {
            throw new Error(`Another browser suite is running in this checkout (PID ${active}). Wait for it to finish; a different PW_PORT does not permit overlapping suites.`);
          }
          // Only a recognized lease whose owner is confirmed dead can be reclaimed.
          unlinkSync(paths.lock);
        }
      } finally {
        closeSync(recoveryFd);
        unlinkSync(recovery);
      }
    }
  }
  if (!created) throw new Error('Could not acquire the browser-test lease. Try again after the other runner exits.');
  const previousEnvironment = process.env[leaseEnvironment];
  process.env[leaseEnvironment] = lease.id;
  let released = false;
  const release = () => {
    if (released) return;
    released = true;
    if (existsSync(paths.lock)) {
      const current = readLease(paths.lock, root);
      if (current.id === lease.id && !(current.children ?? []).some(alive)) unlinkSync(paths.lock);
    }
    ownedLeases.delete(paths.lock);
    if (previousEnvironment === undefined) delete process.env[leaseEnvironment];
    else process.env[leaseEnvironment] = previousEnvironment;
  };
  ownedLeases.set(paths.lock, release);
  if (installExitHandler) process.once('exit', release);
  return release;
}

function inputFiles(root) {
  const files = [];
  const visit = path => {
    if (!existsSync(path)) return;
    const stat = lstatSync(path);
    if (stat.isSymbolicLink()) throw new Error(`Linked production build input requires explicit configuration: ${path}`);
    if (!stat.isDirectory()) { files.push(path); return; }
    for (const name of readdirSync(path).sort()) {
      if (['node_modules', '.git', '.expo', 'dist', 'build'].includes(name)) continue;
      visit(join(path, name));
    }
  };
  for (const name of ['src', 'public', 'mobile', 'index.html', 'agents-dock.html', 'package.json', 'package-lock.json', 'vite.config.ts', 'scripts/playwright-artifacts.mjs']) visit(join(root, name));
  for (const name of readdirSync(root).sort()) {
    if (/^tsconfig.*\.json$/.test(name) || /^\.env(?:\.|$)/.test(name)) visit(join(root, name));
  }
  return files.sort();
}

export function productionFingerprint(root = process.cwd(), environment = process.env) {
  const hash = createHash('sha256');
  // Vite fills in NODE_ENV during build; normalize its production default before hashing.
  const buildEnvironment = { ...environment, NODE_ENV: environment.NODE_ENV ?? 'production' };
  hash.update(JSON.stringify({ node: process.version, env: Object.fromEntries(Object.entries(buildEnvironment).filter(([name]) => /^(?:VITE_|TAURI_|NODE_ENV$)/.test(name)).sort()) }));
  for (const path of inputFiles(root)) {
    hash.update(relative(root, path).replaceAll('\\', '/'));
    hash.update('\0');
    hash.update(readFileSync(path));
    hash.update('\0');
  }
  return hash.digest('hex');
}

function outputFiles(directory, prefix = '') {
  const files = [];
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error('A production test build must not contain linked output.');
    if (entry.isDirectory()) files.push(...outputFiles(join(directory, entry.name), name));
    else if (entry.isFile()) files.push(name);
  }
  return files.sort();
}

export async function ensureProductionBuild({ root = process.cwd(), build, environment = process.env } = {}) {
  const paths = artifactPaths(root);
  const fingerprint = productionFingerprint(root, environment);
  let previous;
  try { previous = JSON.parse(readFileSync(paths.manifest, 'utf8')); } catch { /* No reusable build. */ }
  const entries = ['index.html', 'agents-dock.html'];
  const complete = Array.isArray(previous?.files) && previous.files.length > 0 && previous.files.every(name =>
    typeof name === 'string' && !isAbsolute(name) && !name.split(/[\\/]/).includes('..') && existsSync(join(paths.production, name)));
  if (previous?.schema === 1 && previous.ready === true && previous.fingerprint === fingerprint && complete && entries.every(name => existsSync(join(paths.production, name)))) {
    return { reused: true, fingerprint, directory: paths.production };
  }
  mkdirSync(paths.cache, { recursive: true });
  // Invalidate BEFORE replacing generated output, including when a build is interrupted.
  writeFileSync(paths.manifest, JSON.stringify({ schema: 1, ready: false, fingerprint }));
  await build(paths.production);
  if (!entries.every(name => existsSync(join(paths.production, name)))) throw new Error('The production build did not emit both application entry points.');
  if (productionFingerprint(root, environment) !== fingerprint) throw new Error('Build inputs changed during compilation; no reusable build was recorded.');
  writeFileSync(paths.manifest, JSON.stringify({ schema: 1, ready: true, fingerprint, files: outputFiles(paths.production) }));
  return { reused: false, fingerprint, directory: paths.production };
}

async function previewProduction() {
  const root = process.cwd();
  const port = Number(process.argv[3]);
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('Expected --preview <port>.');
  const release = acquireBrowserRun({ root, allowInherited: true });
  const { build, preview } = await import('vite');
  const result = await ensureProductionBuild({ root, build: outDir => build({ build: { outDir, emptyOutDir: true } }) });
  console.log(`[browser-tests] ${result.reused ? 'Reusing' : 'Built'} production ${result.fingerprint.slice(0, 12)}`);
  const server = await preview({ build: { outDir: result.directory }, preview: { port, strictPort: true, host: '127.0.0.1' } });
  const stop = () => server.httpServer.close(() => { release(); process.exit(0); });
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
  server.printUrls();
}

if (process.argv[1] && pathToFileURL(resolve(process.argv[1])).href === import.meta.url) {
  if (process.argv[2] !== '--preview') throw new Error('Expected --preview <port>.');
  previewProduction().catch(error => { console.error(error); process.exitCode = 1; });
}
