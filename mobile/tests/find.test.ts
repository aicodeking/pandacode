/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { Message } from '../src/connect/types.ts';
import { findHits, firstHit, fold, hitLabel, JUMP_PAGES, jumpStep, keepHit, listIndex, messageParam, rowOfMessage, rowText, stepHit } from '../src/store/find.ts';
import { turnRows } from '../src/store/turns.ts';

const m = (id: number, role: string, content: string): Message => ({ id, role, content, createdAt: id, turnDurationMs: null });
const rows = turnRows([
  m(1, 'user', 'Fix the Login bug'),
  m(2, 'tool', '{"cmd":"grep login"}'),
  m(3, 'assistant', 'Looking at login.ts now'),
  m(4, 'assistant', 'Fixed the login and the café menu. LOGIN works.'),
  m(5, 'user', 'Thanks'),
]);

test('matches are case- and accent-insensitive, oldest first, with counts', () => {
  const hits = findHits(rows, 'login');
  assert.deepEqual(hits, [{ rowId: 'u1', count: 1 }, { rowId: 'w2', count: 1 }, { rowId: 'r4', count: 2 }]);
  assert.deepEqual(findHits(rows, 'CAFE').map(h => h.rowId), ['r4']);
  assert.equal(fold('Café'), 'cafe');
});

test('tool call JSON is not searched; narration in the work row is', () => {
  const work = rows.find(r => r.kind === 'work');
  assert.ok(work);
  assert.equal(rowText(work), 'Looking at login.ts now');
  assert.deepEqual(findHits(rows, 'grep'), []);
});

test('short or empty queries match nothing and say nothing', () => {
  assert.deepEqual(findHits(rows, ' l '), []);
  assert.equal(hitLabel(-1, [], 'l'), '');
  assert.equal(hitLabel(-1, [], 'zzz'), 'No matches');
});

test('a search lands on the newest match and steps wrap both ways', () => {
  const hits = findHits(rows, 'login');
  assert.equal(firstHit(hits), 2);
  assert.equal(firstHit([]), -1);
  assert.equal(stepHit(2, 3, -1), 1);
  assert.equal(stepHit(0, 3, -1), 2);
  assert.equal(stepHit(2, 3, 1), 0);
  assert.equal(stepHit(-1, 3, 1), 0);
  assert.equal(stepHit(0, 0, 1), -1);
  assert.equal(hitLabel(2, hits, 'login'), '3 of 3');
});

test('the current match survives an older page arriving', () => {
  const before = findHits(rows, 'login');
  const older = turnRows([m(0, 'user', 'login first'), ...[1, 2, 3, 4, 5].map(id => m(id, ['user', 'tool', 'assistant', 'assistant', 'user'][id - 1], ['Fix the Login bug', '{}', 'Looking at login.ts now', 'Fixed the login', 'Thanks'][id - 1]))]);
  const after = findHits(older, 'login');
  assert.equal(keepHit(before[1].rowId, after), 2);
  assert.equal(keepHit('gone', after), after.length - 1);
});

test('list index follows the inverted data', () => {
  const inverted = [...rows].reverse();
  assert.equal(listIndex(inverted, 'u1'), rows.length - 1);
  assert.equal(listIndex(rows, 'u1'), 0);
  assert.equal(listIndex(rows, 'nope'), -1);
});

test('a message id maps to the row that shows it', () => {
  assert.equal(rowOfMessage(rows, 1), 'u1');
  assert.equal(rowOfMessage(rows, 2), 'w2'); // a tool call, folded in the work row
  assert.equal(rowOfMessage(rows, 3), 'w2'); // narration in the work row
  assert.equal(rowOfMessage(rows, 4), 'r4');
  assert.equal(rowOfMessage(rows, 99), undefined);
  const noted = turnRows([m(1, 'user', 'go'), m(2, 'error', 'boom')]);
  assert.equal(rowOfMessage(noted, 2), 'n2');
});

test('a jump shows a loaded row, waits for the copy, then asks for older pages within bounds', () => {
  const base = { rows, oldest: 1, ready: true, older: undefined, pages: 0 } as const;
  assert.deepEqual(jumpStep(4, base), { kind: 'show', rowId: 'r4' });
  // A cached row shows even before the copy settles.
  assert.deepEqual(jumpStep(4, { ...base, ready: false }), { kind: 'show', rowId: 'r4' });
  assert.deepEqual(jumpStep(0, { ...base, ready: false, older: 'more' }), { kind: 'wait' });
  assert.deepEqual(jumpStep(0, { ...base, older: 'loading' }), { kind: 'wait' });
  assert.deepEqual(jumpStep(0, { ...base, older: 'more' }), { kind: 'older' });
  assert.deepEqual(jumpStep(0, { ...base, older: 'more', pages: JUMP_PAGES }), { kind: 'missing' });
  assert.deepEqual(jumpStep(0, base), { kind: 'missing' }); // nothing older to load
  // Inside the loaded range but on no row: older pages can't hold it.
  assert.deepEqual(jumpStep(99, { ...base, older: 'more' }), { kind: 'missing' });
  // Nothing loaded at all yet, but the copy settled with older pages known.
  assert.deepEqual(jumpStep(5, { rows: [], oldest: undefined, ready: true, older: 'more', pages: 0 }), { kind: 'older' });
});

test('the message route param takes only a positive integer', () => {
  assert.equal(messageParam('42'), 42);
  assert.equal(messageParam(['7', '8']), 7);
  for (const bad of [undefined, '', '0', '-3', '4.5', 'abc', '1e3', '9'.repeat(20)]) assert.equal(messageParam(bad), undefined);
});
