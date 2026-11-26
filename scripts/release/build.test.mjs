import assert from 'node:assert/strict';
import test from 'node:test';
import { macosSigning } from './build.mjs';

test('official macOS builds require a Developer ID signing identity', () => {
  for (const required of ['1', 'true']) {
    for (const identity of [undefined, '   ', '-']) {
      assert.throws(() => macosSigning({
        PANDACODE_REQUIRE_APPLE_SIGNING: required,
        APPLE_SIGNING_IDENTITY: identity,
      }), /official macOS builds require APPLE_SIGNING_IDENTITY.*notarization credentials/i);
    }
  }
});

test('official macOS builds require notarization credentials for Developer ID', () => {
  const identity = 'Developer ID Application: Example (TEAMID)';
  const env = { PANDACODE_REQUIRE_APPLE_SIGNING: '1', APPLE_SIGNING_IDENTITY: identity };
  assert.throws(() => macosSigning(env), /must be notarized/);
  assert.deepEqual(macosSigning({
    ...env,
    APPLE_API_KEY: 'KEYID',
    APPLE_API_ISSUER: 'issuer',
    APPLE_API_KEY_PATH: '/example/AuthKey_KEYID.p8',
  }), { mode: 'developer-id', identity });
});

test('local and fork macOS builds default to ad-hoc signing', () => {
  const adhoc = { mode: 'adhoc', identity: '-' };
  assert.deepEqual(macosSigning({}), adhoc);
  assert.deepEqual(macosSigning({ APPLE_SIGNING_IDENTITY: '-' }), adhoc);
  assert.deepEqual(macosSigning({ PANDACODE_REQUIRE_APPLE_SIGNING: 'false' }), adhoc);
});
