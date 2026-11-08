import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { stripTypeScriptTypes } from 'node:module';

// The production module owns its stylesheet; exercise its pure geometry without a browser loader.
const url = new URL('../src/brand-mark.ts', import.meta.url);
const source = (await readFile(url, 'utf8')).replace("import './brand-mark.css';", '').replace(/from '(\.\.?\/[^']+)'/g, (_, path) => `from '${new URL(path, url)}'`);
const { desktopBrandLayout, desktopBrandFlight, desktopBrandFit } = await import(`data:text/javascript;base64,${Buffer.from(stripTypeScriptTypes(source)).toString('base64')}`);

test('desktop perches and crossings follow unequal measured letter widths', () => {
  const widths = [12, 9, 10, 11, 8, 14, 10, 11, 9];
  let left = 0;
  const spans = widths.map(width => { const span = { left, width }; left += width; return span; });
  const layout = desktopBrandLayout(spans, [14, 10, 10, 15, 10, 14, 10, 15, 10], 29);
  assert.equal(layout.px[0], left + 12);
  assert.equal(layout.px[1], spans[7].left + widths[7] / 2 + 3.2);
  assert.equal(layout.px[2], spans[5].left + widths[5] / 2);
  assert.deepEqual(layout.ph, [0, 14, 13]);
  assert.equal(layout.width, layout.px[0] + 12.5);
  assert.equal(layout.baseline, 29);
  assert.ok(layout.passes.flat().every(Number.isFinite));
});

test('launch lands at the actual desktop scale and never travels without a visible target', () => {
  const rest = { x: 400, y: 300 }, target = { x: 110, y: 10 };
  assert.deepEqual(desktopBrandFlight(0, rest, target), { ...rest, scale: 2, opacity: 1 });
  const arrived = desktopBrandFlight(1, rest, target);
  assert.equal(arrived.x, target.x);
  assert.equal(arrived.y, target.y);
  assert.equal(arrived.scale, .7);
  assert.equal(desktopBrandFlight(1, rest, { ...target, scale: .55 }).scale, .55);
  assert.deepEqual(desktopBrandFlight(.5, rest, null), { ...rest, scale: 2, opacity: .5 });
  assert.deepEqual(desktopBrandFlight(1, rest, null), { ...rest, scale: 2, opacity: 0 });
});

 test('normal macOS width retains readable text and narrow widths use a compact panda', () => {
  const normal = desktopBrandFit(75, 134.5, 55);
  assert.equal(normal.compact, false);
  assert.ok(normal.scale * 20 >= 11);
  assert.equal(normal.width, 75);
  const narrow = desktopBrandFit(30, 134.5, 55);
  assert.equal(narrow.compact, true);
  assert.equal(narrow.scale, .7);
  assert.ok(narrow.width <= 30);
  assert.deepEqual(desktopBrandFit(280, 134.5, 55), { compact: false, scale: .7, width: 94.14999999999999 });
});
