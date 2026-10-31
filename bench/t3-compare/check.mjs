// Self-check for the workload and both delivery schedules: `node bench/t3-compare/check.mjs`.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { W1_TEXT, W1_DELTAS, W1_TIMES, SENTINEL } from './workload.mjs';
import { pandacodeSchedule, t3Schedule } from './schedule.mjs';

assert.equal(Buffer.byteLength(W1_TEXT), 50_000);
assert.equal(W1_TEXT.length, 50_000); // ASCII only
assert.equal(W1_DELTAS.length, 2_000);
assert.ok(W1_DELTAS.every(d => d.length === 25));
assert.ok(W1_TEXT.endsWith(`${SENTINEL}\n`));
assert.equal((W1_TEXT.match(/^```/gm) ?? []).length % 2, 0, 'every code fence is closed');
for (const kind of [/^## /m, /^- /m, /^1\. /m, /^```ts$/m, /^\| --- /m, /^> /m]) assert.match(W1_TEXT, kind);

const sizes = W1_DELTAS.map(d => d.length);
for (const [name, plan] of [['pandacode', pandacodeSchedule(W1_TIMES, sizes)], ['t3', t3Schedule(W1_TIMES, sizes)]]) {
  assert.equal(plan.at(-1).end, 50_000, `${name} delivers the whole text`);
  assert.equal(plan.at(-1).at, W1_TIMES.at(-1), `${name} ends at the last delta`);
  plan.reduce((a, b) => (assert.ok(b.at >= a.at && b.end >= a.end, `${name} is ordered`), b));
}
// Small hand-made cases.
assert.deepEqual(pandacodeSchedule([0, 10, 20, 40], [1, 1, 1, 1]), [{ at: 33, end: 3 }, { at: 40, end: 4 }]);
assert.deepEqual(pandacodeSchedule([0, 1], [9000, 1]), [{ at: 0, end: 9000 }, { at: 1, end: 9001 }]);
assert.deepEqual(t3Schedule([0, 10, 60, 70], [1, 1, 1, 1]), [{ at: 70, end: 2 }, { at: 70, end: 4 }]);
console.log('ok', createHash('sha256').update(W1_TEXT).digest('hex').slice(0, 16),
  'pandacode events', pandacodeSchedule(W1_TIMES, sizes).length, 't3 events', t3Schedule(W1_TIMES, sizes).length);
