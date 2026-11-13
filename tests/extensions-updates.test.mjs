import test from 'node:test';
import assert from 'node:assert/strict';
import { createUpdatePreview } from '../src/extensions/updates-preview.ts';
const fixture = () => [{ manifest: { id: 'sample.helper', version: '1.0.0', permissions: ['ui.contribute'], contributes: {} }, enabled: true, icons: {}, executable: { digest: 'old', trusted: true } }];
test('updates recording preserves an explicit disable while an approved update drains', () => {
  const updates = createUpdatePreview(), packages = fixture();
  updates.pin(packages, 'sample.helper'); updates.stage(packages, 'sample.helper');
  updates.review(packages, 'sample.helper', packages[0].update.digest);
  packages[0].enabled = false;
  updates.release(packages, 'sample.helper');
  assert.equal(packages[0].manifest.version, '1.1.0');
  assert.equal(packages[0].enabled, false, 'staged enable preference must not undo later disable');
});
test('updates recording stages permission/content review and pins until the final provider lease', () => {
  const updates = createUpdatePreview(), packages = fixture();
  updates.pin(packages, 'sample.helper'); updates.pin(packages, 'sample.helper');
  updates.stage(packages, 'sample.helper');
  assert.equal(packages[0].manifest.version, '1.0.0'); assert.deepEqual(packages[0].update.addedPermissions, ['tasks.summary']);
  assert.throws(() => updates.review(packages, 'sample.helper', 'stale'), /StaleContext/);
  updates.review(packages, 'sample.helper', packages[0].update.digest);
  assert.throws(() => updates.pin(packages, 'sample.helper'), /StaleContext/);
  updates.release(packages, 'sample.helper'); assert.equal(packages[0].manifest.version, '1.0.0');
  updates.release(packages, 'sample.helper'); assert.equal(packages[0].manifest.version, '1.1.0'); assert.equal(packages[0].executable.trusted, true);
  updates.rollback(packages, 'sample.helper'); assert.equal(packages[0].manifest.version, '1.0.0'); assert.equal(packages[0].executable.digest, 'old');
});
test('updates recording defers uninstall and discards refused candidates without changing selected package', () => {
  const updates = createUpdatePreview(), packages = fixture();
  updates.stage(packages, 'sample.helper'); updates.rollback(packages, 'sample.helper'); assert.equal(packages[0].manifest.version, '1.0.0');
  updates.pin(packages, 'sample.helper'); assert.equal(updates.uninstall(packages, 'sample.helper'), true);
  assert.equal(packages.length, 1); assert.equal(packages[0].update.draining, true);
  assert.throws(() => updates.rollback(packages, 'sample.helper'), /pinned/);
  updates.release(packages, 'sample.helper'); assert.equal(packages.length, 0);
});
