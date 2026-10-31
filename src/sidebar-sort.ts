/** Sidebar sort and view preferences, and the comparators every sidebar list uses. Pure: no DOM. */
import type { Project, Session } from './types';

export type TaskSort = 'manual' | 'recent' | 'created';
export type ProjectSort = 'recent' | 'added' | 'name' | 'manual';
/** By project: one folder per project. Flat: one list, each row naming its project. */
export type SidebarGroup = 'project' | 'flat';
export interface SidebarSort { tasks: TaskSort; projects: ProjectSort; perProject: number; group: SidebarGroup }

export const SORT_KEY = 'pandacode.sidebar.sort';
/** Folder order dragged by hand (Projects: Manual), as project ids. */
export const PROJECT_ORDER_KEY = 'pandacode.sidebar.projectOrder';
export const PER_PROJECT = [3, 6, 10, 15] as const;
export const DEFAULT_SORT: SidebarSort = { tasks: 'manual', projects: 'recent', perProject: 6, group: 'project' };
const TASK_SORTS: readonly TaskSort[] = ['manual', 'recent', 'created'];
const PROJECT_SORTS: readonly ProjectSort[] = ['recent', 'added', 'name', 'manual'];
const GROUPS: readonly SidebarGroup[] = ['project', 'flat'];

/** A saved choice that is missing or unknown falls back to the default, one field at a time. */
export function readSort(storage: Pick<Storage, 'getItem'>): SidebarSort {
  let saved: Partial<Record<keyof SidebarSort, unknown>> = {};
  try { const value: unknown = JSON.parse(storage.getItem(SORT_KEY) ?? '{}'); if (value && typeof value === 'object') saved = value; } catch { /* default */ }
  return {
    tasks: TASK_SORTS.includes(saved.tasks as TaskSort) ? saved.tasks as TaskSort : DEFAULT_SORT.tasks,
    projects: PROJECT_SORTS.includes(saved.projects as ProjectSort) ? saved.projects as ProjectSort : DEFAULT_SORT.projects,
    perProject: PER_PROJECT.includes(saved.perProject as 6) ? saved.perProject as number : DEFAULT_SORT.perProject,
    group: GROUPS.includes(saved.group as SidebarGroup) ? saved.group as SidebarGroup : DEFAULT_SORT.group,
  };
}

/** The saved folder order: unique string ids only, anything else is dropped. */
export function readProjectOrder(storage: Pick<Storage, 'getItem'>): string[] {
  try {
    const value: unknown = JSON.parse(storage.getItem(PROJECT_ORDER_KEY) ?? '[]');
    return Array.isArray(value) ? [...new Set(value.filter((id): id is string => typeof id === 'string'))].slice(0, 1000) : [];
  } catch { return []; }
}

/** Newest prompt or response; a task never prompted counts from its creation. */
export function activityAt(task: Session): number {
  return task.lastPromptAt == null ? task.lastResponseAt ?? task.createdAt : Math.max(task.lastPromptAt, task.lastResponseAt ?? 0);
}
const newest = (a: number, b: number) => b - a;
/** The last tie-breakers: newer first, then id, so equal rows never swap between draws. */
const settle = (a: Session, b: Session) => newest(a.createdAt, b.createdAt) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

/**
 * Manual order: tasks never ranked (new since the last drag) lead, newest activity first,
 * then ranked tasks in their saved order. A drag ranks the tasks it touched, so tasks
 * created afterwards would otherwise sink below every arranged one.
 */
export function compareManual(a: Session, b: Session): number {
  const ra = a.sidebarOrder ?? null, rb = b.sidebarOrder ?? null;
  if ((ra == null) !== (rb == null)) return ra == null ? -1 : 1;
  return (ra ?? 0) - (rb ?? 0) || newest(activityAt(a), activityAt(b)) || settle(a, b);
}

export function taskComparator(sort: TaskSort): (a: Session, b: Session) => number {
  if (sort === 'recent') return (a, b) => newest(activityAt(a), activityAt(b)) || settle(a, b);
  if (sort === 'created') return settle;
  return compareManual;
}

/** Active work: the most recently started on top; never arranged by hand. */
export function compareStarted(a: Session, b: Session): number {
  return newest(a.lastPromptAt ?? a.createdAt, b.lastPromptAt ?? b.createdAt) || settle(a, b);
}
/** Completed: the latest completion on top. Metadata edits (renames) never move a row. */
export function compareCompleted(a: Session, b: Session): number {
  const done = (task: Session) => task.completedAt ?? task.lastResponseAt ?? task.createdAt;
  return newest(done(a), done(b)) || settle(a, b);
}

/** Orders folders. `latest` holds each project's newest activity across all its tasks; `manual`
 * is the dragged order, where projects not in it yet (new ones) lead, most recent first. */
export function projectComparator(sort: ProjectSort, projects: readonly Project[], latest: ReadonlyMap<string, number>, manual: readonly string[] = []): (a: Project, b: Project) => number {
  const added = new Map(projects.map((project, index) => [project.id, index]));
  const byName = (a: Project, b: Project) => a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
  const recent = (a: Project, b: Project) => (latest.get(b.id) ?? 0) - (latest.get(a.id) ?? 0) || byName(a, b);
  if (sort === 'name') return byName;
  // The native list comes sorted by name, so Added reads each project's addedOrder (its rowid).
  if (sort === 'added') return (a, b) => (a.addedOrder ?? added.get(a.id) ?? 0) - (b.addedOrder ?? added.get(b.id) ?? 0) || byName(a, b);
  if (sort === 'manual') {
    const rank = new Map(manual.map((id, index) => [id, index]));
    return (a, b) => (rank.get(a.id) ?? -1) - (rank.get(b.id) ?? -1) || recent(a, b);
  }
  return recent;
}

/** Lower-case text a sidebar filter matches: title, branch, linked PR or issue, project. */
export function filterText(task: Session, projectName = ''): string {
  const link = task.pullRequest ?? task.issue;
  return [task.title, task.worktreeBranch ?? '', link ? `#${link.number} ${link.title}` : '', projectName].join('\n').toLocaleLowerCase();
}
export function matchesFilter(task: Session, query: string, projectName = ''): boolean {
  const words = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return true;
  const text = filterText(task, projectName);
  return words.every(word => text.includes(word));
}
