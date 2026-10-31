//! Learned P(pass | task, model) (upstream `router_v4/success.py`): a frozen-feature logistic head over the
//! TaskProfile, one logistic model per trained card, bootstrapped; P is the bootstrap mean through the card's
//! Platt calibration, the lower bound the same at mean - z·sd.

use std::collections::HashMap;
use std::sync::LazyLock;

use regex::Regex;
use serde::Deserialize;

use super::profile::{TaskProfile, FLAG_AMBIGUOUS_SPEC, N_CHECKLIST, N_DIFFICULTY};

const N_FEATURES: usize = 13 + N_DIFFICULTY + 2 + 10 + 7 + N_CHECKLIST + 3;

#[derive(Deserialize)]
struct CardCalibration {
    alpha: f64,
    beta: f64,
}

#[derive(Deserialize)]
struct Params {
    cards: Vec<String>,
    feature_names: Vec<String>,
    mu: Vec<f64>,
    sd: Vec<f64>,
    /// (bootstrap, card, feature)
    coef: Vec<Vec<Vec<f64>>>,
    /// (bootstrap, card)
    bias: Vec<Vec<f64>>,
    prior_difficulty: [f64; N_DIFFICULTY],
    difficulty_quantile: f64,
    lcb_z: f64,
    omega_max: f64,
    short_words: f64,
    #[serde(default)]
    platt: HashMap<String, (f64, f64)>,
    card_calibration: CardCalibration,
    #[serde(default)]
    escalation_logit: HashMap<String, HashMap<String, f64>>,
}

pub(super) struct SuccessHead {
    p: Params,
    index: HashMap<String, usize>,
    /// Mean shift of the escalation table: failures are correlated, so an unknown pair gets it.
    default_shift: f64,
}

pub(super) static HEAD: LazyLock<SuccessHead> = LazyLock::new(|| {
    SuccessHead::new(serde_json::from_str(include_str!("data/success_head.json")).expect("embedded success_head.json"))
        .expect("embedded success_head.json")
});

static WORD: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\w+").expect("word regex"));

pub(super) fn n_words(text: &str) -> usize {
    WORD.find_iter(text).count()
}

fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

fn mean_level(d: &[f64; N_DIFFICULTY]) -> f64 {
    d.iter().enumerate().map(|(i, p)| (i + 1) as f64 * p).sum()
}

/// Interpolated q-quantile of a distribution over levels 1..10.
pub(super) fn quantile_level(diff: &[f64; N_DIFFICULTY], q: f64) -> f64 {
    let total: f64 = diff.iter().sum();
    let mut c = [0.0; N_DIFFICULTY];
    let mut acc = 0.0;
    for (i, d) in diff.iter().enumerate() {
        acc += d / total;
        c[i] = acc;
    }
    let k = c.iter().position(|v| *v >= q).unwrap_or(N_DIFFICULTY - 1); // numpy searchsorted (left)
    if k == 0 {
        return 1.0;
    }
    let lo = c[k - 1];
    k as f64 + (q - lo) / (c[k] - lo).max(1e-9)
}

impl SuccessHead {
    fn new(p: Params) -> Result<Self, String> {
        let shapes_ok = p.mu.len() == N_FEATURES
            && p.sd.len() == N_FEATURES
            && p.feature_names.len() == N_FEATURES
            && p.coef.len() == p.bias.len()
            && p.coef.iter().all(|b| b.len() == p.cards.len() && b.iter().all(|m| m.len() == N_FEATURES))
            && p.bias.iter().all(|b| b.len() == p.cards.len());
        if !shapes_ok || p.coef.is_empty() {
            return Err("success head: coef/bias shapes do not match cards/features".into());
        }
        let index = p.cards.iter().enumerate().map(|(i, c)| (c.clone(), i)).collect();
        let vals: Vec<f64> = p.escalation_logit.values().flat_map(|row| row.values().copied()).collect();
        let default_shift = if vals.is_empty() { 0.0 } else { vals.iter().sum::<f64>() / vals.len() as f64 };
        Ok(Self { p, index, default_shift })
    }

    pub fn covers(&self, card: &str) -> bool {
        self.index.contains_key(card)
    }

    pub fn quantile(&self) -> f64 {
        self.p.difficulty_quantile
    }

    /// (alpha, beta) mapping a card/IRT P onto the head's outcome scale.
    pub fn card_calibration(&self) -> (f64, f64) {
        (self.p.card_calibration.alpha, self.p.card_calibration.beta)
    }

    /// 0..1: excess ambiguity × shortness.
    pub fn vagueness(&self, profile: &TaskProfile, text: &str) -> f64 {
        let sw = self.p.short_words;
        let short = ((sw - n_words(text) as f64) / (sw - 2.0).max(1.0)).clamp(0.0, 1.0);
        let amb = ((profile.flags[FLAG_AMBIGUOUS_SPEC] - 0.5) / 0.5).clamp(0.0, 1.0);
        amb * short
    }

    /// (widened difficulty, vagueness): an underspecified request mixes toward the population prior, never
    /// below the profiler's own mean.
    pub fn decision_difficulty(
        &self,
        profile: &TaskProfile,
        text: &str,
        diff: &[f64; N_DIFFICULTY],
    ) -> ([f64; N_DIFFICULTY], f64) {
        let v = self.vagueness(profile, text);
        let omega = self.p.omega_max * v;
        let total: f64 = diff.iter().sum();
        let d = diff.map(|x| x / total);
        let mixed: [f64; N_DIFFICULTY] = std::array::from_fn(|i| (1.0 - omega) * d[i] + omega * self.p.prior_difficulty[i]);
        (if mean_level(&mixed) >= mean_level(&d) { mixed } else { d }, v)
    }

    /// Upstream `task_features` over the decision difficulty `d`.
    pub fn features(&self, profile: &TaskProfile, text: &str, d: &[f64; N_DIFFICULTY], vague: f64) -> Vec<f64> {
        let mut x = Vec::with_capacity(N_FEATURES);
        x.extend_from_slice(&profile.category);
        x.extend_from_slice(d);
        x.push(mean_level(d) / 10.0);
        x.push(quantile_level(d, self.p.difficulty_quantile) / 10.0);
        x.extend((0..10).map(|k| profile.expected_skill(k) / 10.0));
        x.extend_from_slice(&profile.flags);
        x.extend_from_slice(&profile.checklist);
        x.push(profile.out_p50 / 4.0);
        x.push((n_words(text) as f64).ln_1p() / 6.0);
        x.push(vague);
        debug_assert_eq!(x.len(), N_FEATURES);
        x
    }

    /// Log-odds shift of `card` given that `failed` cards already failed on this task.
    pub fn failure_offset(&self, failed: &[&str], card: &str) -> f64 {
        failed
            .iter()
            .map(|f| match self.p.escalation_logit.get(*f).and_then(|row| row.get(card)) {
                Some(v) => *v,
                None if *f == card => 0.0,
                None => self.default_shift,
            })
            .sum()
    }

    /// (calibrated P, lower bound) for a covered card.
    pub fn predict(&self, x: &[f64], card: &str, offset: f64) -> (f64, f64) {
        let row = self.index[card];
        let z: Vec<f64> = x.iter().zip(&self.p.mu).zip(&self.p.sd).map(|((x, m), s)| (x - m) / s).collect();
        let logits: Vec<f64> = self
            .p
            .coef
            .iter()
            .zip(&self.p.bias)
            .map(|(c, b)| c[row].iter().zip(&z).map(|(w, z)| w * z).sum::<f64>() + b[row] + offset)
            .collect();
        let n = logits.len() as f64;
        let m = logits.iter().sum::<f64>() / n;
        let s = (logits.iter().map(|l| (l - m) * (l - m)).sum::<f64>() / n).sqrt();
        let (a, b) = self.p.platt.get(card).copied().unwrap_or((0.0, 1.0));
        (sigmoid(a + b * m), sigmoid(a + b * (m - self.p.lcb_z * s)))
    }
}
