// Webview and preview twin of src-tauri/src/extensions/runtime_hook_context.rs (runtime phase R5, slice R0504): how
// the host folds the returns of `prompt.submit`, `tool.after` and `compaction` (each package asked in turn; context
// needs harness.hooks.context, a rewrite, a block, a result rewrite and a compaction answer need harness.hooks.decide,
// a note needs ui.presentation; a compaction answer is taken only where `can` lists it), the message as sent, and the
// transcript's reading of it: the attributed context and note blocks fold into one collapsible block under what the
// user wrote. The same rules in the same order as the native folds; the shared fixture is
// tests/fixtures/extensions/runtime-hook-context/returns.json.
import { preview, type Json } from './runtime-hook-payload.ts';

type Obj = { [key: string]: Json };
const object = (value: Json | undefined): value is Obj => value !== null && typeof value === 'object' && !Array.isArray(value);

export const DECIDE = 'harness.hooks.decide';
export const CONTEXT = 'harness.hooks.context';
export const PRESENTATION = 'ui.presentation';
export const CHAIN_MS = 60_000;
export const CONTEXT_BYTES = 64 * 1024;
export const PROMPT_BYTES = 1024 * 1024;
export const REASON_BYTES = 4_096;
export const NOTE_BYTES = 512;
export const INSTRUCTIONS_BYTES = 16 * 1024;
export const SUMMARY_BYTES = 256 * 1024;
export const OUTPUT_BYTES = 1024 * 1024;
export const CONTEXT_HEADING = 'Extension context from';
export const NOT_WRITTEN = '(not written by the user):';
/** The heading of R0402's next-send notes (`runtime_tasks_messages::render_context`). */
export const NOTES_HEADING = 'Notes added by extensions for this message (not written by the user):';

const bytes = (text: string) => new TextEncoder().encode(text).length;
const oneLine = (text: string) => text.split(/\s+/).filter(Boolean).join(' ');

export interface Step { owner: string; name: string; onFailure?: string; grants: readonly string[]; answer: { value: Json } | { error: string } }
export interface Receipt { owner: string; applied: boolean; code?: string; refused?: Record<string, string> }

class Shape extends Error { constructor(readonly code: string) { super(code); } }
function boundedText(value: Json | undefined, limit: number, allowEmpty: boolean): string {
  if (typeof value !== 'string') throw new Shape('InvalidShape');
  if (bytes(value) > limit) throw new Shape('LimitExceeded');
  if (!allowEmpty && !value.trim()) throw new Shape('InvalidShape');
  return value;
}
function reasonOf(value: Json | undefined): string {
  if (!object(value) || Object.keys(value).length !== 1) throw new Shape('InvalidShape');
  return oneLine(boundedText(value.reason, REASON_BYTES, false));
}
/** The return's present keys, `null` for an empty return; an unknown key or a non-object is `InvalidShape`. */
function fields(value: Json, keys: readonly string[]): Obj | null {
  if (value === null || value === undefined) return null;
  if (!object(value)) throw new Shape('InvalidShape');
  if (Object.keys(value).some(key => !keys.includes(key))) throw new Shape('InvalidShape');
  const present = Object.fromEntries(Object.entries(value).filter(([, entry]) => entry !== null && entry !== undefined)) as Obj;
  return Object.keys(present).length ? present : null;
}
class Draft {
  applied = false; refused: Record<string, string> = {};
  constructor(readonly owner: string) {}
  refuse(key: string, code: string) { if (!(key in this.refused)) this.refused[key] = code; }
  finish(): Receipt {
    const receipt: Receipt = { owner: this.owner, applied: this.applied };
    const refused = Object.keys(this.refused).sort();
    if (!this.applied && refused.length) receipt.code = this.refused[refused[0]];
    if (refused.length) receipt.refused = Object.fromEntries(refused.map(key => [key, this.refused[key]]));
    return receipt;
  }
}
const invalid = (owner: string, code: string): Receipt => ({ owner, applied: false, code });
const holds = (step: Step, permission: string) => step.grants.includes(permission);

export interface Fold { payload(base: Obj): Obj; step(step: Step): void; stopped(): boolean; receipts: Receipt[] }

// ---- prompt.submit ----------------------------------------------------------------------------------------------

export interface Blocked { by: string; reason: string; failed: boolean }
export const blockedMessage = (blocked: Blocked) => blocked.failed ? `Not sent: ${blocked.reason}` : `Not sent: blocked by ${blocked.by}. ${blocked.reason}`;

export class PromptFold implements Fold {
  contexts: [string, string][] = []; rewrittenBy: string[] = []; notes: [string, string][] = []; blocked: Blocked | null = null; receipts: Receipt[] = [];
  constructor(public text: string) {}
  payload(base: Obj): Obj { return { ...base, text: preview(this.text) }; }
  stopped() { return this.blocked !== null; }
  private failed(step: Step, code: string) {
    if (step.onFailure === 'deny') this.blocked = { by: step.name, reason: `${step.name} did not answer (${code}).`, failed: true };
  }
  step(step: Step): void {
    if ('error' in step.answer) return this.failed(step, step.answer.error);
    let parsed: { block?: string; prompt?: string; context?: string; note?: string } | null;
    try {
      const present = fields(step.answer.value, ['context', 'prompt', 'block', 'note']);
      if (!present) return;
      parsed = {
        block: 'block' in present ? reasonOf(present.block) : undefined,
        prompt: 'prompt' in present ? boundedText(present.prompt, PROMPT_BYTES, false) : undefined,
        context: 'context' in present ? boundedText(present.context, CONTEXT_BYTES, true) : undefined,
        note: 'note' in present ? oneLine(boundedText(present.note, NOTE_BYTES, true)) : undefined,
      };
    } catch (error) {
      const code = error instanceof Shape ? error.code : 'InvalidShape';
      this.receipts.push(invalid(step.owner, code)); this.failed(step, code); return;
    }
    const receipt = new Draft(step.owner);
    if (parsed.note) { if (holds(step, PRESENTATION)) { this.notes.push([step.name, parsed.note]); receipt.applied = true; } else receipt.refuse('note', 'PermissionDenied'); }
    if (parsed.block !== undefined) {
      if (holds(step, DECIDE)) { this.blocked = { by: step.name, reason: parsed.block, failed: false }; receipt.applied = true; this.receipts.push(receipt.finish()); return; }
      receipt.refuse('block', 'PermissionDenied');
    }
    if (parsed.prompt !== undefined) { if (holds(step, DECIDE)) { this.text = parsed.prompt; this.rewrittenBy.push(step.name); receipt.applied = true; } else receipt.refuse('prompt', 'PermissionDenied'); }
    if (parsed.context !== undefined && parsed.context.trim()) { if (holds(step, CONTEXT)) { this.contexts.push([step.name, parsed.context.trim()]); receipt.applied = true; } else receipt.refuse('context', 'PermissionDenied'); }
    this.receipts.push(receipt.finish());
  }
}

/** The message as sent: the text, then each package's context and the waiting notes as attributed blocks. */
export function compose(text: string, contexts: readonly (readonly [string, string])[], notesBlock: string | null): string {
  let message = text;
  for (const [name, context] of contexts) {
    const body = context.split('\n\n').map(part => part.trim()).filter(Boolean).join('\n');
    message += `\n\n${CONTEXT_HEADING} ${oneLine(name)} ${NOT_WRITTEN}\n${body}`;
  }
  if (notesBlock) message += `\n\n${notesBlock}`;
  return message;
}

// ---- tool.after -------------------------------------------------------------------------------------------------

export class ToolAfterFold implements Fold {
  output: Json | undefined = undefined; by: string[] = []; notes: [string, string][] = []; receipts: Receipt[] = [];
  constructor(readonly can: readonly string[], readonly original: Json) {}
  payload(base: Obj): Obj { return { ...base, can: [...this.can], ...(this.output !== undefined ? { output: this.output } : {}) }; }
  stopped() { return false; }
  step(step: Step): void {
    if ('error' in step.answer) return;
    let present: Obj | null; let note: string | undefined;
    try {
      present = fields(step.answer.value, ['output', 'note']);
      if (!present) return;
      note = 'note' in present ? oneLine(boundedText(present.note, NOTE_BYTES, true)) : undefined;
      if ('output' in present && bytes(JSON.stringify(present.output)) > OUTPUT_BYTES) throw new Shape('LimitExceeded');
    } catch (error) { this.receipts.push(invalid(step.owner, error instanceof Shape ? error.code : 'InvalidShape')); return; }
    const receipt = new Draft(step.owner);
    if ('output' in present) {
      if (!this.can.includes('rewriteResult')) receipt.refuse('output', 'UnsupportedCapability');
      else if (!holds(step, DECIDE)) receipt.refuse('output', 'PermissionDenied');
      else { this.output = present.output; this.by.push(step.name); receipt.applied = true; }
    }
    if (note) { if (holds(step, PRESENTATION)) { this.notes.push([step.name, note]); receipt.applied = true; } else receipt.refuse('note', 'PermissionDenied'); }
    this.receipts.push(receipt.finish());
  }
}

// ---- compaction -------------------------------------------------------------------------------------------------

/** `cancel` always (the host does not send the command), `instructions` where `/compact` takes them; never `summary`. */
export const compactionCan = (harness: string): string[] => ['claude', 'glm', 'mimo', 'alibaba'].includes(harness) ? ['cancel', 'instructions'] : ['cancel'];

export class CompactionFold implements Fold {
  cancel: [string, string] | null = null; instructions: [string, string][] = []; summaries: [string, string][] = []; receipts: Receipt[] = [];
  constructor(readonly can: readonly string[]) {}
  payload(base: Obj): Obj { return { ...base, can: [...this.can] }; }
  stopped() { return this.cancel !== null; }
  step(step: Step): void {
    if ('error' in step.answer) return;
    let cancel: string | undefined, instructions: string | undefined, summary: string | undefined;
    try {
      const present = fields(step.answer.value, ['summary', 'instructions', 'cancel']);
      if (!present) return;
      cancel = 'cancel' in present ? reasonOf(present.cancel) : undefined;
      instructions = 'instructions' in present ? boundedText(present.instructions, INSTRUCTIONS_BYTES, false) : undefined;
      summary = 'summary' in present ? boundedText(present.summary, SUMMARY_BYTES, false) : undefined;
    } catch (error) { this.receipts.push(invalid(step.owner, error instanceof Shape ? error.code : 'InvalidShape')); return; }
    const receipt = new Draft(step.owner);
    const gate = (key: string) => {
      if (!this.can.includes(key)) { receipt.refuse(key, 'UnsupportedCapability'); return false; }
      if (!holds(step, DECIDE)) { receipt.refuse(key, 'PermissionDenied'); return false; }
      return true;
    };
    const cancelOk = cancel !== undefined && gate('cancel');
    const instructionsOk = instructions !== undefined && gate('instructions');
    const summaryOk = summary !== undefined && gate('summary');
    if (cancelOk) { this.cancel = [step.name, cancel!]; receipt.applied = true; this.receipts.push(receipt.finish()); return; }
    if (instructionsOk) { this.instructions.push([step.name, oneLine(instructions!)]); receipt.applied = true; }
    if (summaryOk) { this.summaries.push([step.name, summary!]); receipt.applied = true; }
    this.receipts.push(receipt.finish());
  }
}

/** The tool name without its server prefix (`mcp__pandacode__x`, `pandacode.x`). */
export function baseName(name: string): string {
  const stripped = name.startsWith('mcp__') ? name.slice(5).split('__').pop() ?? name : name;
  return stripped.split(/[.:/]/).pop() ?? stripped;
}

// ---- The transcript ---------------------------------------------------------------------------------------------

export interface HookBlock { kind: 'context' | 'notes'; by: string[]; text: string }
const TRAILING = new RegExp(String.raw`\n\n(?=${CONTEXT_HEADING} [^\n]{1,200} \(not written by the user\):\n|Notes added by extensions for this message \(not written by the user\):)`);

function parseBlock(raw: string): HookBlock {
  if (raw.startsWith(NOTES_HEADING)) {
    const lines = raw.slice(NOTES_HEADING.length).replace(/^\n/, '');
    const by = [...new Set([...lines.matchAll(/^- \[([^\]\n]{1,128})\]/gm)].map(match => match[1]))];
    return { kind: 'notes', by, text: lines };
  }
  const newline = raw.indexOf('\n');
  const heading = newline < 0 ? raw : raw.slice(0, newline);
  const name = heading.slice(CONTEXT_HEADING.length + 1, heading.length - NOT_WRITTEN.length - 1);
  return { kind: 'context', by: [name], text: newline < 0 ? '' : raw.slice(newline + 1) };
}

/**
 * Splits a sent user message into what the user wrote and the blocks extensions added: a leading notes block (a
 * message a package sent, R0402) and the trailing context and notes blocks this slice appends.
 */
export function splitHookContext(content: string): { typed: string; blocks: HookBlock[] } {
  const blocks: HookBlock[] = [];
  let rest = content;
  if (rest.startsWith(NOTES_HEADING)) {
    const end = rest.indexOf('\n\n');
    blocks.push(parseBlock(end < 0 ? rest : rest.slice(0, end)));
    rest = end < 0 ? '' : rest.slice(end + 2);
  }
  const index = rest.search(TRAILING);
  if (index >= 0) {
    for (const raw of rest.slice(index + 2).split(TRAILING)) blocks.push(parseBlock(raw));
    rest = rest.slice(0, index);
  }
  return { typed: rest, blocks };
}

/** One collapsible block naming every package that added to the message; empty when none did. */
export function hookContextHtml(blocks: readonly HookBlock[], escape: (text: string) => string): string {
  if (!blocks.length) return '';
  const names = [...new Set(blocks.flatMap(block => block.by))];
  const summary = `Context added by ${names.length ? names.join(', ') : 'extensions'}`;
  const body = blocks.map(block => `<section data-hook-context="${block.kind}"><strong>${escape(block.kind === 'notes' ? 'Notes' : `From ${block.by[0] ?? 'an extension'}`)}</strong><pre>${escape(block.text)}</pre></section>`).join('');
  return `<details class="message-context hook-context"><summary>${escape(summary)}</summary>${body}</details>`;
}
