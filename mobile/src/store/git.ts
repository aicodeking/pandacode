// Pure logic for git & shipping from the phone (src/connect/api/git.ts): decoding the host's
// replies defensively, one stage row per file, and the suggested texts for a commit and a pull
// request. Tested in tests/git.test.ts.

/** `origPath`: a staged rename's source (git.status sends it for `R`/`C`). */
export interface GitEntry { path: string; status: string; origPath?: string }
export interface PullLink { number: number; url: string; title: string; state: string }

export interface GitStatus {
  isRepo: boolean; branch: string; upstream: string | null; ahead: number; behind: number;
  staged: GitEntry[]; unstaged: GitEntry[]; untracked: string[]; truncated: boolean;
  running: boolean; title: string; worktree: boolean; pull: PullLink | null;
}

export interface BranchList { current: string; branches: string[]; defaultBranch: string; worktree: boolean; running: boolean }

export interface WorktreeState {
  worktree: boolean; exists: boolean; branch: string; changes: number; clean: boolean;
  hasUpstream: boolean; ahead: number; merged: boolean; running: boolean;
}

export interface WorktreeMerge { branch: string; target: string; commits: number; switchedFrom: string | null }
export interface WorktreeRemoval { removed: boolean; branch: string; branchDeleted: boolean; note: string }
export interface CommitResult { output: string; pushed: boolean; pushOutput?: string; pushError?: string }

/** How much of a file is staged: everything, nothing, or some of its changes. */
export type StageState = 'all' | 'none' | 'partial';
/** `origPath`: the path a staged rename came from; discarding the row brings it back. */
export interface StageRow { path: string; letter: string; stage: StageState; origPath?: string }

const obj = (value: unknown): Record<string, unknown> => (value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {});
const str = (value: unknown, fallback = ''): string => (typeof value === 'string' ? value : fallback);
const num = (value: unknown): number => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const bool = (value: unknown): boolean => value === true;
const list = (value: unknown): unknown[] => (Array.isArray(value) ? value : []);

const entries = (value: unknown): GitEntry[] => list(value).flatMap(item => {
  const row = obj(item);
  const path = str(row.path);
  const origPath = str(row.origPath);
  return path ? [{ path, status: str(row.status, 'M'), ...(origPath && origPath !== path ? { origPath } : {}) }] : [];
});

export function decodePull(value: unknown): PullLink | null {
  const row = obj(value);
  const number = num(row.number);
  return number > 0 ? { number, url: str(row.url), title: str(row.title), state: str(row.state) } : null;
}

export function decodeStatus(value: unknown): GitStatus {
  const row = obj(value);
  return {
    isRepo: row.isRepo !== false, branch: str(row.branch), upstream: typeof row.upstream === 'string' && row.upstream ? row.upstream : null,
    ahead: num(row.ahead), behind: num(row.behind),
    staged: entries(row.staged), unstaged: entries(row.unstaged), untracked: list(row.untracked).filter((p): p is string => typeof p === 'string' && !!p),
    truncated: bool(row.truncated), running: bool(row.running), title: str(row.title), worktree: bool(row.worktree), pull: decodePull(row.pull),
  };
}

export function decodeBranches(value: unknown): BranchList {
  const row = obj(value);
  return {
    current: str(row.current), branches: list(row.branches).filter((b): b is string => typeof b === 'string' && !!b),
    defaultBranch: str(row.defaultBranch), worktree: bool(row.worktree), running: bool(row.running),
  };
}

export function decodeWorktree(value: unknown): WorktreeState {
  const row = obj(value);
  return {
    worktree: bool(row.worktree), exists: bool(row.exists), branch: str(row.branch), changes: num(row.changes), clean: row.clean !== false,
    hasUpstream: bool(row.hasUpstream), ahead: num(row.ahead), merged: bool(row.merged), running: bool(row.running),
  };
}

/** One row per path, sorted by path: staged and unstaged halves of the same file join as `partial`. */
export function stageRows(status: Pick<GitStatus, 'staged' | 'unstaged' | 'untracked'>): StageRow[] {
  const rows = new Map<string, StageRow>();
  for (const entry of status.staged) {
    rows.set(entry.path, { path: entry.path, letter: entry.status, stage: 'all', ...(entry.origPath ? { origPath: entry.origPath } : {}) });
  }
  for (const entry of status.unstaged) {
    const held = rows.get(entry.path);
    rows.set(entry.path, held ? { ...held, stage: 'partial' } : { path: entry.path, letter: entry.status, stage: 'none' });
  }
  for (const path of status.untracked) if (!rows.has(path)) rows.set(path, { path, letter: 'A', stage: 'none' });
  return [...rows.values()].sort((a, b) => a.path.localeCompare(b.path));
}

/** The rows with `path` moved to `staged`, for an optimistic toggle. */
export const withStage = (rows: readonly StageRow[], path: string, staged: boolean): StageRow[] =>
  rows.map(row => (row.path === path ? { ...row, stage: staged ? 'all' : 'none' } : row));

const baseName = (path: string) => path.slice(path.lastIndexOf('/') + 1);

/** What discarding `row` does, for its confirm. The host undoes a staged rename whole (git.rs `git_discard`
 * restores the old path from HEAD), so the text says the old file comes back. */
export function discardNote(row: Pick<StageRow, 'letter' | 'origPath'>): string {
  if (row.letter === 'R' && row.origPath) return `The rename is undone: ${baseName(row.origPath)} comes back as it was in the last commit, with no other changes. This can’t be undone.`;
  if (row.letter === 'A' || row.letter === 'C') return 'This new file will be deleted from the computer. This can’t be undone.';
  return 'Its uncommitted changes, staged or not, go back to the last commit. This can’t be undone.';
}

/** Discard all only when git.status listed every change: a cut list (`truncated`) would discard a partial set. */
export const canDiscardAll = (status: Pick<GitStatus, 'truncated'>, rows: readonly StageRow[]) => !status.truncated && rows.length > 0;

export const stagedCount = (rows: readonly StageRow[]) => rows.filter(row => row.stage !== 'none').length;

/** "1 file staged" / "3 of 5 files staged". */
export function stageSummary(rows: readonly StageRow[]): string {
  const staged = stagedCount(rows);
  const files = rows.length === 1 ? 'file' : 'files';
  if (!rows.length) return 'No changes';
  if (staged === rows.length) return `${rows.length} ${files} staged`;
  return staged ? `${staged} of ${rows.length} ${files} staged` : `${rows.length} ${files} changed, none staged`;
}

const MAX_SUBJECT = 72;

/** A subject line under 72 characters: cut at a word where it can be, with an ellipsis. */
export function subjectLine(text: string, max = MAX_SUBJECT): string {
  const line = text.replace(/\s+/g, ' ').trim();
  if (line.length <= max) return line;
  const cut = line.slice(0, max - 1);
  const space = cut.lastIndexOf(' ');
  return `${(space > max / 2 ? cut.slice(0, space) : cut).trimEnd()}…`;
}

/** A starting commit message from the task's title, else the files it touches. */
export function suggestCommitMessage(title: string, rows: readonly StageRow[]): string {
  const subject = subjectLine(title);
  if (subject) return subject;
  const staged = rows.filter(row => row.stage !== 'none');
  const names = staged.map(row => row.path.slice(row.path.lastIndexOf('/') + 1));
  if (!names.length) return '';
  return subjectLine(names.length <= 3 ? `Update ${names.join(', ')}` : `Update ${names.slice(0, 2).join(', ')} and ${names.length - 2} more`);
}

/** Commit needs a message, staged work and an idle agent (`running`: git.status says a turn is live); the reason it can't, else null. */
export function commitBlocker(message: string, rows: readonly StageRow[], running = false): string | null {
  if (running) return 'Wait for the agent to finish first.';
  if (!stagedCount(rows)) return 'Stage at least one file to commit.';
  if (!message.trim()) return 'Write a commit message.';
  return null;
}

/** Why a pull request can't be opened yet, else null. */
export function pullBlocker(status: GitStatus, base: string): string | null {
  if (!status.isRepo) return 'This task isn’t in a Git repository.';
  if (status.running) return 'Wait for the agent to finish first.';
  if (status.staged.length || status.unstaged.length || status.untracked.length) return 'Commit your changes before opening a pull request.';
  if (!status.branch) return 'Check out a branch first.';
  if (base && status.branch === base) return `Create a branch other than ${base} first.`;
  return null;
}

/** A linked pull request still open (or a draft). */
export const openPull = (pull: PullLink | null) => !!pull && (pull.state === 'open' || pull.state === 'draft');

/** The pull request's suggested title and body: the task's title, and the newest summary, if any. */
export function pullDraft(title: string, summary: string, branch: string): { title: string; body: string } {
  const fallback = branch.replace(/^[^/]*\//, '').replace(/[-_]+/g, ' ').trim();
  const name = subjectLine(title) || subjectLine(fallback ? fallback[0].toUpperCase() + fallback.slice(1) : '', 256);
  return { title: name, body: summary.trim() };
}

/** Branches to choose from: the current one first, then the rest as listed, filtered by `query`. */
export function branchChoices(listed: BranchList, query = ''): string[] {
  const q = query.trim().toLowerCase();
  const rest = listed.branches.filter(branch => branch !== listed.current);
  return [...(listed.current ? [listed.current] : []), ...rest].filter(branch => !q || branch.toLowerCase().includes(q));
}

/** Base branches for a pull request: the default first, never the task's own branch. */
export function baseChoices(listed: BranchList, head: string): string[] {
  const rest = listed.branches.filter(branch => branch !== head && branch !== listed.defaultBranch);
  return [...(listed.defaultBranch && listed.defaultBranch !== head ? [listed.defaultBranch] : []), ...rest];
}

/** "2 ahead · 1 behind of origin/main", or why there's nothing to say. */
export function syncLine(status: Pick<GitStatus, 'upstream' | 'ahead' | 'behind'>): string {
  if (!status.upstream) return 'Not pushed yet';
  const parts = [status.ahead > 0 && `${status.ahead} ahead`, status.behind > 0 && `${status.behind} behind`].filter(Boolean);
  return parts.length ? `${parts.join(' · ')} of ${status.upstream}` : `Up to date with ${status.upstream}`;
}

/** What the worktree screen says about its state. */
export function worktreeLine(state: WorktreeState): string {
  if (!state.exists) return 'The worktree folder is gone.';
  if (state.merged) return 'Merged into the main branch.';
  if (!state.clean) return `${state.changes} uncommitted ${state.changes === 1 ? 'change' : 'changes'}.`;
  if (state.ahead > 0) return `${state.ahead} ${state.ahead === 1 ? 'commit' : 'commits'} not merged yet.`;
  return 'Clean, nothing to merge.';
}

/** A task's pull-request lookup on the phone (client.ts `loadPull`): the newest fetch's generation and
 * whether one is still in flight. */
export interface PullFlight { generation: number; running: boolean }
/** Answer from the cache, join the fetch in flight, or start a fetch at `generation`. */
export type PullPlan = { kind: 'cached' } | { kind: 'join' } | { kind: 'fetch'; generation: number };

/** What `loadPull` does. A forced call (after a merge, review or create) always starts a new fetch and bumps
 * the generation, so a fetch that began before the action can't answer it or overwrite its result. */
export function planPull(cached: boolean, force: boolean, flight: PullFlight | undefined): PullPlan {
  if (!force && cached) return { kind: 'cached' };
  if (!force && flight?.running) return { kind: 'join' };
  return { kind: 'fetch', generation: (flight?.generation ?? 0) + 1 };
}

/** A finished fetch writes the cache only while no newer one has started. */
export const pullCurrent = (fetched: number, flight: Pick<PullFlight, 'generation'> | undefined) => fetched === (flight?.generation ?? 0);

/** The paths Discard all sends: each once (a file both staged and unstaged is one change), without folder rows
 * (`sub/`, an untracked nested repository), which the host refuses to discard file by file. */
export function discardAllPaths(rows: readonly Pick<StageRow, 'path'>[]): string[] {
  return [...new Set(rows.map(row => row.path))].filter(path => !path.endsWith('/'));
}
