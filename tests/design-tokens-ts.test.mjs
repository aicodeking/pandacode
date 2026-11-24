/**
 * Static design-token guard, part 2: TypeScript and HTML style APIs.
 * Samples exercise style.*, setProperty, cssText, Object.assign, attributeStyleMap,
 * aliases, bindings, dynamic writes and inline HTML scripts against the CSS rules.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { scanCss, valueResolves, canonical } from './design-tokens/parser.mjs';
import { scanTsFile, scanHtml, specAliasProblems, isPreview, isCanvas } from './design-tokens/ts-style.mjs';

test('TypeScript guard: caps and resets', () => {
  const bad = [
    ['src/x.ts', "el.style.lineHeight = 'initial';", 'initial leading reset'],
    ['src/x.ts', 'const css = \'@property --ds-btn-h{syntax:"<length>";inherits:true;initial-value:40px}\';', 'ts string @property ds-btn-h'],
  ];
  for (const [file, text, label] of bad) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
});

test('TypeScript guard: scale literals and style API syntax', () => {
  const bad = [
    ['src/x.ts', "el.style.fontSize = '12px';", 'style fontSize'],
    ['src/x.ts', "el.style.setProperty('font-size', '12px');", 'setProperty font-size'],
    ['src/x.ts', "el.style.setProperty('--icon-size', '16px');", 'setProperty size'],
    ['src/x.ts', "Object.assign(el.style, { fontSize: '13px' });", 'assign fontSize'],
    ['src/not-terminal.ts', 'node.options.fontSize = 14;', 'xterm outside terminal'],
    ['src/trace-brands.ts', `const html = '<div style="font-size:12px"></div><svg><text font-size="10">brand</text></svg>';`, 'svg does not hide style'],
    ['src/x.ts', "el.style.font = '13px sans-serif';", 'style font'],
    ['src/x.ts', "el.style.fontFamily = 'Arial';", 'style fontFamily'],
    ['src/x.ts', "el.style['fontSize'] = '13px';", 'bracket fontSize'],
    ['src/x.ts', "el.style.setProperty('font-family', 'Arial');", 'setProperty family'],
    ['src/x.ts', "el.style.setProperty('--sans', 'Georgia');", 'setProperty sans'],
    ['src/x.ts', 'const node = { style: { fontSize: \'13px\' } };', 'style object'],
    ['src/preview.ts', "const css = '.a{font-size:13px}';", 'preview css'],
    ['src/x.ts', '`<svg><foreignObject><div style="font-size:12px"></div></foreignObject></svg>`', 'foreignObject style'],
    ['src/x.ts', "const st = el.style; st.fontSize = '12px';", 'style alias'],
    ['src/x.ts', "el.style.fontSize = cond ? '12px' : '14px';", 'ternary fontSize'],
    ['src/x.ts', "el.style.fontSize = cond ? 'var(--type-body)' : 'var(--type-meta)';", 'ternary var fontSize'],
    ['src/x.ts', "el.style.fontSize = size + 'px';", 'concat fontSize'],
    ['src/x.ts', "el.style.setProperty('font-size', size);", 'setProperty variable'],
    ['src/x.ts', "const {style} = el; style.fontSize = '12px';", 'destructured style'],
    ['src/x.ts', "el.style['font-size'] = '13px';", 'kebab font-size'],
    ['src/x.ts', "el.style[prop] = '12px';", 'computed style key'],
    ['src/x.ts', "const {style} = el; style[prop] = '7px';", 'destructured computed key'],
    ['src/x.ts', "el.attributeStyleMap.set('font-size', '12px');", 'attributeStyleMap font-size'],
    ['src/x.ts', '`<div style="font-size:${x}"></div>`', 'interpolated inline font-size'],
    ['src/x.ts', '`<div style="font-size:var(${x})"></div>`', 'interpolated var without dashes'],
    ['src/x.ts', "el.style.cssText = 'font-size:12px';", 'cssText literal font-size'],
    ['src/x.ts', "const st = el.style; st.cssText = 'font-size:12px';", 'aliased cssText literal'],
    ['src/x.ts', "Object.assign(el.style, { cssText: 'font-size:12px' });", 'assign cssText literal'],
    ['src/x.ts', 'el.style.cssText = dynamicCss;', 'cssText dynamic expr'],
    ['src/x.ts', "el.style.cssText = 'font-size:' + size;", 'cssText concat expr'],
    ['src/x.ts', "el.style.cssText = 'font-size:' + '12px';", 'cssText string concat'],
    ['src/x.ts', 'el.style.cssText = `font-size:${size}px`;', 'cssText template font-size'],
    ['src/x.ts', 'el.style.cssText = `${prop}:12px`;', 'cssText template dynamic prop'],
    ['src/x.ts', 'el.style.cssText = `color:red;${extra}`;', 'cssText template dynamic fragment'],
    ['src/x.ts', "el.setAttribute('style', 'font-size:12px');", 'setAttribute style literal'],
    ['src/x.ts', 'el.setAttribute(\'style\', css);', 'setAttribute style dynamic expr'],
    ['src/x.ts', "const css = '.a{FONT-SIZE:13px}';", 'ts string uppercase FONT-SIZE'],
    ['src/x.ts', "const esc = s => s.replace(/[&<>\"']/g, ''); const html = '<div style=\"font-size:12px\"></div>';", 'regex quote does not blind string scan'],
    ['src/x.ts', "const re = /'/g; el.style.fontSize = '12px';", 'regex quote does not blind style api'],
    ['src/x.ts', "const html = `<div>${fn({ a: '}' })}</div><div style=\"font-size:12px\"></div>`;", 'nested brace inside template expr'],
    ['src/x.ts', "const s = 'style=\"font-size:12px\"';", 'style attr at start of string double quotes'],
    ['src/x.ts', "el.style.setProperty(dynProp, '12px');", 'dynamic setProperty literal px'],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--type-body) 12px');", 'dynamic setProperty trailing literal'],
    ['src/x.ts', 'el.style.setProperty(dynProp, `${size}px`);', 'dynamic setProperty px template'],
    ['src/x.ts', "el.style.setProperty(dynProp, size + 'px');", 'dynamic setProperty px concat'],
    ['src/x.ts', "const p = 'font-size'; el.style.setProperty(p, size);", 'const-resolved setProperty dynamic rhs'],
    ['src/x.ts', "el.attributeStyleMap.set(dynProp, '12px');", 'dynamic attributeStyleMap literal px'],
    ['src/x.ts', "el.style[prop] = 'var(--type-body) 12px';", 'computed style key trailing literal after var'],
    ['src/x.ts', "el.style.fontSize = 'var(--root-size)';", 'ts style.fontSize root-size'],
    ['src/x.ts', "const s = { fontSize: '12px' }; Object.assign(el.style, s);", 'ts indirect Object.assign style object'],
    ['src/x.ts', "Object.assign(el.style, opaqueStyle);", 'ts opaque Object.assign style identifier'],
    ['src/x.ts', "Object.assign(el.style, cond ? { fontSize: '12px' } : {});", 'ts conditional Object.assign style'],
    ['src/x.ts', "Object.assign(el.style, { ...{ fontSize: '12px' } });", 'ts spread literal in Object.assign style'],
    ['src/x.ts', "Object.assign(el.style, { ...opaqueStyle });", 'ts opaque spread in Object.assign style'],
    ['src/x.ts', "Object.assign(el.style, { ['font' + 'Size']: '12px' });", 'ts computed concat key in Object.assign style'],
    ['src/x.ts', "Object.assign(el.style, { [dynKey]: '12px' });", 'ts dynamic computed key in Object.assign style'],
    ['src/x.ts', "let p = 'font-size'; let v = '12px'; el.style.setProperty(p, v);", 'ts let-bound setProperty'],
    ['src/x.ts', '`<svg><style>.card { font-size: 12px; }</style></svg>`', 'svg style block scanned'],
    ['src/x.ts', '`<svg><text style="font-size:12px">P</text></svg>`', 'svg inline style attribute scanned'],
    ['src/x.ts', '`<svg><text font-size="11">1</text></svg>`', 'svg text literal font-size attribute'],
    ['src/x.ts', `const pin = '<text x="1" font-size="11px">1</text>';`, 'svg text fragment literal px font-size'],
    ['src/x.ts', "`<svg viewBox='0 0 10 10'><text><tspan font-size='9'>1</tspan></text></svg>`", 'svg tspan literal font-size'],
    ['src/trace-brands.ts', '`<svg><text font-size="12">P</text></svg>`', 'svg text literal outside the exact allowlisted value'],
    ['src/x.ts', '`<div style=font-size:12px></div>`', 'unquoted html style attribute'],
    ['src/x.ts', '`<div style="${p}:12px"></div>`', 'split-prop template style attribute'],
    ['src/x.ts', 'const css = ".a { font-\\\\73 ize: 12px }";', 'ts string css hex escape font-size'],
    ['src/x.ts', 'const css = "@font-face { src: url(x.woff2); }";', 'ts string @font-face without font-family'],
    ['src/x.ts', "const css = '.card { font-size: 99px;' + '}';", 'ts + folded split css string'],
    ['src/x.ts', "const html = '<div style=\"font-size:12px;' + 'color:red\"></div>';", 'ts + folded split html style attr'],
    ['src/x.ts', "const html = '<div style=\"font-size:' + size + 'px\"></div>';", 'ts + folded dynamic html style attr'],
    ['src/x.ts', "el.style.zoom = '1.5';", 'ts style.zoom literal'],
    ['src/x.ts', 'el.style.zoom = 2;', 'ts style.zoom numeric'],
    ['src/x.ts', "el.style.setProperty('zoom', '1.5');", 'ts setProperty zoom'],
    ['src/x.ts', 'el.style.fontVariationSettings = \'"wght" 700\';', 'ts style.fontVariationSettings wght'],
    ['src/x.ts', 'el.style.setProperty(\'font-variation-settings\', \'"wght" 700\');', 'ts setProperty font-variation-settings wght'],
    ['src/x.ts', "el.style[prop] = 'var(--type-heading)';", 'computed style strict heading token'],
    ['src/x.ts', "el.style[prop] = 'var(--root-size)';", 'computed style root-size token'],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--type-heading)');", 'dynamic setProperty strict heading token'],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--root-size)');", 'dynamic setProperty root-size token'],
    ['src/x.ts', 'const set = (el, p, v) => el.style.setProperty(p, v);', 'unallowlisted dynamic setProperty'],
    ['src/x.ts', 'const set = (el, p, v) => el.attributeStyleMap.set(p, v);', 'unallowlisted dynamic attributeStyleMap.set'],
    ['src/x.ts', "for (const { style } of els) { style.fontSize = '12px'; }", 'for-of destructured style alias'],
    ['src/x.ts', "els.forEach(({ style }) => { style.fontSize = '12px'; });", 'parameter destructured style alias'],
    ['src/x.ts', '`<div style="${css}"></div>`', 'dynamic html style attr bare expr'],
    ['src/x.ts', '`<div style="color:red;${extra}"></div>`', 'dynamic html style attr trailing expr'],
    ['src/x.ts', '`<style>${css}</style>`', 'dynamic style tag bare expr'],
    ['src/x.ts', '`<style>.a { ${decl} }</style>`', 'dynamic style tag block bare expr'],
    ['src/x.ts', '`<style>.a { color: red; } ${extra}</style>`', 'dynamic style tag trailing top-level expr'],
    ['src/x.ts', 'sheet.replaceSync(`.a { ${prop}: 12px }`);', 'replaceSync dynamic prop'],
    ['src/x.ts', 'sheet.replaceSync(`.a { font-${x}: 12px }`);', 'replaceSync split dynamic prop'],
    ['src/x.ts', 'sheet.replaceSync(`.a { ${decl} }`);', 'replaceSync bare dynamic decl'],
    ['src/x.ts', 'sheet.replaceSync(dynamicCss);', 'replaceSync dynamic identifier'],
    ['src/x.ts', 'const css = `.a { ${prop}: 12px }`;', 'embeddedChunks rest dynamic prop'],
    ['src/x.ts', 'const css = `.a { font-${x}: 12px }`;', 'embeddedChunks rest split dynamic prop'],
    ['src/x.ts', 'const css = `.a { ${decl} }`;', 'embeddedChunks rest bare dynamic decl'],
    ['src/x.ts', "h('div', { style: dynamicCss });", 'style property dynamic identifier'],
    ['src/x.ts', "h('div', { style: `${prop}:12px` });", 'style property dynamic prop template'],
    ['src/x.ts', "h('div', { style: 'font-size:12px' });", 'style property literal css string'],
    ['src/x.ts', "const c = 'font-size:12px'; h('div', { style: c });", 'style property const-bound css string'],
    ['src/x.ts', "el.style.fontSize ||= '12px';", 'logical or-assign fontSize'],
    ['src/x.ts', 'el.style.cssText ||= dynamicCss;', 'logical or-assign cssText dynamic'],
    ['src/x.ts', "el.style.cssText ??= 'font-size:12px';", 'logical nullish-assign cssText literal'],
    ['src/x.ts', "el.style['font-size'] ||= '12px';", 'logical or-assign bracket font-size'],
    ['src/x.ts', "el.style['FONT-SIZE'] = '12px';", 'uppercase kebab bracket font-size'],
    ['src/x.ts', "el.style.setProperty('font-\\\\73 ize', '12px');", 'setProperty CSS-escaped font-size'],
    ['src/x.ts', "el.style.setProperty('--\\\\74 ype-body', '1rem');", 'setProperty CSS-escaped canonical token'],
    ['src/x.ts', "const m = el.attributeStyleMap; m.set('font-size', '12px');", 'aliased attributeStyleMap font-size'],
    ['src/x.ts', "(cond ? a.style : b.style).fontSize = '12px';", 'ternary non-identifier style receiver'],
    ['src/x.ts', "styles[0].fontSize = '12px';", 'indexed styles array receiver'],
    ['src/x.ts', "el.setAttributeNS(null, 'style', 'font-size:12px');", 'setAttributeNS style literal'],
    ['src/x.ts', "el.setAttributeNS(null, 'style', css);", 'setAttributeNS style dynamic'],
    ['src/x.ts', "Reflect.set(el.style, 'fontSize', '12px');", 'Reflect.set style fontSize literal'],
    ['src/x.ts', "Reflect.set(el.style, 'cssText', dynamicCss);", 'Reflect.set style cssText dynamic'],
    ['src/x.tsx', "const view = <div />; el.style.fontSize = '12px';", 'tsx file scanned'],
    ['src/x.tsx', 'const el = <div style={{ fontSize: `${sz}px` }} />;', 'TSX JsxAttribute style template'],
    ['src/x.tsx', 'const el = <div style={css} />;', 'TSX JsxAttribute dynamic style'],
    ['src/x.ts', 'function paint(style: CSSStyleDeclaration) { style.fontSize = "12px"; }', 'typed CSSStyleDeclaration param'],
    ['src/x.ts', 'function paint(map: StylePropertyMap) { map.set("font-size", "12px"); }', 'typed StylePropertyMap param'],
    ['src/x.ts', 'function paint(s) { s.fontSize = "12px"; } paint(el.style);', 'call-site propagated style param'],
    ['src/x.ts', 'sheet.replace(".a{font-size:12px}");', 'sheet.replace literal'],
    ['src/x.ts', 'sheet.replace(dynamicCss);', 'sheet.replace dynamic'],
    ['src/x.ts', "el.style['setProperty']('font-size', size);", 'bracket setProperty'],
    ['src/x.ts', 'const style = dynamicCss; h("div", { style });', 'shorthand { style } dynamic css'],
    ['src/x.ts', 'el.attributeStyleMap.append("font-size", "12px");', 'attributeStyleMap.append font-size'],
    ['src/x.ts', 'type S = CSSStyleDeclaration; function paint(s: S) { s.fontSize = "12px"; }', 'type alias CSSStyleDeclaration param'],
    ['src/x.ts', 'class A { s!: CSSStyleDeclaration; paint() { this.s.fontSize = "12px"; } }', 'typed class property CSSStyleDeclaration'],
    ['src/x.ts', 'class A { m!: StylePropertyMap; paint() { this.m.set("font-size", "12px"); } }', 'typed class property StylePropertyMap'],
    ['src/x.ts', 'function getStyle(): CSSStyleDeclaration { return el.style; } getStyle().fontSize = "12px";', 'direct call returning CSSStyleDeclaration'],
    ['src/x.ts', 'const getMap = (): StylePropertyMap => el.attributeStyleMap; getMap().append("font-size", "12px");', 'arrow returning StylePropertyMap'],
  ];
  for (const [file, text, label] of bad) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.ts', "el.style.fontSize = 'var(--type-body)';"],
    ['src/x.ts', "el.style.fontSize = '';"],
    ['src/x.ts', "el.style[prop] = '';"],
    ['src/x.ts', "el.style.setProperty('font-size', '');"],
    ['src/x.ts', "el.style.setProperty(dynProp, '');"],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--type-body)');"],
    ['src/x.ts', "const ROOM = '--toast-room'; el.style.setProperty(ROOM, value);"],
    ['src/x.ts', "const esc = s => s.replace(/[&<>\"']/g, ''); const html = '<div style=\"font-size:var(--type-body)\"></div>';"],
    ['src/x.ts', "const s = 'style=\"font-size:var(--type-body)\"';"],
    ['src/x.ts', "const st = el.style; st.fontSize = 'var(--type-body)';"],
    ['src/x.ts', "el.style.setProperty('font-size', 'var(--type-meta)');"],
    ['src/x.ts', "el.style.setProperty('--tail-room', `${'${room}'}px`);"],
    ['src/preview.ts', "el.style.fontSize = '12px';"],
    ['src/terminal.ts', 'terminal.options.fontSize = 12 * textScale();'],
    ['src/sketch.ts', 'area.style.fontSize = `${Math.max(12, shape.fontSize * scale)}px`;'],
    ['src/x.ts', '`<svg viewBox="0 0 ${W} ${H}"><text class="pp-pin-n" font-size="${n(pinSize * s)}">1</text></svg>`'],
    ['src/x.ts', '`<svg><text font-size="var(--type-caption)">1</text></svg>`'],
    ['src/x.ts', 'const shot = `<svg xmlns="http://www.w3.org/2000/svg" width="320" height="200"><text font-size="14">shot.png</text></svg>`; img.src = `data:image/svg+xml;base64,${btoa(shot)}`;'],
    ['src/x.ts', "el.style.fontFamily = 'var(--sans)';"],
    ['src/x.ts', "el.style['fontSize'] = 'var(--type-body)';"],
    ['src/x.ts', "el.style.setProperty('--ui-scale', '1.1');"],
    ['src/x.ts', "el.style.setProperty('font-family', 'var(--mono)');"],
    ['src/x.ts', 'el.animate([{ opacity: 0, transform: "translateY(4px)" }]);'],
    ['src/preview.ts', "el.style.fontSize = '12px';"],
    ['src/x.ts', '`<svg><text font-size="${n(size)}">P</text><foreignObject><div style="font-size:var(--type-meta)"></div></foreignObject></svg>`'],
    ['src/x.ts', "const {style} = el; style.fontSize = 'var(--type-body)';"],
    ['src/x.ts', "el.style['font-size'] = 'var(--type-body)';"],
    ['src/x.ts', "el.style[prop] = 'var(--type-body)';"],
    ['src/x.ts', "el.attributeStyleMap.set('font-size', 'var(--type-body)');"],
    ['src/x.ts', "el.attributeStyleMap.set('width', '12px');"],
    ['src/x.ts', "el.style.fontSize = 'unset';"],
    ['src/x.ts', "el.style.fontFamily = 'inherit';"],
    ['src/x.ts', "el.style.cssText = '';"],
    ['src/x.ts', 'el.style.cssText = `display:block;left:${x}px;width:${w}px`;'],
    ['src/x.ts', "el.setAttribute('style', '');"],
    ['src/token-saver-panel.ts', "levels.setAttribute('style', thumbAt);"],
    ['src/generative-ui-components.ts', "element.setAttribute('style', scrubCss(value));"],
    ['src/x.ts', "el.style.setProperty('font-size', 'inherit');"],
    ['src/x.ts', '`<div style="font-size:var(--type-body);color:${color}"></div>`'],
    ['src/x.ts', "const kf = [{ opacity: 0 }, { opacity: 1 }]; el.animate(kf);"],
    ['src/x.ts', "const css = '.card { font-size: var(--type-body);' + '}';"],
    ['src/x.ts', "el.style.zoom = '1';"],
    ['src/x.ts', "el.style.zoom = '100%';"],
    ['src/x.ts', 'el.style.fontVariationSettings = \'"opsz" 14\';'],
    ['src/tray-popover.ts', 'for (const [name, value] of Object.entries(tokens)) root.style.setProperty(name, value);'],
    ['src/x.ts', "for (const { style } of els) { style.fontSize = 'var(--type-body)'; }"],
    ['src/bot-avatars.ts', '`<button style="${fill}"></button>`'],
    ['src/progress-marks.ts', '`<g style="${order}"></g>`'],
    ['src/x.ts', "const FRAME = ':host{display:block}'; shadow.innerHTML = `<style>${FRAME}</style>`;"],
    ['src/x.ts', "import css from './a.css?inline'; sheet.replaceSync(css);"],
    ['src/x.ts', "sheet.replaceSync('.a { font-size: var(--type-body); }');"],
    ['src/x.ts', "new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD' });"],
    ['src/x.ts', "h('span', { style: `width:${percent}%` });"],
    ['src/x.ts', "h('div', { style: 'font-size:var(--type-body)' });"],
    ['src/x.ts', "el.style['FONT-SIZE'] = 'var(--type-body)';"],
    ['src/x.ts', "const m = el.attributeStyleMap; m.set('font-size', 'var(--type-body)');"],
    ['src/x.ts', "(cond ? a.style : b.style).fontSize = 'var(--type-body)';"],
    ['src/x.ts', "styles[0].fontSize = 'var(--type-body)';"],
    ['src/x.ts', "el.setAttributeNS(null, 'style', 'font-size:var(--type-body)');"],
    ['src/x.ts', "Reflect.set(el.style, 'fontSize', 'var(--type-body)');"],
    ['src/x.ts', 'const style = { fontSize: "var(--type-body)" }; h("div", { style });'],
    ['src/x.ts', 'el.attributeStyleMap.append("font-size", "var(--type-body)");'],
    ['src/x.ts', 'type S = CSSStyleDeclaration; function paint(s: S) { s.fontSize = "var(--type-body)"; }'],
    ['src/x.ts', 'class A { s!: CSSStyleDeclaration; paint() { this.s.fontSize = "var(--type-body)"; } }'],
    ['src/x.ts', 'function getStyle(): CSSStyleDeclaration { return el.style; } getStyle().fontSize = "var(--type-body)";'],
  ];
  for (const [file, text, label] of good) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('TypeScript guard: type roles, leading and tracking', () => {
  const bad = [
    ['src/x.ts', "el.style.fontWeight = '700';", 'style fontWeight'],
    ['src/x.ts', "el.style.fontWeight = 'bold';", 'style bold'],
    ['src/x.ts', "el.style.lineHeight = '1.45';", 'style lineHeight'],
    ['src/x.ts', "el.style.letterSpacing = '.05em';", 'style letterSpacing'],
    ['src/x.ts', "el.style.setProperty('line-height', '1.4');", 'setProperty line-height'],
    ['src/x.ts', "el.style.setProperty('letter-spacing', '.02em');", 'setProperty tracking'],
    ['src/x.ts', 'el.style.fontWeight = 700;', 'numeric fontWeight'],
    ['src/x.ts', "el.style.setProperty('font-weight', '700');", 'setProperty weight'],
    ['src/x.ts', "el.style.setProperty('--type-body', '1rem');", 'setProperty role'],
    ['src/x.ts', 'el.style.lineHeight = leading;', 'variable lineHeight'],
    ['src/x.ts', "const {style: st} = el; st.fontWeight = '700';", 'renamed destructured style'],
    ['src/x.ts', "el.style.fontWeight = '600';", 'numeric string fontWeight'],
    ['src/x.ts', "el.style.setProperty('line-height', '1.5');", 'unitless non-1 line-height'],
    ['src/x.ts', "el.style.setProperty('font-weight', '600');", 'setProperty numeric weight'],
    ['src/x.ts', '`<div style="line-height:${lh}"></div>`', 'interpolated inline line-height'],
    ['src/x.ts', '`<div style="font-weight:${w}"></div>`', 'interpolated inline font-weight'],
    ['src/x.ts', "el.style['cssText'] = 'font-weight:700';", 'bracket cssText numeric weight'],
    ['src/x.ts', "const css = '.a{line-height:var(--leading-body)}';", 'ts string deprecated leading-body'],
    ['tests/x.spec.ts', "getPropertyValue('--leading-ui')", 'spec deprecated leading-ui'],
    ['tests/x.spec.ts', "getPropertyValue('--leading-tight')", 'spec deprecated leading-tight'],
    ['tests/x.spec.ts', "getPropertyValue('--leading-body')", 'spec deprecated leading-body'],
    ['src/x.ts', "`<div ${'style=\"font-size:12px\"'}></div>`", 'nested template string with leading style attr'],
    ['src/x.ts', "el.style.font = 'var(--type-heading) var(--sans)';", 'ts style.font checkPair and missing /line-height'],
    ['src/x.ts', "Object.assign(el.style, { fontSize: 'var(--type-body)', fontWeight: 'var(--weight-strong)' });", 'ts Object.assign checkPair body strong'],
    ['src/x.ts', "Object.assign(el.style, { fontSize: 'var(--type-body)' }, { fontWeight: 'var(--weight-strong)' });", 'ts multi-arg Object.assign checkPair body strong'],
    ['src/x.ts', "const node = { style: { fontSize: 'var(--type-body)', fontWeight: 'var(--weight-medium)' } };", 'ts style object checkPair body medium'],
    ['src/x.ts', "el.style.fontWeight = 'var(--type-heading-weight)';", 'ts style.fontWeight heading-weight without size'],
    ['src/x.ts', "el.style.lineHeight = 'var(--type-display-leading)';", 'ts style.lineHeight display-leading without size'],
    ['src/x.ts', "el.style.letterSpacing = 'var(--tracking-caps)';", 'ts style.letterSpacing tracking-caps without uppercase'],
    ['src/x.ts', "el.style[prop] = 'var(--type-display-leading)';", 'computed style display-leading token'],
    ['src/x.ts', "el.style[prop] = 'var(--weight-strong)';", 'computed style weight-strong token'],
    ['src/x.ts', "function paint({ style: st }) { st.fontWeight = '700'; }", 'function parameter renamed style alias'],
    ['src/x.ts', "el.style.fontSize = 'var(--type-body)'; el.style.fontWeight = 'var(--weight-medium)';", 'sequential block pairing body medium'],
    ['src/x.ts', "const st = el.style; st.fontSize = 'var(--type-body)'; st.setProperty('font-weight', 'var(--weight-strong)');", 'sequential block pairing via setProperty body strong'],
    ['src/x.ts', "el.style.fontWeight &&= '700';", 'logical and-assign fontWeight'],
    ['src/x.ts', "(el.style.fontSize = 'var(--type-body)', el.style.fontWeight = 'var(--weight-medium)');", 'sequential pairing inside comma expression'],
    ['src/x.ts', "const f = () => (el.style.fontSize = 'var(--type-body)', el.style.fontWeight = 'var(--weight-medium)');", 'sequential pairing inside arrow comma expression'],
    ['src/x.ts', "el.style.fontSize = 'var(--type-body)'; if (cond) el.style.fontWeight = 'var(--weight-medium)';", 'sequential pairing across if-guarded statement'],
    ['src/x.ts', "el.style.fontSize = 'var(--type-body)'; if (cond) { el.style.fontWeight = 'var(--weight-medium)'; }", 'sequential pairing across if-guarded block'],
    ['src/x.ts', "if (cond) el.style.fontSize = 'var(--type-body)'; el.style.fontWeight = 'var(--weight-medium)';", 'sequential pairing from if branch into following statement'],
    ['src/x.ts', "Reflect.set(el.style, 'fontSize', 'var(--type-body)'); Reflect.set(el.style, 'fontWeight', 'var(--weight-medium)');", 'Reflect.set sequential pairing body medium'],
    ['src/x.ts', 'el.attributeStyleMap.append("font-size", "var(--type-body)"); el.attributeStyleMap.append("font-weight", "var(--weight-medium)");', 'attributeStyleMap.append sequential pairing'],
  ];
  for (const [file, text, label] of bad) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.ts', "el.style.lineHeight = 'var(--type-body-leading)';"],
    ['src/x.ts', "const plain = style.letterSpacing === 'normal';"],
    ['src/trace-brands.ts', '`<svg><text font-size="10.5" font-weight="700" font-family="system-ui,sans-serif">P</text></svg>`'],
    ['src/x.ts', "el.style.font = 'var(--weight-regular) var(--type-body)/var(--type-body-leading) var(--sans)';"],
    ['src/x.ts', "el.style.setProperty('font-weight', 'var(--weight-medium)');"],
    ['src/x.ts', "el.style.lineHeight = '1';"],
    ['src/x.ts', "el.style.lineHeight = 'normal';"],
    ['src/x.ts', "el.style.lineHeight = '0';"],
    ['src/x.ts', "el.style.fontWeight = 'normal';"],
    ['src/x.ts', "el.style.fontWeight = 'inherit';"],
    ['src/x.ts', "el.style.letterSpacing = '0';"],
    ['src/x.ts', "el.style.letterSpacing = 'normal';"],
    ['src/x.ts', "el.style.letterSpacing = 'inherit';"],
    ['src/x.ts', "el.style.setProperty('letter-spacing', 'unset');"],
    ['src/x.ts', "el.style.cssText = 'color:var(--muted);font-size:var(--type-caption);line-height:var(--type-caption-leading)';"],
    ['src/x.ts', "el.style.setProperty('line-height', '1');"],
    ['src/x.ts', "el.style.setProperty('line-height', 'normal');"],
    ['src/x.ts', "el.style.setProperty('font-weight', 'unset');"],
    ['src/x.ts', "el.attributeStyleMap.set('line-height', 'normal');"],
    ['src/x.ts', "Object.assign(el.style, { fontSize: 'var(--type-heading)', fontWeight: 'var(--type-heading-weight)', lineHeight: 'var(--type-heading-leading)', letterSpacing: 'var(--tracking-tight)' });"],
    ['src/x.ts', "Object.assign(el.style, { fontSize: 'var(--type-caption)', lineHeight: 'var(--type-caption-leading)', fontWeight: 'var(--weight-strong)', textTransform: 'uppercase', letterSpacing: 'var(--tracking-caps)' });"],
    ['src/x.ts', "el.style.fontSize = 'var(--type-heading)'; el.style.fontWeight = 'var(--type-heading-weight)'; el.style.lineHeight = 'var(--type-heading-leading)'; el.style.letterSpacing = 'var(--tracking-tight)';"],
    ['src/x.ts', "const st = el.style; el.style.fontSize = 'var(--type-heading)'; st.fontWeight = 'var(--type-heading-weight)'; st.lineHeight = 'var(--type-heading-leading)'; el.style.letterSpacing = 'var(--tracking-tight)';"],
    ['src/x.ts', "(el.style.fontSize = 'var(--type-subheading)', el.style.fontWeight = 'var(--type-subheading-weight)');"],
    ['src/x.ts', "if (cond) { el.style.fontSize = 'var(--type-heading)'; el.style.fontWeight = 'var(--type-heading-weight)'; el.style.lineHeight = 'var(--type-heading-leading)'; el.style.letterSpacing = 'var(--tracking-tight)'; } else { el.style.fontSize = 'var(--type-body)'; el.style.lineHeight = 'var(--type-body-leading)'; }"],
  ];
  for (const [file, text, label] of good) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('TypeScript guard: radius, corners and nesting', () => {
  const bad = [
    ['src/x.ts', "el.style.borderRadius = '7px';", 'style borderRadius'],
    ['src/x.ts', "el.style.setProperty('border-top-left-radius', '4px');", 'setProperty longhand'],
    ['src/x.ts', "el.style.setProperty('--card-radius', '8px');", 'setProperty radius'],
    ['src/x.ts', "Object.assign(el.style, { borderRadius: '8px', color: 'red' });", 'assign radius'],
    ['tests/x.spec.ts', "getPropertyValue('--ds-radius-inner')", 'spec alias'],
    ['src/x.ts', "el.style.borderTopLeftRadius = '7px';", 'radius longhand'],
    ['src/x.ts', "el.animate([{ borderRadius: '7px' }]);", 'animate radius'],
    ['src/x.ts', 'Object.assign(plate.style, { borderRadius: getComputedStyle(dialog).borderRadius });', 'computed radius'],
    ['src/x.ts', "const s = el.style; s['border-radius'] = '8px';", 'kebab radius'],
    ['src/x.ts', "el.attributeStyleMap.set('border-radius', '8px');", 'attributeStyleMap radius'],
    ['src/x.ts', "el.style.setProperty('border-radius', '12px');", 'setProperty px radius'],
    ['src/x.ts', '`<div style="border-radius:${r}"></div>`', 'interpolated inline border-radius'],
    ['src/x.ts', "el.style.setProperty('--my-radius', 'var(--radius-card)');", 'setProperty unapproved radius alias'],
    ['src/x.ts', "el.style.setProperty('--inset-radius', 'var(--radius-card)');", 'setProperty inset-radius wrong owner'],
    ['src/x.ts', "el.style.cssText += 'border-radius:7px';", 'cssText append literal radius'],
    ['src/x.ts', "el.setAttribute('STYLE', 'border-radius:8px');", 'setAttribute STYLE uppercase literal'],
    ['src/x.ts', 'el.setAttribute(\'style\', `border-radius:${r}`);', 'setAttribute style template radius'],
    ['src/x.ts', "const s = \"style='border-radius:7px'\";", 'style attr at start of string single quotes'],
    ['src/x.ts', "const st = el.style; Object.assign(st, { fontSize: '12px', borderRadius: '7px' });", 'Object.assign on style alias'],
    ['src/x.ts', "const { style } = el; Object.assign(style, { borderRadius: '7px' });", 'Object.assign on destructured style alias'],
    ['src/x.ts', "el.style.clipPath = 'inset(0 round 8px)';", 'style clipPath literal px round'],
    ['src/x.ts', "el.style.clipPath = 'inset(0 round var(--row))';", 'style clipPath non-radius var round'],
    ['src/x.ts', 'el.style.clipPath = `inset(0 round ${r}px)`;', 'style clipPath template round'],
    ['src/x.ts', "el.style.setProperty('clip-path', 'inset(0 round 8px)');", 'setProperty clip-path literal round'],
    ['src/x.ts', "el.style.borderTopLeftRadius = 'var(--radius-inner)';", 'style physical corner longhand'],
    ['src/x.ts', "el.style.borderRadius = 'var(--radius-card, var(--totally-undefined))';", 'style nested undefined var fallback'],
    ['src/x.ts', "el.style.borderRadius = 'var(--radius-card, var(--type-body))';", 'style nested wrong-family var fallback'],
    ['src/x.ts', "el.style.borderRadius = 'var(--radius-card, var(bogus))';", 'style nested bogus var fallback'],
    ['src/x.ts', "el.style.borderRadius = 'var(--radius-card) / var(--radius-inner)';", 'style elliptical slash radius'],
    ['src/x.ts', "el.style.borderStartStartRadius = 'var(--ds-control-radius) var(--radius-chip)';", 'style two-axis elliptical corner'],
    ['src/x.ts', "el.style.setProperty('border-end-start-radius', 'var(--ds-control-radius) 0');", 'setProperty two-axis elliptical corner'],
    ['src/x.ts', "Object.assign(el.style, { borderEndEndRadius: '50% var(--radius-chip)' });", 'Object.assign two-axis elliptical corner'],
    ['src/x.ts', "el.style.cssText = 'border-start-end-radius:var(--ds-control-radius) var(--radius-chip)';", 'cssText two-axis elliptical corner'],
    ['src/x.ts', "const kf = [{ borderRadius: '7px' }]; el.animate(kf);", 'ts indirect animate keyframes'],
    ['src/x.ts', "el.style.webkitBorderRadius = '7px';", 'ts style.webkitBorderRadius literal'],
    ['src/x.ts', "el.style.webkitBorderTopLeftRadius = 'var(--radius-inner)';", 'ts style.webkitBorderTopLeftRadius physical corner'],
    ['src/x.ts', "el.style.setProperty('-webkit-border-radius', '7px');", 'ts setProperty -webkit-border-radius literal'],
    ['src/x.ts', "el.style[prop] = 'var(--icon-lg)';", 'computed style non-type/radius token'],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--icon-lg)');", 'dynamic setProperty non-type/radius token'],
    ['src/x.ts', "for (const { style: st } of els) { st.borderRadius = '8px'; }", 'for-of renamed destructured style alias'],
    ['src/x.ts', "h('div', { style: cond ? 'border-radius:8px' : undefined });", 'style property conditional literal css'],
    ['src/x.ts', "el.style.borderRadius ??= '8px';", 'logical nullish-assign borderRadius'],
    ['src/x.ts', "el.style.webkitClipPath = 'inset(0 round 8px)';", 'style webkitClipPath literal round'],
    ['src/x.ts', "el.style.WebkitClipPath = 'inset(0 round 8px)';", 'style WebkitClipPath literal round'],
    ['src/x.ts', "el.style.setProperty('-webkit-clip-path', 'inset(0 round 8px)');", 'setProperty -webkit-clip-path literal round'],
    ['src/x.ts', "el.style.webkitBorderBeforeLeftRadius = '8px';", 'style webkitBorderBeforeLeftRadius literal'],
    ['src/x.ts', "el.style.webkitBorderAfterRightRadius = 'var(--radius-inner)';", 'style webkitBorderAfterRightRadius physical'],
    ['src/x.ts', "el.style.setProperty('-webkit-border-before-left-radius', '8px');", 'setProperty -webkit-border-before-left-radius'],
    ['src/x.ts', "el.style['BORDER-RADIUS'] = '8px';", 'uppercase kebab bracket border-radius'],
    ['src/x.ts', "const { attributeStyleMap: m } = el; m.set('border-radius', '8px');", 'destructured attributeStyleMap border-radius'],
    ['src/x.ts', "const list = [el.style]; list[0].borderRadius = '8px';", 'tracked style collection indexed receiver'],
    ['src/x.ts', "Reflect.set(el.style, 'border-radius', '8px');", 'Reflect.set style kebab radius literal'],
    ['src/x.tsx', 'const el = <div style={{ fontSize: "12px", borderRadius: 8 }} />;', 'TSX JsxAttribute style object'],
    ['src/x.ts', 'sheet.insertRule(".a{border-radius:7px}");', 'sheet.insertRule literal'],
    ['src/x.mjs', "el.style.borderRadius = '8px';", 'mjs file scanned'],
    ['src/x.tsx', 'const el = <div style={{ "--card-radius": "8px" }} />;', 'TSX style object --card-radius literal'],
    ['src/x.tsx', 'const el = <div style={{ ["--card-" + "radius"]: "var(--radius-card)" }} />;', 'TSX style object computed unapproved radius alias'],
    ['src/x.ts', 'const style = { fontSize: "12px", borderRadius: "7px" }; h("div", { style });', 'shorthand { style } object literal'],
    ['src/x.ts', 'type A = CSSStyleDeclaration; type B = A | null; const s: B = get(); s.borderRadius = "8px";', 'chained type alias CSSStyleDeclaration var'],
    ['src/x.ts', 'type S = CSSStyleDeclaration; class A { s!: S; } const a = new A(); a.s.borderRadius = "8px";', 'typed class property via type alias'],
    ['src/x.ts', 'function getStyle(): CSSStyleDeclaration { return el.style; } const st = getStyle(); st.borderRadius = "8px";', 'variable from CSSStyleDeclaration return type'],
  ];
  for (const [file, text, label] of bad) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.ts', "el.style.borderRadius = '';"],
    ['src/x.ts', "const st = el.style; Object.assign(st, { fontSize: '', borderRadius: 'var(--ds-card-radius)' });"],
    ['src/x.ts', "el.style.clipPath = '';"],
    ['src/x.ts', "el.style.clipPath = 'inset(0 round var(--ds-card-radius))';"],
    ['src/x.ts', "el.style.clipPath = 'inset(50%)';"],
    ['src/x.ts', 'el.style.clipPath = `path("${d}")`;'],
    ['src/x.ts', 'el.style.setProperty(\'clip-path\', `inset(0 0 0 ${split}%)`);'],
    ['src/motion.ts', 'Object.assign(plate.style, { borderRadius: getComputedStyle(dialog).borderRadius });'],
    ['src/x.ts', "el.style.borderRadius = 'var(--ds-control-radius)';"],
    ['tests/x.spec.ts', "getPropertyValue('--radius-inner')"],
    ['src/x.ts', "el.animate([{ borderRadius: 'var(--ds-control-radius)' }]);"],
    ['src/x.ts', "const {style: st} = el; st['border-radius'] = 'var(--ds-control-radius)';"],
    ['src/x.ts', "const {style} = el; style[prop] = 'var(--ds-control-radius)';"],
    ['src/x.ts', "el.style.borderRadius = '50%';"],
    ['src/x.ts', "el.style.borderRadius = '0';"],
    ['src/x.ts', "el.style.borderRadius = 'inherit';"],
    ['src/x.ts', "el.setAttribute('style', 'color:var(--muted);border-radius:var(--ds-card-radius)');"],
    ['src/x.ts', "el.style.setProperty('border-radius', '50%');"],
    ['src/x.ts', "el.style.setProperty('border-radius', '0');"],
    ['src/x.ts', "el.attributeStyleMap.set('border-radius', '50%');"],
    ['src/x.ts', '`<div style="border-radius:var(--ds-control-radius);width:${w}px"></div>`'],
    ['src/x.ts', "el.style.webkitBorderRadius = 'var(--ds-card-radius)';"],
    ['src/x.ts', "els.forEach(({ style }) => { style.borderRadius = 'var(--ds-control-radius)'; });"],
    ['src/x.ts', "el.style.fontSize ||= 'var(--type-body)'; el.style.borderRadius ??= 'var(--ds-card-radius)';"],
    ['src/x.ts', "el.style.webkitClipPath = 'inset(0 round var(--ds-card-radius))';"],
  ];
  for (const [file, text, label] of good) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('TypeScript guard: token aliases and ownership', () => {
  const bad = [
    ['src/x.ts', "el.style[prop] = 'var(--not-a-token)';", 'computed key undefined var'],
    ['src/x.ts', "el.style[prop] = 'var(--bad, 12px)';", 'computed key literal fallback'],
    ['src/x.ts', "el.style[prop] = 'var(--type-body, 12px)';", 'computed key valid var with literal fallback'],
    ['src/x.ts', "const {style} = el; style[prop] = 'var(--bad, 12px)';", 'destructured computed key literal fallback'],
    ['src/x.ts', '`<div style="font-size:var(--type-body, ${x})"></div>`', 'interpolated var fallback'],
    ['src/x.ts', "el.style.setProperty('--ds-btn-h', '40px');", 'setProperty locked ds-btn-h'],
    ['src/x.ts', "el.style.setProperty('--ds-btn-primary-h', '40px');", 'setProperty locked ds-btn-primary-h'],
    ['src/x.ts', "el.style.setProperty('--ds-row-h', '50px');", 'setProperty locked ds-row-h'],
    ['src/x.ts', "el.style.setProperty('--ds-row-h-sub', '52px');", 'setProperty locked ds-row-h-sub'],
    ['src/x.ts', "el.attributeStyleMap.set('--ds-row-h', '50px');", 'attributeStyleMap locked ds-row-h'],
    ['src/x.ts', "el.attributeStyleMap.set('--ds-btn-h', '40px');", 'attributeStyleMap locked ds-btn-h'],
    ['src/x.ts', "const css = ':root{--sans:Georgia}';", 'ts string redefine sans'],
    ['src/x.ts', "const css = ':root{--mono:monospace}';", 'ts string redefine mono'],
    ['src/x.ts', "const css = ':root{--ds-btn-h:40px}';", 'ts string redefine ds-btn-h'],
    ['src/x.ts', "const css = ':root{--type-body:2rem}';", 'ts string redefine type-body'],
    ['src/x.ts', "const css = ':root{--row:30px}';", 'ts string redefine row'],
    ['src/x.ts', "`<div style=\"font-size:var(--type-body${', 12px'})\"></div>`", 'interpolated var fallback hole closed'],
    ['src/x.ts', "el.style.setProperty(dynProp, 'var(--not-a-token)');", 'dynamic setProperty undefined var'],
    ['src/x.ts', "el.style[prop] = 'var(--ds-card)';", 'computed style key non-locked design-system var'],
    ['src/x.ts', "el.style.font = 'var(--weight-strong, var(--weight-medium)) var(--type-body)/var(--type-body-leading) var(--sans)';", 'style font shorthand weight fallback'],
    ['src/x.ts', '`<svg><text font-size="var(--type-caption, 11px)">1</text></svg>`', 'svg text literal fallback'],
    ['src/x.ts', "const st = el.style; el.style.fontSize = 'var(--type-body)'; st.fontWeight = 'var(--weight-medium)';", 'sequential pairing merges alias back to el.style'],
    ['src/x.ts', "const { style: st } = el; el.style.fontSize = 'var(--type-body)'; st.fontWeight = 'var(--weight-strong)';", 'sequential pairing merges destructured alias back to el.style'],
    ['src/x.tsx', 'const el = <div style={{ "--type-body": "2rem" }} />;', 'TSX style object --type-body redefinition'],
    ['src/x.tsx', 'const el = <div style={{ "--ds-btn-h": "40px" }} />;', 'TSX style object --ds-btn-h redefinition'],
    ['src/x.ts', 'el.animate([{ "--type-body": "2rem" }]);', 'WAAPI animate --type-body redefinition'],
    ['src/x.ts', 'el.animate({ "--ds-btn-h": ["36px", "40px"] });', 'WAAPI animate property-indexed --ds-btn-h'],
    ['src/x.ts', 'const n = { style: { "--type-body": "2rem" } };', 'style object --type-body redefinition'],
    ['src/x.ts', 'el.attributeStyleMap.append("--ds-btn-h", "40px");', 'attributeStyleMap.append locked ds-btn-h'],
    ['src/x.ts', 'type M = StylePropertyMap; function paint(m: M) { m.append("font-size", "12px"); }', 'type alias StylePropertyMap param'],
  ];
  for (const [file, text, label] of bad) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.ok(hits.length, `${label || text}: ${hits.join(' | ')}`);
  }
  const good = [
    ['src/x.ts', "el.style.setProperty('--ds-avatar', 'red');"],
    ['src/x.ts', "h('div', { style: cond ? `--gu-columns:${n}` : undefined });"],
    ['src/x.tsx', 'const el = <div style={{ "--ds-avatar": "red" }} />;'],
  ];
  for (const [file, text, label] of good) {
    const hits = file.endsWith('.spec.ts') ? specAliasProblems(file, text) : scanTsFile(file, text);
    assert.equal(hits.join('\n'), '', text);
  }
});

test('token resolution and canvas classification reject hidden literals', () => {
  assert.equal(valueResolves('var(--radius-card)', '--inset-radius', new Map()), true);
  assert.equal(valueResolves('0px', '--inset-radius', new Map()), true);
  assert.equal(valueResolves('13px', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--row)', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--type-body)', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--type-prose)', '--thread-font', new Map()), true);
  assert.equal(valueResolves('var(--radius-card)', '--thread-font', new Map()), false);
  assert.equal(valueResolves('var(--icon-lg)', '--thread-font', new Map()), false);
  assert.equal(valueResolves('0px', '--thread-font', new Map()), false);
  assert.equal(valueResolves('var(--radius-card,var(--x,7px))', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--radius-card,var(--totally-undefined))', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--radius-card,var(--type-body))', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('var(--radius-card,var(bogus))', '--inset-radius', new Map()), false);
  assert.equal(valueResolves('.9', '--trace-mono-scale', new Map()), false);
  assert.equal(canonical.has('--ds-btn-h'), true);
  assert.equal(canonical.has('--ds-card'), false);
  assert.equal(isPreview('src/preview-design.ts'), true);
  assert.equal(isPreview('src/bots.ts'), false);
  assert.equal(isCanvas('ctx.font = '), false, 'canvas font strings are checked, not skipped');
  assert.equal(isCanvas('ctx.fillText('), true);
});

test('style API usage tracking and nested scopes preserve guard diagnostics', () => {
  const sample = (file, css) => scanCss(file, css, new Set(), new Map(), new Set());
  const tsUsed = new Set();
  const tsAliasUsed = new Set();
  assert.deepEqual(scanTsFile('src/x.ts', "el.style.lineHeight = 'var(--row)'; el.style.borderRadius = 'var(--inset-radius)';", tsUsed, new Map(), tsAliasUsed), []);
  assert.equal(tsUsed.has('rowlead:--row'), true, 'TS style records rowlead');
  assert.equal(tsAliasUsed.has('--inset-radius'), true, 'TS style records aliasUsed');
  const scopeHits = sample('src/x.css', '@scope (.card){@media (min-width:1px){font-size:12px;border-radius:7px;--ds-btn-h:99px}}');
  assert.ok(scopeHits.some(hit => hit.includes('font-size: literal 12px')), scopeHits.join(' | '));
  assert.ok(scopeHits.some(hit => hit.includes('border-radius: literal radius 7px')), scopeHits.join(' | '));
  assert.ok(scopeHits.some(hit => hit.includes('redefines canonical token --ds-btn-h')), scopeHits.join(' | '));
});

test('inline HTML <script> blocks and event handlers are scanned for style API violations', () => {
  assert.ok(scanHtml('index.html', '<script>el.style.fontSize = "12px";</script>').length > 0, 'classic inline script');
  assert.ok(scanHtml('index.html', '<script type="module">el.style.borderRadius = "8px";</script>').length > 0, 'module inline script');
  assert.ok(scanHtml('index.html', '<script type="text/javascript; charset=utf-8">el.style.fontSize = "12px";</script>').length > 0, 'script MIME parameters stripped');
  assert.ok(scanHtml('index.html', '<div onclick="el.style.fontSize=\'12px\'"></div>').length > 0, 'inline HTML event handler');
  assert.ok(scanHtml('index.html', '<button onclick="(() => { this.style.fontSize = \'12px\'; })()"></button>').length > 0, 'arrow function > inside quoted onclick');
  assert.ok(scanHtml('index.html', '<button title="a > b" onclick="this.style.fontSize=\'12px\'"></button>').length > 0, '> inside earlier quoted attribute');
  assert.ok(scanHtml('index.html', '<button onclick="const {style}=this;style.fontSize=\'12px\'"></button>').length > 0, 'destructured {style} inside onclick');
  assert.ok(scanHtml('index.html', '<button onclick="this.animate([{fontSize:\'12px\'}])"></button>').length > 0, 'animate() inside onclick');
  assert.deepEqual(scanHtml('index.html', '<script type="application/json">{"style":{"fontSize":"12px"}}</script>'), [], 'JSON script ignored');
  assert.deepEqual(scanHtml('index.html', '<script>el.style.fontSize = "var(--type-body)";</script>'), [], 'valid inline script');
  assert.deepEqual(scanHtml('index.html', '<script type="text/javascript; charset=utf-8">el.style.fontSize = "var(--type-body)";</script>'), [], 'valid MIME-parameterized inline script');
  assert.deepEqual(scanHtml('index.html', '<div onclick="el.style.fontSize=\'var(--type-body)\'"></div>'), [], 'valid inline HTML event handler');
  assert.deepEqual(scanHtml('index.html', '<button title="a > b" onclick="(() => { const {style}=this; style.fontSize=\'var(--type-body)\'; })()"></button>'), [], 'valid arrow/destructured onclick');
});
