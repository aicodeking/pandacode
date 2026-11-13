/* What one describeShell call learns as it walks a command (shell-intent.ts): shell functions, literal and loop
 * variables, variables trusted to hold scratch, the directory of the last literal `cd`, and the shared step budget.
 * Pure apart from the Context it is handed; total. */
import { basename, clip, desc, plural, positionals, set, trimTrailing, type Desc, type Step } from './shell-intent-base.ts';
import { SCRATCH_VARS, isScratchPath, risksOf, withRisks } from './shell-intent-risk.ts';

const RAW_TEXT = 80;
const DECLARERS = set('export', 'local', 'declare', 'typeset', 'readonly');
const OPENERS = set('if', 'then', 'do', 'else', 'elif', 'while', 'until', '!', '{');
/** `if `, `do `, `{ `: the keywords before a step's own command. */
export const LEADING_KEYWORDS = /^(?:(?:if|then|do|else|elif|while|until|!|\{)\s+)+/;

/** `gated`: the step only runs when the step before it succeeded (`a && b`). */
/** `dead`: the shell skips the step (`true || x`, `false && x`). */
/** `gated`: runs only after the step before it succeeded (`a && b`); `orElse`: only after it failed (`a || b`). */
export interface Described { program: string; desc: Desc; gated?: boolean; orElse?: boolean; dead?: boolean }
/** Shell functions defined earlier in the command: name → the meaningful steps of the body. */
export type Functions = Map<string, Described[]>;
/** A `for` loop's variable: its first literal item and how many there are (count 0: the list is not literal). */
export interface Loop { first?: string; count: number; glob?: boolean }
/** Where the shell stands: the last literal `cd` (relative to the start when not rooted), or unknown after `cd "$X"`. */
interface Place { cwd?: string; unknown: boolean }
/** What one describeShell call has learned so far: functions, literal variables (`F=src/a.ts`), variables trusted to
 * hold scratch (`$TMPDIR`, mktemp results), loop variables and the directory of the last literal `cd`. */
export interface Context {
  depth: number; functions: Functions; vars: Map<string, string>; scratch: Set<string>; loops: Map<string, Loop>;
  cwd?: string; cwds: Place[];
  /** The directory a `cd "$X"` or `popd` left unknown: relative paths can no longer be located. */
  cwdUnknown: boolean;
  /** The record's own working directory (Codex `Working directory`, a `workdir`), absolute; unset when the record has none. */
  base?: string;
  /** Steps left to describe, shared by every depth: a compound longer than this reads as the raw command. */
  budget: Budget;
}
/** How many steps one describeShell call may still describe; `exhausted` once a step was skipped, whose text `unchecked`
 * keeps for the fallback scan. `expansion`: characters variable substitution may still add, shared by every step, so
 * `A=$A$A` repeated cannot grow the work past it. */
export interface Budget { left: number; exhausted: boolean; expansion: number; unchecked: string[] }

/** Steps one describeShell call describes at most, counting nested scripts and substitutions. */
export const MAX_STEPS = 300;
/** The longest value a variable may hold or a word may grow to by substitution; past it the variable is unknown. */
export const MAX_VALUE = 4096;
/** Characters substitution may add over one describeShell call; past it variables stay as written (`$A`). */
export const MAX_EXPANSION = 64 * 1024;

export const newContext = (base?: string): Context => ({
  depth: 0, functions: new Map(), vars: new Map(), scratch: new Set(SCRATCH_VARS), loops: new Map(), cwds: [], cwdUnknown: false,
  budget: { left: MAX_STEPS, exhausted: false, expansion: MAX_EXPANSION, unchecked: [] }, ...(base && isAbsolute(base) ? { base: trimTrailing(base, '/') || '/' } : {}),
});
/** `/x`, `C:\x`: a path that names one file wherever the shell stands (`~` depends on whose home, so it is not). */
const isAbsolute = (path: string) => /^(?:\/|[A-Za-z]:[\\/])/.test(path);
export const deeper = (ctx: Context): Context => ({ ...ctx, depth: ctx.depth + 1 });
export const VAR_USE = /\$\{([A-Za-z_]\w*)\}|\$([A-Za-z_]\w*)(?![\w{[])/g;
export const ASSIGN_WORD = /^([A-Za-z_]\w*)=([\s\S]*)$/;

/** Substitutes known variables into a word; a word that would pass MAX_VALUE, or the call's expansion budget, stays as
 * written, so its variables read as unknown (`rm -rf $A` is still an unknown, destructive path). */
const replacer = (known: Map<string, string>, budget: Budget) => (word: string) => {
  if (!word.includes('$')) return word;
  const out = word.replace(VAR_USE, (whole, braced?: string, bare?: string) => known.get(braced ?? bare ?? '') ?? whole);
  const grown = out.length - word.length;
  if (out.length > MAX_VALUE || grown > budget.expansion) return word;
  budget.expansion -= Math.max(0, grown);
  return out;
};

/** `F=src/a.ts; sed -n 1,5p $F`: known literal variables (and a loop's first item) are replaced in every word,
 * redirect and input; the source text (quoted by risks) only takes the literal variables, since a loop runs every item. */
export function withVars(step: Step, ctx: Context): Step {
  const known = new Map(ctx.vars);
  ctx.loops.forEach((loop, name) => { if (loop.first !== undefined) known.set(name, loop.first); });
  if (!known.size) return step;
  const replace = replacer(known, ctx.budget), literal = replacer(ctx.vars, ctx.budget);
  return {
    ...step,
    pipes: step.pipes.map(pipe => ({ ...pipe, words: pipe.words.map(replace), redirect: replace(pipe.redirect), input: replace(pipe.input), text: pipe.text && literal(pipe.text) })),
  };
}

/** A step that only assigns (`F=a.ts`, `export D=src`, `T=$(mktemp -d)`) teaches the context its variables. */
export function recordAssignments(step: Step, ctx: Context): void {
  if (step.pipes.length !== 1) return;
  let words = step.pipes[0].words;
  if (DECLARERS.has(words[0] ?? '')) words = words.slice(1).filter(word => !/^-\w+$/.test(word));
  const pairs = words.map(word => ASSIGN_WORD.exec(word));
  if (!pairs.length || pairs.some(pair => !pair)) return;
  for (const pair of pairs) {
    const [, name = '', value = ''] = pair ?? [];
    if (/^(?:\$\(|`)\s*mktemp\b/.test(value)) { ctx.scratch.add(name); ctx.vars.delete(name); continue; }
    // `export TMPDIR=$HOME`: a reassigned variable is no longer trusted as scratch (a literal value is substituted instead).
    ctx.scratch.delete(name);
    if (/[$`*?(){}\[\]]/.test(value) || !value || value.length > MAX_VALUE) ctx.vars.delete(name);
    else ctx.vars.set(name, value);
  }
}

/** `TMPDIR=~ rm -rf $TMPDIR/x`: an inline assignment of anything but scratch stops trusting that variable. */
export function scopedScratch(words: string[], scratch: Set<string>): Set<string> {
  const assigned = words.slice(0, words.findIndex(word => !ASSIGN_WORD.test(word)) >>> 0).map(word => ASSIGN_WORD.exec(word));
  if (!assigned.length) return scratch;
  const out = new Set(scratch);
  for (const [, name = '', value = ''] of assigned.map(pair => pair ?? [])) {
    if (value && !/[`(]/.test(value) && isScratchPath(value, scratch)) out.add(name); else out.delete(name);
  }
  return out;
}

/** `cd /tmp/x`, `pushd src`: later relative paths resolve against it; `cd "$X"`, `cd -` and `popd` make it unknown.
 * `(cd x && …)` restores the directory when its subshell closes. */
export function recordCd(step: Step, ctx: Context): void {
  if (/^\((?!\()/.test(step.text)) ctx.cwds.push({ cwd: ctx.cwd, unknown: ctx.cwdUnknown });
  const words = step.pipes[0].words;
  const at = words.findIndex(word => !OPENERS.has(word));
  const program = words[at] ?? '';
  if (step.pipes.length !== 1 || !['cd', 'pushd', 'popd'].includes(program)) return;
  const [target] = positionals(words.slice(at + 1));
  const rooted = !!target && /^[/~]/.test(target);
  // `cd "$X" && cd sub`: a relative step from an unknown directory stays unknown.
  if (program === 'popd' || target === '-' || (target && /[$`*?]/.test(target)) || (ctx.cwdUnknown && target && !rooted)) {
    ctx.cwd = undefined;
    ctx.cwdUnknown = true;
    return;
  }
  ctx.cwdUnknown = false;
  if (!target || target === '~') ctx.cwd = '~';
  else ctx.cwd = trimTrailing(rooted || !ctx.cwd ? target : `${ctx.cwd}/${target}`, '/') || '/';
}

/** A produced image's path made absolute: as written when absolute, else joined to the record's working directory;
 * unknown (undefined) without one, under `~`, or after a `cd` to an unknown place. tool_images_auth/shell.rs resolves
 * paths the same way; both sides ignore `~` paths rather than guess the home directory.
 * `path` is already resolved against the last literal `cd`. */
export function locatedPath(path: string | undefined, ctx: Context): string | undefined {
  if (!path || isAbsolute(path)) return path;
  if (path.startsWith('~') || ctx.cwdUnknown || !ctx.base) return undefined;
  return `${trimTrailing(ctx.base, '/')}/${path.replace(/^(?:\.\/)+/, '')}`;
}

/** The end of a `( … )` subshell gives back the directory it started in. */
export function closeSubshell(step: Step, ctx: Context): void {
  const opens = (step.text.match(/\(/g) ?? []).length, closes = (step.text.match(/\)/g) ?? []).length;
  const place = closes > opens ? ctx.cwds.pop() : undefined;
  if (place) { ctx.cwd = place.cwd; ctx.cwdUnknown = place.unknown; }
}

/** `for p in a.ts b.ts; do`: `$p` reads as `a.ts` (2 items); `for p in $(ls)` and `while read -r p` leave it unknown. */
export function recordLoop(step: Step, ctx: Context): void {
  const words = step.pipes[0].words;
  if (words[0] === 'done') { ctx.loops.clear(); return; }
  if (words[0] === 'for' && words[2] === 'in' && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) {
    const items = words.slice(3).filter(word => word !== 'do');
    const literal = items.length > 0 && items.every(item => !/[$`(]/.test(item));
    ctx.loops.set(words[1], literal ? { first: items[0], count: items.length, glob: items.some(item => /[*?[]/.test(item)) } : { count: 0 });
  } else if (words[0] === 'for' && /^[A-Za-z_]\w*$/.test(words[1] ?? '')) ctx.loops.set(words[1], { count: 0 });
  else if (words[0] === 'while' && words[1] === 'read') positionals(words.slice(2), set('-p', '-d', '-n', '-N', '-t', '-u', '-a')).forEach(name => ctx.loops.set(name, { count: 0 }));
}

/** The loop variables a step uses. */
export function loopsUsed(step: Step, ctx: Context): Loop[] {
  if (!ctx.loops.size) return [];
  const names = step.pipes.flatMap(pipe => [...pipe.words.join(' ').matchAll(VAR_USE)].map(match => match[1] ?? match[2] ?? ''));
  return [...new Set(names)].flatMap(name => ctx.loops.get(name) ?? []);
}

/** A step inside a loop: `Read [a.ts] 3 items`; a chip that would show `$p` reads as `Ran [loop] …`. */
export function inLoop(described: Desc, loops: Loop[], text: string, program = ''): Desc {
  if (!loops.length || described.raw) return described;
  const body = loopedWork(described, loops, program);
  if (body) return body;
  if (described.label.includes('$')) return withRisks(desc('shell', 'Ran', 'loop', clip(sourceText(text), RAW_TEXT)), risksOf(described));
  const loop = loops.reduce((most, next) => next.count > most.count ? next : most);
  return loop.count > 1 ? counted(described, loop) : described;
}

/** `Read [a.py] +5 files` when the chip is the loop's first file; else `· 6 files` or `· 2 URLs`. Items nothing names
 * (`for i in 1 2 3 4`, a counter) are not counted: `· 4 items` beside a stray chip says nothing. */
function counted(described: Desc, loop: Loop): Desc {
  const first = loop.first ?? '';
  const noun = /^[a-z][\w+.-]*:\/\//i.test(first) ? 'URL' : described.kind === 'list' ? 'folder' : /\/|[^.]\.\w{1,8}$/.test(first) ? 'file' : '';
  if (!noun) return described;
  if (noun === 'file' && first && described.label === basename(first) && !described.object) return { ...described, object: `+${plural(loop.count - 1, 'file')}` };
  return { ...described, object: [described.object, plural(loop.count, noun)].filter(Boolean).join(' · ') };
}

const LOOPED_MEDIA = set('Encoded', 'Converted', 'Resized image', 'Processed', 'Captured screenshot');

/** `for k in a b c; do ffmpeg … $k.jpg; done` → `Encoded [3 files] with ffmpeg`; `for d in a b; do du -sh "$d"` →
 * `Checked disk usage [folders]`: the body's work over every item, not its first one (one literal item reads as itself). */
function loopedWork(described: Desc, loops: Loop[], program: string): Desc | undefined {
  const count = Math.max(...loops.map(loop => loop.count));
  const known = count > 1 && !loops.some(loop => loop.glob);
  if (count === 1 && !loops.some(loop => loop.glob)) return undefined;
  if (described.kind === 'media' && LOOPED_MEDIA.has(described.verb)) {
    return { ...described, label: known ? `${count} files` : 'files', object: program ? `with ${clip(program, 24)}` : '' };
  }
  if (described.verb === 'Checked disk usage') return { ...described, label: known ? `${count} folders` : 'folders', object: '' };
  return undefined;
}

/** `do rm -rf "$f"` → `rm -rf "$f"`: a step's command without the loop or group keywords around it. */
export function sourceText(text: string): string {
  const body = text.replace(LEADING_KEYWORDS, '').trimEnd();
  const closer = /(?:\}|\bdone|\bfi)$/.exec(body.slice(-5));
  return closer ? body.slice(0, body.length - closer[0].length).trimEnd() : body;
}
