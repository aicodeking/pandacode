import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { remoteProviderPlacement, REMOTE_UNSUPPORTED, REMOTE_MISSING } from '../src/extensions/remote-placement.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { packageHarnesses } from '../src/extensions/harnesses.ts';
const cases = JSON.parse(readFileSync('tests/fixtures/extensions/remote-peers.json', 'utf8'));
const manifest = JSON.parse(readFileSync('tests/fixtures/extensions/fake-harness/extension.json', 'utf8'));
test('remote extensions: shared native/preview old/new peer matrix fails closed', () => {
  for (const entry of cases) assert.equal(remoteProviderPlacement(entry.peer, 'host-a', 'sample.fake-harness/recorded') === null, entry.supported, entry.name);
  assert.match(REMOTE_UNSUPPORTED, /History and core commands remain available/);
  assert.match(REMOTE_MISSING, /No package or credentials are copied/);
});
test('remote extensions: workspace and split are explicit; UI-only packages never supply workspace providers', () => {
  for (const kind of ['workspace', 'split', 'ui']) {
    const candidate = { ...manifest, extensionKind: kind };
    assert.equal(validateContract('packages', [candidate]).ok, true);
    const snapshot = { safeMode: false, packages: [{ manifest: candidate, enabled: true, executable: { trusted: true }, icons: {} }] };
    assert.equal(packageHarnesses(snapshot, 'workspace').length, kind === 'ui' ? 0 : 1);
    assert.equal(packageHarnesses(snapshot).length, 1, 'legacy UI providers remain usable locally');
    snapshot.packages[0].executable.trusted = false;
    assert.deepEqual(packageHarnesses(snapshot), []);
  }
});
test('remote extensions: reconnect rechecks peer authority instead of carrying forward positive negotiation', () => {
  const peer = structuredClone(cases[1].peer);
  assert.equal(remoteProviderPlacement(peer, 'host-a', 'sample.fake-harness/recorded'), null);
  peer.providers = [];
  assert.equal(remoteProviderPlacement(peer, 'host-a', 'sample.fake-harness/recorded'), REMOTE_MISSING);
  assert.equal(remoteProviderPlacement(cases[1].peer, 'host-b', 'sample.fake-harness/recorded'), REMOTE_UNSUPPORTED);
});
test('remote extensions: both explicit browser runners and CI retain compatibility coverage', () => {
  for (const file of ['playwright.config.ts', 'playwright.webkit.config.ts', '.github/workflows/ci.yml']) {
    assert.match(readFileSync(file, 'utf8'), /extensions-remote\.spec\.ts/, file);
  }
  assert.match(readFileSync('playwright.webkit.config.ts', 'utf8'), /extensions remote/);
});
