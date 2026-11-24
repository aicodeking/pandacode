import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { ACTIVE_TURN_TOLERANCE, PREVIEW_MAX, buildScrollIndicatorModel, extractTurnPreview, findActiveTurnIndex } from '../src/thread-scroll-model.ts';

const turn = (index, extra = {}) => ({ id: `t${index}`, userText: `Question number ${index + 1}`, messageIds: [`m${index}`], ...extra });
const turns = (count, extra = () => ({})) => Array.from({ length: count }, (_, index) => turn(index, extra(index)));
const model = (overrides = {}) => buildScrollIndicatorModel({ turns: [], activeTurnIndex: 0, hasOlder: false, atBottom: true, scrollable: false, ...overrides });

test('extractTurnPreview prefers the prompt, then the reply, then the fallback', () => {
  assert.equal(extractTurnPreview('Fix the login bug', 'Done.', 'Turn 1'), 'Fix the login bug');
  assert.equal(extractTurnPreview('', 'The reply text', 'Turn 1'), 'The reply text');
  assert.equal(extractTurnPreview('   \n ', undefined, 'Turn 3'), 'Turn 3');
  assert.equal(extractTurnPreview(undefined, '```\nonly code\n```', 'Turn 2'), '[code]');
  assert.equal(extractTurnPreview(), '');
});

test('extractTurnPreview strips markdown noise and collapses whitespace', () => {
  assert.equal(extractTurnPreview('## Heading\n\nRun `npm test` and see **bold** and *em* text'), 'Heading Run npm test and see bold and em text');
  assert.equal(extractTurnPreview('Read [the docs](https://example.com/x) now ![logo](a.png)'), 'Read the docs now logo');
  assert.equal(extractTurnPreview('Before\n```ts\nconst a = 1;\n```\nafter'), 'Before [code] after');
  assert.equal(extractTurnPreview('Unclosed\n```js\nlet x'), 'Unclosed [code]');
  assert.equal(extractTurnPreview('- one\n- two\n> quoted ~~gone~~'), 'one two quoted gone');
  assert.equal(extractTurnPreview('keep snake_case_names and 2*3*4 intact'), 'keep snake_case_names and 2*3*4 intact');
  assert.equal(extractTurnPreview('a\t\tb\n\n\nc'), 'a b c');
});

test('extractTurnPreview trims long text to the limit with an ellipsis', () => {
  const long = 'word '.repeat(60);
  const preview = extractTurnPreview(long);
  assert.ok(preview.length <= PREVIEW_MAX, String(preview.length));
  assert.ok(preview.endsWith('…'));
  assert.ok(!preview.includes('wor…'), 'cuts at a word boundary');
  const unbroken = 'x'.repeat(300);
  assert.equal(extractTurnPreview(unbroken).length, PREVIEW_MAX);
  assert.equal(extractTurnPreview('y'.repeat(PREVIEW_MAX)), 'y'.repeat(PREVIEW_MAX));
});

test('findActiveTurnIndex finds the turn at the reading line', () => {
  const tops = [0, 100, 250, 400, 900];
  assert.equal(findActiveTurnIndex([], 10, false), -1);
  assert.equal(findActiveTurnIndex([], 10, true), -1);
  assert.equal(findActiveTurnIndex(tops, -50, false), 0);
  assert.equal(findActiveTurnIndex(tops, 0, false), 0);
  assert.equal(findActiveTurnIndex(tops, 98, false), 0);
  assert.equal(findActiveTurnIndex(tops, 100, false), 1);
  assert.equal(findActiveTurnIndex(tops, 398, false), 2);
  assert.equal(findActiveTurnIndex(tops, 5000, false), 4);
  assert.equal(findActiveTurnIndex(tops, 0, true), 4);
  assert.equal(findActiveTurnIndex([42], 0, false), 0);
  const many = Array.from({ length: 10_000 }, (_, index) => index * 10);
  assert.equal(findActiveTurnIndex(many, 54_321, false), 5432);
});

test('findActiveTurnIndex tolerates WebKit scrollTop rounding just below the reading line', () => {
  const readingLine = 300;
  assert.equal(ACTIVE_TURN_TOLERANCE, 1.5);
  assert.equal(findActiveTurnIndex([0, 100, readingLine + 0.5625, 900], readingLine, false), 2);
  assert.equal(findActiveTurnIndex([0, 100, readingLine + ACTIVE_TURN_TOLERANCE, 900], readingLine, false), 2);
  assert.equal(findActiveTurnIndex([0, 100, readingLine + 20, 900], readingLine, false), 1);
});

test('an empty thread hides the indicator', () => {
  const state = model();
  assert.equal(state.visible, false);
  assert.equal(state.showEarlier, false);
  assert.equal(state.showLatest, false);
  assert.deepEqual(state.markers, []);
  assert.equal(state.activeMarkerIndex, -1);
});

test('a single short turn hides it; a single scrollable turn shows it', () => {
  assert.equal(model({ turns: turns(1) }).visible, false);
  const long = model({ turns: turns(1), scrollable: true, atBottom: false });
  assert.equal(long.visible, true);
  assert.equal(long.showLatest, true);
  assert.equal(long.markers.length, 1);
  assert.equal(long.markers[0].active, true);
  assert.equal(long.markers[0].title, 'Turn 1 of 1');
});

test('2..16 turns get one marker per turn', () => {
  for (let count = 2; count <= 16; count++) {
    const list = turns(count);
    const state = model({ turns: list, activeTurnIndex: 1, atBottom: false, scrollable: true });
    assert.equal(state.visible, true);
    assert.equal(state.markers.length, count);
    state.markers.forEach((marker, index) => {
      assert.equal(marker.startIndex, index);
      assert.equal(marker.endIndex, index);
      assert.equal(marker.targetId, list[index].id);
      assert.equal(marker.totalTurns, count);
      assert.equal(marker.title, `Turn ${index + 1} of ${count}`);
      assert.equal(marker.preview, `Question number ${index + 1}`);
    });
    assert.equal(state.activeMarkerIndex, 1);
    assert.deepEqual(state.markers.map(marker => marker.active), state.markers.map((_, index) => index === 1));
    assert.equal(new Set(state.markers.map(marker => marker.key)).size, count, 'keys are unique');
  }
});

test('the live turn is titled and flagged; errors are flagged', () => {
  const list = turns(3, index => (index === 1 ? { hasError: true } : index === 2 ? { isLive: true } : {}));
  const state = model({ turns: list });
  assert.equal(state.markers[2].title, 'Live response');
  assert.equal(state.markers[2].isLive, true);
  assert.equal(state.markers[1].hasError, true);
  assert.equal(state.markers[0].isLive || state.markers[0].hasError, false);
});

test('50 turns fold into contiguous ranges that keep the first and last turns', () => {
  const list = turns(50, index => (index === 49 ? { isLive: true } : index === 20 ? { hasError: true } : {}));
  const state = model({ turns: list, maxSlots: 16, activeTurnIndex: 25, atBottom: false, scrollable: true });
  const { markers } = state;
  assert.equal(markers.length, 16);
  assert.equal(markers[0].startIndex, 0);
  assert.equal(markers[0].endIndex, 0);
  assert.equal(markers[0].targetId, 't0');
  assert.equal(markers[15].startIndex, 49);
  assert.equal(markers[15].targetId, 't49');
  assert.equal(markers[15].title, 'Live response');
  assert.equal(markers[15].isLive, true);
  for (let index = 1; index < markers.length; index++) assert.equal(markers[index].startIndex, markers[index - 1].endIndex + 1, `marker ${index} is contiguous`);
  const middle = markers.slice(1, -1);
  const sizes = middle.map(marker => marker.endIndex - marker.startIndex + 1);
  assert.ok(Math.max(...sizes) - Math.min(...sizes) <= 1, `even ranges: ${sizes}`);
  for (const marker of middle) {
    assert.ok(marker.targetId === list[marker.startIndex].id || list.slice(marker.startIndex, marker.endIndex + 1).some(t => t.id === marker.targetId));
    assert.equal(marker.title, `Turns ${marker.startIndex + 1}–${marker.endIndex + 1} of 50`);
    assert.equal(marker.totalTurns, 50);
  }
  const errored = middle.find(marker => marker.startIndex <= 20 && marker.endIndex >= 20);
  assert.equal(errored.targetId, 't20', 'a range points at its errored turn');
  assert.equal(errored.hasError, true);
  assert.equal(errored.preview, 'Question number 21');
  const plain = middle.find(marker => !marker.hasError);
  const mid = Math.floor((plain.startIndex + plain.endIndex) / 2);
  assert.equal(plain.targetId, `t${mid}`, 'a plain range points at its midpoint');
  const active = markers.filter(marker => marker.active);
  assert.equal(active.length, 1);
  assert.ok(active[0].startIndex <= 25 && active[0].endIndex >= 25);
  assert.equal(markers.indexOf(active[0]), state.activeMarkerIndex);
});

test('a live turn inside a range becomes its target', () => {
  const list = turns(40, index => (index === 10 ? { isLive: true } : {}));
  const markers = model({ turns: list, maxSlots: 8 }).markers;
  const range = markers.find(marker => marker.startIndex <= 10 && marker.endIndex >= 10);
  assert.equal(range.targetId, 't10');
  assert.equal(range.isLive, true);
});

test('maxSlots is clamped to 4..20 and defaults to 16', () => {
  assert.equal(model({ turns: turns(100), maxSlots: 1 }).markers.length, 4);
  assert.equal(model({ turns: turns(100), maxSlots: 99 }).markers.length, 20);
  assert.equal(model({ turns: turns(100) }).markers.length, 16);
  assert.equal(model({ turns: turns(17) }).markers.length, 16);
  assert.equal(model({ turns: turns(16) }).markers.length, 16);
});

test('active range matching clamps out-of-range indices and follows the bottom', () => {
  const list = turns(30);
  const at = (activeTurnIndex, atBottom = false) => model({ turns: list, activeTurnIndex, atBottom, scrollable: true, maxSlots: 6 });
  assert.equal(at(0).activeMarkerIndex, 0);
  assert.equal(at(-5).activeMarkerIndex, 0);
  assert.equal(at(29).activeMarkerIndex, 5);
  assert.equal(at(500).activeMarkerIndex, 5);
  assert.equal(at(3, true).activeMarkerIndex, 5);
  assert.equal(at(Number.NaN).activeMarkerIndex, 0);
  for (let index = 0; index < 30; index++) {
    const state = at(index);
    const marker = state.markers[state.activeMarkerIndex];
    assert.ok(marker.startIndex <= index && marker.endIndex >= index, `turn ${index}`);
    assert.equal(state.markers.filter(m => m.active).length, 1);
  }
});

test('hasOlder shows the earlier button and the indicator', () => {
  const state = model({ hasOlder: true });
  assert.equal(state.visible, true);
  assert.equal(state.showEarlier, true);
  assert.equal(model({ turns: turns(1), hasOlder: true }).visible, true);
  assert.equal(model({ turns: turns(3) }).showEarlier, false);
});

test('showLatest needs a scrollable thread that is away from the bottom', () => {
  assert.equal(model({ turns: turns(3), atBottom: false, scrollable: true }).showLatest, true);
  assert.equal(model({ turns: turns(3), atBottom: true, scrollable: true }).showLatest, false);
  assert.equal(model({ turns: turns(3), atBottom: false, scrollable: false }).showLatest, false);
  assert.equal(model({ turns: [], atBottom: false, scrollable: true, hasOlder: true }).showLatest, false);
});

test('the model never mutates its input', () => {
  const list = Object.freeze(turns(30).map(item => Object.freeze(item)));
  assert.doesNotThrow(() => model({ turns: list, activeTurnIndex: 12, maxSlots: 8 }));
});

test('the stylesheet uses tokens only: no literal colours or gradients', () => {
  const css = readFileSync(new URL('../src/thread-scroll-indicator.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.doesNotMatch(css, /#[0-9a-f]{3,8}\b/i, 'no hex colours');
  assert.doesNotMatch(css, /\b(?:rgb|rgba|hsl|hsla|oklch)\(/i, 'no literal colour functions');
  assert.doesNotMatch(css, /gradient\(/i, 'no gradients');
  assert.doesNotMatch(css, /transition:[^;}]*\b(?:width|height|top|left)\b/, 'no layout transitions');
  for (const query of ['prefers-reduced-motion:reduce', 'prefers-reduced-transparency:reduce', 'prefers-contrast:more', 'forced-colors:active']) {
    assert.ok(css.replace(/\s+/g, '').includes(query), query);
  }
});

test('the rail is bare and transparent while the preview keeps its glass', () => {
  const css = readFileSync(new URL('../src/thread-scroll-indicator.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const rules = [...css.matchAll(/([^{}]+)\{([^{}]*)\}/g)].map(([, selector, body]) => ({ selector: selector.trim(), body }));
  const indicatorRules = rules.filter(rule => rule.selector.split(',').some(part => /\.thread-scroll-indicator\s*$/.test(part.trim()) || /:is\([^)]*\.thread-scroll-indicator/.test(part)));
  assert.ok(indicatorRules.length > 0, 'indicator rules exist');
  for (const rule of indicatorRules) {
    assert.doesNotMatch(rule.body, /backdrop-filter/, `${rule.selector}: no backdrop-filter`);
    assert.doesNotMatch(rule.body, /box-shadow:(?!\s*none)/, `${rule.selector}: no box-shadow`);
    assert.doesNotMatch(rule.body, /outline:/, `${rule.selector}: no outline`);
    assert.doesNotMatch(rule.body, /border:(?!\s*0)/, `${rule.selector}: no border`);
    const background = rule.body.match(/background:([^;}]+)/);
    if (background) assert.equal(background[1].trim(), 'transparent', `${rule.selector}: transparent background`);
  }
  const base = indicatorRules.find(rule => rule.selector === '.thread-scroll-indicator' && /position:absolute/.test(rule.body));
  assert.ok(base, 'base indicator rule');
  assert.match(base.body, /background:transparent/);
  assert.match(base.body, /border-radius:0(?![.\d])/);
  const preview = rules.find(rule => rule.selector === '.thread-scroll-preview' && /--dock-fill/.test(rule.body));
  assert.ok(preview, 'preview glass rule');
  assert.match(preview.body, /background:var\(--dock-fill/);
  assert.match(preview.body, /backdrop-filter:var\(--dock-blur/);
  assert.match(preview.body, /box-shadow:var\(--dock-edge/);
  assert.match(css, /\.thread-scroll-tick-bar\{[^}]*opacity:\.62/);
});

test('the indicator mounts beside the transcript, never inside it', () => {
  const source = readFileSync(new URL('../src/thread-scroll-indicator.ts', import.meta.url), 'utf8');
  assert.match(source, /host\.pane\.append\(/);
  assert.doesNotMatch(source, /host\.scroller\.(?:append|prepend|appendChild|insertBefore)\(/);
});
