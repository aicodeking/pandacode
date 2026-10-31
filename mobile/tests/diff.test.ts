/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { diffLines, fileCounts, statusLetter } from '../src/store/diff.ts';

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
