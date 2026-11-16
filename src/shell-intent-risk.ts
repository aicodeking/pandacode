/* Risk ranking for shell-intent.ts: how badly a destructive step loses data, which paths are disposable scratch,
 * how paths resolve against the last `cd`, and handlers for commands that delete or stop everything (crontab -r, diskutil
 * erase, kubectl delete, terraform destroy, aws s3 rm/rb, xargs/parallel deleters, shutdown/reboot). Pure and total. */
import {
  afterOptions, basename, clip, desc, destroys, flagValue, hasFlag, plural, positionals, set, trimTrailing, urlParts, type Desc, type Handler, type Recurse, type Risk, type Scope, type Segment, type ShellVerb,
} from './shell-intent-base.ts';

/** 4 history rewrite, force push, hard reset, disk erase, deleting / ~ .. or discarding the whole checkout;
 * 3 recursive deletes of real directories; 2 discarded changes; 1 any other loss (a rebase, a file outside the checkout).
 * Not destructive at all: scratch deletes (artefact folders, /tmp, /var/folders) and, deliberately, named relative files
 * without `-r` (`rm src/old.ts`, see `remove` in shell-intent-files.ts): undoable from git and too common to badge. */
export const SEVERITY = { other: 1, discard: 2, tree: 3, critical: 4 } as const;

const ARTEFACTS = set('dist', 'build', 'out', 'target', 'node_modules', '.cache', '.next', 'coverage', 'test-results', 'playwright-report',
  '__pycache__', '.DS_Store', '.pytest_cache', '.mypy_cache', '.ruff_cache', '.turbo', '.parcel-cache', 'DerivedData');
/** Relative top-level folders agents keep scratch in (`.work/preview/x`, `tmp/run1`): anything under them is disposable. */
const SCRATCH_ROOTS = set('.work', 'tmp', '.tmp', 'temp', '.temp', 'scratch', '.scratch');
/** Variables trusted to hold a temporary directory until the command reassigns them. */
export const SCRATCH_VARS: ReadonlySet<string> = set('TMPDIR', 'TMP', 'TEMP', 'TEMPDIR');
/** Programs that delete or overwrite the files they are given; also looked for after `xargs` and `parallel`. */
export const DELETERS = set('rm', 'rmdir', 'unlink', 'shred', 'dd', 'truncate', 'rimraf');
/** The checkout itself, however it is spelled: `$(pwd)`, `` `pwd` ``, `$PWD`, `$(git rev-parse --show-toplevel)`. */
const CHECKOUT = /^(?:\$\(pwd\)|`pwd`|\$\{?PWD\}?|\$\(git rev-parse --show-toplevel\)|`git rev-parse --show-toplevel`)\/?\*?$/;
const CRITICAL = /^(?:\/+\*?|~\/?\*?|\$\{?HOME\}?\/?\*?|\.\.\/?\*?|\.\/?\*?|\*)$/;
const LEADING_VAR = /^\$\{?([A-Za-z_]\w*)\}?(?:\/|$)/;
const ROOTED = /^(?:\/|~|\$\{?HOME\b)/;
const TEMPORARY = /^(?:\/private)?\/tmp\/[^/]|^\/(?:private\/)?var\/folders\/[^/]/;
/** The temporary directory itself or everything in it (`/tmp/*`, `$TMPDIR`, `"$TMPDIR"/*`): other programs' scratch too. */
const TEMP_ROOT = /^(?:(?:\/private)?\/tmp|\/(?:private\/)?var\/folders(?:\/[^/*]+){0,2}(?:\/[TC])?|\$\{?(?:TMPDIR|TMP|TEMP|TEMPDIR)\}?)\/?\*?$/;
const HOME = /^(?:~|\$\{?HOME\}?|\/Users\/[^/]+|\/home\/[^/]+|\/root)\//;
/** Programs and data installed under home (`~/.local/bin/x`, `~/.local/share/x`, `~/.cargo/bin/x`): not settings. */
const INSTALLS = String.raw`local\/(?:bin|share|lib)\/|(?:cargo|bun|deno)\/bin\/`;
/** Dotfiles and settings under home (`~/.zshrc`, `~/.ssh/authorized_keys`, `~/.config/x`), not caches. */
const HOME_CONFIG = new RegExp(`${HOME.source}(?:\\.(?!cache\\/|Trash\\/|${INSTALLS})[^/]|Library\\/Preferences\\/)`);
/** A folder at the top of home (`~/Documents`, `$HOME/Desktop`): a name without dots. */
const HOME_FOLDER = new RegExp(`${HOME.source}[^/.]+\\/?$`);

/** `~/.zshrc`, `$HOME/.ssh/authorized_keys`: overwriting it changes how the user's shell or tools behave. */
export const isHomeConfig = (path: string): boolean => HOME_CONFIG.test(path.trim());
/** `~/Documents`, `/Users/me/Desktop`: moving it away loses where everything is. */
export const isHomeFolder = (path: string): boolean => HOME_FOLDER.test(path.trim());

/** `.bashrc`, `.zshrc`, `.profile`, fish's `config.fish`: run by every new shell, so even an append changes it. */
const SHELL_STARTUP = new RegExp(`${HOME.source}(?:\\.(?:bash(?:rc|_profile|_login)|zsh(?:rc|env|profile)|z?profile|zlogin)|\\.config\\/fish\\/(?:config\\.fish|conf\\.d\\/[^/]+))$`);
export const isShellStartup = (path: string): boolean => SHELL_STARTUP.test(path.trim());

type Write = 'Overwrote' | 'Appended to' | 'Edited';
const CONFIG_REASONS: Record<Write, string> = {
  'Overwrote': 'Overwrites a config file', 'Appended to': 'Appends to a shell startup file', 'Edited': 'Edits a config file in place',
};

/** `> ~/.zshrc`, `ln -sf /dev/null ~/.zshrc`, `sed -i … ~/.zshrc`, `>> ~/.bashrc`: a dotfile or setting replaced or changed. */
export const overwroteConfig = (file: string, risk?: string, verb: Write = 'Overwrote'): Desc => ({
  ...destroys(desc('file', verb, clip(basename(file), 48), '', 'edit'), SEVERITY.discard, risk && riskLine(CONFIG_REASONS[verb], riskCommand(risk))), reason: CONFIG_REASONS[verb],
});

/** System locations (`/etc`, `/private/etc`, `/usr`, `/System`, `/Library`, `/bin`, `/sbin`): writing there changes the machine. */
const SYSTEM_PATH = /^(?:(?:\/private)?\/etc|\/usr|\/System|\/Library|\/bin|\/sbin)\//;
const SYSTEM_REASONS: Record<Write | 'Emptied', string> = {
  'Overwrote': 'Overwrites a system file', 'Emptied': 'Overwrites a system file', 'Appended to': 'Appends to a system file', 'Edited': 'Edits a system file in place',
};
export const isSystemPath = (path: string): boolean => SYSTEM_PATH.test(path.trim());

/** `> /etc/hosts`, `sudo tee /etc/hosts`, `cp x /usr/local/bin/x`, `sed -i … /etc/hosts`: a file the whole machine reads, changed. */
export const overwroteSystem = (file: string, verb: Write | 'Emptied' = 'Overwrote', risk?: string): Desc => ({
  ...destroys(desc('file', verb, clip(basename(file), 48) || clip(file, 48), '', verb === 'Emptied' ? 'trash' : 'edit'), SEVERITY.tree, risk && riskLine(SYSTEM_REASONS[verb], riskCommand(risk))),
  reason: SYSTEM_REASONS[verb],
});

/** `/`, `~`, `$HOME`, `..`, `.`, a root `*`, the checkout (`$(pwd)`): deleting it loses everything. */
export const isCriticalPath = (path: string): boolean => CRITICAL.test(path.trim()) || CHECKOUT.test(path.trim());

/** The chip for a critical path: `$PWD` and `repo root` rather than a substitution. */
const criticalLabel = (path: string) => !CHECKOUT.test(path.trim()) ? path : /rev-parse/.test(path) ? 'repo root' : '$PWD';

/** `f` after `cd /tmp/x` → `/tmp/x/f`; rooted paths, variables and an unknown directory leave the path as given. */
export function resolvePath(path: string, cwd?: string): string {
  const trimmed = path.trim();
  if (!cwd || !trimmed || ROOTED.test(trimmed) || trimmed.startsWith('$') || trimmed.startsWith('`')) return trimmed;
  const rest = trimmed.replace(/^(?:\.\/)+/, '');
  return rest === '.' || rest === '' ? cwd : `${trimTrailing(cwd, '/')}/${rest}`;
}

/** Disposable paths: under /tmp, /var/folders or a trusted $TMPDIR (or a mktemp result); artefact names (dist,
 * node_modules, …) only for relative paths, since `~/build` or `/Users/me/target` may be anything. */
export function isScratchPath(path: string, scratchVars: ReadonlySet<string> = SCRATCH_VARS): boolean {
  const trimmed = path.trim();
  if (!trimmed || isCriticalPath(trimmed) || TEMP_ROOT.test(trimmed) || /(?:^|\/)\.\.(?:\/|$)/.test(trimmed)) return false;
  const variable = LEADING_VAR.exec(trimmed);
  if (variable) return scratchVars.has(variable[1]);
  if (ROOTED.test(trimmed)) return TEMPORARY.test(trimmed);
  if (/[`$]/.test(trimmed)) return false;
  const parts = trimmed.split('/').filter(part => part && part !== '.');
  return SCRATCH_ROOTS.has(parts[0] ?? '') || parts.some(part => ARTEFACTS.has(part)) || /\.py[co]$/.test(parts[parts.length - 1] ?? '');
}

/** Whether a path, resolved against the scope's directory, is scratch. A relative path under a literal `cd` (not `~`
 * or `/`) keeps the artefact rule (`cd /p && rm -rf dist`), since it sits inside the folder the command chose. */
export function isScratchIn(path: string, scope?: Scope): boolean {
  if (isScratchPath(resolvePath(path, scope?.cwd), scope?.scratch)) return true;
  const cwd = scope?.cwd?.trim();
  const relative = !!cwd && !ROOTED.test(path.trim()) && !/^[$`]/.test(path.trim());
  return relative && !isCriticalPath(cwd) && !/[$`*?]/.test(cwd) && isScratchPath(path, scope?.scratch);
}

/** How badly deleting these paths loses data; 0 when every one is scratch. A recursive delete under ~ or any
 * absolute non-scratch path ranks with a hard reset. */
export function deletionSeverity(paths: string[], recursive: boolean, scope?: Scope): number {
  const scratch = paths.map(path => isScratchIn(path, scope));
  if (paths.some((path, i) => isCriticalPath(path) && !scratch[i])) return SEVERITY.critical;
  if (paths.length && scratch.every(Boolean)) return 0;
  if (recursive && paths.some((path, i) => ROOTED.test(path.trim()) && !scratch[i])) return SEVERITY.critical;
  return recursive ? SEVERITY.tree : SEVERITY.other;
}

/** `rm -rf node_modules dist` → `2 folders`, `rm a.log b.log` → `2 files`, a recursive mix of both → `3 items`. */
function deletedCount(paths: string[], recursive: boolean): string {
  const files = paths.filter(path => /[^./]\.\w+$/.test(basename(trimTrailing(path, '/')))).length;
  if (!recursive || files === paths.length) return plural(paths.length, 'file');
  return files ? plural(paths.length, 'item') : plural(paths.length, 'folder');
}

/** `~/.config/app`, `$HOME/.cache/x`: a path under home is named as written, so the chip says whose folder it is. */
const UNDER_HOME = /^(?:~|\$\{?HOME\}?)\/./;

/** `/usr`, `/etc/`: a system root itself (`isSystemPath` covers what is under one). */
const SYSTEM_ROOT = /^(?:\/private)?\/(?:etc|usr|System|Library|bin|sbin)\/?$/;

/** `../sibling`: a path beside the project keeps its `..`, so the chip never reads as a folder inside it. */
const BESIDE = /^\.\.\/[^/]+\/?$/;

/** The chip for one deleted path: under home or beside the project as written, else its name; `files` when the name is
 * an unresolved variable (`rm -rf $D`), which the risk still quotes. */
function deletedName(path: string): string {
  if (UNDER_HOME.test(path) || BESIDE.test(path) || isSystemPath(path) || SYSTEM_ROOT.test(path)) return trimTrailing(path, '/');
  const name = basename(path);
  return name.includes('$') ? 'files' : name;
}

/** A delete of `paths`, labelled by its most dangerous path; harmless (not destructive) when every path is scratch. */
export function deletion(paths: string[], recursive: boolean, scope?: Scope, verb: 'Deleted' | 'Deleted from git' = 'Deleted'): Desc {
  const critical = paths.find(isCriticalPath);
  const label = critical ? criticalLabel(critical) : paths.length === 1 ? deletedName(paths[0]) : deletedCount(paths, recursive);
  const deleted = desc(verb === 'Deleted' ? 'file' : 'git', verb, clip(label, 48), '', 'trash');
  const severity = deletionSeverity(paths, recursive, scope);
  return severity ? destroys(deleted, severity) : deleted;
}

/** `> f`, `cat /dev/null > f`, `tee f < /dev/null`: the file is emptied (harmless when it is scratch). */
export function emptied(file: string, scope?: Scope): Desc {
  if (isHomeConfig(file)) return overwroteConfig(file);
  if (isSystemPath(file)) return overwroteSystem(file, 'Emptied');
  const described = desc('file', 'Emptied', clip(basename(file), 48), '', 'trash');
  if (isScratchIn(file, scope)) return described;
  return isSecretFile(file) ? { ...destroys(described, SEVERITY.discard), reason: 'Empties a secrets file' } : destroys(described);
}

/** `.env`, `.env.local`, `server.pem`, `id.key`, `~/x/config.json`: keys and settings nothing else keeps a copy of. */
const SECRET_NAME = /^\.env(?:\.[\w.-]+)?$|\.(?:pem|key)$/;
export const isSecretFile = (path: string): boolean => SECRET_NAME.test(basename(path.trim())) || (HOME.test(path.trim()) && basename(path.trim()) === 'config.json');

const COMMAND_LABEL = /^(?:shell|git|gh|docker|kubectl|terraform|pulumi|aws|tmux)(?:\s|$)/;

/** Why each destructive verb is risky; a handler may name its own `reason`. */
const REASONS: Partial<Record<ShellVerb, string>> = {
  'Deleted': 'Deletes files', 'Deleted from git': 'Deletes files', 'Shredded': 'Deletes files', 'Synced (deleting extras)': 'Deletes files',
  'Hard-reset to': 'Discards uncommitted changes', 'Discarded changes in': 'Discards uncommitted changes',
  'Force-pushed': 'Rewrites remote history', 'Deleted remote branch': 'Deletes a remote branch', 'Rewrote history': 'Rewrites history',
  'Deleted branch': 'Deletes a branch', 'Deleted tag': 'Deletes a tag', 'Deleted ref': 'Deletes a ref', 'Expired reflog': 'Expires the reflog',
  'Pruned': 'Prunes unreachable commits', 'Dropped stash': 'Drops stashed changes', 'Dropped all stashes': 'Drops stashed changes',
  'Overwrote': 'Overwrites a file', 'Emptied': 'Empties a file', 'Truncated': 'Cuts a file short', 'Formatted': 'Formats a disk',
  'Erased': 'Erases a disk', 'Destroyed': 'Destroys infrastructure', 'Stopped': 'Force-kills a process',
  'Stopped processes matching': 'Force-kills processes', 'Set permissions': 'Changes permissions', 'Changed owner of': 'Changes ownership',
  'Removed': 'Removes a container', 'Removed image': 'Removes an image', 'Cleaned': 'Removes unused containers and images',
  'Changed database': 'Changes a database', 'Dropped database': 'Drops a database', 'Shut down': 'Shuts down the machine',
  'Rebooted': 'Reboots the machine', 'Unpublished': 'Unpublishes a package', 'Moved': 'Moves a home folder',
};

/** 'Deletes files', 'Discards uncommitted changes': why a destructive step is risky. */
export function riskReason(described: Desc): string {
  if (described.reason) return described.reason;
  if (described.verb === 'Cleaned' && described.label.startsWith('git')) return 'Deletes untracked files';
  return REASONS[described.verb] ?? 'Loses data';
}

/** `Deletes files: rm -rf lib`. */
export const riskLine = (reason: string, command: string): string => `${reason}: ${command}`;

/** A destructive step whose risk reads as `command` (as written) after its reason; hidden steps' risks stay as they are. */
export function withCommandRisk(described: Desc | undefined, command: string): Desc | undefined {
  if (!described?.destructive || described.risks?.length) return described;
  return { ...described, risk: riskLine(riskReason(described), clip(riskCommand(command), 160)) };
}

/** A command as quoted in a risk: without a leading line continuation (`\ rm -rf ~` after `ls && \⏎`) or the `)` that
 * closes a subshell it sits in (`(cd /; rm -rf *)` → `rm -rf *`). */
const QUOTED = /'[^']*'|"(?:\\.|[^"\\])*"/g;
export function riskCommand(command: string): string {
  let text = command.replace(/^(?:\\\s+)+/, '').trim();
  const bare = text.replace(QUOTED, '');
  let extra = (bare.match(/\)/g) ?? []).length - (bare.match(/\(/g) ?? []).length;
  while (extra-- > 0 && text.endsWith(')')) text = text.slice(0, -1).trimEnd();
  return text;
}

/** A step's risk: its reason and the command as written, else the step's sentence without command chips. */
export function riskText(described: Desc): string {
  if (described.risk) return described.risk;
  const label = COMMAND_LABEL.test(described.label) ? '' : described.label;
  return riskLine(riskReason(described), clip([described.verb, label, described.object].filter(Boolean).join(' '), 80));
}

/** Every risk a description carries: its hidden steps' risks, else its own when destructive. */
export function risksOf(described: Desc | undefined): Risk[] {
  if (!described) return [];
  const own = described.destructive && !described.risks?.length ? [{ text: riskText(described), severity: described.severity ?? SEVERITY.other }] : [];
  return [...own, ...(described.risks ?? [])];
}

export const severityOf = (described: Desc): number => risksOf(described).reduce((max, risk) => Math.max(max, risk.severity), 0);

/** The same description, also carrying the hidden steps' risks (and so destructive when any exist). */
export function withRisks(described: Desc, risks: Risk[]): Desc {
  if (!risks.length) return described;
  const all = [...risksOf(described), ...risks];
  return { ...described, destructive: true, severity: all.reduce((max, risk) => Math.max(max, risk.severity), 0), risks: all };
}

/** Risk texts, highest severity first (stable), without repeats. */
export function rankRisks(risks: Risk[]): string[] {
  const sorted = risks.map((risk, index) => ({ risk, index })).sort((a, b) => b.risk.severity - a.risk.severity || a.index - b.index);
  return [...new Set(sorted.map(({ risk }) => risk.text))];
}

// ---------------------------------------------------------------- infrastructure deletes

const crontab: Handler = (_program, args) =>
  hasFlag(args, '-r') ? { ...destroys(desc('system', 'Deleted', 'crontab', '', 'trash')), reason: 'Deletes every scheduled job' } : undefined;

const diskutil: Handler = (_program, args) => {
  const [sub = '', ...rest] = positionals(args);
  if (!/^(?:erase|zero|secureErase|randomDisk|reformat|partitionDisk|apfs)/i.test(sub)) return undefined;
  if (sub === 'apfs' && !/^delete/i.test(rest[0] ?? '')) return undefined;
  const device = rest[rest.length - 1] ?? 'disk';
  return destroys(desc('system', 'Erased', clip(basename(device), 48), '', 'trash'), SEVERITY.critical);
};

const KUBECTL_VALUES = set('-n', '--namespace', '-f', '--filename', '-l', '--selector', '--context', '-o', '--output', '--grace-period', '--timeout');

const kubectl: Handler = (_program, args) => {
  const [sub = '', ...rest] = positionals(args, KUBECTL_VALUES);
  if (sub !== 'delete') return undefined;
  const file = flagValue(args, ['-f', '--filename']);
  const label = rest.length ? rest.join(' ') : file ? basename(file) : 'resources';
  const severity = rest[0] === 'namespace' || rest[0] === 'ns' ? SEVERITY.tree : SEVERITY.other;
  return { ...destroys(desc('system', 'Deleted', clip(label, 48), '', 'trash'), severity), reason: 'Deletes cluster resources' };
};

const UNREVIEWED = 'Changes infrastructure without review';

/** `terraform destroy`; `terraform apply -auto-approve` changes real infrastructure with no plan shown first. */
const terraform: Handler = (_program, args) => {
  const [sub = ''] = positionals(args, set('-chdir', '-var', '-var-file', '-target'));
  const destroying = sub === 'destroy' || (sub === 'apply' && args.includes('-destroy'));
  if (destroying) return destroys(desc('system', 'Destroyed', 'terraform', '', 'trash'), SEVERITY.critical);
  const approved = args.some(arg => /^--?auto-approve(?:=true)?$/.test(arg));
  return sub === 'apply' && approved ? { ...destroys(desc('system', 'Applied', 'terraform'), SEVERITY.tree), reason: UNREVIEWED } : undefined;
};

/** `pulumi destroy --yes`, `pulumi up --yes`: the stack changes with no preview confirmed (without `--yes` pulumi asks). */
const pulumi: Handler = (_program, args) => {
  const [sub = ''] = positionals(args, set('-s', '--stack', '-C', '--cwd', '-m', '--message', '-c', '--config', '-t', '--target', '-p', '--parallel'));
  if (!hasFlag(args, '-y', '--yes', '-f', '--skip-preview')) return undefined;
  if (sub === 'destroy' || sub === 'down') return destroys(desc('system', 'Destroyed', 'pulumi', '', 'trash'), SEVERITY.critical);
  return sub === 'up' || sub === 'update' ? { ...destroys(desc('system', 'Applied', 'pulumi'), SEVERITY.tree), reason: UNREVIEWED } : undefined;
};

const aws: Handler = (_program, args) => {
  const [service = '', sub = '', target = ''] = positionals(args, set('--profile', '--region', '--endpoint-url', '--exclude', '--include', '--output'));
  if (service !== 's3' || (sub !== 'rm' && sub !== 'rb')) return undefined;
  const bucket = urlParts(target)?.[0] ?? (target || 'bucket');
  const whole = sub === 'rb' || args.includes('--recursive');
  const deleted = destroys(desc('fetch', 'Deleted', clip(bucket, 48), clip(urlParts(target)?.[1] ?? '', 60), 'trash'), whole ? SEVERITY.tree : SEVERITY.other);
  return { ...deleted, reason: 'Deletes cloud storage' };
};

const XARGS_VALUES = set('-n', '-I', '-i', '-P', '-L', '-l', '-d', '-a', '-E', '-e', '-s', '--max-args', '--max-procs', '--max-lines', '--arg-file',
  '--delimiter', '--replace', '--eof', '--max-chars');
const PARALLEL_VALUES = set('-j', '-n', '-N', '-L', '-S', '-I', '-a', '-d', '--jobs', '--max-args', '--sshlogin', '--arg-file', '--delimiter', '--joblog', '--results', '--tmpdir');

const MAX_WRAPPERS = 8;
/** `xargs xargs -n1 rm`: nested xargs/parallel unwrapped in a loop, at most MAX_WRAPPERS deep (never one recursion each). */
function unwrapped(words: string[]): string[] {
  let rest = words;
  for (let n = 0; n < MAX_WRAPPERS && (rest[0] === 'xargs' || rest[0] === 'parallel'); n++) {
    rest = afterOptions(rest.slice(1), rest[0] === 'xargs' ? XARGS_VALUES : PARALLEL_VALUES);
  }
  return rest;
}

/** `xargs rm -rf < list`, `parallel rm < list`: deletes whatever the input lists; another command reads as itself when it loses data. */
function listedDeletes(given: string[], source: string, recurse: Recurse, seg: Segment): Desc | undefined {
  const words = unwrapped(given);
  const program = basename(words[0] ?? '');
  if (!program) return undefined;
  // Past the cap the wrappers are not read further; a deleter anywhere after them still counts.
  const buried = (program === 'xargs' || program === 'parallel') && words.some(word => DELETERS.has(basename(word)));
  if (DELETERS.has(program) || buried) {
    const recursive = program === 'rimraf' || words.some(word => /^-[a-zA-Z]*[rR]/.test(word) || word === '--recursive');
    const deleted = desc('file', 'Deleted', 'files', source ? `listed in ${clip(basename(source), 48)}` : '', 'trash');
    return destroys(deleted, recursive ? SEVERITY.tree : SEVERITY.other);
  }
  if (program === 'xargs' || program === 'parallel') return undefined;
  const inner = recurse(words, { ...seg, input: '' });
  return inner?.destructive ? inner : undefined;
}

const xargs: Handler = (_program, args, seg, recurse) =>
  listedDeletes(afterOptions(args, XARGS_VALUES), flagValue(args, ['-a', '--arg-file']) ?? seg.input, recurse, seg);

/** `parallel rm ::: a b` runs `rm a` and `rm b`; without `:::` it reads its arguments like xargs. */
const parallel: Handler = (_program, args, seg, recurse) => {
  const words = afterOptions(args, PARALLEL_VALUES);
  const split = words.findIndex(word => word === ':::' || word === '::::');
  if (split < 0 || words[split] === '::::') return listedDeletes(split < 0 ? words : words.slice(0, split), seg.input, recurse, seg);
  return words.slice(0, split).length ? recurse([...words.slice(0, split), ...words.slice(split + 1).filter(word => !/^:::/.test(word))], seg) : undefined;
};

/** `shutdown -h now`, `reboot`, `halt`: every running program stops (`shutdown -c` / `-k` only cancel or warn). */
const power: Handler = (program, args) => {
  if (program === 'shutdown' && args.some(arg => /^-[ck]$/.test(arg) || arg === '--cancel')) return undefined;
  const reboot = program === 'reboot' || (program === 'shutdown' && args.some(arg => /^-\w*r/.test(arg) || arg === '--reboot'));
  return destroys(desc('system', reboot ? 'Rebooted' : 'Shut down', 'machine'), SEVERITY.tree);
};

// ---------------------------------------------------------------- macOS settings, keychains and services

/** `security delete-keychain build.keychain`: every password and certificate in it is gone. */
const security: Handler = (_program, args) => {
  const [sub = '', keychain = ''] = positionals(args);
  if (sub !== 'delete-keychain') return undefined;
  return { ...destroys(desc('system', 'Deleted', clip(basename(keychain || 'keychain'), 48), 'keychain', 'trash'), SEVERITY.tree), reason: 'Deletes a keychain' };
};

/** `defaults read com.apple.dock`; `defaults delete <domain> [key]` drops an app's settings (all of them without a key). */
const defaults: Handler = (_program, args) => {
  const [sub = '', domain = '', key] = positionals(args.filter(arg => arg !== '-currentHost'), set('-host'));
  if (!domain) return undefined;
  const label = clip(domain, 48);
  if (sub === 'read' || sub === 'read-type') return desc('system', 'Read', label, 'settings');
  if (sub !== 'delete') return undefined;
  return { ...destroys(desc('system', 'Deleted', label, 'settings', 'trash'), key ? SEVERITY.other : SEVERITY.discard), reason: 'Deletes app settings' };
};

/** `launchctl list`; `unload -w`, `bootout`, `disable` keep a service from running (across logins for `-w` and `disable`). */
const launchctl: Handler = (_program, args) => {
  const [sub = '', ...rest] = positionals(args);
  if (sub === 'list' || sub === 'print') return desc('system', 'Listed', 'launchctl services');
  const target = rest[rest.length - 1];
  const stopped = desc('system', 'Stopped', clip(basename(target ?? 'service'), 48), '', 'stop');
  const disables = sub === 'bootout' || sub === 'disable' || sub === 'remove' || (sub === 'unload' && hasFlag(args, '-w'));
  if (disables) return { ...destroys(stopped), reason: 'Disables a launch service' };
  return sub === 'unload' || sub === 'stop' ? stopped : undefined;
};

export const RISK_HANDLERS: Record<string, Handler> = {
  crontab, diskutil, kubectl, terraform, pulumi, aws, xargs, parallel, shutdown: power, reboot: power, halt: power, poweroff: power, security, defaults, launchctl,
};

// ---------------------------------------------------------------- text the parser never checked

/** How much of a command the fallback scan reads: past the parser's input limit and step budget, padding must not hide a step. */
export const MAX_UNCHECKED = 200_000;
const UNCHECKED_WRAPPERS = set('sudo', 'doas', 'env', 'nohup', 'time', 'command', 'exec', 'xargs', 'nice', 'then', 'do', 'else', '!');
const PIPED_SHELLS = set('sh', 'bash', 'zsh', 'dash', 'ksh', 'fish');
/** A segment naming none of these needs no word scan. */
const UNCHECKED_PROGRAMS = /\b(?:rm|git|dd|mkfs|chmod|chown|chgrp|curl|wget|drop)\b/i;
const SQL_DROP = /\bDROP\s+(?:TABLE|DATABASE|SCHEMA)\b[^"';\n]*/i;

/** The program of a stage's words (wrappers, assignments and their flags skipped) and its arguments. */
function stageProgram(words: string[]): { program: string; args: string[] } {
  let at = 0;
  while (at < Math.min(words.length, 8) && (UNCHECKED_WRAPPERS.has(words[at]) || words[at].startsWith('-') || /^[A-Za-z_]\w*=/.test(words[at]))) at++;
  const word = words[at] ?? '';
  return { program: word.slice(word.lastIndexOf('/') + 1), args: words.slice(at + 1) };
}

/** Whether one pipe stage, as plain words, deletes, force-pushes, discards or overwrites a disk. */
function dangerousStage(words: string[]): boolean {
  const { program, args } = stageProgram(words);
  const short = (letters: RegExp) => args.some(word => /^-[^-]/.test(word) && letters.test(word.slice(1)));
  const sub = args.find(word => !word.startsWith('-'));
  if (program === 'rm') return short(/[rRf]/) || args.includes('--recursive') || args.includes('--force');
  if (program === 'git' && sub === 'push') return short(/f/) || args.some(word => word.startsWith('--force') || /^\+./.test(word));
  if (program === 'git' && sub === 'reset') return args.includes('--hard');
  if (program === 'git' && sub === 'clean') return short(/f/) || args.includes('--force');
  if (program === 'dd') return args.some(word => word.startsWith('of='));
  if (['chmod', 'chown', 'chgrp'].includes(program)) return short(/R/) || args.includes('--recursive');
  return program.startsWith('mkfs');
}

/** The first dangerous step in text the parser never checked (the steps past its budget, the tail past its input limit),
 * as written. A word scan per `;`/`&`/newline segment and `|` stage: linear, no regex over the whole text. */
export function uncheckedDanger(text: string): string | undefined {
  for (const segment of text.slice(0, MAX_UNCHECKED).split(/[;&\n(){}`]/)) {
    if (!UNCHECKED_PROGRAMS.test(segment)) continue;
    const stages = segment.split('|').map(stage => stage.trim().split(/\s+/));
    const at = stages.findIndex(dangerousStage);
    if (at >= 0) return clip(stages[at].join(' '), 120);
    const fetched = stages.some((words, index) => ['curl', 'wget'].includes(stageProgram(words).program) && PIPED_SHELLS.has(stageProgram(stages[index + 1] ?? []).program));
    const found = fetched ? segment : SQL_DROP.exec(segment)?.[0];
    if (found) return clip(found.trim(), 120);
  }
  return undefined;
}

/** `intent` marked destructive by a step the parser never checked. */
export function withUnchecked<T extends { destructive: boolean; risks: string[] }>(intent: T, danger: string | undefined): T {
  return danger ? { ...intent, destructive: true, risks: [...intent.risks, `Long command not fully checked: ${danger}`] } : intent;
}
