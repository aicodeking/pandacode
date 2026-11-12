import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { validateContract } from '../src/extensions/contracts.ts';

test('extensions SDK: standalone strict example compiles using only the public type package', () => {
  const config = ts.readConfigFile('examples/extensions/project-summary/tsconfig.json', ts.sys.readFile);
  const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, 'examples/extensions/project-summary');
  const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
  const diagnostics = ts.getPreEmitDiagnostics(program);
  assert.deepEqual(diagnostics.map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), []);
  const dependencies = program.getSourceFiles().filter(file => !program.isSourceFileDefaultLibrary(file)).map(file => resolve(file.fileName).replaceAll('\\', '/'));
  assert.equal(dependencies.length, 2);
  assert.ok(dependencies.some(file => file.endsWith('/src/extensions/sdk/index.d.ts')));
  assert.ok(dependencies.some(file => file.endsWith('/examples/extensions/project-summary/main.cts')));
  const source = readFileSync('examples/extensions/project-summary/main.cts', 'utf8');
  const compiled = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
  assert.equal(readFileSync('examples/extensions/project-summary/package/main.cjs', 'utf8').replaceAll('\r\n', '\n'), compiled.replaceAll('\r\n', '\n'));
  assert.equal(readFileSync('src/extensions/sdk/LICENSE', 'utf8').replaceAll('\r\n', '\n').trim(), readFileSync('LICENSE', 'utf8').replaceAll('\r\n', '\n').trim());
});

test('extensions SDK: example registers the declared command, queries context and stages a schema-valid dialog', async () => {
  const manifest = JSON.parse(readFileSync('examples/extensions/project-summary/package/extension.json', 'utf8'));
  assert.equal(validateContract('packages', [manifest]).ok, true);
  const { activate } = createRequire(import.meta.url)('../examples/extensions/project-summary/package/main.cjs');
  let callback, dialog;
  activate({
    commands: { register(id, handler) { assert.equal(id, manifest.runtime.activationEvents[0]); callback = handler; return { dispose() {} }; } },
    context: { async query(params) { assert.deepEqual(params, { resource: 'projects', limit: 10 }); return { schemaVersion: 1, state: 'Ready', revision: '1', items: [{ id: 'a', name: 'Orbit' }], nextCursor: null }; } },
    ui: { async showDialog(definition) { dialog = definition; } },
  });
  await callback({ projectId: 'a' });
  assert.equal(validateContract('dialog', dialog).ok, true);
  assert.equal(dialog.confirmation, 'Captured project a: Orbit');
});
