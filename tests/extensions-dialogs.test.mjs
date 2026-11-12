import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { validateContract } from '../src/extensions/contracts.ts';
import { createDialogState } from '../src/extensions/dialog-state.ts';
import { createDeclarativeActivation } from '../src/extensions/activation.ts';
const laboratory = JSON.parse(readFileSync(new URL('./fixtures/extensions/menu-laboratory/extension.json', import.meta.url), 'utf8'));
const definition = laboratory.contributes.commands[0].action.dialog;
const context = { schemaVersion: 1, windowId: 'main', surfaceId: 'panda.workspace.header.actions', revision: 1, projectId: 'A', sessionId: 'A' };
const deferred = () => { let resolve, reject; const promise = new Promise((a, b) => { resolve = a; reject = b; }); return { promise, resolve, reject }; };
function filled(callbacks) {
  const state = createDialogState(definition, context, callbacks);
  state.set('name', 'My report'); state.set('format', 'brief'); return state;
}

test('extensions dialogs: menu laboratory is a bounded declarative package', () => {
  assert.equal(validateContract('packages', [laboratory]).ok, true);
});

test('extensions dialogs: reject duplicate fields/options, executable fields, oversized data and invalid field variants', () => {
  for (const mutate of [
    d => { d.fields[1].id = d.fields[0].id; },
    d => { d.fields[2].options[1].value = d.fields[2].options[0].value; },
    d => { d.fields[0].onChange = 'eval()'; },
    d => { d.fields[0].value = 'a'.repeat(4097); },
    d => { d.fields[0].value = false; },
    d => { d.fields[2].options = Array.from({ length: 101 }, (_, n) => ({ value: String(n), label: String(n) })); },
    d => { d.fields = Array.from({ length: 25 }, (_, n) => ({ kind: 'text', id: `field-${n}`, label: 'Name' })); },
  ]) {
    const value = structuredClone(definition); mutate(value);
    assert.equal(validateContract('dialog', value).ok, false);
  }
});

test('extensions dialogs: activation resolves copied dialog data with captured/authorized context on all three surfaces', () => {
  for (const surfaceId of ['panda.workspace.header.actions', 'panda.sidebar.footer', 'panda.inspector.actions']) {
    const manifest = structuredClone(laboratory); manifest.contributes.menus[0].location = surfaceId;
    const activation = createDeclarativeActivation({ safeMode: false, diagnostics: [], packages: [{ manifest, enabled: true, icons: {} }] }, 1);
    const result = activation.actionFor('sample.menu-laboratory/open', { ...context, surfaceId });
    assert.deepEqual(result, laboratory.contributes.commands[0].action);
    result.dialog.title = 'Changed';
    assert.equal(activation.actionFor('sample.menu-laboratory/open', { ...context, surfaceId }).dialog.title, 'Report options');
    assert.equal(activation.actionFor('sample.menu-laboratory/open', { ...context, surfaceId: 'wrong' }), undefined);
    activation.dispose(); assert.equal(activation.actionFor('sample.menu-laboratory/open', { ...context, surfaceId }), undefined);
  }
});

test('extensions dialogs: validation preserves input, labels differ from values, switches and multiselect are bounded', async () => {
  const state = createDialogState(definition, context);
  assert.deepEqual(await state.validate(), { name: 'Enter at least 3 characters.', format: 'Choose an option.' });
  state.set('name', 'Hi'); state.set('details', false); state.set('format', 'full'); state.set('tags', ['alpha', 'beta']);
  assert.deepEqual(await state.validate(), { name: 'Enter at least 3 characters.' });
  assert.deepEqual(state.values(), { name: 'Hi', details: false, format: 'full', tags: ['alpha', 'beta'] });
  for (const [id, value] of [['format', 'Full report'], ['format', 'unavailable'], ['tags', ['alpha', 'alpha']], ['name', 'a'.repeat(4097)], ['details', 'true']]) assert.throws(() => state.set(id, value));
  state.set('name', 'Valid'); assert.deepEqual(await state.validate(), {});
  const copy = state.values(); copy.tags.push('changed'); assert.deepEqual(state.values().tags, ['alpha', 'beta']);
});

test('extensions dialogs: newer queries win even if an aborted provider ignores cancellation and resolves last', async () => {
  const requests = [];
  const state = filled({ options(field, query, captured, signal) { const done = deferred(); requests.push({ ...done, query, captured, signal }); return done.promise; }, async validate() { return {}; } });
  const old = state.options('tags', 'a'), latest = state.options('tags', 'b');
  assert.equal(requests[0].signal.aborted, true); assert.equal(requests[1].captured.projectId, 'A');
  requests[1].resolve([{ value: 'new', label: 'New option' }]); assert.deepEqual(await latest, [{ value: 'new', label: 'New option' }]);
  requests[0].resolve([{ value: 'old', label: 'Old option' }]); assert.equal(await old, undefined);
  state.set('tags', ['new']); assert.throws(() => state.set('tags', ['old']));
});

test('extensions dialogs: option errors can retry; malformed async options and validators are rejected', async () => {
  let fail = true;
  const state = filled({ async options() { if (fail) throw new Error('offline'); return []; }, async validate() { return { alien: 'Not a field' }; } });
  await assert.rejects(state.options('tags', 'x'), /offline/); fail = false; assert.deepEqual(await state.options('tags', 'x'), []);
  await assert.rejects(state.validate(), /Invalid validation response/);
  const bad = filled({ async options() { return Array.from({ length: 101 }, () => ({ value: 'same', label: 'Same' })); }, async validate() { return {}; } });
  await assert.rejects(bad.options('tags', ''), /Invalid option response/);
});

test('extensions dialogs: unload aborts query/validation and suppresses late success and rejection', async () => {
  const option = deferred(), validation = deferred(); let optionSignal, validationSignal;
  const state = filled({ options(_f, _q, _c, signal) { optionSignal = signal; return option.promise; }, validate(_v, _c, signal) { validationSignal = signal; return validation.promise; } });
  const options = state.options('tags', ''), submit = state.validate(); state.dispose();
  assert.equal(optionSignal.aborted, true); assert.equal(validationSignal.aborted, true);
  option.resolve([{ value: 'late', label: 'Late' }]); validation.reject(new Error('late failure'));
  assert.equal(await options, undefined); assert.equal(await submit, undefined);
  state.set('name', 'Changed'); assert.equal(state.values().name, 'My report');
});

test('extensions dialogs: callbacks cannot mutate captured inputs or retarget a later active project', async () => {
  const captured = structuredClone(context);
  let seen;
  const state = createDialogState(definition, captured, { async options() { return []; }, async validate(values, ctx) { seen = structuredClone(ctx); ctx.projectId = 'mutated'; values.name = 'mutated'; return { name: 'Try another name.' }; } });
  captured.projectId = 'B'; state.set('name', 'Name'); state.set('format', 'brief');
  assert.deepEqual(await state.validate(), { name: 'Try another name.' }); assert.equal(seen.projectId, 'A'); assert.equal(state.values().name, 'Name');
});
