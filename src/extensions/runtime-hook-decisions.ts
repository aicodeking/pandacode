// Webview and preview twin of src-tauri/src/extensions/runtime_hook_decisions.rs (runtime phase R5, slice R0505): how
// the host resolves `tool.before` returns (approve, deny with a reason, ask, rewrite the arguments) from the packages
// that hold harness.hooks.decide, what each call can carry (`can`, with approve and rewriteInput dropped where the
// task's mode or sandbox holds the call), when a `full` launch asks at the harness and answers at the host, and what
// the host then does with the request. The same rules in the same order as the native module; the shared fixtures are
// tests/fixtures/extensions/runtime-hook-decisions/ (decisions.json, modes.json, scenarios.json). It runs no harness.
import { can as sourceCan, COMPLETE_BYTES, type Answer, type Json, type Support } from './runtime-hook-payload.ts';
import { DECIDE, NOTE_BYTES, PRESENTATION, REASON_BYTES, type Step } from './runtime-hook-context.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);
const bytes = (text: string) => new TextEncoder().encode(text).length;
const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

export const EVENT = 'tool.before';
export const PERMISSION_REQUEST = 'permissionRequest';
export const ASK_AT_HOST_SOURCE = 'askAtHost';
/** Harnesses whose `full` can be launched ask-at-host (no companion, the asking mode selects no sandbox). */
export const ASK_AT_HOST = ['opencode', 'kilo', 'cline', 'kimi', 'grok', 'commandcode', 'github-copilot', 'hermes', 'zcode'] as const;
export const DECISIONS = ['approve', 'deny', 'ask', 'rewrite'] as const;

/** The mode itself holds what the harness asks about: a sandbox escalation, or what no mode approves (Claude Code family in full). */
export const modeHolds = (harness: string, mode: string): boolean =>
  ['codex', 'deepseek', 'muse'].includes(harness) || (['claude', 'glm', 'mimo', 'alibaba'].includes(harness) && mode === 'full');
/** `HookCall.can` of one call. */
export function callCan(support: Support, source: string, harness: string, mode: string, kind: string, lasting: boolean): string[] {
  let can = sourceCan(support);
  if (source === ASK_AT_HOST_SOURCE) can = can.filter(entry => entry !== 'rewriteInput');
  const held = modeHolds(harness, mode) || lasting || (mode === 'plan' && !['read', 'search', 'fetch'].includes(kind));
  return held ? can.filter(entry => entry !== 'approve' && entry !== 'rewriteInput') : can;
}
/** The `can` a permission request offers in `mode` for a call the mode allows (the capability report). */
export const modeCan = (support: Support, harness: string, mode: string): string[] => callCan(support, PERMISSION_REQUEST, harness, mode, 'read', false);
export const launchAsks = (mode: string, harness: string): boolean => mode === 'full' && (ASK_AT_HOST as readonly string[]).includes(harness);
export const route = (deciders: number, askAtHost: boolean, auto: boolean): 'chain' | 'approve' | 'pass' =>
  deciders > 0 ? 'chain' : askAtHost && auto ? 'approve' : 'pass';

export type Decision =
  | { decision: 'approve'; reason: string | null }
  | { decision: 'deny'; reason: string }
  | { decision: 'ask'; reason: string | null }
  | { decision: 'rewrite'; input: Json };
export interface Parsed { decision: Decision; note: string | null }
class Invalid extends Error { readonly code: string; constructor(code: string) { super(code); this.code = code; } }

/** A `ToolDecision`, strictly, in the native order: keys, reason, note, decision, input. */
export function parseDecision(value: Json | undefined): Parsed | null {
  if (value === null || value === undefined) return null;
  if (!object(value)) throw new Invalid('InvalidShape');
  if (Object.keys(value).some(key => !['decision', 'reason', 'note', 'input'].includes(key))) throw new Invalid('InvalidShape');
  let reason: string | null = null;
  if (value.reason !== null && value.reason !== undefined) {
    if (typeof value.reason !== 'string') throw new Invalid('InvalidShape');
    if (bytes(value.reason) > REASON_BYTES) throw new Invalid('LimitExceeded');
    reason = oneLine(value.reason);
    if (!reason) throw new Invalid('InvalidShape');
  }
  let note: string | null = null;
  if (value.note !== null && value.note !== undefined) {
    if (typeof value.note !== 'string') throw new Invalid('InvalidShape');
    if (bytes(value.note) > NOTE_BYTES) throw new Invalid('LimitExceeded');
    note = oneLine(value.note) || null;
  }
  const input = value.input === null || value.input === undefined ? null : value.input;
  let decision: Decision;
  switch (value.decision) {
    case 'approve': decision = { decision: 'approve', reason }; break;
    case 'deny': if (reason === null) throw new Invalid('InvalidShape'); decision = { decision: 'deny', reason }; break;
    case 'ask': decision = { decision: 'ask', reason }; break;
    case 'rewrite':
      if (input === null) throw new Invalid('InvalidShape');
      if (bytes(JSON.stringify(input)) > COMPLETE_BYTES) throw new Invalid('LimitExceeded');
      decision = { decision: 'rewrite', input };
      break;
    default: throw new Invalid('InvalidShape');
  }
  if (input !== null && decision.decision !== 'rewrite') throw new Invalid('InvalidShape');
  return { decision, note };
}

export interface Verdict { owner: string; name: string; reason: string | null; failed: boolean }
type Role = 'approve' | 'rewrite' | 'ask' | 'deny' | null;
export interface DecisionReceipt { owner: string; applied: boolean; code?: string; overriddenBy?: string; refused?: Record<string, string> }
interface Draft { owner: string; applied: boolean; code?: string; refused: Record<string, string>; role: Role }
const finish = (draft: Draft): Draft => {
  if (!draft.applied && draft.code === undefined) {
    const first = Object.keys(draft.refused).sort()[0];
    if (first !== undefined) draft.code = draft.refused[first];
  }
  return draft;
};
const refuse = (draft: Draft, key: string, code: string) => { if (!(key in draft.refused)) draft.refused[key] = code; };

export type Outcome =
  | { kind: 'none' }
  | { kind: 'approve'; by: Verdict; input: Json | null }
  | { kind: 'deny'; by: Verdict }
  | { kind: 'ask'; by: Verdict };

/** The fold of `tool.before`: a deny ends the chain and wins, an ask wins over an approve, the first approve applies, rewrites accumulate. */
export class DecisionFold {
  input: Json | null = null;
  approved: Verdict | null = null;
  rewrittenBy: Verdict[] = [];
  asked: Verdict | null = null;
  denied: Verdict | null = null;
  notes: [string, string][] = [];
  private drafts: Draft[] = [];
  readonly can: readonly string[];
  constructor(can: readonly string[]) { this.can = can; }
  stopped(): boolean { return this.denied !== null; }
  payload(base: Obj): Obj {
    const payload: Obj = { ...base, can: [...this.can] };
    if (this.input !== null) {
      delete payload.inputPreview;
      payload.input = this.input;
      payload.inputComplete = true;
      payload.inputBytes = bytes(JSON.stringify(this.input));
    }
    return payload;
  }
  private failed(step: Step, code: string) {
    const verdict: Verdict = { owner: step.owner, name: step.name, reason: `${step.name} did not answer (${code}).`, failed: true };
    if (step.onFailure === 'deny') this.denied = verdict;
    else if (step.onFailure === 'ask' && this.asked === null) this.asked = verdict;
  }
  step(step: Step): void {
    if ('error' in step.answer) { this.failed(step, step.answer.error); return; }
    let parsed: Parsed | null;
    try { parsed = parseDecision(step.answer.value); } catch (error) {
      const code = error instanceof Invalid ? error.code : 'InvalidShape';
      this.drafts.push({ owner: step.owner, applied: false, code, refused: {}, role: null });
      this.failed(step, code);
      return;
    }
    if (parsed === null) return;
    const draft: Draft = { owner: step.owner, applied: false, refused: {}, role: null };
    if (parsed.note !== null) {
      if (step.grants.includes(PRESENTATION)) this.notes.push([step.name, parsed.note]); else refuse(draft, 'note', 'PermissionDenied');
    }
    if (!step.grants.includes(DECIDE)) { refuse(draft, 'decision', 'PermissionDenied'); this.drafts.push(finish(draft)); return; }
    const verdict = (reason: string | null): Verdict => ({ owner: step.owner, name: step.name, reason, failed: false });
    const decision = parsed.decision;
    if (decision.decision === 'deny') { this.denied = verdict(decision.reason); draft.applied = true; draft.role = 'deny'; }
    else if (decision.decision === 'ask') { if (this.asked === null) this.asked = verdict(decision.reason); draft.applied = true; draft.role = 'ask'; }
    else if (decision.decision === 'approve') {
      if (!this.can.includes('approve')) refuse(draft, 'decision', 'UnsupportedCapability');
      else { if (this.approved === null) this.approved = verdict(decision.reason); draft.applied = true; draft.role = 'approve'; }
    } else if (!this.can.includes('rewriteInput')) refuse(draft, 'decision', 'UnsupportedCapability');
    else { this.input = decision.input; this.rewrittenBy.push(verdict(null)); draft.applied = true; draft.role = 'rewrite'; }
    this.drafts.push(finish(draft));
  }
  outcome(): Outcome {
    if (this.denied) return { kind: 'deny', by: this.denied };
    if (this.asked) return { kind: 'ask', by: this.asked };
    const by = this.approved ?? this.rewrittenBy[this.rewrittenBy.length - 1] ?? null;
    return by ? { kind: 'approve', by, input: this.input } : { kind: 'none' };
  }
  /** The receipts once the chain is resolved: an overridden approve, rewrite or ask names the winner. */
  settled(): DecisionReceipt[] {
    const winner = this.denied ? { owner: this.denied.owner, deny: true } : this.asked ? { owner: this.asked.owner, deny: false } : null;
    return this.drafts.map(draft => {
      const receipt: DecisionReceipt = { owner: draft.owner, applied: draft.applied };
      if (draft.code !== undefined) receipt.code = draft.code;
      const overridden = draft.role === 'approve' || draft.role === 'rewrite' || (draft.role === 'ask' && winner?.deny === true);
      if (winner && overridden && draft.owner !== winner.owner) { receipt.applied = false; receipt.overriddenBy = winner.owner; }
      if (Object.keys(draft.refused).length) receipt.refused = { ...draft.refused };
      return receipt;
    });
  }
}

export type Action = { kind: 'approve'; answer: Answer } | { kind: 'deny'; answer: Answer } | { kind: 'prompt'; note: string | null };
/** What the host does with an outcome; `auto`: ask-at-host may answer this request itself. */
export function action(outcome: Outcome, askAtHost: boolean, auto: boolean): Action {
  switch (outcome.kind) {
    case 'deny': return { kind: 'deny', answer: { approved: false, ...(outcome.by.reason !== null ? { reason: outcome.by.reason } : {}), decidedBy: outcome.by.owner } };
    case 'approve': return { kind: 'approve', answer: { approved: true, ...(outcome.by.reason !== null ? { reason: outcome.by.reason } : {}), ...(outcome.input !== null ? { input: outcome.input } : {}), decidedBy: outcome.by.owner } };
    case 'ask': {
      const { reason, failed, name } = outcome.by;
      return { kind: 'prompt', note: reason !== null && failed ? `${reason} Decide yourself.` : reason !== null ? `${name} asks you to decide: ${reason}` : `${name} asks you to decide.` };
    }
    default: return askAtHost && auto ? { kind: 'approve', answer: { approved: true } } : { kind: 'prompt', note: null };
  }
}
