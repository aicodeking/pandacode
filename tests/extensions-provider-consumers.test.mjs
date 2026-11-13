import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { packageHarnesses } from '../src/extensions/harnesses.ts';
import { setPackageProviders } from '../src/extensions/provider-state.ts';
import { modelChoices, advertisedModelsOnly } from '../src/model-catalog.ts';
import { approvalModes } from '../src/approval-modes.ts';
import { validateContract } from '../src/extensions/contracts.ts';

const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
const snapshot = () => ({ safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, executable: { trusted: true }, icons: {} }] });
test('extensions provider consumers: registry metadata and recovery, without built-in impersonation', () => {
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const state = snapshot();
  const [provider] = packageHarnesses(state);
  setPackageProviders([provider]);
  assert.equal(provider.metadata.icon, 'sample.fake-harness/mark');
  assert.match(provider.metadata.authentication, /no sign-in/);
  assert.equal(provider.metadata.usage.context, true);
  assert.equal(provider.models[0].reasoningEfforts[1].id, 'medium');
  assert.deepEqual(modelChoices(provider.id, provider.models).map(model => model.id), ['recorded-model']);
  assert.equal(advertisedModelsOnly(provider.id), true);
  assert.deepEqual(approvalModes(provider.id).map(mode => mode.id), ['ask', 'plan']);
  assert.equal(approvalModes(provider.id, 'full').at(-1).disabled, true);
  state.packages[0].manifest.contributes.providers[0].metadata.readiness = { state: 'signedOut', reason: 'Sign in using the extension.' };
  assert.equal(packageHarnesses(state)[0].installed, false);
  state.packages[0].enabled = false;
  setPackageProviders(packageHarnesses(state));
  assert.match(approvalModes(provider.id, 'plan')[0].description, /Enable or reinstall/);
  assert.equal(approvalModes(provider.id, 'plan')[0].disabled, true);
  state.packages[0].enabled = true;
  state.packages[0].executable.trusted = false;
  assert.deepEqual(packageHarnesses(state), []);
  state.safeMode = true;
  assert.deepEqual(packageHarnesses(state), []);
});
test('extensions provider consumers: malformed, duplicate or foreign metadata is rejected', () => {
  for (const mutate of [
    metadata => { metadata.modes = ['ask', 'ask']; },
    metadata => { metadata.modes = ['review']; },
    metadata => { metadata.icon = 'another.package/mark'; },
    metadata => { metadata.readiness = { state: 'unknown', reason: '' }; },
    metadata => { metadata.usage.limitsReason = ''; },
  ]) {
    const invalid = structuredClone(manifest);
    mutate(invalid.contributes.providers[0].metadata);
    assert.equal(validateContract('packages', [invalid]).ok, false);
  }
});
test('extensions provider consumers: zero-extension legacy models and native policies remain unchanged', () => {
  setPackageProviders([]);
  assert.equal(modelChoices('glm', [])[0].name, 'GLM-5.3');
  assert.equal(modelChoices('mimo', [])[0].name, 'MiMo-V2.6-Pro');
  assert.equal(modelChoices('claude', [], 'sonnet')[1].name, 'Claude Sonnet');
  assert.equal(advertisedModelsOnly('claude'), false);
  assert.equal(advertisedModelsOnly('devin'), true);
  assert.equal(approvalModes('codex').find(mode => mode.id === 'auto').label, 'Approve for me');
  assert.equal(approvalModes('claude').find(mode => mode.id === 'review').disabled, undefined);
  assert.equal(approvalModes('devin').some(mode => mode.id === 'auto'), false);
});
