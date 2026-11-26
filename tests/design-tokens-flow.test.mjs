/**
 * Static design-token guard, part 5: Shadow DOM sheet flow and attachShadow inventory.
 * The flow traces src/type-base.css and src/shadow-base.css through the TS AST into every
 * constructed sheet, renderBlock() and the rich-HTML shadow root; the inventory parses every
 * src/ file (escaped and indirect attachShadow references included) so a new shadow root is
 * either flow-verified or exempt with an owner and reason. Also: the GU_CONTAINERS closed import
 * rules (gu-containers.mjs) and the segmented-control regular-weight guard (segmented.mjs).
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { root } from './design-tokens/allowlists.mjs';
import { scanTsFile } from './design-tokens/ts-style.mjs';
import {
  baseSheetFlowProblems, componentSheetFlow, unusedShadowExemptions, SHADOW_ROOT_EXEMPT, SHADOW_ROOT_VERIFIED, FLOW_VERIFIED,
  shadowSources, shadowInventoryProblems, SHADOW_EXTS,
} from './design-tokens/flow.mjs';
import { SCRIPT_EXTS as SHARED_EXTS } from './design-tokens/allowlists.mjs';
import { tightContainerProblems, ownerDerivedExports, SCRIPT_EXTS } from './design-tokens/gu-containers.mjs';
import { segmentedWeightProblems, segmentedTracks, heavyFontShorthand } from './design-tokens/segmented.mjs';

test('shared base sheet flow is traced through the AST, not variable names', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const gu = read('src/generative-ui.ts');
  const rich = read('src/rich-markdown.ts');
  assert.deepEqual(baseSheetFlowProblems(gu, rich), []);
  const rename = (source, from, to) => source.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  assert.deepEqual(baseSheetFlowProblems(rename(rename(gu, 'typeBase', 'sharedType'), 'shadowBase', 'sharedShadow'), rename(rename(rich, 'typeBase', 'resetCss'), 'shadowBase', 'hostCss')), [], 'renamed locals still pass');
  const staged = gu.replace('sheet.replaceSync(`${typeBase}\\n${shadowBase}\\n${richCss}\\n${css}`)', 'const all = `${typeBase}\\n${shadowBase}`; sheet.replaceSync(`${all}\\n${richCss}\\n${css}`)');
  assert.notEqual(staged, gu, 'staging sample changes the source');
  assert.deepEqual(baseSheetFlowProblems(staged, rich), [], 'a local const carrying both sheets still passes');
  for (const [label, guSource, richSource] of [
    ['sheet without shadow-base', gu.replace('${typeBase}\\n${shadowBase}\\n', '${typeBase}\\n'), rich],
    ['sheet without type-base', gu.replace('${typeBase}\\n${shadowBase}\\n', '${shadowBase}\\n'), rich],
    ['sheet with the shared reset after generative CSS', gu.replace('`${typeBase}\\n${shadowBase}\\n${richCss}\\n${css}`', '`${richCss}\\n${css}\\n${typeBase}\\n${shadowBase}`'), rich],
    ['renderBlock without shadow-base', gu.replace('renderBlock(kind, source, typeBase + shadowBase)', 'renderBlock(kind, source, typeBase)'), rich],
    ['renderBlock without type-base', gu.replace('renderBlock(kind, source, typeBase + shadowBase)', 'renderBlock(kind, source, shadowBase)'), rich],
    ['shadow-base import removed', gu.replace("import shadowBase from './shadow-base.css?inline';", "const shadowBase = '';"), rich],
    ['rich-html without type-base', gu, rich.replace('base.textContent = typeBase + shadowBase +', 'base.textContent = shadowBase +')],
    ['rich-html without shadow-base', gu, rich.replace('base.textContent = typeBase + shadowBase +', 'base.textContent = typeBase +')],
    ['rich-html style not appended to the shadow root', gu, rich.replace('root.append(base, clean)', 'root.append(clean)')],
    ['rich CSS precedes shared resets', gu.replace('`${typeBase}\\n${shadowBase}\\n${richCss}\\n${css}`', '`${richCss}\\n${typeBase}\\n${shadowBase}\\n${css}`'), rich],
    ['conditional operand is not a shared prefix', gu.replace('typeBase + shadowBase)', 'typeBase ? shadowBase : "")'), rich],
    ['false branch drops both resets', gu.replace('typeBase + shadowBase)', 'false ? typeBase + shadowBase : "")'), rich],
    ['array slice discards shared resets', gu.replace('`${typeBase}\\n${shadowBase}\\n${richCss}\\n${css}`', '[typeBase, shadowBase, richCss, css].slice(2)'), rich],
    ['style overwritten before append', gu, rich.replace('root.append(base, clean)', 'base.textContent = ""; root.append(base, clean)')],
    ['sheet lengths are not sheet contents', gu.replace('typeBase + shadowBase)', 'String(typeBase.length + shadowBase.length))'), rich],

  ]) {
    assert.notEqual(guSource + richSource, gu + rich, `${label}: sample changes the source`);
    assert.ok(baseSheetFlowProblems(guSource, richSource).length, label);
  }
});

test('base sheet flow resolves lexical bindings and covers every shadow root and constructed sheet', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const gu = read('src/generative-ui.ts');
  const rich = read('src/rich-markdown.ts');
  for (const entry of SHADOW_ROOT_EXEMPT) assert.ok(entry.reason.trim() && entry.owner, entry.file);
  assert.deepEqual(unusedShadowExemptions(gu), [], 'every shadow exemption matches a real attachShadow class');
  const guMarker = 'export function generativeSheet(): CSSStyleSheet {';
  const drawMarker = "const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });";
  const richMarker = "const root = figure.attachShadow({ mode: 'open' });";
  const appendMarker = 'root.append(base, clean);';
  for (const marker of [guMarker, drawMarker]) assert.ok(gu.includes(marker), marker);
  for (const marker of [richMarker, appendMarker]) assert.ok(rich.includes(marker), marker);
  const extraView = `\nclass Extra extends HTMLElement { connectedCallback(): void { const root = this.attachShadow({ mode: 'open' }); root.append(document.createElement('p')); } }\n`;
  for (const [label, guSource, richSource] of [
    ['const typeBase shadowing inside generativeSheet()', gu.replace(guMarker, `${guMarker}\n  const typeBase = '';`), rich],
    ['const shadowBase shadowing inside generativeSheet()', gu.replace(guMarker, `${guMarker}\n  const shadowBase = '';`), rich],
    ['let typeBase shadowing before renderBlock()', gu.replace(drawMarker, `${drawMarker}\n    let typeBase = '';`), rich],
    ['parameter named typeBase shadows the import', gu.replace('private async draw(): Promise<void> {', 'private async draw(typeBase = \'\'): Promise<void> {'), rich],
    ['const typeBase shadowing in the rich-html block', gu, rich.replace(richMarker, `const typeBase = '';\n      ${richMarker}`)],
    ['const shadowBase shadowing in the rich-html block', gu, rich.replace(richMarker, `const shadowBase = '';\n      ${richMarker}`)],
    ['second unguarded attachShadow root', gu + extraView, rich],
    ['second attachShadow root without generativeSheet()', gu + extraView.replace("root.append(document.createElement('p'));", 'root.adoptedStyleSheets = [];'), rich],
    ['shadowing generativeSheet local', gu.replace(drawMarker, `const generativeSheet = () => new CSSStyleSheet();\n    ${drawMarker}`), rich],
    ['second constructed sheet without shared resets', gu + "\nconst extra = new CSSStyleSheet(); extra.replaceSync('p{color:red}');\n", rich],
    ['async replace() without shared resets', gu + "\nconst extra = new CSSStyleSheet(); void extra.replace(css);\n", rich],
    ['insertRule() on a constructed sheet', gu.replace('sheet.replaceSync(', "sheet.insertRule('p{}'); sheet.replaceSync("), rich],
    ['root innerHTML bypasses adoption', gu.replace(drawMarker, `${drawMarker}\n    root.innerHTML = '<style>p{}</style>';`), rich],
    ['style.innerHTML cleared before append', gu, rich.replace(appendMarker, `base.innerHTML = ''; ${appendMarker}`)],
    ['style.replaceChildren() before append', gu, rich.replace(appendMarker, `base.replaceChildren(); ${appendMarker}`)],
    ['style.appendChild() before append', gu, rich.replace(appendMarker, `base.appendChild(document.createTextNode('*{}')); ${appendMarker}`)],
    ['style.remove() after append', gu, rich.replace(appendMarker, `${appendMarker} base.remove();`)],
    ['style.textContent overwritten after append', gu, rich.replace(appendMarker, `${appendMarker} base.textContent = '';`)],
    ['style aliased then mutated', gu, rich.replace(appendMarker, `const alias = base; alias.textContent = ''; ${appendMarker}`)],
    ['second rich-html shadow root without shared style', gu, rich + "\nexport function extra(el: HTMLElement): void { const root = el.attachShadow({ mode: 'open' }); root.append(document.createElement('p')); }\n"],
  ]) {
    assert.notEqual(guSource + richSource, gu + rich, `${label}: sample changes the source`);
    assert.ok(baseSheetFlowProblems(guSource, richSource).length, label);
  }
  // Renamed imports and a staged const carrying both sheets still pass.
  const renamed = gu.replace(/\btypeBase\b/g, 'resetCss').replace(/\bshadowBase\b/g, 'hostCss');
  assert.deepEqual(baseSheetFlowProblems(renamed, rich), []);
  // A same-named local in an unrelated scope does not shadow the module import.
  assert.deepEqual(baseSheetFlowProblems(gu + "\nfunction unrelated(): string { const typeBase = ''; return typeBase; }\n", rich), []);
});

test('every attachShadow under src/ is flow-verified or exempt with an owner and reason', () => {
  const sources = shadowSources();
  assert.deepEqual(shadowInventoryProblems(sources), []);
  const found = Object.keys(sources).filter(file => /attachShadow/.test(sources[file]));
  assert.ok(found.length >= 5 && found.every(file => [...SHADOW_ROOT_VERIFIED, ...SHADOW_ROOT_EXEMPT].some(item => item.file === file)), found.join());
  for (const file of FLOW_VERIFIED) assert.ok(sources[file] && SHADOW_ROOT_VERIFIED.some(item => item.file === file), `${file} exists with a verified root`);
  for (const item of [...SHADOW_ROOT_VERIFIED, ...SHADOW_ROOT_EXEMPT]) assert.equal(item.count, 1, `${item.file} ${item.owner} pins one call`);
  // Flow-verified files are inventoried too: a rogue root beside the verified custom() fails.
  const rogue = "\nfunction rogue(el: HTMLElement) { const r = el.attachShadow({ mode: 'open' }); r.innerHTML = '<style>code{font-size:1em}</style>'; }\n";
  assert.ok(shadowInventoryProblems({ ...sources, 'src/generative-ui-components.ts': sources['src/generative-ui-components.ts'] + rogue }).some(hit => hit.startsWith('src/generative-ui-components.ts: attachShadow() in rogue')), 'a rogue root in a flow-verified file fails');
  assert.ok(shadowInventoryProblems({ ...sources, 'src/rich-markdown.ts': sources['src/rich-markdown.ts'] + rogue }).some(hit => hit.startsWith('src/rich-markdown.ts: attachShadow() in rogue')), 'a rogue root in rich-markdown.ts fails');
  // Exemptions pin the exact scope path and call count, not a bare inner function name.
  const motion = sources['src/motion.ts'];
  const stageMarker = 'function stage(): { host: HTMLElement; root: ShadowRoot; page: HTMLElement } {';
  assert.ok(motion.includes(stageMarker), 'motion stage marker');
  const nested = motion.replace(stageMarker, `${stageMarker}\n  function stage() { document.body.attachShadow({ mode: 'closed' }); }`);
  assert.ok(shadowInventoryProblems({ ...sources, 'src/motion.ts': nested }).some(hit => hit.startsWith('src/motion.ts: attachShadow() in stage.stage')), 'a nested duplicate stage() fails');
  const twice = `${motion}\nfunction stage() { document.body.attachShadow({ mode: 'closed' }); }\n`;
  assert.ok(shadowInventoryProblems({ ...sources, 'src/motion.ts': twice }).some(hit => /motion\.ts: stage: 2 attachShadow\(\) calls, expected exactly 1/.test(hit)), 'a second same-named stage() fails the count');
  const extraDraw = sources['src/generative-ui.ts'].replace("const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' });", "const root = this.shadowRoot ?? this.attachShadow({ mode: 'open' }); this.attachShadow({ mode: 'open' });");
  assert.ok(shadowInventoryProblems({ ...sources, 'src/generative-ui.ts': extraDraw }).some(hit => /GenerativeView\.draw: 2 attachShadow/.test(hit)), 'a second call in the verified scope fails');
  const widget = "export function mount(el: HTMLElement) {\n  const root = el.attachShadow({ mode: 'open' });\n  root.innerHTML = '<p>hi</p>';\n}\n";
  assert.ok(shadowInventoryProblems({ ...sources, 'src/new-widget.ts': widget }).some(hit => hit.startsWith('src/new-widget.ts: attachShadow() in mount')), 'a new unadopted shadow root fails');
  assert.ok(shadowInventoryProblems({ ...sources, 'src/new-widget.ts': "const k = 'attachShadow'; export const m = (el: any) => el[k]({ mode: 'open' });" }).some(hit => hit.startsWith('src/new-widget.ts')), 'an indirect attachShadow fails');
  for (const indirect of ["Element.prototype.attachShadow.call(h, { mode: 'open' })", "Reflect.apply(Element.prototype.attachShadow, h, [{ mode: 'open' }])", "h[`attachShadow`]?.bind(h)", "const k = 'attachShadow';"]) {
    const motion = `${sources['src/motion.ts']}\nexport const rogueRoot = (h: HTMLElement) => ${indirect.startsWith('const') ? `{ ${indirect} return (h as any)[k]({ mode: 'open' }); }` : indirect};\n`;
    assert.ok(shadowInventoryProblems({ ...sources, 'src/motion.ts': motion }).some(hit => hit.startsWith('src/motion.ts:') && hit.includes('indirect attachShadow reference')), `${indirect} beside motion.ts's direct call fails`);
  }
  // Unicode and hex escapes name attachShadow without the raw substring; such files are still parsed.
  for (const sneaky of [
    "export function f(h: HTMLElement) { return h['attach\\u0053hadow']({ mode: 'open' }); }",
    "export function f(h: any) { return h.attach\\u0053hadow({ mode: 'open' }); }",
    "export const f = (h: any) => h['attach\\x53hadow']({ mode: 'open' });",
    "export const k = 'attach\\u{53}hadow';",
  ]) {
    assert.ok(!sneaky.includes('attachShadow'), `${sneaky} hides the raw name`);
    assert.ok(shadowInventoryProblems({ ...sources, 'src/sneaky.ts': sneaky }).some(hit => hit.startsWith('src/sneaky.ts')), `escaped attachShadow fails: ${sneaky}`);
  }
  assert.deepEqual(shadowInventoryProblems({ ...sources, 'src/motion.ts': `// attachShadow in a comment\n${sources['src/motion.ts']}` }), [], 'comments are not references');
  // Declarative Shadow DOM builds a root that adopts neither shared sheet, in scripts and in HTML pages.
  assert.ok(Object.keys(sources).some(file => /^[^/]+\.html$/.test(file)), 'root *.html windows are inventoried');
  for (const [file, text] of [
    ['src/dsd.ts', "export const m = (el: any) => el.setHTMLUnsafe('<template shadowrootmode=\"open\"><p>hi</p></template>');"],
    ['src/dsd.ts', "export const m = (el: any) => { el.innerHTML = '<template shadowrootmode=\"closed\"></template>'; };"],
    ['src/dsd.ts', 'export const m = (el: any, mode: string) => { el.innerHTML = `<template ShadowRootMode = "${mode}"></template>`; };'],
    ['src/dsd.ts', "export const m = (el: any) => el.setHTMLUnsafe('<template shadow\\u0072ootmode=open></template>');"],
    ['dsd.html', '<!doctype html><div><template shadowrootmode="open"><p>hi</p></template></div>'],
  ]) {
    assert.ok(shadowInventoryProblems({ ...sources, [file]: text }).some(hit => hit.startsWith(`${file}:`) && hit.includes('shadowrootmode')), `declarative root fails: ${text}`);
  }
  assert.deepEqual(shadowInventoryProblems({ ...sources, 'src/dsd.ts': '// shadowrootmode="open"\nexport const x = 1;' }), [], 'a JS comment is not a root');
  assert.deepEqual(shadowInventoryProblems({ ...sources, 'dsd.html': '<!-- <template shadowrootmode="open"> -->\n<p>hi</p>' }), [], 'an HTML comment is not a root');
  assert.ok(shadowInventoryProblems({ ...sources, 'src/motion.ts': sources['src/motion.ts'].replace('function stage()', 'function stageRoot()') }).some(hit => /motion\.ts: stage: unused/.test(hit)), 'a stale exemption fails');
});

test('the attachShadow inventory folds constant strings built with +, templates and join()', () => {
  const sources = shadowSources();
  // Split names are folded by the shared ts-fold.mjs helper, so a string-built root or declarative template still fails, with its line.
  for (const [text, line, kind] of [
    ["export const m = (h: any) => h['attach' + 'Shadow']({ mode: 'open' });", 2, 'attachShadow() in m (line 2)'],
    ["export const m = (h: any) => h[['attach', 'Shadow'].join('')]({ mode: 'open' });", 2, 'attachShadow() in m (line 2)'],
    ["export const m = (h: any) => h[`attach${'Shadow'}`]({ mode: 'open' });", 2, 'attachShadow() in m (line 2)'],
    ["export const m = (h: any) => h[('attach' + `${'Sha'}d`) + ['o', 'w'].join('') as const]({ mode: 'open' });", 2, 'attachShadow() in m (line 2)'],
    ["export const k = (x: string) => x + 'attach' + 'Shadow';", 2, 'src/split.ts:2: indirect attachShadow reference'],
    ["export const k = ['x', 'attach', 'Shadow'].join('').slice(1);", 2, 'src/split.ts:2: indirect attachShadow reference'],
    ["export const m = (el: any) => el.setHTMLUnsafe('<template shadowroot' + 'mode=\"open\"></template>');", 2, 'src/split.ts:2: declarative Shadow DOM'],
    ['export const m = (el: any) => { el.innerHTML = `<template shadowroot${\'mode\'}="closed"></template>`; };', 2, 'src/split.ts:2: declarative Shadow DOM'],
    ["export const m = (el: any) => el.setHTMLUnsafe(['<template shadowroot', 'mode=\"open\">'].join(''));", 2, 'src/split.ts:2: declarative Shadow DOM'],
    ["export const m = (el: any, x: string) => el.setHTMLUnsafe(`${x}<template shadow${'root'}mode=open>${x}`);", 2, 'src/split.ts:2: declarative Shadow DOM'],
  ]) {
    assert.ok(!/attachShadow|shadowrootmode/i.test(text), `${text} hides the raw name`);
    const problems = shadowInventoryProblems({ ...sources, 'src/split.ts': `// split\n${text}\n` });
    assert.ok(problems.some(hit => hit.includes(kind)), `string-built root fails at line ${line}: ${text}\n${problems.join('\n')}`);
  }
  // A folded name on an accounted direct call is still that call: rewriting motion.ts's exempt root keeps the inventory clean.
  const motion = sources['src/motion.ts'];
  for (const spelled of ["['attach' + 'Shadow']", "[['attach', 'Shadow'].join('')]", "[`attach${'Shadow'}`]"]) {
    const rewritten = motion.replace('host.attachShadow(', `host${spelled}(`);
    assert.notEqual(rewritten, motion, 'motion.ts sample present');
    assert.deepEqual(shadowInventoryProblems({ ...sources, 'src/motion.ts': rewritten }), [], `${spelled} on the exempt call still counts once`);
  }
  // Dynamic pieces are not folded through: a plain mention of "attach" or "shadow" is not a root.
  assert.deepEqual(shadowInventoryProblems({ ...sources, 'src/split.ts': "export const k = (x: string) => 'attach' + x + 'Shadow';\nexport const s = 'box-shadow';" }), []);
});

test('component CSS forwarding tolerates renamed bindings and rejects missing or reordered resets', () => {
  const source = readFileSync(join(root, 'src/generative-ui-components.ts'), 'utf8');
  let renamed = source;
  for (const [from, to] of [['baseCss', 'resetText'], ['host', 'element'], ['own', 'localStyle'], ['base', 'resetStyle'], ['CUSTOM_BASE', 'LOCAL_CSS'], ['root', 'shadowRoot']]) renamed = renamed.replace(new RegExp(`\\b${from}\\b`, 'g'), to);
  assert.deepEqual(componentSheetFlow(renamed).problems, []);
  assert.notEqual(renamed, source);
  for (const [from, to] of [
    ['view(spec, baseCss)', 'view(spec, "")'],
    ['view(child, baseCss)', 'view(child, "")'],
    ['tabs(spec.items, baseCss)', 'tabs(spec.items, "")'],
    ['custom(spec, baseCss)', 'custom(spec, "")'],
    ['baseCss + CUSTOM_BASE', 'CUSTOM_BASE + baseCss'],
    ['baseCss + CUSTOM_BASE', 'CUSTOM_BASE'],
    ['root.append(base, own,', 'root.append(own, base,'],
    ['root.append(base, own,', 'base.textContent = ""; root.append(base, own,'],
  ]) {
    const mutated = source.replace(from, to);
    assert.notEqual(mutated, source, from);
    assert.ok(componentSheetFlow(mutated).problems.length, `${from} -> ${to}`);
  }
});

test('lazy CSS module adoption is accepted only for the imported default text', () => {
  assert.deepEqual(scanTsFile('src/x.ts', "import('katex/dist/katex.min.css?inline').then(mod => { next.replaceSync(mod.default); });"), []);
  for (const source of ["import('./a.ts').then(mod => { next.replaceSync(mod.default); });", "import('./a.css?inline').then(mod => { next.replaceSync(mod.other); });", 'next.replaceSync(mod.default);']) assert.ok(scanTsFile('src/x.ts', source).length, source);
});

test('GU_CONTAINERS closed import rules reject renamed, .js, namespace and dynamic-import bypasses', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const IMPORT = "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';";
  assert.ok(gu.includes(IMPORT), 'import sample present');
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  assert.deepEqual(other("import { markTightCustom } from './generative-ui-selectors.js';\nexport const m = markTightCustom;"), [], 'a plain named import with a .js specifier passes');
  assert.deepEqual(other("import type { GU_CONTAINERS as G } from './generative-ui-selectors';\nexport type T = typeof G;"), [], 'a type-only renamed import passes');
  for (const [label, source] of [
    ['(a) renamed import in another module', "import { GU_CONTAINERS as G } from './generative-ui-selectors';\nexport const S = G.slice(1).join(',');"],
    ['(a) renamed re-export', "export { GU_CONTAINER_SELECTOR as SEL } from './generative-ui-selectors.ts';"],
    ['(c) .js specifier slicing GU_CONTAINERS', "import { GU_CONTAINERS } from './generative-ui-selectors.js';\nexport const S = GU_CONTAINERS.slice(1);"],
    ['(c) .mjs specifier slicing GU_CONTAINERS', "import { GU_CONTAINERS } from './generative-ui-selectors.mjs';\nexport const S = GU_CONTAINERS.slice(1);"],
    ['(d) namespace import with computed access', "import * as s from './generative-ui-selectors';\nexport const S = s['GU_' + 'CONTAINERS'].slice(1);"],
    ['(d) default import', "import sel from './generative-ui-selectors';\nexport const S = sel;"],
    ['(d) namespace re-export', "export * as s from './generative-ui-selectors.js';"],
    ['(e) dynamic import()', "export const load = () => import('./generative-ui-selectors').then(m => m.GU_CONTAINERS.slice(1));"],
    ['(e) folded dynamic import()', "export const load = () => import('./generative-ui-' + 'selectors.js');"],
    ['(e) template dynamic import()', 'export const load = () => import(`./generative-ui-${\'selectors\'}`);'],
  ]) assert.ok(other(source).length, label);
  // (b) inside src/generative-ui.ts itself: a renamed import alongside the plain one, and a dynamic import.
  for (const [label, mutated] of [
    ['(b) renamed import alongside the plain import', gu.replace(IMPORT, `${IMPORT}\nimport { GU_CONTAINERS as G } from './generative-ui-selectors.ts';\nexport const S = G.slice(1);`)],
    ['(b) renamed GU_CONTAINER_SELECTOR in the same import', gu.replace(IMPORT, IMPORT.replace('markTightCustom', 'markTightCustom, GU_CONTAINER_SELECTOR as SEL'))],
    ['(e) dynamic import in src/generative-ui.ts', `${gu}\nexport const load = () => import('./generative-ui-' + 'selectors.ts');`],
  ]) {
    assert.notEqual(mutated, gu, label);
    assert.ok(tightContainerProblems(sel, css, mutated).length, label);
  }
});

test('GU_CONTAINERS whole uses reject chained reads, re-exports and local exports', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const IMPORT = "import { GU_CONTAINERS, markTightCustom } from './generative-ui-selectors.ts';";
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  const both = "import { GU_CONTAINERS, GU_CONTAINER_SELECTOR } from './generative-ui-selectors';\n";
  assert.deepEqual(other(`${both}const A = [...GU_CONTAINERS, '.x'].join(',');\nconst B = \`:is(\${GU_CONTAINER_SELECTOR}) a\`;\nconst C = ([GU_CONTAINER_SELECTOR, '.y'] as const).join(',');\nconst D = (GU_CONTAINERS.join(',') as string);\nexport const hit = (el: Element) => el.matches(A) || el.matches(B) || el.matches(C) || el.matches(D);`), [], 'sealed whole uses read bare pass');
  const chained = [
    "[...GU_CONTAINERS].slice(1).join(',')",
    "GU_CONTAINERS.join(',').replace('.gu-card,', '')",
    "`${GU_CONTAINER_SELECTOR}`.replace('.gu-card,', '')",
    "([ ...GU_CONTAINERS ]).filter(Boolean).join(',')",
    "(GU_CONTAINERS.join(',')).split(',')",
    '[...GU_CONTAINERS][0]',
    "[...GU_CONTAINERS].join(',').replace('.gu-card,', '')",
    "[GU_CONTAINER_SELECTOR].map(String).join(',')",
    // Any enclosing operator fails: sealed() is an allowlist (initializer, return, export default).
    "([...GU_CONTAINERS] || []).slice(1).join(',')",
    '(true ? [...GU_CONTAINERS] : []).slice(1)',
    "('' + GU_CONTAINERS.join(',')).replace('.gu-card,', '')",
    '[...new Set([...GU_CONTAINERS])].slice(1)',
    '({ l: [...GU_CONTAINERS] }).l.slice(1)',
  ];
  for (const expr of chained) {
    assert.ok(other(`${both}export const S = ${expr};`).length, `another module: ${expr}`);
    const mutated = gu.replace(IMPORT, `import { GU_CONTAINERS, GU_CONTAINER_SELECTOR, markTightCustom } from './generative-ui-selectors.ts';\nexport const S = ${expr};`);
    assert.notEqual(mutated, gu, expr);
    assert.ok(tightContainerProblems(sel, css, mutated).length, `src/generative-ui.ts: ${expr}`);
  }
  for (const [label, source] of [
    ['local renamed export', "import { GU_CONTAINERS } from './generative-ui-selectors';\nexport { GU_CONTAINERS as G };"],
    ['local plain export', "import { GU_CONTAINER_SELECTOR } from './generative-ui-selectors';\nexport { GU_CONTAINER_SELECTOR };"],
    ['plain re-export', "export { GU_CONTAINERS } from './generative-ui-selectors';"],
    ['star re-export', "export * from './generative-ui-selectors';"],
    ['re-export of a helper', "export { markTightCustom } from './generative-ui-selectors.ts';"],
  ]) assert.ok(other(source).length, label);
  assert.deepEqual(other("export type { GU_CONTAINERS } from './generative-ui-selectors';"), [], 'a type-only re-export passes');
  assert.ok(other(`${both}export default \`\${GU_CONTAINER_SELECTOR} a\`;`).length, 'an export default whole use fails');
  assert.ok(other(`${both}export default [...GU_CONTAINERS];`).length, 'export default [...GU_CONTAINERS] fails');
  for (const source of [
    "const [, ...rest] = [...GU_CONTAINERS];\nexport const S = rest.join(',');",
    "const { 0: a } = [...GU_CONTAINERS];\nexport const S = a;",
    "export function f() { return [...GU_CONTAINERS].join(','); }",
    'export const f = () => [...GU_CONTAINERS];',
    'function f() { return [...GU_CONTAINERS]; }\nexport const S = f().slice(1);',
  ]) {
    assert.ok(other(`${both}${source}`).length, `another module: ${source}`);
    const mutated = gu.replace(IMPORT, `${IMPORT}\n${source}`);
    assert.notEqual(mutated, gu, source);
    assert.ok(tightContainerProblems(sel, css, mutated).length, `src/generative-ui.ts: ${source}`);
  }
});

test('GU_CONTAINERS derived variables stay local, whole and unexported', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  const both = "import { GU_CONTAINERS, GU_CONTAINER_SELECTOR } from './generative-ui-selectors';\n";
  assert.deepEqual(other(`${both}const A = [...GU_CONTAINERS, '.x'].join(',');\nexport const hit = (el: Element) => el.matches(A);`), [], 'a bare read of a local derived variable passes');
  for (const [label, source] of [
    ['non-owning export const', "export const X = [...GU_CONTAINERS];"],
    ['non-owning export let', "export let X = GU_CONTAINERS.join(',');"],
    ['derived spread sliced', "const a = [...GU_CONTAINERS];\nconst X = a.slice(1);"],
    ['derived join replaced', "const a = GU_CONTAINERS.join(',');\nconst X = a.replace('.gu-card,', '');"],
    ['derived element access', 'const a = [...GU_CONTAINERS];\nconst X = (a as string[])[0];'],
    ['derived template sliced', 'const a = `${GU_CONTAINER_SELECTOR}`;\nconst X = a.slice(4);'],
    ['derived local export', "const a = [...GU_CONTAINERS].join(',');\nexport { a };"],
    ['derived renamed export', "const a = [...GU_CONTAINERS].join(',');\nexport { a as B };"],
    ['derived default export', "const a = [...GU_CONTAINERS].join(',');\nexport default a;"],
  ]) {
    assert.ok(other(`${both}${source}`).some(hit => hit.startsWith('src/gu-extra.ts')), label);
  }
  // The real derived constants in the owner and src/generative-ui.ts are read bare and still pass.
  assert.deepEqual(tightContainerProblems(sel, css, gu), []);
  assert.ok(tightContainerProblems(sel.replace('node.matches(TIGHT_CUSTOM)', 'node.matches(TIGHT_CUSTOM.slice(1))'), css, gu).length, 'slicing TIGHT_CUSTOM in the owner fails');
  assert.ok(tightContainerProblems(sel, css, gu.replace('node.matches(SHADOW_SURFACE)', 'node.matches(SHADOW_SURFACE.replace(".gu-card,", ""))')).length, 'editing SHADOW_SURFACE fails');
});

test('GU_CONTAINERS derived exports, spreads, destructuring and require() are closed', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  const fails = (source, label) => assert.ok(other(source).some(hit => hit.startsWith('src/gu-extra.ts')), label);
  assert.deepEqual([...ownerDerivedExports(sel)], ['TIGHT_CUSTOM'], 'TIGHT_CUSTOM is found as a derived export of the owner');
  const tight = "import { TIGHT_CUSTOM } from './generative-ui-selectors';\n";
  assert.deepEqual(other(`${tight}export const hit = (el: Element) => el.matches(TIGHT_CUSTOM);`), [], 'a bare read of an imported TIGHT_CUSTOM passes');
  for (const source of [
    "export const t = TIGHT_CUSTOM.replace('.gu-card', '');",
    'export const t = TIGHT_CUSTOM.slice(1);',
    'export const t = TIGHT_CUSTOM[0];',
    'export const t = [...TIGHT_CUSTOM];',
    'export default TIGHT_CUSTOM;',
    'export { TIGHT_CUSTOM };',
  ]) fails(`${tight}${source}`, `imported TIGHT_CUSTOM: ${source}`);
  fails("import { TIGHT_CUSTOM as T } from './generative-ui-selectors';\nexport const hit = (el: Element) => el.matches(T);", 'a renamed TIGHT_CUSTOM import fails');
  fails("import { TIGHT_CUSTOM as T } from './generative-ui-selectors';\nexport const t = T.slice(1);", 'slicing a renamed TIGHT_CUSTOM fails');
  const both = "import { GU_CONTAINERS } from './generative-ui-selectors';\n";
  for (const source of [
    'const a = [...GU_CONTAINERS];\nexport const b = [...a].slice(1);',
    "const a = [...GU_CONTAINERS];\nconst [, ...rest] = a;\nexport const b = rest.join(',');",
    'const a = [...GU_CONTAINERS];\nconst { 0: x } = a;\nexport const b = x;',
  ]) fails(`${both}${source}`, `derived spread or destructuring: ${source}`);
  for (const source of [
    "const s = require('./generative-ui-selectors');\nconst t = s.GU_CONTAINERS.slice(1);",
    "const s = require('./generative-ui-' + 'selectors.ts');",
    "const s = (require)(`./generative-ui-${'selectors'}`);",
  ]) {
    assert.ok(!/\b(?:import|export)\b/.test(source), `no import/export keyword: ${source}`);
    fails(source, `require(): ${source}`);
  }
});

test('GU_CONTAINERS specifiers resolve ?query, /src/ root paths and every script extension', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  for (const [label, file, source] of [
    ['root-relative renamed import', 'src/gu-extra.ts', "import { GU_CONTAINERS as G } from '/src/generative-ui-selectors.ts';\nexport const S = G;"],
    ['?query slicing import', 'src/gu-extra.ts', "import { GU_CONTAINERS } from './generative-ui-selectors.ts?v=1';\nconst S = GU_CONTAINERS.slice(1);"],
    ['root-relative dynamic import()', 'src/nested/gu-extra.ts', "export const load = () => import('/src/generative-ui-selectors.ts');"],
    ['.mjs module', 'src/gu-extra.mjs', "import { GU_CONTAINERS } from './generative-ui-selectors.js';\nconst S = GU_CONTAINERS.slice(1);"],
    ['.cjs module', 'src/gu-extra.cjs', "export const load = () => import('./generative-ui-selectors');"],
    ['.mts module', 'src/gu-extra.mts', "import * as s from './generative-ui-selectors.ts';\nexport const S = s;"],
    ['.cts module', 'src/gu-extra.cts', "import { GU_CONTAINERS as G } from './generative-ui-selectors';\nexport const S = G;"],
  ]) assert.ok(tightContainerProblems(sel, css, gu, { [file]: source }).some(hit => hit.startsWith(file)), label);
  assert.deepEqual([...SCRIPT_EXTS].sort(), ['.cjs', '.cts', '.js', '.mjs', '.mts', '.ts', '.tsx'], 'the repo-wide scan walks every script extension');
  assert.deepEqual(tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': "import { markTightCustom } from '/src/generative-ui-selectors.ts?raw';\nexport const m = markTightCustom;" }), [], 'a plain named import through /src/ and ?query passes');
});

test('GU_CONTAINERS is not reachable through import.meta.glob()', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  for (const source of [
    "export const m = import.meta.glob('./generative-ui-selectors.ts', { eager: true });",
    "export const m = import.meta.glob('./*.ts');",
    "export const m = import.meta.glob(['./a.ts', './generative-ui-' + 'selectors.ts']);",
    "export const m = import.meta.glob('/src/**/*.ts');",
    "export const m = import.meta['glob']('./*.{ts,js}');",
    "export const m = import.meta.globEager('../src/generative-ui-selector?.ts');",
  ]) assert.ok(other(source).some(hit => hit.includes('import.meta.glob()')), source);
  assert.deepEqual(other("export const m = import.meta.glob('./scenes/*.ts');"), [], 'a glob missing the module passes');
  assert.deepEqual(other("export const m = import.meta.glob(['./scenes/*.ts', '!./*.ts']);"), [], 'negated patterns are skipped');
  assert.deepEqual(tightContainerProblems(sel, css, gu, { 'src/scenes/index.ts': read('src/scenes/index.ts') }), [], "src/scenes/index.ts's './*.ts' glob stays in src/scenes/");
});

test('GU_CONTAINERS importers are found from the AST alone, with no raw-text pre-filter', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const probes = [
    "export const load = () => import('./gener' + 'ative-ui-selectors');",
    "import { GU_CONTAINERS } from './generative\\x2dui-selectors';\nexport const S = GU_CONTAINERS.slice(1);",
  ];
  for (const source of probes) {
    assert.ok(!source.includes('generative-ui'), `${source} hides the raw module name`);
    assert.ok(tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source }).some(hit => hit.startsWith('src/gu-extra.ts')), `extraSources: ${source}`);
  }
  // The default repo-wide scan reads every src/ module, so the same probe on disk would be parsed too.
  const live = tightContainerProblems(sel, css, gu);
  assert.deepEqual(live, []);
});

test('segmented-control options keep regular body weight, with tracks discovered automatically', () => {
  assert.deepEqual(segmentedWeightProblems(), []);
  const live = segmentedTracks({ 'src/a.css': '.gh-tabs>.segment-thumb{}html[data-theme] :is(.saver-levels,.choice-menu-segment-list)>.segment-thumb{}' }, { 'src/a.ts': '`<div class="import-sources ds-seg" data-segmented role="radiogroup">`' });
  for (const name of ['[data-segmented]', '.gh-tabs', '.saver-levels', '.choice-menu-segment-list', '.import-sources', '.ds-seg']) assert.ok(live.has(name), name);
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': '.custom-seg>button[aria-pressed="true"]{font-weight:var(--weight-medium)}' }), [], 'a class with no .segment-thumb or data-segmented is not a track');
  for (const css of [
    '.saver-levels button[aria-checked="true"]{font-weight:var(--weight-medium)}',
    '[data-segmented]>button.selected{font-weight:500}',
    '.import-sources>button{font-weight:var(--weight-medium)}',
    '.custom-seg>.segment-thumb{border-radius:var(--ds-control-radius)}.custom-seg>button[aria-pressed="true"]{font-weight:var(--weight-medium)}',
    ':where(.new-seg)>.segment-thumb{}.new-seg>button:hover{font:var(--weight-strong) var(--type-body)/var(--type-body-leading) var(--font-ui)}',
    '.gh-tabs>button[aria-selected="true"]{font-weight:bold}',
    '.choice-menu .choice-menu-option.choice-menu-segment[aria-checked=true]{font-weight:var(--type-subheading-weight)}',
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  for (const css of ['.routing-modes{font-weight:700}', '.gh-tabs{font:600 1rem/1.4 var(--sans)}', '[data-segmented]{font-weight:600}', '.ds-seg{font-weight:var(--weight-medium)}']) {
    assert.ok(segmentedWeightProblems({ 'src/x.css': `.routing-modes>.segment-thumb{}${css}` }).length, `track subject: ${css}`);
  }
  for (const css of [
    '.ds-seg>button{font-weight:var(--x,700)}',
    '.ds-seg>button{font-weight:var(--x, var(--weight-medium))}',
    '.ds-seg>button{font-weight:calc(600)}',
    ".ds-seg>button{font-variation-settings:'wght' 600}",
    '.ds-seg>button{font-variation-settings:"opsz" 12, "wght" 650}',
    '[data-segmented=""]{font-weight:600}',
    '[data-segmented="true"]>button{font-weight:600}',
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': ".ds-seg>button{font-weight:var(--weight-regular,400);font-variation-settings:'wght' 400}" }), [], 'regular fallbacks and axes pass');
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': '.gh-tabs>.segment-thumb{font-weight:600}' }), [], 'the thumb itself is exempt');
  assert.ok(segmentedWeightProblems({ 'src/x.css': '.ts-seg>button.selected{font-weight:600}' }, { 'src/x.ts': '`<div class="ts-seg" data-segmented>`' }).length, 'a data-segmented tag in TS is discovered');
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': '.gh-tabs>button.selected{font-weight:var(--type-body-weight)}.gh-tabs>button{font-weight:400}' }), [], 'regular weight passes');
});

test('segmented weights resolve custom properties, font shorthand tokens and wght axes, failing closed', () => {
  for (const css of [
    '.gh-tabs{--seg-w:600}.gh-tabs button{font-weight:var(--seg-w)}',
    ':root{--probe-w:var(--weight-strong)}.gh-tabs button{font-weight:var(--probe-w)}',
    '.ds-seg>button{font-weight:var(--unknown-w)}',
    ':root{--cyc-a:var(--cyc-b);--cyc-b:var(--cyc-a)}.ds-seg>button{font-weight:var(--cyc-a)}',
    '.ds-seg>button{font:var(--x, 600) 13px/1 sans-serif}',
    '.gh-tabs{--seg-w:600}.gh-tabs button{font:italic var(--seg-w) 13px/1 var(--sans)}',
    '.ds-seg>button{font:calc(600) 13px/1 var(--sans)}',
    '.ds-seg>button{font:calc(600) var(--type-body)/var(--type-body-leading) var(--sans)}',
    '.ds-seg>button{font:var(--type-heading-weight) var(--type-heading) var(--sans)}',
    '.ds-seg>button{font-variation-settings:"wght" var(--weight-strong)}',
    '.ds-seg>button{font-variation-settings:"wght" calc(650)}',
    '.ds-seg>button{font-variation-settings:"wght" var(--unknown-w)}',
    '.ds-seg>button{font-variation-settings:"wght" var(--x, 600)}',
    ".gh-tabs{--seg-w:600}.gh-tabs button{font-variation-settings:'wght' var(--seg-w)}",
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  for (const css of [
    '.ds-seg{--seg-ok:var(--weight-regular)}.ds-seg>button{font-weight:var(--seg-ok)}',
    '.ds-seg>button{font:var(--weight-regular) var(--type-body)/var(--type-body-leading) var(--sans)}',
    ".ds-seg>button{font-variation-settings:'wght' 400}",
    ".ds-seg>button{font-variation-settings:'wght' var(--weight-regular)}",
    '.ds-seg>button{font:inherit}',
  ]) assert.deepEqual(segmentedWeightProblems({ 'src/x.css': css }), [], css);
});

test('segmented font shorthands, variation settings and class attribute selectors fail closed', () => {
  for (const css of [
    '.ds-seg button{font:var(--probe-font)} :root{--probe-font:600 13px/1.4 sans-serif}',
    '.ds-seg button{font:var(--unknown)}',
    '.ds-seg button{font:caption}',
    '.ds-seg button{font:menu}',
    '.ds-seg button{font:var(--unknown, 400 13px/1 sans-serif)}',
    '.ds-seg button{font-variation-settings:var(--probe-fv)} :root{--probe-fv:"wght" 700}',
    '.ds-seg button{font-variation-settings:var(--unknown-fv)}',
    '.ds-seg button{font-variation-settings:"opsz" 12, var(--unknown-fv)}',
    '.ds-seg button{font-variation-settings:attr(data-axes)}',
    '[class~="ds-seg"] button{font-weight:600}',
    '[class="a ds-seg"] button{font-weight:600}',
    "[class*='seg' i] button{font-weight:600}",
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  for (const css of [
    '.ds-seg button{font:inherit}',
    '.ds-seg button{font:unset}',
    '.ds-seg button{font:var(--ok-font)} :root{--ok-font:400 13px/1.4 sans-serif}',
    '.ds-seg button{font-variation-settings:normal}',
    ".ds-seg button{font-variation-settings:'opsz' 12}",
    ".ds-seg button{font-variation-settings:'wght' 400}",
    ".ds-seg button{font-variation-settings:'wght' var(--weight-regular)}",
    ".ds-seg button{font-variation-settings:var(--ok-fv)} :root{--ok-fv:'wght' 400}",
    '[class~="a ds-seg"] button{font-weight:600}',
    '[class^=""] button{font-weight:600}',
    '.x:not([class~="ds-seg"]) button{font-weight:600}',
  ]) assert.deepEqual(segmentedWeightProblems({ 'src/x.css': css }), [], css);
});

test('segmented weights check every definition of regular role tokens', () => {
  for (const css of [
    '.ds-seg{--type-body-weight:700}',
    ':root{--weight-regular:700}',
    ':root{--type-meta-weight:var(--weight-strong)}.gh-tabs>button{font-weight:var(--type-meta-weight)}',
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': ':root{--weight-regular:400}' }), [], 'a regular redefinition passes');
});

test('R18: the base reset is verified and track subjects cannot inherit, unset or all: it away', () => {
  const base = readFileSync(join(root, 'src/design-system.css'), 'utf8');
  const rule = '[data-segmented],.ds-seg{font-weight:var(--type-body-weight);font-variation-settings:normal}';
  assert.ok(base.includes(rule), 'the base reset is present');
  const missing = segmentedWeightProblems({ 'src/design-system.css': base.replace(rule, '') });
  assert.ok(missing.some(hit => hit.includes('must keep the unconditional regular font-weight')), 'removing the base reset fails');
  for (const [label, css] of [
    ['inside @media', base.replace(rule, `@media (min-width:1px){${rule}}`)],
    ['inherit', base.replace(rule, '[data-segmented],.ds-seg{font-weight:inherit}')],
    ['descendant subject', base.replace(rule, '.x [data-segmented],.x .ds-seg{font-weight:var(--type-body-weight);font-variation-settings:normal}')],
  ]) assert.ok(segmentedWeightProblems({ 'src/design-system.css': css }).some(hit => hit.includes('unconditional regular font-weight')), label);
  assert.deepEqual(segmentedWeightProblems({ 'src/design-system.css': base.replace(rule, '[data-segmented]{font-weight:400;font-variation-settings:normal}.ds-seg{font-weight:normal;font-variation-settings:NORMAL}') }), [], 'separate unconditional regular rules pass');
  for (const css of ['.gh-tabs{font-weight:inherit}', '[data-segmented]{font-weight:unset}', '.ds-seg{font:inherit}', '.ds-seg{font:unset}', '.ds-seg{all:inherit}', '.ds-seg{all:unset}', '.gh-tabs{all:initial}']) {
    assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, `track subject: ${css}`);
  }
  for (const css of ['.ds-seg>button{font:inherit}', '.ds-seg>button{font-weight:inherit}', '.ds-seg{font-weight:normal}', '.ds-seg{font-weight:var(--weight-regular)}']) {
    assert.deepEqual(segmentedWeightProblems({ 'src/x.css': css }), [], `allowed: ${css}`);
  }
  assert.ok(segmentedWeightProblems({ 'src/x.css': '.mts-seg>button.selected{font-weight:600}' }, { 'src/x.mts': '`<div class="mts-seg" data-segmented>`' }).length, 'a data-segmented tag in a .mts module is discovered');
});

test('R18: derived container variables are held to a strict DOM-selector allowlist', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  const tight = "import { TIGHT_CUSTOM } from './generative-ui-selectors';\n";
  const list = "import { GU_CONTAINERS } from './generative-ui-selectors';\nconst a = GU_CONTAINERS.join(',');\n";
  for (const [label, source] of [
    ['template replace', `${tight}export const t = \`\${TIGHT_CUSTOM}\`.replace('.gu-card', '');`],
    ['concat split', `${tight}export const t = (TIGHT_CUSTOM + '').split(',').slice(1);`],
    ['String()', `${tight}export const t = String(TIGHT_CUSTOM).slice(1);`],
    ['let reassigned', "import { GU_CONTAINERS } from './generative-ui-selectors';\nlet a = GU_CONTAINERS.join(',');\na = '.gu-card';\nexport const hit = (el: Element) => el.matches(a);"],
    ['var', "import { GU_CONTAINERS } from './generative-ui-selectors';\nvar a = GU_CONTAINERS.join(',');\nexport const hit = (el: Element) => el.matches(a);"],
    ['for..of', `${list}for (const c of a) console.log(c);`],
    ['alias copy', `${list}const b = a;\nexport const t = b.slice(1);`],
    ['helper call', `${list}const trim = (s: string) => s.slice(1);\nexport const t = trim(a);`],
    ['mixed-case specifier', "import { GU_CONTAINERS } from './Generative-UI-Selectors';\nexport const S = GU_CONTAINERS.slice(1);"],
    ['mixed-case extension', "import { GU_CONTAINERS as G } from './generative-ui-selectors.TS';\nexport const S = G;"],
  ]) assert.ok(other(source).some(hit => hit.startsWith('src/gu-extra.ts')), label);
  assert.ok(other("export const m = import.meta.glob('./Generative-UI-Selectors.ts');").some(hit => hit.includes('import.meta.glob()')), 'a mixed-case glob fails');
  for (const call of ['el.matches(TIGHT_CUSTOM)', 'el.closest(TIGHT_CUSTOM)', 'el.querySelector(TIGHT_CUSTOM)', 'el.querySelectorAll((TIGHT_CUSTOM as string))']) {
    assert.deepEqual(other(`${tight}export const hit = (el: Element) => ${call};`), [], `allowed: ${call}`);
  }
  assert.deepEqual(tightContainerProblems(sel, css, gu), [], 'the live owner, generative-ui.ts and importers pass');
});

test('R18: every guard shares SCRIPT_EXTS and the attachShadow inventory covers .mts, .cts and .cjs', () => {
  assert.deepEqual(SHARED_EXTS, ['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs', '.cjs']);
  assert.equal(SCRIPT_EXTS, SHARED_EXTS, 'gu-containers re-exports the shared list');
  assert.deepEqual(SHADOW_EXTS, [...SHARED_EXTS, '.html'], 'shadowSources() walks every script extension plus .html');
  const sources = shadowSources();
  const widget = "export function mount(el: HTMLElement) {\n  const root = el.attachShadow({ mode: 'open' });\n  root.innerHTML = '<p>hi</p>';\n}\n";
  for (const file of ['src/new-widget.mts', 'src/new-widget.cts', 'src/new-widget.cjs']) {
    assert.ok(shadowInventoryProblems({ ...sources, [file]: widget }).some(hit => hit.startsWith(`${file}: attachShadow() in mount`)), `${file} root fails`);
  }
});

test('R20: shared extension lists are frozen', () => {
  assert.ok(Object.isFrozen(SHARED_EXTS), 'SCRIPT_EXTS is frozen');
  assert.ok(Object.isFrozen(SHADOW_EXTS), 'SHADOW_EXTS is frozen');
  assert.throws(() => { 'use strict'; SHARED_EXTS.push('.vue'); }, TypeError);
});

test('R20: 2-token and var()-bearing font shorthands expand in place and fail closed', () => {
  const probe = css => segmentedWeightProblems({ 'src/x.css': css });
  for (const css of [
    ':root{--zzx:13px/1 sans-serif}.ds-seg{font:var(--weight-bold) var(--zzx)}',
    ':root{--zzx:700 13px/1 sans-serif}.ds-seg{font:italic var(--zzx)}',
    ':root{--x:700 13px}.ds-seg{font:var(--x)/1 sans-serif}',
    ':root{--zzx:13px/1 sans-serif}.ds-seg{font:italic var(--weight-bold) var(--zzx)}',
    ':root{--zzx:13px/1 sans-serif}.ds-seg{font:var(--weight-medium) var(--zzx)}',
    '.ds-seg{font:var(--zzx-unknown) sans-serif}',
    ':root{--zzx:var(--zzx) sans-serif}.ds-seg{font:italic var(--zzx)}',
    ':root{--zzx:13px/1 sans-serif}.ds-seg{font:var(--zzw, 700) var(--zzx)}',
    ':root{--zzx:700 13px}.ds-seg{font:var(--zzx-missing, var(--zzx))/1 sans-serif}',
    '.ds-seg{font:bold sans-serif}',
  ]) assert.ok(probe(css).length, css);
  for (const css of [
    ':root{--zzx:13px/1 sans-serif}.ds-seg{font:var(--weight-regular) var(--zzx)}',
    ':root{--zzx:400 13px/1 sans-serif}.ds-seg{font:italic var(--zzx)}',
    ':root{--zzx:13px}.ds-seg{font:var(--zzx)/1 sans-serif}',
    '.ds-seg{font:var(--type-body)/var(--type-body-leading) var(--font-sans)}',
    '.ds-seg{font:400 13px/1 sans-serif}',
  ]) assert.deepEqual(probe(css), [], `allowed: ${css}`);
  const defs = new Map([['--zzx', ['13px/1 sans-serif']]]);
  assert.equal(heavyFontShorthand('var(--weight-regular) var(--zzx)', defs), false, 'an undefined regular role token reads as 400');
  assert.equal(heavyFontShorthand('var(--weight-bold) var(--zzx)', defs), true, 'an undefined heavy token fails closed');
});

test('R20: the base reset pins font-variation-settings and track subjects cannot inherit it', () => {
  const base = readFileSync(join(root, 'src/design-system.css'), 'utf8');
  const rule = '[data-segmented],.ds-seg{font-weight:var(--type-body-weight);font-variation-settings:normal}';
  for (const [label, css] of [
    ['omitted', '[data-segmented],.ds-seg{font-weight:var(--type-body-weight)}'],
    ['inherit', '[data-segmented],.ds-seg{font-weight:var(--type-body-weight);font-variation-settings:inherit}'],
    ['axis', '[data-segmented],.ds-seg{font-weight:var(--type-body-weight);font-variation-settings:"wght" 400}'],
  ]) assert.ok(segmentedWeightProblems({ 'src/design-system.css': base.replace(rule, css) }).some(hit => hit.includes('font-variation-settings:normal reset')), label);
  for (const css of ['.ds-seg{font-variation-settings:inherit}', '[data-segmented]{font-variation-settings:unset}', '.gh-tabs{font-variation-settings:var(--zzv)}:root{--zzv:inherit}']) {
    assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, `track subject: ${css}`);
  }
  for (const css of ['.ds-seg>button{font-variation-settings:inherit}', '.ds-seg>button{font-variation-settings:unset}', '.ds-seg{font-variation-settings:normal}']) {
    assert.deepEqual(segmentedWeightProblems({ 'src/x.css': css }), [], `allowed: ${css}`);
  }
});

test('R20: renamed owner exports are tracked and fake selector receivers rejected', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const renamed = `${sel}\nexport { TIGHT_CUSTOM as TC, GU_CONTAINERS as G };\n`;
  assert.ok(ownerDerivedExports(renamed).has('TC') && ownerDerivedExports(renamed).has('G'), 'renamed owner exports are tracked by exported name');
  assert.ok(!ownerDerivedExports(`${sel}\nexport { GU_CONTAINERS };\n`).has('GU_CONTAINERS'), 'a plain export of the list is not a derived export');
  const owner = source => tightContainerProblems(renamed, css, gu, { 'src/gu-extra.ts': source }).filter(hit => hit.includes('src/gu-extra.ts'));
  for (const [label, source] of [
    ['TC split', "import { TC } from './generative-ui-selectors';\nexport const bad = TC.split(',').slice(1);"],
    ['TC renamed', "import { TC as X } from './generative-ui-selectors';\nexport const ok = (el: Element) => el.matches(X);"],
    ['TC re-exported', "import { TC } from './generative-ui-selectors';\nexport { TC };"],
    ['G slice', "import { G } from './generative-ui-selectors';\nexport const bad = G.slice(1);"],
  ]) assert.ok(owner(source).length, label);
  assert.deepEqual(owner("import { TC } from './generative-ui-selectors';\nexport const ok = (el: Element) => el.matches(TC);"), [], 'TC passed whole to matches()');
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source });
  const tight = "import { TIGHT_CUSTOM } from './generative-ui-selectors';\n";
  for (const [label, source] of [
    ['object literal receiver', 'export const bad = { matches(s: string) { return s.slice(1); } }.matches(TIGHT_CUSTOM);'],
    ['local object method', 'const f = { matches(s: string) { return s.slice(1); } };\nexport const bad = f.matches(TIGHT_CUSTOM);'],
    ['new receiver', 'class C { matches(s: string) { return s; } }\nexport const bad = new C().matches(TIGHT_CUSTOM);'],
    ['assigned method', "declare const el: any;\nel.matches = (s: string) => s;\nexport const bad = el.matches(TIGHT_CUSTOM);"],
    ['bracket-assigned method', "declare const el: any;\nel['clo' + 'sest'] = (s: string) => s;\nexport const bad = el.closest(TIGHT_CUSTOM);"],
    ['function declaration', 'function querySelector(s: string) { return s; }\nexport const bad = (el: Element) => el.querySelector(TIGHT_CUSTOM);'],
    ['extra argument', "declare const el: any;\nexport const bad = el.matches('a', TIGHT_CUSTOM);"],
    ['trailing argument', "declare const el: any;\nexport const bad = el.matches(TIGHT_CUSTOM, 'a');"],
  ]) assert.ok(other(`${tight}${source}`).some(hit => hit.startsWith('src/gu-extra.ts')), label);
  assert.deepEqual(other(`${tight}export const ok = (el: Element) => el.matches(TIGHT_CUSTOM);`), [], 'el.matches(TIGHT_CUSTOM) passes');
  assert.deepEqual(tightContainerProblems(sel, css, gu), [], 'the live owner and generative-ui.ts stay clean');
});

test('R21: font sizes are literal or exact bare size tokens; fallbacks and poisoned definitions expand', () => {
  const probe = css => segmentedWeightProblems({ 'src/x.css': css });
  for (const css of [
    ':root{--text-heavy:700 13px/1}.ds-seg>button{font:var(--text-heavy) sans-serif}',
    ':root{--md-heavy:bold 1em/1}.ds-seg>button{font:var(--md-heavy) sans-serif}',
    '.ds-seg>button{font:var(--type-body, bold 13px) sans-serif}',
    '.ds-seg>button{font:var(--type-body, bold 13px)/1 sans-serif}',
    ':root{--type-body:700 13px}.ds-seg>button{font:var(--type-body) sans-serif}',
    ':root{--type-body:bold}.ds-seg>button{font:var(--type-body) 13px sans-serif}',
  ]) assert.ok(probe(css).length, css);
  for (const css of [
    '.ds-seg>button{font:var(--type-body)/var(--type-body-leading) var(--font-sans)}',
    '.ds-seg>button{font:var(--type-body, 13px) sans-serif}',
    '.ds-seg>button{font:var(--md-heading-lg)/1.2 sans-serif}',
    '.ds-seg>button{font:400 var(--md-heading-lg)/1.2 sans-serif}',
  ]) assert.deepEqual(probe(css), [], `allowed: ${css}`);
  assert.equal(heavyFontShorthand('var(--type-body, 13px) sans-serif'), false, 'an undefined exact size token reads as 1rem');
  assert.equal(heavyFontShorthand('var(--type-body, bold 13px) sans-serif'), true, 'its heavy fallback still fails');
  assert.equal(heavyFontShorthand('var(--text-heavy) sans-serif'), true, 'an open-ended --text- name is no longer a size');
});

test('R21: defineProperty, defineProperties, Reflect.set and import = require() are closed', () => {
  const read = file => readFileSync(join(root, file), 'utf8');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(read);
  const other = source => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source }).filter(hit => hit.startsWith('src/gu-extra.ts'));
  const tight = "import { TIGHT_CUSTOM } from './generative-ui-selectors';\ndeclare const f: any;\n";
  for (const [label, source] of [
    ['Object.defineProperty', "Object.defineProperty(f, 'matches', { value: (s: string) => s });\nexport const bad = f.matches(TIGHT_CUSTOM);"],
    ['folded Object[defineProperty]', "Object['define' + 'Property'](f, 'mat' + 'ches', { value: (s: string) => s });\nexport const bad = f.matches(TIGHT_CUSTOM);"],
    ['Object.defineProperties', 'Object.defineProperties(f, { matches: { value: (s: string) => s } });\nexport const bad = f.matches(TIGHT_CUSTOM);'],
    ['Reflect.set', "Reflect.set(f, 'closest', (s: string) => s);\nexport const bad = f.closest(TIGHT_CUSTOM);"],
    ["folded Reflect['set']", "(Reflect['s' + 'et'])(f, `closest`, (s: string) => s);\nexport const bad = f.closest(TIGHT_CUSTOM);"],
  ]) assert.ok(other(`${tight}${source}`).length, label);
  assert.deepEqual(other(`${tight}Object.defineProperty(f, 'other', { value: 1 });\nexport const ok = (el: Element) => el.matches(TIGHT_CUSTOM);`), [], 'an unrelated key passes');
  for (const source of ["import sel = require('./generative-ui-selectors');\nexport const S = sel;", "import sel = require('./generative-ui-selectors.ts');\nexport const n = 1;"]) {
    assert.ok(other(source).some(hit => hit.includes('import sel = require()')), source);
  }
});

test('R22: :has(… .segment-thumb) compounds are tracks, with or without their own class', () => {
  for (const css of [
    ':has(>.segment-thumb)>button{font-weight:700}',
    ':has(>.segment-thumb){font-weight:inherit}',
    '.custom:has(>.segment-thumb){font-weight:600}',
    '.has-seg:has(> .segment-thumb){}.has-seg>button.selected{font-weight:600}',
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': ':has(>.segment-thumb)>button{font-weight:var(--type-body-weight)}' }), [], 'regular weight passes');
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': '.plain:not(:has(.segment-thumb))>button{font-weight:600}' }), [], 'a negated :has() is not a track');
  const tracks = segmentedTracks({ 'src/x.css': '.custom:has(>.segment-thumb){}' }, {});
  assert.ok(tracks.has('.custom') && !tracks.has('.segment-thumb'), 'own classes are discovered, the thumb class is not');
});

test('R23: namespaced attributes, deep :has() and \\u-escaped require are caught', () => {
  for (const css of [
    '[*|data-segmented] button{font-weight:700}',
    '[|data-segmented] button{font-weight:700}',
    '[*|class~="ds-seg"] button{font-weight:700}',
    '.nt2:has(:is(:where(.segment-thumb))){color:inherit} .nt2 button{font-weight:700}',
  ]) assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  assert.deepEqual(segmentedWeightProblems({ 'src/x.css': '.nt3:has(:not(.segment-thumb)) button{font-weight:700}' }), [], 'a negated thumb inside :has() is not a track');
  assert.ok(!segmentedTracks({ 'src/x.css': '.nt3:has(:not(.segment-thumb)){}' }, {}).has('.nt3'), '.nt3 is not discovered');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(file => readFileSync(join(root, file), 'utf8'));
  const source = "const s = \\u0072equire('./generative-ui-selectors').GU_CONTAINERS.slice(1);\nconsole.log(s);";
  assert.ok(!/\b(?:import|export|require)\b/.test(source), 'the probe has no plain module keyword');
  assert.ok(tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': source }).some(hit => hit.startsWith('src/gu-extra.ts')), source);
});

test('R24: :not() parity, thumb child compounds, ${...} class slots and glob classes/extglobs', () => {
  for (const css of [':not(:not(.ds-seg)) button{font-weight:700}', ':not(:not([data-segmented])) button{font-weight:700}', '.q:has(:not(:not(.segment-thumb))) button{font-weight:700}']) {
    assert.ok(segmentedWeightProblems({ 'src/x.css': css }).length, css);
  }
  for (const css of ['.zz:not(.ds-seg) button{font-weight:700}', '.zz:not(:not(:not(.ds-seg))) button{font-weight:700}', '.q:has(:not(.segment-thumb)) button{font-weight:700}']) {
    assert.deepEqual(segmentedWeightProblems({ 'src/x.css': css }), [], `odd :not() stays excluded: ${css}`);
  }
  const tracks = segmentedTracks({ 'src/x.css': '.c1>.a.segment-thumb{}.c2 > :is(.segment-thumb){}.c3>:where(.a.segment-thumb){}.c4>[class~="segment-thumb"]{}.c5>:not(.segment-thumb){}' }, { 'src/a.ts': '`<div class="${x ? "a" : "b"} zztpl" data-segmented>`' });
  for (const name of ['.c1', '.c2', '.c3', '.c4', '.zztpl']) assert.ok(tracks.has(name), name);
  assert.ok(!tracks.has('.c5') && !tracks.has('.a') && !tracks.has('.segment-thumb'), 'negated thumbs, child classes and the thumb itself are not tracks');
  const [sel, css, gu] = ['src/generative-ui-selectors.ts', 'src/generative-ui.css', 'src/generative-ui.ts'].map(file => readFileSync(join(root, file), 'utf8'));
  const glob = pattern => tightContainerProblems(sel, css, gu, { 'src/gu-extra.ts': `export const m = import.meta.glob('./generative-ui-selector${pattern}.ts');` });
  for (const pattern of ['[s]', '[!x]', '+(s)', '@(s)', '?(s)', '*(s)', '!(x)', '{t,{s,u}}']) assert.ok(glob(pattern).some(hit => hit.includes('import.meta.glob()')), pattern);
  for (const pattern of ['[t]', '@(t|u)']) assert.deepEqual(glob(pattern), [], `${pattern} misses the module`);
});
