import { lex } from './shell-intent-lex.ts';
import { programName, stripPrefixes } from './shell-intent-base.ts';
import { ROW_TEXT, clip } from './tool-text.ts';
import { parseFields } from './tool-fields.ts';

/* What a shell call's exit means beyond `failed`: a search that found nothing (grep exits 1), a compound that failed after
 * its lead step, a harness refusal's blocked command and its reason, and a check's error count. Pure. */

const CLAUDE_EXIT = /^Exit code (-?\d+)(?:\n|$)/;
const CODEX_EXIT = /^Exit code: (-?\d+)\n?/;
const TRAILING_EXIT = /(?:^|\n)Exit code:? (-?\d+)\s*$/;
const joined = (...parts: unknown[]): string => parts.filter((part): part is string => typeof part === 'string' && part !== '').join('\n');

/** A shell result's exit code and its output without the harness's exit lines: Claude Code leads a failed Bash result
 *  with `Exit code 2`, Codex with `Exit code: 2`, `Wall time: …` and `Output:`; JSON results carry `exitCode`/`exit_code`
 *  with stdout and stderr; an `Exit code N` closing the text counts too. */
export function exitCode(output: string): { code?: number; body: string } {
  const claude = CLAUDE_EXIT.exec(output);
  if (claude) return { code: Number(claude[1]), body: output.slice(claude[0].length) };
  const codex = CODEX_EXIT.exec(output);
  if (codex) return { code: Number(codex[1]), body: output.slice(codex[0].length).replace(/^Wall time:.*\n?/, '').replace(/^Output:\n?/, '') };
  const json = parseFields(output);
  const code = typeof json.exitCode === 'number' ? json.exitCode : typeof json.exit_code === 'number' ? json.exit_code : undefined;
  if (code !== undefined) return { code, body: joined(json.stdout, json.stderr) };
  const trailing = TRAILING_EXIT.exec(output);
  return trailing ? { code: Number(trailing[1]), body: output.slice(0, trailing.index) } : { body: output };
}

/** Errors that mean the shell could not start the command at all: a full disk, no process to spawn. */
const SPAWN_ERROR = /\b(?:ENOSPC|no space left on device|spawn \S+ ENOENT|posix_spawn|fork: Resource temporarily unavailable)/i;
/** The words a shell or runner prints when it cannot find a program; shared by every never-started check. */
export const NOT_FOUND = /command not found|not found: |no such file or directory|could not determine executable|is not recognized as/i;
/** Only a short output counts, so a command that ran and printed more failed in the usual way. */
export const SHORT_LINES = 3;

/** A failed shell call that never ran: no output at all (not even an exit code), a short output that is only a spawn or
 *  disk error, or one where the shell could not find the command's own program (`missingProgram`). */
export function neverStarted(output: string, command = ''): boolean {
  const { code, body } = exitCode(output);
  const text = body.trim();
  if (!text) return code === undefined;
  if (text.split('\n', SHORT_LINES + 1).length > SHORT_LINES) return false;
  return SPAWN_ERROR.test(text) || missingProgram(command, text) !== undefined;
}

/** The shell's own words for a program it could not find, naming it: zsh `(eval):1: command not found: x`,
 *  `zsh: no such file or directory: ./x`; bash `bash: line 1: x: command not found`, `bash: x: No such file or directory`;
 *  dash `/bin/sh: 1: x: not found`. */
const SHELL_SAYS = String.raw`(?:\(eval\)|(?:[\w.-]*/)?(?:ba|z|da)?sh)(?::(?: line)? ?\d+)?: `;
const MISSING_AFTER = new RegExp(`^${SHELL_SAYS}(?:command not found|no such file or directory): (\\S+)$`, 'i');
const MISSING_BEFORE = new RegExp(`^${SHELL_SAYS}(\\S+?): (?:command not found|not found|no such file or directory)$`, 'i');
/** Steps that only set up the one that matters (`cd repo && timeout 60 npm test`). */
const SETUP = new Set(['cd', 'pushd', 'export', 'set', 'unset', 'source', '.']);
const SHELLS = /^(?:ba|z|da)?sh$/;

/** The names that would start a command's lead step: its wrappers and program (`timeout`, `npx`), and a script a shell
 *  was asked to run (`bash x`). */
function leadNames(command: string): string[] {
  let steps;
  try { steps = lex(command); } catch { return []; }
  const lead = steps.map(step => (step.pipes[0]?.words ?? []).map(word => word.replace(/^\(+/, '')).filter(Boolean))
    .find(words => words.length > 0 && !SETUP.has(words[0]));
  if (!lead) return [];
  const rest = stripPrefixes(lead);
  const names = lead.slice(0, lead.length - rest.length + 1).map(programName);
  return SHELLS.test(names[names.length - 1] ?? '') && rest[1] ? [...names, programName(rest[1])] : names;
}

/** The program a short output says the shell could not find, when it is the command's lead program or a wrapper of it
 *  (`timeout`); undefined otherwise, so `ls: x: No such file or directory` or a later step's missing tool never counts. */
export function missingProgram(command: string, output: string): string | undefined {
  const text = output.trim();
  const shown = text.split('\n', SHORT_LINES + 1);
  if (!command || !text || shown.length > SHORT_LINES) return undefined;
  const first = shown[0].trim();
  const match = MISSING_AFTER.exec(first) ?? MISSING_BEFORE.exec(first);
  const name = match ? programName(match[1]) : '';
  return name && leadNames(command).includes(name) ? name : undefined;
}

const SEARCHERS = /^(?:grep|egrep|fgrep|rg|ag|ack)$/;
const NO_MATCH_EXIT = 1;

const COUNT_FLAG = /^(?:--count|-[A-Za-z]*c[A-Za-z]*)$/;
/** `0`, `a.txt:0`: a counting search's line for a file with no match. */
const ZERO_COUNT = /^(?:[^\n]*:)?0$/;

/** How the last pipe stage of a step searches (`grep`, `rg`, `git grep`), so its exit 1 means it found nothing: `count`
 *  when it prints counts (`grep -c`), whose last line then reads `0`. */
function searchKind(words: string[]): 'search' | 'count' | undefined {
  const [program = '', sub = '', ...rest] = stripPrefixes(words);
  const name = programName(program);
  if (!SEARCHERS.test(name) && !(name === 'git' && sub === 'grep')) return undefined;
  return [sub, ...rest].some(word => COUNT_FLAG.test(word)) ? 'count' : 'search';
}

/** `differ`: a lone `diff`/`cmp` exits 1 when its files differ; `changes`: so does `git diff --exit-code`/`--quiet`. */
function compareKind(words: string[]): 'differ' | 'changes' | undefined {
  const [program = '', sub = '', ...rest] = stripPrefixes(words);
  const name = programName(program);
  if (name === 'diff' || name === 'cmp') return 'differ';
  return name === 'git' && sub === 'diff' && rest.some(word => word === '--exit-code' || word === '--quiet') ? 'changes' : undefined;
}

export type ExitAnswer = 'none' | 'tail' | 'differ' | 'changes';

/** `none`: a lone search that printed nothing (or a lone `grep -c` only zero counts) found no matches. `tail`: a
 *  compound's last step searched (or counted) and found nothing. `differ`/`changes`: a lone comparison found a
 *  difference. A step after `&&`/`||` is skipped: there the 1 may be an earlier step's. */
export function searchFoundNothing(command: string, code: number | undefined, body: string): ExitAnswer | undefined {
  if (code !== NO_MATCH_EXIT || !command) return undefined;
  let steps;
  try { steps = lex(command); } catch { return undefined; }
  const last = steps[steps.length - 1];
  const stage = last?.pipes[last.pipes.length - 1];
  if (steps.length === 1 && last.pipes.length === 1 && stage) {
    const compare = compareKind(stage.words);
    if (compare) return compare;
  }
  const kind = stage ? searchKind(stage.words) : undefined;
  if (!kind) return undefined;
  const lines = body.trim().split('\n');
  if (kind === 'count' && steps.length === 1) return lines.every(line => ZERO_COUNT.test(line.trim())) ? 'none' : undefined;
  if (kind === 'search' && steps.length === 1) return body.trim() ? undefined : 'none';
  // A compound's closing count answers 0 on its last line.
  if (kind === 'count' && !ZERO_COUNT.test(lines[lines.length - 1].trim())) return undefined;
  const before = command.slice(0, command.lastIndexOf(last.text)).trimEnd();
  return /(?:&&|\|\|)$/.test(before) ? undefined : 'tail';
}

/** How many steps `followed by: …` names: its own steps when it lexes, else one. */
function followingSteps(text: string): number {
  if (!text.trim()) return 0;
  try { return Math.max(1, lex(text).length); } catch { return 1; }
}

const FOLLOWED = /^(.+?) followed by: ([\s\S]+?)\.(?:\s+(?=[A-Z])|\s*$)([\s\S]*)$/;

/** `Blocked: sleep 60 followed by: cat a.txt. To wait …` → what was blocked (`sleep 60`), whether more followed it and the
 *  explanation from its first sentence; undefined when the refusal names no command. */
export function blockedCommand(reason: string): { what: string; more: number; why: string } | undefined {
  const match = FOLLOWED.exec(reason.trim());
  return match ? { what: clip(match[1].trim(), ROW_TEXT), more: followingSteps(match[2]), why: match[3].trim() } : undefined;
}

/** The refusal's explanation, starting at a sentence: the blocked command is the row's, so the note starts after it. */
export function blockedReason(reason: string): string {
  const text = blockedCommand(reason)?.why ?? reason.trim();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

const TSC_FOUND = /\bFound (\d+) errors?\b/;
const ESLINT = /✖ \d+ problems? \((\d+) errors?/;
const CARGO = /could not compile .*? due to (\d+) previous errors?/;
const TSC_LINE = /\berror TS\d+:/g;
const RUST_LINE = /^error(?:\[E\d+\])?: (?!could not compile|aborting)/gm;

/** How many errors a typecheck or lint printed (tsc, eslint, cargo/clippy); undefined when it says no count. */
export function errorCount(output: string): number | undefined {
  for (const summary of [TSC_FOUND, ESLINT, CARGO]) {
    const match = summary.exec(output);
    if (match) return Number(match[1]);
  }
  const lines = (output.match(TSC_LINE) ?? []).length || (output.match(RUST_LINE) ?? []).length;
  return lines || undefined;
}

export function errorCountText(count: number): string {
  return `${count} ${count === 1 ? 'error' : 'errors'}`;
}

/** Devin's `Tool` record whose output says it asked for a tool that does not exist: that tool's name. */
export function unknownToolName(name: string, output: string): string {
  return name === 'Tool' ? /^Unknown tool '([^']{1,120})'/.exec(output.trim())?.[1] ?? '' : '';
}

/** Nouns for a verb that only repeats its chip (`Cleaned [git clean]`): what the command acted on. */
const ACTED_ON: Record<string, string> = { 'git clean': 'untracked files', 'git stash': 'changes', 'git diff': 'the working tree' };
const STEM = 4;

/** The verb already says the chip (`Cleaned [git clean]`, `Force-pushed [git push]`): a stem of its lead word leads a
 *  subcommand of the label (`Ran tests [npm test]` is not one: `tests` is not its lead). */
export function verbRepeatsChip(verb: string, label: string): boolean {
  const lead = verb.split(' ', 1)[0].toLowerCase();
  const stems = lead.split('-').filter(word => word.length >= STEM).map(word => word.slice(0, STEM));
  const words = label.toLowerCase().split(/\s+/).slice(1);
  return words.some(word => stems.some(stem => word.startsWith(stem)));
}

export function actedOn(label: string): string { return ACTED_ON[label] ?? ''; }

/* --- What a failed compound's output blames, checks that expect silence, patches in commands -------------------------- */

/** A test runner printed: a summary line, a per-test mark or a runner banner. Per line (`^[ \t]*`), so no newline run backtracks. */
const RUNNER_PRINTED = /^[ \t]*(?:RUN\s+v\d|PASS\s|FAIL\s|--- FAIL|✓|✔|✗|✘|×|❯ \S+ \(\d+ tests?|TAP version|# Subtest|(?:not )?ok \d+ |running \d+ tests?|Running \d+ tests? using|test result:|=+ (?:FAILURES|test session starts)|\d+ (?:passing|failing)\b)/m;
const LINT_FOUND = /✖ \d+ problems?\b/;
const TSC_ERROR = /\berror TS\d+:/;
const BUILD_ERROR = /\bnpm ERR!|\bERR_PNPM_|\bbuild failed\b|\berror during build\b|\bcould not compile\b/i;
const BUILD_STEP = /\bbuild\b/;

/** Whether a test runner's own output is in the text (its summary or per-test lines), so a failure is the tests'. */
export function runnerPrinted(output: string): boolean {
  return RUNNER_PRINTED.test(output);
}

const CARGO_FAILED = /test result: FAILED\. (\d+) passed; (\d+) failed/;
const VITEST_FAILED = /^[ \t]*Tests?(?: Files)?[ \t]+([1-9]\d*) failed(?: \| (\d+) passed)?/m;
const FAILED_LINE = /^[ \t]*([1-9]\d*) (?:failing|failed)\b/m;
const PASSED_LINE = /^[ \t]*(\d+) (?:passing|passed)\b/m;

/** Failed tests a runner printed in its own words, for output whose parsed summary has none (mocha `2 failing`, a later
 *  Playwright `1 failed` after a clean node:test summary, vitest `Tests 3 failed | 100 passed`, cargo `test result: FAILED`);
 *  `passed` when the same runner said it. */
export function printedTestFailures(output: string): { failed: number; passed?: number } | undefined {
  const cargo = CARGO_FAILED.exec(output);
  if (cargo && cargo[2] !== '0') return { failed: Number(cargo[2]), passed: Number(cargo[1]) };
  const vitest = VITEST_FAILED.exec(output);
  if (vitest) return { failed: Number(vitest[1]), ...(vitest[2] ? { passed: Number(vitest[2]) } : {}) };
  const failed = FAILED_LINE.exec(output);
  if (!failed) return undefined;
  const passed = PASSED_LINE.exec(output);
  return { failed: Number(failed[1]), ...(passed ? { passed: Number(passed[1]) } : {}) };
}

/** The stage a failed compound's output blames when no test runner printed: a lint, a typecheck, a build; else undefined. */
export function stageFailure(output: string, command: string): string | undefined {
  if (LINT_FOUND.test(output)) return 'Lint found problems';
  if (TSC_ERROR.test(output)) return BUILD_STEP.test(command) ? 'Build failed' : 'Typecheck failed';
  return BUILD_ERROR.test(output) ? 'Build failed' : undefined;
}

const NEGATED_LEAD = /^\s*!\s*curl\s/;
const FAIL_IF_ANSWERS = /\bif\s+curl\s[^;\n]*;\s*then\s+exit\s+[1-9]/;

/** A check that passes only when nothing answers: `! curl …`, `if curl …; then exit 1; fi`. */
export function expectsNoAnswer(command: string): boolean {
  return NEGATED_LEAD.test(command) || FAIL_IF_ANSWERS.test(command);
}

const PATCH_BEGIN = '*** Begin Patch';
const PATCH_END = '*** End Patch';

/** `+2 −1` from an `apply_patch` heredoc in a shell command; undefined when the command holds no whole patch. */
export function patchDelta(command: string): { added: number; removed: number } | undefined {
  const start = command.indexOf(PATCH_BEGIN);
  const end = command.indexOf(PATCH_END, start);
  if (start < 0 || end < 0) return undefined;
  const body = command.slice(start + PATCH_BEGIN.length, end).split('\n').filter(line => !line.startsWith('***'));
  const added = body.filter(line => line.startsWith('+')).length;
  const removed = body.filter(line => line.startsWith('-')).length;
  return added || removed ? { added, removed } : undefined;
}

const STAGE_STEPS: Record<string, RegExp> = {
  'Build failed': /\bbuild\b/, 'Typecheck failed': /\btsc\b|\btype-?check\b/, 'Lint found problems': /\blint\b|\beslint\b|\bclippy\b/,
};
const STEP_LIMIT = 48;

/** The step of a compound that ran the failing stage (`npm run build`), for the row's chip; '' when none names it. */
export function stageStep(command: string, stage: string): string {
  const pattern = STAGE_STEPS[stage];
  const step = pattern ? command.split(/&&|\|\||;|\n/).map(part => part.trim()).find(part => pattern.test(part)) : undefined;
  return step ? clip(step, STEP_LIMIT) : '';
}
