// The i18n guardrail: catalogs stay complete and placeholder-faithful, and every
// wrapped UI string in src/ has a translation. See src/locales/GLOSSARY.md.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { resolveSystemLocale } from '../src/i18n.ts';

const srcDir = fileURLToPath(new URL('../src', import.meta.url));
const localesDir = `${srcDir}/locales`;
const zhHans = (await import('../src/locales/zh-Hans.ts')).default;
const zhHantTw = (await import('../src/locales/zh-Hant-TW.ts')).default;
const zhHantHk = (await import('../src/locales/zh-Hant-HK.ts')).default;
const enGb = (await import('../src/locales/en-GB.ts')).default;
const de = (await import('../src/locales/de.ts')).default;
const es = (await import('../src/locales/es.ts')).default;
const fr = (await import('../src/locales/fr.ts')).default;
const it = (await import('../src/locales/it.ts')).default;
const ja = (await import('../src/locales/ja.ts')).default;
const ko = (await import('../src/locales/ko.ts')).default;
const pl = (await import('../src/locales/pl.ts')).default;
const ptBr = (await import('../src/locales/pt-BR.ts')).default;
const ru = (await import('../src/locales/ru.ts')).default;

/** The full catalogs: every wrapped key in src/ must exist in each, translated. */
const FULL_CATALOGS = [
  ['zh-Hans', zhHans], ['zh-Hant-TW', zhHantTw],
  ['de', de], ['es', es], ['fr', fr], ['it', it], ['ja', ja], ['ko', ko],
  ['pl', pl], ['pt-BR', ptBr], ['ru', ru],
];
/** Every catalog checked for placeholder fidelity, overrides included. */
const ALL_CATALOGS = [...FULL_CATALOGS, ['zh-Hant-HK', zhHantHk], ['en-GB', enGb]];

const signature = value => (value.match(/\{\d+\}/g) ?? []).sort().join(',');

/** Recursively lists .rs files under a directory. */
function rustFiles(dir) {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.name === 'target') continue;
    const full = `${dir}/${entry.name}`;
    if (entry.isDirectory()) out.push(...rustFiles(full));
    else if (entry.name.endsWith('.rs')) out.push(full);
  }
  return out;
}

const tauriSrc = fileURLToPath(new URL('../src-tauri/src', import.meta.url));
const zhHansBackend = (await import('../src/locales/zh-Hans.ts')).backend;
const zhHantTwBackend = (await import('../src/locales/zh-Hant-TW.ts')).backend;
const zhHantHkBackend = (await import('../src/locales/zh-Hant-HK.ts')).backend;
const enGbBackend = (await import('../src/locales/en-GB.ts')).backend;
const deBackend = (await import('../src/locales/de.ts')).backend;
const esBackend = (await import('../src/locales/es.ts')).backend;
const frBackend = (await import('../src/locales/fr.ts')).backend;
const itBackend = (await import('../src/locales/it.ts')).backend;
const jaBackend = (await import('../src/locales/ja.ts')).backend;
const koBackend = (await import('../src/locales/ko.ts')).backend;
const plBackend = (await import('../src/locales/pl.ts')).backend;
const ptBrBackend = (await import('../src/locales/pt-BR.ts')).backend;
const ruBackend = (await import('../src/locales/ru.ts')).backend;

/** The full backend tables: the stable Rust error set must be covered by each. */
const FULL_BACKENDS = [
  ['zh-Hans', zhHansBackend], ['zh-Hant-TW', zhHantTwBackend],
  ['de', deBackend], ['es', esBackend], ['fr', frBackend], ['it', itBackend],
  ['ja', jaBackend], ['ko', koBackend], ['pl', plBackend], ['pt-BR', ptBrBackend], ['ru', ruBackend],
];


/** Extracts keys from t('…') literals and tagged t`…${…}…` templates, like the runtime does. */
function extractKeys(text) {
  const keys = new Set();
  const staticRe = /\bt\(\s*'((?:[^'\\]|\\.)*)'\s*\)|\bt\(\s*"((?:[^"\\]|\\.)*)"\s*\)/g;
  for (const match of text.matchAll(staticRe)) {
    keys.add((match[1] ?? match[2]).replace(/\\(['"\\])/g, '$1'));
  }
  let index = -1;
  while ((index = text.indexOf('t`', index + 1)) !== -1) {
    if (index > 0 && /[\w$]/.test(text[index - 1])) continue;
    let cursor = index + 2, key = '', n = 0, closed = false;
    while (cursor < text.length) {
      const ch = text[cursor];
      if (ch === '`') { closed = true; break; }
      if (ch === '$' && text[cursor + 1] === '{') {
        key += `{${n++}}`;
        cursor += 2;
        let depth = 1;
        while (cursor < text.length && depth > 0) {
          const inner = text[cursor];
          if (inner === '{') depth++;
          else if (inner === '}') depth--;
          else if (inner === '`') { while (cursor < text.length && text[cursor] !== '`') { if (text[cursor] === '\\') cursor++; cursor++; } }
          cursor++;
        }
        continue;
      }
      if (ch === '\\') { key += text.slice(cursor, cursor + 2); cursor += 2; continue; }
      key += ch; cursor++;
    }
    if (closed) keys.add(key);
  }
  return keys;
}

test('zh-Hans and zh-Hant-TW cover the same keys, every value translated', () => {
  assert.deepEqual(Object.keys(zhHantTw).sort(), Object.keys(zhHans).sort());
  for (const [key, value] of Object.entries(zhHans)) {
    assert.ok(value.trim(), `empty zh-Hans value for ${JSON.stringify(key)}`);
    assert.equal(/\b(the|and|of|to|for)\b/.test(value) && !/[a-zA-Z]{4,}/.test(value), false, `zh-Hans value looks untranslated for ${JSON.stringify(key)}: ${value}`);
  }
});

test('every key keeps its placeholder signature in every catalog', () => {
  for (const [name, catalog] of ALL_CATALOGS) {
    for (const [key, value] of Object.entries(catalog)) {
      assert.equal(signature(value), signature(key), `${name} placeholder mismatch for ${JSON.stringify(key)}: ${JSON.stringify(value)}`);
    }
  }
});

test('zh-Hant-HK is the Taiwan table plus HK vocabulary, nothing dropped', () => {
  for (const [key, value] of Object.entries(zhHantHk)) {
    assert.equal(signature(value), signature(zhHantTw[key] ?? key), `HK override changed placeholders for ${JSON.stringify(key)}`);
  }
  for (const key of Object.keys(zhHantTw)) {
    assert.notEqual(zhHantHk[key], undefined, `HK dropped the Taiwan key ${JSON.stringify(key)}`);
  }
});

test('en-GB only respells known source keys, and stays partial', () => {
  for (const key of Object.keys(enGb)) {
    assert.ok(zhHans[key] !== undefined, 'en-GB shares the key space with the source');
  }
  assert.ok(enGb['Colors'] === 'Colours');
  assert.ok(Object.keys(enGb).length > 5, 'en-GB has its spelling overrides');
});

test('every wrapped t() key in src/ is present in every full catalog', () => {
  const files = readdirSync(srcDir).filter(name => name.endsWith('.ts') && !/^(preview|locales|i18n\.ts|entry\.ts)/.test(name));
  const missing = [];
  for (const file of files) {
    for (const key of extractKeys(readFileSync(`${srcDir}/${file}`, 'utf8'))) {
      for (const [name, catalog] of FULL_CATALOGS) {
        if (catalog[key] === undefined) missing.push(`${name}: ${JSON.stringify(key)} (${file})`);
      }
    }
  }
  assert.equal(missing.length, 0, `untranslated keys (add them to src/locales):\n${missing.slice(0, 20).join('\n')}`);
});

test('system locale mapping follows the documented resolution', () => {
  assert.equal(resolveSystemLocale([]), 'en-US');
  assert.equal(resolveSystemLocale(['en-US', 'zh-CN']), 'en-US');
  assert.equal(resolveSystemLocale(['zh-CN']), 'zh-Hans');
  assert.equal(resolveSystemLocale(['zh', 'en']), 'zh-Hans');
  assert.equal(resolveSystemLocale(['zh-SG']), 'zh-Hans');
  assert.equal(resolveSystemLocale(['zh-Hans-CN']), 'zh-Hans');
  assert.equal(resolveSystemLocale(['zh-TW']), 'zh-Hant-TW');
  assert.equal(resolveSystemLocale(['zh-Hant-TW', 'en']), 'zh-Hant-TW');
  assert.equal(resolveSystemLocale(['zh-HK']), 'zh-Hant-HK');
  assert.equal(resolveSystemLocale(['zh-MO']), 'zh-Hant-HK');
  assert.equal(resolveSystemLocale(['zh-Hant-HK']), 'zh-Hant-HK');
  assert.equal(resolveSystemLocale(['zh-Hant']), 'zh-Hant-TW');
  assert.equal(resolveSystemLocale(['en-GB']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-AU']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-NZ']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-IE']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-ZA']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-SG']), 'en-GB');
  assert.equal(resolveSystemLocale(['en-IN']), 'en-GB');
  assert.equal(resolveSystemLocale(['de']), 'de');
  assert.equal(resolveSystemLocale(['de-AT']), 'de');
  assert.equal(resolveSystemLocale(['de-DE', 'en']), 'de');
  assert.equal(resolveSystemLocale(['es']), 'es');
  assert.equal(resolveSystemLocale(['es-419']), 'es');
  assert.equal(resolveSystemLocale(['fr']), 'fr');
  assert.equal(resolveSystemLocale(['fr-CA']), 'fr');
  assert.equal(resolveSystemLocale(['it']), 'it');
  assert.equal(resolveSystemLocale(['ja']), 'ja');
  assert.equal(resolveSystemLocale(['ja-JP']), 'ja');
  assert.equal(resolveSystemLocale(['ko']), 'ko');
  assert.equal(resolveSystemLocale(['pl']), 'pl');
  assert.equal(resolveSystemLocale(['pt']), 'pt-BR');
  assert.equal(resolveSystemLocale(['pt-PT']), 'pt-BR');
  assert.equal(resolveSystemLocale(['pt-BR']), 'pt-BR');
  assert.equal(resolveSystemLocale(['ru']), 'ru');
  // Unsupported languages are skipped; the first supported candidate wins.
  assert.equal(resolveSystemLocale(['nl-NL', 'zh-HK']), 'zh-Hant-HK');
});

test('t() translates statics and substitutes tagged values in one pass', async () => {
  // setActiveLocale touches <html lang>; the shim stands in for the DOM.
  globalThis.document ??= { documentElement: { lang: 'en' } };
  const i18n = await import('../src/i18n.ts');
  i18n.registerCatalog('zh-Hans', { 'New task': '新任务', 'Copied {0}': '已复制 {0}', 'Remove {0}?': '移除 {0}？' });
  i18n.setActiveLocale('zh-Hans');
  try {
    assert.equal(i18n.t('New task'), '新任务');
    assert.equal(i18n.t('Missing key'), 'Missing key');
    const name = 'a {0} sneaky {1} value';
    assert.equal(i18n.t`Copied ${name}`, '已复制 a {0} sneaky {1} value');
    assert.equal(i18n.t`Remove ${'我的文件'}?`, '移除 我的文件？');
  } finally {
    i18n.setActiveLocale('en-US');
  }
});

test('dynamically translated key sets (stored stream statuses) are covered too', () => {
  // statusLabel() looks keys up at render from stored English; extractKeys cannot see them.
  const mainTs = readFileSync(`${srcDir}/main.ts`, 'utf8');
  const setLiteral = mainTs.match(/STREAM_STATUSES = new Set\(\[([^\]]*)\]\)/);
  assert.ok(setLiteral, 'STREAM_STATUSES is still declared in main.ts');
  const keys = [...setLiteral[1].matchAll(/'((?:[^'\\]|\\.)*)'/g)].map(m => m[1].replace(/\\'/g, "'"));
  assert.ok(keys.length >= 5, 'the status set was parsed');
  for (const key of keys) {
    for (const [name, catalog] of FULL_CATALOGS) {
      assert.ok(catalog[key] !== undefined, `dynamic status key missing from ${name}: ${JSON.stringify(key)}`);
    }
  }
});

test('stable Rust error strings are covered by the backend catalogs', () => {
  const literals = new Set();
  for (const file of rustFiles(tauriSrc)) {
    const text = readFileSync(file, 'utf8');
    for (const match of text.matchAll(/Err\(\s*"((?:[^"\\]|\\.)*)"/g)) literals.add(match[1]);
  }
  const sentenceLike = [...literals].filter(s => s.length >= 14 && s[0].isupper === undefined && s[0] === s[0].toUpperCase() && /\p{Lu}/u.test(s[0]) && s.includes(' ') && !/[{}<>/*]/.test(s));
  assert.ok(sentenceLike.length > 500, `expected the full Rust error surface, found ${sentenceLike.length}`);
  const missing = sentenceLike.filter(key => FULL_BACKENDS.some(([, table]) => table[key] === undefined));
  assert.equal(missing.length, 0, `backend errors missing translations:\n${missing.slice(0, 10).join('\n')}`);
  for (const [key, value] of Object.entries(zhHansBackend)) {
    assert.ok(!/\{\d+\}/.test(key) && !/\{\d+\}/.test(value), 'backend strings are static, no placeholders');
  }
  for (const [name, table] of FULL_BACKENDS) {
    assert.deepEqual(Object.keys(table).sort(), Object.keys(zhHansBackend).sort(), `${name} backend covers the same keys as zh-Hans`);
  }
  assert.deepEqual(Object.keys(zhHantHkBackend).sort(), Object.keys(zhHansBackend).sort(), 'zh-Hant-HK backend covers the Taiwan table');
  for (const key of Object.keys(enGbBackend)) assert.ok(zhHansBackend[key] !== undefined, 'en-GB backend keys are real error strings');
});

test('Rust-defined slash command descriptions are translated', () => {
  const table = readFileSync(`${tauriSrc}/bots/../slash_commands.rs`, 'utf8');
  const start = table.indexOf('const LOCAL_ACTIONS');
  const end = table.indexOf('];', start);
  const descriptions = [...table.slice(start, end).matchAll(/\(\s*"(\/[^"]*)",\s*\n?\s*"((?:[^"\\]|\\.)*)"/g)].map(m => m[2]);
  assert.ok(descriptions.length >= 10, `parsed the LOCAL_ACTIONS table, found ${descriptions.length}`);
  const missing = descriptions.filter(key => FULL_CATALOGS.some(([, catalog]) => catalog[key] === undefined));
  assert.equal(missing.length, 0, `slash descriptions missing translations:\n${missing.join('\n')}`);
});
