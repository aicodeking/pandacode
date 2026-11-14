/** Stable host-owned locations; these are not selectors or dynamic inspector view IDs. */
import type { WindowActionLocation } from './window-surfaces';
/** Branch/worktree menu entries and chip context. `panda.worktree.protected` is inspect-only:
 * recovery rows, the branch picker and form/cleanup confirmations are never hidden, reordered or package-confirmed. */
export const WORKTREE_ACTION_SURFACES = ['panda.worktree.actions', 'panda.worktree.context'] as const;
export const WORKTREE_CONTROLS = {
  'panda.worktree.controls': [['branch-menu', 'Branch and worktree menu'], ['checkout', 'Checkout kind'], ['open-pull', 'Linked pull request'], ['open-url', 'Linked issue']],
  'panda.worktree.actions': [['switch-default', 'Switch to the main branch'], ['switch-other', 'Other branch'], ['worktree-attach', 'Work in a new worktree'], ['worktree-new', 'New task in a worktree'], ['worktree-merge', 'Merge worktree'], ['worktree-remove', 'Remove worktree'], ['copy-path', 'Copy checkout path']],
  'panda.worktree.protected': [['checkout-row', 'Current checkout'], ['worktree-recreate', 'Recreate worktree'], ['settle-task', 'Settle task'], ['branch-pick', 'Pick a branch to switch to'], ['worktree-confirm', 'Create worktree'], ['cleanup-confirm', 'Confirm cleanup'], ['cleanup-remove', 'Remove the worktree folder']],
} as const;
export const WORKTREE_PROTECTED_LOCATION = 'panda.worktree.protected';
export const PULL_ACTION_SURFACES = ['panda.pull.actions', 'panda.pull.context'] as const;
/** `panda.pull.merge` is protected: inspectable only, never hidden, reordered or package-confirmed. */
export const PULL_CONTROLS = {
  'panda.pull.controls': [['overview', 'Summary section'], ['commits', 'Commits section'], ['files', 'Files section'], ['checks', 'Show checks'], ['check', 'Open check details'], ['review', 'Reviews on GitHub'], ['conflicts', 'Mergeability'], ['link', 'Open pull request on GitHub'], ['file', 'Toggle file diff'], ['refresh', 'Refresh pull request'], ['unlink', 'Unlink pull request']],
  'panda.pull.merge': [['merge-start', 'Start merge'], ['merge-method', 'Choose merge method'], ['merge-cancel', 'Cancel merge'], ['merge-confirm', 'Confirm merge']],
} as const;
export const PULL_PROTECTED_LOCATION = 'panda.pull.merge';
export const GITHUB_HUB_ACTION_SURFACES = ['panda.githubHub.actions', 'panda.githubHub.context'] as const;
export const GITHUB_HUB_CONTROLS = { 'panda.githubHub.controls': [
  ['repo', 'Select repository'], ['tab', 'Repository tab'], ['refresh', 'Refresh GitHub'], ['other', 'Other repositories'], ['clone', 'Clone repository'], ['open', 'Open on GitHub'], ['task', 'Open thread'], ['review', 'Review pull request'], ['pull-menu', 'Pull request actions'], ['runs', 'Pull request runs'], ['issue-thread', 'Open issue thread'], ['solve', 'Solve issue'], ['fix', 'Fix workflow run'], ['details', 'Workflow run details'], ['workflow', 'Check workflow files'], ['clear', 'Clear run filters'], ['repo-filter', 'Filter repositories'], ['query', 'Search this tab'], ['event', 'Filter runs by event'], ['pull', 'Filter runs by pull request'], ['latest', 'Latest run per pull request'], ['compose', 'Start thread'],
] } as const;
export const BOARD_ACTION_SURFACES = ['panda.board.header', 'panda.board.card', 'panda.board.detail', 'panda.board.context'] as const;
export const BOARD_CONTROLS = {
  'panda.board.header': [['open-project', 'Open project'], ['filter', 'Filter projects'], ['import', 'Import from GitHub'], ['add', 'Add task']],
  'panda.board.columns': [['pending', 'Pending column'], ['in-progress', 'In progress column'], ['review', 'Review column'], ['completed', 'Settled column']],
  'panda.board.cards': [['open', 'Open task'], ['start', 'Start pending task'], ['retry', 'Retry task']],
  'panda.board.detail': [['edit', 'Edit task details'], ['close', 'Close task details'], ['start', 'Start task'], ['retry', 'Retry task'], ['settle', 'Settle task'], ['reopen', 'Reopen task']],
} as const;
export const BTW_ACTION_SURFACES = ['panda.btw.header', 'panda.btw.composer', 'panda.btw.context'] as const;
export const BTW_CONTROLS = {
  'panda.btw.header': [['new', 'New side thread'], ['open', 'Open side thread'], ['close', 'Close side panel']],
  'panda.btw.controls': [['focus', 'Side draft'], ['model', 'Side model'], ['send', 'Send side message'], ['steer', 'Steer side task'], ['stop', 'Stop side task']],
  'panda.btw.queue': [['queue-edit', 'Edit queued side message'], ['queue-save', 'Save queued side message'], ['queue-cancel', 'Cancel queue edit'], ['queue-remove', 'Remove queued side message'], ['queue-send', 'Send queued side message'], ['queue-steer', 'Steer queued side message'], ['queue-resume', 'Resume side queue']],
  'panda.btw.message': [['insert', 'Insert side answer into main draft']],
} as const;
export const VIEW_ACTION_SURFACES = [
  'panda.inspector.files.toolbar', 'panda.inspector.files.context',
  'panda.inspector.changes.toolbar', 'panda.inspector.changes.context',
  'panda.inspector.search.toolbar', 'panda.inspector.search.context',
  'panda.sidebar.project.context', 'panda.sidebar.task.context',
] as const;
export const DOCUMENT_ACTION_SURFACES = ['panda.documents.actions', 'panda.documents.context'] as const;
export const CHANGES_ACTION_SURFACES = ['panda.changes.actions'] as const;
export const BROWSER_ACTION_SURFACES = ['panda.browser.actions', 'panda.browser.context'] as const;
export const SIMULATOR_ACTION_SURFACES = ['panda.simulator.actions', 'panda.simulator.context'] as const;
export const VM_ACTION_SURFACES = ['panda.vm.actions', 'panda.vm.context'] as const;
export const DESIGN_ACTION_SURFACES = ['panda.design.actions', 'panda.design.context'] as const;
export const DESIGN_CONTROLS = { 'panda.design.controls': [['comment', 'Comment mode'], ['in', 'Zoom in'], ['out', 'Zoom out'], ['fit', 'Fit artboards'], ['refresh', 'Reload artboards'], ['pan', 'Pan canvas'], ['select', 'Select element'], ['draft', 'Comment draft'], ['save', 'Add comment'], ['cancel', 'Cancel comment'], ['resolve', 'Resolve comment'], ['reopen', 'Reopen comment'], ['delete', 'Delete comment'], ['compose', 'Compose comments']] } as const;
export const VM_CONTROLS = { 'panda.vm.controls': [['select', 'Choose VM'], ['new', 'New VM'], ['delete', 'Delete VM'], ['setup', 'Set up VMs'], ['desktop', 'Add a desktop'], ['power', 'Start / stop VM'], ['suspend', 'Suspend VM'], ['input', 'VM input'], ['share', 'Share project read-only']] } as const;
export const SIMULATOR_CONTROLS = { 'panda.simulator.controls': [
  ['device', 'Choose simulator'], ['pose', 'Device pose'], ['finish', 'Device finish'], ['appearance', 'Light / dark'], ['power', 'Boot / shut down'], ['back', 'Back'], ['recents', 'Recent apps'], ['reset', 'Face forward'], ['home', 'Home'], ['lock', 'Lock'], ['capture', 'Copy screenshot'], ['copy-axe', 'Copy AXe install command'], ['add-duo', 'Add iPhone Duo'], ['android-setup', 'Set up Android emulator'],
] } as const;
export const TERMINAL_CONTROLS = { 'panda.terminal.controls': [['new', 'New terminal'], ['minimize', 'Minimize terminal'], ['select', 'Select terminal tab'], ['close', 'Close terminal tab']] } as const;
export const TERMINAL_ACTION_SURFACES = ['panda.terminal.actions', 'panda.terminal.context'] as const;
export const BROWSER_CONTROLS = { 'panda.browser.controls': [
  ['back', 'Go back'], ['forward', 'Go forward'], ['reload', 'Reload page'], ['address', 'Browser URL'],
  ['pick', 'Attach an element'], ['capture', 'Attach screenshot'], ['test', 'Test with Jev'], ['close', 'Close browser'],
  ['home', 'Local servers'], ['watch-jev', 'Watch Jev'], ['refresh-ports', 'Refresh local servers'],
] } as const;
export const SEARCH_CONTROLS = {
  'panda.search.controls': [['query', 'Search query'], ['match-case', 'Match case'], ['whole-word', 'Match whole word'], ['regex', 'Use regular expression']],
} as const;
export const CHANGES_CONTROLS = {
  'panda.changes.controls': [['scope', 'Change scope'], ['fold-all', 'Collapse all'], ['menu', 'Changes menu'], ['commit-message', 'Commit message'], ['commit', 'Commit'], ['retry', 'Retry Changes']],
  'panda.changes.file': [['toggle', 'Collapse file'], ['copy', 'Copy path'], ['file-menu', 'File actions'], ['retry-file', 'Retry diff']],
  'panda.changes.viewer': [['unified', 'Unified diff'], ['split', 'Split diff'], ['wrap', 'Wrap lines']],
} as const;
export const THREAD_ACTION_SURFACES = [
  'panda.composer.actions', 'panda.composer.tray', 'panda.composer.attachments',
  'panda.thread.header', 'panda.thread.message.actions', 'panda.thread.trace.actions',
  'panda.actionDock.actions', 'panda.team.actions', 'panda.agents.actions',
] as const;
export type ThreadActionLocation = typeof THREAD_ACTION_SURFACES[number];
export const SETTINGS_ACTION_SURFACES = ['panda.status.items', 'panda.dialog.colors.actions', 'panda.dialog.wallpapers.actions'] as const;
export const SETTINGS_DATA_SURFACES = ['panda.settings.pages', 'panda.commands', 'panda.shortcuts', 'panda.dialog.colors.bodyExtras', 'panda.dialog.wallpapers.bodyExtras'] as const;
export type ActionLocation = typeof WORKTREE_ACTION_SURFACES[number] | typeof PULL_ACTION_SURFACES[number] | typeof GITHUB_HUB_ACTION_SURFACES[number] | typeof BOARD_ACTION_SURFACES[number] | 'panda.workspace.header.actions' | 'panda.sidebar.footer' | 'panda.inspector.actions' | 'panda.status.items' | 'panda.dialog.colors.actions' | 'panda.dialog.wallpapers.actions' | typeof BTW_ACTION_SURFACES[number] | typeof DESIGN_ACTION_SURFACES[number] | typeof VIEW_ACTION_SURFACES[number] | typeof DOCUMENT_ACTION_SURFACES[number] | typeof CHANGES_ACTION_SURFACES[number] | typeof BROWSER_ACTION_SURFACES[number] | typeof TERMINAL_ACTION_SURFACES[number] | typeof SIMULATOR_ACTION_SURFACES[number] | typeof VM_ACTION_SURFACES[number] | ThreadActionLocation | WindowActionLocation;

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
  'panda.documents.context': [['select', 'Select document'], ['close', 'Close document'], ['attach', 'Attach'], ['copy', 'Copy file'], ['preview', 'Preview in browser']],
  'panda.inspector.files.context': [['open', 'Open file'], ['attach', 'Attach file']],
  'panda.inspector.changes.context': [['stage', 'Stage file'], ['unstage', 'Unstage file'], ['open', 'Open file'], ['copy', 'Copy path']],
  'panda.inspector.search.context': [['open', 'Open file']],
  'panda.sidebar.project.context': [['new', 'New task'], ['collapse', 'Collapse other projects'], ['reveal', 'Reveal folder'], ['remove', 'Remove project…']],
  'panda.sidebar.task.context': [['pin', 'Pin task'], ['up', 'Move up'], ['down', 'Move down'], ['beside', 'Open beside'], ['rename', 'Rename…'], ['wake', 'Schedule a wake-up…'], ['unread', 'Mark as unread'], ['branch-task', 'New task from branch…'], ['copy-branch', 'Copy branch name'], ['copy-path', 'Copy project path'], ['copy-id', 'Copy task ID'], ['stage', 'Settle'], ['delete', 'Delete task…']],
};
