// Webview and preview twin of src-tauri/src/extensions/runtime_tool_servers.rs (runtime phase R7, slice R0702): the
// rules of `contributes.toolServers` that contracts.ts applies after the schema (the same checks in the same order as
// the native `check`), the inventory by project grant, and a registry that attaches servers to runs the way the host
// does: a bounded handshake for a stdio server, an http server attached as declared, start/stop/restart bounded, a
// revoked grant removing only its own slots. Everything here is for predictability and fault isolation (ADR-0005).
// A stdio server never receives a held value (ADR-0006); the held-header attachment of http servers is R0703.
import type { Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const PERMISSION = 'tools.model';
export const MAX_SERVERS = 4;
export const MAX_TITLE = 80;
export const MAX_COMMAND_PARTS = 16;
export const MAX_COMMAND_PART = 1_024;
export const MAX_URL = 2_048;
export const MAX_TOOL_NAMES = 64;
export const MAX_ATTEMPTS = 5;
export const MAX_ATTACHMENTS = 32;
export const MAX_ERROR = 200;
export const TRANSPORTS = ['stdio', 'http'] as const;
export const AUTHENTICATIONS = ['none', 'bearer', 'header'] as const;
export const CREDENTIAL_SOURCES = ['secret', 'entered', 'held'] as const;
const PLACEHOLDERS = ['{node}', '{package}'];
const AT = 'contributes/toolServers' as const;
const encoder = new TextEncoder();

// ---- Declarations ----------------------------------------------------------------------------------------------------

export interface Declaration {
  id: string; title: string; transport: 'stdio' | 'http'; command: string[]; url: string;
  authentication: 'none' | 'bearer' | 'header'; credential: Obj | null;
}
export interface Refusal { code: string; at: typeof AT | 'permissions'; ids: string[] }
/** A declared credential is attached host-side by R0703; until then the server is not handed to a harness. */
export const credentialPending = (declaration: Declaration) => declaration.authentication !== 'none';
const refuse = (code: string, at: Refusal['at'], id: string): { ok: false; refusal: Refusal } => ({ ok: false, refusal: { code, at, ids: [id] } });

/** Every `{…}` in a command part is one of the two placeholders. */
export function placeholdersKnown(part: string): boolean {
  let rest = part;
  for (;;) {
    const open = rest.indexOf('{');
    if (open < 0) break;
    const tail = rest.slice(open);
    const close = tail.indexOf('}');
    if (close < 0 || !PLACEHOLDERS.includes(tail.slice(0, close + 1))) return false;
    rest = tail.slice(close + 1);
  }
  return !rest.includes('}');
}

/** `http(s)://host[:port]/…` with no user information and no whitespace. */
export function validUrl(url: string): boolean {
  const rest = url.startsWith('https://') ? url.slice(8) : url.startsWith('http://') ? url.slice(7) : null;
  if (rest === null) return false;
  const authority = rest.split(/[/?#]/)[0] ?? '';
  return url.length <= MAX_URL && authority.length > 0 && !authority.includes('@') && !/[\s\u0000-\u001f\u007f]/.test(url);
}

export function checkToolServerDeclarations(manifest: Json): { ok: true; declarations: Declaration[] } | { ok: false; refusal: Refusal } {
  const contributes = object(manifest) && object(manifest.contributes) ? manifest.contributes : {};
  const servers = contributes.toolServers;
  if (!Array.isArray(servers) || servers.length === 0) return { ok: true, declarations: [] };
  const root = manifest as Obj;
  const pkg = typeof root.id === 'string' ? root.id : '';
  if (servers.length > MAX_SERVERS) return refuse('LimitExceeded', AT, pkg);
  const permissions = new Set(Array.isArray(root.permissions) ? root.permissions : []);
  const ids = new Set<string>();
  const out: Declaration[] = [];
  for (const raw of servers) {
    const server = (object(raw) ? raw : {}) as Obj;
    const id = typeof server.id === 'string' ? server.id : '';
    if (id.startsWith('panda.')) return refuse('ReservedId', AT, id);
    if (!id.startsWith(`${pkg}/`)) return refuse('InvalidId', AT, id);
    if (ids.has(id)) return refuse('DuplicateId', AT, id);
    ids.add(id);
    const title = server.title;
    if (typeof title !== 'string' || !title.trim() || [...title].length > MAX_TITLE) return refuse('InvalidShape', AT, id);
    const transport = server.transport;
    if (transport !== 'stdio' && transport !== 'http') return refuse('InvalidShape', AT, id);
    let authentication: Declaration['authentication'] = 'none';
    if ('authentication' in server) {
      if (typeof server.authentication !== 'string' || !(AUTHENTICATIONS as readonly string[]).includes(server.authentication)) return refuse('InvalidShape', AT, id);
      authentication = server.authentication as Declaration['authentication'];
    }
    const credential = server.credential === undefined || server.credential === null ? null : server.credential;
    let command: string[] = [];
    let url = '';
    if (transport === 'stdio') {
      // A package process never receives a held value (ADR-0006): no credential field at all.
      if (authentication !== 'none' || credential !== null || 'url' in server) return refuse('InvalidShape', AT, id);
      const parts = server.command;
      if (!Array.isArray(parts) || parts.length === 0 || parts.length > MAX_COMMAND_PARTS) return refuse('InvalidShape', AT, id);
      for (const part of parts) {
        if (typeof part !== 'string' || !part || encoder.encode(part).length > MAX_COMMAND_PART || !placeholdersKnown(part)) return refuse('InvalidShape', AT, id);
        command.push(part);
      }
    } else {
      if ('command' in server) return refuse('InvalidShape', AT, id);
      if (typeof server.url !== 'string' || !validUrl(server.url)) return refuse('InvalidShape', AT, id);
      url = server.url;
      if (authentication === 'none') { if (credential !== null) return refuse('InvalidShape', AT, id); }
      else {
        if (credential === null) return refuse('InvalidShape', AT, id);
        const source = object(credential) && typeof credential.source === 'string' && (CREDENTIAL_SOURCES as readonly string[]).includes(credential.source) ? credential.source : null;
        const name = object(credential) ? (source === 'held' ? credential.id : credential.key) : undefined;
        if (source === null || typeof name !== 'string' || !name || encoder.encode(name).length > 200) return refuse('InvalidShape', AT, id);
      }
    }
    out.push({ id, title, transport, command, url, authentication, credential: credential as Obj | null });
  }
  if (!permissions.has(PERMISSION)) return refuse('PermissionDenied', 'permissions', pkg);
  return { ok: true, declarations: out };
}

/** The command with `{node}` and `{package}` replaced; `null` when a placeholder has nothing to resolve to. */
export function resolveCommand(command: readonly string[], node: string | null, pkg: string | null): string[] | null {
  const out: string[] = [];
  for (const part of command) {
    let text = part;
    if (text.includes('{node}')) { if (node === null) return null; text = text.split('{node}').join(node); }
    if (text.includes('{package}')) { if (pkg === null) return null; text = text.split('{package}').join(pkg); }
    out.push(text);
  }
  return out;
}

/** The name a harness knows a server by: `pkg_<owner>__<server>`, lowercase `[a-z0-9_]`, at most 48 characters. */
export function serverName(id: string): string {
  const slash = id.indexOf('/');
  const [owner, tail] = slash < 0 ? [id, ''] : [id.slice(0, slash), id.slice(slash + 1)];
  const clean = (text: string) => [...text].map(c => (/[A-Za-z0-9]/.test(c) ? c.toLowerCase() : '_')).join('');
  return `pkg_${clean(owner)}__${clean(tail)}`.slice(0, 48);
}

// ---- The inventory and the run attachments ---------------------------------------------------------------------------

export interface Entry { owner: string; version: string; packageName: string; declarations: Declaration[]; packageDir?: () => string | null }
export interface Listed { owner: string; version: string; packageName: string; declaration: Declaration; packageDir?: () => string | null }
export type State = 'attached' | 'failed' | 'stopped' | 'credentialPending';
/** The bounded handshake of a launched stdio server: the names of its tools, or an error code. */
export type Probe = (argv: string[], cwd: string) => { ok: true; tools: string[] } | { ok: false; code: string };
export interface Wiring {
  source: () => Entry[];
  holds: (owner: string, version: string, permission: string, project: string) => boolean;
  probe: Probe;
  node: () => string | null;
}
export interface Slot {
  run: string; owner: string; id: string; title: string; package: string; transport: 'stdio' | 'http'; state: State; tools: string[]; error: string | null; attempts: number; name: string;
}
interface Held { project: string; version: string; packageName: string; declaration: Declaration; cwd: string; state: State; tools: string[]; error: string | null; attempts: number; argv: string[] }
const bounded = (text: string) => [...text].slice(0, MAX_ERROR).join('');

export class ToolServerRegistry {
  private readonly slots = new Map<string, Held & { run: string; owner: string }>();
  constructor(private readonly wiring: Wiring) {}
  private key = (run: string, owner: string, id: string) => `${run}\u0000${owner}\u0000${id}`;

  /** The servers a run of `project` may be offered, by the grant checked now. */
  listed(project: string): Listed[] {
    return this.wiring.source().filter(entry => this.wiring.holds(entry.owner, entry.version, PERMISSION, project))
      .flatMap(entry => entry.declarations.map(declaration => ({ owner: entry.owner, version: entry.version, packageName: entry.packageName, declaration, packageDir: entry.packageDir })));
  }
  private launch(listed: Listed, cwd: string): Pick<Held, 'state' | 'tools' | 'error' | 'argv'> {
    const { declaration } = listed;
    if (credentialPending(declaration)) return { state: 'credentialPending', tools: [], error: 'Waiting for its credential to be attached by the host.', argv: [] };
    if (declaration.transport === 'http') return { state: 'attached', tools: [], error: null, argv: [] };
    const argv = resolveCommand(declaration.command, this.wiring.node(), listed.packageDir?.() ?? null);
    if (!argv) return { state: 'failed', tools: [], error: 'The runtime or the package folder is not available.', argv: [] };
    const answer = this.wiring.probe(argv, cwd);
    return answer.ok ? { state: 'attached', tools: answer.tools.slice(0, MAX_TOOL_NAMES), error: null, argv }
      : { state: 'failed', tools: [], error: bounded(`${declaration.title} could not connect (${answer.code}).`), argv };
  }
  private view(held: Held & { run: string; owner: string }): Slot {
    return { run: held.run, owner: held.owner, id: held.declaration.id, title: held.declaration.title, package: held.packageName, transport: held.declaration.transport, state: held.state, tools: held.tools, error: held.error, attempts: held.attempts, name: serverName(held.declaration.id) };
  }

  /** Gives `run` a slot per listed server, replacing what the run held before; at most MAX_ATTACHMENTS. */
  attachRun(run: string, project: string, cwd = ''): Slot[] {
    this.detachRun(run);
    const out: Slot[] = [];
    for (const listed of this.listed(project).slice(0, MAX_ATTACHMENTS)) {
      const held = { run, owner: listed.owner, project, version: listed.version, packageName: listed.packageName, declaration: listed.declaration, cwd, attempts: 1, ...this.launch(listed, cwd) };
      this.slots.set(this.key(run, listed.owner, listed.declaration.id), held);
      out.push(this.view(held));
    }
    return out;
  }
  /** The run ended: its slots go, nobody else's. */
  detachRun(run: string) { for (const [key, held] of [...this.slots]) if (held.run === run) this.slots.delete(key); }
  private find(run: string, id: string) { return [...this.slots.values()].find(held => held.run === run && held.declaration.id === id); }

  stop(run: string, id: string): { ok: true; slot: Slot } | { ok: false; code: 'NotFound' } {
    const held = this.find(run, id);
    if (!held) return { ok: false, code: 'NotFound' };
    Object.assign(held, { state: 'stopped', tools: [], error: null });
    return { ok: true, slot: this.view(held) };
  }
  /** Starts a stopped or failed server again (restart also works on an attached one). */
  start(run: string, id: string): { ok: true; slot: Slot } | { ok: false; code: 'NotFound' | 'LimitExceeded' | 'PermissionDenied' } {
    const held = this.find(run, id);
    if (!held) return { ok: false, code: 'NotFound' };
    if (held.attempts >= MAX_ATTEMPTS) return { ok: false, code: 'LimitExceeded' };
    const listed = this.listed(held.project).find(candidate => candidate.declaration.id === id);
    if (!listed) return { ok: false, code: 'PermissionDenied' };
    Object.assign(held, this.launch(listed, held.cwd), { attempts: held.attempts + 1 });
    return { ok: true, slot: this.view(held) };
  }
  restart(run: string, id: string) { return this.start(run, id); }

  /** A grant, an enablement or the safe mode changed: only slots whose package is no longer listed go. */
  reconcile(): Array<{ run: string; id: string }> {
    const listed = new Map<string, Set<string>>();
    const removed: Array<{ run: string; id: string }> = [];
    for (const [key, held] of [...this.slots]) {
      if (!listed.has(held.project)) listed.set(held.project, new Set(this.listed(held.project).map(candidate => `${candidate.owner}\u0000${candidate.declaration.id}`)));
      if (!listed.get(held.project)!.has(`${held.owner}\u0000${held.declaration.id}`)) { this.slots.delete(key); removed.push({ run: held.run, id: held.declaration.id }); }
    }
    return removed;
  }

  state(run: string): Slot[] { return [...this.slots.values()].filter(held => held.run === run).map(held => this.view(held)); }
  /** The tools the run's attached servers announced, per server id. */
  tools(run: string): Record<string, string[]> {
    return Object.fromEntries([...this.slots.values()].filter(held => held.run === run && held.state === 'attached').map(held => [held.declaration.id, held.tools]));
  }
  attachedCount(): number { return [...this.slots.values()].filter(held => held.state === 'attached').length; }

  /** What a harness is given for `run`: each attached server that is not waiting for a credential. */
  mcpEntries(run: string, shape: 'claude' | 'codex' | 'acp'): Array<{ name: string; entry: Obj }> {
    return [...this.slots.values()].filter(held => held.run === run && held.state === 'attached').map(held => {
      const name = serverName(held.declaration.id);
      const { url } = held.declaration;
      const [program, ...args] = held.argv;
      let entry: Obj;
      if (held.declaration.transport === 'http') entry = shape === 'claude' ? { type: 'http', url } : shape === 'codex' ? { url, enabled: true } : { type: 'http', name, url, headers: [] };
      else entry = shape === 'claude' ? { type: 'stdio', command: program, args, env: {} } : shape === 'codex' ? { command: program, args, enabled: true } : { name, command: program, args, env: [] };
      return { name, entry };
    });
  }
  /** `(package, server title)` of a tool `mcp__<server>__<tool>` or of a bare server name, for the tool row. */
  attribution(run: string, tool: string): { packageName: string; title: string } | null {
    const find = (name: string) => { const held = [...this.slots.values()].find(candidate => candidate.run === run && serverName(candidate.declaration.id) === name); return held ? { packageName: held.packageName, title: held.declaration.title } : null; };
    if (!tool.startsWith('mcp__')) return find(tool);
    const parts = tool.slice(5).split('__').filter(Boolean);
    return parts.length >= 2 ? find(`${parts[0]}__${parts[1]}`) ?? find(parts[0]) : find(tool);
  }
}

/** The row a served server's tool call carries: the package is named. */
export const attributedRow = (packageName: string, title: string, tool: string): Obj => ({ title: tool, label: `${packageName} (${title}) served ${tool}.` });
