import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createServicesPreview } from '../src/extensions/services-preview.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
const provider = JSON.parse(readFileSync('examples/extensions/service-provider/package/extension.json', 'utf8'));
const consumer = JSON.parse(readFileSync('examples/extensions/service-consumer/package/extension.json', 'utf8'));
const request = { op: 'start', service: 'sample.service-provider/greeting', version: '1.0.0', method: 'hello', input: 'PandaCode' };
const snapshot = () => ({ safeMode: false, packages: [provider, consumer].map(manifest => ({ manifest, enabled: true, icons: {}, executable: { digest: 'synthetic', trusted: true } })) });
const binding = { owner: consumer.id, version: '1.0.0', context: { projectId: 'A' } };
test('extensions services: explicit installable export schemas, duplicate method and dependency validation', () => {
  assert.equal(validateContract('packages', [provider, consumer]).ok, true);
  const duplicate = structuredClone(provider); duplicate.contributes.services[0].methods.push(duplicate.contributes.services[0].methods[0]);
  assert.equal(validateContract('packages', [duplicate, consumer]).error.code, 'DuplicateId');
  const cycle = structuredClone(provider); cycle.dependencies = { [consumer.id]: '^1.0.0' };
  assert.equal(validateContract('packages', [cycle, consumer]).error.code, 'DependencyCycle');
});
test('extensions services: E23 wrong version/private/schema/forged identity and grant denials leave public service usable', () => {
  const broker = createServicesPreview(), state = snapshot();
  const call = request => broker.call(state, binding, 'captured-A', request);
  assert.throws(() => call(request), /PermissionDenied/);
  call({ op: 'grant', service: request.service, allow: true });
  for (const [patch, error] of [[{ version: '2.0.0' }, 'IncompatibleApi'], [{ method: 'privateMethod' }, 'PermissionDenied'], [{ input: 42 }, 'InvalidShape'], [{ consumer: 'panda.core' }, 'InvalidShape']]) assert.throws(() => call({ ...request, ...patch }), new RegExp(error));
  const started = call(request);
  const result = call({ op: 'poll', request: started.request });
  assert.equal(result.output, 'Hello PandaCode'); assert.equal(result.events[0].value, 'Consumer sample.service-consumer; project A');
  assert.deepEqual(call({ op: 'poll', request: started.request }).events, []);
  assert.throws(() => broker.call(state, binding, 'new-activation', { op: 'poll', request: started.request }), /PermissionDenied/);
  broker.stop(provider.id); assert.throws(() => call({ op: 'poll', request: started.request }), /Cancelled/);
  assert.throws(() => call(request), /PermissionDenied/);
  call({ op: 'grant', service: request.service, allow: true }); state.packages[0].enabled = false; assert.throws(() => call(request), /NotFound/);
});
test('extensions services: explicit browser runner and CI registration', () => {
  for (const file of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) assert.match(readFileSync(file, 'utf8'), /extensions-services[.]spec[.]ts/);
});
test('extensions services: missing provider or cyclic dependency blocks only affected presentation owners', () => {
  const unrelated = structuredClone(provider); unrelated.id = 'other.operational'; unrelated.contributes.services = [];
  unrelated.contributes.commands[0].id = 'other.operational/info'; unrelated.runtime.activationEvents = ['other.operational/info'];
  for (const cycle of [false, true]) {
    const state = snapshot(); state.packages.push({ manifest: unrelated, enabled: true, icons: {} });
    if (cycle) state.packages[0].manifest = { ...provider, dependencies: { [consumer.id]: '^1.0.0' } }; else state.packages[0].enabled = false;
    const activation = createDeclarativeActivation(state, 1);
    assert.deepEqual(activation.commands.map(item => item.owner.extensionId), ['other.operational']); activation.dispose();
  }
});
