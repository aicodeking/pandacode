/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { PullCheck, PullComment } from '../src/connect/types.ts';
import { checksLine, conflictsLine, countParts, reviewLine } from '../src/store/pull-summary.ts';
import { groupByFolder } from '../src/ui/file-groups.ts';

const check = (state: PullCheck['state']): PullCheck => ({ name: 'x', state, url: '' });
const review = (author: string, state: string): PullComment => ({ kind: 'review', author, state, body: '', createdAt: '' });

test('failing checks outrank pending, and pending outranks passed', () => {
  assert.equal(checksLine([]), null);
  assert.deepEqual(checksLine([check('success'), check('failure'), check('pending')]), { tone: 'danger', title: '1 check failing', meta: '1 of 3' });
  assert.deepEqual(checksLine([check('success'), check('pending'), check('pending')]), { tone: 'warning', title: '2 checks pending', meta: '1 of 3' });
  assert.deepEqual(checksLine([check('success')]), { tone: 'success', title: 'All checks passed', meta: '1 of 1' });
});

test('approval names each approver once; an unknown decision has no line', () => {
  const timeline = [review('mira', 'APPROVED'), review('mira', 'approved'), review('jo', 'commented')];
  assert.equal(reviewLine({ reviewDecision: 'approved', timeline })?.title, 'Approved by mira');
  assert.equal(reviewLine({ reviewDecision: '', timeline }), null);
});

test('conflicts follow the host, and anything unknown stays neutral', () => {
  const pull = { base: 'main' };
  assert.equal(conflictsLine({ ...pull, mergeable: 'conflicting' }, 'squash').tone, 'danger');
  assert.equal(conflictsLine({ ...pull, mergeable: 'mergeable' }, 'merge').title, 'No conflicts with main');
  assert.equal(conflictsLine({ ...pull, mergeable: 'unknown' }, 'rebase').tone, 'neutral');
});

test('a zero count says nothing, in either direction', () => {
  assert.deepEqual(countParts(6, 0), { added: '+6' });
  assert.deepEqual(countParts(0, 2), { removed: '−2' });
  assert.deepEqual(countParts(3, 1), { added: '+3', removed: '−1' });
  assert.deepEqual(countParts(undefined, 0), {});
});

test('files group under their folders in first-seen order', () => {
  const groups = groupByFolder([{ path: 'a/x.ts' }, { path: 'root.md' }, { path: 'a/y.ts' }, { path: 'a/b/z.ts' }]);
  assert.deepEqual(groups.map(g => [g.folder, g.files.length]), [['a', 2], ['', 1], ['a/b', 1]]);
});
