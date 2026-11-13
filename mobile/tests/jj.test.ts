/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import { jjSummary } from '../src/ui/jj-summary.ts';

const change = { changeId: 'kxqvmzorpwtuabcdef', description: 'Fix the parser\n\nlonger body', bookmarks: [], conflict: false, empty: false };

test('no card outside a jj repo', () => {
  assert.equal(jjSummary(null), null);
  assert.equal(jjSummary({ isRepo: false, colocated: false, change: null, files: [], truncated: false }), null);
});

test('summarises the working-copy change', () => {
  const s = jjSummary({ isRepo: true, colocated: true, change: { ...change, bookmarks: ['main'] }, files: [{ status: 'M', path: 'a' }, { status: 'A', path: 'b' }], truncated: false });
  assert.deepEqual(s, { title: 'Fix the parser', subtitle: 'kxqvmzorpwtu · main · 2 files changed · Colocated with Git', conflict: false });
});

test('conflicts, empty changes and missing descriptions', () => {
  const s = jjSummary({ isRepo: true, colocated: false, change: { ...change, description: '', conflict: true, empty: true }, files: [], truncated: false });
  assert.deepEqual(s, { title: '(no description)', subtitle: 'kxqvmzorpwtu · Empty change · Has conflicts', conflict: true });
  assert.match(jjSummary({ isRepo: true, colocated: false, change, files: [{ status: 'M', path: 'a' }], truncated: true })!.subtitle, /1\+ files changed/);
});
