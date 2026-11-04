import test from 'node:test';
import assert from 'node:assert/strict';
import { dupModelNames, limitTeamModels, TEAM_LIMIT, toggleTeamModel } from '../src/team-catalog.ts';

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

test('an excluded recent model leaves the catalog and the next recent one takes its place (issue #315)', () => {
  const recent = Array.from({ length: 15 }, (_, i) => `m${i}`);
  const result = limitTeamModels(models(20), { recent, added: [], excluded: ['m0'] });
  assert.equal(result.limited, true);
  assert.deepEqual([...result.recent], ['m1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
  assert.deepEqual(ids(result), ['default', 'm1', 'm2', 'm3', 'm4', 'm5', 'm6', 'm7', 'm8', 'm9', 'm10']);
});

test('an exclusion hides a model entirely until it is added again', () => {
  const dropped = limitTeamModels(models(20), { recent: ['m19'], added: ['m19'], excluded: ['m19'] });
  assert.deepEqual(ids(dropped), ['default']);
  const back = limitTeamModels(models(20), { recent: ['m19'], added: [], excluded: [] });
  assert.deepEqual(ids(back), ['default', 'm19']);
});

test('exclusions never apply to short or unlimited catalogs', () => {
  assert.deepEqual(ids(limitTeamModels(models(10), { recent: ['m3'], added: [], excluded: ['m3'] })), ids(limitTeamModels(models(10), { recent: [], added: [] })));
  assert.equal(limitTeamModels(models(300), { recent: [], added: [], excluded: ['m1'], unlimited: true }).models.length, 301);
});

test('toggling uses the exclusion list only for a model recency would keep', () => {
  const recent = Array.from({ length: 12 }, (_, i) => `m${i}`);
  const limit = { recent, added: [], excluded: [] };
  // In the recent slots: off excludes it, on clears that.
  const off = toggleTeamModel(models(20), limit, 'm0', false);
  assert.deepEqual(off, { added: [], excluded: ['m0'] });
  assert.deepEqual(toggleTeamModel(models(20), { ...limit, ...off }, 'm0', true), { added: [], excluded: [] });
  // A recent model past the slots is really off, so on must add it, and off then just un-adds it.
  const on = toggleTeamModel(models(20), limit, 'm11', true);
  assert.deepEqual(on, { added: ['m11'], excluded: [] });
  assert.deepEqual(toggleTeamModel(models(20), { ...limit, ...on }, 'm11', false), { added: [], excluded: [] });
  // Never recent: only the added list moves.
  assert.deepEqual(toggleTeamModel(models(20), limit, 'm15', true), { added: ['m15'], excluded: [] });
});

test('dupModelNames finds only the names a catalog uses more than once', () => {
  const dupes = dupModelNames([
    { id: 'deepseek/deepseek-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'default', name: 'Default model' },
    { id: 'opencode-go/deepseek-v4.1-flash', name: 'DeepSeek V4.1 Flash' },
    { id: 'anthropic/claude-sonnet-4', name: 'Claude Sonnet 4' },
  ]);
  assert.deepEqual([...dupes], ['DeepSeek V4.1 Flash']);
});
