import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { coverage, inventoryStatus, markdown, packagedAssets, platformOf, scanStatus } from './sbom.mjs';

const workflow = await readFile(new URL('../../.github/workflows/release.yml', import.meta.url), 'utf8');
const sbomJob = workflow.split('\n  sbom:\n')[1].split('\n  publish:\n')[0];

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
  const summary = sbomJob.split('      - name: Show coverage\n')[1].split('      - uses:')[0];
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
