//! ONNX profiler: tokenizer + int8 Ettin model + decode (upstream `model/onnx_profiler.py`, `model/decode.py`).

use std::path::Path;
use std::sync::{LazyLock, Mutex};

use ort::session::Session;
use ort::value::Tensor;
use serde::Deserialize;
use sha2::{Digest, Sha256};
use tokenizers::{Tokenizer, TruncationDirection, TruncationParams, TruncationStrategy};

use super::profile::{TaskProfile, N_CHECKLIST, N_DIFFICULTY, N_SKILL_LEVELS};

const INTRA_THREADS: usize = 2;
const PAD_TOKEN: &str = "[PAD]";

#[derive(Deserialize)]
pub(super) struct Heads {
    taxonomy_version: String,
    pub(super) max_len: usize,
    temperatures: Temperatures,
}

#[derive(Deserialize)]
struct Temperatures {
    category: f64,
    difficulty: f64,
    skills: [f64; 10],
    flags: f64,
    checklist: f64,
}

pub(super) static HEADS: LazyLock<Heads> = LazyLock::new(|| {
    let heads: Heads = serde_json::from_str(include_str!("data/heads.json")).expect("embedded heads.json");
    assert_eq!(heads.taxonomy_version, "1.0.0", "heads.json taxonomy version");
    heads
});

/// ONNX Runtime allows one environment per process, and a dropped one cannot be rebuilt: keep it.
static ENVIRONMENT: LazyLock<Result<ort::environment::Environment, String>> =
    LazyLock::new(|| ort::init().with_name("panda-router").build().map_err(|e| e.to_string()));

pub(super) struct OnnxProfiler {
    tokenizer: Tokenizer,
    pad_id: u32,
    session: Mutex<Session>,
}

fn read_verified(dir: &Path, name: &str, sha256: &str) -> Result<Vec<u8>, String> {
    let path = dir.join(name);
    let bytes = std::fs::read(&path).map_err(|e| format!("cannot read {}: {e}", path.display()))?;
    let digest: String = Sha256::digest(&bytes).iter().map(|b| format!("{b:02x}")).collect();
    if digest != sha256 {
        return Err(format!("{name} has sha256 {digest}, expected {sha256}"));
    }
    Ok(bytes)
}

fn asset_hash(name: &str) -> &'static str {
    super::ASSETS.iter().find(|(n, _)| *n == name).map(|(_, h)| *h).expect("known asset")
}

impl OnnxProfiler {
    pub(super) fn load(dir: &Path) -> Result<Self, String> {
        let model = read_verified(dir, "model.int8.onnx", asset_hash("model.int8.onnx"))?;
        let tok = read_verified(dir, "tokenizer.json", asset_hash("tokenizer.json"))?;
        let mut tokenizer = Tokenizer::from_bytes(&tok).map_err(|e| format!("tokenizer.json: {e}"))?;
        tokenizer
            .with_truncation(Some(TruncationParams {
                max_length: HEADS.max_len,
                strategy: TruncationStrategy::LongestFirst,
                direction: TruncationDirection::Right,
                stride: 0,
            }))
            .map_err(|e| format!("tokenizer truncation: {e}"))?;
        tokenizer.with_padding(None);
        let pad_id = tokenizer.token_to_id(PAD_TOKEN).ok_or("tokenizer.json has no [PAD] token")?;
        let env = ENVIRONMENT.as_ref().map_err(|e| format!("onnx runtime: {e}"))?;
        let session = Session::builder(env)
            .and_then(|b| Ok(b.with_intra_threads(INTRA_THREADS)?))
            // No arena and no memory pattern: freed tensors go back to the system instead of
            // staying reserved for the process.
            .and_then(|b| Ok(b.with_memory_pattern(false)?))
            .and_then(|b| Ok(b.with_execution_providers([ort::ep::CPU::default().with_arena_allocator(false).build()])?))
            .and_then(|mut b| b.commit_from_memory(&model))
            .map_err(|e| format!("cannot load model.int8.onnx: {e}"))?;
        Ok(Self { tokenizer, pad_id, session: Mutex::new(session) })
    }

    pub(super) fn token_ids(&self, text: &str) -> Result<Vec<u32>, String> {
        let enc = self.tokenizer.encode(text, true).map_err(|e| format!("tokenize: {e}"))?;
        Ok(enc.get_ids().to_vec())
    }

    /// One padded run over every input (right padding with [PAD], like `padding=True`).
    pub(super) fn profile_batch(&self, texts: &[String]) -> Result<Vec<TaskProfile>, String> {
        if texts.is_empty() {
            return Ok(Vec::new());
        }
        let ids = texts.iter().map(|t| self.token_ids(t)).collect::<Result<Vec<_>, _>>()?;
        let (batch, seq) = (ids.len(), ids.iter().map(Vec::len).max().unwrap_or(0));
        let mut input = vec![i64::from(self.pad_id); batch * seq];
        let mut mask = vec![0i64; batch * seq];
        for (row, row_ids) in ids.iter().enumerate() {
            for (col, id) in row_ids.iter().enumerate() {
                input[row * seq + col] = i64::from(*id);
                mask[row * seq + col] = 1;
            }
        }
        let shape = [batch as i64, seq as i64];
        let input = Tensor::from_array((shape, input)).map_err(|e| e.to_string())?;
        let mask = Tensor::from_array((shape, mask)).map_err(|e| e.to_string())?;
        let mut session = self.session.lock().map_err(|_| "profiler session poisoned".to_string())?;
        let out = session
            .run(ort::inputs!["input_ids" => input, "attention_mask" => mask])
            .map_err(|e| format!("onnx run: {e}"))?;
        let head = |name: &str, width: usize| -> Result<Vec<f64>, String> {
            let value = out.get(name).ok_or_else(|| format!("model has no output {name}"))?;
            let (_, data) = value.try_extract_tensor::<f32>().map_err(|e| format!("{name}: {e}"))?;
            if data.len() != batch * width {
                return Err(format!("{name}: expected {} values, got {}", batch * width, data.len()));
            }
            Ok(data.iter().map(|v| f64::from(*v)).collect())
        };
        let (category, difficulty) = (head("category", 13)?, head("difficulty", N_DIFFICULTY - 1)?);
        let (skills, flags, out_tokens) = (head("skills", 100)?, head("flags", 7)?, head("out_tokens", 3)?);
        let checklist = head("checklist", N_CHECKLIST)?;
        Ok((0..batch)
            .map(|i| decode(
                &category[i * 13..][..13],
                &difficulty[i * 9..][..9],
                &skills[i * 100..][..100],
                &flags[i * 7..][..7],
                &checklist[i * N_CHECKLIST..][..N_CHECKLIST],
                out_tokens[i * 3 + 1],
            ))
            .collect())
    }
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// CORN conditional logits (K-1) -> level distribution (K).
fn corn<const K: usize>(logits: &[f64], temp: f64) -> [f64; K] {
    let mut probs = [0.0; K];
    let (mut upper, mut total) = (1.0, 0.0);
    for (k, p) in probs.iter_mut().enumerate() {
        let lower = if k + 1 < K { upper * sigmoid(logits[k] / temp) } else { 0.0 };
        *p = (upper - lower).max(0.0);
        total += *p;
        upper = lower;
    }
    probs.map(|p| p / total)
}

fn decode(category: &[f64], difficulty: &[f64], skills: &[f64], flags: &[f64], checklist: &[f64], out_p50: f64) -> TaskProfile {
    let t = &HEADS.temperatures;
    let scaled: Vec<f64> = category.iter().map(|x| x / t.category).collect();
    let max = scaled.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let exps: Vec<f64> = scaled.iter().map(|x| (x - max).exp()).collect();
    let z: f64 = exps.iter().sum();
    TaskProfile {
        category: std::array::from_fn(|i| exps[i] / z),
        difficulty: corn::<N_DIFFICULTY>(difficulty, t.difficulty),
        skills: std::array::from_fn(|k| corn::<N_SKILL_LEVELS>(&skills[k * 10..][..10], t.skills[k])),
        flags: std::array::from_fn(|i| sigmoid(flags[i] / t.flags)),
        checklist: std::array::from_fn(|i| sigmoid(checklist[i] / t.checklist)),
        out_p50,
    }
}
