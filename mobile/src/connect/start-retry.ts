// Starting a task safely over a flaky link (docs/remote-access.md, "Starts"): one `startId` per
// deliberate start, kept with the new-task draft so a retry reuses it, and, when the reply was
// lost, asking the host how the start went (task.startStatus every 3 s, as the desktop's
// mirror.rs does) instead of failing. Pure (tested in node, tests/connect-robust.test.ts).
import { LOST, maybeRan, NOT_CONNECTED, OFFLINE, RATE, TIMED_OUT } from './rpc.ts';
import type { StartStatus } from './types.ts';

export const START_POLL_MS = 3000;
/** A start the host does not know (the request never arrived) is sent again at most this often. */
export const MAX_RESENDS = 2;
export const STILL_STARTING = 'That computer is still starting this task. It shows in the list once it is ready.';
const START_FAILED = 'Could not start the task.';

/** What `task.start` (or a `done` task.startStatus) answers. `sent: false` (with `error`): the
 * task was made but its first message did not go (docs/remote-access.md, Round-11 gates). */
export interface StartReply { sessionId: string; worktree?: unknown; note?: unknown; sent?: boolean; error?: unknown; projectId?: string }

/** Why a start's first message did not go, or null when it went (an older host's reply has no `sent`). */
export function unsentStartError(reply: { sent?: unknown; error?: unknown } | null | undefined): string | null {
  if (reply?.sent !== false) return null;
  return typeof reply.error === 'string' && reply.error.trim() ? reply.error.trim() : 'The computer did not say why.';
}

/** The toast for a task that was made without its first message: it opens anyway, the prompt waits in its composer. */
export function unsentStartNotice(error: string): { title: string; body: string; tone: 'danger' } {
  const reason = error.replace(/[.\s]+$/, '');
  return { title: 'Message not sent', body: `The task was created but your message didn’t send: ${reason}. Send it again from the task.`, tone: 'danger' };
}

/** Only the not-sent fields of a reply, to pass along with a start's own result. */
export const unsentFields = (reply: { sent?: unknown; error?: unknown }): { sent?: false; error?: string } =>
  reply.sent === false ? { sent: false, error: unsentStartError(reply)! } : {};

/** A draft's start id: `key` is the draft (computer, project, prompt and settings). */
export interface DraftStart { key: string; id: string }

/** The id for a tap: the last attempt's when the draft is unchanged and it may still be on the host. */
export const draftStartId = (last: DraftStart | null, key: string, fresh: () => string): DraftStart =>
  last?.key === key ? last : { key, id: fresh() };

/** Whether a failed attempt keeps its id for the next tap: only when the host may have the start
 * (or never got it). An answer the host gave keeps a new id: it remembers a failed start an hour. */
export function keepsStartId(error: unknown): boolean {
  const message = error instanceof Error ? error.message : error;
  return message === TIMED_OUT || message === LOST || message === OFFLINE || message === NOT_CONNECTED || message === RATE || message === STILL_STARTING;
}

export interface FollowDeps {
  start: () => Promise<StartReply>;
  status: () => Promise<StartStatus & { worktree?: unknown; note?: unknown; sent?: boolean; projectId?: unknown }>;
  /** The host serves task.startStatus (unknown counts as yes: an older host's refusal ends the poll). */
  canPoll: () => boolean;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  /** How long to keep asking, from the first send. */
  maxMs: number;
}

type Poll = { kind: 'done'; reply: StartReply } | { kind: 'failed'; error: string } | { kind: 'unknown' } | { kind: 'waiting' } | { kind: 'refused' };

const transient = (error: unknown) => {
  const message = error instanceof Error ? error.message : error;
  return maybeRan(error) || message === OFFLINE || message === NOT_CONNECTED || message === RATE;
};

/** Asks how the start stands until it settles, the host does not know it, or time runs out. */
async function poll(deps: FollowDeps, deadline: number): Promise<Poll> {
  for (;;) {
    try {
      const status = await deps.status();
      if (status?.state === 'done' && typeof status.sessionId === 'string') {
        // A chat.start's status names its project too (newer hosts), as its direct reply does.
        const project = typeof status.projectId === 'string' && status.projectId ? { projectId: status.projectId } : {};
        return { kind: 'done', reply: { sessionId: status.sessionId, worktree: status.worktree, note: status.note, ...unsentFields(status), ...project } };
      }
      if (status?.state === 'failed') return { kind: 'failed', error: typeof status.error === 'string' && status.error ? status.error : START_FAILED };
      if (status?.state === 'unknown') return { kind: 'unknown' };
    } catch (error) {
      if (!transient(error)) return { kind: 'refused' };
    }
    if (deps.now() >= deadline) return { kind: 'waiting' };
    await deps.sleep(START_POLL_MS);
  }
}

/** Sends the start; a lost reply turns into asking how it went. The same `startId` goes with every
 * send, so the host runs it once. Throws what the host decided, or the lost-reply error. */
export async function followStart(deps: FollowDeps): Promise<StartReply> {
  const deadline = deps.now() + deps.maxMs;
  for (let resends = 0; ; resends++) {
    let lost: unknown;
    try {
      return await deps.start();
    } catch (error) {
      if (!maybeRan(error) || !deps.canPoll()) throw error;
      lost = error;
    }
    const outcome = await poll(deps, deadline);
    switch (outcome.kind) {
      case 'done': return outcome.reply;
      case 'failed': throw new Error(outcome.error);
      case 'waiting': throw new Error(STILL_STARTING);
      case 'refused': throw lost;
      case 'unknown':
        // Never arrived (or the host restarted): sending it again is safe under the same id.
        if (resends >= MAX_RESENDS || deps.now() >= deadline) throw lost;
    }
  }
}
