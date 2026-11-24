/**
 * Static design-token guard, part 4: documentation, base resets and parity.
 * Docs locks keep the visible scale, alias table and em tokens equal to the CSS; the base
 * reset locks pin src/type-base.css and src/shadow-base.css; Markdown parity resolves
 * effective typography per host (and bare Shadow DOM content); standalone windows follow
 * their runtime imports and reject unresolved or cyclic var() chains. The Shadow DOM flow
 * and attachShadow inventory live in design-tokens-flow.test.mjs.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import ts from 'typescript';
import { root, FONT_SIZE_NAME, EM_SIZES, ALIAS_VALUES, EM_TOKENS, EM_TOKEN_NAME, MARKDOWN_OUTSIDE } from './design-tokens/allowlists.mjs';
import {
  scanCss, tokenMap, tokensCss, declarations, eachVar, stripComments, parseBlocks, directBody, rootSelector,
  splitTop, parseSelectorChain, extractCompoundParts,
} from './design-tokens/parser.mjs';
import {
  loadRulebook, compareRulebook, compareAliases, unexpectedLocked, emTokenDocProblems, agentsEmValueProblems,
  markdownTypographyProblems, markdownHosts, mainMarkdownSheets,
} from './design-tokens/docs.mjs';
import { normalizeRepoPath } from './design-tokens/ts-style.mjs';
import { baseSheetFlowProblems, componentSheetFlow } from './design-tokens/flow.mjs';

test('documented scale and alias locks reject drift', () => {
  const book = loadRulebook();
  assert.ok(unexpectedLocked(['--radius-blob'], book.expected).length, 'new radius token');
  assert.ok(unexpectedLocked(['--row-xl'], book.expected).length, 'new row height token');
  assert.ok(unexpectedLocked(['--control-xl'], book.expected).length, 'new control height token');
  assert.equal(unexpectedLocked(['--radius-card'], book.expected).join(''), '');
  assert.equal(unexpectedLocked(['--sans', '--row', '--row-sm', '--control', '--mono-size'], book.expected).join(''), '');
  const drifted = new Map(tokenMap(tokensCss));
  drifted.set('--type-body', '1.2rem');
  assert.ok(compareRulebook(drifted, book).some(hit => hit.includes('--type-body')), compareRulebook(drifted, book).join(' | '));
  for (const [token, badVal] of [
    ['--root-size', '15px'],
    ['--mono-size', 'var(--type-body)'],
    ['--sans', 'Arial,sans-serif'],
    ['--mono', 'Courier,monospace'],
  ]) {
    const coreDrift = new Map(tokenMap(tokensCss));
    coreDrift.set(token, badVal);
    assert.ok(compareRulebook(coreDrift, book).some(hit => hit.includes(token)), `${token}: ${compareRulebook(coreDrift, book).join(' | ')}`);
  }
  assert.equal(compareRulebook(tokenMap(tokensCss), book).join('\n'), '');
  const tracked = loadRulebook();
  tracked.roles.find(role => role.name === '--type-body').tracking = '--tracking-caps';
  assert.ok(compareRulebook(tokenMap(tokensCss), tracked).some(hit => hit.includes('tracking')));
  assert.deepEqual(compareAliases(ALIAS_VALUES, book.aliases), []);

});

test('visible alias table and documented role and radius values stay locked', () => {
  const md = readFileSync(join(root, 'docs/agent-reference.md'), 'utf8');
  const table = (rows, heading = '### Aliases') => `${heading}\n\n| alias | value | defined in |\n| --- | --- | --- |\n${rows}\n`;
  const row = '| `--sample-radius` | `var(--radius-chip)` or `0px` | `src/x.css` |';
  const spec = new Map([['--sample-radius', { values: new Set(['var(--radius-chip)', '0']), files: new Set(['src/x.css']) }]]);
  const compare = rows => compareAliases(spec, loadRulebook(table(rows)).aliases);
  assert.deepEqual(compare(row), [], 'normalizes 0px to 0');
  assert.deepEqual(compareAliases(spec, loadRulebook(`See ### Aliases below.\n\n${table(row)}`).aliases), [], 'only an actual heading starts the table section');
  assert.ok(compare('').some(hit => hit.includes('missing from docs')));
  assert.ok(compare(row.replace('var(--radius-chip)', 'var(--radius-card)')).some(hit => hit.includes('values in ALIAS_VALUES')));
  assert.ok(compare(row.replace('src/x.css', 'src/y.css')).some(hit => hit.includes('owners in ALIAS_VALUES')));
  assert.ok(compare(`${row}\n| \`--extra-radius\` | \`0\` | \`src/x.css\` |`).some(hit => hit.includes('--extra-radius')));
  assert.throws(() => loadRulebook(''), /exactly one ### Aliases/);
  assert.throws(() => loadRulebook(`${table(row)}\n${table(row)}`), /exactly one ### Aliases/);
  assert.throws(() => loadRulebook(table(row).replace('| value |', '| values |')), /alias \| value \| defined in/);
  const roleDrift = md.replace('`--type-heading-weight` (strong)', '`--type-heading-weight` (medium)');
  assert.notEqual(roleDrift, md, 'role pairing sample actually changes the docs');
  assert.ok(compareRulebook(tokenMap(tokensCss), loadRulebook(roleDrift)).some(hit => hit.includes('--type-heading-weight')));
  const radiusDrift = md.replace('| `--radius-card` | 16px |', '| `--radius-card` | 17px |');
  assert.notEqual(radiusDrift, md, 'radius sample actually changes the docs');
  assert.ok(compareRulebook(tokenMap(tokensCss), loadRulebook(radiusDrift)).some(hit => hit.includes('--radius-card')));
});

test('styles.css and Shadow DOM base stylesheets keep the base type resets', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const base = stripComments(read('src/type-base.css')).trim();
  assert.equal(base.replace(/\s+/g, ''), [
    ':where(strong,b,th){font-weight:var(--weight-medium)}',
    ':where(small){font-size:var(--type-meta);font-weight:var(--weight-regular);line-height:var(--type-meta-leading);letter-spacing:var(--tracking-none)}',
    ':where(h1,h2,h3,h4,h5,h6){margin:0;font-size:inherit;font-weight:inherit}',
    ':where(h1,h2,h3,h4,h5,h6) :where(strong,b){font-weight:inherit}',
    ':where(code,pre,samp,tt){font-family:var(--mono)}',
    // Semantic elements only; component copy (settings, empty states, cards) sizes its own code in styles.css.
    ':where(:is(p,li,dd,small) :is(code,samp,tt):not(pre *)){font-size:var(--code-inline-size);line-height:inherit}',
    '.markdown :is(thead th:not([scope="row" i],[scope="rowgroup" i]),th:is([scope="col" i],[scope="colgroup" i])){font-size:var(--type-caption);font-weight:var(--weight-medium);line-height:var(--type-caption-leading);letter-spacing:var(--tracking-none)}',
    '.markdown :is(tbody th:not([scope="col" i],[scope="colgroup" i]),th:is([scope="row" i],[scope="rowgroup" i])){font-size:1em;font-weight:var(--weight-medium);line-height:inherit;letter-spacing:var(--tracking-none)}',
    'kbd{font-family:var(--sans);font-size:var(--type-caption);font-weight:var(--weight-regular);line-height:var(--type-caption-leading);letter-spacing:var(--tracking-none);white-space:nowrap}',
  ].join('').replace(/\s+/g, ''), 'shared reset keeps the complete ordered rule list');
  assert.match(base, /(?:^|[\s}])kbd\{[^}]*letter-spacing:var\(--tracking-none\)/, 'shared kbd keeps tracking-none');
  for (const file of ['src/styles.css', 'src/overlay.css', 'src/tray-popover.css']) {
    assert.match(read(file), /^@import ['"]\.\/tokens\.css['"];\s*@import "\.\/type-base\.css";/, `${file} imports shared reset immediately after tokens`);
  }
  assert.deepEqual(baseSheetFlowProblems(read('src/generative-ui.ts'), read('src/rich-markdown.ts')), [], 'both shared sheets reach generativeSheet(), renderBlock() and the rich-html shadow root');
  const custom = read('src/generative-ui-components.ts');
  assert.doesNotMatch(custom, /(?:import\s+[^;]*?from\s*|import\s*\(|import\s*)['"][^'"]*\.css(?:\?[^'"]*)?['"]/, 'pure component module has no CSS import');
  const { problems: componentProblems, customBase } = componentSheetFlow(custom);
  assert.deepEqual(componentProblems, []);
  const shadow = stripComments(read('src/shadow-base.css')).trim();
  const shadowRules = parseBlocks(shadow);
  // Heading reset, heading bold and heading code come from src/type-base.css and the shared code rules; restating them here was redundant.
  // The four .markdown duplicates of the bare heading, code and pre rules were pruned: the bare rules already reach Markdown.
  for (const selector of [':where(h1,h2,h3,h4,h5,h6)', ':where(h1,h2,h3,h4,h5,h6) :where(strong,b)', ':where(h1,h2,h3,h4,h5,h6) :is(code,samp)',
    '.markdown :is(h1,h2,h3,h4,h5,h6)', '.markdown :is(h1,h2)', '.markdown code', '.markdown pre', ':where(pre :is(code,samp)),.markdown pre :is(code,samp)']) {
    assert.ok(!shadowRules.some(block => block.selector === selector), `shared shadow reset no longer repeats ${selector}`);
  }
  const ROW_TH = ':where(tbody th:not([scope="col" i],[scope="colgroup" i]),th:is([scope="row" i],[scope="rowgroup" i]))';
  for (const selector of [':host', '*', '.markdown', ':where(code,samp,tt)', 'pre', ':where(p,li,blockquote,dd,td) :where(strong,b)', ':where(strong,b) :is(code,samp,tt)', ':where(pre :is(code,samp,tt))', ':where(h1,h2)', ':where(h3,h4,h5,h6)',
    ':where(thead th:not([scope="row" i],[scope="rowgroup" i]),th:is([scope="col" i],[scope="colgroup" i]))', ROW_TH]) {
    assert.ok(shadowRules.some(block => block.selector === selector), `shared shadow reset contains ${selector}`);
  }
  const shadowDecls = selector => Object.fromEntries(declarations(shadowRules.find(block => block.selector === selector)?.body || '').map(({ property, value }) => [property, value]));
  const inlineCode = { 'font-size': 'var(--code-inline-size)', 'line-height': 'inherit', 'letter-spacing': 'var(--tracking-none)' };
  assert.deepEqual(shadowDecls(':where(code,samp,tt)'), inlineCode, 'every Shadow DOM inline code, samp and tt is 0.9em with inherited leading');
  assert.deepEqual(shadowDecls('pre'), { 'font-size': 'var(--mono-size)', 'line-height': 'var(--leading-code)' }, 'only pre defaults to the mono size');
  const host = shadowDecls(':host');
  assert.deepEqual([host['font-size'], host['line-height']], ['inherit', 'inherit'], 'Shadow DOM hosts inherit the surrounding size and leading (16px main, 12px compact, 14px custom views)');
  assert.deepEqual(shadowDecls(':where(h1,h2)'), { 'font-size': 'var(--md-heading-lg)', 'font-weight': 'var(--weight-strong)', 'line-height': 'var(--type-title-leading)', 'letter-spacing': 'var(--tracking-none)' }, 'bare h1/h2 scale with context like Markdown h1/h2, with tracking-none');
  assert.deepEqual(shadowDecls(':where(h3,h4,h5,h6)'), { 'font-size': '1em', 'font-weight': 'var(--weight-strong)', 'line-height': 'var(--type-title-leading)', 'letter-spacing': 'var(--tracking-none)' }, 'bare h3-h6 are 1em strong (600), like Markdown');
  assert.deepEqual(shadowDecls(':where(pre :is(code,samp,tt))'), { 'font-size': 'inherit', 'line-height': 'inherit' }, 'pre code, samp and tt inherit the pre size');
  assert.deepEqual(shadowDecls(':where(strong,b) :is(code,samp,tt)'), { 'font-weight': 'var(--weight-medium)' }, 'bold code, samp and tt stay medium');
  assert.deepEqual(shadowDecls(':where(p,li,blockquote,dd,td) :where(strong,b)'), { 'font-weight': 'var(--weight-strong)' }, 'rich-HTML prose bold matches Markdown strong (600)');
  const styles = stripComments(read('src/styles.css'));
  assert.ok(styles.includes(':where(:is(.setting-desc,.inspector-empty,.connection-card) :is(code,samp,tt):not(pre *)){font-size:var(--code-inline-size);line-height:inherit}'), 'light-DOM component inline code, samp and tt live in styles.css');
  assert.deepEqual(shadowDecls(ROW_TH), { 'font-size': '1em', 'font-weight': 'var(--weight-medium)', 'line-height': 'inherit', 'letter-spacing': 'var(--tracking-none)' }, 'bare Shadow DOM row headers scale with context like Markdown row headers');
  assert.ok(customBase && ts.isStringLiteral(customBase), 'custom base remains inspectable CSS');
  const customBlocks = parseBlocks(customBase.text);
  assert.equal(customBlocks.filter(block => block.selector === ':host').map(block => block.body).join('|'), 'overflow:auto', 'custom host adds only its view-specific override');
  for (const block of customBlocks) {
    const own = new Set(declarations(block.body).map(decl => decl.property));
    for (const selector of splitTop(block.selector, /,/)) {
      for (const shared of shadowRules.filter(rule => splitTop(rule.selector, /,/).includes(selector))) {
        const repeated = declarations(shared.body).map(decl => decl.property).filter(property => own.has(property));
        assert.deepEqual(repeated, [], `CUSTOM_BASE does not redeclare shared ${selector} properties`);
      }
    }
  }
});

const MARKDOWN_SHEETS = ['src/styles.css', 'src/overlay.css', 'src/shadow-base.css', 'src/generative-ui.css'];
const readSheet = file => readFileSync(join(root, file), 'utf8');
const markdownPrefix = file => file === 'src/overlay.css' ? '.launcher-thread-message' : file === 'src/generative-ui.css' ? ':is(.gu-md,.rich-markdown)' : '.markdown';
const withRule = (file, rule) => markdownTypographyProblems({ [file]: readSheet(file) + rule });

test('Markdown prose, headings, emphasis, inline code and pre typography stay in parity', () => {
  assert.deepEqual(markdownTypographyProblems(), []);
  for (const file of ['src/styles.css', 'src/overlay.css', 'src/shadow-base.css']) {
    const source = readSheet(file);
    const prefix = markdownPrefix(file);
    for (const [from, to] of [
      ['var(--type-prose-leading)', 'var(--type-body-leading)'],
      ['font-size:1em', 'font-size:1.1em'],
      ['font-size:var(--md-heading-lg)', 'font-size:1.2em'],
      ['var(--weight-strong)', 'var(--weight-regular)'],
      ['var(--type-title-leading)', 'var(--type-body-leading)'],
      ['var(--tracking-none)', 'var(--tracking-tight)'],
      ['font-size:var(--code-inline-size)', 'font-size:.8em'],
      ['font-size:var(--mono-size)', 'font-size:var(--type-body)'],
      ['line-height:var(--leading-code)', 'line-height:normal'],
    ]) {
      // Replace all occurrences so unrelated earlier rules do not mask the sample.
      const mutated = source.replaceAll(from, to);
      assert.notEqual(mutated, source, `${file} ${from}`);
      assert.ok(markdownTypographyProblems({ [file]: mutated }).length, `${file} ${from}`);
    }
    assert.ok(withRule(file, `${prefix} p{font-size:var(--type-body)}`).length, `${file} paragraph drift`);
    assert.ok(withRule(file, `${prefix} :is(strong,b) code{font-weight:var(--weight-regular)}`).length, `${file} emphasis code drift`);
  }
});

test('Markdown parity covers emphasis, deleted, term, tfoot, loose nested list and list-bold code plus nested quotes and captions', () => {
  for (const [rule, label] of [
    ['.markdown em code{font-size:1em}', 'inline p > em > code'],
    ['.markdown del code{font-size:1em}', 'inline p > del > code'],
    ['.markdown dt code{font-size:1em}', 'inline dl > dt > code'],
    ['.markdown tfoot td code{font-size:1em}', 'inline table > tfoot > tr > td > code'],
    ['.markdown li li p code{font-size:1em}', 'inline ul > li > ul > li > p > code'],
    ['.markdown li strong code{font-weight:var(--weight-strong)}', 'li strong code'],
    ['.markdown blockquote blockquote{font-size:1.2em}', 'nested blockquote'],
    ['.markdown caption{font-size:1.2em}', 'caption'],
  ]) {
    const hits = withRule('src/styles.css', rule);
    assert.ok(hits.some(hit => hit.includes(`Markdown ${label} needs`)), `${rule} fails as ${label}:\n${hits.slice(0, 3).join('\n')}`);
  }
});

test('Markdown parity covers every heading code path, heading bold, nested lists, quotes, tfoot and bare Shadow DOM', () => {
  for (const file of ['src/styles.css', 'src/shadow-base.css']) {
    for (const rule of [
      '.markdown h1 code{font-size:1em}',
      '.markdown h3 code{font-size:1em}',
      '.markdown h6 code{font-size:1em}',
      '.markdown ul ul li{font-size:1.2em}',
      '.markdown ul ul{font-size:1.2em}',
      '.markdown ol ol li code{font-size:1em}',
      '.markdown blockquote p{font-size:1.2em}',
      '.markdown tfoot td{font-size:1.2em}',
      '.markdown tfoot{font-size:1.2em}',
      '.markdown tfoot th{font-weight:var(--weight-regular)}',
      '.markdown h2 strong{font-weight:var(--weight-regular)}',
      '.markdown h2 b{font-weight:var(--weight-regular)}',
      '.markdown h3 strong{font-weight:var(--weight-medium)}',
    ]) assert.ok(withRule(file, rule).length, `${file}: ${rule}`);
  }
  for (const rule of ['.markdown samp{font-size:1em}', '.markdown tt{font-size:1em}', '.markdown ul ul ul li{font-size:.9em}', '.markdown pre tt{font-size:1em}']) {
    assert.ok(withRule('src/styles.css', rule).length, `Light DOM samp/tt and 3-level list drift: ${rule}`);
  }
  assert.deepEqual(withRule('src/styles.css', '.markdown ul ul ul ul li{font-size:.9em}'), [], 'four-level lists sit outside the sampled paths (documented boundary)');
  for (const rule of ['.markdown ul ul ul{font-size:1.2em}', '.markdown ol ol{font-size:1.2em}', '.markdown ul ul ul li code{font-size:1em}',
    '.markdown ol li samp{font-size:1em}', '.markdown h4 samp{font-size:1em}', '.markdown td samp{font-size:1em}']) {
    assert.ok(withRule('src/styles.css', rule).length, `3-level list wrappers and samp/tt on every inline-code path: ${rule}`);
  }
  for (const rule of [':where(dd tt){font-size:1em}', ':where(li samp){font-size:1em}']) {
    assert.ok(withRule('src/type-base.css', rule).some(hit => hit.startsWith('src/type-base.css (semantic HTML)')), `semantic HTML samp/tt: ${rule}`);
  }
  assert.ok(withRule('src/shadow-base.css', 'h5 samp{font-size:1em}').some(hit => hit.includes('(bare Shadow DOM)')), 'bare Shadow DOM heading samp');
  const bare = rule => withRule('src/shadow-base.css', rule).filter(hit => hit.includes('(bare Shadow DOM)'));
  for (const rule of [
    ':where(tt){font-size:1em}',
    ':where(pre tt){font-size:var(--code-inline-size)}',
    ':where(h1,h2){letter-spacing:var(--tracking-tight)}',
    ':where(h1,h2){font-size:1.4em}',
    ':where(h4){font-size:1.1em}',
    ':where(samp){font-size:1em}',
    'pre{line-height:normal}',
    ':where(pre code){font-size:var(--code-inline-size)}',
    ':where(thead th){font-size:var(--type-body)}',
    ':where(tbody th){font-weight:var(--weight-regular)}',
  ]) assert.ok(bare(rule).length, `bare Shadow DOM: ${rule}`);
  // A rule scoped only to a Markdown root never reaches bare Shadow DOM content (the Markdown host locks it).
  assert.deepEqual(bare('.markdown h1{font-size:1.4em}'), [], 'Markdown-only rules are out of bare scope');
  assert.ok(markdownHosts().some(host => host.label?.includes('bare Shadow DOM') && host.roots.length === 0), 'bare Shadow DOM host has no Markdown root');
});

test('Markdown parity resolves the effective style of every rule reaching a Markdown element', () => {
  for (const file of MARKDOWN_SHEETS) {
    const prefix = markdownPrefix(file);
    for (const rule of [
      `${prefix} h2{font-size:1.4em}`,
      `${prefix} :not(pre)>code{font-size:1em}`,
      `${prefix} h1{line-height:1}`,
      `${prefix} strong{font-weight:var(--weight-medium)}`,
      `${prefix} h4{letter-spacing:var(--tracking-tight)}`,
      `${prefix} b code{font-weight:var(--weight-regular)}`,
      `${prefix} pre{line-height:var(--type-body-leading)}`,
      `${prefix} pre code{font-size:1em!important}`,
      `${prefix} th{font-weight:var(--weight-strong)!important}`,
      `${prefix} tbody th{font-size:var(--type-caption)!important}`,
      `@media (max-width:600px){${prefix} h3{font-size:1.2em}}`,
      `:where(${prefix}) :is(h5,h6){font-size:1.1em!important}`,
      `.agent-message ${prefix} h2{font-size:1.4em}`,
      `${prefix} td code{font-size:1em}`,
      `${prefix} h2 code{font-size:1.2em}`,
      `${prefix} blockquote code{font-size:1em}`,
      `${prefix} a code{font-size:1em}`,
      `${prefix} small code{font-size:1em}`,
      `${prefix} thead th code{font-size:1em}`,
      `${prefix} em strong{font-weight:var(--weight-medium)}`,
    ]) {
      assert.ok(withRule(file, rule).length, `${file}: ${rule}`);
    }
  }
  // Specificity is honoured: a weaker selector that loses the cascade does not change the effective style.
  assert.deepEqual(withRule('src/styles.css', ':where(.markdown) :where(h2){font-size:1.4em}'), []);
  assert.deepEqual(withRule('src/styles.css', '.markdown .note h2{color:red}.markdown h2::before{font-size:1em}'), []);
});

test('Markdown parity treats unknown outer ancestors as able to reach Markdown', () => {
  for (const [file, rule] of [
    ['src/styles.css', '.agent-message code{font-size:1em}'],
    ['src/styles.css', '.conversation-pane h2{font-size:1.4em}'],
    ['src/shadow-base.css', ':host code{font-size:1em}'],
    ['src/generative-ui.css', '.gu-card code{font-size:1em}'],
    ['src/styles.css', 'div code{font-size:1em!important}'],
    ['src/turn-card.css', 'section h3{font-size:1.3em!important}'],
    ['src/rich-markdown.css', '.rich-markdown h2{font-size:1.4em}'],
    ['src/styles.css', '#thread [data-x] .markdown strong{font-weight:var(--weight-medium)}'],
  ]) assert.ok(withRule(file, rule).length, `${file}: ${rule}`);
  // Each outer context is its own scenario: a later same-specificity rule for another component cannot mask it.
  assert.ok(markdownTypographyProblems({ 'src/styles.css': readSheet('src/styles.css') + '.agent-message code{font-size:1em}', 'src/zz-late.css': '.markdown-free code{font-size:var(--code-inline-size)}' }).length);
  // The main document is every sheet main.ts loads, in import order, whether or not it names a Markdown root.
  const main = mainMarkdownSheets();
  for (const [before, after] of [['src/tokens.css', 'src/type-base.css'], ['src/type-base.css', 'src/styles.css'], ['src/styles.css', 'src/design-system.css'], ['src/design-system.css', 'src/turn-card.css']]) {
    assert.ok(main.indexOf(before) >= 0 && main.indexOf(before) < main.indexOf(after), `${before} loads before ${after}`);
  }
  for (const file of ['src/agent-teams.css', 'src/settings.css', 'src/rich-markdown.css', 'src/architect.css']) assert.ok(main.includes(file), `${file} is a main-document sheet`);
  for (const file of ['src/overlay.css', 'src/tray-popover.css', 'src/generative-ui.css', 'src/shadow-base.css', 'src/redesign/gallery.css']) assert.ok(!main.includes(file), `${file} is standalone, inline or preview-only`);
  assert.ok(markdownTypographyProblems({ 'src/new-feature.css': '.markdown code{font-size:1em}' }).length, 'a synthetic sheet not yet imported still joins the main host');
  for (const host of markdownHosts()) assert.ok(host.files.length, 'every host has sheets');
  assert.deepEqual(markdownHosts().at(-1).files, ['src/type-base.css', 'src/shadow-base.css', 'src/rich-markdown.css', 'src/generative-ui.css'], 'generativeSheet() layers rich-markdown before generative-ui');
  // Reviewed component exemptions carry reasons and stay live.
  for (const entry of MARKDOWN_OUTSIDE) assert.ok(entry.reason.trim(), entry.selector);
  const stale = markdownTypographyProblems({ 'src/styles.css': readSheet('src/styles.css').replace('.welcome h1{', '.welcome-gone h1{') });
  assert.ok(stale.some(hit => hit.includes('.welcome h1: unused MARKDOWN_OUTSIDE entry')), 'a stale exemption fails');
});

test('Markdown parity evaluates complex :not(), real list paths, parent sizes and every main-document sheet', () => {
  const typeBase = readSheet('src/type-base.css');
  const inlineCode = typeBase.replace(':is(code,samp,tt):not(pre *)){font-size:var(--code-inline-size)', ':is(code,samp,tt):not(pre *)){font-size:2em');
  assert.notEqual(inlineCode, typeBase, 'type-base inline-code sample changes the sheet');
  assert.ok(markdownTypographyProblems({ 'src/type-base.css': inlineCode }).some(hit => hit.startsWith('src/type-base.css (semantic HTML)')), 'type-base inline code at 2em');
  for (const [file, rule] of [
    // :not(<complex>) is matched against the full ancestor chain, so inline code is reached.
    ['src/styles.css', '.markdown code:not(pre code){font-size:1em}'],
    ['src/styles.css', '.markdown p code:not(pre code){font-size:1em}'],
    ['src/styles.css', '.markdown code:not(pre *){font-size:1em}'],
    // List items sit in ul/ol, and loose items wrap their text in p.
    ['src/styles.css', '.markdown ul code{font-size:1em}'],
    ['src/styles.css', '.markdown ol > li code{font-size:1em}'],
    ['src/styles.css', '.markdown ul li code{font-size:1em}'],
    ['src/styles.css', 'ul.foo code{font-size:1em}'],
    ['src/styles.css', '.markdown li > p > code{font-size:1em}'],
    ['src/overlay.css', '.launcher-thread-message ul code{font-size:1em}'],
    // Prose containers and inline wrappers keep the inherited prose size.
    ['src/styles.css', '.markdown blockquote{font-size:1.2em}'],
    ['src/styles.css', '.markdown li{font-size:1.3em}'],
    ['src/styles.css', '.markdown a{font-size:1.4em}'],
    ['src/styles.css', '.markdown em{font-size:1.4em}'],
    ['src/styles.css', '.markdown dd{font-size:1.2em}'],
    ['src/styles.css', '.markdown td{font-size:1.2em}'],
    // Wrappers would scale every list item or cell inside them.
    ...['ul', 'ol', 'table', 'tbody', 'tr', 'dl'].map(tag => ['src/styles.css', `.markdown ${tag}{font-size:1.2em}`]),
    ['src/shadow-base.css', '.markdown ul{font-size:1.2em}'],
    ['src/styles.css', '.markdown p{letter-spacing:var(--tracking-tight)}'],
    ['src/shadow-base.css', '.markdown h5 code{font-size:1em}'],
    ['src/shadow-base.css', '.markdown dd code{font-size:1em}'],
    // A main-document sheet that never names a Markdown root still wraps Markdown.
    ['src/agent-teams.css', '.agent-team-card code{font-size:1em}'],
  ]) assert.ok(withRule(file, rule).length, `${file}: ${rule}`);
  const notPre = withRule('src/styles.css', '.markdown code:not(pre code){font-size:1em}');
  assert.ok(!notPre.some(hit => /Markdown pre code needs/.test(hit)), 'code:not(pre code) never reaches code inside pre');
  assert.deepEqual(withRule('src/styles.css', '.markdown pre code:not(pre code){font-size:1em}.markdown pre code:not(pre *){font-size:1em}'), [], 'a :not() that excludes the element is not a reach');
  assert.deepEqual(withRule('src/styles.css', '.markdown a.citation{font-size:1.4em}'), [], 'a class on the sample subject is a distinct element kind (documented boundary)');
});

test('canonical em tokens derive from one list, are defined once, documented from live values and paired with code leadings', () => {
  const map = tokenMap(tokensCss);
  assert.deepEqual(EM_TOKENS, ['--code-inline-size', '--md-heading-lg', '--md-cite-size', '--md-katex-size']);
  for (const name of EM_TOKENS) {
    assert.match(map.get(name) || '', /^\d*\.?\d+em$/, `${name} is an em size in src/tokens.css`);
    assert.ok(EM_TOKEN_NAME.test(name) && FONT_SIZE_NAME.test(name), `${name} is a font-size token`);
    assert.ok(scanCss('src/x.css', `.a{${name}:1em}`, new Set(), new Map(), new Set()).some(hit => /redefines canonical token/.test(hit)), `${name} redefinition outside tokens.css`);
  }
  assert.ok(!EM_TOKEN_NAME.test('--md-code-size') && !EM_TOKEN_NAME.test('--md-tone'), 'the old name and unrelated --md-* names are not em tokens');
  const md = readFileSync(join(root, 'docs/agent-reference.md'), 'utf8');
  assert.deepEqual(emTokenDocProblems(map, md), []);
  assert.ok(emTokenDocProblems(map, md.replace('`--code-inline-size` is `.9em`', '`--code-inline-size` is `.85em`')).length, 'doc drift fails');
  assert.ok(emTokenDocProblems(new Map([...map, ['--md-cite-size', '.8em']]), md).length, 'token drift fails');
  const agents = readFileSync(join(root, 'AGENTS.md'), 'utf8'); assert.deepEqual(agentsEmValueProblems(map, agents), []);
  assert.ok(agentsEmValueProblems(map, agents.replace('`--code-inline-size` (0.9em)', '`--code-inline-size` (0.85em)')).length, 'AGENTS.md quoted-value drift fails');
  assert.ok(agentsEmValueProblems(map, agents.replace('`--code-inline-size` (0.9em)', '`--code-inline-size`')).length, 'AGENTS.md must keep quoting the value');
  assert.ok(agentsEmValueProblems(new Map([...map, ['--code-inline-size', '.85em']]), agents).length, 'token drift against AGENTS.md fails');
  const css = source => scanCss('src/x.css', source, new Set(), new Map(), new Set());
  for (const lh of ['inherit', 'var(--type-meta-leading)', 'var(--type-body-leading)', 'var(--type-caption-leading)']) assert.deepEqual(css(`.a code{font-size:var(--code-inline-size);line-height:${lh}}`), [], lh);
  assert.deepEqual(css('.a code{font-family:var(--mono);font-size:var(--code-inline-size);line-height:var(--leading-code)}'), []);
  for (const lh of ['var(--type-title-leading)', 'var(--type-prose-leading)', 'normal', '1.4']) assert.ok(css(`.a code{font-size:var(--code-inline-size);line-height:${lh}}`).length, lh);
  assert.ok(css('.a{font-size:.9em}').length, 'a literal em outside EM_SIZES still fails');
  assert.ok(css('.a{font-size:var(--md-code-size)}').length, 'the retired name is an undefined token');
  assert.ok(EM_SIZES.length <= 6, 'EM_SIZES keeps only the literal em exceptions the tokens cannot express');
});

test('standalone window entrypoints resolve transitive imported tokens without IACVT', () => {
  const resolveImport = (fromFile, spec) => {
    if (!spec.startsWith('.') || spec.includes('?')) return null;
    const base = resolve(root, dirname(fromFile), spec);
    const candidates = [base, `${base}.ts`, `${base}.tsx`, `${base}.js`, `${base}.mjs`, join(base, 'index.ts')];
    for (const candidate of candidates) {
      if (existsSync(candidate)) return normalizeRepoPath(relative(root, candidate));
    }
    return null;
  };
  const collectTransitiveGraph = entryTs => {
    const visitedTs = new Set();
    const cssFiles = new Set();
    const directTsImports = new Set();
    let usesPublishSprings = false;
    let usesPaletteRgb = false;
    const visitCss = cssFile => {
      if (cssFiles.has(cssFile)) return;
      cssFiles.add(cssFile);
      const src = readFileSync(join(root, cssFile), 'utf8');
      for (const m of src.matchAll(/@import\s+(?:url\()?['"]([^'"]+)['"]\)?/g)) {
        const next = resolveImport(cssFile, m[1]);
        if (next && next.endsWith('.css')) visitCss(next);
      }
    };
    const visitTs = tsFile => {
      if (visitedTs.has(tsFile) || /^src\/preview(?:[-.]|$)/.test(tsFile)) return;
      visitedTs.add(tsFile);
      const src = readFileSync(join(root, tsFile), 'utf8');
      const sf = ts.createSourceFile(tsFile, src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const specs = [];
      const walk = node => {
        if (ts.isImportDeclaration(node) && !node.importClause?.isTypeOnly && ts.isStringLiteral(node.moduleSpecifier)) {
          const spec = node.moduleSpecifier.text;
          specs.push(spec);
          const resolved = resolveImport(tsFile, spec);
          if (tsFile === entryTs && resolved && !resolved.endsWith('.css')) directTsImports.add(resolved);
          if (resolved === 'src/motion.ts' && /\bpublishSpringEasings\b/.test(node.importClause?.getText(sf) || '')) {
            usesPublishSprings = true;
          }
          if (resolved === 'src/palette.ts' && /\b(?:palette|restorePalette)\b/.test(node.importClause?.getText(sf) || '')) {
            usesPaletteRgb = true;
          }
        } else if (ts.isExportDeclaration(node) && !node.isTypeOnly && node.moduleSpecifier && ts.isStringLiteral(node.moduleSpecifier)) {
          specs.push(node.moduleSpecifier.text);
        } else if (
          ts.isCallExpression(node)
          && node.expression.kind === ts.SyntaxKind.ImportKeyword
          && node.arguments.length >= 1
          && ts.isStringLiteralLike(node.arguments[0])
        ) {
          specs.push(node.arguments[0].text);
        }
        ts.forEachChild(node, walk);
      };
      walk(sf);
      for (const spec of specs) {
        const next = resolveImport(tsFile, spec);
        if (!next) continue;
        if (next.endsWith('.css')) visitCss(next);
        else visitTs(next);
      }
    };
    visitTs(entryTs);
    return {
      cssFiles: [...cssFiles],
      tsFiles: [...visitedTs],
      directTsImports,
      usesPublishSprings,
      usesPaletteRgb,
    };
  };
  const loadRootMapFromSources = sources => {
    const merged = new Map();
    for (const [, raw] of sources) {
      const src = stripComments(raw);
      for (const block of parseBlocks(src)) {
        const selector = block.effectiveSelector || block.selector || '';
        if (!rootSelector(selector)) continue;
        for (const decl of declarations(directBody(block.body))) {
          if (decl.property.startsWith('--') && !merged.has(decl.property)) {
            merged.set(decl.property, decl.value);
          }
        }
      }
    }
    return merged;
  };
  const loadRootMap = files => loadRootMapFromSources(files.map(f => [f, readFileSync(join(root, f), 'utf8')]));
  const resolvesWithoutIacvt = (name, map, runtime = new Set(), seen = new Set()) => {
    if (runtime.has(name)) return true;
    if (!map.has(name) || seen.has(name)) return false;
    const nextSeen = new Set([...seen, name]);
    const val = map.get(name);
    let ok = true;
    eachVar(val, (ref, fallback) => {
      if (!ref.startsWith('--')) { ok = false; return; }
      if (runtime.has(ref)) return;
      if (map.has(ref)) {
        if (!resolvesWithoutIacvt(ref, map, runtime, nextSeen)) ok = false;
      } else if (fallback == null || !fallback.trim()) {
        ok = false;
      }
    });
    return ok;
  };
  const expandSelectorBranches = selector => {
    const expanded = [];
    for (const branch of splitTop(selector, /,/)) {
      const trimmed = branch.trim();
      if (!trimmed) continue;
      const chain = parseSelectorChain(trimmed);
      if (chain.compounds.length === 1) {
        const { base, groups } = extractCompoundParts(chain.compounds[0]);
        if (!base.trim() && groups.length === 1) {
          expanded.push(...expandSelectorBranches(groups[0]));
          continue;
        }
      }
      expanded.push(trimmed);
    }
    return expanded;
  };
  const scopeBranchTokens = selector => {
    const tokens = [];
    for (const branch of expandSelectorBranches(selector)) {
      const classes = [...branch.matchAll(/\.[-\w]+/g)].map(m => m[0]);
      const attrs = [...branch.matchAll(/\[([-\w]+)/g)].map(m => m[1]).filter(a => a !== 'data-theme');
      if (classes.length || attrs.length) tokens.push({ classes, attrs });
    }
    return tokens;
  };
  const COMPONENT_CONTAINERS = [
    { file: 'src/tool-trace.css', defRe: /\.(?:tool-trace-card|is-steps)\b/, useRe: /\.(?:trace-|turn-activity-|live-activity|tool-trace)/ },
    { file: 'src/tool-cards.css', defRe: /\.tc-(?:lines|diff)\b/, useRe: /\.tc-(?:line|diff-line)\b/ },
    { file: 'src/tray-popover.css', defRe: /\.tray-window\b/, useRe: /\.tray-/ },
  ];
  const scopedDefCoversUse = (def, use) => {
    if (def.selector === use.selector) return true;
    if (def.file === use.file) {
      for (const container of COMPONENT_CONTAINERS) {
        if (container.file === def.file && container.defRe.test(def.selector) && container.useRe.test(use.selector)) return true;
      }
    }
    const defBranches = scopeBranchTokens(def.selector);
    if (!defBranches.length) return false;
    const useBranches = expandSelectorBranches(use.selector);
    if (!useBranches.length) return false;
    return useBranches.every(ub => defBranches.some(({ classes, attrs }) => {
      const classOk = classes.length === 0 || classes.every(cls => {
        if (cls === '.workspace' && classes.length > 1) return true;
        const esc = cls.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        return new RegExp(`${esc}(?:(?![-\\w])|-)`).test(ub);
      });
      const attrOk = attrs.length === 0 || attrs.every(attr => ub.includes(`[${attr}`));
      return classOk && attrOk;
    }));
  };
  const findUnresolvedRefsFromSources = (sources, runtime, skipSelector = null) => {
    const rootDefs = new Set();
    const scopedDefs = new Map();
    const blocks = [];
    for (const [file, raw] of sources) {
      const src = stripComments(raw);
      for (const block of parseBlocks(src)) {
        const selector = block.effectiveSelector || block.selector || '';
        const decls = declarations(directBody(block.body));
        blocks.push({ file, selector, decls });
        const isRoot = rootSelector(selector);
        for (const decl of decls) {
          if (!decl.property.startsWith('--')) continue;
          if (isRoot) rootDefs.add(decl.property);
          else {
            if (!scopedDefs.has(decl.property)) scopedDefs.set(decl.property, []);
            scopedDefs.get(decl.property).push({ file, selector });
          }
        }
      }
    }
    const missing = new Set();
    for (const { file, selector, decls } of blocks) {
      if (skipSelector?.(file, selector)) continue;
      for (const decl of decls) {
        eachVar(decl.value, (ref, fallback) => {
          if (!ref.startsWith('--')) return;
          if (rootDefs.has(ref) || runtime.has(ref)) return;
          if (fallback != null && fallback.trim()) return;
          const defs = scopedDefs.get(ref) || [];
          if (defs.some(def => scopedDefCoversUse(def, { file, selector }))) return;
          missing.add(`${file}:${ref}`);
        });
      }
    }
    return [...missing].sort();
  };
  const findUnresolvedRefs = (files, runtime, skipSelector = null) =>
    findUnresolvedRefsFromSources(files.map(f => [f, readFileSync(join(root, f), 'utf8')]), runtime, skipSelector);

  const BASE_RUNTIME = [
    '--accent', '--accent-rgb', '--on-accent', '--accent-ink', '--accent-dim', '--accent-hover', '--accent-tint',
    '--focus', '--ui-scale',
    '--thumb-x', '--thumb-w', '--toast-room', '--dock-room', '--sidebar-w', '--inspector-w',
    '--ds-value', '--ds-avatar', '--ds-tone', '--ds-tone-fill', '--i', '--cell', '--panda-bg', '--swatch',
  ];
  const MOTION_SPRING_RUNTIME = [
    '--spring-fast', '--spring-fast-duration', '--spring-snappy', '--spring-snappy-duration',
    '--spring-settle', '--spring-settle-duration', '--spring-ease', '--spring-duration',
  ];
  const PALETTE_RGB_RUNTIME = ['--bg-rgb', '--panel-rgb', '--raised-rgb', '--text-rgb', '--frame-rgb'];
  const runtimeForGraph = graph => new Set([
    ...BASE_RUNTIME,
    ...(graph.usesPublishSprings ? MOTION_SPRING_RUNTIME : []),
    ...(graph.usesPaletteRgb ? PALETTE_RGB_RUNTIME : []),
  ]);

  // Self-check: IACVT resolver rejects missing, cyclic, and scoped-only chains.
  const minimalRuntime = new Set(BASE_RUNTIME);
  assert.equal(resolvesWithoutIacvt('--broken', new Map([['--broken', 'var(--missing)']]), minimalRuntime), false, 'unresolved var() is rejected');
  assert.equal(resolvesWithoutIacvt('--a', new Map([['--a', 'var(--b)'], ['--b', 'var(--a)']]), minimalRuntime), false, 'cyclic var() is rejected');
  const scopedOnlySources = [
    ['src/a.css', ':root{--ok:1px}.scoped{--only-scoped:var(--ok)}.other{color:var(--only-scoped)}'],
  ];
  const scopedOnlyRoot = loadRootMapFromSources(scopedOnlySources);
  assert.equal(scopedOnlyRoot.has('--only-scoped'), false, 'loadRootMap ignores non-root scoped custom properties');
  assert.deepEqual(findUnresolvedRefsFromSources(scopedOnlySources, minimalRuntime), ['src/a.css:--only-scoped'], 'scoped def does not satisfy unrelated selector');
  assert.deepEqual(
    findUnresolvedRefsFromSources([['src/a.css', '.scoped{--local:1px}.scoped .child{color:var(--local)}']], minimalRuntime),
    [],
    'scoped def satisfies descendant selector',
  );

  // Quick Launcher (?view=launcher) — walks real runtime transitive imports of src/overlay.ts.
  const overlayGraph = collectTransitiveGraph('src/overlay.ts');
  const overlayCssFiles = overlayGraph.cssFiles;
  const overlayRuntime = runtimeForGraph(overlayGraph);
  assert.equal(overlayRuntime.has('--spring-fast'), false, 'overlay verifies --spring-fast from :root CSS rather than runtime');
  assert.ok(overlayCssFiles.includes('src/tool-trace.css'), 'overlay.ts transitively imports tool-trace.css');
  assert.ok(overlayCssFiles.includes('src/tool-images.css'), 'overlay.ts transitively imports tool-images.css');
  assert.ok(overlayCssFiles.includes('src/overlay-model-picker.css'), 'overlay.ts transitively imports overlay-model-picker.css');
  assert.ok(overlayCssFiles.includes('src/tokens.css'), 'overlay.ts transitively imports tokens.css');
  const overlayMap = loadRootMap(overlayCssFiles);
  for (const token of [
    '--glass-warm', '--glass-border', '--glass-shadow-deep', '--glass-shadow-near',
    '--press', '--ds-row-hover', '--ds-success', '--ds-ease-in', '--ds-ease-out',
    '--spring-fast', '--spring-fast-duration', '--thread-font',
    '--surface-1', '--surface-2', '--surface-3', '--surface-sunken',
    '--fill-hover', '--fill-active',
  ]) {
    assert.equal(resolvesWithoutIacvt(token, overlayMap, overlayRuntime), true, `overlay resolves ${token} without IACVT`);
  }
  assert.deepEqual(findUnresolvedRefs(overlayCssFiles, overlayRuntime), [], 'overlay transitive CSS has no unresolved var()');
  // Deleting a :root token in overlay.css is NOT masked by .launcher-thread-activity or .model-menu.
  const overlayWithoutRootBorder = overlayCssFiles.map(file => {
    const raw = readFileSync(join(root, file), 'utf8');
    if (file !== 'src/overlay.css') return [file, raw];
    return [file, raw.replace(/(:root\{[^}]*)--ds-border:[^;]+;/, '$1')];
  });
  assert.equal(
    resolvesWithoutIacvt('--ds-border', loadRootMapFromSources(overlayWithoutRootBorder), overlayRuntime),
    false,
    'deleting :root --ds-border in overlay.css is not masked by scoped overrides',
  );
  assert.ok(
    findUnresolvedRefsFromSources(overlayWithoutRootBorder, overlayRuntime).some(hit => hit.endsWith(':--ds-border')),
    'findUnresolvedRefs catches deleted :root --ds-border despite .launcher-thread-activity and .model-menu',
  );

  // Menu bar tray popover (?view=tray) — walks real runtime transitive imports of src/tray-popover.ts.
  const trayGraph = collectTransitiveGraph('src/tray-popover.ts');
  const trayCssFiles = trayGraph.cssFiles;
  const trayRuntime = runtimeForGraph(trayGraph);
  assert.equal(trayRuntime.has('--spring-fast'), false, 'tray-popover verifies --spring-fast from motion.css :root');
  assert.equal(trayRuntime.has('--bg-rgb'), false, 'tray-popover does not assume palette.ts runtime rgb vars');
  assert.ok(trayCssFiles.includes('src/motion.css'), 'tray-popover.ts transitively imports motion.css');
  assert.ok(trayCssFiles.includes('src/tray-popover.css'), 'tray-popover.ts transitively imports tray-popover.css');
  assert.ok(trayCssFiles.includes('src/tokens.css'), 'tray-popover.ts transitively imports tokens.css');
  const trayMap = loadRootMap(trayCssFiles);
  for (const token of [
    '--bg', '--panel', '--raised', '--border', '--text', '--muted',
    '--surface-1', '--surface-2', '--surface-3', '--surface-sunken',
    '--fill-hover', '--fill-active',
    '--press', '--ds-ease-out', '--spring-fast', '--spring-fast-duration', '--ds-border-strong', '--thread-font',
  ]) {
    assert.equal(resolvesWithoutIacvt(token, trayMap, trayRuntime), true, `tray-popover resolves ${token} without IACVT`);
  }
  assert.deepEqual(findUnresolvedRefs(trayCssFiles, trayRuntime), [], 'tray-popover transitive CSS has no unresolved var()');

  // Agents dock standalone window (agents-dock.html) — walks real runtime transitive imports of src/agents-dock-window.ts.
  const dockGraph = collectTransitiveGraph('src/agents-dock-window.ts');
  const dockCssFiles = dockGraph.cssFiles;
  const dockRuntime = runtimeForGraph(dockGraph);
  assert.ok(dockCssFiles.includes('src/design-system.css'), 'agents-dock-window.ts transitively imports design-system.css');
  const dockMap = loadRootMap(dockCssFiles);
  for (const token of [
    '--press', '--ds-row-hover', '--ds-success', '--ds-ease-in', '--ds-ease-out',
    '--spring-fast', '--spring-fast-duration', '--ds-border-strong', '--thread-font',
    '--surface-1', '--surface-2', '--surface-3', '--surface-sunken',
    '--fill-hover', '--fill-active',
  ]) {
    assert.equal(resolvesWithoutIacvt(token, dockMap, dockRuntime), true, `agents-dock-window resolves ${token} without IACVT`);
  }
  const skipMainWorkArea = (file, selector) => file === 'src/styles.css' && /\.work-area\b/.test(selector);
  assert.deepEqual(findUnresolvedRefs(dockCssFiles, dockRuntime, skipMainWorkArea), [], 'agents-dock-window transitive CSS has no unresolved var()');

  // Tool trace gallery standalone window (tool-trace-gallery.html).
  const galleryGraph = collectTransitiveGraph('src/tool-trace-gallery.ts');
  const galleryCssFiles = galleryGraph.cssFiles;
  const galleryRuntime = runtimeForGraph(galleryGraph);
  assert.equal(galleryRuntime.has('--spring-fast'), false, 'tool-trace-gallery verifies --spring-fast from motion.css :root');
  assert.equal(galleryRuntime.has('--bg-rgb'), false, 'tool-trace-gallery does not assume palette.ts runtime rgb vars');
  assert.ok(galleryCssFiles.includes('src/tokens.css'), 'tool-trace-gallery.ts transitively imports tokens.css');
  const skipGalleryUnused = (file, selector) =>
    skipMainWorkArea(file, selector)
    || (file === 'src/tool-images.css' && /\.(?:is-launcher|launcher-thread)\b/.test(selector));
  assert.deepEqual(findUnresolvedRefs(galleryCssFiles, galleryRuntime, skipGalleryUnused), [], 'tool-trace-gallery transitive CSS has no unresolved var()');
});
