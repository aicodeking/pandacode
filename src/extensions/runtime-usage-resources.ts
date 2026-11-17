// Usage, limits, accounts and metrics for background services (runtime phase R2, slice R0204).
//
// The native rules live in src-tauri/src/extensions/runtime_usage_resources.rs; this file mirrors them with no I/O
// for the browser preview and for the deterministic checks of tests/extensions-runtime-usage-resources.spec.ts.
// Limits are for stability and predictability, never for trust: a page is at most 50 items and 256 KiB, a refresh
// of one harness is admitted once per 60 s. Nothing here carries a credential value (ADR-0006) and nothing is
// invented: a figure that is not measured is absent, never zero.

export const PAGE_ITEMS = 50;
export const PAGE_BYTES = 256 * 1024;
export const REFRESH_INTERVAL_MS = 60_000;
export const RESOURCES = { usage: 'tasks.usage.read', limits: 'harnesses.limits.read', accounts: 'harnesses.accounts.read', metrics: 'metrics.read' } as const;
export type UsageResource = keyof typeof RESOURCES;
export type UsageCode = 'InvalidShape' | 'InvalidArguments' | 'UnsupportedCapability' | 'LimitExceeded' | 'PermissionDenied' | 'NotFound' | 'StaleContext';
export type Failure = { readonly code: UsageCode };
export type Json = null | boolean | number | string | readonly Json[] | { readonly [key: string]: Json };

/** The built-in harness ids (`providers::PROVIDERS`). */
export const HARNESSES = ['codex', 'claude', 'kimi', 'opencode', 'glm', 'antigravity', 'grok', 'mimo', 'alibaba', 'pi', 'deepseek', 'commandcode', 'cline', 'kilo', 'omp', 'github-copilot', 'muse', 'devin', 'zcode', 'hermes', 'cursor'] as const;

export interface Reading { readonly status: string; readonly stale: boolean; readonly checkedAt: number; readonly windows: readonly { label: string; usedPercent: number; resetsAt?: string; detail?: string }[]; readonly email?: string; readonly plan?: string; readonly message?: string; readonly dashboardUrl?: string }
export interface Connection { readonly id: string; readonly harness: string; readonly name: string; readonly revision: number; readonly env?: Record<string, string>; readonly secretEnv?: readonly string[]; readonly configDir?: string }
export interface Report { readonly usedTokens: number; readonly contextWindow?: number }
/** The ledger of one task: reports in the order they arrived, each with the number of user messages at that time. */
export interface LedgerRow { readonly taskId: string; readonly turn: number; readonly usedTokens: number; readonly contextWindow?: number; readonly reports: number; readonly at: number }
export interface Service { readonly id: string; readonly state: string; readonly residentBytes?: number }
export interface World {
  readonly tasks: readonly { readonly id: string; readonly projectId: string }[];
  readonly ledger: LedgerRow[];
  readonly readings: Record<string, Reading>;
  readonly connectionReadings: Record<string, Reading>;
  readonly connections: readonly Connection[];
  readonly app: { readonly coreRssBytes?: number; readonly activeAgents?: number; readonly activeTerminals?: number; readonly databaseBytes?: number };
  readonly services: readonly Service[];
}
/** The grants file: `project` is `null` for a global permission. */
export type Gate = (owner: string, version: string, permission: string, project: string | null) => boolean;

/** One `usage` report of a run: the row of the turn keeps the LAST report and counts them. */
export function record(ledger: LedgerRow[], taskId: string, userMessages: number, report: Report, at: number): void {
  const row = ledger.find(item => item.taskId === taskId && item.turn === userMessages);
  const next = { taskId, turn: userMessages, usedTokens: report.usedTokens, ...(report.contextWindow === undefined ? {} : { contextWindow: report.contextWindow }), reports: (row?.reports ?? 0) + 1, at };
  if (row) ledger[ledger.indexOf(row)] = next; else ledger.push(next);
}

/** Admits one refresh per harness per 60 s. At exactly 60 s after the admitted one the next is admitted. */
export class Throttle {
  private last = new Map<string, number>();
  admit(harness: string, now: number): boolean {
    const at = this.last.get(harness);
    if (at !== undefined && now - at < REFRESH_INTERVAL_MS) return false;
    this.last.set(harness, now);
    return true;
  }
  /** The admitted harnesses, or `LimitExceeded` when there were targets and none was admitted. */
  plan(targets: readonly string[], now: number): string[] | Failure {
    const admitted = targets.filter(harness => this.admit(harness, now));
    return admitted.length === 0 && targets.length > 0 ? { code: 'LimitExceeded' } : admitted;
  }
}

export function limitRow(harness: string, account: string, reading: Reading): Json {
  const seen = new Set<string>();
  const windows = reading.windows.slice(0, 32).map((window, index) => {
    let id = window.label.toLowerCase().replace(/[^a-z0-9]/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
    if (id === '' || seen.has(id)) id = `${id}-${index}`;
    seen.add(id);
    return { id, label: window.label.slice(0, 120), usedPercent: window.usedPercent, ...(window.resetsAt === undefined ? {} : { resetsAt: window.resetsAt }) };
  });
  return { harness, account, status: reading.status, stale: reading.stale, windows, readAt: reading.checkedAt };
}

const signedIn = (status: string): boolean | null => (status === 'ready' ? true : status === 'signedOut' ? false : null);

/** Only these projected fields: nothing else of a connection (environment, secrets, folders) reaches a package. */
export function accountRow(harness: string, id: string, active: boolean, name: string | undefined, reading: Reading | undefined): Json {
  const label = name ?? reading?.email;
  return {
    harness, id, active, signedIn: reading ? signedIn(reading.status) : null, status: reading?.status ?? 'unchecked',
    ...(label === undefined ? {} : { label: label.slice(0, 120) }), ...(reading?.plan === undefined ? {} : { plan: reading.plan.slice(0, 64) }),
  };
}

/** The measured totals and services; per-task figures are absent and `unmeasured` says so. */
export function metricsItem(app: World['app'], services: readonly Service[]): Json {
  const unmeasured: string[] = ['tasks'];
  const measured: Record<string, number> = {};
  for (const name of ['coreRssBytes', 'activeAgents', 'activeTerminals', 'databaseBytes'] as const) {
    const value = app[name];
    if (value === undefined) unmeasured.push(`app.${name}`); else measured[name] = value;
  }
  const rows = services.filter(service => ['running', 'starting', 'stopping'].includes(service.state) || service.residentBytes !== undefined).map(service => {
    if (service.residentBytes === undefined) unmeasured.push(`services.${service.id}`);
    return { package: service.id, ...(service.residentBytes === undefined ? {} : { rssBytes: service.residentBytes }) };
  });
  return { app: measured, services: rows, unmeasured };
}

const encoder = new TextEncoder();
const bytes = (text: string) => encoder.encode(text).length;
const canonical = (value: Json): string => (Array.isArray(value) ? `[${value.map(item => canonical(item)).join(',')}]`
  : value !== null && typeof value === 'object' ? `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as { [key: string]: Json })[key])}`).join(',')}}`
  : JSON.stringify(value));
/** FNV-1a 64 of the canonical JSON kept to 53 bits, in hex: the revision of a listed resource. */
export function listRevision(items: readonly Json[]): string {
  let hash = 0xcbf29ce484222325n;
  for (const byte of encoder.encode(canonical(items as Json))) { hash ^= BigInt(byte); hash = BigInt.asUintN(64, hash * 0x100000001b3n); }
  return (hash & ((1n << 53n) - 1n)).toString(16);
}

function listing(items: readonly Json[], limit: number, cursor: number, expected: string | null): Json | Failure {
  const revision = listRevision(items);
  if (expected !== null && expected !== revision) return { code: 'StaleContext' };
  const page = items.slice(cursor, cursor + limit);
  let more = cursor + page.length < items.length;
  while (page.length > 1 && bytes(JSON.stringify(page)) > PAGE_BYTES) { page.pop(); more = true; }
  return { schemaVersion: 1, state: 'Ready', revision, items: page, nextCursor: more ? cursor + page.length : null };
}

const harnessIds = (only: string | null) => HARNESSES.filter(id => only === null || id === only);

export function limitsOf(world: World, harness: string | null): Json[] {
  const rows: Json[] = [];
  for (const id of harnessIds(harness)) {
    if (world.readings[id]) rows.push(limitRow(id, 'default', world.readings[id]));
    for (const connection of world.connections.filter(item => item.harness === id)) {
      const reading = world.connectionReadings[`${connection.id}#${connection.revision}`];
      if (reading) rows.push(limitRow(id, connection.id, reading));
    }
  }
  return rows;
}
export function accountsOf(world: World, harness: string | null): Json[] {
  const rows: Json[] = [];
  for (const id of harnessIds(harness)) {
    rows.push(accountRow(id, 'default', true, undefined, world.readings[id]));
    for (const connection of world.connections.filter(item => item.harness === id)) rows.push(accountRow(id, connection.id, false, connection.name, world.connectionReadings[`${connection.id}#${connection.revision}`]));
  }
  return rows;
}

/** One `panda.context.query` for `usage`, `limits`, `accounts` or `metrics`. */
export function query(gate: Gate, world: World, owner: string, version: string, params: unknown): Json | Failure {
  if (typeof params !== 'object' || params === null || Array.isArray(params)) return { code: 'InvalidShape' };
  const input = params as Record<string, unknown>;
  if (Object.keys(input).some(key => !['resource', 'taskId', 'harness', 'limit', 'cursor', 'revision'].includes(key))) return { code: 'InvalidShape' };
  const resource = input.resource;
  if (typeof resource !== 'string') return { code: 'InvalidShape' };
  if (!(resource in RESOURCES)) return { code: 'UnsupportedCapability' };
  const permission = RESOURCES[resource as UsageResource];
  const limit = input.limit === undefined ? 10 : input.limit;
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > PAGE_ITEMS) return { code: 'LimitExceeded' };
  const cursor = input.cursor === undefined || input.cursor === null ? 0 : input.cursor;
  if (typeof cursor !== 'number' || !Number.isInteger(cursor) || cursor < 0 || cursor > 1_000_000) return { code: 'LimitExceeded' };
  const expected = input.revision === undefined || input.revision === null ? null : input.revision;
  if (expected !== null && (typeof expected !== 'string' || expected.length > 64)) return { code: 'LimitExceeded' };
  const present = (key: string) => input[key] !== undefined && input[key] !== null;
  if (present('harness') && (typeof input.harness !== 'string' || input.harness === '' || input.harness.length > 64)) return { code: 'InvalidShape' };
  if ((resource === 'usage' && present('harness')) || ((resource === 'limits' || resource === 'accounts') && present('taskId')) || (resource === 'metrics' && (present('taskId') || present('harness')))) return { code: 'InvalidShape' };
  // Holding the permission at all comes first, so a package without it learns nothing about the data.
  if (!gate(owner, version, permission, null)) return { code: 'PermissionDenied' };
  if (resource === 'usage') {
    const taskId = input.taskId;
    if (typeof taskId !== 'string' || taskId.length === 0 || taskId.length > 256) return { code: 'InvalidShape' };
    const task = world.tasks.find(item => item.id === taskId);
    if (!task) return { code: 'NotFound' };
    if (!gate(owner, version, permission, task.projectId)) return { code: 'PermissionDenied' };
    const rows = world.ledger.filter(row => row.taskId === taskId).sort((a, b) => a.turn - b.turn);
    const revision = `u${rows.length}.${rows.reduce((sum, row) => sum + row.reports, 0)}`;
    if (expected !== null && expected !== revision) return { code: 'StaleContext' };
    const items = rows.slice(cursor, cursor + limit);
    const more = cursor + items.length < rows.length;
    return { schemaVersion: 1, state: 'Ready', revision, items: items as unknown as Json[], nextCursor: more ? cursor + items.length : null };
  }
  const harness = present('harness') ? (input.harness as string) : null;
  if (harness !== null && !(HARNESSES as readonly string[]).includes(harness)) return { code: 'NotFound' };
  if (resource === 'limits') return listing(limitsOf(world, harness), limit, cursor, expected as string | null);
  if (resource === 'accounts') return listing(accountsOf(world, harness), limit, cursor, expected as string | null);
  return listing([metricsItem(world.app, world.services)], limit, cursor, expected as string | null);
}

/** `panda.harnesses.refreshLimits`: the harnesses to read again, or a failure. `now` is a monotonic clock in ms. */
export function refreshLimits(gate: Gate, world: World, throttle: Throttle, owner: string, version: string, params: unknown, now: number): { readonly harnesses: string[] } | Failure {
  if (!gate(owner, version, 'harnesses.limits.read', null)) return { code: 'PermissionDenied' };
  if (params !== undefined && params !== null && (typeof params !== 'object' || Array.isArray(params))) return { code: 'InvalidArguments' };
  const input = (params ?? {}) as Record<string, unknown>;
  if (Object.keys(input).some(key => key !== 'harness')) return { code: 'InvalidArguments' };
  let targets: string[];
  if (input.harness === undefined || input.harness === null) targets = HARNESSES.filter(id => world.readings[id] !== undefined);
  else {
    if (typeof input.harness !== 'string' || input.harness === '' || input.harness.length > 64) return { code: 'InvalidArguments' };
    if (!(HARNESSES as readonly string[]).includes(input.harness)) return { code: 'NotFound' };
    targets = [input.harness];
  }
  const planned = throttle.plan(targets, now);
  return Array.isArray(planned) ? { harnesses: planned } : planned;
}
