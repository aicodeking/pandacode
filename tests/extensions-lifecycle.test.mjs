import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const packageOf = (value = manifest) => ({ manifest: structuredClone(value), enabled: true, icons: {} });
const snapshot = packages => ({ safeMode: false, packages, diagnostics: [] });
const context = surfaceId => ({ schemaVersion: 1, windowId: 'main', surfaceId, revision: 1, projectId: 'project-a' });

test('extensions lifecycle: two surfaces use exactly one command through repeated restart/re-enable', () => {
  assert.equal(manifest.contributes.commands.length, 1);
  let previous;
  for (let generation = 0; generation < 5; generation++) {
    previous?.dispose();
    const activation = createDeclarativeActivation(snapshot([packageOf()]), generation);
    assert.equal(activation.entries.length, 2);
    assert.equal(new Set(activation.entries.map(entry => entry.menu.id)).size, 2);
    for (const entry of activation.entries) {
      assert.equal(entry.command.id, manifest.contributes.commands[0].id);
      assert.equal(activation.invoke(entry.menu.id, context(entry.menu.location)), 'Extension installed successfully');
      assert.equal(previous?.invoke(entry.menu.id, context(entry.menu.location)), undefined);
    }
    previous = activation;
  }
});

test('extensions lifecycle: owner removal retains other registrations and recovery ignores malformed manifests', () => {
  const other = JSON.parse(JSON.stringify(manifest).replaceAll('sample.project-helper', 'other.project-helper'));
  const removed = packageOf(); removed.enabled = false;
  const activation = createDeclarativeActivation(snapshot([removed, packageOf(other)]), 1);
  assert.equal(activation.entries.length, 2);
  assert.ok(activation.entries.every(entry => entry.owner.extensionId === other.id));
  const corrupt = { safeMode: true, packages: [{ enabled: true, manifest: null }], diagnostics: [] };
  assert.deepEqual(createDeclarativeActivation(corrupt, 2).entries, []);
});
