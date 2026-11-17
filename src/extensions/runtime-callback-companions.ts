/** Preview/fixture twin. SDK-derived Claude, GLM, MiMo and synthetic Pi/omp are not live qualification. */
import { CompanionLifetime, negotiateCompanion, type CompanionLease, type CompanionProfile, type InstalledCompanionApi } from './runtime-companion-lifetime.ts';
import type { Json } from './runtime-hook-payload.ts';
type Obj = { [key: string]: Json };
const obj = (v: Json | undefined): Obj => v && typeof v === 'object' && !Array.isArray(v) ? v : {};
export const CALLBACK_EVENTS = ['PreToolUse', 'PostToolUse', 'UserPromptSubmit', 'PreCompact', 'PostCompact', 'Stop'] as const;
export function callbackProfile(harness: string): CompanionProfile | null {
  const pi = ['pi', 'omp'].includes(harness);
  if (!pi && !['claude', 'glm', 'mimo', 'alibaba'].includes(harness)) return null;
  return { id: `${harness}.callback.v1`, harness, versions: [pi ? 'synthetic-bridge-v1' : 'sdk-derived'], api: pi ? 'pandacode.pi.structured.v1' : 'claude.initialize.hooks.v1', protocol: 1, evidence: 'sourceFeasible' };
}
export function translateCallback(event: string, answer: Obj, pi = false): Obj {
  if (pi) {
    if (event === 'PreToolUse') {
      if (answer.decision === 'deny') return { block: true, reason: answer.reason ?? 'Declined by an extension.' };
      if (answer.decision === 'rewrite') return { input: answer.input ?? null };
      if (answer.decision === 'ask') return { ask: true, reason: answer.reason ?? null };
      if (answer.decision === 'approve') return { approved: true };
    }
    if (event === 'PostToolUse' && 'output' in answer) return { output: answer.output! };
    if (event === 'UserPromptSubmit' && typeof answer.context === 'string') return { context: answer.context };
    if (event === 'PreCompact' && answer.cancel === true) return { cancel: true };
    if (event === 'PreCompact' && typeof answer.summary === 'string') return { summary: answer.summary };
    return {};
  }
  if (event === 'PreToolUse') {
    const decisions: Record<string, string> = { deny: 'deny', ask: 'ask', approve: 'allow', rewrite: 'allow' };
    const decision = decisions[String(answer.decision)];
    if (!decision) return {};
    const out: Obj = { hookEventName: event, permissionDecision: decision };
    if (typeof answer.reason === 'string') out.permissionDecisionReason = answer.reason;
    if (answer.decision === 'rewrite' && answer.input && typeof answer.input === 'object' && !Array.isArray(answer.input)) out.updatedInput = answer.input;
    return { hookSpecificOutput: out };
  }
  if (event === 'PostToolUse' && 'output' in answer) return { hookSpecificOutput: { hookEventName: event, updatedToolOutput: answer.output! } };
  if (event === 'UserPromptSubmit' && typeof answer.context === 'string') return { hookSpecificOutput: { hookEventName: event, additionalContext: answer.context } };
  if (event === 'PreCompact' && answer.cancel === true) return { continue: false, stopReason: answer.reason ?? 'Declined by an extension.' };
  if (event === 'PreCompact' && typeof answer.instructions === 'string') return { hookSpecificOutput: { hookEventName: event, additionalContext: answer.instructions } };
  return {};
}
export interface CallbackInvocation { id: string; event: string; input: Obj; call: string }
export class CallbackSession {
  private host: CompanionLifetime;
  private lease: CompanionLease;
  private pi: boolean;
  private closed = false;
  private pending = new Map<string, CallbackInvocation>();
  private seen = new Set<string>();
  constructor(host: CompanionLifetime, lease: CompanionLease, installed: InstalledCompanionApi) {
    if (negotiateCompanion(installed, callbackProfile(installed.harness)).code) throw new Error('UnsupportedCapability');
    this.host = host; this.lease = { ...lease }; this.pi = ['pi', 'omp'].includes(installed.harness); this.check();
  }
  private check(): void { if (this.closed || !this.host.current(this.lease, this.lease)) { this.pending.clear(); throw new Error('StaleContext'); } }
  registration(): Obj {
    this.check();
    if (this.pi) return { protocol: 1, events: [...CALLBACK_EVENTS] };
    return Object.fromEntries(CALLBACK_EVENTS.map(event => [event, [{ hookCallbackIds: [`pandacode:${event}`], timeout: 65 }]])) as Obj;
  }
  receive(frame: Obj): CallbackInvocation {
    this.check();
    const request = obj(frame.request); const rawInput = this.pi ? frame.input : request.input;
    if (!rawInput || typeof rawInput !== 'object' || Array.isArray(rawInput)) throw new Error('InvalidShape');
    const input = obj(rawInput);
    const id = this.pi ? frame.id : frame.request_id;
    const callback = typeof request.callback_id === 'string' ? request.callback_id.replace(/^pandacode:/, '') : '';
    const event = this.pi ? frame.event : callback;
    if (this.pi ? frame.protocol !== 1 : frame.type !== 'control_request' || request.subtype !== 'hook_callback' || request.callback_id !== `pandacode:${event}` || event !== input.hook_event_name) throw new Error('InvalidShape');
    if (typeof id !== 'string' || !id || id.length > 256 || !((CALLBACK_EVENTS as readonly Json[]).includes(event!))) throw new Error('InvalidShape');
    if (this.seen.has(id)) throw new Error('Conflict');
    if (this.seen.size >= 4096 || this.pending.size >= 64 || new TextEncoder().encode(JSON.stringify(frame)).length > 2 * 1024 * 1024) throw new Error('LimitExceeded');
    this.seen.add(id);
    const invocation = { id, event: String(event), input, call: String(input.tool_use_id ?? request.tool_use_id ?? id) };
    this.pending.set(id, invocation); return invocation;
  }
  reply(id: string, answer: Obj): Obj {
    this.check();
    if (new TextEncoder().encode(JSON.stringify(answer)).length > 2 * 1024 * 1024) throw new Error('LimitExceeded');
    const invocation = this.pending.get(id); if (!invocation) throw new Error('StaleContext'); this.pending.delete(id);
    const output = translateCallback(invocation.event, answer, this.pi);
    return this.pi ? { type: 'extension_ui_response', id, value: JSON.stringify(output) } : { type: 'control_response', response: { subtype: 'success', request_id: id, response: output } };
  }
  close(): void { this.closed = true; this.pending.clear(); }
}
