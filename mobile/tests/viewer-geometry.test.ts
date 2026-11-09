/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { draggedRect, fitRect, isOnScreen, panBounds } from '../src/ui/viewer-geometry.ts';

const W = 400;
const H = 800;

test('a landscape image fits the width, a tall one the height, both centred', () => {
  assert.deepEqual(fitRect(2, W, H), { width: 400, height: 200, x: 0, y: 300 });
  assert.deepEqual(fitRect(0.25, W, H), { width: 200, height: 800, x: 100, y: 0 });
});

test('a zoomed landscape image cannot pan vertically until it covers the screen', () => {
  assert.deepEqual(panBounds(2, 2, W, H), { x: 200, y: 0 });
  assert.deepEqual(panBounds(2, 5, W, H), { x: 800, y: 100 });
  assert.deepEqual(panBounds(2, 1, W, H), { x: 0, y: 0 });
});

test('a dragged image scales about the window centre, then moves down', () => {
  const fitted = fitRect(1, W, H);
  assert.deepEqual(draggedRect(fitted, 1, 0, W, H), fitted);
  assert.deepEqual(draggedRect(fitted, 0.5, 100, W, H), { x: 100, y: 400, width: 200, height: 200 });
});

test('only a laid-out thumbnail overlapping the window counts', () => {
  assert.equal(isOnScreen({ x: 10, y: 10, width: 50, height: 50 }, W, H), true);
  assert.equal(isOnScreen({ x: 10, y: -60, width: 50, height: 50 }, W, H), false);
  assert.equal(isOnScreen({ x: 10, y: H, width: 50, height: 50 }, W, H), false);
  assert.equal(isOnScreen({ x: 0, y: 0, width: 0, height: 0 }, W, H), false);
});
