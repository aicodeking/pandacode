// Demo answers for the `threads` feature group (src/connect/api/threads.ts). The pure task-list
// edits they share with the client live in ../store/thread-model.ts. See ./index.ts.
import type { TaskSummary } from '../connect/types.ts';
import type { ConnectState } from '../store/index.ts';
import { cleanTitle, dropTasks, exportMarkdown, exportVersion, isStage, MAX_TITLE, patchTask, type Stage, type ThreadGoal } from '../store/thread-model.ts';
import type { DemoContext, DemoHandlers } from './index.ts';

// ---- demo host ----

/** Demo-only details per thread (the demo list carries no stage or description). */
const details = new Map<string, { description: string; stage: Stage }>();

function findTask(state: ConnectState, deviceId: string, sessionId: unknown): TaskSummary {
  const task = state.tasks[deviceId]?.tasks.find(t => t.sessionId === sessionId);
  if (!task) throw new Error('Conversation not found.');
  return task;
}

/** Writes a stage onto the listed task too, as a newer host's task list carries it. */
function listStage(host: DemoContext['host'], deviceId: string, sessionId: string, stage: Stage) {
  host.set(s => {
    const list = s.tasks[deviceId];
    if (!list) return {};
    return { tasks: { ...s.tasks, [deviceId]: { ...list, tasks: list.tasks.map(t => (t.sessionId === sessionId ? { ...t, stage } : t)) } } };
  });
}

const busy = (task: TaskSummary) => task.status === 'running' || task.status === 'waiting';

function goalOf(deviceId: string, task: TaskSummary): ThreadGoal {
  const saved = details.get(`${deviceId}/${task.sessionId}`);
  return {
    sessionId: task.sessionId, title: task.title, running: busy(task), goal: null,
    description: saved?.description ?? 'Demo task details: what the agent should do and how you’ll know it’s done.',
    // The listed stage next, as a newer host lists it (Undo after Archive sets it back with thread.setStage).
    stage: saved?.stage ?? (isStage(task.stage) ? task.stage : busy(task) ? 'in_progress' : 'review'),
  };
}

export const handlers: DemoHandlers = {
  'thread.rename': ({ host, deviceId, state }, p) => {
    findTask(state, deviceId, p?.sessionId);
    const title = cleanTitle(String(p?.title ?? ''));
    if (!title) throw new Error(`Choose a name of 1–${MAX_TITLE} characters.`);
    host.set(s => ({ tasks: patchTask(s.tasks, deviceId, p.sessionId, { title }) }));
    return { sessionId: p.sessionId, title };
  },
  'thread.pin': ({ host, deviceId, state }, p) => {
    findTask(state, deviceId, p?.sessionId);
    host.set(s => ({ tasks: patchTask(s.tasks, deviceId, p.sessionId, { pinned: !!p.pinned }) }));
    return { sessionId: p.sessionId, pinned: !!p.pinned };
  },
  'thread.archive': ({ host, deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    if (busy(task)) throw new Error('Restore this task and stop its agent before changing its stage.');
    // As the host: Archive settles (`completed`), unarchive reopens for review; the phone's Undo then
    // moves it back to the stage it had before with thread.setStage.
    const stage: Stage = p.archived ? 'completed' : 'review';
    details.set(`${deviceId}/${task.sessionId}`, { ...goalOf(deviceId, task), stage });
    listStage(host, deviceId, task.sessionId, stage);
    return { sessionId: task.sessionId, archived: !!p.archived, stage };
  },
  'thread.delete': ({ host, deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    if (busy(task)) throw new Error('Stop this task and wait for its agents to finish before deleting it.');
    host.set(s => ({ tasks: dropTasks(s.tasks, deviceId, [task.sessionId]) }));
    return { deletedSessionIds: [task.sessionId] };
  },
  'thread.fork': ({ host, deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    const messages = state.messages[`${deviceId}/${task.sessionId}`] ?? [];
    const at = messages.findIndex(m => m.id === p.messageId);
    const kept = at < 0 ? messages : messages.slice(0, p.before ? at : at + 1);
    const sessionId = `${task.sessionId}-fork-${host.now()}`;
    const now = host.now();
    const fork: TaskSummary = { ...task, sessionId, title: `${task.title} (fork)`, status: 'idle', pinned: false, pending: [], updatedAt: now };
    host.set(s => {
      const list = s.tasks[deviceId];
      return {
        tasks: list ? { ...s.tasks, [deviceId]: { ...list, tasks: [fork, ...list.tasks] } } : s.tasks,
        messages: { ...s.messages, [`${deviceId}/${sessionId}`]: kept },
      };
    });
    return { sessionId, title: fork.title };
  },
  'thread.export': ({ deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    const text = exportMarkdown(task.title, state.messages[`${deviceId}/${task.sessionId}`] ?? []);
    return { text, offset: 0, next: null, total: text.length, token: `demo-${exportVersion(text)}`, version: exportVersion(text) };
  },
  'thread.goal': ({ deviceId, state }, p) => goalOf(deviceId, findTask(state, deviceId, p?.sessionId)),
  'thread.setGoal': ({ deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    if (busy(task)) throw new Error('Stop the agent before editing its task details.');
    const next = { ...goalOf(deviceId, task), description: String(p.description ?? '').trim() };
    details.set(`${deviceId}/${task.sessionId}`, next);
    return next;
  },
  'thread.setStage': ({ host, deviceId, state }, p) => {
    const task = findTask(state, deviceId, p?.sessionId);
    if (!isStage(p?.stage)) throw new Error('Unknown task stage.');
    if (busy(task)) throw new Error('Restore this task and stop its agent before changing its stage.');
    const next = { ...goalOf(deviceId, task), stage: p.stage };
    details.set(`${deviceId}/${task.sessionId}`, next);
    listStage(host, deviceId, task.sessionId, p.stage);
    return next;
  },
};
