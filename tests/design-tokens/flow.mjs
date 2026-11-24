/**
 * Prove the shared base sheets (src/type-base.css, then src/shadow-base.css) reach every
 * Shadow DOM root built by src/generative-ui.ts, src/rich-markdown.ts and the custom views in
 * src/generative-ui-components.ts.
 *
 * Identifiers are resolved through lexical scopes, so a local `const typeBase = ''` (or a
 * parameter, `let` or `var` of the same name) shadowing the import never counts as the sheet.
 * Coverage is universal: every attachShadow root, every constructed-sheet write, every
 * adoptedStyleSheets assignment and every renderBlock call is checked, not just one of them.
 * CSS flow is proven only through string concatenation and templates; calls, arrays,
 * conditionals and property reads are barriers. This is a static guard for these files,
 * not a general data-flow analysis.
 *
 * The inventory (shadowInventoryProblems) scans every .ts/.js/.mjs file under src/ for
 * attachShadow, flow-verified files included, and rejects declarative `shadowrootmode=` roots
 * in script literals and in HTML (src/ and the root *.html windows). Each call is attributed to its exact enclosing
 * scope path (named classes, functions, methods and const-bound functions joined with `.`,
 * anonymous functions as `<anonymous>`), and every path must match exactly one entry in
 * SHADOW_ROOT_VERIFIED (the root a flow check proves) or SHADOW_ROOT_EXEMPT (with a reason)
 * with the same call count. A new root, a duplicate nested function of an exempt name, or a
 * second call in an accounted scope fails; so do unused entries.
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { root, SCRIPT_EXTS } from './allowlists.mjs';
import { walk } from './parser.mjs';
import { evalConstString, foldedStrings } from './ts-fold.mjs';

export const TYPE_BASE = './type-base.css?inline';
export const SHADOW_BASE = './shadow-base.css?inline';
const KATEX_CSS = 'katex/dist/katex.min.css?inline';

/** Files whose every Shadow DOM root is proven to adopt the shared base sheets below. */
export const FLOW_VERIFIED = ['src/generative-ui.ts', 'src/generative-ui-components.ts', 'src/rich-markdown.ts'];

/** The flow-verified roots: exact scope path and attachShadow() call count each flow check proves. */
export const SHADOW_ROOT_VERIFIED = [
  { file: 'src/generative-ui.ts', owner: 'GenerativeView.draw', count: 1, check: 'generativeShadowProblems: adopts generativeSheet() on every write' },
  { file: 'src/rich-markdown.ts', owner: 'block.<anonymous>', count: 1, check: 'richShadowProblems: appends a style starting with type-base then shadow-base' },
  { file: 'src/generative-ui-components.ts', owner: 'custom', count: 1, check: 'componentSheetFlow: appends the forwarded base CSS before its own style' },
];

/** Shadow roots that intentionally skip the shared base sheets: exact scope path and call count. */
export const SHADOW_ROOT_EXEMPT = [
  { file: 'src/generative-ui.ts', owner: 'CodeBlock.connectedCallback', count: 1, reason: 'The code copy button root holds only a slot and an icon-only button; the code text stays in the light DOM under app styles.' },
  { file: 'src/motion.ts', owner: 'stage', count: 1, reason: 'The closed dialog exit ghost clones already-styled DOM and mirrors the page\'s own stylesheets into its root.' },
  { file: 'src/office-viewer.ts', owner: 'renderDocx', count: 1, reason: 'The docx-preview sandbox renders a Word file with the document\'s own CSS, isolated from the app.' },
];

const SCOPE_KINDS = new Set([
  ts.SyntaxKind.SourceFile, ts.SyntaxKind.Block, ts.SyntaxKind.ModuleBlock, ts.SyntaxKind.CaseBlock,
  ts.SyntaxKind.ForStatement, ts.SyntaxKind.ForInStatement, ts.SyntaxKind.ForOfStatement, ts.SyntaxKind.CatchClause,
]);
const isFunctionLike = node => ts.isFunctionDeclaration(node) || ts.isFunctionExpression(node) || ts.isArrowFunction(node)
  || ts.isMethodDeclaration(node) || ts.isConstructorDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node);
const isScope = node => SCOPE_KINDS.has(node.kind) || isFunctionLike(node) || ts.isClassLike(node);

function blockScope(node) {
  for (let cur = node.parent; cur; cur = cur.parent) if (isScope(cur)) return cur;
  return node.getSourceFile();
}
function functionScope(node) {
  for (let cur = node.parent; cur; cur = cur.parent) if (isFunctionLike(cur) || ts.isSourceFile(cur)) return cur;
  return node.getSourceFile();
}
function bindingNames(name, out = []) {
  if (ts.isIdentifier(name)) out.push(name);
  else if (ts.isObjectBindingPattern(name) || ts.isArrayBindingPattern(name)) {
    for (const element of name.elements) if (!ts.isOmittedExpression(element)) bindingNames(element.name, out);
  }
  return out;
}

/** Parse once and index every declaration by its lexical scope. */
export function flowAst(file, source) {
  const sf = ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true);
  const calls = [], assigns = [], functions = new Map(), identifiers = [], decls = new Map();
  const declare = (scope, nameNode, info) => {
    const key = `${scope.pos}:${scope.end}:${scope.kind}`;
    if (!decls.has(key)) decls.set(key, new Map());
    const names = decls.get(key);
    if (!names.has(nameNode.text)) names.set(nameNode.text, { ...info, nameNode });
  };
  const visit = node => {
    if (ts.isCallExpression(node)) calls.push(node);
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) assigns.push(node);
    if (ts.isIdentifier(node)) identifiers.push(node);
    if (ts.isFunctionDeclaration(node) && node.name) {
      functions.set(node.name.text, node);
      declare(blockScope(node), node.name, { kind: 'function', node });
    }
    if (ts.isClassDeclaration(node) && node.name) declare(blockScope(node), node.name, { kind: 'class', node });
    if (ts.isVariableDeclaration(node)) {
      const list = node.parent;
      const flags = ts.isVariableDeclarationList(list) ? list.flags : 0;
      const kind = flags & ts.NodeFlags.Const ? 'const' : flags & (ts.NodeFlags.Let | ts.NodeFlags.Using) ? 'let' : 'var';
      const scope = kind === 'var' ? functionScope(node) : blockScope(list.parent && ts.isVariableStatement(list.parent) ? list.parent : list);
      for (const name of bindingNames(node.name)) declare(scope, name, { kind, node, init: ts.isIdentifier(node.name) ? node.initializer : undefined });
    }
    if (ts.isParameter(node)) for (const name of bindingNames(node.name)) declare(node.parent, name, { kind: 'param', node });
    if (ts.isCatchClause(node) && node.variableDeclaration) for (const name of bindingNames(node.variableDeclaration.name)) declare(node, name, { kind: 'param', node });
    if (ts.isImportDeclaration(node) && ts.isStringLiteral(node.moduleSpecifier) && node.importClause && !node.importClause.isTypeOnly) {
      const spec = node.moduleSpecifier.text;
      if (node.importClause.name) declare(sf, node.importClause.name, { kind: 'import', spec, imported: 'default' });
      const named = node.importClause.namedBindings;
      if (named && ts.isNamedImports(named)) {
        for (const element of named.elements) if (!element.isTypeOnly) declare(sf, element.name, { kind: 'import', spec, imported: (element.propertyName || element.name).text });
      } else if (named && ts.isNamespaceImport(named)) declare(sf, named.name, { kind: 'import', spec, imported: '*' });
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return { sf, calls, assigns, functions, identifiers, decls };
}

/** Resolve an identifier to its nearest lexical declaration (or null for globals). */
export function resolve(ast, id) {
  for (let scope = id.parent; scope; scope = scope.parent) {
    if (!isScope(scope)) continue;
    const found = ast.decls.get(`${scope.pos}:${scope.end}:${scope.kind}`)?.get(id.text);
    if (found) return found;
  }
  return null;
}

const sameDecl = (a, b) => Boolean(a && b) && a.nameNode === b.nameNode;
const isDefaultImport = (info, spec) => info?.kind === 'import' && info.spec === spec && info.imported === 'default';
export const calleeName = node => {
  const callee = node.expression;
  return ts.isIdentifier(callee) ? callee.text : ts.isPropertyAccessExpression(callee) ? callee.name.text : '';
};
const unwrap = node => {
  let cur = node;
  while (cur && (ts.isParenthesizedExpression(cur) || ts.isAsExpression(cur) || ts.isNonNullExpression(cur) || ts.isSatisfiesExpression?.(cur))) cur = cur.expression;
  return cur;
};
const within = (node, fn) => Boolean(fn) && node.pos >= fn.pos && node.end <= fn.end;

const UNKNOWN = Symbol('unknown CSS operand');
/**
 * Flatten string concatenation into operands: default imports become their module
 * specifier; immutable local consts are followed; anything else is UNKNOWN. Whitespace-only
 * literal pieces vanish, so `${typeBase}\n${shadowBase}` reads as [type, shadow].
 */
export function cssOperands(ast, node, seen = new Set()) {
  const n = unwrap(node);
  if (!n) return [UNKNOWN];
  if (ts.isIdentifier(n)) {
    const info = resolve(ast, n);
    if (info?.kind === 'import' && info.imported === 'default') return [info.spec];
    if (info?.kind !== 'const' || !info.init || seen.has(info.init)) return [UNKNOWN];
    return cssOperands(ast, info.init, new Set([...seen, info.init]));
  }
  if (ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...cssOperands(ast, n.left, seen), ...cssOperands(ast, n.right, seen)];
  if (ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) return n.text.trim() ? [n] : [];
  if (ts.isTemplateExpression(n)) return [
    ...(n.head.text.trim() ? [UNKNOWN] : []),
    ...n.templateSpans.flatMap(span => [...cssOperands(ast, span.expression, seen), ...(span.literal.text.trim() ? [UNKNOWN] : [])]),
  ];
  return [UNKNOWN];
}
/** True when the CSS expression starts with exactly the required module specifiers, in order. */
export const startsWithCss = (ast, node, required) => required.every(Boolean)
  && required.every((spec, i) => cssOperands(ast, node)[i] === spec);

/** The declaration an attachShadow() result is bound to, through `a ?? attachShadow()` and parentheses. */
function shadowRootDecl(ast, call) {
  let cur = call;
  while (cur.parent && (ts.isParenthesizedExpression(cur.parent) || ts.isAsExpression(cur.parent) || ts.isNonNullExpression(cur.parent)
    || (ts.isBinaryExpression(cur.parent) && [ts.SyntaxKind.QuestionQuestionToken, ts.SyntaxKind.BarBarToken].includes(cur.parent.operatorToken.kind)))) cur = cur.parent;
  const decl = cur.parent;
  if (decl && ts.isVariableDeclaration(decl) && decl.initializer === cur && ts.isIdentifier(decl.name)) {
    const info = resolve(ast, decl.name);
    return info?.kind === 'const' ? info : null;
  }
  return null;
}
const refersTo = (ast, node, info) => {
  const n = unwrap(node);
  return Boolean(n) && ts.isIdentifier(n) && sameDecl(resolve(ast, n), info);
};
/** References to a declaration (excluding the declaring name itself). */
const referencesOf = (ast, info) => ast.identifiers.filter(id => id !== info.nameNode && sameDecl(resolve(ast, id), info));

/** Is `node` a call of the module's own generativeSheet() (not a shadowing local)? */
function isGenerativeSheetCall(ast, node, sheetFn) {
  const n = unwrap(node);
  if (!n || !ts.isCallExpression(n) || !ts.isIdentifier(n.expression) || n.expression.text !== 'generativeSheet') return false;
  const info = resolve(ast, n.expression);
  return info?.kind === 'function' && info.node === sheetFn;
}
/** A KaTeX sheet operand: a const awaited from loadKatexSheet(). */
function isKatexSheet(ast, node) {
  const n = unwrap(node);
  if (!n || !ts.isIdentifier(n)) return false;
  const info = resolve(ast, n);
  let init = unwrap(info?.kind === 'const' ? info.init : null);
  if (init && ts.isAwaitExpression(init)) init = unwrap(init.expression);
  return Boolean(init) && ts.isCallExpression(init) && ts.isIdentifier(init.expression) && init.expression.text === 'loadKatexSheet'
    && resolve(ast, init.expression)?.kind === 'function';
}
/** `mod.default` inside `import('katex/...css?inline').then(mod => ...)`. */
function isKatexModuleDefault(node) {
  const n = unwrap(node);
  if (!n || !ts.isPropertyAccessExpression(n) || n.name.text !== 'default' || !ts.isIdentifier(n.expression)) return false;
  for (let fn = n.parent; fn; fn = fn.parent) {
    if (!isFunctionLike(fn)) continue;
    const param = fn.parameters?.[0];
    if (!param || !ts.isIdentifier(param.name) || param.name.text !== n.expression.text) return false;
    const then = fn.parent;
    if (!then || !ts.isCallExpression(then) || !ts.isPropertyAccessExpression(then.expression) || then.expression.name.text !== 'then') return false;
    const loader = unwrap(then.expression.expression);
    return ts.isCallExpression(loader) && loader.expression.kind === ts.SyntaxKind.ImportKeyword && ts.isStringLiteral(loader.arguments[0]) && loader.arguments[0].text === KATEX_CSS;
  }
  return false;
}

/** Every constructed sheet write in generative-ui.ts starts with the shared resets (KaTeX's own sheet excepted). */
function constructedSheetProblems(gu, sheetFn, own, richCss) {
  const problems = [];
  const writes = gu.calls.filter(call => ['replaceSync', 'replace', 'insertRule'].includes(calleeName(call)) && ts.isPropertyAccessExpression(call.expression));
  let generative = 0;
  for (const call of writes) {
    if (calleeName(call) === 'insertRule') { problems.push('constructed sheets take their CSS from one replaceSync(); insertRule() bypasses the shared resets'); continue; }
    const arg = call.arguments[0];
    if (isKatexModuleDefault(arg)) continue;
    if (within(call, sheetFn)) {
      generative++;
      if (!startsWithCss(gu, arg, [TYPE_BASE, SHADOW_BASE, richCss, own])) problems.push('generativeSheet() replaceSync starts with type-base then shadow-base before the other sheets');
    } else if (!startsWithCss(gu, arg, [TYPE_BASE, SHADOW_BASE])) problems.push(`${calleeName(call)}() on a constructed sheet must start with type-base then shadow-base before component CSS`);
  }
  if (!generative) problems.push('generativeSheet() replaceSync starts with type-base then shadow-base before the other sheets');
  return problems;
}

/** Every attachShadow root in generative-ui.ts adopts generativeSheet() on every adoption (KaTeX alongside). */
function generativeShadowProblems(gu, sheetFn, used) {
  const problems = [];
  const adoptions = gu.assigns.filter(write => ts.isPropertyAccessExpression(write.left) && write.left.name.text === 'adoptedStyleSheets');
  const adoptsShared = write => write.operatorToken.kind === ts.SyntaxKind.EqualsToken && ts.isArrayLiteralExpression(unwrap(write.right))
    && unwrap(write.right).elements.some(element => isGenerativeSheetCall(gu, element, sheetFn))
    && unwrap(write.right).elements.every(element => isGenerativeSheetCall(gu, element, sheetFn) || isKatexSheet(gu, element));
  if (!adoptions.length || !adoptions.every(adoptsShared)) problems.push('every adoptedStyleSheets write keeps generativeSheet(), including lazy KaTeX adoption');
  for (const call of gu.calls.filter(item => calleeName(item) === 'attachShadow')) {
    const owner = scopePath(call);
    const exempt = SHADOW_ROOT_EXEMPT.findIndex(item => item.file === 'src/generative-ui.ts' && item.owner === owner);
    if (exempt >= 0) { used.add(exempt); continue; }
    const root = shadowRootDecl(gu, call);
    if (!root) { problems.push('every attachShadow() root is bound to a const so its adopted sheets can be traced'); continue; }
    const mine = adoptions.filter(write => refersTo(gu, write.left.expression, root));
    if (!mine.length) problems.push(`attachShadow() root ${root.nameNode.text} never adopts generativeSheet()`);
    // The root's own CSS can only arrive through adoptedStyleSheets; inline <style> or innerHTML would bypass it.
    for (const ref of referencesOf(gu, root)) {
      const access = ref.parent;
      if (ts.isPropertyAccessExpression(access) && access.expression === ref && ['innerHTML', 'styleSheets'].includes(access.name.text)) problems.push(`attachShadow() root ${root.nameNode.text} writes ${access.name.text}, bypassing generativeSheet()`);
    }
  }
  return problems;
}

/** Every rich-html shadow root appends one <style> starting with the shared resets, never touched again. */
function richShadowProblems(rich) {
  const problems = [];
  const shadows = rich.calls.filter(call => calleeName(call) === 'attachShadow');
  if (!shadows.length) problems.push('rich-html appends a style with the shared prefix and no intervening overwrite');
  for (const call of shadows) {
    const root = shadowRootDecl(rich, call);
    if (!root) { problems.push('every rich-html attachShadow() root is bound to a const'); continue; }
    const mutations = rich.calls.filter(item => ['append', 'prepend', 'replaceChildren', 'appendChild', 'insertBefore'].includes(calleeName(item))
      && ts.isPropertyAccessExpression(item.expression) && refersTo(rich, item.expression.expression, root)).sort((a, b) => a.pos - b.pos);
    const first = mutations[0];
    const styleId = first && unwrap(first.arguments[0]);
    const style = styleId && ts.isIdentifier(styleId) ? resolve(rich, styleId) : null;
    const init = unwrap(style?.kind === 'const' ? style.init : null);
    const isStyle = init && ts.isCallExpression(init) && calleeName(init) === 'createElement' && ts.isStringLiteral(init.arguments[0]) && init.arguments[0].text === 'style';
    if (!first || !isStyle) { problems.push('rich-html appends a style with the shared prefix and no intervening overwrite'); continue; }
    // Allowed references: one unconditional `style.textContent = typeBase + shadowBase + ...` in the append's block, and the append argument.
    let base = null;
    for (const ref of referencesOf(rich, style)) {
      if (ref === styleId) continue;
      const access = ref.parent;
      const write = access?.parent;
      const isBaseWrite = !base && ts.isPropertyAccessExpression(access) && access.expression === ref && access.name.text === 'textContent'
        && write && ts.isBinaryExpression(write) && write.left === access && write.operatorToken.kind === ts.SyntaxKind.EqualsToken
        && ts.isExpressionStatement(write.parent) && write.parent.parent === first.parent?.parent && write.end < first.pos;
      if (isBaseWrite) { base = write; continue; }
      problems.push(`rich-html style ${style.nameNode.text} is mutated or aliased after its shared base text (${(access || ref).getText(rich.sf)})`);
    }
    if (!base || !startsWithCss(rich, base.right, [TYPE_BASE, SHADOW_BASE])) problems.push('rich-html appends a style with the shared prefix and no intervening overwrite');
  }
  return problems;
}

/** Prove shared reset prefixes reach constructed sheets, adopted roots, renderBlock and rich HTML. */
export function baseSheetFlowProblems(guSource, richSource, used = new Set()) {
  const problems = [];
  const gu = flowAst('src/generative-ui.ts', guSource);
  const importSpec = name => [...(gu.decls.get(`${gu.sf.pos}:${gu.sf.end}:${gu.sf.kind}`)?.values() || [])].find(info => isDefaultImport(info, name))?.spec || '';
  const own = importSpec('./generative-ui.css?inline');
  const richCss = importSpec('./rich-markdown.css?inline');
  const sheetFn = gu.functions.get('generativeSheet');
  problems.push(...constructedSheetProblems(gu, sheetFn, own, richCss));
  problems.push(...generativeShadowProblems(gu, sheetFn, used));
  const renders = gu.calls.filter(call => calleeName(call) === 'renderBlock');
  if (!renders.length || !renders.every(call => startsWithCss(gu, call.arguments[2], [TYPE_BASE, SHADOW_BASE]))) problems.push('renderBlock() receives type-base then shadow-base as its base CSS');
  problems.push(...richShadowProblems(flowAst('src/rich-markdown.ts', richSource)));
  return [...new Set(problems)];
}

/** Generative UI shadow exemptions that no longer match a class with an attachShadow() call. */
export function unusedShadowExemptions(guSource) {
  const used = new Set();
  baseSheetFlowProblems(guSource, '', used);
  return SHADOW_ROOT_EXEMPT.filter((item, index) => item.file === 'src/generative-ui.ts' && !used.has(index)).map(item => `${item.file} ${item.owner}`);
}

/** One scope's name: a named class, function or method, a const-bound function, or `<anonymous>`. */
function scopeName(node) {
  if ((ts.isClassLike(node) || ts.isFunctionDeclaration(node) || ts.isMethodDeclaration(node) || ts.isGetAccessorDeclaration(node) || ts.isSetAccessorDeclaration(node)) && node.name) return node.name.getText();
  if (ts.isConstructorDeclaration(node)) return 'constructor';
  if ((ts.isArrowFunction(node) || ts.isFunctionExpression(node)) && ts.isVariableDeclaration(node.parent) && ts.isIdentifier(node.parent.name)) return node.parent.name.text;
  if (isFunctionLike(node) || ts.isClassLike(node)) return '<anonymous>';
  return '';
}
/** The exact enclosing scope path of a node, outermost first (empty at module level), e.g. `CodeBlock.connectedCallback`. */
export function scopePath(node) {
  const names = [];
  for (let cur = node.parent; cur; cur = cur.parent) {
    const name = scopeName(cur);
    if (name) names.unshift(name);
  }
  return names.join('.');
}

/** The extensions shadowSources() walks under src/: the shared SCRIPT_EXTS plus `.html`. */
export const SHADOW_EXTS = Object.freeze([...SCRIPT_EXTS, '.html']);
/** Every script and HTML page under src/ plus the root *.html windows, keyed by repo-relative path (declaration files excluded). */
export function shadowSources() {
  const pages = readdirSync(root).filter(name => name.endsWith('.html')).map(name => join(root, name));
  const files = [...walk(join(root, 'src'), SHADOW_EXTS).filter(path => !path.endsWith('.d.ts')), ...pages];
  return Object.fromEntries(files.map(path => [relative(root, path).split('\\').join('/'), readFileSync(path, 'utf8')]));
}

/** Declarative Shadow DOM: `<template shadowrootmode=...>` builds a root that adopts neither shared sheet. */
const DECLARATIVE_SHADOW = /\bshadowrootmode\s*=/i;
const declarativeProblem = (file, line) => `${file}:${line}: declarative Shadow DOM (shadowrootmode=) is an unverified root that adopts neither type-base.css nor shadow-base.css; use attachShadow() and adopt them`;

/** shadowrootmode= in HTML outside <!-- --> comments, by line. */
function htmlDeclarativeProblems(file, source) {
  const text = source.replace(/<!--[\s\S]*?(?:-->|$)/g, comment => comment.replace(/[^\n]/g, ' '));
  return text.split('\n').flatMap((line, index) => DECLARATIVE_SHADOW.test(line) ? [declarativeProblem(file, index + 1)] : []);
}

/** shadowrootmode= in any non-comment constant string, folded across `+`, templates and `.join()` (the AST unescapes \\u and \\x). */
function scriptDeclarativeProblems(file, sf) {
  return foldedStrings(sf).filter(item => DECLARATIVE_SHADOW.test(item.text))
    .map(item => declarativeProblem(file, sf.getLineAndCharacterOfPosition(item.node.getStart()).line + 1));
}

const isAttachShadowCall = call => calleeName(call) === 'attachShadow'
  || (ts.isElementAccessExpression(call.expression) && evalConstString(call.expression.argumentExpression) === 'attachShadow');

/**
 * Every non-comment AST reference to attachShadow (identifier, property name or folded constant
 * string: `'attach' + 'Shadow'`, `` `attach${'Shadow'}` ``, `['attach', 'Shadow'].join('')`) other
 * than the callee name of an accounted direct `.attachShadow(...)` / `['attachShadow'](...)` call,
 * so `Element.prototype.attachShadow.call(...)` or `Reflect.apply(Element.prototype.attachShadow, ...)`
 * fail even beside a valid direct call.
 */
function strayAttachShadowRefs(sf, calls) {
  const accounted = new Set(calls.map(call => ts.isPropertyAccessExpression(call.expression) ? call.expression.name : call.expression.argumentExpression));
  const stray = [];
  const visit = node => {
    if ((ts.isIdentifier(node) || ts.isPrivateIdentifier(node)) && node.text === 'attachShadow' && !accounted.has(node)) stray.push(node);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  for (const item of foldedStrings(sf)) if (/attachShadow/.test(item.text) && !accounted.has(item.node)) stray.push(item.node);
  return stray.sort((a, b) => a.getStart() - b.getStart());
}

/**
 * Files the inventory parses: any whose raw text says attach or shadow (in any case, so split
 * `'attach' + 'Shadow'` or `'<template shadowroot' + 'mode=...'` pieces still match), plus any with
 * a \\u or \\x escape, because `h['attach\\u0053hadow'](...)` names it without the raw substring
 * (the AST unescapes it). Unrelated files are skipped without parsing.
 */
const MAY_NAME_ATTACH_SHADOW = /attach|shadow|\\[ux]/i;

/** One script's declarative and indirect problems plus its attachShadow() calls by scope path, memoized on its text. */
const shadowScans = new Map();
function scanShadowFile(file, source) {
  const key = `${file}\0${source}`;
  if (shadowScans.has(key)) return shadowScans.get(key);
  const ast = flowAst(file, source);
  const problems = scriptDeclarativeProblems(file, ast.sf);
  const calls = ast.calls.filter(isAttachShadowCall);
  for (const ref of strayAttachShadowRefs(ast.sf, calls)) {
    problems.push(`${file}:${ast.sf.getLineAndCharacterOfPosition(ref.getStart()).line + 1}: indirect attachShadow reference (${ref.getText().slice(0, 60)}) the inventory cannot attribute; call it directly so its root is verified or exempt`);
  }
  const byPath = new Map();
  for (const call of calls) {
    const owner = scopePath(call), line = ast.sf.getLineAndCharacterOfPosition(call.getStart()).line + 1;
    byPath.set(owner, { count: (byPath.get(owner)?.count || 0) + 1, line: byPath.get(owner)?.line ?? line });
  }
  const scan = { problems, byPath };
  shadowScans.set(key, scan);
  return scan;
}

/**
 * Repo-wide attachShadow inventory, flow-verified files included: every call's exact scope path
 * must match one SHADOW_ROOT_VERIFIED or SHADOW_ROOT_EXEMPT entry with the same call count.
 * Declarative roots (`shadowrootmode=` in a script literal or an HTML page) always fail.
 */
export function shadowInventoryProblems(sources = shadowSources()) {
  const problems = [];
  const entries = [...SHADOW_ROOT_VERIFIED, ...SHADOW_ROOT_EXEMPT];
  const counts = new Map(entries.map(item => [item, 0]));
  for (const [file, source] of Object.entries(sources)) {
    if (file.endsWith('.html')) { problems.push(...htmlDeclarativeProblems(file, source)); continue; }
    if (!MAY_NAME_ATTACH_SHADOW.test(source)) continue;
    const scan = scanShadowFile(file, source);
    problems.push(...scan.problems);
    const byPath = scan.byPath;
    for (const [owner, { count, line }] of byPath) {
      const matches = entries.filter(item => item.file === file && item.owner === owner);
      if (matches.length === 1) counts.set(matches[0], count);
      else problems.push(`${file}: attachShadow() in ${owner || 'module scope'} (line ${line}) is neither flow-verified (SHADOW_ROOT_VERIFIED) nor in SHADOW_ROOT_EXEMPT; adopt type-base then shadow-base or exempt it with a reason`);
    }
  }
  for (const item of entries) {
    const count = counts.get(item);
    if (!count) problems.push(`${item.file}: ${item.owner}: unused ${SHADOW_ROOT_VERIFIED.includes(item) ? 'SHADOW_ROOT_VERIFIED' : 'SHADOW_ROOT_EXEMPT'} entry`);
    else if (count !== item.count) problems.push(`${item.file}: ${item.owner}: ${count} attachShadow() calls, expected exactly ${item.count}; each extra root needs its own verified or exempt scope`);
  }
  for (const item of SHADOW_ROOT_VERIFIED) if (!FLOW_VERIFIED.includes(item.file)) problems.push(`${item.file}: SHADOW_ROOT_VERIFIED entry outside FLOW_VERIFIED`);
  return problems;
}

/** Resolve only preceding local const declarations in lexical scope (used for parameter forwarding). */
function localConst(node, name) {
  for (let scope = node.parent; scope; scope = scope.parent) {
    if (!ts.isBlock(scope) && !ts.isSourceFile(scope)) continue;
    for (const statement of scope.statements) {
      if (statement.pos >= node.pos || !ts.isVariableStatement(statement)) continue;
      if (!(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
      const decl = statement.declarationList.declarations.find(item => ts.isIdentifier(item.name) && item.name.text === name);
      if (decl) return decl.initializer;
    }
  }
  return null;
}
const receiver = node => ts.isPropertyAccessExpression(node) && ts.isIdentifier(node.expression) ? node.expression.text : null;

/** Follow renderBlock's third parameter through nested views and custom style elements. */
export function componentSheetFlow(source) {
  const ast = flowAst('src/generative-ui-components.ts', source);
  const problems = [];
  const targets = ['renderBlock', 'view', 'tabs', 'custom'];
  const parameters = new Map(targets.map(name => {
    const fn = ast.functions.get(name);
    const param = fn?.parameters[name === 'renderBlock' ? 2 : 1];
    return [name, param && ts.isIdentifier(param.name) && !param.questionToken && !param.initializer ? param : null];
  }));
  if ([...parameters.values()].some(param => !param)) problems.push('renderBlock and every nested renderer require a base CSS parameter');
  // A parameter operand resolves to itself only when no local shadows it.
  const isParam = (node, param) => {
    const n = unwrap(node);
    return Boolean(param) && n && ts.isIdentifier(n) && resolve(ast, n)?.nameNode === param.name;
  };
  const operands = (node, param) => {
    const n = unwrap(node);
    if (n && ts.isBinaryExpression(n) && n.operatorToken.kind === ts.SyntaxKind.PlusToken) return [...operands(n.left, param), ...operands(n.right, param)];
    if (isParam(n, param)) return ['param'];
    if (n && ts.isIdentifier(n)) {
      const info = resolve(ast, n);
      if (info?.kind === 'const' && info.init && ts.isStringLiteral(unwrap(info.init))) return [unwrap(info.init)];
    }
    if (n && ts.isStringLiteral(n)) return [n];
    return [UNKNOWN];
  };
  const forwards = ast.calls.filter(call => ['view', 'tabs', 'custom'].includes(calleeName(call)));
  for (const call of forwards) {
    let fn = call.parent;
    while (fn && !(ts.isFunctionDeclaration(fn) && targets.includes(fn.name?.text))) fn = fn.parent;
    const supplied = fn && parameters.get(fn.name.text);
    if (!supplied || call.arguments.length !== 2 || operands(call.arguments[1], supplied)[0] !== 'param') problems.push('nested renderer does not forward the shared CSS parameter');
  }
  if (!forwards.some(call => calleeName(call) === 'custom') || !forwards.some(call => calleeName(call) === 'tabs') || forwards.filter(call => calleeName(call) === 'view').length < 2) problems.push('shared CSS reaches custom, tabs and nested views');
  const fn = ast.functions.get('custom');
  const append = ast.calls.find(call => within(call, fn) && calleeName(call) === 'append' && (() => {
    const root = receiver(call.expression);
    const init = root && localConst(call, root);
    return init && ts.isCallExpression(init) && calleeName(init) === 'attachShadow';
  })());
  let customBase = null;
  const isStyleConst = (node, name) => {
    const init = localConst(node, name);
    return init && ts.isCallExpression(init) && calleeName(init) === 'createElement' && init.arguments[0]?.text === 'style';
  };
  if (append && ts.isIdentifier(append.arguments[0]) && ts.isIdentifier(append.arguments[1])) {
    const base = append.arguments[0].text, own = append.arguments[1].text;
    const shared = parameters.get('custom');
    const writes = ast.assigns.filter(write => within(write, fn) && receiver(write.left) === base && write.left.name?.text === 'textContent' && write.end < append.pos);
    const write = writes.at(-1);
    let statement = write;
    while (statement?.parent && !ts.isBlock(statement.parent)) statement = statement.parent;
    let appendStatement = append;
    while (appendStatement.parent && !ts.isBlock(appendStatement.parent)) appendStatement = appendStatement.parent;
    const unconditional = write && statement.parent === appendStatement.parent && ts.isExpressionStatement(statement);
    const parts = write ? operands(write.right, shared) : [];
    if (!isStyleConst(append, base) || !unconditional || parts[0] !== 'param' || !isStyleConst(append, own)) problems.push('custom base style precedes its own style');
    if (parts.length === 2 && ts.isStringLiteral(parts[1])) customBase = parts[1];
    else problems.push('custom style starts with the shared reset followed by inspectable local CSS');
    const ownWrite = ast.assigns.find(item => within(item, fn) && receiver(item.left) === own && item.left.name?.text === 'textContent');
    const spec = fn?.parameters[0]?.name;
    if (!ownWrite || !ts.isPropertyAccessExpression(ownWrite.right) || ownWrite.right.name.text !== 'css' || ownWrite.right.expression.getText(ast.sf) !== spec?.getText(ast.sf)) problems.push('custom own style receives the supplied CSS');
  } else problems.push('custom shadow root appends base and own style elements in order');
  return { problems, customBase };
}
