import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
// dom.ts reads the theme once its lazy icon chunk has loaded.
globalThis.document ??= { documentElement: { dataset: {} } };
const { modelCardHtml, modelFactsHtml } = await import('../src/voice-model-card.ts');

const catalog = JSON.parse(readFileSync(new URL('../src-tauri/src/voice/local/catalog.json', import.meta.url), 'utf8'));
const view = (overrides = {}) => ({ selectedLanguages: [], pending: new Set(), errors: new Map(), ...overrides });
const STATES = [
  { state: 'downloadable', active: false },
  { state: 'downloadable', active: false, downloaded: 1 },
  { state: 'downloading', active: false, downloaded: 0 },
  { state: 'verifying', active: false },
  { state: 'installed', active: false },
  { state: 'installed', active: true },
];

test('every model in the real catalog renders a card in every state without throwing', () => {
  assert.ok(catalog.models.length > 0);
  for (const entry of catalog.models) {
    for (const flags of STATES) {
      const model = { ...entry, ...flags, downloaded: flags.downloaded ?? undefined };
      for (const v of [view(), view({ selectedLanguages: ['en', 'zz'], busyWith: 'Other' })]) {
        const html = modelCardHtml(model, v);
        assert.match(html, /voice-model-facts/, entry.id);
        assert.doesNotMatch(html, /undefined|NaN|null/, `${entry.id} ${flags.state}`);
      }
    }
  }
});

test('a benchmark without a speed says so instead of throwing', () => {
  const voxtral = catalog.models.find(model => model.benchmark && model.benchmark.secondsPer30s == null);
  assert.ok(voxtral, 'the real catalog has a model without a measured speed');
  assert.match(modelFactsHtml({ ...voxtral, state: 'downloadable', active: false }, []), /Speed not measured/);
});

test('card facts survive missing or malformed catalog data', () => {
  const base = { ...catalog.models[0], state: 'downloadable', active: false };
  const broken = [
    { ...base, benchmark: { accuracy: undefined, secondsPer30s: undefined } },
    { ...base, benchmark: { accuracy: { en: { grade: undefined, errorPercent: null } }, secondsPer30s: Number.NaN } },
    { ...base, languages: undefined, size: undefined, license: undefined, description: undefined },
  ];
  for (const model of broken) {
    const html = modelCardHtml(model, view({ selectedLanguages: ['en'] }));
    assert.doesNotMatch(html, /undefined|NaN|null/);
  }
});

test('each separator stays attached to the fact that follows it', () => {
  const html = modelFactsHtml({ ...catalog.models[0], state: 'downloadable', active: false }, []);
  const groups = html.match(/<span class="voice-model-fact">/g) ?? [];
  assert.ok(groups.length >= 3);
  assert.doesNotMatch(html, /<\/span><span class="voice-model-dot"[^>]*>·<\/span><span>/);
  assert.match(html, /<span class="voice-model-fact"><span class="voice-model-dot" aria-hidden="true">·<\/span>/);
});

test('auto-detect on a model that cannot detect names the language native uses', async () => {
  const { languageNote } = await import('../src/voice-model-browser.ts');
  const find = id => ({ ...catalog.models.find(model => model.id === `handy-computer/${id}`), state: 'installed', active: true });
  const canary = find('canary-180m-flash-gguf');
  assert.equal(canary.supportsLanguageDetection, false);
  assert.equal(languageNote(canary, 'auto'), `${canary.name} can’t detect the language; it will transcribe English.`);
  // No English: the model's first language, as native falls back.
  const gigaam = find('gigaam-v3-ctc-gguf');
  assert.equal(languageNote({ ...gigaam, languages: ['ru', 'uk'] }, 'auto'), `${gigaam.name} can’t detect the language; it will transcribe Russian.`);
});

test('every catalog licence shows its canonical SPDX casing, and unknown ids pass through', async () => {
  const { licenseLabel } = await import('../src/voice-model-card.ts');
  const CANONICAL = { 'apache-2.0': 'Apache-2.0', 'cc-by-4.0': 'CC-BY-4.0', 'cc-by-sa-4.0': 'CC-BY-SA-4.0', mit: 'MIT' };
  const licences = [...new Set(catalog.models.map(model => model.license))];
  assert.ok(licences.length > 0);
  for (const id of licences) {
    const label = CANONICAL[id] ?? id;
    assert.equal(licenseLabel(id), label, id);
    // An SPDX-style id never shows in all lowercase on a card.
    assert.ok(label !== label.toLowerCase(), `${id} has a display label`);
    const html = modelFactsHtml({ ...catalog.models.find(model => model.license === id), state: 'downloadable', active: false }, []);
    assert.ok(html.includes(`>${label}</a>`) || html.includes(label), id);
    assert.ok(!html.includes(`>${id}<`) || id === label, `${id} is not shown raw`);
  }
  assert.equal(licenseLabel('CC-BY-NC-4.0'), 'CC-BY-NC-4.0');
  assert.equal(licenseLabel('cc-by-nc-4.0'), 'CC-BY-NC-4.0');
  assert.equal(licenseLabel('Some Custom Licence'), 'Some Custom Licence');
});
