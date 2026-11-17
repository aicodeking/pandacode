// What a hook sees of a tool call, and how an answer travels back to the harness (runtime phase R5, slice R0502).
// The browser preview runs no harness. This module is the preview's twin of
// src-tauri/src/extensions/runtime_hook_payload.rs: the same input fields (complete input up to 1 MiB that fits the
// 2 MiB hook frame, else a code-point-safe preview), the same `hooks.input` chunks (256 KiB, UTF-8 byte cursors), the
// same per-run call and request book, and the same rendering of an answer (reason, rewritten input, deciding package)
// for a package provider, an ACP agent and Claude Code. No DOM, no IPC.

export type Json = null | boolean | number | string | Json[] | { [key: string]: Json };
type Obj = { [key: string]: Json };

export const SCHEMA_VERSION = 1;
export const COMPLETE_BYTES = 1 << 20;
export const PREVIEW_BYTES = 1 << 20;
export const CHUNK_BYTES = 256 << 10;
export const FRAME_BYTES = 2 << 20;
export const FRAME_DEPTH = 64;
export const FRAME_NODES = 131_072;
export const ENVELOPE_BYTES = 64 << 10;
const ENVELOPE_DEPTH = 4;
const ENVELOPE_NODES = 1_024;
export const REASON_BYTES = 4_096;
const CALLS_PER_RUN = 256;
const REQUESTS_PER_RUN = 64;

const encoder = new TextEncoder();
const decoder = new TextDecoder();
const isObject = (value: unknown): value is Obj => typeof value === 'object' && value !== null && !Array.isArray(value);
const utf8 = (text: string): number => encoder.encode(text).length;

/** Depth and node count of a JSON value (a scalar is depth 1 and one node). */
export function shape(value: Json): { depth: number; nodes: number } {
  if (Array.isArray(value) || isObject(value)) {
    let depth = 1; let nodes = 1;
    for (const child of Array.isArray(value) ? value : Object.values(value)) { const inner = shape(child); depth = Math.max(depth, inner.depth + 1); nodes += inner.nodes; }
    return { depth, nodes };
  }
  return { depth: 1, nodes: 1 };
}

/** Whether a whole hook frame (payload or `hooks.input` result, with its envelope) fits the endpoint budget. */
export function frameCheck(frame: Json): 'LimitExceeded' | null {
  const measured = shape(frame);
  if (measured.depth > FRAME_DEPTH || measured.nodes > FRAME_NODES) return 'LimitExceeded';
  return utf8(JSON.stringify(frame)) > FRAME_BYTES ? 'LimitExceeded' : null;
}

/** Bytes a code point takes once written inside a JSON string. */
function escaped(code: number): number {
  if (code === 0x22 || code === 0x5c || code === 0x0a || code === 0x0d || code === 0x09 || code === 0x08 || code === 0x0c) return 2;
  if (code < 0x20) return 6;
  return code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
}

/** The preview of a serialization: at most 1 MiB, cut back to a code point, short enough to keep the frame within 2 MiB. */
export function preview(text: string): string {
  const budget = FRAME_BYTES - ENVELOPE_BYTES;
  let bytes = 0; let written = 2; let end = 0;
  for (const character of text) {
    const code = character.codePointAt(0) as number;
    const width = code < 0x80 ? 1 : code < 0x800 ? 2 : code < 0x10000 ? 3 : 4;
    if (bytes + width > PREVIEW_BYTES) break;
    const cost = escaped(code);
    if (written + cost > budget) break;
    bytes += width; written += cost; end += character.length;
  }
  return text.slice(0, end);
}

export type InputFields =
  | { inputBytes: number; inputComplete: true; input: Json }
  | { inputBytes: number; inputComplete: false; inputPreview: string };

/** The input fields of a `HookCall`. */
export function inputFields(input: Json, text = JSON.stringify(input)): InputFields {
  const bytes = utf8(text);
  const measured = bytes <= COMPLETE_BYTES ? shape(input) : { depth: Infinity, nodes: Infinity };
  if (bytes <= COMPLETE_BYTES && measured.depth + ENVELOPE_DEPTH <= FRAME_DEPTH && measured.nodes + ENVELOPE_NODES <= FRAME_NODES) return { inputBytes: bytes, inputComplete: true, input };
  return { inputBytes: bytes, inputComplete: false, inputPreview: preview(text) };
}

export type DenyReason = 'answer' | 'steer' | 'none';
export interface Support { denyReason: DenyReason; rewriteInput: boolean }
export const BARE: Support = { denyReason: 'none', rewriteInput: false };
export const can = (support: Support): string[] => ['approve', 'deny', 'ask', ...(support.rewriteInput ? ['rewriteInput'] : [])];

/** What each built-in harness's permission answer can carry. */
export function builtinSupport(provider: string): Support {
  if (['claude', 'glm', 'mimo', 'alibaba'].includes(provider)) return { denyReason: 'answer', rewriteInput: true };
  if (['pi', 'omp', 'codex', 'opencode', 'devin'].includes(provider)) return { denyReason: 'steer', rewriteInput: false };
  return BARE;
}
/** What an ACP agent declared it reads: `agentCapabilities._meta.pandacode.permissionAnswer`. */
export function acpSupport(initializeResult: Json): Support {
  const capabilities = isObject(initializeResult) && isObject(initializeResult.agentCapabilities) ? initializeResult.agentCapabilities : {};
  const meta = isObject(capabilities._meta) && isObject(capabilities._meta.pandacode) && isObject(capabilities._meta.pandacode.permissionAnswer) ? capabilities._meta.pandacode.permissionAnswer : {};
  return { denyReason: meta.reason === true ? 'answer' : 'none', rewriteInput: meta.updatedInput === true };
}
/** What a package handler provider's `approval` event said it can take. */
export function providerSupport(event: Json): Support {
  const declared = isObject(event) ? event.denyReason : undefined;
  return { denyReason: declared === 'none' || declared === 'steer' ? declared : 'answer', rewriteInput: isObject(event) && Array.isArray(event.can) && event.can.includes('rewriteInput') };
}

export interface Answer { approved: boolean; reason?: string; input?: Json; decidedBy?: string }
const PACKAGE = /^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/;
/** Parses `{ approved, reason?, input?, decidedBy? }` strictly; throws the native error text. */
export function parseAnswer(value: Json): Answer {
  if (!isObject(value)) throw new Error('InvalidShape: an answer is an object');
  if (Object.keys(value).some(key => !['approved', 'reason', 'input', 'decidedBy'].includes(key))) throw new Error('InvalidShape: an answer has an unknown field');
  if (typeof value.approved !== 'boolean') throw new Error('InvalidShape: approved must be true or false');
  const answer: Answer = { approved: value.approved };
  for (const name of ['reason', 'decidedBy'] as const) {
    const text = value[name];
    if (text === undefined || text === null) continue;
    if (typeof text !== 'string') throw new Error(`InvalidShape: ${name} must be text`);
    answer[name] = text;
  }
  if (value.input !== undefined) answer.input = value.input;
  validateAnswer(answer);
  return answer;
}
export function validateAnswer(answer: Answer): void {
  if (answer.reason !== undefined) {
    if (!answer.reason.trim() || answer.reason.includes('\0')) throw new Error('InvalidShape: a reason is non-empty text');
    if (utf8(answer.reason) > REASON_BYTES) throw new Error('LimitExceeded: a reason is at most 4,096 bytes');
  }
  if (answer.input !== undefined) {
    if (!answer.approved) throw new Error('InvalidShape: a rewritten input comes only with an approval');
    if (utf8(JSON.stringify(answer.input)) > COMPLETE_BYTES) throw new Error('LimitExceeded: a rewritten input is at most 1 MiB');
  }
  if (answer.decidedBy !== undefined && (answer.decidedBy.length > 160 || !PACKAGE.test(answer.decidedBy))) throw new Error('InvalidShape: decidedBy is a package id');
}

interface Call { run: string; harness: string; project: string | null; bytes: Uint8Array | null; text: string | null; sealed: boolean; finished: boolean; holds: number; order: number }
type Pending = { kind: 'approval'; call: string | null; support: Support; answer: Answer | null } | { kind: 'question'; decidedBy: string | null };
export type ChunkResult = { schemaVersion: 1; text: string; cursor: number; nextCursor: number | null; totalBytes: number };
type Failure = 'NotFound' | 'StaleContext' | 'InvalidShape';

/** The per-run book of calls and requests (one per preview; the native one is process-wide). */
export class HookPayloads {
  private calls = new Map<string, Call>();
  private byHarness = new Map<string, string>();
  private requests = new Map<string, { pending: Pending; order: number }>();
  private serial = 0;
  private key = (run: string, id: string) => JSON.stringify([run, id]);

  /** Records the complete input of a harness call; a later record replaces it until a hook saw it. */
  record(run: string, project: string | null, harnessCall: string, input: Json): { callId: string; fields: InputFields } {
    for (const id of [run, harnessCall]) if (!id || id.length > 256 || /[\u0000-\u001f\u007f]/.test(id)) throw new Error('InvalidShape');
    const text = JSON.stringify(input);
    const key = this.key(run, harnessCall);
    const known = this.byHarness.get(key);
    const existing = known === undefined ? undefined : this.calls.get(known);
    if (known !== undefined && existing) {
      if (existing.sealed || existing.finished || existing.text === null) return { callId: known, fields: existing.text === null ? inputFields(null) : inputFields(JSON.parse(existing.text), existing.text) };
      existing.text = text; existing.bytes = encoder.encode(text);
      if (project !== null) existing.project = project;
      this.bound(run);
      return { callId: known, fields: inputFields(input, text) };
    }
    const callId = `call-${crypto.randomUUID()}`;
    this.calls.set(callId, { run, harness: harnessCall, project, text, bytes: encoder.encode(text), sealed: false, finished: false, holds: 0, order: ++this.serial });
    this.byHarness.set(key, callId);
    this.bound(run);
    return { callId, fields: inputFields(input, text) };
  }
  private bound(run: string): void {
    for (;;) {
      const owned = [...this.calls.entries()].filter(([, call]) => call.run === run);
      if (owned.length <= CALLS_PER_RUN) return;
      const victim = owned.filter(([, call]) => call.holds === 0).sort(([, a], [, b]) => Number(a.text !== null) - Number(b.text !== null) || a.order - b.order)[0];
      if (!victim) return;
      this.calls.delete(victim[0]); this.byHarness.delete(this.key(victim[1].run, victim[1].harness));
    }
  }
  callId(run: string, harnessCall: string): string | null { return this.byHarness.get(this.key(run, harnessCall)) ?? null; }
  scope(callId: string): { run: string; project: string | null } | null { const call = this.calls.get(callId); return call ? { run: call.run, project: call.project } : null; }
  /** The payload's input fields of a live call, fixing its serialization. */
  payload(callId: string): InputFields | Failure {
    const call = this.calls.get(callId);
    if (!call) return 'NotFound';
    if (call.text === null) return 'StaleContext';
    call.sealed = true;
    return inputFields(JSON.parse(call.text), call.text);
  }
  /** A `HookCall`: base facts plus `schemaVersion`, `callId` and the input fields, checked against the frame budget. */
  hookCall(base: Obj, callId: string): Obj | Failure | 'LimitExceeded' {
    const fields = this.payload(callId);
    if (typeof fields === 'string') return fields;
    const { input: _input, inputPreview: _preview, inputComplete: _complete, inputBytes: _bytes, ...rest } = base;
    const call = { ...rest, schemaVersion: SCHEMA_VERSION, callId, ...fields } as Obj;
    return frameCheck(call) ?? call;
  }
  finish(run: string, harnessCall: string): void {
    const id = this.byHarness.get(this.key(run, harnessCall)); const call = id === undefined ? undefined : this.calls.get(id);
    if (!call) return;
    call.finished = true;
    if (call.holds === 0) { call.text = null; call.bytes = null; }
  }
  retain(callId: string): Failure | null {
    const call = this.calls.get(callId);
    if (!call) return 'NotFound';
    if (call.text === null) return 'StaleContext';
    call.holds += 1; call.sealed = true; return null;
  }
  release(callId: string): void {
    const call = this.calls.get(callId);
    if (!call) return;
    call.holds = Math.max(0, call.holds - 1);
    if (call.finished && call.holds === 0) { call.text = null; call.bytes = null; }
  }
  /** One chunk of a call's serialization (`panda.hooks.input`). */
  read(callId: string, cursor: number): ChunkResult | Failure {
    const call = this.calls.get(callId);
    if (!call) return 'NotFound';
    if (call.bytes === null) return 'StaleContext';
    call.sealed = true;
    const bytes = call.bytes; const total = bytes.length;
    const boundary = (at: number) => at === total || (bytes[at] & 0xc0) !== 0x80;
    if (!Number.isInteger(cursor) || cursor < 0 || cursor > total || !boundary(cursor)) return 'InvalidShape';
    let end = Math.min(cursor + CHUNK_BYTES, total);
    while (!boundary(end)) end -= 1;
    return { schemaVersion: 1, text: decoder.decode(bytes.subarray(cursor, end)), cursor, nextCursor: end === total ? null : end, totalBytes: total };
  }
  /** The service's `hooks.input` request `{ callId, cursor }`, strictly. */
  serve(params: Json): ChunkResult | Failure {
    if (!isObject(params) || Object.keys(params).length !== 2 || typeof params.callId !== 'string' || !params.callId || params.callId.length > 256 || typeof params.cursor !== 'number') return 'InvalidShape';
    return this.read(params.callId, params.cursor);
  }

  openApproval(run: string, requestId: string, harnessCall: string | null, support: Support): string | null {
    const call = harnessCall === null ? null : this.callId(run, harnessCall);
    this.requests.set(this.key(run, requestId), { pending: { kind: 'approval', call, support, answer: null }, order: ++this.serial });
    this.boundRequests(run);
    return call;
  }
  openQuestion(run: string, requestId: string): void {
    this.requests.set(this.key(run, requestId), { pending: { kind: 'question', decidedBy: null }, order: ++this.serial });
    this.boundRequests(run);
  }
  private boundRequests(run: string): void {
    const owned = [...this.requests.entries()].filter(([key]) => JSON.parse(key)[0] === run).sort(([, a], [, b]) => a.order - b.order);
    for (const [key] of owned.slice(0, Math.max(0, owned.length - REQUESTS_PER_RUN))) this.requests.delete(key);
  }
  support(run: string, requestId: string): Support | null {
    const pending = this.requests.get(this.key(run, requestId))?.pending;
    return pending?.kind === 'approval' ? pending.support : null;
  }
  requestCall(run: string, requestId: string): string | null {
    const pending = this.requests.get(this.key(run, requestId))?.pending;
    return pending?.kind === 'approval' ? pending.call : null;
  }
  /** Attaches an answer's details; throws `StaleContext` or `UnsupportedCapability` (nothing attached) like the native one. */
  attach(run: string, requestId: string, answer: Answer): void {
    validateAnswer(answer);
    const request = this.requests.get(this.key(run, requestId));
    if (!request) throw new Error('StaleContext: the request is no longer open');
    if (request.pending.kind !== 'approval') throw new Error('InvalidShape: this request is a question');
    if (answer.input !== undefined && !request.pending.support.rewriteInput) throw new Error('UnsupportedCapability: this harness cannot run a rewritten input; the call was not approved');
    request.pending.answer = answer;
  }
  attachQuestion(run: string, requestId: string, decidedBy: string): void {
    if (!PACKAGE.test(decidedBy)) throw new Error('InvalidShape: decidedBy is a package id');
    const request = this.requests.get(this.key(run, requestId));
    if (!request) throw new Error('StaleContext: the request is no longer open');
    if (request.pending.kind !== 'question') throw new Error('InvalidShape: this request is an approval');
    request.pending.decidedBy = decidedBy;
  }
  /** Claims the answer as the decision `approved` is applied; details that disagree with it are dropped. */
  take(run: string, requestId: string, approved: boolean): Answer {
    const key = this.key(run, requestId); const pending = this.requests.get(key)?.pending;
    this.requests.delete(key);
    return pending?.kind === 'approval' && pending.answer && pending.answer.approved === approved ? pending.answer : { approved };
  }
  takeQuestion(run: string, requestId: string): string | null {
    const key = this.key(run, requestId); const pending = this.requests.get(key)?.pending;
    this.requests.delete(key);
    return pending?.kind === 'question' ? pending.decidedBy : null;
  }
  close(run: string, requestId: string): void { this.requests.delete(this.key(run, requestId)); }
  forgetRun(run: string): void {
    for (const [id, call] of this.calls) if (call.run === run) { this.calls.delete(id); this.byHarness.delete(this.key(run, call.harness)); }
    for (const key of [...this.requests.keys()]) if (JSON.parse(key)[0] === run) this.requests.delete(key);
  }
}

/** `ProviderInput` of a package handler provider. */
export function providerInput(answer: Answer): Obj {
  return { kind: 'approval', approved: answer.approved, ...(answer.reason !== undefined ? { reason: answer.reason } : {}), ...(answer.input !== undefined ? { input: answer.input } : {}), ...(answer.decidedBy !== undefined ? { decidedBy: answer.decidedBy } : {}) };
}
/** The `_meta.pandacode` of an ACP permission result, with only what the agent declared it reads. */
export function acpMeta(answer: Answer, support: Support): Obj | null {
  const meta: Obj = {};
  if (support.denyReason === 'answer') {
    if (answer.reason !== undefined) meta.reason = answer.reason;
    if (answer.decidedBy !== undefined) meta.decidedBy = answer.decidedBy;
  }
  if (support.rewriteInput && answer.input !== undefined) meta.updatedInput = answer.input;
  return Object.keys(meta).length ? { pandacode: meta } : null;
}
export function acpChoice(options: readonly Json[], approved: boolean): Obj | null {
  const [wanted, fallback] = approved ? ['allow_once', 'allow_always'] : ['reject_once', 'reject_always'];
  const find = (kind: string) => options.find((option): option is Obj => isObject(option) && option.kind === kind);
  return find(wanted) ?? find(fallback) ?? null;
}
/** The `result` of an ACP `session/request_permission` answer. */
export function acpPermissionResult(options: readonly Json[], answer: Answer, support: Support): Obj {
  const option = acpChoice(options, answer.approved);
  if (!option) return { outcome: { outcome: 'cancelled' } };
  const meta = acpMeta(answer, support);
  return { outcome: { outcome: 'selected', optionId: option.optionId }, ...(meta ? { _meta: meta } : {}) };
}
/** The `response` of a Claude Code `can_use_tool` answer. */
export function claudePermissionResponse(original: Json, answer: Answer, decline: string): Obj {
  return answer.approved ? { behavior: 'allow', updatedInput: answer.input ?? original } : { behavior: 'deny', message: answer.reason ?? decline };
}
/** Whether an ACP permission request is a structured question. */
export function acpStructuredQuestion(request: Json): boolean {
  const options = isObject(request) && isObject(request.params) && Array.isArray(request.params.options) ? request.params.options : [];
  return options.filter(option => isObject(option) && option.kind === 'allow_once').length > 1
    || options.some(option => isObject(option) && typeof option.optionId === 'string' && /^q\d+_opt_/.test(option.optionId));
}
/** The core `questions` list of an ACP structured question. */
export function acpQuestion(request: Json): Obj[] | null {
  if (!acpStructuredQuestion(request) || !isObject(request) || !isObject(request.params)) return null;
  const params = request.params;
  const tool = isObject(params.toolCall) ? params.toolCall : {};
  const title = typeof tool.title === 'string' && tool.title.trim() ? [...tool.title].slice(0, 4000).join('') : 'The agent asks a question.';
  const options = (params.options as Json[]).filter((option): option is Obj => isObject(option) && option.kind === 'allow_once')
    .map(option => (typeof option.name === 'string' ? option.name : typeof option.optionId === 'string' ? option.optionId : null)).filter((label): label is string => label !== null)
    .slice(0, 20).map(label => ({ label: [...label].slice(0, 200).join(''), description: '' }));
  return options.length ? [{ id: 'q0', header: '', question: title, isOther: false, isSecret: false, options }] : null;
}
/** The `result` of an ACP structured question answered with core's response. */
export function acpQuestionResult(request: Json, response: Json): Obj {
  const answers = isObject(response) && isObject(response.answers) && isObject(response.answers.q0) && Array.isArray(response.answers.q0.answers) ? response.answers.q0.answers : [];
  const label = typeof answers[0] === 'string' ? answers[0] : null;
  const options = isObject(request) && isObject(request.params) && Array.isArray(request.params.options) ? request.params.options : [];
  const option = label === null ? undefined : options.find((entry): entry is Obj => isObject(entry) && entry.kind === 'allow_once' && (typeof entry.name === 'string' ? entry.name : entry.optionId) === label);
  return option ? { outcome: { outcome: 'selected', optionId: option.optionId } } : { outcome: { outcome: 'cancelled' } };
}
const by = (decidedBy: string | null | undefined, cancelled: boolean): Json => (cancelled ? 'cancelled' : decidedBy ? { package: decidedBy } : 'user');
/** The normalized `approval.resolved` event. */
export function approvalResolved(taskId: string, requestId: string, callId: string | null, answer: Answer | null): Obj {
  return { requestId, taskId, approved: answer?.approved ?? false, by: by(answer?.decidedBy, answer === null), ...(callId ? { callId } : {}), ...(answer?.reason !== undefined ? { reason: answer.reason } : {}) };
}
/** The normalized `question.resolved` event; `answers` is core's validated response, null when cancelled. */
export function questionResolved(taskId: string, requestId: string, decidedBy: string | null, answers: Obj | null): Obj {
  return { requestId, taskId, by: by(decidedBy, answers === null), ...(answers ? { answers: answers.answers } : {}) };
}
