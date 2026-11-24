/**
 * Value grammar and per-value policy for the CSS guard: escapes, var() walking with
 * fallbacks, top-level splitting, font shorthand parts, token families and roles,
 * radius/clip-path rounds, caps/reset/stretch/tracking/family checks, custom
 * literal exceptions and alias/token resolution. Pure functions of their inputs
 * plus the token state in parser.mjs; exception usage is recorded through take().
 * Loaded through parser.mjs, which re-exports everything here.
 */
import {
  RADIUS, FONT_SIZE_NAME, WEIGHT_NAME, LEADING_NAME, RADIUS_NAME, TRACKING_NAME, FAMILY_NAME, ROOT_FILES,
  ROW_LEADING, LITERALS, EM_SIZES, LINE_HEIGHTS, CUSTOM, ALIASES, aliasNames,
} from './allowlists.mjs';
import { rootSelector } from './parser-select.mjs';
import { canonical, declarations, parseBlocks, stripComments, tokensCss } from './parser.mjs';

/** Decode CSS hex/simple escapes, replacing invalid code points with the replacement character. */
export function decodeCssEscapes(str) {
  if (!str || !str.includes('\\')) return str;
  return str.replace(/\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|([^\r\n\f]))/g, (_m, hex, ch) => {
    if (hex) {
      const code = parseInt(hex, 16);
      if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\uFFFD';
      return String.fromCodePoint(code);
    }
    return ch;
  });
}

/** Decode value escapes while keeping escaped quotes and backslashes safe inside strings. */
export function decodeCssValue(str) {
  if (!str || !str.includes('\\')) return str;
  let out = '';
  let quote = '';
  for (let i = 0; i < str.length; i++) {
    const c = str[i];
    if (c === '\\' && i + 1 < str.length) {
      const rest = str.slice(i);
      const hex = /^\\([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?/.exec(rest);
      let decoded = '';
      if (hex) {
        const code = parseInt(hex[1], 16);
        decoded = (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) ? '\uFFFD' : String.fromCodePoint(code);
        i += hex[0].length - 1;
      } else if (!/[\r\n\f]/.test(str[i + 1])) {
        decoded = str[++i];
      } else {
        out += c;
        continue;
      }
      if (quote && (decoded === quote || decoded === '\\')) out += `\\${decoded}`;
      else out += decoded;
      continue;
    }
    if (quote) {
      if (c === quote || c === '\n' || c === '\r' || c === '\f') quote = '';
    } else if (c === '"' || c === "'") {
      quote = c;
    }
    out += c;
  }
  return out;
}

/** Remove balanced calls to the named function outside identifier continuations. */
export function stripCalls(value, name) {
  const lower = value.toLowerCase();
  const needle = `${name.toLowerCase()}(`;
  let out = '';
  for (let i = 0; i < value.length; i++) {
    if (lower.startsWith(needle, i) && (i === 0 || !/[-\w]/.test(value[i - 1]))) {
      let depth = 0;
      let quote = '';
      for (; i < value.length; i++) {
        const ch = value[i];
        if (quote) {
          if (ch === '\\') { i++; continue; }
          if (ch === quote) quote = '';
          continue;
        }
        if (ch === '"' || ch === "'") { quote = ch; continue; }
        if (ch === '(') depth++;
        else if (ch === ')') { depth--; if (depth === 0) break; }
      }
      continue;
    }
    out += value[i];
  }
  return out;
}

/** Visit each var() name/fallback and recursively visit vars within its fallback. */
export function eachVar(value, fn) {
  const lower = value.toLowerCase();
  let i = 0;
  while (i < value.length) {
    const at = lower.indexOf('var(', i);
    if (at < 0) break;
    if (at > 0 && /[-\w]/.test(value[at - 1])) { i = at + 4; continue; }
    let depth = 1;
    let k = at + 4;
    let args = '';
    let q = '';
    for (; k < value.length; k++) {
      const c = value[k];
      if (q) {
        args += c;
        if (c === '\\' && value[k + 1]) { args += value[++k]; continue; }
        if (c === q) q = '';
        continue;
      }
      if (c === '"' || c === "'") { q = c; args += c; continue; }
      if (c === '(') depth++;
      else if (c === ')') { depth--; if (depth === 0) break; }
      args += c;
    }
    let name = '';
    let fallback = null;
    let nested = 0;
    let quote = '';
    for (let n = 0; n < args.length; n++) {
      const c = args[n];
      if (quote) {
        if (fallback === null) name += c;
        else fallback += c;
        if (c === '\\' && args[n + 1]) {
          const next = args[++n];
          if (fallback === null) name += next;
          else fallback += next;
          continue;
        }
        if (c === quote) quote = '';
        continue;
      }
      if (c === '"' || c === "'") quote = c;
      if (c === '(') nested++;
      else if (c === ')' && nested) nested--;
      if (nested === 0 && !quote && c === ',' && fallback === null) { fallback = ''; continue; }
      if (fallback === null) name += c;
      else fallback += c;
    }
    const trimmedName = name.trim();
    const trimmedFallback = fallback === null ? null : fallback.trim();
    fn(trimmedName, trimmedFallback);
    if (trimmedFallback) eachVar(trimmedFallback, fn);
    i = k + 1;
  }
}

/** Split a value at matching separator characters outside parentheses, quotes and escapes. */
export function splitTop(value, separator = /\s/) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (let i = 0; i < value.length; i++) {
    const ch = value[i];
    if (quote) {
      cur += ch;
      if (ch === '\\' && i + 1 < value.length) { cur += value[++i]; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '\\' && i + 1 < value.length) { cur += ch + value[++i]; continue; }
    if (ch === '"' || ch === "'") { quote = ch; cur += ch; continue; }
    if (ch === '(') depth++;
    else if (ch === ')') depth--;
    if (depth === 0 && separator.test(ch)) {
      if (cur.trim()) parts.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

/** Return the two sides of the first slash outside parentheses and quotes, or null. */
export function topSlash(token) {
  let depth = 0;
  let quote = '';
  for (let i = 0; i < token.length; i++) {
    const c = token[i];
    if (quote) { if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth--;
    else if (c === '/' && depth === 0) return [token.slice(0, i), token.slice(i + 1)];
  }
  return null;
}

/** Report literal numeric or alphabetic fallback content, including nested var fallbacks. */
export function fallbackBad(fallback) {
  if (fallback == null) return false;
  const bare = stripCalls(fallback, 'var').replace(/\s+/g, '');
  if (bare && (/[\d.]/.test(bare) || /[a-z]/i.test(bare))) return true;
  let bad = false;
  eachVar(fallback, (_name, nested) => { if (fallbackBad(nested)) bad = true; });
  return bad;
}

/** Return the tracked longhand family or radius family for a property. */
export function propertyFamily(property) {
  if (property === 'font-size' || property === 'font-weight' || property === 'line-height' || property === 'letter-spacing' || property === 'font-family') return property;
  if (RADIUS.test(property)) return 'radius';
  return '';
}

/** Check whether a token or approved alias belongs to the property family. */
export function familyOk(property, name) {
  const alias = ALIASES.find(item => item.name === name);
  const family = propertyFamily(property);
  if (alias && family) return alias.family === family;
  if (property === 'font-size') return FONT_SIZE_NAME.test(name);
  if (property === 'font-weight') return WEIGHT_NAME.test(name);
  if (property === 'line-height') return LEADING_NAME.test(name);
  if (property === 'letter-spacing') return TRACKING_NAME.test(name);
  if (property === 'font-family') return FAMILY_NAME.test(name);
  if (family === 'radius') return RADIUS_NAME.test(name);
  if (property === 'font') {
    return FONT_SIZE_NAME.test(name) || WEIGHT_NAME.test(name) || LEADING_NAME.test(name) || FAMILY_NAME.test(name)
      || ALIASES.some(item => item.name === name && item.family !== 'radius');
  }
  return true;
}

/** Allow the exact root-size pixel fallback only on root selectors in designated entry sheets. */
export function rootSizeFallback(file, selector, name, fallback) {
  if (name !== '--root-size' || fallback == null) return false;
  if (fallback.replace(/\s+/g, '') !== '14px') return false;
  if (!ROOT_FILES.has(file)) return false;
  return rootSelector(selector);
}

/** Return the name of a single var() with no fallback or surrounding content. */
export function soleVar(value) {
  if (!value) return '';
  const names = [];
  let fallback = false;
  eachVar(value, (name, fb) => { names.push(name); if (fb != null) fallback = true; });
  if (names.length === 1 && names[0].startsWith('--') && !fallback && stripCalls(value, 'var').trim() === '') return names[0];
  return '';
}

/** Return the first var() name in a value, or an empty string. */
export function firstVar(value) {
  let first = '';
  eachVar(value || '', name => { if (!first) first = name; });
  return first;
}

/** Return a strict display/title/heading/subheading role from the first variable. */
export function roleOf(value) {
  const match = /^--type-(display|title|heading|subheading)$/.exec(firstVar(value));
  return match ? match[1] : '';
}

/** Return any type size role from the first variable. */
export function sizeRole(value) {
  const match = /^--type-(display|title|heading|subheading|body|prose|meta|caption)$/.exec(firstVar(value));
  return match ? match[1] : '';
}

/** Check role-compatible leading, allowed resets/zeros/one, fixed heights and listed exceptions. */
export function leadingMatches(role, value, file, selector, used, mono) {
  if (!value) return true;
  if (/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(value) || /^(?:0|1)(?:\.0+)?$/.test(value) || zeroLength(value)) return true;
  const name = soleVar(value);
  if (name === `--type-${role}-leading`) return true;
  if (name === '--type-prose-compact-leading' && role === 'prose') return true;
  if (name === '--leading-code' && mono) return true;
  if (name && ROW_LEADING.test(name)) return true;
  return take(LINE_HEIGHTS, used, 'lh', item => item.file === file && item.selector === selector && item.value === value);
}

/** Split the supported font shorthand into size, weight, leading and family fields. */
export function fontParts(value) {
  if (/^(?:inherit|initial|unset|revert|revert-layer)$/.test(value)) return { family: value, size: value, weight: value, lineHeight: value };
  const tokens = [];
  for (const token of splitTop(value)) {
    const slash = topSlash(token);
    if (slash) tokens.push(...[slash[0], '/', slash[1]].filter(Boolean));
    else tokens.push(token);
  }
  const weightKw = /^(?:normal|bold|bolder|lighter|[1-9]00)$/;
  const style = /^(?:italic|oblique)$/;
  const variant = /^small-caps$/;
  const stretch = /^(?:ultra-condensed|extra-condensed|condensed|semi-condensed|semi-expanded|expanded|extra-expanded|ultra-expanded)$/;
  let i = 0;
  let weight = '';
  let width = '';
  while (i < tokens.length) {
    const token = tokens[i];
    if (/^var\(/i.test(token)) {
      const names = [];
      eachVar(token, name => names.push(name));
      if (names.some(name => /weight/.test(name))) { weight = token; i++; continue; }
      break;
    }
    if (weightKw.test(token)) { weight = token; i++; continue; }
    if (stretch.test(token)) { width = token; i++; continue; }
    if (style.test(token) || variant.test(token)) { i++; continue; }
    break;
  }
  const size = tokens[i] || '';
  let lineHeight = '';
  if (tokens[i + 1] === '/') { lineHeight = tokens[i + 2] || ''; i += 3; }
  else i += 1;
  return { family: tokens.slice(i).join(' '), size, weight, lineHeight, stretch: width };
}

/** Consume the first matching exception and record its kind/index usage marker. */
export function take(list, used, kind, pred) {
  const index = list.findIndex(pred);
  if (index < 0) return false;
  used.add(`${kind}:${index}`);
  return true;
}

/** Recognize the explicitly supported zero lengths. */
export function zeroLength(value) {
  return /^(?:0|0px|0rem|0pt|0em)$/.test(value);
}

/** Recognize canonical token names and approved local alias names. */
export function knownVar(name) {
  return canonical.has(name) || aliasNames.has(name);
}

const RADIUS_ROLES = new Map([
  ['--ds-card-radius', ['--radius-card', '--radius-inner']],
  ['--ds-inner-radius', ['--radius-inner', '--radius-control']],
  ['--ds-control-radius', ['--radius-control', '--radius-chip']],
]);

/**
 * The one dialog step-down selector in src/tokens.css. In-dialog glass plates keep
 * the card radius, and portaled menus/tooltips (.floating-menu, .tip-bubble) keep
 * page roles in both branches.
 */
export const DIALOG_STEP_DOWN = 'dialog>*:not(.pp-lb-plate,.tool-image-viewer-plate,.floating-menu,.tip-bubble),dialog>:is(.pp-lb-plate,.tool-image-viewer-plate)>*:not(.floating-menu,.tip-bubble)';

/** Check normalized values: scale reads belong only to exact role defaults/remaps in src/tokens.css. */
export function radiusRoleProblems(file, selector, property, value) {
  const problems = [];
  const role = RADIUS_ROLES.get(property);
  const target = selector.replace(/\s+/g, '');
  const index = file !== 'src/tokens.css' ? -1 : target === ':root' ? 0 : target === DIALOG_STEP_DOWN ? 1 : -1;
  const normalized = value.replace(/\bvar\(/gi, 'var(').replace(/\s+/g, '');
  const allowed = Boolean(role) && index >= 0 && normalized === `var(${role[index]})`;
  if (role && !allowed) {
    problems.push(`${property}: radius role definition must be var(${role[0]}) on :root or var(${role[1]}) on ${DIALOG_STEP_DOWN} in src/tokens.css`);
  }
  eachVar(value, name => {
    if (/^--radius-(?:card|inner|control)$/.test(name) && !allowed) {
      problems.push(`${property}: direct scale reference var(${name}); read the radius role instead`);
    }
  });
  return problems;
}

/** Report radius-role violations, unknown/wrong-family tokens and literal fallbacks. */
export function varProblems(file, selector, property, value) {
  const problems = radiusRoleProblems(file, selector, property, value);
  eachVar(value, (name, fallback) => {
    if (!name.startsWith('--')) {
      problems.push(`${property}: var() without a custom property`);
      return;
    }
    if (!knownVar(name)) problems.push(`${property}: undefined token ${name}`);
    else if (!familyOk(property, name)) {
      const kind = property === 'font' ? 'font shorthand' : (propertyFamily(property) || property);
      problems.push(`${property}: ${name} is not a ${kind} token`);
    }
    if (fallback != null && fallbackBad(fallback) && !rootSizeFallback(file, selector, name, fallback)) {
      problems.push(`${property}: literal fallback var(${name}, ${fallback})`);
    }
  });
  return problems;
}

/** Validate a size token/reset/zero or consume an exact literal/em exception. */
export function fontSizeProblems(file, selector, value, used) {
  const hits = varProblems(file, selector, 'font-size', value);
  if (/^(?:inherit|initial|unset|revert|revert-layer)$/.test(value) || zeroLength(value) || soleVar(value)) return hits;
  const bare = stripCalls(value, 'var').trim();
  if (!bare) return hits;
  if (/[\d.]+em\b/.test(bare)) {
    if (take(EM_SIZES, used, 'em', item => item.file === file && item.selector === selector && item.value === value)) return hits;
    return [...hits, `font-size: em size ${value} is not in the markdown/code allowlist`];
  }
  if (take(LITERALS, used, 'literal', item => item.file === file && item.selector === selector && item.property === 'font-size' && item.value === value)) return hits;
  return [...hits, `font-size: literal ${value}`];
}

/** Validate a leading token/reset/zero/one or consume an exact fixed-height exception. */
export function lineHeightProblems(file, selector, value, used) {
  if (/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(value) || /^(?:0|1)(?:\.0+)?$/.test(value) || zeroLength(value)) return [];
  if (soleVar(value)) return varProblems(file, selector, 'line-height', value);
  if (take(LINE_HEIGHTS, used, 'lh', item => item.file === file && item.selector === selector && item.value === value)) return [];
  return [`line-height: ${value} is not 0, 1, normal, or a leading token`];
}

/** Split top-level slash-separated radius parts outside parentheses and quotes. */
export function splitSlashes(token) {
  const parts = [];
  let cur = '';
  let depth = 0;
  let quote = '';
  for (const c of token) {
    if (quote) { cur += c; if (c === quote) quote = ''; continue; }
    if (c === '"' || c === "'") { quote = c; cur += c; continue; }
    if (c === '(') depth++;
    else if (c === ')') depth = Math.max(0, depth - 1);
    if (c === '/' && depth === 0) { if (cur.trim()) parts.push(cur.trim()); cur = ''; continue; }
    cur += c;
  }
  if (cur.trim()) parts.push(cur.trim());
  return parts;
}

const CORNER_RADIUS = /^(?:-webkit-)?border-(?:(?:start|end)-(?:start|end)|(?:top|bottom|before|after)-(?:left|right))-radius$/i;

const RADIUS_SHORTHAND = /^(?:-webkit-)?border-radius$/i;

/**
 * Reject elliptical (slash or two-axis corner), multi-value physical shorthand,
 * calculated and unlisted literal radius parts.
 */
export function radiusProblems(value, property = '') {
  const problems = [];
  if (topSlash(value)) problems.push(`elliptical radius / is not allowed (${value})`);
  if (CORNER_RADIUS.test(property) && splitTop(value).length > 1) problems.push(`elliptical corner radius is not allowed; ${property} takes one value (${value})`);
  if (RADIUS_SHORTHAND.test(property) && !topSlash(value) && splitTop(value).length > 1) {
    problems.push(`multi-value ${property} shorthand maps corners physically; use one value or logical border-start-*/border-end-* longhands (${value})`);
  }
  for (const part of splitTop(value).flatMap(splitSlashes)) {
    if (/^(?:0|0px|0rem|50%|inherit|initial|unset|revert|revert-layer)$/.test(part)) continue;
    if (/^var\(/i.test(part)) {
      if (stripCalls(part, 'var').trim()) problems.push(`literal radius ${part}`);
      continue;
    }
    if (/^calc\(/i.test(part)) problems.push(`calc radius ${part}`);
    else problems.push(`literal radius ${part}`);
  }
  return problems;
}

/** Validate round radii inside clip functions against scale/role tokens, zero and circles. */
export function clipPathProblems(file, selector, value) {
  const problems = radiusRoleProblems(file, selector, 'clip-path', value);
  for (let i = 0; i < value.length; i++) {
    if (value[i] !== '(') continue;
    let depth = 1;
    let k = i + 1;
    let inner = '';
    let quote = '';
    for (; k < value.length; k++) {
      const ch = value[k];
      if (quote) {
        inner += ch;
        if (ch === '\\' && value[k + 1]) { inner += value[++k]; continue; }
        if (ch === quote) quote = '';
        continue;
      }
      if (ch === '"' || ch === "'") { quote = ch; inner += ch; continue; }
      if (ch === '(') depth++;
      else if (ch === ')') { depth--; if (depth === 0) break; }
      inner += ch;
    }
    const tokens = splitTop(inner);
    const roundIdx = tokens.findIndex(tok => tok.toLowerCase() === 'round');
    if (roundIdx >= 0) {
      const roundTokens = tokens.slice(roundIdx + 1);
      const roundText = roundTokens.join(' ');
      if (!roundTokens.length) {
        problems.push('clip-path round has no radius value');
      } else {
        if (topSlash(roundText)) problems.push(`clip-path round uses elliptical / (${roundText})`);
        for (const tok of roundTokens.flatMap(splitSlashes)) {
          if (/^(?:0|0px|50%)$/.test(tok)) continue;
          if (/^var\(/i.test(tok) && !stripCalls(tok, 'var').trim()) {
            const varHits = varProblems(file, selector, 'border-radius', tok);
            problems.push(...varHits.map(hit => `clip-path round ${hit}`));
            eachVar(tok, name => {
              if (name.startsWith('--') && knownVar(name) && !RADIUS_NAME.test(name) && !/^--ds-(?:card|inner|control)-radius$/.test(name)) {
                problems.push(`clip-path round ${name} is not a --radius-* or --ds-{card,inner,control}-radius token`);
              }
            });
          } else {
            problems.push(`clip-path rounds with ${tok}, not a radius scale/role token, 0, or 50%`);
          }
        }
      }
    }
    i = k;
  }
  return problems;
}

const CAPS_VARIANT = /(?:^|[^-\w])(?:all-)?(?:small|petite)-caps(?![-\w])|(?:^|[^-\w])(?:unicase|titling-caps)(?![-\w])/i;
const CAPS_FEATURE = /(?:^|[^-\w])["']?(?:smcp|c2sc|pcap|c2pc|unic|titl)["']?(?![-\w])/i;
const RESET_PROPS = new Set(['font', 'font-size', 'font-family', 'font-weight', 'line-height', 'letter-spacing', 'all', 'font-variant', 'font-variant-caps', 'font-stretch', 'font-width']);
/** Font width keywords and percentages synthesize condensed or expanded glyphs off the sans/mono families. */
const STRETCH_OK = /^(?:normal|100%|inherit|unset)$/i;

let typographyTokens;
/** Resolve values used by caps/transform checks, including fallbacks and cycles.
 * Local declarations win over file definitions; canonical token definitions are last.
 * All possible values are checked, so a conditional cascade cannot conceal caps.
 */
export function resolvedTypography(value, list = [], defs = new Map(), file = '', seen = new Set()) {
  const values = [stripCalls(value, 'var')];
  let complete = true;
  eachVar(value, (name, fallback) => {
    if (seen.has(name)) { complete = false; return; }
    const local = list.filter(decl => decl.property === name).map(decl => decl.value);
    const records = defs.get(name) || [];
    const own = records.filter(record => record.file === file).map(record => record.value);
    const token = (typographyTokens ??= tokenMap(tokensCss)).get(name);
    const candidates = local.length ? local : own.length ? own : token ? [token] : [];
    if (fallback != null && fallback.trim()) candidates.push(fallback);
    if (!candidates.length) complete = false;
    for (const candidate of candidates) {
      const resolved = resolvedTypography(candidate, list, defs, file, new Set([...seen, name]));
      if (resolved === null) complete = false;
      else values.push(resolved);
    }
  });
  return complete ? values.join(' ').trim() : null;
}

export function capsVariantProblems(property, value, list = [], defs = new Map(), file = '') {
  const variant = property === 'font-variant';
  const feature = property === 'font-feature-settings' || property === '-webkit-font-feature-settings';
  if ((variant || feature) && /var\(/i.test(value)) {
    const resolved = resolvedTypography(value, list, defs, file);
    const variantWords = /^(?:(?:normal|none|common-ligatures|no-common-ligatures|discretionary-ligatures|no-discretionary-ligatures|historical-ligatures|no-historical-ligatures|contextual|no-contextual|lining-nums|oldstyle-nums|proportional-nums|tabular-nums|diagonal-fractions|stacked-fractions|ordinal|slashed-zero|jis78|jis83|jis90|jis04|simplified|traditional|full-width|proportional-width|ruby|sub|super)\s*)+$/i;
    const featureWords = /^(?:normal|(?:["'][a-z0-9]{4}["']|[a-z0-9]{4})(?:\s+(?:on|off|\d+))?)(?:\s*,\s*(?:["'][a-z0-9]{4}["']|[a-z0-9]{4})(?:\s+(?:on|off|\d+))?)*$/i;
    if (resolved === null) return [`${property} ${value} has unresolved var() caps settings`];
    const hits = capsVariantProblems(property, resolved);
    if (hits.length) return hits;
    if (!(variant ? variantWords : featureWords).test(resolved)) return [`${property} ${value} resolves to arbitrary caps settings: ${resolved}`];
    return [];
  }
  if ((variant || property === 'font') && CAPS_VARIANT.test(value)) {
    return [`${property} ${value} synthesizes caps; use text-transform:uppercase with --tracking-caps`];
  }
  if (feature && CAPS_FEATURE.test(value)) {
    return [`${property} ${value} enables a caps feature; use text-transform:uppercase with --tracking-caps`];
  }
  return [];
}

/** Reject browser-default resets on fonts, leading, tracking and all. */
export function cssWideResetProblems(property, value) {
  if (!RESET_PROPS.has(property) || !/^(?:initial|revert|revert-layer)$/i.test(value.trim())) return [];
  return [`${property}:${value.trim()} resets to the browser default, outside the type scale; use a role token, inherit or unset`];
}

/** Reject synthetic width (font-stretch/font-width, or a stretch keyword in the font shorthand). */
export function stretchProblems(property, value) {
  if (property === 'font-stretch' || property === 'font-width') {
    if (STRETCH_OK.test(value.trim()) || /^(?:initial|revert|revert-layer)$/i.test(value.trim())) return [];
    return [`${property}:${value.trim()} synthesizes condensed or expanded glyphs; the type scale uses the normal width of --sans/--mono`];
  }
  if (property === 'font' && fontParts(value).stretch) return [`font shorthand width ${fontParts(value).stretch} synthesizes condensed or expanded glyphs; drop it`];
  return [];
}

export function letterProblems(value) {
  if (/^(?:0|0px|0em|0rem|normal|inherit|initial|unset|revert|revert-layer)$/.test(value)) return [];
  if (/^var\(--tracking-[\w-]+\)$/.test(value)) return [];
  return [`letter-spacing: ${value} is not 0, normal, inherit, or a --tracking-* token`];
}

/** Require a sans/mono token or a supported CSS-wide family keyword. */
export function familyProblems(family) {
  if (/^(?:var\(--sans\)|var\(--mono\)|inherit|initial|unset|revert|revert-layer)$/.test(family)) return [];
  return [`font family ${family || '(missing)'} is not var(--sans), var(--mono), or inherit`];
}

/** Detect literal content or literal fallbacks in a custom-property definition. */
export function customLiteral(value) {
  if (soleVar(value) || zeroLength(value)) return false;
  let badFallback = false;
  eachVar(value, (_name, fallback) => { if (fallback != null && fallbackBad(fallback)) badFallback = true; });
  if (badFallback) return true;
  const bare = stripCalls(value, 'var');
  return /[\d.]/.test(bare) || /[a-z]/i.test(bare);
}

/** Consume a custom-property exception matching its name, file, value and literal policy. */
export function matchCustom(file, name, value, used, literal) {
  const compact = value.replace(/\s+/g, '');
  return take(CUSTOM, used, 'custom', item => {
    if (item.name !== name) return false;
    if (literal && !item.allowLiteral) return false;
    if (item.files && !item.files.has(file)) return false;
    if (item.values && !item.values.has(compact)) return false;
    return true;
  });
}

function aliasProperty(name) {
  const alias = ALIASES.find(item => item.name === name);
  if (alias) return alias.family === 'radius' ? 'border-radius' : alias.family;
  if (/radius/i.test(name)) return 'border-radius';
  if (/weight/i.test(name)) return 'font-weight';
  if (/leading|line-height/i.test(name)) return 'line-height';
  if (/tracking/i.test(name)) return 'letter-spacing';
  if (/font-family/i.test(name)) return 'font-family';
  if (/size|font/i.test(name)) return 'font-size';
  return '';
}

/** Verify every alias definition path reaches a compatible canonical token without cycles or literal fallback. */
export function valueResolves(value, name, defs, seen = new Set()) {
  const normalised = value.replace(/\s+/g, ' ').trim();
  const prop = aliasProperty(name);
  if (zeroLength(normalised)) return prop !== 'font-size' && prop !== 'font-family' && prop !== 'font-weight';
  if (prop === 'border-radius' && normalised === '50%') return true;
  const vars = [];
  eachVar(normalised, (token, fallback) => vars.push([token, fallback]));
  if (!vars.length) return false;
  const bare = stripCalls(normalised, 'var');
  if (/[\d.]+(?:px|rem|pt)\b/.test(bare) || /\b[1-9]00\b/.test(bare)) return false;
  return vars.every(([token, fallback]) => {
    if (!token.startsWith('--')) return false;
    if (fallback != null && fallbackBad(fallback)) return false;
    if (canonical.has(token)) return !prop || familyOk(prop, token);
    if (!aliasNames.has(token) || seen.has(token)) return false;
    if (prop && !familyOk(prop, token)) return false;
    const nextSeen = new Set([...seen, token]);
    const nested = defs.get(token) || [];
    return nested.length > 0 && nested.every(item => valueResolves(item.value, token, defs, nextSeen));
  });
}

/** Build a first-definition map of custom properties across parsed CSS blocks. */
export function tokenMap(css) {
  const map = new Map();
  for (const block of parseBlocks(stripComments(css))) {
    for (const decl of declarations(block.body)) {
      if (decl.property.startsWith('--') && !map.has(decl.property)) map.set(decl.property, decl.value);
    }
  }
  return map;
}

/** Record a sole fixed row/control/button height token used as line-height. */
export function noteRowLeading(value, used) {
  const name = soleVar(value);
  if (name && ROW_LEADING.test(name)) used.add(`rowlead:${name}`);
}
