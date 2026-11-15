/// <reference types="node" />
import assert from 'node:assert/strict';
import test from 'node:test';
import type { TaskSummary } from '../src/connect/types.ts';
import type { DemoContext } from '../src/demo/index.ts';
import { handlers, resetDemoGit } from '../src/demo/git.ts';
import type { DemoHost } from '../src/demo-host.ts';
import {
  baseChoices, branchChoices, canDiscardAll, commitBlocker, discardNote, decodeBranches, decodePull, decodeStatus, decodeWorktree, openPull, pullBlocker, pullDraft,
  stageRows, stageSummary, subjectLine, suggestCommitMessage, syncLine, withStage, worktreeLine, type GitStatus,
} from '../src/store/git.ts';
import type { ConnectState } from '../src/store/index.ts';

const clean: GitStatus = decodeStatus({ branch: 'feat/x', upstream: 'origin/feat/x' });

test('decodeStatus fills defaults and drops malformed entries', () => {
  const status = decodeStatus({ branch: 'main', ahead: 2, behind: -1, staged: [{ path: 'a', status: 'M' }, { status: 'M' }, 'x'], untracked: ['n', 4, ''], pull: { number: 0 } });
  assert.equal(status.isRepo, true);
  assert.equal(status.ahead, 2);
  assert.equal(status.behind, 0);
  assert.deepEqual(status.staged, [{ path: 'a', status: 'M' }]);
  assert.deepEqual(status.untracked, ['n']);
  assert.equal(status.pull, null);
  assert.equal(status.upstream, null);
  assert.equal(decodeStatus(null).branch, '');
  assert.equal(decodeStatus({ isRepo: false }).isRepo, false);
});

test('decoders for pulls, branches and worktrees tolerate junk', () => {
  assert.deepEqual(decodePull({ number: 7, url: 'u', title: 't', state: 'open' }), { number: 7, url: 'u', title: 't', state: 'open' });
  assert.equal(decodePull('nope'), null);
  assert.deepEqual(decodeBranches({ current: 'a', branches: ['a', 3, 'b'], defaultBranch: 'main' }), { current: 'a', branches: ['a', 'b'], defaultBranch: 'main', worktree: false, running: false });
  const wt = decodeWorktree({ worktree: true, exists: true, changes: 2, clean: false });
  assert.equal(wt.changes, 2);
  assert.equal(wt.clean, false);
  assert.equal(decodeWorktree({}).clean, true);
});

test('stage rows join both halves of a file as partly staged', () => {
  const rows = stageRows({ staged: [{ path: 'b', status: 'M' }, { path: 'a', status: 'A' }], unstaged: [{ path: 'b', status: 'M' }, { path: 'c', status: 'D' }], untracked: ['d'] });
  assert.deepEqual(rows, [
    { path: 'a', letter: 'A', stage: 'all' },
    { path: 'b', letter: 'M', stage: 'partial' },
    { path: 'c', letter: 'D', stage: 'none' },
    { path: 'd', letter: 'A', stage: 'none' },
  ]);
  const toggled = withStage(rows, 'c', true);
  assert.equal(toggled[2].stage, 'all');
  assert.equal(rows[2].stage, 'none', 'the original rows are untouched');
  assert.equal(stageSummary(rows), '2 of 4 files staged');
  assert.equal(stageSummary(withStage(withStage(rows, 'a', false), 'b', false)), '4 files changed, none staged');
  assert.equal(stageSummary([{ path: 'a', letter: 'M', stage: 'all' }]), '1 file staged');
  assert.equal(stageSummary([]), 'No changes');
});

test('a staged rename keeps its source, and discarding it says the old file comes back', () => {
  const status = decodeStatus({ staged: [{ path: 'src/new.ts', status: 'R', origPath: 'src/old.ts' }, { path: 'a', status: 'M', origPath: 'a' }, { path: 'b', status: 'M', origPath: 7 }] });
  assert.deepEqual(status.staged, [{ path: 'src/new.ts', status: 'R', origPath: 'src/old.ts' }, { path: 'a', status: 'M' }, { path: 'b', status: 'M' }]);
  const rows = stageRows({ ...status, unstaged: [{ path: 'src/new.ts', status: 'M' }] });
  assert.deepEqual(rows.find(row => row.path === 'src/new.ts'), { path: 'src/new.ts', letter: 'R', stage: 'partial', origPath: 'src/old.ts' });
  assert.match(discardNote(rows.find(row => row.path === 'src/new.ts')!), /rename is undone: old\.ts comes back/);
  assert.match(discardNote({ letter: 'R' }), /go back to the last commit/, 'an older host without origPath: the plain text');
  assert.match(discardNote({ letter: 'A' }), /new file will be deleted/);
  assert.match(discardNote({ letter: 'M' }), /go back to the last commit/);
});

test('Discard all is off when git.status cut its lists', () => {
  const rows = stageRows({ staged: [], unstaged: [{ path: 'a', status: 'M' }], untracked: [] });
  assert.equal(canDiscardAll(decodeStatus({ truncated: false }), rows), true);
  assert.equal(canDiscardAll(decodeStatus({ truncated: true }), rows), false, 'never a silent partial discard');
  assert.equal(canDiscardAll(decodeStatus({}), []), false);
});

test('commit messages: subject lines are cut at a word, suggestions come from the title or files', () => {
  assert.equal(subjectLine('  Fix   the\nthing '), 'Fix the thing');
  const long = subjectLine('word '.repeat(40));
  assert.ok(long.length <= 72 && long.endsWith('…'));
  const rows = stageRows({ staged: [{ path: 'src/a.ts', status: 'M' }, { path: 'b.md', status: 'M' }], unstaged: [], untracked: [] });
  assert.equal(suggestCommitMessage('Add passkeys', rows), 'Add passkeys');
  assert.equal(suggestCommitMessage('', rows), 'Update b.md, a.ts');
  assert.equal(suggestCommitMessage('', []), '');
  assert.equal(commitBlocker('msg', []), 'Stage at least one file to commit.');
  assert.equal(commitBlocker('  ', rows), 'Write a commit message.');
  assert.equal(commitBlocker('msg', rows), null);
  assert.equal(commitBlocker('msg', rows, true), 'Wait for the agent to finish first.');
  assert.equal(commitBlocker('msg', rows, false), null);
});

test('pull requests need a clean, idle branch other than the base', () => {
  assert.equal(pullBlocker(clean, 'main'), null);
  assert.match(pullBlocker({ ...clean, untracked: ['x'] }, 'main') ?? '', /Commit/);
  assert.match(pullBlocker({ ...clean, running: true }, 'main') ?? '', /Wait/);
  assert.match(pullBlocker({ ...clean, branch: 'main' }, 'main') ?? '', /other than main/);
  assert.match(pullBlocker({ ...clean, isRepo: false }, 'main') ?? '', /Git/);
  assert.equal(openPull({ number: 1, url: '', title: '', state: 'draft' }), true);
  assert.equal(openPull({ number: 1, url: '', title: '', state: 'merged' }), false);
  assert.equal(openPull(null), false);
  assert.deepEqual(pullDraft('Add passkeys', '  Did it.  ', 'feat/passkeys'), { title: 'Add passkeys', body: 'Did it.' });
  assert.equal(pullDraft('', '', 'feat/passkey-sign_in').title, 'Passkey sign in');
});

test('branch lists: current first, defaults first for a base, never the head', () => {
  const list = decodeBranches({ current: 'feat/x', branches: ['main', 'feat/x', 'dev'], defaultBranch: 'main' });
  assert.deepEqual(branchChoices(list), ['feat/x', 'main', 'dev']);
  assert.deepEqual(branchChoices(list, 'DE'), ['dev']);
  assert.deepEqual(baseChoices(list, 'feat/x'), ['main', 'dev']);
  assert.deepEqual(baseChoices(list, 'main'), ['feat/x', 'dev']);
});

test('sync and worktree lines', () => {
  assert.equal(syncLine({ upstream: null, ahead: 0, behind: 0 }), 'Not pushed yet');
  assert.equal(syncLine({ upstream: 'origin/x', ahead: 2, behind: 1 }), '2 ahead · 1 behind of origin/x');
  assert.equal(syncLine({ upstream: 'origin/x', ahead: 0, behind: 0 }), 'Up to date with origin/x');
  const wt = decodeWorktree({ worktree: true, exists: true, clean: true, ahead: 1 });
  assert.equal(worktreeLine(wt), '1 commit not merged yet.');
  assert.equal(worktreeLine({ ...wt, merged: true }), 'Merged into the main branch.');
  assert.equal(worktreeLine({ ...wt, clean: false, changes: 3 }), '3 uncommitted changes.');
  assert.equal(worktreeLine({ ...wt, exists: false }), 'The worktree folder is gone.');
});

// ---- demo handlers ----

const task = (sessionId: string, branch: string): TaskSummary => ({
  sessionId, title: `Task ${sessionId}`, status: 'idle', projectId: 'p', projectName: 'p', provider: 'claude', model: 'default',
  effort: null, mode: 'ask', pinned: false, updatedAt: 0, lastPromptAt: null, branch,
});

function demo() {
  resetDemoGit();
  let state = {
    tasks: { mac: { tasks: [task('auth', 'feat/passkeys'), task('docs', 'docs/relay'), task('team', 'feat/team')], projects: [], loadedAt: 0 } },
    messages: { 'mac/docs': [{ id: 3, role: 'assistant', content: 'done', createdAt: 0, turnDurationMs: null, turnChanges: { id: 't', files: [{ path: 'README.md' }], additions: 1, deletions: 0 } }] },
    live: {}, pulls: {},
  } as unknown as ConnectState;
  const host: DemoHost = { get: () => state, set: update => { state = { ...state, ...update(state) } as ConnectState; }, later: () => undefined, now: () => 0 };
  const call = (method: string, params: Record<string, unknown>) => {
    const ctx: DemoContext = { host, deviceId: 'mac', state, reply: () => undefined };
    return handlers[method](ctx, params) as any;
  };
  return { call, state: () => state };
}

test('demo: stage, commit and push move the checkout along', () => {
  const { call } = demo();
  const before = call('git.status', { sessionId: 'auth' });
  assert.ok(before.unstaged.length + before.untracked.length > 0);
  assert.throws(() => call('git.commit', { sessionId: 'auth', message: 'x' }), /nothing added/);
  assert.ok(call('git.stage', { sessionId: 'auth', all: true }).count > 0);
  const staged = call('git.status', { sessionId: 'auth' });
  assert.equal(staged.unstaged.length + staged.untracked.length, 0);
  assert.throws(() => call('git.commit', { sessionId: 'auth', message: '  ' }), /commit message/);
  const result = call('git.commit', { sessionId: 'auth', message: 'Add passkeys', push: true });
  assert.equal(result.pushed, true);
  const after = call('git.status', { sessionId: 'auth' });
  assert.equal(after.staged.length, 0);
  assert.equal(after.ahead, 0);
});

test('demo: unstaging an added file makes it untracked again', () => {
  const { call } = demo();
  const path = call('git.status', { sessionId: 'auth' }).untracked[0];
  call('git.stage', { sessionId: 'auth', paths: [path] });
  assert.ok(call('git.status', { sessionId: 'auth' }).staged.some((e: { path: string }) => e.path === path));
  call('git.stage', { sessionId: 'auth', paths: [path], unstage: true });
  assert.ok(call('git.status', { sessionId: 'auth' }).untracked.includes(path));
});

test('demo: discard drops only the named files and refuses escapes', () => {
  const { call } = demo();
  const before = call('git.status', { sessionId: 'auth' });
  const path = before.untracked[0] ?? before.unstaged[0].path;
  const total = before.staged.length + before.unstaged.length + before.untracked.length;
  assert.ok(call('git.discard', { sessionId: 'auth', paths: [path] }).count >= 1);
  const after = call('git.status', { sessionId: 'auth' });
  const listed = [...after.staged.map((e: { path: string }) => e.path), ...after.unstaged.map((e: { path: string }) => e.path), ...after.untracked];
  assert.ok(!listed.includes(path));
  assert.ok(listed.length > 0 && listed.length < total);
  assert.equal(call('git.discard', { sessionId: 'auth', paths: [path] }).count, 0, 'a retry changes nothing');
  assert.throws(() => call('git.discard', { sessionId: 'auth', paths: ['../x'] }), /inside the project/);
  assert.throws(() => call('git.discard', { sessionId: 'auth', paths: [] }), /Missing paths/);
  call('git.discard', { sessionId: 'auth', paths: listed });
  const clean = call('git.status', { sessionId: 'auth' });
  assert.equal(clean.staged.length + clean.unstaged.length + clean.untracked.length, 0);
});

test('demo: Stage all follows the host, partly staged files included, and skips folder rows', () => {
  const { call } = demo();
  const before = call('git.status', { sessionId: 'team' });
  const partial = 'mobile/src/connect/api/team.ts';
  const folder = 'mobile/vendor/relay-sdk/';
  assert.ok(before.staged.some((e: { path: string }) => e.path === partial) && before.unstaged.some((e: { path: string }) => e.path === partial), 'partly staged');
  assert.ok(before.untracked.includes(folder));
  const moves = before.unstaged.length + before.untracked.length;
  assert.deepEqual(call('git.stage', { sessionId: 'team', all: true }), { count: moves - 1, skipped: 1 });
  const staged = call('git.status', { sessionId: 'team' });
  assert.deepEqual(staged.unstaged, [], 'the partly staged file moved too');
  assert.deepEqual(staged.untracked, [folder], 'only the folder row stays');
  const unstaged = call('git.stage', { sessionId: 'team', all: true, unstage: true });
  assert.deepEqual(unstaged, { count: staged.staged.length, skipped: 0 });
  assert.equal(call('git.status', { sessionId: 'team' }).staged.length, 0);
  assert.throws(() => call('git.stage', { sessionId: 'team', paths: [folder] }), /Select individual files to stage or unstage/);
});

test('demo: Discard all with skipFolders leaves folder rows and counts them', () => {
  const { call } = demo();
  const status = call('git.status', { sessionId: 'team' });
  const listed: string[] = [...new Set<string>([...status.staged.map((e: { path: string }) => e.path), ...status.unstaged.map((e: { path: string }) => e.path), ...status.untracked])];
  assert.throws(() => call('git.discard', { sessionId: 'team', paths: listed }), /Select individual files to discard/);
  assert.deepEqual(call('git.discard', { sessionId: 'team', paths: listed, skipFolders: true }), { count: listed.length - 1, skipped: 1 });
  const after = call('git.status', { sessionId: 'team' });
  assert.deepEqual([after.staged.length, after.unstaged.length, after.untracked], [0, 0, ['mobile/vendor/relay-sdk/']]);
  assert.deepEqual(call('git.discard', { sessionId: 'team', paths: ['README.md'] }), { count: 0, skipped: 0 });
});

test('demo: branches switch only on a clean main checkout', () => {
  const { call } = demo();
  assert.throws(() => call('git.switchBranch', { sessionId: 'auth', branch: 'main' }), /overwritten/);
  call('git.stage', { sessionId: 'auth', all: true });
  call('git.commit', { sessionId: 'auth', message: 'wip' });
  assert.equal(call('git.switchBranch', { sessionId: 'auth', branch: 'main' }).current, 'main');
  assert.throws(() => call('git.switchBranch', { sessionId: 'auth', branch: 'nope' }), /no local branch/);
  assert.throws(() => call('git.switchBranch', { sessionId: 'docs', branch: 'main' }), /worktree/);
});

test('demo: a worktree merges once clean, then is removed', () => {
  const { call } = demo();
  assert.deepEqual(call('worktree.status', { sessionId: 'auth' }), { worktree: false });
  assert.equal(call('worktree.status', { sessionId: 'docs' }).worktree, true);
  assert.throws(() => call('worktree.merge', { sessionId: 'docs' }), /Commit/);
  call('git.stage', { sessionId: 'docs', all: true });
  call('git.commit', { sessionId: 'docs', message: 'Docs' });
  assert.equal(call('worktree.merge', { sessionId: 'docs' }).target, 'main');
  assert.equal(call('worktree.status', { sessionId: 'docs' }).merged, true);
  assert.equal(call('worktree.remove', { sessionId: 'docs', deleteBranch: true }).branchDeleted, true);
  assert.deepEqual(call('worktree.status', { sessionId: 'docs' }), { worktree: false });
});

test('demo: a pull request opens once the work is committed and links the task', () => {
  const { call, state } = demo();
  assert.throws(() => call('pull.create', { sessionId: 'auth', title: 'Add passkeys' }), /Commit or stash/);
  call('git.stage', { sessionId: 'auth', all: true });
  call('git.commit', { sessionId: 'auth', message: 'Add passkeys' });
  const created = call('pull.create', { sessionId: 'auth', title: 'Add passkeys', draft: true });
  assert.equal(created.pull.state, 'draft');
  assert.equal(state().pulls['mac/auth']?.head, 'feat/passkeys');
  assert.equal(call('git.status', { sessionId: 'auth' }).pull.number, created.pull.number);
  assert.throws(() => call('pull.create', { sessionId: 'auth', title: 'Again' }), /already/);
});

test('demo: turn summaries and diffs come from the message’s changes', () => {
  const { call } = demo();
  assert.equal(call('turn.summary', { sessionId: 'docs', messageId: 3 }).files[0].path, 'README.md');
  assert.match(call('turn.diff', { sessionId: 'docs', messageId: 3, path: 'README.md' }).patch, /^@@/);
  assert.throws(() => call('turn.diff', { sessionId: 'docs', messageId: 3, path: 'x' }), /not in this turn/);
  assert.throws(() => call('turn.summary', { sessionId: 'docs', messageId: 9 }), /no recorded changes/);
});

test('worktree.create runs once per tap, and a commit always gets the long deadline', async () => {
  const { readFileSync } = await import('node:fs');
  const source = readFileSync(new URL('../src/connect/api/git.ts', import.meta.url), 'utf8');
  assert.match(source, /hostCallForkOnce<.+?>\(deviceId, 'worktree\.create'/);
  assert.doesNotMatch(source, /hostCall<.+?>\(deviceId, 'worktree\.create'/);
  const commit = source.slice(source.indexOf('export async function commitChanges'));
  assert.match(commit.slice(0, commit.indexOf('\n}\n')), /timeoutMs: push \? NETWORK_TIMEOUT_MS : MERGE_TIMEOUT_MS/);
});

test('only user-initiated calls cut a reconnect backoff short', async () => {
  const { readFileSync } = await import('node:fs');
  const client = readFileSync(new URL('../src/connect/client.ts', import.meta.url), 'utf8');
  assert.match(client, /await whenConnected\(userInitiated\(method, background, automatic\)\)/);
  assert.doesNotMatch(client, /whenConnected\(!background\)/);
  const automatic = client.slice(client.indexOf('const AUTOMATIC_METHODS'), client.indexOf('\n', client.indexOf('const AUTOMATIC_METHODS')));
  for (const method of ['host.hello', 'subscribe', 'task.messages', 'tasks.list']) assert.ok(automatic.includes(`'${method}'`), method);
  for (const method of ['task.send', 'git.commit', 'worktree.create']) assert.ok(!automatic.includes(`'${method}'`), method);
});

test('discardAllPaths sends each file once and leaves folder rows out', async () => {
  const { discardAllPaths } = await import('../src/store/git.ts');
  assert.deepEqual(discardAllPaths([{ path: 'a.txt' }, { path: 'nested/' }, { path: 'a.txt' }, { path: 'b/c.txt' }]), ['a.txt', 'b/c.txt']);
  assert.deepEqual(discardAllPaths([{ path: 'sub/' }]), []);
  const rows = stageRows({ staged: [{ path: 'a', status: 'M' }], unstaged: [{ path: 'a', status: 'M' }], untracked: ['dir/'] });
  assert.deepEqual(discardAllPaths(rows), ['a']);
});
