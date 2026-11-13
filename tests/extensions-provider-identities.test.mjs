import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { parseProviderId, providerOwner, BUILTIN_PROVIDER_IDS } from '../src/extensions/provider-identity.ts';
const fixture = JSON.parse(readFileSync('tests/fixtures/extensions/provider-identities.json', 'utf8'));
test('extensions providers: validated identities preserve legacy IDs and reject arbitrary/reserved names', () => {
  for (const id of [...BUILTIN_PROVIDER_IDS, ...fixture.valid]) assert.equal(parseProviderId(id), id);
  for (const id of [...fixture.invalid, null, {}, 42, `sample.harness/${'a'.repeat(200)}`]) assert.equal(parseProviderId(id), undefined);
  assert.equal(providerOwner('sample.harness/agent'), 'sample.harness');
  assert.equal(providerOwner('claude'), undefined);
  assert.equal(providerOwner('panda.harness/agent'), undefined);
});
test('extensions providers: explicit browser and CI registration', () => {
  for (const file of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) assert.match(readFileSync(file, 'utf8'), /extensions-provider-history[.]spec[.]ts/);
});
