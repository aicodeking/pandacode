//! The downloadable model catalog. Nothing is bundled with the app: the user
//! picks a model in Settings → Voice and it downloads once (pinned URL, size
//! cap, SHA-256 where the source publishes one) into `<data>/voice/models`.
//! Sources are the k2-fsa sherpa-onnx model collections on Hugging Face and
//! GitHub; licenses are noted per model and credited in docs/voice.md.

use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

/// Hard ceiling per download, well above the largest catalog file.
pub(crate) const MAX_FILE_BYTES: u64 = 800_000_000;

pub const FINAL_DEFAULT: &str = "moonshine-base";
/// The streaming model that provides live partials for the sherpa engine.
pub const LIVE_DEFAULT: &str = "live-en";
/// Punctuation restoration for the streaming result (English).
pub const PUNCT_DEFAULT: &str = "punct-en";

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    /// Offline quality pass, run when recording stops.
    Final,
    /// Streaming model producing live partials while recording.
    Live,
    /// Punctuation/casing restoration for streaming text.
    Punct,
}

#[derive(Clone, Copy, Debug)]
pub struct File {
    pub name: &'static str,
    pub size: u64,
    /// SHA-256 from the source (Hugging Face LFS oid); `None` pins size only.
    pub sha256: Option<&'static str>,
}

#[derive(Clone, Copy, Debug)]
pub struct Model {
    pub id: &'static str,
    pub label: &'static str,
    pub kind: Kind,
    /// Languages in rough terms, for the picker (`en`, `zh/en/ja/ko/yue`, …).
    pub languages: &'static str,
    pub license: &'static str,
    pub files: &'static [File],
    /// Hugging Face repo (`<owner>/<name>`) the files resolve from.
    pub repo: &'static str,
}

const HF: &str = "https://huggingface.co";
/// The only non-HF source: k2-fsa's GitHub release (no per-file digest,
/// ~30.7 MB, size-pinned at extraction).
const PUNCT_URL: &str = "https://github.com/k2-fsa/sherpa-onnx/releases/download/punctuation-models/sherpa-onnx-online-punct-en-2024-08-06.tar.bz2";

pub const CATALOG: &[Model] = &[
    Model {
        id: "live-en",
        label: "Live English (streaming)",
        kind: Kind::Live,
        languages: "en",
        license: "Apache-2.0",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-en-2023-06-26",
        files: &[
            File { name: "encoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx", size: 71_082_637, sha256: Some("0d072fd4ef956294ba9db9e9a71a541ac70659095ec4934c8453d8b2fe740187") },
            File { name: "decoder-epoch-99-avg-1-chunk-16-left-64.int8.onnx", size: 1_307_236, sha256: Some("98da299f471e38bb4e1a8df579b8cc9122d6039576a77e357b3c60f17dd83b02") },
            File { name: "joiner-epoch-99-avg-1-chunk-16-left-64.int8.onnx", size: 259_335, sha256: Some("d944208d660d67c8d72cd2acaeac971fa5ceb8c80e76c1968148846fedd6e297") },
            File { name: "tokens.txt", size: 5_048, sha256: None },
        ],
    },
    Model {
        id: "live-zh-en",
        label: "Live Chinese/English (streaming)",
        kind: Kind::Live,
        languages: "zh/en",
        license: "Apache-2.0",
        repo: "csukuangfj/sherpa-onnx-streaming-zipformer-bilingual-zh-en-2023-02-20",
        files: &[
            File { name: "encoder-epoch-99-avg-1.int8.onnx", size: 181_895_032, sha256: Some("8fa764187a261844f859d7143ebaa563af5d10adfece4c18a8f414c88cba2a9b") },
            File { name: "decoder-epoch-99-avg-1.int8.onnx", size: 13_091_040, sha256: Some("1a70c593d71e53f023f5f55b0b4cfff5055abb786ee3992e5f63dc2e273cc4fa") },
            File { name: "joiner-epoch-99-avg-1.int8.onnx", size: 3_228_404, sha256: Some("1ed689c5ed19dbaa725d9d191bb4822b5f4855a39e1ffd28cbc1f340d25b2ee0") },
            File { name: "tokens.txt", size: 56_317, sha256: None },
        ],
    },
    Model {
        id: "punct-en",
        label: "Live punctuation (English)",
        kind: Kind::Punct,
        languages: "en",
        license: "Apache-2.0",
        repo: "",
        files: &[
            File { name: "model.int8.onnx", size: 0, sha256: None },
            File { name: "bpe.vocab", size: 0, sha256: None },
        ],
    },
    Model {
        id: "sense-voice",
        label: "SenseVoice Small",
        kind: Kind::Final,
        languages: "zh/en/ja/ko/yue",
        license: "FunASR Model License (attribution required)",
        repo: "csukuangfj/sherpa-onnx-sense-voice-zh-en-ja-ko-yue-2024-07-17",
        files: &[
            File { name: "model.int8.onnx", size: 239_233_841, sha256: Some("c71f0ce00bec95b07744e116345e33d8cbbe08cef896382cf907bf4b51a2cd51") },
            File { name: "tokens.txt", size: 315_894, sha256: None },
        ],
    },
    Model {
        id: "moonshine-base",
        label: "Moonshine Base",
        kind: Kind::Final,
        languages: "en",
        license: "MIT",
        repo: "csukuangfj/sherpa-onnx-moonshine-base-en-int8",
        files: &[
            File { name: "preprocess.onnx", size: 14_077_290, sha256: Some("ffa630d395c5ccf76f5d4954be5b882df76aaf6491519ec01fd82ea7a3819fb2") },
            File { name: "encode.int8.onnx", size: 50_311_494, sha256: Some("7e38770f776f2e5583a53b052936005df2ba5c833d7e09c2a5fd796b94bf73e2") },
            File { name: "cached_decode.int8.onnx", size: 99_983_837, sha256: Some("2db74e51cedf64a8b1be3c8192e0bb5e4923af0e90bd9e87f8e8771873f8ea03") },
            File { name: "uncached_decode.int8.onnx", size: 122_120_451, sha256: Some("c01f4b35093bcac20d352d23a75a539e772964579f9d024a90e5e6f09cae9987") },
            File { name: "tokens.txt", size: 436_688, sha256: None },
        ],
    },
    Model {
        id: "moonshine-tiny",
        label: "Moonshine Tiny",
        kind: Kind::Final,
        languages: "en",
        license: "MIT",
        repo: "csukuangfj/sherpa-onnx-moonshine-tiny-en-int8",
        files: &[
            File { name: "preprocess.onnx", size: 6_800_738, sha256: Some("f33addce61a143460fe753b5ee5b7db255e5140b5b779c065b94f6c83ff0bf4e") },
            File { name: "encode.int8.onnx", size: 18_249_187, sha256: Some("8774dfba578de027ec6595c2c654a0836434489bc963a0db124a7f181f571acb") },
            File { name: "cached_decode.int8.onnx", size: 45_264_830, sha256: Some("2aff28bba6a03d8dcf5c9feac45462629bae37317442299f28115ad09da773f6") },
            File { name: "uncached_decode.int8.onnx", size: 53_216_096, sha256: Some("216737000dd5881a17aa043f6bbd286add33e4c3b0ae257153e2ec15438bdc41") },
            File { name: "tokens.txt", size: 436_688, sha256: None },
        ],
    },
    Model {
        id: "parakeet-v3",
        label: "Parakeet TDT 0.6B v3",
        kind: Kind::Final,
        languages: "25 European",
        license: "CC-BY-4.0",
        repo: "csukuangfj/sherpa-onnx-nemo-parakeet-tdt-0.6b-v3-int8",
        files: &[
            File { name: "encoder.int8.onnx", size: 652_184_281, sha256: Some("acfc2b4456377e15d04f0243af540b7fe7c992f8d898d751cf134c3a55fd2247") },
            File { name: "decoder.int8.onnx", size: 11_845_275, sha256: Some("179e50c43d1a9de79c8a24149a2f9bac6eb5981823f2a2ed88d655b24248db4e") },
            File { name: "joiner.int8.onnx", size: 6_355_277, sha256: Some("3164c13fc2821009440d20fcb5fdc78bff28b4db2f8d0f0b329101719c0948b3") },
            File { name: "tokens.txt", size: 93_939, sha256: None },
        ],
    },
    Model {
        id: "whisper-small",
        label: "Whisper Small",
        kind: Kind::Final,
        languages: "99",
        license: "MIT",
        repo: "csukuangfj/sherpa-onnx-whisper-small",
        files: &[
            File { name: "small-encoder.int8.onnx", size: 112_442_483, sha256: Some("4cbe7b22fa9026b843b60a68640c747de05bafb1a11b57edc0e66c232d9f33a9") },
            File { name: "small-decoder.int8.onnx", size: 262_226_114, sha256: Some("acad50b5c782696e91b55914cc5ab4f756f1532f76e22aa6fc615f39fb69a8ee") },
            File { name: "small-tokens.txt", size: 816_730, sha256: None },
        ],
    },
];

pub fn find(id: &str) -> Option<&'static Model> {
    CATALOG.iter().find(|model| model.id == id)
}

/// Total download size of a model (zero-size punct entries are measured live).
pub fn total_size(model: &Model) -> u64 {
    model.files.iter().map(|file| file.size).sum()
}

/// Offline models worth defaulting to, best-first per language.
pub fn defaults_for_language(language: &str) -> &'static [&'static str] {
    let code = language.split(['-', '_']).next().unwrap_or("auto");
    match code {
        "zh" | "ja" | "ko" | "yue" => &["sense-voice", "whisper-small"],
        "en" => &["moonshine-base", "sense-voice", "moonshine-tiny"],
        _ => &["sense-voice", "whisper-small", "moonshine-base"],
    }
}

/// The live (streaming) model matching a language hint.
pub fn live_for_language(language: &str) -> &'static str {
    let code = language.split(['-', '_']).next().unwrap_or("auto");
    if code == "zh" {
        "live-zh-en"
    } else {
        LIVE_DEFAULT
    }
}

pub fn installed(dir: &std::path::Path, id: &str) -> bool {
    find(id).is_some_and(|model| model.files.iter().all(|file| file_present(dir, model, file)))
}

/// `punct-en` keeps the tar's names (`model.int8.onnx`, `bpe.vocab`); every
/// other model stores its files verbatim under `<dir>/<model-id>/`.
pub fn file_path(dir: &std::path::Path, model: &Model, file: &File) -> std::path::PathBuf {
    dir.join(model.id).join(file.name)
}

fn file_present(dir: &std::path::Path, model: &Model, file: &File) -> bool {
    // Zero-size catalog entries (the punct archive contents) count as present
    // once the extraction wrote them; size is not a check for them.
    let path = file_path(dir, model, file);
    match std::fs::metadata(&path) {
        Ok(meta) => file.size == 0 || meta.len() == file.size,
        Err(_) => false,
    }
}

/// Verifies one downloaded file against its pinned size and digest.
pub fn verify(bytes: &[u8], file: &File) -> Result<(), String> {
    if file.size > 0 && bytes.len() as u64 != file.size {
        return Err(format!(
            "{} downloaded {} bytes, expected {}",
            file.name,
            bytes.len(),
            file.size
        ));
    }
        if let Some(expected) = file.sha256 {
            let digest = hex_sha256(bytes);
            if digest != expected {
                return Err(format!("{} failed its SHA-256 check", file.name));
            }
        }
    Ok(())
}

pub fn hex_sha256(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    let digest = hasher.finalize();
    digest.iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Source URL for one catalog file.
pub fn file_url(model: &Model, file: &File) -> String {
    if model.repo.is_empty() {
        // The punctuation archive; files are extracted from it, never fetched
        // one by one, so this URL is only meaningful for documentation/tests.
        PUNCT_URL.to_string()
    } else {
        format!("{}/{}/resolve/main/{}", HF, model.repo, file.name)
    }
}

/// Files a working local setup needs, given language and fast-mode preferences:
/// the live streamer, the final model (unless fast mode skips it) and, for
/// English, the punctuation restorer.
pub fn required_models(language: &str, fast_mode: bool, final_id: &str) -> Vec<&'static str> {
    let mut needed = vec![live_for_language(language)];
    if !fast_mode {
        if let Some(entry) = find(final_id) {
            needed.push(entry.id);
        }
    }
    let code = language.split(['-', '_']).next().unwrap_or("auto");
    if code == "en" || code == "auto" {
        needed.push(PUNCT_DEFAULT);
    }
    needed
}

/// What the picker shows: catalog entries with their install state.
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ModelStatus {
    pub id: String,
    pub label: String,
    pub kind: Kind,
    pub languages: String,
    pub license: String,
    pub size: u64,
    pub installed: bool,
    pub downloading: bool,
    pub progress: f32,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir() -> std::path::PathBuf {
        let dir = std::env::temp_dir().join(format!("pandacode-voice-model-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn catalog_is_complete_and_unique() {
        assert!(CATALOG.len() >= 8);
        let mut ids: Vec<_> = CATALOG.iter().map(|model| model.id).collect();
        ids.sort_unstable();
        ids.dedup();
        assert_eq!(ids.len(), CATALOG.len());
        for model in CATALOG {
            if model.kind == Kind::Punct {
                continue; // extracted from the archive, sizes unknown upfront
            }
            let total = total_size(model);
            assert!(total > 1_000_000, "{} looks too small", model.id);
            assert!(total < MAX_FILE_BYTES * model.files.len() as u64 + 1);
            for file in model.files {
                assert!(!model.repo.is_empty() || model.id == "punct-en");
                assert!(!file.name.is_empty());
            }
        }
    }

    #[test]
    fn pinned_digests_have_the_right_shape() {
        for model in CATALOG {
            for file in model.files {
                if let Some(sha) = file.sha256 {
                    assert_eq!(sha.len(), 64, "{}:{}", model.id, file.name);
                }
            }
        }
    }

    #[test]
    fn verify_checks_size_and_digest() {
        let sha: &'static str = Box::leak(hex_sha256(b"hello").into_boxed_str());
        let file = File { name: "x.onnx", size: 5, sha256: Some(sha) };
        assert!(verify(b"hello", &file).is_ok());
        assert!(verify(b"hell", &file).is_err());
        assert!(verify(b"hello!", &file).is_err());
        let sized = File { name: "x.onnx", size: 3, sha256: None };
        assert!(verify(b"abc", &sized).is_ok());
        assert!(verify(b"abcd", &sized).is_err());
    }

    #[test]
    fn install_detection_needs_every_file() {
        let dir = temp_dir();
        let model = find("sense-voice").unwrap();
        assert!(!installed(&dir, "sense-voice"));
        for file in model.files {
            let path = file_path(&dir, model, file);
            std::fs::create_dir_all(path.parent().unwrap()).unwrap();
            std::fs::write(&path, vec![0u8; file.size as usize]).unwrap();
        }
        assert!(installed(&dir, "sense-voice"));
        std::fs::write(file_path(&dir, model, &model.files[0]), b"bad").unwrap();
        assert!(!installed(&dir, "sense-voice"));
        std::fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn language_defaults_prefer_the_right_models() {
        assert_eq!(defaults_for_language("zh")[0], "sense-voice");
        assert_eq!(defaults_for_language("en")[0], "moonshine-base");
        assert_eq!(defaults_for_language("auto")[0], "sense-voice");
        assert_eq!(live_for_language("zh"), "live-zh-en");
        assert_eq!(live_for_language("en"), "live-en");
        assert_eq!(live_for_language("auto"), "live-en");
    }

    #[test]
    fn required_models_follow_fast_mode_and_language() {
        let needed = required_models("en", false, "moonshine-base");
        assert_eq!(needed, vec!["live-en", "moonshine-base", "punct-en"]);
        let fast = required_models("en", true, "moonshine-base");
        assert_eq!(fast, vec!["live-en", "punct-en"]);
        let zh = required_models("zh", false, "sense-voice");
        assert_eq!(zh, vec!["live-zh-en", "sense-voice"]);
    }

    #[test]
    fn urls_are_https_and_pinned() {
        let model = find("sense-voice").unwrap();
        let url = file_url(model, &model.files[0]);
        assert!(url.starts_with("https://huggingface.co/csukuangfj/"));
        assert!(url.ends_with("/resolve/main/model.int8.onnx"));
        let punct = find("punct-en").unwrap();
        assert!(file_url(punct, &punct.files[0]).starts_with("https://github.com/k2-fsa/"));
    }
}
