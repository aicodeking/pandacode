/**
 * Static design-token guard: the generative UI container set stays single-sourced.
 * GU_CONTAINERS (src/generative-ui-selectors.ts) is the one list; TIGHT_CUSTOM, GU_CONTAINER_SELECTOR
 * and SHADOW_SURFACE (src/generative-ui.ts) derive from it whole, every src/ script module is held to
 * closed import rules and whole uses (read from the TS AST), and every src/generative-ui.css
 * :is()/:where() group naming two or more containers must match it. docs.mjs re-exports
 * tightContainerProblems() for existing callers.
 */
import { readFileSync } from 'node:fs';
import { join, relative, posix } from 'node:path';
import ts from 'typescript';
import { root, SCRIPT_EXTS } from './allowlists.mjs';
import { stripComments, walk } from './parser.mjs';
import { decodeCssEscapes, splitTop } from './parser-values.mjs';
import { collectFoldedStrings, evalConstString } from './ts-fold.mjs';

/** One parsed TS AST per (file, source), shared by every scan in a run. */
const astMemo = new Map();
function sourceFile(file, source) {
  const key = `${file}\0${source}`;
  if (!astMemo.has(key)) astMemo.set(key, ts.createSourceFile(file, source, ts.ScriptTarget.Latest, true));
  return astMemo.get(key);
}
/**
 * A module can reach another module only through an `import`, `export` or `require` token. Such an
 * identifier may be spelled with a `\u` escape (`\u0072equire(…)`), so any `\u` also forces a parse;
 * the TS AST unescapes it, so the import rules below see `require`.
 */
const hasModuleSyntax = source => /\b(?:import|export|require)\b|\\u/.test(source);

const sameSet = (a, b) => a.size === b.size && [...a].every(item => b.has(item));

/** Top-level `const NAME = ...` initializers of one module, parsed with the TS AST so formatting never matters. */
function constInitializers(file, source) {
  const sf = sourceFile(file, source);
  const found = new Map();
  for (const statement of sf.statements) {
    if (!ts.isVariableStatement(statement) || !(statement.declarationList.flags & ts.NodeFlags.Const)) continue;
    for (const decl of statement.declarationList.declarations) {
      if (ts.isIdentifier(decl.name) && decl.initializer) found.set(decl.name.text, { node: decl.initializer, exported: Boolean(statement.modifiers?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword)) });
    }
  }
  return found;
}
/**
 * Every constant string under a node (folded across `+`, templates and `.join()` by the shared
 * ts-fold.mjs helper, CSS escapes decoded) and every identifier name, so `'.gu-' + 'card'`,
 * `` `.gu-${'card'}` ``, `['.gu', 'card'].join('-')` and `'.gu\\-card'` all read as `.gu-card`.
 */
function nodeParts(node) {
  const names = new Set();
  const visit = child => { if (ts.isIdentifier(child)) names.add(child.text); ts.forEachChild(child, visit); };
  visit(node);
  return { texts: collectFoldedStrings(node).map(decodeCssEscapes), names };
}
const SHARED = ['GU_CONTAINERS', 'GU_CONTAINER_SELECTOR'];
/** Inside a type annotation (`typeof GU_CONTAINERS[number]`), where nothing reaches the runtime selector. */
const inType = node => { for (let at = node.parent; at; at = at.parent) if (ts.isTypeNode(at)) return true; return false; };
/** Expression wrappers that change nothing at runtime: parentheses, `as`, `satisfies`, `!` and `<T>` casts. */
const WRAPS = [ts.isParenthesizedExpression, ts.isAsExpression, ts.isSatisfiesExpression, ts.isNonNullExpression, ts.isTypeAssertionExpression];
/** The first meaningful enclosing node past any WRAPS, and the outermost wrapped expression (`child`) it holds. */
function unwrapParent(node) {
  let child = node;
  while (child.parent && WRAPS.some(is => is(child.parent))) child = child.parent;
  return { parent: child.parent, child };
}
/** `access` is `.join` and `call` invokes it with the single string literal `','`. */
const isCommaJoin = (access, call) => ts.isPropertyAccessExpression(access) && access.name.text === 'join' && Boolean(call) && ts.isCallExpression(call)
  && call.expression === access && call.arguments.length === 1 && ts.isStringLiteralLike(call.arguments[0]) && call.arguments[0].text === ',';
/**
 * A whole-use result nothing reads further, by strict allowlist: past parentheses and casts it must land
 * directly in a plain-identifier `const` initializer (`let`/`var` could be reassigned; a template slot seals its whole template; an
 * array item seals its array). Any other enclosing node (`||`, `??`, `?:`, `+`, `new`, an object
 * property, a call, a tag, property or element access, a comma, a destructuring pattern such as
 * `const [, ...rest] = [...GU_CONTAINERS]`, a `return` or `export default`, whose consumer could chain
 * `.slice(1)`) fails.
 */
function sealed(node) {
  const { parent, child } = unwrapParent(node);
  if (!parent) return false;
  if (ts.isTemplateSpan(parent) && parent.expression === child) return sealed(parent.parent);
  if (ts.isArrayLiteralExpression(parent)) return sealedArray(parent);
  return ts.isVariableDeclaration(parent) && ts.isIdentifier(parent.name) && parent.initializer === child
    && Boolean(parent.parent && ts.isVariableDeclarationList(parent.parent) && (parent.parent.flags & ts.NodeFlags.Const));
}
/** An array literal holding a whole use: only a sealed `.join(',')` may follow it. */
function sealedArray(array) {
  const { parent, child } = unwrapParent(array);
  if (parent && ts.isPropertyAccessExpression(parent) && parent.expression === child) return isCommaJoin(parent, parent.parent) && sealed(parent.parent);
  return sealed(array);
}
/**
 * Every occurrence of the shared lists anywhere in a whole module must be a declaration name, an
 * import/export specifier, a type, or a whole use: spread `...GU_CONTAINERS` in an array literal,
 * `GU_CONTAINERS.join(',')`, `${GU_CONTAINER_SELECTOR}` in a template, or bare `GU_CONTAINER_SELECTOR`
 * as an array item. Any other access (`.slice`, `.filter`, `.replace`, `[0]`, a call, an alias
 * `const ALL = GU_CONTAINERS`) could strip a container, including through a helper constant slotted
 * into a derived selector, and so could a chained access on a whole use (`[...GU_CONTAINERS].slice(1)`,
 * `GU_CONTAINERS.join(',').replace(...)`, `` `${GU_CONTAINER_SELECTOR}`.replace(...) ``), seen past
 * parentheses and casts, or any other operator around it (sealed() is an allowlist). The variable a
 * whole use initializes (`const a = [...GU_CONTAINERS]`) is a derived variable, held to a strict
 * allowlist by derivedAccessProblems(): it may only be a bare direct argument of `.matches()`,
 * `.closest()`, `.querySelector()` or `.querySelectorAll()`, and outside the owner its declaration may not
 * be exported. An importing module holds every derived export of the owner it imports (TIGHT_CUSTOM,
 * found by ownerDerivedExports()) to the same rules.
 */
const useMemo = new Map();
function sourceUseProblems(file, source, ownerDerived = new Set()) {
  const key = `${file}\0${[...ownerDerived].join(',')}\0${source}`;
  if (!useMemo.has(key)) useMemo.set(key, wholeUseProblems(file, source, ownerDerived));
  return useMemo.get(key);
}
/** Whether one occurrence of a shared list is a sealed whole use. */
function wholeUse(child) {
  const { parent: holder, child: outer } = unwrapParent(child);
  const list = child.text === 'GU_CONTAINERS';
  if (list && ts.isSpreadElement(holder)) return ts.isArrayLiteralExpression(holder.parent) && sealedArray(holder.parent);
  if (list && ts.isPropertyAccessExpression(holder) && holder.expression === outer && isCommaJoin(holder, holder.parent)) return sealed(holder.parent);
  if (ts.isTemplateSpan(holder) && holder.expression === outer) return sealed(holder.parent);
  if (!list && ts.isArrayLiteralExpression(holder)) return sealedArray(holder);
  return false;
}
const isExported = node => Boolean(node && ts.canHaveModifiers(node) && ts.getModifiers(node)?.some(mod => mod.kind === ts.SyntaxKind.ExportKeyword));
/** The plain-identifier declaration a sealed whole use initializes, and its statement. */
function landing(node) {
  let at = node;
  while (at && !ts.isVariableDeclaration(at)) at = at.parent;
  return at && ts.isIdentifier(at.name) ? { decl: at, statement: at.parent?.parent } : null;
}
/** Local names of runtime named imports of the owner's derived exports (`TIGHT_CUSTOM`, renamed or not). */
function importedDerived(file, source, ownerDerived) {
  const names = new Set();
  for (const st of selectorImports(file, source)) {
    const bindings = ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly ? st.importClause?.namedBindings : null;
    if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) if (!item.isTypeOnly && ownerDerived.has(specName(item).name)) names.add(item.name.text);
  }
  return names;
}
function wholeUseProblems(file, source, ownerDerived) {
  const sf = sourceFile(file, source);
  const problems = [];
  // Outside the owner, an imported derived export (TIGHT_CUSTOM) is held to the same rules as a local derived variable.
  const derivedVars = file === OWNER ? new Set() : importedDerived(file, source, ownerDerived);
  const visit = child => {
    if (ts.isIdentifier(child) && SHARED.includes(child.text)) {
      const parent = child.parent;
      const declared = (ts.isVariableDeclaration(parent) && parent.name === child) || ts.isImportSpecifier(parent) || ts.isExportSpecifier(parent) || inType(child);
      if (!declared && !wholeUse(child)) {
        let at = child;
        while (at.parent && !ts.isStatement(at.parent) && !ts.isVariableDeclaration(at.parent)) at = at.parent;
        problems.push(`${file} must use ${child.text} whole (spread, .join(',') or a template slot, read no further), not \`${at.getText(sf)}\``);
      } else if (!declared) {
        const land = landing(child);
        const name = land?.decl.name.text;
        if (name && !SHARED.includes(name)) derivedVars.add(name);
        if (file !== OWNER && land && isExported(land.statement)) problems.push(`${file} exports ${name}, derived from ${child.text}; only src/generative-ui-selectors.ts may export derived container lists`);
      }
    }
    ts.forEachChild(child, visit);
  };
  visit(sf);
  if (derivedVars.size) problems.push(...derivedAccessProblems(file, sf, derivedVars));
  return problems;
}
/** Strip WRAPS (parentheses and casts) off an expression. */
const unwrapExpr = node => { while (WRAPS.some(is => is(node))) node = node.expression; return node; };
const DOM_SELECTOR_CALL = new Set(['matches', 'closest', 'querySelector', 'querySelectorAll']);
/** Receivers that are never a DOM element or document: literals, constructions and function values. */
const FAKE_RECEIVER = [ts.isObjectLiteralExpression, ts.isArrayLiteralExpression, ts.isNewExpression, ts.isClassExpression, ts.isFunctionExpression,
  ts.isArrowFunction, ts.isStringLiteral, ts.isNumericLiteral, ts.isNoSubstitutionTemplateLiteral, ts.isTemplateExpression, ts.isRegularExpressionLiteral];
const memberName = name => name && (ts.isIdentifier(name) || ts.isStringLiteral(name) || ts.isNoSubstitutionTemplateLiteral(name) || ts.isPrivateIdentifier(name)) ? name.text : null;
/**
 * The DOM_SELECTOR_CALL names a module defines or overrides itself (a method, property, shorthand,
 * accessor or function named `matches`/`closest`/..., including `Object.defineProperties()` descriptor
 * keys, an assignment to `.matches` / `['matches']` with a constant-folded key, or an
 * `Object.defineProperty()` / `Reflect.set()` call (callee name constant-folded too) whose key folds
 * to one), so a derived variable passed to such a call may reach a local function.
 */
const REFLECTIVE_SET = [['Object', 'defineProperty'], ['Reflect', 'set']];
/** `obj.fn` or `obj['f' + 'n']` past parentheses and casts. */
const isMember = (expr, obj, fn) => {
  const callee = unwrapExpr(expr);
  const base = ts.isPropertyAccessExpression(callee) || ts.isElementAccessExpression(callee) ? unwrapExpr(callee.expression) : null;
  if (!base || !ts.isIdentifier(base) || base.text !== obj) return false;
  return (ts.isPropertyAccessExpression(callee) ? callee.name.text : evalConstString(callee.argumentExpression)) === fn;
};
function localSelectorMethods(sf) {
  const found = new Set();
  const add = name => { if (name && DOM_SELECTOR_CALL.has(name)) found.add(name); };
  const visit = node => {
    if (ts.isMethodDeclaration(node) || ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node) || ts.isGetAccessorDeclaration(node)
      || ts.isSetAccessorDeclaration(node) || ts.isFunctionDeclaration(node) || ts.isPropertyDeclaration(node) || ts.isMethodSignature(node)) {
      add(node.name && ts.isComputedPropertyName(node.name) ? evalConstString(node.name.expression) : memberName(node.name));
    }
    if (ts.isBinaryExpression(node) && node.operatorToken.kind >= ts.SyntaxKind.FirstAssignment && node.operatorToken.kind <= ts.SyntaxKind.LastAssignment) {
      const target = unwrapExpr(node.left);
      if (ts.isPropertyAccessExpression(target)) add(target.name.text);
      else if (ts.isElementAccessExpression(target)) add(evalConstString(target.argumentExpression));
    }
    // Object.defineProperty(el, 'matches', ...) and Reflect.set(el, 'closest', ...), the callee name constant-folded too.
    if (ts.isCallExpression(node) && node.arguments.length >= 2 && REFLECTIVE_SET.some(([obj, fn]) => isMember(node.expression, obj, fn))) {
      add(evalConstString(node.arguments[1]));
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return found;
}
/**
 * Strict allowlist for derived variables (local, or imported derived exports of the owner): past
 * parentheses and casts, every occurrence other than its declaration name, an import specifier, a type
 * or the owner's own `export { ... }` must be a bare direct argument of `.matches()`, `.closest()`,
 * `.querySelector()` or `.querySelectorAll()`. Anything else (property or element access, spread,
 * destructuring, a template or `+` concatenation, `String()`, `for..of`, a helper call, an alias copy,
 * a reassignment, an export) fails. The call takes exactly that one argument, its receiver is not a
 * literal, construction or function value (`{ matches(s){...} }.matches(x)`, `new C().matches(x)`), and
 * the module must not define or assign that method name itself (localSelectorMethods()).
 */
function derivedAccessProblems(file, sf, derivedVars) {
  const problems = [];
  const overridden = localSelectorMethods(sf);
  const visit = node => {
    if (ts.isIdentifier(node) && derivedVars.has(node.text)) {
      const skip = (ts.isVariableDeclaration(node.parent) && node.parent.name === node) || ts.isImportSpecifier(node.parent) || inType(node)
        || (file === OWNER && ts.isExportSpecifier(node.parent) && !node.parent.parent.parent.moduleSpecifier);
      const { parent, child } = unwrapParent(node);
      const domCall = parent && ts.isCallExpression(parent) && parent.arguments.length === 1 && parent.arguments[0] === child
        && ts.isPropertyAccessExpression(parent.expression) && DOM_SELECTOR_CALL.has(parent.expression.name.text)
        && !FAKE_RECEIVER.some(is => is(unwrapExpr(parent.expression.expression))) && !overridden.has(parent.expression.name.text);
      if (!skip && !domCall) {
        let at = node;
        while (at.parent && !ts.isStatement(at.parent) && !ts.isVariableDeclaration(at.parent)) at = at.parent;
        problems.push(`${file} uses ${node.text} (derived from GU_CONTAINERS) in \`${at.getText(sf)}\`; pass it whole and directly to .matches(), .closest(), .querySelector() or .querySelectorAll()`);
      }
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}
/** `[...GU_CONTAINERS, ...]` or `[...GU_CONTAINERS, ...].join(',')`: the array literal must spread the bare identifier. */
function spreadsContainers(node) {
  let array = node;
  if (ts.isCallExpression(node) && ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === 'join') array = node.expression.expression;
  return ts.isArrayLiteralExpression(array) && array.elements.some(item => ts.isSpreadElement(item) && ts.isIdentifier(item.expression) && item.expression.text === 'GU_CONTAINERS');
}
/** `GU_CONTAINERS.join(',')` appears directly under the node. */
function joinsContainers(node) {
  let found = false;
  const visit = child => {
    if (ts.isCallExpression(child) && ts.isPropertyAccessExpression(child.expression) && child.expression.name.text === 'join'
      && ts.isIdentifier(child.expression.expression) && child.expression.expression.text === 'GU_CONTAINERS') found = true;
    ts.forEachChild(child, visit);
  };
  visit(node);
  return found;
}
/**
 * Every :is()/:where() group, nested ones included, with balanced parentheses: its top-level
 * comma arguments as trimmed, escape-decoded parts (`:is(.a,:not(*))` yields `.a` and `:not(*)`).
 */
const groupMemo = new Map();
function allGroups(text) {
  if (groupMemo.has(text)) return groupMemo.get(text);
  const groups = [];
  for (const match of text.matchAll(/:(?:is|where)\(/gi)) {
    let depth = 1, at = match.index + match[0].length;
    for (; at < text.length && depth; at++) depth += text[at] === '(' ? 1 : text[at] === ')' ? -1 : 0;
    const inner = text.slice(match.index + match[0].length, at - 1);
    groups.push(splitTop(inner, /,/).map(part => decodeCssEscapes(part).trim().replace(/\s*([>+~])\s*/g, '$1').replace(/\s+/g, ' ')));
  }
  groupMemo.set(text, groups);
  return groups;
}
const CLASS_ONLY = /^\.[-\w]+$/;
/** A derived selector may not restate any container class by hand. */
const repeatedContainers = (texts, containers) => [...containers].filter(name => texts.some(text => new RegExp(`${name.replace('.', '\\.')}(?![-\\w])`).test(text)));

const SELECTORS_MODULE = 'src/generative-ui-selectors';
const OWNER = 'src/generative-ui-selectors.ts';
const OWN_MODULES = [OWNER, 'src/generative-ui.ts'];
export { SCRIPT_EXTS };
const SCRIPT_EXT_I = /\.(?:ts|tsx|mts|cts|js|mjs|cjs)$/i;
/** A path from `file` as a repo path: Vite root-relative `/src/...` or relative to the file. */
const resolvePath = (file, bare) => bare.startsWith('/') ? bare.replace(/^\/+/, '') : posix.join(posix.dirname(file), bare);
/** Whether a specifier from `file` resolves to src/generative-ui-selectors (`.ts`, `.js`, `.mjs`, ... or bare; any `?query` dropped; `/src/...` too), case-insensitively as on macOS/Windows filesystems. */
const isSelectorsSpecifier = (file, spec) => typeof spec === 'string' && resolvePath(file, spec.replace(/\?[^/]*$/, '')).replace(SCRIPT_EXT_I, '').toLowerCase() === SELECTORS_MODULE;
/** A module's import/export-from declarations (read from the TS AST) whose specifier resolves to src/generative-ui-selectors. */
function selectorImports(file, source) {
  if (!hasModuleSyntax(source)) return [];
  return sourceFile(file, source).statements.filter(st => (ts.isImportDeclaration(st) || ts.isExportDeclaration(st)) && st.moduleSpecifier && ts.isStringLiteral(st.moduleSpecifier)
    && isSelectorsSpecifier(file, st.moduleSpecifier.text));
}
/** A runtime named import of GU_CONTAINERS (not renamed, not type-only) from the selectors module. */
const importsContainers = (file, source) => selectorImports(file, source).some(st => {
  const bindings = ts.isImportDeclaration(st) && !st.importClause?.isTypeOnly ? st.importClause?.namedBindings : null;
  return Boolean(bindings && ts.isNamedImports(bindings) && bindings.elements.some(item => !item.isTypeOnly && item.name.text === 'GU_CONTAINERS' && (!item.propertyName || item.propertyName.text === 'GU_CONTAINERS')));
});
/** The exported name a specifier binds (`{ A as B }` reads A) and whether it renames it. */
const specName = item => ({ name: (item.propertyName ?? item.name).text, renamed: Boolean(item.propertyName) && item.propertyName.text !== item.name.text });
/**
 * Closed import rules for the selectors module: no default, namespace (`* as s`) or renamed runtime
 * import of GU_CONTAINERS / GU_CONTAINER_SELECTOR or any derived export of the owner (TIGHT_CUSTOM), since a namespace or alias reaches the lists under
 * a name the whole-use scan never sees (`s['GU_' + 'CONTAINERS'].slice(1)`). No other module re-exports
 * the selectors module at runtime (`export *`, `export * as s`, `export { ... } from`) or locally
 * exports either list or a derived export (plain or renamed), so a barrel never hands them to a module the scan skips.
 * A dynamic `import()` whose argument folds to the module (ts-fold.mjs) fails outright; non-constant
 * specifiers (`import(m)`) are not resolved. `import.meta.glob()` / `import.meta.globEager()` whose
 * constant-folded string or array patterns match the module fail too (non-constant patterns are not
 * resolved, like `import(m)`), and so does a CommonJS `require()` whose argument folds to the module
 * (`require(m)` is not resolved). Type-only imports and plain named imports stay allowed.
 */
const GLOB_NAMES = ['glob', 'globEager'];
const isImportMeta = node => ts.isMetaProperty(node) && node.keywordToken === ts.SyntaxKind.ImportKeyword && node.name.text === 'meta';
/** A call to `import.meta.glob(...)` / `import.meta.globEager(...)`, dotted or by a folded element access. */
function isMetaGlob(node) {
  if (!ts.isCallExpression(node) || !node.arguments.length) return false;
  let callee = node.expression;
  while (WRAPS.some(is => is(callee))) callee = callee.expression;
  if (ts.isPropertyAccessExpression(callee)) return isImportMeta(callee.expression) && GLOB_NAMES.includes(callee.name.text);
  if (ts.isElementAccessExpression(callee)) return isImportMeta(callee.expression) && GLOB_NAMES.includes(evalConstString(callee.argumentExpression));
  return false;
}
/** Constant-folded glob patterns from a string or array-literal argument (non-constant entries are skipped). */
function globPatterns(arg) {
  const items = ts.isArrayLiteralExpression(arg) ? [...arg.elements] : [arg];
  return items.map(item => evalConstString(item)).filter(text => typeof text === 'string');
}
/** Index of the `close` that balances the `open` at `start` (backslash escapes skipped), or -1. */
function closeOf(glob, start, open, close) {
  for (let i = start, depth = 0; i < glob.length; i++) {
    if (glob[i] === '\\') i++;
    else if (glob[i] === open) depth++;
    else if (glob[i] === close && !--depth) return i;
  }
  return -1;
}
/** `text` split on `sep` outside any `()`, `{}` or `[]` group. */
function splitGlobTop(text, sep) {
  const parts = [''];
  for (let i = 0, depth = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '\\') { parts[parts.length - 1] += c + (text[++i] ?? ''); continue; }
    if ('({['.includes(c)) depth++;
    else if (')}]'.includes(c)) depth--;
    if (!depth && c === sep) parts.push('');
    else parts[parts.length - 1] += c;
  }
  return parts;
}
const altSource = body => splitGlobTop(body, '|').map(alt => globRegExp(alt).source.slice(1, -1)).join('|');
/** A `[...]` class at `i` as [regexp source, end index], or null; `[!`/`[^` negate and never match `/`; a leading `]` is literal. */
function globClass(glob, i) {
  let j = i + 1;
  const negated = glob[j] === '!' || glob[j] === '^';
  if (negated) j++;
  let body = '';
  for (let first = true; j < glob.length; j++, first = false) {
    const c = glob[j];
    if (c === ']' && !first) return [`[${negated ? '^/' : ''}${body}]`, j];
    if (c === '\\') { body += `\\${glob[++j] ?? '\\'}`; continue; }
    body += /[\]\[^\\]/.test(c) ? `\\${c}` : c;
  }
  return null;
}
const EXTGLOB = { '+': '+', '@': '', '?': '?', '*': '*' };
/**
 * A Vite glob as a case-insensitive RegExp (macOS/Windows filesystems): `**\/` (zero or more segments),
 * `**`, `*`, `?`, `[...]` classes (`[!`/`[^` negated, never matching `/`), balanced `{a,b}` alternation
 * and extglobs `+(a|b)`, `@(a|b)`, `?(a|b)`, `*(a|b)`; a negative `!(a|b)` fails closed as `[^/]*`.
 */
function globRegExp(glob) {
  let out = '';
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i];
    const extEnd = '+@?*!'.includes(c) && glob[i + 1] === '(' ? closeOf(glob, i + 1, '(', ')') : -1;
    const cls = c === '[' ? globClass(glob, i) : null;
    if (extEnd > 0) {
      out += c === '!' ? '[^/]*' : `(?:${altSource(glob.slice(i + 2, extEnd))})${EXTGLOB[c]}`;
      i = extEnd;
    } else if (cls) { out += cls[0]; i = cls[1]; }
    else if (glob.startsWith('**/', i)) { out += '(?:[^/]*/)*'; i += 2; }
    else if (glob.startsWith('**', i)) { out += '.*'; i += 1; }
    else if (c === '*') out += '[^/]*';
    else if (c === '?') out += '[^/]';
    else if (c === '{' && closeOf(glob, i, '{', '}') > 0) {
      const end = closeOf(glob, i, '{', '}');
      out += `(?:${splitGlobTop(glob.slice(i + 1, end), ',').map(alt => globRegExp(alt).source.slice(1, -1)).join('|')})`;
      i = end;
    } else out += c.replace(/[.+^$()|[\]{}\\]/g, '\\$&');
  }
  return new RegExp(`^${out}$`, 'i');
}
/** Whether a positive glob pattern from `file` (relative, or Vite root-relative `/src/...`) matches the selectors module. */
function globHitsSelectors(file, pattern) {
  if (pattern.startsWith('!')) return false;
  // `?` is both a query suffix and a one-character wildcard, so test the pattern with and without it.
  return [pattern, pattern.replace(/\?[^/]*$/, '')].some(bare => {
    const re = globRegExp(resolvePath(file, bare));
    return re.test(OWNER) || re.test(SELECTORS_MODULE);
  });
}
function importShapeProblems(file, source, ownerDerived = new Set()) {
  const problems = [];
  const guarded = new Set([...SHARED, ...ownerDerived]);
  if (!hasModuleSyntax(source)) return problems;
  for (const st of selectorImports(file, source)) {
    const where = `${file} imports ./generative-ui-selectors`;
    if (ts.isImportDeclaration(st)) {
      const clause = st.importClause;
      if (!clause || clause.isTypeOnly) continue;
      if (clause.name) problems.push(`${where} as a default import; use named imports`);
      const bindings = clause.namedBindings;
      if (bindings && ts.isNamespaceImport(bindings)) problems.push(`${where} as a namespace (* as ${bindings.name.text}); use named imports`);
      if (bindings && ts.isNamedImports(bindings)) for (const item of bindings.elements) {
        const { name, renamed } = specName(item);
        if (!item.isTypeOnly && renamed && guarded.has(name)) problems.push(`${where} renaming ${name} as ${item.name.text}; import it under its own name`);
      }
    } else if (!st.isTypeOnly && file !== OWNER) {
      const clause = st.exportClause;
      const runtime = !clause || !ts.isNamedExports(clause) || clause.elements.some(item => !item.isTypeOnly);
      if (runtime) problems.push(`${file} re-exports ./generative-ui-selectors (\`${st.getText()}\`); import from the selectors module directly`);
    }
  }
  const sf = sourceFile(file, source);
  // A local `export { GU_CONTAINERS }` / `export { GU_CONTAINERS as G }` hands the list on under a name or module the scan never follows.
  if (file !== OWNER) for (const st of sf.statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier || st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const item of st.exportClause.elements) {
      const { name } = specName(item);
      if (!item.isTypeOnly && guarded.has(name)) problems.push(`${file} exports ${name}${item.propertyName ? ` as ${item.name.text}` : ''}; only src/generative-ui-selectors.ts may export it`);
    }
  }
  const visit = node => {
    if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && isSelectorsSpecifier(file, evalConstString(node.moduleReference.expression))) problems.push(`${file} loads ./generative-ui-selectors with import ${node.name.text} = require(); use a static named import`);
    if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments.length
      && isSelectorsSpecifier(file, evalConstString(node.arguments[0]))) problems.push(`${file} loads ./generative-ui-selectors with a dynamic import(); use a static named import`);
    if (ts.isCallExpression(node) && ts.isIdentifier(unwrapExpr(node.expression)) && unwrapExpr(node.expression).text === 'require' && node.arguments.length
      && isSelectorsSpecifier(file, evalConstString(node.arguments[0]))) problems.push(`${file} loads ./generative-ui-selectors with require(); use a static named import`);
    if (isMetaGlob(node) && globPatterns(node.arguments[0]).some(pattern => globHitsSelectors(file, pattern))) {
      problems.push(`${file} loads ./generative-ui-selectors via import.meta.glob(); use a static named import`);
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return problems;
}
let srcModules = null;
/** Every other non-.d.ts script module under src/ (all SCRIPT_EXTS), unfiltered by module name (read once per run), so escaped or folded specifiers are still parsed. */
function otherSrcModules() {
  srcModules ??= Object.fromEntries(walk(join(root, 'src'), SCRIPT_EXTS).filter(path => !path.endsWith('.d.ts'))
    .map(path => [relative(root, path).split('\\').join('/'), path]).filter(([file]) => !OWN_MODULES.includes(file))
    .map(([file, path]) => [file, readFileSync(path, 'utf8')]));
  return srcModules;
}

/** Parse `export const GU_CONTAINERS = [...] as const` into its class list, or a problem. */
function guContainers(selectorsTs) {
  const consts = constInitializers('src/generative-ui-selectors.ts', selectorsTs);
  const entry = consts.get('GU_CONTAINERS');
  let node = entry?.node;
  const asConst = node && ts.isAsExpression(node) && ts.isTypeReferenceNode(node.type) && node.type.typeName.getText() === 'const';
  if (asConst) node = node.expression;
  if (!entry?.exported || !asConst || !ts.isArrayLiteralExpression(node) || !node.elements.every(ts.isStringLiteralLike)) {
    return { consts, problem: 'src/generative-ui-selectors.ts must export GU_CONTAINERS as an `[...] as const` array of string literals' };
  }
  return { consts, containers: node.elements.map(item => item.text) };
}

/**
 * Every exported top-level const of the owner (other than the shared lists) whose initializer names
 * GU_CONTAINERS, GU_CONTAINER_SELECTOR or another derived const (today TIGHT_CUSTOM), exported inline
 * or through a local `export { ... }`, by the name importers see (`export { TIGHT_CUSTOM as TC }`
 * yields TC); a renamed export of a shared list itself (`export { GU_CONTAINERS as G }`) counts too.
 */
export function ownerDerivedExports(selectorsTs) {
  const consts = constInitializers(OWNER, selectorsTs);
  const derived = new Set();
  for (let grew = true; grew;) {
    grew = false;
    for (const [name, { node }] of consts) {
      if (SHARED.includes(name) || derived.has(name)) continue;
      const { names } = nodeParts(node);
      if ([...SHARED, ...derived].some(source => names.has(source))) { derived.add(name); grew = true; }
    }
  }
  const out = new Set([...consts].filter(([name, entry]) => entry.exported && derived.has(name)).map(([name]) => name));
  for (const st of sourceFile(OWNER, selectorsTs).statements) {
    if (!ts.isExportDeclaration(st) || st.moduleSpecifier || st.isTypeOnly || !st.exportClause || !ts.isNamedExports(st.exportClause)) continue;
    for (const item of st.exportClause.elements) {
      if (item.isTypeOnly) continue;
      // Importers see the exported name: `export { TIGHT_CUSTOM as TC }` exports TC, and `{ GU_CONTAINERS as G }` hands the list on as G.
      const local = (item.propertyName ?? item.name).text, exportedName = item.name.text;
      if (derived.has(local) || (SHARED.includes(local) && exportedName !== local)) out.add(exportedName);
    }
  }
  return out;
}

/**
 * Keep the generative UI container set single-sourced: GU_CONTAINERS (src/generative-ui-selectors.ts)
 * lists class selectors including `.gu-card`; TIGHT_CUSTOM and GU_CONTAINER_SELECTOR derive from it,
 * SHADOW_SURFACE (src/generative-ui.ts) spreads it, and none of them restates a container class by
 * hand (constant `+` concatenation is folded first). Both whole modules, and every other src/ module
 * importing the selectors module, reach the shared lists only whole (no `.slice`/`.filter`/`.replace`/
 * alias, even through a helper constant), under the closed import rules of importShapeProblems(). Every :is()/:where()
 * group in generative-ui.css naming two or more containers is either a class-only nesting group (that
 * set, optionally with `.gu-tight-host`, or the control-holder set with `.gu-code`) or a leaf-surface
 * group; the leaf-surface groups must be one identical set holding every container.
 */
export function tightContainerProblems(
  selectorsTs = readFileSync(join(root, 'src/generative-ui-selectors.ts'), 'utf8'),
  css = readFileSync(join(root, 'src/generative-ui.css'), 'utf8'),
  guTs = readFileSync(join(root, 'src/generative-ui.ts'), 'utf8'),
  extraSources = otherSrcModules(),
) {
  const { consts, containers: list, problem } = guContainers(selectorsTs);
  if (problem) return [problem];
  const problems = [];
  const containers = new Set(list);
  if (!containers.has('.gu-card')) problems.push('GU_CONTAINERS must include .gu-card');
  for (const name of list) if (!/^\.[-\w]+$/.test(name)) problems.push(`GU_CONTAINERS item ${name} must be a single class selector`);
  if (containers.size !== list.length) problems.push('GU_CONTAINERS lists a class twice');
  const derived = (label, entry, sources, shape) => {
    if (!entry) { problems.push(`${label} is missing`); return; }
    if (shape && !shape.test(entry.node)) problems.push(`${label} must ${shape.need}`);
    const { texts, names } = nodeParts(entry.node);
    if (!sources.some(name => names.has(name))) problems.push(`${label} must derive from ${sources.join(' or ')}`);
    const repeated = repeatedContainers(texts, containers);
    if (repeated.length) problems.push(`${label} restates container classes by hand (${repeated.join(',')}); derive them from GU_CONTAINERS`);
  };
  derived('GU_CONTAINER_SELECTOR in src/generative-ui-selectors.ts', consts.get('GU_CONTAINER_SELECTOR'), ['GU_CONTAINERS'], { test: joinsContainers, need: "join the whole list with GU_CONTAINERS.join(',')" });
  derived('TIGHT_CUSTOM in src/generative-ui-selectors.ts', consts.get('TIGHT_CUSTOM'), ['GU_CONTAINER_SELECTOR', 'GU_CONTAINERS']);
  derived('SHADOW_SURFACE in src/generative-ui.ts', constInitializers('src/generative-ui.ts', guTs).get('SHADOW_SURFACE'), ['GU_CONTAINERS'], { test: spreadsContainers, need: 'be an array literal (optionally .join(\',\')) that spreads ...GU_CONTAINERS directly' });
  if (!importsContainers('src/generative-ui.ts', guTs)) problems.push('src/generative-ui.ts must import GU_CONTAINERS from ./generative-ui-selectors');
  // Repo-wide: every other src/ module that imports from (or re-exports) the selectors module is held to the same whole-use rule.
  const others = Object.entries(extraSources).filter(([file]) => !OWN_MODULES.includes(file));
  const importers = others.filter(([file, source]) => selectorImports(file, source).length);
  const ownerDerived = ownerDerivedExports(selectorsTs);
  for (const [file, source] of [['src/generative-ui-selectors.ts', selectorsTs], ['src/generative-ui.ts', guTs], ...importers]) problems.push(...sourceUseProblems(file, source, ownerDerived));
  for (const [file, source] of [['src/generative-ui-selectors.ts', selectorsTs], ['src/generative-ui.ts', guTs], ...others]) problems.push(...importShapeProblems(file, source, ownerDerived));
  const sheet = stripComments(css);
  const named = parts => parts.filter(part => containers.has(part)).length;
  const holders = new Set([...containers, '.gu-tight-host', '.gu-code']);
  const groups = allGroups(sheet).filter(parts => named(parts) >= 2);
  // Class-only groups of containers (plus .gu-tight-host or .gu-code, or about one stray class) are nesting groups, so dropping .gu-card itself still fails.
  const isNesting = parts => parts.every(part => CLASS_ONLY.test(part)) && (parts.every(part => holders.has(part)) || parts.length <= containers.size + 1);
  let nesting = 0;
  for (const parts of groups.filter(isNesting)) {
    const group = new Set(parts);
    const missing = [...containers].filter(name => !group.has(name));
    const extra = [...group].filter(name => !holders.has(name));
    const holder = group.has('.gu-code') && !group.has('.gu-tight-host');
    if (missing.length || extra.length || (group.has('.gu-code') && !holder)) {
      problems.push(`src/generative-ui.css :is(${parts.join(',')}) must match GU_CONTAINERS (${list.join(',')})`);
    }
    if (!holder) nesting++;
  }
  if (!nesting) problems.push('src/generative-ui.css has no :is() container nesting group to check against GU_CONTAINERS');
  // Every other group naming two or more containers is a leaf-surface group (containers plus leaf surfaces); they must stay one identical set.
  const leaves = groups.filter(parts => !isNesting(parts)).map(parts => new Set(parts));
  if (leaves.length < 2) problems.push('src/generative-ui.css must keep its repeated leaf-surface :is() groups (containers plus leaf surfaces)');
  const [first] = leaves;
  if (first && leaves.some(group => !sameSet(group, first))) problems.push('src/generative-ui.css leaf-surface :is() groups must all list the same selectors');
  const lost = first ? list.filter(name => leaves.some(group => !group.has(name))) : [];
  if (lost.length) problems.push(`src/generative-ui.css leaf-surface :is() groups must include every GU_CONTAINERS class (missing ${lost.join(',')})`);
  return problems;
}
