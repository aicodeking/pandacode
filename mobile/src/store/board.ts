// The task board (the desktop's src/task-board.ts, docs/task-board.md) as pure data for board.tsx:
// each task's stage, the tasks grouped by stage, which stages a task may move to and how the
// screen lays them out. Pure, so tests/board.test.ts covers it in node.
import type { TaskSummary } from '../connect/types.ts';
import { isStage, STAGES, type Stage } from './thread-model.ts';

export { STAGES, type Stage } from './thread-model.ts';

/** The desktop board's column names (store/stages.ts, shared with Task info). */
export { STAGE_NAMES as BOARD_LABELS } from './stages.ts';

/** What an empty stage says, as the desktop's empty columns. */
export const BOARD_EMPTY: Readonly<Record<Stage, string>> = {
  pending: 'Ideas waiting to begin', in_progress: 'Work happens here', review: 'Ready for your feedback', completed: 'Settled and done',
};

const WORKING = new Set(['running', 'waiting', 'interrupted']);
const BUSY = new Set(['running', 'waiting']);

type BoardTask = Pick<TaskSummary, 'stage' | 'archived' | 'status' | 'lastPromptAt'>;

/** A task's stage as the desktop's `taskStage`: archived counts as settled; a host without stages
 * gets one from the run (working → In progress, answered → Review, else Pending). */
export function boardStage(task: BoardTask): Stage {
  if (task.archived) return 'completed';
  if (isStage(task.stage)) return task.stage;
  if (WORKING.has(task.status)) return 'in_progress';
  return task.lastPromptAt ? 'review' : 'pending';
}

export type BoardGroups = Readonly<Record<Stage, readonly TaskSummary[]>>;

/** Project tasks (not chats or bot conversations) by stage, most recently updated first;
 * `projectId` keeps one project's. */
export function groupBoard(tasks: readonly TaskSummary[], projectId?: string): BoardGroups {
  const shown = tasks.filter(t => !t.chat && !t.botId && (!projectId || t.projectId === projectId));
  const sorted = [...shown].sort((a, b) => b.updatedAt - a.updatedAt);
  const of = (stage: Stage) => sorted.filter(t => boardStage(t) === stage);
  return { pending: of('pending'), in_progress: of('in_progress'), review: of('review'), completed: of('completed') };
}

/** Whether the agent holds the task, so its stage can't change (the host refuses it too). */
export const stageLocked = (task: Pick<TaskSummary, 'status'>): boolean => BUSY.has(task.status);

/** The stages a task can move to from the board: never its own, and In progress only comes from
 * starting it (as Task info and the desktop's Start); none while the agent works. */
export function stageMoves(task: BoardTask): Stage[] {
  if (stageLocked(task)) return [];
  const current = boardStage(task);
  return STAGES.filter(stage => stage !== current && stage !== 'in_progress');
}

/** A card's stage action, as the desktop's task details (src/task-board.ts renderTaskDetails):
 * Start a pending task, Retry one left in progress, Settle one in review, Reopen a settled one;
 * none while the agent works. */
export type BoardAction = 'start' | 'retry' | 'settle' | 'reopen';
export function boardAction(task: BoardTask): BoardAction | null {
  const stage = boardStage(task);
  if (stage === 'completed') return 'reopen';
  if (BUSY.has(task.status)) return null;
  if (stage === 'review') return 'settle';
  return stage === 'pending' ? 'start' : 'retry';
}

/** What starting a task sends, as the desktop's Start: its details, else its title. */
export const startPrompt = (title: string, description?: string | null): string => description?.trim() || title.trim();

/** Wide enough for the desktop's four columns (the Duo's split pane, a tablet); else tabs. */
export const BOARD_COLUMNS_MIN_WIDTH = 760;
export const boardLayout = (width: number): 'columns' | 'tabs' => (width >= BOARD_COLUMNS_MIN_WIDTH ? 'columns' : 'tabs');

/** The tab to open on: the first stage with tasks, In progress first, else Pending. */
export function firstStage(groups: BoardGroups): Stage {
  const order: Stage[] = ['in_progress', 'review', 'pending', 'completed'];
  return order.find(stage => groups[stage].length > 0) ?? 'pending';
}

/** The projects the board can filter by, in first-seen order. */
export function boardProjects(tasks: readonly TaskSummary[]): { id: string; name: string }[] {
  const seen = new Map<string, string>();
  for (const t of tasks) if (!t.chat && !t.botId && t.projectId && !seen.has(t.projectId)) seen.set(t.projectId, t.projectName || 'Project');
  return [...seen].map(([id, name]) => ({ id, name }));
}
