import test from 'node:test';
import assert from 'node:assert/strict';
import { ImageCache } from '../src/image-cache.ts';

const image = 'data:image/png;base64,AAAA';
const bytes = key => 2 * (key.length + image.length);

test('image cache evicts the least recently used payload across both image paths', async () => {
  const cache = new ImageCache(bytes('sent:a') + bytes('step:b'));
  await cache.load('sent:a', async () => image);
  await cache.load('step:b', async () => image);
  assert.equal(cache.get('sent:a'), image);
  await cache.load('sent:c', async () => image);
  assert.equal(cache.get('step:b'), undefined);
  assert.equal(cache.get('sent:a'), image);
  let reloads = 0;
  assert.equal(await cache.load('step:b', async () => { reloads++; return image; }), image);
  assert.equal(reloads, 1);
});

test('visible images survive pressure, then trim back to budget when scrolled away', async () => {
  const pinned = new Set(['a', 'b']);
  const cache = new ImageCache(bytes('a'), () => pinned);
  await cache.load('a', async () => image);
  await cache.load('b', async () => image);
  assert.equal(cache.get('a'), image);
  assert.equal(cache.get('b'), image);
  pinned.clear();
  cache.trim();
  assert.equal(cache.get('a'), undefined);
  assert.equal(cache.get('b'), image);
});

test('image cache shares in-flight reads without retaining resolved promises', async () => {
  const cache = new ImageCache(0);
  let resolve, calls = 0;
  const loader = () => { calls++; return new Promise(done => { resolve = done; }); };
  const first = cache.load('a', loader), second = cache.load('a', loader);
  await Promise.resolve();
  resolve(image);
  assert.equal(await first, image);
  assert.equal(await second, image);
  assert.equal(calls, 1);
  assert.equal(cache.get('a'), undefined);
  assert.equal(await cache.load('a', async () => image), image);
});

test('invalid or failed image reads keep the fallback and can be retried', async () => {
  const cache = new ImageCache();
  assert.equal(await cache.load('bad', async () => 'https://example.com/image.png'), null);
  assert.equal(await cache.load('bad', async () => image), null);
  assert.equal(await cache.load('missing', async () => null), null);
  assert.equal(await cache.load('retry', async () => { throw Error('unavailable'); }), null);
  assert.equal(await cache.load('retry', async () => image), image);
});
