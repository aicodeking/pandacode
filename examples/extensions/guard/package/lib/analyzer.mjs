// Command guard (sample.guard): the analyser. One browser-safe ES module (no imports, no Node, nothing but its own
// arguments), so the Node unit table, the preview and the installed service all run the same file.
//
// analyze(command, context) -> { verdict: 'allow' | 'deny', rule, reason, segment, steps, rewritable }
//   context: { cwd, root, home, temp: string[], level, rules: CustomRule[], escapes: boolean }
//   - `root` is the project folder and `cwd` the folder the call runs in; both absolute.
//   - `escapes` is true for POSIX shells (backslash escapes) and false for PowerShell/cmd paths with drive letters.
// Nothing here runs a command, reads a file or opens a socket: it only reads text.

export const LEVELS = ['standard', 'strict', 'paranoid'];
export const MAX_DEPTH = 10;
const SAFE_DIRS = new Set(['build', 'dist', 'out', 'target', 'coverage', 'node_modules', '.cache', 'tmp', '.next', '.turbo']);
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh', 'ash', 'fish']);
const REMOVERS = new Set(['rm', 'rmdir', 'del', 'erase', 'rd', 'remove-item', 'ri']);
const SUDO_VALUE_FLAGS = new Set(['-u', '-g', '-c', '-d', '-h', '-p', '-r', '-t', '-U', '-C', '-D', '--user', '--group', '--host', '--prompt', '--chdir']);

export const POLICY_PATH = '.sample-guard/policy.json';
export const levelRank = level => Math.max(0, LEVELS.indexOf(level));
export const higher = (a, b) => (levelRank(b) > levelRank(a) ? b : a);

const deny = (rule, reason, extra = {}) => ({ rule, reason, ...extra });
const base = word => String(word).replace(/\\/g, '/').split('/').pop().toLowerCase().replace(/\.(exe|cmd|bat)$/, '');

// ---- text to words -----------------------------------------------------------------------------------------------

/** Segments of a command line (split on | || && & ; and newlines, outside quotes), each as its words. null: a quote is open. */
export function parse(text, escapes = true) {
  const segments = [];
  let words = [], word = null, quote = null, start = 0;
  const endWord = () => { if (word !== null) { words.push(word); word = null; } };
  const endSegment = at => { endWord(); if (words.length) segments.push({ words, text: text.slice(start, at).trim() }); words = []; };
  for (let i = 0; i < text.length; i += 1) {
    const c = text[i];
    if (quote === "'") { if (c === "'") quote = null; else word += c; continue; }
    if (quote === '"') {
      if (c === '"') quote = null;
      else if (escapes && c === '\\' && i + 1 < text.length && '"\\$`'.includes(text[i + 1])) { i += 1; word += text[i]; } else word += c;
      continue;
    }
    if (c === "'" || c === '"') { quote = c; word ??= ''; continue; }
    if (escapes && c === '\\' && i + 1 < text.length) { i += 1; word = (word ?? '') + text[i]; continue; }
    if (c === '\n') { endSegment(i); start = i + 1; continue; }
    if (/\s/.test(c)) { endWord(); continue; }
    if (c === '&' && (text[i - 1] === '>' || text[i + 1] === '>')) { word = (word ?? '') + c; continue; }
    if (c === '|' || c === '&' || c === ';') {
      endSegment(i);
      if ((c === '|' || c === '&') && text[i + 1] === c) i += 1;
      start = i + 1;
      continue;
    }
    word = (word ?? '') + c;
  }
  if (quote) return null;
  endSegment(text.length);
  return segments;
}

/** The inner text of $( ... ) and `...` in a segment, so a substitution is analysed like a command of its own. */
export function substitutions(text) {
  const found = [];
  for (const match of text.matchAll(/\$\(([^()]*)\)/g)) found.push(match[1]);
  for (const match of text.matchAll(/`([^`]*)`/g)) found.push(match[1]);
  return found.filter(inner => inner.trim());
}

// ---- paths -------------------------------------------------------------------------------------------------------

const normalize = path => {
  let text = String(path).replace(/\\/g, '/');
  const drive = /^([A-Za-z]):(?=\/|$)/.exec(text);
  const prefix = drive ? `${drive[1].toLowerCase()}:` : '';
  if (drive) text = text.slice(2);
  const out = [];
  for (const part of text.split('/')) {
    if (part === '' || part === '.') continue;
    if (part === '..') out.pop(); else out.push(part);
  }
  const folded = prefix ? out.map(part => part.toLowerCase()) : out;
  return `${prefix}/${folded.join('/')}`;
};
const isAbsolute = path => /^([A-Za-z]:)?[\\/]/.test(path);
const isUnder = (path, parent) => path === parent || path.startsWith(parent === '/' || parent.endsWith('/') ? parent : `${parent}/`);

/** { path } for a literal path, { glob, path } when the last part has a wildcard (path is the parent), or { unresolved } for a variable we cannot know. */
export function resolveTarget(target, context) {
  let text = String(target);
  if (text === '~' || text.startsWith('~/')) text = `${context.home}${text.slice(1)}`;
  else if (/^\$\{?HOME\}?(\/|$)/.test(text)) text = text.replace(/^\$\{?HOME\}?/, context.home);
  else if (/^\$env:(USERPROFILE|HOME)(\\|\/|$)/i.test(text)) text = text.replace(/^\$env:(USERPROFILE|HOME)/i, context.home);
  if (/[$`]/.test(text) || /^%[^%]+%/.test(text)) return { unresolved: true };
  const absolute = isAbsolute(text) ? text : `${context.cwd}/${text}`;
  const full = normalize(absolute);
  const last = full.split('/').pop();
  if (/[*?[]/.test(last)) return { path: normalize(`${full}/..`), glob: true };
  return { path: full };
}

/** protected: the project, its parents, the home folder, a filesystem root or a temp root itself. */
export function classify(resolved, context) {
  if (resolved.unresolved) return 'unresolved';
  const root = normalize(context.root), home = normalize(context.home);
  const temps = (context.temp ?? []).map(normalize);
  const { path } = resolved;
  if (/^([a-z]:)?\/$/.test(path) || path === home || isUnder(root, path)) return 'protected';
  if (temps.includes(path)) return 'protected';
  if (isUnder(path, root)) return 'inside';
  if (temps.some(temp => isUnder(path, temp))) return 'temp';
  return 'outside';
}

// ---- rules -------------------------------------------------------------------------------------------------------

const gitSub = args => {
  let i = 0;
  while (i < args.length && args[i].startsWith('-')) i += ['-C', '-c', '--git-dir', '--work-tree', '--namespace'].includes(args[i]) ? 2 : 1;
  return { sub: args[i] ?? '', rest: args.slice(i + 1) };
};

function gitRule(args) {
  const { sub, rest } = gitSub(args);
  const has = (...flags) => rest.some(arg => flags.includes(arg));
  if (sub === 'reset' && has('--hard')) return deny('git.reset-hard', 'git reset --hard throws away uncommitted work.');
  if (sub === 'push') {
    const force = rest.some(arg => arg === '--force' || arg === '-f' || /^\+\S/.test(arg));
    if (force) return deny('git.push-force', 'A plain force push can overwrite other people\'s commits; use --force-with-lease.', { rewritable: true });
  }
  if (sub === 'stash' && ['drop', 'clear'].includes(rest[0])) return deny('git.stash-drop', 'git stash drop loses stashed work.');
  const dry = rest.some(arg => arg === '--dry-run' || /^-[a-zA-Z]*n/.test(arg));
  if (sub === 'clean' && !dry && rest.some(arg => arg === '--force' || /^-[a-zA-Z]*f/.test(arg))) return deny('git.clean-force', 'git clean -f deletes untracked files for good.');
  if (sub === 'checkout' && (rest.includes('--') || rest.includes('.')) && !has('-b', '-B')) return deny('git.checkout-discard', 'git checkout -- <path> discards changes in the working tree.');
  if (sub === 'restore' && !(has('--staged', '-S') && !has('--worktree', '-W'))) return deny('git.restore-worktree', 'git restore discards changes in the working tree.');
  if (sub === 'branch' && has('-D')) return deny('git.branch-force-delete', 'git branch -D deletes a branch that may not be merged.');
  return null;
}

function removeRule(name, args, context) {
  const ps = name === 'remove-item' || name === 'ri' || name === 'del' || name === 'erase' || name === 'rd';
  const targets = [];
  let recursive = false, endFlags = false;
  for (const arg of args) {
    if (!endFlags && arg === '--') { endFlags = true; continue; }
    if (!endFlags && arg.startsWith('-') && arg.length > 1) {
      const low = arg.toLowerCase();
      if (ps ? low.startsWith('-r') : /^-[a-zA-Z]*[rR]/.test(arg) || arg === '--recursive') recursive = true;
      continue;
    }
    if (!endFlags && ps && /^\/s$/i.test(arg)) { recursive = true; continue; }
    if (!endFlags && ps && /^\/[a-z]$/i.test(arg)) continue;
    targets.push(arg);
  }
  if (name === 'rmdir' && !recursive) return null;
  if (!recursive) return null;
  for (const target of targets) {
    const kind = classify(resolveTarget(target, context), context);
    const shown = `rm -rf ${target}`;
    if (kind === 'protected') return deny('rm.protected', `${shown} would delete the project, your home folder or a system root.`);
    if (kind === 'unresolved') return deny('rm.unresolved', `${shown} uses a variable the guard cannot resolve.`);
    if (kind === 'outside') return deny('rm.outside-project', `${shown} deletes outside the project.`);
    if (kind === 'inside') {
      if (context.level === 'paranoid') return deny('rm.paranoid-inside', `${shown} is a recursive delete; paranoid level blocks them all.`);
      if (context.level === 'strict') {
        const top = normalize(resolveTarget(target, context).path).slice(normalize(context.root).length + 1).split('/')[0];
        if (!SAFE_DIRS.has(top)) return deny('rm.strict-inside', `${shown} is not a known build folder; strict level blocks it.`);
      }
    }
  }
  return null;
}

function customRule(name, args, rules) {
  for (const rule of rules ?? []) {
    if (base(rule.command) !== name) continue;
    const blocked = rule.blockArgs ?? [];
    if (blocked.length === 0 || blocked.some(arg => args.includes(arg))) return deny(rule.id ?? `custom.${name}`, rule.reason ?? `${name} is blocked by a custom rule.`);
  }
  return null;
}

const writesPolicy = (name, words) => /\.sample-guard(\/|\\|$)/.test(words.join(' ')) && (['rm', 'mv', 'cp', 'tee', 'sed', 'truncate', 'del', 'move-item', 'set-content', 'out-file', 'remove-item'].includes(name) || words.some(word => /^\d*>>?/.test(word) || word === '>' || word === '>>'));

/** The rule a single simple command (no wrapper left) hits, or null. */
function simpleRule(name, args, words, context) {
  const custom = customRule(name, args, context.rules);
  if (custom) return custom;
  if (writesPolicy(name, words)) return deny('guard.policy-protected', 'The guard\'s own policy file cannot be changed by an agent.');
  if (name === 'git') return gitRule(args);
  if (REMOVERS.has(name)) return removeRule(name, args, context);
  if (name.startsWith('mkfs')) return deny('disk.format', 'Formatting a disk is blocked.');
  if (name === 'dd' && args.some(arg => /^of=\/dev\//.test(arg))) return deny('disk.raw-write', 'Writing to a raw device is blocked.');
  return null;
}

// ---- unwrapping --------------------------------------------------------------------------------------------------

function analyseWords(words, context, depth, steps, state) {
  let list = words.slice();
  while (list.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(list[0])) list.shift();
  if (!list.length) return null;
  if (depth > MAX_DEPTH) return deny('analysis.recursion-limit', `More than ${MAX_DEPTH} nested wrappers; the guard does not follow them further.`);
  const name = base(list[0]);
  const args = list.slice(1);
  steps.push(`${'  '.repeat(depth)}${name}${args.length ? ` (${args.length} argument${args.length === 1 ? '' : 's'})` : ''}`);
  if (name === 'sudo' || name === 'doas') {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += SUDO_VALUE_FLAGS.has(args[i]) ? 2 : 1;
    state.wrapped = true;
    return analyseWords(args.slice(i), context, depth + 1, steps, state);
  }
  if (name === 'env') {
    let i = 0;
    while (i < args.length && (args[i].startsWith('-') || /^[A-Za-z_][A-Za-z0-9_]*=/.test(args[i]))) i += args[i] === '-u' || args[i] === '-C' ? 2 : 1;
    state.wrapped = true;
    return analyseWords(args.slice(i), context, depth + 1, steps, state);
  }
  if (['command', 'exec', 'nohup', 'time', 'builtin', 'nice'].includes(name)) {
    let i = 0;
    while (i < args.length && args[i].startsWith('-')) i += name === 'nice' && args[i] === '-n' ? 2 : 1;
    state.wrapped = true;
    return analyseWords(args.slice(i), context, depth + 1, steps, state);
  }
  if (SHELLS.has(name)) {
    const at = args.findIndex(arg => /^-[a-zA-Z]*c$/.test(arg));
    if (at >= 0 && args[at + 1] !== undefined) { state.wrapped = true; return analyseText(args[at + 1], context, depth + 1, steps, state); }
    return null;
  }
  if (name === 'powershell' || name === 'pwsh') {
    const at = args.findIndex(arg => /^-(c|command)$/i.test(arg));
    if (at >= 0) { state.wrapped = true; return analyseText(args.slice(at + 1).join(' '), { ...context, escapes: false }, depth + 1, steps, state); }
    return null;
  }
  if (name === 'cmd') {
    const at = args.findIndex(arg => /^\/[ck]$/i.test(arg));
    if (at >= 0) { state.wrapped = true; return analyseText(args.slice(at + 1).join(' '), { ...context, escapes: false }, depth + 1, steps, state); }
    return null;
  }
  return simpleRule(name, args, list, context);
}

function analyseText(text, context, depth, steps, state) {
  const segments = parse(text, context.escapes !== false);
  if (segments === null) return deny('analysis.unparsed', 'The command has an unbalanced quote, so the guard cannot read it.', { unparsed: true });
  state.segments = Math.max(state.segments, segments.length);
  for (let index = 0; index < segments.length; index += 1) {
    const segment = segments[index];
    for (const inner of substitutions(segment.text)) {
      const found = analyseText(inner, context, depth + 1, steps, state);
      if (found) return { ...found, segment: depth === 0 ? index + 1 : found.segment, segmentText: depth === 0 ? segment.text : found.segmentText };
    }
    const found = analyseWords(segment.words, context, depth, steps, state);
    if (found) return { ...found, segment: depth === 0 ? index + 1 : found.segment, segmentText: depth === 0 ? segment.text : found.segmentText };
  }
  return null;
}

/** The verdict for one shell command line. A malformed line is denied at every level; strict also denies what it cannot parse. */
export function analyze(command, context) {
  const steps = [];
  const state = { wrapped: false, segments: 0 };
  const ctx = { level: 'standard', rules: [], temp: ['/tmp', '/var/tmp'], escapes: true, ...context };
  if (typeof command !== 'string' || !command.trim()) return { verdict: 'deny', rule: 'analysis.malformed', reason: 'The call has no command text.', segment: 1, segmentText: '', steps, rewritable: false };
  let found;
  try { found = analyseText(command, ctx, 0, steps, state); } catch (error) { found = deny('analysis.error', `The analyser failed (${String(error?.message ?? error).slice(0, 80)}).`); }
  if (!found) return { verdict: 'allow', rule: null, reason: 'No rule matched.', segment: null, segmentText: null, steps, rewritable: false };
  const where = state.segments > 1 && found.segment ? ` (segment ${found.segment}: ${String(found.segmentText ?? '').slice(0, 80)})` : '';
  const rewritable = found.rewritable === true && !state.wrapped && state.segments === 1 && /^[\w\s./:@=+~-]+$/.test(command);
  return { verdict: 'deny', rule: found.rule, reason: `${found.reason}${where}`, segment: found.segment ?? 1, segmentText: found.segmentText ?? command, steps, rewritable };
}

/** `git push --force origin main` -> `git push --force-with-lease origin main` (only the first plain force flag). */
export function rewriteForcePush(command) {
  const next = command.replace(/(^|\s)(--force|-f)(?=\s|$)/, '$1--force-with-lease');
  return next === command ? null : next;
}

/** A path a write or edit tool aims at, judged against the guard's own policy file. */
export function checkWritePath(path, context) {
  if (typeof path !== 'string' || !path) return null;
  const full = resolveTarget(path, context);
  if (full.path && (full.path.endsWith(`/${POLICY_PATH}`) || full.path.includes('/.sample-guard/'))) return deny('guard.policy-protected', 'The guard\'s own policy file cannot be changed by an agent.');
  return null;
}

// ---- policy ------------------------------------------------------------------------------------------------------

/** { ok, level, rules } from the text of a policy file; { ok: false } when it is not valid (the defaults apply, the status says degraded). */
export function readPolicy(text) {
  if (text === null || text === undefined || text === '') return { ok: true, level: null, rules: [] };
  let raw;
  try { raw = JSON.parse(text); } catch { return { ok: false, level: null, rules: [] }; }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { ok: false, level: null, rules: [] };
  if (raw.level !== undefined && !LEVELS.includes(raw.level)) return { ok: false, level: null, rules: [] };
  const rules = [];
  for (const rule of raw.rules ?? []) {
    if (!rule || typeof rule.command !== 'string' || !rule.command.trim()) return { ok: false, level: null, rules: [] };
    if (rule.blockArgs !== undefined && !(Array.isArray(rule.blockArgs) && rule.blockArgs.every(arg => typeof arg === 'string'))) return { ok: false, level: null, rules: [] };
    if (rule.reason !== undefined && (typeof rule.reason !== 'string' || rule.reason.length > 200)) return { ok: false, level: null, rules: [] };
    rules.push({ id: `custom.${base(rule.command)}`, command: rule.command, blockArgs: rule.blockArgs ?? [], reason: rule.reason });
  }
  return { ok: true, level: raw.level ?? null, rules };
}

// ---- audit -------------------------------------------------------------------------------------------------------

/** A command with secrets replaced by <redacted> (tokens, passwords, bearer values, credentials in URLs). */
export function redact(text) {
  return String(text)
    .replace(/(\b(?:token|secret|password|passwd|api[_-]?key|authorization)\b\s*[=:]\s*)("[^"]*"|'[^']*'|\S+)/gi, '$1<redacted>')
    .replace(/(--(?:password|token|secret|api-key)(?:=|\s+))(\S+)/gi, '$1<redacted>')
    .replace(/(\bBearer\s+)\S+/gi, '$1<redacted>')
    .replace(/(:\/\/[^/\s:@]+:)[^@\s/]+(@)/g, '$1<redacted>$2')
    .replace(/\b(?:tok|ghp|gho|ghs|sk|xox[bp])[-_][A-Za-z0-9_-]{6,}/g, '<redacted>');
}
