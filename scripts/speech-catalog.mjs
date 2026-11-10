#!/usr/bin/env node
// Generates src-tauri/src/voice/local/catalog.json, the vendored catalog of
// built-in local speech models, from an unpacked @handy-computer/models
// package (MIT). Offline and dependency-free; ported from T3 Code's
// apps/server/scripts/speech-catalog.ts (pingdotgg/t3code@357fb75) and the
// helpers it imports from @handy-computer/models@0.2.3.
//
//   node scripts/speech-catalog.mjs --source <dir>/package [--check]

import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const SOURCE_PACKAGE = "@handy-computer/models";
export const SOURCE_VERSION = "0.2.3";
export const ENGINE_VERSION = "0.4.1";
export const GENERATED_BY = "scripts/speech-catalog.mjs";
export const DEFAULT_MODEL = "handy-computer/parakeet-unified-en-0.6b-gguf";
export const VAD_MODEL_ID = "silero-vad-v6.2";
export const BENCHMARK_DICTATION_SECONDS = 30;

export const TARGET = fileURLToPath(
  new URL("../src-tauri/src/voice/local/catalog.json", import.meta.url),
);

// ASR architectures registered in transcribe.cpp v0.4.1's src/transcribe-arch.cpp.
export const ASR_FAMILIES = new Set([
  "parakeet", "cohere_asr", "canary", "qwen3_asr", "moss", "voxtral",
  "voxtral_realtime", "canary_qwen", "whisper", "moonshine",
  "moonshine_streaming", "sensevoice", "funasr_nano", "gigaam",
  "granite_speech", "granite_speech_nar", "granite5_ctc", "medasr",
]);

// Handy's onboarding badges.
export const RECOMMENDED = new Set([
  "parakeet-unified-en-0.6b",
  "nemotron-3.5-asr-streaming-0.6b",
  "canary-180m-flash",
  "cohere-transcribe-03-2026",
  "whisper-medium",
]);

export const NON_COMMERCIAL_LICENSE = /(?:^|[^a-z0-9])nc(?:$|[^a-z0-9])/i;
// Handy labels these MIT; Moonshine lists them under its Community License
// (https://huggingface.co/moonshine-ai/moonshine-models).
export const COMMUNITY_LICENSED_MOONSHINE =
  /^moonshine-(?:(?:base|tiny)-(?:ar|ja|ko|uk|vi|zh)|base-es)$/;

// Canonical licence pages for the SPDX ids the source package uses.
export const SPDX_LICENSE_URLS = {
  "apache-2.0": "https://www.apache.org/licenses/LICENSE-2.0",
  mit: "https://opensource.org/license/mit",
  "cc-by-4.0": "https://creativecommons.org/licenses/by/4.0/",
  "cc-by-sa-4.0": "https://creativecommons.org/licenses/by-sa/4.0/",
};

const NVIDIA_OPEN_MODEL_LICENSE = {
  license: "NVIDIA Open Model License",
  licenseUrl: "https://www.nvidia.com/en-us/agreements/enterprise-software/nvidia-open-model-license/",
};
const FUNASR_MODEL_LICENSE = {
  license: "FunASR Model License 1.1",
  licenseUrl: "https://github.com/modelscope/FunASR/blob/main/MODEL_LICENSE",
};

// Reviewed source models whose licence is "other" (checked 2026-11-09 against
// huggingface.co/handy-computer/<id>-gguf and the upstream base_model card).
// Each is kept with a precise licence name and link, or excluded with a reason.
export const REVIEWED_LICENSES = {
  // nvidia/nemotron-3.5-asr-streaming-0.6b: OpenMDW-1.1, permissive.
  "nemotron-3.5-asr-streaming-0.6b": { license: "OpenMDW-1.1", licenseUrl: "https://openmdw.ai/license/1-1/" },
  // nvidia/nemotron-speech-streaming-en-0.6b: commercial use allowed.
  "nemotron-speech-streaming-en-0.6b": NVIDIA_OPEN_MODEL_LICENSE,
  // nvidia/multitalker-parakeet-streaming-0.6b-v1: commercial use allowed.
  "multitalker-parakeet-streaming-0.6b-v1": NVIDIA_OPEN_MODEL_LICENSE,
  // FunAudioLLM/Fun-ASR-*-Nano-2512 tag apache-2.0; the GGUF conversion ships the
  // FunASR Model License 1.1 (use, modify, share with attribution). Label the stricter one.
  "Fun-ASR-Nano-2512": FUNASR_MODEL_LICENSE,
  "Fun-ASR-MLT-Nano-2512": FUNASR_MODEL_LICENSE,
  // FunAudioLLM/SenseVoiceSmall: FunASR Model License 1.1.
  SenseVoiceSmall: FUNASR_MODEL_LICENSE,
  // google/medasr is gated under the Health AI Developer Foundations terms, which
  // impose use restrictions (Prohibited Use Policy, clinical-use limits) that must
  // flow down to every user and let Google restrict use remotely.
  medasr: {
    exclude: true,
    reason: "Health AI Developer Foundations terms (use restrictions, https://developers.google.com/health-ai-developer-foundations/terms)",
  },
};

/** The licence name and link a kept model shows; throws when it has not been reviewed. */
export function licenseFor(model) {
  const reviewed = REVIEWED_LICENSES[model.id];
  if (reviewed && !reviewed.exclude) return { license: reviewed.license, licenseUrl: reviewed.licenseUrl };
  const licenseUrl = SPDX_LICENSE_URLS[model.license];
  if (!licenseUrl) throw new Error(`Review the licence of ${model.id} (${model.license}) before including it.`);
  return { license: model.license, licenseUrl };
}

// Reviewed one-line descriptions, keyed by source model id (checked 2026-11-09
// against each catalog entry's languages, size, flags and benchmark, and the
// upstream Hugging Face model card). Plain and factual: every kept model needs
// one, and language claims must match its languages list.
export const DESCRIPTIONS = {
  "parakeet-unified-en-0.6b": "English-only 0.6B Parakeet with streaming; fast and accurate for everyday dictation.",
  "nemotron-3.5-asr-streaming-0.6b": "Streaming 0.6B NVIDIA model for 28 languages across Europe and Asia, with language detection.",
  "canary-180m-flash": "Small 180M Canary for English, German, Spanish and French; quick on any hardware and can translate.",
  "cohere-transcribe-03-2026": "2B Cohere model for 14 languages, from Italian, Greek and Polish to Arabic, Japanese and Vietnamese.",
  "whisper-medium": "Mid-size OpenAI Whisper for 99 languages, with language detection and translation; slower on CPU.",
  "Voxtral-Mini-4B-Realtime-2602": "4B Mistral Voxtral with streaming for 13 languages; best on Apple Silicon or a discrete GPU.",
  "parakeet-ultra": "Moondream's retrained Parakeet TDT v3 for 25 European languages; more accurate in noise and on long audio.",
  "parakeet-tdt-0.6b-v3": "NVIDIA's 0.6B Parakeet TDT v3 for 25 European languages, with language detection; fast on any hardware.",
  "parakeet-tdt-0.6b-v2": "English-only 0.6B Parakeet TDT v2 from NVIDIA; fast and accurate on any hardware.",
  "Qwen3-ASR-0.6B": "Alibaba's 0.6B Qwen3-ASR for 30 languages including Mandarin and Cantonese, with language detection.",
  "Fun-ASR-MLT-Nano-2512": "0.8B Fun-ASR for 31 languages, mostly Asian and European; the lowest Japanese error rate here.",
  "canary-1b-v2": "NVIDIA's 1B Canary v2 for 25 European languages, with translation to and from English.",
  "canary-qwen-2.5b": "English-only 2.5B Canary-Qwen from NVIDIA; very accurate but slow without a GPU.",
  "cohere-transcribe-arabic-07-2026": "2B Cohere model tuned for Arabic, which also transcribes English.",
  "Fun-ASR-Nano-2512": "0.8B Fun-ASR for Mandarin, English and Japanese.",
  "gigaam-v3-e2e-ctc": "Russian-only GigaAM v3 CTC that outputs punctuated, normalized text; very fast.",
  "gigaam-v3-e2e-rnnt": "Russian-only GigaAM v3 RNN-T that outputs punctuated, normalized text; slower than the CTC variant.",
  "granite-speech-5.0-470m-turboctc": "English-only 470M IBM Granite Speech 5.0 with a CTC decoder; fast, especially on a GPU.",
  "granite-speech-4.1-2b": "IBM's 2B Granite Speech 4.1 for English, French, German, Spanish, Portuguese and Japanese, with translation.",
  "parakeet-tdt_ctc-110m": "English-only 110M Parakeet; a small download that is near-instant even on CPU.",
  "multitalker-parakeet-streaming-0.6b-v1": "English-only streaming Parakeet for overlapping speakers in meetings, not solo dictation.",
  "Qwen3-ASR-1.7B": "Alibaba's 1.7B Qwen3-ASR for 30 languages including Mandarin and Cantonese; best on Apple Silicon or a GPU.",
  SenseVoiceSmall: "Small, fast model for Mandarin, English, Japanese and Korean; lists Cantonese but is weak at it.",
  "Voxtral-Mini-3B-2507": "Mistral's Voxtral Mini 3B for 8 languages, with translation; best on Apple Silicon or a GPU.",
  "whisper-small": "Small OpenAI Whisper for 99 languages, with language detection and translation.",
  "whisper-large-v3-turbo": "Pruned, faster Whisper Large v3 for 100 languages, with language detection; slow without a GPU.",
  "Breeze-ASR-25": "Whisper fine-tune for Taiwanese Mandarin mixed with English; Traditional script, no punctuation.",
  "whisper-large-v3": "OpenAI's Whisper Large v3 for 100 languages, with language detection and translation; best with a GPU.",
  "canary-1b-flash": "NVIDIA's 1B Canary Flash for English, German, Spanish and French, with translation; fast.",
  "gigaam-v3-ctc": "Russian-only GigaAM v3 CTC; very fast, without the punctuation of the end-to-end variant.",
  "gigaam-v3-rnnt": "Russian-only GigaAM v3 RNN-T; without the punctuation of the end-to-end variant.",
  "granite-4.0-1b-speech": "IBM's Granite Speech 4.0 for English, French, German, Spanish, Portuguese and Japanese, with translation.",
  "granite-speech-4.1-2b-nar": "Non-autoregressive Granite Speech 4.1 for English, French, German, Spanish and Portuguese.",
  "granite-speech-4.1-2b-plus": "Granite Speech 4.1 Plus for English, French, German, Spanish and Portuguese, with word timestamps.",
  "moonshine-base": "English-only 62M Moonshine; a small, fast download with lower accuracy than larger models.",
  "moonshine-streaming-medium": "English-only streaming Moonshine; the most accurate of the three streaming sizes.",
  "moonshine-streaming-small": "English-only streaming Moonshine; between the tiny and medium sizes in speed and accuracy.",
  "moonshine-streaming-tiny": "English-only 44M streaming Moonshine; very small and fast, with low accuracy.",
  "moonshine-tiny": "English-only 27M Moonshine, the smallest download here; very fast, with low accuracy.",
  "MOSS-Transcribe-Diarize": "0.9B MOSS model for English and Mandarin, built for long recordings with several speakers.",
  "nemotron-speech-streaming-en-0.6b": "English-only streaming 0.6B Nemotron from NVIDIA, for low-latency live transcription.",
  orukeet: "Oruk AI's retrained Parakeet TDT v3 for 25 European languages, with lower error rates than the original.",
  "parakeet-ctc-0.6b": "English-only 0.6B Parakeet with a CTC decoder; fast on any hardware.",
  "parakeet-ctc-1.1b": "English-only 1.1B Parakeet with a CTC decoder; larger and slower than the 0.6B.",
  "parakeet-primeline": "Primeline's Parakeet TDT v3 fine-tuned for German, still covering 25 European languages.",
  "parakeet-rnnt-0.6b": "English-only 0.6B Parakeet with an RNN-T decoder; fast on any hardware.",
  "parakeet-rnnt-1.1b": "English-only 1.1B Parakeet with an RNN-T decoder; larger and slower than the 0.6B.",
  "parakeet-tdt_ctc-1.1b": "English-only 1.1B Parakeet with a hybrid TDT-CTC decoder.",
  "parakeet-tdt-1.1b": "English-only 1.1B Parakeet TDT; larger and slower than the 0.6B v2.",
  "Voxtral-Small-24B-2507": "Mistral's 24B Voxtral Small for 8 languages, with translation; a 26 GB download that needs lots of memory.",
  "whisper-base": "Small Whisper Base for 99 languages, with language detection and translation; fast but less accurate.",
  "whisper-base.en": "English-only Whisper Base; small and fast, with a lower English error rate than the 99-language Base.",
  "whisper-large": "Original Whisper Large (v1) for 99 languages, with language detection and translation; slow without a GPU.",
  "whisper-large-v2": "Whisper Large v2 for 99 languages, with language detection and translation; slow without a GPU.",
  "whisper-medium.en": "English-only Whisper Medium; accurate, but slower than Parakeet models of similar size.",
  "whisper-small.en": "English-only Whisper Small; compact, with moderate speed and accuracy.",
  "whisper-tiny": "Smallest Whisper, for 99 languages with language detection and translation; very fast, low accuracy.",
  "whisper-tiny.en": "English-only Whisper Tiny; very small and fast, with low accuracy.",
};

/** The reviewed description of a kept model; throws when it has none. */
export function descriptionFor(model) {
  const description = DESCRIPTIONS[model.id];
  if (!description) throw new Error(`Write a reviewed description for ${model.id} before including it.`);
  return description;
}

const ROOT_GGUF = /^[^/\\:]+\.gguf$/;
const REPOSITORY = /^\w[\w.-]*\/\w[\w.-]*$/;
const REVISION = /^[a-f0-9]{40}$/;
const SHA256 = /^[a-f0-9]{64}$/;

const ACCURACY_CEILINGS = { A: 5, B: 10, C: 20, D: 30 };
const SUB_GRADE_STEP = Math.cbrt(2);
const LANGUAGE_ALIASES = { tl: "fil", no: "nb", iw: "he", jw: "jv" };

/** A base code (`en-US` → `en`). */
export function canonicalLanguage(language) {
  return language.trim().toLowerCase().split("-", 1)[0] ?? "";
}

/** The identity benchmarks are keyed by (legacy aliases folded). */
export function languageIdentity(language) {
  const base = canonicalLanguage(language);
  return LANGUAGE_ALIASES[base] ?? base;
}

/** Compare "0.4.0"-style versions (a leading "v" is ignored). */
export function compareEngineVersions(left, right) {
  const parse = (version) =>
    version.trim().replace(/^v/, "").split(/[.+-]/, 3).map((part) => Number.parseInt(part, 10) || 0);
  const [a, b] = [parse(left), parse(right)];
  for (let index = 0; index < 3; index++) {
    const difference = (a[index] ?? 0) - (b[index] ?? 0);
    if (difference !== 0) return difference;
  }
  return 0;
}

/** handy's accuracyGrade label: A<5, B<10, C<20, D<30, else F; A–C get +/plain/-. */
export function accuracyGrade(errorPercent) {
  if (errorPercent >= ACCURACY_CEILINGS.D) return "F";
  if (errorPercent >= ACCURACY_CEILINGS.C) return "D";
  const [letter, ceiling] = [["A", ACCURACY_CEILINGS.A], ["B", ACCURACY_CEILINGS.B], ["C", ACCURACY_CEILINGS.C]]
    .find(([, limit]) => errorPercent < limit);
  const modifier =
    errorPercent < ceiling / SUB_GRADE_STEP ** 2 ? "+" : errorPercent < ceiling / SUB_GRADE_STEP ? "" : "-";
  return `${letter}${modifier}`;
}

function modelFile(model) {
  const file = model.files?.[model.quant];
  if (!file) throw new Error(`${model.id} has no ${model.quant} file`);
  return file;
}

/** Why a source model is left out, or null when it is kept. */
export function exclusionReason(model, data, engineVersion = ENGINE_VERSION) {
  if (model.role !== "asr") return `role ${model.role}`;
  if (NON_COMMERCIAL_LICENSE.test(model.license)) return `non-commercial licence ${model.license}`;
  const reviewed = REVIEWED_LICENSES[model.id];
  if (reviewed?.exclude) return reviewed.reason;
  if (COMMUNITY_LICENSED_MOONSHINE.test(model.id)) return "Moonshine Community License";
  if (!ASR_FAMILIES.has(model.family)) return `family ${model.family} not in engine ${engineVersion}`;
  const minEngine = model.minEngine ?? data.transcribeCpp;
  if (compareEngineVersions(minEngine, engineVersion) > 0) return `needs engine ${minEngine}`;
  const { filename } = modelFile(model);
  if (!ROOT_GGUF.test(filename) || filename.startsWith(".")) return `file ${filename} is not a root .gguf`;
  return null;
}

function validateFile(model, file) {
  const valid =
    REPOSITORY.test(model.repository) &&
    REVISION.test(model.revision) &&
    SHA256.test(file.sha256) &&
    Number.isSafeInteger(file.size) &&
    file.size > 0;
  if (!valid) throw new Error(`Invalid speech catalog metadata: ${model.id}`);
}

function benchmarkFor(result, languages) {
  if (!result) return null;
  const accuracy = {};
  for (const language of languages) {
    const cell = result.accuracy?.[languageIdentity(language)];
    if (cell) accuracy[language] = { grade: accuracyGrade(cell.error), errorPercent: cell.error };
  }
  const factor = result.performance?.accelerated;
  const secondsPer30s = factor ? Number((BENCHMARK_DICTATION_SECONDS / factor).toFixed(2)) : null;
  return { accuracy, secondsPer30s };
}

function catalogEntry(model, data) {
  const file = modelFile(model);
  validateFile(model, file);
  if (model.languages.length === 0) throw new Error(`Invalid speech catalog metadata: ${model.id}`);
  const languages = [...new Set(model.languages.map(canonicalLanguage))];
  const entry = {
    id: model.repository,
    revision: model.revision,
    name: model.name,
    description: descriptionFor(model),
    filename: file.filename,
    size: file.size,
    sha256: file.sha256,
    ...licenseFor(model),
    languages,
    benchmark: benchmarkFor(data.results?.[model.id], languages),
    recommended: RECOMMENDED.has(model.id),
    supportsStreaming: model.capabilities.streaming === true,
    supportsLanguageDetection: model.capabilities.languageDetection === true,
    supportsTranslation: model.capabilities.translate === true,
  };
  if (Number.isSafeInteger(model.maxAudioMs)) entry.maxAudioMs = model.maxAudioMs;
  const longForm = model.capabilities.longForm ?? model.supportsLongForm;
  if (typeof longForm === "boolean") entry.supportsLongForm = longForm;
  return entry;
}

function vadEntry(data) {
  const model = data.models.find((candidate) => candidate.id === VAD_MODEL_ID && candidate.role === "vad");
  if (!model) throw new Error(`Source catalog has no ${VAD_MODEL_ID} VAD model.`);
  const file = modelFile(model);
  validateFile(model, file);
  return { id: model.repository, revision: model.revision, filename: file.filename, size: file.size, sha256: file.sha256 };
}

/** Builds the vendored catalog plus the list of excluded source models. */
export function generateSpeechCatalog(data, sourceVersion, engineVersion = ENGINE_VERSION) {
  if (data?.schema !== 2) throw new Error("Unsupported speech catalog schema.");
  if (engineVersion !== ENGINE_VERSION) throw new Error("Review speech catalog loader support for this engine.");
  const ids = new Set();
  const filenames = new Set();
  const models = [];
  const excluded = [];
  for (const model of data.models) {
    const reason = exclusionReason(model, data, engineVersion);
    if (reason) {
      excluded.push({ id: model.id, reason });
      continue;
    }
    const entry = catalogEntry(model, data);
    if (ids.has(entry.id) || filenames.has(entry.filename)) {
      throw new Error(`Duplicate speech catalog model or filename: ${model.id}`);
    }
    ids.add(entry.id);
    filenames.add(entry.filename);
    models.push(entry);
  }
  const fallback = models.find((entry) => entry.id === DEFAULT_MODEL);
  if (!fallback?.recommended) throw new Error(`Default model ${DEFAULT_MODEL} is missing or not recommended.`);
  const catalog = {
    source: SOURCE_PACKAGE,
    sourceVersion,
    engineVersion,
    generated: GENERATED_BY,
    vad: vadEntry(data),
    defaultModel: DEFAULT_MODEL,
    models,
  };
  return { catalog, excluded };
}

export function renderSpeechCatalog(catalog) {
  return `${JSON.stringify(catalog, null, 2)}\n`;
}

function parseArgs(argv) {
  const sourceIndex = argv.indexOf("--source");
  const source = sourceIndex >= 0 ? argv[sourceIndex + 1] : undefined;
  if (!source) throw new Error("Usage: node scripts/speech-catalog.mjs --source <package dir> [--check]");
  return { source: resolve(source), check: argv.includes("--check"), verbose: argv.includes("--verbose") };
}

function main(argv) {
  const { source, check, verbose } = parseArgs(argv);
  const manifest = JSON.parse(readFileSync(join(source, "package.json"), "utf8"));
  if (manifest.name !== SOURCE_PACKAGE || manifest.version !== SOURCE_VERSION) {
    throw new Error(`Expected ${SOURCE_PACKAGE}@${SOURCE_VERSION}, found ${manifest.name}@${manifest.version}.`);
  }
  const data = JSON.parse(readFileSync(join(source, "catalog.json"), "utf8"));
  const { catalog, excluded } = generateSpeechCatalog(data, manifest.version);
  const expected = renderSpeechCatalog(catalog);
  if (verbose) for (const { id, reason } of excluded) console.log(`excluded ${id}: ${reason}`);
  if (check) {
    let current = "";
    try {
      current = readFileSync(TARGET, "utf8");
    } catch (error) {
      throw new Error(`Cannot read ${TARGET}: ${error.message}`);
    }
    if (current !== expected) throw new Error("Speech catalog differs; rerun without --check to regenerate.");
    console.log(`Speech catalog matches ${SOURCE_PACKAGE}@${manifest.version} (${catalog.models.length} models).`);
    return;
  }
  writeFileSync(TARGET, expected);
  console.log(`Wrote ${catalog.models.length} models from ${SOURCE_PACKAGE}@${manifest.version}; excluded ${excluded.length}.`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    main(process.argv.slice(2));
  } catch (error) {
    console.error(error.message);
    process.exit(1);
  }
}
