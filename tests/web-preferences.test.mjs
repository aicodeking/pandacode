import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const source = fs.readFileSync(new URL('../src/web-preferences.ts', import.meta.url), 'utf8');
const js = ts.transpileModule(source, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 } }).outputText;
const { sanitizeAppearance, appearanceSnapshot, storeAppearance, validatedWallpaperAccentSeed, applyWallpaperAccentSeed } = await import(`data:text/javascript,${encodeURIComponent(js)}`);
test('host accent metadata accepts only six-digit hex and clears stale seeds', () => {
  globalThis.document = { documentElement: { dataset: {} } };
  assert.equal(validatedWallpaperAccentSeed('#A1B2C3'), '#a1b2c3');
  for (const seed of ['#abc', '#abcd', '#aabbccdd', 'red', 'url(x)', '#12345g', '', null, 12]) {
    assert.equal(validatedWallpaperAccentSeed(seed), undefined);
    applyWallpaperAccentSeed({ wallpaperAccentSeed: '#aabbcc' });
    applyWallpaperAccentSeed({ wallpaperAccentSeed: seed });
    assert.equal(document.documentElement.dataset.pandacodeWallpaperAccentSeed, undefined);
  }
  applyWallpaperAccentSeed({ wallpaperAccentSeed: '#A1B2C3' });
  assert.equal(document.documentElement.dataset.pandacodeWallpaperAccentSeed, '#a1b2c3');
  assert.deepEqual(sanitizeAppearance({ wallpaperAccentSeed: '#a1b2c3' }), {});
});
test('appearance snapshot excludes credential keys and derived CSS cache', () => {
  const palette = { accent: {mode:'custom',color:'#aabbcc'}, vsix:null, cache:{tokens:{'--bg':'url(https://evil.example)'}} };
  const clean = sanitizeAppearance({'pandacode.theme':'dark','token':'secret','pandacode.palette':JSON.stringify(palette)});
  assert.deepEqual(Object.keys(clean).sort(), ['pandacode.palette','pandacode.theme']);
  assert.deepEqual(JSON.parse(clean['pandacode.palette']), {accent:palette.accent,vsix:null});
});
test('rejects injected colors, malformed themes and out-of-range scaling', () => {
  assert.deepEqual(sanitizeAppearance({'pandacode.theme':'<script>', 'pandacode.uiScale':'99', 'pandacode.palette':JSON.stringify({accent:{mode:'custom',color:'url(x)'}})}),{});
  assert.deepEqual(sanitizeAppearance({'pandacode.palette':'{','pandacode.compact':'yes'}),{});
});
test('preserves all supported wallpaper choices while bounding sliders', () => {
  const clean=sanitizeAppearance({'pandacode.wallpaperPreferences':JSON.stringify({version:3,enabled:true,set:'sat',pinned:'sun-night',visibility:200,blur:-1})});
  assert.deepEqual(JSON.parse(clean['pandacode.wallpaperPreferences']),{version:3,enabled:true,set:'sat',pinned:'sun-night',visibility:100,blur:0});
});
test('host snapshot and application only access appearance keys', () => {
  const storage=new Map([['token','secret'],['pandacode.theme','light']]);
  globalThis.localStorage={getItem:key=>storage.get(key)??null,setItem:(key,value)=>storage.set(key,value),removeItem:key=>storage.delete(key)};
  assert.equal(appearanceSnapshot()['pandacode.theme'],'light');
  assert.equal(appearanceSnapshot().token,undefined);
  storeAppearance({'token':'changed','pandacode.theme':'dark','pandacode.compact':null});
  assert.equal(storage.get('token'),'secret'); assert.equal(storage.get('pandacode.theme'),'dark');
});
