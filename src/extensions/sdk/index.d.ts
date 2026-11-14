/** Public API 1.0.0, experimental. Type-only package; the supervised host supplies the API.
 * No Tauri/DOM/database/credential bridge. API grants are NOT an OS sandbox.
 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Disposable = { dispose(): void };
/** Closed declarative Changes recipe; no executable Git or content service. */
export interface ChangesComponent { readonly id: string; readonly title: string; readonly slot: 'panda.changes'; readonly contractVersion: 1; readonly presentation: 'commit-first'; readonly capabilities: readonly ['host-diff', 'host-commit', 'original-actions'] }
export interface ChangesControl { readonly id: string; readonly label: string; readonly enabled: boolean; readonly selected?: boolean }
export interface ChangesFile { readonly id: string; readonly diffId: string; readonly revision: number; readonly staged: boolean; readonly load: 'idle' | 'loading' | 'loaded' | 'error'; readonly hunks: readonly { readonly id: string; readonly revision: number }[]; readonly controls: readonly ChangesControl[] }
export interface ChangesPresentation { readonly contractVersion: 1; readonly context: string; readonly repository: string; readonly revision: number; readonly scope: 'all' | 'staged' | 'unstaged'; readonly selected: string; readonly focused: string; readonly loading: boolean; readonly error: boolean; readonly offline: boolean; readonly visible: boolean; readonly pending: boolean; readonly truncated: boolean; readonly files: readonly ChangesFile[]; readonly controls: readonly ChangesControl[] }
export interface ChangesAction { readonly contractVersion: 1; readonly context: string; readonly repository: string; readonly revision: number; readonly fileId: string; readonly diffId: string; readonly fileRevision: number; readonly hunkId: string; readonly hunkRevision: number; readonly controlId: string; readonly requestId: string }
export type ChangesResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'InvalidArguments' | 'UnsupportedCapability' | 'StaleContext' | 'WrongOwner' | 'PermissionDenied' | 'Revoked' | 'Busy' | 'AlreadyApplied' };
/** Closed declarative recipe; no executable renderer or document-content grant. */
export interface DocumentComponent { readonly id: string; readonly title: string; readonly slot: 'panda.documents'; readonly contractVersion: 1; readonly presentation: 'viewer-first'; readonly capabilities: readonly ['host-tabs', 'host-viewer', 'original-actions'] }
export interface DocumentPresentation {
  readonly contractVersion: 1; readonly context: string; readonly revision: number;
  readonly selected: string; readonly focused: string; readonly visible: boolean;
  readonly tabs: readonly { readonly id: string; readonly documentId: string; readonly label: string; readonly controls: readonly { readonly id: string; readonly label: string; readonly enabled: boolean; readonly selected?: boolean }[] }[];
}
export interface DocumentAction { readonly contractVersion: 1; readonly context: string; readonly revision: number; readonly tabId: string; readonly documentId: string; readonly controlId: string }
export type DocumentResult = { readonly ok: true } | { readonly ok: false; readonly reason: 'InvalidArguments' | 'UnsupportedCapability' | 'StaleContext' | 'Revoked' };
/** Manifest-owned executable provider, experimental; only role-scoped core team tools. */
export type ProviderMetadata = { modes: ('ask' | 'auto' | 'plan' | 'full')[]; authentication: string; teams?: boolean; readiness: { state: 'ready' | 'signedOut' | 'unavailable'; reason: string }; icon?: string; usage: { context: boolean; limitsReason: string } };
export type ProviderDiscoveryRoot = { kind: 'skills' | 'rules' | 'config'; scope: 'user' | 'project'; path: string };
export type ProviderDescriptor = { apiVersion: 1; id: string; name: string; metadata?: ProviderMetadata; discovery?: ProviderDiscoveryRoot[]; models: { id: string; name: string; efforts: string[]; contextWindow?: number }[] };
export type ProviderRun = Readonly<{ apiVersion: 1; id: string; version: string; digest: string; model: string; effort: string | null; mode: 'ask' | 'auto' | 'plan' | 'full'; resumeId: string | null; prompt: string; instructions: string; teamTools: readonly Json[] }>;
export type ProviderInput = { kind: 'approval'; approved: boolean } | { kind: 'question'; response: Json } | { kind: 'steer'; id: string; text: string };
export type ProviderEvent = { kind: 'text' | 'thinking'; text: string } | { kind: 'session'; id: string } | { kind: 'approval'; text: string } | { kind: 'question'; questions: Json } | { kind: 'usage'; usedTokens: number; contextWindow?: number } | { kind: 'tool'; tool: { id: string; name: string; status: 'running' | 'completed' | 'failed'; input: string; output: string; writePaths?: string[] } };
export type ProviderHandler = (run: ProviderRun, core: Readonly<{ emit(event: ProviderEvent): Promise<null>; nextInput(): Promise<ProviderInput>; teamTool(name: string, arguments_: { readonly [key: string]: Json }): Promise<Json> }>) => Promise<void>;
export type ServicePayloadSchema = { type: 'null' | 'string' | 'integer' | 'boolean' };
export type ServiceDescriptor = { id: string; version: string; methods: { id: string; inputSchema: ServicePayloadSchema; outputSchema: ServicePayloadSchema; eventSchema: ServicePayloadSchema }[] };
export type ServiceCall = { schemaVersion: 1; request: string; state: 'running' | 'settled'; events: { sequence: number; value: Json }[]; output: Json; error: string | null };
export interface InvocationContext {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly windowId: string;
  readonly surfaceId: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly selection?: Json;
  readonly revision: number;
  /** Set when the command runs from a main-dialog band: the dialog it was captured in, never the current one. */
  readonly dialog?: MainDialogId;
}
/** Eligible main-window dialogs (`panda.dialog.<id>.actions` / `.bodyExtras`): shared modals, then module-owned and directly mounted dialogs. Destructive, credential, permission and recovery dialogs have no ID. */
export type MainDialogId = 'recipes' | 'attachment' | 'task-details' | 'subagents' | 'task-status' | 'integrations-fallback' | 'working-directory' | 'changed-files' | 'open-project' | 'rename-task' | 'colors' | 'wallpapers' | 'opencode-models' | 'moodboards' | 'integrations' | 'jev-settings' | 'jev-assist' | 'jev-tests' | 'conversation-import' | 'bots' | 'bot-settings' | 'usage' | 'command-palette'
  | 'agent-updates' | 'channel-create' | 'channel-settings' | 'github-import' | 'github-pr' | 'github-link' | 'sketch' | 'worktree-create' | 'command-center' | 'progress-lightbox' | 'team-model-add';
/** `contributes.dialogExtras[]` (at most 64): owner-labelled plain text in the dialog's extension band; 8 per dialog are shown. */
export interface DialogExtra { readonly id: string; readonly dialog: MainDialogId; readonly text: string }
/** Captured once when an eligible main dialog opens; `project`/`task` are opaque handles, empty when none. */
export interface DialogAccessory { readonly contractVersion: 1; readonly window: 'main'; readonly dialog: MainDialogId; readonly mount: string; readonly revision: number; readonly project: string; readonly task: string; readonly target: 'none' | 'task' | 'project' }
export type DialogAccessoryAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' };
export type ContextResource = 'projects' | 'tasks' | 'harnesses' | 'connections' | 'jobs';
export interface SummaryItem {
  readonly id: string; readonly name?: string; readonly projectId?: string; readonly status?: string;
  readonly installed?: 'Installed' | 'Absent' | 'Unknown'; readonly version?: string | null;
  readonly capabilities?: readonly string[]; readonly authentication?: string;
}
export interface SummaryPage {
  readonly schemaVersion: 1; readonly state: 'Ready' | 'NoProject'; readonly revision: string;
  readonly items: readonly SummaryItem[]; readonly nextCursor: number | null;
}
export interface ContextStream {
  readonly schemaVersion: 1; readonly subscription?: string; readonly cursor: string;
  readonly snapshot: SummaryPage | null;
  readonly events: readonly { readonly sequence: number; readonly revision: string; readonly id: string; readonly kind: 'progress' | 'terminal'; readonly status: string }[];
  readonly resync: boolean;
}
export type DialogField = { readonly id: string; readonly label: string } & (
  { readonly kind: 'text'; readonly value?: string; readonly required?: boolean; readonly minLength?: number } |
  { readonly kind: 'switch'; readonly value?: boolean } |
  { readonly kind: 'select'; readonly options: readonly { readonly value: string; readonly label: string; readonly disabled?: boolean }[]; readonly required?: boolean; readonly multiple?: boolean; readonly async?: boolean; readonly placeholder?: string }
);
export interface DialogDefinition {
  readonly title: string; readonly fields: readonly DialogField[]; readonly confirmLabel?: string;
  readonly confirmation?: string; readonly successMessage: string; readonly cancelMessage?: string;
}
export interface PandaCode {
  /** Host-granted public exports only. Poll drains at most 32 events; dispose cancels owned work. */
  readonly services: {
    start(options: { service: string; version: string; method: string; input: Json }): Promise<ServiceCall>;
    poll(options: { request: string }): Promise<ServiceCall>;
    dispose(options: { request: string }): Promise<null>;
  };
  readonly apiVersion: '1.0.0';
  /** Invocation-scoped opaque API; credentials are entered only in host UI. No raw HTTP
   * strings/headers are returned. This does not constrain trusted code's independent OS access. */
  readonly connections: {
    status(options: ConnectionResource): Promise<ConnectionStatus>;
    start(options: ConnectionResource & { credential: string }): Promise<ConnectionRequest>;
    poll(options: ConnectionResource & { request: string }): Promise<ConnectionRequest>;
    cancel(options: ConnectionResource & { request: string }): Promise<ConnectionRequest>;
  };
  /** Manifest-declared tool, captured project and host-UI authorization only; no PID/cwd/executable input. */
  readonly jobs: {
    start(options: { tool: string; args: readonly string[] }): Promise<OwnedJob>;
    poll(options: { tool: string; job: string }): Promise<OwnedJob>;
    cancel(options: { tool: string; job: string }): Promise<OwnedJob>;
  };
  /** Supported API isolation only. Trusted native code can independently access user files.
   * Requires declared storage.private and explicit persisted user consent for this version.
   * All subscriptions end with activation, disable, trust/grant revocation or uninstall. */
  readonly storage: PrivateStorage;
  readonly commands: {
    /** Registers only this captured, manifest-declared activation command. Disposed on completion. */
    register(id: string, handler: (context: InvocationContext) => void | Promise<void>): Disposable;
  };
  readonly context: {
    /** Rejects with a stable broker error code if consent, scope, revision or limits fail. */
    query(options: { resource: ContextResource; limit?: number; cursor?: number; revision?: string }): Promise<SummaryPage>;
    subscribe(options: { resource: ContextResource; limit?: number; requestId: string }): Promise<ContextStream>;
    events(options: { subscription: string; cursor: string }): Promise<ContextStream>;
    unsubscribe(options: { subscription: string }): Promise<null>;
  };
  readonly ui: {
    /** Stages one validated dialog; displayed only after successful completion and reauthorization.
     * Resolves on admission, NOT on the user's answer. No live callback/DOM access is implied. */
    showDialog(dialog: DialogDefinition): Promise<null>;
  };
}
export type Activate = (panda: PandaCode, context: InvocationContext) => void | Promise<void>;
export interface ConnectionResource { readonly connection: string; readonly operation: string }
export interface ConnectionStatus { readonly schemaVersion: 1; readonly state: 'connected' | 'disconnected'; readonly credential: string | null }
export interface ConnectionRequest { readonly schemaVersion: 1; readonly request: string; readonly state: 'running' | 'completed' | 'failed'; readonly response: { readonly schemaVersion: 1; readonly accepted: boolean; readonly count: number } | null; readonly error: string | null }
/** Initial adapter: exact GET URL, HTTPS (numeric loopback HTTP allowed), no redirects,
 * no query/userinfo/fragment, Bearer only; 32 KiB response, 100–30,000 ms deadline.
 * json-summary projects only boolean accepted and integer count (0..1,000,000).
 * Unknown authentication schemes fail with UnsupportedCapability, never a raw-key fallback. */
export interface ConnectionDescriptor {
  readonly id: string; readonly command: string; readonly title: string; readonly authentication: string;
  readonly adapter: 'json-summary'; readonly timeoutMs: number;
  readonly operations: readonly { readonly id: string; readonly method: 'GET'; readonly url: string }[];
}
export interface OwnedJob { readonly schemaVersion: 1; readonly job: string; readonly state: 'running' | 'completed' | 'cancelled' | 'timeout' | 'failed'; readonly progress: readonly Json[]; readonly result: Json; readonly error: string | null }
/** Export `tools` from main.cjs, keyed by the fully qualified manifest tool ID.
 * The packaged Node adapter calls the handler with literal args, in captured project cwd.
 * Up to 32 progress messages (512 bytes each), one result (8192 bytes), deadline <= 30 s. */
export type ToolHandler = (args: readonly string[], job: { progress(value: Json): Promise<null> }) => Json | Promise<Json>;
export interface ToolDescriptor {
  readonly id: string; readonly command: string; readonly executable: 'node'; readonly cwd: 'project';
  readonly arguments: { readonly maxItems: number; readonly maxLength: number }; readonly timeoutMs: number;
}
export type StorageScope = 'global' | 'project';
export interface StorageSnapshot { readonly schemaVersion: 1; readonly dataVersion: number; readonly revision: number; readonly values: Readonly<Record<string, Json>> }
export interface StorageStream {
  readonly schemaVersion: 1; readonly subscription?: string; readonly cursor: number;
  readonly snapshot: StorageSnapshot | null; readonly resync: boolean;
  readonly events: readonly { readonly sequence: number; readonly keys: readonly string[] }[];
}
export interface PrivateStorage {
  get(options: { scope: StorageScope; key: string }): Promise<{ readonly schemaVersion: 1; readonly revision: number; readonly value: Json }>;
  set(options: { scope: StorageScope; key: string; value: Json }): Promise<{ readonly schemaVersion: 1; readonly revision: number }>;
  remove(options: { scope: StorageScope; key: string }): Promise<{ readonly schemaVersion: 1; readonly revision: number }>;
  snapshot(options: { scope: StorageScope }): Promise<StorageSnapshot>;
  subscribe(options: { scope: StorageScope }): Promise<StorageStream>;
  events(options: { scope: StorageScope; subscription: string; cursor: number }): Promise<StorageStream>;
  unsubscribe(options: { scope: StorageScope; subscription: string }): Promise<null>;
  /** Compute output in the trusted host. CAS rejects stale/failed migrations atomically.
   * Only next-version, explicitly rollback-compatible transformations are supported. */
  migrate(options: { scope: StorageScope; revision: number; fromVersion: number; toVersion: number; rollbackCompatible: true; values: Readonly<Record<string, Json>> }): Promise<{ readonly schemaVersion: 1; readonly revision: number }>;
}
/** Explicit closed host recipe. Approval/mode and main-task control are not delegated. */
export interface BoardComponent { readonly id: string; readonly title: string; readonly slot: 'panda.board'; readonly contractVersion: 1; readonly presentation: 'review-first'; readonly capabilities: readonly ['host-tasks', 'host-details', 'original-actions'] }
/** Experimental closed execution target and machine coordination recipe. Remote starts, the behind-GitHub continue, pairing, link and access consent, the orchestration switch and owner placement stay host-owned. */
export interface MachinesComponent { readonly id: string; readonly title: string; readonly slot: 'panda.machines'; readonly contractVersion: 1; readonly presentation: 'controls-below'; readonly capabilities: readonly ['host-targets', 'host-lineage', 'original-actions'] }
export type MachinesControl = 'computer-menu' | 'target-local' | 'target-device' | 'target-setup' | 'reconnect' | 'start-retry' | 'start-dismiss' | 'behind-cancel' | 'link-open' | 'link-decline' | 'link-cancel' | 'lineage-open' | 'lineage-stop' | 'stop-all';
export interface MachinesPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly host: string; readonly revision: number; readonly mode: 'none' | 'choice' | 'task'; readonly visible: boolean; readonly busy: boolean; readonly pending: 'none' | 'checking' | 'starting' | 'reconnecting' | 'error'; readonly behind: boolean; readonly linking: boolean; readonly offline: boolean; readonly hostOffline: boolean; readonly missing: boolean; readonly signedIn: boolean; readonly orchestration: boolean; readonly requests: number; readonly threads: number; readonly running: number; readonly label: string; readonly truncated: boolean; readonly controls: readonly { readonly id: string; readonly controlId: MachinesControl; readonly resource: string; readonly enabled: boolean }[] }
export interface MachinesAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly host: string; readonly revision: number; readonly control: string; readonly resource: string; readonly controlId: MachinesControl; readonly requestId: string }
export type MachinesAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Experimental closed cloud machine recipe. Provisioning, provider credentials, the delete confirmation and the native cloud policy stay host-owned. */
export interface CloudComponent { readonly id: string; readonly title: string; readonly slot: 'panda.cloud'; readonly contractVersion: 1; readonly presentation: 'controls-below'; readonly capabilities: readonly ['host-machine', 'host-targets', 'original-actions'] }
export type CloudControl = 'target-cloud' | 'target-setup' | 'machine-menu' | 'sync' | 'retry' | 'open' | 'stop' | 'delete' | 'delete-cancel';
export type CloudStage = 'none' | 'creating' | 'installing' | 'credentials' | 'uploading' | 'ready' | 'running' | 'reconnecting' | 'syncing' | 'stopped' | 'error';
export interface CloudPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly machine: string; readonly revision: number; readonly mode: 'none' | 'choice' | 'task'; readonly stage: CloudStage; readonly visible: boolean; readonly busy: boolean; readonly pending: 'none' | 'sync' | 'retry' | 'open' | 'stop' | 'delete'; readonly confirm: boolean; readonly offline: boolean; readonly error: boolean; readonly supported: boolean; readonly targets: number; readonly label: string; readonly truncated: boolean; readonly controls: readonly { readonly id: string; readonly controlId: CloudControl; readonly resource: string; readonly enabled: boolean }[] }
export interface CloudAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly machine: string; readonly revision: number; readonly control: string; readonly resource: string; readonly controlId: CloudControl; readonly requestId: string }
export type CloudAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Experimental closed moodboard recipe. The asset store, file chooser, drop/paste, create submit, delete confirmation and attach policy stay host-owned. */
export interface MoodboardComponent { readonly id: string; readonly title: string; readonly slot: 'panda.moodboards'; readonly contractVersion: 1; readonly presentation: 'viewer-first'; readonly capabilities: readonly ['host-boards', 'host-images', 'original-actions'] }
export type MoodboardControl = 'board-new' | 'board-select' | 'board-rename' | 'board-delete' | 'delete-cancel' | 'image-add' | 'image-preview' | 'image-caption' | 'image-remove' | 'preview-close' | 'attach';
export interface MoodboardPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly board: string; readonly image: string; readonly destination: string; readonly revision: number; readonly visible: boolean; readonly loading: boolean; readonly busy: boolean; readonly error: boolean; readonly draft: boolean; readonly create: boolean; readonly confirm: boolean; readonly preview: boolean; readonly attach: boolean; readonly boardName: string; readonly boardCount: number; readonly imageCount: number; readonly truncated: boolean; readonly controls: readonly { readonly id: string; readonly controlId: MoodboardControl; readonly resource: string; readonly enabled: boolean }[] }
export interface MoodboardAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly board: string; readonly image: string; readonly destination: string; readonly revision: number; readonly control: string; readonly resource: string; readonly controlId: MoodboardControl; readonly requestId: string }
export type MoodboardAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Experimental closed core Settings recipe. Preferences, secrets, grants, pairing and recovery stay host-owned; actions run the original Settings handlers. */
export interface SettingsComponent { readonly id: string; readonly title: string; readonly slot: 'panda.settings'; readonly contractVersion: 1; readonly presentation: 'actions-first'; readonly capabilities: readonly ['host-sections', 'host-controls', 'original-actions'] }
export type SettingsPageId = 'recommended' | 'general' | 'appearance' | 'voice' | 'agents' | 'providers' | 'teams' | 'routing' | 'schedules' | 'tools' | 'skills' | 'rules' | 'extensions' | 'cloud' | 'remote' | 'github' | 'about' | 'extension';
export type SettingsSectionId = 'recommended' | 'general' | 'appearance' | 'voice' | 'agents' | 'schedules' | 'tools' | 'connections' | 'extensions' | 'about' | 'extension';
export type SettingsControl = 'compact-mode' | 'expand-tool-activity' | 'toggle-theme' | 'daily-wallpapers' | 'default-provider' | 'default-model' | 'agent-updates' | 'refresh-agents' | 'agent-integrations' | 'jev-settings' | 'support';
/** A package settings page with `section` renders as an owner-labelled group in that core page; values stay in the package namespace. */
export type SettingsFieldPage = 'general' | 'appearance' | 'teams' | 'schedules' | 'tools' | 'skills' | 'rules';
export interface SettingsPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly page: SettingsPageId; readonly section: SettingsSectionId; readonly revision: number; readonly visible: boolean; readonly focused: boolean; readonly busy: boolean; readonly offline: boolean; readonly safeMode: boolean; readonly sections: readonly { readonly id: SettingsSectionId; readonly pinned: boolean; readonly hidden: boolean }[]; readonly controls: readonly { readonly id: string; readonly controlId: SettingsControl; readonly page: SettingsPageId; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface SettingsAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly page: SettingsPageId; readonly revision: number; readonly control: string; readonly controlId: SettingsControl; readonly requestId: string }
export type SettingsAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Experimental closed branch/worktree recipe. Create, switch and cleanup policy, the create form submit and the cleanup confirmation stay host-owned. */
export interface WorktreeComponent { readonly id: string; readonly title: string; readonly slot: 'panda.worktree'; readonly contractVersion: 1; readonly presentation: 'controls-first'; readonly capabilities: readonly ['host-branch', 'host-worktree', 'original-actions'] }
export type WorktreeControl = 'branch-menu' | 'switch-default' | 'switch-other' | 'worktree-attach' | 'worktree-new' | 'worktree-merge' | 'worktree-remove' | 'worktree-recreate' | 'settle-task' | 'copy-path' | 'open-pull' | 'open-url' | 'cleanup-cancel';
export interface WorktreePresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly repository: string; readonly branch: string; readonly base: string; readonly worktree: string; readonly revision: number; readonly checkout: 'local' | 'worktree' | 'missing' | 'remote' | 'none'; readonly visible: boolean; readonly loading: boolean; readonly busy: boolean; readonly running: boolean; readonly offline: boolean; readonly error: boolean; readonly detached: boolean; readonly branchName: string; readonly pending: 'none' | 'switch' | 'create' | 'merge' | 'cleanup' | 'recreate'; readonly form: 'none' | 'attach' | 'new'; readonly cleanup: 'none' | 'complete' | 'remove'; readonly linked: { readonly issue: boolean; readonly pull: boolean }; readonly truncated: boolean; readonly controls: readonly Readonly<{ id: string; controlId: WorktreeControl; resource: string; enabled: boolean }>[] }
export interface WorktreeAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly repository: string; readonly branch: string; readonly base: string; readonly worktree: string; readonly revision: number; readonly control: string; readonly resource: string; readonly controlId: WorktreeControl; readonly requestId: string }
export type WorktreeAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Experimental closed Pull request recipe. Merge confirmation and its method selection stay host-owned and are never package-invocable. */
export interface PullComponent { readonly id: string; readonly title: string; readonly slot: 'panda.pull'; readonly contractVersion: 1; readonly presentation: 'tabs-first'; readonly capabilities: readonly ['host-pull', 'host-diffs', 'original-actions'] }
export type PullControl = 'overview' | 'commits' | 'files' | 'checks' | 'check' | 'review' | 'conflicts' | 'link' | 'file' | 'refresh' | 'unlink' | 'merge-start' | 'merge-method' | 'merge-cancel';
export type PullSection = 'overview' | 'commits' | 'files';
export interface PullFile { readonly id: string; readonly path: string; readonly additions: number; readonly deletions: number; readonly expanded: boolean; readonly loading: boolean; readonly error: boolean }
export interface PullPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly repository: string; readonly pull: string; readonly base: string; readonly head: string; readonly section: PullSection; readonly revision: number; readonly visible: boolean; readonly loading: boolean; readonly busy: boolean; readonly offline: boolean; readonly error: boolean; readonly state: 'open' | 'draft' | 'merged' | 'closed' | 'unknown'; readonly merge: 'unavailable' | 'idle' | 'confirm' | 'merging'; readonly method: 'squash' | 'merge' | 'rebase'; readonly checks: boolean; readonly title: string; readonly truncated: boolean; readonly files: readonly PullFile[]; readonly controls: readonly Readonly<{ id: string; controlId: PullControl; resource: string; enabled: boolean }>[] }
export interface PullAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly repository: string; readonly pull: string; readonly base: string; readonly head: string; readonly section: PullSection; readonly revision: number; readonly control: string; readonly resource: string; readonly controlId: PullControl; readonly requestId: string }
export type PullAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
/** Experimental closed GitHub recipe. Metadata never grants task/clone/network authority. */
export interface GithubHubComponent { readonly id: string; readonly title: string; readonly slot: 'panda.githubHub'; readonly contractVersion: 1; readonly presentation: 'tabs-first'; readonly capabilities: readonly ['host-repositories', 'host-runs', 'original-actions'] }
export type GithubHubControl = 'repo' | 'tab' | 'refresh' | 'other' | 'clone' | 'open' | 'task' | 'review' | 'pull-menu' | 'runs' | 'issue-thread' | 'solve' | 'fix' | 'details' | 'workflow' | 'clear' | 'repo-filter' | 'query' | 'event' | 'pull' | 'latest' | 'compose';
export interface GithubHubRow { readonly id: string; readonly kind: 'repo' | 'thread' | 'pull' | 'issue' | 'run'; readonly title: string; readonly revision: number; readonly attempt: number; readonly expanded: boolean; readonly loading: boolean; readonly error: boolean }
export interface GithubHubPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly repository: string; readonly project: string; readonly tab: string; readonly revision: number; readonly visible: boolean; readonly loading: boolean; readonly busy: boolean; readonly offline: boolean; readonly error: boolean; readonly query: string; readonly filter: string; readonly truncated: boolean; readonly rows: readonly GithubHubRow[]; readonly controls: readonly Readonly<{ id: string; controlId: GithubHubControl; resource: string; attempt: number; enabled: boolean }>[] }
export interface GithubHubAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly repository: string; readonly project: string; readonly tab: string; readonly revision: number; readonly control: string; readonly resource: string; readonly attempt: number; readonly controlId: GithubHubControl; readonly value: string; readonly requestId: string }
export type GithubHubAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' | 'Offline' };
export type BoardStage = 'pending' | 'in_progress' | 'review' | 'completed';
export type BoardControl = 'open-project' | 'add' | 'filter' | 'import' | 'open' | 'close' | 'edit' | 'start' | 'retry' | 'settle' | 'reopen';
export interface BoardRow { readonly id: string; readonly project: string; readonly revision: number; readonly stage: BoardStage; readonly title: string; readonly running: boolean; readonly busy: boolean; readonly archived: boolean }
export interface BoardPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly filter: string; readonly revision: number; readonly visible: boolean; readonly loading: boolean; readonly busy: boolean; readonly detail: boolean; readonly importable: boolean; readonly truncated: boolean; readonly rows: readonly BoardRow[] }
export interface BoardAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly filter: string; readonly revision: number; readonly row: string; readonly rowProject: string; readonly rowRevision: number; readonly stage: BoardStage | ''; readonly controlId: BoardControl; readonly requestId: string }
export type BoardAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export interface BtwComponent { readonly id: string; readonly title: string; readonly slot: 'panda.btw'; readonly contractVersion: 1; readonly presentation: 'composer-first'; readonly capabilities: readonly ['host-input', 'host-history', 'main-side-isolation', 'original-actions'] }
export type BtwControl = 'new' | 'open' | 'close' | 'focus' | 'send' | 'steer' | 'stop' | 'model' | 'queue-edit' | 'queue-save' | 'queue-cancel' | 'queue-remove' | 'queue-send' | 'queue-steer' | 'queue-resume' | 'insert';
export interface BtwPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly main: string; readonly side: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly running: boolean; readonly waiting: boolean; readonly draft: boolean; readonly messages: readonly string[]; readonly queues: readonly string[]; readonly controls: readonly BtwControl[] }
export interface BtwAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly main: string; readonly side: string; readonly revision: number; readonly controlId: BtwControl; readonly resource: string; readonly requestId: string }
export type BtwAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Closed Browser recipe; no package guest, DOM, raw IPC or content ownership. */
/** Closed VM recipe. No frame content, raw input, native ID, writable share or provisioning authority. */
export interface VmComponent { readonly id: string; readonly title: string; readonly slot: 'panda.vm'; readonly contractVersion: 1; readonly presentation: 'controls-first'; readonly capabilities: readonly ['host-machine', 'host-input', 'host-frames', 'original-actions'] }
/** Closed Design recipe: no selectors, HTML, frame, comment/draft text or send authority. */
export interface DesignComponent { readonly id: string; readonly title: string; readonly slot: 'panda.design'; readonly contractVersion: 1; readonly presentation: 'comments-first'; readonly capabilities: readonly ['host-artboards', 'host-comments', 'original-actions'] }
export type DesignControl = 'comment' | 'in' | 'out' | 'fit' | 'refresh' | 'pan' | 'select' | 'draft' | 'save' | 'cancel' | 'resolve' | 'reopen' | 'delete' | 'compose';
export interface DesignPresentation { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly revision: number; readonly selection: string; readonly visible: boolean; readonly busy: boolean; readonly loading: boolean; readonly error: string; readonly commenting: boolean; readonly draft: boolean; readonly artboards: readonly Readonly<{ id: string; revision: string; label: string }>[]; readonly comments: readonly Readonly<{ id: string; revision: string; artboard: string; status: 'open' | 'resolved' }>[]; readonly controls: readonly Readonly<{ id: DesignControl; enabled: boolean }>[] }
export interface DesignAction { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly revision: number; readonly selection: string; readonly artboard: string; readonly comment: string; readonly resourceRevision: string; readonly controlId: DesignControl; readonly value: string; readonly x: number; readonly y: number; readonly requestId: string }
export type DesignAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export type VmControl = 'select' | 'new' | 'delete' | 'setup' | 'desktop' | 'power' | 'suspend' | 'input' | 'share';
export interface VmPresentation { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly machine: string; readonly connection: string; readonly platform: 'local' | 'cloud' | 'none'; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly loading: boolean; readonly error: string; readonly truncated: boolean; readonly share: boolean; readonly machines: readonly Readonly<{ id: string; connection: string; name: string; detail: string; platform: 'local' | 'cloud'; running: boolean }>[]; readonly controls: readonly Readonly<{ id: VmControl; enabled: boolean; reason: string; values: readonly string[] }>[] }
export interface VmAction { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly machine: string; readonly connection: string; readonly platform: VmPresentation['platform']; readonly revision: number; readonly controlId: VmControl; readonly value: string; readonly requestId: string }
export type VmAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Closed Simulator recipe. No device content, raw input, native ID or setup authority. */
export interface SimulatorComponent { readonly id: string; readonly title: string; readonly slot: 'panda.simulator'; readonly contractVersion: 1; readonly presentation: 'controls-first'; readonly capabilities: readonly ['host-device', 'host-input', 'host-frames', 'original-actions'] }
export type SimulatorControl = 'device' | 'pose' | 'finish' | 'appearance' | 'power' | 'back' | 'recents' | 'reset' | 'home' | 'lock' | 'capture' | 'copy-axe' | 'add-duo' | 'android-setup';
export interface SimulatorPresentation { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly device: string; readonly platform: 'ios' | 'android' | 'none'; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly loading: boolean; readonly error: string; readonly truncated: boolean; readonly pose: string; readonly finish: string; readonly appearance: 'light' | 'dark'; readonly devices: readonly Readonly<{ id: string; name: string; runtime: string; platform: 'ios' | 'android'; state: string }>[]; readonly controls: readonly Readonly<{ id: SimulatorControl; enabled: boolean; reason: string; values: readonly string[] }>[] }
export interface SimulatorAction { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly session: string; readonly device: string; readonly platform: SimulatorPresentation['platform']; readonly revision: number; readonly controlId: SimulatorControl; readonly value: string; readonly requestId: string }
export type SimulatorAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export interface BrowserComponent { readonly id: string; readonly title: string; readonly slot: 'panda.browser'; readonly contractVersion: 1; readonly presentation: 'controls-below'; readonly capabilities: readonly ['host-guest', 'host-bounds', 'original-actions'] }
export interface TerminalComponent { readonly id: string; readonly title: string; readonly slot: 'panda.terminal'; readonly contractVersion: 1; readonly presentation: 'tabs-below'; readonly capabilities: readonly ['host-pty', 'host-tabs', 'original-actions'] }
export interface TerminalPresentation { readonly contractVersion: 1; readonly context: string; readonly group: string; readonly project: string; readonly session: string; readonly revision: number; readonly selected: string; readonly focused: string; readonly visible: boolean; readonly busy: boolean; readonly tabs: readonly Readonly<{ id: string; title: string; ready: boolean; exited: boolean }>[] }
export interface TerminalAction { readonly contractVersion: 1; readonly context: string; readonly group: string; readonly project: string; readonly session: string; readonly revision: number; readonly tab: string; readonly controlId: 'new' | 'select' | 'close' | 'minimize'; readonly requestId: string }
export type TerminalAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
export interface BrowserPresentation { readonly contractVersion: 1; readonly context: string; readonly guest: string; readonly project: string; readonly session: string; readonly revision: number; readonly url: string; readonly home: boolean; readonly loading: boolean; readonly busy: boolean; readonly watching: boolean; readonly visible: boolean; readonly embedded: boolean; readonly canGoBack: boolean; readonly canGoForward: boolean; readonly picking: boolean; readonly picked: Readonly<{ tag: string; text: string }> }
export interface BrowserAction { readonly contractVersion: 1; readonly context: string; readonly guest: string; readonly project: string; readonly session: string; readonly revision: number; readonly controlId: 'navigate' | 'back' | 'forward' | 'reload' | 'pick' | 'capture' | 'test' | 'close' | 'home' | 'watch-jev' | 'refresh-ports'; readonly value: string; readonly requestId: string }
export type BrowserAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Closed Search recipe; no package query execution or matching source text delivery. */
export interface SearchComponent { readonly id: string; readonly title: string; readonly slot: 'panda.search'; readonly contractVersion: 1; readonly presentation: 'results-first'; readonly capabilities: readonly ['host-query', 'host-results', 'original-actions'] }
export interface SearchResult { readonly id: string; readonly path: string; readonly line: number; readonly collapsed: boolean }
export interface SearchPresentation { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly revision: number; readonly query: string; readonly matchCase: boolean; readonly wholeWord: boolean; readonly regex: boolean; readonly loading: boolean; readonly error: boolean; readonly visible: boolean; readonly selected: string; readonly results: readonly SearchResult[]; readonly next: string; readonly truncated: boolean }
export interface SearchAction { readonly contractVersion: 1; readonly context: string; readonly project: string; readonly revision: number; readonly query: string; readonly resultId: string; readonly controlId: 'query' | 'submit' | 'matchCase' | 'wholeWord' | 'regex' | 'open' | 'collapse'; readonly value: string; readonly requestId: string }
export type SearchAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' };
