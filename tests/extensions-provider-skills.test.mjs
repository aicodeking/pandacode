import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { packageHarnesses } from '../src/extensions/harnesses.ts';
import { packageDiscoveryHarnesses, INSTALL_UNSUPPORTED } from '../src/extensions/provider-discovery.ts';
import { setPackageProviders } from '../src/extensions/provider-state.ts';
import { harnessName, installTargets } from '../src/skill-manager-model.ts';
import { createPreviewSkillManager, MATRIX } from '../src/preview-skill-manager.ts';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';
import { createContextClient } from '../src/extensions/context-state.ts';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
const id = manifest.contributes.providers[0].id;
const snapshot = () => ({ safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {}, executable: { trusted: true } }] });
test('extensions skills: dynamic discovery matrix preserves built-ins and explains unsupported writes', async () => {
  const state = snapshot();
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const dynamic = () => packageDiscoveryHarnesses(state);
  setPackageProviders(packageHarnesses(state));
  assert.equal(harnessName(id), 'Recorded harness');
  const manager = createPreviewSkillManager({ dynamicHarnesses: dynamic });
  const inventory = manager.list({});
  const row = inventory.harnesses.find(row => row.id === id);
  assert.equal(row.discovery.length, 4);
  assert.equal(row.enforcement, 'asked'); assert.equal(row.consoleEnforcement, 'none');
  assert.equal(row.installable, false); assert.equal(row.syncable, false);
  assert.match(row.syncReason, /never writes/);
  assert.equal(row.installReason, INSTALL_UNSUPPORTED);
  assert.ok(!installTargets(inventory.harnesses).some(row => row.id === id));
  await assert.rejects(manager.add({ source: 'owner/repo', skills: ['example'], harnesses: [id] }), /UnsupportedCapability/);
  assert.deepEqual(MATRIX, JSON.parse(readFileSync('tests/fixtures/skill-matrix.json', 'utf8')));
  assert.equal(MATRIX.claude.enforcement, 'blocked');
  state.packages[0].enabled = false;
  assert.ok(!manager.list({}).harnesses.some(row => row.id === id));
  state.packages[0].enabled = true; state.packages[0].executable.trusted = false;
  assert.deepEqual(dynamic(), []);
  state.packages[0].executable.trusted = true; state.safeMode = true;
  assert.deepEqual(dynamic(), []); setPackageProviders([]);
});
test('extensions skills: discovery rejects arbitrary, auth/config, foreign, duplicate and expanded roots', () => {
  for (const path of ['/etc/passwd', 'C:/auth.json', '.claude/auth.json', '../config.json', '.panda-harnesses/other.package/recorded/settings.json', '.panda-harnesses/sample.fake-harness/recorded/auth.json', '$HOME/.codex/config.toml', '.panda-harnesses/sample.fake-harness/recorded/skills/../settings.json']) {
    const invalid = structuredClone(manifest); invalid.contributes.providers[0].discovery[0].path = path;
    assert.equal(validateContract('packages', [invalid]).ok, false, path);
  }
  const invalid = structuredClone(manifest); invalid.contributes.providers[0].discovery.push(invalid.contributes.providers[0].discovery[0]);
  assert.equal(validateContract('packages', [invalid]).ok, false);
});
test('extensions skills: metadata public grants cannot read declared config or arbitrary auth files', async () => {
  const reader = JSON.parse(readFileSync('tests/fixtures/extensions/project-reads/extension.json', 'utf8'));
  const state = { safeMode: false, packages: [{ manifest: reader, enabled: true, icons: {} }] };
  const broker = createPreviewContextBroker();
  const data = { projects: [{ id: 'A', name: 'Alpha', path: '/synthetic/A' }], tasks: [], files: { A: {} } };
  const client = createContextClient('sample.project-reads/header', '1.0.0', { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId: 'A' }, async request => broker(request, state, data));
  for (const path of ['auth.json', '.codex/config.toml', manifest.contributes.providers[0].discovery[3].path]) {
    assert.equal((await client.readConsent('projects.files.metadata', path, true)).ok, false, path);
    assert.equal((await client.read('metadata', path)).ok, false, path);
  }
  client.dispose();
});
