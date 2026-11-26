// Checks a release's assets before they are published: every platform installer with a
// matching SHA-256 sidecar and, when updater signing is required or detected, every
// update file verified against its `.sig` and a latest.json that names them all.
//
//   node scripts/release/verify-publish.mjs [--require-signed] <assets-dir> <version> <notes.md>
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { root, json, digest, targets, version } from './common.mjs';
import { verifyMinisign } from '../../packages/npx/installer.mjs';

const MANIFEST = 'latest.json';
const SBOM_COVERAGE = 'SBOM-COVERAGE.json';

async function defaultPubkey() {
  return (await json(resolve(root, 'src-tauri/tauri.conf.json'))).plugins.updater.pubkey;
}

async function verifyChecksum(directory, asset) {
  const sidecar = await readFile(resolve(directory, `${asset}.sha256`), 'utf8').catch(() => null);
  if (sidecar === null) throw new Error(`${asset}.sha256 is missing.`);
  const match = /^([a-f0-9]{64}) {2}(.+)$/.exec(sidecar.trim());
  if (!match || match[2] !== asset) throw new Error(`${asset}.sha256 is not a sha256sum line for ${asset}.`);
  if (await digest(resolve(directory, asset)) !== match[1]) throw new Error(`${asset} does not match its SHA-256 sidecar.`);
}

async function verifyUpdaterSignatures(directory, names, pubkey) {
  const signatures = {};
  for (const [target, { updaterAsset }] of Object.entries(targets)) {
    if (!names.has(updaterAsset)) throw new Error(`Updater file ${updaterAsset} is missing.`);
    if (!names.has(`${updaterAsset}.sig`)) throw new Error(`Updater signature ${updaterAsset}.sig is missing.`);
    const signature = await readFile(resolve(directory, `${updaterAsset}.sig`), 'utf8');
    try {
      verifyMinisign(await readFile(resolve(directory, updaterAsset)), signature, pubkey);
    } catch (error) {
      throw new Error(`${updaterAsset}.sig does not verify: ${error.message}`);
    }
    signatures[target] = signature.trim();
  }
  return signatures;
}

async function verifyManifest(directory, names, { releaseVersion, notes, repository, signatures }) {
  if (!names.has(MANIFEST)) throw new Error(`${MANIFEST} is missing.`);
  let manifest;
  try { manifest = JSON.parse(await readFile(resolve(directory, MANIFEST), 'utf8')); }
  catch (error) { throw new Error(`${MANIFEST} is not valid JSON: ${error.message}`); }
  if (manifest?.version !== releaseVersion) throw new Error(`${MANIFEST} names version ${manifest?.version}, not ${releaseVersion}.`);
  if (manifest.notes !== notes.trim()) throw new Error(`${MANIFEST} notes differ from the release notes.`);
  for (const [target, { updaterAsset }] of Object.entries(targets)) {
    const entry = manifest.platforms?.[target];
    if (!entry) throw new Error(`${MANIFEST} has no entry for ${target}.`);
    if (entry.signature !== signatures[target]) throw new Error(`${MANIFEST} signature for ${target} differs from ${updaterAsset}.sig.`);
    const url = `https://github.com/${repository}/releases/download/v${releaseVersion}/${updaterAsset}`;
    if (entry.url !== url) throw new Error(`${MANIFEST} URL for ${target} is ${entry.url}, not ${url}.`);
  }
}

export async function verifyPublishAssets({
  directory,
  releaseVersion,
  notes,
  pubkey,
  repository = process.env.GITHUB_REPOSITORY || 'aicodeking/pandacode',
  requireSigned = false,
  warn = console.warn,
}) {
  const v = version(releaseVersion);
  const names = new Set(await readdir(directory));
  for (const { asset } of Object.values(targets)) {
    if (!names.has(asset)) throw new Error(`Installer ${asset} is missing.`);
    await verifyChecksum(directory, asset);
  }
  const hasUpdaterArchive = Object.values(targets).some(t => t.updaterAsset !== t.asset && names.has(t.updaterAsset));
  const signed = Boolean(requireSigned) || names.has(MANIFEST) || hasUpdaterArchive || [...names].some(name => name.endsWith('.sig'));
  if (signed) {
    const signatures = await verifyUpdaterSignatures(directory, names, pubkey ?? await defaultPubkey());
    await verifyManifest(directory, names, { releaseVersion: v, notes: String(notes ?? ''), repository, signatures });
  }
  if (!names.has(SBOM_COVERAGE)) warn(`::warning::${SBOM_COVERAGE} is missing from publish assets.`);
  return { signed };
}

async function main() {
  const { values, positionals } = parseArgs({
    options: { 'require-signed': { type: 'boolean' } },
    allowPositionals: true,
  });
  const [directory, releaseVersion, notesFile] = positionals;
  if (positionals.length !== 3 || !directory || !releaseVersion || !notesFile) {
    throw new Error('Usage: verify-publish.mjs [--require-signed] <assets-dir> <version> <notes.md>');
  }
  const { signed } = await verifyPublishAssets({
    directory, releaseVersion, notes: await readFile(notesFile, 'utf8'), requireSigned: values['require-signed'],
  });
  console.log(`Verified ${Object.keys(targets).length} installers${signed ? ', updater signatures and latest.json' : ' (unsigned: no updater files)'}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
