import { escape } from './dom.ts';
import { clip } from './tool-text.ts';
import { blockedReason } from './tool-trace-outcome.ts';

/* Claude Code wraps a refused or invalid call's result in `<tool_use_error>…</tool_use_error>`. A `Blocked: …` one is a
 * harness rule saying no before anything ran (`Blocked: sleep 60 followed by: cat a.txt. To wait …`): the row reads
 * `Blocked: read a.txt`, drawn quiet rather than as a failure, and the card says why. Pure and escaped. */

const TOOL_ERROR = /<\/?tool_use_error>/g;
const BLOCKED = /^\s*<tool_use_error>\s*Blocked:/;
/** A Claude Code PreToolUse hook said no (`PreToolUse:Bash hook error: [guard.sh]: …`): blocked before it ran, like a rule. */
const HOOK = /^\s*(?:<tool_use_error>\s*)?(?:Hook\s+)?PreToolUse:[^\s:]+[\s:]/;
/** The hook's own lead (`PreToolUse:Bash hook error: [guard.sh]: `), so the reason starts at the hook's words. */
const HOOK_LEAD = /^(?:Hook\s+)?PreToolUse:[^\s:]+(?: hook(?: error)?)?:?\s*(?:\[[^\]\n]{0,400}\]:?\s*)?/;
/** The user said no to the call (Claude Code's permission prompt, a harness's approval): `Denied: …`, quiet like a block. */
const DENIED = [
  /^\s*(?:<tool_use_error>\s*)?Permission to use \S+ .{0,4000}?has been denied\b/s,
  /^\s*(?:<tool_use_error>\s*)?The user doesn't want to proceed with this tool use\b/,
  /^\s*(?:<tool_use_error>\s*)?User (?:refused|rejected|denied)\b/i,
];
const FAILED_LEAD = /^Couldn't /;
const REASON_LIMIT = 400;

/** The result without its `<tool_use_error>` tags. */
export function stripToolError(output: string): string {
  return output.replace(TOOL_ERROR, '').trim();
}

/** A call the user turned down before it ran. */
export function isDeniedOutput(status: string, output: string): boolean {
  return status === 'failed' && DENIED.some(pattern => pattern.test(output));
}

/** A call refused before it ran: by a harness rule (`Blocked: …`) or by the user (a denied permission). */
export function isBlockedOutput(status: string, output: string): boolean {
  return status === 'failed' && (BLOCKED.test(output) || HOOK.test(output) || isDeniedOutput(status, output));
}

/** `Couldn't read` → `Blocked: read` (or `Denied: read`); a verb with no `Couldn't` lead (already an outcome) reads `Blocked: <verb>`. */
export function blockedVerb(failed: string, lead = 'Blocked'): string {
  const prefix = `${lead}: `;
  return FAILED_LEAD.test(failed) ? failed.replace(FAILED_LEAD, prefix) : `${prefix}${failed.charAt(0).toLowerCase()}${failed.slice(1)}`;
}

/** Harness boilerplate after a refusal's reason: instructions to the agent, never news to the reader. */
const PERMISSION = /^Permission to use (\S+) .*has been denied\b/s;
/** A sentence ends at `. ` before a capital, never inside `e.g.`/`eg.` or a code span. */
const SENTENCE_END = /(?<!\be\.g|\beg|\bi\.e)\.(?=\s+[A-Z]|\s*$)/;

/** The first sentence of a text, skipping periods inside backticks. */
export function firstSentence(text: string): string {
  const masked = text.replace(/`[^`\n]*`/g, span => '_'.repeat(span.length));
  const end = SENTENCE_END.exec(masked);
  return (end ? text.slice(0, end.index + 1) : text).trim();
}

/** The refusal's one-line reason: tags, the `Blocked:` lead, the blocked command (the row's) and the harness's
 *  instructions to the agent (`STOP what you are doing…`) stripped; a permission denial names its tool. */
export function refusalReason(output: string): string {
  const text = stripToolError(output).replace(HOOK_LEAD, '').replace(/^Blocked:\s*/, '');
  const permission = PERMISSION.exec(text);
  if (permission) return `Permission to use ${permission[1]} was denied.`;
  return firstSentence(blockedReason(text));
}

/** The refusal as a quiet note from its first whole sentence. */
export function blockedNoteHtml(output: string, partial: string): string {
  const reason = refusalReason(output);
  if (!reason) return '';
  const clipped = reason.length > REASON_LIMIT ? partial : '';
  return `${clipped}<p class="tool-trace-note is-blocked">${escape(clip(reason, REASON_LIMIT))}</p>`;
}

/* --- Interrupted calls: the turn ended (or the user stopped it) before the tool reported --------------------------- */

/** PandaCode's markers for a tool that never reported, matched with string searches (a `\n*` pattern before them would
 *  rescan every newline run). */
const INTERRUPTED_TAILS = ['[PandaCode was interrupted before this tool reported a result.]', '[The turn ended before this tool reported a result.]'];
const USER_INTERRUPT = /^\s*(?:<tool_use_error>\s*)?\[Request interrupted by user(?: for tool use)?\]/;

function interruptTail(output: string): string | undefined {
  const end = output.trimEnd();
  return INTERRUPTED_TAILS.find(tail => end.endsWith(tail));
}

/** A call that never reported a result because the turn stopped: neither a success nor a failure. */
export function isInterruptedOutput(status: string, output: string): boolean {
  return status !== 'running' && (interruptTail(output) !== undefined || USER_INTERRUPT.test(output.slice(0, 200)));
}

/** What the call printed before it was interrupted, without the marker. */
export function withoutInterrupt(output: string): string {
  if (USER_INTERRUPT.test(output.slice(0, 200))) return '';
  const tail = interruptTail(output);
  return tail ? output.trimEnd().slice(0, -tail.length).trimEnd() : output;
}

export const INTERRUPTED_NOTE = '<p class="tool-trace-note is-interrupted">Interrupted before it reported a result.</p>';

/* --- Why an edit or write failed: the error line, short ------------------------------------------------------------ */

const EDIT_REASONS: [RegExp, (match: RegExpExecArray) => string][] = [
  [/String to replace not found|old_string was not found|String not found in file/i, () => 'string to replace not found'],
  [/Found (\d+) matches of the string to replace/i, match => `${match[1]} matches of the string to replace`],
  [/has not been read yet|file has not been read/i, () => 'file has not been read yet'],
  [/modified since (?:it was )?read/i, () => 'file changed since it was read'],
  [/ENOSPC|no space left on device/i, () => 'no space left on device'],
  [/No changes to make/i, () => 'old and new text are the same'],
  [/EACCES|permission denied/i, () => 'permission denied'],
];
const REASON_WORDS = 60;

/** `string to replace not found`: why a failed edit or write wrote nothing, for its row; '' without an error line. */
export function editFailureReason(output: string): string {
  const text = stripToolError(output);
  if (!text) return '';
  for (const [pattern, say] of EDIT_REASONS) {
    const match = pattern.exec(text.slice(0, 2000));
    if (match) return say(match);
  }
  const line = firstSentence(text.split('\n', 1)[0].replace(/^Error:\s*/i, '')).replace(/\.$/, '');
  return clip(line.charAt(0).toLowerCase() + line.slice(1), REASON_WORDS);
}

/** The error's first line for a failed edit's card, above the diff it meant to make. */
export function editFailureHtml(output: string): string {
  const line = stripToolError(output).split('\n', 1)[0].trim();
  return line ? `<p class="tool-trace-note is-error tool-trace-why">${escape(clip(line, REASON_LIMIT))}</p>` : '';
}

/** Claude Code's answer to a call of a tool the session does not have (`No such tool available: bash. …`): the tool's
 *  name, else ''. The agent misnamed a tool; nothing ran and nothing failed. */
const UNAVAILABLE = /^\s*(?:<tool_use_error>\s*)?(?:Error:\s*)?No such tool available: ([^\s.<]{1,120})/;
export function unavailableToolName(status: string, output: string): string {
  return status === 'failed' ? UNAVAILABLE.exec(output)?.[1] ?? '' : '';
}
