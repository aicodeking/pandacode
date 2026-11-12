import { decodeHandoff, historicalProvider } from './provider-handoff';
import { ACCOUNT_SWITCH_PREFIX, accountSwitchDetail } from './account-switch-note';
import { bindThreadReordering, syncRovingFocus, threadGroupRows } from './thread-order';
import { PROJECT_LIMIT, readCollapsed, shownTasks } from './sidebar-tree';
import { COLLAPSED_SECTIONS_KEY, COMPLETED_OPEN_KEY, UNREVIEWED_KEY, readOpen, sectionOf, sidebarSections, type HeldSection } from './sidebar-sections';
import { PER_PROJECT, PROJECT_ORDER_KEY, SORT_KEY, compareManual, matchesFilter, readProjectOrder, readSort, taskComparator, type SidebarSort } from './sidebar-sort';
import './styles.css';
import { createVoiceDictation, voiceButtonHtml } from './voice-dictation';
import './design-system.css';
import './model-picker.css';
import './smooth.css';
import './wallpapers.css';
import './turn-changes.css';
import './team-progress.css';
import './council.css';
import './motion.css';
import './sidebar-tree.css';
import './inspector-bar.css';
import './message-queue.css';
import './schedules.css';
import './bot-shared-channels.css';
import './bots.css';
import './usage-limit.css';
import './document-viewer.css';
import './tool-trace.css';
import './tool-cards.css';
import './tool-images.css';
import './trace-motion.css';
import './action-dock.css';
import './inset-shell.css';
import './redesign/sidebar.css';
import './redesign/conversation.css';
import './redesign/inspector.css';
import './redesign/settings.css';
import './redesign/board.css';
import './redesign/bots.css';
import './voice-dictation.css';
import { mountActionDock, mountAgents, snapDockDuring } from './action-dock';
import { setDocumentView } from './document-viewer';
import { onQueueReorder, queuePanel, type HoldReason, type QueuedMessage } from './message-queue';
import { initWakeups, openWakeComposer, scheduledMark, schedulesVersion, wakeCommand, wakeGlyph, wakeStrip } from './schedules-thread';
import { TRACE_HEADER } from './schedules-api';
import { afterRun as turnChecksAfterRun, enabled as turnChecksEnabled, noteManualSend, setEnabled as turnChecksSetEnabled } from './turn-checks';
import { limitActive, limitBanner, resetLabel } from './usage-limit';
import { cascade, enterView, glideIn, glideOut, hidePanel, hideToast, holdDim, installDialogMotion, materializeIn, materializeOut, publishSpringEasings, releaseHold, syncPulses, revealIn, settleIn, showPanel, showToast } from './motion';
import { teamSignature, updateTeamProgress } from './team-progress';
import { installedCatalog, setTeamRecency } from './team-catalog';
import { classicTeamSetup, isTeam, namedTeams, teamDetail, TEAM_MODE_EVENT } from './team-mode';
import { renderCoordination } from './coordination-message';
import { renderTurnChanges, turnChangesFoot, changeRequest, captureChangeCards, restoreChangeCards, isCombined, mountCombinedReview } from './turn-changes';
import { SKELETON_HTML, bridgeCard, fadeInFoot, fadeInReply, holdCard, keepReplyOpen, onReplyCollapse, openReply, measureReplies, replyHtml, replyOpen, timeHtml, watchReplies } from './turn-card';
import { mountWallpapers } from './wallpapers';
import { mountSky } from './sky-window';
import { mountThreadTiles } from './thread-tiles';
import { parseSkyTime } from './sky-math';
import type { AgentEvent, BrowserAttachment, ContextUsage, FileEntry, GitStatus, Message, MessagePage, Mode, Project, Provider, ProviderId, ProviderModel, Session, TaskLink, TaskStage, ToolActivity, TurnChanges, TurnChangeDiff } from './types';
import type { BrowserPanel } from './browser';
import { call, chooseFolder, preview, subscribe } from './bridge';
import { isNetworkPath, MAX_RETRIES, NETWORK_PATH_ERROR, retryLater, toolImageCache, type ToolImageLoader } from './tool-images';
import { attachToolImages, REVEAL_LABEL } from './tool-image-viewer';
import { jjChip, showJjPanel, type JjStatus } from './jj';
import { $, button, escape, fileIcon, fileIconsReady, icon, isImeKey, markdown, markdownCache, markdownHtml, morph, showsHtml } from './dom';
import { MORE_TURNS, ROWS_MARGIN, ROW_BUDGET, drawRows, markupCache, parseRow, rowsIntact, swapRowNodes, turnIds, untouchedFields, viewIndex, windowAnchor, windowShort, windowStart, type DrawnRow } from './transcript-rows';
import { LAZY_REPLY_CHARS, drawnFrom, lazyMarkdown, prepareMarkdown, touchedRows } from './transcript-window';
import { leftRowsCache, leftViews, mountTileWindows, mountTranscriptView } from './transcript-view';
import { botAvatarHtml } from './bot-avatars';
import * as botThread from './bot-thread';
import type { Activity as BotActivity, FailoverAsk } from './bots';
import { mountExternalLinks } from './external-links';
import { mountDesktopBrand } from './brand-mark';
import { starPanda } from './star-panda';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import { providerLogo } from './provider-logos';
import { decodeToolActivity, groupToolRuns, renderToolActivity, renderToolGroup, renderToolStatus, toolStackHtml } from './tool-activity';
import { describeTool, kindIcon, summarizeTools, traceRowHtml } from './tool-trace';
import { choreograph, enterHeader, enterText, foldTurn, foldWait, readingTrace, revealRow } from './trace-motion';
import { groupTurns, mergeLeadTurns, splitLiveExchange, combineChanges, formatDuration, turnLabel, type TranscriptTurn } from './turn-activity';
import { initializeNativeAppearance } from './appearance';
import { currentTheme, setTheme } from './theme';
import { palette, SKY_SCENE } from './palette';
import { contextSummary, fallbackModel, parseContextUsage } from './model-catalog';
import { openCodeChoices, type OpenCodeModels } from './preview-opencode';
import { SECTIONS } from './settings-sections';
import { MODE_TONES, approvalMode, approvalModes, toned, type ApprovalMode } from './approval-modes';
import { syncTrayState } from './tray-motion';
import { renderTaskBoard, renderTaskDetails, taskStage } from './task-board';
import { streamMarkdown } from './streaming-markdown';
import { TerminalPanel } from './terminal-panel';
import { ProjectRunner } from './run-project';
import { captureTranscriptAnchor, followTranscriptBottom } from './transcript-scroll';
import { Subagents } from './subagents';
import { JevActivity } from './jev-activity';
import { initializeSidebarResizing } from './sidebar-resize';
import { changeUiScale, initializeUiSizing, setUiScale } from './ui-size';
import { approvalBarHtml } from './approval-bar';
import { decorateTranscript, initOrchestration, lineageSource, syncOrchestration } from './machine-orchestration';
import { createThreadFind } from './thread-find';
import { captureAccountSwitches, captureTools, fillMatchingToolBodies, fillToolBody as fillDrawnToolBody, dispatchHeld, findCounter, lastHandoff, markupShared, mergeTaskDetails, restoreAccountSwitches, restoreToolViews, rowViews, takeAccountSwitch, turnMessages, type AccountSwitchView, type HeldQueueHost, type ToolView } from './transcript-host';
import { installPointerDrag } from './pointer-drag';
import type { RemoteHost, RemoteRepoCheck, RemoteStatus, RemoteTarget } from './remote-types';
import type { RemoteStart } from './remote-progress';
import type { RoutingMode, RoutingStatus } from './model-routing';
import { CONNECT_SETUP, LOCAL, behindDialog, behindText, cancelledRemoteStart, clearRemoteStart, computerControl, computerItems, lastSeenText, remoteStart, remoteStartAttached, remoteStartStrip, startStageText, trackRemoteStart } from './remote-target';
import './cloud-agents.css';
import { SETUP_CHOICE, cloudActionItems, cloudIcon, cloudProvider, cloudStrip, deleteMachineDialog, harnessRefusal, type CloudStage, type CloudTarget } from './cloud-agents';
import { botsBarHtml, botsListHtml, botsPanelHeadHtml, markAllBotsRead, moveBot, pinnedBots, setBotPinned, storedSidebarView, storeSidebarView, syncSeen, type BotSignals, type SidebarView } from './sidebar-bots';
import { sharedChannelActionsHtml, sharedChannelComposerHtml, sharedChannelThreadHtml, type SharedChannelDetail, type SharedChannelSummary, type SharedChannelUiOptions } from './bot-shared-channels';
import { connectAgentUiActions, type AgentUiAction } from './agent-ui-actions';
import { createAgentInput, type AgentInput } from './agent-input';
import { mountSlashCommands, type SlashCommand } from './slash-commands';
import { mountFileMentions, type MentionEntry } from './file-mentions';
import { createFileTabs } from './file-tabs';
import { bindFileLinkContext, configureFileLinks, isPreviewableFile, refreshFileLinks, type FileLinkContext, type ResolvedFile } from './file-links';
import { createWorktrees } from './worktrees';
import { createGithub, githubEnabled } from './github';
import { mountUpdatePill, startAppUpdates } from './app-updates';
import { mountTextUndo } from './text-undo';
import { projectIconHtml } from './project-icons';
import { createPullView } from './github-pull';
import { createSearchPanel } from './search-panel';
import { createTokenSaver } from './token-saver-panel';
import { createCouncil } from './council-panel';
import { councilNotice } from './council';
import { MAX_IMAGES, mountPromptAttachments, type PromptImage } from './attachments';
import { attachmentChips, parseAttachments } from './message-attachments';
import { compactSublines, infoMark, installTooltips } from './tooltip';
import { isMac, shortcut } from './platform';
import { createGoalBanner, showGoalDialog, showCommandCenter, type GoalState, type GoalAction, type CommandPanel } from './command-center';
import { LEAD_RETRY, teamActive, teamHeldUntil, type TeamSnapshot, type TeamEvent, type TeamLibrary, type TeamConfig, type WorkerProfile } from './architect-types';
import type { ArchitectView } from './architect';
import { syncOverlayContext } from './overlay-client';
import { initializeAgentUpdates } from './agent-updates';
import { isChatProject, NO_PROJECT } from './chats';
import { CONTEXT_LIMIT, mainContext, parseBtw, readLinks, sideTitle, writeLink, type BtwLink } from './btw';
import { BtwPanel } from './btw-panel';
import './btw.css';
import { mountAgentsDock } from './agents-dock';
import { mountChangesView, type ChangesView } from './changes-view';
import { INSPECTOR_VIEWS, closeTab, closedViews, loadTabs, openTab, sameTabs, saveTabs, threadDefault, type InspectorView } from './inspector-tabs';
import { TailText } from './tail-text';
import { noteChangedPaths, preloadDiffsAfterPaint } from './diff-prefetch';
import { applyRestoredDraft, createCommittedDrafts } from './composer-restore';
import { errorText } from './error-text';
import { escapeClosesToast, globalErrorText, isBenignGlobalError, nextToastCount, queueToast, shouldShowGlobalError, shouldToastLiveError, toastTitle, type ToastTone } from './toast-model';
import { DISMISS_BATCH, dismissJournal, errorKey, foldErrorTurns, hiddenRunErrors, parseDismissJournal, errorSummary, groupErrors, savedErrorId, shouldAnnounce, stripErrorPrefix, type ErrorGroup, type RunHide, type ShownTurn } from './thread-errors';

/* Visual thesis: calm surfaces, system typography, yellow selection, and bamboo details.
 * Content: project navigation → conversation → contextual source review.
 * Interaction: quick drawer reveals, calm dialog entrances, coalesced text updates. */
type WorkspaceView = 'conversation' | 'board' | 'github';
/** `count`: how many identical error events this one row stands for; `dismissed`: hidden by Dismiss, Undo shows it again;
 * `savedIds`: the saved rows of those events (the event's `messageId`; an event never saved has none). */
type LiveTool = { key: string; content: string | ToolActivity; statusOnly?: boolean; commentary?: boolean; count?: number; dismissed?: boolean; savedIds?: number[] };
type LiveAccountSwitch = Message & { eventSeen?: boolean };
type Stream = { body: TailText; thought: TailText; readonly text: string; readonly thinking?: string; retainedMessageKey?: string; tools: LiveTool[]; accountSwitches: LiveAccountSwitch[]; status: string; approvals: Map<string, string>; inputs: Map<string, AgentInput>; revision: number; lastPromptAt?: number; lastResponseAt: number | null; startedAt: number; turnKey: string; omittedActivity: boolean; contextUsage?: ContextUsage; pendingChanges?: TurnChanges; earlier?: LiveEarlier };
/** The exchange a lead's wake run continues, drawn inside its live card (renderTranscript). */
type LiveEarlier = { turn: TranscriptTurn; tools: ToolActivity[] };
/** Views this platform can show; the inspector's open tabs and selection persist across launches. */
const INSPECTOR_AVAILABLE = INSPECTOR_VIEWS.filter(view => view !== 'vm' || isMac);
let inspectorTabs = loadTabs(localStorage, INSPECTOR_AVAILABLE);
/** Open files is the inspector's per-task editor view: shown only while the task has file tabs, never saved in the strip's order. */
type PanelView = InspectorView | 'file';
const INSPECTOR_TITLES: Record<InspectorView, string> = { files: 'Files', search: 'Search', changes: 'Changes', browser: 'Browser', pull: 'Pull request', simulator: 'Simulators', vm: 'Virtual machines', design: 'Design', btw: 'By the way' };
const INSPECTOR_TIPS: Partial<Record<InspectorView, string>> = { simulator: 'iOS & Android simulators', design: 'Design canvas', btw: 'By the way: a side thread' };
const INSPECTOR_ICONS: Record<InspectorView, string> = { files: 'file', search: 'search', changes: 'branch', browser: 'globe', pull: 'pull', simulator: 'phone', vm: 'monitor', design: 'sketch', btw: 'chat' };
/** Tab buttons keep the actions the old icon bar used, so every handler and shortcut still applies. */
const INSPECTOR_ACTIONS: Record<InspectorView, string> = { files: 'tab-files', search: 'tab-search', changes: 'tab-changes', browser: 'browser', pull: 'tab-pull', simulator: 'tab-simulator', vm: 'tab-vm', design: 'tab-design', btw: 'tab-btw' };
const state = {
  projects: [] as Project[], sessions: [] as Session[], providers: [] as Provider[],
  projectId: '', sessionId: '', messages: [] as Message[], messagesLoading: false, messagesError: '', streams: new Map<string, Stream>(),
  view: (({ board: 'board', github: 'github' } as Record<string, 'board' | 'github'>)[localStorage.getItem('pandacode.view') ?? ''] ?? 'conversation') as WorkspaceView, boardPanel: false,
  sidebarCollapsed: localStorage.getItem('pandacode.sidebarCollapsed') === 'true',
  query: '', inspector: false, inspectorTab: threadDefault(inspectorTabs) as PanelView,
  projectFilter: localStorage.getItem('pandacode.projectFilter') ?? '', collapsedFolders: readCollapsed(localStorage, 'pandacode.collapsedFolders'), expandedFolders: new Set<string>(),
  /** Follow-ups typed while an agent works, per task, in delivery order; mirrored from native storage. */
  queues: new Map<string, QueuedMessage[]>(), queueHolds: new Map<string, HoldReason>(), queueEditing: '', queueBusy: new Set<string>(),
  git: null as GitStatus | null, jj: null as JjStatus | null, files: [] as FileEntry[], openFolders: new Set<string>(), folderFiles: new Map<string, FileEntry[]>(), gitError: '', filesError: '', inspectorLoading: false,
  selectedFile: '', selectedContent: '', selectedKind: '' as '' | 'diff', selectedStaged: false, filePreviewLoading: false,
  browserUrl: '',
  attachments: [] as string[], drafts: new Map<string, string>(), defaultProvider: (localStorage.getItem('pandacode.defaultProvider') ?? localStorage.getItem('pandacode.provider') ?? 'claude') as ProviderId,
  browserAttachments: new Map<string, BrowserAttachment[]>(),
  moodboardAttachments: new Map<string, { id: string; projectId: string; name: string }[]>(),
  generation: 0, hasOlder: false,
  sharedChannelId: '', sharedChannelDetail: null as SharedChannelDetail | null, sharedChannelRequest: 0,
  sharedChannelDrafts: new Map<string, string>(), sharedChannelLimits: new Map<string, number>(), sharedChannelFromBottom: null as number | null, sharedChannelScrollTop: 0, sharedChannelAtBottom: true, sharedChannelPosting: new Set<string>(),
};
let renderFrame = 0;
/** Shows the open thread's scene behind the conversation (set once the sky mounts; `renderTranscript` calls it). */
let showThreadScene: (id: string | null) => void = () => {};
let navigationFrame = 0;
let settledDock: HTMLElement | null = null;
const settledResize = new ResizeObserver(() => { if (settledDock) $('#navigation').style.setProperty('--settled-height', `${settledDock.offsetHeight}px`); });
type FinishingStream = { stream: Stream; finishedAt: number; error?: string };
const finishingStreams = new Map<string, FinishingStream>();
/* Thread error state (declared early: the first render reads it). */
/** Disclosures the reader opened are remembered by scope and key, up to this many, across the live region's redraws. */
const OPEN_ERRORS_MAX = 200;
const openErrors = new Set<string>();
/** Live disclosures the reader opened, by `sessionId|key`: the saved ids of that live row (addLiveError adds later
 * ones), so its saved rows (or transient ones) open too when the live card hands off to the saved one. */
const openLiveErrors = new Map<string, Set<number>>();
/** Saved error rows a dismissal hid (deleted natively, or waiting on it); transient negative ids too. */
const hiddenErrors = new Set<number>();
/** Bumped whenever hiddenErrors changes, so a tile's cached rows redraw (drawTile). */
let hiddenErrorsRevision = 0;
/** Live errors dismissed in threads mirrored from another computer, by thread (RunHide): their events carry no saved id,
 * and the run's copies arrive with new ids when it ends, so those copies are hidden by key (hiddenRunErrors) for the
 * rest of the app session. At most RUN_HIDES_MAX in all; the oldest goes first. */
const runHides = new Map<string, RunHide[]>();
const RUN_HIDES_MAX = 200;
/** The dismissal whose Undo the toast offers; its native delete runs when the toast settles (commitDismiss). */
type PendingDismiss = { sessionId: string; saved: number[]; transient: number[]; liveTools: string[]; runHides: RunHide[]; focus: { key: string; scope: string; action: string } };
let pendingDismiss: PendingDismiss | null = null;
/** When each thread last announced each live error, by `sessionId|errorKey` (shouldAnnounce); the oldest goes past
 * OPEN_ERRORS_MAX entries. Per thread, so the same error in another thread is still told. */
const lastErrorToasts = new Map<string, number>();
// Ignore late snapshots/events for IDs removed during this window's lifetime.
const deletedSessions = new Set<string>();
let inspectorRequest = 0;
let fileRequest = 0;
let selectedFileContext: FileLinkContext | undefined;
let inspectorDiff: import('./diff-viewer').DiffViewerController | undefined;
let inspectorDiffEpoch = 0;
let transientId = -1;
const savedMarkdownSources = new WeakMap<HTMLElement, string>();
let olderMessagesRequest: { sessionId: string; generation: number; beforeId: number } | undefined;
const pendingApprovals = new Set<string>();
const configuringSessions = new Set<string>();
const modelCatalogs = new Map<ProviderId, { expires: number; pending: Promise<ProviderModel[]> }>();
let slashPicker: ReturnType<typeof mountSlashCommands> | undefined;
let fileMentionPicker: ReturnType<typeof mountFileMentions> | undefined;
let boardMentionPicker: ReturnType<typeof mountFileMentions> | undefined;
let modelPickerCleanup: (() => void) | undefined;
let projectPickerCleanup: (() => void) | undefined;
let choiceMenuCleanup: (() => void) | undefined;
let choiceMenuAnchor: HTMLElement | undefined;
let menuEpoch = 0;
let pendingMenuOpen: { anchor: HTMLElement; release: () => void } | undefined;
let openingProjectForTask: { id: string; generation: number } | undefined;
let creatingTask = false;
let openingSupport = false;
let activityTimer = 0;
let workTimer = 0;
let channelWorkingLabelTimer = 0;
let browserPanel: BrowserPanel | undefined, browserWanted = false;
let simulatorPanel: ReturnType<typeof import('./simulator').mountSimulator> | undefined, simulatorLoading: Promise<void> | undefined;
let vmPanel: ReturnType<typeof import('./vm-panel').mountVmPanel> | undefined, vmLoading: Promise<void> | undefined;
let designPanel: ReturnType<typeof import('./design-canvas').mountDesignCanvas> | undefined, designLoading: Promise<void> | undefined;
let progressPip: import('./progress-pip').ProgressPip | undefined, progressPipLoading: Promise<void> | undefined;
let browserLifecycle = Promise.resolve();
let browserOwner = '', browserRevision = 0, inspectorSuppressed = false;
/** The user's last explicit inspector toggle; a task without saved panel state follows it. */
let inspectorChosen = true;
type ThreadPanel = { workspace: string; open: boolean; tab: typeof state.inspectorTab; folders: string[]; file: string; kind: typeof state.selectedKind; staged: boolean; context?: FileLinkContext; browserUrl: string };
const threadPanels = new Map<string, ThreadPanel>();
const teams = new Map<string, TeamSnapshot | null>();
let architectView: ArchitectView | undefined;
let architectLoading: Promise<ArchitectView> | undefined;
let architectSetupCleanup: (() => void) | undefined;
let jevTestCleanup: (() => void) | undefined;
let jevTestRequest = 0;
let architectSetupRequest = 0;
let overlayOpenRequest = 0;
let jevDecisionsEnabled = false;
function setJevAvailability(enabled: boolean): void {
  jevDecisionsEnabled = enabled;
  architectView?.setAssistEnabled(enabled);
}
void call<import('./jev').JevConfiguration>('jev_configuration').then(config => setJevAvailability(Boolean(config.decisionsEnabled))).catch(() => { /* Optional integrations never block startup. */ });
window.addEventListener('pandacode:jev-settings', event => setJevAvailability(Boolean((event as CustomEvent<import('./jev').JevConfiguration>).detail.decisionsEnabled)));
async function ensureArchitectView(): Promise<ArchitectView> {
  return architectLoading ??= import('./architect').then(({ ArchitectView }) => {
    architectView = new ArchitectView({ setup: anchor => run(showArchitectSetup(anchor)), loadModels, updated: onArchitect, report, onFork: forkAtMessage, fileContext: sessionId => ({ projectId: state.projectId, sessionId }), assist: (sessionId, kind) => run(openJevAssist(kind, sessionId)), remote: sessionId => Boolean(state.sessions.find(task => task.id === sessionId)?.remoteDevice) });
    architectView.setAssistEnabled(jevDecisionsEnabled);
    $('#subagents-host').before(architectView.host);
    architectView.setTask(state.sessionId, teams.get(state.sessionId) ?? null, state.providers);
    return architectView;
  });
}
function onArchitect(team: TeamEvent): void {
  if (deletedSessions.has(team.sessionId)) return;
  if ('removed' in team) { teams.set(team.sessionId, null); if (team.sessionId === state.sessionId) { architectView?.setTask(team.sessionId, null, state.providers); renderComposer(); } return; }
  const current = teams.get(team.sessionId);
  if (current && current.revision > team.revision) return;
  // Pauses and failures the user did not ask for would otherwise only show inside the panel.
  // A Council refusal is written for the lead; the user gets its plain notice (and the card), never the refusal itself.
  // Asking is announced once, by the composer's live region, so it gets no toast as well.
  if (team.sessionId === state.sessionId && team.error && team.error !== current?.error && team.councilStatus?.state !== 'asking' && !/^Team (paused|stopped)\./.test(team.error) && !LEAD_RETRY.test(team.error)) notify(councilNotice(team) ?? team.error);
  const wasActive = teamActive(current);
  teams.set(team.sessionId, team);
  const task = state.sessions.find(s => s.id === team.sessionId), taskState = `${task?.status}:${task?.taskStage}`;
  if (task && teamActive(team)) { task.status = 'running'; task.taskStage = 'in_progress'; }
  if (task && !teamActive(team) && !state.streams.has(task.id)) task.status = 'idle';
  void ensureArchitectView().then(view => { if (!deletedSessions.has(team.sessionId)) view.update(team); }).catch(report);
  // A snapshot that only moved its revision shows nothing new: no composer, thread or sidebar paint.
  if (current && teamSignature(current) === teamSignature(team) && taskState === `${task?.status}:${task?.taskStage}`) return;
  if (team.sessionId === state.sessionId) { scheduleTeamRender(wasActive !== teamActive(team)); if (!current) syncTeamRows(); }
  scheduleNavigation();
}
/** Team snapshots can arrive many times a frame: the composer (and thread worker lines) paint once per frame. */
let teamFrame = 0, teamComposer = false;
function scheduleTeamRender(composer: boolean): void {
  teamComposer ||= composer;
  teamFrame ||= requestAnimationFrame(() => {
    const full = teamComposer; teamFrame = 0; teamComposer = false;
    if (full) renderComposer(); else refreshModelLabels();
  });
}
async function loadTeam(id: string): Promise<TeamSnapshot | null> {
  const known = teams.has(id), before = teams.get(id);
  // A task on another computer shows the team its host runs; older hosts have none to show.
  const loaded = state.sessions.find(task => task.id === id)?.remoteDevice ? await call<TeamSnapshot | null>('remote_team', { sessionId: id }).catch(() => null) : await call<TeamSnapshot | null>('architect_get', { sessionId: id });
  if (deletedSessions.has(id)) return null;
  // An update or a removal that arrived during the fetch is newer than this snapshot.
  if (teams.has(id) !== known || teams.get(id) !== before) return teams.get(id) ?? null;
  teams.set(id, loaded);
  // A remembered thread keeps its answer: coming back to it must not wait for its team again (selectSession).
  if (teams.size > 64) { const old = [...teams].find(([key, value]) => key !== state.sessionId && !threadPages.has(key) && !teamActive(value)); if (old) teams.delete(old[0]); }
  if (loaded) await ensureArchitectView();
  if (id === state.sessionId) architectView?.setTask(id, loaded, state.providers);
  return loaded;
}
/** A mirror's host reports changed worker rows (`team` events) and run ends: reread its team. */
const mirrorTeamReads = new Map<string, number>();
function refreshMirrorTeam(id: string): void {
  if (mirrorTeamReads.has(id)) return;
  mirrorTeamReads.set(id, window.setTimeout(() => {
    mirrorTeamReads.delete(id);
    void call<TeamSnapshot | null>('remote_team', { sessionId: id }).then(team => {
      if (team) onArchitect(team); else if (teams.get(id)) onArchitect({ sessionId: id, removed: true });
    }).catch(() => undefined);
  }, 300));
}
async function showArchitectSetup(anchor: HTMLElement): Promise<void> {
  if (architectSetupCleanup) { architectSetupCleanup(); return; }
  const task = session(); if (!task) return;
  if (task.remoteDevice) { notify(mirrorTeamNote(task)); return; }
  closeMenus();
  const request = ++architectSetupRequest;
  const { openArchitectSetup } = await import('./architect');
  if (request !== architectSetupRequest || !anchor.isConnected || task.id !== state.sessionId) return;
  architectSetupCleanup = openArchitectSetup(anchor, async () => {
    const [team, library] = await Promise.all([loadTeam(task.id), call<TeamLibrary>('architect_profiles')]);
    return { task, team, library, providers: state.providers, loadModels,
      save: async (config, architect, profileId) => {
        if (task.id !== state.sessionId) throw new Error('Select this task again to change its team.');
        const saved = await call<TeamSnapshot | null>('architect_configure', { sessionId: task.id, config, architect, profileId });
        // Completion may already have applied the pending setup before this IPC
        // reply arrives. Honor the newer event instead of restoring stale state.
        onArchitect(saved ?? { sessionId: task.id, removed: true });
        if (task.id === state.sessionId) architectSetupCleanup?.();
        await reloadSessions();
        if (task.id === state.sessionId) {
          renderComposer();
          notify(teams.get(task.id)?.pendingSetup ? 'Team switch queued for the next architect turn. Existing workers keep their models.' : config ? 'Team setup saved for this and new tasks.' : 'New tasks will use a single agent. Saved profiles are kept.');
        }
      },
    };
  }, () => { architectSetupCleanup = undefined; });
}
/** Team mode needs no setup: the task's selected model leads, and the lead (or the user's prompt) picks worker models. */
const TEAM_TIP = 'Your model leads and starts agents. Name workers in your prompt to pick them.';
const routeIcon = (path: string) => `<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${path}</svg>`;
/** The Team menu's team kinds. Each one is Panda Router's global mode, so the next task pre-checks the kind used last. */
/** The kinds are one global setting: every automatic team follows it, and new tasks start with it. */
const TEAM_KINDS_HINT = 'Worker models for every team · remembered', TEAM_KINDS_OFF_HINT = 'Worker models for every team · turns routing on';
const TEAM_KINDS: { id: RoutingMode; label: string; description: string; leading: string }[] = [
  { id: 'cheapest', label: 'Cheap team', description: 'Cheapest model likely to pass', leading: routeIcon('<path d="M3 12V4a1 1 0 0 1 1-1h8l9 9-9 9z"/><circle cx="7.5" cy="7.5" r="1.2"/>') },
  { id: 'balanced', label: 'Balanced team', description: 'Best value for the cost', leading: routeIcon('<path d="M12 4v16M7 20h10M5 8h14M5 8l-3 6a3 3 0 0 0 6 0zM19 8l-3 6a3 3 0 0 0 6 0z"/>') },
  { id: 'quality', label: 'Best team', description: 'Strongest model for each worker', leading: icon('spark') },
];
/** The task's team as the Team button names it: off, a named agent team, a routed kind, or a team whose lead picks models. */
function teamState(s: Session): { id: string; label: string } {
  const team = teams.get(s.id);
  if (!team) return { id: 'off', label: 'Team' };
  if (team.config.rosterOnly) return { id: 'named', label: team.config.name?.trim() || 'Team' };
  const kind = team.config.auto && routing?.enabled ? TEAM_KINDS.find(k => k.id === routing?.mode) : undefined;
  return kind ?? { id: 'lead', label: 'Team' };
}
const teamButtonHtml = (s: Session) => `${teamToggles.has(s.id) ? '<span class="support-spinner" aria-hidden="true"></span>' : icon('team')}<span class="sr-only">${escape(teamState(s).label)}</span>${icon('down')}`;
/** The Team button's tooltip leads with its state, since the button is only an icon. */
const teamName = (s: Session) => teams.get(s.id) ? `${teamState(s).label}: on` : 'Team: off';
const teamTip = (s: Session) => `${teamName(s)}. ${TEAM_TIP}`;
/** A tray icon's one tip, state first; the description also reaches assistive tech. */
const modeTip = (mode: ApprovalMode) => `${mode.label}: ${mode.description}`;
/** The mode button's name says what it is; its visible (sr-only) label stays the mode alone. */
const modeName = (mode: ApprovalMode) => `Mode: ${mode.label}`;
const modeFaceHtml = (mode: ApprovalMode) => `${icon(mode.icon)}<span class="sr-only">${escape(mode.label)}</span>${icon('down')}`;
const trayStateChanged = () => { const id = state.sessionId; if (id) syncTrayState(id, teams.has(id)); };
/** Team opens the team menu, or with Settings → Classic team setup opens Architect & workers. */
function teamButton(s: Session): string {
  if (s.remoteDevice) return '';
  const on = Boolean(teams.get(s.id)), busy = teamToggles.has(s.id);
  return classicTeamSetup()
    ? `<button type="button" class="composer-team-button" data-action="architect-setup" aria-label="Architect & workers" aria-description="${on ? 'On' : 'Off'}" aria-pressed="${on}" aria-busy="${busy}" ${busy ? 'disabled' : ''} data-tip="Architect & workers: ${on ? 'on' : 'off'}">${icon('team')}<span class="sr-only">Team</span></button>`
    : `<button type="button" id="team-trigger" class="composer-team-button" data-action="team-menu" aria-description="${escape(teamTip(s))}" data-tip="${escape(teamTip(s))}" aria-label="${escape(teamName(s))}" aria-haspopup="dialog" aria-expanded="false" aria-busy="${busy}" ${on ? 'data-on' : ''}>${teamButtonHtml(s)}</button>`;
}
/** Panda Router's global mode, cached for the Team button and menu; Settings announces every status it shows. */
let routing: RoutingStatus | null = null;
/** Every change of `routing` (a Team menu pick, a Settings status) takes a ticket; a reply lands only
 * while no newer change has started. Reads (status, prepare) take none: they land only if no change
 * started after them and none is pending, so a read never overrides a change. */
let routingTicket = 0, routingConfiguring = 0, routingFailedAt = 0;
let routingLoad: Promise<RoutingStatus | null> | null = null;
/** A Settings status that arrived during a Team menu configure; applied if that configure fails. */
let routingMissed: RoutingStatus | null = null;
const ROUTING_RETRY_MS = 3000;
/** Redraws only the Team button's label, so the prompt keeps its focus and caret. */
function syncTeamButton(): void {
  const trigger = document.querySelector<HTMLElement>('#team-trigger'), s = session(); if (!trigger || !s) return;
  const html = teamButtonHtml(s);
  if (trigger.innerHTML !== html) trigger.innerHTML = html;
  trigger.setAttribute('aria-label', teamName(s));
  trigger.toggleAttribute('data-on', Boolean(teams.get(s.id)));
  trigger.setAttribute('aria-busy', String(teamToggles.has(s.id)));
  trigger.dataset.tip = teamTip(s); trigger.setAttribute('aria-description', teamTip(s));
  trayStateChanged();
}
function applyRouting(ticket: number, next: RoutingStatus): boolean {
  if (ticket !== routingTicket) return false;
  routing = next; syncTeamButton(); return true;
}
/** A read started at `ticket` lands only if no change started since and none is pending. */
function applyRead(ticket: number, next: RoutingStatus): void {
  if (!routingConfiguring) applyRouting(ticket, next);
}
/** Reads the status once at a time; every caller shares the request in flight. */
function loadRouting(): Promise<RoutingStatus | null> {
  return routingLoad ??= (async () => {
    const ticket = routingTicket;
    try {
      const next = await call<RoutingStatus>('model_routing_status');
      routingFailedAt = 0; applyRead(ticket, next); return next;
    } catch (cause) { routingFailedAt = Date.now(); console.warn('Model routing status is unavailable', cause); return null; }
    finally { routingLoad = null; }
  })();
}
/** Until a status has loaded, a local task asks again when it renders (no request once loaded). */
function retryRouting(s: Session | undefined): void {
  if (!routing && s && !s.remoteDevice && Date.now() - routingFailedAt >= ROUTING_RETRY_MS) void loadRouting();
}
// Settings' status is newer than anything in flight, except a configure started here, whose reply follows.
window.addEventListener('pandacode:routing', event => {
  const next = (event as CustomEvent<RoutingStatus>).detail;
  if (routingConfiguring) routingMissed = next; else applyRouting(++routingTicket, next);
});
window.addEventListener('focus', () => void loadRouting());
void loadRouting();
/** Turns routing on in `mode`; a refusal throws, so the menu shows it. */
async function configureRouting(mode: RoutingMode): Promise<void> {
  if (routing?.enabled && routing.mode === mode) return;
  const ticket = ++routingTicket;
  routingConfiguring++;
  let saved = false;
  try { applyRouting(ticket, await call<RoutingStatus>('model_routing_configure', { enabled: true, mode })); saved = true; }
  finally {
    routingConfiguring--;
    // A Settings status that arrived meanwhile: re-read after a save (it may be newer), apply it after a failure.
    if (!routingConfiguring && routingMissed) {
      const missed = routingMissed; routingMissed = null;
      if (saved) void loadRouting(); else applyRouting(++routingTicket, missed);
    }
  }
}
/** No team, a team whose lead picks models, or a team whose workers Panda Router picks by kind (the global mode). */
async function showTeamMenu(anchor: HTMLElement): Promise<void> {
  const task = session(); if (!task) return;
  if (task.remoteDevice) { notify(mirrorTeamNote(task)); return; }
  if (!teams.has(task.id)) await loadTeam(task.id);
  const { id: current, label } = teamState(task), team = teams.get(task.id);
  const routed = routing?.enabled === true;
  // A kind replaces a named agent team, and turns routing on when it is off (or its status is unknown).
  const note = current === 'named' ? `Replaces ${label}` : '';
  const items = [
    { id: 'off', label: 'No team', description: 'A single agent', leading: icon('bot') },
    ...(current === 'named' ? [{ id: 'named', label, description: 'Agent team', leading: toned(icon('team'), 'team') }] : []),
    ...(!routed || current === 'lead' ? [{ id: 'lead', label: 'Team', description: 'The lead picks models', leading: toned(icon('team'), 'team') }] : []),
    ...TEAM_KINDS.map((k, index) => ({ id: k.id, label: k.label, description: note || k.description, leading: toned(k.leading, 'team'), heading: index ? undefined : routed ? TEAM_KINDS_HINT : TEAM_KINDS_OFF_HINT })),
  ].map(item => ({ ...item, selected: item.id === current }));
  // A team turned on here redraws the composer once the menu closes, so a routing error can still show in it.
  let turnedOn = false;
  await showChoices(anchor, { title: 'Team', width: 320, items, afterClose: () => { if (turnedOn && task.id === state.sessionId) renderComposer(); }, onSelect: async id => {
    if (id === current || id === 'named') return;
    if (id === 'off') { await setTeam(task, false); return; }
    // The team turns on first, so a refusal leaves the global mode alone; an automatic team only changes kind.
    const keep = team && !team.config.rosterOnly && team.config.auto;
    if (!keep) { if (!await setTeam(task, true, false)) return; turnedOn = true; }
    if (id === 'lead') return;
    await configureRouting(id as RoutingMode);
    if (!routed) prepareModelRouting();
  } });
}
/** An automatic team's config with the current installed models (the capped roster for the lead,
 * the full catalog for Panda Router), keeping the limits of `base` or the last saved setup. */
async function autoTeamConfig(base?: TeamConfig): Promise<TeamConfig> {
  const [library, { roster, catalog }] = await Promise.all([base ? Promise.resolve(null) : call<TeamLibrary>('architect_profiles'), installedCatalog(state.providers, loadModels)]);
  const limits = base ?? library?.lastSetup?.config;
  return { auto: true, workers: roster, catalog, maxParallel: limits?.maxParallel ?? 0, maxRounds: limits?.maxRounds ?? 8, maxAssignments: limits?.maxAssignments ?? 24, workspace: 'shared', summaryLimit: limits?.summaryLimit ?? 3072 };
}
/** Warms Panda Router's profiler when a team starts; failures only reach the console. */
function prepareModelRouting(): void {
  void loadRouting()
    .then(status => {
      // The cached status may be newer than the shared read this joined.
      if (!(routing ?? status)?.enabled) return;
      const ticket = routingTicket;
      return call<RoutingStatus>('model_routing_prepare').then(next => applyRead(ticket, next));
    })
    .catch(cause => console.warn('Model routing could not prepare', cause));
}
const teamToggles = new Set<string>();
const mirrorTeamNote = (task: Session) => `Teams for this task are set up on ${task.remoteDevice?.name ?? 'the other computer'}.`;
/** Turns an automatic team on (replacing any other team) or the task's team off; false when nothing changed.
 * While it saves, the task is configuring: the Team button shows it, and sending and queue dispatch wait. */
async function setTeam(task: Session, on: boolean, render = true): Promise<boolean> {
  if (configuringSessions.has(task.id)) return false;
  teamToggles.add(task.id); configuringSessions.add(task.id);
  try {
    // In place: the Team menu stays anchored to the button while it applies.
    if (task.id === state.sessionId) syncTeamButton();
    let config: TeamConfig | null = null;
    if (on) {
      prepareModelRouting();
      config = await autoTeamConfig();
    }
    if (task.id !== state.sessionId) return false;
    const saved = await call<TeamSnapshot | null>('architect_configure', { sessionId: task.id, config, architect: null, profileId: null });
    onArchitect(saved ?? { sessionId: task.id, removed: true });
    await reloadSessions();
    teamToggles.delete(task.id); configuringSessions.delete(task.id);
    // "Turn on for new threads": a team starting on a thread with no messages yet starts Council with it.
    if (on && saved && task.id === state.sessionId && !state.messages.length) void council.enableForNewThread(task.id);
    if (task.id === state.sessionId) { if (render) renderComposer(); else syncTeamButton(); }
    return true;
  } finally {
    // A failed save keeps the menu open with its error, so only the button is redrawn.
    if (teamToggles.delete(task.id) && task.id === state.sessionId) syncTeamButton();
    configuringSessions.delete(task.id);
    run(dispatchQueue(task.id));
  }
}
const ACTIVITY_WINDOW = 24 * 60 * 60 * 1000;
/** Sort arrows for the sidebar's sort and view menu. */
const SORT_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 4v16m-3-3 3 3 3-3M17 20V4m-3 3 3-3 3 3"/></svg>';
const $app = document.querySelector<HTMLDivElement>('#app')!;
$app.innerHTML = `<div class="workspace" data-tauri-drag-region>
  <aside id="workspace-sidebar" class="sidebar" aria-label="Projects and tasks">
    <div class="brand" data-tauri-drag-region><button type="button" class="brand-name" aria-label="Replay PandaCode animation" data-tauri-drag-region="false">PandaCode</button>${button('view-menu', 'Workspace view: Conversation', 'thread', 'view-menu', 'id="view-menu" aria-haspopup="menu" aria-expanded="false"')}</div>
    <div class="sidebar-actions"><button class="new-task-button" data-action="new-task">${icon('plus')}<span>New task</span><kbd>${shortcut('N')}</kbd></button><button class="new-chat-button" data-action="new-chat" title="New chat (no project)">${icon('chat')}<span>New chat</span></button><button class="search-trigger" data-action="search">${icon('search')}<span>Search</span><kbd>${shortcut('K')}</kbd></button></div>
    <div class="sidebar-projects"><button id="project-filter" class="project-filter" data-action="filter-projects" aria-label="Filter projects" aria-haspopup="dialog" aria-expanded="false"><span data-filter-label>All projects</span>${icon('down')}</button><button id="sidebar-sort" class="icon-button sidebar-sort" data-action="sidebar-sort" aria-label="Sort and view" title="Sort and view" aria-haspopup="menu" aria-expanded="false">${SORT_ICON}</button>${button('import-conversations', 'Import conversations', 'download', 'import-trigger')}${button('add-project', 'Open project', 'plus')}</div>
    <div class="sidebar-search">${icon('search')}<input id="sidebar-filter" type="search" aria-label="Filter tasks" placeholder="Filter tasks" autocomplete="off" spellcheck="false" maxlength="200" aria-keyshortcuts="/"><button type="button" class="sidebar-search-clear" data-action="clear-sidebar-filter" tabindex="-1" aria-label="Clear filter" title="Clear filter">${icon('close')}</button></div>
    <div class="navigation-frame"><div id="navigation" class="navigation"></div></div>
    <section id="sidebar-bots-panel" class="bots-panel" aria-label="Bots"></section>
    <div id="sidebar-bots" class="sidebar-bots"></div>
    <div class="sidebar-bottom">${button('support', 'Help & support', 'help', 'support-button', 'id="support-button"')}${button('agent-usage', 'Agent usage', 'activity', '', 'id="agent-usage-button"')}<button data-action="settings" title="Settings (${shortcut(',')})" aria-label="Settings">${icon('settings')}</button>${starPanda()}<button data-action="toggle-theme" id="theme-toggle" aria-label="Dark mode" aria-pressed="false"></button></div>
  </aside>
  <main class="main-pane">
    <header class="workspace-header" data-tauri-drag-region="deep"><div class="header-leading" data-tauri-drag-region>${button('toggle-sidebar', 'Hide sidebar', 'sidebar', 'sidebar-toggle', 'id="sidebar-toggle" aria-controls="workspace-sidebar" aria-expanded="true" aria-keyshortcuts="Meta+B Control+B"')}<span id="view-divider" class="header-divider" aria-hidden="true" hidden></span><div id="breadcrumb" class="breadcrumb" data-tauri-drag-region></div></div><div class="header-actions">${preview ? '<span class="preview-status">Browser preview · sample data</span>' : ''}</div><div id="agents-dock-host"></div><div id="action-dock" class="action-dock" role="toolbar" aria-label="Workspace actions" aria-orientation="vertical" data-tauri-drag-region="false"><div class="action-dock-group" data-group="panels">${button('toggle-inspector', 'Toggle inspector', 'panel', 'active', 'id="inspector-toggle" aria-keyshortcuts="Meta+Shift+B Control+Shift+B"', `Toggle inspector (${shortcut('B', true)})`)}${button('terminal', 'Toggle terminal', 'terminal', '', 'id="terminal-toggle" aria-controls="terminal-drawer" aria-expanded="false" aria-keyshortcuts="Meta+J Control+J"', `Toggle terminal (${shortcut('J')})`)}${button('browser', 'Open browser', 'globe', '', 'id="browser-toggle"')}${button('moodboards', 'Project moodboards', 'images')}<button type="button" id="agents-toggle" class="agents-toggle" aria-label="Agents" aria-haspopup="dialog" aria-expanded="false" aria-controls="agents-flyout" data-dock-notip hidden>${icon('team')}<b class="dock-badge" aria-hidden="true" hidden></b></button></div><div class="action-dock-group" data-group="actions"><button type="button" class="header-run" id="run-project-button" data-action="run-project" aria-label="Run project" title="Run pandacode-run.sh" hidden>${icon('play')}<span>Run</span></button>${button('deploy', 'Deploy', 'upload', '', 'id="deploy-button" aria-haspopup="dialog"')}${button('task-menu', 'Task actions', 'more', '', 'id="task-menu-trigger" aria-haspopup="dialog" aria-expanded="false"')}</div><div class="action-dock-group" data-group="status"><button type="button" id="update-status" class="update-status" hidden>${icon('refresh')}<span>Restart to update</span></button></div></div><div id="agents-flyout" class="agents-flyout" data-tauri-drag-region="false" hidden><div id="subagents-host" class="subagents-host" hidden></div><div id="lineage-host" class="lineage-host"></div></div></header>
    <div class="work-area"><section id="project-board" class="project-board" aria-label="Project board" hidden></section><section id="github-hub" aria-label="GitHub" hidden></section><section class="conversation-pane"><div id="task-details-heading" class="task-details-heading" hidden></div><aside id="progress-pip" class="progress-pip" aria-label="Visual progress" hidden></aside><div id="transcript" class="transcript" role="log" aria-label="Conversation" aria-live="off"></div><div id="composer-area" class="composer-area"></div><div id="composer-live" class="sr-only" role="status" aria-live="polite"></div></section></div>
    <div id="terminal-drawer" class="terminal-drawer" hidden><div class="drawer-heading"><span>${icon('terminal')}<span id="terminal-project" class="muted"></span></span><div class="terminal-tabs" role="tablist" aria-label="Terminal tabs"></div><div class="terminal-heading-actions"><button class="icon-button" data-terminal-action="new" aria-label="New terminal" title="New terminal">${icon('plus')}</button><button class="icon-button" data-terminal-action="minimize" aria-label="Minimize terminal" title="Minimize terminal">${icon('minimize')}</button><button class="icon-button" data-terminal-action="close" aria-label="Close terminal" title="Close terminal" aria-haspopup="dialog">${icon('close')}</button></div></div><div id="terminal-host"></div></div>
  </main>
  <section id="settings-page" aria-label="Settings" hidden></section>
  <aside id="inspector" class="inspector" aria-label="Project inspector"><div class="inspector-strip"><nav class="inspector-tabs" role="tablist" aria-label="Panel views"><div class="inspector-tab file-panel-tab" data-view="file" hidden><button class="inspector-tab-button" role="tab" aria-selected="false" tabindex="-1" data-action="tab-open-files" aria-label="Open files" title="Open files">${icon('file')}<span class="inspector-tab-label">Open files</span></button>${button('close-inspector-tab', 'Close open files', 'close', 'inspector-tab-close', 'data-view="file" tabindex="-1"')}</div>${INSPECTOR_AVAILABLE.map(view => `<div class="inspector-tab" data-view="${view}" hidden><button class="inspector-tab-button" role="tab" aria-selected="false" tabindex="-1" data-action="${INSPECTOR_ACTIONS[view]}" aria-label="${INSPECTOR_TITLES[view]}" title="${escape(INSPECTOR_TIPS[view] ?? INSPECTOR_TITLES[view])}">${icon(INSPECTOR_ICONS[view])}<span class="inspector-tab-label">${INSPECTOR_TITLES[view]}</span>${view === 'changes' ? '<span id="changes-count" class="inspector-tab-count"></span>' : ''}</button>${button('close-inspector-tab', `Close ${INSPECTOR_TITLES[view]}`, 'close', 'inspector-tab-close', `data-view="${view}" tabindex="-1"`)}</div>`).join('')}${button('inspector-add-tab', 'Open a view', 'plus', 'inspector-tab-add', 'aria-haspopup="dialog"')}</nav><h2 id="inspector-title" class="sr-only">${INSPECTOR_TITLES[inspectorTabs.selected]}</h2><div class="inspector-strip-actions">${button('refresh-inspector', 'Refresh project', 'refresh', '', 'id="inspector-refresh"')}${button('toggle-inspector', 'Hide inspector', 'panel', 'inspector-hide')}</div></div><div id="inspector-content" class="inspector-content"></div><section id="browser-panel" class="browser-panel" aria-label="Browser" hidden></section><section id="simulator-panel" class="simulator-panel" aria-label="Simulators" hidden></section><section id="vm-panel" class="vm-panel" aria-label="Virtual machines" hidden></section><section id="design-panel" class="design-panel" aria-label="Design" hidden></section><section id="file-panel" class="file-panel" aria-label="Open files" hidden><div id="file-tabs" class="file-tabs" role="tablist" aria-label="Open files" hidden></div><section id="file-view" class="file-view" role="tabpanel" aria-label="Open file" hidden></section></section></aside>
</div><div id="toast" class="toast" hidden></div><dialog id="dialog"></dialog>`;
mountDesktopBrand($('.brand-name'));
// Design-system gallery (src/redesign/gallery.ts): browser preview only, with `?ds`.
if (preview && new URLSearchParams(location.search).has('ds')) void import('./redesign/gallery').then(gallery => gallery.mountGallery());
mountAgentsDock(document.querySelector<HTMLElement>('#agents-dock-host')!, { openTask: id => run((async () => { await reloadSessions(); await selectSession(id, true); })()) });
publishSpringEasings();
syncPulses();
mountActionDock($('#action-dock'));
installDialogMotion(document.querySelector<HTMLDialogElement>('#dialog')!);
const terminalPanel = new TerminalPanel($('#terminal-drawer'), $('#terminal-host'), report);
const projectRunner = new ProjectRunner({
  context: () => project() ? workspaceContext() : undefined,
  start: requestId => terminalPanel.runScript(requestId),
  navigate: openRunPreview,
  notify, notifyError,
});
let sidebarDragging = false, orderingBusy = false;
/** The open thread stays in the section it was opened from, so its row does not jump from under the click. */
/** False until the first list_projects settles: neither empty state draws before it, so startup never flashes "Choose a project". */
let projectsListed = false;
/** Startup still running: a New task pressed now waits for it, or it would find no projects and boot would then select another thread over it. */
let bootPending: Promise<void> | undefined;
let sectionHold: { id: string; section: HeldSection } | undefined, completedOpen = readOpen(localStorage, COMPLETED_OPEN_KEY);
const collapsedSections = readCollapsed(localStorage, COLLAPSED_SECTIONS_KEY);
/** Settled lists its newest rows first, then pages in more on request. */
const COMPLETED_FIRST = 10, COMPLETED_PAGE = 25;
let completedShown = COMPLETED_FIRST;
let sidebarSort: SidebarSort = readSort(localStorage);
let projectOrder: string[] = readProjectOrder(localStorage);
/** "3:45 PM" from "Resets 3:45 PM"; nothing when the harness did not report a reset time. */
function limitReset(until: number | null | undefined, now: number): string {
  return until ? resetLabel(until, now).replace(/^Resets /, '') : '';
}
/** A last run that ended badly: an error, or cut short by a restart. */
const FAILED_STATUS = new Set(['error', 'interrupted']);
/** Long branch names keep their tail ("…ant-search"), where branches usually differ. */
function branchLabel(branch: string): string {
  const chars = [...branch], tail = chars.length > 14 ? chars.slice(-8).join('') : '';
  return `<span class="task-branch-name"><span class="task-branch-head">${escape(tail ? chars.slice(0, -8).join('') : branch)}</span>${tail ? `<span class="task-branch-tail">${escape(tail)}</span>` : ''}</span>`;
}
/** Threads whose turn finished out of sight (shown unread until opened); read on first draw. */
let unreviewed: Set<string> | undefined;
function saveUnreviewed(): void { try { localStorage.setItem(UNREVIEWED_KEY, JSON.stringify([...unreviewed ?? []])); } catch { /* per-launch only */ } }
bindThreadReordering($('#navigation'), {
  busy: () => orderingBusy,
  dragging: active => { sidebarDragging = active; if (!active) renderNavigation(); },
  reorder: (ids, focus) => run(reorderThreads(ids, focus)),
  reorderFolders: (ids, focus) => reorderFolders(ids, focus),
  menu: (row, point) => run(showSidebarTaskMenu(row, point)),
  folderMenu: (heading, point) => run(showFolderMenu(heading, point)),
});
/* Branch and worktree control, plus optional GitHub through the user's gh CLI. */
const github = createGithub({
  call, modal, closeModal, notify, notifyError,
  sessions: () => state.sessions,
  project: id => state.projects.find(p => p.id === id),
  defaultHarness: () => {
    const harness = state.providers.find(p => p.id === state.defaultProvider && p.installed) ?? state.providers.find(p => p.installed) ?? state.providers[0];
    if (!harness) throw new Error('Open Settings to check your installed agents.');
    return { provider: harness.id, model: rememberedModel(harness.id) };
  },
  upsert: saved => { upsertSession(saved); pullView.forget(saved.id); },
  changed: () => { renderNavigation(); renderHeader(); },
  showPull: task => openPullRequest(task.id),
});
/* Per-thread token saving: packs ride along with messages as folded guidance. */
const tokenSaver = createTokenSaver({
  call, notify, notifyError,
  contextUsage: sessionId => {
    const s = session();
    return s && s.id === sessionId ? state.streams.get(s.id)?.contextUsage ?? s.contextUsage ?? null : null;
  },
  changed: sessionId => {
    if (sessionId !== state.sessionId) return;
    const current = document.querySelector<HTMLElement>('.composer-saver-button');
    if (current) { current.outerHTML = tokenSaver.button(sessionId); trayStateChanged(); }
  },
});
void tokenSaver.loadTools();
/* Council: an automatic team whose reviewers score the work until they reach the user's target. */
const council = createCouncil({
  call,
  team: sessionId => teams.get(sessionId) ?? null,
  loaded: sessionId => teams.has(sessionId),
  startTeam: async sessionId => {
    const task = state.sessions.find(s => s.id === sessionId);
    // Redraws the composer once the team is on (placeholder, steer bar), like the Team menu does.
    return Boolean(task) && setTeam(task!, true);
  },
  updated: onArchitect,
  announce: text => announce(text),
  keepFixing: sessionId => councilKeepFixing(sessionId),
  classicSetup: () => classicTeamSetup(),
  openClassicSetup: anchor => run(showArchitectSetup(anchor)),
});
const searchPanel = createSearchPanel({
  call,
  context: () => project() ? workspaceContext() : null,
  open: path => run(openFile(path, 'file')),
});
const fileTabs = createFileTabs({
  call,
  canAttach: context => Boolean(state.sessionId) && context.sessionId === state.sessionId,
  attach: path => attachFile(path),
  preview: (path, context) => previewFile(path, context),
  notify: text => notify(text),
  report: error => report(error),
  focusConversation: () => document.querySelector<HTMLElement>('#prompt')?.focus(),
  emptied: () => { if (state.inspectorTab === 'file') { state.inspectorTab = threadDefault(inspectorTabs); renderInspector(); } },
});
const pullView = createPullView({
  call,
  openUrl: url => call('open_external_url', { url }),
  unlink: async task => {
    const saved = await call<Session>('set_task_link', { sessionId: task.id, kind: 'pull', link: null });
    upsertSession(saved); pullView.forget(task.id);
    if (state.inspectorTab === 'pull' && task.id === state.sessionId) state.inspectorTab = 'changes';
    renderNavigation(); renderHeader(); renderInspector();
    notify(`Pull request #${task.pullRequest?.number ?? ''} unlinked`);
  },
  merged: saved => { upsertSession(saved); renderNavigation(); renderHeader(); },
  notify, notifyError,
});
function upsertSession(saved: Session): void { const index = state.sessions.findIndex(s => s.id === saved.id); if (index < 0) state.sessions.unshift(saved); else state.sessions[index] = saved; }
/** Show a task's linked pull request in the inspector. */
async function openPullRequest(sessionId: string): Promise<void> {
  if (sessionId !== state.sessionId) await selectSession(sessionId);
  if (!session()?.pullRequest) return;
  inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'pull'; state.selectedKind = ''; renderInspector();
}
/** After a turn, link the pull request the agent opened, if there is one. */
async function detectPullRequest(sessionId: string): Promise<void> {
  const task = state.sessions.find(s => s.id === sessionId);
  if (!task || !githubEnabled() || !github.connected(task.projectId)) return;
  try {
    const saved = await call<Session | null>('github_detect_pull_request', { sessionId });
    if (!saved?.pullRequest) return;
    upsertSession(saved); pullView.forget(sessionId);
    renderNavigation(); renderHeader(); renderInspector();
    notify(`Linked pull request #${saved.pullRequest.number}${sessionId === state.sessionId ? '' : ` to ${saved.title}`}`);
  } catch { /* Detection is best effort; the branch menu can link it by hand. */ }
}
const worktrees = createWorktrees({
  call, modal, closeModal, notify, notifyError, showChoices,
  session, project,
  git: () => state.git, gitError: () => state.gitError,
  draft: () => document.querySelector<HTMLTextAreaElement>('#prompt')?.value ?? '',
  attachable: () => newTaskView(),
  computer: (task, fresh) => computerControl(task, fresh, remoteTargets, remoteChoice, cloudTargets, remoteChoiceName) + botTaskControl(task, fresh),
  running: () => isRunning(),
  afterAttach: async (saved, live) => {
    const index = state.sessions.findIndex(s => s.id === saved.id); if (index >= 0) state.sessions[index] = saved;
    if (live) closeModal();
    if (saved.id === state.sessionId) { clearWorkspaceInspector(); render(); terminalPanel.minimize(); await refreshInspector(); renderHeader(); if (live) document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(); }
    else renderNavigation();
  },
  branchChanged: async () => { await refreshInspector(); renderHeader(); },
  afterCreate: async (created, live, current) => {
    state.sessions.unshift(created); renderNavigation();
    // Only a dialog that is still open may close and navigate; a canceled one leaves the user where they are.
    if (!live) return;
    closeModal();
    if (current) { state.query = ''; await selectSession(created.id, true); }
  },
  settle: async task => { await changeTaskStage(task, 'completed', false); },
  extraItems: task => github.menuItems(task),
  onExtra: (id, task) => github.onMenu(id, task),
});
window.addEventListener('pandacode-github-change', () => { renderComposer(); renderHeader(); renderInspector(); });
window.addEventListener('focus', () => void github.refreshLinks(state.projectId));
/** The prompt's aria-description, shared by the composer render and dictation's restore, so the bot-steering and
 * GitHub-mention wording is the same everywhere. */
function promptDescription(): string {
  const running = isRunning(), task = session(), bot = running ? botForThread() : undefined;
  let enter = 'Enter to send.';
  if (running) {
    const steering = task && !teams.get(task.id) ? ' Command Enter to steer the running turn.' : '';
    enter = `Enter to queue for when the agent finishes.${steering}`;
  }
  if (bot) {
    const steer = bot.whileWorking === 'steer';
    enter = `Enter to ${steer ? 'steer current work' : 'queue for after it finishes'}. `
      + `Command Enter to ${steer ? 'queue for after it finishes' : 'steer now'}.`;
  }
  const references = task && github.connected(task.projectId) ? ', issue, or pull request' : '';
  return `${enter} Shift Enter for a new line. Type @ to mention a project file${references}.`;
}
const voiceDictation = createVoiceDictation({
  call, subscribe: callback => subscribe('voice-event', callback),
  thread: () => state.sharedChannelId ? null : session()?.id ?? null,
  threadTitle: id => state.sessions.find(task => task.id === id)?.title || 'New task',
  showThread: id => run(selectSession(id)),
  settings: () => run(showVoiceSettings()), isImeKey, announce, describePrompt: promptDescription,
  enter: element => {
    if (document.documentElement.hasAttribute('data-ready')) {
      materializeIn(element, { scale: 1, y: 0, spring: { response: 0.18 } });
    }
  },
  leave: element => materializeOut(element, { scale: 1, y: 0 }),
});

const attachments = mountPromptAttachments({
  taskId: () => state.sessionId,
  blocked: taskId => {
    const task = state.sessions.find(s => s.id === taskId);
    if (!task) return 'Start a task before attaching anything.';
    if (taskStage(task) === 'completed') return 'Reopen this settled task before attaching anything.';
    return null;
  },
  otherImages: taskId => (state.browserAttachments.get(taskId) ?? []).filter(item => item.kind === 'screenshot').length,
  // Grok Build's ACP agent advertises no image input; say so before a send fails.
  imagesUnsupported: taskId => {
    const provider = state.sessions.find(s => s.id === taskId)?.provider;
    if (provider === 'grok') return 'Grok Build does not accept images yet. Describe them, or attach documents and folders instead.';
    if (provider === 'zcode') return 'ZCode does not accept images yet. Describe them, or attach documents and folders instead.';
    return null;
  },
  notify: message => notify(message),
  report: error => report(error),
  insertText: text => {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
    if (!prompt || prompt.disabled || prompt.dataset.sessionId !== state.sessionId) return false;
    const before = prompt.value.slice(0, prompt.selectionStart);
    prompt.setRangeText((before && !/\s$/.test(before) ? (text.includes('\n') ? '\n' : ' ') : '') + text, prompt.selectionStart, prompt.selectionEnd, 'end');
    prompt.dispatchEvent(new Event('input', { bubbles: true }));
    prompt.focus();
    return true;
  },
  rerender: taskId => { if (taskId === state.sessionId) renderAttachmentBar(); },
  menu: (anchor, items, onSelect) => showChoices(anchor, { title: 'Attach', width: 340, actions: true, items: [...items, { id: 'recipes', label: 'Workflow recipes…', description: 'Queue saved steps', icon: 'play' }, { id: 'wake', label: 'Schedule a wake-up…', description: 'Wake this thread later', icon: 'clock' }], onSelect: id => { closeChoiceMenu(); if (id === 'wake') openWakeComposer(anchor); else run(id === 'recipes' ? openRecipes() : onSelect(id)); } }),
  projectFiles: () => { state.inspector = true; state.inspectorTab = 'files'; state.selectedKind = ''; renderInspector(); },
  sketch: (taskId, existing) => run(openSketch(taskId, existing)),
});
async function openRecipes(): Promise<void> {
  const s = session(); if (!s) return;
  const { mountRecipes } = await import('./recipes');
  modal('Workflow recipes', '<div id="recipes-body"></div>', 'recipes-dialog');
  mountRecipes($('#recipes-body'), {
    call, projectId: s.projectId, provider: s.provider,
    slashCommands: async () => (await call<{ commands: { name: string }[] }>('list_slash_commands', { sessionId: s.id })).commands.map(c => c.name),
    enqueue: async text => { const entry = await call<QueuedMessage>('queue_add', { sessionId: s.id, text, attachments: [] }); setQueue(s.id, [...queueOf(s.id), entry]); },
    done: () => { closeModal(); if (s.id === state.sessionId) renderComposer(); void run(dispatchQueue(s.id)); },
  });
}
async function openSketch(taskId: string, existing?: PromptImage): Promise<void> {
  const { showSketch } = await import('./sketch');
  const task = state.sessions.find(s => s.id === taskId);
  if (!task) throw new Error('Select the task again to sketch a mockup.');
  showSketch({
    taskId, existing, modal, close: closeModal,
    attach: async (dataUrl, name, sketchId, replace) => {
      const image = await attachments.addImage(taskId, { dataUrl, name, origin: 'sketch', sketchId, replace });
      notify(replace ? 'Mockup updated' : 'Mockup attached');
      return image;
    },
  });
}
let activeCommandView: { dispose(): void } | undefined;
const goalBanner = createGoalBanner({
  open: () => { const task = session(); if (task) openGoal(task); },
  pause: async () => { const task = session(); if (task) await updateGoal(task, { action: 'pause' }); },
  resume: async () => { const task = session(); if (task) await updateGoal(task, { action: 'resume' }); },
});
$('#composer-area').before(goalBanner.element);
function commandDialog(): HTMLDialogElement { disposeSettingsViews(); activeCommandView?.dispose(); activeCommandView = undefined; return document.querySelector<HTMLDialogElement>('#dialog')!; }
async function updateGoal(task: Session, request: GoalAction): Promise<GoalState | null> {
  const goal = await call<GoalState | null>('task_goal', { sessionId: task.id, request });
  // Native goal events are authoritative and may be newer than this request's acknowledgment.
  if (task.id === state.sessionId) goalBanner.update(task.goalState ?? null);
  // A newly created goal has an initiating user message; keep streamed text intact.
  const current = await call<Session>('get_task', { sessionId: task.id });
  Object.assign(task, current, { goalState: task.goalState });
  if (task.id === state.sessionId && request.action === 'set') {
    const page = await latestMessagePage(task.id);
    if (task.id === state.sessionId) { setMessagePage(page); renderTranscript(); renderComposer(); }
  }
  scheduleNavigation(); return goal;
}
function openGoal(task: Session, initialObjective?: string): void {
  activeCommandView = showGoalDialog(commandDialog(), {
    taskId: task.id, initialObjective,
    load: () => call('task_goal', { sessionId: task.id, request: { action: 'get' } }),
    execute: request => updateGoal(task, request),
  });
}
function openCommandPanel(task: Session, kind: string, argumentsText = ''): void {
  if (kind === 'usage' && argumentsText && !['daily', 'weekly', 'cumulative'].includes(argumentsText)) throw new Error('Use /usage, /usage daily, /usage weekly, or /usage cumulative.');
  const titles: Record<string, string> = { usage: 'Codex usage', hooks: 'Lifecycle hooks', preferences: 'Codex preferences', imports: 'Import agent setup', conversations: 'Resume a Codex task', plugins: 'Installed plugins', jobs: 'Background commands' };
  const load = (cursor?: string) => kind === 'jobs'
    ? call<CommandPanel>('codex_jobs', { sessionId: task.id })
    : call<CommandPanel>('codex_command', { sessionId: task.id, request: { action: kind, ...(kind === 'conversations' ? { cursor: cursor ?? null, search: argumentsText || null } : {}) } });
  activeCommandView = showCommandCenter(commandDialog(), { title: titles[kind] ?? kind, initialSearch: kind === 'conversations' ? argumentsText : undefined, initialSection: kind === 'usage' && argumentsText === 'daily' ? 'daily' : undefined, load, execute: async (action, payload) => {
    if (action === 'set_preferences') {
      for (const [id, value] of Object.entries(payload.values as Record<string, unknown>)) await call('codex_command', { sessionId: task.id, request: { action: 'setPreference', id, value } });
      slashPicker?.refresh(); return load();
    }
    if (action === 'import') { const result = await call<CommandPanel>('codex_command', { sessionId: task.id, request: { action: 'importSelected', ids: payload.ids } }); slashPicker?.refresh(); return result; }
    if (action === 'stop') { await call('codex_jobs', { sessionId: task.id, stopId: payload.id }); return load(); }
    if (action === 'resume' || action === 'fork') {
      const adopted = await call<Session>('fork_codex_task', { sessionId: task.id, remoteId: payload.id });
      if (!state.sessions.some(s => s.id === adopted.id)) state.sessions.unshift(adopted);
      if (state.sessionId === task.id) { closeModal(); await selectSession(adopted.id, true); } else scheduleNavigation(); return;
    }
  } });
}
async function openHarnessConsole(task: Session, command?: string): Promise<void> {
  if (isRunning(task.id)) throw new Error('Stop this task before opening its harness console.');
  if (task.id !== state.sessionId) return;
  terminalPanel.select(workspaceContext(task), project()?.name ?? task.title);
  await terminalPanel.add({ provider: task.provider, command });
}
async function instruction(task: Session, text: string): Promise<void> {
  if (task.id !== state.sessionId) return;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  // A recording owns the locked draft: leave it untouched and say how to send.
  if (!prompt || !voiceDictation.prepareSubmit()) return;
  prompt.value = text; state.drafts.set(task.id, text); await send();
}
async function exportTask(task: Session, name?: string): Promise<void> {
  if (!preview) {
    const path = await (await import('@tauri-apps/plugin-dialog')).save({ title: 'Export task', defaultPath: name || `${task.title.replace(/[^a-z0-9 -]/gi, '').slice(0, 80) || 'task'}.md`, filters: [{ name: 'Markdown', extensions: ['md'] }] });
    if (path) { await call('save_task_export', { sessionId: task.id, path }); notify('Task exported'); }
    return;
  }
  const text = await call<string>('export_task', { sessionId: task.id });
  const url = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  const link = document.createElement('a'); link.href = url; link.download = name || 'task.md'; link.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
}

const disposeMessageActions = bindMessageActions($('#transcript'), {
  content: (sessionId, key) => {
    if (sessionId !== state.sessionId) return undefined;
    const live = state.streams.get(sessionId) ?? finishingStreams.get(sessionId)?.stream;
    if (key === 'live') return live?.text;
    if (key.startsWith('commentary:')) {
      const content = live?.tools.find(tool => tool.key === key.slice(11))?.content;
      return typeof content === 'string' ? content : undefined;
    }
    const saved = state.messages.find(message => String(message.id) === key);
    return saved && saved.id > 0 && ['user', 'assistant'].includes(saved.role)
      ? call<string>('get_message_content', { sessionId, messageId: saved.id }) : saved?.content;
  }, onFork: (sessionId, messageId) => forkAtMessage(sessionId, messageId), onEdit: editAtMessage, report,
});
installPointerDrag();
const transcriptScroller = $('#transcript');
transcriptScroller.tabIndex = 0;
/* Following the latest output is an intent, not a measurement. Growing content and a resizing
 * composer never clear it: only the reader scrolling up or opening a fold does, and reaching
 * the bottom sets it again. The observer re-pins before paint, so nothing jumps for a frame. */
let stickToBottom = true, lastTranscriptTop = 0, resumeFollow = true;
const transcriptGap = (): number => transcriptScroller.scrollHeight - transcriptScroller.scrollTop - transcriptScroller.clientHeight;
const readingTranscriptTool = (): boolean => Boolean(document.activeElement?.closest('.tool-activity, .turn-activity, .turn-changes, .agent-input'));
/** Clear the floating header when a fold brings an off-screen card back into view. */
const readingLine = (): number => transcriptScroller.getBoundingClientRect().top + (parseFloat(getComputedStyle(transcriptScroller).scrollPaddingTop) || 0);
/** The live card shrinking (a result card or the trace folding) would clamp the scroll and slide everything above it down:
 * the height it gave up becomes blank room under it, which new content grows back into. Only while the card's top is in
 * view: a card taller than the window moves down until its top arrives, or the fold would leave the window empty. */
let liveCardSeen: { card: Element; height: number } | undefined;
function keepTopOnShrink(): void {
  const card = document.querySelector('#stream-region .turn-card.is-live'), before = liveCardSeen;
  if (!card) { liveCardSeen = undefined; return; }
  const box = card.getBoundingClientRect();
  liveCardSeen = { card, height: box.height };
  if (before?.card !== card || box.height >= before.height - 0.5 || tailBridging) return;
  // At the end, the scroll has already lost what the card gave up (a clamp or scroll anchoring, in layout, before this runs).
  const end = transcriptScroller.scrollHeight - transcriptScroller.clientHeight, top = transcriptScroller.scrollTop;
  if (top < end - 1) return;
  const clear = readingLine();
  const aim = Math.min(top + before.height - box.height, top + box.top - clear);
  if (aim <= top) return;
  tailSession = state.sessionId;
  setTailRoom(tailRoom + aim - end);
  transcriptScroller.scrollTop = aim;
  // Where it landed, not where it was aimed: the room is whole pixels, and a fraction short would read as the reader scrolling up.
  lastTranscriptTop = transcriptScroller.scrollTop;
}
function followTranscript(): void {
  if (!stickToBottom) {
    liveCardSeen = undefined;
    // Room below the window can go without clamping the reader or moving their line.
    if (tailRoom && !tailBridging && transcriptGap() >= tailRoom) setTailRoom(0);
    return;
  }
  keepTopOnShrink();
  if (readingTranscriptTool()) { if (transcriptGap() > 2) stickToBottom = false; return; }
  // A handoff's room easing (growTailRoom) holds the follow unless it was started to keep following.
  if (tailBridging && !tailFollows) return;
  absorbTailRoom();
  const height = transcriptScroller.clientHeight, grew = (height === followedHeight || sendFollow) && transcriptGap() > 2;
  followedHeight = height;
  // A live trace's result card unfolding (a scripted animation in .live-tools) is followed on a short spring, so the
  // thread never lurches by the card's per-frame growth; a send (the bubble and the skeleton card) on a slower one
  // (SEND_RESPONSE); text, a switch or the composer still pin at once.
  if (grew && (state.streams.has(state.sessionId) || finishingStreams.has(state.sessionId)) && (followFrame !== 0 || sendFollow || traceUnfolding()) && transcriptGap() < FOLLOW_EASE_LIMIT && !matchMedia('(prefers-reduced-motion: reduce)').matches) {
    if (!followFrame) { followVelocity = 0; followStill = 0; followAt = performance.now(); followFrame = requestAnimationFrame(easeFollow); }
    // The spring steps before layout; this runs after it (the observer), so the frame's own growth is held to the cap too.
    const gap = transcriptGap();
    if (!sendFollow && gap > FOLLOW_MAX_LAG) { transcriptScroller.scrollTop += gap - FOLLOW_MAX_LAG; lastTranscriptTop = transcriptScroller.scrollTop; }
    return;
  }
  cancelAnimationFrame(followFrame); followFrame = 0; sendFollow = false;
  transcriptScroller.scrollTop = transcriptScroller.scrollHeight;
  lastTranscriptTop = transcriptScroller.scrollTop;
}
/** A result card's height animation (trace-motion.ts `expand`) is running in the live trace. */
const traceUnfolding = (): boolean => Boolean(document.querySelector('#stream-region .live-tools')?.getAnimations({ subtree: true })
  .some(animation => animation.playState === 'running' && ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.matches?.('.tool-activity-body')));
/** The follow is a critically damped spring on the distance to the bottom (time-based, FOLLOW_RESPONSE s), so it
 * eases in, tracks a growing card without stepping and lands without overshoot. */
const FOLLOW_RESPONSE = 0.1, SEND_RESPONSE = 0.26, FOLLOW_EASE_LIMIT = 480, FOLLOW_MAX_LAG = 24;
let followFrame = 0, followedHeight = 0, followVelocity = 0, followAt = 0, sendFollow = false, followStill = 0;
/** The next follow (a send's new bubble and card) eases on SEND_RESPONSE until it lands. */
function followSend(): void {
  sendFollow = true; followStill = 0;
  cancelAnimationFrame(followFrame); followFrame = 0;
}
function easeFollow(now: number): void {
  followFrame = 0;
  const gap = transcriptGap();
  if (!stickToBottom || gap <= 0.5) { sendFollow = false; return; }
  if (gap >= FOLLOW_EASE_LIMIT) { sendFollow = false; stickTranscript(); return; }
  const dt = Math.min(0.05, Math.max(0, (now - followAt) / 1000)), omega = 2 * Math.PI / (sendFollow ? SEND_RESPONSE : FOLLOW_RESPONSE), decay = Math.exp(-omega * dt);
  followAt = now;
  // Position relative to the target is -gap; the closed-form critically damped step. The bottom never runs more than
  // FOLLOW_MAX_LAG ahead of the follow (a result card unfolding; a send eases all the way), so the spring only shapes
  // the start and the end.
  const y = -gap, base = followVelocity + omega * y, next = Math.max(sendFollow ? -Infinity : -FOLLOW_MAX_LAG, (y + base * dt) * decay);
  followVelocity = (followVelocity - omega * base * dt) * decay;
  const before = transcriptScroller.scrollTop;
  transcriptScroller.scrollTop = before + next - y;
  lastTranscriptTop = transcriptScroller.scrollTop;
  // Compare this attempted step, not the previous post-write position: normal motion must not count as a stall.
  followStill = dt > 0 && lastTranscriptTop === before ? followStill + 1 : 0;
  if (followStill >= 2 && gap <= 4) { sendFollow = false; stickTranscript(); return; }
  followFrame = requestAnimationFrame(easeFollow);
}
/** Blank room under the last card after the handoff (handOffCard, foldInPlace) or a Show less: the card's top stays where it
 * was, and the room is given back only as new content grows into it (the reply, the next send) or the reader scrolls
 * up, so nothing above it moves and nothing moves on its own after a run. */
let tailRoom = 0, tailSession = '', tailBridging = false, tailFollows = false;
function setTailRoom(px: number): void {
  tailRoom = Math.max(0, Math.round(px));
  if (tailRoom) transcriptScroller.style.setProperty('--tail-room', `${tailRoom}px`); else transcriptScroller.style.removeProperty('--tail-room');
}
function absorbTailRoom(): void {
  if (!tailRoom || tailBridging) return;
  const gap = transcriptGap();
  if (gap > 0.5) setTailRoom(tailRoom - gap);
}
function stickTranscript(): void { stickToBottom = true; transcriptScroller.scrollTop = transcriptScroller.scrollHeight; lastTranscriptTop = transcriptScroller.scrollTop; }
const transcriptResize = new ResizeObserver(followTranscript);
followTranscriptBottom(transcriptScroller, () => stickToBottom && !readingTranscriptTool());
const observeTranscript = (): void => { transcriptResize.disconnect(); for (const node of [transcriptScroller, ...transcriptScroller.children]) transcriptResize.observe(node); };
new MutationObserver(observeTranscript).observe(transcriptScroller, { childList: true });
observeTranscript();
// Images agents viewed (tool rows, cards, the live header) all come from `tool_image`: only paths the thread's tool
// records name, absolute (/tmp screenshots included) or relative to the task's checkout. Network paths never load.
// Rows and cards ask for a downscaled copy (`maxEdge`); only the viewer asks for the whole image.
const toolImageLoader: ToolImageLoader = (sessionId, path, maxEdge) => isNetworkPath(path)
  ? Promise.reject(new Error(NETWORK_PATH_ERROR))
  : call<string>('tool_image', maxEdge ? { sessionId, path, maxEdge } : { sessionId, path });
// Thumbnails load once near the viewport, whichever render inserted them, with the thread that rendered them (a
// held transcript keeps showing the previous thread's rows after a switch); a click opens the viewer and never
// toggles the row around it.
attachToolImages(transcriptScroller, () => state.sessionId ?? '', toolImageLoader);
const releaseTranscript = (): void => { resumeFollow = false; if (transcriptScroller.scrollTop > 0) stickToBottom = false; };
// Composer mutations do not imply a resize; the transcript ResizeObserver handles actual size changes before paint.
const composerArea = $('#composer-area');
new MutationObserver(records => { if (records.some(record => !transcriptScroller.contains(record.target) && !composerArea.contains(record.target))) followTranscript(); })
  .observe($('.conversation-pane'), { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class', 'data-state', 'hidden'] });
transcriptScroller.addEventListener('scroll', () => {
  const top = transcriptScroller.scrollTop;
  // Scrolling up gives back the blank room a fold or handoff left under the last card: only the part now below the
  // window goes, so nothing on screen moves and the scroll follows the wheel; the reader has left the bottom (a later
  // scroll back down to the end pins again). A clamp (the old top past the end, or the scroll still at the end after a
  // pixel's shrink) is not the reader moving.
  const scrollEnd = transcriptScroller.scrollHeight - transcriptScroller.clientHeight;
  if (top >= scrollEnd - 2) transcriptView.scheduleTrim();
  if (top < lastTranscriptTop && tailRoom && !tailBridging && lastTranscriptTop <= scrollEnd + 1 && top < scrollEnd - 1) {
    absorbTailRoom(); stickToBottom = false; lastTranscriptTop = transcriptScroller.scrollTop;
    void loadOlderMessages(); return;
  }
  // Following and not moving up (the observer's own pins): nothing can change, so skip measuring. A pin is not the
  // reader asking for history: drawing it here would widen every thread as it opens, only for the trim to cut it again.
  if (stickToBottom && top >= lastTranscriptTop) { lastTranscriptTop = top; return; }
  // Native focus/anchoring scrolls after Read more are not the reader asking to follow again.
  if (resumeFollow && transcriptGap() <= 2) stickToBottom = true;
  // Content that shrank clamps the scroll up (the old top is past the end now): that is not the reader leaving.
  else if (stickToBottom && lastTranscriptTop > transcriptScroller.scrollHeight - transcriptScroller.clientHeight) followTranscript();
  else if (top < lastTranscriptTop) stickToBottom = false;
  lastTranscriptTop = transcriptScroller.scrollTop;
  if (!stickToBottom) void loadOlderMessages();
}, { passive: true });
transcriptScroller.addEventListener('click', event => {
  const target = event.target as Element;
  // Before the fold opens, so it opens at its full height.
  const tool = target.closest('details[data-tool-key] > summary')?.parentElement;
  if (tool) fillToolBody(tool as HTMLDetailsElement);
  const holdFold = stickToBottom && target.closest('summary');
  if (target.closest('summary, .turn-card-more, .team-progress-toggle')) stickToBottom = false;
  if (target.closest('.turn-card-more, .team-progress-toggle')) resumeFollow = false;
  // A manual fold still gives its lost height back once, without re-arming continuous following.
  if (holdFold) queueMicrotask(keepTopOnShrink);
}, true);
// Any other way a tool comes open (a restore, a script) still gets its body.
transcriptScroller.addEventListener('toggle', event => { const tool = event.target as HTMLDetailsElement; if (tool.open && tool.matches('details[data-tool-key]')) fillToolBody(tool); }, true);
// A page consisting mostly of folded tools may be shorter than the viewport.
// Let upward wheel/keyboard intent fetch its history even without a scroll event.
transcriptScroller.addEventListener('wheel', event => { if (event.deltaY > 0) { resumeFollow = true; if (!stickToBottom && transcriptGap() <= 2) stickToBottom = true; } else if (event.deltaY < 0) { releaseTranscript(); void loadOlderMessages(); } }, { passive: true });
transcriptScroller.addEventListener('pointerdown', event => { if (event.pointerType === 'touch' || event.target === transcriptScroller) resumeFollow = true; }, { passive: true });
transcriptScroller.addEventListener('keydown', event => {
  if (event.target !== transcriptScroller) return;
  if (['ArrowUp', 'PageUp', 'Home'].includes(event.key) || (event.key === ' ' && event.shiftKey)) { releaseTranscript(); void loadOlderMessages(); }
  else if (['ArrowDown', 'PageDown', 'End', ' '].includes(event.key)) { resumeFollow = true; if (!stickToBottom && transcriptGap() <= 2) stickToBottom = true; }
});
/* While the window's size changes, transcript rows off screen skip layout and paint (styles.css):
 * in a long thread they are most of each step's cost. A reader scrolled up gets their row back
 * when it settles, since those rows only reach their new heights then. */
const WINDOW_SETTLE_MS = 150;
let windowSize = `${innerWidth}x${innerHeight}`, windowSettle = 0, restoreWindowReader: (() => void) | undefined, windowReaderTask = '';
addEventListener('resize', () => {
  const size = `${innerWidth}x${innerHeight}`;
  if (size === windowSize) return; // Layout notifications (sidebar, UI size) dispatch resize too.
  windowSize = size;
  if (!windowSettle) {
    transcriptScroller.toggleAttribute('data-window-resizing', true);
    restoreWindowReader = stickToBottom ? undefined : captureTranscriptAnchor(transcriptScroller);
    windowReaderTask = state.sessionId;
  }
  clearTimeout(windowSettle);
  windowSettle = window.setTimeout(() => {
    windowSettle = 0;
    transcriptScroller.removeAttribute('data-window-resizing');
    if (windowReaderTask === state.sessionId) {
      if (restoreWindowReader && !stickToBottom) restoreWindowReader();
      else if (resumeFollow) { stickToBottom = true; followTranscript(); }
      lastTranscriptTop = transcriptScroller.scrollTop;
    }
    restoreWindowReader = undefined;
  }, WINDOW_SETTLE_MS);
});
const subagents = new Subagents($('#subagents-host'), 'subagents-panel', sessionId => ({ projectId: state.projectId, sessionId }));
const jevActivity = new JevActivity();
$('#transcript').before(jevActivity.host);
mountAgents($('#agents-toggle') as HTMLButtonElement, $('#agents-flyout'), () => architectView ? [architectView, subagents, lineageSource] : [subagents, lineageSource]);
// The thread is a window: the wallpaper (when the Wallpapers switch is on) or the sky shows inside the main pane.
const wallpapers = mountWallpapers($('.workspace'), $('.main-pane'));
const sky = mountSky($('.main-pane'), $('.workspace'), {
  wanted: () => !wallpapers.preferences.enabled,
  fixedMinutes: preview ? parseSkyTime(new URLSearchParams(location.search).get('sky')) : null,
  expose: preview,
  pinnedScene: preview ? new URLSearchParams(location.search).get('scene') : null,
});
const skyTime = preview ? parseSkyTime(new URLSearchParams(location.search).get('sky')) : null;
/** Threads tiled beside the open one (src/thread-tiles.ts); `tilePages` holds what the read-only views show. */
const tilePages = new Map<string, MessagePage>();
/** Longest a run this window did not start waits for its page before its live card paints anyway (loadWakeExchange). */
const WAKE_LOAD_HOLD_MS = 300;
/** Open threads whose new run is holding its live card back, by the timer that ends the hold. */
const wakeHolds = new Map<string, number>();
const tiles = mountThreadTiles({
  area: $('.work-area'), pane: $('.conversation-pane'), workspace: $('.workspace'),
  title: id => state.sessions.find(s => s.id === id)?.title || 'New task',
  signal: id => { const s = state.sessions.find(item => item.id === id); if (!s) return { status: '', label: '', word: '' }; const { status, statusLabel, word } = taskSignal(s, Date.now()); return { status, label: statusLabel, word }; },
  exists: id => state.sessions.some(s => s.id === id) && !deletedSessions.has(id),
  running: id => isRunning(id),
  open: (id, scrollTop) => openFromTile(id, scrollTop),
  focusPrompt: () => document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(),
  draw: (id, rows, scroller) => drawTile(id, rows, scroller),
  more: (id, rows, scroller) => tileWindows.showMore(id, rows, scroller),
  scene: (tile, id) => { const scene = mountSky(tile, $('.workspace'), { wanted: () => !wallpapers.preferences.enabled, fixedMinutes: skyTime, tileRoot: $('.work-area') }); scene.setThread(id); return scene; },
  notify,
});
wallpapers.subscribe(() => tiles.refreshScenes());
showThreadScene = id => { sky.setThread(id); tiles.sync(id); };
showThreadScene(session()?.draft ? null : session()?.id ?? null);
wallpapers.subscribe(() => sky.refresh());
// The accent follows the scene on screen; a VS Code theme keeps its own colors.
// With Wallpapers off the scene is the sky, and the scene accent is its calm blue.
const syncPaletteWallpaper = () => palette.setWallpaper(wallpapers.enabled ? wallpapers.currentId : SKY_SCENE);
wallpapers.subscribe(syncPaletteWallpaper); syncPaletteWallpaper();
window.addEventListener('pandacode-theme-change', () => palette.refresh());
const disposeSidebarResizing = initializeSidebarResizing($('.workspace'), $('.sidebar'));
const disposeInspectorResizing = initializeSidebarResizing($('.workspace'), $('#inspector'), true);
const disposeUiSizing = initializeUiSizing();
window.addEventListener('pagehide', () => { disposeSidebarResizing(); disposeInspectorResizing(); disposeUiSizing(); disposeMessageActions(); }, { once: true });

function project(): Project | undefined { return state.projects.find(p => p.id === state.projectId); }
function workspaceContext(s = session()): { projectId: string; sessionId?: string } { return { projectId: s?.projectId ?? state.projectId, ...(s ? { sessionId: s.id } : {}) }; }
function workspaceKey(): string { return `${state.projectId}:${session()?.worktreePath ?? ''}`; }
/** PDFs and images open in a file tab like other documents; the tab still offers the browser preview. */
const OPENS_IN_TAB = /\.(?:pdf|png|jpe?g|gif|webp|avif|bmp|ico|svg)$/i;
function workspacePath(): string { return session()?.worktreePath ?? project()?.path ?? ''; }
configureFileLinks({
  context: () => state.projectId ? workspaceContext() : undefined,
  resolve: (context, paths) => call<ResolvedFile[]>('resolve_workspace_files', { ...context, paths }),
  open: async (context, file) => {
    try {
      if (file.previewable && !OPENS_IN_TAB.test(file.path)) await previewFile(file.path, context);
      else await openFile(file.path, 'file', false, context);
    } catch (error) { report(error); }
  },
});
function saveThreadPanel(): void {
  if (!state.sessionId || deletedSessions.has(state.sessionId)) return;
  threadPanels.set(state.sessionId, { workspace: workspaceKey(), open: state.inspector, tab: state.inspectorTab, folders: [...state.openFolders], file: state.selectedFile, kind: state.selectedKind, staged: state.selectedStaged, context: selectedFileContext && { ...selectedFileContext }, browserUrl: state.browserUrl });
}
function restoreThreadPanel(task?: Session): void {
  clearWorkspaceInspector(false);
  const saved = task && threadPanels.get(task.id);
  const sameWorkspace = saved?.workspace === workspaceKey();
  // Without saved state the conversation opens the panel on the selected tab, unless the user closed it or it would cover the chat.
  state.inspector = saved?.open ?? (state.view === 'conversation' && inspectorChosen && !matchMedia('(max-width: 920px)').matches);
  state.inspectorTab = saved?.tab && (saved.tab === 'file' || inspectorTabs.open.includes(saved.tab)) ? saved.tab : threadDefault(inspectorTabs); state.openFolders = new Set(sameWorkspace ? saved?.folders : []);
  state.selectedFile = sameWorkspace ? saved?.file ?? '' : ''; state.selectedKind = sameWorkspace ? saved?.kind ?? '' : ''; state.selectedStaged = saved?.staged ?? false;
  state.browserUrl = sameWorkspace ? saved?.browserUrl ?? '' : ''; selectedFileContext = sameWorkspace && saved?.context ? { ...saved.context } : undefined;
  fileTabs.show(state.sessionId, workspaceKey());
  state.filePreviewLoading = Boolean(state.selectedKind);
}
async function restoreSelectedFile(): Promise<void> {
  if (!state.selectedKind || !state.selectedFile) return;
  const request = ++fileRequest, owner = state.sessionId;
  const path = state.selectedFile, kind = state.selectedKind, context = selectedFileContext ?? workspaceContext();
  try {
    const content = await call<string>('git_diff', { ...context, path, staged: state.selectedStaged });
    if (request !== fileRequest || owner !== state.sessionId) return;
    state.selectedContent = content; selectedFileContext = { ...context };
  } catch (error) {
    if (request !== fileRequest || owner !== state.sessionId) return;
    state.selectedKind = ''; state.selectedFile = ''; report(error);
  } finally {
    if (request === fileRequest && owner === state.sessionId) { state.filePreviewLoading = false; renderInspector(); }
  }
}
function clearWorkspaceInspector(render = true): void {
  ++inspectorRequest; ++fileRequest;
  state.git = null; state.files = []; state.gitError = ''; state.filesError = ''; state.inspectorLoading = Boolean(state.projectId);
  state.openFolders = new Set(); state.folderFiles = new Map(); state.selectedFile = ''; state.selectedContent = ''; state.selectedKind = ''; state.filePreviewLoading = false;
  state.browserUrl = '';
  selectedFileContext = undefined;
  if (render) renderInspector();
}
function renderThemeToggle(): void {
  const dark = currentTheme() === 'dark', toggle = $('#theme-toggle');
  toggle.innerHTML = icon(dark ? 'sun' : 'moon');
  toggle.setAttribute('aria-pressed', String(dark));
  toggle.title = dark ? 'Switch to light mode' : 'Switch to dark mode';
}
function activateProject(id: string, render = true): void {
  const changed = state.projectId !== id;
  state.projectId = id; localStorage.setItem('pandacode.project', id);
  if (changed) {
    // Old file actions must disappear before any asynchronous task/terminal load.
    clearWorkspaceInspector(render);
  }
}
function setProjectFilter(id: string): void { state.projectFilter = id; localStorage.setItem('pandacode.projectFilter', id); }
function saveCollapsedFolders(): void { try { localStorage.setItem('pandacode.collapsedFolders', JSON.stringify([...state.collapsedFolders])); } catch { /* per-launch preference only */ } }
/** Tasks shown in lists: a New task draft appears only after its first prompt. */
function listedSessions(): Session[] { return state.sessions.filter(task => !task.draft); }
/** Leaving an untouched draft discards it; one with typed text, attachments or a worktree stays hidden and New task reopens it. */
function leaveDraft(nextId: string): void {
  if (nextId !== state.sessionId) voiceDictation.detach();
  const draft = session();
  if (!draft?.draft || draft.id === nextId || isRunning(draft.id) || state.messages.length || configuringSessions.has(draft.id) || draft.worktreePath) return;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const typed = prompt?.dataset.sessionId === draft.id ? prompt.value : state.drafts.get(draft.id) ?? '';
  if (voiceDictation.ownsThread(draft.id) || typed.trim() || attachments.list(draft.id).length || state.browserAttachments.get(draft.id)?.length || state.moodboardAttachments.get(draft.id)?.length) return;
  state.sessions = state.sessions.filter(task => task.id !== draft.id);
  state.drafts.delete(draft.id);
  void call<boolean>('discard_draft', { sessionId: draft.id }).catch(() => undefined);
}
function lastActivity(s: Session): number | null { return s.lastPromptAt == null ? s.lastResponseAt : Math.max(s.lastPromptAt, s.lastResponseAt ?? 0); }
function activeTask(s: Session, now = Date.now()): boolean { const time = lastActivity(s); return time != null && time > now - ACTIVITY_WINDOW; }
const pendingPromptActivity = new Map<string, number>();
function session(): Session | undefined { return state.sessions.find(s => s.id === state.sessionId); }
function provider(id?: ProviderId): Provider | undefined { return state.providers.find(p => p.id === (id ?? session()?.provider ?? state.defaultProvider)); }
function isRunning(id = state.sessionId): boolean { return teamActive(teams.get(id)) || state.streams.has(id) || ['running', 'starting', 'waiting', 'waiting_approval'].includes(state.sessions.find(s => s.id === id)?.status ?? ''); }
/** A team waiting out its lead's usage limit with nothing at work. It stays active (Stop works, prompts
 *  queue, it retries by itself), so `isRunning` holds; the sidebar and composer say limited, not working. */
function teamHeld(id = state.sessionId): boolean {
  const team = teams.get(id), task = state.sessions.find(s => s.id === id);
  return Boolean(team && teamHeldUntil(team) && task && limitActive(task) && !state.streams.has(id) && !team.workers.some(w => w.status === 'running' || w.status === 'waiting'));
}
/** The empty-thread layout (no header underlap) changes only once the thread's page is known, in the
 * frame that draws it: a switch never moves the transcript 39px while it loads or mid-settle. */
function syncNewTaskPage(): void { if (!state.messagesLoading) $('.conversation-pane').classList.toggle('new-task-page', newTaskView()); }
/** The first load of a thread whose page is drawn while its task's details and team are still on the way: what acts on
 *  the task (sending, editing) waits until that load's details settle, whatever redraws the page meanwhile (a run
 *  finishing): a send before the team is known would go to a team thread as a plain message. Another load ends it. */
let taskDetailsPending: { id: string; generation: number } | undefined;
const threadLoading = (): boolean => state.messagesLoading || (taskDetailsPending?.id === state.sessionId && taskDetailsPending.generation === state.generation);
function newTaskView(): boolean { const s = session(); return Boolean(s && !s.resumeId && !isRunning() && !state.messagesLoading && !state.messagesError && state.messages.length === 0); }
function stream(id: string): Stream {
  let s = state.streams.get(id);
  if (!s) {
    finishingStreams.delete(id);
    const now = Date.now();
    s = { body: new TailText(), thought: new TailText(), get text() { return this.body.value; }, get thinking() { return this.thought.value || undefined; }, tools: [], accountSwitches: [], status: '', approvals: new Map(), inputs: new Map(), revision: 0, lastResponseAt: null, startedAt: now, turnKey: 'turn:live:' + id, omittedActivity: false };
    state.streams.set(id, s);
  }
  return s;
}
function updateStreamStatus(current: Stream, status: string): void {
  // Providers can flush buffered activity while cancellation is in progress.
  if (current.status !== 'Stopping agent') current.status = status;
}
function clearAgentInputs(current: Stream): void {
  for (const input of current.inputs.values()) input.dispose();
  current.inputs.clear();
}
function trimLiveActivity(current: Stream, sessionId: string): void {
  const focused = sessionId === state.sessionId ? document.activeElement?.closest<HTMLElement>('[data-tool-key]')?.dataset.toolKey : undefined;
  while (current.tools.length > 30) {
    // Keep the visible narrative anchored before subsequent calls even when a
    // long tool-only stretch evicts older activity from the bounded preview.
    const removable = current.tools.findIndex(entry => entry.key !== focused && entry.key !== current.retainedMessageKey);
    if (removable < 0) break;
    current.tools.splice(removable, 1);
    current.omittedActivity = true;
  }
}
function finishLiveMessage(current: Stream, sessionId: string): void {
  if (!current.text || current.retainedMessageKey) return;
  // Preserve chronology, but keep the latest message in its live slot until
  // actual replacement text arrives. Tool/message boundaries must not hide it.
  current.retainedMessageKey = 'commentary:' + transientId--;
  current.tools.push({ key: current.retainedMessageKey, content: current.text.length > 16384 ? current.text.slice(0, 16384) + '\n[Activity preview truncated]' : current.text, commentary: true });
  trimLiveActivity(current, sessionId); current.revision++;
}
 function shortProvider(id: ProviderId): string { return ({ claude: 'Claude', codex: 'Codex', kimi: 'Kimi', opencode: 'OpenCode', glm: 'GLM', antigravity: 'Antigravity', grok: 'Grok', mimo: 'MiMo', pi: 'Pi', deepseek: 'DeepSeek', commandcode: 'Command Code', cline: 'Cline', kilo: 'Kilo', omp: 'omp', 'github-copilot': 'GitHub Copilot CLI', muse: 'Muse Code', devin: 'Devin', zcode: 'ZCode', hermes: 'Hermes' })[id]; }
function selectedModel(s: Session): ProviderModel { return provider(s.provider)?.models.find(model => model.id === (s.model || 'default')) ?? fallbackModel(s.provider, s.model); }
function modelLabel(s?: Session, withEffort = true): string {
  if (!s) return 'Default model';
  const named = teams.get(s.id)?.config;
  if (named?.rosterOnly && named.name) return named.name;
  const model = selectedModel(s);
  const name = model.name === 'Default' ? 'Default model' : model.name;
  const effort = withEffort && effortLabel(s);
  return effort ? `${name} · ${effort}` : name;
}
/** The trigger's effort word; none for a named team, whose workers set their own. */
function effortLabel(s: Session): string {
  if (!s.reasoningEffort || teams.get(s.id)?.config.rosterOnly) return '';
  return selectedModel(s).reasoningEfforts?.find(effort => effort.id === s.reasoningEffort)?.name ?? s.reasoningEffort;
}
/** The trigger's logo, or a named team's stacked roster. */
function triggerLogo(s: Session): string {
  const team = teams.get(s.id)?.config;
  if (team?.rosterOnly) {
    const roster = [...new Set(team.workers.map(worker => worker.provider))].slice(0, 3);
    return `<span class="model-menu-stack" data-logo="${escape(roster.join(' '))}">${roster.map(id => providerLogo(id)).join('')}</span>`;
  }
  return `<span class="provider-small ${s.provider}" data-logo="${s.provider}">${providerLogo(s.provider)}</span>`;
}
function teamModelLabel(s?: Session): string {
  const team = s ? teams.get(s.id) : null;
  // A named agent team shows its name in place of the model and counts its models.
  if (team?.config.rosterOnly) { const count = team.config.workers.length; return `${count} ${count === 1 ? 'model' : 'models'}`; }
  // An auto team shows only its lead's model; the Team button carries the state.
  if (team?.config.auto) return '';
  const count = team?.config.workers.length ?? 0;
  return count ? `+${count} ${count === 1 ? 'model' : 'models'}${team?.pendingSetup ? ' · queued' : ''}` : '';
}
/** The model pill's tooltip names the model and effort, which an icon-only tray no longer shows. */
function modelTitle(s: Session): string {
  const team = teams.get(s.id), effort = effortLabel(s);
  return `${modelLabel(s, false)}${effort ? ` · ${effort}` : ''} — ${team && !team.config.auto ? 'Choose team profile and models' : 'Choose harness and model'}`;
}
function refreshModelLabels(): void {
  const s = session(); if (!s) return;
  const name = modelLabel(s, false), effort = effortLabel(s);
  document.querySelectorAll<HTMLElement>('[data-model-label]').forEach(label => { if (label.textContent !== name) label.textContent = name; });
  document.querySelectorAll<HTMLElement>('[data-effort-label]').forEach(label => { if (label.textContent !== effort) label.textContent = effort; label.hidden = !effort; label.closest<HTMLElement>('.model-effort-pill')?.toggleAttribute('hidden', !effort); });
  const teamLabel = teamModelLabel(s);
  document.querySelectorAll<HTMLElement>('[data-team-model-label]').forEach(label => {
    if (label.textContent !== teamLabel) label.textContent = teamLabel;
    label.hidden = !teamLabel;
  });
  const modelTrigger = document.querySelector('#model-picker-trigger');
  modelTrigger?.setAttribute('aria-label', `Model: ${modelLabel(s)}`);
  modelTrigger?.setAttribute('aria-description', ['Choose harness and model', teamLabel].filter(Boolean).join('. '));
  modelTrigger?.setAttribute('data-tip', modelTitle(s));
  const logo = modelTrigger?.querySelector<HTMLElement>('[data-logo]'), nextLogo = triggerLogo(s);
  if (logo && logo.dataset.logo !== /data-logo="([^"]*)"/.exec(nextLogo)?.[1]) logo.outerHTML = nextLogo;
  const modeTrigger = document.querySelector<HTMLElement>('#mode-picker-trigger');
  const mode = approvalMode(s.provider, s.mode);
  if (modeTrigger && modeTrigger.dataset.mode !== mode.id) {
    modeTrigger.dataset.mode = mode.id; modeTrigger.dataset.tip = modeTip(mode); modeTrigger.setAttribute('aria-label', modeName(mode)); modeTrigger.setAttribute('aria-description', mode.description);
    modeTrigger.innerHTML = modeFaceHtml(mode);
    trayStateChanged();
  }
  council.sync(s.id);
  refreshTeamProgress();
}
function formatTime(timestamp: number): string { return new Date(timestamp < 1e12 ? timestamp * 1000 : timestamp).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' }); }
/** The toast's Undo, while it shows; ⌘Z runs it too. `toastSettle` runs once when that toast leaves without its Undo
 * (expires, is closed, or another toast replaces it): work an Undo can still cancel waits for it. */
let toastUndo: (() => void) | undefined, toastSettle: (() => void) | undefined, toastGeneration = 0, toastShown: { text: string; count: number; plain: boolean; tone: ToastTone } | null = null, toastShownAt = 0;
const toastVisible = (toast: HTMLElement): boolean => !toast.hidden;
/** `important`: the notice asks the user to act (an approval, a question), so it is never dropped from the queue. */
type ToastOptions = { tone?: ToastTone; settle?: () => void; important?: boolean };
function settleToast(): void { const settle = toastSettle; toastSettle = undefined; toastUndo = undefined; settle?.(); }
/** Runs the toast's Undo (its button or ⌘Z); its settle work is cancelled, not run. */
function runToastUndo(): boolean {
  const undo = toastUndo;
  if (!undo) return false;
  toastUndo = undefined; toastSettle = undefined; toastShown = null; releaseToastRoom(); void hideToast($('#toast')); undo();
  leaveToastFocus();
  showQueuedToast();
  return true;
}
/** Notices that arrived while a dismissal's Undo toast showed (queueToast); shown one by one once it settles. */
type QueuedToast = { text: string; tone?: ToastTone; important?: boolean; undo?: (() => void) | { label: string; run: () => void }; options: ToastOptions };
let toastQueue: QueuedToast[] = [];
function showQueuedToast(): void {
  const [next, ...rest] = toastQueue;
  if (!next) return;
  toastQueue = rest;
  notify(next.text, next.undo, next.options);
}
const toastCountHtml = (count: number): string => `<span class="toast-count" aria-hidden="true">×${count}</span><span class="sr-only">Repeated ${count} times</span>`;
/** A short notice; a function adds Undo, `{ label, run }` one other button that stays a little longer. `tone: 'danger'`
 * marks a notice raised by a failure. An identical notice while it shows only bumps its count, so a screen reader hears
 * "Repeated N times" rather than the whole message again. */
function notify(text: string, undo?: (() => void) | { label: string; run: () => void }, options: ToastOptions = {}): void {
  const toast = $('#toast'), wasVisible = toastVisible(toast), plain = !undo && !options.settle;
  const queued = queueToast({ holding: wasVisible && Boolean(toastSettle), queue: toastQueue }, { text, tone: options.tone, important: options.important, undo, options }, Boolean(options.settle));
  toastQueue = queued.queue;
  if (!queued.show) return;
  const count = nextToastCount(toastShown, text, wasVisible, plain, options.tone);
  const generation = ++toastGeneration;
  if (count > 1 && toast.querySelector('.toast-counter')) {
    toastShown = { text, count, plain, tone: options.tone };
    toast.querySelector('.toast-counter')!.innerHTML = toastCountHtml(count);
    hideToastLater(toast, generation, 4500);
    return;
  }
  settleToast();
  // The toast's controls are about to be replaced: focus in them goes back where the last toast was raised from.
  leaveToastFocus();
  const raisedFrom = document.activeElement;
  toastOrigin = raisedFrom instanceof HTMLElement && raisedFrom !== document.body ? raisedFrom : null;
  const action = typeof undo === 'function' ? undefined : undo;
  toastShown = { text, count, plain, tone: options.tone }; toastUndo = typeof undo === 'function' ? undo : undefined; toastSettle = options.settle;
  // The live region is the text alone (never the buttons), kept from toast to toast so each new text is announced once,
  // and not atomic: a count bump says only "Repeated N times".
  const label = toast.querySelector<HTMLElement>(':scope>.toast-text') ?? document.createElement('span');
  label.className = 'toast-text'; label.setAttribute('role', 'status'); label.setAttribute('aria-atomic', 'false'); label.title = toastTitle(text);
  const counter = document.createElement('span');
  counter.className = 'toast-counter';
  if (count > 1) counter.innerHTML = toastCountHtml(count);
  label.replaceChildren(text, counter);
  for (const child of [...toast.children]) if (child !== label) child.remove();
  if (!label.isConnected) toast.append(label);
  toast.toggleAttribute('data-danger', options.tone === 'danger');
  if (options.tone === 'danger') {
    const mark = document.createElement('span');
    mark.className = 'toast-icon'; mark.dataset.stateTone = 'danger'; mark.setAttribute('aria-hidden', 'true'); mark.innerHTML = icon('alert');
    toast.prepend(mark);
  }
  if (typeof undo === 'function') {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toast-undo'; button.textContent = 'Undo'; button.setAttribute('aria-keyshortcuts', 'Meta+Z Control+Z');
    button.addEventListener('click', () => { if (toastUndo === undo) runToastUndo(); });
    toast.append(button);
  } else if (action) {
    const button = document.createElement('button');
    button.type = 'button'; button.className = 'toast-action'; button.textContent = action.label;
    button.addEventListener('click', () => { releaseToastRoom(); void hideToast(toast); action.run(); leaveToastFocus(); });
    toast.append(button);
  }
  const close = document.createElement('button');
  close.type = 'button'; close.className = 'toast-close'; close.setAttribute('aria-label', 'Dismiss'); close.innerHTML = icon('close');
  close.addEventListener('click', dismissToast);
  toast.append(close);
  toastShownAt = Date.now();
  showToast(toast);
  placeToast(toast);
  const composerArea = document.querySelector('#composer-area');
  if (composerArea) toastPlacement.observe(composerArea);
  hideToastLater(toast, generation, action ? 9000 : undo ? 5000 : 4500);
}
/** The toast keeps its bottom-right corner unless that would cover the composer (narrow windows, where the composer
 * reaches the corner): then it sits just above it. Placed before its first frame, never animated. */
const TOAST_COMPOSER_GAP = 8;
/** While a toast shows, a composer that grows or shrinks (a run starts, the prompt wraps) places it again. */
const toastPlacement = new ResizeObserver(() => { const toast = $('#toast'); if (toastVisible(toast)) placeToast(toast); else toastPlacement.disconnect(); });
function placeToast(toast: HTMLElement): void {
  toast.style.removeProperty('bottom');
  const composer = document.querySelector('#composer-area')?.getBoundingClientRect(), box = toast.getBoundingClientRect();
  if (composer?.width && !(box.left >= composer.right || box.right <= composer.left || box.top >= composer.bottom || box.bottom <= composer.top)) {
    toast.style.bottom = `${Math.round(window.innerHeight - composer.top + TOAST_COMPOSER_GAP)}px`;
  }
  makeToastRoom(toast);
}
/** A toast over the end of the open thread would cover its live errors' controls: while it shows, the transcript ends
 * that much higher (`--toast-clear`, extra room after the last row, turn-card.css), followed to the bottom when it was
 * there. A jump, never animated; a reader scrolled up is left where they are. */
function makeToastRoom(toast: HTMLElement): void {
  const transcript = document.querySelector<HTMLElement>('#transcript'), live = transcript?.querySelector<HTMLElement>('#stream-region .live-errors');
  if (!transcript) return;
  const current = parseFloat(transcript.style.getPropertyValue('--toast-clear')) || 0;
  const atBottom = transcript.scrollHeight - transcript.scrollTop - transcript.clientHeight < 2;
  const box = toast.hidden ? null : toast.getBoundingClientRect(), errors = live?.childElementCount ? live.getBoundingClientRect() : null;
  if (!atBottom && box) return;
  const across = box && errors && errors.height && box.left < errors.right && box.right > errors.left;
  const room = across ? Math.max(0, Math.ceil(current + errors.bottom + TOAST_COMPOSER_GAP - box.top)) : 0;
  if (room === current) return;
  if (room) transcript.style.setProperty('--toast-clear', `${room}px`); else transcript.style.removeProperty('--toast-clear');
  if (atBottom) transcript.scrollTop = transcript.scrollHeight;
}
/** The toast is leaving: the room it took goes with it. */
function releaseToastRoom(): void { toastPlacement.disconnect(); document.querySelector<HTMLElement>('#transcript')?.style.removeProperty('--toast-clear'); }
function dismissToast(): void {
  const toast = $('#toast');
  if (!toastVisible(toast)) return;
  toastGeneration++; toastShown = null; settleToast(); leaveToastFocus(); releaseToastRoom(); void hideToast(toast);
  showQueuedToast();
}
/** What had focus when the toast was raised (for an error dismissal, the next row's control or the composer). */
let toastOrigin: HTMLElement | null = null;
/** The toast is leaving or being replaced: focus in it moves to where it was raised from if that is still shown, else
 * the composer; never left on <body>. */
function leaveToastFocus(): void {
  const toast = $('#toast');
  if (!toast.contains(document.activeElement)) return;
  const back = toastOrigin?.isConnected && !toast.contains(toastOrigin) && toastOrigin.getClientRects().length ? toastOrigin : document.querySelector<HTMLElement>('#prompt');
  back?.focus({ preventScroll: true });
}
/** The toast stays while the pointer rests on it or focus is in it (WCAG 2.2.1), then leaves shortly after. */
function hideToastLater(toast: HTMLElement, generation: number, delay: number): void {
  window.setTimeout(() => {
    if (generation !== toastGeneration) return;
    if (toast.matches(':hover, :focus-within')) { hideToastLater(toast, generation, 1200); return; }
    toastShown = null; settleToast(); releaseToastRoom(); void hideToast(toast);
    showQueuedToast();
  }, delay);
}
/** A notice raised by a failure (danger tone); modules get it as `host.notifyError`. */
function notifyError(text: string): void { notify(text, undefined, { tone: 'danger' }); }
function report(error: unknown): void { console.error(error); notifyError(errorText(error, 'Something went wrong. Please try again.')); }
/** Rejections and errors nothing caught: logged in full, shown once and calmly (globalErrorText). Never throws. */
let lastGlobalError: { key: string; at: number } | null = null;
function onGlobalError(reason: unknown, message: string): void {
  try {
    if (isBenignGlobalError(reason, message)) return;
    console.error('Uncaught error', reason ?? message);
    const text = globalErrorText(reason), now = Date.now();
    if (!shouldShowGlobalError(lastGlobalError, text, now)) return;
    lastGlobalError = { key: text, at: now }; notifyError(text);
  } catch (inner) { console.error(inner); }
}
window.addEventListener('unhandledrejection', event => onGlobalError(event.reason, errorText(event.reason, '')));
window.addEventListener('error', event => onGlobalError(event.error, event.message || ''));
function run(work: Promise<unknown>): void { void work.catch(report); }
async function openSupport(): Promise<void> {
  if (openingSupport) return;
  openingSupport = true;
  const buttons = [...document.querySelectorAll<HTMLButtonElement>('button[data-action="support"]')].map(button => ({ button, html: button.innerHTML, label: button.getAttribute('aria-label'), title: button.title, disabled: button.disabled }));
  for (const { button } of buttons) {
    button.disabled = true;
    button.setAttribute('aria-busy', 'true');
    button.setAttribute('aria-label', 'Opening support…');
    button.title = 'Opening support…';
    button.innerHTML = `<span class="support-spinner" aria-hidden="true"></span>${button.id === 'support-button' ? '' : '<span>Opening…</span>'}`;
  }
  try { await call<void>('open_support'); }
  finally {
    openingSupport = false;
    for (const { button, html, label, title, disabled } of buttons) {
      button.disabled = disabled;
      button.removeAttribute('aria-busy');
      if (label === null) button.removeAttribute('aria-label'); else button.setAttribute('aria-label', label);
      button.title = title;
      button.innerHTML = html;
    }
  }
}
function cancelPendingMenu(): void { menuEpoch++; pendingMenuOpen?.release(); }
function closeModelPicker(): void { cancelPendingMenu(); const close = modelPickerCleanup; modelPickerCleanup = undefined; close?.(); }
function closeProjectPicker(): void { cancelPendingMenu(); const close = projectPickerCleanup; projectPickerCleanup = undefined; close?.(); }
function closeChoiceMenu(): void { cancelPendingMenu(); const close = choiceMenuCleanup; choiceMenuCleanup = undefined; choiceMenuAnchor = undefined; close?.(); }
function closeMenus(): void { ++architectSetupRequest; ++jevTestRequest; jevTestCleanup?.(); architectSetupCleanup?.(); closeModelPicker(); closeProjectPicker(); closeChoiceMenu(); }
function closeContentMenus(): void {
  // Header/browser controls, the workspace view menu and the GitHub view's row menus survive transcript and composer updates.
  const anchor = choiceMenuAnchor ?? pendingMenuOpen?.anchor;
  if (!jevTestCleanup && anchor?.id !== 'task-menu-trigger' && anchor?.id !== 'view-menu' && !anchor?.closest('#sidebar-bots-panel, #github-hub')) closeMenus();
}
function beginMenuOpen(anchor: HTMLElement): { epoch: number; release: () => void } {
  cancelPendingMenu();
  const epoch = menuEpoch, ownBusy = anchor.getAttribute('aria-busy');
  anchor.setAttribute('aria-busy', 'true');
  let released = false;
  function release(): void {
    if (released) return;
    released = true;
    if (ownBusy === null) anchor.removeAttribute('aria-busy'); else anchor.setAttribute('aria-busy', ownBusy);
    document.removeEventListener('keydown', onEscape, true);
    document.removeEventListener('pointerdown', onOutside, true);
    document.removeEventListener('focusin', onOutside, true);
    window.removeEventListener('blur', cancelPendingMenu);
    if (pendingMenuOpen?.release === release) pendingMenuOpen = undefined;
  }
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return;
    event.preventDefault(); event.stopPropagation(); cancelPendingMenu();
  }
  function onOutside(event: Event): void {
    if (event.target instanceof Node && !anchor.contains(event.target)) cancelPendingMenu();
  }
  pendingMenuOpen = { anchor, release };
  document.addEventListener('keydown', onEscape, true);
  document.addEventListener('pointerdown', onOutside, true);
  document.addEventListener('focusin', onOutside, true);
  window.addEventListener('blur', cancelPendingMenu);
  return { epoch, release };
}
function rememberedModel(id: ProviderId): string {
  const model = localStorage.getItem('pandacode.defaultModel.' + id) || localStorage.getItem('pandacode.model.' + id) || state.sessions.find(s => s.provider === id && s.model)?.model || 'default';
  return model.length <= 200 ? model : 'default';
}
let openCodeSaved = false;
/** Models by last use for long catalogs: OpenCode without a Settings selection, and Devin (about 110 models, most of them Fusion pairs). */
function recentModels(id: ProviderId): string[] | null {
  return (id === 'opencode' && !openCodeSaved) || id === 'devin' ? usedModels(id) : null;
}
/** Models of `id` by the last prompt of the tasks that ran them, newest first. */
function usedModels(id: ProviderId): string[] {
  const used = state.sessions.filter(s => s.provider === id && s.model);
  return used.sort((a, b) => (b.lastPromptAt ?? b.updatedAt) - (a.lastPromptAt ?? a.updatedAt)).map(s => s.model);
}
// Teams offer a long catalog's recent models only; OpenCode's saved selection is already short.
setTeamRecency({ used: usedModels, unlimited: id => id === 'opencode' && openCodeSaved });
function loadModels(id: ProviderId): Promise<ProviderModel[]> {
  const cached = modelCatalogs.get(id);
  if (cached && cached.expires > Date.now()) return cached.pending;
  // OpenCode's own listing also says whether Settings saved a selection, which keeps the picker's full list.
  const request = id === 'opencode'
    ? call<OpenCodeModels>('list_opencode_models').then(result => { openCodeSaved = result.selectedModelIds.length > 0; return openCodeChoices(result); })
    : call<ProviderModel[]>('list_provider_models', { provider: id });
  const pending = request.then(models => {
    if (modelCatalogs.get(id)?.pending === pending) {
      const entry = provider(id); if (entry) entry.models = models;
      if (session()?.provider === id) refreshModelLabels();
      else refreshTeamProgress();
    }
    return models;
  }).catch(error => { if (modelCatalogs.get(id)?.pending === pending) modelCatalogs.delete(id); throw error; });
  // Refresh on demand, without polling or retaining an idle provider process.
  modelCatalogs.set(id, { expires: Date.now() + 5 * 60 * 1000, pending });
  return pending;
}

/* Another computer's catalog (PandaCode Connect): kept per device, never in state.providers. */
const remoteCatalogs = new Map<string, Promise<Provider[]>>();
const remoteModelCatalogs = new Map<string, Promise<ProviderModel[]>>();
let localChoice: { provider: ProviderId; model: string } | undefined;
/** Named provider connections (Settings → Providers) and which task uses which. */
let namedConnections: import('./connections').ConnectionSnapshot = { connections: [], tasks: {} };
function taskConnection(s: Session): import('./connections').Connection | undefined {
  if (s.remoteDevice) return undefined;
  const id = namedConnections.tasks[s.id];
  return namedConnections.connections.find(c => c.id === id && c.provider === s.provider);
}
function onNamedConnections(snapshot: import('./connections').ConnectionSnapshot): void { namedConnections = snapshot; refreshModelLabels(); }
/** An account pool moved a running task to another account: show that one, never the old. */
function onAccountPoolSwitch(event: AgentEvent): void {
  const pool = (event.data as { accountPool?: { connectionId?: string | null } } | null | undefined)?.accountPool; if (!pool) return;
  const { [event.sessionId]: _old, ...tasks } = namedConnections.tasks;
  onNamedConnections({ ...namedConnections, tasks: pool.connectionId ? { ...tasks, [event.sessionId]: pool.connectionId } : tasks });
}
/** The computer the composer's picker lists: a mirror task's, a new task's chosen one, else undefined (local). */
function composerDevice(): string | undefined {
  const s = session();
  return s?.remoteDevice?.id ?? (s && newTaskView() && remoteChoice !== LOCAL && !cloudProvider(remoteChoice) ? remoteChoice : undefined);
}
function cachedFor<T>(cache: Map<string, Promise<T>>, key: string, load: () => Promise<T>): Promise<T> {
  let pending = cache.get(key);
  if (!pending) {
    const made = pending = load();
    cache.set(key, made);
    const drop = () => { if (cache.get(key) === made) cache.delete(key); };
    made.catch(drop);
    setTimeout(drop, 5 * 60 * 1000);
  }
  return pending;
}
const remoteProviders = (deviceId: string) => cachedFor(remoteCatalogs, deviceId, () => call<Provider[]>('list_providers', { deviceId }));
const remoteModels = (deviceId: string, id: ProviderId) => cachedFor(remoteModelCatalogs, deviceId + ':' + id, () => call<ProviderModel[]>('list_provider_models', { provider: id, deviceId }));
/** A new task's provider/model on the chosen computer: kept when it exists there, else that computer's first harness. Switching back to local restores the local choice. */
async function adaptPickerToComputer(task: Session, deviceId: string, name: string): Promise<void> {
  let choice: { provider: ProviderId; model: string } | undefined;
  let notice = '';
  if (deviceId === LOCAL) { choice = localChoice; localChoice = undefined; }
  else {
    try {
      const found = (await remoteProviders(deviceId)).filter(p => p.installed);
      const have = found.find(p => p.id === task.provider);
      const models = have ? await remoteModels(deviceId, have.id) : [];
      const model = task.model || 'default';
      if (have && (model === 'default' || models.some(m => m.id === model))) return;
      const next = have ?? found[0];
      if (!next) return;
      localChoice ??= { provider: task.provider, model };
      choice = { provider: next.id, model: 'default' };
      notice = `${name} doesn’t have ${have ? model : provider(task.provider)?.name ?? task.provider}. Using ${next.name}.`;
    } catch { return; }
  }
  if (!choice || state.sessionId !== task.id || remoteChoice !== deviceId) return;
  const updated = await call<Session>('configure_session', { sessionId: task.id, provider: choice.provider, model: choice.model });
  const index = state.sessions.findIndex(item => item.id === task.id); if (index >= 0) state.sessions[index] = updated;
  renderComposer(); renderHeader();
  if (notice) notify(notice);
}

/** Whether a task needs you, as its sidebar row and board card say it: a state, its full label, and the word shown. */
function taskSignal(s: Session, now: number): { status: string; statusLabel: string; word: string } {
  const live = state.streams.get(s.id), answer = Boolean(live?.inputs.size);
  const status = live && (live.approvals.size || live.inputs.size) || s.status === 'waiting_approval' ? 'attention' : isRunning(s.id) && !teamHeld(s.id) ? 'running' : limitActive(s, now) ? 'limited' : FAILED_STATUS.has(s.status) ? 'failed' : '';
  const statusLabel = status === 'attention' ? answer ? 'Needs your answer' : 'Needs approval' : status === 'limited' ? `Usage limit · ${resetLabel(s.limitedUntil, now)}` : status === 'failed' ? s.status === 'interrupted' ? 'Interrupted' : 'Failed' : 'Running';
  // States that need you say so in a word; running shows its clock, the rest their age.
  const word = status === 'attention' ? answer ? 'Answer' : 'Approval' : status === 'failed' ? statusLabel : status === 'limited' ? (limitReset(s.limitedUntil, now) ? `Limited · ${limitReset(s.limitedUntil, now)}` : 'Limited') : '';
  return { status, statusLabel, word };
}
function renderNavigation(): void {
  queueMicrotask(() => tiles.refresh());
  // Preserve the native drag source while agent updates arrive in the background.
  if (sidebarDragging) return;
  const now = Date.now();
  const filterLabel = $('#project-filter').querySelector('[data-filter-label]')!;
  const filtered = state.projects.find(p => p.id === state.projectFilter);
  const filterName = filtered?.name ?? 'All projects';
  if (filterLabel.textContent !== filterName) filterLabel.textContent = filterName;
  // A chosen project leads with its own icon.
  const filterIcon = filtered ? projectAppIcon(filtered.id, filtered.name) : '';
  const shownIcon = filterLabel.previousElementSibling;
  if ((shownIcon?.outerHTML ?? '') !== filterIcon) { shownIcon?.remove(); if (filterIcon) filterLabel.insertAdjacentHTML('beforebegin', filterIcon); }
  const filterField = $('#sidebar-filter') as HTMLInputElement;
  if (filterField.value !== state.query) filterField.value = state.query;
  filterField.parentElement!.classList.toggle('has-query', Boolean(state.query));
  const projectName = (s: Session) => state.projects.find(p => p.id === s.projectId)?.name ?? '';
  const sidebarSessions = listedSessions().filter(s => !botProjects.has(s.projectId));
  const inScope = sidebarSessions.filter(s => !state.projectFilter || s.projectId === state.projectFilter);
  const matching = inScope.filter(s => matchesFilter(s, state.query, projectName(s)));
  // Opening a thread (in view, with the window focused) clears its unread mark; settling one does too.
  const seen = unreviewed ?? (state.sessions.length ? unreviewed = readCollapsed(localStorage, UNREVIEWED_KEY) : new Set<string>());
  const reviewed = [...seen].filter(id => { const task = state.sessions.find(s => s.id === id); return id === state.sessionId && transcriptVisible() && document.hasFocus() || (task ? taskStage(task) === 'completed' : state.sessions.length > 0); });
  if (reviewed.length) { for (const id of reviewed) seen.delete(id); saveUnreviewed(); }
  const failed = (s: Session) => FAILED_STATUS.has(s.status);
  // A held thread that starts running is held in Active from then on: after its run it stays there
  // while it is open, and goes to its folder once you open another thread, never back to (say)
  // the Settled section it was opened from.
  if (sectionHold && sectionHold.section !== 'active' && isRunning(sectionHold.id)) sectionHold = { ...sectionHold, section: 'active' };
  const order = taskComparator(sidebarSort.tasks), manual = sidebarSort.tasks === 'manual';
  const sections = sidebarSections({
    tasks: [...matching].sort(order), stage: taskStage,
    // Work that needs you: running or waiting, stopped by a usage limit, or failed while you were away.
    active: s => isRunning(s.id) || limitActive(s, now) || failed(s) && seen.has(s.id),
    selectedId: state.sessionId, hold: sectionHold?.id === state.sessionId ? sectionHold.section : undefined,
  });
  const visible = sections.rest;
  renderBots();
  /** `card`: two lines (where, then what) for Active, Finished and Pinned; otherwise one line. */
  const row = (s: Session, card = false, reorderable = false, showProject = false): string => {
    const p = state.projects.find(p => p.id === s.projectId);
    const activityAt = lastActivity(s);
    const live = state.streams.get(s.id);
    const startedAt = live?.startedAt ?? s.lastPromptAt;
    const working = isRunning(s.id) && !teamHeld(s.id);
    const elapsed = working && startedAt != null ? formatDuration(now - startedAt) : '';
    const age = elapsed || (activityAt == null ? '' : responseAge(activityAt, now));
    const { status, statusLabel, word } = taskSignal(s, now);
    const unread = seen.has(s.id) && s.id !== state.sessionId;
    const checkout = s.worktreePath ? s.worktreePath.split(/[\\/]/).filter(Boolean).pop() ?? p?.name ?? 'Project' : p?.name ?? 'Project';
    const link = s.pullRequest ?? s.issue;
    const linkMark = link ? `<span class="task-link ${link.kind === 'pull' ? 'pull' : 'issue'}" title="${escape(`${link.kind === 'pull' ? 'Pull request' : 'Issue'} #${link.number}: ${link.title}`)}">#${link.number}</span>` : '';
    // Worktree tasks show their branch; the worktree mark keeps its accessible name either way.
    const worktreeMark = (s.worktreePath ? `<span class="task-worktree" role="img" aria-label="Worktree" title="${escape(s.worktreePath)}">${icon('worktree')}</span>` : '')
      + (s.cloud ? `<span class="task-cloud" role="img" aria-label="Runs on ${escape(s.cloud.label)}" title="Runs on a ${escape(s.cloud.label)} cloud machine">${cloudIcon()}</span>` : '')
      + (s.remoteDevice ? `<span class="task-cloud task-remote" role="img" aria-label="Runs on ${escape(s.remoteDevice.name)}" title="Runs on ${escape(s.remoteDevice.name)}">${icon('monitor')}</span>` : '');
    const branch = s.worktreePath || s.cloud || s.remoteDevice ? `<span class="task-branch">${worktreeMark}${s.worktreeBranch ? branchLabel(s.worktreeBranch) : ''}</span>` : '';
    const signals = `${status ? `<span class="task-indicator ${status}" role="img" aria-label="${statusLabel}" title="${statusLabel}"></span>` : unread ? '<span class="task-indicator unread" role="img" aria-label="Unread" title="Unread"></span>' : '<span class="task-indicator" aria-hidden="true"></span>'}${word ? `<span class="task-status ${status}" aria-hidden="true">${word}</span>` : ''}${age && !word ? `<span class="task-age${elapsed ? ' task-runtime' : ''}"${elapsed ? ` data-started-at="${startedAt}"` : ''} title="${elapsed ? `Working for ${elapsed}` : `Last message: ${escape(new Date(activityAt!).toLocaleString())}`}">${age}</span>` : ''}${wakeGlyph(s.id)}`;
    const stage = taskStage(s), done = stage === 'completed';
    const selected = s.id === state.sessionId;
    const button = `<button class="task-item${card ? '' : ' task-oneline'}${selected ? ' selected' : ''}${unread ? ' unread' : ''}" data-action="select-task" data-id="${escape(s.id)}" data-activity="${activeTask(s, now) ? 'active' : 'inactive'}" draggable="true" data-reorderable="${reorderable}" data-pinned="${Boolean(s.pinned)}" tabindex="-1" ${reorderable ? 'aria-keyshortcuts="Alt+ArrowUp Alt+ArrowDown"' : ''} ${selected ? 'aria-current="page"' : ''} aria-description="${shortProvider(s.provider)}" title="${escape([s.title, showProject || card ? chatTask(s) ? 'Chat' : p?.name ?? '' : '', s.worktreeBranch ?? ''].filter(Boolean).join('\n'))}">`;
    const pin = s.pinned ? `<span class="task-pin" role="img" aria-label="Pinned">${icon('pin')}</span>` : '';
    const projectLabel = `<span class="task-project">${escape(p?.name ?? 'Project')}</span>`;
    // Row actions sit beside the row's button (buttons cannot nest), over its right edge. They
    // are not Tab stops: ⌘↩ completes and the menu key or ⇧F10 opens the menu.
    const title = escape(s.title), id = escape(s.id), busy = isRunning(s.id) || configuringSessions.has(s.id);
    const tick = busy ? '' : `<button class="task-action task-check${done ? ' checked' : ''}" data-action="${done ? 'sidebar-reopen' : 'sidebar-complete'}" data-task="${id}" tabindex="-1" aria-label="${done ? 'Reopen' : 'Settle'}: ${title}" title="${done ? 'Reopen task' : 'Settle task'}">${icon('check')}</button>`;
    // Delete and the rest sit in the row's menu.
    const extra = `<button class="task-action task-more" data-action="sidebar-more" data-task="${id}" tabindex="-1" aria-haspopup="menu" aria-label="Task actions: ${title}" title="Task actions">${icon('more')}</button>`;
    const wrap = (content: string) => `<div class="task-row${card ? '' : ' task-row-oneline'}" id="task-row-${id}" data-stage="${stage}">${content}<span class="task-actions">${tick}${extra}</span></div>`;
    // One line: the title, then the worktree mark, linked PR or issue, status, age and harness.
    // A flat list names each row's project: its icon first, its name after the title.
    if (!card && showProject) return wrap(`${button}<span class="task-line task-top">${projectAppIcon(s.projectId, p?.name ?? '')}<span class="task-title">${title}</span><span class="task-project-name" aria-hidden="true">${escape(chatTask(s) ? 'Chat' : p?.name ?? 'Project')}</span>${worktreeMark}${linkMark}${pin}${projectLabel}${signals}${providerLogo(s.provider, 'task-provider')}</span></button>`);
    if (!card) return wrap(`${button}<span class="task-line task-top"><span class="task-title">${title}</span>${worktreeMark}${linkMark}${pin}${projectLabel}${signals}${providerLogo(s.provider, 'task-provider')}</span></button>`);
    // Two lines: where (app icon, checkout, status, age), then what (title, branch, PR, harness).
    return wrap(`${button}<span class="task-line task-head">${projectAppIcon(s.projectId, p?.name ?? '')}<span class="task-checkout">${escape(checkout)}</span>${pin}${signals}</span>`
      + `<span class="task-line task-top"><span class="task-title">${title}</span>${branch}${linkMark}${projectLabel}${providerLogo(s.provider, 'task-provider')}</span></button>`);
  };
  const single = Boolean(state.projectFilter);
  const heading = (key: string, label: string, count: number) => `<div class="group-heading section-heading">${label}<span class="section-count">${count}</span></div>`;
  const filtering = Boolean(state.query.trim());
  // Active, Finished, Chats and Tasks fold from their headings (saved in collapsedSections); a line
  // runs from the label to the count. `rows` draws only while open.
  const section = (key: string, label: string, name: string, count: number, rows: () => string) => {
    if (!count) return '';
    const open = filtering || !collapsedSections.has(key);
    return `<section class="task-group sidebar-section ${key}-group" data-thread-group="${key}" aria-label="${name}"><button class="group-heading section-heading section-fold" data-action="toggle-section" data-section="${key}" tabindex="-1" aria-expanded="${open}" aria-controls="${key}-tasks">${label}<span class="section-rule" aria-hidden="true"></span><span class="section-count">${count}</span>${icon('chevron')}</button><div id="${key}-tasks" class="task-list" ${open ? '' : 'hidden'}>${open ? rows() : ''}</div></section>`;
  };
  // While filtering, every match shows: closed sections open and limits lift, for this draw only
  // (nothing is saved).
  const completedVisible = completedOpen || filtering;
  // The open (held) thread always shows, even past the first page, as in a folder.
  const completedRows = filtering ? sections.completed : shownTasks(sections.completed, false, state.sessionId, completedShown);
  const completedMore = sections.completed.length - completedRows.length;
  const completedSection = sections.completed.length
    ? `<section class="task-group sidebar-section completed-group" data-thread-group="completed" aria-label="Settled tasks"><button class="group-heading section-heading section-toggle" data-action="toggle-completed" tabindex="-1" aria-expanded="${completedVisible}" aria-controls="completed-tasks">${icon('chevron')}Settled<span class="section-count">${sections.completed.length}</span></button><div id="completed-tasks" class="task-list" ${completedVisible ? '' : 'hidden'}>${completedVisible ? completedRows.map(s => row(s)).join('') + (completedMore ? `<button class="folder-more" data-action="completed-more" tabindex="-1">Show ${Math.min(COMPLETED_PAGE, completedMore)} more</button>` : '') : ''}</div></section>` : '';
  const sectioned = sections.active.length + sections.review.length + sections.completed.length;
  // Pinned keeps the order you gave it, whatever the task sort.
  const pinned = visible.filter(s => s.pinned).sort(compareManual);
  // "Show N more" / "Show less" under a capped list; `key` is a project id, "chats" or "all".
  const moreButton = (key: string, total: number, shown: number, expanded: boolean, limit: number) => !filtering && (total > shown || expanded && total > limit)
    ? `<button class="folder-more" data-action="toggle-folder-more" data-project="${escape(key)}" tabindex="-1">${expanded ? 'Show less' : `Show ${total - shown} more`}</button>` : '';
  const capped = (key: string, tasks: Session[], limit: number) => {
    const expanded = state.expandedFolders.has(key);
    const rows = filtering ? tasks : shownTasks(tasks, expanded, state.sessionId, limit);
    return { rows, more: moreButton(key, tasks.length, rows.length, expanded, limit) };
  };
  // All projects: no folders, only sections. Projectless chats, then every other task, each row
  // naming its project; a chosen project filter hides chats.
  const chats = single ? [] : visible.filter(s => !s.pinned && chatTask(s));
  const others = single ? [] : visible.filter(s => !s.pinned && !chatTask(s));
  const listed = (key: string, tasks: Session[], showProject: boolean) => () => {
    const { rows, more } = capped(key, tasks, sidebarSort.perProject);
    return rows.map(s => row(s, false, manual, showProject)).join('') + more;
  };
  const chatGroup = section('chats', 'Chats', 'Chats', chats.length, listed('chats', chats, false));
  const tasksGroup = section('all', 'Tasks', 'Tasks', others.length, listed('all', others, true));
  // A selected project is already named by the filter above: list its tasks flat, with room for more.
  const project = single ? state.projects.find(p => p.id === state.projectFilter) : undefined;
  const projectTasks = project ? visible.filter(s => !s.pinned && s.projectId === project.id) : [];
  const projectList = project && (projectTasks.length || !filtering && !sectioned && !pinned.length) ? (() => {
    const { rows, more } = capped(project.id, projectTasks, PROJECT_LIMIT);
    const list = rows.map(s => row(s, false, manual)).join('') || '<div class="no-tasks">No tasks yet</div>';
    return `<section class="task-group folder-group single-project" data-thread-group="project:${escape(project.id)}" data-project="${escape(project.id)}" aria-label="${escape(project.name)} tasks"><div class="task-list">${list}${more}</div></section>`;
  })() : '';
  const nav = $('#navigation');
  nav.setAttribute('aria-busy', String(orderingBusy));
  const menuTrigger = choiceMenuAnchor ?? pendingMenuOpen?.anchor;
  const retainedRow = menuTrigger && nav.contains(menuTrigger) && menuTrigger.matches('.task-item') ? menuTrigger : null;
  const focused = nav.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusSelector = focused?.dataset.id ? `[data-id="${CSS.escape(focused.dataset.id)}"]` : focused?.dataset.action ? `[data-action="${CSS.escape(focused.dataset.action)}"]${focused.dataset.project ? `[data-project="${CSS.escape(focused.dataset.project)}"]` : ''}${focused.dataset.section ? `[data-section="${CSS.escape(focused.dataset.section)}"]` : ''}${focused.dataset.task ? `[data-task="${CSS.escape(focused.dataset.task)}"]` : ''}` : '';
  const pinnedGroup = pinned.length ? `<section class="task-group pinned-group" data-thread-group="pinned" aria-label="Pinned tasks">${heading('pinned', 'Pinned', pinned.length)}<div class="task-list">${pinned.map(s => row(s, !single, true)).join('')}</div></section>` : '';
  const empty = filtering ? '<div class="no-tasks sidebar-no-match">No tasks match</div>' : '';
  // Morph rather than replace: unchanged rows keep their nodes, so nothing flickers.
  // Rows sit one level deeper than before (.task-row around .task-item), so morph one level deeper.
  morph(nav, !userProjects().length && !chats.length && !pinned.length && !sectioned ? (projectsListed ? '<div class="sidebar-empty">Open a project to get started.</div>' : '')
    : `${pinnedGroup}${section('active', 'Active', 'Active tasks', sections.active.length, () => sections.active.map(s => row(s, !single)).join(''))}${section('review', 'Finished', 'Finished tasks', sections.review.length, () => { const { rows, more } = capped('review', sections.review, sidebarSort.perProject); return rows.map(s => row(s, !single, manual)).join('') + more; })}${chatGroup}${tasksGroup}${projectList}${filtering && !matching.length ? empty : ''}${completedSection}`, 6);
  if (retainedRow) {
    const replacement = nav.querySelector<HTMLElement>(`.task-item[data-id="${CSS.escape(retainedRow.dataset.id!)}"]`);
    if (replacement) {
      // Keep the menu's real anchor connected through background task updates.
      retainedRow.innerHTML = replacement.innerHTML; retainedRow.className = replacement.className;
      retainedRow.title = replacement.title;
      retainedRow.dataset.pinned = replacement.dataset.pinned; retainedRow.dataset.reorderable = replacement.dataset.reorderable;
      if (replacement.hasAttribute('aria-current')) retainedRow.setAttribute('aria-current', 'page'); else retainedRow.removeAttribute('aria-current');
      replacement.replaceWith(retainedRow);
      nav.dispatchEvent(new Event('scroll'));
    } else closeChoiceMenu();
  }
  // The list's scrollport ends where the docked Settled section starts, so rows never pass under it.
  const dock = nav.querySelector<HTMLElement>(':scope > .completed-group');
  if (dock !== settledDock) {
    settledResize.disconnect(); settledDock = dock;
    if (dock) settledResize.observe(dock); else nav.style.removeProperty('--settled-height');
  }
  // A row action that moved its task to another section hands focus to the task's row. Its tab stops read layout,
  // so unless focus is in the list (keyboard use, kept instant) they settle in the frame, after the thread's own work.
  syncNavigationFocus(nav);
  if (focusSelector) (nav.querySelector<HTMLElement>(focusSelector) ?? (focused?.dataset.task ? nav.querySelector<HTMLElement>(`.task-item[data-id="${CSS.escape(focused.dataset.task)}"]`) : null))?.focus({ preventScroll: true });
  renderBoardView();
  updateWorkTimer();
  window.clearTimeout(activityTimer);
  if (!document.hidden) {
    const expiry = Math.min(state.sessions.reduce((next, s) => activeTask(s, now) ? Math.min(next, lastActivity(s)! + ACTIVITY_WINDOW) : next, Infinity));
    if (Number.isFinite(expiry)) activityTimer = window.setTimeout(renderNavigation, Math.min(2147483647, Math.max(1, expiry - now)));
  }
}
function scheduleNavigation(): void {
  if (navigationFrame || document.hidden) return;
  navigationFrame = requestAnimationFrame(() => { navigationFrame = 0; if (!document.hidden) renderNavigation(); });
}
/** The thread shows full width in the conversation view, and as a side panel beside the board or GitHub. */
function transcriptVisible(): boolean { return !document.hidden && (state.view === 'conversation' || state.boardPanel); }
function responseAge(timestamp: number, now: number): string {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60000));
  return minutes < 1 ? 'now' : minutes < 60 ? `${minutes}m` : minutes < 1440 ? `${Math.floor(minutes / 60)}h` : `${Math.floor(minutes / 1440)}d`;
}
function renderHeader(): void {
  renderBoardView();
  syncProgressPip();
  const p = project();
  terminalPanel.select(p ? workspaceContext() : undefined, p?.name ?? '');
  projectRunner.paint();
  const fresh = newTaskView(), bot = botForThread(), chat = chatTask(session());
  syncNewTaskPage();
  $('.conversation-pane').classList.toggle('channel-thread', Boolean(state.sharedChannelId));
  document.body.classList.toggle('shared-channel-thread', Boolean(state.sharedChannelId));
  if (state.sharedChannelId) {
    const channel = state.sharedChannelDetail;
    $('#breadcrumb').innerHTML = `<button class="channel-back" data-action="close-shared-channel" aria-label="Back to conversation">${icon('chevron')}</button><span>${escape(channel ? `#${channel.name}` : 'Shared channel')}</span>`;
    return;
  }
  // A chat has no project: no project bar, deploy or run script.
  document.body.classList.toggle('chat-thread', chat);
  $('.conversation-pane').classList.toggle('bot-thread', Boolean(bot));
  const crumb = bot ? botCrumb(bot) : chat ? `${icon('chat')}<span>Chat</span>` : p && !fresh ? `${icon('folder')}<button data-action="select-project" data-id="${escape(p.id)}">${escape(p.name)}</button>` : '';
  if (!showsHtml($('#breadcrumb'), crumb)) $('#breadcrumb').innerHTML = crumb;
  const s = session(), bar = document.querySelector<HTMLElement>('#composer-area .composer-context');
  if (s && bar) {
    const markup = contextBarHtml(s, fresh);
    // A menu opening from the bar keeps its anchor; replacing it mid-open would cancel the menu.
    if (!showsHtml(bar, markup, true) && !bar.querySelector('[aria-expanded="true"]') && !(pendingMenuOpen && bar.contains(pendingMenuOpen.anchor))) bar.outerHTML = markup;
  }
}
/** The composer's context row. A linked PR or issue shows its state as a dot, so the state also goes in its tooltip. */
function contextBarHtml(s: Session, fresh: boolean): string {
  let markup = worktrees.contextBar(s, fresh).replace('<div class="composer-context', '<div id="composer-context" class="composer-context');
  // While git status loads, a quiet placeholder holds the branch chip's place so nothing shifts when it arrives.
  if (!s.remoteDevice && !s.worktreePath && !state.git && state.inspectorLoading && !markup.includes('branch-chip')) {
    markup = markup.replace(/(<span class="composer-local"[\s\S]*?<\/span><\/span>)/, `$1<span class="branch-chip branch-chip-pending" aria-hidden="true">${icon('branch')}<span class="branch-chip-name"></span></span>`);
  }
  if (!markup.includes('link-chip-state')) return markup;
  const template = document.createElement('template'); template.innerHTML = markup;
  template.content.querySelectorAll<HTMLElement>('.link-chip').forEach(chip => {
    const value = chip.querySelector('.link-chip-state')?.textContent ?? '';
    if (value) chip.title = `${value[0].toUpperCase()}${value.slice(1)} · ${chip.title}`;
  });
  return template.innerHTML;
}
/** What the empty prompt invites: a task, or a message to the bot whose thread this is. */
function composerPlaceholder(): string { const bot = botForThread(); return bot ? `Message ${escape(bot.name)}…` : chatTask(session()) ? 'Ask anything…' : newTaskView() ? 'Describe a task…' : 'Ask for follow-up changes…'; }
/** A bot thread's header: who you're talking to, where the thread comes from, and its settings. */
function botCrumb(bot: import('./bots').Bot): string {
  const s = session();
  const working = state.sessions.some(task => task.projectId === bot.projectId && isRunning(task.id));
  // Channel threads and scheduled work name where they come from; the bot's own chat needs no label.
  const where = s && s.id !== bot.desktopSession ? s.title.split(' · ').slice(1).join(' · ') : '';
  const next = s && isRunning(s.id) ? botThread.nextModel(s.id) : undefined;
  return botThread.crumbHtml(bot, { where, status: bot.paused ? 'Paused' : working ? 'Working' : 'Ready', nextModel: s && next ? { running: modelLabel(s), next: next.label } : undefined });
}
/** Where a turn's spawned workers appear: right after what the architect said in that turn. */
function workerSlot(turn: { user?: Message; coordination?: Message; workerStart?: number }, sessionId = state.sessionId, topLevel = false): string {
  const start = turn.workerStart ?? turn.user?.createdAt ?? turn.coordination?.createdAt;
  // A card always carries its (hidden) slot, so a team landing after the rows fills slots rather than redrawing every
  // card. A slot that would be a row of its own (chat rows, a turn with no card) is drawn only with a team.
  return start !== undefined && (!topLevel || teams.get(sessionId)) ? `<div class="team-progress-slot" data-turn-start="${start}" hidden></div>` : '';
}
/** Each spawned worker shows in the turn it was spawned in; while that turn is still running,
 *  it follows the live activity at the end of the thread. */
function refreshTeamProgress(): void {
  const liveHost = document.querySelector<HTMLElement>('#team-progress-host');
  if (!liveHost) return;
  const team = teams.get(state.sessionId), workers = team?.workers ?? [];
  const slots = [...document.querySelectorAll<HTMLElement>('#transcript .team-progress-slot')].map(slot => ({ slot, start: Number(slot.dataset.turnStart) }));
  const placed = new Map<HTMLElement, typeof workers>([[liveHost, []], ...slots.map(({ slot }) => [slot, []] as [HTMLElement, typeof workers])]);
  // Only a turn that is still streaming has no saved place yet. Workers spawned before it
  // started (a coordination turn whose message hasn't loaded yet) keep their saved place.
  const startedAt = state.streams.get(state.sessionId)?.startedAt;
  for (const worker of workers) {
    let index = -1;
    slots.forEach((slot, at) => { if (slot.start <= worker.createdAt) index = at; });
    // Its turn is older than the ones drawn so far; it takes its place when that turn is. A worker of the running turn
    // always shows, whatever the drawn rows hold.
    const live = startedAt !== undefined && worker.createdAt >= startedAt;
    if (index < 0 && !live && transcriptView.view.first !== null && transcriptView.view.sessionId === state.sessionId) continue;
    const turn = slots[Math.max(index, 0)];
    placed.get(!turn || (live && index === slots.length - 1) ? liveHost : turn.slot)!.push(worker);
  }
  const asking = (sessionId: string) => architectView?.needsInput(sessionId) ?? false;
  for (const [host, shown] of placed) updateTeamProgress(host, team, state.providers, shown, asking);
}
/** A turn's change card, or nothing when the snapshot has nothing to report. */
function changesRow(sessionId: string, changes: TurnChanges | undefined): string {
  // A remote task's diffs live on its computer; their review and commit actions would act on this one.
  const card = changes && !state.sessions.find(task => task.id === sessionId)?.remoteDevice ? renderTurnChanges(sessionId, changes, sessionId === state.sessionId && projectRunner.available()) : '';
  return card ? `<div class="turn-changes-row">${card}</div>` : '';
}
/** The turn card's footer, under the same rule as changesRow. */
function changesFoot(sessionId: string, changes: TurnChanges | undefined): string {
  return changes && !state.sessions.find(task => task.id === sessionId)?.remoteDevice ? turnChangesFoot(sessionId, changes, sessionId === state.sessionId && projectRunner.available()) : '';
}
/** A saved turn: the user's bubble, then one card (header and trace, the reply, the changes).
 * Bot threads keep their chat rows (bot-thread.ts decorates direct children of the transcript). */
/** A thread's read-only view in a tile: the same turn cards, plus what is streaming. Rows redraw only when the saved
 *  messages change, so a stream's ticks touch just its live card. */
function drawTile(id: string, rows: HTMLElement, scroller: HTMLElement): void {
  const page = tilePages.get(id) ?? threadPages.get(id);
  if (!tilePages.has(id)) void call<MessagePage>('get_messages', { sessionId: id }).then(fresh => { tilePages.set(id, fresh); if (rows.isConnected) drawTile(id, rows, scroller); }).catch(error => {
    report(error);
    // The live card must still show: the page this view already has stands in for the one that failed.
    const known = threadPages.get(id);
    if (known) { tilePages.set(id, known); if (rows.isConnected) drawTile(id, rows, scroller); }
  });
  if (!page) return;
  // Until the fresh page is in, the saved rows stay alone: a wake's exchange joins its live card only once its message is known.
  const live = tilePages.has(id) ? state.streams.get(id) : undefined;
  let messages = page.messages;
  if (live) messages = liveVisibleMessages(messages, live);
  const key = `${messages.length}:${messages.at(-1)?.id ?? ''}:${live ? 'live' : ''}:${hiddenErrorsRevision}`;
  if (rows.dataset.key !== key) {
    const switches = captureAccountSwitches(rows);
    rows.dataset.key = key;
    const thread = { messages: page.messages, provider: state.sessions.find(task => task.id === id)?.provider ?? state.defaultProvider };
    const turns = mergeLeadTurns(withErrorTurns(groupTurns(messages)));
    const { saved, earlier } = live ? splitLiveExchange(turns) : { saved: turns, earlier: undefined };
    const env = markupEnv(id, false, thread);
    const { from, added } = tileWindows.draw(rows, saved, turn => savedTurnHtml(turn, id, false, env, thread), `${earlier ? turnLeadHtml(earlier, thread) : ''}<div class="thread-mirror-live" data-earlier-ms="${earlier?.durationMs ?? 0}">${live ? tileLiveCard(earlier, id, thread) : ''}</div>`, () => restoreAccountSwitches(rows, switches));
    rows.querySelectorAll('[id]').forEach(node => node.removeAttribute('id'));
    const byId = new Map(messages.map(message => [String(message.id), message]));
    // Only what was just drawn, the live card included: kept rows already hold their formatted text.
    for (const node of added) if (node instanceof Element) node.querySelectorAll<HTMLElement>('[data-markdown]').forEach(target => { const message = byId.get(target.dataset.markdown!); if (message) void markdown(target, message.content, scroller).catch(report); });
    watchReplies(added);
    if (from > 0 && windowShort(scroller.scrollHeight, scroller.clientHeight)) tileWindows.showMore(id, rows, scroller);
  }
  const slot = rows.querySelector<HTMLElement>('.thread-mirror-live');
  if (!slot) return;
  if (!live) { slot.replaceChildren(); return; }
  paintAccountSwitches(slot.querySelector<HTMLElement>('.live-account-switches')!, live.accountSwitches);
  const records = liveToolRecords(live);
  slot.querySelector<HTMLElement>('.turn-activity-label')!.innerHTML = records.length ? foldedLabelHtml(records) : 'Thinking';
  slot.querySelector<HTMLElement>('.thread-mirror-time')!.innerHTML = timeHtml(Date.now() - live.startedAt + Number(slot.dataset.earlierMs), true);
  const reply = slot.querySelector<HTMLElement>('.turn-card-reply')!;
  reply.hidden = !live.text;
  if (live.text && reply.dataset.source !== live.text) { reply.dataset.source = live.text; void markdown(reply.querySelector<HTMLElement>('.markdown')!, live.text, scroller).catch(report); }
}
/** What each tile view has drawn, and the steps that draw more of it (transcript-view.ts). */
const tileWindows = mountTileWindows<TranscriptTurn>({
  redraw: (id, rows, scroller) => drawTile(id, rows, scroller), turnIds, messagesOf: turns => turnsMessages(turns), fillToolBody: tool => fillToolBody(tool), report,
});
/** A tile's live card: its read-only header and reply, with the exchange a wake continues folded between them. */
function tileLiveCard(earlier: TranscriptTurn | undefined, sessionId: string, thread: Thread): string {
  const tools = earlier?.activity.flatMap(message => { const tool = message.role === 'tool' ? decodeToolActivity(message.content) : undefined; return tool ? [tool] : []; }) ?? [];
  const trace = earlier?.activity.length ? activityHtml(earlier.key, tools.length ? foldedLabelHtml(tools) : 'Earlier in this turn', `<div class="live-earlier">${savedActivityHtml(earlier.activity, activityExpanded(), thread)}</div>`) : '';
  return `<section class="turn-card is-live"><div class="turn-card-head"><span class="turn-activity-label"></span><span class="thread-mirror-time"></span></div>${trace}<div class="turn-card-reply ds-card-inner"><article class="message agent-message"><div class="message-content markdown"></div></article></div>${earlier ? cardErrorsHtml(earlier, sessionId) + cardFootHtml(sessionId, earlierChangeSets(earlier)) : ''}</section>${earlier ? notesHtml(earlier, thread) : ''}<div class="live-account-switches"></div>`;
}
/** A wake's earlier rows in the live trace: one closed line, so the card does not grow as the wake starts. */
function liveEarlierFold(earlier: TranscriptTurn, tools: ToolActivity[]): string {
  return `<details class="live-earlier" data-earlier-key="${escape(earlier.key)}"${wakeOpenTraces.has(earlier.key) ? ' open' : ''}><summary class="tool-group-summary">${tools.length ? foldedLabelHtml(tools) : 'Earlier in this turn'}${icon('chevron')}</summary><div class="tool-group-body">${savedActivityHtml(earlier.activity)}</div></details>`;
}
/** What stands above a turn's card: the user's bubble, a handoff, or a coordination label with no earlier card to join. */
function turnLeadHtml(turn: TranscriptTurn, thread = shownThread()): string {
  return (turn.user ? messageHtml(turn.user, false, true, thread) : '') + (turn.handoff ? messageHtml(turn.handoff, false, true, thread) : '') + (turn.coordination ? renderCoordination(turn.coordination) : '');
}
const notesHtml = (turn: TranscriptTurn, thread: Thread): string => turn.notes.map(message => messageHtml(message, false, true, thread)).join('');
const cardErrorsHtml = (turn: TranscriptTurn, sessionId: string): string => savedErrorsHtml(turn.errors, turn.key, sessionId, 'turn-card-errors');
const earlierChangeSets = (turn: TranscriptTurn): TurnChanges[] => [...(turn.earlierChanges ?? []), ...(turn.changes ? [turn.changes] : [])];
/** A card's one footer: a single run's snapshot as it is, several runs of a merged exchange combined (combineChanges). */
function cardFootHtml(sessionId: string, changes: TurnChanges[]): string {
  const shown = changes.filter(set => set.attributed && set.files.length);
  return shown.length > 1 ? changesFoot(sessionId, combineChanges(shown)) : shown[0] ? changesFoot(sessionId, shown[0]) : '';
}
/** Each saved turn's markup in the open thread, kept while nothing it is drawn from changed, so a redraw compares
 *  strings rather than rebuilding every drawn card. Keyed by the turn's first message: the turn is the same while it
 *  holds the same message objects (saved messages are never edited in place, and a pending one, id <= 0, is never kept)
 *  and `markupEnv` (everything else the markup reads) is unchanged. RULE: a new input to turnHtml or what it calls goes
 *  into `parts` or `markupEnv` (tests/transcript-markup.test.mjs flags any change to turnHtml's code). */
const turnMarkup = markupCache<Message>();
/** What every saved turn's markup reads from outside the app's state (transcript-host.ts markupShared). */
const turnInputs = markupShared();
/** What a turn's markup reads besides its own messages; computed once per draw. `thread` is a tile's (the open thread's otherwise). */
function markupEnv(sessionId: string, chatRows: boolean, thread = shownThread()): string {
  const task = state.sessions.find(item => item.id === sessionId);
  // A later handoff names the harness of every reply before it (historicalProvider).
  // Whether the thread is the open one: only its changes cards act (changesRow, changesFoot); a tile of it does not.
  return JSON.stringify([sessionId, sessionId === state.sessionId, chatRows, thread.provider, task?.remoteDevice?.id ?? '', chatRows && Boolean(teams.get(sessionId)), activityExpanded(), state.view === 'board', projectRunner.available(), lastHandoff(thread.messages), state.providers.length, schedulesVersion(), ...turnInputs.inputs()]);
}
/** A saved turn's markup, from turnMarkup when it still holds: the open thread's, or a tile's with its `thread`. */
function savedTurnHtml(turn: TranscriptTurn, sessionId: string, chatRows: boolean, env: string, thread?: Thread): string {
  const messages = turnMessages(turn);
  const head = messages.find(Boolean);
  if (!head || (!thread && sessionId !== state.sessionId) || messages.some(message => message && message.id <= 0)) return turnHtml(turn, sessionId, chatRows, thread);
  const parts = [...messages, ...(turn.timeline ?? []), turn.changes, ...(turn.earlierChanges ?? []), turn.key, turn.durationMs, turn.estimated, turn.workerStart, state.providers, replyOpen(turn.key), cardless(turn) && Boolean(teams.get(sessionId)), (turn as ShownTurn).dismissedErrors, (turn as ShownTurn).errorsDismissed, errorsOpenKey(turn, sessionId)];
  return turnMarkup(head, parts, env, () => turnHtml(turn, sessionId, chatRows, thread));
}
/** Which of a saved turn's error rows are expanded (errorRowHtml reads openErrors and openLiveErrors): part of what
 *  its cached markup depends on (savedTurnHtml). */
const errorsOpenKey = (turn: TranscriptTurn, sessionId: string): string => turn.errors.length ? groupErrors(turn.errors).map(group => openErrors.has(`${turn.key}|${group.key}`) || liveErrorOpen(group, sessionId, false) ? '1' : '0').join('') : '';
/** A turn drawn without a card (no activity, reply or error): its workers slot is a row of its own (workerSlot). */
const cardless = (turn: TranscriptTurn): boolean => !turn.activity.length && !turn.final && !turn.errors.length && !(turn as ShownTurn).errorsDismissed;
function turnHtml(turn: TranscriptTurn, sessionId: string, chatRows: boolean, thread = shownThread()): string {
  const lead = turnLeadHtml(turn, thread);
  const notes = notesHtml(turn, thread);
  if (chatRows) return lead + (turn.activity.length ? savedTurnActivity(turn.key, turnLabel(turn.durationMs, turn.estimated), turn.activity, thread) : '') + savedErrorsHtml(turn.errors, turn.key, sessionId) + dismissedNoteHtml(turn) + (turn.final ? messageHtml(turn.final, turn.activity.some(message => message.role === 'tool'), true, thread) : '') + notes + workerSlot(turn, sessionId, true) + changesRow(sessionId, turn.changes);
  if (cardless(turn)) return lead + notes + workerSlot(turn, sessionId, true) + changesRow(sessionId, turn.changes);
  return lead + turnCardHtml(turn, sessionId, thread) + notes;
}
function turnCardHtml(turn: TranscriptTurn, sessionId: string, thread: Thread): string {
  const decoded = turn.activity.map(message => message.role === 'tool' ? decodeToolActivity(message.content) : undefined);
  const tools = decoded.filter((tool): tool is ToolActivity => Boolean(tool)), steps = decoded.every(Boolean);
  const time = timeHtml(turn.durationMs);
  const label = tools.length ? foldedLabelHtml(tools) : escape(turn.final ? 'Replied' : turn.errors.length || (turn as ShownTurn).errorsDismissed ? 'Stopped' : 'Worked');
  const head = turn.activity.length
    ? activityHtml(turn.key, label, savedActivityHtml(turn.activity, steps || activityExpanded(), thread, true), { steps, meta: time })
    : `<div class="turn-card-head"><span class="turn-activity-label">${label}</span>${time}</div>`;
  const final = turn.final;
  const reply = final ? replyHtml(messageHtml(final, true, false, thread), turn.key, messageActionsHtml(final.sessionId, final.id, final.id > 0), false, String(final.id)) : '';
  return `<section class="turn-card" data-turn-card="${escape(turn.key)}">${head}${reply}${workerSlot(turn, sessionId)}${cardErrorsHtml(turn, sessionId)}${dismissedNoteHtml(turn)}${cardFootHtml(sessionId, earlierChangeSets(turn))}</section>`;
}
/** On a first visit, the previous thread's rows stay (inert, dimmed to 0.7) for at most
 *  TRANSCRIPT_HOLD_MS while the page loads; then the loading line takes over at once. */
const TRANSCRIPT_HOLD_MS = 150;
/** Whether the open thread's rows were drawn with a team: a turn with no card draws its workers slot only then. A
 *  thread found to have none reads as before its team was known, so learning that redraws nothing. */
let rowsTeam = false;
/** The open thread's team became known (or went) after its rows drew: rows whose markup depends on it redraw (drawRows
 *  keeps the rest); otherwise the workers just move into their slots. */
function syncTeamRows(): void {
  if (transcriptRows === state.sessionId && rowsTeam !== Boolean(teams.get(state.sessionId))) renderTranscript(); else refreshTeamProgress();
}
let transcriptRows: string | undefined, transcriptHold: { expired: boolean; timer: number } | undefined;
function holdTranscript(transcript: HTMLElement, id: string, rows: string | undefined): boolean {
  if (transcriptHold) { if (transcriptHold.expired) return false; transcriptRows = rows; return true; }
  if (!rows || rows === id || !holdDim(transcript)) return false;
  transcriptHold = { expired: false, timer: window.setTimeout(() => { if (transcriptHold) { transcriptHold.expired = true; renderTranscript(); } }, TRANSCRIPT_HOLD_MS) };
  transcriptRows = rows;
  return true;
}
function releaseTranscriptHold(transcript: HTMLElement, settle: boolean): void {
  if (!transcriptHold) return;
  clearTimeout(transcriptHold.timer); transcriptHold = undefined;
  releaseHold(transcript, settle);
}
/** What a reader had set in a row: its folds, change cards and open account notes. */
type RowViews = { turns: TurnView[]; groups: ToolGroupView[]; tools: Map<string, ToolView>; changes: Map<string, boolean>; notes: AccountSwitchView[] };
/** What the reader set in a row; undefined for a row they never touched, which redraws as it was. */
const rowViewsKept = rowViews<RowViews>(transcriptScroller, roots => ({
  turns: roots.flatMap(root => captureTurns(root)), groups: roots.flatMap(captureToolGroups),
  tools: new Map(roots.flatMap(root => [...captureTools(root)])), changes: new Map(roots.flatMap(root => [...captureChangeCards(root)])),
  notes: roots.flatMap(root => root.matches('details[data-account-switch]') ? [{ node: root as HTMLDetailsElement, focused: false }] : captureAccountSwitches(root)).filter(note => note.node.open),
}), (root, views) => { restoreTurns(root, views.turns); restoreToolGroups(root, views.groups); restoreChangeCards(root, views.changes); restoreTools(root, views.tools); });
const captureRowViews = rowViewsKept.capture, restoreRowViews = rowViewsKept.restore;
const turnsMessages = (turns: readonly TranscriptTurn[], all = false): (Message | undefined)[] => turns.flatMap(turn => [all || !lazyReply(turn) ? turn.final : undefined, ...turn.activity]);
/** What the transcript has drawn, and the steps that widen and narrow it (transcript-view.ts). */
const transcriptView = mountTranscriptView<TranscriptTurn, RowViews>({
  scroller: transcriptScroller,
  openId: () => state.sessionId,
  drawsWhole: () => Boolean(botForThread()),
  elsewhere: () => Boolean(state.sharedChannelId),
  visible: transcriptVisible,
  savedTurns: sessionId => shownTurns(sessionId, false).saved,
  turnIds,
  messagesOf: (turns, all) => turnsMessages(turns, all),
  markup: sessionId => { const env = markupEnv(sessionId, false); return turn => savedTurnHtml(turn, sessionId, false, env); },
  captureViews: captureRowViews,
  restoreViews: restoreRowViews,
  prepare: (fragment, back) => {
    const swaps = restoreAccountSwitches(fragment, back.flatMap(views => views?.notes ?? []));
    // Formatted in the fragment, in one pass: already-prepared text lands before anything lays out.
    paintSavedMarkdown(fragment, state.messages, new Map(), workspaceContext(), followTranscript, transcriptScroller);
    return swaps;
  },
  redrawRow,
  rowsChanged: workersOnly => { refreshTeamProgress(); if (!workersOnly) decorateTranscript(); },
  watch: (nodes, defer) => measureReplies(nodes, defer),
  placed: top => { lastTranscriptTop = top; },
  trimBlocked: () => transcriptGap() > 2 || Boolean(tailRoom) || tailBridging || Boolean(followFrame) || threadFind.isOpen(),
  findInput: () => document.querySelector<HTMLInputElement>('.thread-find input'),
  findCount: (turn, query) => turnMatches(turn, query),
  prepareCounts: turns => findCounts.prepare(turns),
  deferredReplies: () => lazyReplies.pending().map(el => ({ role: 'assistant', content: savedMarkdownSources.get(el) ?? '' })),
  paintDeferred: () => lazyReplies.flush(el => markdownCache.get(savedMarkdownSources.get(el) ?? '') !== undefined),
  // A page that failed is asked for again only by the reader scrolling, never by every redraw.
  fetchOlder: () => { if (state.messages.find(message => message.id > 0)?.id !== olderFailedAt) void loadOlderMessages(true, false); },
  report,
});
let rowsSeed: { sessionId: string; first: string | null } | undefined;
/** The last threads left, kept to reattach (transcript-view.ts). Bot threads are not kept: their decorations span rows. */
const leftRows = leftRowsCache<RowViews>();
function keepLeftRows(): void {
  const view = transcriptView.view, task = state.sessions.find(item => item.id === view.sessionId);
  if (task && !sidebarBots.some(bot => bot.projectId === task.projectId) && rowsIntact(transcriptScroller, view.rows)) leftRows.keep(view.sessionId, { rows: view.rows, trimmed: view.trimmed, keys: view.ids.slice(drawnFrom(view)).map(ids => ids.at(-1)!) });
}
/** A tile opened in the pane. A reader who left the bottom of the tile keeps their place, so the pane draws from the
 *  tile's oldest drawn turn; when the pane's page does not hold that turn (it keeps fewer messages), the same scroll
 *  offset would land on other content, so the pane stays at its bottom instead. */
async function openFromTile(id: string, scrollTop: number | undefined): Promise<void> {
  const tile = scrollTop === undefined ? undefined : tileWindows.ofThread(id);
  const anchor = tile?.ids[drawnFrom(tile)]?.[0];
  rowsSeed = tile ? { sessionId: id, first: tile.first } : undefined;
  await selectSession(id);
  const view = transcriptView.view;
  if (scrollTop === undefined || anchor === undefined || view.sessionId !== id || state.sessionId !== id || !view.ids[drawnFrom(view)]?.includes(anchor)) return;
  transcriptScroller.scrollTop = scrollTop; releaseTranscript();
}
/** A thread's turns as drawn, and what a live card takes over from the last one. */
function shownTurns(sessionId: string, bot: boolean): { saved: TranscriptTurn[]; earlier: TranscriptTurn | undefined; running: Stream | undefined } {
  const grouped = withErrorTurns(groupTurns(visibleMessages(sessionId)));
  const turns = bot ? grouped : mergeLeadTurns(grouped);
  // A lead's wake run takes the exchange it continues into its live card, so one reply is one card while it streams too.
  const running = bot || wakeHolds.has(sessionId) ? undefined : state.streams.get(sessionId) ?? finishingStreams.get(sessionId)?.stream;
  const { saved, earlier } = running ? splitLiveExchange(turns) : { saved: turns, earlier: undefined };
  return { saved, earlier, running };
}
function renderTranscript(preservePosition = false): void {
  closeContentMenus();
  const open = session();
  showThreadScene(open && !open.draft && !state.sharedChannelId ? open.id : null);
  const heldRows = transcriptRows; transcriptRows = undefined;
  syncNewTaskPage();
  const transcript = $('#transcript');
  transcript.removeAttribute('aria-busy');
  // Another thread's rows are about to go: nothing in them carries over, so don't read them (it forces their layout).
  const leaving = Boolean(transcriptView.view.sessionId) && transcriptView.view.sessionId !== open?.id && document.getElementById('stream-region')?.dataset.sessionId !== open?.id;
  if (leaving) keepLeftRows();
  const toolViews = leaving ? new Map<string, ToolView>() : captureTools(transcript), groupViews = leaving ? [] : captureToolGroups(transcript), turnViews = leaving ? [] : captureTurns(transcript), changeViews = leaving ? new Map<string, boolean>() : captureChangeCards(transcript), scrollTop = transcript.scrollTop;
  const switches = captureAccountSwitches(transcript);
  const liveTurn = transcript.querySelector<HTMLElement>('#stream-region .live-activity[open]:not([data-folded])');
  const unfolded = liveTurn && !liveTurnStaysOpen(liveTurn) ? captureTurns(liveTurn.parentElement!, true)[0] : undefined;
  const readingTool = readingTranscriptTool();
  if (state.sharedChannelId) {
    releaseTranscriptHold(transcript, false);
    const channel = state.sharedChannelDetail;
    transcript.innerHTML = channel ? sharedChannelThreadHtml(channel, sidebarBots) : '<p class="history-notice" role="status">Loading channel…</p>';
    if (channel) {
      for (const node of transcript.querySelectorAll<HTMLElement>('.bc-message-text[data-message-id]')) {
        const message = channel.messages.find(item => item.id === node.dataset.messageId);
        if (message) void markdown(node, message.text, transcript).catch(report);
      }
      const history = transcript.querySelector<HTMLElement>('.bc-history');
      if (history) {
        // After "Show earlier messages", the rows the user was reading stay where they were.
        history.scrollTop = state.sharedChannelFromBottom !== null ? history.scrollHeight - state.sharedChannelFromBottom : state.sharedChannelAtBottom ? history.scrollHeight : state.sharedChannelScrollTop;
        state.sharedChannelFromBottom = null;
      }
    }
    return;
  }
  const s = session();
  if (tailRoom && s?.id !== tailSession) setTailRoom(0);
  botThread.noteThread(s?.id ?? '');
  if (!s && !projectsListed) { releaseTranscriptHold(transcript, false); transcript.innerHTML = ''; return; }
  if (!s) { releaseTranscriptHold(transcript, false); transcript.innerHTML = `<div class="welcome"><span class="welcome-mark" aria-hidden="true">${icon('bamboo')}</span><h1>${project() ? 'No task selected' : 'Choose a project'}</h1><button class="primary-button" data-action="${project() ? 'new-task' : 'add-project'}">${icon('plus')}${project() ? 'Start a task' : 'Open a project'}</button></div>`; return; }
  if ((state.messagesLoading || state.messagesError) && !state.streams.has(s.id) && !finishingStreams.has(s.id)) {
    if (!state.messagesError && holdTranscript(transcript, s.id, heldRows)) return;
    // After a hold the line shows at once (the 150 ms wait is spent); a line already up keeps its fade.
    const afterHold = Boolean(transcriptHold?.expired);
    releaseTranscriptHold(transcript, false);
    if (state.messagesError) transcript.innerHTML = '<p class="history-notice" role="status"><span>Unable to load this task.</span> <button type="button" class="secondary-button" data-action="retry-task-load">Retry</button></p>';
    else if (!(transcript.childElementCount === 1 && transcript.firstElementChild!.classList.contains('history-loading'))) transcript.innerHTML = `<p class="history-notice history-loading${afterHold ? ' after-hold' : ''}" role="status">Loading conversation…</p>`;
    return;
  }
  releaseTranscriptHold(transcript, true);
  if (state.view === 'board' && newTaskView()) {
    transcript.innerHTML = '<p class="pending-comments">Start this task when you’re ready. Agent updates and your replies will appear here.</p><div id="stream-region"></div>';
    return;
  }
  const bot = botForThread();
  if (newTaskView() && bot && !isRunning(s.id)) {
    transcript.innerHTML = `${botThread.welcomeHtml(bot)}<div id="stream-region"></div>`;
    botThread.decorateTranscript(transcript, bot, s.id, state.messages, botSwitches.get(s.id) ?? [], botMessages.get(s.id) ?? []);
    if (!botThreadMetaLoaded.has(s.id)) void refreshBotThreadMeta(bot, s.id);
    return;
  }
  if (newTaskView() && chatTask(s)) {
    transcript.innerHTML = `<div class="new-task-welcome chat-welcome"><span class="new-task-mark" aria-hidden="true">${icon('bamboo')}</span><h1>What’s on your mind?</h1><button id="welcome-project" class="welcome-project" data-action="change-task-project" aria-haspopup="dialog" aria-expanded="false">Move to project…</button></div><div id="stream-region"></div>`;
    return;
  }
  if (newTaskView() && !bot) {
    const name = project()?.name ?? 'this project';
    transcript.innerHTML = `<div class="new-task-welcome"><span class="new-task-mark" aria-hidden="true">${icon('bamboo')}</span><h1 aria-label="What should we build in ${escape(name)}?">What should we build in <button id="welcome-project" class="welcome-project" data-action="change-task-project" aria-label="Change task project" aria-haspopup="dialog" aria-expanded="false" title="${escape(project()?.path)}" ${s.worktreePath ? 'disabled' : ''}>${escape(name)}</button>?</h1></div><div id="stream-region"></div>`;
    return;
  }
  const { saved, earlier, running } = shownTurns(s.id, Boolean(bot));
  if (running) running.earlier = earlier && { turn: earlier, tools: earlier.activity.flatMap(message => { const tool = message.role === 'tool' ? decodeToolActivity(message.content) : undefined; return tool ? [tool] : []; }) };
  // Whether the earlier rows show is the reader's: a trace open before the wake, or the fold as they left it.
  if (earlier && turnViews.some(view => view.key === earlier.key && view.open)) wakeOpenTraces.add(earlier.key);
  const earlierFold = transcript.querySelector<HTMLDetailsElement>('#stream-region .live-earlier');
  if (earlierFold) { if (earlierFold.open) wakeOpenTraces.add(earlierFold.dataset.earlierKey!); else wakeOpenTraces.delete(earlierFold.dataset.earlierKey!); }
  // A run that just ended hands its live card over to the saved one in place: the reply stays open and the footer folds in.
  const liveRegion = document.getElementById('stream-region');
  const liveCard = liveRegion?.dataset.sessionId === s.id ? liveRegion.querySelector<HTMLElement>('.turn-card.is-live') : null;
  const shownCards = liveCard ? new Set([...transcript.querySelectorAll<HTMLElement>('[data-turn-card]')].map(card => card.dataset.turnCard)) : undefined;
  // finishResponse measures the live card before the composer lets go of the steer row (which clamps the scroll).
  // Open the saved reply before layout can clamp the paused reader, and transfer its live reading anchor.
  const completed = liveCard && !running ? saved.at(-1) : undefined;
  if (completed?.final) {
    openReply(completed.key);
    const reply = liveCard!.querySelector<HTMLElement>('.turn-card-reply');
    if (reply) reply.dataset.turnKey = `reply:${completed.key}`;
  }
  const restoreAnchor = preservePosition || !stickToBottom ? captureTranscriptAnchor(transcript) : undefined;
  const liveRect = liveCard ? handoffRect ?? liveCard.getBoundingClientRect() : undefined; handoffRect = undefined;
  const focusRole = liveCard ? focusedRole(liveCard) : undefined;
  // A wake's live card already shows the exchange's footer; the saved card's replaces it in place rather than fading in.
  const liveFoot = Boolean(liveCard?.querySelector(':scope > .turn-card-foot'));
  const liveTrace = liveCard?.querySelector<HTMLDetailsElement>(':scope > details.turn-activity'), liveTraceOpen = Boolean(liveTrace?.open && liveTrace.dataset.folded === undefined);
  // A trace that folded as the reply started and the reader opened again stays open in the saved card.
  const traceReopened = Boolean(liveTrace?.open && liveTrace.dataset.folded !== undefined && liveTrace.dataset.closing === undefined);
  // Back on a thread left a moment ago: its rows go back in first, and drawRows keeps every one whose markup still matches.
  const left = leaving && !bot ? leftRows.take(s.id) : undefined;
  if (left) transcript.replaceChildren(...left.rows.flatMap(row => row.nodes));
  const previousMarkdown = new Map([...transcript.querySelectorAll<HTMLElement>('[data-markdown]')]
    .map(node => [node.dataset.markdown!, node]));
  const emptyHtml = state.messages.length === 0 && !bot ? '<div class="empty-conversation"><h2>What would you like to do?</h2><div class="prompt-suggestions"><button data-action="suggest" data-text="Explore this project and explain its architecture.">Explore this project '+icon('chevron')+'</button><button data-action="suggest" data-text="Review the current changes for bugs and suggest improvements.">Review my changes '+icon('chevron')+'</button></div></div>' : '';
  // A thread opens from its newest turns; a redraw keeps the window and every row that did not change.
  // Bot threads draw whole: bot-thread.ts decorates and groups the transcript's children across all of them.
  const rowsView = transcriptView.view, intact = rowsView.sessionId === s.id && rowsIntact(transcript, rowsView.rows);
  // A running thread draws before its page arrives: the seed waits for that page, and those rows are not a window yet.
  const pageIn = !state.messagesLoading && saved.length > 0;
  const ids = saved.map(turnIds);
  // A tile's anchor this page does not list (it keeps fewer messages) opens from the newest turns, as any open does.
  const seed = pageIn && rowsSeed?.sessionId === s.id && (rowsSeed.first === null || ids.some(list => list.includes(rowsSeed!.first!))) ? rowsSeed.first : undefined;
  if (pageIn || rowsSeed?.sessionId !== s.id) rowsSeed = undefined;
  const from = bot ? 0 : windowStart(ids, intact ? rowsView.first : seed), env = markupEnv(s.id, Boolean(bot));
  const { rows: drawn, added } = drawRows(transcript, intact && !bot ? rowsView.rows : left?.rows ?? [], saved.slice(from).map(turn => savedTurnHtml(turn, s.id, Boolean(bot), env)), `${emptyHtml}${earlier ? turnLeadHtml(earlier) : ''}<div id="stream-region"></div><div id="team-progress-host" class="turn-changes-row" hidden></div>`);
  // Folds the reader opened in rows of a widened window the reopened one leaves out come back with those rows.
  const lastIds = left ? new Map(ids.map((list, index) => [list.at(-1)!, index])) : undefined;
  const trimmed = intact ? rowsView.trimmed : left ? leftViews(left, drawn, key => (lastIds!.get(key) ?? from) < from, captureRowViews) : new Map<string, RowViews>();
  transcriptView.view = { sessionId: s.id, first: windowAnchor(ids, from), ids, turns: saved, rows: state.messagesLoading ? [] : drawn, trimmed };
  paintSavedMarkdown(transcript, state.messages, previousMarkdown, workspaceContext(), followTranscript);
  watchReplies(added);
  reusableMarkdown = previousMarkdown;
  renderStream();
  reusableMarkdown = undefined;
  refreshTeamProgress();
  restoreTurns(transcript, turnViews);
  if (unfolded && !shownCards) foldSavedTurn(transcript, unfolded);
  restoreToolGroups(transcript, groupViews);
  restoreChangeCards(transcript, changeViews);
  restoreTools(transcript, toolViews);
  decorateTranscript();
  if (restoreAnchor) restoreAnchor();
  else if (readingTool) transcript.scrollTop = scrollTop;
  else followTranscript();
  lastTranscriptTop = transcript.scrollTop;
  // After every restore and the pin, so the saved card is measured where it will stay.
  if (shownCards && liveRect) handOffCard(transcript, shownCards, liveRect, !restoreAnchor && !readingTool && stickToBottom, liveTraceOpen, focusRole, traceReopened, liveFoot);
  // A note the reader had open goes back in place of the redrawn one, so the row lists the node that is on screen.
  transcriptView.view = { ...transcriptView.view, rows: swapRowNodes(transcriptView.view.rows, restoreAccountSwitches(transcript, switches)) };
  if (bot) {
    botThread.decorateTranscript(transcript, bot, s.id, state.messages, botSwitches.get(s.id) ?? [], botMessages.get(s.id) ?? []);
    if (!botThreadMetaLoaded.has(s.id)) void refreshBotThreadMeta(bot, s.id);
  }
  transcriptView.fill();
  transcriptView.syncFarRows();
  transcriptRows = s.id; rowsTeam = Boolean(teams.get(s.id));
}
/** The live card is gone and the saved one stands in its place, in the same task: its reply stays open and the
 * footer fades in. If the live trace was still open (no reply folded it), the saved trace opens in its place and
 * folds (foldInPlace), unless the reader is in it (then it stays open). Pinned, the card's top stays where the live
 * card's was and blank room under it (`tailRoom`) takes any height given up, so nothing above it moves. */
// ponytail: a key stays if the run's card never hands off (a thread switch); a few short strings per wake.
/** Saved traces the reader had open when a wake took their card into the live one; they stay open when it hands back. */
const wakeOpenTraces = new Set<string>();
/** Formatted rows renderTranscript just took down, for the live card's earlier rows to reuse. */
let reusableMarkdown: Map<string, HTMLElement> | undefined;
function handOffCard(transcript: HTMLElement, shown: Set<string | undefined>, live: DOMRect, pinned: boolean, traceOpen: boolean, focus?: string, reopened = false, hadFoot = false): void {
  const card = [...transcript.querySelectorAll<HTMLElement>('[data-turn-card]')].at(-1);
  if (!card || shown.has(card.dataset.turnCard)) return;
  const trace = card.querySelector<HTMLDetailsElement>(':scope > details.turn-activity');
  stopTailEase();
  // A reader in the trace (a focused step) keeps it: the saved trace stays open, with no fold, and the same step is focused.
  const reading = Boolean((wakeOpenTraces.delete(card.dataset.turnCard!) || reopened || focus?.startsWith('[data-tool-key')) && trace);
  if (reading) trace!.open = true;
  if (focus) refocusCard(card, focus);
  const reply = card.querySelector<HTMLElement>(':scope > .turn-card-reply');
  if (reply) keepReplyOpen(reply);
  if (pinned) { cancelAnimationFrame(followFrame); followFrame = 0; }
  if (traceOpen && trace && !trace.open) {
    trace.open = true;
    foldInPlace(card, trace, live, pinned);
    if (!hadFoot) fadeInFoot(card);
    return;
  }
  if (!pinned) { bridgeCard(card, live.height); return; }
  // The card's top stays where the live card's was. Blank room under it takes what the composer let go of (or a
  // shorter saved card gives up); what a taller card (the footer) runs past the window grows in as the follow keeps up.
  const saved = card.getBoundingClientRect(), target = Math.max(0, transcriptScroller.scrollTop + saved.top - live.top);
  const room = target + transcriptScroller.clientHeight - (transcriptScroller.scrollHeight - tailRoom);
  tailSession = state.sessionId;
  // The footer (what the saved card adds to the live one) eases in on the bridge's timing, and the room under the card gives way (or grows) as it does, so the
  // scroll end holds and nothing above moves; what runs past the window the follow takes.
  const delta = Math.round(saved.height - live.height);
  const timing = bridgeCard(card, delta ? live.height : saved.height + Math.min(0, room));
  const end = Math.max(0, room), start = timing && delta ? Math.max(0, room + delta) : end;
  setTailRoom(start);
  transcriptScroller.scrollTop = target;
  lastTranscriptTop = transcriptScroller.scrollTop;
  if (timing && start !== end) growTailRoom(start, end, timing, () => {}, true); else followTranscript();
}
/** The control in the live card that has focus, as a selector the saved card answers (header, a trace step, Read
 * more, Copy, Fork, the footer), so the handoff gives focus back instead of dropping it to the page. */
const CARD_CONTROLS = [':scope > details.turn-activity > .turn-activity-summary', '.turn-card-reply [data-message-action="copy"]', '.turn-card-reply [data-message-action="fork"]', '.turn-card-more', '.turn-card-foot-open'];
function focusedRole(card: HTMLElement): string | undefined {
  const active = document.activeElement;
  if (!(active instanceof HTMLElement) || !card.contains(active)) return;
  const step = active.matches('summary') ? active.parentElement?.closest<HTMLElement>('[data-tool-key]') : null;
  if (step) return `[data-tool-key="${CSS.escape(step.dataset.toolKey!)}"] > summary`;
  return CARD_CONTROLS.find(selector => active.matches(selector.replace(':scope > ', '.turn-card > '))) ?? CARD_CONTROLS[0];
}
/** Focuses that control in the saved card, else its header (a step folded out of reach has no focus to take). */
function refocusCard(card: HTMLElement, selector: string): void {
  // A tool the reader was in has already been restored (restoreTools); only focus the page dropped is taken back.
  if (document.activeElement && document.activeElement !== document.body) return;
  for (const target of [card.querySelector<HTMLElement>(selector), card.querySelector<HTMLElement>(CARD_CONTROLS[0])]) {
    // A step inside a folded group of a narrated turn: its group opens so the step can take focus.
    for (let group = target?.parentElement?.parentElement?.closest<HTMLDetailsElement>('details.tool-group'); group && card.contains(group); group = group.parentElement?.closest<HTMLDetailsElement>('details.tool-group')) group.open = true;
    target?.focus({ preventScroll: true });
    if (target && document.activeElement === target) return;
  }
}
/** Folds the saved card's trace starting from the live card's height, so its bottom never steps: the card closes from
 * there to its folded height on the fold's own timing (`holdCard`). Pinned, its top stays where the live card's was
 * and the height it gives up (and any the composer just let go of) grows as blank room under it on the same timing
 * (the room is `#transcript::after`), so nothing above it moves; the room stays until content or the reader takes it.
 * An off-screen card comes down to the reading line so the fold cannot leave only blank room in view. */
function foldInPlace(card: HTMLElement, trace: HTMLDetailsElement, live: DOMRect, pinned: boolean): void {
  const open = card.offsetHeight, total = transcriptScroller.scrollHeight, from = tailRoom;
  trace.open = false;
  const shut = card.offsetHeight; trace.open = true;
  foldTurn(trace, true);
  const fold = trace.getAnimations({ subtree: true }).find(animation => ((animation.effect as KeyframeEffect | null)?.target as Element | null)?.parentElement === trace);
  const timing = fold?.effect?.getTiming();
  if (timing) holdCard(card, live.height, shut, timing);
  if (!pinned) return;
  tailSession = state.sessionId;
  // The room must let the scroll reach the held top with the card at its starting height.
  const shown = timing ? live.height : shut, keepTop = Math.max(live.top, readingLine());
  const target = Math.max(0, transcriptScroller.scrollTop + card.getBoundingClientRect().top - keepTop);
  const start = Math.max(from, target + transcriptScroller.clientHeight - (total - open - from) - shown), end = Math.max(0, start + shown - shut);
  setTailRoom(Math.max(start, end));
  transcriptScroller.scrollTop = target;
  lastTranscriptTop = transcriptScroller.scrollTop;
  if (!timing) { setTailRoom(end); return; }
  growTailRoom(start, end, timing);
}
/** Drops a room animation in flight (one the run's end or a later change overtook): the room stands at its set height. */
function stopTailEase(): void {
  const ease = tailEase;
  tailEase = undefined; tailBridging = false; tailFollows = false;
  ease?.cancel();
}
/** Eases the blank room from `from` to `to` (already set as the room) on `timing`, holding the follow meanwhile. */
let tailEase: Animation | undefined;
function growTailRoom(from: number, to: number, timing: EffectTiming, done = () => {}, follow = false): void {
  stopTailEase();
  tailBridging = true; tailFollows = follow;
  const room = transcriptScroller.animate([{ height: `${from}px` }, { height: `${to}px` }], { duration: timing.duration, easing: timing.easing, pseudoElement: '::after' });
  tailEase = room;
  room.onfinish = room.oncancel = () => {
    if (tailEase !== room) return;
    tailEase = undefined; tailBridging = false; tailFollows = false;
    if (tailSession === state.sessionId && tailRoom) setTailRoom(to);
    followTranscript(); done();
  };
}
// Show less near the end of the thread: the height the reply gives up past what the scroll can lose becomes blank room
// on the clamp's own timing, so the reply's top stays where it is; scrolling up or the next turn takes the room back.
onReplyCollapse((shrink, timing) => {
  const room = Math.max(0, Math.round(shrink - transcriptGap()));
  if (!room) return;
  const from = tailRoom;
  tailSession = state.sessionId;
  setTailRoom(from + room);
  if (timing) growTailRoom(from, tailRoom, timing);
});
/** A side thread's saved turns: the By the way panel keeps the plain chat rows, since its live turn has no card to hand off to. */
function turnRowsHtml(sessionId: string, visible: Message[], thread = shownThread()): string {
  return withErrorTurns(groupTurns(visible)).map(turn => turnHtml(turn, sessionId, true, thread)).join('');
}
/** Formats saved answers, reusing nodes whose source is unchanged so nothing reparses. */
function paintSavedMarkdown(root: ParentNode, messages: Message[], previousMarkdown: Map<string, HTMLElement>, context: FileLinkContext, follow: () => void, scroller = root as HTMLElement): void {
  const byId = new Map(messages.map(message => [String(message.id), message]));
  root.querySelectorAll<HTMLElement>('[data-markdown]').forEach(el => {
    const message = byId.get(el.dataset.markdown!);
    if (!message) return;
    const previous = previousMarkdown.get(el.dataset.markdown!);
    if (previous && savedMarkdownSources.get(previous) === message.content && !staleMarkdown.has(previous)) {
      // Prepending history must not reparse responses the reader already loaded; a kept row already holds its own.
      if (previous !== el) el.replaceWith(previous);
      bindFileLinkContext(previous, context);
    } else {
      savedMarkdownSources.set(el, message.content);
      staleMarkdown.delete(el);
      bindFileLinkContext(el, context);
      const lazy = message.content.length > LAZY_REPLY_CHARS && markdownCache.get(message.content) === undefined && el.closest('.turn-card-reply') && !el.closest('.turn-card-reply[data-open]');
      if (lazy && lazyReplies.defer(el, follow)) return;
      paintMarkdown(el, message.content, scroller, follow);
    }
  });
}
/** Following skips the paint's own pin (the ResizeObserver pins before paint); pin now so no task sees the gap. A
 *  paint that finished while its node was out of the document wrote nothing: the node is marked, and formatted again
 *  when it comes back (a thread's rows kept across a switch). */
function paintMarkdown(el: HTMLElement, content: string, scroller: HTMLElement, follow: () => void): void {
  void markdown(el, content, scroller).then(() => { if (!el.isConnected) staleMarkdown.add(el); follow(); }, report);
}
const staleMarkdown = new WeakSet<HTMLElement>();
/** Long folded replies, formatted as they near the reader (transcript-window.ts LAZY_REPLY_CHARS). */
const lazyReplies = lazyMarkdown(transcriptScroller, (el, follow) => { const content = savedMarkdownSources.get(el); if (content !== undefined) paintMarkdown(el, content, transcriptScroller, follow); }, el => leftRows.holds(el));
/** Whether a saved reply is left to format lazily rather than ahead of its step (see LAZY_REPLY_CHARS). */
const lazyReply = (turn: TranscriptTurn): boolean => Boolean(turn.final && turn.final.content.length > LAZY_REPLY_CHARS && !replyOpen(turn.key));
/** `lazy` leaves each tool's body to `fillToolBody`. Narration is always drawn, so Find can reach it inside a closed fold. */
function savedActivityHtml(messages: Message[], expanded = activityExpanded(), thread = shownThread(), lazy = false): string {
  return groupToolRuns(messages, message => message.role === 'tool' ? savedToolKey(message) : undefined)
    .map(run => {
      if (run.kind !== 'tools') return messageHtml(run.item, false, false, thread);
      return renderToolGroup(run.items.map(message => ({ key: savedToolKey(message), content: message.content, id: String(message.id) })), expanded, false, lazy);
    }).join('');
}
/** Draws a saved tool's body the first time it is needed, from the messages of the view it is in: the open thread's
 *  `state.messages` in the transcript, the turns a tile drew in a tile. */
function fillToolBody(tool: HTMLDetailsElement): void {
  const rows = tool.closest<HTMLElement>('.thread-mirror-rows');
  fillDrawnToolBody(tool, rows ? tileWindows.of(rows)?.turns.flatMap(turn => turn.activity) ?? [] : state.messages);
}
/** Find's in-memory counts (transcript-host.ts findCounter). */
const findCounts = findCounter({ userHtml: message => messageHtml(message, false, false), version: schedulesVersion });
const turnMatches = findCounts.turn;
/** A turn of only tool calls folds to its summary sentence and mark stack (`Ran 2 searches and read 3 sources`),
 * opening onto the step rail; turns with narration keep `Worked for …` over their groups. */
function savedTurnActivity(key: string, label: string, activity: Message[], thread = shownThread()): string {
  const tools = activity.map(message => message.role === 'tool' ? decodeToolActivity(message.content) : undefined);
  if (tools.some(tool => !tool)) return activityHtml(key, escape(label), savedActivityHtml(activity, activityExpanded(), thread));
  return activityHtml(key, foldedLabelHtml(tools as ToolActivity[]), savedActivityHtml(activity, true, thread), { steps: true, title: label });
}
function foldedLabelHtml(tools: ToolActivity[]): string {
  // Tallies after the sentence (`2 running`, `1 failed`, `1 blocked`, `1 interrupted`): only failures read as a failure.
  const [sentence, ...tallies] = summarizeTools(tools).split(' · ');
  const status = tallies.map(tally => `<span class="tool-group-status${/\bfailed$/.test(tally) ? ' has-failure' : /\b(blocked|denied|interrupted)$/.test(tally) ? ' is-blocked' : /\brunning$/.test(tally) ? ' is-running' : ''}"><span class="tool-group-sep"> · </span>${escape(tally)}</span>`).join('');
  // The sentence ellipsizes; the tallies after it never shrink, so a narrow header still says what failed.
  return `<span class="trace-summary-text"><span class="trace-summary-sentence">${escape(sentence)}</span>${status}</span>${toolStackHtml(tools)}`;
}
function savedToolKey(message: Message): string {
  const tool = decodeToolActivity(message.content);
  return tool ? 'tool:' + tool.id : 'message:' + message.id;
}
function activityExpanded(): boolean { return localStorage.getItem('pandacode.activityExpanded') === 'true'; }
/** `labelHtml` is escaped by the caller. `steps` turns hang their calls straight off the rail (no group headers). */
function activityHtml(key: string, labelHtml: string, body: string, options: { live?: boolean; steps?: boolean; title?: string; meta?: string } = {}): string {
  const { live = false, steps = live, title, meta = '' } = options;
  const open = live || state.view === 'board' || activityExpanded();
  return `<details class="turn-activity${live ? ' live-activity' : ''}${steps ? ' is-steps' : ''}" data-turn-key="${escape(key)}"${open ? ' open' : ''}><summary class="turn-activity-summary"${title ? ` title="${escape(title)}"` : ''}><span class="turn-activity-label">${labelHtml}</span>${meta}${icon('chevron')}</summary><div class="turn-activity-body">${body}</div></details>`;
}
type ToolGroupView = { key: string; toolKeys: string[]; open: boolean; focused: boolean };
function captureToolGroups(root: ParentNode): ToolGroupView[] {
  // Live groups always show their steps, so their open state carries over only around a tool the reader opened.
  return [...root.querySelectorAll<HTMLDetailsElement>('.tool-group')].filter(group => !group.closest('.live-tools') || readingTrace(group)).map(group => ({
    key: group.dataset.toolGroupKey!, open: group.open, focused: document.activeElement === group.querySelector('.tool-group-summary'),
    toolKeys: [...group.querySelectorAll<HTMLElement>('[data-tool-key]')].map(tool => tool.dataset.toolKey!),
  }));
}
function restoreToolGroups(root: ParentNode, views: ToolGroupView[]): void {
  if (!views.length) return;
  const find = viewIndex(views);
  root.querySelectorAll<HTMLDetailsElement>('.tool-group').forEach(group => {
    const view = find(group.dataset.toolGroupKey, [...group.querySelectorAll<HTMLElement>('[data-tool-key]')].map(tool => tool.dataset.toolKey));
    if (!view) return;
    if (group.open !== view.open) group.open = view.open;
    if (view.focused) group.querySelector<HTMLElement>('.tool-group-summary')?.focus({ preventScroll: true });
  });
}
type TurnView = { key: string; open: boolean; focused: boolean; toolKeys: string[] };
/** A finished live turn folds unless the reader keeps one of its tools open, the board shows it, or Settings expands activity. */
function liveTurnStaysOpen(turn: HTMLElement): boolean {
  return state.view === 'board' || activityExpanded() || readingTrace(turn);
}
/** Live turns are left out unless asked for or being read: the saved turn starts folded (see foldSavedTurn). */
function captureTurns(root: ParentNode, live = false): TurnView[] {
  return [...root.querySelectorAll<HTMLDetailsElement>('.turn-activity')].filter(turn => live || !turn.classList.contains('live-activity') || liveTurnStaysOpen(turn)).map(turn => ({ key: turn.dataset.turnKey!, open: turn.open && turn.dataset.folded === undefined, focused: document.activeElement === turn.querySelector('.turn-activity-summary'), toolKeys: [...turn.querySelectorAll<HTMLElement>('[data-tool-key]')].map(tool => tool.dataset.toolKey!) }));
}
/** A run that ended without a finishing frame folds here, as the live header would have. */
function foldSavedTurn(root: ParentNode, live: TurnView): void {
  const turn = [...root.querySelectorAll<HTMLDetailsElement>('.turn-activity:not(.live-activity)')].find(turn => turn.dataset.turnKey === live.key
    || [...turn.querySelectorAll<HTMLElement>('[data-tool-key]')].some(tool => live.toolKeys.includes(tool.dataset.toolKey!)));
  if (!turn || turn.open) return;
  turn.open = true;
  foldTurn(turn);
}
function restoreTurns(root: ParentNode, views: TurnView[]): void {
  if (!views.length) return;
  const find = viewIndex(views);
  root.querySelectorAll<HTMLDetailsElement>('.turn-activity').forEach(turn => {
    // A live trace holds a wake's earlier tools, but a saved card's folded state is not its own.
    const live = turn.classList.contains('live-activity');
    const view = find(turn.dataset.turnKey, live ? [] : [...turn.querySelectorAll<HTMLElement>('[data-tool-key]')].map(tool => tool.dataset.toolKey));
    if (!view) return;
    if (turn.open !== view.open) turn.open = view.open;
    if (view.focused) turn.querySelector<HTMLElement>('.turn-activity-summary')?.focus({ preventScroll: true });
  });
}
/** `afterTrace`: an answer that follows a tool trace sits flush under it without the avatar/name row (still read out). */
/** `actions` is false for replies between tool calls: only the turn's last reply carries copy and fork. */
/** `thread`: the messages and harness a row belongs to (the open thread unless the By the way panel draws its side thread). */
interface Thread { messages: Message[]; provider: ProviderId }
const shownThread = (): Thread => ({ messages: state.messages, provider: session()?.provider ?? state.defaultProvider });
function messageHtml(m: Message, afterTrace = false, actions = true, thread = shownThread()): string {
  if (m.role === 'handoff') {
    const handoff = decodeHandoff(m);
    if (!handoff) return '';
    return `<details class="provider-handoff"><summary>${providerLogo(handoff.fromProvider)}${icon('forward')}${providerLogo(handoff.toProvider)}<span>Conversation carried forward</span>${icon('down')}</summary><p>${escape(handoff.summary)}</p></details>`;
  }
  if (m.role === 'coordination') return renderCoordination(m);
  if (m.role === 'tool') {
    const tool = decodeToolActivity(m.content);
    return renderToolActivity(tool ?? m.content, tool ? 'tool:' + tool.id : 'message:' + m.id);
  }
  if (m.role === 'status') return renderToolStatus(m.content);
  if (m.role === 'error') return errorRowHtml({ key: errorKey(m.content), content: m.content, count: 1, ids: [m.id] }, 'message:' + m.id, m.sessionId);
  if (m.role === 'system') return accountSwitchHtml(m) ?? `<p class="message-note">${escape(m.content)}</p>`;
  const isUser = m.role === 'user';
  const author = historicalProvider(m, thread.messages, thread.provider);
  return `<article class="message ${isUser ? 'user-message' : 'agent-message'}${afterTrace && !isUser ? ' after-trace' : ''}" data-message-id="${m.id}"><div class="message-meta"><span class="message-avatar ${isUser ? 'user-avatar' : ''}">${isUser ? 'Y' : providerLogo(author)}</span><strong>${isUser ? 'You' : escape(provider(author)?.name || 'Agent')}</strong><time>${formatTime(m.createdAt)}</time></div><div class="message-content ${isUser ? '' : 'markdown'}" ${isUser ? '' : `data-markdown="${m.id}"`}>${isUser ? scheduledMark(m.content) + userContent(m.content, m.id) : escape(m.content)}</div>${isUser && m.id < 0 ? steerStateHtml(m) : ''}${actions ? messageActionsHtml(m.sessionId, m.id, m.id > 0 && (isUser || m.role === 'assistant'), isUser && m.id > 0) : ''}</article>`;
}
// Context appended at send time (files, documents, folders, GitHub, browser, images) shows as
// read-only chips under what you said; each opens its attachment (see message-attachments.ts).
const CONTEXT_BOUNDARY = new RegExp(String.raw`\n\n(?=(?:File|Document|Folder|GitHub|Browser element|Main thread) context[ :(]|Attached (?:browser screenshot|image|mockup)[ :]|Bot brief:\n|Your ongoing role is:|Response style \(PandaCode token saver|${TRACE_HEADER.replace(/[()]/g, '\\$&')})`);
function contextBlocks(content: string): { typed: string; blocks: string[]; wake: string[] } {
  const index = content.search(CONTEXT_BOUNDARY);
  if (index < 0) return { typed: content, blocks: [], wake: [] };
  // A wake-up's trace is the scheduler's note, not an attachment: it folds on its own.
  const all = content.slice(index + 2).split(CONTEXT_BOUNDARY);
  return { typed: content.slice(0, index), blocks: all.filter(block => !block.startsWith(TRACE_HEADER)), wake: all.filter(block => block.startsWith(TRACE_HEADER)) };
}
function userContent(content: string, messageId: number): string {
  const { typed, blocks, wake } = contextBlocks(content);
  const items = parseAttachments(blocks);
  for (const item of items) if (item.kind === 'image' && item.imageId) loadSentImage(item.imageId);
  const details = wake.length ? `<details class="message-context"><summary>${icon('clock')}Wake-up details</summary><pre>${escape(wake.join('\n\n'))}</pre></details>` : '';
  return `<div class="user-prose" dir="auto">${escape(typed)}</div>` + attachmentChips(items, messageId, sentImages) + details;
}
// Sent images live in the capture registry for a week; null marks one that is gone.
const sentImages = new Map<string, string | null>();
function loadSentImage(id: string): void {
  if (sentImages.has(id)) return;
  sentImages.set(id, null);
  call<string | null>('prompt_image', { id }).then(url => {
    if (!url?.startsWith('data:image/')) return;
    sentImages.set(id, url);
    turnInputs.bump();
    for (const img of document.querySelectorAll<HTMLImageElement>(`img[data-prompt-image="${id}"]`)) {
      img.src = url; img.hidden = false;
      if (img.nextElementSibling?.matches('svg.icon')) img.nextElementSibling.remove();
    }
  }).catch(() => { /* The chip keeps its icon and still opens the block's text. */ });
}
async function openMessageAttachment(element: HTMLElement): Promise<void> {
  // Chips in the By the way tab belong to the side thread's messages, not the open thread's.
  const message = element.closest('.btw-panel') ? btwPanel.message(Number(element.dataset.messageId)) : state.messages.find(m => String(m.id) === element.dataset.messageId);
  const item = message && parseAttachments(contextBlocks(message.content).blocks)[Number(element.dataset.index)];
  if (!item) return;
  if (item.kind === 'github') { await call('open_external_url', { url: item.url }); return; }
  if (item.kind === 'image') {
    const url = item.imageId ? sentImages.get(item.imageId) : null;
    if (url) { modal(item.name, `<img class="message-attachment-image" src="${escape(url)}" alt="${escape(item.name)}">`, 'message-attachment-dialog'); return; }
    modal(item.name, `<p class="dialog-description">This image is no longer stored. Here is what was sent with it.</p><pre class="message-attachment-raw">${escape(item.raw)}</pre>`, 'message-attachment-dialog'); return;
  }
  if (item.kind === 'raw') { modal(item.name, `<pre class="message-attachment-raw">${escape(item.raw)}</pre>`, 'message-attachment-dialog'); return; }
  // Project files are workspace-relative; documents and folders carry the path they came from.
  const root = workspacePath().replace(/[\\/]+$/, '');
  const relative = item.kind === 'file' && !/^(?:\/|[A-Za-z]:[\\/])/.test(item.path) ? item.path
    : root && [root + '/', root + '\\'].some(prefix => item.path.startsWith(prefix)) ? item.path.slice(root.length + 1) : '';
  if (relative && item.kind !== 'folder') { await openFile(relative, 'file'); return; }
  if (!/^(?:\/|[A-Za-z]:[\\/])/.test(item.path)) throw new Error(`${item.name} was dropped from a browser, so its location is unknown.`);
  await call('reveal_path', { path: item.path });
}
/** A saved tool's folds and scroll offsets, put back after a redraw (transcript-host.ts restoreToolViews). */
const restoreTools = (root: ParentNode, views: Map<string, ToolView>): void => restoreToolViews(root, views, fillToolBody);
function accountSwitchHtml(message: Message): string | null {
  const detail = accountSwitchDetail(message.content);
  return detail === null ? null : `<details class="account-switch-note" data-account-switch="${escape(message.sessionId)}:${message.id}" data-account-switch-session="${escape(message.sessionId)}"><summary>${icon('refresh')}<span>Account switched</span>${icon('chevron')}</summary><p>${escape(detail)}</p></details>`;
}
function paintAccountSwitches(host: HTMLElement, messages: LiveAccountSwitch[]): void {
  const views = captureAccountSwitches(host), keys = new Set(messages.map(message => `${message.sessionId}:${message.id}`));
  const notes = [...messages].reverse().map(message => {
    const key = `${message.sessionId}:${message.id}`, detail = accountSwitchDetail(message.content)!;
    const view = takeAccountSwitch(views, key, message.sessionId, detail, keys);
    let node = view?.node;
    if (!node) { const template = document.createElement('template'); template.innerHTML = accountSwitchHtml(message)!; node = template.content.firstElementChild as HTMLDetailsElement; }
    node.dataset.accountSwitch = key;
    return { node, focused: view?.focused };
  }).reverse();
  notes.forEach(({ node, focused }, index) => {
    if (host.children[index] !== node) { host.insertBefore(node, host.children[index] ?? null); if (focused) node.querySelector('summary')!.focus({ preventScroll: true }); }
  });
  for (const view of views) view.node.remove();
}
/** Keep saved pool notes from the hidden streaming tail, including a run opened midway through. */
function liveVisibleMessages(messages: Message[], current: Stream): Message[] {
  let boundary = -1; messages.forEach((message, index) => { if (message.role === 'user' || message.role === 'coordination' || message.role === 'changes') boundary = index; });
  const pending = [...current.accountSwitches], saved: LiveAccountSwitch[] = [];
  for (const message of messages.slice(boundary + 1)) {
    const detail = message.role === 'system' ? accountSwitchDetail(message.content) : null;
    if (detail === null) continue;
    const content = ACCOUNT_SWITCH_PREFIX + detail;
    const index = pending.findIndex(note => note.id === message.id || note.content === content);
    const previous = index < 0 ? undefined : pending.splice(index, 1)[0];
    saved.push({ ...message, content, eventSeen: previous?.eventSeen ?? message.createdAt < current.startedAt });
  }
  const notes = [...saved, ...pending];
  if (notes.length !== current.accountSwitches.length || notes.some((note, index) => note.id !== current.accountSwitches[index].id || note.content !== current.accountSwitches[index].content)) current.revision++;
  current.accountSwitches = notes;
  return messages.slice(0, boundary + 1);
}
function visibleMessages(sessionId = state.sessionId, messages = state.messages): Message[] {
  const current = state.streams.get(sessionId) ?? finishingStreams.get(sessionId)?.stream;
  return current && !wakeHolds.has(sessionId) ? liveVisibleMessages(messages, current) : messages.slice();
}
function renderStream(): void {
  if (!transcriptVisible() || wakeHolds.has(state.sessionId)) { updateWorkTimer(); return; }
  const region = document.getElementById('stream-region'); if (!region) return;
  // A bot's welcome is for an idle, empty thread; its first live event (an approval, say) replaces it.
  if ((state.streams.has(state.sessionId) || finishingStreams.has(state.sessionId)) && isRunning() && region.parentElement?.querySelector('.bot-welcome-setup')) { renderTranscript(); return; }
  paintStream(region, state.sessionId, transcriptScroller, true);
}
/** Draws a thread's live turn into `region`: the main transcript's `#stream-region`, or the By the way
 *  panel's (`main` false: no approval bar, bot chrome or team rows of the open thread). */
function paintStream(region: HTMLElement, sessionId: string, transcript: HTMLElement, main = false): void {
  const finishing = finishingStreams.get(sessionId);
  const current = state.streams.get(sessionId) ?? finishing?.stream;
  // A final text frame can run while the saved transcript is loading. Retain
  // its tool controls until renderTranscript can transfer their reading state.
  if (!current) { updateWorkTimer(); return; }
  const task = state.sessions.find(item => item.id === sessionId), harness = task?.provider ?? state.defaultProvider, context = workspaceContext(task);
  // The only layout read, and only while a tool is being read.
  const readingTool = readingTranscriptTool() && (main || transcript.contains(document.activeElement)), scrollTop = readingTool ? transcript.scrollTop : 0;
  let parts = streamParts.get(region);
  if (region.dataset.sessionId !== sessionId || !parts || !region.contains(parts.output)) {
    const thinkingHtml = `<details class="thinking-block" hidden><summary class="tool-group-summary"><span class="tool-group-label">Thinking</span>${icon('chevron')}</summary><div class="tool-group-body thinking-text"></div></details>`;
    const liveMessageHtml = `<article class="message agent-message live-message" hidden><div class="message-meta"><span class="message-avatar">${providerLogo(harness)}</span><strong>${escape(provider()?.name || 'Agent')}</strong><span class="streaming-label">Generating</span></div><div class="message-content streaming-content live-text"></div>${messageActionsHtml(state.sessionId, 'live', false)}</article>`;
    const trace = (meta = '', before = '') => activityHtml(current.turnKey, '', `${before}<div class="live-tools"></div><div class="live-status"></div>`, { live: true, meta });
    const earlier = main ? current.earlier?.turn : undefined;
    // Bot threads and the side panel keep their chat rows; every other turn streams into its card (turn-card.ts).
    const switches = captureAccountSwitches(region);
    region.innerHTML = (!main || botForThread() ? thinkingHtml + trace() + liveMessageHtml + '<div class="live-errors thread-errors"></div>'
      : `<section class="turn-card is-live">${trace(timeHtml(Date.now() - workStart(current), true), earlier?.activity.length ? liveEarlierFold(earlier, current.earlier!.tools) : '')}${thinkingHtml}${replyHtml(SKELETON_HTML + liveMessageHtml, current.turnKey, '', true)}${earlier ? workerSlot(earlier, sessionId) + cardErrorsHtml(earlier, sessionId) : ''}<div class="live-errors thread-errors turn-card-errors"></div>${earlier ? cardFootHtml(sessionId, earlierChangeSets(earlier)) : ''}</section>${earlier ? notesHtml(earlier, shownThread()) : ''}`) + '<div class="live-account-switches"></div><div class="live-approvals"></div><div class="live-inputs"></div>';
    paintAccountSwitches(region.querySelector<HTMLElement>('.live-account-switches')!, current.accountSwitches);
    restoreAccountSwitches(region, switches);
    if (earlier) paintSavedMarkdown(region, state.messages, reusableMarkdown ?? new Map(), context, followTranscript);
    watchReplies(region);
    region.dataset.sessionId = sessionId; region.dataset.revision = '-1';
    streamParts.set(region, parts = queryStreamParts(region));
  }
  const { activity, message, thinking, output, status } = parts;
  if (activity.dataset.turnKey !== current.turnKey) { activity.dataset.turnKey = current.turnKey; delete activity.dataset.folded; activity.open = true; }
  const answered = answerAge(current);
  paintLiveHeader(activity, current, finishing ? finishing.finishedAt - workStart(current) : undefined, answered);
  scheduleAnswerFolds(answered, main ? 'main' : sessionId, main ? renderStream : () => paintStream(region, sessionId, transcript));
  if (region.dataset.revision !== String(current.revision)) {
    paintAccountSwitches(parts.accountSwitches, current.accountSwitches);
    paintLiveActivity(region, current, transcript, context);
    paintLiveErrors(parts.errors, current, sessionId, finishing?.error);
    // Approvals live in the bar above the prompt, not in the transcript.
    if (parts.approvals.firstChild) parts.approvals.replaceChildren();
    if (main) renderApprovalBar();
    const inputs = parts.inputs;
    for (const input of current.inputs.values()) if (input.element.parentElement !== inputs) inputs.append(input.element);
    region.dataset.revision = String(current.revision);
  }
  // In a card the header already reads the running step, so its own row waits until it finishes or prints (no echo).
  // A step with output to read (a command printing) keeps its row, so it can be opened while it runs. Rows are shown
  // before the choreography below measures them, and a row that appears grows in (revealRow), never in one step.
  const header = activity.querySelector<HTMLElement>('.turn-activity-label'), newest = liveToolRecords(current).at(-1);
  const mirrored = newest && activity.closest('.turn-card') && header?.dataset.mode === 'step' && newest.id === header.dataset.step && !newest.output ? newest.id : undefined;
  for (const row of parts.tools.querySelectorAll<HTMLElement>('details.tool-trace')) {
    const key = row.dataset.toolKey!, echo = Boolean(mirrored) && row.dataset.toolStatus === 'running' && (key === mirrored || key.endsWith(':' + mirrored));
    // By key: a finished step's row is a fresh element (patchToolGroup), never the one that carried the attribute.
    if (echo) { if (!row.hasAttribute('data-mirrored')) row.toggleAttribute('data-mirrored', true); mirroredRows.add(key); }
    else if (mirroredRows.delete(key)) revealRow(activity, row);
  }
  // The open cards fold once the answer is under way; text-only frames change neither the tools nor that.
  // In a card the trace folds as the reply starts, so once it has begun no result card unfolds only to fold back.
  const answering = answered >= CARDS_FOLD_MS, expandAll = activityExpanded(), hold = answered >= 0 && Boolean(activity.closest('.turn-card')) && !current.retainedMessageKey;
  const choreographed = `${current.turnKey}:${current.revision}:${answering}:${expandAll}:${hold}`;
  if (activity.dataset.folded === undefined && activity.dataset.choreographed !== choreographed) {
    activity.dataset.choreographed = choreographed;
    choreograph(parts.tools, current.turnKey, { answering, expandAll, hold });
  }
  // The answer to a traced turn hangs flush under the trace, as in the reference: no avatar/name row.
  message.classList.toggle('after-trace', liveToolRecords(current).length > 0 || Boolean(current.earlier));
  // One closed Thinking fold per turn; it keeps the reader's open state while the text streams in.
  const thought = current.thinking ?? '';
  if (thinking.dataset.turnKey !== current.turnKey) { thinking.dataset.turnKey = current.turnKey; thinking.open = false; }
  setHidden(thinking, !thought);
  if (parts.thought.textContent !== thought) parts.thought.textContent = thought;
  bindFileLinkContext(output, context);
  streamMarkdown(output, current.text, transcript);
  setHidden(parts.streaming, Boolean(finishing || current.retainedMessageKey));
  const appeared = message.hidden && Boolean(current.text);
  setHidden(message, !current.text);
  if (appeared && message.parentElement?.classList.contains('turn-card-reply-content')) fadeInReply(message);
  const card = region.querySelector<HTMLElement>('.turn-card.is-live');
  if (card && card.hasAttribute('data-done') !== Boolean(finishing)) card.toggleAttribute('data-done', Boolean(finishing));
  const label = current.status || 'Working…'; if (status.textContent !== label) status.textContent = label;
  setHidden(status, Boolean(finishing) || current.approvals.size > 0 || current.inputs.size > 0);
  const bot = main ? botForThread() : undefined;
  if (bot) botThread.paintWorking(region, bot, provider()?.name || 'the agent', () => state.streams.get(sessionId), Boolean(finishing));
  updateWorkTimer();
  // Following needs no pin here: Markdown paints pin after themselves, and the ResizeObserver after layout.
  if (readingTool) { transcript.scrollTop = scrollTop; if (main) lastTranscriptTop = transcript.scrollTop; }
}
type StreamParts = {
  activity: HTMLDetailsElement; thinking: HTMLDetailsElement; thought: HTMLElement; tools: HTMLElement; status: HTMLElement;
  message: HTMLElement; streaming: HTMLElement; output: HTMLElement; errors: HTMLElement; accountSwitches: HTMLElement; approvals: HTMLElement; inputs: HTMLElement;
};
/** renderStream's elements, kept until the region's markup is rebuilt. */
const streamParts = new WeakMap<HTMLElement, StreamParts>();
/** Tool keys whose row the live header mirrors (renderStream); each grows in once its step shows (revealRow). */
// ponytail: keys of a run stopped mid-step stay in the set; a few short strings per stopped step.
const mirroredRows = new Set<string>();
function queryStreamParts(region: HTMLElement): StreamParts {
  const part = <T extends HTMLElement = HTMLElement>(selector: string): T => region.querySelector<T>(selector)!;
  const thinking = part<HTMLDetailsElement>('.thinking-block');
  return {
    activity: part<HTMLDetailsElement>('.turn-activity'), thinking, thought: thinking.lastElementChild as HTMLElement,
    tools: part('.live-tools'), status: part('.live-status'), message: part('.live-message'), streaming: part('.streaming-label'),
    output: part('.live-text'), errors: part('.live-errors'), accountSwitches: part('.live-account-switches'), approvals: part('.live-approvals'), inputs: part('.live-inputs'),
  };
}
const setHidden = (node: HTMLElement, hidden: boolean): void => { if (node.hidden !== hidden) node.hidden = hidden; };
const liveGroupEntries = new WeakMap<HTMLElement, LiveTool[]>();
const liveErrorHtml = new WeakMap<Element, string>();
/* Thread errors (pure helpers in thread-errors.ts): identical errors are one row with a count, the full text folds
 * open under a disclosure, and a row (or every row of a turn) can be dismissed, with Undo in the toast. Clicks reach
 * `action` by delegation. */
/** A transient error row a turn boundary wrote for a live row (materializeTurn): `count` events in one row, and the
 * saved rows of those events, which dismissing the transient row deletes. */
type CountedMessage = Message & { count?: number; savedIds?: number[] };
/** "3 errors dismissed" where an emptied turn's error box was; plain muted text, not announced (the toast was). */
function dismissedNoteHtml(turn: ShownTurn): string {
  const count = turn.dismissedErrors ?? 0;
  return count && !turn.errors.length ? `<p class="errors-dismissed-note">${count === 1 ? '1 error' : `${count} errors`} dismissed</p>` : '';
}
/** Drops dismissed error rows (hiddenErrors, and a mirrored thread's run copies, runHides) and folds errors-only turns
 * into the turn before (foldErrorTurns). */
function withErrorTurns(turns: TranscriptTurn[]): ShownTurn[] {
  const sessionId = turns.find(turn => turn.errors.length)?.errors[0].sessionId, hides = sessionId ? runHides.get(sessionId) : undefined;
  const fromRun = hides?.length ? hiddenRunErrors(turns.flatMap(turn => [turn.user, turn.coordination, ...turn.activity, turn.final, ...turn.errors, ...turn.notes].filter((message): message is Message => Boolean(message))), hides) : undefined;
  if (!hiddenErrors.size && !fromRun?.size) return foldErrorTurns(turns, () => false);
  return foldErrorTurns(turns, message => hiddenErrors.has(message.id) || Boolean(fromRun?.has(message.id)));
}
/** Whether a live disclosure the reader opened carries over to this row: the live row itself, or the run's saved rows. */
function liveErrorOpen(group: ErrorGroup, sessionId: string, live: boolean): boolean {
  const saved = openLiveErrors.get(`${sessionId}|${group.key}`);
  if (!saved) return false;
  return live || group.ids.some(id => typeof id === 'number' && (id < 0 || saved.has(id)));
}
function errorRowHtml(group: ErrorGroup, scope: string, sessionId: string, live = false): string {
  const { summary, detail } = errorSummary(group.content);
  // Unique per session, scope and row; the By the way panel prefixes its copies (scopeErrorIds), tiles drop ids.
  const baseId = `err-${[sessionId, scope, String(group.ids[0])].join('-').replace(/[^\w-]/g, '_')}`, detailId = `${baseId}-detail`;
  const open = detail !== null && (openErrors.has(`${scope}|${group.key}`) || liveErrorOpen(group, sessionId, live));
  const count = group.count > 1 ? `<span class="error-row-count"><span aria-hidden="true">×${group.count}</span><span class="sr-only">Repeated ${group.count} times</span></span>` : '';
  const toggle = detail === null ? '' : `<button type="button" class="error-row-button error-row-toggle" data-action="toggle-error" aria-label="Error details" aria-describedby="${baseId}-summary" aria-expanded="${open}" aria-controls="${detailId}">${icon('chevron')}</button>`;
  const dismiss = `<button type="button" class="error-row-button error-row-dismiss" data-action="dismiss-error" aria-label="Dismiss error" aria-describedby="${baseId}-summary">${icon('close')}</button>`;
  // Focusable so the keyboard can scroll a long detail (WKWebView does not scroll an unfocusable overflow box); a named
  // region, so a screen reader reads its text after the summary that names it.
  const body = detail === null ? '' : `<pre class="error-row-detail" id="${detailId}" role="region" aria-labelledby="${baseId}-summary" tabindex="0"${open ? '' : ' hidden'}>${escape(detail)}</pre>`;
  return `<div class="message-error error-row" data-error-key="${escape(group.key)}" data-error-scope="${escape(scope)}" data-error-ids="${escape(group.ids.join(' '))}" data-error-count="${group.count}" data-session="${escape(sessionId)}"${live ? ' data-live' : ''}><div class="error-row-head"><span class="error-row-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="error-row-summary" id="${baseId}-summary">${escape(summary)}</span>${count}${toggle}${dismiss}</div>${body}</div>`;
}
/** The By the way panel can show the open thread too: its error rows get their own ids (and references to them). */
function scopeErrorIds(root: HTMLElement): void {
  root.querySelectorAll<HTMLElement>('.message-error [id^="err-"]').forEach(node => { node.id = 'btw-' + node.id; });
  for (const attribute of ['aria-controls', 'aria-labelledby', 'aria-describedby']) {
    root.querySelectorAll<HTMLElement>(`.message-error [${attribute}^="err-"]`).forEach(node => node.setAttribute(attribute, 'btw-' + node.getAttribute(attribute)));
  }
}
const dismissAllHtml = (groups: number): string => groups > 1 ? '<div class="error-dismiss-all-row"><button type="button" class="error-dismiss-all" data-action="dismiss-errors">Dismiss all</button></div>' : '';
/** A turn's saved errors, grouped, in one `.thread-errors` box (none at all when every error was dismissed). */
function savedErrorsHtml(errors: Message[], scope: string, sessionId: string, extraClass = ''): string {
  if (!errors.length) return '';
  // A transient row (materializeTurn) stands in for saved rows too: dismissing it deletes those.
  const savedOf = new Map(errors.map(error => [error.id, (error as CountedMessage).savedIds ?? []]));
  const groups = groupErrors(errors).map(group => ({ ...group, ids: [...group.ids, ...group.ids.flatMap(id => savedOf.get(id as number) ?? [])] }));
  return `<div class="thread-errors${extraClass ? ' ' + extraClass : ''}">${groups.map(group => errorRowHtml(group, scope, sessionId)).join('')}${dismissAllHtml(groups.length)}</div>`;
}
/** A live error row keeps at most the last this many characters (the tool path bounds its text the same way). */
const LIVE_ERROR_CHARS = 8192;
const isLiveError = (tool: LiveTool): boolean => Boolean(tool.statusOnly) && typeof tool.content === 'string';
/** The live turn's errors (one row per key, already counted by addLiveError) and a failed saved-page load. Redrawn only
 * when its markup changes; a focused control in it is focused again in the new markup. */
function paintLiveErrors(container: HTMLElement, current: Stream, sessionId: string, loadError?: string): void {
  const tools = current.tools.filter(tool => isLiveError(tool) && !tool.dismissed);
  // The stream key first (it names the row), then the saved rows its events became.
  const groups = tools.map(tool => ({ key: errorKey(tool.content as string), content: stripErrorPrefix(tool.content as string), count: tool.count ?? 1, ids: [tool.key, ...(tool.savedIds ?? [])] }));
  const html = groups.map(group => errorRowHtml(group, 'live:' + current.turnKey, sessionId, true)).join('') + dismissAllHtml(groups.length);
  paintRetryRow(container, sessionId, loadError);
  if (liveErrorHtml.get(container) === html) return;
  const focused = container.contains(document.activeElement) ? document.activeElement as HTMLElement : null;
  const focusKey = focused?.closest<HTMLElement>('.message-error')?.dataset.errorKey, focusAction = focused?.dataset.action;
  // The Retry row (paintRetryRow) is left in place: only the live rows before it are rewritten.
  for (const child of [...container.children]) if (!child.classList.contains('live-retry')) child.remove();
  container.insertAdjacentHTML('afterbegin', html); liveErrorHtml.set(container, html);
  if (focusAction) refocusError(container, focusKey, focusAction);
  // After this frame's follow-to-bottom, so the room is measured where the rows end up.
  requestAnimationFrame(() => { const toast = $('#toast'); if (!toast.hidden) makeToastRoom(toast); });
}
/** The load error each session's Retry row has already announced (paintRetryRow). */
const announcedLoadErrors = new Map<string, string>();
/** A failed saved-page load: its own node after the live rows, rewritten only when its text changes, and `role=alert`
 * only the first time that error shows for the session, so a redraw (a new live row, a dismissal rebuilding the region)
 * does not announce it again. Not saved, so no dismiss: Retry is its one action. */
function paintRetryRow(container: HTMLElement, sessionId: string, loadError?: string): void {
  let retry = container.querySelector<HTMLElement>(':scope>.live-retry');
  if (!loadError) { retry?.remove(); announcedLoadErrors.delete(sessionId); return; }
  if (retry?.dataset.loadError === loadError) return;
  retry?.remove();
  retry = document.createElement('div');
  retry.className = 'message-error error-row live-retry'; retry.dataset.loadError = loadError;
  if (announcedLoadErrors.get(sessionId) !== loadError) { retry.setAttribute('role', 'alert'); announcedLoadErrors.set(sessionId, loadError); }
  retry.innerHTML = `<div class="error-row-head"><span class="error-row-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="error-row-summary">Couldn't load the saved response. ${escape(loadError)}</span><button type="button" class="secondary-button" data-action="retry-response">Retry loading response</button></div>`;
  container.append(retry);
}
function refocusError(root: ParentNode, key: string | undefined, action: string, scope?: string): void {
  const row = key ? `.message-error[data-error-key="${CSS.escape(key)}"]${scope ? `[data-error-scope="${CSS.escape(scope)}"]` : ''} ` : '';
  root.querySelector<HTMLElement>(`${row}[data-action="${CSS.escape(action)}"]`)?.focus({ preventScroll: true });
}
/** An identical error bumps its row's count (a dismissed row stays dismissed: the repeat starts a new row, which an Undo
 * merges back, mergeLiveErrors). Its toast
 * shows once per `shouldAnnounce` window, and only when the row is not already in front of the reader
 * (shouldToastLiveError). */
function addLiveError(current: Stream, sessionId: string, text: string, savedId?: number): void {
  // Bounded like a tool row's text (the saved row keeps the backend's own bound); identity is savedId, never the text.
  const content = 'Error: ' + (text.length > LIVE_ERROR_CHARS ? text.slice(-LIVE_ERROR_CHARS) : text), key = errorKey(content);
  const saved = savedId === undefined ? [] : [savedId];
  const same = current.tools.find(tool => isLiveError(tool) && !tool.dismissed && errorKey(tool.content as string) === key);
  if (same) current.tools = current.tools.map(tool => tool === same ? { ...tool, count: (tool.count ?? 1) + 1, savedIds: [...(tool.savedIds ?? []), ...saved] } : tool);
  else { current.tools.push({ key: 'error:' + transientId--, content, statusOnly: true, savedIds: saved }); trimLiveActivity(current, sessionId); }
  // A disclosure opened on this row stays open on the saved row this event became.
  const open = openLiveErrors.get(`${sessionId}|${key}`);
  if (open && savedId !== undefined) openLiveErrors.set(`${sessionId}|${key}`, new Set([...open, savedId]));
  current.revision++;
  const onScreen = sessionId === state.sessionId && state.view === 'conversation' && !settingsView;
  const toastKey = `${sessionId}|${key}`, last = lastErrorToasts.get(toastKey);
  const now = Date.now(), fresh = shouldAnnounce(last === undefined ? null : { key, at: last }, key, now);
  if (fresh) {
    lastErrorToasts.delete(toastKey); lastErrorToasts.set(toastKey, now);
    if (lastErrorToasts.size > OPEN_ERRORS_MAX) lastErrorToasts.delete(lastErrorToasts.keys().next().value!);
  }
  // The row in front of the reader needs no toast, but the toast was also what a screen reader heard.
  if (!shouldToastLiveError({ onScreen, attended: !document.hidden && document.hasFocus(), undoShowing: Boolean(toastUndo) })) { if (fresh) announce(stripErrorPrefix(content)); return; }
  if (fresh) notifyError(errorSummary(text).summary);
}
function toggleError(button: HTMLElement): void {
  const row = button.closest<HTMLElement>('.message-error'), detail = row?.querySelector<HTMLElement>('.error-row-detail');
  if (!row || !detail) return;
  const open = button.getAttribute('aria-expanded') !== 'true', id = `${row.dataset.errorScope}|${row.dataset.errorKey}`;
  const liveId = `${row.dataset.session}|${row.dataset.errorKey}`;
  openErrors.delete(id); openLiveErrors.delete(liveId);
  if (open && row.hasAttribute('data-live')) openLiveErrors.set(liveId, new Set(rowSavedIds(row)));
  else if (open) openErrors.add(id);
  if (openErrors.size > OPEN_ERRORS_MAX) openErrors.delete(openErrors.values().next().value!);
  if (openLiveErrors.size > OPEN_ERRORS_MAX) openLiveErrors.delete(openLiveErrors.keys().next().value!);
  button.setAttribute('aria-expanded', String(open)); detail.hidden = !open;
}
/** Redraws every view of a thread's errors: the open transcript, the By the way panel and its tile. */
function redrawErrors(sessionId: string): void {
  hiddenErrorsRevision++;
  if (sessionId === state.sessionId) { renderTranscript(true); renderStream(); }
  btwPanel.refresh();
  tiles.event(sessionId);
}
/** The loaded page of a thread's saved messages: the open thread's, else its tile's or cached page. */
const threadMessages = (sessionId: string): Message[] | undefined => sessionId === state.sessionId ? state.messages : (tilePages.get(sessionId) ?? threadPages.get(sessionId))?.messages;
const errorStream = (sessionId: string): Stream | undefined => state.streams.get(sessionId) ?? finishingStreams.get(sessionId)?.stream;
/** The saved row ids a rendered error row stands for (positive ids in `data-error-ids`). */
const rowSavedIds = (row: HTMLElement): number[] => (row.dataset.errorIds ?? '').split(' ').map(Number).filter(id => Number.isSafeInteger(id) && id > 0);
/* Dismissing live errors. The backend saves each error event as a row before it emits the event, and the event carries
 * that row's id (`data.messageId`, lib.rs `attach_message_id`; savedErrorId). The live row keeps the ids of the events it
 * stands for (LiveTool.savedIds, also on the transient row materializeTurn writes), so dismissing it is dismissing those
 * saved rows: they hide at once (hiddenErrors, the live row by its `dismissed` flag), Undo shows them again, and the
 * native delete runs when the Undo toast settles, as for any saved row. An event without an id (the backend could not
 * save it, or a task mirrored from another computer, whose ids name the host's rows) is dismissed in the view only.
 * Deletes not yet confirmed are kept in localStorage (journalDismissals) and replayed at the next launch, since quitting
 * can end the webview before an IPC call finishes. */
/** Dismisses one row or every row of a `.thread-errors` box: the rows hide at once and the toast offers Undo; saved rows
 * are deleted natively only when that toast settles (commitDismiss). */
function dismissErrors(target: HTMLElement | null): void {
  const rows = !target ? [] : target.matches('.message-error') ? [target] : [...target.querySelectorAll<HTMLElement>('.message-error[data-error-key]')];
  const sessionId = rows[0]?.dataset.session;
  if (!target || !sessionId) return;
  const single = target.matches('.message-error');
  const box = rows[0].closest('.thread-errors'), siblings = box ? [...box.querySelectorAll<HTMLElement>('.message-error[data-error-key]')] : [];
  const neighbour = single ? siblings[siblings.indexOf(target) + 1] ?? siblings[siblings.indexOf(target) - 1] : undefined;
  const pending: PendingDismiss = { sessionId, saved: [], transient: [], liveTools: [], runHides: [], focus: { key: rows[0].dataset.errorKey!, scope: rows[0].dataset.errorScope!, action: single ? 'dismiss-error' : 'dismiss-errors' } };
  // A thread that runs on another computer shows this computer's copies, which the mirror's backfill could copy again:
  // dismissing there only hides them for this app session (with the transient ids), never deletes them. Its live rows
  // carry no saved id, so the run's copies, which arrive when it ends, are hidden by key (runHides).
  const task = state.sessions.find(item => item.id === sessionId), mirrored = Boolean(task?.remoteDevice);
  // A bot thread's failover reads the failed turn's error rows when the run ends (bots/failover.rs failed_turn), so
  // errors dismissed while it runs are hidden for this app session and never deleted.
  const viewOnly = mirrored || (sidebarBots.some(bot => bot.projectId === task?.projectId || bot.desktopSession === sessionId) && isRunning(sessionId));
  const newest = mirrored ? threadMessages(sessionId)?.reduce((max, message) => Math.max(max, message.id), 0) : undefined;
  for (const row of rows) {
    const ids = (row.dataset.errorIds ?? '').split(' ').filter(Boolean);
    if (row.hasAttribute('data-live')) pending.liveTools.push(ids[0]);
    if (row.hasAttribute('data-live') && newest !== undefined) pending.runHides.push({ key: row.dataset.errorKey!, after: newest });
    (viewOnly ? pending.transient : pending.saved).push(...rowSavedIds(row));
    pending.transient.push(...ids.map(Number).filter(id => Number.isInteger(id) && id < 0));
  }
  applyDismiss(pending);
  redrawErrors(sessionId);
  if (neighbour) refocusError(document, neighbour.dataset.errorKey, 'dismiss-error', neighbour.dataset.errorScope);
  // The last error went with its box: the keyboard continues from the composer, not from <body>.
  const active = document.activeElement;
  if (!active || active === document.body || !active.isConnected) document.querySelector<HTMLTextAreaElement>('#prompt')?.focus({ preventScroll: true });
  // Replacing this toast with another dismissal settles (commits) the one before; other notices wait (toastQueue).
  notify(rows.length === 1 ? 'Error dismissed' : `${rows.length} errors dismissed`, () => undoDismiss(pending), { settle: () => commitDismiss(pending) });
  pendingDismiss = pending;
  journalDismissals();
}
function setLiveDismissed(pending: PendingDismiss, dismissed: boolean): void {
  const current = errorStream(pending.sessionId);
  if (!current || !pending.liveTools.length) return;
  const tools = current.tools.map(tool => pending.liveTools.includes(tool.key) ? { ...tool, dismissed } : tool);
  current.tools = dismissed ? tools : mergeLiveErrors(tools); current.revision++;
}
/** One shown live row per key: a restored row takes in the repeat that started a new row while it was dismissed
 * (addLiveError), at the earlier row's place, so a later dismissal carries every saved id. */
function mergeLiveErrors(tools: LiveTool[]): LiveTool[] {
  const merged: LiveTool[] = [], at = new Map<string, number>();
  for (const tool of tools) {
    const key = isLiveError(tool) && !tool.dismissed ? errorKey(tool.content as string) : undefined, index = key === undefined ? undefined : at.get(key);
    if (index === undefined) { if (key !== undefined) at.set(key, merged.length); merged.push(tool); continue; }
    const kept = merged[index];
    merged[index] = { ...kept, count: (kept.count ?? 1) + (tool.count ?? 1), savedIds: [...(kept.savedIds ?? []), ...(tool.savedIds ?? [])] };
  }
  return merged;
}
function applyDismiss(pending: PendingDismiss): void {
  for (const id of [...pending.saved, ...pending.transient]) hiddenErrors.add(id);
  if (pending.runHides.length) {
    runHides.set(pending.sessionId, [...(runHides.get(pending.sessionId) ?? []), ...pending.runHides]);
    let total = [...runHides.values()].reduce((sum, hides) => sum + hides.length, 0);
    for (const [sessionId, hides] of runHides) {
      if (total <= RUN_HIDES_MAX) break;
      const drop = Math.min(hides.length, total - RUN_HIDES_MAX);
      if (drop === hides.length) runHides.delete(sessionId); else runHides.set(sessionId, hides.slice(drop));
      total -= drop;
    }
  }
  setLiveDismissed(pending, true);
}
/** Undo: the rows come back where they were, and focus returns to the control that dismissed them. */
function undoDismiss(pending: PendingDismiss): void {
  if (pendingDismiss !== pending) return;
  pendingDismiss = null;
  for (const id of [...pending.saved, ...pending.transient]) hiddenErrors.delete(id);
  const hides = (runHides.get(pending.sessionId) ?? []).filter(hide => !pending.runHides.includes(hide));
  if (hides.length) runHides.set(pending.sessionId, hides); else runHides.delete(pending.sessionId);
  setLiveDismissed(pending, false);
  journalDismissals();
  redrawErrors(pending.sessionId);
  const active = document.activeElement;
  if (active && active !== document.body && active.isConnected && !$('#toast').contains(active)) return;
  const { key, scope, action } = pending.focus;
  const row = document.querySelector<HTMLElement>(`.message-error[data-error-key="${CSS.escape(key)}"][data-error-scope="${CSS.escape(scope)}"]`);
  const control = action === 'dismiss-errors' ? row?.closest('.thread-errors')?.querySelector<HTMLElement>('[data-action="dismiss-errors"]') : row?.querySelector<HTMLElement>('[data-action="dismiss-error"]');
  control?.focus({ preventScroll: true });
}
/** The undo window passed: delete the saved rows (in any thread, open or not, the run over or not: they exist). */
function commitDismiss(pending: PendingDismiss): void {
  if (pendingDismiss !== pending) return;
  pendingDismiss = null;
  if (pending.saved.length) void deleteSavedErrors(pending.sessionId, pending.saved);
  journalDismissals();
}
/** Commits a dismissal still waiting on its Undo (the toast leaves with it): on leaving or hiding the window, and on a
 * thread switch. */
function flushPendingDismiss(): void {
  if (!pendingDismiss) return;
  if (toastSettle) dismissToast(); else commitDismiss(pendingDismiss);
}
window.addEventListener('pagehide', flushPendingDismiss);
document.addEventListener('visibilitychange', () => { if (document.hidden) flushPendingDismiss(); });
/** Saved ids whose native delete has started but not answered yet. */
const unconfirmedDeletes = new Map<string, Set<number>>();
async function deleteSavedErrors(sessionId: string, ids: number[]): Promise<void> {
  const unconfirmed = unconfirmedDeletes.get(sessionId) ?? new Set<number>();
  unconfirmedDeletes.set(sessionId, unconfirmed);
  for (const id of ids) unconfirmed.add(id);
  journalDismissals();
  const failed: number[] = [];
  for (let start = 0; start < ids.length; start += DISMISS_BATCH) {
    const batch = ids.slice(start, start + DISMISS_BATCH);
    try { await call<number>('dismiss_error_messages', { sessionId, ids: batch }); }
    catch (error) { console.error('dismiss_error_messages failed', error); failed.push(...batch); }
  }
  for (const id of ids) unconfirmed.delete(id);
  if (!unconfirmed.size) unconfirmedDeletes.delete(sessionId);
  journalDismissals();
  if (!failed.length) return;
  for (const id of failed) hiddenErrors.delete(id);
  redrawErrors(sessionId);
  notifyError("Couldn't dismiss the error. It's shown again.");
}
const DISMISS_JOURNAL_KEY = 'pandacode.errors.pendingDeletes';
/** Stores what a quit right now would lose: unconfirmed deletes and the pending dismissal (leaving commits it).
 * Replayed by replayDismissals at the next launch. */
function journalDismissals(): void {
  const saved = new Map([...unconfirmedDeletes].map(([sessionId, ids]) => [sessionId, new Set(ids)]));
  if (pendingDismiss?.saved.length) saved.set(pendingDismiss.sessionId, new Set([...(saved.get(pendingDismiss.sessionId) ?? []), ...pendingDismiss.saved]));
  const raw = dismissJournal(saved);
  try { if (raw) localStorage.setItem(DISMISS_JOURNAL_KEY, raw); else localStorage.removeItem(DISMISS_JOURNAL_KEY); }
  catch (error) { console.error('Could not keep dismissed errors for the next launch', error); }
}
/** At launch: hides and deletes what the last session dismissed but could not finish deleting (journalDismissals),
 * for threads that still exist. */
function replayDismissals(): void {
  let raw: string | null = null;
  try { raw = localStorage.getItem(DISMISS_JOURNAL_KEY); } catch (error) { console.error('Could not read dismissed errors', error); }
  const saved = parseDismissJournal(raw), known = new Set(state.sessions.map(task => task.id));
  for (const [sessionId, ids] of saved) if (known.has(sessionId)) { for (const id of ids) hiddenErrors.add(id); void deleteSavedErrors(sessionId, ids); }
  journalDismissals();
}
/** Patch only changed groups; text frames do not recreate tool controls or open details. */
function paintLiveActivity(region: HTMLElement, current: Stream, transcript: HTMLElement, context: FileLinkContext): void {
  const host = region.querySelector<HTMLElement>('.live-tools')!;
  const liveMessage = region.querySelector<HTMLElement>('.live-message')!;
  const previous = new Map([...host.children].map(node => [(node as HTMLElement).dataset.streamKey, node as HTMLElement]));
  const next: HTMLElement[] = [];
  const commentary: { node: HTMLElement; content: string }[] = [];
  /** Where the latest text falls among the steps, though it shows in the card's reply. */
  let narratedAt = -1;
  // Live worker lines follow the call that spawned them, so later activity stays below them.
  // ponytail: anchors every live worker after the turn's first dispatch; a second dispatch's workers join them.
  const tools = current.tools.filter(tool => !tool.statusOnly), workers = region.parentElement?.querySelector<HTMLElement>(':scope > #team-progress-host') ?? null;
  const dispatch = workers ? tools.findIndex(tool => typeof tool.content !== 'string' && /dispatch_workers/.test(tool.content.name)) : -1;
  const toolRuns = (entries: LiveTool[]) => groupToolRuns(entries, tool => tool.commentary ? undefined : tool.key);
  const runs = dispatch < 0 ? toolRuns(tools) : [...toolRuns(tools.slice(0, dispatch + 1)), null, ...toolRuns(tools.slice(dispatch + 1))];
  if (current.omittedActivity) {
    const note = previous.get('omitted') ?? document.createElement('p');
    note.className = 'activity-limit'; note.dataset.streamKey = 'omitted';
    note.textContent = 'Earlier activity will be available in saved history.';
    next.push(note);
  }
  for (const run of runs) {
    if (!run) { next.push(workers!); continue; }
    if (run.kind === 'message') {
      // In a card the latest text stays in the reply, even between steps; it joins the trace when newer text replaces it.
      if (run.item.key === current.retainedMessageKey) { if (region.querySelector('.turn-card-reply-content')) narratedAt = next.length; else next.push(liveMessage); continue; }
      const key = run.item.key;
      let node = previous.get(key);
      if (!node) {
        node = document.createElement('article'); node.className = 'message agent-message activity-commentary-message';
        node.dataset.streamKey = key;
        node.innerHTML = `<div class="message-content activity-commentary" data-commentary="${escape(key)}"></div>`;
      }
      next.push(node); commentary.push({ node: node.querySelector<HTMLElement>('[data-commentary]')!, content: run.item.content as string });
    } else {
      const key = 'group:' + run.key;
      let node = previous.get(key);
      const previousEntries = node ? liveGroupEntries.get(node) : undefined;
      if (!node) {
        const html = renderToolGroup(run.items, true, true);
        const template = document.createElement('template'); template.innerHTML = html;
        node = template.content.firstElementChild as HTMLElement; node.dataset.streamKey = key;
      } else if (!previousEntries || previousEntries.length !== run.items.length || run.items.some((entry, index) => entry !== previousEntries[index])) {
        patchToolGroup(node, run.items, previousEntries ?? []);
      }
      liveGroupEntries.set(node, run.items);
      next.push(node);
    }
  }
  // The last narrative stays at its original position when tools follow it.
  // New text takes over the stable live node after the accumulated work.
  if (!next.includes(liveMessage)) {
    const home = region.querySelector('.turn-card-reply-content'), activity = region.querySelector('.turn-activity')!;
    if (home) { if (liveMessage.parentElement !== home) home.append(liveMessage); }
    else if (activity.nextElementSibling !== liveMessage) activity.after(liveMessage);
  }
  const retained = new Set(next);
  if (workers?.parentElement === host && !retained.has(workers)) region.after(workers);
  for (const child of [...host.children]) if (!retained.has(child as HTMLElement)) child.remove();
  next.forEach((node, index) => { if (host.children[index] !== node) host.insertBefore(node, host.children[index] ?? null); });
  // Steps the agent narrated past fold once to their one-line summary, so later work never reopens them.
  const newestGroup = next.map(node => node.classList.contains('tool-group')).lastIndexOf(true);
  const narratedPast = Math.max(next.slice(0, Math.max(newestGroup, 0)).map(node => node.classList.contains('agent-message')).lastIndexOf(true), narratedAt <= newestGroup ? narratedAt : -1);
  next.slice(0, Math.max(narratedPast, 0)).forEach(node => {
    if (!node.classList.contains('tool-group') || node.dataset.earlier !== undefined) return;
    node.dataset.earlier = '';
    if (!liveTurnStaysOpen(node)) (node as HTMLDetailsElement).open = false;
  });
  for (const entry of commentary) { bindFileLinkContext(entry.node, context); streamMarkdown(entry.node, entry.content, transcript); }
}
/** One changed call redraws its own row; the summary redraws only when a member's name or status changed. */
function patchToolGroup(node: HTMLElement, items: LiveTool[], before: LiveTool[]): void {
  const fragment = (html: string) => { const template = document.createElement('template'); template.innerHTML = html; return template.content.firstElementChild as HTMLElement; };
  const tool = (entry: LiveTool) => typeof entry.content === 'string' ? decodeToolActivity(entry.content) : entry.content;
  const summaryKey = (entries: LiveTool[]) => entries.map(entry => { const item = tool(entry); return `${entry.key}\0${item?.name}\0${item?.status}`; }).join('\n');
  if (summaryKey(items) !== summaryKey(before)) {
    // The summary reads only names and statuses, so it renders from the calls without their (large) input and output.
    const bare = items.map(entry => { const item = tool(entry); return { key: entry.key, content: item ? { ...item, input: '', output: '' } : entry.content }; });
    node.querySelector('.tool-group-summary')!.innerHTML = fragment(renderToolGroup(bare, true, true)).querySelector('.tool-group-summary')!.innerHTML;
  }
  const body = node.querySelector<HTMLElement>('.tool-group-body')!;
  const rows = new Map([...body.children].map(row => [(row as HTMLElement).dataset.toolKey, row as HTMLElement]));
  const kept = new Map(before.map(entry => [entry.key, entry]));
  const changed = items.filter(entry => kept.get(entry.key) !== entry || !rows.has(entry.key));
  const views = changed.length ? captureTools(body) : new Map<string, ToolView>();
  for (const entry of changed) {
    const fresh = fragment(renderToolActivity(entry.content, entry.key));
    rows.get(entry.key)?.replaceWith(fresh); rows.set(entry.key, fresh);
  }
  const wanted = items.map(entry => rows.get(entry.key)!), keep = new Set(wanted);
  for (const row of [...body.children]) if (!keep.has(row as HTMLElement)) row.remove();
  wanted.forEach((row, index) => { if (body.children[index] !== row) body.insertBefore(row, body.children[index] ?? null); });
  if (changed.length) restoreTools(body, new Map([...views].filter(([key]) => changed.some(entry => entry.key === key))));
}
// Measured from the reference at 30 fps: the answer starts at 7.20 s, the open cards fold at 8.25 s
// and the turn folds to its summary at 9.6-9.8 s, mid-answer for any reply longer than the reference's.
const CARDS_FOLD_MS = 1050;
const TURN_FOLD_MS = 2350;
/** A card's trace folds this long into the reply, so a line of narration right before the next step does not flap it. */
const CARD_TRACE_FOLD_MS = 200;
let foldRestTimer = 0;
const answerStarts = new WeakMap<Stream, { at: number; tools: number }>();
/** One fold timer per live region ('main', or a side thread's id). */
const answerTimers = new Map<string, number>();
/** Milliseconds since the answer began (text after the last tool finished), or -1 while tools still run.
 * A tool that starts after narration resets it, so the trace unfolds again for the new steps. */
function answerAge(current: Stream): number {
  const tools = liveToolRecords(current);
  if (!current.text || (!tools.length && !current.earlier) || tools.some(tool => tool.status === 'running')) { answerStarts.delete(current); return -1; }
  let mark = answerStarts.get(current);
  if (!mark || mark.tools !== tools.length) answerStarts.set(current, mark = { at: Date.now(), tools: tools.length });
  return Date.now() - mark.at;
}
/** Text frames may stop before a threshold passes; repaint once when the next one is due. */
function scheduleAnswerFolds(age: number, key: string, repaint: () => void): void {
  clearTimeout(answerTimers.get(key)); answerTimers.delete(key);
  if (age < 0 || age >= TURN_FOLD_MS) return;
  const due = [CARD_TRACE_FOLD_MS, CARDS_FOLD_MS, TURN_FOLD_MS].find(threshold => threshold > age)!;
  answerTimers.set(key, window.setTimeout(() => { answerTimers.delete(key); repaint(); }, due - age + 16));
}
const toolRecords = new WeakMap<Stream, { revision: number; records: ToolActivity[] }>();
/** Every tool change bumps the stream's revision, so text frames reuse the last scan. */
function liveToolRecords(current: Stream): ToolActivity[] {
  const cached = toolRecords.get(current);
  if (cached?.revision === current.revision) return cached.records;
  const records = current.tools.flatMap(tool => !tool.statusOnly && !tool.commentary && typeof tool.content !== 'string' ? [tool.content] : []);
  toolRecords.set(current, { revision: current.revision, records });
  return records;
}
/** The header glyph, as in the reference: a dot cluster before the first step, the step's icon (a filled dot
 * stands in for its first frames, trace-motion.css) and level bars while the answer streams after the tools. */
function traceGlyphHtml(kind: 'dots' | 'bars' | 'step', iconName = ''): string {
  const inner = kind === 'step' ? icon(iconName) : '<i></i>'.repeat(kind === 'dots' ? 4 : 3);
  return `<span class="trace-glyph is-${kind}" aria-hidden="true">${inner}</span>`;
}
/** The live header mirrors the newest step's sentence (shimmering while the turn runs); at the end it
 * becomes the turn's summary and the steps fold under it, as the saved turn will render. */
function paintLiveHeader(activity: HTMLDetailsElement, current: Stream, workedMs: number | undefined, answerMs: number): void {
  const label = activity.querySelector<HTMLElement>('.turn-activity-label')!;
  const tools = liveToolRecords(current), allTools = current.earlier ? [...current.earlier.tools, ...tools] : tools;
  const narrated = current.tools.some(tool => tool.commentary && tool.key !== current.retainedMessageKey);
  const last = tools[tools.length - 1];
  const status = current.inputs.size || current.approvals.size || current.status === 'Stopping agent';
  const carded = Boolean(activity.closest('.turn-card'));
  // A card folds its trace as the final reply starts (its first token after the last step), so the live card is at
  // its saved shape by the end of the run; a step focused by the reader keeps it open.
  const reading = Boolean(document.activeElement?.closest('.turn-activity-body') && activity.contains(document.activeElement));
  // Narration kept above a later step (retainedMessageKey) is not the reply.
  let early = carded ? answerMs >= CARD_TRACE_FOLD_MS && !reading && !current.retainedMessageKey : answerMs >= TURN_FOLD_MS && !narrated;
  // A result card that unfolded just before the reply began is left in sight a moment (UNFOLD_REST_MS) before the fold.
  const rest = early && carded && workedMs === undefined ? foldWait(activity) : 0;
  if (rest) { early = false; clearTimeout(foldRestTimer); foldRestTimer = window.setTimeout(renderStream, rest + 16); }
  let mode: string, html: string, step = '';
  if (workedMs !== undefined || early) {
    // A tool-only turn folds to its summary mid-answer (a card's as the answer starts); a narrated one keeps its steps until it ends.
    mode = 'folded';
    // In a card the time stands on the right, so the label is the steps' summary; bot rows keep `Worked for`.
    html = allTools.length && (!narrated || carded) ? foldedLabelHtml(allTools) : carded ? escape('Replied') : escape(`Worked for ${formatDuration(workedMs ?? 0)}`);
  } else if (last && !status && carded && (last.status !== 'running' || last.output)) {
    // In a card, once the step the header mirrored finishes or prints, its own row shows it: the header moves on
    // to the turn's running summary (`Ran 1 command`), so header and rows never say the same thing.
    mode = 'summary';
    html = `${answerMs >= 0 ? traceGlyphHtml('bars') : ''}${foldedLabelHtml(allTools)}`;
  } else if (last && !status) {
    const trace = describeTool(last);
    mode = 'step'; step = last.id;
    // An image row already carries its thumbnail in the sentence (traceRowHtml).
    const thumb = carded && !trace.image ? stepImage(last) : '';
    html = `${answerMs >= 0 ? traceGlyphHtml('bars') : traceGlyphHtml('step', trace.icon ?? kindIcon(trace.kind))}<span class="trace-sentence">${traceRowHtml(trace)}</span>${thumb ? `<img class="turn-card-thumb" alt="" data-thumb="${escape(thumb)}" hidden>` : ''}`;
  } else {
    mode = 'status';
    // The first word reads dark and the rest dim, like the reference's `Working on it…`.
    const [first, rest] = workingLabel(current).split(/(?<=^\S+)(?=\s)/);
    html = `${traceGlyphHtml('dots')}<span class="trace-sentence is-status"><span class="trace-status-lead">${escape(first)}</span>${rest ? `<span class="trace-status-rest">${escape(rest)}</span>` : ''}</span>`;
  }
  // New steps after an early fold (the agent went back to work) unfold the trace again.
  if (mode !== 'folded' && activity.dataset.folded !== undefined) {
    // A fold still closing is called off, so its end does not shut the trace again.
    delete activity.dataset.folded; delete activity.dataset.closing;
    activity.querySelector(':scope > .turn-activity-body')?.getAnimations().forEach(animation => animation.cancel());
    activity.open = true;
  }
  const summary = activity.querySelector<HTMLElement>('.turn-activity-summary')!;
  const working = `Working for ${formatDuration(Date.now() - current.startedAt)}`;
  // A card shows the time beside the sentence, so only a bot's trace keeps it as the tooltip.
  if (!carded && workedMs === undefined && summary.title !== working) summary.title = working;
  const changed = label.dataset.mode !== mode || label.dataset.step !== step;
  if (label.dataset.html !== html) { label.innerHTML = html; label.dataset.html = html; loadStepImage(label); }
  const time = summary.querySelector<HTMLElement>('.turn-card-time');
  if (time) {
    const shown = formatDuration(workedMs ?? Date.now() - workStart(current));
    if (time.textContent !== shown) time.textContent = shown;
    if (workedMs !== undefined && time.hasAttribute('data-live')) {
      time.removeAttribute('data-live');
      const lead = time.previousElementSibling;
      if (lead?.classList.contains('turn-card-time-lead')) lead.textContent = 'took ';
    }
  }
  if (changed) { label.dataset.mode = mode; label.dataset.step = step; }
  if (changed && mode === 'step') enterHeader(label);
  else if (changed && (mode === 'folded' || mode === 'summary')) enterText(label);
  // A card's trace does not fold when the run ends: the saved card replaces it folded, and its bridge eases the height (handOffCard).
  if (mode === 'folded' && activity.dataset.folded === undefined && !liveTurnStaysOpen(activity) && !(carded && workedMs !== undefined)) foldTurn(activity, carded);
}
/** What the agent is doing before its first step (or while it waits); the elapsed time is the header's tooltip. */
// Startup and generic statuses read as the reference's `Working on it…` until the first step or a real wait.
const STARTUP_STATUS = new Set(['running', 'Working…', 'Starting agent', 'Waiting for response']);
/** A workspace image the running step looks at (a Read of a .png, say), for the header's thumbnail. */
function stepImage(tool: ToolActivity): string {
  if (tool.status !== 'running' && tool.status !== 'completed') return '';
  const match = /"(?:file_path|path|image_path)"\s*:\s*"([^"]+\.(?:png|jpe?g|gif|webp))"/i.exec(tool.input) ?? /^\s*(\S+\.(?:png|jpe?g|gif|webp))\s*$/i.exec(tool.input);
  return match?.[1] ?? '';
}
/** The header thumbnail shares the tool rows' image cache: a success stays cached, and a failure is asked again
 * when the header re-renders and a few times after `RETRY_MS` while the image stays. */
/** Forced retries the header has asked per session and image: it re-renders on every step, so without a cap a
 * missing image would be asked again about once a second for as long as it stays. */
const stepImageForced = new Map<string, number>();
const STEP_IMAGE_FORCED_LIMIT = 64;
function forceStepImage(sessionId: string, path: string): boolean {
  const key = sessionId + '\0' + path, tries = stepImageForced.get(key) ?? 0;
  if (tries >= MAX_RETRIES) return false;
  stepImageForced.delete(key);
  stepImageForced.set(key, tries + 1);
  while (stepImageForced.size > STEP_IMAGE_FORCED_LIMIT) stepImageForced.delete(stepImageForced.keys().next().value!);
  return true;
}
function loadStepImage(label: HTMLElement, retry = true, sessionId = state.sessionId): void {
  const image = label.querySelector<HTMLImageElement>('img[data-thumb]');
  if (!image || !sessionId) return;
  const path = image.dataset.thumb!;
  void toolImageCache(toolImageLoader).get(sessionId, path, { retry: retry && forceStepImage(sessionId, path) }).then(url => {
    if (!image.isConnected) return;
    if (url) { image.src = url; image.hidden = false; return; }
    retryLater(image, () => loadStepImage(label, false, sessionId));
  });
}
function workingLabel(current: Stream): string {
  let label = current.inputs.size ? 'Waiting for your answer' : current.approvals.size ? 'Waiting for approval' : current.status;
  if (current.status === 'Stopping agent') label = current.status;
  return !label || STARTUP_STATUS.has(label) ? 'Thinking' : label;
}
/** When the card's time would have started: a wake's card counts the work its exchange already did, not the wait between. */
const workStart = (current: Stream): number => current.startedAt - (current.earlier?.turn.durationMs ?? 0);
function updateWorkTimer(): void {
  if (document.hidden || ((!transcriptVisible() || !state.streams.has(state.sessionId)) && !document.querySelector('.task-runtime'))) { clearTimeout(workTimer); workTimer = 0; return; }
  if (workTimer) return;
  // Each tick lands just past the next whole second since the prompt, so the shown time never drifts.
  const running = state.streams.get(state.sessionId);
  const wait = running ? 1000 - (Date.now() - workStart(running)) % 1000 + 4 : 1000;
  workTimer = window.setTimeout(() => {
    workTimer = 0;
    const current = state.streams.get(state.sessionId), summary = document.querySelector<HTMLElement>('#stream-region .live-activity:not([data-folded]) .turn-activity-summary');
    if (current && summary && !summary.closest('.turn-card')) summary.title = `Working for ${formatDuration(Date.now() - current.startedAt)}`;
    const time = document.querySelector<HTMLElement>('#stream-region .turn-card-time[data-live]');
    if (current && time) time.textContent = formatDuration(Date.now() - workStart(current));
    const now = Date.now();
    for (const timer of document.querySelectorAll<HTMLElement>('.task-runtime')) {
      const elapsed = formatDuration(now - Number(timer.dataset.startedAt));
      timer.textContent = elapsed;
      timer.title = `Working for ${elapsed}`;
    }
    updateWorkTimer();
  }, wait);
}
// Project files, moodboards and prompt attachments share one bar; refreshing it alone
// keeps the prompt's focus and caret when something is pasted or dropped mid-sentence.
function attachmentBar(s: Session): string {
  const boardItems = (state.moodboardAttachments.get(s.id) ?? []).filter(item => item.projectId === s.projectId);
  return state.attachments.map(path => `<span>${icon('file')}${escape(path.split('/').pop())}<button type="button" data-action="detach" data-path="${escape(path)}" aria-label="Remove ${escape(path)}">${icon('close')}</button></span>`).join('')
    + boardItems.map(item => `<span>${icon('images')}${escape(item.name)}<button type="button" data-action="detach-moodboard" data-id="${escape(item.id)}" aria-label="Remove moodboard ${escape(item.name)}">${icon('close')}</button></span>`).join('')
    + attachments.chips(s.id);
}
function renderAttachmentBar(): void {
  const s = session(), bar = document.querySelector<HTMLElement>('#attachments');
  if (s && bar) bar.innerHTML = attachmentBar(s); else renderComposer();
}
/** Pending approvals for the open task, in the bar directly above the prompt. */
/** Tasks whose grouped approval bar is expanded (the main bar and the By the way panel's are separate). */
const approvalGroupsOpen = new Set<string>();
const approvalDetails = new Set<string>();
/** What the bar last showed: its host is rebuilt with the composer, so "empty to filled" can't be read from the DOM. A thread switch draws at once. */
let approvalBarShown = { sessionId: '', filled: false };
function renderApprovalBar(): void {
  const host = document.querySelector<HTMLElement>('#approval-bar');
  if (!host) return;
  const sessionId = state.sessionId, filled = Boolean(state.streams.get(sessionId)?.approvals.size);
  const html = taskApprovalsHtml(sessionId);
  const appeared = filled && approvalBarShown.sessionId === sessionId && !approvalBarShown.filled;
  approvalBarShown = { sessionId, filled };
  if (host.innerHTML === html) return;
  host.innerHTML = html;
  if (!filled) approvalGroupsOpen.delete(sessionId);
  if (appeared) settleUnfolded(host);
}
/** A task's pending approvals as the bar above its prompt. */
function taskApprovalsHtml(sessionId: string): string {
  const approvals = [...state.streams.get(sessionId)?.approvals ?? []].map(([id, text]) => ({ id, text }));
  return approvalBarHtml(approvals, { busy: id => pendingApprovals.has(sessionId + id), expanded: approvalGroupsOpen.has(sessionId), details: new Set([...approvalDetails].filter(item => item.startsWith(sessionId)).map(item => item.slice(sessionId.length))) });
}
async function respondApproval(sessionId: string, id: string, approved: boolean): Promise<void> {
  const current = state.streams.get(sessionId), approvalKey = sessionId + id;
  if (!current?.approvals.has(id) || pendingApprovals.has(approvalKey)) return;
  pendingApprovals.add(approvalKey); renderApprovalBar(); btwPanel.event(sessionId, 'approval');
  try {
    await call('respond_approval', { sessionId, requestId: id, approved });
    current.approvals.delete(id); approvalDetails.delete(approvalKey); current.revision++;
    if (!current.approvals.size && current.status === 'Waiting for approval') current.status = 'Continuing task';
  } finally { pendingApprovals.delete(approvalKey); current.revision++; renderStream(); renderNavigation(); renderApprovalBar(); btwPanel.event(sessionId, 'approval'); }
}
/** Rows that unfold snap to height, then fade up 4px over ~120 ms (settleIn keeps the MOTION and reduced-motion paths). */
const settleUnfolded = (element: HTMLElement): void => settleIn(element, 4, { response: 0.07 }, 0);
/** The reference's steer arrow (↳) and effort gauge; dom.ts has no such glyphs. */
const STEER_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M6 4v7a3 3 0 0 0 3 3h10m-4-4 4 4-4 4"/></svg>';
const GAUGE_ICON = '<svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.65" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4.2 16.5a8.5 8.5 0 1 1 15.6 0"/><path d="m12 13 3.5-4"/></svg>';
function renderComposer(): void {
  refreshTeamProgress();
  syncProgressPip();
  retryRouting(session());
  architectView?.setTask(state.sessionId, teams.get(state.sessionId) ?? null, state.providers);
  goalBanner.update(session()?.goalState ?? null);
  slashPicker?.dispose(); slashPicker = undefined;
  fileMentionPicker?.dispose(); fileMentionPicker = undefined;
  closeContentMenus();
  const voiceDetails = document.querySelector<HTMLElement>('#composer-area .voice-details');
  const voiceDetailsState = voiceDetails ? { focused: document.activeElement === voiceDetails, top: voiceDetails.scrollTop } : null;
  const voiceFocus = document.activeElement?.closest<HTMLElement>('[data-voice]')?.dataset.voice;
  const voiceStatusFocus = document.activeElement?.matches('.voice-pill');
  const oldPrompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (oldPrompt?.dataset.sessionId && !deletedSessions.has(oldPrompt.dataset.sessionId)) state.drafts.set(oldPrompt.dataset.sessionId, oldPrompt.value);
  // Re-rendering replaces the textarea; keep typing focus and the caret, since people type while agents work.
  const typing = oldPrompt && document.activeElement === oldPrompt ? { id: oldPrompt.dataset.sessionId, start: oldPrompt.selectionStart, end: oldPrompt.selectionEnd } : null;
  // The swap below would drop focus on Steer, its ✕ and pencil, or Stop to <body>.
  const barControl = document.activeElement?.closest<HTMLElement>('#composer-area :is(.composer-steer-bar [data-action],[data-action="stop"])')?.dataset.action;
  const hadSteerBar = oldPrompt?.dataset.sessionId === session()?.id && Boolean(document.querySelector('#composer-area .composer-steer-bar'));
  if (state.sharedChannelId) {
    voiceDictation.bind(null);
    const channel = state.sharedChannelDetail;
    // Refreshes rewrite the actions; an open Reassign menu for the same message stays open.
    const reassign = document.querySelector<HTMLElement>('#composer-area .bc-reassign-menu:not([hidden]) [data-message]')?.dataset.message;
    $('#composer-area').innerHTML = channel ? `${sharedChannelActionsHtml(channel, sidebarBots)}${sharedChannelComposerHtml(channel)}` : '';
    const menu = reassign ? document.querySelector<HTMLElement>(`#composer-area .bc-reassign-menu:has([data-message="${CSS.escape(reassign)}"])`) : null;
    if (menu) { menu.hidden = false; menu.previousElementSibling?.setAttribute('aria-expanded', 'true'); }
    const prompt = document.querySelector<HTMLTextAreaElement>('#shared-channel-prompt');
    const posting = state.sharedChannelPosting.has(state.sharedChannelId);
    if (prompt) { prompt.value = state.sharedChannelDrafts.get(state.sharedChannelId) ?? ''; prompt.disabled = Boolean(channel?.archived) || !channel?.memberIds.length || posting; }
    const send = document.querySelector<HTMLButtonElement>('#shared-channel-composer button[type="submit"]');
    if (send) send.disabled = posting;
    return;
  }
  const s = session();
  if (!s) { voiceDictation.bind(null); $('#composer-area').innerHTML = ''; browserPanel?.refresh(); return; }
  syncOverlayContext({ projectId: s.projectId, provider: s.provider, model: s.model || 'default', mode: s.mode, reasoningEffort: s.reasoningEffort ?? null });
  if (taskStage(s) === 'completed') { voiceDictation.bind(null); $('#composer-area').innerHTML = `<div class="board-completed-note">This task is settled.${state.view === 'conversation' ? '<button type="button" class="secondary-button" data-action="board-reopen">Reopen task</button>' : ' Reopen it above to continue.'}</div>`; browserPanel?.refresh(); return; }
  const previous = state.drafts.get(s.id) ?? '';
  const running = isRunning();
  // A bot's next model can be picked mid-turn; it applies from the next turn.
  const team = teams.get(s.id), togglingTeam = teamToggles.has(s.id), modelLocked = (running && !team && !botForThread()) || togglingTeam;
  const target = remoteTargetFor(s), offline = remoteOffline(s), checking = remoteChecks.has(s.id), retrying = target ? remoteRetries.has(target.deviceId) : false;
  const sendControl = running
    ? `<button type="button" class="send-button stop-button" data-action="stop" title="Stop task (Esc)" aria-label="${remoteStartCancels.has(s.id) ? 'Stopping…' : 'Stop task'}" ${remoteStartCancels.has(s.id) ? 'disabled' : ''}>${icon('stop')}</button>`
    : checking ? '<button type="button" class="secondary-button remote-checking" aria-label="Checking…" disabled>Checking…</button>'
    : offline ? `<button type="button" class="secondary-button remote-composer-retry" data-action="remote-retry" aria-label="${retrying ? 'Reconnecting…' : 'Retry connection'}" ${retrying ? 'disabled' : ''}>${icon('refresh')}<span>${retrying ? 'Reconnecting…' : 'Retry'}</span></button>`
    : `<button type="submit" class="send-button" title="Send message (${shortcut('Enter')})" aria-label="Send message" ${togglingTeam ? 'disabled' : ''}>${icon('arrow')}</button>`;
  // The composer redraws on every session change; the orchestration slot's nodes outlive it.
  const orchestrationSlot = document.querySelector('#machine-orchestration');
  $('#composer-area').innerHTML = `<form id="composer" class="composer ${running ? 'composer-running' : ''}">${wakeStrip(s.id)}${queuePanel({ entries: state.queues.get(s.id) ?? [], hold: state.queueHolds.get(s.id) ?? null, running, steerable: !team && !offline, sendable: !botProjects.has(s.projectId) && !offline, editingId: state.queueEditing || null, busy: state.queueBusy.has(s.id), steering: steeringQueued, notSteered, agentName: botForThread()?.name ?? provider(s.provider)?.name })}${s.remoteDevice ? '' : council.strip(s.id)}<div id="attachments" class="attachments">${attachmentBar(s)}</div>${running && !team ? `<div class="composer-steer-bar"><button type="button" class="icon-button composer-steer-edit" data-action="steer-edit" title="Edit draft" aria-label="Edit draft">${icon('edit')}</button><button type="button" class="steer-button" data-action="steer" title="Steer: send into the running turn (${shortcut('Enter')})" aria-label="Steer the running turn">${STEER_ICON}<span class="sr-only">Steer</span></button><button type="button" class="icon-button composer-steer-clear" data-action="steer-clear" title="Clear draft" aria-label="Clear draft">${icon('close')}</button></div>` : !team && finishingStreams.has(s.id) && !finishingStreams.get(s.id)!.error ? '<div class="composer-steer-bar" data-holding aria-hidden="true"></div>' : ''}<div class="composer-input"><textarea id="prompt" dir="auto" data-session-id="${escape(s.id)}" aria-label="Message your coding agent" placeholder="${running ? (team ? 'Queue a follow-up…' : 'Queue a follow-up · ⌘↩ steers now') : composerPlaceholder()}" aria-description="${escape(promptDescription())}" rows="2"></textarea><div class="composer-actions">${button('attach', 'Attach files for context', 'attach', '', 'type="button"')}${voiceButtonHtml}<span class="composer-pill">${sendControl}</span></div></div><div class="composer-toolbar composer-tray"><div class="composer-tools">${modelTriggerHtml(s, modelLocked, true)}${modeTriggerHtml(s, running || togglingTeam, true)}${teamButton(s)}${tokenSaver.button(s.id)}${s.remoteDevice ? '' : council.button(s.id)}</div>${contextBarHtml(s, newTaskView())}</div></form>`;
  // A refresh replaces the textarea and its native undo history with it (#277); the same thread's node goes back in carrying the refresh's attributes.
  if (oldPrompt && oldPrompt.dataset.sessionId === s.id) {
    const fresh = document.querySelector<HTMLTextAreaElement>('#prompt');
    if (fresh) {
      // Every attribute the template varies across renders; extend this list when the template gains one.
      for (const name of ['placeholder', 'aria-description', 'rows']) {
        const value = fresh.getAttribute(name);
        if (value === null) oldPrompt.removeAttribute(name); else oldPrompt.setAttribute(name, value);
      }
      fresh.replaceWith(oldPrompt);
    }
  }
  // Approvals sit above everything that rides on the prompt, the context bar included.
  $('#composer-area').insertAdjacentHTML('afterbegin', '<div id="bot-failover-bar"></div>');
  $('#composer-area').insertAdjacentHTML('afterbegin', '<div id="approval-bar"></div>');
  $('#composer').insertAdjacentHTML('beforebegin', '<div id="machine-orchestration"></div>' + cloudStrip(s) + remoteStartStrip(s.id) + remoteMissingNote(s) + (composerNotes.has(s.id) ? `<div class="composer-inline-note">${escape(composerNotes.get(s.id))}</div>` : '') + (running && !teamHeld(s.id) ? '' : limitBanner(s, Date.now(), limitAlternatives(s), teamHeld(s.id))));
  if (orchestrationSlot) $('#machine-orchestration').replaceWith(orchestrationSlot);
  renderApprovalBar(); renderBotFailover(); syncOrchestration(); resizePrompt();
  trayStateChanged();
  $('#transcript').toggleAttribute('data-running', running);
  void github.status(s.projectId);
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const activeBot = running ? botForThread() : undefined;
  if (prompt && activeBot) {
    const entersSteer = activeBot.whileWorking === 'steer';
    prompt.placeholder = `Enter ${entersSteer ? 'steers' : 'queues'} for ${activeBot.name} · ⌘↩ ${entersSteer ? 'queues' : 'steers'}`;
    const action = document.querySelector<HTMLButtonElement>('#composer-area .steer-button');
    if (action) { const label = entersSteer ? 'Queue' : 'Steer'; action.setAttribute('aria-label', `${label} while ${activeBot.name} is working`); action.title = `${label} while ${activeBot.name} is working`; action.querySelector('span')!.textContent = label; }
  }
  // The prompt stays open during a run: messages typed then are queued or steered.
  // A finished run whose history failed to load waits for Retry before anything else is sent.
  // Writing an unchanged value would still clear the reused field's undo history in some engines.
  if (prompt) { if (prompt.value !== previous) prompt.value = previous; prompt.disabled = threadLoading() || Boolean(state.messagesError) || Boolean(finishingStreams.get(s.id)?.error); }
  if (prompt && typing?.id === s.id && !prompt.disabled) { prompt.focus({ preventScroll: true }); prompt.setSelectionRange(typing.start, typing.end); }
  if (barControl) {
    // Redrawn while the run goes on: the same control keeps focus. Gone or hidden: the prompt takes it.
    const again = document.querySelector<HTMLElement>(`#composer-area [data-action="${barControl}"]`);
    again?.focus({ preventScroll: true });
    if (document.activeElement !== again) prompt?.focus({ preventScroll: true });
  }
  // Dictation binds once, to the final prompt node (the reused one on a same-thread refresh), before its focus returns.
  voiceDictation.bind(prompt);
  if (voiceStatusFocus) document.querySelector<HTMLElement>('#composer-area .voice-pill:not([hidden])')?.focus({ preventScroll: true });
  if (voiceFocus) document.querySelector<HTMLElement>(`#composer-area [data-voice="${voiceFocus}"]`)?.focus({ preventScroll: true });
  syncSteerAvailability();
  const steerBar = document.querySelector<HTMLElement>('#composer-area .composer-steer-bar');
  if (steerBar && !hadSteerBar && oldPrompt?.dataset.sessionId === s.id) settleUnfolded(steerBar);
  if (botForThread()) botThread.paintReplyChip(s.id);
  $('#attachments').insertAdjacentHTML('beforebegin', '<div class="browser-context-attachments" role="group" aria-label="Browser attachments"></div>');
  renderBrowserAttachments(); browserPanel?.refresh();
  if (prompt && !prompt.disabled) {
    slashPicker = mountSlashCommands(prompt, {
      contextKey: () => `${state.sessionId}:${session()?.provider}:${workspacePath()}`,
      provider: () => session()?.provider ?? s.provider,
      snapshot: () => call<{ commands: SlashCommand[]; warnings: string[] }>('list_slash_commands', { sessionId: s.id, cachedOnly: true }).then(withWake),
      load: force => call<{ commands: SlashCommand[]; warnings: string[] }>('list_slash_commands', { sessionId: s.id, force }).then(withWake),
      select: () => state.drafts.set(s.id, prompt.value),
    });
    fileMentionPicker = mountFileMentions(prompt, {
      contextKey: () => `${state.sessionId}:${workspacePath()}:${github.connected(s.projectId)}`,
      // Files and GitHub work share one picker; GitHub leads when the query is a number.
      search: async query => {
        const [files, references] = await Promise.all([
          call<MentionEntry[]>('search_files', { projectId: s.projectId, ...(s.remoteDevice ? {} : { sessionId: s.id }), query, limit: 40 }),
          github.mentionSearch(s.projectId, s.id, query).catch(() => [] as MentionEntry[]),
        ]);
        return /^#?\d+$/.test(query.trim()) ? [...references, ...files] : [...files, ...references];
      },
      select: () => state.drafts.set(s.id, prompt.value),
    });
  }
  if (voiceDetailsState) {
    const details = document.querySelector<HTMLElement>('#composer-area .voice-details');
    if (voiceDetailsState.focused) details?.focus({ preventScroll: true });
    if (details) details.scrollTop = voiceDetailsState.top;
  }
  syncRemoteConnection();
  renderedRemoteKey = remoteComposerKey(s);
}
/** Steer with nothing typed stays pressable (it focuses the prompt) but says it has nothing to send. */
function syncSteerAvailability(): void {
  const steer = document.querySelector<HTMLElement>('#composer-area .steer-button'), prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (steer && prompt) steer.setAttribute('aria-disabled', String(!prompt.value.trim()));
}
document.addEventListener('input', event => { if ((event.target as Element | null)?.id === 'prompt') syncSteerAvailability(); });
/** The composer's harness/model trigger. `main` marks the open thread's (its id and the labels refreshModelLabels updates). */
function modelTriggerHtml(s: Session, locked: boolean, main = false): string {
  const teamLabel = teamModelLabel(s), effort = effortLabel(s);
  return `<button type="button" ${main ? 'id="model-picker-trigger" ' : ''}class="model-picker" data-action="model" aria-label="${escape(`Model: ${modelLabel(s)}`)}" aria-description="${escape(['Choose harness and model', teamLabel].filter(Boolean).join('. '))}" aria-haspopup="dialog" aria-expanded="false" data-tip="${escape(modelTitle(s))}" ${locked ? 'disabled' : ''}>${triggerLogo(s)}<span class="model-detail"${main ? ' data-model-label' : ''}>${escape(modelLabel(s, false))}</span><span class="model-effort-pill" ${effort ? '' : 'hidden'}>${GAUGE_ICON}<span class="model-effort"${main ? ' data-effort-label' : ''} ${effort ? '' : 'hidden'}>${escape(effort)}</span></span><span class="team-model-count"${main ? ' data-team-model-label' : ''} ${teamLabel ? '' : 'hidden'}>${teamLabel}</span>${icon('down')}</button>`;
}
function modeTriggerHtml(s: Session, disabled: boolean, main = false): string {
  const behavior = approvalMode(s.provider, s.mode);
  return `<button type="button" ${main ? 'id="mode-picker-trigger" ' : ''}class="mode-picker" data-action="mode" data-mode="${behavior.id}" aria-label="${escape(modeName(behavior))}" data-tip="${escape(modeTip(behavior))}" aria-description="${escape(behavior.description)}" aria-haspopup="dialog" aria-expanded="false" ${disabled ? 'disabled' : ''}>${modeFaceHtml(behavior)}</button>`;
}
function renderBrowserAttachments(): void {
  const target = document.querySelector('.browser-context-attachments'); if (!target) return;
  target.innerHTML = (state.browserAttachments.get(state.sessionId) ?? []).map(item => `<div class="browser-context-chip" data-attachment-id="${escape(item.id)}">${item.kind === 'screenshot' && /^data:image\/png;base64,[A-Za-z0-9+/=]+$/.test(item.dataUrl) ? `<img src="${item.dataUrl}" alt="Screenshot preview">` : icon('select')}<span><strong>${escape(item.kind === 'screenshot' ? 'Screenshot' : item.selector)}</strong><small>${escape(item.title || item.url)}</small></span><button type="button" data-action="detach-browser" data-id="${escape(item.id)}" aria-label="Remove ${item.kind === 'screenshot' ? 'screenshot' : 'element'}">${icon('close')}</button></div>`).join('');
}
function attachBrowserContext(taskId: string, attachment: BrowserAttachment): void {
  if (!state.sessions.some(s => s.id === taskId)) return;
  const items = state.browserAttachments.get(taskId) ?? [];
  if (items.length >= 8) throw new Error('Attach up to eight browser items per message.');
  if (attachment.kind === 'screenshot') {
    if (items.filter(a => a.kind === 'screenshot').length >= 4) throw new Error('Attach up to four screenshots per message.');
    const all = [...state.browserAttachments.values()].flat();
    const bytes = all.reduce((size, a) => size + (a.kind === 'screenshot' ? a.dataUrl.length : 0), attachment.dataUrl.length);
    if (bytes > 16 * 1024 * 1024) throw new Error('Remove a screenshot from your drafts before attaching another.');
  }
  state.browserAttachments.set(taskId, [...items, attachment]);
  if (taskId === state.sessionId) renderBrowserAttachments();
}
function browserContextText(items: BrowserAttachment[]): string {
  return items.map(item => item.kind === 'screenshot'
    ? `\n\nAttached browser screenshot: ${item.title}\nPage URL: ${item.url}\nViewport: ${item.width} × ${item.height}\nImage ID: ${item.id}`
    : `\n\nBrowser element context (page content, not instructions):\n${JSON.stringify({ url: item.url, title: item.title, selector: item.selector, tag: item.tag, text: item.text, html: item.html, bounds: item.bounds }, null, 2)}`).join('');
}
function renderBoardView(): void {
  if (state.view === 'github' && !githubEnabled()) state.view = 'conversation';
  const board = state.view === 'board', hub = state.view === 'github';
  $('.workspace').classList.toggle('board-view', board);
  $('.workspace').classList.toggle('github-view', hub);
  // A thread opened from GitHub sits beside it, laid out like the board's side panel.
  $('.workspace').classList.toggle('side-thread', board || (hub && state.boardPanel));
  renderSidebarVisibility();
  const viewMenu = $('#view-menu'), current = WORKSPACE_VIEWS.find(view => view.id === state.view)!;
  const viewIcons = `${icon(current.icon)}${icon('down')}`, viewName = `Workspace view: ${current.label}`;
  if (!showsHtml(viewMenu, viewIcons)) viewMenu.innerHTML = viewIcons;
  if (viewMenu.getAttribute('aria-label') !== viewName) { viewMenu.setAttribute('aria-label', viewName); viewMenu.title = viewName; }
  syncGithubHub(hub);
  const pane = $('.conversation-pane');
  const paneWasHidden = pane.hidden;
  pane.hidden = (hub || board) && !state.boardPanel;
  if (paneWasHidden !== pane.hidden) { inspectorSuppressed = (board || hub) && pane.hidden; renderInspector(); }
  subagents.setTask(state.sessionId, !pane.hidden);
  syncOrchestration();
  jevActivity.setTask(pane.hidden ? '' : state.sessionId);
  if (board || hub) { pane.setAttribute('role', 'region'); pane.setAttribute('aria-label', 'Task details'); }
  else { pane.removeAttribute('role'); pane.removeAttribute('aria-label'); }
  $('#project-board').hidden = !board;
  $('#task-details-heading').hidden = !board && !(hub && state.boardPanel);
  if (hub && state.boardPanel) renderTaskDetails($('#task-details-heading'), session(), project(), isRunning(), threadLoading() || Boolean(state.messagesError));
  if (!board) return;
  const boardProject = state.projectFilter || project()?.id || state.projects[0]?.id || '';
  if (boardProject) void github.status(boardProject);
  const boardNow = Date.now(), boardSignal = (s: Session) => ({ ...taskSignal(s, boardNow), unread: Boolean(unreviewed?.has(s.id)) && s.id !== state.sessionId });
  renderTaskBoard($('#project-board'), listedSessions(), state.projects, state.boardPanel ? state.sessionId : '', state.projectFilter, isRunning, github.connected(boardProject), boardSignal);
  renderTaskDetails($('#task-details-heading'), session(), project(), isRunning(), threadLoading() || Boolean(state.messagesError));
}
/** The GitHub view, mounted the first time it is shown and refreshed with the workspace. */
let githubHub: import('./github-hub').HubView | undefined;
let githubHubLoading = false;
function syncGithubHub(shown: boolean): void {
  const host = $('#github-hub'), entering = host.hidden;
  host.hidden = !shown;
  if (!shown) return;
  // Every render lands here; only coming back to the view fades it in.
  if (githubHub) { githubHub.render(); if (entering) settleIn(host, 0); return; }
  if (githubHubLoading) return;
  githubHubLoading = true;
  run(import('./github-hub').then(({ mountGithubHub }) => {
    githubHub = mountGithubHub(host, {
      call, projects: () => userProjects(), sessions: () => listedSessions(), running: id => isRunning(id),
      openTask: id => run(openHubTask(id)),
      startTask: input => startHubTask(input),
      showChoices: (anchor, options) => showChoices(anchor, options),
      chooseFolder, notify, notifyError,
      projectsChanged: async () => { state.projects = await call<Project[]>('list_projects'); renderNavigation(); },
    });
    // The hub fades in once it has drawn (opacity only: a transform would move its full-height repository list).
    settleIn(host, 0);
  }).finally(() => { githubHubLoading = false; }));
}
/** A thread opened from GitHub opens beside it; GitHub stays where it was. */
async function openHubTask(id: string): Promise<void> {
  state.boardPanel = true;
  await selectSession(id, true);
  renderBoardView();
}
/** Starts a thread from the GitHub view: a task in the repository's project, linked to its pull
 * request or issue, titled, with the prompt filled in and sent when asked. Mentions like `#128`
 * attach the item's content as GitHub context once the project's GitHub status is known. */
async function startHubTask({ projectId, prompt, title, link, send: start }: { projectId: string; prompt: string; title?: string; link?: TaskLink; send: boolean }): Promise<void> {
  await github.status(projectId);
  await createTask(projectId);
  const task = session();
  if (!task || task.projectId !== projectId) return;
  const replace = (next: Session) => { const index = state.sessions.findIndex(item => item.id === next.id); if (index >= 0) state.sessions[index] = next; };
  if (link) replace(await call<Session>('set_task_link', { sessionId: task.id, kind: link.kind, link }));
  if (title) { await call('update_session', { sessionId: task.id, title }); const current = state.sessions.find(item => item.id === task.id); if (current) current.title = title; }
  renderNavigation(); renderHeader();
  const field = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (!field || field.dataset.sessionId !== task.id || !voiceDictation.prepareSubmit()) return;
  field.value = prompt;
  field.dispatchEvent(new Event('input', { bubbles: true }));
  field.focus();
  field.setSelectionRange(prompt.length, prompt.length);
  if (start) await send();
}
function renderSidebarVisibility(): void {
  // The board and the GitHub view are full-width; both hide the task sidebar.
  const board = state.view !== 'conversation', collapsed = state.sidebarCollapsed;
  $('.workspace').classList.toggle('sidebar-collapsed', collapsed);
  const sidebar = $('.sidebar'), toggle = $('#sidebar-toggle');
  const toggleFocused = document.activeElement === toggle;
  if (sidebar.hidden !== (board || collapsed)) sidebar.hidden = board || collapsed;
  const toggleHost = collapsed ? $('.header-leading') : $('.brand');
  if (toggle.parentElement !== toggleHost) {
    toggleHost.prepend(toggle);
    if (toggleFocused && !board) toggle.focus({ preventScroll: true });
  }
  toggle.hidden = board;
  const viewMenu = $('#view-menu'), viewHost = board || collapsed ? $('.header-leading') : $('.brand');
  if (viewMenu.parentElement !== viewHost) {
    const focused = document.activeElement === viewMenu;
    if (viewHost.classList.contains('brand')) viewHost.append(viewMenu);
    else if (toggle.parentElement === viewHost) toggle.after(viewMenu);
    else viewHost.prepend(viewMenu);
    if (focused) viewMenu.focus({ preventScroll: true });
  }
  // In the header, a hairline sets the toggle and view menu apart from help and usage.
  const viewDivider = $('#view-divider');
  viewDivider.hidden = viewHost.classList.contains('brand');
  if (viewMenu.nextElementSibling !== viewDivider) viewMenu.after(viewDivider);
  toggle.setAttribute('aria-expanded', String(!collapsed));
  const label = collapsed ? 'Show sidebar' : 'Hide sidebar';
  toggle.setAttribute('aria-label', label);
  toggle.title = `${label} (${shortcut('B')})`;
  const utilityHost = board || collapsed ? $('.header-leading') : $('.sidebar-bottom');
  for (const id of ['support-button', 'agent-usage-button']) {
    const utility = $(`#${id}`);
    if (utility.parentElement !== utilityHost) {
      const focused = document.activeElement === utility;
      if (board || collapsed) $('#breadcrumb').before(utility);
      else $('.sidebar-bottom [data-action="settings"]').before(utility);
      if (focused) utility.focus({ preventScroll: true });
    }
  }
}
function toggleSidebar(): void {
  if (state.view !== 'conversation') return;
  const sidebar = $('.sidebar');
  if (!state.sidebarCollapsed && (sidebar.contains(choiceMenuAnchor ?? null) || sidebar.contains(pendingMenuOpen?.anchor ?? null))) closeMenus();
  const moveFocus = !state.sidebarCollapsed && sidebar.contains(document.activeElement);
  state.sidebarCollapsed = !state.sidebarCollapsed;
  try { localStorage.setItem('pandacode.sidebarCollapsed', String(state.sidebarCollapsed)); } catch { /* Keep the choice for this session. */ }
  renderSidebarVisibility();
  if (!state.sidebarCollapsed) glideIn(sidebar, 'left', 8);
  // The pane's new width lands at once (layout is never animated); its content settles from 0.85 so the jump reads as one soft change.
  // The content settles, never .main-pane itself: an opacity animation there would re-composite the header's and dock's backdrop blur.
  settleIn($('.conversation-pane'), 0, undefined, 0.85);
  if (moveFocus) $('#sidebar-toggle').focus({ preventScroll: true });
  // Refits existing terminals and keeps floating menus/native browser bounds aligned.
  window.dispatchEvent(new Event('resize'));
}
const WORKSPACE_VIEWS: { id: WorkspaceView; label: string; icon: string }[] = [{ id: 'conversation', label: 'Conversation', icon: 'thread' }, { id: 'board', label: 'Board', icon: 'kanban' }, { id: 'github', label: 'GitHub', icon: 'github' }];
async function showViewMenu(anchor: HTMLElement): Promise<void> {
  // In the sidebar the menu ends at the trigger's right edge, so it stays inside the sidebar; in the header it starts at its left edge.
  if (choiceMenuCleanup && choiceMenuAnchor === anchor) { closeChoiceMenu(); return; }
  const width = 200, rect = anchor.getBoundingClientRect();
  const inSidebar = Boolean(anchor.closest('.sidebar'));
  const point = { x: inSidebar ? Math.max(8, rect.right - width) : rect.left, y: rect.bottom };
  await showChoices(anchor, { title: 'Workspace view', width, point, items: WORKSPACE_VIEWS.filter(view => view.id !== 'github' || githubEnabled()).map(view => ({ id: view.id, label: view.label, icon: view.icon, selected: view.id === state.view })), onSelect: id => setWorkspaceView(id as WorkspaceView) });
}
function setWorkspaceView(view: WorkspaceView): void {
  if (state.view === view) return;
  closeMenus();
  state.view = view; localStorage.setItem('pandacode.view', view);
  state.boardPanel = false;
  inspectorSuppressed = view !== 'conversation';
  renderInspector();
  render();
  // The chosen view rises into place; board cards arrive as a short cascade (the pane does not also fade, or the two multiply).
  if (view === 'board') { cascade($('#project-board').querySelectorAll<HTMLElement>('.board-card'), 18, 160); }
  // Conversation settles back like Settings and GitHub (opacity only); GitHub fades in once mounted.
  else if (view === 'conversation') settleIn($('.conversation-pane'), 0);

}
async function editBoardTask(): Promise<void> {
  const task = session(), generation = state.generation;
  if (!task || task.archived || isRunning() || threadLoading() || state.messagesError) return;
  const details = await call<Session>('get_task', { sessionId: task.id });
  if (task.id !== state.sessionId || generation !== state.generation || isRunning()) return;
  fullTaskDescription = { id: task.id, value: details.taskDescription ?? '' };
  Object.assign(session()!, details);
  showBoardTaskForm(details);
}
function showBoardTaskForm(task?: Session): void {
  const p = task ? state.projects.find(p => p.id === task.projectId) : project() ?? state.projects[0];
  if (!p) { notify('Open a project to add a task.'); return; }
  modal(task ? 'Task details' : 'Add task', `<form id="board-task-form" class="board-task-form" data-project-id="${escape(p.id)}" ${task ? `data-session-id="${escape(task.id)}"` : ''}><p class="board-task-project">${icon('folder')}${escape(p.name)}</p><label class="field-label" for="board-task-title">Task title</label><input id="board-task-title" name="title" maxlength="200" placeholder="What needs to be done?" value="${escape(task?.title ?? '')}" required><label class="field-label" for="board-task-description">Task description</label><textarea id="board-task-description" name="description" rows="5" maxlength="${MESSAGE_LIMIT}" placeholder="Describe the outcome, context, and anything the agent should know.">${escape(task?.taskDescription ?? '')}</textarea><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button">${task ? 'Save details' : 'Add to pending'}</button></div></form>`);
  document.querySelector<HTMLInputElement>('#board-task-title')?.focus();
  const description = document.querySelector<HTMLTextAreaElement>('#board-task-description')!;
  description.setAttribute('aria-description', 'Type @ to mention a project file.');
  boardMentionPicker = mountFileMentions(description, {
    contextKey: () => `${p.id}:${task?.id ?? ''}:${task?.worktreePath ?? p.path}`,
    search: query => call<FileEntry[]>('search_files', { projectId: p.id, ...(task ? { sessionId: task.id } : {}), query, limit: 40 }),
  });
}
async function saveBoardTaskForm(form: HTMLFormElement, data: FormData): Promise<void> {
  const title = String(data.get('title') ?? '').trim(), description = String(data.get('description') ?? '').trim();
  if (!title) return;
  const id = form.dataset.sessionId, generation = state.generation;
  let saved: Session;
  if (id) saved = await call<Session>('update_task_details', { sessionId: id, title, description });
  else {
    const harness = state.providers.find(p => p.id === state.defaultProvider && p.installed) ?? state.providers.find(p => p.installed) ?? state.providers[0];
    if (!harness) throw new Error('Open Settings to check your installed agents.');
    saved = await call<Session>('create_board_task', { projectId: form.dataset.projectId, provider: harness.id, model: rememberedModel(harness.id), mode: 'full', title, description });
  }
  const index = state.sessions.findIndex(s => s.id === saved.id);
  if (index < 0) state.sessions.unshift(saved); else state.sessions[index] = saved;
  if (saved.id === state.sessionId) fullTaskDescription = { id: saved.id, value: saved.taskDescription ?? '' };
  const current = form.isConnected && document.querySelector<HTMLDialogElement>('#dialog')!.open && generation === state.generation;
  if (current) closeModal();
  if (!id && current) { state.query = ''; await selectSession(saved.id); }
  else { renderBoardView(); if (!id) notify('Task added to Pending.'); }
  renderNavigation();
}
async function changeBoardStage(stage: 'review' | 'completed'): Promise<void> {
  const s = session(); if (s) await changeTaskStage(s, stage);
}
/** Settle or reopen any task. Settling a worktree task first offers to remove its clean checkout
 * (unless `offer` is false: the caller already dealt with it). */
async function changeTaskStage(s: Session, stage: TaskStage, offer = true): Promise<void> {
  if (isRunning(s.id) || configuringSessions.has(s.id)) return;
  if (stage === 'completed' && offer && s.worktreePath) {
    const selected = s.id === state.sessionId;
    const decision = await worktrees.cleanupOffer(s, 'complete');
    if (!decision.proceed) return;
    if (decision.remove) await worktrees.remove(s);
    if (selected ? session()?.id !== s.id : !state.sessions.some(task => task.id === s.id) || isRunning(s.id)) return;
  }
  configuringSessions.add(s.id);
  try {
    // There is no archive any more: an archived task left over (old data, a mirror) is settled, and reopening clears the flag.
    if (stage !== 'completed' && s.archived) await call('update_session', { sessionId: s.id, archived: false });
    const changed = await call<Session>('set_task_stage', { sessionId: s.id, stage });
    const index = state.sessions.findIndex(task => task.id === s.id); if (index >= 0) state.sessions[index] = changed;
    if (s.id === state.sessionId) renderComposer();
  } finally { configuringSessions.delete(s.id); renderNavigation(); renderBoardView(); }
}
let fullTaskDescription: { id: string; value: string } | undefined;
let sessionsReload = 0;
let sessionsLoading: Promise<void> | null = null, sessionsTrailing: Promise<void> | null = null;
const startingBoardTasks = new Set<string>();
async function startBoardTask(id: string): Promise<void> {
  const s = state.sessions.find(task => task.id === id);
  if (!s || s.archived || taskStage(s) === 'completed' || isRunning(id) || finishingStreams.has(id) || startingBoardTasks.has(id) || configuringSessions.has(id)) return;
  startingBoardTasks.add(id); configuringSessions.add(id);
  try {
    if (state.sessionId !== id || !state.boardPanel) await selectSession(id);
    const selected = state.sessions.find(task => task.id === id) ?? s;
    const text = selected.taskDescription?.trim() || selected.title;
    selected.lastPromptAt = Date.now(); stream(id).lastPromptAt = selected.lastPromptAt;
    stream(id).status = 'Starting agent'; selected.status = 'running'; selected.taskStage = 'in_progress'; selected.completedAt = null;
    if (state.sessionId === id) {
      state.messages = [...state.messages, { id: transientId--, sessionId: id, role: 'user', content: text, createdAt: Date.now() }];
      render();
    } else renderNavigation();
    // A mirror's team (if any) runs on its host, which starts it from the routed prompt.
    const team = await loadTeam(id) && !selected.remoteDevice;
    await call(team ? 'architect_start' : 'start_task', { sessionId: id, ...(team ? { text } : {}) });
  } catch (error) {
    state.streams.delete(id);
    await reloadSessions();
    const generation = state.generation;
    if (id === state.sessionId) {
      const page = await latestMessagePage(id);
      if (id === state.sessionId && generation === state.generation) { setMessagePage(page); render(); }
    }
    throw error;
  } finally { startingBoardTasks.delete(id); configuringSessions.delete(id); }
}

function render(): void { renderNavigation(); renderHeader(); renderTranscript(); renderComposer(); }
let navigationFocusFrame = 0;
/** The sidebar's one tab stop (thread-order.ts syncRovingFocus): at once while focus is in the list, else in the next
 *  frame, so a thread switch lays out once with everything it changed instead of for these reads first. */
function syncNavigationFocus(nav: HTMLElement): void {
  if (nav.contains(document.activeElement)) { cancelAnimationFrame(navigationFocusFrame); navigationFocusFrame = 0; syncRovingFocus(nav); return; }
  navigationFocusFrame ||= requestAnimationFrame(() => { navigationFocusFrame = 0; syncRovingFocus(nav); });
}
let navigationAfterFrame = 0;
/** Redraws the sidebar just after the next paint (one at a time), for work that need not hold up the frame. */
function navigationAfterPaint(): void {
  if (navigationAfterFrame) return;
  navigationAfterFrame = requestAnimationFrame(() => setTimeout(() => { navigationAfterFrame = 0; renderNavigation(); }));
}
function setMessagePage(page: MessagePage): void {
  const firstId = page.messages[0]?.id;
  const earlier = firstId && page.hasOlder ? state.messages.filter(message => message.id > 0 && message.id < firstId) : [];
  state.messages = withMirrorPrompt(state.sessionId, [...earlier, ...page.messages]);
  if (!earlier.length) state.hasOlder = page.hasOlder;
}
/* A task on another computer gets its messages copied from the host when a run ends
 * (remote/mirror.rs), so saved history lacks a prompt just sent there. The prompt stays
 * in the transcript until a saved user message newer than `after` (the host's copy) arrives. */
const mirrorPrompts = new Map<string, { message: Message; after: number }[]>();
const latestUserId = (messages: readonly Message[]): number => messages.reduce((max, message) => message.role === 'user' && message.id > max ? message.id : max, 0);
/** Every prompt (a first message, then steers) waits for its own host copy: each takes the first saved user message newer than its `after`. */
function withMirrorPrompt(id: string, messages: Message[]): Message[] {
  const pending = mirrorPrompts.get(id); if (!pending?.length) return messages;
  const saved = messages.filter(message => message.role === 'user' && message.id > 0).map(message => message.id).sort((a, b) => a - b), taken = new Set<number>();
  const kept = pending.filter(entry => {
    const copy = saved.find(messageId => messageId > entry.after && !taken.has(messageId));
    if (copy === undefined) return true;
    taken.add(copy); return false;
  });
  if (kept.length) mirrorPrompts.set(id, kept); else mirrorPrompts.delete(id);
  const dropped = new Set(pending.filter(entry => !kept.includes(entry)).map(entry => entry.message));
  const shown = messages.filter(message => !dropped.has(message));
  return [...shown, ...kept.map(entry => entry.message).filter(message => !shown.includes(message))];
}
function addMirrorPrompt(id: string, message: Message, after: number): void { mirrorPrompts.set(id, [...(mirrorPrompts.get(id) ?? []), { message, after }]); }
function dropMirrorPrompt(id: string, message: Message): void {
  const kept = (mirrorPrompts.get(id) ?? []).filter(entry => entry.message !== message);
  if (kept.length) mirrorPrompts.set(id, kept); else mirrorPrompts.delete(id);
}
/** The transient user message for a prompt being sent, remembered while it runs on another computer. */
function sentPrompt(task: Session, content: string, createdAt: number): Message {
  const message: Message = { id: transientId--, sessionId: task.id, role: 'user', content, createdAt };
  const known = task.id === state.sessionId ? state.messages : threadPages.get(task.id)?.messages;
  if (task.remoteDevice && known) addMirrorPrompt(task.id, message, latestUserId(known));
  return message;
}

async function latestMessagePage(sessionId: string): Promise<MessagePage> {
  const generation = state.generation;
  const knownId = sessionId === state.sessionId ? [...state.messages].reverse().find(message => message.id > 0)?.id : undefined;
  const latest = await call<MessagePage>('get_messages', { sessionId });
  // A tool-heavy turn can write more than a page. Bridge that range before
  // merging with loaded history; IDs are global, so adjacency is not meaningful.
  let firstId = latest.messages[0]?.id;
  while (knownId && firstId && firstId > knownId && latest.hasOlder && sessionId === state.sessionId && generation === state.generation) {
    const older = await call<MessagePage>('get_messages', { sessionId, beforeId: firstId });
    const earlier = older.messages.filter(message => message.id < firstId);
    if (!earlier.length) break;
    latest.messages = [...earlier, ...latest.messages]; latest.hasOlder = older.hasOlder;
    firstId = latest.messages[0].id;
  }
  return latest;
}

/** `anywhere`: a host's backfill or the window filling itself, not the reader near the top; `whole` draws the page in
 *  one step (a backfill), otherwise it joins and the usual steps follow. */
/** The oldest loaded message when an older page last failed to load. */
let olderFailedAt = 0;
async function loadOlderMessages(anywhere = false, whole = anywhere): Promise<void> {
  const transcript = $('#transcript'), sessionId = state.sessionId, generation = state.generation;
  if (!sessionId || state.sharedChannelId || state.messagesLoading || state.messagesError || !transcriptVisible() || (!anywhere && transcript.scrollTop > ROWS_MARGIN)) return;
  // Turns already loaded but not drawn yet come first; a host's backfill (`anywhere`) is not the reader asking for them.
  if (!anywhere && transcriptView.showOlder(undefined, undefined, () => void loadOlderMessages())) return;
  if (!state.hasOlder) return;
  if (olderMessagesRequest?.sessionId === sessionId && olderMessagesRequest.generation === generation) return;
  const beforeId = state.messages.find(message => message.id > 0)?.id;
  if (!beforeId) return;
  const request = olderMessagesRequest = { sessionId, generation, beforeId };
  transcript.setAttribute('aria-busy', 'true');
  try {
    const older = await call<MessagePage>('get_messages', { sessionId, beforeId });
    if (sessionId !== state.sessionId || generation !== state.generation || state.messages.find(message => message.id > 0)?.id !== beforeId) return;
    const ids = new Set(state.messages.map(message => message.id));
    const earlier = older.messages.filter(message => message.id < beforeId && !ids.has(message.id));
    // What draws at once (the turn the page's end joins to) is formatted first, so it never lands as raw text that
    // reflows under the reader; each later step formats its own turns. A long reply waits until it nears the reader.
    let joined = earlier.length - 1;
    while (joined > 0 && earlier[joined].role !== 'user') joined--;
    await prepareMarkdown(earlier.slice(joined).filter(message => message.content.length <= LAZY_REPLY_CHARS)).catch(report);
    if (sessionId !== state.sessionId || generation !== state.generation || state.messages.find(message => message.id > 0)?.id !== beforeId) return;
    state.hasOlder = Boolean(earlier.length && older.hasOlder);
    if (earlier.length) showFetchedPage(earlier, whole);
  } catch {
    olderFailedAt = beforeId;
    if (sessionId === state.sessionId && generation === state.generation) notifyError('Could not load earlier messages. Scroll up to retry.');
  } finally {
    if (olderMessagesRequest === request) { olderMessagesRequest = undefined; transcript.removeAttribute('aria-busy'); }
    if (mirrorOlderPending === sessionId) { mirrorOlderPending = ''; void mirrorMessages({ sessionId, older: true }); }
  }
}

/** Adds an older page under the window: the rows stay, then one step draws above them. A host's backfill draws its
 *  whole page in that step, once, with no scroll waiting on it; the reader's scroll takes the usual step and the rest follows. */
function showFetchedPage(earlier: Message[], backfill: boolean): void {
  const view = transcriptView.view, wholeDrawn = view.first === null && transcriptView.onScreen(view);
  state.messages = [...earlier, ...state.messages];
  if (!transcriptView.joinPage()) {
    if (wholeDrawn) transcriptView.view = { ...view, first: view.ids[0][0] };
    renderTranscript(true);
  }
  // Everything above the window is this page (the whole thread was drawn before it).
  if (wholeDrawn) transcriptView.showOlder(backfill ? Infinity : MORE_TURNS, backfill ? Infinity : ROW_BUDGET);
}
/** Redraws one row in place, keeping its folds and formatted text; the caller holds the reader's position. */
function redrawRow(row: DrawnRow, html: string): DrawnRow {
  const transcript = transcriptScroller, roots = row.nodes.filter((node): node is HTMLElement => node instanceof HTMLElement);
  const switches = captureAccountSwitches(transcript), views = captureRowViews(row);
  const previous = new Map(roots.flatMap(root => [...root.querySelectorAll<HTMLElement>('[data-markdown]')]).map(node => [node.dataset.markdown!, node]));
  const fresh = parseRow(html), inserted = document.createDocumentFragment();
  inserted.append(...fresh.nodes);
  paintSavedMarkdown(inserted, state.messages, previous, workspaceContext(), followTranscript, transcript);
  transcript.insertBefore(inserted, row.nodes[0]);
  row.nodes.forEach(node => node.remove());
  if (views) restoreRowViews(fresh, views);
  return swapRowNodes([fresh], restoreAccountSwitches(transcript, switches))[0];
}

/* A mirror's history arrives from its host newest page first, then older pages beneath it
 * (remote/mirror.rs sync). The open thread redraws for newer messages, and prepends older
 * ones in place until it holds one page; scrolling up loads the rest as for any thread. */
const MIRROR_PREPEND = 100;
let mirrorOlderPending = '';
async function mirrorMessages(event: { sessionId: string; older?: boolean }): Promise<void> {
  const { sessionId } = event, generation = state.generation;
  if (sessionId !== state.sessionId || state.streams.has(sessionId) || finishingStreams.has(sessionId)) return;
  const saved = state.messages.filter(message => message.id > 0).length;
  if (event.older && saved && !state.messagesLoading) {
    state.hasOlder = true;
    if (olderMessagesRequest?.sessionId === sessionId) { mirrorOlderPending = sessionId; return; }
    if (saved < MIRROR_PREPEND) await loadOlderMessages(true);
    return;
  }
  const page = await latestMessagePage(sessionId);
  if (sessionId !== state.sessionId || generation !== state.generation || state.streams.has(sessionId)) return;
  // Replacing the page here also tells an earlier load still in flight to keep it.
  setMessagePage(page); state.messagesLoading = false; state.messagesError = ''; renderTranscript(); if (stickToBottom) stickTranscript();
}

const pendingMessageForks = new Set<string>();
/** `draft` makes an Edit: the fork stops before the message, which waits in the composer. */
async function forkAtMessage(sessionId: string, messageId: number, draft?: string): Promise<void> {
  const key = JSON.stringify([sessionId, messageId]);
  if (pendingMessageForks.has(key)) return;
  pendingMessageForks.add(key);
  const generation = state.generation;
  try {
    const fork = await call<Session>('fork_session_at_message', { sessionId, messageId, exclusive: draft !== undefined });
    state.sessions = [fork, ...state.sessions.filter(task => task.id !== fork.id)];
    if (draft) state.drafts.set(fork.id, draft);
    if (generation === state.generation) {
      await selectSession(fork.id, true);
      if (draft !== undefined) document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
      notify(draft !== undefined ? 'Rewound to before your message. Edit it and send.' : 'Conversation forked. Both tasks use the same checkout.');
    } else {
      scheduleNavigation();
      notify('Conversation forked. Your new task is in the task list.');
    }
  } finally { pendingMessageForks.delete(key); }
}
async function editAtMessage(sessionId: string, messageId: number): Promise<void> {
  if (isRunning(sessionId)) throw new Error('Stop the agent before editing a message.');
  const content = await call<string>('get_message_content', { sessionId, messageId });
  // Attached context (files, images) is not re-attached; only what you typed returns.
  await forkAtMessage(sessionId, messageId, contextBlocks(content).typed);
}

/* Each thread's last page. Switching back draws it in the same frame as the click; the
 * saved history then refreshes behind it and redraws only if something changed. Bounded by
 * size too: a thread scrolled far back keeps only its newest messages (older ones reload on
 * scroll), and the least recently opened threads are forgotten first. */
const THREAD_PAGES = 24;
const THREAD_PAGES_CHARS = 4_000_000, THREAD_PAGE_CHARS = 1_000_000;
const threadPages = new Map<string, MessagePage & { chars: number }>();
function rememberThread(id: string): void {
  const messages = state.messages.filter(message => message.id > 0);
  // Only a page that really is this thread's: other paths can switch tasks without a reload.
  if (!id || !messages.length || messages.some(message => message.sessionId !== id)) return;
  let start = messages.length - 1, chars = messages[start].content.length;
  while (start > 0 && chars + messages[start - 1].content.length <= THREAD_PAGE_CHARS) chars += messages[--start].content.length;
  threadPages.delete(id); threadPages.set(id, { messages: start ? messages.slice(start) : messages, hasOlder: state.hasOlder || start > 0, chars });
  let total = 0; for (const page of threadPages.values()) total += page.chars;
  for (const [key, page] of threadPages) {
    if (key === id || (threadPages.size <= THREAD_PAGES && total <= THREAD_PAGES_CHARS)) break;
    threadPages.delete(key); total -= page.chars;
  }
}
const pageSignature = (messages: Message[]): string => messages.filter(message => message.id > 0).map(message => `${message.id}:${message.content.length}`).join(',');

// The menu bar item lists finished tasks until they are viewed.
function markTraySeen(sessionId: string): void { void call('tray_seen', { sessionId }).catch(() => undefined); }
function selectSession(id: string, focusComposer = false): Promise<void> {
  if (id !== state.sessionId) voiceDictation.detach();
  return id === state.sessionId ? openThread(id, focusComposer) : snapDockDuring(() => openThread(id, focusComposer));
}
/** What a thread's load sends from its queue once the team is known (transcript-host.ts dispatchHeld). */
const heldQueue: HeldQueueHost = { queued: id => queueOf(id).length > 0, hasTeam: id => teams.has(id), loadTeam, dispatch: id => dispatchQueue(id), run };
async function openThread(id: string, focusComposer: boolean): Promise<void> {
  if (deletedSessions.has(id)) return;
  const s = state.sessions.find(s => s.id === id); if (!s) return;
  closeMenus();
  if (document.querySelector('#dialog')?.classList.contains('change-review-dialog')) closeModal();
  const previousTask = session(), changingTask = previousTask?.id !== id;
  // A first load left before its details landed never clears its own wait: its page, remembered, must not come back disabled.
  if (changingTask) { if (previousTask) rememberThread(previousTask.id); leaveDraft(id); saveThreadPanel(); transcriptView.forgetFind(); taskDetailsPending = undefined; flushPendingDismiss(); }
  // However it is opened (click, ⌘1…9, ⌘⇧[ / ], board, palette), the thread holds the sidebar
  // section its row is in while it stays open, so the row never jumps from under the pointer.
  if (changingTask) {
    const section = sectionOf(document.querySelector<HTMLElement>(`#navigation .task-item[data-id="${CSS.escape(id)}"]`)?.closest<HTMLElement>('[data-thread-group]')?.dataset.threadGroup);
    sectionHold = section ? { id, section } : undefined;
  }
  if (previousTask && previousTask.id !== id) {
    if (previousTask.taskDescription) previousTask.taskDescription = [...previousTask.taskDescription].slice(0, 512).join('');
    fullTaskDescription = undefined;
  }
  if (state.view !== 'conversation') state.boardPanel = true;
  // A bot's conversation lives in the Bots section; it never re-points the project filter.
  if (state.projectFilter && state.projectFilter !== s.projectId && !botProjects.has(s.projectId) && !chatTask(s)) setProjectFilter(s.projectId);
  state.sessionId = s.id; markTraySeen(s.id); activateProject(s.projectId, false); if (changingTask) restoreThreadPanel(s); state.attachments = [];
  const remembered = changingTask ? threadPages.get(id) : undefined;
  state.messages = withMirrorPrompt(id, remembered ? [...remembered.messages] : []); state.messagesLoading = !remembered; state.messagesError = ''; state.hasOlder = remembered?.hasOlder ?? false;
  const generation = ++state.generation;
  // What acts on the task waits for this load's details and team. A remembered page whose team is already known has
  // been usable since it was left; one left before its team landed waits again, so a send never goes out as a plain
  // message to what turns out to be a team thread.
  taskDetailsPending = remembered && teams.has(id) ? undefined : { id, generation };
  renderInspector();
  if (changingTask) run(restoreSelectedFile());
  const requestedMessages = state.messages;
  const requestedStream = state.streams.get(id), requestedFinishing = finishingStreams.get(id);
  stickToBottom = true; resumeFollow = true; lastTranscriptTop = 0; render();
  if (remembered) stickTranscript();
  // A thread switch settles in once, after its real content draws: here for a remembered page,
  // below once the page arrives (never on the loading placeholder).
  const settle = changingTask && Boolean(previousTask);
  if (settle && remembered) settleIn($('#transcript'));
  if (focusComposer) document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
  // The rows draw the moment the page is in; the task's details and team land after, and a failure of theirs is met below.
  // The task as it was when its details were asked for: a field changed here since (a rename, a model picked, a run
  // starting) is newer than what the details say.
  const askedTask = state.sessions.find(task => task.id === id), asked = askedTask ? { ...askedTask } : undefined;
  const taskLoad = Promise.all([call<Session>('get_task', { sessionId: id }), loadTeam(id)]);
  taskLoad.catch(() => undefined);
  /* A load another one took over (a switch, the same thread opened again) never reaches its own dispatch, while a
   * dispatch made meanwhile waited for it (dispatchQueue): what the queue holds goes once the team is known. If this
   * thread is the open one loading again, dispatchQueue leaves it to that load. */
  const superseded = (): void => dispatchHeld(heldQueue, id, taskLoad);
  const failLoad = (error: unknown, shownMessages: Message[]): boolean => {
    if (generation !== state.generation) { superseded(); return false; }
    taskDetailsPending = undefined;
    // What the queue held back for this load goes now, once the team is known (asked again if its load is what failed).
    dispatchHeld(heldQueue, id);
    // A failed thread load still owns the inspector cleared during the switch.
    run(refreshInspector());
    state.messagesLoading = false;
    if (state.messages !== shownMessages) { renderComposer(); return false; }
    state.messagesError = errorText(error); renderTranscript(); renderComposer();
    return true;
  };
  let page: MessagePage;
  try { page = await latestMessagePage(id); }
  catch (error) { if (failLoad(error, requestedMessages)) throw error; return; }
  if (generation !== state.generation) { superseded(); return; }
  // A send or completed turn can replace the transcript while this earlier
  // history request is in flight. Keep that newer state instead of erasing it.
  const shown = pageSignature(state.messages), pageTaken = state.messages === requestedMessages;
  const steady = pageTaken && state.streams.get(id) === requestedStream && finishingStreams.get(id) === requestedFinishing;
  if (pageTaken) setMessagePage(page);
  state.messagesLoading = false;
  if (!state.streams.has(id) && finishingStreams.get(id) === requestedFinishing) finishingStreams.delete(id);
  // A remembered page that is still current is already on screen; leave it untouched.
  const changed = !remembered || pageSignature(state.messages) !== shown;
  if (changed) renderTranscript();
  if (settle && !remembered && changed) settleIn($('#transcript'));
  if (changed) stickTranscript();
  rememberThread(id);
  const pageMessages = state.messages;
  let details: Session;
  try { [details] = await taskLoad; }
  catch (error) { if (failLoad(error, pageMessages)) throw error; return; }
  if (generation !== state.generation) { superseded(); return; }
  taskDetailsPending = undefined;
  fullTaskDescription = { id, value: details.taskDescription ?? '' };
  // A run that started or ended since the details were asked for owns the run's own fields; the rest still apply.
  applyTaskDetails(id, details, asked, steady && state.streams.get(id) === requestedStream && finishingStreams.get(id) === requestedFinishing);
  renderHeader(); renderComposer();
  // What the queue held back while the team was unknown goes now.
  if (queueOf(id).length) run(dispatchQueue(id));
  // A saved team can select a harness whose catalog has not been opened this run.
  // Resolve its display name in place, without delaying the task or replacing input.
  if (provider(details.provider)?.installed) void loadModels(details.provider).catch(() => { /* Keep the exact model ID if discovery is unavailable. */ });
  if (focusComposer) document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
  if (generation !== state.generation) return;
  await refreshInspectorIfStale(); renderHeader();
}
/** A thread's details and team, landing after its rows: applied by thread (the caller checked the load is still the
 *  current one), whatever redrew the page meanwhile (transcript-host.ts mergeTaskDetails). Redraws only if they change
 *  how the rows read. */
function applyTaskDetails(id: string, details: Session, asked: Session | undefined, steady: boolean): void {
  const loaded = state.sessions.find(task => task.id === id);
  if (loaded && mergeTaskDetails(loaded, details, asked, steady, state.streams.has(id))) renderTranscript(); else syncTeamRows();
}
async function selectProject(id: string): Promise<void> {
  const first = listedSessions().find(s => s.projectId === id && !s.archived);
  if (first) { await selectSession(first.id); return; }
  leaveDraft(''); saveThreadPanel();
  const generation = ++state.generation; activateProject(id, false); state.sessionId = ''; restoreThreadPanel(); renderInspector(); state.messages = []; state.attachments = [];
  render(); if (generation !== state.generation) return; await refreshInspector();
}
/** Every worker change asks for a listing, so at most one runs and one waits. A waiter's listing starts after its call, so `await` still means "at least as new as this call". */
function reloadSessions(): Promise<void> {
  if (!sessionsLoading) {
    sessionsLoading = loadSessions().finally(() => { sessionsLoading = null; });
    return sessionsLoading;
  }
  return sessionsTrailing ??= sessionsLoading.catch(() => undefined).then(() => { sessionsTrailing = null; return reloadSessions(); });
}
async function loadSessions(): Promise<void> {
  const selectedId = state.sessionId, generation = state.generation, request = ++sessionsReload, previousDetails = fullTaskDescription;
  const [sessions, detailResult] = await Promise.all([call<Session[]>('list_sessions'),
    Promise.allSettled([selectedId ? call<Session>('get_task', { sessionId: selectedId }) : Promise.resolve(null)]).then(results => results[0])]);
  if (request !== sessionsReload) return;
  if (detailResult.status === 'rejected' && !deletedSessions.has(selectedId)) throw detailResult.reason;
  const details = detailResult.status === 'fulfilled' ? detailResult.value : null;
  // The open draft is not listed natively until its first prompt; keep it while it is still a draft.
  const listedIds = new Set(sessions.map(task => task.id));
  const drafts = state.sessions.filter(task => task.draft && !listedIds.has(task.id)).map(task => task.id === selectedId && details ? details : task);
  state.sessions = [...sessions, ...drafts].filter(task => !deletedSessions.has(task.id));
  scheduleLimitResumes();
  if (details && state.sessionId === selectedId && state.generation === generation && fullTaskDescription === previousDetails) fullTaskDescription = { id: selectedId, value: details.taskDescription ?? '' };
  const selected = session();
  if (selected && fullTaskDescription?.id === selected.id) selected.taskDescription = fullTaskDescription.value;
  // Native transcripts flush at tool/turn boundaries. Keep responses already
  // visible in an ongoing stream when another task refreshes session metadata.
  for (const s of state.sessions) {
    if (state.streams.has(s.id)) { s.taskStage = 'in_progress'; s.status = 'running'; }
    const promptAt = pendingPromptActivity.get(s.id) ?? state.streams.get(s.id)?.lastPromptAt;
    if (promptAt != null) s.lastPromptAt = Math.max(s.lastPromptAt ?? 0, promptAt);
    const observed = state.streams.get(s.id)?.lastResponseAt;
    if (observed != null) s.lastResponseAt = Math.max(s.lastResponseAt ?? 0, observed);
    const context = state.streams.get(s.id)?.contextUsage;
    if (context) s.contextUsage = context;
  }
  renderNavigation(); renderHeader(); refreshModelLabels(); syncCloudStrip();
}
function removeDeletedSessions(ids: string[]): void {
  voiceDictation.discardThreads(ids);
  committedDrafts.forget(ids);
  terminalPanel.forget(ids);
  const removed = new Set(ids);
  for (const id of removed) {
    deletedSessions.add(id); writeLink(localStorage, id, null);
    const live = state.streams.get(id); if (live) clearAgentInputs(live);
    state.streams.delete(id); finishingStreams.delete(id); teams.delete(id);
    state.drafts.delete(id); state.browserAttachments.delete(id); state.moodboardAttachments.delete(id);
    attachments.clear(id); pendingPromptActivity.delete(id);
    subagents.forget(id);
    threadPanels.delete(id); fileTabs.forget(id);
  }
  state.sessions = state.sessions.filter(task => !removed.has(task.id));
  ++sessionsReload;
  if (fullTaskDescription && removed.has(fullTaskDescription.id)) fullTaskDescription = undefined;
  if (removed.has(state.sessionId)) {
    ++state.generation; ++overlayOpenRequest;
    closeMenus(); subagents.close(false); architectView?.close();
    state.sessionId = ''; state.messages = []; state.messagesLoading = false; state.messagesError = '';
    state.attachments = []; state.hasOlder = false; state.boardPanel = false;
    restoreThreadPanel(); renderInspector();
    render(); run(refreshInspector());
  } else { renderNavigation(); renderHeader(); }
}
async function removeProject(id: string): Promise<void> {
  await call('remove_project', { projectId: id });
  removeDeletedSessions(state.sessions.filter(s => s.projectId === id).map(s => s.id));
  state.projects = await call<Project[]>('list_projects');
  if (state.projectFilter === id) setProjectFilter('');
  if (state.projectId === id) activateProject(userProjects()[0]?.id ?? '');
  renderNavigation(); renderHeader();
}

async function addProject(path: string): Promise<void> {
  const target = openingProjectForTask;
  const added = await call<Project>('add_project', { path });
  state.projects = await call<Project[]>('list_projects');
  if (target) {
    if (target !== openingProjectForTask) { renderNavigation(); return; }
    if (target.id === state.sessionId && target.generation === state.generation && newTaskView()) {
      await changeTaskProject(added.id);
      if (target === openingProjectForTask) { closeModal(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(); }
    } else { if (target === openingProjectForTask) closeModal(); renderNavigation(); }
    notify(`Opened ${added.name}`); return;
  }
  leaveDraft(''); saveThreadPanel();
  const generation = ++state.generation; activateProject(added.id, false); setProjectFilter(added.id); state.sessionId = ''; restoreThreadPanel(); renderInspector(); state.messages = []; state.attachments = []; state.hasOlder = false;
  closeModal(); render(); if (generation !== state.generation) return; await refreshInspector();
  notify(`Opened ${added.name}`);
}
/** A project folder renamed or moved outside PandaCode: pick its new location and repoint the project. */
async function locateProjectFolder(): Promise<void> {
  const p = project();
  if (!p || isChatProject(p)) return;
  const path = await chooseFolder(`Locate the moved "${p.name}" folder`);
  if (!path) return;
  try {
    const updated = await call<Project>('relink_project', { projectId: p.id, path });
    state.projects = await call<Project[]>('list_projects');
    notify(`Relinked ${updated.name}`);
  } catch (error) { report(error); return; }
  renderNavigation(); renderHeader();
  refreshFileLinks(workspaceContext());
  await refreshInspector();
}
const SLASH_INSTRUCTIONS: Record<string, string> = {
  init: 'Inspect this repository and create or update AGENTS.md with concise, accurate project instructions: setup, development commands, tests, architecture, and conventions. Preserve existing useful guidance.',
  recap: 'Summarize this conversation concisely: objective, changes, important decisions, validation, and remaining work.',
};
function slashInstruction(action: string, argumentsText: string): string { return SLASH_INSTRUCTIONS[action] + (argumentsText ? '\n' + argumentsText : ''); }
/** App slash commands that act only on the task they are given, so the By the way panel can run them for its side thread. */
const SIDE_SAFE_SLASH = new Set(['usage', 'hooks', 'preferences', 'imports', 'conversations', 'plugins', 'jobs', 'export', 'fast', 'settings', 'theme']);
/** Runs an app slash command typed in the By the way panel on its side thread. Returns text to send to the side
 *  agent instead (commands that become a prompt), true when handled, false when `text` is not an app command;
 *  commands that would act on the open thread are refused with a notice. */
async function btwSlash(side: Session, text: string, toolbar: HTMLElement | null): Promise<boolean | string> {
  if (!/^\/(?:[\p{L}\p{N}_:.-]+|\?)(?:\s|$)/u.test(text)) return false;
  const resolved = await call<{ action: string | null; arguments: string }>('resolve_slash_command', { sessionId: side.id, text });
  const action = resolved.action, args = resolved.arguments;
  if (!action || action === 'btw') return false;
  if (action === 'init' || action === 'recap') return slashInstruction(action, args);
  if (action === 'model' || action === 'permissions') {
    const trigger = toolbar?.querySelector<HTMLElement>(action === 'model' ? '.model-picker' : '.mode-picker');
    if (trigger) await (action === 'model' ? showModel(trigger, side) : showMode(trigger, side));
    return true;
  }
  if (action === 'rename' && args) { await call('update_session', { sessionId: side.id, title: args }); side.title = args; renderNavigation(); btwPanel.refresh(); return true; }
  if (SIDE_SAFE_SLASH.has(action) || (action === 'plan' && (!args || ['on', 'off'].includes(args)))) { await performSlashAction(action, args, side); return true; }
  notify(`Open the side thread as a full thread to use ${text.split(/\s/)[0]}.`);
  return true;
}
async function performSlashAction(action: string, argumentsText: string, task: Session): Promise<void> {
  if (action.startsWith('console:')) { await openHarnessConsole(task, `/${action.slice(8)}${argumentsText ? ' ' + argumentsText : ''}`); return; }
  switch (action) {
    case 'console': await openHarnessConsole(task, argumentsText || undefined); break;
    case 'goal':
      if (['pause', 'resume', 'clear'].includes(argumentsText)) await updateGoal(task, { action: argumentsText as 'pause' | 'resume' | 'clear' });
      else openGoal(task, argumentsText && argumentsText !== 'edit' ? argumentsText : undefined);
      break;
    case 'usage': case 'hooks': case 'preferences': case 'imports': case 'conversations': case 'plugins': case 'jobs': openCommandPanel(task, action, argumentsText); break;
    case 'fork': {
      const fork = await call<Session>('fork_codex_task', { sessionId: task.id }); state.sessions.unshift(fork); await selectSession(fork.id, true);
      if (argumentsText) await instruction(fork, argumentsText); break;
    }
    case 'archive': await call('archive_codex_task', { sessionId: task.id }); task.archived = true; render(); break;
    case 'delete': await openHarnessConsole(task, '/delete'); break;
    case 'export': await exportTask(task, argumentsText || undefined); break;
    case 'worktree': worktrees.openDialog(newTaskView() ? 'attach' : 'new', argumentsText); break;
    case 'agents': showCommands(); break;
    case 'subagents': { const trigger = document.querySelector<HTMLButtonElement>('#agents-toggle:not([hidden])'); if (trigger) trigger.click(); else modal('Subagents', '<p class="dialog-description">No subagents have been reported for this task yet.</p>'); break; }
    case 'mention':
      if (argumentsText) { await projectFileText(task, argumentsText); if (task.id === state.sessionId) attachFile(argumentsText); }
      else { state.inspector = true; state.inspectorTab = 'files'; renderInspector(); }
      break;
    case 'cd': {
      if (!argumentsText) { showOpenProject(); break; }
      const added = await call<Project>('add_project', { path: argumentsText }); if (!state.projects.some(p => p.id === added.id)) state.projects.push(added); await createTask(added.id); break;
    }
    case 'plan': case 'fast': {
      if (action === 'fast' && argumentsText && !['on', 'off'].includes(argumentsText)) throw new Error('Use /fast, /fast on, or /fast off.');
      const settings = task.codexSettings;
      const current = action === 'plan' ? settings?.collaborationMode?.mode === 'plan' : settings?.serviceTier === 'fast';
      const enabled = argumentsText === 'off' ? false : argumentsText === 'on' || (action === 'plan' && Boolean(argumentsText)) ? true : !current;
      const updated = await call<Session>('set_task_preference', { sessionId: task.id, request: { action, enabled } }); Object.assign(task, updated);
      notify(`${action === 'plan' ? 'Plan mode' : 'Fast service tier'} ${enabled ? 'enabled' : 'disabled'}`);
      if (action === 'plan' && argumentsText && !['on', 'off'].includes(argumentsText)) await instruction(task, argumentsText);
      break;
    }
    case 'init': case 'recap': await instruction(task, slashInstruction(action, argumentsText)); break;
    case 'new': await createTask(); break;
    case 'model': await showModel($('#model-picker-trigger')); break;
    case 'permissions': await showMode($('#mode-picker-trigger')); break;
    case 'settings': await showSettings(); break;
    case 'theme': toggleTheme(); break;
    case 'help': case 'skills': {
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
      if (prompt) { prompt.value = '/'; prompt.focus(); prompt.setSelectionRange(1, 1); prompt.dispatchEvent(new Event('input', { bubbles: true })); }
      break;
    }
    case 'diff': state.inspector = true; state.inspectorTab = 'changes'; state.selectedFile = ''; renderInspector(); await refreshInspector(); break;
    case 'status': modal('Task status', `<p class="dialog-description">${escape(provider(task.provider)?.name ?? task.provider)} · ${escape(modelLabel(task))}</p><p>${escape(approvalMode(task.provider, task.mode).label)} approvals</p><p>${escape(contextSummary(task.contextUsage)?.detail ?? 'This harness has not reported context usage yet.')}</p><p class="muted">${escape(workspacePath())}</p>`); break;
    case 'integrations': {
      if (task.provider !== 'codex') { modal('Integrations', '<p class="dialog-description">Use the harness’s advertised MCP commands. Refresh the slash-command menu to sync the current list.</p>'); break; }
      if (state.sessionId === task.id) await showAgentIntegrations(workspaceContext(task));
      break;
    }
    case 'resume': showCommands(); break;
    case 'rename':
      if (!argumentsText) showRename();
      else { await call('update_session', { sessionId: task.id, title: argumentsText }); task.title = argumentsText; renderNavigation(); renderHeader(); }
      break;
    case 'copy': {
      const answer = [...state.messages].reverse().find(message => message.role === 'assistant' && message.content.trim());
      if (!answer) throw new Error('There is no agent response to copy yet.');
      await navigator.clipboard.writeText(answer.content); notify('Response copied'); break;
    }
    case 'btw': { const refusal = btwRefusal(task); if (refusal) throw new Error(refusal); openBtw(); if (argumentsText) await sendBtw(argumentsText); else btwPanel.focus(); break; }
    case 'pwd': modal('Working directory', `<p class="dialog-description">${escape(workspacePath())}</p>`); break;
    default: throw new Error('This command is not available in PandaCode yet.');
  }
}

const runEndings = new Map<string, 'failed' | 'stopped' | 'limited'>();
/** Entries picked with Send now: delivered before the rest, even past a hold. While the run they
 * stopped is ending, `stopping` keeps the hold from before, so the stop does not pause the others. */
const sendFirst = new Map<string, { id: string; stopping?: boolean; hold?: HoldReason }>();
function queueOf(id: string): QueuedMessage[] { return state.queues.get(id) ?? []; }
function setQueue(id: string, entries: QueuedMessage[]): void { if (entries.length) state.queues.set(id, entries); else state.queues.delete(id); btwPanel.event(id, 'queue'); }
function composerPayload(s: Session): { text: string; items: QueuedMessage['attachments'] } {
  const text = document.querySelector<HTMLTextAreaElement>('#prompt')?.value.trim() ?? '';
  return { text, items: [...attachments.list(s.id), ...state.attachments.map(path => ({ kind: 'path' as const, path }))] as QueuedMessage['attachments'] };
}
async function botMessageFromComposer(s: Session, bot: import('./bots').Bot, text: string, promptItems: ReturnType<typeof attachments.list>, paths: string[], browserItems: BrowserAttachment[], moodboardItems: { id: string; projectId: string; name: string }[], forceQueue = false): Promise<void> {
  const contexts = await Promise.all(paths.map(path => fileContext(s, path)));
  const imageIds = [...browserItems.filter(item => item.kind === 'screenshot').map(item => item.id), ...attachments.imageIds(promptItems)];
  const content = text + contexts.join('') + browserContextText(browserItems) + attachments.contextFor(promptItems) + await github.contextFor(s.projectId, s.id, text) + tokenSaver.contextFor(s.id)
    || (imageIds.length || moodboardItems.length ? 'Please review the attached material.' : '');
  await call('bot_message', { botId: bot.id, text: content, imageIds, moodboardIds: moodboardItems.map(item => item.id), forceQueue });
}
/** Clears a draft whose send already began (`beginSubmit` retired its dictation anchor). */
function clearComposer(s: Session): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  noteCommittedDraft(s, prompt?.dataset.sessionId === s.id ? prompt.value : state.drafts.get(s.id) ?? '');
  if (prompt) prompt.value = '';
  state.drafts.delete(s.id); attachments.clear(s.id); state.attachments = [];
}
/** Queues the composer's message to send when the agent finishes. */
async function enqueueFromComposer(forceQueue = false): Promise<void> {
  if (!voiceDictation.prepareSubmit()) return;
  await enqueueDraft(forceQueue);
}
async function enqueueDraft(forceQueue: boolean): Promise<void> {
  if (btwFromComposer()) return;
  const s = session(); if (!s) return;
  if (remoteOffline(s)) { renderComposer(); return; }
  const { text, items } = composerPayload(s);
  if (isWake(text)) { await wakeFromComposer(s, text); return; }
  const bot = sidebarBots.find(item => item.desktopSession === s.id);
  if (bot) {
    const promptItems = attachments.list(s.id), paths = [...state.attachments];
    const browserItems = [...(state.browserAttachments.get(s.id) ?? [])];
    const moodboardItems = (state.moodboardAttachments.get(s.id) ?? []).filter(item => item.projectId === s.projectId);
    if (!text && !paths.length && !browserItems.length && !moodboardItems.length && !promptItems.length) return;
    const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
    clearComposer(s);
    state.browserAttachments.delete(s.id);
    const sentBoards = new Set(moodboardItems.map(item => item.id));
    state.moodboardAttachments.set(s.id, (state.moodboardAttachments.get(s.id) ?? []).filter(item => !sentBoards.has(item.id)));
    renderComposer(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
    try {
      await botMessageFromComposer(s, bot, text, promptItems, paths, browserItems, moodboardItems, forceQueue);
      // The gateway may have queued it; show the row now rather than on the next queue event.
      setQueue(s.id, await call<QueuedMessage[]>('queue_list', { sessionId: s.id }).catch(() => queueOf(s.id)));
    } catch (error) {
      restoreComposer(s, text, promptItems, paths);
      if (browserItems.length) state.browserAttachments.set(s.id, browserItems);
      if (moodboardItems.length) state.moodboardAttachments.set(s.id, [...moodboardItems, ...(state.moodboardAttachments.get(s.id) ?? [])]);
      throw error;
    } finally { if (s.id === state.sessionId) renderComposer(); finishSubmit(); }
    return;
  }
  if (!text && !items.length) return;
  clearComposerNote(s);
  // Clear at once so the next message can be typed while this one is saved.
  const promptItems = attachments.list(s.id), paths = [...state.attachments];
  const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
  clearComposer(s); renderComposer(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
  try {
    const entry = await call<QueuedMessage>('queue_add', { sessionId: s.id, text, attachments: items });
    setQueue(s.id, [...queueOf(s.id), entry]);
  } catch (error) {
    restoreComposer(s, text, promptItems, paths);
    throw error;
  } finally { if (s.id === state.sessionId) renderComposer(); finishSubmit(); }
}
/** A committed send owns this draft; later typing belongs to the next message. The field keeps its height until the
 * send's own render (after followSend) rebuilds it: shrinking it here, before the follow is armed, grows the transcript
 * early and leaves it unpinned (ui.spec "streaming keeps the transcript at the bottom after sending"). */
function clearComposerDraft(s: Session): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const shown = prompt?.dataset.sessionId === s.id;
  noteCommittedDraft(s, shown ? prompt.value : state.drafts.get(s.id) ?? '');
  if (shown) prompt.value = '';
  state.drafts.delete(s.id);
}
/** Rejected sends come back before newer draft text, in written order (composer-restore.ts). */
const committedDrafts = createCommittedDrafts();
function noteCommittedDraft(s: Session, text: string): void { committedDrafts.note(s.id, text); }
/** Restores a rejected message before newer draft text (after earlier rejected ones) without losing its selection. */
function restoreComposerDraft(s: Session, text: string): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  const shown = prompt?.dataset.sessionId === s.id;
  const current = shown ? prompt.value : state.drafts.get(s.id) ?? '';
  const restored = committedDrafts.restore(s.id, text, current);
  state.drafts.set(s.id, restored.text);
  if (shown) { applyRestoredDraft(prompt, current, restored.text, restored.at); resizePrompt(); }
}
/** Restores an unsent message and its attachments alongside any newer draft. */
function restoreComposer(s: Session, text: string, promptItems: ReturnType<typeof attachments.list>, paths: string[]): void {
  restoreComposerDraft(s, text);
  if (promptItems.length) attachments.restore(s.id, promptItems);
  if (paths.length && s.id === state.sessionId) state.attachments = [...new Set([...paths, ...state.attachments])];
}
type SteerMode = 'live' | 'next-turn';
type SteerStatus = 'pending' | 'delivered' | 'failed';
interface Steer { sessionId: string; text: string; mode: SteerMode; status: SteerStatus; messageId?: number }
/** Steers by native id. Events can arrive before `steer_task` resolves, so either side may create the entry. */
const steers = new Map<string, Steer>();
/** Queue entries whose steer is in flight. */
const steeringQueued = new Set<string>();
/** Sends text into the running turn and shows it at once as a pending user message. */
async function steer(s: Session, text: string): Promise<void> {
  const message = sentPrompt(s, text, Date.now());
  if (s.id === state.sessionId) { state.messages = [...state.messages, message]; renderTranscript(true); }
  btwPanel.sent(s.id, message);
  try {
    const result = await call<{ id?: string; mode?: SteerMode } | null>('steer_task', { sessionId: s.id, text });
    const known = result?.id ? steers.get(result.id) : undefined;
    if (result?.id) steers.set(result.id, { sessionId: s.id, text, mode: known?.mode ?? result.mode ?? 'live', status: known?.status ?? 'pending', messageId: message.id });
  } catch (error) {
    dropMirrorPrompt(s.id, message);
    if (s.id === state.sessionId) { state.messages = state.messages.filter(item => item !== message); renderTranscript(true); }
    btwPanel.unsent(s.id, message);
    throw error;
  }
}
function steerEvent(event: AgentEvent): void {
  const data = event.data as { id?: string; status?: SteerStatus; mode?: SteerMode } | undefined;
  if (!data?.id || !data.status) return;
  const known = steers.get(data.id);
  if (known?.status === 'failed') return;
  // A steer this window did not send (a bot routes Enter natively) still shows as the user's message.
  // The event can beat `steer_task`'s reply: then the bubble sendSteer already drew is this steer.
  const linked = new Set([...steers.values()].map(item => item.messageId));
  const drawn = !known && event.sessionId === state.sessionId ? state.messages.find(m => m.id < 0 && m.role === 'user' && m.content === event.text && !linked.has(m.id)) : undefined;
  const shown = drawn ? drawn.id : !known && data.status !== 'failed' && event.text && event.sessionId === state.sessionId ? transientId-- : undefined;
  if (shown !== undefined && !drawn) state.messages = [...state.messages, { id: shown, sessionId: event.sessionId, role: 'user', content: event.text, createdAt: Date.now() }];
  steers.set(data.id, { sessionId: event.sessionId, text: event.text, ...known, ...(shown !== undefined ? { messageId: shown } : {}), mode: data.mode ?? known?.mode ?? 'live', status: data.status });
  if (data.status === 'failed') void requeueSteer(event.sessionId, event.text || known?.text || '', (event.data as { reason?: string } | undefined)?.reason || 'The agent could not take it during this turn.');
  if (event.sessionId === state.sessionId && (known?.messageId !== undefined || shown !== undefined)) renderTranscript(true);
  btwPanel.event(event.sessionId, 'steer');
}
/** Queued entries whose steer did not land, with the reason (the queue shows "Not steered"). */
const notSteered = new Map<string, string>();
/** A steer the agent could not take goes back to the queue, so nothing typed is lost. */
async function requeueSteer(sessionId: string, text: string, reason: string): Promise<void> {
  if (!text) return;
  const entry = await call<QueuedMessage>('queue_add', { sessionId, text, attachments: [] }).catch(() => null);
  const s = state.sessions.find(item => item.id === sessionId);
  if (entry) notSteered.set(entry.id, reason);
  if (entry) { setQueue(sessionId, [...queueOf(sessionId), entry]); notifyError('The agent could not take that message, so it was queued.'); }
  else { if (s) restoreComposer(s, text, [], []); notifyError('The agent could not take that message; it is back in the prompt.'); }
  if (sessionId === state.sessionId) renderComposer();
}
function steerStateHtml(m: Message): string {
  const steer = [...steers.values()].find(item => item.messageId === m.id && item.status !== 'delivered');
  if (!steer) return '';
  if (steer.status === 'failed') return `<div class="steer-state failed">${icon('alert')}<span>Not taken by the agent · moved to the queue</span></div>`;
  return `<div class="steer-state" role="status"><span class="support-spinner" aria-hidden="true"></span><span>${steer.mode === 'next-turn' ? 'Sends when this turn ends' : 'Steering…'}</span></div>`;
}
/** Sends the composer's text into the running turn; anything that cannot steer is queued instead. */
async function steerFromComposer(): Promise<void> {
  if (!voiceDictation.prepareSubmit()) return;
  await steerDraft();
}
async function steerDraft(): Promise<void> {
  if (btwFromComposer()) return;
  const s = session(); if (!s) return;
  if (remoteOffline(s)) { renderComposer(); return; }
  const { text, items } = composerPayload(s);
  const bot = sidebarBots.find(item => item.desktopSession === s.id);
  if (bot?.whileWorking === 'steer') return enqueueFromComposer(true);
  if (bot && (items.length || (state.browserAttachments.get(s.id) ?? []).length || (state.moodboardAttachments.get(s.id) ?? []).length)) {
    notify('Attachments travel with queued messages, so this one was queued.');
    return enqueueFromComposer();
  }
  if (!text) { document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(); return; }
  if (items.length || teams.get(s.id)) {
    notify(items.length ? 'Attachments travel with queued messages, so this one was queued.' : 'A team takes messages between runs, so this one was queued.');
    return enqueueFromComposer();
  }
  const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
  clearComposerNote(s); clearComposer(s); renderComposer();
  try { await steerOrQueue(s, text); } finally { finishSubmit(); }
}
/** Steers `text` into the running turn of `s`; whatever cannot steer is queued, or put back in its composer. */
async function steerOrQueue(s: Session, text: string): Promise<void> {
  // A mirror whose start has not attached has no run to steer yet: the message waits in the queue.
  const starting = remoteStart(s.id);
  if (starting && starting.stage !== 'error') {
    const entry = await call<QueuedMessage>('queue_add', { sessionId: s.id, text, attachments: [] }).catch(() => null);
    if (entry) { setQueue(s.id, [...queueOf(s.id), entry]); notify(`${starting.device} is still starting this task; your message is queued for after it.`); }
    else restoreComposer(s, text, [], []);
    refreshComposer(s);
    return;
  }
  try {
    await steer(s, text);
  } catch (error) {
    // A host that has not approved this device would refuse it queued too: say so, keep the text.
    if (remoteRefusal(s, error)) { restoreComposer(s, text, [], []); refreshComposer(s); return; }
    // Not taken mid-turn: keep it for after the run instead of losing it.
    const reason = errorText(error);
    notifyError(/\bqueued\b/i.test(reason) ? reason : `${reason} Queued instead.`);
    const entry = await call<QueuedMessage>('queue_add', { sessionId: s.id, text, attachments: [] }).catch(() => null);
    if (entry) notSteered.set(entry.id, reason);
    if (entry) setQueue(s.id, [...queueOf(s.id), entry]); else restoreComposer(s, text, [], []);
    refreshComposer(s);
  }
}
/** Steers a queued entry; it leaves the queue only once the running turn has taken it. */
async function steerQueued(s: Session, id: string): Promise<void> {
  const entry = queueOf(s.id).find(item => item.id === id); if (!entry || steeringQueued.has(id)) return;
  if (entry.attachments.length) { notify('Queued messages with attachments are sent after the run.'); return; }
  const starting = remoteStart(s.id);
  if (starting && starting.stage !== 'error') { notify(`${starting.device} is still starting this task; the message stays queued.`); return; }
  steeringQueued.add(id); refreshComposer(s);
  try {
    await steer(s, entry.text);
    await call('queue_take_steered', { id }); setQueue(s.id, queueOf(s.id).filter(item => item.id !== id));
  } finally { steeringQueued.delete(id); refreshComposer(s); }
}
async function saveQueueEdit(s = session()): Promise<void> {
  const entry = s && queueOf(s.id).find(item => item.id === state.queueEditing); if (!s || !entry) return;
  const text = document.querySelector<HTMLTextAreaElement>('.queue-edit')?.value.trim() ?? '';
  const updated = await call<QueuedMessage>('queue_update', { id: entry.id, text, attachments: entry.attachments });
  setQueue(s.id, queueOf(s.id).map(item => item.id === entry.id ? updated : item)); state.queueEditing = ''; refreshComposer(s);
}
/** Redraws the composer that shows `s`: the main one, or the By the way panel's. */
function refreshComposer(s: Session): void { if (s.id === state.sessionId) renderComposer(); else btwPanel.refresh(); }
onQueueReorder(async (row, ids) => {
  const s = actionTask(row); if (!s) return false;
  try { setQueue(s.id, await call<QueuedMessage[]>('queue_reorder', { sessionId: s.id, ids })); refreshComposer(s); return true; }
  catch (error) { report(error); return false; }
});
async function queueAction(action: string, element: HTMLElement): Promise<void> {
  const s = actionTask(element); if (!s) return;
  const id = element.closest<HTMLElement>('[data-queue-id]')?.dataset.queueId ?? '';
  if (action === 'queue-steer') return steerQueued(s, id).catch(error => { if (remoteRefusal(s, error)) return; if (!isRunning(s.id)) run(dispatchQueue(s.id)); throw error; });
  if (action === 'queue-send-now') return sendQueuedNow(s, id);
  if (action === 'queue-edit') { state.queueEditing = id; refreshComposer(s); document.querySelector<HTMLTextAreaElement>('.queue-edit')?.focus(); return; }
  if (action === 'queue-cancel') { state.queueEditing = ''; refreshComposer(s); return; }
  if (action === 'queue-save') return saveQueueEdit(s);
  if (action === 'queue-remove') { await call('queue_remove', { id }); setQueue(s.id, queueOf(s.id).filter(item => item.id !== id)); refreshComposer(s); return; }
  if (action === 'queue-resume') { state.queueHolds.delete(s.id); refreshComposer(s); await dispatchQueue(s.id); }
}
/** Sends this entry now: right away when idle, into the running turn when it can steer, otherwise after stopping the run. */
async function sendQueuedNow(s: Session, id: string): Promise<void> {
  const entry = queueOf(s.id).find(item => item.id === id); if (!entry) return;
  if (!isRunning(s.id)) { sendFirst.set(s.id, { id }); return dispatchQueue(s.id); }
  if (!teams.get(s.id) && !entry.attachments.length) {
    try { return await steerQueued(s, id); } catch {
      // The run ended meanwhile: send it as the next turn instead.
      if (!isRunning(s.id)) return sendQueuedNow(s, id);
    }
  }
  sendFirst.set(s.id, { id, stopping: true, hold: state.queueHolds.get(s.id) });
  runEndings.set(s.id, 'stopped');
  const team = teams.get(s.id) && !s.remoteDevice;
  await call(team ? 'architect_control' : 'stop_session', { sessionId: s.id, ...(team ? { action: 'stop' } : {}) });
  notify('Stopping the run to send this message…');
}
/** Runs the optional turn-end project check (Settings → Agents) for a clean finish, queueing one repair on failure. */
async function maybeTurnChecks(id: string): Promise<void> {
  await ensureBotProjects();
  const current = () => state.sessions.find(item => item.id === id);
  const task = current();
  await turnChecksAfterRun(id, {
    call,
    task,
    isTeam: teams.has(id),
    isBot: botProjects.has(task?.projectId ?? ''),
    isRunning: () => isRunning(id),
    queued: () => queueOf(id).length,
    mode: () => current()?.codexSettings?.collaborationMode?.mode === 'plan' ? 'plan' : current()?.mode,
    onQueued: queued => { void run(dispatchQueue(queued)); },
    onError: error => console.warn('Project checks failed to run', error),
  });
}
/** Sends a task's next queued message once it is idle and its queue is not held (Send now skips the hold). */
async function dispatchQueue(id: string): Promise<void> {
  if (!queueOf(id).length) return;
  await ensureBotProjects();
  const task = state.sessions.find(item => item.id === id);
  const first = sendFirst.get(id), next = queueOf(id).find(item => item.id === first?.id) ?? queueOf(id)[0];
  if (first && next?.id !== first.id) sendFirst.delete(id);
  // The open thread's team may not be known yet: like sendDraft, wait for its load (openThread dispatches again then),
  // so a team thread's message never goes out as a plain one.
  if (id === state.sessionId && threadLoading()) return;
  if (!task || !next || botProjects.has(task.projectId) || (state.queueHolds.has(id) && next.id !== first?.id) || state.queueBusy.has(id) || steeringQueued.has(next.id) || next.id === state.queueEditing || isRunning(id) || finishingStreams.has(id) || configuringSessions.has(id) || task.archived) return;
  if (limitActive(task)) { state.queueHolds.set(id, 'limited'); if (id === state.sessionId) renderComposer(); return; }
  state.queueBusy.add(id);
  try {
    if (next.id === first?.id) sendFirst.delete(id);
    const entry = await call<QueuedMessage>('queue_take', { id: next.id });
    setQueue(id, queueOf(id).filter(item => item.id !== entry.id));
    await deliverQueued(task, entry);
  } catch (error) {
    state.queueHolds.set(id, 'failed'); if (!remoteRefusal(task, error)) notifyError(errorText(error));
  } finally { state.queueBusy.delete(id); if (id === state.sessionId) renderComposer(); renderNavigation(); }
}
/** Starts a turn with a queued message, for the open task or one in the background. */
async function deliverQueued(task: Session, entry: QueuedMessage): Promise<void> {
  const promptItems = entry.attachments.filter(item => item.kind !== 'path') as unknown as ReturnType<typeof attachments.list>;
  const paths = entry.attachments.flatMap(item => item.kind === 'path' ? [item.path] : []);
  let sent: Message | undefined;
  try {
    const files = await Promise.all(paths.map(async path => { const content = await projectFileText(task, path); return `\n\nFile context: ${path}\n\`\`\`\n${content.slice(0, 32768)}\n\`\`\``; }));
    // A side thread's queued follow-up carries the main thread's news like any /btw message.
    const btw = btwMainOf(task.id), context = btw ? await btwContext(btw.main, btw.link) : undefined;
    const content = entry.text + files.join('') + attachments.contextFor(promptItems) + (context?.text ?? '');
    const sentAt = Date.now();
    task.lastPromptAt = sentAt; task.draft = false; pendingPromptActivity.set(task.id, sentAt);
    stream(task.id).lastPromptAt = sentAt; stream(task.id).startedAt = Math.min(stream(task.id).startedAt, sentAt); stream(task.id).status = 'Starting agent'; task.status = 'running'; task.taskStage = 'in_progress'; task.completedAt = null;
    sent = sentPrompt(task, content, sentAt);
    if (task.id === state.sessionId) { state.messages = [...state.messages, sent]; render(); } else renderNavigation();
    btwPanel.sent(task.id, sent);
    await call(teams.get(task.id) && !task.remoteDevice ? 'architect_start' : 'send_message', { sessionId: task.id, text: content, imageIds: attachments.imageIds(promptItems), moodboardIds: [] });
    // Recorded once sent, unless a New side thread replaced the link meanwhile.
    if (btw && context && readLinks(localStorage)[btw.main.id]?.sideId === task.id) writeLink(localStorage, btw.main.id, { ...readLinks(localStorage)[btw.main.id], seenId: context.link.seenId });
  } catch (error) {
    // Put it back at the front and hold, so nothing is lost or sent out of order.
    pendingPromptActivity.delete(task.id); state.streams.delete(task.id); task.status = 'idle'; if (sent) dropMirrorPrompt(task.id, sent);
    // A synthetic entry (no id, e.g. continuing after a limit) was never queued.
    if (entry.id) {
      const restored = await call<QueuedMessage>('queue_restore', { entry }).catch(() => null);
      if (restored) setQueue(task.id, [restored, ...queueOf(task.id).filter(item => item.id !== restored.id)]);
      else notifyError('A queued message could not be put back; it was not sent.');
    }
    state.queueHolds.set(task.id, 'failed');
    throw error;
  }
}
let limitTimer = 0;
/** Continues limited tasks set to resume at reset; overdue ones (after a restart) continue at once. */
function scheduleLimitResumes(): void {
  window.clearTimeout(limitTimer);
  const waiting = state.sessions.filter(task => task.resumeAtReset && task.limitedUntil && !task.archived);
  if (!waiting.length) return;
  const next = Math.min(...waiting.map(task => task.limitedUntil!));
  limitTimer = window.setTimeout(() => {
    for (const task of state.sessions.filter(item => item.resumeAtReset && item.limitedUntil && item.limitedUntil <= Date.now() + 1000 && !item.archived)) run(continueAfterLimit(task));
    scheduleLimitResumes();
  }, Math.min(Math.max(0, next - Date.now()), 2147483647));
}
/** Recovery runs before queued follow-ups: continue the task, then the queue delivers when that run ends. */
async function continueAfterLimit(task: Session, text = 'Continue where you left off.'): Promise<void> {
  if (teamHeld(task.id)) return clearLimit(task);
  // The run's saved page is still landing: a click on the banner waits for it rather than being lost.
  const finishing = finishingStreams.get(task.id);
  if (finishing && !finishing.error) { window.setTimeout(() => void continueAfterLimit(task, text), 50); return; }
  if (task.archived || isRunning(task.id) || state.queueBusy.has(task.id) || finishing) return;
  const hold = state.queueHolds.get(task.id);
  if (hold === 'limited' || hold === 'restart') state.queueHolds.delete(task.id);
  task.resumeAtReset = false;
  state.queueBusy.add(task.id);
  try {
    const at = Date.now();
    await deliverQueued(task, { id: '', sessionId: task.id, position: 0, text, attachments: [], createdAt: at, updatedAt: at });
    task.limitedAt = null; task.limitedUntil = null;
  } catch (error) { notifyError(errorText(error)); }
  finally { state.queueBusy.delete(task.id); if (task.id === state.sessionId) renderComposer(); renderNavigation(); }
}
/** The harness's other named connections a limited task can continue on (issue #137). */
function limitAlternatives(s: Session): { id: string; name: string }[] {
  if (s.remoteDevice) return [];
  const current = namedConnections.tasks[s.id];
  return namedConnections.connections.filter(c => c.provider === s.provider && c.id !== current);
}
/** Moves the task to another connection and resends with its context: a harness session can't resume
 *  across config folders, so connection_assign starts a fresh one that context recovery fills in. */
async function continueOnConnection(task: Session, id: string): Promise<void> {
  const target = limitAlternatives(task).find(c => c.id === id);
  if (!target || (isRunning(task.id) && !teamHeld(task.id)) || state.queueBusy.has(task.id)) return;
  const from = taskConnection(task)?.name ?? `the default ${provider(task.provider)?.name ?? task.provider} setup`;
  onNamedConnections(await call('connection_assign', { sessionId: task.id, connectionId: id }));
  task.resumeId = null;
  await continueAfterLimit(task, `Continue where you left off. (Moved to the connection “${target.name}” because ${from} reached its usage limit.)`);
}
/** Drops a task's limit; a team held by it retries on the scheduler's next tick. */
async function clearLimit(task: Session): Promise<void> {
  await call('clear_usage_limit', { sessionId: task.id });
  task.limitedAt = null; task.limitedUntil = null; task.resumeAtReset = false;
  const team = teams.get(task.id);
  if (team?.leadFailure) onArchitect({ ...team, leadFailure: { ...team.leadFailure, heldUntil: null } });
  scheduleLimitResumes(); renderComposer(); renderNavigation();
}
async function limitAction(action: string, element: HTMLElement): Promise<void> {
  const s = session(); if (!s) return;
  if (action === 'limit-continue') return continueAfterLimit(s);
  if (action === 'limit-switch') return continueOnConnection(s, element.dataset.connection ?? '');
  if (action === 'limit-dismiss') return clearLimit(s);
  if (action === 'limit-resume-at-reset') {
    const enabled = (element as HTMLInputElement).checked;
    try { Object.assign(s, await call<Session>('set_resume_at_reset', { sessionId: s.id, enabled })); }
    finally { scheduleLimitResumes(); renderComposer(); }
  }
}
/** A project file's text as it is here. A task on another computer has no checkout here, so its
 * files are read from this computer's copy of the project, which the host cloned the same repo of. */
async function projectFileText(s: Session, path: string): Promise<string> {
  if (!s.remoteDevice) return call<string>('read_file', { ...workspaceContext(s), path });
  try { return await call<string>('read_file', { projectId: s.projectId, path }); }
  catch { throw new Error(`${path} can’t be read on this computer, so it can’t go to ${s.remoteDevice.name}. Remove it, or paste the part you need.`); }
}
async function fileContext(s: Session, path: string): Promise<string> {
  const content = await projectFileText(s, path);
  return `\n\nFile context: ${path}\n\`\`\`\n${content.slice(0, 32768)}${content.length > 32768 ? '\n[Context truncated at 32 KiB]' : ''}\n\`\`\``;
}
/** `/wake` is handled here for every harness, so it works whether or not the CLI knows it. */
const WAKE_SLASH: SlashCommand = { id: 'pandacode:wake', name: '/wake', description: 'Wake this thread later', argumentHint: '[30m | 9:00 | tomorrow] [message]', kind: 'action', source: 'PandaCode' };
function withWake(catalog: { commands: SlashCommand[]; warnings: string[] }): { commands: SlashCommand[]; warnings: string[] } {
  return catalog.commands.some(command => command.name === '/wake') ? catalog : { ...catalog, commands: [WAKE_SLASH, ...catalog.commands] };
}
/** Checked without awaiting, so an ordinary send prepares in the same task as the click. */
const WAKE_TEXT = /^\/wake(?:\s+([\s\S]*))?$/i;
const isWake = (text: string) => WAKE_TEXT.test(text.trim());
/** Runs a typed `/wake …` and clears the prompt; false when the text is something else. */
async function wakeFromComposer(s: Session, text: string): Promise<boolean> {
  const match = WAKE_TEXT.exec(text.trim()); if (!match) return false;
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  await wakeCommand(s.id, match[1] ?? '', document.querySelector<HTMLElement>('#composer') ?? $('#composer-area'));
  if (prompt?.isConnected && prompt.value.trim() === text.trim()) { prompt.value = ''; resizePrompt(); }
  state.drafts.delete(s.id);
  return true;
}
const mirrorLocalSlash = new Set(['console', 'goal', 'usage', 'hooks', 'preferences', 'imports', 'conversations', 'plugins', 'jobs', 'fork', 'archive', 'delete', 'export', 'worktree', 'cd', 'plan', 'fast', 'diff', 'integrations', 'pwd']);
function remoteSlashUnavailable(action: string): boolean { return action.startsWith('console:') || mirrorLocalSlash.has(action); }
/** One line above the prompt for the task, kept across composer redraws until the next send. */
const composerNotes = new Map<string, string>();
function showComposerNote(s: Session, text: string): void {
  composerNotes.set(s.id, text);
  if (s.id !== state.sessionId) return;
  syncComposerNote(s); announce(text);
}
function clearComposerNote(s: Session): void { if (composerNotes.delete(s.id) && s.id === state.sessionId) syncComposerNote(s); }
function syncComposerNote(s: Session): void {
  const composer = document.querySelector('#composer'), old = document.querySelector<HTMLElement>('#composer-area .composer-inline-note:not(.remote-missing-note)');
  const text = composerNotes.get(s.id), markup = text ? `<div class="composer-inline-note">${escape(text)}</div>` : '';
  if (old) { if (old.outerHTML !== markup) { if (markup) old.outerHTML = markup; else old.remove(); } }
  else if (markup && composer) composer.insertAdjacentHTML('beforebegin', markup);
}
/** The composer's one live region: notes and connection status are drawn silently and read from here. */
function announce(text: string): void {
  const region = document.querySelector<HTMLElement>('#composer-live'); if (!region) return;
  if (region.textContent === text) region.textContent = '';
  queueMicrotask(() => { region.textContent = text; });
}
/** A host's refusal under scoped pairing (remote/grants.rs), which names the host. */
const scopeRefusal = (error: unknown): string | null => {
  const text = errorText(error);
  return /Waiting for approval on |has blocked this device|can only view tasks on |is not allowed to do that on /.test(text) ? text : null;
};
/** Shows a mirror task's scope refusal inline instead of as a toast; false for any other error. */
function remoteRefusal(s: Session, error: unknown): boolean {
  const text = s.remoteDevice ? scopeRefusal(error) : null;
  if (text) showComposerNote(s, text);
  return Boolean(text);
}
/** The asking card's Keep fixing: a follow-up to the lead with its own text and no attachments, sent the way a queued
 *  message is (`deliverQueued`), so the prompt's draft and attachments are never touched. */
async function councilKeepFixing(sessionId: string): Promise<void> {
  const task = state.sessions.find(item => item.id === sessionId);
  if (!task) throw new Error('This task is gone.');
  if (isRunning(task.id)) throw new Error('The team is already working.');
  // Its failure is the card's to show: the user's real queue keeps whatever hold it had.
  const hold = state.queueHolds.get(task.id), at = Date.now();
  try { await deliverQueued(task, { id: '', sessionId: task.id, position: 0, text: 'Keep fixing until every reviewer reaches the target.', attachments: [], createdAt: at, updatedAt: at }); }
  catch (error) { if (hold === undefined) state.queueHolds.delete(task.id); else state.queueHolds.set(task.id, hold); throw error; }
}
/** Threads whose first send waits on Council turning on: a second Enter meanwhile sends nothing. */
const councilFirstSends = new Set<string>();
async function send(): Promise<void> {
  if (!voiceDictation.prepareSubmit()) return;
  await sendDraft();
}
async function sendDraft(): Promise<void> {
  if (btwFromComposer()) return;
  const draft = document.querySelector<HTMLTextAreaElement>('#prompt')?.value ?? ''; const text = draft.trim(); const s = session();
  if (!s) return;
  if (isWake(text)) { await wakeFromComposer(s, text); return; }
  const bot = sidebarBots.find(item => item.desktopSession === s.id);
  const hasBotAttachments = Boolean(bot && (state.attachments.length || state.browserAttachments.get(s.id)?.length || attachments.list(s.id).length || state.moodboardAttachments.get(s.id)?.some(item => item.projectId === s.projectId)));
  if (councilFirstSends.has(s.id)) return;
  if ((!text && !hasBotAttachments) || s.archived || taskStage(s) === 'completed' || isRunning() || finishingStreams.has(s.id) || threadLoading() || state.messagesError || configuringSessions.has(s.id)) return;
  clearComposerNote(s);
  if (remoteOffline(s)) { renderComposer(); return; }
  const fresh = !s.remoteDevice && newTaskView();
  const target = fresh ? remoteTargets.find(item => item.deviceId === remoteChoice) : undefined;
  if (target) return sendRemote(s, target, draft, text);
  if (fresh && remoteChoice !== LOCAL && !cloudProvider(remoteChoice)) { renderComposer(); return; }
  // A failed start elsewhere no longer applies once this task is sent another way.
  clearRemoteStart(s.id);
  const cloud = !s.remoteDevice && !s.cloud && newTaskView() ? cloudTargets.find(item => item.ready && item.provider === cloudProvider(remoteChoice)) : undefined;
  if (cloud) return sendCloud(s, cloud, draft, text);
  // "Turn on for new threads": a local first send starts the team and Council before it goes. The guard holds a second
  // Enter meanwhile; a failure is shown, and the message still goes.
  if (!s.remoteDevice && !state.messages.length && !bot) {
    councilFirstSends.add(s.id);
    try { const failed = await council.enableForNewThread(s.id); if (failed) notifyError(`Council did not turn on: ${failed}`); }
    finally { councilFirstSends.delete(s.id); }
    if (state.sessionId !== s.id) return;
  }
  // Preparing attachments or awaiting admission blocks only this task.
  configuringSessions.add(s.id);
  noteManualSend(s.id);
  const filePaths = [...state.attachments], browserItems = state.browserAttachments.get(s.id) ?? [];
  const moodboardItems = (state.moodboardAttachments.get(s.id) ?? []).filter(item => item.projectId === s.projectId);
  const promptItems = attachments.list(s.id);
  const screenshots = browserItems.filter(a => a.kind === 'screenshot').map(a => a.id);
  const commandGeneration = state.generation;
  try {
    if (screenshots.length + attachments.imageIds(promptItems).length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per message, including browser screenshots.`);
    if (/^\/(?:[\p{L}\p{N}_:.-]+|\?)(?:\s|$)/u.test(text)) {
      const resolved = await call<{ action: string | null; arguments: string; acceptsAttachments?: boolean }>('resolve_slash_command', { sessionId: s.id, text });
      if (state.sessionId !== s.id || state.generation !== commandGeneration || document.querySelector<HTMLTextAreaElement>('#prompt')?.value !== draft) throw new Error('Your task or message changed while commands were loading. Send it again.');
      if (!resolved.action && resolved.acceptsAttachments === false && (filePaths.length || browserItems.length || moodboardItems.length || promptItems.length)) throw new Error('This command does not accept attachments. Remove them before running it.');
      if (resolved.action) {
        configuringSessions.delete(s.id);
        if (s.remoteDevice && remoteSlashUnavailable(resolved.action)) {
          showComposerNote(s, `${text} needs a checkout on this computer. Run it in a local task, or ask the remote agent in plain text.`);
          return;
        }
        if (state.sessionId !== s.id) throw new Error('Return to the task to run this command.');
        const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
        if (prompt?.value !== draft) throw new Error('Your message changed while commands were loading. Send it again.');
        const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
        prompt.value = ''; state.drafts.delete(s.id); resizePrompt();
        try { await performSlashAction(resolved.action, resolved.arguments, s); }
        catch (error) {
          restoreComposerDraft(s, draft);
          throw error;
        } finally { finishSubmit(); }
        return;
      }
    }
  } catch (error) { configuringSessions.delete(s.id); throw error; }
  const finishSubmit = voiceDictation.beginSubmit(s.id);
  if (!finishSubmit) { configuringSessions.delete(s.id); return; }
  clearComposerDraft(s);
  const sentAt = Date.now();
  const listed = state.sessions.find(task => task.id === s.id) ?? s;
  // The first prompt publishes a New task draft; native storage confirms it when the prompt is saved.
  const wasDraft = Boolean(listed.draft);
  listed.lastPromptAt = sentAt; listed.draft = false;
  // Sending by hand is an explicit continue: release a held queue, which then follows this run.
  state.queueHolds.delete(s.id);
  pendingPromptActivity.set(s.id, sentAt); navigationAfterPaint();
  let browserItemsConsumed = false, moodboardItemsConsumed = false, promptItemsConsumed = false, sent: Message | undefined;
  const isCurrent = () => state.sessionId === s.id;
  try {
    const contexts = await Promise.all(filePaths.map(path => fileContext(s, path)));
    // Mentioned issues and pull requests travel with the message, so every harness can read them.
    const rawContent = text + contexts.join('') + browserContextText(browserItems) + attachments.contextFor(promptItems) + await github.contextFor(s.projectId, s.id, text) + await botTaskBrief(s) + tokenSaver.contextFor(s.id);
    const content = rawContent || (bot ? 'Please review the attached material.' : rawContent);
    const sentIds = new Set(browserItems.map(item => item.id));
    const remaining = (state.browserAttachments.get(s.id) ?? []).filter(item => !sentIds.has(item.id));
    if (remaining.length) state.browserAttachments.set(s.id, remaining); else state.browserAttachments.delete(s.id);
    browserItemsConsumed = true;
    attachments.consume(s.id, promptItems); promptItemsConsumed = true;
    const boardIds = new Set(moodboardItems.map(item => item.id));
    state.moodboardAttachments.set(s.id, (state.moodboardAttachments.get(s.id) ?? []).filter(item => !boardIds.has(item.id)));
    moodboardItemsConsumed = true;
    stream(s.id).lastPromptAt = sentAt; stream(s.id).startedAt = Math.min(stream(s.id).startedAt, sentAt); stream(s.id).status = 'Starting agent'; s.status = 'running'; s.taskStage = 'in_progress'; s.completedAt = null;
    sent = sentPrompt(s, content, Date.now());
    if (isCurrent()) {
      stickToBottom = true; followSend();
      state.messages = [...state.messages, sent];
      // The sidebar redraws after the first frame (navigationAfterPaint), so the send paints the thread first.
      state.attachments = state.attachments.filter(path => !filePaths.includes(path)); renderHeader(); renderTranscript(); renderComposer();
      const shown = $('#transcript').querySelectorAll<HTMLElement>('.user-message');
      if (shown.length) enterView(shown[shown.length - 1], 12);
    } else renderNavigation();
    const imageIds = [...screenshots, ...attachments.imageIds(promptItems)];
    // A bot's own conversation goes through the bot, which adds its brief and memories.
    if (bot) await call('bot_message', { botId: bot.id, text: content, imageIds, moodboardIds: moodboardItems.map(item => item.id) });
    else await call(teams.get(s.id) && !s.remoteDevice && !moodboardItems.length ? 'architect_start' : 'send_message', { sessionId: s.id, text: content, imageIds, moodboardIds: moodboardItems.map(item => item.id) });
  } catch (error) {
    pendingPromptActivity.delete(s.id); if (sent) dropMirrorPrompt(s.id, sent);
    state.streams.delete(s.id); s.status = 'idle';
    // A rejected first prompt may not have been saved; follow native storage on whether the task is listed.
    if (wasDraft) void call<Session>('get_task', { sessionId: s.id }).then(saved => { listed.draft = saved.draft; renderNavigation(); }).catch(() => undefined);
    restoreComposerDraft(s, draft);
    if (promptItemsConsumed) attachments.restore(s.id, promptItems);
    if (moodboardItemsConsumed && moodboardItems.length) {
      const sent = new Set(moodboardItems.map(item => item.id));
      state.moodboardAttachments.set(s.id, [...moodboardItems, ...(state.moodboardAttachments.get(s.id) ?? []).filter(item => !sent.has(item.id))]);
    }
    if (browserItemsConsumed && browserItems.length) {
      const sentIds = new Set(browserItems.map(item => item.id));
      state.browserAttachments.set(s.id, [...browserItems, ...(state.browserAttachments.get(s.id) ?? []).filter(item => !sentIds.has(item.id))]);
    }
    await reloadSessions();
    if (isCurrent()) {
      const generation = state.generation;
      state.attachments = [...new Set([...filePaths, ...state.attachments])];
      const saved = await latestMessagePage(s.id);
      if (isCurrent() && generation === state.generation) { setMessagePage(saved); state.messagesLoading = false; render(); }
    }
    if (remoteRefusal(s, error)) return;
    throw error;
  } finally { pendingPromptActivity.delete(s.id); configuringSessions.delete(s.id); finishSubmit(); }
}
// /btw side threads (docs/btw.md): a second task beside this one, fed what the main thread said.
const btwPanel = new BtwPanel({
  call, report,
  side: () => { const link = btwLink(state.sessionId), side = link && state.sessions.find(task => task.id === link.sideId); return side && { session: side, hiddenThrough: link.hiddenThrough ?? 0 }; },
  running: sideId => isRunning(sideId),
  streaming: sideId => state.streams.has(sideId) || finishingStreams.has(sideId),
  waiting: sideId => {
    const live = state.streams.get(sideId), status = state.sessions.find(task => task.id === sideId)?.status;
    return Boolean(live?.approvals.size || live?.inputs.size) || status === 'waiting' || status === 'waiting_approval';
  },
  mainRunning: () => isRunning(),
  draft: sideId => state.drafts.get(sideId) ?? '',
  setDraft: (sideId, text) => { if (text) state.drafts.set(sideId, text); else state.drafts.delete(sideId); },
  // Dismissed error rows leave the list the panel keys its redraws on; the rows themselves get the whole list, so
  // withErrorTurns can drop them and say how many went (dismissedNoteHtml).
  visible: (sideId, messages) => visibleMessages(sideId, messages).filter(message => !(message.role === 'error' && hiddenErrors.has(message.id))),
  renderRows: (log, region, side, visible, all, follow) => {
    const toolViews = captureTools(log), groupViews = captureToolGroups(log), turnViews = captureTurns(log), changeViews = captureChangeCards(log);
    const switches = captureAccountSwitches(log);
    const previous = new Map([...log.querySelectorAll<HTMLElement>('[data-markdown]')].map(node => [node.dataset.markdown!, node]));
    for (const row of [...log.children]) if (row !== region) row.remove();
    region.insertAdjacentHTML('beforebegin', turnRowsHtml(side.id, visibleMessages(side.id, all), { messages: all, provider: side.provider }));
    paintSavedMarkdown(log, all, previous, workspaceContext(side), follow);
    restoreTurns(log, turnViews); restoreToolGroups(log, groupViews); restoreChangeCards(log, changeViews); restoreTools(log, toolViews);
    // A finished turn's live notes leave with the stream region; the saved rows inherit them.
    restoreAccountSwitches(log, switches, state.streams.has(side.id) || finishingStreams.has(side.id) ? undefined : region);
    scopeErrorIds(log);
  },
  paintStream: (region, sideId, log) => { paintStream(region, sideId, log); scopeErrorIds(region); },
  aboveHtml: side => {
    const running = isRunning(side.id);
    return `<div class="btw-approvals">${taskApprovalsHtml(side.id)}</div>` + queuePanel({ entries: state.queues.get(side.id) ?? [], hold: state.queueHolds.get(side.id) ?? null, running, steerable: !teams.get(side.id), sendable: true, editingId: state.queueEditing || null, busy: state.queueBusy.has(side.id), steering: steeringQueued, notSteered, agentName: provider(side.provider)?.name });
  },
  toolsHtml: shown => {
    // Before the side thread exists, the choices apply to the one /btw creates (btwDraftTask).
    const side = shown ?? btwDraftTask();
    if (!side) return `<div class="composer-tools"></div><button type="submit" class="send-button btw-send" aria-label="Send to side thread" title="Send to side thread (${shortcut('Enter')})">${icon('arrow')}</button>`;
    // A pick made while /btw creates the side thread could miss it, so the pickers wait.
    const running = isRunning(side.id), busy = configuringSessions.has(side.id) || btwSending.has(state.sessionId);
    const send = running
      ? `${teams.get(side.id) ? '' : `<button type="button" class="steer-button" data-btw="steer" title="Send into the side thread's running turn (${shortcut('Enter')})" aria-label="Steer the side thread">${icon('spark')}<span>Steer</span></button>`}<button type="button" class="send-button stop-button" data-action="stop" title="Stop the side thread" aria-label="Stop side thread">${icon('stop')}</button>`
      : `<button type="submit" class="send-button btw-send" aria-label="Send to side thread" title="Send to side thread (${shortcut('Enter')})" ${busy ? 'disabled' : ''}>${icon('arrow')}</button>`;
    return `<div class="composer-tools">${modelTriggerHtml(side, running || busy)}<span class="composer-separator"></span>${modeTriggerHtml(side, running || busy)}</div>${send}`;
  },
  menuBusy: root => Boolean(root.querySelector('[aria-expanded="true"]') || (pendingMenuOpen && root.contains(pendingMenuOpen.anchor))),
  mountPickers: (textarea, side) => {
    const draft = () => state.drafts.set(side.id, textarea.value);
    const slash = mountSlashCommands(textarea, {
      contextKey: () => `${side.id}:${side.provider}:${workspacePath()}`,
      provider: () => state.sessions.find(task => task.id === side.id)?.provider ?? side.provider,
      snapshot: () => call<{ commands: SlashCommand[]; warnings: string[] }>('list_slash_commands', { sessionId: side.id, cachedOnly: true }),
      load: force => call<{ commands: SlashCommand[]; warnings: string[] }>('list_slash_commands', { sessionId: side.id, force }),
      select: draft,
    });
    const mentions = mountFileMentions(textarea, {
      contextKey: () => `${side.id}:${workspacePath()}`,
      search: query => call<MentionEntry[]>('search_files', { projectId: side.projectId, sessionId: side.id, query, limit: 40 }),
      select: draft,
    });
    return () => { slash.dispose(); mentions.dispose(); };
  },
  bindActions: root => { bindMessageActions(root, {
    content: (sessionId, key) => {
      const live = state.streams.get(sessionId) ?? finishingStreams.get(sessionId)?.stream;
      if (key === 'live') return live?.text;
      const saved = btwPanel.message(Number(key));
      return saved && saved.id > 0 && ['user', 'assistant'].includes(saved.role) ? call<string>('get_message_content', { sessionId, messageId: saved.id }) : saved?.content;
    }, onFork: (sessionId, messageId) => forkAtMessage(sessionId, messageId), onEdit: editAtMessage, report,
  }); },
  send: text => sendBtw(text),
  queue: (side, text) => btwPanelQueue(side, text),
  // A team takes messages between runs, as in the main composer.
  steer: (side, text) => teams.get(side.id) ? btwPanelQueue(side, text) : steerOrQueue(side, text),
  command: (side, text) => btwSlash(side, text, document.querySelector('.btw-panel .btw-toolbar')),
  openFull: sideId => run(selectSession(sideId, true)),
  newThread: () => { writeLink(localStorage, state.sessionId, null); renderInspector(); btwPanel.focus(); },
  close: () => { state.inspector = false; renderInspector(); },
  insertMain: text => {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (!prompt) return;
    prompt.value = prompt.value.trim() ? `${prompt.value.trimEnd()}\n\n${text}` : text; state.drafts.set(state.sessionId, prompt.value); resizePrompt();
  },
});
async function btwPanelQueue(side: Session, text: string): Promise<void> {
  const entry = await call<QueuedMessage>('queue_add', { sessionId: side.id, text, attachments: [] });
  setQueue(side.id, [...queueOf(side.id), entry]);
  // The run may have ended while this was saved: send it now.
  if (!isRunning(side.id)) run(dispatchQueue(side.id));
}
/* Model, effort and permissions picked in the panel before a side thread exists: kept per main thread
 * on a stand-in task and applied to the side thread createBtw makes, before its first message. */
const BTW_DRAFT = 'btw-draft:';
const btwDrafts = new Map<string, Session>();
const isBtwDraft = (task: Session): boolean => task.id.startsWith(BTW_DRAFT);
function btwDraftTask(): Session | undefined {
  const main = session();
  return main && (btwDrafts.get(main.id) ?? { ...main, id: BTW_DRAFT + main.id, status: 'idle', contextUsage: null, title: 'Side thread' });
}
/** Records a pick on the stand-in task; the next side thread starts with it. */
function saveBtwDraft(task: Session, change: Partial<Session>): void {
  const mainId = task.id.slice(BTW_DRAFT.length);
  // createBtw is applying (then clearing) the picks; a late pick from a picker opened before the send would vanish.
  if (btwSending.has(mainId)) throw new Error('The side thread is starting. Change it once it has started.');
  btwDrafts.set(mainId, { ...(btwDrafts.get(mainId) ?? task), ...change });
  btwPanel.refresh();
}
/** Gives a new side thread the choices made in the panel before it existed; an error names the setting that failed.
 *  The draft stays until createBtw has finished, so a failure keeps the choices for another try. */
async function applyBtwDraft(mainId: string, side: Session): Promise<Session> {
  const draft = btwDrafts.get(mainId);
  if (!draft) return side;
  const step = async <T>(setting: string, work: () => Promise<T>): Promise<T> => {
    try { return await work(); } catch (error) { throw new Error(`The side thread could not use the ${setting} you picked. ${errorText(error)}`); }
  };
  let current = side;
  if (draft.provider !== current.provider || (draft.model || 'default') !== (current.model || 'default')) current = await step('model', () => call<Session>('configure_session', { sessionId: current.id, provider: draft.provider, model: draft.model }));
  if ((draft.reasoningEffort ?? null) !== (current.reasoningEffort ?? null)) current = await step('reasoning effort', () => call<Session>('set_reasoning_effort', { sessionId: current.id, reasoningEffort: draft.reasoningEffort ?? null }));
  if (draft.mode !== current.mode) { await step('permissions', () => call('update_session', { sessionId: current.id, mode: draft.mode })); current = { ...current, mode: draft.mode }; }
  return current;
}
/** The side thread the By the way panel shows for the open thread. */
function btwSideTask(): Session | undefined { const link = btwLink(state.sessionId); return link && state.sessions.find(task => task.id === link.sideId); }
/** The task a composer control acts on: the By the way panel's side thread inside that panel, else the open thread. */
function actionTask(element: Element): Session | undefined { return element.closest('.btw-panel') ? btwSideTask() ?? btwDraftTask() : session(); }
/** The side thread linked to a main thread. An archived or unlisted one is not reused (the next /btw
 *  starts fresh); the link is never erased here, since a session list can briefly lag a new side thread. */
function btwLink(mainId: string): BtwLink | undefined {
  const link = readLinks(localStorage)[mainId];
  const side = link && state.sessions.find(task => task.id === link.sideId);
  return side && !side.archived ? link : undefined;
}
function openBtw(): void { inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'btw'; state.selectedKind = ''; renderInspector(); }
/** Why this task cannot open a side thread, if it cannot. */
function btwRefusal(main: Session): string {
  if (main.remoteDevice || main.cloud) return 'Side threads run on this computer, and this task runs elsewhere.';
  if (botProjects.has(main.projectId)) return 'Bot conversations cannot open side threads. Ask in a project task instead.';
  return '';
}
/** `/btw …` in the main prompt goes to the side thread, never to the main thread's queue or steer. */
function btwFromComposer(): boolean {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'), s = session();
  const text = prompt && s ? parseBtw(prompt.value) : null;
  if (text === null || !prompt || !s) return false;
  const refusal = btwRefusal(s);
  if (refusal) { notify(refusal); return true; }
  if (text && (composerPayload(s).items.length || state.browserAttachments.get(s.id)?.length || state.moodboardAttachments.get(s.id)?.length)) {
    notify('Side questions cannot carry attachments. Remove them, or send without /btw.'); return true;
  }
  const draft = prompt.value;
  voiceDictation.draftCleared(s.id);
  prompt.value = ''; state.drafts.delete(s.id); resizePrompt(); openBtw();
  if (!text) { btwPanel.focus(); return true; }
  run(voiceDictation.submit(() => sendBtw(text).catch(error => {
    restoreComposerDraft(s, draft);
    throw error;
  })));
  return true;
}
/** A new side thread in the main thread's project, harness, model and checkout. */
async function createBtw(main: Session, prompt: string): Promise<BtwLink> {
  let side: Session, link: BtwLink;
  if (main.worktreePath) {
    // Only a fork keeps a worktree checkout; its copied transcript stays hidden in the panel.
    const page = await call<MessagePage>('get_messages', { sessionId: main.id });
    const last = [...page.messages].reverse().find(m => m.id > 0 && (m.role === 'user' || m.role === 'assistant'));
    if (!last) throw new Error('Send a first message in this task before asking on the side.');
    side = await call<Session>('fork_session_at_message', { sessionId: main.id, messageId: last.id });
    link = { sideId: side.id, seenId: last.id, hiddenThrough: 0 };
  } else {
    side = await call<Session>('create_session', { projectId: main.projectId, provider: main.provider, model: main.model, mode: main.mode });
    link = { sideId: side.id, seenId: 0 };
  }
  const title = sideTitle(prompt);
  try {
    if (main.worktreePath) {
      const copied = await call<MessagePage>('get_messages', { sessionId: side.id });
      link = { ...link, hiddenThrough: Math.max(0, ...copied.messages.map(m => m.id)) };
    }
    side = await applyBtwDraft(main.id, side);
    await call('update_session', { sessionId: side.id, title });
  } catch (error) {
    // Never leave a half-set-up task behind; the panel keeps its picks and the /btw text comes back.
    const created = side;
    await call('delete_session', { sessionId: created.id }).catch(() => undefined);
    state.sessions = state.sessions.filter(task => task.id !== created.id);
    throw error;
  }
  btwDrafts.delete(main.id);
  state.sessions = [{ ...side, title }, ...state.sessions.filter(task => task.id !== side.id)];
  writeLink(localStorage, main.id, link); renderNavigation();
  return link;
}
/** One create-or-send at a time per main thread, so two quick /btw prompts share one side thread. */
const btwSending = new Map<string, Promise<void>>();
function sendBtw(text: string): Promise<void> {
  const main = session(); if (!main) return Promise.resolve();
  const refusal = btwRefusal(main);
  if (refusal) return Promise.reject(new Error(refusal));
  const next = (btwSending.get(main.id) ?? Promise.resolve()).catch(() => undefined).then(() => deliverBtw(main, text));
  btwSending.set(main.id, next); btwPanel.refresh();
  void next.catch(() => undefined).finally(() => { if (btwSending.get(main.id) === next) btwSending.delete(main.id); btwPanel.refresh(); });
  return next;
}
/** Sends to the side thread with the main thread's news since its last message. */
async function deliverBtw(main: Session, text: string): Promise<void> {
  const link = btwLink(main.id) ?? await createBtw(main, text);
  const side = state.sessions.find(task => task.id === link.sideId)!;
  if (isRunning(side.id)) throw new Error('The side thread is still answering. Send this when it finishes.');
  // Running from here on: no second send can pass the check above, and a failure below tears down only this run.
  stream(side.id).status = 'Starting agent'; side.status = 'running';
  const showing = () => state.sessionId === main.id && state.inspectorTab === 'btw';
  if (showing()) renderInspector();
  let sentLink: BtwLink | undefined;
  try {
    const context = await btwContext(main, link);
    const content = text + context.text;
    sentLink = context.link;
    writeLink(localStorage, main.id, sentLink);
    if (showing()) btwPanel.sent(side.id, sentPrompt(side, content, Date.now()));
    await call('send_message', { sessionId: side.id, text: content, imageIds: [], moodboardIds: [] });
  } catch (error) {
    state.streams.delete(side.id); side.status = 'idle';
    // Roll back only our own write; a New side thread chosen meanwhile stays.
    const current = readLinks(localStorage)[main.id];
    if (sentLink && current?.sideId === sentLink.sideId && current.seenId === sentLink.seenId) writeLink(localStorage, main.id, link);
    if (showing()) { renderInspector(); void btwPanel.reload(); }
    throw error;
  }
}
/** The `Main thread context:` block for the side thread's next message, and the link that records it as seen. */
async function btwContext(main: Session, link: BtwLink): Promise<{ text: string; link: BtwLink }> {
  const page = await call<MessagePage>('get_messages', { sessionId: main.id });
  const strip = (content: string) => { const index = content.search(CONTEXT_BOUNDARY); return index < 0 ? content : content.slice(0, index); };
  // Only the newest page came back: older unseen history is reported as left out.
  const gap = page.hasOlder && (page.messages[0]?.id ?? 0) > link.seenId;
  const context = mainContext({ title: main.title, status: isRunning(main.id) ? 'running' : main.status },
    page.messages.map(m => ({ ...m, content: m.role === 'user' ? strip(m.content) : m.content })), link.seenId, state.streams.get(main.id)?.text ?? '', CONTEXT_LIMIT, gap);
  return { text: context.text, link: { ...link, seenId: context.seenId } };
}
/** The main thread a side thread was opened beside, with its link. */
function btwMainOf(sideId: string): { main: Session; link: BtwLink } | undefined {
  for (const [mainId, link] of Object.entries(readLinks(localStorage))) {
    const main = link.sideId === sideId ? state.sessions.find(task => task.id === mainId) : undefined;
    if (main) return { main, link };
  }
  return undefined;
}
async function finishResponse(sessionId: string, finishing: FinishingStream): Promise<void> {
  const current = () => finishingStreams.get(sessionId) === finishing && !state.streams.has(sessionId);
  finishing.error = undefined; finishing.stream.revision++;
  if (sessionId === state.sessionId) renderStream();
  try {
    await reloadSessions(); const generation = state.generation;
    if (!current()) return;
    if (sessionId !== state.sessionId) { finishingStreams.delete(sessionId); return; }
    const saved = await latestMessagePage(sessionId);
    if (!current()) return;
    // The saved reply draws from the cache in the swap's own task, so the card is measured as it will stay.
    const reply = [...saved.messages].reverse().find(message => message.role === 'assistant')?.content;
    if (reply && !markdownCache.get(reply)) await (markdownCache.settle(reply) ?? markdownHtml(reply)).catch(() => undefined);
    if (!current()) return;
    finishingStreams.delete(sessionId);
    if (sessionId !== state.sessionId || generation !== state.generation) return;
    setMessagePage(saved); state.messagesLoading = false; state.messagesError = ''; mirrorPrompts.delete(sessionId);
    // The composer lets go of the steer row's space (held since the run ended) in the task the saved card arrives,
    // whose bridge absorbs it (handOffCard), so a pinned thread does not move at the swap.
    handoffRect = document.querySelector('#stream-region .turn-card.is-live')?.getBoundingClientRect();
    renderComposer(); renderTranscript();
    await refreshInspector();
  } catch (error) {
    if (!current()) return;
    finishing.error = errorText(error); finishing.stream.revision++;
    if (sessionId === state.sessionId) { renderStream(); renderComposer(); }
  }
}
let completedHistoryRequest = 0;
/** The live card's rect at a handoff, taken before renderComposer (renderTranscript → handOffCard). */
let handoffRect: DOMRect | undefined;
/** A run usually ends right after its changes arrive, so the live card stays until the saved one replaces it
 * in one task (finishResponse → handOffCard). Only a next turn of the same run materializes them first. */
function completeTurnChanges(event: AgentEvent): void {
  const data = event.data as { messageId?: number; turnChanges?: TurnChanges } | undefined;
  if (!data?.turnChanges) return;
  const current = state.streams.get(event.sessionId);
  if (current) current.pendingChanges = data.turnChanges;
  else materializeTurn(event.sessionId, data.turnChanges);
}
function materializeTurn(sessionId: string, changes: TurnChanges): void {
  const current = state.streams.get(sessionId);
  if (current) current.pendingChanges = undefined;
  const page = tilePages.get(sessionId) ?? threadPages.get(sessionId);
  const existing = sessionId === state.sessionId ? state.messages : page?.messages;
  if (existing && !existing.some(message => message.turnChanges?.id === changes.id)) {
    const messages = current ? liveVisibleMessages(existing, current) : existing.slice();
    // Materialize only at a turn boundary; tokens keep their existing incremental path.
    if (current) {
      for (const entry of current.tools) {
        // A dismissed error leaves no row; a counted one is one row carrying its count (groupErrors sums it).
        if (entry.statusOnly && entry.dismissed) continue;
        const row: CountedMessage = { id: transientId--, sessionId: sessionId, role: entry.commentary ? 'assistant' : entry.statusOnly ? 'error' : 'tool', content: entry.key === current.retainedMessageKey ? current.text : typeof entry.content === 'string' ? entry.content : JSON.stringify({ type: 'tool_activity', version: 1, ...entry.content }), createdAt: Date.now(), ...(entry.count ? { count: entry.count } : {}), ...(entry.savedIds?.length ? { savedIds: entry.savedIds } : {}) };
        messages.push(row);
      }
      if (current.text && !current.tools.some(entry => entry.key === current.retainedMessageKey)) messages.push({ id: transientId--, sessionId: sessionId, role: 'assistant', content: current.text, createdAt: Date.now() });
      messages.push(...current.accountSwitches);
    }
    messages.push({ id: transientId--, sessionId: sessionId, role: 'changes', content: '', createdAt: Date.now(), turnChanges: changes });
    if (sessionId === state.sessionId) state.messages = messages;
    else {
      tilePages.set(sessionId, { messages, hasOlder: page!.hasOlder });
      if (threadPages.has(sessionId)) threadPages.set(sessionId, { messages, hasOlder: page!.hasOlder, chars: messages.reduce((total, message) => total + message.content.length, 0) });
    }
  }
  if (current) { current.body.set(''); current.thought.set(''); current.retainedMessageKey = undefined; current.tools = []; current.accountSwitches = []; current.omittedActivity = false; current.revision++; current.startedAt = Date.now(); current.turnKey = 'turn:live:' + transientId--; }
  if (sessionId === state.sessionId) {
    renderTranscript();
    // A task on another computer has its messages copied when the run ends; its `done` reloads them.
    if (session()?.remoteDevice) return;
    // Reconcile once at completion with persisted IDs and full text. This also
    // wins over an older history request made while switching to a busy task.
    const request = ++completedHistoryRequest, generation = state.generation;
    void latestMessagePage(sessionId).then(page => {
      if (request !== completedHistoryRequest || generation !== state.generation || sessionId !== state.sessionId || state.streams.get(sessionId) !== current) return;
      setMessagePage(page); state.messagesLoading = false; renderTranscript();
    }).catch(report);
  }
}
/** A run this window did not start may be a lead's wake, whose coordination message is saved but not loaded yet.
 * Its live card waits for that page, so the saved card never shows beside it; the run's state updates at once, and a
 * failed or slow load (WAKE_LOAD_HOLD_MS) lets the card paint, so no reply is hidden. Any other run keeps the page it has. */
function loadWakeExchange(sessionId: string, current: Stream): void {
  tilePages.delete(sessionId);
  if (sessionId !== state.sessionId || botForThread()) return;
  const generation = state.generation;
  const endHold = (): void => { if (wakeHolds.get(sessionId) === timer) { clearTimeout(timer); wakeHolds.delete(sessionId); } };
  const timer = window.setTimeout(() => { endHold(); renderTranscript(); }, WAKE_LOAD_HOLD_MS);
  clearTimeout(wakeHolds.get(sessionId));
  wakeHolds.set(sessionId, timer);
  // Only the newest page: a wake's coordination message is saved just before its run starts, so it is there. A run
  // that has no boundary on it is not looked into further, so this never asks for older pages (latestMessagePage
  // bridges a gap with them). setMessagePage keeps the older pages the reader loaded.
  // ponytail: a wake that saved over a page before its first event shows two cards until it ends; bridge here if that happens.
  const fresh = (): boolean => generation === state.generation && sessionId === state.sessionId && state.streams.get(sessionId) === current && !current.earlier;
  void call<MessagePage>('get_messages', { sessionId }).then(async newest => {
    const boundary = [...newest.messages].reverse().find(message => message.role === 'user' || message.role === 'coordination' || message.role === 'changes');
    if (boundary?.role !== 'coordination' || !fresh()) return;
    // The page reaches what is loaded, so it joins it as is; with a gap in between, the gap is loaded first.
    const known = [...state.messages].reverse().find(message => message.id > 0)?.id;
    const page = newest.hasOlder && known !== undefined && newest.messages[0]?.id > known ? await latestMessagePage(sessionId) : newest;
    if (!fresh()) return;
    endHold(); setMessagePage(page); renderTranscript();
  }).catch(report).finally(() => { if (wakeHolds.get(sessionId) === timer) { endHold(); renderTranscript(); } });
}
/** `MESSAGE_LIMIT` in lib.rs. */
const MESSAGE_LIMIT = 16 * 1024 * 1024;
function onAgent(event: AgentEvent): void {
  remoteStartAttached(event.sessionId);
  queueMicrotask(() => btwPanel.event(event.sessionId, event.kind));
  if (botsView) queueMicrotask(() => botsView?.agent(event.sessionId, event.kind));
  if ((event.kind === 'done' || event.kind === 'turn_start') && botForThread()) queueMicrotask(renderHeader);
  if (event.kind === 'done') tilePages.delete(event.sessionId);
  queueMicrotask(() => tiles.event(event.sessionId));
  if (deletedSessions.has(event.sessionId)) return;
  // Managed workers are deliberately absent from sidebar/board task summaries.
  // Route their live output and approval forms to the team's worker inspector.
  if (!state.sessions.some(s => s.id === event.sessionId)) {
    void ensureArchitectView().then(view => {
      if (deletedSessions.has(event.sessionId)) return;
      view.receive(event);
      // A worker's approval or question must reach the user even with the panel closed.
      if (event.kind === 'approval' || event.kind === 'input_request') notify('A worker needs your input. Open Architect & workers.', undefined, { important: true });
      if (['approval', 'approval_cancelled', 'input_request', 'input_cancelled', 'done'].includes(event.kind)) refreshTeamProgress();
    }).catch(report);
    return;
  }
  onAccountPoolSwitch(event);
  if (event.kind === 'task_settings') { const task = state.sessions.find(s => s.id === event.sessionId); if (task) task.codexSettings = event.data as Session['codexSettings']; return; }
  if (event.kind === 'goal_ready') return;
  if (event.kind === 'goal_input') { const current = state.streams.get(event.sessionId); if (current) { finishLiveMessage(current, event.sessionId); current.tools.push({ key: 'goal:' + transientId--, content: 'Goal updated: ' + event.text, commentary: true }); current.revision++; if (event.sessionId === state.sessionId) renderStream(); } return; }
  if (event.kind === 'goal') {
    const task = state.sessions.find(s => s.id === event.sessionId);
    if (task) { task.goalState = event.data as GoalState | null; if (task.id === state.sessionId) goalBanner.update(task.goalState ?? null); }
    return;
  }
  // Keep the final response intact until its persisted changes boundary arrives.
  if (event.kind === 'turn_complete') return;
  if (event.kind === 'turn_changes') { if (event.sessionId === state.sessionId) void projectRunner.refresh(); completeTurnChanges(event); return; }
  if (event.kind === 'turn_start') return;
  if (event.kind === 'commands_changed') { if (event.sessionId === state.sessionId) slashPicker?.refresh(true); return; }
  if (event.kind === 'subagent') { subagents.receive(event.sessionId, event.data); return; }
  // Hosts send `team` (a changed worker row) only for mirrors; it is not a local event kind.
  const workerRow = (event.kind as string) === 'team';
  if ((workerRow || event.kind === 'done' && teams.get(event.sessionId)) && state.sessions.find(task => task.id === event.sessionId)?.remoteDevice) refreshMirrorTeam(event.sessionId);
  if (workerRow) return;
  // Native reports each steer's pending, delivered or failed state.
  if (event.kind === 'steer') { steerEvent(event); return; }
  const s = state.sessions.find(s => s.id === event.sessionId);
  if (event.kind === 'usage') {
    const usage = parseContextUsage(event.data);
    if (s && usage) {
      s.contextUsage = usage;
      const current = state.streams.get(s.id); if (current) current.contextUsage = usage;
    }
    return;
  }
  if (event.kind === 'done') {
    subagents.runEnded(event.sessionId);
    if (s) refreshFileLinks(workspaceContext(s));
    void detectPullRequest(event.sessionId);
    if (s && botProjects.has(s.projectId)) { if (event.sessionId !== state.sessionId) respondedBots.add(s.projectId); void refreshBotPreviews(); }
    for (const [id, item] of steers) if (item.sessionId === event.sessionId) steers.delete(id);
    const finishing = { stream: state.streams.get(event.sessionId) ?? stream(event.sessionId), finishedAt: Date.now() };
    clearAgentInputs(finishing.stream);
    finishingStreams.set(event.sessionId, finishing);
    state.streams.delete(event.sessionId); if (s) s.status = 'idle';
    // A turn that finished out of view (another thread, the board, another app) shows unread until opened.
    if (s && (s.id !== state.sessionId || !transcriptVisible() || !document.hasFocus())) { (unreviewed ??= readCollapsed(localStorage, UNREVIEWED_KEY)).add(s.id); saveUnreviewed(); }
    updateWorkTimer();
    // A failed or stopped run holds the queue; a clean finish sends the next queued message.
    const ending = runEndings.get(event.sessionId); runEndings.delete(event.sessionId);
    // Hold even an empty queue: a message saved a moment later must not slip past a failure or limit.
    const first = sendFirst.get(event.sessionId);
    if (first?.stopping) sendFirst.set(event.sessionId, { id: first.id });
    if (first?.stopping && ending === 'stopped') { if (first.hold) state.queueHolds.set(event.sessionId, first.hold); else state.queueHolds.delete(event.sessionId); }
    else if (ending) state.queueHolds.set(event.sessionId, ending);
    if (s && botProjects.has(s.projectId)) {
      if (ending === 'failed') failedBotProjects.add(s.projectId);
      else if (!ending) failedBotProjects.delete(s.projectId);
    }
    if (!ending) void maybeTurnChecks(event.sessionId);
    if (event.sessionId === state.sessionId) { renderStream(); renderComposer(); }
    void applyNextBotModel(event.sessionId);
    void finishResponse(event.sessionId, finishing).finally(() => run(dispatchQueue(event.sessionId))); return;
  }
  if (event.kind === 'session') return;
  if (event.kind === 'limited') {
    // The account is out for now: remember the reset, hold any queue, and say when it resets.
    const until = (event.data as { resetsAt?: number | null } | undefined)?.resetsAt ?? null;
    if (s) { s.limitedAt = Date.now(); s.limitedUntil = until; s.resumeAtReset = false; }
    runEndings.set(event.sessionId, 'limited');
    // A bot's limit already shows as its sidebar chip and above its composer.
    if (!sidebarBots.some(bot => bot.projectId === s?.projectId)) notify(`${s?.title ?? 'Task'}: ${event.text}${until ? ` · ${resetLabel(until)}` : ''}`);
    renderNavigation(); if (event.sessionId === state.sessionId) renderComposer();
    return;
  }
  if ((event.kind === 'approval_cancelled' || event.kind === 'input_cancelled') && !state.streams.has(event.sessionId)) return;
  const pendingChanges = state.streams.get(event.sessionId)?.pendingChanges;
  if (pendingChanges) materializeTurn(event.sessionId, pendingChanges);
  const firstEvent = !state.streams.has(event.sessionId); const current = stream(event.sessionId); if (s) { s.status = 'running'; s.taskStage = 'in_progress'; }
  if (firstEvent) loadWakeExchange(event.sessionId, current);
  if ((event.kind as string) === 'note') {
    const pool = (event.data as { accountPool?: { connectionId?: unknown } } | undefined)?.accountPool;
    const marked = pool && (pool.connectionId === null || typeof pool.connectionId === 'string');
    const detail = accountSwitchDetail(event.text) ?? (marked && !event.text.startsWith(ACCOUNT_SWITCH_PREFIX) && event.text.trim() ? event.text : null);
    if (detail !== null) {
      const content = ACCOUNT_SWITCH_PREFIX + detail;
      const saved = current.accountSwitches.find(note => !note.eventSeen && note.content === content);
      if (saved) saved.eventSeen = true;
      else current.accountSwitches.push({ id: transientId--, sessionId: event.sessionId, role: 'system', content, createdAt: Date.now(), eventSeen: true });
      current.revision++;
      if (event.sessionId === state.sessionId) announce('Account switched');
    }
  }
  let becameActive = false;
  if (event.kind === 'message_start') finishLiveMessage(current, event.sessionId);
  if (event.kind === 'text') {
    if (event.text && current.retainedMessageKey) {
      current.body.set(''); current.retainedMessageKey = undefined; current.revision++;
    }
    current.body.append(event.text);
    if (event.text.trim()) {
      updateStreamStatus(current, 'Generating response');
      current.lastResponseAt = Date.now();
      if (s) { becameActive = !activeTask(s); s.lastResponseAt = current.lastResponseAt; }
    }
  }
  // Not saved with the transcript, so the fold lives only while the turn streams.
  if ((event.kind as string) === 'thinking') current.thought.append(event.text);
  if (event.kind === 'tool') {
    const tool = event.tool;
    const key = tool ? 'tool:' + tool.id : 'live:' + transientId--;
    if (current.turnKey.startsWith('turn:live:')) current.turnKey = 'turn:' + key;
    const entry = { key, content: tool ?? event.text.slice(0, 8192) };
    const index = current.tools.findIndex(item => item.key === key);
    if (index < 0) finishLiveMessage(current, event.sessionId);
    if (index < 0) current.tools.push(entry); else current.tools[index] = entry;
    const running = tool?.status === 'running' ? tool : current.tools.find(item => typeof item.content !== 'string' && item.content.status === 'running')?.content;
    updateStreamStatus(current, running && typeof running !== 'string' ? `Running ${running.name.slice(0, 80)}` : 'Working…');
    trimLiveActivity(current, event.sessionId); current.revision++;
  }
  if (event.kind === 'status') {
    updateStreamStatus(current, event.text);
    if (event.text === 'Stopping agent') clearAgentInputs(current);
  }
  if (event.kind === 'error') { if (runEndings.get(event.sessionId) !== 'limited') runEndings.set(event.sessionId, 'failed'); addLiveError(current, event.sessionId, event.text, savedErrorId(event.data)); }
  if (event.kind === 'approval' && event.requestId) { current.approvals.set(event.requestId, event.text); current.revision++; updateStreamStatus(current, 'Waiting for approval'); if (event.sessionId !== state.sessionId) notify(`${(s?.title ?? 'Task').replace(/ · You$/, '')} needs approval`, undefined, { important: true }); }
  if (event.kind === 'approval_cancelled' && event.requestId && current.approvals.delete(event.requestId)) {
    current.revision++; if (!current.approvals.size && current.status === 'Waiting for approval') updateStreamStatus(current, 'Continuing task');
  }
  if (event.kind === 'input_request' && event.requestId && current.status !== 'Stopping agent' && !current.inputs.has(event.requestId)) {
    const requestId = event.requestId;
    current.inputs.set(requestId, createAgentInput(event.sessionId, requestId, event.data, () => {
      current.inputs.get(requestId)?.dispose(); current.inputs.delete(requestId); current.revision++;
      if (!current.inputs.size && current.status === 'Waiting for your answer') updateStreamStatus(current, 'Continuing task');
      if (event.sessionId === state.sessionId) renderStream();
      btwPanel.event(event.sessionId, 'input');
      scheduleNavigation();
    }, Boolean(s?.remoteDevice)));
    current.revision++; updateStreamStatus(current, 'Waiting for your answer');
    if (event.sessionId !== state.sessionId) notify(`${(s?.title ?? 'Task').replace(/ · You$/, '')} needs your answer`, undefined, { important: true });
  }
  if (event.kind === 'input_cancelled' && event.requestId) {
    current.inputs.get(event.requestId)?.dispose(); current.inputs.delete(event.requestId); current.revision++;
    if (!current.inputs.size && current.status === 'Waiting for your answer') updateStreamStatus(current, 'Continuing task');
  }
  // Tokens and tool snapshots do not change task navigation. Four busy agents
  // share one navigation frame only when a running/recency/approval state changes.
  if (firstEvent || becameActive || event.kind === 'approval' || event.kind === 'approval_cancelled' || event.kind === 'input_request' || event.kind === 'input_cancelled') {
    if (firstEvent && event.sessionId === state.sessionId && !document.hidden) { renderHeader(); if (document.querySelector<HTMLTextAreaElement>('#prompt')?.disabled === false) renderComposer(); }
    scheduleNavigation();
  }
  if (firstEvent && event.sessionId === state.sessionId && !wakeHolds.has(event.sessionId)) renderTranscript();
  if (!renderFrame && event.sessionId === state.sessionId && transcriptVisible()) renderFrame = requestAnimationFrame(() => { renderFrame = 0; renderStream(); });
}

/** A thread switch within the workspace whose status loaded this long ago (ms) reuses it rather than reloading the
 *  status, file list and jj state and redrawing the inspector; anything that changes the files refreshes it itself. */
const INSPECTOR_FRESH_MS = 5000;
/** The workspace refreshInspector last loaded cleanly, and when. */
let inspectorLoaded: { key: string; at: number } | undefined;
/** refreshInspector, unless the same workspace loaded cleanly a moment ago and nothing cleared it since. */
async function refreshInspectorIfStale(): Promise<void> {
  const fresh = inspectorLoaded?.key === workspaceKey() && Date.now() - inspectorLoaded.at < INSPECTOR_FRESH_MS;
  if (fresh && !state.inspectorLoading && state.git && !state.gitError && !state.filesError) return;
  await refreshInspector();
}
async function refreshInspector(): Promise<void> {
  void projectRunner.refresh();
  const request = ++inspectorRequest;
  const p = project(); if (!p) { state.git = null; state.jj = null; state.files = []; state.gitError = ''; state.filesError = ''; state.inspectorLoading = false; renderInspector(); return; }
  state.inspectorLoading = true; renderInspector();
  const id = p.id, folders = [...state.openFolders], context = workspaceContext(), key = workspaceKey();
  const [results, children] = await Promise.all([
    Promise.allSettled([call<GitStatus>('git_status', context), call<FileEntry[]>('list_files', { ...context, path: '' }), call<JjStatus>('jj_status', context)]),
    Promise.allSettled(folders.map(path => call<FileEntry[]>('list_files', { ...context, path }))),
  ]);
  if (request !== inspectorRequest || id !== state.projectId || key !== workspaceKey()) return;
  // Only folders still open take the new listing; a failed read keeps the last one rather than collapsing the folder.
  children.forEach((result, index) => {
    const path = folders[index];
    if (result.status === 'fulfilled' && state.openFolders.has(path)) state.folderFiles.set(path, result.value);
  });
  state.inspectorLoading = false;
  // An unchanged status keeps its object, so the Changes view does not refetch every loaded diff for nothing.
  const git = results[0].status === 'fulfilled' ? results[0].value : null;
  state.git = git && state.git && JSON.stringify(git) === JSON.stringify(state.git) ? state.git : git;
  inspectorLoaded = results.every(result => result.status === 'fulfilled') ? { key, at: Date.now() } : undefined;
  if (state.git) noteChangedPaths(state.git.files.map(file => file.path));
  state.gitError = results[0].status === 'rejected' ? errorText(results[0].reason) || 'Git status could not be loaded.' : '';
  state.files = results[1].status === 'fulfilled' ? results[1].value : [];
  state.jj = results[2].status === 'fulfilled' ? results[2].value : null;
  state.filesError = results[1].status === 'rejected' ? errorText(results[1].reason) || 'The folder could not be read.' : '';
  renderInspector(); renderHeader(); if (state.inspector && state.inspectorTab === 'file') fileTabs.reload();
}
/** The simulator panel stays mounted once opened; hiding it stops its frames. */
function syncSimulatorPanel(): void {
  const wanted = state.inspector && state.inspectorTab === 'simulator' && !inspectorSuppressed;
  $('#simulator-panel').hidden = !wanted;
  if (wanted) { $('#inspector-content').hidden = true; $('#inspector-refresh').hidden = true; }
  if (!wanted) { simulatorPanel?.hide(); return; }
  if (simulatorPanel) { simulatorPanel.show(); return; }
  simulatorLoading ??= import('./simulator').then(({ mountSimulator }) => {
    simulatorPanel = mountSimulator($('#simulator-panel'), {
      call, notify, notifyError,
      choose: (anchor, title, items, onSelect) => void showChoices(anchor, { title, width: 300, items, onSelect: id => { closeChoiceMenu(); onSelect(id); } }),
      listen: (name, callback) => subscribe(name, callback),
    });
    if (state.inspector && state.inspectorTab === 'simulator' && !inspectorSuppressed) simulatorPanel.show();
  }).catch(error => { simulatorLoading = undefined; report(error); });
}
/** The VM panel stays mounted once opened; hiding it stops its frames. */
function syncVmPanel(): void {
  const wanted = isMac && state.inspector && state.inspectorTab === 'vm' && !inspectorSuppressed;
  $('#vm-panel').hidden = !wanted;
  if (wanted) { $('#inspector-content').hidden = true; $('#inspector-refresh').hidden = true; }
  if (!wanted) { vmPanel?.hide(); return; }
  if (vmPanel) { vmPanel.show(); return; }
  vmLoading ??= import('./vm-panel').then(({ mountVmPanel }) => {
    vmPanel = mountVmPanel($('#vm-panel'), {
      call, notify,
      choose: (anchor, title, items, onSelect) => void showChoices(anchor, { title, width: 300, items, onSelect: id => { closeChoiceMenu(); onSelect(id); } }),
      project: () => project()?.path ?? null,
    });
    if (state.inspector && state.inspectorTab === 'vm' && !inspectorSuppressed) vmPanel.show();
  }).catch(error => { vmLoading = undefined; report(error); });
}
/** The thread's visual progress PiP: conversation view only, never on the new-task page. */
function syncProgressPip(): void {
  const id = state.sessionId, allowed = Boolean(id) && state.view === 'conversation' && !newTaskView();
  if (progressPip) { progressPip.update(id, allowed, allowed && isRunning()); return; }
  if (!id) return;
  progressPipLoading ??= import('./progress-pip').then(({ mountProgressPip }) => {
    progressPip = mountProgressPip($('#progress-pip'), { call, notify, notifyError });
    syncProgressPip();
  }).catch(error => { progressPipLoading = undefined; report(error); });
}
/** The design canvas stays mounted once opened; hidden, it makes no calls. */
function syncDesignPanel(): void {
  const wanted = state.inspector && state.inspectorTab === 'design' && !inspectorSuppressed;
  $('#design-panel').hidden = !wanted;
  if (wanted) { $('#inspector-content').hidden = true; $('#inspector-refresh').hidden = true; }
  if (!wanted) { designPanel?.hide(); return; }
  if (designPanel) { designPanel.show(); return; }
  designLoading ??= import('./design-canvas').then(({ mountDesignCanvas }) => {
    designPanel = mountDesignCanvas($('#design-panel'), {
      call, notify, notifyError,
      context: () => state.projectId ? { projectId: state.projectId, sessionId: state.sessionId || null } : null,
      compose: text => { const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (prompt) { prompt.value = text; prompt.dispatchEvent(new Event('input', { bubbles: true })); prompt.focus(); } },
    });
    if (state.inspector && state.inspectorTab === 'design' && !inspectorSuppressed) designPanel.show();
  }).catch(error => { designLoading = undefined; report(error); });
}
function openVm(): void { inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'vm'; state.selectedKind = ''; renderInspector(); }
function openSimulator(): void { inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'simulator'; state.selectedKind = ''; renderInspector(); }
function syncBrowserPanel(): void {
  const wanted = state.inspector && state.inspectorTab === 'browser' && !inspectorSuppressed;
  const owner = state.sessionId;
  const ownerKey = `${owner}:${workspaceKey()}`;
  $('.workspace').classList.toggle('browser-open', wanted);
  $('#browser-toggle').classList.toggle('active', wanted);
  $('#browser-panel').hidden = !wanted;
  $('#inspector-content').hidden = wanted;
  $('#inspector-refresh').hidden = wanted;
  if (browserWanted === wanted && browserOwner === ownerKey) { browserPanel?.refresh(); return; }
  browserWanted = wanted; browserOwner = ownerKey;
  const revision = ++browserRevision;
  const previous = browserPanel; browserPanel = undefined;
  // Stop accepting the old task's page events before any asynchronous teardown.
  const closing = previous?.close();
  // Observe an early rejection now; the serialized lifecycle still awaits and
  // reports the original failure before mounting another guest.
  void closing?.catch(() => {});
  $('#browser-panel').replaceChildren();
  browserLifecycle = browserLifecycle.catch(report).then(async () => {
    await closing;
    if (!browserWanted || revision !== browserRevision) return;
    const { mountBrowser } = await import('./browser');
    if (!browserWanted || revision !== browserRevision) return;
    // A superseded mount may still be awaiting subscriptions. Its detached host
    // must stay intact until that mount returns and can dispose itself.
    const mount = document.createElement('div'); mount.className = 'browser-panel browser-instance';
    $('#browser-panel').append(mount);
    const panel = await mountBrowser(mount, {
      task: () => state.sessionId === owner && session() && !isRunning() && !threadLoading() ? owner : undefined,
      session: () => owner || undefined,
      navigated: url => { if (revision === browserRevision && state.sessionId === owner) state.browserUrl = url; },
      attach: attachBrowserContext,
      test: (url, anchor) => run(openJevTests(url, anchor)),
      close: () => { state.inspector = false; renderInspector(); },
    });
    if (!browserWanted || revision !== browserRevision) { await panel.close(); return; }
    browserPanel = panel;
    if (state.browserUrl) await panel.navigate(state.browserUrl);
  });
  run(browserLifecycle);
}
async function performAgentUiAction(request: AgentUiAction): Promise<unknown> {
  const active = async () => {
    const pending = await call<boolean>('agent_ui_request_active', { requestId: request.requestId });
    if (!pending || !transcriptVisible() || state.sessionId !== request.sessionId) throw new Error('App action is no longer active for the visible task.');
  };
  await active();
  const { action, args } = request;
  if (action === 'open_task') { await selectSession(String(args.taskId)); return { opened: state.sessionId === args.taskId }; }
  if (action === 'open_file') { if (args.view === 'rendered' || args.view === 'raw') setDocumentView(String(args.path), args.view); await openFile(String(args.path), 'file'); return { opened: fileTabs.active === args.path }; }
  if (action === 'open_terminal') { if (!terminalPanel.open) await toggleTerminal(); return { opened: terminalPanel.open }; }
  if (action === 'run_project') return projectRunner.run(request.requestId, active);
  if (action === 'preview_file') { await previewFile(String(args.path), workspaceContext(), active); return { opened: true }; }
  if (action === 'open_browser') {
    state.inspector = true; state.inspectorTab = 'browser'; renderInspector();
    await browserLifecycle; await active();
    if (!browserPanel) throw new Error('Browser could not be opened.');
    return browserPanel.navigate(String(args.url));
  }
  if (!browserPanel || !state.inspector || state.inspectorTab !== 'browser') throw new Error('Open the browser in this task first.');
  if (action === 'read_browser') return call('browser_inspect', { action: 'read' });
  if (action === 'browser_click' || action === 'browser_type') return call('browser_inspect', { action: action === 'browser_click' ? 'click' : 'type', selector: args.selector, text: args.text });
  if (action === 'browser_action') { await call('browser_action', { action: args.action }); return { dispatched: true }; }
  if (action === 'capture_browser') {
    const screenshot = await call<import('./types').BrowserScreenshot>('browser_capture');
    return { path: screenshot.path, url: screenshot.url, title: screenshot.title, width: screenshot.width, height: screenshot.height };
  }
  throw new Error('Unknown app action.');
}
/** Adds the selected view's tab when something opened it, then draws the strip in the open order. */
/** Keeps the selected tab clear of the sticky + and of the 16px edge fades (inspector-bar.css), which end at the strip's scroll ends. */
function revealSelectedTab(): void {
  const nav = $('.inspector-tabs'), add = nav.querySelector<HTMLElement>('.inspector-tab-add')!;
  const current = nav.querySelector<HTMLElement>(':scope>.inspector-tab:has(>.selected):not([hidden])');
  if (!current || !nav.clientWidth) return;
  const strip = nav.getBoundingClientRect(), box = current.getBoundingClientRect(), fade = 16;
  const start = strip.left + fade, end = strip.right - fade - (add.hidden ? 0 : add.offsetWidth);
  if (box.left < start) nav.scrollLeft -= start - box.left;
  else if (box.right > end) nav.scrollLeft += box.right - end;
}
// A tab can change the panel's width after it draws (the browser view is wider).
new ResizeObserver(revealSelectedTab).observe($('.inspector-tabs'));
/** The strip is one Tab stop: the focused tab while focus is in the strip, else the selected one. Close buttons stay out
 * of the Tab order (Delete closes the focused tab). */
const stripTabs = (nav: HTMLElement): HTMLElement[] => [...nav.querySelectorAll<HTMLElement>(':scope>.inspector-tab:not([hidden])>.inspector-tab-button')];
function rovingTabs(nav: HTMLElement, focus?: HTMLElement): void {
  const tabs = stripTabs(nav), stop = focus ?? tabs.find(tab => tab === document.activeElement) ?? tabs.find(tab => tab.classList.contains('selected')) ?? tabs[0];
  for (const tab of nav.querySelectorAll<HTMLElement>('.inspector-tab-button')) tab.tabIndex = tab === stop ? 0 : -1;
}
$('.inspector-tabs').addEventListener('keydown', event => {
  const nav = event.currentTarget as HTMLElement, current = (event.target as HTMLElement).closest<HTMLElement>('.inspector-tab-button');
  if (!current || event.altKey || event.metaKey || event.ctrlKey) return;
  const tabs = stripTabs(nav), index = tabs.indexOf(current);
  if (event.key === 'Delete' || event.key === 'Backspace') {
    const close = current.parentElement!.querySelector<HTMLElement>('.inspector-tab-close');
    if (!close || close.hidden) return;
    event.preventDefault();
    const neighbour = tabs[index + 1] ?? tabs[index - 1];
    closeInspectorTab(close.dataset.view as PanelView);
    const next = neighbour?.isConnected && !neighbour.closest('[hidden]') ? neighbour : stripTabs(nav).find(tab => tab.classList.contains('selected'));
    if (next) { rovingTabs(nav, next); next.focus(); }
    return;
  }
  const target = event.key === 'ArrowRight' ? tabs[(index + 1) % tabs.length] : event.key === 'ArrowLeft' ? tabs[(index - 1 + tabs.length) % tabs.length]
    : event.key === 'Home' ? tabs[0] : event.key === 'End' ? tabs.at(-1) : undefined;
  if (!target) return;
  event.preventDefault();
  rovingTabs(nav, target);
  target.focus();
  target.scrollIntoView({ block: 'nearest', inline: 'nearest' });
});
$('.inspector-tabs').addEventListener('focusout', event => {
  const nav = event.currentTarget as HTMLElement;
  if (!nav.contains(event.relatedTarget as Node | null)) rovingTabs(nav);
});
function renderInspectorTabs(pullLinked: boolean): void {
  const tabs = state.inspectorTab === 'file' ? inspectorTabs : openTab(inspectorTabs, state.inspectorTab);
  if (!sameTabs(tabs, inspectorTabs)) { inspectorTabs = tabs; saveTabs(localStorage, tabs); }
  const nav = $('.inspector-tabs'), add = nav.querySelector<HTMLElement>('.inspector-tab-add')!;
  const shown = tabs.open.filter(view => view !== 'pull' || pullLinked);
  const files = nav.querySelector<HTMLElement>(':scope>.file-panel-tab')!;
  files.hidden = !fileTabs.count;
  const items = [files, ...nav.querySelectorAll<HTMLElement>(':scope>.inspector-tab:not(.file-panel-tab)')];
  for (const item of items) {
    const view = item.dataset.view as PanelView, selected = view === state.inspectorTab;
    if (item !== files) {
      item.hidden = !shown.includes(view as InspectorView);
      item.querySelector<HTMLElement>('.inspector-tab-close')!.hidden = shown.length < 2;
    }
    const tab = item.querySelector<HTMLElement>('.inspector-tab-button')!;
    tab.classList.toggle('selected', selected);
    tab.setAttribute('aria-selected', String(selected));
  }
  rovingTabs(nav);
  // Move nodes only when the order changed, so a focused tab keeps focus.
  if (items.filter(item => !item.hidden && item !== files).map(item => item.dataset.view).join() !== shown.join()) for (const view of shown) nav.insertBefore(items.find(item => item.dataset.view === view)!, add);
  add.hidden = !closedViews(tabs, INSPECTOR_AVAILABLE.filter(view => view !== 'pull' || pullLinked)).length;
  revealSelectedTab();
}
function openInspectorView(view: InspectorView): void {
  const tab = document.querySelector<HTMLElement>(`.inspector-tab[data-view="${view}"] .inspector-tab-button`);
  if (tab) run(action(tab.dataset.action!, tab));
}
function closeInspectorTab(view: PanelView): void {
  if (view === 'file') {
    fileTabs.forget(state.sessionId);
    if (state.inspectorTab === 'file') state.inspectorTab = threadDefault(inspectorTabs);
    renderInspector();
    document.querySelector<HTMLElement>(`.inspector-tab[data-view="${state.inspectorTab}"] .inspector-tab-button`)?.focus();
    return;
  }
  const next = closeTab(inspectorTabs, view);
  if (next === inspectorTabs) return;
  const wasSelected = state.inspectorTab === view;
  inspectorTabs = next; saveTabs(localStorage, next);
  if (wasSelected) { ++fileRequest; state.inspectorTab = next.selected; state.selectedKind = ''; }
  renderInspector();
  if (wasSelected) document.querySelector<HTMLElement>(`.inspector-tab[data-view="${state.inspectorTab}"] .inspector-tab-button`)?.focus();
}
async function showInspectorViews(anchor: HTMLElement): Promise<void> {
  const pullLinked = Boolean(githubEnabled() && session()?.pullRequest);
  const views = closedViews(inspectorTabs, INSPECTOR_AVAILABLE.filter(view => view !== 'pull' || pullLinked));
  await showChoices(anchor, { title: 'Open view', width: 240, actions: true, items: views.map(view => ({ id: view, label: INSPECTOR_TITLES[view], icon: INSPECTOR_ICONS[view] })), onSelect: id => { closeChoiceMenu(); openInspectorView(id as InspectorView); } });
}
/** One Changes view lives while the Changes tab shows the same checkout, so folds, scroll and loaded diffs survive refreshes. */
let changesView: ChangesView | undefined, changesViewKey = '';
function disposeChangesView(): void { changesView?.dispose(); changesView = undefined; changesViewKey = ''; }
function showChangesView(target: HTMLElement, key: string): void {
  if (!changesView || changesViewKey !== key || !target.querySelector(':scope>.changes-view')) {
    disposeChangesView();
    const host = document.createElement('div');
    target.replaceChildren(host);
    const context = workspaceContext();
    changesView = mountChangesView(host, {
      loadDiff: (path, staged) => call<string>('git_diff', { ...context, path, staged }),
      stage: (paths, staged) => stage(paths, staged),
      commit: async message => { const result = await call<string>('git_commit', { ...context, message }); await refreshInspector(); notify(result || 'Changes committed'); },
      openFile: path => { state.inspectorTab = 'files'; run(openFile(path, 'file')); },
      refresh: () => run(refreshInspector()),
      notify, notifyError,
      choose: (anchor, title, items, onSelect) => void showChoices(anchor, { title, width: 260, actions: !items.some(item => item.selected !== undefined), items, onSelect: id => { closeChoiceMenu(); onSelect(id); } }),
      worktree: () => worktrees.openDialog(newTaskView() ? 'attach' : 'new'),
    });
    changesViewKey = key;
  }
  changesView.update(state.git, undefined);
}
/** Files tab rows, VS Code style: open folders list their children inline, indented by depth. */
function fileTree(files: FileEntry[], depth: number): string {
  return files.map(file => {
    const open = file.isDir && state.openFolders.has(file.path), path = escape(file.path);
    const row = `<div class="file-row" style="--depth:${depth}"><button data-action="${file.isDir ? 'toggle-file-folder' : isPreviewableFile(file.path) && !OPENS_IN_TAB.test(file.path) ? 'preview-file' : 'open-file'}" data-path="${path}"${file.isDir ? ` aria-expanded="${open}"` : ''}>${file.isDir ? icon('chevron', 'file-twisty') : '<span class="file-twisty"></span>'}${fileIcon(file.name, file.isDir)}<span>${escape(file.name)}</span></button>${!file.isDir && /\.(html?|svg)$/i.test(file.path) ? button('view-source', 'View source of ' + file.name, 'file', 'file-attach', `data-path="${path}"`) : ''}${!file.isDir ? button('attach-file', 'Attach ' + file.name, 'plus', 'file-attach', `data-path="${path}"`) : ''}</div>`;
    return row + (open ? fileTree(state.folderFiles.get(file.path) ?? [], depth + 1) : '');
  }).join('');
}
async function toggleFolder(path: string): Promise<void> {
  // The tree redraws from scratch, so keyboard focus returns to the folder row it was on.
  const render = () => {
    const focused = (document.activeElement as HTMLElement | null)?.dataset.path === path;
    renderInspector();
    if (focused) document.querySelector<HTMLElement>(`#inspector-content [data-action="toggle-file-folder"][data-path="${CSS.escape(path)}"]`)?.focus();
  };
  if (state.openFolders.delete(path)) { state.folderFiles.delete(path); render(); return; }
  state.openFolders.add(path); render();
  const key = workspaceKey();
  try {
    const files = await call<FileEntry[]>('list_files', { ...workspaceContext(), path });
    if (key === workspaceKey() && state.openFolders.has(path)) state.folderFiles.set(path, files);
  } catch (error) {
    if (key !== workspaceKey()) return;
    state.openFolders.delete(path); report(error);
  }
  render();
}
let inspectorDrawn = false, inspectorView: WorkspaceView | undefined;
/** Launch renders never move the inspector: it animates only after the first press or key, once the
 * palette's startup gate (`html[data-ready]`, palette.ts) has opened. */
let inspectorArmed = false;
const armInspector = () => { inspectorArmed = true; removeEventListener('pointerdown', armInspector, true); removeEventListener('keydown', armInspector, true); };
addEventListener('pointerdown', armInspector, true); addEventListener('keydown', armInspector, true);
function renderInspector(): void {
  const diffEpoch = ++inspectorDiffEpoch;
  inspectorDiff?.dispose(); inspectorDiff = undefined;
  // A shared channel has no checkout of its own, so the inspector steps aside.
  const visible = state.inspector && !inspectorSuppressed && !state.sharedChannelId;
  const inspector = $('#inspector');
  // Opening: the column appears at once and the panel slides in. Closing: the panel fades in its
  // column and the column snaps shut after (`inspector-closed`), so the thread never rewraps under a
  // fading panel. state.inspector is the source of truth meanwhile; the leaving panel is inert and
  // carries `data-leaving`. Nothing animates on the first, startup render.
  // A view switch (Conversation, Board, GitHub) changes the layout once: the inspector then opens or
  // closes at once with the view, never a fade and a second reflow after it.
  const workspace = $('.workspace'), animate = inspectorDrawn && inspectorArmed && document.documentElement.hasAttribute('data-ready') && inspectorView === state.view;
  if (visible) { showPanel(inspector, animate, ['browser', 'simulator', 'vm'].includes(state.inspectorTab)); workspace.classList.remove('inspector-closed'); }
  else hidePanel(inspector, animate, () => { if (inspector.hidden) workspace.classList.add('inspector-closed'); }, $('#inspector-toggle'));
  inspectorDrawn = true; inspectorView = state.view;
  $('#inspector-toggle').classList.toggle('active', visible);
  const pullTask = githubEnabled() && session()?.pullRequest ? session() : undefined;
  if (state.inspectorTab === 'pull' && !pullTask) { const shown = inspectorTabs.open.filter(view => view !== 'pull'); state.inspectorTab = shown.includes('changes') || !shown.length ? 'changes' : shown[0]; }
  if (state.inspectorTab === 'file' && !fileTabs.count) state.inspectorTab = threadDefault(inspectorTabs);
  renderInspectorTabs(Boolean(pullTask));
  const pullTab = $('.inspector-tabs').querySelector<HTMLButtonElement>('[data-action="tab-pull"]')!;
  if (pullTask) { pullTab.title = `Pull request #${pullTask.pullRequest!.number}`; pullTab.setAttribute('aria-label', `Pull request #${pullTask.pullRequest!.number}`); }
  const changeCount = state.git?.files.length ?? 0;
  $('.inspector-tabs [data-action="tab-changes"]').setAttribute('aria-label', changeCount ? `Changes, ${changeCount} changed ${changeCount === 1 ? 'file' : 'files'}` : 'Changes');
  $('#inspector-title').textContent = state.inspectorTab === 'file' ? 'Open files' : INSPECTOR_TITLES[state.inspectorTab];
  $('#changes-count').textContent = state.git?.files.length ? String(state.git.files.length) : '';
  const changesKey = `${state.projectId}\0${state.sessionId}\0${workspacePath()}`;
  const keepChanges = state.inspectorTab === 'changes' && !state.selectedKind && Boolean(project()) && !session()?.remoteDevice && !(state.jj?.isRepo && !state.jj.colocated) && changesViewKey === changesKey && (state.inspectorLoading || (!state.gitError && Boolean(state.git?.isRepo)));
  if (!keepChanges) disposeChangesView();
  syncBrowserPanel();
  syncSimulatorPanel();
  syncVmPanel();
  syncDesignPanel();
  const showFiles = state.inspectorTab === 'file';
  $('#file-panel').hidden = !showFiles;
  if (showFiles) { $('#inspector-content').hidden = true; $('#inspector-refresh').hidden = true; }
  if (showFiles || state.inspectorTab === 'browser' || state.inspectorTab === 'simulator' || state.inspectorTab === 'vm' || state.inspectorTab === 'design') { pullView.dispose(); return; }
  const target = $('#inspector-content');
  if (state.inspectorTab === 'pull' && pullTask && visible) { pullView.show(target, pullTask); return; }
  pullView.dispose();
  if (state.inspectorTab === 'btw' && visible) { btwPanel.show(target); return; }
  btwPanel.dispose();
  if (!project()) { target.innerHTML = '<div class="inspector-empty">Open a project to browse files and review changes.</div>'; return; }
  const remote = session()?.remoteDevice;
  if (remote) { $('#changes-count').textContent = ''; target.innerHTML = `<div class="inspector-empty">${icon('monitor')}<h3>Runs on ${escape(remote.name)}</h3><p>Its changes and files are on that computer, so review and commit them there.</p></div>`; return; }
  if (state.inspectorTab === 'search' && !state.selectedKind) { searchPanel.show(target); return; }
  // A refresh keeps the mounted Changes view on screen until the new status arrives.
  if (state.inspectorLoading && changesView) return;
  if (state.inspectorLoading) { target.innerHTML = `<div class="inspector-empty" role="status">${icon('refresh')}<p>${state.inspectorTab === 'changes' ? 'Loading changes…' : 'Loading files…'}</p></div>`; return; }
  const loadError = state.inspectorTab === 'changes' ? state.gitError : state.filesError;
  if (loadError) {
    // A project folder that was renamed or moved on disk can be relinked; worktree and chat folders cannot.
    const relocatable = loadError.startsWith('Project folder is unavailable') && !isChatProject(project());
    target.innerHTML = `<div class="inspector-empty" role="alert">${icon('alert')}<h3>${state.inspectorTab === 'changes' ? 'Unable to load changes' : 'Unable to read folder'}</h3><p>${escape(loadError)}</p><button class="secondary-button" data-action="refresh-inspector">${icon('refresh')}Retry</button>${relocatable ? `<button class="secondary-button" data-action="locate-project-folder">${icon('folder')}Locate folder…</button>` : ''}</div>`;
    target.querySelector('p')!.style.overflowWrap = 'anywhere';
    return;
  }
  if (state.selectedKind) {
    if (state.filePreviewLoading) { target.innerHTML = '<div class="inspector-empty" role="status">Loading file…</div>'; return; }
    target.innerHTML = `<div class="file-preview-header"><button data-action="back-inspector">${icon('chevron', 'rotate-180')} Back</button><div class="file-preview-actions">${isPreviewableFile(state.selectedFile) ? button('preview-selected-file', 'Preview in browser', 'globe') : ''}${button('copy-file', 'Copy file', 'copy')}${button('toggle-diff-stage', state.selectedStaged ? 'Unstage file' : 'Stage file', state.selectedStaged ? 'close' : 'plus')}</div></div><div class="file-preview-title">${icon('file')}<span title="${escape(state.selectedFile)}">${escape(state.selectedFile)}</span></div><div class="inspector-diff-host"></div>`;
    if (state.selectedKind === 'diff' && state.inspector) {
      const host = target.querySelector<HTMLElement>('.inspector-diff-host')!;
      const patch = state.selectedContent, path = state.selectedFile;
      host.innerHTML = '<p class="inspector-hint" role="status">Loading diff…</p>';
      // Mounted after the next paint: a thread switch restoring its file paints the thread first.
      void import('./diff-viewer').then(module => new Promise<typeof module>(resolve => requestAnimationFrame(() => setTimeout(() => resolve(module))))).then(({ mountDiffViewer }) => {
        if (diffEpoch !== inspectorDiffEpoch || !host.isConnected) return;
        inspectorDiff = mountDiffViewer(host, { patch, path, layout: 'unified', truncated: patch.includes('[Diff truncated') });
      }).catch(error => { if (host.isConnected && diffEpoch === inspectorDiffEpoch) host.textContent = errorText(error); });
    }
    return;
  }
  if (state.inspectorTab === 'files') {
    // Morphed once the tree is up, so a folder's chevron survives to turn.
    const tree = `<div class="file-folder-path"><span>${escape(project()?.name)}</span>${state.openFolders.size ? button('collapse-folders', 'Collapse folders', 'minimize') : ''}</div><div class="file-list">${fileTree(state.files, 0) || '<div class="inspector-empty">This folder is empty.</div>'}</div>`;
    if (target.querySelector(':scope>.file-list')) morph(target, tree); else target.innerHTML = tree;
    return;
  }
  if (state.jj?.isRepo && !state.jj.colocated) {
    showJjPanel(target, state.jj, {
      call, notify, notifyError, context: () => workspaceContext(), changed: status => { state.jj = status; },
      openDiff: (path, patch) => { selectedFileContext = workspaceContext(); state.selectedFile = path; state.selectedContent = patch; state.selectedKind = 'diff'; state.selectedStaged = false; state.filePreviewLoading = false; state.inspector = true; renderInspector(); },
    });
    return;
  }
  if (!state.git?.isRepo) { target.innerHTML = '<div class="inspector-empty">'+icon('branch')+'<h3>No Git repository</h3><p>Open a Git repository to review changes.</p></div>'; return; }
  showChangesView(target, changesKey);
}
async function openRunPreview(url: string, context: { projectId: string; sessionId?: string }): Promise<void> {
  const current = () => state.projectId === context.projectId && state.sessionId === (context.sessionId ?? '');
  if (!current()) return;
  state.inspector = true; state.inspectorTab = 'browser'; renderInspector();
  await browserLifecycle;
  if (!current() || !browserPanel) return;
  await browserPanel.navigate(url);
}
async function previewFile(path: string, context = workspaceContext(), active?: () => Promise<void>): Promise<void> {
  if (!context.projectId) return;
  const request = ++fileRequest, generation = state.generation;
  const file = await call<{ url: string; path: string; name: string }>('prepare_file_preview', { ...context, path });
  await active?.();
  // A slow filesystem lookup must not open a preview over a task selected meanwhile.
  if (request !== fileRequest || generation !== state.generation) return;
  state.inspector = true; state.inspectorTab = 'browser'; state.selectedKind = ''; renderInspector();
  await browserLifecycle;
  await active?.();
  if (request !== fileRequest || generation !== state.generation || !browserWanted) return;
  if (!browserPanel) throw new Error('Browser could not be opened.');
  await browserPanel.navigate(file.url);
}
async function openFile(path: string, kind: 'file' | 'diff', staged = false, context = workspaceContext(), source = false): Promise<void> {
  const p = project(); if (!p) return;
  // Files open as tabs in the inspector's Open files view beside their task's conversation.
  if (kind === 'file') {
    if (context.sessionId && context.sessionId !== state.sessionId) await selectSession(context.sessionId);
    if (context.sessionId && context.sessionId !== state.sessionId) return;
    if (state.view !== 'conversation' && !state.boardPanel) setWorkspaceView('conversation');
    fileTabs.open(path, context, source);
    ++fileRequest; inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'file'; state.selectedKind = ''; renderInspector(); return;
  }
  const request = ++fileRequest, generation = state.generation; const content = await call<string>('git_diff', { ...context, path, staged }); if (request !== fileRequest || p.id !== state.projectId || generation !== state.generation) return;
  selectedFileContext = { ...context };
  state.selectedFile = path; state.selectedContent = content; state.selectedKind = kind; state.selectedStaged = staged; state.filePreviewLoading = false; state.inspector = true; renderInspector();
}
function attachFile(path: string): void {
  if (!session()) { notify('Start a task before attaching files.'); return; }
  if (state.attachments.includes(path)) { notify('File already attached.'); return; }
  if (state.attachments.length >= 5) { notify('Attach up to 5 files per message.'); return; }
  state.attachments.push(path); renderComposer(); notify('Attached ' + path.split('/').pop());
}
async function stage(paths: string[], staged: boolean): Promise<void> {
  if (!project() || !paths.length) return;
  const generation = state.generation;
  await call('git_stage', { ...workspaceContext(), paths, staged });
  if (generation !== state.generation) return;
  state.selectedKind = ''; await refreshInspector();
}

let previousFocus: HTMLElement | null = null;
let wallpaperSettingsCleanup: (() => void) | undefined;
let changeReviewCleanup: (() => void) | undefined;
let providerSettingsCleanup: (() => void) | undefined;
let agentUsageCleanup: (() => void) | undefined;
let conversationImportCleanup: (() => void) | undefined;
let openCodeModelsCleanup: (() => void) | undefined;
let moodboardsCleanup: (() => void) | undefined;
let botsView: import('./bots').BotsView | undefined;
function disposeSettingsViews(): void {
  botsView?.dispose(); botsView = undefined;
  boardMentionPicker?.dispose(); boardMentionPicker = undefined;
  agentUsageCleanup?.(); agentUsageCleanup = undefined;
  conversationImportCleanup?.(); conversationImportCleanup = undefined;
  moodboardsCleanup?.(); moodboardsCleanup = undefined;
  providerSettingsCleanup?.(); providerSettingsCleanup = undefined;
  openCodeModelsCleanup?.(); openCodeModelsCleanup = undefined;
  changeReviewCleanup?.(); changeReviewCleanup = undefined;
  architectSetupCleanup?.(); architectSetupCleanup = undefined;
  wallpaperSettingsCleanup?.(); wallpaperSettingsCleanup = undefined;
}
function modal(title: string, body: string, cls = ''): HTMLDialogElement {
  disposeSettingsViews();
  closeMenus();
  openingProjectForTask = undefined;
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  if (!dialog.open) previousFocus = document.activeElement as HTMLElement;
  dialog.className = cls;
  dialog.setAttribute('aria-label', title);
  dialog.innerHTML = `<div class="dialog-heading"><div class="dialog-title"><h2>${escape(title)}</h2></div>${button('close-dialog', 'Close dialog', 'close')}</div>${body}`;
  // A long explanation moves behind an info mark beside the title; a short one stays as
  // a single line. The text remains in the DOM for assistive technology.
  const description = dialog.querySelector<HTMLElement>('.dialog-description');
  const explanation = description?.textContent?.trim() ?? '';
  if (description && explanation.length > LONG_DESCRIPTION) {
    description.classList.add('sr-only'); description.id ||= 'dialog-description';
    dialog.setAttribute('aria-describedby', description.id);
    dialog.querySelector('.dialog-title')!.insertAdjacentHTML('beforeend', infoMark(explanation, 'About this dialog'));
  } else dialog.removeAttribute('aria-describedby');
  // Static field hints join their label as a mark; live previews and alerts stay in place.
  for (const help of dialog.querySelectorAll<HTMLElement>('.field-help:not([role]):not([data-live]):not([hidden])')) {
    const hint = help.textContent?.trim() ?? '';
    let label = help.previousElementSibling;
    while (label && !label.classList.contains('field-label')) label = label.previousElementSibling;
    if (!hint || !label) continue;
    // The mark sits beside the label, not inside it, so the field's name stays clean.
    help.classList.add('sr-only');
    const row = document.createElement('div'); row.className = 'field-label-row';
    label.replaceWith(row); row.append(label); row.insertAdjacentHTML('beforeend', infoMark(hint));
  }
  if (!dialog.open) dialog.showModal();
  dialog.querySelector<HTMLElement>('input, select, textarea')?.focus();
  return dialog;
}
const LONG_DESCRIPTION = 90;
// Close before disposing so the departing dialog still shows its content while it fades.
function closeModal(): void { closeMenus(); const dialog = document.querySelector<HTMLDialogElement>('#dialog')!; dialog.close(); disposeSettingsViews(); openingProjectForTask = undefined; previousFocus?.focus(); }
async function showTurnDiff(element: HTMLElement): Promise<void> {
  const request = changeRequest(element); if (!request) return;
  await openSavedDiff(request.sessionId, request.changes, request.path);
}
async function openSavedDiff(sessionId: string, changes: TurnChanges, path?: string): Promise<void> {
  const dialog = modal('Changed files', '<div id="change-review-host"><p role="status">Loading diff viewer…</p></div>', 'change-review-dialog');
  const host = dialog.querySelector<HTMLElement>('#change-review-host')!;
  try {
    const { mountChangeReview } = await import('./change-review');
    if (!dialog.open || !host.isConnected) return;
    // A merged card's footer: each run's diff comes from its own snapshot, and Jev reviews the run in view.
    if (isCombined(changes)) {
      changeReviewCleanup = mountCombinedReview(host, sessionId, changes, (changeId, file) => call<TurnChangeDiff>('turn_change_diff', { sessionId, changeId, path: file }), path, jevDecisionsEnabled ? snapshot => run(openJevAssist('review', sessionId, snapshot)) : undefined);
      return;
    }
    changeReviewCleanup = mountChangeReview(host, sessionId, changes, path, jevDecisionsEnabled ? () => run(openJevAssist('review', sessionId, changes)) : undefined);
  } catch (error) {
    if (dialog.open && host.isConnected) host.innerHTML = `<p role="alert">Unable to load the diff viewer. Close this window and try again. ${escape(errorText(error))}</p>`;
  }
}
function showOpenProject(forTask = false): void {
  modal('Open project', `<form id="open-project-form"><label class="field-label" for="project-folder">Project folder</label><input id="project-folder" name="path" placeholder="/Users/you/Projects/my-app" autocomplete="off" spellcheck="false" required><p class="field-help">Enter a full path or choose Browse.</p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="browse-project">${icon('folder')}Browse…</button><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button">Open project</button></div></form>`);
  if (forTask && newTaskView()) openingProjectForTask = { id: state.sessionId, generation: state.generation };
}
async function changeTaskProject(projectId: string): Promise<void> {
  const selected = session();
  if (!selected || !newTaskView() || configuringSessions.has(selected.id)) throw new Error('A project can only be changed before starting the task.');
  if (selected.worktreePath && selected.projectId !== projectId) throw new Error('A worktree task stays with its original project. Start a new task to use another project.');
  if (selected.projectId === projectId) { document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(); return; }
  const generation = state.generation;
  configuringSessions.add(selected.id);
  try {
    const updated = await call<Session>('configure_session', { sessionId: selected.id, provider: selected.provider, model: selected.model, projectId });
    const index = state.sessions.findIndex(s => s.id === selected.id); if (index >= 0) state.sessions[index] = updated;
    if (chatTask(selected)) await forgetChat(selected.projectId);
    if (selected.id !== state.sessionId) { renderNavigation(); return; }
    // The user may have left and reselected this task while the write ran.
    // Reload its new project before permitting any file or composer action.
    if (generation !== state.generation) { await selectSession(selected.id, true); return; }
    const currentGeneration = ++state.generation;
    const hadAttachments = state.attachments.length > 0;
    state.attachments = [];
    activateProject(updated.projectId);
    if (state.projectFilter && state.projectFilter !== updated.projectId) setProjectFilter(updated.projectId);
    render();
    document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
    terminalPanel.minimize();
    if (currentGeneration !== state.generation) return;
    await refreshInspector();
    if (hadAttachments) notify('Attachments cleared for the new project.');
  } finally { configuringSessions.delete(selected.id); }
}
async function showProjectPicker(anchor: HTMLElement): Promise<void> {
  if (pendingMenuOpen?.anchor === anchor) { cancelPendingMenu(); return; }
  if (projectPickerCleanup) { closeProjectPicker(); return; }
  const selected = session(); if (!selected || selected.worktreePath || !newTaskView() || configuringSessions.has(selected.id)) return;
  closeModelPicker();
  closeChoiceMenu();
  const { epoch, release } = beginMenuOpen(anchor);
  const generation = state.generation;
  const { openProjectPicker } = await import('./project-picker').finally(release);
  if (epoch !== menuEpoch || projectPickerCleanup || !anchor.isConnected || selected.id !== state.sessionId || generation !== state.generation || !newTaskView()) return;
  projectPickerCleanup = openProjectPicker({
    anchor, projects: [{ id: NO_PROJECT, name: 'No project', path: 'Chat in its own folder' }, ...userProjects()], currentProjectId: chatTask(selected) ? NO_PROJECT : selected.projectId,
    onClose: () => { projectPickerCleanup = undefined; },
    onSelect: async projectId => {
      if (selected.id !== state.sessionId || generation !== state.generation) throw new Error('Select the task again to change its project.');
      // createChat closes this picker, which would drop an error thrown back to it.
      if (projectId === NO_PROJECT) { if (!chatTask(selected)) await createChat(selected).catch(report); return; }
      await changeTaskProject(projectId);
    },
    onNewProject: () => { if (selected.id === state.sessionId && generation === state.generation) showOpenProject(true); },
  });
}
/** One line for the picker: the lead's model, then the worker count. */
function pickerTeamDetail(profile: TeamLibrary['profiles'][number]): string {
  const { architect, config } = profile.setup;
  const lead = provider(architect.provider)?.models.find(model => model.id === architect.model)?.name ?? (architect.model && architect.model !== 'default' ? architect.model : `${provider(architect.provider)?.name ?? architect.provider} default`);
  return `${lead} · ${config.workers.length} ${config.workers.length === 1 ? 'worker' : 'workers'}`;
}
/** `target`: the task whose composer holds `anchor` (the open thread's, or the By the way panel's side thread). */
async function showModel(anchor: HTMLElement, target = session()): Promise<void> {
  // A New task under way is about to replace this composer: opening now would act on the task it leaves, and its arrival would close the picker.
  if (taskCreation && !anchor.closest('.btw-panel')) {
    await taskCreation;
    anchor = document.querySelector<HTMLElement>('#model-picker-trigger') ?? anchor;
    target = session();
  }
  if (pendingMenuOpen?.anchor === anchor) { cancelPendingMenu(); return; }
  if (modelPickerCleanup) { closeModelPicker(); return; }
  const selected = target; if (!selected || configuringSessions.has(selected.id)) return;
  // A side thread's picker acts on the side thread only, and only while the panel still shows it.
  const inPanel = selected.id !== state.sessionId, current = () => inPanel ? (btwSideTask() ?? btwDraftTask())?.id === selected.id : selected.id === state.sessionId;
  if (teams.get(selected.id) && !selected.remoteDevice && !teams.get(selected.id)?.config.auto) { await showArchitectSetup(anchor); return; }
  const botNext = !inPanel && Boolean(botForThread());
  if (isRunning(selected.id) && !botNext) return;
  closeProjectPicker();
  closeChoiceMenu();
  const { epoch, release } = beginMenuOpen(anchor);
  const generation = state.generation;
  const [{ openModelPicker }, library] = await Promise.all([import('./model-picker'), call<TeamLibrary>('architect_profiles').catch(() => null), call<import('./connections').ConnectionSnapshot>('connections_list').then(snapshot => { namedConnections = snapshot; }).catch(() => undefined)]).finally(release);
  if (epoch !== menuEpoch || modelPickerCleanup || !anchor.isConnected || !current() || generation !== state.generation || (isRunning(selected.id) && !botNext)) return;
  const device = inPanel ? undefined : composerDevice();
  // A side thread not created yet has no team to configure.
  const named = library && !device && !isBtwDraft(selected) ? namedTeams(library) : [];
  modelPickerCleanup = openModelPicker({
    teams: named.map(profile => ({ id: profile.id, name: profile.name, detail: pickerTeamDetail(profile), provider: profile.setup.architect.provider, roster: [profile.setup.architect.provider, ...profile.setup.config.workers.map(worker => worker.provider)], selected: isTeam(teams.get(selected.id)?.config, profile) })),
    onTeamSelect: async id => {
      const profile = named.find(team => team.id === id);
      if (!profile) throw new Error('This agent team no longer exists.');
      if (!current() || generation !== state.generation || isRunning(selected.id)) throw new Error('Select the task again to change its model.');
      configuringSessions.add(selected.id);
      try {
        const saved = await call<TeamSnapshot | null>('architect_configure', { sessionId: selected.id, config: profile.setup.config, architect: profile.setup.architect, profileId: profile.id });
        onArchitect(saved ?? { sessionId: selected.id, removed: true });
        await reloadSessions();
        if (inPanel) btwPanel.refresh(); else if (selected.id === state.sessionId) { renderComposer(); renderHeader(); }
      } finally { configuringSessions.delete(selected.id); }
    },
    anchor, providers: device ? [] : state.providers, current: { provider: selected.provider, model: selected.model || 'default', reasoningEffort: selected.reasoningEffort ?? null, contextUsage: selected.contextUsage },
    canSwitchProvider: true,
    loadModels: device ? id => remoteModels(device, id) : loadModels, loadProviders: device ? () => remoteProviders(device) : undefined,
    recent: device ? undefined : recentModels, onClose: () => { modelPickerCleanup = undefined; },
    onEffortSelect: async reasoningEffort => {
      if (!current() || generation !== state.generation || isRunning(selected.id)) throw new Error('Select the task again to change its reasoning effort.');
      if (isBtwDraft(selected)) { saveBtwDraft(selected, { reasoningEffort }); return; }
      configuringSessions.add(selected.id);
      try {
        const updated = await call<Session>('set_reasoning_effort', { sessionId: selected.id, reasoningEffort });
        const index = state.sessions.findIndex(s => s.id === selected.id); if (index >= 0) state.sessions[index] = updated;
        if (inPanel) btwPanel.refresh();
        else if (selected.id === state.sessionId) {
          refreshModelLabels();
          syncOverlayContext({ projectId: updated.projectId, provider: updated.provider, model: updated.model || 'default', mode: updated.mode, reasoningEffort: updated.reasoningEffort ?? null });
        }
      } finally { configuringSessions.delete(selected.id); }
    },
    onSelect: async (providerId, model) => {
      if (botNext && isRunning(selected.id) && current()) {
        const changed = providerId !== selected.provider || (model || 'default') !== (selected.model || 'default');
        botThread.setNextModel(selected.id, changed ? { provider: providerId, model, label: model && model !== 'default' ? model : provider(providerId)?.name ?? providerId } : undefined);
        renderHeader(); return;
      }
      if (!current() || generation !== state.generation || isRunning(selected.id)) throw new Error('Select the task again to change its model.');
      if (isBtwDraft(selected)) { saveBtwDraft(selected, { provider: providerId, model, reasoningEffort: null }); return; }
      configuringSessions.add(selected.id);
      try {
        // A plain model leaves a named team; ZCode only supports single-agent tasks.
        if (teams.get(selected.id)?.config.rosterOnly || (providerId === 'zcode' && teams.has(selected.id))) {
          await call<TeamSnapshot | null>('architect_configure', { sessionId: selected.id, config: null, architect: null, profileId: null });
          onArchitect({ sessionId: selected.id, removed: true });
        }
        // An automatic team keeps its limits but learns about newly installed models.
        const auto = teams.get(selected.id)?.config;
        if (auto?.auto && !auto.rosterOnly) {
          const saved = await call<TeamSnapshot | null>('architect_configure', { sessionId: selected.id, config: await autoTeamConfig(auto), architect: null, profileId: null });
          onArchitect(saved ?? { sessionId: selected.id, removed: true });
        }
        const updated = await call<Session>('configure_session', { sessionId: selected.id, provider: providerId, model });
        const index = state.sessions.findIndex(s => s.id === selected.id); if (index >= 0) state.sessions[index] = updated;
        // Same-harness model choices keep the account and its resumable conversation.
        if (!device && providerId !== selected.provider && namedConnections.tasks[selected.id]) namedConnections = await call('connection_assign', { sessionId: selected.id, connectionId: null });
        if (!device) {
          if (!localStorage.getItem('pandacode.defaultProvider')) state.defaultProvider = providerId;
          localStorage.setItem('pandacode.provider', providerId); localStorage.setItem('pandacode.model.' + providerId, model);
        } else localChoice = undefined;
        if (inPanel) { if (current()) btwPanel.harnessChanged(); }
        else if (selected.id === state.sessionId && generation === state.generation) {
          if (providerId !== selected.provider) {
            // The harness change is already durable; a transcript refresh error
            // must not report the selection itself as failed or restore stale controls.
            try {
              const page = await latestMessagePage(selected.id);
              if (selected.id !== state.sessionId || generation !== state.generation) return;
              setMessagePage(page);
            } catch {
              if (selected.id !== state.sessionId || generation !== state.generation) return;
              notify('Harness changed. Reopen this task to refresh its conversation.');
            }
          }
          renderComposer(); renderHeader(); renderNavigation(); renderTranscript();
          document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
        }
      } finally { configuringSessions.delete(selected.id); }
    },
  });
}
/** Deploy: pick a connected platform, then a new task in this project ships it end to end. */
async function showDeploy(anchor: HTMLElement): Promise<void> {
  if (!project() || chatTask(session())) { notify('Open a project to deploy it.'); return; }
  const [{ deployItems, deployBrief }, connections] = await Promise.all([import('./deploy'), call<import('./cloud-settings').CloudConnection[]>('cloud_connections').catch(() => [])]);
  await showChoices(anchor, { title: 'Deploy', width: 300, actions: true, items: deployItems(connections), onSelect: async id => {
    closeChoiceMenu();
    const projectId = state.projectId;
    await createTask(projectId);
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
    if (!prompt || state.projectId !== projectId) return;
    prompt.value = deployBrief(id as import('./deploy').DeployTarget);
    await send();
  } });
}
/** Settles once every New task under way has opened its thread (it waits for boot first, then for the session). */
let taskCreation: Promise<unknown> | undefined;
function createTask(projectId = state.projectId): Promise<void> {
  const run = startTask(projectId);
  const tracked: Promise<unknown> = Promise.allSettled([taskCreation, run]).finally(() => { if (taskCreation === tracked) taskCreation = undefined; });
  taskCreation = tracked;
  return run;
}
async function startTask(projectId: string): Promise<void> {
  if (bootPending) await bootPending.catch(() => undefined);
  if (creatingTask) return;
  const projects = state.projects.filter(p => !isChatProject(p));
  const active = projects.find(p => p.id === projectId)
    ?? projects.find(p => p.id === localStorage.getItem('pandacode.project')) ?? userProjects()[0];
  if (!active) { notify('Open a project to start a task.'); return; }
  closeModelPicker();
  closeProjectPicker();
  const generation = state.generation;
  const harness = state.providers.find(p => p.id === state.defaultProvider && p.installed)
    ?? state.providers.find(p => p.installed) ?? state.providers[0];
  if (!harness) { notify('Open Settings to check your installed agents.'); return; }
  // An untouched draft is replaced so current defaults apply. Coming from elsewhere, a kept draft
  // (typed text or a worktree) is reopened; from inside one, New task starts another.
  const current = state.sessionId;
  leaveDraft('');
  // A settled draft (its worktree removed) is never reopened.
  const existing = state.sessions.find(task => task.draft && task.id !== current && task.projectId === active.id && !deletedSessions.has(task.id) && taskStage(task) !== 'completed');
  if (existing) { state.query = ''; closeModal(); await selectSession(existing.id, true); return; }
  creatingTask = true;
  let created: Session;
  try {
    created = await call<Session>('create_session', { projectId: active.id, provider: harness.id, model: rememberedModel(harness.id), mode: 'full', draft: true });
  } finally { creatingTask = false; }
  state.sessions.unshift(created);
  if (generation !== state.generation) { renderNavigation(); return; }
  state.query = ''; closeModal(); await selectSession(created.id, true);
}
/** A projectless chat: its own folder, the usual harness and model. `from` is a New task moved to No project:
 *  the chat takes over its choices, typed text and attachments, so the draft is left empty and discarded on the way out. */
async function createChat(from?: Session): Promise<void> {
  if (creatingTask) return;
  closeModelPicker(); closeProjectPicker();
  const generation = state.generation;
  // A chat nobody has written in yet is reopened, as New task reopens its draft.
  const unused = from ? undefined : state.sessions.find(task => chatTask(task) && task.lastPromptAt == null && !task.resumeId && !task.archived && !deletedSessions.has(task.id) && taskStage(task) !== 'completed');
  if (unused) {
    if (state.projectFilter) setProjectFilter('');
    state.query = ''; closeModal(); await selectSession(unused.id, true); return;
  }
  const harness = state.providers.find(p => p.id === state.defaultProvider && p.installed)
    ?? state.providers.find(p => p.installed) ?? state.providers[0];
  if (!harness) { notify('Open Settings to check your installed agents.'); return; }
  if (!from) leaveDraft('');
  creatingTask = true;
  let created: Session;
  try {
    created = await call<Session>('chat_create', from ? { provider: from.provider, model: from.model, mode: from.mode } : { provider: harness.id, model: rememberedModel(harness.id), mode: 'full' });
    if (from?.reasoningEffort) created = await call<Session>('set_reasoning_effort', { sessionId: created.id, reasoningEffort: from.reasoningEffort });
    // Fresh pooled conversations choose their own account when the native run starts.
    const pooled = from && (from.provider === 'claude' || from.provider === 'codex') && namedConnections.pools?.includes(from.provider);
    const connection = from && !pooled && taskConnection(from)?.id;
    if (connection) namedConnections = await call<typeof namedConnections>('connection_assign', { sessionId: created.id, connectionId: connection });
    state.projects = await call<Project[]>('list_projects');
  } finally { creatingTask = false; }
  // chat_create announces the new row, so the refresh may already have listed it.
  upsertSession(created);
  if (from) {
    const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'), open = prompt?.dataset.sessionId === from.id;
    const typed = open ? prompt!.value : state.drafts.get(from.id) ?? '';
    if (typed) state.drafts.set(created.id, typed);
    state.drafts.delete(from.id);
    if (open) prompt!.value = '';
    attachments.restore(created.id, attachments.list(from.id)); attachments.clear(from.id);
    const browserItems = state.browserAttachments.get(from.id);
    if (browserItems?.length) state.browserAttachments.set(created.id, browserItems);
    state.browserAttachments.delete(from.id);
    // Project files and moodboards belong to the project, so a chat cannot send them.
    if ((from.id === state.sessionId && state.attachments.length) || state.moodboardAttachments.get(from.id)?.length) notify('Project files and moodboards stay with the project, so they were not moved to the chat.');
    state.moodboardAttachments.delete(from.id);
  }
  if (generation !== state.generation) { renderNavigation(); return; }
  if (state.projectFilter) setProjectFilter('');
  state.query = ''; closeModal(); await selectSession(created.id, true);
}
/** Drops a chat's hidden project (and its empty folder) once no task uses it. */
async function forgetChat(projectId: string): Promise<void> {
  if (await call<boolean>('chat_cleanup', { projectId }).catch(() => false)) state.projects = state.projects.filter(p => p.id !== projectId);
}
type ChoiceOptions = Omit<Parameters<typeof import('./choice-menu').openChoiceMenu>[0], 'anchor' | 'onClose'> & { afterClose?: () => void };
async function showChoices(anchor: HTMLElement, options: ChoiceOptions): Promise<void> {
  // A second click on the trigger closes its menu; a right-click (a point) moves it there instead.
  if (!options.point && pendingMenuOpen?.anchor === anchor) { cancelPendingMenu(); return; }
  if (!options.point && choiceMenuCleanup && choiceMenuAnchor === anchor) { closeChoiceMenu(); return; }
  closeMenus();
  const { epoch, release } = beginMenuOpen(anchor);
  const generation = state.generation;
  const { openChoiceMenu } = await import('./choice-menu').finally(release);
  if (epoch !== menuEpoch || generation !== state.generation || !anchor.isConnected) return;
  choiceMenuAnchor = anchor;
  choiceMenuCleanup = openChoiceMenu({ ...options, anchor, onClose: () => {
    choiceMenuCleanup = undefined; choiceMenuAnchor = undefined;
    if (anchor.closest('#sidebar-bots-panel')) window.setTimeout(() => { if (botsListPendingRender) renderBots(); }, 0);
    options.afterClose?.();
  } });
}
async function showMode(anchor: HTMLElement, target = session()): Promise<void> {
  const s = target; if (!s || isRunning(s.id) || configuringSessions.has(s.id)) return;
  const generation = state.generation, inPanel = s.id !== state.sessionId;
  const current = () => inPanel ? (btwSideTask() ?? btwDraftTask())?.id === s.id : s.id === state.sessionId;
  const modes = approvalModes(s.provider, s.mode);
  await showChoices(anchor, { title: 'Permissions', width: 320, items: modes.map(mode => ({ ...mode, leading: toned(icon(mode.icon), MODE_TONES[mode.id]), selected: s.mode === mode.id })), onSelect: async id => {
    if (!current() || generation !== state.generation || isRunning(s.id) || configuringSessions.has(s.id)) throw new Error('Select the task again to change its permissions.');
    const chosen = modes.find(mode => mode.id === id); if (!chosen) throw new Error('Choose an available approval behavior.');
    if (isBtwDraft(s)) { saveBtwDraft(s, { mode: id as Mode }); return; }
    configuringSessions.add(s.id);
    try {
      await call('update_session', { sessionId: s.id, mode: id as Mode });
      const saved = state.sessions.find(item => item.id === s.id); if (saved) saved.mode = id as Mode;
      if (inPanel) btwPanel.refresh();
      else if (s.id === state.sessionId) {
        if (saved) syncOverlayContext({ projectId: saved.projectId, provider: saved.provider, model: saved.model || 'default', mode: saved.mode, reasoningEffort: saved.reasoningEffort ?? null });
        const trigger = document.querySelector<HTMLElement>('#mode-picker-trigger');
        if (trigger) {
          trigger.innerHTML = modeFaceHtml(chosen);
          trigger.dataset.mode = chosen.id; trigger.dataset.tip = modeTip(chosen); trigger.setAttribute('aria-label', modeName(chosen)); trigger.setAttribute('aria-description', chosen.description);
          trayStateChanged();
        }
      }
    } finally { configuringSessions.delete(s.id); }
  } });
}
async function showTaskMenu(anchor: HTMLElement): Promise<void> {
  const s = session(); if (!s) { await createTask(); return; }
  const generation = state.generation;
  await showChoices(anchor, { title: 'Task actions', actions: true, items: [
    { id: 'pin-task', label: s.pinned ? 'Unpin task' : 'Pin task', icon: 'pin', disabled: orderingBusy },
    { id: 'rename', label: 'Rename task', icon: 'edit' },
    { id: 'jev-tests', label: 'Browser tests with Jev', icon: 'spark' },
    ...jevDecisionsEnabled ? [{ id: 'jev-assist', label: 'Jev assistance', icon: 'spark' }] : [],
    taskStage(s) === 'completed' ? { id: 'board-reopen', label: 'Reopen task', icon: 'undo' } : { id: 'board-complete', label: 'Settle task', icon: 'check', disabled: isRunning(s.id) || configuringSessions.has(s.id) },
    ...s.provider === 'codex' ? [{ id: 'goal', label: 'Manage goal', icon: 'spark' }, { id: 'jobs', label: 'Background commands', icon: 'terminal' }, { id: 'usage', label: 'Codex usage', icon: 'activity' }] : [],
    { id: 'harness-console', label: 'Open harness console', icon: 'terminal' },
    { id: 'copy-path', label: s.worktreePath ? 'Copy worktree path' : 'Copy project path', icon: 'copy' },
    ...s.worktreePath ? [] : [{ id: 'worktree', label: newTaskView() ? 'Work in a new worktree…' : 'New task in a worktree…', icon: 'worktree' }],
    { id: 'delete-task', label: 'Delete task…', icon: 'trash', danger: true, disabled: isRunning(s.id) || configuringSessions.has(s.id) || finishingStreams.has(s.id), description: isRunning(s.id) ? 'Stop the agent before deleting this task.' : undefined },
  ], onSelect: id => {
    if (s.id !== state.sessionId || generation !== state.generation) return;
    closeChoiceMenu(); run(action(id, anchor));
  } });
}
async function pinTask(id: string): Promise<void> {
  const task = state.sessions.find(item => item.id === id);
  if (!task || orderingBusy) return;
  orderingBusy = true; $('#navigation').setAttribute('aria-busy', 'true');
  try {
    const saved = await call<Session>('pin_session', { sessionId: id, pinned: !task.pinned });
    const current = state.sessions.find(item => item.id === id);
    if (current) { current.pinned = saved.pinned; current.sidebarOrder = saved.sidebarOrder; }
    notify(saved.pinned ? 'Task pinned' : 'Task unpinned', saved.pinned ? undefined : () => run(pinTask(id)));
  } finally { orderingBusy = false; renderNavigation(); }
}
async function reorderThreads(ids: string[], focus: string): Promise<void> {
  if (orderingBusy || ids.length < 2) return;
  const generation = state.generation;
  orderingBusy = true; $('#navigation').setAttribute('aria-busy', 'true');
  // Keep navigation metadata separate from provider/stream state changed during IPC.
  try {
    const saved = await call<Session[]>('reorder_sessions', { sessionIds: ids });
    const ranks = new Map(saved.map(task => [task.id, task.sidebarOrder]));
    for (const task of state.sessions) if (ranks.has(task.id)) task.sidebarOrder = ranks.get(task.id);
  } finally {
    const restoreFocus = document.activeElement === document.body && generation === state.generation;
    orderingBusy = false; renderNavigation();
    if (restoreFocus) {
      $('#navigation').querySelector<HTMLElement>(`.task-item[data-id="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
    }
  }
}
/** Row buttons and the row menu act on any sidebar task, not only the open one. */
function sidebarTaskAction(kind: 'complete' | 'reopen' | 'delete', id: string): void {
  const task = state.sessions.find(item => item.id === id); if (!task) return;
  const current = () => state.sessions.find(item => item.id === id);
  if (kind === 'delete') showDeleteTask(task);
  else {
    // Undo puts back exactly what settling took away: the stage and the unread mark.
    const before = taskStage(task), unread = unreviewed?.has(id) ?? false;
    run(changeTaskStage(task, kind === 'complete' ? 'completed' : 'review').then(() => {
      const saved = current();
      if (kind === 'complete' && saved && taskStage(saved) === 'completed') notify('Task settled', () => {
        const again = current(); if (!again) return;
        run(changeTaskStage(again, before).then(() => {
          if (!unread || id === state.sessionId) return;
          (unreviewed ??= readCollapsed(localStorage, UNREVIEWED_KEY)).add(id); saveUnreviewed(); renderNavigation();
        }));
      });
    }));
  }
}
async function showSidebarTaskMenu(anchor: HTMLElement, point?: { x: number; y: number }): Promise<void> {
  const id = anchor.dataset.id!, task = state.sessions.find(item => item.id === id);
  if (!task) return;
  const ids = threadGroupRows(anchor).map(row => row.dataset.id!), index = ids.indexOf(id);
  const group = anchor.closest<HTMLElement>('[data-thread-group]')?.dataset.threadGroup ?? '';
  // Active and Settled keep their own order: no Move up/down there.
  const movable = !['active', 'completed'].includes(group);
  const fixed = anchor.dataset.reorderable !== 'true', busy = isRunning(id) || configuringSessions.has(id), done = taskStage(task) === 'completed';
  const unread = unreviewed?.has(id) ?? false, path = task.worktreePath ?? state.projects.find(p => p.id === task.projectId)?.path ?? '';
  const branch = task.worktreeBranch ?? '';
  await showChoices(anchor, { title: 'Task actions', point, actions: true, width: 280, items: [
    { id: 'pin', label: task.pinned ? 'Unpin task' : 'Pin task', icon: 'pin', disabled: orderingBusy },
    ...movable ? [
      { id: 'up', label: 'Move up', icon: 'arrow', disabled: fixed || orderingBusy || index < 1 },
      { id: 'down', label: 'Move down', leading: icon('arrow', 'icon-down'), disabled: fixed || orderingBusy || index === ids.length - 1 },
    ] : [],
    ...id === state.sessionId || tiles.has(id) ? [] : [{ id: 'beside', label: 'Open beside', icon: 'panel', separator: true }],
    { id: 'rename', label: 'Rename…', icon: 'edit', separator: id === state.sessionId || tiles.has(id) },
    ...task.archived ? [] : [{ id: 'wake', label: 'Schedule a wake-up…', icon: 'clock' }],
    ...id === state.sessionId ? [] : [{ id: 'unread', label: unread ? 'Mark as read' : 'Mark as unread', icon: 'chat' }],
    ...branch && !task.archived && !task.remoteDevice ? [{ id: 'branch-task', label: `New task from ${branch}…`, icon: 'worktree' }] : [],
    ...branch ? [{ id: 'copy-branch', label: 'Copy branch name', icon: 'copy', separator: true }] : [],
    ...path ? [{ id: 'copy-path', label: task.worktreePath ? 'Copy worktree path' : 'Copy project path', icon: 'copy', separator: !branch }] : [],
    { id: 'copy-id', label: 'Copy task ID', icon: 'copy', separator: !branch && !path },
    { id: 'stage', label: done ? 'Reopen' : 'Settle', icon: done ? 'undo' : 'check', disabled: busy, separator: true },
    { id: 'delete', label: 'Delete task…', icon: 'trash', danger: true, disabled: busy || finishingStreams.has(id), description: isRunning(id) ? 'Stop the agent before deleting this task.' : undefined },
  ], onSelect: async choice => {
    closeChoiceMenu();
    if (choice === 'beside') { tiles.open(id); return; }
    if (choice === 'pin') { run(pinTask(id)); return; }
    if (choice === 'wake') { openWakeComposer(anchor.isConnected ? anchor : $('#navigation'), id); return; }
    if (choice === 'stage' || choice === 'delete') { sidebarTaskAction(choice === 'stage' ? done ? 'reopen' : 'complete' : choice, id); return; }
    // Renames the row's task in place; the open thread stays open.
    if (choice === 'rename') { showRename(task); return; }
    if (choice === 'branch-task') { await selectSession(id); worktrees.openDialog('new'); return; }
    if (choice === 'unread') {
      const seen = unreviewed ??= readCollapsed(localStorage, UNREVIEWED_KEY);
      if (unread) seen.delete(id); else seen.add(id);
      saveUnreviewed(); renderNavigation(); return;
    }
    if (choice === 'copy-branch' || choice === 'copy-path' || choice === 'copy-id') {
      await navigator.clipboard.writeText(choice === 'copy-branch' ? branch : choice === 'copy-path' ? path : id);
      notify(choice === 'copy-branch' ? 'Branch name copied' : choice === 'copy-path' ? 'Path copied' : 'Task ID copied'); return;
    }
    // Resolve the current list after an agent activity change or project filter.
    const row = $('#navigation').querySelector<HTMLElement>(`.task-item[data-id="${CSS.escape(id)}"]`);
    if (!row) return;
    const current = threadGroupRows(row).map(item => item.dataset.id!), from = current.indexOf(id);
    const to = from + (choice === 'up' ? -1 : 1);
    if (from >= 0 && to >= 0 && to < current.length) {
      [current[from], current[to]] = [current[to], current[from]];
      run(reorderThreads(current, id));
    }
  } });
}
/** A folder's menu (… or right-click): new task, collapse the others, reveal, remove. */
async function showFolderMenu(heading: HTMLElement, point?: { x: number; y: number }): Promise<void> {
  const id = heading.dataset.project!, project = state.projects.find(p => p.id === id);
  if (!project) return;
  const anchor = heading.parentElement?.querySelector<HTMLElement>('.folder-actions') ?? heading;
  await showChoices(anchor, { title: 'Project actions', point, actions: true, width: 280, items: [
    { id: 'new', label: 'New task', icon: 'plus' },
    { id: 'collapse', label: 'Collapse other projects', icon: 'folder' },
    { id: 'reveal', label: REVEAL_LABEL, icon: 'folder', separator: true },
    { id: 'remove', label: 'Remove project…', icon: 'trash', danger: true, separator: true },
  ], onSelect: async choice => {
    closeChoiceMenu();
    if (choice === 'new') { await createTask(id); return; }
    if (choice === 'reveal') { await call('reveal_path', { path: project.path }); return; }
    if (choice === 'remove') { showRemoveProject(project); return; }
    for (const other of userProjects()) if (other.id !== id) state.collapsedFolders.add(other.id);
    state.collapsedFolders.delete(id); saveCollapsedFolders(); renderNavigation();
  } });
}
function showRemoveProject(project: Project): void {
  modal(`Remove ${project.name}?`, `<form id="remove-project-form" data-project-id="${escape(project.id)}"><p class="dialog-description">Its tasks are removed from PandaCode. The folder stays on disk.</p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button danger">Remove project</button></div></form>`, 'compact-dialog');
}
/** Projects: Manual. Saves the dragged folder order; projects not in it lead, newest first. */
function reorderFolders(ids: string[], focus: string): void {
  projectOrder = [...ids, ...projectOrder.filter(id => !ids.includes(id))];
  try { localStorage.setItem(PROJECT_ORDER_KEY, JSON.stringify(projectOrder)); } catch { /* per-launch preference only */ }
  renderNavigation();
  $('#navigation').querySelector<HTMLElement>(`.folder-heading[data-project="${CSS.escape(focus)}"]`)?.focus({ preventScroll: true });
}
/** Sort and view: task order and tasks per section. Saved per window. */
async function showSidebarSort(anchor: HTMLElement): Promise<void> {
  const sort = sidebarSort;
  await showChoices(anchor, { title: 'Sort and view', width: 280, items: [
    { id: 'tasks:manual', label: 'Manual', description: 'drag to arrange', heading: 'Sort tasks', selected: sort.tasks === 'manual' },
    { id: 'tasks:recent', label: 'Recent activity', selected: sort.tasks === 'recent' },
    { id: 'tasks:created', label: 'Created', selected: sort.tasks === 'created' },
    ...PER_PROJECT.map(count => ({ id: `perProject:${count}`, label: `${count} tasks`, short: String(count), segment: 'Show per section', selected: sort.perProject === count })),
  ], onSelect: id => {
    const [key, value] = id.split(':');
    const next: SidebarSort = key === 'perProject' ? { ...sidebarSort, perProject: Number(value) } : { ...sidebarSort, [key]: value };
    sidebarSort = readSort({ getItem: () => JSON.stringify(next) });
    try { localStorage.setItem(SORT_KEY, JSON.stringify(sidebarSort)); } catch { /* per-launch preference only */ }
    renderNavigation();
  } });
}
/** Rows in the order they are drawn, skipping closed folders and sections. */
function visibleSidebarRows(): HTMLElement[] {
  return [...$('#navigation').querySelectorAll<HTMLElement>('.task-item')].filter(row => !row.closest('[hidden]'));
}
/** ⌘1…⌘9 open the Nth visible task, ⌘⇧[ and ⌘⇧] the previous and next, / filters, ⌘Z undoes. */
function sidebarShortcut(event: KeyboardEvent): boolean {
  const command = event.metaKey || event.ctrlKey, target = event.target as HTMLElement;
  const typing = target.matches('input, textarea, select, [contenteditable="true"]');
  if (event.key === 'Escape' && target.id === 'sidebar-filter') {
    event.preventDefault();
    if ((target as HTMLInputElement).value) { state.query = ''; renderNavigation(); } else target.blur();
    return true;
  }
  // Never take keys meant for the prompt or any other field.
  if (typing) return false;
  if (command && !event.shiftKey && !event.altKey && /^[1-9]$/.test(event.key)) {
    const row = visibleSidebarRows()[Number(event.key) - 1];
    if (row) { event.preventDefault(); run(selectSession(row.dataset.id!)); }
    return Boolean(row);
  }
  if (command && event.shiftKey && !event.altKey && (event.code === 'BracketLeft' || event.code === 'BracketRight')) {
    const rows = visibleSidebarRows(), index = rows.findIndex(row => row.dataset.id === state.sessionId);
    const next = rows[index < 0 ? 0 : index + (event.code === 'BracketLeft' ? -1 : 1)];
    event.preventDefault();
    if (next) run(selectSession(next.dataset.id!));
    return true;
  }
  // / filters from the task list or anywhere that is not a control (the typing guard above already
  // passed); when the field is not shown (a narrow window) the key is left alone.
  const filter = $('#sidebar-filter');
  const control = !$('#navigation').contains(target) && target.closest('button, a[href], [role="button"], [role="menuitem"], [role="tab"], summary');
  if (event.key === '/' && !command && !event.altKey && !control && filter.getClientRects().length) {
    event.preventDefault(); filter.focus(); return true;
  }
  if (command && !event.shiftKey && !event.altKey && event.code === 'KeyZ' && toastUndo) {
    event.preventDefault(); runToastUndo(); return true;
  }
  return false;
}
/** A project's favicon or app icon; the sidebar redraws once a new one has loaded. */
function projectAppIcon(projectId: string, name: string): string {
  return projectIconHtml(projectId, name, id => call<string | null>('project_icon', { projectId: id }), () => renderNavigation());
}
async function showProjectFilter(anchor: HTMLElement): Promise<void> {
  await showChoices(anchor, { title: 'Filter projects', searchPlaceholder: 'Search projects…', width: 300, items: [
    { id: '', label: 'All projects', icon: 'folder', selected: !state.projectFilter },
    ...userProjects().map(p => ({ id: p.id, label: p.name, description: p.path, leading: projectAppIcon(p.id, p.name), selected: p.id === state.projectFilter })),
  ], onSelect: async id => {
    setProjectFilter(id);
    if (id) await selectProject(id); else renderNavigation();
  } });
}
async function showDefaultProvider(anchor: HTMLElement): Promise<void> {
  await showChoices(anchor, { title: 'Default agent', items: state.providers.map(p => ({ id: p.id, label: p.name, provider: p.id, selected: state.defaultProvider === p.id })), onSelect: id => {
    state.defaultProvider = id as ProviderId; localStorage.setItem('pandacode.provider', id);
    localStorage.setItem('pandacode.defaultProvider', id);
    refreshDefaultAgent();
  } });
}
function defaultModelLabel(): string {
  const id = state.defaultProvider, model = rememberedModel(id);
  return (provider(id)?.models.find(entry => entry.id === model) ?? fallbackModel(id, model)).name;
}
function refreshDefaultAgent(): void {
  const agent = document.getElementById('default-provider'), model = document.querySelector('#default-model span');
  if (agent) agent.innerHTML = `${providerLogo(state.defaultProvider)}<span>${escape(provider(state.defaultProvider)?.name ?? shortProvider(state.defaultProvider))}</span>${icon('down')}`;
  if (model) model.textContent = defaultModelLabel();
}
async function showDefaultModel(anchor: HTMLElement): Promise<void> {
  if (pendingMenuOpen?.anchor === anchor) { cancelPendingMenu(); return; }
  if (modelPickerCleanup) { closeModelPicker(); return; }
  closeMenus();
  const { epoch, release } = beginMenuOpen(anchor);
  const { openModelPicker } = await import('./model-picker').finally(release);
  if (epoch !== menuEpoch || !anchor.isConnected) return;
  modelPickerCleanup = openModelPicker({
    anchor, providers: state.providers, current: { provider: state.defaultProvider, model: rememberedModel(state.defaultProvider) },
    canSwitchProvider: true, loadModels, placement: 'below', onClose: () => { modelPickerCleanup = undefined; },
    onSelect: async (providerId, model) => {
      state.defaultProvider = providerId;
      localStorage.setItem('pandacode.provider', providerId); localStorage.setItem('pandacode.model.' + providerId, model);
      localStorage.setItem('pandacode.defaultProvider', providerId); localStorage.setItem('pandacode.defaultModel.' + providerId, model);
      refreshDefaultAgent();
    },
  });
}
function showDeleteTask(task = session()): void {
  if (!task || isRunning(task.id) || configuringSessions.has(task.id)) return;
  const dialog = modal('Delete task?', `<form id="delete-task-form"><p class="delete-task-name">${escape(task.title)}</p><p class="delete-task-description">Permanently delete this conversation and its worker history from PandaCode? This cannot be undone. Its terminal tabs close and running commands may stop. Project files and worktrees stay.</p><p class="delete-task-error" role="alert" hidden></p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="secondary-button delete-task-confirm">Delete task</button></div></form>`, 'delete-task-dialog');
  const form = dialog.querySelector<HTMLFormElement>('#delete-task-form')!;
  const confirm = form.querySelector<HTMLButtonElement>('[type="submit"]')!;
  const error = form.querySelector<HTMLElement>('[role="alert"]')!;
  const ownsDialog = () => dialog.open && form.isConnected;
  form.querySelector<HTMLButtonElement>('[data-action="close-dialog"]')!.focus();
  form.addEventListener('submit', event => {
    event.preventDefault(); event.stopPropagation();
    if (confirm.disabled) return;
    confirm.disabled = true; confirm.setAttribute('aria-busy', 'true'); error.hidden = true;
    void (async () => {
      try {
        const result = await call<{deletedSessionIds: string[]}>('delete_session', { sessionId: task.id });
        if (chatTask(task)) await forgetChat(task.projectId);
        removeDeletedSessions(result.deletedSessionIds);
        if (ownsDialog()) closeModal();
        notify('Task deleted');
      } catch (failure) {
        if (ownsDialog()) { error.textContent = String(failure instanceof Error ? failure.message : failure); error.hidden = false; }
        else report(failure);
      } finally { confirm.disabled = false; confirm.removeAttribute('aria-busy'); }
    })();
  });
}
function showRename(task?: Session): void { const s = task ?? session(); if (!s) return; modal('Rename task', `<form id="rename-form" data-session-id="${escape(s.id)}"><label for="task-title" class="field-label">Task name</label><input id="task-title" name="title" value="${escape(s.title)}" maxlength="200" required><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button class="primary-button">Save</button></div></form>`); document.querySelector<HTMLInputElement>('#task-title')?.select(); }
let settingsDiscoveryGeneration = 0;
async function discoverSettingsProviders(): Promise<Provider[]> {
  const generation = ++settingsDiscoveryGeneration;
  // Refresh also retries unchanged harnesses and invalidates their older in-flight metadata.
  modelCatalogs.clear();
  const providers = await call<Provider[]>('list_providers', { force: true });
  if (generation !== settingsDiscoveryGeneration) return state.providers;
  for (const found of providers) {
    const previous = provider(found.id);
    if (previous?.path === found.path && previous?.version === found.version) found.models = previous.models;
  }
  state.providers = providers;
  return providers;
}
/** Settings is a full page over the workspace; Back or Escape returns to where you were. */
let settingsView: import('./settings').SettingsView | undefined;
let settingsOpening: Promise<void> | undefined;
let settingsReturnFocus: HTMLElement | null = null;
async function showSettings(section?: import('./settings').SettingsSection, intent?: { newForSession?: string; editScheduleId?: string }): Promise<void> {
  // "Back to settings" in a dialog returns here; the dialog closes first.
  if (document.querySelector<HTMLDialogElement>('#dialog')?.open) closeModal();
  closeMenus();
  const host = $('#settings-page');
  // A schedules intent needs a fresh mount; the page reads it once.
  if (settingsView && intent) closeSettings();
  if (settingsView) { if (section) settingsView.show(section); return; }
  if (settingsOpening) { await settingsOpening; if (section) (settingsView as import("./settings").SettingsView | undefined)?.show(section); return; }
  settingsReturnFocus = document.activeElement as HTMLElement | null;
  host.hidden = false;
  $('.workspace').classList.add('settings-open');
  settingsOpening = import('./settings').then(({ mountSettings }) => {
    if (host.hidden) return;
    settingsView = mountSettings(host, {
      providers: state.providers, defaultProvider: state.defaultProvider, defaultModel: defaultModelLabel(), activityExpanded: activityExpanded(),
      compact: document.body.classList.contains('compact'), wallpapers: wallpapers.preferences.enabled,
      theme: currentTheme(), preview, section, discover: discoverSettingsProviders,
      projects: { list: userProjects, remove: removeProject },
      turnChecks: turnChecksEnabled(),
      github: target => github.mountSettings(target, project()?.id ?? state.projects[0]?.id ?? ''),
      teams: { loadModels, call },
      cloud: { call, listen: (name, callback) => subscribe(name, callback) },
      skills: { call, projects: () => userProjects().map(p => ({ id: p.id, name: p.name })), activeProject: () => project()?.id ?? '' },
      remote: remoteHost,
      schedules: { intent, openThread: id => { closeSettings(); run(selectSession(id, true)); } },
      embed: {
        colors: async target => (await import('./theme-settings')).mountThemeSettings(target, { call, notify, chooseVsix: () => import('./bridge').then(bridge => bridge.chooseVsix()) }),
        wallpapers: async target => {
          const cleanup = (await import('./wallpaper-settings')).mountWallpaperSettings(target, wallpapers);
          // Keep the Wallpapers switch and the scene controls it reveals in step with the saved choice.
          const unsubscribe = wallpapers.subscribe(() => {
            const on = wallpapers.preferences.enabled, box = host.querySelector<HTMLInputElement>('#daily-wallpapers');
            if (box) box.checked = on;
            host.querySelector<HTMLElement>('.settings-wallpapers')?.toggleAttribute('hidden', !on);
          });
          return () => { unsubscribe(); cleanup(); };
        },
        providerConnections: async target => (await import('./provider-settings')).mountProviderSettings(target, async () => { modelCatalogs.clear(); await discoverSettingsProviders(); renderComposer(); }, { harnesses: state.providers.map(p => ({ id: p.id, name: p.name, installed: p.installed })), saved: onNamedConnections }),
        openCodeModels: async target => (await import('./opencode-model-settings')).mountOpenCodeModels(target, () => invalidateModels('opencode')),
        harnessPrivacy: async target => (await import('./harness-privacy')).mountHarnessPrivacy(target),
      },
      close: closeSettings,
    });
    // Settings settles in once its content has drawn (opacity only).
    const content = host.querySelector<HTMLElement>('.settings-content');
    if (content) settleIn(content, 0);
  }).finally(() => { settingsOpening = undefined; });
  await settingsOpening;
}
/** Dictation's setup opens Settings → Voice on its missing step (where audio goes, or a model to download), not the top of the page. */
async function showVoiceSettings(): Promise<void> {
  const opening = showSettings('voice');
  // Settings hides the workspace (and the mic that was focused) before its module has loaded and drawn: hold focus on
  // the Settings region meanwhile, so it never falls to the page body on the way to the missing step.
  const page = $('#settings-page');
  const held = !page.hidden && !page.contains(document.activeElement);
  if (held) { page.tabIndex = -1; page.focus({ preventScroll: true }); }
  try {
    await opening;
    // The Voice page is mounted once Settings has opened (voice-settings.ts arrived with it): land on the missing step.
    const host = document.querySelector<HTMLElement>('#settings-page:not([hidden]) #voice-settings');
    if (host) (await import('./voice-settings')).focusVoiceSetup(host);
  } finally { if (held && document.activeElement !== page) page.removeAttribute('tabindex'); }
}
function closeSettings(): void {
  settingsView?.dispose(); settingsView = undefined;
  // Shortcut mode and local models change without a configuration event; dictation re-reads them on the way out.
  void voiceDictation.refreshPreferences();
  run(refreshCloudTargets());
  const host = $('#settings-page');
  host.hidden = true; host.replaceChildren();
  $('.workspace').classList.remove('settings-open');
  // The thread underneath settles back in (opacity only), instead of a hard cut.
  settleIn($('#transcript'), 0);
  (settingsReturnFocus?.isConnected ? settingsReturnFocus : $('#prompt'))?.focus({ preventScroll: true });
  settingsReturnFocus = null;
}
/** Light and dark belong to PandaCode's palette; switching leaves a VS Code theme. */
function toggleTheme(): void {
  const vsix = palette.vsix;
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  if (vsix) palette.setVsix(null);
  setTheme(next); renderThemeToggle();
  if (vsix) notify(`${vsix.name} turned off · PandaCode ${next}`);
  if (settingsView) { closeSettings(); void showSettings('appearance'); }
}
let colorsSettingsCleanup: (() => void) | undefined;
async function showColorsSettings(): Promise<void> {
  const dialog = modal('Colors', '<div id="colors-settings-content"><div class="dialog-loading">Loading themes…</div></div><div class="dialog-footer"><button class="secondary-button" data-action="settings">Back to settings</button><button class="primary-button" data-action="close-dialog">Done</button></div>', 'colors-dialog');
  const host = dialog.querySelector<HTMLElement>('#colors-settings-content')!;
  const { mountThemeSettings } = await import('./theme-settings');
  if (!dialog.open || !host.isConnected) return;
  colorsSettingsCleanup?.();
  colorsSettingsCleanup = mountThemeSettings(host, { call, notify, chooseVsix: () => import('./bridge').then(bridge => bridge.chooseVsix()) });
  dialog.addEventListener('close', () => { colorsSettingsCleanup?.(); colorsSettingsCleanup = undefined; }, { once: true });
}
async function showWallpaperSettings(): Promise<void> {
  const dialog = modal('Wallpapers', '<div id="wallpaper-settings-content"><div class="dialog-loading">Loading scenes…</div></div><div class="dialog-footer"><button class="secondary-button" data-action="settings">Back to settings</button><button class="primary-button" data-action="close-dialog">Done</button></div>', 'wallpaper-settings-dialog');
  const host = dialog.querySelector<HTMLElement>('#wallpaper-settings-content')!;
  const { mountWallpaperSettings } = await import('./wallpaper-settings');
  if (!dialog.open || !host.isConnected) return;
  wallpaperSettingsCleanup = mountWallpaperSettings(host, wallpapers);
}
async function showProviderConnections(): Promise<void> {
  const dialog = modal('Provider connections', '<div id="provider-connections-content"><p class="dialog-loading">Loading connections…</p></div><div class="dialog-footer"><button class="secondary-button" data-action="settings">Back to settings</button><button class="primary-button" data-action="close-dialog">Done</button></div>', 'provider-connections-dialog');
  const host = dialog.querySelector<HTMLElement>('#provider-connections-content')!;
  const { mountProviderSettings } = await import('./provider-settings');
  if (!dialog.open || !host.isConnected) return;
  providerSettingsCleanup = mountProviderSettings(host, async () => { modelCatalogs.clear(); await discoverSettingsProviders(); renderComposer(); }, { harnesses: state.providers.map(p => ({ id: p.id, name: p.name, installed: p.installed })), saved: onNamedConnections });
}
function invalidateModels(id: ProviderId): void {
  modelCatalogs.delete(id);
  const entry = provider(id); if (entry) entry.models = [];
}
async function showOpenCodeModels(): Promise<void> {
  const dialog = modal('OpenCode models', '<div id="opencode-model-settings"></div><div class="dialog-footer"><button class="secondary-button" data-action="settings">Back to settings</button><button class="primary-button" data-action="close-dialog">Done</button></div>', 'opencode-model-dialog');
  const host = dialog.querySelector<HTMLElement>('#opencode-model-settings')!;
  const {mountOpenCodeModels} = await import('./opencode-model-settings');
  if (!dialog.open || !host.isConnected) return;
  openCodeModelsCleanup = mountOpenCodeModels(host, () => invalidateModels('opencode'));
}
async function showMoodboards(): Promise<void> {
  const p = project(); if (!p) { notify('Open a project to create a moodboard.'); return; }
  const task = session();
  const dialog = modal('Moodboards', '<div id="moodboards-content"><p class="dialog-loading">Loading moodboards…</p></div>', 'moodboards-dialog');
  const host = dialog.querySelector<HTMLElement>('#moodboards-content')!;
  const { mountMoodboards } = await import('./moodboards');
  if (!host.isConnected || !dialog.open) return;
  moodboardsCleanup = mountMoodboards(host, { projectId: p.id, onAttach: board => {
    if (!task || task.id !== state.sessionId || task.projectId !== board.projectId || isRunning() || task.archived || taskStage(task) === 'completed') { notify('Open an idle task in this project to attach a moodboard.'); return; }
    const items = state.moodboardAttachments.get(task.id) ?? [];
    if (items.some(item => item.id === board.id)) { notify('Moodboard already attached.'); return; }
    if (items.length >= 8) { notify('Attach up to eight moodboards per message.'); return; }
    state.moodboardAttachments.set(task.id, [...items, { id: board.id, projectId: board.projectId, name: board.name }]);
    closeModal(); renderComposer(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus();
  } });
}
async function showAgentIntegrations(context: { projectId: string; sessionId?: string }): Promise<void> {
  const dialog = modal('Tools & integrations', '<div class="dialog-loading">Loading integrations…</div>', 'integrations-dialog');
  const loadingView = dialog.firstElementChild;
  const { showIntegrations } = await import('./integrations');
  if (!dialog.open || dialog.firstElementChild !== loadingView) return;
  await showIntegrations(dialog, context);
}
async function openJevSettings(): Promise<void> {
  const dialog = modal('Jev add-on', '<div class="dialog-loading">Loading Jev settings…</div>', 'jev-dialog');
  const loading = dialog.firstElementChild;
  const { showJevSettings } = await import('./jev');
  if (dialog.open && dialog.firstElementChild === loading) await showJevSettings(dialog);
}
async function openJevAssist(kind: import('./jev-assist').AssistKind = 'review', sessionId = state.sessionId, changes?: TurnChanges): Promise<void> {
  if (!sessionId) return;
  const ownerId = state.sessionId;
  const dialog = modal('Jev assistance', '<div class="dialog-loading">Preparing Jev assistance…</div>', 'jev-dialog');
  const loading = dialog.firstElementChild;
  const { showJevAssist } = await import('./jev-assist');
  if (!dialog.open || dialog.firstElementChild !== loading) return;
  await showJevAssist(dialog, { sessionId, kind, changeId: changes?.id,
    settings: () => run(openJevSettings()),
    openDiff: (changeId, path) => {
      // Resolve only a snapshot belonging to this report's task. The native
      // viewer independently validates task, snapshot and path on every read.
      const saved = changes?.id === changeId ? changes : [...document.querySelectorAll<HTMLElement>('.turn-changes')]
        .map(card => changeRequest(card)).find(item => item?.sessionId === sessionId && item.changes.id === changeId)?.changes;
      if (saved) run(openSavedDiff(sessionId, saved, path));
      else run((async () => {
        const view = dialog.firstElementChild;
        const summary = await call<TurnChanges>('turn_change_summary', { sessionId, changeId });
        if (dialog.open && dialog.firstElementChild === view) await openSavedDiff(sessionId, summary, path);
      })());
    },
    attach: text => {
      const current = session();
      if (!current || current.id !== ownerId || isRunning() || current.archived || taskStage(current) === 'completed') { notify('Open this task while it is idle to add the report.'); return; }
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (!prompt) return;
      prompt.value = [prompt.value.trim(), text].filter(Boolean).join('\n\n');
      state.drafts.set(ownerId, prompt.value); closeModal(); resizePrompt(); prompt.focus();
    },
  });
}
async function openJevTests(url?: string, anchor?: HTMLElement): Promise<void> {
  const task = session();
  if (!task) { notify('Open a task to save browser test results.'); return; }
  const context = { sessionId: task.id, url,
    settings: () => run(openJevSettings()),
    watch: (runId: string) => run((async () => {
      if (state.sessionId !== task.id) return;
      state.inspector = true; state.inspectorTab = 'browser'; renderInspector();
      await browserLifecycle;
      if (state.sessionId === task.id) await browserPanel?.watchJev(runId);
    })()),
    attach: (text: string) => {
      const current = session();
      if (!current || current.id !== task.id || isRunning() || current.archived || taskStage(current) === 'completed') { notify('Open this task while it is idle to add its test report.'); return; }
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
      if (!prompt) return;
      prompt.value = [prompt.value.trim(), text].filter(Boolean).join('\n\n');
      state.drafts.set(task.id, prompt.value); closeModal(); resizePrompt(); prompt.focus();
    },
  };
  if (anchor) {
    if (jevTestCleanup) { jevTestCleanup(); return; }
    closeMenus();
    const ticket = ++jevTestRequest;
    const { showJevTestPopover } = await import('./jev');
    if (ticket !== jevTestRequest || !anchor.isConnected || state.sessionId !== task.id) return;
    jevTestCleanup = showJevTestPopover(anchor, { ...context, onClose: () => { jevTestCleanup = undefined; } });
    return;
  }
  const dialog = modal('Browser tests', '<div class="dialog-loading">Loading browser tests…</div>', 'jev-dialog');
  const loading = dialog.firstElementChild;
  const { showJevTests } = await import('./jev');
  if (!dialog.open || dialog.firstElementChild !== loading) return;
  await showJevTests(dialog, context);
}
async function showConversationImport(): Promise<void> {
  const dialog = modal('Import conversations', '<div id="conversation-import-host"><p role="status">Loading…</p></div>', 'conversation-import-dialog');
  const host = dialog.querySelector<HTMLElement>('#conversation-import-host')!;
  try {
    const { mountConversationImport } = await import('./conversation-import');
    if (!dialog.open || !host.isConnected) return;
    conversationImportCleanup = mountConversationImport(host, {
      call,
      installed: state.providers.filter(p => p.installed).map(p => p.id),
      defaultModel: provider => rememberedModel(provider),
      openTask: id => { closeModal(); run(selectSession(id, true)); },
      onImported: result => run((async () => {
        // New folders become projects; reload both lists, then open the first import.
        state.projects = await call<Project[]>('list_projects');
        await reloadSessions();
        const count = result.imported.length;
        if (count) notify(`Imported ${count} ${count === 1 ? 'conversation' : 'conversations'}`);
        if (count && !result.failed.length) { closeModal(); await selectSession(result.imported[0].id, true); } else renderNavigation();
      })()),
    });
  } catch {
    if (dialog.open && host.isConnected) host.innerHTML = '<p role="alert">Unable to open the importer. Close this window and try again.</p>';
  }
}
/** What the Bots window and a bot's page share: native calls, live turns and approvals. */
function botsOptions(providers: Provider[]): import('./bots').BotsOptions {
  return {
    call, providers, notify, notifyError, loadModels,
    defaultModel: provider => rememberedModel(provider),
    running: id => isRunning(id),
    openTask: id => run((async () => { closeModal(); await reloadSessions(); await selectSession(id, true); })()),
    openChat: id => run((async () => { closeModal(); await openBot(id); })()),
  };
}
async function showBots(open: { botId?: string; startNew?: boolean } = {}): Promise<void> {
  const dialog = modal(open.startNew ? 'New bot' : 'Bots', '<div id="bots-host"><p role="status">Loading bots…</p></div>', 'bots-dialog');
  const host = dialog.querySelector<HTMLElement>('#bots-host')!;
  try {
    const [{ mountBots }, providers] = await Promise.all([
      import('./bots'),
      state.providers.length ? Promise.resolve(state.providers) : call<Provider[]>('list_providers'),
    ]);
    if (!dialog.open || !host.isConnected) return;
    botsView = mountBots(host, { ...botsOptions(providers), initialBot: open.botId, startNew: open.startNew });
  } catch {
    if (dialog.open && host.isConnected) host.innerHTML = '<p role="alert">Unable to open bots. Close this window and try again.</p>';
  }
}
/** One bot's settings as a modal: profile, conversations, memory, schedules, channels, rules and activity. */
async function showBotSettings(botId: string, tab?: import('./bots').Section): Promise<void> {
  const name = sidebarBots.find(bot => bot.id === botId)?.name;
  const dialog = modal(name ? `${name} settings` : 'Bot settings', '<div id="bots-host"><p role="status">Loading…</p></div>', 'bot-settings-dialog');
  const host = dialog.querySelector<HTMLElement>('#bots-host')!;
  try {
    const [{ mountBots }, providers] = await Promise.all([import('./bots'), state.providers.length ? Promise.resolve(state.providers) : call<Provider[]>('list_providers')]);
    if (!dialog.open || !host.isConnected) return;
    botsView = mountBots(host, { ...botsOptions(providers), layout: 'settings', initialBot: botId, initialTab: tab, onDeleted: () => run((async () => { closeModal(); await reloadBotProjects(); await reloadSessions(); if (!session()) state.sessionId = ''; render(); })()) });
  } catch {
    if (dialog.open && host.isConnected) host.innerHTML = '<p role="alert">Unable to open bot settings. Close this window and try again.</p>';
  }
}
/** Bots shown in the sidebar. Their workspaces stay out of the project tree, and their
 * conversations deliver queued messages natively, so the window never sends them twice. */
let sidebarBots: import('./bots').Bot[] = [];
let sidebarChannels: SharedChannelSummary[] = [];
let botProjects = new Set<string>();
let botProjectsLoad: Promise<void> | undefined;
const botSwitches = new Map<string, BotActivity[]>();
const botMessages = new Map<string, botThread.BotMessageMarker[]>();
const botFailovers = new Map<string, FailoverAsk>();
const botFailoverErrors = new Map<string, string>();
/** The failover error each thread last announced (renderBotFailover). */
const announcedFailoverErrors = new Map<string, string>();
const botThreadMetaLoaded = new Set<string>();
const botThreadMetaRequests = new Map<string, number>();
function ensureBotProjects(): Promise<void> { return botProjectsLoad ??= reloadBotProjects(false); }
async function reloadBotProjects(withProjects = true): Promise<void> {
  const [nextBots, nextChannels] = await Promise.all([
    call<import('./bots').Bot[]>('bots_list').catch(() => sidebarBots),
    call<SharedChannelSummary[]>('bot_shared_channels').catch(() => sidebarChannels),
  ]);
  sidebarBots = nextBots;
  sidebarChannels = nextChannels;
  botsLoaded = true;
  botProjects = new Set(sidebarBots.map(bot => bot.projectId));
  taskBots = new Map(Object.entries(await call<Record<string, string>>('bot_task_links').catch(() => Object.fromEntries(taskBots))));
  // An earlier build could leave the filter on a bot's workspace; send it back to All projects.
  if (botProjects.has(state.projectFilter)) setProjectFilter('');
  // A new bot brings a workspace project; a renamed bot renames it.
  if (withProjects) state.projects = await call<Project[]>('list_projects');
  renderNavigation(); renderHeader();
}
/* A project task can start with a bot (#114): its first message carries the bot's brief and
 * skills, and it uses the bot's harness and model. The task keeps its own project and checkout. */
let taskBots = new Map<string, string>();
const NO_BOT = 'none';
function botTaskControl(task: Session, fresh: boolean): string {
  const bot = sidebarBots.find(item => item.id === taskBots.get(task.id));
  if (!fresh) return bot ? `<span class="composer-computer composer-computer-fixed" role="img" tabindex="0" aria-label="Bot: ${escape(bot.name)} (fixed for this task)" data-tip="With ${escape(bot.name)}">${icon('bot')}<span class="sr-only">with ${escape(bot.name)}</span></span>` : '';
  if (!sidebarBots.length || botProjects.has(task.projectId) || chatTask(task) || task.remoteDevice || task.cloud || remoteChoice !== LOCAL) return '';
  const name = bot?.name ?? 'No bot';
  return `<button type="button" id="composer-bot" class="composer-computer" data-action="bot-task-menu" aria-label="Bot: ${escape(name)}" aria-haspopup="dialog" aria-expanded="false" data-tip="${escape(name)}: start this task with a bot">${icon('bot')}<span class="sr-only">${escape(name)}</span>${icon('down')}</button>`;
}
async function showBotTaskMenu(anchor: HTMLElement): Promise<void> {
  const task = session(); if (!task) return;
  const chosen = taskBots.get(task.id) ?? NO_BOT;
  const items = [{ id: NO_BOT, label: 'No bot', icon: 'close', selected: chosen === NO_BOT }, ...sidebarBots.map(bot => ({ id: bot.id, label: bot.name, description: bot.role, icon: 'bot', selected: bot.id === chosen }))];
  await showChoices(anchor, { title: 'Bot', width: 280, items, onSelect: id => { closeChoiceMenu(); run(assignTaskBot(task, id === NO_BOT ? null : id)); } });
}
async function assignTaskBot(task: Session, botId: string | null): Promise<void> {
  if (!newTaskView() || state.sessionId !== task.id) throw new Error('Choose a bot before the task\'s first message.');
  if (configuringSessions.has(task.id)) return;
  configuringSessions.add(task.id);
  try {
    const bot = await call<import('./bots').Bot | null>('bot_assign_task', { sessionId: task.id, botId });
    if (bot) {
      taskBots.set(task.id, bot.id);
      // The bot's harness and model become the task's defaults; the picker can still change them.
      if (bot.provider !== task.provider || bot.model !== task.model) upsertSession(await call<Session>('configure_session', { sessionId: task.id, provider: bot.provider, model: bot.model }));
    } else taskBots.delete(task.id);
  } finally { configuringSessions.delete(task.id); }
  if (state.sessionId === task.id) render();
}
/** The bot's brief for a task's next message, once per brief version; empty without a bot. */
async function botTaskBrief(task: Session): Promise<string> {
  return taskBots.has(task.id) ? await call<string | null>('bot_task_brief', { sessionId: task.id }) ?? '' : '';
}
const userProjects = (): Project[] => state.projects.filter(project => !botProjects.has(project.id) && !isChatProject(project));
/** Whether a task runs as a projectless chat. */
const chatTask = (task: Session | undefined): boolean => Boolean(task && isChatProject(state.projects.find(p => p.id === task.projectId)));
/* PandaCode Connect. A new task can start on another computer: the context bar offers the
 * signed-in account's targets; the started task is an ordinary session with `remoteDevice`. */
const remoteHost: RemoteHost = { call, listen: (name, callback) => subscribe(name as 'remote://status', callback), notify, notifyError, openUrl: url => call('open_external_url', { url }) };
type RemoteAccountDevice = Omit<RemoteTarget, 'deviceId'> & { id: string; current: boolean; host: boolean };
let remoteTargets: RemoteTarget[] = [], remoteChoice = LOCAL, remoteSignedIn = false, remoteConnected = false, remotePresenceReady = false;
/** The chosen computer's last known name, for when it leaves the list (signed out or revoked). */
let remoteChoiceName: string | undefined;
/** What the composer was last drawn with, so presence updates redraw it only when this changes. */
let renderedRemoteKey = '';
let pairingPrompt: (() => void) | undefined, pairingLoading = false;
const remoteChecks = new Set<string>(), remoteStartCancels = new Set<string>(), remoteRetries = new Set<string>(), remoteRetryErrors = new Map<string, string>();
function remoteDeviceId(s: Session): string | undefined {
  return s.remoteDevice?.id ?? (!s.cloud && newTaskView() && remoteChoice !== LOCAL && !cloudProvider(remoteChoice) ? remoteChoice : undefined);
}
function remoteTargetFor(s: Session): RemoteTarget | undefined {
  const id = remoteDeviceId(s); if (!id) return undefined;
  const target = remoteTargets.find(item => item.deviceId === id);
  if (target) return target;
  return s.remoteDevice && remotePresenceReady ? { deviceId: id, name: s.remoteDevice.name, platform: '', online: false, lastSeen: null } : undefined;
}
function remoteOffline(s: Session): boolean {
  const id = remoteDeviceId(s); if (!id || !remotePresenceReady) return false;
  const target = remoteTargetFor(s);
  return !target || !target.online || (remoteSignedIn && !remoteConnected);
}
/** A New task's chosen computer that is no longer in the account's list, or undefined. */
function remoteMissing(s: Session): string | undefined {
  if (s.remoteDevice || s.cloud || !newTaskView() || remoteChoice === LOCAL || cloudProvider(remoteChoice) || !remotePresenceReady) return undefined;
  return remoteTargets.some(item => item.deviceId === remoteChoice) ? undefined : remoteChoiceName ?? 'That computer';
}
function remoteMissingNote(s: Session): string {
  const name = remoteMissing(s);
  return name ? `<div class="composer-inline-note remote-missing-note"><span>${escape(name)} is no longer paired.</span><button type="button" class="remote-note-action" data-action="remote-choose-computer">Choose another</button></div>` : '';
}
function remoteComposerKey(s: Session): string {
  const target = remoteTargetFor(s);
  return JSON.stringify([s.id, remoteOffline(s), target?.deviceId ?? null, remoteMissing(s) ?? null]);
}
/** The status line of a task whose computer is out of reach. Drawn silently; its text is announced from the composer's live region. */
function syncRemoteConnection(): void {
  const region = document.querySelector<HTMLElement>('#stream-region'), s = session(), old = region?.querySelector<HTMLElement>(':scope > .remote-connection');
  if (!region || !s?.remoteDevice || !remoteOffline(s)) { old?.remove(); return; }
  const target = remoteTargetFor(s)!, retrying = remoteRetries.has(target.deviceId), failure = remoteRetryErrors.get(target.deviceId);
  const text = retrying ? `Reconnecting to ${target.name}…` : failure ? `Couldn’t reconnect to ${target.name}: ${failure}` : remoteSignedIn && !remoteConnected ? `Reconnecting to ${target.name}…` : `${target.name} is offline · ${lastSeenText(target)}`;
  const markup = `<div class="remote-connection"><span>${escape(text)}</span><button type="button" class="secondary-button" data-action="remote-retry" aria-label="${retrying ? 'Reconnecting…' : 'Retry connection'}" ${retrying ? 'disabled' : ''}>${icon('refresh')}${retrying ? 'Reconnecting…' : 'Retry'}</button></div>`;
  if (old?.outerHTML === markup) return;
  if (old?.querySelector('span')?.textContent !== text) announce(text);
  if (old) old.outerHTML = markup; else region.insertAdjacentHTML('beforeend', markup);
}
async function refreshRemoteTargets(signedIn: boolean): Promise<void> {
  remoteSignedIn = signedIn;
  if (signedIn) {
    const devices = await call<RemoteAccountDevice[]>('remote_devices').catch(() => undefined);
    if (devices) remoteTargets = devices.filter(device => !device.current && device.host).map(({ id: deviceId, name, platform, online, lastSeen }) => ({ deviceId, name, platform, online, lastSeen }));
  } else remoteTargets = [];
  remotePresenceReady = true;
  const chosen = remoteTargets.find(item => item.deviceId === remoteChoice);
  if (chosen) remoteChoiceName = chosen.name;
  for (const target of remoteTargets) if (target.online) remoteRetryErrors.delete(target.deviceId);
  syncPairingPrompt(signedIn);
  // The chip and status update in place; the prompt is redrawn only when what it offers changes,
  // so presence never closes an open @ menu, a picker or an IME composition.
  renderHeader();
  const s = session(); if (!s) return;
  if (remoteComposerKey(s) !== renderedRemoteKey) renderComposer(); else syncRemoteConnection();
}
/** Devices asking this computer for access (src/remote-pairing-prompt.ts), while signed in to Connect. */
function syncPairingPrompt(signedIn: boolean): void {
  if (!signedIn) { pairingPrompt?.(); pairingPrompt = undefined; return; }
  if (pairingPrompt || pairingLoading) return;
  pairingLoading = true;
  import('./remote-pairing-prompt').then(module => { if (remoteSignedIn && !pairingPrompt) pairingPrompt = module.mountPairingPrompt(remoteHost); })
    .catch(error => console.warn('Could not load the pairing prompt', error))
    .finally(() => { pairingLoading = false; });
}
/** Retry: reconnects to the relay now (`remote_reconnect`), then resubscribes, with any failure shown inline. */
async function retryRemoteConnection(): Promise<void> {
  const s = session(), id = s && remoteDeviceId(s); if (!s || !id || remoteRetries.has(id)) return;
  remoteRetries.add(id); remoteRetryErrors.delete(id); clearComposerNote(s); renderComposer();
  try {
    await call('remote_reconnect');
    await call('remote_resubscribe');
    await refreshRemoteTargets(remoteSignedIn);
  } catch (error) {
    const reason = errorText(error);
    remoteRetryErrors.set(id, reason);
    // A running mirror says so in its status line; a New task above its prompt.
    if (!s.remoteDevice) showComposerNote(s, `Couldn’t reconnect to ${remoteTargetFor(s)?.name ?? remoteMissing(s) ?? 'the other computer'}: ${reason}`);
  } finally { remoteRetries.delete(id); if (s.id === state.sessionId) renderComposer(); }
}
async function stopRemoteStart(s: Session, starting: NonNullable<ReturnType<typeof remoteStart>>): Promise<void> {
  if (remoteStartCancels.has(s.id)) return;
  const current = state.streams.get(s.id), previousStatus = current?.status, previousEnding = runEndings.get(s.id);
  starting.cancelling = true; remoteStartCancels.add(s.id); runEndings.set(s.id, 'stopped');
  if (current) { current.status = 'Stopping…'; current.revision++; }
  renderStream(); renderComposer();
  try {
    const reply = await call<{ cancelled: boolean; pending?: boolean }>('remote_cancel_start', { sessionId: starting.mirrorId ?? s.id });
    if (reply.cancelled) {
      // The draft comes back to the composer; no run ended, so nothing may report one.
      if (previousEnding) runEndings.set(s.id, previousEnding); else runEndings.delete(s.id);
      cancelledRemoteStart(s.id);
      return;
    }
    // The host has not answered yet: Stopping… stays until the start fails or attaches (sendRemote then stops it).
    if (reply.pending) return;
    // Too late to cancel: the host made the task, so it is stopped like any run.
    starting.cancelling = false; remoteStartCancels.delete(s.id); remoteStartAttached(starting.mirrorId ?? s.id);
    if (current) { current.status = 'Stopping agent'; current.revision++; clearAgentInputs(current); }
    renderStream(); renderComposer();
    await call('stop_session', { sessionId: starting.mirrorId ?? s.id });
  } catch (error) {
    starting.cancelling = false; remoteStartCancels.delete(s.id);
    if (previousEnding) runEndings.set(s.id, previousEnding); else runEndings.delete(s.id);
    if (current) { current.status = previousStatus ?? ''; current.revision++; }
    renderStream(); renderComposer(); throw error;
  }
}
async function stopTask(s: Session): Promise<void> {
  const starting = remoteStart(s.id);
  if (starting && starting.stage !== 'error') return stopRemoteStart(s, starting);
  runEndings.set(s.id, 'stopped');
  const current = state.streams.get(s.id);
  if (current) { current.status = 'Stopping agent'; current.revision++; clearAgentInputs(current); renderStream(); btwPanel.event(s.id, 'status'); }
  const team = teams.get(s.id) && !s.remoteDevice;
  await call(team ? 'architect_control' : 'stop_session', { sessionId: s.id, ...(team ? { action: 'stop' } : {}) });
}
/* Cloud agents (docs/cloud-agents.md): connected cloud providers are "Run on" targets too,
 * whether or not Connect is signed in. A cloud task is an ordinary session with `cloud`. */
let cloudTargets: CloudTarget[] = [];
async function refreshCloudTargets(): Promise<void> {
  cloudTargets = await call<CloudTarget[]>('cloud_agent_targets').catch(() => cloudTargets);
  const chosen = cloudProvider(remoteChoice);
  if (chosen && !cloudTargets.some(target => target.ready && target.provider === chosen)) remoteChoice = LOCAL;
  renderHeader();
}
/** Redraws the strip in place, so progress never re-renders the prompt someone is typing in. */
function syncCloudStrip(): void {
  const s = session(), old = document.querySelector<HTMLElement>('#composer-area .cloud-strip'), composer = document.querySelector('#composer');
  if (!s || !composer || old?.querySelector('[aria-expanded="true"]')) return;
  const markup = cloudStrip(s);
  if (old) { if (old.outerHTML !== markup) { if (markup) old.outerHTML = markup; else old.remove(); } }
  else if (markup) composer.insertAdjacentHTML('beforebegin', markup);
}
function onCloudProgress(event: { sessionId: string; stage: CloudStage; detail?: string | null }): void {
  const task = state.sessions.find(item => item.id === event.sessionId);
  // A task that just turned into a cloud task may not be listed as one yet.
  if (!task?.cloud) { run(reloadSessions()); return; }
  task.cloud = { ...task.cloud, stage: event.stage, detail: event.detail ?? null };
  if (task.id === state.sessionId) { syncCloudStrip(); renderHeader(); }
  renderNavigation();
}
async function initCloudAgents(): Promise<void> {
  // bridge.ts has no typed overload for this event yet.
  await (subscribe as unknown as (name: string, callback: typeof onCloudProgress) => Promise<() => void>)('cloud-agent://progress', onCloudProgress);
  await refreshCloudTargets();
}
async function showCloudMenu(anchor: HTMLElement): Promise<void> {
  const s = session(); if (!s?.cloud) return;
  await showChoices(anchor, { title: 'Cloud machine', width: 240, items: cloudActionItems(s), onSelect: async id => {
    closeChoiceMenu();
    if (id === 'delete' && !await confirmDeleteMachine(s)) return;
    try { await call('cloud_agent_action', { sessionId: s.id, action: id }); }
    catch (error) { notifyError(errorText(error)); return; }
    if (id === 'open') openVm();
    else if (id === 'delete') notify('Deleted the cloud machine. Your next message creates a new one.');
  } });
}
function confirmDeleteMachine(s: Session): Promise<boolean> {
  const dialog = modal('Delete cloud machine?', deleteMachineDialog(s));
  const form = dialog.querySelector<HTMLFormElement>('#cloud-delete-form')!;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(false), { once: true });
    form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); resolve(true); closeModal(); }, { once: true });
  });
}
/** A New task sent with a cloud provider chosen: the same message content as a Connect start, on a cloud machine. */
async function sendCloud(s: Session, target: CloudTarget, draft: string, text: string): Promise<void> {
  const filePaths = [...state.attachments], promptItems = attachments.list(s.id);
  const refusal = harnessRefusal(s.provider, provider(s.provider)?.name ?? s.provider);
  if (refusal) throw new Error(refusal);
  if ((state.browserAttachments.get(s.id) ?? []).length || (state.moodboardAttachments.get(s.id) ?? []).length || attachments.imageIds(promptItems).length) throw new Error(`Images and browser captures can’t be sent to a cloud machine yet. Remove them, or run on this computer.`);
  const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
  // A cloud start opens a new task and nothing re-renders while it waits, so the emptied field shrinks now.
  clearComposerDraft(s); resizePrompt();
  let accepted = false;
  configuringSessions.add(s.id);
  try {
    const contexts = await Promise.all(filePaths.map(path => fileContext(s, path)));
    const content = text + contexts.join('') + attachments.contextFor(promptItems) + await github.contextFor(s.projectId, s.id, text) + tokenSaver.contextFor(s.id);
    const started = await call<Session>('cloud_agent_start', {
      // The empty New task draft becomes the cloud task, so no stray draft is left behind.
      sessionId: s.id, projectId: s.projectId, provider: target.provider, prompt: content, harness: s.provider, model: s.model, mode: s.mode, effort: s.reasoningEffort ?? null,
    });
    accepted = true;
    attachments.consume(s.id, promptItems);
    state.attachments = state.attachments.filter(path => !filePaths.includes(path));
    remoteChoice = LOCAL;
    await reloadSessions();
    state.query = ''; await selectSession(started.id, true);
  } catch (error) {
    if (!accepted) restoreComposerDraft(s, draft);
    throw error;
  } finally { configuringSessions.delete(s.id); finishSubmit(); }
}
async function initRemote(): Promise<void> {
  let signedIn = false;
  await subscribe('remote://status', (status: RemoteStatus) => { signedIn = status.signedIn; remoteConnected = status.connected; run(refreshRemoteTargets(signedIn)); });
  await subscribe('remote://presence', () => run(refreshRemoteTargets(signedIn)));
  // A start whose reply was lost links later (`resume_start`) and brings the host's worktree note.
  await (subscribe as unknown as (name: string, callback: (note: { sessionId: string; note: string }) => void) => Promise<unknown>)('remote://start-note', ({ sessionId, note }) => {
    const mirror = state.sessions.find(task => task.id === sessionId);
    if (mirror) showComposerNote(mirror, note);
  });
  // A build without the Connect commands, or a signed-out one, simply offers no other computers.
  const status = await call<RemoteStatus>('remote_status').catch(() => undefined);
  if (status) { signedIn = status.signedIn; remoteConnected = status.connected; await refreshRemoteTargets(signedIn); }
}
async function showComputerMenu(anchor: HTMLElement): Promise<void> {
  await showChoices(anchor, { title: 'Run on', width: 280, items: computerItems(remoteTargets, remoteChoice, cloudTargets), onSelect: id => {
    closeChoiceMenu();
    if (id === SETUP_CHOICE) { run(showSettings('cloud')); return; }
    if (id === CONNECT_SETUP) { run(showSettings('remote')); return; }
    remoteChoice = id; remoteChoiceName = remoteTargets.find(item => item.deviceId === id)?.name; renderHeader();
    const task = session();
    if (task && remoteComposerKey(task) !== renderedRemoteKey) renderComposer();
    if (cloudProvider(id)) { if (task && newTaskView()) { const refusal = harnessRefusal(task.provider, provider(task.provider)?.name ?? task.provider); if (refusal) notify(refusal); } return; }
    if (task && newTaskView()) run(adaptPickerToComputer(task, id, remoteTargets.find(item => item.deviceId === id)?.name ?? 'That computer'));
  } });
}
/** Resolves true on Continue; Cancel or closing the dialog resolves false. */
function confirmBehind(name: string, check: RemoteRepoCheck): Promise<boolean> {
  const dialog = modal('GitHub is behind this computer', behindDialog(name, check));
  const form = dialog.querySelector<HTMLFormElement>('#remote-behind-form')!;
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(false), { once: true });
    form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); resolve(true); closeModal(); }, { once: true });
  });
}
/** A New task sent with another computer chosen: check GitHub, then start it there with the same settings. */
async function sendRemote(s: Session, target: RemoteTarget, draft: string, text: string): Promise<void> {
  const filePaths = [...state.attachments], promptItems = attachments.list(s.id), browserItems = state.browserAttachments.get(s.id) ?? [];
  if ((state.moodboardAttachments.get(s.id) ?? []).length) throw new Error(`Moodboards can’t be sent to ${target.name} yet. Remove them, or run on this computer.`);
  // Images and screenshots are copied to the other computer natively (remote/images.rs).
  const imageIds = [...browserItems.filter(a => a.kind === 'screenshot').map(a => a.id), ...attachments.imageIds(promptItems)];
  if (imageIds.length > MAX_IMAGES) throw new Error(`Attach up to ${MAX_IMAGES} images per message, including browser screenshots.`);
  const finishSubmit = voiceDictation.beginSubmit(s.id); if (!finishSubmit) return;
  clearComposerDraft(s);
  let accepted = false;
  configuringSessions.add(s.id); remoteChecks.add(s.id); renderComposer();
  try {
    const check = await call<RemoteRepoCheck>('remote_repo_check', { projectId: s.projectId });
    if (!check.repo) throw new Error(`${project()?.name ?? 'This project'} has no GitHub remote, so it can’t run on another computer.`);
    if (behindText(check) && !await confirmBehind(target.name, check)) return;
    const contexts = await Promise.all(filePaths.map(path => fileContext(s, path)));
    const content = text + contexts.join('') + browserContextText(browserItems) + attachments.contextFor(promptItems) + await github.contextFor(s.projectId, s.id, text) + tokenSaver.contextFor(s.id);
    remoteChecks.delete(s.id);
    // Shown at once, like send(): the prompt, and a turn below it that reports the start's
    // stages until the host's events stream in. Saved history gets the host's copy of the
    // prompt after the run (remote/mirror.rs); until then `mirrorPrompts` keeps this one.
    const sentAt = Date.now(), sent: Message = { id: transientId--, sessionId: s.id, role: 'user', content, createdAt: sentAt };
    const before = { status: s.status, taskStage: s.taskStage };
    addMirrorPrompt(s.id, sent, 0);
    const live = stream(s.id); live.lastPromptAt = sentAt; live.startedAt = Math.min(live.startedAt, sentAt); live.status = `Connecting to ${target.name}…`;
    s.status = 'running'; s.taskStage = 'in_progress';
    if (state.sessionId === s.id) {
      stickToBottom = true; followSend(); state.messages = [...state.messages, sent]; render();
      const shown = $('#transcript').querySelectorAll<HTMLElement>('.user-message');
      if (shown.length) enterView(shown[shown.length - 1], 12);
    }
    const onStage = (start: RemoteStart) => {
      // Once the agent has said or done something, its own status wins over a late stage.
      if (start.stage === 'error' || remoteStartCancels.has(s.id) || state.streams.get(s.id) !== live || live.text || live.tools.length) return;
      updateStreamStatus(live, startStageText(start)); live.revision++;
      if (state.sessionId === s.id) renderStream();
    };
    // A failure shows in the strip above the composer with Retry, so it is not also a toast.
    const started = await trackRemoteStart(s.id, target, startId => call<{ sessionId: string; note?: string }>('remote_start_task', {
      // The empty New task draft becomes the mirror, so no stray draft is left behind.
      sessionId: s.id, deviceId: target.deviceId, projectId: s.projectId, prompt: content, provider: s.provider, model: s.model, mode: s.mode,
      effort: s.reasoningEffort ?? null, worktree: Boolean(s.worktreePath), branch: s.worktreeBranch || state.git?.branch || check.branch || null, startId, imageIds,
    }), undefined, onStage).catch((error: unknown) => { if (!remoteStartCancels.has(s.id)) console.error(error); return undefined; });
    accepted = Boolean(started);
    if (!started || started.sessionId !== s.id) {
      // The prompt leaves the transcript: back to the composer on failure, to the mirror's own row otherwise.
      dropMirrorPrompt(s.id, sent);
      if (state.streams.get(s.id) === live) state.streams.delete(s.id);
      // A sessions reload meanwhile may have replaced the draft's object.
      for (const task of new Set([s, state.sessions.find(task => task.id === s.id)])) if (task) Object.assign(task, before);
      if (state.sessionId === s.id) state.messages = state.messages.filter(message => message !== sent);
      if (!started) {
        if (remoteStartCancels.has(s.id) && runEndings.get(s.id) === 'stopped') runEndings.delete(s.id);
        if (state.sessionId === s.id) render(); else renderNavigation();
        return;
      }
      addMirrorPrompt(started.sessionId, { ...sent, sessionId: started.sessionId }, 0);
      if (!state.streams.has(started.sessionId)) state.streams.set(started.sessionId, live);
    }
    const { sessionId } = started;
    attachments.consume(s.id, promptItems);
    const sentIds = new Set(browserItems.map(item => item.id)), remaining = (state.browserAttachments.get(s.id) ?? []).filter(item => !sentIds.has(item.id));
    if (remaining.length) state.browserAttachments.set(s.id, remaining); else state.browserAttachments.delete(s.id);
    state.attachments = state.attachments.filter(path => !filePaths.includes(path));
    await reloadSessions();
    state.query = ''; await selectSession(sessionId, true);
    // A busy or dirty checkout on the host gave way to a worktree: say so once, under the prompt.
    const mirror = state.sessions.find(task => task.id === sessionId);
    if (started.note && mirror) showComposerNote(mirror, started.note);
    if (remoteStartCancels.delete(s.id)) {
      // Stop was pressed while the host could not yet say whether the start was cancelled; it attached, so stop it now.
      runEndings.set(sessionId, 'stopped');
      const current = state.streams.get(sessionId);
      if (current) { current.status = 'Stopping agent'; current.revision++; clearAgentInputs(current); }
      if (sessionId === state.sessionId) { renderStream(); renderComposer(); }
      await call('stop_session', { sessionId });
    }
  } finally {
    if (!accepted) restoreComposerDraft(s, draft);
    configuringSessions.delete(s.id); remoteStartCancels.delete(s.id);
    if (remoteChecks.delete(s.id) && s.id === state.sessionId) renderComposer();
    finishSubmit();
  }
}
/** The sidebar shows tasks or bots; the bar at its bottom switches between them. */
let sidebarView: SidebarView = storedSidebarView();
let botsQuery = '';
/** Skeleton rows show until the first bots_list answers, so the empty state never flashes. */
let botsLoaded = false;
let hiddenBotsOpen = (() => { try { return localStorage.getItem('pandacode.botsHiddenOpen') === 'true'; } catch { return false; } })();
let botsListPendingRender = false;
/** Bot workspaces whose run finished while another thread was open; cleared when the bot opens. */
const respondedBots = new Set<string>();
const failedBotProjects = new Set<string>();
function botSignals(bot: import('./bots').Bot, unread: Map<string, number>): BotSignals {
  const tasks = state.sessions.filter(task => task.projectId === bot.projectId), now = Date.now();
  const live = tasks.map(task => state.streams.get(task.id)).filter(item => item !== undefined);
  const limited = tasks.find(task => limitActive(task, now));
  return {
    waiting: live.some(item => item.inputs.size) ? 'question' : live.some(item => item.approvals.size) ? 'approval' : undefined,
    failed: failedBotProjects.has(bot.projectId),
    limited: limited ? { until: limited.limitedUntil ?? null } : undefined,
    working: tasks.some(task => isRunning(task.id)), unread: unread.get(bot.id) ?? 0, responded: respondedBots.has(bot.projectId),
  };
}
function renderBots(): void {
  const bar = document.querySelector<HTMLElement>('#sidebar-bots'), panel = document.querySelector<HTMLElement>('#sidebar-bots-panel');
  if (!bar || !panel) return;
  const current = session(), open = state.view === 'conversation' ? current?.projectId : undefined;
  if (open) respondedBots.delete(open);
  const unread = syncSeen(sidebarBots, open, bot => state.sessions.filter(task => task.projectId === bot.projectId && task.lastResponseAt).map(task => task.lastResponseAt!));
  const markRead = panel.querySelector<HTMLButtonElement>('.bots-mark-read');
  if (markRead) markRead.hidden = unread.size === 0;
  document.querySelector('.sidebar')?.classList.toggle('bots-view', sidebarView === 'bots');
  const barHtml = botsBarHtml(sidebarView, sidebarBots.length, unread.size);
  if (!showsHtml(bar, barHtml)) morph(bar, barHtml);
  // The head (and its search field) is built once, so typing never loses focus.
  if (!panel.firstElementChild) {
    panel.innerHTML = botsPanelHeadHtml();
    panel.querySelector<HTMLInputElement>('[data-bots-search]')!.addEventListener('input', event => { botsQuery = (event.target as HTMLInputElement).value; renderBots(); });
    document.addEventListener('pointerdown', event => {
      const target = event.target as Element | null;
      if (target?.closest('#sidebar-bots-panel')) return;
      hideCreateBotMenu();
    }, true);
    bindBotRows(panel.querySelector<HTMLElement>('.bots-panel-list')!);
  }
  const list = panel.querySelector<HTMLElement>('.bots-panel-list')!;
  const html = botsListHtml({ bots: sidebarBots, channels: sidebarChannels, selectedProject: state.sharedChannelId ? undefined : current?.projectId, selectedChannel: state.sharedChannelId, signals: bot => botSignals(bot, unread), loaded: botsLoaded, hiddenOpen: hiddenBotsOpen }, botsQuery);
  if (!showsHtml(list, html)) {
    const menuAnchor = choiceMenuAnchor ?? pendingMenuOpen?.anchor;
    if (menuAnchor && list.contains(menuAnchor)) botsListPendingRender = true;
    else { morph(list, html); botsListPendingRender = false; }
  }
}
/** Right-click (or the context-menu key) opens a row's menu; rows drag to reorder. */
function bindBotRows(list: HTMLElement): void {
  const rowOf = (target: EventTarget | null) => (target as HTMLElement | null)?.closest<HTMLElement>('[data-bot-row]') ?? null;
  // A right click can also produce a non-primary click on the nested open button.
  // Keep that event from navigating away while the context menu opens.
  list.addEventListener('click', event => {
    if (event.button !== 0) { event.preventDefault(); event.stopPropagation(); }
  }, true);
  list.addEventListener('contextmenu', event => {
    const row = rowOf(event.target); if (!row) return;
    event.preventDefault();
    run(showBotMenu(row.querySelector<HTMLElement>('.bot-row-open')!, row.dataset.botRow!));
  });
  list.addEventListener('contextmenu', event => {
    const row = (event.target as HTMLElement | null)?.closest<HTMLElement>('.channel-row[data-channel]'); if (!row) return;
    event.preventDefault();
    run(showSharedChannelMenu(row, row.dataset.channel!));
  });
  let dragged = '', draggedGroup = '';
  list.addEventListener('dragstart', event => {
    const row = rowOf(event.target); if (!row) return;
    if (!['pinned', 'bots'].includes(row.dataset.botGroup ?? '')) { event.preventDefault(); return; }
    dragged = row.dataset.botRow!; draggedGroup = row.dataset.botGroup ?? ''; event.dataTransfer?.setData('text/plain', dragged);
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  });
  list.addEventListener('dragover', event => { const row = rowOf(event.target); if (dragged && row?.dataset.botGroup === draggedGroup) { event.preventDefault(); row.classList.add('drag-over'); } });
  list.addEventListener('dragleave', event => { const row = rowOf(event.target); if (row && !row.contains(event.relatedTarget as Node | null)) row.classList.remove('drag-over'); });
  list.addEventListener('drop', event => {
    const row = rowOf(event.target); if (!dragged || !row) return;
    if (row.dataset.botGroup !== draggedGroup) return;
    event.preventDefault();
    const shown = [...list.querySelectorAll<HTMLElement>('[data-bot-row]')].map(item => item.dataset.botRow!);
    if (row.dataset.botRow !== dragged) { moveBot(shown, dragged, row.dataset.botRow!); renderBots(); }
    dragged = ''; draggedGroup = '';
  });
  list.addEventListener('dragend', () => { list.querySelectorAll('.drag-over').forEach(item => item.classList.remove('drag-over')); dragged = ''; draggedGroup = ''; });
  list.addEventListener('keydown', event => {
    if (!event.altKey || !['ArrowUp', 'ArrowDown'].includes(event.key)) return;
    const row = rowOf(event.target), group = row?.dataset.botGroup;
    if (!row || !['pinned', 'bots'].includes(group ?? '')) return;
    const peers = [...list.querySelectorAll<HTMLElement>(`[data-bot-group="${group}"]`)];
    const index = peers.indexOf(row), next = index + (event.key === 'ArrowUp' ? -1 : 1);
    if (next < 0 || next >= peers.length) return;
    event.preventDefault();
    const all = [...list.querySelectorAll<HTMLElement>('[data-bot-row]')].map(item => item.dataset.botRow!);
    const before = event.key === 'ArrowUp' ? peers[next].dataset.botRow! : peers[next + 1]?.dataset.botRow ?? null;
    moveBot(all, row.dataset.botRow!, before);
    const id = row.dataset.botRow!;
    const live = document.querySelector<HTMLElement>('#bots-reorder-live');
    if (live) live.textContent = `Moved ${sidebarBots.find(bot => bot.id === id)?.name ?? 'bot'} ${event.key === 'ArrowUp' ? 'up' : 'down'} within ${group}.`;
    renderBots();
    document.querySelector<HTMLButtonElement>(`[data-bot-row="${CSS.escape(id)}"] .bot-row-open`)?.focus();
  });
}
async function showBotMenu(anchor: HTMLElement, botId: string): Promise<void> {
  const bot = sidebarBots.find(item => item.id === botId); if (!bot) return;
  const pinned = pinnedBots().has(bot.id);
  await showChoices(anchor, { title: `${bot.name} actions`, actions: true, items: [
    { id: 'pin', label: pinned ? 'Unpin' : 'Pin', icon: 'pin' },
    { id: 'edit', label: 'Edit bot', icon: 'edit' },
    { id: 'duplicate', label: 'Duplicate bot', icon: 'copy' },
    { id: 'hide', label: bot.paused ? 'Restore' : 'Hide (pause)', icon: bot.paused ? 'play' : 'pause' },
    { id: 'delete', label: 'Delete bot…', icon: 'trash', danger: true },
  ], onSelect: id => { closeChoiceMenu(); run(botMenuAction(id, bot.id)); } });
}
async function showCreateBotMenu(anchor: HTMLElement): Promise<void> {
  const menu = document.querySelector<HTMLElement>('#bot-create-menu'); if (!menu) return;
  menu.hidden = !menu.hidden;
  anchor.setAttribute('aria-expanded', String(!menu.hidden));
  if (!menu.hidden) menu.querySelector<HTMLElement>('[role=menuitem]')?.focus();
}
function hideCreateBotMenu(): void {
  const menu = document.querySelector<HTMLElement>('#bot-create-menu');
  if (!menu || menu.hidden) return;
  menu.hidden = true;
  document.querySelector('[data-action="new-bot-menu"]')?.setAttribute('aria-expanded', 'false');
}
function syncChannelWorkingLabel(): void {
  if (channelWorkingLabelTimer) { window.clearInterval(channelWorkingLabelTimer); channelWorkingLabelTimer = 0; }
  if (!state.sharedChannelId || !state.sharedChannelDetail?.activeBotIds.length) return;
  channelWorkingLabelTimer = window.setInterval(() => {
    if (!state.sharedChannelId || !state.sharedChannelDetail?.activeBotIds.length) { syncChannelWorkingLabel(); return; }
    const label = document.querySelector<HTMLElement>('.bc-history .bc-working .bot-working-label');
    if (label) label.textContent = botThread.pickLabel(label.textContent ?? '');
  }, 4_000);
}
/** Channel history rows per page, as `HISTORY_PAGE` in `shared_channels.rs`. */
const CHANNEL_PAGE = 100;
async function refreshSharedChannel(channelId = state.sharedChannelId): Promise<void> {
  if (!channelId) return;
  const request = ++state.sharedChannelRequest;
  const history = document.querySelector<HTMLElement>('.bc-history');
  if (history) {
    state.sharedChannelScrollTop = history.scrollTop;
    state.sharedChannelAtBottom = history.scrollHeight - history.clientHeight - history.scrollTop < 32;
  }
  const prompt = document.querySelector<HTMLTextAreaElement>('#shared-channel-prompt');
  if (prompt && state.sharedChannelId) state.sharedChannelDrafts.set(state.sharedChannelId, prompt.value);
  try {
    const detail = await call<SharedChannelDetail>('bot_shared_channel_detail', { channelId, limit: state.sharedChannelLimits.get(channelId) ?? CHANNEL_PAGE });
    if (request !== state.sharedChannelRequest || channelId !== state.sharedChannelId) return;
    state.sharedChannelDetail = detail;
    renderHeader(); renderTranscript(true); renderComposer(); renderBots();
    syncChannelWorkingLabel();
  } catch (error) { if (channelId === state.sharedChannelId) notifyError(errorText(error)); }
}
function activateSharedChannel(channelId: string): void {
  voiceDictation.detach();
  state.sharedChannelId = channelId;
  state.sharedChannelDetail = null;
  state.sharedChannelScrollTop = 0;
  state.sharedChannelAtBottom = true;
  state.view = 'conversation'; state.boardPanel = false;
  render(); renderInspector(); renderBots();
  void refreshSharedChannel(channelId);
}
function closeSharedChannel(): void {
  voiceDictation.detach();
  state.sharedChannelId = ''; state.sharedChannelDetail = null;
  state.sharedChannelRequest++;
  syncChannelWorkingLabel();
  render(); renderInspector(); renderBots();
}
function sharedChannelUi(): SharedChannelUiOptions {
  return { call, bots: sidebarBots, modal, closeModal, changed: () => reloadBotProjects(false), openChannel: activateSharedChannel, notify, notifyError };
}
async function createSharedChannel(): Promise<void> {
  const { openCreateChannel } = await import('./bot-shared-channels');
  openCreateChannel(sharedChannelUi());
}
async function openSharedChannel(id: string): Promise<void> {
  const { openSharedChannel } = await import('./bot-shared-channels');
  await openSharedChannel(id, sharedChannelUi());
}
async function showSharedChannelMenu(anchor: HTMLElement, channelId: string): Promise<void> {
  const channel = sidebarChannels.find(item => item.id === channelId); if (!channel) return;
  await showChoices(anchor, { title: `#${channel.name} actions`, actions: true, items: channel.archived
    ? [{ id: 'restore', label: 'Restore', icon: 'undo' }]
    : [{ id: 'edit', label: 'Edit', icon: 'edit' }, { id: 'delete', label: 'Delete', icon: 'trash', danger: true }],
  onSelect: id => { closeChoiceMenu(); run(sharedChannelMenuAction(id, channel)); } });
}
async function sharedChannelMenuAction(action: string, channel: SharedChannelSummary): Promise<void> {
  try {
    if (action === 'edit') {
      const { openSharedChannelSettings } = await import('./bot-shared-channels');
      await openSharedChannelSettings(channel.id, sharedChannelUi());
    }
    else {
      await call('bot_shared_channel_archive', { channelId: channel.id, archived: action !== 'restore' });
      await reloadBotProjects(false);
    }
  } catch (error) { notifyError(errorText(error)); }
}
async function botMenuAction(id: string, botId: string): Promise<void> {
  const bot = sidebarBots.find(item => item.id === botId); if (!bot) return;
  if (id === 'pin') { setBotPinned(bot.id, !pinnedBots().has(bot.id)); renderBots(); }
  else if (id === 'edit') await showBotSettings(bot.id);
  else if (id === 'hide') await setBotPaused(bot, !bot.paused);
  else if (id === 'duplicate') await duplicateBot(bot);
  else if (id === 'delete') await deleteBot(bot);
}
async function setBotPaused(bot: import('./bots').Bot, paused: boolean): Promise<void> {
  try {
    await call('bot_set_paused', { botId: bot.id, paused });
    notify(paused ? `${bot.name} paused` : `${bot.name} resumed`);
  } catch (error) {
    notifyError(`Couldn’t ${paused ? 'pause' : 'resume'} ${bot.name}: ${errorText(error)}`);
  }
  await reloadBotProjects(false);
}
async function duplicateBot(bot: import('./bots').Bot): Promise<void> {
  try {
    const { bot: source } = await call<import('./bots').BotDetail>('bot_detail', { botId: bot.id });
    const input: import('./bots').BotInput = { name: `${[...source.name].slice(0, 55).join('')} copy`, role: source.role, instructions: source.instructions, goals: source.goals, avatar: source.avatar, provider: source.provider, model: source.model, mode: source.mode, heartbeatMinutes: source.heartbeatMinutes, color: source.color ?? '', reasoningEffort: source.reasoningEffort ?? '', backupModels: source.backupModels ?? [], fallbackMode: source.fallbackMode ?? 'ask', notify: source.notify ?? true, whileWorking: source.whileWorking ?? 'queue', showPlan: source.showPlan ?? false };
    await call('bot_create', { input });
    notify(`${input.name} created`);
  } catch (error) {
    notifyError(`Couldn’t duplicate ${bot.name}: ${errorText(error)}`);
  }
  await reloadBotProjects();
}
async function deleteBot(bot: import('./bots').Bot): Promise<void> {
  if (!await confirmBotDelete(bot.name)) return;
  try { await call('bot_delete', { botId: bot.id }); }
  catch (error) { notifyError(`Couldn’t delete ${bot.name}: ${errorText(error)}`); return; }
  setBotPinned(bot.id, false);
  notify(`${bot.name} deleted`);
  await reloadBotProjects(); await reloadSessions();
  if (!session()) state.sessionId = '';
  render();
}
function confirmBotDelete(name: string): Promise<boolean> {
  const dialog = modal(`Delete ${name}?`, '<form id="delete-bot-form"><p class="delete-task-description">This removes the bot, its conversations and its channel connections. Its workspace folder stays on disk.</p><div class="dialog-footer"><button type="button" class="secondary-button" data-action="close-dialog">Cancel</button><button type="submit" class="secondary-button delete-task-confirm">Delete bot</button></div></form>', 'delete-task-dialog');
  const form = dialog.querySelector<HTMLFormElement>('#delete-bot-form')!;
  form.querySelector<HTMLButtonElement>('[data-action="close-dialog"]')!.focus();
  return new Promise(resolve => {
    dialog.addEventListener('close', () => resolve(false), { once: true });
    form.addEventListener('submit', event => { event.preventDefault(); event.stopPropagation(); resolve(true); closeModal(); }, { once: true });
  });
}
function setSidebarView(view: SidebarView): void {
  sidebarView = view; storeSidebarView(view); renderBots();
  if (view === 'bots') document.querySelector<HTMLInputElement>('#sidebar-bots-panel [data-bots-search]')?.focus({ preventScroll: true });
}
/** A bot's latest message changed; refresh the list's previews without reloading projects. */
async function refreshBotPreviews(): Promise<void> {
  sidebarBots = await call<import('./bots').Bot[]>('bots_list').catch(() => sidebarBots);
  renderBots();
}
/** The bot whose workspace holds the open conversation: its own chat, a channel thread or scheduled work. */
function botForThread(): import('./bots').Bot | undefined {
  const s = state.view === 'conversation' ? session() : undefined;
  return s ? sidebarBots.find(bot => bot.projectId === s.projectId) : undefined;
}
function switchKey(item: BotActivity): string {
  return [item.at, item.detail.sessionId, item.detail.provider, item.detail.model, item.detail.cause, item.detail.back].join(':');
}
function mergeBotSwitches(current: BotActivity[], incoming: BotActivity[]): BotActivity[] {
  const merged = new Map<string, BotActivity>();
  for (const item of [...current, ...incoming]) merged.set(switchKey(item), item);
  return [...merged.values()].sort((a, b) => a.at - b.at);
}
async function refreshBotThreadMeta(bot: import('./bots').Bot, sessionId: string, force = false): Promise<void> {
  if (!force && (botThreadMetaLoaded.has(sessionId) || botThreadMetaRequests.has(sessionId))) return;
  const request = (botThreadMetaRequests.get(sessionId) ?? 0) + 1;
  botThreadMetaRequests.set(sessionId, request);
  try {
    const [ask, switches, messages] = await Promise.all([
      call<FailoverAsk | null>('bot_failover_pending', { sessionId }),
      call<BotActivity[]>('bot_model_switches', { sessionId }),
      call<botThread.BotMessageMarker[]>('bot_message_markers', { sessionId }),
    ]);
    if (botThreadMetaRequests.get(sessionId) !== request) return;
    if (ask?.sessionId === sessionId) botFailovers.set(sessionId, ask); else botFailovers.delete(sessionId);
    botSwitches.set(sessionId, mergeBotSwitches(botSwitches.get(sessionId) ?? [], switches));
    botMessages.set(sessionId, messages);
    botThreadMetaLoaded.add(sessionId);
    if (state.sessionId === sessionId && botForThread()?.id === bot.id) { renderTranscript(true); renderComposer(); }
  } catch (error) {
    console.warn('Could not load bot conversation markers:', error);
  } finally {
    if (botThreadMetaRequests.get(sessionId) === request) botThreadMetaRequests.delete(sessionId);
  }
}
function renderBotFailover(): void {
  const host = document.querySelector<HTMLElement>('#bot-failover-bar');
  const ask = botFailovers.get(state.sessionId);
  if (!ask) botFailoverErrors.delete(state.sessionId);
  const error = ask ? botFailoverErrors.get(state.sessionId) : undefined;
  // Every composer rebuild redraws this bar: the alert is said only the first time an error shows (as paintRetryRow).
  const fresh = error !== undefined && announcedFailoverErrors.get(state.sessionId) !== error;
  if (error === undefined) announcedFailoverErrors.delete(state.sessionId); else announcedFailoverErrors.set(state.sessionId, error);
  if (host) host.innerHTML = `${botThread.failoverHtml(ask)}${error !== undefined ? `<div class="bot-failover-error message-error error-row"><div class="error-row-head"><span class="error-row-icon" data-state-tone="danger" aria-hidden="true">${icon('alert')}</span><span class="error-row-summary"${fresh ? ' role="alert"' : ''}>${escape(error)}</span><button type="button" class="error-row-button error-row-dismiss" data-action="dismiss-failover-error" aria-label="Dismiss error">${icon('close')}</button></div></div>` : ''}`;
}
/** A model picked during a bot's turn takes over once the turn ends; if the next turn already
 *  started (a queued message), it stays pending and is tried again at that turn's end. */
async function applyNextBotModel(sessionId: string): Promise<void> {
  const next = botThread.nextModel(sessionId);
  if (!next || isRunning(sessionId)) return;
  try {
    const updated = await call<Session>('configure_session', { sessionId, provider: next.provider, model: next.model });
    botThread.setNextModel(sessionId, undefined);
    state.sessions = state.sessions.map(task => task.id === sessionId ? updated : task);
    if (sessionId === state.sessionId) { renderComposer(); renderHeader(); }
  } catch (error) { console.warn('The bot keeps its model until the next turn ends:', error); }
}
/** Opens a bot's conversation in this app, creating it the first time. */
async function openBot(botId: string): Promise<void> {
  const bot = sidebarBots.find(item => item.id === botId); if (bot) respondedBots.delete(bot.projectId);
  const id = await call<string>('bot_desktop_thread', { botId });
  if (bot) { sidebarBots = sidebarBots.map(item => item.id === botId ? { ...item, desktopSession: id } : item); renderBots(); }
  if (!state.sessions.some(task => task.id === id)) await reloadSessions();
  await selectSession(id, true);
}
async function showAgentUsage(): Promise<void> {
  const dialog = modal('Agent usage', '<div id="agent-usage-host"><p role="status">Loading usage panel…</p></div>', 'agent-usage-dialog');
  const host = dialog.querySelector<HTMLElement>('#agent-usage-host')!;
  try {
    const [{ mountAgentUsage }, providers] = await Promise.all([
      import('./agent-usage'),
      state.providers.length ? Promise.resolve(state.providers) : call<Provider[]>('list_providers'),
    ]);
    if (!dialog.open || !host.isConnected) return;
    agentUsageCleanup = mountAgentUsage(host, providers);
  } catch {
    if (dialog.open && host.isConnected) host.innerHTML = '<p role="alert">Unable to load usage. Close this window and try again.</p>';
  }
}
function showCommands(): void {
  modal('Go to anything', `<div class="command-search">${icon('search')}<input id="command-query" aria-label="Search tasks and commands" placeholder="Search tasks and commands…" autocomplete="off"></div><div id="command-results" class="command-results"></div><div class="command-footer"><span>↑ ↓ to navigate</span><span>↵ to open</span><span>esc to close</span></div>`, 'command-dialog'); renderCommands('');
}
/** Every Settings page, findable by page or section name or a page's keywords; only listed once there is a query. */
const settingsPageCommands = () => SECTIONS.flatMap(section => section.pages.map(item => ({ action: 'settings-page', page: item.id, label: `Settings › ${section.pages.length > 1 ? `${section.label} › ` : ''}${item.label}`, keywords: item.keywords ?? '', icon: section.icon, shortcut: '' })));
/** Every whitespace-separated word of the query appears somewhere in the text (case-insensitive). */
const matchesWords = (text: string, query: string): boolean => { const hay = text.toLowerCase(); return query.toLowerCase().split(/\s+/).filter(Boolean).every(word => hay.includes(word)); };
function renderCommands(query: string): void {
  const commands = [{ action: 'new-task', label: 'New task', icon: 'plus', shortcut: shortcut('N') }, { action: 'new-chat', label: 'New chat (no project)', icon: 'chat', shortcut: '' }, { action: 'add-project', label: 'Open project', icon: 'folder', shortcut: '' }, { action: 'browser', label: 'Open browser', icon: 'globe', shortcut: '' }, { action: 'terminal', label: 'Toggle terminal', icon: 'terminal', shortcut: shortcut('J') }, { action: 'settings', label: 'Settings', icon: 'settings', shortcut: shortcut(',') }, { action: 'agent-usage', label: 'Agent usage', icon: 'activity', shortcut: '' }, { action: 'bots', label: 'Bots', icon: 'bot', shortcut: '' }, { action: 'import-conversations', label: 'Import conversations', icon: 'download', shortcut: '' }, { action: 'worktree', label: 'Create worktree', icon: 'branch', shortcut: '' }, { action: 'conversation-view', label: 'Conversation', icon: 'thread', shortcut: '' }, { action: 'board-view', label: 'Board', icon: 'kanban', shortcut: '' }, ...(session() && !session()!.archived ? [{ action: 'wake-later', label: 'Schedule a wake-up…', icon: 'clock', shortcut: '' }] : []), ...(githubEnabled() ? [{ action: 'github-view', label: 'GitHub', icon: 'github', shortcut: '' }] : []), ...(query ? settingsPageCommands() : [])].filter(c => matchesWords(`${c.label} ${'keywords' in c ? c.keywords : ''}`, query));
  const tasks = listedSessions().filter(s => matchesWords(s.title, query)).slice(0, 12);
  $('#command-results').innerHTML = `${commands.length ? '<div class="command-section">Commands</div>' : ''}${commands.map(c => `<button data-action="${c.action}"${'page' in c ? ` data-id="${c.page}"` : ''} data-command="true">${icon(c.icon)}<span>${c.label}</span><kbd>${c.shortcut}</kbd></button>`).join('')}${tasks.length ? '<div class="command-section">Tasks</div>' : ''}${tasks.map(s => `<button data-action="select-task" data-id="${escape(s.id)}" data-command="true">${providerLogo(s.provider)}<span>${escape(s.title)}<small>${escape(state.projects.find(p => p.id === s.projectId)?.name)} · ${shortProvider(s.provider)}</small></span></button>`).join('')}${!commands.length && !tasks.length ? '<div class="inspector-empty">No matching tasks or commands.</div>' : ''}`;
  $('#command-results').querySelector('button')?.classList.add('command-selected');
}
async function toggleTerminal(): Promise<void> {
  if (!project()) { notify('Open a project before starting a terminal.'); return; }
  await terminalPanel.toggle();
}

async function action(name: string, element: HTMLElement): Promise<void> {
  if (element.dataset.command) closeModal();
  if (['tab-files', 'tab-changes', 'browser', 'back-inspector'].includes(name) || name === 'toggle-inspector' && !state.filePreviewLoading) ++fileRequest;
  if (name.startsWith('queue-')) { await queueAction(name, element); return; }
  if (name.startsWith('limit-')) { await limitAction(name, element); return; }
  switch (name) {
    case 'support': await openSupport(); break;
    case 'new-task': if (state.view === 'board') showBoardTaskForm(); else await createTask(); break;
    case 'new-chat': if (state.view !== 'conversation') setWorkspaceView('conversation'); await createChat(); break;
    case 'board-view': setWorkspaceView('board'); break;
    case 'conversation-view': setWorkspaceView('conversation'); break;
    case 'github-view': setWorkspaceView('github'); break;
    case 'wake-later': openWakeComposer(document.querySelector<HTMLElement>('#composer') ?? $('#composer-area')); break;
    case 'toggle-sidebar': toggleSidebar(); break;
    case 'board-add': showBoardTaskForm(); break;
    case 'board-open': await selectSession(element.dataset.id!); break;
    case 'board-close': closeMenus(); state.boardPanel = false; renderBoardView(); document.querySelector<HTMLButtonElement>(`[data-action="board-open"][data-id="${CSS.escape(state.sessionId)}"]`)?.focus(); break;
    case 'board-edit': await editBoardTask(); break;
    case 'board-start': await startBoardTask(element.dataset.id ?? state.sessionId); break;
    case 'board-complete': await changeBoardStage('completed'); break;
    case 'board-reopen': await changeBoardStage('review'); break;
    case 'project-task': await createTask(element.dataset.id!); break;
    case 'toggle-folder': {
      // While filtering every folder shows its matches; a click must not quietly save open/closed.
      if (state.query.trim()) break;
      const id = element.dataset.project!;
      if (element.getAttribute('aria-expanded') === 'true') state.collapsedFolders.add(id); else state.collapsedFolders.delete(id);
      saveCollapsedFolders(); renderNavigation(); break;
    }
    case 'completed-more': completedShown += COMPLETED_PAGE; renderNavigation(); break;
    case 'sidebar-sort': await showSidebarSort(element); break;
    case 'view-menu': await showViewMenu(element); break;
    case 'folder-menu': { const heading = element.parentElement?.querySelector<HTMLElement>('.folder-heading'); if (heading) await showFolderMenu(heading); break; }
    case 'clear-sidebar-filter': state.query = ''; renderNavigation(); $('#sidebar-filter').focus(); break;
    case 'toggle-folder-more': { const id = element.dataset.project!; if (!state.expandedFolders.delete(id)) state.expandedFolders.add(id); renderNavigation(); break; }
    case 'add-project': showOpenProject(); break;
    case 'browse-project': {
      const input = document.querySelector<HTMLInputElement>('#project-folder'); if (!input) break;
      (element as HTMLButtonElement).disabled = true;
      try { const path = await chooseFolder(); if (path && input.isConnected) { input.value = path; input.focus(); } }
      finally { if (element.isConnected) (element as HTMLButtonElement).disabled = false; }
      break;
    }
    case 'open-turn-diff': await showTurnDiff(element); break;
    case 'select-task': await selectSession(element.dataset.id!); break;
    case 'sidebar-complete': sidebarTaskAction('complete', element.dataset.task!); break;
    case 'sidebar-reopen': sidebarTaskAction('reopen', element.dataset.task!); break;
    case 'sidebar-delete': sidebarTaskAction('delete', element.dataset.task!); break;
    case 'sidebar-more': { const row = element.closest('.task-row')?.querySelector<HTMLElement>('.task-item'); if (row) await showSidebarTaskMenu(row); break; }
    case 'toggle-section': {
      if (state.query.trim()) break;
      const key = element.dataset.section!;
      if (!collapsedSections.delete(key)) collapsedSections.add(key);
      try { localStorage.setItem(COLLAPSED_SECTIONS_KEY, JSON.stringify([...collapsedSections])); } catch { /* per-launch preference only */ }
      renderNavigation(); break;
    }
    case 'toggle-completed': if (state.query.trim()) break; completedOpen = !completedOpen; completedShown = COMPLETED_FIRST; try { localStorage.setItem(COMPLETED_OPEN_KEY, String(completedOpen)); } catch { /* per-launch preference only */ } renderNavigation(); break;
    case 'select-project': await selectProject(element.dataset.id!); break;
    case 'toggle-theme': toggleTheme(); break;
    case 'colors-settings': await showColorsSettings(); break;
    case 'ui-size-decrease': changeUiScale(-1); break;
    case 'ui-size-increase': changeUiScale(1); break;
    case 'ui-size-reset': setUiScale(1); break;
    case 'delete-task': showDeleteTask(); break;
    case 'search': showCommands(); break;
    case 'toggle-error': toggleError(element); break;
    case 'dismiss-error': dismissErrors(element.closest<HTMLElement>('.message-error')); break;
    case 'dismiss-failover-error': {
      botFailoverErrors.delete(state.sessionId); renderBotFailover();
      // The bar was rewritten: the keyboard continues from the hold card's first button, else the composer.
      (document.querySelector<HTMLElement>('#bot-failover-bar button') ?? document.querySelector<HTMLElement>('#prompt'))?.focus({ preventScroll: true });
      break;
    }
    case 'dismiss-errors': dismissErrors(element.closest<HTMLElement>('.thread-errors')); break;
    case 'retry-response': { const id = actionTask(element)?.id ?? state.sessionId, finishing = finishingStreams.get(id); if (finishing) await finishResponse(id, finishing); break; }
    case 'settings': case 'refresh-settings': await showSettings(); break;
    case 'settings-page': await showSettings(element.dataset.id as import('./settings').SettingsSection); break;
    case 'wallpaper-settings': await showWallpaperSettings(); break;
    case 'provider-connections': await showProviderConnections(); break;
    case 'opencode-models': await showOpenCodeModels(); break;
    case 'moodboards': await showMoodboards(); break;
    case 'detach-moodboard': state.moodboardAttachments.set(state.sessionId, (state.moodboardAttachments.get(state.sessionId) ?? []).filter(item => item.id !== element.dataset.id)); renderComposer(); break;
    case 'agent-integrations': await showAgentIntegrations(workspaceContext()); break;
    case 'jev-settings': await openJevSettings(); break;
    case 'jev-tests': await openJevTests(); break;
    case 'jev-assist': await openJevAssist(); break;
    case 'agent-usage': await showAgentUsage(); break;
    case 'bots': await showBots(); break;
    case 'new-bot': hideCreateBotMenu(); await showBots({ startNew: true }); break;
    case 'new-bot-menu': await showCreateBotMenu(element); break;
    case 'new-channel': hideCreateBotMenu(); await createSharedChannel(); break;
    case 'open-shared-channel': if (element.dataset.channel) await openSharedChannel(element.dataset.channel); break;
    case 'close-shared-channel': closeSharedChannel(); break;
    case 'shared-channel-settings': if (state.sharedChannelId) { const { openSharedChannelSettings } = await import('./bot-shared-channels'); await openSharedChannelSettings(state.sharedChannelId, sharedChannelUi()); } break;
    case 'bot-settings': if (element.dataset.bot) await showBotSettings(element.dataset.bot, element.dataset.tab as import('./bots').Section | undefined); break;
    case 'bot-pause': if (element.dataset.bot) { const bot = sidebarBots.find(item => item.id === element.dataset.bot); if (bot) await setBotPaused(bot, !bot.paused); } break;
    case 'toggle-hidden-bots': hiddenBotsOpen = !hiddenBotsOpen; try { localStorage.setItem('pandacode.botsHiddenOpen', String(hiddenBotsOpen)); } catch { /* Keep the choice for this window. */ } renderBots(); break;
    case 'mark-bots-read': markAllBotsRead(sidebarBots, bot => state.sessions.filter(task => task.projectId === bot.projectId && task.lastResponseAt).map(task => task.lastResponseAt!)); renderBots(); break;
    case 'open-bot': if (element.dataset.bot) await openBot(element.dataset.bot); break;
    case 'computer-menu': await showComputerMenu(element); break;
    case 'remote-choose-computer': { const chip = document.querySelector<HTMLElement>('#composer-computer'); if (chip) await showComputerMenu(chip); break; }
    case 'bot-task-menu': await showBotTaskMenu(element); break;
    case 'cloud-menu': await showCloudMenu(element); break;
    case 'toggle-bots-view': setSidebarView(sidebarView === 'bots' ? 'tasks' : 'bots'); break;
    case 'import-conversations': await showConversationImport(); break;
    case 'agent-updates': await agentUpdates.show(); break;
    case 'goal': case 'jobs': case 'usage': if (session()) await performSlashAction(name, '', session()!); break;
    case 'harness-console': if (session()) await openHarnessConsole(session()!); break;
    case 'task-menu': await showTaskMenu(element); break;
    case 'pin-task': if (session()) await pinTask(session()!.id); break;
    case 'rename': showRename(); break;
    case 'worktree': worktrees.openDialog(newTaskView() ? 'attach' : 'new'); break;
    case 'branch-menu': await worktrees.showMenu(element); break;
    case 'open-url': if (element.dataset.url) await call('open_external_url', { url: element.dataset.url }); break;
    case 'board-import': github.showImport(state.projectFilter || project()?.id || state.projects[0]?.id || ''); break;
    case 'model': await showModel(element, actionTask(element)); break;
    case 'change-task-project': await showProjectPicker(element); break;
    case 'mode': await showMode(element, actionTask(element)); break;
    case 'filter-projects': await showProjectFilter(element); break;
    case 'default-provider': await showDefaultProvider(element); break;
    case 'default-model': await showDefaultModel(element); break;
    case 'close-dialog': closeModal(); break;
    case 'copy-file': await navigator.clipboard.writeText(state.selectedContent); notify('File copied'); break;
    case 'copy-path': await navigator.clipboard.writeText(workspacePath()); notify(session()?.worktreePath ? 'Worktree path copied' : 'Project path copied'); break;
    case 'terminal': await toggleTerminal(); break;
    case 'toggle-inspector': state.inspector = inspectorChosen = inspectorSuppressed || !state.inspector; inspectorSuppressed = false; renderInspector(); break;
    case 'tab-vm': openVm(); break;
    case 'tab-btw': openBtw(); btwPanel.focus(); break;
    case 'inspector-add-tab': await showInspectorViews(element); break;
    case 'close-inspector-tab': closeInspectorTab(element.dataset.view as PanelView); break;
    case 'tab-open-files': state.inspectorTab = 'file'; state.selectedKind = ''; renderInspector(); break;
    case 'tab-design': inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'design'; state.selectedKind = ''; renderInspector(); break;
    case 'deploy': await showDeploy(element); break;
    case 'tab-simulator': case 'simulator': if (name === 'simulator' && state.inspector && state.inspectorTab === 'simulator' && !inspectorSuppressed) { state.inspectorTab = 'changes'; renderInspector(); } else openSimulator(); break;
    case 'token-saver': tokenSaver.open(element, state.sessionId); break;
    case 'council': if (element.getAttribute('aria-disabled') !== 'true') council.open(element, state.sessionId, element.dataset.councilFocus === 'target' || element.dataset.councilFocus === 'maxRounds' ? element.dataset.councilFocus : undefined); break;
    case 'council-keep-fixing': case 'council-accept': if (element.closest<HTMLElement>('.council-strip')?.dataset.sessionId === state.sessionId) await council.act(state.sessionId, name === 'council-accept' ? 'accept' : 'keep', element); break;
    case 'council-strip-toggle': council.toggle(state.sessionId); break;
    case 'council-dismiss': council.dismiss(state.sessionId); break;
    case 'tab-pull': state.inspectorTab = 'pull'; state.selectedKind = ''; renderInspector(); break;
    case 'open-pull': if (element.dataset.sessionId) await openPullRequest(element.dataset.sessionId); break;
    case 'tab-changes': case 'tab-files': state.inspectorTab = name === 'tab-files' ? 'files' : 'changes'; state.selectedKind = ''; renderInspector(); break;
    case 'tab-search': state.inspectorTab = 'search'; state.selectedKind = ''; renderInspector(); document.querySelector<HTMLInputElement>('#inspector-content .search-input')?.focus(); break;
    case 'browser': inspectorSuppressed = false; state.inspector = true; state.inspectorTab = 'browser'; state.selectedKind = ''; renderInspector(); break;
    case 'refresh-inspector': if (state.inspectorTab === 'btw') { await btwPanel.reload(); break; } if (state.inspectorTab === 'pull') { pullView.forget(state.sessionId); renderInspector(); break; } if (state.inspectorTab === 'search') searchPanel.refresh(); refreshFileLinks(workspaceContext()); await refreshInspector(); break;
    case 'locate-project-folder': await locateProjectFolder(); break;
    case 'toggle-file-folder': await toggleFolder(element.dataset.path!); break;
    case 'collapse-folders': state.openFolders = new Set(); state.folderFiles = new Map(); renderInspector(); document.querySelector<HTMLElement>('#inspector-content .file-row button')?.focus(); break;
    case 'run-project': if (!element.dataset.sessionId || element.dataset.sessionId === state.sessionId) await projectRunner.run(); break;
    case 'preview-file': await previewFile(element.dataset.path!); break;
    case 'preview-selected-file': await previewFile(state.selectedFile, selectedFileContext); break;
    case 'open-file': await openFile(element.dataset.path!, 'file'); break;
    case 'open-message-attachment': await openMessageAttachment(element); break;
    case 'view-source': await openFile(element.dataset.path!, 'file', false, workspaceContext(), true); break;
    case 'open-diff': await openFile(element.dataset.path!, 'diff', element.dataset.staged === 'true'); break;
    case 'back-inspector': state.selectedKind = ''; renderInspector(); break;
    case 'attach': await attachments.openMenu(element); break;
    case 'attach-file': attachFile(element.dataset.path!); break;
    case 'detach': state.attachments = state.attachments.filter(p => p !== element.dataset.path); renderComposer(); break;
    case 'detach-prompt': attachments.remove(state.sessionId, element.dataset.id!); break;
    case 'edit-sketch': { const image = attachments.find(state.sessionId, element.dataset.id!); if (image?.kind === 'image') await openSketch(state.sessionId, image); break; }
    case 'detach-browser': state.browserAttachments.set(state.sessionId, (state.browserAttachments.get(state.sessionId) ?? []).filter(a => a.id !== element.dataset.id)); renderBrowserAttachments(); break;
    case 'stage-file': case 'unstage-file': await stage([element.dataset.path!], name === 'stage-file'); break;
    case 'stage-all': case 'unstage-all': await stage(state.git?.files.map(f => f.path) ?? [], name === 'stage-all'); break;
    case 'toggle-diff-stage': await stage([state.selectedFile], !state.selectedStaged); break;
    case 'open-team-progress': case 'open-team-worker': {
      const taskId = element.closest<HTMLElement>('.team-progress, .council-strip, .council-summary')?.dataset.sessionId;
      if (!taskId || taskId !== state.sessionId) break;
      const view = await ensureArchitectView();
      if (taskId !== state.sessionId) break;
      if (name === 'open-team-worker' && element.dataset.workerId) await view.openWorker(element.dataset.workerId, undefined, element);
      else view.open();
      break;
    }
    case 'architect-setup': await showArchitectSetup(element); break;
    case 'team-menu': await showTeamMenu(element); break;
    case 'retry-task-load': if (state.sessionId) await selectSession(state.sessionId, true); break;
    case 'steer': await steerFromComposer(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus({ preventScroll: true }); break;
    case 'steer-edit': document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(); break;
    case 'steer-clear': {
      const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (!prompt) break;
      voiceDictation.draftCleared(state.sessionId);
      prompt.value = ''; state.drafts.set(state.sessionId, '');
      prompt.dispatchEvent(new Event('input', { bubbles: true }));
      prompt.focus();
      break;
    }
    case 'remote-retry': await retryRemoteConnection(); break;
    case 'stop': { const task = actionTask(element); if (task) { notify('Stopping task…'); await stopTask(task); } break; }
    case 'approval-allow': case 'approval-deny': await respondApproval(actionTask(element)?.id ?? state.sessionId, element.dataset.request!, name === 'approval-allow'); break;
    case 'approval-allow-all': case 'approval-deny-all': { const sessionId = actionTask(element)?.id ?? state.sessionId; for (const id of [...state.streams.get(sessionId)?.approvals.keys() ?? []]) await respondApproval(sessionId, id, name === 'approval-allow-all'); break; }
    case 'approval-group': { const id = actionTask(element)?.id ?? state.sessionId; if (!approvalGroupsOpen.delete(id)) approvalGroupsOpen.add(id); renderApprovalBar(); btwPanel.refresh(); break; }
    case 'approval-details': { const key = (actionTask(element)?.id ?? state.sessionId) + element.dataset.request; if (!approvalDetails.delete(key)) approvalDetails.add(key); renderApprovalBar(); btwPanel.refresh(); break; }
    case 'suggest': { const prompt = document.querySelector<HTMLTextAreaElement>('#prompt'); if (prompt) { prompt.value = element.dataset.text!; prompt.focus(); } break; }
  }
}
mountExternalLinks(document, url => call('open_external_url', { url }), report);
document.addEventListener('click', event => {
  const button = (event.target as Element | null)?.closest<HTMLButtonElement>('[data-shared-action]');
  if (!button || !state.sharedChannelId) return;
  const action = button.dataset.sharedAction;
  if (action === 'reassign-toggle') { const menu = button.nextElementSibling as HTMLElement | null; if (menu) { menu.hidden = !menu.hidden; button.setAttribute('aria-expanded', String(!menu.hidden)); } return; }
  const channelId = state.sharedChannelId, messageId = button.dataset.message;
  if (action === 'earlier') {
    const history = button.closest<HTMLElement>('.bc-history');
    state.sharedChannelLimits.set(channelId, (state.sharedChannelLimits.get(channelId) ?? CHANNEL_PAGE) + CHANNEL_PAGE);
    button.disabled = true;
    if (history) state.sharedChannelFromBottom = history.scrollHeight - history.scrollTop;
    run(refreshSharedChannel(channelId));
    return;
  }
  if (action === 'stop') run(call('bot_shared_channel_stop', { channelId }).then(() => refreshSharedChannel(channelId)).catch(error => notifyError(errorText(error))));
  else if (action === 'continue' && messageId) run(call('bot_shared_channel_continue', { channelId, messageId }).then(() => refreshSharedChannel(channelId)).catch(error => notifyError(errorText(error))));
  else if (action === 'reassign' && messageId && button.dataset.bot) run(call('bot_shared_channel_reassign', { channelId, messageId, botId: button.dataset.bot }).then(() => refreshSharedChannel(channelId)).catch(error => notifyError(errorText(error))));
});
document.addEventListener('click', event => { const target = event.target as Element; if (target.closest('.markdown,.streaming-content,.message-content') && !target.closest('.message-attachments')) return; const element = target.closest<HTMLElement>('[data-action]'); if (!element || element instanceof HTMLButtonElement && element.disabled) return; event.preventDefault(); run(action(element.dataset.action!, element)); });
document.addEventListener('click', event => {
  const button = (event.target as Element).closest<HTMLButtonElement>('[data-failover]');
  if (!button || button.disabled) return;
  const card = button.closest<HTMLElement>('.bot-failover'), sessionId = card?.dataset.failoverSession;
  const action = button.dataset.failover;
  if (!card || !sessionId || !botFailovers.has(sessionId) || (action !== 'send' && action !== 'wait')) return;
  event.preventDefault(); button.disabled = true;
  const always = card.querySelector<HTMLInputElement>('[data-failover-always]')?.checked ?? false;
  run((async () => {
    try {
      botFailoverErrors.delete(sessionId);
      await call('bot_failover_decide', { sessionId, action, always });
      botFailovers.delete(sessionId);
      if (state.sessionId === sessionId) renderComposer();
    } catch (error) {
      botFailoverErrors.set(sessionId, errorText(error));
      if (state.sessionId === sessionId) renderComposer();
      if (button.isConnected) button.disabled = false;
    }
  })());
});
document.addEventListener('submit', event => {
  const form = event.target as HTMLFormElement; event.preventDefault();
  if (form.id === 'shared-channel-composer' && state.sharedChannelId) {
    const channelId = state.sharedChannelId, text = String(new FormData(form).get('text') ?? '').trim();
    if (!text) return;
    state.sharedChannelDrafts.delete(channelId);
    const channel = state.sharedChannelDetail;
    const recipients = (channel?.memberIds ?? []).filter(id => {
      const name = sidebarBots.find(bot => bot.id === id)?.name;
      return Boolean(name && new RegExp(`(?:^|\\s)@${name.replace(/[.*+?^${}()|[\\]\\]/g, '\\$&')}(?=$|\\s|[^\\p{L}\\p{N}_])`, 'iu').test(text));
    }).slice(0, 2);
    state.sharedChannelPosting.add(channelId); renderComposer();
    // A failed post goes back to its own channel's draft, unless something new was typed there.
    run(call('bot_shared_channel_post', { channelId, text, ...(recipients.length ? { recipients } : {}) }).then(() => { state.sharedChannelPosting.delete(channelId); return refreshSharedChannel(channelId); }).catch(error => {
      state.sharedChannelPosting.delete(channelId);
      if (!state.sharedChannelDrafts.get(channelId)?.trim()) state.sharedChannelDrafts.set(channelId, text);
      notifyError(errorText(error));
      if (channelId === state.sharedChannelId) renderComposer();
    }));
    return;
  }
  if (form.id === 'composer') { run(send()); return; }
  const data = new FormData(form); const submitter = form.querySelector<HTMLButtonElement>('button:not([type="button"])'); if (submitter) submitter.disabled = true;
  run((async () => {
    try {
      if (form.id === 'board-task-form') { await saveBoardTaskForm(form, data); }
      else if (form.id === 'open-project-form') {
        const path = String(data.get('path') || '').trim(); if (!path) return; await addProject(path);
      } else if (form.id === 'rename-form') { const title = String(data.get('title') || '').trim(); if (!title) return; await call('update_session', { sessionId: form.dataset.sessionId || state.sessionId, title }); closeModal(); await reloadSessions(); }
      else if (form.id === 'remove-project-form') { await removeProject(form.dataset.projectId!); closeModal(); }
      else if (form.id.startsWith('worktree-')) { await worktrees.submit(form, data); }
      else if (form.id.startsWith('github-')) { await github.submit(form, data); }
      else if (form.id === 'commit-form') { const message = document.querySelector<HTMLTextAreaElement>('#commit-message')!.value.trim(); if (!message) { notify('Enter a commit message.'); return; } const result = await call<string>('git_commit', { ...workspaceContext(), message }); await refreshInspector(); notify(result || 'Changes committed'); }
    } finally { if (submitter?.isConnected) submitter.disabled = false; }
  })());
});
/** The prompt last sized while empty: an empty prompt is one line at any width, so sizing it again changes nothing
 *  and would only lay out the page (every composer render asks). */
let emptySized: HTMLTextAreaElement | undefined;
function resizePrompt(): void {
  const prompt = document.querySelector<HTMLTextAreaElement>('#prompt');
  if (!prompt) return;
  if (!prompt.value && emptySized === prompt) return;
  emptySized = prompt.value ? undefined : prompt;
  prompt.style.height = 'auto';
  const natural = prompt.scrollHeight;
  prompt.style.height = Math.min(natural, 180) + 'px';
  // Use the same measurement; a pixel of rounding at the cap must not show a scroll bar.
  const overflow = natural > 181 ? 'auto' : 'hidden';
  if (prompt.style.overflowY !== overflow) prompt.style.overflowY = overflow;
}
window.addEventListener('pandacode-ui-scale-change', () => { emptySized = undefined; resizePrompt(); });
document.addEventListener('input', event => { const input = event.target as HTMLInputElement; if (input.id === 'command-query') renderCommands(input.value); if (input.id === 'prompt') resizePrompt(); if (input.id === 'shared-channel-prompt' && state.sharedChannelId) state.sharedChannelDrafts.set(state.sharedChannelId, input.value); if (input.id === 'sidebar-filter') { state.query = input.value; renderNavigation(); } });
document.addEventListener('scroll', event => {
  if (!state.sharedChannelId) return;
  const history = (event.target as Element | null)?.closest?.('.bc-history') as HTMLElement | null;
  if (history) { state.sharedChannelScrollTop = history.scrollTop; state.sharedChannelAtBottom = history.scrollHeight - history.clientHeight - history.scrollTop < 32; }
}, true);
document.addEventListener('change', event => {
  const input = event.target as HTMLInputElement;
  if (input.id === 'daily-wallpapers') { wallpapers.setEnabled(input.checked); document.querySelector('.settings-wallpapers')?.toggleAttribute('hidden', !input.checked); }
  if (input.id === 'turn-checks') turnChecksSetEnabled(input.checked);
  // A switch toggles natively (the data-action click path cancels the default), then saves.
  if (input.classList.contains('limit-resume-switch')) run(limitAction('limit-resume-at-reset', input));
  if (input.id === 'compact-mode') { document.body.classList.toggle('compact', input.checked); localStorage.setItem('pandacode.compact', String(input.checked)); }
  if (input.id === 'expand-tool-activity') {
    localStorage.setItem('pandacode.activityExpanded', String(input.checked));
    document.querySelectorAll<HTMLDetailsElement>('.turn-activity:not(.live-activity), .tool-group:not(.is-steps .tool-group)').forEach(group => { group.open = input.checked; });
  }
});
mountTextUndo();
document.addEventListener('keydown', event => {
  if (!(event.metaKey || event.ctrlKey) || event.shiftKey || event.altKey || isImeKey(event) || event.defaultPrevented || event.code !== 'KeyB' || state.view !== 'conversation' || document.querySelector<HTMLDialogElement>('#dialog')!.open) return;
  event.preventDefault(); event.stopPropagation(); toggleSidebar();
}, true);
const threadFind = createThreadFind({
  pane: () => document.querySelector<HTMLElement>('.conversation-pane'),
  // Find asks for the transcript before each search: a query the reader gave this thread draws down to its newest
  // older match, and a closed tool whose details match draws its body so the match can be found.
  transcript: query => {
    const transcript = document.querySelector<HTMLElement>('#transcript');
    if (query) { transcriptView.showForFind(query); if (transcript) fillMatchingToolBodies(transcript, query, state.messages, (message, text) => findCounts.count(message, text, true)); }
    return transcript;
  },
  older: query => transcriptView.olderMatches(query),
  settled: () => transcriptView.countsSettled(),
  extend: (query, all, done) => transcriptView.extendFind(query, all, done),
  release: () => { stickToBottom = false; },
  openReply: keepReplyOpen,
  restoreFocus: () => document.querySelector<HTMLTextAreaElement>('#prompt')?.focus(),
});
// Capture, so the thread is noted before the bar's own handler searches.
const noteFind = (): void => transcriptView.noteFind(state.sessionId);
document.addEventListener('input', event => { if ((event.target as Element).matches?.('.thread-find input')) noteFind(); }, true);
document.addEventListener('keydown', event => { if (event.key === 'Enter' && (event.target as Element).matches?.('.thread-find input')) noteFind(); }, true);
document.addEventListener('click', event => { if ((event.target as Element).closest?.('.thread-find [data-find-step]')) noteFind(); }, true);
document.addEventListener('keydown', event => {
  // IME conversions own their keys; letter shortcuts otherwise follow the physical layout.
  if (event.defaultPrevented || isImeKey(event)) return;
  const command = (event.metaKey || event.ctrlKey) && !event.altKey;
  const dialog = document.querySelector<HTMLDialogElement>('#dialog')!;
  if (command && event.code === 'KeyK') { event.preventDefault(); showCommands(); return; }
  if (dialog.open) {
    if (dialog.classList.contains('command-dialog') && ['ArrowUp', 'ArrowDown', 'Enter'].includes(event.key) && !isImeKey(event)) {
      event.preventDefault(); const buttons = [...dialog.querySelectorAll<HTMLButtonElement>('#command-results button')]; const current = buttons.findIndex(b => b.classList.contains('command-selected'));
      if (event.key === 'Enter') buttons[Math.max(current, 0)]?.click(); else { buttons[current]?.classList.remove('command-selected'); const index = (current + (event.key === 'ArrowDown' ? 1 : -1) + buttons.length) % buttons.length; buttons[index]?.classList.add('command-selected'); buttons[index]?.scrollIntoView({ block: 'nearest' }); }
    }
    return;
  }
  if (event.key === ' ' && !command && !event.altKey && !event.shiftKey && !isImeKey(event)) {
    const summary = (event.target as Element).closest<HTMLElement>('details[data-account-switch] > summary');
    if (summary) {
      // Moving the retained notice at handoff cancels WebKit's delayed native Space activation.
      event.preventDefault(); if (!event.repeat) summary.click(); return;
    }
  }
  // ⌘F finds in the open thread; ⌘G and ⇧⌘G step through its matches.
  if (command && !event.shiftKey && event.code === 'KeyF') { if (session() && transcriptVisible()) { event.preventDefault(); noteFind(); threadFind.open(); } return; }
  if (command && event.code === 'KeyG' && threadFind.isOpen()) { event.preventDefault(); noteFind(); threadFind.step(event.shiftKey ? -1 : 1); return; }
  if (sidebarShortcut(event)) return;
  if (command && event.code === 'KeyN') { event.preventDefault(); if (state.view === 'board') showBoardTaskForm(); else run(createTask()); }
  else if (command && event.code === 'KeyJ') { event.preventDefault(); run(toggleTerminal()); }
  else if (command && event.code === 'Comma') { event.preventDefault(); run(showSettings()); }
  else if (command && event.shiftKey && event.code === 'KeyB') { event.preventDefault(); state.inspector = inspectorChosen = inspectorSuppressed || !state.inspector; inspectorSuppressed = false; renderInspector(); }
  else if (event.key === 'Enter' && (event.target as HTMLElement).id === 'prompt' && !event.shiftKey && !isImeKey(event)) {
    event.preventDefault();
    // While an agent works, Enter queues the message and Command/Ctrl Enter steers the running turn.
    if (isRunning()) run(event.metaKey || event.ctrlKey ? steerFromComposer() : enqueueFromComposer());
    else if (finishingStreams.has(state.sessionId)) run(enqueueFromComposer()); else run(send());
  }
  else if (event.key === 'Enter' && (event.target as HTMLElement).id === 'shared-channel-prompt' && !event.shiftKey && !isImeKey(event)) { event.preventDefault(); (event.target as HTMLTextAreaElement).form?.requestSubmit(); }
  else if (event.key === 'Enter' && (event.target as HTMLElement).classList.contains('queue-edit') && (event.metaKey || event.ctrlKey) && !isImeKey(event)) { event.preventDefault(); run(saveQueueEdit(actionTask(event.target as HTMLElement))); }
  // A toast the reader is in, or an urgent one (danger, Undo) that just appeared, takes Escape before Settings, the board panel and Stop do.
  else if (event.key === 'Escape' && toastVisible($('#toast')) && escapeClosesToast({ visible: true, focusInToast: $('#toast').contains(document.activeElement), urgent: $('#toast').hasAttribute('data-danger') || Boolean(toastUndo), shownAt: toastShownAt, now: Date.now(), blocked: escapeTaken(event) })) { event.preventDefault(); dismissToast(); }
  else if (event.key === 'Escape' && settingsView && !event.defaultPrevented && !document.querySelector<HTMLDialogElement>('#dialog')?.open && !document.querySelector('.floating-menu')) { event.preventDefault(); closeSettings(); }
  else if (event.key === 'Escape' && state.view !== 'conversation' && state.boardPanel && !event.defaultPrevented) { event.preventDefault(); closeMenus(); state.boardPanel = false; renderBoardView(); }
  else if (event.key === 'Escape' && (event.target as Element).closest?.('.composer-steer-bar') && !event.defaultPrevented) { event.preventDefault(); document.querySelector<HTMLTextAreaElement>('#prompt')?.focus({ preventScroll: true }); }
  else if (event.key === 'Escape' && isRunning() && !terminalPanel.open && !event.defaultPrevented) { event.preventDefault(); if (session()) run(stopTask(session()!)); }
  // Last, so menus, dialogs, the composer and Stop keep Escape; it only closes a toast nothing else wanted it for.
  else if (event.key === 'Escape' && toastVisible($('#toast')) && !escapeTaken(event)) { event.preventDefault(); dismissToast(); }
});
/** `:popover-open` is WebKit 17+ (macOS 12's WKWebView throws a SyntaxError on it): probed once, falling back to any
 * `[popover]` that has a box. The same probe as `foreground()` in voice-dictation.ts. */
let openPopoverSelector: string | undefined;
function popoverOpen(): boolean {
  if (openPopoverSelector === undefined) {
    try { document.querySelector(':popover-open'); openPopoverSelector = '[popover]:popover-open'; }
    catch { openPopoverSelector = '[popover]'; }
  }
  return [...document.querySelectorAll(openPopoverSelector)].some(node => node.getClientRects().length > 0);
}
/** Escape belongs to something else: a handler already took it, an IME is composing, or a dialog or menu is open. */
function escapeTaken(event: KeyboardEvent): boolean {
  return event.defaultPrevented || isImeKey(event) || Boolean(document.querySelector<HTMLDialogElement>('#dialog')?.open) || Boolean(document.querySelector('.floating-menu')) || popoverOpen();
}
let dialogBackdropPressed = false;
function outsideDialog(event: MouseEvent): boolean {
  const dialog = event.currentTarget as HTMLDialogElement, rect = dialog.getBoundingClientRect();
  return event.target === dialog && (event.clientX < rect.left || event.clientX > rect.right || event.clientY < rect.top || event.clientY > rect.bottom);
}
document.querySelector<HTMLDialogElement>('#dialog')!.addEventListener('pointerdown', event => { dialogBackdropPressed = outsideDialog(event); });
document.querySelector<HTMLDialogElement>('#dialog')!.addEventListener('click', event => { if (dialogBackdropPressed && outsideDialog(event)) closeModal(); dialogBackdropPressed = false; });
document.querySelector<HTMLDialogElement>('#dialog')!.addEventListener('close', disposeSettingsViews);
document.querySelector<HTMLDialogElement>('#dialog')!.addEventListener('cancel', () => { closeMenus(); openingProjectForTask = undefined; });
window.matchMedia('(max-width: 920px)').addEventListener('change', event => { if (event.matches) { state.inspector = false; renderInspector(); } });
document.addEventListener('paste', event => { if ((event.target as HTMLElement | null)?.id === 'prompt' && !document.querySelector<HTMLDialogElement>('#dialog')!.open) attachments.handlePaste(event); });
attachments.installDropZone(() => document.querySelector('#composer-area'));
installTooltips();
// Settings views render asynchronously into the dialog; fold their sublines as they land.
new MutationObserver(() => compactSublines(document.querySelector('#dialog')!)).observe(document.querySelector('#dialog')!, { childList: true, subtree: true });
window.addEventListener('focus', renderNavigation);
document.addEventListener('visibilitychange', () => { renderNavigation(); if (!document.hidden) { renderHeader(); renderStream(); } updateWorkTimer(); });
if (localStorage.getItem('pandacode.compact') === 'true') document.body.classList.add('compact');
// Material file icons arrive in a lazy chunk and have light-theme variants; markup is baked at render time.
// A full render() here would close open menus mid-click; other icon spots pick the icons up on their next render.
function refreshFileIcons(): void { if (state.inspector && state.inspectorTab === 'files' && !state.selectedFile) renderInspector(); }
async function boot(): Promise<void> {
  await subscribe('agent-event', onAgent);
  await subscribe('provider-models-changed', event => invalidateModels(event.provider));
  await subscribe('architect-event', onArchitect);
  window.addEventListener(TEAM_MODE_EVENT, () => { if (session()) renderComposer(); });
  await subscribe('sessions-deleted', event => removeDeletedSessions(event.sessionIds));
  await subscribe('sessions-changed', () => run(reloadSessions()));
  await subscribe('mirror-messages' as 'queue-changed', (event: { sessionId: string; older?: boolean }) => run(mirrorMessages(event)));
  // An agent booted or asked to show a simulator: bring the panel forward.
  // An agent started or asked to show a VM: bring the panel forward.
  run(subscribe('vm-changed', event => { if (event && !Array.isArray(event) && event.show) openVm(); void vmPanel?.refresh(); }).then(() => undefined));
  run((subscribe as (name: string, callback: () => void) => Promise<() => void>)('design-changed', () => void designPanel?.refresh()).then(() => undefined));
  run(subscribe('agent-event', (event: AgentEvent) => {
    if (event.kind !== 'done') return;
    if (event.sessionId !== state.sessionId) return;
    void designPanel?.refresh();
    progressPip?.refresh(event.sessionId);
    if (document.hasFocus()) markTraySeen(event.sessionId);
  }).then(() => undefined));
  run((subscribe as (name: string, callback: (event: unknown) => void) => Promise<() => void>)('tray-open-session', sessionId => run((async () => {
    if (typeof sessionId !== 'string') return;
    if (!state.sessions.some(s => s.id === sessionId)) await reloadSessions();
    if (state.view !== 'conversation') state.boardPanel = true;
    await selectSession(sessionId, true);
  })())).then(() => undefined));
  run((subscribe as (name: string, callback: (event: { sessionId?: string } | null) => void) => Promise<() => void>)('progress-changed', event => progressPip?.refresh(event?.sessionId)).then(() => undefined));
  run(subscribe('simulator-changed', event => { if (event?.show) openSimulator(); void simulatorPanel?.refresh(); }).then(() => undefined));
  run(subscribe('bots-changed', () => run((async () => { botProjectsLoad = reloadBotProjects(); await botProjectsLoad; botsView?.refresh(); })())).then(() => undefined));
  run(subscribe('bot-shared-channel-changed', event => { run(reloadBotProjects(false)); if (state.sharedChannelId && (!event?.channelId || event.channelId === state.sharedChannelId)) void refreshSharedChannel(); }).then(() => undefined));
  run(subscribe('bot-messages-changed', () => {
    botThreadMetaLoaded.clear();
    const bot = botForThread();
    if (bot && state.sessionId) void refreshBotThreadMeta(bot, state.sessionId, true);
  }).then(() => undefined));
  run(initRemote());
  run(initCloudAgents());
  run(initOrchestration({ call, listen: (name, callback) => (subscribe as (name: string, callback: (event: any) => void) => Promise<() => void>)(name, callback), notify, notifyError, modal, closeModal, openSession: id => run(selectSession(id, true)), sessionId: () => state.sessionId, running: () => isRunning(), visible: () => !$('.conversation-pane').hidden, title: id => state.sessions.find(s => s.id === id)?.title }));
  run(subscribe('bot-notification', event => { if (event?.text) notify(String(event.text).replace(/\s+/g, ' ').slice(0, 160)); }).then(() => undefined));
  run(subscribe('bot-failover', (ask: FailoverAsk) => {
    if (!ask?.sessionId) return;
    botFailovers.set(ask.sessionId, ask);
    if (state.sessionId === ask.sessionId) renderComposer();
  }).then(() => undefined));
  run(subscribe('bot-model-switch', (event: { botId?: string; at?: number; text?: string; detail?: Record<string, unknown> }) => {
    const sessionId = typeof event?.detail?.sessionId === 'string' ? event.detail.sessionId : '';
    const bot = sidebarBots.find(item => item.id === event?.botId);
    if (!sessionId || !bot) return;
    const activity: BotActivity = { id: Number(event.at) || Date.now(), kind: 'model-switch', summary: event.text ?? '', detail: event.detail ?? {}, at: Number(event.at) || Date.now() };
    botSwitches.set(sessionId, mergeBotSwitches(botSwitches.get(sessionId) ?? [], [activity]));
    if (state.sessionId === sessionId) renderTranscript(true);
    void refreshBotThreadMeta(bot, sessionId, true);
  }).then(() => undefined));
  // Bots appear in the sidebar once loaded; startup does not wait for them.
  botProjectsLoad = reloadBotProjects(false); run(botProjectsLoad);
  run(subscribe('bot-pairing', event => { if (event?.code) notify(`${event.senderName || 'Someone'} wants to talk to a bot. Approve code ${event.code} in Bots.`, undefined, { important: true }); }).then(() => undefined));
  // Wake-ups for the open thread and the sidebar's clocks; refreshed on schedules-changed.
  // Motion only when the user opens these: a remembered thread or a redraw restores them still.
  document.addEventListener('click', event => {
    const target = event.target as Element;
    target.closest('.turn-changes summary')?.parentElement?.setAttribute('data-opened', '');
    // schedules-thread.ts paints synchronously in its own click listener, so the body exists by the next frame.
    if (target.closest('[data-wake="expand"]')) requestAnimationFrame(() => { const body = document.querySelector<HTMLElement>('#wake-body'); if (body) settleUnfolded(body); });
  });
  run(initWakeups({
    sessionId: () => state.sessionId, showChoices, notify, report, changed: scheduleNavigation,
    openSettings: intent => run(showSettings('schedules', intent)),
  }));
  // Agents can queue or remove follow-ups through their tools; an idle, unheld task sends right away.
  await subscribe('queue-changed', payload => run((async () => {
    const id = payload?.sessionId; if (!id) return;
    setQueue(id, await call<QueuedMessage[]>('queue_list', { sessionId: id }));
    if (id === state.sessionId) renderComposer();
    await dispatchQueue(id);
  })()));
  await subscribe('overlay-open-task', event => run((async () => {
    const request = ++overlayOpenRequest, initialGeneration = state.generation;
    await reloadSessions();
    if (request !== overlayOpenRequest || initialGeneration !== state.generation) return;
    if (state.view !== 'conversation') state.boardPanel = true;
    await selectSession(event.sessionId, true);
    if (request !== overlayOpenRequest || state.sessionId !== event.sessionId) return;
    const generation = state.generation;
    subagents.close(false); architectView?.close();
    if (event.workerId) {
      const view = await ensureArchitectView();
      if (request !== overlayOpenRequest || generation !== state.generation) return;
      await view.openWorker(event.workerId, event.subagentId);
    } else if (event.subagentId) {
      await subagents.showAgent(event.subagentId);
    }
  })()));
  await connectAgentUiActions(() => transcriptVisible() ? state.sessionId : '', performAgentUiAction);
  [state.projects, state.sessions, state.providers] = await Promise.all([call<Project[]>('list_projects'), call<Session[]>('list_sessions'), call<Provider[]>('list_providers')]);
  projectsListed = true;
  replayDismissals();
  run(call<import('./connections').ConnectionSnapshot>('connections_list').then(onNamedConnections));
  // Queues from an earlier launch wait for an explicit Resume.
  for (const entry of await call<QueuedMessage[]>('queue_list').catch(() => [])) {
    state.queues.set(entry.sessionId, [...(state.queues.get(entry.sessionId) ?? []), entry]);
    state.queueHolds.set(entry.sessionId, 'restart');
  }
  scheduleLimitResumes();
  if (state.projectFilter && !state.projects.some(p => p.id === state.projectFilter)) setProjectFilter('');
  const savedProject = localStorage.getItem('pandacode.project');
  const recent = state.sessions.find(s => !s.archived);
  activateProject(state.projects.find(p => p.id === savedProject)?.id ?? recent?.projectId ?? state.projects[0]?.id ?? '');
  const first = state.sessions.find(s => !s.archived && s.projectId === state.projectId);
  // selectSession bumps the generation before its first await; a later bump means the user picked a task meanwhile.
  const selecting = first ? selectSession(first.id) : undefined, bootGeneration = state.generation;
  if (selecting) await selecting; else { render(); await refreshInspector(); }
  run(fileIconsReady.then(refreshFileIcons));
  window.addEventListener('pandacode-theme-change', refreshFileIcons);
  if (state.view !== 'conversation' && state.generation === bootGeneration) { state.boardPanel = false; renderInspector(); renderBoardView(); }
  if (!preview && !state.providers.some(p => p.installed)) notify('Open Settings to check your installed agent CLIs.');
}
// PandaCode's own updates: checked on GitHub Releases, installed when no agent is working.
mountUpdatePill($('#update-status') as HTMLButtonElement, startAppUpdates({ busy: () => state.sessions.some(task => isRunning(task.id)), notify, notifyError }));
const agentUpdates = initializeAgentUpdates({
  modal, closeModal, report, providers: () => state.providers,
  providersChanged: async () => { await discoverSettingsProviders(); refreshModelLabels(); slashPicker?.refresh(true); },
});
window.addEventListener('pagehide', () => agentUpdates.dispose(), { once: true });
renderThemeToggle(); render(); renderInspector();
// A failed boot still ends in a usable empty state (its error is reported by run()).
bootPending = boot().finally(() => { bootPending = undefined; if (!projectsListed) { projectsListed = true; render(); } });
run(bootPending);
// The diff engine (module, highlighter workers, themes) starts right after the first paint.
preloadDiffsAfterPaint();
if (!preview) initializeNativeAppearance();
