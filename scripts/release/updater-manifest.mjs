// Writes latest.json, the in-app updater's manifest, beside a release's assets: one entry
// per platform whose signed update file was built. The release workflow uploads it with
// the installers, so .../releases/latest/download/latest.json names the newest version.
//
//   node scripts/release/updater-manifest.mjs <assets-dir> <version> <notes.md>
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { targets, updaterManifest, isMain } from './common.mjs';

export async function signaturesIn(directory) {
  const signatures = {};
  for (const [target, config] of Object.entries(targets)) {
    try { signatures[target] = await readFile(resolve(directory, `${config.updaterAsset}.sig`), 'utf8'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
  }
  return signatures;
}

async function main() {
  const [directory, releaseVersion, notesFile] = process.argv.slice(2);
  if (!directory || !releaseVersion || !notesFile) throw new Error('Usage: updater-manifest.mjs <assets-dir> <version> <notes.md>');
  const manifest = updaterManifest(releaseVersion, await readFile(notesFile, 'utf8'), await signaturesIn(directory));
  await writeFile(resolve(directory, 'latest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
  console.log(`latest.json: ${manifest.version} for ${Object.keys(manifest.platforms).join(', ')}`);
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
