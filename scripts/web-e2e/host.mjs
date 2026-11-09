// Launches an isolated native PandaCode with the web gateway for end-to-end tests.
//
// - Debug build only: `npm run web-e2e:build` compiles the app with its own bundle identifier
//   (`ai.pandacode.webe2e`), so its database, caches and native WebView storage never touch a
//   real install (`ai.pandacode.desktop`).
// - A fresh temp workspace holds a git repo with a local bare remote; the gateway's only file
//   root is that workspace.
// - The debug-only `PANDACODE_WEB_E2E_PAIRING_FILE` hook hands the harness a one-time code.
import { spawn, execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, symlinkSync } from 'node:fs';
import { homedir, tmpdir, platform } from 'node:os';
import { join, resolve } from 'node:path';

export const IDENTIFIER = 'ai.pandacode.webe2e';
const repoRoot = resolve(new URL('../..', import.meta.url).pathname);

export function binaryPath() {
  if (process.env.PANDACODE_WEB_E2E_BINARY) return process.env.PANDACODE_WEB_E2E_BINARY;
  const name = platform() === 'win32' ? 'pandacode.exe' : 'pandacode';
  return join(repoRoot, 'src-tauri', 'target-webe2e', 'debug', name);
}

/** Per-identifier data dirs. Each must end with the harness identifier before it is removed. */
function dataDirs() {
  const home = homedir();
  if (platform() === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', IDENTIFIER),
      join(home, 'Library', 'Caches', IDENTIFIER),
      join(home, 'Library', 'WebKit', IDENTIFIER),
    ];
  }
  if (platform() === 'linux') {
    return [join(home, '.local', 'share', IDENTIFIER), join(home, '.cache', IDENTIFIER), join(home, '.config', IDENTIFIER)];
  }
  return [];
}

function resetData() {
  for (const dir of dataDirs()) {
    if (!dir.endsWith(`/${IDENTIFIER}`)) throw new Error(`refusing to remove ${dir}`);
    rmSync(dir, { recursive: true, force: true });
  }
}

function git(cwd, ...args) {
  return execFileSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_AUTHOR_NAME: 'E2E', GIT_AUTHOR_EMAIL: 'e2e@example.invalid', GIT_COMMITTER_NAME: 'E2E', GIT_COMMITTER_EMAIL: 'e2e@example.invalid' } });
}

/** A workspace with: repo/ (git, remote = ../remote.git), outside/ (must stay unreachable). */
export function makeWorkspace() {
  const base = mkdtempSync(join(tmpdir(), 'pandacode-web-e2e-'));
  const workspace = join(base, 'workspace');
  const repo = join(workspace, 'repo');
  const outside = join(base, 'outside');
  mkdirSync(join(repo, 'src'), { recursive: true });
  mkdirSync(join(workspace, 'dir with spaces ü'), { recursive: true });
  mkdirSync(outside);
  writeFileSync(join(outside, 'secret.txt'), 'outside-the-root\n');
  writeFileSync(join(repo, 'README.md'), '# E2E repo\n\nneedle-alpha\n');
  writeFileSync(join(repo, 'src', 'main.ts'), 'export const answer = 42; // needle-beta\n');
  writeFileSync(join(repo, '.hidden'), 'dotfile\n');
  writeFileSync(join(repo, 'pixel.png'), Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64'));
  writeFileSync(join(workspace, 'dir with spaces ü', 'naïve file.txt'), 'unicode ok\n');
  symlinkSync(join(outside, 'secret.txt'), join(repo, 'escape.txt'));
  writeFileSync(join(repo, '.gitignore'), 'escape.txt\n');
  git(base, 'init', '-q', '--bare', '-b', 'main', 'remote.git');
  git(repo, 'init', '-q', '-b', 'main');
  git(repo, 'add', '.');
  git(repo, 'commit', '-q', '-m', 'initial');
  git(repo, 'remote', 'add', 'origin', join(base, 'remote.git'));
  git(repo, 'push', '-q', '-u', 'origin', 'main');
  return { base, workspace, repo, outside };
}

async function waitReady(origin, child, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`native app exited early (${child.exitCode})`);
    try {
      const response = await fetch(`${origin}/api/pandacode/health`);
      if (response.ok && (await response.json()).ready) return;
    } catch {}
    await new Promise(r => setTimeout(r, 250));
  }
  throw new Error('native gateway did not become ready');
}

/**
 * Starts the app. Returns { origin, code, workspace, stop, restart }.
 * `restart()` keeps data and workspace (for durability tests) and returns a new code.
 */
export async function startHost({ port = Number(process.env.PANDACODE_WEB_E2E_PORT ?? 6091), keepData = false, workspace } = {}) {
  const binary = binaryPath();
  if (!existsSync(binary)) throw new Error(`missing ${binary}; run npm run web-e2e:build`);
  if (!keepData) resetData();
  const ws = workspace ?? makeWorkspace();
  const origin = `http://127.0.0.1:${port}`;
  const pairingFile = join(ws.base, `pairing-${Date.now()}`);
  const log = join(ws.base, 'native.log');
  const child = spawn(binary, ['--web-gateway', `--web-gateway-port=${port}`, `--web-gateway-origin=${origin}`, `--web-root=E2E=${ws.workspace}`], {
    env: { ...process.env, PANDACODE_WEB_E2E_PAIRING_FILE: pairingFile },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const chunks = [];
  child.stdout.on('data', d => chunks.push(d));
  child.stderr.on('data', d => chunks.push(d));
  child.on('exit', () => { try { writeFileSync(log, Buffer.concat(chunks)); } catch {} });
  await waitReady(origin, child, 60_000);
  const code = readFileSync(pairingFile, 'utf8');
  rmSync(pairingFile, { force: true });
  const stop = () => new Promise(done => {
    if (child.exitCode !== null) return done();
    child.once('exit', () => done());
    child.kill('SIGTERM');
    setTimeout(() => child.kill('SIGKILL'), 5000);
  });
  return { origin, code, workspace: ws, pid: child.pid, stop, log,
    restart: async () => { await stop(); return startHost({ port, keepData: true, workspace: ws }); } };
}
