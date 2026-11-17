// Webview and preview twin of src-tauri/src/extensions/runtime_hook_registration.rs (runtime phase R5, slice R0503):
// the event-dependent rules of `contributes.hooks` that contracts.ts applies after the schema (the same checks in the
// same order as the native `check`, so both validators answer the same first refusal), the normalization of tool
// calls, the `match` filter, and a registry that turns run reports into the normalized payloads an attached hook
// receives. Every delivery is observe only: nothing waits for it and nothing reads what a handler returns.
// Everything here is for predictability and fault isolation (ADR-0005), never for trust.
import { preview, type Json } from './runtime-hook-payload.ts';
import { EVENTS as PENDING_EVENTS } from './runtime-pending-requests.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const OBSERVE = 'harness.hooks.observe';
export const EDITORS = 'documents.editors';
export const EVENTS = [
  'turn.start', 'prompt.submit', 'tool.before', 'tool.after', 'turn.finish', 'turn.fail', 'task.idle', 'compaction',
  'approval.pending', 'approval.resolved', 'question.pending', 'question.resolved', 'save.before',
] as const;
export type HookEvent = typeof EVENTS[number];
/** What this slice delivers; `approval.*`, `question.*` (R0507) and `save.before` (documents) register already. */
export const DELIVERED: readonly HookEvent[] = ['turn.start', 'prompt.submit', 'tool.before', 'tool.after', 'turn.finish', 'turn.fail', 'task.idle', 'compaction'];
export const TOOL_KINDS = ['shell', 'read', 'write', 'edit', 'search', 'fetch', 'other'] as const;
export const RUN_KINDS = ['task', 'worker', 'bot', 'schedule', 'remote'] as const;
export const DEFAULT_BUDGET_MS = 2_000;
export const OUTPUT_BYTES = 8_192;

export function budgetRange(event: string): [number, number] | null {
  if (event === 'tool.before' || event === 'tool.after') return [100, 30_000];
  if (event === 'prompt.submit' || event === 'save.before') return [100, 10_000];
  if (event === 'compaction') return [100, 120_000];
  return null;
}
export function failurePolicies(event: string): readonly string[] {
  return event === 'tool.before' ? ['continue', 'ask', 'deny'] : event === 'prompt.submit' ? ['continue', 'deny'] : ['continue'];
}
const toolEvent = (event: string) => event === 'tool.before' || event === 'tool.after';
const extensionEvent = (event: string) => toolEvent(event) || event === 'save.before';
export const permissionOf = (event: string) => event === 'save.before' ? EDITORS : OBSERVE;

// ---- Declarations --------------------------------------------------------------------------------------------------

export interface Match { toolKinds?: Set<string>; harnesses?: Set<string>; runs?: Set<string>; extensions?: Set<string> }
export interface Declaration { id: string; event: string; onFailure: string; budgetMs: number; match: Match }
export interface Refusal { code: string; at: 'contributes/hooks' | 'permissions'; ids: string[] }

const strings = (value: Json | undefined): string[] | undefined => Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : undefined;
const distinct = (value: Json | undefined) => !Array.isArray(value) || new Set(value.map(item => JSON.stringify(item))).size === value.length;

/** The event-dependent rules after the schema; answers the declarations, or the first refusal. */
export function checkHookDeclarations(manifest: Json): { ok: true; declarations: Declaration[] } | { ok: false; refusal: Refusal } {
  const manifestObject = object(manifest) ? manifest : {};
  const contributes = object(manifestObject.contributes) ? manifestObject.contributes : {};
  const hooks = Array.isArray(contributes.hooks) ? contributes.hooks : [];
  if (!hooks.length) return { ok: true, declarations: [] };
  const pkg = typeof manifestObject.id === 'string' ? manifestObject.id : '';
  const refuse = (code: string, at: Refusal['at'], id: string) => ({ ok: false as const, refusal: { code, at, ids: [id] } });
  const runtime = object(manifestObject.runtime) ? manifestObject.runtime : {};
  if (runtime.service === undefined || runtime.service === null) return refuse('UnsupportedRuntime', 'contributes/hooks', pkg);
  const permissions = new Set(strings(manifestObject.permissions) ?? []);
  const ids = new Set<string>(); const events = new Set<string>(); const declarations: Declaration[] = [];
  for (const raw of hooks) {
    const hook = object(raw) ? raw : {};
    const id = typeof hook.id === 'string' ? hook.id : '';
    const event = typeof hook.event === 'string' ? hook.event : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', 'contributes/hooks', id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', 'contributes/hooks', id);
    if (ids.has(id)) return refuse('DuplicateId', 'contributes/hooks', id);
    ids.add(id);
    if (!(EVENTS as readonly string[]).includes(event)) return refuse('InvalidShape', 'contributes/hooks', id);
    if (events.has(event)) return refuse('DuplicateId', 'contributes/hooks', event);
    events.add(event);
    const onFailure = typeof hook.onFailure === 'string' ? hook.onFailure : 'continue';
    if (!failurePolicies(event).includes(onFailure)) return refuse('InvalidShape', 'contributes/hooks', id);
    let budgetMs = DEFAULT_BUDGET_MS;
    if (hook.budgetMs !== undefined) {
      const range = budgetRange(event);
      if (typeof hook.budgetMs !== 'number' || !Number.isInteger(hook.budgetMs) || hook.budgetMs < 0 || !range) return refuse('InvalidShape', 'contributes/hooks', id);
      if (hook.budgetMs < range[0] || hook.budgetMs > range[1]) return refuse('InvalidShape', 'contributes/hooks', id);
      budgetMs = hook.budgetMs;
    }
    const filter = object(hook.match) ? hook.match : {};
    if (filter.toolKinds !== undefined && filter.toolKinds !== null && !toolEvent(event)) return refuse('InvalidShape', 'contributes/hooks', id);
    if (filter.extensions !== undefined && filter.extensions !== null && !extensionEvent(event)) return refuse('InvalidShape', 'contributes/hooks', id);
    if (['toolKinds', 'harnesses', 'runs', 'extensions'].some(key => !distinct(filter[key]))) return refuse('DuplicateId', 'contributes/hooks', id);
    const set = (key: string) => { const values = strings(filter[key]); return values ? new Set(values) : undefined; };
    const extensions = strings(filter.extensions);
    const match: Match = { toolKinds: set('toolKinds'), harnesses: set('harnesses'), runs: set('runs'), extensions: extensions ? new Set(extensions.map(extension => extension.toLowerCase())) : undefined };
    if ([...(match.toolKinds ?? [])].some(kind => !(TOOL_KINDS as readonly string[]).includes(kind)) || [...(match.runs ?? [])].some(run => !(RUN_KINDS as readonly string[]).includes(run))) return refuse('InvalidShape', 'contributes/hooks', id);
    if (!permissions.has(permissionOf(event))) return refuse('PermissionDenied', 'permissions', pkg);
    declarations.push({ id, event, onFailure, budgetMs, match });
  }
  return { ok: true, declarations };
}

export function declarationJson(declaration: Declaration): Obj {
  const match: Obj = {};
  for (const key of ['toolKinds', 'harnesses', 'runs', 'extensions'] as const) { const values = declaration.match[key]; if (values) match[key] = [...values].sort(); }
  return { id: declaration.id, event: declaration.event, onFailure: declaration.onFailure, budgetMs: declaration.budgetMs, match };
}

// ---- Normalization ---------------------------------------------------------------------------------------------------

const KIND_NAMES: Record<string, string[]> = {
  shell: ['bash', 'command', 'shell', 'exec', 'exec_command', 'execute', 'run_terminal_cmd', 'terminal', 'powershell', 'local_shell', 'run_shell_command'],
  read: ['read', 'read_file', 'readfile', 'view', 'cat', 'notebookread', 'open_file'],
  write: ['write', 'write_file', 'writefile', 'create', 'create_file'],
  edit: ['edit', 'multiedit', 'str_replace', 'str_replace_editor', 'str_replace_based_edit_tool', 'apply_patch', 'patch', 'notebookedit', 'replace', 'delete', 'move'],
  search: ['grep', 'glob', 'search', 'find', 'ls', 'list', 'list_dir', 'codebase_search', 'file_search', 'grep_search'],
  fetch: ['webfetch', 'fetch', 'websearch', 'web_search', 'web_fetch', 'http'],
};
export function toolKind(name: string): string {
  const lower = name.toLowerCase();
  let base = lower.split(/[.:]/).pop() ?? lower;
  if (base.startsWith('mcp__')) base = base.slice(5).split('__').pop() ?? base;
  for (const [kind, names] of Object.entries(KIND_NAMES)) if (names.includes(base)) return kind;
  return 'other';
}
export function kindOfInput(input: Json): string {
  const fields = object(input) ? input : {};
  if (typeof fields.command === 'string' || Array.isArray(fields.command)) return 'shell';
  if ('old_string' in fields || 'patch' in fields) return 'edit';
  if (('file_path' in fields || 'path' in fields) && 'content' in fields) return 'write';
  if (typeof fields.url === 'string') return 'fetch';
  if (typeof fields.pattern === 'string' || typeof fields.query === 'string') return 'search';
  return 'other';
}
export function inputPaths(input: Json): string[] {
  const fields = object(input) ? input : {};
  const paths = ['file_path', 'filePath', 'path', 'notebook_path'].map(key => fields[key]).filter((value): value is string => typeof value === 'string');
  if (Array.isArray(fields.paths)) paths.push(...fields.paths.filter((value): value is string => typeof value === 'string'));
  return paths.filter(path => path.length > 0 && new TextEncoder().encode(path).length <= 4_096).slice(0, 64);
}
export function extensionOf(path: string): string | null {
  const name = path.split(/[\\/]/).pop() ?? '';
  const dot = name.lastIndexOf('.');
  return dot > 0 && dot + 1 < name.length ? name.slice(dot).toLowerCase() : null;
}
export function shell(name: string, input: Json): Obj | null {
  const fields = object(input) ? input : {};
  const command = typeof fields.command === 'string' ? fields.command
    : Array.isArray(fields.command) ? fields.command.filter((part): part is string => typeof part === 'string').join(' ')
    : typeof fields.cmd === 'string' ? fields.cmd : null;
  if (command === null) return null;
  const lower = name.toLowerCase();
  const dialect = lower.includes('powershell') ? 'powershell' : lower === 'bash' || lower.endsWith('bash') ? 'posix' : lower === 'cmd' ? 'cmd' : 'unknown';
  return { dialect, command };
}

export interface RunFacts {
  taskId: string; projectId: string; projectRoot: string; cwd: string; harness: string; model: string | null; mode: string;
  run: Obj; index: number; text: string; attachments: Obj[]; startedBy: Json; transcriptCursor: number;
}
export interface Occurrence { event: HookEvent; project: string; harness: string; run: string; toolKind: string | null; paths: string[]; payload: Obj }

export function matches(filter: Match, occurrence: Occurrence): boolean {
  return (!filter.harnesses || filter.harnesses.has('*') || filter.harnesses.has(occurrence.harness))
    && (!filter.runs || filter.runs.has(occurrence.run))
    && (!filter.toolKinds || (occurrence.toolKind !== null && filter.toolKinds.has(occurrence.toolKind)))
    && (!filter.extensions || occurrence.paths.some(path => { const extension = extensionOf(path); return extension !== null && filter.extensions!.has(extension); }));
}

function turnPayload(facts: RunFacts, sinceCompaction: number): Obj {
  const turn: Obj = {
    schemaVersion: 1, taskId: facts.taskId, projectId: facts.projectId, projectRoot: facts.projectRoot, harness: facts.harness, model: facts.model,
    mode: facts.mode, run: facts.run, index: facts.index, text: preview(facts.text),
  };
  if (facts.attachments.length) turn.attachments = facts.attachments;
  turn.sinceCompaction = sinceCompaction;
  turn.startedBy = facts.startedBy;
  return turn;
}

// ---- Registry ----------------------------------------------------------------------------------------------------------

export type Gate = (owner: string, version: string, permission: string, project: string | null) => boolean;
export type Deliver = (owner: string, frame: Obj) => string | null;
/** Builds the `HookCall` of a recorded call (`HookPayloads.hookCall`); a string is a failure code. */
export type CallPayload = (base: Obj, callId: string) => Obj | string;
export interface Published { delivered: number; filtered: number; failed: number }
const none = (): Published => ({ delivered: 0, filtered: 0, failed: 0 });
const add = (a: Published, b: Published): Published => ({ delivered: a.delivered + b.delivered, filtered: a.filtered + b.filtered, failed: a.failed + b.failed });

interface Attached { version: string; declaration: Declaration; handlers: number }
interface Run { facts: RunFacts; sinceCompaction: number; started: number; before: Set<string>; after: Set<string>; toolCalls: number }

export class HookRegistry {
  private attached = new Map<string, Attached>();
  private runs = new Map<string, Run>();
  private compacted = new Map<string, number>();
  private gate: Gate | null = null;
  private deliver: Deliver | null = null;
  readonly counters = { delivered: 0, filtered: 0, failed: 0 };
  private readonly now: () => number;
  constructor(now: () => number = () => Date.now()) { this.now = now; }
  private key = (owner: string, event: string) => JSON.stringify([owner, event]);

  setGate(gate: Gate): void { this.gate = gate; }
  setDeliver(deliver: Deliver): void { this.deliver = deliver; }
  /** R0507: what is still waiting in a task (`task.idle.pending`); `PendingBook.counts` in the app's twin. */
  private pendingCounts: (task: string) => [number, number] = () => [0, 0];
  setPendingCounts(counts: (task: string) => [number, number]): void { this.pendingCounts = counts; }
  active(): boolean { return this.attached.size > 0; }
  private refresh(): void { if (!this.active()) this.runs.clear(); }

  /** `panda.hooks.on(event)`: InvalidShape, UnknownReference (not declared) or PermissionDenied, else the declaration. */
  register(owner: string, version: string, declarations: readonly Declaration[], event: string): Obj | string {
    if (!(EVENTS as readonly string[]).includes(event)) return 'InvalidShape';
    const declaration = declarations.find(item => item.event === event);
    if (!declaration) return 'UnknownReference';
    if (!this.gate?.(owner, version, permissionOf(event), null)) return 'PermissionDenied';
    const key = this.key(owner, event);
    const entry = this.attached.get(key) ?? { version, declaration, handlers: 0 };
    entry.handlers += 1; entry.version = version; entry.declaration = declaration;
    this.attached.set(key, entry);
    this.refresh();
    // `approval.*` and `question.*` are delivered by R0507 (runtime-pending-requests.ts).
    return { ...declarationJson(declaration), observeOnly: true, delivered: DELIVERED.includes(event as HookEvent) || (PENDING_EVENTS as readonly string[]).includes(event) };
  }
  unregister(owner: string, event: string): string | null {
    if (!(EVENTS as readonly string[]).includes(event)) return 'InvalidShape';
    const key = this.key(owner, event);
    const entry = this.attached.get(key);
    if (entry) { entry.handlers = Math.max(0, entry.handlers - 1); if (!entry.handlers) this.attached.delete(key); }
    this.refresh();
    return null;
  }
  removeOwner(owner: string): number {
    let removed = 0;
    for (const key of [...this.attached.keys()]) if (JSON.parse(key)[0] === owner) { this.attached.delete(key); removed += 1; }
    this.refresh();
    return removed;
  }
  listeners(owner: string): string[] { return [...this.attached.keys()].map(key => JSON.parse(key) as [string, string]).filter(([attached]) => attached === owner).map(([, event]) => event); }
  run(task: string): RunFacts | null { return this.runs.get(task)?.facts ?? null; }

  publish(occurrence: Occurrence): Published {
    const out = none();
    for (const [key, entry] of [...this.attached.entries()]) {
      const [owner, event] = JSON.parse(key) as [string, string];
      if (event !== occurrence.event) continue;
      if (!matches(entry.declaration.match, occurrence) || !this.gate?.(owner, entry.version, permissionOf(occurrence.event), occurrence.project)) { out.filtered += 1; continue; }
      const frame: Obj = { schemaVersion: 1, hookId: entry.declaration.id, event: occurrence.event, observeOnly: true, payload: occurrence.payload };
      const failure = this.deliver ? this.deliver(owner, frame) : 'HostUnavailable';
      if (failure) out.failed += 1; else out.delivered += 1;
    }
    this.counters.delivered += out.delivered; this.counters.filtered += out.filtered; this.counters.failed += out.failed;
    return out;
  }
  private occurrence(facts: RunFacts, event: HookEvent, payload: Obj): Occurrence {
    return { event, project: facts.projectId, harness: facts.harness, run: typeof facts.run.kind === 'string' ? facts.run.kind : 'task', toolKind: null, paths: [], payload };
  }

  turnStarted(facts: RunFacts): Published {
    if (!this.active()) return none();
    const at = this.compacted.get(facts.taskId);
    const since = at === undefined ? Math.max(0, facts.index - 1) : Math.max(0, facts.index - (at + 1));
    this.runs.set(facts.taskId, { facts, sinceCompaction: since, started: this.now(), before: new Set(), after: new Set(), toolCalls: 0 });
    const turn = turnPayload(facts, since);
    let out = none();
    if (facts.text) out = add(out, this.publish(this.occurrence(facts, 'prompt.submit', turn)));
    return add(out, this.publish(this.occurrence(facts, 'turn.start', turn)));
  }
  private callBase(facts: RunFacts, name: string, request: string | null, source: string, coverage: string): Obj {
    const base: Obj = {
      taskId: facts.taskId, projectId: facts.projectId, projectRoot: facts.projectRoot, cwd: facts.cwd, harness: facts.harness, model: facts.model,
      mode: facts.mode, turn: facts.index, run: facts.run, tool: { kind: toolKind(name), name }, source, coverage, can: [],
    };
    if (request !== null) base.requestId = request;
    return base;
  }
  private complete(call: Obj, name: string): { kind: string; paths: string[] } {
    const input = call.input ?? null;
    let kind = toolKind(name);
    if (kind === 'other') kind = kindOfInput(input);
    call.tool = { ...(call.tool as Obj), kind };
    if (kind === 'shell') { const command = shell(name, input); if (command) call.shell = command; }
    const paths = inputPaths(input);
    if (kind === 'write' || kind === 'edit') call.writePaths = paths;
    return { kind, paths };
  }
  toolBefore(task: string, harnessCall: string, callId: string, name: string, request: string | null, payload: CallPayload): Published {
    if (!this.active()) return none();
    const run = this.runs.get(task);
    if (!run || run.before.has(harnessCall)) return none();
    run.before.add(harnessCall);
    const call = payload(this.callBase(run.facts, name, request, 'permissionRequest', 'askedCalls'), callId);
    if (typeof call === 'string') return none();
    const { kind, paths } = this.complete(call, name);
    return this.publish({ ...this.occurrence(run.facts, 'tool.before', call), toolKind: kind, paths });
  }
  toolAfter(task: string, harnessCall: string, callId: string, name: string, status: string, output: string, payload: CallPayload): Published {
    if (!this.active()) return none();
    const run = this.runs.get(task);
    if (!run || run.after.has(harnessCall)) return none();
    run.after.add(harnessCall); run.toolCalls += 1;
    const seen = run.before.has(harnessCall);
    const call = payload(this.callBase(run.facts, name, null, seen ? 'permissionRequest' : 'activity', seen ? 'askedCalls' : 'afterOnly'), callId);
    if (typeof call === 'string') return none();
    const { kind, paths } = this.complete(call, name);
    const normalized = ['completed', 'success', 'succeeded', 'done'].includes(status) ? 'completed' : ['denied', 'rejected'].includes(status) ? 'denied' : ['cancelled', 'canceled', 'interrupted'].includes(status) ? 'cancelled' : 'failed';
    const bytes = new TextEncoder().encode(output);
    let cut = Math.min(bytes.length, OUTPUT_BYTES);
    while (cut > 0 && cut < bytes.length && (bytes[cut] & 0xc0) === 0x80) cut -= 1;
    call.status = normalized;
    call.output = new TextDecoder().decode(bytes.slice(0, cut));
    call.outputComplete = cut === bytes.length && bytes.length < OUTPUT_BYTES;
    call.durationMs = Math.max(0, this.now() - run.started);
    call.decidedBy = null;
    return this.publish({ ...this.occurrence(run.facts, 'tool.after', call), toolKind: kind, paths });
  }
  compaction(task: string): Published {
    if (!this.active()) return none();
    const run = this.runs.get(task);
    if (!run) return none();
    run.sinceCompaction = 0;
    this.compacted.set(task, run.facts.index);
    const facts = run.facts;
    return this.publish(this.occurrence(facts, 'compaction', { taskId: facts.taskId, projectId: facts.projectId, harness: facts.harness, phase: 'after', can: [] }));
  }
  turnEnded(task: string, successful: boolean, error: string | null): Published {
    const run = this.runs.get(task);
    this.runs.delete(task);
    if (!this.active() || !run) return none();
    const turn = turnPayload(run.facts, run.sinceCompaction);
    let out = none();
    if (successful) {
      Object.assign(turn, { transcript: { cursor: run.facts.transcriptCursor }, durationMs: Math.max(0, this.now() - run.started), toolCalls: run.toolCalls });
      out = add(out, this.publish(this.occurrence(run.facts, 'turn.finish', turn)));
    } else {
      turn.error = { message: [...(error ?? 'The turn ended with an error.')].slice(0, 4_000).join('') };
      out = add(out, this.publish(this.occurrence(run.facts, 'turn.fail', turn)));
    }
    const [approvals, questions] = this.pendingCounts(run.facts.taskId);
    const idle: Obj = { taskId: run.facts.taskId, projectId: run.facts.projectId, harness: run.facts.harness, turn: run.facts.index, pending: { approvals, questions } };
    return add(out, this.publish(this.occurrence(run.facts, 'task.idle', idle)));
  }
  forgetTask(task: string): void { this.runs.delete(task); this.compacted.delete(task); }
}
