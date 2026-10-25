import { decodeHandoff, historicalProvider } from './provider-handoff';
import { ACCOUNT_SWITCH_PREFIX, accountSwitchDetail } from './account-switch-note';
import { revealSetting } from './settings-reveal';
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
import { watchErrorDockOverlap } from './error-dock-overlap';
import { setDocumentView } from './document-viewer';
import { onQueueReorder, queuePanel, type HoldReason, type QueuedMessage } from './message-queue';
import { initWakeups, openWakeComposer, scheduledMark, schedulesVersion, wakeCommand, wakeGlyph, wakeStrip } from './schedules-thread';
import { TRACE_HEADER } from './schedules-api';
import { afterRun as turnChecksAfterRun, enabled as turnChecksEnabled, noteManualSend, setEnabled as turnChecksSetEnabled } from './turn-checks';
import { limitActive, limitBanner, resetLabel } from './usage-limit';
import { cascade, enterView, glideIn, glideOut, hidePanel, hideToast, holdDim, installDialogMotion, materializeIn, materializeOut, publishSpringEasings, releaseHold, syncPulses, revealIn, settleIn, showPanel, showToast } from './motion';
import { teamSignature, updateTeamProgress } from './team-progress';
import { installedCatalog, setTeamRecency } from './team-catalog';
import { classicTeamSetup, isTeam, namedTeams, sameTeamSetup, teamDetail, TEAM_MODE_EVENT } from './team-mode';
import { renderCoordination } from './coordination-message';
import { renderTurnChanges, turnChangesFoot, changeRequest, captureChangeCards, restoreChangeCards, isCombined, mountCombinedReview } from './turn-changes';
import { SKELETON_HTML, bridgeCard, fadeInFoot, fadeInReply, holdCard, keepReplyOpen, onReplyCollapse, openReply, measureReplies, replyHtml, replyOpen, syncReplyClamp, timeHtml, watchReplies } from './turn-card';
import { mountWallpapers } from './wallpapers';
import { mountSky } from './sky-window';
import { mountThreadTiles } from './thread-tiles';
import { parseSkyTime } from './sky-math';
import type { AgentEvent, BrowserAttachment, ContextUsage, FileEntry, GitStatus, Message, MessagePage, Mode, Project, Provider, ProviderId, ProviderModel, Session, TaskLink, TaskStage, ToolActivity, TurnChanges, TurnChangeDiff } from './types';
import type { BrowserPanel } from './browser';
import { call, chooseFolder, nativeDesktop, preview, subscribe, webMode } from './bridge';
// Take the access token out of the address bar as early as possible.
if (webMode) void import('./web-bridge');
/** Opens a link for the person at this screen; in a browser tab `call` opens it there (bridge.ts). */
function openExternalUrl(url: string): Promise<void> {
  return call<void>('open_external_url', { url });
}
import { isNetworkPath, MAX_RETRIES, NETWORK_PATH_ERROR, retryLater, toolImageCache, type ToolImageLoader } from './tool-images';
import { attachToolImages, REVEAL_LABEL } from './tool-image-viewer';
import { jjChip, showJjPanel, type JjStatus } from './jj';
import { $, button, escape, fileIcon, fileIconsReady, icon, isImeKey, markdown, markdownCache, markdownHtml, morph, showsHtml, type MarkdownOptions } from './dom';
import { MORE_TURNS, ROWS_MARGIN, ROW_BUDGET, drawRows, markupCache, parseRow, rowsIntact, swapRowNodes, turnIds, untouchedFields, viewIndex, windowAnchor, windowShort, windowStart, type DrawnRow } from './transcript-rows';
import { LAZY_REPLY_CHARS, drawnFrom, lazyMarkdown, prepareMarkdown, touchedRows } from './transcript-window';
import { leftRowsCache, leftViews, mountTileWindows, mountTranscriptView } from './transcript-view';
import { botAvatarHtml } from './bot-avatars';
import * as botThread from './bot-thread';
import type { Activity as BotActivity, FailoverAsk } from './bots';
import { mountExternalLinks } from './external-links';
import { mountDesktopBrand } from './brand-mark';
import { starPanda } from './star-panda';
import { PROJECT_LINKS } from './about-settings';
import { bindMessageActions, messageActionsHtml } from './message-actions';
import { providerLogo } from './provider-logos';
import { decodeToolActivity, groupToolRuns, renderToolActivity, renderToolGroup, renderToolStatus, toolStackHtml } from './tool-activity';
import { describeTool, kindIcon, summarizeTools, toolKind, traceRowHtml } from './tool-trace';
import { choreograph, enterHeader, enterText, foldTurn, foldWait, readingTrace, revealRow } from './trace-motion';
import { groupTurns, normalizeCardTurns, mergeLeadTurns, splitLiveExchange, combineChanges, formatDuration, turnLabel, type TranscriptTurn } from './turn-activity';
import { initializeNativeAppearance } from './appearance';
import { currentTheme, setTheme } from './theme';
import { languagePref, setBeforeLanguageReload, takeComposerDrafts, COMPOSER_DRAFT_PREFIX, t } from './i18n.ts';
import { palette } from './palette';
import { contextSummary, fallbackModel, parseContextUsage, tokenCount } from './model-catalog';
import { openCodeChoices, type OpenCodeModels } from './preview-opencode';
import { SECTIONS } from './settings-sections';
import { MODE_TONES, approvalMode, approvalModes, toned, type ApprovalMode } from './approval-modes';
import { syncTrayState } from './tray-motion';
import { renderTaskBoard, renderTaskDetails, taskStage } from './task-board';
import { streamMarkdown } from './streaming-markdown';
import { TerminalPanel } from './terminal-panel';
import { ProjectRunner } from './run-project';
import { canNestedScrollerConsume, captureTranscriptAnchor, createSmoothScroller, decideScrollTransition, followTranscriptBottom, onAnchorRestore, shouldWheelRestick } from './transcript-scroll';
import { mountThreadScrollIndicator, type ThreadScrollIndicator, type ThreadScrollSnapshot } from './thread-scroll-indicator';
import type { ScrollTurnSummary } from './thread-scroll-model';
import { Subagents } from './subagents';
import { JevActivity } from './jev-activity';
import { initializeSidebarResizing } from './sidebar-resize';
import { changeUiScale, initializeUiSizing, setUiScale } from './ui-size';
// Applies the saved reading width before Settings (a lazy import) ever renders it.
import './reading-width';
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
import { createFileExplorer, noteFilePollActivity, noteFilePollChange, setFilePollMounted } from './file-explorer';
import { bindFileLinkContext, configureFileLinks, isPreviewableFile, refreshFileLinks, type FileLinkContext, type ResolvedFile } from './file-links';
import { createWorktrees } from './worktrees';
import { createGithub, githubEnabled } from './github';
import { mountUpdatePill, startAppUpdates } from './app-updates';
import { heldBackOpened, showCrashRecovery, takeCrashRecovery, tasksChanged } from './crash-recovery';
import { addToastClose, labelToastShortcut, wireToastKeys } from './toast-keys';
import { keepToastClear } from './toast-clearance';
import { NEW_TASK_DRAFT, PersistedDrafts, browserDraftTimer, flushDraftsOnLeave, channelDraftKey, dropRemovedChannelDrafts, WINDOW_STABLE_AFTER, beginThreadRestore, dropDeletedDrafts, dropRemovedProjectDrafts, expireDraftsWhileRunning, finishThreadRestore, finishThreadRestoreAfterPaint, leavePage, rememberOpenThread, threadToReopen, windowContentDied, windowStable } from './launch-restore';
import { mountTextUndo } from './text-undo';
import { projectIconHtml } from './project-icons';
import { createPullView } from './github-pull';
import { createSearchPanel } from './search-panel';
import { createTokenSaver } from './token-saver-panel';
import { createCouncil } from './council-panel';
import { councilNotice } from './council';
// No CSS of its own (architect.css arrives with ./architect): safe in the always-loaded bundle.
import { workerActive } from './architect-worker-list';
import { MAX_IMAGES, mountPromptAttachments, type PromptImage } from './attachments';
import { attachmentChips, parseAttachments } from './message-attachments';
import { compactSublines, infoMark, installTooltips } from './tooltip';
import { isMac, shortcut } from './platform';
import { createGoalBanner, showGoalDialog, showCommandCenter, type GoalState, type GoalAction, type CommandPanel } from './command-center';
import { LEAD_RETRY, teamActive, teamHeldUntil, type TeamSnapshot, type TeamEvent, type TeamLibrary, type TeamProfile, type TeamConfig, type WorkerProfile } from './architect-types';
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
import { noteChangedPaths, preloadDiffsAfterPaint, preloadDiffsWhenWanted } from './diff-prefetch';
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
/** Inspector tabs only. Open files live in the floating editor, not in this strip. */
type PanelView = InspectorView;
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
  attachments: [] as string[], drafts: new PersistedDrafts(localStorage, Date.now, browserDraftTimer), defaultProvider: (localStorage.getItem('pandacode.defaultProvider') ?? localStorage.getItem('pandacode.provider') ?? 'claude') as ProviderId,
  browserAttachments: new Map<string, BrowserAttachment[]>(),
  moodboardAttachments: new Map<string, { id: string; projectId: string; name: string }[]>(),
  generation: 0, hasOlder: false,
  sharedChannelId: '', sharedChannelDetail: null as SharedChannelDetail | null, sharedChannelRequest: 0,
  sharedChannelLimits: new Map<string, number>(), sharedChannelFromBottom: null as number | null, sharedChannelScrollTop: 0, sharedChannelAtBottom: true, sharedChannelPosting: new Set<string>(),
};
let renderFrame = 0;
/** Shows the open thread's scene behind the conversation (set once the sky mounts; `renderTranscript` calls it). */
let showThreadScene: (id: string | null) => void = () => {};
// A language switch reloads the window: carry every session's unsent text across it.
setBeforeLanguageReload(() => {
  try {
    for (const [id, text] of state.drafts) {
      if (text.trim()) sessionStorage.setItem(COMPOSER_DRAFT_PREFIX + id, text);
    }
  } catch { /* best effort */ }
});
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
const teamToggles = new Set<string>();
/** True while a non-provisional session mutation or Team toggle is in flight. */
const taskBusyConfiguring = (id: string): boolean => configuringSessions.has(id) || teamToggles.has(id);
/** True while either a non-provisional session mutation, a Team toggle, or an automatic provisional harness correction is in flight. */
const configuringSession = (id: string): boolean => taskBusyConfiguring(id) || provisionalCorrections.has(id);
const modelCatalogs = new Map<ProviderId, { expires: number; pending: Promise<ProviderModel[]> }>();
let slashPicker: ReturnType<typeof mountSlashCommands> | undefined;
let fileMentionPicker: ReturnType<typeof mountFileMentions> | undefined;
let boardMentionPicker: ReturnType<typeof mountFileMentions> | undefined;
let modelPickerCleanup: (ReturnType<typeof import('./model-picker').openModelPicker> & { taskId?: string }) | undefined;
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
/** The thread's Colab runtimes pip (colab-pip.ts). `colabInUse`: Colab is connected or a `colab-runtime` event arrived. */
let colabPip: import('./colab-pip').ColabPip | undefined, colabPipLoading: Promise<void> | undefined, colabInUse = false;
let browserLifecycle = Promise.resolve();
let browserOwner = '', browserRevision = 0, inspectorSuppressed = false;
/** The user's last explicit inspector show or hide, kept across launches. Visibility is global across tasks, while each
 * task remembers its own tab, folders, selected diff/file, and browser URL. */
const INSPECTOR_CHOSEN_KEY = 'pandacode.inspector.chosen';
let inspectorChosen = (() => {
  try { return localStorage.getItem(INSPECTOR_CHOSEN_KEY) !== 'false'; } catch (cause) { console.warn('Could not read the inspector choice', cause); return true; }
})();
function chooseInspector(open: boolean): boolean {
  inspectorChosen = open;
  try { localStorage.setItem(INSPECTOR_CHOSEN_KEY, String(open)); } catch (cause) { console.warn('Could not save the inspector choice', cause); }
  return open;
}
type ThreadPanel = { workspace: string; tab: typeof state.inspectorTab; folders: string[]; file: string; kind: typeof state.selectedKind; staged: boolean; context?: FileLinkContext; browserUrl: string };
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
    architectView = new ArchitectView({ setup: anchor => run(showArchitectSetup(anchor)), loadModels, updated: onArchitect, report, onFork: forkAtMessage, fileContext: sessionId => ({ projectId: state.projectId, sessionId }), assist: (sessionId, kind) => run(openJevAssist(kind, sessionId)), remote: sessionId => Boolean(state.sessions.find(task => task.id === sessionId)?.remoteDevice), leadMode: sessionId => state.sessions.find(task => task.id === sessionId)?.mode ?? null });
    architectView.setAssistEnabled(jevDecisionsEnabled);
    $('#subagents-host').before(architectView.host);
    architectView.setTask(state.sessionId, teams.get(state.sessionId) ?? null, state.providers);
    return architectView;
  });
}
function onArchitect(team: TeamEvent): void {
  if (deletedSessions.has(team.sessionId)) return;
  if ('removed' in team) { teams.set(team.sessionId, null); if (team.sessionId === state.sessionId) { architectView?.setTask(team.sessionId, null, state.providers); renderComposer(); syncTeamRows(); } return; }
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
  if (team.sessionId === state.sessionId) {
    scheduleTeamRender(wasActive !== teamActive(team));
    if (!current || current.workers.length !== team.workers.length || team.workers.some((worker, index) => worker.createdAt !== current.workers[index].createdAt)) syncTeamRows();
  }
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
  if (pendingMenuOpen?.anchor === anchor) { cancelPendingMenu(); return; }
  if (architectSetupCleanup) { architectSetupCleanup(); return; }
  const task = session(); if (!task || taskBusyConfiguring(task.id)) return;
  if (task.remoteDevice) { notify(mirrorTeamNote(task)); return; }
  closeMenus();
  const request = ++architectSetupRequest;
  scheduleLimitResumes();
  if (state.projectFilter && !state.projects.some(p => p.id === state.projectFilter)) setProjectFilter('');
  const savedProject = localStorage.getItem('pandacode.project');
  // The thread open at the last exit (clean or a crash) comes back; otherwise the newest one.
  const { task: reopened, stuck, stuckNotLast, newTask: lastNewTask, fallback, windowDiedAgain } = threadToReopen(localStorage, state.sessions.filter(s => state.projects.some(p => p.id === s.projectId)), { crashed: Boolean(recovery), paused: recovery?.restartsPaused ?? false, windowDied });
  windowDeath = windowDiedAgain ? windowDied ? 'again' : 'before' : windowDied ? 'reloaded' : undefined;
  // A thread whose opening took the app down last time is not opened by itself again.
  const candidates = state.sessions.filter(s => !s.archived && s.id !== stuck);
  heldBackThread = stuck ? state.sessions.find(s => s.id === stuck && !s.archived) : undefined;
  heldBackNotLast = Boolean(stuckNotLast);
  const recent = candidates[0];
  // A New task open at exit comes back with its kept text, even when boot holds threads back (it has
  // no transcript to suspect); otherwise, after repeated crashes, nothing opens by itself.
  const newTask = lastNewTask ? state.projects.find(p => p.id === savedProject)?.id : undefined;
  bootOpenedNothing = !fallback && !newTask;
  activateProject(reopened?.projectId ?? newTask ?? state.projects.find(p => p.id === savedProject)?.id ?? recent?.projectId ?? state.projects[0]?.id ?? '');
  // A remembered New task whose project is gone (removed elsewhere) falls back like any launch.
  const first = reopened ?? (fallback && !newTask ? candidates.find(s => s.projectId === state.projectId) : undefined);
  if (newTask) run(createTask(newTask));
  // selectSession bumps the generation before its first await; a later bump means the user picked a task meanwhile.
  const selecting = first ? selectSession(first.id, false, true) : undefined, bootGeneration = state.generation;
  showCrashNotice();
  // CLI version probes start behind the initial thread's own IPCs and must not hold the task list, thread or composer.
  const providerGeneration = settingsDiscoveryGeneration;
  const providersReady = providerDiscovery = call<Provider[]>('list_providers').then(providers => {
    if (providerGeneration !== settingsDiscoveryGeneration) return;
    state.providers = providers;
    render(); refreshModelLabels(); slashPicker?.refresh(true);
    if (!preview && !providers.some(p => p.installed)) notify(t('Open Settings to check your installed agent CLIs.'));
  });
  run(providersReady.finally(() => { providerDiscovery = undefined; }));
  // openThread marks the thread until it has painted and clears the mark when it fails.
  let selectionError: unknown;
  let selectionFailed = false;
  try {
    if (selecting) await selecting; else { render(); await refreshInspector(); }
  } catch (error) {
    selectionError = error;
    selectionFailed = true;
  }
  // Secondary background listeners and integrations start once the usable screen is up.
  run(call<import('./connections').ConnectionSnapshot>('connections_list').then(onNamedConnections));
  run(subscribe('vm-changed', event => { if (event && !Array.isArray(event) && event.show) openVm(); void vmPanel?.refresh(); }).then(() => undefined));
