//! Deterministic matcher: MIRT P(success) (upstream `matcher/core.py`) and the v4 routing path of
//! `matcher/policy.py` (`Matcher._route` with `policy="v4"`, calibration off, no exploration).

use std::f64::consts::{PI, SQRT_2};

use super::cards::Card;
use super::policy::{self, Arrays};
use super::profile::{TaskProfile, FLAG_NEEDS_TOOLS, FLAG_NEEDS_VISION, N_DIFFICULTY};
use super::success::HEAD;
use super::tiers;
use super::Mode;

const LAMBDA: f64 = 0.5;
const CONTEXT_MARGIN: f64 = 1.2;
const INPUT_OVERHEAD_TOKENS: usize = 500;
#[cfg(test)]
pub(super) const DEFAULT_CARD: &str = "claude-opus-5.5";
const REASONING: usize = 2;

/// Non-negative half of numpy's `hermgauss(20)`; the rule is symmetric.
const GH_X: [f64; 10] = [
    0.24534070830090127, 0.7374737285453944, 1.234076215395323, 1.7385377121165861, 2.2549740020892752,
    2.7888060584281305, 3.3478545673832163, 3.944764040115625, 4.603682449550744, 5.387480890011233,
];
const GH_W: [f64; 10] = [
    0.4622436696006101, 0.28667550536283415, 0.1090172060200233, 0.024810520887463643, 0.0032437733422378623,
    0.00022833863601635365, 7.80255647853206e-06, 1.0860693707692782e-07, 4.3993409922731747e-10,
    2.2293936455341447e-13,
];

/// Task-side quantities shared by every card.
pub(super) struct Demand {
    exp: [f64; 10],
    w: [f64; 10],
}

impl Demand {
    pub fn new(profile: &TaskProfile) -> Self {
        let exp: [f64; 10] =
            std::array::from_fn(|k| profile.skills[k].iter().enumerate().map(|(lvl, p)| lvl as f64 * p).sum());
        let total: f64 = exp.iter().sum();
        let w = if total < 1e-6 {
            std::array::from_fn(|k| if k == REASONING { 1.0 } else { 0.0 })
        } else {
            exp.map(|e| e / total)
        };
        Self { exp, w }
    }

    /// Mean and sd of the effective ability z (linear + hinge, moment-matched per axis). A user tier
    /// (ability, weight) pulls the mean toward it.
    pub(super) fn moments(&self, card: &Card, tier: Option<(f64, f64)>) -> (f64, f64) {
        let (mut mu, mut var) = (0.0, 0.0);
        for k in 0..10 {
            let m = self.exp[k] - card.theta[k];
            let s = card.se[k].max(1e-9);
            let t = m / s;
            let cdf = 0.5 * libm::erfc(-t / SQRT_2);
            let pdf = (-0.5 * t * t).exp() / (2.0 * PI).sqrt();
            let eh = m * cdf + s * pdf;
            let var_h = ((m * m + s * s) * cdf + m * s * pdf - eh * eh).max(0.0);
            mu += (card.theta[k] - LAMBDA * eh) * self.w[k];
            var += (s * s + LAMBDA * LAMBDA * var_h + 2.0 * LAMBDA * s * s * cdf) * self.w[k] * self.w[k];
        }
        (tier.map_or(mu, |(t, w)| w * t + (1.0 - w) * mu), var.sqrt())
    }

    /// P(success | b = level) for levels 1..10, integrated over z ~ N(mu, sd) by Gauss-Hermite.
    /// A tier moves the mean ability `TIER_WEIGHT` of the way to it.
    pub fn p_by_level(&self, card: &Card, tier: Option<f64>) -> ([f64; N_DIFFICULTY], f64) {
        self.p_by_ability(card, tier.map(|t| (t, tiers::TIER_WEIGHT)))
    }

    fn p_by_ability(&self, card: &Card, tier: Option<(f64, f64)>) -> ([f64; N_DIFFICULTY], f64) {
        let (mu, sd) = self.moments(card, tier);
        let sigmoid = |x: f64| 0.5 * (1.0 + (0.5 * x).tanh());
        let mut out = [0.0; N_DIFFICULTY];
        for (l, o) in out.iter_mut().enumerate() {
            let level = (l + 1) as f64;
            for (x, w) in GH_X.iter().zip(GH_W) {
                let (z, p) = (SQRT_2 * x, w / PI.sqrt());
                *o += p * (sigmoid(card.a * (mu - sd * z - level)) + sigmoid(card.a * (mu + sd * z - level)));
            }
        }
        (out, mu)
    }

    /// Bayes: post(b) ∝ prior(b) · P(fail | b) for a model that failed.
    pub fn after_failure(&self, prior: &[f64; N_DIFFICULTY], failed: &Card, tier: Option<f64>) -> [f64; N_DIFFICULTY] {
        let (p, _) = self.p_by_level(failed, tier);
        let post: [f64; N_DIFFICULTY] = std::array::from_fn(|l| prior[l] * (1.0 - p[l]));
        let s: f64 = post.iter().sum();
        if s > 1e-12 { post.map(|x| x / s) } else { *prior }
    }
}

pub(super) fn normalized(d: &[f64; N_DIFFICULTY]) -> [f64; N_DIFFICULTY] {
    let s: f64 = d.iter().sum();
    d.map(|x| x / s)
}

pub(super) struct Scored {
    pub p: f64,
    pub p_lo: f64,
    pub cost: f64,
    pub latency: f64,
    /// Expected cost including the failure term (candidates only; NaN otherwise).
    pub expected_cost: f64,
    /// A ranked card's tier P before the blend (`p` = blend(tier_p, v4 P)).
    pub tier_p: Option<f64>,
}

pub(super) struct Decision {
    pub scored: Vec<Scored>,
    pub chosen: Option<usize>,
    pub decided_by: String,
    /// Candidates, chosen first, then by P(success) descending.
    pub order: Vec<usize>,
    pub ladder: Vec<usize>,
    /// The decision difficulty (widened for vague requests).
    pub difficulty: [f64; N_DIFFICULTY],
}

pub(super) struct Request<'a> {
    pub profile: &'a TaskProfile,
    pub text: &'a str,
    /// Profile difficulty, or an escalation posterior.
    pub difficulty: &'a [f64; N_DIFFICULTY],
    /// De-duplicated pool of cards.
    pub pool: &'a [&'a Card],
    /// Pool entries that already failed, in failure order.
    pub failed: &'a [usize],
    /// The previous route's escalation ladder (pool indices).
    pub prev_ladder: &'a [usize],
    /// User tier ability per pool entry (None: unranked).
    pub tiers: &'a [Option<f64>],
    pub requires_tools: bool,
    pub mode: Mode,
    pub min_p: f64,
}

/// v4 P and its lower bound per card: the success head for cards it was trained on; otherwise the card's
/// P at the upper difficulty quantile, recentred on this task's covered cards (`Matcher._v4_p`). A ranked
/// card's P (and bound) then moves `TIER_WEIGHT` of the way to the P of its tier's ability, put on the head's
/// scale for this task by the covered cards' mean logit shift (raw card P sits far above the head's).
fn v4_p(
    r: &Request,
    p_levels: &[[f64; N_DIFFICULTY]],
    tier_levels: &[Option<[f64; N_DIFFICULTY]>],
    cost: &[f64],
    diff: &[f64; N_DIFFICULTY],
) -> (Vec<f64>, Vec<f64>, Vec<Option<f64>>, [f64; N_DIFFICULTY]) {
    let head = &*HEAD;
    let (dec, vague) = head.decision_difficulty(r.profile, r.text, diff);
    let level = super::success::quantile_level(&dec, head.quantile());
    let (alpha, beta) = head.card_calibration();
    let n = r.pool.len();
    let penalty: Vec<f64> = (0..n)
        .map(|i| r.pool[i].prior_penalty + if cost[i] <= 0.0 || r.pool[i].local { policy::FREE_PENALTY } else { 0.0 })
        .collect();
    let card_q: Vec<f64> = p_levels.iter().map(|l| policy::p_at_level(l, level)).collect();
    let mut p: Vec<f64> = (0..n).map(|i| policy::sigmoid(alpha + beta * policy::logit(card_q[i]) - penalty[i])).collect();
    let mut p_lo = p.clone();
    let covered: Vec<usize> = (0..n).filter(|&i| head.covers(&r.pool[i].id)).collect();
    let failed: Vec<&str> = r.failed.iter().map(|&i| r.pool[i].id.as_str()).collect();
    let mut head_shift = 0.0;
    if !failed.is_empty() {
        // Uncovered cards also lose the mean correlated-failure shift.
        for i in (0..n).filter(|i| !covered.contains(i)) {
            let shift = head.failure_offset(&failed, &r.pool[i].id);
            p[i] = policy::sigmoid(policy::logit(p[i]) + shift);
            p_lo[i] = policy::sigmoid(policy::logit(p_lo[i]) + shift);
        }
    }
    if !covered.is_empty() {
        let x = head.features(r.profile, r.text, &dec, vague);
        let (pc, lo): (Vec<f64>, Vec<f64>) =
            covered.iter().map(|&i| head.predict(&x, &r.pool[i].id, head.failure_offset(&failed, &r.pool[i].id))).unzip();
        let mean = |v: Vec<f64>| v.iter().sum::<f64>() / v.len() as f64;
        head_shift = mean(pc.iter().map(|p| policy::logit(*p)).collect())
            - mean(covered.iter().map(|&i| alpha + beta * policy::logit(card_q[i])).collect());
        if covered.len() >= 2 {
            // Upstream recomputes every card here, so the failure shift above survives only with < 2 covered cards.
            let ref_q: Vec<f64> = covered.iter().map(|&i| card_q[i]).collect();
            p = policy::shrunk_card_p(&card_q, &ref_q, &pc, &penalty, alpha, beta);
            p_lo = policy::shrunk_card_p(&card_q, &ref_q, &lo, &penalty, alpha, beta);
        }
        for (k, &i) in covered.iter().enumerate() {
            (p[i], p_lo[i]) = (pc[k], lo[k]);
        }
    }
    let tier_p: Vec<Option<f64>> = tier_levels
        .iter()
        .map(|levels| levels.map(|l| policy::sigmoid(alpha + beta * policy::logit(policy::p_at_level(&l, level)) + head_shift)))
        .collect();
    for (i, tp) in tier_p.iter().enumerate() {
        if let Some(tp) = *tp {
            (p[i], p_lo[i]) = (tiers::blend(tp, p[i]), tiers::blend(tp, p_lo[i]));
        }
    }
    let p: Vec<f64> = p.iter().map(|v| v.clamp(0.0, 1.0)).collect();
    let p_lo = p_lo.iter().zip(&p).map(|(lo, p)| lo.min(*p).clamp(0.0, 1.0)).collect();
    (p, p_lo, tier_p, dec)
}

fn cmp(a: f64, b: f64) -> std::cmp::Ordering {
    a.partial_cmp(&b).unwrap_or(std::cmp::Ordering::Equal)
}

pub(super) fn decide(r: &Request) -> Decision {
    let pool = r.pool;
    let n = pool.len();
    let demand = Demand::new(r.profile);
    let diff = normalized(r.difficulty);
    let in_tok = (r.text.chars().count() / 4 + INPUT_OVERHEAD_TOKENS) as f64;
    let out_tok = 10f64.powf(r.profile.out_p50);
    // Untiered levels keep every unranked card's recentring exactly as without tiers.
    let p_levels: Vec<[f64; N_DIFFICULTY]> = pool.iter().map(|c| demand.p_by_level(c, None).0).collect();
    let tier_levels: Vec<Option<[f64; N_DIFFICULTY]>> =
        pool.iter().zip(r.tiers).map(|(c, t)| t.map(|t| demand.p_by_ability(c, Some((t, 1.0))).0)).collect();
    let cost: Vec<f64> = pool.iter().map(|c| (in_tok * c.cost_in + out_tok * c.cost_out) / 1e6).collect();
    let latency: Vec<f64> = pool.iter().map(|c| c.ttft_ms + out_tok / c.tps * 1000.0).collect();
    let (p, p_lo, tier_p, dec) = v4_p(r, &p_levels, &tier_levels, &cost, &diff);
    let strength: Vec<f64> = pool.iter().zip(r.tiers).map(|(c, t)| t.map_or(c.strength, |t| tiers::blend(t, c.strength))).collect();

    // Hard filters.
    let needs_tools = r.profile.flags[FLAG_NEEDS_TOOLS].max(if r.requires_tools { 1.0 } else { 0.0 }) > 0.5;
    let needs_vision = r.profile.flags[FLAG_NEEDS_VISION] > 0.5;
    let mut cand: Vec<usize> = (0..n)
        .filter(|&i| {
            let c = pool[i];
            !r.failed.contains(&i)
                && (c.tools || !needs_tools)
                && (c.vision || !needs_vision)
                && in_tok * CONTEXT_MARGIN <= c.context
        })
        .collect();

    // Newer version wins when it costs no more for this task.
    let newer = |old: &str| cand.iter().rev().copied().find(|&j| pool[j].supersedes.iter().any(|s| s == old));
    let superseded: Vec<usize> =
        cand.iter().copied().filter(|&i| newer(&pool[i].id).is_some_and(|j| cost[j] <= cost[i] + 1e-12)).collect();
    cand.retain(|i| !superseded.contains(i));

    let mut expected = vec![f64::NAN; n];
    let (mut chosen, mut decided_by, mut ladder) = (None, "none:all_filtered".to_string(), Vec::new());
    if !cand.is_empty() {
        let pick = |v: &[f64]| cand.iter().map(|&i| v[i]).collect::<Vec<f64>>();
        let (cp, cpm, cc, cl, cs) = (pick(&p_lo), pick(&p), pick(&cost), pick(&latency), pick(&strength));
        let arrays = Arrays { p: &cp, p_mean: &cpm, cost: &cc, latency: &cl, strength: &cs };
        let (k, by, e) = policy::choose(r.mode, &arrays, r.min_p);
        for (j, &i) in cand.iter().enumerate() {
            expected[i] = e[j];
        }
        let (mut greedy, mut by) = (cand[k], by);
        // After a failure never step down: only models at least as strong as the strongest failed one.
        let floor_s = r.failed.iter().map(|&i| strength[i]).fold(f64::NEG_INFINITY, f64::max);
        let up: Vec<usize> = cand.iter().copied().filter(|&i| strength[i] >= floor_s - 1e-9).collect();
        let key = |i: usize, j: usize| cmp(p_lo[i], p_lo[j]).then(cmp(strength[i], strength[j])).then(cmp(cost[j], cost[i]));
        if let Some(&next) = r.prev_ladder.iter().find(|i| up.contains(i)) {
            (greedy, by) = (next, "escalation_ladder".into());
        } else if !up.is_empty() && !up.contains(&greedy) {
            greedy = first_max(&up, key);
            by = "escalation:stronger".into();
        } else if up.is_empty() && !r.failed.is_empty() {
            greedy = first_max(&cand, |i, j| cmp(strength[i], strength[j]).then(cmp(p_lo[i], p_lo[j])).then(cmp(cost[j], cost[i])));
            by = "escalation:strongest_left".into();
        }
        (chosen, decided_by) = (Some(greedy), by);
        ladder = cascade(pool, &cand, &p_lo, &cost, &strength).into_iter().filter(|i| up.is_empty() || up.contains(i)).collect();
    }

    let mut order = cand;
    order.sort_by(|&a, &b| cmp(p[b], p[a]).then(cmp(cost[a], cost[b])).then(a.cmp(&b)));
    if let Some(c) = chosen {
        order.retain(|&i| i != c);
        order.insert(0, c);
    }
    let scored = (0..n)
        .map(|i| Scored { p: p[i], p_lo: p_lo[i], cost: cost[i], latency: latency[i], expected_cost: expected[i], tier_p: tier_p[i] })
        .collect();
    Decision { scored, chosen, decided_by, order, ladder, difficulty: dec }
}

/// Python `max(items, key)`: the first maximum.
fn first_max(items: &[usize], ord: impl Fn(usize, usize) -> std::cmp::Ordering) -> usize {
    items.iter().copied().fold(items[0], |best, x| if ord(x, best) == std::cmp::Ordering::Greater { x } else { best })
}

/// `Matcher._ladder`: the escalation ladder over the candidates (pool indices).
fn cascade(pool: &[&Card], cand: &[usize], p_lo: &[f64], cost: &[f64], strength: &[f64]) -> Vec<usize> {
    let ids: Vec<&str> = cand.iter().map(|&i| pool[i].id.as_str()).collect();
    let off: Vec<Vec<f64>> = (0..ids.len())
        .map(|a| (0..ids.len()).map(|b| if a == b { 0.0 } else { HEAD.failure_offset(&[ids[a]], ids[b]) }).collect())
        .collect();
    let pick = |v: &[f64]| cand.iter().map(|&i| v[i]).collect::<Vec<f64>>();
    let (cp, cc, cs) = (pick(p_lo), pick(cost), pick(strength));
    let allowed = policy::free_guard(&cp, &cc);
    policy::ladder(&cp, &cc, &cs, &off, &allowed).into_iter().map(|k| cand[k]).collect()
}
