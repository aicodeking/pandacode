//! v4 decision rules (upstream `router_v4/policy.py`) over candidate arrays.
//!
//! Expected cost including failure: E = c + (1 - P)·(c_next + L). Decisions use the lower bound of P.
//! A $0 candidate may only win if its P is within `FREE_MARGIN` of the best paid candidate's P.

use std::cmp::Ordering;

use super::Mode;

const FREE_MARGIN: f64 = 0.05;
const TIE_REL: f64 = 0.02;
const TIE_ABS: f64 = 1e-5;
pub(super) const FREE_PENALTY: f64 = 0.5;
const UNCOVERED_SHRINK: f64 = 0.5;
const P_TIE: f64 = 0.005;
const Q_TIE: f64 = 0.01;
/// Upstream `V4_DEFAULTS` (tuned on train/val).
pub(super) const FAILURE_PENALTY_USD: f64 = 0.02;
pub(super) const EQUAL_P_MARGIN: f64 = 0.05;
pub(super) const LADDER_LAMBDA: f64 = 3.0;
const W_QUALITY: f64 = 1.0;
const W_COST: f64 = 0.3;
const W_LATENCY: f64 = 0.0;
const LADDER_LEN: usize = 3;

pub(super) fn provenance_penalty(provenance: &str) -> f64 {
    match provenance {
        "verified" => 0.0,
        "benchmark-informed" => 0.5,
        _ => 1.0,
    }
}

pub(super) fn logit(p: f64) -> f64 {
    let p = p.clamp(1e-6, 1.0 - 1e-6);
    (p / (1.0 - p)).ln()
}

pub(super) fn sigmoid(x: f64) -> f64 {
    1.0 / (1.0 + (-x).exp())
}

/// P(success | b = level) at a fractional level (linear interpolation).
pub(super) fn p_at_level(p_levels: &[f64; 10], level: f64) -> f64 {
    let lv = level.clamp(1.0, 10.0);
    let lo = lv.floor() as usize - 1;
    let hi = (lo + 1).min(9);
    let f = lv - (lo + 1) as f64;
    (1.0 - f) * p_levels[lo] + f * p_levels[hi]
}

/// numpy's contiguous `sum` (pairwise: eight accumulators up to 128 values), so ties match bit for bit.
pub(super) fn np_sum(v: &[f64]) -> f64 {
    if v.len() < 8 {
        return v.iter().sum();
    }
    if v.len() > 128 {
        let half = v.len() / 2 / 8 * 8;
        return np_sum(&v[..half]) + np_sum(&v[half..]);
    }
    let mut r = [0.0; 8];
    r.copy_from_slice(&v[..8]);
    let full = v.len() - v.len() % 8;
    for chunk in v[8..full].chunks(8) {
        for (acc, x) in r.iter_mut().zip(chunk) {
            *acc += x;
        }
    }
    let mut res = ((r[0] + r[1]) + (r[2] + r[3])) + ((r[4] + r[5]) + (r[6] + r[7]));
    for x in &v[full..] {
        res += x;
    }
    res
}

/// numpy's median.
fn median(v: &[f64]) -> f64 {
    let mut s = v.to_vec();
    s.sort_by(|a, b| a.partial_cmp(b).unwrap_or(Ordering::Equal));
    let n = s.len();
    if n % 2 == 1 { s[n / 2] } else { (s[n / 2 - 1] + s[n / 2]) / 2.0 }
}

/// Uncovered cards on the head's scale for this task: the mapped card P recentred on the covered cards,
/// shrunk toward their median, minus the prior penalty, capped at the best covered card.
pub(super) fn shrunk_card_p(card_q: &[f64], ref_q: &[f64], ref_p: &[f64], penalty: &[f64], alpha: f64, beta: f64) -> Vec<f64> {
    let map = |q: f64| alpha + beta * logit(q);
    let mean = |v: &[f64]| np_sum(v) / v.len() as f64;
    let y_ref: Vec<f64> = ref_p.iter().map(|p| logit(*p)).collect();
    let z_ref: Vec<f64> = ref_q.iter().map(|q| map(*q)).collect();
    let shift = mean(&y_ref) - mean(&z_ref);
    let (med, cap) = (median(&y_ref), ref_p.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    card_q
        .iter()
        .zip(penalty)
        .map(|(q, pen)| sigmoid(UNCOVERED_SHRINK * (map(*q) + shift) + (1.0 - UNCOVERED_SHRINK) * med - pen).min(cap))
        .collect()
}

fn cmp(a: f64, b: f64) -> Ordering {
    a.partial_cmp(&b).unwrap_or(Ordering::Equal)
}

/// Python `max(iter, key)`: the first maximum.
fn first_max<T: Copy>(items: impl IntoIterator<Item = T>, ord: impl Fn(T, T) -> Ordering) -> Option<T> {
    items.into_iter().fold(None, |best, x| match best {
        Some(b) if ord(x, b) != Ordering::Greater => Some(b),
        _ => Some(x),
    })
}

fn first_min<T: Copy>(items: impl IntoIterator<Item = T>, ord: impl Fn(T, T) -> Ordering) -> Option<T> {
    first_max(items, |a, b| ord(b, a))
}

pub(super) struct Arrays<'a> {
    /// Decision P (lower bound).
    pub p: &'a [f64],
    /// Calibrated P.
    pub p_mean: &'a [f64],
    pub cost: &'a [f64],
    pub latency: &'a [f64],
    pub strength: &'a [f64],
}

/// Cost of the escalation target if candidate i fails: the best other candidate by (P, strength).
fn next_step_cost(p: &[f64], cost: &[f64], strength: &[f64]) -> Vec<f64> {
    let n = p.len();
    if n == 1 {
        return cost.to_vec();
    }
    let mut order: Vec<usize> = (0..n).collect();
    order.sort_by(|&a, &b| cmp(p[b], p[a]).then(cmp(strength[b], strength[a])).then(cmp(cost[a], cost[b])));
    let (first, second) = (order[0], order[1]);
    (0..n).map(|i| if i == first { cost[second] } else { cost[first] }).collect()
}

pub(super) fn expected_cost(p: &[f64], cost: &[f64], strength: &[f64]) -> Vec<f64> {
    let next = next_step_cost(p, cost, strength);
    (0..p.len()).map(|i| cost[i] + (1.0 - p[i]) * (next[i] + FAILURE_PENALTY_USD)).collect()
}

/// Candidates allowed to win: $0 ones only if within `FREE_MARGIN` of the best paid P.
pub(super) fn free_guard(p: &[f64], cost: &[f64]) -> Vec<bool> {
    let free: Vec<bool> = cost.iter().map(|c| *c <= 0.0).collect();
    if free.iter().all(|f| *f) || !free.iter().any(|f| *f) {
        return vec![true; p.len()];
    }
    let best_paid = (0..p.len()).filter(|&i| !free[i]).map(|i| p[i]).fold(f64::NEG_INFINITY, f64::max);
    (0..p.len()).map(|i| !free[i] || p[i] >= best_paid - FREE_MARGIN).collect()
}

fn stronger(idx: &[usize], a: &Arrays) -> usize {
    let top = idx.iter().map(|&i| a.p[i]).fold(f64::NEG_INFINITY, f64::max);
    first_max(idx.iter().copied().filter(|&i| a.p[i] >= top - P_TIE), |x, y| {
        cmp(a.strength[x], a.strength[y]).then(cmp(a.p[x], a.p[y])).then(cmp(a.cost[x], a.cost[y])).then(y.cmp(&x))
    })
    .expect("non-empty")
}

fn best_p_cheaper(idx: &[usize], a: &Arrays) -> usize {
    let top = idx.iter().map(|&i| a.p[i]).fold(f64::NEG_INFINITY, f64::max);
    first_min(idx.iter().copied().filter(|&i| a.p[i] >= top - Q_TIE), |x, y| {
        cmp(a.cost[x], a.cost[y]).then(cmp(a.strength[y], a.strength[x])).then(cmp(a.p[y], a.p[x])).then(x.cmp(&y))
    })
    .expect("non-empty")
}

fn min_e(idx: &[usize], e: &[f64], a: &Arrays) -> usize {
    let e_min = idx.iter().map(|&i| e[i]).fold(f64::INFINITY, f64::min);
    let tied: Vec<usize> = idx.iter().copied().filter(|&i| e[i] <= e_min * (1.0 + TIE_REL) + TIE_ABS).collect();
    stronger(&tied, a)
}

/// -> (index, decided_by, expected cost) over non-empty candidate arrays.
pub(super) fn choose(mode: Mode, a: &Arrays, min_p: f64) -> (usize, String, Vec<f64>) {
    let n = a.p.len();
    let e = expected_cost(a.p, a.cost, a.strength);
    let (e_max, lat_max) = (e.iter().copied().fold(f64::NEG_INFINITY, f64::max), a.latency.iter().copied().fold(f64::NEG_INFINITY, f64::max));
    let util: Vec<f64> = (0..n)
        .map(|i| W_QUALITY * a.p[i] - W_COST * e[i] / e_max.max(1e-12) - W_LATENCY * a.latency[i] / lat_max.max(1e-12))
        .collect();
    let guard = free_guard(a.p, a.cost);
    let ok: Vec<usize> = (0..n).filter(|&i| guard[i]).collect();
    let (pool, k, by) = match mode {
        Mode::Quality => return (best_p_cheaper(&ok, a), "policy:max_quality".into(), e),
        Mode::Cheapest => {
            let pool: Vec<usize> = ok.iter().copied().filter(|&i| a.p[i] >= min_p).collect();
            if pool.is_empty() {
                return (best_p_cheaper(&ok, a), "policy:cheapest_above_threshold:relaxed".into(), e);
            }
            let k = min_e(&pool, &e, a);
            (pool, k, "policy:cheapest_above_threshold")
        }
        Mode::Balanced => {
            let u_max = ok.iter().map(|&i| util[i]).fold(f64::NEG_INFINITY, f64::max);
            let top: Vec<usize> = ok.iter().copied().filter(|&i| util[i] >= u_max - 1e-9).collect();
            let k = stronger(&top, a);
            (ok, k, "policy:max_utility")
        }
    };
    let eq: Vec<usize> = pool
        .iter()
        .copied()
        .filter(|&i| {
            a.cost[i] < a.cost[k] * (1.0 - TIE_REL) - TIE_ABS
                && a.p_mean[i] >= a.p_mean[k] - EQUAL_P_MARGIN
                && a.p[i] >= a.p[k] - EQUAL_P_MARGIN
        })
        .collect();
    if eq.is_empty() {
        (k, by.into(), e)
    } else {
        (min_e(&eq, &e, a), format!("{by}:equal_p_cheaper"), e)
    }
}

/// Cascade: the ordered pair (a, b) maximising S2 - λ·C2 (b's P shifted by `off[a][b]` given a failed),
/// then the most likely remaining card given both failed. `allowed` masks cards that may open it.
pub(super) fn ladder(p: &[f64], cost: &[f64], strength: &[f64], off: &[Vec<f64>], allowed: &[bool]) -> Vec<usize> {
    let n = p.len();
    if n == 1 {
        return vec![0];
    }
    let lp: Vec<f64> = p.iter().map(|x| logit(*x)).collect();
    let obj = |a: usize, b: usize| {
        if a == b || !allowed[a] {
            return f64::NEG_INFINITY;
        }
        let s2 = p[a] + (1.0 - p[a]) * sigmoid(lp[b] + off[a][b]);
        let c2 = cost[a] + (1.0 - p[a]) * cost[b];
        s2 - LADDER_LAMBDA * c2
    };
    let pairs: Vec<(usize, usize)> = (0..n).flat_map(|a| (0..n).map(move |b| (a, b))).collect();
    let best = pairs.iter().map(|&(a, b)| obj(a, b)).fold(f64::NEG_INFINITY, f64::max);
    let (a, b) = first_max(pairs.into_iter().filter(|&(a, b)| obj(a, b) >= best - 1e-9), |x, y| {
        cmp(strength[x.1], strength[y.1]).then(cmp(strength[x.0], strength[y.0]))
    })
    .expect("a pair");
    let mut out = vec![a, b];
    while out.len() < LADDER_LEN.min(n) {
        let rest: Vec<usize> = (0..n).filter(|i| !out.contains(i)).collect();
        let q = |r: usize| super::heuristic::py_round(sigmoid(lp[r] + out.iter().map(|&o| off[o][r]).sum::<f64>()), 3);
        let pick = first_max(rest.iter().copied(), |x, y| cmp(q(x), q(y)).then(cmp(strength[x], strength[y])))
            .expect("a remaining card");
        out.push(pick);
    }
    out
}
