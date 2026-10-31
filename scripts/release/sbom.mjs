// Release assurance: one CycloneDX SBOM per packaged artifact (syft), Rust and npm
// dependency SBOMs from the lockfiles, a grype scan of each, and SBOM-COVERAGE.{json,md}.
// Findings never fail the run; an inventory that is empty or errored is reported as
// "incomplete", never as a pass. See docs/releasing.md.
//
//   node scripts/release/sbom.mjs <assets-dir> <out-dir> <version> <commit>
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { mkdir, readFile, readdir, writeFile } from 'node:fs/promises';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { targets } from './common.mjs';

const run = promisify(execFile);
const LIMIT = 512 * 1024 * 1024;

/** Assets that get their own SBOM: the installers, plus the macOS updater archives. */
export function packagedAssets(names) {
  const wanted = new Set(Object.values(targets).flatMap(t => [t.asset, t.updaterAsset]));
  return names.filter(name => wanted.has(name)).sort();
}

export function platformOf(name) {
  const entry = Object.entries(targets).find(([, t]) => t.asset === name || t.updaterAsset === name);
  return entry ? `${entry[1].platform}/${entry[1].arch}` : 'unknown';
}

const count = bom => Array.isArray(bom?.components) ? bom.components.length : 0;

/** "ok" only with a non-empty inventory; an empty or failed one is "incomplete". */
export function inventoryStatus({ bom, error }) {
  if (error) return { status: 'incomplete', components: 0, reason: `syft failed: ${error}` };
  const components = count(bom);
  if (components === 0) return { status: 'incomplete', components, reason: 'syft found no components (format unsupported or nothing identifiable)' };
  return { status: 'ok', components };
}

const SEVERITIES = ['Critical', 'High', 'Medium', 'Low', 'Negligible', 'Unknown'];

/** Scan status: "scanned" needs a complete inventory and a grype run that finished. */
export function scanStatus(inventory, { report, error }) {
  if (inventory.status !== 'ok') return { status: 'not-scanned', reason: 'inventory incomplete' };
  if (error) return { status: 'failed', reason: `grype failed: ${error}` };
  const severities = Object.fromEntries(SEVERITIES.map(s => [s, 0]));
  for (const match of report?.matches ?? []) {
    const severity = SEVERITIES.includes(match.vulnerability?.severity) ? match.vulnerability.severity : 'Unknown';
    severities[severity] += 1;
  }
  return { status: 'scanned', findings: (report?.matches ?? []).length, severities };
}

export function coverage({ version, commit, scanners, dbBuilt, entries, notes }) {
  const incomplete = entries.filter(e => e.inventory.status !== 'ok' || e.scan.status !== 'scanned');
  return {
    version, commit, scanners, vulnerabilityDbBuilt: dbBuilt ?? 'unknown', entries, notes,
    complete: incomplete.length === 0, incomplete: incomplete.map(e => e.name),
  };
}

export function markdown(report) {
  const rows = report.entries.map(e => {
    const scan = e.scan.status === 'scanned' ? `${e.scan.findings} finding(s)` : `${e.scan.status}${e.scan.reason ? `: ${e.scan.reason}` : ''}`;
    const inventory = e.inventory.status === 'ok' ? `${e.inventory.components} components` : `**incomplete** (${e.inventory.reason})`;
    return `| \`${e.name}\` | ${e.platform} | \`${e.sha256 ?? 'n/a'}\` | ${e.kind} | ${inventory} | ${scan} |`;
  });
  return [
    `# Security scan coverage for PandaCode ${report.version}`, '',
    `Commit \`${report.commit}\`. Scanners: ${Object.entries(report.scanners).map(([n, v]) => `${n} ${v}`).join(', ')}. Vulnerability database built: ${report.vulnerabilityDbBuilt}.`, '',
    report.complete ? 'All listed inventories were identified and scanned.' : `**Coverage is incomplete** for: ${report.incomplete.map(n => `\`${n}\``).join(', ')}. An incomplete inventory is not a clean scan.`, '',
    '| Subject | Platform | SHA-256 | Kind | Inventory | Vulnerability scan |', '| --- | --- | --- | --- | --- | --- |', ...rows, '',
    '## Limits', '', ...report.notes.map(n => `- ${n}`), '',
  ].join('\n');
}

const NOTES = [
  'Artifact SBOMs list only what syft can identify inside the installer; compressed installers (DMG, NSIS, AppImage) often yield little or nothing, which is reported as incomplete.',
  'The Rust and npm SBOMs come from Cargo.lock and package-lock.json at the release commit and describe build dependencies, not a verified inventory of any one installer.',
  'The website, the relay and the npx package are not shipped in the desktop app and are excluded.',
  'The WebView and other operating-system libraries (WebKitGTK, WebView2, WKWebView, glibc) are supplied by the host, are not bundled, and are not scanned.',
  'Findings are reported, not gating. Checksums and signatures are separate provenance checks and are unchanged.',
];

async function sha256(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}

async function tool(command, args) {
  try { return { out: (await run(command, args, { maxBuffer: LIMIT })).stdout }; }
  catch (error) { return { error: (error.stderr || error.message).toString().trim().split('\n').slice(-3).join(' ').slice(0, 300) }; }
}

async function inventory(source, outFile) {
  const result = await tool('syft', ['scan', ...source, '-o', `cyclonedx-json=${outFile}`, '-q']);
  if (result.error) return inventoryStatus({ error: result.error });
  return inventoryStatus({ bom: JSON.parse(await readFile(outFile, 'utf8')) });
}

async function scan(inventoryResult, file) {
  if (inventoryResult.status !== 'ok') return scanStatus(inventoryResult, {});
  const result = await tool('grype', [`sbom:${file}`, '-o', 'json', '-q']);
  return scanStatus(inventoryResult, result.error ? { error: result.error } : { report: JSON.parse(result.out) });
}

async function main() {
  const [assets, out, releaseVersion, commit] = process.argv.slice(2);
  if (!assets || !out || !releaseVersion || !commit) throw new Error('Usage: sbom.mjs <assets-dir> <out-dir> <version> <commit>');
  await mkdir(out, { recursive: true });
  const syftVersion = JSON.parse((await tool('syft', ['version', '-o', 'json'])).out ?? '{}').version;
  const grypeVersion = JSON.parse((await tool('grype', ['version', '-o', 'json'])).out ?? '{}').version;
  const db = await tool('grype', ['db', 'status', '-o', 'json']);
  const dbBuilt = db.out ? JSON.parse(db.out).built : undefined;

  const subjects = [
    ...packagedAssets(await readdir(assets)).map(name => ({ name, kind: 'artifact', platform: platformOf(name), source: [`file:${resolve(assets, name)}`], path: resolve(assets, name) })),
    { name: 'pandacode-npm', kind: 'npm lockfile', platform: 'all', source: ['dir:.', '--select-catalogers', 'javascript', '--exclude', './website/**', '--exclude', './packages/**', '--exclude', './relay/**', '--exclude', './node_modules/**'] },
    { name: 'pandacode-rust', kind: 'Cargo.lock', platform: 'all', source: ['dir:.', '--select-catalogers', 'rust'] },
  ];
  const entries = [];
  for (const subject of subjects) {
    const file = resolve(out, `${subject.name}.cdx.json`);
    const inv = await inventory(subject.source, file);
    const result = await scan(inv, file);
    entries.push({ name: subject.name, kind: subject.kind, platform: subject.platform, sha256: subject.path ? await sha256(subject.path) : undefined, sbom: inv.status === 'ok' ? basename(file) : undefined, inventory: inv, scan: result });
    console.log(`${subject.name}: inventory ${inv.status}, scan ${result.status}`);
  }
  const report = coverage({ version: releaseVersion, commit, scanners: { syft: syftVersion ?? 'unknown', grype: grypeVersion ?? 'unknown' }, dbBuilt, entries, notes: NOTES });
  await writeFile(resolve(out, 'SBOM-COVERAGE.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(out, 'SBOM-COVERAGE.md'), markdown(report));
  if (!report.complete) console.log(`::warning::SBOM/scan coverage is incomplete for: ${report.incomplete.join(', ')}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
