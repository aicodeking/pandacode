/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, diffSummary, fileCounts, numberedLines, statusLetter } from '../src/store/diff.ts';

const DIFF = [
  'diff --git a/a.sql b/a.sql',
  'index 1..2 100644',
  '--- a/a.sql',
  '+++ b/a.sql',
  '@@ -1,3 +1,3 @@',
  ' select 1;',
  '--- old comment',
  '+-- new comment',
  '\\ No newline at end of file',
  'diff --git a/b.ts b/b.ts',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/b.ts',
  '@@ -0,0 +1,2 @@',
  '+export const b = 1;',
  '+export const c = 2;',
  '',
].join('\n');

test('diff lines: headers are meta only before the first hunk', () => {
  assert.deepEqual(diffLines(DIFF).map(l => l.kind), [
    'meta', 'meta', 'meta', 'meta', 'hunk', 'context', 'del', 'add', 'meta',
    'meta', 'meta', 'meta', 'meta', 'hunk', 'add', 'add',
  ]);
  assert.deepEqual(diffLines(''), []);
});

test('per-file counts and status letters', () => {
  assert.deepEqual(fileCounts(DIFF), { 'a.sql': { additions: 1, deletions: 1 }, 'b.ts': { additions: 2, deletions: 0 } });
  assert.deepEqual(['??', ' M', 'M ', 'A ', ' D', 'R ', 'UU', 'C '].map(statusLetter), ['A', 'M', 'M', 'A', 'D', 'R', 'U', 'C']);
});

test('numbered lines drop file headers and count from each hunk', () => {
  const lines = numberedLines([
    'diff --git a/a.ts b/a.ts', '--- a/a.ts', '+++ b/a.ts',
    '@@ -10,3 +20,3 @@ fn', ' keep', '-gone', '+came', ' tail', '\\ No newline at end of file',
    '@@ -40 +50 @@', '-x', '+y',
  ].join('\n'));
  assert.deepEqual(lines.map(l => [l.kind, l.oldLine, l.newLine]), [
    ['hunk', undefined, undefined], ['context', 10, 20], ['del', 11, undefined], ['add', undefined, 21], ['context', 12, 22], ['meta', undefined, undefined],
    ['hunk', undefined, undefined], ['del', 40, undefined], ['add', undefined, 50],
  ]);
  assert.deepEqual(numberedLines('Binary files a/x and b/x differ').map(l => l.kind), ['meta']);
});

test('diff summary reads counts and status from headers or the first hunk', () => {
  assert.deepEqual(diffSummary('@@ -0,0 +1,2 @@\n+a\n+b'), { additions: 2, deletions: 0, letter: 'A' });
  assert.deepEqual(diffSummary('@@ -1,2 +0,0 @@\n-a\n-b'), { additions: 0, deletions: 2, letter: 'D' });
  assert.deepEqual(diffSummary('diff --git a/a b/b\nrename from a\nrename to b\n@@ -1 +1 @@\n-a\n+b'), { additions: 1, deletions: 1, letter: 'R' });
  assert.equal(diffSummary('@@ -3,2 +3,2 @@\n-a\n+b').letter, 'M');
});
