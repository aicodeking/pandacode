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
import { targets, isMain } from './common.mjs';

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
  return { status: 'scanned', findings: (report?.matches ?? []).length, severities, advisories: advisories(report?.matches) };
}

const REPORTED = ['Critical', 'High'];
const text = value => (typeof value === 'string' || typeof value === 'number') && String(value).trim() ? String(value).trim() : undefined;

/** Critical and High matches as a sorted, de-duplicated `{ id, severity, package, version }` list. */
export function advisories(matches) {
  const seen = new Map();
  for (const match of Array.isArray(matches) ? matches : []) {
    const severity = match?.vulnerability?.severity;
    const id = text(match?.vulnerability?.id);
    if (!REPORTED.includes(severity) || !id) continue;
    const entry = { id, severity, package: text(match?.artifact?.name) ?? 'unknown', version: text(match?.artifact?.version) ?? 'unknown' };
    const key = [entry.id, entry.package, entry.version].join('\0');
    const prior = seen.get(key);
    if (!prior || REPORTED.indexOf(severity) < REPORTED.indexOf(prior.severity)) seen.set(key, entry);
  }
  const cmp = (a, b) => (a < b ? -1 : a > b ? 1 : 0);
  return [...seen.values()].sort((a, b) => REPORTED.indexOf(a.severity) - REPORTED.indexOf(b.severity)
    || cmp(a.package, b.package) || cmp(a.version, b.version) || cmp(a.id, b.id));
}

/**
 * The vulnerability database build time from `grype db status -o json`. grype 0.121.0 (schema v6)
 * prints `{ schemaVersion, from, built, path, valid }`; older or wrapped shapes nest it under `status`.
 * Falls back to the timestamp in the `from` archive URL. Returns an ISO string or undefined.
 */
export function dbBuiltAt(status) {
  let db = status;
  if (typeof db === 'string') {
    try { db = JSON.parse(db); } catch { return undefined; }
  }
  if (!db || typeof db !== 'object') return undefined;
  const fromUrl = text(db.from ?? db.status?.from)?.match(/_(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z)_/)?.[1];
  for (const candidate of [db.built, db.status?.built, db.db?.built, fromUrl]) {
    const value = text(candidate);
    if (value && !Number.isNaN(Date.parse(value))) return new Date(value).toISOString().replace('.000Z', 'Z');
  }
  return undefined;
}

function advisoryLines(entries) {
  return entries.filter(e => e.scan.advisories?.length).map(e => {
    const groups = new Map();
    for (const a of e.scan.advisories) {
      const key = `**${a.severity}** \`${a.package}\` ${a.version}`;
      groups.set(key, [...(groups.get(key) ?? []), a.id]);
    }
    return `- \`${e.name}\`: ${[...groups].map(([key, ids]) => `${key}: ${ids.join(', ')}`).join('; ')}`;
  });
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
  const advisories = advisoryLines(report.entries);
  return [
    `# Security scan coverage for PandaCode ${report.version}`, '',
    `Commit \`${report.commit}\`. Scanners: ${Object.entries(report.scanners).map(([n, v]) => `${n} ${v}`).join(', ')}. Vulnerability database built: ${report.vulnerabilityDbBuilt}.`, '',
    report.complete ? 'All listed inventories were identified and scanned.' : `**Coverage is incomplete** for: ${report.incomplete.map(n => `\`${n}\``).join(', ')}. An incomplete inventory is not a clean scan.`, '',
    '| Subject | Platform | SHA-256 | Kind | Inventory | Vulnerability scan |', '| --- | --- | --- | --- | --- | --- |', ...rows, '',
    ...(advisories.length ? ['## Critical and High advisories', '', ...advisories, ''] : []),
    '## Limits', '', ...report.notes.map(n => `- ${n}`), '',
  ].join('\n');
}

/** Paths kept out of the `pandacode-npm` scan: none of them ship in the desktop app. */
export const NPM_EXCLUDES = ['./mobile/**', './website/**', './packages/**', './relay/**', './node_modules/**'];

export const NOTES = [
  'Artifact SBOMs list only what syft can identify inside the installer; compressed installers (DMG, NSIS, AppImage) often yield little or nothing, which is reported as incomplete.',
  'The Rust and npm SBOMs come from Cargo.lock and package-lock.json at the release commit and describe build dependencies, not a verified inventory of any one installer.',
  'The mobile app, the website, the relay and the npx package are not shipped in the desktop app and are excluded.',
  'On macOS and Windows, the host supplies the WebView (WKWebView or WebView2) and other operating-system libraries. These libraries are not bundled or scanned.',
  'Linux AppImages bundle WebKitGTK, JavaScriptCoreGTK, GTK, and supporting shared libraries under usr/lib. The host supplies glibc, Wayland/EGL, and GPU drivers. Syft finds no identifiable package inventory inside the compressed AppImages, so both Linux AppImages remain incomplete / not-scanned and their bundled shared libraries are not scanned.',
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

  const subjects = [
    ...packagedAssets(await readdir(assets)).map(name => ({ name, kind: 'artifact', platform: platformOf(name), source: [`file:${resolve(assets, name)}`], path: resolve(assets, name) })),
    { name: 'pandacode-npm', kind: 'npm lockfile', platform: 'all', source: ['dir:.', '--select-catalogers', 'javascript', ...NPM_EXCLUDES.flatMap(glob => ['--exclude', glob])] },
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
  // After the scans: on a fresh runner the first scan downloads the database.
  const dbBuilt = dbBuiltAt((await tool('grype', ['db', 'status', '-o', 'json'])).out);
  if (!dbBuilt) console.log('::warning::Could not determine grype vulnerability database build time; reporting "unknown".');
  const report = coverage({ version: releaseVersion, commit, scanners: { syft: syftVersion ?? 'unknown', grype: grypeVersion ?? 'unknown' }, dbBuilt, entries, notes: NOTES });
  await writeFile(resolve(out, 'SBOM-COVERAGE.json'), `${JSON.stringify(report, null, 2)}\n`);
  await writeFile(resolve(out, 'SBOM-COVERAGE.md'), markdown(report));
  if (!report.complete) console.log(`::warning::SBOM/scan coverage is incomplete for: ${report.incomplete.join(', ')}`);
}

if (isMain(import.meta.url)) {
  main().catch(error => { console.error(error.message); process.exitCode = 1; });
}
