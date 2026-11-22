// Small statistics used by analyze.mjs. Exact tests where the task count allows it.

export const mean = list => list.reduce((sum, x) => sum + x, 0) / list.length;
export const median = list => {
  const sorted = [...list].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** Deterministic generator, so a report reproduces from the same seed. */
export function random(seed) {
  let state = seed >>> 0 || 1;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 2 ** 32;
  };
}

/** Two-sided exact sign test, ties dropped. */
export function signTest(diffs) {
  const nonzero = diffs.filter(d => d !== 0);
  const n = nonzero.length;
  if (!n) return 1;
  const k = Math.min(nonzero.filter(d => d > 0).length, nonzero.filter(d => d < 0).length);
  let tail = 0;
  let choose = 1;
  for (let i = 0; i <= k; i++) {
    tail += choose / 2 ** n;
    choose = choose * (n - i) / (i + 1);
  }
  return Math.min(1, 2 * tail);
}

const SIGN_FLIPS = 200_000;
/** Each row is one way to assign signs: every assignment up to 2^17, else a seeded sample. */
function signAssignments(n, seed = 0x51ed) {
  if (n <= 17) return { count: 2 ** n, at: mask => i => (mask & (1 << i) ? 1 : -1) };
  const next = random(seed);
  return { count: SIGN_FLIPS, at: () => { const signs = Array.from({ length: n }, () => (next() < 0.5 ? 1 : -1)); return i => signs[i]; } };
}

/**
 * Wilcoxon signed-rank with midranks: exact up to 17 pairs, sampled past that. Two-sided by default;
 * `side: 'less'` is one-sided, small p when the differences sit below zero.
 */
export function wilcoxon(diffs, { side = 'two' } = {}) {
  const nonzero = diffs.filter(d => d !== 0);
  const n = nonzero.length;
  if (!n) return 1;
  const order = nonzero.map(d => Math.abs(d)).sort((a, b) => a - b);
  const rank = value => (order.indexOf(value) + order.lastIndexOf(value)) / 2 + 1;
  const ranks = nonzero.map(d => rank(Math.abs(d)));
  const total = ranks.reduce((a, b) => a + b, 0);
  const positive = nonzero.reduce((sum, d, i) => sum + (d > 0 ? ranks[i] : 0), 0);
  const extreme = Math.min(positive, total - positive);
  const { count, at } = signAssignments(n);
  let hits = 0;
  for (let mask = 0; mask < count; mask++) {
    const sign = at(mask);
    let sum = 0;
    for (let i = 0; i < n; i++) if (sign(i) > 0) sum += ranks[i];
    if (side === 'less' ? sum <= positive + 1e-9 : Math.min(sum, total - sum) <= extreme + 1e-9) hits++;
  }
  return hits / count;
}

/** Exact McNemar on discordant pairs. */
export const mcnemar = (beforeOnly, afterOnly) => signTest([...Array(beforeOnly).fill(-1), ...Array(afterOnly).fill(1)]);

/** Percentile bootstrap of the mean, resampling tasks. */
export function bootstrapCi(values, rounds = 20_000, seed = 0x2545f491) {
  const next = random(seed);
  const means = new Float64Array(rounds);
  for (let r = 0; r < rounds; r++) {
    let sum = 0;
    for (let i = 0; i < values.length; i++) sum += values[Math.floor(next() * values.length)];
    means[r] = sum / values.length;
  }
  means.sort();
  return [means[Math.floor(rounds * 0.025)], means[Math.floor(rounds * 0.975)]];
}

const tStat = (values, sign) => {
  const n = values.length;
  if (n < 2) return 0;
  const first = values[0] * sign(0);
  let constant = true;
  let sum = 0;
  for (let i = 0; i < n; i++) {
    const x = values[i] * sign(i);
    if (x !== first) constant = false;
    sum += x;
  }
  if (constant) return first === 0 ? 0 : Infinity;
  const avg = sum / n;
  let sse = 0;
  for (let i = 0; i < n; i++) sse += (values[i] * sign(i) - avg) ** 2;
  const variance = sse / (n - 1);
  return variance > 0 ? Math.abs(avg) / Math.sqrt(variance / n) : (avg === 0 ? 0 : Infinity);
};

/**
 * Westfall-Young max-T: flips the sign of each task's differences together across all metrics, so
 * correlated metrics share one correction. `family` maps a metric to per-task values in one task order.
 */
export function maxT(family) {
  const names = Object.keys(family);
  if (!names.length) return {};
  const n = family[names[0]].length;
  if (names.some(name => family[name].length !== n)) throw new Error('metrics must cover the same tasks');
  const observed = Object.fromEntries(names.map(name => [name, tStat(family[name], () => 1)]));
  const { count, at } = signAssignments(n);
  const hits = Object.fromEntries(names.map(name => [name, 0]));
  for (let mask = 0; mask < count; mask++) {
    const sign = at(mask);
    let most = 0;
    for (const name of names) most = Math.max(most, tStat(family[name], sign));
    for (const name of names) if (most >= observed[name] - 1e-12) hits[name]++;
  }
  return Object.fromEntries(names.map(name => [name, hits[name] / count]));
}

/** Holm step-down adjustment: adjusted p-values in the input order. */
export function holm(ps) {
  const order = ps.map((p, i) => [p, i]).sort((a, b) => a[0] - b[0]);
  const adjusted = new Array(ps.length);
  let running = 0;
  order.forEach(([p, i], rank) => { running = Math.max(running, Math.min(1, (ps.length - rank) * p)); adjusted[i] = running; });
  return adjusted;
}
