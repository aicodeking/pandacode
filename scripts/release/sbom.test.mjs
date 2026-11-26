import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { NOTES, NPM_EXCLUDES, advisories, coverage, dbBuiltAt, inventoryStatus, markdown, packagedAssets, platformOf, scanStatus } from './sbom.mjs';

// Windows checkouts may convert the workflow to CRLF; compare against LF only.
const workflow = (await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8')).replace(/\r\n/g, '\n');

function section(text, start, end, label) {
  const from = text.indexOf(start);
  assert.notEqual(from, -1, `${label}: start marker ${JSON.stringify(start)} not found`);
  const body = text.slice(from + start.length);
  const to = body.indexOf(end);
  assert.notEqual(to, -1, `${label}: end marker ${JSON.stringify(end)} not found`);
  return body.slice(0, to);
}

const sbomJob = section(workflow, '\n  sbom:\n', '\n  publish:\n', 'release.yml sbom job');

test('scanner downloads have bounded transient retries and retain pinned integrity checks', () => {
  const download = sbomJob.match(/^\s+curl .+$/m)[0];
  for (const option of ['retry', 'retry-max-time', 'connect-timeout', 'max-time']) {
    assert.match(download, new RegExp(`--${option} [1-9]\\d*\\b`), option);
  }
  for (const tool of ['SYFT', 'GRYPE']) {
    assert.match(sbomJob, new RegExp(`${tool}_VERSION: '[0-9.]+'`));
    assert.match(sbomJob, new RegExp(`${tool}_SHA256: [a-f0-9]{64}\\n`));
  }
  assert.match(sbomJob, /for tool in syft grype; do[\s\S]*curl -fsSL[\s\S]*echo "\$\{!sum_var\}  \$file" \| sha256sum -c -\n\s+tar -xzf/);
  assert.doesNotMatch(sbomJob, /--insecure|--retry-all-errors|\|\| true/);
});

test('missing coverage is summarized as a failure while publishing stays non-blocking', () => {
  assert.match(sbomJob, /continue-on-error: true/);
  const summary = section(sbomJob, '      - name: Show coverage\n', '      - uses:', 'sbom job coverage step');
  assert.match(summary, /if: always\(\)/);
  assert.match(summary, /if \[ -s sbom\/SBOM-COVERAGE\.md \]; then\n\s+cat sbom\/SBOM-COVERAGE\.md >> "\$GITHUB_STEP_SUMMARY"/);
  assert.match(summary, /else\n[\s\S]*coverage[^\n]*unavailable[^\n]*>> "\$GITHUB_STEP_SUMMARY"/i);
  assert.match(summary, /::error::[^\n]*\n\s+exit 1/);
});

test('picks installers and updater archives only', () => {
  const names = ['PandaCode-macOS-arm64.dmg', 'PandaCode-macOS-arm64.dmg.sha256', 'latest.json', 'PandaCode-macOS-arm64.app.tar.gz.sig', 'PandaCode-Linux-x86_64.AppImage'];
  assert.deepEqual(packagedAssets(names), ['PandaCode-Linux-x86_64.AppImage', 'PandaCode-macOS-arm64.dmg']);
  assert.equal(platformOf('PandaCode-Windows-x64-setup.exe'), 'win32/x64');
});

test('an empty or failed inventory is incomplete, never ok', () => {
  assert.equal(inventoryStatus({ bom: { components: [] } }).status, 'incomplete');
  assert.equal(inventoryStatus({ bom: {} }).status, 'incomplete');
  assert.match(inventoryStatus({ error: 'boom' }).reason, /boom/);
  assert.deepEqual(inventoryStatus({ bom: { components: [{}, {}] } }), { status: 'ok', components: 2 });
});

test('a scan needs a complete inventory and counts severities', () => {
  assert.equal(scanStatus({ status: 'incomplete' }, {}).status, 'not-scanned');
  assert.equal(scanStatus({ status: 'ok' }, { error: 'db' }).status, 'failed');
  const scanned = scanStatus({ status: 'ok' }, { report: { matches: [{ vulnerability: { severity: 'High' } }, { vulnerability: { severity: 'odd' } }] } });
  assert.equal(scanned.findings, 2);
  assert.equal(scanned.severities.High, 1);
  assert.equal(scanned.severities.Unknown, 1);
  assert.equal(scanStatus({ status: 'ok' }, { report: {} }).findings, 0);
});

test('coverage is not complete while any inventory is incomplete', () => {
  const ok = { name: 'a', kind: 'artifact', platform: 'x', inventory: { status: 'ok', components: 3 }, scan: { status: 'scanned', findings: 0 } };
  const bad = { name: 'b.dmg', kind: 'artifact', platform: 'y', sha256: 'ff', inventory: { status: 'incomplete', reason: 'none' }, scan: { status: 'not-scanned', reason: 'inventory incomplete' } };
  const base = { version: '1.2.3', commit: 'abc', scanners: { syft: '1', grype: '2' }, notes: ['n'] };
  assert.equal(coverage({ ...base, entries: [ok] }).complete, true);
  const report = coverage({ ...base, entries: [ok, bad] });
  assert.equal(report.complete, false);
  assert.deepEqual(report.incomplete, ['b.dmg']);
  assert.match(markdown(report), /Coverage is incomplete\*\* for: `b\.dmg`/);
  assert.match(markdown(report), /unknown|Vulnerability database built/);
});

// Exact `grype db status -o json` output from grype 0.121.0 (v6 schema), recorded for v0.3.147.
const DB_STATUS = {
  schemaVersion: 'v6.1.10',
  from: 'https://grype.anchore.io/databases/v6/vulnerability-db_v6.1.10_2026-11-24T00:23:39Z_1795587741.tar.zst?checksum=sha256%3A8a5df903f7a5362233738dbf4f4b1066e6b121e4da881e596f2fc7ec81fdd3aa',
  built: '2026-11-25T06:22:21Z',
  path: '/home/runner/.cache/grype/db/6/vulnerability.db',
  valid: true,
};

test('reads the database build time from grype db status', () => {
  assert.equal(dbBuiltAt(DB_STATUS), '2026-11-25T06:22:21Z');
  assert.equal(dbBuiltAt(JSON.stringify(DB_STATUS)), '2026-11-25T06:22:21Z');
  assert.equal(dbBuiltAt({ status: { built: '2026-01-02T03:04:05.000Z' } }), '2026-01-02T03:04:05Z');
  const { built, ...unbuilt } = DB_STATUS;
  assert.equal(dbBuiltAt(unbuilt), '2026-11-24T00:23:39Z', 'falls back to the archive timestamp');
  assert.equal(dbBuiltAt({ built: 'not a date' }), undefined);
  for (const empty of [undefined, null, '', 'not json', '{}', 42]) assert.equal(dbBuiltAt(empty), undefined);
});

const match = (id, severity, name, version) => ({ vulnerability: { id, severity, fix: { versions: [] } }, artifact: { name, version } });

test('lists Critical and High advisories once, sorted, in JSON and Markdown', () => {
  const report = { matches: [
    match('GHSA-q7v9-x93c-xqv3', 'High', 'zip', '2.4.2'),
    match('GHSA-low', 'Medium', 'zip', '2.4.2'),
    match('GHSA-m665-v7pm-7grj', 'Critical', 'zip', '2.4.2'),
    match('GHSA-q7v9-x93c-xqv3', 'High', 'zip', '2.4.2'),
    match('GHSA-mrhx-c7xc-m3w5', 'High', 'zod', '3.25.76'),
    match('GHSA-86w9-cpqp-85rv', 'High', 'node-forge', '1.4.0'),
    match('GHSA-5x38-2vff-x55p', 'High', 'node-forge', '1.4.0'),
    { vulnerability: { severity: 'High' } },
  ] };
  const scan = scanStatus({ status: 'ok' }, { report });
  assert.equal(scan.severities.Critical, 1);
  assert.deepEqual(scan.advisories, [
    { id: 'GHSA-m665-v7pm-7grj', severity: 'Critical', package: 'zip', version: '2.4.2' },
    { id: 'GHSA-5x38-2vff-x55p', severity: 'High', package: 'node-forge', version: '1.4.0' },
    { id: 'GHSA-86w9-cpqp-85rv', severity: 'High', package: 'node-forge', version: '1.4.0' },
    { id: 'GHSA-q7v9-x93c-xqv3', severity: 'High', package: 'zip', version: '2.4.2' },
    { id: 'GHSA-mrhx-c7xc-m3w5', severity: 'High', package: 'zod', version: '3.25.76' },
  ]);
  assert.deepEqual(advisories(undefined), []);
  assert.deepEqual(scanStatus({ status: 'ok' }, { report: { matches: [match('x', 'Low', 'a', '1')] } }).advisories, []);

  const entry = { name: 'pandacode-npm', kind: 'npm lockfile', platform: 'all', inventory: { status: 'ok', components: 9 }, scan };
  const clean = { ...entry, name: 'pandacode-rust', scan: scanStatus({ status: 'ok' }, { report: {} }) };
  const base = { version: '1.2.3', commit: 'abc', scanners: { syft: '1', grype: '2' }, dbBuilt: dbBuiltAt(DB_STATUS), notes: ['n'] };
  const built = coverage({ ...base, entries: [entry, clean] });
  assert.deepEqual(JSON.parse(JSON.stringify(built)).entries[0].scan.advisories, scan.advisories);
  const md = markdown(built);
  assert.match(md, /Vulnerability database built: 2026-11-25T06:22:21Z\./);
  assert.match(md, /## Critical and High advisories\n\n- `pandacode-npm`: \*\*Critical\*\* `zip` 2\.4\.2: GHSA-m665-v7pm-7grj; \*\*High\*\* `node-forge` 1\.4\.0: GHSA-5x38-2vff-x55p, GHSA-86w9-cpqp-85rv; \*\*High\*\* `zip` 2\.4\.2: GHSA-q7v9-x93c-xqv3; \*\*High\*\* `zod` 3\.25\.76: GHSA-mrhx-c7xc-m3w5\n\n## Limits/);
  assert.doesNotMatch(md, /`pandacode-rust`:/);
  assert.doesNotMatch(markdown(coverage({ ...base, entries: [clean] })), /Critical and High advisories/);
});

test('a duplicate advisory keeps its highest severity regardless of order', () => {
  const critical = match('GHSA-dup', 'Critical', 'zip', '2.4.2');
  const high = match('GHSA-dup', 'High', 'zip', '2.4.2');
  const expected = [{ id: 'GHSA-dup', severity: 'Critical', package: 'zip', version: '2.4.2' }];
  assert.deepEqual(advisories([critical, high]), expected);
  assert.deepEqual(advisories([high, critical]), expected);
});

test('the npm inventory excludes the mobile app and other unshipped code, and the notes say so', () => {
  assert.deepEqual(NPM_EXCLUDES, ['./mobile/**', './website/**', './packages/**', './relay/**', './node_modules/**']);
  assert.ok(NOTES.includes('The mobile app, the website, the relay and the npx package are not shipped in the desktop app and are excluded.'));
});

test('a missing database build time is reported as unknown with a warning', async () => {
  const base = { version: '1.2.3', commit: 'abc', scanners: { syft: '1', grype: '2' }, entries: [], notes: ['n'] };
  assert.equal(coverage(base).vulnerabilityDbBuilt, 'unknown');
  assert.match(markdown(coverage(base)), /Vulnerability database built: unknown\./);
  const source = await readFile(new URL('./sbom.mjs', import.meta.url), 'utf8');
  assert.match(source, /if \(!dbBuilt\) console\.log\('::warning::Could not determine grype vulnerability database build time; reporting "unknown"\.'\);/);
});
