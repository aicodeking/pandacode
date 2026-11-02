import test from 'node:test';
import assert from 'node:assert/strict';
import { limitTeamModels, TEAM_LIMIT } from '../src/team-catalog.ts';

const models = n => [{ id: 'default' }, ...Array.from({ length: n }, (_, i) => ({ id: `m${i}` }))];
const ids = result => result.models.map(m => m.id);

test('a long catalog keeps default and its most recent models in the catalog', () => {
  const recent = ['gone', 'm3', 'm3', ...Array.from({ length: 15 }, (_, i) => `m${14 - i}`)];
  const result = limitTeamModels(models(20), { recent, added: [] });
  assert.equal(result.limited, true);
  assert.equal(result.total, 20);
  assert.equal(result.recent.size, TEAM_LIMIT);
  assert.deepEqual([...result.recent], ['m3', 'm14', 'm13', 'm12', 'm11', 'm10', 'm9', 'm8', 'm7', 'm6']);
  assert.deepEqual(ids(result), ['default', 'm3', 'm6', 'm7', 'm8', 'm9', 'm10', 'm11', 'm12', 'm13', 'm14']);
});

test('added models join the recent ones', () => {
  const result = limitTeamModels(models(20), { recent: ['m0'], added: ['m19', 'm5'] });
  assert.deepEqual(ids(result), ['default', 'm0', 'm5', 'm19']);
  assert.deepEqual([...result.recent], ['m0']);
});

test('ten models or fewer (default not counted) pass through', () => {
  const result = limitTeamModels(models(10), { recent: [], added: [] });
  assert.equal(result.limited, false);
  assert.deepEqual(ids(result), ids({ models: models(10) }));
});

test('an unlimited catalog (OpenCode with a saved selection) passes through', () => {
  const result = limitTeamModels(models(300), { recent: ['m1'], added: [], unlimited: true });
  assert.equal(result.limited, false);
  assert.equal(result.models.length, 301);
});

// Tiers as native reports them on Codex model lists: key (from the catalog name), name and description.
const tier = (id, name, key) => ({ id, key, name, description: `${name} speed.` });
const FAST = tier('priority', 'Fast', 'fast'), ULTRAFAST = tier('ultrafast', 'Ultrafast', 'ultrafast'), TURBO = tier('turbo', 'Turbo Max', 'turbo-max');

test('every catalog tier of every Codex model becomes a <model>@<key> variant after every model', async () => {
  const { buildTeamCatalog, CATALOG_MAX } = await import('../src/team-catalog.ts');
  const { catalog, roster } = buildTeamCatalog([
    { id: 'codex', name: 'Codex', models: [{ id: 'default', name: 'Default', speedTiers: [FAST] }, { id: 'gpt-6.1-sol', name: 'GPT-6.1 Sol', speedTiers: [FAST, ULTRAFAST] }, { id: 'gpt-6-luna', name: 'GPT-6 Luna', speedTiers: [FAST] }, { id: 'nova-9', name: 'Nova 9', speedTiers: [TURBO] }, { id: 'plain', name: 'Plain' }] },
    { id: 'claude', name: 'Claude Code', models: [{ id: 'opus', name: 'Opus', speedTiers: [FAST] }] },
  ]);
  assert.deepEqual(catalog.map(p => p.model), ['default', 'opus', 'gpt-6.1-sol', 'gpt-6-luna', 'nova-9', 'plain', 'gpt-6.1-sol@fast', 'gpt-6.1-sol@ultrafast', 'gpt-6-luna@fast', 'nova-9@turbo-max']);
  const turbo = catalog.find(p => p.model === 'nova-9@turbo-max');
  assert.deepEqual({ ...turbo }, { id: 'codex-nova-9-turbo-max', name: 'Nova 9 Turbo Max · Codex', provider: 'codex', model: 'nova-9@turbo-max', reasoningEffort: null });
  assert.equal(catalog.find(p => p.model === 'gpt-6.1-sol@ultrafast').name, 'GPT-6.1 Sol Ultrafast · Codex');
  assert.equal(new Set(catalog.map(p => p.id)).size, catalog.length);
  assert.ok(roster.every(p => !p.model.includes('@')), 'the roster lists models, not variants');
  // A full catalog has no room left: variants never displace a model.
  const many = Array.from({ length: CATALOG_MAX }, (_, i) => ({ id: `m${i}`, name: `M${i}`, speedTiers: [FAST] }));
  const full = buildTeamCatalog([{ id: 'codex', name: 'Codex', models: many }]).catalog;
  assert.equal(full.length, CATALOG_MAX);
  assert.ok(full.every(p => !p.model.includes('@')));
});
