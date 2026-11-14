/** Stable host-owned locations; these are not selectors or dynamic inspector view IDs. */
import type { WindowActionLocation } from './window-surfaces';
/** Execution host and machine coordination. `panda.machines.context` is the lineage row, waiting line and
 * fixed remote chip context menu; `panda.machines.protected` is inspect-only: the fixed task computer, the
 * behind-GitHub continue, the remote start send, the Link a machine submit with its access choice, pairing
 * approval, the orchestration switch and unlinking are never hidden, reordered or package-confirmed. */
export const MACHINES_ACTION_SURFACES = ['panda.machines.context'] as const;
export const MACHINES_CONTROLS = {
  'panda.machines.controls': [['link-decline', 'Decline link request'], ['link-open', 'Link a machine…']],
  'panda.machines.targets': [['target-local', 'This computer'], ['target-device', 'Other computers'], ['target-setup', 'Set up other computers…']],
  'panda.machines.context': [['lineage-open', 'Open thread'], ['lineage-stop', 'Stop thread'], ['stop-all', 'Stop all threads'], ['reconnect', 'Retry connection']],
  'panda.machines.protected': [['chip', 'Fixed task computer'], ['behind-continue', 'Start from GitHub anyway'], ['remote-start', 'Start on another computer'], ['link-confirm', 'Link machine with access'], ['pairing', 'Pairing approval'], ['orchestration', 'Agent orchestration switch'], ['unlink', 'Unlink computer']],
} as const;
export const MACHINES_PROTECTED_LOCATION = 'panda.machines.protected';
/** Cloud machine menu entries and strip/chip context. `panda.cloud.protected` is inspect-only: the fixed
 * computer chip, the delete confirmation, the provisioning send and provider credentials are never hidden,
 * reordered or package-confirmed. */
export const CLOUD_ACTION_SURFACES = ['panda.cloud.actions', 'panda.cloud.context'] as const;
const CLOUD_MACHINE_ROWS = [['sync', 'Sync changes'], ['retry', 'Retry'], ['open', 'Open machine'], ['stop', 'Stop machine'], ['delete', 'Delete machine…']] as const;
export const CLOUD_CONTROLS = {
  'panda.cloud.controls': [['status', 'Cloud machine status'], ['machine-menu', 'Cloud machine actions']],
  'panda.cloud.targets': [['target-cloud', 'Cloud providers'], ['target-setup', 'Set up cloud providers…']],
  'panda.cloud.actions': CLOUD_MACHINE_ROWS,
  'panda.cloud.context': CLOUD_MACHINE_ROWS,
  'panda.cloud.protected': [['chip', 'Fixed cloud computer'], ['delete-confirm', 'Delete machine'], ['cloud-start', 'Start on a cloud machine'], ['credentials', 'Cloud provider credentials']],
} as const;
export const CLOUD_PROTECTED_LOCATION = 'panda.cloud.protected';
/** Moodboard toolbar entries and image/board context. `panda.moodboards.protected` is inspect-only:
 * the create submit, delete confirmation, file chooser and drop are never hidden, reordered or package-confirmed. */
export const MOODBOARD_ACTION_SURFACES = ['panda.moodboards.actions', 'panda.moodboards.context'] as const;
export const MOODBOARD_CONTROLS = {
  'panda.moodboards.controls': [['board-new', 'New moodboard'], ['image-add', 'Add images'], ['board-delete', 'Delete moodboard'], ['attach', 'Attach to task']],
  'panda.moodboards.context': [['image-preview', 'View image'], ['image-caption', 'Edit caption'], ['image-remove', 'Remove image']],
  'panda.moodboards.protected': [['create-confirm', 'Create moodboard'], ['delete-confirm', 'Delete the board and its images'], ['file-picker', 'Choose image files'], ['file-drop', 'Drop or paste images']],
} as const;
export const MOODBOARD_PROTECTED_LOCATION = 'panda.moodboards.protected';
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
export const SETTINGS_ACTION_SURFACES = ['panda.status.items'] as const;
export const SETTINGS_DATA_SURFACES = ['panda.settings.pages', 'panda.commands', 'panda.shortcuts'] as const;
/** Main-window modals opened through the shared main.ts modal helper (docs/extensions/core-dialogs.md). Eligible
 * dialogs accept owner-labelled body extras and secondary actions in one band after the host content:
 * [dialog id, title, captured target]. The original fields, primary action and confirmation stay host-owned. */
export const MAIN_DIALOG_EXTRAS = [
  ['recipes', 'Workflow recipes', 'task'], ['attachment', 'Message attachment', 'task'], ['task-details', 'Task details', 'task'],
  ['subagents', 'Subagents', 'task'], ['task-status', 'Task status', 'task'], ['integrations-fallback', 'Integrations', 'task'],
  ['working-directory', 'Working directory', 'task'], ['changed-files', 'Changed files', 'task'], ['open-project', 'Open project', 'none'],
  ['rename-task', 'Rename task', 'task'], ['colors', 'Colors', 'none'], ['wallpapers', 'Wallpapers', 'none'],
  ['opencode-models', 'OpenCode models', 'none'], ['moodboards', 'Moodboards', 'project'], ['integrations', 'Tools & integrations', 'project'],
  ['jev-settings', 'Jev add-on', 'none'], ['jev-assist', 'Jev assistance', 'task'], ['jev-tests', 'Browser tests', 'task'],
  ['conversation-import', 'Import conversations', 'none'], ['bots', 'Bots', 'none'], ['bot-settings', 'Bot settings', 'none'],
  ['usage', 'Agent usage', 'none'], ['command-palette', 'Go to anything', 'none'],
] as const;
/** Main-window dialogs opened by their own module host through the modal helper, or mounted directly on a
 * dialog element (docs/extensions/owned-dialogs.md): [dialog id, title, captured target, host]. Same band and
 * `dialogAccessory` contract as MAIN_DIALOG_EXTRAS; each host passes its own target, never the global modal's. */
export const OWNED_DIALOG_EXTRAS = [
  ['agent-updates', 'Agent updates', 'none', 'module'], ['channel-create', 'New channel', 'none', 'module'], ['channel-settings', 'Channel settings', 'none', 'module'],
  ['github-import', 'Import from GitHub', 'project', 'module'], ['github-pr', 'Push & open pull request', 'task', 'module'], ['github-link', 'Link pull request', 'task', 'module'],
  ['sketch', 'Sketch a mockup', 'task', 'module'], ['worktree-create', 'New worktree', 'task', 'module'],
  ['command-center', 'Command center', 'task', 'direct'], ['progress-lightbox', 'Progress large view', 'task', 'direct'], ['team-model-add', 'Models for teams', 'none', 'direct'],
] as const;
/** Direct mounts of a main dialog's own view (used when the view opens the dialog itself): they reuse that
 * dialog's ID and band, so one opening never registers twice. [ledger id, reused dialog id]. */
export const OWNED_DIALOG_ALIASES = [['integrations-direct', 'integrations'], ['jev-assist-direct', 'jev-assist'], ['jev-tests-direct', 'jev-tests']] as const;
/** Module-owned or direct dialogs that never mount the band: [ledger id, title, reason]. Inspect-only in the catalog. */
export const OWNED_DIALOG_PROTECTED = [
  ['machine-link', 'Link a machine', 'Granting agents here access to another machine is a permission choice that stays host-owned (panda.machines.protected).'],
  ['worktree-cleanup', 'Settle task / Remove worktree', 'Removing a worktree folder or branch is a destructive confirmation that stays host-owned (panda.worktree.protected).'],
  ['skill-add', 'Add skills', 'Installing third-party skills into agent harnesses follows a host security scan; its verdicts and the install confirmation stay host-owned.'],
  ['extension-form', 'Extension form', "A package's own form is itself the accessory surface; another package's content is never placed inside it."],
] as const;
export type MainDialogId = typeof MAIN_DIALOG_EXTRAS[number][0] | typeof OWNED_DIALOG_EXTRAS[number][0];
export type DialogTarget = 'none' | 'task' | 'project';
/** Every dialog that accepts the band, in schema order: main modals first, then module-owned and direct dialogs. */
export const DIALOG_EXTRAS: ReadonlyArray<readonly [MainDialogId, string, DialogTarget]> = [...MAIN_DIALOG_EXTRAS, ...OWNED_DIALOG_EXTRAS.map(([id, title, target]) => [id, title, target] as const)];
/** The target kind a dialog captures; unknown IDs capture nothing. */
export const dialogTarget = (id: string): DialogTarget => DIALOG_EXTRAS.find(([dialog]) => dialog === id)?.[2] ?? 'none';
export const isOwnedDialog = (id: string): boolean => OWNED_DIALOG_EXTRAS.some(([dialog]) => dialog === id);
/** Main-window modals that never mount the band: [dialog id, title, reason]. Inspect-only in the catalog. */
export const MAIN_DIALOG_PROTECTED = [
  ['remove-project', 'Remove project', 'A destructive confirmation stays host-owned; the folder-retention explanation is not extensible.'],
  ['delete-task', 'Delete task', 'A destructive confirmation stays host-owned.'],
  ['provider-connections', 'Provider connections', 'Credential entry and sign-in are never presented beside package content.'],
  ['delete-cloud', 'Delete cloud machine', 'A destructive confirmation stays host-owned (panda.cloud.protected).'],
  ['github-behind', 'GitHub is behind this computer', 'The start-anyway recovery choice stays host-owned (panda.machines.protected).'],
  ['delete-bot', 'Delete bot', 'A destructive confirmation stays host-owned.'],
] as const;
export const DIALOG_ACTION_SURFACES = DIALOG_EXTRAS.map(([id]) => `panda.dialog.${id}.actions` as const);
export const DIALOG_DATA_SURFACES = DIALOG_EXTRAS.map(([id]) => `panda.dialog.${id}.bodyExtras` as const);
export const DIALOG_PROTECTED_LOCATION = 'panda.dialog.protected';
/** Core Settings adoption (docs/extensions/settings.md). `panda.settings.actions` is each core page's header
 * accessory and `panda.settings.context` the section list's context menu. `panda.settings.sections` holds the
 * left-column sections (reorder for all; hide only where no protected control lives); `panda.settings.controls`
 * holds eligible original rows; `panda.settings.protected` is inspect-only and never a layout location. */
export const SETTINGS_CORE_ACTION_SURFACES = ['panda.settings.actions', 'panda.settings.context'] as const;
export const SETTINGS_SECTIONS_LOCATION = 'panda.settings.sections';
export const SETTINGS_CONTROLS_LOCATION = 'panda.settings.controls';
export const SETTINGS_PROTECTED_LOCATION = 'panda.settings.protected';
/** Sections whose pages host a protected control: reorderable, never hidden, each with its reason. */
export const SETTINGS_PINNED_SECTIONS: Readonly<Record<string, string>> = {
  voice: 'Speech provider keys are saved and removed on this page.',
  agents: 'Provider credentials, harness privacy and the project-checks consent live in this section.',
  connections: 'Cloud credentials, Connect pairing and revocation, and GitHub sign-in live in this section.',
  extensions: 'Install, enable, trust and safe-mode recovery must stay one click away.',
  about: 'Updates, privacy details and support recovery must stay reachable.',
};
/** Eligible original controls: [control id, label, page]. Each runs its original Settings handler. */
export const SETTINGS_CORE_CONTROLS = [
  ['compact-mode', 'Compact conversation', 'general'], ['expand-tool-activity', 'Expand tool activity', 'general'],
  ['toggle-theme', 'Theme', 'appearance'], ['daily-wallpapers', 'Wallpapers', 'appearance'],
  ['default-provider', 'Default agent', 'agents'], ['default-model', 'Default model', 'agents'], ['agent-updates', 'Agent updates', 'agents'], ['refresh-agents', 'Refresh agents', 'agents'],
  ['agent-integrations', 'Tools & integrations', 'tools'], ['jev-settings', 'Jev', 'tools'],
  ['support', 'Help & support', 'about'],
] as const;
/** Protected Settings controls: [id, label, page, reason]. Inspect-only; no public action reaches them. */
export const SETTINGS_PROTECTED_CONTROLS = [
  ['turn-checks', 'Project checks after turns', 'agents', 'Runs project commands with your environment; the consent stays visible and host-owned.'],
  ['harness-privacy', 'Harness privacy', 'agents', 'Telemetry opt-outs are privacy consent.'],
  ['provider-credentials', 'Provider keys and sign-in', 'providers', 'Credential entry is never presented or confirmed by a package.'],
  ['routing-opt-in', 'Model routing opt-in', 'routing', 'Turning routing on starts a profiler download; it stays an explicit host choice.'],
  ['voice-key', 'Speech provider key', 'voice', 'Credential entry and removal stay host-owned.'],
  ['cloud-credentials', 'Cloud provider credentials', 'cloud', 'Credential entry and environment opt-in stay host-owned.'],
  ['remote-pairing', 'Connect pairing and revocation', 'remote', 'Device pairing consent and revocation stay host-owned.'],
  ['github-sign-in', 'GitHub sign-in', 'github', 'Sign-in stays host-owned; the token is never exposed.'],
  ['project-remove', 'Remove project', 'general', 'A destructive confirmation stays host-owned.'],
  ['extension-trust', 'Install, enable and trust packages', 'extensions', 'Grants and executable trust are host decisions.'],
  ['safe-mode', 'Disable extensions for this launch', 'extensions', 'Safe-mode recovery must always be reachable.'],
  ['app-update', 'Install update and restart', 'about', 'Update installation and restart stay host-owned recovery.'],
] as const;
/** Core pages that accept a package's shared fields (`settings[].section`); the others host protected controls or live checklists. */
export const SETTINGS_FIELD_PAGES = ['general', 'appearance', 'teams', 'schedules', 'tools', 'skills', 'rules'] as const;
/** Sidebar adoption (docs/extensions/sidebar.md). `panda.sidebar.actions` is the header accessory under New task,
 * New chat and Search; `panda.sidebar.context` is the section headings' context menu. The task and project row
 * menus stay the existing `panda.sidebar.task.context` / `panda.sidebar.project.context`. Grouping, sorting,
 * selection and every handler stay in main.ts, sidebar-sections.ts and sidebar-sort.ts. */
export const SIDEBAR_ACTION_SURFACES = ['panda.sidebar.actions', 'panda.sidebar.context', 'panda.sidebar.bots.actions', 'panda.sidebar.bots.context', 'panda.sidebar.channel.context'] as const;
/** Bots panel adoption (docs/extensions/sidebar.md#bots-panel). `panda.sidebar.bots.actions` is the panel head's
 * accessory; `panda.sidebar.bots.context` and `panda.sidebar.channel.context` are the bot and shared-channel row
 * menus. Grouping (Needs you, Pinned, Hidden), unread state, pins, the dragged order and every handler stay in
 * main.ts and sidebar-bots.ts. */
export const SIDEBAR_BOTS_LOCATION = 'panda.sidebar.bots';
export const SIDEBAR_BOTS_GROUPS_LOCATION = 'panda.sidebar.bots.groups';
export const SIDEBAR_BOTS_ROWS_LOCATION = 'panda.sidebar.bots.rows';
export const SIDEBAR_BOTS_PROTECTED_LOCATION = 'panda.sidebar.bots.protected';
/** Panel head controls: [id, label, hideable]. Reorder on the original nodes; the search field never hides. */
export const SIDEBAR_BOTS_CONTROLS = [['search', 'Search bots and channels', false], ['mark-read', 'Mark all read', true], ['create', 'New bot or channel', true]] as const;
/** Bot and channel groups in their built-in order: [id, label]. Membership comes from botsListHtml() alone. */
export const SIDEBAR_BOTS_GROUPS = [['needs-you', 'Needs you'], ['pinned', 'Pinned'], ['bots', 'Bots'], ['hidden', 'Hidden'], ['channels', 'Channels'], ['deleted-channels', 'Deleted channels']] as const;
export type SidebarBotsGroupId = typeof SIDEBAR_BOTS_GROUPS[number][0];
/** Groups that are never hidden, with the reason. They still reorder. */
export const SIDEBAR_BOTS_PINNED_GROUPS: Readonly<Partial<Record<SidebarBotsGroupId, string>>> = {
  'needs-you': 'Bots waiting for an approval or an answer stay visible.',
};
/** Bot row parts: [id, label]. A hidden settings button keeps its path: the row menu's Edit bot opens the same page. */
export const SIDEBAR_BOTS_ROW_PARTS = [['settings', 'Bot settings button'], ['role', 'Role tag'], ['time', 'Last message time']] as const;
/** Protected Bots panel behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const SIDEBAR_BOTS_PROTECTED = [
  ['bar', 'Bots bar', 'The Bots bar is the only way between the task list and the Bots panel.'],
  ['search-field', 'Search bots and channels', 'The search field is the keyboard path to every bot and channel, including hidden groups.'],
  ['status', 'Bot status signals', 'Approval, question, failure, usage-limit, working and unread marks stay on every bot row.'],
  ['selection', 'Open bot or channel', 'The open bot or channel and the group holding it stay listed, so selection never disappears.'],
  ['manual-order', 'Drag and Alt+Arrow ordering', 'Pins and the saved bot order change only through host menus, drags and keys.'],
  ['delete-confirm', 'Delete bot confirmation', 'Deleting a bot, pausing it and its confirmation stay host-owned.'],
  ['channel-membership', 'Channel membership', 'Shared-channel members, deletion and restore stay in the host menus and dialogs.'],
  ['credentials', 'Bot credentials', 'Messaging tokens and pairing codes stay in bot settings and never reach a package.'],
] as const;
export const SIDEBAR_HEADER_LOCATION = 'panda.sidebar.header';
export const SIDEBAR_PROJECTS_LOCATION = 'panda.sidebar.projects';
export const SIDEBAR_SECTIONS_LOCATION = 'panda.sidebar.sections';
export const SIDEBAR_ROWS_LOCATION = 'panda.sidebar.rows';
export const SIDEBAR_PROTECTED_LOCATION = 'panda.sidebar.protected';
/** Original header and project-row controls: [id, label]. Reorder and reversible hide on the original nodes. */
export const SIDEBAR_HEADER_CONTROLS = [['new-task', 'New task'], ['new-chat', 'New chat'], ['search', 'Search']] as const;
export const SIDEBAR_PROJECT_CONTROLS = [['project-filter', 'Filter projects'], ['sort', 'Sort and view'], ['import', 'Import conversations'], ['open-project', 'Open project']] as const;
/** Sidebar sections in their built-in order: [id, label]. Membership comes from sidebarSections() and the
 * original Chats/Tasks/project lists; this table only names them. */
export const SIDEBAR_SECTIONS = [['pinned', 'Pinned'], ['active', 'Active'], ['review', 'Finished'], ['chats', 'Chats'], ['all', 'Tasks'], ['project', 'Project tasks'], ['completed', 'Settled']] as const;
export type SidebarSectionId = typeof SIDEBAR_SECTIONS[number][0];
/** Sections that are never hidden, with the reason. They still reorder. */
export const SIDEBAR_PINNED_SECTIONS: Readonly<Partial<Record<SidebarSectionId, string>>> = {
  active: 'Running work, approvals, questions, usage limits and failures waiting on you stay visible.',
};
/** Sections that keep their place, with the reason. They still hide. */
export const SIDEBAR_FIXED_SECTIONS: Readonly<Partial<Record<SidebarSectionId, string>>> = {
  completed: 'Settled is docked at the bottom of the task list.',
};
/** Row parts: [id, label, reorderable]. Hidden parts keep their keyboard path (⌘↩ settles, the menu key opens the menu). */
export const SIDEBAR_ROW_PARTS = [['settle', 'Settle / Reopen tick', true], ['more', 'Task actions button', true], ['provider', 'Harness logo', false], ['link', 'Linked pull request or issue', false], ['branch', 'Branch name', false]] as const;
/** Protected sidebar behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const SIDEBAR_PROTECTED = [
  ['filter', 'Filter tasks', 'The task filter (/) is the keyboard path to every row, including rows in hidden sections.'],
  ['status', 'Row status and unread signals', 'Running, approval, question, usage-limit, failure and unread signals stay on every row.'],
  ['selection', 'Open task row', 'The open task row and the section holding it stay listed, so selection never disappears.'],
  ['manual-order', 'Drag and Alt+Arrow ordering', 'Manual task and folder order is saved only by host drag and keyboard input.'],
  ['delete-confirm', 'Delete task confirmation', 'A destructive confirmation stays host-owned.'],
  ['remove-confirm', 'Remove project confirmation', 'A destructive confirmation stays host-owned.'],
] as const;
/** Action dock and team progress adoption (docs/extensions/action-dock.md). `panda.team.context` is the Workers line's
 * context menu; the existing `panda.actionDock.actions`, `panda.team.actions` and `panda.agents.actions` stay
 * THREAD_ACTION_SURFACES. Dock placement, motion, the flyout's panels and every team handler stay in action-dock.ts,
 * team-progress.ts, architect.ts and main.ts. */
export const DOCK_ACTION_SURFACES = ['panda.team.context'] as const;
export const DOCK_CONTROLS_LOCATION = 'panda.actionDock.controls';
export const TEAM_CONTROLS_LOCATION = 'panda.team.controls';
export const DOCK_PROTECTED_LOCATION = 'panda.actionDock.protected';
/** The dock's groups in built-in order. The `actions-first` recipe moves `actions` ahead of `panels`; `status` stays last. */
export const DOCK_GROUPS = ['panels', 'actions', 'status'] as const;
export type DockGroupId = typeof DOCK_GROUPS[number];
/** Original dock items: [id, label, group]. Order inside their own group and reversible hide on the original nodes. */
export const DOCK_CONTROLS = [
  ['inspector', 'Toggle inspector', 'panels'], ['terminal', 'Toggle terminal', 'panels'], ['browser', 'Open browser', 'panels'],
  ['moodboards', 'Project moodboards', 'panels'], ['agents', 'Agents', 'panels'],
  ['run', 'Run project', 'actions'], ['deploy', 'Deploy', 'actions'], ['task-menu', 'Task actions', 'actions'],
] as const;
export type DockControlId = typeof DOCK_CONTROLS[number][0];
/** Dock items that never hide, with the reason. They still reorder. */
export const DOCK_PINNED_CONTROLS: Readonly<Partial<Record<DockControlId, string>>> = {
  agents: 'Workers that need attention, their approvals and the team panel are reached from Agents.',
};
/** Workers line parts: [id, label]. Hidden or reordered through one workspace attribute, never per list. */
export const TEAM_PARTS = [['toggle', 'Workers toggle'], ['menu', 'Open team button']] as const;
export type TeamPartId = typeof TEAM_PARTS[number][0];
export const TEAM_PINNED_PARTS: Readonly<Partial<Record<TeamPartId, string>>> = {
  toggle: 'The Workers line shows each turn\'s workers and what needs attention; it never hides.',
};
/** Protected dock and team behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const DOCK_PROTECTED = [
  ['stop', 'Stop task and workers', 'Stop stays in the composer and the team panel; no package control stops a task or a worker.'],
  ['approvals', 'Worker approvals and questions', 'Allow, deny and answers stay host-drawn in the composer and the worker panel.'],
  ['attention', 'Attention and running counts', 'The Workers count, its tone, the Agents badge and needs-attention states stay on every list.'],
  ['recovery', 'Worker recovery', 'Retry, resume and skip of paused or failed workers stay in the team panel.'],
  ['update', 'Restart to update', 'The restart prompt runs only while safe and belongs to the status family.'],
] as const;
/** Agent roster adoption (docs/extensions/agent-roster.md): the subagent view, the team profile library and the
 * main-window Running agents widget. `panda.roster.context` is a subagent row's context menu. Child state, streams,
 * profiles, the widget's preference and its pinned window stay in subagents.ts, team-profiles.ts and agents-dock.ts. */
export const ROSTER_ACTION_SURFACES = ['panda.roster.context'] as const;
export const ROSTER_CONTROLS_LOCATION = 'panda.roster.controls';
export const ROSTER_PROTECTED_LOCATION = 'panda.roster.protected';
/** Original roster controls: [id, label, member]. Order inside their own parent and reversible hide on the original nodes. */
export const ROSTER_CONTROLS = [
  ['back', 'Back to Subagents', 'subagents'], ['close', 'Close subagents', 'subagents'],
  ['picker', 'Choose team profile', 'profiles'], ['manage', 'Manage team profile', 'profiles'], ['create', 'Save as…', 'profiles'], ['update', 'Update profile', 'profiles'],
  ['widget', 'Running agents', 'widget'], ['pin', 'Pin widget', 'widget'],
] as const;
export type RosterControlPart = typeof ROSTER_CONTROLS[number][0];
/** Roster controls that never hide, with the reason. They still reorder. */
export const ROSTER_PINNED_CONTROLS: Readonly<Partial<Record<RosterControlPart, string>>> = {
  back: 'Back is the way from a child\'s work to the list of subagents.',
  close: 'Close (and Escape) is the way out of the subagent view.',
  picker: 'The profile picker is the only way to a saved team profile.',
  widget: 'The widget shows only when the user turns it on in Settings; that preference is the user\'s.',
};
/** Protected roster behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const ROSTER_PROTECTED = [
  ['lineage', 'Parent and child ownership', 'Which task owns a subagent and which child it came from are reported by the harness; no package re-parents, merges or moves children.'],
  ['stream', 'Open child\'s live work', 'The open child\'s response, tools and loading or failure notices stay host-drawn and keep streaming.'],
  ['stop', 'Stop subagents', 'Subagents stop with their task from the composer; no package control stops a child or a task.'],
  ['profile-delete', 'Rename and delete profile', 'Rename and delete run only from the host\'s Profile actions menu.'],
  ['widget-window', 'Pinned widget window', 'Pinning opens the auxiliary Running agents window; its contributions are panda.agentsDock.actions and its Unpin, Collapse and lifetime stay protected (panda.agentsDock.protected).'],
  ['widget-preferences', 'Widget preferences', 'Turning the widget on and keeping it on screen are the user\'s Settings choices.'],
] as const;
/** Cached usage, status and progress adoption (docs/extensions/status.md): the Agent usage panel, the dock's status
 * group, the toast, the visual progress picture-in-picture and the Jev entry. `panda.status.context` is a usage agent
 * row's context menu. Usage reads, the update prompt, notices, snapshots and test reports stay in agent-usage.ts,
 * app-updates.ts, main.ts, progress-pip.ts and jev-activity.ts. */
export const STATUS_ACTION_SURFACES = ['panda.status.context'] as const;
export const STATUS_CONTROLS_LOCATION = 'panda.status.controls';
export const STATUS_PROTECTED_LOCATION = 'panda.status.protected';
/** Original status controls: [id, label, member]. Order inside their own parent and reversible hide on the original nodes. */
export const STATUS_CONTROLS = [
  ['tabs', 'Usage views', 'usage'], ['refresh', 'Refresh usage', 'usage'],
  ['prev', 'Previous iteration', 'progress'], ['play', 'Play iterations', 'progress'], ['next', 'Next iteration', 'progress'],
  ['marks', 'Show annotations', 'progress'], ['compare', 'Compare with the previous iteration', 'progress'], ['enlarge', 'Open large view', 'progress'], ['clear', 'Clear visual history', 'progress'],
] as const;
export type StatusControlPart = typeof STATUS_CONTROLS[number][0];
/** Status controls that never hide, with the reason. They still reorder. */
export const STATUS_PINNED_CONTROLS: Readonly<Partial<Record<StatusControlPart, string>>> = {
  tabs: 'The usage views are the only way to each harness\'s limits and calendar.',
};
/** Protected status behavior: [id, label, reason]. Inspect-only; never a layout item or a public action. */
export const STATUS_PROTECTED = [
  ['update', 'Restart to update', 'The prompt never hides and restarts only when no agent runs and the user is idle; that decision is the updater\'s.'],
  ['toast-undo', 'Undo in notices', 'Undo (and ⌘Z) reverts the user\'s own last change; no package runs or dismisses it.'],
  ['toast-action', 'Notice actions', 'A notice\'s button runs what that notice offered; its text and action never cross the boundary.'],
  ['progress-clear', 'Clear visual history', 'Clearing deletes the task\'s snapshots and runs only from the card\'s own confirmation.'],
  ['usage-reads', 'Usage reads', 'Usage is read when the panel opens and on an explicit Refresh; no package reads providers, polls or starts a timer.'],
  ['usage-account', 'Account details and sign-in', 'Emails, plans, messages, costs, dashboard links and sign-in stay host-drawn and host-run.'],
] as const;
export type ActionLocation = typeof STATUS_ACTION_SURFACES[number] | typeof ROSTER_ACTION_SURFACES[number] |typeof DOCK_ACTION_SURFACES[number] | typeof SIDEBAR_ACTION_SURFACES[number] | typeof SETTINGS_CORE_ACTION_SURFACES[number] | typeof MACHINES_ACTION_SURFACES[number] | typeof CLOUD_ACTION_SURFACES[number] | typeof MOODBOARD_ACTION_SURFACES[number] | typeof WORKTREE_ACTION_SURFACES[number] | typeof PULL_ACTION_SURFACES[number] | typeof GITHUB_HUB_ACTION_SURFACES[number] | typeof BOARD_ACTION_SURFACES[number] | 'panda.workspace.header.actions' | 'panda.sidebar.footer' | 'panda.inspector.actions' | 'panda.status.items' | `panda.dialog.${MainDialogId}.actions` | typeof BTW_ACTION_SURFACES[number] | typeof DESIGN_ACTION_SURFACES[number] | typeof VIEW_ACTION_SURFACES[number] | typeof DOCUMENT_ACTION_SURFACES[number] | typeof CHANGES_ACTION_SURFACES[number] | typeof BROWSER_ACTION_SURFACES[number] | typeof TERMINAL_ACTION_SURFACES[number] | typeof SIMULATOR_ACTION_SURFACES[number] | typeof VM_ACTION_SURFACES[number] | ThreadActionLocation | WindowActionLocation;

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
  'panda.sidebar.context': [['toggle', 'Collapse or expand section']],
  'panda.sidebar.bots.context': [['pin', 'Pin bot'], ['edit', 'Edit bot'], ['duplicate', 'Duplicate bot'], ['hide', 'Hide (pause)'], ['delete', 'Delete bot…']],
  'panda.sidebar.channel.context': [['edit', 'Edit channel'], ['delete', 'Delete channel'], ['restore', 'Restore channel']],
  'panda.team.context': [['toggle', 'Show or hide workers'], ['open', 'Open team']],
  'panda.roster.context': [['open', 'Open subagent']],
  'panda.status.context': [['open', 'Show details']],
  'panda.sidebar.project.context': [['new', 'New task'], ['collapse', 'Collapse other projects'], ['reveal', 'Reveal folder'], ['remove', 'Remove project…']],
  'panda.sidebar.task.context': [['pin', 'Pin task'], ['up', 'Move up'], ['down', 'Move down'], ['beside', 'Open beside'], ['rename', 'Rename…'], ['wake', 'Schedule a wake-up…'], ['unread', 'Mark as unread'], ['branch-task', 'New task from branch…'], ['copy-branch', 'Copy branch name'], ['copy-path', 'Copy project path'], ['copy-id', 'Copy task ID'], ['stage', 'Settle'], ['delete', 'Delete task…']],
};
