/* Shared types and argument helpers for shell-intent.ts and its handler tables (src/shell-intent-*.ts).
 * Pure and total: nothing here throws or touches the DOM. */
import { basename, clip } from './tool-text.ts';

export type ShellKind = 'read' | 'search' | 'list' | 'test' | 'typecheck' | 'build' | 'install' | 'git' | 'github' | 'wait' | 'fetch' | 'script' | 'db'
  | 'file' | 'process' | 'media' | 'system' | 'shell';

/** Every finished verb describeShell can produce. `desc()` only accepts these, so tsc keeps the list complete;
 * tool-trace-intent.ts turns each into its running form (`Deleted` → `Deleting`) and tool-trace.ts into `Couldn't delete`. */
export const SHELL_VERBS = [
  'Ran', 'Ran tests', 'Ran script', 'Ran tar', 'Ran container', 'Ran in container', 'Reran',
  'Read', 'Counted', 'Counted lines in', 'Searched', 'Listed', 'Listed archive', 'Listed containers', 'Listed images', 'Listed simulators',
  'Edited', 'Wrote', 'Appended to', 'Deleted', 'Moved', 'Copied', 'Changed owner of', 'Made executable', 'Set permissions', 'Hashed',
  'Checked', 'Checked out', 'Checked processes', 'Checked open files', 'Checked disk usage', 'Extracted', 'Archived', 'Compressed',
  'Typechecked', 'Linted', 'Built', 'Cleaned', 'Installed', 'Removed', 'Removed image', 'Locked',
  'Waited', 'Fetched', 'Queried', 'Called', 'Stopped', 'Started', 'Restarted', 'Inspected', 'Signed in to', 'Viewed logs of',
  'Probed', 'Encoded', 'Captured screenshot', 'Opened', 'Located',
  'Diffed', 'Viewed', 'Viewed history', 'Showed', 'Committed', 'Pushed', 'Pulled', 'Switched to', 'Staged', 'Stashed', 'Merged', 'Rebased', 'Rebased onto', 'Untracked',
  'Reset', 'Restored', 'Tagged', 'Cloned', 'Cherry-picked', 'Created', 'Commented on', 'Closed', 'Reopened', 'Reviewed', 'Watched',
  'Booted simulator', 'Shut down simulator', 'Erased simulator', 'Created simulator', 'Deleted simulator', 'Installed on simulator',
  'Uninstalled from simulator', 'Launched on simulator', 'Stopped app on simulator', 'Spawned on simulator', 'Opened on simulator', 'Captured simulator screenshot',
  'Recorded simulator video', 'Set simulator status bar', 'Set simulator privacy', 'Sent push to simulator', 'Added media to simulator',
  'Set simulator appearance', 'Located app on simulator',
  // Destructive steps (ShellIntent.destructive) and wait loops.
  'Force-pushed', 'Deleted branch', 'Deleted remote branch', 'Deleted tag', 'Dropped stash', 'Dropped all stashes', 'Discarded changes in',
  'Overwrote', 'Emptied', 'Truncated', 'Shredded', 'Formatted', 'Waited for',
  'Ran on', 'Synced (deleting extras)', 'Deleted from git', 'Rewrote history', 'Deleted ref', 'Expired reflog', 'Pruned', 'Listed worktrees',
  'Added worktree', 'Removed worktree', 'Erased', 'Destroyed', 'Changed database', 'Sent keys to', 'Inspected binary', 'Ran accessibility check',
  'Hard-reset to', 'Reset to', 'Showed help for', 'Checked version of', 'Stopped processes matching', 'Shut down', 'Rebooted', 'Unpublished',
  'Processed', 'Resized image', 'Converted', 'Initialized', 'Looked up', 'Dropped database', 'Previewed cleaning',
  'Listed changed files', 'Checked processes matching', 'Applied', 'Started preview server',
  'Compared', 'Started dev server', 'Checked ignore rules', 'Found merge base', 'Listed tracked files',
  'Created folder', 'Created branch', 'Renamed branch to', 'Applied stash', 'Sent DELETE to', 'Tapped', 'Swiped', 'Typed', 'Pressed', 'Resolved', 'Linked', 'Symlinked',
] as const;
export type ShellVerb = typeof SHELL_VERBS[number];

export interface ShellIntent {
  kind: ShellKind;
  /** Finished verb: 'Read', 'Searched', 'Ran tests', 'Typechecked', 'Waited', … */
  verb: ShellVerb;
  /** Chip text: a file basename, 'playwright', 'git status', a domain, … */
  label: string;
  /** Full hover text (the command as given). */
  title: string;
  /** The short rest of the sentence: 'lines 210–222', 'for "foo" in src', '30s', '· +2 more commands'. */
  object: string;
  /** An icon name from src/dom.ts. */
  icon: string;
  /** The object is command text, a path or arguments (drawn monospace) rather than prose (`lines 1–20`, `"Fix it"`). */
  mono: boolean;
  /** Meaningful sub-commands (a `cd` prelude, `echo` or a `sleep` beside other work does not count). */
  steps: number;
  /** The row's step loses data or work (`rm`, `git reset --hard`, `git push -f`, `> file`, …); a compound command
   * leads with its first destructive step, so this is true whenever any step is destructive. */
  destructive: boolean;
  /** Short descriptions of every destructive step ('Force-pushed origin main', 'Deleted src'), highest severity first;
   * empty when nothing is destructive. The row leads with the first. */
  risks: string[];
  /** The image file a step writes (`screencapture a.png`, `sips … --out b.png`, `ffmpeg … out.png`), as written or
   * resolved against the last literal `cd`; the last one when several steps write images. */
  producedImage?: string;
  /** The row is the command as written (opaque: piped into a non-filter, `find -exec`, a fed script); its chip is the
   * leading program, or `shell` when none is named. */
  raw?: boolean;
  /** The leading step is a typecheck or test run and the output was given: whether its output shows it failed
   * (`error TS…`, `error[E…]`, a failing test summary). A failed check leads its compound. */
  check?: ShellCheck;
  /** The output shows the leading step failed although the command may have exited 0 (`screencapture …; echo sc=$?`
   * printing `could not create image`): the row reads `Couldn't …`, and the image it named is not offered. */
  failed?: true;
  /** The output pins a failure on the leading step itself, even when a pipe hid its exit (`git push -f … 2>&1 | tail -2`
   * printing `error: failed to push some refs`, `git commit` printing `nothing to commit`): a git/gh `fatal:`/`error:`
   * line, `npm ERR!` for an install or build. Never set when another step of the row could have printed it. */
  leadFailed?: true;
  /** Destructive steps came after a `&&` step whose failure the output (or a nonzero exit) shows, so they never ran:
   * `risks` still names them, `destructive` is false and the row leads with a step that ran (`Didn't force-push`). */
  notRun?: true;
  /** The output says a wrapper the command runs through (`timeout 60 cargo test`) was not found, so the inner command
   * never ran: the row keeps the inner command's sentence and names the wrapper here. */
  missing?: string;
}

/** `waited`: the row leads with a wait (`Waited for [final2.log] to contain “^DONE”`) whose log printed this summary;
 * the check is a separate finding, not the wait's own outcome. */
export interface ShellCheck { kind: 'typecheck' | 'test'; failed: boolean; waited?: true }

/** One destructive step: `<reason>: <command>` ('Deletes files: rm -rf lib') and how badly (see SEVERITY in shell-intent-risk.ts). */
export interface Risk { text: string; severity: number }

/** A handler's answer; `raw` asks the composer to show the command itself (an unsafe or opaque step).
 * A destructive answer may carry its `severity` (default 1), a `risk` text overriding the sentence, or the `risks`
 * of the steps it hides (a script fed to `bash`, a `$(…)`, an `ssh` command). */
export type Desc = Pick<ShellIntent, 'kind' | 'verb' | 'label' | 'object' | 'icon'> & {
  raw?: boolean; destructive?: boolean; severity?: number; risk?: string; risks?: Risk[]; producedImage?: string;
  /** Why the step is risky ('Deletes files'), when its verb alone does not say (see riskReason in shell-intent-risk.ts). */
  reason?: string;
};

/** Kinds whose object is usually arguments, a path, SQL or a URL path; PROSE marks the sentences among them. */
const CODE_KINDS: ReadonlySet<ShellKind> = new Set(['shell', 'script', 'db', 'git', 'fetch', 'file', 'process', 'system']);
const PROSE = /^(?:"|“|· “|at \d|branch name$|last \d|matching\b|files\b|exists$|does not\b|is |from |with |to contain\b|listed in\b|\+?\d+ (?:items|files|folders|URLs)\b|\()/;
export const monoObject = (described: Desc) => !!described.object && CODE_KINDS.has(described.kind) && !PROSE.test(described.object);

export interface Segment {
  words: string[];
  heredoc: boolean;
  /** File written by a stdout redirect (`> f`, `>> f`, `&> f`); never /dev/null or a descriptor. */
  redirect: string;
  append: boolean;
  /** File read by `< f`. */
  input: string;
  /** A live `$(…)`, backtick or `<(…)` substitution appears in a word (not single-quoted or escaped). */
  substituted: boolean;
  /** The commands inside this segment's live substitutions, including an unquoted heredoc body's. */
  subs: string[];
  /** The text of this segment's heredoc bodies (bounded by the input), '' without one. */
  body: string;
  /** Variables known to hold scratch paths (`$TMPDIR`, `T=$(mktemp -d)`), set by shell-intent.ts before handlers run. */
  scratch?: ReadonlySet<string>;
  /** The directory of the last literal `cd` (relative paths resolve against it); unset when unknown. */
  cwd?: string;
  /** The segment's own source text (`rm -rf "$(pwd)"`), as written; risks quote it. */
  text?: string;
  /** The segment closes a `( … )` subshell, so later pipe stages read the whole subshell's output, not this command's. */
  group?: boolean;
}
/** Where a path is resolved and which variables hold scratch: a segment's `scratch` and `cwd`. */
export type Scope = Pick<Segment, 'scratch' | 'cwd'>;
/** `next`: the operator joining this step to the following one (`&&`, `||`, `;`, `&`), '' for a newline or the end. */
export interface Step { text: string; pipes: Segment[]; next?: string }

export type Recurse = (words: string[], seg: Segment) => Desc | undefined;
export type Handler = (program: string, args: string[], seg: Segment, recurse: Recurse) => Desc | undefined;

const KIND_ICON: Record<ShellKind, string> = {
  read: 'file', search: 'search', list: 'folder', test: 'check', typecheck: 'check', build: 'spark', install: 'download',
  git: 'branch', github: 'github', wait: 'clock', fetch: 'globe', script: 'command', db: 'server',
  file: 'file', process: 'activity', media: 'play', system: 'monitor', shell: 'terminal',
};
export const NONE: ReadonlySet<string> = new Set();
const set0 = (...items: string[]): ReadonlySet<string> => new Set(items);
/** Programs that run the rest of the line, with their options that take a separate value. */
const PREFIXES: Record<string, ReadonlySet<string>> = {
  sudo: set0('-u', '-g', '-h', '-p', '-C', '-D', '-r', '-t', '-U', '-T', '-R', '--user', '--group', '--host', '--prompt', '--chdir', '--close-from', '--other-user'),
  doas: set0('-u', '-C'), nice: set0('-n', '--adjustment'), ionice: set0('-c', '-n', '-p', '-P', '-u', '--class', '--classdata'),
  timeout: set0('-s', '-k', '--signal', '--kill-after'), gtimeout: set0('-s', '-k', '--signal', '--kill-after'),
  env: set0('-u', '-C', '-S', '--unset', '--chdir', '--split-string'), caffeinate: set0('-t', '-w'), time: set0('-o', '-f', '--output', '--format'),
  nohup: NONE, command: NONE, builtin: NONE, exec: set0('-a'), stdbuf: set0('-i', '-o', '-e'), chrt: NONE, taskset: NONE,
};
const ASSIGNMENT = /^[A-Za-z_]\w*(?:\[[^\]]*\])?\+?=/;
const own = (table: object, key: string) => Object.prototype.hasOwnProperty.call(table, key);

const NOT_FOUND = 'command not found';

/** The wrapper (`timeout`, `nice`) the output says is missing (`zsh: command not found: timeout`, `bash: timeout: command
 * not found`), when `command` runs one; the row keeps the inner command. String scans only, so any output stays linear. */
export function missingWrapper(command: string, output: string): string | undefined {
  const at = output.indexOf(NOT_FOUND);
  if (at < 0) return undefined;
  const end = output.indexOf('\n', at);
  const after = output.slice(at + NOT_FOUND.length, end < 0 ? undefined : end);
  const head = output.slice(output.lastIndexOf('\n', at) + 1, at);
  const name = (after.startsWith(': ') ? after.slice(2) : head.endsWith(': ') ? head.slice(0, -2).split(': ').pop() ?? '' : '').trim();
  if (!name || !own(PREFIXES, name)) return undefined;
  return command.split(/[\s;&|()]+/).includes(name) ? name : undefined;
}

export const desc = (kind: ShellKind, verb: ShellVerb, label: string, object = '', icon = KIND_ICON[kind]): Desc => ({ kind, verb, label, object, icon });
export const RAW: Desc = { ...desc('shell', 'Ran', 'shell'), raw: true };
/** The same description, marked as losing data or work. */
export const destroys = (described: Desc, severity = 1, risk?: string): Desc => ({ ...described, destructive: true, severity, ...(risk ? { risk } : {}) });
export const isFlag = (arg: string) => arg.length > 1 && arg.startsWith('-');
export const set = (...items: string[]): ReadonlySet<string> => new Set(items);
/** `“wip”`: a message or title as a row quotes it. */
export const quoted = (text: string, max = 60) => `“${clip(text.trim(), max)}”`;
export const plural = (count: number, noun: string) => `${count} ${noun}${count === 1 ? '' : 's'}`;
/** Whether any of `flags` is given, counting a bundle of short flags (`-qf`, `-fdn`) as each of its letters; only
 * for options that take no value, and never after `--`. */
export function hasFlag(args: string[], ...flags: string[]): boolean {
  const end = args.indexOf('--');
  const shorts = flags.filter(flag => /^-[a-zA-Z]$/.test(flag)).map(flag => flag[1]);
  return (end < 0 ? args : args.slice(0, end)).some(arg => flags.includes(arg) || (/^-[a-zA-Z]{2,}$/.test(arg) && shorts.some(letter => arg.includes(letter))));
}
/** `/dev/null`, `/dev/stdout`, `/dev/fd/2`: a device stream, never a file whose contents can be lost. */
export const isDeviceStream = (path: string) => /^\/dev\/(?:null|zero|u?random|stdin|stdout|stderr|tty|fd\/\d+)$/.test(path);
export const isSubstitution = (word: string) => /\$\(|`|[<>]\(/.test(word);

/** Formats `tool_image` serves (src-tauri/src/tool_images_auth/shell.rs): a .tiff or .heic output gets no thumbnail. */
const IMAGE_FILE = /[^/]\.(?:png|jpe?g|gif|webp)$/i;
/** A literal image path (no variables, substitutions, globs, braces or `%03d` patterns). */
export const isImagePath = (path: string | undefined): path is string => !!path && IMAGE_FILE.test(path) && !/[$`*?%{]/.test(path);
/** The same description, naming the image it writes when `path` is one. */
export const withImage = (described: Desc, path: string | undefined): Desc => isImagePath(path) ? { ...described, producedImage: path } : described;

export { basename, clip };

/** Programs whose `-h` is not help (`ls -h` human sizes, `shutdown -h` halts, `psql -h` a host). */
const H_IS_NOT_HELP = new Set(['ls', 'df', 'du', 'sort', 'free', 'grep', 'egrep', 'fgrep', 'rg', 'ag', 'ack', 'ps', 'tar', 'cp', 'ln', 'chown', 'chgrp',
  'chmod', 'rsync', 'mysql', 'psql', 'pg_dump', 'pg_restore', 'dropdb', 'createdb', 'redis-cli', 'mongo', 'mongosh', 'shutdown', 'sudo', 'ssh', 'scp', 'nc', 'head', 'tail', 'sed', 'xargs', 'find']);
/** Programs whose first word names what the help is about (`git push --help`). */
const SUBCOMMANDED = new Set(['git', 'gh', 'npm', 'pnpm', 'yarn', 'bun', 'npx', 'bunx', 'cargo', 'docker', 'kubectl', 'go', 'uv', 'pip', 'brew', 'xcrun',
  'terraform', 'aws', 'deno', 'jj', 'swift', 'rustup', 'gcloud', 'az', 'tmux', 'systemctl', 'launchctl', 'apt', 'apt-get']);

/** `git push --help`, `rm -h`, `node --version`: only shows text, whatever the command would otherwise do. */
export function helpDesc(program: string, label: string, args: string[]): Desc | undefined {
  const at = args.findIndex(arg => arg === '--help' || arg === '--version' || (arg === '-h' && !H_IS_NOT_HELP.has(program)));
  if (at < 0) return undefined;
  const sub = SUBCOMMANDED.has(program) ? args.slice(0, at).find(arg => !isFlag(arg)) : undefined;
  const about = [label, sub && /^[a-z][\w:-]*$/i.test(sub) ? clip(sub, 24) : ''].filter(Boolean).join(' ');
  return desc('shell', args[at] === '--version' ? 'Checked version of' : 'Showed help for', about);
}

/** The command words after a wrapper's own options (`watch -n 5 cmd`, `xargs -n1 rm`). */
export function afterOptions(args: string[], valued: ReadonlySet<string>): string[] {
  let i = 0;
  while (i < args.length && isFlag(args[i]) && args[i] !== '--') i += valued.has(args[i]) ? 2 : 1;
  return args.slice(args[i] === '--' ? i + 1 : i);
}

/** "a.ts", "a.ts +2" — the first item and a count of the rest. */
export function firstAndMore(items: string[], map: (item: string) => string = basename): string {
  if (!items.length) return '';
  return items.length > 1 ? `${clip(map(items[0]), 48)} +${items.length - 1}` : clip(map(items[0]), 48);
}

/** `a.ts +1 file` when every item is a file path (`a.ts`, `src/x`), else firstAndMore's bare `+N` (`foo +1`). */
export function firstAndMoreFiles(items: string[], map: (item: string) => string = basename): string {
  if (items.length < 2 || !items.every(item => FILE_LIKE.test(item))) return firstAndMore(items, map);
  return `${clip(map(items[0]), 48)} +${plural(items.length - 1, 'file')}`;
}
const FILE_LIKE = /\/|[^./]\.[A-Za-z0-9]+$/;

const MAX_SHOWN_ARGS = 4;
const SHOWN_ARGS_TEXT = 48;

/** An argument tail in words: `a b` as written, `sp and 9 more args` once it is long; never a bare `+9`. */
export function argsSummary(given: string[]): string {
  const args = withoutVariables(given);
  const joined = args.join(' ');
  if (args.length <= MAX_SHOWN_ARGS && joined.length <= SHOWN_ARGS_TEXT) return joined;
  return args.length > 1 ? `${clip(args[0], 32)} and ${plural(args.length - 1, 'more arg')}` : clip(joined, SHOWN_ARGS_TEXT);
}

/** `$X`, `"${args[@]}"`, `"$@"`: a whole word that is only an unresolved expansion, which a row never shows. */
const BARE_VARIABLE = /^"?\$(?:[@*#]|\{?[A-Za-z_]\w*(?:\[[@*]\])?\}?|\{[@*#]\})"?$/;
export const isBareVariable = (word: string) => BARE_VARIABLE.test(word);
/** Arguments without whole-word expansions (`seams ${args[@]}` → `seams`). */
export const withoutVariables = (args: string[]) => args.filter(arg => !isBareVariable(arg));

/** `s` without trailing `ch` characters (a loop, so a long run of them never backtracks the way `/x+$/` does). */
export function trimTrailing(text: string, ch: string): string {
  let end = text.length;
  while (end > 0 && text[end - 1] === ch) end--;
  return text.slice(0, end);
}

/** `2>&1`, `>/dev/null`, `2>/dev/null`, `&>/dev/null` as whole words: they say where output went, not what ran. */
const REDIRECTION = /(^|\s)(?:\d*>&\d+|&>>?\s?\/dev\/null|\d*>>?\s?\/dev\/null)(?=\s|$)/g;
/** curl's `-w '%{http_code}\n'` formats. Only ever run on clipped objects, so the scan stays short. */
const CURL_FORMAT = /%\{[^}\s]{0,40}\}/g;

const EMPTY_QUOTES = /(^|\s)(?:''|"")(?=\s|$)/g;

/** A displayed object without redirections, literal `\n`/`\t` escapes or curl formats, its spaces collapsed. */
export function tidyObject(text: string): string {
  if (!/[>&%\\]/.test(text)) return text;
  const tidied = text.replace(REDIRECTION, '$1').replace(/\\[nt]/g, ' ').replace(CURL_FORMAT, '');
  // `-w '%{http_code}'` leaves `''` once its format is gone.
  return (tidied === text ? tidied : tidied.replace(EMPTY_QUOTES, '$1')).replace(/ {2,}/g, ' ').trim();
}

/** One label for a list of paths: the basename of one, or "3 files". */
export function pathsLabel(paths: string[]): string {
  return paths.length === 1 ? clip(basename(paths[0]), 48) : plural(paths.length, 'file');
}

export function positionals(args: string[], valueFlags: ReadonlySet<string> = NONE): string[] {
  const out: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return [...out, ...args.slice(i + 1)];
    if (isFlag(arg)) { if (valueFlags.has(arg)) i++; continue; }
    out.push(arg);
  }
  return out;
}

export function flagValue(args: string[], names: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === '--') return undefined;
    if (names.includes(arg)) return args[i + 1];
    const long = names.find(name => name.startsWith('--') && arg.startsWith(name + '='));
    if (long) return arg.slice(long.length + 1);
  }
  return undefined;
}

/** Drops `FOO=1`, `sudo -u root`, `env -i A=b`, `nice -n 10`, `timeout -s KILL 5s` and the like; keeps `command -v`
 * (a lookup, not a prefix). */
export function stripPrefixes(words: string[]): string[] {
  let i = 0;
  while (i < words.length) {
    const word = words[i];
    if (ASSIGNMENT.test(word)) { i++; continue; }
    const name = basename(word);
    if (!own(PREFIXES, name) || (name === 'command' && /^-[vV]$/.test(words[i + 1] ?? ''))) break;
    i = skipOptions(words, i + 1, PREFIXES[name]);
    if (name === 'timeout' || name === 'gtimeout') i++;
  }
  return words.slice(i);
}

function skipOptions(words: string[], from: number, valued: ReadonlySet<string>): number {
  let i = from;
  while (i < words.length && isFlag(words[i]) && words[i] !== '--') i += valued.has(words[i]) ? 2 : 1;
  return words[i] === '--' ? i + 1 : i;
}

export function programName(word: string): string {
  return basename(word).replace(/(.)@[^/]*$/, '$1');
}

/** [host, path+query] of a URL-ish argument, or undefined when it is not one. */
export function urlParts(url: string): [string, string] | undefined {
  try {
    const parsed = new URL(/^[a-z][\w+.-]*:\/\//i.test(url) ? url : `http://${url}`);
    const path = parsed.pathname === '/' ? '' : parsed.pathname;
    return [parsed.host.replace(/^www\./, ''), clip(path + parsed.search, 60)];
  } catch {
    return undefined;
  }
}

/** Arguments that are values rather than options: not a flag, and not right after one (`-v error file` → file). */
export function looseOperands(args: string[]): string[] {
  return args.filter((arg, i) => !isFlag(arg) && (i === 0 || !isFlag(args[i - 1])));
}
