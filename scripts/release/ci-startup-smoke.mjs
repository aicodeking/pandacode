// CI startup check only: survival is not proof of rendering or feature behavior.
// Never launch a developer's installed app or run against a self-hosted runner.
import { spawn } from 'node:child_process';
import { mkdir, mkdtemp, readdir, rmdir, chmod, readFile, stat } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { root, targetConfig } from './common.mjs';

export function assertHostedRunner(env, target, platform = process.platform) {
  if (env.GITHUB_ACTIONS !== 'true' || env.RUNNER_ENVIRONMENT !== 'github-hosted' || !env.RUNNER_TEMP || !isAbsolute(env.RUNNER_TEMP)) {
    throw new Error('Startup smoke is restricted to disposable GitHub-hosted runners.');
  }
  if (!['windows-x86_64', 'windows-aarch64', 'linux-x86_64', 'linux-aarch64'].includes(target) || targetConfig(target).platform !== platform) {
    throw new Error('Startup smoke requires the matching Windows or Linux host.');
  }
}

export function selectPackage(names, version, target) {
  const expected = targetConfig(target).built(version);
  if (names.length > 100 || names.filter(name => name === expected).length !== 1) {
    throw new Error(`Expected exactly one built package: ${expected}`);
  }
  return expected;
}

/** Where Tauri leaves the target's installer, from the same config the build uses. */
export function bundleDirectory(target, base = root) {
  const config = targetConfig(target);
  return join(base, 'src-tauri/target', config.triple, 'release/bundle', config.bundleDir);
}

export function smokeEnvironment(env, directory) {
  const clean = { ...env };
  for (const key of Object.keys(clean)) {
    if (/^(APPLE_|TAURI_SIGNING_)/.test(key) || /(_TOKEN|_SECRET|_PASSWORD|_API_KEY)$/.test(key)) delete clean[key];
  }
  return { ...clean, HOME: join(directory, 'home'), USERPROFILE: join(directory, 'home'), APPDATA: join(directory, 'roaming'), LOCALAPPDATA: join(directory, 'local'), XDG_CONFIG_HOME: join(directory, 'config'), XDG_DATA_HOME: join(directory, 'data'), XDG_CACHE_HOME: join(directory, 'cache'), XDG_RUNTIME_DIR: join(directory, 'runtime'), GDK_BACKEND: 'x11', APPIMAGE_EXTRACT_AND_RUN: '1' };
}

export function installArguments(directory) {
  if (/["\r\n\0]/.test(directory)) throw new Error('Invalid temporary install path.');
  // NSIS requires /D last and unquoted, including paths with spaces. This goes
  // directly to CreateProcess, never cmd.exe or PowerShell.
  return ['/S', `/D=${directory}`];
}

export function linuxStartupCommand(installer) {
  // The bus and every activated portal must inherit Xvfb's DISPLAY.
  return { command: 'xvfb-run', args: ['--auto-servernum', '--server-args=-screen 0 1440x940x24', 'dbus-run-session', '--', installer] };
}

export function validatePackageSize(size) {
  if (!Number.isSafeInteger(size) || size < 1 || size > 200 * 1024 * 1024) throw new Error('The packaged installer exceeds the release size limit (1 byte–200 MiB).');
}

function removeSmokeFiles(directory) {
  // Run removal outside this process so even blocked filesystem IO cannot keep
  // the startup check alive. Linux runtime mounts are excluded before this call.
  return new Promise((resolve, reject) => {
    const cleaner = spawn(process.execPath, ['-e', 'require("node:fs/promises").rm(process.argv[1], {recursive:true,force:true,maxRetries:2,retryDelay:100}).catch(()=>{process.exitCode=1})', directory], { shell: false, windowsHide: true, stdio: 'ignore' });
    const timer = setTimeout(() => { cleaner.kill('SIGKILL'); cleaner.unref(); reject(new Error('cleanup timeout')); }, 3000);
    cleaner.once('error', error => { clearTimeout(timer); reject(error); });
    cleaner.once('exit', code => { clearTimeout(timer); code === 0 ? resolve() : reject(new Error('temporary files are still busy')); });
  });
}

export async function cleanupSmokeDirectory(directory, { runnerTemp = process.env.RUNNER_TEMP, platform = process.platform, removeRuntime = rmdir, removeDirectory = removeSmokeFiles, warn = console.warn } = {}) {
  // Only a direct mkdtemp child owned by this check may be removed.
  if (!runnerTemp || dirname(resolve(directory)) !== resolve(runnerTemp) || !basename(directory).startsWith('pandacode-startup-')) {
    warn('Startup cleanup skipped a directory outside the owned CI temporary path.');
    return;
  }
  try {
    if (platform === 'linux') {
      try {
        // Never descend into XDG_RUNTIME_DIR: document portals can leave FUSE
        // mounts here after an app crash. Nonrecursive rmdir fails immediately.
        await removeRuntime(join(directory, 'runtime'));
      } catch (error) {
        if (error.code !== 'ENOENT') {
          warn('Startup cleanup left the occupied runtime directory for disposable runner teardown.');
          return;
        }
      }
    }
    await removeDirectory(directory);
  } catch {
    // Cleanup must neither replace an app failure nor turn a passed startup
    // check into an unrelated EBUSY failure. The hosted runner is disposable.
    warn('Startup cleanup could not remove all temporary files; runner teardown will remove them.');
  }
}

const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
async function killTree(child, platform) {
  if (!child.pid) return;
  if (platform === 'win32') {
    // The owned root process remains alive until taskkill resolves its children.
    // Resolve it under System32: PATH need not carry System32 (Git Bash strips it),
    // and a missing taskkill leaves the fixture running for the whole test run.
    const taskkill = join(process.env.SystemRoot || process.env.WINDIR || 'C:\\Windows', 'System32', 'taskkill.exe');
    await new Promise(resolve => {
      const killer = spawn(taskkill, ['/PID', String(child.pid), '/T', '/F'], { shell: false, windowsHide: true, stdio: 'ignore', timeout: 10_000 });
      killer.once('error', resolve); killer.once('close', resolve);
    });
  } else {
    try { process.kill(-child.pid, 'SIGTERM'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
    await delay(250);
    try { process.kill(-child.pid, 'SIGKILL'); } catch (error) { if (error.code !== 'ESRCH') throw error; }
  }
}

export async function observeProcess(command, args, { env, cwd, durationMs, expectExit = false, platform = process.platform, windowsVerbatimArguments = false, stdio = 'inherit' }) {
  const child = spawn(command, args, { env, cwd, shell: false, detached: platform !== 'win32', windowsHide: true, windowsVerbatimArguments, stdio });
  let timer;
  const ended = new Promise(resolve => {
    child.once('error', error => resolve({ error }));
    child.once('exit', (code, signal) => resolve({ code, signal }));
  });
  const interrupted = () => { void killTree(child, platform); };
  process.once('SIGINT', interrupted); process.once('SIGTERM', interrupted);
  try {
    const result = await Promise.race([ended, new Promise(resolve => { timer = setTimeout(() => resolve(null), durationMs); })]);
    if (result?.error) throw result.error;
    if (expectExit) {
      if (!result) throw new Error('Installer did not finish within the startup-smoke timeout.');
      if (result.code !== 0) throw new Error(`Installer failed (${result.code ?? result.signal}).`);
    } else if (result) {
      throw new Error(`App exited during the startup check (${result.code ?? result.signal}).`);
    }
  } finally {
    clearTimeout(timer);
    // Completed installers need no termination; startup processes are always stopped.
    if (!expectExit || child.exitCode === null) await killTree(child, platform);
    process.removeListener('SIGINT', interrupted); process.removeListener('SIGTERM', interrupted);
  }
}

async function main() {
  const target = process.env.RELEASE_TARGET;
  assertHostedRunner(process.env, target);
  const config = targetConfig(target);
  const { version } = JSON.parse(await readFile(join(root, 'src-tauri/tauri.conf.json'), 'utf8'));
  const bundle = bundleDirectory(target);
  const installer = join(bundle, selectPackage(await readdir(bundle), version, target));
  const size = (await stat(installer)).size;
  console.log(`Packaged installer: ${size} bytes (${(size / 1024 / 1024).toFixed(1)} MiB; release limit 200 MiB).`);
  validatePackageSize(size);
  const directory = await mkdtemp(join(process.env.RUNNER_TEMP, 'pandacode-startup-'));
  const env = smokeEnvironment(process.env, directory);
  try {
    for (const name of ['home', 'roaming', 'local', 'config', 'data', 'cache', 'runtime']) await mkdir(join(directory, name), { mode: 0o700 });
    if (target.startsWith('linux-')) {
      await chmod(installer, 0o755);
      const { command, args } = linuxStartupCommand(installer);
      await observeProcess(command, args, { env, cwd: directory, durationMs: 15_000 });
    } else {
      const destination = join(directory, 'installed');
      // WebView2 bootstrap may download its runtime on a clean runner.
      await observeProcess(installer, installArguments(destination), { env, cwd: directory, durationMs: 120_000, expectExit: true, windowsVerbatimArguments: true });
      const names = await readdir(destination);
      const binaries = names.filter(name => name.toLowerCase() === 'pandacode.exe');
      if (names.length > 100 || binaries.length !== 1) throw new Error('NSIS did not install the expected app executable.');
      await observeProcess(join(destination, binaries[0]), [], { env, cwd: directory, durationMs: 30_000 });
    }
    console.log(`${target}: packaged app stayed alive during the startup check (no GUI or agent behavior asserted).`);
  } finally {
    await cleanupSmokeDirectory(directory);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
