import test from 'node:test';
import assert from 'node:assert/strict';

// Line comments' pure parts: anchors, relocation, outdated detection and patch reading
// (review-anchor.ts), and the prompt and the store (review-comments.ts, loaded at startup).
const { makeAnchor, locateAnchor, reconcileComments, placeDraft, patchRows, patchSideLines, patchHunks, clampToHunk, selectionSpan, spanSelection, UNSHOWN } = await import('../src/review-anchor.ts');
const { reviewPrompt, rangeLabel, lineRuns, droppedNote, createReviewStore, unshownComments, SUMMARY_REQUEST, STORED_PREFIX, STORED_MAX_AGE, STORED_FUTURE_SLACK, STORED_MAX_CHARS, STORED_BUDGET_CHARS } = await import('../src/review-comments.ts');

const FILE = ['import a', 'import b', '', 'function one() {', '  return 1;', '}', '', 'function two() {', '  return 2;', '}'];
const comment = (over = {}) => ({ id: 'c1', sessionId: 's1', file: 'src/a.ts', side: 'file', startLine: 4, endLine: 6, text: 'Rename this', status: 'open', createdAt: 1, ...over });

test('an anchor keeps the covered range and up to three lines of context each side', () => {
  const anchor = makeAnchor(FILE, 4, 6);
  assert.equal(anchor.text, 'function one() {\n  return 1;\n}');
  assert.deepEqual(anchor.before, ['import a', 'import b', '']);
  assert.deepEqual(anchor.after, ['', 'function two() {', '  return 2;']);
  // At the edges the context is shorter.
  assert.deepEqual(makeAnchor(FILE, 1, 1).before, []);
  assert.deepEqual(makeAnchor(FILE, 10, 10).after, []);
  assert.deepEqual(makeAnchor(FILE, 9, 10).before, ['}', '', 'function two() {']);
});

test('in a diff the context stops where the known lines stop', () => {
  const sparse = [];
  sparse[9] = 'a'; sparse[10] = 'b'; sparse[11] = 'c';
  const anchor = makeAnchor(sparse, 11, 11);
  assert.equal(anchor.text, 'b');
  assert.deepEqual(anchor.before, ['a']);
  assert.deepEqual(anchor.after, ['c']);
});

test('a range still at its lines is the same; lines inserted above move it down', () => {
  const c = comment({ anchor: makeAnchor(FILE, 4, 6) });
  assert.deepEqual(locateAnchor(FILE, c), { state: 'same', startLine: 4, endLine: 6 });
  const edited = ['// header', '// more', ...FILE];
  assert.deepEqual(locateAnchor(edited, c), { state: 'moved', startLine: 6, endLine: 8 });
  const { placed, updates } = reconcileComments([c], edited);
  assert.deepEqual(updates, [{ id: 'c1', startLine: 6, endLine: 8 }]);
  assert.equal(placed[0].startLine, 6);
  assert.equal(placed[0].outdated, false);
});

test('trailing whitespace changes do not move or outdate a comment', () => {
  const c = comment({ anchor: makeAnchor(FILE, 4, 6) });
  const spaced = FILE.map(line => line + '  ');
  assert.equal(locateAnchor(spaced, c).state, 'same');
});

test('a comment whose lines are gone is outdated, and comes back when they return', () => {
  const c = comment({ anchor: makeAnchor(FILE, 4, 6) });
  const rewritten = FILE.map(line => line.replace('return 1;', 'return 42;'));
  assert.equal(locateAnchor(rewritten, c).state, 'outdated');
  const { placed, updates } = reconcileComments([c], rewritten);
  assert.deepEqual(updates, [{ id: 'c1', status: 'outdated' }]);
  assert.equal(placed[0].outdated, true);
  assert.equal(placed[0].startLine, 4);
  // An outdated comment whose text reappears is open again.
  const back = reconcileComments([{ ...c, status: 'outdated' }], FILE);
  assert.deepEqual(back.updates, [{ id: 'c1', status: 'open' }]);
  assert.equal(back.placed[0].outdated, false);
});

test('an outdated comment past the end of a shorter file is placed on its last line', () => {
  const c = comment({ startLine: 9, endLine: 10, anchor: makeAnchor(FILE, 9, 10) });
  const short = ['one', 'two', 'three'];
  const { placed } = reconcileComments([c], short);
  assert.deepEqual([placed[0].startLine, placed[0].endLine, placed[0].outdated], [3, 3, true]);
});

test('ambiguous matches are resolved by context, then by distance', () => {
  // `return x;` / `}` appears in both functions; the context says which one was meant.
  const lines = ['function one() {', '  return x;', '}', '', 'function two() {', '  return x;', '}'];
  const two = comment({ startLine: 6, endLine: 7, anchor: makeAnchor(lines, 6, 7) });
  // Something was inserted at the top, so neither copy sits at line 6 any more.
  const moved = ['// a', '// b', '// c', ...lines];
  assert.deepEqual(locateAnchor(moved, two), { state: 'moved', startLine: 9, endLine: 10 });
  // Even when the nearer copy is the other one, context wins.
  const one = comment({ startLine: 2, endLine: 3, anchor: makeAnchor(lines, 2, 3) });
  const shuffled = ['// top', 'function zero() {', '  return x;', '}', '', 'function one() {', '  return x;', '}', '', 'function two() {'];
  assert.deepEqual(locateAnchor(shuffled, one), { state: 'moved', startLine: 7, endLine: 8 });
  // No context to go on: the nearest copy wins.
  const bare = comment({ startLine: 5, endLine: 5, anchor: { text: 'x', before: [], after: [] } });
  assert.deepEqual(locateAnchor(['x', 'y', 'y', 'y', 'y', 'y', 'x'], bare), { state: 'moved', startLine: 7, endLine: 7 });
});

test('a diff that no longer shows a comment\'s lines says nothing about it, and shows it away from its lines', () => {
  const sparse = [];
  sparse[19] = 'other';
  const c = comment({ startLine: 4, endLine: 4, anchor: { text: 'function one() {', before: [], after: [] } });
  assert.equal(locateAnchor(sparse, c, true).state, 'unknown');
  const { placed, updates } = reconcileComments([c], sparse, true);
  assert.deepEqual(updates, []);
  assert.deepEqual(placed.map(p => [p.startLine, p.endLine, p.outdated, p.away]), [[4, 4, false, true]]);
});

/** A patch with two hunks: new lines 1–5 and 20–24, with lines 6–19 in the collapsed gap. */
const TWO_HUNKS = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -1,4 +1,5 @@\n a\n+b\n c\n d\n e\n@@ -18,5 +19,6 @@ fn\n s\n t\n+u\n v\n w\n x\n';

test('a diff range across two hunks stays where it is (lines the patch does not show match anything)', () => {
  const { new: lines } = patchSideLines(TWO_HUNKS);
  const anchor = makeAnchor(lines, 2, 22);
  assert.equal(anchor.text.split('\n')[5], UNSHOWN, 'line 7 is in the gap');
  const c = comment({ side: 'new', startLine: 2, endLine: 22, anchor });
  assert.deepEqual(locateAnchor(lines, c, true), { state: 'same', startLine: 2, endLine: 22 });
  const { placed, updates } = reconcileComments([c], lines, true);
  assert.deepEqual(updates, []);
  assert.equal(placed[0].outdated, false);
});

test('a diff selection is kept to the hunk it starts in', () => {
  const hunks = patchHunks(TWO_HUNKS);
  assert.deepEqual(hunks, [{ oldStart: 1, oldCount: 4, newStart: 1, newCount: 5 }, { oldStart: 18, oldCount: 5, newStart: 19, newCount: 6 }]);
  // Down into the next hunk: ends at this hunk's last line; up into the one before: at its first.
  assert.deepEqual(clampToHunk(hunks, { start: 2, side: 'additions', end: 22, endSide: 'additions' }), { start: 2, side: 'additions', end: 5, endSide: 'additions' });
  assert.deepEqual(clampToHunk(hunks, { start: 21, side: 'additions', end: 3, endSide: 'additions' }), { start: 21, side: 'additions', end: 19, endSide: 'additions' });
  // From a deleted line, on the old side.
  assert.deepEqual(clampToHunk(hunks, { start: 2, side: 'deletions', end: 20, endSide: 'additions' }), { start: 2, side: 'deletions', end: 4, endSide: 'deletions' });
  // Inside one hunk, nothing changes.
  const inside = { start: 19, side: 'additions', end: 24, endSide: 'additions' };
  assert.equal(clampToHunk(hunks, inside), inside);
});

test('a diff marks a comment outdated when it shows all of its lines, changed, whatever context it shows', () => {
  // Commented `c` (new line 3) with `b` before and `d` after it.
  const before = patchSideLines(TWO_HUNKS).new;
  const c = comment({ side: 'new', startLine: 3, endLine: 3, anchor: makeAnchor(before, 3, 3) });
  assert.deepEqual([c.anchor.before, c.anchor.after], [['a', 'b'], ['d', 'e']]);
  // The diff shows line 3 changed, though not all of its context: it is not on line 3.
  const partial = [];
  partial[1] = 'b'; partial[2] = 'C'; partial[3] = 'd';
  assert.equal(locateAnchor(partial, c, true).state, 'outdated');
  const result = reconcileComments([c], partial, true);
  assert.deepEqual(result.updates, [{ id: 'c1', status: 'outdated' }]);
  assert.deepEqual(result.placed.map(p => [p.startLine, p.outdated]), [[3, true]]);
  // Lines and context all shown, and different: outdated too.
  const whole = ['a', 'b', 'C', 'd', 'e'];
  assert.equal(locateAnchor(whole, c, true).state, 'outdated');
  assert.deepEqual(reconcileComments([c], whole, true).updates, [{ id: 'c1', status: 'outdated' }]);
  // Its line not shown: the diff cannot tell, and keeps it.
  const elsewhere = [];
  elsewhere[19] = 's';
  assert.equal(locateAnchor(elsewhere, c, true).state, 'unknown');
});

test('a diff that shows a comment\'s line changed, with some of its context hidden, never places it open there', () => {
  // A comment on new line 14 `foo`, its context lines 11–13 and 15–17.
  const lines = [];
  for (let n = 11; n <= 17; n++) lines[n - 1] = n === 14 ? 'foo' : `line ${n}`;
  const c = comment({ side: 'new', startLine: 14, endLine: 14, anchor: makeAnchor(lines, 14, 14) });
  assert.deepEqual([c.anchor.before.length, c.anchor.after.length], [3, 3]);
  // The refetched patch shows 12–17, with line 14 now `bar`.
  const refetched = [];
  for (let n = 12; n <= 17; n++) refetched[n - 1] = n === 14 ? 'bar' : `line ${n}`;
  const { placed, updates } = reconcileComments([c], refetched, true);
  assert.deepEqual(updates, [{ id: 'c1', status: 'outdated' }]);
  assert.deepEqual(placed.map(p => [p.startLine, p.outdated]), [[14, true]]);
  // A range whose shown line changed while another of its lines is hidden: away, not on that code.
  const range = comment({ side: 'new', startLine: 13, endLine: 14, anchor: makeAnchor(lines, 13, 14) });
  const half = [];
  half[13] = 'bar'; half[14] = 'line 15';
  assert.equal(locateAnchor(half, range, true).state, 'unknown');
  assert.deepEqual(reconcileComments([range], half, true).placed.map(p => [p.outdated, p.away]), [[false, true]]);
  const draft = { side: 'new', startLine: 13, endLine: 14, text: 'x', anchor: range.anchor };
  placeDraft(draft, half, true);
  assert.equal(draft.lost, 'away');
});

test('a draft follows its lines when the content changes under it, and says when they are gone', () => {
  const draft = { side: 'file', startLine: 4, endLine: 6, text: 'typing…', anchor: makeAnchor(FILE, 4, 6) };
  placeDraft(draft, ['// new', '// lines', ...FILE]);
  assert.deepEqual([draft.startLine, draft.endLine, draft.lost], [6, 8, undefined]);
  placeDraft(draft, FILE.map(line => line.replace('return 1;', 'return 42;')));
  assert.deepEqual([draft.startLine, draft.endLine, draft.lost], [6, 8, 'changed']);
  // In a diff that no longer shows its lines, it is away.
  const sparse = [];
  sparse[29] = 'elsewhere';
  const diffDraft = { side: 'new', startLine: 4, endLine: 6, text: 'x', anchor: makeAnchor(FILE, 4, 6) };
  placeDraft(diffDraft, sparse, true);
  assert.equal(diffDraft.lost, 'away');
  placeDraft(diffDraft, FILE, true);
  assert.equal(diffDraft.lost, undefined);
});

test('patch lines are read per side, context on both', () => {
  const patch = 'diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -12,4 +12,5 @@ fn\n+added one\n+\n   keep\n-old one\n-old two\n+new one\n   end\n\\ No newline at end of file';
  const sides = patchSideLines(patch);
  assert.equal(sides.new[11], 'added one');
  assert.equal(sides.new[12], '');
  assert.equal(sides.new[13], '  keep');
  assert.equal(sides.old[11], '  keep');
  assert.equal(sides.old[12], 'old one');
  assert.equal(sides.old[13], 'old two');
  assert.equal(sides.new[14], 'new one');
  assert.equal(sides.old[14], '  end');
  assert.equal(sides.new[15], '  end');
  assert.equal(sides.new[10], undefined);
  assert.equal(sides.new.length, 16);
});

test('the newline that ends a patch is not a blank context line; each hunk takes the lines it counts', () => {
  // git ends a patch with a newline: the empty string after it is not a line of either side.
  const sides = patchSideLines('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -3,2 +3,3 @@\n a\n+b\n c\n');
  assert.deepEqual([sides.old.length, sides.new.length], [4, 5]);
  assert.deepEqual(sides.new.slice(2), ['a', 'b', 'c']);
  assert.deepEqual(sides.old.slice(2), ['a', 'c']);
  // Two files, two hunks: lines between them (the next file's header) are not read; an empty line
  // inside a hunk is a blank context line whose space was stripped; a count left out is 1.
  const two = patchSideLines('@@ -1,3 +1,3 @@\n x\n\n-y\n+z\ndiff --git a/q b/q\nindex 1..2\n@@ -7 +7 @@\n-p\n+r\n');
  assert.deepEqual(two.old.slice(0, 3), ['x', '', 'y']);
  assert.deepEqual(two.new.slice(0, 3), ['x', '', 'z']);
  assert.equal(two.old[6], 'p');
  assert.equal(two.new[6], 'r');
  assert.deepEqual([two.old.length, two.new.length], [7, 7]);
});

test('the prompt lists each comment as its file, lines and text, then asks for a summary per comment', () => {
  const comments = [
    comment({ id: 'a1', file: 'src/a.ts', side: 'file', startLine: 4, endLine: 6, anchor: makeAnchor(FILE, 4, 6), text: 'Rename this\nand document it' }),
    comment({ id: 'b2', file: 'src/b.ts', side: 'old', startLine: 13, endLine: 13, anchor: { text: 'removed()', before: [], after: [] }, text: 'Why was this removed?' }),
    comment({ id: 'e5', file: 'src/c.ts', side: 'new', startLine: 2, endLine: 2, anchor: makeAnchor(FILE, 2, 2), text: '  Trim me  ' }),
    comment({ id: 'd4', file: 'src/d.ts', status: 'outdated', startLine: 1, endLine: 1, text: 'Was here', anchor: makeAnchor(FILE, 1, 1) }),
  ];
  assert.equal(reviewPrompt(comments), [
    '1. src/a.ts, lines 4–6',
    '   Rename this',
    '   and document it',
    '',
    '2. src/b.ts, line 13 (deleted lines)',
    '   Why was this removed?',
    '   Written on:',
    '      removed()',
    '',
    '3. src/c.ts, line 2',
    '   Trim me',
    '',
    '4. src/d.ts, line 1 (these lines have since changed)',
    '   Was here',
    '   Written on:',
    '      import a',
    '',
    SUMMARY_REQUEST,
  ].join('\n'));
  // No ids, nothing about what the comments are for, no quoted code for comments on their lines
  // (deleted lines aside: their numbers are in the previous version); the agent answers with a list.
  assert.match(SUMMARY_REQUEST, /numbered list/);
  // Generic: comments may be questions as well as requests.
  assert.doesNotMatch(SUMMARY_REQUEST, /what you did|change/i);
  for (const absent of ['a1', 'pandacode_', 'function one']) assert.ok(!reviewPrompt(comments).includes(absent), absent);
  assert.equal(reviewPrompt([]), '');
});

test('comments not shown on their lines quote the code they were written on', () => {
  const lines = ['  if (ready) {', '    start();', '', '  }'];
  const away = comment({ id: 'w1', side: 'new', startLine: 7, endLine: 10, anchor: { text: [...lines, ''].join('\n'), before: [], after: [] }, text: 'Why here?' });
  const shown = comment({ id: 's1', side: 'new', startLine: 2, endLine: 2, anchor: makeAnchor(FILE, 2, 2), text: 'Fine' });
  // `onLines` says which comments a view shows on their lines; the others quote their code,
  // trimmed, dedented, without blank lines at the ends.
  assert.equal(reviewPrompt([away, shown], c => c.id === 's1'), [
    '1. src/a.ts, lines 7–10',
    '   Why here?',
    '   Written on:',
    '      if (ready) {',
    '        start();',
    '',
    '      }',
    '',
    '2. src/a.ts, line 2',
    '   Fine',
    '',
    SUMMARY_REQUEST,
  ].join('\n'));
  // Lines a diff did not show are left out; a long range is cut short.
  const partial = comment({ anchor: { text: `a\n${UNSHOWN}\nb`, before: [], after: [] } });
  assert.match(reviewPrompt([partial], () => false), /Written on:\n {6}a\n {6}b\n\n/);
  const long = comment({ startLine: 1, endLine: 30, anchor: { text: Array.from({ length: 30 }, (_, i) => `line ${i}`).join('\n'), before: [], after: [] } });
  const quoted = reviewPrompt([long], () => false);
  assert.match(quoted, /line 11\n {6}… 18 more lines\n/);
  assert.ok(!quoted.includes('line 12'));
});

test('line ranges read as one line or a span', () => {
  assert.equal(rangeLabel(3, 3), 'line 3');
  assert.equal(rangeLabel(3, 5), 'lines 3–5');
});

/** A store whose composer the test controls. */
function fakeStore({ composer = true } = {}) {
  const composed = [];
  const store = createReviewStore({ isImeKey: () => false, compose: prompt => { if (!composer) return false; composed.push(prompt); return true; } });
  let paints = 0;
  store.subscribe(() => paints++);
  return { store, composed, paints: () => paints };
}
const input = (over = {}) => ({ file: 'src/a.ts', side: 'file', startLine: 2, endLine: 2, anchor: { text: 'import b', before: [], after: [] }, text: 'Why b?', ...over });

test('comments are kept per thread (in local storage, like composer drafts, until sent)', () => {
  const { store } = fakeStore();
  assert.equal(store.add(input()), null, 'no thread, no comment');
  store.show('s1');
  const first = store.add(input());
  store.add(input({ file: 'src/b.ts', side: 'new' }));
  assert.equal(store.all().length, 2);
  assert.deepEqual(store.forFile('src/a.ts', ['file']).map(c => c.id), [first.id]);
  assert.equal(store.forFile('src/b.ts', ['old']).length, 0);
  store.show('s2');
  assert.equal(store.all().length, 0);
  store.add(input({ text: 'other thread' }));
  store.show('s1');
  assert.equal(store.all().length, 2, 'switching back keeps them');
  store.forget(['s1']);
  assert.equal(store.all().length, 0, 'a deleted thread takes its comments');
  store.show('s2');
  assert.equal(store.all()[0].text, 'other thread');
});

test('the field that makes a comment steps aside in the same paint the comment appears in', () => {
  const { store } = fakeStore();
  store.show('s1');
  const order = [];
  store.subscribe(() => order.push(`paint:${store.all().length}`));
  store.add(input(), { beforeShow: () => order.push('field steps aside') });
  assert.deepEqual(order, ['field steps aside', 'paint:1']);
});

test('a view saves into the thread it was drawn for, even after another thread is shown', () => {
  const { store } = fakeStore();
  store.show('a');
  const surface = store.surface('file', 'src/a.ts');
  assert.equal(surface.thread, 'a');
  assert.equal(store.surface('file', 'src/a.ts'), surface, 'one surface per thread, view and file, kept across redraws');
  assert.notEqual(store.surface('diff', 'src/a.ts'), surface);
  // A field left while thread b is already shown (a blur during the switch) saves into a.
  store.show('b');
  assert.notEqual(store.surface('file', 'src/a.ts'), surface);
  const c = store.add(input({ text: 'for a' }), { thread: surface.thread });
  assert.equal(c.sessionId, 'a');
  assert.equal(store.all().length, 0, 'thread b has none');
  store.update({ id: c.id, text: 'still for a' }, 'a');
  assert.deepEqual(store.forFile('src/a.ts', ['file'], 'a').map(x => x.text), ['still for a']);
  store.remove(c.id, 'a');
  assert.equal(store.forFile('src/a.ts', ['file'], 'a').length, 0);
  // A deleted thread's surfaces go with it.
  surface.draft = { side: 'file', startLine: 1, endLine: 1, text: 'draft' };
  store.forget(['a']);
  assert.equal(store.surface('file', 'src/a.ts', 'a').draft, null);
});

test('edits, deletes and remembered relocations', () => {
  const { store, paints } = fakeStore();
  store.show('s1');
  const c = store.add(input());
  store.update({ id: c.id, text: 'Why import b?' });
  assert.equal(store.all()[0].text, 'Why import b?');
  // A relocation found while painting is remembered without another paint.
  const before = paints();
  store.persist([{ id: c.id, startLine: 5, endLine: 5 }, { id: c.id, status: 'outdated' }]);
  assert.equal(paints(), before);
  assert.deepEqual([store.all()[0].startLine, store.all()[0].status], [5, 'outdated']);
  store.remove(c.id);
  assert.equal(store.all().length, 0);
});

test('Send adds the comments to the composer and clears them; with no composer they stay', () => {
  const blocked = fakeStore({ composer: false });
  blocked.store.show('s1');
  blocked.store.add(input());
  assert.equal(blocked.store.send(), 0);
  assert.equal(blocked.store.all().length, 1, 'nothing lost when there is nowhere to put them');

  const { store, composed } = fakeStore();
  store.show('s1');
  assert.equal(store.send(), 0, 'nothing to send');
  const one = store.add(input()), two = store.add(input({ startLine: 4, endLine: 6, text: 'And this' }));
  // A view shows both on their lines, so no code is quoted.
  const view = store.surface('file', 'src/a.ts');
  store.retain(view);
  view.shown = new Set([one.id, two.id]);
  assert.equal(store.send(), 2);
  assert.deepEqual(composed, [`1. src/a.ts, line 2\n   Why b?\n\n2. src/a.ts, lines 4–6\n   And this\n\n${SUMMARY_REQUEST}`]);
  assert.equal(store.all().length, 0);
});

test('Send includes an edit held only in a field that went without saving (a thread switch removed it)', () => {
  const { store, composed } = fakeStore();
  store.show('s1');
  const edited = store.add(input());
  const emptied = store.add(input({ startLine: 4, endLine: 4, text: 'Emptied' }));
  const surface = store.surface('file', 'src/a.ts');
  store.retain(surface);
  surface.shown = new Set([edited.id, emptied.id]);
  surface.live.set(edited.id, '  Why import b at all?  ');
  surface.live.set(emptied.id, '');
  // Another thread's unsaved edit stays with that thread.
  store.surface('file', 'src/a.ts', 's2').live.set(edited.id, 'not this one');
  // A comment whose field was emptied and not left is not counted...
  assert.equal(store.count(), 1);
  assert.equal(store.send(), 1);
  assert.deepEqual(composed, [`1. src/a.ts, line 2\n   Why import b at all?\n\n${SUMMARY_REQUEST}`]);
  // ...nor sent or deleted: it stays, its field still empty, for leaving it to delete (with Undo).
  assert.deepEqual(store.all().map(c => c.text), ['Emptied']);
  assert.deepEqual([...surface.live], [[emptied.id, '']]);
  assert.equal(store.count(), 0);
});

/** Local storage in a Map, with a clock and the Keep unsent drafts switch. */
function storedStore({ items = new Map(), keep = true, now = 1_000_000_000_000, quota = Infinity } = {}) {
  const storage = {
    getItem: key => items.has(key) ? items.get(key) : null,
    setItem: (key, value) => { if (value.length > quota) throw new Error('QuotaExceededError'); items.set(key, String(value)); },
    removeItem: key => { items.delete(key); },
    key: i => [...items.keys()][i] ?? null,
    get length() { return items.size; },
  };
  const state = { keep, now };
  const composed = [];
  const store = createReviewStore({ isImeKey: () => false, compose: p => { composed.push(p); return true; }, storage, keep: () => state.keep, now: () => state.now, typingDelay: 10 });
  return { store, items, state, composed };
}

test('unsent comments outlive a restart, one key per thread, and go once sent', () => {
  const items = new Map();
  const first = storedStore({ items });
  first.store.show('s1');
  const c = first.store.add(input());
  first.store.show('s2');
  first.store.add(input({ text: 'Other thread' }));
  assert.deepEqual([...items.keys()].sort(), [`${STORED_PREFIX}s1`, `${STORED_PREFIX}s2`]);
  const saved = JSON.parse(items.get(`${STORED_PREFIX}s1`));
  assert.equal(saved.comments[0].text, 'Why b?');
  assert.equal(saved.comments[0].sessionId, undefined, 'the key names the thread');

  // A new launch reads them back, edits included.
  first.store.show('s1');
  first.store.update({ id: c.id, text: 'Why import b?' });
  const second = storedStore({ items });
  second.store.show('s1');
  assert.deepEqual(second.store.all().map(x => [x.id, x.text, x.sessionId]), [[c.id, 'Why import b?', 's1']]);
  // New ids never collide with the ones read back.
  const added = second.store.add(input({ text: 'More' }));
  assert.notEqual(added.id, c.id);
  assert.equal(second.store.send(), 2);
  assert.equal(items.has(`${STORED_PREFIX}s1`), false, 'sent comments are not stored');
  // Deleting the last comment removes the key too.
  second.store.show('s2');
  second.store.remove(second.store.all()[0].id);
  assert.equal(items.size, 0);
});

test('stored comments of deleted threads, old or malformed entries go; Keep unsent drafts off writes nothing', () => {
  const items = new Map([
    [`${STORED_PREFIX}old`, JSON.stringify({ t: 1, comments: [{ id: 'x', file: 'a', side: 'file', startLine: 1, endLine: 1, anchor: { text: '', before: [], after: [] }, text: 'stale' }] })],
    [`${STORED_PREFIX}bad`, '{not json'],
    [`${STORED_PREFIX}mixed`, JSON.stringify({ t: 1_000_000_000_000, comments: [{ id: 'ok', file: 'a.ts', side: 'new', startLine: 2, endLine: 3, anchor: { text: 'x', before: [], after: [] }, text: 'kept', status: 'outdated' }, { id: 'no', side: 'left' }] })],
    ['pandacode.draft:s1', 'not ours'],
  ]);
  const { store, state } = storedStore({ items });
  assert.deepEqual(store.storedThreads().sort(), ['bad', 'mixed', 'old']);
  store.show('old');
  assert.equal(store.all().length, 0, `older than ${STORED_MAX_AGE} ms`);
  store.show('bad');
  assert.equal(store.all().length, 0);
  assert.deepEqual(store.storedThreads(), ['mixed']);
  store.show('mixed');
  assert.deepEqual(store.all().map(c => [c.id, c.status]), [['ok', 'outdated']], 'the valid comment stays, the other is skipped');
  store.forget(['mixed']);
  assert.deepEqual(store.storedThreads(), []);
  assert.equal(items.get('pandacode.draft:s1'), 'not ours');

  // Keep unsent drafts off: comments stay in memory, nothing is written, and Clear empties storage.
  state.keep = false;
  store.show('s9');
  store.add(input());
  assert.equal(store.all().length, 1);
  assert.equal(items.has(`${STORED_PREFIX}s9`), false);
  state.keep = true;
  store.add(input({ text: 'again' }));
  assert.equal(items.has(`${STORED_PREFIX}s9`), true);
  store.clearStored();
  assert.equal(items.has(`${STORED_PREFIX}s9`), false);
  assert.equal(store.all().length, 2, 'cleared from storage, kept for this launch');
});

test('a thread whose comments are too large, or a full store, keeps them for this launch only', () => {
  const { store, items } = storedStore();
  store.show('s1');
  store.add(input({ text: 'x'.repeat(4000) }));
  assert.equal(items.has(`${STORED_PREFIX}s1`), true);
  while (JSON.stringify(store.all()).length <= STORED_MAX_CHARS) store.add(input({ text: 'x'.repeat(4000) }));
  assert.equal(items.has(`${STORED_PREFIX}s1`), false, 'too large: not stored, rather than stale');
  const full = storedStore({ quota: 10 });
  full.store.show('s1');
  full.store.add(input());
  assert.equal(full.store.all().length, 1, 'a quota error loses nothing in memory');
});

test('a repeated line at its old position stays there only when its context does too', () => {
  // `}` on line 7 ends function b; z's `}` is on line 3.
  const before = ['function z() {', '  z1();', '}', 'function b() {', '  b1();', '  b2();', '}', '', 'tail'];
  const c = comment({ startLine: 7, endLine: 7, anchor: makeAnchor(before, 7, 7) });
  // A 4-line function inserted at the top puts z's `}` on line 7: the comment follows b's to 11.
  const after = ['function a() {', '  a1();', '}', '', ...before];
  assert.equal(after[6], '}');
  assert.deepEqual(locateAnchor(after, c), { state: 'moved', startLine: 11, endLine: 11 });
  assert.deepEqual(reconcileComments([c], after).updates, [{ id: 'c1', startLine: 11, endLine: 11 }]);
  // A comment being written follows its line the same way.
  const draft = { side: 'file', startLine: 7, endLine: 7, text: 'typing', anchor: makeAnchor(before, 7, 7) };
  placeDraft(draft, after);
  assert.deepEqual([draft.startLine, draft.lost], [11, undefined]);
  // Blank lines too: line 5 is still blank after three lines are inserted, but it is another one.
  const blank = ['a', '', 'b', 'c', '', 'd'];
  const onBlank = comment({ startLine: 5, endLine: 5, anchor: makeAnchor(blank, 5, 5) });
  const inserted = ['x', 'y', '', ...blank];
  assert.equal(inserted[4], '');
  assert.deepEqual(locateAnchor(inserted, onBlank), { state: 'moved', startLine: 8, endLine: 8 });
  const blankDraft = { side: 'file', startLine: 5, endLine: 5, text: '', anchor: makeAnchor(blank, 5, 5) };
  placeDraft(blankDraft, inserted);
  assert.equal(blankDraft.startLine, 8);
  // Unchanged, or the only copy with its context edited: it stays.
  assert.equal(locateAnchor(before, c).state, 'same');
  const edited = before.map(line => line.replace('b2', 'b2b'));
  assert.deepEqual(locateAnchor(edited.slice(3), comment({ startLine: 4, endLine: 4, anchor: makeAnchor(before.slice(3), 4, 4) })), { state: 'same', startLine: 4, endLine: 4 });
});

test('a common line whose context is all gone is outdated, not moved onto another copy', () => {
  // A blank line the agent filled: the other blank line shares none of its context.
  const blank = ['a', 'b', '', 'c', 'd', '', 'e'];
  const onBlank = comment({ startLine: 3, endLine: 3, anchor: makeAnchor(blank, 3, 3) });
  const filled = ['a', 'b', 'x', 'c', 'd', '', 'e'];
  assert.equal(locateAnchor(filled, onBlank).state, 'outdated');
  assert.deepEqual(reconcileComments([onBlank], filled).updates, [{ id: 'c1', status: 'outdated' }]);
  const draft = { side: 'file', startLine: 3, endLine: 3, text: 'typing', anchor: makeAnchor(blank, 3, 3) };
  placeDraft(draft, filled);
  assert.deepEqual([draft.startLine, draft.lost], [3, 'changed']);
  // Function a's `}`, with a rewritten as one line: b's `}` is not it.
  const before = ['function a() {', '  a1();', '}', '', 'function b() {', '  b1();', '}'];
  const onBrace = comment({ startLine: 3, endLine: 3, anchor: makeAnchor(before, 3, 3) });
  const rewritten = ['const a = () => a1();', '', 'function b() {', '  b1();', '}'];
  assert.equal(locateAnchor(rewritten, onBrace).state, 'outdated');
  // A diff that shows the line, changed, says so too; one that does not show it cannot tell.
  const sparse = [];
  sparse[2] = 'x'; sparse[5] = '';
  assert.equal(locateAnchor(sparse, onBlank, true).state, 'outdated');
  const unshown = [];
  unshown[5] = '';
  assert.equal(locateAnchor(unshown, onBlank, true).state, 'unknown');
  // The only `}` left in the file is no evidence: a line of punctuation is not taken without context.
  assert.equal(rewritten.filter(line => line === '}').length, 1);
  // A copy that keeps some of its context still moves (a function inserted above).
  assert.deepEqual(locateAnchor(['function z() {', '}', '', ...before], onBrace), { state: 'moved', startLine: 6, endLine: 6 });
});

test('a blank line counts as context', () => {
  // Line 2 `x` follows a blank line; its anchor keeps that blank line.
  const c = comment({ startLine: 2, endLine: 2, anchor: makeAnchor(['', 'x'], 2, 2) });
  assert.deepEqual(c.anchor.before, ['']);
  // `x` is now on lines 2 and 4; only line 4 follows a blank line.
  assert.deepEqual(locateAnchor(['q', 'x', '', 'x'], c), { state: 'moved', startLine: 4, endLine: 4 });
});

test('a unique line whose surroundings were all rewritten is still found, and remembers its new surroundings', () => {
  const file = ['import a', 'import b', 'import c', 'export function foo() {', '  one();', '  two();', '  three();', '}'];
  const c = comment({ startLine: 4, endLine: 4, anchor: makeAnchor(file, 4, 4) });
  // The agent rewrites the imports above and the body below: the line has not moved.
  const rewritten = ['import x', 'import y', 'import z', 'export function foo() {', '  four();', '  five();', '  six();', '}'];
  assert.equal(locateAnchor(rewritten, c).state, 'same');
  const { updates } = reconcileComments([c], rewritten);
  assert.deepEqual(updates, [{ id: 'c1', anchor: makeAnchor(rewritten, 4, 4) }], 'its new context is remembered');
  // Then a line is added at the top. With the remembered context, it moves with it...
  const shifted = ['// header', ...rewritten];
  const refreshed = { ...c, anchor: updates[0].anchor };
  assert.deepEqual(locateAnchor(shifted, refreshed), { state: 'moved', startLine: 5, endLine: 5 });
  assert.deepEqual(reconcileComments([refreshed], shifted).updates, [{ id: 'c1', startLine: 5, endLine: 5 }]);
  // ...and with the old context (the file view was not open meanwhile), it is the one copy of its text.
  assert.deepEqual(locateAnchor(shifted, c), { state: 'moved', startLine: 5, endLine: 5 });
  // Two copies, neither with its context: outdated rather than a guess.
  assert.equal(locateAnchor(['x', 'export function foo() {', 'y', 'z', 'w', 'export function foo() {'], c).state, 'outdated');
  // A diff shows part of the file only, so one copy there proves nothing.
  const sparse = [];
  sparse[9] = 'export function foo() {';
  assert.equal(locateAnchor(sparse, { ...c, side: 'new' }, true).state, 'unknown');
  // Unchanged surroundings remember nothing new.
  assert.deepEqual(reconcileComments([c], file).updates, []);
});

test('a diff refreshes a found comment\'s context only when it shows at least as much of it', () => {
  const file = ['a', 'b', 'c', 'target', 'd', 'e', 'f'];
  const c = comment({ side: 'new', startLine: 4, endLine: 4, anchor: makeAnchor(file, 4, 4) });
  // A refetch showing fewer lines around it: found, nothing remembered (its context would shrink).
  const less = [];
  less[2] = 'c'; less[3] = 'target'; less[4] = 'd';
  assert.equal(locateAnchor(less, c, true).state, 'same');
  assert.deepEqual(reconcileComments([c], less, true).updates, []);
  // All of it shown, edited above: the new context is remembered.
  const edited = ['A', 'B', 'c', 'target', 'd', 'e', 'f'];
  assert.deepEqual(reconcileComments([c], edited, true).updates, [{ id: 'c1', anchor: makeAnchor(edited, 4, 4) }]);
});

test('stored comments in the shape context had before it became arrays are skipped', () => {
  const items = new Map([[`${STORED_PREFIX}s1`, JSON.stringify({ t: 1_000_000_000_000, comments: [
    { id: 'old', file: 'a.ts', side: 'file', startLine: 3, endLine: 3, anchor: { text: 'x', contextBefore: 'a', contextAfter: '' }, text: 'unknown shape' },
    { id: 'new', file: 'a.ts', side: 'file', startLine: 3, endLine: 3, anchor: { text: 'x', before: ['a'], after: [] }, text: 'kept' },
  ] })]]);
  const { store } = storedStore({ items });
  store.show('s1');
  assert.deepEqual(store.all().map(x => x.text), ['kept']);
});

test('a deleted thread stays deleted: a field left afterwards writes nothing back for it', () => {
  const { store, items } = storedStore();
  store.show('s1');
  const c = store.add(input());
  const surface = store.surface('file', 'src/a.ts');
  store.forget(['s1']);
  assert.equal(items.size, 0);
  // What a field left a task later (letGo) would do: none of it lands.
  assert.equal(store.add(input({ text: 'late' }), { thread: surface.thread }), null);
  store.update({ id: c.id, text: 'late edit' }, 's1');
  store.remove(c.id, 's1');
  store.persist([{ id: c.id, startLine: 9 }], 's1');
  assert.equal(items.size, 0, 'nothing written for the deleted thread');
  assert.equal(store.forFile('src/a.ts', ['file'], 's1').length, 0);
  assert.equal(store.has('s1'), false);
  // Other threads are unaffected.
  store.show('s2');
  store.add(input());
  assert.deepEqual([...items.keys()], [`${STORED_PREFIX}s2`]);
});

test('a thread has comments while it holds a saved one or a new one with text', () => {
  const { store } = fakeStore();
  store.show('draft');
  assert.equal(store.has('draft'), false);
  const surface = store.surface('file', 'src/a.ts');
  surface.draft = { side: 'file', startLine: 1, endLine: 1, text: '  ', anchor: { text: 'x', before: [], after: [] } };
  assert.equal(store.has('draft'), false, 'an empty new comment is not one');
  surface.draft.text = 'typed';
  assert.equal(store.has('draft'), true);
  surface.draft = null;
  const c = store.add(input());
  store.show('other');
  assert.equal(store.has('draft'), true, 'asked by id, whichever thread is shown');
  store.remove(c.id, 'draft');
  assert.equal(store.has('draft'), false);
});

test('comments no view shows: diff comments on unlisted files, Files view comments with no tab open', () => {
  const { store, paints } = fakeStore();
  store.show('s1');
  const onFile = store.add(input({ file: 'src/a.ts', side: 'file' }));
  const onDiff = store.add(input({ file: 'src/b.ts', side: 'new' }));
  const listed = file => file === 'src/b.ts';
  // No tab open in this thread yet (after a restart, tabs are not kept).
  assert.deepEqual(unshownComments(store, listed).map(c => c.id), [onFile.id]);
  const before = paints();
  store.openFiles('s1', ['src/a.ts']);
  assert.equal(paints(), before + 1, 'a tab opening for a commented file tells the views');
  assert.deepEqual(unshownComments(store, listed), []);
  store.openFiles('s1', ['src/a.ts']);
  store.openFiles('s1', ['src/a.ts', 'src/z.ts']);
  assert.equal(paints(), before + 1, 'the same tabs, or another file\'s tab, tell nobody');
  // Its tab closed (or its file deleted, which closes the tab), and the diff hidden by the scope.
  store.openFiles('s1', []);
  assert.deepEqual(unshownComments(store, () => false).map(c => c.id), [onFile.id, onDiff.id]);
  // Tabs belong to their thread.
  assert.equal(store.fileOpen('src/a.ts', 's2'), false);
});

test('a diff range between deleted and added lines covers the new-side lines among its rows', () => {
  // The preview's sample diff: new 12–13 added, 14 context, old 13–14 deleted, new 15 added, 16–17 context.
  const rows = patchRows('diff --git a/x b/x\n--- a/x\n+++ b/x\n@@ -12,5 +12,6 @@ fn\n+  const index = make();\n+\n   input.on(() => {\n-    const index = make();\n-    renderAll(index);\n+    renderResults(index);\n   });\n }');
  // Deleted 13 down to added 15: the rows are old 13, old 14 and new 15.
  // The deleted lines it leaves out are named, so the comment can say so.
  assert.deepEqual(selectionSpan(rows, { start: 13, side: 'deletions', end: 15, endSide: 'additions' }), { side: 'new', startLine: 15, endLine: 15, dropped: [13, 14] });
  // Added 12 down to deleted 14: new 12, 13 and context 14.
  assert.deepEqual(selectionSpan(rows, { start: 12, side: 'additions', end: 14, endSide: 'deletions' }), { side: 'new', startLine: 12, endLine: 14, dropped: [13, 14] });
  // Deleted 13 down to context 16 (the `});` line): new 15–16.
  assert.deepEqual(selectionSpan(rows, { start: 13, side: 'deletions', end: 16, endSide: 'additions' }), { side: 'new', startLine: 15, endLine: 16, dropped: [13, 14] });
  // Upwards works the same; one side keeps its own lines.
  assert.deepEqual(selectionSpan(rows, { start: 15, side: 'additions', end: 13, endSide: 'deletions' }), { side: 'new', startLine: 15, endLine: 15, dropped: [13, 14] });
  // What the diff shows while the range is drawn: the lines the comment will be on, one side.
  assert.deepEqual(spanSelection(selectionSpan(rows, { start: 13, side: 'deletions', end: 15, endSide: 'additions' })), { start: 15, side: 'additions', end: 15, endSide: 'additions' });
  assert.equal(lineRuns([14, 13, 16, 17, 19]), '13–14, 16–17, 19');
  assert.deepEqual(selectionSpan(rows, { start: 14, side: 'deletions', end: 13, endSide: 'deletions' }), { side: 'old', startLine: 13, endLine: 14 });
  assert.deepEqual(selectionSpan(rows, { start: 16, side: 'additions', end: 14 }), { side: 'new', startLine: 14, endLine: 16 });
  // patchSideLines reads the same rows.
  assert.equal(patchSideLines(rows).old[12], '    const index = make();');
});

test('Send saves a new comment left with text in its field, and the button counts it', () => {
  const { store, composed } = fakeStore();
  store.show('s1');
  let told = 0;
  store.watchCount(() => told++);
  const surface = store.surface('diff', 'src/b.ts');
  store.retain(surface);
  surface.draft = { side: 'new', startLine: 3, endLine: 4, text: '', anchor: { text: 'x\ny', before: [], after: [] } };
  assert.equal(store.count(), 0, 'an empty field is no comment');
  surface.draft.text = '  Check this  ';
  store.typed();
  assert.equal(told, 1, 'the button hears of it');
  assert.equal(store.count(), 1, 'the only comment is the one being written');
  // A field whose lines changed under it is sent as outdated; another thread's is left alone.
  const changed = store.surface('file', 'src/c.ts');
  changed.draft = { side: 'file', startLine: 2, endLine: 2, text: 'Was here', anchor: { text: 'z', before: [], after: [] }, lost: 'changed' };
  const other = store.surface('file', 'src/a.ts', 's2');
  other.draft = { side: 'file', startLine: 1, endLine: 1, text: 'other thread', anchor: { text: 'a', before: [], after: [] } };
  assert.equal(store.count(), 2);
  assert.equal(store.send(), 2);
  // The one on its lines in a view quotes no code; the outdated one quotes what it was written on.
  assert.deepEqual(composed, [`1. src/b.ts, lines 3–4\n   Check this\n\n2. src/c.ts, line 2 (these lines have since changed)\n   Was here\n   Written on:\n      z\n\n${SUMMARY_REQUEST}`]);
  assert.equal(surface.draft, null);
  assert.equal(store.count(), 0);
  assert.equal(other.draft.text, 'other thread');
  // With no composer, the field's text becomes a saved comment and stays.
  const blocked = fakeStore({ composer: false });
  blocked.store.show('s1');
  blocked.store.surface('file', 'src/a.ts').draft = { side: 'file', startLine: 2, endLine: 2, text: 'Keep me', anchor: { text: 'import b', before: [], after: [] } };
  assert.equal(blocked.store.send(), 0);
  assert.deepEqual(blocked.store.all().map(c => c.text), ['Keep me']);
});

test('stored comments expire like drafts: untouched too long, or dated too far ahead', () => {
  const now = 1_000_000_000_000;
  const entry = t => JSON.stringify({ t, comments: [{ id: 'x', file: 'a.ts', side: 'file', startLine: 1, endLine: 1, anchor: { text: 'a', before: [], after: [] }, text: 'hi' }] });
  const items = new Map([
    [`${STORED_PREFIX}fresh`, entry(now - 1000)],
    [`${STORED_PREFIX}old`, entry(now - STORED_MAX_AGE - 1)],
    [`${STORED_PREFIX}ahead`, entry(now + STORED_FUTURE_SLACK + 1)],
    [`${STORED_PREFIX}soon`, entry(now + STORED_FUTURE_SLACK - 1)],
    [`${STORED_PREFIX}bad`, '{'],
  ]);
  const { store, state } = storedStore({ items, now });
  // At launch, before any thread is shown.
  store.expire();
  assert.deepEqual(store.storedThreads().sort(), ['fresh', 'soon']);
  // While running: a thread read into memory and then left untouched goes from memory too.
  store.show('fresh');
  assert.equal(store.all().length, 1);
  let painted = 0;
  store.subscribe(() => painted++);
  state.now += STORED_MAX_AGE + 1;
  store.expire();
  assert.equal(store.all().length, 0);
  assert.equal(painted, 1, 'the shown thread is painted without them');
  assert.deepEqual(store.storedThreads(), ['soon']);
  // Keep unsent drafts off: every entry goes.
  state.keep = false;
  store.expire();
  assert.deepEqual(store.storedThreads(), []);
});

test('all threads together keep to a budget: the oldest leave storage and stay for this launch', () => {
  const { store, items, state } = storedStore();
  const big = 'x'.repeat(4000);
  for (const id of ['t1', 't2', 't3', 't4']) {
    state.now += 1000;
    store.show(id);
    while ((items.get(STORED_PREFIX + id)?.length ?? 0) < 150_000) store.add(input({ text: big }));
  }
  const total = [...items.values()].reduce((sum, value) => sum + value.length, 0);
  assert.ok(total <= STORED_BUDGET_CHARS, `${total} characters stored`);
  assert.equal(items.has(`${STORED_PREFIX}t1`), false, 'the oldest thread left storage');
  assert.equal(items.has(`${STORED_PREFIX}t4`), true, 'the one written is stored');
  store.show('t1');
  assert.ok(store.all().length > 30, 'kept in memory for this launch');
});

test('a surface no view draws, with nothing unsaved, is let go', () => {
  const { store } = fakeStore();
  store.show('s1');
  const idle = store.surface('file', 'a.ts');
  store.retain(idle);
  assert.equal(store.surface('file', 'a.ts'), idle);
  store.release(idle);
  assert.notEqual(store.surface('file', 'a.ts'), idle, 'let go');
  // Unsaved text, or a comment being written, keeps it for the next view.
  const typing = store.surface('file', 'b.ts');
  store.retain(typing);
  typing.live.set('c1', 'half an edit');
  store.release(typing);
  assert.equal(store.surface('file', 'b.ts'), typing);
  // Still drawn by another view (a refetched diff mounts before the old one goes): kept.
  const shared = store.surface('diff', 'c.ts');
  store.retain(shared); store.retain(shared); store.release(shared);
  assert.equal(store.surface('diff', 'c.ts'), shared);
  // A view that took a surface just let go registers it again.
  store.release(shared);
  store.retain(shared);
  assert.equal(store.surface('diff', 'c.ts'), shared);
});

test('a line of punctuation at its old position, with none of its context left, is outdated, not taken over', () => {
  // The comment is on function a's `}` (line 3). The agent deletes function a and the blank line
  // after it, so b's `}` lands on line 3: the same text on the same line, with none of the context.
  const before = ['function a() {', '  a1();', '}', '', 'function b() {', '  b1();', '}'];
  const after = ['function b() {', '  b1();', '}'];
  assert.equal(after[2], '}');
  const onBrace = comment({ startLine: 3, endLine: 3, anchor: makeAnchor(before, 3, 3) });
  assert.equal(locateAnchor(after, onBrace).state, 'outdated');
  const { placed, updates } = reconcileComments([onBrace], after);
  assert.deepEqual(updates, [{ id: 'c1', status: 'outdated' }], 'outdated, and its anchor is not rewritten to b\'s context');
  assert.equal(placed[0].outdated, true);
  const draft = { side: 'file', startLine: 3, endLine: 3, text: 'typing', anchor: makeAnchor(before, 3, 3) };
  placeDraft(draft, after);
  assert.equal(draft.lost, 'changed');
  // In a diff that shows those lines (b's context differs), the same; one showing none of the
  // context around it cannot tell, and leaves it where it was with its anchor as it was.
  const diffComment = { ...onBrace, side: 'new' };
  const shown = [...after];
  assert.equal(locateAnchor(shown, diffComment, true).state, 'outdated');
  assert.deepEqual(reconcileComments([diffComment], shown, true).updates, [{ id: 'c1', status: 'outdated' }]);
  const bare = [];
  bare[2] = '}';
  assert.equal(locateAnchor(bare, diffComment, true).state, 'unknown');
  assert.deepEqual(reconcileComments([diffComment], bare, true).updates, []);
  // A line that says something stays at its old position without its context, even with another
  // copy further down.
  const file = ['x1', 'x2', 'return total;', 'x3'];
  const onReturn = comment({ startLine: 3, endLine: 3, anchor: makeAnchor(file, 3, 3) });
  assert.deepEqual(locateAnchor(['y1', 'y2', 'return total;', 'y3', 'return total;'], onReturn), { state: 'same', startLine: 3, endLine: 3 });
});

test('text typed in a field and not yet saved is stored once typing rests, and comes back saved', async () => {
  const items = new Map();
  const first = storedStore({ items });
  first.store.show('s1');
  const kept = first.store.add(input({ text: 'Saved.' }));
  const surface = first.store.surface('file', 'src/a.ts');
  // A new comment being written, and an unsaved edit of the saved one.
  surface.draft = { side: 'file', startLine: 5, endLine: 5, text: 'Half typed', anchor: { text: 'x', before: [], after: [] } };
  surface.live.set(kept.id, 'Saved, then edited');
  first.store.typing('s1');
  assert.doesNotMatch(items.get(`${STORED_PREFIX}s1`), /Half typed/, 'not at every key');
  await new Promise(resolve => setTimeout(resolve, 30));
  const stored = JSON.parse(items.get(`${STORED_PREFIX}s1`)).comments;
  assert.deepEqual(stored.map(c => c.text), ['Saved, then edited', 'Half typed']);
  // In memory nothing is saved yet: leaving the field still decides.
  assert.deepEqual(first.store.all().map(c => c.text), ['Saved.']);
  // After a reload or crash, the text is there, saved as leaving the field would have.
  const second = storedStore({ items });
  second.store.show('s1');
  assert.deepEqual(second.store.all().map(c => [c.text, c.startLine]), [['Saved, then edited', 2], ['Half typed', 5]]);
  // A field discarded, and its comment sent, write nothing back.
  surface.draft = null; surface.live.clear();
  first.store.typing('s1');
  first.store.flushTyping();
  assert.deepEqual(JSON.parse(items.get(`${STORED_PREFIX}s1`)).comments.map(c => c.text), ['Saved.']);
});

test('a deleted comment comes back with Undo, in its place and with its lines and status', () => {
  const undos = [];
  const store = createReviewStore({ isImeKey: () => false, compose: () => true, undoable: (text, undo) => undos.push([text, undo]) });
  store.show('s1');
  const a = store.add(input({ text: 'first' }));
  const b = store.add(input({ text: 'second', startLine: 4, endLine: 6 }));
  store.update({ id: b.id, status: 'outdated' });
  const removed = store.all()[1];
  store.remove(b.id);
  assert.equal(store.restore(removed, 1, 's1'), true);
  assert.deepEqual(store.all().map(c => [c.id, c.startLine, c.endLine, c.status]), [[a.id, 2, 2, 'open'], [b.id, 4, 6, 'outdated']]);
  assert.equal(store.restore(removed, 1, 's1'), false, 'already there');
  store.remove(a.id);
  store.forget(['s1']);
  assert.equal(store.restore(a, 0, 's1'), false, 'its thread is gone');
});

test('comments no view shows are read for the thread a view was drawn for', () => {
  const { store } = fakeStore();
  store.show('s1');
  const own = store.add(input({ file: 'src/b.ts', side: 'new' }));
  store.show('s2');
  store.add(input({ file: 'src/c.ts', side: 'new' }));
  assert.deepEqual(unshownComments(store, () => false, 's1').map(c => c.id), [own.id]);
});

test('a line edited in place is outdated, never moved onto another copy of its old text', () => {
  // Probe 1: two copies of `return foo;` with different neighbours; the commented one is rewritten.
  const file = ['function a() {', '  const v = 1;', '  return foo;', '}', '', 'function b() {', '  log();', '  return foo;', '  // end', '}'];
  const c = comment({ startLine: 3, endLine: 3, anchor: makeAnchor(file, 3, 3) });
  assert.equal(c.anchor.unique, false, 'the text had two copies when the comment was made');
  const edited = file.map((line, i) => i === 2 ? '  return bar;' : line);
  assert.equal(locateAnchor(edited, c).state, 'outdated');
  assert.deepEqual(reconcileComments([c], edited).updates, [{ id: 'c1', status: 'outdated' }], 'no fresh anchor binds it to line 8');
  // Even with the neighbours of line 3 rewritten too, the only copy left is not taken: it was not
  // the only copy when the comment was made.
  const rewritten = ['// one', '// two', '  return bar;', '// three', '// four', '// five', '  log();', '  return foo;', '  // end', '}'];
  assert.equal(locateAnchor(rewritten, c).state, 'outdated');

  // Probe 2: a unique `await save(x);` is rewritten in place, while line 9 becomes a copy of it.
  const before = ['async function go(x) {', '  check(x);', '  log(x);', '  await save(x);', '  done();', '}', '', 'async function later(x) {', '  queue(x);', '}'];
  const d = comment({ startLine: 4, endLine: 4, anchor: makeAnchor(before, 4, 4) });
  assert.equal(d.anchor.unique, true);
  const after = [...before];
  after[3] = '  await saveAll([x]);';
  after[8] = '  await save(x);';
  assert.equal(locateAnchor(after, d).state, 'outdated');
  assert.deepEqual(reconcileComments([d], after).updates, [{ id: 'c1', status: 'outdated' }]);
  // In a diff showing those lines the same holds.
  assert.equal(locateAnchor(after, { ...d, side: 'new' }, true).state, 'outdated');
  // A unique line that moved with all its surroundings rewritten is still followed.
  const moved = ['// a', '// b', '// c', '// d', '// e', '// f', '  await save(x);', '// g'];
  assert.deepEqual(locateAnchor(moved, d), { state: 'moved', startLine: 7, endLine: 7 });
  // A stored anchor from before `unique` was recorded never moves to a lone copy that way.
  const { unique: _, ...legacy } = d.anchor;
  assert.equal(locateAnchor(moved, { ...d, anchor: legacy }).state, 'outdated');
});

test('an anchor\'s uniqueness is stored and read back; a diff anchor has none', () => {
  const items = new Map();
  const { store } = storedStore({ items });
  store.show('s1');
  store.add(input({ anchor: makeAnchor(FILE, 2, 2) }));
  assert.equal(JSON.parse(items.get(`${STORED_PREFIX}s1`)).comments[0].anchor.unique, true);
  const again = storedStore({ items });
  again.store.show('s1');
  assert.equal(again.store.all()[0].anchor.unique, true);
  assert.equal('unique' in makeAnchor(FILE, 2, 2, true), false);
});

test('a comment whose lines were deleted is not moved onto a similar line whose only shared context is `}` or blank', () => {
  // Probe 1: `return null;` in second(), 44 lines below its copy in first(); second() is deleted.
  const filler = Array.from({ length: 37 }, (_, i) => `  step${i}();`);
  const first = ['function first() {', '  if (!a) {', '    warnA();', '    return null;', '  }', ...filler, '}', ''];
  const second = ['function second() {', '  if (!b) {', '    warnB();', '    return null;', '  }', '  return b;', '}'];
  const file = [...first, ...second];
  const line = file.lastIndexOf('    return null;') + 1;
  assert.equal(line - (file.indexOf('    return null;') + 1), 44);
  const c = comment({ startLine: line, endLine: line, anchor: makeAnchor(file, line, line) });
  const deleted = [...first];
  assert.equal(locateAnchor(deleted, c).state, 'outdated', 'only `  }` agrees beside the copy in first()');
  assert.deepEqual(reconcileComments([c], deleted).updates, [{ id: 'c1', status: 'outdated' }]);
  const draft = { side: 'file', startLine: line, endLine: line, text: 'typing', anchor: makeAnchor(file, line, line) };
  placeDraft(draft, deleted);
  assert.deepEqual([draft.startLine, draft.lost], [line, 'changed']);
  // In a diff showing the copy and not the old lines, the comment's place is unknown, not moved.
  const sparse = [];
  for (let i = 0; i < 6; i++) sparse[i] = deleted[i];
  assert.equal(locateAnchor(sparse, { ...c, side: 'new' }, true).state, 'unknown');

  // Probe 2: two functions ending `return 1; }`; the second is deleted.
  const two = ['function a() {', '  prepare();', '  return 1;', '}', '', 'function b() {', '  other();', '  return 1;', '}'];
  const onB = comment({ startLine: 8, endLine: 8, anchor: makeAnchor(two, 8, 8) });
  assert.equal(locateAnchor(two.slice(0, 4), onB).state, 'outdated');
  assert.equal(locateAnchor(two.slice(0, 5), onB).state, 'outdated', 'a trailing blank line agreeing too is still no evidence');

  // A copy whose agreeing context says something is still followed (the function moved up).
  const moved = ['function b() {', '  other();', '  return 1;', '}', '', 'function a() {', '  prepare();', '  return 1;', '}'];
  assert.deepEqual(locateAnchor(moved, onB), { state: 'moved', startLine: 3, endLine: 3 });
  // And so is one whose context is all `}` and blank lines, when all of it agrees.
  const braces = ['}', '', 'x();', '}', '', 'y();', '}'];
  const onY = comment({ startLine: 6, endLine: 6, anchor: makeAnchor(braces, 6, 6) });
  assert.deepEqual(locateAnchor(['// top', ...braces.slice(3)], onY), { state: 'moved', startLine: 4, endLine: 4 });
});

test('Send that finds no composer stores a new comment left in its field once, not twice', () => {
  const { store, items } = storedStore({ items: new Map() });
  store.show('s1');
  const host = store.host;
  host.compose = () => false;
  const surface = store.surface('file', 'src/a.ts');
  surface.draft = { side: 'file', startLine: 2, endLine: 2, text: 'Typed, not left', anchor: { text: 'import b', before: [], after: [] } };
  assert.equal(store.send(), 0);
  assert.deepEqual(store.all().map(c => c.text), ['Typed, not left']);
  assert.equal(surface.draft, null);
  assert.deepEqual(JSON.parse(items.get(`${STORED_PREFIX}s1`)).comments.map(c => c.text), ['Typed, not left'], 'storage holds what memory holds');
});

test('a comment on deleted lines always quotes them: their numbers are in the previous version', () => {
  const old = comment({ side: 'old', startLine: 13, endLine: 14, anchor: { text: '  legacy();\n  cleanup();', before: [], after: [] }, text: 'Why?' });
  // Shown on its lines in the diff, it still quotes them.
  assert.equal(reviewPrompt([old], () => true), [
    '1. src/a.ts, lines 13–14 (deleted lines)',
    '   Why?',
    '   Written on:',
    '      legacy();',
    '      cleanup();',
    '',
    SUMMARY_REQUEST,
  ].join('\n'));
  // A new-side comment shown on its lines does not.
  assert.doesNotMatch(reviewPrompt([{ ...old, side: 'new' }], () => true), /Written on/);
});

test('a diff range that left out deleted lines keeps saying so once saved, in storage and in the prompt', () => {
  assert.equal(droppedNote([14, 13]), 'deleted lines 13–14 not included');
  assert.equal(droppedNote([7]), 'deleted line 7 not included');
  assert.equal(droppedNote(undefined), '');
  assert.equal(lineRuns([14, 13, 16, 17, 19]), '13–14, 16–17, 19');
  const items = new Map();
  const first = storedStore({ items });
  first.store.show('s1');
  // Saved from a field (leaving it), and from Send with the text still in its field.
  first.store.add(input({ side: 'new', startLine: 12, endLine: 14, dropped: [13, 14], text: 'Saved' }));
  const surface = first.store.surface('diff', 'src/a.ts');
  surface.draft = { side: 'new', startLine: 20, endLine: 20, text: 'Typed', anchor: { text: 'x', before: [], after: [] }, dropped: [19] };
  first.store.typing('s1');
  first.store.flushTyping();
  const stored = JSON.parse(items.get(`${STORED_PREFIX}s1`)).comments;
  assert.deepEqual(stored.map(c => c.dropped), [[13, 14], [19]]);
  // Read back after a restart; entries stored before it was recorded, or malformed, have none.
  const raw = JSON.parse(items.get(`${STORED_PREFIX}s1`));
  raw.comments.push({ ...stored[0], id: 'legacy', dropped: undefined }, { ...stored[0], id: 'bad', dropped: ['x'] }, { ...stored[0], id: 'file', side: 'file', dropped: [3] });
  items.set(`${STORED_PREFIX}s1`, JSON.stringify(raw));
  const second = storedStore({ items });
  second.store.show('s1');
  assert.deepEqual(second.store.all().map(c => [c.text, c.dropped]), [['Saved', [13, 14]], ['Typed', [19]], ['Saved', undefined], ['Saved', undefined], ['Saved', undefined]]);
  // The prompt says it, after the lines.
  const prompt = reviewPrompt(second.store.all().slice(0, 1), () => true);
  assert.match(prompt, /^1\. src\/a\.ts, lines 12–14 \(deleted lines 13–14 not included\)\n {3}Saved\n/);
  first.store.surface('diff', 'src/a.ts').draft = null;
  // Send saves a typed draft with its dropped lines too.
  first.store.surface('diff', 'src/b.ts').draft = { side: 'new', startLine: 5, endLine: 6, text: 'Sent from the field', anchor: { text: 'a\nb', before: [], after: [] }, dropped: [4] };
  first.store.send();
  assert.match(first.composed.at(-1), /src\/b\.ts, lines 5–6 \(deleted line 4 not included\)/);
});
