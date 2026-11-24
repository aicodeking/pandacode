/**
 * TypeScript-AST style/data-flow scan plus HTML and repository entrypoints.
 * Accepts TS/TSX/JS-family syntax parsed by TypeScript, literal/concatenated CSS,
 * templates with __TS_EXPR__ holes, HTML style attributes/blocks and script/event
 * handlers. CSS syntax and token/clip-path validation delegate to parser.mjs.
 *
 * The scan grows style/attributeStyleMap aliases through assignments, destructuring,
 * collections, type annotations/aliases, typed returns, local calls and IIFEs.
 * Static string bindings and ternaries enumerate possible keys/values; opaque or
 * computed writes are checked conservatively rather than executed. Template holes
 * may survive in untracked values or qualified non-round geometry, not arbitrary
 * property names, literal type sizes or radius rounds. Style objects, Object.assign,
 * JSX, cssText, stylesheet APIs, Reflect.set and animation keyframes are inspected.
 * attributeStyleMap.append checks every appended value, just as set checks its value.
 * Select author checks reuse CSS policy for inline HTML and receivers traced to
 * createElement('select'), explicit select queries or HTMLSelectElement annotations,
 * including local style aliases, setters and Object.assign. Unknown receivers
 * and arbitrary class-only selector names do not establish select identity.
 *
 * Sequential type declarations are grouped by normalized receiver and branch path.
 * if/else Cartesian expansion is capped at 16 paths; the statement-list pass checks
 * overflow branches against its first base path, while nested collection stops
 * expanding combinations beyond the cap. This is bounded static analysis, not a
 * complete control-flow interpreter. Each grouped path still uses pairing.mjs.
 *
 * Repository scans exclude vendor and distinguish preview/mock content via the
 * narrow policies in allowlists.mjs, whose reasons and live usage are tested.
 * Canvas `.font =` strings are checked (only fillText/strokeText/measureText text
 * is skipped); a STYLE_EXEMPT canvas-font entry covers only its named context
 * receivers in its file. SVG font
 * attributes are checked in markup and setAttribute(NS) unless isSerializedSvg
 * proves a standalone image document.
 * The standalone-entrypoint check lives in design-tokens-parity.test.mjs: it follows real
 * runtime imports and CSS imports, then checks root/scoped var() resolution and
 * cycles with explicit runtime-token sets, so another window's CSS cannot mask gaps.
 *
 * Module map: this file holds the entrypoints (scanTsFile, scanStyleApi), literal
 * value checks and statement-level declaration grouping; ts-style-ast.mjs parses
 * and tracks style receivers and static string bindings; ts-style-scan.mjs judges
 * style objects, setters, cssText, animations and select receivers;
 * ts-style-canvas.mjs covers canvas fonts, SVG text attributes, HTML markup and the
 * repository walk (scanRepo). Import from this module: it re-exports the public
 * helpers, and the submodules expect it to load first.
 */
import ts from 'typescript';
import {
  PHYSICAL_RADIUS, RADIUS, CHECKED, ALLOW_NONE, NAME_HINT, DEPRECATED, STYLE_PROPS, STYLE_EXEMPT, MOCK_CONTENT,
  ALIAS_VALUES, aliasNames,
} from './allowlists.mjs';
import {
  scanCss, embeddedChunksDetailed, fontSizeProblems, lineHeightProblems, varProblems, letterProblems,
  familyProblems, radiusProblems, radiusRoleProblems, clipPathProblems, fontParts, soleVar, customLiteral,
  tokenOwner, take, eachVar, noteRowLeading, decodeCssValue, decodeCssEscapes, capsVariantProblems,
  cssWideResetProblems, stretchProblems,
} from './parser.mjs';
import { checkPair } from './pairing.mjs';
import {
  collectBindings, collectStyleEnv, exprRhs, flattenCommaExpr, isAttrMapExpr, isLocationOrHistory,
  isStyleAssignOp, isStyleExpr, isWholeAssignOp, parseTs, resolveCallTarget, resolveStaticStrings,
  staticPropName, staticString, styleKeyToJs, tsStrings, unwrap,
} from './ts-style-ast.mjs';
import {
  canvasFontExempt, canvasFontProblems, canvasLetterProblems, computedKeyIs, inlineSelectProblems, isCanvas,
  isPreview, isSerializedSvg, serializedNames, stripSvgGlyph, svgAttrNodeProblems, svgTextProblems,
} from './ts-style-canvas.mjs';
import {
  dynamicVarProblems, isPureInlineCssArg, judgeCssTextNode, judgeDynamicSetterNode, judgeSetterNode,
  judgeStyleNode, radiusRoleNodeProblems, scanAnimateArg, scanSelectStyleApi, scanStylePropertyValue,
  scanStyleSourceExpr,
} from './ts-style-scan.mjs';

/** Validate a literal style value with the shared CSS property rules and usage tracking. */
export function styleLiteralProblems(property, rawValue, file, used, aliasUsed) {
  if (ALLOW_NONE.has(property)) return [`${property} is not allowed; use the type scale and uppercase tracking rules`];
  const value = decodeCssValue(rawValue);
  const roleHits = radiusRoleProblems(file, '(style)', property, value);
  if (roleHits.length) return roleHits;
  const keywordHits = [...capsVariantProblems(property, value), ...cssWideResetProblems(property, value), ...stretchProblems(property, value)];
  if (keywordHits.length) return keywordHits;
  if (aliasUsed && (CHECKED.has(property) || RADIUS.test(property))) {
    eachVar(value, name => { if (aliasNames.has(name)) aliasUsed.add(name); });
  }
  if (property === 'zoom') {
    const zoom = value.replace(/\s+/g, '');
    if (!/^(?:1|1\.0+|100%)$/.test(zoom)) return [`zoom ${value}`];
    return [];
  }
  if (property === 'font-variation-settings') {
    if (/wght/i.test(value)) return [`font-variation-settings sets wght ${value}`];
    return [];
  }
  if (property === 'font-size') return fontSizeProblems(file, '(style)', value, used);
  if (property === 'font-weight') {
    const problems = [];
    if (/^(?:bold|bolder|lighter)$/.test(value)) problems.push(`font-weight keyword ${value}`);
    else if (!/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(value) && !soleVar(value)) problems.push(`numeric font-weight ${value}`);
    problems.push(...varProblems(file, '(style)', property, value));
    return problems;
  }
  if (property === 'line-height') {
    noteRowLeading(value, used);
    return lineHeightProblems(file, '(style)', value, used);
  }
  if (property === 'letter-spacing') return [...letterProblems(value), ...varProblems(file, '(style)', property, value)];
  if (property === 'font-family') return [...familyProblems(value), ...varProblems(file, '(style)', property, value)];
  if (property === 'font') {
    const parts = fontParts(value);
    const problems = [...familyProblems(parts.family)];
    if (parts.size) problems.push(...fontSizeProblems(file, '(style)', parts.size, used));
    if (parts.lineHeight) {
      noteRowLeading(parts.lineHeight, used);
      problems.push(...lineHeightProblems(file, '(style)', parts.lineHeight, used));
    } else {
      problems.push('font shorthand must include /line-height (omitting it resets line-height to normal)');
    }
    if (parts.weight) {
      if (/^(?:bold|bolder|lighter)$/.test(parts.weight)) problems.push(`font shorthand weight keyword ${parts.weight}`);
      else if (!/^(?:inherit|initial|unset|revert|revert-layer|normal)$/.test(parts.weight) && !soleVar(parts.weight)) {
        problems.push(`numeric font-weight ${parts.weight}`);
      }
    }
    problems.push(...varProblems(file, '(style)', property, value));
    return problems;
  }
  if (property === 'clip-path' || property === '-webkit-clip-path') return clipPathProblems(file, '(style)', value);
  if (RADIUS.test(property)) {
    const problems = [];
    if (PHYSICAL_RADIUS.test(property)) problems.push('use logical border-start-*/border-end-* radius longhand');
    problems.push(...radiusProblems(value, property), ...varProblems(file, '(style)', property, value));
    return problems;
  }
  if (property.startsWith('--')) {
    if (tokenOwner(property)) return [`redefines canonical token ${property}`];
    const listed = ALIAS_VALUES.get(property);
    if (listed) {
      const problems = [];
      if (listed.files && !listed.files.has(file)) problems.push(`${property} may only be defined in ${[...listed.files].join(', ')}`);
      if (!listed.values.has(value.replace(/\s+/g, ''))) problems.push(`${property} is ${value}, not a listed value`);
      return problems;
    }
    return [`${property}: ${customLiteral(value) ? `literal ${value}` : `unapproved custom property alias ${value}`}`];
  }
  return [];
}

/** Decode a setter property name and return its tracked CSS/custom-property kind, or an empty string. */
export function setPropertyKind(name) {
  const decoded = decodeCssEscapes(name);
  const property = decoded.startsWith('--') ? decoded : decoded.toLowerCase();
  if (
    property === 'font-size' || property === 'font-weight' || property === 'font-family'
    || property === 'font' || property === 'line-height' || property === 'letter-spacing'
    || property === 'clip-path' || property === '-webkit-clip-path' || property === 'text-transform'
    || property === 'zoom' || property === 'font-variation-settings' || ALLOW_NONE.has(property)
    || property === 'font-variant' || property === 'font-feature-settings' || property === '-webkit-font-feature-settings' || property === 'all'
    || property === 'font-stretch' || property === 'font-width'
  ) return property;
  if (RADIUS.test(property)) return property;
  if (property.startsWith('--') && (NAME_HINT.test(property) || Boolean(tokenOwner(property)))) return property;
  return '';
}

/** Report deprecated token aliases referenced by a browser spec. */
export function specAliasProblems(file, text) {
  const names = text.match(new RegExp(DEPRECATED.source, 'g'));
  if (!names) return [];
  return [`${file}: deprecated alias ${[...new Set(names)].join(', ')}`];
}

/** Scan one script for style-API writes and embedded CSS, honoring canvas/preview/mock policies. */
export function scanTsFile(file, source, used = new Set(), defs = new Map(), aliasUsed = new Set()) {
  const sf = parseTs(source, file);
  const bindings = collectBindings(sf);
  const problems = isPreview(file) ? [] : scanStyleApi(file, source, used, defs, aliasUsed, sf, bindings);
  const cssProblems = [];
  const names = serializedNames(sf);
  for (const item of tsStrings(source, sf, bindings)) {
    if (isCanvas(item.before)) continue;
    const text = stripSvgGlyph(item.text);
    const serialized = isPreview(file) || isSerializedSvg(item.node, item.text, sf, names);
    cssProblems.push(...svgTextProblems(file, item.text, used, { serialized }));
    cssProblems.push(...inlineSelectProblems(file, text));
    for (const chunk of embeddedChunksDetailed(text)) {
      cssProblems.push(...scanCss(file, chunk.css, used, defs, aliasUsed, { htmlStyle: chunk.htmlStyle }));
    }
  }
  if (cssProblems.length && take(MOCK_CONTENT, used, 'mock', item => item.file === file)) return problems;
  problems.push(...cssProblems);
  return problems;
}

function normalizeStyleReceiver(node, sf, scopeTargets = null) {
  const n = unwrap(node);
  if (!n) return '';
  if (ts.isIdentifier(n) && scopeTargets?.has(n.text)) {
    return scopeTargets.get(n.text);
  }
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'attributeStyleMap') {
    return `${n.expression.getText(sf).replace(/\s+/g, '')}.style`;
  }
  if (ts.isElementAccessExpression(n) && (staticString(n.argumentExpression) === 'style' || staticString(n.argumentExpression) === 'attributeStyleMap')) {
    return `${n.expression.getText(sf).replace(/\s+/g, '')}.style`;
  }
  return n.getText(sf).replace(/\s+/g, '');
}

function recordScopeAliasTargets(stmt, env, scopeTargets, sf) {
  const recordPattern = (pattern, init) => {
    if (!init || !ts.isObjectBindingPattern(pattern)) return;
    const baseText = unwrap(init)?.getText(sf).replace(/\s+/g, '');
    if (!baseText) return;
    for (const el of pattern.elements) {
      const prop = el.propertyName ? staticPropName(el.propertyName) : (ts.isIdentifier(el.name) ? el.name.text : null);
      if ((prop === 'style' || prop === 'attributeStyleMap') && ts.isIdentifier(el.name)) {
        scopeTargets.set(el.name.text, `${baseText}.style`);
      }
    }
  };
  if (ts.isVariableStatement(stmt)) {
    for (const decl of stmt.declarationList.declarations) {
      if (!decl.initializer) continue;
      if (ts.isIdentifier(decl.name)) {
        const init = unwrap(decl.initializer);
        if (isStyleExpr(init, env) || isAttrMapExpr(init, env)) {
          const target = normalizeStyleReceiver(init, sf, scopeTargets);
          if (target) scopeTargets.set(decl.name.text, target);
        }
      } else if (ts.isObjectBindingPattern(decl.name)) {
        recordPattern(decl.name, decl.initializer);
      }
    }
  } else if (ts.isExpressionStatement(stmt)) {
    const expr = unwrap(stmt.expression);
    if (expr && ts.isBinaryExpression(expr) && isWholeAssignOp(expr.operatorToken.kind)) {
      const left = unwrap(expr.left);
      const right = unwrap(expr.right);
      if (left && ts.isIdentifier(left) && (isStyleExpr(right, env) || isAttrMapExpr(right, env))) {
        const target = normalizeStyleReceiver(right, sf, scopeTargets);
        if (target) scopeTargets.set(left.text, target);
      }
    }
  }
}

function extractSingleExprDecl(expr, env, scopeTargets, bindings, sf) {
  const n = unwrap(expr);
  if (!n) return null;
  if (ts.isBinaryExpression(n) && isWholeAssignOp(n.operatorToken.kind)) {
    const left = unwrap(n.left);
    if (left && ts.isPropertyAccessExpression(left) && isStyleExpr(left.expression, env)) {
      const jsKey = styleKeyToJs(left.name.text);
      if (!jsKey) return null;
      const property = jsKey === 'textTransform' ? 'text-transform' : STYLE_PROPS[jsKey];
      if (!CHECKED.has(property) && property !== 'text-transform') return null;
      const parsed = exprRhs(n.right, sf);
      if (parsed.kind !== 'literal' || !parsed.value) return null;
      return {
        node: n,
        receiver: normalizeStyleReceiver(left.expression, sf, scopeTargets),
        decls: [{ property, value: decodeCssValue(parsed.value), important: false }],
      };
    }
    if (left && ts.isElementAccessExpression(left) && isStyleExpr(left.expression, env)) {
      const resolved = resolveStaticStrings(left.argumentExpression, bindings);
      if (!resolved.complete || resolved.values.size !== 1) return null;
      const [key] = resolved.values;
      const jsKey = styleKeyToJs(key);
      if (!jsKey) return null;
      const property = jsKey === 'textTransform' ? 'text-transform' : STYLE_PROPS[jsKey];
      if (!CHECKED.has(property) && property !== 'text-transform') return null;
      const parsed = exprRhs(n.right, sf);
      if (parsed.kind !== 'literal' || !parsed.value) return null;
      return {
        node: n,
        receiver: normalizeStyleReceiver(left.expression, sf, scopeTargets),
        decls: [{ property, value: decodeCssValue(parsed.value), important: false }],
      };
    }
  } else if (ts.isCallExpression(n)) {
    const target = resolveCallTarget(unwrap(n.expression), bindings);
    if (!target || target.methods.length !== 1) return null;
    const method = target.methods[0];
    const recv = target.recv;
    if (method === 'set' && n.arguments.length >= 3 && recv && ts.isIdentifier(recv) && recv.text === 'Reflect' && isStyleExpr(n.arguments[0], env)) {
      const resolved = resolveStaticStrings(n.arguments[1], bindings);
      if (!resolved.complete || resolved.values.size !== 1) return null;
      const [key] = resolved.values;
      const jsKey = styleKeyToJs(key);
      if (!jsKey) return null;
      const property = jsKey === 'textTransform' ? 'text-transform' : STYLE_PROPS[jsKey];
      if (!CHECKED.has(property) && property !== 'text-transform') return null;
      const parsed = exprRhs(n.arguments[2], sf);
      if (parsed.kind !== 'literal' || !parsed.value) return null;
      return {
        node: n,
        receiver: normalizeStyleReceiver(n.arguments[0], sf, scopeTargets),
        decls: [{ property, value: decodeCssValue(parsed.value), important: false }],
      };
    }
    const isSetProp = method === 'setProperty' && n.arguments.length >= 2;
    const isAttrMap = (method === 'set' || method === 'append') && n.arguments.length >= 2 && isAttrMapExpr(recv, env);
    if (isSetProp || isAttrMap) {
      const resolved = resolveStaticStrings(n.arguments[0], bindings);
      if (!resolved.complete || resolved.values.size !== 1) return null;
      const [rawName] = resolved.values;
      const property = setPropertyKind(rawName);
      if (!property || (!CHECKED.has(property) && property !== 'text-transform')) return null;
      const parsed = exprRhs(n.arguments[1], sf);
      if (parsed.kind === 'literal' && parsed.value) {
        return {
          node: n,
          receiver: normalizeStyleReceiver(recv, sf, scopeTargets),
          decls: [{ property, value: decodeCssValue(parsed.value), important: false }],
        };
      }
    }
  }
  return null;
}

function extractSequentialExprDecls(expr, env, scopeTargets, bindings, sf) {
  const entries = [];
  for (const part of flattenCommaExpr(expr)) {
    const entry = extractSingleExprDecl(part, env, scopeTargets, bindings, sf);
    if (entry && entry.receiver) entries.push(entry);
  }
  return entries;
}

function collectBranchEntries(stmt, env, parentTargets, bindings, sf) {
  const localTargets = new Map(parentTargets);
  const paths = [[]];
  const appendEntries = (entries) => {
    for (const p of paths) p.push(...entries);
  };
  const processStmt = (s) => {
    recordScopeAliasTargets(s, env, localTargets, sf);
    if (ts.isExpressionStatement(s)) {
      appendEntries(extractSequentialExprDecls(s.expression, env, localTargets, bindings, sf));
    } else if (ts.isBlock(s)) {
      const blockTargets = new Map(localTargets);
      for (const inner of s.statements) {
        recordScopeAliasTargets(inner, env, blockTargets, sf);
        if (ts.isExpressionStatement(inner)) {
          appendEntries(extractSequentialExprDecls(inner.expression, env, blockTargets, bindings, sf));
        } else if (ts.isIfStatement(inner)) {
          const thenPaths = collectBranchEntries(inner.thenStatement, env, blockTargets, bindings, sf);
          const elsePaths = inner.elseStatement
            ? collectBranchEntries(inner.elseStatement, env, blockTargets, bindings, sf)
            : [[]];
          const branches = [...thenPaths, ...elsePaths].filter(b => b.length);
          if (branches.length && paths.length * (branches.length + (inner.elseStatement ? 0 : 1)) <= 16) {
            const next = [];
            for (const base of paths) {
              for (const b of thenPaths) next.push([...base, ...b]);
              for (const b of elsePaths) next.push([...base, ...b]);
            }
            paths.length = 0;
            paths.push(...next);
          }
        }
      }
    } else if (ts.isIfStatement(s)) {
      const thenPaths = collectBranchEntries(s.thenStatement, env, localTargets, bindings, sf);
      const elsePaths = s.elseStatement
        ? collectBranchEntries(s.elseStatement, env, localTargets, bindings, sf)
        : [[]];
      if (paths.length * (thenPaths.length + elsePaths.length) <= 16) {
        const next = [];
        for (const base of paths) {
          for (const b of thenPaths) next.push([...base, ...b]);
          for (const b of elsePaths) next.push([...base, ...b]);
        }
        paths.length = 0;
        paths.push(...next);
      }
    }
  };
  processStmt(stmt);
  return paths;
}

/** Scan AST style writes with alias tracking, bounded branch pairing and conservative dynamic-value checks. */
export function scanStyleApi(file, source, used, defs = new Map(), aliasUsed = new Set(), sf = parseTs(source, file), bindings = collectBindings(sf)) {
  const problems = scanSelectStyleApi(file, sf, bindings);
  const env = collectStyleEnv(sf);
  const groupedPairNodes = new Set();
  const checkedCommaNodes = new Set();
  const checkedIfBlocks = new Set();
  let xtermUsed = false;

  const checkStatementList = (statements, parentTargets) => {
    const scopeTargets = new Map(parentTargets);
    let paths = [[]];
    const extraBranchPaths = [];
    for (const stmt of statements) {
      recordScopeAliasTargets(stmt, env, scopeTargets, sf);
      if (ts.isExpressionStatement(stmt)) {
        const entries = extractSequentialExprDecls(stmt.expression, env, scopeTargets, bindings, sf);
        if (entries.length) {
          if (ts.isBinaryExpression(unwrap(stmt.expression)) && unwrap(stmt.expression).operatorToken.kind === ts.SyntaxKind.CommaToken) {
            checkedCommaNodes.add(unwrap(stmt.expression));
          }
          for (const e of entries) groupedPairNodes.add(e.node);
          for (const p of paths) p.push(...entries);
        }
      } else if (ts.isIfStatement(stmt)) {
        const thenPaths = collectBranchEntries(stmt.thenStatement, env, scopeTargets, bindings, sf);
        const elsePaths = stmt.elseStatement
          ? collectBranchEntries(stmt.elseStatement, env, scopeTargets, bindings, sf)
          : [[]];
        const hasAny = thenPaths.some(p => p.length) || elsePaths.some(p => p.length);
        if (!hasAny) continue;
        checkedIfBlocks.add(stmt.thenStatement);
        if (stmt.elseStatement) checkedIfBlocks.add(stmt.elseStatement);
        for (const p of [...thenPaths, ...elsePaths]) {
          for (const e of p) groupedPairNodes.add(e.node);
        }
        const totalBranches = thenPaths.length + elsePaths.length;
        if (paths.length * totalBranches <= 16) {
          const next = [];
          for (const base of paths) {
            for (const b of thenPaths) next.push([...base, ...b]);
            for (const b of elsePaths) next.push([...base, ...b]);
          }
          paths = next;
        } else {
          extraBranchPaths.push(...thenPaths, ...elsePaths);
        }
      }
    }
    const reported = new Set();
    const runPath = (entries) => {
      const groups = new Map();
      for (const entry of entries) {
        if (!groups.has(entry.receiver)) groups.set(entry.receiver, []);
        groups.get(entry.receiver).push(...entry.decls);
      }
      for (const decls of groups.values()) {
        if (!decls.length) continue;
        const local = [];
        checkPair('(style)', decls, local, `${file}: style`, file, used);
        for (const hit of local) {
          if (!reported.has(hit)) {
            reported.add(hit);
            problems.push(hit);
          }
        }
      }
    };
    for (const p of paths) runPath(p);
    if (extraBranchPaths.length) {
      const base = paths[0] || [];
      for (const b of extraBranchPaths) runPath([...base, ...b]);
    }
    return scopeTargets;
  };

  const checkComputedStyleKey = (keyExpr, valExpr, label, node, runPair) => {
    const resolved = resolveStaticStrings(keyExpr, bindings);
    if (resolved.values.size > 0 && resolved.complete) {
      for (const key of resolved.values) {
        if (key === 'cssText') {
          problems.push(...judgeCssTextNode(file, valExpr, used, defs, aliasUsed, `${label}.cssText`, sf));
        } else {
          const jsKey = styleKeyToJs(key);
          if (jsKey) problems.push(...judgeStyleNode(file, jsKey, valExpr, used, label, sf, aliasUsed, runPair));
          else problems.push(...radiusRoleNodeProblems(file, key, valExpr, sf, bindings));
        }
      }
    } else {
      for (const key of resolved.values) {
        if (key === 'cssText') {
          problems.push(...judgeCssTextNode(file, valExpr, used, defs, aliasUsed, `${label}.cssText`, sf));
        } else {
          const jsKey = styleKeyToJs(key);
          if (jsKey) problems.push(...judgeStyleNode(file, jsKey, valExpr, used, label, sf, aliasUsed, true));
          else problems.push(...radiusRoleNodeProblems(file, key, valExpr, sf, bindings));
        }
      }
      const parsed = exprRhs(valExpr, sf);
      const keyText = keyExpr.getText(sf).trim();
      if (parsed.kind === 'literal' && !parsed.value) {
        // Empty string resets an inline style property.
      } else if (parsed.kind === 'literal' && soleVar(decodeCssValue(parsed.value))) {
        problems.push(...dynamicVarProblems(file, `${label}[${keyText}]`, parsed.value, aliasUsed));
      } else {
        const shown = parsed.kind === 'literal' ? parsed.value : (parsed.value || '(empty)');
        problems.push(`${file}: ${label}[${keyText}] = ${shown}: right-hand side is not a var() token`);
      }
    }
    void node;
  };

  const visit = (node, parentTargets) => {
    let nextTargets = parentTargets;
    if (
      ts.isBlock(node) || ts.isSourceFile(node) || ts.isCaseClause(node)
      || ts.isDefaultClause(node) || ts.isModuleBlock(node)
    ) {
      if (!checkedIfBlocks.has(node)) {
        nextTargets = checkStatementList(node.statements, parentTargets);
      } else {
        nextTargets = new Map(parentTargets);
        for (const stmt of node.statements) recordScopeAliasTargets(stmt, env, nextTargets, sf);
      }
    }
    if (
      ts.isBinaryExpression(node)
      && node.operatorToken.kind === ts.SyntaxKind.CommaToken
      && !checkedCommaNodes.has(node)
    ) {
      const entries = extractSequentialExprDecls(node, env, nextTargets, bindings, sf);
      if (entries.length > 1) {
        const groups = new Map();
        for (const e of entries) {
          groupedPairNodes.add(e.node);
          if (!groups.has(e.receiver)) groups.set(e.receiver, []);
          groups.get(e.receiver).push(...e.decls);
        }
        for (const decls of groups.values()) {
          if (decls.length) checkPair('(style)', decls, problems, `${file}: style`, file, used);
        }
      }
    }
    if (ts.isNewExpression(node)) {
      const callee = unwrap(node.expression);
      if (callee && ts.isIdentifier(callee) && callee.text === 'Terminal') xtermUsed = true;
    } else if (ts.isBinaryExpression(node) && isStyleAssignOp(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (isWholeAssignOp(node.operatorToken.kind) && left && ts.isPropertyAccessExpression(left)) {
        const inner = unwrap(left.expression);
        if (left.name.text === 'fontSize' && inner && ts.isPropertyAccessExpression(inner) && inner.name.text === 'options') {
          xtermUsed = true;
        }
      }
      const canvasMember = prop => left
        && ((ts.isPropertyAccessExpression(left) && left.name.text === prop) || (ts.isElementAccessExpression(left) && computedKeyIs(left.argumentExpression, prop, bindings)))
        && !isStyleExpr(left.expression, env);
      if (canvasMember('font')) {
        if (node.operatorToken.kind === ts.SyntaxKind.PlusEqualsToken) {
          if (!canvasFontExempt(file, unwrap(left.expression)?.getText(sf) || '', used)) {
            problems.push(`${file}: canvas font += ${node.right.getText(sf)}: canvas fonts cannot be extended in place; copy getComputedStyle(element).font instead`);
          }
        } else if (isWholeAssignOp(node.operatorToken.kind)) {
          problems.push(...canvasFontProblems(file, node.right, used, sf, bindings, unwrap(left.expression)?.getText(sf) || ''));
        }
      }
      if (canvasMember('letterSpacing')) problems.push(...canvasLetterProblems(file, node.right, bindings));
      if (left && ts.isPropertyAccessExpression(left) && isStyleExpr(left.expression, env)) {
        const key = left.name.text;
        if (key === 'cssText') {
          problems.push(...judgeCssTextNode(file, node.right, used, defs, aliasUsed, 'style.cssText', sf));
        } else {
          const jsKey = styleKeyToJs(key);
          if (jsKey) problems.push(...judgeStyleNode(file, jsKey, node.right, used, 'style', sf, aliasUsed, !groupedPairNodes.has(node)));
          else problems.push(...radiusRoleNodeProblems(file, key, node.right, sf, bindings));
        }
      } else if (left && ts.isElementAccessExpression(left) && isStyleExpr(left.expression, env)) {
        checkComputedStyleKey(left.argumentExpression, node.right, 'style', node, !groupedPairNodes.has(node));
      }
    } else if (ts.isCallExpression(node)) {
      const target = resolveCallTarget(unwrap(node.expression), bindings);
      if (target) {
        const recv = target.recv;
        for (const method of target.methods) {
          if (method === 'setAttribute' && node.arguments.length >= 2) {
            const resolved = resolveStaticStrings(node.arguments[0], bindings);
            if ([...resolved.values].some(attr => attr.toLowerCase() === 'style')) {
              problems.push(...judgeCssTextNode(file, node.arguments[1], used, defs, aliasUsed, "setAttribute('style')", sf));
            }
            problems.push(...svgAttrNodeProblems(file, resolved, node.arguments[1], used, sf, bindings, 'setAttribute'));
          } else if (method === 'setAttributeNS' && node.arguments.length >= 3) {
            const resolved = resolveStaticStrings(node.arguments[1], bindings);
            if ([...resolved.values].some(attr => attr.toLowerCase() === 'style')) {
              problems.push(...judgeCssTextNode(file, node.arguments[2], used, defs, aliasUsed, "setAttributeNS('style')", sf));
            }
            problems.push(...svgAttrNodeProblems(file, resolved, node.arguments[2], used, sf, bindings, 'setAttributeNS'));
          } else if (
            (method === 'replaceSync' && node.arguments.length >= 1)
            || (method === 'replace' && node.arguments.length === 1 && !isLocationOrHistory(recv))
            || (method === 'insertRule' && node.arguments.length >= 1)
          ) {
            if (!isPureInlineCssArg(node.arguments[0], env.inlineCssImports)) {
              problems.push(...judgeCssTextNode(file, node.arguments[0], used, defs, aliasUsed, method, sf));
            }
          } else if (
            method === 'set'
            && node.arguments.length >= 3
            && recv
            && ts.isIdentifier(recv)
            && recv.text === 'Reflect'
            && isStyleExpr(node.arguments[0], env)
          ) {
            checkComputedStyleKey(node.arguments[1], node.arguments[2], 'Reflect.set(style)', node, !groupedPairNodes.has(node));
          } else if (
            (method === 'setProperty' && node.arguments.length >= 2)
            || ((method === 'set' || method === 'append') && node.arguments.length >= 2 && isAttrMapExpr(recv, env))
          ) {
            const label = method === 'setProperty' ? 'setProperty' : `attributeStyleMap.${method}`;
            const propArg = node.arguments[0];
            const valArgs = method === 'append' ? node.arguments.slice(1) : [node.arguments[1]];
            const resolved = resolveStaticStrings(propArg, bindings);
            if (resolved.values.size > 0) {
              for (const name of resolved.values) {
                const property = setPropertyKind(name);
                if (property) {
                  for (const valArg of valArgs) {
                    problems.push(...judgeSetterNode(file, property, name, valArg, used, label, sf, aliasUsed, bindings, !groupedPairNodes.has(node)));
                  }
                } else {
                  for (const valArg of valArgs) problems.push(...radiusRoleNodeProblems(file, name, valArg, sf, bindings));
                }
              }
            }
            if (!resolved.complete) {
              for (const valArg of valArgs) {
                problems.push(...judgeDynamicSetterNode(file, propArg, valArg, label, sf, bindings, used, aliasUsed));
              }
            }
          } else if (method === 'assign' && node.arguments.length >= 2) {
            if (recv && ts.isIdentifier(recv) && recv.text === 'Object' && !isStyleExpr(node.arguments[0], env)) {
              // Object.assign(ctx, { font, letterSpacing }) is a canvas write by another name.
              for (const srcArg of node.arguments.slice(1)) {
                const literal = unwrap(srcArg);
                if (!literal || !ts.isObjectLiteralExpression(literal)) continue;
                for (const prop of literal.properties) {
                  const name = ts.isPropertyAssignment(prop) ? staticPropName(prop.name) : ts.isShorthandPropertyAssignment(prop) ? prop.name.text : null;
                  const value = ts.isPropertyAssignment(prop) ? prop.initializer : ts.isShorthandPropertyAssignment(prop) ? prop.name : null;
                  if (name === 'font') problems.push(...canvasFontProblems(file, value, used, sf, bindings, unwrap(node.arguments[0])?.getText(sf) || ''));
                  else if (name === 'letterSpacing') problems.push(...canvasLetterProblems(file, value, bindings));
                }
              }
            }
            if (recv && ts.isIdentifier(recv) && recv.text === 'Object' && isStyleExpr(node.arguments[0], env)) {
              const sharedPairDecls = [];
              for (const srcArg of node.arguments.slice(1)) {
                problems.push(...scanStyleSourceExpr(file, srcArg, used, 'Object.assign(style,', defs, aliasUsed, sf, bindings, {
                  allowArrayValues: false, strictOpaque: true, pairDecls: sharedPairDecls,
                }));
              }
              if (sharedPairDecls.length) {
                checkPair('(style)', sharedPairDecls, problems, `${file}: Object.assign(style,`, file, used);
              }
            }
          } else if (method === 'animate' && node.arguments.length >= 1) {
            problems.push(...scanAnimateArg(file, node.arguments[0], used, defs, aliasUsed, sf, bindings));
          }
        }
      }
    } else if (ts.isPropertyAssignment(node) && staticPropName(node.name) === 'style') {
      problems.push(...scanStylePropertyValue(file, node.initializer, used, defs, aliasUsed, sf, bindings));
    } else if (ts.isShorthandPropertyAssignment(node) && node.name.text === 'style') {
      problems.push(...scanStylePropertyValue(file, node.name, used, defs, aliasUsed, sf, bindings));
    } else if (ts.isJsxAttribute(node) && node.name.getText(sf) === 'style' && node.initializer) {
      if (ts.isJsxExpression(node.initializer) && node.initializer.expression) {
        problems.push(...scanStyleSourceExpr(file, node.initializer.expression, used, 'JSX style', defs, aliasUsed, sf, bindings, {
          allowArrayValues: false, strictOpaque: true, allowStringCss: true,
        }));
      }
    }
    ts.forEachChild(node, child => visit(child, nextTargets));
  };

  visit(sf, new Map());

  if (xtermUsed && !take(STYLE_EXEMPT, used, 'style', item => item.file === file && item.api === 'xterm')) {
    problems.push(`${file}: numeric fontSize API is only the xterm option in src/terminal.ts`);
  }

  return problems;
}

export * from './ts-style-ast.mjs';
export * from './ts-style-canvas.mjs';
export * from './ts-style-scan.mjs';
