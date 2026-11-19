import test from 'node:test';
import assert from 'node:assert/strict';
import { dockOverlap } from '../src/error-dock-overlap.ts';

test('dockOverlap returns 0 when the dock is missing or has zero width', () => {
  assert.equal(dockOverlap(900, null), 0);
  assert.equal(dockOverlap(900, { left: 850, width: 0 }), 0);
  assert.equal(dockOverlap(900, { left: 850, width: -12 }), 0);
});

test('dockOverlap returns 0 for non-finite cardRight values', () => {
  const dock = { left: 800, width: 44 };
  assert.equal(dockOverlap(Number.NaN, dock), 0);
  assert.equal(dockOverlap(Number.POSITIVE_INFINITY, dock), 0);
  assert.equal(dockOverlap(Number.NEGATIVE_INFINITY, dock), 0);
});

test('dockOverlap returns 0 when the card sits clear of the dock', () => {
  assert.equal(dockOverlap(700, { left: 900, width: 44 }), 0);
  assert.equal(dockOverlap(889, { left: 900, width: 44 }), 0);
});

test('dockOverlap respects the exact 10px gap boundary', () => {
  const dock = { left: 900, width: 44 };
  assert.equal(dockOverlap(890, dock), 0);
  assert.equal(dockOverlap(891, dock), 1);
});

test('dockOverlap returns the reach into the gap and over the dock', () => {
  const dock = { left: 900, width: 44 };
  assert.equal(dockOverlap(895, dock), 5);
  assert.equal(dockOverlap(900, dock), 10);
  assert.equal(dockOverlap(924, dock), 34);
});

test('dockOverlap rounds fractional overlap pixels up', () => {
  assert.equal(dockOverlap(890.01, { left: 900, width: 44 }), 1);
  assert.equal(dockOverlap(895.2, { left: 900, width: 44 }), 6);
  assert.equal(dockOverlap(890.4, { left: 900.4, width: 44 }), 0);
  assert.equal(dockOverlap(890.5, { left: 900.4, width: 44 }), 1);
});
