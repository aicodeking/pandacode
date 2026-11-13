/** Public API 1.0.0, experimental. Type-only package; the supervised host supplies the API.
 * No Tauri/DOM/database/credential bridge. API grants are NOT an OS sandbox.
 */
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };
export type Disposable = { dispose(): void };
export interface InvocationContext {
  readonly schemaVersion: 1;
  readonly commandId: string;
  readonly windowId: string;
  readonly surfaceId: string;
  readonly projectId?: string;
  readonly sessionId?: string;
  readonly selection?: Json;
  readonly revision: number;
}
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
  readonly apiVersion: '1.0.0';
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
