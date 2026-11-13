import test from 'node:test';
import assert from 'node:assert/strict';
import { errorKey, groupErrors, errorSummary, shouldAnnounce, stripErrorPrefix, savedErrorId, parseDismissJournal, dismissJournal, foldErrorTurns, hiddenRunErrors } from '../src/thread-errors.ts';

const DNS = "API Error: Can't reach the API server — check your internet or DNS (ENOTFOUND)";
const err = (id, content) => ({ id, content });

test('errorKey strips one leading Error: prefix, trims and collapses whitespace', () => {
  assert.equal(errorKey(`Error: ${DNS}`), errorKey(DNS));
  assert.equal(errorKey('  a \n\t b   c '), 'a b c');
  assert.equal(errorKey('Error:   boom'), 'boom');
  assert.notEqual(errorKey('Error: Error: x'), errorKey('x'));
  assert.notEqual(errorKey('Boom'), errorKey('boom'));
});

test('errorKey handles empty and whitespace-only content', () => {
  assert.equal(errorKey(''), '');
  assert.equal(errorKey('   \n '), '');
});

test('errorKey is stable and bounded for very long content', () => {
  const long = 'x'.repeat(8192);
  assert.equal(errorKey(long), errorKey(long));
  assert.ok(errorKey(long).length <= 200);
  assert.notEqual(errorKey(long + 'a'), errorKey(long + 'b'));
  assert.notEqual(errorKey('y'.repeat(8000) + 'a'), errorKey('y'.repeat(8000) + 'b'));
});

test('identical x7 errors become one group with count 7', () => {
  const input = Array.from({ length: 7 }, (_, i) => err(i + 1, DNS));
  const groups = groupErrors(input);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].count, 7);
  assert.deepEqual(groups[0].ids, [1, 2, 3, 4, 5, 6, 7]);
  assert.equal(groups[0].content, DNS);
  assert.equal(groups[0].key, errorKey(DNS));
});

test('non-adjacent duplicates merge and first-occurrence order is kept', () => {
  const groups = groupErrors([err(1, 'A'), err(2, 'B'), err(3, 'A'), err(4, 'C'), err(5, 'B')]);
  assert.deepEqual(groups.map(g => g.content), ['A', 'B', 'C']);
  assert.deepEqual(groups.map(g => g.ids), [[1, 3], [2, 5], [4]]);
  assert.deepEqual(groups.map(g => g.count), [2, 2, 1]);
});

test('Error: prefix and whitespace differences are the same group; content is first occurrence stripped', () => {
  const groups = groupErrors([err('live', `Error: ${DNS}`), err(9, `  ${DNS}\n`), err(10, DNS.replace(/ /g, '  '))]);
  assert.equal(groups.length, 1);
  assert.equal(groups[0].content, DNS);
  assert.deepEqual(groups[0].ids, ['live', 9, 10]);
});

test('empty and whitespace-only errors group together without crashing', () => {
  const groups = groupErrors([err(1, ''), err(2, '  \n'), err(3, 'x')]);
  assert.deepEqual(groups.map(g => g.ids), [[1, 2], [3]]);
  assert.deepEqual(groupErrors([]), []);
});

test('groupErrors never mutates its input', () => {
  const input = Object.freeze([Object.freeze(err(1, 'Error: a')), Object.freeze(err(2, 'a'))]);
  const groups = groupErrors(input);
  assert.equal(input.length, 2);
  assert.equal(input[0].content, 'Error: a');
  groups[0].ids.push(99);
  assert.equal(groupErrors(input)[0].ids.length, 2);
});

test('errorSummary returns short single-line text with no detail', () => {
  assert.deepEqual(errorSummary('  boom  '), { summary: 'boom', detail: null });
  assert.deepEqual(errorSummary(''), { summary: '', detail: null });
});

test('errorSummary uses the first non-empty line; the detail is the rest, not the summary again', () => {
  const text = '\n\n  Request failed\n  at foo\n  at bar\n';
  assert.deepEqual(errorSummary(text), { summary: 'Request failed', detail: '  at foo\n  at bar' });
  // Blank lines between the summary and the rest are dropped; the rest keeps its indentation.
  assert.deepEqual(errorSummary('Failed  \n\n   \n    deep\nend'), { summary: 'Failed', detail: '    deep\nend' });
  // Only blank lines after the summary: nothing more to show.
  assert.deepEqual(errorSummary('Failed\n \n'), { summary: 'Failed', detail: null });
});

test('errorSummary keeps the full text as detail when the summary was clamped', () => {
  const text = 'y'.repeat(300) + '\nnext line';
  const out = errorSummary(text);
  assert.ok(out.summary.endsWith('…'));
  assert.equal(out.detail, text);
});

test('errorSummary clamps long lines with an ellipsis', () => {
  const long = 'z'.repeat(500);
  const out = errorSummary(long);
  assert.equal(out.summary.length, 240);
  assert.ok(out.summary.endsWith('…'));
  assert.equal(out.detail, long);
  const custom = errorSummary('abcdefghij', 5);
  assert.equal(custom.summary, 'abcd…');
  assert.equal(errorSummary('abcde', 5).detail, null);
});

test('shouldAnnounce respects the window and key', () => {
  assert.equal(shouldAnnounce(null, 'k', 1000), true);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'k', 1000), false);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'k', 10999), false);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'k', 11000), true);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'other', 1001), true);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'k', 1500, 100), true);
  assert.equal(shouldAnnounce({ key: 'k', at: 1000 }, 'k', 1050, 100), false);
});

test('shouldAnnounce treats a clock that moved backwards as inside the window', () => {
  assert.equal(shouldAnnounce({ key: 'k', at: 5000 }, 'k', 4000), false);
});

test('a row with a repeat count stands for that many events', () => {
  const groups = groupErrors([{ id: -1, content: `Error: ${DNS}`, count: 999 }, err(5, DNS), { id: 6, content: 'x', count: 0 }]);
  assert.deepEqual(groups.map(g => g.count), [1000, 1]);
  assert.deepEqual(groups[0].ids, [-1, 5]);
});

test('stripErrorPrefix removes one leading Error: and surrounding space', () => {
  assert.equal(stripErrorPrefix('  Error:  boom \n'), 'boom');
  assert.equal(stripErrorPrefix('Error: Error: x'), 'Error: x');
  assert.equal(stripErrorPrefix('fine'), 'fine');
});

test('savedErrorId: the saved row id an error event carries, nothing for anything else', () => {
  assert.equal(savedErrorId({ messageId: 42 }), 42);
  assert.equal(savedErrorId({ messageId: 42, code: 7 }), 42);
  for (const bad of [undefined, null, 'x', [], {}, { messageId: '42' }, { messageId: 0 }, { messageId: -3 }, { messageId: 1.5 }, { messageId: Number.MAX_SAFE_INTEGER + 2 }]) {
    assert.equal(savedErrorId(bad), undefined, JSON.stringify(bad));
  }
});

test('the dismissal journal round-trips saved ids per thread and drops anything malformed', () => {
  const raw = dismissJournal(new Map([['s1', new Set([5, 6])], ['s3', []]]));
  assert.deepEqual(JSON.parse(raw), { s1: [5, 6] });
  assert.deepEqual([...parseDismissJournal(raw)], [['s1', [5, 6]]]);
  assert.equal(dismissJournal(new Map()), null);
  assert.equal(dismissJournal(new Map([['s', []]])), null);
  for (const bad of [null, '', 'nope', '[]', '{"s":["1",-2,1.5]}', '{"s":{"after":7}}', '{"saved":{"s":[1]}}']) {
    assert.equal(parseDismissJournal(bad).size, 0, String(bad));
  }
  assert.deepEqual(parseDismissJournal('{"s":[3,"4",0],"t":[9]}').get('s'), [3]);
});

const turn = (fields) => ({ activity: [], errors: [], notes: [], key: `k${Math.random()}`, durationMs: null, estimated: false, ...fields });
const msg = (id, role, content = 'x') => ({ id, sessionId: 's', role, content, createdAt: id });

test('foldErrorTurns: folding an errors-only turn sums both run times and keeps estimated', () => {
  const kept = () => false;
  const [one] = foldErrorTurns([turn({ user: msg(1, 'user'), durationMs: 7000 }), turn({ errors: [msg(2, 'error')], durationMs: 3000, estimated: true })], kept);
  assert.equal(one.durationMs, 10_000);
  assert.equal(one.estimated, true);
  assert.equal(one.errors.length, 1);
  // An untimed side leaves the other's time alone.
  const [two] = foldErrorTurns([turn({ user: msg(1, 'user'), durationMs: 7000 }), turn({ errors: [msg(2, 'error')] })], kept);
  assert.deepEqual([two.durationMs, two.estimated], [7000, false]);
  const [three] = foldErrorTurns([turn({ user: msg(1, 'user') }), turn({ errors: [msg(2, 'error')], durationMs: 4000 })], kept);
  assert.deepEqual([three.durationMs, three.estimated], [4000, false]);
});

test('foldErrorTurns: drops hidden rows, keeps an untouched turn identical, marks an emptied one', () => {
  const first = turn({ user: msg(1, 'user'), errors: [msg(2, 'error')] }), second = turn({ user: msg(3, 'user'), errors: [msg(4, 'error')] });
  const shown = foldErrorTurns([first, second], message => message.id === 4);
  assert.equal(shown[0], first);
  assert.deepEqual([shown[1].errors, shown[1].errorsDismissed, shown[1].dismissedErrors], [[], true, 1]);
  // An errors-only turn left with nothing leaves no shell.
  assert.equal(foldErrorTurns([turn({ errors: [msg(5, 'error')] })], () => true).length, 0);
});

test('hiddenRunErrors: hides matching errors copied after the dismissal, in that run only', () => {
  const boom = 'Error: Boom', key = errorKey(boom);
  const messages = [msg(1, 'user'), msg(2, 'error', boom), msg(3, 'user'), msg(10, 'tool'), msg(11, 'error', boom), msg(12, 'error', 'Other'), msg(13, 'error', 'Boom'), msg(14, 'user'), msg(15, 'error', boom)];
  assert.deepEqual([...hiddenRunErrors(messages, [{ key, after: 9 }])], [11, 13]);
  // The run's own prompt copied after the dismissal starts it, it does not end it.
  const copied = [msg(1, 'user'), msg(10, 'user'), msg(11, 'error', boom), msg(12, 'user'), msg(13, 'error', boom)];
  assert.deepEqual([...hiddenRunErrors(copied, [{ key, after: 9 }])], [11]);
  assert.deepEqual([...hiddenRunErrors(messages, [])], []);
});
