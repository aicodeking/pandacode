//! User tier list (S–D): a ranked model's tier is the major weight in every decision. Per route only;
//! the static catalog is never changed.

use std::sync::LazyLock;

use serde::{Deserialize, Serialize};

use super::cards::Card;

/// Share of a ranked model's ability, strength and final P that comes from its tier.
pub const TIER_WEIGHT: f64 = 0.7;
/// Synthetic cards (ranked models without a card) are fairly certain of their tier.
const SYNTHETIC_SE: f64 = 1.0;
const SYNTHETIC_CONTEXT: f64 = 200_000.0;
const SYNTHETIC_TTFT_MS: f64 = 1500.0;
const SYNTHETIC_TPS: f64 = 50.0;
const DEFAULT_A: f64 = 1.2;
/// Fallback cost per Mtok if the catalog had no paid card.
const DEFAULT_COST_IN: f64 = 3.0;
const DEFAULT_COST_OUT: f64 = 15.0;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash, Serialize, Deserialize)]
pub enum Tier {
    S,
    A,
    B,
    C,
    D,
}

impl Tier {
    /// Ability on the cards' 1–10 difficulty scale, calibrated on the embedded cards' mean theta:
    /// S ≈ the five strongest (Fable 5.1, Opus 5.5: 8.8–9.1), D ≈ small local models.
    pub fn ability(self) -> f64 {
        match self {
            Tier::S => 8.9,
            Tier::A => 8.0,
            Tier::B => 7.0,
            Tier::C => 6.0,
            Tier::D => 4.5,
        }
    }
}

pub(super) fn blend(tier: f64, x: f64) -> f64 {
    TIER_WEIGHT * tier + (1.0 - TIER_WEIGHT) * x
}

fn median(mut v: Vec<f64>, fallback: f64) -> f64 {
    if v.is_empty() {
        return fallback;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    let n = v.len();
    if n % 2 == 1 { v[n / 2] } else { (v[n / 2 - 1] + v[n / 2]) / 2.0 }
}

/// Median discrimination and paid cost (in, out per Mtok) over the whole catalog, computed once: a
/// synthetic card's cost must not move when unrelated models join or leave the pool. Free (local)
/// cards are left out so the cost is never 0.
static CATALOG_MEDIANS: LazyLock<(f64, f64, f64)> = LazyLock::new(|| {
    let cards = super::cards::catalog().map(|c| c.cards.as_slice()).unwrap_or_default();
    let paid = |f: fn(&Card) -> f64, fallback| median(cards.iter().map(f).filter(|v| *v > 0.0).collect(), fallback);
    (median(cards.iter().map(|c| c.a).collect(), DEFAULT_A), paid(|c| c.cost_in, DEFAULT_COST_IN), paid(|c| c.cost_out, DEFAULT_COST_OUT))
});

/// A card for a ranked model the catalog does not know: the tier's ability on every axis, the catalog's
/// median discrimination and paid cost. Harness agents are tool-using and the PandaCode harnesses run
/// long-context models, so tools are on and the context is a typical 200k.
pub(super) fn synthetic(id: String, tier: Tier) -> Card {
    let ability = tier.ability();
    let (a, cost_in, cost_out) = *CATALOG_MEDIANS;
    Card {
        theta: [ability; 10],
        se: [SYNTHETIC_SE; 10],
        a,
        cost_in,
        cost_out,
        context: SYNTHETIC_CONTEXT,
        ttft_ms: SYNTHETIC_TTFT_MS,
        tps: SYNTHETIC_TPS,
        tools: true,
        vision: false,
        supersedes: Vec::new(),
        local: false,
        strength: ability,
        prior_penalty: super::policy::provenance_penalty("estimated"),
        provider: String::new(),
        model: String::new(),
        id,
    }
}

#[cfg(test)]
pub(super) fn catalog_medians() -> (f64, f64, f64) {
    *CATALOG_MEDIANS
}
