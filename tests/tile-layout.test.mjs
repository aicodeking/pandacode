import test from 'node:test';
import assert from 'node:assert/strict';
import { MAX_TILES, MIN_TILE_HEIGHT, MIN_TILE_WIDTH, TILE_GAP, tileAt, tileRects, tilesThatFit } from '../src/tile-layout.ts';

const overlaps = (a, b) => a.left < b.left + b.width && b.left < a.left + a.width && a.top < b.top + b.height && b.top < a.top + a.height;

test('every tile stays in bounds, clears the minimum and overlaps nothing', () => {
  for (const [width, height] of [[1600, 1000], [1200, 840], [900, 820], [700, 700], [560, 900]]) {
    for (let tiles = 1; tiles <= MAX_TILES; tiles++) {
      const rects = tileRects(tiles, width, height);
      if (!rects) continue;
      assert.equal(rects.length, tiles);
      rects.forEach((rect, i) => {
        assert.ok(rect.left >= 0 && rect.top >= 0, `${tiles} tiles at ${width}x${height}`);
        assert.ok(rect.left + rect.width <= width && rect.top + rect.height <= height, `${tiles} tiles at ${width}x${height}`);
        if (tiles > 1) assert.ok(rect.width >= MIN_TILE_WIDTH - 1 && rect.height >= MIN_TILE_HEIGHT - 1);
        rects.slice(i + 1).forEach(other => assert.ok(!overlaps(rect, other)));
      });
    }
  }
});

test('two threads sit side by side on an ordinary pane', () => {
  const [a, b] = tileRects(2, 900, 820);
  assert.equal(a.top, b.top);
  assert.equal(b.left, a.left + a.width + TILE_GAP);
});

test('the rows use the whole area', () => {
  const rects = tileRects(6, 1200, 840);
  assert.equal(Math.max(...rects.map(rect => rect.left + rect.width)), 1200);
  assert.equal(Math.max(...rects.map(rect => rect.top + rect.height)), 840);
  assert.deepEqual(rects.slice(0, 3).map(rect => rect.top), [0, 0, 0]);
});

test('five tiles put the extra one in the first row', () => {
  const rects = tileRects(5, 1200, 840);
  assert.equal(rects.filter(rect => rect.top === 0).length, 3);
  assert.equal(rects.filter(rect => rect.top > 0).length, 2);
});

test('an area too small for the count refuses it', () => {
  assert.equal(tileRects(6, 500, 400), null);
  assert.equal(tileRects(2, 400, 300), null);
  assert.equal(tilesThatFit(400, 300), 1);
  assert.equal(tilesThatFit(600, 300), 2);
  assert.equal(tilesThatFit(1600, 1000), MAX_TILES);
});

test('a point finds its tile and which side of it', () => {
  const rects = tileRects(2, 900, 820);
  assert.deepEqual(tileAt(rects, 10, 400), { index: 0, after: false });
  assert.deepEqual(tileAt(rects, 400, 400), { index: 0, after: true });
  assert.deepEqual(tileAt(rects, 880, 400), { index: 1, after: true });
  // Past the edge still lands on the nearest.
  assert.equal(tileAt(rects, 2000, -50).index, 1);
  assert.equal(tileAt([], 0, 0), null);
});

test('a tile with a row to itself splits by height', () => {
  const rects = tileRects(2, 400, 900);
  assert.notEqual(rects[0].top, rects[1].top);
  assert.deepEqual(tileAt(rects, 200, rects[0].height - 5), { index: 0, after: true });
  assert.deepEqual(tileAt(rects, 200, 5), { index: 0, after: false });
});
