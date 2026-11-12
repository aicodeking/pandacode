/** Stable host-owned locations; these are not selectors or dynamic inspector view IDs. */
import type { WindowActionLocation } from './window-surfaces';
export const VIEW_ACTION_SURFACES = [
  'panda.inspector.files.toolbar', 'panda.inspector.files.context',
  'panda.inspector.changes.toolbar', 'panda.inspector.changes.context',
  'panda.inspector.search.toolbar', 'panda.inspector.search.context',
  'panda.sidebar.project.context', 'panda.sidebar.task.context',
] as const;
export const THREAD_ACTION_SURFACES = [
  'panda.composer.actions', 'panda.composer.tray', 'panda.composer.attachments',
  'panda.thread.header', 'panda.thread.message.actions', 'panda.thread.trace.actions',
  'panda.actionDock.actions', 'panda.team.actions', 'panda.agents.actions',
] as const;
export type ThreadActionLocation = typeof THREAD_ACTION_SURFACES[number];
export const SETTINGS_ACTION_SURFACES = ['panda.status.items', 'panda.dialog.colors.actions', 'panda.dialog.wallpapers.actions'] as const;
export const SETTINGS_DATA_SURFACES = ['panda.settings.pages', 'panda.commands', 'panda.shortcuts', 'panda.dialog.colors.bodyExtras', 'panda.dialog.wallpapers.bodyExtras'] as const;
export type ActionLocation = 'panda.workspace.header.actions' | 'panda.sidebar.footer' | 'panda.inspector.actions' | 'panda.status.items' | 'panda.dialog.colors.actions' | 'panda.dialog.wallpapers.actions' | typeof VIEW_ACTION_SURFACES[number] | ThreadActionLocation | WindowActionLocation;

/** Reserve room for core actions; oversized extension trees never break the legacy menu. */
export function boundedContextActions<T extends { children?: T[] }>(core: T[], contributed: T[], limit = 128): { items: T[]; omitted: number } {
  const size = (item: T): number => 1 + (item.children ?? []).reduce((count, child) => count + size(child), 0);
  let remaining = limit - core.reduce((count, item) => count + size(item), 0), omitted = 0;
  const items = [...core];
  for (const item of contributed) {
    const count = size(item);
    if (count > remaining) { omitted++; continue; }
    items.push(item); remaining -= count;
  }
  return { items, omitted };
}

export const CONTEXT_COMMANDS: Record<string, readonly (readonly [string, string])[]> = {
  'panda.inspector.files.context': [['open', 'Open file'], ['attach', 'Attach file']],
  'panda.inspector.changes.context': [['stage', 'Stage file'], ['unstage', 'Unstage file'], ['open', 'Open file'], ['copy', 'Copy path']],
  'panda.inspector.search.context': [['open', 'Open file']],
  'panda.sidebar.project.context': [['new', 'New task'], ['collapse', 'Collapse other projects'], ['reveal', 'Reveal folder'], ['remove', 'Remove project…']],
  'panda.sidebar.task.context': [['pin', 'Pin task'], ['up', 'Move up'], ['down', 'Move down'], ['beside', 'Open beside'], ['rename', 'Rename…'], ['wake', 'Schedule a wake-up…'], ['unread', 'Mark as unread'], ['branch-task', 'New task from branch…'], ['copy-branch', 'Copy branch name'], ['copy-path', 'Copy project path'], ['copy-id', 'Copy task ID'], ['stage', 'Settle'], ['delete', 'Delete task…']],
};
