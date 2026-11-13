import type { Tool, TraceChip, TraceKind } from './tool-trace.ts';
import type { TraceParts } from './tool-trace-intent.ts';
import { lex } from './shell-intent-lex.ts';
import { programName, stripPrefixes } from './shell-intent-base.ts';
import { describeShell } from './shell-intent.ts';
import { ROW_TEXT, basename, clip } from './tool-text.ts';
import { stripToolError } from './tool-trace-errors.ts';
import { blockedCommand, exitCode } from './tool-trace-outcome.ts';
import { shellTrace } from './tool-trace-shell.ts';

/* Shell calls whose outcome is the whole row: a refusal or interruption names the command and never what it would have
 * done (`Denied: [npm] install left-pad`, `Blocked: [sleep] 25 …`, `Interrupted: [npm] test`), a command the harness never
 * started reads `Couldn't start [cat] a.txt`, and one stopped by a signal `Stopped [vite] (terminated)`. Pure. */

const COMMAND_LIMIT = ROW_TEXT;
const CHIP_LIMIT = 32;

/** `+2 more commands`: the steps that followed the one a row names. */
export function moreCommands(count: number): string {
  return count > 0 ? `+${count} more ${count === 1 ? 'command' : 'commands'}` : '';
}

/** `npm install left-pad` → chip `npm` and mono object `install left-pad`, like every other shell row; `+N more commands`
 *  when more steps followed. A step whose program cannot be found keeps the whole step as its object. */
export function commandParts(step: { what: string; more: number }, icon = 'terminal'): Pick<TraceParts, 'chip' | 'object' | 'mono' | 'more'> {
  const what = step.what.trim();
  const words = what.split(/\s+/);
  const program = stripPrefixes(words)[0] ?? '';
  const at = program ? what.indexOf(program) : -1;
  const more = step.more > 0 ? { more: moreCommands(step.more) } : {};
  if (at < 0) return { object: clip(what, COMMAND_LIMIT), mono: true, ...more };
  const rest = what.slice(at + program.length).trim();
  const chip: TraceChip = { icon, label: clip(programName(program), CHIP_LIMIT), title: what };
  return { chip, object: rest ? clip(rest, COMMAND_LIMIT) : '', mono: true, ...more };
}

/** The command's first step and how many steps followed it; the whole line when it does not lex. */
function firstStep(command: string): { what: string; more: number } {
  try {
    const steps = lex(command);
    const first = steps[0]?.text.trim() ?? '';
    if (first) return { what: first, more: steps.length - 1 };
  } catch { /* An unbalanced quote: the line as written. */ }
  return { what: command.trim(), more: 0 };
}

/** `Denied: npm install left-pad`, `Blocked: sleep 25 …`: one rule for every refusal, the object the refused command's
 *  first step (clipped, mono), ` …` when more steps followed it. Without a recorded command, the one the refusal names. */
export function refusedShell(command: string, output: string, refusal: 'Blocked' | 'Denied'): TraceParts | undefined {
  const step = command ? firstStep(command) : blockedCommand(stripToolError(output).replace(/^Blocked:\s*/, ''));
  if (!step?.what) return undefined;
  return { verb: `${refusal}:`, settled: true, ...commandParts(step, 'shield') };
}

/** `Interrupted: [npm] test`: the turn ended before the command reported, quiet like a stop. */
export function interruptedShell(command: string): TraceParts | undefined {
  if (!command) return undefined;
  return { verb: 'Interrupted:', settled: true, ...commandParts(firstStep(command), 'stop'), icon: 'stop', quiet: true };
}

/** The harness says it never started the command: Codex could not spawn its exec process, Claude Code had no disk. */
const HARNESS_UNSTARTED = /^(?:Failed to create unified exec process\b|The command was not started\b)/;
const DISK_FULL = /\bdisk is full\b|\bENOSPC\b/;

/** `Couldn't start [cat] a.txt`, `Couldn't start [npm] run build · disk is full`: nothing ran, so the row names the
 *  command with its intent's icon and no exit badge (Codex records -1). */
export function harnessUnstarted(command: string, output: string): TraceParts | undefined {
  const text = exitCode(stripToolError(output)).body.trim();
  if (!command || !HARNESS_UNSTARTED.test(text)) return undefined;
  const parts = commandParts(firstStep(command), describeShell(command).icon);
  return { verb: "Couldn't start", settled: true, ...parts, icon: 'terminal', ...(DISK_FULL.test(text) ? { reason: 'disk is full' } : {}) };
}

const SIGNALS: Record<number, string> = { 143: 'terminated', 137: 'killed' };
const TIMED_OUT = /\btimed out\b/i;

/** The signal that stopped a shell command (exit 143 SIGTERM, 137 SIGKILL), unless the harness says it timed out. */
function stopSignal(tool: Tool): string | undefined {
  const { code, body } = exitCode(tool.output);
  const signal = code === undefined ? undefined : SIGNALS[code];
  return signal && !TIMED_OUT.test(body.slice(0, 2000)) ? signal : undefined;
}

/** A shell command that something stopped (a server killed when the turn moved on): neither a success nor a failure. */
export function signalStop(tool: Tool, kind: TraceKind): boolean {
  return kind === 'shell' && tool.status !== 'running' && stopSignal(tool) !== undefined;
}

/** `Stopped [server.mjs] (terminated)`: what was running, named by its intent's chip (else its program). */
export function stoppedShell(tool: Tool, command: string): TraceParts | undefined {
  const signal = command ? stopSignal(tool) : undefined;
  if (!signal) return undefined;
  const intent = describeShell(command);
  const label = intent.label && intent.label !== 'shell' ? intent.label : basename(command.split(/\s/, 1)[0] ?? '');
  const chip: TraceChip = { icon: 'stop', label: clip(label, 48), title: command };
  return { verb: 'Stopped', settled: true, chip, object: `(${signal})`, icon: 'stop' };
}

/* --- Commands the harness gave up waiting for: timed out (killed, exit 143) or moved to the background ------------ */

const TIMEOUT = /\bCommand timed out after (\d+(?:\.\d+)?(?:ms|s|m|h)(?: \d+(?:\.\d+)?(?:ms|s|m))*)/i;
const BACKGROUNDED = /^Command did not complete within its [^\n]{1,40}? timeout and was moved to the background\b/;
const SCAN = 2000;
/** A doing that leads into its chip (`Waiting for [server.log]`) takes no `…` between them. */
const LEADS_ON = /\s(?:for|to|in|of|on|at|from|with|into)$/;

/** `5m 0.0s` → `5m`, `45.0s` → `45s`, `1m 30.4s` → `1m 30s`: whole seconds, and a zero tail says nothing. */
export function tidyDuration(text: string): string {
  const whole = text.replace(/(\d+(?:\.\d+)?)s\b/g, (_all, seconds: string) => `${Math.round(Number(seconds))}s`);
  return whole.replace(/(?<=\d[hm]) 0s$/, '');
}

/** What the command was doing, as the row's tail: `Waiting for [server.log] to contain “ready”`. */
function doing(command: string): Partial<TraceParts> & { doing: string } {
  const parts = shellTrace(command, true);
  const { chip, object = '', mono, icon } = parts ?? {};
  return { doing: parts?.verb ?? 'Running', chip, object, mono, icon };
}

/** `Timed out after 5m · Waiting for [server.log] …`: the harness killed it at its limit. A failure, but its exit 143 is
 *  the harness's signal, not the command's answer, so the row carries no exit badge and never reads `Stopped`. */
export function timedOutShell(command: string, output: string): TraceParts | undefined {
  const match = TIMEOUT.exec(exitCode(output).body.slice(0, SCAN));
  if (!command || !match) return undefined;
  const { doing: what, ...parts } = doing(command);
  return { ...parts, verb: `Timed out after ${tidyDuration(match[1])} · ${what}${LEADS_ON.test(what) ? '' : '…'}`, settled: true, object: parts.object ?? '', icon: 'clock' };
}

/** `Moved to background · Running tests [playwright]`: still running when the harness stopped waiting; not a result yet,
 *  so the row says what it was doing (like a timeout), neither in progress nor done. */
export function backgroundedShell(command: string, output: string): TraceParts | undefined {
  if (!command || !BACKGROUNDED.test(output.trimStart().slice(0, SCAN))) return undefined;
  const { doing: what, ...parts } = doing(command);
  return { ...parts, verb: `Moved to background · ${what}`, settled: true, object: parts.object ?? '', icon: 'terminal' };
}
