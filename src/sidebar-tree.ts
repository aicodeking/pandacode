/** Sidebar tree: pinned tasks first, then one folder per project with its tasks indented beneath it. */
import type { Project, Session } from './types';
import { activityAt, projectComparator, type ProjectSort } from './sidebar-sort.ts';

/** Tasks a folder shows before "Show more" unless the sort menu says otherwise. The selected task is always shown. */
export const FOLDER_LIMIT = 6;
/** With one project selected its list fills the sidebar, so it shows more before "Show more". */
export const PROJECT_LIMIT = 20;

export interface FolderGroup {
  project: Project;
  tasks: Session[];
  /** Newest prompt or response among all the project's tasks; orders folders. */
  latest: number;
}

export interface TreeInput {
  projects: readonly Project[];
  /** Visible, unpinned tasks already sorted in sidebar order. */
  tasks: readonly Session[];
  /** Every task of these projects, wherever it is listed (Active, Needs review, Pinned, Completed).
   * Folder order reads their activity, so a folder holds still when its task starts running. */
  all?: readonly Session[];
  /** Keep folders without tasks (hidden while searching). */
  includeEmpty: boolean;
  sort?: ProjectSort;
  /** The dragged folder order, for `sort: 'manual'`. */
  manual?: readonly string[];
}

/** Folders ordered by the project sort; within a folder, tasks keep their sidebar order. */
export function folderGroups({ projects, tasks, all = tasks, includeEmpty, sort = 'recent', manual = [] }: TreeInput): FolderGroup[] {
  const byProject = new Map<string, Session[]>(), latest = new Map<string, number>();
  for (const task of tasks) byProject.set(task.projectId, [...(byProject.get(task.projectId) ?? []), task]);
  for (const task of all) latest.set(task.projectId, Math.max(latest.get(task.projectId) ?? 0, activityAt(task)));
  const order = projectComparator(sort, projects, latest, manual);
  return [...projects].sort(order)
    .map(project => ({ project, tasks: byProject.get(project.id) ?? [], latest: latest.get(project.id) ?? 0 }))
    .filter(group => group.tasks.length || includeEmpty);
}

/** The rows a folder shows: its first tasks, plus the selected one if it would otherwise be hidden. */
export function shownTasks(tasks: readonly Session[], expanded: boolean, selectedId: string, limit = FOLDER_LIMIT): Session[] {
  if (expanded || tasks.length <= limit) return [...tasks];
  const head = tasks.slice(0, limit);
  const selected = tasks.find(task => task.id === selectedId);
  return selected && !head.includes(selected) ? [...head, selected] : head;
}

/** Folder open/closed state lives per project across launches. */
export function readCollapsed(storage: Pick<Storage, 'getItem'>, key: string): Set<string> {
  try {
    const value: unknown = JSON.parse(storage.getItem(key) ?? '[]');
    return new Set(Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string') : []);
  } catch { return new Set(); }
}
