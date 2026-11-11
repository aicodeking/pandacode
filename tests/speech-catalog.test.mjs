import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

import {
  accuracyGrade,
  canonicalLanguage,
  compareEngineVersions,
  descriptionFor,
  DESCRIPTIONS,
  exclusionReason,
  languageIdentity,
  licenseFor,
  renderSpeechCatalog,
  REVIEWED_LICENSES,
  SPDX_LICENSE_URLS,
} from "../scripts/speech-catalog.mjs";

const path = new URL("../src-tauri/src/voice/local/catalog.json", import.meta.url);
const raw = readFileSync(path, "utf8");
const catalog = JSON.parse(raw);

const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;
const REPOSITORY = /^\w[\w.-]*\/\w[\w.-]*$/;
const ROOT_GGUF = /^[^/\\:.][^/\\:]*\.gguf$/;
const NC = /(?:^|[^a-z0-9])nc(?:$|[^a-z0-9])/i;
const RECOMMENDED = [
  "parakeet-unified-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
  "canary-180m-flash",
  "cohere-transcribe-03-2026",
  "whisper-medium",
].map((id) => `handy-computer/${id}-gguf`);
const MODEL_KEYS = [
  "id", "revision", "name", "description", "filename", "size", "sha256", "license",
  "licenseUrl", "languages", "benchmark", "recommended", "supportsStreaming",
  "supportsLanguageDetection", "supportsTranslation",
];

// Independent of the generator: the documented bands and cube-root-of-2 steps.
function expectedGrade(error) {
  if (error >= 30) return "F";
  if (error >= 20) return "D";
  const [letter, ceiling] = error < 5 ? ["A", 5] : error < 10 ? ["B", 10] : ["C", 20];
  const step = Math.cbrt(2);
  if (error < ceiling / step ** 2) return `${letter}+`;
  if (error < ceiling / step) return letter;
  return `${letter}-`;
}

function assertFile(entry, label) {
  assert.match(entry.id, REPOSITORY, `${label} id`);
  assert.match(entry.revision, REVISION, `${label} revision`);
  assert.match(entry.sha256, SHA256, `${label} sha256`);
  assert.match(entry.filename, ROOT_GGUF, `${label} filename`);
  assert.ok(Number.isSafeInteger(entry.size) && entry.size > 0, `${label} size`);
}

test("speech catalog header and deterministic formatting", () => {
  assert.deepEqual(Object.keys(catalog), [
    "source", "sourceVersion", "engineVersion", "generated", "vad", "defaultModel", "models",
  ]);
  assert.equal(catalog.source, "@handy-computer/models");
  assert.equal(catalog.sourceVersion, "0.2.3");
  assert.equal(catalog.engineVersion, "0.4.1");
  assert.equal(raw, renderSpeechCatalog(catalog), "2-space JSON with a trailing newline");
  assert.ok(catalog.models.length >= 50, `expected ~59 models, got ${catalog.models.length}`);
});

test("speech catalog models have valid, unique files and fields", () => {
  const ids = new Set();
  const filenames = new Set();
  for (const model of catalog.models) {
    assertFile(model, model.id);
    const keys = Object.keys(model);
    assert.deepEqual(keys.slice(0, MODEL_KEYS.length), MODEL_KEYS, `${model.id} key order`);
    for (const extra of keys.slice(MODEL_KEYS.length)) {
      assert.ok(["maxAudioMs", "supportsLongForm"].includes(extra), `${model.id} unexpected ${extra}`);
    }
    assert.ok(!ids.has(model.id), `duplicate id ${model.id}`);
    assert.ok(!filenames.has(model.filename), `duplicate filename ${model.filename}`);
    ids.add(model.id);
    filenames.add(model.filename);
    assert.ok(model.name && model.description && model.license, `${model.id} text fields`);
    assert.ok(model.languages.length > 0, `${model.id} languages`);
    assert.equal(new Set(model.languages).size, model.languages.length, `${model.id} unique languages`);
    for (const language of model.languages) assert.match(language, /^[a-z]{2,3}$/);
    for (const flag of ["recommended", "supportsStreaming", "supportsLanguageDetection", "supportsTranslation"]) {
      assert.equal(typeof model[flag], "boolean", `${model.id} ${flag}`);
    }
    assert.doesNotMatch(model.license, NC, `${model.id} is non-commercial`);
    assert.doesNotMatch(model.id, /moonshine-(?:(?:base|tiny)-(?:ar|ja|ko|uk|vi|zh)|base-es)-gguf$/);
  }
});

test("speech catalog licences are reviewed and linked", () => {
  const reviewed = new Map(
    Object.entries(REVIEWED_LICENSES).filter(([, entry]) => !entry.exclude),
  );
  const reviewedNames = new Set([...reviewed.values()].map((entry) => entry.license));
  for (const model of catalog.models) {
    assert.notEqual(model.license.toLowerCase(), "other", `${model.id} has an unreviewed licence`);
    assert.match(model.licenseUrl, /^https:\/\/[^\s]+$/, `${model.id} licenseUrl`);
    const spdx = SPDX_LICENSE_URLS[model.license];
    if (spdx) assert.equal(model.licenseUrl, spdx, `${model.id} canonical URL`);
    else assert.ok(reviewedNames.has(model.license), `${model.id} licence ${model.license} not reviewed`);
  }
  const ids = new Set(catalog.models.map((model) => model.id));
  for (const [id, entry] of Object.entries(REVIEWED_LICENSES)) {
    const kept = ids.has(`handy-computer/${id}-gguf`);
    if (entry.exclude) {
      assert.ok(!kept, `${id} is excluded but present`);
      assert.ok(entry.reason, `${id} exclusion reason`);
    } else {
      assert.ok(kept, `${id} was reviewed but is missing`);
      assert.ok(entry.license && /^https:\/\//.test(entry.licenseUrl), `${id} review entry`);
    }
  }
  assert.ok(!ids.has("handy-computer/medasr-gguf"), "MedASR stays excluded");
});

test("speech catalog grades re-derive from errorPercent", () => {
  let graded = 0;
  for (const model of catalog.models) {
    if (model.benchmark === null) continue;
    const { accuracy, secondsPer30s } = model.benchmark;
    assert.ok(secondsPer30s === null || (secondsPer30s > 0 && Number(secondsPer30s.toFixed(2)) === secondsPer30s));
    for (const [language, cell] of Object.entries(accuracy)) {
      assert.ok(model.languages.includes(language), `${model.id} grades unlisted ${language}`);
      assert.equal(typeof cell.errorPercent, "number");
      assert.equal(cell.grade, expectedGrade(cell.errorPercent), `${model.id} ${language}`);
      graded++;
    }
  }
  assert.ok(graded > 0);
});

test("speech catalog default, recommended set and VAD", () => {
  const byId = new Map(catalog.models.map((model) => [model.id, model]));
  assert.equal(catalog.defaultModel, "handy-computer/parakeet-unified-en-0.6b-gguf");
  assert.equal(byId.get(catalog.defaultModel)?.recommended, true);
  assert.deepEqual(
    catalog.models.filter((model) => model.recommended).map((model) => model.id).sort(),
    [...RECOMMENDED].sort(),
  );
  assert.deepEqual(Object.keys(catalog.vad), ["id", "revision", "filename", "size", "sha256"]);
  assertFile(catalog.vad, "vad");
  assert.equal(catalog.vad.id, "handy-computer/silero-vad-v6.2-gguf");
  assert.equal(catalog.vad.revision, "97bbd75179f535e4708bccdf61e9278b8b60dfc7");
  assert.equal(catalog.vad.filename, "silero-vad-v6.2-F32.gguf");
});

test("speech catalog helpers match handy's behaviour", () => {
  assert.equal(accuracyGrade(3.99), "A-");
  assert.equal(accuracyGrade(2), "A+");
  assert.equal(accuracyGrade(3.5), "A");
  assert.equal(accuracyGrade(9.99), "B-");
  assert.equal(accuracyGrade(20), "D");
  assert.equal(accuracyGrade(30), "F");
  assert.equal(canonicalLanguage(" EN-us "), "en");
  assert.equal(languageIdentity("iw"), "he");
  assert.equal(languageIdentity("tl-PH"), "fil");
  assert.ok(compareEngineVersions("v0.4.1", "0.4.0") > 0);
  assert.equal(compareEngineVersions("0.4.1", "0.4.1"), 0);
  const data = { transcribeCpp: "0.4.0" };
  const base = {
    id: "x", role: "asr", license: "mit", family: "whisper", quant: "Q8_0",
    files: { Q8_0: { filename: "x.gguf" } },
  };
  assert.equal(exclusionReason(base, data), null);
  assert.match(exclusionReason({ ...base, license: "cc-by-nc-4.0" }, data), /non-commercial/);
  assert.equal(exclusionReason({ ...base, license: "sync" }, data), null);
  assert.match(exclusionReason({ ...base, id: "moonshine-tiny-ja" }, data), /Community/);
  assert.match(exclusionReason({ ...base, family: "sortformer" }, data), /family/);
  assert.match(exclusionReason({ ...base, minEngine: "0.5.0" }, data), /needs engine/);
  assert.match(exclusionReason({ ...base, files: { Q8_0: { filename: "a/x.gguf" } } }, data), /root/);
  assert.match(exclusionReason({ ...base, role: "vad" }, data), /role/);
  assert.match(exclusionReason({ ...base, id: "medasr", license: "other" }, data), /Health AI/);
  assert.deepEqual(licenseFor({ id: "x", license: "mit" }), { license: "mit", licenseUrl: SPDX_LICENSE_URLS.mit });
  assert.equal(licenseFor({ id: "SenseVoiceSmall", license: "other" }).license, "FunASR Model License 1.1");
  assert.throws(() => licenseFor({ id: "unreviewed", license: "other" }), /Review the licence/);
});

// Language names a description may mention, and the codes they require.
const LANGUAGE_NAMES = {
  English: "en", German: "de", Spanish: "es", French: "fr", Italian: "it", Portuguese: "pt",
  Greek: "el", Polish: "pl", Russian: "ru", Arabic: "ar", Japanese: "ja", Korean: "ko",
  Vietnamese: "vi", Mandarin: "zh", Chinese: "zh", Cantonese: "yue", Hindi: "hi", Dutch: "nl",
};

test("speech catalog descriptions are reviewed, not placeholders", () => {
  const reviewed = new Set(Object.values(DESCRIPTIONS));
  assert.equal(Object.keys(DESCRIPTIONS).length, catalog.models.length, "one description per kept model");
  assert.equal(reviewed.size, catalog.models.length, "descriptions are distinct");
  for (const model of catalog.models) {
    const { description, name } = model;
    assert.ok(reviewed.has(description), `${model.id} description is not from DESCRIPTIONS`);
    assert.ok(description.length <= 120, `${model.id} description is ${description.length} chars`);
    assert.match(description, /^[A-Z0-9].*\.$/, `${model.id} description is one sentence`);
    assert.doesNotMatch(description, /speech-to-text/i, `${model.id} restates the placeholder`);
    const restated = description.replace(/\.$/, "").trim().toLowerCase();
    assert.notEqual(restated, name.toLowerCase(), `${model.id} description repeats the name`);
  }
  assert.throws(() => descriptionFor({ id: "unreviewed" }), /reviewed description/);
});

test("speech catalog description language claims match the languages list", () => {
  for (const model of catalog.models) {
    const { description, languages } = model;
    const only = description.match(/\b(\w+)-only\b/);
    if (only) {
      assert.ok(LANGUAGE_NAMES[only[1]], `${model.id} unknown "${only[0]}"`);
      assert.deepEqual(languages, [LANGUAGE_NAMES[only[1]]], `${model.id} says ${only[0]}`);
    }
    if (languages.length === 1) {
      assert.ok(only, `${model.id} has one language but does not say so`);
      assert.doesNotMatch(description, /multilingual|\blanguages\b/i, `${model.id} claims several languages`);
    }
    const count = description.match(/\b(\d+) (?:European )?languages\b/);
    if (count) assert.equal(Number(count[1]), languages.length, `${model.id} says ${count[0]}`);
    for (const [word, code] of Object.entries(LANGUAGE_NAMES)) {
      if (new RegExp(`\\b${word}\\b`).test(description)) {
        assert.ok(languages.includes(code), `${model.id} mentions ${word} but lacks ${code}`);
      }
    }
    if (/translat/i.test(description)) assert.equal(model.supportsTranslation, true, `${model.id} translation`);
    if (/streaming/i.test(description)) assert.equal(model.supportsStreaming, true, `${model.id} streaming`);
    if (/language detection/i.test(description)) {
      assert.equal(model.supportsLanguageDetection, true, `${model.id} language detection`);
    }
  }
});
