// Declared ACP harnesses of trusted packages (`contributes.providers[].launch`, slice R0801).
// The browser preview runs no package code. This module is the preview's twin of
// src-tauri/src/extensions/runtime_provider_launch.rs: the same placeholder and readiness rules, the same shared
// per-package state and the same translation of ACP frames into core conversation events. No DOM, no IPC.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export interface Launch { protocol?: Json; command?: Json; env?: Json }
/** Where placeholders resolve; an absent entry leaves that placeholder an explicit readiness error. */
export interface Places { node?: string; package?: string; data?: string }
export interface Resolved { program: string; arguments: string[]; env: Record<string, string> }
export type Existing = (program: string) => boolean;

export const TRUST_REQUIRED = 'ExecutableTrustRequired: review this version and its executable content in Settings → Extensions before this harness can run.';
export const ACP_VERSION = 1;
/** Longest text delta forwarded as one core event (core refuses larger events). */
export const CHUNK = 8000;

const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);

export function declared(definition: Json): Launch | null {
  return isObject(definition) && isObject(definition.launch) ? definition.launch : null;
}

function substitute(text: string, places: Places): string {
  let out = ''; let rest = text;
  for (;;) {
    const start = rest.indexOf('{');
    if (start < 0) return out + rest;
    out += rest.slice(0, start);
    const end = rest.indexOf('}', start);
    if (end < 0) throw new Error(`InvalidShape: unclosed placeholder in ${JSON.stringify(text)}`);
    const name = rest.slice(start + 1, end);
    if (name === 'node') out += places.node ?? fail("UnsupportedRuntime: this target's trusted Node runtime is not qualified, so {node} cannot be resolved");
    else if (name === 'package') out += places.package ?? fail("UnsupportedRuntime: {package} needs the package's code folder (runtime.files), which is not available");
    else if (name === 'data') out += places.data ?? fail("UnsupportedRuntime: {data} needs the package's data directory, which is not available");
    else throw new Error(`InvalidShape: unknown placeholder {${name}}`);
    rest = rest.slice(end + 1);
  }
}
function fail(message: string): never { throw new Error(message); }

/** Resolves and checks the declared command: protocol, argument shape, placeholders and the executable itself. */
export function resolveLaunch(launch: Launch, places: Places, exists: Existing = () => true): Resolved {
  if (launch.protocol === undefined || launch.protocol === null) throw new Error("InvalidShape: the provider's launch declares no protocol.");
  if (launch.protocol !== 'acp') throw new Error(`UnsupportedCapability: launch protocol ${JSON.stringify(launch.protocol)} is not supported; the only protocol is "acp".`);
  const command = launch.command;
  if (!Array.isArray(command) || command.length < 1 || command.length > 32 || command.some(item => typeof item !== 'string' || item.length > 1024)) {
    throw new Error("InvalidShape: the provider's launch command must be 1 to 32 strings of at most 1,024 characters.");
  }
  const parts = (command as string[]).map(item => substitute(item, places));
  const program = parts.shift() as string;
  if (!program) throw new Error('InvalidShape: the launch command names no executable.');
  if (!exists(program)) throw new Error(`ExecutableMissing: the declared harness executable was not found at ${program}.`);
  const env: Record<string, string> = {};
  const declaredEnv = launch.env;
  if (declaredEnv !== undefined) {
    if (!isObject(declaredEnv)) throw new Error('InvalidShape: the launch environment must be a text map.');
    for (const [name, value] of Object.entries(declaredEnv)) {
      if (!name || name.includes('=') || name.includes('\0')) throw new Error('InvalidShape: an environment name of the launch is invalid.');
      if (typeof value !== 'string') throw new Error('InvalidShape: an environment value of the launch is not text.');
      env[name] = substitute(value, places);
    }
  }
  return { program, arguments: parts, env };
}

/** The one shared state of a package's launched runs: one token manager for every conversation. */
export interface State {
  service: boolean; tokensIssued: number; handshakes: number; active: number; peak: number; finished: number;
  readiness: string[]; lastError: string | null;
}
const states = new Map<string, State>();
const blank = (): State => ({ service: false, tokensIssued: 0, handshakes: 0, active: 0, peak: 0, finished: 0, readiness: [], lastError: null });
export const sharedState = (owner: string): State => { let state = states.get(owner); if (!state) states.set(owner, state = blank()); return state; };
export const snapshotState = (owner: string): State => structuredClone(states.get(owner) ?? blank());
export const forgetState = (owner: string): void => { states.delete(owner); };
export const stateCount = (owner: string): number => (states.has(owner) ? 1 : 0);

function observe(state: State, readiness: string, error: string | null): void {
  if (state.readiness.at(-1) !== readiness) state.readiness.push(readiness);
  state.lastError = error;
}

/** Begins one run on the package's shared state; `end()` releases it. */
export function beginRun(owner: string): { token: number; end(): void } {
  const state = sharedState(owner);
  state.tokensIssued += 1; state.active += 1; state.peak = Math.max(state.peak, state.active);
  const token = state.tokensIssued; let ended = false;
  return { token, end() { if (ended) return; ended = true; state.active = Math.max(0, state.active - 1); state.finished += 1; } };
}
export function recordHandshake(owner: string): void { sharedState(owner).handshakes += 1; }

/** The readiness shown for a declared harness: the manifest's own metadata with `readiness` replaced by what resolves now. */
export function overlayReadiness(owner: string, definition: Json, metadata: Obj, places: Places, exists?: Existing): Obj {
  const launch = declared(definition);
  if (!launch) return metadata;
  const state = sharedState(owner);
  const readiness = metadata.readiness as Obj | undefined;
  if (readiness?.state !== 'ready') { observe(state, String(readiness?.state ?? 'unavailable'), null); return metadata; }
  try { resolveLaunch(launch, places, exists); observe(state, 'ready', null); return metadata; }
  catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    observe(state, 'unavailable', reason);
    return { ...metadata, readiness: { state: 'unavailable', reason } };
  }
}

export type CoreEvent = { kind: 'text' | 'thinking'; text: string }
  | { kind: 'tool'; tool: { id: string; name: string; status: string; input: string; output: string } }
  | { kind: 'usage'; usedTokens: number; contextWindow: number | null };

const chunks = (text: string): string[] => {
  const characters = [...text]; const out: string[] = [];
  for (let at = 0; at < characters.length; at += CHUNK) out.push(characters.slice(at, at + CHUNK).join(''));
  return out;
};
const preview = (value: Json | undefined): string => (value === undefined || value === null ? '' : (typeof value === 'string' ? value : JSON.stringify(value))).slice(0, 2000);

/** Maps one ACP `session/update` onto bounded core conversation events. Unknown kinds are ignored. */
export function updateEvents(update: Json): CoreEvent[] {
  if (!isObject(update)) return [];
  const content = isObject(update.content) ? update.content : undefined;
  switch (update.sessionUpdate) {
    case 'agent_message_chunk': return typeof content?.text === 'string' ? chunks(content.text).map(text => ({ kind: 'text' as const, text })) : [];
    case 'agent_thought_chunk': return typeof content?.text === 'string' ? chunks(content.text).map(text => ({ kind: 'thinking' as const, text })) : [];
    case 'tool_call': case 'tool_call_update': {
      if (typeof update.toolCallId !== 'string') return [];
      const status = update.status === 'completed' ? 'completed' : update.status === 'failed' ? 'failed' : 'running';
      const name = typeof update.title === 'string' ? update.title : typeof update.kind === 'string' ? update.kind : 'tool';
      const texts = Array.isArray(update.content) ? update.content.map(item => (isObject(item) && isObject(item.content) && typeof item.content.text === 'string' ? item.content.text : isObject(item) && typeof item.text === 'string' ? item.text : '')).filter(Boolean) : [];
      return [{ kind: 'tool', tool: { id: update.toolCallId.slice(0, 200), name: name.slice(0, 200), status, input: preview(update.rawInput), output: texts.length ? texts.join('\n').slice(0, 2000) : preview(update.rawOutput) } }];
    }
    case 'usage_update': {
      const used = update.used;
      return typeof used === 'number' && Number.isInteger(used) && used >= 0 ? [{ kind: 'usage', usedTokens: used, contextWindow: typeof update.size === 'number' && update.size > 0 ? update.size : null }] : [];
    }
    default: return [];
  }
}

/** The option a permission answer selects: allow once (or always) when approved, reject once (or always) otherwise. */
export function permissionChoice(options: readonly Json[], approved: boolean): Json | null {
  const [wanted, fallback] = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const kind = (name: string) => options.find(option => isObject(option) && option.kind === name);
  return kind(wanted) ?? kind(fallback) ?? null;
}
