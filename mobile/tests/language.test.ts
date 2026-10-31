// The mobile localization core must behave exactly like the desktop's src/i18n.ts:
// same system-locale mapping. The tagged-template/substitution behavior is covered
// desktop-side in tests/i18n.test.mjs (desktop) and here for mobile's own copy.
import test from 'node:test';
import assert from 'node:assert/strict';
import { resolveSystemLocale as mobileResolve, makeTranslate } from '../src/i18n/core.ts';
import { resolveSystemLocale as desktopResolve } from '../../src/i18n.ts';
import { CATALOGS } from '../src/i18n/catalogs.ts';

const CASES = [
  [], ['en-US'], ['en'], ['en-GB'], ['en-AU'], ['en-NZ'], ['en-IE'], ['en-ZA'], ['en-SG'], ['en-IN'],
  ['zh'], ['zh-CN'], ['zh-SG'], ['zh-Hans-CN'], ['zh-TW'], ['zh-Hant-TW'], ['zh-HK'], ['zh-MO'],
  ['zh-Hant-HK'], ['zh-Hant'],
  ['de'], ['de-AT'], ['es'], ['es-419'], ['fr'], ['fr-CA'], ['it'], ['ja'], ['ja-JP'],
  ['ko'], ['pl'], ['pt'], ['pt-PT'], ['pt-BR'], ['ru'],
  ['nl-NL', 'zh-HK'],
];

test('system locale mapping is identical to the desktop', () => {
  for (const candidates of CASES) {
    assert.equal(mobileResolve(candidates), desktopResolve(candidates), `mapping differs for ${JSON.stringify(candidates)}`);
  }
});

test('mobile translate substitutes values in one pass, never re-splitting them', () => {
  const t = makeTranslate({ 'Copied {0}': '已复制 {0}' });
  assert.equal(t('Unknown'), 'Unknown', 'missing keys fall back to source English');
  assert.equal(t`Copied ${'a {0} sneaky {1} value'}`, '已复制 a {0} sneaky {1} value');
});

test('catalogs keep placeholder signatures and the full tables agree', () => {
  const signature = (value: string) => (value.match(/\{\d+\}/g) ?? []).sort().join(',');
  for (const [locale, catalog] of Object.entries(CATALOGS)) {
    for (const [key, value] of Object.entries(catalog ?? {})) {
      assert.equal(signature(value!), signature(key), `${locale} placeholder mismatch for ${key}`);
    }
  }
  const hans = CATALOGS['zh-Hans']!, tw = CATALOGS['zh-Hant-TW']!;
  assert.ok(Object.keys(hans).length > 150, 'mobile zh-Hans catalog is populated');
  assert.deepEqual(Object.keys(tw).sort(), Object.keys(hans).sort(), 'zh-Hant-TW covers the same keys');
  // zh-Hant-HK ships the full Taiwan table (with HK vocabulary) — an empty table would silently serve English.
  assert.deepEqual(Object.keys(CATALOGS['zh-Hant-HK']!).sort(), Object.keys(tw).sort(), 'zh-Hant-HK covers the Taiwan table');
  for (const [key, value] of Object.entries(CATALOGS['zh-Hant-HK'] ?? {})) {
    assert.equal(signature(value!), signature(tw[key]!), `HK override changed placeholders for ${key}`);
  }
  // Every full locale ships the complete key set; missing keys silently serve English otherwise.
  for (const locale of ['de', 'es', 'fr', 'it', 'ja', 'ko', 'pl', 'pt-BR', 'ru'] as const) {
    assert.deepEqual(Object.keys(CATALOGS[locale] ?? {}).sort(), Object.keys(hans).sort(), `${locale} covers the zh-Hans key set`);
  }
});
