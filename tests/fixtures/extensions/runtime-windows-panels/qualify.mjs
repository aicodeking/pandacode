// R0306: the installed Windows qualification of rich panels, in one command.
//
//   node tests/fixtures/extensions/runtime-windows-panels/qualify.mjs --build            (build, install, run)
//   node tests/fixtures/extensions/runtime-windows-panels/qualify.mjs --installer <setup.exe>
//
// It builds the exact tree (optional), installs that build silently into a test-owned folder, starts B1, launches
// the installed app with its WebView2 debugging port, runs `scenarios.mjs`, and writes three files to `--out`
// (default `test-results/runtime-windows-panels/`): `observation.json` (what was seen), `result.json` (the
// comparison with `expected.json`) and `platform-rich-panel.json` (the `rich-panel` entry of the windows-x64
// platform record). It never touches a developer profile: it runs only under a dedicated Windows account or a
// Windows Sandbox (`PANDACODE_QUALIFICATION_PROFILE=dedicated`) and refuses when PandaCode data or a running
// PandaCode is found that this runner did not create.
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { basename, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import os from 'node:os';
import { stagePackages, ROOT } from './stage.mjs';
import { evaluate, platformScenario, OBSERVATION_KIND, TARGET } from './evaluate.mjs';

const REPO = resolve(ROOT, '../../../..');
const IDENTIFIER = 'ai.pandacode.desktop';
const MARKER = '.pandacode-windows-panels-qualification';
const RELEASE_TARGET = 'windows-x86_64';
// wry's own defaults on Windows, kept so the only difference from a normal launch is the debugging port.
const WRY_DEFAULTS = '--disable-features=msWebOOUI,msPdfOOUI,msSmartScreenProtection';
const sha256 = bytes => createHash('sha256').update(bytes).digest('hex');
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));

export function parseArguments(argv) {
  const options = { build: false, installer: null, out: join(REPO, 'test-results/runtime-windows-panels'), keepInstall: false, port: 0 };
  for (let index = 0; index < argv.length; index++) {
    const name = argv[index];
    const value = () => { const next = argv[++index]; if (!next || next.startsWith('--')) throw new Error(`${name} takes a value.`); return next; };
    if (name === '--build') options.build = true;
    else if (name === '--keep-install') options.keepInstall = true;
    else if (name === '--installer') options.installer = resolve(value());
    else if (name === '--out') options.out = resolve(value());
    else if (name === '--port') options.port = Number(value());
    else throw new Error(`Unknown argument ${name}. Use --build, --installer <setup.exe>, --out <folder>, --keep-install or --port <n>.`);
  }
  if (!options.build && !options.installer) throw new Error('Give --build (build this tree first) or --installer <setup.exe> (a build made by --build).');
  if (options.port && (!Number.isInteger(options.port) || options.port < 1024 || options.port > 65535)) throw new Error('--port takes 1024 to 65535.');
  return options;
}

function git(args) {
  const result = spawnSync('git', args, { cwd: REPO, encoding: 'utf8', shell: false, windowsHide: true, maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0) throw new Error(`git ${args[0]} failed: ${result.stderr.trim()}`);
  return result.stdout;
}

/** The source fingerprint: HEAD, plus every changed or untracked file's path and bytes (read-only git). */
export function sourceFingerprint() {
  const head = git(['rev-parse', 'HEAD']).trim();
  const status = git(['status', '--porcelain=v1', '-z', '--untracked-files=all']);
  const hash = createHash('sha256').update(`head:${head}\0`);
  const changed = status.split('\0').filter(Boolean).map(line => line.slice(3)).sort();
  for (const path of changed) {
    const absolute = join(REPO, path);
    hash.update(`${path}\0`);
    hash.update(existsSync(absolute) && statSync(absolute).isFile() ? readFileSync(absolute) : Buffer.from('deleted'));
    hash.update('\0');
  }
  return { head, fingerprint: hash.digest('hex'), clean: changed.length === 0, changed: changed.length };
}

/** Refuses anything but a dedicated Windows x64 profile with no PandaCode of the user's in it. */
function preflight() {
  if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('The installed rich-panel qualification runs on Windows x64 only; no other platform is inferred from it.');
  if (process.env.PANDACODE_QUALIFICATION_PROFILE !== 'dedicated') throw new Error('Run under a dedicated Windows account or a Windows Sandbox and set PANDACODE_QUALIFICATION_PROFILE=dedicated. The installer writes per-user registry entries and the app uses the profile\'s PandaCode data folders.');
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) {
    const folder = join(base, IDENTIFIER);
    if (existsSync(folder) && !existsSync(join(folder, MARKER))) throw new Error(`${folder} holds PandaCode data this runner did not create. Use a dedicated profile.`);
  }
  const running = spawnSync('tasklist', ['/FO', 'CSV', '/NH'], { encoding: 'utf8', windowsHide: true }).stdout ?? '';
  if (/"pandacode\.exe"/i.test(running)) throw new Error('A PandaCode process is running; its single-instance handoff would take the launch. Quit it first.');
}

function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: REPO, shell: false, windowsHide: true, stdio: 'inherit', ...options });
    child.once('error', reject);
    child.once('exit', code => (code === 0 ? resolve() : reject(new Error(`${basename(command)} exited with ${code}.`))));
  });
}

async function build(out) {
  const before = sourceFingerprint();
  await run(process.execPath, [join(REPO, 'scripts/release/build.mjs'), RELEASE_TARGET]);
  const after = sourceFingerprint();
  if (after.fingerprint !== before.fingerprint) throw new Error('The tree changed during the build; no build identity was recorded.');
  const { version } = JSON.parse(readFileSync(join(REPO, 'src-tauri/tauri.conf.json'), 'utf8'));
  const directory = join(REPO, 'src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis');
  const installer = join(directory, `PandaCode_${version}_x64-setup.exe`);
  const identity = { schemaVersion: 1, kind: 'runtime-windows-panels-build', candidateCommit: before.head, sourceFingerprint: before.fingerprint, treeClean: before.clean, version, installer: relative(REPO, installer), installerSha256: sha256(readFileSync(installer)) };
  writeFileSync(`${installer}.identity.json`, `${JSON.stringify(identity, null, 2)}\n`);
  mkdirSync(out, { recursive: true });
  return installer;
}

function readIdentity(installer, now) {
  const path = `${installer}.identity.json`;
  const bytes = readFileSync(installer);
  const recorded = existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : null;
  const installerSha256 = sha256(bytes);
  return {
    candidateCommit: recorded?.candidateCommit ?? null,
    sourceFingerprint: now.fingerprint,
    builtFingerprint: recorded?.sourceFingerprint ?? null,
    buildMatchesSource: !!recorded && recorded.sourceFingerprint === now.fingerprint && recorded.candidateCommit === now.head && recorded.installerSha256 === installerSha256,
    treeClean: now.clean,
    installer: { name: basename(installer), sha256: installerSha256, bytes: bytes.length },
  };
}

async function freePort() {
  return new Promise((resolve, reject) => { const server = createServer(); server.once('error', reject); server.listen(0, '127.0.0.1', () => { const { port } = server.address(); server.close(() => resolve(port)); }); });
}

/** B1 with the run's seed: argument array, piped stdin kept open, ready line on stdout. */
function startDaemon() {
  const child = spawn(process.execPath, [join(ROOT, '../backends/fake-daemon/fake-daemon.mjs'), '--seed', join(ROOT, 'seed.json')], { shell: false, windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  return new Promise((resolve, reject) => {
    let buffer = '';
    const timer = setTimeout(() => reject(new Error('B1 did not report ready.')), 10_000);
    child.once('error', reject);
    child.stdout.on('data', chunk => {
      buffer += chunk;
      const line = buffer.split('\n')[0];
      if (!buffer.includes('\n')) return;
      clearTimeout(timer);
      const ready = JSON.parse(line);
      resolve({ child, socket: ready.socket, control: ready.control, stop: () => new Promise(done => { child.once('close', done); child.stdin.end(); }) });
    });
  });
}

function installedExecutable(directory) {
  const names = readdirSync(directory).filter(name => /\.exe$/i.test(name) && !/^uninstall/i.test(name));
  const main = names.find(name => /^pandacode\.exe$/i.test(name));
  if (!main) throw new Error(`No PandaCode executable in ${directory} (${names.join(', ')}).`);
  return join(directory, main);
}

function killInstalled(directory) {
  // Only processes started from this runner's own install folder.
  const script = `Get-CimInstance Win32_Process | Where-Object { $_.ExecutablePath -and $_.ExecutablePath.StartsWith('${directory.replaceAll("'", "''")}', [System.StringComparison]::OrdinalIgnoreCase) } | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`;
  spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { windowsHide: true, stdio: 'ignore' });
}

async function connect(chromium, port, timeout = 90_000) {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
      const context = browser.contexts()[0];
      const main = await (async () => { for (;;) { const page = context.pages().find(candidate => /^http:\/\/tauri\.localhost\//.test(candidate.url())); if (page) return page; if (Date.now() > end) throw new Error('No main webview.'); await delay(500); } })();
      await main.locator('#prompt').waitFor({ state: 'visible', timeout: 60_000 });
      return { browser, context, main };
    } catch (error) {
      if (Date.now() > end) throw new Error(`Could not reach the installed app's WebView2 debugging port ${port}: ${error.message}`);
      await delay(1_000);
    }
  }
}

export async function main(argv = process.argv.slice(2)) {
  const options = parseArguments(argv);
  preflight();
  mkdirSync(options.out, { recursive: true });
  const installer = options.build ? await build(options.out) : options.installer;
  const now = sourceFingerprint();
  const identity = readIdentity(installer, now);
  const work = join(options.out, 'run');
  rmSync(work, { recursive: true, force: true });
  const paths = { install: join(work, 'install'), project: join(work, 'project'), serviceLog: join(work, 'service.json'), agentLog: join(work, 'agent-frames.jsonl'), packages: join(work, 'packages') };
  for (const directory of [paths.project, paths.packages]) mkdirSync(directory, { recursive: true });
  writeFileSync(join(paths.project, 'README.md'), '# Windows panels qualification project\n');

  // Install the build: NSIS, per user, silent, into the test-owned folder (/D last and unquoted).
  await run(installer, ['/S', `/D=${paths.install}`], { stdio: 'ignore', cwd: work });
  const exe = installedExecutable(paths.install);
  for (const base of [process.env.APPDATA, process.env.LOCALAPPDATA].filter(Boolean)) { mkdirSync(join(base, IDENTIFIER), { recursive: true }); writeFileSync(join(base, IDENTIFIER, MARKER), 'created by the R0306 qualification runner\n'); }
  const runtimeManifest = join(paths.install, 'extension-runtime/manifest.json');
  identity.app = { exe: basename(exe), sha256: sha256(readFileSync(exe)), bytes: statSync(exe).size, version: JSON.parse(readFileSync(join(REPO, 'src-tauri/tauri.conf.json'), 'utf8')).version };
  identity.installedBy = 'nsis-silent';

  const daemon = await startDaemon();
  const staged = stagePackages({ b1: daemon.socket, serviceLog: paths.serviceLog, fakeAgent: join(ROOT, '../backends/fake-agent.mjs'), agentLog: paths.agentLog });
  const packages = staged.map(item => { const archive = join(paths.packages, `${item.id}.zip`); writeFileSync(archive, item.bytes); return { id: item.id, grants: item.grants, archive }; });

  const port = options.port || await freePort();
  const additionalBrowserArguments = `${WRY_DEFAULTS} --remote-debugging-port=${port}`;
  const env = { ...process.env, WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS: additionalBrowserArguments };
  const launch = () => { const child = spawn(exe, [], { cwd: paths.install, env, shell: false, windowsHide: false, stdio: 'ignore', detached: false }); child.on('error', () => {}); return child; };
  const { chromium } = await import('@playwright/test');
  let app = launch();
  let link = await connect(chromium, port);
  const record = {
    schemaVersion: 1, kind: OBSERVATION_KIND, target: TARGET, evidence: 'installed', startedAt: new Date().toISOString(), identity,
    engines: {
      webview2: link.browser.version(), userAgent: await link.main.evaluate(() => navigator.userAgent),
      node: existsSync(runtimeManifest) ? JSON.parse(readFileSync(runtimeManifest, 'utf8')).nodeVersion ?? null : null,
      os: { platform: process.platform, arch: process.arch, release: os.release(), version: os.version() },
      runner: { node: process.version, playwright: JSON.parse(readFileSync(join(REPO, 'node_modules/@playwright/test/package.json'), 'utf8')).version },
    },
    instrumentation: { additionalBrowserArguments, remotePage: 'https://charts.windows-panels.test answered from remote/chart.html by a debugging-connection request route (no network)', keys: 'CDP Input.dispatchKeyEvent to the panel renderer, not the OS input queue' },
  };
  const session = {
    packages, paths,
    context: () => link.context,
    main: () => link.main,
    readService: () => { try { return JSON.parse(readFileSync(paths.serviceLog, 'utf8')); } catch { return null; } },
    readAgentLog: () => { try { return readFileSync(paths.agentLog, 'utf8').split('\n').filter(Boolean).map(line => { try { return JSON.parse(line); } catch { return {}; } }); } catch { return []; } },
    restart: async () => {
      // The app's own restart (`process:allow-restart` on the main window): a clean shutdown and a relaunch with the
      // same environment, so the debugging port comes back.
      void link.main.evaluate(() => window.__TAURI_INTERNALS__.invoke('plugin:process|restart')).catch(() => {});
      await new Promise(done => { if (app.exitCode !== null) done(); else app.once('exit', done); setTimeout(done, 30_000); });
      await link.browser.close().catch(() => {});
      await delay(2_000);
      link = await connect(chromium, port);
    },
  };
  try {
    const { runScenarios } = await import(pathToFileURL(join(ROOT, 'scenarios.mjs')).href);
    Object.assign(record, await runScenarios(session));
  } catch (error) {
    record.error = String(error?.stack ?? error).slice(0, 4000);
  } finally {
    record.finishedAt = new Date().toISOString();
    await link.browser.close().catch(() => {});
    killInstalled(paths.install);
    await daemon.stop().catch(() => {});
    if (!options.keepInstall && existsSync(join(paths.install, 'uninstall.exe'))) await run(join(paths.install, 'uninstall.exe'), ['/S'], { stdio: 'ignore', cwd: work }).catch(() => {});
  }
  const expected = JSON.parse(readFileSync(join(ROOT, 'expected.json'), 'utf8'));
  const result = evaluate(record, expected);
  writeFileSync(join(options.out, 'observation.json'), `${JSON.stringify(record, null, 2)}\n`);
  writeFileSync(join(options.out, 'result.json'), `${JSON.stringify(result, null, 2)}\n`);
  writeFileSync(join(options.out, 'platform-rich-panel.json'), `${JSON.stringify(platformScenario(result), null, 2)}\n`);
  console.log(JSON.stringify({ verdict: result.verdict, reason: result.reason, criteria: result.criteria, out: options.out }));
  return result.verdict === 'passed' ? 0 : 1;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error.message); process.exitCode = 2; });
}
