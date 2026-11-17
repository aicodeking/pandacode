// Webview and preview twin of src-tauri/src/extensions/runtime_model_tool_parity.rs (runtime phase R7, slice R0703):
// the capability rows and the run-path matrix of package tools, honest call outcomes (executed yes / no / unknown, a result
// that was cut or never arrived is never a success), the provider `core.tools.list/call` bridge over the run's tool host,
// the host-added header of a held credential on an HTTP tool server (a stdio server never receives one, ADR-0006), and the
// zero-extension bridge of a resumed session. Everything here is for predictability and fault isolation (ADR-0005).
import type { Json } from './runtime-hook-payload.ts';
import type { CallError, ModelToolRegistry, Served } from './runtime-model-tools.ts';
import { serverName, type Declaration, type ToolServerRegistry } from './runtime-tool-servers.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const SCHEMA_VERSION = 1;
/** The header a `header` authentication uses when the declaration names none. */
export const DEFAULT_HEADER = 'X-API-Key';
export const MAX_HEADER_VALUE = 8_192;
export const MAX_LINE = 200;
export const QUALIFICATIONS = ['sourceFeasible', 'recorded', 'installedQualified', 'unsupported'] as const;
/** What the tool-server attachment is today: the entries are built, the per-run providers do not read them yet. */
export const SERVER_ATTACHMENT = 'entriesReady';
const CLAUDE = ['claude', 'glm', 'mimo', 'alibaba'];
const ACP = ['kimi', 'opencode', 'antigravity', 'grok', 'deepseek', 'commandcode', 'cline', 'kilo', 'github-copilot', 'devin', 'hermes', 'cursor'];
export const RECORDED = ['claude', 'glm', 'mimo', 'alibaba', 'codex', 'kimi', 'pi'];
export const INSTALLED_QUALIFIED: ReadonlyArray<readonly [string, string]> = [];

// ---- Capabilities ----------------------------------------------------------------------------------------------------

export type Family = 'claude' | 'codex' | 'acp' | 'pi' | 'muse' | 'zcode' | 'package' | 'unknown';
export function family(harness: string, pkg: boolean): Family {
  if (pkg) return 'package';
  if (CLAUDE.includes(harness)) return 'claude';
  if (ACP.includes(harness)) return 'acp';
  return harness === 'codex' ? 'codex' : harness === 'pi' || harness === 'omp' ? 'pi' : harness === 'muse' ? 'muse' : harness === 'zcode' ? 'zcode' : 'unknown';
}
type Supported = { ok: true; bridge: string } | { ok: false; reason: string };
const A5 = "ZCode's per-session bridge is pending person decision A5 and is not wired.";
const NO_ENTRY = "PandaCode's launch of this harness has no place for an MCP server entry.";
function modelBridge(kind: Family): Supported {
  switch (kind) {
    case 'claude': return { ok: true, bridge: 'per-run MCP host (--mcp-config)' };
    case 'codex': return { ok: true, bridge: 'per-run MCP host (config mcp_servers)' };
    case 'acp': return { ok: true, bridge: 'per-run MCP host (session/new mcpServers)' };
    case 'pi': return { ok: true, bridge: 'Pi extension bridge' };
    case 'muse': return { ok: true, bridge: 'host tools' };
    case 'package': return { ok: true, bridge: 'core.tools of the provider' };
    case 'zcode': return { ok: false, reason: A5 };
    default: return { ok: false, reason: 'This harness has no way to receive tools from the host.' };
  }
}
export type Shape = 'claude' | 'codex' | 'acp';
function serverShape(kind: Family): { ok: true; shape: Shape } | { ok: false; reason: string } {
  switch (kind) {
    case 'claude': case 'codex': case 'acp': return { ok: true, shape: kind };
    case 'pi': case 'muse': return { ok: false, reason: NO_ENTRY };
    case 'package': return { ok: false, reason: 'A package provider reaches tools through core.tools, not through an MCP server entry.' };
    case 'zcode': return { ok: false, reason: A5 };
    default: return { ok: false, reason: 'This harness has no way to receive a tool server.' };
  }
}
const installed = (harness: string, path: string) => INSTALLED_QUALIFIED.some(([id, qualified]) => id === harness && qualified === path);
function cell(harness: string, supported: Supported, recorded: boolean, path: string): Obj {
  if (!supported.ok) return { support: 'unsupported', qualification: 'unsupported', bridge: null, code: 'UnsupportedCapability', reason: supported.reason };
  return { support: 'supported', qualification: installed(harness, path) ? 'installedQualified' : recorded ? 'recorded' : 'sourceFeasible', bridge: supported.bridge, code: null, reason: null };
}

/** The row of one harness. A tool-server cell is never `recorded`: no frame of a real harness launched with such an entry exists. */
export function row(harness: string, pkg: boolean): Obj {
  const kind = family(harness, pkg);
  const shape = serverShape(kind);
  const toolServers = cell(harness, shape.ok ? { ok: true, bridge: `${shape.shape} launch entry` } : shape, false, 'toolServers');
  if (shape.ok) { toolServers.bridge = null; toolServers.shape = shape.shape; toolServers.attachment = SERVER_ATTACHMENT; }
  return { harness, family: kind, modelTools: cell(harness, modelBridge(kind), pkg || RECORDED.includes(harness), 'modelTools'), toolServers };
}
export const shapeOf = (harness: string, pkg: boolean): Shape | null => { const shape = serverShape(family(harness, pkg)); return shape.ok ? shape.shape : null; };

export interface Path { kind: string; trigger: string; here: boolean; note: string }
/** Every run path the host classifies. Only a mirrored run executes elsewhere. */
export const PATHS: readonly Path[] = [
  { kind: 'task', trigger: 'user', here: true, note: '' },
  { kind: 'task', trigger: 'package', here: true, note: '' },
  { kind: 'task', trigger: 'tool', here: true, note: '' },
  { kind: 'worker', trigger: 'team', here: true, note: '' },
  { kind: 'worker', trigger: 'council', here: true, note: '' },
  { kind: 'bot', trigger: 'bot', here: true, note: '' },
  { kind: 'schedule', trigger: 'schedule', here: true, note: '' },
  { kind: 'remote', trigger: 'remote', here: true, note: "A paired device's turn runs on this computer." },
  { kind: 'remote', trigger: 'cloud', here: true, note: "The cloud agent's tool host is built here." },
  { kind: 'remote', trigger: 'mirror', here: false, note: 'The turn runs on another computer; this desktop only mirrors it.' },
];
export function pathCell(harness: string, pkg: boolean, path: Path): Obj {
  const base = row(harness, pkg);
  const on = (key: 'modelTools' | 'toolServers'): Json => path.here ? base[key] : { support: 'unsupported', qualification: 'unsupported', bridge: null, code: 'UnsupportedCapability', reason: path.note };
  return { harness, kind: path.kind, trigger: path.trigger, modelTools: on('modelTools'), toolServers: on('toolServers') };
}
export const matrix = (harnesses: ReadonlyArray<readonly [string, boolean]>): Obj[] => harnesses.flatMap(([harness, pkg]) => PATHS.map(path => pathCell(harness, pkg, path)));

// ---- Outcomes --------------------------------------------------------------------------------------------------------

export type Executed = 'no' | 'yes' | 'unknown';
export interface Outcome { status: 'completed' | 'failed' | 'refused' | 'unavailable' | 'interrupted' | 'truncated'; executed: Executed; delivered: boolean; code: string | null; line: string; result?: Json }
const bounded = (text: string) => [...text].slice(0, MAX_LINE).join('');
const outcome = (status: Outcome['status'], executed: Executed, delivered: boolean, code: string | null, line: string): Outcome => ({ status, executed, delivered, code, line: bounded(line) });
/** True only for a tool that ran and whose result reached the model. */
export const succeeded = (value: Outcome) => value.status === 'completed' && value.executed === 'yes' && value.delivered;
/** The diagnostics and recorder form: the status and the line, never the result. */
export const outcomeJson = (value: Outcome): Obj => ({ status: value.status, executed: value.executed, delivered: value.delivered, code: value.code, line: value.line, resultBytes: value.result === undefined ? null : JSON.stringify(value.result).length });

/** What a failed call of the package model-tool registry came to: a timeout, a service that stopped mid-call or an answer the host cannot use is never `no`. */
export function classifyError(error: CallError): Outcome {
  const line = error.message;
  const code: string = error.code;
  if (code === 'NotFound' || code === 'PermissionDenied') return outcome('refused', 'no', false, code, line);
  if (code === 'InvalidShape') return line.includes('answered') ? outcome('failed', 'yes', false, code, line) : outcome('refused', 'no', false, code, line);
  if (code === 'LimitExceeded') return line.startsWith('The result') ? outcome('truncated', 'yes', false, code, line) : outcome('refused', 'no', false, code, line);
  if (code === 'Timeout') return outcome('interrupted', 'unknown', false, code, line);
  if (code === 'HostUnavailable' && (line.includes('stopped before') || line.includes('failed in'))) return outcome('interrupted', 'unknown', false, code, line);
  return outcome('unavailable', 'no', false, code, line);
}
export function servedOutcome(served: Served): Outcome {
  const value = served.isError ? outcome('failed', 'yes', true, null, 'The tool answered an error result.') : outcome('completed', 'yes', true, null, '');
  value.result = served.content;
  return value;
}
/** A tool server's call is made by the harness; success is claimed only for a `completed` row that carries its output and was not cut. */
export function serverOutcome(rowValue: Obj): Outcome {
  const output = rowValue.output;
  const status = typeof rowValue.status === 'string' ? rowValue.status : '';
  if (status === 'completed' && output !== undefined && output !== null) {
    const value = rowValue.truncated === true ? outcome('truncated', 'yes', false, 'LimitExceeded', 'The result was cut by the harness.') : outcome('completed', 'yes', true, null, '');
    value.result = output;
    return value;
  }
  if (status === 'completed') return outcome('interrupted', 'unknown', false, 'HostUnavailable', 'The harness reported the call done without its result.');
  if (status === 'failed') return outcome('failed', 'unknown', false, null, 'The harness reported the call failed.');
  return outcome('interrupted', 'unknown', false, 'HostUnavailable', 'The server was cancelled, reconnected or never answered.');
}

// ---- Provider core.tools over the run's tool host --------------------------------------------------------------------

export type Lookup = { kind: 'core' } | { kind: 'package'; owner: string } | { kind: 'gone' };
export type Verdict = { allow: true } | { allow: false; reason: string };
export interface CallFacts { run: string; kind: string; mode: string; tool: string; package: string | null; inputBytes: number }
export interface ToolHost { tools: Obj[]; approvalTools: ReadonlySet<string>; handler: (name: string, input: Json) => Promise<{ ok: true; value: Json } | { ok: false; line: string }> }
/** The mode's rule for a tool that needs approval: `plan` refuses, `full` allows, the other modes ask. */
export function modeVerdict(mode: string, userAllows: boolean): Verdict {
  if (mode === 'plan') return { allow: false, reason: 'This host action is unavailable in Plan mode' };
  if (mode === 'full' || userAllows) return { allow: true };
  return { allow: false, reason: 'The user declined.' };
}

export class CoreBridge {
  constructor(private readonly host: ToolHost, private readonly resolve: (name: string) => Lookup, private readonly approver: ((facts: CallFacts) => Verdict) | null, private readonly trace: Obj[]) {}
  /** The tools the run offers now: the host's own list without a package tool that is no longer offered. */
  list(): Obj[] {
    const out: Obj[] = [];
    for (const tool of this.host.tools) {
      const name = typeof tool.name === 'string' ? tool.name : '';
      const lookup = this.resolve(name);
      if (!name || lookup.kind === 'gone') continue;
      out.push({ name, description: tool.description ?? null, inputSchema: tool.inputSchema ?? null, owner: lookup.kind === 'package' ? lookup.owner : null, needsApproval: this.host.approvalTools.has(name) });
    }
    return out;
  }
  async call(run: string, kind: string, mode: string, name: string, input: Json): Promise<Outcome> {
    const lookup = this.resolve(name);
    if (!this.host.tools.some(tool => tool.name === name) || lookup.kind === 'gone') {
      this.trace.push({ event: 'tool.refused', tool: name, code: 'NotFound' });
      return outcome('refused', 'no', false, 'NotFound', `The tool ${name} is not available.`);
    }
    const needs = this.host.approvalTools.has(name);
    if (needs) {
      const facts: CallFacts = { run, kind, mode, tool: name, package: lookup.kind === 'package' ? lookup.owner : null, inputBytes: JSON.stringify(input).length };
      if (!this.approver) {
        this.trace.push({ event: 'tool.before', tool: name, asked: true, verdict: 'unavailable' });
        return outcome('unavailable', 'no', false, 'HostUnavailable', `${name} needs approval and no approval is attached to this call.`);
      }
      const verdict = this.approver(facts);
      this.trace.push({ event: 'tool.before', tool: name, asked: true, verdict: verdict.allow ? 'allow' : 'deny' });
      if (!verdict.allow) return outcome('refused', 'no', false, 'PermissionDenied', verdict.reason);
    } else this.trace.push({ event: 'tool.before', tool: name, asked: false, verdict: 'allow' });
    const answer = await this.host.handler(name, input);
    if (answer.ok) { const value = outcome('completed', 'yes', true, null, ''); value.result = answer.value; return value; }
    // The handler's error is a line, not a code: the tool may or may not have run, so nothing is claimed.
    return outcome('failed', 'unknown', false, null, answer.line);
  }
}

// ---- The held credential of an HTTP tool server ----------------------------------------------------------------------

export const validHeader = (name: string) => /^[A-Za-z0-9-]{1,64}$/.test(name);
export const validItem = (item: string) => {
  const colon = item.indexOf(':');
  if (colon < 0) return item === 'speech' || item === 'github';
  const [kind, id] = [item.slice(0, colon), item.slice(colon + 1)];
  return ['provider', 'connection', 'bot', 'deploy', 'cloud'].includes(kind) && /^[A-Za-z0-9._-]{1,64}$/.test(id);
};
export interface Plan { item: string; header: string; prefix: string }
/** The header a declaration asks for. `null`: no credential (a stdio server never has one). */
export function headerPlan(declaration: Declaration): { ok: true; plan: Plan | null } | { ok: false; code: 'UnsupportedCapability' | 'InvalidShape' } {
  if (declaration.transport !== 'http' || declaration.authentication === 'none') return { ok: true, plan: null };
  const credential = declaration.credential;
  if (!object(credential)) return { ok: false, code: 'InvalidShape' };
  if (credential.source !== 'held') return { ok: false, code: 'UnsupportedCapability' };
  if (typeof credential.id !== 'string' || !validItem(credential.id)) return { ok: false, code: 'InvalidShape' };
  if (declaration.authentication === 'bearer') return { ok: true, plan: { item: credential.id, header: 'Authorization', prefix: 'Bearer ' } };
  const named = credential.header === undefined || credential.header === null ? DEFAULT_HEADER : credential.header;
  if (typeof named !== 'string' || !validHeader(named)) return { ok: false, code: 'InvalidShape' };
  return { ok: true, plan: { item: credential.id, header: named, prefix: '' } };
}
/** The origin and path of a declared address (the query is not kept in a record). */
export function addressOf(url: string): string | null {
  try { const parsed = new URL(url); return `${parsed.protocol}//${parsed.host}${parsed.pathname}`; } catch { return null; }
}
function httpEntry(shape: Shape, name: string, url: string, header: string, value: string): Obj {
  if (shape === 'claude') return { type: 'http', url, headers: { [header]: value } };
  if (shape === 'codex') return { url, enabled: true, http_headers: { [header]: value } };
  return { type: 'http', name, url, headers: [{ name: header, value }] };
}
/** Replaces every occurrence of a held value in a JSON tree with `[held]`. */
export function scrub(value: Json, secrets: readonly string[]): Json {
  if (typeof value === 'string') return secrets.some(secret => secret && value.includes(secret)) ? '[held]' : value;
  if (Array.isArray(value)) return value.map(item => scrub(item, secrets));
  if (object(value)) return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, scrub(item, secrets)]));
  return value;
}

/** Where a held value comes from and where uses are written: PandaCode's own store, a fake in the preview and the spec. */
export interface HeldStore { use(owner: string, version: string, item: string, address: string): { ok: true; value: string } | { ok: false; code: string } }
export interface Ports { servers: ToolServerRegistry; held: HeldStore; holdsItem: (owner: string, version: string, item: string) => boolean }

export class Attachment {
  readonly states: Obj[] = [];
  private readonly all: Array<{ name: string; entry: Obj }> = [];
  private readonly secrets: string[] = [];
  /** @internal for the attach function. */
  push(name: string, entry: Obj, secrets: readonly string[] = []) { this.all.push({ name, entry }); this.secrets.push(...secrets); }
  /** `(name, entry)` for the harness launch. An http entry with a credential carries its header value. */
  entries(): ReadonlyArray<{ name: string; entry: Obj }> { return this.all; }
  /** The same entries with every held value replaced by `[held]`: for diagnostics, the recorder and the tests. */
  publicEntries(): Array<{ name: string; entry: Json }> { return this.all.map(({ name, entry }) => ({ name, entry: scrub(entry, this.secrets) })); }
  names(): string[] { return this.all.map(({ name }) => name); }
  toJSON() { return { states: this.states, entries: this.publicEntries() }; }
}

const stateLine = (base: Obj, state: string, error: string | null, credential: Json): Obj => ({ ...base, state, error: error === null ? null : bounded(error), credential });

/** The entries of `run` for one harness shape: what the registry attached, plus each credential-pending HTTP server whose held credential the package declared, the user granted and PandaCode holds. */
export function attach(ports: Ports, run: string, project: string, shape: Shape): Attachment {
  const out = new Attachment();
  for (const { name, entry } of ports.servers.mcpEntries(run, shape)) out.push(name, entry as Obj);
  const listed = ports.servers.listed(project);
  for (const slot of ports.servers.state(run)) {
    const base = slot as unknown as Obj;
    if (slot.state !== 'credentialPending') { out.states.push(base); continue; }
    const server = listed.find(candidate => candidate.declaration.id === slot.id);
    if (!server) { out.states.push(stateLine(base, 'failed', 'The server is no longer offered.', null)); continue; }
    const planned = headerPlan(server.declaration);
    if (!planned.ok || planned.plan === null) {
      const code = planned.ok ? 'InvalidShape' : planned.code;
      out.states.push(stateLine(base, 'credentialPending', `Its credential source is not attached by the host (${code}).`, { state: 'unsupported', code }));
      continue;
    }
    const { plan } = planned;
    const credential = (state: string): Json => ({ item: plan.item, header: plan.header, state });
    if (!ports.holdsItem(server.owner, server.version, plan.item)) { out.states.push(stateLine(base, 'credentialDenied', 'The package was not granted this credential.', credential('denied'))); continue; }
    const address = addressOf(server.declaration.url);
    if (address === null) { out.states.push(stateLine(base, 'failed', 'The server address is not valid.', credential('invalid'))); continue; }
    const used = ports.held.use(server.owner, server.version, plan.item, address);
    if (!used.ok) {
      out.states.push(used.code === 'NotFound'
        ? stateLine(base, 'credentialMissing', 'PandaCode holds no such credential.', credential('missing'))
        : stateLine(base, 'credentialUnavailable', `The credential could not be used (${used.code}).`, credential('unavailable')));
      continue;
    }
    const headerValue = `${plan.prefix}${used.value}`;
    if (headerValue.length > MAX_HEADER_VALUE || /[\u0000-\u001f\u007f]/.test(headerValue)) { out.states.push(stateLine(base, 'credentialInvalid', 'The credential cannot be sent as a header.', credential('invalid'))); continue; }
    const name = serverName(slot.id);
    out.push(name, httpEntry(shape, name, server.declaration.url, plan.header, headerValue), [used.value, headerValue]);
    out.states.push(stateLine(base, 'attached', null, credential('attached')));
  }
  return out;
}
/** Whether any entry that runs a package's own command (stdio) carries `needle` in its arguments or environment. */
export const stdioCarries = (entries: ReadonlyArray<{ name: string; entry: Obj }>, needle: string) => entries.filter(({ entry }) => 'command' in entry).some(({ entry }) => JSON.stringify(entry).includes(needle));

// ---- Disable, safe mode and a resumed session ------------------------------------------------------------------------

/** The package tool names a run is offered now: model tools of its project, and per attached server `mcp__<server>__<tool>` (or `mcp__<server>__*`). */
export function offeredNames(model: ModelToolRegistry, servers: ToolServerRegistry, attachment: Attachment, run: string, project: string): Set<string> {
  const out = new Set(model.listed(project).map(listed => listed.declaration.name));
  for (const [id, tools] of Object.entries(servers.tools(run))) {
    const name = serverName(id);
    if (tools.length === 0) out.add(`mcp__${name}__*`);
    for (const tool of tools) out.add(`mcp__${name}__${tool}`);
  }
  for (const name of attachment.names()) out.add(`mcp__${name}__*`);
  return out;
}
/** A resumed session's tool names without the package names that are no longer offered. */
export function pruneResumed(previous: readonly string[], packageKnown: ReadonlySet<string>, current: ReadonlySet<string>): { kept: string[]; removed: string[] } {
  const covered = (name: string) => current.has(name) || [...current].some(offered => offered.endsWith('*') && name.startsWith(offered.slice(0, -1)));
  const kept: string[] = [];
  const removed: string[] = [];
  for (const name of previous) (((packageKnown.has(name) || name.startsWith('mcp__pkg_')) && !covered(name)) ? removed : kept).push(name);
  return { kept, removed };
}
/** The bridge of a run: its package tools and servers, or the zero-extension bridge when nothing is offered. */
export function bridgeView(offered: ReadonlySet<string>): Obj {
  const names = [...offered].sort();
  return { zeroExtension: names.length === 0, modelTools: names.filter(name => !name.startsWith('mcp__')), toolServers: names.filter(name => name.startsWith('mcp__')) };
}
