/**
 * Markdown typography parity: resolve the effective style each Markdown host gives a set of
 * sample element paths (headings, prose containers, list items, inline/heading/table/quote/link
 * code, samp and tt on every inline-code path, pre, strong/b, th, `ul`/`ol` wrappers, items and code
 * nested up to three levels) and compare it with the canonical values.
 *
 * Hosts and their complete sheet sets, in cascade order:
 * - semantic HTML: src/type-base.css alone, whose inline code, samp and tt in p, li, dd and small (never pre)
 *   must read --code-inline-size with inherited leading;
 * - main document: every sheet the main window loads, in its actual import order, found by
 *   walking index.html -> src/entry.ts -> src/main.ts through static then dynamic TS imports,
 *   CSS imports and CSS @import (`?inline`/`?raw` text is not injected, so it does not count);
 *   a component sheet that never names a Markdown root (agent-teams.css) still counts;
 * - launcher window: src/type-base.css + src/overlay.css;
 * - custom views and rich-HTML shadow roots: src/type-base.css + src/shadow-base.css, both inside
 *   `.markdown` and as bare Shadow DOM content (no Markdown root: headings, code, pre, table heads);
 * - generativeSheet(): type-base, shadow-base, rich-markdown and generative-ui, in that order.
 *
 * Selector matching lives in markdown-parity-match.mjs: unknown outer ancestors may reach
 * Markdown, ancestor path elements may carry unknown classes, and `:is()`/`:not()` arguments are
 * complex selectors matched against the full ancestor chain. Specificity is the highest
 * matching branch, then source order and !important decide. This is a static model of the
 * listed sample paths, not a browser cascade: sibling combinators, `:has()` and classes on the
 * sample subject itself (`a.citation`, `code.hljs`) are out of scope.
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { root, EM_TOKENS, MARKDOWN_OUTSIDE } from './allowlists.mjs';
import { parseBlocks, stripComments, declarations, walk } from './parser.mjs';
import { effectiveStyle } from './pairing.mjs';
import { splitTop } from './parser-values.mjs';
import { ruleReach, compareSpec } from './markdown-parity-match.mjs';

const [CODE_INLINE, HEADING_LG] = EM_TOKENS.map(name => `var(${name})`);
/** Sheets whose own `.markdown` prose pair is locked. */
const PROSE_FILES = ['src/styles.css', 'src/overlay.css', 'src/shadow-base.css'];

const HEADING = { size: '1em', weight: 'var(--weight-strong)', lineHeight: 'var(--type-title-leading)', letter: 'var(--tracking-none)' };
/** Every Markdown root sets --tracking-none, so code that inherits or restates it reads the same. */
const TRACKING = ['', 'var(--tracking-none)', '0'];
const CODE = { size: CODE_INLINE, weight: '', letter: TRACKING };
/** Prose containers and inline wrappers keep the inherited prose size. */
const INHERITED_SIZE = { size: '' };
const LIST_PATHS = [['ul', 'li'], ['ol', 'li']];
const WRAPPER_PATHS = [['ul'], ['ol'], ['dl'], ['table'], ['table', 'thead'], ['table', 'tbody'], ['table', 'tfoot'], ['table', 'thead', 'tr'], ['table', 'tbody', 'tr'], ['table', 'tfoot', 'tr']];
/** Nested lists (wrappers and items) keep the prose size at sample depths up to three levels; deeper nesting is outside the sampled paths. */
const NESTED_LIST_PATHS = ['ul', 'ol'].flatMap(tag => [[tag, 'li', tag], [tag, 'li', tag, 'li'], [tag, 'li', tag, 'li', tag], [tag, 'li', tag, 'li', tag, 'li']]);
/** Inline code at the second and third list level. */
const NESTED_CODE_PATHS = ['ul', 'ol'].flatMap(tag => [[tag, 'li', tag, 'li', 'code'], [tag, 'li', tag, 'li', tag, 'li', 'code']]);
/** samp and tt are inline code too: every inline-code sample path checks all three. */
export const INLINE_TAGS = ['code', 'samp', 'tt'];
const HEADINGS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
/** Every parent an inline-code sample sits in, in each Markdown host. */
const INLINE_PARENTS = [
  ['p'], ['ul', 'li'], ['ol', 'li'], ['ul', 'li', 'p'], ['ol', 'li', 'p'], ['blockquote', 'p'], ['table', 'tbody', 'tr', 'td'], ['table', 'tfoot', 'tr', 'td'],
  ['dl', 'dd'], ['dl', 'dt'], ['p', 'a'], ['p', 'small'], ['p', 'em'], ['p', 'del'], ['ul', 'li', 'ul', 'li', 'p'], ...HEADINGS.map(tag => [tag]), ['table', 'thead', 'tr', 'th'],
];
/** Semantic HTML parents src/type-base.css sizes inline code in. */
const BASE_PARENTS = [['p'], ['ul', 'li'], ['ol', 'li'], ['dl', 'dd'], ['p', 'small']];
const inlineTargets = (parents, expected, prefix = '') => parents.flatMap(parent => INLINE_TAGS.map(tag => ({ label: `${prefix}${[...parent, tag].join(' > ')}`, path: [...parent, tag], expected })));
/**
 * Bold inside a heading reads the heading weight: src/type-base.css inherits it and the later
 * Markdown bold rule restates the same --weight-strong, so either value renders identically.
 */
const HEADING_BOLD = { size: '', weight: ['inherit', 'var(--weight-strong)'], lineHeight: '', letter: '' };
/** Table header cells come from src/type-base.css and src/shadow-base.css: caption column heads, prose-size row heads. */
const THEAD_TH = { size: 'var(--type-caption)', weight: 'var(--weight-medium)', lineHeight: 'var(--type-caption-leading)', letter: 'var(--tracking-none)' };
const TBODY_TH = { size: '1em', weight: 'var(--weight-medium)', lineHeight: 'inherit', letter: 'var(--tracking-none)' };
/** Canonical effective typography for each Markdown element path below the host root(s). */
const MARKDOWN_TARGETS = [
  ...['h1', 'h2'].map(tag => ({ label: tag, path: [tag], expected: { ...HEADING, size: HEADING_LG } })),
  ...['h3', 'h4', 'h5', 'h6'].map(tag => ({ label: tag, path: [tag], expected: HEADING })),
  { label: 'p', path: ['p'], expected: { size: '', letter: TRACKING } },
  { label: 'blockquote', path: ['blockquote'], expected: INHERITED_SIZE },
  { label: 'blockquote > p', path: ['blockquote', 'p'], expected: { size: '', letter: TRACKING } },
  { label: 'nested blockquote', path: ['blockquote', 'blockquote'], expected: INHERITED_SIZE },
  { label: 'caption', path: ['table', 'caption'], expected: INHERITED_SIZE },
  ...LIST_PATHS.map(path => ({ label: `${path[0]} > li`, path, expected: INHERITED_SIZE })),
  ...NESTED_LIST_PATHS.map(path => ({ label: `nested ${path.join(' > ')}`, path, expected: INHERITED_SIZE })),
  { label: 'a', path: ['p', 'a'], expected: INHERITED_SIZE },
  { label: 'em', path: ['p', 'em'], expected: INHERITED_SIZE },
  { label: 'dd', path: ['dl', 'dd'], expected: INHERITED_SIZE },
  { label: 'td', path: ['table', 'tbody', 'tr', 'td'], expected: INHERITED_SIZE },
  { label: 'tfoot td', path: ['table', 'tfoot', 'tr', 'td'], expected: INHERITED_SIZE },
  { label: 'tfoot th', path: ['table', 'tfoot', 'tr', 'th'], expected: { size: '', weight: 'var(--weight-medium)' } },
  // Wrappers keep the prose size too: scaling one (ul{font-size:1.2em}) would scale every item or cell inside it.
  ...WRAPPER_PATHS.map(path => ({ label: `${path.at(-1)} wrapper`, path, expected: INHERITED_SIZE })),
  ...inlineTargets(INLINE_PARENTS, CODE, 'inline '),
  ...NESTED_CODE_PATHS.map(path => ({ label: `nested ${path.join(' > ')}`, path, expected: CODE })),
  ...['h1', 'h2', 'h3'].map(tag => ({ label: `${tag} strong`, path: [tag, 'strong'], expected: HEADING_BOLD })),
  { label: 'h2 b', path: ['h2', 'b'], expected: HEADING_BOLD },
  { label: 'pre', path: ['pre'], expected: { size: 'var(--mono-size)', lineHeight: 'var(--leading-code)', weight: '', letter: TRACKING } },
  ...INLINE_TAGS.map(tag => ({ label: `pre ${tag}`, path: ['pre', tag], expected: { size: 'inherit', weight: '', letter: TRACKING } })),
  ...['strong', 'b'].map(tag => ({ label: tag, path: ['p', tag], expected: { size: '', weight: 'var(--weight-strong)', lineHeight: '', letter: '' } })),
  { label: 'em strong', path: ['p', 'em', 'strong'], expected: { size: '', weight: 'var(--weight-strong)', lineHeight: '', letter: '' } },
  ...['strong', 'b'].flatMap(bold => INLINE_TAGS.map(tag => ({ label: `${bold} ${tag}`, path: ['p', bold, tag], expected: { size: CODE_INLINE, weight: 'var(--weight-medium)' } }))),
  ...INLINE_TAGS.map(tag => ({ label: `li strong ${tag}`, path: ['ul', 'li', 'strong', tag], expected: { size: CODE_INLINE, weight: 'var(--weight-medium)' } })),
  // Table header cells come from src/type-base.css: caption column heads, prose-size row heads.
  { label: 'thead th', path: ['table', 'thead', 'tr', 'th'], expected: THEAD_TH },
  { label: 'tbody th', path: ['table', 'tbody', 'tr', 'th'], expected: TBODY_TH },
];
/** Semantic HTML outside any Markdown root: src/type-base.css alone sizes inline code in p, li, dd and small, never in pre. */
const BASE_TARGETS = [
  ...inlineTargets(BASE_PARENTS, { size: CODE_INLINE, lineHeight: 'inherit' }, 'semantic '),
  ...INLINE_TAGS.map(tag => ({ label: `semantic pre ${tag}`, path: ['pre', tag], expected: { size: '', lineHeight: '' } })),
];
/** Bare Shadow DOM content (custom views, rich HTML) outside any Markdown root reads the same scale as Markdown. */
const BARE_SHADOW_TARGETS = [
  ...['h1', 'h2'].map(tag => ({ label: `bare ${tag}`, path: [tag], expected: { ...HEADING, size: HEADING_LG } })),
  ...['h3', 'h4', 'h5', 'h6'].map(tag => ({ label: `bare ${tag}`, path: [tag], expected: HEADING })),
  ...INLINE_TAGS.map(tag => ({ label: `bare ${tag}`, path: [tag], expected: { size: CODE_INLINE, lineHeight: 'inherit', letter: 'var(--tracking-none)' } })),
  ...inlineTargets(HEADINGS.map(tag => [tag]), { size: CODE_INLINE }, 'bare '),
  { label: 'bare pre', path: ['pre'], expected: { size: 'var(--mono-size)', lineHeight: 'var(--leading-code)' } },
  ...INLINE_TAGS.map(tag => ({ label: `bare pre ${tag}`, path: ['pre', tag], expected: { size: 'inherit', lineHeight: 'inherit' } })),
  { label: 'bare thead th', path: ['table', 'thead', 'tr', 'th'], expected: THEAD_TH },
  { label: 'bare tbody th', path: ['table', 'tbody', 'tr', 'th'], expected: TBODY_TH },
];
const FIELD_LABEL = { size: 'font-size', weight: 'font-weight', lineHeight: 'line-height', letter: 'letter-spacing' };

/**
 * Resolve the effective typography a host's rules give one sample element, once per context
 * scenario. The base scenario has only plain outer ancestors (generic tags, :host); each rule
 * that needs an outer class, id or attribute adds a scenario where only that ancestor exists,
 * so one component's context cannot mask another's override. Within a scenario the highest
 * matching branch specificity, source order and !important decide.
 */
const reachCache = new Map();
export function markdownEffectiveStyles(rules, path, roots, used = null) {
  const hits = [];
  // One key per sample (not per rule): the rule walk below runs for every rule of every host.
  const key = `${path.join('/')}|${roots.join()}`;
  for (const rule of rules) {
    let memo = reachCache.get(rule.selector);
    if (!memo) reachCache.set(rule.selector, memo = new Map());
    let reach = memo.get(key);
    if (reach === undefined) memo.set(key, reach = ruleReach(rule, path, roots));
    if (!reach) continue;
    if (rule.outside) {
      used?.add(rule.outside);
      continue;
    }
    hits.push({ spec: reach.plain || reach.open, order: rule.order, list: rule.list, context: reach.plain ? null : rule.base || rule });
  }
  const resolve = context => {
    const active = hits.filter(hit => !hit.context || hit.context === context).sort((a, b) => compareSpec(a.spec, b.spec) || a.order - b.order);
    return { context: context?.selector || null, file: context?.file || null, style: effectiveStyle(active.flatMap(hit => hit.list)) };
  };
  return [resolve(null), ...hits.filter(hit => hit.context).map(hit => resolve(hit.context))];
}

/** The base-scenario effective style (no outer classes) of one sample element. */
export function markdownEffectiveStyle(rules, path, roots) {
  return markdownEffectiveStyles(rules, path, roots)[0].style;
}

/** Every style rule of a sheet, including rules inside @media/@supports/@container/@layer (conditional drift still breaks parity). */
const ruleCache = new Map();
function styleRules(css, file, offset) {
  const key = `${file}\n${css}`;
  if (!ruleCache.has(key)) {
    ruleCache.set(key, parseBlocks(stripComments(css))
      .filter(block => block.effectiveSelector && !block.selector.startsWith('@') && !/^@(?:keyframes|font-face|property)/i.test(block.parentBlock?.selector || ''))
      .map(block => {
        const outside = MARKDOWN_OUTSIDE.find(item => item.file === file && item.selector === block.effectiveSelector) || null;
        return { file, selector: block.effectiveSelector, order: block.order, list: declarations(block.body), outside };
      }));
  }
  return ruleCache.get(key).map(base => ({ ...base, order: offset + base.order, base }));
}

let diskSheets = null;
/** Read the repo sheets a parity run needs (once), with caller overrides (mutations or synthetic files) on top. */
function loadSheets(overrides) {
  if (!diskSheets) {
    const files = walk(join(root, 'src'), '.css').map(path => relative(root, path).split('\\').join('/'));
    diskSheets = Object.fromEntries(files.map(file => [file, readFileSync(join(root, file), 'utf8')]));
  }
  return { ...diskSheets, ...overrides };
}

const repoPath = path => relative(root, path).split('\\').join('/');
/** Resolve a relative import to a repo file; query imports (`?inline`, `?raw`) never inject a sheet. */
function resolveImport(fromFile, spec) {
  if (!spec.startsWith('.') || spec.includes('?')) return null;
  const base = resolve(root, dirname(fromFile), spec);
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')]) {
    if (existsSync(candidate) && !candidate.endsWith('.d.ts') && (/\.(?:css|tsx?|m?js)$/.test(candidate))) return repoPath(candidate);
  }
  return null;
}
/** Static and dynamic (`import()`) specifiers of one module, in source order; type-only imports are erased. */
function moduleImports(file) {
  const sf = ts.createSourceFile(file, readFileSync(join(root, file), 'utf8'), ts.ScriptTarget.Latest, true, file.endsWith('.tsx') ? ts.ScriptKind.TSX : file.endsWith('.ts') ? ts.ScriptKind.TS : ts.ScriptKind.JS);
  if (sf.parseDiagnostics?.length) throw new Error(`${file} does not parse; the main sheet walk would miss its imports`);
  const imports = { static: [], dynamic: [] };
  const visit = node => {
    if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) imports.static.push(node.moduleSpecifier.text);
    else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) imports.static.push(node.moduleSpecifier.text);
    else if (ts.isCallExpression(node) && node.expression.kind === ts.SyntaxKind.ImportKeyword && node.arguments[0] && ts.isStringLiteralLike(node.arguments[0])) imports.dynamic.push(node.arguments[0].text);
    ts.forEachChild(node, visit);
  };
  visit(sf);
  return imports;
}

/** The main window entry: index.html's module script, then the default (non-launcher, non-tray) branch of src/entry.ts. */
export const MAIN_ENTRY = ['index.html', 'src/entry.ts', 'src/main.ts'];
/** Modules main.ts loads only in the browser preview (`?ds` gallery, preview mocks), never in the app window. */
const PREVIEW_ONLY = /^src\/(?:preview(?:[-.]|$)|redesign\/gallery\.ts$)/;
let mainOrder = null;
/**
 * Every sheet the main document loads, in cascade order: a depth-first walk of static imports
 * in source order (a CSS file's @imports precede its own rules), then each dynamic import
 * boundary in discovery order. Sheets reached twice keep their first position.
 */
export function mainDocumentSheets() {
  if (mainOrder) return mainOrder;
  const html = readFileSync(join(root, MAIN_ENTRY[0]), 'utf8');
  const entry = /<script[^>]*type="module"[^>]*src="\/([^"]+)"/.exec(html)?.[1];
  if (entry !== MAIN_ENTRY[1]) throw new Error(`index.html module script is ${entry}, expected ${MAIN_ENTRY[1]}`);
  if (!moduleImports(entry).dynamic.some(spec => resolveImport(entry, spec) === MAIN_ENTRY[2])) throw new Error(`${entry} no longer imports ${MAIN_ENTRY[2]}`);
  const order = [], seen = new Set(), pending = [MAIN_ENTRY[2]];
  const visitCss = file => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const match of stripComments(readFileSync(join(root, file), 'utf8')).matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g)) {
      const next = resolveImport(file, match[1]);
      if (next?.endsWith('.css')) visitCss(next);
    }
    order.push(file);
  };
  const visit = file => {
    if (seen.has(file) || PREVIEW_ONLY.test(file)) return;
    if (file.endsWith('.css')) { visitCss(file); return; }
    seen.add(file);
    const { static: statics, dynamic } = moduleImports(file);
    for (const spec of statics) { const next = resolveImport(file, spec); if (next) visit(next); }
    for (const spec of dynamic) { const next = resolveImport(file, spec); if (next) pending.push(next); }
  };
  while (pending.length) visit(pending.shift());
  mainOrder = order;
  return order;
}

/** The main-document sheet set in import order, with synthetic override sheets (not on disk) appended last. */
export function mainMarkdownSheets(sheets = {}) {
  const order = mainDocumentSheets();
  return [...order, ...Object.keys(sheets).filter(file => !order.includes(file) && !(diskSheets && file in diskSheets) && !existsSync(join(root, file)))];
}

/** Every Markdown host with its ordered sheets and root classes. */
export function markdownHosts(sheets = {}) {
  return [
    { files: ['src/type-base.css'], roots: [], targets: BASE_TARGETS, label: 'src/type-base.css (semantic HTML)' },
    { files: mainMarkdownSheets(sheets), roots: ['markdown', 'rich-markdown'], label: 'main document' },
    { files: ['src/type-base.css', 'src/overlay.css'], roots: ['launcher-thread-message', 'markdown'] },
    { files: ['src/type-base.css', 'src/shadow-base.css'], roots: ['markdown'] },
    { files: ['src/type-base.css', 'src/shadow-base.css'], roots: [], targets: BARE_SHADOW_TARGETS, label: 'src/type-base.css + src/shadow-base.css (bare Shadow DOM)', skip: /\.markdown(?![-\w])/ },
    { files: ['src/type-base.css', 'src/shadow-base.css', 'src/rich-markdown.css', 'src/generative-ui.css'], roots: ['markdown', 'gu-md', 'rich-markdown'] },
  ];
}

/** Each prose sheet keeps the Markdown prose size and leading pair on its root and paragraphs. */
function proseProblems(sheets) {
  const problems = [];
  const prose = { 'font-size': 'var(--thread-font)', 'line-height': 'var(--type-prose-leading)' };
  for (const file of PROSE_FILES) {
    const rules = parseBlocks(stripComments(sheets[file]));
    const launcher = file === 'src/overlay.css';
    const read = selectors => Object.assign({}, ...rules.filter(rule => selectors.includes(rule.selector))
      .map(rule => Object.fromEntries(declarations(rule.body).map(decl => [decl.property, decl.value]))));
    const actualProse = launcher ? { ...read(['.launcher-thread-message']), ...read(['.launcher-thread-message .markdown']) } : read(['.markdown']);
    if (launcher && actualProse['font-size'] === read([':root'])['--thread-font']) actualProse['font-size'] = 'var(--thread-font)';
    const check = (label, actual) => {
      for (const [property, value] of Object.entries(prose)) if (actual[property] !== value) problems.push(`${file}: Markdown ${label} needs ${property}:${value}, got ${actual[property] || '(missing)'}`);
    };
    check('prose', actualProse);
    // Paragraphs inherit the prose pair; explicit drift cannot silently escape parity.
    check('p', { ...actualProse, ...read([`${launcher ? '.launcher-thread-message' : '.markdown'} p`]) });
  }
  return problems;
}

const fieldOk = (got, value) => (Array.isArray(value) ? value : [value]).some(option => got === option.replace(/\s+/g, '')
  || (option === '' && /^(?:inherit|unset)$/i.test(got)));

/** Lock shared Markdown typography by resolving the effective style of each Markdown element in every host.
 * `overrides` maps repo-relative sheet paths to replacement (or synthetic) CSS; everything else is read from src/.
 */
export function markdownTypographyProblems(overrides = {}) {
  const sheets = loadSheets(overrides);
  const problems = proseProblems(sheets);
  const used = new Set();
  for (const host of markdownHosts(sheets)) {
    // Bare Shadow DOM content sits under no Markdown root, so rules whose every branch is scoped to one never reach it (the Markdown host covers them).
    const rules = host.files.flatMap((file, index) => styleRules(sheets[file] ?? '', file, index * 1e6)).filter(rule => !host.skip || !splitTop(rule.selector, /,/).every(branch => host.skip.test(branch)));
    const label = host.label === 'main document' ? `main document (${host.files.length} sheets)` : host.label || host.files.join(' + ');
    for (const target of host.targets || MARKDOWN_TARGETS) {
      for (const { style, context, file } of markdownEffectiveStyles(rules, target.path, host.roots, used)) {
        const where = context ? `${label} under ${file} ${context}` : label;
        for (const [field, value] of Object.entries(target.expected)) {
          const got = (style[field] || '').replace(/\s+/g, '');
          if (!fieldOk(got, value)) problems.push(`${where}: ${host.targets ? '' : 'Markdown '}${target.label} needs ${FIELD_LABEL[field]}:${[value].flat()[0] || '(inherited)'}, got ${style[field] || '(inherited)'}`);
        }
      }
    }
  }
  for (const item of MARKDOWN_OUTSIDE) if (!used.has(item)) problems.push(`${item.file}: ${item.selector}: unused MARKDOWN_OUTSIDE entry (it no longer reaches a Markdown sample)`);
  return problems;
}
