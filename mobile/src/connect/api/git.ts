// Host calls for the `git` feature group (src-tauri/src/remote/methods/git.rs): the task's checkout
// status, staging, commit and push, branches, its worktree, opening a pull request and per-turn
// change summaries. Replies are decoded by src/store/git.ts. See docs/remote-access.md, "Adding a method".
import { hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { hostCallOnce } from './github.ts';
import { hostCallForkOnce } from './rewind.ts';
import { decodeBranches, decodePull, decodeStatus, decodeWorktree, type BranchList, type CommitResult, type GitStatus, type PullLink, type WorktreeMerge, type WorktreeRemoval, type WorktreeState } from '../../store/git.ts';

export const GIT_METHODS = registerMethods(['git.status', 'git.stage', 'git.discard', 'git.commit', 'git.push', 'git.branches', 'git.switchBranch',
  'worktree.status', 'worktree.merge', 'worktree.remove', 'worktree.create', 'pull.create', 'turn.summary', 'turn.diff'] as const);

/** Pushing and opening a pull request talk to the remote: allow them longer than a plain call. */
const NETWORK_TIMEOUT_MS = 90_000;
const MERGE_TIMEOUT_MS = 60_000;

export const gitStatus = async (deviceId: string, sessionId: string): Promise<GitStatus> =>
  decodeStatus(await hostCall<unknown>(deviceId, 'git.status', { sessionId }));

/** Stages (or with `unstage` unstages) `paths`, or every file that can move when `paths` is 'all'. */
export const stageFiles = (deviceId: string, sessionId: string, paths: readonly string[] | 'all', unstage = false) =>
  hostCall<{ count: number }>(deviceId, 'git.stage', paths === 'all' ? { sessionId, all: true, unstage } : { sessionId, paths, unstage });

/** Discards uncommitted changes to `paths`: tracked files go back to HEAD, untracked ones named here are deleted.
 * Idempotent on the host (a retry finds nothing left), so a plain call. */
/** `skipFolders`: Discard all leaves folder and submodule rows out (`skipped` counts them) instead of refusing. */
export const discardFiles = (deviceId: string, sessionId: string, paths: readonly string[], skipFolders = false) =>
  hostCall<{ count: number; skipped?: number }>(deviceId, 'git.discard', skipFolders ? { sessionId, paths, skipFolders } : { sessionId, paths });

export async function commitChanges(deviceId: string, sessionId: string, message: string, push: boolean): Promise<CommitResult> {
  // Always the long deadline: a commit runs the repository's hooks and filters (and with `push` the network),
  // and a commit the phone gave up on still lands, so a short timeout invites a second one. Once per call:
  // a lost reply is retried under the same `sendId` (github.ts `runOnce`), never committed twice.
  const reply = await hostCallOnce<Partial<CommitResult>>(deviceId, 'git.commit', { sessionId, message, push }, { timeoutMs: push ? NETWORK_TIMEOUT_MS : MERGE_TIMEOUT_MS });
  return { output: reply?.output ?? '', pushed: !!reply?.pushed, pushOutput: reply?.pushOutput, pushError: reply?.pushError };
}

export const pushBranch = (deviceId: string, sessionId: string) =>
  hostCall<{ output: string }>(deviceId, 'git.push', { sessionId }, { timeoutMs: NETWORK_TIMEOUT_MS });

export const listBranches = async (deviceId: string, sessionId: string): Promise<BranchList> =>
  decodeBranches(await hostCall<unknown>(deviceId, 'git.branches', { sessionId }));

export const switchBranch = async (deviceId: string, sessionId: string, branch: string): Promise<BranchList> =>
  decodeBranches(await hostCall<unknown>(deviceId, 'git.switchBranch', { sessionId, branch }));

export const worktreeStatus = async (deviceId: string, sessionId: string): Promise<WorktreeState> =>
  decodeWorktree(await hostCall<unknown>(deviceId, 'worktree.status', { sessionId }));

export const mergeWorktree = (deviceId: string, sessionId: string) =>
  hostCall<WorktreeMerge>(deviceId, 'worktree.merge', { sessionId }, { timeoutMs: MERGE_TIMEOUT_MS });

export const removeWorktree = (deviceId: string, sessionId: string, deleteBranch: boolean) =>
  hostCall<WorktreeRemoval>(deviceId, 'worktree.remove', { sessionId, deleteBranch }, { timeoutMs: MERGE_TIMEOUT_MS });

/** worktree.create's reply: the task that now works in the worktree (`moved`: the same task; else a new one). */
export interface WorktreeCreated { sessionId: string; moved: boolean; branch: string }

/** Once per call (rewind.ts `hostCallForkOnce`). Gives a task on the main checkout its own worktree: an unstarted task moves into it, a started one
 * gets a new task there with its harness and model. `branch` defaults to one from the task's title. */
export async function createWorktree(deviceId: string, sessionId: string, branch?: string): Promise<WorktreeCreated> {
  const reply = await hostCallForkOnce<Partial<WorktreeCreated>>(deviceId, 'worktree.create', { sessionId, ...(branch ? { branch } : {}) }, { timeoutMs: MERGE_TIMEOUT_MS });
  if (typeof reply?.sessionId !== 'string' || !reply.sessionId) throw new Error('The computer sent an unexpected reply.');
  return { sessionId: reply.sessionId, moved: reply.moved === true, branch: typeof reply.branch === 'string' ? reply.branch : '' };
}

export interface NewPull { title: string; body: string; base?: string; draft?: boolean }

/** Pushes the task's branch and opens a pull request, which the task then links. `note`: it opened, but something after didn't.
 * Once per call: a lost reply is retried under the same `sendId`, never opened twice (github.ts `runOnce`). */
export async function createPull(deviceId: string, sessionId: string, pull: NewPull): Promise<{ pull: PullLink | null; note: string | null }> {
  const reply = await hostCallOnce<{ pull?: unknown; note?: unknown }>(deviceId, 'pull.create', { sessionId, ...pull }, { timeoutMs: NETWORK_TIMEOUT_MS });
  return { pull: decodePull(reply?.pull), note: typeof reply?.note === 'string' ? reply.note : null };
}

export interface TurnFile { path: string; oldPath?: string; status: string; additions: number | null; deletions: number | null; binary: boolean; truncated: boolean }
export interface TurnSummary { id: string; files: TurnFile[]; additions: number; deletions: number; truncated: boolean; attributed: boolean; error?: string }
export interface TurnDiff { path: string; oldPath?: string; patch: string; binary: boolean; truncated: boolean; error?: string }

/** What one turn changed (the message's `turnChanges`), with every file. */
export const turnSummary = (deviceId: string, sessionId: string, messageId: number) =>
  hostCall<TurnSummary>(deviceId, 'turn.summary', { sessionId, messageId });

/** One file's patch from that turn. */
export const turnDiff = (deviceId: string, sessionId: string, messageId: number, path: string) =>
  hostCall<TurnDiff>(deviceId, 'turn.diff', { sessionId, messageId, path });
