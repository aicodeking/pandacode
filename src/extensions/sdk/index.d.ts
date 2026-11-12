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
