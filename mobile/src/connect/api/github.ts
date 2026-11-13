// Host calls for the `github` feature group (src-tauri/src/remote/methods/github.rs): the desktop's
// GitHub view for one host project. Reads are View; comment and startTask need Full access.
// pull.review (Full, like github.comment: it speaks as the user's gh account) approves, requests changes on or comments on a task's linked pull request.
// github.startTask carries a startId like task.start, so a lost reply turns into task.startStatus
// polls (start-retry.ts). client.ts is loaded only by the calls, so node can load this file.
import type { HostCallOptions } from '../client.ts';
import { uuid } from '../crypto.ts';
import { NOT_CONNECTED, OFFLINE, promptMaybeRan, RATE, registerMethods, START_TIMEOUT_MS, type Method } from '../rpc.ts';
import { draftStartId, followStart, keepsStartId, type DraftStart, type StartReply } from '../start-retry.ts';
import type { StartStatus } from '../types.ts';

export const GITHUB_METHODS = registerMethods(['github.repos', 'github.issues', 'github.pulls', 'github.runs', 'github.item', 'github.search', 'github.comment', 'github.startTask', 'pull.review'] as const);

/** A host project whose `origin` is on GitHub. */
export interface GithubRepo { projectId: string; projectName: string; repo: string }
export interface HubIssue { number: number; title: string; author: string; updatedAt: string; url: string; comments: number; labels: string[]; assignees: string[] }
export interface HubPull { number: number; title: string; author: string; state: string; head: string; base: string; updatedAt: string; url: string; review: string; checks: string; additions: number; deletions: number; labels: string[] }
/** `state`: queued, in_progress, passed, failed, not_started or cancelled. */
export interface HubRun { id: number; workflow: string; title: string; branch: string; event: string; state: string; createdAt: string; startedAt: string; updatedAt: string; url: string; attempt: number; pulls: number[] }
export interface SearchItem { kind: 'issue' | 'pull'; number: number; title: string; state: string; url: string; author: string }

export interface ItemComment { author: string; body: string; createdAt: string; truncated: boolean }
export interface ItemCheck { name: string; workflow: string; state: 'success' | 'failure' | 'pending' | 'neutral'; url: string }
export interface IssueDetail {
  kind: 'issue' | 'pull'; number: number; title: string; state: string; url: string; author: string; createdAt: string; updatedAt: string;
  body: string; labels: string[]; assignees: string[]; comments: ItemComment[]; earlierComments: number; truncated: boolean;
  /** Pull requests only. */
  head?: string; base?: string; review?: string; additions?: number; deletions?: number; checks?: ItemCheck[];
}
export interface RunStep { name: string; state: string; startedAt: string; completedAt: string }
export interface RunJob { id: number; name: string; state: string; startedAt: string; completedAt: string; url: string; steps: RunStep[]; summary: string }
export interface RunDetail {
  kind: 'run'; runId: number; jobs: RunJob[]; truncated: boolean;
  attempts: { attempt: number; state: string; startedAt: string; updatedAt: string; url: string }[];
  artifacts: { name: string; size: number; expired: boolean }[];
}
export type ItemKind = 'issue' | 'pull' | 'run';

const GH_TIMEOUT = 45_000;
const hostCall = async <T>(deviceId: string, method: Method, params: unknown, options?: HostCallOptions): Promise<T> =>
  (await import('../client.ts')).hostCall<T>(deviceId, method, params, options);
const list = <T>(reply: { items?: T[] } | undefined): T[] => (Array.isArray(reply?.items) ? reply.items : []);

export const githubRepos = async (deviceId: string): Promise<GithubRepo[]> => {
  const reply = await hostCall<{ repos?: GithubRepo[] }>(deviceId, 'github.repos', {}, { timeoutMs: GH_TIMEOUT });
  return Array.isArray(reply?.repos) ? reply.repos : [];
};
export const githubIssues = async (deviceId: string, projectId: string) => list(await hostCall<{ items?: HubIssue[] }>(deviceId, 'github.issues', { projectId }, { timeoutMs: GH_TIMEOUT }));
export const githubPulls = async (deviceId: string, projectId: string) => list(await hostCall<{ items?: HubPull[] }>(deviceId, 'github.pulls', { projectId }, { timeoutMs: GH_TIMEOUT }));
export const githubRuns = async (deviceId: string, projectId: string) => list(await hostCall<{ items?: HubRun[] }>(deviceId, 'github.runs', { projectId }, { timeoutMs: GH_TIMEOUT }));
export const githubSearch = async (deviceId: string, projectId: string, query: string) => list(await hostCall<{ items?: SearchItem[] }>(deviceId, 'github.search', { projectId, query }, { timeoutMs: GH_TIMEOUT }));

export function githubItem(deviceId: string, projectId: string, kind: 'issue' | 'pull', number: number): Promise<IssueDetail>;
export function githubItem(deviceId: string, projectId: string, kind: 'run', runId: number): Promise<RunDetail>;
export function githubItem(deviceId: string, projectId: string, kind: ItemKind, id: number): Promise<IssueDetail | RunDetail> {
  const params = kind === 'run' ? { projectId, kind, runId: id } : { projectId, kind, number: id };
  return hostCall<IssueDetail | RunDetail>(deviceId, 'github.item', params, { timeoutMs: GH_TIMEOUT });
}

// ---- writes that must not run twice ----

/** The host.hello feature of hosts that run a repeated `github.comment`, `pull.create`,
 * `recipes.run` or `schedules.runNow` with the same `sendId` once (host.rs ONCE_METHODS). */
export const ACTION_SEND_ID = 'actionSendId';
/** A write whose reply was lost (and, where the host dedupes, whose retry was lost too). */
export const MAY_HAVE_RUN = 'The computer did not confirm this, so it may have gone through. Check before trying again.';

/** Errors after which a retry under the same `sendId` can't have been answered by the host. */
const NEVER_DELIVERED = new Set([OFFLINE, NOT_CONNECTED, RATE]);

/**
 * One user action on a write that must not run twice, as the composer's sends do (client.ts
 * `optimistic`): `call` gets the action's `sendId` when the host dedupes by it. A lost reply is
 * sent once more under the same id (the host answers a repeat with the first result); a refusal
 * then means it never ran. If that is lost too, or the host can't dedupe, this fails with
 * [`MAY_HAVE_RUN`] instead of risking a second comment, pull request or run.
 */
export async function runOnce<T>(call: (sendId?: string) => Promise<T>, dedupes: boolean, sendId: string = uuid()): Promise<T> {
  try {
    return await call(dedupes ? sendId : undefined);
  } catch (error) {
    if (!promptMaybeRan(error)) throw error;
  }
  if (dedupes) {
    try {
      return await call(sendId);
    } catch (again) {
      const message = again instanceof Error ? again.message : String(again);
      if (!promptMaybeRan(again) && !NEVER_DELIVERED.has(message)) throw again;
    }
  }
  throw new Error(MAY_HAVE_RUN);
}

/** [`runOnce`] for one host call: `sendId` joins `params` when the host has [`ACTION_SEND_ID`]. */
export async function hostCallOnce<T>(deviceId: string, method: Method, params: Record<string, unknown>, options?: HostCallOptions): Promise<T> {
  const { capabilitiesOf } = await import('./capabilities.ts');
  const caps = capabilitiesOf(deviceId);
  const dedupes = caps?.kind === 'hello' && caps.features.has(ACTION_SEND_ID);
  return runOnce(sendId => hostCall<T>(deviceId, method, sendId ? { ...params, sendId } : params, options), dedupes);
}

export const githubComment = (deviceId: string, projectId: string, kind: 'issue' | 'pull', number: number, body: string) =>
  hostCallOnce<{ url: string }>(deviceId, 'github.comment', { projectId, kind, number, body }, { timeoutMs: GH_TIMEOUT });

// ---- pull.review ----

export type ReviewEvent = 'approve' | 'request_changes' | 'comment';
/** The review choices in the order the phone offers them; `verb` labels the submit button. */
export const REVIEW_EVENTS: readonly { value: ReviewEvent; label: string; verb: string }[] = [
  { value: 'approve', label: 'Approve', verb: 'Approve' },
  { value: 'request_changes', label: 'Request changes', verb: 'Request changes' },
  { value: 'comment', label: 'Comment', verb: 'Comment' },
];
/** GitHub's comment limit; the host cuts a longer body. */
export const MAX_REVIEW_BODY = 65_536;

/** Why this review can't be sent yet, or null: a change request or a comment needs text. */
export function reviewProblem(event: ReviewEvent, body: string): string | null {
  if (event !== 'approve' && !body.trim()) return 'Write a comment for this review.';
  if (body.length > MAX_REVIEW_BODY) return 'GitHub reviews are at most 65,536 characters.';
  return null;
}

/** `pull.review`'s params: the body trimmed, and left out when empty. */
export function reviewParams(sessionId: string, event: ReviewEvent, body: string): { sessionId: string; event: ReviewEvent; body?: string } {
  const text = body.trim();
  return text ? { sessionId, event, body: text } : { sessionId, event };
}

/** The toast after a review went through. */
export const reviewDone = (event: ReviewEvent, number: number): string =>
  event === 'approve' ? `Approved #${number}` : event === 'request_changes' ? `Requested changes on #${number}` : `Reviewed #${number}`;

/** What to say when GitHub refuses a review from the pull request's own author (the pull reply names
 * the author but not the gh account, so the phone can't hide the choices up front). */
export const OWN_PULL_REVIEW = 'GitHub doesn’t let the author approve or request changes on their own pull request. You can still comment.';
const OWN_PULL_PATTERN = /can ?not (approve|request changes on) your own pull request/i;

/** A failed review's message for the user: gh's own-pull refusal made clear, anything else as is. */
export const reviewErrorMessage = (message: string): string => (OWN_PULL_PATTERN.test(message) ? OWN_PULL_REVIEW : message);

/** Reviews the task's linked pull request as the computer's `gh` account, once per action. */
export const reviewPull = (deviceId: string, sessionId: string, event: ReviewEvent, body: string) =>
  hostCallOnce<{ number?: number }>(deviceId, 'pull.review', reviewParams(sessionId, event, body), { timeoutMs: GH_TIMEOUT });

export interface IssueStart { provider: string; model: string; mode?: string; effort?: string; worktree?: boolean }
export type IssueStartReply = StartReply & { worktree?: boolean; note?: string };

/** What starting from an issue needs, handed in so tests can drive it. */
export interface IssueStartDeps {
  start: (params: Record<string, unknown>) => Promise<StartReply>;
  status: (startId: string) => Promise<StartStatus & { worktree?: unknown; note?: unknown }>;
  canPoll: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  uuid: () => string;
}

/** The last issue start's draft: a retry of the same issue and settings after a lost reply reuses its id. */
let issueDraft: DraftStart | null = null;

/** Starts a task that solves the issue (named and linked as the desktop's Solve does), once per
 * draft: the host runs one start per startId and a lost reply is followed with task.startStatus. */
export async function solveIssue(deps: IssueStartDeps, deviceId: string, projectId: string, issueNumber: number, start: IssueStart): Promise<IssueStartReply> {
  const draft = draftStartId(issueDraft, JSON.stringify([deviceId, projectId, issueNumber, start]), deps.uuid);
  issueDraft = draft;
  const startId = draft.id;
  try {
    const reply = await followStart({
      start: () => deps.start({ projectId, issueNumber, ...start, startId }),
      status: () => deps.status(startId),
      canPoll: deps.canPoll,
      sleep: deps.sleep,
      now: deps.now,
      maxMs: START_TIMEOUT_MS,
    });
    issueDraft = null;
    return reply as IssueStartReply;
  } catch (e) {
    if (!keepsStartId(e)) issueDraft = null;
    throw e;
  }
}

/** [`solveIssue`] against the computer; refreshes its tasks once started. */
export async function githubStartTask(deviceId: string, projectId: string, issueNumber: number, start: IssueStart): Promise<IssueStartReply> {
  const { connect } = await import('../client.ts');
  const { capabilitiesOf } = await import('./capabilities.ts');
  const { supports } = await import('./hello.ts');
  const { uuid } = await import('../crypto.ts');
  const reply = await solveIssue({
    start: params => hostCall<StartReply>(deviceId, 'github.startTask', params, { timeoutMs: START_TIMEOUT_MS }),
    status: startId => hostCall(deviceId, 'task.startStatus', { startId }),
    canPoll: () => supports(capabilitiesOf(deviceId), 'task.startStatus') !== false,
    sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
    now: Date.now,
    uuid,
  }, deviceId, projectId, issueNumber, start);
  void connect.listTasks(deviceId).catch(() => undefined);
  return reply;
}
