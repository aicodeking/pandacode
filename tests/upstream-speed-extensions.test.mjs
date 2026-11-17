import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { speedChoices, speedView, speedItemId, captureSpeed, speedStale, SPEED_LOCATION } from '../src/extensions/upstream-speed-core.ts';
import { validateContract } from '../src/extensions/contracts.ts';
import { actionLocations } from '../src/extensions/ordering.ts';
import { createLayoutStore } from '../src/extensions/layout.ts';

const manifest = JSON.parse(readFileSync(new URL('./fixtures/extensions/upstream-speed/manifest.json', import.meta.url), 'utf8'));
const tiers = manifest.contributes.providers[0].models[0].speedTiers;
const upstream = [{ id: 'fast', name: 'Fast', description: 'a' }, { id: 'ultra', name: 'Ultra fast', description: 'b' }];
const live = (store, project) => ({ safe: () => false, order: (location, ids) => store.order(location, ids, project), isHidden: id => store.isHidden(id, project) });
const memory = () => { const data = new Map(); return { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) }; };

test('speed tiers: with no arrangement the picker keeps the upstream list', () => {
  const store = createLayoutStore(memory());
  const view = speedView('codex', 'gpt', upstream, null, live(store));
  assert.deepEqual(view.choices.map(choice => choice.id), ['', 'fast', 'ultra']);
  assert.deepEqual(view.hidden, []);
  assert.deepEqual(speedChoices(upstream, null).map(choice => choice.id), ['', 'fast', 'ultra']);
});

test('speed tiers: a saved tier the catalog dropped still shows as chosen, and no tiers means Standard only', () => {
  assert.deepEqual(speedChoices(upstream, 'gone').map(choice => choice.id), ['', 'fast', 'ultra', 'gone']);
  assert.deepEqual(speedChoices([], null).map(choice => choice.id), ['']);
});

test('speed tiers: hide, reorder and restore on the user layout; Standard and the saved tier never hide', () => {
  const store = createLayoutStore(memory());
  const ids = upstream.map(tier => speedItemId('codex', 'gpt', tier.id));
  assert.ok(ids.every(id => /^panda\.composer\.model\.speed\/[a-z][a-z0-9-]*$/.test(id)));
  assert.ok(actionLocations.includes(SPEED_LOCATION));
  store.setVisible(ids[0], false);
  assert.deepEqual(speedView('codex', 'gpt', upstream, null, live(store)).choices.map(choice => choice.id), ['', 'ultra']);
  assert.deepEqual(speedView('codex', 'gpt', upstream, 'fast', live(store)).choices.map(choice => choice.id), ['', 'fast', 'ultra'], 'the saved tier stays');
  store.setVisible(ids[0], true);
  store.move(SPEED_LOCATION, ids, { id: ids[1], target: ids[0], side: 'before' });
  assert.deepEqual(speedView('codex', 'gpt', upstream, null, live(store)).choices.map(choice => choice.id), ['', 'ultra', 'fast']);
  store.resetGlobal();
  assert.deepEqual(speedView('codex', 'gpt', upstream, null, live(store)).choices.map(choice => choice.id), ['', 'fast', 'ultra']);
});

test('speed tiers: safe mode restores the upstream list', () => {
  const store = createLayoutStore(memory());
  store.setVisible(speedItemId('codex', 'gpt', 'fast'), false);
  const view = speedView('codex', 'gpt', upstream, null, { ...live(store), safe: () => true });
  assert.deepEqual(view.choices.map(choice => choice.id), ['', 'fast', 'ultra']);
});

test('speed tiers: a captured context is stale once the arrangement or the model changes', () => {
  const store = createLayoutStore(memory());
  const drawn = speedView('codex', 'gpt', upstream, null, live(store));
  const captured = captureSpeed(drawn, 'codex', 'gpt', 'fast');
  assert.equal(speedStale(captured, { provider: 'codex', model: 'gpt', revision: drawn.revision }), false);
  store.setVisible(speedItemId('codex', 'gpt', 'fast'), false);
  const changed = speedView('codex', 'gpt', upstream, null, live(store));
  assert.equal(speedStale(captured, { provider: 'codex', model: 'gpt', revision: changed.revision }), true);
  assert.equal(speedStale(captured, { provider: 'codex', model: 'other', revision: drawn.revision }), true);
});

test('speed tiers: the installed fixture declares tiers through the harness contract; a duplicate tier is refused', () => {
  assert.equal(tiers.length, 3);
  assert.equal(validateContract('packages', [structuredClone(manifest)]).ok, true);
  const duplicate = structuredClone(manifest);
  duplicate.contributes.providers[0].models[0].speedTiers.push({ id: 'fast', name: 'Again' });
  const refused = validateContract('packages', [duplicate]);
  assert.equal(refused.ok, false);
  assert.equal(refused.error.code, 'DuplicateId');
});
