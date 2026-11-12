/* Which described step leads a shell row, and how the row counts the rest. Pure and total.
 * Order: the most dangerous step (a harmless `cat` never hides a later `rm -rf`), then a check whose output shows it
 * failed (`ln -s a b && npx tsc` with `error TS2345`), then the test step (`cargo build && npm test`), then the first
 * real step. Preludes (`cd`, `export`) and soft steps (`echo`, `sleep`, `mkdir`) only lead when nothing else runs. */
import { plural, set, type Desc, type ShellCheck } from './shell-intent-base.ts';
import { severityOf } from './shell-intent-risk.ts';
import { testRunners, testSummary } from './shell-intent-results.ts';
import type { Described } from './shell-intent-context.ts';

export const PRELUDE = set('cd', 'pushd', 'popd', 'export', 'set', 'source', '.', 'true', 'false', ':', 'unset', 'alias', 'setopt', 'ulimit',
  'read', 'local', 'let', 'declare', 'typeset', 'trap', 'shopt', 'return', 'exit', 'break', 'continue', 'shift', 'wait');
/** The program of a step that only assigns a substitution (`rid=$(cat f)`): noise beside the work that uses it. */
export const ASSIGNMENT = '=$()';
/** Steps that only matter when nothing else runs (a `[ … ]` file check is kind 'file' and still counts). */
const SOFT = set(ASSIGNMENT, 'sleep', 'echo', 'printf', 'mkdir', 'touch', '[', '[[', 'test', 'pwd', 'date', 'clear', 'whoami', 'uname', 'hostname', 'id',
  'mktemp', 'uptime', 'tty', 'nproc', 'arch', 'sw_vers');
/** `[ -f a ] && cargo build`: a guard is noise beside the work it guards. */
export const GUARDS = set('[', '[[', 'test');

/** 0 meaningful, 1 noise beside other work, 2 prelude. */
export function noiseOf(step: Described, all: Described[], index: number): number {
  if (PRELUDE.has(step.program)) return 2;
  if (SOFT.has(step.program) && (step.desc.kind !== 'file' || GUARDS.has(step.program) || step.desc.verb === 'Created folder')) return 1;
  // `sed -n 1p /dev/null`: a read of a device stream reads nothing.
  if (step.desc.kind === 'read' && step.desc.label.startsWith('/dev/')) return 1;
  if (step.desc.label === 'git add' && all.slice(index + 1).some(next => next.desc.label === 'git commit')) return 1;
  return 0;
}

function mainSteps(all: Described[]): Described[] {
  const levels = all.map((step, index) => noiseOf(step, all, index));
  for (const max of [0, 1]) {
    const kept = all.filter((_, index) => levels[index] <= max);
    if (kept.length) return kept;
  }
  return all;
}

/** A delete of scratch (`rm -rf dist`) never leads a row that does other work. */
const isScratchDelete = (described: Desc) => described.verb === 'Deleted' && !described.destructive;

/** The steps a row counts, the leading one first. `output` (when given) lets a failed check or the runner that printed lead. */
export function leadingSteps(all: Described[], output = ''): Described[] {
  const chosen = mainSteps(all);
  const riskiest = all.reduce<Described | undefined>((best, step) => severityOf(step.desc) > (best ? severityOf(best.desc) : 0) ? step : best, undefined);
  const tests = chosen.filter(step => step.desc.kind === 'test');
  const runners = output ? testRunners(output) : [];
  const first = riskiest ?? failedCheck(chosen, tests, runners, output) ?? testStep(tests, runners) ?? clearedRead(chosen)
    ?? chosen.find(step => !isScratchDelete(step.desc));
  return first ? [first, ...chosen.filter(step => step !== first)] : chosen;
}

/** `error TS2345`, `error[E0308]`: a typecheck's errors (tsc, cargo check). Linear: no nested quantifiers. */
const TYPE_ERRORS = /\berror TS\d+|\berror\[E\d{4}\]/;
/** Checkers whose errors look different, by chip: [label, what only their errors print]. Per line (`^`), so `\S+` before a
 * literal only scans its own line. A plain `error:` line belongs to whatever printed it, never to the check. */
const CHECK_ERRORS: [RegExp, RegExp][] = [
  [/^go vet\b/, /^vet: |^\S+\.go:\d+:\d+: /m],
  [/^(?:mypy|pyright|basedpyright)\b/, /^\S+\.pyi?:\d+(?::\d+)?: error:|^\s+\S+\.pyi?:\d+:\d+ - error:/m],
  [/^cargo\b/, /\berror\[E\d{4}\]|^error: could not compile\b/m],
];
const MAX_OUTPUT = 200_000;

/** Whether `output` shows errors of the typecheck chipped `label`. */
const typeErrors = (output: string, label = '') => (CHECK_ERRORS.find(([chip]) => chip.test(label))?.[1] ?? TYPE_ERRORS).test(output.slice(0, MAX_OUTPUT));
const testsFailed = (output: string) => (testSummary(output)?.failed ?? 0) > 0;

/** `fatal: …`, `error: could not compile`, `nothing to commit`, `npm ERR!`, `make: *** [all] Error 2`: a step failed. Per line, linear. */
const STEP_FAILED = /^(?:fatal|error): |^nothing (?:added )?to commit\b|\bnpm ERR!|\bERR_PNPM_|^make(?:\[\d+\])?: \*\*\* /m;

/** Steps whose failure `fatal:` / `nothing to commit` / `npm ERR!` can be: git, gh, package managers, builds. */
const BLAMED_KINDS = set('git', 'github', 'install', 'build');

/** Whether the output shows that `step` failed: its tests, its typecheck's errors, or a git/npm failure line. */
function blamed(step: Described, output: string): boolean {
  if (step.desc.kind === 'test') return testsFailed(output);
  if (step.desc.verb === 'Typechecked') return typeErrors(output, step.desc.label);
  return BLAMED_KINDS.has(step.desc.kind) && STEP_FAILED.test(output);
}

/** Lines only one git subcommand prints: [verbs of the step, pattern]. Per line, linear. */
const OWN_FAILURES: [ReadonlySet<string>, RegExp][] = [
  [set('Pushed', 'Force-pushed', 'Deleted remote branch'), /^error: failed to push some refs\b|^error: src refspec \S+ does not match any|^ ! \[(?:remote )?rejected\]/m],
  [set('Committed'), /^nothing (?:added )?to commit\b|^no changes added to commit\b/m],
];
/** The failure lines a kind's own program prints. */
const KIND_FAILURES: Record<string, RegExp> = {
  git: /^(?:fatal|error): /m, github: /^(?:fatal|error): /m, install: /\bnpm ERR!|\bERR_PNPM_/, build: /\bnpm ERR!|\bERR_PNPM_|^make(?:\[\d+\])?: \*\*\* /m,
};

/** Whether `output` pins a failure on `lead` itself (ShellIntent.leadFailed): a line only its subcommand prints
 * (`error: failed to push some refs` for a push), else its kind's failure line when no other step could have printed it. */
export function leadFailed(lead: Described, all: Described[], output: string): boolean {
  const text = output.slice(0, MAX_OUTPUT);
  if (!text) return false;
  const own = OWN_FAILURES.find(([verbs]) => verbs.has(lead.desc.verb));
  if (own?.[1].test(text)) return true;
  // A line another subcommand owns (`nothing to commit` beside a push) is never the lead's.
  if (OWN_FAILURES.some(([verbs, pattern]) => verbs !== own?.[0] && pattern.test(text))) return false;
  const pattern = KIND_FAILURES[lead.desc.kind];
  return !!pattern && pattern.test(text) && !all.some(step => step !== lead && BLAMED_KINDS.has(step.desc.kind));
}

/** Destructive steps the shell skips (`true || rm -rf ~`), those after a `&&` that can't have run: a step before them in the same `&&` chain is blamed by the output
 * (`npm test && git push -f` printing failures), and those after a `||` whose chain clearly succeeded (`npm test || rm -rf x`
 * printing every test passed). A nonzero exit alone proves nothing (the destructive step may be the one
 * that failed), and a line of the step's own program (`rm: x: Permission denied`) proves it ran. A step after `;`, or one
 * whose chain shows neither, could have run. */
export function notRunSteps(all: Described[], output: string): Set<Described> {
  const text = output.slice(0, MAX_OUTPUT);
  const out = new Set<Described>();
  all.forEach((step, at) => {
    if (step.dead && step.desc.destructive) { out.add(step); return; }
    if (!step.desc.destructive || printedBy(step.program, text)) return;
    if (step.gated && chainBefore(all, at, 'gated').some(before => blamed(before, text))) out.add(step);
    if (step.orElse && chainBefore(all, at, 'orElse').some(before => succeeded(before, text))) out.add(step);
  });
  return out;
}

/** The steps before `at` in its own `&&` (gated) or `||` (orElse) chain. */
function chainBefore(all: Described[], at: number, link: 'gated' | 'orElse'): Described[] {
  let head = at;
  while (head > 0 && all[head][link]) head--;
  return all.slice(head, at);
}

/** A test step whose summary shows every test passed: the `||` branch after it never ran. */
function succeeded(step: Described, output: string): boolean {
  const summary = step.desc.kind === 'test' ? testSummary(output) : undefined;
  return !!summary && summary.passed > 0 && !summary.failed;
}

/** `rm: x: Permission denied`: a line the program itself printed. */
const printedBy = (program: string, text: string) => !!program && (text.startsWith(`${program}: `) || text.includes(`\n${program}: `));

/** The typecheck whose errors the output shows, else the test step whose run failed. */
function failedCheck(chosen: Described[], tests: Described[], runners: string[], output: string): Described | undefined {
  if (!output) return undefined;
  const typecheck = chosen.find(step => step.desc.verb === 'Typechecked' && typeErrors(output, step.desc.label));
  return typecheck ?? (tests.length && testsFailed(output) ? testStep(tests, runners) : undefined);
}

/** The leading step's check (`check` of ShellIntent): undefined unless it is a typecheck or a test and output was given. */
export function checkOf(lead: Desc, output: string | undefined): ShellCheck | undefined {
  if (typeof output !== 'string' || !output) return undefined;
  if (lead.verb === 'Typechecked') return { kind: 'typecheck', failed: typeErrors(output, lead.label) };
  // `until grep -q "test result" $F; do sleep 5; done; cat $F`: a wait for a test log carries the summary it printed, apart.
  if (lead.kind === 'wait') return testSummary(output) ? { kind: 'test', failed: testsFailed(output), waited: true } : undefined;
  return lead.kind === 'test' ? { kind: 'test', failed: testsFailed(output) } : undefined;
}

/** Test labels that name the runner whose summary testSummary reports; any other label (`npm test`, `make test`) may run any. */
const RUNNER_LABELS: Record<string, RegExp> = {
  cargo: /^cargo\b/, pytest: /\b(?:pytest|unittest)\b/, jest: /\bjest\b/, vitest: /\bvitest\b/, 'node:test': /^node:test$/,
  playwright: /\bplaywright\b/, go: /^go test\b/,
};
const namesRunner = (label: string) => Object.values(RUNNER_LABELS).some(pattern => pattern.test(label));

/** `npm test; cargo test` whose output holds cargo's summary leads with `cargo test`; a generic script (`npm test`) stands
 * in for an unnamed runner. With no summary, or summaries of several runners, the first test step leads. */
function testStep(tests: Described[], runners: string[]): Described | undefined {
  const pattern = runners.length === 1 ? RUNNER_LABELS[runners[0]] : undefined;
  if (!pattern) return tests[0];
  return tests.find(step => pattern.test(step.desc.label)) ?? tests.find(step => !namesRunner(step.desc.label)) ?? tests[0];
}

/** `rm -f /tmp/x.json && cat /tmp/x.json`: a scratch delete before a read of the same file is the point of the row. */
function clearedRead(chosen: Described[]): Described | undefined {
  const index = chosen.findIndex(step => !isScratchDelete(step.desc));
  const read = chosen[index]?.desc;
  if (!read || read.kind !== 'read') return undefined;
  return chosen.slice(0, index).find(step => isScratchDelete(step.desc) && step.desc.label === read.label);
}

const OBJECT_COUNT = /(^|\s)\+(\d+)(?: more)?(?: (?:files?|paths?))?(?=$|\s)/;

/** One count per row: beside other commands, the step's own `+N` (`a.ts +1` in the label, `+2 files` in the object)
 * joins them (`Read [a.ts] +2 more`), never `a.ts and 1 more · +1 more command`. `code`: the object is code or
 * command text, whose `+4` is never a count. */
export function counted(label: string, object: string, more: number, code = false): { label: string; object: string; note: string } {
  if (more <= 0) return { label, object, note: '' };
  const inLabel = / \+(\d+)$/.exec(label);
  // `python3 -c "x = 1 +4"`: an object that is code holds no count.
  const inObject = inLabel || code ? null : OBJECT_COUNT.exec(object);
  const own = Number((inLabel ?? inObject)?.[inLabel ? 1 : 2] ?? 0);
  const note = own ? `+${own + more} more` : `+${more} more ${more === 1 ? 'command' : 'commands'}`;
  return {
    label: inLabel ? label.slice(0, inLabel.index) : label,
    object: inObject ? object.replace(OBJECT_COUNT, '$1').trim() : object,
    note,
  };
}

/** Files one read step names: its own and its `+N` (`a +2 files`). */
const filesRead = (read: Desc) => 1 + Number(/ \+(\d+)$/.exec(read.label)?.[1] ?? OBJECT_COUNT.exec(read.object)?.[2] ?? 0);

/** Several reads count their files as one step would: `cat a b; cat c` reads `Read [a] +2 files`, as `cat a b c` does.
 * A file read twice (the same chip, no `+N`) counts once. */
export function mergedReads(chosen: Described[]): Desc | undefined {
  const reads = chosen.map(step => step.desc);
  if (reads.length < 2 || !reads.every(read => read.kind === 'read' && read.verb === 'Read' && !read.destructive && !read.object.startsWith('matching'))) return undefined;
  const named = new Set<string>();
  let total = 0;
  for (const read of reads) {
    const count = filesRead(read), name = read.label.replace(/ \+\d+$/, '');
    if (count > 1 || !named.has(name)) total += count;
    named.add(name);
  }
  const first = chosen[0].desc;
  const label = first.label.replace(/ \+\d+$/, '');
  return total > 1 ? { ...first, label, object: `+${plural(total - 1, 'file')}` } : undefined;
}

/** `sleep 45 && tail log`: `after 45s` when a literal sleep comes right before the step that leads (not a wait itself). */
export function waitedBefore(all: Described[], lead: Described): string {
  const at = all.indexOf(lead);
  if (at <= 0 || lead.desc.kind === 'wait') return '';
  const before = all.slice(0, at).reverse().find(step => !PRELUDE.has(step.program) && step.program !== 'echo' && step.program !== 'printf');
  return before?.program === 'sleep' && before.desc.object ? `after ${before.desc.object}` : '';
}
