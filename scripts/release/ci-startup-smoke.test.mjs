import test from 'node:test';
import assert from 'node:assert/strict';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { mkdir, mkdtemp, readFile, rm, writeFile, access } from 'node:fs/promises';
import { assertHostedRunner, bundleDirectory, selectPackage, smokeEnvironment, installArguments, observeProcess, linuxStartupCommand, cleanupSmokeDirectory, validatePackageSize } from './ci-startup-smoke.mjs';

test('Linux starts Xvfb before the bus so portal services inherit the display', () => {
  assert.deepEqual(linuxStartupCommand('/tmp/build with spaces/PandaCode.AppImage'), { command: 'xvfb-run', args: ['--auto-servernum', '--server-args=-screen 0 1440x940x24', 'dbus-run-session', '--', '/tmp/build with spaces/PandaCode.AppImage'] });
});

test('startup packages obey the same 200 MiB publisher size limit', () => {
  for (const size of [1, 200 * 1024 * 1024]) assert.doesNotThrow(() => validatePackageSize(size));
  for (const size of [0, 200 * 1024 * 1024 + 1, NaN]) assert.throws(() => validatePackageSize(size), /size limit/);
});

test('busy Linux runtime cleanup never descends into a portal mount or masks the app failure', async () => {
  const directory = join(tmpdir(), 'pandacode-startup-fixture');
  const primary = new Error('updater initialization failed');
  let recursiveCalls = 0;
  const warnings = [];
  await assert.rejects(async () => {
    try { throw primary; } finally {
      await cleanupSmokeDirectory(directory, { runnerTemp: tmpdir(), platform: 'linux', removeRuntime: async path => { assert.equal(path, join(directory, 'runtime')); throw Object.assign(new Error('busy mount'), { code: 'EBUSY' }); }, removeDirectory: async () => { recursiveCalls++; }, warn: value => warnings.push(value) });
    }
  }, error => error === primary);
  assert.equal(recursiveCalls, 0);
  assert.equal(warnings.length, 1);
});

test('cleanup removes an owned empty-runtime fixture and rejects unrelated paths', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-startup-'));
  await mkdir(join(directory, 'runtime'));
  await writeFile(join(directory, 'fixture'), 'disposable');
  await cleanupSmokeDirectory(directory, { runnerTemp: tmpdir(), platform: 'linux' });
  await assert.rejects(access(directory), { code: 'ENOENT' });
  let touched = false;
  await cleanupSmokeDirectory(join(tmpdir(), 'another-directory'), { runnerTemp: tmpdir(), removeDirectory: async () => { touched = true; }, warn: () => {} });
  assert.equal(touched, false);
});

test('file-removal errors are warnings even when the original operation succeeded', async () => {
  const warnings = [];
  await cleanupSmokeDirectory(join(tmpdir(), 'pandacode-startup-fixture'), { runnerTemp: tmpdir(), platform: 'win32', removeDirectory: async () => { throw new Error('cleanup timeout'); }, warn: value => warnings.push(value) });
  assert.equal(warnings.length, 1);
});

test('startup smoke refuses local, self-hosted, and mismatched systems', () => {
  const env = { GITHUB_ACTIONS: 'true', RUNNER_ENVIRONMENT: 'github-hosted', RUNNER_TEMP: tmpdir() };
  assert.doesNotThrow(() => assertHostedRunner(env, 'linux-x86_64', 'linux'));
  assert.doesNotThrow(() => assertHostedRunner(env, 'linux-aarch64', 'linux'));
  for (const invalid of [{}, { ...env, RUNNER_ENVIRONMENT: 'self-hosted' }, { ...env, RUNNER_TEMP: 'relative' }]) assert.throws(() => assertHostedRunner(invalid, 'linux-x86_64', 'linux'), /disposable/);
  assert.throws(() => assertHostedRunner(env, 'linux-x86_64', 'win32'), /matching/);
  assert.throws(() => assertHostedRunner(env, 'darwin-aarch64', 'darwin'), /matching/);
});

test('only the exact target/version package is launched', () => {
  assert.equal(selectPackage(['PandaCode_1.2.3_arm64-setup.exe'], '1.2.3', 'windows-aarch64'), 'PandaCode_1.2.3_arm64-setup.exe');
  assert.equal(selectPackage(['PandaCode_1.2.3_x64-setup.exe', 'PandaCode_1.2.3_x64-setup.exe.sig'], '1.2.3', 'windows-x86_64'), 'PandaCode_1.2.3_x64-setup.exe');
  assert.equal(selectPackage(['PandaCode_1.2.3_amd64.AppImage'], '1.2.3', 'linux-x86_64'), 'PandaCode_1.2.3_amd64.AppImage');
  assert.equal(selectPackage(['PandaCode_1.2.3_aarch64.AppImage'], '1.2.3', 'linux-aarch64'), 'PandaCode_1.2.3_aarch64.AppImage');
  assert.throws(() => selectPackage(['PandaCode_1.2.2_amd64.AppImage'], '1.2.3', 'linux-x86_64'), /exactly one/);
  assert.throws(() => selectPackage(Array(101).fill('PandaCode_1.2.3_amd64.AppImage'), '1.2.3', 'linux-x86_64'), /exactly one/);
});

test('isolated app data and literal NSIS arguments do not inherit credentials', () => {
  const directory = join(tmpdir(), 'startup with spaces');
  const env = smokeEnvironment({ HOME: '/real-user', APPDATA: '/real-data', PATH: 'path', GITHUB_TOKEN: 'secret', ANTHROPIC_API_KEY: 'secret', TAURI_SIGNING_PRIVATE_KEY: 'secret', RUST_LOG: 'info' }, directory);
  assert.equal(env.HOME, join(directory, 'home'));
  assert.equal(env.APPDATA, join(directory, 'roaming'));
  assert.equal(env.XDG_RUNTIME_DIR, join(directory, 'runtime'));
  assert.equal(env.PATH, 'path'); assert.equal(env.GDK_BACKEND, 'x11');
  assert.equal(env.GITHUB_TOKEN, undefined); assert.equal(env.ANTHROPIC_API_KEY, undefined); assert.equal(env.TAURI_SIGNING_PRIVATE_KEY, undefined);
  assert.equal(env.RUST_LOG, 'info');
  assert.deepEqual(installArguments(directory), ['/S', `/D=${directory}`]);
  assert.throws(() => installArguments('bad"path'), /Invalid/);
});

// Fixtures that exit at once settle the observation as soon as they exit, so a long window costs
// nothing normally but keeps a cold Node start (over 1.5 s on windows-11-arm) inside it.
const EXIT_WINDOW_MS = 10_000;

test('startup observation rejects early clean exits, crashes, and missing executables', async () => {
  const options = { env: process.env, cwd: tmpdir(), durationMs: EXIT_WINDOW_MS, stdio: 'ignore' };
  await assert.rejects(observeProcess(process.execPath, ['-e', 'process.exit(0)'], options), /App exited/);
  await assert.rejects(observeProcess(process.execPath, ['-e', 'process.exit(42)'], options), /42/);
  await assert.rejects(observeProcess(join(tmpdir(), 'nonexistent-pandacode-smoke-executable'), [], options), /ENOENT/);
});

test('startup observation stops a surviving fixture and bounds installer execution', async () => {
  const options = { env: process.env, cwd: tmpdir(), durationMs: 200, stdio: 'ignore' };
  const directory = await mkdtemp(join(tmpdir(), 'pandacode-smoke-test-'));
  try {
    const pidFile = join(directory, 'pid');
    await observeProcess(process.execPath, ['-e', 'require("node:fs").writeFileSync(process.argv[1], String(process.pid)); setInterval(() => {}, 1000)', pidFile], { ...options, durationMs: 1000 });
    const pid = Number(await readFile(pidFile, 'utf8'));
    assert.throws(() => process.kill(pid, 0), { code: 'ESRCH' }, 'the observed process must be gone before returning');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
  await observeProcess(process.execPath, ['-e', 'process.exit(0)'], { ...options, durationMs: EXIT_WINDOW_MS, expectExit: true });
  await assert.rejects(observeProcess(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { ...options, expectExit: true }), /timeout/);
});

test('the startup check looks for the installer where the build leaves it', () => {
  assert.equal(bundleDirectory('windows-x86_64', '/repo'), join('/repo', 'src-tauri/target', 'x86_64-pc-windows-msvc', 'release/bundle', 'nsis'));
  assert.equal(bundleDirectory('linux-x86_64', '/repo'), join('/repo', 'src-tauri/target', 'x86_64-unknown-linux-gnu', 'release/bundle', 'appimage'));
});
