// Demo answers for the `git` feature group (src/connect/api/git.ts). See ./index.ts.
// Each task's checkout starts from demo-pull.ts's changes; staging, commits, pushes, branch
// switches and worktree steps then live here for the session (replaced, never mutated).
import type { ChangedFile, TaskSummary } from '../connect/types.ts';
import { demoChanges, demoPull } from '../demo-pull.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

interface Checkout {
  branch: string; upstream: string | null; ahead: number; behind: number; files: readonly ChangedFile[];
  branches: readonly string[]; worktree: 'none' | 'present' | 'merged' | 'removed';
}

/** Tasks that run in their own worktree in the demo. */
const WORKTREE_TASKS = new Set(['flaky', 'docs']);
const DEFAULT_BRANCH = 'main';
const OTHER_BRANCHES = ['main', 'release/0.4', 'fix/sidebar-flicker'];

/**
 * Rows the host lists beyond demo-pull.ts's files: a partly staged file, and an untracked nested
 * repository (`dir/`, a folder row Git cannot stage or discard one file at a time).
 */
const EXTRA_ROWS: Readonly<Record<string, readonly ChangedFile[]>> = {
  team: [
    { path: 'mobile/src/connect/api/team.ts', status: 'MM', staged: true },
    { path: 'mobile/vendor/relay-sdk/', status: '??', staged: false },
  ],
};

let checkouts: Readonly<Record<string, Checkout>> = {};

const keyOf = (ctx: DemoContext, sessionId: string) => `${ctx.deviceId}/${sessionId}`;
const taskOf = (ctx: DemoContext, sessionId: string): TaskSummary | undefined => ctx.state.tasks[ctx.deviceId]?.tasks.find(t => t.sessionId === sessionId);

function checkoutOf(ctx: DemoContext, sessionId: string): Checkout {
  const held = checkouts[keyOf(ctx, sessionId)];
  if (held) return held;
  const changes = demoChanges(sessionId, taskOf(ctx, sessionId)?.branch);
  const branches = [changes.branch, ...OTHER_BRANCHES.filter(b => b !== changes.branch)];
  return {
    branch: changes.branch, upstream: changes.branch === DEFAULT_BRANCH ? 'origin/main' : `origin/${changes.branch}`, ahead: changes.ahead, behind: changes.behind,
    files: [...changes.files, ...(EXTRA_ROWS[sessionId] ?? [])], branches, worktree: WORKTREE_TASKS.has(sessionId) ? 'present' : 'none',
  };
}

function save(ctx: DemoContext, sessionId: string, change: Partial<Checkout>): Checkout {
  const next = { ...checkoutOf(ctx, sessionId), ...change };
  checkouts = { ...checkouts, [keyOf(ctx, sessionId)]: next };
  return next;
}

const isStaged = (file: ChangedFile) => file.staged;
/** A folder or gitlink row, which the host leaves out of Stage all and Discard all (`skipped`). */
const isFolderRow = (path: string) => path.endsWith('/');
const FOLDER_STAGE_REFUSED = 'Select individual files to stage or unstage';
const FOLDER_DISCARD_REFUSED = 'Select individual files to discard';
/** As the host's `git.stage {all}`: unstage every staged file; stage every untracked file and
 *  every file with a working-tree change, partly staged ones included. */
function movesInAll(file: ChangedFile, unstage: boolean): boolean {
  const [index = ' ', working = ' '] = file.status;
  if (unstage) return index !== ' ' && index !== '?' && index !== '!';
  return file.status === '??' || (working !== ' ' && working !== '!');
}

function statusReply(ctx: DemoContext, sessionId: string) {
  const checkout = checkoutOf(ctx, sessionId);
  const task = taskOf(ctx, sessionId);
  const pull = ctx.state.pulls[keyOf(ctx, sessionId)];
  const running = ctx.state.live[keyOf(ctx, sessionId)]?.status === 'running' || task?.status === 'running';
  const letter = (status: string, at: 0 | 1) => status[at]?.trim() || '';
  return {
    isRepo: true, branch: checkout.branch, upstream: checkout.upstream, ahead: checkout.ahead, behind: checkout.behind,
    staged: checkout.files.filter(f => f.status !== '??' && letter(f.status, 0)).map(f => ({ path: f.path, status: letter(f.status, 0) })),
    unstaged: checkout.files.filter(f => f.status !== '??' && letter(f.status, 1)).map(f => ({ path: f.path, status: letter(f.status, 1) })),
    untracked: checkout.files.filter(f => f.status === '??').map(f => f.path),
    truncated: false, running, title: task?.title ?? '', worktree: checkout.worktree === 'present' || checkout.worktree === 'merged',
    pull: pull ? { number: pull.number, url: pull.url, title: pull.title, state: pull.state } : null,
  };
}

/** A file moved to the index or out of it, with its porcelain status to match. */
function restaged(file: ChangedFile, staged: boolean): ChangedFile {
  const change = file.status === '??' ? 'A' : (file.status.trim()[0] ?? 'M');
  if (staged) return { ...file, status: `${change} `, staged: true };
  return change === 'A' ? { ...file, status: '??', staged: false } : { ...file, status: ` ${change}`, staged: false };
}

function stage(ctx: DemoContext, p: { sessionId: string; paths?: string[]; all?: boolean; unstage?: boolean }) {
  const checkout = checkoutOf(ctx, p.sessionId);
  const unstage = !!p.unstage;
  if (!p.all) {
    const paths = p.paths ?? [];
    if (paths.some(isFolderRow)) throw new Error(FOLDER_STAGE_REFUSED);
    const wanted = (file: ChangedFile) => paths.includes(file.path);
    save(ctx, p.sessionId, { files: checkout.files.map(file => (wanted(file) ? restaged(file, !unstage) : file)) });
    return { count: paths.length };
  }
  const listed = checkout.files.filter(file => movesInAll(file, unstage));
  const wanted = (file: ChangedFile) => listed.includes(file) && !isFolderRow(file.path);
  save(ctx, p.sessionId, { files: checkout.files.map(file => (wanted(file) ? restaged(file, !unstage) : file)) });
  const count = listed.filter(wanted).length;
  return { count, skipped: listed.length - count };
}

/** git.discard: the named files leave the checkout's changes (restored from HEAD, or deleted when
 *  untracked). `skipFolders` (Discard all) leaves folder rows out, counted in `skipped`. */
function discard(ctx: DemoContext, p: { sessionId: string; paths?: string[]; skipFolders?: boolean }) {
  const paths = Array.isArray(p.paths) ? p.paths : [];
  if (!paths.length) throw new Error('Missing paths.');
  if (paths.some(path => typeof path !== 'string' || !path || path.startsWith('/') || path.split('/').some(part => part === '..' || part === '.git'))) {
    throw new Error('Path must stay inside the project');
  }
  const folders = paths.filter(isFolderRow);
  if (folders.length && !p.skipFolders) throw new Error(FOLDER_DISCARD_REFUSED);
  const named = paths.filter(path => !isFolderRow(path));
  const checkout = checkoutOf(ctx, p.sessionId);
  const kept = checkout.files.filter(file => !named.includes(file.path));
  save(ctx, p.sessionId, { files: kept });
  return { count: checkout.files.length - kept.length, skipped: folders.length };
}

function commit(ctx: DemoContext, p: { sessionId: string; message: string; push?: boolean }) {
  const checkout = checkoutOf(ctx, p.sessionId);
  const staged = checkout.files.filter(isStaged);
  if (!String(p.message ?? '').trim()) throw new Error('Write a commit message (up to 16 KB).');
  if (!staged.length) throw new Error('nothing added to commit but untracked files present (use "git add" to track)');
  const rest = checkout.files.filter(file => !isStaged(file));
  const subject = String(p.message).split('\n')[0];
  const output = `[${checkout.branch} 3f9c2ab] ${subject}\n ${staged.length} file${staged.length === 1 ? '' : 's'} changed`;
  const next = save(ctx, p.sessionId, { files: rest, ahead: p.push ? 0 : checkout.ahead + 1, upstream: checkout.upstream ?? `origin/${checkout.branch}` });
  return p.push ? { output, pushed: true, pushOutput: `To github.com:pandadev/demo.git\n   1a2b3c4..3f9c2ab  ${next.branch} -> ${next.branch}` } : { output, pushed: false };
}

function push(ctx: DemoContext, p: { sessionId: string }) {
  const checkout = save(ctx, p.sessionId, { ahead: 0, upstream: checkoutOf(ctx, p.sessionId).upstream ?? `origin/${checkoutOf(ctx, p.sessionId).branch}` });
  return { output: `branch '${checkout.branch}' set up to track '${checkout.upstream}'.` };
}

function branchesReply(ctx: DemoContext, sessionId: string) {
  const checkout = checkoutOf(ctx, sessionId);
  return { current: checkout.branch, branches: checkout.branches, defaultBranch: DEFAULT_BRANCH, worktree: checkout.worktree === 'present', running: statusReply(ctx, sessionId).running };
}

function switchTo(ctx: DemoContext, p: { sessionId: string; branch: string }) {
  const checkout = checkoutOf(ctx, p.sessionId);
  if (statusReply(ctx, p.sessionId).running) throw new Error('Wait for the agent to finish first.');
  if (checkout.worktree === 'present') throw new Error('This task works in its own worktree; its branch stays as it is.');
  if (!checkout.branches.includes(p.branch)) throw new Error(`There is no local branch named ${p.branch}.`);
  if (checkout.files.some(f => f.status !== '??')) throw new Error('error: Your local changes to the following files would be overwritten by checkout. Commit your changes or stash them before you switch branches.');
  save(ctx, p.sessionId, { branch: p.branch, upstream: `origin/${p.branch}`, ahead: 0, behind: 0 });
  return branchesReply(ctx, p.sessionId);
}

function worktreeReply(ctx: DemoContext, sessionId: string) {
  const checkout = checkoutOf(ctx, sessionId);
  if (checkout.worktree === 'none' || checkout.worktree === 'removed') return { worktree: false };
  const changes = checkout.files.length;
  return {
    worktree: true, exists: true, branch: checkout.branch, changes, clean: changes === 0, hasUpstream: !!checkout.upstream,
    ahead: checkout.worktree === 'merged' ? 0 : Math.max(checkout.ahead, 2), merged: checkout.worktree === 'merged', running: statusReply(ctx, sessionId).running,
  };
}

function mergeWorktree(ctx: DemoContext, p: { sessionId: string }) {
  const state = worktreeReply(ctx, p.sessionId);
  if (!state.worktree) throw new Error('This task uses the main checkout.');
  if (state.running) throw new Error('Wait for the agent to finish before merging its worktree.');
  if (!state.clean) throw new Error('Commit or discard the worktree’s changes before merging.');
  const checkout = save(ctx, p.sessionId, { worktree: 'merged' });
  return { branch: checkout.branch, target: DEFAULT_BRANCH, commits: state.ahead ?? 0, switchedFrom: null };
}

function removeWorktree(ctx: DemoContext, p: { sessionId: string; deleteBranch?: boolean }) {
  const state = worktreeReply(ctx, p.sessionId);
  if (!state.worktree) throw new Error('This task uses the main checkout.');
  if (state.running) throw new Error('Stop the agent before removing its worktree.');
  if (!state.clean) throw new Error('fatal: the worktree contains modified or untracked files, use --force to delete it');
  const checkout = save(ctx, p.sessionId, { worktree: 'removed' });
  return { removed: true, branch: checkout.branch, branchDeleted: !!p.deleteBranch && !!state.merged, note: p.deleteBranch && !state.merged ? 'The branch was kept: it has commits that are not merged.' : '' };
}

/** As the host's worktree_branch_name: letters, digits, `-`, `_` and `/`, under `pandacode/` unless already namespaced. */
function worktreeBranch(name: string): string {
  const trimmed = name.trim();
  if (!trimmed || trimmed.length > 120 || trimmed.includes('..') || !/^[A-Za-z0-9_/-]+$/.test(trimmed)) throw new Error('Use a branch name with letters, numbers, hyphens, underscores and slashes.');
  return /^(pandacode|kingcode|codex)\//.test(trimmed) ? trimmed : `pandacode/${trimmed}`;
}

/** The host's suggestion from the title: whole lowercase words, up to 40 characters. */
function suggestedBranch(title: string, sessionId: string): string {
  const words = title === 'New conversation' ? [] : title.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const slug = words.reduce((acc, word) => (!acc ? word.slice(0, 40) : acc.length + 1 + word.length > 40 ? acc : `${acc}-${word}`), '');
  return slug || `task-${sessionId.replace(/[^A-Za-z0-9]/g, '').slice(0, 8)}`;
}

/** worktree.create: an unstarted task moves into a new worktree; a started one gets a new task there. */
function createWorktree(ctx: DemoContext, p: { sessionId: string; branch?: string }) {
  const task = taskOf(ctx, p.sessionId);
  if (!task) throw new Error('That task is not on this computer.');
  if (checkoutOf(ctx, p.sessionId).worktree === 'present') throw new Error('This task already has a worktree.');
  if (statusReply(ctx, p.sessionId).running) throw new Error('Stop the agent before moving this task into a worktree.');
  const branch = worktreeBranch(p.branch ?? suggestedBranch(task.title, task.sessionId));
  const fresh = { branch, upstream: null, ahead: 0, behind: 0, files: [], branches: [branch, ...OTHER_BRANCHES], worktree: 'present' as const };
  const started = !!task.lastPromptAt || !!ctx.state.messages[keyOf(ctx, p.sessionId)]?.length;
  if (!started) {
    save(ctx, p.sessionId, fresh);
    return { sessionId: task.sessionId, moved: true, branch, path: `/demo/${task.projectName}-worktrees/${branch.replaceAll('/', '-')}` };
  }
  const sessionId = `${task.sessionId}-wt-${ctx.host.now().toString(36)}`;
  const now = ctx.host.now();
  ctx.host.set(s => {
    const list = s.tasks[ctx.deviceId];
    if (!list) return {};
    const copy = { ...task, sessionId, title: 'New conversation', status: 'idle', branch, stage: 'pending', archived: false, pinned: false, lastPromptAt: null, updatedAt: now, pending: [] };
    return { tasks: { ...s.tasks, [ctx.deviceId]: { ...list, tasks: [copy, ...list.tasks] } } };
  });
  save(ctx, sessionId, fresh);
  return { sessionId, moved: false, branch, path: `/demo/${task.projectName}-worktrees/${branch.replaceAll('/', '-')}` };
}

function createPull(ctx: DemoContext, p: { sessionId: string; title: string; body?: string; base?: string; draft?: boolean }) {
  const status = statusReply(ctx, p.sessionId);
  if (status.pull && (status.pull.state === 'open' || status.pull.state === 'draft')) throw new Error('This task already has an open pull request.');
  if (status.running) throw new Error('Wait for the agent to finish first.');
  if (status.staged.length || status.unstaged.length || status.untracked.length) throw new Error('Commit or stash your changes before opening a pull request. The Changes tab can commit them.');
  const base = p.base || DEFAULT_BRANCH;
  if (status.branch === base) throw new Error(`Create a branch other than ${base} before opening a pull request.`);
  const number = 500 + Object.keys(ctx.state.pulls).length;
  const pull = {
    ...demoPull(), number, title: String(p.title).trim(), body: p.body ?? '', state: p.draft ? 'draft' : 'open', base, head: status.branch,
    url: `https://github.com/pandadev/demo/pull/${number}`, reviewDecision: '', checks: [], timeline: [], createdAt: new Date(ctx.host.now()).toISOString(), updatedAt: new Date(ctx.host.now()).toISOString(),
  };
  save(ctx, p.sessionId, { ahead: 0, upstream: `origin/${status.branch}` });
  ctx.host.set(s => ({ pulls: { ...s.pulls, [keyOf(ctx, p.sessionId)]: pull } }));
  return { pull: { number, url: pull.url, title: pull.title, state: pull.state }, note: null };
}

/** The message's own `turnChanges` stand in for the stored summary. */
function turnChangesOf(ctx: DemoContext, sessionId: string, messageId: number) {
  const message = ctx.state.messages[keyOf(ctx, sessionId)]?.find(m => m.id === messageId);
  const changes = message?.turnChanges as { id?: string; files?: { path: string }[]; additions?: number; deletions?: number } | undefined;
  if (!changes) throw new Error('This message has no recorded changes.');
  return changes;
}

function turnSummary(ctx: DemoContext, p: { sessionId: string; messageId: number }) {
  const changes = turnChangesOf(ctx, p.sessionId, p.messageId);
  const files = (changes.files ?? []).map(f => ({ path: f.path, status: 'modified', additions: 1, deletions: 0, binary: false, truncated: false }));
  return { id: changes.id ?? 'demo', files, additions: changes.additions ?? 0, deletions: changes.deletions ?? 0, truncated: false, concurrent: false, attributed: true };
}

function turnDiff(ctx: DemoContext, p: { sessionId: string; messageId: number; path: string }) {
  const changes = turnChangesOf(ctx, p.sessionId, p.messageId);
  if (!(changes.files ?? []).some(f => f.path === p.path)) throw new Error('This file is not in this turn’s change summary.');
  return { path: p.path, patch: '@@ -1,3 +1,4 @@\n context\n-old line\n+new line\n+another line\n context', binary: false, truncated: false };
}

export const handlers: DemoHandlers = {
  'git.status': (ctx, p) => statusReply(ctx, p.sessionId),
  'git.stage': stage,
  'git.discard': discard,
  'git.commit': commit,
  'git.push': push,
  'git.branches': (ctx, p) => branchesReply(ctx, p.sessionId),
  'git.switchBranch': switchTo,
  'worktree.status': (ctx, p) => worktreeReply(ctx, p.sessionId),
  'worktree.merge': mergeWorktree,
  'worktree.remove': removeWorktree,
  'worktree.create': createWorktree,
  'pull.create': createPull,
  'turn.summary': turnSummary,
  'turn.diff': turnDiff,
};

/** Forgets the demo's git state (leaving the demo, tests). */
export function resetDemoGit() {
  checkouts = {};
}
