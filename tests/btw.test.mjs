import test from 'node:test';
import assert from 'node:assert/strict';
import { mainContext, parseBtw, readLinks, sideTitle, tail, writeLink } from '../src/btw.ts';

const main = { title: 'Build search', status: 'running' };
const history = [
  { id: 1, role: 'user', content: 'Add search' },
  { id: 2, role: 'tool', content: '{"type":"tool_activity"}' },
  { id: 3, role: 'assistant', content: 'Added an index.' },
];

test('/btw is parsed only at the start of a prompt', () => {
  assert.equal(parseBtw('/btw what is X?'), 'what is X?');
  assert.equal(parseBtw('  /BTW  multi\nline '), 'multi\nline');
  assert.equal(parseBtw('/btw'), '');
  assert.equal(parseBtw('/btwx hi'), null);
  assert.equal(parseBtw('say /btw hi'), null);
});

test('side threads are titled BTW and fit the sidebar', () => {
  assert.equal(sideTitle('why  is\nthis slow'), 'BTW: why is this slow');
  assert.ok(sideTitle('x'.repeat(200)).length <= 53);
});

test('the first message carries the recent tail, later ones only what is new', () => {
  const first = mainContext(main, history, 0);
  assert.match(first.text, /^\n\nMain thread context: "Build search" \(running\)/);
  assert.match(first.text, /Recent main-thread messages:/);
  assert.match(first.text, /User: Add search\n\nAgent: Added an index\./);
  assert.doesNotMatch(first.text, /tool_activity/);
  assert.equal(first.seenId, 3);

  const later = mainContext(main, [...history, { id: 5, role: 'user', content: 'Now sort it' }], first.seenId, 'Sorting by');
  assert.match(later.text, /New in the main thread since your last message:/);
  assert.doesNotMatch(later.text, /Add search/);
  assert.match(later.text, /User: Now sort it\n\nAgent \(still writing\): Sorting by$/);
  assert.equal(later.seenId, 5);

  const idle = mainContext(main, history, 3);
  assert.match(idle.text, /Nothing new in the main thread/);
  assert.equal(idle.seenId, 3);
});

test('context stays bounded, keeps the newest text, and says when it is cut', () => {
  const long = Array.from({ length: 40 }, (_, i) => ({ id: i + 1, role: i % 2 ? 'assistant' : 'user', content: `entry ${i} ` + 'é'.repeat(1000) }));
  const { text, seenId } = mainContext(main, long, 0, '', 8 * 1024);
  assert.ok(new TextEncoder().encode(text).length < 8 * 1024 + 600);
  assert.match(text, /entry 39/);
  assert.doesNotMatch(text, /entry 0 /);
  assert.match(text, /Older main-thread text was left out to stay within 8 KB\./);
  assert.equal(seenId, 40);
});

test('links are stored per main thread and tolerate bad storage', () => {
  const data = new Map();
  const storage = { getItem: key => data.get(key) ?? null, setItem: (key, value) => data.set(key, value) };
  writeLink(storage, 'main', { sideId: 'side', seenId: 3 });
  assert.deepEqual(readLinks(storage).main, { sideId: 'side', seenId: 3 });
  writeLink(storage, 'main', null);
  assert.deepEqual(readLinks(storage), {});
  data.set('pandacode.btw', 'not json');
  assert.deepEqual(readLinks(storage), {});
});

test('/btw takes text after blank lines, and titles drop Markdown markers', () => {
  assert.equal(parseBtw('/btw\n\nwhat is X?'), 'what is X?');
  assert.equal(sideTitle('why is **`search`** _slow_?'), 'BTW: why is search slow?');
});

test('tail keeps whole code points within the byte limit', () => {
  const size = value => new TextEncoder().encode(value).length;
  assert.equal(tail('short', 100), 'short');
  const emoji = 'a'.repeat(50) + '😀' + 'b'.repeat(10);
  for (let limit = 8; limit < 30; limit++) {
    const cut = tail(emoji, limit);
    assert.ok(size(cut) <= limit, `limit ${limit}`);
    assert.ok(cut.startsWith('…'));
    assert.doesNotMatch(cut, /[\uD800-\uDFFF](?![\uDC00-\uDFFF])/u);
    assert.ok(!cut.includes('\uFFFD'));
  }
  assert.equal(tail(emoji, 3 + 4 + 10), '…😀' + 'b'.repeat(10));
  const huge = mainContext(main, [{ id: 9, role: 'assistant', content: '😀'.repeat(20000) }], 0, '', 4096);
  assert.ok(size(huge.text) < 4096 + 600);
  assert.match(huge.text, /left out/);
});

test('unloaded older history is reported as left out', () => {
  const context = mainContext(main, history, 0, '', 24 * 1024, true);
  assert.match(context.text, /Older main-thread text was left out/);
  assert.equal(context.seenId, 3);
});
