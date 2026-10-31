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
