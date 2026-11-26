/**
 * CSS structural reader and type/radius policy checks; this is a static guard,
 * not a full CSS parser or cascade engine. It reads declarations and balanced
 * blocks, nested selectors with &, and @scope roots/:scope, preserving enough
 * parent/order information to pair declarations on the same element. It walks
 * @media/@container/@supports/@starting-style/@layer/@scope grouping blocks,
 * checks @property initial values, and rejects @font-face. Other at-rule
 * declarations do not participate in ordinary role pairing.
 *
 * Comments are stripped outside quoted strings; CSS hex/simple escapes are
 * decoded without turning escaped selector punctuation into structure. Quotes
 * and parenthesized values protect delimiters in declaration/value splitting.
 * :is/:where groups and selector combinators are inspected for subject/ancestor
 * roles; :not/:has arguments do not establish those type roles. Select author
 * checks separately evaluate :is/:where/:not against possible size/multiple states,
 * requiring an explicit select type on the subject (not arbitrary class names). Dynamic script holes
 * use __TS_EXPR__ and cannot silently stand for a declaration/property name.
 *
 * Invariants: canonical ownership, token-family/fallback validity, exact listed
 * exceptions, circular logical corners, one-value border-radius shorthands,
 * scale/role clip radii, matching type roles, no synthetic caps or CSS-wide
 * font/all resets, and shared select chevron ownership. Scans append definitions and usage markers supplied by the caller;
 * pairing.mjs handles effective type combinations and docs.mjs locks definitions.
 *
 * Module map: this file reads blocks and declarations, owns token state and runs
 * checkRule/scanCss; parser-select.mjs holds selector grammar (nesting, @scope,
 * chains, compounds) and the shared <select> policy; parser-values.mjs holds value
 * grammar (var(), splitting, font shorthand) and per-value problems. Import from
 * this module: it re-exports both, and the submodules expect it to load first.
 */
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import {
  root, PHYSICAL_RADIUS, RADIUS, CHECKED, ALLOW_NONE, NAME_HINT, DEPRECATED, ROW_LEADING, LITERALS, aliasNames,
  REDEFINES, ALIAS_VALUES, STYLE_EXEMPT,
} from './allowlists.mjs';
import { checkPair, stateOverrideProblems } from './pairing.mjs';
import {
  combineNestedSelector, decodeAtRule, decodeSelectorEscapes, expandAmpersand, hasScopePseudo, isSameElementNest,
  isSameElementScopeRoot, selectRuleProblems, selectorOf,
} from './parser-select.mjs';
import {
  capsVariantProblems, clipPathProblems, cssWideResetProblems, customLiteral, decodeCssEscapes, decodeCssValue,
  eachVar, familyProblems, fontParts, fontSizeProblems, letterProblems, lineHeightProblems, matchCustom,
  noteRowLeading, radiusProblems, radiusRoleProblems, soleVar, stretchProblems, take, varProblems,
} from './parser-values.mjs';

export const tokensCss = readFileSync(join(root, 'src/tokens.css'), 'utf8');
export const designSystemCss = readFileSync(join(root, 'src/design-system.css'), 'utf8');
export const tokenSource = definedNames(tokensCss);
const designSystemSource = definedNames(designSystemCss);
export const designSystemLocked = new Set([...designSystemSource].filter(name => ROW_LEADING.test(name)));
export const canonical = new Set(tokenSource);
for (const name of designSystemLocked) canonical.add(name);

/** Return the owning sheet for a canonical token, or an empty string. */
export function tokenOwner(name) {
  if (tokenSource.has(name)) return 'src/tokens.css';
  if (designSystemLocked.has(name)) return 'src/design-system.css';
  return '';
}

/** Collect files with the requested suffixes recursively, honoring an optional skip predicate. */
export function walk(dir, ext, out = [], skip = null) {
  const matches = Array.isArray(ext)
    ? name => ext.some(suffix => name.endsWith(suffix))
    : name => name.endsWith(ext);
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (skip && skip(path, name)) continue;
    if (statSync(path).isDirectory()) walk(path, ext, out, skip);
    else if (matches(name)) out.push(path);
  }
  return out;
}

/** Remove CSS block comments outside strings while preserving quoted/escaped content. */
export function stripComments(css) {
  let out = '';
  let quote = '';
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      out += c;
      if (c === '\\' && i + 1 < css.length) { out += css[++i]; continue; }
      if (c === quote || c === '\n' || c === '\r' || c === '\f') quote = '';
      continue;
    }
    if (c === '\\' && i + 1 < css.length) { out += c + css[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; out += c; continue; }
    if (c === '/' && css[i + 1] === '*') {
      i += 2;
      while (i < css.length && !(css[i] === '*' && css[i + 1] === '/')) i++;
      if (i < css.length) i++;
      continue;
    }
    out += c;
  }
  return out;
}

/** Collect custom-property declaration names from all parsed blocks. */
export function definedNames(css) {
  const names = new Set();
  for (const block of parseBlocks(stripComments(css))) {
    for (const decl of declarations(block.body)) if (decl.property.startsWith('--')) names.add(decl.property);
  }
  return names;
}

/** Read balanced blocks with nesting, scope, parent, child and source-order metadata. */
export function parseBlocks(css) {
  const blocks = [];
  const stack = [];
  let i = 0;
  let preludeStart = 0;
  let paren = 0;
  let quote = '';
  let order = 0;
  while (i < css.length) {
    const c = css[i];
    if (quote) {
      if (c === '\\') { i += 2; continue; }
      if (c === quote) quote = '';
      i++;
      continue;
    }
    if (c === '"' || c === "'") { quote = c; i++; continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    else if (paren === 0 && c === '{') {
      const prelude = css.slice(preludeStart, i).trim();
      const selector = decodeSelectorEscapes(decodeAtRule(selectorOf(prelude)));
      const enclosing = [...stack].reverse().find(item => item.effectiveSelector);
      const enclosingScope = [...stack].reverse().find(item => item.scopeBlock);
      const parent = enclosing?.effectiveSelector || '';
      const parentScopeRoot = enclosingScope?.scopeRoot || '';
      const parentScopeBlock = enclosingScope?.scopeBlock || null;
      let effectiveSelector = '';
      let scopeRoot = parentScopeRoot;
      let scopeBlock = parentScopeBlock;
      let sameElementScope = false;
      const parentBlock = stack[stack.length - 1]?.block || null;
      const block = {
        prelude, selector, parent, effectiveSelector: '', parentBlock,
        scopeRoot: parentScopeRoot, scopeBlock: parentScopeBlock, sameElementScope: false,
        children: [], order: order++, body: '',
      };
      if (/^@scope\b/i.test(selector)) {
        if (/^@scope\s*\(/i.test(selector)) {
          const rawRoot = scopeRootSelector(selector);
          effectiveSelector = (parent && rawRoot.includes('&')) ? expandAmpersand(rawRoot, parent) : rawRoot;
          sameElementScope = Boolean(parent) && isSameElementScopeRoot(rawRoot);
        } else {
          effectiveSelector = parent || ':scope';
          sameElementScope = Boolean(parent);
        }
        scopeRoot = effectiveSelector;
        scopeBlock = block;
      } else if (selector && !selector.startsWith('@')) {
        effectiveSelector = (parent || parentScopeRoot) ? combineNestedSelector(selector, parent, parentScopeRoot) : selector;
      }
      block.effectiveSelector = effectiveSelector;
      block.sameElementScope = sameElementScope;
      if (parentBlock) parentBlock.children.push(block);
      stack.push({ prelude, selector, parent, effectiveSelector, scopeRoot, scopeBlock, block, bodyStart: i + 1 });
      preludeStart = i + 1;
    } else if (paren === 0 && c === '}' && stack.length) {
      const top = stack.pop();
      top.block.body = css.slice(top.bodyStart, i);
      blocks.push(top.block);
      preludeStart = i + 1;
    }
    i++;
  }
  return blocks;
}

/** Keep direct declarations while removing nested block contents and their preludes. */
export function directBody(body) {
  let out = '';
  let seg = '';
  let depth = 0;
  let paren = 0;
  let quote = '';
  for (let i = 0; i < body.length; i++) {
    const c = body[i];
    if (quote) {
      if (depth === 0) seg += c;
      if (c === '\\') { if (depth === 0 && body[i + 1]) seg += body[i + 1]; i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; if (depth === 0) seg += c; continue; }
    if (c === '(') { paren++; if (depth === 0) seg += c; continue; }
    if (c === ')') { if (paren) paren--; if (depth === 0) seg += c; continue; }
    if (paren === 0 && c === '{') { if (depth === 0) seg = ''; depth++; continue; }
    if (paren === 0 && c === '}') { depth = Math.max(0, depth - 1); if (depth === 0) seg = ''; continue; }
    if (depth === 0) {
      if (paren === 0 && c === ';') { out += `${seg};`; seg = ''; }
      else seg += c;
    }
  }
  return out + seg;
}

function splitDeclaration(raw) {
  let paren = 0;
  let quote = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    if (quote) {
      if (c === '\\') { i++; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\') { i++; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    else if (paren === 0 && c === ':') return [raw.slice(0, i).trim(), raw.slice(i + 1).trim()];
  }
  return null;
}

/** Read direct declarations with decoded names/values, priority and dynamic-name flags. */
export function declarations(body) {
  const found = [];
  let cur = '';
  let paren = 0;
  let quote = '';
  const flush = () => {
    const raw = cur.trim();
    cur = '';
    const split = splitDeclaration(raw);
    if (!split) return;
    const [rawProp, rawVal] = split;
    if (!rawProp || !rawVal) return;
    const decodedVal = decodeCssValue(rawVal);
    const important = /\s*!\s*important\s*$/i.test(decodedVal);
    const value = decodedVal.replace(/\s*!\s*important\s*$/i, '').trim().replace(/\s+/g, ' ');
    if (rawProp.includes('__TS_EXPR__')) {
      if (/^-{0,2}(?:[-\w]|__TS_EXPR__)+$/.test(rawProp)) {
        found.push({ property: rawProp, rawProp, value, important, upper: false, dynamic: true });
      }
      return;
    }
    const written = decodeCssEscapes(rawProp);
    if (!/^-{0,2}[-\w]+$/.test(written)) return;
    const property = written.startsWith('--') ? written : written.toLowerCase();
    found.push({ property, value, important, upper: written !== property, dynamic: false });
  };
  const source = directBody(body);
  for (let i = 0; i < source.length; i++) {
    const c = source[i];
    if (quote) {
      cur += c;
      if (c === '\\') { if (source[i + 1]) cur += source[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    if (paren === 0 && c === ';') { flush(); continue; }
    cur += c;
  }
  flush();
  return found;
}

const NESTED_AT = /^@(?:media|container|supports|starting-style|layer|scope)\b/i;
const EMBEDDED_PROP = /(?:font-size-adjust|-webkit-text-size-adjust|font-variant(?:-[\w]+)?|font-feature-settings|font-size|font-weight|font-family|line-height|letter-spacing|(?:-webkit-)?border(?:-[\w]+)*-radius|(?:^|[\s;{])font|zoom|font-variation-settings|(?:-webkit-)?clip-path|text-transform)\s*:|(?:^|[\s;{])all\s*:\s*(?:initial|revert)/i;

function hasTrackedCustomDef(text) {
  for (const match of text.matchAll(/(--[\w-]+)\s*:/g)) {
    const name = match[1];
    if (tokenOwner(name) || NAME_HINT.test(name) || /^--(?:type|ds)-/.test(name)) return true;
  }
  return /@property\s+--[\w-]+/i.test(text);
}

/** Check declarations for ownership, allowed values and role pairing while recording definitions/usage. */
export function checkRule(file, selector, list, used, defs, aliasUsed, pairList = list, context = null, typographyDefs = defs) {
  const problems = [];
  // Inspect every declaration, including custom properties and otherwise untracked
  // values. Skip further checks for these invalid declarations to avoid duplicate
  // reports from the property-specific var()/clip-path checks below.
  const blocked = new Set();
  for (const decl of list) {
    const hits = radiusRoleProblems(file, selector, decl.property, decl.value);
    if (hits.length) blocked.add(decl);
    problems.push(...hits.map(hit => `${file}: ${selector}: ${hit}`));
  }
  const decodedSelector = selector.startsWith('@') ? decodeCssEscapes(selector) : selector;
  if (/^@font-face\b/i.test(decodedSelector)) {
    problems.push(`${file}: ${selector}: @font-face is not allowed; use var(--sans) or var(--mono)`);
    return problems;
  }
  if (/^@property\b/i.test(decodedSelector)) {
    const name = decodedSelector.replace(/^@property\s+/i, '').trim();
    const initial = list.find(decl => decl.property === 'initial-value');
    if (initial) problems.push(...radiusRoleProblems(file, selector, name, initial.value).map(hit => `${file}: ${selector}: ${hit}`));
    if (initial && name.startsWith('--')) {
      if (!defs.has(name)) defs.set(name, []);
      defs.get(name).push({ file, selector, value: initial.value });
    }
    const owner = tokenOwner(name);
    if (owner && file !== owner) {
      if (!take(REDEFINES, used, 'redef', item => item.file === file && item.name === name)) {
        problems.push(`${file}: ${selector}: redefines canonical token ${name}`);
      }
    }
    const listed = ALIAS_VALUES.get(name);
    if (listed) {
      if (listed.files && !listed.files.has(file)) {
        problems.push(`${file}: ${selector}: ${name} may only be defined in ${[...listed.files].join(', ')}`);
      }
      if (initial && !listed.values.has(initial.value.replace(/\s+/g, ''))) {
        problems.push(`${file}: ${selector}: ${name} initial-value is ${initial.value}, not a listed value`);
      }
    }
    if (file !== 'src/tokens.css' && !owner && NAME_HINT.test(name)) {
      if (initial && customLiteral(initial.value)) {
        if (!matchCustom(file, name, initial.value, used, true)) {
          problems.push(`${file}: ${selector}: @property ${name} initial-value ${initial.value}`);
        }
      } else if (!aliasNames.has(name) && !matchCustom(file, name, initial?.value || '', used, false)) {
        problems.push(`${file}: ${selector}: @property ${name} is not an approved custom property`);
      }
    }
    return problems;
  }
  for (const { property } of list) {
    if (ALLOW_NONE.has(property)) problems.push(`${file}: ${selector}: ${property} is not allowed; use the type scale and uppercase tracking rules`);
  }
  if (selector.startsWith('@') || !selector) return problems;
  for (const decl of list) {
    if (blocked.has(decl)) continue;
    const { property, rawProp, value, upper, dynamic } = decl;
    if (dynamic) {
      problems.push(`${file}: ${selector}: dynamic interpolated property ${rawProp}: ${value}`);
      continue;
    }
    if (upper) problems.push(`${file}: ${selector}: uppercase property ${property}`);
    if (property.startsWith('--')) {
      if (!defs.has(property)) defs.set(property, []);
      defs.get(property).push({ file, selector, value });
      const owner = tokenOwner(property);
      if (owner && file !== owner) {
        if (!take(REDEFINES, used, 'redef', item => item.file === file && item.name === property)) {
          problems.push(`${file}: ${selector}: redefines canonical token ${property}`);
        }
      }
      const listed = ALIAS_VALUES.get(property);
      if (listed) {
        if (listed.files && !listed.files.has(file)) problems.push(`${file}: ${selector}: ${property} may only be defined in ${[...listed.files].join(', ')}`);
        if (!listed.values.has(value.replace(/\s+/g, ''))) problems.push(`${file}: ${selector}: ${property} is ${value}, not a listed value`);
      }
      if (file !== 'src/tokens.css' && !owner && NAME_HINT.test(property)) {
        if (customLiteral(value)) {
          if (!matchCustom(file, property, value, used, true)) {
            problems.push(`${file}: ${selector}: custom property ${property}: ${value}`);
          }
        } else if (!aliasNames.has(property) && !matchCustom(file, property, value, used, false)) {
          problems.push(`${file}: ${selector}: unapproved custom property alias ${property}: ${value}`);
        }
      }
    }
    problems.push(...capsVariantProblems(property, value, pairList, typographyDefs, file).map(hit => `${file}: ${selector}: ${hit}`));
    problems.push(...cssWideResetProblems(property, value).map(hit => `${file}: ${selector}: ${hit}`));
    problems.push(...stretchProblems(property, value).map(hit => `${file}: ${selector}: ${hit}`));
    if (property === 'zoom') {
      const zoom = value.replace(/\s+/g, '');
      if (!/^(?:1|1\.0+|100%)$/.test(zoom)) problems.push(`${file}: ${selector}: zoom ${value}`);
    } else if (property === 'font-variation-settings' && /wght/i.test(value)) {
      problems.push(`${file}: ${selector}: font-variation-settings sets wght ${value}`);
    } else if (property === 'clip-path' || property === '-webkit-clip-path') {
      problems.push(...clipPathProblems(file, selector, value).map(hit => `${file}: ${selector}: ${hit}`));
    }
    if (CHECKED.has(property) || RADIUS.test(property)) {
      eachVar(value, name => { if (aliasNames.has(name)) aliasUsed.add(name); });
    }
    if (property === 'font-size') {
      problems.push(...fontSizeProblems(file, selector, value, used).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (property === 'font-weight') {
      if (/^(?:bold|bolder|lighter)$/.test(value)) problems.push(`${file}: ${selector}: font-weight keyword ${value}`);
      else if (!/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(value) && !soleVar(value)) {
        problems.push(`${file}: ${selector}: numeric font-weight ${value}`);
      }
      problems.push(...varProblems(file, selector, property, value).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (property === 'line-height') {
      noteRowLeading(value, used);
      problems.push(...lineHeightProblems(file, selector, value, used).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (property === 'letter-spacing') {
      problems.push(...letterProblems(value).map(hit => `${file}: ${selector}: ${hit}`));
      problems.push(...varProblems(file, selector, property, value).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (property === 'font-family') {
      if (take(LITERALS, used, 'literal', item => item.file === file && item.selector === selector && item.property === property && item.value === value)) continue;
      problems.push(...familyProblems(value).map(hit => `${file}: ${selector}: ${hit}`));
      problems.push(...varProblems(file, selector, property, value).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (property === 'font') {
      const parts = fontParts(value);
      problems.push(...familyProblems(parts.family).map(hit => `${file}: ${selector}: ${hit}`));
      if (parts.size) problems.push(...fontSizeProblems(file, selector, parts.size, used).map(hit => `${file}: ${selector}: ${hit}`));
      if (parts.weight) {
        if (/^(?:bold|bolder|lighter)$/.test(parts.weight)) {
          problems.push(`${file}: ${selector}: font shorthand weight keyword ${parts.weight}`);
        } else if (!/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(parts.weight) && !soleVar(parts.weight)) {
          problems.push(`${file}: ${selector}: font shorthand numeric weight ${value}`);
        }
      }
      if (parts.lineHeight) {
        noteRowLeading(parts.lineHeight, used);
        problems.push(...lineHeightProblems(file, selector, parts.lineHeight, used).map(hit => `${file}: ${selector}: ${hit}`));
      } else {
        problems.push(`${file}: ${selector}: font shorthand must include /line-height (omitting it resets line-height to normal)`);
      }
      problems.push(...varProblems(file, selector, property, value).map(hit => `${file}: ${selector}: ${hit}`));
    } else if (RADIUS.test(property)) {
      if (PHYSICAL_RADIUS.test(property)) {
        problems.push(`${file}: ${selector}: ${property}: use logical border-start-*/border-end-* radius longhand`);
      }
      if (take(LITERALS, used, 'literal', item => item.file === file && item.selector === selector && item.property === property && item.value === value)) continue;
      for (const hit of radiusProblems(value, property)) problems.push(`${file}: ${selector}: ${property}: ${hit}`);
      problems.push(...varProblems(file, selector, property, value).map(hit => `${file}: ${selector}: ${property}: ${hit}`));
    }
  }
  problems.push(...selectRuleProblems(file, selector, list, context));
  checkPair(selector, pairList, problems, file, file, used, typographyDefs);
  return problems;
}

function enclosingDecls(block) {
  const chain = [];
  let cur = block.parentBlock;
  while (cur) {
    chain.push(cur);
    if (/^@scope\s*\(/i.test(cur.selector || '') && !cur.sameElementScope) break;
    if (cur.selector && !cur.selector.startsWith('@') && !isSameElementNest(cur)) break;
    cur = cur.parentBlock;
  }
  chain.reverse();
  const chainSet = new Set(chain);
  const merged = [];
  const wantsScopeSiblings = Boolean(block.scopeRoot) && hasScopePseudo(block.selector);
  for (const item of chain) {
    merged.push(...declarations(item.body));
    if (Array.isArray(item.children)) {
      for (const child of item.children) {
        if (child === block || chainSet.has(child) || child.order >= block.order) continue;
        const childSel = (child.selector || '').trim();
        if (childSel === '&') {
          merged.push(...declarations(child.body));
        } else if (wantsScopeSiblings && /^@scope\b/i.test(item.selector || '') && /^:scope$/i.test(childSel)) {
          merged.push(...declarations(child.body));
        }
      }
    }
  }
  return merged;
}

function scopeRootSelector(selector) {
  const match = /^@scope\s*\(/i.exec(selector);
  if (!match) return ':scope';
  let depth = 1;
  let i = match[0].length;
  let quote = '';
  let inner = '';
  for (; i < selector.length; i++) {
    const c = selector[i];
    if (quote) {
      inner += c;
      if (c === '\\' && selector[i + 1]) { inner += selector[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '\\' && selector[i + 1]) { inner += c + selector[++i]; continue; }
    if (c === '"' || c === "'") { quote = c; inner += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) break;
    }
    inner += c;
  }
  return inner.trim() || ':scope';
}

/** Detect template holes that could replace a property name or whole declaration segment. */
export function hasDynamicDeclSegment(css) {
  if (!css || !css.includes('__TS_EXPR__')) return false;
  let cur = '';
  let paren = 0;
  let quote = '';
  const segments = [];
  for (let i = 0; i < css.length; i++) {
    const c = css[i];
    if (quote) {
      cur += c;
      if (c === '\\') { if (css[i + 1]) cur += css[++i]; continue; }
      if (c === quote) quote = '';
      continue;
    }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') paren++;
    else if (c === ')' && paren) paren--;
    if (paren === 0 && c === ';') { segments.push(cur); cur = ''; continue; }
    cur += c;
  }
  segments.push(cur);
  for (const seg of segments) {
    const trimmed = seg.trim();
    if (!trimmed || !trimmed.includes('__TS_EXPR__')) continue;
    const colon = trimmed.indexOf(':');
    if (colon < 0 || trimmed.slice(0, colon).includes('__TS_EXPR__')) return true;
  }
  return false;
}

/** Check direct declarations in inline CSS or parsed blocks for dynamic declaration holes. */
export function hasDynamicCssSegment(css) {
  if (!css || !css.includes('__TS_EXPR__')) return false;
  const clean = stripComments(css);
  const blocks = parseBlocks(clean);
  if (!blocks.length) return hasDynamicDeclSegment(clean);
  for (const block of blocks) {
    if (hasDynamicDeclSegment(directBody(block.body))) return true;
  }
  return hasDynamicDeclSegment(directBody(clean));
}

/** Scan CSS blocks or inline declarations, merging same-element nesting context for pairing. */
export function scanCss(file, css, used, defs, aliasUsed, opts = {}) {
  const { htmlStyle = false } = opts;
  const clean = stripComments(css);
  const problems = [];
  if (DEPRECATED.test(clean)) problems.push(`${file}: deprecated alias`);
  const blocks = parseBlocks(clean);
  const typographyDefs = new Map(defs);
  for (const block of blocks) for (const decl of declarations(block.body)) {
    if (!decl.property.startsWith('--')) continue;
    typographyDefs.set(decl.property, [...(typographyDefs.get(decl.property) || []), {file, selector: block.selector, value: decl.value}]);
  }
  if (!blocks.length) {
    const list = declarations(clean);
    const hasDynProp = list.some(decl => decl.dynamic);
    if (!hasDynProp && hasDynamicDeclSegment(clean)) {
      if (!take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'dynamic-html-style')) {
        problems.push(`${file}: (inline): dynamic CSS segment`);
      }
    }
    const decoded = clean.includes('\\') ? decodeCssEscapes(clean) : clean;
    if (hasDynProp || EMBEDDED_PROP.test(decoded) || NAME_HINT.test(decoded) || /--[\w-]+\s*:/.test(decoded) || /__TS_EXPR__[^;:]*:/.test(clean)) {
      problems.push(...checkRule(file, '(inline)', list, used, defs, aliasUsed));
    }
    return problems;
  }
  if (htmlStyle && hasDynamicDeclSegment(directBody(clean))) {
    if (!take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'dynamic-html-style')) {
      problems.push(`${file}: (inline): dynamic CSS segment`);
    }
  }
  for (const block of blocks) {
    const selector = block.selector || selectorOf(block.prelude);
    const list = declarations(block.body);
    const hasDynProp = list.some(decl => decl.dynamic);
    if (!hasDynProp && hasDynamicDeclSegment(directBody(block.body))) {
      if (!take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'dynamic-html-style')) {
        problems.push(`${file}: ${block.effectiveSelector || selector}: dynamic CSS segment`);
      }
    }
    if (NESTED_AT.test(selector)) {
      if (!list.length) continue;
      if (/^@scope\b/i.test(selector)) {
        const target = block.effectiveSelector || scopeRootSelector(selector);
        if (block.parent && (!/^@scope\s*\(/i.test(selector) || block.sameElementScope)) {
          const merged = [...enclosingDecls(block), ...list];
          problems.push(...checkRule(file, target, list, used, defs, aliasUsed, merged, block.parentBlock, typographyDefs));
        } else {
          problems.push(...checkRule(file, target, list, used, defs, aliasUsed, list, block.parentBlock, typographyDefs));
        }
      } else if (block.parent) {
        const merged = [...enclosingDecls(block), ...list];
        problems.push(...checkRule(file, block.parent, list, used, defs, aliasUsed, merged, block.parentBlock, typographyDefs));
      }
      continue;
    }
    if (isSameElementNest(block)) {
      const target = block.effectiveSelector || combineNestedSelector(selector, block.parent, block.scopeRoot);
      const hasTypo = list.some(decl => CHECKED.has(decl.property) || decl.property === 'text-transform' || decl.property === 'all');
      const pairList = hasTypo ? [...enclosingDecls(block), ...list] : list;
      problems.push(...checkRule(file, target, list, used, defs, aliasUsed, pairList, block.parentBlock, typographyDefs));
      continue;
    }
    const target = (block.parent || block.scopeRoot)
      ? (block.effectiveSelector || combineNestedSelector(selector, block.parent, block.scopeRoot))
      : selector;
    problems.push(...checkRule(file, target, list, used, defs, aliasUsed, list, block.parentBlock, typographyDefs));
  }
  problems.push(...stateOverrideProblems(file, blocks, declarations, used, typographyDefs));
  return problems;
}

const CSS_SELECTOR_START = /^(?:[.#[:*@&>~+]|(?:html|body|div|span|p|a|ul|ol|li|button|input|select|textarea|table|thead|tbody|tr|th|td|form|label|section|article|header|footer|main|nav|aside|dialog|details|summary|h[1-6]|pre|code|kbd|samp|strong|em|small|img|svg|canvas|iframe)\b)/i;

function hasDynamicRestCss(rest) {
  if (!rest.includes('__TS_EXPR__')) return false;
  if (/(?:^|[;\s{])(?:(?:font|border|line|letter|clip|text|webkit)[-\w]*__TS_EXPR__[-\w]*|--[-\w]*__TS_EXPR__[-\w]*)\s*:/i.test(rest)) {
    return true;
  }
  if (!rest.includes('{') || !rest.includes('}')) return false;
  for (const block of parseBlocks(rest)) {
    const db = directBody(block.body);
    if (!db.includes('__TS_EXPR__')) continue;
    if (declarations(block.body).some(decl => decl.dynamic)) return true;
    const sel = (block.selector || '').trim();
    if (sel && CSS_SELECTOR_START.test(sel) && hasDynamicDeclSegment(db)) return true;
  }
  return false;
}

/** Extract embedded style blocks/attributes and relevant remaining CSS with HTML-style flags. */
export function embeddedChunksDetailed(text) {
  const clean = stripComments(text);
  const bits = [];
  for (const match of clean.matchAll(/<style[^>]*>([\s\S]*?)<\/style>/gi)) bits.push({ css: match[1], htmlStyle: true });
  for (const match of clean.matchAll(/(?<![-\w])style\s*=\s*"([^"]*)"/gi)) bits.push({ css: match[1], htmlStyle: true });
  for (const match of clean.matchAll(/(?<![-\w])style\s*=\s*'([^']*)'/gi)) bits.push({ css: match[1], htmlStyle: true });
  for (const match of clean.matchAll(/(?<![-\w])style\s*=\s*([^\s"'=<>`]+)/gi)) {
    const val = match[1].replace(/\/$/, '');
    if (val) bits.push({ css: val, htmlStyle: true });
  }
  const rest = clean
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
    .replace(/(?<![-\w])style\s*=\s*"[^"]*"/gi, '')
    .replace(/(?<![-\w])style\s*=\s*'[^']*'/gi, '')
    .replace(/(?<![-\w])style\s*=\s*[^\s"'=<>`]+/gi, '');
  const restDecoded = rest.includes('\\') && /[:@]/.test(rest) ? decodeCssEscapes(rest) : rest;
  if (
    EMBEDDED_PROP.test(restDecoded)
    || radiusRoleProblems('', '(embedded)', '', decodeCssValue(rest)).length > 0
    || (/select/i.test(restDecoded) && /(?:background(?:-image|-position(?:-[xy])?|-repeat|-size)?|appearance|padding(?:-[\w-]+)?)\s*:/.test(restDecoded))
    || hasTrackedCustomDef(restDecoded)
    || DEPRECATED.test(rest)
    || /@font-face\b/i.test(restDecoded)
    || hasDynamicRestCss(rest)
  ) {
    bits.push({ css: rest, htmlStyle: false });
  }
  return bits;
}

/** Return only CSS text from the detailed embedded-chunk extraction. */
export function embeddedChunks(text) {
  return embeddedChunksDetailed(text).map(item => item.css);
}

export * from './parser-values.mjs';
export * from './parser-select.mjs';
