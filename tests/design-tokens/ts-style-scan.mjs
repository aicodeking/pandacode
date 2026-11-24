/**
 * Judges for traced style writes: cssText, style.* and setProperty values (static,
 * dynamic and template), style objects (Object.assign, JSX, keyframes), animate()
 * arguments, inline CSS module text and select receivers traced to
 * createElement('select'), explicit select queries or HTMLSelectElement annotations.
 * Each judge reuses the CSS policy in parser.mjs and pairing.mjs and records exception
 * usage. Loaded through ts-style.mjs, which re-exports everything here.
 */
import ts from 'typescript';
import {
  CHECKED, ALLOW_NONE, STYLE_PROPS, STYLE_EXEMPT, REDEFINES, aliasNames, FONT_SIZE_NAME, WEIGHT_NAME,
  LEADING_NAME, RADIUS_NAME, TRACKING_NAME, FAMILY_NAME,
} from './allowlists.mjs';
import {
  scanCss, varProblems, radiusRoleProblems, clipPathProblems, soleVar, tokenOwner, take, eachVar, decodeCssValue,
  decodeCssEscapes, knownVar, hasDynamicCssSegment, declarations, selectRuleProblems, selectSelectorKinds,
} from './parser.mjs';
import { checkPair } from './pairing.mjs';
import {
  LOCKED_TEMPLATE_PREFIX, exprRhs, hasCastToType, isStyleAssignOp, resolveCallTarget, resolveStaticStrings,
  staticPropName, staticString, styleKeyToJs, unwrap,
} from './ts-style-ast.mjs';
import { setPropertyKind, styleLiteralProblems } from './ts-style.mjs';

export function judgeCssTextNode(file, rhsNode, used, defs, aliasUsed, label, sf) {
  const parsed = exprRhs(rhsNode, sf);
  if (parsed.kind === 'literal') {
    if (!parsed.value) return [];
    return scanCss(file, parsed.value, used, defs, aliasUsed).map(hit => `${file}: ${label}: ${hit}`);
  }
  if (parsed.kind === 'template') {
    const substituted = parsed.value;
    if (hasDynamicCssSegment(substituted)) {
      return [`${file}: ${label}: dynamic template expression ${parsed.text}`];
    }
    return scanCss(file, substituted, used, defs, aliasUsed).map(hit => `${file}: ${label}: ${hit}`);
  }
  if (label === "setAttribute('style')" && take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'setAttribute-style')) {
    return [];
  }
  return [`${file}: ${label}: dynamic style expression ${parsed.value || '(empty)'}`];
}

function exemptStyle(file, jsKey, used) {
  if (file === 'src/sketch.ts' && jsKey === 'fontSize') return take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'sketch');
  if (file === 'src/motion.ts' && jsKey === 'borderRadius') return take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'computed-radius');
  return false;
}

function safeNonRoundClipPathTemplate(value) {
  if (/\bround\b/i.test(value)) return false;
  const trimmed = value.trim();
  if (/^path\(\s*(["'])[\s\S]*\1\s*\)$/i.test(trimmed)) return true;
  if (!/^(?:inset|polygon|circle|ellipse|rect|xywh)\([\s\S]*\)$/i.test(trimmed)) return false;
  let quote = '';
  for (let i = 0; i < trimmed.length; i++) {
    const ch = trimmed[i];
    if (quote) {
      if (ch === '\\') { i++; continue; }
      if (ch === quote) quote = '';
      continue;
    }
    if (ch === '"' || ch === "'") { quote = ch; continue; }
    if (trimmed.startsWith('__TS_EXPR__', i)) {
      const after = trimmed.slice(i + '__TS_EXPR__'.length);
      if (!/^(?:%|(?:px|rem|em|vw|vh|vmin|vmax|deg|rad|turn)\b)/i.test(after)) return false;
      i += '__TS_EXPR__'.length - 1;
    }
  }
  return true;
}

const UNSAFE_DYNAMIC_VAR = new Set([
  '--type-display', '--type-title', '--type-heading', '--type-subheading', '--type-caption',
  '--root-size',
  '--type-display-weight', '--type-title-weight', '--type-heading-weight', '--type-subheading-weight', '--weight-strong',
  '--type-display-leading', '--type-title-leading', '--type-heading-leading', '--type-caption-leading',
  '--type-prose-leading', '--type-prose-compact-leading', '--leading-code',
  '--tracking-tight', '--tracking-caps',
]);

function isTypeOrRadiusToken(name) {
  return FONT_SIZE_NAME.test(name) || WEIGHT_NAME.test(name) || LEADING_NAME.test(name)
    || RADIUS_NAME.test(name) || TRACKING_NAME.test(name) || FAMILY_NAME.test(name)
    || aliasNames.has(name);
}

export function dynamicVarProblems(file, label, value, aliasUsed) {
  const decoded = decodeCssValue(value);
  const hits = varProblems(file, '(style)', label, decoded).map(hit => `${file}: ${hit}`);
  eachVar(decoded, name => {
    if (aliasUsed && aliasNames.has(name)) aliasUsed.add(name);
    if (!name.startsWith('--') || !knownVar(name)) return;
    if (UNSAFE_DYNAMIC_VAR.has(name)) {
      hits.push(`${file}: ${label}: ${name} cannot be assigned to a computed style property without verified pairing`);
    } else if (!isTypeOrRadiusToken(name)) {
      hits.push(`${file}: ${label}: ${name} is not a type or radius token`);
    }
  });
  return hits;
}

/** Apply the shared radius policy even to untracked keys and partially dynamic values. */
export function radiusRoleNodeProblems(file, property, node, sf, bindings) {
  const parsed = exprRhs(node, sf);
  const values = parsed.kind === 'literal' || parsed.kind === 'template'
    ? [parsed.value]
    : bindings ? resolveStaticStrings(node, bindings).values : [];
  return [...values].flatMap(value => radiusRoleProblems(file, '(style)', property, decodeCssValue(value)))
    .map(hit => `${file}: ${hit}`);
}

export function judgeStyleNode(file, jsKey, rhsNode, used, label, sf, aliasUsed, runPair = true) {
  const property = jsKey === 'textTransform' ? 'text-transform' : STYLE_PROPS[jsKey];
  if (ALLOW_NONE.has(property)) return [`${file}: ${label}: ${property} is not allowed; use the type scale and uppercase tracking rules`];
  const parsed = exprRhs(rhsNode, sf);
  const roleHits = radiusRoleNodeProblems(file, property, rhsNode, sf);
  if (roleHits.length) return roleHits;
  if (parsed.kind === 'literal') {
    if (!parsed.value) return [];
    const decoded = decodeCssValue(parsed.value);
    const hits = styleLiteralProblems(property, parsed.value, file, used, aliasUsed)
      .map(hit => `${file}: ${label} ${jsKey} = ${parsed.value}: ${hit}`);
    if (runPair && (CHECKED.has(property) || property === 'text-transform')) {
      checkPair('(style)', [{ property, value: decoded, important: false }], hits, `${file}: ${label}`, file, used);
    }
    return hits;
  }
  if (property === 'text-transform') return [];
  if ((property === 'clip-path' || property === '-webkit-clip-path') && parsed.kind === 'template') {
    const clipHits = clipPathProblems(file, '(style)', decodeCssValue(parsed.value));
    if (clipHits.length) return clipHits.map(hit => `${file}: ${label} ${jsKey} = ${parsed.text}: ${hit}`);
    if (safeNonRoundClipPathTemplate(parsed.value)) return [];
  }
  if (exemptStyle(file, jsKey, used)) return [];
  return [`${file}: ${label} ${jsKey} = ${parsed.value || '(empty)'}: right-hand side is not a var() token`];
}

export function judgeSetterNode(file, property, rawName, rhsNode, used, label, sf, aliasUsed, bindings, runPair = true) {
  if (ALLOW_NONE.has(property)) return [`${file}: ${label}(${rawName}): ${property} is not allowed; use the type scale and uppercase tracking rules`];
  const parsed = exprRhs(rhsNode, sf);
  const roleHits = radiusRoleNodeProblems(file, property, rhsNode, sf, bindings);
  if (roleHits.length) return roleHits;
  if (tokenOwner(property)) {
    if (!take(REDEFINES, used, 'redef', item => item.file === file && item.name === property)) {
      return [`${file}: ${label}(${rawName}): redefines canonical token ${property}`];
    }
    return [];
  }
  if (parsed.kind === 'literal') {
    if (!parsed.value && !property.startsWith('--')) return [];
    if (parsed.value) {
      const decoded = decodeCssValue(parsed.value);
      const hits = styleLiteralProblems(property, parsed.value, file, used, aliasUsed)
        .map(hit => `${file}: ${label}(${rawName}): ${hit}`);
      if (runPair && (CHECKED.has(property) || property === 'text-transform')) {
        checkPair('(style)', [{ property, value: decoded, important: false }], hits, `${file}: ${label}`, file, used);
      }
      return hits;
    }
  }
  if (property === 'text-transform') return [];
  if ((property === 'clip-path' || property === '-webkit-clip-path') && parsed.kind === 'template') {
    const clipHits = clipPathProblems(file, '(style)', decodeCssValue(parsed.value));
    if (clipHits.length) return clipHits.map(hit => `${file}: ${label}(${rawName}): ${hit}`);
    if (safeNonRoundClipPathTemplate(parsed.value)) return [];
  }
  if (parsed.kind === 'expr' && parsed.node && ts.isIdentifier(parsed.node) && bindings) {
    const resolved = resolveStaticStrings(parsed.node, bindings);
    if (resolved.values.size > 0) {
      const hits = [];
      for (const val of resolved.values) {
        if (!val && !property.startsWith('--')) continue;
        if (val) {
          const decoded = decodeCssValue(val);
          hits.push(...styleLiteralProblems(property, val, file, used, aliasUsed).map(hit => `${file}: ${label}(${rawName}): ${hit}`));
          if (runPair && (CHECKED.has(property) || property === 'text-transform')) {
            checkPair('(style)', [{ property, value: decoded, important: false }], hits, `${file}: ${label}`, file, used);
          }
        }
      }
      if (hits.length || resolved.complete) return hits;
    }
  }
  return [`${file}: ${label}(${rawName}): right-hand side is not a var() token`];
}

function exprHasSuspiciousStyleConcat(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return exprHasSuspiciousStyleConcat(n.left) || exprHasSuspiciousStyleConcat(n.right);
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return /^(?:px|rem|pt|em)\b|(?:\d+(?:\.\d+)?(?:px|rem|pt|em)\b)|\bround\b|\bvar\s*\(/i.test(n.text);
  }
  return false;
}

export function judgeDynamicSetterNode(file, propNode, rhsNode, label, sf, bindings, used, aliasUsed, seen = new Set()) {
  const propExpr = unwrap(propNode);
  const propText = propExpr ? propExpr.getText(sf).trim() : '(dynamic)';
  if (ts.isTemplateExpression(propExpr) && LOCKED_TEMPLATE_PREFIX.test(propExpr.head.text)) {
    return [`${file}: ${label}(${propText}): dynamic canonical token property`];
  }
  const rhs = unwrap(rhsNode);
  if (rhs && ts.isConditionalExpression(rhs)) {
    return [
      ...judgeDynamicSetterNode(file, propNode, rhs.whenTrue, label, sf, bindings, used, aliasUsed, seen),
      ...judgeDynamicSetterNode(file, propNode, rhs.whenFalse, label, sf, bindings, used, aliasUsed, seen),
    ];
  }
  const parsed = exprRhs(rhsNode, sf);
  if (parsed.kind === 'literal') {
    if (!parsed.value) return [];
    if (soleVar(decodeCssValue(parsed.value))) {
      return dynamicVarProblems(file, `${label}(${propText})`, parsed.value, aliasUsed);
    }
    return [`${file}: ${label}(${propText}) = ${parsed.value}: right-hand side is not a var() token`];
  }
  if (parsed.kind === 'template') {
    if (/\bvar\s*\(/i.test(parsed.value)) {
      const hits = dynamicVarProblems(file, `${label}(${propText})`, parsed.value, aliasUsed);
      if (hits.length) return hits;
      return [`${file}: ${label}(${propText}) = ${parsed.text}: right-hand side is not a var() token`];
    }
    if (/(?:__TS_EXPR__|\d)(?:px|rem|pt|em)\b|\bround\b/i.test(parsed.value)) {
      return [`${file}: ${label}(${propText}) = ${parsed.text}: dynamic property with literal type/radius value`];
    }
    if (take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'dynamic-setProperty')) {
      return [];
    }
    return [`${file}: ${label}(${propText}) = ${parsed.text}: unallowlisted dynamic ${label}`];
  }
  if (rhs && ts.isBinaryExpression(rhs) && rhs.operatorToken.kind === ts.SyntaxKind.PlusToken && exprHasSuspiciousStyleConcat(rhs)) {
    return [`${file}: ${label}(${propText}) = ${parsed.value}: dynamic property with literal type/radius value`];
  }
  if (rhs && ts.isIdentifier(rhs) && bindings && !seen.has(rhs.text)) {
    const exprs = bindings.get(rhs.text);
    if (exprs && exprs.length) {
      const nextSeen = new Set([...seen, rhs.text]);
      const hits = [];
      for (const bound of exprs) hits.push(...judgeDynamicSetterNode(file, propNode, bound, label, sf, bindings, used, aliasUsed, nextSeen));
      return hits;
    }
  }
  if (take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'dynamic-setProperty')) {
    return [];
  }
  return [`${file}: ${label}(${propText}) = ${parsed.value || '(empty)'}: unallowlisted dynamic ${label}`];
}

function scanStyleObjectAst(file, objNode, used, label, defs, aliasUsed, sf, bindings, opts = {}) {
  const { allowArrayValues = false, strictOpaque = false, seen = new Set(), pairDecls = null } = opts;
  const problems = [];
  const localPairDecls = pairDecls || [];
  const checkKeyValue = (key, valNode) => {
    if (key === 'cssText') {
      problems.push(...judgeCssTextNode(file, valNode, used, defs, aliasUsed, `${label} cssText`, sf));
      return;
    }
    if (decodeCssEscapes(key).startsWith('--')) {
      const property = setPropertyKind(key);
      if (!property) {
        problems.push(...radiusRoleNodeProblems(file, key, valNode, sf, bindings));
        return;
      }
      const init = unwrap(valNode);
      if (allowArrayValues && init && ts.isArrayLiteralExpression(init)) {
        for (const el of init.elements) {
          if (!ts.isOmittedExpression(el)) {
            problems.push(...judgeSetterNode(file, property, key, el, used, label, sf, aliasUsed, bindings, false));
          }
        }
        return;
      }
      problems.push(...judgeSetterNode(file, property, key, valNode, used, label, sf, aliasUsed, bindings, false));
      return;
    }
    const jsKey = styleKeyToJs(key);
    if (!jsKey) {
      problems.push(...radiusRoleNodeProblems(file, key, valNode, sf, bindings));
      return;
    }
    const property = jsKey === 'textTransform' ? 'text-transform' : STYLE_PROPS[jsKey];
    const init = unwrap(valNode);
    if (allowArrayValues && init && ts.isArrayLiteralExpression(init)) {
      for (const el of init.elements) {
        problems.push(...judgeStyleNode(file, jsKey, el, used, label, sf, aliasUsed, true));
      }
      return;
    }
    problems.push(...judgeStyleNode(file, jsKey, valNode, used, label, sf, aliasUsed, false));
    const parsed = exprRhs(valNode, sf);
    if (parsed.kind === 'literal' && parsed.value && (CHECKED.has(property) || property === 'text-transform')) {
      localPairDecls.push({ property, value: decodeCssValue(parsed.value), important: false });
    }
  };

  for (const prop of objNode.properties) {
    if (ts.isSpreadAssignment(prop)) {
      problems.push(...scanStyleSourceExpr(file, prop.expression, used, label, defs, aliasUsed, sf, bindings, {
        allowArrayValues, strictOpaque, seen, pairDecls: localPairDecls,
      }));
    } else if (ts.isPropertyAssignment(prop)) {
      const key = staticPropName(prop.name);
      if (key !== null) {
        checkKeyValue(key, prop.initializer);
      } else if (ts.isComputedPropertyName(prop.name)) {
        const resolved = resolveStaticStrings(prop.name.expression, bindings);
        if (resolved.values.size > 0) {
          for (const k of resolved.values) checkKeyValue(k, prop.initializer);
        }
        if (!resolved.complete) {
          problems.push(`${file}: ${label}: dynamic computed style property [${prop.name.expression.getText(sf).trim()}]`);
        }
      }
    } else if (ts.isShorthandPropertyAssignment(prop)) {
      checkKeyValue(prop.name.text, prop.name);
    }
  }

  if (!pairDecls && localPairDecls.length) {
    checkPair('(style)', localPairDecls, problems, `${file}: ${label}`, file, used);
  }
  return problems;
}

export function scanStyleSourceExpr(file, exprNode, used, label, defs, aliasUsed, sf, bindings, opts = {}) {
  const { allowArrayValues = false, strictOpaque = false, allowStringCss = false, seen = new Set(), pairDecls = null } = opts;
  const n = unwrap(exprNode);
  if (!n) return [];
  if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(n) && n.text === 'undefined')) return [];
  if (ts.isObjectLiteralExpression(n)) {
    return scanStyleObjectAst(file, n, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, seen, pairDecls });
  }
  if (allowStringCss && (staticString(n) !== null || ts.isTemplateExpression(n))) {
    return judgeCssTextNode(file, n, used, defs, aliasUsed, label, sf);
  }
  if (ts.isConditionalExpression(n)) {
    return [
      ...scanStyleSourceExpr(file, n.whenTrue, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, allowStringCss, seen }),
      ...scanStyleSourceExpr(file, n.whenFalse, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, allowStringCss, seen }),
    ];
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return scanStyleSourceExpr(file, n.right, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, allowStringCss, seen });
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...scanStyleSourceExpr(file, n.left, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, allowStringCss, seen }),
        ...scanStyleSourceExpr(file, n.right, used, label, defs, aliasUsed, sf, bindings, { allowArrayValues, strictOpaque, allowStringCss, seen }),
      ];
    }
  }
  if (ts.isIdentifier(n)) {
    if (seen.has(n.text)) return [];
    const exprs = bindings.get(n.text);
    if (exprs && exprs.length) {
      const nextSeen = new Set([...seen, n.text]);
      const hits = [];
      for (const bound of exprs) {
        hits.push(...scanStyleSourceExpr(file, bound, used, label, defs, aliasUsed, sf, bindings, {
          allowArrayValues, strictOpaque, allowStringCss, seen: nextSeen, pairDecls,
        }));
      }
      return hits;
    }
    if (strictOpaque) return [`${file}: ${label}: opaque style object ${n.text}`];
    return [];
  }
  if (strictOpaque) return [`${file}: ${label}: opaque style expression ${n.getText(sf).trim()}`];
  return [];
}

export function scanAnimateArg(file, argNode, used, defs, aliasUsed, sf, bindings, seen = new Set()) {
  const n = unwrap(argNode);
  if (!n) return [];
  if (ts.isArrayLiteralExpression(n)) {
    const hits = [];
    for (const el of n.elements) {
      if (ts.isSpreadElement(el)) {
        hits.push(...scanAnimateArg(file, el.expression, used, defs, aliasUsed, sf, bindings, seen));
      } else {
        hits.push(...scanStyleSourceExpr(file, el, used, 'animate', defs, aliasUsed, sf, bindings, {
          allowArrayValues: false, strictOpaque: false, seen,
        }));
      }
    }
    return hits;
  }
  if (ts.isObjectLiteralExpression(n)) {
    return scanStyleObjectAst(file, n, used, 'animate', defs, aliasUsed, sf, bindings, {
      allowArrayValues: true, strictOpaque: false, seen,
    });
  }
  if (ts.isConditionalExpression(n)) {
    return [
      ...scanAnimateArg(file, n.whenTrue, used, defs, aliasUsed, sf, bindings, seen),
      ...scanAnimateArg(file, n.whenFalse, used, defs, aliasUsed, sf, bindings, seen),
    ];
  }
  if (ts.isIdentifier(n) && !seen.has(n.text)) {
    const exprs = bindings.get(n.text);
    if (exprs && exprs.length) {
      const nextSeen = new Set([...seen, n.text]);
      const hits = [];
      for (const bound of exprs) hits.push(...scanAnimateArg(file, bound, used, defs, aliasUsed, sf, bindings, nextSeen));
      return hits;
    }
  }
  return [];
}

export function isPureInlineCssArg(node, inlineCssImports) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isIdentifier(n)) return inlineCssImports.has(n.text);
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'default' && ts.isIdentifier(n.expression)) {
    for (let scope = n.parent; scope; scope = scope.parent) {
      if (!ts.isArrowFunction(scope) && !ts.isFunctionExpression(scope)) continue;
      if (scope.parameters[0]?.name.getText() !== n.expression.text) continue;
      const then = scope.parent;
      const load = ts.isCallExpression(then) && ts.isPropertyAccessExpression(then.expression) && then.expression.name.text === 'then' ? then.expression.expression : null;
      return Boolean(load && ts.isCallExpression(load) && load.expression.kind === ts.SyntaxKind.ImportKeyword
        && ts.isStringLiteral(load.arguments[0]) && /\.css\?inline$/.test(load.arguments[0].text));
    }
  }
  if (ts.isTemplateExpression(n)) {
    if (n.head.text.trim()) return false;
    return n.templateSpans.every(span => {
      const expr = unwrap(span.expression);
      return expr && ts.isIdentifier(expr) && inlineCssImports.has(expr.text) && !span.literal.text.trim();
    });
  }
  return false;
}

export function scanStylePropertyValue(file, exprNode, used, defs, aliasUsed, sf, bindings, seen = new Set()) {
  const n = unwrap(exprNode);
  if (!n) return [];
  if (n.kind === ts.SyntaxKind.NullKeyword || n.kind === ts.SyntaxKind.UndefinedKeyword || (ts.isIdentifier(n) && n.text === 'undefined')) return [];
  if (ts.isObjectLiteralExpression(n)) {
    return scanStyleObjectAst(file, n, used, 'style object', defs, aliasUsed, sf, bindings, {
      allowArrayValues: false, strictOpaque: false, seen,
    });
  }
  if (ts.isConditionalExpression(n)) {
    return [
      ...scanStylePropertyValue(file, n.whenTrue, used, defs, aliasUsed, sf, bindings, seen),
      ...scanStylePropertyValue(file, n.whenFalse, used, defs, aliasUsed, sf, bindings, seen),
    ];
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) {
      return scanStylePropertyValue(file, n.right, used, defs, aliasUsed, sf, bindings, seen);
    }
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return [
        ...scanStylePropertyValue(file, n.left, used, defs, aliasUsed, sf, bindings, seen),
        ...scanStylePropertyValue(file, n.right, used, defs, aliasUsed, sf, bindings, seen),
      ];
    }
  }
  if (ts.isIdentifier(n)) {
    if (seen.has(n.text)) return [];
    const exprs = bindings.get(n.text);
    if (exprs && exprs.length) {
      const nextSeen = new Set([...seen, n.text]);
      const hits = [];
      for (const bound of exprs) {
        hits.push(...scanStylePropertyValue(file, bound, used, defs, aliasUsed, sf, bindings, nextSeen));
      }
      return hits;
    }
    return judgeCssTextNode(file, n, used, defs, aliasUsed, 'style property', sf);
  }
  return judgeCssTextNode(file, n, used, defs, aliasUsed, 'style property', sf);
}

// Only infer select receivers from explicit DOM creation/query/type evidence.
// Arbitrary element/class names remain unknown; this does not guess from "select"
// appearing in a variable name. Reuse the CSS author checks for every known write.
export function scanSelectStyleApi(file, sf, bindings) {
  const hits = [];
  const selectTypes = new Set(['HTMLSelectElement']);
  const typed = new Set();
  const destructured = new Map();
  const collect = node => {
    if ((ts.isVariableDeclaration(node) || ts.isParameter(node)) && ts.isIdentifier(node.name) && node.type && /\bHTMLSelectElement\b/.test(node.type.getText(sf))) typed.add(node.name.text);
    if (ts.isVariableDeclaration(node) && ts.isObjectBindingPattern(node.name) && node.initializer) {
      for (const el of node.name.elements) {
        const key = el.propertyName ? staticPropName(el.propertyName) : (ts.isIdentifier(el.name) ? el.name.text : '');
        if ((key === 'style' || key === 'attributeStyleMap') && ts.isIdentifier(el.name)) destructured.set(el.name.text, node.initializer);
      }
    }
    ts.forEachChild(node, collect);
  };
  collect(sf);
  const throughBindings = (node, seen, resolveNode) => {
    if (!ts.isIdentifier(node) || seen.has(node.text)) return '';
    const next = new Set([...seen, node.text]);
    return (bindings.get(node.text) || []).map(bound => resolveNode(bound, next)).filter(Boolean).join(',');
  };
  const elementSelector = (node, seen = new Set()) => {
    if (node && hasCastToType(node, selectTypes)) return 'select';
    const n = unwrap(node);
    if (!n) return '';
    if (ts.isIdentifier(n) && typed.has(n.text)) return 'select';
    if (ts.isConditionalExpression(n)) return [elementSelector(n.whenTrue, seen), elementSelector(n.whenFalse, seen)].filter(Boolean).join(',');
    if (ts.isCallExpression(n)) {
      const target = resolveCallTarget(unwrap(n.expression), bindings);
      if (target && n.arguments[0]) {
        if (target.methods.includes('createElement') && [...resolveStaticStrings(n.arguments[0], bindings).values].some(name => name.toLowerCase() === 'select')) return 'select';
        if (target.methods.some(method => method === 'querySelector' || method === 'closest')) {
          const resolved = resolveStaticStrings(n.arguments[0], bindings);
          const selectors = [...resolved.values].filter(selector => selectSelectorKinds(selector).any).join(',');
          return selectors || (n.typeArguments?.some(type => /\bHTMLSelectElement\b/.test(type.getText(sf))) ? 'select' : '');
        }
      }
    }
    return throughBindings(n, seen, elementSelector);
  };
  const styleSelector = (node, seen = new Set()) => {
    const n = unwrap(node);
    if (!n) return '';
    if (ts.isIdentifier(n) && destructured.has(n.text)) return elementSelector(destructured.get(n.text));
    if (ts.isPropertyAccessExpression(n) && /^(?:style|attributeStyleMap)$/.test(n.name.text)) return elementSelector(n.expression);
    if (ts.isElementAccessExpression(n) && /^(?:style|attributeStyleMap)$/.test(staticString(n.argumentExpression) || '')) return elementSelector(n.expression);
    return throughBindings(n, seen, styleSelector);
  };
  const names = {
    background: 'background', backgroundColor: 'background-color', backgroundImage: 'background-image',
    padding: 'padding', paddingInline: 'padding-inline', paddingInlineEnd: 'padding-inline-end',
    paddingInlineStart: 'padding-inline-start', paddingBlock: 'padding-block',
    paddingTop: 'padding-top', paddingRight: 'padding-right', paddingBottom: 'padding-bottom', paddingLeft: 'padding-left',
    backgroundPosition: 'background-position', backgroundPositionX: 'background-position-x', backgroundPositionY: 'background-position-y',
    backgroundRepeat: 'background-repeat', backgroundSize: 'background-size',
    appearance: 'appearance', webkitAppearance: '-webkit-appearance', WebkitAppearance: '-webkit-appearance',
  };
  const check = (selector, key, valueNode) => {
    if (!selector) return;
    const property = names[key] || key;
    if (property !== 'cssText' && !property.startsWith('--') && !/^(?:background(?:-image|-color|-position(?:-[xy])?|-repeat|-size)?|-webkit-appearance|appearance|padding(?:-[\w-]+)?)$/.test(property)) return;
    const resolved = resolveStaticStrings(valueNode, bindings);
    const values = resolved.complete ? [...resolved.values] : [...resolved.values, '__TS_EXPR__'];
    for (const value of values) {
      if (!value) continue; // Removing an inline property exposes the shared base.
      const list = property === 'cssText' ? declarations(value) : [{ property, value: decodeCssValue(value) }];
      hits.push(...selectRuleProblems(file, selector, list));
    }
  };
  const object = (selector, node, seen = new Set()) => {
    const n = unwrap(node);
    if (!n) return;
    if (ts.isIdentifier(n) && !seen.has(n.text)) {
      for (const bound of bindings.get(n.text) || []) object(selector, bound, new Set([...seen, n.text]));
    } else if (ts.isConditionalExpression(n)) {
      object(selector, n.whenTrue, seen); object(selector, n.whenFalse, seen);
    } else if (ts.isObjectLiteralExpression(n)) {
      for (const prop of n.properties) {
        if (ts.isSpreadAssignment(prop)) object(selector, prop.expression, seen);
        else if (ts.isPropertyAssignment(prop)) {
          const key = staticPropName(prop.name);
          if (key !== null) check(selector, key, prop.initializer);
          else if (ts.isComputedPropertyName(prop.name)) {
            for (const name of resolveStaticStrings(prop.name.expression, bindings).values) check(selector, name, prop.initializer);
          }
        } else if (ts.isShorthandPropertyAssignment(prop)) check(selector, prop.name.text, prop.name);
      }
    }
  };
  const visit = node => {
    if (ts.isBinaryExpression(node) && isStyleAssignOp(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (left && ts.isPropertyAccessExpression(left)) check(styleSelector(left.expression), left.name.text, node.right);
      else if (left && ts.isElementAccessExpression(left)) {
        for (const key of resolveStaticStrings(left.argumentExpression, bindings).values) check(styleSelector(left.expression), key, node.right);
      }
    } else if (ts.isJsxSelfClosingElement(node) || ts.isJsxOpeningElement(node)) {
      if (node.tagName.getText(sf).toLowerCase() === 'select') {
        let selector = 'select';
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr)) continue;
          if (attr.name.getText(sf) === 'multiple' && (!attr.initializer || !ts.isJsxExpression(attr.initializer) || attr.initializer.expression?.kind !== ts.SyntaxKind.FalseKeyword)) selector += '[multiple]';
          if (attr.name.getText(sf) === 'size' && attr.initializer && ts.isStringLiteral(attr.initializer)) selector += attr.initializer.text === '1' ? '[size="1"]' : '[size]:not([size="1"])';
        }
        for (const attr of node.attributes.properties) {
          if (!ts.isJsxAttribute(attr) || attr.name.getText(sf) !== 'style' || !attr.initializer) continue;
          if (ts.isJsxExpression(attr.initializer) && attr.initializer.expression) object(selector, attr.initializer.expression);
          else check(selector, 'cssText', attr.initializer);
        }
      }
    } else if (ts.isCallExpression(node)) {
      const target = resolveCallTarget(unwrap(node.expression), bindings);
      if (target) for (const method of target.methods) {
        const selector = styleSelector(target.recv);
        if (selector && (method === 'setProperty' || method === 'set' || method === 'append') && node.arguments.length >= 2) {
          for (const key of resolveStaticStrings(node.arguments[0], bindings).values) {
            for (const value of method === 'append' ? node.arguments.slice(1) : [node.arguments[1]]) check(selector, key, value);
          }
        } else if (method === 'assign' && ts.isIdentifier(target.recv) && target.recv.text === 'Object') {
          for (const arg of node.arguments.slice(1)) object(styleSelector(node.arguments[0]), arg);
        } else if (method === 'setAttribute' && staticString(node.arguments[0])?.toLowerCase() === 'style' && node.arguments[1]) {
          check(elementSelector(target.recv), 'cssText', node.arguments[1]);
        } else if (method === 'set' && ts.isIdentifier(target.recv) && target.recv.text === 'Reflect' && node.arguments.length >= 3) {
          for (const key of resolveStaticStrings(node.arguments[1], bindings).values) check(styleSelector(node.arguments[0]), key, node.arguments[2]);
        }
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return hits;
}
