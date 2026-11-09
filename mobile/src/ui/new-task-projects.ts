import type { Project, TasksList } from '../connect/types.ts';

/** Projectless chats live in their own "Chat" projects, which aren't something to start a task in. */
export function pickableProjects(list: TasksList | undefined | null): Project[] {
  if (!list) return [];
  const chats = new Set(list.tasks.filter(task => task.chat).map(task => task.projectId));
  return list.projects.filter(project => !chats.has(project.id));
}
