// Local-only native companion staging and qualification; never installs or activates packages.
import { spawnSync } from 'node:child_process';
import { mkdirSync, copyFileSync, writeFileSync, readFileSync, readdirSync, lstatSync, existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const trustedRuntime = Object.freeze({
  nodeVersion: 'v26.1.0',
  nodeSha256: '35ebb74da6acb56fdf570de64f1ae510d6d18ca09da494a3e1ac87edd32d263b',
  licenseSha256: 'd94dd7496d4de9cd130f1eb6e661e43422483663fd48cf3a450d244b9cda6fdc',
});
const hash = bytes => createHash('sha256').update(bytes).digest('hex');

/** Local, build-time inputs only. No PATH lookup, download, install script or activation. */
export function stageTrustedRuntime({ target = `${process.platform}-${process.arch}`, directory = resolve(root, 'src-tauri/target/extension-runtime'), binary = process.env.PANDACODE_EXTENSION_NODE || process.execPath, licensePath = process.env.PANDACODE_EXTENSION_NODE_LICENSE } = {}) {
  if (!['win32-x64', 'windows-x86_64', 'x86_64-pc-windows-msvc'].includes(target)) return {};
  if (!licensePath) throw new Error('Windows x64 packaging requires PANDACODE_EXTENSION_NODE_LICENSE: the complete local Node v26.1.0 upstream LICENSE. No runtime will be downloaded.');
  const verified = (path, expected, max) => {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink() || stat.size > max) throw new Error('Trusted runtime input must be a bounded regular file.');
    const bytes = readFileSync(path);
    if (hash(bytes) !== expected) throw new Error('Trusted runtime input SHA-256 mismatch. Use the pinned Node v26.1.0 Windows x64 executable and complete LICENSE.');
    return bytes;
  };
  // Validate both inputs before creating or changing the packaging stage.
  const license = verified(resolve(licensePath), trustedRuntime.licenseSha256, 1024 * 1024);
  verified(resolve(binary), trustedRuntime.nodeSha256, 150 * 1024 * 1024);
  mkdirSync(directory, { recursive: true });
  if (lstatSync(directory).isSymbolicLink()) throw new Error('Refusing a linked runtime stage.');
  for (const name of ['node.exe', 'LICENSE', 'manifest.json']) {
    if (existsSync(resolve(directory, name)) && (!lstatSync(resolve(directory, name)).isFile() || lstatSync(resolve(directory, name)).isSymbolicLink())) throw new Error('Refusing a linked runtime resource.');
  }
  copyFileSync(resolve(binary), resolve(directory, 'node.exe'));
  verified(resolve(directory, 'node.exe'), trustedRuntime.nodeSha256, 150 * 1024 * 1024);
  writeFileSync(resolve(directory, 'LICENSE'), license);
  writeFileSync(resolve(directory, 'manifest.json'), JSON.stringify({ schemaVersion: 1, target: 'windows-x64', ...trustedRuntime }, null, 2) + '\n');
  return Object.fromEntries(['node.exe', 'LICENSE', 'manifest.json'].map(name => [resolve(directory, name), `extension-runtime/${name}`]));
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
if (process.argv[2] === '--trusted-bundle') {
  if (process.argv.length !== 3) throw new Error('--trusted-bundle takes local inputs through PANDACODE_EXTENSION_NODE / PANDACODE_EXTENSION_NODE_LICENSE.');
  console.log(JSON.stringify({ bundle: { resources: stageTrustedRuntime() } }));
  process.exit(0);
}
// New trusted-host staging is independent of (and never retries) the preserved LPAC experiment.
if (process.argv[2] === '--trusted-stage') {
  const licensePath = process.argv[3];
  if (process.platform !== 'win32' || process.arch !== 'x64' || process.version !== 'v26.1.0' || !licensePath || process.argv.length !== 4) throw new Error('Usage: Node v26.1.0 Windows x64: --trusted-stage <local version-matched Node LICENSE>');
  const directory = resolve(root, '_work/00-tmp/extensibility-trusted-runtime');
  const resources = stageTrustedRuntime({ directory, licensePath });
  writeFileSync(resolve(directory, 'tauri-runtime.conf.json'), JSON.stringify({ bundle: { resources } }, null, 2) + '\n');
  console.log(JSON.stringify({ stage: directory, bytes: readFileSync(resolve(directory, 'node.exe')).length, version: process.version, nativeQualification: false, releaseSupport: 'experimental, explicit local packaging only' }));
  process.exit(0);
}
const target = resolve(root, '_work/00-tmp/extensibility-runtime-target');
const stage = resolve(root, '_work/00-tmp/extensibility-runtime-package');
function command(binary,args,env=process.env) {
  const result = spawnSync(binary,args,{cwd:root,env,encoding:'utf8',timeout:120000,stdio:['ignore','pipe','pipe']});
  if (result.status !== 0) throw new Error(`${binary} failed (${result.status}): ${result.error || ''}\n${result.stdout || ''}\n${result.stderr || ''}`);
  if (result.stderr) process.stderr.write(result.stderr);
  return result.stdout;
}
if (process.platform !== 'win32' || process.arch !== 'x64') throw new Error('Windows x64 native qualification is required; no fallback.');
const manifest = 'src-tauri/src/extensions/native-runtime/Cargo.toml';
const env = {...process.env,CARGO_TARGET_DIR:target,PANDACODE_RUNTIME_STAGE:stage};
process.stdout.write(command('cargo',['build','--offline','--locked','--manifest-path',manifest,'--features','native-probes'],env));
mkdirSync(stage,{recursive:true});
const names = ['pandacode-extension-host.exe','pandacode-runtime-probe.exe'];
for (const name of names) copyFileSync(resolve(target,'debug',name),resolve(stage,name));
// Carry the complete resolved graph's source notices, including build tools and
// optional dependencies. This conservative set is not a claim of binary linkage.
const metadata = JSON.parse(command('cargo',['metadata','--offline','--locked','--format-version','1','--manifest-path',manifest,'--features','native-probes','--filter-platform','x86_64-pc-windows-msvc'],env));
const notices = ['Test-owned unsigned runtime staging. Not a release or activation artifact.'];
for (const pkg of metadata.packages.filter(pkg=>pkg.source).sort((a,b)=>a.name.localeCompare(b.name,'en'))) {
  const directory = dirname(pkg.manifest_path);
  const licenses = readdirSync(directory).filter(name=>/^(LICENSE|COPYING|NOTICE)([.-]|$)/i.test(name)).sort();
  notices.push(`\n=== ${pkg.name} ${pkg.version} (${pkg.license}) ===`);
  // These two upstream workspace crates omit the root MIT file in their
  // published archives. Use the same pinned project's top-level crate notice.
  if (!licenses.length && ['rquickjs-core','rquickjs-sys'].includes(pkg.name) && pkg.license === 'MIT') {
    const umbrella = metadata.packages.find(other=>other.name === 'rquickjs' && other.version === pkg.version && other.repository === pkg.repository);
    if (!umbrella) throw new Error(`Missing matching rquickjs notice: ${pkg.name}`);
    notices.push(`\n--- rquickjs project LICENSE ---\n${readFileSync(resolve(dirname(umbrella.manifest_path),'LICENSE'),'utf8')}`);
  } else if (!licenses.length) throw new Error(`Missing source notice: ${pkg.name} ${pkg.version}`);
  for (const name of licenses) notices.push(`\n--- ${name} ---\n${readFileSync(resolve(directory,name),'utf8')}`);
  if (pkg.name === 'rquickjs-sys') notices.push(`\n--- bundled QuickJS-NG LICENSE ---\n${readFileSync(resolve(directory,'quickjs/LICENSE'),'utf8')}`);
}
writeFileSync(resolve(stage,'THIRD-PARTY-NOTICES.txt'),notices.join('\n')+'\n');
// Deriving a SID does not provision a global AppContainer profile or registry/storage roots.
const sid = command(resolve(stage,names[1]),['--sid'],env).trim();
if (!/^S-1-15-2-(\d+-)*\d+$/.test(sid)) throw new Error('Invalid derived AppContainer SID');
// Grant read/execute ONLY on the newly staged test-owned companion resources.
process.stdout.write(command('icacls.exe',[stage,'/grant:r',`*${sid}:(OI)(CI)(RX)`,'/T','/Q'],env));
const files = [...names,'THIRD-PARTY-NOTICES.txt'].map(name=>({name,sha256:createHash('sha256').update(readFileSync(resolve(stage,name))).digest('hex')}));
writeFileSync(resolve(stage,'manifest.json'),JSON.stringify({target:'windows-x64',mode:'test-owned-unsigned',sid,files,activationEnabled:false},null,2)+'\n');
const args = process.argv.slice(2);
if (args.includes('--stage-only')) {
  if (args.length !== 1) throw new Error('--stage-only must be used alone');
  process.stdout.write('Staged test-owned unsigned binaries and dependency notices; no native qualification executed.\n');
} else {
  process.stdout.write(command('cargo',['test','--offline','--locked','--manifest-path',manifest,'--features','native-probes',...args,'--','--nocapture','--test-threads=1'],env));
}
}
