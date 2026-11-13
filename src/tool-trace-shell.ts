import { failedVerb, type TraceChip } from './tool-trace.ts';
import type { TraceParts } from './tool-trace-intent.ts';
import { describeShell, testSummary, type ShellIntent } from './shell-intent.ts';
import type { ShellCheck } from './shell-intent-base.ts';
import { ROW_TEXT, clip, lines, strings } from './tool-text.ts';
import {
  NOT_FOUND, SHORT_LINES, actedOn, errorCount, errorCountText, expectsNoAnswer, patchDelta, printedTestFailures, runnerPrinted, stageFailure,
  stageStep, verbRepeatsChip,
} from './tool-trace-outcome.ts';

/* A shell command's row parts from its intent (shell-intent.ts): `Read [a.ts] lines 1–20`, `Ran tests [playwright]`,
 * `Tests failed [playwright] · 1 of 14`, the running and `Couldn't …` forms of every shell verb. Pure. */

/** Present tense of a shell verb's lead word (the rest is kept: `Checked disk usage` → `Checking disk usage`), so a
 * failed row reads `Couldn't check disk usage`. Covers every word of SHELL_VERBS (tests/tool-trace-visuals.test.mjs). */
const PRESENT: Record<string, string> = {
  Ran: 'Running', Reran: 'Rerunning', Read: 'Reading', Counted: 'Counting', Searched: 'Searching', Listed: 'Listing', Edited: 'Editing',
  Wrote: 'Writing', Appended: 'Appending', Deleted: 'Deleting', Moved: 'Moving', Copied: 'Copying', Changed: 'Changing', Made: 'Making',
  Set: 'Setting', Hashed: 'Hashing', Checked: 'Checking', Extracted: 'Extracting', Archived: 'Archiving', Compressed: 'Compressing',
  Typechecked: 'Typechecking', Linted: 'Linting', Built: 'Building', Cleaned: 'Cleaning', Installed: 'Installing', Removed: 'Removing',
  Locked: 'Locking', Waited: 'Waiting', Fetched: 'Fetching', Queried: 'Querying', Called: 'Calling', Stopped: 'Stopping',
  Started: 'Starting', Restarted: 'Restarting', Inspected: 'Inspecting', Signed: 'Signing', Viewed: 'Viewing', Probed: 'Probing',
  Encoded: 'Encoding', Captured: 'Capturing', Opened: 'Opening', Located: 'Locating', Diffed: 'Diffing', Showed: 'Showing',
  Committed: 'Committing', Pushed: 'Pushing', Pulled: 'Pulling', Switched: 'Switching', Staged: 'Staging', Stashed: 'Stashing',
  Merged: 'Merging', Rebased: 'Rebasing', Reset: 'Resetting', Restored: 'Restoring', Tagged: 'Tagging', Cloned: 'Cloning',
  'Cherry-picked': 'Cherry-picking', Created: 'Creating', Commented: 'Commenting', Closed: 'Closing', Reopened: 'Reopening',
  Reviewed: 'Reviewing', Watched: 'Watching', Booted: 'Booting', Shut: 'Shutting', Erased: 'Erasing', Uninstalled: 'Uninstalling',
  Launched: 'Launching', Recorded: 'Recording', Sent: 'Sending', Added: 'Adding', Applied: 'Applying',
  'Force-pushed': 'Force-pushing', Overwrote: 'Overwriting', Emptied: 'Emptying', Discarded: 'Discarding', Dropped: 'Dropping',
  Truncated: 'Truncating', Shredded: 'Shredding', Formatted: 'Formatting', Synced: 'Syncing', Downloaded: 'Downloading',
  Uploaded: 'Uploading', Converted: 'Converting', Renamed: 'Renaming', Linked: 'Linking', Generated: 'Generating', Updated: 'Updating',
  Upgraded: 'Upgrading', Published: 'Publishing', Deployed: 'Deploying', Validated: 'Validating', Profiled: 'Profiling',
  Benchmarked: 'Benchmarking', Served: 'Serving', Mounted: 'Mounting', Exported: 'Exporting', Imported: 'Importing', Resized: 'Resizing',
  Unzipped: 'Unzipping', Zipped: 'Zipping', Tested: 'Testing', Previewed: 'Previewing', Bumped: 'Bumping',
  Destroyed: 'Destroying', Expired: 'Expiring', Pruned: 'Pruning', Rewrote: 'Rewriting', Purged: 'Purging', Wiped: 'Wiping',
  Killed: 'Killing', Revoked: 'Revoking', Unlinked: 'Unlinking',
  // Verbs the shell intents are growing into (tests/tool-trace-rows.test.mjs).
  'Hard-reset': 'Hard-resetting', Reverted: 'Reverting', Amended: 'Amending', Unstaged: 'Unstaging', Cleared: 'Clearing',
  Paused: 'Pausing', Resumed: 'Resuming', Enabled: 'Enabling', Disabled: 'Disabling',
  Rebooted: 'Rebooting', Unpublished: 'Unpublishing',
  Processed: 'Processing', Initialized: 'Initializing', Looked: 'Looking', Measured: 'Measuring', Rendered: 'Rendering',
  Compiled: 'Compiling', Decoded: 'Decoding', Cropped: 'Cropping', Rotated: 'Rotating', Compared: 'Comparing',
  Optimized: 'Optimizing', Transcoded: 'Transcoding', Trimmed: 'Trimming', Verified: 'Verifying', Migrated: 'Migrating',
  Spawned: 'Spawning', Terminated: 'Terminating', Seeded: 'Seeding', Unmounted: 'Unmounting', Loaded: 'Loading', Unloaded: 'Unloading',
  Flushed: 'Flushing', Ejected: 'Ejecting', Attached: 'Attaching', Detached: 'Detaching', Forked: 'Forking', Scheduled: 'Scheduling',
  Simulated: 'Simulating', Printed: 'Printing', Found: 'Finding',
  Resolved: 'Resolving', Tapped: 'Tapping', Pressed: 'Pressing', Scrolled: 'Scrolling', Swiped: 'Swiping', Typed: 'Typing',
  Pinged: 'Pinging', Traced: 'Tracing', Unstashed: 'Unstashing', Symlinked: 'Symlinking', Untracked: 'Untracking',
};
/** `Deleted` → `Deleting`, `Checked disk usage` → `Checking disk usage`; an unknown verb reads `Running`. */
export function shellRunningVerb(verb: string): string {
  const space = verb.indexOf(' ');
  const lead = space < 0 ? verb : verb.slice(0, space);
  const present = Object.prototype.hasOwnProperty.call(PRESENT, lead) ? PRESENT[lead] : undefined;
  return present ? present + (space < 0 ? '' : verb.slice(space)) : 'Running';
}


const MORE_STEPS = /^\+\d+ more commands?$/;
/** An intent's object without its `· +2 more commands` tail, which the row draws apart as muted text. */
function splitMore(object: string): { object: string; more?: string } {
  const at = object.lastIndexOf('·');
  const tail = (at < 0 ? object : object.slice(at + 1)).trim();
  if (!MORE_STEPS.test(tail)) return { object };
  return { object: at < 0 ? '' : object.slice(0, at).trimEnd(), more: tail };
}

/** Why a destructive command is (shell-intent.ts's `risks`, highest first), else the command itself. */
function riskParts(intent: ShellIntent, command: string, leadFailed: boolean): Partial<TraceParts> {
  if (!intent.destructive) return intent.notRun ? skippedRisks(intent) : {};
  const named = strings(intent.risks);
  const risks = named.length ? named : [command];
  // A destructive lead that failed destroyed nothing: no badge, the risks stay in the verb's tooltip.
  return leadFailed ? { risks, title: `Failed, so nothing changed: ${risks.join('; ')}` } : { destructive: true, risks };
}

/** shell-intent read from the output that the lead step failed, although the command may have exited 0 (a pipe hid it).
 *  `leadFailed` is shell-intent's newer name for `failed`. */
function leadStepFailed(intent: ShellIntent): boolean {
  return intent.failed === true || (intent as { leadFailed?: true }).leadFailed === true;
}

/** Checks whose nonzero exit is their finding, not a failure to run: [finished verb or kind, what the row then says]. */
export const FAILED_CHECKS: Readonly<Record<string, string>> = { test: 'Tests failed', Typechecked: 'Typecheck failed', Linted: 'Lint found problems', Built: 'Build failed' };

type FailedCheck = { verb: string; tally: string; label?: string };

/** `1 of 14 tests`: the verb (`Tests failed`) already says which side the count is. */
function failedOf(summary: { failed: number; passed: number }): string {
  return `${summary.failed} of ${summary.passed + summary.failed} tests`;
}

/** `Tests failed` with `1 of 14` when the output has a summary; undefined when the check never ran or is no check. */
function failedCheck(intent: { kind: string; verb: string; steps: number }, output: string, command: string): FailedCheck | undefined {
  const verb = FAILED_CHECKS[intent.kind === 'test' ? 'test' : intent.verb];
  const text = output.trim();
  if (!verb || !text) return undefined;
  const summary = intent.kind === 'test' ? testSummary(text) : undefined;
  // Every test the summary counts passed: a later runner's own failures still lead, else the nonzero exit is another
  // step's, so the run is no failed check (`then failed` says it).
  if (summary && !summary.failed) return intent.kind === 'test' ? printedTests(text) : undefined;
  // A runner that never started: the shell could not find it. Only a short output counts, so a test that prints this still failed.
  if (!summary && lines(text).length <= SHORT_LINES && NOT_FOUND.test(text)) return undefined;
  if (intent.kind === 'test' && !summary && intent.steps > 1 && !runnerPrinted(text)) return stageCheck(text, command);
  const errors = intent.kind === 'test' ? undefined : errorCount(text);
  return { verb, tally: summary?.failed ? failedOf(summary) : errors ? errorCountText(errors) : '' };
}

/** A compound whose tests never printed failed earlier: the stage its output blames (`Build failed [npm run build] · 1 error`),
 *  else `Couldn't run tests`. */
function stageCheck(text: string, command: string): FailedCheck {
  return blamedStage(text, command) ?? { verb: "Couldn't run tests", tally: '' };
}

/** `Tests failed · 2 of 7` from failures a runner printed beside (or without) a parsed summary. */
function printedTests(output: string): FailedCheck | undefined {
  const printed = printedTestFailures(output);
  if (!printed) return undefined;
  return { verb: 'Tests failed', tally: printed.passed === undefined ? '' : failedOf({ failed: printed.failed, passed: printed.passed }) };
}

/** A stage the output blames (`Build failed · 2 errors`), chipped by the step that ran it when the command names one. */
function blamedStage(output: string, command: string): FailedCheck | undefined {
  const stage = stageFailure(output, command);
  if (!stage) return undefined;
  const errors = errorCount(output);
  const step = stageStep(command, stage);
  return { verb: stage, tally: errors ? errorCountText(errors) : '', ...(step ? { label: step } : {}) };
}

/** A check that exited 0 (a pipe's last stage did) while its output says it failed: tests with failures, tests that never
 *  compiled, a typecheck with errors, a build that printed its failure. `npm test | tail` reads `Tests failed · 5 of 113`,
 *  `npm run build | tail` with `error during build` reads `Build failed`. */
function printedFailure(intent: { kind: string; verb: string }, output: string, command: string): FailedCheck | undefined {
  if (intent.kind === 'test') {
    const summary = testSummary(output);
    if (summary?.failed) return { verb: 'Tests failed', tally: failedOf(summary) };
    return printedTests(output) ?? (summary || runnerPrinted(output) ? undefined : blamedStage(output, command));
  }
  if (intent.verb === 'Built') return blamedStage(output, command);
  const errors = intent.verb === 'Typechecked' ? errorCount(output) : undefined;
  return errors ? { verb: 'Typecheck failed', tally: errorCountText(errors) } : undefined;
}

/** shell-intent's failing check of a compound (`tsc; npm test` with tsc errors), which leads the row. A wait's check
 *  (`waited`) never replaces the wait: waitedTally says it apart. */
function intentCheck(check: ShellCheck | undefined, output: string): FailedCheck | undefined {
  if (!check?.failed || check.waited) return undefined;
  if (check.kind === 'test') {
    const summary = testSummary(output);
    return { verb: 'Tests failed', tally: summary?.failed ? failedOf(summary) : '' };
  }
  const errors = errorCount(output);
  return { verb: 'Typecheck failed', tally: errors ? errorCountText(errors) : '' };
}

/** `3 of 873 tests failed`: the failed tests a waited-for log printed, beside the wait (`Waited for [final2.log] …`). */
function waitedTally(check: ShellCheck | undefined, output: string): string {
  if (!check?.waited || !check.failed) return '';
  const summary = testSummary(output);
  return summary?.failed ? `${summary.failed} of ${summary.passed + summary.failed} tests failed` : 'tests failed';
}

/** `152 passed`: a test run that passed says how many, from its parsed summary. */
function passedTally(intent: ShellIntent, run: ShellRun | undefined): string {
  if (intent.kind !== 'test' || !run || run.nonzero) return '';
  const summary = testSummary(run.output);
  return summary && !summary.failed && summary.passed ? `${summary.passed} passed` : '';
}

/** What a shell row knows beyond its command: its output (a test summary leads a compound), whether it exited nonzero
 *  (a failing check reads `Tests failed [playwright] · 1 of 14`), whether a finished run's output should still be
 *  read for a failure (`inspect`: it exited 0 or said nothing), Claude's own `description` of it and the record's working
 *  directory (`cwd`: Devin's `workdir`), which locates a relative image the command wrote. */
export type ShellRun = { output: string; nonzero: boolean; description?: string; code?: number; inspect?: boolean; cwd?: string };

/** An object that is only flags (`--short`, `-la`) says nothing beside its chip, whose tooltip has the whole command. */
const FLAG = /^--?\w[\w-]*(?:=\S*)?$/;
/** Token by token, so no pattern can backtrack over a run of dashes (`rm ------…` once froze the window). */
export function flagsOnly(object: string): boolean {
  const words = object.trim().split(/\s+/);
  return words[0] !== '' && words.every(word => FLAG.test(word));
}
const NOTE_LIMIT = ROW_TEXT;

/** The generic `Ran [shell] <command>` fallback: Claude's description reads better than the raw text (the card keeps it). */
function rawWithDescription(intent: ShellIntent, description: string): boolean {
  // `raw` marks the raw-command fallback chipped by its program.
  return Boolean(description) && intent.kind === 'shell' && (intent.raw === true || intent.label === 'shell');
}

/** The words of a chip's subcommand that name a thing (`gh pr view` → `PR`, `gh run watch` → `run`): every word after the
 *  program except the one the verb already says. */
const CHIP_NOUNS: Record<string, string> = { pr: 'PR' };
function chipNoun(verb: string, label: string): string {
  const words = label.split(/\s+/).slice(1).filter(word => !verbRepeatsChip(verb, `x ${word}`));
  return words.map(word => CHIP_NOUNS[word] ?? word).join(' ');
}

/** `npm run build`, `yarn run-script lint`: a package script, whose chip stays as written. */
const RUN_SCRIPT = /^(?:npm|pnpm|yarn|bun) run(?:-script)? /;
type PlainChip = { chip?: TraceChip; object?: string; chipLast?: true; unchipped?: true };
/** A chip that only repeats its verb (`Diffed [git diff]`, `Viewed [gh pr view] #12`) gives way to what was acted on:
 *  `Viewed [PR #12]`, `Diffed the working tree`, `Cleaned untracked files [git clean -fdx]` (the chip the whole command). */
function plainChip(intent: { verb: string; label: string; steps: number }, chip: TraceChip | undefined, own: string, command: string): PlainChip {
  // `Built [npm run build]`: a script's name is the chip, whatever the verb.
  if (!chip || RUN_SCRIPT.test(intent.label) || !verbRepeatsChip(intent.verb, intent.label)) return {};
  const noun = chipNoun(intent.verb, intent.label);
  if (own) return { chip: { ...chip, label: clip(`${noun} ${own.replace(/^·\s*/, '')}`.trim(), 48) }, object: '' };
  // A bare `git diff` (alone, or leading a compound) has nothing beyond its program: the sentence names what it acted on.
  if (command.trim() === intent.label || intent.steps !== 1) return { unchipped: true, object: actedOn(intent.label) || noun };
  // `git clean -fdx` chips the whole command; a step inside a compound (`cd /x && (cargo build | tail)`) only its own label.
  const label = command.trim().startsWith(intent.label) ? command : intent.label;
  return { chip: { ...chip, label: clip(label, 48) }, object: actedOn(intent.label), chipLast: true };
}

/** A bare `+N` names what it counts (`+4 paths`, `react +1 package`), from the kind of step that printed it. shell-intent's
 *  `+N more` folds a step's own extra items and the later steps into one number; it splits back into both
 *  (`+1 file · +1 more command`), so every count has its noun. */
const COUNT_NOUNS: Record<string, [string, string]> = {
  search: ['path', 'paths'], read: ['file', 'files'], file: ['file', 'files'], install: ['package', 'packages'],
  test: ['file', 'files'], list: ['path', 'paths'], process: ['process', 'processes'],
};
const BARE_COUNT = /(^|\s)\+(\d+)( more)?(?=$|\s·)/g;
/** `+2 files` (shell-intent's own noun) → `+2 more files`: the overflow of a listed set always says `more`. */
const NAMED_COUNT = /(^|\s)\+(\d+) (?!more\b)(?=[a-z])/g;
function namedCounts(object: string, kind: string, steps: number): string {
  if (!object.includes('+')) return object;
  const noun = COUNT_NOUNS[kind] ?? ['item', 'items'];
  return object.replace(NAMED_COUNT, '$1+$2 more ').replace(BARE_COUNT, (_all, lead: string, count: string, more?: string) => {
    const later = more ? Math.max(0, steps - 1) : 0;
    const own = Number(count) - later;
    const parts = [own > 0 ? `+${own} more ${own === 1 ? noun[0] : noun[1]}` : '', later > 0 ? `+${later} more ${later === 1 ? 'command' : 'commands'}` : ''];
    return lead + parts.filter(Boolean).join(' · ');
  });
}

/** A compound that failed after its lead step keeps the lead's finished verb, then says it failed (with its exit code). */
function thenFailed(intent: { verb: string; steps: number }, run: ShellRun | undefined, check: unknown): { verb?: string; settled?: true; then?: true; exit?: number } {
  if (!run?.nonzero || intent.steps < 2 || check) return {};
  return { verb: intent.verb, settled: true, then: true, ...(run.code !== undefined && run.code !== 0 ? { exit: run.code } : {}) };
}

/** Where each runner's summary comes from in a command line (`cargo test`, `npx playwright test`). */
const RUNNER_STEPS: Record<string, RegExp> = {
  cargo: /\bcargo\s+(?:test|nextest)\b/, pytest: /\bpytest\b/, jest: /\bjest\b/, vitest: /\bvitest\b/, go: /\bgo\s+test\b/,
  playwright: /\bplaywright\s+test\b/, 'node:test': /\bnode\s+--test\b|\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?test\b/,
};
/** A test run's chip names the runner whose summary its card shows: a compound that ran `npm test` then `cargo test` and
 *  printed only cargo's summary reads `[cargo test]`. Undecided (no summary, unknown runner) keeps the intent's label. */
function runnerLabel(label: string, command: string, output: string): string {
  const runner = testSummary(output)?.runner ?? '';
  const step = RUNNER_STEPS[runner];
  if (!step || step.test(label) || label.includes(runner)) return label;
  // Only rename the chip when the command itself names the runner: `npm test | tail` keeps [npm test] whatever its output looks like.
  return step.exec(command)?.[0].replace(/\s+/g, ' ') ?? label;
}

const WORKING_TREE = 'the working tree';
/** Objects that are prose beside their chip, never code: `responds`, `to exist`, `to contain "ready"`. */
const PROSE_OBJECT = /^(?:responds|is not responding|· not responding|to exist|does not exist|to contain\b)/;
const NOT_RESPONDING = 'not responding';

/** A wait on something (`Waited for [localhost:1420] responds`) keeps its subject as a chip; a plain `Waited 30s` has none. */
function waitSubject(intent: ShellIntent): boolean {
  return intent.kind === 'wait' && / for$/.test(intent.verb) && Boolean(intent.label);
}

/** The object as the row says it: `.` reads as the working tree, a check that expects silence `· not responding`. */
function spokenObject(intent: ShellIntent, own: string, command: string): { object: string; prose: boolean } {
  if (own === '.' || own === '-- .') return { object: WORKING_TREE, prose: true };
  const tree = own.endsWith(' in .') ? `${own.slice(0, -1)}${WORKING_TREE}` : own;
  if (intent.kind === 'fetch' && expectsNoAnswer(command)) return { object: `${tree.replace(/\s*responds$/, '')} · ${NOT_RESPONDING}`.trim(), prose: true };
  return { object: tree, prose: waitSubject(intent) || PROSE_OBJECT.test(tree) };
}

/** `Read [a.ts] lines 1–20`, `Ran tests [playwright]`, `Waited 30s`; undefined when the intent says nothing new. */
export function shellTrace(command: string, failed: boolean, where = '', raw = command, run?: ShellRun): TraceParts | undefined {
  if (!command) return undefined;
  // The recorded line still has its `zsh -lc "…"` wrapper, whose quoting describeShell undoes properly.
  const intent = describeShell(raw || command, run?.output, run ? { nonzero: run.nonzero, ...(run.cwd ? { cwd: run.cwd } : {}) } : undefined);
  if (!intent.steps) return undefined;
  // A plain wait (`Waited 30s`) and a search (`Searched for "x" in src`) already name everything in the sentence.
  const bare = (intent.kind === 'wait' && !waitSubject(intent)) || intent.kind === 'search';
  const led = intentCheck(intent.check, run?.output ?? '');
  // shell-intent read the lead step's own failure from its output (`screencapture …; echo sc=$?` printing `could not create image`).
  const leadFailed = leadStepFailed(intent);
  // A typecheck shell-intent read is trusted: a passing `go vet` stays passed when a later step prints `error:`. A test
  // check is not (printedFailure also reads runners testSummary misses, mocha's `2 failing`).
  const trusted = intent.check?.kind === 'typecheck';
  const printed = !run?.nonzero && (led || (run?.inspect && !trusted ? printedFailure(intent, run.output, command) : undefined));
  const check = led ?? (run?.nonzero ? failedCheck(intent, run.output, command) : printed || undefined);
  const label = check?.label ?? (intent.kind === 'test' ? runnerLabel(intent.label, command, run?.output ?? '') : intent.label);
  const chip: TraceChip | undefined = bare ? undefined : { icon: intent.icon, label, title: command };
  const split = splitMore(namedCounts(intent.object, intent.kind, intent.steps));
  const described = rawWithDescription(intent, run?.description ?? '');
  const spoken = spokenObject(intent, described || flagsOnly(split.object) ? '' : split.object, command);
  const own = spoken.object;
  const counted = check?.tally || (check ? '' : waitedTally(intent.check, run?.output ?? '') || passedTally(intent, run));
  const tally = counted ? (own ? ' · ' : '· ') + counted : '';
  const plainer = plainChip(intent, chip, own, command);
  const object = (bare && intent.kind === 'wait' ? own || intent.label : plainer.object ?? own) + tally + where;
  const then = leadFailed ? {} : thenFailed(intent, run, check);
  // A lead failure the output showed settles as `Couldn't …` here: the call itself may have exited 0.
  const verb = check?.verb ?? then.verb ?? (leadFailed ? failedVerb(shellVerb(intent, command, own, true)) : shellVerb(intent, command, own, failed));
  const { unchipped, ...plain } = plainer;
  const parts: TraceParts = {
    ...then, verb, ...(check || leadFailed || NOT_DONE.test(verb) ? { settled: true } : {}), ...(printed || leadFailed ? { outputFailed: true } : {}),
    ...(unchipped ? {} : { chip }), ...plain,
    object, mono: intent.mono && Boolean(own) && !spoken.prose && plain.object !== '',
    ...shellExtras(intent, command, failed, leadFailed, split.more, described ? run?.description ?? '' : ''),
  };
  const placed = intent.kind === 'search' ? { ...parts, ...searchPlace(object) } : parts;
  return placed.chip ? { ...placed, chip: curlyChip(placed.chip) } : placed;
}

/** shell-intent's own `Didn't …` verbs already say the outcome; a failure must not rewrite them to `Couldn't didn't …`. */
const NOT_DONE = /^Didn['’]t /;

/** A chip that is a quoted message (`"fix: x"`, a commit's) reads with curly quotes, like every other row's prose. */
function curlyChip(chip: TraceChip | undefined): TraceChip | undefined {
  const quoted = chip ? /^"([^"\n]*)"$/.exec(chip.label) : null;
  return chip && quoted ? { ...chip, label: `“${quoted[1]}”` } : chip;
}

/** `for "foo" in src-tauri/src` → object `for "foo" in` and a folder chip after it, like Grep's row. Only a path (no
 *  spaces) becomes a chip; `in the working tree` stays prose. */
function searchPlace(object: string): Partial<TraceParts> {
  const tallyAt = object.indexOf(' · ');
  const sentence = tallyAt < 0 ? object : object.slice(0, tallyAt);
  const at = sentence.lastIndexOf(' in ');
  const place = at < 0 ? '' : sentence.slice(at + 4);
  if (!place || /\s/.test(place)) return {};
  const chip: TraceChip = { icon: 'folder', label: clip(place, 48), title: place };
  return { chip, chipLast: true, object: sentence.slice(0, at + 3) + (tallyAt < 0 ? '' : object.slice(tallyAt)) };
}

/** A lead step that never ran (after a failed `&&`) says so: `Didn't delete`, settled, with the compound's exit.
 *  shell-intent leads with a step that ran (`ShellIntent.notRun` marks the skipped destructive ones, see skippedRisks),
 *  so this is for a lead known not to have run. Undefined otherwise. */
export function notRunParts(intent: { verb: string; notRun?: boolean }, run: Pick<ShellRun, 'nonzero' | 'code'> | undefined): Partial<TraceParts> | undefined {
  if (!intent.notRun || !run?.nonzero) return undefined;
  const base = failedVerb(shellRunningVerb(intent.verb)).replace(/^Couldn't /, '');
  return { verb: `Didn't ${base}`, settled: true, ...(run.code ? { exit: run.code } : {}) };
}

/** Destructive steps that never ran (`ShellIntent.notRun`): no badge, but their risks stay, in the verb's tooltip. */
function skippedRisks(intent: ShellIntent): Partial<TraceParts> {
  const risks = strings(intent.risks);
  return risks.length ? { risks, title: `Didn't run (an earlier step failed): ${risks.join('; ')}` } : {};
}

/** The intent's verb as the row says it: a check expecting silence `Checked`, an install with no packages named
 *  `Installed packages`; a failure's present tense (`Couldn't …`). */
function shellVerb(intent: ShellIntent, command: string, own: string, failed: boolean): string {
  const negated = intent.kind === 'fetch' && expectsNoAnswer(command) ? 'Checked' : intent.verb;
  const verb = intent.kind === 'install' && !own && negated === 'Installed' ? 'Installed packages' : negated;
  return failed ? shellRunningVerb(verb) : verb;
}

/** The row's icon, muted `+N more`, Claude's description, a produced image, risks and an apply_patch's delta. */
function shellExtras(intent: ShellIntent, command: string, failed: boolean, leadFailed: boolean, more: string | undefined, description: string): Partial<TraceParts> {
  const produced = intent.producedImage;
  const delta = intent.verb === 'Edited' ? patchDelta(command) : undefined;
  // A test run's mark must not read as a pass before it has one; a failure swaps it for the alert anyway.
  return {
    icon: intent.kind === 'test' ? 'play' : intent.icon, ...(more ? { more } : {}),
    ...(description ? { note: clip(description, NOTE_LIMIT) } : {}), ...(produced && !failed && !leadFailed ? { produced } : {}),
    ...riskParts(intent, command, leadFailed), ...(delta ?? {}),
  };
}
