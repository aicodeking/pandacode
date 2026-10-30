import { escape, icon } from './dom';
import { folderGroups, shownTasks } from './sidebar-tree';
import { compareManual, compareCompleted, type SidebarSort } from './sidebar-sort';
import type { HeldSection } from './sidebar-sections';
import type { Project, Session } from './types';

/** Activity changes a chat's signals, never its parent folder. */
export function projectSidebar(options: {
  projects: Project[]; tasks: Session[]; all: Session[]; sort: SidebarSort; projectOrder: string[];
  collapsed: Set<string>; expanded: Set<string>; settledOpen: Set<string>;
  selectedId: string; selectedSection?: HeldSection; query: string;
  stage(task: Session): string; active(task: Session): boolean; running(task: Session): boolean;
  row(task: Session): string;
}): string {
  const { selectedId, query, sort, row } = options;
  const filtering = Boolean(query.trim());
  const settled = (task: Session) => !options.active(task) && (task.id === selectedId && options.selectedSection === 'completed'
    || options.stage(task) === 'completed' && !(task.id === selectedId && options.selectedSection && options.selectedSection !== 'completed'));
  const folders = folderGroups({ projects: options.projects, tasks: options.tasks, all: options.all, includeEmpty: true, sort: sort.projects, manual: options.projectOrder });
  const list = (key: string, tasks: Session[], keepActive = false) => {
    const expanded = options.expanded.has(key);
    const visible = filtering ? tasks : shownTasks(tasks, expanded, selectedId, sort.perProject);
    const ids = new Set(visible.map(task => task.id));
    if (keepActive) for (const task of tasks) if (options.active(task) || task.pinned) ids.add(task.id);
    const shown = tasks.filter(task => ids.has(task.id));
    const more = !filtering && (shown.length < tasks.length || expanded && tasks.length > sort.perProject)
      ? `<button class="folder-more" data-action="toggle-folder-more" data-project="${escape(key)}" tabindex="-1">${expanded ? 'Show less' : `Show ${tasks.length - shown.length} more`}</button>` : '';
    return shown.map(row).join('') + more;
  };
  return folders.filter(({ project, tasks }) => !filtering || tasks.length || query.trim().toLocaleLowerCase().split(/\s+/).every(word => project.name.toLocaleLowerCase().includes(word))).map(({ project, tasks }) => {
    const id = escape(project.id), name = escape(project.name), open = filtering || !options.collapsed.has(project.id);
    const normal = tasks.filter(task => !settled(task)).sort((a, b) => Number(Boolean(b.pinned)) - Number(Boolean(a.pinned)) || (a.pinned && b.pinned ? compareManual(a, b) : 0));
    const completed = tasks.filter(settled).sort(compareCompleted);
    const running = tasks.filter(options.running).length;
    const completedVisible = filtering || options.settledOpen.has(project.id);
    const completedList = completed.length ? `<section class="project-settled" data-thread-group="completed"><button class="section-toggle project-settled-toggle" data-action="toggle-project-settled" data-project="${id}" tabindex="-1" aria-label="Settled chats in ${name}" aria-expanded="${completedVisible}" aria-controls="project-${id}-settled">${icon('chevron')}<span>Settled</span><span class="folder-count">${completed.length}</span></button><div class="task-list" id="project-${id}-settled" ${completedVisible ? '' : 'hidden'}>${completedVisible ? list(`settled:${project.id}`, completed) : ''}</div></section>` : '';
    return `<section class="task-group folder-group project-tree-group" data-thread-group="project:${id}" data-project="${id}" aria-label="${name} chats"><div class="folder-row"><button class="folder-heading${tasks.length ? '' : ' empty'}" data-action="toggle-folder" data-project="${id}" tabindex="-1" draggable="${sort.projects === 'manual' && !filtering}" aria-label="${name} project" aria-expanded="${open}" aria-controls="project-${id}-tasks" title="${escape(project.path)}">${icon('chevron', 'folder-chevron')}${icon('folder')}<span class="folder-name">${name}</span>${running ? `<span class="folder-running" role="img" aria-label="${running} running" title="${running} running">${running}</span>` : ''}<span class="folder-count">${tasks.length}</span></button><button class="folder-new-task" data-action="project-task" data-id="${id}" tabindex="-1" aria-label="New chat in ${name}" title="New chat in ${name}">${icon('plus')}</button><button class="folder-actions" data-action="folder-menu" data-project="${id}" tabindex="-1" aria-label="Project actions: ${name}" aria-haspopup="menu" title="Project actions">${icon('more')}</button></div><div id="project-${id}-tasks" class="task-list folder-tasks" ${open ? '' : 'hidden'}>${open ? list(project.id, normal, true) + completedList + (!tasks.length ? '<div class="no-tasks">No chats yet</div>' : '') : ''}</div></section>`;
  }).join('');
}
