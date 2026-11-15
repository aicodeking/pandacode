// Host calls for the `threads` feature group (src-tauri/src/remote/methods/threads.rs): rename, pin,
// archive (settle on the desktop), delete, fork, export and the task's goal and stage. Each applies to
// the store at once and rolls back if the host refuses; the host's `sessions-changed` brings the
// desktop and the next tasks.list along. See docs/remote-access.md, "Adding a method".
import { connect, hostCall } from '../client.ts';
import { registerMethods } from '../rpc.ts';
import { capabilitiesOf } from './capabilities.ts';
import { hostCallForkOnce } from './rewind.ts';
import { allows, supports } from './hello.ts';
import { dropTasks, isStage, patchTask, readPages, type Stage, type ThreadGoal } from '../../store/thread-model.ts';
import { restoreTask } from '../../store/inbox.ts';
import { taskKey, useConnect } from '../../store/index.ts';
import { archive, markDeleted, setPin, togglePin, unarchive, useLocal } from '../../store/local.ts';

export const THREAD_METHODS = registerMethods(['thread.rename', 'thread.archive', 'thread.delete', 'thread.pin', 'thread.fork', 'thread.export', 'thread.goal', 'thread.setGoal', 'thread.setStage'] as const);

export type { Stage, ThreadGoal } from '../../store/thread-model.ts';
export { cleanTitle, MAX_TITLE, STAGE_LABELS, STAGES } from '../../store/thread-model.ts';

const taskOf = (deviceId: string, sessionId: string) => useConnect.getState().tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);

/** Applies `change` to the listed task now; the returned function puts back what was there. */
function optimistic(deviceId: string, sessionId: string, change: Parameters<typeof patchTask>[3]): () => void {
  const before = taskOf(deviceId, sessionId);
  useConnect.setState(s => ({ tasks: patchTask(s.tasks, deviceId, sessionId, change) }));
  return () => {
    if (!before) return;
    const undo = Object.fromEntries(Object.keys(change).map(k => [k, before[k as keyof typeof before]]));
    useConnect.setState(s => ({ tasks: patchTask(s.tasks, deviceId, sessionId, undo) }));
  };
}

export async function renameThread(deviceId: string, sessionId: string, title: string): Promise<void> {
  const undo = optimistic(deviceId, sessionId, { title });
  try {
    await hostCall(deviceId, 'thread.rename', { sessionId, title });
  } catch (error) {
    undo();
    throw error;
  }
}

/** Whether pins sync with the computer: a host without thread.pin, or one this phone may not pin on, keeps this phone's own pin. */
export const pinsSync = (deviceId: string) => {
  const caps = capabilitiesOf(deviceId);
  return supports(caps, 'thread.pin') === true && allows(caps, 'thread.pin');
};

/** Pins or unpins on the computer (the desktop sidebar follows); else this phone's own pin. */
export async function pinThread(deviceId: string, sessionId: string, pinned: boolean): Promise<void> {
  const key = taskKey(deviceId, sessionId);
  if (!pinsSync(deviceId)) {
    if (!!useLocal.getState().pins[key] !== pinned) togglePin(key);
    return;
  }
  const hadLocal = !!useLocal.getState().pins[key];
  // A phone-only pin from before becomes the synced one, so Unpin isn't undone by it.
  if (hadLocal) setPin(key, false);
  const undo = optimistic(deviceId, sessionId, { pinned });
  try {
    await hostCall(deviceId, 'thread.pin', { sessionId, pinned });
  } catch (error) {
    undo();
    if (hadLocal) setPin(key, true);
    throw error;
  }
}

/** Settles the thread on the computer (its Completed section) and drops it from this phone's lists.
 * A refusal puts back only this task (restoreTask): the rest of the list keeps what arrived meanwhile. */
export async function archiveThread(deviceId: string, sessionId: string): Promise<void> {
  const key = taskKey(deviceId, sessionId);
  const list = useConnect.getState().tasks[deviceId]?.tasks ?? [];
  const index = list.findIndex(t => t.sessionId === sessionId);
  const before = index >= 0 ? list[index] : undefined;
  archive(key, Math.max(Date.now(), before?.lastPromptAt ?? 0));
  try {
    await hostCall(deviceId, 'thread.archive', { sessionId, archived: true });
  } catch (error) {
    unarchive(key);
    if (before) useConnect.setState(s => ({ tasks: restoreTask(s.tasks, deviceId, before, index) as typeof s.tasks }));
    throw error;
  }
}

/** The stage Undo puts back after Archive: one the host reopens differently from (`review`), and only
 * where this phone may set stages on that computer. */
export function stageToRestore(deviceId: string, stage: string | undefined): Stage | undefined {
  if (!isStage(stage) || stage === 'review' || stage === 'completed') return undefined;
  const caps = capabilitiesOf(deviceId);
  return supports(caps, 'thread.setStage') === true && allows(caps, 'thread.setStage') ? stage : undefined;
}

/** Reopens an archived thread for review and lists it again; with `previous` (the stage before Archive,
 * for Undo) it then moves it back there where the host serves thread.setStage. The stage it ends in. */
export async function unarchiveThread(deviceId: string, sessionId: string, previous?: string): Promise<Stage> {
  await hostCall(deviceId, 'thread.archive', { sessionId, archived: false });
  unarchive(taskKey(deviceId, sessionId));
  const back = stageToRestore(deviceId, previous);
  // Reopened either way: a refused stage leaves it under review rather than failing the Undo.
  const stage = back ? await setThreadStage(deviceId, sessionId, back).then(() => back, () => 'review' as const) : 'review';
  void connect.listTasks(deviceId).catch(() => undefined);
  return stage;
}

/** Deletes the thread (and its team's workers) on the computer. The host refuses a running one. */
export async function deleteThread(deviceId: string, sessionId: string): Promise<void> {
  const reply = await hostCall<{ deletedSessionIds?: unknown }>(deviceId, 'thread.delete', { sessionId });
  const ids = Array.isArray(reply?.deletedSessionIds) ? reply.deletedSessionIds.filter((id): id is string => typeof id === 'string') : [];
  const gone = ids.includes(sessionId) ? ids : [...ids, sessionId];
  markDeleted(gone.map(id => taskKey(deviceId, id)));
  useConnect.setState(s => ({ tasks: dropTasks(s.tasks, deviceId, gone) }));
}

/** A new thread with the conversation up to `messageId` (before it, for a prompt to ask again); its id, once listed. */
export async function forkThread(deviceId: string, sessionId: string, messageId: number, before = false): Promise<string> {
  const reply = await hostCallForkOnce<{ sessionId?: unknown }>(deviceId, 'thread.fork', { sessionId, messageId, before });
  if (typeof reply?.sessionId !== 'string') throw new Error('The computer did not say which thread it made.');
  await connect.listTasks(deviceId).catch(() => undefined);
  return reply.sessionId;
}

/** The thread as Markdown, page by page (the host cuts it to fit its reply budget), up to 2 MB; later
 * pages pass back page 0's snapshot `token`, and a changed export starts again (readPages). */
export async function exportThread(deviceId: string, sessionId: string): Promise<string> {
  const { text } = await readPages(async (offset, token) => {
    const reply = await hostCall<{ text?: unknown; next?: unknown; token?: unknown; version?: unknown }>(deviceId, 'thread.export', { sessionId, offset, ...(token && { token }) });
    return {
      text: typeof reply?.text === 'string' ? reply.text : '',
      next: typeof reply?.next === 'number' ? reply.next : null,
      token: typeof reply?.token === 'string' ? reply.token : undefined,
      version: typeof reply?.version === 'string' ? reply.version : undefined,
    };
  });
  return text;
}

export const threadGoal = (deviceId: string, sessionId: string) => hostCall<ThreadGoal>(deviceId, 'thread.goal', { sessionId });
export const setThreadGoal = (deviceId: string, sessionId: string, description: string) => hostCall<ThreadGoal>(deviceId, 'thread.setGoal', { sessionId, description });
export const setThreadStage = (deviceId: string, sessionId: string, stage: Stage) => hostCall<ThreadGoal>(deviceId, 'thread.setStage', { sessionId, stage });
