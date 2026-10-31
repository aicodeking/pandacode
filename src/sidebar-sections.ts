/** Sidebar sections: threads that need you (Active, Finished) above the tree, settled ones below it. */
import type { Session, TaskStage } from './types';
import { compareCompleted, compareStarted } from './sidebar-sort.ts';

/** Whether the Settled section is open ('true') or closed (anything else). */
export const COMPLETED_OPEN_KEY = 'pandacode.sidebar.completedOpen';
/** Keys of closed Active / Finished sections. */
export const COLLAPSED_SECTIONS_KEY = 'pandacode.sidebar.collapsedSections';
/** IDs of threads whose turn finished out of sight; they show as unread until opened. */
export const UNREVIEWED_KEY = 'pandacode.sidebar.unreviewed';

export interface SectionInput {
  /** Visible tasks in sidebar order. */
  tasks: readonly Session[];
  /** Running, waiting on an approval or answer, stopped by a usage limit, or failed while you were away. */
  active(task: Session): boolean;
  stage(task: Session): TaskStage;
  selectedId?: string;
  /** The open thread stays in the section it was opened from (running work still goes to
   * Active), so a click on its row (Reopen, Settle, a finished run) never moves it. */
  hold?: HeldSection;
}
export type HeldSection = 'active' | 'review' | 'rest' | 'completed';
/** The section a sidebar group belongs to: Pinned, Chats and folders are `rest`. */
export function sectionOf(group: string | undefined): HeldSection | undefined {
  if (!group) return undefined;
  return group === 'active' || group === 'review' || group === 'completed' ? group : 'rest';
}

export interface Sections {
  active: Session[];
  review: Session[];
  /** Pinned only. */
  rest: Session[];
  /** Settled (stage `completed`), most recently settled first. */
  completed: Session[];
}

/** Each task lands in exactly one section. Running work, pinned or open, is always Active; pinned
 * tasks otherwise stay pinned unless settled; finished work stays in Finished until it is settled. */
export function sidebarSections({ tasks, active, stage, selectedId, hold }: SectionInput): Sections {
  const sections: Sections = { active: [], review: [], rest: [], completed: [] };
  for (const task of tasks) {
    const running = active(task), done = stage(task) === 'completed', open = task.id === selectedId;
    // Only three states: Active, Finished, Settled. Anything not running or settled is Finished
    // (new, interrupted, failed or board-staged alike); `rest` holds only Pinned.
    // A pinned task is never held in Finished, an unpinned one never in Pinned.
    const held = open && hold && (task.pinned ? hold !== 'review' : hold !== 'rest') ? hold : undefined;
    if (running) sections.active.push(task);
    else if (held) sections[held].push(task);
    else if (done) sections.completed.push(task);
    else if (task.pinned) sections.rest.push(task);
    else sections.review.push(task);
  }
  // Active and Settled keep their own order; Finished is the main list, so it keeps the sidebar
  // sort it was given (Manual lists never-arranged work newest first, then the arranged rows).
  sections.active.sort(compareStarted);
  sections.completed.sort(compareCompleted);
  return sections;
}

export function readOpen(storage: Pick<Storage, 'getItem'>, key: string): boolean {
  try { return storage.getItem(key) === 'true'; } catch { return false; }
}
