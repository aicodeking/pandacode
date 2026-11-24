/**
 * Static design-token guard, part 3: closed bypasses.
 * Select author rules and the shared select rule, synthetic caps and var() indirection,
 * browser-default resets, SVG and canvas typography, clip-path rounds, and the
 * effective-typography and canonical-definition locks each reject a known escape.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root, selectImportPolicy } from './design-tokens/allowlists.mjs';
import {
  scanCss, valueResolves, tokenMap, tokensCss, designSystemCss, designSystemLocked, declarations, fontParts,
  sharedSelectRuleProblems, sharedSelectImageProblems,
} from './design-tokens/parser.mjs';
import { effectiveStyle } from './design-tokens/pairing.mjs';
import { loadRulebook, compareRulebook, repeatedLocked, tightContainerProblems } from './design-tokens/docs.mjs';
import { scanTsFile, scanHtml } from './design-tokens/ts-style.mjs';
import { baseSheetFlowProblems } from './design-tokens/flow.mjs';
import { collectSelectClasses, selectClasses } from './design-tokens/parser-select.mjs';

test('select fill, padding and chevron author rules are checked without selector-name false positives', () => {
  const scan = (selector, css, file = 'src/x.css') => scanCss(file, `${selector}{${css}}`, new Set(), new Map(), new Set());
  for (const selector of ['select', ':is(input,select)', ':where(select):hover', ':not(:not(select))']) {
    assert.ok(scan(selector, 'background:var(--panel)').some(hit => hit.includes('select fill')), selector);
  }
  assert.ok(scan('select', 'background:transparent').some(hit => hit.includes('select fill')));
  assert.deepEqual(scan('select', 'background-color:var(--panel)'), []);
  assert.deepEqual(scan('select', 'padding-block:4px;padding-inline-start:8px'), []);
  assert.deepEqual(scan('select', 'padding-inline-end:30px'), []);
  assert.deepEqual(scan('select', 'padding-inline-end:40px'), []);
  for (const css of ['padding:4px 8px', 'padding-inline:8px', 'padding-right:8px', 'padding-inline-end:29px']) {
    assert.ok(scan('select', css).some(hit => hit.includes('select padding')), css);
  }
  assert.deepEqual(scan('select', 'background-image:var(--select-chevron)'), []);
  for (const css of ['background-image:url("data:image/svg+xml,other")', 'background-image:var(--my-chevron)', '--other-chevron:url("data:image/svg+xml,other")']) {
    assert.ok(scan('select', css).some(hit => hit.includes('select chevron')), css);
  }
  for (const selector of ['::selection', '[aria-selected]', '.selected', '.selection', '.sketch-select', 'select option', 'select::before', ':not(select)', ':is(button,textarea):not(select)', '.row:has(select)']) {
    assert.deepEqual(scan(selector, 'background:var(--panel);padding:4px 8px'), [], selector);
  }
  for (const selector of ['select[multiple]', 'select[size="3"]', 'select:where([multiple],[size]:not([size="1"]))', ':is(input,select):where(:not(select),[multiple],[size]:not([size="1"]))']) {
    assert.deepEqual(scan(selector, 'padding-inline-end:8px'), [], selector);
  }
  assert.ok(scan('select[size="1"]', 'padding-inline-end:8px').some(hit => hit.includes('select padding')));
  assert.ok(scan('select:not([multiple])', 'padding:0').some(hit => hit.includes('select padding')));
  for (const selector of ['select:not(.compact-form select)', 'select:not(.a > select,[multiple])', 'select:is(.form select)', 'select:where(:not(.a + select))', '.row :is(.form select)']) {
    const hits = scan(selector, 'background:#fff;padding:0');
    assert.ok(hits.some(hit => hit.includes('select fill')) && hits.some(hit => hit.includes('select padding')), selector);
  }
  assert.deepEqual(scan('select:not(.compact-form select)[multiple]', 'padding-inline-end:8px'), [], 'complex branches keep exact attribute logic');
  assert.ok(scanCss('src/x.css', '.a{@media (width > 1px){& select{background:var(--panel)}}}', new Set(), new Map(), new Set()).some(hit => hit.includes('select fill')), 'nested selectors');
  assert.ok(scanCss('src/x.css', '.a{\\73 elect{background:var(--panel)}}', new Set(), new Map(), new Set()).some(hit => hit.includes('select fill')), 'escaped select type');
  assert.deepEqual(scan('select', 'background:transparent;padding:0', 'src/overlay.css'), [], 'exclusive launcher sheet is exempt');
});

test('select policy exemptions follow the runtime window import graphs', () => {
  const policy = selectImportPolicy();
  assert.deepEqual([...policy.exemptSheets].sort(), ['src/overlay-model-picker.css', 'src/overlay.css', 'src/tray-popover.css']);
  assert.equal(policy.exemptFiles.has('src/motion.css'), false, 'shared sheet stays guarded');
  assert.equal(policy.exemptFiles.has('src/generative-ui.css'), false, 'shadow form sheet stays guarded');
});

test('known select receivers obey the same author rules in TypeScript style APIs and HTML', () => {
  const select = "const field = document.createElement('select'); ";
  for (const source of [
    "field.style.backgroundColor = 'var(--panel)';",
    "field.style.paddingBlock = '4px'; field.style.paddingInlineStart = '8px';",
    "field.style.paddingInlineEnd = '30px';",
    "field.style.backgroundImage = 'var(--select-chevron)';",
  ]) assert.deepEqual(scanTsFile('src/x.ts', select + source), [], source);
  for (const source of [
    "field.style.background = 'transparent';",
    "field.style.setProperty('background', fill);",
    "field.style.padding = '4px 8px';",
    "field.style.paddingInlineEnd = '20px';",
    "field.attributeStyleMap.append('padding-inline-end', '10px', '20px');",
    "field.style.backgroundImage = 'none';",
    "Object.assign(field.style, { backgroundImage: 'url(other.svg)' });",
    "field.style.setProperty('--private-chevron', 'url(other.svg)');",
    "const st = field.style; st.background = 'transparent';",
    "const { style: st } = field; st.padding = '0';",
    "Reflect.set(field.style, 'background', 'transparent');",
    "field.style.cssText = 'padding:0';",
    "field.setAttribute('style', 'background:transparent');",
  ]) assert.ok(scanTsFile('src/x.ts', select + source).some(hit => /select (?:fill|padding|chevron)/.test(hit)), source);
  assert.ok(scanTsFile('src/x.ts', "const field = document.querySelector('select'); field.style.background = 'transparent';").length);
  assert.ok(scanTsFile('src/x.ts', "const field = document.querySelector<HTMLSelectElement>('.settings-select'); field.style.background = 'transparent';").length);
  assert.ok(scanTsFile('src/x.ts', "(field as HTMLSelectElement).style.padding = '0';").length);
  assert.ok(scanTsFile('src/x.ts', "function f(field: HTMLSelectElement) { field.style.paddingInlineEnd = '10px'; }").length);
  assert.deepEqual(scanTsFile('src/x.ts', "const field = document.createElement('button'); field.style.background = 'transparent';"), [], 'unrelated receivers are not inferred from their name');
  assert.deepEqual(scanTsFile('src/x.ts', "const field = document.querySelector('select[multiple]'); field.style.paddingInlineEnd = '8px';"), [], 'known multi-line query');
  assert.ok(scanTsFile('src/x.ts', "const css = 'select{background:transparent}';").some(hit => hit.includes('select fill')), 'embedded CSS discovery');
  assert.deepEqual(scanTsFile('src/x.tsx', '<select style={{ backgroundColor: "var(--panel)", paddingInlineEnd: "30px" }} />'), []);
  assert.deepEqual(scanTsFile('src/x.tsx', '<select multiple style={{ paddingInlineEnd: "8px" }} />'), []);
  for (const jsx of ['<select style={{ background: "transparent" }} />', '<select style={{ padding: "0" }} />', '<select style={{ backgroundImage: "none" }} />']) assert.ok(scanTsFile('src/x.tsx', jsx).length, jsx);
  assert.deepEqual(scanHtml('src/x.html', '<select style="background-color:var(--panel);padding-block:4px;padding-inline-start:8px"></select>'), []);
  for (const html of ['<select style="background:transparent"></select>', '<select style="padding:0"></select>', '<select style="background-image:none"></select>']) assert.ok(scanHtml('src/x.html', html).length, html);
});

test('select-capable shadow sheets keep the shared single-line select rule', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const base = 'select:where(:not([multiple]):not([size]),:not([multiple])[size="1"]){appearance:none;-webkit-appearance:none;background-image:var(--select-chevron);background-repeat:no-repeat;background-position:right 11px center;padding-inline-end:30px}';
  assert.deepEqual(sharedSelectRuleProblems(base), []);
  for (const css of [
    '', base.replace('appearance:none', 'appearance:auto'), base.replace('var(--select-chevron)', 'none'), base.replace('30px', '20px'),
    `${base}@media print{${base}}`, `@media print{${base}}`, `@supports (appearance:none){${base}}`, `@container (min-width:1px){${base}}`, `@layer base{${base}}`, `.host{${base}}`,
  ]) {
    assert.ok(sharedSelectRuleProblems(css).length, css || '(missing rule)');
  }
  for (const file of ['src/design-system.css', 'src/generative-ui.css']) assert.deepEqual(sharedSelectRuleProblems(read(file)), [], file);
  assert.deepEqual(baseSheetFlowProblems(read('src/generative-ui.ts'), read('src/rich-markdown.ts')), [], 'generative sheet (which holds the shared select rule) reaches every generative shadow root');
  for (const file of ['src/rich-markdown.ts', 'src/generative-ui-components.ts']) {
    assert.match(read(file), /FORBID_TAGS:\s*\[[^\]]*'select'/, `${file} cannot expose a select without adding the shared sheet`);
  }
});

test('native select fallback is restricted to the exact shared forced-colors rules', () => {
  const shared = 'select:where(:not([multiple]):not([size]),:not([multiple])[size="1"])';
  const scan = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  for (const file of ['src/design-system.css', 'src/generative-ui.css', 'src/overlay.css']) {
    const selector = file === 'src/overlay.css' ? '.launcher-project select' : shared;
    const rule = `${selector}{appearance:auto;-webkit-appearance:menulist;background-image:none;padding-inline-end:8px}`;
    const css = `@media(forced-colors:active){${rule}}`;
    assert.deepEqual(scan(file, css), [], file);
    for (const source of [rule, `@media print{${rule}}`, `@supports (display:grid){${rule}}`, `@media(forced-colors:active){.other ${rule}}`, `@media print{${css}}`, css.replace('appearance:auto;', ''), css.replace('background-image:none', 'background-image:url(other.svg)')]) assert.ok(scan(file, source).length, `${file} ${source}`);
    assert.ok(scan('src/x.css', css).length, 'another file cannot claim ownership');
  }
});

test('only the shared select rule clears appearance; component copies would erase the forced-colors arrow', () => {
  const scan = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const shared = 'select:where(:not([multiple]):not([size]),:not([multiple])[size="1"])';
  for (const file of ['src/design-system.css', 'src/generative-ui.css']) assert.deepEqual(scan(file, `${shared}{appearance:none;-webkit-appearance:none;background-image:var(--select-chevron);background-repeat:no-repeat;background-position:right 11px center;padding-inline-end:30px}`), [], file);
  assert.deepEqual(scan('src/overlay.css', '.launcher-project select{appearance:none;-webkit-appearance:none}'), [], 'the launcher picker is the overlay shared rule');
  for (const [file, css] of [
    ['src/x.css', '.foo select{appearance:none}'],
    ['src/x.css', '.foo select{-webkit-appearance:none}'],
    ['src/jev-live.css', '.jev-live-run-picker select{appearance:none;-webkit-appearance:none}'],
    ['src/design-system.css', '.picker select{appearance:none}'],
    ['src/overlay.css', '.launcher-other select{appearance:none}'],
  ]) assert.ok(scan(file, css).some(hit => /belongs only to the shared select rule/.test(hit)), `${file} ${css}`);
  // all:unset resets appearance and the chevron too, not only the inherited font weight.
  for (const [file, css] of [['src/x.css', '.foo select{all:unset}'], ['src/x.css', 'select.picker{all:revert}'], ['src/overlay.css', '.launcher-project select{all:unset}']]) {
    assert.ok(scan(file, css).some(hit => /select all:\w+ strips the shared appearance, chevron and padding/.test(hit)), `${file} ${css}`);
  }
});

test('class-only rules on classes src/ places on a <select> follow the same select policy', () => {
  const scan = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const classes = selectClasses();
  for (const name of ['settings-select', 'voice-select', 'agent-team-effort', 'schedules-unit']) assert.ok(classes.has(name), `${name} is discovered on a <select>`);
  assert.deepEqual([...collectSelectClasses([
    '<select class="a-pick ${x}" aria-label="x">', "node('select', 'b-pick')", "h('select', { className: 'c-pick' })",
    "const s = document.createElement('select'); s.className = 'd-pick'; s.classList.add('e-pick', \"f-pick\");", '<div class="not-select">',
  ])].sort(), ['a-pick', 'b-pick', 'c-pick', 'd-pick', 'e-pick', 'f-pick']);
  for (const [css, pattern] of [
    ['.settings-select{appearance:none}', /belongs only to the shared select rule/],
    ['.settings-select{all:unset}', /select all:unset strips/],
    ['.settings-select{padding-inline-end:4px}', /at least the base 30px/],
    ['.panel .voice-select:hover{background:none}', /background shorthand/],
    [':is(.agent-team-effort){background-position:left}', /chevron position/],
  ]) assert.ok(scan('src/x.css', css).some(hit => pattern.test(hit)), css);
  for (const css of [
    '.agent-team-effort:where([multiple],[size]:not([size="1"])){padding-inline-end:10px}',
    '.settings-select{padding-inline-end:30px;padding-block:6px}',
    '.settings-select option{all:unset}', 'input.settings-select{appearance:none}', '.row:not(.settings-select){appearance:none}',
  ]) assert.deepEqual(scan('src/x.css', css).filter(hit => /select/.test(hit)), [], css);
});

test('[class~=], [class=] and substring attribute selectors naming a <select> class follow the select policy', () => {
  const scan = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  for (const [css, pattern] of [
    ['[class~="settings-select"]{appearance:none}', /belongs only to the shared select rule/],
    ['[class="settings-select"]{all:unset}', /select all:unset strips/],
    ["[class~='voice-select']{padding-inline-end:4px}", /at least the base 30px/],
    ['[class~=settings-select]{appearance:none}', /belongs only to the shared select rule/],
    ['[class="field settings-select"]{appearance:none}', /belongs only to the shared select rule/],
    ['[class~="SETTINGS-SELECT" i]{appearance:none}', /belongs only to the shared select rule/],
    [':is([class~="schedules-unit"]){background-position:left}', /chevron position/],
    // Substring operators reach every known select class they would match on their own.
    ['[class^="settings-sel"]{appearance:none}', /belongs only to the shared select rule/],
    ['[class*="settings-select"]{all:unset}', /select all:unset strips/],
    ['[class$="-select"]{padding-inline-end:4px}', /at least the base 30px/],
    ['[class*="SETTINGS-SEL" i]{appearance:none}', /belongs only to the shared select rule/],
    ['select{background-origin:content-box}', /background-origin and background-clip/],
    ['select{background-clip:content-box}', /background-origin and background-clip/],
    ['[class~="settings-select"]{background-clip:padding-box}', /background-origin and background-clip/],
    // Hiding, blending or detaching the chevron image is the shared rule's call too.
    ['select{background-attachment:fixed}', /chevron visibility belongs to the shared select rule/],
    ['select{background-blend-mode:multiply}', /chevron visibility belongs to the shared select rule/],
    ['select{mask:none}', /chevron visibility belongs to the shared select rule/],
    ['select{mask-image:none}', /chevron visibility belongs to the shared select rule/],
    ['select{-webkit-mask:none}', /chevron visibility belongs to the shared select rule/],
    ['select{-webkit-mask-image:linear-gradient(black,transparent)}', /chevron visibility belongs to the shared select rule/],
    ['.settings-select{mask-image:none}', /chevron visibility belongs to the shared select rule/],
  ]) assert.ok(scan('src/x.css', css).some(hit => pattern.test(hit)), css);
  for (const css of [
    'input[class~="settings-select"]{appearance:none}',
    '[class~="settings-select"][multiple]{padding-inline-end:10px}',
    '[class~="SETTINGS-SELECT"]{appearance:none}',
    '[class~="field settings-select"]{appearance:none}',
    '[class="settings-select-wrap"]{appearance:none}',
    '.row:not([class~="settings-select"]){appearance:none}',
    'input[class*="settings-select"]{appearance:none}',
    '[class*=""]{appearance:none}',
    '[class*="SETTINGS-SEL"]{appearance:none}',
    '[class^="zz-not-a-select"]{appearance:none}',
  ]) assert.deepEqual(scan('src/x.css', css).filter(hit => /select/.test(hit)), [], css);
});

test('one themed select image property owns the chevron', () => {
  const sample = ':root{--select-chevron:url("data:image/svg+xml,light")}html[data-theme="dark"]{--select-chevron:url("data:image/svg+xml,dark")}';
  assert.deepEqual(sharedSelectImageProblems(sample), []);
  assert.deepEqual(sharedSelectImageProblems(tokensCss), []);
  assert.ok(sharedSelectImageProblems(sample + ':root{--select-chevron:url("data:image/svg+xml,other")}').length, 'duplicate light definition');
  assert.ok(sharedSelectImageProblems(sample.replace('data:image/svg+xml,dark', 'other.svg')).length, 'unshared external image');
  for (const file of ['src/x.css', 'src/generative-ui.css']) {
    assert.ok(scanCss(file, ':root{--select-chevron:url("data:image/svg+xml,other")}', new Set(), new Map(), new Set()).some(hit => hit.includes('redefines canonical token --select-chevron')), file);
  }
});

test('glyph scaling and caps properties are forbidden in CSS and style APIs', () => {
  for (const [property, jsKey, value] of [
    ['font-size-adjust', 'fontSizeAdjust', 'none'],
    ['-webkit-text-size-adjust', 'webkitTextSizeAdjust', '100%'],
    ['font-variant-caps', 'fontVariantCaps', 'normal'],
  ]) {
    for (const css of [`.a{${property}:${value}}`, `${property}:${value}`, `@media (width > 1px){.a{${property}:${value}}}`]) {
      assert.ok(scanCss('src/x.css', css, new Set(), new Map(), new Set()).some(hit => hit.includes(`${property} is not allowed`)), css);
    }
    for (const source of [
      `el.style.${jsKey} = '${value}';`,
      `el.style['${property}'] = '${value}';`,
      `el.style.setProperty('${property}', '${value}');`,
      `el.attributeStyleMap.set('${property}', '${value}');`,
      `el.attributeStyleMap.append('${property}', '${value}', '${value}');`,
      `Object.assign(el.style, { ${jsKey}: '${value}' });`,
      `el.style.cssText = '${property}:${value}';`,
      `el.style.${jsKey} = computed;`,
      `el.style.setProperty('${property}', computed);`,
    ]) {
      assert.ok(scanTsFile('src/x.ts', source).some(hit => hit.includes(`${property} is not allowed`)), source);
    }
    assert.ok(scanTsFile('src/x.ts', `const css = '.a{${property}:${value}}';`).some(hit => hit.includes(`${property} is not allowed`)), 'embedded CSS is discovered');
  }
});

test('closed bypasses: caps features, SVG font attributes, canvas fonts, radius shorthand, resets and select chevrons', () => {
  const css = (source, file = 'src/x.css') => scanCss(file, source, new Set(), new Map(), new Set());
  const expectHit = (hits, pattern, label) => assert.ok(hits.some(hit => pattern.test(hit)), `${label}: ${hits.join(' | ') || '(no hits)'}`);
  const caps = /synthesizes caps|enables a caps feature/;
  for (const value of ['small-caps', 'all-small-caps', 'petite-caps', 'all-petite-caps', 'unicase', 'titling-caps', 'SMALL-CAPS', 'small-caps tabular-nums']) {
    expectHit(css(`.a{font-variant:${value}}`), caps, `css font-variant ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.fontVariant = '${value}';`), caps, `style.fontVariant ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.setProperty('font-variant', '${value}');`), caps, `setProperty font-variant ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.cssText = 'font-variant:${value}';`), caps, `cssText font-variant ${value}`);
    expectHit(scanTsFile('src/x.ts', `Object.assign(el.style, { fontVariant: '${value}' });`), caps, `Object.assign fontVariant ${value}`);
    expectHit(scanHtml('index.html', `<div style="font-variant:${value}"></div>`), caps, `inline HTML font-variant ${value}`);
  }
  expectHit(css('.a{font:small-caps var(--type-body)/var(--type-body-leading) var(--sans)}'), caps, 'font shorthand small-caps');
  for (const value of ['"smcp"', "'c2sc'", '"pcap" 1', "'c2pc' on", 'unic', '"TITL"', '"tnum", "smcp"']) {
    expectHit(css(`.a{font-feature-settings:${value}}`), caps, `css font-feature-settings ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.fontFeatureSettings = ${JSON.stringify(value)};`), caps, `style.fontFeatureSettings ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.setProperty('font-feature-settings', ${JSON.stringify(value)});`), caps, `setProperty font-feature-settings ${value}`);
    expectHit(scanTsFile('src/x.ts', `Object.assign(el.style, { fontFeatureSettings: ${JSON.stringify(value)} });`), caps, `Object.assign fontFeatureSettings ${value}`);
    expectHit(scanHtml('index.html', `<div style='font-feature-settings:${value.replaceAll("'", '"')}'></div>`), caps, `inline HTML font-feature-settings ${value}`);
  }
  for (const source of ['.a{font-variant:normal}', '.a{font-variant:tabular-nums}', '.a{font-variant-numeric:tabular-nums}', '.a{font-feature-settings:"tnum"}', '.a{font-feature-settings:normal}']) {
    assert.deepEqual(css(source), [], source);
  }
  assert.deepEqual(scanTsFile('src/x.ts', "el.style.fontVariant = 'tabular-nums'; el.style.setProperty('font-feature-settings', '\"tnum\"');"), []);

  const svg = /\(svg text\)|setAttribute(?:NS)?\('font-/;
  for (const source of [
    'el.innerHTML = `<g font-size="13"></g>`;',
    'el.innerHTML = `<svg font-size="13"><text>x</text></svg>`;',
    'el.innerHTML = `<svg><textPath font-size="13">x</textPath></svg>`;',
    'el.innerHTML = `<svg><tspan font-size="13">x</tspan></svg>`;',
    'el.innerHTML = `<svg><text font-weight="700">x</text></svg>`;',
    'el.innerHTML = `<svg><g font-weight="bold"><text>x</text></g></svg>`;',
    'el.innerHTML = `<svg><text font-family="Arial">x</text></svg>`;',
    'el.innerHTML = `<svg xmlns="http://www.w3.org/2000/svg"><text font-size="13">x</text></svg>`;',
    'const icon = `<svg xmlns="http://www.w3.org/2000/svg"><text font-weight="600">x</text></svg>`; el.innerHTML = icon;',
    "el.setAttribute('font-size', '13');",
    "el.setAttribute('font-weight', '700');",
    "el.setAttribute('FONT-FAMILY', 'Arial');",
    "el.setAttributeNS(null, 'font-size', '13px');",
    "const size = '13'; el.setAttribute('font-size', size);",
  ]) expectHit(scanTsFile('src/x.ts', source), svg, source);
  expectHit(scanHtml('index.html', '<svg><g font-size="13"><text>x</text></g></svg>'), svg, 'HTML inline svg g font-size');
  expectHit(scanTsFile('src/trace-brands.ts', '`<svg><text font-size="10.5" font-weight="600" font-family="system-ui,sans-serif">P</text></svg>`'), svg, 'trace-brands literal is exact');
  for (const source of [
    'el.innerHTML = `<svg><text font-size="${n(size)}" font-weight="${weight}">1</text></svg>`;',
    'el.innerHTML = `<svg><text font-size="var(--type-caption)" font-weight="var(--weight-medium)" font-family="var(--sans)">1</text></svg>`;',
    "el.setAttribute('font-size', String(n));",
    "el.setAttribute('font-size', 'var(--type-caption)');",
    'const u = `data:image/svg+xml,${encodeURIComponent(`<svg xmlns="http://www.w3.org/2000/svg"><text font-size="13">x</text></svg>`)}`;',
    "const u = 'url(\"data:image/svg+xml,<svg xmlns=%27http://www.w3.org/2000/svg%27><text font-size=%2713%27>x</text></svg>\")';",
    'const shot = `<svg xmlns="http://www.w3.org/2000/svg"><text font-size="14">x</text></svg>`; img.src = `data:image/svg+xml;base64,${btoa(shot)}`;',
    'const blob = new Blob([`<svg xmlns="http://www.w3.org/2000/svg"><text font-size="14">x</text></svg>`], { type: "image/svg+xml" });',
  ]) assert.deepEqual(scanTsFile('src/x.ts', source), [], source);
  assert.deepEqual(scanTsFile('src/preview.ts', 'const svg = `<svg xmlns="http://www.w3.org/2000/svg"><text font-size="14">x</text></svg>`;'), [], 'preview image fixtures');

  const canvas = /canvas font/;
  for (const source of ['ctx.font = "600 13px sans-serif";', 'c.font = "600 13px sans-serif";', "const F = '13px monospace'; ctx.font = F;", 'ctx.font = `600 ${size}px sans-serif`;', "ctx['font'] = '12px system-ui';"]) {
    expectHit(scanTsFile('src/x.ts', source), canvas, source);
  }
  for (const source of ['ctx.font = style.font;', 'ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;', 'ctx.font = getComputedStyle(el).font;', "ctx.fillText('600 13px', 0, 0);"]) {
    assert.deepEqual(scanTsFile('src/x.ts', source), [], source);
  }
  assert.deepEqual(scanTsFile('src/preview.ts', "g.font = '600 17px -apple-system, sans-serif';"), [], 'preview canvas fixtures stay exempt');
  for (const [file, receiver] of [['src/sketch.ts', 'context'], ['src/simulator-3d.ts', 'paint']]) {
    assert.deepEqual(scanTsFile(file, `${receiver}.font = \`500 \${n}px sans-serif\`;`), [], `${file} canvas-font exemption`);
    assert.ok(scanTsFile(file, 'other.font = `500 ${n}px sans-serif`;').some(hit => canvas.test(hit)), `${file} exemption covers only its named canvas context`);
  }

  const shorthand = /multi-value (?:-webkit-)?border-radius shorthand/;
  for (const value of ['var(--ds-card-radius) var(--ds-card-radius) 0 0', '0 var(--ds-inner-radius)', 'var(--ds-control-radius) 0 0']) {
    expectHit(css(`.a{border-radius:${value}}`), shorthand, `css border-radius ${value}`);
    expectHit(css(`.a{-webkit-border-radius:${value}}`), shorthand, `css -webkit-border-radius ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.borderRadius = '${value}';`), shorthand, `style.borderRadius ${value}`);
    expectHit(scanTsFile('src/x.ts', `el.style.setProperty('border-radius', '${value}');`), shorthand, `setProperty border-radius ${value}`);
    expectHit(scanHtml('index.html', `<div style="border-radius:${value}"></div>`), shorthand, `inline HTML border-radius ${value}`);
  }
  for (const source of ['.a{border-radius:var(--ds-card-radius)}', '.a{border-radius:var(--inset-radius,var(--ds-card-radius))}', '.a{border-radius:50%}', '.a{border-start-start-radius:var(--ds-card-radius);border-start-end-radius:var(--ds-card-radius);border-end-start-radius:0;border-end-end-radius:0}']) {
    assert.deepEqual(css(source), [], source);
  }
  assert.ok(!css('.a{border-radius:calc(var(--ds-card-radius) - 1px)}').some(hit => shorthand.test(hit)), 'one calc() is one value');

  const reset = /resets to the browser default/;
  for (const decl of ['font:initial', 'font-size:initial', 'font-size:revert', 'font:revert', 'font-family:initial', 'font-family:REVERT', 'all:initial', 'all:revert', 'font-size:revert-layer']) {
    expectHit(css(`div{${decl}}`), reset, `css ${decl}`);
    expectHit(scanHtml('index.html', `<div style="${decl}"></div>`), reset, `inline HTML ${decl}`);
    expectHit(scanTsFile('src/x.ts', `el.style.cssText = '${decl}';`), reset, `cssText ${decl}`);
    const [property, value] = decl.split(':');
    expectHit(scanTsFile('src/x.ts', `el.style.setProperty('${property}', '${value}');`), reset, `setProperty ${decl}`);
  }
  expectHit(scanTsFile('src/x.ts', "el.style.all = 'initial';"), reset, 'style.all initial');
  expectHit(scanTsFile('src/x.ts', "el.style.fontSize = 'revert';"), reset, 'style.fontSize revert');
  expectHit(scanTsFile('src/x.ts', "Object.assign(el.style, { fontFamily: 'initial' });"), reset, 'Object.assign fontFamily initial');
  for (const source of ['.gu-sort{all:unset}', 'div{font:inherit}', 'div{font-size:inherit}', 'div{font-size:unset}', 'div{font-family:inherit}', '.a{letter-spacing:inherit}']) {
    assert.deepEqual(css(source), [], source);
  }
  assert.deepEqual(scanTsFile('src/x.ts', "el.style.all = 'unset'; el.style.fontSize = 'inherit';"), []);

  const chevron = /select chevron|select (?:-webkit-)?appearance/;
  for (const decl of ['background-position:center', 'background-position:right 4px center', 'background-position-x:right', 'background-repeat:repeat', 'background-repeat:no-repeat', 'background-size:12px', 'appearance:auto', 'appearance:menulist-button', '-webkit-appearance:menulist']) {
    expectHit(css(`select{${decl}}`), chevron, `css select ${decl}`);
    expectHit(css(`.settings select{${decl}}`), chevron, `css descendant select ${decl}`);
    expectHit(scanHtml('src/x.html', `<select style="${decl}"></select>`), chevron, `inline HTML select ${decl}`);
    const [property, value] = decl.split(':');
    expectHit(scanTsFile('src/x.ts', `const s = document.createElement('select'); s.style.setProperty('${property}', '${value}');`), chevron, `TS select setProperty ${decl}`);
  }
  expectHit(scanTsFile('src/x.ts', "const s = document.createElement('select'); s.style.appearance = 'auto';"), chevron, 'TS select style.appearance');
  expectHit(scanTsFile('src/x.ts', "const s = document.createElement('select'); Object.assign(s.style, { backgroundSize: '8px' });"), chevron, 'TS select Object.assign backgroundSize');
  expectHit(scanTsFile('src/x.tsx', '<select style={{ backgroundPosition: "center" }} />'), chevron, 'JSX select backgroundPosition');
  const shared = 'select:where(:not([multiple]):not([size]),:not([multiple])[size="1"])';
  for (const file of ['src/design-system.css', 'src/generative-ui.css']) {
    assert.deepEqual(css(`${shared}{appearance:none;-webkit-appearance:none;background-image:var(--select-chevron);background-repeat:no-repeat;background-position:right 11px center;padding-inline-end:30px}`, file), [], `${file} shared rule`);
    assert.deepEqual(css(`${shared}:dir(rtl){background-position:left 11px center}`, file), [], `${file} :dir(rtl) chevron position`);
    expectHit(css(`${shared}:dir(rtl){background-position:right 11px center}`, file), chevron, `${file} rtl keeps the chevron on the left`);
    expectHit(css(`${shared}{background-position:left 11px center}`, file), chevron, `${file} ltr keeps the chevron on the right`);
  }
  assert.deepEqual(css('.settings select{background-color:var(--panel)}'), []);
  assert.ok(css('.settings select{appearance:none;-webkit-appearance:none;background-color:var(--panel)}').length, 'a component appearance:none would outrank the forced-colors arrow');
});

test('caps and uppercase tracking cannot hide behind var indirection or WebKit features', () => {
  const css = source => scanCss('src/x.css', source, new Set(), new Map(), new Set());
  for (const source of [
    '.a{--v:small-caps;font-variant:var(--v)}',
    '.a{--f:"smcp";font-feature-settings:var(--f)}',
    '.a{font-variant:var(--sans)}',
    '.a{font-feature-settings:var(--unknown)}',
    '.a{--f:"c2sc";-webkit-font-feature-settings:var(--f)}',
    '.a{--v:var(--w);--w:petite-caps;font-variant:var(--v)}',
    '.a{--v:var(--w);--w:var(--v);font-variant:var(--v)}',
    '.a{--v:uppercase;text-transform:var(--v)}',
    '.a{text-transform:var(--unknown)}',
    '.a{text-transform:var(--unknown,uppercase)}',
  ]) assert.ok(css(source).length, source);
  for (const source of [
    '.a{--v:normal;font-variant:var(--v)}',
    '.a{--f:"tnum";font-feature-settings:var(--f)}',
    '.a{--v:lowercase;text-transform:var(--v)}',
    '.a{--v:uppercase;text-transform:var(--v);letter-spacing:var(--tracking-caps)}',
    '.a{font-variant:var(--v)}.b{--v:tabular-nums}',
  ]) assert.deepEqual(css(source), [], source);
  for (const tag of ['smcp', 'c2sc', 'pcap', 'c2pc', 'unic', 'titl']) {
    const value = `"${tag}"`;
    assert.ok(css(`.a{-webkit-font-feature-settings:${value}}`).length, tag);
    for (const source of [
      `el.style.webkitFontFeatureSettings = '${value}';`,
      `el.style.setProperty('-webkit-font-feature-settings', '${value}');`,
      `el.style.cssText = '-webkit-font-feature-settings:${value}';`,
      `Object.assign(el.style, {webkitFontFeatureSettings: '${value}'});`,
    ]) assert.ok(scanTsFile('src/x.ts', source).length, source);
    assert.ok(scanHtml('index.html', `<span style='-webkit-font-feature-settings:${value}'></span>`).length);
  }
  assert.ok(scanTsFile('src/x.ts', "el.style.fontVariant = 'var(--unknown)';").length);
  assert.ok(scanTsFile('src/x.ts', "el.style.textTransform = 'var(--unknown)';").length);
});

test('browser-default resets are rejected on all font, leading and tracking properties', () => {
  for (const [property, js] of [['font', 'font'], ['font-size', 'fontSize'], ['font-family', 'fontFamily'], ['font-weight', 'fontWeight'], ['line-height', 'lineHeight'], ['letter-spacing', 'letterSpacing'], ['all', 'all']]) {
    for (const value of ['initial', 'revert', 'revert-layer']) {
      const decl = `${property}:${value}`;
      assert.ok(scanCss('src/x.css', `.a{${decl}}`, new Set(), new Map(), new Set()).length, decl);
      assert.ok(scanHtml('index.html', `<div style="${decl}"></div>`).length, decl);
      for (const source of [`el.style.${js} = '${value}';`, `el.style.setProperty('${property}', '${value}');`, `el.style.cssText = '${decl}';`, `Object.assign(el.style, {${js}:'${value}'});`]) {
        assert.ok(scanTsFile('src/x.ts', source).length, source);
      }
    }
  }
});

test('SVG caps and tracking attributes and concatenated canvas fonts follow typography rules', () => {
  for (const tag of ['svg', 'g', 'text', 'tspan', 'textPath']) {
    for (const [attr, value] of [['font-variant', 'small-caps'], ['font-variant', 'petite-caps'], ['font-variant', 'unicase'], ['font-variant', 'titling-caps'], ['letter-spacing', '.05em'], ['letter-spacing', 'var(--type-body)']]) {
      const html = `<${tag} ${attr}="${value}"></${tag}>`;
      assert.ok(scanHtml('index.html', html).length, html);
      assert.ok(scanTsFile('src/x.ts', JSON.stringify(html)).length, html);
      for (const method of [`el.setAttribute('${attr}', '${value}');`, `el.setAttributeNS(null, '${attr}', '${value}');`]) assert.ok(scanTsFile('src/x.ts', method).length, method);
    }
    for (const attr of ['font-variant="normal"', 'letter-spacing="0"', 'letter-spacing="normal"', 'letter-spacing="var(--tracking-none)"']) assert.deepEqual(scanHtml('index.html', `<${tag} ${attr}></${tag}>`), []);
  }
  for (const source of ["ctx.font = '600 ' + '13px sans-serif';", "ctx.font = '600 ' + size + 'px sans-serif';", "const sizePart = size + 'px sans-serif'; ctx.font = '600 ' + sizePart;"]) assert.ok(scanTsFile('src/x.ts', source).some(hit => hit.includes('canvas font')), source);
  for (const source of ['context.font = style.font;', 'context.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;', "context.font = style.fontWeight + ' ' + style.fontSize + ' ' + style.fontFamily;"]) assert.deepEqual(scanTsFile('src/x.ts', source), [], source);
});

test('body medium diagnostic preserves the control naming requirement', () => {
  assert.deepEqual(scanCss('src/x.css', '.a{font-size:var(--type-body);font-weight:var(--weight-medium)}', new Set(), new Map(), new Set()), [
    'src/x.css: .a: --type-body with --weight-medium is reserved for buttons and controls; name the control as a control (element, role, or class control word), or add it to CONTROLS with a reason',
  ]);
});

test('clip-path rounds follow radius roles in CSS and TypeScript styles', () => {
  for (const name of ['--ds-card-radius', '--ds-inner-radius', '--ds-control-radius']) {
    const value = `inset(0 round var(${name}))`;
    assert.deepEqual(scanCss('src/x.css', `.a{clip-path:${value}}`, new Set(), new Map(), new Set()), []);
    assert.deepEqual(scanTsFile('src/x.ts', `el.style.clipPath = '${value}';`), []);
    assert.deepEqual(scanTsFile('src/x.ts', `el.style.setProperty('clip-path', '${value}');`), []);
  }
  const bad = 'inset(0 round var(--space-2))';
  assert.ok(scanCss('src/x.css', `.a{clip-path:${bad}}`, new Set(), new Map(), new Set()).length);
  assert.ok(scanTsFile('src/x.ts', `el.style.clipPath = '${bad}';`).length);
});


test('closed bypasses: canvas font laundering, canvas tracking, font-variant resets, font-stretch, -moz-appearance and state overrides', () => {
  for (const source of [
    "ctx.font = ['600', '13px', 'sans-serif'].join(' ');",
    "ctx.font = String('13px sans-serif');",
    "ctx.font = '600 '.concat(size, 'px sans-serif');",
    "Object.assign(ctx, { font: '13px sans-serif' });",
    "const font = '13px sans-serif'; Object.assign(ctx, { font });",
    "const k = 'font'; ctx[k] = '13px sans-serif';",
    "let k = 'font'; ctx[k] = '13px sans-serif';",
    "ctx.font += ' sans-serif';",
    "ctx.letterSpacing = '2px';",
    "Object.assign(ctx, { letterSpacing: '1px' });",
    "el.style.fontStretch = 'condensed';",
    "el.style.setProperty('font-stretch', '75%');",
    "el.style.fontVariant = 'initial';",
  ]) assert.ok(scanTsFile('src/x.ts', source).length, source);
  for (const source of [
    'ctx.font = getComputedStyle(el).font;',
    'ctx.font = `${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;',
    "ctx.letterSpacing = '0px';",
    'ctx.letterSpacing = getComputedStyle(el).letterSpacing;',
    "el.style.fontStretch = 'normal';",
  ]) assert.deepEqual(scanTsFile('src/x.ts', source), [], source);
  const css = source => scanCss('src/x.css', source, new Set(), new Map(), new Set());
  const title = '.t{font-size:var(--type-title);font-weight:var(--type-title-weight);line-height:var(--type-title-leading);letter-spacing:var(--tracking-tight)}';
  assert.deepEqual(css(title), []);
  for (const source of [
    '.a{font-variant:initial}', '.a{font-variant:revert}', '.a{font-variant:revert-layer}', '.a{font-variant-caps:initial}',
    '.a{font-stretch:condensed}', '.a{font-stretch:75%}', '.a{font-width:expanded}', '.a{font:condensed 600 var(--type-body)/var(--type-body-leading) var(--sans)}',
    'select{-moz-appearance:none}', '.picker select{-moz-appearance:menulist}',
    `${title}@media (max-width:600px){.t{font-weight:var(--weight-medium)}}`,
    `${title}@media (max-width:600px){.t{font-size:var(--type-body)}}`,
    `${title}@supports (display:grid){.t{line-height:1}}`,
    `${title}.t:hover{font-weight:var(--weight-medium)}`,
    `${title}.t:focus-visible{letter-spacing:var(--tracking-none)}`,
    `${title}.t:is(:hover,:active){font-weight:var(--weight-regular)}`,
    `${title}.t{&:active{font-weight:var(--weight-medium)}}`,
  ]) assert.ok(css(source).length, source);
  for (const source of [
    '.a{font-stretch:normal}', '.a{font-variant:normal}', '.a{font-variant:tabular-nums}',
    `${title}.t:hover{color:var(--text)}`,
    `${title}@media (max-width:600px){.t{font-size:var(--type-heading);font-weight:var(--type-heading-weight);line-height:var(--type-heading-leading);letter-spacing:var(--tracking-tight)}}`,
    '.save-button{font-size:var(--type-body);font-weight:var(--weight-medium)}.save-button:hover{font-weight:var(--weight-regular)}',
  ]) assert.deepEqual(css(source), [], source);
});

test('effective typography respects priority independently for each longhand', () => {
  const read = css => effectiveStyle(declarations(css));
  const shorthand = 'font:var(--type-body) var(--sans)';
  for (const priority of ['!important', '! important', '!\tImPoRtAnT']) {
    for (const [property, field, value] of [
      ['font-size', 'size', 'var(--type-heading)'],
      ['font-weight', 'weight', 'var(--type-heading-weight)'],
      ['line-height', 'lineHeight', 'var(--type-heading-leading)'],
      ['font-family', 'family', 'var(--mono)'],
    ]) {
      assert.equal(read(`${property}:${value}${priority};${shorthand}`)[field], value, `${property} ${priority}`);
      assert.equal(read(`${shorthand}${priority};${property}:${value}`)[field], read(shorthand)[field], `${property} ${priority}`);
      assert.equal(read(`${shorthand}${priority};${property}:${value}${priority}`)[field], value, `${property} ${priority}`);
      assert.equal(read(`${property}:${value}${priority};${shorthand}${priority}`)[field], read(shorthand)[field], `${property} ${priority}`);
    }
    for (const [property, field, first, last] of [
      ['letter-spacing', 'letter', 'var(--tracking-tight)', 'var(--tracking-none)'],
      ['text-transform', 'transform', 'uppercase', 'none'],
    ]) {
      assert.equal(read(`${property}:${first}${priority};${property}:${last}`)[field], first);
      assert.equal(read(`${property}:${first};${property}:${last}${priority}`)[field], last);
    }
    const scan = css => scanCss('src/x.css', `.a{${css}}`, new Set(), new Map(), new Set());
    const heading = 'font:var(--type-heading-weight) var(--type-heading)/var(--type-heading-leading) var(--sans);letter-spacing:var(--tracking-tight)';
    assert.ok(scan(`font-weight:var(--weight-regular)${priority};${heading}`).some(hit => hit.includes('needs font-weight')), priority);
    assert.deepEqual(scan(`font-weight:var(--type-heading-weight)${priority};line-height:var(--type-heading-leading)${priority};font:var(--type-heading)/var(--type-body-leading) var(--sans);letter-spacing:var(--tracking-tight)`), [], priority);
  }
});

test('implicit strong weight requires a prose strong selector', () => {
  const scan = (selector, file = 'src/x.css') => scanCss(file, `${selector}{font-weight:var(--weight-strong)}`, new Set(), new Map(), new Set());
  for (const selector of ['.markdown strong', '.markdown b', '.markdown :is(strong,b)', '.message-meta strong', '.gu-md strong, .gu-md b', '.launcher-thread-message :is(strong,b)']) {
    assert.deepEqual(scan(selector), [], selector);
  }
  assert.ok(scan(':where(strong, b, th)', 'src/styles.css').some(hit => hit.includes('with no role font-size')), 'styles.css base reset uses --weight-medium');
  for (const selector of ['strong', 'b', 'th', 'strong.note', ':where(strong, b, th)', '.card strong', '.table th', '.markdown-strong', 'strong, .markdown-strong', '.x:not(strong)', '.x:has(strong)', 'strong .subtitle', 'strong>.subtitle', '.markdown strong .subtitle', ':is(strong,.subtitle)', ':not(strong,b)', '.markdown-strong .subtitle', '.not-markdown-strong', 'strong, .subtitle']) {
    assert.ok(scan(selector).some(hit => hit.includes('with no role font-size')), selector);
  }
});

test('font shorthand CSS-wide keywords preserve keyword instead of resetting to normal', () => {
  for (const kw of ['inherit', 'initial', 'unset', 'revert', 'revert-layer']) {
    assert.deepEqual(fontParts(kw), { family: kw, size: kw, weight: kw, lineHeight: kw }, kw);
    const style = effectiveStyle(declarations(`font:${kw}`));
    assert.equal(style.size, kw, `${kw} size`);
    assert.equal(style.weight, kw, `${kw} weight`);
    assert.equal(style.lineHeight, kw, `${kw} lineHeight`);
    assert.equal(style.family, kw, `${kw} family`);
  }
});

test('font shorthand accepts whitespace on either side of its slash', () => {
  const expected = fontParts('var(--type-heading-weight) var(--type-heading)/var(--type-heading-leading) var(--sans)');
  for (const slash of [' / ', '/ ', ' /', '/']) {
    const value = `var(--type-heading-weight) var(--type-heading)${slash}var(--type-heading-leading) var(--sans)`;
    assert.deepEqual(fontParts(value), expected, value);
    assert.deepEqual(scanCss('src/x.css', `.a{font:${value};letter-spacing:var(--tracking-tight)}`, new Set(), new Map(), new Set()), []);
  }
});

test('canonical definitions cannot bypass locks through a later definition', () => {
  const book = loadRulebook();
  const css = `${tokensCss}\n:root{--type-body:1.2rem}`;
  assert.deepEqual(compareRulebook(tokenMap(css), book), [], 'first-definition map hides the later role');
  assert.ok(repeatedLocked(css, book).some(hit => hit.includes('--type-body')));
  for (const name of ['--type-heading-weight', '--type-heading-leading', '--tracking-tight', '--weight-medium', '--leading-code', '--radius-card', '--space-2', '--icon-md', '--icon-stroke-md', '--sans', '--mono-size', '--root-size', '--row', '--control']) {
    assert.ok(repeatedLocked(`${tokensCss} :root{${name}:0}`, book).some(hit => hit.includes(name)), name);
  }
  assert.ok(repeatedLocked(':root{--type-body:1rem;--type-body:1.2rem}', book).length, 'same-block repetition');
  assert.ok(repeatedLocked(':root{--type-body:1rem} @property --type-body{syntax:"<length>";inherits:true;initial-value:1.2rem}', book).length, '@property duplicates canonical token');
  assert.ok(repeatedLocked(':root{--ds-btn-h:36px} @property --ds-btn-h{syntax:"<length>";inherits:true;initial-value:40px}', book, 'src/design-system.css').length, '@property duplicates design-system height');
  assert.ok(repeatedLocked(':root{--ds-btn-h:36px} html{--ds-btn-h:40px}', book).length, 'checked control height');
  assert.deepEqual(repeatedLocked(`${designSystemCss} :root{--ds-btn-h:40px}`, book, 'src/design-system.css'), [
    'src/design-system.css: repeated canonical definition --ds-btn-h',
  ], 'owning design-system height cannot be overridden');
  assert.deepEqual(repeatedLocked(tokensCss, book), [], 'palette variants remain valid');
  assert.deepEqual(repeatedLocked(designSystemCss, book, 'src/design-system.css'), [], 'design-system theme variants remain valid');
  assert.deepEqual(repeatedLocked(':root{--ds-row-hover:transparent} html[data-theme=dark]{--ds-row-hover:inherit}', book, 'src/design-system.css'), [], 'untracked theme declarations remain valid');
  assert.deepEqual(repeatedLocked(':root{--custom:1;--custom:2}', book), [], 'noncanonical definitions remain valid');
});

test('design-system height tokens cannot be redefined outside src/design-system.css', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  for (const name of designSystemLocked) {
    assert.deepEqual(sample('src/design-system.css', `:root{${name}:36px}`), [], `${name} allowed in owner`);
    assert.deepEqual(sample('src/other.css', `.a{${name}:40px}`), [
      `src/other.css: .a: redefines canonical token ${name}`,
    ], `${name} blocked in another stylesheet`);
    assert.deepEqual(sample('src/tokens.css', `:root{${name}:36px}`), [
      `src/tokens.css: :root: redefines canonical token ${name}`,
    ], `${name} blocked in tokens.css`);
    assert.deepEqual(sample('src/other.css', `@property ${name}{syntax:"<length>";inherits:true;initial-value:40px}`), [
      `src/other.css: @property ${name}: redefines canonical token ${name}`,
    ], `${name} blocked via @property outside owner`);
  }
});

test('@property records initial-value in defs and checks ALIAS_VALUES', () => {
  const defs = new Map();
  const hits = scanCss('src/inset-shell.css', '@property --inset-radius{syntax:"*";inherits:false;initial-value:var(--ds-card-radius)}', new Set(), defs, new Set());
  assert.deepEqual(hits, []);
  assert.deepEqual(defs.get('--inset-radius'), [{ file: 'src/inset-shell.css', selector: '@property --inset-radius', value: 'var(--ds-card-radius)' }]);
  const badDefs = new Map();
  const badHits = scanCss('src/inset-shell.css', '@property --inset-radius{syntax:"<length>";inherits:false;initial-value:8px}', new Set(), badDefs, new Set());
  assert.ok(badHits.length > 0);
  assert.equal(valueResolves(badDefs.get('--inset-radius')[0].value, '--inset-radius', badDefs), false);
});

test('GU_CONTAINERS single-sources TIGHT_CUSTOM, SHADOW_SURFACE and the generative-ui.css nesting groups', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const sel = read('src/generative-ui-selectors.ts');
  const css = read('src/generative-ui.css');
  const gu = read('src/generative-ui.ts');
  const LIST = "['.gu-card', '.gu-tabs', '.gu-accordion', '.gu-callout', '.gu-form', '.gu-flow']";
  const SET = '.gu-card,.gu-tabs,.gu-accordion,.gu-callout,.gu-form,.gu-flow';
  const SURFACE = "[...GU_CONTAINERS, '.gu-custom', '.rich-html'].join(',')";
  const LEAF = /:is\(\.gu-card,[^()]*\.rich-image img[^()]*\)/.exec(css)[0];
  assert.deepEqual(tightContainerProblems(sel, css, gu), []);
  assert.deepEqual(tightContainerProblems(sel, css.replaceAll('.rich-image img', '.rich-image > img'), gu), [], 'every leaf-surface group respelled the same way still passes');
  assert.deepEqual(tightContainerProblems(sel, css.replace(`:is(${SET})>*`, `:is(${SET.replace('.gu-card', '.gu-c\\61rd')})>*`), gu), [], 'a CSS-escaped .gu-card decodes to the same class');
  assert.ok(LEAF.includes(',.gu-flow,') && sel.includes('/** A custom view'), 'leaf and helper samples present');
  assert.ok(sel.includes(LIST) && css.includes(`:is(${SET})>*`) && gu.includes(SURFACE), 'samples present');
  // Formatting does not matter: the list is read through the TS AST.
  assert.deepEqual(tightContainerProblems(sel.replace(LIST, LIST.replaceAll(', ', ',\n  ').replace('[', '[\n  ')), css, gu), [], 'reformatted GU_CONTAINERS still passes');
  for (const [label, mutated] of [
    ['GU_CONTAINERS adds a container', [sel.replace(LIST, LIST.replace(']', ", '.gu-stat']")), css, gu]],
    ['GU_CONTAINERS drops a container', [sel.replace(LIST, LIST.replace(", '.gu-flow'", '')), css, gu]],
    ['GU_CONTAINERS drops .gu-card', [sel.replace(LIST, LIST.replace("'.gu-card', ", '')), css.replaceAll('.gu-card,', ''), gu]],
    ['GU_CONTAINERS item is not a class', [sel.replace(LIST, LIST.replace("'.gu-flow'", "'div.gu-flow'")), css, gu]],
    ['GU_CONTAINERS without as const', [sel.replace(`${LIST} as const`, LIST), css, gu]],
    ['TIGHT_CUSTOM hand-repeats the class list', [sel.replaceAll('${GU_CONTAINER_SELECTOR}', `:is(${SET})`), css, gu]],
    ['GU_CONTAINER_SELECTOR hand-repeats the class list', [sel.replace("`:is(${GU_CONTAINERS.join(',')})`", `':is(${SET})'`), css, gu]],
    ['CSS adds a container', [sel, css.replace(`:is(${SET})>*`, `:is(${SET},.gu-stat)>*`), gu]],
    ['CSS drops a container', [sel, css.replace(`:is(${SET})>*`, `:is(${SET.replace(',.gu-flow', '')})>*`), gu]],
    ['CSS control holders drop a container', [sel, css.replace(':is(.gu-card,.gu-callout,.gu-tabs,.gu-accordion,.gu-form,.gu-code,.gu-flow)', ':is(.gu-card,.gu-callout,.gu-tabs,.gu-accordion,.gu-code,.gu-flow)'), gu]],
    ['CSS tight-host group adds a container', [sel, css.replace(':where(.gu-tight-host,.gu-card,', ':where(.gu-tight-host,.gu-stat,.gu-card,'), gu]],
    ['SHADOW_SURFACE hand-hardcodes the containers', [sel, css, gu.replace(SURFACE, `'${SET},.gu-custom,.rich-html'`)]],
    ['SHADOW_SURFACE spreads GU_CONTAINERS but restates .gu-card', [sel, css, gu.replace(SURFACE, "[...GU_CONTAINERS, '.gu-card', '.gu-custom', '.rich-html'].join(',')")]],
    ['SHADOW_SURFACE spreads a sliced GU_CONTAINERS', [sel, css, gu.replace(SURFACE, "[...GU_CONTAINERS.slice(1), '.gu-custom', '.rich-html'].join(',')")]],
    ['SHADOW_SURFACE filters GU_CONTAINERS', [sel, css, gu.replace(SURFACE, "[...GU_CONTAINERS.filter(name => name !== '.gu-card'), '.gu-custom'].join(',')")]],
    ['GU_CONTAINER_SELECTOR slices GU_CONTAINERS', [sel.replace("GU_CONTAINERS.join(',')", "GU_CONTAINERS.slice(1).join(',')"), css, gu]],
    ['TIGHT_CUSTOM strips a class from GU_CONTAINER_SELECTOR', [sel.replace('`${GU_CONTAINER_SELECTOR} ${GU_CONTAINER_SELECTOR} .gu-custom`', "`${GU_CONTAINER_SELECTOR.replace('.gu-tabs,', '')} .gu-custom`"), css, gu]],
    // Any class-only group naming two or more containers is checked, not only groups that still name .gu-card.
    ['CSS drops .gu-card from one nesting group', [sel, css.replace(`:is(${SET})>*{--gu-surface-radius:var(--ds-control-radius)}`, `:is(${SET.replace('.gu-card,', '')})>*{--gu-surface-radius:var(--ds-control-radius)}`), gu]],
    ['CSS drops .gu-stat from one leaf-surface group', [sel, css.replace('.gu-sparkline,.gu-stat,.gu-code', '.gu-sparkline,.gu-code'), gu]],
    ['CSS drops .gu-flow from every leaf-surface group', [sel, css.replaceAll('.gu-tree,.gu-flow,.gu-checklist', '.gu-tree,.gu-checklist'), gu]],
    // Leaf-surface groups are keyed on container count, not on the literal `.rich-image img`.
    ['CSS rewrites .rich-image>img and drops .gu-flow in one leaf-surface group', [sel, css.replace(LEAF, LEAF.replace('.rich-image img', '.rich-image>img').replace(',.gu-flow,', ',')), gu]],
    // Whole-module scan: a helper constant cannot launder a slice into a derived selector.
    ['TIGHT_CUSTOM slots a helper constant that slices GU_CONTAINERS', [sel.replace('/** A custom view', "const SUB = GU_CONTAINERS.slice(1).join(',');\n/** A custom view").replace('`${GU_CONTAINER_SELECTOR} ${GU_CONTAINER_SELECTOR} .gu-custom`', '`:is(${SUB}) .gu-custom`'), css, gu]],
    ['TIGHT_CUSTOM aliases GU_CONTAINERS', [sel.replace('/** A custom view', 'const ALL = GU_CONTAINERS;\n/** A custom view'), css, gu]],
    ['TIGHT_CUSTOM hand-repeats .gu-card through string concatenation', [sel.replace("  '.gu-tight-host .gu-custom',", "  '.gu-tight-host .gu-custom',\n  '.gu-' + 'card .gu-custom',"), css, gu]],
    // Shared ts-fold.mjs folding (templates, join) and CSS escape decoding.
    ['TIGHT_CUSTOM hand-repeats .gu-card through a constant template', [sel.replace("  '.gu-tight-host .gu-custom',", "  '.gu-tight-host .gu-custom',\n  `.gu-${'card'} .gu-custom`,"), css, gu]],
    ['TIGHT_CUSTOM hand-repeats .gu-card through join()', [sel.replace("  '.gu-tight-host .gu-custom',", "  '.gu-tight-host .gu-custom',\n  ['.gu', 'card'].join('-') + ' .gu-custom',"), css, gu]],
    ['TIGHT_CUSTOM hand-repeats .gu-card through a CSS escape', [sel.replace("  '.gu-tight-host .gu-custom',", "  '.gu-tight-host .gu-custom',\n  '.gu\\\\-card .gu-custom',"), css, gu]],
    ['SHADOW_SURFACE hides .gu-card in a template after a dynamic slot', [sel, css, gu.replace(SURFACE, "[...GU_CONTAINERS, `${'.gu-'}card`, '.gu-custom', '.rich-html'].join(',')")]],
    // Balanced :is() parsing: a nested :not(*) no longer hides a group that drops .gu-card.
    ['CSS nesting group drops .gu-card behind a nested :not(*)', [sel, css.replace(`:is(${SET})>*{--gu-surface-radius:var(--ds-control-radius)}`, `:is(${SET.replace('.gu-card,', '')},:not(*))>*{--gu-surface-radius:var(--ds-control-radius)}`), gu]],
    ['CSS escapes .gu-card to drop it from a nesting group', [sel, css.replace(`:is(${SET})>*{--gu-surface-radius:var(--ds-control-radius)}`, `:is(${SET.replace('.gu-card', '.gu-c\\61rd-x')})>*{--gu-surface-radius:var(--ds-control-radius)}`), gu]],
    ['src/generative-ui.ts renames the GU_CONTAINERS import', [sel, css, gu.replace("import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';", "import { GU_CONTAINERS as GU_CONTAINERS_ALL, markTightCustom } from './generative-ui-selectors.ts';\nconst GU_CONTAINERS = GU_CONTAINERS_ALL;")]],
  ]) {
    assert.notDeepEqual(mutated, [sel, css, gu], `${label} sample changes the source`);
    assert.ok(tightContainerProblems(...mutated).length, label);
  }
});

test('GU_CONTAINERS imports resolve through the AST and every importing src/ module is scanned', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const sel = read('src/generative-ui-selectors.ts');
  const css = read('src/generative-ui.css');
  const gu = read('src/generative-ui.ts');
  const comps = read('src/generative-ui-components.ts');
  const IMPORT = "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';";
  const COMPS_IMPORT = "import { markTightCustom } from './generative-ui-selectors.ts';";
  assert.ok(gu.includes(IMPORT) && comps.includes(COMPS_IMPORT), 'import samples present');
  assert.deepEqual(tightContainerProblems(sel, css, gu), [], 'the .ts specifier passes');
  assert.deepEqual(tightContainerProblems(sel, css, gu.replace(IMPORT, IMPORT.replace("selectors.ts'", "selectors'"))), [], 'the extensionless specifier passes');
  assert.deepEqual(tightContainerProblems(sel, css, gu.replace(IMPORT, IMPORT.replace('{ ', '{\n  ').replace(' }', ',\n}'))), [], 'a reformatted import passes');
  assert.ok(tightContainerProblems(sel, css, gu.replace(IMPORT, IMPORT.replace("'./generative-ui-selectors.ts'", "'./generative-ui-selectors-copy.ts'"))).length, 'an import from another module fails');
  assert.ok(tightContainerProblems(sel, css, gu.replace(IMPORT, IMPORT.replace('import {', 'import type {'))).length, 'a type-only import fails');
  // A third module importing the shared list must also use it whole.
  const third = comps.replace(COMPS_IMPORT, "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';\nexport const SOME = GU_CONTAINERS.slice(1);");
  assert.deepEqual(tightContainerProblems(sel, css, gu, { 'src/generative-ui-components.ts': comps }), [], 'the real third importer passes');
  assert.ok(tightContainerProblems(sel, css, gu, { 'src/generative-ui-components.ts': third }).some(hit => hit.startsWith('src/generative-ui-components.ts must use GU_CONTAINERS whole')), 'a third module slicing GU_CONTAINERS fails');
  const whole = comps.replace(COMPS_IMPORT, "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors';\nconst ALL = [...GU_CONTAINERS, '.gu-x'].join(',');\nexport const hit = (el: Element) => el.matches(ALL);");
  assert.deepEqual(tightContainerProblems(sel, css, gu, { 'src/generative-ui-components.ts': whole }), [], 'a third module spreading GU_CONTAINERS whole locally passes');
  const exported = comps.replace(COMPS_IMPORT, "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors';\nexport const ALL = [...GU_CONTAINERS, '.gu-x'].join(',');");
  assert.ok(tightContainerProblems(sel, css, gu, { 'src/generative-ui-components.ts': exported }).length, 'a third module exporting a derived GU_CONTAINERS variable fails');
  const nested = "import * as sel from '../generative-ui-selectors';\nexport const S = sel.GU_CONTAINER_SELECTOR.replace('.gu-card,', '');";
  assert.ok(tightContainerProblems(sel, css, gu, { 'src/redesign/gu-extra.ts': nested }).some(hit => hit.startsWith('src/redesign/gu-extra.ts')), 'a nested namespace importer that edits GU_CONTAINER_SELECTOR fails');
  assert.deepEqual(tightContainerProblems(sel, css, gu, { 'src/other.ts': 'export const GU_CONTAINERS = [1].slice(1);' }), [], 'modules that do not import the selectors module are out of scope');
});
