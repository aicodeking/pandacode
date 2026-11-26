/**
 * TypeScript AST helpers for the style-API scan: parsing by script kind, unwrapping
 * casts and parentheses, static strings, templates as CSS with __TS_EXPR__ holes,
 * + chains, and the receiver environment. collectStyleEnv grows style and
 * attributeStyleMap aliases through assignments, destructuring, collections, type
 * annotations/aliases, typed returns, local calls and IIFEs; collectBindings and
 * resolveStaticStrings enumerate the static values a const/let binding can hold.
 * Loaded through ts-style.mjs, which re-exports everything here.
 */
import ts from 'typescript';
import { STYLE_PROPS } from './allowlists.mjs';

const KEBAB_TO_JS = Object.fromEntries(Object.entries(STYLE_PROPS).map(([js, css]) => [css, js]));
export const LOCKED_TEMPLATE_PREFIX = /^--(?:type|radius|weight|tracking|leading|row|control|ds-row-h|ds-btn)-/;

function scriptKindFor(file) {
  if (/\.tsx$/i.test(file)) return ts.ScriptKind.TSX;
  if (/\.jsx$/i.test(file)) return ts.ScriptKind.JSX;
  if (/\.(?:mjs|cjs|js)$/i.test(file)) return ts.ScriptKind.JS;
  return ts.ScriptKind.TS;
}

export function parseTs(source, file = 'file.ts') {
  return ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true, scriptKindFor(file));
}

export function unwrap(node) {
  let cur = node;
  while (cur && (
    ts.isParenthesizedExpression(cur)
    || ts.isAsExpression(cur)
    || ts.isNonNullExpression(cur)
    || ts.isSatisfiesExpression(cur)
    || ts.isTypeAssertionExpression(cur)
  )) {
    cur = cur.expression;
  }
  return cur;
}

export function staticString(node) {
  const n = unwrap(node);
  if (!n) return null;
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text;
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = staticString(n.left);
    const right = staticString(n.right);
    if (left !== null && right !== null) return left + right;
  }
  return null;
}

export function staticPropName(name) {
  if (!name) return null;
  if (ts.isIdentifier(name)) return name.text;
  if (ts.isStringLiteral(name) || ts.isNumericLiteral(name)) return name.text;
  if (ts.isComputedPropertyName(name)) return staticString(name.expression);
  return null;
}

function templateExprToCss(node, bindings = null) {
  let out = node.head.text;
  for (const span of node.templateSpans) {
    let sub = '__TS_EXPR__';
    if (bindings) {
      const resolved = resolveStaticStrings(span.expression, bindings);
      if (resolved.complete && resolved.values.size === 1) [sub] = resolved.values;
    }
    out += `${sub}${span.literal.text}`;
  }
  return out;
}

export function exprRhs(node, sf) {
  const n = unwrap(node);
  if (!n) return { kind: 'empty', value: '', text: '' };
  const folded = staticString(n);
  if (folded !== null) {
    return { kind: 'literal', value: folded.trim(), raw: folded, text: n.getText(sf), node: n };
  }
  if (ts.isNumericLiteral(n)) {
    return { kind: 'literal', value: n.text, raw: n.text, text: n.getText(sf), node: n };
  }
  if (
    ts.isPrefixUnaryExpression(n)
    && (n.operator === ts.SyntaxKind.MinusToken || n.operator === ts.SyntaxKind.PlusToken)
    && ts.isNumericLiteral(n.operand)
  ) {
    const val = n.getText(sf).trim();
    return { kind: 'literal', value: val, raw: val, text: val, node: n };
  }
  if (ts.isTemplateExpression(n)) {
    return { kind: 'template', value: templateExprToCss(n), text: n.getText(sf), node: n };
  }
  return { kind: 'expr', value: n.getText(sf).trim(), text: n.getText(sf), node: n };
}

function flattenPlusChain(node, extraNodes, bindings = null) {
  const n = unwrap(node);
  if (!n) return [];
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    return [...flattenPlusChain(n.left, extraNodes, bindings), ...flattenPlusChain(n.right, extraNodes, bindings)];
  }
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) {
    return [{ kind: 'str', text: n.text }];
  }
  if (ts.isTemplateExpression(n)) {
    for (const span of n.templateSpans) extraNodes.push(span.expression);
    return [{ kind: 'str', text: templateExprToCss(n, bindings) }];
  }
  if (bindings) {
    const resolved = resolveStaticStrings(n, bindings);
    if (resolved.complete && resolved.values.size === 1) {
      const [val] = resolved.values;
      return [{ kind: 'str', text: val }];
    }
  }
  extraNodes.push(n);
  return [{ kind: 'expr' }];
}

/** Extract AST strings/templates/concatenations, substituting resolvable bindings or explicit dynamic holes. */
export function tsStrings(source, sf = parseTs(source), bindings = null) {
  const out = [];
  const visit = node => {
    if (ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) return;
    if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
      const extraNodes = [];
      const parts = flattenPlusChain(node, extraNodes, bindings);
      if (parts.some(p => p.kind === 'str')) {
        const start = node.getStart(sf);
        const text = parts.map(p => (p.kind === 'str' ? p.text : '__TS_EXPR__')).join('');
        out.push({ text, before: source.slice(Math.max(0, start - 120), start), node });
        for (const extra of extraNodes) visit(extra);
        return;
      }
    }
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      const start = node.getStart(sf);
      out.push({ text: node.text, before: source.slice(Math.max(0, start - 120), start), node });
      return;
    }
    if (ts.isTemplateExpression(node)) {
      const start = node.getStart(sf);
      out.push({ text: templateExprToCss(node, bindings), before: source.slice(Math.max(0, start - 120), start), node });
      for (const span of node.templateSpans) visit(span.expression);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return out;
}

export function isStyleAssignOp(kind) {
  return kind === ts.SyntaxKind.EqualsToken
    || kind === ts.SyntaxKind.PlusEqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
}

export function isWholeAssignOp(kind) {
  return kind === ts.SyntaxKind.EqualsToken
    || kind === ts.SyntaxKind.BarBarEqualsToken
    || kind === ts.SyntaxKind.QuestionQuestionEqualsToken
    || kind === ts.SyntaxKind.AmpersandAmpersandEqualsToken;
}

function isDirectStyleExpr(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'style') return true;
  if (ts.isElementAccessExpression(n) && staticString(n.argumentExpression) === 'style') return true;
  return false;
}

function isDirectAttrMapExpr(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isPropertyAccessExpression(n) && n.name.text === 'attributeStyleMap') return true;
  if (ts.isElementAccessExpression(n) && staticString(n.argumentExpression) === 'attributeStyleMap') return true;
  return false;
}

function isStyleCollectionExpr(node, env) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isArrayLiteralExpression(n)) {
    return n.elements.some(el => !ts.isOmittedExpression(el) && isStyleExpr(ts.isSpreadElement(el) ? el.expression : el, env));
  }
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.some(prop => (
      (ts.isPropertyAssignment(prop) && isStyleExpr(prop.initializer, env))
      || (ts.isShorthandPropertyAssignment(prop) && isStyleExpr(prop.name, env))
    ));
  }
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'map' && n.arguments.length >= 1) {
      const fn = unwrap(n.arguments[0]);
      if (fn && (ts.isArrowFunction(fn) || ts.isFunctionExpression(fn)) && !ts.isBlock(fn.body)) {
        return isStyleExpr(fn.body, env);
      }
    }
  }
  return false;
}

function isAttrMapCollectionExpr(node, env) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isArrayLiteralExpression(n)) {
    return n.elements.some(el => !ts.isOmittedExpression(el) && isAttrMapExpr(ts.isSpreadElement(el) ? el.expression : el, env));
  }
  if (ts.isObjectLiteralExpression(n)) {
    return n.properties.some(prop => (
      (ts.isPropertyAssignment(prop) && isAttrMapExpr(prop.initializer, env))
      || (ts.isShorthandPropertyAssignment(prop) && isAttrMapExpr(prop.name, env))
    ));
  }
  return false;
}

export function hasCastToType(node, typeNames) {
  let cur = node;
  while (cur) {
    if (ts.isParenthesizedExpression(cur) || ts.isNonNullExpression(cur)) {
      cur = cur.expression;
      continue;
    }
    if (ts.isAsExpression(cur) || ts.isSatisfiesExpression(cur) || ts.isTypeAssertionExpression(cur)) {
      if (typeMentionsName(cur.type, typeNames)) return true;
      cur = cur.expression;
      continue;
    }
    break;
  }
  return false;
}

export function isStyleExpr(node, env) {
  if (env.styleTypeNames && hasCastToType(node, env.styleTypeNames)) return true;
  const n = unwrap(node);
  if (!n) return false;
  if (isDirectStyleExpr(n)) return true;
  if (ts.isIdentifier(n)) return env.aliases.has(n.text);
  if (ts.isPropertyAccessExpression(n) && env.stylePropNames?.has(n.name.text)) return true;
  if (ts.isConditionalExpression(n)) {
    return isStyleExpr(n.whenTrue, env) || isStyleExpr(n.whenFalse, env);
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isStyleExpr(n.right, env);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isStyleExpr(n.left, env) || isStyleExpr(n.right, env);
    }
  }
  if (ts.isElementAccessExpression(n)) {
    const propKey = staticString(n.argumentExpression);
    if (propKey && env.stylePropNames?.has(propKey)) return true;
    const target = unwrap(n.expression);
    if (target && ts.isIdentifier(target)) {
      if (env.styleCollections.has(target.text) || /(?:^|[_-])styles?$|Styles?$/.test(target.text)) return true;
    }
    if (isStyleCollectionExpr(target, env)) return true;
  }
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (callee && ts.isIdentifier(callee) && env.styleReturnFuncs?.has(callee.text)) return true;
    if (callee && ts.isPropertyAccessExpression(callee) && env.styleReturnFuncs?.has(callee.name.text)) return true;
    if (callee && ts.isElementAccessExpression(callee)) {
      const mName = staticString(callee.argumentExpression);
      if (mName && env.styleReturnFuncs?.has(mName)) return true;
    }
    if (callee && ts.isPropertyAccessExpression(callee) && callee.name.text === 'at') {
      const target = unwrap(callee.expression);
      if (target && ts.isIdentifier(target) && (env.styleCollections.has(target.text) || /(?:^|[_-])styles?$|Styles?$/.test(target.text))) {
        return true;
      }
      if (isStyleCollectionExpr(target, env)) return true;
    }
  }
  return false;
}

export function isAttrMapExpr(node, env) {
  if (env.attrMapTypeNames && hasCastToType(node, env.attrMapTypeNames)) return true;
  const n = unwrap(node);
  if (!n) return false;
  if (isDirectAttrMapExpr(n)) return true;
  if (ts.isIdentifier(n)) return env.attrMapAliases.has(n.text);
  if (ts.isPropertyAccessExpression(n) && env.attrMapPropNames?.has(n.name.text)) return true;
  if (ts.isConditionalExpression(n)) {
    return isAttrMapExpr(n.whenTrue, env) || isAttrMapExpr(n.whenFalse, env);
  }
  if (ts.isBinaryExpression(n)) {
    const op = n.operatorToken.kind;
    if (op === ts.SyntaxKind.AmpersandAmpersandToken) return isAttrMapExpr(n.right, env);
    if (op === ts.SyntaxKind.BarBarToken || op === ts.SyntaxKind.QuestionQuestionToken) {
      return isAttrMapExpr(n.left, env) || isAttrMapExpr(n.right, env);
    }
  }
  if (ts.isElementAccessExpression(n)) {
    const propKey = staticString(n.argumentExpression);
    if (propKey && env.attrMapPropNames?.has(propKey)) return true;
    const target = unwrap(n.expression);
    if (target && ts.isIdentifier(target) && env.attrMapCollections.has(target.text)) return true;
    if (isAttrMapCollectionExpr(target, env)) return true;
  }
  if (ts.isCallExpression(n)) {
    const callee = unwrap(n.expression);
    if (callee && ts.isIdentifier(callee) && env.attrMapReturnFuncs?.has(callee.text)) return true;
    if (callee && ts.isPropertyAccessExpression(callee) && env.attrMapReturnFuncs?.has(callee.name.text)) return true;
    if (callee && ts.isElementAccessExpression(callee)) {
      const mName = staticString(callee.argumentExpression);
      if (mName && env.attrMapReturnFuncs?.has(mName)) return true;
    }
  }
  return false;
}

function collectBindingStyleAliases(pattern, aliases, attrMapAliases) {
  if (ts.isObjectBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (el.propertyName) {
        const prop = staticPropName(el.propertyName);
        if (prop === 'style' && ts.isIdentifier(el.name)) aliases.add(el.name.text);
        else if (prop === 'attributeStyleMap' && ts.isIdentifier(el.name)) attrMapAliases.add(el.name.text);
      } else if (ts.isIdentifier(el.name)) {
        if (el.name.text === 'style') aliases.add('style');
        else if (el.name.text === 'attributeStyleMap') attrMapAliases.add('attributeStyleMap');
      }
      if (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name)) {
        collectBindingStyleAliases(el.name, aliases, attrMapAliases);
      }
    }
  } else if (ts.isArrayBindingPattern(pattern)) {
    for (const el of pattern.elements) {
      if (ts.isBindingElement(el) && (ts.isObjectBindingPattern(el.name) || ts.isArrayBindingPattern(el.name))) {
        collectBindingStyleAliases(el.name, aliases, attrMapAliases);
      }
    }
  }
}

const STYLE_TYPE_NAMES = new Set(['CSSStyleDeclaration']);
const ATTR_MAP_TYPE_NAMES = new Set(['StylePropertyMap', 'StylePropertyMapReadOnly']);

function typeMentionsName(typeNode, targetSet) {
  if (!typeNode) return false;
  if (ts.isTypeReferenceNode(typeNode)) {
    const tn = typeNode.typeName;
    const name = ts.isIdentifier(tn) ? tn.text : (ts.isQualifiedName(tn) ? tn.right.text : '');
    if (targetSet.has(name)) return true;
    if (typeNode.typeArguments?.some(arg => typeMentionsName(arg, targetSet))) return true;
  } else if (ts.isUnionTypeNode(typeNode) || ts.isIntersectionTypeNode(typeNode)) {
    return typeNode.types.some(t => typeMentionsName(t, targetSet));
  } else if (ts.isParenthesizedTypeNode(typeNode) || ts.isOptionalTypeNode(typeNode) || ts.isTypeOperatorNode(typeNode)) {
    return typeMentionsName(typeNode.type, targetSet);
  }
  return false;
}

export function collectStyleEnv(sf) {
  const aliases = new Set();
  const attrMapAliases = new Set();
  const styleCollections = new Set();
  const attrMapCollections = new Set();
  const stylePropNames = new Set();
  const attrMapPropNames = new Set();
  const styleReturnFuncs = new Set();
  const attrMapReturnFuncs = new Set();
  const styleTypeNames = new Set(STYLE_TYPE_NAMES);
  const attrMapTypeNames = new Set(ATTR_MAP_TYPE_NAMES);
  const inlineCssImports = new Set();
  const env = {
    aliases, attrMapAliases, styleCollections, attrMapCollections,
    stylePropNames, attrMapPropNames, styleReturnFuncs, attrMapReturnFuncs,
    styleTypeNames, attrMapTypeNames, inlineCssImports,
  };
  const pendingAssigns = [];
  const pendingPropAssigns = [];
  const localFuncs = new Map();
  const pendingCalls = [];
  const pendingIifes = [];
  const typeAliases = [];
  const typedVars = [];
  const typedParams = [];
  const typedProps = [];
  const typedReturnFuncs = [];
  const recordFunc = (name, params) => {
    if (!localFuncs.has(name)) localFuncs.set(name, []);
    localFuncs.get(name).push(params);
  };
  const visit = node => {
    if (ts.isImportDeclaration(node)) {
      const spec = staticString(node.moduleSpecifier);
      if (spec && /\.css\?inline$/i.test(spec) && node.importClause?.name) {
        inlineCssImports.add(node.importClause.name.text);
      }
      return;
    }
    if (ts.isTypeAliasDeclaration(node)) {
      typeAliases.push([node.name.text, node.type]);
    } else if (ts.isInterfaceDeclaration(node) && node.heritageClauses) {
      for (const clause of node.heritageClauses) {
        for (const exprType of clause.types) {
          if (ts.isIdentifier(exprType.expression)) {
            typeAliases.push([node.name.text, ts.factory.createTypeReferenceNode(exprType.expression)]);
          }
        }
      }
    }
    if (ts.isFunctionDeclaration(node) && node.name) {
      recordFunc(node.name.text, node.parameters);
      if (node.type) typedReturnFuncs.push([node.name.text, node.type]);
    } else if (ts.isMethodDeclaration(node) || ts.isMethodSignature(node)) {
      const mName = staticPropName(node.name);
      if (mName) {
        if (ts.isMethodDeclaration(node)) recordFunc(mName, node.parameters);
        if (node.type) typedReturnFuncs.push([mName, node.type]);
      }
    } else if (ts.isPropertyDeclaration(node) || ts.isPropertySignature(node) || ts.isGetAccessorDeclaration(node)) {
      const pName = staticPropName(node.name);
      if (pName) {
        if (node.type) {
          if (ts.isFunctionTypeNode(node.type)) typedReturnFuncs.push([pName, node.type.type]);
          else typedProps.push([pName, node.type]);
        }
        if (ts.isPropertyDeclaration(node) && node.initializer) {
          const init = unwrap(node.initializer);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init)) && init.type) {
            typedReturnFuncs.push([pName, init.type]);
          }
          pendingPropAssigns.push([pName, node.initializer]);
        }
      }
    }
    if (ts.isVariableDeclaration(node)) {
      if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
        collectBindingStyleAliases(node.name, aliases, attrMapAliases);
        if (ts.isArrayBindingPattern(node.name) && node.initializer) {
          const init = unwrap(node.initializer);
          if (init && ts.isArrayLiteralExpression(init)) {
            node.name.elements.forEach((el, idx) => {
              if (ts.isBindingElement(el) && ts.isIdentifier(el.name) && idx < init.elements.length) {
                pendingAssigns.push([el.name.text, init.elements[idx]]);
              }
            });
          }
        }
      } else if (ts.isIdentifier(node.name)) {
        if (node.type) {
          if (ts.isFunctionTypeNode(node.type)) typedReturnFuncs.push([node.name.text, node.type.type]);
          else typedVars.push([node.name.text, node.type]);
        }
        if (node.initializer) {
          const init = unwrap(node.initializer);
          if (init && (ts.isArrowFunction(init) || ts.isFunctionExpression(init))) {
            recordFunc(node.name.text, init.parameters);
            if (init.type) typedReturnFuncs.push([node.name.text, init.type]);
          }
          pendingAssigns.push([node.name.text, node.initializer]);
        }
      }
    } else if (ts.isParameter(node)) {
      if (ts.isObjectBindingPattern(node.name) || ts.isArrayBindingPattern(node.name)) {
        collectBindingStyleAliases(node.name, aliases, attrMapAliases);
      } else if (ts.isIdentifier(node.name) && node.type) {
        const isParamProp = Boolean(node.modifiers?.some(m => (
          m.kind === ts.SyntaxKind.PublicKeyword
          || m.kind === ts.SyntaxKind.PrivateKeyword
          || m.kind === ts.SyntaxKind.ProtectedKeyword
          || m.kind === ts.SyntaxKind.ReadonlyKeyword
        )));
        if (ts.isFunctionTypeNode(node.type)) typedReturnFuncs.push([node.name.text, node.type.type]);
        else typedParams.push([node.name.text, node.type, isParamProp]);
      }
    } else if (ts.isBinaryExpression(node) && isWholeAssignOp(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (left && ts.isIdentifier(left)) {
        pendingAssigns.push([left.text, node.right]);
      } else if (left && ts.isPropertyAccessExpression(left) && left.expression.kind === ts.SyntaxKind.ThisKeyword) {
        pendingPropAssigns.push([left.name.text, node.right]);
      }
    } else if (ts.isCallExpression(node) && node.arguments.length > 0) {
      const callee = unwrap(node.expression);
      if (callee && ts.isIdentifier(callee)) {
        pendingCalls.push({ fnName: callee.text, args: node.arguments });
      } else if (callee && ts.isPropertyAccessExpression(callee) && callee.expression.kind === ts.SyntaxKind.ThisKeyword) {
        pendingCalls.push({ fnName: callee.name.text, args: node.arguments });
      } else if (callee && (ts.isArrowFunction(callee) || ts.isFunctionExpression(callee))) {
        pendingIifes.push({ params: callee.parameters, args: node.arguments });
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  let typesGrew = true;
  while (typesGrew) {
    typesGrew = false;
    for (const [name, typeNode] of typeAliases) {
      if (!styleTypeNames.has(name) && typeMentionsName(typeNode, styleTypeNames)) {
        styleTypeNames.add(name);
        typesGrew = true;
      }
      if (!attrMapTypeNames.has(name) && typeMentionsName(typeNode, attrMapTypeNames)) {
        attrMapTypeNames.add(name);
        typesGrew = true;
      }
    }
  }
  for (const [name, typeNode] of typedVars) {
    if (typeMentionsName(typeNode, styleTypeNames)) aliases.add(name);
    if (typeMentionsName(typeNode, attrMapTypeNames)) attrMapAliases.add(name);
  }
  for (const [name, typeNode, isParamProp] of typedParams) {
    if (typeMentionsName(typeNode, styleTypeNames)) {
      aliases.add(name);
      if (isParamProp) stylePropNames.add(name);
    }
    if (typeMentionsName(typeNode, attrMapTypeNames)) {
      attrMapAliases.add(name);
      if (isParamProp) attrMapPropNames.add(name);
    }
  }
  for (const [name, typeNode] of typedProps) {
    if (typeMentionsName(typeNode, styleTypeNames)) stylePropNames.add(name);
    if (typeMentionsName(typeNode, attrMapTypeNames)) attrMapPropNames.add(name);
  }
  for (const [name, typeNode] of typedReturnFuncs) {
    if (typeMentionsName(typeNode, styleTypeNames)) styleReturnFuncs.add(name);
    if (typeMentionsName(typeNode, attrMapTypeNames)) attrMapReturnFuncs.add(name);
  }
  const propagateParams = (params, args) => {
    let changed = false;
    for (let idx = 0; idx < params.length && idx < args.length; idx++) {
      const param = params[idx];
      if (!ts.isIdentifier(param.name)) continue;
      if (param.dotDotDotToken) {
        for (let k = idx; k < args.length; k++) {
          if (!styleCollections.has(param.name.text) && isStyleExpr(args[k], env)) {
            styleCollections.add(param.name.text);
            changed = true;
          }
          if (!attrMapCollections.has(param.name.text) && isAttrMapExpr(args[k], env)) {
            attrMapCollections.add(param.name.text);
            changed = true;
          }
        }
        break;
      }
      const arg = args[idx];
      if (!aliases.has(param.name.text) && isStyleExpr(arg, env)) {
        aliases.add(param.name.text);
        changed = true;
      }
      if (!attrMapAliases.has(param.name.text) && isAttrMapExpr(arg, env)) {
        attrMapAliases.add(param.name.text);
        changed = true;
      }
      if (!styleCollections.has(param.name.text) && isStyleCollectionExpr(arg, env)) {
        styleCollections.add(param.name.text);
        changed = true;
      }
      if (!attrMapCollections.has(param.name.text) && isAttrMapCollectionExpr(arg, env)) {
        attrMapCollections.add(param.name.text);
        changed = true;
      }
    }
    return changed;
  };
  let grew = true;
  while (grew) {
    grew = false;
    for (const [target, rhs] of pendingAssigns) {
      if (!aliases.has(target) && isStyleExpr(rhs, env)) {
        aliases.add(target);
        grew = true;
      }
      if (!attrMapAliases.has(target) && isAttrMapExpr(rhs, env)) {
        attrMapAliases.add(target);
        grew = true;
      }
      if (!styleCollections.has(target) && isStyleCollectionExpr(rhs, env)) {
        styleCollections.add(target);
        grew = true;
      }
      if (!attrMapCollections.has(target) && isAttrMapCollectionExpr(rhs, env)) {
        attrMapCollections.add(target);
        grew = true;
      }
    }
    for (const [propName, rhs] of pendingPropAssigns) {
      if (!stylePropNames.has(propName) && isStyleExpr(rhs, env)) {
        stylePropNames.add(propName);
        grew = true;
      }
      if (!attrMapPropNames.has(propName) && isAttrMapExpr(rhs, env)) {
        attrMapPropNames.add(propName);
        grew = true;
      }
    }
    for (const { params, args } of pendingIifes) {
      if (propagateParams(params, args)) grew = true;
    }
    for (const { fnName, args } of pendingCalls) {
      const paramLists = localFuncs.get(fnName);
      if (!paramLists) continue;
      for (const params of paramLists) {
        if (propagateParams(params, args)) grew = true;
      }
    }
  }
  return env;
}

export function collectBindings(sf) {
  const map = new Map();
  const add = (name, expr) => {
    if (!map.has(name)) map.set(name, []);
    map.get(name).push(expr);
  };
  const visit = node => {
    if (ts.isVariableDeclaration(node) && ts.isIdentifier(node.name) && node.initializer) {
      add(node.name.text, node.initializer);
    } else if (ts.isBinaryExpression(node) && isWholeAssignOp(node.operatorToken.kind)) {
      const left = unwrap(node.left);
      if (left && ts.isIdentifier(left)) add(left.text, node.right);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return map;
}

export function resolveStaticStrings(node, bindings, seen = new Set()) {
  const n = unwrap(node);
  if (!n) return { values: new Set(), complete: false };
  const s = staticString(n);
  if (s !== null) return { values: new Set([s]), complete: true };
  if (ts.isConditionalExpression(n)) {
    const a = resolveStaticStrings(n.whenTrue, bindings, seen);
    const b = resolveStaticStrings(n.whenFalse, bindings, seen);
    return { values: new Set([...a.values, ...b.values]), complete: a.complete && b.complete };
  }
  if (ts.isIdentifier(n) && bindings && !seen.has(n.text)) {
    const exprs = bindings.get(n.text);
    if (!exprs || !exprs.length) return { values: new Set(), complete: false };
    const nextSeen = new Set([...seen, n.text]);
    const values = new Set();
    let complete = true;
    for (const expr of exprs) {
      const res = resolveStaticStrings(expr, bindings, nextSeen);
      for (const v of res.values) values.add(v);
      if (!res.complete) complete = false;
    }
    return { values, complete };
  }
  return { values: new Set(), complete: false };
}

export function styleKeyToJs(key) {
  if (!key) return '';
  if (key === 'textTransform') return 'textTransform';
  if (key in STYLE_PROPS) return key;
  const lower = key.toLowerCase();
  if (lower === 'text-transform') return 'textTransform';
  if (lower in KEBAB_TO_JS) return KEBAB_TO_JS[lower];
  if (key.startsWith('Webkit')) {
    const webkit = `w${key.slice(1)}`;
    if (webkit in STYLE_PROPS) return webkit;
  }
  return '';
}

export function flattenCommaExpr(node) {
  const n = unwrap(node);
  if (!n) return [];
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.CommaToken) {
    return [...flattenCommaExpr(n.left), ...flattenCommaExpr(n.right)];
  }
  return [n];
}

export function resolveCallTarget(callee, bindings) {
  if (!callee) return null;
  if (ts.isPropertyAccessExpression(callee)) {
    return { recv: unwrap(callee.expression), methods: [callee.name.text] };
  }
  if (ts.isElementAccessExpression(callee)) {
    const resolved = resolveStaticStrings(callee.argumentExpression, bindings);
    if (!resolved.values.size) return null;
    return { recv: unwrap(callee.expression), methods: [...resolved.values] };
  }
  return null;
}

export function isLocationOrHistory(node) {
  const n = unwrap(node);
  if (!n) return false;
  if (ts.isIdentifier(n)) return n.text === 'location' || n.text === 'history';
  if (ts.isPropertyAccessExpression(n)) return n.name.text === 'location' || n.name.text === 'history';
  return false;
}
