/* Shell-intent handlers for programs that name files: readers, searches, listings and file operations.
 * Every program here is in FILE_HANDLERS, which the composer uses to refuse presenting a `$(…)` as a file name. */
import {
  RAW, basename, clip, desc, destroys, firstAndMore, trimTrailing, flagValue, hasFlag, isDeviceStream, isFlag, isSubstitution, pathsLabel, plural, positionals, set, type Scope,
  type Desc, type Handler, type ShellVerb,
} from './shell-intent-base.ts';
import {
  DELETERS, SEVERITY, deletion, emptied, isCriticalPath, isHomeConfig, isHomeFolder, isScratchIn, isSystemPath, overwroteConfig, overwroteSystem, riskLine,
} from './shell-intent-risk.ts';

export { DELETERS };

const editDesc = (verb: ShellVerb, file: string): Desc => desc('file', verb, basename(file), '', 'edit');
/** `echo … > f`: wrote f; a dotfile or setting under home is overwritten. */
const wrote = (file: string, append: boolean): Desc => isSystemPath(file) ? overwroteSystem(file, append ? 'Appended to' : 'Overwrote')
  : !append && isHomeConfig(file) ? overwroteConfig(file) : editDesc(append ? 'Appended to' : 'Wrote', file);
const GLOB = /[*?[]/;
/** `bench/*.md` alone reads as `[files] matching bench/*.md`, never a `*.md` chip. */
const globbed = (files: string[]): [string, string] | undefined =>
  files.length === 1 && GLOB.test(files[0]) ? ['files', `matching ${clip(files[0], 60)}`] : undefined;

/** `sed -i`, `perl -pi`: one file reads `Edited a.ts`; several or a glob `Edited [3 files] in place`. */
export function editedInPlace(files: string[], fallback: string): Desc {
  if (!files.length) return editDesc('Edited', fallback);
  if (files.length === 1 && !GLOB.test(files[0]) && !isSubstitution(files[0])) return editDesc('Edited', files[0]);
  // `$(git ls-files)` names files only at run time.
  const label = files.some(isSubstitution) ? 'files' : files.length === 1 ? clip(basename(files[0]), 48) : plural(files.length, 'file');
  return desc('file', 'Edited', label, 'in place', 'edit');
}
const moreFiles = (count: number) => count > 0 ? `+${plural(count, 'file')}` : '';
/** A read file's chip; `/dev/null` stays whole, so the lead can tell a read of nothing from a file named `null`. */
const readLabel = (file: string) => isDeviceStream(file) ? file : basename(file);

const readSed: Handler = (_program, args, seg) => {
  const script = flagValue(args, ['-e', '--expression']);
  const rest = positionals(args, set('-e', '-f', '--expression'));
  const files = script === undefined ? rest.slice(1) : rest;
  if (args.some(arg => /^-i/.test(arg) || /^--in-place/.test(arg))) return sedInPlace(args, script, seg);
  if (!hasFlag(args, '-n') || !files.length) return undefined;
  const range = /^(\d+|\$)(?:,(\d+|\$))?p$/.exec((script ?? rest[0] ?? '').trim());
  const object = !range ? '' : range[2] ? `lines ${range[1]}–${range[2]}` : `line ${range[1]}`;
  return desc('read', 'Read', readLabel(files[0]), [object, moreFiles(files.length - 1)].filter(Boolean).join(' · '));
};

/** `sed -i d f`, `sed -i '1,$d' f`: a script that deletes every line empties the file. */
const DELETES_ALL = /^\s*(?:1\s*,\s*\$\s*)?d\s*$/;

function sedInPlace(args: string[], script: string | undefined, scope: Scope): Desc {
  const files = sedTargets(args, script);
  const program = script ?? positionals(args.filter((arg, i) => !(arg === '' && args[i - 1] === '-i')), set('-e', '-f', '--expression'))[0] ?? '';
  if (!DELETES_ALL.test(program) || !files.length) return editedInPlace(files, 'sed');
  return files.length === 1 ? emptied(files[0], scope) : destroys(desc('file', 'Emptied', pathsLabel(files), '', 'trash'));
}

/** The files `sed -i` edits: positionals after the script, without macOS's `-i ''` suffix. */
function sedTargets(args: string[], script: string | undefined): string[] {
  const kept = args.filter((arg, i) => !(arg === '' && args[i - 1] === '-i'));
  const rest = positionals(kept, set('-e', '-f', '--expression'));
  return script === undefined ? rest.slice(1) : rest;
}

const readCat: Handler = (program, args, seg) => {
  const files = positionals(args, program === 'bat' ? set('-l', '--language', '-r', '--line-range') : set()).filter(file => file !== '-');
  if (program === 'cat' && seg.redirect && !seg.append && files.length && files.every(file => file === '/dev/null')) return emptied(seg.redirect, seg);
  if (program === 'cat' && seg.redirect) return wrote(seg.redirect, seg.append);
  if (!files.length) return undefined;
  const glob = globbed(files);
  return glob ? desc('read', 'Read', ...glob) : desc('read', 'Read', readLabel(files[0]), moreFiles(files.length - 1));
};

const readEnds: Handler = (program, args) => {
  const files = positionals(args, set('-n', '-c', '--lines', '--bytes'));
  if (!files.length) return undefined;
  const count = flagValue(args, ['-n', '--lines']) ?? args.map(arg => /^-n?(\d+)$/.exec(arg)?.[1]).find(Boolean);
  const following = program === 'tail' && args.some(arg => /^-\w*[fF]/.test(arg));
  const object = following ? 'following' : count ? `${program === 'head' ? 'first' : 'last'} ${count.replace(/^[+-]/, '')} lines` : '';
  return desc('read', 'Read', readLabel(files[0]), object);
};

const wc: Handler = (_program, args, seg) => {
  const files = positionals(args, set('--files0-from'));
  const file = files[0] ?? seg.input;
  if (!file) return undefined;
  const lines = args.some(arg => /^-\w*l/.test(arg) || arg === '--lines');
  const verb = lines ? 'Counted lines in' : 'Counted';
  const glob = globbed(files);
  return glob ? desc('read', verb, ...glob) : desc('read', verb, basename(file), files.length > 1 ? moreFiles(files.length - 1) : '');
};

// rg and grep disagree on several short options (`-T`, `-E`, `-r`), so each has its own value-taking set.
const RG_FLAGS = set('-e', '-f', '-g', '-t', '-T', '-A', '-B', '-C', '-m', '-M', '-j', '-d', '-E', '-r', '--glob', '--iglob', '--type', '--type-not',
  '--type-add', '--type-clear', '--max-count', '--context', '--after-context', '--before-context', '--regexp', '--file', '--max-columns', '--pre',
  '--pre-glob', '--max-depth', '--max-filesize', '--sort', '--sortr', '--threads', '--encoding', '--engine', '--replace', '--color', '--colors', '--ignore-file');
const GREP_FLAGS = set('-e', '-f', '-A', '-B', '-C', '-m', '-d', '-D', '-G', '--regexp', '--file', '--after-context', '--before-context', '--context',
  '--max-count', '--include', '--exclude', '--exclude-dir', '--label', '--binary-files', '--devices', '--directories');

/** `"x"`, or `'say "hi"'` when the pattern holds double quotes (never `""x""`). */
const quoted = (text: string) => !text.includes('"') ? `"${text}"` : !text.includes("'") ? `'${text}'` : text;

/** grep's basic regexes spell alternation `\|`; show it as `|`. */
const shownPattern = (program: string, args: string[], pattern: string) =>
  program === 'grep' && !args.some(arg => /^-[a-zA-Z]*[EFP]/.test(arg)) ? pattern.replace(/\\\|/g, '|') : pattern;

/** The values of every `-g`/`--glob`/`--iglob`, without `!` exclusions. */
function rgGlobs(args: string[]): string[] {
  return args.flatMap((arg, i) => /^(?:-g|--glob|--iglob)$/.test(arg) ? [args[i + 1] ?? ''] : /^--i?glob=/.test(arg) ? [arg.replace(/^--i?glob=/, '')] : [])
    .filter(glob => glob && !glob.startsWith('!'));
}

const asWritten = (path: string) => clip(path, 40);

/** `rg --files src -g '*.ts'`: `Listed [files] in src matching *.ts`. */
function rgFiles(args: string[]): Desc {
  const paths = positionals(args, RG_FLAGS), globs = rgGlobs(args);
  const where = paths.length ? `in ${firstAndMore(paths, asWritten)}` : '';
  return desc('list', 'Listed', 'files', [where, globs.length ? `matching ${firstAndMore(globs, asWritten)}` : ''].filter(Boolean).join(' '));
}

/** The pattern a grep or rg stage keeps (`rg -i shell`, `grep -e x`); undefined for `-v`, `--files` or a pattern file. */
export function filterPattern(program: string, args: string[]): string | undefined {
  if (!['rg', 'grep', 'egrep', 'fgrep'].includes(program) || args.some(arg => /^-[a-zA-Z]*v/.test(arg) || arg === '--invert-match' || arg === '--files')) return undefined;
  return flagValue(args, ['-e', '--regexp']) ?? (flagValue(args, ['-f', '--file']) === undefined ? positionals(args, program === 'rg' ? RG_FLAGS : GREP_FLAGS)[0] : undefined);
}

export const search: Handler = (program, args) => {
  if (program === 'rg' && args.includes('--files')) return rgFiles(args);
  const explicit = flagValue(args, ['-e', '--regexp']);
  const patternFile = explicit === undefined ? flagValue(args, ['-f', '--file']) : undefined;
  const rest = positionals(args, program === 'rg' ? RG_FLAGS : GREP_FLAGS);
  const named = explicit !== undefined || patternFile !== undefined;
  const pattern = explicit ?? rest[0];
  if (pattern === undefined && patternFile === undefined) return undefined;
  const paths = named ? rest : rest.slice(1);
  // `grep -n "" f`, `rg -n '^' f`: every line, numbered — a read.
  if (!named && (pattern === '' || pattern === '^') && paths.length) return desc('read', 'Read', basename(paths[0]), moreFiles(paths.length - 1));
  const where = paths.length ? ` in ${firstAndMore(paths, path => clip(path, 40))}` : '';
  const what = patternFile !== undefined ? `patterns from ${basename(patternFile)}` : quoted(clip(shownPattern(program, args, pattern ?? ''), 40));
  return desc('search', 'Searched', paths.length ? basename(paths[0]) : program, `for ${what}${where}`);
};

const FIND_ACTIONS = /^-(?:exec|execdir|ok|okdir|fprint0?|fprintf|fls)$/;

/** How badly `find <paths> -name <name> -delete` (or `-exec rm`) loses data: 0 for scratch names or paths. */
export function findSeverity(paths: string[], name: string | undefined, scope?: Scope): number {
  if (paths.some(path => isCriticalPath(path) && !isScratchIn(path, scope)) && !name) return SEVERITY.critical;
  if ((name && isScratchIn(name.replace(/^\*(?=\.)/, 'x'), { scratch: scope?.scratch })) || (paths.length && paths.every(path => isScratchIn(path, scope)))) return 0;
  return SEVERITY.other;
}

const find: Handler = (_program, args, seg) => {
  const execs = args.filter((arg, i) => /^-(?:exec|execdir|ok|okdir)$/.test(args[i - 1] ?? '') && DELETERS.has(basename(arg)));
  const firstExpression = args.findIndex(arg => /^[-(!]/.test(arg));
  const paths = (firstExpression < 0 ? args : args.slice(0, firstExpression)).filter(arg => !isFlag(arg));
  const name = flagValue(args, ['-name', '-iname', '-path', '-ipath', '-regex']);
  const severity = findSeverity(paths.length ? paths : ['.'], name, seg);
  if (args.some(arg => FIND_ACTIONS.test(arg))) return execs.length && severity ? destroys(RAW, severity, 'Deleted files found by find') : RAW;
  const matching = name ? `matching ${clip(name, 40)}` : '';
  const where = basename(paths[0] ?? '.');
  // `find src -name '*.ts' -delete` → `Deleted [files] matching *.ts in src`; without a name, `Deleted [dist] files`.
  const deleted = name ? desc('file', 'Deleted', 'files', [matching, where === '.' ? '' : `in ${where}`].filter(Boolean).join(' '), 'trash')
    : desc('file', 'Deleted', where, 'files', 'trash');
  if (args.includes('-delete')) return severity ? destroys(deleted, severity) : deleted;
  return desc('list', 'Listed', basename(paths[0] ?? '.'), matching);
};

const fd: Handler = (_program, args) => {
  if (args.some(arg => /^(?:-x|-X|--exec|--exec-batch)$/.test(arg))) return RAW;
  const [pattern, path] = positionals(args, set('-e', '-t', '-E', '-d', '--type', '--extension', '--exclude', '--max-depth'));
  return desc('list', 'Listed', basename(path ?? '.'), pattern ? `matching ${clip(pattern, 40)}` : '');
};

/** `ls`, `tree`: the listed folder (after `cd /x/proj`, a bare `ls` lists `proj`) and how many more paths. */
const list: Handler = (_program, args, seg) => {
  const paths = positionals(args, set('-L', '-I', '-P', '--ignore'));
  const here = seg.cwd ? clip(basename(seg.cwd), 48) || '.' : '.';
  const glob = globbed(paths);
  if (glob) return desc('list', 'Listed', ...glob);
  // `ls $d`: an unresolved variable never becomes the chip.
  const named = paths.length ? basename(paths[0]) : here;
  return desc('list', 'Listed', named.includes('$') ? 'folder' : named, paths.length > 1 ? `+${plural(paths.length - 1, 'path')}` : '');
};

/** A named file in or below the working directory: no glob, variable, `..`, absolute or home path. */
const isNamedRelative = (path: string) => !!path && !GLOB.test(path) && !/^[/~$`]|(?:^|\/)\.\.(?:\/|$)/.test(path) && !isCriticalPath(path);

const remove: Handler = (program, args, seg) => {
  const paths = positionals(args);
  if (!paths.length) return undefined;
  if (program === 'trash' || paths.every(isDeviceStream)) return desc('file', 'Deleted', pathsLabel(paths), '', 'trash');
  const options = args.includes('--') ? args.slice(0, args.indexOf('--')) : args;
  const recursive = program === 'rimraf' || options.some(arg => /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive');
  // `rm a.txt`, `rm -f src/old.ts`: named files, whatever directory a `cd` chose; not an alarm.
  if (!recursive && paths.every(isNamedRelative)) return desc('file', 'Deleted', pathsLabel(paths), '', 'trash');
  return deletion(paths, recursive, seg);
};

/** `truncate -s 0 f` empties a file; any other size cuts or pads it. */
const truncate: Handler = (_program, args) => {
  const files = positionals(args, set('-s', '--size', '-r', '--reference'));
  if (!files.length) return undefined;
  const size = flagValue(args, ['-s', '--size']) ?? '';
  const emptied = /^0+[KMGTPEZY]?B?$/i.test(size);
  if (files.every(isDeviceStream)) return desc('file', emptied ? 'Emptied' : 'Truncated', firstAndMore(files), '', 'trash');
  return destroys(desc('file', emptied ? 'Emptied' : 'Truncated', firstAndMore(files), emptied ? '' : clip(size, 24), 'trash'));
};

const shred: Handler = (_program, args) => {
  const files = positionals(args, set('-n', '--iterations', '-s', '--size'));
  return files.length ? destroys(desc('file', 'Shredded', pathsLabel(files), '', 'trash')) : undefined;
};

/** `dd if=a of=b`: writes over `of`, which may be a whole disk; without `of=` it only reads `if`. */
const dd: Handler = (_program, args, seg) => {
  const operand = (name: string) => args.find(arg => arg.startsWith(`${name}=`))?.slice(name.length + 1);
  const target = operand('of');
  const source = operand('if');
  if (!target || isDeviceStream(target)) return desc('read', 'Read', source ? clip(basename(source), 48) : 'stdin', target ? 'with dd' : '');
  const overwrote = desc('file', 'Overwrote', clip(basename(target), 48), source ? `from ${clip(basename(source), 48)}` : '', 'trash');
  if (isScratchIn(target, seg)) return overwrote;
  return destroys(overwrote, /^\/dev\/r?disk|^\/dev\/(?:sd|nvme|hd|mmcblk)/.test(target) ? SEVERITY.critical : SEVERITY.other);
};

/** `tee f`: writes stdin to f; `tee f < /dev/null` empties it. */
const tee: Handler = (_program, args, seg) => {
  const files = positionals(args).filter(file => !isDeviceStream(file));
  const append = hasFlag(args, '-a', '--append');
  if (!files.length) return undefined;
  if (seg.input === '/dev/null' && !append) return files.length === 1 ? emptied(files[0], seg) : destroys(desc('file', 'Emptied', pathsLabel(files), '', 'trash'));
  const system = files.find(isSystemPath);
  if (system) return overwroteSystem(system, append ? 'Appended to' : 'Overwrote');
  const config = append ? undefined : files.find(isHomeConfig);
  return config ? overwroteConfig(config) : desc('file', append ? 'Appended to' : 'Wrote', firstAndMore(files), '', 'edit');
};

/** `mkfs`, `mkfs.ext4`, `newfs_apfs`: erases the device. */
const format: Handler = (_program, args) => {
  const [device] = positionals(args, set('-t', '-L', '-n', '-v', '-b'));
  return destroys(desc('system', 'Formatted', device ? clip(basename(device), 48) : 'disk', '', 'trash'));
};

const transfer: Handler = (program, args, seg) => {
  const paths = positionals(args, program === 'rsync' ? set('-e', '--rsh', '--exclude', '--include', '--filter', '-f') : set('-t', '--target-directory'));
  if (paths.length < 2) return undefined;
  const last = paths[paths.length - 1];
  const target = clip(basename(last), 48);
  if (program === 'cp' && isDeviceStream(last)) return desc('file', 'Copied', pathsLabel(paths.slice(0, -1)), `→ ${last}`, 'copy');
  if (program === 'cp' && paths.length === 2 && paths[0] === '/dev/null') return destroys(desc('file', 'Emptied', target, '', 'trash'));
  const moved = program === 'mv';
  if (moved && last === '/dev/null') return deletion(paths.slice(0, -1), true, seg);
  if (program === 'rsync' && args.some(arg => /^--(?:delete|del$|remove-source-files)/.test(arg))) return syncDeleting(paths, seg);
  if (isHomeConfig(last)) return overwroteConfig(last);
  if (isSystemPath(last)) return overwroteSystem(last);
  const sources = paths.slice(0, -1);
  const described = desc('file', moved ? 'Moved' : 'Copied', pathsLabel(sources), `→ ${target}`, moved ? 'move' : 'copy');
  // `mv ~/Documents x`: a whole folder at the top of home leaves where everything was.
  if (moved && sources.some(isCriticalPath)) return destroys(described, SEVERITY.critical);
  if (moved && sources.some(isHomeFolder)) return destroys(described, SEVERITY.tree);
  if (moved && movesOut(sources, last, seg)) return { ...destroys({ ...described, object: 'out of the project' }, SEVERITY.tree), reason: 'Moves files out of the project' };
  // `cp a src/main.ts`, `mv -f a src/main.ts` (a plain `mv a.ts b.ts` is a rename).
  const forced = !moved || args.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force');
  return forced && sources.length === 1 && isSourceFile(last, seg) ? { ...destroys(editDesc('Overwrote', last)), reason: 'Replaces a file' } : described;
};

/** A code file in a project folder (`src/main.ts`, `tests/a.spec.ts`), not scratch: copying or moving onto it replaces
 * what was there. A bare or `./` name, a hidden folder or a tmp-looking name (`./_probe.mjs`, `.work/x.py`) is a new file. */
const SOURCE_FILE = /\.(?:[cm]?[jt]sx?|rs|py|go|swift|kt|java|rb|php|c|h|cc|cpp|hpp|cs|css|scss|html|vue|svelte|sql|sh|toml)$/;
const SCRATCH_NAME = /^[_.]|tmp|temp|scratch|probe|shot/i;
function isSourceFile(path: string, scope: Scope): boolean {
  const parts = path.replace(/^(?:\.\/)+/, '').split('/');
  const tracked = parts.length > 1 && !parts.slice(0, -1).some(part => part.startsWith('.')) && !SCRATCH_NAME.test(parts[parts.length - 1]);
  return tracked && isNamedRelative(path) && SOURCE_FILE.test(path) && !isScratchIn(path, scope);
}
/** A folder-looking source (`src`, `lib/core`) of the project, moved somewhere outside it (`/tmp/x`, `~/old`). */
function movesOut(sources: string[], target: string, scope: Scope): boolean {
  const outside = /^(?:\/|~|\$\{?HOME\b)/.test(target) && !(scope.cwd && target.startsWith(`${trimTrailing(scope.cwd, '/')}/`));
  return outside && sources.some(source => isNamedRelative(source) && !/\.[\w]+$/.test(basename(source)) && !isScratchIn(source, scope));
}

/** `ln -s ../shared/a.json a.json` → `Symlinked [a.json] → ../shared/a.json` (a hard link
 * reads `Linked`); `ln -sf /dev/null ~/.zshrc`, a forced link over a
 * dotfile, replaces it. */
const link: Handler = (_program, args) => {
  const forced = args.some(arg => /^-[a-zA-Z]*f/.test(arg) || arg === '--force');
  const paths = positionals(args, set('-t', '--target-directory', '-S', '--suffix'));
  const target = paths[paths.length - 1];
  if (forced && paths.length >= 2 && isHomeConfig(target)) return overwroteConfig(target);
  if (!paths.length || flagValue(args, ['-t', '--target-directory']) !== undefined) return undefined;
  const [source] = paths;
  const verb = args.some(arg => /^-[a-zA-Z]*s/.test(arg) || arg === '--symbolic') ? 'Symlinked' : 'Linked';
  if (paths.length > 2) return undefined;
  return desc('file', verb, clip(basename(paths.length === 1 ? source : target), 48), `→ ${clip(source, 60)}`, 'attach');
};

/** `mkdir -p src/a/b` → `Created folder [src/a/b]`; several read `[a] +2 more`. */
const makeFolder: Handler = (_program, args) => {
  const folders = positionals(args, set('-m', '--mode'));
  if (!folders.length) return undefined;
  return desc('file', 'Created folder', clip(trimTrailing(folders[0], '/') || folders[0], 48), folders.length > 1 ? `+${folders.length - 1} more` : '', 'folderPlus');
};

/** `awk '{print $1}' data.csv`: processed the file (`-f prog.awk` names the program instead of an inline one). */
const awk: Handler = (program, args) => {
  const rest = positionals(args, set('-f', '-v', '-F', '--file', '--assign', '--field-separator'));
  const files = (flagValue(args, ['-f', '--file']) === undefined ? rest.slice(1) : rest).filter(file => !/^[A-Za-z_]\w*=/.test(file) && file !== '-');
  return files.length ? desc('read', 'Processed', clip(basename(files[0]), 48), [`with ${program}`, moreFiles(files.length - 1)].filter(Boolean).join(' · ')) : undefined;
};

/** `cut -d, -f1 data.csv`, `cut -c1-80 < log`: read the file. */
const cut: Handler = (_program, args, seg) => {
  const files = [...positionals(args, set('-d', '-f', '-c', '-b', '--delimiter', '--fields', '--characters', '--bytes', '--output-delimiter')), seg.input]
    .filter(file => file && file !== '-');
  return files.length ? desc('read', 'Read', clip(basename(files[0]), 48), moreFiles(files.length - 1)) : undefined;
};

/** jq options that take one or two values (`--arg name value`). */
const JQ_VALUES: Record<string, number> = {
  '--arg': 2, '--argjson': 2, '--slurpfile': 2, '--rawfile': 2, '--indent': 1, '-L': 1, '--tab': 0, '-f': 1, '--from-file': 1,
};

/** `jq '.scripts' package.json`, `jq . < a.json`: queried the JSON file (with `-f prog.jq` every positional is a file). */
const jq: Handler = (_program, args, seg) => {
  const words: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--') { words.push(...args.slice(i + 1)); break; }
    if (isFlag(args[i])) { i += JQ_VALUES[args[i]] ?? 0; continue; }
    words.push(args[i]);
  }
  const fromFile = flagValue(args, ['-f', '--from-file']) !== undefined;
  const files = [...(fromFile ? words : words.slice(1)), seg.input].filter(file => file && file !== '-');
  return files.length ? desc('read', 'Queried', clip(basename(files[0]), 48), moreFiles(files.length - 1)) : undefined;
};

interface PatchFile { action: 'update' | 'add' | 'delete'; path: string }
const PATCH_HEADER = /^\*\*\* (Update|Add|Delete) File: (.+)$/gm;

/** The `*** Update File: a.ts` headers of an apply_patch envelope (bounded). */
function patchFiles(text: string): PatchFile[] {
  return [...text.slice(0, 200_000).matchAll(PATCH_HEADER)].slice(0, 200)
    .map(match => ({ action: match[1].toLowerCase() as PatchFile['action'], path: match[2].trim() }));
}

/** Codex `apply_patch <<'PATCH' … *** Update File: a.ts …`: the files it edits, creates or deletes (deletes lead). */
const applyPatch: Handler = (_program, args, seg) => {
  const files = patchFiles([seg.body, ...args].join('\n'));
  const lead = files.find(file => file.action === 'delete') ?? files[0];
  if (!lead) return undefined;
  const verb: ShellVerb = lead.action === 'delete' ? 'Deleted' : lead.action === 'add' ? 'Created' : 'Edited';
  const described = desc('file', verb, clip(basename(lead.path), 48), files.length > 1 ? `+${plural(files.length - 1, 'more file')}` : '', lead.action === 'delete' ? 'trash' : 'edit');
  const deleted = files.filter(file => file.action === 'delete').map(file => file.path);
  // One named relative file is like `rm a.ts`: not an alarm.
  if (!deleted.length || (deleted.length === 1 && isNamedRelative(deleted[0]))) return described;
  // A `risks` entry (not `risk`), so the row quotes the deleted paths rather than the whole patch.
  const risks = [{ text: riskLine('Deletes files', clip(`apply_patch deleting ${deleted.join(', ')}`, 160)), severity: SEVERITY.other }];
  return { ...described, destructive: true, severity: SEVERITY.other, risks };
};

/** `rsync --delete a/ b/`: files in b that a lacks are deleted. */
function syncDeleting(paths: string[], scope?: Scope): Desc {
  const last = paths[paths.length - 1];
  const synced = desc('file', 'Synced (deleting extras)', pathsLabel(paths.slice(0, -1)), `→ ${clip(basename(last), 48)}`, 'copy');
  const severity = isCriticalPath(last) ? SEVERITY.critical : isScratchIn(last, scope) ? 0 : SEVERITY.other;
  return severity ? destroys(synced, severity) : synced;
}

const permissions: Handler = (program, args) => {
  const [mode = '', ...files] = positionals(args, set('--reference'));
  if (!files.length) return undefined;
  const changed = changedPermissions(program, mode, firstAndMore(files));
  return args.some(arg => /^-[A-Za-z]*R/.test(arg) || arg === '--recursive') ? destroys(changed) : changed;
};

function changedPermissions(program: string, mode: string, label: string): Desc {
  if (program === 'chown' || program === 'chgrp') return desc('file', 'Changed owner of', label, clip(mode, 32), 'lock');
  if (/^[ugoa]*\+[rwX]*x/.test(mode)) return desc('file', 'Made executable', label, '', 'lock');
  return desc('file', 'Set permissions', label, clip(mode, 32), 'lock');
}

const hash: Handler = (_program, args) => {
  const files = positionals(args, set('-a', '--algorithm'));
  return files.length ? desc('file', 'Hashed', firstAndMore(files), '', 'lock') : undefined;
};

const TEST_OBJECT: Record<string, string> = { '-x': 'is executable', '-s': 'is not empty', '-r': 'is readable', '-w': 'is writable' };

/** `test -f x`, `[ -d x ]`, `[[ ! -e x ]]`; any other test reads `Checked [condition] "$s" = done`, never a `[` chip. */
const fileTest: Handler = (_program, args) => {
  const words = args.filter(arg => arg !== ']' && arg !== ']]');
  const negated = words[0] === '!';
  const [op = '', file = '', ...extra] = negated ? words.slice(1) : words;
  if (extra.length || !/^-[efdsrwxLhp]$/.test(op) || !file) return desc('shell', 'Checked', 'condition', clip(words.join(' '), 60));
  return desc('file', 'Checked', clip(basename(file), 48), negated ? 'does not exist' : TEST_OBJECT[op] ?? 'exists');
};

const tar: Handler = (_program, args) => {
  const bundles = args.filter((arg, i) => /^-[A-Za-z]+$/.test(arg) || (i === 0 && /^[A-Za-z]+$/.test(arg)));
  const letters = bundles.join('');
  const long = (name: string) => args.includes(`--${name}`);
  const verb = /x/.test(letters) || long('extract') ? 'Extracted' : /c/.test(letters) || long('create') ? 'Archived' : /t/.test(letters) || long('list') ? 'Listed archive' : 'Ran tar';
  const bundle = args.findIndex(arg => bundles.includes(arg) && /f$/.test(arg));
  const file = flagValue(args, ['--file']) ?? (bundle >= 0 ? args[bundle + 1] : undefined);
  return desc('file', verb, file ? clip(basename(file), 48) : 'tar', '', 'archive');
};

const zipTool: Handler = (program, args) => {
  const [archive] = positionals(args, set('-d', '-x', '-P'));
  if (!archive) return undefined;
  const extracting = program === 'unzip' || program === 'gunzip' || args.some(arg => /^-\w*d/.test(arg) && program !== 'zip');
  const target = program === 'unzip' ? flagValue(args, ['-d']) : undefined;
  const verb = extracting ? 'Extracted' : program === 'zip' ? 'Archived' : 'Compressed';
  return desc('file', verb, clip(basename(archive), 48), target ? `→ ${clip(basename(target), 48)}` : '', 'archive');
};

/** `strings`, `file`, `otool -L`, `xxd`, `hexdump -C`: looked inside a binary. */
const binary: Handler = (_program, args) => {
  const files = positionals(args, set('-n', '-t', '-s', '-l', '-c', '-g', '-o', '-arch', '--arch', '-m', '-e'));
  const file = files[files.length - 1];
  return file ? desc('file', 'Inspected binary', clip(basename(file), 48), '', 'file') : undefined;
};

/** `printf "" > f`, `echo -n > f`: prints nothing, so the redirect only empties the file. */
const printsNothing = (program: string, args: string[]) => args.every(arg => arg === '') || (program === 'echo' && args.every(arg => arg === '' || arg === '-n') && args.includes('-n'));
const echo: Handler = (program, args, seg) => !seg.redirect ? undefined
  : !seg.append && printsNothing(program, args) ? emptied(seg.redirect, seg) : wrote(seg.redirect, seg.append);

/** Programs whose description names files; `[` and `test` included. */
export const FILE_HANDLERS: Record<string, Handler> = {
  sed: readSed, cat: readCat, bat: readCat, batcat: readCat, less: readCat, more: readCat, nl: readCat, head: readEnds, tail: readEnds, wc,
  rg: search, grep: search, egrep: search, fgrep: search, ag: search, ack: search,
  ls: list, tree: list, eza: list, exa: list, find, fd, fdfind: fd,
  rm: remove, rmdir: remove, unlink: remove, trash: remove, rimraf: remove, truncate, tee,
  strings: binary, file: binary, otool: binary, xxd: binary, hexdump: binary, od: binary, nm: binary, objdump: binary, readelf: binary, lipo: binary, shred, dd, mkfs: format, mv: transfer, cp: transfer, rsync: transfer,
  chmod: permissions, chown: permissions, chgrp: permissions, shasum: hash, sha256sum: hash, sha1sum: hash, md5sum: hash, md5: hash, b2sum: hash,
  ln: link, mkdir: makeFolder, cut, jq, awk, gawk: awk, mawk: awk, apply_patch: applyPatch, applypatch: applyPatch,
  test: fileTest, '[': fileTest, '[[': fileTest, tar, bsdtar: tar, gtar: tar, unzip: zipTool, zip: zipTool, gzip: zipTool, gunzip: zipTool,
};

/** Programs that only write their output when redirected; not file-naming otherwise. */
export const ECHO_HANDLERS: Record<string, Handler> = { echo, printf: echo };

/** `ls … > out.txt`: mention the file a read, search or listing wrote its results to. */
export function withRedirect(described: Desc, redirect: string): Desc {
  if (!redirect || !['read', 'search', 'list'].includes(described.kind)) return described;
  return { ...described, object: [described.object, `→ ${clip(basename(redirect), 48)}`].filter(Boolean).join(' ') };
}
