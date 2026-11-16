import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, existsSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createContextClient } from '../src/extensions/context-state.ts';
import { createPreviewContextBroker } from '../src/extensions/context-preview.ts';

// Project scope of enablement (T60 use case 2). Native tests own persistence and admission
// (src-tauri/src/extensions/{updates,context,services,windows}.rs); these check the shared contract,
// the preview counterpart, the ledger closure and the documentation.
const read = path => readFileSync(new URL(path, import.meta.url), 'utf8');
const ledger = JSON.parse(read('./fixtures/extensions/surfaces.json'));
const manifest = JSON.parse(read('./fixtures/extensions/project-context/extension.json'));
const scopeRefusal = { ok: false, error: { schemaVersion: 1, code: 'PermissionDenied', path: '$.projectScope', ids: [] } };

test('extensions project scope: the shared projectScope contract accepts all or 1..64 distinct projects', () => {
  assert.equal(validateContract('projectScope', { schemaVersion: 1, mode: 'all' }).ok, true);
  assert.deepEqual(validateContract('projectScope', { schemaVersion: 1, mode: 'selected', projects: ['A', 'B'] }).value, { schemaVersion: 1, mode: 'selected', projects: ['A', 'B'] });
  for (const invalid of [{ schemaVersion: 1, mode: 'selected', projects: [] }, { schemaVersion: 1, mode: 'all', projects: ['A'] }, { schemaVersion: 1, mode: 'selected' }, { schemaVersion: 2, mode: 'all' }, { schemaVersion: 1, mode: 'some', projects: ['A'] }, { schemaVersion: 1, mode: 'selected', projects: [''] }, { schemaVersion: 1, mode: 'selected', projects: Array.from({ length: 65 }, (_, i) => `p${i}`) }, { schemaVersion: 1, mode: 'selected', projects: ['x'.repeat(257)] }]) {
    assert.equal(validateContract('projectScope', invalid).ok, false, JSON.stringify(invalid).slice(0, 80));
  }
  assert.deepEqual(validateContract('projectScope', { schemaVersion: 1, mode: 'selected', projects: ['A', 'A'] }).error, { schemaVersion: 1, code: 'DuplicateId', path: '$/projects', ids: ['A'] });
  const schema = JSON.parse(read('../src/extensions/schema-v1.json'));
  assert.ok(schema.$defs.projectScope, 'schema-v1.json defines projectScope');
  assert.match(read('../src/extensions/sdk/index.d.ts'), /export type ProjectScope = /);
  assert.match(read('../src-tauri/src/extensions/contracts.rs'), /"projectScope"\]\.contains\(&kind\)/);
});

test('extensions project scope: the preview broker mirrors native admission and keeps a captured project', async () => {
  const broker = createPreviewContextBroker();
  const state = { safeMode: false, packages: [{ manifest: structuredClone(manifest), enabled: true, icons: {} }], diagnostics: [] };
  const data = { projects: [{ id: 'A', name: 'Alpha' }, { id: 'B', name: 'Beta' }], tasks: [] };
  const transport = async request => broker(request, state, data);
  const context = project => ({ schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, ...(project ? { projectId: project } : {}) });
  // All projects: unchanged.
  for (const project of ['A', 'B', undefined]) assert.equal((await transport({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: context(project) })).ok, true);
  const inA = createContextClient('sample.project-context/header', '1.0.0', context('A'), transport);
  assert.equal((await inA.consent('projects.summary', true)).ok, true);
  state.packages[0].projects = ['A'];
  assert.deepEqual(await transport({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: context('B') }), scopeRefusal);
  assert.deepEqual(await transport({ op: 'capture', id: 'sample.project-context/header', version: '1.0.0', context: context() }), scopeRefusal);
  // Captured in A, finished after B became active: still A.
  assert.deepEqual((await inA.query('projects')).value.items, [{ id: 'A', name: 'Alpha' }]);
  state.packages[0].projects = ['B'];
  assert.deepEqual(await inA.query('projects'), scopeRefusal);
  inA.dispose?.();
});

test('extensions project scope: ledger closes useCase:2 with evidence, docs describe the scope and the spec is registered', () => {
  const entry = ledger.enablementCoverage?.['useCase:2'];
  assert.ok(entry, 'surfaces.json enablementCoverage block');
  assert.deepEqual(entry.closes, ['useCase:2']);
  assert.equal(entry.adapter, 'panda.extensions.enablement');
  for (const path of entry.evidence) assert.ok(existsSync(new URL(`../${path}`, import.meta.url)), path);
  const adapter = ledger.implementedAdapters.filter(row => row.id === 'panda.extensions.enablement');
  assert.equal(adapter.length, 1);
  assert.ok(adapter[0].tests.includes('tests/extensions-project-scope.spec.ts'));
  assert.deepEqual(ledger.completionAudit.useCases['2'], { ...ledger.completionAudit.useCases['2'], status: 'implemented', closure: 'useCase:2' }, 'the T60 completion audit closes use case 2 through this scope');
  for (const doc of ['../docs/extensions/lifecycle.md', '../docs/extensions/install.md']) {
    const text = read(doc);
    assert.match(text, /project scope/i, doc); assert.match(text, /All projects/, doc); assert.match(text, /\$\.projectScope/, doc);
  }
  for (const config of ['../playwright.config.ts', '../playwright.webkit.config.ts']) assert.match(read(config), /extensions-project-scope\.spec\.ts/, config);
  assert.match(read('../playwright.webkit.config.ts'), /\|extensions project scope/);
  assert.equal((read('../.github/workflows/ci.yml').match(/tests\/extensions-project-scope\.spec\.ts/g) ?? []).length, 2);
});
