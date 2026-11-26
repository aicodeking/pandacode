/**
 * Drawing surfaces and markup for the style-API scan. Canvas: `.font` writes must not
 * carry literal type; literal pieces are traced through string and template literals,
 * +, join(), String(), concat(), conditionals, arrays and static bindings, and a
 * canvas-font exemption covers only its named context receivers. Dynamic property
 * reads, function returns and parameters are opaque. A literal `letterSpacing` other
 * than zero/normal fails. SVG: font and tracking attributes in markup and
 * setAttribute(NS) follow the CSS rules unless the markup is a serialized image.
 * HTML: style attributes, <style> blocks, inline scripts and select author rules.
 * scanRepo walks every HTML and script file (vendor excluded, preview/mock content
 * flagged by isPreview) through these scanners and scanTsFile.
 * Loaded through ts-style.mjs, which re-exports everything here.
 */
import { readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { root, htmlFiles, STYLE_EXEMPT, LITERALS, SCRIPT_EXTS } from './allowlists.mjs';
import {
  walk, scanCss, embeddedChunksDetailed, fontSizeProblems, varProblems, letterProblems, familyProblems, soleVar,
  take, decodeCssValue, declarations, selectRuleProblems, capsVariantProblems, cssWideResetProblems,
} from './parser.mjs';
import { exprRhs, resolveStaticStrings, staticString, unwrap } from './ts-style-ast.mjs';
import { scanTsFile, specAliasProblems } from './ts-style.mjs';

/** Recognize source preview script filenames for the preview style-API policy. */
export function isPreview(file) {
  return /^src\/preview[^/]*\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/.test(file);
}

/**
 * Recognize canvas text-content arguments from the source immediately before a string.
 * Canvas `.font =` strings are not skipped: scanStyleApi checks them as type.
 */
export function isCanvas(before) {
  return /(?:fillText\s*\(|strokeText\s*\(|measureText\s*\()\s*$/.test(before);
}

const SVG_SERIALIZERS = new Set(['encodeURIComponent', 'encodeURI', 'btoa']);
const isSerializerCall = node => {
  if (ts.isCallExpression(node)) {
    const callee = unwrap(node.expression);
    const name = callee && (ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '');
    return SVG_SERIALIZERS.has(name);
  }
  if (ts.isNewExpression(node)) {
    const callee = unwrap(node.expression);
    return Boolean(callee && ts.isIdentifier(callee) && (callee.text === 'Blob' || callee.text === 'File'));
  }
  return false;
};

/** Names passed straight to an image serializer (encodeURIComponent, btoa, new Blob([...])) in this file. */
export function serializedNames(sf) {
  const names = new Set();
  const visit = node => {
    if (isSerializerCall(node)) {
      for (const arg of node.arguments || []) {
        const n = unwrap(arg);
        for (const item of n && ts.isArrayLiteralExpression(n) ? n.elements : [n]) {
          const el = unwrap(item);
          if (el && ts.isIdentifier(el)) names.add(el.text);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return names;
}

/**
 * True when a string is a standalone serialized SVG image document: its text or an
 * enclosing template/concatenation is a data:image/svg+xml URL, or it flows into
 * encodeURIComponent/encodeURI/btoa or new Blob/File directly or through the const
 * it initializes. Page tokens cannot reach such images; inline DOM SVG stays checked.
 */
export function isSerializedSvg(node, text, sf, names = serializedNames(sf)) {
  if (/data:image\/svg\+xml/i.test(text)) return true;
  let cur = node;
  while (cur?.parent) {
    const parent = cur.parent;
    if (isSerializerCall(parent)) return true;
    if ((ts.isTemplateExpression(parent) || ts.isBinaryExpression(parent)) && /data:image\/svg\+xml/i.test(parent.getText(sf))) return true;
    if (ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name)) return names.has(parent.name.text);
    if (!(ts.isTemplateSpan(parent) || ts.isTemplateExpression(parent) || ts.isBinaryExpression(parent) || ts.isConditionalExpression(parent)
      || ts.isParenthesizedExpression(parent) || ts.isAsExpression(parent) || ts.isArrayLiteralExpression(parent))) return false;
    cur = parent;
  }
  return false;
}

/** Remove SVG glyph markup while retaining foreignObject content, style blocks and style attributes. */
export function stripSvgGlyph(text) {
  return text.replace(/<svg\b[^>]*>[\s\S]*?<\/svg>/gi, svg => {
    const kept = [];
    for (const match of svg.matchAll(/<foreignObject\b[^>]*>([\s\S]*?)<\/foreignObject>/gi)) kept.push(match[1]);
    const withoutForeign = svg.replace(/<foreignObject\b[^>]*>[\s\S]*?<\/foreignObject>/gi, '');
    for (const match of withoutForeign.matchAll(/<style\b[^>]*>[\s\S]*?<\/style>/gi)) kept.push(match[0]);
    const withoutStyles = withoutForeign.replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
    for (const match of withoutStyles.matchAll(/(?<![-\w])style\s*=\s*(?:"[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi)) {
      kept.push(match[0]);
    }
    return kept.join('\n');
  });
}

const SVG_FONT_ATTRS = new Set(['font-size', 'font-weight', 'font-family', 'font-variant', 'letter-spacing']);

/** Validate one static SVG presentation font attribute with the CSS property rules and LITERALS. */
export function svgAttrProblems(file, property, value, used) {
  const hits = [...cssWideResetProblems(property, value), ...capsVariantProblems(property, value)];
  if (property === 'letter-spacing') hits.push(...letterProblems(value));
  if (property === 'font-size') return [...hits, ...fontSizeProblems(file, '(svg text)', value, used)];
  if (take(LITERALS, used, 'literal', item => item.file === file && item.selector === '(svg text)' && item.property === property && item.value === value)) return hits;
  if (property === 'font-weight') {
    if (/^(?:bold|bolder|lighter)$/i.test(value)) hits.push(`font-weight keyword ${value}`);
    else if (!/^(?:inherit|unset|normal)$/.test(value) && !soleVar(value)) hits.push(`numeric font-weight ${value}`);
  } else if (property === 'font-family') hits.push(...familyProblems(value));
  return [...hits, ...varProblems(file, '(svg text)', property, value)];
}

/**
 * Check font-size/font-weight/font-family/font-variant/letter-spacing attributes on <svg>, <g>, <text>, <tspan>
 * and <textPath> in DOM markup, inline xmlns SVG included. Only callers that prove a
 * standalone serialized image document (isSerializedSvg, previews) pass serialized;
 * interpolated values are computed at runtime and stay with their call site.
 */
export function svgTextProblems(file, text, used, { serialized = false } = {}) {
  const markup = serialized ? text.replace(/<svg\b[^>]*\bxmlns\s*=[^>]*>[\s\S]*?<\/svg>/gi, '') : text;
  const problems = [];
  for (const tag of markup.matchAll(/<(?:svg|g|text|tspan|textPath)\b((?:[^>"']|"[^"]*"|'[^']*')*)>/gi)) {
    for (const attr of tag[1].matchAll(/(?<![-\w])(font-size|font-weight|font-family|font-variant|letter-spacing)\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/gi)) {
      const value = decodeCssValue((attr[2] ?? attr[3] ?? attr[4]).trim());
      if (value.includes('__TS_EXPR__')) continue;
      problems.push(...svgAttrProblems(file, attr[1].toLowerCase(), value, used).map(hit => `${file}: (svg text): ${hit}`));
    }
  }
  return problems;
}

/** Check setAttribute(NS) SVG font attributes with static values; runtime-computed values stay with their call site. */
export function svgAttrNodeProblems(file, names, valueNode, used, sf, bindings, label) {
  const attrs = [...names.values].map(name => name.toLowerCase()).filter(name => SVG_FONT_ATTRS.has(name));
  if (!attrs.length) return [];
  const parsed = exprRhs(valueNode, sf);
  const resolved = parsed.kind === 'literal' ? { values: new Set([parsed.value]), complete: true } : resolveStaticStrings(valueNode, bindings);
  const values = [...resolved.values].map(value => decodeCssValue(value.trim())).filter(value => value && !value.includes('__TS_EXPR__'));
  return attrs.flatMap(attr => values.flatMap(value => svgAttrProblems(file, attr, value, used).map(hit => `${file}: ${label}('${attr}'): ${hit}`)));
}

/**
 * Collect the literal text a canvas value is built from, following string concatenation,
 * templates, arrays, `[...].join()`, `String()`, `'...'.concat()`, conditionals and
 * bindings. Dynamic reads contribute nothing; any remaining non-space text is a literal.
 */
export function canvasLiteralText(node, bindings, seen = new Set()) {
  const n = unwrap(node);
  if (!n) return '';
  const walk = child => canvasLiteralText(child, bindings, seen);
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isNumericLiteral(n)) return n.text;
  if (ts.isTemplateExpression(n)) return n.head.text + n.templateSpans.map(span => ` ${walk(span.expression)} ${span.literal.text}`).join('');
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return `${walk(n.left)} ${walk(n.right)}`;
  if (ts.isConditionalExpression(n)) return `${walk(n.whenTrue)} ${walk(n.whenFalse)}`;
  if (ts.isArrayLiteralExpression(n)) return n.elements.map(walk).join(' ');
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (callee && ts.isIdentifier(callee) && callee.text === 'String') return n.arguments.map(walk).join(' ');
    if (callee && ts.isPropertyAccessExpression(callee) && ['join', 'concat', 'trim', 'toString'].includes(callee.name.text)) {
      return [walk(callee.expression), ...n.arguments.map(walk)].join(' ');
    }
    return '';
  }
  if (ts.isIdentifier(n) && bindings && !seen.has(n.text)) {
    const next = new Set([...seen, n.text]);
    return (bindings.get(n.text) || []).map(expr => canvasLiteralText(expr, bindings, next)).join(' ');
  }
  return '';
}

/** A canvas letterSpacing literal other than zero/normal sets tracking off the --tracking-* scale. */
export function canvasLetterProblems(file, rhsNode, bindings) {
  const text = canvasLiteralText(rhsNode, bindings).trim();
  if (!text || /^(?:0|0px|0em|0rem|normal)$/i.test(text)) return [];
  return [`${file}: canvas letterSpacing = ${text}: canvas tracking cannot read --tracking-* tokens; copy getComputedStyle(element).letterSpacing instead`];
}

/** Resolve whether a computed member key (literal or const/let binding) names `prop`. */
export function computedKeyIs(arg, prop, bindings) {
  if (staticString(arg) === prop) return true;
  return [...resolveStaticStrings(arg, bindings).values].includes(prop);
}

/** A canvas-font exemption covers only the named drawing contexts (receivers) in its file. */
export function canvasFontExempt(file, receiver, used) {
  return Boolean(receiver) && take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'canvas-font' && item.receivers?.includes(receiver));
}

/** Check a canvas `.font =` value: static or partly literal strings set type off the scale. */
export function canvasFontProblems(file, rhsNode, used, sf, bindings, receiver = '') {
  const parsed = exprRhs(rhsNode, sf);
  let values = [];
  if (parsed.kind === 'literal') values = [parsed.value];
  else if (parsed.kind === 'template') values = [parsed.value];
  else if (parsed.node) {
    const resolved = resolveStaticStrings(parsed.node, bindings);
    values = [...resolved.values];
  }
  // Preserve literal pieces even when a binary + expression includes dynamic operands.
  const parts = node => {
    const n = unwrap(node);
    if (n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return parts(n.left) + parts(n.right);
    if (n && ts.isIdentifier(n) && bindings.has(n.text)) {
      // resolveStaticStrings already follows constant aliases; avoid recursing through cycles.
      const resolved = resolveStaticStrings(n, bindings);
      if (resolved.complete) return [...resolved.values].join(' ');
    }
    const part = n && exprRhs(n, sf);
    return part && (part.kind === 'literal' || part.kind === 'template') ? part.value : '__TS_EXPR__';
  };
  if (parsed.node && ts.isBinaryExpression(parsed.node) && parsed.node.operatorToken.kind === ts.SyntaxKind.PlusToken) values.push(parts(parsed.node));
  const fixed = values.filter(value => value.replace(/__TS_EXPR__/g, '').trim());
  // join(), String(), concat(), arrays and conditionals cannot launder literal type pieces.
  if (!fixed.length) {
    const pieces = canvasLiteralText(rhsNode, bindings).trim();
    if (pieces) fixed.push(pieces);
  }
  if (!fixed.length) return [];
  if (canvasFontExempt(file, receiver, used)) return [];
  return fixed.map(value => `${file}: canvas font = ${value}: canvas text cannot read type tokens; copy getComputedStyle(element).font from a styled element instead`);
}

function decodeHtmlEntities(text) {
  return text.replace(/&(?:#x([0-9a-f]+)|#(\d+)|(quot|apos|amp|lt|gt));/gi, (m, hex, dec, named) => {
    if (hex) return String.fromCodePoint(parseInt(hex, 16));
    if (dec) return String.fromCodePoint(parseInt(dec, 10));
    const table = { quot: '"', apos: "'", amp: '&', lt: '<', gt: '>' };
    return table[named.toLowerCase()] ?? m;
  });
}

function scanHtmlTags(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt + 4);
      i = end < 0 ? html.length : end + 3;
      continue;
    }
    const nameMatch = /^<([a-zA-Z][^\s/>]*)/.exec(html.slice(lt));
    if (!nameMatch) { i = lt + 1; continue; }
    const tagName = nameMatch[1].toLowerCase();
    let j = lt + nameMatch[0].length;
    let quote = '';
    while (j < html.length) {
      const c = html[j];
      if (quote) {
        if (c === quote) quote = '';
        j++;
        continue;
      }
      if (c === '"' || c === "'") { quote = c; j++; continue; }
      if (c === '>') break;
      j++;
    }
    if (j >= html.length) break;
    const attrs = html.slice(lt + nameMatch[0].length, j);
    if (tagName === 'script' || tagName === 'style') {
      const closeRe = new RegExp(`<\\/${tagName}\\s*>`, 'gi');
      closeRe.lastIndex = j + 1;
      const closeMatch = closeRe.exec(html);
      const bodyEnd = closeMatch ? closeMatch.index : html.length;
      tags.push({ tagName, attrs, body: html.slice(j + 1, bodyEnd) });
      i = closeMatch ? closeMatch.index + closeMatch[0].length : html.length;
      continue;
    }
    tags.push({ tagName, attrs, body: '' });
    i = j + 1;
  }
  return tags;
}

function parseHtmlAttrs(attrs) {
  const list = [];
  let i = 0;
  while (i < attrs.length) {
    while (i < attrs.length && /[\s/]/.test(attrs[i])) i++;
    if (i >= attrs.length) break;
    const nameStart = i;
    while (i < attrs.length && !/[\s=/>]/.test(attrs[i])) i++;
    const name = attrs.slice(nameStart, i).toLowerCase();
    if (!name) { i++; continue; }
    while (i < attrs.length && /\s/.test(attrs[i])) i++;
    let value = '';
    if (attrs[i] === '=') {
      i++;
      while (i < attrs.length && /\s/.test(attrs[i])) i++;
      if (attrs[i] === '"' || attrs[i] === "'") {
        const q = attrs[i++];
        const valStart = i;
        while (i < attrs.length && attrs[i] !== q) i++;
        value = attrs.slice(valStart, i);
        if (i < attrs.length) i++;
      } else {
        const valStart = i;
        while (i < attrs.length && !/[\s>]/.test(attrs[i])) i++;
        value = attrs.slice(valStart, i);
      }
    }
    list.push({ name, value });
  }
  return list;
}

// Inline attributes otherwise lose the tag name in embeddedChunksDetailed().
export function inlineSelectProblems(file, html) {
  const hits = [];
  for (const tag of scanHtmlTags(html)) {
    if (tag.tagName !== 'select') continue;
    const attrs = parseHtmlAttrs(tag.attrs);
    let selector = 'select';
    if (attrs.some(attr => attr.name === 'multiple')) selector += '[multiple]';
    const size = attrs.find(attr => attr.name === 'size');
    if (size) selector += size.value === '1' ? '[size="1"]' : '[size]:not([size="1"])';
    for (const attr of attrs.filter(attr => attr.name === 'style')) {
      hits.push(...selectRuleProblems(file, selector, declarations(decodeHtmlEntities(attr.value))));
    }
  }
  return hits;
}

/** Scan embedded CSS plus executable inline scripts and decoded event-handler bodies. */
export function scanHtml(file, html, used = new Set(), defs = new Map(), aliasUsed = new Set()) {
  const problems = [...inlineSelectProblems(file, html), ...svgTextProblems(file, html.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, ''), used)];
  for (const chunk of embeddedChunksDetailed(html)) {
    problems.push(...scanCss(file, chunk.css, used, defs, aliasUsed, { htmlStyle: chunk.htmlStyle }));
  }
  for (const tag of scanHtmlTags(html)) {
    const attrs = parseHtmlAttrs(tag.attrs);
    if (tag.tagName === 'script' && tag.body.trim()) {
      const typeAttr = attrs.find(a => a.name === 'type');
      const type = (typeAttr?.value || '').split(';')[0].trim().toLowerCase();
      if (!type || /^(?:module|(?:text|application)\/(?:java|ecma)script)$/.test(type)) {
        problems.push(...scanTsFile(file, tag.body, used, defs, aliasUsed));
      }
    }
    for (const attr of attrs) {
      if (!/^on[a-z]+$/i.test(attr.name)) continue;
      const body = decodeHtmlEntities(attr.value).trim();
      if (!body) continue;
      problems.push(...scanTsFile(file, body, used, defs, aliasUsed));
    }
  }
  return problems;
}

/** Convert a repository-relative path to the forward-slash keys used by policy tables. */
export function normalizeRepoPath(file) {
  return file.replaceAll('\\', '/');
}

/** Scan source sheets/scripts, root HTML and browser-spec aliases into diagnostics and usage/definition maps. */
export function scanRepo() {
  const used = new Set();
  const defs = new Map();
  const aliasUsed = new Set();
  const problems = [];
  const skipVendor = path => normalizeRepoPath(relative(root, path)) === 'src/vendor';
  for (const path of walk(join(root, 'src'), '.css', [], skipVendor)) {
    const file = normalizeRepoPath(relative(root, path));
    problems.push(...scanCss(file, readFileSync(path, 'utf8'), used, defs, aliasUsed));
  }
  for (const name of htmlFiles) {
    problems.push(...scanHtml(name, readFileSync(join(root, name), 'utf8'), used, defs, aliasUsed));
  }
  for (const path of walk(join(root, 'src'), SCRIPT_EXTS, [], skipVendor)) {
    const file = normalizeRepoPath(relative(root, path));
    problems.push(...scanTsFile(file, readFileSync(path, 'utf8'), used, defs, aliasUsed));
  }
  for (const path of walk(join(root, 'tests'), '.spec.ts')) {
    const file = normalizeRepoPath(relative(root, path));
    problems.push(...specAliasProblems(file, readFileSync(path, 'utf8')));
  }
  return { used, defs, aliasUsed, problems };
}
