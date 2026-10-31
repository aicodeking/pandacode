//! Model cards: embedded catalog, validation (rules of upstream `schemas/model_card.schema.json`), the
//! numeric view the matcher uses (`matcher/cards.py`) and name resolution (`resolve_alias` in `matcher/policy.py`).

use std::collections::{BTreeMap, HashMap};
use std::sync::{LazyLock, Mutex};

use serde::Deserialize;
use serde_json::Value;

use super::profile::SKILL_AXES;

const DEFAULT_A: f64 = 1.2;
const MISSING_AXIS_SE: f64 = 2.0;
const MISSING_ALL_THETA: f64 = 5.0;
const MISSING_ALL_SE: f64 = 2.5;
const DEFAULT_TTFT_MS: f64 = 1500.0;
/// Upstream `FUZZY_CUTOFF` (policy.py): a misspelling must be at least this close.
const FUZZY_CUTOFF: f64 = 0.75;
/// Resolutions remembered per process; a team catalog lists up to 1000 models.
const RESOLVE_CACHE: usize = 8192;
const DEFAULT_TPS: f64 = 50.0;

/// Every schema field is parsed (unknown ones are refused); documentation fields are never read.
#[allow(dead_code)]
#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawCard {
    id: String,
    provider: Option<String>,
    model: Option<String>,
    description: String,
    #[serde(default)]
    skills: BTreeMap<String, RawSkill>,
    discrimination: Option<f64>,
    #[serde(default)]
    modalities: Modalities,
    #[serde(default)]
    features: Features,
    limits: Limits,
    cost: Cost,
    #[serde(default)]
    latency: Latency,
    #[serde(default)]
    local: bool,
    #[serde(default)]
    supersedes: Vec<String>,
    provenance: Option<String>,
    #[serde(default)]
    field_provenance: BTreeMap<String, String>,
    // Documentation fields: accepted, not used for routing.
    strengths: Option<Vec<String>>,
    weaknesses: Option<Vec<String>>,
    tags: Option<Vec<String>>,
    card_version: Option<String>,
    sources: Option<Vec<String>>,
    notes: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RawSkill {
    theta: f64,
    se: f64,
}

#[derive(Default, Deserialize)]
struct Modalities {
    #[serde(default)]
    input: Vec<String>,
    #[serde(default)]
    output: Vec<String>,
}

#[derive(Default, Deserialize)]
struct Features {
    #[serde(default)]
    tools: bool,
}

#[derive(Deserialize)]
struct Limits {
    context_tokens: Value,
}

#[derive(Deserialize)]
struct Cost {
    input_per_mtok: f64,
    output_per_mtok: f64,
    cached_input_per_mtok: Option<f64>,
    currency: Option<String>,
}

#[derive(Default, Deserialize)]
struct Latency {
    ttft_ms_p50: Option<f64>,
    tokens_per_sec: Option<f64>,
}

/// One card, compiled for the matcher.
pub(super) struct Card {
    pub id: String,
    pub provider: String,
    pub model: String,
    pub theta: [f64; 10],
    pub se: [f64; 10],
    pub a: f64,
    pub cost_in: f64,
    pub cost_out: f64,
    pub context: f64,
    pub ttft_ms: f64,
    pub tps: f64,
    pub tools: bool,
    pub vision: bool,
    pub supersedes: Vec<String>,
    pub local: bool,
    /// Mean ability over the skill axes (v4 "strength").
    pub strength: f64,
    /// v4 provenance prior penalty in logits for cards the success head was not trained on.
    pub prior_penalty: f64,
}

fn validate(c: &RawCard) -> Result<(), String> {
    let fail = |msg: String| Err(format!("invalid model card {:?}: {msg}", c.id));
    let mut chars = c.id.chars();
    let id_ok = chars.next().is_some_and(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit())
        && chars.all(|ch| ch.is_ascii_lowercase() || ch.is_ascii_digit() || "._-".contains(ch));
    if !id_ok {
        return fail("id must match ^[a-z0-9][a-z0-9._-]*$".into());
    }
    if c.description.is_empty() {
        return fail("empty description".into());
    }
    for (axis, s) in &c.skills {
        if !SKILL_AXES.contains(&axis.as_str()) {
            return fail(format!("unknown skill axis {axis}"));
        }
        if !((0.0..=10.0).contains(&s.theta) && s.se > 0.0 && s.se <= 5.0) {
            return fail(format!("skill {axis} out of range"));
        }
    }
    if c.discrimination.is_some_and(|a| !(a > 0.0 && a <= 5.0)) {
        return fail("discrimination must be in (0, 5]".into());
    }
    let inputs_ok = c.modalities.input.iter().all(|m| ["text", "image", "audio", "video"].contains(&m.as_str()));
    let outputs_ok = c.modalities.output.iter().all(|m| ["text", "image", "audio"].contains(&m.as_str()));
    if !inputs_ok || !outputs_ok {
        return fail("unknown modality".into());
    }
    if c.limits.context_tokens.as_u64().is_none_or(|n| n < 1) {
        return fail("limits.context_tokens must be an integer >= 1".into());
    }
    let cost = &c.cost;
    if cost.input_per_mtok < 0.0 || cost.output_per_mtok < 0.0 || cost.cached_input_per_mtok.is_some_and(|v| v < 0.0) {
        return fail("negative cost".into());
    }
    if cost.currency.as_deref().is_some_and(|cur| cur != "USD") {
        return fail("cost.currency must be USD".into());
    }
    if c.latency.ttft_ms_p50.is_some_and(|v| v < 0.0) || c.latency.tokens_per_sec.is_some_and(|v| v <= 0.0) {
        return fail("latency out of range".into());
    }
    let provenance = ["verified", "benchmark-informed", "estimated"];
    if c.provenance.iter().chain(c.field_provenance.values()).any(|p| !provenance.contains(&p.as_str())) {
        return fail("unknown provenance".into());
    }
    Ok(())
}

fn compile(c: RawCard) -> Card {
    let known: Vec<&RawSkill> = SKILL_AXES.iter().filter_map(|a| c.skills.get(*a)).collect();
    let (theta, se) = if known.is_empty() {
        ([MISSING_ALL_THETA; 10], [MISSING_ALL_SE; 10])
    } else {
        let fill_theta = known.iter().map(|s| s.theta).sum::<f64>() / known.len() as f64 - 0.5;
        let fill_se = MISSING_AXIS_SE.max(known.iter().map(|s| s.se).fold(f64::MIN, f64::max) + 1.0);
        (
            std::array::from_fn(|k| c.skills.get(SKILL_AXES[k]).map_or(fill_theta, |s| s.theta)),
            std::array::from_fn(|k| c.skills.get(SKILL_AXES[k]).map_or(fill_se, |s| s.se)),
        )
    };
    let provenance = c.field_provenance.get("skills").or(c.provenance.as_ref()).map_or("estimated", String::as_str);
    Card {
        strength: super::policy::np_sum(&theta) / 10.0,
        prior_penalty: super::policy::provenance_penalty(provenance),
        local: c.local,
        theta,
        se,
        a: c.discrimination.unwrap_or(DEFAULT_A),
        cost_in: c.cost.input_per_mtok,
        cost_out: c.cost.output_per_mtok,
        context: c.limits.context_tokens.as_f64().unwrap_or(0.0),
        ttft_ms: c.latency.ttft_ms_p50.unwrap_or(DEFAULT_TTFT_MS),
        tps: c.latency.tokens_per_sec.unwrap_or(DEFAULT_TPS),
        tools: c.features.tools,
        vision: c.modalities.input.iter().any(|m| m == "image"),
        supersedes: c.supersedes,
        provider: c.provider.unwrap_or_default(),
        model: c.model.unwrap_or_default(),
        id: c.id,
    }
}

#[derive(Deserialize)]
struct HarnessEntry {
    provider: String,
    model: String,
    card: String,
}

pub(super) struct Catalog {
    pub cards: Vec<Card>,
    by_id: HashMap<String, usize>,
    /// Normalised id / model / slug tail -> card; None marks a key shared by several cards.
    index: HashMap<String, Option<usize>>,
    /// `index` keys in insertion order, like the Python dict the fuzzy step walks.
    keys: Vec<String>,
    harness: HashMap<(String, String), usize>,
    resolved: Mutex<HashMap<(String, String, String), Option<usize>>>,
}

pub(super) static CATALOG: LazyLock<Result<Catalog, String>> = LazyLock::new(|| {
    Catalog::build(
        &[include_str!("data/cards.json"), include_str!("data/pandacode_cards.json")],
        include_str!("data/harness_map.json"),
    )
});

pub(super) fn catalog() -> Result<&'static Catalog, String> {
    CATALOG.as_ref().map_err(Clone::clone)
}

fn alias_key(name: &str) -> String {
    name.chars().flat_map(char::to_lowercase).filter(|c| c.is_ascii_lowercase() || c.is_ascii_digit()).collect()
}

fn tail(name: &str) -> &str {
    name.rsplit('/').next().unwrap_or(name)
}

fn card_keys(card: &Card) -> Vec<String> {
    let mut keys: Vec<String> = [card.id.as_str(), card.model.as_str()]
        .into_iter()
        .filter(|n| !n.is_empty())
        .flat_map(|n| [alias_key(n), alias_key(tail(n))])
        .filter(|k| !k.is_empty())
        .collect();
    keys.sort();
    keys.dedup();
    keys
}

impl Catalog {
    fn build(card_sources: &[&str], harness: &str) -> Result<Self, String> {
        let mut cards = Vec::new();
        let mut by_id = HashMap::new();
        for source in card_sources {
            let raw: Vec<RawCard> = serde_json::from_str(source).map_err(|e| format!("model cards: {e}"))?;
            for card in raw {
                validate(&card)?;
                if by_id.insert(card.id.clone(), cards.len()).is_some() {
                    return Err(format!("duplicate card id {:?}", card.id));
                }
                cards.push(compile(card));
            }
        }
        let mut index: HashMap<String, Option<usize>> = HashMap::new();
        let mut keys = Vec::new();
        for (i, card) in cards.iter().enumerate() {
            for key in card_keys(card) {
                if !index.contains_key(&key) {
                    keys.push(key.clone());
                }
                let entry = index.entry(key).or_insert(Some(i));
                if *entry != Some(i) {
                    *entry = None;
                }
            }
        }
        let entries: Vec<HarnessEntry> = serde_json::from_str(harness).map_err(|e| format!("harness map: {e}"))?;
        let mut map = HashMap::new();
        for e in entries {
            let card = *by_id.get(&e.card).ok_or_else(|| format!("harness map names unknown card {:?}", e.card))?;
            map.insert((e.provider, e.model), card);
        }
        Ok(Self { cards, by_id, index, keys, harness: map, resolved: Mutex::new(HashMap::new()) })
    }

    pub fn by_id(&self, id: &str) -> Option<usize> {
        self.by_id.get(id).copied()
    }

    /// Upstream `resolve_alias`: exact id, exact model (also after a `vendor/` prefix), then
    /// case/separator-insensitive id, model or slug tail, then the closest spelling with the same
    /// version digits ('gpt-6-sol' never becomes 'gpt-6.1-sol'). Ambiguous -> None.
    fn resolve_alias(&self, name: &str) -> Option<usize> {
        if let Some(i) = self.by_id(name) {
            return Some(i);
        }
        let short = tail(name);
        let by_model: Vec<usize> =
            (0..self.cards.len()).filter(|&i| self.cards[i].model == name || self.cards[i].model == short).collect();
        if by_model.len() == 1 {
            return Some(by_model[0]);
        }
        let mut keys = vec![alias_key(name), alias_key(short)];
        keys.dedup();
        for key in keys.iter().filter(|k| !k.is_empty()) {
            match self.index.get(key) {
                None => continue,
                Some(Some(i)) => return Some(*i),
                Some(None) => {
                    // Shared key: a vendor prefix ('ollama/...', 'openrouter/...') may pick one card.
                    let prefix = name.split_once('/').map(|(p, _)| alias_key(p)).unwrap_or_default();
                    let hits: Vec<usize> = (0..self.cards.len())
                        .filter(|&i| {
                            let c = &self.cards[i];
                            let vendor = alias_key(c.id.split('-').next().unwrap_or(""));
                            !prefix.is_empty()
                                && (prefix == alias_key(&c.provider) || prefix == vendor)
                                && card_keys(c).contains(key)
                        })
                        .collect();
                    return if hits.len() == 1 { Some(hits[0]) } else { None };
                }
            }
        }
        let (mut best, mut best_score) = (None, FUZZY_CUTOFF);
        for key in keys.iter().filter(|k| !k.is_empty()) {
            for cand in &self.keys {
                let Some(Some(card)) = self.index.get(cand) else { continue };
                if digits(cand) != digits(key) || tier_differs(name, &self.cards[*card]) {
                    continue;
                }
                let score = ratio(key, cand);
                if score > best_score {
                    (best, best_score) = (Some(*card), score);
                } else if score == best_score && best != Some(*card) {
                    best = None; // tie between different cards: refuse to guess
                }
            }
        }
        best
    }

    /// `resolve_uncached`, remembered: prompts and pools resolve the same catalog every turn.
    pub fn resolve(&self, provider: &str, model: &str, name: &str) -> Option<usize> {
        let key = (provider.to_string(), model.to_string(), name.to_string());
        if let Some(hit) = self.resolved.lock().ok().and_then(|cache| cache.get(&key).copied()) {
            return hit;
        }
        let card = self.resolve_uncached(provider, model, name);
        if let Ok(mut cache) = self.resolved.lock() {
            if cache.len() >= RESOLVE_CACHE {
                cache.clear();
            }
            cache.insert(key, card);
        }
        card
    }

    fn resolve_uncached(&self, provider: &str, model: &str, name: &str) -> Option<usize> {
        if let Some(i) = self.harness.get(&(provider.to_string(), model.to_string())) {
            return Some(*i);
        }
        if model != "default" {
            return self.resolve_alias(model).or_else(|| model.strip_prefix("openrouter/").and_then(|m| self.resolve_alias(m)));
        }
        // "Default · Claude Opus 5.5 · Claude Code": exactly one segment of the display name must name a card.
        let mut hits: Vec<usize> = name.split('·').filter_map(|part| self.resolve_alias(part.trim())).collect();
        hits.sort_unstable();
        hits.dedup();
        if hits.len() == 1 { Some(hits[0]) } else { None }
    }
}

/// Size and speed tiers are different models, not misspellings: `gpt-6-luna-mini` must not borrow
/// `gpt-6-luna`'s card (a PandaCode guard on top of upstream's digit check).
const TIERS: [&str; 14] = ["mini", "nano", "micro", "tiny", "small", "lite", "flash", "air", "turbo", "pro", "max", "ultra", "plus", "highspeed"];

/// Compares whole name tokens, so a tier word inside another word ("mini" in "gemini") never counts.
fn tier_differs(name: &str, card: &Card) -> bool {
    let tokens = |s: &str| -> Vec<String> {
        s.split(|c: char| !c.is_ascii_alphanumeric()).map(str::to_ascii_lowercase).filter(|t| !t.is_empty()).collect()
    };
    let wanted = tokens(name);
    let have: Vec<String> = tokens(&card.id).into_iter().chain(tokens(&card.model)).collect();
    TIERS.iter().any(|t| wanted.iter().any(|w| w == t) != have.iter().any(|h| h == t))
}

fn digits(key: &str) -> String {
    key.chars().filter(char::is_ascii_digit).collect()
}

/// `difflib.SequenceMatcher(None, a, b).ratio()` for short keys (no junk; autojunk needs 200+ chars).
pub(super) fn ratio(a: &str, b: &str) -> f64 {
    let (a, b) = (a.as_bytes(), b.as_bytes());
    if a.is_empty() && b.is_empty() {
        return 1.0;
    }
    let mut b2j: HashMap<u8, Vec<usize>> = HashMap::new();
    for (j, c) in b.iter().enumerate() {
        b2j.entry(*c).or_default().push(j);
    }
    let longest = |alo: usize, ahi: usize, blo: usize, bhi: usize| {
        let (mut besti, mut bestj, mut best) = (alo, blo, 0);
        let mut j2len: HashMap<usize, usize> = HashMap::new();
        for (i, c) in a.iter().enumerate().take(ahi).skip(alo) {
            let mut next = HashMap::new();
            for &j in b2j.get(c).map_or(&[][..], Vec::as_slice) {
                if j < blo {
                    continue;
                }
                if j >= bhi {
                    break;
                }
                let k = j.checked_sub(1).and_then(|p| j2len.get(&p)).copied().unwrap_or(0) + 1;
                next.insert(j, k);
                if k > best {
                    (besti, bestj, best) = (i + 1 - k, j + 1 - k, k);
                }
            }
            j2len = next;
        }
        (besti, bestj, best)
    };
    let (mut matched, mut queue) = (0, vec![(0, a.len(), 0, b.len())]);
    while let Some((alo, ahi, blo, bhi)) = queue.pop() {
        let (i, j, k) = longest(alo, ahi, blo, bhi);
        if k > 0 {
            matched += k;
            if alo < i && blo < j {
                queue.push((alo, i, blo, j));
            }
            if i + k < ahi && j + k < bhi {
                queue.push((i + k, ahi, j + k, bhi));
            }
        }
    }
    2.0 * matched as f64 / (a.len() + b.len()) as f64
}
