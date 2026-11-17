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
/** Every permission name the manifest accepts (`permissions`, `requiredCapabilities`, `optionalCapabilities`). A declaration is a ceiling: the user's grant, kept natively and revocable, is what a call needs. There is no `credentials.read`: the host attaches a held credential (`credentials.use`) and never returns its value. */
export type ManifestPermission = 'btw.content' | 'btw.taskControl' | 'services.call' | 'connections.request' | 'tools.execute' | 'ui.contribute' | 'ui.customize' | 'ui.richViews' | 'storage.private' | 'projects.summary' | 'tasks.summary' | 'harnesses.inventory' | 'connections.summary' | 'jobs.summary' | 'projects.files.metadata' | 'projects.files.read' | 'projects.git.read' | 'tasks.transcript.read' | 'tasks.tools.read' | 'runtime.service' | 'events.workspace' | 'ui.dynamic' | 'ui.notify' | 'ui.presentation' | 'tasks.start' | 'tasks.message' | 'tasks.draft' | 'tasks.control' | 'tasks.usage.read' | 'harnesses.limits.read' | 'harnesses.accounts.read' | 'harness.hooks.observe' | 'harness.hooks.decide' | 'harness.hooks.context' | 'harness.companions' | 'harness.console' | 'tools.model' | 'models.call' | 'secrets.private' | 'credentials.use' | 'auth.signIn' | 'documents.editors' | 'workspace.manage' | 'workspace.settings' | 'terminals.read' | 'terminals.write' | 'guests.control' | 'projects.checks.run' | 'metrics.read' | 'internal.unstable';
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
export type ProviderDescriptor = { apiVersion: 1; id: string; name: string; metadata?: ProviderMetadata; discovery?: ProviderDiscoveryRoot[]; models: { id: string; name: string; efforts: string[]; contextWindow?: number; speedTiers?: { id: string; name: string; description?: string }[] }[] };
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
  /** Set when the command runs from the composer slash menu: the slash command, the task's harness and the arguments typed after the name (never the rest of the draft). */
  readonly slash?: { readonly command: string; readonly provider: string; readonly arguments: string };
  /** The opaque `args` of the live item, table row or tree node that ran the command (up to 4 KiB). */
  readonly args?: Json;
}
/** What a live registration is bound to: one task or one project. Checked when registered. */
export type RuntimeScope = { readonly taskId: string } | { readonly projectId: string };
/** One live contribution: the manifest shape of its `kind` plus an optional scope. `id`, `kind`, `location` and `command` are fixed. */
export type RuntimeContribution = { readonly kind: 'menu' | 'command' | 'view' | 'slashCommand'; readonly id: string; readonly location?: string; readonly command?: string; readonly scope?: RuntimeScope; readonly [field: string]: Json | undefined };
/** Changeable fields: text, badge, icon, tone, tooltip (up to 1,024 characters), progress (0-100), enabled, visible (boolean or null to restore the declared one), args, items; for a view also title, controls, toolbar. At most 20 applied per second. */
/** A notice (R0207): key names it inside the package (the same key replaces it), 	ext up to 1,024 characters, 	itle up to 120. */
export type RuntimeNotice = { readonly key: string; readonly text: string; readonly title?: string; readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger' };
export type RuntimePatch = { readonly text?: string; readonly badge?: string; readonly icon?: string; readonly tone?: 'neutral' | 'info' | 'success' | 'warning' | 'danger'; readonly tooltip?: string; readonly progress?: number; readonly enabled?: boolean | null; readonly visible?: boolean | null; readonly args?: Json; readonly items?: Json; readonly title?: string; readonly controls?: Json; readonly toolbar?: Json };
export interface RuntimeItem {
  readonly id: string;
  update(patch: RuntimePatch): Promise<null>;
  /** Removes the item; a handle that is gone answers NotFound. */
  dispose(): Promise<null>;
}
/** Eligible main-window dialogs (`panda.dialog.<id>.actions` / `.bodyExtras`): shared modals, then module-owned and directly mounted dialogs. Destructive, credential, permission and recovery dialogs have no ID. */
export type MainDialogId = 'recipes' | 'attachment' | 'task-details' | 'subagents' | 'task-status' | 'integrations-fallback' | 'working-directory' | 'changed-files' | 'open-project' | 'rename-task' | 'colors' | 'wallpapers' | 'opencode-models' | 'moodboards' | 'integrations' | 'jev-settings' | 'jev-assist' | 'jev-tests' | 'conversation-import' | 'bots' | 'bot-settings' | 'usage' | 'command-palette'
  | 'agent-updates' | 'channel-create' | 'channel-settings' | 'github-import' | 'github-pr' | 'github-link' | 'sketch' | 'worktree-create' | 'command-center' | 'progress-lightbox' | 'team-model-add' | 'tool-image-viewer'
  | 'remove-project' | 'delete-task' | 'delete-bot' | 'delete-cloud' | 'provider-connections' | 'worktree-cleanup' | 'machine-link' | 'skill-add';
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
  /** Multi-line text: the same 4096-character value contract as `text`; `rows` is 2-12 (default 4). */
  { readonly kind: 'textarea'; readonly value?: string; readonly required?: boolean; readonly minLength?: number; readonly rows?: number } |
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
    start(options: ConnectionResource & { credential?: string; body?: Json; query?: Readonly<Record<string, string>> }): Promise<ConnectionRequest>;
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
    /** Adds one live contribution (needs `runtime.service` and the `ui.dynamic` grant). Same validators as a manifest
     * entry; the id starts with the package id; at most 128 live items. Gone when the service stops. */
    register(item: RuntimeContribution): Promise<RuntimeItem>;
    /** Changes fields of a live item or of an item of this package's own manifest, until the service stops. */
    update(id: string, patch: RuntimePatch): Promise<null>;
    /** Changes `title`, `text`, `controls` or `toolbar` of a view of this package. */
    updateView(id: string, patch: RuntimePatch): Promise<null>;
    /** Raises the notice named `key` of this package, or replaces it when it is live (needs `runtime.service` and the
     * `ui.notify` grant). The package's name leads every notice, in the app and in the operating-system channel. At most
     * 6 sends per minute; the following ones merge into one "N more notices" notice. `os` is `unavailable` when this
     * build has no operating-system channel: the notice still shows in the app. */
    notify(notice: RuntimeNotice): Promise<{ readonly key: string; readonly replaced: boolean; readonly merged: boolean; readonly os: 'delivered' | 'unavailable' }>;
    /** Removes the notice named `key`; a key that is gone answers `NotFound`. */
    withdraw(key: string): Promise<null>;
  };
}
export type Activate = (panda: PandaCode, context: InvocationContext) => void | Promise<void>;
export interface ConnectionResource { readonly connection: string; readonly operation: string }
export interface ConnectionStatus { readonly schemaVersion: 1; readonly state: 'connected' | 'disconnected'; readonly credential: string | null }
export interface ConnectionRequest { readonly schemaVersion: 1; readonly request: string; readonly state: 'running' | 'completed' | 'failed'; readonly response: { readonly schemaVersion: 1; readonly accepted: boolean; readonly count: number } | { readonly schemaVersion: 1; readonly status: number; readonly body: Json } | null; readonly error: string | null }
/** Declared requests (R0804): HTTPS (numeric loopback HTTP allowed), no redirects, no userinfo/fragment; the address may
 * carry a query. `json-summary` projects only boolean accepted and integer count (32 KiB response); `json` returns the
 * parsed body within `maxResponseBytes` (default 256 KiB, at most 1 MiB). Authentication: bearer, header (`headerName`),
 * query (`queryName`) or none; the credential is a package secret (`credential.source: 'secret'`) or a held one
 * (`'held'`, needs `credentials.use`) and never reaches the package. `start` accepts `body` (operations declaring
 * `"body": "json"`, at most 256 KiB) and `query` (at most 16 string pairs). Unknown authentication schemes fail with
 * UnsupportedCapability, never a raw-key fallback. Service only on the duplex channel. */
export interface ConnectionDescriptor {
  readonly id: string; readonly command: string; readonly title: string; readonly authentication: string;
  readonly adapter: 'json-summary' | 'json'; readonly timeoutMs: number;
  readonly headerName?: string; readonly queryName?: string; readonly maxResponseBytes?: number;
  readonly credential?: { readonly source: 'host' } | { readonly source: 'secret'; readonly key: string } | { readonly source: 'held'; readonly id: string };
  readonly operations: readonly { readonly id: string; readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly url: string; readonly body?: 'json'; readonly headers?: Readonly<Record<string, string>> }[];
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
/** Experimental closed action dock and team progress recipe. Placement, motion, team state, workers, approvals and Stop stay host-owned; actions run the original dock and Workers line handlers. */
export interface ActionDockComponent { readonly id: string; readonly title: string; readonly slot: 'panda.actionDock'; readonly contractVersion: 1; readonly presentation: 'actions-first'; readonly capabilities: readonly ['host-groups', 'host-workers', 'original-actions'] }
export type DockControl = 'inspector' | 'terminal' | 'browser' | 'moodboards' | 'agents' | 'run' | 'deploy' | 'task-menu' | 'team-toggle' | 'team-open' | 'worker-open' | 'workers-more';
export type DockWorkerStatus = 'queued' | 'running' | 'waiting' | 'parked' | 'completed' | 'failed' | 'stopped' | 'paused' | 'skipped';
/** `progress`, `status`, the counts and `workers` are filled only for a package that declares `tasks.summary`. */
export interface DockPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly team: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly row: boolean; readonly flyout: boolean; readonly progress: boolean; readonly status: 'none' | 'ready' | 'running' | 'waiting' | 'paused' | 'completed' | 'failed' | 'interrupted'; readonly running: number; readonly attention: number; readonly failed: number; readonly total: number; readonly groups: readonly { readonly id: 'panels' | 'actions' | 'status'; readonly shown: boolean }[]; readonly workers: readonly { readonly id: string; readonly status: DockWorkerStatus; readonly attention: boolean }[]; readonly controls: readonly { readonly id: string; readonly controlId: DockControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface DockAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly team: string; readonly revision: number; readonly control: string; readonly controlId: DockControl; readonly resource: string; readonly requestId: string }
export type DockAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Experimental composer controls (owner: the selected `panda.composer` provider). Tray controls, model picker entries
 * and steer bar parts reorder and hide on the original nodes; actions run the original handlers. The draft, the
 * selected model, the approval mode, Send, Stop and approvals stay host-owned. */
export type ComposerControl = 'model' | 'mode' | 'team' | 'saver' | 'council' | 'run-target' | 'steer-edit' | 'steer' | 'steer-clear';
/** Named but never run: refused with `PermissionDenied`. A mode or model changes only through the user's own choice
 * in the original Permissions menu or model picker (request `mode` or `model` to open them). */
export type ComposerProtectedControl = 'mode-set' | 'model-set' | 'effort-set' | 'team-set' | 'send' | 'stop' | 'approve' | 'deny';
/** `draft` says only whether a draft exists; its text never crosses. Editing the draft changes `revision`. */
export interface ComposerPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly running: boolean; readonly steering: boolean; readonly draft: boolean; readonly mode: 'ask' | 'auto' | 'review' | 'plan' | 'full'; readonly controls: readonly { readonly id: string; readonly controlId: ComposerControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface ComposerAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: ComposerControl; readonly resource: string; readonly requestId: string }
export type ComposerAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the composer contexts: `draft` (steer bar, ids = [task]), `model` (model picker actions,
 * ids = ["<harness>:<model>"]) and `approval-mode` (Permissions menu, ids = [current mode]). */
export type ComposerSelectionKind = 'draft' | 'model' | 'approval-mode';
/** Experimental queue, token saver and council panel controls (owner: the selected `panda.composer` provider). Eligible
 * controls reorder and hide on the original nodes; actions run the original handlers. Queued text, queue order and
 * delivery, token saver packs and the council's team decisions stay host-owned. */
export type ComposerPanelControl = 'queue-steer' | 'queue-send-now' | 'queue-edit' | 'queue-resume' | 'saver-tighten' | 'saver-default' | 'saver-off' | 'council-strip-toggle' | 'council-open-worker' | 'council-lower-target' | 'council-raise-rounds';
/** Named but never run: refused with `PermissionDenied`. */
export type ComposerPanelProtectedControl = 'queue-remove' | 'queue-save' | 'queue-cancel' | 'queue-reorder' | 'saver-pack' | 'saver-level' | 'saver-install' | 'council-accept' | 'council-dismiss' | 'council-keep-fixing' | 'council-set';
/** `entries` are opaque entry handles in delivery order (never text); an edited, moved, sent or removed entry, a new
 * council cycle or any redraw changes `revision`. */
export interface ComposerPanelsPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly running: boolean; readonly held: boolean; readonly entries: readonly string[]; readonly saver: boolean; readonly council: boolean; readonly cycle: string; readonly controls: readonly { readonly id: string; readonly controlId: ComposerPanelControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface ComposerPanelsAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: ComposerPanelControl; readonly resource: string; readonly requestId: string }
export type ComposerPanelsAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the panel contexts: `queue-entry` (queue row actions, ids = [entry]), `token-saver` (token saver
 * panel actions, ids = [task]) and `council-cycle` (council strip actions, ids = ["<task>:<cycle start>"]). */
export type ComposerPanelSelectionKind = 'queue-entry' | 'token-saver' | 'council-cycle';
/** Experimental Attach menu, Workflow recipes and wake-up controls (owner: the selected `panda.composer` provider).
 * Eligible entries reorder and hide on the original nodes and menus; actions run the original handlers. Draft
 * attachments, recipe steps, deletes and schedule changes stay host-owned. */
export type ComposerAttachControl = 'attach-open' | 'attach-file' | 'recipe-pick' | 'recipe-new' | 'recipe-edit' | 'recipe-run' | 'wake-expand' | 'wake-add' | 'wake-run' | 'wake-enable' | 'wake-more';
/** Named but never run: refused with `PermissionDenied`. */
export type ComposerAttachProtectedControl = 'attach-paths' | 'attach-remove' | 'recipe-delete' | 'recipe-save' | 'recipe-cancel' | 'wake-create' | 'wake-remove' | 'wake-snooze' | 'wake-set';
/** `attachments` counts the draft's attachments (never paths); `recipe` and `schedules` are opaque handles. An edited
 * draft, a changed attachment, recipe or wake-up, or any redraw changes `revision`. */
export interface ComposerAttachPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly draft: boolean; readonly attachments: number; readonly recipes: boolean; readonly recipe: string; readonly wake: boolean; readonly schedules: readonly string[]; readonly controls: readonly { readonly id: string; readonly controlId: ComposerAttachControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface ComposerAttachAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: ComposerAttachControl; readonly resource: string; readonly requestId: string }
export type ComposerAttachAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the attach contexts: `draft` (Attach menu, ids = [task]), `recipe` (selected recipe actions,
 * ids = ["<scope>:<name>"]), `task` (Wake this thread later actions, ids = [task]) and `schedule` (a wake-up's ⋯ menu,
 * ids = [schedule]). */
export type ComposerAttachSelectionKind = 'draft' | 'recipe' | 'task' | 'schedule';
/** Experimental transcript extras: a sent message's attachment chips, thread find, a turn's changes card and footer,
 * and the usage-limit card (owner: the selected `panda.transcript` provider). Eligible controls reorder and hide on the
 * original nodes; actions run the original handlers. Attachment contents, the find text, diffs, the limit and
 * connection changes stay host-owned. */
export type ThreadExtrasControl = 'attachment-open' | 'find-previous' | 'find-next' | 'find-close' | 'changes-open' | 'changes-file' | 'changes-run' | 'limit-continue' | 'limit-switch' | 'limit-dismiss' | 'limit-resume';
/** Named but never run: refused with `PermissionDenied`. */
export type ThreadExtrasProtectedControl = 'attachment-read' | 'attachment-reveal' | 'find-set-query' | 'find-read-matches' | 'changes-read-diff' | 'limit-set' | 'limit-assign-connection' | 'limit-switch-provider';
/** `attachments` counts the transcript's chips (never names, paths or contents); `turns` and `provider` are opaque
 * handles. A new turn, another query, a changed limit or any redraw changes `revision`. */
export interface ThreadExtrasPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly attachments: number; readonly find: boolean; readonly turns: readonly string[]; readonly limited: boolean; readonly provider: string; readonly controls: readonly { readonly id: string; readonly controlId: ThreadExtrasControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface ThreadExtrasAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: ThreadExtrasControl; readonly resource: string; readonly requestId: string }
export type ThreadExtrasAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the transcript-extras contexts: `message-attachment` (ids = ["<message>:<index>", …] for the
 * message's chips), `find` (ids = [task]; never the query), `turn-changes` (ids = [<turn change set>, …changed paths],
 * at most 99 paths) and `usage-limit` (ids = [<harness>]). */
export type ThreadExtrasSelectionKind = 'message-attachment' | 'find' | 'turn-changes' | 'usage-limit';
/** Experimental tool rows and result cards (docs/extensions/upstream-tool-rows.md). A menu at `panda.thread.trace.actions`
 * whose `visible` condition names one of these kinds gets an action slot on every tool row (`tool-row`, on the summary
 * line) or result card (`tool-card`, under the disclosed result). `selection.ids` = [<tool call key>, <tool name>, <tool
 * kind>, <MCP server, when the call names one>]; never the input, output, a path or a thumbnail. */
export type ToolRowSelectionKind = 'tool-row' | 'tool-card';
/** Experimental thread tiles (owner: the selected `panda.transcript` provider) and draft project picker (owner: the
 * selected `panda.composer` provider). A tile bar's controls and the picker's entries reorder and hide on the original
 * nodes; actions run the original handlers. Input to a tile, tile layout, the draft and moving it stay host-owned. */
export type TilesControl = 'tile-focus' | 'tile-close' | 'tile-composer';
export type ProjectPickerControl = 'picker-toggle' | 'picker-select' | 'picker-open';
/** Named but never run: refused with `PermissionDenied`. */
export type TilesProtectedControl = 'tile-send-input' | 'tile-read-rows' | 'tile-open' | 'tile-move' | 'tile-resize';
export type ProjectPickerProtectedControl = 'picker-move' | 'picker-read-draft' | 'picker-set-search' | 'picker-create-project' | 'picker-clear-attachments';
/** `task` is the focused thread; `tiles` the tiled threads' opaque handles in order (never titles or rows). Another
 * focused tile, a closed tile or any redraw changes `revision`. */
export interface TilesPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly tiles: readonly string[]; readonly controls: readonly { readonly id: string; readonly controlId: TilesControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface TilesAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: TilesControl; readonly resource: string; readonly requestId: string }
/** `task` is the draft; `draft` whether it has text (never the text); `entries` how many projects the open picker
 * lists. An edited draft, another search or another current project changes `revision`. */
export interface ProjectPickerPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly open: boolean; readonly draft: boolean; readonly entries: number; readonly controls: readonly { readonly id: string; readonly controlId: ProjectPickerControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface ProjectPickerAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: ProjectPickerControl; readonly resource: string; readonly requestId: string }
export type TilesPickerAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the tile and picker contexts: `tile` (ids = [the tile's own thread], never the focused one) and
 * `draft-project` (ids = [draft]; never the draft text). */
export type TilesPickerSelectionKind = 'tile' | 'draft-project';
/** Experimental composer slash commands (`contributes.slashCommands`, at most 32): `name` is `/` plus 1-32 lowercase
 * letters, digits or dashes; exactly one of `command` (a contributed command, run with the captured task, harness and
 * arguments; nothing is typed into the harness) or `provider` (one of this package's providers, whose send path receives
 * the command as typed). `arguments` is the argument schema; without it the command takes no arguments. A name PandaCode
 * or the harness already has, or that two packages declare, is listed unavailable and never runs. */
export interface SlashCommandDefinition { readonly id: string; readonly name: string; readonly description: string; readonly command?: string; readonly provider?: string; readonly arguments?: { readonly hint?: string; readonly required: boolean; readonly maxLength: number } }
/** Experimental harness command center and slash menu (owner: the selected `panda.composer` provider). PandaCode's slash
 * entries and the harness entries that open the command center hide and reorder in the menu; actions run the original
 * handlers. The draft, Send, resolving a typed command and the command center's changes stay host-owned. */
export type CommandsControl = 'harness-open' | 'harness-refresh' | 'harness-close';
/** Named but never run: refused with `PermissionDenied`. */
export type CommandsProtectedControl = 'slash-send' | 'slash-insert' | 'slash-read-draft' | 'harness-execute' | 'console-open';
/** `menu` whether the slash menu is open, `panel` the open command center panel, `slash` how many package slash commands
 * the menu offers. An edited draft, another task or harness, an opened or closed panel or any redraw changes `revision`. */
export interface CommandsPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly menu: boolean; readonly panel: 'none' | 'goal' | 'usage' | 'hooks' | 'preferences' | 'imports' | 'conversations' | 'plugins' | 'jobs'; readonly slash: number; readonly controls: readonly { readonly id: string; readonly controlId: CommandsControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface CommandsAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly revision: number; readonly control: string; readonly controlId: CommandsControl; readonly resource: string; readonly requestId: string }
export type CommandsAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of the slash and command center contexts: `slash-command` (ids = [task]; the `slash` field carries the
 * command, harness and arguments) and `harness-command` (ids = [`<harness>:<panel>`]). */
export type CommandsSelectionKind = 'slash-command' | 'harness-command';
/** Experimental Team, dock Task actions, Deploy and Bot assignment menus (owner: the selected `panda.composer` provider; docs/extensions/task-menus.md).
 * Captured actions run the menus' original handlers: starting or stopping a team, a task action, a deploy and a bot
 * assignment. Deleting a task, deploying and assigning a bot need a fresh host choice; saving a team, the harness console,
 * connections and credentials and bot settings are never public. */
export type TaskMenusControl = 'team-select' | 'team-setup-open' | 'task-run' | 'task-delete' | 'deploy-run' | 'bot-assign';
/** Named but never run: refused with `PermissionDenied`. */
export type TaskMenusProtectedControl = 'team-save' | 'team-profile-edit' | 'task-console' | 'task-delete-confirm' | 'deploy-connect' | 'deploy-credentials' | 'bot-credentials' | 'bot-create' | 'bot-delete';
/** `team`, `connection` and `bot` are opaque handles ('' when the task has none): the task's team, the connected deploy platforms and the task's bot. `menu` is the host menu that is open. Any change of task, team, connections or bot, or a redraw, changes `revision`. */
export interface TaskMenusPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly team: string; readonly connection: string; readonly bot: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly menu: 'none' | 'team' | 'setup' | 'task' | 'deploy' | 'bot'; readonly controls: readonly { readonly id: string; readonly controlId: TaskMenusControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface TaskMenusAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly team: string; readonly connection: string; readonly bot: string; readonly revision: number; readonly control: string; readonly controlId: TaskMenusControl; readonly resource: string; readonly requestId: string }
export type TaskMenusAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of these menus' contexts: `team` (ids = [task]), `task` (ids = [task]), `connection` (ids = the connected deploy platforms) and `bot` (ids = [the bots listed, or the task's bot]). */
export type TaskMenusSelectionKind = 'team' | 'task' | 'connection' | 'bot';
/** Experimental Workspace view, Sort and view and Filter projects menus (owner: the selected `panda.composer` provider; docs/extensions/window-menus.md).
 * The open view, the sort, the tasks per section and the project filter are host settings: a captured action changes one
 * only after a fresh host choice, which runs the original handler once. Hiding the open view, reordering tasks by hand,
 * a project's own actions, adding or removing a project and turning GitHub on are never public. */
export type WindowMenusControl = 'view-open' | 'sort-set' | 'scope-set' | 'filter-set';
/** Named but never run: refused with `PermissionDenied`. */
export type WindowMenusProtectedControl = 'view-hide-current' | 'sort-reorder' | 'project-actions' | 'project-remove' | 'project-add' | 'github-enable';
/** `view`, `sort` and `filter` are opaque handles of the open view, the sort with its count and the project filter. `menu` is the host menu that is open. Any change of view, sort, count or filter, or a redraw, changes `revision`. */
export interface WindowMenusPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly view: string; readonly sort: string; readonly filter: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly menu: 'none' | 'view' | 'sort' | 'filter'; readonly controls: readonly { readonly id: string; readonly controlId: WindowMenusControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface WindowMenusAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly view: string; readonly sort: string; readonly filter: string; readonly revision: number; readonly control: string; readonly controlId: WindowMenusControl; readonly resource: string; readonly requestId: string }
export type WindowMenusAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** `selection.kind` of these menus' contexts: `workspace-view` (ids = [the open view]), `sidebar-sort` (ids = [the task order, `per-<count>`]) and `project-filter` (ids = [the filtered project, or `all-projects`]). */
export type WindowMenusSelectionKind = 'workspace-view' | 'sidebar-sort' | 'project-filter';
/** Experimental bot thread header and shared channel conversation controls (owner: the selected `panda.transcript` provider; docs/extensions/bot-conversation.md).
 * Pausing or resuming a bot, opening bot or channel settings, putting a suggestion in the draft, Continue and Reassign run
 * the original handler once, only after a fresh host choice. Stop, deletion, credentials, settings and membership
 * changes, sending and the draft are never public. Contributed `panda.bot.thread.actions` capture `selection.kind`
 * `bot` (ids = [the bot]) with the bot's conversation as `sessionId`; `panda.bot.channel.actions` capture `channel`
 * (ids = [the channel]). */
export type BotConversationControl = 'bot-pause' | 'bot-settings' | 'bot-suggest' | 'channel-earlier' | 'channel-continue' | 'channel-reassign-open' | 'channel-reassign' | 'channel-settings';
/** Named but never run: refused with `PermissionDenied`. */
export type BotConversationProtectedControl = 'bot-stop' | 'channel-stop' | 'bot-delete' | 'bot-credentials' | 'bot-settings-save' | 'channel-settings-save' | 'channel-membership' | 'channel-delete' | 'message-send' | 'draft-write';
/** `bot`, `session` and `channel` are opaque handles of the open bot thread or shared channel ('' when not open). Switching bot, conversation or channel, pausing, a channel refresh or a redraw changes `revision`. */
export interface BotConversationPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly view: 'none' | 'bot-thread' | 'channel'; readonly project: string; readonly bot: string; readonly session: string; readonly channel: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly controls: readonly { readonly id: string; readonly controlId: BotConversationControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface BotConversationAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly bot: string; readonly session: string; readonly channel: string; readonly revision: number; readonly control: string; readonly controlId: BotConversationControl; readonly resource: string; readonly requestId: string }
export type BotConversationAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** The bot web chat's history reports `extensions` as `{ apiVersion: 1, projected: [], state: 'none' | 'withheld', reason? }`: nothing a package contributes is forwarded to it. */
export interface BotWebExtensionPolicy { readonly apiVersion: 1; readonly projected: readonly []; readonly state: 'none' | 'withheld'; readonly reason?: string }
/** Experimental closed agent roster recipe (subagent view, team profiles, main-window Running agents widget). Children, their streams and lineage, profiles, Stop, the widget's preference and its pinned window stay host-owned; actions run the original roster handlers. */
export interface AgentRosterComponent { readonly id: string; readonly title: string; readonly slot: 'panda.roster'; readonly contractVersion: 1; readonly presentation: 'running-first'; readonly capabilities: readonly ['host-rows', 'host-lineage', 'original-actions'] }
export type RosterControl = 'subagents' | 'subagent-open' | 'subagents-back' | 'subagents-close' | 'subagents-retry' | 'profile-picker' | 'profile-select' | 'profile-manage' | 'profile-create' | 'profile-update' | 'widget' | 'widget-open';
/** `progress`, `running`, `children` and `agents` are filled only for a package that declares `tasks.summary`. A child's `parent` is the child it came from, or empty for the task itself. */
export interface RosterPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly profile: string; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly view: 'closed' | 'list' | 'detail'; readonly child: string; readonly setup: boolean; readonly widget: boolean; readonly widgetOpen: boolean; readonly progress: boolean; readonly running: number; readonly children: readonly { readonly id: string; readonly parent: string; readonly status: 'running' | 'waiting' | 'completed' | 'failed' | 'stopped'; readonly active: boolean }[]; readonly agents: readonly { readonly id: string; readonly status: 'running' | 'waiting' }[]; readonly controls: readonly { readonly id: string; readonly controlId: RosterControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface RosterAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly profile: string; readonly revision: number; readonly control: string; readonly controlId: RosterControl; readonly resource: string; readonly requestId: string }
export type RosterAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Experimental closed cached usage, status and progress recipe (Agent usage panel, dock status group, notices, visual progress, Jev entry). Usage reads, the update prompt, Undo, snapshots and test reports stay host-owned; actions run the original handlers and a package Refresh needs the user's Continue. */
export interface StatusComponent { readonly id: string; readonly title: string; readonly slot: 'panda.status'; readonly contractVersion: 1; readonly presentation: 'details-first'; readonly capabilities: readonly ['host-usage', 'host-feedback', 'original-actions'] }
export type StatusControl = 'usage-open' | 'usage-tab' | 'usage-details' | 'usage-range' | 'usage-breakdown' | 'usage-refresh' | 'progress-expand' | 'progress-collapse' | 'progress-prev' | 'progress-next' | 'progress-play' | 'progress-marks' | 'progress-compare' | 'progress-enlarge' | 'progress-thumb' | 'jev-open';
/** `inventory` and `providers` are filled only for a package that declares `harnesses.inventory`; `progress`, `iterations`, `iteration` and `jevStatus` only for `tasks.summary`. A provider's `peak` is the highest window used as a whole percent, or -1. */
export interface StatusPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly range: 'week' | 'month' | 'year'; readonly revision: number; readonly visible: boolean; readonly busy: boolean; readonly safeMode: boolean; readonly usage: boolean; readonly tab: 'closed' | 'overview' | 'provider'; readonly breakdown: 'model' | 'day'; readonly loading: boolean; readonly update: boolean; readonly toast: 'hidden' | 'notice' | 'undo' | 'action'; readonly pip: 'hidden' | 'collapsed' | 'expanded'; readonly jev: boolean; readonly inventory: boolean; readonly providers: readonly { readonly id: string; readonly provider: string; readonly status: 'checking' | 'ready' | 'unavailable' | 'signedOut' | 'error' | 'unsupported'; readonly peak: number; readonly stale: boolean }[]; readonly progress: boolean; readonly iterations: number; readonly iteration: number; readonly jevStatus: 'none' | 'testing' | 'passed' | 'failed' | 'finished' | 'stopped' | 'attention'; readonly controls: readonly { readonly id: string; readonly controlId: StatusControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface StatusAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly provider: string; readonly range: 'week' | 'month' | 'year'; readonly revision: number; readonly control: string; readonly controlId: StatusControl; readonly resource: string; readonly requestId: string }
export type StatusAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Experimental closed sidebar recipe. Grouping, sorting, selection, manual order, drafts and every task handler stay host-owned; actions run the original sidebar handlers. */
export interface SidebarComponent { readonly id: string; readonly title: string; readonly slot: 'panda.sidebar'; readonly contractVersion: 1; readonly presentation: 'filter-first'; readonly capabilities: readonly ['host-sections', 'host-rows', 'original-actions'] }
export type SidebarSectionId = 'pinned' | 'active' | 'review' | 'chats' | 'all' | 'project' | 'completed';
export type SidebarControl = 'new-task' | 'new-chat' | 'search' | 'project-filter' | 'sort' | 'import' | 'open-project' | 'filter-clear' | 'toggle-section' | 'completed-more' | 'folder-more' | 'select-task' | 'task-menu' | 'settle' | 'reopen';
export interface SidebarPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly visible: boolean; readonly focused: boolean; readonly busy: boolean; readonly filtering: boolean; readonly safeMode: boolean; readonly group: 'project' | 'flat'; readonly taskSort: 'manual' | 'recent' | 'created'; readonly projectSort: 'recent' | 'added' | 'name' | 'manual'; readonly sections: readonly { readonly id: SidebarSectionId; readonly pinned: boolean; readonly hidden: boolean; readonly collapsed: boolean; readonly count: number }[]; readonly rows: readonly { readonly id: string; readonly section: SidebarSectionId; readonly selected: boolean; readonly pinned: boolean; readonly unread: boolean; readonly active: boolean; readonly settled: boolean }[]; readonly controls: readonly { readonly id: string; readonly controlId: SidebarControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface SidebarAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly task: string; readonly revision: number; readonly control: string; readonly controlId: SidebarControl; readonly resource: string; readonly requestId: string }
export type SidebarAdmission = { readonly ok: true } | { readonly ok: false; readonly reason: 'Revoked' | 'WrongOwner' | 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidArguments' | 'StaleContext' | 'AlreadyApplied' | 'Busy' };
/** Experimental Bots panel presentation (same `panda.sidebar` provider). Grouping, unread state, pins, order, deletion, pausing, channel membership and credentials stay host-owned; actions run the original Bots panel handlers. */
export type SidebarBotsGroupId = 'needs-you' | 'pinned' | 'bots' | 'hidden' | 'channels' | 'deleted-channels';
export type SidebarBotsControl = 'toggle-view' | 'search' | 'mark-read' | 'create-menu' | 'new-bot' | 'new-channel' | 'toggle-hidden' | 'open-bot' | 'bot-settings' | 'bot-menu' | 'open-channel' | 'channel-menu';
export interface SidebarBotsPresentation { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly bot: string; readonly channel: string; readonly revision: number; readonly visible: boolean; readonly focused: boolean; readonly busy: boolean; readonly view: 'tasks' | 'bots'; readonly searching: boolean; readonly loaded: boolean; readonly safeMode: boolean; readonly groups: readonly { readonly id: SidebarBotsGroupId; readonly pinned: boolean; readonly hidden: boolean; readonly open: boolean; readonly count: number }[]; readonly rows: readonly { readonly id: string; readonly kind: 'bot' | 'channel'; readonly group: SidebarBotsGroupId; readonly selected: boolean; readonly pinned: boolean; readonly status: 'none' | 'waiting' | 'failed' | 'limited' | 'working' | 'unread' | 'responded' }[]; readonly controls: readonly { readonly id: string; readonly controlId: SidebarBotsControl; readonly resource: string; readonly enabled: boolean; readonly hidden: boolean }[]; readonly truncated: boolean }
export interface SidebarBotsAction { readonly contractVersion: 1; readonly window: 'main'; readonly context: string; readonly project: string; readonly bot: string; readonly channel: string; readonly revision: number; readonly control: string; readonly controlId: SidebarBotsControl; readonly resource: string; readonly requestId: string }
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
/** Project scope of a package's enablement, chosen by the user in Settings → Extensions (never by a package). A refusal for a project outside it is `PermissionDenied` at path `$.projectScope`. */
export type ProjectScope = { readonly schemaVersion: 1; readonly mode: 'all' } | { readonly schemaVersion: 1; readonly mode: 'selected'; readonly projects: readonly string[] };
/** Background service (`runtime.service` with `"service": { "start": "onEnable" }`): one per package, started at app start and on enable for an enabled, trusted package holding the `runtime.service` grant; see docs/extensions/runtime-service-lifetime.md. */
export type ServiceStartReason = 'appStart' | 'enable' | 'restart' | 'update';
/** A revoked `runtime.service` grant stops the service with `trust`. */
export type ServiceStopReason = 'disable' | 'uninstall' | 'update' | 'trust' | 'safeMode' | 'quit' | 'stop' | 'park';
export interface ServiceLifetime {
  readonly reason: ServiceStartReason;
  readonly restarts: number;
  /** Runs before the process is ended; the host waits at most 2 s. */
  onStop(handler: (reason: ServiceStopReason) => void | Promise<void>): Disposable;
  /** One line for the Running list. `working: true` makes the quit confirmation name the service. */
  setStatus(status: { text: string; working?: boolean }): Promise<null>;
}
/** The service's host object in this release: owned command handlers registered here live in the service's shared state. */
/** `tasks.start` (project scoped): starts a task as the user would, attributed to the package. `harness`, `model`, `effort` and `mode` default to the user's; `worktree` is `current` (default), `new` or an existing branch; `target` is a machine that is already paired (pairing and remote access are not package operations). No grant, a narrowed project: `PermissionDenied`; unknown project, harness or target: `NotFound`; a signed-out or missing harness: `HostUnavailable` with the readiness state in `ids`. A refusal creates no task. */
export interface TasksStartOptions { readonly projectId: string; readonly prompt: string; readonly harness?: string; readonly model?: string; readonly effort?: string; readonly mode?: 'ask' | 'auto' | 'review' | 'plan' | 'full'; readonly title?: string; readonly worktree?: 'current' | 'new' | string; readonly target?: string; readonly attachments?: readonly string[] }
export interface TasksMessage { readonly text?: string; readonly attachments?: readonly string[]; readonly delivery?: 'queue' | 'steer' }
export interface QueueEntry { readonly id: string; readonly position: number; readonly text: string; readonly truncated: boolean; readonly attachments: number; readonly createdAt: number; readonly updatedAt: number; readonly package?: string; readonly changedBy?: string }
export interface TasksQueueApi {
  list(taskId: string): Promise<{ readonly revision: number; readonly entries: readonly QueueEntry[] }>;
  update(taskId: string, entryId: string, change: { text: string; revision?: number }): Promise<null>;
  remove(taskId: string, entryId: string): Promise<null>;
  reorder(taskId: string, entryIds: readonly string[]): Promise<null>;
  sendNow(taskId: string, entryId: string): Promise<null>;
  resume(taskId: string): Promise<null>;
}
/** `tasks.draft` / `tasks.attachments` (R0403): a composer target is exactly one of `taskId` or `windowId`. Editing never sends. See docs/extensions/runtime-tasks-drafts.md. */
export type DraftTarget = { readonly taskId: string; readonly windowId?: never } | { readonly windowId: string; readonly taskId?: never }
export interface DraftAttachment { readonly id: string; readonly kind: string; readonly name: string }
export interface TasksDraftApi {
  get(target: DraftTarget): Promise<{ readonly text: string; readonly attachments: readonly DraftAttachment[]; readonly revision: number }>;
  set(options: DraftTarget & { text: string; revision?: number }): Promise<{ readonly revision: number }>;
  insert(options: DraftTarget & { text: string }): Promise<{ readonly revision: number }>;
  suggest(options: DraftTarget & { text: string }): Promise<null>;
  attach(options: DraftTarget & { path: string }): Promise<{ readonly id: string }>;
  detach(options: DraftTarget & { attachmentId: string }): Promise<null>;
}
/** One page of at most 256 KiB decoded; `data` is base64 and `nextCursor` is the byte cursor of the next page, `null` at the end. */
export interface AttachmentChunk { readonly schemaVersion: 1; readonly mime: string; readonly name: string; readonly bytes: number; readonly data: string; readonly nextCursor: number | null }
export interface TasksAttachmentsApi { read(options: { taskId: string; attachmentId: string; cursor?: number }): Promise<AttachmentChunk> }
/** `terminals.read` / `terminals.write` (R0409). A page is at most 64 KiB; `cursor` is where `data` starts and `nextCursor` where the next page starts; `dropped` counts bytes that left the 256 KiB log first. See docs/extensions/runtime-terminals.md. */
export interface TerminalInfo { readonly id: string; readonly title: string; readonly cwd: string; readonly projectId: string; readonly taskId: string | null; readonly kind: 'shell' | 'script' | 'harness'; readonly running: boolean; readonly exitCode: number | null }
export interface TerminalOutput { readonly schemaVersion: 1; readonly data: string; readonly cursor: number; readonly nextCursor: number; readonly dropped: number; readonly exited: boolean; readonly exitCode: number | null }
/** `guests.control` (R0410). An id is `<kind>:<name>` (`vm:<name>`, `simulator:<udid>`, `browser:page`). A capture is a file in the package's data directory, never image bytes. See docs/extensions/runtime-guests.md. */
export interface GuestKindInfo { readonly kind: 'vm' | 'simulator' | 'browser'; readonly supported: boolean; readonly reason?: string; readonly available?: boolean }
export interface GuestInfo { readonly id: string; readonly kind: 'vm' | 'simulator' | 'browser'; readonly name: string; readonly state: string; readonly interactive: boolean }
export interface GuestCapture { readonly schemaVersion: 1; readonly id: string; readonly kind: 'vm' | 'simulator' | 'browser'; readonly path: string; readonly mime: 'image/png' | 'image/jpeg'; readonly bytes: number; readonly width?: number; readonly height?: number }
export interface GuestsApi {
  list(): Promise<{ readonly schemaVersion: 1; readonly kinds: readonly GuestKindInfo[]; readonly guests: readonly GuestInfo[] }>;
  capture(id: string): Promise<GuestCapture>;
  input(id: string, input: Record<string, unknown>): Promise<{ readonly schemaVersion: 1; readonly result: unknown }>;
  control(id: string, action: 'start' | 'stop' | 'suspend' | 'boot' | 'shutdown' | 'light' | 'dark' | 'back' | 'forward' | 'reload'): Promise<null>;
}
export interface TerminalsApi {
  list(options?: { projectId?: string }): Promise<readonly TerminalInfo[]>;
  read(options: { terminalId: string; cursor?: number }): Promise<TerminalOutput>;
  /** At most ten coalesced chunks a second; omit `cursor` to start at the end. Dispose to stop. */
  onOutput(options: { terminalId: string; cursor?: number }, handler: (chunk: TerminalOutput) => void | Promise<void>): { dispose(): void };
  open(options: { projectId: string; taskId?: string; cols?: number; rows?: number }): Promise<{ readonly id: string; readonly projectId: string; readonly taskId: string | null }>;
  write(options: { terminalId: string; data: string }): Promise<null>;
  close(options: { terminalId: string }): Promise<null>;
}
/** `internal.unstable` (R1301): UNSTABLE, there is NO compatibility promise. Service only (a panel answers `UnsupportedCapability`); host operations and events by name, from the host's native table. A name that denotes a credential is `PermissionDenied`; every call is written to the package's activity list. No reference package uses it. See docs/extensions/runtime-internal-unstable.md. */
export interface InternalApi {
  /** Runs a registered host operation (today `internal.info` and `internal.echo`). `NotFound` for any other name; `args` is JSON of at most 64 KiB. */
  invoke(command: string, args?: Json): Promise<Json>;
  /** At most 16 listeners a package; the host queues 64 events a listener and the service pumps them every 100 ms. Dispose to stop. */
  listen(event: string, handler: (payload: Json) => void | Promise<void>): { dispose(): void };
}
/** What `tasks.configure` may change (R0404): the picker's fields. A harness always comes with its model; `null` clears effort, team, connection and bot. See docs/extensions/runtime-tasks-control.md. */
export interface TasksConfigureChange { harness?: string; model?: string; effort?: string | null; team?: string | null; connection?: string | null; bot?: string | null; target?: string; stage?: 'active' | 'completed' }
export interface TasksApi {
  readonly draft: TasksDraftApi;
  readonly attachments: TasksAttachmentsApi;
  start(options: TasksStartOptions): Promise<{ readonly id: string; readonly projectId: string; readonly worktree: string | null }>;
  message(taskId: string, message: TasksMessage): Promise<{ readonly id: string; readonly delivery: 'sent' | 'queued' | 'steered' }>;
  note(taskId: string, note: { text: string; forModel?: boolean }): Promise<{ readonly id: string }>;
  readonly queue: TasksQueueApi;
  /** Permission `tasks.control`, per project. Runs the interface's own stop; an idle task changes nothing. */
  stop(taskId: string): Promise<null>;
  /** Refused while an agent runs, and from inside a hook (PermissionDenied, path `setMode`). */
  setMode(taskId: string, mode: 'ask' | 'auto' | 'review' | 'plan' | 'full'): Promise<null>;
  configure(taskId: string, change: TasksConfigureChange): Promise<null>;
  /** UnsupportedCapability when the harness has no compaction; `task.compacted` is emitted when it completes. */
  compact(taskId: string): Promise<null>;
  /** Permission `tasks.control`, per project (R0404B). The strip's Accept and finish, its close button and its Keep fixing. `keepFixing` waits for an idle lead (Conflict). See docs/extensions/runtime-tasks-flow.md. */
  council(taskId: string, decision: 'accept' | 'dismiss' | 'keepFixing'): Promise<null>;
  /** One worker of a team: `stop`, `skip` (abandon, as the lead's cancel), `retry` (a failed worker) and `resume` (a stopped one). A paused team takes its own Resume. A reviewer is never retried. */
  worker(taskId: string, workerId: string, action: 'retry' | 'resume' | 'skip' | 'stop'): Promise<null>;
  /** The banner's Continue (on another connection of the task's harness when `connection` names one), Resume at reset and dismissal. `harness` may only be the task's own. */
  limit(taskId: string, action: 'continue' | 'resume' | 'dismiss', options?: { connection?: string; harness?: string }): Promise<null>;
  /** Permission `harness.hooks.decide`, per project and tool kind (a question counts as `other`) (R0508). Answers an approval or question still open in the task, however long after the hook budget; whoever answers first wins. StaleContext once it is no longer open, NotFound for an id never issued, UnsupportedCapability for an approve the task's mode or sandbox holds. See docs/extensions/runtime-late-responses.md. */
  respond(taskId: string, requestId: string, answer: { approved: boolean; reason?: string } | { answers: Readonly<Record<string, string | readonly string[] | boolean | number | null>> }): Promise<null>;
}
/** `workspace.settings` (global): the app's own settings, by the frozen keys `sidebar.sort`, `sidebar.filter`, `sidebar.scope`, `sidebar.order`, `view.open`, `tiles.layout`, `find.query`, `projects.search`, `tokenSaver`, `council`, `bot:<id>`, `channel:<id>`, `team.profiles`, `widgets`, `machines.orchestration`, `appearance.compact` and `appearance.theme`. An unknown key (telemetry, routing, the GitHub switch, safe mode, updates, trust, pairing and remote access are not keys) answers `NotFound`; a `revision` that is not the current one answers `StaleContext`. A fixed key nobody has written reads `null` at revision 0. See docs/extensions/runtime-workspace-settings.md. */
/** `workspace.manage` (global): bots as the New bot form makes them. `update` is a patch; `remove` deletes the bot and its channel connections (its workspace folder stays) and asks the host first unless the user turned that off for the package. See docs/extensions/runtime-workspace-automation.md. */
export interface WorkspaceBotInput { readonly name?: string; readonly role?: string; readonly instructions?: string; readonly goals?: string; readonly soul?: string; readonly avatar?: string; readonly provider?: string; readonly model?: string; readonly mode?: string; readonly heartbeatMinutes?: number; readonly color?: string; readonly reasoningEffort?: string; readonly backupModels?: readonly { readonly provider: string; readonly model: string }[]; readonly fallbackMode?: 'ask' | 'auto'; readonly notify?: boolean; readonly whileWorking?: 'queue' | 'steer'; readonly showPlan?: boolean; readonly skills?: readonly string[]; readonly mcp?: readonly string[] }
export interface WorkspaceBot { readonly id: string; readonly name: string; readonly role: string; readonly projectId: string; readonly provider: string; readonly model: string; readonly mode: string; readonly heartbeatMinutes: number; readonly paused: boolean; readonly skills: readonly string[]; readonly mcp: readonly string[]; readonly [field: string]: unknown }
export interface WorkspaceBotsApi { create(input: WorkspaceBotInput & { readonly name: string }): Promise<WorkspaceBot>; update(botId: string, input: WorkspaceBotInput): Promise<WorkspaceBot>; remove(botId: string): Promise<null> }
/** `workspace.manage` (global): shared bot channels. `remove` archives the channel (restorable under Deleted channels) and asks the host first unless the user turned that off for the package. */
export interface WorkspaceChannelInput { readonly name?: string; readonly memberIds?: readonly string[]; readonly leadBotId?: string | null }
export interface WorkspaceChannel { readonly id: string; readonly name: string; readonly memberIds: readonly string[]; readonly leadBotId: string | null; readonly archived: boolean; readonly updatedAt: number }
export interface WorkspaceChannelsApi { create(input: WorkspaceChannelInput & { readonly name: string; readonly memberIds: readonly string[] }): Promise<WorkspaceChannel>; update(channelId: string, input: WorkspaceChannelInput): Promise<WorkspaceChannel>; remove(channelId: string): Promise<null> }
export interface WorkspaceSettingsApi { list(): Promise<readonly string[]>; get(key: string): Promise<{ readonly key: string; readonly value: unknown; readonly revision: number }>; set(key: string, value: unknown, options?: { readonly revision?: number }): Promise<null> }
/** `workspace.recipes` and `workspace.wakeups` (`workspace.manage`, project scoped): recipe ids are `global:<name>` or `project:<projectId>:<name>`; a wake-up id is the schedule's id. Removals ask the host first unless the user turned that off for the package (`Cancelled` when refused). See docs/extensions/runtime-workspace-schedules.md. */
export interface WorkspaceRecipeStep { readonly kind: 'prompt' | 'slash' | 'check' | 'approval'; readonly text?: string; readonly command?: string; readonly requires?: readonly string[] }
export interface WorkspaceRecipesListInput { readonly projectId?: string }
export interface WorkspaceRecipesSaveInput { readonly scope: 'project' | 'global'; readonly projectId?: string; readonly name: string; readonly description?: string; readonly steps: readonly WorkspaceRecipeStep[] }
export interface WorkspaceRecipesRunInput { readonly taskId: string }
export interface WorkspaceRecipe { readonly id: string; readonly scope: 'project' | 'global'; readonly projectId: string | null; readonly name: string; readonly description: string; readonly steps: readonly WorkspaceRecipeStep[]; readonly by: string | null }
export interface WorkspaceRecipesRunResult { readonly recipeId: string; readonly taskId: string; readonly queued: number; readonly entries: readonly string[]; readonly steps: readonly { readonly index: number; readonly status: 'supported' | 'fallback' | 'manual' | 'blocked'; readonly reason: string }[] }
export interface WorkspaceRecipesApi { list(options?: WorkspaceRecipesListInput): Promise<readonly WorkspaceRecipe[]>; save(recipe: WorkspaceRecipesSaveInput): Promise<{ readonly id: string }>; remove(recipeId: string): Promise<null>; run(recipeId: string, options: WorkspaceRecipesRunInput): Promise<WorkspaceRecipesRunResult> }
export interface WorkspaceWakeupsListInput { readonly taskId?: string }
export interface WorkspaceWakeupsInput { readonly sessionId: string; readonly title?: string; readonly prompt: string; readonly kind: 'once' | 'interval' | 'daily' | 'weekdays' | 'weekly' | 'after'; readonly intervalMinutes?: number | null; readonly timeOfDay?: string | null; readonly days?: readonly number[]; readonly runAt?: number | null; readonly watchSessionId?: string | null; readonly onlyOnSuccess?: boolean; readonly maxRuns?: number | null; readonly workflowId?: string | null; readonly chainFromId?: string | null }
export interface WorkspaceWakeup { readonly id: string; readonly sessionId: string; readonly projectId: string; readonly title: string; readonly prompt: string; readonly kind: string; readonly enabled: boolean; readonly by: string | null; readonly [field: string]: unknown }
export interface WorkspaceWakeupsApi { list(options?: WorkspaceWakeupsListInput): Promise<readonly WorkspaceWakeup[]>; create(input: WorkspaceWakeupsInput): Promise<WorkspaceWakeup>; update(wakeupId: string, input: WorkspaceWakeupsInput): Promise<WorkspaceWakeup>; remove(wakeupId: string): Promise<null> }
export interface ServicePandaCode { readonly apiVersion: '1.0.0'; readonly commands: { register(id: string, handler: (invocation: unknown) => unknown): Disposable }; readonly secrets: PrivateSecrets; readonly events: WorkspaceEvents; readonly hooks: ServiceHooks; readonly modelTools: ServiceModelTools; readonly models: ServiceModels; readonly storage: ServiceStorage; readonly auth: ServiceAuth; readonly settings: PackageSettings; readonly context: ServiceContext; readonly harnesses: ServiceHarnesses; readonly providers: ServiceProviders; readonly ui: ServiceUi; readonly tasks: TasksApi; readonly terminals: TerminalsApi; readonly internal: InternalApi; readonly guests: GuestsApi; readonly workspace: { readonly bots: WorkspaceBotsApi; readonly channels: WorkspaceChannelsApi; readonly settings: WorkspaceSettingsApi; readonly recipes: WorkspaceRecipesApi; readonly wakeups: WorkspaceWakeupsApi; readonly moodboards: WorkspaceMoodboardsApi; readonly cloud: WorkspaceCloudApi; readonly projects: WorkspaceProjectsApi; readonly worktrees: WorkspaceWorktreesApi; readonly branches: WorkspaceBranchesApi; readonly tasks: WorkspaceTasksApi; readonly pulls: WorkspacePullsApi }; readonly projects: { readonly checks: ProjectChecksApi }; readonly views: PanelViews }
/** A moodboard as the host stores it. */
export interface MoodboardInfo { readonly id: string; readonly projectId: string; readonly name: string; readonly imageCount: number; readonly updatedAt: number }
/** `workspace.manage` (project scoped): moodboard content, over the same native commands the moodboard panel uses. `remove` is irreversible: the host confirms by default (the user can turn that off per package) and a declined one answers `Cancelled`. An image is `{ name, dataUrl }` (a `data:image/...` URL up to 17 MiB); 24 boards a project and 64 images a board. A board of a project outside the grant answers `PermissionDenied`. */
export interface WorkspaceMoodboardsApi {
  create(input: { projectId: string; name: string }): Promise<MoodboardInfo>;
  rename(boardId: string, name: string): Promise<MoodboardInfo>;
  remove(boardId: string): Promise<null>;
  addImage(boardId: string, input: { name: string; dataUrl: string }): Promise<MoodboardInfo & { readonly images: readonly { readonly id: string; readonly name: string; readonly caption: string; readonly width: number; readonly height: number; readonly createdAt: number }[] }>;
  removeImage(boardId: string, imageId: string): Promise<null>;
}
/** A project as the workspace lists it. */
export interface WorkspaceProjectInfo { readonly projectId: string; readonly name: string }
/** `workspace.manage` (project scoped): the frozen input of each call; `projects.add` takes a path (the folder chooser stays the user's) and needs the grant for every project. `projects.remove`, `tasks.remove`, `worktrees.remove`, `branches.remove` and `pulls.merge` are irreversible: the host confirms by default (the user can turn that off per package) and a declined one answers `Cancelled`. Pairing a machine and remote access are not methods. A worktree is identified by its task's id. */
export interface WorkspaceProjectsApi {
  add(input: { path: string }): Promise<WorkspaceProjectInfo>;
  remove(projectId: string): Promise<null>;
  rename(projectId: string, name: string): Promise<WorkspaceProjectInfo>;
  relink(projectId: string, path: string): Promise<WorkspaceProjectInfo>;
}
export interface WorkspaceWorktreesApi {
  create(input: { taskId: string; branch: string; base?: string; existing?: boolean }): Promise<{ readonly worktreeId: string; readonly taskId: string; readonly projectId: string; readonly branch: string }>;
  remove(worktreeId: string, options?: { deleteBranch?: boolean }): Promise<{ readonly removed: boolean; readonly branch: string; readonly branchDeleted: boolean; readonly note: string }>;
  recreate(worktreeId: string): Promise<{ readonly worktreeId: string; readonly branch: string }>;
  merge(worktreeId: string): Promise<{ readonly branch: string; readonly target: string; readonly commits: number; readonly switchedFrom: string | null }>;
}
export interface WorkspaceBranchList { readonly current: string; readonly branches: readonly string[]; readonly defaultBranch: string }
export interface WorkspaceBranchesApi {
  create(input: { projectId: string; taskId?: string; name: string; from?: string; switch?: boolean }): Promise<WorkspaceBranchList>;
  switch(input: { projectId: string; taskId?: string; branch: string }): Promise<WorkspaceBranchList>;
  rename(input: { projectId: string; taskId?: string; from: string; to: string }): Promise<WorkspaceBranchList>;
  remove(input: { projectId: string; taskId?: string; branch: string; force?: boolean }): Promise<WorkspaceBranchList>;
}
export interface WorkspaceTasksApi {
  remove(taskId: string): Promise<{ readonly taskIds: readonly string[] }>;
  rename(taskId: string, title: string): Promise<null>;
  move(taskId: string, projectId: string): Promise<{ readonly taskId: string; readonly projectId: string }>;
}
export interface WorkspacePullInfo { readonly number: number; readonly url: string; readonly title: string; readonly state: string }
export interface WorkspacePullsApi {
  link(taskId: string, input: { reference: string }): Promise<WorkspacePullInfo>;
  unlink(taskId: string): Promise<null>;
  check(taskId: string): Promise<Json>;
  merge(taskId: string, options?: { method?: 'squash' | 'merge' | 'rebase' }): Promise<WorkspacePullInfo>;
}
/** `projects.checks.run` (per project, revocable, no prompt after the grant): runs the project's check script in the task's checkout through the existing runner. No plan is a report, not an error. */
export interface ProjectChecksApi { run(input: { taskId: string }): Promise<{ readonly schemaVersion: 1; readonly report: Json }> }
/** A cloud machine as the machines panel lists it. */
export interface CloudMachineInfo { readonly id: string; readonly provider: string; readonly name: string; readonly state: string; readonly os: string; readonly desktop: boolean; readonly detail: string }
/** `workspace.manage`: provision (only a provider the user already connected, else `UnsupportedCapability`) and control cloud machines. `sync`, `retry` and the task-owned `stop` and `remove` reach the cloud task that owns the machine; `remove` is irreversible and confirms by default. Connecting a provider, pairing, remote access and credentials are not methods or fields. A machine no task owns, and `provision`, need the grant for every project. */
export interface WorkspaceCloudApi {
  provision(input: { provider: string; name: string }): Promise<CloudMachineInfo>;
  sync(machineId: string): Promise<null>;
  retry(machineId: string): Promise<null>;
  open(machineId: string): Promise<null>;
  stop(machineId: string): Promise<null>;
  remove(machineId: string): Promise<null>;
}
/** One mount of a rich view (R0303): its own id, document and `state`. An inspector panel keeps its id across a reload or failure in this run. See docs/extensions/runtime-rich-channel.md. */
export interface PanelInstance { readonly instanceId: string; readonly viewId: string; readonly windowId: string; readonly placement: 'inspector' | 'floating' | 'window' | 'band' | 'editor'; readonly visible: boolean; readonly focused: boolean; readonly scope?: { readonly taskId?: string; readonly projectId?: string } }
/** `panda.views` of a service (`ui.richViews`): `post` without `instance` reaches every live instance of the view and answers how many received it (nothing is queued for a closed one); messages are at most 256 KiB of JSON and 20 per second per package in each direction (`LimitExceeded`). A view that is not a rich view of the package is `NotFound`. */
export interface PanelViews {
  post(viewId: string, message: Json, options?: { readonly instance?: string }): Promise<{ readonly delivered: number }>;
  onMessage(viewId: string, handler: (message: Json, from: PanelInstance) => void | Promise<void>): Disposable;
  on(kind: 'opened' | 'visible' | 'hidden' | 'closed', handler: (instance: PanelInstance) => void): Disposable;
  instances(viewId?: string): Promise<readonly PanelInstance[]>;
}
/** The finite theme a panel receives (today's theme message). */
export interface PanelTheme { readonly schemaVersion: 1; readonly colorScheme: 'light' | 'dark'; readonly tokens?: Readonly<Record<string, string>> }
/** What `pandaView.onDidInitialize` receives: today's `{ dto, theme }` envelope, plus the instance of a served panel (absent for the legacy inline form). */
export interface PanelInit { readonly dto: Json; readonly theme: PanelTheme; readonly instanceId?: string; readonly viewId?: string; readonly placement?: PanelInstance['placement']; readonly restored?: boolean; readonly state?: Json }
/** The package SDK inside a panel, through the host: every call the package holds a grant for except the service-only ones (secrets, sign-in, the data directory, internal calls and handler registrations), which reject with `UnsupportedCapability`. */
export type PanelApi = Omit<ServicePandaCode, 'secrets' | 'auth' | 'events' | 'commands' | 'views' | 'providers' | 'storage' | 'internal'>;
/** `window.pandaView` in a rich panel (R0302 `baseUrl`, R0303 channel). Callbacks return a bare unsubscribe function. */
export interface PandaView {
  onDidInitialize(callback: (init: PanelInit) => void): () => void;
  onDidChangeTheme(callback: (theme: PanelTheme) => void): () => void;
  readonly viewId: string; readonly instanceId: string; readonly baseUrl?: string;
  /** To the service; `UnsupportedCapability` without one, `HostUnavailable` while it is not running, `LimitExceeded` past the bounds. */
  postMessage(message: Json): Promise<null>;
  onMessage(callback: (message: Json) => void): () => void;
  /** Called once after initialization and at every change. */
  onDidChangeVisibility(callback: (state: { readonly visible: boolean; readonly focused: boolean }) => void): () => void;
  /** Synchronous; `set` throws `LimitExceeded` above 256 KiB. Kept for one run of the app, across hiding, reload and failure. */
  readonly state: { get(): Json | undefined; set(value: Json): void };
  /** R0304: gives the keyboard back to the app control that had it before the panel (the same as an unhandled Escape). */
  releaseFocus(): void;
  readonly panda: PanelApi;
}
/** What the user answered a service's dialog (R0206). A dialog that was closed, or whose service ended, is `cancelled`. */
export type DialogAnswer = { readonly status: 'confirmed'; readonly values: Readonly<Record<string, string | boolean | readonly string[]>> } | { readonly status: 'cancelled' };
/** Where `reveal` takes the window: a view or settings page of this package, a task, or a file of a project (relative path). */
export type RevealTarget = { readonly view: string } | { readonly taskId: string } | { readonly projectId: string; readonly path: string; readonly line?: number; readonly editor?: string } | { readonly settingsPage: string };
/** The `ui` of a background service (needs `runtime.service` and the `ui.dynamic` grant, checked on every call). */
export interface ServiceUi {
  /** Shows the dialog and resolves with the user's answer. One dialog may be open per package: a second call while one is open rejects with Conflict. A dialog waits while another one is open. */
  showDialog(dialog: DialogDefinition): Promise<DialogAnswer>;
  register(item: RuntimeContribution): Promise<RuntimeItem>;
  update(id: string, patch: RuntimePatch): Promise<null>;
  updateView(id: string, patch: RuntimePatch): Promise<null>;
  /** Opens one of the package's views or settings pages, selects a task, or opens a project file in the editor (`editor`: the package's own, `line` where the editor supports it). Never moves the keyboard out of a text field; an unknown or stale target rejects with NotFound and nothing is sent to any task. */
  reveal(target: RevealTarget): Promise<null>;
}
/** `panda.settings.get`: the values and revision of one of the package's OWN settings pages (another page is `NotFound`). */
export interface PackageSettings { get(options: { page: string }): Promise<{ readonly schemaVersion: 1; readonly revision: number; readonly values: Readonly<Record<string, Json>> }> }
/** The one-shot task reads of a service: `tasks.summary`, `tasks.transcript.read` and `tasks.tools.read` (the last for `tools` and `changes`). */
export type ContentResource = 'tasks' | 'transcript' | 'tools' | 'changes';
/** The one-shot reads of usage and host figures: `tasks.usage.read` (per project, the last report of each turn), `harnesses.limits.read`, `harnesses.accounts.read` (never a credential value) and `metrics.read` (measured figures only; unmeasured ones are absent and named in `unmeasured`). */
export type UsageResource = 'usage' | 'limits' | 'accounts' | 'metrics';
/** `refreshLimits` needs `harnesses.limits.read` and is admitted once per harness per 60 s (`LimitExceeded` before that); it resolves to `null`. */
/**
 * `switchAccount` makes `account` (an `id` of the `accounts` resource: `default`, or a saved connection of the harness) the
 * active account of `harness`. It needs `credentials.use` for that account's item (`provider:<harness>` for `default`,
 * `connection:<id>`); another item, a revoked grant or a stale version answers `PermissionDenied`, an unknown harness or
 * account `NotFound`. It resolves to `null`: the host does the switch, no credential is returned or replaced (ADR-0006), and
 * the `accounts` resource shows the new `active` flags under a new revision. Each switch is written to the package's activity list.
 */
/** What a package service publishes for one of its own providers with `panda.providers.update` (needs `runtime.service` and `ui.dynamic`). A `signedOut` or `unavailable` readiness empties the account, models and limits in the same step; the values return to the manifest's when the service stops. No credential belongs in any field. See docs/extensions/runtime-provider-state.md. */
export interface ProviderState {
  readiness?: { state: 'ready' | 'signedOut' | 'unavailable'; reason: string };
  account?: { label: string } | null;
  models?: readonly { id: string; name: string; efforts: readonly string[]; contextWindow?: number; speedTiers?: readonly { id: string; name: string; description?: string }[] }[];
  limits?: { windows: readonly { id: string; label: string; usedPercent: number; resetsAt?: string }[]; credits?: unknown } | null;
}
export interface ServiceProviders { update(id: string, state: ProviderState): Promise<null> }
/** Hooks declared in `contributes.hooks` (service only; `harness.hooks.observe`, `documents.editors` for `save.before`). See docs/extensions/runtime-hook-registration.md. */
export type HookEvent = 'turn.start' | 'prompt.submit' | 'tool.before' | 'tool.after' | 'turn.finish' | 'turn.fail' | 'task.idle' | 'compaction'
  | 'approval.pending' | 'approval.resolved' | 'question.pending' | 'question.resolved' | 'save.before';
export interface HookInputChunk { readonly schemaVersion: 1; readonly text: string; readonly cursor: number; readonly nextCursor: number | null; readonly totalBytes: number }
/** `ready` settles with the host's answer: `UnknownReference` for an event the manifest does not declare, `PermissionDenied` without the grant. Deliveries are observe only in this slice: a returned value is never read. */
export interface HookRegistration extends Disposable { readonly ready: Promise<void> }
/** What the host did with a non-empty return of `prompt.submit`, `tool.after` or `compaction` (R0504; see docs/extensions/runtime-hook-context.md). */
export interface HookReceipt {
  readonly schemaVersion: 1; readonly hookId: string; readonly event: HookEvent; readonly taskId: string; readonly callId?: string; readonly applied: boolean;
  /** `Timeout` (R0506): the answer came after the budget and was never applied. */
  readonly code?: 'PermissionDenied' | 'UnsupportedCapability' | 'InvalidShape' | 'LimitExceeded' | 'Timeout';
  readonly refused?: Readonly<Record<string, 'PermissionDenied' | 'UnsupportedCapability'>>;
  /** R0505: an approve or rewrite another package's deny or ask overrode, or an ask a deny overrode. */
  readonly overriddenBy?: { readonly package: string };
}
/** R0505: what a `tool.before` handler returns (needs `harness.hooks.decide` for the call's project and tool kind; see docs/extensions/runtime-hook-decisions.md). `approve` and `rewrite` apply only where the payload's `can` lists `approve` / `rewriteInput`; `note` needs `ui.presentation`. Nothing (or `null`) is no decision. */
export type ToolDecision = void | null
  | { decision: 'approve'; reason?: string; note?: string }
  | { decision: 'deny'; reason: string; note?: string }
  | { decision: 'ask'; reason?: string; note?: string }
  | { decision: 'rewrite'; input: Json; reason?: string; note?: string };
/** Returns the host applies (R0504): `context` needs `harness.hooks.context`; `prompt`, `block`, `output`, `summary`, `instructions`, `cancel` need `harness.hooks.decide` (and, for `output` and compaction, a matching entry in the payload's `can`); `note` needs `ui.presentation`. */
export interface PromptSubmitReturn { context?: string; prompt?: string; block?: { reason: string }; note?: string }
export interface ToolAfterReturn { output?: Json; note?: string }
export interface CompactionReturn { summary?: string; instructions?: string; cancel?: { reason: string } }
/** Model tools declared in `contributes.modelTools` and answered by the service (`tools.model`, service only). See docs/extensions/runtime-model-tools.md. */
export interface ModelToolCall { readonly callId: string; readonly taskId: string; readonly projectId: string; readonly projectRoot: string; readonly cwd: string; readonly harness: string; readonly model: string | null; readonly mode: string; readonly run: HookRun }
/** Always this envelope: a bare return is `InvalidShape`; `content` is at most 64 KiB of compact JSON; `isError: true` gives the model an error result. */
export type ModelToolResult = { readonly content: Json; readonly isError?: boolean };
/** `ready` settles with the host's answer: `UnknownReference` for an id the manifest does not declare, `PermissionDenied` without `tools.model`, `DuplicateId` for a second handler. */
export interface ModelToolRegistration extends Disposable { readonly ready: Promise<void> }
export interface ServiceModelTools { register(id: string, handler: (input: Json, call: ModelToolCall) => ModelToolResult | Promise<ModelToolResult>): ModelToolRegistration }
/** One bounded model answer (`models.call`, service only): one prompt, no tools, no hooks, no task, no session kept. `harness` and `model` default to those of `taskId`, otherwise to the user's defaults for `projectId` or for new tasks; `taskId` only chooses defaults and the usage label. `timeoutMs` is 1,000 to 600,000 (default 60,000) and covers the wait and the run; two calls run and eight wait per package, then `LimitExceeded`. A signed-out harness is `HostUnavailable`, one without a hidden-run path `UnsupportedCapability`, a revoked grant or a stopped service `PermissionDenied`, an aborted `signal` `Cancelled`. See docs/extensions/runtime-model-call.md. */
export interface ModelCallOptions { readonly prompt: string; readonly system?: string; readonly harness?: string; readonly model?: string; readonly effort?: string; readonly projectId?: string; readonly taskId?: string; readonly timeoutMs?: number; readonly signal?: AbortSignal }
export interface ModelCallResult { readonly text: string; readonly harness: string; readonly model: string; readonly usage?: { readonly input?: number; readonly output?: number } }
export interface ServiceModels { call(options: ModelCallOptions): Promise<ModelCallResult> }
/** An intent rule of a package command-line tool, in `contributes.cliIntents` (`tools.model`). A hint for the host classifier, never a gate. See docs/extensions/runtime-cli-intent.md. */
export interface CliIntentRule { readonly id: string; readonly command: string; readonly words?: readonly string[]; readonly flags?: readonly string[]; readonly intent: { readonly kind: string; readonly verb: string; readonly label?: string; readonly object?: string } }
/** The classification of a shell call as a hook payload carries it in `intent` (present only when a package rule matched). */
export interface CliIntentClassification { readonly schemaVersion: 1; readonly status: 'Matched' | 'Unmatched' | 'NoRule' | 'Unparseable'; readonly segments: readonly { readonly text: string; readonly status: string; readonly rule: string | null; readonly owner: string | null; readonly package: string | null; readonly intent: Json | null; readonly candidates: readonly string[] }[]; readonly hint: { readonly rule: string; readonly owner: string; readonly package: string; readonly intent: Json } | null }
/** R0507: `approval.pending` (see docs/extensions/runtime-pending-requests.md). Fields are frozen when the prompt appears; `input` is the complete input when it travels structured (1 MiB). */
export interface PendingApproval {
  readonly requestId: string; readonly callId?: string; readonly taskId: string; readonly projectId: string; readonly harness: string; readonly mode: string;
  readonly tool: { readonly kind: string; readonly name: string }; readonly text: string; readonly input?: Json;
  readonly askedBy: 'harness' | 'mode' | { readonly package: string }; readonly at: string;
}
/** R0507: `question.pending`. */
export interface PendingQuestion {
  readonly requestId: string; readonly taskId: string; readonly projectId: string; readonly harness: string;
  readonly questions: readonly { readonly id: string; readonly header?: string; readonly question: string; readonly options?: readonly { readonly label: string; readonly description?: string }[]; readonly multiple?: boolean; readonly secret?: boolean }[];
  readonly at: string;
}
/** R0507: `approval.resolved`, once per pending approval. `mode`: withdrawn by the harness after the task's mode changed. */
export interface ApprovalResolved { readonly requestId: string; readonly callId?: string; readonly taskId: string; readonly approved: boolean; readonly reason?: string; readonly by: 'user' | 'mode' | 'cancelled' | { readonly package: string } }
/** R0507: `question.resolved`, once per pending question; `answers` never holds a secret question's answer. */
export interface QuestionResolved { readonly requestId: string; readonly taskId: string; readonly by: 'user' | 'cancelled' | { readonly package: string }; readonly answers?: Json }
/** R0507: `panda.hooks.pending()`, the open set now, filtered like a live delivery; a resolved request is never in it. */
export interface PendingSnapshot { readonly schemaVersion: 1; readonly revision: number; readonly approvals: readonly PendingApproval[]; readonly questions: readonly PendingQuestion[]; readonly truncated: boolean }
export interface ServiceHooks {
  on(event: HookEvent, handler: (payload: Json) => unknown): HookRegistration;
  input(options: { callId: string; cursor: number }): Promise<HookInputChunk>;
  onApplied(handler: (receipt: HookReceipt) => void): Disposable;
  /** `UnknownReference` without an attached `approval.*` or `question.*` hook. */
  pending(): Promise<PendingSnapshot>;
}
/** `harnesses.console` and `harnesses.commands` (R0408, `harness.console`): the user's own harness console and slash commands, per project grant. A task that is running answers `Busy` to `console.open`; a package harness has no console (`UnsupportedCapability`). See docs/extensions/runtime-harness-console.md. */
export interface HarnessConsoleApi { open(options: { taskId: string } | { harness: string; projectId: string }): Promise<null> }
export interface HarnessCommandsApi { list(options: { harness: string }): Promise<readonly { readonly id: string; readonly title: string }[]>; run(options: { taskId: string; command: string; arguments?: string }): Promise<null> }
/** R0509: what each cell is known from. `installedQualified` only with an authorized capture on an installed harness. */
export type CapabilityQualification = 'sourceFeasible' | 'recorded' | 'installedQualified' | 'unsupported';
export type HookSource = 'companion' | 'askAtHost' | 'permissionRequest' | 'hostTool' | 'activity';
export type HookCoverage = 'everyCall' | 'askedCalls' | 'escalationsOnly' | 'afterOnly' | 'none';
/** The `run` of every hook payload: `kind` is what `match.runs` filters on, `trigger` what started the turn. */
export interface HookRun { readonly kind: 'task' | 'worker' | 'bot' | 'schedule' | 'remote'; readonly trigger: 'user' | 'package' | 'tool' | 'team' | 'council' | 'bot' | 'schedule' | 'remote' | 'cloud' | 'mirror'; readonly executor: 'desktop' | 'headless' | 'cloud' | 'remote'; readonly parentTaskId?: string; readonly workerId?: string; readonly lens?: string; readonly botId?: string; readonly scheduleId?: string; readonly deviceId?: string; readonly hostId?: string; readonly tool?: string; readonly package?: string }
export interface ToolBeforeCell { readonly source: 'permissionRequest' | null; readonly coverage: HookCoverage; readonly can: readonly string[]; readonly sourceCan: readonly string[]; readonly qualification: CapabilityQualification; readonly feasible: readonly { readonly source: HookSource; readonly coverage: HookCoverage; readonly qualification: CapabilityQualification }[] }
/** One harness row of `panda.harnesses.list` (see docs/extensions/runtime-harness-coverage.md). */
export interface HarnessCapabilities {
  readonly schemaVersion: 1; readonly id: string; readonly name: string; readonly kind: 'builtin' | 'package'; readonly owner?: string; readonly installed: 'Installed' | 'Absent' | 'Unknown';
  readonly modes: readonly string[]; readonly evidence: 'frame' | 'spike' | 'documentation';
  readonly toolServers: { readonly value: boolean; readonly qualification: CapabilityQualification };
  readonly compact: { readonly how: 'request' | 'command' | 'none'; readonly qualification: CapabilityQualification };
  readonly denyReason: 'answer' | 'steer' | 'none'; readonly rewriteInput: boolean;
  readonly companion: { readonly state: 'sourceFeasible' | 'unknown' | 'none'; readonly mechanism: string | null; readonly qualification: CapabilityQualification };
  readonly hooks: { readonly toolBefore: Readonly<Record<string, ToolBeforeCell>>; readonly toolAfter: Json; readonly hostTools: Json; readonly promptSubmit: Json; readonly turn: Json; readonly compaction: Json };
}
export interface HarnessCoverageReport { readonly companionCoverage?: readonly CompanionCoverage[]; readonly packageCompanions?: readonly (PackageCompanionDeclaration & { readonly owner: string; readonly packageName: string; readonly code: string | null })[]; readonly schemaVersion: 1; readonly decisions: 'delivered'; readonly harnesses: readonly HarnessCapabilities[]; readonly runs: readonly { readonly kind: HookRun['kind']; readonly paths: readonly Json[]; readonly counters: Json }[] }
export interface ServiceHarnesses { list(options?: { harness?: string; includeModels?: false }): Promise<HarnessCoverageReport>; refreshLimits(options?: { harness?: string }): Promise<null>; switchAccount(options: { harness: string; account: string }): Promise<null>; readonly console: HarnessConsoleApi; readonly commands: HarnessCommandsApi }
export interface ResourcePage { readonly schemaVersion: 1; readonly state: 'Ready'; readonly revision: string; readonly items: readonly Json[]; readonly nextCursor: number | null }
export interface ServiceContext { query(options: { resource: ContextResource | ContentResource | UsageResource; taskId?: string; harness?: string; limit?: number; cursor?: number; revision?: string }): Promise<SummaryPage | ResourcePage> }
/** Browser sign-in (`auth.signIn`, service only; see docs/extensions/runtime-sign-in.md): the host opens the system browser, listens on a loopback address for the redirect and returns the whole redirected address (it carries the authorization code, so keep it in the service). `{redirect_uri}` in `authorizeUrl` is replaced by the encoded listening address. At most one flow per package; a taken port or a second flow answers `Conflict`, a missing browser `HostUnavailable` unless `manual` is true. */
export interface SignInOptions {
  readonly authorizeUrl: string;
  readonly callback: { readonly path: string; readonly port?: number; readonly host?: '127.0.0.1' | 'localhost' };
  /** 1 to 900000 ms; default 120000. */
  readonly timeoutMs?: number;
  /** Offer "Paste the redirect address" when the wait ends or no browser opens; the dialog stays open for 2 minutes. */
  readonly manual?: boolean;
  readonly title?: string;
}
export type SignInResult =
  | { readonly status: 'completed'; readonly url: string; readonly redirectUri: string; readonly via: 'callback' | 'manual' }
  | { readonly status: 'cancelled' }
  | { readonly status: 'timeout' };
export interface ServiceAuth { signIn(options: SignInOptions): Promise<SignInResult> }
/** Workspace events (`events.workspace`, service only; narrowable per project): ids only, in order, at most 256 waiting, then one `gap`. See docs/extensions/runtime-workspace-events.md. */
export type WorkspaceEventKind = 'task.created' | 'task.removed' | 'task.shown' | 'task.stopped' | 'task.idle' | 'task.compacted' | 'turn.started' | 'turn.finished' | 'turn.failed' | 'project.opened' | 'project.closed' | 'settings.changed' | 'app.focus';
export type WorkspaceEventStarter = 'user' | 'bot' | 'schedule' | 'team' | { readonly package: string };
export type WorkspaceEvent = { readonly schemaVersion: 1; readonly sequence: number; readonly at: number } & (
  | { readonly kind: 'task.created'; readonly taskId: string; readonly projectId: string; readonly harness: string; readonly startedBy: WorkspaceEventStarter }
  | { readonly kind: 'task.removed' | 'task.idle' | 'task.compacted'; readonly taskId: string; readonly projectId: string }
  | { readonly kind: 'task.shown'; readonly windowId: string; readonly taskId: string | null; readonly projectId: string | null }
  | { readonly kind: 'task.stopped'; readonly taskId: string; readonly projectId: string; readonly by: 'user' | { readonly package: string } }
  | { readonly kind: 'turn.started' | 'turn.finished' | 'turn.failed'; readonly taskId: string; readonly projectId: string; readonly index: number }
  | { readonly kind: 'project.opened' | 'project.closed'; readonly projectId: string }
  | { readonly kind: 'settings.changed'; readonly page: string; readonly revision: number }
  | { readonly kind: 'app.focus'; readonly focused: boolean }
  | { readonly kind: 'gap'; readonly dropped: number });
export interface WorkspaceEvents {
  /** The handler of one event finishes before the next event reaches any handler. A refused subscription (no grant) leaves the kind without listeners. */
  on<K extends WorkspaceEventKind | 'gap'>(kind: K, handler: (event: Extract<WorkspaceEvent, { kind: K }>) => void | Promise<void>): Disposable;
}
/** The package's data directory (`storage.private`, service only; a short activation answers `UnsupportedCapability`): `global`, or `project` for the call's project (`StaleContext` without one). Kept across disable, update and uninstall; removed by "remove own data". Code runs from the declared `runtime.files` folders; see docs/extensions/runtime-code-folders.md. */
export interface ServiceStorage { directory(options: { scope: 'global' | 'project' }): Promise<{ readonly schemaVersion: 1; readonly path: string }> }
/** The package's own secrets (`secrets.private`, service only): scoped to this package by the host, at most 64 keys (`^[a-z][a-z0-9-]{0,63}$`) of 16 KiB each, kept across disable and update, removed on uninstall. Not a host credential; see docs/extensions/runtime-private-secrets.md. */
export interface PrivateSecrets {
  get(options: { key: string }): Promise<{ readonly value: string | null }>;
  set(options: { key: string; value: string }): Promise<null>;
  delete(options: { key: string }): Promise<null>;
  list(): Promise<{ readonly keys: readonly string[] }>;
}
export type Service = (panda: ServicePandaCode, lifetime: ServiceLifetime) => void | Promise<void>;
/** `contributes.presentations[]` (R1002, `ui.presentation`, at most 16, ids unique): what the user may pick in the Look menu beside the thread. Nothing changes until they choose. See docs/extensions/runtime-transcript-presentation.md. */
export interface WorkingIndicatorPresentation { readonly id: string; readonly title: string; readonly kind: 'working-indicator'; /** 2 to 16 text frames of at most 16 characters. */ readonly frames: readonly string[]; /** 80 to 1000; with reduced motion the first frame is shown still. */ readonly intervalMs: number }
export interface BackdropImagePresentation { readonly id: string; readonly title: string; readonly kind: 'backdrop'; /** An `assets/` SVG that `contributes.icons` also lists. */ readonly image: string; /** 0 to 0.5. */ readonly opacity: number }
export interface BackdropViewPresentation { readonly id: string; readonly title: string; readonly kind: 'backdrop'; /** The id of one of the package's own rich views. */ readonly view: string; /** 0 to 0.5. */ readonly opacity: number }
/** `contributes.toolRows[]` (R1004, `ui.presentation`, at most 16, ids unique): replaces how one kind of built-in tool row reads. The host draws it from these tokens; a package never supplies markup. `{input}` and `{output}` also need `tasks.tools.read`. See docs/extensions/runtime-tool-row-replacement.md. */
export interface ToolRowSelector { /** At least one key; every key must equal the row's fact. A name beats a server, a server a family, a family a kind. */ readonly kind?: string; readonly name?: string; readonly family?: string; readonly server?: string }
export interface ToolRowField { readonly label: string; /** Text and tokens `{name}` `{kind}` `{family}` `{server}` `{status}` `{target}` `{input}` `{output}`, at most 160 characters. */ readonly value: string }
/** `when`: `always`, `failed` and `blocked` read the row; `hook-approve|deny|ask|rewrite` show only when this same package returned that decision for the call (provenance `hook`). */
export interface ToolRowSignal { readonly id: string; readonly risk: 'notice' | 'caution' | 'destructive'; /** At most 24 characters. */ readonly label: string; readonly when: 'always' | 'failed' | 'blocked' | 'hook-approve' | 'hook-deny' | 'hook-ask' | 'hook-rewrite' }
export interface ToolRowDeclaration { readonly id: string; readonly title: string; readonly selector: ToolRowSelector; readonly row: { /** At most 160 characters of text and tokens. */ readonly sentence: string }; readonly card?: { readonly title: string; /** At most 8. */ readonly fields: readonly ToolRowField[] }; /** At most 8. The host's own destructive badge is never hidden or lowered. */ readonly signals?: readonly ToolRowSignal[] }
export type PresentationDefinition = WorkingIndicatorPresentation | BackdropImagePresentation | BackdropViewPresentation;
/** A transcript replacement that keeps the text of the turns and hides the tool steps (`ui.presentation`; no transcript or tool read needed). `capabilities` must include `streaming`, `stop-resume` and `host-history`. */
export interface ConversationTranscriptComponent { readonly id: string; readonly title: string; readonly slot: 'panda.transcript'; readonly contractVersion: 1; readonly presentation: 'conversation'; readonly capabilities: readonly ('streaming' | 'tool-output' | 'questions' | 'approvals' | 'team-progress' | 'usage' | 'stop-resume' | 'host-history')[] }

/** Harness-native package entry, declared in contributes.companions under harness.companions. Native admission requires executable trust and an exact per-run API profile. */
export interface PackageCompanionDeclaration { readonly id: string; readonly title: string; readonly harness: string; /** Relative file inside a runtime.files code folder. */ readonly file: string }
export interface CompanionCoverage { readonly harness: string; readonly adapter: string | null; readonly code: string; readonly reason: string; readonly source: string; readonly fake: string; readonly recorded: string; readonly installed: string; readonly modelRequest: "notReported"; readonly compaction: "notReported" }
