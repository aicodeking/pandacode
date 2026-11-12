/* Semantic descriptions of shell tool calls (Claude `Bash`, Codex `Command`) and of test-runner output.
 * Pure: no DOM access and no I/O; every export is total (never throws) and bounded.
 *
 * describeShell(command) → ShellIntent: what the command did, as a finished sentence
 *   ("Read voice-input.spec.ts lines 210–222", "Ran tests playwright a.spec.ts", "Waited 30s").
 *   `;`, `&&`, `||` and newlines split steps (never inside quotes, substitutions or heredoc bodies). The main step
 *   skips noise: preludes (`cd`, `export`, `set -e`, `true`), then `sleep`, `echo`, `mkdir` and a `git add` before a
 *   `git commit` when anything else runs. Loops, conditionals, `( … )` and `{ …; }` are described by their body;
 *   a `zsh -lc "…"` wrapper by its script.
 *   Function definitions (`t(){ …; }`) are not steps: a later call reads as the body's main step with the call's
 *   arguments, or `Ran [t] shell function`. `s=$(cmd)` alone describes `cmd`; `[ … ]` tests are noise beside real work.
 *   Safety: a step is only summarised as its first program when every later pipe stage is a pure filter (head, grep,
 *   sort, jq, …); piping into `sh`, `xargs`, `tee`, an interpreter or `sudo` — or a file-naming program given a
 *   `$(…)` / backtick / `<(…)` argument, or `find -exec` — reads as the raw command (kind 'shell', `raw: true`, chipped
 *   by its leading program; `shell` only when none is named or a shell reads a script). A fetch piped into an interpreter
 *   alone (`curl … | bash`, `| python3 -`) runs downloaded code; `| python3 -c "…"`, `| node -e`, `| jq` only read it.
 *   A literal `sleep` right before the leading step reads as `… · after 45s`.
 *   A read, search or listing whose output is redirected to a file says so ('→ results.txt').
 * testSummary(output) / testSummaryHtml(summary): see shell-intent-results.ts.
 * Handler tables live in shell-intent-files.ts, shell-intent-dev.ts and shell-intent-system.ts. */
import {
  afterOptions, argsSummary, basename, clip, desc, destroys, flagValue, hasFlag, helpDesc, isImagePath, isSubstitution, missingWrapper, monoObject, positionals, programName, set, stripPrefixes,
  tidyObject, withImage, withoutVariables, type Desc, type Handler, type Risk, type Segment, type ShellIntent, type Step,
} from './shell-intent-base.ts';
import { lex } from './shell-intent-lex.ts';
import { DELETERS, ECHO_HANDLERS, FILE_HANDLERS, filterPattern, findSeverity, withRedirect } from './shell-intent-files.ts';
import { DEV_HANDLERS, cargoTestBinary, isTestBinary, wrappedTests } from './shell-intent-dev.ts';
import { SYSTEM_HANDLERS } from './shell-intent-system.ts';
import { gh, git } from './shell-intent-git.ts';
import {
  RISK_HANDLERS, SEVERITY, emptied, isCriticalPath, isHomeConfig, isSystemPath, overwroteConfig, overwroteSystem, rankRisks, resolvePath, riskLine, risksOf, withCommandRisk,
  withRisks,
} from './shell-intent-risk.ts';
import {
  LEADING_KEYWORDS, closeSubshell, deeper, inLoop, locatedPath, loopsUsed, newContext, recordAssignments, recordCd, recordLoop, scopedScratch, sourceText, withVars,
  type Context, type Described, type Functions,
} from './shell-intent-context.ts';
import { editedFile, fedText, inlineText, languageOf, scriptRisks, shellCalls } from './shell-intent-scripts.ts';
import { ASSIGNMENT, GUARDS, PRELUDE, checkOf, counted, leadFailed, leadingSteps, mergedReads, noiseOf, notRunSteps, waitedBefore } from './shell-intent-lead.ts';

export { basename } from './shell-intent-base.ts';
export { SHELL_VERBS } from './shell-intent-base.ts';
export type { ShellIntent, ShellKind, ShellVerb } from './shell-intent-base.ts';
/** What the record knows beyond the command: its working directory (Codex `workdir`, Devin `workdir`), absolute. */
export interface ShellContext {
  cwd?: string;
  /** The command exited nonzero. Alone it never marks a step not run: only output blaming an earlier `&&` step does. */
  nonzero?: boolean;
}
export { formatDuration, testSummary, testSummaryHtml, type TestSummary } from './shell-intent-results.ts';
import { imageFailed } from './shell-intent-results.ts';

const MAX_INPUT = 20_000;
const MAX_DEPTH = 3;
const RAW_TEXT = 80;
const HANDLERS: Record<string, Handler> = { ...FILE_HANDLERS, ...ECHO_HANDLERS, ...DEV_HANDLERS, ...SYSTEM_HANDLERS, git, gh, ...RISK_HANDLERS };
const FEEDERS = set('echo', 'printf', 'cat', 'yes');
const SHELLS = set('sh', 'bash', 'zsh', 'dash', 'fish', 'ksh');
const SSH_VALUES = set('-p', '-i', '-l', '-o', '-F', '-J', '-L', '-R', '-D', '-E', '-b', '-c', '-e', '-m', '-O', '-Q', '-S', '-W', '-w', '-B', '-I');
/** Pipe stages that only reshape text; anything else after a pipe makes the step opaque. */
const FILTERS = set('head', 'tail', 'grep', 'egrep', 'fgrep', 'rg', 'sort', 'uniq', 'wc', 'jq', 'cut', 'tr', 'sed', 'awk', 'gawk', 'less', 'more',
  'cat', 'column', 'nl', 'fold', 'tac', 'rev');
/** Filters and readers whose redirected output reads as writing the file (searches and listings keep `→ file`). */
const WRITING_FILTERS = set('head', 'tail', 'sort', 'uniq', 'wc', 'jq', 'cut', 'tr', 'sed', 'awk', 'gawk', 'mawk', 'cat', 'column', 'nl', 'fold', 'tac', 'rev');
const OPENERS = set('if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{');
const WATCH_VALUES = set('-n', '--interval', '-d', '-q', '--equexit');
const RISK_TEXT = 160;
const CLOSERS = set('done', 'fi', 'esac', '}', 'for', 'case', 'select', 'function');

const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);
/** The command as written, chipped by its leading program (`Ran [lsof] lsof -i … | xargs kill`); `shell` when no program
 * is named (`$(which node) a.js`) or the program is a shell reading a script. */
const rawDesc = (text: string, words: string[] = []): Desc => {
  const first = commandWords(words)[0] ?? '';
  const named = first && !/^(?:\$\(|`)/.test(first) && !SHELLS.has(programName(first));
  return { ...desc('shell', 'Ran', named ? programLabel(first) : 'shell', clip(tidyObject(named ? withoutProgram(text, first) : text), RAW_TEXT)), raw: true };
};
/** `gh api x | jq` chipped `[gh]` reads `api x | jq`: the chip already names the program the text starts with. */
const withoutProgram = (text: string, first: string) => {
  const source = text.trim().replace(LEADING_KEYWORDS, '');
  return source.startsWith(first) && /^\s/.test(source.slice(first.length)) ? source.slice(first.length).trim() : text;
};
/** `$BIN`, `"${BIN}"`: a program held in a variable is named by the variable. */
const ASSIGNED = /^[A-Za-z_]\w*\+?=\$\((?!\()([\s\S]*)\)$/;
const VARIABLE = /^\$\{?([A-Za-z_]\w*)\}?$/;
const programLabel = (word: string) => clip(VARIABLE.test(word) ? word.replace(VARIABLE, '$$$1') : basename(word), 40);

function handlerFor(program: string): Handler | undefined {
  if (isTestBinary(program)) return cargoTestBinary;
  const key = /^python[\d.]*$/.test(program) ? 'python' : program === 'pip3' ? 'pip' : /^(?:mkfs(?:\..+)?|newfs_\w+)$/.test(program) ? 'mkfs' : program;
  return own(HANDLERS, key) ? HANDLERS[key] : undefined;
}

/** The words from the program on: `sudo -u x rm a` → `rm a`; a prefix run alone (`env`, `time`) is the program. */
function commandWords(words: string[]): string[] {
  const stripped = stripPrefixes(words);
  if (stripped.length) return stripped;
  const at = words.findIndex(word => !/^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/.test(word));
  return at < 0 ? [] : words.slice(at);
}

function classify(words: string[], seg: Segment): Desc | undefined {
  const [first = '', ...args] = commandWords(words);
  if (!first) return undefined;
  // `$(npm bin)/eslint`, `` `which node` a.js ``: a program found by a substitution is not named.
  if (/^(?:\$\(|`)/.test(first)) return rawDesc('');
  const program = programName(first);
  const help = helpDesc(program, programLabel(first), args);
  if (help) return help;
  // `cat $(git ls-files)`: never present a substitution as a file name; `rm -rf "$(pwd)"` still names the checkout.
  if (seg.substituted && own(FILE_HANDLERS, program) && !(DELETERS.has(program) && args.some(isCriticalPath))) return substitutedFiles(program, args);
  return handlerFor(program)?.(program, args, seg, classify) ?? wrappedTests(programLabel(first), args, seg, classify)
    ?? desc('shell', 'Ran', programLabel(first), clip(argumentText(first, args, seg), 60));
}

/** `e "a b" (c)`: an unknown program's arguments as written (quotes kept, redirections dropped), else its words in
 * short (`sp and 9 more args`). */
function argumentText(first: string, args: string[], seg: Segment): string {
  const words = withoutVariables(args.filter(arg => arg !== '--'));
  if (words.length > 4) return argsSummary(words);
  const text = seg.text ?? '';
  const at = text.indexOf(first);
  // `look.sh seams ${args[@]}`: an expansion is dropped, so the text as written can't be used.
  const expands = words.length < args.filter(arg => arg !== '--').length;
  if (!args.length || at < 0 || expands || seg.redirect || seg.input || seg.heredoc || /[\\\n]/.test(text)) return tidyObject(words.join(' '));
  return tidyObject(text.slice(at + first.length).trim()) || args.join(' ');
}

/** A file-naming program given a `$(…)`: the raw command, which loses data when the program deletes. */
function substitutedFiles(program: string, args: string[]): Desc {
  const raw = rawDesc('');
  if (!DELETERS.has(program) || program === 'dd') return raw;
  return destroys(raw, args.some(arg => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive') ? SEVERITY.tree : SEVERITY.other);
}

// ---------------------------------------------------------------- one step

function isFilter(seg: Segment): boolean {
  const [first = '', ...args] = seg.words;
  const program = programName(first);
  if (!FILTERS.has(program)) return false;
  if (program === 'sed') return !args.some(arg => /^-i/.test(arg) || /^--in-place/.test(arg));
  if (program === 'sort') return !args.some(arg => /^-o/.test(arg) || /^--output/.test(arg));
  return true;
}

/** `do cat "$f"` → `cat "$f"`; `done`, `fi`, `for f in …` → nothing. */
function bodyWords(words: string[]): string[] {
  let start = 0;
  while (start < words.length && OPENERS.has(words[start])) start++;
  if (CLOSERS.has(words[start] ?? '')) return [];
  let end = words.length;
  while (end > start && words[end - 1] === '}') end--;
  return words.slice(start, end);
}

function primaryIndex(pipes: Segment[]): number {
  const [first] = pipes;
  // `(printf a; sleep 8) | dsh`: the stages after a subshell read all of it; the subshell's last command leads nothing.
  if (first.group && pipes.length > 1) return 1;
  const program = programName(stripPrefixes(first.words)[0] ?? '');
  const feeds = FEEDERS.has(program) && (program !== 'cat' || first.words.length === 1) && !first.redirect;
  return feeds && pipes.length > 1 ? 1 : 0;
}

/** `bash -lc "…"`, `su root -c "…"`: the inner script. */
function shellWrapped(words: string[]): string | undefined {
  const [first = '', ...args] = stripPrefixes(words);
  const program = programName(first);
  if (program === 'su') return flagValue(args, ['-c', '--command']);
  // `eval "rm -rf x"`, `watch -n 5 rm -rf x`: both join their arguments into a shell command.
  if (program === 'eval') return args.join(' ') || undefined;
  if (program === 'watch') return afterOptions(args, WATCH_VALUES).join(' ') || undefined;
  if (!SHELLS.has(program)) return undefined;
  const flag = args.findIndex(arg => /^-[a-z]*c[a-z]*$/.test(arg));
  return flag >= 0 ? args[flag + 1] : undefined;
}

/** The risks of every step of a shell script (bounded by depth). */
function shellRisks(script: string, ctx: Context): Risk[] {
  return ctx.depth < MAX_DEPTH && script.trim() ? describeSteps(script, deeper(ctx)).flatMap(step => risksOf(step.desc)) : [];
}

/** A shell reading its script from stdin or a heredoc (`bash`, `bash -s`, `bash <<EOF`), not `bash -c` or `bash x.sh`. */
const readsStdin = (args: string[]) => args.includes('-s') || (!args.some(arg => /^-[a-z]*c[a-z]*$/.test(arg)) && !positionals(args, set('-o', '-O')).length);

/** An interpreter given its script inline (`-c`, `-e`, `-p`, `--eval`), as a module (`-m`) or as a file reads stdin as
 * data; only `python3`, `python3 -` or `node` alone runs what is piped in. */
const SCRIPT_GIVEN = /^-(?:[a-zA-Z]*[ce]|m|p|-eval|-print|-command)$/;
const runsStdin = (program: string, args: string[]) => SHELLS.has(program)
  ? readsStdin(args)
  : !args.some(arg => SCRIPT_GIVEN.test(arg)) && !positionals(args).some(arg => arg !== '-');

/** Risks of text fed to a shell or interpreter (`cat <<EOF | bash`, `echo … | python3`, `bash <<EOF`); undefined when nothing is fed. */
function feedRisks(pipes: Segment[], ctx: Context): Risk[] | undefined {
  let fed = false;
  const risks: Risk[] = [];
  pipes.forEach((pipe, index) => {
    const [first = '', ...args] = stripPrefixes(pipe.words);
    const program = programName(first);
    const shell = SHELLS.has(program);
    const language = shell ? undefined : languageOf(program);
    if ((!shell && !language) || (index === 0 && (!shell || !readsStdin(args)))) return;
    fed = true;
    const own = shell ? [shellWrapped(pipe.words) ?? '', pipe.body].join('\n') : inlineText(args, pipe);
    const before = index > 0 ? fedText(pipes[index - 1], stripPrefixes(pipes[index - 1].words)) : '';
    const body = [own, before].join('\n');
    risks.push(...(shell ? shellRisks(body, ctx) : scriptRisks(body, language ?? program, classify)));
  });
  return fed ? risks : undefined;
}

/** `find … | xargs rm -rf`: deletes whatever the first stage lists (nothing worth flagging when that is scratch). */
function xargsRisks(words: string[], pipes: Segment[], scope: Pick<Segment, 'scratch' | 'cwd'>): Risk[] {
  const deleter = words.slice(1).find(word => DELETERS.has(programName(word)));
  if (!deleter) return [];
  const [source = '', ...args] = stripPrefixes(pipes[0].words);
  const program = programName(source);
  const firstExpression = args.findIndex(arg => /^[-(!]/.test(arg));
  const paths = program === 'find' ? (firstExpression < 0 ? args : args.slice(0, firstExpression)) : [];
  const name = program === 'find' ? flagValue(args, ['-name', '-iname', '-path']) : program === 'fd' ? positionals(args)[0] : undefined;
  if ((program === 'find' || program === 'fd') && !findSeverity(paths.length ? paths : ['.'], name, scope)) return [];
  const recursive = words.some(word => /^-[a-zA-Z]*[rR]/.test(word));
  const text = clip(pipes.map(pipe => pipe.text || pipe.words.join(' ')).join(' | '), RISK_TEXT);
  return [{ text: riskLine(DELETES, text), severity: recursive ? SEVERITY.tree : SEVERITY.other }];
}


/** A destructive step's own risk reads as the command, as written (`git reset --hard origin/main`, `rm -rf ~/x`). */
function commandRisk(described: Desc | undefined, seg: Segment): Desc | undefined {
  return withCommandRisk(described, clip(sourceText(seg.text || seg.words.join(' ')), RISK_TEXT));
}

/** Risks of each pipe stage on its own (`rm -rf x | tee log`, `… | xargs rm`); fed shells are counted by feedRisks. */
function stageRisks(pipes: Segment[], ctx: Context): Risk[] {
  return pipes.flatMap(pipe => {
    const words = stripPrefixes(pipe.words);
    const program = programName(words[0] ?? '');
    if (SHELLS.has(program) || languageOf(program)) return [];
    const scoped = { ...pipe, scratch: scopedScratch(pipe.words, ctx.scratch), cwd: ctx.cwd };
    if (program === 'xargs') return xargsRisks(words, pipes, scoped);
    return risksOf(commandRisk(classify(words, scoped), pipe));
  });
}

/** Commands inside live `$(…)`, backticks, `<(…)` and unquoted heredoc bodies that lose data (never single-quoted or escaped text). */
function substitutionRisks(pipes: Segment[], ctx: Context): Risk[] {
  if (ctx.depth >= MAX_DEPTH) return [];
  return pipes.flatMap(pipe => pipe.subs).slice(0, 8).flatMap(text => shellRisks(text, ctx));
}

const FETCHERS = set('curl', 'wget', 'http', 'https', 'xh', 'fetch');
/** `source <(curl …)`, `. <(wget -qO- …)`: runs what the substitution prints in this shell. */
const SOURCES = set('source', '.');
const DELETES = 'Deletes files';
const DOWNLOADED = 'Runs a downloaded script';
const GENERATED = 'Runs generated code';
const fetches = (text: string) => /(?:^|[\s;|&(])(?:curl|wget|xh|https?)\s/.test(` ${text}`);
const isDynamic = (script: string | undefined, pipe: Segment) => !!script && pipe.subs.length > 0 && /^\s*(?:\$\((?!\()|`)/.test(script);

/** Code fetched or generated at run time and run by a shell: `curl … | bash`, `sh -c "$(…)"`, `bash <<< "$(…)"`,
 * `eval "$(curl …)"`. Nothing reads what it does, so it may do anything. */
function dynamicCodeRisks(pipes: Segment[]): Risk[] {
  return pipes.flatMap((pipe, index): Risk[] => {
    const words = stripPrefixes(pipe.words);
    const program = programName(words[0] ?? '');
    const runner = (SHELLS.has(program) || !!languageOf(program)) && runsStdin(program, words.slice(1));
    const source = index > 0 ? programName(stripPrefixes(pipes[index - 1].words)[0] ?? '') : '';
    if (runner && FETCHERS.has(source)) return [{ text: riskLine(DOWNLOADED, `${source} … | ${program}`), severity: SEVERITY.tree }];
    const evaluates = program === 'eval' || SOURCES.has(program);
    if (!evaluates && !SHELLS.has(program)) return [];
    const risk = (): Risk[] => [{ text: riskLine(pipe.subs.some(fetches) ? DOWNLOADED : GENERATED, clip(pipe.text || pipe.words.join(' '), RISK_TEXT)), severity: SEVERITY.tree }];
    if (evaluates) return pipe.subs.some(fetches) ? risk() : [];
    const script = readsStdin(words.slice(1)) ? pipe.body : shellWrapped(pipe.words);
    return isDynamic(script, pipe) ? risk() : [];
  });
}

const DOCKER_EXEC_VALUES = set('-u', '--user', '-w', '--workdir', '-e', '--env', '--env-file', '--detach-keys');
const KUBECTL_EXEC_VALUES = set('-n', '--namespace', '-c', '--container', '--context', '--kubeconfig', '-f', '--filename');

/** `docker exec [opts] c cmd`, `kubectl exec [opts] pod -- cmd`: `Ran in container [c] cmd`, carrying what `cmd` loses. */
function containerStep(program: string, args: string[], ctx: Context): Desc | undefined {
  if (ctx.depth >= MAX_DEPTH || (program !== 'docker' && program !== 'kubectl') || args[0] !== 'exec') return undefined;
  const rest = args.slice(1);
  const dash = rest.indexOf('--');
  const [target = ''] = positionals(dash >= 0 ? rest.slice(0, dash) : rest, program === 'docker' ? DOCKER_EXEC_VALUES : KUBECTL_EXEC_VALUES);
  const command = dash >= 0 ? rest.slice(dash + 1) : program === 'docker' && target ? rest.slice(rest.indexOf(target) + 1) : [];
  if (!command.length) return undefined;
  // The command is argv (no shell joins it), so a word with spaces stays one word: `sh -c 'rm -rf /app'`.
  const text = command.map(word => /^[\w@%+=:,./-]+$/.test(word) ? word : `'${word.replace(/'/g, `'\\''`)}'`).join(' ');
  const risks = describeSteps(text, deeper(ctx)).flatMap(step => risksOf(step.desc));
  return withRisks(desc('system', 'Ran in container', clip(target.replace(/^(?:pod|pods)\//, ''), 48), clip(text, 60), 'server'), risks);
}

/** `ssh host cmd`: `Ran on host: cmd`, carrying what the remote command loses. */
function remoteStep(program: string, args: string[], ctx: Context): Desc | undefined {
  if (program !== 'ssh') return containerStep(program, args, ctx);
  if (ctx.depth >= MAX_DEPTH) return undefined;
  const [host = ''] = positionals(args, SSH_VALUES);
  const command = host ? args.slice(args.indexOf(host) + 1) : [];
  if (!command.length) return undefined;
  const text = command.join(' ');
  const steps = describeSteps(text, deeper(ctx));
  const risks = steps.flatMap(step => risksOf(step.desc));
  // `ssh vm 'until curl …; do sleep 2; done'`: a remote wait reads as the wait.
  const lead = leadingSteps(steps)[0]?.desc;
  if (lead?.kind === 'wait' && lead.verb === 'Waited for') return withRisks(lead, risks);
  return withRisks(desc('system', 'Ran on', clip(host.replace(/^[^@]*@/, ''), 48), clip(text, 60), 'server'), risks);
}

/** A call of a function defined earlier reads as its body (`Captured simulator screenshot [simctl io] one`) with the
 * call's arguments, or as `Ran [name] shell function` when the body says nothing a row can show. */
function functionCall(name: string, args: string[], functions: Functions): Desc | undefined {
  const body = functions.get(name);
  if (!body) return undefined;
  const main = (body.find(step => step.desc.destructive) ?? body[0])?.desc;
  // `println!("{}", x)` pasted from Rust: a "program" no command is named like says nothing a row can show.
  const garbled = main?.kind === 'shell' && main.verb === 'Ran' && !/^[\w.@+-][\w./@+-]*$/.test(main.label);
  if (!main || main.raw || garbled || (main.kind === 'shell' && main.label === 'shell') || main.label.includes('$')) {
    return withRisks(desc('shell', 'Ran', clip(name, 40), 'shell function'), body.flatMap(step => risksOf(step.desc)));
  }
  return { ...main, object: clip(args.join(' '), 60) };
}

/** `> f`, `: > f`, `true > f`: the file is emptied. */
function truncation(step: Step, ctx: Context): Described | undefined {
  const [only, ...others] = step.pipes;
  if (others.length || !only.redirect || only.append || only.words.length > 1 || !/^(?::|true)?$/.test(only.words[0] ?? '')) return undefined;
  const scope = { ...only, scratch: ctx.scratch, cwd: ctx.cwd };
  return { program: 'truncate', desc: commandRisk(emptied(only.redirect, scope), { ...only, text: step.text }) ?? emptied(only.redirect, scope) };
}

const samePath = (a: string, b: string) => a.replace(/^\.\//, '') === b.replace(/^\.\//, '');

/** `head -n 5 a.txt > a.txt`, `sort < a > a`: the shell empties the file before the step reads it. */
function overwritesInput(pipes: Segment[]): string | undefined {
  const target = [...pipes].reverse().find(pipe => pipe.redirect);
  if (!target || target.append || pipes.some(pipe => ECHO_HANDLERS[programName(stripPrefixes(pipe.words)[0] ?? '')])) return undefined;
  const reads = pipes.some(pipe => samePath(pipe.input, target.redirect) || stripPrefixes(pipe.words).slice(1).some(word => samePath(word, target.redirect)));
  return reads ? target.redirect : undefined;
}

/** `until grep -q ready log`, `while ! curl …`: the loop's condition is what it waited for. */
function waitFor(described: Desc, words: string[]): Desc {
  const pattern = described.kind === 'search' ? /^for (".*?")(?: in |$)/.exec(described.object)?.[1] : undefined;
  const object = pattern ? `to contain ${pattern}`
    : described.kind === 'fetch' && !/\bresponds$/.test(described.object) ? [described.object, 'responds'].filter(Boolean).join(' ')
    : described.object === 'exists' ? 'to exist' : described.object === 'does not exist' ? 'to be gone' : processWait(described.object, words);
  return withRisks(desc('wait', 'Waited for', described.label, object), risksOf(described));
}

/** `while kill -0 P` (or `until ! kill -0 P`) waits for P to exit; `until kill -0 P` (or `while ! kill -0 P`) for it to run. */
const processWait = (object: string, words: string[]) => object !== 'is running' ? object : (words[0] === 'while') !== (words[1] === '!') ? 'to exit' : 'to be running';

/** `while kill -0 $PID; do sleep 1; done`: polls until the process exits. */
const probesProcess = (words: string[]) => words[0] === 'while' && programName(words[1] ?? '') === 'kill' && words.includes('-0');
const isWaitLoop = (words: string[]) => words[0] === 'until' || (words[0] === 'while' && words[1] === '!') || probesProcess(words);
const firstBodyWord = (step: Step | undefined) => step ? bodyWords(step.pipes[0].words)[0] ?? '' : '';
const LOOP_HEADS = set('for', 'while', 'until');

/** Steps that end a polling loop when they succeed (`grep -q X f && break`, `if curl …; then break; fi`) in a loop that
 * sleeps between tries; a loop without a sleep is a search that stops early. */
function pollConditions(steps: Step[]): Set<number> {
  const out = new Set<number>();
  steps.forEach((step, i) => {
    const after = steps[i + 1];
    const words = step.pipes[0].words;
    const head = words.slice(words.findIndex(word => !/^(?:do|then|else|\{)$/.test(word)) >>> 0);
    const guarded = step.next?.trim() === '&&' || (head[0] === 'if' && head[1] !== '!');
    if (!guarded || !after || !breaksAfter(steps, i)) return;
    let start = i, end = i;
    while (start > 0 && !LOOP_HEADS.has(steps[start].pipes[0].words[0] ?? '')) start--;
    while (end < steps.length - 1 && steps[end].pipes[0].words[0] !== 'done') end++;
    if (steps.slice(start, end + 1).some(other => firstBodyWord(other) === 'sleep')) out.add(i);
  });
  return out;
}

/** `grep -q X f && break`, `grep -q X f && tail f | tail -30 && break`: an `&&` chain from step `i` that ends in `break`. */
function breaksAfter(steps: Step[], i: number): boolean {
  for (let j = i + 1; j < steps.length && (j === i + 1 || steps[j - 1].next?.trim() === '&&'); j++) {
    if (bodyWords(steps[j].pipes[0].words).join(' ') === 'break') return true;
  }
  return false;
}

/** `s=$(gh run view 4 --json status)`: an assignment alone runs its substitution (a `mktemp` is only scratch). */
function assignmentStep(seg: Segment, ctx: Context): Described[] {
  const assigned = ctx.depth < MAX_DEPTH && seg.subs.length ? seg.words.map(word => ASSIGNED.exec(word)?.[1]).find(Boolean) : undefined;
  return !assigned || /^\s*mktemp\b/.test(assigned) ? [] : describeSteps(assigned, deeper(ctx));
}

const MAX_STAGES = 64;

/** `a | a | … | rm -rf x`: past MAX_STAGES pipe stages only the first ones and the last are examined (each stage costs a
 * classification and a variable pass), so a hostile pipeline stays linear and its final stage still counts. */
function capStages(step: Step): Step {
  return step.pipes.length <= MAX_STAGES ? step : { ...step, pipes: [...step.pipes.slice(0, MAX_STAGES - 1), step.pipes[step.pipes.length - 1]] };
}

function describeStep(uncapped: Step, ctx: Context, polls = false): Described[] {
  const given = capStages(uncapped);
  recordLoop(given, ctx);
  const loops = loopsUsed(given, ctx);
  const step = withVars(given, ctx);
  recordCd(step, ctx);
  try {
    return describeBody(step, ctx, polls).map(({ program, desc: described }) => ({ program, desc: inLoop(described, loops, given.text, program) }));
  } finally {
    closeSubshell(step, ctx);
  }
}

/** The step's descriptions, the first also carrying any code it runs unseen (`curl … | bash`). */
function describeBody(step: Step, ctx: Context, polls: boolean): Described[] {
  const described = describeWork(step, ctx, polls);
  const dynamic = dynamicCodeRisks(step.pipes);
  if (!dynamic.length) return described;
  const [first, ...rest] = described.length ? described : [{ program: 'shell', desc: rawDesc(step.text, step.pipes[0].words) }];
  return [{ ...first, desc: withRisks(first.desc, dynamic) }, ...rest];
}

function describeWork(step: Step, ctx: Context, polls: boolean): Described[] {
  const truncated = truncation(step, ctx);
  if (truncated) return [truncated];
  recordAssignments(step, ctx);
  const head = { ...step.pipes[0], words: bodyWords(step.pipes[0].words) };
  if (!head.words.length) return [];
  const waited = step.pipes.length === 1 ? substitutionWait(step.pipes[0].words, ctx) : undefined;
  if (waited) return [{ program: 'until', desc: waited }];
  const pipes = [head, ...step.pipes.slice(1)];
  const index = primaryIndex(pipes);
  const seg = { ...pipes[index], scratch: scopedScratch(pipes[index].words, ctx.scratch), cwd: ctx.cwd };
  const [first = '', ...args] = commandWords(seg.words);
  if (!first) return assignmentStep(seg, ctx).map(step => ({ ...step, program: ASSIGNMENT }));
  const program = programName(first);
  const fed = feedRisks(pipes, ctx);
  if (!readsFetched(pipes, index) && (fed || !pipes.slice(index + 1).every(isFilter))) {
    const risks = [...(fed ?? []), ...stageRisks(pipes, ctx), ...substitutionRisks(pipes, ctx)];
    return [{ program, desc: withRisks(rawDesc(pipedText(step, pipes, index), pipes[index].words), risks) }];
  }
  const called = ctx.functions.has(first) ? functionCall(first, args, ctx.functions) : undefined;
  if (called) return [{ program: first, desc: called }];
  const inner = ctx.depth < MAX_DEPTH ? shellWrapped(seg.words) : undefined;
  if (inner !== undefined) return describeSteps(inner, deeper(ctx));
  const classified = remoteStep(program, args, ctx) ?? commandRisk(classify(seg.words, seg), seg);
  if (!classified) return [];
  const described = imageIn(classified, seg);
  const finished = withRisks(finishStep(step, pipes, index, described, seg), substitutionRisks(pipes, ctx));
  const result = finished.producedImage ? withLocatedImage(finished, ctx) : finished;
  const waits = (polls || isWaitLoop(step.pipes[0].words)) && !result.raw && !PRELUDE.has(program);
  return [{ program, desc: waits ? waitFor(result, step.pipes[0].words) : result }];
}

/** The step as written, from the stages after a subshell when they lead (`dsh --x | head`, never `8) | dsh …`). */
const pipedText = (step: Step, pipes: Segment[], index: number) => pipes[0].group && index > 0 ? pipes.slice(index).map(pipe => pipe.text ?? '').join(' | ') : step.text;

function finishStep(step: Step, pipes: Segment[], index: number, described: Desc, seg: Segment): Desc {
  const cwd = seg.cwd;
  if (described.raw) return withRisks(rawDesc(pipedText(step, pipes, index), seg.words), risksOf(described));
  const overwritten = overwritesInput(pipes);
  if (overwritten) return destroys(desc('file', 'Overwrote', clip(basename(overwritten), 48), '', 'edit'), 1, riskLine('Overwrites a file', clip(step.text, RISK_TEXT)));
  const target = [...pipes].reverse().find(pipe => pipe.redirect);
  const redirect = target?.redirect ?? '';
  // `curl … > ~/.zshrc`: a dotfile or setting replaced by whatever the step prints.
  if (target && !target.append && isHomeConfig(redirect)) return overwroteConfig(redirect, clip(sourceText(step.text), RISK_TEXT));
  if (target && isSystemPath(redirect)) return overwroteSystem(redirect, target.append ? 'Appended to' : 'Overwrote', clip(sourceText(step.text), RISK_TEXT));
  // `sed 's#a#b#g' run.sh > run2.sh`, `jq . a.json > b.json`: a filter's output written to a file is that file's new text.
  if (target && (described.kind === 'read' || described.kind === 'shell') && WRITING_FILTERS.has(programName(commandWords(seg.words)[0] ?? ''))) {
    return withRisks(desc('file', target.append ? 'Appended to' : 'Wrote', clip(basename(redirect), 48), '', 'edit'), risksOf(described));
  }
  // `curl … > a.png`: stdout written to an image file is the image the step made (as tool_images_auth/shell.rs reads it).
  const redirected = target && !described.producedImage && isImagePath(redirect) ? resolvePath(redirect, cwd) : undefined;
  return withImage(withRedirect(withMatching(withRange(described, pipes[index + 1]), pipes.slice(index + 1)), redirect), described.producedImage ?? redirected);
}

/** The image a step made, located absolutely (see locatedPath), or none when it can't be. */
function withLocatedImage(described: Desc, ctx: Context): Desc {
  const producedImage = locatedPath(described.producedImage, ctx);
  return producedImage ? { ...described, producedImage } : { ...described, producedImage: undefined };
}

/** `curl … | python3 -c "…json.load(sys.stdin)…"`, `| python3 -m json.tool`, `| node -e`: a fetch whose body only filters
 * and inline scripts read (no script file, no writes, no commands, nothing deleted) stays `Fetched host`. */
function readsFetched(pipes: Segment[], index: number): boolean {
  const program = programName(commandWords(pipes[index].words)[0] ?? '');
  return FETCHERS.has(program) && pipes.length > index + 1 && pipes.slice(index + 1).every(stage => isFilter(stage) || inlineReader(stage));
}

function inlineReader(seg: Segment): boolean {
  const [first = '', ...args] = stripPrefixes(seg.words);
  const program = programName(first);
  const language = languageOf(program);
  if (!language || runsStdin(program, args)) return false;
  const module = flagValue(args, ['-m']);
  if (module !== undefined) return module === 'json.tool' && !positionals(args, set('-m')).length;
  if (!args.some(arg => SCRIPT_GIVEN.test(arg))) return false;
  const text = inlineText(args, seg);
  return !editedFile(text) && !shellCalls(text).length && !scriptRisks(text, language, classify).length;
}

/** `until [ "$(gh run view 4 --json status -q .status)" = completed ]`, `while [ "$(cat s)" != done ]`: the loop waited for
 * the substitution's value (`Waited for [run 4] to be completed`), carrying what the substitution loses. */
function substitutionWait(words: string[], ctx: Context): Desc | undefined {
  const [loop = '', open = '', left = '', op = '', right = '', close, ...extra] = words;
  const awaited = (loop === 'until' && (op === '=' || op === '==')) || (loop === 'while' && op === '!=');
  if (!awaited || !GUARDS.has(open) || extra.length || (close !== undefined && close !== ']' && close !== ']]') || ctx.depth >= MAX_DEPTH) return undefined;
  const [sub, value] = SUBSTITUTED.test(left) ? [left, right] : SUBSTITUTED.test(right) ? [right, left] : [];
  const inner = sub ? SUBSTITUTED.exec(sub)?.[1].trim() : undefined;
  if (!inner || value === undefined || isSubstitution(value)) return undefined;
  const steps = describeSteps(inner, deeper(ctx));
  return withRisks(desc('wait', 'Waited for', waitLabel(inner), `to be ${clip(value, 40)}`), steps.flatMap(step => risksOf(step.desc)));
}
const SUBSTITUTED = /^\$\((?!\()([\s\S]+)\)$/;

/** `gh run view 4 …` → `run 4`, `gh pr checks 82 …` → `PR 82`; any other command as written (short). */
function waitLabel(command: string): string {
  const run = /^gh\s+run\s+(?:view|watch)\s+(\d+)/.exec(command);
  const pr = /^gh\s+pr\s+(?:view|checks)\s+(\d+)/.exec(command);
  return run ? `run ${run[1]}` : pr ? `PR ${pr[1]}` : clip(tidyObject(command), 40);
}

/** `rg --files src | sort | rg shell` → `Listed [files] in src matching shell`; `ps aux | grep vite` →
 * `Checked processes matching [vite]`. */
function withMatching(described: Desc, later: Segment[]): Desc {
  const processes = described.kind === 'process' && described.verb === 'Checked processes' && described.label === 'ps' && !described.object;
  const files = described.kind === 'list' && described.label === 'files' && !described.object.includes('matching');
  if (!processes && !files) return described;
  const pattern = later.map(seg => { const [first = '', ...args] = seg.words; return filterPattern(programName(first), args); }).find(Boolean);
  if (!pattern) return described;
  if (processes) return { ...described, verb: 'Checked processes matching', label: clip(pattern, 40) };
  return { ...described, object: [described.object, `matching ${clip(pattern, 40)}`].filter(Boolean).join(' ') };
}

/** `chrome --headless --screenshot=/tmp/a.png url`: the image a step writes, resolved against the last literal `cd`. */
function imageIn(described: Desc, seg: Segment): Desc {
  const flag = described.producedImage ? undefined : flagValue(seg.words, ['--screenshot']);
  const found = withImage(described, flag);
  const path = found.producedImage;
  return path ? { ...found, producedImage: resolvePath(path, seg.cwd) } : found;
}

/** `cat a.ts | head -5` → `lines 1–5`; `grep -n "" f | sed -n '9,14p'` → `lines 9–14`; `nl -ba f | tail -n 20` → `last 20 lines`. */
function withRange(described: Desc, next: Segment | undefined): Desc {
  if (!next || described.kind !== 'read' || described.verb !== 'Read' || described.object) return described;
  const [first = '', ...args] = next.words;
  const program = programName(first);
  const count = (flagValue(args, ['-n', '--lines']) ?? args.map(arg => /^-(\d+)$/.exec(arg)?.[1]).find(Boolean) ?? '').replace(/^[+-]/, '');
  if (program === 'head' && /^\d+$/.test(count)) return { ...described, object: `lines 1–${count}` };
  if (program === 'tail' && /^\d+$/.test(count)) return { ...described, object: `last ${count} lines` };
  if (program !== 'sed' || !hasFlag(args, '-n')) return described;
  const range = /^(\d+)(?:,(\d+))?p$/.exec((positionals(args, set('-e'))[0] ?? flagValue(args, ['-e']) ?? '').trim());
  return range ? { ...described, object: range[2] ? `lines ${range[1]}–${range[2]}` : `line ${range[1]}` } : described;
}

const NAME = /^[A-Za-z_][\w.:-]*$/;

/** `name() {`, `name(){`, `name () {`, `function name {`: the function's name and the words after the header. */
function functionHeader(step: Step): { name: string; rest: string[] } | undefined {
  const words = step.pipes[0].words;
  let start = 0;
  while (start < words.length && OPENERS.has(words[start]) && words[start] !== '{') start++;
  const [w0 = '', w1 = '', ...more] = words.slice(start);
  if (w0 === 'function' && NAME.test(w1.replace(/\($/, ''))) return { name: w1.replace(/\($/, ''), rest: more };
  if (w0.endsWith('(') && NAME.test(w0.slice(0, -1))) return { name: w0.slice(0, -1), rest: [w1, ...more].filter(Boolean) };
  if (NAME.test(w0) && emptyParens(step.text, w0)) return { name: w0, rest: [w1, ...more].filter(Boolean) };
  return undefined;
}

const MAX_PARENS = 16;

/** `name ()` or `name  ( )` in the step's text, `name` starting a word: the header of a function definition. Looks back
 * from the first few `(` only, so a long word repeated many times never costs a search per occurrence. */
function emptyParens(text: string, name: string): boolean {
  let open = text.indexOf('(');
  for (let seen = 0; open >= 0 && seen < MAX_PARENS; seen++, open = text.indexOf('(', open + 1)) {
    if (!/^\s*\)/.test(text.slice(open + 1, open + 8))) continue;
    const before = text.slice(0, open).trimEnd();
    const at = before.length - name.length;
    if (at >= 0 && before.endsWith(name) && (at === 0 || /\s/.test(before[at - 1]))) return true;
  }
  return false;
}

const braceDelta = (step: Step) => step.pipes.reduce((sum, pipe) => sum + pipe.words.filter(w => w === '{').length - pipe.words.filter(w => w === '}').length, 0);

/** Definitions are not rows: their bodies are remembered for later calls (`t(){ axe tap …; }; t 44 664`). */
function describeSteps(command: string, ctx: Context): Described[] {
  const steps = withinBudget(lex(command), ctx);
  const polls = pollConditions(steps);
  const dead = deadSteps(steps);
  const out: Described[] = [];
  for (let i = 0; i < steps.length; i++) {
    const header = functionHeader(steps[i]);
    const gated = i > 0 && steps[i - 1].next?.trim() === '&&';
    if (!header) { out.push(...describeStep(steps[i], ctx, polls.has(i)).map(step => gate(dead.has(i) ? neverRuns(step) : step, gated))); continue; }
    const first: Step = { ...steps[i], pipes: [{ ...steps[i].pipes[0], words: header.rest }, ...steps[i].pipes.slice(1)] };
    const body = [first];
    let open = header.rest[0] === '{' ? braceDelta(first) : 0;
    while (open > 0 && i + 1 < steps.length) { i++; body.push(steps[i]); open += braceDelta(steps[i]); }
    const described = body.flatMap(step => describeStep(step, ctx));
    ctx.functions.set(header.name, described.filter((step, index) => noiseOf(step, described, index) === 0));
  }
  return out;
}

/** The steps the shared budget still allows; the rest are dropped and the row falls back to the command as written. */
function withinBudget(steps: Step[], ctx: Context): Step[] {
  const allowed = Math.max(0, Math.min(steps.length, ctx.budget.left));
  if (allowed < steps.length) ctx.budget.exhausted = true;
  ctx.budget.left -= allowed;
  return allowed < steps.length ? steps.slice(0, allowed) : steps;
}

const ALWAYS = set('true', ':');
const NEVER = set('false');

/** `true || x`, `false && x`: steps the shell skips, since the step before them already decided the chain. */
function deadSteps(steps: Step[]): Set<number> {
  const out = new Set<number>();
  steps.forEach((step, i) => {
    const words = step.pipes.length === 1 ? step.pipes[0].words : [];
    const op = step.next?.trim();
    const decided = words.length === 1 && ((ALWAYS.has(words[0]) && op === '||') || (NEVER.has(words[0]) && op === '&&'));
    if (!decided) return;
    for (let j = i + 1; j < steps.length; j++) {
      out.add(j);
      if (steps[j].next?.trim() !== op) break;
    }
  });
  return out;
}

/** A step that only runs when the step before it succeeded (`a && b`). */
const gate = (step: Described, gated: boolean): Described => gated ? { ...step, gated: true } : step;

/** A step the shell skips makes no image; its risks stay, but it never leads or badges the row (notRunSteps). */
const neverRuns = (step: Described): Described => ({ ...step, dead: true, desc: step.desc.producedImage ? { ...step.desc, producedImage: undefined } : step.desc });

// ---------------------------------------------------------------- the main step

/** `$COOKIES`, `${OUT_FILE}`: a chip that is only a variable reads as its name in words (`cookies`, `out file`); a name
 * too short to say anything (`$F`, `$DB`) and a program held in a variable (kind 'shell', `$BIN`) stay as written. */
const BARE_LABEL = /^\$\{?([A-Za-z_]\w*)\}?$/;
/** `${k}_*.jpg` → `$k_*.jpg`, `f_$(printf %03d $t).jpg` → `f_….jpg`: a chip never shows expansion syntax. */
function tidyLabel(label: string, kind: string): string {
  const bare = kind === 'shell' ? undefined : BARE_LABEL.exec(label)?.[1];
  if (bare && bare.length > 2) return bare.toLowerCase().replace(/_/g, ' ');
  return label.replace(/\$\{(\w+)[^}]*\}?/g, '$$$1').replace(/\$\((?:[^()]|\([^()]*\))*\)?|`[^`]*`?/g, '…');
}

function fallbackIntent(title: string): ShellIntent {
  return { ...desc('shell', 'Ran', 'shell'), title, steps: 0, mono: false, destructive: false, risks: [] };
}

/** Codex records `/bin/zsh -lc "…"\nWorking directory: /repo`; the directory line is not a step. */
const WORKING_DIRECTORY = '\nWorking directory: ';

/** The command without Codex's trailing directory line (found from the end, never by a regex over the whole text), and that directory. */
function splitWorkingDirectory(text: string): { command: string; cwd?: string } {
  const at = text.lastIndexOf(WORKING_DIRECTORY);
  const cwd = at >= 0 ? text.slice(at + WORKING_DIRECTORY.length).trim() : '';
  return at >= 0 && !cwd.includes('\n') ? { command: text.slice(0, at), cwd: cwd || undefined } : { command: text };
}

/** The recorder cuts long inputs at 4 KB with a `[Preview truncated]` tail; it is not part of the command. */
const CUT_MARK = '[Preview truncated';
function withoutCutTail(text: string): string {
  const at = text.lastIndexOf(CUT_MARK);
  return at >= 0 && /^[^\]\n]*\]\s*$/.test(text.slice(at + CUT_MARK.length)) ? text.slice(0, at).trimEnd() : text;
}

/** What `command` did. A test step leads its compound; given the output, the one whose runner summarised it does.
 * `context.cwd` (else a Codex `Working directory` line) locates relative images; without one they are left unknown. */
export function describeShell(command: string, output?: string, context?: ShellContext): ShellIntent {
  const { command: text, cwd } = splitWorkingDirectory(withoutCutTail(typeof command === 'string' ? command.slice(0, MAX_INPUT) : ''));
  const title = text.trim();
  try {
    const ctx = newContext(typeof context?.cwd === 'string' && context.cwd ? context.cwd : cwd);
    const all = describeSteps(title, ctx);
    if (ctx.budget.exhausted) return tooLong(title, all);
    return summarize(title, all, output) ?? fallbackIntent(title);
  } catch {
    return fallbackIntent(title);
  }
}

/** `Ran [node] "a b.js" | tee x.log`, `Ran [foo] "x y"`: arguments as written are code even when they open with a quote,
 * so the row never curls them. */
const isCommandText = (lead: Desc) => !!lead.object && (!!lead.raw || (lead.kind === 'shell' && lead.verb === 'Ran'));

/** `0123456789abcdef…` (a full 40-character commit hash) → `0123456`, as git abbreviates it. */
const shortHashes = (text: string) => text.replace(/\b([0-9a-f]{7})[0-9a-f]{33}\b/g, '$1');

/** The row for described steps: the leading one, its count of the rest, every risk and the last image made. Destructive
 * steps after a failed `&&` step (notRunSteps) never ran: they keep their risks but neither lead nor badge the row. */
function summarize(title: string, all: Described[], output?: string): ShellIntent | undefined {
  const skipped = notRunSteps(all, typeof output === 'string' ? output : '');
  const ran = skipped.size ? all.filter(step => !skipped.has(step)) : all;
  const chosen = leadingSteps(ran, typeof output === 'string' ? output : '');
  if (!chosen.length) return undefined;
  const merged = mergedReads(chosen);
  const lead = merged ?? chosen[0].desc;
  const { kind, verb, icon } = lead;
  const risks = rankRisks(all.flatMap(step => risksOf(step.desc)));
  const live = skipped.size ? ran.some(step => risksOf(step.desc).length) : risks.length > 0;
  const counts = counted(lead.label, tidyObject(lead.object), merged ? 0 : chosen.length - 1 + skipped.size, lead.kind === 'script');
  const { note } = counts, shownLabel = shortHashes(counts.label), object = shortHashes(counts.object);
  const text = [object, waitedBefore(all, chosen[0]), note].filter(Boolean).join(' · ');
  const made = all.map(step => step.desc.producedImage).filter(Boolean).pop();
  // `screencapture …; echo sc=$?` printing `could not create image`: no image, and a capture that led failed.
  const unmade = !!made && typeof output === 'string' && imageFailed(output, title);
  const producedImage = unmade ? undefined : made;
  const intent: ShellIntent = { kind, verb, label: tidyLabel(shownLabel, kind), icon, object: text, title, steps: chosen.length, mono: isCommandText(lead) || monoObject(lead), destructive: live, risks };
  const check = merged ? undefined : checkOf(lead, output);
  const failed = unmade && !!lead.producedImage;
  const missing = typeof output === 'string' ? missingWrapper(title, output) : undefined;
  const blamed = !merged && typeof output === 'string' && leadFailed(chosen[0], all, output);
  return { ...intent, ...(missing ? { missing } : {}), ...(blamed ? { leadFailed: true as const } : {}), ...(lead.raw ? { raw: true } : {}), ...(producedImage ? { producedImage } : {}), ...(check ? { check } : {}), ...(failed ? { failed: true as const } : {}), ...(skipped.size ? { notRun: true as const } : {}) };
}

/** A compound past the step budget reads as the command as written, still naming the risks of the steps it checked. */
function tooLong(title: string, all: Described[]): ShellIntent {
  const lead = rawDesc(title, title.slice(0, 200).trim().split(/\s+/));
  const risks = rankRisks(all.flatMap(step => risksOf(step.desc)));
  return { ...lead, title, steps: all.length, mono: true, destructive: risks.length > 0, risks, raw: true };
}
