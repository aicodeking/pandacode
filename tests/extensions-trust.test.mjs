import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/project-summary/extension.json', import.meta.url), 'utf8'));

test('extensions trust: executable command descriptor survives shared normalization', () => {
  const checked = validateContract('packages', [manifest]);
  assert.equal(checked.ok, true, JSON.stringify(checked));
  assert.deepEqual(checked.value.packages[0].runtime, manifest.runtime);
});
test('extensions trust: activation must name an owned executable command, never startup or a path escape', () => {
  for (const mutate of [
    m => { m.runtime.activationEvents = ['startup']; },
    m => { m.runtime.activationEvents = ['panda.core/secret']; },
    m => { m.runtime.entrypoint = '../main.cjs'; },
    m => { delete m.runtime; },
  ]) {
    const changed = structuredClone(manifest); mutate(changed);
    assert.equal(validateContract('packages', [changed]).ok, false);
  }
});
