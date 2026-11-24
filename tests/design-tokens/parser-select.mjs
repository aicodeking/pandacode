/**
 * Selector grammar and the shared single-line <select> policy for the CSS guard.
 * Nesting (&), @scope roots and :scope are expanded into effective selectors;
 * selector chains split on combinators outside brackets and functional pseudos;
 * compounds expose their base and :is/:where/:not/:has groups for subject and
 * ancestor role tests. Select checks evaluate :is/:where/:not against possible
 * size/multiple states and enforce one shared rule per owner sheet: only that rule
 * sets the chevron image, position and repeat, or clears appearance (a component
 * appearance:none would outrank the forced-colors native arrow); `all:` on any select
 * fails, since it strips appearance, chevron and padding along with the font.
 * Class-only rules are held to the same policy when they name a class that src/ places
 * on a <select> (see selectClasses()), as `.name`, `[class~="name"]`, `[class="… name …"]` or a
 * substring match (`[class^=]`, `[class$=]`, `[class*=]`, `[class|=]`) that a known class satisfies;
 * universal `*` rules cannot be resolved statically.
 * Loaded through parser.mjs, which re-exports everything here.
 */
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { CONTROL_EL, CONTROL_ROLE, CONTROL_WORD, root, selectImportPolicy } from './allowlists.mjs';
import { decodeCssEscapes, firstVar, splitTop } from './parser-values.mjs';
import { declarations, parseBlocks, stripComments } from './parser.mjs';

export function hasScopePseudo(selector) {
  if (!selector || !/scope/i.test(selector)) return false;
  let quote = '';
  let bracket = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      if (c === '\\' && selector[i + 1]) { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && selector[i + 1]) { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '[') { bracket++; continue; }
    if (c === ']' && bracket) { bracket--; continue; }
    if (bracket === 0 && c === ':' && selector[i - 1] !== ':' && /^:scope(?![-\w])/i.test(selector.slice(i))) {
      return true;
    }
  }
  return false;
}

function expandScopePseudo(selector, scopeRoot) {
  if (!scopeRoot || !hasScopePseudo(selector)) return selector;
  const rootParts = splitTop(scopeRoot, /,/);
  const replacement = rootParts.length > 1 ? `:is(${scopeRoot})` : scopeRoot;
  let out = '';
  let quote = '';
  let bracket = 0;
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      out += c;
      if (c === '\\' && selector[i + 1]) { out += selector[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && selector[i + 1]) { out += c + selector[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '[') { bracket++; out += c; continue; }
    if (c === ']' && bracket) { bracket--; out += c; continue; }
    if (bracket === 0 && c === ':' && selector[i - 1] !== ':' && /^:scope(?![-\w])/i.test(selector.slice(i))) {
      out += replacement;
      i += ':scope'.length - 1;
      continue;
    }
    out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function expandAmpersand(selector, parentSelector) {
  if (!parentSelector || !selector.includes('&')) return selector;
  const parentParts = splitTop(parentSelector, /,/);
  const replacement = parentParts.length > 1 ? `:is(${parentSelector})` : parentSelector;
  let out = '';
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      out += c;
      if (c === '\\' && selector[i + 1]) { out += selector[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && selector[i + 1]) { out += c + selector[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '&') { out += replacement; continue; }
    out += c;
  }
  return out.replace(/\s+/g, ' ').trim();
}

export function combineNestedSelector(selector, parentSelector, scopeRoot = '') {
  if (!parentSelector && !scopeRoot) return selector;
  const parentParts = parentSelector ? splitTop(parentSelector, /,/) : [];
  const replacement = parentParts.length > 1 ? `:is(${parentSelector})` : parentSelector;
  return splitTop(selector, /,/).map(branch => {
    let out = branch;
    let replaced = false;
    if (parentSelector && out.includes('&')) {
      out = expandAmpersand(out, parentSelector);
      replaced = true;
    }
    if (scopeRoot && hasScopePseudo(out)) {
      out = expandScopePseudo(out, scopeRoot);
      replaced = true;
    }
    if (!replaced && parentSelector) {
      out = `${replacement} ${out}`;
    }
    return out.replace(/\s+/g, ' ').trim();
  }).join(', ');
}

function subjectHasSameElement(subject, hasScope) {
  if (!subject || hasPseudoElement(subject)) return false;
  const { base, groups } = extractCompoundParts(subject);
  if (base.includes('&')) return true;
  if (hasScope && hasScopePseudo(base)) return true;
  return groups.some(group => splitTop(group, /,/).some(part => {
    const innerSubject = parseSelectorChain(part).compounds.at(-1) || '';
    return subjectHasSameElement(innerSubject, hasScope);
  }));
}

export function isSameElementScopeRoot(rawRoot) {
  if (!rawRoot || !rawRoot.includes('&')) return false;
  return splitTop(rawRoot, /,/).some(branch => {
    if (!branch.includes('&')) return false;
    const subject = parseSelectorChain(branch).compounds.at(-1) || '';
    return subjectHasSameElement(subject, false);
  });
}

export function isSameElementNest(block) {
  if (!block || !block.selector || block.selector.startsWith('@')) return false;
  const hasAmp = Boolean(block.parent) && block.selector.includes('&');
  const hasScope = Boolean(block.scopeRoot) && hasScopePseudo(block.selector);
  if (!hasAmp && !hasScope) return false;
  return splitTop(block.selector, /,/).some(branch => {
    const branchHasAmp = hasAmp && branch.includes('&');
    const branchHasScope = hasScope && hasScopePseudo(branch);
    if (!branchHasAmp && !branchHasScope) return false;
    const subject = parseSelectorChain(branch).compounds.at(-1) || '';
    return subjectHasSameElement(subject, branchHasScope);
  });
}

export function decodeAtRule(selector) {
  if (!selector || !selector.startsWith('@') || !selector.includes('\\')) return selector;
  return selector.replace(/^@((?:\\[0-9a-fA-F]{1,6}(?:\r\n|[ \t\r\n\f])?|\\[^\r\n\f]|[^\s({])+)/, (_m, kw) => `@${decodeCssEscapes(kw)}`);
}

/** Decode identifier escapes without promoting escaped selector punctuation to syntax. */
export function decodeSelectorEscapes(selector) {
  if (!selector || !selector.includes('\\')) return selector;
  let out = '';
  let quote = '';
  for (let i = 0; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < selector.length) { out += selector[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '\\' && i + 1 < selector.length) {
      const rest = selector.slice(i);
      const hex = /^\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?/.exec(rest);
      let decoded = '';
      let len = 0;
      if (hex) {
        const code = parseInt(hex[1], 16);
        decoded = (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) ? '\uFFFD' : String.fromCodePoint(code);
        len = hex[0].length;
      } else if (!/[\r\n\f]/.test(selector[i + 1])) {
        decoded = selector[i + 1];
        len = 2;
      } else {
        out += c;
        continue;
      }
      if (/^[a-zA-Z0-9_-]$/.test(decoded) || decoded.codePointAt(0) > 0x7f) {
        out += decoded;
      } else {
        out += `\\${decoded}`;
      }
      i += len - 1;
      continue;
    }
    out += c;
  }
  return out;
}

/** Return the last semicolon-separated prelude segment outside quotes and parentheses. */
export function selectorOf(prelude) {
  let cur = '';
  let paren = 0;
  let quote = '';
  const parts = [];
  for (let i = 0; i < prelude.length; i++) {
    const c = prelude[i];
    if (quote) {
      cur += c;
      if (c === '\\') { if (prelude[i + 1]) cur += prelude[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    if (paren === 0 && c === ';') { parts.push(cur); cur = ''; continue; }
    cur += c;
  }
  parts.push(cur);
  return parts[parts.length - 1].replace(/\s+/g, ' ').trim();
}

/** Split a selector branch into compounds and top-level combinators. */
export function parseSelectorChain(branch) {
  const compounds = [];
  const combinators = [];
  let cur = '';
  let paren = 0;
  let bracket = 0;
  let quote = '';
  let pendingSpace = false;
  const trimmed = branch.trim();
  for (let i = 0; i < trimmed.length; i++) {
    const c = trimmed[i];
    if (quote) {
      cur += c;
      if (c === '\\' && trimmed[i + 1]) { cur += trimmed[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && trimmed[i + 1]) {
      if (paren === 0 && bracket === 0 && pendingSpace) {
        compounds.push(cur.trim());
        combinators.push(' ');
        cur = '';
        pendingSpace = false;
      }
      cur += c + trimmed[++i];
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') { paren++; cur += c; continue; }
    if (c === ')' && paren) { paren--; cur += c; continue; }
    if (c === '[') { bracket++; cur += c; continue; }
    if (c === ']' && bracket) { bracket--; cur += c; continue; }
    if (paren === 0 && bracket === 0) {
      if (c === '>' || c === '+' || c === '~') {
        if (cur.trim()) compounds.push(cur.trim());
        cur = '';
        pendingSpace = false;
        if (compounds.length > combinators.length) combinators.push(c);
        continue;
      }
      if (/\s/.test(c)) {
        if (cur.trim()) pendingSpace = true;
        continue;
      }
      if (pendingSpace) {
        compounds.push(cur.trim());
        combinators.push(' ');
        cur = '';
        pendingSpace = false;
      }
    }
    cur += c;
  }
  if (cur.trim()) compounds.push(cur.trim());
  return { compounds, combinators };
}

/** Separate a compound base from :is/:where groups, omitting other functional pseudo arguments. */
export function extractCompoundParts(compound) {
  let base = '';
  const groups = [];
  let bracket = 0;
  let quote = '';
  for (let i = 0; i < compound.length; i++) {
    const c = compound[i];
    if (quote) {
      base += c;
      if (c === '\\' && compound[i + 1]) { base += compound[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && compound[i + 1]) { base += c + compound[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; base += c; continue; }
    if (c === '[') { bracket++; base += c; continue; }
    if (c === ']' && bracket) { bracket--; base += c; continue; }
    if (bracket === 0 && c === ':') {
      const match = /^(:{1,2})([-\w]+)\(/.exec(compound.slice(i));
      if (match) {
        const isSingle = match[1] === ':';
        const pseudo = match[2].toLowerCase();
        let k = i + match[0].length;
        let depth = 1;
        let inner = '';
        let q = '';
        for (; k < compound.length; k++) {
          const ch = compound[k];
          if (q) {
            inner += ch;
            if (ch === '\\' && compound[k + 1]) { inner += compound[++k]; continue; }
            if (ch === q) q = '';
            continue;
          }
          if (ch === '\\' && compound[k + 1]) { inner += ch + compound[++k]; continue; }
          if (ch === '"' || ch === "'") { q = ch; inner += ch; continue; }
          if (ch === '(') depth++;
          else if (ch === ')') { depth--; if (depth === 0) break; }
          inner += ch;
        }
        if (isSingle && (pseudo === 'is' || pseudo === 'where')) groups.push(inner);
        i = k;
        continue;
      }
    }
    base += c;
  }
  return { base, groups };
}

/** Match a compound base or a :is/:where group whose every branch subject matches. */
export function compoundMatches(compound, testBase) {
  const { base, groups } = extractCompoundParts(compound);
  if (testBase(base)) return true;
  return groups.some(group => {
    const branches = splitTop(group, /,/);
    return branches.length > 0 && branches.every(branch => {
      const { compounds } = parseSelectorChain(branch);
      const subject = compounds.at(-1) || '';
      return Boolean(subject) && compoundMatches(subject, testBase);
    });
  });
}

/** Require every selector branch subject to match the supplied base predicate. */
export function selectorSubjectMatches(selector, testBase) {
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const { compounds } = parseSelectorChain(part);
    const subject = compounds.at(-1) || '';
    return Boolean(subject) && compoundMatches(subject, testBase);
  });
}

/** Find a matching compound with a descendant or child combinator in a selector chain. */
export function hasAncestorMatching(chain, testBase) {
  const { compounds, combinators } = chain;
  for (let i = 0; i < compounds.length - 1; i++) {
    if (combinators[i] !== ' ' && combinators[i] !== '>') continue;
    if (compoundMatches(compounds[i], testBase)) return true;
  }
  return false;
}

/** Detect pseudo-elements while ignoring attribute strings and escaped colons. */
export function hasPseudoElement(compound) {
  if (!compound) return false;
  const withoutAttrs = compound.replace(/\[(?:\\.|"(?:\\.|[^"])*"|'(?:\\.|[^'])*'|[^\]])*\]/g, '');
  return /(?<!\\)::|(?<!\\):(?:before|after|first-line|first-letter)(?![-\w])/i.test(withoutAttrs);
}

/** Require each selector branch to be one root/html compound without a pseudo-element. */
export function rootSelector(selector) {
  const parts = splitTop(selector, /,/);
  return parts.length > 0 && parts.every(part => {
    const { compounds } = parseSelectorChain(part);
    if (compounds.length !== 1) return false;
    if (hasPseudoElement(compounds[0])) return false;
    const { base } = extractCompoundParts(compounds[0]);
    return /^(?::root|html)(?![-\w\\])/i.test(base);
  });
}

function isControlBase(base) {
  if (!base) return false;
  if (CONTROL_EL.test(base) || CONTROL_ROLE.test(base)) return true;
  return CONTROL_WORD.test(base.replace(/\[[^\]]*\]/g, ''));
}

/** Require each selector subject to name a recognized control element, role or control word. */
export function isControlSelector(selector) {
  return selectorSubjectMatches(selector, isControlBase);
}

/** Recognize the medium token, subheading weight token or numeric medium weight. */
export function isMediumWeight(value) {
  const name = firstVar(value);
  return name === '--weight-medium' || name === '--type-subheading-weight' || /^500$/.test((value || '').trim());
}

function isMonoBase(base) {
  if (!base) return false;
  if (/^(?:code|pre|kbd|samp|tt)(?![-\w\\])/i.test(base)) return true;
  const nonTag = base.replace(/\[[^\]]*\]/g, '').replace(/^(?:\\.|[a-zA-Z0-9_-])+/, '');
  return /(?:^|[^a-z0-9\\])(?:code|kbd|samp|monos?)(?![a-z0-9\\])/i.test(nonTag);
}

/** Recognize mono size/family tokens, a monospace family or a monospace selector subject. */
export function monoContext(selector, size, family) {
  if (firstVar(size) === '--mono-size' || firstVar(family) === '--mono' || /\bmonospace\b/.test(family || '')) return true;
  return selectorSubjectMatches(selector, isMonoBase);
}

const literalClasses = text => text.split(/\s+/).filter(name => /^-?[_a-zA-Z][-\w]*$/.test(name));

/**
 * Collect every class src/**\/*.{ts,html} places on a <select>: `<select class="...">` in
 * markup or templates, `node('select', '...')`, `h('select', { class/className: '...' })`,
 * and `.className =` / `.classList.add(...)` on a variable created by
 * `createElement('select')` or `node('select')`. Template interpolations are skipped.
 */
export function collectSelectClasses(sources) {
  const found = new Set();
  const add = text => { for (const name of literalClasses(text.replace(/\$\{[^}]*\}/g, ' '))) found.add(name); };
  for (const source of sources) {
    for (const tag of source.matchAll(/<select\b((?:"[^"]*"|'[^']*'|\$\{[^}]*\}|[^>])*)>/gi)) {
      const attr = /\bclass\s*=\s*(?:"([^"]*)"|'([^']*)')/i.exec(tag[1]);
      if (attr) add(attr[1] ?? attr[2]);
    }
    for (const call of source.matchAll(/\bnode\(\s*['"`]select['"`]\s*,\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)) add(call[1] ?? call[2] ?? call[3]);
    for (const call of source.matchAll(/\bh\(\s*['"`]select['"`]\s*,\s*\{[^}]*?\b(?:class|className)\s*:\s*(?:'([^']*)'|"([^"]*)"|`([^`]*)`)/g)) add(call[1] ?? call[2] ?? call[3]);
    for (const made of source.matchAll(/\b([A-Za-z_$][\w$]*)\s*=\s*(?:[\w$.]+\.)?(?:createElement|node)\(\s*['"`]select['"`]\s*\)/g)) {
      const name = made[1].replace(/\$/g, '\\$');
      for (const set of source.matchAll(new RegExp(`\\b${name}\\.className\\s*=\\s*(?:'([^']*)'|"([^"]*)"|\`([^\`]*)\`)`, 'g'))) add(set[1] ?? set[2] ?? set[3]);
      for (const list of source.matchAll(new RegExp(`\\b${name}\\.classList\\.add\\(([^)]*)\\)`, 'g'))) {
        for (const arg of list[1].matchAll(/'([^']*)'|"([^"]*)"/g)) add(arg[1] ?? arg[2]);
      }
    }
  }
  return found;
}

let selectClassCache = null;
/** Classes that src/ puts on <select> elements, scanned once per run. */
export function selectClasses() {
  if (selectClassCache) return selectClassCache;
  const sources = [];
  const walk = dir => {
    for (const entry of readdirSync(join(root, dir), { withFileTypes: true })) {
      const path = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(path);
      else if (/\.(?:ts|html)$/.test(entry.name)) sources.push(readFileSync(join(root, path), 'utf8'));
    }
  };
  walk('src');
  for (const name of readdirSync(root)) if (name.endsWith('.html')) sources.push(readFileSync(join(root, name), 'utf8'));
  return (selectClassCache = collectSelectClasses(sources));
}

/**
 * Class names a `[class~=v]` or `[class=v]` attribute selector names (unquoted, single- or
 * double-quoted, optional `i`/`s` flag); `[class="a b"]` names each space-separated token.
 * Substring operators name every known class that would satisfy them on its own: `^=` a class
 * starting with v, `$=` ending with v, `*=` containing v, `|=` equal to v or starting `v-`
 * (non-empty v only). With the `i` flag a known select class matches case-insensitively.
 */
const SUBSTRING = {
  '^=': (cls, v) => cls.startsWith(v),
  '$=': (cls, v) => cls.endsWith(v),
  '*=': (cls, v) => cls.includes(v),
  '|=': (cls, v) => cls === v || cls.startsWith(`${v}-`),
};
const CLASS_ATTR = /^class\s*([~^$*|]?=)\s*(?:"((?:\\.|[^"\\])*)"|'((?:\\.|[^'\\])*)'|([^\s"'\]]+))\s*([is])?$/i;
export function classAttrNames(inner, classes) {
  const match = CLASS_ATTR.exec(inner.trim());
  if (!match) return [];
  const value = match[2] ?? match[3] ?? match[4] ?? '';
  const fold = match[5]?.toLowerCase() === 'i' ? text => text.toLowerCase() : text => text;
  const substring = SUBSTRING[match[1]];
  if (substring) return value ? [...classes].filter(name => substring(fold(name), fold(value))) : [];
  // `~=` matches one whitespace-free token; a value with whitespace (or empty) never matches.
  const tokens = match[1] === '~=' ? (/^\S+$/.test(value) ? [value] : []) : value.split(/\s+/).filter(Boolean);
  if (match[5]?.toLowerCase() !== 'i') return tokens.filter(token => classes.has(token));
  const known = [...classes];
  return tokens.flatMap(token => known.filter(name => name.toLowerCase() === token.toLowerCase()));
}

// A tiny possibility evaluator for a select subject: unknown classes/pseudos may
// match or not, while select types, :is/:where/:not and size/multiple are concrete.
// A class that src/ places on a <select> (`.name`, `[class~=name]`, `[class="… name"]`, `[class*=nam]`) counts as naming one (outside :not()); other
// class-only selectors, universal `*` rules and :has() are not inferred.
function selectCompound(compound, state, classes = selectClasses()) {
  const both = new Set([false, true]);
  const combine = (a, b, op) => new Set([...a].flatMap(x => [...b].map(y => op(x, y))));
  let possible = new Set([true]);
  let mentions = false;
  let typed = false;
  const add = values => { possible = combine(possible, values, (a, b) => a && b); };
  const balanced = (start, open, close) => {
    let depth = 1, quote = '', end = start + 1;
    for (; end < compound.length; end++) {
      const c = compound[end];
      if (c === '\\') { end++; continue; }
      if (quote) { if (c === quote) quote = ''; continue; }
      if (c === '"' || c === "'") { quote = c; continue; }
      if (c === open) depth++;
      if (c === close) { depth--; if (depth === 0) break; }
    }
    return { inner: compound.slice(start + 1, end), end };
  };
  for (let i = 0; i < compound.length;) {
    const c = compound[i];
    if (c === '[') {
      const { inner, end } = balanced(i, '[', ']');
      const attr = /^(multiple|size)(?:\s*=\s*["']?([^"'\s]+)["']?)?$/i.exec(inner.trim());
      if (classAttrNames(inner, classes).length) mentions = true;
      if (!attr) add(both);
      else if (attr[1].toLowerCase() === 'multiple') add(new Set([state.multiple]));
      else if (attr[2] == null) add(new Set([state.size !== null]));
      else if (state.size === '*') add(attr[2] === '1' ? new Set([false]) : both);
      else add(new Set([state.size === attr[2]]));
      i = end + 1;
    } else if (c === ':') {
      if (compound[i + 1] === ':') return { possible: new Set([false]), mentions, typed };
      const name = /^:([-\w]+)/.exec(compound.slice(i));
      if (!name) { i++; continue; }
      i += name[0].length;
      if (compound[i] === '(') {
        const { inner, end } = balanced(i, '(', ')');
        if (/^(?:is|where|not)$/i.test(name[1])) {
          let choices = new Set([false]);
          for (const branch of splitTop(inner, /,/)) {
            const { compounds } = parseSelectorChain(branch);
            const result = selectCompound(compounds.at(-1) || '', state, classes);
            mentions ||= result.mentions && (name[1].toLowerCase() !== 'not' || result.typed);
            typed ||= result.typed;
            // An ancestor or sibling compound may or may not match, so a complex branch is never certain.
            const possible = compounds.length > 1 && result.possible.has(true) ? both : result.possible;
            choices = combine(choices, possible, (a, b) => a || b);
          }
          add(name[1].toLowerCase() === 'not' ? new Set([...choices].map(x => !x)) : choices);
        } else add(both);
        i = end + 1;
      } else add(both);
    } else if (c === '.' || c === '#') {
      const name = /^(?:\\.|[-\w])+/.exec(compound.slice(i + 1));
      if (c === '.' && name && classes.has(name[0])) mentions = true;
      i += 1 + (name?.[0].length || 0);
      add(both);
    } else if (c === '\\') {
      i += 2;
      add(both);
    } else {
      const name = /^[-\w]+/.exec(compound.slice(i));
      if (name) {
        const isSelect = name[0].toLowerCase() === 'select';
        mentions ||= isSelect;
        typed ||= isSelect;
        add(new Set([isSelect]));
        i += name[0].length;
      } else i++;
    }
  }
  return { possible, mentions, typed };
}

/** Detect explicit select subjects (including logical pseudo groups) and possible single-line matches. */
export function selectSelectorKinds(selector) {
  const decoded = decodeSelectorEscapes(selector);
  const classes = selectClasses();
  const named = [...decoded.matchAll(/\.([-\w]+)/g)].some(match => classes.has(match[1]))
    || [...decoded.matchAll(/\[([^\]]*)\]/g)].some(match => classAttrNames(match[1], classes).length);
  if (!/select/i.test(decoded) && !named) return { any: false, single: false };
  let any = false, single = false;
  for (const branch of splitTop(decoded, /,/)) {
    const subject = parseSelectorChain(branch).compounds.at(-1) || '';
    for (const state of [{ multiple: false, size: null }, { multiple: false, size: '1' }, { multiple: false, size: '*' }, { multiple: true, size: null }]) {
      const match = selectCompound(subject, state, classes);
      if (match.mentions && match.possible.has(true)) {
        any = true;
        if (!state.multiple && (state.size === null || state.size === '1')) single = true;
      }
    }
  }
  return { any, single };
}

const SELECT_PROPS = /^(?:all|background|background-image|background-origin|background-clip|background-attachment|background-blend-mode|(?:-webkit-)?mask(?:-image)?|background-position(?:-[xy])?|background-repeat|background-size|-webkit-appearance|-moz-appearance|appearance|padding(?:-[\w-]+)?)$/;
/** Sheets that own a shared select definition (and its :dir(rtl) chevron position companion). */
const SELECT_OWNERS = new Set(['src/design-system.css', 'src/generative-ui.css', 'src/overlay.css']);

/** Properties that hide, blend or detach the chevron image: no select rule, the shared one included, sets them. */
const CHEVRON_VISIBILITY = new Set(['background-attachment', 'background-blend-mode', 'mask', 'mask-image', '-webkit-mask', '-webkit-mask-image']);

const SHARED_SELECT = 'select:where(:not([multiple]):not([size]),:not([multiple])[size="1"])';

/** The one shared single-line select rule per owner sheet (the launcher styles its sole picker directly). */
function sharedSelectRule(file, selector) {
  const flat = selector.replace(/\s+/g, '');
  return SELECT_OWNERS.has(file) && (flat === SHARED_SELECT || (file === 'src/overlay.css' && flat === '.launcher-projectselect'));
}

function nativeSelectFallback(file, selector, list, context) {
  const nativeSelector = file === 'src/overlay.css' ? '.launcher-project select' : SHARED_SELECT;
  const nativeValues = new Map(list.map(decl => [decl.property, decl.value]));
  return SELECT_OWNERS.has(file) && selector.replace(/\s+/g, '') === nativeSelector.replace(/\s+/g, '')
    && context?.selector?.replace(/\s+/g, '').toLowerCase() === '@media(forced-colors:active)'
    && !context.parentBlock
    && nativeValues.get('appearance') === 'auto' && nativeValues.get('-webkit-appearance') === 'menulist'
    && nativeValues.get('background-image') === 'none';
}

/**
 * Enforce shared select fill/image/position/repeat/appearance ownership and
 * single-line logical padding in nonexempt windows.
 */
export function selectRuleProblems(file, selector, list, context = null) {
  if (!list.some(({ property, value }) => SELECT_PROPS.test(property) || (property.startsWith('--') && /url\(/i.test(value)))) return [];
  const kinds = selectSelectorKinds(selector);
  const exempt = selectImportPolicy().exemptFiles.has(file);
  if (!kinds.any || (!SELECT_OWNERS.has(file) && exempt)) return [];
  const hits = [];
  const owner = SELECT_OWNERS.has(file);
  const native = nativeSelectFallback(file, selector, list, context);
  const rtl = /:dir\(\s*rtl\s*\)/i.test(selector);
  for (const { property, value } of list) {
    const flat = value.replace(/\s+/g, ' ').trim().toLowerCase();
    // Standalone launcher fill/padding policy stays exempt, but its shared arrow is guarded.
    if (exempt && !['all', 'appearance', '-webkit-appearance', '-moz-appearance', 'background-image'].includes(property) && !CHEVRON_VISIBILITY.has(property)) continue;
    if (native && ['appearance', '-webkit-appearance', 'background-image', 'padding-inline-end'].includes(property)) continue;
    // all:unset (or any all:<keyword>) resets appearance, the chevron image and padding, not just the font weight.
    if (property === 'all') hits.push(`select all:${flat} strips the shared appearance, chevron and padding; reset only the properties you need`);
    if (property === 'background') hits.push('select fill uses background-color, never the background shorthand');
    if (/^background-position(?:-[xy])?$/.test(property) && !(owner && property === 'background-position' && flat === (rtl ? 'left 11px center' : 'right 11px center'))) {
      hits.push('select chevron position belongs to the shared select rule (right 11px center, left 11px center under :dir(rtl))');
    }
    if (property === 'background-repeat' && !(owner && flat === 'no-repeat')) hits.push('select chevron repeat belongs to the shared select rule');
    if (property === 'background-size') hits.push('select chevron size belongs to the shared select rule');
    if (property === 'background-origin' || property === 'background-clip') hits.push('select chevron box belongs to the shared select rule; background-origin and background-clip shift or clip the chevron');
    if (CHEVRON_VISIBILITY.has(property)) hits.push(`select ${property}: select chevron visibility belongs to the shared select rule`);
    if ((property === 'appearance' || property === '-webkit-appearance') && flat !== 'none') hits.push(`select ${property} must stay none so the shared chevron draws`);
    // Only the shared rule may clear appearance: a component appearance:none outranks the
    // @media(forced-colors:active) native fallback and erases the dropdown arrow there.
    else if ((property === 'appearance' || property === '-webkit-appearance') && !sharedSelectRule(file, selector)) hits.push(`select ${property}:none belongs only to the shared select rule; a component copy outranks the forced-colors native arrow`);
    // The shared rule owns appearance; a Gecko-only override forks the chevron per engine.
    if (property === '-moz-appearance') hits.push('select -moz-appearance is not part of the shared select rule; appearance and -webkit-appearance own the native arrow');
    if ((property === 'background-image' && value.replace(/\s+/g, '') !== 'var(--select-chevron)') || (property.startsWith('--') && /url\(/i.test(value))) hits.push('select chevron must read var(--select-chevron), with its image defined only in src/tokens.css');
    if (kinds.single && /^(?:padding|padding-inline|padding-(?:top|bottom|left|right))$/.test(property)) hits.push('select padding uses padding-block and padding-inline-start; leave the base inline-end room intact');
    if (kinds.single && property === 'padding-inline-end' && !/^(?:\d+(?:\.\d+)?|\.\d+)px$/.test(value)) hits.push('select padding-inline-end must reserve at least the base 30px');
    else if (kinds.single && property === 'padding-inline-end' && parseFloat(value) < 30) hits.push('select padding-inline-end must reserve at least the base 30px');
  }
  return hits.map(hit => `${file}: ${selector}: ${hit}`);
}

/** Require the complete shared single-line select rule, unconditional at top level, in each select-capable base/shadow sheet. */
export function sharedSelectRuleProblems(css) {
  const rules = parseBlocks(stripComments(css)).filter(block => block.selector.replace(/\s+/g, '') === SHARED_SELECT
    && !nativeSelectFallback('src/generative-ui.css', block.selector, declarations(block.body), block.parentBlock));
  if (rules.length !== 1) return ['shared select rule must occur exactly once'];
  if (rules[0].parentBlock) return ['shared select rule must be a top-level rule, not nested in an at-rule or another rule'];
  const actual = new Map(declarations(rules[0].body).map(({ property, value }) => [property, value]));
  return [
    ['appearance', 'none'], ['-webkit-appearance', 'none'],
    ['background-image', 'var(--select-chevron)'], ['background-repeat', 'no-repeat'],
    ['background-position', 'right 11px center'], ['padding-inline-end', '30px'],
  ].filter(([property, value]) => actual.get(property) !== value).map(([property, value]) => `shared select rule needs ${property}:${value}`);
}

/** Lock the one chevron property to one light and one dark SVG definition in tokens.css. */
export function sharedSelectImageProblems(css) {
  const definitions = [];
  for (const block of parseBlocks(stripComments(css))) {
    for (const decl of declarations(block.body)) {
      if (decl.property === '--select-chevron') definitions.push({ selector: block.selector.replace(/\s+/g, ''), value: decl.value });
    }
  }
  const hits = [];
  for (const selector of [':root', 'html[data-theme="dark"]']) {
    const rows = definitions.filter(item => item.selector === selector);
    if (rows.length !== 1 || !/^url\("data:image\/svg\+xml,[^"]+"\)$/.test(rows[0]?.value || '')) hits.push('--select-chevron needs exactly one SVG image on ' + selector);
  }
  if (definitions.length !== 2) hits.push('--select-chevron must only have its light and dark definitions');
  return hits;
}
