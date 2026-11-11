/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { clampPercent, formatCost, formatTokens, resetLabel, resetTime, sortedWindows, totalTokens, usageTone } from '../src/store/slash.ts';

const MIN = 60_000;

test('reset times read ISO strings, seconds and milliseconds', () => {
  assert.equal(resetTime('2026-01-01T00:00:00Z'), Date.UTC(2026, 0, 1));
  assert.equal(resetTime(1_700_000_000), 1_700_000_000_000);
  assert.equal(resetTime('1700000000'), 1_700_000_000_000);
  assert.equal(resetTime(1_700_000_000_000), 1_700_000_000_000);
  assert.equal(resetTime(null), null);
  assert.equal(resetTime('soon'), null);
});

test('countdowns name the largest units', () => {
  const now = 1_000_000;
  assert.equal(resetLabel(null, now), '');
  assert.equal(resetLabel(now + 30_000, now), 'Resets now');
  assert.equal(resetLabel(now + 47 * MIN, now), 'Resets in 47m');
  assert.equal(resetLabel(now + 134 * MIN, now), 'Resets in 2h 14m');
  assert.equal(resetLabel(now + 120 * MIN, now), 'Resets in 2h');
  assert.equal(resetLabel(now + (3 * 1440 + 4 * 60) * MIN, now), 'Resets in 3d 4h');
});

test('bars clamp and turn warning then danger', () => {
  assert.equal(clampPercent(140), 100);
  assert.equal(clampPercent(-3), 0);
  assert.equal(clampPercent('x'), 0);
  assert.equal(usageTone(10), 'success');
  assert.equal(usageTone(70), 'warning');
  assert.equal(usageTone(95), 'danger');
  assert.deepEqual(sortedWindows([{ label: 'a', usedPercent: 10 }, { label: 'b', usedPercent: 90 }]).map(w => w.label), ['b', 'a']);
});

test('tokens and cost read compactly', () => {
  assert.equal(formatTokens(950), '950');
  assert.equal(formatTokens(12_300), '12.3K');
  assert.equal(formatTokens(4_000_000), '4M');
  assert.equal(formatTokens(250_000_000), '250M');
  assert.equal(formatTokens(1_200_000_000), '1.2B');
  assert.equal(formatCost(0), '$0');
  assert.equal(formatCost(0.004), '<$0.01');
  assert.equal(formatCost(6.4), '$6.40');
  assert.equal(formatCost(12), '$12');
  assert.equal(formatCost(148.3), '$148');
  assert.equal(totalTokens({ input: 1, cacheRead: 2, cacheWrite: 3, output: 4 }), 10);
  assert.equal(totalTokens(null), 0);
});
