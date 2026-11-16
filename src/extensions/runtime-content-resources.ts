// Package settings and content resources for background services (runtime phase R2, slice R0203).
//
// The native rules live in src-tauri/src/extensions/runtime_content_resources.rs; this file mirrors them with no I/O
// for the browser preview and for the deterministic checks of tests/extensions-runtime-content-resources.spec.ts.
// Limits are for stability and predictability, never for trust: a page is at most 50 items and 256 KiB, one text
// field is cut at 64 KiB and says so, a page continued after the data changed is `StaleContext`, and what the store
// holds for a tool call is the display preview, so `inputComplete` and `outputComplete` are always false.

export const PAGE_ITEMS = 50;
export const PAGE_BYTES = 256 * 1024;
export const TEXT_BYTES = 64 * 1024;
export const RESOURCES = { tasks: 'tasks.summary', transcript: 'tasks.transcript.read', tools: 'tasks.tools.read', changes: 'tasks.tools.read' } as const;
export type ContentResource = keyof typeof RESOURCES;
export type ContentCode = 'InvalidShape' | 'InvalidArguments' | 'UnsupportedCapability' | 'LimitExceeded' | 'PermissionDenied' | 'NotFound' | 'StaleContext';
export type Failure = { readonly code: ContentCode };
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;

const canonical = (value: Json): string => (Array.isArray(value) ? `[${value.map(item => canonical(item)).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { [key: string]: Json })[key])}`).join(',')}}`
  : JSON.stringify(value));

/** FNV-1a 64 of the compact JSON of the values (keys sorted), kept to 53 bits: the same number as the native `settings_revision`. */
export function settingsRevision(values: Json): number {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(canonical(values))) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return Number(hash & ((1n << 53n) - 1n));
}

export interface SettingsField { readonly id: string; readonly kind: 'text' | 'textarea' | 'switch' | 'select'; readonly value?: Json; readonly multiple?: boolean }
export interface SettingsPage { readonly id: string; readonly fields: readonly SettingsField[] }
export interface SettingsPackage { readonly id: string; readonly enabled: boolean; readonly pages: readonly SettingsPage[]; readonly stored: Record<string, Record<string, Json>> }

/** The declared defaults of a page, the way `settingsDefaults` and the native `settings_values` build them. */
export function settingsDefaults(page: SettingsPage): Record<string, Json> {
  return Object.fromEntries(page.fields.map(field => [field.id, field.kind === 'select' ? (field.multiple ? [] : '') : (field.value ?? (field.kind === 'switch' ? false : ''))]));
}

/** `panda.settings.get({ page })` for the package `owner`: its own page only; anything else is `NotFound`. */
export function settingsGet(packages: readonly SettingsPackage[], owner: string, params: unknown): { readonly schemaVersion: 1; readonly revision: number; readonly values: Record<string, Json> } | Failure {
  if (typeof params !== 'object' || params === null || Array.isArray(params) || Object.keys(params).length !== 1) return { code: 'InvalidArguments' };
  const page = (params as { page?: unknown }).page;
  if (typeof page !== 'string' || page.length === 0 || page.length > 256) return { code: 'InvalidArguments' };
  const mine = packages.find(item => item.id === owner && item.enabled);
  const definition = mine?.pages.find(item => item.id === page);
  if (!mine || !definition) return { code: 'NotFound' };
  const values = mine.stored[page] ?? settingsDefaults(definition);
  return { schemaVersion: 1, revision: settingsRevision(values), values };
}

/** `text` cut at 64 KiB on a character boundary, and whether it was cut. */
export function cut(text: string): [string, boolean] {
  if (bytes(text) <= TEXT_BYTES) return [text, false];
  let out = '';
  let size = 0;
  for (const char of text) { const width = bytes(char); if (size + width > TEXT_BYTES) break; out += char; size += width; }
  return [out, true];
}

/** Tool kind derived from the stored name (the store keeps the provider's name only). */
export function toolKind(name: string): string {
  const lower = name.toLowerCase();
  if (lower.includes('__')) return 'mcp';
  if (['bash', 'shell', 'command', 'powershell', 'terminal', 'exec'].some(word => lower === word || lower.startsWith(`${word}_`))) return 'shell';
  if (['edit', 'write', 'patch', 'notebook'].some(word => lower.includes(word))) return 'edit';
  if (['read', 'view', 'open'].some(word => lower.includes(word))) return 'read';
  if (['grep', 'glob', 'search', 'find', 'list'].some(word => lower.includes(word))) return 'search';
  if (['web', 'fetch', 'browse', 'http'].some(word => lower.includes(word))) return 'web';
  return 'other';
}

export interface Task { readonly id: string; readonly projectId: string; readonly status: string; readonly title: string; readonly harness: string; readonly model: string; readonly mode: string; readonly stage: string }
export interface Message { readonly id: number; readonly taskId: string; readonly role: string; readonly content: string; readonly at: number; readonly attachments?: readonly { id: string; kind: string; name: string; bytes: number }[] }
export interface Change { readonly taskId: string; readonly afterMessage: number; readonly path: string; readonly patch: string }
export interface Store { readonly tasks: readonly Task[]; readonly messages: readonly Message[]; readonly changes: readonly Change[]; revision: number }
/** Does the package hold `permission` for `project` (`null` asks whether it holds it at all)? */
export type Gate = (owner: string, version: string, permission: string, project: string | null) => boolean;

const KEYS = ['resource', 'taskId', 'harness', 'limit', 'cursor', 'revision'];
const turnOf = (store: Store, taskId: string, upTo: number) => store.messages.filter(message => message.taskId === taskId && message.role === 'user' && message.id <= upTo).length;
const role = (stored: string) => (stored === 'user' || stored === 'assistant' || stored === 'system' ? stored : 'note');

/** `panda.context.query` for `tasks`, `transcript`, `tools` or `changes`, with the rules of the native module. */
export function query(gate: Gate, store: Store, owner: string, version: string, params: unknown): { readonly schemaVersion: 1; readonly state: 'Ready'; readonly revision: string; readonly items: readonly Json[]; readonly nextCursor: number | null } | Failure {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return { code: 'InvalidShape' };
  const input = params as Record<string, unknown>;
  if (Object.keys(input).some(key => !KEYS.includes(key))) return { code: 'InvalidShape' };
  const resource = input.resource;
  if (typeof resource !== 'string') return { code: 'InvalidShape' };
  if (!Object.hasOwn(RESOURCES, resource)) return { code: 'UnsupportedCapability' };
  const permission = RESOURCES[resource as ContentResource];
  const limit = input.limit === undefined ? 10 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_ITEMS) return { code: 'LimitExceeded' };
  const cursor = input.cursor === undefined || input.cursor === null ? 0 : input.cursor;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0 || cursor > 1_000_000) return { code: 'LimitExceeded' };
  const expected = input.revision === undefined || input.revision === null ? null : input.revision;
  if (expected !== null && (typeof expected !== 'string' || expected.length > 64)) return { code: 'LimitExceeded' };
  if (input.harness !== undefined && input.harness !== null) return { code: 'InvalidShape' };
  if (!gate(owner, version, permission, null)) return { code: 'PermissionDenied' };
  const current = String(store.revision);
  let rows: Json[];
  if (resource === 'tasks') {
    if (input.taskId !== undefined && input.taskId !== null) return { code: 'InvalidShape' };
    rows = store.tasks.filter(task => gate(owner, version, permission, task.projectId)).sort((a, b) => (a.id < b.id ? -1 : 1)).map(task => ({ id: task.id, projectId: task.projectId, status: task.status, title: cut(task.title)[0], harness: task.harness, model: task.model, mode: task.mode, stage: task.stage, startedBy: 'user' }));
  } else {
    const taskId = input.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 256) return { code: 'InvalidShape' };
    const task = store.tasks.find(item => item.id === taskId);
    if (!task) return { code: 'NotFound' };
    if (!gate(owner, version, permission, task.projectId)) return { code: 'PermissionDenied' };
    const messages = store.messages.filter(message => message.taskId === taskId);
    if (resource === 'transcript') {
      rows = messages.filter(message => message.role !== 'tool' && message.role !== 'changes').map(message => {
        const [text, truncated] = cut(message.content);
        return { id: String(message.id), turn: turnOf(store, taskId, message.id), role: role(message.role), text, at: message.at, ...(truncated ? { truncated: true } : {}), ...(message.attachments?.length ? { attachments: message.attachments } : {}) };
      });
    } else if (resource === 'tools') {
      rows = messages.filter(message => message.role === 'tool').map(message => {
        let stored: Record<string, unknown> = {};
        try { const parsed = JSON.parse(message.content); if (parsed && typeof parsed === 'object') stored = parsed; } catch { /* a row that is not JSON is shown as its text */ }
        const name = typeof stored.name === 'string' ? stored.name : 'unknown';
        const text = (value: unknown) => (value === undefined || value === null ? ['', false] as [string, boolean] : cut(typeof value === 'string' ? value : JSON.stringify(value)));
        const [input, cutInput] = text(stored.input);
        const [output, cutOutput] = Object.keys(stored).length ? text(stored.output) : cut(message.content);
        return { callId: typeof stored.id === 'string' ? stored.id : String(message.id), turn: turnOf(store, taskId, message.id), tool: { kind: toolKind(name), name }, status: typeof stored.status === 'string' ? stored.status : 'unknown', input, output, inputComplete: false, outputComplete: false, ...(Array.isArray(stored.writePaths) ? { writePaths: stored.writePaths.filter(path => typeof path === 'string').slice(0, 256) } : {}), ...(cutInput || cutOutput ? { truncated: true } : {}) } as Json;
      });
    } else {
      rows = store.changes.filter(change => change.taskId === taskId).sort((a, b) => a.afterMessage - b.afterMessage || (a.path < b.path ? -1 : 1)).map(change => {
        const [patch, truncated] = cut(change.patch);
        return { turn: turnOf(store, taskId, change.afterMessage), path: change.path, patch, ...(truncated ? { truncated: true } : {}) };
      });
    }
  }
  if (expected !== null && expected !== current) return { code: 'StaleContext' };
  const items = rows.slice(cursor, cursor + limit);
  let more = cursor + limit < rows.length;
  while (items.length > 1 && bytes(JSON.stringify(items)) > PAGE_BYTES) { items.pop(); more = true; }
  return { schemaVersion: 1, state: 'Ready', revision: current, items, nextCursor: more ? cursor + items.length : null };
}
