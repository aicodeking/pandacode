// Webview and preview twin of src-tauri/src/extensions/runtime_model_call.rs (runtime phase R7, slice R0704):
// `panda.models.call`, one bounded model answer for a package service. The same option checks, the same per-package
// admission (two run, eight wait, the next is refused), the same timeout (the wait and the run), cancellation, revoke and
// sign-out, the same usage log (the package is named, the prompt and the answer never are). The hidden run is handed the
// options and the package name only: no tool host, no hook registry, no session and no task, so it can neither call a
// model tool nor trigger a package hook. Everything here is for fault isolation and predictability (ADR-0005).
import type { Json } from './runtime-hook-payload.ts';

export const PERMISSION = 'models.call';
export const MAX_RUNNING = 2;
export const MAX_WAITING = 8;
export const DEFAULT_TIMEOUT_MS = 60_000;
export const MIN_TIMEOUT_MS = 1_000;
export const MAX_TIMEOUT_MS = 600_000;
export const MAX_PROMPT_BYTES = 256 * 1024;
export const MAX_SYSTEM_BYTES = 64 * 1024;
export const MAX_ANSWER_BYTES = 256 * 1024;
export const MAX_LABEL = 128;
export const MAX_CALL_ID = 64;
export const MAX_USAGE = 500;
const FIELDS = ['prompt', 'system', 'harness', 'model', 'effort', 'projectId', 'taskId', 'timeoutMs'];
const encoder = new TextEncoder();
const size = (text: string) => encoder.encode(text).length;

export type ModelCallCode = 'InvalidShape' | 'LimitExceeded' | 'Timeout' | 'Cancelled' | 'HostUnavailable' | 'PermissionDenied' | 'UnsupportedCapability' | 'NotFound' | 'DuplicateId';
export interface CallError { code: ModelCallCode; message: string }
const fail = (code: ModelCallCode, message: string): { ok: false; error: CallError } => ({ ok: false, error: { code, message } });

export interface Options { prompt: string; system?: string; harness?: string; model?: string; effort?: string; projectId?: string; taskId?: string; timeoutMs: number }

/** The options of one call, or the first refusal (the checks run in the order of the native `parse`). */
export function parseOptions(options: Json | undefined): { ok: true; options: Options } | { ok: false; error: CallError } {
  if (options === null || typeof options !== 'object' || Array.isArray(options)) return fail('InvalidShape', 'The options must be an object.');
  const fields = options as unknown as { [key: string]: Json };
  const unknown = Object.keys(fields).find(key => !FIELDS.includes(key));
  if (unknown) return fail('InvalidShape', `${unknown} is not an option of models.call.`);
  const prompt = fields.prompt;
  if (typeof prompt !== 'string' || !prompt.trim()) return fail('InvalidShape', 'prompt must be a non-empty string.');
  if (size(prompt) > MAX_PROMPT_BYTES) return fail('LimitExceeded', `The prompt is larger than ${MAX_PROMPT_BYTES / 1024} KiB.`);
  let system: string | undefined;
  if (fields.system !== undefined && fields.system !== null) {
    if (typeof fields.system !== 'string') return fail('InvalidShape', 'system must be a string.');
    if (size(fields.system) > MAX_SYSTEM_BYTES) return fail('LimitExceeded', `The system text is larger than ${MAX_SYSTEM_BYTES / 1024} KiB.`);
    system = fields.system;
  }
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  if (fields.timeoutMs !== undefined && fields.timeoutMs !== null) {
    const value = fields.timeoutMs;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < MIN_TIMEOUT_MS || value > MAX_TIMEOUT_MS) return fail('InvalidShape', `timeoutMs must be an integer from ${MIN_TIMEOUT_MS} to ${MAX_TIMEOUT_MS}.`);
    timeoutMs = value;
  }
  const out: Options = { prompt, timeoutMs };
  if (system !== undefined) out.system = system;
  for (const key of ['harness', 'model', 'effort', 'projectId', 'taskId'] as const) {
    const value = fields[key];
    if (value === undefined || value === null) continue;
    if (typeof value !== 'string' || !value.trim() || [...value].length > MAX_LABEL) return fail('InvalidShape', `${key} must be a short non-empty string.`);
    out[key] = value;
  }
  return { ok: true, options: out };
}

/** What the hidden run is handed. By construction there is no tool host, no hook registry and no session here. */
export interface RunRequest { owner: string; packageName: string; options: Options }
export interface RunOutput { text: string; harness: string; model: string; input?: number; output?: number }
/** The provider run path (or a stand-in): rejects with a code `HostUnavailable`, `UnsupportedCapability` or `NotFound`. `signal` aborts the run (ends its process). */
export type Run = (request: RunRequest, signal: AbortSignal) => Promise<RunOutput>;
export interface Wiring {
  /** `{ version, name }` of an enabled, trusted package outside safe mode. */
  packageOf: (owner: string) => { version: string; name: string } | undefined;
  holds: (owner: string, version: string, permission: string, project: string | null) => boolean;
  run?: Run;
}
export interface Answer { text: string; harness: string; model: string; usage?: { input?: number; output?: number } }
export interface Usage { kind: 'models.call'; owner: string; package: string; harness: string; model: string; input: number | null; output: number | null; taskId: string | null }
export interface Counters { running: number; waiting: number; live: number }

type Reason = 'Cancelled' | 'PermissionDenied' | 'HostUnavailable';
interface Live { harness: string | undefined; stop: (reason: Reason) => void }
interface Lane { running: number; queue: Array<() => void>; }

export class ModelCalls {
  private readonly lanes = new Map<string, Lane>();
  private readonly live = new Map<string, Live>();
  private readonly log: Usage[] = [];
  private readonly wiring: Wiring;
  constructor(wiring: Wiring) { this.wiring = wiring; }
  private key = (owner: string, id: string) => `${owner}\u0000${id}`;
  private lane(owner: string): Lane { let lane = this.lanes.get(owner); if (!lane) { lane = { running: 0, queue: [] }; this.lanes.set(owner, lane); } return lane; }

  counters(owner: string): Counters {
    const lane = this.lane(owner);
    return { running: lane.running, waiting: lane.queue.length, live: [...this.live.keys()].filter(key => key.startsWith(`${owner}\u0000`)).length };
  }
  usage(owner?: string): Usage[] { return this.log.filter(record => owner === undefined || record.owner === owner); }

  private end(owner: string, matching: (call: Live) => boolean, reason: Reason): number {
    let ended = 0;
    for (const [key, call] of this.live) if (key.startsWith(`${owner}\u0000`) && matching(call)) { call.stop(reason); ended += 1; }
    return ended;
  }
  /** The service's `AbortSignal` of one call, or the user's cancel. */
  cancel(owner: string, callId: string): boolean { const call = this.live.get(this.key(owner, callId)); if (!call) return false; call.stop('Cancelled'); return true; }
  /** The grant was revoked, the package disabled or its service stopped: its calls end with `PermissionDenied`. */
  revoked(owner: string): number { return this.end(owner, () => true, 'PermissionDenied'); }
  /** A harness signed out: the calls that use it, or default to one that may be it, end with `HostUnavailable`. */
  signedOut(harness: string): number {
    const owners = new Set([...this.live.keys()].map(key => key.split('\u0000')[0]));
    let ended = 0;
    for (const owner of owners) ended += this.end(owner, call => call.harness === undefined || call.harness === harness, 'HostUnavailable');
    return ended;
  }

  /** One call of `owner`; resolves to the answer or the error the package reads. */
  async call(owner: string, callId: string, params: Json | undefined): Promise<{ ok: true; answer: Answer } | { ok: false; error: CallError }> {
    if (!callId || callId.length > MAX_CALL_ID) return fail('InvalidShape', 'The call id must be 1 to 64 characters.');
    const parsed = parseOptions(params);
    if (!parsed.ok) return parsed;
    const { options } = parsed;
    const pkg = this.wiring.packageOf(owner);
    if (!pkg) return fail('HostUnavailable', 'The package is not enabled.');
    if (!this.wiring.holds(owner, pkg.version, PERMISSION, null)) return fail('PermissionDenied', `${pkg.name} does not hold ${PERMISSION}.`);
    const run = this.wiring.run;
    if (!run) return fail('UnsupportedCapability', 'This build has no hidden-run path for a one-shot model call.');
    const key = this.key(owner, callId);
    if (this.live.has(key)) return fail('DuplicateId', 'A call with this id is already in flight.');
    const lane = this.lane(owner);
    const abort = new AbortController();
    let stopped: Reason | undefined;
    let wake: (() => void) | undefined;
    const stopping = new Promise<void>(resolve => { wake = resolve; });
    this.live.set(key, { harness: options.harness, stop: reason => { stopped ??= reason; wake?.(); abort.abort(); } });
    let timer: ReturnType<typeof setTimeout> | undefined;
    const timedOut = new Promise<'timeout'>(resolve => { timer = setTimeout(() => resolve('timeout'), options.timeoutMs); });
    const ended = (reason: Reason) => reason === 'Cancelled' ? fail('Cancelled', 'The call was cancelled.')
      : reason === 'PermissionDenied' ? fail('PermissionDenied', `${pkg.name} no longer holds ${PERMISSION}, or its service stopped.`)
      : fail('HostUnavailable', 'The harness signed out while the call was in flight.');
    let slot = false;
    let queued: (() => void) | undefined;
    try {
      if (lane.running < MAX_RUNNING) { lane.running += 1; slot = true; }
      else {
        if (lane.queue.length >= MAX_WAITING) return fail('LimitExceeded', `${pkg.name} already has ${MAX_RUNNING} calls running and ${MAX_WAITING} waiting.`);
        const turn = new Promise<'turn'>(resolve => { queued = () => { lane.running += 1; slot = true; resolve('turn'); }; lane.queue.push(queued); });
        const first = await Promise.race([turn, stopping.then(() => 'stop' as const), timedOut]);
        if (first === 'timeout') return fail('Timeout', `The model did not answer within ${options.timeoutMs} ms.`);
        if (first === 'stop') return ended(stopped!);
      }
      const request: RunRequest = { owner, packageName: pkg.name, options };
      const ran = run(request, abort.signal).then(output => ({ output }), (error: unknown) => ({ error }));
      const first = await Promise.race([ran, stopping.then(() => 'stop' as const), timedOut]);
      if (first === 'timeout') { abort.abort(); return fail('Timeout', `The model did not answer within ${options.timeoutMs} ms.`); }
      if (first === 'stop') return ended(stopped!);
      if ('error' in first) {
        const code = String((first.error as { code?: string } | undefined)?.code ?? first.error);
        if (code === 'UnsupportedCapability') return fail(code, 'The harness has no hidden-run path for a one-shot call.');
        if (code === 'NotFound') return fail(code, 'The project, task, harness or model is not known.');
        return fail('HostUnavailable', code === 'HostUnavailable' ? 'The harness is signed out or not installed.' : `The harness could not answer (${code}).`);
      }
      const { output } = first;
      if (size(output.text) > MAX_ANSWER_BYTES) return fail('LimitExceeded', `The answer is larger than ${MAX_ANSWER_BYTES / 1024} KiB.`);
      this.log.push({ kind: 'models.call', owner, package: pkg.name, harness: output.harness, model: output.model, input: output.input ?? null, output: output.output ?? null, taskId: options.taskId ?? null });
      if (this.log.length > MAX_USAGE) this.log.splice(0, this.log.length - MAX_USAGE);
      const usage: Answer['usage'] = {};
      if (output.input !== undefined) usage.input = output.input;
      if (output.output !== undefined) usage.output = output.output;
      return { ok: true, answer: { text: output.text, harness: output.harness, model: output.model, ...(Object.keys(usage).length ? { usage } : {}) } };
    } finally {
      if (timer) clearTimeout(timer);
      this.live.delete(key);
      if (queued) { const at = lane.queue.indexOf(queued); if (at >= 0) lane.queue.splice(at, 1); }
      if (slot) { lane.running -= 1; lane.queue.shift()?.(); }
    }
  }
}
