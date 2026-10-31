/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseSchema, readForm, UNSUPPORTED } from '../src/ui/form-schema.ts';

const schema = {
  type: 'object', required: ['env', 'count'],
  properties: {
    env: { type: 'string', enum: ['dev', 'prod'], enumNames: ['Development', 'Production'] },
    count: { type: 'integer', minimum: 1, maximum: 5 },
    note: { type: 'string', maxLength: 4 },
    tags: { type: 'array', items: { type: 'string', enum: ['a', 'b', 'c'] }, maxItems: 2 },
    ok: { type: 'boolean', default: true },
  },
};

test('enums become choices and values are checked against the schema', () => {
  const fields = parseSchema(schema);
  assert.deepEqual(fields.map(f => f.kind), ['enum', 'number', 'text', 'multi', 'boolean']);
  assert.deepEqual(fields[0].kind === 'enum' && fields[0].options.map(o => o.label), ['Development', 'Production']);
  assert.deepEqual(readForm(fields, { env: '1', count: '3', tags: ['a'] }), { env: 'prod', count: 3, tags: ['a'], ok: true });
  assert.throws(() => readForm(fields, { count: '3' }), /Choose a value for “env”/);
  assert.throws(() => readForm(fields, { env: '0', count: '9' }), /between 1 and 5/);
  assert.throws(() => readForm(fields, { env: '0', count: '2.5' }), /valid value for “count”/);
  assert.throws(() => readForm(fields, { env: '0', count: '2', note: 'too long' }), /valid value for “note”/);
  assert.throws(() => readForm(fields, { env: '0', count: '2', tags: ['a', 'b', 'c'] }), /number of options/);
});

test('unknown schema shapes are refused', () => {
  assert.throws(() => parseSchema({ type: 'object', properties: { x: { type: 'object' } } }), new Error(UNSUPPORTED));
  assert.throws(() => parseSchema({ type: 'object', properties: { x: { type: 'string', pattern: '.' } } }), new Error(UNSUPPORTED));
});
