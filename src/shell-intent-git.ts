/* Shell-intent handlers for git and the GitHub CLI: what a git subcommand did (diffs by range and paths, history by range
 * and count, shown revisions), which subcommands lose work, and `gh` groups and actions. Pure and total. */
import {
  basename, clip, desc, destroys, firstAndMore, flagValue, hasFlag, isFlag, pathsLabel, plural, positionals, quoted, set, type Desc, type Handler, type ShellVerb,
} from './shell-intent-base.ts';
import { SEVERITY, deletion } from './shell-intent-risk.ts';
import { search } from './shell-intent-files.ts';

const same = (word: string) => word;

const GIT_VERBS: Record<string, ShellVerb> = {
  status: 'Checked', diff: 'Diffed', log: 'Viewed history', show: 'Showed', blame: 'Viewed', commit: 'Committed', push: 'Pushed', pull: 'Pulled',
  fetch: 'Fetched', checkout: 'Switched to', switch: 'Switched to', add: 'Staged', stash: 'Stashed', merge: 'Merged', rebase: 'Rebased',
  reset: 'Reset', restore: 'Restored', branch: 'Listed', tag: 'Tagged', clone: 'Cloned', 'cherry-pick': 'Cherry-picked', worktree: 'Ran', rm: 'Removed', mv: 'Moved',
  'check-ignore': 'Checked ignore rules', 'merge-base': 'Found merge base', 'ls-files': 'Listed tracked files',
};

/** The subject line of `-m "msg"`, including the `"$(cat <<'EOF' … EOF)"` form agents use for long messages, or of the
 * heredoc `-F -` / `--file=-` reads; `from msg.txt` for a message file. */
function commitMessage(args: string[], heredoc: string): string {
  const file = flagValue(args, ['-F', '--file']);
  if (file !== undefined && file !== '-') return file ? `from ${clip(basename(file), 48)}` : '';
  const message = file === '-' ? heredoc : flagValue(args, ['-m', '-am', '--message']);
  if (!message) return '';
  const lines = message.split('\n');
  const body = /^\$\(cat <<-?\s*['"]?\w+['"]?\s*$/.test(lines[0].trim()) ? lines.slice(1) : lines;
  const subject = body.find(line => line.trim()) ?? '';
  return subject ? `"${clip(subject.trim(), 60)}"` : '';
}


function gitObject(sub: string, args: string[], body: string): string {
  return sub === 'commit' ? commitMessage(args, body) : clip(args.join(' '), 60);
}

export const git: Handler = (_program, args, seg) => {
  let i = 0;
  while (i < args.length && isFlag(args[i])) i += ['-C', '-c', '--git-dir', '--work-tree'].includes(args[i]) ? 2 : 1;
  const sub = args[i];
  if (!sub) return desc('git', 'Ran', 'git');
  const rest = args.slice(i + 1);
  if (sub === 'grep') return gitGrep(rest);
  return gitDanger(sub, rest) ?? gitWorktree(sub, rest) ?? gitReview(sub, rest) ?? gitPlumbing(sub, rest) ?? desc('git', GIT_VERBS[sub] ?? 'Ran', `git ${clip(sub, 24)}`, gitObject(sub, rest, seg.body));
};

/** `git grep -n pat [-- paths]`: a search, named `git grep` when it names no path. */
function gitGrep(args: string[]): Desc | undefined {
  const found = search('grep', args.filter(arg => arg !== '--'), { words: [], heredoc: false, redirect: '', append: false, input: '', substituted: false, subs: [], body: '' }, () => undefined);
  return found && found.label === 'grep' ? { ...found, label: 'git grep' } : found;
}

const gitDesc = (sub: string, verb: ShellVerb, object = '', severity: number = SEVERITY.other) => destroys(desc('git', verb, `git ${sub}`, clip(object, 60)), severity);
const has = hasFlag;
type GitRule = (args: string[], operands: string[]) => Desc | undefined;

/** `git branch -d x` refuses an unmerged branch, so only `-D`, `-df` or `--delete --force` can lose commits. */
function deletedBranch(args: string[], operands: string[]): Desc {
  const forced = args.some(arg => arg === '--force' || /^-[a-zA-Z]*[Df]/.test(arg));
  // The chip is the branch (`Deleted branch [feature]`), so a failed row never repeats the command.
  const deleted = desc('git', 'Deleted branch', firstAndMore(operands, same) || 'branch');
  return forced ? destroys(deleted, SEVERITY.discard) : deleted;
}

/** `git branch -m [old] new`: renamed; `-M` (or `-m --force`) replaces a branch already named `new`. */
function renamedBranch(args: string[], operands: string[]): Desc | undefined {
  const forced = args.includes('-M') || (has(args, '-m', '--move') && has(args, '-f', '--force'));
  if ((!forced && !has(args, '-m', '--move')) || !operands.length || operands.length > 2) return undefined;
  const target = operands[operands.length - 1];
  const renamed = desc('git', 'Renamed branch to', clip(target, 48), operands.length === 2 ? `from ${clip(operands[0], 40)}` : '');
  return forced ? { ...destroys(renamed, SEVERITY.other), reason: 'Overwrites a branch' } : renamed;
}

/** Subcommands that lose work: resets, cleans, force pushes, deleted branches, tags, refs and stashes, discarded edits, rewritten history. */
const GIT_DANGER: Record<string, GitRule> = {
  reset: (args, operands) => {
    const mode = ['hard', 'merge', 'keep'].find(name => args.includes(`--${name}`));
    if (!mode) return undefined;
    // `Hard-reset to [origin/main]`, `Reset to [HEAD~1] (keep)`: the chip is the target, never a repeat of the verb.
    const target = desc('git', mode === 'hard' ? 'Hard-reset to' : 'Reset to', clip(operands[0] ?? 'HEAD', 48), mode === 'hard' ? '' : `(${mode})`);
    return destroys(target, mode === 'hard' ? SEVERITY.critical : SEVERITY.discard);
  },
  clean: (args, operands) => has(args, '-n', '--dry-run')
    ? desc('git', 'Previewed cleaning', operands.length ? pathsLabel(operands) : 'untracked files')
    : gitDesc('clean', 'Cleaned', operands.join(' '), SEVERITY.discard),
  push: (args, operands) => gitPush(args, operands),
  branch: (args, operands) => args.some(arg => /^-[a-zA-Z]*[dD][a-zA-Z]*$/.test(arg) || arg === '--delete')
    ? deletedBranch(args, operands)
    : renamedBranch(args, operands)
    ?? (has(args, '-f', '--force') && operands.length ? gitDesc('branch', 'Reset', `${firstAndMore(operands, same)} (forced)`, SEVERITY.discard) : undefined),
  tag: (args, operands) => has(args, '-d', '--delete') ? gitDesc('tag', 'Deleted tag', firstAndMore(operands, same)) : undefined,
  stash: (_args, operands) => operands[0] === 'drop' ? gitDesc('stash', 'Dropped stash', operands.slice(1).join(' '), SEVERITY.discard)
    : operands[0] === 'clear' ? gitDesc('stash', 'Dropped all stashes', '', SEVERITY.discard) : undefined,
  checkout: (args, operands) => forcedSwitch(args, operands) ?? discarded('checkout', args, operands),
  switch: (args, operands) => forcedSwitch(args, operands),
  restore: args => discarded('restore', args, positionals(args, set('-s', '--source'))),
  rm: (args, operands) => has(args, '--cached') ? untracked(operands) : has(args, '-n', '--dry-run') ? undefined
    : deletion(operands, args.some(arg => /^-[a-zA-Z]*r/.test(arg)), undefined, 'Deleted from git'),
  rebase: (args, operands) => rebased(args, operands),
  'filter-branch': () => gitDesc('filter-branch', 'Rewrote history', '', SEVERITY.critical),
  'filter-repo': () => gitDesc('filter-repo', 'Rewrote history', '', SEVERITY.critical),
  'update-ref': (args, operands) => has(args, '-d') ? gitDesc('update-ref', 'Deleted ref', operands[0] ?? '', SEVERITY.tree) : undefined,
  reflog: (_args, operands) => operands[0] === 'expire' || operands[0] === 'delete' ? gitDesc('reflog', 'Expired reflog', '', SEVERITY.critical) : undefined,
  gc: args => args.some(arg => /^--prune=(?:now|all)$/.test(arg)) ? gitDesc('gc', 'Pruned', 'unreachable objects', SEVERITY.critical) : undefined,
};

/** `git rm -r --cached .`: the files stay on disk and leave the index (`Untracked [files] in git`). */
const untracked = (operands: string[]): Desc =>
  desc('git', 'Untracked', operands.every(path => /^(?:\.\/?|:\/|\*)$/.test(path)) ? 'files' : pathsLabel(operands), 'in git', 'branch');

/** `git rebase main`, `git rebase -i HEAD~3`, `--onto x y`: rewrites local commits (recoverable from the reflog, so low). */
function rebased(args: string[], operands: string[]): Desc | undefined {
  if (has(args, '--continue', '--abort', '--skip', '--quit', '--edit-todo', '--show-current-patch')) return undefined;
  const target = flagValue(args, ['--onto']) ?? positionals(args, set('--onto', '-s', '--strategy', '-X', '--strategy-option', '-x', '--exec'))[0]
    ?? (has(args, '--root') ? 'root' : undefined);
  if (!target) return undefined;
  return { ...destroys(desc('git', 'Rebased onto', clip(target, 48), '', 'branch'), SEVERITY.other), reason: 'Rewrites local history' };
}

function gitDanger(sub: string, args: string[]): Desc | undefined {
  return Object.prototype.hasOwnProperty.call(GIT_DANGER, sub) ? GIT_DANGER[sub](args, positionals(args)) : undefined;
}

/** `git checkout -f main`, `git switch --discard-changes x`: every uncommitted edit is thrown away. */
function forcedSwitch(args: string[], operands: string[]): Desc | undefined {
  if (!has(args, '-f', '--force', '--discard-changes')) return undefined;
  const object = operands[0] && operands[0] !== '.' ? `switching to ${clip(operands[0], 40)}` : '';
  return destroys(desc('git', 'Discarded changes in', 'working tree', object, 'branch'), SEVERITY.critical);
}

/** `git checkout -- paths`, `git checkout .`, `git restore paths` (not `--staged` alone): working-tree edits are thrown away. */
function discarded(sub: string, args: string[], operands: string[]): Desc | undefined {
  const dash = args.indexOf('--');
  const paths = sub === 'checkout' ? (dash >= 0 ? args.slice(dash + 1) : operands.filter(arg => arg === '.')) : operands;
  if (!paths.length || (sub === 'checkout' && has(args, '-b', '-B', '--orphan'))) return undefined;
  if (sub === 'restore' && has(args, '--staged', '-S') && !has(args, '--worktree', '-W')) return undefined;
  const whole = paths.some(path => /^(?:\.\/?|:\/|\*)$/.test(path));
  const severity = whole ? SEVERITY.critical : SEVERITY.discard;
  // `git restore --source HEAD~1 x`: the file is replaced by an older version, losing its uncommitted edits too.
  const source = sub === 'restore' ? flagValue(args, ['-s', '--source']) : undefined;
  if (source) return { ...destroys(desc('git', 'Restored', pathsLabel(paths), `from ${clip(source, 40)}`, 'branch'), severity), reason: DISCARDS };
  return destroys(desc('git', 'Discarded changes in', pathsLabel(paths), '', 'branch'), severity);
}

const DISCARDS = 'Discards uncommitted changes';

/** `git push -uf origin main`, `+main`, `--force-with-lease`: rewrites the remote; `--prune` deletes remote branches with no local twin. */
function gitPush(args: string[], operands: string[]): Desc | undefined {
  const [, ...refs] = operands;
  const deleted = has(args, '-d', '--delete') ? refs : refs.filter(ref => ref.startsWith(':')).map(ref => ref.slice(1));
  if (deleted.length) return gitDesc('push', 'Deleted remote branch', firstAndMore(deleted, same), SEVERITY.tree);
  const forced = has(args, '-f', '--force', '--force-if-includes', '--mirror') || args.some(arg => /^--force(?:-with-lease)?(?:=.*)?$/.test(arg))
    || refs.some(ref => ref.startsWith('+'));
  if (forced) return gitDesc('push', 'Force-pushed', operands.join(' '), SEVERITY.critical);
  return has(args, '--prune') ? { ...gitDesc('push', 'Pushed', operands.join(' '), SEVERITY.tree), reason: 'Deletes remote branches' } : undefined;
}

/** `git worktree list`, `add ../wt -b x`, `remove [--force] ../wt`. */
function gitWorktree(sub: string, args: string[]): Desc | undefined {
  if (sub !== 'worktree') return undefined;
  const [action = '', path = ''] = positionals(args, set('-b', '-B', '--reason', '--expire'));
  const label = path ? clip(basename(path), 48) : 'git worktree';
  if (action === 'list') return desc('git', 'Listed worktrees', 'git worktree');
  if (action === 'add') return desc('git', 'Added worktree', label);
  if (action !== 'remove') return undefined;
  const removed = desc('git', 'Removed worktree', label, '', 'trash');
  return has(args, '-f', '--force') ? destroys(removed, SEVERITY.discard) : removed;
}

// ---------------------------------------------------------------- diffs, history and shown revisions

/** Options of diff, log and show that take a separate value (`-n 5`, `--author x`); display flags take none. */
const REVIEW_VALUES = set('-n', '--max-count', '--author', '--committer', '--since', '--until', '--after', '--before', '--grep', '-S', '-G', '--skip',
  '-L', '-O', '--diff-filter', '--word-diff-regex', '--stat-width', '--src-prefix', '--dst-prefix', '--format', '--pretty');
/** A named revision: `HEAD~1`, `390ec22`, `origin/main`, `v0.3.12`, `main^`, `stash@{0}`. Only tested on words without
 * whitespace, so the trailing `[~^]` run can never backtrack against a failing end. */
const NAMED_REVISION = /^(?:HEAD|FETCH_HEAD|ORIG_HEAD|@|(?:origin|upstream)\/\S+|[0-9a-f]{7,40}|v\d[\w.-]*|main|master|develop|trunk|stash@\{\d+\})?(?:[~^]\d*)*$/;
/** A word that names a revision or range rather than a path: `main...HEAD`, `a..b`, or a named revision. */
const isRevision = (word: string) => !!word && !/\s/.test(word) && (word.includes('..') ? !word.includes('/..') && !word.startsWith('..') : NAMED_REVISION.test(word));

interface Operands { revisions: string[]; paths: string[] }

/** Revisions before `--` (anything that looks like one), paths after it or that do not look like a revision. */
function reviewOperands(args: string[]): Operands {
  const end = args.indexOf('--');
  const before = positionals(end < 0 ? args : args.slice(0, end), REVIEW_VALUES);
  const after = end < 0 ? [] : args.slice(end + 1);
  return { revisions: before.filter(isRevision), paths: [...before.filter(word => !isRevision(word)), ...after] };
}

/** `· providers.rs`, `· 2 files`: the paths a diff, show or log was limited to. */
const pathsNote = (paths: string[]) => paths.length ? `· ${pathsLabel(paths)}` : '';
const joined = (...parts: string[]) => parts.filter(Boolean).join(' ');

/** `git diff --no-ext-diff -U3 main...HEAD -- a.ts b.ts` → `Diffed [main...HEAD] · 2 files`; `--name-only` lists the files. */
function gitDiff(args: string[]): Desc {
  const { revisions, paths } = reviewOperands(args);
  const label = revisions.length ? clip(revisions.join(' '), 48) : 'git diff';
  const staged = hasFlag(args, '--cached', '--staged') ? 'staged' : '';
  const verb: ShellVerb = hasFlag(args, '--name-only', '--name-status') ? 'Listed changed files' : 'Diffed';
  return desc('git', verb, label, joined(staged, pathsNote(paths)));
}

/** `git show 390ec22 --stat` → `Showed [390ec22]`; `git show main:a/b.md` → `Showed [b.md] at main`. */
function gitShow(args: string[]): Desc {
  const { revisions, paths } = reviewOperands(args);
  const blob = positionals(args, REVIEW_VALUES).find(word => /^[^:\s]+:[^:\s]+$/.test(word));
  if (blob) {
    const [rev = '', file = ''] = blob.split(':');
    return desc('git', 'Showed', clip(basename(file), 48), `at ${clip(rev, 40)}`);
  }
  return desc('git', 'Showed', clip(revisions[0] ?? 'HEAD', 48), pathsNote(paths));
}

function logCount(args: string[]): string {
  const count = flagValue(args, ['-n', '--max-count']) ?? args.map(arg => /^-(\d+)$/.exec(arg)?.[1] ?? /^--max-count=(\d+)$/.exec(arg)?.[1]).find(Boolean);
  return count ? `last ${count}` : '';
}

/** `git log --format=… --stat -5 main..x` → `Viewed history [git log] main..x · last 5`: range and count, never formats. */
function gitLog(args: string[]): Desc {
  const { revisions, paths } = reviewOperands(args.filter(arg => !/^-\d+$/.test(arg)));
  const parts = [clip(revisions.join(' '), 48), logCount(args)].filter(Boolean).join(' · ');
  return desc('git', 'Viewed history', 'git log', joined(parts, pathsNote(paths)));
}

function gitReview(sub: string, args: string[]): Desc | undefined {
  if (sub === 'diff') return gitDiff(args);
  if (sub === 'show') return gitShow(args);
  return sub === 'log' ? gitLog(args) : undefined;
}

// ---------------------------------------------------------------- new branches, stashes and plumbing

/** `git checkout -b x [start]`, `git switch -c x`: a new branch, not a switch to an existing one. */
function createdBranch(sub: string, args: string[]): Desc | undefined {
  const flag = sub === 'checkout' ? '-b' : sub === 'switch' ? '-c' : '';
  const name = flag ? flagValue(args, [flag, ...(sub === 'switch' ? ['--create'] : [])]) : undefined;
  if (!name) return undefined;
  const [start] = positionals(args, set(flag, '--create', '--track', '-t')).filter(word => word !== name);
  return desc('git', 'Created branch', clip(name, 48), start ? `from ${clip(start, 40)}` : '');
}

/** `git stash`, `git stash push -u -m "wip" a.ts`, `git stash save "wip"`: `Stashed [changes] · “wip”`. */
function stashed(args: string[]): Desc | undefined {
  const [action, ...operands] = positionals(args, set('-m', '--message'));
  if (action === 'pop' || action === 'apply') return desc('git', 'Applied stash', 'git stash', clip(operands.join(' '), 40));
  if (action !== undefined && action !== 'push' && action !== 'save') return undefined;
  const message = flagValue(args, ['-m', '--message']) ?? (action === 'save' ? operands.join(' ') : '');
  const paths = action === 'push' ? operands.filter(word => word !== '--') : [];
  const note = message ? `· ${quoted(message)}` : paths.length ? `· ${pathsLabel(paths)}` : '';
  return desc('git', 'Stashed', 'changes', note);
}

/** What `git rev-parse` asked for: a flag's subject or the revision it resolved. */
const REV_PARSE_SUBJECTS: Record<string, string> = {
  '--show-toplevel': 'repo root', '--git-dir': 'git folder', '--absolute-git-dir': 'git folder', '--git-common-dir': 'git folder',
  '--is-inside-work-tree': 'work tree', '--show-prefix': 'repo path', '--show-cdup': 'repo root', '--git-path': 'git path',
};

/** `git rev-parse HEAD` → `Resolved [HEAD]`; `--abbrev-ref HEAD` → `Resolved [HEAD] branch name`; `--show-toplevel` → `[repo root]`. */
function revParse(args: string[]): Desc {
  const subject = args.map(arg => REV_PARSE_SUBJECTS[arg]).find(Boolean);
  const revisions = positionals(args, set('--short', '--git-path', '--default', '--prefix')).filter(word => word !== '--');
  const label = subject ?? (revisions.length ? clip(revisions[0], 48) : 'git rev-parse');
  const branch = !subject && args.some(arg => /^--abbrev-ref(?:=|$)/.test(arg)) ? 'branch name' : '';
  const more = !subject && revisions.length > 1 ? `+${revisions.length - 1} more` : '';
  return desc('git', 'Resolved', label, [branch, more].filter(Boolean).join(' · '));
}

/** `git merge-base --is-ancestor a b` → `Checked [a] is an ancestor of b`; plain merge-base finds the base. */
function mergeBase(args: string[]): Desc | undefined {
  const [ancestor, descendant] = positionals(args);
  if (!hasFlag(args, '--is-ancestor') || !ancestor || !descendant) return undefined;
  return desc('git', 'Checked', clip(ancestor, 48), `is an ancestor of ${clip(descendant, 40)}`);
}

/** `git tag`, `git tag -l 'v0.3.*'`, `git tag --list`, `git tag -n`: lists tags (a name without `-l` creates one). */
function listedTags(args: string[]): Desc | undefined {
  const listing = has(args, '-l', '--list') || args.some(arg => /^-n\d*$/.test(arg));
  const patterns = positionals(args, set('--sort', '--contains', '--no-contains', '--merged', '--no-merged', '--points-at', '--format', '--color'));
  if (!listing && patterns.length) return undefined;
  if (args.some(arg => /^-[a-zA-Z]*[asudfvm]/.test(arg) && !/^-n\d*$/.test(arg) && arg !== '-l')) return undefined;
  return desc('git', 'Listed', 'tags', patterns.length ? `matching ${clip(patterns.join(' '), 40)}` : '');
}

function gitPlumbing(sub: string, args: string[]): Desc | undefined {
  if (sub === 'tag') return listedTags(args);
  if (sub === 'checkout' || sub === 'switch') return createdBranch(sub, args);
  if (sub === 'stash') return stashed(args);
  if (sub === 'rev-parse') return revParse(args);
  return sub === 'merge-base' ? mergeBase(args) : undefined;
}

const GH_VERBS: Record<string, ShellVerb> = {
  view: 'Viewed', list: 'Listed', status: 'Checked', checks: 'Checked', diff: 'Viewed', create: 'Created', merge: 'Merged', comment: 'Commented on',
  edit: 'Edited', close: 'Closed', reopen: 'Reopened', checkout: 'Checked out', review: 'Reviewed', watch: 'Watched', rerun: 'Reran', api: 'Called', clone: 'Cloned',
};
const GH_FLAGS = set('-R', '--repo', '-q', '--jq', '-t', '--template', '--json', '-X', '--method', '-f', '-F', '--field', '-H', '--header', '-b', '--body', '--title',
  '--body-file', '-B', '--base', '--head', '-a', '--assignee', '-r', '--reviewer', '-l', '--label', '-m', '--milestone', '-p', '--project', '--notes', '-n', '--notes-file');
/** How a created item reads: `Created [PR] “Fix it”`. */
const GH_NOUNS: Record<string, string> = { pr: 'PR', issue: 'issue', release: 'release', gist: 'gist', repo: 'repo', label: 'label' };
/** What a `gh … delete` risk names: `Deletes a GitHub repository`. */
const GH_KINDS: Record<string, string> = { repo: 'repository', run: 'workflow run', cache: 'cache', secret: 'secret', variable: 'variable', ssh_key: 'SSH key' };

/** `gh pr create --title "Fix it" --body-file b.md` → `Created [PR] “Fix it”`; never the body or its file. */
function ghCreated(group: string, args: string[]): Desc | undefined {
  const title = flagValue(args, ['--title', '-t']);
  return title && GH_NOUNS[group] ? desc('github', 'Created', GH_NOUNS[group], quoted(title)) : undefined;
}

export const gh: Handler = (_program, args) => {
  const [group = '', action = '', ...rest] = positionals(args, GH_FLAGS);
  const created = action === 'create' ? ghCreated(group, args) : undefined;
  if (created) return created;
  const pair = group !== 'api' && action && !/^\d+$/.test(action) && !action.includes('/');
  const label = pair ? `gh ${group} ${action}` : `gh ${group}`.trim();
  const target = (pair ? rest : [action, ...rest]).filter(Boolean)[0] ?? '';
  const object = /^\d+$/.test(target) ? `#${target}` : clip(target, 60);
  const described = desc('github', GH_VERBS[pair ? action : group] ?? 'Ran', clip(label, 40), object);
  if (pair && action === 'delete') {
    const deleted = destroys({ ...described, verb: 'Deleted', icon: 'trash' }, group === 'repo' ? SEVERITY.critical : SEVERITY.other, `Deleted ${group} ${object}`.trim());
    return { ...deleted, reason: `Deletes a GitHub ${GH_KINDS[group] ?? GH_NOUNS[group] ?? group}` };
  }
  if (group === 'api' && /^delete$/i.test(flagValue(args, ['-X', '--method']) ?? '')) return destroys(described, SEVERITY.other, `Called DELETE ${object}`.trim());
  return described;
};
