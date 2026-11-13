import test from 'node:test';
import assert from 'node:assert/strict';
import { FILL_MARGIN, MIN_TAIL_TURNS, MIN_TRIM_MESSAGES, MIN_TRIM_TURNS, MORE_TURNS, OPEN_BUDGET, ROWS_MARGIN, ROW_BUDGET, TAIL_TURNS, TRIM_SLACK, joinIndex, rowsIntact, sharedEnds, swapRowNodes, trimCount, turnIds, WEIGHT_CHARS, viewIndex, widerWindow, windowAnchor, windowShort, windowStart, untouchedFields } from '../src/transcript-rows.ts';

/** `count` turns of `size` messages each, with ids unique across the thread. */
const turns = (count, size = 2) => Array.from({ length: count }, (_, turn) => Array.from({ length: size }, (_, message) => String(turn * size + message)));

test('a thread opens from its newest turns', () => {
  assert.equal(windowStart(turns(TAIL_TURNS + 10, 1), undefined), 10);
});

test('a short thread draws every turn', () => {
  assert.equal(windowStart(turns(3), undefined), 0);
  assert.equal(windowStart(turns(TAIL_TURNS, 1), undefined), 0);
  assert.equal(windowStart([], undefined), 0);
});

test('an agent-heavy thread opens within the open budget, not just the turn limit', () => {
  const list = turns(20, 10);
  const from = windowStart(list, undefined);
  assert.equal(from, 20 - OPEN_BUDGET / 10);
  assert.ok(list.slice(from).flat().length <= OPEN_BUDGET);
});

test('a full page of messages opens well short of the whole page', () => {
  const list = turns(50);
  assert.ok(list.slice(windowStart(list, undefined)).flat().length <= OPEN_BUDGET);
});

test('one turn larger than the budget still opens, with the turn before it', () => {
  const list = [...turns(5), Array.from({ length: OPEN_BUDGET * 2 }, (_, index) => `big:${index}`)];
  assert.equal(windowStart(list, undefined), list.length - MIN_TAIL_TURNS);
});

test('a redraw keeps the window as new turns arrive', () => {
  const list = turns(100);
  assert.equal(windowStart(list, list[40][0]), 40);
  assert.equal(windowStart(turns(101), list[40][0]), 40);
});

test('a window stays put when an older page joins its oldest turn', () => {
  const joined = [['older'], ['cut', '10', '11'], ['12', '13']];
  assert.equal(windowStart(joined, '10'), 1);
});

test('a fully drawn thread stays fully drawn', () => {
  assert.equal(windowStart(turns(100), null), 0);
});

test('a window whose anchor is gone draws everything rather than hide what was shown', () => {
  assert.equal(windowStart(turns(100), 'gone'), 0);
});

test('widening steps up by MORE_TURNS and ends at the start of the thread', () => {
  const list = turns(MORE_TURNS * 2 + 5, 1);
  assert.equal(widerWindow(list, MORE_TURNS + 5), 5);
  assert.equal(widerWindow(list, 5), 0);
  assert.equal(widerWindow(list, MORE_TURNS), 0);
  assert.equal(widerWindow(list, 0), 0);
});

test('widening stops at the row budget and always makes progress', () => {
  const list = turns(40, 10);
  assert.equal(widerWindow(list, 30), 30 - ROW_BUDGET / 10);
  const huge = [Array.from({ length: ROW_BUDGET * 2 }, (_, index) => `big:${index}`), ['a'], ['b']];
  assert.equal(widerWindow(huge, 1), 0);
});

test('a backfill step is bounded by the budget alone', () => {
  const list = turns(80);
  assert.equal(widerWindow(list, 70, Infinity), 70 - ROW_BUDGET / 2);
});

test('repeated turn keys cannot stall or misplace the window, since it anchors on message ids', () => {
  const repeated = [{ key: 'same', activity: [{ id: 1 }], errors: [], notes: [] }, { key: 'same', activity: [{ id: 2 }], errors: [], notes: [] }, { key: 'same', activity: [{ id: 3 }], errors: [], notes: [] }];
  const list = repeated.map(turnIds);
  assert.equal(windowStart(list, windowAnchor(list, 2)), 2);
  assert.equal(widerWindow(list, 2, 1), 1);
  assert.equal(windowAnchor(list, 1), '2');
});

test('the anchor is null only for the whole thread', () => {
  const list = turns(3);
  assert.equal(windowAnchor(list, 0), null);
  assert.equal(windowAnchor(list, 1), '2');
});

test('a turn lists its messages in order, or its key when it holds none', () => {
  assert.deepEqual(turnIds({ key: 'k', user: { id: 1 }, activity: [{ id: 2 }, { id: 3 }], final: { id: 4 }, errors: [{ id: 5 }], notes: [] }), ['1', '2', '3', '4', '5']);
  assert.deepEqual(turnIds({ key: 'k', handoff: { id: 9 }, activity: [], errors: [], notes: [] }), ['9']);
  assert.deepEqual(turnIds({ key: 'k', activity: [], errors: [], notes: [] }), ['k']);
});

test('long text weighs a turn like more messages, tool records do not, and a step still takes one turn', () => {
  const reply = (id, chars) => ({ key: `k${id}`, user: { id, role: 'user', content: 'q' }, final: { id: id + 1, role: 'assistant', content: 'x'.repeat(chars) }, activity: [{ id: id + 2, role: 'tool', content: 'y'.repeat(100_000) }], errors: [], notes: [] });
  assert.equal(turnIds(reply(1, 10)).weight, 3);
  assert.equal(turnIds(reply(1, 31_000)).weight, 3 + Math.floor(31_001 / WEIGHT_CHARS)); // 3 messages + 15
  const long = Array.from({ length: 20 }, (_, n) => turnIds(reply(n * 10, 31_000)));
  // Twenty 31 KB replies: the open takes what the budget holds (never fewer than MIN_TAIL_TURNS), not all twenty.
  const from = windowStart(long, undefined);
  assert.ok(long.length - from >= MIN_TAIL_TURNS && long.length - from <= 3, `opened with ${long.length - from} turns`);
  // A step takes turns up to its budget (18 + 18 of 40), and always one however heavy.
  assert.equal(widerWindow(long, from), from - 2);
  assert.equal(widerWindow([turnIds(reply(1, 1_000_000)), ...long], 1), 0);
});

test('rows are intact only while every one is still in the host, and no rows never are', () => {
  const host = {}, inside = { parentNode: host }, outside = { parentNode: null };
  assert.equal(rowsIntact(host, [{ html: '', nodes: [inside] }]), true);
  assert.equal(rowsIntact(host, [{ html: '', nodes: [inside] }, { html: '', nodes: [outside] }]), false);
  assert.equal(rowsIntact(host, []), false);
});

test('shared ends find an appended turn, a prepended page and a change in the middle', () => {
  assert.deepEqual(sharedEnds(['a', 'b'], ['a', 'b', 'c']), { start: 2, end: 0 });
  assert.deepEqual(sharedEnds(['b', 'c'], ['a', 'b', 'c']), { start: 0, end: 2 });
  assert.deepEqual(sharedEnds(['a', 'x', 'c'], ['a', 'y', 'c']), { start: 1, end: 1 });
  assert.deepEqual(sharedEnds(['a', 'b'], ['a', 'b']), { start: 2, end: 0 });
  assert.deepEqual(sharedEnds([], ['a']), { start: 0, end: 0 });
});

test('shared ends never count one row twice', () => {
  assert.deepEqual(sharedEnds(['a', 'a'], ['a', 'a', 'a']), { start: 2, end: 0 });
  assert.deepEqual(sharedEnds(['a', 'a', 'a'], ['a']), { start: 1, end: 0 });
});

test('a turn finds the first view matching its key or any of its tools', () => {
  const views = [{ key: 'one', toolKeys: ['t1'] }, { key: 'two', toolKeys: ['t2', 't3'] }, { key: 'three', toolKeys: ['t3'] }];
  const find = viewIndex(views);
  assert.equal(find('two', []), views[1]);
  assert.equal(find('other', ['t3']), views[1]);
  assert.equal(find('three', ['t1']), views[0], 'the earlier view wins, as a linear search would pick it');
  assert.equal(find('other', ['none', undefined]), undefined);
  assert.equal(find(undefined, []), undefined);
});

test('a window is short until it clears the viewport by the margin, and a hidden scroller never is', () => {
  assert.equal(windowShort(700, 700), true);
  assert.equal(windowShort(700 + FILL_MARGIN - 1, 700), true);
  assert.equal(windowShort(700 + FILL_MARGIN, 700), false);
  assert.equal(windowShort(0, 0), false);
});

test('a fetched page joins at the first drawn turn, which may have gained messages', () => {
  const drawn = [['10', '11'], ['12', '13']];
  assert.equal(joinIndex(drawn, [['8'], ['10', '11'], ['12', '13']]), 1);
  assert.equal(joinIndex(drawn, [['8'], ['9', '10', '11'], ['12', '13']]), 1);
  assert.equal(joinIndex(drawn, [['9', '10', '11'], ['12', '13']]), 0);
});

test('a page that changes any other turn does not join, so the transcript draws afresh', () => {
  const drawn = [['10', '11'], ['12', '13']];
  assert.equal(joinIndex(drawn, [['10', '11', '12', '13']]), undefined);
  assert.equal(joinIndex(drawn, [['8'], ['10', '11'], ['12', '14']]), undefined);
  assert.equal(joinIndex(drawn, [['8'], ['9'], ['12', '13']]), undefined);
  assert.equal(joinIndex([], [['8']]), undefined);
});

test('a trim drops rows up to the limit while the reader stays out of reach of the top', () => {
  const tops = Array.from({ length: 30 }, (_, index) => index * 100);
  assert.equal(trimCount(tops, 20, 10_000), 20);
  const far = ROWS_MARGIN + TRIM_SLACK;
  assert.equal(trimCount(tops, 20, far + 1500), 14, 'row 15 would leave the reader exactly at the line');
});

test('a trim too small to be worth a layout does nothing', () => {
  const tops = Array.from({ length: 30 }, (_, index) => index * 100);
  assert.equal(trimCount(tops, MIN_TRIM_TURNS - 1, 10_000), 0);
  assert.equal(trimCount(tops, 20, ROWS_MARGIN), 0);
});

test('rows heavy in messages trim by weight even when they are short in pixels', () => {
  // Three folded agent turns, a line tall each but a hundred messages apiece, with the reader just under them.
  const tops = [0, 40, 80, 120, 160], weights = [100, 100, 100, 2, 2];
  assert.equal(trimCount(tops, 3, 120 + FILL_MARGIN), 0, "counted as one message each they are too few");
  assert.equal(trimCount(tops, 3, 120 + FILL_MARGIN, weights), 3);
  assert.equal(trimCount(tops, 3, 1000, weights), 3);
  // Not so many that the window could no longer scroll.
  assert.equal(trimCount(tops, 3, 120 + FILL_MARGIN - 1, weights), 2);
  assert.equal(trimCount(tops, 3, 40 + FILL_MARGIN - 1, weights), 0);
  // Light rows that short stay: a trim of a few messages is not worth a layout.
  assert.equal(trimCount(tops, 3, 1000, [1, 1, 1, 1, 1]), 0);
  assert.equal(trimCount(tops, 2, 1000, [MIN_TRIM_MESSAGES - 1, 0, 0, 0, 0]), 0);
});

test('swapped nodes replace the fresh ones in their rows and leave the others alone', () => {
  const fresh = { fresh: true }, kept = { kept: true }, other = { other: true };
  const untouched = { html: 'b', nodes: [other] }, rows = [{ html: 'a', nodes: [fresh] }, untouched];
  const swapped = swapRowNodes(rows, new Map([[fresh, kept]]));
  assert.deepEqual(swapped[0], { html: 'a', nodes: [kept] });
  assert.equal(swapped[1], untouched);
  assert.deepEqual(rows[0].nodes, [fresh], 'the input is not mutated');
});

test('a lazy group keeps its rows and draws no tool body', async () => {
  const { renderToolGroup } = await import('../src/tool-activity.ts');
  const tool = (id, output) => JSON.stringify({ type: 'tool_activity', version: 1, id, name: 'Read', status: 'completed', input: 'a.ts', output });
  const entries = [{ key: 'tool:a', content: tool('a', 'first body'), id: '11' }, { key: 'tool:b', content: tool('b', 'second body'), id: '12' }, { key: 'tool:c', content: 'Read old.ts\nlegacy body', id: '13' }];
  const full = renderToolGroup(entries, true), shell = renderToolGroup(entries, true, false, true);
  for (const id of ['11', '12', '13']) assert.match(shell, new RegExp(`data-tool-body="${id}"></div></details>`));
  assert.doesNotMatch(shell, /first|second|legacy body/);
  assert.equal(shell.match(/data-tool-key=/g).length, full.match(/data-tool-key=/g).length);
  assert.equal(shell.match(/<details/g).length, shell.match(/<\/details>/g).length);
});

test('late details apply only to fields left as they were when they were asked for', () => {
  const asked = { title: 'Old', model: 'a', status: 'idle', pinned: false, goal: { done: false } };
  const current = { ...asked, title: 'Renamed', goal: { done: false } };
  const details = { title: 'Server', model: 'b', status: 'running', pinned: true, goal: { done: true } };
  assert.deepEqual(untouchedFields(details, current, asked, ['pinned']), { model: 'b', status: 'running', goal: { done: true } }, 'a field renamed here keeps its newer value; equal objects count as unchanged');
  assert.deepEqual(untouchedFields(details, current, asked, ['pinned', 'status']), { model: 'b', goal: { done: true } }, 'held fields never apply');
  assert.deepEqual(untouchedFields(details, current, undefined, []), details, 'a record unknown when asked takes every field');
});
