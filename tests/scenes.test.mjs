import test from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { sceneIndex } from '../src/scenes/pick.ts';

/** The registered scenes, as src/scenes/index.ts collects them: files exporting `scene`, sorted by id. */
const dir = new URL('../src/scenes/', import.meta.url);
const ids = readdirSync(dir).filter(name => name.endsWith('.ts'))
  .map(name => readFileSync(new URL(name, dir), 'utf8'))
  .filter(source => /export const scene\b/.test(source))
  .map(source => source.match(/\bid:\s*'([^']+)'/)[1]).sort();

const uuid = i => `${(i * 2654435761 >>> 0).toString(16).padStart(8, '0')}-4a1b-${(i % 9999).toString().padStart(4, '0')}-9c3d-${(i * 40503 >>> 0).toString(16).padStart(12, '0')}`;

test('the sky and the aurora are registered, ids unique', () => {
  assert.ok(ids.includes('sky') && ids.includes('aurora'));
  assert.equal(new Set(ids).size, ids.length);
});

test('a thread always gets the same scene', () => {
  for (const id of ['session-5', 'session-cards', uuid(7), '']) assert.equal(sceneIndex(id, ids.length), sceneIndex(id, ids.length));
  assert.equal(sceneIndex('session-5', 1), 0);
  for (let i = 0; i < 200; i++) { const n = sceneIndex(uuid(i), ids.length); assert.ok(Number.isInteger(n) && n >= 0 && n < ids.length); }
});

for (const [name, make] of [['uuids', uuid], ['sequential ids', i => `session-${i}`]]) {
  test(`every scene is reachable and ${name} spread within ±30% of uniform`, () => {
    for (const count of [ids.length, 3, 5, 7]) {
      const hits = new Array(count).fill(0);
      for (let i = 0; i < 1000; i++) hits[sceneIndex(make(i), count)]++;
      const even = 1000 / count;
      for (const n of hits) assert.ok(n > even * .7 && n < even * 1.3, `${count} scenes: ${hits}`);
    }
  });
}
