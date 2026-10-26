/** Sidebar sections: threads that need you (Active, Needs review) above the tree, finished ones (Completed) below it. */
import type { Session, TaskStage } from './types';
import { compareCompleted, compareResponded, compareStarted } from './sidebar-sort.ts';

/** A finished turn stays in Needs review for a day, then returns to its folder. */
export const REVIEW_WINDOW = 24 * 60 * 60 * 1000;
/** Whether the Completed section is open ('true') or closed (anything else). */
export const COMPLETED_OPEN_KEY = 'pandacode.sidebar.completedOpen';
/** IDs of threads whose turn finished while another thread was open; opening one clears it. */
export const UNREVIEWED_KEY = 'pandacode.sidebar.unreviewed';

export interface SectionInput {
  /** Visible tasks in sidebar order. */
  tasks: readonly Session[];
  now: number;
  /** Running, waiting on an approval or answer, stopped by a usage limit, or failed while you were away. */
  active(task: Session): boolean;
  stage(task: Session): TaskStage;
  /** Its latest turn finished while you were elsewhere and you have not opened it since (default: always). */
  unseen?(task: Session): boolean;
  /** The open thread is never waiting for review, so it stays in its folder… */
  selectedId?: string;
  /** …unless held: the open thread stays in the section it was opened from (running work still
   * goes to Active), so a click on its row (Reopen, Mark complete, a finished run) never moves it. */
  hold?: HeldSection;
}
export type HeldSection = 'active' | 'review' | 'rest' | 'completed';
/** The section a sidebar group belongs to: Pinned, Chats, folders and the archive are `rest`. */
export function sectionOf(group: string | undefined): HeldSection | undefined {
  if (!group) return undefined;
  return group === 'active' || group === 'review' || group === 'completed' ? group : 'rest';
}

export interface Sections {
  active: Session[];
  review: Session[];
  /** Pinned, Chats and project folders. */
  rest: Session[];
  /** Most recently completed first. */
  completed: Session[];
}

/** Each task lands in exactly one section. Running work, pinned or open, is always Active; pinned tasks otherwise stay pinned unless completed. */
export function sidebarSections({ tasks, now, active, stage, unseen = () => true, selectedId, hold }: SectionInput): Sections {
  const sections: Sections = { active: [], review: [], rest: [], completed: [] };
  for (const task of tasks) {
    const running = active(task), done = stage(task) === 'completed', open = task.id === selectedId;
    if (running) sections.active.push(task);
    else if (open && hold) sections[hold].push(task);
    else if (done) sections.completed.push(task);
    else if (task.pinned || open) sections.rest.push(task);
    else if (needsReview(task, now, stage) && unseen(task)) sections.review.push(task);
    else sections.rest.push(task);
  }
  // Each section has its own order, never the manual one, so arranging a folder never reshuffles them.
  sections.active.sort(compareStarted);
  sections.review.sort(compareResponded);
  sections.completed.sort(compareCompleted);
  return sections;
}

/** Idle work whose last turn finished within REVIEW_WINDOW. */
export function needsReview(task: Session, now: number, stage: (task: Session) => TaskStage): boolean {
  return stage(task) === 'review' && task.lastResponseAt != null && task.lastResponseAt > now - REVIEW_WINDOW;
}

export function readOpen(storage: Pick<Storage, 'getItem'>, key: string): boolean {
  try { return storage.getItem(key) === 'true'; } catch { return false; }
}
