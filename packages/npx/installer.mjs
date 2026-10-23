// Downloads the latest PandaCode release, verifies its Tauri updater (minisign)
// signature with node:crypto, and installs it. Zero dependencies.
import { createHash, createPublicKey, verify } from 'node:crypto';
import { spawnSync, spawn } from 'node:child_process';
import { accessSync, constants, copyFileSync, chmodSync, existsSync, mkdirSync, mkdtempSync, readdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

// plugins.updater.pubkey from src-tauri/tauri.conf.json (a test keeps them equal).
export const PUBKEY = 'dW50cnVzdGVkIGNvbW1lbnQ6IG1pbmlzaWduIHB1YmxpYyBrZXk6IDM3OEQ0RkYwQ0I4QzRGODEKUldTQlQ0ekw4RStOTnhNYW9jL1pTZENocVU3TGNPeVVxcDdzdkN4d0s3R2lPekxGRitGLzVwM3oK';
export const BASE = 'https://github.com/aicodeking/pandacode/releases/latest/download';
export const ASSETS = {
  'darwin-arm64': 'PandaCode-macOS-arm64.app.tar.gz',
  'darwin-x64': 'PandaCode-macOS-x64.app.tar.gz',
  'win32-x64': 'PandaCode-Windows-x64-setup.exe',
  'win32-arm64': 'PandaCode-Windows-arm64-setup.exe',
  'linux-x64': 'PandaCode-Linux-x86_64.AppImage',
  'linux-arm64': 'PandaCode-Linux-aarch64.AppImage',
};

/** How each published build is named for people. */
const PLATFORMS = {
  'darwin-arm64': 'macOS Apple silicon',
  'darwin-x64': 'macOS Intel',
  'win32-x64': 'Windows x64',
  'win32-arm64': 'Windows arm64',
  'linux-x64': 'Linux x64',
  'linux-arm64': 'Linux arm64',
};

/** Every build a release publishes, named for people. */
export function supportedPlatforms() {
  return Object.keys(ASSETS).map(key => PLATFORMS[key]);
}

export function assetFor(platform = process.platform, arch = process.arch) {
  const asset = ASSETS[`${platform}-${arch}`];
  if (!asset) throw new Error(`PandaCode has no build for ${platform}-${arch}. Supported: ${supportedPlatforms().join(', ')}.`);
  return asset;
}

const b64 = text => Buffer.from(text.trim(), 'base64');
const lines = buffer => buffer.toString('utf8').split('\n');
const SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const key = pk => createPublicKey({ key: Buffer.concat([SPKI_PREFIX, pk]), format: 'der', type: 'spki' });

/** Verify `data` against a Tauri `.sig` file (base64 of minisign text). Throws on any mismatch. */
export function verifyMinisign(data, sigFile, pubkey = PUBKEY) {
  const pub = b64(lines(b64(pubkey))[1]);
  const sigLines = lines(b64(sigFile));
  const sig = b64(sigLines[1]);
  if (pub.length !== 42 || pub.subarray(0, 2).toString() !== 'Ed') throw new Error('Bad public key.');
  if (sig.length !== 74) throw new Error('Bad signature.');
  const alg = sig.subarray(0, 2).toString();
  if (alg !== 'ED' && alg !== 'Ed') throw new Error('Unknown signature algorithm.');
  if (!pub.subarray(2, 10).equals(sig.subarray(2, 10))) throw new Error('Signature was made with a different key.');
  const pk = key(pub.subarray(10));
  const message = alg === 'ED' ? createHash('blake2b512').update(data).digest() : data;
  const raw = sig.subarray(10);
  if (!verify(null, message, pk, raw)) throw new Error('Signature does not match the download.');
  const prefix = 'trusted comment: ';
  if (!sigLines[2]?.startsWith(prefix)) throw new Error('Signature has no trusted comment.');
  const comment = Buffer.from(sigLines[2].slice(prefix.length));
  if (!verify(null, Buffer.concat([raw, comment]), pk, b64(sigLines[3] ?? ''))) throw new Error('Signature comment does not match.');
}

export function desktopEntry(exec, icon) {
  return `[Desktop Entry]\nType=Application\nName=PandaCode\nComment=Desktop app for coding agents\nExec=${exec}\nIcon=${icon}\nTerminal=false\nCategories=Development;\nStartupWMClass=PandaCode\n`;
}

async function download(url, file) {
  const response = await fetch(url, { redirect: 'follow' });
  if (!response.ok) throw new Error(`Download failed (${response.status}) for ${url}`);
  const total = Number(response.headers.get('content-length')) || 0;
  const chunks = [];
  let got = 0;
  let shown = 0;
  for await (const chunk of response.body) {
    chunks.push(chunk);
    got += chunk.length;
    if (got - shown < 1e6 && got < total) continue;
    shown = got;
    const mb = (got / 1e6).toFixed(1);
    process.stderr.write(`\rDownloading ${file}: ${mb} MB${total ? ` (${Math.floor(got / total * 100)}%)` : ''}`);
  }
  process.stderr.write('\n');
  return Buffer.concat(chunks);
}

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: 'utf8', ...options });
  if (result.error) throw result.error;
  return result;
}

function installMac(archive, dir) {
  const extracted = join(dir, 'extracted');
  mkdirSync(extracted);
  const tar = run('tar', ['-xzf', archive, '-C', extracted]);
  if (tar.status !== 0) throw new Error(`tar failed: ${tar.stderr}`);
  const app = join(extracted, 'PandaCode.app');
  if (!existsSync(app)) throw new Error('The archive does not contain PandaCode.app.');
  let root = '/Applications';
  try { accessSync(root, constants.W_OK); } catch { root = join(homedir(), 'Applications'); mkdirSync(root, { recursive: true }); }
  const target = join(root, 'PandaCode.app');
  const old = join(root, `.PandaCode-old-${process.pid}.app`);
  if (existsSync(target)) renameSync(target, old);
  try { renameSync(app, target); } catch { // different volume
    const copy = run('cp', ['-R', app, target]);
    if (copy.status !== 0) { if (existsSync(old)) renameSync(old, target); throw new Error(`Could not copy the app: ${copy.stderr}`); }
  }
  rmSync(old, { recursive: true, force: true });
  const macos = join(target, 'Contents', 'MacOS');
  const names = readdirSync(macos);
  const binary = names.find(n => n === 'pandacode') ?? names[0];
  const sign = run(join(macos, binary), ['--local-sign']);
  if (sign.status !== 0) throw new Error(`Local signing failed:\n${sign.stdout}${sign.stderr}`);
  run('open', [target]);
  return target;
}

function installWindows(setup) {
  const result = run(setup, ['/S'], { stdio: 'inherit' });
  if (result.status !== 0) throw new Error(`The installer exited with ${result.status}.`);
  const base = process.env.LOCALAPPDATA ?? join(homedir(), 'AppData', 'Local');
  const exe = ['PandaCode', 'Programs\\PandaCode'].map(d => join(base, d, 'PandaCode.exe')).find(existsSync);
  if (!exe) return 'PandaCode (installed; start it from the Start menu)';
  spawn(exe, [], { detached: true, stdio: 'ignore' }).unref();
  return exe;
}

function installLinux(appImage) {
  const bin = join(homedir(), '.local', 'bin');
  const share = join(homedir(), '.local', 'share');
  mkdirSync(bin, { recursive: true });
  mkdirSync(join(share, 'applications'), { recursive: true });
  mkdirSync(join(share, 'icons'), { recursive: true });
  const target = join(bin, 'pandacode');
  copyFileSync(appImage, target);
  chmodSync(target, 0o755);
  const icon = join(share, 'icons', 'pandacode.png');
  copyFileSync(join(dirname(fileURLToPath(import.meta.url)), 'icon.png'), icon);
  writeFileSync(join(share, 'applications', 'pandacode.desktop'), desktopEntry(target, icon));
  spawn(target, [], { detached: true, stdio: 'ignore' }).unref();
  return target;
}

export async function install({ dryRun = false } = {}) {
  const asset = assetFor();
  const dir = mkdtempSync(join(tmpdir(), 'pandacode-'));
  try {
    const file = join(dir, asset);
    const [data, sig] = [await download(`${BASE}/${asset}`, asset), await download(`${BASE}/${asset}.sig`, `${asset}.sig`)];
    verifyMinisign(data, sig.toString('utf8'));
    console.log('Signature verified.');
    if (dryRun) return console.log('Dry run: nothing installed.');
    writeFileSync(file, data);
    const where = process.platform === 'darwin' ? installMac(file, dir) : process.platform === 'win32' ? installWindows(file) : installLinux(file);
    console.log(`Installed PandaCode at ${where}`);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
