/**
 * Static design-token guard: segmented-control options keep regular body weight.
 * Tracks are discovered, not listed: every src/ CSS selector with a child compound naming
 * `.segment-thumb` (`.x>.segment-thumb`, `.x>.a.segment-thumb`, `.x>:is(.segment-thumb)`,
 * `.x>[class~="segment-thumb"]`) names its parent compound's own classes as tracks; every src/ script
 * HTML tag carrying `data-segmented` adds the literal classes of its quoted `class` attribute (balanced
 * `${...}` slots dropped; JSX `className` is not read); `:not()` parity is resolved everywhere (odd-depth
 * `:not(X)` drops X, `:not(:not(X))` counts as X);
 * `[data-segmented]` (what trackSegment() sets at runtime) and the `.choice-menu-segment` option
 * class are always included. Any rule whose subject is a track itself (options inherit its weight
 * through `button{font:inherit}`), sits inside a track (any state: default, :hover, [aria-checked],
 * [aria-selected], [aria-pressed], .selected) or is a `.choice-menu-segment` option may not set a
 * medium/strong/bold/heading-role or numeric > 400 weight, directly, via `font:` (every pre-size token,
 * `var()` included; a lone `font: var(--x)` resolves as a whole shorthand, and any other single token but
 * `inherit`/`unset`, system fonts such as `caption` included, fails closed), a `var()` fallback, a custom
 * property (resolved across src/ CSS; unknown or cyclic ones fail closed), a math function
 * (`calc()`/`min()`/`max()`/`clamp()`) or a `font-variation-settings` value that is not proven regular
 * (`'wght'` axes checked as weights, `var()` entries resolved, unrecognised entries fail; the thumb is
 * exempt). `[data-segmented=...]` value forms count as the attribute track, and `[class~=...]`,
 * `[class=...]` and substring class attribute selectors count as the class they name. The structural
 * base rule `[data-segmented],.ds-seg{font-weight:var(--type-body-weight);font-variation-settings:normal}`
 * in src/design-system.css keeps a bold ancestor from leaking into options; its presence is verified (an
 * unconditional top-level rule outside any at-rule, `[data-segmented]` and `.ds-seg` as exact subjects, an
 * explicit regular weight and `font-variation-settings:normal`), and a track subject may not undo it with
 * `font-weight`/`font`/`font-variation-settings` `inherit`/`unset` or any `all:`
 * (option rules inside a track, such as `button{font:inherit}`, may still inherit). TS tags are read
 * from every SCRIPT_EXTS module. Custom-property resolution is name-based, not cascade-aware: a regular
 * definition anywhere never masks a heavy one, since every definition must be regular, regular role
 * tokens (`--weight-regular`, `--type-body-weight`, ...) included; canonical token ownership (role tokens
 * defined only in src/tokens.css) is additionally enforced by tokenOwner() in parser.mjs.
 * A compound with a `:has(… .segment-thumb)` argument is a track too (its own classes are discovered,
 * and a class-less `:has(>.segment-thumb)` compound counts as a track where it appears).
 * Scope: src/ CSS rules only; inline `style="font-weight:…"` attributes and script `el.style.fontWeight`
 * / `style.setProperty()` writes are not scanned.
 * Boundaries: tracks selected only by ID or element tag, classes a track gets only from script (classList/className, JSX `className`) and tracks with neither a
 * `.segment-thumb` rule nor a `data-segmented` tag (the `.bs-nav` and `.jev-assist-tabs` tab conventions) are not discovered.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import { root, SCRIPT_EXTS } from './allowlists.mjs';
import { parseBlocks, stripComments, declarations, walk } from './parser.mjs';
import { splitTop, topSlash, decodeCssEscapes } from './parser-values.mjs';

const OPTION_CLASSES = ['.choice-menu-segment'];
const ATTR_TRACK = '[data-segmented]';
const THUMB = '.segment-thumb';
const HEAVY_VAR = /^var\(\s*--(?:weight-(?:medium|strong|semibold|bold)|type-(?:subheading|heading|title|display)-weight)\b/;

const rel = path => relative(root, path).split('\\').join('/');
const treeCache = new Map();
/** The src/ files with these extensions (read once per run; self-tests merge their probes over a copy). */
const readTree = ext => {
  const key = [ext].flat().join(',');
  if (!treeCache.has(key)) treeCache.set(key, Object.fromEntries(walk(join(root, 'src'), ext).filter(path => !path.endsWith('.d.ts')).map(path => [rel(path), readFileSync(path, 'utf8')])));
  return treeCache.get(key);
};
const blockCache = new Map();
/** Parsed blocks of one stylesheet, memoised by its text. */
const blocksOf = css => {
  if (!blockCache.has(css)) blockCache.set(css, parseBlocks(stripComments(css)).map(block => ({ ...block, decls: declarations(block.body) })));
  return blockCache.get(css);
};

/** Split one complex selector into compounds at top-level combinators (whitespace, `>`, `+`, `~`). */
export function compounds(selector) {
  const out = [];
  let depth = 0, current = '', quote = '';
  for (const c of selector.trim()) {
    if (quote) { current += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; current += c; continue; }
    if (c === '(' || c === '[') depth++;
    if (c === ')' || c === ']') depth--;
    if (!depth && /[\s>+~]/.test(c)) { if (current) out.push(current); current = ''; continue; }
    current += c;
  }
  if (current) out.push(current);
  return out;
}

/** Every `:name(...)` call in a compound as { start, end, inner }, parentheses balanced at any depth, quotes skipped. */
function pseudoCalls(compound, name) {
  const out = [], open = `:${name}(`, lower = compound.toLowerCase();
  for (let at = lower.indexOf(open); at >= 0; at = lower.indexOf(open, out.at(-1).end)) {
    let depth = 0, quote = '', end = at + open.length - 1;
    for (; end < compound.length; end++) {
      const c = compound[end];
      if (quote) { if (c === '\\') end++; else if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") quote = c;
      else if (c === '(') depth++;
      else if (c === ')' && !--depth) break;
    }
    out.push({ start: at, end: end + 1, inner: compound.slice(at + open.length, end) });
  }
  return out;
}
/** The compound with every `:name(...)` call (any nesting depth) removed. */
const stripPseudo = (compound, name) => pseudoCalls(compound, name).reduceRight((text, call) => text.slice(0, call.start) + text.slice(call.end), compound);
/** The inner text of every top-level `:name(...)` call (any nesting depth inside). */
const pseudoArgs = (compound, name) => pseudoCalls(compound, name).map(call => call.inner);
/**
 * Resolve `:not(...)` parity: an odd-depth `:not(X)` is dropped, so a negated class never counts as a
 * match, while an even-depth `:not(:not(X))` unwraps `X` back into positive content (space-separated,
 * so adjacent tokens never paste together); `:not(:not(:not(X)))` stays excluded.
 */
const withoutNot = compound => pseudoCalls(compound, 'not').reduceRight((text, call) => `${text.slice(0, call.start)} ${negatedBack(call.inner)} ${text.slice(call.end)}`, compound);
/** The positive content inside a negation: each nested `:not(Y)` there, with `Y`'s own parity resolved. */
const negatedBack = inner => pseudoCalls(inner, 'not').map(call => withoutNot(call.inner)).join(' ');
const classesOf = compound => [...withoutNot(compound).matchAll(/\.(-?[_a-zA-Z][-\w]*)/g)].map(match => `.${match[1]}`);
/** A `:has(…)` argument naming `.segment-thumb` outside any `:not(…)`, at any nesting depth, makes its compound a track. */
const isHasThumb = compound => pseudoArgs(withoutNot(compound), 'has').some(arg => hasToken(arg, THUMB));
/** The compound's own classes, `:has()` arguments dropped (so `.segment-thumb` itself never becomes a track). */
const ownClasses = compound => classesOf(stripPseudo(compound, 'has'));
/** Optional CSS attribute namespace prefix: `[*|attr]`, `[|attr]`, `[ns|attr]`. */
const NS = String.raw`(?:(?:\*|[-_\w]*)?\|)?`;
/** `[data-segmented]` also matches any value form (`[data-segmented=""]`, `[data-segmented="true" i]`) and namespace prefix. */
const ATTR_MATCH = new RegExp(String.raw`\[\s*${NS}data-segmented(?:[~|^$*]?=[^\]]*)?\]`, 'i');
/**
 * Whether a `[class...]` attribute selector inside the compound matches class `cls`, as parser-select.mjs
 * reads them: `~=` one whitespace-free token, `=` any space-separated token, `^=`/`$=`/`*=`/`|=` as
 * substrings of the class (non-empty values only), optional `i`/`s` flag.
 */
const CLASS_ATTR = new RegExp(String.raw`\[\s*${NS}class\s*([~^$*|]?=)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'\]]+))\s*([is])?\s*\]`, 'gi');
const SUBSTRING = {
  '^=': (cls, v) => cls.startsWith(v),
  '$=': (cls, v) => cls.endsWith(v),
  '*=': (cls, v) => cls.includes(v),
  '|=': (cls, v) => cls === v || cls.startsWith(`${v}-`),
};
const classAttrHit = (compound, cls) => [...compound.matchAll(CLASS_ATTR)].some(match => {
  const fold = match[5]?.toLowerCase() === 'i' ? text => text.toLowerCase() : text => text;
  const value = fold(match[2] ?? match[3] ?? match[4] ?? ''), name = fold(cls);
  if (SUBSTRING[match[1]]) return Boolean(value) && SUBSTRING[match[1]](name, value);
  const tokens = match[1] === '~=' ? (/^\S+$/.test(value) ? [value] : []) : value.split(/\s+/).filter(Boolean);
  return tokens.includes(name);
});
const hasToken = (compound, token) => token === ATTR_TRACK
  ? ATTR_MATCH.test(withoutNot(compound).replace(/\s+/g, ''))
  : token.startsWith('[') ? withoutNot(compound).replace(/\s+/g, '').includes(token)
  : new RegExp(`${token.replace('.', '\\.')}(?![-\\w])`).test(withoutNot(compound)) || classAttrHit(withoutNot(compound), token.slice(1));

/** Every rule as { file, selector, body } with nesting resolved and comma lists split. */
function rules(cssMap) {
  const out = [];
  for (const [file, css] of Object.entries(cssMap)) {
    for (const block of blocksOf(css)) {
      if (!block.effectiveSelector) continue;
      for (const selector of splitTop(decodeCssEscapes(block.effectiveSelector), /,/)) out.push({ file, selector: selector.trim(), body: block.body, decls: block.decls });
    }
  }
  return out;
}

/** Track selectors: `[data-segmented]`, the option classes, CSS `.segment-thumb` parents and TS `data-segmented` tag classes. */
export function segmentedTracks(cssMap, tsMap) {
  const tracks = new Set([ATTR_TRACK]);
  for (const { selector } of rules(cssMap)) {
    // A child compound naming the thumb (`.a.segment-thumb`, `:is(.segment-thumb)`, `[class~="segment-thumb"]`, `:not()` parity resolved) makes its parent a track.
    const steps = splitTop(selector, />/);
    for (let at = 1; at < steps.length; at++) {
      if (hasToken(stripPseudo(compounds(steps[at])[0] ?? '', 'has'), THUMB)) for (const name of ownClasses(compounds(steps[at - 1]).at(-1) ?? '')) tracks.add(name);
    }
    for (const part of compounds(selector)) if (isHasThumb(part)) for (const name of ownClasses(part)) tracks.add(name);
  }
  for (const source of Object.values(tsMap)) {
    for (const [tag] of source.matchAll(/<[a-z][\w-]*\b[^<>]*\bdata-segmented\b[^<>]*>/g)) {
      for (const name of tagClasses(tag)) tracks.add(`.${name}`);
    }
  }
  return tracks;
}

/** The literal class names of an HTML tag's quoted `class` attribute, balanced `${...}` template slots dropped. */
export function tagClasses(tag) {
  const match = /(?<![-\w])class\s*=\s*(["'])/.exec(tag);
  if (!match) return [];
  let text = '';
  for (let i = match.index + match[0].length, depth = 0; i < tag.length; i++) {
    const c = tag[i];
    if (!depth && c === match[1]) break;
    if (c === '$' && tag[i + 1] === '{') { depth++; i++; text += ' '; continue; }
    if (depth && c === '{') depth++;
    else if (depth && c === '}') depth--;
    else if (!depth) text += c;
  }
  return text.split(/\s+/).filter(name => /^-?[_a-zA-Z][-\w]*$/.test(name));
}

const REGULAR_VAR = /^--(?:weight-regular|type-(?:body|meta|caption|prose)-weight)$/;
const SAFE_KEYWORD = /^(?:normal|lighter)$/i;
const INHERIT_KEYWORD = /^(?:inherit|unset)$/i;

/** Every custom property declared in `cssMap` (`--name` -> raw values), so `var(--x)` can be resolved. */
export function customDefs(cssMap) {
  const defs = new Map();
  for (const css of Object.values(cssMap)) {
    for (const block of blocksOf(css)) {
      for (const decl of block.decls) {
        if (!decl.property.startsWith('--')) continue;
        defs.set(decl.property, [...(defs.get(decl.property) ?? []), decl.value]);
      }
    }
  }
  return defs;
}

/**
 * Whether a weight value is (or may be) heavier than regular body weight, failing closed: only
 * `normal`/`lighter`, `inherit`/`unset` (unless `allowInherit` is false, as on a track subject), a number <= 400, a custom property whose every src/ definition
 * is proven regular (regular role tokens too), or a regular role token with no definition in `defs` passes. bold/bolder, numbers > 400, heavy role tokens,
 * heavy `var()` fallbacks, math functions (`calc()`/`min()`/`max()`/`clamp()`), unknown or cyclic
 * custom properties (script-set or undeclared) and anything unrecognised count as heavy.
 */
export function heavyWeight(value, defs = new Map(), seen = new Set(), { allowInherit = true } = {}) {
  const opts = { allowInherit };
  const bare = value.replace(/!\s*important\s*$/i, '').trim();
  if (SAFE_KEYWORD.test(bare)) return false;
  if (INHERIT_KEYWORD.test(bare)) return !allowInherit;
  if (/^(?:bold|bolder)$/i.test(bare)) return true;
  if (/^\d+(?:\.\d+)?$/.test(bare)) return Number(bare) > 400;
  if (/^(?:calc|min|max|clamp)\(/i.test(bare)) return true;
  const call = /^var\(([\s\S]*)\)$/i.exec(bare);
  if (!call) return true;
  const args = splitTop(call[1], /,/);
  const name = args[0].trim();
  if (args.length > 1 && heavyWeight(args.slice(1).join(','), defs, seen, opts)) return true;
  if (HEAVY_VAR.test(bare)) return true;
  // Every src/ definition is checked, regular role tokens included; only an undefined regular role token (standalone calls) passes by name.
  const list = defs.get(name);
  if (!list?.length) return !REGULAR_VAR.test(name);
  if (seen.has(name)) return true;
  const nextSeen = new Set([...seen, name]);
  return list.some(item => heavyWeight(item, defs, nextSeen, opts));
}

const STYLE_KEYWORD = /^(?:italic|oblique|small-caps|ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/i;
/** A literal CSS `<font-size>` (a length or percentage, or an absolute/relative size keyword); never a `var()`. */
const LITERAL_SIZE = /^(?:-?\d*\.?\d+(?:[a-z]+|%)|(?:xx?x?-)?(?:small|large)|medium|smaller|larger|math)$/i;
/** The exact canonical size tokens (no open-ended prefixes). */
const SIZE_VAR_NAME = /^--(?:type-(?:display|title|heading|subheading|body|prose|meta|caption)|mono-size|thread-font|code-inline-size|md-heading-lg|md-cite-size|md-katex-size)$/;
/** A bare `var(--name)` of an exact canonical size token, with no fallback. */
const EXACT_SIZE_VAR = /^var\(\s*(--[\w-]+)\s*\)$/i;
const isExactSizeVar = tok => SIZE_VAR_NAME.test(EXACT_SIZE_VAR.exec(tok)?.[1] ?? '');
/** Size-like token for shorthandWeights() when no definitions are known: a literal size or a bare exact size var. */
const SIZE_TOKEN = { test: tok => LITERAL_SIZE.test(tok) || isExactSizeVar(tok) };

/**
 * Whether `tok` is provably a bare size: a literal size, or a bare exact size var (no fallback) whose
 * every definition in `defs` (if any) is itself a single top-level token that is a literal size or a
 * safe exact size var (so a poisoned `--type-body:700 13px` or `--type-body:bold` is not a size).
 */
export function isSafeSizeToken(tok, defs = new Map(), seen = new Set()) {
  if (LITERAL_SIZE.test(tok)) return true;
  if (!isExactSizeVar(tok)) return false;
  const name = EXACT_SIZE_VAR.exec(tok)[1];
  if (seen.has(name)) return false;
  const nextSeen = new Set([...seen, name]);
  return (defs.get(name) ?? []).every(def => {
    const parts = splitTop(def.replace(/!\s*important\s*$/i, '').trim(), /\s+/).filter(Boolean);
    return parts.length <= 1 && isSafeSizeToken((parts[0] ?? '').trim(), defs, nextSeen);
  });
}

/**
 * The tokens of a `font` shorthand that sit before `<font-size>` and could be a weight: everything
 * but the style/variant/stretch keywords, `var()` and math functions included. The size is the first
 * token with a top-level `/`, else the first size-like token, else the last token (so every token
 * before the family is checked, a 2-token `var(--w) var(--rest)` included).
 */
export function shorthandWeights(value, defs) {
  const bare = value.replace(/!\s*important\s*$/i, '').trim();
  const tokens = splitTop(bare, /\s+/).map(tok => tok.trim()).filter(Boolean);
  if (tokens.length <= 1) return [];
  const isSize = defs ? tok => isSafeSizeToken(tok, defs) : tok => SIZE_TOKEN.test(tok);
  let sizeIdx = tokens.findIndex(tok => topSlash(tok));
  if (sizeIdx < 0) sizeIdx = tokens.findIndex(isSize);
  // No slash and no size-like token: every token but the last (the family) may be a weight.
  if (sizeIdx < 0) sizeIdx = tokens.length - 1;
  return tokens.slice(0, sizeIdx).filter(tok => !STYLE_KEYWORD.test(tok));
}

/** A `var(--name[, fallback])` value: heavy when the fallback is heavy (by `check`) or the property is unknown, cyclic or has any heavy definition. */
function heavyVar(call, defs, seen, check, opts = {}) {
  const args = splitTop(call, /,/);
  const name = args[0].trim();
  if (args.length > 1 && check(args.slice(1).join(','), defs, seen, opts)) return true;
  const list = defs.get(name);
  if (!list?.length || seen.has(name)) return true;
  const nextSeen = new Set([...seen, name]);
  return list.some(item => check(item, defs, nextSeen, opts));
}

/**
 * Whether a `font` shorthand may set a heavy weight, failing closed. `inherit`/`unset` pass unless
 * `opts.allowInherit === false` (a track subject, where they would undo the base reset); a lone
 * `var()` resolves (fallback and every definition, as a whole shorthand); any other single token (a
 * system font such as `caption` or `menu`, `bold`, `calc()`) fails. A `var()` left of the top-level `/`
 * that is not a safe size token (isSafeSizeToken(): a literal, or a bare exact size var with no fallback
 * and only single-token size definitions), or (with no `/` and no safe size token) the first `var()`, is expanded in place
 * with its fallback and every definition and the whole shorthand rechecked (unknown or cyclic fail);
 * otherwise every pre-size token is checked as a weight.
 */
export function heavyFontShorthand(value, defs = new Map(), seen = new Set(), opts = {}) {
  const bare = value.replace(/!\s*important\s*$/i, '').trim();
  const tokens = splitTop(bare, /\s+/).map(tok => tok.trim()).filter(Boolean);
  if (tokens.length === 1) {
    if (INHERIT_KEYWORD.test(bare)) return opts.allowInherit === false;
    const call = /^var\(([\s\S]*)\)$/i.exec(bare);
    return call ? heavyVar(call[1], defs, seen, heavyFontShorthand, opts) : true;
  }
  // A `var()` left of the top-level `/` that is not a size token may itself hold weight and size (`var(--x)/1 sans-serif`).
  const slashIdx = tokens.findIndex(tok => topSlash(tok));
  if (slashIdx >= 0) {
    const [left, right] = topSlash(tokens[slashIdx]);
    const call = VAR_CALL.exec(left.trim());
    if (call && !isSafeSizeToken(left.trim(), defs)) return expandShorthandVar(tokens, slashIdx, call[1], rep => `${rep}/${right}`, defs, seen, opts);
  }
  // With no slash and no size token, the size hides in a `var()`: expand the first one in place (`var(--w) var(--rest)`).
  if (slashIdx < 0 && !tokens.some(tok => isSafeSizeToken(tok, defs))) {
    const varIdx = tokens.findIndex(tok => VAR_CALL.test(tok));
    if (varIdx >= 0) return expandShorthandVar(tokens, varIdx, VAR_CALL.exec(tokens[varIdx])[1], rep => rep, defs, seen, opts);
  }
  return shorthandWeights(bare, defs).some(weight => heavyWeight(weight, defs, seen, opts));
}

const VAR_CALL = /^var\(([\s\S]*)\)$/i;
/**
 * Substitute `var(--name[, fallback])` at `tokens[idx]` (through `wrap`) with its fallback and every
 * src/ definition, rechecking each whole shorthand; unknown or cyclic properties fail closed, except an
 * undefined regular role token (`--weight-regular`), which reads as `400`, and an undefined exact size
 * token (`--type-body`), which reads as `1rem` (its fallback is still expanded and checked).
 */
function expandShorthandVar(tokens, idx, call, wrap, defs, seen, opts) {
  const args = splitTop(call, /,/);
  const name = args[0].trim();
  const list = defs.get(name);
  if (seen.has(name)) return true;
  const reps = [...(args.length > 1 ? [args.slice(1).join(',').trim()] : []), ...(list ?? [])];
  if (!list?.length) {
    if (REGULAR_VAR.test(name)) reps.push('400');
    else if (SIZE_VAR_NAME.test(name)) reps.push('1rem');
    else return true;
  }
  const nextSeen = new Set([...seen, name]);
  return reps.some(rep => heavyFontShorthand(tokens.map((tok, at) => at === idx ? wrap(rep.trim()) : tok).join(' '), defs, nextSeen, opts));
}

/**
 * Whether `font-variation-settings` may set a heavy `'wght'` axis, failing closed: `normal`, `inherit`/
 * `unset` (unless `allowInherit` is false, as on a track subject) and literal non-`wght` axes pass, `'wght'` values are checked like a weight, and `var()`
 * entries resolve (unknown or cyclic ones fail); anything unrecognised fails.
 */
export function heavyVariation(value, defs = new Map(), seen = new Set(), { allowInherit = true } = {}) {
  const opts = { allowInherit };
  const bare = value.replace(/!\s*important\s*$/i, '').trim();
  if (/^normal$/i.test(bare)) return false;
  if (INHERIT_KEYWORD.test(bare)) return !allowInherit;
  const entries = splitTop(bare, /,/).map(entry => entry.trim()).filter(Boolean);
  if (!entries.length) return true;
  return entries.some(entry => {
    const call = /^var\(([\s\S]*)\)$/i.exec(entry);
    if (call) return heavyVar(call[1], defs, seen, heavyVariation, opts);
    const wght = /^(["'])wght\1\s+([\s\S]+)$/i.exec(entry);
    if (wght) return heavyWeight(wght[2].trim(), defs, new Set(), opts);
    return !/^(["'])[a-z0-9]{4}\1\s+[\s\S]+$/i.test(entry);
  });
}

const BASE_FILE = 'src/design-system.css';
/**
 * Whether src/design-system.css keeps an unconditional top-level rule (outside every at-rule) whose
 * selector list holds `token` exactly as a subject and sets both an explicit regular `font-weight` and
 * `font-variation-settings: normal` (not inherited, so a heavy ancestor `'wght'` axis never leaks in).
 */
function hasBaseReset(css, token, defs) {
  const strict = { allowInherit: false };
  return blocksOf(css ?? '').some(block => !block.parentBlock && block.effectiveSelector && !block.selector.startsWith('@')
    && splitTop(decodeCssEscapes(block.effectiveSelector), /,/).some(sel => sel.replace(/\s+/g, '') === token)
    && block.decls.some(decl => decl.property.toLowerCase() === 'font-weight' && !heavyWeight(decl.value, defs, new Set(), strict))
    && block.decls.some(decl => decl.property.toLowerCase() === 'font-variation-settings' && /^normal$/i.test(decl.value.replace(/!\s*important\s*$/i, '').trim())));
}

/**
 * Segmented options at medium/strong/bold weight, as problem strings. `extraCss` / `extraTs`
 * (file -> source) are merged over the live src/ tree for self-tests.
 */
export function segmentedWeightProblems(extraCss = {}, extraTs = {}) {
  const cssMap = { ...readTree('.css'), ...extraCss };
  const tsMap = { ...readTree(SCRIPT_EXTS), ...extraTs };
  const tracks = [...segmentedTracks(cssMap, tsMap)];
  const defs = customDefs(cssMap);
  const problems = [];
  for (const token of [ATTR_TRACK, '.ds-seg']) {
    if (!hasBaseReset(cssMap[BASE_FILE], token, defs)) problems.push(`${BASE_FILE} must keep the unconditional regular font-weight and font-variation-settings:normal reset on [data-segmented] and .ds-seg (missing ${token})`);
  }
  for (const { file, selector, decls } of rules(cssMap)) {
    const parts = compounds(selector);
    const subject = parts.at(-1) ?? '';
    if (/^\.segment-thumb(?![-\w])/.test(subject)) continue;
    const onOptionPart = part => OPTION_CLASSES.some(token => hasToken(part, token));
    const isTrack = part => tracks.some(token => hasToken(part, token)) || (isHasThumb(part) && !onOptionPart(part));
    const inTrack = parts.some(isTrack);
    const onOption = parts.some(part => OPTION_CLASSES.some(token => hasToken(part, token)));
    if (!inTrack && !onOption) continue;
    // On a track itself, `inherit`/`unset` and any `all:` would undo the base regular-weight reset; options inside a track may inherit it.
    const isTrackSubject = isTrack(subject) && !onOptionPart(subject);
    const opts = { allowInherit: !isTrackSubject };
    for (const decl of decls) {
      const property = decl.property.toLowerCase();
      const heavy = property === 'font-weight' ? heavyWeight(decl.value, defs, new Set(), opts)
        : property === 'font' ? heavyFontShorthand(decl.value, defs, new Set(), opts)
        : property === 'all' ? isTrackSubject
        : property === 'font-variation-settings' && heavyVariation(decl.value, defs, new Set(), opts);
      if (heavy) problems.push(`${file} ${selector} sets ${property}:${decl.value} on a segmented track or option; keep regular body weight`);
    }
  }
  return problems;
}
