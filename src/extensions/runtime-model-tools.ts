// Webview and preview twin of src-tauri/src/extensions/runtime_model_tools.rs (runtime phase R7, slice R0701):
// the rules of `contributes.modelTools` that contracts.ts applies after the schema (the same checks in the same order
// as the native `check`, so both validators answer the same first refusal), the argument and result checks, the
// inventory with its name collisions, and a registry that serves a call the way the host does: grant checked now,
// arguments validated, the service answers inside the declared timeout, the envelope becomes the result (64 KiB).
// Everything here is for predictability and fault isolation (ADR-0005), never for trust.
import type { Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const PERMISSION = 'tools.model';
export const RESERVED_PREFIX = 'pandacode_';
export const MAX_TOOLS = 16;
export const MAX_NAME = 48;
export const MAX_DESCRIPTION = 1_024;
export const MAX_SCHEMA_BYTES = 16 * 1024;
export const MAX_RESULT_BYTES = 64 * 1024;
export const MAX_INPUT_BYTES = 256 * 1024;
export const DEFAULT_TIMEOUT_MS = 30_000;
export const MIN_TIMEOUT_MS = 100;
export const MAX_TIMEOUT_MS = 600_000;
export const APPROVALS = ['mode', 'never'] as const;
const SCHEMA_DEPTH = 8;
const AT = 'contributes/modelTools' as const;
const encoder = new TextEncoder();
const bytes = (value: Json) => encoder.encode(JSON.stringify(value)).length;

// ---- Declarations ----------------------------------------------------------------------------------------------------

export interface Declaration { id: string; name: string; description: string; inputSchema: Obj; timeoutMs: number; approval: 'mode' | 'never' }
export interface Refusal { code: string; at: typeof AT | 'permissions'; ids: string[] }

/** `^[a-z][a-z0-9_]{0,47}$`. */
export const validName = (name: string) => name.length <= MAX_NAME && /^[a-z][a-z0-9_]*$/.test(name);

const SCHEMA_TYPES = ['object', 'string', 'number', 'integer', 'boolean', 'array', 'null'];
/** Whether the host cannot read `schema`: only the keywords it applies, `$ref` and other references refused. */
export function schemaUnreadable(schema: Json | undefined, depth = 0): boolean {
  if (!object(schema) || depth > SCHEMA_DEPTH) return true;
  for (const [key, value] of Object.entries(schema)) {
    let bad: boolean;
    switch (key) {
      case 'type':
        bad = typeof value === 'string' ? !SCHEMA_TYPES.includes(value)
          : Array.isArray(value) ? value.length === 0 || value.some(kind => typeof kind !== 'string' || !SCHEMA_TYPES.includes(kind)) : true;
        break;
      case 'properties': bad = !object(value) || Object.values(value).some(property => schemaUnreadable(property, depth + 1)); break;
      case 'required': {
        if (!Array.isArray(value)) { bad = true; break; }
        const names = new Set(value.filter((name): name is string => typeof name === 'string'));
        bad = names.size !== value.length || (object(schema.properties) && [...names].some(name => !(name in (schema.properties as Obj))));
        break;
      }
      case 'enum': bad = !Array.isArray(value) || value.length === 0; break;
      case 'items': bad = schemaUnreadable(value, depth + 1); break;
      case 'additionalProperties': bad = typeof value !== 'boolean' && schemaUnreadable(value, depth + 1); break;
      case 'minimum': case 'maximum': case 'minLength': case 'maxLength': case 'minItems': case 'maxItems': bad = typeof value !== 'number'; break;
      case 'description': case 'title': case 'default': case 'examples': bad = false; break;
      default: bad = true;
    }
    if (bad) return true;
  }
  return false;
}

const refuse = (code: string, at: Refusal['at'], id: string) => ({ ok: false as const, refusal: { code, at, ids: [id] } });

/** The rules after the schema; answers the declarations, or the first refusal. */
export function checkModelToolDeclarations(manifest: Json): { ok: true; declarations: Declaration[] } | { ok: false; refusal: Refusal } {
  const root = object(manifest) ? manifest : {};
  const contributes = object(root.contributes) ? root.contributes : {};
  const tools = Array.isArray(contributes.modelTools) ? contributes.modelTools : [];
  if (!tools.length) return { ok: true, declarations: [] };
  const pkg = typeof root.id === 'string' ? root.id : '';
  const runtime = object(root.runtime) ? root.runtime : {};
  if (runtime.service === undefined || runtime.service === null) return refuse('UnsupportedRuntime', AT, pkg);
  if (tools.length > MAX_TOOLS) return refuse('LimitExceeded', AT, pkg);
  const permissions = new Set(Array.isArray(root.permissions) ? root.permissions.filter((item): item is string => typeof item === 'string') : []);
  const ids = new Set<string>(); const names = new Set<string>(); const declarations: Declaration[] = [];
  for (const raw of tools) {
    const tool = object(raw) ? raw : {};
    const id = typeof tool.id === 'string' ? tool.id : '';
    const name = typeof tool.name === 'string' ? tool.name : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', AT, id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', AT, id);
    if (ids.has(id)) return refuse('DuplicateId', AT, id);
    ids.add(id);
    if (name.startsWith(RESERVED_PREFIX)) return refuse('ReservedId', AT, id);
    if (!validName(name)) return refuse('InvalidShape', AT, id);
    if (names.has(name)) return refuse('DuplicateId', AT, id);
    names.add(name);
    const description = tool.description;
    if (typeof description !== 'string' || !description.trim() || [...description].length > MAX_DESCRIPTION) return refuse('InvalidShape', AT, id);
    const schema = tool.inputSchema;
    if (!object(schema)) return refuse('InvalidShape', AT, id);
    if (bytes(schema) > MAX_SCHEMA_BYTES) return refuse('LimitExceeded', AT, id);
    if (schema.type !== 'object' || schemaUnreadable(schema)) return refuse('InvalidShape', AT, id);
    let timeoutMs = DEFAULT_TIMEOUT_MS;
    if (tool.timeoutMs !== undefined) {
      if (typeof tool.timeoutMs !== 'number' || !Number.isInteger(tool.timeoutMs) || tool.timeoutMs < MIN_TIMEOUT_MS || tool.timeoutMs > MAX_TIMEOUT_MS) return refuse('InvalidShape', AT, id);
      timeoutMs = tool.timeoutMs;
    }
    let approval: Declaration['approval'] = 'mode';
    if (tool.approval !== undefined) {
      if (typeof tool.approval !== 'string' || !(APPROVALS as readonly string[]).includes(tool.approval)) return refuse('InvalidShape', AT, id);
      approval = tool.approval as Declaration['approval'];
    }
    declarations.push({ id, name, description, inputSchema: schema, timeoutMs, approval });
  }
  if (!permissions.has(PERMISSION)) return refuse('PermissionDenied', 'permissions', pkg);
  return { ok: true, declarations };
}

// ---- Arguments and results -------------------------------------------------------------------------------------------

const kindMatches = (kind: string, value: Json | undefined): boolean => {
  switch (kind) {
    case 'object': return object(value);
    case 'string': return typeof value === 'string';
    case 'boolean': return typeof value === 'boolean';
    case 'array': return Array.isArray(value);
    case 'null': return value === null;
    case 'number': return typeof value === 'number';
    case 'integer': return typeof value === 'number' && Number.isInteger(value);
    default: return false;
  }
};

/** The first way `value` does not fit `schema`, as a model-readable line; `null` when it fits. */
export function inputProblem(schema: Json | undefined, value: Json | undefined, path = 'input'): string | null {
  if (!object(schema)) return null;
  if (schema.type !== undefined) {
    const kinds = typeof schema.type === 'string' ? [schema.type] : Array.isArray(schema.type) ? schema.type.filter((kind): kind is string => typeof kind === 'string') : [];
    if (!kinds.some(kind => kindMatches(kind, value))) return `${path} must be ${kinds.join(' or ')}`;
  }
  if (Array.isArray(schema.enum) && !schema.enum.some(option => JSON.stringify(option) === JSON.stringify(value))) return `${path} must be one of ${schema.enum.map(option => JSON.stringify(option)).join(', ')}`;
  if (typeof value === 'number') {
    if (typeof schema.minimum === 'number' && value < schema.minimum) return `${path} is below the minimum`;
    if (typeof schema.maximum === 'number' && value > schema.maximum) return `${path} is above the maximum`;
  }
  if (typeof value === 'string') {
    const length = [...value].length;
    if (typeof schema.minLength === 'number' && length < schema.minLength) return `${path} is too short`;
    if (typeof schema.maxLength === 'number' && length > schema.maxLength) return `${path} is too long`;
  }
  if (Array.isArray(value)) {
    if (typeof schema.minItems === 'number' && value.length < schema.minItems) return `${path} has too few items`;
    if (typeof schema.maxItems === 'number' && value.length > schema.maxItems) return `${path} has too many items`;
    if (schema.items !== undefined) for (const [index, entry] of value.entries()) { const problem = inputProblem(schema.items, entry, `${path}[${index}]`); if (problem) return problem; }
  }
  if (object(value)) {
    const properties = object(schema.properties) ? schema.properties : undefined;
    for (const name of Array.isArray(schema.required) ? schema.required : []) if (typeof name === 'string' && !(name in value)) return `${path}.${name} is required`;
    for (const [name, entry] of Object.entries(value)) {
      if (properties && name in properties) { const problem = inputProblem(properties[name], entry, `${path}.${name}`); if (problem) return problem; }
      else if (schema.additionalProperties === false) return `${path}.${name} is not accepted`;
      else if (object(schema.additionalProperties)) { const problem = inputProblem(schema.additionalProperties, entry, `${path}.${name}`); if (problem) return problem; }
    }
  }
  return null;
}

/** The `{ content, isError? }` envelope a handler returns: nothing else is accepted, and `content` stays in 64 KiB. */
export function envelope(answer: Json): { ok: true; content: Json; isError: boolean } | { ok: false; code: 'InvalidShape' | 'LimitExceeded' } {
  if (!object(answer)) return { ok: false, code: 'InvalidShape' };
  if (Object.keys(answer).some(key => key !== 'content' && key !== 'isError') || !('content' in answer)) return { ok: false, code: 'InvalidShape' };
  if (answer.isError !== undefined && typeof answer.isError !== 'boolean') return { ok: false, code: 'InvalidShape' };
  if (bytes(answer.content) > MAX_RESULT_BYTES) return { ok: false, code: 'LimitExceeded' };
  return { ok: true, content: answer.content, isError: answer.isError === true };
}

// ---- The inventory ---------------------------------------------------------------------------------------------------

export interface Entry { owner: string; version: string; packageName: string; declarations: Declaration[] }
export interface Listed { owner: string; version: string; packageName: string; declaration: Declaration }
export interface Conflict { owner: string; id: string; name: string; heldBy: string }

/** Splits the declared tools into those available and those that lost their name to an earlier package. */
export function resolve(entries: Entry[]): { available: Listed[]; conflicts: Conflict[] } {
  const held = new Map<string, string>(); const available: Listed[] = []; const conflicts: Conflict[] = [];
  for (const entry of entries) for (const declaration of entry.declarations) {
    const holder = held.get(declaration.name);
    if (holder !== undefined && holder !== entry.owner) conflicts.push({ owner: entry.owner, id: declaration.id, name: declaration.name, heldBy: holder });
    else { held.set(declaration.name, entry.owner); available.push({ owner: entry.owner, version: entry.version, packageName: entry.packageName, declaration }); }
  }
  return { available, conflicts };
}

/** The host tool specification the harness is shown; the description names the package. */
export const hostToolSpec = (listed: Listed): Obj => ({ type: 'function', name: listed.declaration.name, description: `${listed.declaration.description} (Provided by ${listed.packageName}.)`, inputSchema: listed.declaration.inputSchema });

// ---- The registry ----------------------------------------------------------------------------------------------------

export type ModelToolCode = 'InvalidShape' | 'LimitExceeded' | 'Timeout' | 'HostUnavailable' | 'PermissionDenied' | 'NotFound';
export interface CallError { code: ModelToolCode; message: string }
export interface Served { content: Json; isError: boolean; owner: string; packageName: string }
/** Hands one awaited frame to the running service of `owner`: its answer, or `null` when no process runs. */
export type Ask = (owner: string, frame: Obj) => Promise<Json> | null;
export interface Wiring { source: () => Entry[]; holds: (owner: string, version: string, permission: string, project: string | null) => boolean; ask: Ask }

const TIMED_OUT: unique symbol = Symbol('timed out');

export class ModelToolRegistry {
  private readonly handlers = new Set<string>();
  private readonly wiring: Wiring;
  constructor(wiring: Wiring) { this.wiring = wiring; }
  private key = (owner: string, id: string) => `${owner}\u0000${id}`;

  /** `panda.modelTools.register(id)`: `UnknownReference`, `PermissionDenied`, `DuplicateId`, `HostUnavailable`. */
  register(owner: string, id: string): { ok: true; value: Obj } | { ok: false; code: string } {
    const entries = this.wiring.source();
    const entry = entries.find(candidate => candidate.owner === owner);
    if (!entry) return { ok: false, code: 'HostUnavailable' };
    const declaration = entry.declarations.find(candidate => candidate.id === id);
    if (!declaration) return { ok: false, code: 'UnknownReference' };
    if (!this.wiring.holds(owner, entry.version, PERMISSION, null)) return { ok: false, code: 'PermissionDenied' };
    if (this.handlers.has(this.key(owner, id))) return { ok: false, code: 'DuplicateId' };
    this.handlers.add(this.key(owner, id));
    const conflict = resolve(entries).conflicts.find(candidate => candidate.owner === owner && candidate.id === id);
    const value: Obj = { ...declaration, available: !conflict };
    if (conflict) value.conflict = { name: conflict.name, heldBy: conflict.heldBy };
    return { ok: true, value };
  }
  unregister(owner: string, id: string) { this.handlers.delete(this.key(owner, id)); }
  /** The service of `owner` ended: none of its handlers stays. */
  removeOwner(owner: string): number {
    let removed = 0;
    for (const key of [...this.handlers]) if (key.startsWith(`${owner}\u0000`)) { this.handlers.delete(key); removed += 1; }
    return removed;
  }
  registered(owner: string, id: string) { return this.handlers.has(this.key(owner, id)); }
  /** The tools a run of `project` may be offered, by the grant checked now. */
  listed(project: string): Listed[] { return resolve(this.wiring.source()).available.filter(listed => this.wiring.holds(listed.owner, listed.version, PERMISSION, project)); }
  conflicts(): Conflict[] { return resolve(this.wiring.source()).conflicts; }
  ownerOf(name: string): string | undefined { return resolve(this.wiring.source()).available.find(listed => listed.declaration.name === name)?.owner; }

  /** One call, the way the host serves it. Resolves to the served result or the error result the model reads. */
  async call(project: string, name: string, input: Json, context: Obj): Promise<{ ok: true; served: Served } | { ok: false; error: CallError }> {
    const fail = (code: ModelToolCode, message: string) => ({ ok: false as const, error: { code, message } });
    const listed = this.listed(project).find(candidate => candidate.declaration.name === name);
    if (!listed) return fail('NotFound', `The tool ${name} is not available.`);
    const { declaration, packageName } = listed;
    const problem = inputProblem(declaration.inputSchema, input);
    if (problem) return fail('InvalidShape', `The input of ${name} is invalid: ${problem}.`);
    if (bytes(input) > MAX_INPUT_BYTES) return fail('LimitExceeded', `The input of ${name} is too large.`);
    if (!this.registered(listed.owner, declaration.id)) return fail('HostUnavailable', `The service of ${packageName} is not running, so ${name} cannot answer.`);
    const pending = this.wiring.ask(listed.owner, { schemaVersion: 1, kind: 'modelTool', observeOnly: false, toolId: declaration.id, input, call: context });
    if (!pending) return fail('HostUnavailable', `The service of ${packageName} is not reachable.`);
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timeout = new Promise<typeof TIMED_OUT>(resolveTimeout => { timer = setTimeout(() => resolveTimeout(TIMED_OUT), declaration.timeoutMs); });
    let answer: Json | typeof TIMED_OUT;
    try { answer = await Promise.race([pending, timeout]); }
    catch { return fail('HostUnavailable', `${name} failed in ${packageName}.`); }
    finally { if (timer) clearTimeout(timer); }
    if (answer === TIMED_OUT) return fail('Timeout', `${name} did not answer within ${declaration.timeoutMs} ms.`);
    const checked = envelope(answer);
    if (!checked.ok) return fail(checked.code, checked.code === 'LimitExceeded' ? `The result of ${name} is larger than ${MAX_RESULT_BYTES / 1024} KiB.` : `${packageName} answered ${name} in a shape the host cannot use.`);
    return { ok: true, served: { content: checked.content, isError: checked.isError, owner: listed.owner, packageName } };
  }
}

/** What the model receives for a served call: the content as the result, or an error result carrying it. */
export function modelResult(served: Served): { ok: true; value: Json } | { ok: false; error: string } {
  if (!served.isError) return { ok: true, value: served.content };
  return { ok: false, error: typeof served.content === 'string' ? served.content : JSON.stringify(served.content) };
}

/** `core.tools.list()` of a package provider: the app's tools and, with `tools.model` for the project, the package tools. */
export function coreToolsList(registry: ModelToolRegistry, wiring: Pick<Wiring, 'holds'>, core: Obj[], approvalCore: ReadonlySet<string>, project: string, requester: { owner: string; version: string }): Obj[] {
  const out: Obj[] = core.map(tool => ({ name: tool.name as string, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null, owner: null, needsApproval: approvalCore.has(tool.name as string) }));
  if (wiring.holds(requester.owner, requester.version, PERMISSION, project)) {
    for (const listed of registry.listed(project)) out.push({ name: listed.declaration.name, description: listed.declaration.description, inputSchema: listed.declaration.inputSchema, owner: listed.owner, needsApproval: listed.declaration.approval !== 'never' });
  }
  return out;
}

/** The tool row the transcript shows for a served call: the tool and the package that served it. */
export const attributedRow = (served: Served, name: string): Obj => ({ title: name, owner: served.owner, label: `${served.packageName} served ${name}.`, status: served.isError ? 'failed' : 'completed' });
