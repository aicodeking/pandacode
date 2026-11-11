/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { HubIssue, HubPull, HubRun } from '../src/connect/api/github.ts';
import { age, checkBadge, checksLine, filterRows, isWebUrl, itemBadge, issueLine, pullBadge, runBadge, safeMarkdown } from '../src/ui/github/model.ts';

const NOW = Date.parse('2026-11-09T12:00:00Z');
const issue: HubIssue = { number: 12, title: 'Crash on start', author: 'mara', updatedAt: '2026-11-09T10:00:00Z', url: 'https://github.com/o/r/issues/12', comments: 1, labels: ['bug'], assignees: [] };
const pull: HubPull = { number: 15, title: 'Fix crash', author: 'devon', state: 'open', head: 'fix/crash', base: 'main', updatedAt: '2026-11-08T12:00:00Z', url: '', review: '', checks: 'passing', additions: 1, deletions: 1, labels: [] };
const run: HubRun = { id: 9001, workflow: 'CI', title: 'Fix crash', branch: 'fix/crash', event: 'pull_request', state: 'failed', createdAt: '', startedAt: '', updatedAt: '', url: '', attempt: 2, pulls: [15] };

test('ages read like the desktop tracker', () => {
  assert.equal(age('2026-11-09T11:59:50Z', NOW), 'now');
  assert.equal(age('2026-11-09T11:35:00Z', NOW), '25m');
  assert.equal(age('2026-11-09T07:00:00Z', NOW), '5h');
  assert.equal(age('2026-11-06T12:00:00Z', NOW), '3d');
  assert.equal(age('nonsense', NOW), '');
  assert.equal(issueLine(issue, NOW), '#12 · mara · 2h · 1 comment');
});

test('badges name each state with a tone', () => {
  assert.deepEqual(itemBadge('merged'), { label: 'Merged', tone: 'team' });
  assert.deepEqual(itemBadge('closed'), { label: 'Closed', tone: 'danger' });
  assert.equal(itemBadge('open').label, 'Open');
  assert.equal(pullBadge({ ...pull, checks: 'failing', review: 'approved' }).label, 'Failing', 'failing checks come first');
  assert.equal(pullBadge({ ...pull, review: 'approved' }).label, 'Approved');
  assert.equal(pullBadge({ ...pull, review: 'changes_requested' }).tone, 'warning');
  assert.equal(pullBadge({ ...pull, state: 'draft', checks: 'failing' }).label, 'Draft');
  assert.equal(runBadge('not_started').label, 'Didn’t start');
  assert.equal(runBadge('in_progress').tone, 'running');
  assert.equal(runBadge('whatever').label, 'Queued');
  assert.equal(checkBadge('failure').tone, 'danger');
  assert.equal(checksLine([{ name: 'a', workflow: '', state: 'failure', url: '' }, { name: 'b', workflow: '', state: 'success', url: '' }, { name: 'c', workflow: '', state: 'success', url: '' }]), '1 failing · 2 passed');
});

test('the search field filters by number, title, author, branch and label', () => {
  const rows = [issue, { ...issue, number: 7, title: 'Docs', author: 'sam', labels: ['docs'] }];
  assert.deepEqual(filterRows(rows, '#12').map(r => r.number), [12]);
  assert.deepEqual(filterRows(rows, 'DOCS').map(r => r.number), [7]);
  assert.deepEqual(filterRows(rows, 'mara').map(r => r.number), [12]);
  assert.equal(filterRows(rows, '  ').length, 2);
  assert.deepEqual(filterRows([pull], 'fix/').map(r => r.number), [15]);
  assert.deepEqual(filterRows([run], '9001').map(r => r.id), [9001]);
  assert.deepEqual(filterRows([run], 'ci').map(r => r.id), [9001]);
});

test('Markdown never loads an image: images become links, template comments go', () => {
  assert.equal(safeMarkdown('Look ![screenshot](https://x.test/a.png "t") here'), 'Look [screenshot](https://x.test/a.png) here');
  assert.equal(safeMarkdown('![](./local.png)'), '[Image](./local.png)');
  assert.equal(safeMarkdown('<img width="200" src="https://x.test/b.png" alt="b">'), '[Image](https://x.test/b.png)');
  assert.equal(safeMarkdown('<!-- fill this in -->\nBody'), 'Body');
  assert.equal(safeMarkdown('odd ![ text'), 'odd [ text');
  assert.ok(!safeMarkdown('a ![x](y) b <IMG SRC=\'z\'>').includes('!['));
  assert.ok(isWebUrl('https://github.com') && !isWebUrl('javascript:alert(1)') && !isWebUrl('http://x'));
});

test('starting from an issue sends one startId per draft and follows a lost reply', async () => {
  const { solveIssue } = await import('../src/connect/api/github.ts');
  const { LOST } = await import('../src/connect/rpc.ts');
  const sent: Record<string, unknown>[] = [];
  let ids = 0;
  let lose = true;
  const deps = {
    start: async (params: Record<string, unknown>) => { sent.push(params); if (lose) throw new Error(LOST); return { sessionId: 's1' }; },
    status: async () => ({ state: 'done' as const, sessionId: 's1', note: 'Started in a worktree: busy.' }),
    canPoll: () => true,
    sleep: async () => undefined,
    now: () => 0,
    uuid: () => `id-${++ids}`,
  };
  const form = { provider: 'claude', model: 'default' };
  const reply = await solveIssue(deps, 'dev', 'p1', 12, form);
  assert.equal(reply.sessionId, 's1', 'a lost reply turns into task.startStatus');
  assert.equal(reply.note, 'Started in a worktree: busy.');
  assert.deepEqual(sent, [{ projectId: 'p1', issueNumber: 12, ...form, startId: 'id-1' }]);

  // The host is still starting it: the next tap of the same issue reuses the id, so one task starts.
  const pending = { ...deps, status: async () => ({ state: 'running' as const }), now: (() => { let t = 0; return () => (t += 20 * 60_000); })() };
  await assert.rejects(solveIssue(pending, 'dev', 'p1', 13, form));
  lose = false;
  await solveIssue(deps, 'dev', 'p1', 13, form);
  assert.deepEqual(sent.slice(1).map(p => p.startId), ['id-2', 'id-2']);
  // A finished start leaves the next one a fresh id.
  await solveIssue(deps, 'dev', 'p1', 13, form);
  assert.equal(sent.at(-1)?.startId, 'id-3');
});

test('a write that must not run twice retries a lost reply once under the same sendId', async () => {
  const { runOnce, MAY_HAVE_RUN } = await import('../src/connect/api/github.ts');
  const { TIMED_OUT, LOST, OFFLINE } = await import('../src/connect/rpc.ts');
  const ids: (string | undefined)[] = [];
  const replies = (...steps: (Error | string)[]) => async (sendId?: string) => {
    ids.push(sendId);
    const step = steps.shift();
    if (step instanceof Error) throw step;
    return step;
  };

  assert.equal(await runOnce(replies('ok'), true, 'a1'), 'ok');
  assert.deepEqual(ids.splice(0), ['a1']);

  // Lost, then answered (the host answers a repeat with the first result): one more call, same id.
  assert.equal(await runOnce(replies(new Error(TIMED_OUT), 'first'), true, 'a2'), 'first');
  assert.deepEqual(ids.splice(0), ['a2', 'a2']);

  // Lost twice: it may have run, so nothing is sent a third time.
  await assert.rejects(runOnce(replies(new Error(LOST), new Error(OFFLINE)), true, 'a3'), { message: MAY_HAVE_RUN });
  assert.deepEqual(ids.splice(0), ['a3', 'a3']);

  // A refusal on the retry means it never ran: that error stands.
  await assert.rejects(runOnce(replies(new Error(TIMED_OUT), new Error('This task already has an open pull request.')), true, 'a4'), { message: 'This task already has an open pull request.' });
  ids.splice(0);

  // A host that can't dedupe gets no sendId and no retry.
  await assert.rejects(runOnce(replies(new Error(TIMED_OUT), 'twice'), false, 'a5'), { message: MAY_HAVE_RUN });
  assert.deepEqual(ids.splice(0), [undefined]);

  // A plain refusal is never retried.
  await assert.rejects(runOnce(replies(new Error('Invalid body.'), 'no'), true, 'a6'), { message: 'Invalid body.' });
  assert.deepEqual(ids.splice(0), ['a6']);

  // Each action gets its own id when none is given.
  const fresh: (string | undefined)[] = [];
  await runOnce(async id => { fresh.push(id); }, true);
  await runOnce(async id => { fresh.push(id); }, true);
  assert.ok(fresh[0] && fresh[1] && fresh[0] !== fresh[1]);
});

test('a review needs text unless it approves, and sends the body only when there is one', async () => {
  const { REVIEW_EVENTS, reviewDone, reviewParams, reviewProblem, MAX_REVIEW_BODY, GITHUB_METHODS } = await import('../src/connect/api/github.ts');
  assert.ok((GITHUB_METHODS as readonly string[]).includes('pull.review'));
  assert.deepEqual(REVIEW_EVENTS.map(e => e.value), ['approve', 'request_changes', 'comment']);
  assert.equal(reviewProblem('approve', ''), null);
  assert.equal(reviewProblem('comment', '   '), 'Write a comment for this review.');
  assert.equal(reviewProblem('request_changes', ''), 'Write a comment for this review.');
  assert.equal(reviewProblem('request_changes', 'Please add a test.'), null);
  assert.match(reviewProblem('comment', 'x'.repeat(MAX_REVIEW_BODY + 1)) ?? '', /at most/);
  assert.deepEqual(reviewParams('s1', 'approve', '  '), { sessionId: 's1', event: 'approve' });
  assert.deepEqual(reviewParams('s1', 'comment', ' Nice \n'), { sessionId: 's1', event: 'comment', body: 'Nice' });
  assert.equal(reviewDone('approve', 42), 'Approved #42');
  assert.equal(reviewDone('request_changes', 42), 'Requested changes on #42');
  assert.equal(reviewDone('comment', 42), 'Reviewed #42');
});

test('the demo review lands on the demo pull request timeline', async () => {
  // demo-host first: it loads the demo groups (demo/github.ts imports helpers from it).
  const { DEMO_PULL_TASK } = await import('../src/demo-host.ts');
  const { handlers } = await import('../src/demo/github.ts');
  let state = { pulls: {} } as unknown as import('../src/store/index.ts').ConnectState;
  const host = { get: () => state, set: (update: (s: typeof state) => Partial<typeof state>) => { state = { ...state, ...update(state) }; }, later: () => undefined, now: () => Date.parse('2026-11-10T09:00:00Z') };
  const review = (params: Record<string, unknown>) => handlers['pull.review']({ host, deviceId: 'mac', state, reply: () => undefined } as never, params);
  assert.throws(() => review({ sessionId: DEMO_PULL_TASK, event: 'comment', body: ' ' }), /Write a comment/);
  assert.throws(() => review({ sessionId: DEMO_PULL_TASK, event: 'merge' }), /Approve, request changes or comment/);
  assert.throws(() => review({ sessionId: 'other', event: 'approve' }), /no linked pull request/);
  const reply = review({ sessionId: DEMO_PULL_TASK, event: 'request_changes', body: 'Add a test.' }) as { number: number };
  const pull = state.pulls[`mac/${DEMO_PULL_TASK}`]!;
  assert.equal(reply.number, pull.number);
  assert.deepEqual(pull.timeline.at(-1), { kind: 'review', author: 'you', body: 'Add a test.', state: 'changes_requested', createdAt: '2026-11-10T09:00:00.000Z' });
});

test('GitHub refusing a review of your own pull request reads as a clear message', async () => {
  const { reviewErrorMessage, OWN_PULL_REVIEW } = await import('../src/connect/api/github.ts');
  assert.equal(reviewErrorMessage('failed to create review: GraphQL: Can not approve your own pull request (addPullRequestReview)'), OWN_PULL_REVIEW);
  assert.equal(reviewErrorMessage('GraphQL: can not request changes on your own pull request'), OWN_PULL_REVIEW);
  assert.equal(reviewErrorMessage('Cannot approve your own pull request'), OWN_PULL_REVIEW);
  assert.equal(reviewErrorMessage('HTTP 502'), 'HTTP 502');
  assert.match(OWN_PULL_REVIEW, /You can still comment/);
});
