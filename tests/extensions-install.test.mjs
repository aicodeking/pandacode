import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
const sample = JSON.parse(readFileSync(new URL('./fixtures/extensions/sample-project-helper/extension.json', import.meta.url), 'utf8'));
const snapshot = (enabled = true) => ({ safeMode: false, packages: [{ manifest: structuredClone(sample), enabled, icons: { 'sample.project-helper/info': '<svg/>' } }], diagnostics: [] });
const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', projectId: 'project-a', sessionId: 'session-a', revision: 1 };
test('extensions install: empty, installed-disabled and safe-mode have no registrations', () => {
  for (const value of [{ safeMode: false, packages: [], diagnostics: [] }, snapshot(false), { ...snapshot(), safeMode: true }]) {
    const activation = createDeclarativeActivation(value, 1);
    assert.deepEqual(activation.entries, []); assert.equal(activation.invoke('sample.project-helper/header', context), undefined);
  }
});
test('extensions install: owner-scoped activation copies data and disposal revokes old controls', () => {
  const value = snapshot(), activation = createDeclarativeActivation(value, 7);
  assert.deepEqual(activation.entries[0].owner, { extensionId: sample.id, version: sample.version, activationId: 7 });
  value.packages[0].manifest.contributes.commands[0].action.message = 'mutated';
  activation.entries[0].command.action.message = 'forged';
  assert.equal(activation.invoke('sample.project-helper/header', context), 'Extension installed successfully');
  assert.equal(activation.invoke('sample.project-helper/header', { ...context, surfaceId: 'panda.sidebar.footer' }), undefined);
  assert.equal(activation.invoke('sample.project-helper/header', { ...context, windowId: 'tray' }), undefined);
  activation.dispose(); activation.dispose();
  assert.equal(activation.invoke('sample.project-helper/header', context), undefined);
});
test('extensions install: conflict fails atomically and declarative conditions do not grant execution', () => {
  const duplicate = snapshot(); duplicate.packages.push(structuredClone(duplicate.packages[0]));
  assert.throws(() => createDeclarativeActivation(duplicate, 1), /DuplicateId/);
  const conditional = snapshot(); conditional.packages[0].manifest.contributes.menus[0].enabled = { op: 'eq', key: 'projectId', value: 'project-a' };
  const activation = createDeclarativeActivation(conditional, 2);
  assert.equal(activation.invoke('sample.project-helper/header', context), 'Extension installed successfully');
  assert.equal(activation.invoke('sample.project-helper/header', { ...context, projectId: 'project-b' }), undefined);
  assert.deepEqual(context.projectId, 'project-a');
});

test('extensions install: CI runs baseline, lifecycle, catalog, layout, menus and dialogs in both preview engines', () => {
  const workflow = readFileSync(new URL('../.github/workflows/ci.yml', import.meta.url), 'utf8');
  assert.match(workflow, /npx playwright install --with-deps chromium webkit/);
  for (const command of [
    'npx playwright test tests/extensions-baseline.spec.ts tests/extensions-install.spec.ts tests/extensions-catalog.spec.ts tests/extensions-layout.spec.ts tests/extensions-menus.spec.ts tests/extensions-dialogs.spec.ts --workers=1',
    'npx playwright test -c playwright.webkit.config.ts tests/extensions-baseline.spec.ts tests/extensions-install.spec.ts tests/extensions-catalog.spec.ts tests/extensions-layout.spec.ts tests/extensions-menus.spec.ts tests/extensions-dialogs.spec.ts --workers=1',
  ]) assert.ok(workflow.includes(`run: ${command}`), command);
  assert.match(workflow, /PANDACODE_TEST_CHROME=/);
  assert.match(workflow, /BASELINE_REVISION=\$GITHUB_SHA/);
});
