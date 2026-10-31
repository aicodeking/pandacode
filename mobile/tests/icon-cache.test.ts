/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { chunks, DAY_MS, dueIcons, iconKey, mergeIcons, parseIcons, RETRY_MS, validIcon } from '../src/store/icon-cache.ts';

const PNG = 'data:image/png;base64,iVBORw0KGgo=';

test('asks only for new or day-old icons, once each', () => {
  const now = 10 * DAY_MS;
  const cache = { [iconKey('d', 'fresh')]: { url: PNG, at: now - 1000 }, [iconKey('d', 'old')]: { url: null, at: now - DAY_MS - 1 } };
  assert.deepEqual(dueIcons(cache, 'd', ['fresh', 'old', 'new', 'new', ''], now), ['old', 'new']);
  assert.deepEqual(dueIcons(cache, 'other', ['fresh'], now), ['fresh']);
});

test('a reply caches answers for a day; missing ids keep their icon and retry soon', () => {
  const now = 5 * DAY_MS;
  const before = { [iconKey('d', 'gone')]: { url: PNG, at: 0 } };
  const cache = mergeIcons(before, 'd', ['a', 'b', 'gone'], { a: PNG, b: null, extra: PNG }, now);
  assert.deepEqual(cache[iconKey('d', 'a')], { url: PNG, at: now });
  assert.deepEqual(cache[iconKey('d', 'b')], { url: null, at: now });
  assert.equal(cache[iconKey('d', 'extra')], undefined);
  assert.equal(cache[iconKey('d', 'gone')].url, PNG);
  assert.deepEqual(dueIcons(cache, 'd', ['a', 'b', 'gone'], now + 1), []);
  assert.deepEqual(dueIcons(cache, 'd', ['a', 'b', 'gone'], now + RETRY_MS), ['gone']);
});

test('only image data: URLs count; the file is checked entry by entry', () => {
  assert.equal(validIcon(PNG), PNG);
  assert.equal(validIcon('data:image/svg+xml;base64,PHN2Zz4='), 'data:image/svg+xml;base64,PHN2Zz4=');
  for (const bad of ['https://x/icon.png', 'data:text/html;base64,PGI+', `data:image/png;base64,${'A'.repeat(600_000)}`, 42, null]) assert.equal(validIcon(bad), null);
  assert.deepEqual(parseIcons('not json'), {});
  assert.deepEqual(parseIcons('[1]'), {});
  assert.deepEqual(parseIcons(JSON.stringify({ 'd/a': { url: PNG, at: 1 }, 'd/b': { url: 'javascript:1', at: 2 }, 'd/c': { at: 'x' } })), { 'd/a': { url: PNG, at: 1 }, 'd/b': { url: null, at: 2 } });
});

test('requests go out in batches of 50', () => {
  assert.deepEqual(chunks(Array.from({ length: 120 }, (_, n) => n)).map(c => c.length), [50, 50, 20]);
  assert.deepEqual(chunks([]), []);
});
