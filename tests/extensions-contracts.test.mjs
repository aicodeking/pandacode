import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract, evaluateCondition, CONTRACT_LIMITS } from '../src/extensions/contracts.ts';

const read = path => JSON.parse(readFileSync(new URL(path, import.meta.url), 'utf8'));
const corpus = read('./fixtures/extensions/contracts-v1.json');
const sample = read('./fixtures/extensions/sample-project-helper/extension.json');
const schema = read('../src/extensions/schema-v1.json');

function edits(input, changes = []) {
  for (const { path, value } of changes) {
    const keys = path.slice(1).split('/');
    const key = keys.pop();
    const parent = keys.reduce((current, part) => current[part], input);
    if (key === '-') parent.push(structuredClone(value));
    else parent[key] = structuredClone(value);
  }
  return input;
}

function inputFor(fixture) {
  let value = edits(structuredClone(fixture.sample ? [sample] : fixture.input), fixture.edits);
  if (fixture.duplicateSample) value.push(structuredClone(sample));
  if (fixture.repeat !== undefined) value = Array.from({ length: fixture.repeat }, () => structuredClone(value));
  if (fixture.textRepeat !== undefined) value = value.repeat(fixture.textRepeat);
  for (let i = 0; i < (fixture.nest ?? 0); i++) value = { op: 'not', arg: value };
  return value;
}

function expectedFor(fixture) {
  return edits(structuredClone(fixture.expected === 'sample' ? corpus.sampleResult : fixture.expected === 'input' ? { ok: true, value: fixture.input, diagnostics: [] } : fixture.expected), fixture.expectedEdits);
}

for (const fixture of corpus.cases) {
  test(`extensions contracts v1: ${fixture.name}`, () => {
    const input = inputFor(fixture), before = structuredClone(input);
    const actual = fixture.kind === 'condition' ? evaluateCondition(input, fixture.context) : validateContract(fixture.kind, input);
    assert.deepEqual(actual, expectedFor(fixture));
    assert.deepEqual(input, before, 'validation cannot mutate the package or captured context');
    if (!actual.ok) assert.equal(validateContract('error', actual.error).ok, true, 'stable errors conform to their own public envelope');
  });
}

test('extensions contracts: normative schema uses only the supported validation vocabulary', () => {
  assert.equal(corpus.schemaVersion, 1);
  assert.equal(schema.$id, 'pandacode:extensions:contracts:1');
  const keywords = new Set(['$ref', 'type', 'minLength', 'maxLength', 'pattern', 'enum', 'const', 'anyOf', 'required', 'additionalProperties', 'properties', 'maxProperties', 'items', 'minItems', 'maxItems', 'minimum', 'maximum']);
  function visit(node) {
    for (const [key, value] of Object.entries(node)) {
      assert.ok(keywords.has(key), `unimplemented keyword ${key} requires both validators to change`);
      if (key === 'properties') Object.values(value).forEach(visit);
      if (key === 'anyOf') value.forEach(visit);
      if (['items', 'additionalProperties'].includes(key) && typeof value === 'object') visit(value);
    }
  }
  Object.values(schema.$defs).forEach(visit);
  for (const kind of ['command', 'surface', 'contribution', 'context', 'error', 'manifest', 'expression']) assert.ok(schema.$defs[kind]);
  const native = readFileSync(new URL('../src-tauri/src/extensions/contracts.rs', import.meta.url), 'utf8');
  assert.ok(native.includes('tests/fixtures/extensions/contracts-v1.json'), 'native tests must execute the exact same corpus');
  assert.ok(native.includes('src/extensions/schema-v1.json'), 'native uses the same normative schema');
});

test('extensions contracts: fixture drift is observable, not auto-approved', () => {
  const actual = validateContract('packages', [sample]);
  const corrupted = structuredClone(corpus.sampleResult);
  corrupted.value.packages[0].contributes.commands[0].action.kind = 'execute';
  assert.notDeepEqual(actual, corrupted);
  assert.deepEqual(actual, corpus.sampleResult);
});

test('extensions contracts: bounded raw data and copy isolation', () => {
  assert.ok(Object.isFrozen(CONTRACT_LIMITS), 'callers cannot loosen the validator budget');
  let calls = 0;
  const hostObject = { get op() { calls++; return 'has'; } };
  assert.deepEqual(validateContract('expression', hostObject), { ok: false, error: { schemaVersion: 1, code: 'InvalidShape', path: '$', ids: [] } });
  assert.equal(calls, 0, 'even accidental host accessors are not data expressions');
  assert.equal(validateContract('expression', 'x'.repeat(CONTRACT_LIMITS.bytes + 1)).error.code, 'LimitExceeded');
  let deep = true;
  for (let i = 0; i < 40; i++) deep = { op: 'not', arg: deep };
  assert.equal(validateContract('expression', deep).error.code, 'LimitExceeded');
  assert.equal(validateContract('packages', [{ extra: Array(9000).fill(0) }]).error.code, 'LimitExceeded');
  const result = validateContract('packages', [sample]);
  result.value.packages[0].contributes.commands[0].title = 'changed';
  assert.equal(sample.contributes.commands[0].title, 'Project helper');
  assert.equal(globalThis.__extensionsExecuted, undefined);
});

test('extensions contracts: registry DTO shapes are bounded and versioned', () => {
  const surface = {
    schemaVersion: 1, id: 'panda.workspace.header.actions', owner: 'panda.core', kind: 'actions',
    itemKinds: ['command'], windows: ['main'], platforms: ['windows', 'macos', 'linux'], contexts: ['project'],
    policies: { hide: true, reorder: true, replace: false }, defaultPosition: 0, accessibilityLabel: 'Workspace actions',
  };
  assert.deepEqual(validateContract('surface', surface), { ok: true, value: surface, diagnostics: [] });
  assert.equal(validateContract('surface', { ...surface, schemaVersion: 2 }).ok, false);
  const owner = { extensionId: sample.id, version: sample.version, activationId: 'activation-1' };
  assert.equal(validateContract('command', { schemaVersion: 1, owner, definition: sample.contributes.commands[0], capability: 'ui.contribute', contexts: ['project'], inputSchema: { type: 'null' }, outputSchema: { type: 'null' } }).ok, true);
  const entry = { schemaVersion: 1, owner, definition: sample.contributes.menus[0] };
  assert.equal(validateContract('contribution', entry).ok, true);
  assert.equal(validateContract('contribution', { ...entry, definition: { ...entry.definition, order: 100001 } }).error.code, 'LimitExceeded');
  assert.equal(validateContract('contribution', { ...entry, definition: { ...entry.definition, location: 'private.dom.selector' } }).ok, false);
});
