// Host calls for the `rewind` feature group (src-tauri/src/remote/methods/rewind.rs): the desktop's
// Edit on a sent prompt (docs/rewind.md). A rewind forks the conversation to just before the prompt
// into a new task in the same checkout and returns what was typed, for that task's composer. The
// source task is unchanged and files are not rewound. See docs/remote-access.md, "Adding a method".
import { connect, hostCall, type HostCallOptions } from '../client.ts';
import { registerMethods, type Method } from '../rpc.ts';
import { capabilitiesOf } from './capabilities.ts';
import { runOnce } from './github.ts';

export const REWIND_METHODS = registerMethods(['rewind.points', 'rewind.to'] as const);

/** The host.hello feature of hosts that run a repeated `worktree.create`, `thread.fork` or `rewind.to`
 * with the same `sendId` once (host.rs ONCE_METHODS). `actionSendId` alone doesn't cover them. */
export const FORK_SEND_ID = 'forkSendId';

/** github.ts `hostCallOnce` for the calls [`FORK_SEND_ID`] covers: a lost reply is retried under the
 * same `sendId` only where the host dedupes it, so a retry never makes a second worktree or thread. */
export function hostCallForkOnce<T>(deviceId: string, method: Method, params: Record<string, unknown>, options?: HostCallOptions): Promise<T> {
  const caps = capabilitiesOf(deviceId);
  const dedupes = caps?.kind === 'hello' && caps.features.has(FORK_SEND_ID);
  return runOnce(sendId => hostCall<T>(deviceId, method, sendId ? { ...params, sendId } : params, options), dedupes);
}

export interface RewindPoint { messageId: number; text: string; createdAt: number }
export interface Rewound { sessionId: string; title: string; draft: string }

/** The task's prompts a rewind may go back to, newest first, and whether its agent runs (a rewind then waits). */
export async function rewindPoints(deviceId: string, sessionId: string): Promise<{ points: RewindPoint[]; running: boolean }> {
  const reply = await hostCall<{ points?: unknown; running?: unknown }>(deviceId, 'rewind.points', { sessionId });
  const points = Array.isArray(reply?.points)
    ? reply.points.filter((p): p is RewindPoint => typeof p?.messageId === 'number' && typeof p?.text === 'string' && typeof p?.createdAt === 'number')
    : [];
  return { points, running: reply?.running === true };
}

/** Forks to just before `messageId`; the new task's id and the prompt's typed text. The host refuses while the agent runs. */
export async function rewindTo(deviceId: string, sessionId: string, messageId: number): Promise<Rewound> {
  const reply = await hostCallForkOnce<{ sessionId?: unknown; title?: unknown; draft?: unknown }>(deviceId, 'rewind.to', { sessionId, messageId });
  if (typeof reply?.sessionId !== 'string') throw new Error('The computer did not say which thread it made.');
  await connect.listTasks(deviceId).catch(() => undefined);
  return { sessionId: reply.sessionId, title: typeof reply.title === 'string' ? reply.title : '', draft: typeof reply.draft === 'string' ? reply.draft : '' };
}
