import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { validateContract, MANIFEST_CONTRIBUTIONS } from '../src/extensions/contracts';
import { BUILT_INS, report } from '../src/extensions/runtime-harness-coverage';
import { checkCompanionDeclarations, companionCoverage, COMPANION_HARNESSES, packageCompanions, packageInline } from '../src/extensions/runtime-package-companions';
import { KILO_SOURCE } from '../src/extensions/runtime-kilo-companion';
const fixture = new URL('./fixtures/extensions/runtime-package-companions/', import.meta.url);
const installed = { harness: 'opencode', version: 'v1.19.5', apis: ['opencode.plugin.v1'] };
const manifest = async () => JSON.parse(await readFile(new URL('extension.json', fixture), 'utf8'));
test('extensions package companions: canonical validator, package attribution and authority withdrawal', async () => {
  const value = await manifest();
  expect(MANIFEST_CONTRIBUTIONS).toContain('companions');
  expect(validateContract('packageFiles', [value]).ok).toBe(true);
  const snapshot = { safeMode: false, packages: [{ manifest: value, enabled: true, executable: { trusted: true }, projects: ['A'] }] };
  const list = () => packageCompanions(snapshot, 'A', installed, () => true);
  expect(list()).toMatchObject([{ owner: value.id, packageName: value.name, code: null, qualification: 'sourceFeasible', modelRequest: 'notReported', compaction: 'notReported' }]);
  expect(packageCompanions(snapshot, 'B', installed, () => true)).toEqual([]);
  expect(packageCompanions(snapshot, 'A', installed, () => false)).toEqual([]);
  expect(packageCompanions(snapshot, 'A', { ...installed, harness: 'kilo' }, () => true)).toEqual([]);
  expect(packageCompanions(snapshot, 'A', { ...installed, version: 'unknown' }, () => true)[0].code).toBe('UnsupportedCapability');
  snapshot.packages[0].enabled = false; expect(list()).toEqual([]);
  snapshot.packages[0].enabled = true; snapshot.packages[0].executable.trusted = false; expect(list()).toEqual([]);
  snapshot.packages[0].executable.trusted = true; snapshot.safeMode = true; expect(list()).toEqual([]);
  for (const file of ['../module.mjs', 'companions/../module.mjs', 'undeclared/module.mjs', 'companions\\module.mjs']) {
    const bad = structuredClone(value); bad.contributes.companions[0].file = file; expect(checkCompanionDeclarations(bad).ok).toBe(false);
  }
  const noGrant = structuredClone(value); noGrant.permissions = []; expect(validateContract('packageFiles', [noGrant]).ok).toBe(false);
  const missingFolder = structuredClone(value); delete missingFolder.runtime; expect(validateContract('packageFiles', [missingFolder]).ok).toBe(false);
});
test('extensions package companions: synthetic loader consumes declared local V1 entry only', async () => {
  const value = await manifest(); const file = new URL(value.contributes.companions[0].file, fixture).href;
  const previous = '{"model":"preserved","plugin":["existing"]}';
  const env = packageInline(installed, file, previous); const config = JSON.parse(env.OPENCODE_CONFIG_CONTENT);
  expect(config.plugin).toEqual(['existing', file]); expect(config.model).toBe('preserved'); expect(previous).toBe('{"model":"preserved","plugin":["existing"]}');
  const entry = await import(config.plugin[1]); const hooks = await entry.default({});
  const args = { input: 'fixture' }; const output = { args }; await hooks['tool.execute.before']({}, output); expect(output.args).toBe(args); expect(args).toMatchObject({ fixtureCompanion: true });
  const result = { output: 'before' }; await hooks['tool.execute.after']({}, result); expect(result.output).toBe('fixture package result');
  expect(() => packageInline(installed, file, '{}', true)).toThrow();
  expect(() => packageInline({ ...installed, version: 'future' }, file)).toThrow();
  expect(() => packageInline({ harness: 'kilo', version: KILO_SOURCE, apis: ['kilo.plugin.v1'] }, file, '{"plugins":[]}')).toThrow();
});
test('extensions package companions: every audit harness has explicit evidence accounting', async () => {
  expect([...COMPANION_HARNESSES].sort()).toEqual(BUILT_INS.map(([id]) => id).sort());
  const coverage = BUILT_INS.map(([id]) => companionCoverage(id));
  for (const row of coverage) {
    expect(row.adapter || row.reason).toBeTruthy(); expect(row.installed).toBe('not authorized or qualified');
    expect(row.code).toBe('UnsupportedCapability'); expect(row.modelRequest).toBe('notReported'); expect(row.compaction).toBe('notReported');
  }
  const actual = report(BUILT_INS.map(([id, name]) => ({ id, name, package: null, installed: 'Unknown' as const })), null, null);
  expect(actual.companionCoverage).toEqual(coverage);
  const evidence = JSON.parse(await readFile(new URL('evidence.json', fixture), 'utf8')); expect(evidence.liveCapture).toBe(false); expect(evidence.recordedCompanionFrames).toBe('none');
});
