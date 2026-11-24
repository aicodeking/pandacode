/**
 * Static design-token guard, part 1: the repository scan and the CSS rules.
 * The full scan requires canonical ownership, resolving aliases, live reasoned
 * exceptions and agreement with the documented design scale. CSS samples exercise
 * nesting, scopes, escapes, radius roles and type-role pairing.
 * --radius-card/inner/control references belong only to src/tokens.css :root defaults
 * and the dialog step-down in the same sheet; components read role tokens.
 * Siblings: design-tokens-ts.test.mjs (TypeScript style APIs), design-tokens-bypasses.test.mjs
 * (selects, caps, resets, canvas and SVG bypasses, effective typography) and
 * design-tokens-parity.test.mjs (docs locks, Shadow DOM sheet flow, Markdown parity and
 * standalone-window token resolution).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { win32 } from 'node:path';
import {
  LITERALS, EM_SIZES, LINE_HEIGHTS, CUSTOM, ALIASES, ALIAS_VALUES, STYLE_EXEMPT, REDEFINES, MOCK_CONTENT,
  CONTROLS, TRACKING,
} from './design-tokens/allowlists.mjs';
import { scanCss, valueResolves, tokenMap, tokensCss, designSystemCss, designSystemLocked, definedNames } from './design-tokens/parser.mjs';
import { loadRulebook, compareRulebook, compareAliases, unexpectedLocked, lockRowLeadings, repeatedLocked } from './design-tokens/docs.mjs';
import { normalizeRepoPath, scanRepo, scanTsFile, scanHtml, specAliasProblems } from './design-tokens/ts-style.mjs';

test('components read radius roles; scale references belong to defaults and dialog remaps', () => {
  const { problems } = scanRepo();
  assert.equal(problems.filter(hit => /direct scale reference|radius role definition/.test(hit)).join('\n'), '');
});

test('normalized radius role guard accepts only exact defaults and dialog remaps', () => {
  const css = (file, source) => scanCss(file, source, new Set(), new Map(), new Set());
  const step = 'dialog > *:not(.pp-lb-plate, .tool-image-viewer-plate, .floating-menu, .tip-bubble), dialog > :is(.pp-lb-plate, .tool-image-viewer-plate) > *:not(.floating-menu, .tip-bubble)';
  const unportaled = 'dialog>*:not(.pp-lb-plate,.tool-image-viewer-plate),dialog>:is(.pp-lb-plate,.tool-image-viewer-plate)>*';
  const defaults = ':root{--ds-card-radius:var(--radius-card);--ds-inner-radius:var(--radius-inner);--ds-control-radius:var(--radius-control)}';
  const remaps = `${step}{--ds-card-radius:var(--radius-inner);--ds-inner-radius:var(--radius-control);--ds-control-radius:var(--radius-chip)}`;
  assert.deepEqual(css('src/tokens.css', defaults), []);
  assert.deepEqual(css('src/tokens.css', remaps), []);
  for (const [file, source] of [
    ['src/design-system.css', remaps],
    ['src/design-system.css', defaults],
    ['src/design-system.css', 'dialog>*{--ds-card-radius:var(--radius-inner)}'],
    ['src/tokens.css', 'dialog>*{--ds-card-radius:var(--radius-inner)}'],
    ['src/tokens.css', 'dialog>*:not(.pp-lb-plate){--ds-control-radius:var(--radius-chip)}'],
    ['src/tokens.css', `${step},.other{--ds-inner-radius:var(--radius-control)}`],
    ['src/tokens.css', `${unportaled}{--ds-card-radius:var(--radius-inner)}`],
    ['src/tokens.css', 'dialog>*:not(.pp-lb-plate,.tool-image-viewer-plate,.floating-menu,.tip-bubble),dialog>:is(.pp-lb-plate,.tool-image-viewer-plate)>*{--ds-control-radius:var(--radius-chip)}'],
    ['src/tokens.css', `${step}{--ds-card-radius:var(--radius-card)}`],
    ['src/tokens.css', `${step}{--ds-control-radius:var(--radius-hair)}`],
    ['src/x.css', `${step}{--ds-control-radius:var(--radius-chip)}`],
    ['src/x.css', '.other{--ds-control-radius:var(--ds-inner-radius)}'],
    ['src/design-system.css', '.other{--ds-control-radius:var(--radius-chip)}'],
    ['src/tokens.css', ':root{--ds-card-radius:var(--radius-inner)}'],
    ['src/tokens.css', '.other{--ds-inner-radius:var(--radius-inner)}'],
    ['src/tokens.css', ':root,.other{--ds-card-radius:var(--radius-card)}'],
    ['src/tokens.css', `.outer{${step}{--ds-inner-radius:var(--radius-control)}}`],
    ['src/tokens.css', ':root{--ds-control-radius:var(--radius-control,var(--radius-chip))}'],
    ['src/tokens.css', '@property --ds-control-radius{syntax:"<length>";inherits:false;initial-value:var(--radius-chip)}'],
  ]) {
    assert.ok(css(file, source).some(hit => hit.includes('radius role definition')), `${file}: ${source}`);
  }
  assert.ok(scanTsFile('src/x.ts', "el.style.setProperty('--ds-control-radius', 'var(--radius-chip)');").some(hit => hit.includes('radius role definition')), 'script role remap');
});

test('normalized radius role guard rejects escaped, uppercase and embedded scale reads', () => {
  const css = source => scanCss('src/x.css', source, new Set(), new Map(), new Set());
  for (const source of [
    '.card{border-radius:VAR(--radius-control)}',
    String.raw`.card{border-radius:var(--radius-\63 ontrol)}`,
    '.card{--unrelated:var(--radius-inner)}',
    '.card{padding:var(--radius-card)}',
    '.card{border-radius:var(--ds-card-radius,VAR(--radius-control))}',
    '.card{clip-path:inset(0 round VAR(--radius-card))}',
    '.card{clip-path:var(--radius-control)}',
    '@property --unrelated{syntax:"<length>";inherits:false;initial-value:VAR(--radius-inner)}',
  ]) {
    assert.ok(css(source).some(hit => hit.includes('direct scale reference')), source);
  }
  for (const source of [
    "el.style.borderRadius = 'var(' + '--radius-control)';",
    "el.style.setProperty('border-radius', 'VAR(--radius-inner)');",
    "Object.assign(el.style, {borderRadius:'var(--radius-card)'});",
    "el.style.cssText = 'border-radius:VAR(--radius-control)';",
    "el.style.clipPath = 'inset(0 round VAR(--radius-card))';",
    "el.style.clipPath = `inset(${n}px round VAR(--radius-card))`;",
    "el.style.setProperty(prop, 'VAR(--radius-control)');",
    "el.style.setProperty('--unrelated', 'var(--radius-inner)');",
    "el.style.padding = 'var(--radius-control)';",
    "el.style['padding'] = 'VAR(--radius-inner)';",
    "Object.assign(el.style, {padding:'var(--radius-card)'});",
    "el.style.setProperty('padding', 'var(--radius-inner)');",
    '`<style>.card{border-radius:var(--radius-card)}</style>`',
    "const css = '.card{padding:VAR(--radius-inner)}';",
    String.raw`const css = '.card{--unrelated:var(--radius-\\63 ontrol)}';`,
  ]) {
    assert.ok(scanTsFile('src/x.ts', source).some(hit => hit.includes('direct scale reference')), source);
  }
  for (const source of [
    '<div style="border-radius:var(--radius-card)"></div>',
    '<div style="padding:var(--radius-card)"></div>',
    '<style>.field{border-radius:VAR(--radius-control)}</style>',
  ]) {
    assert.ok(scanHtml('index.html', source).some(hit => hit.includes('direct scale reference')), source);
  }
});

test('design tokens stay on the canonical scale', () => {
  for (const entry of [...LITERALS, ...EM_SIZES, ...LINE_HEIGHTS, ...CUSTOM, ...ALIASES, ...STYLE_EXEMPT, ...REDEFINES, ...MOCK_CONTENT, ...CONTROLS, ...TRACKING]) assert.ok(entry.reason.trim(), entry.file || entry.name);
  const { used, defs, aliasUsed, problems } = scanRepo();
  for (const [index, entry] of ALIASES.entries()) {
    if (!aliasUsed.has(entry.name)) problems.push(`alias ${entry.name} matched nothing`);
    else used.add(`alias:${index}`);
    const list = defs.get(entry.name) || [];
    if (!list.length) problems.push(`alias ${entry.name} has no definition`);
    for (const item of list) {
      if (!valueResolves(item.value, entry.name, defs)) problems.push(`alias ${entry.name} does not resolve to a token in ${item.file}: ${item.value}`);
    }
  }
  const lists = [['literal', LITERALS], ['em', EM_SIZES], ['lh', LINE_HEIGHTS], ['custom', CUSTOM], ['style', STYLE_EXEMPT], ['redef', REDEFINES], ['mock', MOCK_CONTENT], ['control', CONTROLS], ['track', TRACKING]];
  const unused = [];
  for (const [kind, list] of lists) {
    for (const [index, entry] of list.entries()) {
      if (!used.has(`${kind}:${index}`)) unused.push(`${kind} ${entry.file || ''} ${entry.selector || entry.name || entry.api || ''} ${entry.value || entry.property || ''}`.trim());
    }
  }
  const book = loadRulebook();
  assert.equal(book.roles.filter(role => role.name).length, 8, 'type table rows');
  assert.equal(Object.keys(book.radii).filter(Boolean).length, 7, 'radius table rows');
  assert.equal(Object.keys(book.weights).length, 3, 'weight sentences');
  assert.equal(Object.keys(book.tracking).length, 3, 'tracking sentences');
  assert.equal(Object.keys(book.leadings).length, 1, 'leading aliases');
  assert.equal(book.compactLeading, '1.25', 'compact prose leading');
  assert.equal(Object.keys(book.heights).length, 10, 'row and control heights');
  assert.equal(Object.values(book.core).filter(Boolean).length, 4, 'core tokens');
  assert.equal(book.aliases.size, ALIAS_VALUES.size, 'contextual aliases');
  assert.deepEqual(
    [...designSystemLocked].sort(),
    Object.keys(book.heights).filter(name => name.startsWith('--ds-')).sort(),
    'design-system locked height tokens match docs',
  );
  problems.push(...repeatedLocked(tokensCss, book));
  problems.push(...repeatedLocked(designSystemCss, book, 'src/design-system.css'));
  problems.push(...compareRulebook(tokenMap(tokensCss), book).map(hit => `src/tokens.css: ${hit}`));
  problems.push(...compareAliases(ALIAS_VALUES, book.aliases).map(hit => `alias lock: ${hit}`));
  problems.push(...lockRowLeadings(used, tokenMap(tokensCss), tokenMap(designSystemCss), book.heights).map(hit => `line-height lock: ${hit}`));
  problems.push(...unexpectedLocked([...tokenMap(tokensCss).keys()], book.expected).map(hit => `src/tokens.css: ${hit}`));
  problems.push(...unexpectedLocked([...definedNames(designSystemCss)], book.expected).map(hit => `src/design-system.css: ${hit}`));
  assert.equal(unused.join('\n'), '', 'allowlist entry matched nothing');
  assert.equal(problems.join('\n'), '');
});

test('design-token scanner uses slash-separated keys for Windows paths', () => {
  const windowsFile = file => normalizeRepoPath(win32.relative('C:/PandaCode', `C:/PandaCode/${file}`));
  assert.deepEqual(scanCss(windowsFile('src/tokens.css'), ':root{--type-body:1rem}', new Set(), new Map(), new Set()), []);
  assert.deepEqual(scanTsFile(windowsFile('src/motion.ts'), 'Object.assign(plate.style, { borderRadius: getComputedStyle(dialog).borderRadius });'), []);
  assert.deepEqual(specAliasProblems(windowsFile('tests/x.spec.ts'), "getPropertyValue('--ds-radius-inner')"), [
    'tests/x.spec.ts: deprecated alias --ds-radius-inner',
  ]);
});

test('CSS guard: select rules', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.settings select{font-weight:revert;font-weight:var(--type-body-weight)}', 'browser reset is rejected even when later overridden'],
    ['src/x.css', ':root,.a{font-size:var(--root-size)}', 'root size mixed selector'],
    ['src/x.css', 'button, .title{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'selector list with non-control'],
    ['src/overlay.css', 'html,.card{font-size:var(--root-size,14px)}', 'rootSizeFallback mixed selector'],
    ['src/x.css', '.settings select{font:inherit;font-size:var(--type-body)}', 'select font:inherit leaks weight without type-body-weight'],
    ['src/x.css', 'html[data-theme] .settings-page-root select:not([multiple]){font:inherit;font-size:var(--type-body)}', 'settings select font:inherit leaks weight'],
    ['src/x.css', '.settings select{font-weight:var(--type-body-weight);font:inherit;font-size:var(--type-body)}', 'font:inherit after font-weight resets weight'],
    ['src/x.css', '.settings select{font:inherit}', 'select font:inherit without font-size leaks weight'],
    ['src/x.css', '.settings-content select { font: initial }', 'select font:initial resets weight'],
    ['src/x.css', '.settings \\73 elect{font:inherit;font-size:var(--type-body)}', 'escaped selector form-field font:inherit'],
    ['src/x.css', '.settings \\73 elect{font:inherit}', 'escaped selector form-field bare font:inherit'],
    ['src/x.css', 'select{font:inherit}', 'bare select font:inherit outside base sheet'],
    ['src/x.css', 'select{font:inherit;font-size:var(--type-body)}', 'bare select font:inherit with body size outside base sheet'],
    ['src/x.css', '.settings select{font-weight:inherit}', 'form field font-weight:inherit'],
    ['src/x.css', '.settings select{all:unset}', 'form field all:unset'],
    ['src/x.css', '.settings select{font:unset}', 'form field font:unset'],
    ['src/x.css', '.settings select{font:revert}', 'form field font:revert'],
    ['src/x.css', '.settings select{font:revert-layer}', 'form field font:revert-layer'],
    ['src/styles.css', 'select{font:unset}', 'bare select font:unset even in base sheet'],
    ['src/styles.css', 'select{font-weight:inherit}', 'bare select font-weight:inherit rejected in base sheet'],
    ['src/x.css', '.settings select{font-weight:unset}', 'form field font-weight:unset'],
    ['src/x.css', '.settings select{font-weight:initial}', 'form field font-weight:initial'],
    ['src/x.css', '.settings select{font-weight:revert}', 'form field font-weight:revert'],
    ['src/x.css', '.settings select{font-weight:revert-layer}', 'form field font-weight:revert-layer'],
    ['src/x.css', '.settings select{all:revert}', 'form field all:revert'],
    ['src/x.css', '.settings select{all:revert-layer;font-weight:var(--type-body-weight)}', 'all:revert-layer drops font-size to the browser default even with a weight'],
    ['src/x.css', '.settings select{all:unset;font-weight:var(--type-body-weight)}', 'all:unset on a select strips its appearance and chevron even with a weight'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.css', '.settings select{font:inherit;font-size:var(--type-body);font-weight:var(--type-body-weight)}'],
    ['src/styles.css', 'select{font:inherit;font-size:var(--type-body)}'],
    ['src/x.css', '.settings select{font:inherit;font-weight:var(--type-body-weight)}'],
    ['src/styles.css', 'select{font:inherit}'],
    ['src/x.css', '.settings select{font-weight:inherit;font-weight:var(--type-body-weight)}'],
    ['src/x.css', '.settings input{all:unset;font-weight:var(--type-body-weight)}'],
    ['src/x.css', '.settings select{font:unset;font-weight:var(--type-body-weight)}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('CSS guard: caps and resets', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.a{letter-spacing:revert-layer}', 'browser reset is rejected even when later overridden'],
    ['src/x.css', '.a{letter-spacing:revert}', 'browser reset is rejected even when later overridden'],
    ['src/x.css', '.a{letter-spacing:initial}', 'browser reset is rejected even when later overridden'],
    ['src/x.css', '@property --card-radius{syntax:"<length>";inherits:false;initial-value:8px}', 'property initial'],
    ['src/x.css', '@property --ds-btn-h{syntax:"<length>";inherits:true;initial-value:40px}', 'property redefines ds-btn-h'],
    ['src/x.css', '@property --type-body{syntax:"<length>";inherits:true;initial-value:1rem}', 'property redefines role'],
    ['src/inset-shell.css', '@property --inset-radius{syntax:"<length>";inherits:false;initial-value:8px}', '@property inset-radius invalid initial-value'],
    ['src/x.css', 'textarea.note{font:initial;font-size:var(--type-body)}', 'textarea font:initial resets weight'],
    ['src/x.css', '.settings input{all:initial}', 'form field all:initial'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);all:unset;font-size:var(--type-heading)}', 'all:unset resets earlier heading declarations'],
    ['src/x.css', '.settings input{all:revert-layer}', 'form field all:revert-layer'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/tokens.css', '@property --title-size{syntax:"<length>";inherits:false;initial-value:19px}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('CSS guard: radius, corners and nesting', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.a{border-top-left-radius:12px}', 'top longhand'],
    ['src/x.css', '.a{border-start-start-radius:4px}', 'logical longhand'],
    ['src/x.css', '.a{--card-radius:14px}', 'custom radius'],
    ['src/x.css', '.a{border-radius:var(--row)}', 'radius family'],
    ['src/x.css', '.a{-webkit-border-radius:var(--row)}', 'webkit radius family'],
    ['src/x.css', '.a{border-radius:var(--radius-card,var(--x,7px))}', 'nested fallback'],
    ['src/x.css', '.a{border-radius:var(--radius-card)/7px}', 'slash radius'],
    ['src/x.css', '.a{--my-radius:var(--radius-card,var(--x,7px))}', 'custom property nested literal fallback'],
    ['src/overlay.css', ':root{--launcher-radius-card:var(--radius-card)}', 'unapproved launcher radius alias'],
    ['src/x.css', '.a{--my-radius:var(--radius-card)}', 'unapproved radius alias'],
    ['src/x.css', ':root{--inset-radius:var(--ds-card-radius)}', 'inset-radius wrong owner file'],
    ['src/inset-shell.css', ':root{--inset-radius:var(--radius-popover)}', 'inset-radius wrong value'],
    ['src/x.css', ':root{--inset-radius:var(--radius-popover)}', 'inset-radius wrong owner file'],
    ['src/inset-shell.css', ':root{--inset-radius:var(--radius-control)}', 'inset-radius wrong value'],
    ['src/x.css', '.a{--gu-surface-radius:var(--ds-control-radius)}', 'gu-surface-radius wrong owner file'],
    ['src/generative-ui.css', '.a{--gu-surface-radius:var(--radius-card)}', 'gu-surface-radius wrong value'],
    ['src/x.css', '.a{--radius-card:16px}', 'redefine radius'],
    ['src/x.css', '.a{@container (min-width:200px){border-radius:7px}}', 'nested container literal radius'],
    ['src/x.css', '.a{@starting-style{border-radius:5px}}', 'nested starting-style literal radius'],
    ['src/x.css', '.a{clip-path:inset(0 round 12px)}', 'clip round px'],
    ['src/x.css', '.a{clip-path:inset(0 round .75rem)}', 'clip round rem'],
    ['src/x.css', '.a{clip-path:inset(0 round 1rem)}', 'clip round 1rem'],
    ['src/x.css', '.a{--inset-radius:var(--radius-popover)}', 'inset radius popover'],
    ['src/x.css', '.a{border-radius:var(--radius-card,var(--totally-undefined))}', 'nested undefined fallback'],
    ['src/x.css', '.a{border-radius:var(--radius-card,var(--type-body))}', 'nested wrong-family fallback'],
    ['src/x.css', '.a{border-radius:var(--radius-card,var(bogus))}', 'nested bogus var'],
    ['src/x.css', '.a{@scope (.inner){border-radius:7px}}', 'nested scope literal radius'],
    ['src/x.css', '.a{border-radius:var(--radius-card) / var(--radius-inner)}', 'elliptical slash radius tokens'],
    ['src/x.css', '.a{border-radius:50% / 50%}', 'elliptical slash 50%'],
    ['src/x.css', '.a{border-start-start-radius:var(--ds-control-radius) var(--radius-chip)}', 'two-axis elliptical logical corner'],
    ['src/x.css', '.a{border-end-end-radius:0 var(--ds-inner-radius)}', 'two-axis elliptical corner with zero axis'],
    ['src/x.css', '.a{border-start-end-radius:50% 0}', 'two-axis elliptical corner with circle axis'],
    ['src/x.css', '.a{border-top-left-radius:var(--radius-inner)}', 'physical top-left corner longhand'],
    ['src/x.css', '.a{border-top-right-radius:var(--radius-inner)}', 'physical top-right corner longhand'],
    ['src/x.css', '.a{border-bottom-left-radius:0}', 'physical bottom-left corner longhand'],
    ['src/x.css', '.a{border-bottom-right-radius:var(--radius-control)}', 'physical bottom-right corner longhand'],
    ['src/x.css', '.a{clip-path:inset(0 round var(--row))}', 'clip round non-radius var'],
    ['src/x.css', '.a{clip-path:inset(0 round 12pt)}', 'clip round pt'],
    ['src/x.css', '.a{clip-path:inset(0 round 1em)}', 'clip round em'],
    ['src/x.css', '.a{clip-path:inset(0 round 25%)}', 'clip round non-50 percent'],
    ['src/x.css', '.a{clip-path:inset(0 round var(--radius-card) / var(--radius-inner))}', 'clip round elliptical slash'],
    ['src/x.css', '.a{clip-path:inset(0 round var(--radius-card, 8px))}', 'clip round literal fallback'],
    ['src/x.css', '.a{--inset-radius:var(--ds-card-radius)}', 'inset-radius wrong owner file'],
    ['src/x.css', '@scope (.card){@media (min-width:1px){font-size:12px;border-radius:7px;--ds-btn-h:99px}}', 'nested media inside top-level scope'],
    ['src/x.css', '.a{border-\\72 adius:7px}', 'css hex escape border-radius'],
    ['src/x.css', ".a{content:'/*';border-radius:9px} /* end */", 'quote-aware stripComments single-quote /*'],
    ['src/x.css', '.a{clip-path:inset(0 \\72 ound 12px)}', 'escaped clip-path round px'],
    ['src/x.css', '.a{--code-copy-radius:var(--radius-chip)}', 'code-copy-radius wrong owner file'],
    ['src/generative-ui.css', '.a{--code-copy-radius:var(--radius-card)}', 'code-copy-radius wrong value'],
    ['src/x.css', '.a{-webkit-clip-path:inset(0 round 8px)}', 'webkit clip-path round px'],
    ['src/x.css', '.a{-webkit-border-before-left-radius:8px}', 'webkit border-before-left-radius literal'],
    ['src/x.css', '.a{-webkit-border-before-right-radius:var(--radius-inner)}', 'webkit border-before-right-radius physical'],
    ['src/x.css', '.a{-webkit-border-after-left-radius:4px}', 'webkit border-after-left-radius literal'],
    ['src/x.css', '.a{-webkit-border-after-right-radius:var(--radius-control)}', 'webkit border-after-right-radius physical'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.css', '.a{border-start-start-radius:var(--ds-inner-radius);border-start-end-radius:0;border-end-start-radius:var(--ds-control-radius);border-end-end-radius:0}'],
    ['src/x.css', '.a{border-radius:var(--inset-radius,var(--ds-card-radius))}'],
    ['src/inset-shell.css', ':root{--inset-radius:var(--ds-card-radius)}'],
    ['src/generative-ui.css', ':is(.gu-card,.gu-tabs)>*{--gu-surface-radius:var(--ds-control-radius)}'],
    ['src/turn-card.css', '.turn-card-reply{--gu-surface-radius:var(--ds-control-radius)}'],
    ['src/tokens.css', ':root{--type-body:1rem;--sans:Georgia;--row:28px;--tracking-tight:0;--weight-medium:500;--radius-card:16px;--leading-code:1.55}'],
    ['src/x.css', '.a{@starting-style{border-radius:var(--ds-card-radius)}}'],
    ['src/x.css', '.a{clip-path:inset(0 round var(--ds-card-radius))}'],
    ['src/x.css', '.a{clip-path:inset(0 round 50%)}'],
    ['src/x.css', '.a{clip-path:inset(0 round 0)}'],
    ['src/x.css', '.a{clip-path:inset(1rem)}'],
    ['src/inset-shell.css', '.workspace{--inset-radius:0px}'],
    ['src/inset-shell.css', '.workspace{--inset-radius:0}'],
    ['src/inset-shell.css', '.workspace{--inset-radius:var(--ds-card-radius)}'],
    ['src/x.css', '.a{clip-path:inset(0 \\72 ound var(--ds-card-radius))}'],
    ['src/generative-ui.css', '.gu-tight-host{--gu-surface-radius:var(--radius-chip);--code-copy-radius:var(--radius-hair)}'],
    ['src/github-hub.css', '.gh-job-summary{--code-copy-radius:var(--radius-hair)}'],
    ['src/agent-input.css', '.agent-input-option{--code-copy-radius:var(--radius-hair)}'],
    ['src/x.css', '.a{-webkit-clip-path:inset(0 round var(--ds-card-radius))}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('CSS guard: token aliases and ownership', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.a{font-size:var(--not-a-token)}', 'undefined token'],
    ['src/x.css', '.a{font-size:var(--type-body,13px)}', 'px fallback'],
    ['src/x.css', '.a{font-weight:var(--weight-strong,650)}', 'numeric fallback'],
    ['src/x.css', '.a{--title-size:19px}', 'custom size'],
    ['src/x.css', '.a{--label-weight:700}', 'custom weight'],
    ['src/styles.css', ':root{font-size:var(--root-size,14px)}', 'root fallback outside overlay'],
    ['src/x.css', '.a{font-size:var(--type-body,large)}', 'keyword fallback'],
    ['src/x.css', '.a{--my-size:calc(var(--type-body) * 1.3)}', 'scaled custom size'],
    ['src/x.css', '.a{--my-size:var(--bad,19px)}', 'custom property literal fallback'],
    ['src/diff-viewer.ts', ':host{--diffs-font-family:var(--mono,monospace)}', 'diffs-font-family literal fallback'],
    ['src/x.css', '.a{--my-font-size:var(--type-body)}', 'unapproved font-size alias'],
    ['src/x.css', '.a{--type-body:1rem}', 'redefine type role'],
    ['src/x.css', '.a{--sans:Georgia,serif}', 'redefine sans'],
    ['src/x.css', '.a{--row:28px}', 'redefine row'],
    ['src/x.css', '.a{--ds-btn-h:40px}', 'redefine ds-btn-h'],
    ['src/x.css', '.a{--ds-btn-primary-h:40px}', 'redefine ds-btn-primary-h'],
    ['src/x.css', '.a{--ds-row-h:44px}', 'redefine ds-row-h'],
    ['src/x.css', '.a{--ds-row-h-sub:52px}', 'redefine ds-row-h-sub'],
    ['src/tokens.css', ':root{--ds-btn-h:36px}', 'redefine ds-btn-h in tokens.css'],
    ['src/x.css', '--ds-row-h:44px', 'inline redefine ds-row-h'],
    ['src/x.css', '.a{--tracking-tight:0}', 'redefine tracking'],
    ['src/x.css', '.a{--weight-medium:500}', 'redefine weight'],
    ['src/x.css', '.a{--leading-code:1.55}', 'redefine leading-code'],
    ['src/x.css', '.a{--my-tracking:.04em}', 'custom tracking'],
    ['src/x.css', '.a{font-size:var(--type-title,var(--type-body))}', 'fallback is still title'],
    ['src/x.css', '.a{font-size:var(--type-title,var(--type-body));font-weight:var(--type-body-weight);line-height:var(--type-body-leading);letter-spacing:var(--tracking-none)}', 'title fallback paired as body'],
    ['src/design-system.css', '.a{--ds-row-tracking:.02em}', 'custom row tracking'],
    ['src/x.css', '.a{font:var(--weight-strong,var(--weight-medium)) var(--type-body)/var(--type-body-leading) var(--sans)}', 'shorthand weight fallback strong'],
    ['src/x.css', '.a{font:var(--type-heading-weight,var(--weight-medium)) var(--type-body)/var(--type-body-leading) var(--sans)}', 'shorthand weight fallback heading'],
    ['src/overlay.css', ':root .card{font-size:var(--root-size,14px)}', 'rootSizeFallback descendant of root'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-heading))}', 'fallback heading role requires pairing'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-heading));line-height:var(--type-prose-leading)}', 'fallback heading role paired only as prose'],
    ['src/x.css', '.a{font-size:var(--type-body, var(--type-title))}', 'fallback title role requires pairing'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-subheading))}', 'fallback subheading role requires weight'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--root-size))}', 'fallback root-size off root'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-body));line-height:var(--type-prose-leading)}', 'fallback body with prose leading'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-meta));line-height:var(--type-prose-leading)}', 'fallback meta with prose leading'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-body));font-weight:var(--weight-medium)}', 'fallback body with medium weight on non-control'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-meta));font-weight:var(--weight-strong)}', 'fallback meta with strong weight without caps'],
    ['src/x.css', '.a{font-size:var(--type-body, var(--type-caption))}', 'fallback caption missing line-height'],
    ['src/overlay.css', 'html::before{font-size:var(--root-size,14px)}', 'overlay html::before rootSizeFallback rejected'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/design-system.css', ':root{--ds-row-h:38px;--ds-row-h-sub:48px;--ds-btn-h:36px;--ds-btn-primary-h:36px}'],
    ['src/x.css', '.a{--ds-row-hover:transparent}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('CSS guard: scale literals and style API syntax', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.a{font-size:12pt}', 'pt size'],
    ['src/x.css', '.a{font-size:1.2em}', 'unlisted em'],
    ['src/x.css', '.a{font-size:var(--icon-lg)}', 'size family'],
    ['src/x.css', '.a{font-family:system-ui,sans-serif}', 'font family stack'],
    ['src/x.css', '.a{FONT-SIZE:var(--type-body)}', 'uppercase property'],
    ['src/x.css', 'FONT-SIZE:13px', 'inline uppercase property'],
    ['src/x.css', '.a{font-size:var(--root-size)}', 'root size off the root'],
    ['src/x.css', '.a{@media (max-width:600px){font-size:12px}}', 'nested media literal size'],
    ['src/x.css', '.a{@supports (display:grid){@media (max-width:600px){font-size:12px}}}', 'doubly nested at-rule literal size'],
    ['src/x.css', '.a{zoom:2}', 'zoom'],
    ['src/x.css', '.a{zoom:1.5}', 'zoom fraction'],
    ['src/x.css', '.a{font-size:var(bogus)}', 'bogus var'],
    ['src/x.css', '.a{@layer overrides{font-size:12px}}', 'nested layer literal size'],
    ['src/x.css', '@scope (.card){font-size:12px}', 'top-level scope direct decl literal size'],
    ['src/x.css', '.a{font-\\73 ize:12px}', 'css hex escape font-size'],
    ['src/x.css', '.a{--\\74 ype-body:1rem}', 'css hex escape canonical token'],
    ['src/x.css', '@font-face{font-family:"Custom";src:local("Arial")}', '@font-face disallowed'],
    ['src/x.css', '@\\66 ont-face{font-family:"Custom";src:local("Arial")}', 'escaped @font-face disallowed'],
    ['src/x.css', '.a{content:"/*";font-size:12px} /* end */', 'quote-aware stripComments double-quote /*'],
    ['src/x.css', '.a{content:"\\"/*";font-size:12px} /* end */', 'quote-aware stripComments escaped quote before /*'],
    ['src/x.css', '.a{font-variation-settings:"\\77 ght" 700}', 'escaped font-variation-settings wght'],
    ['src/x.css', '.a{font-size:1\\32 px}', 'escaped font-size literal px'],
    ['src/x.css', 'html::before{font-size:var(--root-size)}', 'html::before pseudo-element root-size'],
    ['src/x.css', ':root::after{font-size:var(--root-size)}', ':root::after pseudo-element root-size'],
    ['src/x.css', 'html:before{font-size:var(--root-size)}', 'html:before legacy pseudo-element root-size'],
    ['src/x.css', 'html::part(x){font-size:var(--root-size)}', 'html::part functional pseudo-element root-size'],
    ['src/styles.css', '.markdown code{font-size:.9em}', 'Markdown inline code reads --code-inline-size, not a literal em'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/overlay.css', ':root{font-size:var(--root-size,14px)}'],
    ['src/shadow-base.css', ':where(h3,h4,h5,h6){font-size:1em}'],
    ['src/styles.css', '.markdown code{font-size:var(--code-inline-size)}'],
    ['src/x.css', '.icon{--icon-size:16px}'],
    ['src/tokens.css', ':root{--title-size:19px}'],
    ['src/brand-mark.css', '.desktop-brand-word{font-family:ui-rounded,"SF Pro Rounded","Arial Rounded MT Bold",system-ui,sans-serif}'],
    ['src/x.css', ':root{font-size:var(--root-size)}'],
    ['src/x.css', 'html{font-size:var(--root-size)}'],
    ['src/x.css', ':root,html{font-size:var(--root-size)}'],
    ['src/x.css', '@layer base{.a{font-size:var(--type-body)}}'],
    ['src/x.css', '@scope (.card){.a{font-size:var(--type-body)}}'],
    ['src/x.css', '.a{zoom:1}'],
    ['src/x.css', '.a{zoom:1.0}'],
    ['src/x.css', '.a{zoom:100%}'],
    ['src/x.css', '.a{content:"/*";font-size:var(--type-body)} /* real comment: font-size:12px */'],
    ['src/x.css', '.foo\\>bar{font-size:var(--type-body)}'],
    ['src/x.css', 'html[data-x="a::b"]{font-size:var(--root-size)}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('CSS guard: type roles, leading and tracking', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const bad = [
    ['src/x.css', '.a{line-height:16px}', 'unlisted px leading'],
    ['src/x.css', '.a{letter-spacing:.05em}', 'literal tracking'],
    ['src/x.css', '.a{letter-spacing:var(--type-caption)}', 'tracking token'],
    ['src/x.css', '.a{font:var(--type-body) sans-serif}', 'font family'],
    ['src/x.css', '.a{font-size:var(--type-title);font-weight:var(--type-title-weight)}', 'missing leading'],
    ['src/x.css', '.a{font-size:var(--type-subheading)}', 'missing subheading weight'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--weight-strong);line-height:var(--type-heading-leading)}', 'weight token'],
    ['src/x.css', '.a{font-weight:var(--type-display)}', 'weight family'],
    ['src/x.css', '.a{line-height:var(--type-body)}', 'leading family'],
    ['src/x.css', '.a{line-height:1.45}', 'unitless leading'],
    ['src/x.css', '.a{line-height:120%}', 'percent leading'],
    ['src/x.css', '.a{line-height:1.2em}', 'em leading'],
    ['src/x.css', '.a{line-height:calc(var(--type-body) * 1.2)}', 'calc leading'],
    ['src/x.css', '.a{font:var(--mono-size)/1.45 var(--mono)}', 'shorthand leading'],
    ['src/x.css', '.a{font-size:var(--type-title);font-weight:var(--type-title-weight);line-height:var(--type-title-leading);letter-spacing:var(--tracking-caps)}', 'caps tracking'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading)}', 'missing tracking'],
    ['src/x.css', '.a{font-weight:bold}', 'bold keyword'],
    ['src/x.css', '.a{font-weight:bolder}', 'bolder keyword'],
    ['src/x.css', '.a{font-weight:lighter}', 'lighter keyword'],
    ['src/x.css', '.a{font:bold var(--type-body)/var(--type-body-leading) var(--sans)}', 'shorthand bold'],
    ['src/other.css', '.a{--diff-line-height:calc(var(--mono-size) * 1.6)}', 'diff-line-height wrong file'],
    ['src/diff-viewer.css', '.a{--diff-line-height:20px}', 'diff-line-height wrong value'],
    ['src/x.css', '.a{line-height:var(--leading-tight)}', 'deprecated leading-tight'],
    ['src/x.css', '.a{line-height:var(--leading-ui)}', 'deprecated leading-ui'],
    ['src/x.css', '.a{line-height:var(--leading-body)}', 'deprecated leading-body'],
    ['src/x.css', '.a{font:var(--root-size)/var(--type-body-leading) var(--sans)}', 'root size shorthand'],
    ['src/x.css', '.a{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'body medium'],
    ['src/x.css', '.a{font:var(--weight-medium) var(--type-body)/var(--type-body-leading) var(--sans)}', 'body medium shorthand'],
    ['src/x.css', '.a{font-size:var(--type-body);font-weight:500}', 'body weight 500'],
    ['src/x.css', '.a{text-transform:uppercase}', 'uppercase tracking'],
    ['src/x.css', '.a{text-transform:uppercase;letter-spacing:var(--tracking-tight)}', 'uppercase tight tracking'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--type-prose-leading)}', 'body prose leading'],
    ['src/x.css', '.a{font-size:var(--type-meta);line-height:var(--type-prose-leading)}', 'meta prose leading'],
    ['src/x.css', '.a{font-size:var(--type-caption);line-height:var(--type-body-leading)}', 'caption body leading'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--leading-code)}', 'body code leading'],
    ['src/x.css', '.a{line-height:var(--leading-code)}', 'code leading off mono'],
    ['src/x.css', '.inspector-preview{line-height:var(--leading-code)}', 'preview is not pre'],
    ['src/x.css', '.a{font-size:var(--type-title);font-weight:var(--type-title-weight);line-height:1;letter-spacing:var(--tracking-tight)}', 'title leading is not 1'],
    ['src/x.css', '.example{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);font:var(--type-heading) var(--sans)}', 'shorthand resets heading weight and leading'],
    ['src/x.css', '.example{font-weight:var(--type-heading-weight);font:var(--type-heading)/var(--type-heading-leading) var(--sans);letter-spacing:var(--tracking-tight)}', 'shorthand resets heading weight'],
    ['src/x.css', '.example{line-height:var(--type-heading-leading);font:var(--type-heading-weight) var(--type-heading) var(--sans);letter-spacing:var(--tracking-tight)}', 'shorthand resets heading leading'],
    ['src/x.css', '.a{line-height:var(--type-display-leading)}', 'standalone display leading'],
    ['src/x.css', '.a{line-height:var(--type-title-leading)}', 'standalone title leading'],
    ['src/x.css', '.a{line-height:var(--type-heading-leading)}', 'standalone heading leading'],
    ['src/x.css', '.card h2{line-height:var(--type-title-leading)}', 'non-markdown h2 title leading'],
    ['src/x.css', '.markdown h2{line-height:var(--type-display-leading)}', 'markdown heading display leading'],
    ['src/x.css', '.a{line-height:var(--type-prose-leading)}', 'standalone prose leading'],
    ['src/x.css', '.a{font-size:inherit;line-height:var(--type-prose-leading)}', 'inherit size prose leading'],
    ['src/x.css', '.markdown .chip{line-height:var(--type-prose-leading)}', 'non-prose child inside markdown'],
    ['src/x.css', '.a{@supports (display:grid){font-weight:700}}', 'nested supports numeric weight'],
    ['src/x.css', '.a{@media (max-width:600px){font-weight:var(--weight-strong)}}', 'nested media strong without role'],
    ['src/x.css', '.a{font-variation-settings:"wght" 700}', 'variation weight'],
    ['src/x.css', '.a{font-size:var(--type-body);font-weight:var(--weight-strong)}', 'body strong'],
    ['src/x.css', '.a{font-size:var(--type-meta);font-weight:var(--weight-strong);letter-spacing:var(--tracking-caps)}', 'meta strong caps'],
    ['src/x.css', '.a{font-size:var(--type-caption);font-weight:var(--weight-strong);text-transform:uppercase}', 'caption strong upper'],
    ['src/x.css', '.a{font:var(--weight-strong) var(--type-caption)/1 var(--sans)}', 'caption strong shorthand'],
    ['src/x.css', '.a{font-size:var(--type-prose);font-weight:var(--weight-strong)}', 'prose strong'],
    ['src/x.css', '.a{font-size:var(--type-body);letter-spacing:var(--tracking-tight)}', 'body tight'],
    ['src/x.css', '.a{font-size:var(--type-subheading);font-weight:var(--type-subheading-weight);letter-spacing:var(--tracking-tight)}', 'subheading tight'],
    ['src/x.css', '.a{letter-spacing:var(--tracking-tight)}', 'tight without a role'],
    ['src/x.css', '.a{line-height:var(--type-prose-compact-leading)}', 'compact leading off prose'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--type-prose-compact-leading)}', 'body compact leading'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--type-meta-leading)}', 'body meta leading'],
    ['src/x.css', '.a{--thread-font:var(--type-caption)}', 'thread font caption'],
    ['src/x.css', '.a{font-weight:var(--type-heading-weight)}', 'heading weight without size'],
    ['src/x.css', '.a{font-weight:var(--type-title-weight)}', 'title weight without size'],
    ['src/x.css', '.a{font-weight:var(--type-display-weight)}', 'display weight without size'],
    ['src/x.css', '.a{font-size:var(--type-body);font-weight:var(--type-heading-weight)}', 'heading weight on body'],
    ['src/x.css', '.a{font-size:var(--type-title);font-weight:var(--type-heading-weight);line-height:var(--type-title-leading);letter-spacing:var(--tracking-tight)}', 'heading weight on title'],
    ['src/x.css', '.brand{font-weight:var(--weight-strong)}', 'strong without size'],
    ['src/x.css', '.brand{font-size:inherit;font-weight:var(--weight-strong)}', 'strong with inherit font-size'],
    ['src/x.css', '.brand{font-size:unset;font-weight:var(--weight-strong)}', 'strong with unset font-size'],
    ['src/x.css', '.brand{font:inherit;font-weight:var(--weight-strong)}', 'strong with font inherit'],
    ['src/x.css', '.a,strong{font-weight:var(--weight-strong)}', 'strong list includes other'],
    ['src/x.css', '.a{font-weight:var(--weight-strong);letter-spacing:var(--tracking-caps)}', 'strong caps without uppercase'],
    ['src/x.css', '.a{font-size:var(--mono-size);font-weight:var(--weight-strong)}', 'mono strong'],
    ['src/x.css', '.a{font:var(--weight-strong) var(--mono-size)/var(--leading-code) var(--mono)}', 'mono strong shorthand'],
    ['src/x.css', '.a{font-size:var(--type-body);@media (max-width:600px){font-weight:var(--weight-medium)}}', 'nested media merges parent body with medium weight'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);@media (max-width:600px){font-weight:var(--weight-regular)}}', 'nested media breaks heading weight'],
    ['src/x.css', '.a{font-size:var(--type-body);@supports (display:grid){@media (max-width:600px){font-weight:var(--weight-medium)}}}', 'doubly nested media merges parent body with medium weight'],
    ['src/x.css', '.a{font-size:var(--type-caption);line-height:var(--type-caption-leading);@media (max-width:600px){line-height:normal}}', 'nested media resets caption line-height to normal'],
    ['src/x.css', 'button + .title{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'sibling after button is not control'],
    ['src/x.css', 'button .title{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'descendant of button is not control'],
    ['src/x.css', '.btn > .label{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'child of btn is not control'],
    ['src/x.css', '.card:has(button){font-size:var(--type-body);font-weight:var(--weight-medium)}', ':has(button) is not control'],
    ['src/x.css', '.title:not(button){font-size:var(--type-body);font-weight:var(--weight-medium)}', ':not(button) is not control'],
    ['src/x.css', ':is(button, .title){font-size:var(--type-body);font-weight:var(--weight-medium)}', ':is with non-control branch'],
    ['src/x.css', '.pre-header{line-height:var(--leading-code)}', '.pre-header is not pre'],
    ['src/x.css', 'pre + .note{line-height:var(--leading-code)}', 'sibling after pre is not mono'],
    ['src/x.css', '.card:has(pre){line-height:var(--leading-code)}', ':has(pre) is not mono'],
    ['src/x.css', '.card:not(code){line-height:var(--leading-code)}', ':not(code) is not mono'],
    ['src/x.css', 'pre, .note{line-height:var(--leading-code)}', 'mono list with non-mono'],
    ['src/x.css', ':not(.markdown) strong{font-weight:var(--weight-strong)}', ':not(.markdown) strong is not prose'],
    ['src/x.css', '.card:has(.markdown) strong{font-weight:var(--weight-strong)}', ':has(.markdown) strong is not prose'],
    ['src/x.css', '.markdown + strong{font-weight:var(--weight-strong)}', 'sibling strong after .markdown is not prose'],
    ['src/x.css', '.markdown ~ strong{font-weight:var(--weight-strong)}', 'general sibling strong after .markdown is not prose'],
    ['src/x.css', '.card:not(.markdown){line-height:var(--type-prose-leading)}', ':not(.markdown) is not prose container'],
    ['src/x.css', '.card:has(.markdown){line-height:var(--type-prose-leading)}', ':has(.markdown) is not prose container'],
    ['src/x.css', '.markdown + p{line-height:var(--type-prose-leading)}', 'sibling p after .markdown is not prose container'],
    ['src/x.css', '.markdown, .card{line-height:var(--type-prose-leading)}', 'prose container list with non-prose'],
    ['src/x.css', '.a{--thread-font:var(--type-prose)}', 'thread-font wrong owner file'],
    ['src/x.css', '.a{line-height:var(--type-caption-leading)}', 'standalone caption leading'],
    ['src/x.css', '.a{font-size:var(--type-caption)}', 'caption missing line-height'],
    ['src/x.css', '.a{font:var(--type-caption) var(--sans)}', 'caption shorthand missing line-height'],
    ['src/x.css', '.a{font-size:var(--type-caption);line-height:normal}', 'caption normal line-height'],
    ['src/x.css', '.a{font-size:var(--type-caption);line-height:inherit}', 'caption inherit line-height'],
    ['src/x.css', '@scope (:is(button) + .title){font-size:var(--type-body);font-weight:var(--weight-medium)}', 'scope balanced parens subject is not control'],
    ['src/x.css', '.card{font-size:var(--type-body);&{font-weight:var(--weight-medium)}}', 'ampersand nesting merges body with medium weight'],
    ['src/x.css', '.card{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);&:hover{font-weight:var(--weight-regular)}}', 'ampersand hover breaks heading weight'],
    ['src/x.css', '.c{font-size:var(--type-caption);line-height:var(--type-caption-leading);&{line-height:normal}}', 'ampersand nesting resets caption line-height to normal'],
    ['src/x.css', '.a{font:var(--type-body) var(--mono)}', 'font shorthand missing /line-height'],
    ['src/x.css', '.tab-panel{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'tab-panel container is not control'],
    ['src/x.css', '.button-group{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'button-group container is not control'],
    ['src/x.css', '.card-title{font-size:var(--type-body);font-weight:var(--type-subheading-weight)}', 'subheading weight on body'],
    ['src/x.css', '.card-title{font-weight:var(--type-subheading-weight)}', 'standalone subheading weight'],
    ['src/x.css', '.col{font-size:var(--type-caption);line-height:var(--type-caption-leading);letter-spacing:var(--tracking-caps)}', 'tracking-caps without text-transform uppercase'],
    ['src/x.css', '.card{font-size:var(--type-body);html[data-theme="dark"] &{font-weight:var(--weight-medium)}}', 'ancestor ampersand nest merges body with medium weight'],
    ['src/x.css', '.card{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);.workspace &{font-weight:var(--weight-regular)}}', 'workspace ancestor ampersand nest breaks heading weight'],
    ['src/x.css', '.card{strong{font-weight:var(--weight-strong)}}', 'implicit descendant nest strong outside markdown'],
    ['src/x.css', '.card{h2{line-height:var(--type-title-leading)}}', 'implicit descendant nest h2 title leading outside markdown'],
    ['src/x.css', '.a{text-transform:\\75 ppercase}', 'escaped text-transform uppercase missing tracking-caps'],
    ['src/x.css', '.a{font-weight:\\62 old}', 'escaped font-weight bold'],
    ['src/x.css', 'input[type="text"]{font:inherit;font-size:var(--type-body)}', 'attribute input font:inherit leaks weight'],
    ['src/x.css', 'textarea.note{font:inherit;font-size:var(--type-body)}', 'classed textarea font:inherit leaks weight'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-subheading-leading)}', 'mono-size with subheading leading'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-display-leading)}', 'mono-size with display leading'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-title-leading)}', 'mono-size with title leading'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-heading-leading)}', 'mono-size with heading leading'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-prose-leading)}', 'mono-size with prose leading'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-caption-leading)}', 'mono-size with caption leading'],
    ['src/x.css', '.form textarea{font:inherit}', 'textarea font:inherit without font-size leaks weight'],
    ['src/x.css', 'input.name{font:inherit}', 'classed input font:inherit without font-size leaks weight'],
    ['src/x.css', '@scope (.card){:scope{font-size:var(--type-body);font-weight:var(--weight-medium)}}', 'scope :scope non-control body medium'],
    ['src/x.css', '@scope (.card){:scope{font-size:var(--type-body)}@media (min-width:1px){:scope{font-weight:var(--weight-medium)}}}', 'scope :scope media merges enclosing :scope body medium'],
    ['src/x.css', '@scope (.card){:scope{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}@media (min-width:1px){:scope{font-weight:var(--weight-regular)}}}', 'scope :scope media breaks enclosing heading weight'],
    ['src/x.css', '.foo\\>bar{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'escaped combinator stays non-control'],
    ['src/x.css', 'button\\>label{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'escaped combinator after button is not button'],
    ['src/x.css', '.card{font-size:var(--type-body);@scope (&){font-weight:var(--weight-medium)}}', 'nested @scope (&) inherits parent decls'],
    ['src/x.css', 'input[type=text]{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'text input cannot use button medium weight'],
    ['src/x.css', 'textarea{font-size:var(--type-body);font-weight:var(--weight-medium)}', 'textarea cannot use button medium weight'],
    ['src/x.css', 'input[data-x="a::b"]{font:inherit}', 'input attr containing :: is not a pseudo-element'],
    ['src/x.css', '.card{&{font-size:var(--type-body)}&{font-weight:var(--weight-medium)}}', 'sibling & blocks merge body with medium weight'],
    ['src/x.css', '.card{&{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}&{font-weight:var(--weight-regular)}}', 'sibling & blocks break heading weight'],
  ];
  for (const [file, text, label] of bad) {
    const hits = sample(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.css', '.example{font:var(--type-heading)/var(--type-body-leading) var(--sans);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.example{font:var(--type-title-weight) var(--type-title)/var(--type-title-leading) var(--sans);font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/tray-popover.css', ':root{font:var(--root-size,14px)/var(--type-body-leading) var(--sans)}'],
    ['src/x.css', '.a{font-size:var(--type-subheading);font-weight:var(--type-subheading-weight)}'],
    ['src/x.css', '.a{font-size:var(--type-title);font-weight:var(--type-title-weight);line-height:var(--type-title-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.a{letter-spacing:0;font:var(--mono-size)/var(--leading-code) var(--mono)}'],
    ['src/x.css', '.a{letter-spacing:inherit}'],
    ['src/x.css', '.a{letter-spacing:unset}'],
    ['src/x.css', '.a{font:inherit}'],
    ['src/x.css', '.a{font:inherit;font-size:var(--type-body)}'],
    ['src/x.css', '.a{line-height:1;font-family:var(--sans)}'],
    ['src/x.css', '.a{line-height:0}'],
    ['src/x.css', '.a{line-height:normal}'],
    ['src/x.css', '.a{line-height:var(--control)}'],
    ['src/x.css', '.a{line-height:var(--row-sm)}'],
    ['src/x.css', '.a{font-weight:normal}'],
    ['src/diff-viewer.css', '.diff-viewer{--diff-line-height:calc(var(--mono-size) * 1.6)}'],
    ['src/diff-viewer.ts', ':host{--diffs-font-family:var(--mono);--diffs-font-size:var(--mono-size);--diffs-line-height:calc(var(--mono-size) * 1.6)}'],
    ['src/x.css', 'button{font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', '.ds-btn{font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', 'a.quiet{font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', ':is(button, a){font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', '.card .ds-btn:not(.disabled){font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', '.meta{font-size:var(--type-meta);font-weight:var(--weight-medium)}'],
    ['src/x.css', '.cap{font-size:var(--type-caption);font-weight:var(--weight-medium);line-height:var(--type-caption-leading)}'],
    ['src/x.css', '.cap{font-size:var(--type-caption);line-height:1}'],
    ['src/x.css', '.cap{font-size:var(--type-caption);line-height:var(--row-sm)}'],
    ['src/x.css', '.cap{font:var(--type-caption)/var(--leading-code) var(--mono)}'],
    ['src/x.css', '.a{text-transform:uppercase;letter-spacing:var(--tracking-caps)}'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--type-body-leading)}'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:1}'],
    ['src/x.css', '.a{font-size:var(--type-body);line-height:var(--row)}'],
    ['src/x.css', '.a{font-size:var(--type-prose);line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.a{font-size:var(--thread-font);line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.a{font-size:var(--thread-font);line-height:var(--type-prose-compact-leading)}'],
    ['src/x.css', '.markdown{line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.message-content{line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.gu-md{line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.launcher-thread-message .markdown{line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.markdown table{font-size:inherit;line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.markdown h1,.markdown h2{line-height:var(--type-title-leading)}'],
    ['src/x.css', '.gu-md :is(h1,h2,h3,h4,h5,h6){line-height:var(--type-title-leading)}'],
    ['src/x.css', '.launcher-thread-message :is(h1,h2,h3,h4,h5,h6){line-height:var(--type-title-leading)}'],
    ['src/x.css', '.a{font-size:var(--type-body);@media (max-width:600px){line-height:var(--type-body-leading)}}'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);@media (max-width:600px){line-height:var(--type-heading-leading)}}'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight);@media (max-width:600px){font-size:var(--type-title);font-weight:var(--type-title-weight);line-height:var(--type-title-leading)}}'],
    ['src/x.css', '.a{font-size:var(--type-caption);line-height:var(--type-caption-leading);@layer compact{line-height:1}}'],
    ['src/x.css', '.markdown strong{@media (max-width:600px){font-weight:var(--weight-strong)}}'],
    ['src/x.css', 'pre{font-size:var(--type-meta);line-height:var(--leading-code)}'],
    ['src/x.css', '.a{font-family:var(--mono);line-height:var(--leading-code)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--leading-code)}'],
    ['src/x.css', '.code-preview{line-height:var(--leading-code)}'],
    ['src/x.css', '.a{font-size:var(--type-title,var(--type-body));font-weight:var(--type-title-weight);line-height:var(--type-title-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.a{font-size:var(--type-subheading);font-weight:var(--type-subheading-weight);line-height:var(--type-subheading-leading)}'],
    ['src/x.css', '.a{font-size:var(--type-caption);font-weight:var(--weight-strong);letter-spacing:var(--tracking-caps);text-transform:uppercase;line-height:var(--type-caption-leading)}'],
    ['src/task-board.css', '.side-thread{--thread-font:var(--type-meta)}'],
    ['src/styles.css', ':root{--thread-font:var(--type-prose)}'],
    ['src/overlay.css', ':root{--thread-font:var(--type-prose)}'],
    ['src/brand-mark.css', '.desktop-brand-word{font-size:20px;letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.a{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.markdown strong{font-weight:var(--weight-strong)}'],
    ['src/x.css', '.message-meta strong{font-weight:var(--weight-strong)}'],
    ['src/x.css', '.gu-md strong,.gu-md b{font-weight:var(--weight-strong)}'],
    ['src/x.css', '.launcher-thread-message :is(strong,b){font-weight:var(--weight-strong)}'],
    ['src/x.css', '.markdown strong{font-size:inherit;font-weight:var(--weight-strong)}'],
    ['src/x.css', '.a{font-size:inherit;font-weight:var(--weight-strong);text-transform:uppercase;letter-spacing:var(--tracking-caps)}'],
    ['src/x.css', '.a{font-weight:var(--weight-strong);text-transform:uppercase;letter-spacing:var(--tracking-caps)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);font-weight:var(--weight-medium);line-height:var(--leading-code)}'],
    ['src/x.css', 'button{&:hover{font-size:var(--type-body);font-weight:var(--weight-medium)}}'],
    ['src/x.css', '.markdown{& strong{font-weight:var(--weight-strong)}}'],
    ['src/x.css', '.card{font-size:var(--type-caption);line-height:var(--type-caption-leading);&:hover{color:var(--text)}}'],
    ['src/x.css', 'button{html[data-theme="dark"] &{font-size:var(--type-body);font-weight:var(--weight-medium)}}'],
    ['src/x.css', '.markdown{strong{font-weight:var(--weight-strong)}}'],
    ['src/x.css', '.markdown{> strong{font-weight:var(--weight-strong)}}'],
    ['src/x.css', '.markdown{h2{line-height:var(--type-title-leading)}}'],
    ['src/x.css', '.a{text-transform:\\75 ppercase;letter-spacing:var(--tracking-caps)}'],
    ['src/x.css', '.a{font-size:var(--type-heading, var(--type-body));font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}'],
    ['src/x.css', '.a{font-size:var(--thread-font, var(--type-prose));line-height:var(--type-prose-leading)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--leading-code)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-meta-leading)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--type-body-leading)}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:1}'],
    ['src/x.css', '.a{font-size:var(--mono-size);line-height:var(--row-sm)}'],
    ['src/tray-popover.css', ':root{--thread-font:var(--type-prose)}'],
    ['src/x.css', 'input[type=submit]{font-size:var(--type-body);font-weight:var(--weight-medium)}'],
    ['src/x.css', ':is(.gu-md,.rich-markdown) :is(h1,h2,h3,h4,h5,h6){line-height:var(--type-title-leading)}'],
    ['src/x.css', '@scope (button){:scope{font-size:var(--type-body);font-weight:var(--weight-medium)}}'],
    ['src/x.css', '@scope (button){:scope{font-size:var(--type-body)}@media (min-width:1px){:scope{font-weight:var(--weight-medium)}}}'],
    ['src/x.css', '@scope (.card){:scope{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}@media (min-width:1px){:scope{line-height:var(--type-heading-leading)}}}'],
    ['src/x.css', 'input::placeholder{font:inherit}'],
    ['src/x.css', '.card{&{font-size:var(--type-body)}&{line-height:var(--type-body-leading)}}'],
  ];
  for (const [file, text, label] of good) {
    const hits = sample(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});
