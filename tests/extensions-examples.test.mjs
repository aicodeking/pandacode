// Author-facing validation of the shipped extension examples and guides (T58, E30). The examples
// are checked as packages with the same manifest contract the native installer uses; the native
// side runs the same corpus in src-tauri/src/extensions/packages.rs
// (author_examples_install_natively_and_agree_with_the_compatibility_corpus).
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import ts from 'typescript';
import { validateContract, MANIFEST_CAPABILITIES, MANIFEST_CONTRIBUTIONS } from '../src/extensions/contracts.ts';
import { createUiCatalog } from '../src/extensions/catalog.ts';

const read = path => readFileSync(path, 'utf8');
const corpus = JSON.parse(read('tests/fixtures/extensions/examples-v1.json'));
const schema = JSON.parse(read('src/extensions/schema-v1.json'));
const EXAMPLES = 'examples/extensions';
const GUIDE = 'docs/extensions/README.md';
const CAPABILITIES = 'docs/extensions/capabilities.md';
const manifestOf = dir => JSON.parse(read(`${EXAMPLES}/${dir}/package/extension.json`));
const byId = new Map(corpus.examples.map(example => [example.id, example]));

function files(root, prefix = '') {
  return readdirSync(join(root, prefix)).flatMap(name => {
    const path = prefix ? `${prefix}/${name}` : name;
    return statSync(join(root, path)).isDirectory() ? files(root, path) : [path];
  }).sort();
}
/** The files an archive may carry: the same declaration rule as the native installer. */
function declaredFiles(manifest) {
  const declared = new Set(['extension.json']);
  if (manifest.runtime) declared.add(manifest.runtime.entrypoint);
  for (const icon of manifest.contributes?.icons ?? []) declared.add(icon.asset);
  for (const view of manifest.contributes?.views ?? []) if (view.rich) for (const key of ['html', 'css', 'script']) declared.add(view.rich[key]);
  return [...declared].sort();
}
/** Validation set for one manifest: itself first, then the examples it depends on. */
function packageSet(manifest) {
  return [manifest, ...Object.keys(manifest.dependencies ?? {}).map(id => manifestOf(byId.get(id).dir))];
}
function edited(manifest, change) {
  const copy = structuredClone(manifest);
  if (change.remove) delete copy[change.key];
  else if (change.append !== undefined) copy[change.key] = [...(copy[change.key] ?? []), change.append];
  else copy[change.key] = structuredClone(change.value);
  return copy;
}
function section(text, name) {
  const start = `<!-- ${name}:start -->`, end = `<!-- ${name}:end -->`;
  const from = text.indexOf(start), to = text.indexOf(end);
  assert.ok(from >= 0 && to > from, `${name} markers`);
  return text.slice(from + start.length, to);
}
const codeList = text => [...text.matchAll(/`([^`]+)`/g)].map(match => match[1]);

test('extension examples: every shipped example is listed once and the author categories are covered', () => {
  assert.deepEqual(readdirSync(EXAMPLES).filter(name => statSync(join(EXAMPLES, name)).isDirectory()).sort(), corpus.examples.map(example => example.dir).sort());
  assert.equal(new Set(corpus.examples.map(example => example.id)).size, corpus.examples.length);
  for (const category of corpus.categories) assert.ok(corpus.examples.some(example => example.categories.includes(category)), category);
  for (const example of corpus.examples) {
    assert.equal(manifestOf(example.dir).id, example.id);
    assert.equal(Boolean(manifestOf(example.dir).runtime), example.executable, example.dir);
    assert.ok(existsSync(`${EXAMPLES}/${example.dir}/README.md`), `${example.dir} README`);
  }
});

test('extension examples: each package validates and carries only declared files', () => {
  const all = corpus.examples.map(example => manifestOf(example.dir));
  const together = validateContract('packages', all);
  assert.equal(together.ok, true, JSON.stringify(together.error));
  assert.deepEqual(together.diagnostics, []);
  for (const example of corpus.examples) {
    const manifest = manifestOf(example.dir);
    const result = validateContract('packages', packageSet(manifest));
    assert.equal(result.ok, true, `${example.dir}: ${JSON.stringify(result.error)}`);
    assert.deepEqual(result.diagnostics, [], example.dir);
    const root = `${EXAMPLES}/${example.dir}/package`;
    assert.deepEqual(files(root), declaredFiles(manifest), example.dir);
    for (const file of files(root).filter(file => file.endsWith('.svg'))) {
      const svg = read(join(root, file)).trim();
      assert.match(svg, /^<svg[\s>]/); assert.doesNotMatch(svg, /<script|\son\w+=|href=|<foreignObject/i);
    }
  }
});

test('extension examples: executable code needs no private source, install hook or runtime download', () => {
  for (const example of corpus.examples.filter(example => example.executable)) {
    const source = read(`${EXAMPLES}/${example.dir}/package/main.cjs`);
    for (const [, specifier] of source.matchAll(/require\(\s*['"]([^'"]+)['"]\s*\)/g)) assert.match(specifier, /^node:/, `${example.dir} requires ${specifier}`);
    assert.doesNotMatch(source, /\bimport\s*\(|from\s+['"]|child_process|https?:\/\//, example.dir);
  }
  for (const dir of corpus.examples.map(example => example.dir).filter(dir => existsSync(`${EXAMPLES}/${dir}/package.json`))) {
    const pkg = JSON.parse(read(`${EXAMPLES}/${dir}/package.json`));
    assert.equal(pkg.private, true); assert.deepEqual(Object.keys(pkg.scripts), ['build']);
    assert.equal(pkg.dependencies, undefined, `${dir} has runtime dependencies`);
    assert.equal(pkg.devDependencies['@pandacode/extensions'], 'file:../../../src/extensions/sdk');
  }
});

test('extension examples: TypeScript examples compile against only the public SDK and match the shipped main.cjs', () => {
  const typed = corpus.examples.map(example => example.dir).filter(dir => existsSync(`${EXAMPLES}/${dir}/tsconfig.json`));
  assert.deepEqual(typed.sort(), ['local-tool', 'project-summary']);
  for (const dir of typed) {
    const config = ts.readConfigFile(`${EXAMPLES}/${dir}/tsconfig.json`, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(config.config, ts.sys, `${EXAMPLES}/${dir}`);
    const program = ts.createProgram(parsed.fileNames, { ...parsed.options, noEmit: true });
    assert.deepEqual(ts.getPreEmitDiagnostics(program).map(d => ts.flattenDiagnosticMessageText(d.messageText, '\n')), [], dir);
    const sources = program.getSourceFiles().filter(file => !program.isSourceFileDefaultLibrary(file)).map(file => resolve(file.fileName).replaceAll('\\', '/'));
    assert.deepEqual(sources.map(file => file.replace(/^.*\/(src\/extensions\/sdk|examples\/extensions)\//, '$1/')).sort(), ['examples/extensions/' + dir + '/main.cts', 'src/extensions/sdk/index.d.ts'].sort(), dir);
    const compiled = ts.transpileModule(read(`${EXAMPLES}/${dir}/main.cts`), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2022 } }).outputText;
    assert.equal(read(`${EXAMPLES}/${dir}/package/main.cjs`).replaceAll('\r\n', '\n'), compiled.replaceAll('\r\n', '\n'), `${dir}: rebuild with npx tsc -p ${EXAMPLES}/${dir}/tsconfig.json`);
  }
});

test('extension examples: the local tool registers its declared command, starts its declared tool and stays within bounds', async () => {
  const manifest = manifestOf('local-tool');
  const module = createRequire(import.meta.url)(`../${EXAMPLES}/local-tool/package/main.cjs`);
  const tool = manifest.contributes.tools[0];
  assert.deepEqual(Object.keys(module.tools), [tool.id]);
  const progress = [];
  const result = await module.tools[tool.id](['one two', 'three'], { async progress(value) { progress.push(value); return null; } });
  assert.deepEqual(result, { words: 3 });
  assert.ok(progress.length <= 32 && progress.every(value => JSON.stringify(value).length <= 512));
  let handler, started, dialog;
  module.activate({
    commands: { register(id, callback) { assert.equal(id, manifest.runtime.activationEvents[0]); handler = callback; return { dispose() {} }; } },
    jobs: { async start(options) { started = options; return { schemaVersion: 1, job: 'job-1', state: 'running', progress: [], result: null, error: null }; } },
    ui: { async showDialog(definition) { dialog = definition; return null; } },
  });
  await handler({ schemaVersion: 1, commandId: manifest.runtime.activationEvents[0], windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1 });
  assert.equal(started.tool, tool.id);
  assert.ok(started.args.length <= tool.arguments.maxItems && started.args.every(arg => arg.length <= tool.arguments.maxLength));
  assert.equal(validateContract('dialog', dialog).ok, true);
  assert.equal(dialog.confirmation, 'Job job-1 is running.');
});

test('extension examples: compatibility corpus accepts supported API ranges and fails closed on incompatible or malformed manifests', () => {
  assert.equal(schema.$defs.manifest.properties.manifestVersion.const, 1);
  for (const example of corpus.examples) {
    const manifest = manifestOf(example.dir);
    for (const range of corpus.apiRanges.accepted) {
      const result = validateContract('packages', packageSet({ ...manifest, engines: { pandacodeApi: range } }));
      assert.equal(result.ok, true, `${example.dir} ${range}`);
    }
    for (const { range, code } of corpus.apiRanges.rejected) {
      const result = validateContract('packages', packageSet({ ...manifest, engines: { pandacodeApi: range } }));
      assert.equal(result.ok, false, `${example.dir} ${range}`); assert.equal(result.error.code, code, `${example.dir} ${range}`);
    }
    for (const change of corpus.manifestCases.filter(change => !change.example || change.example === example.dir)) {
      const result = validateContract('packages', packageSet(edited(manifest, change)));
      assert.equal(result.ok, false, `${example.dir}: ${change.name}`); assert.equal(result.error.code, change.code, `${example.dir}: ${change.name}`);
    }
    for (const change of corpus.optionalCases) {
      const result = validateContract('packages', packageSet(edited(manifest, change)));
      assert.equal(result.ok, true, `${example.dir}: ${change.name}`);
      assert.deepEqual(result.diagnostics.map(diagnostic => diagnostic.code), [change.diagnostic]);
      assert.equal(Object.hasOwn(result.value.packages[0], 'futureGrant'), false);
      if (change.kept) assert.deepEqual(result.value.packages[0].optionalCapabilities, change.kept);
    }
  }
  const duplicate = validateContract('packages', [manifestOf('button-icon'), manifestOf('button-icon')]);
  assert.equal(duplicate.ok, false); assert.equal(duplicate.error.code, 'DuplicateId');
  for (const fixture of corpus.priorFixtures) {
    const manifest = JSON.parse(read(`tests/fixtures/extensions/${fixture}/extension.json`));
    const result = validateContract('packages', [manifest]);
    assert.equal(result.ok, true, `${fixture}: ${JSON.stringify(result.error)}`);
  }
});

test('extension examples: archive corpus matches the author pre-check of declared package files', () => {
  for (const change of corpus.archiveCases) {
    const manifest = manifestOf(change.example);
    const present = files(`${EXAMPLES}/${change.example}/package`).filter(file => file !== change.omit);
    if (change.add) present.push(change.add);
    if (change.omit === 'extension.json') { assert.equal(change.error, 'Missing extension.json.'); continue; }
    const declared = declaredFiles(manifest);
    const unsafe = present.some(file => file.split('/').some(part => part === '..' || part === ''));
    const undeclared = present.filter(file => !declared.includes(file));
    const missing = declared.filter(file => !present.includes(file));
    assert.ok(unsafe || undeclared.length || missing.length, change.name);
    if (unsafe) assert.equal(change.error, 'Unsafe archive entry.');
    else if (missing.length) assert.match(change.error, /^Missing /, change.name);
    else assert.match(change.error, /^Undeclared package file/, change.name);
  }
});

function sdkUnion(name, member) {
  const path = 'src/extensions/sdk/index.d.ts';
  const program = ts.createProgram([path], { noEmit: true, types: [], strict: true });
  const checker = program.getTypeChecker();
  const file = program.getSourceFile(path);
  const symbol = checker.getExportsOfModule(checker.getSymbolAtLocation(file)).find(item => item.name === name);
  assert.ok(symbol, name);
  const type = checker.getDeclaredTypeOfSymbol(symbol);
  if (member) {
    const values = type.isUnion() ? type.types : [type];
    return [...new Set(values.flatMap(value => { const property = value.getProperty(member); if (!property) return []; const inner = checker.getTypeOfSymbolAtLocation(property, file); return (inner.isUnion() ? inner.types : [inner]).map(item => item.value); }).filter(value => typeof value === 'string'))].sort();
  }
  return (type.isUnion() ? type.types : [type]).map(item => item.value).filter(value => typeof value === 'string').sort();
}

test('extension examples: public SDK types agree with the shared native schema', () => {
  const defs = schema.$defs;
  const pairs = [
    ['MainDialogId', defs.mainDialogId.enum], ['BoardStage', defs.boardStage.enum], ['SidebarSectionId', defs.sidebarSectionId.enum],
    ['SidebarBotsGroupId', defs.sidebarBotsGroupId.enum], ['SettingsPageId', defs.settingsPageId.enum], ['SettingsSectionId', defs.settingsSectionId.enum],
    ['PullSection', defs.pullSection.enum],
  ];
  for (const [name, values] of pairs) assert.deepEqual(sdkUnion(name), [...values].sort(), name);
  assert.deepEqual(sdkUnion('DialogField', 'kind'), [...schema['x-primitives'].families.field.kinds].sort());
  assert.deepEqual(sdkUnion('ContextResource'), ['connections', 'harnesses', 'jobs', 'projects', 'tasks']);
  assert.match(read('src/extensions/sdk/index.d.ts'), /readonly apiVersion: '1\.0\.0';/);
  assert.equal(corpus.apiVersion, '1.0.0');
  assert.deepEqual([...MANIFEST_CAPABILITIES], corpus.permissions);
});

function capabilityRows() {
  const ui = createUiCatalog(() => ({ safeMode: false, packages: [], diagnostics: [] }));
  const surfaces = []; let cursor;
  do { const page = ui.listSurfaces({ limit: 100, ...(cursor ? { cursor } : {}) }); surfaces.push(...page.items); cursor = page.nextCursor; } while (cursor);
  surfaces.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return surfaces.map(surface => {
    const fallbacks = Object.entries(surface.capabilities?.fallbacks ?? {}).map(([control, host]) => `${control} → \`${host}\``).join(', ');
    return `| \`${surface.location}\` | ${surface.type === 'action-slot' ? 'action' : 'data'} | ${surface.supportedOperations.join(', ')} | ${surface.supportedItemTypes.join(', ')} | ${surface.windows.join(', ')} | ${fallbacks || '—'} |`;
  });
}

test('extension guides: the capability table is the tested catalog (UPDATE_EXTENSION_DOCS=1 regenerates it)', () => {
  const table = ['', '| Location | Kind | Operations | Item types | Windows | Host fallbacks |', '| --- | --- | --- | --- | --- | --- |', ...capabilityRows(), ''].join('\n');
  const text = read(CAPABILITIES).replaceAll('\r\n', '\n');
  if (process.env.UPDATE_EXTENSION_DOCS === '1') {
    const [head, rest] = text.split('<!-- capability-table:start -->');
    writeFileSync(CAPABILITIES, `${head}<!-- capability-table:start -->${table}<!-- capability-table:end -->${rest.split('<!-- capability-table:end -->')[1]}`);
    return;
  }
  assert.equal(section(text, 'capability-table'), table, 'Run UPDATE_EXTENSION_DOCS=1 node --test tests/extensions-examples.test.mjs and review the diff.');
});

test('extension guides: permissions, contribution kinds and error codes match the validator', () => {
  const guide = read(GUIDE).replaceAll('\r\n', '\n');
  assert.deepEqual(codeList(section(guide, 'permissions')).sort(), [...MANIFEST_CAPABILITIES].sort());
  assert.deepEqual(codeList(section(guide, 'contributions')).sort(), [...MANIFEST_CONTRIBUTIONS].sort());
  const source = read('src/extensions/contracts.ts');
  const codes = [...new Set([...source.matchAll(/error\('([A-Za-z]+)'/g)].map(match => match[1]))].sort();
  const documented = codeList(section(guide, 'errors'));
  for (const code of codes) assert.ok(documented.includes(code), `error code ${code} is undocumented`);
  for (const { error } of corpus.archiveCases) assert.ok(guide.includes(error), `archive error "${error}" is undocumented`);
});

test('extension guides: every example is documented, links resolve and no stale delivery note remains', () => {
  const guide = read(GUIDE);
  for (const example of corpus.examples) assert.ok(guide.includes(`../../${EXAMPLES}/${example.dir}/`), `${example.dir} is not in the author guide`);
  const docs = readdirSync('docs/extensions').filter(name => name.endsWith('.md')).map(name => `docs/extensions/${name}`);
  const readmes = corpus.examples.map(example => `${EXAMPLES}/${example.dir}/README.md`);
  for (const path of [...docs, ...readmes]) {
    const text = read(path);
    for (const [, target] of text.matchAll(/\]\(([^)\s]+)\)/g)) {
      if (/^(https?:|mailto:|#)/.test(target)) continue;
      const file = resolve(dirname(path), target.split('#')[0]);
      assert.ok(existsSync(file), `${path} links to missing ${target}`);
    }
    assert.doesNotMatch(text, /pinned window is T57/, path);
  }
});
