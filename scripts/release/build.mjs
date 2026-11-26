// Builds one desktop installer on its native OS and copies it to
// release/<version>/ under its stable GitHub Release asset name, with a
// SHA-256 sidecar. Nothing is uploaded; .github/workflows/release.yml does that.
//
//   node scripts/release/build.mjs [darwin-aarch64|darwin-x86_64|windows-x86_64|windows-aarch64|linux-x86_64|linux-aarch64]
//
// Outside official builds, macOS can use an ad-hoc signature without Apple
// credentials. Windows and Linux builds are unsigned. With TAURI_SIGNING_PRIVATE_KEY
// (the release workflow's secret) the build also produces the signed update file and
// its `.sig` for the in-app updater.
import { readFile, writeFile, mkdir, copyFile, readdir, readlink, mkdtemp, rmdir, rm, lstat, chmod } from 'node:fs/promises';
import { resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync, spawnSync } from 'node:child_process';
import { root, version, json, run, digest, targetConfig, hostTarget, appImageBundleOptions, releaseDirectory, isMain } from './common.mjs';
import { repackAppImage } from './appimage.mjs';

// Never forwarded to the build: leftovers of the old license check in a developer
// shell must not change the output.
const STRIPPED = /^PANDACODE_(LICENSE|UPDATE)_PUBLIC_KEY$/;

export function macosSigning(env) {
  const identity = env.APPLE_SIGNING_IDENTITY?.trim();
  if (!identity || identity === '-') {
    if (['1', 'true'].includes(env.PANDACODE_REQUIRE_APPLE_SIGNING)) {
      throw new Error('Official macOS builds require APPLE_SIGNING_IDENTITY (Developer ID Application) and Apple notarization credentials.');
    }
    return { mode: 'adhoc', identity: '-' };
  }
  if (!identity.startsWith('Developer ID Application:')) throw new Error('APPLE_SIGNING_IDENTITY must be a "Developer ID Application: ..." certificate, or unset for an ad-hoc build.');
  const complete = names => names.every(name => env[name]?.trim());
  if (!complete(['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH']) && !complete(['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'])) {
    throw new Error('Developer ID builds must be notarized: set APPLE_API_KEY, APPLE_API_ISSUER and APPLE_API_KEY_PATH, or APPLE_ID, APPLE_PASSWORD and APPLE_TEAM_ID.');
  }
  return { mode: 'developer-id', identity };
}

const API_KEY_CREDENTIALS = ['APPLE_API_KEY', 'APPLE_API_ISSUER', 'APPLE_API_KEY_PATH'];
const APPLE_ID_CREDENTIALS = ['APPLE_ID', 'APPLE_PASSWORD', 'APPLE_TEAM_ID'];

// Tauri notarizes only the app; the disk image around it needs its own ticket.
export function notarytoolArgs(dmg, env) {
  const value = name => (typeof env[name] === 'string' ? env[name].trim() : '');
  const complete = names => names.every(value);
  if (complete(API_KEY_CREDENTIALS)) return ['notarytool', 'submit', dmg, '--key', value('APPLE_API_KEY_PATH'), '--key-id', value('APPLE_API_KEY'), '--issuer', value('APPLE_API_ISSUER'), '--wait'];
  if (complete(APPLE_ID_CREDENTIALS)) return ['notarytool', 'submit', dmg, '--apple-id', value('APPLE_ID'), '--password', value('APPLE_PASSWORD'), '--team-id', value('APPLE_TEAM_ID'), '--wait'];
  throw new Error(`Notarizing the disk image needs ${API_KEY_CREDENTIALS.join(', ')} or ${APPLE_ID_CREDENTIALS.join(', ')}.`);
}

export async function notarizeDmg(dmg, env, commands = { run }) {
  await commands.run('/usr/bin/xcrun', notarytoolArgs(dmg, env));
  await commands.run('/usr/bin/xcrun', ['stapler', 'staple', dmg]);
}

function withoutApple(env) {
  return Object.fromEntries(Object.entries(env).filter(([name]) => !name.startsWith('APPLE_')));
}

// `tauri build` accepts either the key or a path to it; `tauri signer sign` needs
// the key itself.
async function signingEnvironment(env) {
  const key = env.TAURI_SIGNING_PRIVATE_KEY?.trim();
  if (!key) return env;
  try {
    return { ...env, TAURI_SIGNING_PRIVATE_KEY: (await readFile(key, 'utf8')).trim() };
  } catch {
    return env;
  }
}

export function buildPlan(releaseTarget, inherited, platform = process.platform, arch = process.arch) {
  const config = targetConfig(releaseTarget);
  if (platform !== config.platform || arch !== config.arch) throw new Error(`Build ${releaseTarget} on its native ${config.platform}/${config.arch} host.`);
  const base = Object.fromEntries(Object.entries(inherited).filter(([name]) => !STRIPPED.test(name)));
  // Update files need the signing key; local builds without it skip them.
  const shared = { createUpdaterArtifacts: Boolean(base.TAURI_SIGNING_PRIVATE_KEY?.trim()), ...appImageBundleOptions(releaseTarget) };
  const cargoTarget = { CARGO_TARGET_DIR: resolve(root, 'src-tauri/target') };
  if (releaseTarget.startsWith('darwin-')) {
    const signing = macosSigning(base);
    const env = signing.mode === 'adhoc' ? withoutApple(base) : base;
    return plan(config, { ...env, ...cargoTarget, APPLE_SIGNING_IDENTITY: signing.identity }, signing.mode, { ...shared, macOS: { signingIdentity: signing.identity } });
  }
  // Neither Windows nor Linux uses Apple credentials, even if a shell has them.
  const env = { ...withoutApple(base), ...cargoTarget };
  if (releaseTarget.startsWith('windows-')) {
    // A local STATIC_VCRUNTIME=false must not produce an installer that only
    // starts on machines with the Visual C++ redistributable installed.
    return plan(config, { ...env, STATIC_VCRUNTIME: 'true' }, 'unsigned', { ...shared, windows: { webviewInstallMode: { type: 'downloadBootstrapper', silent: true }, nsis: { installMode: 'currentUser' } } });
  }
  return plan(config, env, 'unsigned', shared);
}

function plan(config, env, mode, bundle) {
  return { env, signing: { mode }, updater: bundle.createUpdaterArtifacts, args: ['build', '--target', config.triple, '--bundles', config.bundles, '--config', JSON.stringify({ bundle })] };
}

export function builtArtifact(names, releaseVersion, releaseTarget) {
  const expected = targetConfig(releaseTarget).built(version(releaseVersion));
  if (!names.includes(expected)) throw new Error(`Tauri did not produce ${expected}.`);
  return expected;
}

export function checksumLine(sha256, filename) {
  if (!/^[a-f0-9]{64}$/.test(sha256)) throw new Error('Invalid SHA-256 digest.');
  return `${sha256}  ${filename}\n`;
}

async function checkVersions(releaseVersion) {
  const tauri = await json(resolve(root, 'src-tauri/tauri.conf.json'));
  const pkg = await json(resolve(root, 'package.json'));
  const cargo = await readFile(resolve(root, 'src-tauri/Cargo.toml'), 'utf8');
  if (tauri.version !== releaseVersion || pkg.version !== releaseVersion || !cargo.includes(`version = "${releaseVersion}"`)) {
    throw new Error('package.json, tauri.conf.json and Cargo.toml disagree on the version. Run npm run release:version first.');
  }
}

function verifyAdhocSignature(app) {
  const result = spawnSync('/usr/bin/codesign', ['--display', '--verbose=4', app], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  const details = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  if (result.status !== 0 || !/^Signature=adhoc\r?$/m.test(details) || /^Authority=/m.test(details)) throw new Error('Expected an ad-hoc macOS signature.');
}

async function verifyPackagedMacApp(installed, { app, releaseVersion, mode }, label, commands) {
  if (!(await lstat(installed)).isDirectory()) throw new Error(`The ${label} is missing its app bundle.`);
  await commands.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', installed]);
  const plist = resolve(installed, 'Contents/Info.plist');
  const readPlist = key => commands.execFileSync('/usr/libexec/PlistBuddy', ['-c', `Print :${key}`, plist], { encoding: 'utf8' }).trim();
  const binary = 'Contents/MacOS/pandacode';
  if (readPlist('CFBundleShortVersionString') !== releaseVersion || readPlist('CFBundleExecutable') !== 'pandacode' ||
      await digest(resolve(installed, binary)) !== await digest(resolve(app, binary))) {
    throw new Error(`The ${label} contains a different app build.`);
  }
  if (mode === 'developer-id') {
    // Gatekeeper can accept an unstapled app online, so require the attached ticket too.
    await commands.run('/usr/bin/xcrun', ['stapler', 'validate', installed]);
    await commands.run('/usr/sbin/spctl', ['--assess', '--type', 'execute', '--verbose', '--ignore-cache', '--no-cache', installed]);
  }
}

async function verifyDmg(artifacts, commands) {
  await commands.run('/usr/bin/hdiutil', ['verify', artifacts.dmg, '-quiet']);
  if (artifacts.mode === 'developer-id') {
    // The container itself must carry a ticket and pass Gatekeeper's open check.
    await commands.run('/usr/bin/xcrun', ['stapler', 'validate', artifacts.dmg]);
    await commands.run('/usr/sbin/spctl', ['--assess', '--type', 'open', '--context', 'context:primary-signature', '--verbose', '--ignore-cache', '--no-cache', artifacts.dmg]);
  }
  const scratch = await mkdtemp(resolve(tmpdir(), 'pandacode-dmg-verify-'));
  const mount = resolve(scratch, 'volume');
  await mkdir(mount);
  let mounted = false;
  try {
    await commands.run('/usr/bin/hdiutil', ['attach', artifacts.dmg, '-readonly', '-nobrowse', '-noautoopen', '-mountpoint', mount, '-quiet']);
    mounted = true;
    if (await readlink(resolve(mount, 'Applications')) !== '/Applications') throw new Error('The disk image is missing its Applications shortcut.');
    await verifyPackagedMacApp(resolve(mount, 'PandaCode.app'), artifacts, 'disk image', commands);
  } finally {
    if (mounted) await commands.run('/usr/bin/hdiutil', ['detach', mount, '-quiet']);
    // Only remove empty mount directories; never recursively delete a volume.
    await rmdir(mount); await rmdir(scratch);
  }
}

export async function verifyMacArtifacts(artifacts, commands = { run, execFileSync }) {
  const { app, mode, updater } = artifacts;
  if (mode === 'adhoc') {
    await commands.run('/usr/bin/codesign', ['--verify', '--deep', '--strict', app]);
    verifyAdhocSignature(app);
  }
  await verifyDmg(artifacts, commands);
  if (mode !== 'developer-id' || !updater) return;
  const scratch = await mkdtemp(resolve(tmpdir(), 'pandacode-updater-verify-'));
  try {
    await commands.run('/usr/bin/tar', ['-xzf', updater, '-C', scratch]);
    await verifyPackagedMacApp(resolve(scratch, 'PandaCode.app'), artifacts, 'updater archive', commands);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function resignAppImage(source, releaseVersion, env, commands = {}) {
  const runCommand = commands.run ?? run;
  const tauriCli = commands.tauriCli ?? resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
  await runCommand(process.execPath, [tauriCli, 'signer', 'sign', '--app-version', version(releaseVersion), source], {
    env: await signingEnvironment(env),
  });
}

async function main() {
  const releaseTarget = process.argv[2] || process.env.RELEASE_TARGET || hostTarget();
  const config = targetConfig(releaseTarget);
  const releaseVersion = version((await json(resolve(root, 'src-tauri/tauri.conf.json'))).version);
  await checkVersions(releaseVersion);
  const build = buildPlan(releaseTarget, process.env);
  // Execute Node directly: npm.cmd is not an executable for spawn() on Windows.
  const tauriCli = resolve(root, 'node_modules/@tauri-apps/cli/tauri.js');
  await run(process.execPath, [tauriCli, ...build.args], { env: build.env });
  const bundleRoot = resolve(root, 'src-tauri/target', config.triple, 'release/bundle');
  const bundleDir = resolve(bundleRoot, config.bundleDir);
  const source = resolve(bundleDir, builtArtifact(await readdir(bundleDir), releaseVersion, releaseTarget));
  const updater = build.updater ? resolve(bundleRoot, config.updater(releaseVersion)) : undefined;
  if (releaseTarget.startsWith('darwin-')) {
    const app = resolve(bundleRoot, 'macos/PandaCode.app');
    if (build.signing.mode === 'developer-id') await notarizeDmg(source, build.env);
    await verifyMacArtifacts({ dmg: source, app, releaseVersion, mode: build.signing.mode, updater });
  }
  if (releaseTarget.startsWith('linux-')) {
    // Drop the build host's Wayland libraries, let GDK_BACKEND be overridden (see
    // appimage.mjs), and sign the final bytes again, since Tauri signed the image
    // before this rebuild.
    await repackAppImage(source, { log: message => console.log(message) });
    if (build.updater) await resignAppImage(source, releaseVersion, build.env, { run, tauriCli });
  }
  const output = releaseDirectory(releaseVersion);
  await mkdir(output, { recursive: true });
  const destination = resolve(output, config.asset);
  await copyFile(source, destination);
  if (releaseTarget.startsWith('linux-')) await chmod(destination, 0o755);
  await writeFile(`${destination}.sha256`, checksumLine(await digest(destination), config.asset));
  if (updater) {
    if (config.updaterAsset !== config.asset) await copyFile(updater, resolve(output, config.updaterAsset));
    await copyFile(`${updater}.sig`, resolve(output, `${config.updaterAsset}.sig`));
  }
  console.log(`Built ${config.asset} (${build.signing.mode}) in ${output}. Nothing was uploaded.`);
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
